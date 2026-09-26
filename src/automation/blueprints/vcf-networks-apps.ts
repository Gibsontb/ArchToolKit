/**
 * VCF Operations for Networks: applications.
 *
 * vcfnet_applications defines an application with its tiers in one call
 * (POST /groups/applications/full), each tier any mix of criteria: VM name,
 * vCenter tag, NSX security tag or group, IP addresses and subnets (IPv4 and
 * IPv6), Kubernetes namespace or service, or a raw search filter.
 *
 * vcfnet_app_discovery configures flow-based application discovery (FBAD):
 * scope, naming preferences for applications and tiers, an optional naming CSV,
 * then saves what it discovers.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { importGuide, networksApi } from './vcf-networks-logs.ts';
import { API_REF, csvCell, isCidr, isIp, NET, NET_SRC, pipeRows, shq } from './vcf-networks-common.ts';

/** The quoted values in a Networks filter, for overlap checks. */
function quotedValues(filter: string): string[] {
  return [...filter.matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => (match[1] ?? match[2] ?? '').toLowerCase()).filter(Boolean);
}

const q = (value: string): string => `'${value.replace(/'/g, "\\'")}'`;

/** Criterion kind → a group_membership_criteria entry. Filter property names: VERIFY in the search bar. */
const CRITERIA: Readonly<Record<string, { label: string; build: (value: string) => Record<string, unknown> | undefined }>> = {
  'name-like': { label: 'VM name contains', build: (v) => search('VirtualMachine', `name like ${q(v)}`) },
  name: { label: 'VM name is', build: (v) => search('VirtualMachine', `name = ${q(v)}`) },
  'vcenter-tag': { label: 'vCenter tag (Category:Value)', build: (v) => search('VirtualMachine', `tag = ${q(v)}`) },
  'security-tag': { label: 'NSX security tag', build: (v) => search('VirtualMachine', `security_tags.name = ${q(v)}`) },
  'security-group': { label: 'NSX security group', build: (v) => search('VirtualMachine', `security_groups.name = ${q(v)}`) },
  ip: { label: 'IP addresses, ranges, subnets', build: (v) => ({ membership_type: 'IPAddressMembershipCriteria', ip_address_membership_criteria: { ip_addresses: listOf(v.replace(/\s+/g, ',')) } }) },
  'k8s-namespace': { label: 'Kubernetes namespace', build: (v) => search('KubernetesService', `namespace = ${q(v)}`) },
  'k8s-service': { label: 'Kubernetes service', build: (v) => search('KubernetesService', `name = ${q(v)}`) },
  filter: { label: 'Search filter (VMs)', build: (v) => search('VirtualMachine', v) },
};

function search(entityType: string, filter: string): Record<string, unknown> {
  return { membership_type: 'SearchMembershipCriteria', search_membership_criteria: { entity_type: entityType, filter } };
}

const CRITERIA_KEYS = Object.keys(CRITERIA);

