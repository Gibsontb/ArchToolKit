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

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { applyScript, authHeader, authPreamble, scheduledEnv } from '../apply.js';
import { importGuide,                     } from './vcf-networks-logs.js';
import { blueprintYaml, templatePath } from '../vcfa-import.js';

const PLATFORM = 'vcf-fleet'         ;
const SRC = 'ArchToolKit';

// ---------------------------------------------------------------------------
// The tag standard
// ---------------------------------------------------------------------------

/**
 * Object types a vCenter category can be associated with, as /api/cis/tagging
 * spells them. The fleet API lists fewer (GET .../categories/associable-types);
 * the fleet script checks against that list at run time rather than here.
 */
const OBJECT_TYPES                    = [
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
const FLEET_KINDS                    = ['VirtualMachine', 'HostSystem', 'ClusterComputeResource', 'Datacenter', 'Datastore', 'ResourcePool', 'VirtualApp', 'Folder', 'Network'];

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

                       
                        
                               
                                              
                                
                                    
                                     
                             
                                         
 

function norm(text        )         {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The standard as the scripts read it: snake case, the vCenter API's own field names. */
function standardJson(categories                        )         {
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
function parseStandard(text        , path = 'standard')                                                     {
  const categories                = [];
  const findings            = [];
  const seen = new Map                ();
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
    const lowered = new Map                ();
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

function standardMarkdown(categories                        )         {
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

function vcentersLine(vcenters                   )         {
  return `VCENTERS="\${VCENTERS:-${vcenters.join(' ')}}"`;
}

/** The environment a scheduled vCenter job needs. No secret, only the path to one. */
function vcScheduledEnv(vcenters                   )         {
  return `VCENTERS="${vcenters.join(' ')}" VCF_IDB_HOST=vcenter-mgmt.example.com VCF_API_TOKEN_FILE=/etc/archtoolkit/vcf-api-token`;
}

/**
 * vCenter session handling and the readers every script shares.
 *
 * The password reaches curl as `user = "..."` in a config read from stdin
 * (-K -), and the session id reaches curl as a header read from a file
 * descriptor, so neither is ever an argument a `ps` can see.
 */
function vcLib()           {
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
function fleetLib()           {
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
function psConnect(vcenters                   )           {
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
const POWERCLI_TYPES                                   = {
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

function csvCell(value        )         {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The description each tag carries: the same text create-vcenter.sh writes. */
function tagDescription(category        , value        )         {
  return `${category} ${value} (ArchToolKit tag standard)`;
}

/**
 * The PowerCLI-ready CSV: Category,Cardinality,EntityType,Tag,Description — one
 * row per tag, the category's settings repeated on each. EntityType is the
 * PowerCLI names joined with ";" (All when the category applies to every type).
 * A free-text category has one row with an empty Tag: the category only.
 */
function powercliCsv(categories                        )         {
  const rows = categories.flatMap((c) => {
    const types = c.types.length === 0 ? 'All' : c.types.map((t) => POWERCLI_TYPES[t] ?? t).join(';');
    const card = c.cardinality === 'SINGLE' ? 'Single' : 'Multiple';
    const values = c.values.length === 0 ? [''] : c.values;
    return values.map((v) => [c.name, card, types, v, c.description].map(csvCell).join(','));
  });
  return `${['Category,Cardinality,EntityType,Tag,Description', ...rows].join('\r\n')}\r\n`;
}

function powercliImportScript(vcenters                   )         {
  return [
    '<#',
    '.SYNOPSIS',
    '  Create the tag standard in tag-standard.csv on every vCenter, with PowerCLI.',
    '.DESCRIPTION',
    '  Reads Category,Cardinality,EntityType,Tag,Description. Creates each category',
    '  that does not exist (exact, case-sensitive name) and each tag missing from',
    '  it. Never changes or deletes an existing one; a category that exists with a',
    '  different cardinality is reported. Creates when run; -DryRun previews.',
    '',
    '  VC_USER and VC_PASSWORD_FILE (mode 600) log in; VCENTERS overrides the list.',
    '.EXAMPLE',
    '  pwsh ./Import-TagStandard.ps1 -DryRun    # what it would create',
    '  pwsh ./Import-TagStandard.ps1            # create it',
    '#>',
    '[CmdletBinding()]',
    'param(',
    "  [string]$CsvPath = (Join-Path $PSScriptRoot 'tag-standard.csv'),",
    '  [switch]$DryRun',
    ')',
    '$Execute = -not $DryRun',
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
    "if (-not $Execute) { Write-Output 'Dry run: nothing was created. Run it without -DryRun to create.' }",
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
function vcenterRestFiles(categories                        )                         {
  const files                         = {};
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
function tagsImport(intro        , steps                                         , verify                    = [])         {
  return importGuide({ product: 'vCenter and VCF Operations tag management', intro, steps, verify, sources: TAG_SOURCES });
}

/** IMPORT.md for the standard: every format, and which one goes where. */
function taxonomyImport(categories                        , route        )         {
  const tags = categories.reduce((n, c) => n + c.values.length, 0);
  const unconfirmed = [...new Set(categories.flatMap((c) => c.types))].filter((t) => POWERCLI_UNCONFIRMED.includes(t));
  return importGuide({
    product: 'vCenter and VCF Operations tag management',
    intro: `The same standard — ${categories.length} categories, ${tags} tags — in each form tags are imported with. Pick one route per vCenter; every route creates only what is missing.`,
    steps: [
      {
        heading: 'Route A — the scripts (this blueprint’s default)',
        lines: [
          route === 'fleet'
            ? '`./create-fleet.sh` (add `--dry-run` first to preview): creates the categories and tags in VCF Operations fleet tag management and pushes them to the vCenters.'
            : '`./create-vcenter.sh` (add `--dry-run` first to preview): sends exactly the bodies under import/vcenter-rest/ to every vCenter in VCENTERS, filling each tag’s category_id with the id its category got.',
          ...(route === 'both' ? ['', 'Then `FLEET_ADAPTERS=<vCenter adapter ids> ./create-fleet.sh`: imports the categories from those vCenters into VCF Operations fleet tag management.'] : []),
        ],
      },
      {
        heading: 'Route B — PowerCLI with the CSV',
        lines: [
          'import/powercli/tag-standard.csv has the columns Category,Cardinality,EntityType,Tag,Description (one row per tag; EntityType is PowerCLI names separated by ";"). Run from import/powercli:',
          '',
          '```',
          'pwsh ./Import-TagStandard.ps1 -DryRun    # preview',
          'pwsh ./Import-TagStandard.ps1            # create',
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
          'VCF Operations does not import tags from a file. Its import is from a vCenter: create the standard in one vCenter by route A, B or C, then Manage > Fleet Management > Tags > Import from vCenter (or create-fleet.sh, which calls the same import), and push to the other vCenters from there. Or create it centrally (route "fleet only") and push — but not both, or every category gets two ids.',
        ],
      },
    ],
    verify: [
      'VCF Operations 9.1 tag management file import: none found in the 9.0 and 9.1 descriptions; if your build offers one, compare its template with import/powercli/tag-standard.csv.',
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
  control: 'tag-standard'         ,
  default: DEFAULT_STANDARD,
  hint: 'Pick categories, then their object types and tags. The other tag automations use what you build here.',
};

const VCENTERS_INPUT = { id: 'vcenters', label: 'vCenters', control: 'text'         , default: DEFAULT_VCENTERS, hint: 'Comma separated. Every script also takes VCENTERS from the environment' };

// ---------------------------------------------------------------------------
// 1. The standard, and the script that creates it
// ---------------------------------------------------------------------------

function createVcenterScript(vcenters                   )         {
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
    '#   ./create-vcenter.sh                              create it; ids go to created-<run>.tsv',
    '#   ./create-vcenter.sh --dry-run                    list what would be created, change nothing',
    '#   ./create-vcenter.sh --undo created-<run>.tsv [--dry-run]',
    '#                                                    delete what that run created, if unattached',
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    vcentersLine(vcenters),
    'STANDARD=tag-standard.json',
    'DRY_RUN=0; UNDO=""',
    'while (( $# )); do',
    '  case "$1" in',
    '    --dry-run) DRY_RUN=1 ;;',
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
    '  echo "DRY RUN: $WOULD object(s) would be created, $PROBLEMS problem(s) need a person. Run it without --dry-run to create them."',
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
function createFleetScript(mode                     )         {
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
          '#   ./create-fleet.sh --dry-run          what fleet management has today,',
          '#                                        and which adapters it would import from',
          '#   ./create-fleet.sh                    import from each adapter in FLEET_ADAPTERS,',
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
          '#   ./create-fleet.sh --dry-run          list what would be created',
          '#   ./create-fleet.sh                    create what is missing',
          '#   ./create-fleet.sh --push             ...then push the categories to every',
          '#                                        vCenter adapter in FLEET_PUSH_ADAPTERS',
          '#   ./create-fleet.sh --import [--dry-run]  import from FLEET_ADAPTERS instead',
          '#   ./create-fleet.sh --list-adapters    list vCenter adapter ids',
        ]),
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    'STANDARD=tag-standard.json',
    `DRY_RUN=0; PUSH=0; LIST=0; MODE=${mode}`,
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --dry-run) DRY_RUN=1 ;;',
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
    '    else echo "MISSING category $name after the import. Is it in the vCenters behind FLEET_ADAPTERS? Run create-vcenter.sh first."; PROBLEMS=$((PROBLEMS + 1)); fi',
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
    '  if [[ "$MODE" == import ]]; then echo "DRY RUN: nothing was imported, $PROBLEMS problem(s). Run it without --dry-run to import."',
    '  else echo "DRY RUN: $WOULD object(s) would be created, $PROBLEMS problem(s). Run it without --dry-run to create them."; fi',
    'elif [[ "$MODE" == import ]]; then',
    '  (( PROBLEMS == 0 )) && echo "Every category and value of the standard is in fleet tag management, imported from vCenter."',
    'fi',
    '(( PROBLEMS == 0 ))',
    '',
  ].join('\n');
}

export const VCF_TAGS                                 = [
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
    automation: (values                 )             => {
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

      return {
        platform: PLATFORM,
        title: `Tag standard — ${categories.length} categories, ${categories.reduce((n, c) => n + c.values.length, 0)} values`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: both ? 'An engineer runs create-vcenter.sh after the standard is reviewed, then create-fleet.sh to import what it created into fleet tag management; again, in that order, whenever a value is added.' : 'An engineer runs the create script after the standard is reviewed, and again whenever a value is added to it.' },
        scope: {
          what: `The tag catalogue — categories and tags, not assignments — on ${vcenter ? vcenters.join(', ') : 'no vCenter directly'}${fleet ? ', and in VCF Operations fleet tag management' : ''}.`,
          decidedBy: [
            'The lines in tag-standard.json: one category per line, one tag per allowed value.',
            vcenter ? 'VCENTERS, or the list baked into create-vcenter.sh.' : 'The vCenter adapters named in FLEET_PUSH_ADAPTERS, if --push is given.',
            ...(both ? ['FLEET_ADAPTERS: the vCenters create-fleet.sh imports from. An import brings in everything in that vCenter’s catalogue, not only the standard.'] : []),
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
          ...(vcenter ? ['./create-vcenter.sh --dry-run lists every category and tag it would create on each vCenter, and every drift it found.'] : []),
          ...(fleet ? [both ? './create-fleet.sh --dry-run lists which adapters it would import from and which categories and values fleet management does not have yet. Its queries are reads.' : './create-fleet.sh --dry-run does the same against fleet tag management. Its queries are reads.'] : []),
        ],
        undo: [
          ...(vcenter ? ['create-vcenter.sh writes every id it created to created-<run>.tsv. ./create-vcenter.sh --undo created-<run>.tsv deletes those tags and categories again, skipping any that are now attached to something.'] : []),
          ...(fleet && !both ? ['In fleet tag management, delete the tags then the category (DELETE .../categories/{id}/tags/{tagId}, then .../categories/{id}). You cannot delete a tag assigned to objects. A category already pushed to a vCenter stays there when deleted centrally — delete it in that vCenter too.'] : []),
          ...(both ? ['An import makes fleet management manage the vCenter’s category. To hand it back, disengage the vCenter from the category (Fleet Management > Tags > the category > Available In > Remove, or the tags_sync_control blueprint). Deleting it centrally does not delete it from the vCenter.'] : []),
        ],
        told: [`The terminal that ran it${vcenter ? ', and created-<run>.tsv for the vCenter route' : ''}. Commit tag-standard.json and TAG-STANDARD.md to the repository the change was reviewed in.${fleet ? ' Fleet tasks and any conflicts also show under Manage > Fleet Management > Tags.' : ''}`],
        requires: [
          ...(vcenter ? [...VC_REQUIRES, 'The vCenter account needs Tagging > Create vSphere Tag Category and Create vSphere Tag (and Delete for --undo).'] : []),
          ...(fleet ? ['VCF Operations 9.1.1 or later, an API client whose API token is in VCF_API_TOKEN_FILE, and the Tags Manage permission (tag_management.manage) for it.'] : []),
          ...(both ? ['Import needs each vCenter at 9.0 or later, licensed for VCF 9 and integrated with this VCF Operations (the documented requirements). A vSphere 8 vCenter can only take the vCenter route.'] : []),
        ],
        files: {
          'tag-standard.json': standardJson(categories),
          'TAG-STANDARD.md': standardMarkdown(categories),
          ...(vcenter ? { 'create-vcenter.sh': createVcenterScript(vcenters) } : {}),
          ...(fleet ? { 'create-fleet.sh': createFleetScript(vcenter ? 'import' : 'create') } : {}),
          'import/powercli/tag-standard.csv': powercliCsv(categories),
          'import/powercli/Import-TagStandard.ps1': powercliImportScript(vcenters),
          ...vcenterRestFiles(categories),
          'IMPORT.md': taxonomyImport(categories, route),
        },
        notes: [
          'In VCF 9, fleet tag management is where the catalogue should live. There are two consistent ways to get it there, and mixing them is what breaks: create it centrally and push it to vCenters that do not have it (route "fleet only"), or create it in vCenter and import it (route "both", the order this blueprint uses). Creating it in both places gives every category two ids.',
          ...(both ? ['Order for route "both": ./create-vcenter.sh, then FLEET_ADAPTERS=<ids> ./create-fleet.sh. POST .../tag-management/adapters/{adapterId}/categories/pull takes no body and answers 202 with a taskId (9.1.1 API reference). VERIFY on your release: how an import reconciles the same category name arriving from a second vCenter — the documentation lists conflicts under View Conflict Details but does not spell out the rule; the script reports a FAILED task and every category still missing afterwards.'] : []),
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
    automation: (values                 )             => {
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const variant = str(values, 'variant', 'both');
      const maxChanges = num(values, 'max_changes', 200);
      const sample = str(values, 'sample', '').split('\n').map((l) => l.trim()).filter(Boolean);
      const bash = variant !== 'powershell';
      const ps = variant !== 'bash';

      const findings            = [];
      const header = sample[0] ?? '';
      if (header.replace(/\s/g, '').toLowerCase() !== 'vcenter,object_type,object,category,tag') {
        findings.push(error('tags.assign.header', 'The first line must be the header vcenter,object_type,object,category,tag.', { path: 'sample', source: SRC }));
      }
      const rows = sample.slice(1);
      rows.forEach((row, index) => {
        const cells = row.split(',');
        if (cells.length !== 5) findings.push(error('tags.assign.row', `Row ${index + 2} has ${cells.length} fields, not 5.`, { path: 'sample', remediation: 'Names containing commas are not supported in this CSV; use the MoRef instead.', source: SRC }));
        else if (!OBJECT_TYPES.includes(cells[1] .trim())) findings.push(error('tags.assign.type', `Row ${index + 2}: "${cells[1]}" is not an object type.`, { path: 'sample', source: SRC }));
      });
      if (rows.length > maxChanges) findings.push(warning('tags.assign.over-cap', `The CSV has ${rows.length} rows and the cap is ${maxChanges}; the run will refuse if more than ${maxChanges} of them are changes.`, { remediation: 'Split the CSV, or raise the cap deliberately after reading the dry run.', source: SRC }));
      if (maxChanges > 2000) findings.push(warning('tags.assign.high-cap', `A cap of ${maxChanges} is not much of a cap.`, { remediation: 'The cap is what turns a wrong CSV into a small incident. A few hundred per run is plenty.', source: SRC }));
      const unknownVc = [...new Set(rows.map((r) => r.split(',')[0] .trim()))].filter((v) => v && !vcenters.includes(v));
      if (unknownVc.length > 0) findings.push(info('tags.assign.other-vcenter', `${unknownVc.join(', ')} appear in the CSV but not in the vCenter list. The scripts log in to whatever the CSV names.`, { source: SRC }));

      const bashScript = [
        '#!/usr/bin/env bash',
        '# Attach tags from a CSV: vcenter,object_type,object,category,tag',
        '# (object is a name or a MoRef such as vm-2041).',
        '#',
        '#   ./tag-assign.sh [assignments.csv]                   make the changes; change-log-<run>.csv',
        '#   ./tag-assign.sh [assignments.csv] --dry-run         plan-<run>.csv lists every change, nothing changed',
        '#   ./tag-assign.sh ... --replace                       allow replacing the value of a one-value category',
        '#   ./tag-assign.sh --undo change-log-<run>.csv [--dry-run]   put every object back as it was',
        '#',
        `# Refuses a run with more than MAX_CHANGES changes (default ${maxChanges}).`,
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        `MAX_CHANGES="\${MAX_CHANGES:-${maxChanges}}"`,
        'CSV=assignments.csv; DRY_RUN=0; REPLACE=0; UNDO=""',
        'while (( $# )); do',
        '  case "$1" in',
        '    --dry-run) DRY_RUN=1 ;;',
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
        '  (( DRY_RUN )) && echo "DRY RUN: $n object(s) would be put back. Run it without --dry-run to put them back."',
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
        'if (( DRY_RUN )); then echo "DRY RUN: nothing was changed. Read $PLAN, then run it without --dry-run to apply."; exit 0; fi',
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
        'echo "Undo: ./tag-assign.sh --undo $LOG"',
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
        '  Applies when run; -DryRun only lists. Lists every change first, refuses more than',
        '  -MaxChanges, refuses to overwrite a one-value category unless -Replace, and',
        '  writes change-log-<run>.csv with the before and after of every object.',
        '  -UndoLog <change-log> puts every object back as it was.',
        '#>',
        'param(',
        "  [string]$CsvPath = 'assignments.csv',",
        '  [switch]$DryRun,',
        '  [switch]$Replace,',
        `  [int]$MaxChanges = ${maxChanges},`,
        '  [string]$UndoLog',
        ')',
        '$Execute = -not $DryRun',
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
        "  if (-not $Execute) { Write-Host 'DRY RUN: nothing was changed. Read the plan, then run it without -DryRun to apply.'; return }",
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
        '  Write-Host "$okCount change(s) confirmed. Before and after: $logFile. Undo: ./Tag-Assign.ps1 -UndoLog $logFile"',
        '  if ($stopped) { throw "STOPPED at the first failure ($stopped). Rows after it were not attempted; fix the cause and re-run the same CSV." }',
        '}',
        'finally {',
        '  Disconnect-VIServer -Server * -Confirm:$false -ErrorAction SilentlyContinue',
        '}',
        '',
      ].join('\n');

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
          { rule: 'A replace whose new value does not take re-attaches the old value at once and stops the run', because: 'Detach-then-attach leaves the object with no value in between. Without the immediate roll-back, a failed attach leaves a prod VM with no Environment, out of every group that selects on it.' },
          { rule: 'Stops at the first change that does not take', because: 'The next rows usually fail the same way (a missing privilege, a lost session). Re-running the same CSV plans only what is still missing.' },
          { rule: 'Refuses a CSV that gives one object two different values of a one-value category, listing the rows', because: 'Whichever row runs second silently wins, or replaces the first; either way the CSV said two things and one is lost.' },
        ],
        dryRun: [
          ...(bash ? ['./tag-assign.sh --dry-run writes plan-<run>.csv — every row with its MoRef, the current value and the action — and changes nothing.'] : []),
          ...(ps ? ['./Tag-Assign.ps1 -DryRun does the same with PowerCLI.'] : []),
        ],
        undo: [
          ...(bash ? ['./tag-assign.sh --undo change-log-<run>.csv detaches every tag the run attached and re-attaches every value it replaced.'] : []),
          ...(ps ? ['./Tag-Assign.ps1 -UndoLog change-log-<run>.csv does the same.'] : []),
          'The undo works from what is on each object now rather than from the result column, newest row first: it detaches the value the run attached if it is there, and re-attaches the replaced value if it is missing. So it is right for a log left by a run that stopped or was killed half way (rows still marked pending included), and running it twice changes nothing the second time.',
        ],
        told: ['plan-<run>.csv and change-log-<run>.csv beside the script; attach them to the change record. vCenter records every attach and detach as an event against the object.'],
        requires: [
          ...(bash ? VC_REQUIRES : []),
          ...(ps ? ['PowerShell 7 and PowerCLI (VMware.VimAutomation.Core) for Tag-Assign.ps1, with VCENTERS, VC_USER and VC_PASSWORD_FILE set the same way.'] : []),
          'Tagging > Assign or Unassign vSphere Tag on the objects (and on the root to be simple about it), plus read on the objects.',
          'The categories and tags already created — run the tag standard blueprint first.',
        ],
        files: {
          'assignments.csv': `${sample.join('\n')}\n`,
          ...(bash ? { 'tag-assign.sh': bashScript } : {}),
          ...(ps ? { 'Tag-Assign.ps1': psScript } : {}),
          'IMPORT.md': tagsImport(
            'assignments.csv is the bulk-assignment file. Neither vCenter nor VCF Operations imports an assignment CSV, so the scripts beside it are the import: they resolve each row to the object on its vCenter and attach the tag (POST /api/cis/tagging/tag-association/{tag}?action=attach-multiple-tags-to-object style calls, or PowerCLI New-TagAssignment).',
            [
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
              ...(bash ? [{ heading: 'Assign with the bash script', lines: ['`./tag-assign.sh assignments.csv` makes the changes and writes change-log-<run>.csv, which `./tag-assign.sh --undo change-log-<run>.csv` reverses; add `--dry-run` first to write plan-<run>.csv listing every change without applying it. Add `--replace` to allow changing the value of a one-value category.'] }] : []),
              ...(ps ? [{ heading: bash ? 'Or with PowerCLI' : 'Assign with PowerCLI', lines: ['`pwsh ./Tag-Assign.ps1 -CsvPath assignments.csv` (add `-DryRun` first to preview). VC_USER and VC_PASSWORD_FILE log in.'] }] : []),
              { heading: 'VCF 9.1', lines: ['Assignments made in vCenter appear in VCF Operations tag management (Manage > Fleet Management > Tags) with the next sync; 9.1 can also assign there by hand. There is no CSV import in either place (VERIFY on your build).'] },
            ],
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
      { id: 'exclude_tag', label: 'Never touch VMs tagged', control: 'text', fromTags: 'tag'         , default: 'Automation=never', hint: 'Category=Tag. Empty means no escape hatch' },
      { id: 'max_changes', label: 'Refuse a run that changes more than (VMs)', control: 'number', default: 100, min: 1, max: 20000 },
      { id: 'hour', label: 'Run daily at (hour, server time)', control: 'number', default: 3, min: 0, max: 23 },
      { id: 'scheduled_execute', label: 'Let the scheduled run make changes', control: 'toggle', default: true, hint: 'Off: the schedule only reports what it would do' },
    ],
    automation: (values                 )             => {
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const excludeTag = str(values, 'exclude_tag', '');
      const maxChanges = num(values, 'max_changes', 100);
      const hour = num(values, 'hour', 3);
      const scheduledExecute = bool(values, 'scheduled_execute', true);
      const findings            = [];
      const kinds = ['name', 'folder', 'cluster', 'guestos', 'tag'];
      const rules                                                                                   = [];
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
      const byCategory = new Map                     ();
      for (const rule of rules) byCategory.set(rule.category, (byCategory.get(rule.category) ?? new Set()).add(rule.tag));
      for (const [category, tags] of byCategory) {
        if (tags.size > 1) findings.push(info('tags.rules.overlap', `${category} is set by rules for ${[...tags].join(', ')}. A VM two of them match is reported as a conflict and left alone.`, { source: SRC }));
      }
      if (scheduledExecute) findings.push(warning('tags.rules.scheduled-execute', 'The scheduled run makes changes without anyone reading the plan first.', { remediation: 'Run it report-only on the schedule for a couple of weeks, read the plans, and only then switch this on. The cap still applies.', source: SRC }));

      const script = [
        '<#',
        '.SYNOPSIS',
        '  Tag VMs from rules in tag-rules.json. Applies when run; -DryRun previews.',
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
        '  [switch]$DryRun,',
        `  [int]$MaxChanges = ${maxChanges},`,
        "  [string]$RulesPath = 'tag-rules.json',",
        "  [string]$OutDir = 'reports',",
        `  [string]$ExcludeTag = '${excludeTag.replace(/'/g, "''")}',`,
        '  [string]$UndoLog',
        ')',
        '$Execute = -not $DryRun',
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
        '  Write-Host "$okCount change(s) confirmed. Before and after: $logFile. Undo: ./Tag-Rules.ps1 -UndoLog $logFile"',
        '  if ($stopped) { throw "STOPPED at the first failure ($stopped). Later changes were not attempted; the next run plans them again." }',
        '}',
        'finally {',
        '  Disconnect-VIServer -Server * -Confirm:$false -ErrorAction SilentlyContinue',
        '}',
        '',
      ].join('\n');

      const cron = [
        '# Tag rules, daily. No secret here: VCF_API_TOKEN_FILE is a path to a mode-600 file (VC_USER + VC_PASSWORD_FILE on 8.x/9.0).',
        `# ${scheduledExecute ? 'This schedule makes changes (capped).' : 'This schedule only reports (-DryRun). Remove -DryRun once the plans have been right for a while.'}`,
        `0 ${hour} * * * cd /opt/archtoolkit/tag-rules && ${vcScheduledEnv(vcenters)} pwsh -NoProfile -File ./Tag-Rules.ps1${scheduledExecute ? '' : ' -DryRun'} >> reports/tag-rules.log 2>&1`,
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Rule-based VM tagging — ${rules.length} rules, daily at ${String(hour).padStart(2, '0')}:00`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `Daily at ${String(hour).padStart(2, '0')}:00 from cron (or Windows Task Scheduler), ${scheduledExecute ? 'making changes' : 'report-only until -DryRun is removed'}.`, worstCase: 'once a day, across every VM on every vCenter listed' },
        scope: {
          what: `Virtual machines on ${vcenters.join(', ')}, in the categories the rules name, never those tagged ${excludeTag || '(nothing — no exclusion set)'}.`,
          decidedBy: [
            'The rules in tag-rules.json, in the order written.',
            'Which VMs match: a name regex (case-insensitive, .NET syntax), membership anywhere under a folder or in a cluster of that name, the guest OS name, or a tag already present.',
            'Fill-only rules act only on a category the VM has no value in, whether it takes one value or several; authoritative rules also replace a different value in a one-value category, and add their value to a several-value category that already has others.',
            `The exclusion tag ${excludeTag || '(none)'}, checked before any rule.`,
          ],
          ifWrong: 'A rule wider than meant — a regex without an anchor, a folder name that exists twice — re-tags hundreds of VMs, and every custom group, NSX group and placement decision keyed on that tag follows. The cap stops the run; the log undoes it.',
        },
        guardrails: [
          { rule: `Refuses the whole run if more than ${maxChanges} VMs would change`, because: 'A new rule that matches everything is the realistic failure. The first run after it is refused instead of re-tagging the estate.' },
          { rule: 'Fill-only by default: a category that already has a value on the VM — one or several — is never changed or added to unless the rule is authoritative', because: 'A person who tagged a VM by hand knew something the naming convention did not. Adding Application=payments next to a hand-set Application=web-portal would put the VM in both firewall groups.' },
          { rule: 'Writes the log as it goes, and a replace whose new value does not take re-attaches the old value at once and stops the run', because: 'Detach-then-attach leaves the VM with no value in between; a failure there without the roll-back leaves it out of every group that selects on the category, with no record to undo from.' },
          { rule: 'Rules that disagree about a one-value category change nothing and are reported', because: 'Picking one silently means the VM’s environment depends on the order rules happen to be read in.' },
          ...(excludeTag ? [{ rule: `VMs tagged ${excludeTag} are never touched`, because: 'An owner can take a VM out of the automation at once, without editing it.' }] : []),
          { rule: `The schedule is ${scheduledExecute ? 'set to act, still capped' : 'report-only'}`, because: 'Nobody reads the plan of a scheduled run. Report-only until the plans have been right for a while.' },
        ],
        dryRun: ['./Tag-Rules.ps1 -DryRun writes reports/tag-rules-plan-<run>.csv and reports/tag-rules-conflicts-<run>.csv and changes nothing.'],
        undo: ['./Tag-Rules.ps1 -UndoLog reports/tag-rules-log-<run>.csv removes every tag the run attached and puts back every value it replaced. It works from what is on each VM now, newest row first, so it is right for the log of a run that stopped half way (rows still marked pending included) and changes nothing when run twice.'],
        told: ['reports/tag-rules-log-<run>.csv for changes, reports/tag-rules-conflicts-<run>.csv for everything a person has to settle. Point whoever owns the standard at the conflicts file; it is the useful half.'],
        requires: [
          'PowerShell 7 and PowerCLI (VMware.VimAutomation.Core) on the machine that runs it.',
          'VCENTERS, VC_USER and VC_PASSWORD_FILE (a file readable only by the account running the job) in the job’s environment.',
          'Tagging > Assign or Unassign vSphere Tag on the VMs, and read on folders and clusters.',
          'Every Category=Tag the rules set must already exist; a rule whose tag is missing is skipped and reported.',
        ],
        files: {
          'tag-rules.json': `${JSON.stringify(rules, null, 2)}\n`,
          'Tag-Rules.ps1': script,
          'crontab.txt': cron,
          'IMPORT.md': tagsImport('tag-rules.json is read by Tag-Rules.ps1; no product imports it. vCenter has no rule-based tagging of its own, which is what the script supplies.', [
            { heading: 'Run it', lines: ['`pwsh ./Tag-Rules.ps1 -DryRun` to preview, then `pwsh ./Tag-Rules.ps1`, from a host with PowerCLI; then install the line in crontab.txt with `crontab -e`.'] },
          ]),
        },
        notes: [
          'Name patterns use .NET regular expressions and -match, which is case-insensitive. ^prd- also matches PRD-.',
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
      { id: 'ignore_categories', label: 'Ignore categories', control: 'text', fromTags: 'categories'         , default: '', hint: 'Comma separated, e.g. categories another product owns' },
      { id: 'exclude_names', label: 'Ignore objects whose name matches', control: 'text', default: '^vCLS', hint: 'A regular expression; system VMs that are never tagged' },
      { id: 'webhook', label: 'Post a summary to', control: 'text', default: '', hint: 'Optional webhook URL' },
      { id: 'hour', label: 'Run daily at (hour, server time)', control: 'number', default: 6, min: 0, max: 23 },
    ],
    automation: (values                 )             => {
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

      return {
        platform: PLATFORM,
        title: `Tag compliance — ${vcenters.length} vCenter(s) against ${categories.length} categories`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Daily at ${String(hour).padStart(2, '0')}:00 from cron; also worth running before and after any bulk tagging change.`, worstCase: 'once a day; each run reads every tag, every assignment and every VM once' },
        scope: {
          what: `Reads the tag catalogue, every tag assignment, and the inventory of ${vcenters.join(', ')}. Changes nothing.`,
          decidedBy: [
            'VCENTERS, or the list baked into the script.',
            'tag-standard.json: which categories exist, their values and cardinality, and which object types must carry each.',
            `IGNORE_CATEGORIES${ignore ? ` (${ignore})` : ''} and EXCLUDE_NAMES (${exclude || 'none'}).`,
          ],
          ifWrong: 'A standard that does not match reality reports thousands of problems and gets ignored. Start with the threshold where the estate is and lower it; do not start at zero.',
        },
        guardrails: [
          { rule: 'Reads only: GET and the tagging list-* actions, nothing else', because: 'A compliance report that can change what it reports on stops being evidence.' },
          { rule: `Exits 1 above ${maxProblems} problems`, because: 'The scheduler alerts on the exit code; a report nobody opens is the usual end of a tagging programme.' },
          { rule: 'The password file must be mode 600 or the script refuses to start', because: 'A scheduled job’s credential file is the one most often left world-readable.' },
        ],
        dryRun: ['It is a read. Run it by hand once and read the CSV before scheduling it.'],
        undo: ['Nothing to undo. Delete old reports when you no longer need them.'],
        told: [`reports/tag-compliance-<run>.csv every run${webhook ? `, a summary to ${webhook}` : ''}, and the exit code to whatever scheduled it.`],
        requires: [...VC_REQUIRES, 'Read-only access to every object and read on every tag and category — a read-only role at the vCenter root is enough.'],
        files: {
          'IMPORT.md': tagsImport('Nothing is imported: tag-compliance.sh reads every vCenter (or the fleet API) and compares against tag-standard.json.', [
            { heading: 'Run it, then schedule it', lines: ['`./tag-compliance.sh` from /opt/archtoolkit/tag-compliance, then install the line in crontab.txt with `crontab -e`.'] },
          ]),
          'tag-standard.json': standardJson(categories),
          'tag-compliance.sh': script,
          'crontab.txt': [
            '# Tag compliance, daily. No secret here: VCF_API_TOKEN_FILE is a path to a mode-600 file (VC_USER + VC_PASSWORD_FILE on 8.x/9.0).',
            `0 ${hour} * * * cd /opt/archtoolkit/tag-compliance && ${vcScheduledEnv(vcenters)} ./tag-compliance.sh >> reports/tag-compliance.log 2>&1 || echo "tag compliance over threshold" | logger -t archtoolkit`,
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
      { id: 'adapters', label: 'vCenter adapter ids', control: 'text', default: '', hint: 'Comma separated; ./sync-control.sh --list-adapters shows them. Or set FLEET_ADAPTERS' },
      { id: 'categories', label: 'Categories', control: 'text', fromTags: 'categories'         , default: 'Environment, Owner, CostCenter', hint: 'For push and disengage', showWhen: { input: 'action', equals: ['push', 'disengage'] } },
      { id: 'overwrite', label: 'Overwrite category properties in vCenter on push', control: 'toggle', default: false, showWhen: { input: 'action', equals: ['push'] } },
      { id: 'vcenter', label: 'vCenter to disengage', control: 'text', default: 'vc-wld01.example.com', showWhen: { input: 'action', equals: ['disengage'] } },
    ],
    automation: (values                 )             => {
      const action = str(values, 'action', 'pull');
      const adapters = listOf(str(values, 'adapters', ''));
      const categories = listOf(str(values, 'categories', 'Environment, Owner, CostCenter'));
      const overwrite = bool(values, 'overwrite', false);
      const vcenter = str(values, 'vcenter', 'vc-wld01.example.com');
      const findings            = [];
      if (adapters.length === 0 && action !== 'export' && action !== 'disengage') {
        findings.push(info('tags.sync.adapters-at-runtime', 'No adapter ids given, so the script takes them from FLEET_ADAPTERS when it runs.', { remediation: 'Run ./sync-control.sh --list-adapters to see them.', source: SRC }));
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
        '#   ./sync-control.sh pull [--dry-run]         import categories from each adapter in FLEET_ADAPTERS',
        '#   ./sync-control.sh push [--dry-run]         push FLEET_CATEGORIES to each adapter in FLEET_ADAPTERS',
        '#   ./sync-control.sh disengage                guided: export, the steps in the interface, export, diff',
        '#',
        '# Every pull and push exports the whole catalogue and every assignment first,',
        '# runs one background task at a time and waits for it, then exports again and',
        '# prints what changed. With --dry-run, pull and push only say what they',
        '# would do.',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        `FLEET_ADAPTERS="\${FLEET_ADAPTERS:-${adapters.join(' ')}}"`,
        `FLEET_CATEGORIES="\${FLEET_CATEGORIES:-${categories.join(',')}}"`,
        `OVERWRITE="\${OVERWRITE:-${overwrite ? 'true' : 'false'}}"`,
        'MODE="${1:-}"; shift || true',
        'DRY_RUN=0; LABEL=""',
        'for arg in "$@"; do',
        '  case "$arg" in',
        '    --dry-run) DRY_RUN=1 ;;',
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
        '      echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
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
        '1. `./sync-control.sh export baseline` and keep the file with the change record.',
        '2. Run the tag compliance report, so the drift you are about to fix — or create — is on record.',
        '3. Check nobody else is importing: the interface refuses a second import from the same domain while one is running, and warns you.',
        '',
        '## Doing it',
        '',
        ...(action === 'pull'
          ? [
              'Interface: Manage > Fleet Management > Tags > Import, choose the VCF domain, Import. If some categories cannot be imported, open View Conflict Details from the banner — the banner cannot be reopened once dismissed.',
              '',
              'API: `./sync-control.sh pull` — POST .../tag-management/adapters/{adapterId}/categories/pull per adapter, then GET .../tasks/{taskId} until SUCCESS or FAILED.',
              '',
              'Requirements from the documentation: the vCenter is 9.0 or later, licensed for VCF 9, integrated with this VCF Operations, and you hold Tags Manage.',
            ]
          : action === 'push'
            ? [
                'Interface: Manage > Fleet Management > Tags, tick up to 20 categories, Push Categories, choose VCF Domain vCenter Instances or a Tag Group custom group, optionally tick overwrite, Push.',
                '',
                'API: `./sync-control.sh push` — POST .../tag-management/adapters/{adapterId}/categories/push with {categoryIds, overwrite} per adapter, 20 categories at a time.',
                '',
                'Conflicts that fail the push whatever overwrite says: the same category is single in one place and multiple in the other; VCF Operations has fewer object types than the vCenter; the same name has a different id. Resolve them in VCF Operations (widen it to match) or in the vCenter (rename or delete the stray one).',
              ]
            : action === 'disengage'
              ? [
                  `Interface only — the 9.1.1 Tag Management API has no call for it. \`./sync-control.sh disengage\` exports before, prints these steps, waits, and exports after.`,
                  '',
                  `For each of ${categories.join(', ')}: Manage > Fleet Management > Tags > Tag Definitions > the double arrow next to the category > Available In > tick ${vcenter} > Remove > tick the acknowledgment > Remove.`,
                  '',
                  'What it means, from the documentation: VCF Operations can no longer unassign tags of that category on objects in that vCenter (a lock icon shows it); deleting the tag or category in VCF Operations leaves it in that vCenter. The 9.1 release describes this as disengaging tag management: synchronisation stops for those tags, and the metadata stays where it is.',
                ]
              : ['`./sync-control.sh export <label>` writes every category, tag and tagged resource to exports/fleet-inventory-<label>.json, sorted so two exports diff cleanly.']),
        '',
        '## After',
        '',
        '1. `./sync-control.sh export after` (pull and push do this themselves) and read the diff.',
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
          { rule: 'pull and push apply when run; --dry-run previews them', because: 'The dry run names every adapter and category it would touch.' },
        ],
        dryRun: [
          action === 'disengage' ? './sync-control.sh export baseline, then read which categories and tagged objects the vCenter has before touching anything.' : `./sync-control.sh ${action === 'export' ? 'export baseline' : action} --dry-run lists what it would do and calls nothing that changes state.`,
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
        told: ['exports/fleet-inventory-<run>-before.json and -after.json and the printed diff; attach all three to the change record. Task results and conflicts also show under Manage > Fleet Management > Tags, until the banner is dismissed.'],
        requires: [
          'VCF Operations 9.1.1 or later for the API (9.1 for disengage in the interface), with the vCenters integrated and at 9.0 or later.',
          'An API client in VCF Operations whose token is in VCF_API_TOKEN_FILE, with Tags Manage (tag_management.manage) and Tags View; VCF_IDB_HOST set to the VCF Identity Broker.',
          'For push: vSphere Tagging privileges on the target vCenters for the account VCF Operations uses.',
        ],
        files: {
          'IMPORT.md': tagsImport('Nothing is imported: sync-control.sh calls the 9.1.1 fleet tag-management API (import from vCenter, push, disengage, export). RUNBOOK.md is the same in the interface.', [
            { heading: 'Run it', lines: ['`./sync-control.sh --list-adapters` for the vCenter adapter ids, then the action (`export <label>`, `pull`, `push` or `disengage`) — `pull` and `push` apply when run (`--dry-run` previews). In the interface: Manage > Fleet Management > Tags.'] },
          ]),
          'sync-control.sh': script,
          'RUNBOOK.md': runbook,
          ...(action === 'export'
            ? {
                'crontab.txt': [
                  '# Nightly export of the fleet tag catalogue and every assignment, as evidence and a diff baseline.',
                  '# No secret here: VCF_API_TOKEN_FILE is a path to a mode-600 file.',
                  `30 0 * * * cd /opt/archtoolkit/tag-sync && ${scheduledEnv('vcf-fleet')} ./sync-control.sh export nightly-$(date +\\%F) >> exports/export.log 2>&1`,
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
    automation: (values                 )             => {
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const repo = str(values, 'repo', '/var/lib/archtoolkit/tag-backup');
      const push = bool(values, 'push', true);
      const hour = num(values, 'hour', 1);
      const maxAttach = num(values, 'max_attach', 2000);
      const findings            = [];
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
        '#   ./tag-restore.sh <backup>/<vcenter>.json [target-vcenter]              restore',
        '#   ./tag-restore.sh <backup>/<vcenter>.json [target-vcenter] --dry-run    preview only',
        '#   ./tag-restore.sh ... --catalogue-only       categories and tags, no assignments',
        '#   ./tag-restore.sh --undo restore-log-<run>.tsv [target-vcenter]',
        '#',
        '# Recreates missing categories and tags by name, then re-attaches assignments',
        '# by object type and name — MoRefs change when a vCenter is rebuilt, names',
        '# usually do not. It never deletes, never detaches, and never changes the value',
        '# of a one-value category that already has one: those are listed as conflicts.',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        `MAX_ATTACH="\${MAX_ATTACH:-${maxAttach}}"`,
        'DRY_RUN=0; CATALOGUE_ONLY=0; UNDO=""; ARGS=()',
        'while (( $# )); do',
        '  case "$1" in',
        '    --dry-run) DRY_RUN=1 ;;',
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
        '  (( DRY_RUN )) && echo "DRY RUN: $n attachment(s) would be removed. Run it without --dry-run to remove them."',
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
        'if (( DRY_RUN )); then echo "DRY RUN: $ATTACH attachment(s) would be made. Nothing was changed. Run it without --dry-run to apply."; exit 0; fi',
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
        'echo "Attached $ATTACH, $FAILED batch(es) reported errors. Undo: ./tag-restore.sh --undo $LOG $host"',
        '(( FAILED == 0 ))',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Nightly tag backup of ${vcenters.length} vCenter(s) to git, with restore`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `The backup runs daily at ${String(hour).padStart(2, '0')}:00 from cron. The restore is run by hand, after an accident or a vCenter rebuild.`, worstCase: 'the backup once a day; the restore whenever someone runs it' },
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
          { rule: 'The backup refuses to replace a non-empty catalogue with an empty one', because: 'A failed read that commits an empty file makes the history look like a wipe, and the next restore from HEAD restores nothing.' },
        ],
        dryRun: [
          './tag-restore.sh <file> [vcenter] --dry-run lists the categories and tags it would create and writes restore-log-<run>.tsv with the action for every assignment: attach, present, conflict, missing-object, ambiguous-object.',
          'The backup is itself read-only against vCenter; run it by hand once and read the git diff.',
        ],
        undo: [
          'Restore: ./tag-restore.sh --undo restore-log-<run>.tsv <vcenter> detaches everything that run attached. Categories and tags it created stay; delete them in vCenter if unwanted, once unattached.',
          'Backup: git revert or git reset in the backup repository; vCenter is not touched.',
        ],
        told: [`A git commit in ${repo} whenever tags change${push ? ', pushed to its remote' : ''}; the commit diff is the change record. The restore writes restore-log-<run>.tsv.`],
        requires: [
          ...VC_REQUIRES,
          `A git clone at ${repo} the job can commit${push ? ' and push' : ''} to, with its git identity and remote credentials set up for the job’s account.`,
          'Read-only access for the backup; Create vSphere Tag Category, Create vSphere Tag and Assign or Unassign vSphere Tag for the restore.',
        ],
        files: {
          'IMPORT.md': tagsImport('tag-backup.sh writes the catalogue and every assignment as JSON; tag-restore.sh is the only thing that reads that JSON back — vCenter and VCF Operations have no import for it.', [
            { heading: 'Back up daily', lines: ['Install the line in crontab.txt with `crontab -e` after one run by hand.'] },
            { heading: 'Restore', lines: ['`./tag-restore.sh <backup>/<vcenter>.json [target-vcenter]` restores (add `--dry-run` first to see what would be recreated; `--catalogue-only` for categories and tags without assignments). It recreates what is missing through POST /api/cis/tagging/category and /tag, then the assignments.'] },
          ]),
          'tag-backup.sh': backup,
          'tag-restore.sh': restore,
          'crontab.txt': [
            '# Tag backup, daily. No secret here: VCF_API_TOKEN_FILE is a path to a mode-600 file (VC_USER + VC_PASSWORD_FILE on 8.x/9.0).',
            `0 ${hour} * * * cd /opt/archtoolkit/tag-backup && ${vcScheduledEnv(vcenters)} BACKUP_REPO=${repo} ./tag-backup.sh >> tag-backup.log 2>&1`,
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
      { id: 'group_category', label: 'VCF Operations custom group per value of', control: 'text', fromTags: 'category'         , default: 'Environment' },
      { id: 'placement_category', label: 'VCF Automation placement by', control: 'text', fromTags: 'category'         , default: 'Environment' },
      { id: 'nsx_category', label: 'NSX security group per value of', control: 'text', fromTags: 'category'         , default: 'Application' },
      { id: 'nsx_sync', label: 'Copy vCenter tags onto NSX (sync script)', control: 'toggle', default: true },
      { id: 'nsx_host', label: 'NSX Manager', control: 'text', default: 'nsx-wld01.example.com' },
      { id: 'cost_category', label: 'Showback by', control: 'text', fromTags: 'category'         , default: 'CostCenter' },
      { id: 'max_changes', label: 'NSX sync refuses more than (VMs)', control: 'number', default: 200, min: 1, max: 100000, showWhen: { input: 'nsx_sync', equals: ['true'] } },
    ],
    automation: (values                 )             => {
      const { categories, findings } = parseStandard(str(values, 'standard', DEFAULT_STANDARD));
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const groupCat = str(values, 'group_category', 'Environment');
      const placeCat = str(values, 'placement_category', 'Environment');
      const nsxCat = str(values, 'nsx_category', 'Application');
      const costCat = str(values, 'cost_category', 'CostCenter');
      const nsxSync = bool(values, 'nsx_sync', true);
      const nsxHost = str(values, 'nsx_host', 'nsx-wld01.example.com');
      const maxChanges = num(values, 'max_changes', 200);
      const find = (name        , role        )                          => {
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
      if ((g?.values.length ?? 0) > 30) findings.push(warning('tags.consume.too-many-groups', `${groupCat} has ${g .values.length} values; groups are generated for the first 30.`, { remediation: 'A custom group per value past a few dozen is a group nobody opens. Group by a coarser category.', source: SRC }));
      if (g?.freeText || n?.freeText) findings.push(warning('tags.consume.free-text', 'A free-text category has no fixed values to build groups for.', { source: SRC }));

      const files                         = {};

      // VCF Operations custom groups.
      const groupFiles           = [];
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
        files['vcfops-apply-groups.sh'] = applyScript(
          'vcf-operations',
          groupFiles.map((file) => ({ method: 'POST'         , path: '/suite-api/api/resources/groups', payload: file })),
          'DELETE /suite-api/api/resources/groups/{id} for each group created. Deleting a group does not touch its members.',
        );
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
        files['nsx-apply-groups.sh'] = [
          '#!/usr/bin/env bash',
          `# Create or update the NSX groups for ${nsxCat} (Policy API, default domain).`,
          '#',
          '# Refuses to update a group that exists without the managed-by|archtoolkit',
          '# tag: somebody built it by hand, and firewall rules may depend on its',
          '# current membership. With --dry-run it only prints what it would do.',
          'set -euo pipefail',
          'cd "$(dirname "$0")"',
          'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
          ...nsxAuth,
          'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
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
          '(( DRY_RUN )) && echo "Dry run: nothing was changed. Run it without --dry-run to apply." || true',
          '',
        ].join('\n');
      }
      if (nsxSync) {
        files['nsx-tag-sync.sh'] = [
          '#!/usr/bin/env bash',
          `# Copy the vCenter ${nsxCat} tags onto the NSX tags of the same VMs, as`,
          `# scope ${nsxCat}, tag <value>. NSX groups match NSX tags, not vCenter tags.`,
          '#',
          `# Only the ${nsxCat} scope is ever touched; every other NSX tag on the VM is kept.`,
          '# A VM is matched by its instance UUID (the NSX external_id). With',
          '# --dry-run it only lists the changes. --prune also clears the scope from VMs',
          '# in these vCenters that no longer carry the vCenter tag at all.',
          'set -euo pipefail',
          'cd "$(dirname "$0")"',
          vcentersLine(vcenters),
          `SYNC_CATEGORY="\${SYNC_CATEGORY:-${nsxCat}}"`,
          `MAX_CHANGES="\${MAX_CHANGES:-${maxChanges}}"`,
          'DRY_RUN=0; PRUNE=0',
          'for arg in "$@"; do case "$arg" in --dry-run) DRY_RUN=1 ;; --prune) PRUNE=1 ;; *) echo "unknown argument: $arg" >&2; exit 2 ;; esac; done',
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
          'if (( DRY_RUN )); then echo "DRY RUN: nothing was changed. Run it without --dry-run to apply."; exit 0; fi',
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
      files['IMPORT.md'] = tagsImport(
        'Each consumer takes its own format. Where a file is exactly the request body the consumer takes, it is sent as it stands.',
        [
          groupFiles.length > 0
            ? { heading: 'VCF Operations custom groups', lines: [`Each vcfops-group-*.json is exactly the body of POST /suite-api/api/resources/groups. \`./vcfops-apply-groups.sh\` (add \`--dry-run\` first to preview). Then assign a policy per group as in vcfops-policies.md. (The interface’s custom-group Import takes its own export format, not these bodies.)`] }
            : undefined,
          nsxFiles.length > 0
            ? { heading: 'NSX groups', lines: [`Each nsx-group-*.json is exactly the body of PATCH /policy/api/v1/infra/domains/default/groups/<id>. \`./nsx-apply-groups.sh\` (add \`--dry-run\` first to preview).${nsxSync ? ' Then schedule nsx-tag-sync.sh, which copies the vCenter tag to the NSX tag the groups select on.' : ''}`] }
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
        ['The VCF Operations group rule reads the vSphere tag property summary|tag with the value <Category-value>; check the property on one tagged VM in VCF Operations before relying on the group.'],
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
          .filter((x)                   => x !== undefined)
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
          { rule: 'Every script takes --dry-run to preview before it applies', because: 'Membership is the blast radius; read it first.' },
        ],
        dryRun: [
          'vcfops-apply-groups.sh --dry-run prints what it would POST.',
          'nsx-apply-groups.sh --dry-run prints which groups it would create and which it refuses.',
          ...(nsxSync ? ['nsx-tag-sync.sh --dry-run lists every VM whose NSX tags would change, before and after.'] : []),
        ],
        undo: [
          'VCF Operations: DELETE /suite-api/api/resources/groups/{id}. Members are untouched.',
          'NSX: DELETE /policy/api/v1/infra/domains/default/groups/{id} — refused by NSX while a rule still uses the group, which is the right order anyway.',
          ...(nsxSync ? ['NSX tags: each sync run saves its plan (nsx-tag-sync-<run>.json) with every changed VM’s previous values in the scope (have) and the tag set it sent. To put a VM back, POST update_tags with that set, the scope values swapped back to have.'] : []),
        ],
        told: ['Each apply prints the membership count of every group it touched. The NSX audit log records every group and tag change against the NSX account used.'],
        requires: [
          'VCF Operations with the vCenters collected, and OpsToken access (VCFOPS_TOKEN or VCFOPS_PASSWORD_FILE) for vcfops-apply-groups.sh.',
          `NSX Manager ${nsxHost}, an account with rights on groups and VM tags, and its password in a mode-600 NSX_PASSWORD_FILE.`,
          ...(nsxSync ? VC_REQUIRES : []),
          'The categories and values already created — the tag standard blueprint.',
        ],
        files,
        notes: [
          'NSX tags and vCenter tags are separate. An NSX group with a Tag condition matches NSX tags (scope|tag) on the VM; a vCenter tag does nothing there until something copies it. Some estates tag in NSX only; if the vCenter tag is the source of truth, the sync is what makes the firewall follow it.',
          'VERIFY: the sync reads /api/vcenter/vm/{vm} identity.instance_uuid and calls the NSX realized-state virtual-machines update_tags action, which replaces a VM’s whole tag set. Check both on your NSX and vCenter releases before running it without --dry-run.',
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
      'Years of hand-made tags leave a catalogue nobody can pick from: tags attached to nothing, categories with no tags, and "Prod", "prod" and "prod " side by side. This finds all three on every vCenter, deletes only what is unused and not in the standard — after writing a full export — and only with a change ticket and under a cap; --dry-run previews. Near-duplicates in use are reported, never merged.',
    inputs: [
      STANDARD_INPUT,
      VCENTERS_INPUT,
      { id: 'protect', label: 'Never delete from categories', control: 'text', fromTags: 'categories'         , default: '', hint: 'Comma separated, e.g. categories another product creates and expects to find' },
      { id: 'empty_categories', label: 'Also delete empty categories', control: 'toggle', default: true },
      { id: 'max_deletes', label: 'Refuse a run that deletes more than', control: 'number', default: 25, min: 1, max: 10000 },
    ],
    automation: (values                 )             => {
      const { categories, findings } = parseStandard(str(values, 'standard', DEFAULT_STANDARD));
      const vcenters = listOf(str(values, 'vcenters', DEFAULT_VCENTERS));
      const protect = listOf(str(values, 'protect', ''));
      const emptyCategories = bool(values, 'empty_categories', true);
      const maxDeletes = num(values, 'max_deletes', 25);
      if (maxDeletes > 200) findings.push(warning('tags.cleanup.high-cap', `A cap of ${maxDeletes} deletions per run is high for something that cannot be undone.`, { remediation: 'Clean up in batches of a few dozen, reading each plan. The export makes a restore possible, not pleasant.', source: SRC }));

      const script = [
        '#!/usr/bin/env bash',
        '# Find unused tags, empty categories and near-duplicate names on every vCenter',
        '# in VCENTERS, and delete the unused ones (never with --dry-run).',
        '#',
        '#   ./tag-cleanup.sh --dry-run                           cleanup-plan-<run>.csv only',
        '#   CHANGE_TICKET=CHG0012345 ./tag-cleanup.sh            delete, after exporting everything',
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
        'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
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
          { rule: 'Deletes only with CHANGE_TICKET set (never with --dry-run), and records the ticket against every deletion', because: 'A deletion cannot be undone in vCenter. The ticket is the approval, and the log ties each deletion to it.' },
          { rule: 'Writes a full export of every category, tag and assignment before planning anything', because: 'It is the only way back: the restore script recreates a deleted tag or category from it by name.' },
          { rule: 'Re-checks each tag for attachments immediately before deleting it, and refuses if it has any', because: 'The plan can be minutes old, and somebody may have used the tag since.' },
          { rule: 'Never deletes a category or value that is in the standard', because: 'An allowed value nobody has used yet — Environment=dr — is not clutter; deleting it breaks the next deployment that asks for it.' },
          { rule: `Refuses a run planning more than ${maxDeletes} deletions`, because: 'A wrong standard file or an account that sees too little makes everything look unused.' },
          { rule: 'Near-duplicates in use are reported, not merged', because: 'Merging means re-tagging objects, which moves them between groups; that is a reviewed bulk assignment, not a cleanup.' },
        ],
        dryRun: ['./tag-cleanup.sh --dry-run writes cleanup-plan-<run>.csv — every candidate with delete, keep or report and the reason — and the export in backups/, and deletes nothing.'],
        undo: [
          'None in vCenter: a deleted tag is gone, and so is every assignment it had (it had none, or it would not have been deleted).',
          'Recreate from the export: backups/tags-<vcenter>-<run>.json is in the tag-backup.sh format, so ./tag-restore.sh backups/tags-<vcenter>-<run>.json <vcenter> --catalogue-only (the backup blueprint) recreates every deleted category and tag by name. The new tag has a new id — anything that stored the old id will not find it.',
        ],
        told: ['cleanup-log-<run>.csv with the change ticket on every row, and the plan and export beside it; attach all three to the ticket. vCenter logs each deletion as an event.'],
        requires: [
          ...VC_REQUIRES,
          'An account that can read every object in each vCenter (otherwise attached tags look unused to it) with Delete vSphere Tag and Delete vSphere Tag Category.',
          'A change ticket for the run that deletes.',
        ],
        files: {
          'tag-standard.json': standardJson(categories),
          'tag-cleanup.sh': script,
          'IMPORT.md': tagsImport('Nothing is imported: tag-cleanup.sh compares each vCenter’s catalogue with tag-standard.json and removes only what its plan lists.', [
            { heading: 'Run it', lines: ['`./tag-cleanup.sh --dry-run` writes cleanup-plan-<run>.csv; `CHANGE_TICKET=<ref> ./tag-cleanup.sh` exports everything, then deletes.'] },
          ]),
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
