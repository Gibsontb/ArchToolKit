/**
 * Tags: the one piece of metadata every other part of VCF reads.
 *
 * A tag on a VM is what puts it in a VCF Operations custom group, what a VCF
 * Automation template matches for placement, what an NSX group selects for a
 * firewall rule, and what a showback report bills to. So a tagging programme
 * is not a naming exercise. A misspelt value moves a VM out of its firewall
 * group; a category that allows several values lets a VM be both prod and dev
 * and land wherever the placement engine reads first.
 *
 * VCF 9.0 moved the tag catalogue into VCF Operations (Manage > Fleet
 * Management > Tags): categories and tags are created there and pushed to each
 * vCenter, or imported from one. 9.1 added assignment from VCF Operations, a
 * single view of every assignment across the fleet, propagation in both
 * directions, and removing a vCenter from a category's management — the
 * "disengage" of the 9.1 blog. 9.1.1 published the API for it under
 * /suite-api/api/fleet-management/tag-management.
 *
 * Underneath, a tag is still a vCenter object: /api/cis/tagging on each vCenter
 * is where it lives, where assignments are enforced, and the API every other
 * product reads. So the scripts here speak the vCenter API as the working path
 * for everything that must work on vSphere 8 and 9 alike, and the fleet API
 * where fleet management is the point: creating the catalogue centrally, and
 * importing, pushing and exporting it.
 *
 * Every vCenter script logs in with POST /api/session using a password read
 * from a mode-600 file and handed to curl as a config on stdin, and takes the
 * session id through a file descriptor — neither appears on a command line.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { applyScript, authHeader, authPreamble, scheduledEnv } from '../apply.ts';
import { importGuide, type ImportStepSpec } from './vcf-networks-logs.ts';
import { blueprintYaml, templatePath } from '../vcfa-import.ts';
import type { VroActionDef } from '../vro/core.ts';
import { toPackage } from '../vro/to-package.ts';

const PLATFORM = 'vcf-fleet' as const;
const SRC = 'ArchToolKit';

// ---------------------------------------------------------------------------
// The tag standard
// ---------------------------------------------------------------------------

/**
 * Object types a vCenter category can be associated with, as /api/cis/tagging
 * spells them. The fleet API lists fewer (GET .../categories/associable-types);
 * the fleet script checks against that list at run time rather than here.
 */
const OBJECT_TYPES: readonly string[] = [
  'VirtualMachine',
  'HostSystem',
  'ClusterComputeResource',
  'Datastore',
  'StoragePod',
  'Network',
  'DistributedVirtualPortgroup',
  'VmwareDistributedVirtualSwitch',
  'Folder',
  'Datacenter',
  'ResourcePool',
  'VirtualApp',
  'com.vmware.content.Library',
  'com.vmware.content.library.Item',
];

/** What GET .../tag-management/categories/associable-types returned in the 9.1.1 reference. */
const FLEET_KINDS: readonly string[] = ['VirtualMachine', 'HostSystem', 'ClusterComputeResource', 'Datacenter', 'Datastore', 'ResourcePool', 'VirtualApp', 'Folder', 'Network'];

/** Categories that only make sense with one value per object. */
const SHOULD_BE_SINGLE = ['environment', 'owner', 'costcenter', 'costcentre', 'backuppolicy', 'dataclassification', 'tier', 'automation', 'os'];

const DEFAULT_STANDARD = [
  '# Category | single or multiple | object types | allowed values | required on | description',
  '# Object types: VirtualMachine, HostSystem, ClusterComputeResource, Datastore, Network,',
  '# DistributedVirtualPortgroup, Folder, ResourcePool, Datacenter ... (* = every type).',
  '# Values: comma separated, or * for free text (use sparingly).',
  'Environment | single | VirtualMachine,Folder,ClusterComputeResource,ResourcePool | prod,preprod,test,dev,dr | VirtualMachine | Lifecycle stage. Drives placement, policy and firewall groups',
  'Application | multiple | VirtualMachine,Folder,ResourcePool | payments,web-portal,data-platform,shared-services | VirtualMachine | Business application the object serves',
  'Owner | single | VirtualMachine,Folder | team-payments,team-web,team-data,team-platform | VirtualMachine | Owning team, never a person',
  'CostCenter | single | VirtualMachine,Folder,ResourcePool | CC1001,CC1002,CC2001,CC9000 | VirtualMachine | Finance cost centre for showback',
  'BackupPolicy | single | VirtualMachine | gold-daily,silver-daily,bronze-weekly,none | VirtualMachine | Backup schedule the backup product selects on',
  'DataClassification | single | VirtualMachine,Datastore | public,internal,confidential,restricted | VirtualMachine | Highest classification of data held',
  'Compliance | multiple | VirtualMachine,ClusterComputeResource,Datastore | pci-dss,sox,gdpr | | Regimes in scope',
  'Automation | single | VirtualMachine,HostSystem,ClusterComputeResource | allowed,never | | never = every automation in this kit leaves it alone',
  'Tier | single | VirtualMachine,ClusterComputeResource,Datastore | 1,2,3 | ClusterComputeResource | Service tier; cluster and datastore tier used for placement',
  'OS | single | VirtualMachine | windows,linux,other | | Guest operating system family, set by the auto-tagging rules',
].join('\n');

interface StdCategory {
  readonly name: string;
  readonly description: string;
  readonly cardinality: 'SINGLE' | 'MULTIPLE';
  /** Empty means every type. */
  readonly types: readonly string[];
  readonly values: readonly string[];
  readonly freeText: boolean;
  readonly requiredOn: readonly string[];
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The standard as the scripts read it: snake case, the vCenter API's own field names. */
function standardJson(categories: readonly StdCategory[]): string {
  return `${JSON.stringify(
    {
      generatedBy: 'ArchToolKit',
      categories: categories.map((c) => ({
        name: c.name,
        description: c.description,
        cardinality: c.cardinality,
        associable_types: [...c.types].sort(),
        values: [...c.values],
        free_text: c.freeText,
        required_on: [...c.requiredOn],
      })),
    },
    null,
    2,
  )}\n`;
}

/**
 * Parse the line format and say what is wrong with the standard itself.
 *
 * Most of what goes wrong in a tagging programme is visible here, before a tag
 * exists: a category everyone treats as one-value that allows many, a value list
 * that is really free text, the same word in three cases.
 */
function parseStandard(text: string, path = 'standard'): { categories: StdCategory[]; findings: Finding[] } {
  const categories: StdCategory[] = [];
  const findings: Finding[] = [];
  const seen = new Map<string, string>();
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

  for (const line of lines) {
    const fields = line.split('|').map((field) => field.trim());
    const [name = '', cardText = '', typeText = '', valueText = '', requiredText = '', description = ''] = fields;
    if (fields.length < 4 || !name) {
      findings.push(error('tags.standard.malformed', `"${line}" does not have the four fields a category needs.`, { path, remediation: 'Name | single or multiple | object types | values, with optional | required on | description.', source: SRC }));
      continue;
    }
    const cardinality = cardText.toLowerCase();
    if (cardinality !== 'single' && cardinality !== 'multiple') {
      findings.push(error('tags.standard.cardinality', `${name}: cardinality "${cardText}" is neither single nor multiple.`, { path, source: SRC }));
      continue;
    }
    if (name.length > 128) findings.push(error('tags.standard.long-name', `${name.slice(0, 40)}…: a category name is limited to 128 characters.`, { path, source: SRC }));
    const previous = seen.get(norm(name));
    if (previous !== undefined) {
      findings.push(error('tags.standard.duplicate-category', `${name} and ${previous} are the same category spelt two ways.`, { path, remediation: 'Keep one. Two spellings become two categories in vCenter, and half the estate is tagged in each.', source: SRC }));
      continue;
    }
    seen.set(norm(name), name);

    const types = typeText === '*' || typeText === '' ? [] : listOf(typeText);
    const unknown = types.filter((type) => !OBJECT_TYPES.includes(type));
    if (unknown.length > 0) {
      findings.push(error('tags.standard.unknown-type', `${name}: ${unknown.join(', ')} is not an object type vCenter can tag.`, { path, remediation: `Use the vSphere type names: ${OBJECT_TYPES.slice(0, 9).join(', ')}.`, source: SRC }));
    }
    if (types.length === 0) {
      findings.push(warning('tags.standard.all-types', `${name} names no object types, which vCenter reads as every type.`, { path, remediation: 'A category that can go on a datastore, a host and a content library item will. Name the types it is for.', source: SRC }));
    }

    const freeText = valueText === '*';
    const values = freeText ? [] : listOf(valueText);
    if (freeText) {
      findings.push(warning('tags.standard.free-text', `${name} is free text, so every spelling anyone types becomes another tag.`, { path, remediation: 'Give it a closed list. If the list really is open-ended (a ticket number), it belongs in a custom attribute or a CMDB, not a tag.', source: SRC }));
    } else if (values.length === 0) {
      findings.push(error('tags.standard.no-values', `${name} has no values. VCF Operations will not create a category without at least one tag.`, { path, source: SRC }));
    } else if (values.length > 50) {
      findings.push(warning('tags.standard.value-explosion', `${name} has ${values.length} values.`, { path, remediation: 'Past a few dozen, a value list is a free-text field with extra steps: nobody can pick the right one from a dropdown. Split the category or move it out of tags.', source: SRC }));
    }
    const lowered = new Map<string, string>();
    for (const value of values) {
      const key = value.toLowerCase().replace(/\s+/g, ' ');
      const clash = lowered.get(key);
      if (clash !== undefined) findings.push(error('tags.standard.duplicate-value', `${name}: "${value}" and "${clash}" differ only by case or spacing.`, { path, remediation: 'They become two tags, and objects split between them.', source: SRC }));
      lowered.set(key, value);
      if (value.length > 128) findings.push(error('tags.standard.long-value', `${name}: a tag name is limited to 128 characters.`, { path, source: SRC }));
    }
    const spaced = values.filter((value) => /\s/.test(value));
    if (spaced.length > 0) {
      findings.push(warning('tags.standard.value-spaces', `${name}: ${spaced.map((v) => `"${v}"`).join(', ')} contain spaces.`, { path, remediation: 'Every consumer quotes them differently — NSX scope|tag, a VCF Automation constraint, a PowerCLI filter. Use hyphens.', source: SRC }));
    }
    const cased = values.filter((value) => /[A-Z]/.test(value)).length;
    if (cased > 0 && cased < values.length && values.some((value) => /[a-z]/.test(value))) {
      findings.push(warning('tags.standard.value-case', `${name} mixes upper- and lower-case values.`, { path, remediation: 'Pick one case per category. Whoever types the next value will guess the other.', source: SRC }));
    }

    if (cardinality === 'multiple' && SHOULD_BE_SINGLE.includes(norm(name))) {
      findings.push(
        warning('tags.standard.should-be-single', `${name} allows several values per object.`, {
          path,
          remediation: `A VM that is tagged both of two ${name} values is in both custom groups, both firewall groups and both cost centres. And vCenter can turn single into multiple later but never multiple back into single — start single.`,
          source: SRC,
        }),
      );
    }

    const requiredOn = requiredText === '' ? [] : listOf(requiredText);
    const impossible = types.length === 0 ? [] : requiredOn.filter((type) => !types.includes(type));
    if (impossible.length > 0) {
      findings.push(error('tags.standard.required-not-associable', `${name} is required on ${impossible.join(', ')} but cannot be attached to it.`, { path, remediation: 'Add the type to the category, or stop requiring it there. As written, every such object fails compliance forever.', source: SRC }));
    }

    categories.push({
      name,
      description: description || `${name} (ArchToolKit tag standard)`,
      cardinality: cardinality === 'single' ? 'SINGLE' : 'MULTIPLE',
      types,
      values,
      freeText,
      requiredOn,
    });
  }

  const spacedNames = categories.filter((c) => /\s/.test(c.name));
  if (spacedNames.length > 0) {
    findings.push(warning('tags.standard.name-spaces', `${spacedNames.map((c) => c.name).join(', ')} contain spaces.`, { path, remediation: 'Category names become NSX scopes and VCF Automation tag keys. Spaces there need quoting everywhere; leave them out.', source: SRC }));
  }
  const styles = new Set(categories.map((c) => (/^[A-Z][A-Za-z0-9]*$/.test(c.name) ? 'Pascal' : /^[a-z][a-z0-9-]*$/.test(c.name) ? 'lower' : 'other')));
  if (styles.size > 1) {
    findings.push(warning('tags.standard.name-case', 'Category names mix naming styles (for example Environment next to costcenter).', { path, remediation: 'Pick one — PascalCase is what most estates already have — so nobody has to remember which category is spelt which way.', source: SRC }));
  }
  if (categories.length === 0) findings.push(error('tags.standard.empty', 'The standard has no categories.', { path, source: SRC }));
  if (!categories.some((c) => c.requiredOn.length > 0)) {
    findings.push(info('tags.standard.nothing-required', 'No category is required on any object type, so compliance can only report stray values, never missing tags.', { path, source: SRC }));
  }
  return { categories, findings };
}

function standardMarkdown(categories: readonly StdCategory[]): string {
  const rows = categories.map((c) => `| ${c.name} | ${c.cardinality === 'SINGLE' ? 'one per object' : 'several per object'} | ${c.types.length ? c.types.join(', ') : 'every type'} | ${c.freeText ? '*free text*' : c.values.join(', ')} | ${c.requiredOn.join(', ') || '—'} | ${c.description} |`);
  return [
    '# Tag standard',
    '',
    'The categories and values every vCenter in the fleet carries, and where each is required.',
    'Generated by ArchToolKit from the line format in the blueprint; `tag-standard.json` is the',
    'machine-readable copy every script in this kit reads.',
    '',
    '| Category | Cardinality | Applies to | Allowed values | Required on | Meaning |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Rules that go with it',
    '',
    '- A new value is a change to this file, reviewed like code, then pushed. Nobody creates a tag in a vCenter by hand.',
    '- Category names cannot be changed once created, in vCenter or in VCF Operations. Get them right here.',
    '- Single cardinality can be widened to multiple later; multiple can never be narrowed back to single.',
    '- Object types can be added to a category later, never removed.',
    '- Owner is a team, never a person. People leave; the tag stays.',
    '- `Automation=never` takes an object out of every automation in this kit that honours it.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Shared script pieces
// ---------------------------------------------------------------------------

const DEFAULT_VCENTERS = 'vc-mgmt.example.com, vc-wld01.example.com';

function vcentersLine(vcenters: readonly string[]): string {
  return `VCENTERS="\${VCENTERS:-${vcenters.join(' ')}}"`;
}

/** The environment a scheduled vCenter job needs. No secret, only the path to one. */
function vcScheduledEnv(vcenters: readonly string[]): string {
  return `VCENTERS="${vcenters.join(' ')}" VCF_IDB_HOST=vcenter-mgmt.example.com VCF_API_TOKEN_FILE=/etc/archtoolkit/vcf-api-token`;
}

/**
 * vCenter session handling and the readers every script shares.
 *
 * The password reaches curl as `user = "..."` in a config read from stdin
 * (-K -), and the session id reaches curl as a header read from a file
 * descriptor, so neither is ever an argument a `ps` can see.
 */
function vcLib(): string[] {
  return [
    '# --- vCenter access ---------------------------------------------------------',
    '# VCF 9.1: no password at all. Set VCF_API_TOKEN_FILE (a mode-600 file holding',
    '# an API token issued to an API client in VCF Operations) and VCF_IDB_HOST (the',
    '# VCF Identity Broker). The token is exchanged for a short-lived access token,',
    '# then for a vCenter SAML token per vCenter, then for a session.',
    '# 8.x and 9.0: one account for every vCenter (VC_USER), its password in a',
    '# mode-600 file, VC_PASSWORD_FILE, or VC_PASSWORD_DIR/<vcenter> when each',
    '# vCenter has its own SSO domain.',
    '# VC_CACERT points at the CA bundle if the vCenters use a private CA. Nothing',
    '# here disables certificate checking.',
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    '(( BASH_VERSINFO[0] >= 4 )) || { echo "bash 4 or later is required" >&2; exit 2; }',
    'if [[ -z "${VCF_API_TOKEN_FILE:-}" ]]; then',
    '  : "${VC_USER:?set VCF_API_TOKEN_FILE and VCF_IDB_HOST (VCF 9.1), or VC_USER and VC_PASSWORD_FILE (8.x / 9.0)}"',
    'fi',
    'CURL_TLS=()',
    '[[ -n "${VC_CACERT:-}" ]] && CURL_TLS=(--cacert "$VC_CACERT")',
    'declare -A SID=()',
    'WORK=$(mktemp -d)',
    '',
    'secret_file_for() {',
    '  if [[ -n "${VC_PASSWORD_DIR:-}" && -f "${VC_PASSWORD_DIR}/$1" ]]; then',
    '    printf \'%s\\n\' "${VC_PASSWORD_DIR}/$1"',
    '  else',
    '    printf \'%s\\n\' "${VC_PASSWORD_FILE:?set VC_PASSWORD_FILE to a mode-600 file holding the password of VC_USER}"',
    '  fi',
    '}',
    '',
    'check_mode() {',
    '  local mode',
    '  mode=$(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1")',
    '  if [[ "$mode" != 600 && "$mode" != 400 ]]; then',
    '    echo "Refusing: $1 is mode $mode. chmod 600 it; a secret file others can read is a leaked secret." >&2',
    '    exit 2',
    '  fi',
    '}',
    '',
    '# VCF 9.1 API-token login. Three exchanges, each secret on stdin or a file',
    '# descriptor, never an argument. VERIFY on your release: the vCenter token',
    '# exchange and the SIGN header follow davidwzhang.com "VCF 9.1 API Access (4)".',
    'VCF_ACCESS=""',
    'idb_access_token() {',
    '  [[ -n "$VCF_ACCESS" ]] && return 0',
    '  : "${VCF_IDB_HOST:?set VCF_IDB_HOST to the VCF Identity Broker host}"',
    '  check_mode "$VCF_API_TOKEN_FILE"',
    '  VCF_ACCESS=$( { printf \'%s\' \'grant_type=urn:custom:vcf:params:oauth:grant-type:api-token&api_token=\'; jq -jn --rawfile p "$VCF_API_TOKEN_FILE" \'$p | rtrimstr("\\n") | @uri\'; } |',
    '    curl -sS -f ${CURL_TLS[@]+"${CURL_TLS[@]}"} -X POST "https://${VCF_IDB_HOST}/acs/t/CUSTOMER/token" \\',
    '      -H "Content-Type: application/x-www-form-urlencoded" --data-binary @- | jq -r \'.access_token // empty\')',
    '  [[ -n "$VCF_ACCESS" ]] || { echo "The identity broker returned no access token" >&2; exit 2; }',
    '}',
    '',
    'vc_login_token() {',
    '  local host="$1" saml comp',
    '  idb_access_token',
    '  saml=$( { printf \'%s\' \'grant_type=urn:ietf:params:oauth:grant-type:token-exchange&requested_token_type=urn:ietf:params:oauth:token-type:saml2&subject_token_type=urn:ietf:params:oauth:token-type:access_token&subject_token=\'; jq -jn --arg t "$VCF_ACCESS" \'$t | @uri\'; } |',
    '    curl -sS -f ${CURL_TLS[@]+"${CURL_TLS[@]}"} -X POST "https://${host}/api/vcenter/authentication/token" \\',
    '      -H @<(printf \'Authorization: Bearer %s\\n\' "$VCF_ACCESS") \\',
    '      -H "Content-Type: application/x-www-form-urlencoded" --data-binary @- | jq -r \'.access_token // empty\')',
    '  [[ -n "$saml" ]] || { echo "$host did not exchange the access token for a SAML token" >&2; exit 2; }',
    '  # The SAML token is base64: decode it, gzip it, and base64 it again.',
    '  comp=$(printf \'%s\' "$saml" | tr \'_-\' \'/+\' | base64 -d 2>/dev/null | gzip -c | base64 | tr -d \'\\n\')',
    '  SID[$host]=$(curl -sS -f ${CURL_TLS[@]+"${CURL_TLS[@]}"} -X POST "https://${host}/api/session" \\',
    '    -H @<(printf \'Authorization: SIGN token="%s"\\n\' "$comp") | jq -r .)',
    '  [[ -n "${SID[$host]}" && "${SID[$host]}" != null ]] || { echo "Login to $host with the API token failed" >&2; exit 2; }',
    '}',
    '',
    'vc_login() {',
    '  if [[ -n "${VCF_API_TOKEN_FILE:-}" ]]; then vc_login_token "$1"; return; fi',
    '  local host="$1" file mode',
    '  file=$(secret_file_for "$host")',
    '  mode=$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file")',
    '  if [[ "$mode" != 600 && "$mode" != 400 ]]; then',
    '    echo "Refusing: $file is mode $mode. chmod 600 it; a password file others can read is a leaked password." >&2',
    '    exit 2',
    '  fi',
    '  # POST /api/session with Basic auth. The credentials go to curl as a config',
    '  # on stdin, never on its command line.',
    '  SID[$host]=$(jq -rn --arg u "$VC_USER" --rawfile p "$file" \'"user = " + (($u + ":" + ($p | rtrimstr("\\n"))) | tojson)\' |',
    '    curl -sS -f ${CURL_TLS[@]+"${CURL_TLS[@]}"} -K - -X POST "https://${host}/api/session" | jq -r .)',
    '  [[ -n "${SID[$host]}" && "${SID[$host]}" != null ]] || { echo "Login to $host failed" >&2; exit 2; }',
    '}',
    '',
    '# vc METHOD VCENTER PATH [curl args]. The session id is read from a file',
    '# descriptor rather than passed as an argument.',
    'vc() {',
    '  local method="$1" host="$2" path="$3"; shift 3',
    '  curl -sS -f ${CURL_TLS[@]+"${CURL_TLS[@]}"} -X "$method" "https://${host}${path}" \\',
    '    -H @<(printf \'vmware-api-session-id: %s\\n\' "${SID[$host]}") \\',
    '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
    '',
    'vc_logout_all() {',
    '  local host',
    '  for host in "${!SID[@]}"; do vc DELETE "$host" /api/session >/dev/null 2>&1 || true; done',
    '  rm -rf "$WORK"',
    '}',
    'trap vc_logout_all EXIT',
    '',
    '# The tag catalogue of one vCenter as one document:',
    '#   {categories: [{id, name, description, cardinality, associable_types}],',
    '#    tags:       [{id, name, description, category_id, category}]}',
    'load_catalogue() {',
    '  local host="$1" out="$2" list id',
    '  list=$(vc GET "$host" /api/cis/tagging/category)',
    '  for id in $(jq -r \'.[]\' <<<"$list"); do vc GET "$host" "/api/cis/tagging/category/${id}"; echo; done > "$out.cats"',
    '  list=$(vc GET "$host" /api/cis/tagging/tag)',
    '  for id in $(jq -r \'.[]\' <<<"$list"); do vc GET "$host" "/api/cis/tagging/tag/${id}"; echo; done > "$out.tags"',
    '  jq -n --slurpfile c "$out.cats" --slurpfile t "$out.tags" \'',
    '    ($c | map({id, name, description, cardinality, associable_types: ((.associable_types // []) | sort)}) | sort_by(.name)) as $cats',
    '    | ($cats | map({key: .id, value: .name}) | from_entries) as $cname',
    '    | {categories: $cats,',
    '       tags: ($t | map({id, name, description, category_id, category: ($cname[.category_id] // "?")}) | sort_by(.category, .name))}\' > "$out"',
    '  rm -f "$out.cats" "$out.tags"',
    '}',
    '',
    '# Every association in one vCenter, [{tag_id, type, id}], read 100 tags at a time.',
    'load_associations() {',
    '  local host="$1" catalogue="$2" out="$3" batch',
    '  : > "$out.part"',
    '  while read -r batch; do',
    '    vc POST "$host" "/api/cis/tagging/tag-association?action=list-attached-objects-on-tags" --data-binary @- <<<"$batch" |',
    '      jq -c \'.[] | .tag_id as $t | .object_ids[] | {tag_id: $t, type, id}\' >> "$out.part"',
    '  done < <(jq -c \'[.tags[].id] | select(length > 0) | _nwise(100) | {tag_ids: .}\' "$catalogue")',
    '  jq -s \'sort_by(.type, .id, .tag_id)\' "$out.part" > "$out"',
    '  rm -f "$out.part"',
    '}',
    '',
    '# Every object the tags can be on, with its name: [{type, id, name}]. VMs are',
    '# listed host by host because GET /api/vcenter/vm refuses a list longer than',
    '# its limit (4,000 on vSphere 8) rather than paging it.',
    'load_inventory() {',
    '  local host="$1" out="$2" hosts h',
    '  hosts=$(vc GET "$host" /api/vcenter/host)',
    '  {',
    '    jq -c \'.[] | {type: "HostSystem", id: .host, name}\' <<<"$hosts"',
    '    for h in $(jq -r \'.[].host\' <<<"$hosts"); do',
    '      vc GET "$host" "/api/vcenter/vm?hosts=${h}" | jq -c \'.[] | {type: "VirtualMachine", id: .vm, name}\'',
    '    done',
    '    vc GET "$host" /api/vcenter/cluster | jq -c \'.[] | {type: "ClusterComputeResource", id: .cluster, name}\'',
    '    vc GET "$host" /api/vcenter/datastore | jq -c \'.[] | {type: "Datastore", id: .datastore, name}\'',
    '    vc GET "$host" /api/vcenter/folder | jq -c \'.[] | {type: "Folder", id: .folder, name}\'',
    '    vc GET "$host" /api/vcenter/resource-pool | jq -c \'.[] | {type: "ResourcePool", id: .resource_pool, name}\'',
    '    vc GET "$host" /api/vcenter/datacenter | jq -c \'.[] | {type: "Datacenter", id: .datacenter, name}\'',
    '    vc GET "$host" /api/vcenter/network | jq -c \'.[] | {type: (if .type == "DISTRIBUTED_PORTGROUP" then "DistributedVirtualPortgroup" elif .type == "OPAQUE_NETWORK" then "OpaqueNetwork" else "Network" end), id: .network, name}\'',
    '  } | jq -s \'unique_by([.type, .id]) | sort_by(.type, .name)\' > "$out"',
    '}',
    '',
    '# An object name, or a MoRef, to "type<TAB>moref". Prints nothing when it is',
    '# not found, AMBIGUOUS when more than one object of the type has that name,',
    '# and UNSUPPORTED for a type this script cannot look up.',
    'resolve_object() {',
    '  local host="$1" type="$2" ref="$3" path key q',
    '  case "$type" in',
    '    VirtualMachine) path=vm; key=vm ;;',
    '    HostSystem) path=host; key=host ;;',
    '    ClusterComputeResource) path=cluster; key=cluster ;;',
    '    Datastore) path=datastore; key=datastore ;;',
    '    Folder) path=folder; key=folder ;;',
    '    ResourcePool) path=resource-pool; key=resource_pool ;;',
    '    Datacenter) path=datacenter; key=datacenter ;;',
    '    Network|DistributedVirtualPortgroup) path=network; key=network ;;',
    '    *) echo UNSUPPORTED; return 0 ;;',
    '  esac',
    '  if [[ "$ref" =~ ^(vm-|host-|domain-c|datastore-|group-[a-z]|resgroup-|datacenter-|network-|dvportgroup-)[0-9]+$ ]]; then',
    '    q="${key}s=$(jq -rn --arg v "$ref" \'$v | @uri\')"',
    '  else',
    '    q="names=$(jq -rn --arg v "$ref" \'$v | @uri\')"',
    '  fi',
    '  vc GET "$host" "/api/vcenter/${path}?${q}" | jq -r --arg k "$key" --arg t "$type" \'',
    '    if length == 0 then empty elif length > 1 then "AMBIGUOUS" else .[0] |',
    '      [(if $k == "network" then (if .type == "DISTRIBUTED_PORTGROUP" then "DistributedVirtualPortgroup" else "Network" end) else $t end), .[$k]] | @tsv end\'',
    '}',
    '',
    '# Tag ids attached to one object, one per line.',
    'attached_tags() {',
    '  jq -n --arg t "$2" --arg i "$3" \'{object_ids: [{type: $t, id: $i}]}\' |',
    '    vc POST "$1" "/api/cis/tagging/tag-association?action=list-attached-tags-on-objects" --data-binary @- | jq -r \'.[].tag_ids[]?\'',
    '}',
    '',
    '# How many objects carry a tag, read at the moment of asking.',
    'attached_count() {',
    '  jq -n --arg t "$2" \'{tag_ids: [$t]}\' |',
    '    vc POST "$1" "/api/cis/tagging/tag-association?action=list-attached-objects-on-tags" --data-binary @- | jq \'[.[].object_ids[]?] | length\'',
    '}',
    '',
    '# attach/detach VCENTER TAG_ID TYPE MOREF',
    'attach_tag() {',
    '  jq -n --arg t "$3" --arg i "$4" \'{object_id: {type: $t, id: $i}}\' |',
    '    vc POST "$1" "/api/cis/tagging/tag-association/${2}?action=attach" --data-binary @- >/dev/null',
    '}',
    'detach_tag() {',
    '  jq -n --arg t "$3" --arg i "$4" \'{object_id: {type: $t, id: $i}}\' |',
    '    vc POST "$1" "/api/cis/tagging/tag-association/${2}?action=detach" --data-binary @- >/dev/null',
    '}',
    '',
    '# A CSV as a table where column(1) exists, as it is otherwise.',
    'show_table() { if command -v column >/dev/null; then column -s, -t; else cat; fi; }',
    '# --- end of vCenter access -------------------------------------------------',
  ];
}

/** The fleet tag-management API helper: VCF Operations 9.1.1 and later. */
function fleetLib(): string[] {
  return [
    ...authPreamble('vcf-fleet'),
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    'TM="https://${VCFOPS_HOST}/suite-api/api/fleet-management/tag-management"',
    '',
    '# fleet METHOD PATH [curl args] — PATH relative to .../fleet-management/tag-management',
    'fleet() {',
    '  local method="$1" path="$2"; shift 2',
    '  curl -sS -f -X "$method" "${TM}${path}" \\',
    `    -H "${authHeader('vcf-fleet')}" \\`,
    '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
    '',
    '# Push, pull and assignment run as background tasks. Wait for one to finish;',
    '# status is RUNNING, SUCCESS, FAILED, DISMISSED or UNKNOWN.',
    'wait_task() {',
    '  local id="$1" status="" waited=0',
    '  while (( waited < ${TASK_TIMEOUT:-1800} )); do',
    '    status=$(fleet GET "/tasks/${id}" | jq -r \'.status // "UNKNOWN"\')',
    '    case "$status" in',
    '      SUCCESS) echo "task $id: SUCCESS"; return 0 ;;',
    '      FAILED|DISMISSED) echo "task $id: $status" >&2; fleet GET "/tasks/${id}" | jq -r \'.errorMessages[]? | "  \\(.)"\' >&2; return 1 ;;',
    '    esac',
    '    sleep 10; waited=$((waited + 10))',
    '  done',
    '  echo "task $id: still $status after ${waited}s; check it in Manage > Fleet Management > Tags" >&2',
    '  return 1',
    '}',
    '',
    '# Every category, every tag in it, and every tagged resource, as one sorted',
    '# document. Pages through the queries 1,000 at a time.',
    'fleet_export() {',
    '  local out="$1" page=0 got cid',
    '  : > "$out.cats"',
    '  while :; do',
    '    got=$(fleet POST "/categories/query?page=${page}&pageSize=1000" --data-binary @- <<<\'{}\')',
    '    jq -c \'.categories[]?\' <<<"$got" >> "$out.cats"',
    '    (( $(jq \'.categories | length\' <<<"$got") < 1000 )) && break',
    '    page=$((page + 1))',
    '  done',
    '  : > "$out.tags"',
    '  for cid in $(jq -r .id "$out.cats"); do',
    '    fleet POST "/categories/${cid}/tags/query?page=0&pageSize=1000" --data-binary @- <<<\'{}\' | jq -c \'.tags[]?\' >> "$out.tags"',
    '  done',
    '  page=0; : > "$out.res"',
    '  while :; do',
    '    got=$(fleet POST "/resources/query?page=${page}&pageSize=1000" --data-binary @- <<<\'{}\')',
    '    jq -c \'.resources[]?\' <<<"$got" >> "$out.res"',
    '    (( $(jq \'.resources | length\' <<<"$got") < 1000 )) && break',
    '    page=$((page + 1))',
    '  done',
    '  jq -n --slurpfile c "$out.cats" --slurpfile t "$out.tags" --slurpfile r "$out.res" \'{',
    '    categories: ($c | map(.associableTypes |= (. // [] | map(.resourceKinds |= sort))) | sort_by(.name)),',
    '    tags: ($t | sort_by(.categoryName, .name)),',
    '    assignments: ($r | map({resourceId, tags: ([.tags[]? | "\\(.categoryName)/\\(.name)"] | sort)}) | sort_by(.resourceId))',
    '  }\' > "$out"',
    '  rm -f "$out.cats" "$out.tags" "$out.res"',
    '}',
  ];
}

/** PowerCLI: connect to every vCenter with a password read from a file, never typed. */
function psConnect(vcenters: readonly string[]): string[] {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version 3',
    'Import-Module VMware.VimAutomation.Core -ErrorAction Stop',
    '',
    `$vcList = if ($env:VCENTERS) { @($env:VCENTERS -split '[,\\s]+' | Where-Object { $_ }) } else { @(${vcenters.map((v) => `'${v}'`).join(', ')}) }`,
    "if (-not $env:VC_USER) { throw 'Set VC_USER to a vCenter account with the tagging privileges.' }",
    "if (-not $env:VC_PASSWORD_FILE) { throw 'Set VC_PASSWORD_FILE to a file, readable only by this account, holding the password of VC_USER.' }",
    'if ($IsLinux -or $IsMacOS) {',
    '  # 0x3F is every group and other permission bit: the file must be 600 or 400.',
    '  # GetUnixFileMode needs PowerShell 7.3 (.NET 7); older versions skip the check with a warning.',
    '  $mode = try { [int][System.IO.File]::GetUnixFileMode($env:VC_PASSWORD_FILE) } catch { Write-Warning "Cannot read the mode of $($env:VC_PASSWORD_FILE); check it is 600 yourself."; 0 }',
    '  if ($mode -band 0x3F) { throw "Refusing: $($env:VC_PASSWORD_FILE) is readable by others. chmod 600 it." }',
    '}',
    '$secure = (Get-Content -LiteralPath $env:VC_PASSWORD_FILE -Raw).TrimEnd("`r", "`n") | ConvertTo-SecureString -AsPlainText -Force',
    '$cred = [System.Management.Automation.PSCredential]::new($env:VC_USER, $secure)',
    'foreach ($vc in $vcList) { Connect-VIServer -Server $vc -Credential $cred | Out-Null }',
  ];
}

// ---------------------------------------------------------------------------
// The standard in the formats people import tags with
// ---------------------------------------------------------------------------

/**
 * vSphere type names (as /api/cis/tagging spells them) to the names PowerCLI's
 * New-TagCategory -EntityType takes. The three marked VERIFY have no PowerCLI
 * name confirmed here; the script passes them through and PowerCLI refuses an
 * unknown one before creating anything.
 */
const POWERCLI_TYPES: Readonly<Record<string, string>> = {
  VirtualMachine: 'VirtualMachine',
  HostSystem: 'VMHost',
  ClusterComputeResource: 'Cluster',
  Datastore: 'Datastore',
  StoragePod: 'DatastoreCluster',
  DistributedVirtualPortgroup: 'DistributedPortGroup',
  VmwareDistributedVirtualSwitch: 'DistributedSwitch',
  Folder: 'Folder',
  Datacenter: 'Datacenter',
  ResourcePool: 'ResourcePool',
  VirtualApp: 'VApp',
  Network: 'Network',
  'com.vmware.content.Library': 'ContentLibrary',
  'com.vmware.content.library.Item': 'ContentLibraryItem',
};
const POWERCLI_UNCONFIRMED = ['Network', 'com.vmware.content.Library', 'com.vmware.content.library.Item'];

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The description each tag carries: the same text create-vcenter.sh writes. */
function tagDescription(category: string, value: string): string {
  return `${category} ${value} (ArchToolKit tag standard)`;
}

/**
 * The PowerCLI-ready CSV: Category,Cardinality,EntityType,Tag,Description — one
 * row per tag, the category's settings repeated on each. EntityType is the
 * PowerCLI names joined with ";" (All when the category applies to every type).
 * A free-text category has one row with an empty Tag: the category only.
 */
function powercliCsv(categories: readonly StdCategory[]): string {
  const rows = categories.flatMap((c) => {
    const types = c.types.length === 0 ? 'All' : c.types.map((t) => POWERCLI_TYPES[t] ?? t).join(';');
    const card = c.cardinality === 'SINGLE' ? 'Single' : 'Multiple';
    const values = c.values.length === 0 ? [''] : c.values;
    return values.map((v) => [c.name, card, types, v, c.description].map(csvCell).join(','));
  });
  return `${['Category,Cardinality,EntityType,Tag,Description', ...rows].join('\r\n')}\r\n`;
}

function powercliImportScript(vcenters: readonly string[]): string {
  return [
    '<#',
    '.SYNOPSIS',
    '  Create the tag standard in tag-standard.csv on every vCenter, with PowerCLI.',
    '.DESCRIPTION',
    '  Reads Category,Cardinality,EntityType,Tag,Description. Creates each category',
    '  that does not exist (exact, case-sensitive name) and each tag missing from',
    '  it. Never changes or deletes an existing one; a category that exists with a',
    '  different cardinality is reported. Dry run unless -Execute is given.',
    '',
    '  VC_USER and VC_PASSWORD_FILE (mode 600) log in; VCENTERS overrides the list.',
    '.EXAMPLE',
    '  pwsh ./Import-TagStandard.ps1            # what it would create',
    '  pwsh ./Import-TagStandard.ps1 -Execute   # create it',
    '#>',
    '[CmdletBinding()]',
    'param(',
    "  [string]$CsvPath = (Join-Path $PSScriptRoot 'tag-standard.csv'),",
    '  [switch]$Execute',
    ')',
    ...psConnect(vcenters),
    '',
    '$rows = @(Import-Csv -LiteralPath $CsvPath)',
    "foreach ($col in 'Category', 'Cardinality', 'EntityType', 'Tag', 'Description') {",
    '  if (-not ($rows[0].PSObject.Properties.Name -contains $col)) { throw "$CsvPath has no $col column." }',
    '}',
    '$problems = 0',
    'foreach ($server in $global:DefaultVIServers) {',
    '  foreach ($group in ($rows | Group-Object -Property Category)) {',
    '    $first = $group.Group[0]',
    "    $types = @($first.EntityType -split '[;,]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })",
    '    $cat = Get-TagCategory -Server $server -ErrorAction SilentlyContinue | Where-Object { $_.Name -ceq $group.Name }',
    '    if (-not $cat) {',
    '      $near = Get-TagCategory -Server $server -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq $group.Name }',
    '      if ($near) { Write-Warning "$($server.Name): category $($near.Name) exists in another case; skipped $($group.Name)."; $problems++; continue }',
    '      if ($Execute) {',
    '        $cat = New-TagCategory -Server $server -Name $group.Name -Cardinality $first.Cardinality -EntityType $types -Description $first.Description',
    '        Write-Output "$($server.Name): created category $($group.Name)"',
    '      } else {',
    "        Write-Output \"$($server.Name): WOULD create category $($group.Name) ($($first.Cardinality); $($types -join ', '))\"",
    '      }',
    '    } elseif ([string]$cat.Cardinality -ne $first.Cardinality) {',
    '      Write-Warning "$($server.Name): category $($group.Name) is $($cat.Cardinality), the standard says $($first.Cardinality). Not changed."',
    '      $problems++',
    '    }',
    '    foreach ($row in $group.Group) {',
    '      if (-not $row.Tag) { continue }',
    '      $tag = if ($cat) { Get-Tag -Server $server -Category $cat -ErrorAction SilentlyContinue | Where-Object { $_.Name -ceq $row.Tag } }',
    '      if ($tag) { continue }',
    '      if ($Execute) {',
    '        New-Tag -Server $server -Name $row.Tag -Category $cat -Description "$($group.Name) $($row.Tag) (ArchToolKit tag standard)" | Out-Null',
    '        Write-Output "$($server.Name): created tag $($group.Name)/$($row.Tag)"',
    '      } else {',
    '        Write-Output "$($server.Name): WOULD create tag $($group.Name)/$($row.Tag)"',
    '      }',
    '    }',
    '  }',
    '}',
    "if (-not $Execute) { Write-Output 'Dry run: nothing was created. Re-run with -Execute.' }",
    'Disconnect-VIServer -Server * -Confirm:$false | Out-Null',
    'if ($problems -gt 0) { exit 1 }',
    '',
  ].join('\n');
}

/**
 * The exact bodies of POST /api/cis/tagging/category and POST
 * /api/cis/tagging/tag — the ones create-vcenter.sh sends. A tag body names
 * its category by id, which vCenter assigns on creation; the file carries a
 * placeholder there that create-vcenter.sh (or you) replaces.
 */
function vcenterRestFiles(categories: readonly StdCategory[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const c of categories) {
    const slug = slugOf(c.name, 'category');
    files[`import/vcenter-rest/categories/${slug}.json`] = `${JSON.stringify({ name: c.name, description: c.description, cardinality: c.cardinality, associable_types: [...c.types].sort() }, null, 2)}\n`;
    for (const v of c.values) {
      files[`import/vcenter-rest/tags/${slug}/${slugOf(v, 'tag')}.json`] = `${JSON.stringify({ name: v, description: tagDescription(c.name, v), category_id: `<REQUIRED — the id POST /api/cis/tagging/category returned for ${c.name}>` }, null, 2)}\n`;
    }
  }
  return files;
}

const TAG_SOURCES = [
  'vCenter REST: POST /api/cis/tagging/category {name, description, cardinality SINGLE|MULTIPLE, associable_types} and POST /api/cis/tagging/tag {name, description, category_id} — the vSphere Automation API reference (the /api form takes the create spec as the body; the old /rest form wrapped it in create_spec).',
  'PowerCLI: New-TagCategory -Name -Cardinality Single|Multiple -EntityType -Description, New-Tag -Name -Category -Description (VMware.VimAutomation.Core).',
  'VCF Operations tag management: VMware Cloud Foundation blog, "Introducing Centralized Tag Management in VMware Cloud Foundation 9.0" (create categories and tags in VCF Operations, import them from a vCenter, push them to vCenters — no file import) and "VCF 9.1 Tag Management: Elevating Operational Governance"; the 9.1.1 API reference under /suite-api/api/fleet-management/tag-management, as cited in create-fleet.sh.',
];

/** A short IMPORT.md for the tag blueprints whose files are read by their own scripts. */
function tagsImport(intro: string, steps: readonly (ImportStepSpec | undefined)[], verify: readonly string[] = []): string {
  return importGuide({ product: 'vCenter and VCF Operations tag management', intro, steps, verify, sources: TAG_SOURCES });
}

/** IMPORT.md for the standard: every format, and which one goes where. */
function taxonomyImport(categories: readonly StdCategory[], route: string, packageSteps: readonly ImportStepSpec[] = []): string {
  const tags = categories.reduce((n, c) => n + c.values.length, 0);
  const unconfirmed = [...new Set(categories.flatMap((c) => c.types))].filter((t) => POWERCLI_UNCONFIRMED.includes(t));
  return importGuide({
    product: 'vCenter and VCF Operations tag management',
    intro: `The same standard — ${categories.length} categories, ${tags} tags — in each form tags are imported with. Pick one route per vCenter; every route creates only what is missing.`,
    steps: [
      ...packageSteps,
      {
        heading: 'Route A — the scripts, from a Linux host (instead of the package)',
        lines: [
          route === 'fleet'
            ? '`./scripts/create-fleet.sh` (dry run), then `./scripts/create-fleet.sh --execute`: creates the categories and tags in VCF Operations fleet tag management and pushes them to the vCenters. It reads scripts/tag-standard.json beside it.'
            : '`./scripts/create-vcenter.sh` (dry run), then `./scripts/create-vcenter.sh --execute`: sends exactly the bodies under import/vcenter-rest/ to every vCenter in VCENTERS, filling each tag’s category_id with the id its category got. It reads scripts/tag-standard.json beside it.',
          ...(route === 'both' ? ['', 'Then `FLEET_ADAPTERS=<vCenter adapter ids> ./scripts/create-fleet.sh --execute`: imports the categories from those vCenters into VCF Operations fleet tag management.'] : []),
        ],
      },
      {
        heading: 'Route B — PowerCLI with the CSV',
        lines: [
          'import/powercli/tag-standard.csv has the columns Category,Cardinality,EntityType,Tag,Description (one row per tag; EntityType is PowerCLI names separated by ";"). Run from import/powercli:',
          '',
          '```',
          'pwsh ./Import-TagStandard.ps1            # dry run',
          'pwsh ./Import-TagStandard.ps1 -Execute   # create',
          '```',
          '',
          'with VC_USER and VC_PASSWORD_FILE (mode 600) set, and VCENTERS to override the list.',
        ],
      },
      {
        heading: 'Route C — the vCenter REST bodies by hand',
        lines: [
          'Each file under import/vcenter-rest/categories/ is the body of POST https://<vcenter>/api/cis/tagging/category; the response is the new category id. Put that id into category_id of each file under import/vcenter-rest/tags/<category>/ and POST it to /api/cis/tagging/tag. Categories first, then their tags.',
        ],
      },
      {
        heading: 'VCF Operations 9.x tag management',
        lines: [
          'VCF Operations does not import tags from a file. Its import is from a vCenter: create the standard in one vCenter by route A, B or C, then Manage > Fleet Management > Tags > Import from vCenter (or the workflow with route both, or scripts/create-fleet.sh, which call the same import), and push to the other vCenters from there. Or create it centrally (route "fleet only") and push — but not both, or every category gets two ids.',
        ],
      },
    ],
    verify: [
      'VCF Operations 9.1 tag management file import: none found in the 9.0 and 9.1 descriptions; if your build offers one, compare its template with import/powercli/tag-standard.csv.',
      'The VCF 9.1 API-token login to vCenter (identity broker token, exchanged for a SAML token, presented as SIGN) follows davidwzhang.com "VCF 9.1 API Access (4)"; confirm it against your vCenter, or use vcUsername and vcPassword.',
      'How a fleet import (POST .../adapters/{adapterId}/categories/pull) reconciles the same category name arriving from a second vCenter is not spelt out in the 9.1.1 reference; the workflow checks every category and value by exact name afterwards and reports what is missing.',
      ...(unconfirmed.length > 0 ? [`PowerCLI -EntityType names for ${unconfirmed.join(', ')} are not confirmed here; PowerCLI refuses an unknown name before creating anything.`] : []),
      'Import-TagStandard.ps1 was parsed, not run against a vCenter.',
    ],
    sources: TAG_SOURCES,
  });
}

/** The note every vCenter-script README carries about who runs it. */
const VC_REQUIRES = [
  'bash 4+, curl 7.55+ and jq 1.6+ on the machine that runs the scripts.',
  'VCF 9.1: an API client in VCF Operations with the vSphere Tagging privileges on every vCenter in VCENTERS, its API token in a mode-600 file (VCF_API_TOKEN_FILE), and VCF_IDB_HOST set to the Identity Broker. No password anywhere. 8.x and 9.0: a vCenter account (VC_USER) with those privileges and its password in a mode-600 file (VC_PASSWORD_FILE, or VC_PASSWORD_DIR/<vcenter> when each vCenter has its own SSO domain).',
  'VC_CACERT pointing at the CA bundle if the vCenters use a private CA. The scripts never switch certificate checking off.',
];

const STANDARD_INPUT = {
  id: 'standard',
  label: 'Tag standard',
  control: 'textarea' as const,
  default: DEFAULT_STANDARD,
  hint: 'Category | single or multiple | object types | values | required on | description',
};

const VCENTERS_INPUT = { id: 'vcenters', label: 'vCenters', control: 'text' as const, default: DEFAULT_VCENTERS, hint: 'Comma separated. Every script also takes VCENTERS from the environment' };

// ---------------------------------------------------------------------------
// 1. The standard, and the script that creates it
// ---------------------------------------------------------------------------

function createVcenterScript(vcenters: readonly string[]): string {
  return [
    '#!/usr/bin/env bash',
    '# Create the tag standard in tag-standard.json on every vCenter in VCENTERS.',
    '#',
    '# Idempotent. Categories and tags are matched by name and only what is missing',
    '# is created, so running it twice creates nothing the second time. A category',
    '# that exists with a different cardinality or fewer object types is reported,',
    '# never changed: vCenter can widen a category but never narrow it, so that is',
    '# a decision for a person. A name that exists in a different case is skipped',
    '# and reported, because creating the second spelling splits the estate in two.',
    '#',
    '#   ./create-vcenter.sh                              dry run: list what would be created',
    '#   ./create-vcenter.sh --execute                    create it; ids go to created-<run>.tsv',
    '#   ./create-vcenter.sh --undo created-<run>.tsv [--execute]',
    '#                                                    delete what that run created, if unattached',
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    vcentersLine(vcenters),
    'STANDARD=tag-standard.json',
    'DRY_RUN=1; UNDO=""',
    'while (( $# )); do',
    '  case "$1" in',
    '    --execute) DRY_RUN=0 ;;',
    '    --undo) UNDO="${2:?--undo needs the created-*.tsv file}"; shift ;;',
    '    *) echo "unknown argument: $1" >&2; exit 2 ;;',
    '  esac',
    '  shift',
    'done',
    '',
    ...vcLib(),
    '',
    'RUN=$(date -u +%Y%m%dT%H%M%SZ)',
    'CREATED="created-${RUN}.tsv"',
    'PROBLEMS=0; WOULD=0',
    '',
    'if [[ -n "$UNDO" ]]; then',
    '  # Tags first, then categories: a category with tags in it cannot be deleted.',
    '  for kind in tag category; do',
    '    while IFS=$\'\\t\' read -r host k id name; do',
    '      [[ "$k" == "$kind" ]] || continue',
    '      [[ -n "${SID[$host]:-}" ]] || vc_login "$host"',
    '      if [[ "$kind" == tag ]]; then',
    '        n=$(attached_count "$host" "$id")',
    '        if (( n > 0 )); then echo "KEEP  tag $name on $host: attached to $n object(s)"; continue; fi',
    '      else',
    '        n=$(jq -n --arg c "$id" \'{category_id: $c}\' | vc POST "$host" "/api/cis/tagging/tag?action=list-tags-for-category" --data-binary @- | jq length)',
    '        if (( n > 0 )); then echo "KEEP  category $name on $host: still has $n tag(s)"; continue; fi',
    '      fi',
    '      if (( DRY_RUN )); then echo "DRY RUN: would delete $kind $name on $host"; continue; fi',
    '      vc DELETE "$host" "/api/cis/tagging/${kind}/${id}" >/dev/null && echo "deleted $kind $name on $host"',
    '    done < "$UNDO"',
    '  done',
    '  exit 0',
    'fi',
    '',
    'for host in ${VCENTERS//,/ }; do',
    '  vc_login "$host"',
    '  load_catalogue "$host" "$WORK/$host.json"',
    '  echo "== $host: $(jq \'.categories | length\' "$WORK/$host.json") categories, $(jq \'.tags | length\' "$WORK/$host.json") tags today"',
    '  while read -r cat; do',
    '    name=$(jq -r .name <<<"$cat")',
    '    existing=$(jq -c --arg n "$name" \'[.categories[] | select(.name == $n)] | first // empty\' "$WORK/$host.json")',
    '    if [[ -z "$existing" ]]; then',
    '      near=$(jq -r --arg n "$name" \'[.categories[] | select((.name | ascii_downcase) == ($n | ascii_downcase)) | .name] | join(", ")\' "$WORK/$host.json")',
    '      if [[ -n "$near" ]]; then',
    '        echo "SKIP  category \\"$name\\" exists as \\"$near\\". Rename one by hand; do not create both."',
    '        PROBLEMS=$((PROBLEMS + 1)); continue',
    '      fi',
    '    fi',
    '    cid=""',
    '    if [[ -n "$existing" ]]; then',
    '      cid=$(jq -r .id <<<"$existing")',
    '      drift=$(jq -rn --argjson s "$cat" --argjson e "$existing" \'[',
    '        (if $s.cardinality != $e.cardinality then "cardinality is \\($e.cardinality), the standard says \\($s.cardinality)" else empty end),',
    '        (($s.associable_types - $e.associable_types) as $m | if ($e.associable_types | length) > 0 and ($m | length) > 0 then "cannot yet go on \\($m | join(", "))" else empty end)',
    '      ] | join("; ")\')',
    '      [[ -n "$drift" ]] && { echo "DRIFT category $name: $drift. Not changed."; PROBLEMS=$((PROBLEMS + 1)); }',
    '    elif (( DRY_RUN )); then',
    '      echo "WOULD create category $name ($(jq -r \'.cardinality + ", " + ((.associable_types | join(",")) // "") \' <<<"$cat"))"',
    '      WOULD=$((WOULD + 1))',
    '    else',
    '      cid=$(jq -c \'{name, description, cardinality, associable_types}\' <<<"$cat" |',
    '        vc POST "$host" /api/cis/tagging/category --data-binary @- | jq -r .)',
    '      printf \'%s\\tcategory\\t%s\\t%s\\n\' "$host" "$cid" "$name" >> "$CREATED"',
    '      echo "created category $name"',
    '    fi',
    '    while read -r value; do',
    '      [[ -z "$value" ]] && continue',
    '      if [[ -n "$existing" ]]; then',
    '        jq -e --arg c "$cid" --arg v "$value" \'any(.tags[]; .category_id == $c and .name == $v)\' "$WORK/$host.json" >/dev/null && continue',
    '        near=$(jq -r --arg c "$cid" --arg v "$value" \'[.tags[] | select(.category_id == $c and ((.name | ascii_downcase) == ($v | ascii_downcase))) | .name] | join(", ")\' "$WORK/$host.json")',
    '        if [[ -n "$near" ]]; then echo "SKIP  $name=$value exists as \\"$near\\""; PROBLEMS=$((PROBLEMS + 1)); continue; fi',
    '      fi',
    '      if (( DRY_RUN )); then echo "WOULD create tag $name=$value"; WOULD=$((WOULD + 1)); continue; fi',
    '      tid=$(jq -n --arg n "$value" --arg c "$cid" --arg d "$name $value (ArchToolKit tag standard)" \'{name: $n, description: $d, category_id: $c}\' |',
    '        vc POST "$host" /api/cis/tagging/tag --data-binary @- | jq -r .)',
    '      printf \'%s\\ttag\\t%s\\t%s\\n\' "$host" "$tid" "$name=$value" >> "$CREATED"',
    '      echo "created tag $name=$value"',
    '    done < <(jq -r \'.values[]\' <<<"$cat")',
    '  done < <(jq -c \'.categories[]\' "$STANDARD")',
    'done',
    '',
    'if (( DRY_RUN )); then',
    '  echo "DRY RUN: $WOULD object(s) would be created, $PROBLEMS problem(s) need a person. Re-run with --execute."',
    'else',
    '  echo "Done. Everything created is listed in $CREATED; --undo $CREATED removes it again while it is unattached."',
    'fi',
    '(( PROBLEMS == 0 ))',
    '',
  ].join('\n');
}

/**
 * The fleet script. `import` (the route that also creates the standard in each
 * vCenter) never creates a category centrally: it pulls the categories
 * create-vcenter.sh made from each vCenter into fleet tag management, so fleet
 * management adopts the vCenter's own category rather than holding a second
 * one of the same name with a different id — which is what makes a later push
 * with overwrite false fail on every vCenter. `create` (fleet only) creates the
 * standard centrally and can push it to vCenters that do not have it yet.
 */
function createFleetScript(mode: 'import' | 'create'): string {
  return [
    '#!/usr/bin/env bash',
    ...(mode === 'import'
      ? [
          '# Bring the tag standard into VCF Operations fleet tag management (Manage >',
          '# Fleet Management > Tags) by IMPORTING it from the vCenters, after',
          '# create-vcenter.sh has created it there.',
          '#',
          '# Why import and not create: a category created in vCenter and one created',
          '# centrally with the same name are two categories with two ids. Fleet',
          '# management then holds its own copy, and pushing it (overwrite false) fails',
          '# on every vCenter with a same-name, different-id conflict. Importing makes',
          '# fleet management manage the category the vCenter already has.',
          '#',
          '# Uses the Tag Management API published with VCF Operations 9.1.1:',
          '#   POST .../adapters/{adapterId}/categories/pull (no body; 202 {taskId}),',
          '#   GET  .../tasks/{taskId}, POST .../categories/query, POST .../categories/{id}/tags/query',
          '#',
          '#   ./create-fleet.sh                    dry run: what fleet management has today,',
          '#                                        and which adapters it would import from',
          '#   ./create-fleet.sh --execute          import from each adapter in FLEET_ADAPTERS,',
          '#                                        one task at a time, then check every',
          '#                                        category and value of the standard is there',
          '#   ./create-fleet.sh --list-adapters    list vCenter adapter ids',
          '#   ./create-fleet.sh --create ...       create centrally instead (only for a',
          '#                                        standard no vCenter has yet; see README)',
        ]
      : [
          '# Create the tag standard centrally in VCF Operations fleet tag management',
          '# (Manage > Fleet Management > Tags), then optionally push it to vCenters.',
          '#',
          '# Uses the Tag Management API published with VCF Operations 9.1.1:',
          '#   POST .../categories/query, POST .../categories, POST .../categories/{id}/tags,',
          '#   POST .../categories/{id}/tags/query, POST .../adapters/{id}/categories/push,',
          '#   POST .../adapters/{id}/categories/pull, GET .../tasks/{id}',
          '# Idempotent the same way as create-vcenter.sh: matched by exact name, only what',
          '# is missing is created, differences are reported and left alone.',
          '#',
          '# A vCenter that already has a category of the same name (made there by hand',
          '# or by create-vcenter.sh) must be IMPORTED (--import), not pushed to: the',
          '# centrally created category has a different id, and the push fails on it.',
          '#',
          '#   ./create-fleet.sh                    dry run',
          '#   ./create-fleet.sh --execute          create what is missing',
          '#   ./create-fleet.sh --execute --push   ...then push the categories to every',
          '#                                        vCenter adapter in FLEET_PUSH_ADAPTERS',
          '#   ./create-fleet.sh --import [--execute]  import from FLEET_ADAPTERS instead',
          '#   ./create-fleet.sh --list-adapters    list vCenter adapter ids',
        ]),
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    'STANDARD=tag-standard.json',
    `DRY_RUN=1; PUSH=0; LIST=0; MODE=${mode}`,
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --execute) DRY_RUN=0 ;;',
    '    --push) PUSH=1 ;;',
    '    --import) MODE=import ;;',
    '    --create) MODE=create ;;',
    '    --list-adapters) LIST=1 ;;',
    '    *) echo "unknown argument: $arg" >&2; exit 2 ;;',
    '  esac',
    'done',
    'if [[ "$MODE" == import ]] && (( PUSH )); then',
    '  echo "Refusing: --push is for categories created centrally. Imported categories are already in their vCenters." >&2',
    '  exit 2',
    'fi',
    '',
    ...fleetLib(),
    '',
    'if (( LIST )); then',
    '  # VERIFY: the suite API adapter list with the fleet Bearer token. If your',
    '  # release refuses it, the vCenter adapter ids are in Administration >',
    '  # Integrations, or in the Import dialog under Fleet Management > Tags.',
    '  curl -sS -f "https://${VCFOPS_HOST}/suite-api/api/adapters?adapterKindKey=VMWARE" \\',
    `    -H "${authHeader('vcf-fleet')}" -H "Accept: application/json" |`,
    '    jq -r \'.adapterInstancesInfoDto[]? | [.id, .resourceKey.name] | @tsv\'',
    '  exit 0',
    'fi',
    '',
    '# Guardrail (create mode): every object type in the standard must be one fleet',
    '# management can tag. Otherwise the category is created without it, and cannot',
    '# be narrowed later if someone widens it by hand.',
    'SUPPORTED=$(fleet GET /categories/associable-types | jq -c \'[.associableTypes[]? | select(.adapterKind == "VMWARE") | .resourceKinds[]] | unique\')',
    'UNSUPPORTED=$(jq -r --argjson s "$SUPPORTED" \'[.categories[].associable_types[]] | unique - $s | join(", ")\' "$STANDARD")',
    'if [[ "$MODE" == create && -n "$UNSUPPORTED" ]]; then',
    '  echo "Refusing: fleet tag management does not list these object types: $UNSUPPORTED" >&2',
    '  echo "Create those categories with create-vcenter.sh instead, or remove the types from the standard." >&2',
    '  exit 1',
    'fi',
    '',
    'PROBLEMS=0; WOULD=0; IDS=()',
    '',
    'if [[ "$MODE" == import ]]; then',
    '  : "${FLEET_ADAPTERS:?set FLEET_ADAPTERS to the adapter ids of the vCenters create-vcenter.sh created the standard on (--list-adapters shows them)}"',
    '  for adapter in ${FLEET_ADAPTERS//,/ }; do',
    '    if (( DRY_RUN )); then echo "WOULD import (pull) categories and tags from adapter $adapter"; continue; fi',
    '    # An import imports everything in that vCenter, not only the standard.',
    '    task=$(fleet POST "/adapters/${adapter}/categories/pull" -d \'\' | jq -r .taskId)',
    '    # One import at a time: the platform refuses a second while one runs.',
    '    wait_task "$task" || PROBLEMS=$((PROBLEMS + 1))',
    '  done',
    '  echo "Checking the standard against fleet tag management$( (( DRY_RUN )) && echo " as it is before the import"):"',
    'fi',
    '',
    'while read -r cat; do',
    '  name=$(jq -r .name <<<"$cat")',
    '  # The query matches names partially, so the exact match is picked here.',
    '  found=$(jq -n --arg n "$name" \'{names: [$n]}\' | fleet POST "/categories/query?page=0&pageSize=1000" --data-binary @-)',
    '  existing=$(jq -c --arg n "$name" \'[.categories[]? | select(.name == $n)] | first // empty\' <<<"$found")',
    '  near=$(jq -r --arg n "$name" \'[.categories[]? | select((.name | ascii_downcase) == ($n | ascii_downcase) and .name != $n) | .name] | join(", ")\' <<<"$found")',
    '  if [[ -z "$existing" && -n "$near" ]]; then',
    '    echo "SKIP  category \\"$name\\" exists as \\"$near\\""; PROBLEMS=$((PROBLEMS + 1)); continue',
    '  fi',
    '  cid=""; have=""',
    '  if [[ -n "$existing" ]]; then',
    '    cid=$(jq -r .id <<<"$existing")',
    '    IDS+=("$cid")',
    '    card=$(jq -r .cardinality <<<"$existing")',
    '    want=$(jq -r .cardinality <<<"$cat")',
    '    [[ "$card" != "$want" ]] && { echo "DRIFT category $name is $card, the standard says $want. Not changed."; PROBLEMS=$((PROBLEMS + 1)); }',
    '    have=$(fleet POST "/categories/${cid}/tags/query?page=0&pageSize=1000" --data-binary @- <<<\'{}\' | jq -c \'[.tags[]?.name]\')',
    '  elif [[ "$MODE" == import ]]; then',
    '    # Import mode never creates: a missing category is one the import did not bring.',
    '    if (( DRY_RUN )); then echo "NOT YET category $name: the import should bring it from vCenter"',
    '    else echo "MISSING category $name after the import. Is it in the vCenters behind FLEET_ADAPTERS? Run create-vcenter.sh --execute first."; PROBLEMS=$((PROBLEMS + 1)); fi',
    '    continue',
    '  elif (( DRY_RUN )); then',
    '    echo "WOULD create category $name"; WOULD=$((WOULD + 1))',
    '  else',
    '    cid=$(jq -c --argjson s "$SUPPORTED" \'{name, description, cardinality,',
    '      associableTypes: [{adapterKind: "VMWARE", resourceKinds: (if (.associable_types | length) == 0 then $s else .associable_types end)}]}\' <<<"$cat" |',
    '      fleet POST /categories --data-binary @- | jq -r .id)',
    '    IDS+=("$cid")',
    '    echo "created category $name ($cid)"',
    '  fi',
    '  while read -r value; do',
    '    [[ -z "$value" ]] && continue',
    '    if [[ -n "$have" ]] && jq -e --arg v "$value" \'index($v) != null\' <<<"$have" >/dev/null; then continue; fi',
    '    if [[ "$MODE" == import ]]; then',
    '      if (( DRY_RUN )); then echo "NOT YET tag $name=$value"; else echo "MISSING tag $name=$value after the import"; PROBLEMS=$((PROBLEMS + 1)); fi',
    '      continue',
    '    fi',
    '    if (( DRY_RUN )); then echo "WOULD create tag $name=$value"; WOULD=$((WOULD + 1)); continue; fi',
    '    jq -n --arg n "$value" --arg d "$name $value (ArchToolKit tag standard)" \'{name: $n, description: $d}\' |',
    '      fleet POST "/categories/${cid}/tags" --data-binary @- >/dev/null',
    '    echo "created tag $name=$value"',
    '  done < <(jq -r \'.values[]\' <<<"$cat")',
    'done < <(jq -c \'.categories[]\' "$STANDARD")',
    '',
    'if (( PUSH )); then',
    '  : "${FLEET_PUSH_ADAPTERS:?set FLEET_PUSH_ADAPTERS to the vCenter adapter ids to push to (--list-adapters shows them)}"',
    '  for adapter in ${FLEET_PUSH_ADAPTERS//,/ }; do',
    '    # At most 20 categories per push, the same limit the interface has.',
    '    for (( i = 0; i < ${#IDS[@]}; i += 20 )); do',
    '      body=$(printf \'%s\\n\' "${IDS[@]:i:20}" | jq -R . | jq -sc \'{categoryIds: ., overwrite: false}\')',
    '      if (( DRY_RUN )); then echo "WOULD push $(jq \'.categoryIds | length\' <<<"$body") categories to adapter $adapter"; continue; fi',
    '      task=$(fleet POST "/adapters/${adapter}/categories/push" --data-binary @- <<<"$body" | jq -r .taskId)',
    '      # One push at a time: the next waits for this one to finish.',
    '      wait_task "$task" || PROBLEMS=$((PROBLEMS + 1))',
    '    done',
    '  done',
    'fi',
    '',
    'if (( DRY_RUN )); then',
    '  if [[ "$MODE" == import ]]; then echo "DRY RUN: nothing was imported, $PROBLEMS problem(s). Re-run with --execute."',
    '  else echo "DRY RUN: $WOULD object(s) would be created, $PROBLEMS problem(s). Re-run with --execute."; fi',
    'elif [[ "$MODE" == import ]]; then',
    '  (( PROBLEMS == 0 )) && echo "Every category and value of the standard is in fleet tag management, imported from vCenter."',
    'fi',
    '(( PROBLEMS == 0 ))',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tag compliance as an Orchestrator package
// ---------------------------------------------------------------------------

/**
 * The tag compliance checks as Orchestrator actions: the same checks, in the
 * same order and with the same CSV rows, as the jq program in tag-compliance.sh
 * (the parity test in src/automation/vro/vro.test.ts runs both against the
 * same fake vCenters and compares).
 */
const TAGS_COMPLIANCE_PACKAGE = 'com.archtoolkit.tags.compliance';

const TAGS_COMPLIANCE_ACTIONS: readonly VroActionDef[] = [
  {
    name: 'readVcenter',
    description: 'Read one vCenter: the tag catalogue, every tag association (100 tags a request) and every object tags can be on (VMs host by host, since the VM list refuses rather than pages past its limit). Reads only.',
    resultType: 'Any',
    params: [
      { name: 'host', type: 'string', description: 'vCenter host' },
      { name: 'headers', type: 'Any', description: 'Session header from core.loginVcenter or core.loginVcenterToken' },
    ],
    script: String.raw`var core = System.getModule("com.archtoolkit.core");
var base = "https://" + host;
function get(path) { return core.http("GET", base + path, headers, null, null).body || []; }
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
var categories = [];
var categoryIds = get("/api/cis/tagging/category");
for (var i = 0; i < categoryIds.length; i++) {
  var c = get("/api/cis/tagging/category/" + encodeURIComponent(categoryIds[i]));
  categories.push({ id: c.id, name: c.name, description: c.description, cardinality: c.cardinality, associable_types: (c.associable_types || []).slice().sort(cmp) });
}
categories.sort(function (a, b) { return cmp(a.name, b.name); });
var categoryName = {};
for (var j = 0; j < categories.length; j++) categoryName[categories[j].id] = categories[j].name;
var tags = [];
var tagIds = get("/api/cis/tagging/tag");
for (var k = 0; k < tagIds.length; k++) {
  var t = get("/api/cis/tagging/tag/" + encodeURIComponent(tagIds[k]));
  tags.push({ id: t.id, name: t.name, description: t.description, category_id: t.category_id, category: categoryName[t.category_id] || "?" });
}
tags.sort(function (a, b) { return cmp(a.category, b.category) || cmp(a.name, b.name); });
var associations = [];
for (var from = 0; from < tags.length; from += 100) {
  var batch = [];
  for (var n = from; n < Math.min(from + 100, tags.length); n++) batch.push(tags[n].id);
  var attached = core.http("POST", base + "/api/cis/tagging/tag-association?action=list-attached-objects-on-tags", headers, { tag_ids: batch }, null).body || [];
  for (var a = 0; a < attached.length; a++) {
    var objects = attached[a].object_ids || [];
    for (var o = 0; o < objects.length; o++) associations.push({ tag_id: attached[a].tag_id, type: objects[o].type, id: objects[o].id });
  }
}
associations.sort(function (x, y) { return cmp(x.type, y.type) || cmp(x.id, y.id) || cmp(x.tag_id, y.tag_id); });
var inventory = [];
var seen = {};
function add(type, id, name) {
  var key = type + "/" + id;
  if (seen[key]) return;
  seen[key] = true;
  inventory.push({ type: type, id: id, name: name });
}
var hosts = get("/api/vcenter/host");
for (var h = 0; h < hosts.length; h++) add("HostSystem", hosts[h].host, hosts[h].name);
for (var h2 = 0; h2 < hosts.length; h2++) {
  var vms = get("/api/vcenter/vm?hosts=" + encodeURIComponent(hosts[h2].host));
  for (var v = 0; v < vms.length; v++) add("VirtualMachine", vms[v].vm, vms[v].name);
}
var lists = [["/api/vcenter/cluster", "ClusterComputeResource", "cluster"], ["/api/vcenter/datastore", "Datastore", "datastore"], ["/api/vcenter/folder", "Folder", "folder"], ["/api/vcenter/resource-pool", "ResourcePool", "resource_pool"], ["/api/vcenter/datacenter", "Datacenter", "datacenter"]];
for (var l = 0; l < lists.length; l++) {
  var items = get(lists[l][0]);
  for (var m = 0; m < items.length; m++) add(lists[l][1], items[m][lists[l][2]], items[m].name);
}
var networks = get("/api/vcenter/network");
for (var w = 0; w < networks.length; w++) {
  var kind = networks[w].type === "DISTRIBUTED_PORTGROUP" ? "DistributedVirtualPortgroup" : networks[w].type === "OPAQUE_NETWORK" ? "OpaqueNetwork" : "Network";
  add(kind, networks[w].network, networks[w].name);
}
inventory.sort(function (x, y) { return cmp(x.type, y.type) || cmp(x.name, y.name); });
return { catalogue: { categories: categories, tags: tags }, associations: associations, inventory: inventory };`,
  },
  {
    name: 'checkVcenter',
    description: 'Every problem in one vCenter against the standard, as rows [check, vcenter, object_type, object_id, object_name, category, tag, detail]: category-not-in-standard, category-missing, cardinality-mismatch, object-types-mismatch, value-not-in-standard, tag-unused, cardinality-violation, missing-required.',
    resultType: 'Any',
    params: [
      { name: 'vc', type: 'string', description: 'vCenter host, for the rows' },
      { name: 'standard', type: 'Any', description: 'The parsed tag-standard.json' },
      { name: 'data', type: 'Any', description: 'What readVcenter returned' },
      { name: 'ignore', type: 'Any', description: 'Category names to leave out, or null' },
      { name: 'exclude', type: 'string', description: 'Regular expression: objects whose name matches are never required to carry a tag' },
    ],
    script: String.raw`var S = standard.categories || [];
var C = data.catalogue;
var inventory = data.inventory || [];
var skip = ignore || [];
function has(list, value) {
  for (var i = 0; i < list.length; i++) if (list[i] === value) return true;
  return false;
}
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
var standardNames = [];
for (var i = 0; i < S.length; i++) standardNames.push(S[i].name);
var vcenterNames = [];
for (var j = 0; j < C.categories.length; j++) vcenterNames.push(C.categories[j].name);
var tagById = {};
for (var k = 0; k < C.tags.length; k++) tagById[C.tags[k].id] = C.tags[k];
var nameOf = {};
for (var n = 0; n < inventory.length; n++) nameOf[inventory[n].type + "/" + inventory[n].id] = inventory[n].name;
var A = [];
var uses = {};
var categoriesOn = {};
var raw = data.associations || [];
for (var a = 0; a < raw.length; a++) {
  var tag = tagById[raw[a].tag_id];
  var entry = { tag_id: raw[a].tag_id, type: raw[a].type, id: raw[a].id, category: tag ? tag.category : "?", tag: tag ? tag.name : "?" };
  A.push(entry);
  uses[entry.tag_id] = (uses[entry.tag_id] || 0) + 1;
  var on = entry.type + "/" + entry.id;
  (categoriesOn[on] = categoriesOn[on] || []).push(entry.category);
}
var excluded = exclude ? new RegExp(String(exclude)) : null;
var rows = [];
function row(check, type, id, category, tagName, detail) { rows.push([check, vc, type, id, "", category, tagName, detail]); }
for (var c1 = 0; c1 < C.categories.length; c1++) {
  var cat = C.categories[c1];
  if (!has(standardNames, cat.name) && !has(skip, cat.name)) row("category-not-in-standard", "", "", cat.name, "", "exists in vCenter, not in the standard");
}
for (var s1 = 0; s1 < S.length; s1++) {
  if (!has(vcenterNames, S[s1].name)) row("category-missing", "", "", S[s1].name, "", "in the standard, not in this vCenter");
}
for (var s2 = 0; s2 < S.length; s2++) {
  for (var c2 = 0; c2 < C.categories.length; c2++) {
    if (C.categories[c2].name === S[s2].name && C.categories[c2].cardinality !== S[s2].cardinality) row("cardinality-mismatch", "", "", C.categories[c2].name, "", "vCenter says " + C.categories[c2].cardinality + ", the standard says " + S[s2].cardinality);
  }
}
for (var s3 = 0; s3 < S.length; s3++) {
  for (var c3 = 0; c3 < C.categories.length; c3++) {
    var types = C.categories[c3].associable_types || [];
    if (C.categories[c3].name !== S[s3].name || types.length === 0) continue;
    var missingTypes = [];
    for (var t3 = 0; t3 < S[s3].associable_types.length; t3++) if (!has(types, S[s3].associable_types[t3])) missingTypes.push(S[s3].associable_types[t3]);
    if (missingTypes.length > 0) row("object-types-mismatch", "", "", C.categories[c3].name, "", "cannot go on " + missingTypes.join(" "));
  }
}
for (var t4 = 0; t4 < C.tags.length; t4++) {
  for (var s4 = 0; s4 < S.length; s4++) {
    if (S[s4].name === C.tags[t4].category && !S[s4].free_text && !has(S[s4].values, C.tags[t4].name)) row("value-not-in-standard", "", "", C.tags[t4].category, C.tags[t4].name, "on " + (uses[C.tags[t4].id] || 0) + " object(s)");
  }
}
for (var t5 = 0; t5 < C.tags.length; t5++) {
  var t = C.tags[t5];
  if ((uses[t.id] || 0) !== 0 || has(skip, t.category)) continue;
  var inStandard = false;
  for (var s5 = 0; s5 < S.length; s5++) if (S[s5].name === t.category && has(S[s5].values, t.name)) inStandard = true;
  if (!inStandard) row("tag-unused", "", "", t.category, t.name, "attached to nothing");
}
var groups = {};
var keys = [];
for (var g = 0; g < A.length; g++) {
  var key = JSON.stringify([A[g].type, A[g].id, A[g].category]);
  if (!groups[key]) { groups[key] = []; keys.push(key); }
  groups[key].push(A[g]);
}
keys.sort(function (x, y) {
  var p = JSON.parse(x), q = JSON.parse(y);
  return cmp(p[0], q[0]) || cmp(p[1], q[1]) || cmp(p[2], q[2]);
});
for (var g2 = 0; g2 < keys.length; g2++) {
  var group = groups[keys[g2]];
  if (group.length < 2) continue;
  var single = false;
  for (var s6 = 0; s6 < S.length; s6++) if (S[s6].name === group[0].category && S[s6].cardinality === "SINGLE") single = true;
  if (!single) continue;
  var values = [];
  for (var v = 0; v < group.length; v++) values.push(group[v].tag);
  row("cardinality-violation", group[0].type, group[0].id, group[0].category, values.join(" "), group.length + " values in a one-value category");
}
for (var s7 = 0; s7 < S.length; s7++) {
  var required = S[s7].required_on || [];
  for (var r = 0; r < required.length; r++) {
    for (var o = 0; o < inventory.length; o++) {
      var object = inventory[o];
      if (object.type !== required[r]) continue;
      if (excluded && excluded.test(object.name)) continue;
      if (!has(categoriesOn[object.type + "/" + object.id] || [], S[s7].name)) row("missing-required", object.type, object.id, S[s7].name, "", "no " + S[s7].name + " tag");
    }
  }
}
for (var x = 0; x < rows.length; x++) rows[x][4] = nameOf[rows[x][2] + "/" + rows[x][3]] || "";
return rows;`,
  },
  {
    name: 'compareCatalogues',
    description: 'Tags of standard categories that exist on some vCenters and not others, as missing-in-vcenter rows: a VM moved or restored across them loses the tag, and a group keyed on it covers half the fleet.',
    resultType: 'Any',
    params: [
      { name: 'standard', type: 'Any', description: 'The parsed tag-standard.json' },
      { name: 'catalogues', type: 'Any', description: 'Array of { vc, tags } where tags is readVcenter().catalogue.tags' },
    ],
    script: String.raw`function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
var standardNames = {};
var S = standard.categories || [];
for (var i = 0; i < S.length; i++) standardNames[S[i].name] = true;
var all = [];
var groups = {};
var keys = [];
for (var c = 0; c < catalogues.length; c++) {
  all.push(catalogues[c].vc);
  var tags = catalogues[c].tags || [];
  for (var t = 0; t < tags.length; t++) {
    var key = JSON.stringify([tags[t].category, tags[t].name]);
    if (!groups[key]) { groups[key] = { c: tags[t].category, t: tags[t].name, has: [] }; keys.push(key); }
    groups[key].has.push(catalogues[c].vc);
  }
}
keys.sort(function (x, y) {
  var p = JSON.parse(x), q = JSON.parse(y);
  return cmp(p[0], q[0]) || cmp(p[1], q[1]);
});
var rows = [];
for (var k = 0; k < keys.length; k++) {
  var g = groups[keys[k]];
  if (g.has.length >= all.length || !standardNames[g.c]) continue;
  for (var a = 0; a < all.length; a++) {
    var present = false;
    for (var h = 0; h < g.has.length; h++) if (g.has[h] === all[a]) present = true;
    if (!present) rows.push(["missing-in-vcenter", all[a], "", "", "", g.c, g.t, "exists on " + g.has.join(" ")]);
  }
}
return rows;`,
  },
  {
    name: 'toCsv',
    description: 'The rows as CSV with a header line, every value quoted as jq @csv quotes it.',
    resultType: 'string',
    params: [{ name: 'rows', type: 'Any', description: 'Array of rows' }],
    script: String.raw`var lines = ["check,vcenter,object_type,object_id,object_name,category,tag,detail"];
for (var i = 0; i < rows.length; i++) {
  var cells = [];
  for (var j = 0; j < rows[i].length; j++) cells.push('"' + String(rows[i][j]).split('"').join('""') + '"');
  lines.push(cells.join(","));
}
return lines.join("\n") + "\n";`,
  },
];

const TAGS_COMPLIANCE_WORKFLOW = String.raw`var vcenters = settings.vcenters || [];
if (vcenters.length === 0) throw new Error("No vCenters: set vcenters in the configuration element " + SETTINGS_NAME + ".");
var useToken = !!settings.vcfApiToken;
if (useToken && !settings.vcfIdbHost) throw new Error("vcfApiToken is set but vcfIdbHost is not: set the VCF Identity Broker host in " + SETTINGS_NAME + ".");
if (!useToken && !(settings.vcUsername && settings.vcPassword)) throw new Error("Set vcfIdbHost and vcfApiToken (VCF 9.1), or vcUsername and vcPassword (8.x and 9.0), in " + SETTINGS_NAME + ".");
var standard = JSON.parse(core.resource(RESOURCE_PATH, "tag-standard.json"));
var ignoreCategories = settings.ignoreCategories || [];
var rows = [];
var catalogues = [];
for (var i = 0; i < vcenters.length; i++) {
  var host = String(vcenters[i]);
  System.log("Reading " + host + " ...");
  var headers = useToken ? core.loginVcenterToken(host, settings.vcfIdbHost, settings.vcfApiToken) : core.loginVcenter(host, settings.vcUsername, settings.vcPassword);
  var data;
  try {
    data = mod.readVcenter(host, headers);
  } finally {
    core.logoutVcenter(host, headers);
  }
  var found = mod.checkVcenter(host, standard, data, ignoreCategories, settings.excludeNames || "");
  for (var j = 0; j < found.length; j++) rows.push(found[j]);
  catalogues.push({ vc: host, tags: data.catalogue.tags });
}
if (settings.crossVcenter !== false) {
  var cross = mod.compareCatalogues(standard, catalogues);
  for (var k = 0; k < cross.length; k++) rows.push(cross[k]);
}
var counts = {};
for (var r = 0; r < rows.length; r++) counts[rows[r][0]] = (counts[rows[r][0]] || 0) + 1;
var threshold = settings.maxProblems === null || settings.maxProblems === undefined ? 0 : Number(settings.maxProblems);
problemCount = rows.length;
reportCsv = mod.toCsv(rows);
System.log("Tag compliance: " + problemCount + " problem(s) (threshold " + threshold + ")");
for (var check in counts) System.log("  " + counts[check] + "\t" + check);
var shown = Math.min(rows.length, 500);
for (var p = 0; p < shown; p++) System.log("PROBLEM: " + rows[p].join(" | "));
if (rows.length > shown) System.log("... and " + (rows.length - shown) + " more in the reportCsv output.");
summary = core.audit(null, { source: "archtoolkit-tag-compliance", total: problemCount, threshold: threshold, counts: counts, vcenters: vcenters });
core.notify(settings.webhook, summary);
if (problemCount > threshold && settings.failAboveThreshold !== false) {
  throw new Error("Tag compliance: " + problemCount + " problem(s), above the threshold of " + threshold + ". Every problem is in the log above.");
}`;

// ---------------------------------------------------------------------------
// The other tag automations as Orchestrator packages: shared actions
// ---------------------------------------------------------------------------

const ap = (name: string, type: string, description: string) => ({ name, type, description });

/** The configuration attributes every package that logs in to vCenter carries. */
function vcAttributes(vcenters: readonly string[], why: string) {
  return [
    { name: 'vcenters', type: 'Array/string', value: [...vcenters], description: 'Every vCenter this may log in to' },
    { name: 'vcfIdbHost', type: 'string', value: '', description: 'VCF 9.1: the VCF Identity Broker host' },
    { name: 'vcfApiToken', type: 'SecureString', description: `VCF 9.1: an API token issued to an API client in VCF Operations, with ${why}` },
    { name: 'vcUsername', type: 'string', value: '', description: `8.x and 9.0: an account with ${why}, user@domain, the same on every vCenter` },
    { name: 'vcPassword', type: 'SecureString', description: '8.x and 9.0: its password' },
  ] as const;
}

/**
 * The vCenter tagging actions a package that changes tags carries, in its own
 * module (actions call their siblings through System.getModule(module)).
 *
 * changeTag is the one place a value is replaced, and it is where the rule
 * "never leave an object untagged on failure" lives: in a several-value
 * category the new value is attached and read back before the old one is
 * detached, so the object always has a value. In a one-value category vCenter
 * refuses a second value ("Tagging cardinality violation", see
 * github.com/ansible-collections/community.vmware issue 1501), so there the
 * old value has to go first: detach, attach, read back, and on any failure
 * re-attach the old value at once and read that back too. The error then says
 * ROLLED BACK (the object has its old value) or ROLLBACK-FAILED (it has none,
 * with the tag id to put back), and the run stops either way.
 */
function vcTagActions(module: string, only?: readonly string[]): VroActionDef[] {
  const M = JSON.stringify(module);
  const all: VroActionDef[] = [
    {
      name: 'vcLogin',
      description: 'Log in to one vCenter: with vcfIdbHost and vcfApiToken (VCF 9.1, no password), else with vcUsername and vcPassword (8.x and 9.0). Returns the session header.',
      resultType: 'Any',
      params: [ap('settings', 'Any', 'What core.settings returned'), ap('host', 'string', 'vCenter host')],
      script: String.raw`var core = System.getModule("com.archtoolkit.core");
if (settings.vcfApiToken) {
  if (!settings.vcfIdbHost) throw new Error("vcfApiToken is set but vcfIdbHost is not: set the VCF Identity Broker host.");
  return core.loginVcenterToken(String(host), settings.vcfIdbHost, settings.vcfApiToken);
}
if (!(settings.vcUsername && settings.vcPassword)) throw new Error("Set vcfIdbHost and vcfApiToken (VCF 9.1), or vcUsername and vcPassword (8.x and 9.0), in the configuration element.");
return core.loginVcenter(String(host), settings.vcUsername, settings.vcPassword);`,
    },
    {
      name: 'openVcenter',
      description: 'The session header for a vCenter, logging in the first time and reading its tag catalogue into session.catalogues[host]. Refuses a vCenter not in settings.vcenters. The workflow logs out of every session.headers entry in its finally.',
      resultType: 'Any',
      params: [ap('settings', 'Any', 'What core.settings returned'), ap('session', 'Any', '{ headers: {}, catalogues: {} }'), ap('host', 'string', 'vCenter host')],
      script: String.raw`var mod = System.getModule(${M});
var h = String(host);
if ((settings.vcenters || []).indexOf(h) < 0) throw new Error(h + " is not in vcenters in the configuration element; refusing to log in to it.");
if (!session.headers[h]) {
  session.headers[h] = mod.vcLogin(settings, h);
  session.catalogues[h] = mod.readCatalogue(h, session.headers[h]);
}
return session.headers[h];`,
    },
    {
      name: 'readCatalogue',
      description: 'The tag catalogue of one vCenter: { categories: [{id, name, description, cardinality, associable_types}], tags: [{id, name, description, category_id, category}] }, sorted by name. Reads only.',
      resultType: 'Any',
      params: [ap('host', 'string', 'vCenter host'), ap('headers', 'Any', 'Session header')],
      script: String.raw`var core = System.getModule("com.archtoolkit.core");
var base = "https://" + host;
function get(path) { return core.http("GET", base + path, headers, null, null).body || []; }
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
var categories = [];
var ids = get("/api/cis/tagging/category");
for (var i = 0; i < ids.length; i++) {
  var c = get("/api/cis/tagging/category/" + encodeURIComponent(ids[i]));
  categories.push({ id: String(c.id), name: String(c.name), description: c.description || "", cardinality: String(c.cardinality), associable_types: (c.associable_types || []).slice().sort(cmp) });
}
categories.sort(function (a, b) { return cmp(a.name, b.name); });
var nameOf = {};
for (var j = 0; j < categories.length; j++) nameOf[categories[j].id] = categories[j].name;
var tags = [];
var tagIds = get("/api/cis/tagging/tag");
for (var k = 0; k < tagIds.length; k++) {
  var t = get("/api/cis/tagging/tag/" + encodeURIComponent(tagIds[k]));
  tags.push({ id: String(t.id), name: String(t.name), description: t.description || "", category_id: String(t.category_id), category: nameOf[t.category_id] || "?" });
}
tags.sort(function (a, b) { return cmp(a.category, b.category) || cmp(a.name, b.name); });
return { categories: categories, tags: tags };`,
    },
    {
      name: 'readAssociations',
      description: 'Every association of the given tags, [{tag_id, type, id}], read 100 tags a request with list-attached-objects-on-tags (a POST that only reads).',
      resultType: 'Any',
      params: [ap('host', 'string', 'vCenter host'), ap('headers', 'Any', 'Session header'), ap('tags', 'Any', 'Tags from readCatalogue')],
      script: String.raw`var core = System.getModule("com.archtoolkit.core");
var out = [];
for (var from = 0; from < tags.length; from += 100) {
  var batch = [];
  for (var n = from; n < Math.min(from + 100, tags.length); n++) batch.push(tags[n].id);
  var attached = core.http("POST", "https://" + host + "/api/cis/tagging/tag-association?action=list-attached-objects-on-tags", headers, { tag_ids: batch }, null).body || [];
  for (var a = 0; a < attached.length; a++) {
    var objects = attached[a].object_ids || [];
    for (var o = 0; o < objects.length; o++) out.push({ tag_id: String(attached[a].tag_id), type: String(objects[o].type), id: String(objects[o].id) });
  }
}
return out;`,
    },
    {
      name: 'readInventory',
      description: 'Every object tags can be on, with its name: [{type, id, name}]. VMs host by host, because GET /api/vcenter/vm refuses rather than pages past its limit. Reads only.',
      resultType: 'Any',
      params: [ap('host', 'string', 'vCenter host'), ap('headers', 'Any', 'Session header')],
      script: String.raw`var core = System.getModule("com.archtoolkit.core");
var base = "https://" + host;
function get(path) { return core.http("GET", base + path, headers, null, null).body || []; }
var out = [];
var seen = {};
function add(type, id, name) {
  var key = type + "/" + id;
  if (seen[key]) return;
  seen[key] = true;
  out.push({ type: type, id: String(id), name: String(name) });
}
var hosts = get("/api/vcenter/host");
for (var h = 0; h < hosts.length; h++) add("HostSystem", hosts[h].host, hosts[h].name);
for (var h2 = 0; h2 < hosts.length; h2++) {
  var vms = get("/api/vcenter/vm?hosts=" + encodeURIComponent(hosts[h2].host));
  for (var v = 0; v < vms.length; v++) add("VirtualMachine", vms[v].vm, vms[v].name);
}
var lists = [["/api/vcenter/cluster", "ClusterComputeResource", "cluster"], ["/api/vcenter/datastore", "Datastore", "datastore"], ["/api/vcenter/folder", "Folder", "folder"], ["/api/vcenter/resource-pool", "ResourcePool", "resource_pool"], ["/api/vcenter/datacenter", "Datacenter", "datacenter"]];
for (var l = 0; l < lists.length; l++) {
  var items = get(lists[l][0]);
  for (var m = 0; m < items.length; m++) add(lists[l][1], items[m][lists[l][2]], items[m].name);
}
var networks = get("/api/vcenter/network");
for (var w = 0; w < networks.length; w++) add(networks[w].type === "DISTRIBUTED_PORTGROUP" ? "DistributedVirtualPortgroup" : networks[w].type === "OPAQUE_NETWORK" ? "OpaqueNetwork" : "Network", networks[w].network, networks[w].name);
return out;`,
    },
    {
      name: 'tagsOn',
      description: 'The tag ids attached to one object now (list-attached-tags-on-objects, a POST that only reads).',
      resultType: 'Any',
      params: [ap('host', 'string', 'vCenter host'), ap('headers', 'Any', 'Session header'), ap('type', 'string', 'Object type, e.g. VirtualMachine'), ap('id', 'string', 'MoRef, e.g. vm-42')],
      script: String.raw`var r = System.getModule("com.archtoolkit.core").http("POST", "https://" + host + "/api/cis/tagging/tag-association?action=list-attached-tags-on-objects", headers, { object_ids: [{ type: String(type), id: String(id) }] }, null).body || [];
var out = [];
for (var i = 0; i < r.length; i++) {
  var t = r[i].tag_ids || [];
  for (var j = 0; j < t.length; j++) out.push(String(t[j]));
}
return out;`,
    },
    {
      name: 'resolveObject',
      description: 'An object name or MoRef to { type, id }, or "NOT_FOUND", "AMBIGUOUS" (more than one object of that type has the name) or "UNSUPPORTED" (a type this cannot look up). GET /api/vcenter/<type>?names= or ?<type>s=.',
      resultType: 'Any',
      params: [ap('host', 'string', 'vCenter host'), ap('headers', 'Any', 'Session header'), ap('type', 'string', 'Object type'), ap('ref', 'string', 'Name or MoRef')],
      script: String.raw`var TYPES = { VirtualMachine: ["vm", "vm", "vms"], HostSystem: ["host", "host", "hosts"], ClusterComputeResource: ["cluster", "cluster", "clusters"], Datastore: ["datastore", "datastore", "datastores"], Folder: ["folder", "folder", "folders"], ResourcePool: ["resource-pool", "resource_pool", "resource_pools"], Datacenter: ["datacenter", "datacenter", "datacenters"], Network: ["network", "network", "networks"], DistributedVirtualPortgroup: ["network", "network", "networks"] };
var t = TYPES[String(type)];
if (!t) return "UNSUPPORTED";
var moref = /^(vm-|host-|domain-c|datastore-|group-[a-z]|resgroup-|datacenter-|network-|dvportgroup-)[0-9]+$/.test(String(ref));
var list = System.getModule("com.archtoolkit.core").http("GET", "https://" + host + "/api/vcenter/" + t[0] + "?" + (moref ? t[2] : "names") + "=" + encodeURIComponent(String(ref)), headers, null, null).body || [];
if (list.length === 0) return "NOT_FOUND";
if (list.length > 1) return "AMBIGUOUS";
var kind = String(type);
if (t[1] === "network") kind = list[0].type === "DISTRIBUTED_PORTGROUP" ? "DistributedVirtualPortgroup" : "Network";
return { type: kind, id: String(list[0][t[1]]) };`,
    },
    {
      name: 'changeTag',
      description:
        'Attach, detach or replace one value on one object, and read the object back. Replace in a several-value category: attach the new value, read it back, then detach the old — never without a value. Replace in a one-value category (vCenter refuses a second value): detach, attach, read back, and on failure re-attach the old value at once and read it back; the error says ROLLED BACK or ROLLBACK-FAILED. Returns "ok" or throws.',
      resultType: 'string',
      params: [
        ap('host', 'string', 'vCenter host'),
        ap('headers', 'Any', 'Session header'),
        ap('type', 'string', 'Object type'),
        ap('id', 'string', 'MoRef'),
        ap('fromTagId', 'string', 'The value to remove, or null'),
        ap('toTagId', 'string', 'The value to set, or null'),
        ap('cardinality', 'string', 'SINGLE or MULTIPLE, of the category'),
        ap('label', 'string', 'What this is, for the errors'),
      ],
      script: String.raw`var core = System.getModule("com.archtoolkit.core");
var mod = System.getModule(${M});
var base = "https://" + host + "/api/cis/tagging/tag-association/";
var object = { object_id: { type: String(type), id: String(id) } };
function attach(tag) { core.http("POST", base + encodeURIComponent(tag) + "?action=attach", headers, object, null); }
function detach(tag) { core.http("POST", base + encodeURIComponent(tag) + "?action=detach", headers, object, null); }
function now() { try { return mod.tagsOn(host, headers, type, id); } catch (e) { return null; } }
function on(list, tag) { return list !== null && list.indexOf(String(tag)) >= 0; }
function why(e) { return e && e.message ? e.message : String(e); }
var after;
if (!fromTagId) {
  try { attach(toTagId); } catch (e1) { if (!on(now(), toTagId)) throw new Error(label + ": the attach failed: " + why(e1)); }
  if (!on(now(), toTagId)) throw new Error(label + ": the value is not on the object after the attach.");
  return "ok";
}
if (!toTagId) {
  try { detach(fromTagId); } catch (e2) { if (on(now(), fromTagId)) throw new Error(label + ": the detach failed: " + why(e2)); }
  after = now();
  if (after === null || on(after, fromTagId)) throw new Error(label + ": the value is still on the object, or it could not be read back.");
  return "ok";
}
if (String(cardinality) !== "SINGLE") {
  // Several values allowed: the new value first, so the object is never without one.
  try { attach(toTagId); } catch (e3) { if (!on(now(), toTagId)) throw new Error(label + ": the new value did not take (" + why(e3) + "); the old value was not touched."); }
  if (!on(now(), toTagId)) throw new Error(label + ": the new value is not on the object; the old value was not touched.");
  try { detach(fromTagId); } catch (e4) { if (on(now(), fromTagId)) throw new Error(label + ": the new value is on, but the old one could not be detached (" + why(e4) + "); the object carries both."); }
  if (on(now(), fromTagId)) throw new Error(label + ": the new value is on, but the old one is still there; the object carries both.");
  return "ok";
}
// One value allowed: vCenter refuses a second, so the old one must go first.
try { detach(fromTagId); } catch (e5) { if (on(now(), fromTagId)) throw new Error(label + ": could not detach the old value (" + why(e5) + "); nothing changed."); }
var failure = null;
try { attach(toTagId); } catch (e6) { failure = why(e6); }
after = now();
if (on(after, toTagId)) return "ok";
// The old value is gone and the new one did not take: put the old one back now.
try { attach(fromTagId); } catch (e7) { System.warn(label + ": re-attaching the old value: " + why(e7)); }
if (on(now(), fromTagId)) throw new Error(label + ": the new value did not take (" + (failure || "not on the object after the attach") + "); ROLLED BACK: the old value was re-attached and read back.");
throw new Error(label + ": the new value did not take (" + (failure || "not on the object after the attach") + ") AND the old value could not be re-attached: ROLLBACK-FAILED. The object has no value in this category now; attach tag " + fromTagId + " to " + type + " " + id + " by hand, or run the undo with the change log.");`,
    },
    {
      name: 'parseCsv',
      description: 'RFC 4180 CSV text to an array of rows (arrays of strings). Blank lines are dropped.',
      resultType: 'Any',
      params: [ap('text', 'string', 'CSV text')],
      script: String.raw`var s = String(text || "");
var rows = [];
var row = [];
var cell = "";
var quoted = false;
for (var i = 0; i < s.length; i++) {
  var ch = s.charAt(i);
  if (quoted) {
    if (ch === '"' && s.charAt(i + 1) === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = false;
    else cell += ch;
  } else if (ch === '"') quoted = true;
  else if (ch === ",") { row.push(cell); cell = ""; }
  else if (ch === "\n" || ch === "\r") {
    if (ch === "\r" && s.charAt(i + 1) === "\n") i++;
    row.push(cell); rows.push(row); row = []; cell = "";
  } else cell += ch;
}
if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
var out = [];
for (var r = 0; r < rows.length; r++) {
  if (rows[r].join("").replace(/\s/g, "") !== "") out.push(rows[r]);
}
return out;`,
    },
    {
      name: 'toCsv',
      description: 'A header and rows as CSV; a cell is quoted only when it holds a comma, a quote or a line break.',
      resultType: 'string',
      params: [ap('header', 'Any', 'Array of column names'), ap('rows', 'Any', 'Array of arrays')],
      script: String.raw`function cell(v) {
  var s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
}
var lines = [];
var all = [header].concat(rows);
for (var i = 0; i < all.length; i++) {
  var cells = [];
  for (var j = 0; j < all[i].length; j++) cells.push(cell(all[i][j]));
  lines.push(cells.join(","));
}
return lines.join("\n") + "\n";`,
    },
    {
      name: 'undoChangeLog',
      description:
        'Put every object in a change log back as it was, newest row first, working from what is on each object now rather than from the result column — so it is right for a log left by a run that stopped half way, and changes nothing when run twice. Every change goes through core.act (dry run, cap, stop on first failure). Returns the number of objects it had to change.',
      resultType: 'number',
      params: [ap('ctx', 'Any', 'What core.begin returned'), ap('settings', 'Any', 'What core.settings returned'), ap('session', 'Any', '{ headers, catalogues }'), ap('text', 'string', 'The change log CSV')],
      script: String.raw`var core = System.getModule("com.archtoolkit.core");
var mod = System.getModule(${M});
var rows = mod.parseCsv(text);
if (rows.length < 1) throw new Error("The change log is empty.");
var need = ["vcenter", "object_type", "object_id", "object_name", "category", "before_id", "before", "after_id", "after", "action", "result"];
var col = {};
for (var c = 0; c < rows[0].length; c++) col[String(rows[0][c]).replace(/^\s+|\s+$/g, "")] = c;
for (var n = 0; n < need.length; n++) if (!(need[n] in col)) throw new Error("Not a change log: there is no " + need[n] + " column.");
var changed = 0;
for (var r = rows.length - 1; r >= 1; r--) {
  var o = {};
  for (var k = 0; k < need.length; k++) o[need[k]] = rows[r][col[need[k]]] === undefined ? "" : String(rows[r][col[need[k]]]);
  if (!o.object_id || !o.after_id) continue;
  var h = mod.openVcenter(settings, session, o.vcenter);
  var now = mod.tagsOn(o.vcenter, h, o.object_type, o.object_id);
  var hasAfter = now.indexOf(o.after_id) >= 0;
  var needBefore = o.action === "replace" && o.before_id !== "" && now.indexOf(o.before_id) < 0;
  if (!hasAfter && !needBefore) {
    System.log("As before already: " + o.object_name + " " + o.category + "=" + (o.before || "(none)") + " [" + o.result + "]");
    continue;
  }
  var cardinality = "MULTIPLE";
  var cats = session.catalogues[o.vcenter].categories;
  for (var x = 0; x < cats.length; x++) if (cats[x].name === o.category) cardinality = cats[x].cardinality;
  var label = o.object_name + " (" + o.object_id + ") on " + o.vcenter + ": " + o.category;
  var what = hasAfter && needBefore ? "put back " + label + " " + o.after + " -> " + o.before : hasAfter ? "detach " + label + "=" + o.after : "re-attach " + label + "=" + o.before;
  changed++;
  core.act(ctx, what, function () {
    return mod.changeTag(o.vcenter, h, o.object_type, o.object_id, hasAfter ? o.after_id : null, needBefore ? o.before_id : null, cardinality, label);
  });
}
return changed;`,
    },
  ];
  // Each package carries only what it calls (openVcenter needs vcLogin and
  // readCatalogue; changeTag needs tagsOn; undoChangeLog needs parseCsv,
  // openVcenter and changeTag).
  return only ? all.filter((a) => only.includes(a.name)) : all;
}

/** The change log both assignment workflows write, and the undo reads: the same columns as tag-assign.sh writes. */
const CHANGE_LOG_HEADER = ['vcenter', 'object_type', 'object_id', 'object_name', 'category', 'before_id', 'before', 'after_id', 'after', 'action', 'result'];

/**
 * Applying a plan of attach/replace changes: one object at a time, the change
 * log row written as "pending" before each change and its result after, so a
 * run that stops still leaves a log the undo can work from. Shared by the bulk
 * and rule workflows (plan rows are objects with the CHANGE_LOG_HEADER fields
 * plus cardinality).
 */
const APPLY_PLAN = String.raw`function applyPlan(changes) {
  for (var i = 0; i < changes.length; i++) {
    var p = changes[i];
    var entry = { vcenter: p.vcenter, object_type: p.object_type, object_id: p.object_id, object_name: p.object_name, category: p.category, before_id: p.before_id, before: p.before, after_id: p.after_id, after: p.after, action: p.action, result: ctx.dryRun ? "planned" : "pending" };
    changeLog.push(entry);
    var label = p.object_name + " (" + p.object_id + ") on " + p.vcenter + ": " + p.category;
    var what = p.action === "replace" ? "replace " + label + " " + p.before + " -> " + p.after : "attach " + label + "=" + p.after;
    try {
      core.act(ctx, what, function () {
        return mod.changeTag(p.vcenter, session.headers[p.vcenter], p.object_type, p.object_id, p.action === "replace" ? p.before_id : null, p.after_id, p.cardinality, label);
      });
      if (!ctx.dryRun) entry.result = "ok";
    } catch (e) {
      var text = String(e && e.message ? e.message : e);
      // Cap reached and "stopped earlier" mean the change was never attempted.
      entry.result = text.indexOf("ROLLBACK-FAILED") >= 0 ? "ROLLBACK-FAILED" : text.indexOf("ROLLED BACK") >= 0 ? "rolled-back" : /^(Cap reached|Stopped earlier)/.test(text) ? "not-attempted" : entry.result === "pending" ? "failed" : entry.result;
      throw e;
    }
  }
}
function logRows() {
  var out = [];
  for (var i = 0; i < changeLog.length; i++) {
    var e = changeLog[i];
    out.push([e.vcenter, e.object_type, e.object_id, e.object_name, e.category, e.before_id, e.before, e.after_id, e.after, e.action, e.result]);
  }
  return out;
}`;

/** The fleet tag-management actions (VCF Operations 9.1.1 API), for the packages that call it. */
function fleetTagActions(): VroActionDef[] {
  return [
    {
      name: 'fleetCategories',
      description: 'Every category in fleet tag management whose name matches (partially — the query matches partially; pick the exact one yourself), or every category with names empty. POST .../tag-management/categories/query, 1,000 a page. Reads only.',
      resultType: 'Any',
      params: [ap('tm', 'string', 'https://<ops>/suite-api/api/fleet-management/tag-management'), ap('auth', 'Any', 'What core.loginVcfFleet returned'), ap('names', 'Any', 'Array of names, or null')],
      script: String.raw`var core = System.getModule("com.archtoolkit.core");
var body = names && names.length ? { names: names } : {};
return core.pageAll(function (page) {
  var r = core.http("POST", tm + "/categories/query?page=" + page + "&pageSize=1000", auth, body, null).body || {};
  return { items: r.categories || [], total: r.pageInfo ? r.pageInfo.totalCount : null };
}, 0);`,
    },
    {
      name: 'fleetTags',
      description: 'Every tag of one fleet category: POST .../categories/{id}/tags/query, 1,000 a page. Reads only.',
      resultType: 'Any',
      params: [ap('tm', 'string', 'Tag management base URL'), ap('auth', 'Any', 'Bearer header'), ap('categoryId', 'string', 'Category id')],
      script: String.raw`var core = System.getModule("com.archtoolkit.core");
return core.pageAll(function (page) {
  var r = core.http("POST", tm + "/categories/" + encodeURIComponent(categoryId) + "/tags/query?page=" + page + "&pageSize=1000", auth, {}, null).body || {};
  return { items: r.tags || [], total: r.pageInfo ? r.pageInfo.totalCount : null };
}, 0);`,
    },
    {
      name: 'waitTask',
      description: 'Wait for a fleet tagging task (push, pull, assignment): GET .../tasks/{taskId} until SUCCESS; FAILED or DISMISSED throws with its errorMessages, and so does running past maxPolls (10 s apart).',
      resultType: 'Any',
      params: [ap('tm', 'string', 'Tag management base URL'), ap('auth', 'Any', 'Bearer header'), ap('taskId', 'string', 'The taskId a 202 returned'), ap('maxPolls', 'number', 'Give up after this many polls; 0 for 180 (30 minutes)')],
      script: String.raw`var core = System.getModule("com.archtoolkit.core");
if (!taskId) throw new Error("The call returned no taskId.");
var limit = maxPolls && maxPolls > 0 ? maxPolls : 180;
var status = "UNKNOWN";
for (var i = 0; i < limit; i++) {
  var r = core.http("GET", tm + "/tasks/" + encodeURIComponent(taskId), auth, null, null).body || {};
  status = String(r.status || "UNKNOWN");
  if (status === "SUCCESS") return r;
  if (status === "FAILED" || status === "DISMISSED") throw new Error("Task " + taskId + ": " + status + ((r.errorMessages || []).length ? ": " + r.errorMessages.join("; ") : "") + ". Conflicts are under Manage > Fleet Management > Tags (View Conflict Details).");
  System.sleep(10000);
}
throw new Error("Task " + taskId + " is still " + status + " after " + limit + " polls; check it under Manage > Fleet Management > Tags.");`,
    },
    {
      name: 'fleetExport',
      description: 'The whole fleet catalogue and every tagged resource as one sorted document { categories, tags, assignments: [{resourceId, tags: ["Category/tag"]}] }, the same as sync-control.sh export writes, so two exports diff cleanly. Reads only.',
      resultType: 'Any',
      params: [ap('tm', 'string', 'Tag management base URL'), ap('auth', 'Any', 'Bearer header')],
      script: String.raw`var core = System.getModule("com.archtoolkit.core");
var mod = System.getModule(MODULE_NAME);
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
var categories = mod.fleetCategories(tm, auth, null);
var tags = [];
for (var i = 0; i < categories.length; i++) {
  var types = categories[i].associableTypes || [];
  for (var t = 0; t < types.length; t++) types[t].resourceKinds = (types[t].resourceKinds || []).slice().sort(cmp);
  var list = mod.fleetTags(tm, auth, categories[i].id);
  for (var j = 0; j < list.length; j++) tags.push(list[j]);
}
categories.sort(function (a, b) { return cmp(a.name, b.name); });
tags.sort(function (a, b) { return cmp(a.categoryName, b.categoryName) || cmp(a.name, b.name); });
var resources = core.pageAll(function (page) {
  var r = core.http("POST", tm + "/resources/query?page=" + page + "&pageSize=1000", auth, {}, null).body || {};
  return { items: r.resources || [], total: r.pageInfo ? r.pageInfo.totalCount : null };
}, 0);
var assignments = [];
for (var k = 0; k < resources.length; k++) {
  var names = [];
  var on = resources[k].tags || [];
  for (var n = 0; n < on.length; n++) names.push(on[n].categoryName + "/" + on[n].name);
  names.sort(cmp);
  assignments.push({ resourceId: String(resources[k].resourceId), tags: names });
}
assignments.sort(function (a, b) { return cmp(a.resourceId, b.resourceId); });
return { categories: categories, tags: tags, assignments: assignments };`,
    },
  ];
}

/**
 * Create the standard: on each vCenter (only what is missing, by exact name;
 * drift and other-case names reported, never changed), then in fleet tag
 * management — by importing from vCenter (route both) or by creating it
 * centrally and optionally pushing it (route fleet). Mirrors create-vcenter.sh
 * and create-fleet.sh.
 */
const TAXONOMY_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
var SAFE = { redact: settings._secrets };
var ROUTE = String(settings.route || "both");
var S = JSON.parse(core.resource(RESOURCE_PATH, "tag-standard.json")).categories || [];
var problems = [];
function problem(text) { problems.push(text); System.warn("PROBLEM: " + text); }
function lower(s) { return String(s).toLowerCase(); }
var session = { headers: {}, catalogues: {} };
function createVcenter(host) {
  var h = mod.openVcenter(settings, session, host);
  var C = session.catalogues[host];
  System.log("== " + host + ": " + C.categories.length + " categories, " + C.tags.length + " tags today");
  for (var i = 0; i < S.length; i++) {
    var s = S[i];
    var existing = null;
    var near = [];
    for (var c = 0; c < C.categories.length; c++) {
      if (C.categories[c].name === s.name) existing = C.categories[c];
      else if (lower(C.categories[c].name) === lower(s.name)) near.push(C.categories[c].name);
    }
    if (!existing && near.length) { problem(host + ": category \"" + s.name + "\" exists as \"" + near.join(", ") + "\". Rename one by hand; do not create both."); continue; }
    var cid = null;
    if (existing) {
      cid = existing.id;
      if (existing.cardinality !== s.cardinality) problem(host + ": category " + s.name + " is " + existing.cardinality + ", the standard says " + s.cardinality + ". Not changed.");
      var missing = [];
      for (var t = 0; t < s.associable_types.length; t++) if (existing.associable_types.length > 0 && existing.associable_types.indexOf(s.associable_types[t]) < 0) missing.push(s.associable_types[t]);
      if (missing.length) problem(host + ": category " + s.name + " cannot yet go on " + missing.join(", ") + ". Not changed.");
    } else {
      cid = core.act(ctx, "create category " + s.name + " (" + s.cardinality + ") on " + host, function () {
        var r = core.http("POST", "https://" + host + "/api/cis/tagging/category", h, { name: s.name, description: s.description, cardinality: s.cardinality, associable_types: s.associable_types }, SAFE);
        if (typeof r.body !== "string" || !r.body) throw new Error("POST /api/cis/tagging/category returned no id; nothing after it was created.");
        return r.body;
      });
    }
    for (var v = 0; v < s.values.length; v++) {
      var value = s.values[v];
      if (existing) {
        var have = false;
        var nearTag = [];
        for (var x = 0; x < C.tags.length; x++) {
          if (C.tags[x].category_id !== cid) continue;
          if (C.tags[x].name === value) have = true;
          else if (lower(C.tags[x].name) === lower(value)) nearTag.push(C.tags[x].name);
        }
        if (have) continue;
        if (nearTag.length) { problem(host + ": " + s.name + "=" + value + " exists as \"" + nearTag.join(", ") + "\"."); continue; }
      }
      core.act(ctx, "create tag " + s.name + "=" + value + " on " + host, function () {
        var r = core.http("POST", "https://" + host + "/api/cis/tagging/tag", h, { name: value, description: s.name + " " + value + " (ArchToolKit tag standard)", category_id: cid }, SAFE);
        if (typeof r.body !== "string" || !r.body) throw new Error("POST /api/cis/tagging/tag returned no id.");
        return r.body;
      });
    }
  }
}
function fleet() {
  if (!settings.opsHost || !settings.vcfIdbHost || !settings.vcfApiToken) throw new Error("Fleet tag management needs opsHost, vcfIdbHost and vcfApiToken in " + SETTINGS_NAME + ".");
  var TM = "https://" + settings.opsHost + "/suite-api/api/fleet-management/tag-management";
  var auth = core.loginVcfFleet(settings.vcfIdbHost, settings.vcfApiToken);
  var MODE = ROUTE === "both" ? "import" : "create";
  var supported = [];
  var kinds = core.http("GET", TM + "/categories/associable-types", auth, null, SAFE).body || {};
  var list = kinds.associableTypes || [];
  for (var k = 0; k < list.length; k++) if (list[k].adapterKind === "VMWARE") supported = supported.concat(list[k].resourceKinds || []);
  if (MODE === "create") {
    var unsupported = [];
    for (var u = 0; u < S.length; u++) for (var ut = 0; ut < S[u].associable_types.length; ut++) if (supported.indexOf(S[u].associable_types[ut]) < 0 && unsupported.indexOf(S[u].associable_types[ut]) < 0) unsupported.push(S[u].associable_types[ut]);
    if (unsupported.length) throw new Error("Refusing: fleet tag management does not list these object types: " + unsupported.join(", ") + ". Create those categories through the vCenter route, or take the types out of the standard. Nothing was created.");
  }
  if (MODE === "import") {
    var adapters = settings.fleetAdapters || [];
    if (!adapters.length) throw new Error("Set fleetAdapters in " + SETTINGS_NAME + " to the adapter ids of the vCenters the standard was created on.");
    for (var a = 0; a < adapters.length; a++) {
      var adapter = String(adapters[a]);
      // One import at a time: the platform refuses a second while one runs.
      core.act(ctx, "import (pull) the categories and tags of vCenter adapter " + adapter + " into fleet tag management", function () {
        var r = core.http("POST", TM + "/adapters/" + encodeURIComponent(adapter) + "/categories/pull", auth, null, SAFE);
        var task = r.body && r.body.taskId;
        mod.waitTask(TM, auth, task, settings.taskPolls || 0);
        return task;
      });
    }
  }
  var ids = [];
  for (var i = 0; i < S.length; i++) {
    var s = S[i];
    // The query matches names partially; the exact one is picked here.
    var found = mod.fleetCategories(TM, auth, [s.name]);
    var existing = null;
    var near = [];
    for (var f = 0; f < found.length; f++) {
      if (found[f].name === s.name) existing = found[f];
      else if (lower(found[f].name) === lower(s.name)) near.push(found[f].name);
    }
    if (!existing && near.length) { problem("fleet: category \"" + s.name + "\" exists as \"" + near.join(", ") + "\"."); continue; }
    var cid = null;
    var have = [];
    if (existing) {
      cid = String(existing.id);
      ids.push(cid);
      if (existing.cardinality !== s.cardinality) problem("fleet: category " + s.name + " is " + existing.cardinality + ", the standard says " + s.cardinality + ". Not changed.");
      var tags = mod.fleetTags(TM, auth, cid);
      for (var t = 0; t < tags.length; t++) have.push(tags[t].name);
    } else if (MODE === "import") {
      if (ctx.dryRun) System.log("NOT YET: category " + s.name + " (the import should bring it from vCenter)");
      else problem("fleet: category " + s.name + " is missing after the import. Is it in the vCenters behind fleetAdapters?");
      continue;
    } else {
      cid = core.act(ctx, "create category " + s.name + " (" + s.cardinality + ") in fleet tag management", function () {
        var body = { name: s.name, description: s.description, cardinality: s.cardinality, associableTypes: [{ adapterKind: "VMWARE", resourceKinds: s.associable_types.length ? s.associable_types : supported }] };
        var r = core.http("POST", TM + "/categories", auth, body, SAFE);
        if (!r.body || !r.body.id) throw new Error("POST .../categories returned no id; nothing after it was created.");
        return String(r.body.id);
      });
      if (cid) ids.push(cid);
    }
    for (var v = 0; v < s.values.length; v++) {
      var value = s.values[v];
      if (have.indexOf(value) >= 0) continue;
      if (MODE === "import") {
        if (ctx.dryRun) System.log("NOT YET: tag " + s.name + "=" + value);
        else problem("fleet: tag " + s.name + "=" + value + " is missing after the import.");
        continue;
      }
      core.act(ctx, "create tag " + s.name + "=" + value + " in fleet tag management", function () {
        var r = core.http("POST", TM + "/categories/" + encodeURIComponent(cid) + "/tags", auth, { name: value, description: s.name + " " + value + " (ArchToolKit tag standard)" }, SAFE);
        if (!r.body || !r.body.id) throw new Error("POST .../tags returned no id.");
        return String(r.body.id);
      });
    }
  }
  var push = settings.fleetPushAdapters || [];
  if (MODE === "create" && push.length) {
    for (var p = 0; p < push.length; p++) {
      var target = String(push[p]);
      // At most 20 categories a push (the interface's own limit), one push at a time.
      for (var b = 0; b < ids.length; b += 20) {
        var batch = ids.slice(b, b + 20);
        core.act(ctx, "push " + batch.length + " categories to vCenter adapter " + target + " (overwrite false)", function () {
          var r = core.http("POST", TM + "/adapters/" + encodeURIComponent(target) + "/categories/push", auth, { categoryIds: batch, overwrite: false }, SAFE);
          var task = r.body && r.body.taskId;
          mod.waitTask(TM, auth, task, settings.taskPolls || 0);
          return task;
        });
      }
    }
  }
}
try {
  if (ROUTE !== "fleet") {
    var vcenters = settings.vcenters || [];
    if (!vcenters.length) throw new Error("No vCenters: set vcenters in " + SETTINGS_NAME + ".");
    for (var n = 0; n < vcenters.length; n++) createVcenter(String(vcenters[n]));
  }
  if (ROUTE !== "vcenter") fleet();
} finally {
  for (var host in session.headers) core.logoutVcenter(host, session.headers[host]);
}
problemCount = problems.length;
summary = core.audit(ctx, { route: ROUTE, categories: S.length, problems: problems });
core.notify(settings.webhook, summary);
if (problems.length > 0) throw new Error(problems.length + " problem(s) need a person; each is a PROBLEM line in the log. Everything else was done.");`;

/**
 * Bulk assignment from a CSV, as tag-assign.sh does it: plan every row first
 * (resolve the object, check the category, the value, the cardinality and
 * what is attached now), refuse the whole run on a CSV that gives one object
 * two values of a one-value category or plans more changes than the cap, then
 * apply one object at a time through changeTag with a change log that is also
 * the undo. undoLogCsv runs the undo instead.
 */
const BULK_ASSIGN_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
var session = { headers: {}, catalogues: {} };
var changeLog = [];
var planRows = [];
${APPLY_PLAN}
function trim(s) { return String(s === undefined || s === null ? "" : s).replace(/^\s+|\s+$/g, ""); }
var replaceAllowed = replace === true || String(replace) === "true";
var changes = [];
try {
  if (undoLogCsv) {
    var undone = mod.undoChangeLog(ctx, settings, session, String(undoLogCsv));
    System.log((ctx.dryRun ? "DRY RUN: " + undone + " object(s) would be put back." : undone + " object(s) put back."));
  } else {
    var rows = mod.parseCsv(assignmentsCsv ? String(assignmentsCsv) : core.resource(RESOURCE_PATH, "assignments.csv"));
    if (!rows.length || rows[0].join(",").replace(/\s/g, "").toLowerCase() !== "vcenter,object_type,object,category,tag") throw new Error("The first line must be the header vcenter,object_type,object,category,tag.");
    var seen = {};
    var dups = [];
    for (var i = 1; i < rows.length; i++) {
      var cells = rows[i];
      var line = i + 1;
      var host = trim(cells[0]), ref = trim(cells[2]), category = trim(cells[3]), tag = trim(cells[4]);
      var p = { vcenter: host, object_type: trim(cells[1]), object_id: "", object_name: ref, category: category, before_id: "", before: "", after_id: "", after: tag, action: "refused", reason: "", cardinality: "" };
      planRows.push(p);
      if (cells.length !== 5 || !tag) { p.reason = "not five fields"; continue; }
      if ((settings.vcenters || []).indexOf(host) < 0) { p.reason = host + " is not in vcenters in " + SETTINGS_NAME; continue; }
      var h = mod.openVcenter(settings, session, host);
      var C = session.catalogues[host];
      var cat = null;
      for (var c = 0; c < C.categories.length; c++) if (C.categories[c].name === category) cat = C.categories[c];
      if (!cat) { p.reason = "no category " + category + " on " + host; continue; }
      p.cardinality = cat.cardinality;
      for (var t = 0; t < C.tags.length; t++) if (C.tags[t].category_id === cat.id && C.tags[t].name === tag) p.after_id = C.tags[t].id;
      if (!p.after_id) { p.reason = "no tag " + tag + " in " + category + " (values come from the standard)"; continue; }
      var found = mod.resolveObject(host, h, p.object_type, ref);
      if (found === "NOT_FOUND") { p.reason = "no " + p.object_type + " named " + ref; continue; }
      if (found === "AMBIGUOUS") { p.reason = "more than one " + p.object_type + " named " + ref + "; use its MoRef"; continue; }
      if (found === "UNSUPPORTED") { p.reason = p.object_type + " cannot be looked up by this workflow"; continue; }
      p.object_type = found.type;
      p.object_id = found.id;
      if (cat.associable_types.length > 0 && cat.associable_types.indexOf(found.type) < 0) { p.reason = category + " cannot be attached to " + found.type; continue; }
      // Two rows giving one object two values of a one-value category refuse the
      // run below: either order silently loses one of them.
      var key = host + "|" + found.id + "|" + category;
      if (cat.cardinality === "SINGLE" && seen[key]) {
        if (seen[key].tag !== tag) {
          dups.push("rows " + seen[key].line + " and " + line + ": " + ref + " (" + found.id + ") on " + host + " is given " + category + "=" + seen[key].tag + " and " + category + "=" + tag);
          p.reason = "conflicts with row " + seen[key].line + ": " + category + " takes one value";
        } else { p.action = "unchanged"; p.reason = "same as row " + seen[key].line; }
        continue;
      }
      if (cat.cardinality === "SINGLE") seen[key] = { tag: tag, line: line };
      var current = mod.tagsOn(host, h, found.type, found.id);
      if (current.indexOf(p.after_id) >= 0) { p.action = "unchanged"; p.reason = "already tagged"; continue; }
      var same = null;
      for (var s = 0; s < C.tags.length && !same; s++) if (C.tags[s].category_id === cat.id && current.indexOf(C.tags[s].id) >= 0) same = C.tags[s];
      if (same && cat.cardinality === "SINGLE") {
        p.before_id = same.id;
        p.before = same.name;
        if (replaceAllowed) { p.action = "replace"; changes.push(p); }
        else p.reason = "already " + category + "=" + same.name + "; run with the replace input true to change it";
        continue;
      }
      p.action = "attach";
      changes.push(p);
    }
    for (var r = 0; r < planRows.length; r++) {
      var x = planRows[r];
      System.log("PLAN: " + [x.action, x.vcenter, x.object_name + (x.object_id ? " (" + x.object_id + ")" : ""), x.category, (x.before || "-") + " -> " + x.after, x.reason].join(" | "));
    }
    System.log(changes.length + " change(s) planned, " + (planRows.length - changes.length) + " row(s) unchanged or refused.");
    if (dups.length) throw new Error("Refusing: the CSV gives an object two different values of a one-value category: " + dups.join("; ") + ". Keep one row per object and one-value category, then run again. Nothing was changed.");
    if (!ctx.dryRun && changes.length > ctx.cap) throw new Error("Refusing: " + changes.length + " changes is more than the cap of " + ctx.cap + ". Split the CSV, or raise cap after reading the plan. Nothing was changed.");
    applyPlan(changes);
  }
} finally {
  for (var vc in session.headers) core.logoutVcenter(vc, session.headers[vc]);
  var planOut = [];
  for (var q = 0; q < planRows.length; q++) {
    var y = planRows[q];
    planOut.push([y.vcenter, y.object_type, y.object_id, y.object_name, y.category, y.before_id, y.before, y.after_id, y.after, y.action, y.reason]);
  }
  planCsv = mod.toCsv(["vcenter", "object_type", "object_id", "object_name", "category", "before_id", "before", "tag_id", "tag", "action", "reason"], planOut);
  changeLogCsv = mod.toCsv(CHANGE_LOG_HEADER, logRows());
}
summary = core.audit(ctx, { mode: undoLogCsv ? "undo" : "assign", planned: changes.length, rows: planRows.length });
core.notify(settings.webhook, summary);`.replace('CHANGE_LOG_HEADER', JSON.stringify(CHANGE_LOG_HEADER));

/**
 * Rule-based VM tagging, as Tag-Rules.ps1 does it, on the vCenter REST API:
 * fill-only rules set a category only when the VM has no value in it;
 * authoritative rules also replace a different value in a one-value category
 * and add to a several-value one; disagreements are reported, not settled.
 * Folder membership is recursive (child folders are walked explicitly with
 * parent_folders, rather than relying on the VM list filter to recurse).
 */
const RULES_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
var SAFE = { redact: settings._secrets };
var session = { headers: {}, catalogues: {} };
var changeLog = [];
${APPLY_PLAN}
var rules = JSON.parse(core.resource(RESOURCE_PATH, "tag-rules.json"));
var EXCLUDE = String(settings.excludeTag || "");
var conflicts = [];
var changes = [];
function conflict(vc, vm, category, current, wanted, why) { conflicts.push([vc, vm, category, current, wanted, why]); System.warn("CONFLICT: " + [vc, vm, category, current, wanted, why].join(" | ")); }
function planned(base, action, before, after) {
  changes.push({ vcenter: base.vcenter, object_type: base.object_type, object_id: base.object_id, object_name: base.object_name, category: base.category, cardinality: base.cardinality, rule: base.rule, action: action, before_id: before ? before.id : "", before: before ? before.name : "", after_id: after.id, after: after.name });
}
function vmsIn(host, h, query) {
  return core.http("GET", "https://" + host + "/api/vcenter/vm?" + query, h, null, SAFE).body || [];
}
function planVcenter(host) {
  var h = mod.openVcenter(settings, session, host);
  var C = session.catalogues[host];
  var get = function (path) { return core.http("GET", "https://" + host + path, h, null, SAFE).body || []; };
  var tagByPair = {};
  for (var t = 0; t < C.tags.length; t++) tagByPair[C.tags[t].category + "=" + C.tags[t].name] = C.tags[t];
  var tagById = {};
  for (var t2 = 0; t2 < C.tags.length; t2++) tagById[C.tags[t2].id] = C.tags[t2];
  var catByName = {};
  for (var c = 0; c < C.categories.length; c++) catByName[C.categories[c].name] = C.categories[c];
  var usable = [];
  for (var r = 0; r < rules.length; r++) {
    if (tagByPair[rules[r].category + "=" + rules[r].tag]) usable.push(rules[r]);
    else conflict(host, "*", rules[r].category, "", rules[r].tag, "rule " + rules[r].kind + " " + rules[r].pattern + " skipped: there is no tag " + rules[r].category + "=" + rules[r].tag + " on " + host);
  }
  // Every VM, host by host (the VM list refuses rather than pages past its limit).
  var vms = [];
  var hosts = get("/api/vcenter/host");
  for (var hh = 0; hh < hosts.length; hh++) {
    var list = vmsIn(host, h, "hosts=" + encodeURIComponent(hosts[hh].host));
    for (var v = 0; v < list.length; v++) vms.push({ id: String(list[v].vm), name: String(list[v].name) });
  }
  if (!vms.length) return;
  // Every tag on every VM, read once.
  var byVm = {};
  var assoc = mod.readAssociations(host, h, C.tags);
  for (var a = 0; a < assoc.length; a++) {
    if (assoc[a].type !== "VirtualMachine" || !tagById[assoc[a].tag_id]) continue;
    (byVm[assoc[a].id] = byVm[assoc[a].id] || []).push(tagById[assoc[a].tag_id]);
  }
  // Folder and cluster membership, read once per rule.
  var members = {};
  for (var m = 0; m < usable.length; m++) {
    var rule = usable[m];
    if (rule.kind !== "folder" && rule.kind !== "cluster") continue;
    var key = rule.kind + ":" + rule.pattern;
    if (members[key]) continue;
    var set = {};
    if (rule.kind === "cluster") {
      var clusters = get("/api/vcenter/cluster?names=" + encodeURIComponent(rule.pattern));
      for (var cl = 0; cl < clusters.length; cl++) {
        var inCluster = vmsIn(host, h, "clusters=" + encodeURIComponent(clusters[cl].cluster));
        for (var ic = 0; ic < inCluster.length; ic++) set[inCluster[ic].vm] = true;
      }
    } else {
      var queue = get("/api/vcenter/folder?type=VIRTUAL_MACHINE&names=" + encodeURIComponent(rule.pattern));
      var seenFolder = {};
      while (queue.length) {
        var folder = String(queue.shift().folder);
        if (seenFolder[folder]) continue;
        seenFolder[folder] = true;
        var inFolder = vmsIn(host, h, "folders=" + encodeURIComponent(folder));
        for (var f = 0; f < inFolder.length; f++) set[inFolder[f].vm] = true;
        queue = queue.concat(get("/api/vcenter/folder?type=VIRTUAL_MACHINE&parent_folders=" + encodeURIComponent(folder)));
      }
    }
    members[key] = set;
  }
  var needOs = false;
  for (var g = 0; g < usable.length; g++) if (usable[g].kind === "guestos") needOs = true;
  for (var i = 0; i < vms.length; i++) {
    var vm = vms[i];
    var current = byVm[vm.id] || [];
    var pairs = [];
    for (var p = 0; p < current.length; p++) pairs.push(current[p].category + "=" + current[p].name);
    if (EXCLUDE && pairs.indexOf(EXCLUDE) >= 0) continue;
    var os = null;
    if (needOs) {
      // The guest OS from VMware Tools when it runs, else the configured one.
      var ident = core.http("GET", "https://" + host + "/api/vcenter/vm/" + encodeURIComponent(vm.id) + "/guest/identity", h, null, { allow: [400, 404, 503], redact: settings._secrets });
      os = ident.statusCode === 200 && ident.body && ident.body.full_name ? String(ident.body.full_name.default_message || "") : "";
      if (!os) { var info = core.http("GET", "https://" + host + "/api/vcenter/vm/" + encodeURIComponent(vm.id), h, null, SAFE).body || {}; os = String(info.guest_OS || ""); }
    }
    var want = {};
    var order = [];
    for (var u = 0; u < usable.length; u++) {
      var rr = usable[u];
      var hit = false;
      if (rr.kind === "name") hit = new RegExp(rr.pattern, "i").test(vm.name);
      else if (rr.kind === "folder" || rr.kind === "cluster") hit = !!members[rr.kind + ":" + rr.pattern][vm.id];
      else if (rr.kind === "guestos") hit = !!os && os.toLowerCase().indexOf(String(rr.pattern).toLowerCase()) >= 0;
      else if (rr.kind === "tag") hit = pairs.indexOf(rr.pattern) >= 0;
      if (!hit) continue;
      if (!want[rr.category]) { want[rr.category] = []; order.push(rr.category); }
      want[rr.category].push(rr);
    }
    for (var o = 0; o < order.length; o++) {
      var catName = order[o];
      var category = catByName[catName];
      if (!category) continue;
      var wanted = [];
      var why = [];
      var authoritative = false;
      var byAuthority = [];
      for (var w = 0; w < want[catName].length; w++) {
        var x = want[catName][w];
        if (wanted.indexOf(x.tag) < 0) wanted.push(x.tag);
        why.push(x.kind + " " + x.pattern);
        if (x.mode === "authoritative") { authoritative = true; byAuthority.push(x.tag); }
      }
      var have = [];
      for (var hv = 0; hv < current.length; hv++) if (current[hv].category === catName) have.push(current[hv]);
      var haveNames = [];
      for (var hn = 0; hn < have.length; hn++) haveNames.push(have[hn].name);
      var base = { vcenter: host, object_type: "VirtualMachine", object_id: vm.id, object_name: vm.name, category: catName, cardinality: category.cardinality, rule: why.join("; ") };
      if (category.cardinality === "SINGLE") {
        if (wanted.length > 1) { conflict(host, vm.name, catName, haveNames.join(" "), wanted.join(" "), "rules disagree: " + why.join("; ")); continue; }
        if (haveNames.indexOf(wanted[0]) >= 0) continue;
        if (have.length > 0 && !authoritative) { conflict(host, vm.name, catName, haveNames[0], wanted[0], "fill-only rule (" + why.join("; ") + ") disagrees with the value already set; left alone"); continue; }
        planned(base, have.length > 0 ? "replace" : "attach", have.length > 0 ? have[0] : null, tagByPair[catName + "=" + wanted[0]]);
      } else {
        // Several values: fill-only acts only when the VM has none in the category;
        // once it has one, only an authoritative rule adds.
        var missing = [];
        for (var mi = 0; mi < wanted.length; mi++) if (haveNames.indexOf(wanted[mi]) < 0) missing.push(wanted[mi]);
        if (!missing.length) continue;
        if (have.length > 0) {
          var fillOnly = [];
          var kept = [];
          for (var ms = 0; ms < missing.length; ms++) (byAuthority.indexOf(missing[ms]) >= 0 ? kept : fillOnly).push(missing[ms]);
          if (fillOnly.length) conflict(host, vm.name, catName, haveNames.join(" "), fillOnly.join(" "), "fill-only rule (" + why.join("; ") + "): " + catName + " already has a value, so nothing is added");
          missing = kept;
        }
        for (var ad = 0; ad < missing.length; ad++) planned(base, "attach", null, tagByPair[catName + "=" + missing[ad]]);
      }
    }
  }
}
try {
  if (undoLogCsv) {
    var undone = mod.undoChangeLog(ctx, settings, session, String(undoLogCsv));
    System.log(ctx.dryRun ? "DRY RUN: " + undone + " VM(s) would be put back." : undone + " VM(s) put back.");
  } else {
    var vcenters = settings.vcenters || [];
    if (!vcenters.length) throw new Error("No vCenters: set vcenters in " + SETTINGS_NAME + ".");
    for (var n = 0; n < vcenters.length; n++) planVcenter(String(vcenters[n]));
    var vmSet = {};
    var vmCount = 0;
    for (var k = 0; k < changes.length; k++) {
      var e = changes[k];
      System.log("PLAN: " + [e.action, e.vcenter, e.object_name + " (" + e.object_id + ")", e.category, (e.before || "-") + " -> " + e.after, e.rule].join(" | "));
      if (!vmSet[e.vcenter + "|" + e.object_id]) { vmSet[e.vcenter + "|" + e.object_id] = true; vmCount++; }
    }
    System.log(changes.length + " change(s) on " + vmCount + " VM(s); " + conflicts.length + " conflict(s).");
    var maxVms = Number(settings.maxVms || 0);
    if (vmCount > maxVms) throw new Error("Refusing: " + vmCount + " VMs would change, more than maxVms (" + maxVms + "). A rule is probably wider than meant; read the plan. Nothing was changed.");
    applyPlan(changes);
  }
} finally {
  for (var vc in session.headers) core.logoutVcenter(vc, session.headers[vc]);
  var planOut = [];
  for (var q = 0; q < changes.length; q++) planOut.push([changes[q].vcenter, changes[q].object_type, changes[q].object_id, changes[q].object_name, changes[q].category, changes[q].before, changes[q].after, changes[q].action, changes[q].rule]);
  planCsv = mod.toCsv(["vcenter", "object_type", "object_id", "object_name", "category", "before", "after", "action", "rule"], planOut);
  conflictsCsv = mod.toCsv(["vcenter", "vm", "category", "current", "wanted", "reason"], conflicts);
  changeLogCsv = mod.toCsv(CHANGE_LOG_HEADER, logRows());
}
summary = core.audit(ctx, { mode: undoLogCsv ? "undo" : "rules", planned: changes.length, conflicts: conflicts.length });
core.notify(settings.webhook, summary);`.replace('CHANGE_LOG_HEADER', JSON.stringify(CHANGE_LOG_HEADER));

/**
 * Fleet tag management (VCF Operations 9.1.1 API): import from vCenter, push to
 * vCenter, export — each pull and push wrapped in an export before and after
 * and a diff. Disengage has no API in 9.1.1, so the workflow exports and says
 * the interface steps; a second run with action export records the after.
 */
const SYNC_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
var SAFE = { redact: settings._secrets };
var ACTION = String(action || settings.action || "export");
if (["pull", "push", "export", "disengage"].indexOf(ACTION) < 0) throw new Error("action is pull, push, export or disengage, not " + ACTION + ".");
if (!settings.opsHost || !settings.vcfIdbHost || !settings.vcfApiToken) throw new Error("Set opsHost, vcfIdbHost and vcfApiToken in " + SETTINGS_NAME + ".");
var TM = "https://" + settings.opsHost + "/suite-api/api/fleet-management/tag-management";
var auth = core.loginVcfFleet(settings.vcfIdbHost, settings.vcfApiToken);
var adapters = settings.adapters || [];
var names = settings.categories || [];
var polls = settings.taskPolls || 0;
beforeJson = "";
afterJson = "";
diff = "";
function count(doc) { return doc.categories.length + " categories, " + doc.tags.length + " tags, " + doc.assignments.length + " tagged objects"; }
function diffOf(a, b) {
  function names(list, f) { var out = []; for (var i = 0; i < list.length; i++) out.push(f(list[i])); return out; }
  function minus(x, y) { var out = []; for (var i = 0; i < x.length; i++) if (y.indexOf(x[i]) < 0) out.push(x[i]); return out; }
  var ca = names(a.categories, function (c) { return c.name; }), cb = names(b.categories, function (c) { return c.name; });
  var ta = names(a.tags, function (t) { return t.categoryName + "/" + t.name; }), tb = names(b.tags, function (t) { return t.categoryName + "/" + t.name; });
  var xa = {}, xb = {}, keys = {};
  for (var i = 0; i < a.assignments.length; i++) { xa[a.assignments[i].resourceId] = a.assignments[i].tags.join(","); keys[a.assignments[i].resourceId] = true; }
  for (var j = 0; j < b.assignments.length; j++) { xb[b.assignments[j].resourceId] = b.assignments[j].tags.join(","); keys[b.assignments[j].resourceId] = true; }
  var changed = 0;
  for (var k in keys) if (xa[k] !== xb[k]) changed++;
  return ["categories added:   " + minus(cb, ca).join(", "), "categories removed: " + minus(ca, cb).join(", "), "tags added:         " + minus(tb, ta).length, "tags removed:       " + minus(ta, tb).length, "objects whose tags changed: " + changed].join("\n");
}
if (ACTION === "export") {
  var doc = mod.fleetExport(TM, auth);
  afterJson = JSON.stringify(doc, null, 2);
  System.log("Export: " + count(doc));
} else if (ACTION === "disengage") {
  // There is no disengage call in the 9.1.1 Tag Management API: record the state,
  // and say the steps. Run the workflow again with action export afterwards.
  var before = mod.fleetExport(TM, auth);
  beforeJson = JSON.stringify(before, null, 2);
  System.log("Before: " + count(before));
  System.log("In VCF Operations, for each category in " + names.join(", ") + ": Manage > Fleet Management > Tags > Tag Definitions > the double arrow next to the category > Available In > tick " + settings.vcenter + " > Remove > tick the acknowledgment > Remove. Then run this workflow with action export, and compare with beforeJson.");
} else {
  if (!adapters.length) throw new Error("Set adapters in " + SETTINGS_NAME + " to the vCenter adapter ids.");
  var ids = [];
  if (ACTION === "push") {
    // Every name must resolve to exactly one category, or nothing is pushed.
    var missing = [];
    for (var n = 0; n < names.length; n++) {
      var found = mod.fleetCategories(TM, auth, [names[n]]);
      var id = null;
      for (var f = 0; f < found.length; f++) if (found[f].name === String(names[n])) id = String(found[f].id);
      if (id) ids.push(id); else missing.push(String(names[n]));
    }
    if (missing.length || !ids.length) throw new Error("Refusing to push: " + (missing.length ? missing.join(", ") + " is not a category in fleet tag management" : "no categories named") + ". Nothing was pushed.");
  }
  var beforeDoc = null;
  if (!ctx.dryRun) {
    // The before export is the only record of what central management held: if it fails, nothing happens.
    beforeDoc = mod.fleetExport(TM, auth);
    beforeJson = JSON.stringify(beforeDoc, null, 2);
    System.log("Before: " + count(beforeDoc));
  }
  try {
    for (var a = 0; a < adapters.length; a++) {
      var adapter = String(adapters[a]);
      if (ACTION === "pull") {
        core.act(ctx, "import (pull) the categories and tags of vCenter adapter " + adapter, function () {
          var r = core.http("POST", TM + "/adapters/" + encodeURIComponent(adapter) + "/categories/pull", auth, null, SAFE);
          return mod.waitTask(TM, auth, r.body && r.body.taskId, polls);
        });
      } else {
        for (var b = 0; b < ids.length; b += 20) {
          var batch = ids.slice(b, b + 20);
          var overwrite = settings.overwrite === true || String(settings.overwrite) === "true";
          core.act(ctx, "push " + batch.length + " categories (" + names.slice(b, b + 20).join(", ") + ") to vCenter adapter " + adapter + ", overwrite " + overwrite, function () {
            var r = core.http("POST", TM + "/adapters/" + encodeURIComponent(adapter) + "/categories/push", auth, { categoryIds: batch, overwrite: overwrite }, SAFE);
            return mod.waitTask(TM, auth, r.body && r.body.taskId, polls);
          });
        }
      }
    }
  } finally {
    if (beforeDoc) {
      try {
        var afterDoc = mod.fleetExport(TM, auth);
        afterJson = JSON.stringify(afterDoc, null, 2);
        diff = diffOf(beforeDoc, afterDoc);
        System.log("After: " + count(afterDoc) + "\n" + diff);
      } catch (e) {
        System.warn("The after export failed: " + e);
      }
    }
  }
}
summary = core.audit(ctx, { action: ACTION, adapters: adapters, categories: ACTION === "push" || ACTION === "disengage" ? names : [], diff: diff });
core.notify(settings.webhook, summary);`;

/**
 * Backup and restore, as tag-backup.sh and tag-restore.sh do it. Backup reads
 * each vCenter into the archtoolkit-tag-backup/1 document (the same format the
 * scripts write and read, so either restores the other's backup). Restore
 * recreates missing categories and tags by name and re-attaches by object type
 * and name; it never deletes, never detaches, and never changes the value of a
 * one-value category that already has one.
 */
const BACKUP_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
var SAFE = { redact: settings._secrets };
var MODE = String(mode || "backup");
var session = { headers: {}, catalogues: {} };
var failed = [];
var counts = {};
backupJson = "";
restoreLog = "";
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function backupOf(host) {
  var h = mod.openVcenter(settings, session, host);
  var C = session.catalogues[host];
  var assoc = mod.readAssociations(host, h, C.tags);
  var inv = mod.readInventory(host, h);
  var nameOf = {};
  for (var i = 0; i < inv.length; i++) nameOf[inv[i].type + "/" + inv[i].id] = inv[i].name;
  var tagById = {};
  for (var t = 0; t < C.tags.length; t++) tagById[C.tags[t].id] = C.tags[t];
  var categories = [];
  for (var c = 0; c < C.categories.length; c++) categories.push({ id: C.categories[c].id, name: C.categories[c].name, description: C.categories[c].description, cardinality: C.categories[c].cardinality, associable_types: C.categories[c].associable_types });
  var tags = [];
  for (var t2 = 0; t2 < C.tags.length; t2++) tags.push({ id: C.tags[t2].id, name: C.tags[t2].name, description: C.tags[t2].description, category: C.tags[t2].category });
  var assignments = [];
  for (var a = 0; a < assoc.length; a++) {
    var tag = tagById[assoc[a].tag_id] || { category: "?", name: "?" };
    var name = nameOf[assoc[a].type + "/" + assoc[a].id];
    assignments.push({ category: tag.category, tag: tag.name, object_type: assoc[a].type, object_id: assoc[a].id, object_name: name === undefined ? null : name });
  }
  assignments.sort(function (x, y) { return cmp(x.category, y.category) || cmp(x.tag, y.tag) || cmp(x.object_type, y.object_type) || cmp(String(x.object_name), String(y.object_name)) || cmp(x.object_id, y.object_id); });
  return { vcenter: host, format: "archtoolkit-tag-backup/1", categories: categories, tags: tags, assignments: assignments };
}
function restore(doc, host, catalogueOnly) {
  var h = mod.openVcenter(settings, session, host);
  var C = session.catalogues[host];
  System.log("Restoring the " + doc.vcenter + " backup into " + host);
  // 1. Categories, by exact name.
  for (var c = 0; c < doc.categories.length; c++) {
    var cat = doc.categories[c];
    var existing = null;
    for (var e = 0; e < C.categories.length; e++) if (C.categories[e].name === cat.name) existing = C.categories[e];
    if (existing) {
      if (existing.cardinality !== cat.cardinality) System.warn("DRIFT: category " + cat.name + ": cardinality differs from the backup. Left as it is.");
      continue;
    }
    core.act(ctx, "create category " + cat.name + " on " + host, function () {
      var r = core.http("POST", "https://" + host + "/api/cis/tagging/category", h, { name: cat.name, description: cat.description, cardinality: cat.cardinality, associable_types: cat.associable_types || [] }, SAFE);
      if (typeof r.body !== "string" || !r.body) throw new Error("POST /api/cis/tagging/category returned no id.");
      return r.body;
    });
  }
  if (!ctx.dryRun) C = session.catalogues[host] = mod.readCatalogue(host, h);
  // 2. Tags, by exact name within the category.
  for (var t = 0; t < doc.tags.length; t++) {
    var tg = doc.tags[t];
    var have = false;
    for (var x = 0; x < C.tags.length; x++) if (C.tags[x].category === tg.category && C.tags[x].name === tg.name) have = true;
    if (have) continue;
    var cid = null;
    for (var y = 0; y < C.categories.length; y++) if (C.categories[y].name === tg.category) cid = C.categories[y].id;
    core.act(ctx, "create tag " + tg.category + "=" + tg.name + " on " + host, function () {
      if (!cid) throw new Error("There is no category " + tg.category + " to create the tag in.");
      var r = core.http("POST", "https://" + host + "/api/cis/tagging/tag", h, { name: tg.name, description: tg.description, category_id: cid }, SAFE);
      if (typeof r.body !== "string" || !r.body) throw new Error("POST /api/cis/tagging/tag returned no id.");
      return r.body;
    });
  }
  if (!ctx.dryRun) C = session.catalogues[host] = mod.readCatalogue(host, h);
  if (catalogueOnly) { System.log("Catalogue done; assignments skipped (catalogueOnly)."); return; }
  // 3. Assignments, by object type and name: MoRefs change when a vCenter is rebuilt, names usually do not.
  var inv = mod.readInventory(host, h);
  var assoc = mod.readAssociations(host, h, C.tags);
  var tagId = {}, tagById = {}, card = {}, nameById = {}, idsByName = {}, has = {};
  for (var i = 0; i < C.tags.length; i++) { tagId[C.tags[i].category + "\u001f" + C.tags[i].name] = C.tags[i].id; tagById[C.tags[i].id] = C.tags[i]; }
  for (var k = 0; k < doc.categories.length; k++) card[doc.categories[k].name] = doc.categories[k].cardinality;
  for (var n = 0; n < inv.length; n++) {
    nameById[inv[n].type + "/" + inv[n].id] = inv[n].name;
    (idsByName[inv[n].type + "/" + inv[n].name] = idsByName[inv[n].type + "/" + inv[n].name] || []).push(inv[n].id);
  }
  for (var s = 0; s < assoc.length; s++) (has[assoc[s].type + "/" + assoc[s].id] = has[assoc[s].type + "/" + assoc[s].id] || []).push(assoc[s].tag_id);
  var rows = [];
  var attach = {};
  var attachCount = 0;
  for (var z = 0; z < doc.assignments.length; z++) {
    var w = doc.assignments[z];
    var ids = w.object_name !== null && nameById[w.object_type + "/" + w.object_id] === w.object_name ? [w.object_id] : idsByName[w.object_type + "/" + (w.object_name || "")] || [];
    var tid = tagId[w.category + "\u001f" + w.tag] || null;
    var cur = has[w.object_type + "/" + (ids[0] || "")] || [];
    var inCat = [];
    for (var q = 0; q < cur.length; q++) if (tagById[cur[q]] && tagById[cur[q]].category === w.category) inCat.push(tagById[cur[q]].name);
    var what = ids.length === 0 ? "missing-object" : ids.length > 1 ? "ambiguous-object" : !tid ? "tag-not-created-yet" : cur.indexOf(tid) >= 0 ? "present" : card[w.category] === "SINGLE" && inCat.length > 0 ? "conflict" : "attach";
    counts[what] = (counts[what] || 0) + 1;
    rows.push([what, w.category, w.tag, tid || "", w.object_type, ids[0] || "", w.object_name || w.object_id, inCat.join(" ")].join("\t"));
    if (what === "attach") { (attach[tid] = attach[tid] || { label: w.category + "=" + w.tag, objects: [] }).objects.push({ type: w.object_type, id: ids[0] }); attachCount++; }
  }
  restoreLog = rows.join("\n") + (rows.length ? "\n" : "");
  for (var what2 in counts) System.log("  " + counts[what2] + "\t" + what2);
  var maxAttach = Number(settings.maxAttach || 0);
  if (attachCount > maxAttach) throw new Error("Refusing: " + attachCount + " attachments is more than maxAttach (" + maxAttach + "). Read the restoreLog output, then raise it deliberately. Nothing was attached.");
  for (var id in attach) {
    for (var b = 0; b < attach[id].objects.length; b += 100) {
      var batch = attach[id].objects.slice(b, b + 100);
      core.act(ctx, "attach " + attach[id].label + " to " + batch.length + " object(s) on " + host, function () {
        var r = core.http("POST", "https://" + host + "/api/cis/tagging/tag-association/" + encodeURIComponent(id) + "?action=attach-tag-to-multiple-objects", h, { object_ids: batch }, SAFE);
        var result = r.body || {};
        if (result.success === false) {
          var messages = [];
          var errs = result.error_messages || [];
          for (var m = 0; m < errs.length; m++) messages.push(errs[m].default_message || String(errs[m]));
          throw new Error("vCenter refused part of the batch: " + messages.join("; "));
        }
        return batch.length;
      });
    }
  }
}
try {
  if (MODE === "backup") {
    var docs = [];
    var vcenters = settings.vcenters || [];
    for (var v = 0; v < vcenters.length; v++) {
      var host = String(vcenters[v]);
      try {
        var doc = backupOf(host);
        // An empty catalogue is a failed read, not a vCenter with no tags: it must
        // not become the newest backup and make the history look like a wipe.
        if (!doc.categories.length) { failed.push(host + ": no categories read; not taken as a backup"); continue; }
        docs.push(doc);
        System.log(host + ": " + doc.categories.length + " categories, " + doc.tags.length + " tags, " + doc.assignments.length + " assignments");
        if (settings.backupWebhook) core.notify(settings.backupWebhook, doc);
      } catch (e) {
        failed.push(host + ": " + (e && e.message ? e.message : e));
        System.error(host + ": FAILED: " + (e && e.message ? e.message : e));
      }
    }
    backupJson = JSON.stringify(docs, null, 2);
  } else if (MODE === "restore") {
    if (!backup) throw new Error("Give the backup to restore in the backup input (a backupJson output, or a <vcenter>.json from tag-backup.sh).");
    var parsed = JSON.parse(String(backup));
    var list = Object.prototype.toString.call(parsed) === "[object Array]" ? parsed : [parsed];
    var chosen = null;
    for (var l = 0; l < list.length; l++) if (!chosen || (targetVcenter && list[l].vcenter === String(targetVcenter))) chosen = list[l];
    if (list.length > 1 && !(targetVcenter && chosen.vcenter === String(targetVcenter))) throw new Error("The backup holds " + list.length + " vCenters; name the one to restore in targetVcenter.");
    if (!chosen || chosen.format !== "archtoolkit-tag-backup/1") throw new Error("Not an archtoolkit-tag-backup/1 document.");
    restore(chosen, String(targetVcenter || chosen.vcenter), catalogueOnly === true || String(catalogueOnly) === "true");
  } else if (MODE === "undo-restore") {
    if (!targetVcenter || !restoreLogToUndo) throw new Error("Undo needs targetVcenter and restoreLogToUndo (the restoreLog output of the restore).");
    var target = String(targetVcenter);
    var hh = mod.openVcenter(settings, session, target);
    var lines = String(restoreLogToUndo).split("\n");
    for (var u = 0; u < lines.length; u++) {
      var f = lines[u].split("\t");
      if (f[0] !== "attach" || !f[3] || !f[5]) continue;
      core.act(ctx, "detach " + f[1] + "=" + f[2] + " from " + f[6] + " on " + target, function () {
        return mod.changeTag(target, hh, f[4], f[5], f[3], null, "MULTIPLE", f[6] + ": " + f[1] + "=" + f[2]);
      });
    }
  } else throw new Error("mode is backup, restore or undo-restore, not " + MODE + ".");
} finally {
  for (var vc in session.headers) core.logoutVcenter(vc, session.headers[vc]);
}
summary = core.audit(MODE === "backup" ? null : ctx, { mode: MODE, failed: failed, counts: counts });
core.notify(settings.webhook, summary);
if (failed.length) throw new Error(failed.length + " vCenter(s) were not backed up: " + failed.join("; ") + ". The others were.");`;

/**
 * Cleanup, as tag-cleanup.sh does it: export everything first (in the backup
 * format, so the restore can put anything back by name), plan, refuse above
 * the cap, and delete only with a change ticket — each tag re-checked for
 * attachments, and each category for tags, at the moment of deleting.
 */
const CLEANUP_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
var SAFE = { redact: settings._secrets };
var session = { headers: {}, catalogues: {} };
var TICKET = String(changeTicket || "");
if (!ctx.dryRun && !TICKET) throw new Error("Deleting tags cannot be undone: give the approved change in the changeTicket input. Nothing was deleted.");
var S = JSON.parse(core.resource(RESOURCE_PATH, "tag-standard.json")).categories || [];
var PROTECT = settings.protectCategories || [];
var EMPTY = settings.emptyCategories !== false && String(settings.emptyCategories) !== "false";
var standard = {};
for (var i = 0; i < S.length; i++) standard[S[i].name] = S[i].values || [];
function isStandard(c, t) { return !!standard[c] && standard[c].indexOf(t) >= 0; }
function key(s) { return String(s).toLowerCase().replace(/\s+/g, " ").replace(/^ | $/g, ""); }
var plan = [];
var deletes = [];
var log = [];
var exports = [];
function planVcenter(host) {
  var h = mod.openVcenter(settings, session, host);
  var C = session.catalogues[host];
  var assoc = mod.readAssociations(host, h, C.tags);
  var byId = {};
  for (var t = 0; t < C.tags.length; t++) byId[C.tags[t].id] = C.tags[t];
  // The full catalogue and every assignment, before anything is planned, in the
  // format the backup's restore reads.
  var doc = { vcenter: host, format: "archtoolkit-tag-backup/1", categories: [], tags: [], assignments: [] };
  for (var c = 0; c < C.categories.length; c++) doc.categories.push({ id: C.categories[c].id, name: C.categories[c].name, description: C.categories[c].description, cardinality: C.categories[c].cardinality, associable_types: C.categories[c].associable_types });
  for (var t2 = 0; t2 < C.tags.length; t2++) doc.tags.push({ id: C.tags[t2].id, name: C.tags[t2].name, description: C.tags[t2].description, category: C.tags[t2].category });
  var uses = {};
  for (var a = 0; a < assoc.length; a++) {
    uses[assoc[a].tag_id] = (uses[assoc[a].tag_id] || 0) + 1;
    var tg = byId[assoc[a].tag_id] || { category: "?", name: "?" };
    doc.assignments.push({ category: tg.category, tag: tg.name, object_type: assoc[a].type, object_id: assoc[a].id, object_name: null });
  }
  exports.push(doc);
  var count = {};
  for (var t3 = 0; t3 < C.tags.length; t3++) count[C.tags[t3].category_id] = (count[C.tags[t3].category_id] || 0) + 1;
  var rows = [];
  for (var t4 = 0; t4 < C.tags.length; t4++) {
    var x = C.tags[t4];
    if (uses[x.id]) continue;
    if (PROTECT.indexOf(x.category) >= 0) rows.push([host, "tag", x.category, x.name, x.id, "keep", "category is protected"]);
    else if (isStandard(x.category, x.name)) rows.push([host, "tag", x.category, x.name, x.id, "keep", "in the standard, just not used yet"]);
    else rows.push([host, "tag", x.category, x.name, x.id, "delete", "attached to nothing"]);
  }
  for (var c2 = 0; c2 < C.categories.length; c2++) {
    var y = C.categories[c2];
    if (count[y.id]) continue;
    if (!EMPTY) rows.push([host, "category", y.name, "", y.id, "keep", "empty categories not included"]);
    else if (PROTECT.indexOf(y.name) >= 0 || standard[y.name]) rows.push([host, "category", y.name, "", y.id, "keep", "empty, but protected or in the standard"]);
    else rows.push([host, "category", y.name, "", y.id, "delete", "no tags"]);
  }
  // Near-duplicates within a category: the one on the most objects is the keeper.
  var groups = {};
  for (var t5 = 0; t5 < C.tags.length; t5++) (groups[C.tags[t5].category_id + "|" + key(C.tags[t5].name)] = groups[C.tags[t5].category_id + "|" + key(C.tags[t5].name)] || []).push(C.tags[t5]);
  for (var gk in groups) {
    var g = groups[gk];
    if (g.length < 2) continue;
    var keep = g[0];
    for (var k = 1; k < g.length; k++) if ((uses[g[k].id] || 0) > (uses[keep.id] || 0)) keep = g[k];
    for (var d = 0; d < g.length; d++) {
      if (g[d].id === keep.id) continue;
      var unused = !uses[g[d].id] && !isStandard(g[d].category, g[d].name) && PROTECT.indexOf(g[d].category) < 0;
      rows.push([host, "tag", g[d].category, g[d].name, g[d].id, unused ? "delete" : "report", "duplicate of \"" + keep.name + "\" (" + (uses[keep.id] || 0) + " objects); this one on " + (uses[g[d].id] || 0)]);
    }
  }
  var cgroups = {};
  for (var c3 = 0; c3 < C.categories.length; c3++) (cgroups[key(C.categories[c3].name)] = cgroups[key(C.categories[c3].name)] || []).push(C.categories[c3].name);
  for (var ck in cgroups) if (cgroups[ck].length > 1) rows.push([host, "category", cgroups[ck].join(" / "), "", "", "report", "categories differing only by case or spacing"]);
  var seen = {};
  for (var r = 0; r < rows.length; r++) {
    var u = JSON.stringify(rows[r].slice(1, 6));
    if (seen[u]) continue;
    seen[u] = true;
    plan.push(rows[r]);
    // A tag planned twice (unused and a duplicate) is deleted once.
    var dk = rows[r].slice(0, 5).join("|");
    if (rows[r][5] === "delete" && !seen["d:" + dk]) { seen["d:" + dk] = true; deletes.push(rows[r]); }
  }
}
function deleteOne(row) {
  var host = row[0], kind = row[1], id = row[4];
  var h = session.headers[host];
  var label = kind + " " + row[2] + (row[3] ? "/" + row[3] : "") + " on " + host;
  var n;
  if (kind === "tag") {
    // Checked again at the moment of deleting: the plan can be minutes old.
    var attached = core.http("POST", "https://" + host + "/api/cis/tagging/tag-association?action=list-attached-objects-on-tags", h, { tag_ids: [id] }, SAFE).body || [];
    n = 0;
    for (var a = 0; a < attached.length; a++) n += (attached[a].object_ids || []).length;
    if (n > 0) { log.push([host, kind, row[2], row[3], id, "refused: attached to " + n + " object(s) now", TICKET]); System.warn("Refused: " + label + " is attached to " + n + " object(s) now."); return; }
  } else {
    n = (core.http("POST", "https://" + host + "/api/cis/tagging/tag?action=list-tags-for-category", h, { category_id: id }, SAFE).body || []).length;
    if (n > 0) { log.push([host, kind, row[2], row[3], id, "refused: has " + n + " tag(s) now", TICKET]); System.warn("Refused: " + label + " has " + n + " tag(s) now."); return; }
  }
  var entry = [host, kind, row[2], row[3], id, ctx.dryRun ? "planned" : "failed", TICKET];
  log.push(entry);
  core.act(ctx, "delete " + label + (TICKET ? " (" + TICKET + ")" : ""), function () {
    core.http("DELETE", "https://" + host + "/api/cis/tagging/" + kind + "/" + encodeURIComponent(id), h, null, SAFE);
    entry[5] = "deleted";
    return id;
  });
}
try {
  var vcenters = settings.vcenters || [];
  if (!vcenters.length) throw new Error("No vCenters: set vcenters in " + SETTINGS_NAME + ".");
  for (var v = 0; v < vcenters.length; v++) planVcenter(String(vcenters[v]));
  for (var p = 0; p < plan.length; p++) System.log("PLAN: " + plan[p].join(" | "));
  System.log(deletes.length + " deletion(s) planned; the rest are kept or only reported.");
  if (!ctx.dryRun && deletes.length > ctx.cap) throw new Error("Refusing: " + deletes.length + " deletions is more than the cap of " + ctx.cap + ". Delete in smaller batches. Nothing was deleted.");
  // Tags first, then categories: a category is only deleted once it is empty.
  for (var q = 0; q < deletes.length; q++) if (deletes[q][1] === "tag") deleteOne(deletes[q]);
  for (var q2 = 0; q2 < deletes.length; q2++) if (deletes[q2][1] === "category") deleteOne(deletes[q2]);
} finally {
  for (var vc in session.headers) core.logoutVcenter(vc, session.headers[vc]);
  exportsJson = JSON.stringify(exports, null, 2);
  planCsv = mod.toCsv(["vcenter", "kind", "category", "name", "id", "action", "reason"], plan);
  cleanupLogCsv = mod.toCsv(["vcenter", "kind", "category", "name", "id", "result", "ticket"], log);
}
summary = core.audit(ctx, { ticket: TICKET, planned: deletes.length });
core.notify(settings.webhook, summary);`;

/**
 * The consumers: VCF Operations custom groups (created when no group of that
 * name exists), NSX groups (created or updated only when absent or carrying
 * managed-by|archtoolkit, and left alone when already as generated), and the
 * sync that copies the vCenter tag onto the NSX tag of the same VM — only its
 * scope, every other NSX tag kept. Mirrors vcfops-apply-groups.sh,
 * nsx-apply-groups.sh and nsx-tag-sync.sh.
 */
function consumeWorkflow(groupFiles: readonly string[], nsxGroups: readonly { id: string; file: string }[]): string {
  return String.raw`var GROUP_FILES = ${JSON.stringify(groupFiles)};
var NSX_GROUPS = ${JSON.stringify(nsxGroups)};
var ctx = core.begin(settings, dryRun);
var SAFE = { redact: settings._secrets };
var session = { headers: {}, catalogues: {} };
var opsAuth = null;
var problems = [];
var syncPlan = [];
function on(value) { return value === true || String(value) === "true"; }
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function vcfOpsGroups() {
  if (!settings.opsHost || !settings.opsUsername || !settings.opsPassword) throw new Error("Set opsHost, opsUsername and opsPassword in " + SETTINGS_NAME + ", or set applyVcfOpsGroups to false.");
  opsAuth = core.loginVcfOps(settings.opsHost, settings.opsUsername, settings.opsPassword, settings.opsAuthSource || "");
  var api = "https://" + settings.opsHost + "/suite-api/api/resources/groups";
  var existing = core.pageAll(function (page) {
    var r = core.http("GET", api + "?page=" + page + "&pageSize=1000", opsAuth, null, SAFE).body || {};
    return { items: r.groups || [], total: r.pageInfo ? r.pageInfo.totalCount : null };
  }, 0);
  var names = {};
  for (var i = 0; i < existing.length; i++) if (existing[i].resourceKey) names[existing[i].resourceKey.name] = existing[i].id;
  for (var g = 0; g < GROUP_FILES.length; g++) {
    var body = JSON.parse(core.resource(RESOURCE_PATH, GROUP_FILES[g]));
    var name = body.resourceKey.name;
    if (names[name]) { System.log("Exists, left as it is: custom group " + name + " (" + names[name] + ")"); continue; }
    core.act(ctx, "create VCF Operations custom group " + name, function () {
      var r = core.http("POST", api, opsAuth, body, SAFE);
      if (!r.body || !r.body.id) throw new Error("POST /suite-api/api/resources/groups returned no id.");
      return String(r.body.id);
    });
  }
}
function nsxGroups(nsx) {
  var base = "https://" + settings.nsxHost + "/policy/api/v1/infra/domains/default/groups/";
  for (var i = 0; i < NSX_GROUPS.length; i++) {
    var id = NSX_GROUPS[i].id;
    var body = JSON.parse(core.resource(RESOURCE_PATH, NSX_GROUPS[i].file));
    // Only a 404 means absent. Anything else but 200 — 401, 403, a 5xx — means we
    // cannot tell who owns it, so core.http throws and the run stops.
    var r = core.http("GET", base + encodeURIComponent(id), nsx, null, { allow: [404], redact: settings._secrets });
    if (r.statusCode === 200) {
      var tags = r.body.tags || [];
      var ours = false;
      for (var t = 0; t < tags.length; t++) if (tags[t].scope === "managed-by" && tags[t].tag === "archtoolkit") ours = true;
      if (!ours) { problems.push("NSX group " + id + " exists and was not created by this kit; refused. Rename ours or adopt it by hand."); System.warn("REFUSED: NSX group " + id + " exists without managed-by|archtoolkit."); continue; }
      if (r.body.display_name === body.display_name && sameJson(r.body.expression, body.expression)) { System.log("As generated already: NSX group " + id); continue; }
    }
    core.act(ctx, (r.statusCode === 200 ? "update" : "create") + " NSX group " + id, function () {
      core.http("PATCH", base + encodeURIComponent(id), nsx, body, SAFE);
      return id;
    });
  }
}
function nsxSync(nsx) {
  var CAT = String(settings.syncCategory);
  var VMS = "https://" + settings.nsxHost + "/policy/api/v1/infra/realized-state/enforcement-points/default/virtual-machines";
  // What vCenter says: instance UUID -> the values of the category.
  var want = [];
  var wantSet = {};
  var vcenters = settings.vcenters || [];
  for (var v = 0; v < vcenters.length; v++) {
    var host = String(vcenters[v]);
    var h = mod.openVcenter(settings, session, host);
    var C = session.catalogues[host];
    var tags = [];
    var nameOf = {};
    for (var t = 0; t < C.tags.length; t++) if (C.tags[t].category === CAT) { tags.push(C.tags[t]); nameOf[C.tags[t].id] = C.tags[t].name; }
    var assoc = tags.length ? mod.readAssociations(host, h, tags) : [];
    var byVm = {};
    var order = [];
    for (var a = 0; a < assoc.length; a++) {
      if (assoc[a].type !== "VirtualMachine") continue;
      if (!byVm[assoc[a].id]) { byVm[assoc[a].id] = []; order.push(assoc[a].id); }
      byVm[assoc[a].id].push(nameOf[assoc[a].tag_id]);
    }
    for (var o = 0; o < order.length; o++) {
      var info = core.http("GET", "https://" + host + "/api/vcenter/vm/" + encodeURIComponent(order[o]), h, null, SAFE).body || {};
      var uuid = info.identity && info.identity.instance_uuid;
      if (!uuid) { System.warn("No instance UUID for " + order[o] + " on " + host + "; skipped."); continue; }
      want.push({ uuid: String(uuid), values: byVm[order[o]].sort() });
      wantSet[uuid] = true;
    }
  }
  // Every NSX VM with its tags, paged by cursor.
  var nsxVms = {};
  var cursor = "";
  for (var page = 0; page < 10000; page++) {
    var r = core.http("GET", VMS + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), nsx, null, SAFE).body || {};
    var results = r.results || [];
    for (var i = 0; i < results.length; i++) nsxVms[results[i].external_id] = { name: results[i].display_name, tags: results[i].tags || [] };
    cursor = r.cursor || "";
    if (!cursor || !results.length) break;
  }
  function scoped(tags) { var out = []; for (var i = 0; i < tags.length; i++) if (tags[i].scope === CAT) out.push(tags[i].tag); return out.sort(); }
  function others(tags) { var out = []; for (var i = 0; i < tags.length; i++) if (tags[i].scope !== CAT) out.push(tags[i]); return out; }
  for (var w = 0; w < want.length; w++) {
    var n = nsxVms[want[w].uuid];
    if (!n) continue;
    var have = scoped(n.tags);
    if (have.join(",") === want[w].values.join(",")) continue;
    var set = others(n.tags);
    for (var x = 0; x < want[w].values.length; x++) set.push({ scope: CAT, tag: want[w].values[x] });
    syncPlan.push({ uuid: want[w].uuid, name: n.name, have: have, want: want[w].values, tags: set });
  }
  if (on(settings.prune)) {
    // NSX VMs with the scope that vCenter no longer tags: only those found by name
    // in one of the vCenters, with the same instance UUID, are touched.
    for (var id in nsxVms) {
      if (wantSet[id] || !scoped(nsxVms[id].tags).length) continue;
      for (var p = 0; p < vcenters.length; p++) {
        var ph = String(vcenters[p]);
        var hh = mod.openVcenter(settings, session, ph);
        var found = core.http("GET", "https://" + ph + "/api/vcenter/vm?names=" + encodeURIComponent(nsxVms[id].name), hh, null, SAFE).body || [];
        if (!found.length) continue;
        var detail = core.http("GET", "https://" + ph + "/api/vcenter/vm/" + encodeURIComponent(found[0].vm), hh, null, SAFE).body || {};
        if (!detail.identity || String(detail.identity.instance_uuid) !== id) continue;
        syncPlan.push({ uuid: id, name: nsxVms[id].name, have: scoped(nsxVms[id].tags), want: [], tags: others(nsxVms[id].tags) });
        break;
      }
    }
  }
  for (var s = 0; s < syncPlan.length; s++) System.log("SYNC: " + syncPlan[s].name + ": " + (syncPlan[s].have.join(",") || "(none)") + " -> " + (syncPlan[s].want.join(",") || "(none)"));
  var max = Number(settings.maxVmChanges || 0);
  if (syncPlan.length > max) throw new Error("Refusing: " + syncPlan.length + " VMs would have their NSX tags changed, more than maxVmChanges (" + max + "). Read the SYNC lines; if they are right, raise it for one run. Nothing was changed.");
  // update_tags replaces the whole tag set, so each body carries every other
  // scope unchanged plus the new values for this one.
  for (var u = 0; u < syncPlan.length; u++) {
    var item = syncPlan[u];
    core.act(ctx, "set NSX tags " + CAT + " on " + item.name + ": " + (item.have.join(",") || "(none)") + " -> " + (item.want.join(",") || "(none)"), function () {
      core.http("POST", VMS + "?action=update_tags", nsx, { virtual_machine_id: item.uuid, tags: item.tags }, SAFE);
      return item.uuid;
    });
  }
}
try {
  if (on(settings.applyVcfOpsGroups) && GROUP_FILES.length) vcfOpsGroups();
  if ((on(settings.applyNsxGroups) && NSX_GROUPS.length) || on(settings.nsxSync)) {
    if (!settings.nsxHost || !settings.nsxUsername || !settings.nsxPassword) throw new Error("Set nsxHost, nsxUsername and nsxPassword in " + SETTINGS_NAME + ".");
    var nsx = core.loginNsx(settings.nsxUsername, settings.nsxPassword);
    if (on(settings.applyNsxGroups) && NSX_GROUPS.length) nsxGroups(nsx);
    if (on(settings.nsxSync)) nsxSync(nsx);
  }
} finally {
  for (var vc in session.headers) core.logoutVcenter(vc, session.headers[vc]);
  if (opsAuth) core.logoutVcfOps(settings.opsHost, opsAuth);
  syncPlanJson = JSON.stringify(syncPlan, null, 2);
}
summary = core.audit(ctx, { problems: problems, nsxTagChanges: syncPlan.length });
core.notify(settings.webhook, summary);
if (problems.length) throw new Error(problems.join(" "));`;
}

/** fleetTagActions with the module name filled in where an action calls a sibling. */
function fleetActionsIn(module: string): VroActionDef[] {
  return fleetTagActions().map((a) => ({ ...a, script: a.script.split('MODULE_NAME').join(JSON.stringify(module)) }));
}

export const VCF_TAGS: readonly AutomationBlueprint[] = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'tags_taxonomy',
    platform: PLATFORM,
    label: 'A tag standard, and the script that creates it',
    group: 'Tags — standard',
    description:
      'The categories every vCenter in the fleet carries — Environment, Application, Owner, CostCenter, BackupPolicy and the rest — with the cardinality, object types and allowed values of each, and where each is required. Written as JSON and a readable table, and created on every vCenter (and centrally in VCF Operations fleet tag management) by a script that creates only what is missing.',
    inputs: [
      STANDARD_INPUT,
      VCENTERS_INPUT,
      {
        id: 'route',
        label: 'Create it through',
        control: 'select',
        options: [
          { value: 'both', label: 'vCenter API, then import into VCF Operations fleet tag management' },
          { value: 'vcenter', label: 'vCenter API only (vSphere 8 and 9)' },
          { value: 'fleet', label: 'VCF Operations fleet tag management only (9.1.1+)' },
        ],
        default: 'both',
      },
    ],
    automation: (values: BlueprintValues): Automation => {
      const { categories, findings } = parseStandard(str(values, 'standard', DEFAULT_STANDARD));
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const route = str(values, 'route', 'both');
      const fleet = route !== 'vcenter';
      const vcenter = route !== 'fleet';
      const both = fleet && vcenter;
      if (fleet && !both) {
        const notFleet = [...new Set(categories.flatMap((c) => c.types))].filter((t) => !FLEET_KINDS.includes(t));
        if (notFleet.length > 0) {
          findings.push(
            warning('tags.standard.not-fleet-type', `${notFleet.join(', ')} is not among the object types the 9.1.1 fleet API lists.`, {
              remediation: 'create-fleet.sh checks GET .../categories/associable-types and refuses rather than creating the category without the type. Create those categories through the vCenter API, or check the list on your release.',
              source: SRC,
            }),
          );
        }
      }
      if (vcenters.length === 0) findings.push(error('tags.vcenters.none', 'No vCenters listed.', { source: SRC }));

      // The central component: one Orchestrator package that creates the
      // standard on every vCenter and in fleet tag management, in that order.
      const objects = categories.reduce((n, c) => n + 1 + c.values.length, 0);
      const pkg = toPackage({
        packageName: 'com.archtoolkit.tags.taxonomy',
        description: `Creates the tag standard (${categories.length} categories) ${vcenter ? 'on every vCenter' : ''}${both ? ', then imports it into' : fleet ? 'in' : ''}${fleet ? ' VCF Operations fleet tag management' : ''}: only what is missing, by exact name. Generated by ArchToolKit.`,
        categoryPath: 'ArchToolKit/Tags/Standard',
        workflow: {
          name: 'Create tag standard',
          description: 'Creates every category and tag of the standard that is missing — on each vCenter (vCenter API), then in fleet tag management (import from vCenter, or create centrally and push), per the route setting. Never changes or deletes an existing one; drift and names that differ only by case are reported. A dry run until dryRun is set to false in the configuration element.',
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be created and change nothing' }],
          outputs: [
            { name: 'problemCount', type: 'number', description: 'Problems a person has to settle (drift, other-case names, missing after import)' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: TAXONOMY_WORKFLOW,
        },
        actions: [...vcTagActions('com.archtoolkit.tags.taxonomy', ['vcLogin', 'openVcenter', 'readCatalogue']), ...fleetActionsIn('com.archtoolkit.tags.taxonomy').filter((a) => a.name !== 'fleetExport')],
        config: {
          name: 'Tag standard',
          description: 'Settings of the Create tag standard workflow. Fill the secret for your version after import: vcfApiToken (VCF 9.1; also used for fleet tag management) or vcPassword (8.x and 9.0). dryRun stays true until a dry run has been read.',
          attributes: [
            { name: 'route', type: 'string', value: route, description: 'vcenter (vCenter API only), both (vCenter, then import into fleet tag management) or fleet (create centrally, optionally push)' },
            ...vcAttributes(vcenters, 'the vSphere Tagging privileges Create vSphere Tag Category and Create vSphere Tag on every vCenter, and Tags Manage (tag_management.manage) in VCF Operations for the fleet route'),
            { name: 'opsHost', type: 'string', value: '', description: 'VCF Operations 9.1.1 host, for fleet tag management (routes both and fleet)' },
            { name: 'fleetAdapters', type: 'Array/string', value: [], description: 'Route both: the VCF Operations adapter ids of the vCenters to import from' },
            { name: 'fleetPushAdapters', type: 'Array/string', value: [], description: 'Route fleet: the vCenter adapter ids to push the categories to after creating them; empty to push nothing' },
            { name: 'taskPolls', type: 'number', value: 180, description: 'How many times to poll a fleet task, 10 seconds apart, before giving up' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is created while this is true' },
            { name: 'cap', type: 'number', value: objects * Math.max(1, vcenter ? vcenters.length : 0) + (fleet ? objects + 20 : 0), description: 'The most objects one run may create or tasks it may start' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [{ name: 'tag-standard.json', content: standardJson(categories) }],
      });

      return {
        platform: PLATFORM,
        title: `Tag standard — ${categories.length} categories, ${categories.reduce((n, c) => n + c.values.length, 0)} values`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: both ? 'An engineer runs the workflow Create tag standard (or scripts/create-vcenter.sh, then scripts/create-fleet.sh) after the standard is reviewed: it creates the standard on each vCenter, then imports it into fleet tag management; again whenever a value is added.' : 'An engineer runs the workflow Create tag standard (or the script under scripts/) after the standard is reviewed, and again whenever a value is added to it.' },
        scope: {
          what: `The tag catalogue — categories and tags, not assignments — on ${vcenter ? vcenters.join(', ') : 'no vCenter directly'}${fleet ? ', and in VCF Operations fleet tag management' : ''}.`,
          decidedBy: [
            'The lines in tag-standard.json: one category per line, one tag per allowed value.',
            vcenter ? 'vcenters in the configuration element Tag standard (VCENTERS, or the list baked into scripts/create-vcenter.sh).' : 'fleetPushAdapters (FLEET_PUSH_ADAPTERS with --push for the script): the vCenter adapters the categories are pushed to.',
            ...(both ? ['fleetAdapters (FLEET_ADAPTERS for the script): the vCenters imported from. An import brings in everything in that vCenter’s catalogue, not only the standard.'] : []),
            'What already exists by exact name, which is skipped.',
          ],
          ifWrong: 'A category created with the wrong name or cardinality cannot be renamed or narrowed afterwards, in vCenter or VCF Operations. It has to be deleted, which is only possible once nothing carries its tags.',
        },
        guardrails: [
          { rule: 'Only creates; never updates or deletes an existing category or tag', because: 'An existing category is someone else’s decision, and vCenter cannot undo a widening. Drift is printed for a person to settle.' },
          { rule: 'Matches by exact name and refuses a name that exists in another case', because: 'Creating "environment" next to "Environment" is how an estate ends up half-tagged in each.' },
          ...(both
            ? [
                { rule: 'The fleet script imports (pulls) the categories from vCenter and never creates one centrally; it refuses --push', because: 'A category created in vCenter and another created centrally with the same name have different ids. Fleet management would hold its own copy, and every push with overwrite false fails with a same-name, different-id conflict on every vCenter.' },
                { rule: 'Imports one vCenter at a time, waits for each task, then checks every category and value of the standard is in fleet management by exact name', because: 'The platform refuses a second import while one runs, and a task that SUCCEEDs has not necessarily brought everything the standard needs.' },
              ]
            : []),
          ...(fleet && !both ? [{ rule: 'The fleet script refuses object types fleet tag management does not list', because: 'Otherwise the category is created without that type, and nobody notices until an assignment fails.' }] : []),
          ...(fleet && !both ? [{ rule: 'Pushes at most 20 categories at a time and waits for each push task to finish', because: 'Twenty is the interface’s own limit, and overlapping pushes to one vCenter conflict.' }] : []),
          { rule: 'The standard is reviewed before it runs', because: 'Category names and cardinality are permanent. The findings on this page are the review checklist.' },
        ],
        dryRun: [
          'The workflow Create tag standard is a dry run until dryRun is set to false in its configuration element: the log lists every "DRY RUN: would create …", every PROBLEM (drift, other-case names) and, for an import, what fleet management does not have yet. Its reads are GETs and the fleet query POSTs.',
          ...(vcenter ? ['./scripts/create-vcenter.sh with no flag lists every category and tag it would create on each vCenter, and every drift it found.'] : []),
          ...(fleet ? [both ? './scripts/create-fleet.sh with no flag lists which adapters it would import from and which categories and values fleet management does not have yet. Its queries are reads.' : './scripts/create-fleet.sh with no flag does the same against fleet tag management. Its queries are reads.'] : []),
        ],
        undo: [
          ...(vcenter ? ['The workflow logs every object it created (AUDIT: changed: create …); delete those in vCenter once nothing carries them (DELETE /api/cis/tagging/tag/{id}, then /api/cis/tagging/category/{id}). The script writes every id it created to created-<run>.tsv, and ./scripts/create-vcenter.sh --undo created-<run>.tsv --execute deletes those tags and categories again, skipping any that are now attached to something.'] : []),
          ...(fleet && !both ? ['In fleet tag management, delete the tags then the category (DELETE .../categories/{id}/tags/{tagId}, then .../categories/{id}). You cannot delete a tag assigned to objects. A category already pushed to a vCenter stays there when deleted centrally — delete it in that vCenter too.'] : []),
          ...(both ? ['An import makes fleet management manage the vCenter’s category. To hand it back, disengage the vCenter from the category (Fleet Management > Tags > the category > Available In > Remove, or the tags_sync_control blueprint). Deleting it centrally does not delete it from the vCenter.'] : []),
        ],
        told: [`The workflow's log and its summary output (posted to the webhook if set), or the terminal that ran the script${vcenter ? ', and created-<run>.tsv for the vCenter route' : ''}. Commit tag-standard.json and TAG-STANDARD.md to the repository the change was reviewed in.${fleet ? ' Fleet tasks and any conflicts also show under Manage > Fleet Management > Tags.' : ''}`],
        requires: [
          ...(vcenter ? [...VC_REQUIRES, 'The vCenter account needs Tagging > Create vSphere Tag Category and Create vSphere Tag (and Delete for --undo).'] : []),
          ...(fleet ? ['VCF Operations 9.1.1 or later, an API client whose API token is in vcfApiToken (VCF_API_TOKEN_FILE for the script), and the Tags Manage permission (tag_management.manage) for it.'] : []),
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the vCenter, identity broker and VCF Operations certificates trusted in Orchestrator.',
          ...(both ? ['Import needs each vCenter at 9.0 or later, licensed for VCF 9 and integrated with this VCF Operations (the documented requirements). A vSphere 8 vCenter can only take the vCenter route.'] : []),
        ],
        files: {
          'tag-standard.json': standardJson(categories),
          'TAG-STANDARD.md': standardMarkdown(categories),
          ...pkg.files,
          'scripts/tag-standard.json': standardJson(categories),
          ...(vcenter ? { 'scripts/create-vcenter.sh': createVcenterScript(vcenters) } : {}),
          ...(fleet ? { 'scripts/create-fleet.sh': createFleetScript(vcenter ? 'import' : 'create') } : {}),
          'import/powercli/tag-standard.csv': powercliCsv(categories),
          'import/powercli/Import-TagStandard.ps1': powercliImportScript(vcenters),
          ...vcenterRestFiles(categories),
          'IMPORT.md': taxonomyImport(categories, route, pkg.importSteps),
        },
        notes: [
          'In VCF 9, fleet tag management is where the catalogue should live. There are two consistent ways to get it there, and mixing them is what breaks: create it centrally and push it to vCenters that do not have it (route "fleet only"), or create it in vCenter and import it (route "both", the order this blueprint uses). Creating it in both places gives every category two ids.',
          ...(both ? ['Order for route "both": the workflow does it in one run (vCenter first, then one import per adapter in fleetAdapters, then a check of every category and value by exact name); with the scripts, ./scripts/create-vcenter.sh --execute, then FLEET_ADAPTERS=<ids> ./scripts/create-fleet.sh --execute. POST .../tag-management/adapters/{adapterId}/categories/pull takes no body and answers 202 with a taskId (9.1.1 API reference). VERIFY on your release: how an import reconciles the same category name arriving from a second vCenter — the documentation lists conflicts under View Conflict Details but does not spell out the rule; the script reports a FAILED task and every category still missing afterwards.'] : []),
          'The fleet API field names (associableTypes with adapterKind and resourceKinds, cardinality SINGLE/MULTIPLE, categoryIds and overwrite on push) are from the 9.1.1 API reference. VERIFY: whether POST .../categories accepts a category with no tags yet — the interface refuses one, and the script creates the tags straight after.',
          'Pushing with overwrite false fails on conflicts (same name with different cardinality or fewer object types, or same name with a different id) and shows them under Fleet Management > Tags. Resolve them there; the script does not force them.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'tags_bulk_assign',
    platform: PLATFORM,
    label: 'Assign tags in bulk from a CSV',
    group: 'Tags — assign',
    description:
      'The first big tagging pass, or any batch after it: a CSV of object, category and tag, resolved to MoRefs on each vCenter and attached. It lists every change before making any, caps how many one run may make, refuses to overwrite a one-value category unless told to, and writes the before and after of every object to a CSV that is also the undo.',
    inputs: [
      VCENTERS_INPUT,
      {
        id: 'variant',
        label: 'Script',
        control: 'select',
        options: [
          { value: 'both', label: 'bash (vCenter REST) and PowerShell (PowerCLI)' },
          { value: 'bash', label: 'bash (vCenter REST)' },
          { value: 'powershell', label: 'PowerShell (PowerCLI)' },
        ],
        default: 'both',
      },
      { id: 'max_changes', label: 'Refuse a run that changes more than (objects)', control: 'number', default: 200, min: 1, max: 20000 },
      {
        id: 'sample',
        label: 'Assignments',
        control: 'textarea',
        default: [
          'vcenter,object_type,object,category,tag',
          'vc-wld01.example.com,VirtualMachine,prd-pay-app01,Environment,prod',
          'vc-wld01.example.com,VirtualMachine,prd-pay-app01,Application,payments',
          'vc-wld01.example.com,VirtualMachine,vm-2041,Owner,team-payments',
          'vc-wld01.example.com,Folder,Payments,CostCenter,CC1001',
          'vc-wld01.example.com,ClusterComputeResource,wld01-cl01,Tier,1',
        ].join('\n'),
        hint: 'vcenter,object_type,object (name or MoRef),category,tag — becomes assignments.csv',
      },
    ],
    automation: (values: BlueprintValues): Automation => {
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const variant = str(values, 'variant', 'both');
      const maxChanges = num(values, 'max_changes', 200);
      const sample = str(values, 'sample', '').split('\n').map((l) => l.trim()).filter(Boolean);
      const bash = variant !== 'powershell';
      const ps = variant !== 'bash';

      const findings: Finding[] = [];
      const header = sample[0] ?? '';
      if (header.replace(/\s/g, '').toLowerCase() !== 'vcenter,object_type,object,category,tag') {
        findings.push(error('tags.assign.header', 'The first line must be the header vcenter,object_type,object,category,tag.', { path: 'sample', source: SRC }));
      }
      const rows = sample.slice(1);
      rows.forEach((row, index) => {
        const cells = row.split(',');
        if (cells.length !== 5) findings.push(error('tags.assign.row', `Row ${index + 2} has ${cells.length} fields, not 5.`, { path: 'sample', remediation: 'Names containing commas are not supported in this CSV; use the MoRef instead.', source: SRC }));
        else if (!OBJECT_TYPES.includes(cells[1]!.trim())) findings.push(error('tags.assign.type', `Row ${index + 2}: "${cells[1]}" is not an object type.`, { path: 'sample', source: SRC }));
      });
      if (rows.length > maxChanges) findings.push(warning('tags.assign.over-cap', `The CSV has ${rows.length} rows and the cap is ${maxChanges}; the run will refuse if more than ${maxChanges} of them are changes.`, { remediation: 'Split the CSV, or raise the cap deliberately after reading the dry run.', source: SRC }));
      if (maxChanges > 2000) findings.push(warning('tags.assign.high-cap', `A cap of ${maxChanges} is not much of a cap.`, { remediation: 'The cap is what turns a wrong CSV into a small incident. A few hundred per run is plenty.', source: SRC }));
      const unknownVc = [...new Set(rows.map((r) => r.split(',')[0]!.trim()))].filter((v) => v && !vcenters.includes(v));
      if (unknownVc.length > 0) findings.push(info('tags.assign.other-vcenter', `${unknownVc.join(', ')} appear in the CSV but not in the vCenter list. The scripts log in to whatever the CSV names.`, { source: SRC }));

      const bashScript = [
        '#!/usr/bin/env bash',
        '# Attach tags from a CSV: vcenter,object_type,object,category,tag',
        '# (object is a name or a MoRef such as vm-2041).',
        '#',
        '#   ./tag-assign.sh [assignments.csv]                   dry run: plan-<run>.csv lists every change',
        '#                                                       (default: ../assignments.csv, beside scripts/)',
        '#   ./tag-assign.sh [assignments.csv] --execute         make the changes; change-log-<run>.csv',
        '#   ./tag-assign.sh ... --replace                       allow replacing the value of a one-value category',
        '#   ./tag-assign.sh --undo change-log-<run>.csv [--execute]   put every object back as it was',
        '#',
        `# Refuses a run with more than MAX_CHANGES changes (default ${maxChanges}).`,
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        `MAX_CHANGES="\${MAX_CHANGES:-${maxChanges}}"`,
        'CSV=../assignments.csv; DRY_RUN=1; REPLACE=0; UNDO=""',
        'while (( $# )); do',
        '  case "$1" in',
        '    --execute) DRY_RUN=0 ;;',
        '    --replace) REPLACE=1 ;;',
        '    --undo) UNDO="${2:?--undo needs a change-log CSV}"; shift ;;',
        '    -*) echo "unknown argument: $1" >&2; exit 2 ;;',
        '    *) CSV="$1" ;;',
        '  esac',
        '  shift',
        'done',
        '',
        ...vcLib(),
        '',
        'RUN=$(date -u +%Y%m%dT%H%M%SZ)',
        'ensure() { [[ -n "${SID[$1]:-}" ]] || { vc_login "$1"; load_catalogue "$1" "$WORK/$1.json"; }; }',
        '',
        '# Tag ids on one object, read now, into $WORK/now. read_back ... TAG_ID',
        '# answers 0 when the tag is there, 1 when it is not, 2 when it cannot tell.',
        'read_back() { attached_tags "$1" "$2" "$3" > "$WORK/now" || return 2; grep -qxF "$4" "$WORK/now"; }',
        '',
        '# --- undo ----------------------------------------------------------------',
        '# Works from what is on each object now, not from what the log says happened,',
        '# so it is right for every row whatever its result (pending, ok, failed,',
        '# rolled-back), for a log left by a run that stopped or was killed half way,',
        '# and when run twice. Newest row first.',
        'if [[ -n "$UNDO" ]]; then',
        '  n=0; FAILS=0',
        '  while IFS=, read -r host otype oid oname category before_id before after_id after action result; do',
        '    [[ -z "$oid" || -z "$after_id" ]] && continue',
        '    ensure "$host"',
        '    attached_tags "$host" "$otype" "$oid" > "$WORK/undo-now"',
        '    has_after=0; grep -qxF "$after_id" "$WORK/undo-now" && has_after=1',
        '    need_before=0',
        '    if [[ "$action" == replace && -n "$before_id" ]] && ! grep -qxF "$before_id" "$WORK/undo-now"; then need_before=1; fi',
        '    if (( !has_after && !need_before )); then echo "as before already: $oname $category=${before:-(none)} [$result]"; continue; fi',
        '    n=$((n + 1))',
        '    if (( DRY_RUN )); then',
        '      echo "DRY RUN: $oname ($oid) [$result]:$( (( has_after )) && printf \' detach %s=%s\' "$category" "$after")$( (( need_before )) && printf \' attach %s=%s\' "$category" "$before")"',
        '      continue',
        '    fi',
        '    if (( has_after )) && ! detach_tag "$host" "$after_id" "$otype" "$oid"; then echo "FAILED to detach $category=$after from $oname" >&2; FAILS=$((FAILS + 1)); continue; fi',
        '    if (( need_before )) && ! attach_tag "$host" "$before_id" "$otype" "$oid"; then echo "FAILED to re-attach $category=$before to $oname" >&2; FAILS=$((FAILS + 1)); continue; fi',
        '    echo "undone: $oname $category ${after} -> ${before:-(none)}"',
        '  done < <(awk \'NR > 1 { row[NR] = $0 } END { for (i = NR; i > 1; i--) print row[i] }\' "$UNDO")',
        '  (( DRY_RUN )) && echo "DRY RUN: $n object(s) would be put back. Re-run with --execute."',
        '  (( FAILS == 0 )) || { echo "$FAILS object(s) could not be put back; re-run the undo once the cause is fixed." >&2; exit 1; }',
        '  exit 0',
        'fi',
        '',
        '# --- plan ----------------------------------------------------------------',
        '[[ "$(head -1 "$CSV" | tr -d \'\\r \')" == "vcenter,object_type,object,category,tag" ]] || { echo "$CSV: first line must be vcenter,object_type,object,category,tag" >&2; exit 2; }',
        'PLAN="plan-${RUN}.csv"',
        'echo "vcenter,object_type,object_id,object_name,category,before_id,before,tag_id,tag,action,reason" > "$PLAN"',
        'CHANGES=0; REFUSED=0; CSVLINE=1',
        '# One value per object in a one-value category: which CSV row set it.',
        'declare -A SEEN_TAG=() SEEN_ROW=()',
        'DUPS=()',
        'while IFS= read -r line; do',
        '  CSVLINE=$((CSVLINE + 1))',
        '  line=${line%$\'\\r\'}',
        '  [[ -z "$line" ]] && continue',
        '  IFS=, read -r host otype ref category tag extra <<<"$line"',
        '  row() { printf \'%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\\n\' "$host" "$otype" "${oid:-}" "$ref" "$category" "${before_id:-}" "${before:-}" "${tag_id:-}" "$tag" "$1" "${2:-}" >> "$PLAN"; }',
        '  oid=""; before_id=""; before=""; tag_id=""',
        '  if [[ -n "$extra" || -z "$tag" ]]; then row refused "not five fields"; REFUSED=$((REFUSED + 1)); continue; fi',
        '  ensure "$host"',
        '  cat_json=$(jq -c --arg c "$category" \'[.categories[] | select(.name == $c)] | first // empty\' "$WORK/$host.json")',
        '  if [[ -z "$cat_json" ]]; then row refused "no category $category on $host"; REFUSED=$((REFUSED + 1)); continue; fi',
        '  tag_id=$(jq -r --arg c "$category" --arg t "$tag" \'[.tags[] | select(.category == $c and .name == $t) | .id] | first // empty\' "$WORK/$host.json")',
        '  if [[ -z "$tag_id" ]]; then row refused "no tag $tag in $category (values come from the standard)"; REFUSED=$((REFUSED + 1)); continue; fi',
        '  resolved=$(resolve_object "$host" "$otype" "$ref")',
        '  case "$resolved" in',
        '    "") row refused "no $otype named $ref"; REFUSED=$((REFUSED + 1)); continue ;;',
        '    AMBIGUOUS) row refused "more than one $otype named $ref; use its MoRef"; REFUSED=$((REFUSED + 1)); continue ;;',
        '    UNSUPPORTED) row refused "$otype cannot be looked up by this script"; REFUSED=$((REFUSED + 1)); continue ;;',
        '  esac',
        '  IFS=$\'\\t\' read -r otype oid <<<"$resolved"',
        '  if ! jq -e --arg t "$otype" \'(.associable_types | length) == 0 or (.associable_types | index($t)) != null\' <<<"$cat_json" >/dev/null; then',
        '    row refused "$category cannot be attached to $otype"; REFUSED=$((REFUSED + 1)); continue',
        '  fi',
        '  cardinality=$(jq -r .cardinality <<<"$cat_json")',
        '  # Two rows giving one object two values of a one-value category: the run is',
        '  # refused below, because either order leaves one of them silently lost.',
        '  key="$host|$oid|$category"',
        '  if [[ "$cardinality" == SINGLE && -n "${SEEN_TAG[$key]:-}" ]]; then',
        '    if [[ "${SEEN_TAG[$key]}" != "$tag" ]]; then',
        '      DUPS+=("rows ${SEEN_ROW[$key]} and ${CSVLINE}: $ref ($oid) on $host is given $category=${SEEN_TAG[$key]} and $category=$tag")',
        '      row refused "conflicts with row ${SEEN_ROW[$key]}: $category takes one value"; REFUSED=$((REFUSED + 1))',
        '    else',
        '      row unchanged "same as row ${SEEN_ROW[$key]}"',
        '    fi',
        '    continue',
        '  fi',
        '  [[ "$cardinality" == SINGLE ]] && { SEEN_TAG[$key]=$tag; SEEN_ROW[$key]=$CSVLINE; }',
        '  current=$(attached_tags "$host" "$otype" "$oid" | jq -R . | jq -sc .)',
        '  if jq -e --arg t "$tag_id" \'index($t) != null\' <<<"$current" >/dev/null; then row unchanged "already tagged"; continue; fi',
        '  same=$(jq -r --argjson cur "$current" --arg c "$category" \'[.tags[] | select(.category == $c and (.id as $i | $cur | index($i) != null))] | first // empty | [.id, .name] | @tsv\' "$WORK/$host.json")',
        '  if [[ -n "$same" && "$cardinality" == SINGLE ]]; then',
        '    IFS=$\'\\t\' read -r before_id before <<<"$same"',
        '    if (( REPLACE )); then row replace; CHANGES=$((CHANGES + 1)); else row refused "already $category=$before; --replace to change it"; REFUSED=$((REFUSED + 1)); fi',
        '    continue',
        '  fi',
        '  row attach; CHANGES=$((CHANGES + 1))',
        'done < <(tail -n +2 "$CSV")',
        '',
        '# The plan without the ids, as a table; the ids are in the file.',
        'cut -d, -f2,4,5,7,9,10,11 < "$PLAN" | show_table',
        'echo',
        'echo "$CHANGES change(s), $REFUSED refused. The full plan is in $PLAN."',
        'if (( ${#DUPS[@]} > 0 )); then',
        '  echo "Refusing: the CSV gives an object two different values of a one-value category:" >&2',
        '  printf \'  %s\\n\' "${DUPS[@]}" >&2',
        '  echo "Keep one row per object and one-value category, then re-run. Nothing was changed." >&2',
        '  exit 2',
        'fi',
        'if (( CHANGES > MAX_CHANGES )); then',
        '  echo "Refusing: $CHANGES changes is more than MAX_CHANGES=$MAX_CHANGES. Split the CSV, or raise MAX_CHANGES after reading the plan." >&2',
        '  exit 1',
        'fi',
        'if (( DRY_RUN )); then echo "DRY RUN: nothing was changed. Read $PLAN, then re-run with --execute."; exit 0; fi',
        '',
        '# --- apply ---------------------------------------------------------------',
        '# One object at a time, and the change log is written as it goes: a row',
        '# marked pending before each call, its result filled in once the object has',
        '# been read back. So a run that stops half way — a failure, a lost session,',
        '# Ctrl-C — still leaves a log the undo can work from.',
        '#',
        '# Results: ok; failed (the attach did not take, nothing else changed);',
        '# rolled-back (a replace whose new value did not take: the old value was',
        '# re-attached at once and read back); ROLLBACK-FAILED (the old value could not',
        '# be re-attached either — the object has no value in that category now);',
        '# unknown (the object could not be read back; the undo still works, because',
        '# it goes by what is on the object).',
        '#',
        '# Policy: the run stops at the first result that is not ok. Rows after it are',
        '# not attempted; the plan still lists them, and re-running the same CSV plans',
        '# only what is still missing.',
        'LOG="change-log-${RUN}.csv"',
        'echo "vcenter,object_type,object_id,object_name,category,before_id,before,after_id,after,action,result" > "$LOG"',
        '# log_add FIELDS... appends a row and prints its line number; log_set LINE',
        '# RESULT rewrites that row\'s result (to a temporary file, then renamed).',
        'log_add() { local IFS=,; printf \'%s\\n\' "$*" >> "$LOG"; wc -l < "$LOG" | tr -d \' \'; }',
        'log_set() { awk -F, -v OFS=, -v n="$1" -v r="$2" \'NR == n { $NF = r } { print }\' "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; }',
        'OK=0; STOPPED=""',
        'while IFS=, read -r host otype oid oname category before_id before tag_id tag action reason; do',
        '  [[ "$action" == attach || "$action" == replace ]] || continue',
        '  n=$(log_add "$host" "$otype" "$oid" "$oname" "$category" "$before_id" "$before" "$tag_id" "$tag" "$action" pending)',
        '  if [[ "$action" == replace ]] && ! detach_tag "$host" "$before_id" "$otype" "$oid"; then',
        '    # A failed detach may still have happened: go by what is there.',
        '    rc=0; read_back "$host" "$otype" "$oid" "$before_id" || rc=$?',
        '    if (( rc == 0 )); then log_set "$n" failed; STOPPED="$oname: could not detach $category=$before"; break; fi',
        '    if (( rc == 2 )); then log_set "$n" unknown; STOPPED="$oname: the detach failed and the object could not be read back"; break; fi',
        '  fi',
        '  attach_tag "$host" "$tag_id" "$otype" "$oid" || echo "attach $category=$tag to $oname failed" >&2',
        '  rc=0; read_back "$host" "$otype" "$oid" "$tag_id" || rc=$?',
        '  if (( rc == 0 )); then log_set "$n" ok; OK=$((OK + 1)); continue; fi',
        '  if (( rc == 2 )); then log_set "$n" unknown; STOPPED="$oname: could not be read back after the change. Check it; the undo works from what is there"; break; fi',
        '  if [[ "$action" == replace ]]; then',
        '    # The old value is gone and the new one did not take: put the old one back now.',
        '    attach_tag "$host" "$before_id" "$otype" "$oid" || true',
        '    if read_back "$host" "$otype" "$oid" "$before_id"; then',
        '      log_set "$n" rolled-back; STOPPED="$oname: $category=$tag did not take; $category=$before was put back"',
        '    else',
        '      log_set "$n" ROLLBACK-FAILED; STOPPED="$oname: $category=$tag did not take AND $category=$before could not be put back. It has no $category now; fix it by hand or with the undo"',
        '    fi',
        '  else',
        '    log_set "$n" failed; STOPPED="$oname: $category=$tag did not take"',
        '  fi',
        '  break',
        'done < <(tail -n +2 "$PLAN")',
        'echo "$OK change(s) confirmed. Before and after: $LOG"',
        'echo "Undo: ./tag-assign.sh --undo $LOG --execute"',
        'if [[ -n "$STOPPED" ]]; then',
        '  echo "STOPPED at the first failure — $STOPPED." >&2',
        '  echo "Rows after it were not attempted. Fix the cause and re-run the same CSV; what is done already plans as unchanged." >&2',
        '  exit 1',
        'fi',
        '',
      ].join('\n');

      const psScript = [
        '<#',
        '.SYNOPSIS',
        '  Attach tags from a CSV (vcenter,object_type,object,category,tag) with PowerCLI.',
        '.DESCRIPTION',
        '  Dry run unless -Execute. Lists every change first, refuses more than',
        '  -MaxChanges, refuses to overwrite a one-value category unless -Replace, and',
        '  writes change-log-<run>.csv with the before and after of every object.',
        '  -UndoLog <change-log> puts every object back as it was.',
        '#>',
        'param(',
        "  [string]$CsvPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'assignments.csv'),",
        '  [switch]$Execute,',
        '  [switch]$Replace,',
        `  [int]$MaxChanges = ${maxChanges},`,
        '  [string]$UndoLog',
        ')',
        ...psConnect(vcenters),
        "$run = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')",
        '',
        'function Resolve-TagEntity([string]$Server, [string]$Type, [string]$Ref) {',
        "  if ($Ref -match '^(vm-|host-|domain-c|datastore-|group-[a-z]|resgroup-|datacenter-|network-|dvportgroup-)\\d+$') {",
        "    $viewType = if ($Type -eq 'Network' -and $Ref -like 'dvportgroup-*') { 'DistributedVirtualPortgroup' } else { $Type }",
        '    return @(Get-View -Server $Server -Id "$viewType-$Ref" -ErrorAction SilentlyContinue | Get-VIObjectByVIView)',
        '  }',
        '  switch ($Type) {',
        "    'VirtualMachine'              { return @(Get-VM -Server $Server -Name $Ref -ErrorAction SilentlyContinue) }",
        "    'HostSystem'                  { return @(Get-VMHost -Server $Server -Name $Ref -ErrorAction SilentlyContinue) }",
        "    'ClusterComputeResource'      { return @(Get-Cluster -Server $Server -Name $Ref -ErrorAction SilentlyContinue) }",
        "    'Datastore'                   { return @(Get-Datastore -Server $Server -Name $Ref -ErrorAction SilentlyContinue) }",
        "    'Folder'                      { return @(Get-Folder -Server $Server -Name $Ref -ErrorAction SilentlyContinue) }",
        "    'ResourcePool'                { return @(Get-ResourcePool -Server $Server -Name $Ref -ErrorAction SilentlyContinue) }",
        "    'Datacenter'                  { return @(Get-Datacenter -Server $Server -Name $Ref -ErrorAction SilentlyContinue) }",
        "    'Network'                     { return @(Get-VirtualNetwork -Server $Server -Name $Ref -ErrorAction SilentlyContinue) }",
        "    'DistributedVirtualPortgroup' { return @(Get-VirtualNetwork -Server $Server -Name $Ref -ErrorAction SilentlyContinue) }",
        '    default                       { return @() }',
        '  }',
        '}',
        '',
        'try {',
        '  if ($UndoLog) {',
        '    # Works from what is on each object now, not from the result column, so it is',
        '    # right for every row (pending, ok, failed, rolled-back), for the log of a run',
        '    # that stopped half way, and when run twice. Newest row first.',
        '    $rows = @(Import-Csv $UndoLog)',
        '    [array]::Reverse($rows)',
        '    $failures = 0',
        '    foreach ($r in $rows) {',
        '      if (-not $r.object_id -or -not $r.after) { continue }',
        '      $entity = @(Resolve-TagEntity $r.vcenter $r.object_type $r.object_id)[0]',
        '      if (-not $entity) { Write-Warning "$($r.object_name) ($($r.object_id)) not found on $($r.vcenter); skipped"; $failures++; continue }',
        '      $now = @(Get-TagAssignment -Server $r.vcenter -Entity $entity -Category $r.category | ForEach-Object { $_.Tag.Name })',
        '      $removeAfter = $now -contains $r.after',
        "      $restoreBefore = ($r.action -eq 'replace' -and $r.before -and $now -notcontains $r.before)",
        '      if (-not $removeAfter -and -not $restoreBefore) { Write-Host "as before already: $($r.object_name) $($r.category)=$($r.before) [$($r.result)]"; continue }',
        "      $steps = @($(if ($removeAfter) { \"remove $($r.category)=$($r.after)\" }), $(if ($restoreBefore) { \"restore $($r.category)=$($r.before)\" })) -ne $null",
        '      if (-not $Execute) { Write-Host "DRY RUN: $($r.object_name) [$($r.result)]: $($steps -join \', \')"; continue }',
        '      try {',
        '        if ($removeAfter) {',
        '          Get-TagAssignment -Server $r.vcenter -Entity $entity -Category $r.category |',
        '            Where-Object { $_.Tag.Name -eq $r.after } | Remove-TagAssignment -Confirm:$false',
        '        }',
        '        if ($restoreBefore) {',
        '          New-TagAssignment -Server $r.vcenter -Entity $entity -Tag (Get-Tag -Server $r.vcenter -Category $r.category -Name $r.before) | Out-Null',
        '        }',
        '        Write-Host "undone: $($r.object_name) $($r.category) $($r.after) -> $($r.before)"',
        '      }',
        '      catch { Write-Warning "$($r.object_name): $($_.Exception.Message)"; $failures++ }',
        '    }',
        '    if ($failures -gt 0) { throw "$failures object(s) could not be put back; re-run the undo once the cause is fixed." }',
        '    return',
        '  }',
        '',
        '  $plan = [System.Collections.Generic.List[object]]::new()',
        '  # One value per object in a one-value category: which CSV line set it.',
        '  $seen = @{}',
        '  $dups = [System.Collections.Generic.List[string]]::new()',
        '  $line = 1',
        '  foreach ($row in Import-Csv $CsvPath) {',
        '    $line++',
        '    $item = [ordered]@{ vcenter = $row.vcenter; object_type = $row.object_type; object_id = ""; object_name = $row.object',
        '      category = $row.category; before = ""; tag = $row.tag; action = "refused"; reason = "" }',
        '    $category = Get-TagCategory -Server $row.vcenter -Name $row.category -ErrorAction SilentlyContinue',
        '    $tag = if ($category) { Get-Tag -Server $row.vcenter -Category $category -Name $row.tag -ErrorAction SilentlyContinue } else { $null }',
        '    $found = @(Resolve-TagEntity $row.vcenter $row.object_type $row.object)',
        '    if (-not $category) { $item.reason = "no category $($row.category)" }',
        '    elseif (-not $tag) { $item.reason = "no tag $($row.tag) in $($row.category)" }',
        '    elseif ($found.Count -eq 0) { $item.reason = "no $($row.object_type) named $($row.object)" }',
        '    elseif ($found.Count -gt 1) { $item.reason = "more than one $($row.object_type) named $($row.object); use its MoRef" }',
        '    else {',
        '      $entity = $found[0]',
        '      $item.object_id = $entity.ExtensionData.MoRef.Value',
        '      $key = "$($row.vcenter)|$($item.object_id)|$($row.category)"',
        "      $single = $category.Cardinality -eq 'Single'",
        '      if ($single -and $seen.ContainsKey($key)) {',
        '        # Two rows giving one object two values of a one-value category: the run is',
        '        # refused below, because either order silently loses one of them.',
        '        if ($seen[$key].tag -ne $row.tag) {',
        '          $dups.Add("rows $($seen[$key].line) and ${line}: $($row.object) ($($item.object_id)) on $($row.vcenter) is given $($row.category)=$($seen[$key].tag) and $($row.category)=$($row.tag)")',
        '          $item.reason = "conflicts with row $($seen[$key].line): $($row.category) takes one value"',
        '        }',
        "        else { $item.action = 'unchanged'; $item.reason = \"same as row $($seen[$key].line)\" }",
        '      }',
        '      else {',
        '        if ($single) { $seen[$key] = @{ tag = $row.tag; line = $line } }',
        '        $current = @(Get-TagAssignment -Server $row.vcenter -Entity $entity -Category $category)',
        '        $currentNames = @($current | ForEach-Object { $_.Tag.Name })',
        "        if ($currentNames -contains $row.tag) { $item.action = 'unchanged'; $item.reason = 'already tagged' }",
        '        elseif ($current.Count -gt 0 -and $single) {',
        '          $item.before = $current[0].Tag.Name',
        '          $item.beforeTag = $current[0].Tag',
        '          if ($Replace) { $item.action = \'replace\' } else { $item.reason = "already $($row.category)=$($item.before); -Replace to change it" }',
        '        }',
        "        else { $item.action = 'attach' }",
        '        $item.entity = $entity; $item.tagObject = $tag',
        '      }',
        '    }',
        '    $plan.Add([pscustomobject]$item)',
        '  }',
        '',
        '  $planFile = "plan-$run.csv"',
        '  $plan | Select-Object vcenter, object_type, object_id, object_name, category, before, tag, action, reason | Export-Csv -NoTypeInformation $planFile',
        '  $plan | Format-Table vcenter, object_name, category, before, tag, action, reason -AutoSize | Out-String -Width 200 | Write-Host',
        "  $changes = @($plan | Where-Object { $_.action -in 'attach', 'replace' })",
        '  Write-Host "$($changes.Count) change(s). The full plan is in $planFile."',
        '  if ($dups.Count -gt 0) {',
        '    throw ("Refusing: the CSV gives an object two different values of a one-value category:`n  " + ($dups -join "`n  ") + "`nKeep one row per object and one-value category, then re-run. Nothing was changed.")',
        '  }',
        '  if ($changes.Count -gt $MaxChanges) { throw "Refusing: $($changes.Count) changes is more than MaxChanges=$MaxChanges." }',
        "  if (-not $Execute) { Write-Host 'DRY RUN: nothing was changed. Read the plan, then re-run with -Execute.'; return }",
        '',
        '  # One object at a time, and the change log is written as it goes: a row marked',
        '  # pending before each change, its result filled in once the object has been',
        '  # read back. Results: ok; failed (nothing changed); rolled-back (a replace whose',
        '  # new value did not take: the old value was re-attached at once and read back);',
        '  # ROLLBACK-FAILED (the old value could not be put back — no value now).',
        '  # Policy: stop at the first result that is not ok; later rows are not attempted.',
        '  $logFile = "change-log-$run.csv"',
        '  $log = [System.Collections.Generic.List[object]]::new()',
        '  function Save-Log { $log | Export-Csv -NoTypeInformation -LiteralPath $logFile }',
        '  function Test-Tagged($c, [string]$name) {',
        '    @(Get-TagAssignment -Server $c.vcenter -Entity $c.entity -Category $c.category | ForEach-Object { $_.Tag.Name }) -contains $name',
        '  }',
        '  $stopped = $null',
        '  foreach ($c in $changes) {',
        '    $entry = [pscustomobject]@{ vcenter = $c.vcenter; object_type = $c.object_type; object_id = $c.object_id; object_name = $c.object_name',
        "      category = $c.category; before = $c.before; after = $c.tag; action = $c.action; result = 'pending' }",
        '    $log.Add($entry); Save-Log',
        '    try {',
        "      if ($c.action -eq 'replace') {",
        '        Get-TagAssignment -Server $c.vcenter -Entity $c.entity -Category $c.category |',
        '          Where-Object { $_.Tag.Name -eq $c.before } | Remove-TagAssignment -Confirm:$false',
        '      }',
        '      New-TagAssignment -Server $c.vcenter -Entity $c.entity -Tag $c.tagObject | Out-Null',
        '    }',
        '    catch { Write-Warning "$($c.object_name): $($_.Exception.Message)" }',
        "    if (Test-Tagged $c $c.tag) { $entry.result = 'ok'; Save-Log; continue }",
        "    if ($c.action -eq 'replace' -and -not (Test-Tagged $c $c.before)) {",
        '      # The old value is gone and the new one did not take: put the old one back now.',
        '      try { New-TagAssignment -Server $c.vcenter -Entity $c.entity -Tag $c.beforeTag | Out-Null } catch { Write-Warning "$($c.object_name): $($_.Exception.Message)" }',
        "      $entry.result = if (Test-Tagged $c $c.before) { 'rolled-back' } else { 'ROLLBACK-FAILED' }",
        '    }',
        "    else { $entry.result = 'failed' }",
        '    Save-Log',
        '    $stopped = "$($c.object_name) $($c.category)=$($c.tag): $($entry.result)"',
        '    break',
        '  }',
        "  $okCount = @($log | Where-Object { $_.result -eq 'ok' }).Count",
        '  Write-Host "$okCount change(s) confirmed. Before and after: $logFile. Undo: ./Tag-Assign.ps1 -UndoLog $logFile -Execute"',
        '  if ($stopped) { throw "STOPPED at the first failure ($stopped). Rows after it were not attempted; fix the cause and re-run the same CSV." }',
        '}',
        'finally {',
        '  Disconnect-VIServer -Server * -Confirm:$false -ErrorAction SilentlyContinue',
        '}',
        '',
      ].join('\n');

      const pkg = toPackage({
        packageName: 'com.archtoolkit.tags.bulk_assign',
        description: `Assigns tags from a CSV (vcenter,object_type,object,category,tag) on ${vcenters.length} vCenter(s), at most ${maxChanges} changes a run, with a change log that is also the undo. Generated by ArchToolKit.`,
        categoryPath: 'ArchToolKit/Tags/Bulk assign',
        workflow: {
          name: 'Assign tags from CSV',
          description: 'Plans every row of the CSV (the assignmentsCsv input, or the resource element assignments.csv), refuses a CSV that gives one object two values of a one-value category or plans more changes than the cap, then attaches one object at a time and reads each back. A one-value category is only changed with replace = true, and a replace never leaves the object without a value unless the roll-back itself fails, which stops the run and says so. undoLogCsv puts back every object a change log names. A dry run until dryRun is set to false in the configuration element.',
          inputs: [
            { name: 'dryRun', type: 'boolean', description: 'true: plan and report, change nothing' },
            { name: 'replace', type: 'boolean', description: 'true: allow replacing the value of a one-value category (tag-assign.sh --replace)' },
            { name: 'assignmentsCsv', type: 'string', description: 'The CSV to apply; empty: the resource element assignments.csv' },
            { name: 'undoLogCsv', type: 'string', description: 'A changeLogCsv from an earlier run: put every object in it back as it was, instead of assigning' },
          ],
          outputs: [
            { name: 'planCsv', type: 'string', description: 'Every row with its MoRef, the current value and the action' },
            { name: 'changeLogCsv', type: 'string', description: 'Before and after of every change, with its result; pass it back as undoLogCsv to undo' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: BULK_ASSIGN_WORKFLOW,
        },
        actions: vcTagActions('com.archtoolkit.tags.bulk_assign', ['vcLogin', 'openVcenter', 'readCatalogue', 'tagsOn', 'resolveObject', 'changeTag', 'parseCsv', 'toCsv', 'undoChangeLog']),
        config: {
          name: 'Bulk tag assignment',
          description: 'Settings of the Assign tags from CSV workflow. Fill vcfApiToken (VCF 9.1) or vcPassword (8.x and 9.0) after import; a CSV row naming a vCenter that is not in vcenters is refused.',
          attributes: [
            ...vcAttributes(vcenters, 'Assign or Unassign vSphere Tag on the objects, and read on them'),
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is attached while this is true' },
            { name: 'cap', type: 'number', value: maxChanges, description: 'A run that plans more changes than this is refused before the first one' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [{ name: 'assignments.csv', content: `${sample.join('\n')}\n`, mimeType: 'text/csv' }],
      });

      return {
        platform: PLATFORM,
        title: `Bulk tag assignment from assignments.csv (at most ${maxChanges} changes a run)`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'An engineer runs it with a reviewed CSV — the first tagging pass, a migration wave, an application onboarding.' },
        scope: {
          what: 'Exactly the objects named in the CSV, on the vCenters the CSV names, and only the categories it names.',
          decidedBy: [
            'Each row: vCenter, object type, object name or MoRef, category, tag.',
            'Name resolution: GET /api/vcenter/<type>?names=<name> (or ?<type>s=<moref>). A name that matches more than one object is refused, not guessed.',
            'The category’s cardinality and associable object types in that vCenter.',
            'What is already attached: unchanged rows are skipped; a one-value category that already has a value is refused without --replace.',
            'The CSV as a whole: two rows giving one object different values of a one-value category refuse the run.',
          ],
          ifWrong: 'A wrong CSV row moves an object into another custom group, placement zone, NSX group or cost centre. The cap and the dry run are what keep a wrong CSV to a handful of objects, and the change log puts them back.',
        },
        guardrails: [
          { rule: `Refuses the whole run above ${maxChanges} changes (MAX_CHANGES / -MaxChanges)`, because: 'A CSV exported from the wrong filter is thousands of rows. The run stops before the first change rather than after the thousandth.' },
          { rule: 'Never replaces an existing value in a one-value category without --replace / -Replace', because: 'Silently re-tagging a prod VM as test is exactly the change nobody meant to make, and it moves the VM out of its firewall group.' },
          { rule: 'Refuses a name that matches more than one object', because: 'Two VMs called "app01" in different folders is normal. The script asks for the MoRef rather than tagging both.' },
          { rule: 'Only attaches tags that already exist in the category', because: 'Values come from the standard. A typo in the CSV is refused instead of becoming a new tag.' },
          { rule: 'Writes the change log as it goes — a pending row before each change, its result after the object is read back', because: 'A run that dies half way otherwise leaves objects changed and no record of what they were before. The log is the undo.' },
          { rule: 'A replace never leaves the object without a value: in a several-value category the new value is attached and read back before the old one is detached; in a one-value category, where vCenter refuses a second value, a new value that does not take is rolled back at once (old value re-attached and read back) and the run stops', because: 'Detach-then-attach leaves the object with no value in between. Without the immediate roll-back, a failed attach leaves a prod VM with no Environment, out of every group that selects on it. The only way it ends with no value is a roll-back that fails too, which the change log records as ROLLBACK-FAILED with the tag to put back.' },
          { rule: 'Stops at the first change that does not take', because: 'The next rows usually fail the same way (a missing privilege, a lost session). Re-running the same CSV plans only what is still missing.' },
          { rule: 'Refuses a CSV that gives one object two different values of a one-value category, listing the rows', because: 'Whichever row runs second silently wins, or replaces the first; either way the CSV said two things and one is lost.' },
        ],
        dryRun: [
          'The workflow Assign tags from CSV is a dry run until dryRun is set to false in its configuration element: the planCsv output (and a PLAN line per row in the log) lists every row with its MoRef, the current value and the action, and nothing is attached.',
          ...(bash ? ['./scripts/tag-assign.sh with no --execute writes plan-<run>.csv — every row with its MoRef, the current value and the action — and changes nothing.'] : []),
          ...(ps ? ['./scripts/Tag-Assign.ps1 without -Execute does the same with PowerCLI.'] : []),
        ],
        undo: [
          'Run the workflow again with undoLogCsv set to the changeLogCsv output of the run to undo (same columns as the script’s change-log-<run>.csv, so either can undo the other’s run).',
          ...(bash ? ['./scripts/tag-assign.sh --undo change-log-<run>.csv --execute detaches every tag the run attached and re-attaches every value it replaced.'] : []),
          ...(ps ? ['./scripts/Tag-Assign.ps1 -UndoLog change-log-<run>.csv -Execute does the same.'] : []),
          'The undo works from what is on each object now rather than from the result column, newest row first: it detaches the value the run attached if it is there, and re-attaches the replaced value if it is missing. So it is right for a log left by a run that stopped or was killed half way (rows still marked pending included), and running it twice changes nothing the second time.',
        ],
        told: ['The workflow’s planCsv and changeLogCsv outputs and its AUDIT lines (the audit record posted to the webhook if set); plan-<run>.csv and change-log-<run>.csv beside the script. Attach them to the change record. vCenter records every attach and detach as an event against the object.'],
        requires: [
          ...(bash ? VC_REQUIRES : []),
          ...(ps ? ['PowerShell 7 and PowerCLI (VMware.VimAutomation.Core) for Tag-Assign.ps1, with VCENTERS, VC_USER and VC_PASSWORD_FILE set the same way.'] : []),
          'Tagging > Assign or Unassign vSphere Tag on the objects (and on the root to be simple about it), plus read on the objects.',
          'The categories and tags already created — run the tag standard blueprint first.',
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the vCenter certificates trusted in Orchestrator.',
        ],
        files: {
          'assignments.csv': `${sample.join('\n')}\n`,
          ...pkg.files,
          ...(bash ? { 'scripts/tag-assign.sh': bashScript } : {}),
          ...(ps ? { 'scripts/Tag-Assign.ps1': psScript } : {}),
          'IMPORT.md': tagsImport(
            `assignments.csv is the bulk-assignment file. Neither vCenter nor VCF Operations imports an assignment CSV, so something has to read it and call the API: the Orchestrator package \`${pkg.packageDir}\` (on the shared core library) is that component — its workflow **Assign tags from CSV** resolves each row to the object on its vCenter and attaches the tag (POST /api/cis/tagging/tag-association/{tag}?action=attach, read back with list-attached-tags-on-objects). The scripts under scripts/ do the same from a host, with bash or PowerCLI.`,
            [
              ...pkg.importSteps,
              {
                heading: 'Fill assignments.csv',
                lines: [
                  'Columns, in this order, with this header line: `vcenter,object_type,object,category,tag`.',
                  '',
                  '- vcenter: the vCenter FQDN as in VCENTERS.',
                  '- object_type: the vSphere type name (VirtualMachine, HostSystem, ClusterComputeResource, Datastore, Folder, ResourcePool, Datacenter, Network, DistributedVirtualPortgroup, ...).',
                  '- object: its name, or its MoRef (vm-2041) when names repeat.',
                  '- category, tag: exactly as in the tag standard — create the standard first (tags_taxonomy).',
                ],
              },
              ...(bash ? [{ heading: 'Or: assign with the bash script', lines: ['`./scripts/tag-assign.sh` (it reads assignments.csv, one level up) writes plan-<run>.csv listing every change; `./scripts/tag-assign.sh --execute` makes them and writes change-log-<run>.csv, which `./scripts/tag-assign.sh --undo change-log-<run>.csv --execute` reverses. Add `--replace` to allow changing the value of a one-value category.'] }] : []),
              ...(ps ? [{ heading: bash ? 'Or with PowerCLI' : 'Or: assign with PowerCLI', lines: ['`pwsh ./scripts/Tag-Assign.ps1` (dry run; it reads assignments.csv one level up, or -CsvPath), then add `-Execute`. VC_USER and VC_PASSWORD_FILE log in.'] }] : []),
              { heading: 'VCF 9.1', lines: ['Assignments made in vCenter appear in VCF Operations tag management (Manage > Fleet Management > Tags) with the next sync; 9.1.1 can also assign there, by hand or with POST /suite-api/api/fleet-management/tag-management/assignments ({resourceIds, tagsToAttach, tagsToDetach}, VCF Operations resource ids — not vCenter MoRefs). There is no CSV import in either place.'] },
            ],
            ['A replace in a one-value category detaches the old value before attaching the new one, because vCenter refuses a second value in a one-value category ("Tagging cardinality violation"); the workflow rolls the old value back at once if the new one does not take. VERIFY on your build whether the 9.1.1 fleet assignment call (tagsToAttach and tagsToDetach in one task) swaps a one-value category without that window.', 'The VCF 9.1 API-token login to vCenter follows davidwzhang.com "VCF 9.1 API Access (4)"; confirm it, or use vcUsername and vcPassword.'],
          ),
        },
        notes: [
          'Folders are matched by name alone, and vCenter has many folders called "Discovered virtual machine". Use the folder MoRef (group-v123) in the CSV for folders.',
          'In VCF 9.1 the same assignments can be made from VCF Operations (Manage > Fleet Management > Tags > Tag Assignments, or POST .../tag-management/assignments). The vCenter route is used here because it works on vSphere 8 and 9, and assignments made in vCenter show up in VCF Operations anyway.',
          'Names containing commas cannot be expressed in this CSV. Use the MoRef.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'tags_rules',
    platform: PLATFORM,
    label: 'Tag VMs automatically from rules, on a schedule',
    group: 'Tags — assign',
    description:
      'Rule-based tagging that keeps up with the estate: a VM named prd-* gets Environment=prod, a VM in the Payments folder gets Application=payments, a VM in the gold cluster gets Tier=1, a Windows guest gets OS=windows. By default a rule only fills a category that is empty; it changes a value somebody set only when the rule is marked authoritative. Every disagreement is reported rather than settled.',
    inputs: [
      VCENTERS_INPUT,
      {
        id: 'rules',
        label: 'Rules',
        control: 'textarea',
        default: [
          '# match | pattern | Category=Tag | fill or authoritative',
          '# match: name (regex on the VM name), folder (VM anywhere under a folder of that name),',
          '# cluster (VM in a cluster of that name), guestos (guest OS name contains), tag (VM already has Category=Tag)',
          'name | ^prd- | Environment=prod | fill',
          'name | ^(uat|tst)- | Environment=test | fill',
          'name | ^dev- | Environment=dev | fill',
          'folder | Payments | Application=payments | fill',
          'cluster | wld01-cl-gold | Tier=1 | authoritative',
          'guestos | Windows | OS=windows | fill',
          'guestos | Linux | OS=linux | fill',
          'tag | Environment=prod | BackupPolicy=gold-daily | fill',
        ].join('\n'),
      },
      { id: 'exclude_tag', label: 'Never touch VMs tagged', control: 'text', default: 'Automation=never', hint: 'Category=Tag. Empty means no escape hatch' },
      { id: 'max_changes', label: 'Refuse a run that changes more than (VMs)', control: 'number', default: 100, min: 1, max: 20000 },
      { id: 'hour', label: 'Run daily at (hour, server time)', control: 'number', default: 3, min: 0, max: 23 },
      { id: 'scheduled_execute', label: 'Let the scheduled run make changes', control: 'toggle', default: false, hint: 'Off: the schedule only reports what it would do' },
    ],
    automation: (values: BlueprintValues): Automation => {
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const excludeTag = str(values, 'exclude_tag', '');
      const maxChanges = num(values, 'max_changes', 100);
      const hour = num(values, 'hour', 3);
      const scheduledExecute = bool(values, 'scheduled_execute', false);
      const findings: Finding[] = [];
      const kinds = ['name', 'folder', 'cluster', 'guestos', 'tag'];
      const rules: { kind: string; pattern: string; category: string; tag: string; mode: string }[] = [];
      for (const line of str(values, 'rules', '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
        // The pattern is everything between the first and the last two fields, so a
        // regex alternation like ^(uat|tst)- survives the | separator.
        const fields = line.split('|');
        const kind = (fields[0] ?? '').trim();
        const mode = fields.length >= 4 ? (fields[fields.length - 1] ?? '').trim() : '';
        const target = fields.length >= 4 ? (fields[fields.length - 2] ?? '').trim() : '';
        const pattern = fields.slice(1, -2).join('|').trim();
        const [category = '', tag = ''] = target.split('=').map((f) => f.trim());
        if (!kinds.includes(kind)) {
          findings.push(error('tags.rules.kind', `"${line}": "${kind}" is not one of ${kinds.join(', ')}.`, { path: 'rules', source: SRC }));
          continue;
        }
        if (!pattern || !category || !tag) {
          findings.push(error('tags.rules.malformed', `"${line}" needs a pattern and a Category=Tag.`, { path: 'rules', source: SRC }));
          continue;
        }
        if (mode !== 'fill' && mode !== 'authoritative') {
          findings.push(error('tags.rules.mode', `"${line}": the last field is fill or authoritative, not "${mode}".`, { path: 'rules', source: SRC }));
          continue;
        }
        if (kind === 'name') {
          try {
            new RegExp(pattern);
          } catch {
            findings.push(error('tags.rules.regex', `"${pattern}" is not a valid regular expression.`, { path: 'rules', source: SRC }));
            continue;
          }
          if (!pattern.startsWith('^')) findings.push(warning('tags.rules.unanchored', `The name pattern "${pattern}" is not anchored, so it matches anywhere in the name.`, { path: 'rules', remediation: `"prd" also matches "sprdsheet01". Start it with ^.`, source: SRC }));
        }
        if (kind === 'tag' && !/^[^=]+=[^=]+$/.test(pattern)) findings.push(error('tags.rules.tag-pattern', `A tag rule matches Category=Tag; "${pattern}" is not that.`, { path: 'rules', source: SRC }));
        if (mode === 'authoritative') {
          findings.push(warning('tags.rules.authoritative', `${kind} ${pattern} → ${category}=${tag} overwrites a value somebody set by hand.`, { path: 'rules', remediation: 'Keep authoritative rules to facts the platform owns, such as which cluster a VM runs in. Anything a person decides should be fill-only.', source: SRC }));
        }
        rules.push({ kind, pattern, category, tag, mode });
      }
      if (rules.length === 0) findings.push(error('tags.rules.none', 'There are no rules.', { path: 'rules', source: SRC }));
      if (!excludeTag) findings.push(warning('tags.rules.no-exclusion', 'There is no exclusion tag.', { remediation: 'Without one, the only way to stop the rules touching a VM is to edit the rules. Automation=never is the escape hatch every automation in this kit honours.', source: SRC }));
      else if (!/^[^=]+=[^=]+$/.test(excludeTag)) findings.push(error('tags.rules.exclude-format', 'The exclusion tag must be Category=Tag.', { path: 'exclude_tag', source: SRC }));
      const byCategory = new Map<string, Set<string>>();
      for (const rule of rules) byCategory.set(rule.category, (byCategory.get(rule.category) ?? new Set()).add(rule.tag));
      for (const [category, tags] of byCategory) {
        if (tags.size > 1) findings.push(info('tags.rules.overlap', `${category} is set by rules for ${[...tags].join(', ')}. A VM two of them match is reported as a conflict and left alone.`, { source: SRC }));
      }
      if (scheduledExecute) findings.push(warning('tags.rules.scheduled-execute', 'The scheduled run makes changes without anyone reading the plan first.', { remediation: 'Run it report-only on the schedule for a couple of weeks, read the plans, and only then switch this on. The cap still applies.', source: SRC }));

      const script = [
        '<#',
        '.SYNOPSIS',
        '  Tag VMs from rules in tag-rules.json. Dry run unless -Execute.',
        '.DESCRIPTION',
        '  Fill-only rules set a category only when the VM has no value in it, for',
        '  one-value and several-value categories alike. Authoritative rules also',
        '  replace a different value in a one-value category, and add their value to a',
        '  several-value category that already has others. Rules that disagree',
        '  about a one-value category, and fill-only rules that disagree with a value',
        '  already set, are written to the conflicts report and change nothing.',
        `  VMs tagged ${excludeTag || '(no exclusion tag set)'} are never touched.`,
        '  -UndoLog <log> puts every VM a run changed back as it was.',
        '#>',
        'param(',
        '  [switch]$Execute,',
        `  [int]$MaxChanges = ${maxChanges},`,
        "  [string]$RulesPath = (Join-Path $PSScriptRoot 'tag-rules.json'),",
        "  [string]$OutDir = (Join-Path $PSScriptRoot 'reports'),",
        `  [string]$ExcludeTag = '${excludeTag.replace(/'/g, "''")}',`,
        '  [string]$UndoLog',
        ')',
        ...psConnect(vcenters),
        "$run = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')",
        'New-Item -ItemType Directory -Force -Path $OutDir | Out-Null',
        '$rules = @(Get-Content -LiteralPath $RulesPath -Raw | ConvertFrom-Json)',
        '$plan = [System.Collections.Generic.List[object]]::new()',
        '$conflicts = [System.Collections.Generic.List[object]]::new()',
        '',
        'function Add-Conflict($vc, $vmName, $category, $current, $wanted, $why) {',
        '  $conflicts.Add([pscustomobject]@{ vcenter = $vc; vm = $vmName; category = $category; current = $current; wanted = $wanted; reason = $why })',
        '}',
        '',
        'try {',
        '  if ($UndoLog) {',
        '    # Works from what is on each VM now, not from the result column, so it is right',
        '    # for every row (pending, ok, failed, rolled-back), for the log of a run that',
        '    # stopped half way, and when run twice. Newest row first.',
        '    $rows = @(Import-Csv $UndoLog)',
        '    [array]::Reverse($rows)',
        '    $failures = 0',
        '    foreach ($r in $rows) {',
        '      if (-not $r.object_id -or -not $r.after) { continue }',
        '      $vm = Get-VM -Server $r.vcenter -Id "VirtualMachine-$($r.object_id)" -ErrorAction SilentlyContinue',
        '      if (-not $vm) { Write-Warning "$($r.object_name) ($($r.object_id)) not found on $($r.vcenter); skipped"; $failures++; continue }',
        '      $now = @(Get-TagAssignment -Server $r.vcenter -Entity $vm -Category $r.category | ForEach-Object { $_.Tag.Name })',
        '      $removeAfter = $now -contains $r.after',
        "      $restoreBefore = ($r.action -eq 'replace' -and $r.before -and $now -notcontains $r.before)",
        '      if (-not $removeAfter -and -not $restoreBefore) { Write-Host "as before already: $($vm.Name) $($r.category)=$($r.before) [$($r.result)]"; continue }',
        '      if (-not $Execute) { Write-Host "DRY RUN: $($vm.Name) [$($r.result)]: $(if ($removeAfter) { "remove $($r.category)=$($r.after) " })$(if ($restoreBefore) { "restore $($r.category)=$($r.before)" })"; continue }',
        '      try {',
        '        if ($removeAfter) { Get-TagAssignment -Server $r.vcenter -Entity $vm -Category $r.category | Where-Object { $_.Tag.Name -eq $r.after } | Remove-TagAssignment -Confirm:$false }',
        '        if ($restoreBefore) { New-TagAssignment -Server $r.vcenter -Entity $vm -Tag (Get-Tag -Server $r.vcenter -Category $r.category -Name $r.before) | Out-Null }',
        '        Write-Host "undone: $($vm.Name) $($r.category) $($r.after) -> $($r.before)"',
        '      }',
        '      catch { Write-Warning "$($vm.Name): $($_.Exception.Message)"; $failures++ }',
        '    }',
        '    if ($failures -gt 0) { throw "$failures VM(s) could not be put back; re-run the undo once the cause is fixed." }',
        '    return',
        '  }',
        '',
        '  foreach ($vc in $vcList) {',
        '    $tags = @{}; foreach ($t in Get-Tag -Server $vc) { $tags["$($t.Category.Name)=$($t.Name)"] = $t }',
        '    $cats = @{}; foreach ($c in Get-TagCategory -Server $vc) { $cats[$c.Name] = $c }',
        '    $usable = @($rules | Where-Object { $tags.ContainsKey("$($_.category)=$($_.tag)") })',
        '    foreach ($r in @($rules | Where-Object { -not $tags.ContainsKey("$($_.category)=$($_.tag)") })) {',
        '      Add-Conflict $vc \'*\' $r.category \'\' $r.tag "rule $($r.kind) $($r.pattern) skipped: there is no tag $($r.category)=$($r.tag) on $vc"',
        '    }',
        '    $vms = @(Get-VM -Server $vc)',
        '    if ($vms.Count -eq 0) { continue }',
        '',
        '    # Every tag on every VM, read once rather than once per VM.',
        '    $byVm = @{}',
        '    foreach ($a in @(Get-TagAssignment -Server $vc -Entity $vms)) {',
        '      if (-not $byVm.ContainsKey($a.Entity.Id)) { $byVm[$a.Entity.Id] = [System.Collections.Generic.List[object]]::new() }',
        '      $byVm[$a.Entity.Id].Add($a)',
        '    }',
        '    # Folder and cluster membership, read once per rule. Get-VM under a folder is recursive.',
        '    $members = @{}',
        "    foreach ($r in @($usable | Where-Object { $_.kind -in 'folder', 'cluster' })) {",
        '      $key = "$($r.kind):$($r.pattern)"',
        '      if ($members.ContainsKey($key)) { continue }',
        '      $set = [System.Collections.Generic.HashSet[string]]::new()',
        "      $containers = if ($r.kind -eq 'folder') { Get-Folder -Server $vc -Name $r.pattern -Type VM -ErrorAction SilentlyContinue } else { Get-Cluster -Server $vc -Name $r.pattern -ErrorAction SilentlyContinue }",
        '      foreach ($m in @($containers | Get-VM)) { [void]$set.Add($m.Id) }',
        '      $members[$key] = $set',
        '    }',
        '',
        '    foreach ($vm in $vms) {',
        '      $current = if ($byVm.ContainsKey($vm.Id)) { @($byVm[$vm.Id]) } else { @() }',
        '      $pairs = @($current | ForEach-Object { "$($_.Tag.Category.Name)=$($_.Tag.Name)" })',
        '      if ($ExcludeTag -and $pairs -contains $ExcludeTag) { continue }',
        '      $want = @{}',
        '      foreach ($r in $usable) {',
        '        $hit = switch ($r.kind) {',
        "          'name'    { $vm.Name -match $r.pattern }",
        "          'folder'  { $members[\"folder:$($r.pattern)\"].Contains($vm.Id) }",
        "          'cluster' { $members[\"cluster:$($r.pattern)\"].Contains($vm.Id) }",
        "          'guestos' {",
        '            $os = $vm.Guest.OSFullName',
        '            if (-not $os) { $os = $vm.ExtensionData.Config.GuestFullName }',
        '            [bool]($os -and $os.IndexOf($r.pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0)',
        '          }',
        "          'tag'     { $pairs -contains $r.pattern }",
        '          default   { $false }',
        '        }',
        '        if ($hit) {',
        '          if (-not $want.ContainsKey($r.category)) { $want[$r.category] = [System.Collections.Generic.List[object]]::new() }',
        '          $want[$r.category].Add($r)',
        '        }',
        '      }',
        '      foreach ($cat in $want.Keys) {',
        '        $category = $cats[$cat]',
        '        $wanted = @($want[$cat] | ForEach-Object { $_.tag } | Select-Object -Unique)',
        '        $have = @($current | Where-Object { $_.Tag.Category.Name -eq $cat } | ForEach-Object { $_.Tag.Name })',
        '        $why = (@($want[$cat] | ForEach-Object { "$($_.kind) $($_.pattern)" }) -join \'; \')',
        "        $authoritative = @($want[$cat] | Where-Object { $_.mode -eq 'authoritative' }).Count -gt 0",
        "        if ($category.Cardinality -eq 'Single') {",
        '          if ($wanted.Count -gt 1) { Add-Conflict $vc $vm.Name $cat ($have -join \' \') ($wanted -join \' \') "rules disagree: $why"; continue }',
        '          $t = $wanted[0]',
        '          if ($have -contains $t) { continue }',
        '          if ($have.Count -gt 0 -and -not $authoritative) { Add-Conflict $vc $vm.Name $cat $have[0] $t "fill-only rule ($why) disagrees with the value already set; left alone"; continue }',
        "          $action = if ($have.Count -gt 0) { 'replace' } else { 'attach' }",
        '          $before = if ($have.Count -gt 0) { $have[0] } else { \'\' }',
        '          $plan.Add([pscustomobject]@{ vcenter = $vc; object_type = \'VirtualMachine\'; object_id = $vm.ExtensionData.MoRef.Value; object_name = $vm.Name',
        '            category = $cat; before = $before; after = $t; action = $action; rule = $why; entity = $vm; tag = $tags["$cat=$t"]',
        '            beforeTag = $(if ($before) { $tags["$cat=$before"] } else { $null }) })',
        '        }',
        '        else {',
        '          # Several-value category. Fill-only means the same as for a one-value',
        '          # category: act only when the VM has no value in it at all. Once it has',
        '          # one, only an authoritative rule adds a value; a fill-only rule that',
        '          # would add one is reported instead.',
        '          $missing = @($wanted | Where-Object { $have -notcontains $_ })',
        '          if ($missing.Count -eq 0) { continue }',
        '          if ($have.Count -gt 0) {',
        "            $byAuthority = @($want[$cat] | Where-Object { $_.mode -eq 'authoritative' } | ForEach-Object { $_.tag })",
        '            $fillOnly = @($missing | Where-Object { $byAuthority -notcontains $_ })',
        '            if ($fillOnly.Count -gt 0) { Add-Conflict $vc $vm.Name $cat ($have -join \' \') ($fillOnly -join \' \') "fill-only rule ($why): $cat already has a value, so nothing is added" }',
        '            $missing = @($missing | Where-Object { $byAuthority -contains $_ })',
        '          }',
        '          foreach ($t in $missing) {',
        '            $plan.Add([pscustomobject]@{ vcenter = $vc; object_type = \'VirtualMachine\'; object_id = $vm.ExtensionData.MoRef.Value; object_name = $vm.Name',
        '              category = $cat; before = \'\'; after = $t; action = \'attach\'; rule = $why; entity = $vm; tag = $tags["$cat=$t"]; beforeTag = $null })',
        '          }',
        '        }',
        '      }',
        '    }',
        '  }',
        '',
        '  $planFile = Join-Path $OutDir "tag-rules-plan-$run.csv"',
        '  $conflictFile = Join-Path $OutDir "tag-rules-conflicts-$run.csv"',
        '  $plan | Select-Object vcenter, object_type, object_id, object_name, category, before, after, action, rule | Export-Csv -NoTypeInformation $planFile',
        '  $conflicts | Export-Csv -NoTypeInformation $conflictFile',
        '  $vmCount = @($plan | Select-Object -ExpandProperty object_id -Unique).Count',
        '  Write-Host "$($plan.Count) change(s) on $vmCount VM(s); $($conflicts.Count) conflict(s). Plan: $planFile  Conflicts: $conflictFile"',
        '  if ($vmCount -gt $MaxChanges) { Write-Error "Refusing: $vmCount VMs would change, more than MaxChanges=$MaxChanges. A rule is probably wider than meant — read the plan."; exit 1 }',
        "  if (-not $Execute) { Write-Host 'DRY RUN: nothing was changed.'; return }",
        '',
        '  # One VM and category at a time, and the log is written as it goes: a row marked',
        '  # pending before each change, its result filled in once the VM has been read',
        '  # back. Results: ok; failed (nothing changed); rolled-back (a replace whose new',
        '  # value did not take: the old value was re-attached at once and read back);',
        '  # ROLLBACK-FAILED (the old value could not be put back — no value now).',
        '  # Policy: stop at the first result that is not ok; later changes are not attempted.',
        '  $logFile = Join-Path $OutDir "tag-rules-log-$run.csv"',
        '  $log = [System.Collections.Generic.List[object]]::new()',
        '  function Save-Log { $log | Export-Csv -NoTypeInformation -LiteralPath $logFile }',
        '  function Test-Tagged($p, [string]$name) {',
        '    @(Get-TagAssignment -Server $p.vcenter -Entity $p.entity -Category $p.category | ForEach-Object { $_.Tag.Name }) -contains $name',
        '  }',
        '  $stopped = $null',
        '  foreach ($p in $plan) {',
        '    $entry = [pscustomobject]@{ vcenter = $p.vcenter; object_type = $p.object_type; object_id = $p.object_id; object_name = $p.object_name',
        "      category = $p.category; before = $p.before; after = $p.after; action = $p.action; rule = $p.rule; result = 'pending' }",
        '    $log.Add($entry); Save-Log',
        '    try {',
        "      if ($p.action -eq 'replace') {",
        '        Get-TagAssignment -Server $p.vcenter -Entity $p.entity -Category $p.category |',
        '          Where-Object { $_.Tag.Name -eq $p.before } | Remove-TagAssignment -Confirm:$false',
        '      }',
        '      New-TagAssignment -Server $p.vcenter -Entity $p.entity -Tag $p.tag | Out-Null',
        '    }',
        '    catch { Write-Warning "$($p.object_name): $($_.Exception.Message)" }',
        "    if (Test-Tagged $p $p.after) { $entry.result = 'ok'; Save-Log; continue }",
        "    if ($p.action -eq 'replace' -and -not (Test-Tagged $p $p.before)) {",
        '      # The old value is gone and the new one did not take: put the old one back now.',
        '      try { New-TagAssignment -Server $p.vcenter -Entity $p.entity -Tag $p.beforeTag | Out-Null } catch { Write-Warning "$($p.object_name): $($_.Exception.Message)" }',
        "      $entry.result = if (Test-Tagged $p $p.before) { 'rolled-back' } else { 'ROLLBACK-FAILED' }",
        '    }',
        "    else { $entry.result = 'failed' }",
        '    Save-Log',
        '    $stopped = "$($p.object_name) $($p.category)=$($p.after): $($entry.result)"',
        '    break',
        '  }',
        "  $okCount = @($log | Where-Object { $_.result -eq 'ok' }).Count",
        '  Write-Host "$okCount change(s) confirmed. Before and after: $logFile. Undo: ./Tag-Rules.ps1 -UndoLog $logFile -Execute"',
        '  if ($stopped) { throw "STOPPED at the first failure ($stopped). Later changes were not attempted; the next run plans them again." }',
        '}',
        'finally {',
        '  Disconnect-VIServer -Server * -Confirm:$false -ErrorAction SilentlyContinue',
        '}',
        '',
      ].join('\n');

      const cron = [
        '# Tag rules, daily. No secret here: VCF_API_TOKEN_FILE is a path to a mode-600 file (VC_USER + VC_PASSWORD_FILE on 8.x/9.0).',
        `# ${scheduledExecute ? 'This schedule makes changes (capped).' : 'This schedule only reports. Add -Execute once the plans have been right for a while.'}`,
        '# With the Orchestrator package, schedule the workflow Tag VMs from rules in Orchestrator instead and leave this out.',
        `0 ${hour} * * * cd /opt/archtoolkit/tag-rules && ${vcScheduledEnv(vcenters)} pwsh -NoProfile -File ./scripts/Tag-Rules.ps1${scheduledExecute ? ' -Execute' : ''} >> scripts/reports/tag-rules.log 2>&1`,
        '',
      ].join('\n');

      const pkg = toPackage({
        packageName: 'com.archtoolkit.tags.rules',
        description: `Tags VMs on ${vcenters.length} vCenter(s) from ${rules.length} rules; fill-only unless a rule is authoritative; at most ${maxChanges} VMs a run. Generated by ArchToolKit.`,
        categoryPath: 'ArchToolKit/Tags/Rules',
        workflow: {
          name: 'Tag VMs from rules',
          description: `Reads every VM and its tags on each vCenter, matches the rules in the resource element tag-rules.json (name regex, folder, cluster, guest OS, tag already present), and attaches what the rules say — only into an empty category unless the rule is authoritative. Disagreements go to conflictsCsv and change nothing. VMs tagged ${excludeTag || '(no exclusion set)'} are never touched. undoLogCsv puts back every VM a change log names. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [
            { name: 'dryRun', type: 'boolean', description: 'true: plan and report, change nothing' },
            { name: 'undoLogCsv', type: 'string', description: 'A changeLogCsv from an earlier run: put every VM in it back as it was, instead of applying the rules' },
          ],
          outputs: [
            { name: 'planCsv', type: 'string', description: 'Every change the rules call for' },
            { name: 'conflictsCsv', type: 'string', description: 'Everything a person has to settle' },
            { name: 'changeLogCsv', type: 'string', description: 'Before and after of every change, with its result; pass it back as undoLogCsv to undo' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: RULES_WORKFLOW,
        },
        actions: vcTagActions('com.archtoolkit.tags.rules', ['vcLogin', 'openVcenter', 'readCatalogue', 'readAssociations', 'tagsOn', 'changeTag', 'parseCsv', 'toCsv', 'undoChangeLog']),
        config: {
          name: 'Tag rules',
          description: 'Settings of the Tag VMs from rules workflow. Fill vcfApiToken (VCF 9.1) or vcPassword (8.x and 9.0) after import. Schedule the workflow report-only (dryRun true) until its plans have been right for a while.',
          attributes: [
            ...vcAttributes(vcenters, 'Assign or Unassign vSphere Tag on the VMs, and read on VMs, folders and clusters'),
            { name: 'excludeTag', type: 'string', value: excludeTag, description: 'Category=Tag: VMs carrying it are never touched' },
            { name: 'maxVms', type: 'number', value: maxChanges, description: 'A run that would change more VMs than this is refused before the first change' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is attached while this is true' },
            { name: 'cap', type: 'number', value: maxChanges * 4, description: 'The most tag changes (VM and category) one run may make' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [{ name: 'tag-rules.json', content: `${JSON.stringify(rules, null, 2)}\n` }],
      });

      return {
        platform: PLATFORM,
        title: `Rule-based VM tagging — ${rules.length} rules, daily at ${String(hour).padStart(2, '0')}:00`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `Daily at ${String(hour).padStart(2, '0')}:00 from the Orchestrator scheduler (or cron / Windows Task Scheduler with the fallback script), ${scheduledExecute ? 'making changes once dryRun is set to false' : 'report-only: dryRun stays true (and the script has no -Execute) until the plans have been right for a while'}.`, worstCase: 'once a day, across every VM on every vCenter listed' },
        scope: {
          what: `Virtual machines on ${vcenters.join(', ')}, in the categories the rules name, never those tagged ${excludeTag || '(nothing — no exclusion set)'}.`,
          decidedBy: [
            'The rules in tag-rules.json (the resource element of the same name in the package), in the order written.',
            'Which VMs match: a name regex (case-insensitive; JavaScript syntax in the workflow, .NET in the script), membership anywhere under a folder or in a cluster of that name, the guest OS name, or a tag already present.',
            'Fill-only rules act only on a category the VM has no value in, whether it takes one value or several; authoritative rules also replace a different value in a one-value category, and add their value to a several-value category that already has others.',
            `The exclusion tag ${excludeTag || '(none)'}, checked before any rule.`,
          ],
          ifWrong: 'A rule wider than meant — a regex without an anchor, a folder name that exists twice — re-tags hundreds of VMs, and every custom group, NSX group and placement decision keyed on that tag follows. The cap stops the run; the log undoes it.',
        },
        guardrails: [
          { rule: `Refuses the whole run if more than ${maxChanges} VMs would change`, because: 'A new rule that matches everything is the realistic failure. The first run after it is refused instead of re-tagging the estate.' },
          { rule: 'Fill-only by default: a category that already has a value on the VM — one or several — is never changed or added to unless the rule is authoritative', because: 'A person who tagged a VM by hand knew something the naming convention did not. Adding Application=payments next to a hand-set Application=web-portal would put the VM in both firewall groups.' },
          { rule: 'Writes the log as it goes, and a replace never leaves the VM without a value: a several-value category gets the new value before the old one goes; a one-value category (vCenter refuses a second value) is rolled back at once if the new value does not take, and the run stops', because: 'Detach-then-attach leaves the VM with no value in between; a failure there without the roll-back leaves it out of every group that selects on the category, with no record to undo from.' },
          { rule: 'Rules that disagree about a one-value category change nothing and are reported', because: 'Picking one silently means the VM’s environment depends on the order rules happen to be read in.' },
          ...(excludeTag ? [{ rule: `VMs tagged ${excludeTag} are never touched`, because: 'An owner can take a VM out of the automation at once, without editing it.' }] : []),
          { rule: `The schedule is ${scheduledExecute ? 'set to act, still capped' : 'report-only'}`, because: 'Nobody reads the plan of a scheduled run. Report-only until the plans have been right for a while.' },
        ],
        dryRun: ['The workflow Tag VMs from rules is a dry run until dryRun is set to false in its configuration element: planCsv and conflictsCsv say what it would do, and nothing changes.', './scripts/Tag-Rules.ps1 without -Execute writes scripts/reports/tag-rules-plan-<run>.csv and tag-rules-conflicts-<run>.csv and changes nothing.'],
        undo: ['Run the workflow with undoLogCsv set to the changeLogCsv of the run to undo; ./scripts/Tag-Rules.ps1 -UndoLog scripts/reports/tag-rules-log-<run>.csv -Execute does the same for a script run. Both remove every tag the run attached and put back every value it replaced, working from what is on each VM now, newest row first, so they are right for the log of a run that stopped half way (rows still marked pending included) and change nothing when run twice.'],
        told: ['The workflow’s changeLogCsv and conflictsCsv outputs and the audit record (posted to the webhook if set); scripts/reports/tag-rules-log-<run>.csv and tag-rules-conflicts-<run>.csv for the script. Point whoever owns the standard at the conflicts; they are the useful half.'],
        requires: [
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the vCenter certificates trusted in Orchestrator, and vcfApiToken or vcUsername/vcPassword filled in.',
          'For the fallback script: PowerShell 7 and PowerCLI (VMware.VimAutomation.Core) on the machine that runs it.',
          'VCENTERS, VC_USER and VC_PASSWORD_FILE (a file readable only by the account running the job) in the job’s environment.',
          'Tagging > Assign or Unassign vSphere Tag on the VMs, and read on folders and clusters.',
          'Every Category=Tag the rules set must already exist; a rule whose tag is missing is skipped and reported.',
        ],
        files: {
          ...pkg.files,
          'scripts/tag-rules.json': `${JSON.stringify(rules, null, 2)}\n`,
          'scripts/Tag-Rules.ps1': script,
          'crontab.txt': cron,
          'IMPORT.md': tagsImport(
            `vCenter has no rule-based tagging of its own; the Orchestrator package \`${pkg.packageDir}\` supplies it, on the shared core library: the workflow **Tag VMs from rules** reads the rules from its resource element tag-rules.json and tags through the vCenter REST API. scripts/Tag-Rules.ps1 does the same with PowerCLI from a host.`,
            [
              ...pkg.importSteps,
              { heading: 'Or: the PowerCLI script', lines: ['`pwsh ./scripts/Tag-Rules.ps1` (dry run; it reads scripts/tag-rules.json), then `-Execute`, from a host with PowerCLI; then install the line in crontab.txt with `crontab -e`.'] },
            ],
            [
              'Guest OS rules match the VMware Tools full name (GET /api/vcenter/vm/{vm}/guest/identity) and fall back to the configured guest_OS identifier (for example WINDOWS_2019SERVER_64), which contains "WINDOWS" but not "Linux" for most Linux guests — check a guestos rule against your VMs.',
              'The VCF 9.1 API-token login to vCenter follows davidwzhang.com "VCF 9.1 API Access (4)"; confirm it, or use vcUsername and vcPassword.',
            ],
          ),
        },
        notes: [
          'Name patterns are case-insensitive regular expressions (JavaScript in the workflow, .NET -match in the script); ^prd- also matches PRD-. Keep them to the common subset.',
          'The guest OS comes from VMware Tools when it is running, otherwise from the guest OS the VM was configured with.',
          'On Windows, run it from Task Scheduler as a service account and keep the password file in that account’s profile, or replace the three credential lines with Import-Clixml of a DPAPI-protected credential.',
          'VCF Automation also tags the VMs it deploys, from the template. Rules here fill what nothing else set; they are not a substitute for tagging at deployment.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'tags_compliance',
    platform: PLATFORM,
    label: 'Tag compliance report across every vCenter',
    group: 'Tags — govern',
    description:
      'The read-only check that says whether the standard is being followed: objects missing a required category, values that are not in the standard, one-value categories carrying two values, tags that exist on one vCenter and not another, tags attached to nothing, and categories nobody agreed to. A CSV every run, an optional webhook, and exit 1 above a threshold so the scheduler can alert.',
    inputs: [
      STANDARD_INPUT,
      VCENTERS_INPUT,
      { id: 'max_problems', label: 'Exit 1 above (problems)', control: 'number', default: 50, min: 0, max: 1000000, hint: 'During a rollout set it to where you are, and lower it as you go' },
      { id: 'cross_vcenter', label: 'Compare the catalogue between vCenters', control: 'toggle', default: true },
      { id: 'ignore_categories', label: 'Ignore categories', control: 'text', default: '', hint: 'Comma separated, e.g. categories another product owns' },
      { id: 'exclude_names', label: 'Ignore objects whose name matches', control: 'text', default: '^vCLS', hint: 'A regular expression; system VMs that are never tagged' },
      { id: 'webhook', label: 'Post a summary to', control: 'text', default: '', hint: 'Optional webhook URL' },
      { id: 'hour', label: 'Run daily at (hour, server time)', control: 'number', default: 6, min: 0, max: 23 },
    ],
    automation: (values: BlueprintValues): Automation => {
      const { categories, findings } = parseStandard(str(values, 'standard', DEFAULT_STANDARD));
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const maxProblems = num(values, 'max_problems', 50);
      const cross = bool(values, 'cross_vcenter', true);
      const ignore = str(values, 'ignore_categories', '');
      const exclude = str(values, 'exclude_names', '^vCLS');
      const webhook = str(values, 'webhook', '');
      const hour = num(values, 'hour', 6);
      if (cross && vcenters.length < 2) findings.push(info('tags.compliance.one-vcenter', 'The cross-vCenter comparison needs at least two vCenters; with one it reports nothing.', { source: SRC }));
      if (exclude) {
        try {
          new RegExp(exclude);
        } catch {
          findings.push(error('tags.compliance.exclude-regex', `"${exclude}" is not a valid regular expression.`, { path: 'exclude_names', source: SRC }));
        }
      }
      if (!webhook) findings.push(info('tags.compliance.no-webhook', 'No webhook: the report is a CSV and an exit code, and nobody is told unless whatever runs it alerts on the exit code.', { source: SRC }));

      const checks = [
        '# Every problem in one vCenter, as CSV rows:',
        '#   check, vcenter, object_type, object_id, object_name, category, tag, detail',
        '$std[0].categories as $S',
        '| ($S | map(.name)) as $snames',
        '| $cat[0] as $C',
        '| ($C.categories | map(.name)) as $cnames',
        '| ($C.tags | map({key: .id, value: .}) | from_entries) as $tagById',
        '| ($inv[0] | map({key: (.type + "/" + .id), value: .name}) | from_entries) as $nameOf',
        '| ($asn[0] | map(. + {category: ($tagById[.tag_id].category // "?"), tag: ($tagById[.tag_id].name // "?")})) as $A',
        '| ($A | group_by(.tag_id) | map({key: .[0].tag_id, value: length}) | from_entries) as $uses',
        '| ($A | group_by(.type + "/" + .id) | map({key: (.[0].type + "/" + .[0].id), value: map(.category)}) | from_entries) as $catsOn',
        '| [',
        '    ($C.categories[] | select((.name as $n | $snames | index($n)) == null and (.name as $n | $ign | index($n)) == null)',
        '      | ["category-not-in-standard", $vc, "", "", "", .name, "", "exists in vCenter, not in the standard"]),',
        '    ($S[] | select((.name as $n | $cnames | index($n)) == null)',
        '      | ["category-missing", $vc, "", "", "", .name, "", "in the standard, not in this vCenter"]),',
        '    ($S[] as $s | $C.categories[] | select(.name == $s.name and .cardinality != $s.cardinality)',
        '      | ["cardinality-mismatch", $vc, "", "", "", .name, "", "vCenter says \\(.cardinality), the standard says \\($s.cardinality)"]),',
        '    ($S[] as $s | $C.categories[] | select(.name == $s.name and (.associable_types | length) > 0 and (($s.associable_types - .associable_types) | length) > 0)',
        '      | ["object-types-mismatch", $vc, "", "", "", .name, "", "cannot go on \\(($s.associable_types - .associable_types) | join(" "))"]),',
        '    ($C.tags[] as $t | $S[] | select(.name == $t.category and (.free_text | not) and ((.values | index($t.name)) == null))',
        '      | ["value-not-in-standard", $vc, "", "", "", $t.category, $t.name, "on \\($uses[$t.id] // 0) object(s)"]),',
        '    ($C.tags[] | select(($uses[.id] // 0) == 0) | select((.category as $n | $ign | index($n)) == null)',
        '      | . as $t | select(any($S[]; .name == $t.category and (.values | index($t.name)) != null) | not)',
        '      | ["tag-unused", $vc, "", "", "", .category, .name, "attached to nothing"]),',
        '    ($A | group_by([.type, .id, .category])[] | select(length > 1) | . as $g | .[0] as $f',
        '      | select(any($S[]; .name == $f.category and .cardinality == "SINGLE"))',
        '      | ["cardinality-violation", $vc, $f.type, $f.id, "", $f.category, ($g | map(.tag) | join(" ")), "\\($g | length) values in a one-value category"]),',
        '    ($S[] as $s | $s.required_on[] as $rt | $inv[0][] | select(.type == $rt)',
        '      | select(($excl == "") or ((.name | test($excl)) | not))',
        '      | select((($catsOn[.type + "/" + .id] // []) | index($s.name)) == null)',
        '      | ["missing-required", $vc, .type, .id, "", $s.name, "", "no \\($s.name) tag"])',
        '  ]',
        '| .[] | .[4] = ($nameOf[.[2] + "/" + .[3]] // "") | @csv',
      ];

      const script = [
        '#!/usr/bin/env bash',
        '# Tag compliance: every vCenter in VCENTERS, against tag-standard.json.',
        '#',
        '# Reads only. Writes reports/tag-compliance-<run>.csv and exits 1 when there',
        '# are more than MAX_PROBLEMS problems, so a scheduler can alert on the exit',
        '# code rather than on somebody reading the CSV.',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        vcentersLine(vcenters),
        `MAX_PROBLEMS="\${MAX_PROBLEMS:-${maxProblems}}"`,
        `IGNORE_CATEGORIES="\${IGNORE_CATEGORIES:-${ignore}}"`,
        `EXCLUDE_NAMES="\${EXCLUDE_NAMES:-${exclude}}"`,
        `WEBHOOK="\${WEBHOOK:-${webhook}}"`,
        `CROSS_VCENTER="\${CROSS_VCENTER:-${cross ? 1 : 0}}"`,
        'OUT_DIR="${OUT_DIR:-reports}"',
        'STANDARD=tag-standard.json',
        '',
        ...vcLib(),
        '',
        'mkdir -p "$OUT_DIR"',
        'RUN=$(date -u +%Y%m%dT%H%M%SZ)',
        'REPORT="$OUT_DIR/tag-compliance-${RUN}.csv"',
        'echo "check,vcenter,object_type,object_id,object_name,category,tag,detail" > "$REPORT"',
        'IGN=$(jq -cn --arg s "$IGNORE_CATEGORIES" \'$s | split(",") | map(gsub("^\\\\s+|\\\\s+$"; "")) | map(select(length > 0))\')',
        '',
        "cat > \"$WORK/checks.jq\" <<'JQ'",
        ...checks,
        'JQ',
        '',
        ': > "$WORK/catalogues.jsonl"',
        'for host in ${VCENTERS//,/ }; do',
        '  echo "reading $host ..." >&2',
        '  vc_login "$host"',
        '  load_catalogue "$host" "$WORK/$host.cat.json"',
        '  load_associations "$host" "$WORK/$host.cat.json" "$WORK/$host.asn.json"',
        '  load_inventory "$host" "$WORK/$host.inv.json"',
        '  jq -rn --arg vc "$host" --argjson ign "$IGN" --arg excl "$EXCLUDE_NAMES" \\',
        '    --slurpfile std "$STANDARD" --slurpfile cat "$WORK/$host.cat.json" \\',
        '    --slurpfile asn "$WORK/$host.asn.json" --slurpfile inv "$WORK/$host.inv.json" \\',
        '    -f "$WORK/checks.jq" >> "$REPORT"',
        '  jq -c --arg vc "$host" \'{vc: $vc, tags: [.tags[] | {c: .category, t: .name}]}\' "$WORK/$host.cat.json" >> "$WORK/catalogues.jsonl"',
        'done',
        '',
        '# A tag that exists on some vCenters and not others: a VM vMotioned or',
        '# restored across them loses it, and a group keyed on it covers half the fleet.',
        'if (( CROSS_VCENTER )); then',
        '  jq -rs --slurpfile std "$STANDARD" \'',
        '    ($std[0].categories | map(.name)) as $snames',
        '    | map(.vc) as $all',
        '    | [.[] | .vc as $v | .tags[] | . + {vc: $v}] | group_by([.c, .t])[]',
        '    | map(.vc) as $has',
        '    | select(($has | length) < ($all | length))',
        '    | .[0] as $x | select(($snames | index($x.c)) != null)',
        '    | ($all - $has)[] as $missing',
        '    | ["missing-in-vcenter", $missing, "", "", "", $x.c, $x.t, "exists on \\($has | join(" "))"] | @csv\' "$WORK/catalogues.jsonl" >> "$REPORT"',
        'fi',
        '',
        'TOTAL=$(( $(wc -l < "$REPORT") - 1 ))',
        'COUNTS=$(tail -n +2 "$REPORT" | jq -Rn \'[inputs | split(",")[0] | fromjson] | group_by(.) | map({key: .[0], value: length}) | from_entries\')',
        'echo "Tag compliance: $TOTAL problem(s) (threshold $MAX_PROBLEMS)"',
        'jq -r \'to_entries[] | "  \\(.value)\\t\\(.key)"\' <<<"$COUNTS"',
        'echo "Report: $REPORT"',
        '',
        'if [[ -n "$WEBHOOK" ]]; then',
        '  jq -n --arg report "$REPORT" --argjson counts "$COUNTS" --argjson total "$TOTAL" --argjson max "$MAX_PROBLEMS" \\',
        '    \'{source: "archtoolkit-tag-compliance", total: $total, threshold: $max, counts: $counts, report: $report}\' |',
        '    curl -sS -X POST "$WEBHOOK" -H "Content-Type: application/json" --data-binary @- >/dev/null || echo "webhook post failed" >&2',
        'fi',
        '',
        '(( TOTAL <= MAX_PROBLEMS ))',
        '',
      ].join('\n');

      // The same report as one Orchestrator package: the workflow, its actions,
      // the settings and the standard, on top of the shared core library.
      const pkg = toPackage({
        packageName: TAGS_COMPLIANCE_PACKAGE,
        description: `Tag compliance report: ${vcenters.length} vCenter(s) against ${categories.length} tag categories. Reads only. Generated by ArchToolKit.`,
        categoryPath: 'ArchToolKit/Tags',
        workflow: {
          name: 'Tag compliance report',
          description: 'Reads the tag catalogue, every tag assignment and the inventory of every vCenter in the settings, and reports every departure from the tag standard. Changes nothing. Fails above the threshold, so a schedule shows it.',
          inputs: [],
          outputs: [
            { name: 'problemCount', type: 'number', description: 'Problems found' },
            { name: 'reportCsv', type: 'string', description: 'check,vcenter,object_type,object_id,object_name,category,tag,detail' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: TAGS_COMPLIANCE_WORKFLOW,
        },
        actions: TAGS_COMPLIANCE_ACTIONS,
        config: {
          name: 'Tag compliance',
          description: 'Settings of the Tag compliance report workflow. Fill the secret for your version after import: vcfApiToken (VCF 9.1) or vcPassword (8.x and 9.0).',
          attributes: [
            { name: 'vcenters', type: 'Array/string', value: vcenters, description: 'Every vCenter to read' },
            { name: 'vcfIdbHost', type: 'string', value: '', description: 'VCF 9.1: the VCF Identity Broker host' },
            { name: 'vcfApiToken', type: 'SecureString', description: 'VCF 9.1: an API token issued to an API client in VCF Operations with read access to the vCenters' },
            { name: 'vcUsername', type: 'string', value: '', description: '8.x and 9.0: a read-only account, user@domain, the same on every vCenter' },
            { name: 'vcPassword', type: 'SecureString', description: '8.x and 9.0: its password' },
            { name: 'maxProblems', type: 'number', value: maxProblems, description: 'The run fails above this many problems' },
            { name: 'failAboveThreshold', type: 'boolean', value: true, description: 'Fail the run above maxProblems, so a schedule shows it' },
            { name: 'crossVcenter', type: 'boolean', value: cross, description: 'Compare the catalogue between vCenters' },
            { name: 'ignoreCategories', type: 'Array/string', value: listOf(ignore), description: 'Categories another product owns' },
            { name: 'excludeNames', type: 'string', value: exclude, description: 'Regular expression: objects never required to carry a tag' },
            { name: 'webhook', type: 'string', value: webhook, description: 'Optional: where the summary is posted' },
          ],
        },
        resources: [{ name: 'tag-standard.json', content: standardJson(categories) }],
      });

      return {
        platform: PLATFORM,
        title: `Tag compliance — ${vcenters.length} vCenter(s) against ${categories.length} categories`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Daily at ${String(hour).padStart(2, '0')}:00, from the Orchestrator scheduler (or cron, with the fallback script); also worth running before and after any bulk tagging change.`, worstCase: 'once a day; each run reads every tag, every assignment and every VM once' },
        scope: {
          what: `Reads the tag catalogue, every tag assignment, and the inventory of ${vcenters.join(', ')}. Changes nothing.`,
          decidedBy: [
            'vcenters in the configuration element Tag compliance (VCENTERS for the script).',
            'The resource element tag-standard.json (scripts/tag-standard.json for the script): which categories exist, their values and cardinality, and which object types must carry each.',
            `ignoreCategories${ignore ? ` (${ignore})` : ''} and excludeNames (${exclude || 'none'}).`,
          ],
          ifWrong: 'A standard that does not match reality reports thousands of problems and gets ignored. Start with the threshold where the estate is and lower it; do not start at zero.',
        },
        guardrails: [
          { rule: 'Reads only: GET and the tagging list-* actions, nothing else', because: 'A compliance report that can change what it reports on stops being evidence.' },
          { rule: `Fails above ${maxProblems} problems (the script exits 1)`, because: 'The scheduler shows a failed run; a report nobody opens is the usual end of a tagging programme.' },
          { rule: 'Secrets are SecureString attributes in Orchestrator, never logged; the script refuses a password file that is not mode 600', because: 'A scheduled job’s credential is the one most often left readable.' },
        ],
        dryRun: ['It is a read. Run the workflow by hand once and read the log (every problem is a PROBLEM line) before scheduling it.'],
        undo: ['Nothing to undo. Delete old reports when you no longer need them.'],
        told: [`The workflow's log and its reportCsv output every run${webhook ? `, a summary to ${webhook}` : ''}, and a failed run above the threshold to whatever scheduled it. The fallback script writes scripts/reports/tag-compliance-<run>.csv and exits 1 instead.`],
        requires: [...VC_REQUIRES, 'Read-only access to every object and read on every tag and category — a read-only role at the vCenter root is enough.', 'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the vCenter certificates trusted in Orchestrator.'],
        files: {
          'IMPORT.md': tagsImport(
            `One Orchestrator package does the whole job: the workflow **Tag compliance report** with its actions, its settings and the tag standard, on the shared ArchToolKit core library — \`${pkg.packageDir}\` and \`import/com.archtoolkit.core.package\`, each built and signed as a .package in the .zip download. The bash script under scripts/ does the same from a Linux host, if you would rather not use Orchestrator.`,
            [
              ...pkg.importSteps,
              { heading: 'Or: the script, from a Linux host', lines: ['`./scripts/tag-compliance.sh` (it reads scripts/tag-standard.json beside it and writes scripts/reports/), then install the line in crontab.txt with `crontab -e`. It needs bash 4, curl and jq.'] },
            ],
            ['The VCF 9.1 API-token login to vCenter (identity broker token, exchanged for a SAML token, presented as SIGN) follows davidwzhang.com "VCF 9.1 API Access (4)"; confirm it against your vCenter, or use vcUsername and vcPassword.'],
          ),
          ...pkg.files,
          'scripts/tag-standard.json': standardJson(categories),
          'scripts/tag-compliance.sh': script,
          'crontab.txt': [
            '# Tag compliance with the fallback script, daily. No secret here: VCF_API_TOKEN_FILE is a path to a mode-600 file (VC_USER + VC_PASSWORD_FILE on 8.x/9.0).',
            '# With the Orchestrator package, schedule the workflow in Orchestrator instead and leave this out.',
            `0 ${hour} * * * cd /opt/archtoolkit/tag-compliance && ${vcScheduledEnv(vcenters)} ./scripts/tag-compliance.sh >> scripts/reports/tag-compliance.log 2>&1 || echo "tag compliance over threshold" | logger -t archtoolkit`,
            '',
          ].join('\n'),
        },
        notes: [
          'VMs are read host by host (GET /api/vcenter/vm?hosts=...) because the VM list call refuses more than its limit rather than paging. A VM on a disconnected host is missed until the host is back.',
          'The tag associations are read with list-attached-objects-on-tags, which filters by the reader’s privileges: an account that cannot see an object cannot see its tags either, and the report will call that object untagged.',
          'In VCF 9.1 the Tag Assignments page under Manage > Fleet Management > Tags shows the same assignments across the fleet, and POST .../tag-management/resources/query returns them. This script uses the vCenter API so the same report works on vSphere 8.',
          'Checks, by name in the CSV: category-not-in-standard, category-missing, cardinality-mismatch, object-types-mismatch, value-not-in-standard, tag-unused, cardinality-violation, missing-required, missing-in-vcenter.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'tags_sync_control',
    platform: PLATFORM,
    label: 'Import, push or disengage fleet tag management',
    group: 'Tags — govern',
    description:
      'The three moves that decide who owns a tag in VCF 9.1: import a vCenter’s categories into VCF Operations fleet tag management, push centrally-owned categories out to vCenters, or take a vCenter back out of central management for a category (the “disengage” of the 9.1 release). Each is wrapped in an export of the whole fleet catalogue and every assignment before and after, and a diff of the two.',
    inputs: [
      {
        id: 'action',
        label: 'What to do',
        control: 'select',
        options: [
          { value: 'pull', label: 'Import categories and tags from vCenter into VCF Operations' },
          { value: 'push', label: 'Push categories from VCF Operations to vCenter' },
          { value: 'disengage', label: 'Disengage: remove a vCenter from central management of a category' },
          { value: 'export', label: 'Export the fleet catalogue and assignments only' },
        ],
        default: 'pull',
      },
      { id: 'adapters', label: 'vCenter adapter ids', control: 'text', default: '', hint: 'Comma separated; ./scripts/sync-control.sh --list-adapters shows them. Or set FLEET_ADAPTERS' },
      { id: 'categories', label: 'Categories', control: 'text', default: 'Environment, Owner, CostCenter', hint: 'For push and disengage', showWhen: { input: 'action', equals: ['push', 'disengage'] } },
      { id: 'overwrite', label: 'Overwrite category properties in vCenter on push', control: 'toggle', default: false, showWhen: { input: 'action', equals: ['push'] } },
      { id: 'vcenter', label: 'vCenter to disengage', control: 'text', default: 'vc-wld01.example.com', showWhen: { input: 'action', equals: ['disengage'] } },
    ],
    automation: (values: BlueprintValues): Automation => {
      const action = str(values, 'action', 'pull');
      const adapters = listOf(str(values, 'adapters', ''));
      const categories = listOf(str(values, 'categories', 'Environment, Owner, CostCenter'));
      const overwrite = bool(values, 'overwrite', false);
      const vcenter = str(values, 'vcenter', 'vc-wld01.example.com');
      const findings: Finding[] = [];
      if (adapters.length === 0 && action !== 'export' && action !== 'disengage') {
        findings.push(info('tags.sync.adapters-at-runtime', 'No adapter ids given, so the script takes them from FLEET_ADAPTERS when it runs.', { remediation: 'Run ./scripts/sync-control.sh --list-adapters to see them.', source: SRC }));
      }
      if (action === 'push' && categories.length > 20) findings.push(info('tags.sync.push-batches', `${categories.length} categories go out in batches of 20, the interface’s own limit.`, { source: SRC }));
      if (action === 'push' && overwrite) {
        findings.push(warning('tags.sync.overwrite', 'Overwrite replaces the category properties in each vCenter with VCF Operations’ copy.', { remediation: 'It resolves description and property conflicts only; a cardinality or object-type conflict still fails. Push without it first and read the conflicts.', source: SRC }));
      }
      if (action === 'disengage') {
        findings.push(warning('tags.sync.disengage', `Once ${vcenter} is removed from these categories, VCF Operations can no longer unassign their tags there, and nothing keeps that vCenter consistent with the rest of the fleet.`, { remediation: 'Use it for a vCenter being handed to another team or migrated out, not to get round a conflict. Run the compliance report afterwards: this vCenter will drift and it should be visible.', source: SRC }));
      }

      const script = [
        '#!/usr/bin/env bash',
        '# Fleet tag management in VCF Operations 9.1.1+: import, push, disengage, export.',
        '#',
        '#   ./sync-control.sh --list-adapters          vCenter adapter ids',
        '#   ./sync-control.sh export <label>           fleet-inventory-<label>.json',
        '#   ./sync-control.sh pull [--execute]         import categories from each adapter in FLEET_ADAPTERS',
        '#   ./sync-control.sh push [--execute]         push FLEET_CATEGORIES to each adapter in FLEET_ADAPTERS',
        '#   ./sync-control.sh disengage                guided: export, the steps in the interface, export, diff',
        '#',
        '# Every pull and push exports the whole catalogue and every assignment first,',
        '# runs one background task at a time and waits for it, then exports again and',
        '# prints what changed. Without --execute, pull and push only say what they',
        '# would do.',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        `FLEET_ADAPTERS="\${FLEET_ADAPTERS:-${adapters.join(' ')}}"`,
        `FLEET_CATEGORIES="\${FLEET_CATEGORIES:-${categories.join(',')}}"`,
        `OVERWRITE="\${OVERWRITE:-${overwrite ? 'true' : 'false'}}"`,
        'MODE="${1:-}"; shift || true',
        'DRY_RUN=1; LABEL=""',
        'for arg in "$@"; do',
        '  case "$arg" in',
        '    --execute) DRY_RUN=0 ;;',
        '    -*) echo "unknown argument: $arg" >&2; exit 2 ;;',
        '    *) LABEL="$arg" ;;',
        '  esac',
        'done',
        '',
        ...fleetLib(),
        '',
        'RUN=$(date -u +%Y%m%dT%H%M%SZ)',
        'mkdir -p exports',
        '',
        '# What changed between two exports.',
        'diff_exports() {',
        '  jq -rn --slurpfile a "$1" --slurpfile b "$2" \'',
        '    ($a[0].categories | map(.name)) as $ca | ($b[0].categories | map(.name)) as $cb',
        '    | ($a[0].tags | map("\\(.categoryName)/\\(.name)")) as $ta | ($b[0].tags | map("\\(.categoryName)/\\(.name)")) as $tb',
        '    | ($a[0].assignments | map({key: .resourceId, value: .tags}) | from_entries) as $xa',
        '    | ($b[0].assignments | map({key: .resourceId, value: .tags}) | from_entries) as $xb',
        '    | "categories added:   \\(($cb - $ca) | join(", "))",',
        '      "categories removed: \\(($ca - $cb) | join(", "))",',
        '      "tags added:         \\(($tb - $ta) | length)",',
        '      "tags removed:       \\(($ta - $tb) | length)",',
        '      "objects whose tags changed: \\([($xa + $xb) | keys[] | select($xa[.] != $xb[.])] | length)"\'',
        '}',
        '',
        '# Category names to ids, one per line. Runs inside $(...), where set -e does',
        '# not apply, so every failure returns at once rather than carrying on with',
        '# the next name; the caller also checks one id came back per name.',
        'category_ids() {',
        '  local name',
        '  for name in ${FLEET_CATEGORIES//,/ }; do',
        '    jq -n --arg n "$name" \'{names: [$n]}\' | fleet POST "/categories/query?page=0&pageSize=1000" --data-binary @- |',
        '      jq -r --arg n "$name" \'[.categories[]? | select(.name == $n) | .id] | first // error("no category named \\($n) in fleet tag management")\' || return 1',
        '  done',
        '}',
        '',
        'case "$MODE" in',
        '  --list-adapters)',
        '    # VERIFY: the suite API adapter list accepting the fleet Bearer token on your',
        '    # release. The Import dialog under Fleet Management > Tags lists the same vCenters.',
        '    curl -sS -f "https://${VCFOPS_HOST}/suite-api/api/adapters?adapterKindKey=VMWARE" \\',
        `      -H "${authHeader('vcf-fleet')}" -H "Accept: application/json" |`,
        '      jq -r \'.adapterInstancesInfoDto[]? | [.id, .resourceKey.name] | @tsv\'',
        '    ;;',
        '',
        '  export)',
        '    out="exports/fleet-inventory-${LABEL:-$RUN}.json"',
        '    fleet_export "$out"',
        '    echo "wrote $out: $(jq \'.categories | length\' "$out") categories, $(jq \'.tags | length\' "$out") tags, $(jq \'.assignments | length\' "$out") tagged objects"',
        '    ;;',
        '',
        '  pull|push)',
        '    : "${FLEET_ADAPTERS:?set FLEET_ADAPTERS to the vCenter adapter ids (--list-adapters)}"',
        '    if [[ "$MODE" == push ]]; then',
        '      # Every name must resolve, or nothing is pushed.',
        '      ids_text=$(category_ids) || { echo "Refusing to push: not every name in FLEET_CATEGORIES is a category in fleet tag management. Nothing was pushed." >&2; exit 1; }',
        '      mapfile -t IDS < <(grep -v \'^$\' <<<"$ids_text" || true)',
        '      NAMES=(${FLEET_CATEGORIES//,/ })',
        '      if (( ${#IDS[@]} == 0 || ${#IDS[@]} != ${#NAMES[@]} )); then',
        '        echo "Refusing to push: ${#NAMES[@]} categories named (${FLEET_CATEGORIES}) but ${#IDS[@]} ids found. Nothing was pushed." >&2',
        '        exit 1',
        '      fi',
        '      echo "push ${#IDS[@]} categories (${FLEET_CATEGORIES}) with overwrite=${OVERWRITE}"',
        '    fi',
        '    if (( DRY_RUN )); then',
        '      for adapter in ${FLEET_ADAPTERS//,/ }; do echo "DRY RUN: would $MODE for adapter $adapter"; done',
        '      echo "Nothing was changed. Re-run with --execute."',
        '      exit 0',
        '    fi',
        '    before="exports/fleet-inventory-${RUN}-before.json"',
        '    fleet_export "$before"',
        '    echo "before: $before"',
        '    FAILED=0',
        '    for adapter in ${FLEET_ADAPTERS//,/ }; do',
        '      if [[ "$MODE" == pull ]]; then',
        '        task=$(fleet POST "/adapters/${adapter}/categories/pull" -d \'\' | jq -r .taskId)',
        '        wait_task "$task" || FAILED=$((FAILED + 1))',
        '      else',
        '        for (( i = 0; i < ${#IDS[@]}; i += 20 )); do',
        '          task=$(printf \'%s\\n\' "${IDS[@]:i:20}" | jq -R . | jq -sc --argjson o "$OVERWRITE" \'{categoryIds: ., overwrite: $o}\' |',
        '            fleet POST "/adapters/${adapter}/categories/push" --data-binary @- | jq -r .taskId)',
        '          wait_task "$task" || FAILED=$((FAILED + 1))',
        '        done',
        '      fi',
        '    done',
        '    after="exports/fleet-inventory-${RUN}-after.json"',
        '    fleet_export "$after"',
        '    echo "after: $after"',
        '    diff_exports "$before" "$after"',
        '    (( FAILED == 0 )) || { echo "$FAILED task(s) failed. Conflicts are listed under Manage > Fleet Management > Tags (View Conflict Details)." >&2; exit 1; }',
        '    ;;',
        '',
        '  disengage)',
        '    # There is no disengage call in the 9.1.1 Tag Management API. This records',
        '    # the state either side of doing it in the interface.',
        '    [[ -t 0 ]] || { echo "disengage is interactive: run it from a terminal." >&2; exit 2; }',
        '    before="exports/fleet-inventory-${RUN}-before-disengage.json"',
        '    fleet_export "$before"',
        '    echo "before: $before"',
        '    cat <<STEPS',
        '',
        'In VCF Operations, for each category in: ${FLEET_CATEGORIES}',
        '  1. Manage > Fleet Management > Tags, Tag Definitions tab.',
        '  2. Click the double arrow next to the category, then the Available In tab.',
        `  3. Tick ${vcenter}, click Remove, tick the acknowledgment, click Remove.`,
        '     (On builds that label it "Disengage", it is the same action.)',
        '',
        'Afterwards VCF Operations shows a lock next to those tags for that vCenter and',
        'can no longer unassign them there. Deleting the category in VCF Operations will',
        'NOT delete it from that vCenter.',
        'STEPS',
        '    read -r -p "Type DONE when every category has been removed, or anything else to stop: " answer',
        '    [[ "$answer" == DONE ]] || { echo "Stopped. Nothing was recorded after $before."; exit 1; }',
        '    after="exports/fleet-inventory-${RUN}-after-disengage.json"',
        '    fleet_export "$after"',
        '    echo "after: $after"',
        '    diff_exports "$before" "$after"',
        '    ;;',
        '',
        '  *)',
        '    sed -n \'2,12p\' "$0"',
        '    exit 2',
        '    ;;',
        'esac',
        '',
      ].join('\n');

      const runbook = [
        `# Fleet tag management — ${action === 'pull' ? 'import from vCenter' : action === 'push' ? 'push to vCenter' : action === 'disengage' ? 'disengage a vCenter' : 'export'}`,
        '',
        'Who owns a tag decides where it may be changed. In VCF 9.1, a category that VCF Operations',
        'manages is created and edited centrally, pushed to each vCenter, and its assignments show and',
        'propagate in both directions. A category a vCenter owns on its own is invisible to that.',
        '',
        '## Before',
        '',
        '1. `./scripts/sync-control.sh export baseline` and keep the file with the change record.',
        '2. Run the tag compliance report, so the drift you are about to fix — or create — is on record.',
        '3. Check nobody else is importing: the interface refuses a second import from the same domain while one is running, and warns you.',
        '',
        '## Doing it',
        '',
        ...(action === 'pull'
          ? [
              'Interface: Manage > Fleet Management > Tags > Import, choose the VCF domain, Import. If some categories cannot be imported, open View Conflict Details from the banner — the banner cannot be reopened once dismissed.',
              '',
              'API: the workflow Fleet tag sync control with action pull, or `./scripts/sync-control.sh pull --execute` — POST .../tag-management/adapters/{adapterId}/categories/pull per adapter, then GET .../tasks/{taskId} until SUCCESS or FAILED.',
              '',
              'Requirements from the documentation: the vCenter is 9.0 or later, licensed for VCF 9, integrated with this VCF Operations, and you hold Tags Manage.',
            ]
          : action === 'push'
            ? [
                'Interface: Manage > Fleet Management > Tags, tick up to 20 categories, Push Categories, choose VCF Domain vCenter Instances or a Tag Group custom group, optionally tick overwrite, Push.',
                '',
                'API: the workflow Fleet tag sync control with action push, or `./scripts/sync-control.sh push --execute` — POST .../tag-management/adapters/{adapterId}/categories/push with {categoryIds, overwrite} per adapter, 20 categories at a time.',
                '',
                'Conflicts that fail the push whatever overwrite says: the same category is single in one place and multiple in the other; VCF Operations has fewer object types than the vCenter; the same name has a different id. Resolve them in VCF Operations (widen it to match) or in the vCenter (rename or delete the stray one).',
              ]
            : action === 'disengage'
              ? [
                  `Interface only — the 9.1.1 Tag Management API has no call for it. \`./scripts/sync-control.sh disengage\` exports before, prints these steps, waits, and exports after.`,
                  '',
                  `For each of ${categories.join(', ')}: Manage > Fleet Management > Tags > Tag Definitions > the double arrow next to the category > Available In > tick ${vcenter} > Remove > tick the acknowledgment > Remove.`,
                  '',
                  'What it means, from the documentation: VCF Operations can no longer unassign tags of that category on objects in that vCenter (a lock icon shows it); deleting the tag or category in VCF Operations leaves it in that vCenter. The 9.1 release describes this as disengaging tag management: synchronisation stops for those tags, and the metadata stays where it is.',
                ]
              : ['`./scripts/sync-control.sh export <label>` writes every category, tag and tagged resource to exports/fleet-inventory-<label>.json, sorted so two exports diff cleanly.']),
        '',
        '## After',
        '',
        '1. `./scripts/sync-control.sh export after` (pull and push do this themselves) and read the diff.',
        '2. Run the tag compliance report again.',
        '',
        '## Undo',
        '',
        ...(action === 'pull'
          ? ['An import makes VCF Operations manage the category for that vCenter. To hand it back, disengage the vCenter from the category (this blueprint, action disengage). Deleting the imported category centrally does not delete it from the vCenter, and cannot be done while its tags are assigned.']
          : action === 'push'
            ? ['A pushed category now exists in the vCenter. To take it back out, delete it in that vCenter once nothing there carries its tags (DELETE /api/cis/tagging/tag/{id}, then /api/cis/tagging/category/{id}), or disengage the vCenter from it and leave it be.']
            : action === 'disengage'
              ? ['Documented: VCF Operations takes the category back as soon as you perform any tag task for it on that vCenter again — assign a tag, push the category, or import from the vCenter.']
              : ['An export changes nothing.']),
        '',
      ].join('\n');

      const pkg = toPackage({
        packageName: 'com.archtoolkit.tags.sync_control',
        description: `Fleet tag management in VCF Operations 9.1.1: ${action} (import from vCenter, push to vCenter, export; disengage records the state and says the steps), wrapped in an export before and after. Generated by ArchToolKit.`,
        categoryPath: 'ArchToolKit/Tags/Fleet sync',
        workflow: {
          name: 'Fleet tag sync control',
          description: 'Pull (import categories and tags from each vCenter adapter), push (the named categories to each adapter, 20 a task) or export the fleet catalogue and every assignment, through /suite-api/api/fleet-management/tag-management. Pull and push export before and after and diff; one background task at a time, each waited for. Disengage has no API in 9.1.1: the workflow exports and logs the interface steps. A dry run until dryRun is set to false in the configuration element.',
          inputs: [
            { name: 'dryRun', type: 'boolean', description: 'true: say what would be pulled or pushed, change nothing' },
            { name: 'action', type: 'string', description: 'pull, push, export or disengage; empty: the action setting' },
          ],
          outputs: [
            { name: 'beforeJson', type: 'string', description: 'The export before a pull or push (or before a disengage)' },
            { name: 'afterJson', type: 'string', description: 'The export after, or the export itself' },
            { name: 'diff', type: 'string', description: 'What changed between the two' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: SYNC_WORKFLOW,
        },
        actions: fleetActionsIn('com.archtoolkit.tags.sync_control'),
        config: {
          name: 'Fleet tag sync',
          description: 'Settings of the Fleet tag sync control workflow. Fill vcfApiToken after import: an API token of an API client with Tags Manage (tag_management.manage) and Tags View.',
          attributes: [
            { name: 'action', type: 'string', value: action, description: 'pull, push, export or disengage, when the input is empty' },
            { name: 'opsHost', type: 'string', value: '', description: 'VCF Operations 9.1.1 host' },
            { name: 'vcfIdbHost', type: 'string', value: '', description: 'The VCF Identity Broker host' },
            { name: 'vcfApiToken', type: 'SecureString', description: 'An API token issued to an API client in VCF Operations' },
            { name: 'adapters', type: 'Array/string', value: adapters, description: 'The VCF Operations adapter ids of the vCenters, one per vCenter' },
            { name: 'categories', type: 'Array/string', value: categories, description: 'Push and disengage: the categories, by exact name' },
            { name: 'overwrite', type: 'boolean', value: overwrite, description: 'Push: replace the category properties in vCenter with VCF Operations’ copy' },
            { name: 'vcenter', type: 'string', value: vcenter, description: 'Disengage: the vCenter to take out of central management' },
            { name: 'taskPolls', type: 'number', value: 180, description: 'How many times to poll a task, 10 seconds apart, before giving up' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is pulled or pushed while this is true' },
            { name: 'cap', type: 'number', value: Math.max(10, adapters.length) * Math.max(1, Math.ceil(categories.length / 20)), description: 'The most pull or push tasks one run may start' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
      });

      const verb = action === 'pull' ? 'Import vCenter tags into fleet tag management' : action === 'push' ? `Push ${categories.join(', ')} to vCenter` : action === 'disengage' ? `Disengage ${vcenter} from ${categories.join(', ')}` : 'Export the fleet tag catalogue';
      return {
        platform: PLATFORM,
        title: verb,
        effect: action === 'export' ? 'read' : 'reversible',
        trigger: { kind: 'manual', detail: action === 'export' ? 'An engineer runs it before and after any tag change, or nightly as evidence.' : 'An engineer runs it as a planned change, with the before export attached to the record.' },
        scope: {
          what:
            action === 'pull'
              ? 'Every category and tag in the vCenters behind the adapters in FLEET_ADAPTERS, copied into VCF Operations fleet tag management.'
              : action === 'push'
                ? `The categories ${categories.join(', ')} and all their tags, created or updated in the vCenters behind FLEET_ADAPTERS.`
                : action === 'disengage'
                  ? `Central management of ${categories.join(', ')} on ${vcenter} only. The tags and their assignments stay where they are.`
                  : 'Reads the whole fleet catalogue and every tagged resource.',
          decidedBy: [
            'FLEET_ADAPTERS: VCF Operations adapter ids, one per vCenter.',
            ...(action === 'push' || action === 'disengage' ? ['FLEET_CATEGORIES, resolved to ids by exact name.'] : []),
            ...(action === 'pull' ? ['Everything in each vCenter’s catalogue: an import is not selective.'] : []),
            ...(action === 'push' ? [`overwrite=${overwrite}: whether vCenter’s properties for those categories are replaced.`] : []),
          ],
          ifWrong:
            action === 'pull'
              ? 'A vCenter full of ad-hoc tags becomes the fleet’s catalogue, and pushes from then on spread them. Run the compliance report against it before importing.'
              : action === 'push'
                ? 'A category pushed to the wrong vCenter appears there for every administrator to use. Cheap to remove while unassigned, expensive once someone has used it.'
                : action === 'disengage'
                  ? 'That vCenter drifts from the fleet standard with nothing reporting it except the compliance report.'
                  : 'Nothing: it reads.',
        },
        guardrails: [
          { rule: 'Pull and push export the whole catalogue and every assignment first, and stop if that fails', because: 'The before export is the only record of what central management looked like; without it there is nothing to diff or restore from.' },
          { rule: 'One background task at a time, waited for until SUCCESS or FAILED', because: 'The platform refuses simultaneous imports, and overlapping pushes to one vCenter fail on each other’s conflicts.' },
          ...(action === 'push' ? [{ rule: `Pushes at most 20 categories per task, overwrite=${overwrite}`, because: 'Twenty is the interface’s own limit; overwrite off means a conflict fails loudly instead of silently rewriting vCenter.' }] : []),
          ...(action === 'disengage' ? [{ rule: 'Disengage is done in the interface, which requires ticking an acknowledgment; the script only records either side', because: 'There is no API for it in 9.1.1, and a step that stops central management should need a person anyway.' }] : []),
          { rule: 'Nothing acts until dryRun is set to false in the configuration element (the script: without --execute)', because: 'The dry run names every adapter and category it would touch.' },
          { rule: 'Push refuses unless every category name resolves to exactly one category, and pushes nothing then', because: 'A push of half the list is a fleet in two states.' },
        ],
        dryRun: [
          action === 'disengage'
            ? 'Run the workflow with action export (or ./scripts/sync-control.sh export baseline), then read which categories and tagged objects the vCenter has before touching anything.'
            : `The workflow Fleet tag sync control is a dry run until dryRun is set to false: it logs "DRY RUN: would …" for every task it would start. ./scripts/sync-control.sh ${action === 'export' ? 'export baseline' : action} without --execute does the same.`,
        ],
        undo: [
          action === 'pull'
            ? 'Disengage the vCenter from the imported categories (this blueprint, action disengage) to hand them back. The before export records what fleet management held.'
            : action === 'push'
              ? 'Delete the pushed category from that vCenter once nothing carries its tags, or disengage the vCenter from it.'
              : action === 'disengage'
                ? 'Any tag task for the category on that vCenter — assign, push, or import — puts it back under VCF Operations management (documented).'
                : 'Nothing to undo.',
        ],
        told: ['The workflow’s beforeJson, afterJson and diff outputs and its audit record (posted to the webhook if set); with the script, scripts/exports/fleet-inventory-<run>-before.json and -after.json and the printed diff. Attach them to the change record. Task results and conflicts also show under Manage > Fleet Management > Tags, until the banner is dismissed.'],
        requires: [
          'VCF Operations 9.1.1 or later for the API (9.1 for disengage in the interface), with the vCenters integrated and at 9.0 or later.',
          'An API client in VCF Operations with Tags Manage (tag_management.manage) and Tags View, its API token in vcfApiToken (VCF_API_TOKEN_FILE for the script), and vcfIdbHost (VCF_IDB_HOST) set to the VCF Identity Broker.',
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the identity broker and VCF Operations certificates trusted in Orchestrator.',
          'For push: vSphere Tagging privileges on the target vCenters for the account VCF Operations uses.',
        ],
        files: {
          'IMPORT.md': tagsImport(
            `No tag file is imported: the Orchestrator package \`${pkg.packageDir}\` (on the shared core library) calls the 9.1.1 fleet tag-management API — import from vCenter, push, export — with the workflow **Fleet tag sync control**. scripts/sync-control.sh does the same from a Linux host. RUNBOOK.md is the same in the interface.`,
            [
              ...pkg.importSteps,
              { heading: 'Or: the script', lines: ['`./scripts/sync-control.sh --list-adapters` for the vCenter adapter ids, then the action (`export <label>`, `pull`, `push` or `disengage`) — `pull` and `push` are dry runs until `--execute`. In the interface: Manage > Fleet Management > Tags.'] },
            ],
            [
              'The adapter ids: GET /suite-api/api/adapters?adapterKindKey=VMWARE (sync-control.sh --list-adapters) with the fleet Bearer token; if your release refuses it, the ids are in Administration > Integrations, or in the Import dialog under Fleet Management > Tags.',
              'Disengage (removing a vCenter from a category’s central management) has no call in the 9.1.1 Tag Management API reference; if a later release adds one, the workflow still only records it.',
            ],
          ),
          ...pkg.files,
          'scripts/sync-control.sh': script,
          'RUNBOOK.md': runbook,
          ...(action === 'export'
            ? {
                'crontab.txt': [
                  '# Nightly export of the fleet tag catalogue and every assignment, as evidence and a diff baseline.',
                  '# No secret here: VCF_API_TOKEN_FILE is a path to a mode-600 file.',
                  '# With the Orchestrator package, schedule the workflow with action export instead and leave this out.',
                  `30 0 * * * cd /opt/archtoolkit/tag-sync && ${scheduledEnv('vcf-fleet')} ./scripts/sync-control.sh export nightly-$(date +\\%F) >> scripts/exports/export.log 2>&1`,
                  '',
                ].join('\n'),
              }
            : {}),
        },
        notes: [
          'Endpoints used, from the VCF Operations 9.1.1 API reference (Tag Management): POST .../tag-management/adapters/{adapterId}/categories/pull and /push, POST .../categories/query, POST .../categories/{id}/tags/query, POST .../resources/query, GET .../tasks/{taskId}.',
          'VERIFY: the pull endpoint takes no request body in the reference; if your build asks for one, it will say so in a 400.',
          'Access tokens from the Identity Broker last about half an hour. A pull across many vCenters can outlast one; run it per adapter if it does.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'tags_backup',
    platform: PLATFORM,
    label: 'Back up every tag and assignment to git, and restore them',
    group: 'Tags — govern',
    description:
      'Tags are not in the vCenter file-based backup in any form you can restore one category from, and a deleted category takes every assignment with it. This exports every category, tag and assignment from every vCenter nightly into git — one sorted file per vCenter, so the history is a readable diff — and ships the restore that recreates the catalogue and re-attaches by name, never deleting anything.',
    inputs: [
      VCENTERS_INPUT,
      { id: 'repo', label: 'Git working copy', control: 'text', default: '/var/lib/archtoolkit/tag-backup', hint: 'An existing clone the job can commit to' },
      { id: 'push', label: 'Push after committing', control: 'toggle', default: true },
      { id: 'hour', label: 'Run daily at (hour, server time)', control: 'number', default: 1, min: 0, max: 23 },
      { id: 'max_attach', label: 'Restore refuses more than (attachments)', control: 'number', default: 2000, min: 1, max: 1000000 },
    ],
    automation: (values: BlueprintValues): Automation => {
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const repo = str(values, 'repo', '/var/lib/archtoolkit/tag-backup');
      const push = bool(values, 'push', true);
      const hour = num(values, 'hour', 1);
      const maxAttach = num(values, 'max_attach', 2000);
      const findings: Finding[] = [];
      if (!push) findings.push(warning('tags.backup.no-push', 'The backup is committed but never pushed, so it lives on the same machine as the job.', { remediation: 'A backup on the box that runs it is lost with the box. Push to a remote.', source: SRC }));
      if (!repo.startsWith('/')) findings.push(error('tags.backup.relative-repo', 'The git working copy must be an absolute path; cron runs from the home directory.', { path: 'repo', source: SRC }));

      const backup = [
        '#!/usr/bin/env bash',
        '# Export every category, tag and assignment from every vCenter in VCENTERS',
        '# into a git working copy: <vcenter>.json and <vcenter>-assignments.csv,',
        '# sorted, with no timestamps inside, so a commit only happens when something',
        '# really changed and the diff says what.',
        '#',
        '# Reads the vCenters only. Writes and commits to BACKUP_REPO.',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        vcentersLine(vcenters),
        `BACKUP_REPO="\${BACKUP_REPO:-${repo}}"`,
        `GIT_PUSH="\${GIT_PUSH:-${push ? 1 : 0}}"`,
        '',
        ...vcLib(),
        '',
        'git -C "$BACKUP_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "$BACKUP_REPO is not a git working copy. Clone the backup repository there first." >&2; exit 2; }',
        'RUN=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
        'FAILED=0',
        'for host in ${VCENTERS//,/ }; do',
        '  # Each vCenter in its own subshell, so one that is down does not stop the',
        '  # rest. (Not inside an if: bash ignores set -e there.)',
        '  set +e',
        '  (',
        '    set -e',
        '    vc_login "$host"',
        '    load_catalogue "$host" "$WORK/$host.cat.json"',
        '    load_associations "$host" "$WORK/$host.cat.json" "$WORK/$host.asn.json"',
        '    load_inventory "$host" "$WORK/$host.inv.json"',
        '    jq -n --arg vc "$host" --slurpfile c "$WORK/$host.cat.json" --slurpfile a "$WORK/$host.asn.json" --slurpfile i "$WORK/$host.inv.json" \'',
        '      ($i[0] | map({key: (.type + "/" + .id), value: .name}) | from_entries) as $name',
        '      | ($c[0].tags | map({key: .id, value: .}) | from_entries) as $tag',
        '      | {vcenter: $vc, format: "archtoolkit-tag-backup/1",',
        '         categories: [$c[0].categories[] | {id, name, description, cardinality, associable_types}],',
        '         tags: [$c[0].tags[] | {id, name, description, category}],',
        '         assignments: ([$a[0][] | {category: $tag[.tag_id].category, tag: $tag[.tag_id].name, object_type: .type, object_id: .id,',
        '                        object_name: ($name[.type + "/" + .id] // null)}] | sort_by(.category, .tag, .object_type, .object_name, .object_id))}\' > "$WORK/$host.json"',
        '    # Guardrail: an empty catalogue where there was one is a failed read, not',
        '    # a vCenter with no tags. Committing it would make the backup look like a wipe.',
        '    new=$(jq \'.categories | length\' "$WORK/$host.json")',
        '    old=$(jq \'.categories | length\' "$BACKUP_REPO/$host.json" 2>/dev/null || echo 0)',
        '    if (( new == 0 && old > 0 )); then echo "Refusing to replace $host.json ($old categories) with an empty export." >&2; exit 1; fi',
        '    mv "$WORK/$host.json" "$BACKUP_REPO/$host.json"',
        '    { echo "category,tag,object_type,object_id,object_name"',
        '      jq -r \'.assignments[] | [.category, .tag, .object_type, .object_id, .object_name] | @csv\' "$BACKUP_REPO/$host.json"; } > "$BACKUP_REPO/$host-assignments.csv"',
        '    echo "$host: $new categories, $(jq \'.tags | length\' "$BACKUP_REPO/$host.json") tags, $(jq \'.assignments | length\' "$BACKUP_REPO/$host.json") assignments"',
        '    vc DELETE "$host" /api/session >/dev/null 2>&1 || true',
        '  )',
        '  rc=$?',
        '  set -e',
        '  if (( rc != 0 )); then echo "$host: FAILED, previous backup left as it was" >&2; FAILED=$((FAILED + 1)); fi',
        'done',
        '',
        'git -C "$BACKUP_REPO" add -A',
        'if git -C "$BACKUP_REPO" diff --cached --quiet; then',
        '  echo "No tag changes since the last backup."',
        'else',
        '  git -C "$BACKUP_REPO" diff --cached --stat',
        '  git -C "$BACKUP_REPO" commit -q -m "Tag backup $RUN"',
        '  if (( GIT_PUSH )); then git -C "$BACKUP_REPO" push -q; fi',
        'fi',
        '(( FAILED == 0 ))',
        '',
      ].join('\n');

      const restore = [
        '#!/usr/bin/env bash',
        '# Restore tags from a backup file written by tag-backup.sh.',
        '#',
        '#   ./tag-restore.sh <backup>/<vcenter>.json [target-vcenter]              dry run',
        '#   ./tag-restore.sh <backup>/<vcenter>.json [target-vcenter] --execute',
        '#   ./tag-restore.sh ... --catalogue-only       categories and tags, no assignments',
        '#   ./tag-restore.sh --undo restore-log-<run>.tsv [target-vcenter] --execute',
        '#',
        '# Recreates missing categories and tags by name, then re-attaches assignments',
        '# by object type and name — MoRefs change when a vCenter is rebuilt, names',
        '# usually do not. It never deletes, never detaches, and never changes the value',
        '# of a one-value category that already has one: those are listed as conflicts.',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        `MAX_ATTACH="\${MAX_ATTACH:-${maxAttach}}"`,
        'DRY_RUN=1; CATALOGUE_ONLY=0; UNDO=""; ARGS=()',
        'while (( $# )); do',
        '  case "$1" in',
        '    --execute) DRY_RUN=0 ;;',
        '    --catalogue-only) CATALOGUE_ONLY=1 ;;',
        '    --undo) UNDO="${2:?--undo needs a restore log}"; shift ;;',
        '    -*) echo "unknown argument: $1" >&2; exit 2 ;;',
        '    *) ARGS+=("$1") ;;',
        '  esac',
        '  shift',
        'done',
        '',
        ...vcLib(),
        '',
        'RUN=$(date -u +%Y%m%dT%H%M%SZ)',
        '',
        'if [[ -n "$UNDO" ]]; then',
        '  host="${ARGS[0]:?give the vCenter the restore was run against}"',
        '  vc_login "$host"',
        '  n=0',
        '  while IFS=$\'\\t\' read -r action category tag tid otype oid oname current; do',
        '    [[ "$action" == attach ]] || continue',
        '    n=$((n + 1))',
        '    if (( DRY_RUN )); then echo "DRY RUN: would detach $category=$tag from $oname"; continue; fi',
        '    detach_tag "$host" "$tid" "$otype" "$oid" && echo "detached $category=$tag from $oname"',
        '  done < "$UNDO"',
        '  (( DRY_RUN )) && echo "DRY RUN: $n attachment(s) would be removed. Re-run with --execute."',
        '  exit 0',
        'fi',
        '',
        'FILE="${ARGS[0]:?give the backup file, e.g. tag-backup/vc-wld01.example.com.json}"',
        'jq -e \'.format == "archtoolkit-tag-backup/1"\' "$FILE" >/dev/null || { echo "$FILE is not a tag-backup.sh export" >&2; exit 2; }',
        'host="${ARGS[1]:-$(jq -r .vcenter "$FILE")}"',
        'echo "Restoring $(jq -r .vcenter "$FILE") backup into $host"',
        'vc_login "$host"',
        'load_catalogue "$host" "$WORK/cat.json"',
        '',
        '# 1. Categories, by exact name.',
        'while read -r cat; do',
        '  name=$(jq -r .name <<<"$cat")',
        '  existing=$(jq -c --arg n "$name" \'[.categories[] | select(.name == $n)] | first // empty\' "$WORK/cat.json")',
        '  if [[ -n "$existing" ]]; then',
        '    [[ "$(jq -r .cardinality <<<"$existing")" != "$(jq -r .cardinality <<<"$cat")" ]] && echo "DRIFT category $name: cardinality differs from the backup. Left as it is."',
        '    continue',
        '  fi',
        '  if (( DRY_RUN )); then echo "WOULD create category $name"; continue; fi',
        '  jq -c \'{name, description, cardinality, associable_types}\' <<<"$cat" | vc POST "$host" /api/cis/tagging/category --data-binary @- >/dev/null',
        '  echo "created category $name"',
        'done < <(jq -c \'.categories[]\' "$FILE")',
        '(( DRY_RUN )) || load_catalogue "$host" "$WORK/cat.json"',
        '',
        '# 2. Tags, by exact name within the category.',
        'while read -r t; do',
        '  cname=$(jq -r .category <<<"$t"); tname=$(jq -r .name <<<"$t")',
        '  jq -e --arg c "$cname" --arg n "$tname" \'any(.tags[]; .category == $c and .name == $n)\' "$WORK/cat.json" >/dev/null && continue',
        '  cid=$(jq -r --arg c "$cname" \'[.categories[] | select(.name == $c) | .id] | first // empty\' "$WORK/cat.json")',
        '  if (( DRY_RUN )) || [[ -z "$cid" ]]; then echo "WOULD create tag $cname=$tname"; continue; fi',
        '  jq -c --arg c "$cid" \'{name, description, category_id: $c}\' <<<"$t" | vc POST "$host" /api/cis/tagging/tag --data-binary @- >/dev/null',
        '  echo "created tag $cname=$tname"',
        'done < <(jq -c \'.tags[]\' "$FILE")',
        '(( DRY_RUN )) || load_catalogue "$host" "$WORK/cat.json"',
        '(( CATALOGUE_ONLY )) && { echo "Catalogue done; assignments skipped (--catalogue-only)."; exit 0; }',
        '',
        '# 3. Assignments, by object type and name.',
        'load_inventory "$host" "$WORK/inv.json"',
        'load_associations "$host" "$WORK/cat.json" "$WORK/asn.json"',
        'LOG="restore-log-${RUN}.tsv"',
        'jq -r --slurpfile e "$FILE" --slurpfile inv "$WORK/inv.json" --slurpfile asn "$WORK/asn.json" \'',
        '  (.tags | map({key: (.category + "\\u001f" + .name), value: .id}) | from_entries) as $tagId',
        '  | (.tags | map({key: .id, value: .}) | from_entries) as $tagById',
        '  | (.categories | map({key: .name, value: .cardinality}) | from_entries) as $card',
        '  | ($inv[0] | map({key: (.type + "/" + .id), value: .name}) | from_entries) as $nameById',
        '  | ($inv[0] | group_by([.type, .name]) | map({key: (.[0].type + "/" + .[0].name), value: map(.id)}) | from_entries) as $idsByName',
        '  | ($asn[0] | group_by([.type, .id]) | map({key: (.[0].type + "/" + .[0].id), value: map(.tag_id)}) | from_entries) as $has',
        '  | $e[0].assignments[] | . as $x',
        '  | (if $x.object_name != null and $nameById[$x.object_type + "/" + $x.object_id] == $x.object_name then [$x.object_id]',
        '     else ($idsByName[$x.object_type + "/" + ($x.object_name // "")] // []) end) as $ids',
        '  | $tagId[$x.category + "\\u001f" + $x.tag] as $tid',
        '  | ($has[$x.object_type + "/" + ($ids[0] // "")] // []) as $cur',
        '  | [$cur[] | $tagById[.] | select(.category == $x.category) | .name] as $inCat',
        '  | (if ($ids | length) == 0 then "missing-object"',
        '     elif ($ids | length) > 1 then "ambiguous-object"',
        '     elif $tid == null then "tag-not-created-yet"',
        '     elif ($cur | index($tid)) != null then "present"',
        '     elif $card[$x.category] == "SINGLE" and ($inCat | length) > 0 then "conflict"',
        '     else "attach" end) as $action',
        '  | [$action, $x.category, $x.tag, ($tid // ""), $x.object_type, ($ids[0] // ""), ($x.object_name // $x.object_id), ($inCat | join(" "))] | @tsv',
        '\' "$WORK/cat.json" > "$LOG"',
        '',
        'cut -f1 "$LOG" | sort | uniq -c',
        'ATTACH=$(awk -F\'\\t\' \'$1 == "attach"\' "$LOG" | wc -l)',
        'echo "Plan: $LOG (conflicts, missing and ambiguous objects are listed there and left alone)"',
        'if (( ATTACH > MAX_ATTACH )); then',
        '  echo "Refusing: $ATTACH attachments is more than MAX_ATTACH=$MAX_ATTACH. Read $LOG, then raise it deliberately." >&2',
        '  exit 1',
        'fi',
        'if (( DRY_RUN )); then echo "DRY RUN: $ATTACH attachment(s) would be made. Nothing was changed. Re-run with --execute."; exit 0; fi',
        '',
        'FAILED=0',
        'while IFS=$\'\\t\' read -r tid batch; do',
        '  result=$(vc POST "$host" "/api/cis/tagging/tag-association/${tid}?action=attach-tag-to-multiple-objects" --data-binary @- <<<"$batch")',
        '  if ! jq -e .success <<<"$result" >/dev/null; then',
        '    FAILED=$((FAILED + 1))',
        '    jq -r \'.error_messages[]? | "  attach failed: \\(.default_message)"\' <<<"$result" >&2',
        '  fi',
        'done < <(awk -F\'\\t\' \'$1 == "attach"\' "$LOG" | jq -R \'split("\\t") | {tid: .[3], type: .[4], id: .[5]}\' |',
        '  jq -sr \'group_by(.tid)[] | . as $g | range(0; length; 100) as $i | [$g[0].tid, ({object_ids: [$g[$i:($i + 100)][] | {type, id}]} | tojson)] | @tsv\')',
        'echo "Attached $ATTACH, $FAILED batch(es) reported errors. Undo: ./tag-restore.sh --undo $LOG $host --execute"',
        '(( FAILED == 0 ))',
        '',
      ].join('\n');

      const pkg = toPackage({
        packageName: 'com.archtoolkit.tags.backup',
        description: `Backs up every tag category, tag and assignment of ${vcenters.length} vCenter(s), and restores them by name — never deleting or detaching. Generated by ArchToolKit.`,
        categoryPath: 'ArchToolKit/Tags/Backup',
        workflow: {
          name: 'Tag backup and restore',
          description: 'mode backup: reads every category, tag and assignment of each vCenter into the archtoolkit-tag-backup/1 format (the backupJson output, and each vCenter posted to backupWebhook if set). mode restore: recreates the missing categories and tags of one backup by name and re-attaches its assignments by object type and name, never deleting, detaching or changing a one-value category that has a value. mode undo-restore: detaches what a restore attached. Restore is a dry run until dryRun is set to false in the configuration element.',
          inputs: [
            { name: 'dryRun', type: 'boolean', description: 'true: say what a restore would do, change nothing' },
            { name: 'mode', type: 'string', description: 'backup (default), restore or undo-restore' },
            { name: 'backup', type: 'string', description: 'restore: the backup — a backupJson output, or one <vcenter>.json from tag-backup.sh' },
            { name: 'targetVcenter', type: 'string', description: 'restore and undo-restore: the vCenter to restore into; empty: the one the backup came from' },
            { name: 'catalogueOnly', type: 'boolean', description: 'restore: categories and tags only, no assignments' },
            { name: 'restoreLogToUndo', type: 'string', description: 'undo-restore: the restoreLog output of the restore to undo' },
          ],
          outputs: [
            { name: 'backupJson', type: 'string', description: 'backup: one archtoolkit-tag-backup/1 document per vCenter, as a JSON array' },
            { name: 'restoreLog', type: 'string', description: 'restore: action, category, tag, tag id, object type, object id, object name, current value — tab separated, as tag-restore.sh writes it' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: BACKUP_WORKFLOW,
        },
        actions: vcTagActions('com.archtoolkit.tags.backup', ['vcLogin', 'openVcenter', 'readCatalogue', 'readAssociations', 'readInventory', 'tagsOn', 'changeTag']),
        config: {
          name: 'Tag backup',
          description: 'Settings of the Tag backup and restore workflow. Fill vcfApiToken (VCF 9.1) or vcPassword (8.x and 9.0) after import. Schedule mode backup nightly; run restore by hand.',
          attributes: [
            ...vcAttributes(vcenters, 'read on every object (backup), plus Create vSphere Tag Category, Create vSphere Tag and Assign or Unassign vSphere Tag for a restore'),
            { name: 'backupWebhook', type: 'string', value: '', description: 'Where each vCenter’s backup document is POSTed (a collector or an object-store gateway that keeps history); empty: only the backupJson output' },
            { name: 'maxAttach', type: 'number', value: maxAttach, description: 'A restore planning more attachments than this is refused before the first' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch for restore: nothing is created or attached while this is true' },
            { name: 'cap', type: 'number', value: maxAttach, description: 'The most create and attach calls (an attach call is up to 100 objects) one restore may make' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
      });

      return {
        platform: PLATFORM,
        title: `Nightly tag backup of ${vcenters.length} vCenter(s) to git, with restore`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `The backup runs daily at ${String(hour).padStart(2, '0')}:00 — the workflow Tag backup and restore (mode backup) on the Orchestrator scheduler, or scripts/tag-backup.sh from cron to keep the history in git. The restore is run by hand, after an accident or a vCenter rebuild.`, worstCase: 'the backup once a day; the restore whenever someone runs it' },
        scope: {
          what: `Backup: reads the tag catalogue, every assignment and the object names of ${vcenters.join(', ')}; writes to ${repo}. Restore: creates missing categories and tags and attaches tags on one vCenter.`,
          decidedBy: [
            'VCENTERS for the backup.',
            'For the restore: the backup file given, the target vCenter, and object type plus name to find each object again.',
            'What is already there: existing categories, tags and attachments are skipped, and a one-value category that already has a different value is left alone.',
          ],
          ifWrong: 'A restore pointed at the wrong vCenter attaches tags to objects that happen to share names — common for VM names across sites. The plan file lists every object before anything is attached; read it.',
        },
        guardrails: [
          { rule: 'The restore never deletes and never detaches', because: 'It exists to put things back after a mistake; it must not be able to make a second one of the same kind.' },
          { rule: 'The restore never changes the value of a one-value category that already has one', because: 'The live value may be newer than the backup. Conflicts are listed for a person.' },
          { rule: `The restore refuses more than ${maxAttach} attachments (MAX_ATTACH)`, because: 'Restoring the wrong vCenter’s backup would otherwise re-tag every name-alike object.' },
          { rule: 'An object whose name matches more than one object is skipped, not guessed', because: 'Two VMs with one name in different folders is ordinary; tagging both is not.' },
          { rule: 'The backup refuses to replace a non-empty catalogue with an empty one (the workflow never takes an empty catalogue as a backup, and fails the run)', because: 'A failed read that commits an empty file makes the history look like a wipe, and the next restore from HEAD restores nothing.' },
        ],
        dryRun: [
          'The workflow in mode restore is a dry run until dryRun is set to false in its configuration element: the log lists every "DRY RUN: would create/attach …" and the restoreLog output the action for every assignment.',
          './scripts/tag-restore.sh <file> [vcenter] without --execute lists the categories and tags it would create and writes restore-log-<run>.tsv with the action for every assignment: attach, present, conflict, missing-object, ambiguous-object.',
          'The backup is itself read-only against vCenter; run it by hand once and read the git diff.',
        ],
        undo: [
          'Restore: the workflow in mode undo-restore with targetVcenter and restoreLogToUndo (the restoreLog output) detaches everything that run attached; ./scripts/tag-restore.sh --undo restore-log-<run>.tsv <vcenter> --execute does the same for a script run. Categories and tags it created stay; delete them in vCenter if unwanted, once unattached.',
          'Backup: git revert or git reset in the backup repository; vCenter is not touched.',
        ],
        told: [`The workflow: its backupJson output, each document posted to backupWebhook if set, and a failed run when a vCenter could not be read. The script: a git commit in ${repo} whenever tags change${push ? ', pushed to its remote' : ''}; the commit diff is the change record. A restore returns (or writes) the restore log.`],
        requires: [
          ...VC_REQUIRES,
          `A git clone at ${repo} the job can commit${push ? ' and push' : ''} to, with its git identity and remote credentials set up for the job’s account.`,
          'Read-only access for the backup; Create vSphere Tag Category, Create vSphere Tag and Assign or Unassign vSphere Tag for the restore.',
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the vCenter certificates trusted in Orchestrator. Orchestrator has no git; for history in git keep the script, or point backupWebhook at something that keeps every version.',
        ],
        files: {
          'IMPORT.md': tagsImport(
            `The backup is JSON in the archtoolkit-tag-backup/1 format; vCenter and VCF Operations have no import for it, so the restore is the import. The Orchestrator package \`${pkg.packageDir}\` (on the shared core library) does both with the workflow **Tag backup and restore**; scripts/tag-backup.sh and scripts/tag-restore.sh do the same from a Linux host, the backup into git. Either restores the other's backup.`,
            [
              ...pkg.importSteps,
              { heading: 'Or: back up daily with the script', lines: ['Install the line in crontab.txt with `crontab -e` after one run by hand.'] },
              { heading: 'Or: restore with the script', lines: ['`./scripts/tag-restore.sh <backup>/<vcenter>.json [target-vcenter]` (dry run: what would be recreated), then `--execute` (`--catalogue-only` for categories and tags without assignments). It recreates what is missing through POST /api/cis/tagging/category and /tag, then the assignments.'] },
            ],
            ['The VCF 9.1 API-token login to vCenter follows davidwzhang.com "VCF 9.1 API Access (4)"; confirm it, or use vcUsername and vcPassword.'],
          ),
          ...pkg.files,
          'scripts/tag-backup.sh': backup,
          'scripts/tag-restore.sh': restore,
          'crontab.txt': [
            '# Tag backup, daily. No secret here: VCF_API_TOKEN_FILE is a path to a mode-600 file (VC_USER + VC_PASSWORD_FILE on 8.x/9.0).',
            '# With the Orchestrator package, schedule the workflow Tag backup and restore (mode backup) instead, or keep this for the git history.',
            `0 ${hour} * * * cd /opt/archtoolkit/tag-backup && ${vcScheduledEnv(vcenters)} BACKUP_REPO=${repo} ./scripts/tag-backup.sh >> tag-backup.log 2>&1`,
            '',
          ].join('\n'),
        },
        notes: [
          'Category and tag ids are URNs local to each vCenter. The restore matches everything by name and ignores ids, so a backup from one vCenter can seed another.',
          'The vCenter file-based backup does include the tagging data, but only as the whole appliance; this is the only way to put back one category somebody deleted.',
          'In VCF 9.1, fleet tag management can also export category definitions as JSON from Manage > Fleet Management > Tags. That covers the catalogue, not the assignments; this covers both.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'tags_consume',
    platform: PLATFORM,
    label: 'Make the tags drive groups, placement, firewall and showback',
    group: 'Tags — use',
    description:
      'A tag nobody reads is a label. This generates, from the standard, everything that reads them: VCF Operations custom groups per value (and which policy each should carry), VCF Automation capability tags and a template constraint for placement, NSX security groups per value with the sync that copies vCenter tags onto NSX, and the showback mapping — plus one table of which category drives what, so nobody changes a value without knowing what moves.',
    inputs: [
      STANDARD_INPUT,
      VCENTERS_INPUT,
      { id: 'group_category', label: 'VCF Operations custom group per value of', control: 'text', default: 'Environment' },
      { id: 'placement_category', label: 'VCF Automation placement by', control: 'text', default: 'Environment' },
      { id: 'nsx_category', label: 'NSX security group per value of', control: 'text', default: 'Application' },
      { id: 'nsx_sync', label: 'Copy vCenter tags onto NSX (sync script)', control: 'toggle', default: true },
      { id: 'nsx_host', label: 'NSX Manager', control: 'text', default: 'nsx-wld01.example.com' },
      { id: 'cost_category', label: 'Showback by', control: 'text', default: 'CostCenter' },
      { id: 'max_changes', label: 'NSX sync refuses more than (VMs)', control: 'number', default: 200, min: 1, max: 100000, showWhen: { input: 'nsx_sync', equals: ['true'] } },
    ],
    automation: (values: BlueprintValues): Automation => {
      const { categories, findings } = parseStandard(str(values, 'standard', DEFAULT_STANDARD));
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const groupCat = str(values, 'group_category', 'Environment');
      const placeCat = str(values, 'placement_category', 'Environment');
      const nsxCat = str(values, 'nsx_category', 'Application');
      const costCat = str(values, 'cost_category', 'CostCenter');
      const nsxSync = bool(values, 'nsx_sync', true);
      const nsxHost = str(values, 'nsx_host', 'nsx-wld01.example.com');
      const maxChanges = num(values, 'max_changes', 200);
      const find = (name: string, role: string): StdCategory | undefined => {
        const found = categories.find((c) => c.name === name);
        if (!found) findings.push(error('tags.consume.unknown-category', `${role} uses "${name}", which is not in the standard.`, { remediation: 'Every consumer must read a category the standard defines, or the groups it builds match nothing.', source: SRC }));
        return found;
      };
      const g = find(groupCat, 'The VCF Operations groups');
      const p = find(placeCat, 'VCF Automation placement');
      const n = find(nsxCat, 'The NSX groups');
      const c = find(costCat, 'Showback');
      if (p && p.cardinality === 'MULTIPLE') {
        findings.push(warning('tags.consume.placement-multiple', `${placeCat} drives placement but allows several values per object.`, { remediation: 'A cluster tagged both prod and dev satisfies both constraints, and a VM tagged both lands on whichever the placement engine reads first. Placement categories must be single.', source: SRC }));
      }
      if (c && c.cardinality === 'MULTIPLE') {
        findings.push(warning('tags.consume.cost-multiple', `${costCat} drives showback but allows several values per object.`, { remediation: 'An object with two cost centres is billed to both, or to neither, depending on the report. Make it single.', source: SRC }));
      }
      if (!nsxSync) {
        findings.push(warning('tags.consume.nsx-no-sync', `The NSX groups select on ${nsxCat} tags, and nothing copies the vCenter tags onto NSX.`, { remediation: 'NSX groups match NSX tags on the VM, which are separate from vCenter tags. Without the sync the groups stay empty and the firewall rules on them match nothing — or, for a deny rule, protect nothing.', source: SRC }));
      }
      if (n && !n.types.includes('VirtualMachine') && n.types.length > 0) {
        findings.push(error('tags.consume.nsx-not-vm', `${nsxCat} cannot be attached to VMs, so no VM will ever be in its NSX groups.`, { source: SRC }));
      }
      const groupValues = (g?.values ?? []).slice(0, 30);
      if ((g?.values.length ?? 0) > 30) findings.push(warning('tags.consume.too-many-groups', `${groupCat} has ${g!.values.length} values; groups are generated for the first 30.`, { remediation: 'A custom group per value past a few dozen is a group nobody opens. Group by a coarser category.', source: SRC }));
      if (g?.freeText || n?.freeText) findings.push(warning('tags.consume.free-text', 'A free-text category has no fixed values to build groups for.', { source: SRC }));

      const files: Record<string, string> = {};

      // VCF Operations custom groups.
      const groupFiles: string[] = [];
      for (const value of groupValues) {
        const file = `vcfops-group-${slugOf(groupCat, 'cat')}-${slugOf(value, 'value')}.json`;
        groupFiles.push(file);
        files[file] = `${JSON.stringify(
          {
            resourceKey: { name: `${groupCat} ${value} VMs`, adapterKindKey: 'Container', resourceKindKey: 'Environment', resourceIdentifiers: [] },
            autoResolveMembership: true,
            membershipDefinition: {
              includedResources: [],
              excludedResources: [],
              rules: [
                {
                  resourceKindKey: { resourceKind: 'VirtualMachine', adapterKind: 'VMWARE' },
                  propertyConditionRules: [{ key: 'summary|tag', stringValue: `<${groupCat}-${value}>`, compareOperator: 'CONTAINS' }],
                  statConditionRules: [],
                  resourceNameConditionRules: [],
                  relationshipConditionRules: [],
                  resourceTagConditionRules: [],
                },
              ],
            },
          },
          null,
          2,
        )}\n`;
      }
      if (groupFiles.length > 0) {
        // The fallback lives in scripts/ and works from the folder above, where the
        // payloads are (they are also the files people send by hand).
        files['scripts/vcfops-apply-groups.sh'] = applyScript(
          'vcf-operations',
          groupFiles.map((file) => ({ method: 'POST' as const, path: '/suite-api/api/resources/groups', payload: file })),
          'DELETE /suite-api/api/resources/groups/{id} for each group created. Deleting a group does not touch its members.',
        ).replace('set -euo pipefail\n', 'set -euo pipefail\ncd "$(dirname "$0")/.."\n');
      }
      files['vcfops-policies.md'] = [
        `# VCF Operations policy per ${groupCat}`,
        '',
        'Assign a policy to each group (Infrastructure Operations > Configurations > Policies > the policy > Custom Groups),',
        'so thresholds follow the tag rather than a list somebody maintains. A suggested starting point:',
        '',
        '| Group | Policy | Why |',
        '| --- | --- | --- |',
        ...groupValues.map((value) => {
          const prod = /^(prod|production|prd|dr)$/i.test(value);
          return `| ${groupCat} ${value} VMs | ${prod ? 'Production' : /test|dev|uat|preprod/i.test(value) ? 'Non-production' : '<choose>'} | ${prod ? 'Tighter thresholds, alerts page someone, no aggressive reclamation.' : 'Looser thresholds, reclamation allowed, alerts to a queue.'} |`;
        }),
        '',
        'A VM in two groups gets the policy of the group with the higher priority. With a single-value',
        `${groupCat} a VM is in exactly one of these groups; with a multiple-value category it can be in several`,
        'and the priority order decides silently.',
        '',
        'VERIFY: summary|tag is the property VCF Operations fills from vSphere tags. Open a tagged VM,',
        'Metrics > Properties > Summary, and check how your release writes it (this kit assumes',
        `\`<Category-Tag>\`, e.g. \`<${groupCat}-${groupValues[0] ?? 'prod'}>\`). Adjust stringValue in the group files if it differs.`,
        '',
      ].join('\n');

      // VCF Automation placement.
      const key = slugOf(placeCat, 'env').replace(/-/g, '');
      const placeValues = p?.values ?? [];
      files['vcfa-capability-tags.json'] = `${JSON.stringify(
        {
          note: `Capability tags for cloud zones (and compute), one zone per ${placeCat} value. PATCH each zone with its tags, or set them in Infrastructure > Cloud Zones > Capability tags.`,
          zones: placeValues.map((value) => ({ cloudZone: `<REQUIRED — the cloud zone for ${placeCat}=${value}>`, tags: [{ key, value }] })),
          vsphereTagMapping: `vCenter tags are collected by VCF Automation as key:value, category as key — ${placeCat}=${placeValues[0] ?? 'prod'} appears as ${placeCat}:${placeValues[0] ?? 'prod'} on the discovered cluster, and can be used in a cloud zone's dynamic compute filter.`,
        },
        null,
        2,
      )}\n`;
      files['vcfa-template.yaml'] = [
        'formatVersion: 1',
        'inputs:',
        `  ${key}:`,
        '    type: string',
        `    title: ${placeCat}`,
        `    enum: [${placeValues.join(', ')}]`,
        'resources:',
        '  vm:',
        '    type: Cloud.vSphere.Machine',
        '    properties:',
        '      image: <REQUIRED — image mapping>',
        '      flavor: <REQUIRED — flavor mapping>',
        '      # Placement: only cloud zones whose capability tags include this pair.',
        '      constraints:',
        `        - tag: '${key}:\${input.${key}}'`,
        '      # Tags written onto the VM. On vSphere these become vCenter tags',
        '      # (key = category, value = tag), so the VM is compliant from birth.',
        '      tags:',
        `        - key: ${placeCat}`,
        `          value: '\${input.${key}}'`,
        ...(c ? [`        - key: ${costCat}`, `          value: '\${input.${slugOf(costCat, 'cost').replace(/-/g, '')}}'`] : []),
        '',
      ].join('\n');
      if (c) {
        files['vcfa-template.yaml'] = files['vcfa-template.yaml'].replace('resources:\n', `  ${slugOf(costCat, 'cost').replace(/-/g, '')}:\n    type: string\n    title: ${costCat}\n    enum: [${c.values.join(', ')}]\nresources:\n`);
      }

      // NSX groups.
      const nsxValues = (n?.values ?? []).slice(0, 50);
      const nsxFiles = nsxValues.map((value) => {
        const id = `${slugOf(nsxCat, 'cat')}-${slugOf(value, 'value')}`;
        const file = `nsx-group-${id}.json`;
        files[file] = `${JSON.stringify(
          {
            display_name: `${nsxCat} ${value}`,
            description: `VMs whose NSX tag ${nsxCat}|${value} is set — copied from the vCenter tag by nsx-tag-sync.sh. Generated by ArchToolKit.`,
            expression: [{ resource_type: 'Condition', member_type: 'VirtualMachine', key: 'Tag', operator: 'EQUALS', value: `${nsxCat}|${value}` }],
            tags: [{ scope: 'managed-by', tag: 'archtoolkit' }],
          },
          null,
          2,
        )}\n`;
        return { id, file };
      });
      const nsxAuth = [
        `NSX_HOST="\${NSX_HOST:-${nsxHost}}"`,
        ': "${NSX_USER:?set NSX_USER to an NSX account (Security Engineer is enough for groups and VM tags)}"',
        ': "${NSX_PASSWORD_FILE:?set NSX_PASSWORD_FILE to a mode-600 file holding the password of NSX_USER}"',
        'NSX_TLS=()',
        '[[ -n "${NSX_CACERT:-}" ]] && NSX_TLS=(--cacert "$NSX_CACERT")',
        '# nsx METHOD PATH [curl args]. Basic auth from a config on stdin, never argv.',
        'nsx() {',
        '  local method="$1" path="$2"; shift 2',
        '  jq -rn --arg u "$NSX_USER" --rawfile p "$NSX_PASSWORD_FILE" \'"user = " + (($u + ":" + ($p | rtrimstr("\\n"))) | tojson)\' |',
        '    curl -sS -f ${NSX_TLS[@]+"${NSX_TLS[@]}"} -K - -X "$method" "https://${NSX_HOST}${path}" \\',
        '      -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
        '}',
        '# nsx_get_status PATH OUTFILE: GET without -f, the body to OUTFILE, and prints',
        '# the HTTP status (000 when nothing answered), so the caller can tell a 404',
        '# from a 401 or a 503.',
        'nsx_get_status() {',
        '  jq -rn --arg u "$NSX_USER" --rawfile p "$NSX_PASSWORD_FILE" \'"user = " + (($u + ":" + ($p | rtrimstr("\\n"))) | tojson)\' |',
        '    curl -sS ${NSX_TLS[@]+"${NSX_TLS[@]}"} -K - -o "$2" -w \'%{http_code}\' "https://${NSX_HOST}$1" -H "Accept: application/json" || true',
        '}',
      ];
      if (nsxFiles.length > 0) {
        files['scripts/nsx-apply-groups.sh'] = [
          '#!/usr/bin/env bash',
          `# Create or update the NSX groups for ${nsxCat} (Policy API, default domain).`,
          '#',
          '# Refuses to update a group that exists without the managed-by|archtoolkit',
          '# tag: somebody built it by hand, and firewall rules may depend on its',
          '# current membership. Without --execute it only prints what it would do.',
          '# Works from the folder above scripts/, where the nsx-group-*.json bodies are.',
          'set -euo pipefail',
          'cd "$(dirname "$0")/.."',
          'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
          ...nsxAuth,
          'DRY_RUN=1; [[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
          'TMP_GET=$(mktemp); trap \'rm -f "$TMP_GET"\' EXIT',
          'send_group() {',
          '  local id="$1" file="$2" code',
          '  # Only a 404 means the group does not exist. Anything else — 401, 403, a 5xx,',
          '  # no answer — means we cannot tell, and treating it as absent would skip the',
          '  # managed-by check and overwrite a hand-built group. So stop.',
          '  code=$(nsx_get_status "/policy/api/v1/infra/domains/default/groups/${id}" "$TMP_GET")',
          '  case "$code" in',
          '    200)',
          '      if ! jq -e \'any(.tags[]?; .scope == "managed-by" and .tag == "archtoolkit")\' "$TMP_GET" >/dev/null; then',
          '        echo "REFUSED $id: exists and was not created by this kit. Rename ours or adopt it by hand." >&2; return 0',
          '      fi ;;',
          '    404) ;;',
          '    *) echo "STOPPED at $id: reading the existing group answered HTTP ${code}, so whether it exists, and who owns it, is unknown. Nothing more was sent." >&2; exit 1 ;;',
          '  esac',
          '  if (( DRY_RUN )); then echo "DRY RUN: would PATCH group $id from $file"; return 0; fi',
          '  nsx PATCH "/policy/api/v1/infra/domains/default/groups/${id}" --data-binary @"$file" >/dev/null',
          '  echo "group $id: $(nsx GET "/policy/api/v1/infra/domains/default/groups/${id}/members/virtual-machines" | jq \'.result_count // (.results | length)\') VM member(s)"',
          '}',
          ...nsxFiles.map((f) => `send_group '${f.id}' '${f.file}'`),
          '(( DRY_RUN )) && echo "Nothing was changed. Re-run with --execute." || true',
          '',
        ].join('\n');
      }
      if (nsxSync) {
        files['scripts/nsx-tag-sync.sh'] = [
          '#!/usr/bin/env bash',
          `# Copy the vCenter ${nsxCat} tags onto the NSX tags of the same VMs, as`,
          `# scope ${nsxCat}, tag <value>. NSX groups match NSX tags, not vCenter tags.`,
          '#',
          `# Only the ${nsxCat} scope is ever touched; every other NSX tag on the VM is kept.`,
          '# A VM is matched by its instance UUID (the NSX external_id). Without',
          '# --execute it only lists the changes. --prune also clears the scope from VMs',
          '# in these vCenters that no longer carry the vCenter tag at all.',
          'set -euo pipefail',
          'cd "$(dirname "$0")"',
          vcentersLine(vcenters),
          `SYNC_CATEGORY="\${SYNC_CATEGORY:-${nsxCat}}"`,
          `MAX_CHANGES="\${MAX_CHANGES:-${maxChanges}}"`,
          'DRY_RUN=1; PRUNE=0',
          'for arg in "$@"; do case "$arg" in --execute) DRY_RUN=0 ;; --prune) PRUNE=1 ;; *) echo "unknown argument: $arg" >&2; exit 2 ;; esac; done',
          '',
          ...vcLib(),
          ...nsxAuth,
          '',
          '# Every NSX VM with its tags, paged by cursor.',
          '# VERIFY: realized-state virtual-machines list and update_tags on your NSX release.',
          'VMS_PATH=/policy/api/v1/infra/realized-state/enforcement-points/default/virtual-machines',
          ': > "$WORK/nsx.jsonl"',
          'cursor=""',
          'while :; do',
          '  page=$(nsx GET "${VMS_PATH}${cursor:+?cursor=$cursor}")',
          '  jq -c \'.results[]? | {external_id, display_name, tags: (.tags // [])}\' <<<"$page" >> "$WORK/nsx.jsonl"',
          '  cursor=$(jq -r \'.cursor // empty\' <<<"$page")',
          '  [[ -z "$cursor" ]] && break',
          'done',
          'jq -s \'map({key: .external_id, value: .}) | from_entries\' "$WORK/nsx.jsonl" > "$WORK/nsx.json"',
          '',
          '# What vCenter says: instance UUID -> values of SYNC_CATEGORY.',
          ': > "$WORK/want.jsonl"',
          'for host in ${VCENTERS//,/ }; do',
          '  vc_login "$host"',
          '  load_catalogue "$host" "$WORK/$host.cat.json"',
          '  load_associations "$host" "$WORK/$host.cat.json" "$WORK/$host.asn.json"',
          '  while IFS=$\'\\t\' read -r vm values; do',
          '    uuid=$(vc GET "$host" "/api/vcenter/vm/${vm}" | jq -r \'.identity.instance_uuid // empty\')',
          '    [[ -z "$uuid" ]] && { echo "no instance UUID for $vm on $host; skipped" >&2; continue; }',
          '    jq -nc --arg u "$uuid" --arg v "$values" --arg h "$host" --arg m "$vm" \'{uuid: $u, host: $h, vm: $m, values: ($v | split(",") | map(select(length > 0)))}\' >> "$WORK/want.jsonl"',
          '  done < <(jq -r --slurpfile c "$WORK/$host.cat.json" --arg cat "$SYNC_CATEGORY" \'',
          '      ($c[0].tags | map(select(.category == $cat)) | map({key: .id, value: .name}) | from_entries) as $t',
          '      | map(select(.type == "VirtualMachine" and $t[.tag_id] != null)) | group_by(.id)[]',
          '      | [.[0].id, (map($t[.tag_id]) | sort | join(","))] | @tsv\' "$WORK/$host.asn.json")',
          'done',
          '',
          '# The plan: VMs whose NSX tags in the scope differ from vCenter.',
          'jq -s --slurpfile nsx "$WORK/nsx.json" --arg cat "$SYNC_CATEGORY" \'',
          '  map(. as $w | $nsx[0][$w.uuid] as $n | select($n != null)',
          '    | ([$n.tags[] | select(.scope == $cat) | .tag] | sort) as $have',
          '    | select($have != ($w.values | sort))',
          '    | {uuid: $w.uuid, name: $n.display_name, have: $have, want: $w.values,',
          '       tags: ([$n.tags[] | select(.scope != $cat)] + [$w.values[] | {scope: $cat, tag: .}])})\' "$WORK/want.jsonl" > "$WORK/plan.json"',
          'if (( PRUNE )); then',
          '  # NSX VMs with the scope that vCenter no longer tags. Only VMs found by name',
          '  # in one of VCENTERS with the same instance UUID are touched.',
          '  while IFS=$\'\\t\' read -r uuid name; do',
          '    for host in ${VCENTERS//,/ }; do',
          '      vm=$(vc GET "$host" "/api/vcenter/vm?names=$(jq -rn --arg v "$name" \'$v | @uri\')" | jq -r \'.[0].vm // empty\')',
          '      [[ -z "$vm" ]] && continue',
          '      [[ "$(vc GET "$host" "/api/vcenter/vm/${vm}" | jq -r \'.identity.instance_uuid // empty\')" == "$uuid" ]] || continue',
          '      jq --arg u "$uuid" --slurpfile nsx "$WORK/nsx.json" --arg cat "$SYNC_CATEGORY" \'. + [$nsx[0][$u] | {uuid: $u, name: .display_name,',
          '        have: [.tags[] | select(.scope == $cat) | .tag], want: [], tags: [.tags[] | select(.scope != $cat)]}]\' "$WORK/plan.json" > "$WORK/plan2.json"',
          '      mv "$WORK/plan2.json" "$WORK/plan.json"',
          '      break',
          '    done',
          '  done < <(jq -r --slurpfile w <(jq -s \'map(.uuid)\' "$WORK/want.jsonl") --arg cat "$SYNC_CATEGORY" \'',
          '      to_entries[] | .value | select(any(.tags[]; .scope == $cat)) | select(.external_id as $u | $w[0] | index($u) | not)',
          '      | [.external_id, .display_name] | @tsv\' "$WORK/nsx.json")',
          'fi',
          '',
          'COUNT=$(jq length "$WORK/plan.json")',
          'jq -r \'.[] | "\\(.name): \\(.have | join(",") | if . == "" then "(none)" else . end) -> \\(.want | join(",") | if . == "" then "(none)" else . end)"\' "$WORK/plan.json"',
          'echo "$COUNT VM(s) to change."',
          'if (( COUNT > MAX_CHANGES )); then echo "Refusing: more than MAX_CHANGES=$MAX_CHANGES. Read the list; if it is right, raise MAX_CHANGES for one run." >&2; exit 1; fi',
          'if (( DRY_RUN )); then echo "DRY RUN: nothing was changed. Re-run with --execute."; exit 0; fi',
          'LOG="nsx-tag-sync-$(date -u +%Y%m%dT%H%M%SZ).json"',
          'cp "$WORK/plan.json" "$LOG"',
          '# update_tags replaces the whole tag set, so the plan carries every other',
          '# scope unchanged plus the new values for this one. A VM that fails is counted',
          '# and the rest carry on; the run exits 1 if any failed, so a scheduler sees it.',
          'FAILED=0; DONE=0',
          'while read -r body; do',
          '  # The body goes in a file: stdin carries the NSX credentials to curl.',
          '  printf \'%s\' "$body" > "$WORK/body.json"',
          '  if nsx POST "${VMS_PATH}?action=update_tags" --data-binary @"$WORK/body.json" >/dev/null; then',
          '    DONE=$((DONE + 1))',
          '  else',
          '    FAILED=$((FAILED + 1)); echo "failed: $(jq -r .virtual_machine_id <<<"$body")" >&2',
          '  fi',
          'done < <(jq -c \'.[] | {virtual_machine_id: .uuid, tags}\' "$WORK/plan.json")',
          'echo "$DONE VM(s) updated, $FAILED failed. The before and after of every VM planned is in $LOG."',
          '(( FAILED == 0 )) || { echo "$FAILED VM(s) were not updated; their NSX tags are as they were. Re-run once the cause is fixed." >&2; exit 1; }',
          '',
        ].join('\n');
      }

      files['cost-showback.md'] = [
        `# Showback by ${costCat}`,
        '',
        `VCF Operations cost and showback work on groups: put the ${costCat} tag behind a custom group per`,
        'value, and the cost of each group is the cost of that cost centre.',
        '',
        `1. Create a custom group per ${costCat} value, the same shape as the vcfops-group-*.json files here`,
        `   with \`<${costCat}-${c?.values[0] ?? 'CC1001'}>\` as the tag condition.`,
        '2. Put a pricing card on them (Infrastructure Operations > Configurations > Cost > Pricing),',
        '   or report on the group’s cost metrics. VERIFY in your release: pricing cards can also apply',
        '   tag-based rates directly — a rate for VMs carrying a given category and value — which saves',
        '   the groups if the rate is all you need.',
        `3. Report monthly per group. An object with no ${costCat} is cost nobody is shown; the compliance`,
        '   report lists them as missing-required.',
        '',
        `${c?.cardinality === 'MULTIPLE' ? `**${costCat} allows several values per object in the standard.** An object with two cost centres appears in two groups and is shown to both. Make it single.` : `${costCat} is single in the standard, so each object is shown to exactly one cost centre.`}`,
        '',
      ].join('\n');

      const template = { name: `VM placed by ${placeCat}`, description: `A vSphere VM placed and tagged by ${placeCat}${c ? ` and ${costCat}` : ''}. Generated by ArchToolKit.`, version: '1.0.0', yaml: files['vcfa-template.yaml'] ?? '' };
      files[templatePath(template)] = blueprintYaml(template);
      // The central component: one Orchestrator package that creates the VCF
      // Operations groups and the NSX groups from the same bodies, and runs the sync.
      const pkg = toPackage({
        packageName: 'com.archtoolkit.tags.consume',
        description: `Applies the tag consumers: ${groupFiles.length} VCF Operations custom groups (${groupCat}), ${nsxFiles.length} NSX groups (${nsxCat})${nsxSync ? `, and the sync of the vCenter ${nsxCat} tag onto NSX` : ''}. Generated by ArchToolKit.`,
        categoryPath: 'ArchToolKit/Tags/Consumers',
        workflow: {
          name: 'Apply tag consumers',
          description: `Creates the VCF Operations custom groups that do not exist yet (by name), creates or updates the NSX groups (refusing any that exist without managed-by|archtoolkit, leaving alone those already as generated)${nsxSync ? `, and copies the vCenter ${nsxCat} tag onto the NSX tag scope ${nsxCat} of the same VMs (only that scope; every other NSX tag kept; refused above maxVmChanges)` : ''}. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: say what would be created and changed, change nothing' }],
          outputs: [
            { name: 'syncPlanJson', type: 'string', description: 'Every VM whose NSX tags the sync changes (or would), with the scope values before (have) and after, and the whole tag set sent' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: consumeWorkflow(groupFiles, nsxFiles),
        },
        actions: vcTagActions('com.archtoolkit.tags.consume', ['vcLogin', 'openVcenter', 'readCatalogue', 'readAssociations']),
        config: {
          name: 'Tag consumers',
          description: 'Settings of the Apply tag consumers workflow. Fill opsPassword, nsxPassword and vcfApiToken (VCF 9.1) or vcPassword (8.x and 9.0) after import.',
          attributes: [
            { name: 'applyVcfOpsGroups', type: 'boolean', value: groupFiles.length > 0, description: 'Create the VCF Operations custom groups' },
            { name: 'opsHost', type: 'string', value: '', description: 'VCF Operations host' },
            { name: 'opsUsername', type: 'string', value: '', description: 'An account that may create custom groups' },
            { name: 'opsPassword', type: 'SecureString', description: 'Its password' },
            { name: 'opsAuthSource', type: 'string', value: '', description: 'Its authentication source; empty for a local account' },
            { name: 'applyNsxGroups', type: 'boolean', value: nsxFiles.length > 0, description: 'Create or update the NSX groups' },
            { name: 'nsxSync', type: 'boolean', value: nsxSync, description: `Copy the vCenter ${nsxCat} tags onto the NSX tags of the same VMs` },
            { name: 'nsxHost', type: 'string', value: nsxHost, description: 'NSX Manager' },
            { name: 'nsxUsername', type: 'string', value: '', description: 'An NSX account with rights on groups and VM tags' },
            { name: 'nsxPassword', type: 'SecureString', description: 'Its password' },
            { name: 'syncCategory', type: 'string', value: nsxCat, description: 'The vCenter category copied to the NSX scope of the same name' },
            { name: 'prune', type: 'boolean', value: false, description: 'Also clear the scope from VMs in these vCenters that no longer carry the vCenter tag at all' },
            { name: 'maxVmChanges', type: 'number', value: maxChanges, description: 'The sync refuses a run that would change more VMs than this' },
            ...vcAttributes(vcenters, 'read on the VMs and their tags'),
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is created or changed while this is true' },
            { name: 'cap', type: 'number', value: groupFiles.length + nsxFiles.length + maxChanges, description: 'The most changes one run may make' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [...groupFiles, ...nsxFiles.map((f) => f.file)].map((name) => ({ name, content: files[name]! })),
      });
      Object.assign(files, pkg.files);

      files['IMPORT.md'] = tagsImport(
        `Each consumer takes its own format. Where a file is exactly the request body the consumer takes, it is sent as it stands — by the Orchestrator package \`${pkg.packageDir}\` (on the shared core library, workflow **Apply tag consumers**), or by the scripts under scripts/, which work from this folder.`,
        [
          ...pkg.importSteps,
          groupFiles.length > 0
            ? { heading: 'VCF Operations custom groups', lines: [`Each vcfops-group-*.json is exactly the body of POST /suite-api/api/resources/groups; the workflow sends them (resource elements of the same names). Or \`./scripts/vcfops-apply-groups.sh\` (dry run), then \`--execute\`. Then assign a policy per group as in vcfops-policies.md. (The interface’s custom-group Import takes its own export format, not these bodies.)`] }
            : undefined,
          nsxFiles.length > 0
            ? { heading: 'NSX groups', lines: [`Each nsx-group-*.json is exactly the body of PATCH /policy/api/v1/infra/domains/default/groups/<id>; the workflow sends them. Or \`./scripts/nsx-apply-groups.sh\` (dry run), then \`--execute\`.${nsxSync ? ' Then schedule the workflow (or scripts/nsx-tag-sync.sh), which copies the vCenter tag to the NSX tag the groups select on.' : ''}`] }
            : undefined,
          {
            heading: 'VCF Automation',
            lines: [
              `${templatePath(template)} is the template with name and version at the top — the layout VCF Automation’s git integration reads, and what Design > Templates > Upload (VM Apps) or Blueprint Design > New From Import (All Apps) takes. Replace the image and flavor <REQUIRED> values first.`,
              'vcfa-capability-tags.json is not a request body: it lists which capability tag each cloud zone needs. Set them under Infrastructure > Configure > Cloud Zones > the zone > Capability tags.',
            ],
          },
          { heading: 'Showback', lines: ['cost-showback.md: steps in VCF Operations; nothing to upload.'] },
        ],
        [
          'The VCF Operations group rule reads the vSphere tag property summary|tag with the value <Category-value>; check the property on one tagged VM in VCF Operations before relying on the group.',
          'The workflow finds existing custom groups with GET /suite-api/api/resources/groups (the groups array, by resourceKey.name); check the list shape on your release before an armed run, or a group could be created twice.',
          'The NSX sync reads /api/vcenter/vm/{vm} identity.instance_uuid and calls the NSX realized-state virtual-machines update_tags action, which replaces a VM’s whole tag set; check both on your NSX and vCenter releases.',
        ],
      );
      files['TAG-CONSUMERS.md'] = [
        '# What reads which tag',
        '',
        'Change a value in the left column and everything in the row moves. Review a change to the standard',
        'against this table.',
        '',
        '| Category | Consumer | How it reads it | Must be single? | File |',
        '| --- | --- | --- | --- | --- |',
        `| ${groupCat} | VCF Operations custom groups, and the policy on each | summary\\|tag property condition | Yes — otherwise the policy priority decides silently | vcfops-group-*.json, vcfops-policies.md |`,
        `| ${placeCat} | VCF Automation placement | capability tag ${key}:<value> on cloud zones, constraint in the template | Yes — a zone or VM with two values matches both | vcfa-capability-tags.json, vcfa-template.yaml |`,
        `| ${placeCat}${c ? `, ${costCat}` : ''} | VCF Automation deployments | tags on the machine, written to vCenter as tags | — | vcfa-template.yaml |`,
        `| ${nsxCat} | NSX security groups, and every DFW rule on them | NSX tag ${nsxCat}\\|<value> on the VM — ${nsxSync ? 'copied from vCenter by nsx-tag-sync.sh' : '**nothing copies it from vCenter**'} | No, a VM can be in several application groups | nsx-group-*.json, nsx-apply-groups.sh${nsxSync ? ', nsx-tag-sync.sh' : ''} |`,
        `| ${costCat} | Cost showback | custom group per value, pricing card | Yes | cost-showback.md |`,
        '| Automation | Every automation in this kit | Automation=never is skipped | Yes | — |',
        '',
        '## Current values',
        '',
        ...[g, p, n, c]
          .filter((x): x is StdCategory => x !== undefined)
          .filter((x, i, all) => all.findIndex((y) => y.name === x.name) === i)
          .map((x) => `- **${x.name}** (${x.cardinality.toLowerCase()}): ${x.freeText ? 'free text' : x.values.join(', ')}`),
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Tags that drive the platform — ${groupCat} groups, ${placeCat} placement, ${nsxCat} firewall groups, ${costCat} showback`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: `An engineer applies the groups once; ${nsxSync ? 'nsx-tag-sync.sh then runs on a schedule (every hour is reasonable) to keep NSX tags in step with vCenter.' : 'nothing keeps NSX in step afterwards.'}` },
        scope: {
          what: `Creates ${groupFiles.length} VCF Operations custom groups and ${nsxFiles.length} NSX groups${nsxSync ? `, and sets the ${nsxCat} scope of NSX tags on VMs in ${vcenters.join(', ')}` : ''}. The VCF Automation and showback files are for review and apply elsewhere.`,
          decidedBy: [
            'The standard: one group per allowed value of each category chosen.',
            `VCF Operations group membership: VMs whose summary|tag contains <${groupCat}-value>.`,
            `NSX group membership: VMs with NSX tag ${nsxCat}|value — ${nsxSync ? 'set by the sync from the vCenter tag' : 'set by whatever sets NSX tags'}.`,
            ...(nsxSync ? [`The sync touches only the ${nsxCat} scope, on VMs matched by instance UUID in the vCenters listed.`] : []),
          ],
          ifWrong: 'An NSX group that selects the wrong VMs changes what the firewall allows. A VM missing from an application group loses its allow rules; a VM wrongly in one gains them. Apply the groups before any rule refers to them, and read the membership each apply prints.',
        },
        guardrails: [
          { rule: 'nsx-apply-groups.sh refuses to update a group it did not create (no managed-by|archtoolkit tag), and stops unless reading the existing group answers 200 or 404', because: 'A hand-built group of the same name may have firewall rules on it; silently replacing its criteria changes the firewall. A 401 or 503 read as "absent" would skip that check.' },
          ...(nsxSync
            ? [
                { rule: `The sync only ever changes the ${nsxCat} scope and keeps every other NSX tag`, because: 'NSX tags are also set by other tools and by people; the sync owns one scope and nothing else.' },
                { rule: `The sync refuses more than ${maxChanges} VMs in one run`, because: 'A mass change of NSX tags is a mass change of firewall membership. A wrong vCenter tag run should stop there.' },
                { rule: 'The sync counts every VM whose update fails and exits 1 if any did', because: 'A scheduled run that reports success while half the VMs kept their old tags leaves the firewall groups wrong with nobody told.' },
                { rule: '--prune is off by default and only clears VMs found in the listed vCenters by name and instance UUID', because: 'An NSX Manager serving several vCenters has VMs this script cannot see; it must not strip their tags.' },
              ]
            : []),
          { rule: 'Every script is a dry run without --execute', because: 'Membership is the blast radius; read it first.' },
        ],
        dryRun: [
          'The workflow Apply tag consumers is a dry run until dryRun is set to false in its configuration element: it logs every group it would create or update, every group it refuses, and (SYNC lines, syncPlanJson) every VM whose NSX tags would change.',
          'scripts/vcfops-apply-groups.sh without --execute prints what it would POST.',
          'scripts/nsx-apply-groups.sh without --execute prints which groups it would create and which it refuses.',
          ...(nsxSync ? ['scripts/nsx-tag-sync.sh without --execute lists every VM whose NSX tags would change, before and after.'] : []),
        ],
        undo: [
          'VCF Operations: DELETE /suite-api/api/resources/groups/{id}. Members are untouched.',
          'NSX: DELETE /policy/api/v1/infra/domains/default/groups/{id} — refused by NSX while a rule still uses the group, which is the right order anyway.',
          ...(nsxSync ? ['NSX tags: each sync run keeps its plan (the syncPlanJson output; nsx-tag-sync-<run>.json for the script) with every changed VM’s previous values in the scope (have) and the tag set it sent. To put a VM back, POST update_tags with that set, the scope values swapped back to have.'] : []),
        ],
        told: ['The workflow’s log and audit record (posted to the webhook if set); each script prints the membership count of every group it touched. The NSX audit log records every group and tag change against the NSX account used.'],
        requires: [
          'VCF Operations with the vCenters collected; opsUsername/opsPassword for the workflow, OpsToken access (VCFOPS_TOKEN or VCFOPS_PASSWORD_FILE) for scripts/vcfops-apply-groups.sh.',
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Operations, NSX and vCenter certificates trusted in Orchestrator.',
          `NSX Manager ${nsxHost}, an account with rights on groups and VM tags, and its password in a mode-600 NSX_PASSWORD_FILE.`,
          ...(nsxSync ? VC_REQUIRES : []),
          'The categories and values already created — the tag standard blueprint.',
        ],
        files,
        notes: [
          'NSX tags and vCenter tags are separate. An NSX group with a Tag condition matches NSX tags (scope|tag) on the VM; a vCenter tag does nothing there until something copies it. Some estates tag in NSX only; if the vCenter tag is the source of truth, the sync is what makes the firewall follow it.',
          'VERIFY: the sync reads /api/vcenter/vm/{vm} identity.instance_uuid and calls the NSX realized-state virtual-machines update_tags action, which replaces a VM’s whole tag set. Check both on your NSX and vCenter releases before running with --execute.',
          'VCF Automation reads vCenter tags on discovered compute as key:value, and writes the machine’s tags back to vCenter on vSphere. Capability tags on cloud zones are its own; keep their keys lower case and short.',
          `Groups are generated for at most 30 ${groupCat} values and 50 ${nsxCat} values.`,
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'tags_cleanup',
    platform: PLATFORM,
    label: 'Clean up unused tags, empty categories and near-duplicates',
    group: 'Tags — govern',
    description:
      'Years of hand-made tags leave a catalogue nobody can pick from: tags attached to nothing, categories with no tags, and "Prod", "prod" and "prod " side by side. This finds all three on every vCenter, deletes only what is unused and not in the standard — after writing a full export — and only with --execute, a change ticket and a cap. Near-duplicates in use are reported, never merged.',
    inputs: [
      STANDARD_INPUT,
      VCENTERS_INPUT,
      { id: 'protect', label: 'Never delete from categories', control: 'text', default: '', hint: 'Comma separated, e.g. categories another product creates and expects to find' },
      { id: 'empty_categories', label: 'Also delete empty categories', control: 'toggle', default: true },
      { id: 'max_deletes', label: 'Refuse a run that deletes more than', control: 'number', default: 25, min: 1, max: 10000 },
    ],
    automation: (values: BlueprintValues): Automation => {
      const { categories, findings } = parseStandard(str(values, 'standard', DEFAULT_STANDARD));
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const protect = listOf(str(values, 'protect', ''));
      const emptyCategories = bool(values, 'empty_categories', true);
      const maxDeletes = num(values, 'max_deletes', 25);
      if (maxDeletes > 200) findings.push(warning('tags.cleanup.high-cap', `A cap of ${maxDeletes} deletions per run is high for something that cannot be undone.`, { remediation: 'Clean up in batches of a few dozen, reading each plan. The export makes a restore possible, not pleasant.', source: SRC }));

      const script = [
        '#!/usr/bin/env bash',
        '# Find unused tags, empty categories and near-duplicate names on every vCenter',
        '# in VCENTERS, and — only with --execute — delete the unused ones.',
        '#',
        '#   ./tag-cleanup.sh                                     dry run: cleanup-plan-<run>.csv',
        '#   CHANGE_TICKET=CHG0012345 ./tag-cleanup.sh --execute  delete, after exporting everything',
        '#',
        '# Never deleted: a tag attached to anything (checked again at the moment of',
        '# deleting), any category or value in tag-standard.json, anything in',
        '# PROTECT_CATEGORIES. Near-duplicates that are in use are reported, not merged:',
        '# merging means re-tagging objects, which is tag-assign.sh’s job.',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        vcentersLine(vcenters),
        `MAX_DELETES="\${MAX_DELETES:-${maxDeletes}}"`,
        `PROTECT_CATEGORIES="\${PROTECT_CATEGORIES:-${protect.join(',')}}"`,
        `EMPTY_CATEGORIES="\${EMPTY_CATEGORIES:-${emptyCategories ? 1 : 0}}"`,
        'STANDARD=tag-standard.json',
        'DRY_RUN=1; [[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
        'if (( ! DRY_RUN )); then',
        '  : "${CHANGE_TICKET:?deleting tags cannot be undone: set CHANGE_TICKET to the approved change}"',
        'fi',
        '',
        ...vcLib(),
        '',
        'RUN=$(date -u +%Y%m%dT%H%M%SZ)',
        'mkdir -p backups',
        'PLAN="cleanup-plan-${RUN}.csv"',
        ': > "$WORK/plan.jsonl"',
        'PROTECT=$(jq -cn --arg s "$PROTECT_CATEGORIES" \'$s | split(",") | map(gsub("^\\\\s+|\\\\s+$"; "")) | map(select(length > 0))\')',
        '',
        'for host in ${VCENTERS//,/ }; do',
        '  vc_login "$host"',
        '  load_catalogue "$host" "$WORK/$host.cat.json"',
        '  load_associations "$host" "$WORK/$host.cat.json" "$WORK/$host.asn.json"',
        '  # Guardrail: the full catalogue and every assignment are written out before',
        '  # anything is planned, and the run stops if that file is not valid JSON.',
        '  backup="backups/tags-${host}-${RUN}.json"',
        '  # Same format as tag-backup.sh, so tag-restore.sh can put back anything deleted.',
        '  jq -n --slurpfile c "$WORK/$host.cat.json" --slurpfile a "$WORK/$host.asn.json" --arg vc "$host" \'',
        '    ($c[0].tags | map({key: .id, value: .}) | from_entries) as $tag',
        '    | {vcenter: $vc, format: "archtoolkit-tag-backup/1",',
        '       categories: [$c[0].categories[] | {id, name, description, cardinality, associable_types}],',
        '       tags: [$c[0].tags[] | {id, name, description, category}],',
        '       assignments: [$a[0][] | {category: $tag[.tag_id].category, tag: $tag[.tag_id].name, object_type: .type, object_id: .id, object_name: null}]}\' > "$backup"',
        '  jq -e \'.format == "archtoolkit-tag-backup/1" and (.categories | type) == "array"\' "$backup" >/dev/null',
        '  echo "== $host: exported to $backup"',
        '  jq -r --arg vc "$host" --argjson protect "$PROTECT" --argjson empty "$EMPTY_CATEGORIES" --slurpfile std "$STANDARD" --slurpfile asn "$WORK/$host.asn.json" \'',
        '    ($std[0].categories | map({key: .name, value: .values}) | from_entries) as $S',
        '    | ($asn[0] | group_by(.tag_id) | map({key: .[0].tag_id, value: length}) | from_entries) as $uses',
        '    | (.tags | group_by(.category_id) | map({key: .[0].category_id, value: length}) | from_entries) as $count',
        '    | def key: ascii_downcase | gsub("\\\\s+"; " ") | ltrimstr(" ") | rtrimstr(" ");',
        '      def protected($c): ($protect | index($c)) != null;',
        '      def standard($c; $t): ($S[$c] // []) | index($t) != null;',
        '    [',
        '      (.tags[] | select(($uses[.id] // 0) == 0)',
        '        | if protected(.category) then [$vc, "tag", .category, .name, .id, "keep", "category is protected"]',
        '          elif standard(.category; .name) then [$vc, "tag", .category, .name, .id, "keep", "in the standard, just not used yet"]',
        '          else [$vc, "tag", .category, .name, .id, "delete", "attached to nothing"] end),',
        '      (.categories[] | select(($count[.id] // 0) == 0)',
        '        | if $empty == 0 then [$vc, "category", .name, "", .id, "keep", "empty categories not included"]',
        '          elif protected(.name) or $S[.name] != null then [$vc, "category", .name, "", .id, "keep", "empty, but protected or in the standard"]',
        '          else [$vc, "category", .name, "", .id, "delete", "no tags"] end),',
        '      (.tags | group_by([.category_id, (.name | key)])[] | select(length > 1) | . as $g',
        '        | ($g | max_by($uses[.id] // 0)) as $keep',
        '        | $g[] | select(.id != $keep.id)',
        '        | [$vc, "tag", .category, .name, .id, (if ($uses[.id] // 0) == 0 and (standard(.category; .name) | not) and (protected(.category) | not) then "delete" else "report" end),',
        '           "duplicate of \\"\\($keep.name)\\" (\\($uses[$keep.id] // 0) objects); this one on \\($uses[.id] // 0)"]),',
        '      (.categories | group_by(.name | key)[] | select(length > 1)',
        '        | [$vc, "category", (map(.name) | join(" / ")), "", "", "report", "categories differing only by case or spacing"])',
        '    ] | unique_by(.[1:6]) | .[]\' -c "$WORK/$host.cat.json" >> "$WORK/plan.jsonl"',
        'done',
        '',
        '{ echo "vcenter,kind,category,name,id,action,reason"; jq -r \'@csv\' "$WORK/plan.jsonl"; } > "$PLAN"',
        '# A tag planned twice (unused and a duplicate) is deleted once.',
        '# (A category row has no tag name; "-" keeps the tab-separated fields aligned.)',
        'jq -r \'select(.[5] == "delete") | [.[0], .[1], .[2], (if .[3] == "" then "-" else .[3] end), .[4]] | @tsv\' "$WORK/plan.jsonl" | sort -u > "$WORK/deletes.tsv"',
        'DELETES=$(wc -l < "$WORK/deletes.tsv")',
        'show_table < "$PLAN" | cut -c1-220',
        'echo',
        'echo "$DELETES deletion(s) planned; the rest are kept or only reported. Plan: $PLAN"',
        'if (( DELETES > MAX_DELETES )); then',
        '  echo "Refusing: $DELETES deletions is more than MAX_DELETES=$MAX_DELETES. Delete in smaller batches." >&2',
        '  exit 1',
        'fi',
        'if (( DRY_RUN )); then echo "DRY RUN: nothing was deleted. The exports in backups/ were written anyway."; exit 0; fi',
        '',
        'LOG="cleanup-log-${RUN}.csv"',
        'echo "vcenter,kind,category,name,id,result,ticket" > "$LOG"',
        '# Tags first, then categories: a category is only deleted once it is empty.',
        'for kind in tag category; do',
        '  while IFS=$\'\\t\' read -r host k category name id; do',
        '    [[ "$k" == "$kind" ]] || continue',
        '    if [[ "$kind" == tag ]]; then',
        '      n=$(attached_count "$host" "$id")',
        '      if (( n > 0 )); then result="refused: attached to $n object(s) now"',
        '      else vc DELETE "$host" "/api/cis/tagging/tag/${id}" >/dev/null && result=deleted || result=failed; fi',
        '    else',
        '      n=$(jq -n --arg c "$id" \'{category_id: $c}\' | vc POST "$host" "/api/cis/tagging/tag?action=list-tags-for-category" --data-binary @- | jq length)',
        '      if (( n > 0 )); then result="refused: has $n tag(s) now"',
        '      else vc DELETE "$host" "/api/cis/tagging/category/${id}" >/dev/null && result=deleted || result=failed; fi',
        '    fi',
        '    echo "$kind $category/$name on $host: $result"',
        '    jq -rn --arg a "$host" --arg b "$kind" --arg c "$category" --arg d "$name" --arg e "$id" --arg f "$result" --arg g "$CHANGE_TICKET" \'[$a, $b, $c, $d, $e, $f, $g] | @csv\' >> "$LOG"',
        '  done < "$WORK/deletes.tsv"',
        'done',
        'echo "Log: $LOG. Everything as it was before is in backups/, in the format tag-restore.sh (backup blueprint) reads with --catalogue-only."',
        '',
      ].join('\n');

      const pkg = toPackage({
        packageName: 'com.archtoolkit.tags.cleanup',
        description: `Finds unused tags, empty categories and near-duplicates on ${vcenters.length} vCenter(s) and deletes only the unused ones that are not in the standard, after exporting everything, with a change ticket and at most ${maxDeletes} deletions a run. Generated by ArchToolKit.`,
        categoryPath: 'ArchToolKit/Tags/Cleanup',
        workflow: {
          name: 'Clean up tags',
          description: 'Exports every category, tag and assignment of each vCenter (the exportsJson output, in the backup format), plans — delete what is attached to nothing and not in the standard or a protected category; report near-duplicates in use — and deletes only with a changeTicket, re-checking each tag for attachments and each category for tags at the moment of deleting. A dry run until dryRun is set to false in the configuration element.',
          inputs: [
            { name: 'dryRun', type: 'boolean', description: 'true: plan and export, delete nothing' },
            { name: 'changeTicket', type: 'string', description: 'The approved change; required to delete, recorded against every deletion' },
          ],
          outputs: [
            { name: 'exportsJson', type: 'string', description: 'Everything as it was before, one archtoolkit-tag-backup/1 document per vCenter: the restore input of the tag backup workflow' },
            { name: 'planCsv', type: 'string', description: 'Every candidate with delete, keep or report and the reason' },
            { name: 'cleanupLogCsv', type: 'string', description: 'What was deleted or refused, with the ticket' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: CLEANUP_WORKFLOW,
        },
        actions: vcTagActions('com.archtoolkit.tags.cleanup', ['vcLogin', 'openVcenter', 'readCatalogue', 'readAssociations', 'toCsv']),
        config: {
          name: 'Tag cleanup',
          description: 'Settings of the Clean up tags workflow. Fill vcfApiToken (VCF 9.1) or vcPassword (8.x and 9.0) after import, for an account that reads every object — otherwise attached tags look unused to it.',
          attributes: [
            ...vcAttributes(vcenters, 'read on every object and Delete vSphere Tag and Delete vSphere Tag Category'),
            { name: 'protectCategories', type: 'Array/string', value: protect, description: 'Never delete from these categories' },
            { name: 'emptyCategories', type: 'boolean', value: emptyCategories, description: 'Also delete categories with no tags' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is deleted while this is true' },
            { name: 'cap', type: 'number', value: maxDeletes, description: 'A run planning more deletions than this is refused before the first' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [{ name: 'tag-standard.json', content: standardJson(categories) }],
      });

      return {
        platform: PLATFORM,
        title: `Tag cleanup on ${vcenters.length} vCenter(s) — at most ${maxDeletes} deletions a run`,
        effect: 'irreversible',
        trigger: { kind: 'manual', detail: 'An engineer runs it under a change ticket, after reading the dry-run plan. Not scheduled.' },
        scope: {
          what: `Tags attached to nothing${emptyCategories ? ', and categories with no tags' : ''}, on ${vcenters.join(', ')}, excluding every category and value in the standard${protect.length ? ` and the categories ${protect.join(', ')}` : ''}.`,
          decidedBy: [
            'Usage read from list-attached-objects-on-tags, as the running account can see it.',
            'tag-standard.json: every category and allowed value in it is kept, used or not.',
            'PROTECT_CATEGORIES.',
            'At the moment of each delete, the tag is checked for attachments again and the category for tags again.',
          ],
          ifWrong: 'A tag that looks unused to an account that cannot see every object is deleted from under the objects it could not see — and deleting a tag detaches it everywhere. Run it as an account that reads the whole inventory.',
        },
        guardrails: [
          { rule: 'Deletes only when armed (dryRun false in the configuration element; --execute for the script) and with a change ticket (the changeTicket input; CHANGE_TICKET), and records the ticket against every deletion', because: 'A deletion cannot be undone in vCenter. The ticket is the approval, and the log ties each deletion to it.' },
          { rule: 'Writes a full export of every category, tag and assignment before planning anything', because: 'It is the only way back: the restore script recreates a deleted tag or category from it by name.' },
          { rule: 'Re-checks each tag for attachments immediately before deleting it, and refuses if it has any', because: 'The plan can be minutes old, and somebody may have used the tag since.' },
          { rule: 'Never deletes a category or value that is in the standard', because: 'An allowed value nobody has used yet — Environment=dr — is not clutter; deleting it breaks the next deployment that asks for it.' },
          { rule: `Refuses a run planning more than ${maxDeletes} deletions`, because: 'A wrong standard file or an account that sees too little makes everything look unused.' },
          { rule: 'Near-duplicates in use are reported, not merged', because: 'Merging means re-tagging objects, which moves them between groups; that is a reviewed bulk assignment, not a cleanup.' },
        ],
        dryRun: ['The workflow Clean up tags is a dry run until dryRun is set to false in its configuration element: planCsv and exportsJson are written and nothing is deleted.', './scripts/tag-cleanup.sh without --execute writes cleanup-plan-<run>.csv — every candidate with delete, keep or report and the reason — and the export in backups/, and deletes nothing.'],
        undo: [
          'None in vCenter: a deleted tag is gone, and so is every assignment it had (it had none, or it would not have been deleted).',
          'Recreate from the export: the workflow’s exportsJson output (the script’s backups/tags-<vcenter>-<run>.json) is in the tag backup format, so the tag backup blueprint’s workflow in mode restore with catalogueOnly (or ./scripts/tag-restore.sh backups/tags-<vcenter>-<run>.json <vcenter> --catalogue-only --execute) recreates every deleted category and tag by name. The new tag has a new id — anything that stored the old id will not find it.',
        ],
        told: ['The workflow’s cleanupLogCsv (the change ticket on every row), planCsv and exportsJson outputs and its audit record (posted to the webhook if set); the script writes cleanup-log-<run>.csv, the plan and the export. Attach them to the ticket. vCenter logs each deletion as an event.'],
        requires: [
          ...VC_REQUIRES,
          'An account that can read every object in each vCenter (otherwise attached tags look unused to it) with Delete vSphere Tag and Delete vSphere Tag Category.',
          'A change ticket for the armed run.',
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the vCenter certificates trusted in Orchestrator.',
        ],
        files: {
          ...pkg.files,
          'scripts/tag-standard.json': standardJson(categories),
          'scripts/tag-cleanup.sh': script,
          'IMPORT.md': tagsImport(
            `Nothing is imported into vCenter: the Orchestrator package \`${pkg.packageDir}\` (on the shared core library) compares each vCenter’s catalogue with the standard in its resource element tag-standard.json and deletes only what its plan lists, with the workflow **Clean up tags**. scripts/tag-cleanup.sh does the same from a Linux host.`,
            [
              ...pkg.importSteps,
              { heading: 'Or: the script', lines: ['`./scripts/tag-cleanup.sh` writes cleanup-plan-<run>.csv; `CHANGE_TICKET=<ref> ./scripts/tag-cleanup.sh --execute` exports everything, then deletes.'] },
            ],
            ['If a category is managed by VCF Operations fleet tag management (9.x), delete it there (DELETE /suite-api/api/fleet-management/tag-management/categories/{id}) rather than in vCenter: a later push or import brings back what was deleted in the vCenter.', 'The VCF 9.1 API-token login to vCenter follows davidwzhang.com "VCF 9.1 API Access (4)"; confirm it, or use vcUsername and vcPassword.'],
          ),
        },
        notes: [
          'If a category is managed centrally by VCF Operations fleet tag management, delete it there instead: a later push or import brings back what was deleted in the vCenter.',
          'Duplicates are detected within a category, ignoring case and repeated or trailing spaces. The one on the most objects is named as the keeper in the plan.',
        ],
        findings,
      };
    },
  }),
];