export const VCFNET_APPLICATIONS: AutomationBlueprint = automationBlueprint({
  id: 'vcfnet_applications',
  platform: NET,
  label: 'Define an application and its tiers',
  group: 'Segmentation',
  description:
    'An application in Networks is a name and a set of tiers; each tier is one or more membership criteria — VM name, vCenter tag, NSX security tag or group, IP addresses and subnets, Kubernetes namespace or service, or a search filter. Created (or updated) in one call with its tiers, after counting what each tier matches. The tiers have to be disjoint, or the rules written from them will be too.',
  inputs: [
    { id: 'app_name', label: 'Application', control: 'text', default: 'Orders' },
    {
      id: 'tiers',
      label: 'Tiers',
      control: 'textarea',
      default: 'web | name-like | orders-web\napp | name-like | orders-app\ndb | name-like | orders-db',
      hint: 'Tier | Criterion | Value',
      help: `Criterion is one of: ${CRITERIA_KEYS.map((key) => `${key} (${CRITERIA[key]!.label})`).join(', ')}. Several rows for one tier are OR-ed. ip takes a space- or comma-separated list of addresses, a-b ranges and CIDRs, IPv4 or IPv6.`,
    },
    { id: 'enable_intent', label: 'Enable application flow-health and utilization intents', control: 'toggle', default: true },
    { id: 'update_existing', label: 'Update the application if it exists', control: 'toggle', default: true, hint: 'Otherwise an existing one is left alone' },
  ],
  automation: (values: BlueprintValues, name: string): Automation => {
    const app = str(values, 'app_name', 'Application');
    const base = slugOf(name || app, 'application');
    const enableIntent = bool(values, 'enable_intent', true);
    const update = bool(values, 'update_existing', true);
    const findings: Finding[] = [];

    const rows = pipeRows(str(values, 'tiers', ''), 3).filter((row) => row[0]);
    const order: string[] = [];
    const byTier = new Map<string, { kind: string; value: string }[]>();
    for (const [tier, kindRaw, value] of rows) {
      let kind = kindRaw!.toLowerCase();
      let val = value ?? '';
      // The old one-column form "tier = filter" still reads as a filter.
      if (!kind && tier!.includes('=')) {
        const at = tier!.indexOf('=');
        kind = 'filter';
        val = tier!.slice(at + 1).trim();
      }
      const tierName = tier!.includes('=') && kind === 'filter' && !value ? tier!.slice(0, tier!.indexOf('=')).trim() : tier!;
      if (!CRITERIA[kind]) {
        findings.push(error('vcfnet.app.criterion', `Tier ${tierName}: "${kindRaw}" is not a criterion. Use one of ${CRITERIA_KEYS.join(', ')}.`, { source: NET_SRC }));
        continue;
      }
      if (!val) {
        findings.push(error('vcfnet.app.empty-tier', `Tier ${tierName}: no value for ${kind}.`, { source: NET_SRC }));
        continue;
      }
      if (kind === 'ip') {
        const bad = listOf(val.replace(/\s+/g, ',')).filter((item) => !isIp(item) && !isCidr(item) && !/^[^-]+-[^-]+$/.test(item));
        if (bad.length > 0) findings.push(error('vcfnet.app.bad-ip', `Tier ${tierName}: ${bad.join(', ')} is not an address, range or CIDR.`, { source: NET_SRC }));
      }
      if (!byTier.has(tierName)) {
        byTier.set(tierName, []);
        order.push(tierName);
      }
      byTier.get(tierName)!.push({ kind, value: val });
    }
    if (order.length === 0) findings.push(error('vcfnet.app.no-tiers', 'An application with no tiers groups nothing.', { source: NET_SRC }));

    // Overlap: compare the quoted values of name/tag criteria across tiers.
    const overlaps: string[] = [];
    const filterOf = (entry: { kind: string; value: string }): string => {
      const built = CRITERIA[entry.kind]!.build(entry.value) as { search_membership_criteria?: { filter: string } };
      return built.search_membership_criteria?.filter ?? '';
    };
    for (let i = 0; i < order.length; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        const a = byTier.get(order[i]!)!.map(filterOf).filter(Boolean);
        const b = byTier.get(order[j]!)!.map(filterOf).filter(Boolean);
        const clash = a.some((fa) =>
          b.some((fb) => {
            const va = quotedValues(fa);
            const vb = quotedValues(fb);
            return fa === fb || va.some((x) => vb.some((y) => (/\blike\b/i.test(fa) && y.includes(x)) || (/\blike\b/i.test(fb) && x.includes(y)) || x === y));
          }),
        );
        if (clash) overlaps.push(`${order[i]} and ${order[j]}`);
      }
    }
    if (overlaps.length > 0) {
      findings.push(
        warning('vcfnet.app.overlap', `Tier criteria overlap: ${overlaps.join('; ')}. A VM matching both is in both tiers.`, {
          remediation: '"name like" is a substring match, so like \'web\' also matches \'web-db\'. Make every tier’s criterion exclusive — a tag per tier is the cleanest way.',
          source: NET_SRC,
        }),
      );
    }

    const tierBodies = order.map((tier) => ({ name: tier, group_membership_criteria: byTier.get(tier)!.map((entry) => CRITERIA[entry.kind]!.build(entry.value)) }));
    const full = { name: app, enable_intent: enableIntent, tiers: tierBodies };

    // The discovery CSV: one row per tier criterion that is a VM-name match.
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const csvRows = order.flatMap((tier) =>
      byTier
        .get(tier)!
        .filter((entry) => entry.kind === 'name-like' || entry.kind === 'name')
        .map((entry) => [app, tier, entry.kind === 'name-like' ? `.*${escape(entry.value)}.*` : escape(entry.value)].map(csvCell).join(',')),
    );

    const script = [
      '#!/usr/bin/env bash',
      `# Create${update ? ' or update' : ''} the application "${app.replace(/[\n"]/g, ' ')}" with ${order.length} tier(s) in VCF Operations for Networks.`,
      '#',
      '# Counts what each search criterion matches today, then sends the whole',
      '# definition in one call (POST /groups/applications/full). --dry-run stops',
      '# after the count — the check that the criteria are right.',
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      ...networksApi(),
      '',
      'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
      '',
      "while IFS=$'\\t' read -r TIER TYPE FILTER; do",
      '  COUNT=$(ni POST /search --data "$(jq -n --arg t "$TYPE" --arg f "$FILTER" \'{entity_type: $t, filter: $f, size: 1}\')" | jq -r \'.total_count // 0\') \\',
      '    || { echo "tier ${TIER}: the search rejected ${FILTER}" >&2; exit 2; }',
      '  echo "tier ${TIER}: ${COUNT} ${TYPE} match ${FILTER}"',
      '  [[ "$COUNT" == 0 ]] && echo "  WARNING: tier ${TIER} matches nothing today" >&2',
      "done < <(jq -r '.tiers[] | .name as $n | .group_membership_criteria[] | select(.membership_type == \"SearchMembershipCriteria\") | [$n, .search_membership_criteria.entity_type, .search_membership_criteria.filter] | @tsv' application-full.json)",
      '',
      '(( DRY_RUN )) && { echo "Dry run: nothing was created. Run it without --dry-run to apply."; exit 0; }',
      '',
      `NAME=${shq(app)}`,
      'EXISTING=""',
      "for id in $(ni GET /groups/applications | jq -r '.results[]?.entity_id // empty'); do",
      '  if ni GET "/groups/applications/$id" | jq -e --arg n "$NAME" \'.name == $n\' >/dev/null; then EXISTING="$id"; break; fi',
      'done',
      'if [[ -n "$EXISTING" ]]; then',
      update
        ? [
            '  # Edit the saved application: entity_id in the body, If-Match its last modified time.',
            '  STAMP=$(ni GET "/groups/applications/$EXISTING" | jq -r \'.last_modified_timestamp // .lastModifiedTimestamp // empty\')',
            '  jq --arg id "$EXISTING" \'. + {entity_id: $id}\' application-full.json \\',
            '    | ni POST /groups/applications/full --data @- ${STAMP:+-H "If-Match: $STAMP"} >/dev/null',
            '  echo "updated application ${EXISTING}"',
            '  APP_ID="$EXISTING"',
          ].join('\n')
        : '  echo "application exists (${EXISTING}); left as it is"; APP_ID="$EXISTING"',
      'else',
      '  APP_ID=$(ni POST /groups/applications/full --data @application-full.json | jq -r \'.entity_id // empty\')',
      '  echo "created application ${APP_ID}"',
      'fi',
      'echo "${APP_ID}" > created-application-id.txt',
      "ni GET \"/groups/applications/${APP_ID}/tiers\" | jq -r '.results[]? | \"tier \\(.name // .entity_id)\"' || true",
      '',
    ].join('\n');

    return {
      platform: NET,
      title: `Application "${app}" with ${order.length} tier${order.length === 1 ? '' : 's'}${enableIntent ? ', flow intents on' : ''}`,
      effect: 'reversible',
      trigger: { kind: 'manual', detail: 'Created once. Membership is re-evaluated as VMs come and go.', worstCase: 'membership changes whenever something matching a tier criterion appears' },
      scope: {
        what: 'A definition only: it groups VMs, addresses and services for analysis and changes nothing on the network.',
        decidedBy: order.map((tier) => `Tier ${tier}: ${byTier.get(tier)!.map((entry) => `${CRITERIA[entry.kind]!.label} ${entry.value}`).join(' OR ')}.`),
        ifWrong: 'The flow analysis shows the wrong members in a tier, and any firewall rules recommended from it are wrong in the same way. That is where the harm is — in the rules written later from this.',
      },
      guardrails: [
        { rule: 'Counts each tier’s members before creating anything', because: 'A tier that matches three hundred VMs instead of three is visible as a number before it is visible as a bad rule.' },
        { rule: 'Creates a definition, never a rule', because: 'Recommended rules are reviewed before they go to NSX (vcfnet_microseg_policy).' },
        ...(update ? [{ rule: 'Updates the saved application with If-Match', because: 'An edit made in the interface since it was read is not silently overwritten.' }] : []),
      ],
      dryRun: ['Run with --dry-run. It prints how many members each tier criterion matches today and creates nothing.'],
      undo: ['DELETE /api/ni/groups/applications/{id} with the id in created-application-id.txt, or delete it under Applications.'],
      told: [enableIntent ? 'Networks raises its application flow-health and utilization alerts for it once the intents learn a baseline.' : 'Nobody. It is a definition.'],
      requires: ['VM names, tags or groups consistent enough for a criterion to find them.', 'Flow collection (IPFIX) for the flow analysis to have anything in it.', 'A Networks account: VCFNET_USER and VCFNET_PASSWORD_FILE, or VCFNET_TOKEN.'],
      files: {
        [`${base}.sh`]: script,
        'application-full.json': `${JSON.stringify(full, null, 2)}\n`,
        'import/application.json': `${JSON.stringify({ name: app }, null, 2)}\n`,
        'import/tiers.json': `${JSON.stringify(tierBodies, null, 2)}\n`,
        ...(csvRows.length > 0 ? { 'import/application-discovery.csv': `${['Application Name,Tier Name,VM Name', ...csvRows].join('\n')}\n` } : {}),
        'IMPORT.md': importGuide({
          product: 'VCF Operations for Networks',
          intro: `${base}.sh sends application-full.json to POST /api/ni/groups/applications/full — the application and every tier in one call. import/application.json and import/tiers.json are the same definition in the two-step form (POST /groups/applications, then POST /groups/applications/{id}/tiers per tier) for tooling that wants it.`,
          steps: [
            {
              heading: 'Create the application and tiers',
              lines: [
                `\`./${base}.sh --dry-run\` counts each tier’s members and creates nothing; \`./${base}.sh\` counts them and ${update ? 'creates or updates' : 'creates'} "${app}", writing the id to created-application-id.txt.`,
                '',
                `By hand: Applications > Add Application, name "${app}", one tier per element of import/tiers.json.`,
              ],
            },
            csvRows.length > 0
              ? {
                  heading: 'Optional: seed flow-based discovery with the CSV',
                  lines: [
                    'import/application-discovery.csv maps VM-name patterns to application and tier names for flow-based discovery (vcfnet_app_discovery uploads it, or Applications > Discover > Flow based > Discovery Options). It does not create the definition above.',
                    '',
                    'VERIFY: the header names ("Application Name", "Tier Name", "VM Name"); the upload reports any column it cannot find.',
                  ],
                }
              : undefined,
          ],
          verify: [
            'The search filter property names per criterion: tag (vCenter tag), security_tags.name, security_groups.name, and namespace / name on KubernetesService — try each in the search bar.',
            'The If-Match value for an edit is the application’s lastModifiedTimestamp; the script reads last_modified_timestamp (or lastModifiedTimestamp) from GET /groups/applications/{id}.',
          ],
          sources: [API_REF, 'Applications: POST /groups/applications/full (AppWithTiersRequest: name, entity_id, enable_intent, tiers[{name, group_membership_criteria[SearchMembershipCriteria | IPAddressMembershipCriteria]}], If-Match header).'],
        }),
      },
      notes: [
        'Networks can discover applications from flows, tags and names on its own (vcfnet_app_discovery). Use that to find candidates, then write the definition here so it is reviewed and versioned.',
        'IP criteria accept IPv6 addresses and prefixes as the product does for IPv4 (VERIFY on your release).',
      ],
      findings,
    };
  },
});

// ---------------------------------------------------------------------------

const NAMING = [
  { value: 'LB_VIRTUAL_SERVERS', label: 'Load balancer virtual servers' },
  { value: 'NSX_SECURITY_GROUPS', label: 'NSX security groups' },
  { value: 'SECURITY_TAGS', label: 'NSX security tags' },
  { value: 'VCENTER_TAGS', label: 'vCenter tags (categories below)' },
  { value: 'VM_NAMES', label: 'VM names (regular expression below)' },
];

export const VCFNET_APP_DISCOVERY: AutomationBlueprint = automationBlueprint({
  id: 'vcfnet_app_discovery',
  platform: NET,
  label: 'Configure flow-based application discovery and save what it finds',
  group: 'Segmentation',
  description:
    'Flow-based application discovery (FBAD) groups VMs into applications and tiers from the flows between them, named by load balancer, NSX group or tag, vCenter tag or a VM-name pattern — optionally seeded with a naming CSV. This sets the scope and the naming preferences, runs it, and saves the discovered applications as definitions.',
  inputs: [
    { id: 'scope', label: 'Clusters in scope', control: 'text', default: 'wld01-cl01, wld01-cl02', hint: 'Comma-separated cluster names' },
    {
      id: 'lookback',
      label: 'Flows analysed',
      control: 'select',
      options: [
        { value: '604800', label: 'Last 7 days' },
        { value: '259200', label: 'Last 3 days' },
        { value: '86400', label: 'Last day' },
        { value: '2592000', label: 'Last 30 days' },
      ],
      default: '604800',
    },
    { id: 'app_naming', label: 'Name applications by', control: 'checklist', options: NAMING, default: 'VCENTER_TAGS,VM_NAMES' },
    { id: 'app_tag_categories', label: 'Application tag categories', control: 'text', default: 'Application', hint: 'vCenter tag categories, comma-separated' },
    { id: 'app_regex', label: 'Application from VM name', control: 'text', default: '^([a-z0-9]+)-', hint: 'Regex; the first group is the application name' },
    { id: 'tier_naming', label: 'Name tiers by', control: 'checklist', options: NAMING, default: 'VCENTER_TAGS,VM_NAMES' },
    { id: 'tier_tag_categories', label: 'Tier tag categories', control: 'text', default: 'Tier' },
    { id: 'tier_regex', label: 'Tier from VM name', control: 'text', default: '^[a-z0-9]+-([a-z]+)' },
    { id: 'use_lb', label: 'Use load balancer pools as a discovery source', control: 'toggle', default: true },
    { id: 'naming_csv', label: 'Naming CSV rows', control: 'textarea', default: 'Orders | web | ^orders-web-[0-9]+$', hint: 'Application | Tier | VM name regex', section: 'Naming CSV' },
    {
      id: 'save',
      label: 'Then',
      control: 'select',
      options: [
        { value: 'all', label: 'Save every discovered application' },
        { value: 'match', label: 'Save those whose name matches the filter below' },
        { value: 'none', label: 'Save nothing (review in the interface)' },
      ],
      default: 'match',
    },
    { id: 'save_filter', label: 'Save names matching', control: 'text', default: '^(orders|payments)', hint: 'Regex', showWhen: { input: 'save', equals: ['match'] } },
    { id: 'enable_intent', label: 'Enable flow intents on saved applications', control: 'toggle', default: true },
  ],
  automation: (values: BlueprintValues, name: string): Automation => {
    const scope = listOf(str(values, 'scope', ''));
    const lookback = num(values, 'lookback', 604800);
    const appNaming = listOf(str(values, 'app_naming', ''));
    const tierNaming = listOf(str(values, 'tier_naming', ''));
    const save = str(values, 'save', 'match');
    const saveFilter = str(values, 'save_filter', '');
    const enableIntent = bool(values, 'enable_intent', true);
    const csv = pipeRows(str(values, 'naming_csv', ''), 3).filter((row) => row[0] && row[2]);
    const base = slugOf(name || 'app-discovery', 'app-discovery');
    const findings: Finding[] = [];

    const prefs = (list: string[], categories: string, regex: string) =>
      list.map((type) => (type === 'VCENTER_TAGS' ? { type, values: listOf(categories) } : type === 'VM_NAMES' ? { type, values: [regex] } : { type }));
    const body = {
      scope_object_type: 66,
      scope_entities: scope,
      full_fetch_flow_interval_in_sec: lookback,
      pause_discovery: false,
      application_naming_preferences: prefs(appNaming, str(values, 'app_tag_categories', ''), str(values, 'app_regex', '')),
      tier_naming_preferences: prefs(tierNaming, str(values, 'tier_tag_categories', ''), str(values, 'tier_regex', '')),
      discovery_options: [...(bool(values, 'use_lb', true) ? [{ type: 'LB' }] : [])],
    };

    if (scope.length === 0) findings.push(error('vcfnet.fbad.no-scope', 'No cluster is in scope; discovery has nothing to analyse.', { source: NET_SRC }));
    if (appNaming.length === 0) findings.push(error('vcfnet.fbad.no-naming', 'No application naming preference: discovered applications would have no name to save them by.', { source: NET_SRC }));
    for (const [label, regex] of [['Application', str(values, 'app_regex', '')], ['Tier', str(values, 'tier_regex', '')], ['Save filter', saveFilter]] as const) {
      try {
        if (regex) new RegExp(regex);
      } catch {
        findings.push(error('vcfnet.fbad.regex', `${label}: "${regex}" is not a valid regular expression.`, { source: NET_SRC }));
      }
    }
    if (save === 'all') findings.push(warning('vcfnet.fbad.save-all', 'Saving every discovered application turns guesses into definitions; review them before rules are recommended from them.', { source: NET_SRC }));

    const script = [
      '#!/usr/bin/env bash',
      '# Configure flow-based application discovery in VCF Operations for Networks,',
      '# wait for it, and save the discovered applications. --dry-run prints the',
      '# configuration and changes nothing.',
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      ...networksApi(),
      '',
      'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
      'CONFIG=fbad-config.json',
      ...(csv.length > 0
        ? [
            '# Upload the naming CSV first; the configuration refers to it as a CSV discovery option.',
            'if (( ! DRY_RUN )); then',
            '  UP=$(ni_form POST /groups/discovered-applications/custom-config/fbad/file/upload -F "file=@import/fbad-naming.csv;type=text/csv")',
            '  REF=$(jq -r \'.file_path // .value // .path // empty\' <<<"$UP")',
            '  [[ -n "$REF" ]] || { echo "Upload returned no file reference: $UP" >&2; exit 2; }',
            '  CONFIG=$(mktemp); trap \'rm -f "$CONFIG"\' EXIT',
            '  jq --arg v "$(printf %s "$REF" | base64 | tr -d \'\\n\')" \'.discovery_options += [{type: "CSV", value: $v}]\' fbad-config.json > "$CONFIG"',
            'fi',
          ]
        : []),
      'if (( DRY_RUN )); then echo "DRY RUN: would set the FBAD configuration:"; jq . "$CONFIG"; exit 0; fi',
      '',
      "ID=$(ni GET /groups/discovered-applications/custom-config/fbad | jq -r '[.. | objects | .entity_id? // empty] | first // empty')",
      'if [[ -n "$ID" ]]; then',
      '  ni PUT "/groups/discovered-applications/custom-config/fbad/$ID" --data @"$CONFIG" >/dev/null; echo "FBAD configuration $ID updated"',
      'else',
      '  ID=$(ni POST /groups/discovered-applications/custom-config/fbad --data @"$CONFIG" | jq -r \'.entity_id // .id // empty\'); echo "FBAD configuration $ID created"',
      'fi',
      '',
      '# Wait for discovery (up to an hour).',
      'for n in $(seq 1 60); do',
      '  P=$(ni GET "/groups/discovered-applications/custom-config/fbad/progress/$ID" || echo "{}")',
      "  echo \"progress: $(jq -r '.status // .progress // \"?\"' <<<\"$P\")\"",
      "  jq -e '(.status // \"\") | test(\"COMPLETE|DONE|SUCCESS|FAIL\"; \"i\")' <<<\"$P\" >/dev/null && break",
      '  sleep 60',
      'done',
      "ni GET /groups/discovered-applications/custom-config/fbad/fileErrors/csv 2>/dev/null | head -20 || true",
      '',
      ...(save === 'none'
        ? ['echo "Review the discovered applications under Applications > Discovered; nothing was saved."', 'exit 0']
        : [
            `FILTER=${shq(save === 'match' ? saveFilter : '.*')}`,
            'IDS=()',
            "for app in $(ni GET /groups/discovered-applications | jq -r '.results[]?.entity_id // empty'); do",
            '  APPNAME=$(ni GET "/entities/names/$app" | jq -r \'.name // empty\')',
            '  if [[ "$APPNAME" =~ $FILTER ]]; then IDS+=("$app"); echo "save: $APPNAME"; fi',
            'done',
            '(( ${#IDS[@]} > 0 )) || { echo "No discovered application matches $FILTER"; exit 0; }',
            `printf '%s\\n' "\${IDS[@]}" | jq -R . | jq -s --argjson intent ${enableIntent} '{discovered_apps: map({source_entity_id: .}), discovery_type: "FBAD", enable_intent: $intent}' \\`,
            '  | ni POST /groups/discovered-applications/save --data @- | jq -r \'.request_id // .requestId // empty\' | while read -r req; do',
            '    [[ -n "$req" ]] && ni GET "/groups/task/progress/$req" | jq .',
            '  done',
            'echo "saved ${#IDS[@]} application(s)"',
          ]),
      '',
    ].join('\n');

    return {
      platform: NET,
      title: `Flow-based application discovery on ${scope.length} cluster${scope.length === 1 ? '' : 's'}${save === 'none' ? '' : ', saving what it finds'}`,
      effect: 'reversible',
      trigger: { kind: 'manual', detail: 'Run once; discovery then re-runs on the product’s own schedule over the chosen window.', worstCase: 'once' },
      scope: {
        what: `Application definitions in Networks, discovered from flows in: ${scope.join(', ') || 'nothing'}.`,
        decidedBy: [`Clusters ${scope.join(', ')}.`, `Application names by ${appNaming.join(', ')}; tier names by ${tierNaming.join(', ')}.`, save === 'match' ? `Saved when the name matches ${saveFilter}.` : save === 'all' ? 'Every discovered application is saved.' : 'Nothing is saved.'],
        ifWrong: 'Discovered applications with the wrong tiers, saved as definitions — and rules recommended from them are wrong in the same way. Nothing on the network changes.',
      },
      guardrails: [
        { rule: 'Saves only names matching the filter (unless told to save all)', because: 'Discovery guesses; a saved guess becomes the input to a firewall policy.' },
        { rule: 'Updates the one FBAD configuration rather than adding another', because: 'Discovery has one configuration per instance.' },
      ],
      dryRun: [`Run ./${base}.sh --dry-run. It prints the configuration and changes nothing.`],
      undo: ['DELETE /api/ni/groups/discovered-applications/custom-config/fbad/{id}; delete saved applications under Applications (or DELETE /api/ni/groups/applications/{id}).'],
      told: ['Nobody; the discovered applications appear under Applications.'],
      requires: ['IPFIX flow collection from the clusters in scope, for at least the window analysed.', 'vCenter tags or VM names that follow the naming chosen.', 'A Networks admin account: VCFNET_USER and VCFNET_PASSWORD_FILE, or VCFNET_TOKEN.'],
      files: {
        [`${base}.sh`]: script,
        'fbad-config.json': `${JSON.stringify(body, null, 2)}\n`,
        ...(csv.length > 0 ? { 'import/fbad-naming.csv': `${['Application Name,Tier Name,VM Name', ...csv.map((row) => row.map((cell) => csvCell(cell)).join(','))].join('\n')}\n` } : {}),
        'IMPORT.md': importGuide({
          product: 'VCF Operations for Networks',
          intro: `${base}.sh sends fbad-config.json to POST (or PUT) /api/ni/groups/discovered-applications/custom-config/fbad${csv.length > 0 ? ', after uploading import/fbad-naming.csv' : ''}, waits for discovery, and saves the matching discovered applications (POST /groups/discovered-applications/save).`,
          steps: [
            { heading: 'Run discovery', lines: [`\`./${base}.sh\` (\`--dry-run\` prints the configuration). By hand: Applications > Discover > Flow based > Discovery Options.`] },
          ],
          verify: [
            'scope_object_type 66 is Cluster (the cluster entity ids are 18230:66:…); scope_entities takes cluster names, as in the API reference example.',
            'The upload response field holding the stored file path, and discovery_type "FBAD" on save, are not spelled out in the reference.',
          ],
          sources: [API_REF, 'Applications: custom-config/fbad (scope_object_type, scope_entities, full_fetch_flow_interval_in_sec, application_naming_preferences, tier_naming_preferences, discovery_options), fbad/file/upload, fbad/progress/{id}, discovered-applications/save.'],
        }),
      },
      notes: ['Discovery needs flows; with a short window it misses anything that talks weekly or less. Seven days is the product’s default.'],
      findings,
    };
  },
});
