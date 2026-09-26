/**
 * VCF Operations for Networks: settings that decide what the analysis means.
 *
 *   vcfnet_ip_definitions   East-West and Internet IP tags, physical subnet → VLAN
 *   vcfnet_search_alert     a saved search that raises an alert and notifies
 *   vcfnet_intents          network intents (MTU, duplex, VLAN, STP, … segmentation)
 *   vcfnet_ip_tags_dns      any IP tag, and the physical IP ↔ DNS mapping file
 *   vcfnet_access           users and groups from VCF SSO with Admin/Member/Auditor
 *   vcfnet_backup           scheduled configuration backup to SSH/FTP
 *
 * What the API does not have (mail server, LDAP, DNS mapping import, local
 * users) is said plainly, with the shortest steps by hand.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { importGuide, networksApi } from './vcf-networks-logs.ts';
import {
  API_REF,
  csvCell,
  envCheck,
  isCidr,
  isIp,
  isIpv6,
  mailServerStep,
  NET,
  NET_SRC,
  notificationInputs,
  notifyAny,
  notifyDescribe,
  notifyJson,
  notifyPlan,
  notifyShell,
  pipeRows,
  searchAlertShell,
  SEVERITY_OPTIONS,
  shq,
} from './vcf-networks-common.ts';

// ---------------------------------------------------------------------------
// IP tag entries (v2): a subnet or an a-b range, with exclusions
// ---------------------------------------------------------------------------

interface TagEntry {
  readonly parent: Record<string, unknown>;
  readonly exclusions?: Record<string, unknown>[];
}

function ipItem(text: string): Record<string, unknown> | undefined {
  const t = text.trim();
  if (isCidr(t)) return { subnet: t.toLowerCase() };
  const dash = t.indexOf('-');
  if (dash > 0) {
    const start = t.slice(0, dash).trim();
    const end = t.slice(dash + 1).trim();
    if (isIp(start) && isIp(end) && isIpv6(start) === isIpv6(end)) return { ip_address_range: { start_ip: start.toLowerCase(), end_ip: end.toLowerCase() } };
  }
  if (isIp(t)) return { subnet: `${t.toLowerCase()}/${isIpv6(t) ? 128 : 32}` };
  return undefined;
}

function tagEntries(rows: string[][], label: string, findings: Finding[]): TagEntry[] {
  const out: TagEntry[] = [];
  for (const [what, excl] of rows) {
    const parent = ipItem(what ?? '');
    if (!parent) {
      findings.push(error('vcfnet.ip.bad-entry', `${label}: "${what}" is not a subnet (CIDR), an address or an a-b range.`, { source: NET_SRC }));
      continue;
    }
    const exclusions = listOf(excl ?? '').map((item) => {
      const parsed = ipItem(item);
      if (!parsed) findings.push(error('vcfnet.ip.bad-entry', `${label}: exclusion "${item}" is not a subnet, an address or a range.`, { source: NET_SRC }));
      return parsed;
    });
    out.push({ parent, ...(exclusions.length > 0 ? { exclusions: exclusions.filter((e): e is Record<string, unknown> => e !== undefined) } : {}) });
  }
  return out;
}

/** add_tag TAG FILE [prune]: add the entries in FILE that the tag lacks; with prune, remove the rest. */
function ipTagShell(): string[] {
  return [
    '# The tag ids this instance has (EAST_WEST, INTERNET, …).',
    'TAG_IDS=$(ni GET /settings/ip-tags/v2/tag-ids)',
    'tag_id() {  # tag_id WANTED -> the id as the instance spells it, or exit',
    '  local id; id=$(jq -r --arg w "$1" \'[.. | strings | select(ascii_upcase == ($w | ascii_upcase))] | first // empty\' <<<"$TAG_IDS")',
    '  [[ -n "$id" ]] || { echo "No IP tag $1 here; the instance has: $(jq -c \'[.. | strings]\' <<<"$TAG_IDS")" >&2; exit 2; }',
    '  echo "$id"',
    '}',
    '# add_tag TAG FILE PRUNE',
    'add_tag() {',
    '  local tag="$1" file="$2" prune="$3" cur add del',
    '  cur=$(ni GET "/settings/ip-tags/v2/${tag}" || echo \'{"entries": []}\')',
    '  # An entry is the same when its parent (subnet or range) is the same.',
    "  add=$(jq -c --argjson cur \"$cur\" '[.[] | select(.parent as $p | ([$cur.entries[]?.parent] | index($p)) == null)]' \"$file\")",
    "  del=$(jq -c --argjson cur \"$cur\" '[.[].parent] as $want | [$cur.entries[]? | select(.parent as $p | ($want | index($p)) == null)]' \"$file\")",
    '  echo "${tag}: $(jq length <<<"$add") to add$( [[ "$prune" == 1 ]] && echo ", $(jq length <<<"$del") to remove")"',
    '  if (( DRY_RUN )); then jq . <<<"$add"; return 0; fi',
    '  if [[ "$(jq length <<<"$add")" != 0 ]]; then',
    '    ni POST "/settings/ip-tags/v2/${tag}/add" --data "$(jq -n --arg t "$tag" --argjson e "$add" \'{tag_id: $t, entries: $e}\')" >/dev/null',
    '  fi',
    '  if [[ "$prune" == 1 && "$(jq length <<<"$del")" != 0 ]]; then',
    '    ni POST "/settings/ip-tags/v2/${tag}/remove" --data "$(jq -n --arg t "$tag" --argjson e "$del" \'{tag_id: $t, entries: $e}\')" >/dev/null',
    '  fi',
    '}',
  ];
}

const SUBNET_HINT = 'Subnet or range | Exclusions (comma-separated, - for none)';

export const VCFNET_IP_DEFINITIONS: AutomationBlueprint = automationBlueprint({
  id: 'vcfnet_ip_definitions',
  platform: NET,
  label: 'East-West and Internet IP definitions, and physical subnet → VLAN',
  group: 'Settings',
  description:
    'What Networks counts as East-West (inside) and Internet decides every flow classification, every "internet-facing VM" and every recommended rule; and which VLAN a physical subnet sits on decides whether physical-to-physical flows land anywhere. This sets both, IPv4 and IPv6, additively or as the exact list.',
  inputs: [
    { id: 'east_west', label: 'East-West', control: 'textarea', default: '10.0.0.0/8 | -\n172.16.0.0/12 | -\n192.168.0.0/16 | -\nfd00::/8 | -', hint: SUBNET_HINT },
    { id: 'internet', label: 'Internet (addresses to count as internet)', control: 'textarea', default: '100.64.0.0/10 | 100.64.10.0/24', hint: SUBNET_HINT },
    { id: 'subnet_vlans', label: 'Physical subnet → VLAN', control: 'textarea', default: '10.10.10.0/24 | 110\n10.10.20.0/24 | 120\n2001:db8:10::/64 | 110', hint: 'Subnet | VLAN' },
    { id: 'prune', label: 'Make the lists exact (remove entries not listed)', control: 'toggle', default: false },
  ],
  automation: (values: BlueprintValues, name: string): Automation => {
    const findings: Finding[] = [];
    const ew = tagEntries(pipeRows(str(values, 'east_west', ''), 2).filter((r) => r[0]), 'East-West', findings);
    const inet = tagEntries(pipeRows(str(values, 'internet', ''), 2).filter((r) => r[0]), 'Internet', findings);
    const vlans = pipeRows(str(values, 'subnet_vlans', ''), 2).filter((r) => r[0]);
    const prune = bool(values, 'prune', false);
    const base = slugOf(name || 'ip-definitions', 'ip-definitions');
    const mappings = vlans.flatMap(([cidr, vlan]) => {
      const id = Number(vlan);
      if (!isCidr(cidr!)) {
        findings.push(error('vcfnet.ip.bad-cidr', `Subnet → VLAN: "${cidr}" is not a CIDR.`, { source: NET_SRC }));
        return [];
      }
      if (!Number.isInteger(id) || id < 1 || id > 4094) {
        findings.push(error('vcfnet.ip.bad-vlan', `Subnet → VLAN: ${cidr} has VLAN "${vlan}"; a VLAN id is 1–4094.`, { source: NET_SRC }));
        return [];
      }
      return [{ cidr: cidr!.toLowerCase(), vlan_id: id }];
    });
    const ewSubnets = ew.map((entry) => String(entry.parent['subnet'] ?? ''));
    const clash = inet.filter((entry) => ewSubnets.includes(String(entry.parent['subnet'] ?? '-')));
    if (clash.length > 0) findings.push(error('vcfnet.ip.both', `${clash.map((entry) => entry.parent['subnet']).join(', ')} is in East-West and Internet at once.`, { source: NET_SRC }));
    if (ew.length === 0) findings.push(warning('vcfnet.ip.no-east-west', 'No East-West ranges: Networks falls back to its defaults (RFC 1918), which rarely match a data centre with public addresses inside.', { source: NET_SRC }));
    if (ew.length > 0 && !ew.some((entry) => isIpv6(String(entry.parent['subnet'] ?? '').split('/')[0] ?? ''))) {
      findings.push(warning('vcfnet.ip.no-ipv6', 'No IPv6 East-West range: IPv6 flows between your own workloads would count as internet.', { remediation: 'Add your IPv6 aggregate (a /32–/48) or fd00::/8.', source: NET_SRC }));
    }
    if (prune) findings.push(warning('vcfnet.ip.prune', 'Exact lists remove every entry not listed here, including ones added in the interface.', { source: NET_SRC }));

    const script = [
      '#!/usr/bin/env bash',
      '# East-West and Internet IP tags, and physical subnet → VLAN mappings, in',
      `# VCF Operations for Networks. ${prune ? 'Lists are made exact.' : 'Additive: nothing already there is removed.'} --dry-run prints the changes.`,
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      ...networksApi(),
      '',
      'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
      ...ipTagShell(),
      '',
      `add_tag "$(tag_id EAST_WEST)" east-west.json ${prune ? 1 : 0}`,
      `add_tag "$(tag_id INTERNET)" internet.json ${prune ? 1 : 0}`,
      '',
      '# Subnet → VLAN: create what is missing, update a VLAN that differs.',
      'CUR=$(ni GET /settings/subnet-mappings)',
      "while IFS=$'\\t' read -r CIDR VLAN; do",
      '  ROW=$(jq -c --arg c "$CIDR" \'[.. | objects | select((.cidr? // "" | ascii_downcase) == $c)] | first // empty\' <<<"$CUR")',
      '  if [[ -z "$ROW" ]]; then',
      '    if (( DRY_RUN )); then echo "DRY RUN: would map $CIDR to VLAN $VLAN"; continue; fi',
      '    ni POST /settings/subnet-mappings --data "$(jq -n --arg c "$CIDR" --argjson v "$VLAN" \'{cidr: $c, vlan_id: $v}\')" >/dev/null && echo "mapped $CIDR -> VLAN $VLAN"',
      '  elif [[ "$(jq -r .vlan_id <<<"$ROW")" != "$VLAN" ]]; then',
      '    ID=$(jq -r \'.entity_id // .id\' <<<"$ROW")',
      '    if (( DRY_RUN )); then echo "DRY RUN: would change $CIDR to VLAN $VLAN"; continue; fi',
      '    ni PUT "/settings/subnet-mappings/$ID" --data "$(jq -n --arg c "$CIDR" --argjson v "$VLAN" \'{cidr: $c, vlan_id: $v}\')" >/dev/null && echo "remapped $CIDR -> VLAN $VLAN"',
      '  else echo "$CIDR already VLAN $VLAN"; fi',
      "done < <(jq -r '.[] | [.cidr, (.vlan_id | tostring)] | @tsv' subnet-mappings.json)",
      '(( DRY_RUN )) && echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
      'exit 0',
      '',
    ].join('\n');

    return {
      platform: NET,
      title: `East-West (${ew.length}), Internet (${inet.length}) and ${mappings.length} subnet → VLAN mapping${mappings.length === 1 ? '' : 's'}${prune ? ', exact' : ''}`,
      effect: 'reversible',
      trigger: { kind: 'manual', detail: 'Run once, and again whenever the address plan changes.', worstCase: 'once' },
      scope: {
        what: 'Instance-wide settings: how every flow is classified (East-West or Internet) and which VLAN a physical subnet belongs to.',
        decidedBy: ['east-west.json, internet.json and subnet-mappings.json, written from the lists above.', prune ? 'Entries not listed are removed.' : 'Entries already there are kept.'],
        ifWrong: 'A range missing from East-West makes internal traffic look like internet traffic: dashboards, internet-exposure searches and recommended rules are all wrong until it is fixed. Nothing on the network changes.',
      },
      guardrails: [
        { rule: prune ? 'Exact only when asked' : 'Additive by default', because: 'A range added in the interface by someone else is not silently removed.' },
        { rule: 'Every entry validated as a CIDR, address or range before anything is sent', because: 'A typo in a /8 reclassifies a data centre.' },
      ],
      dryRun: [`Run ./${base}.sh --dry-run: it prints what it would add${prune ? ' and remove' : ''} and changes nothing.`],
      undo: ['POST /api/ni/settings/ip-tags/v2/{tag}/remove with the entries added; DELETE /api/ni/settings/subnet-mappings/{id} for a mapping; or Settings > IP Properties.'],
      told: ['Nobody. Flow classifications change from the next collection.'],
      requires: ['A Networks admin account: VCFNET_USER and VCFNET_PASSWORD_FILE, or VCFNET_TOKEN.', 'jq and curl.'],
      files: {
        [`${base}.sh`]: script,
        'east-west.json': `${JSON.stringify(ew, null, 2)}\n`,
        'internet.json': `${JSON.stringify(inet, null, 2)}\n`,
        'subnet-mappings.json': `${JSON.stringify(mappings, null, 2)}\n`,
        'IMPORT.md': importGuide({
          product: 'VCF Operations for Networks',
          intro: `${base}.sh adds east-west.json and internet.json to the EAST_WEST and INTERNET IP tags (POST /api/ni/settings/ip-tags/v2/{tag}/add) and creates or updates subnet-mappings.json (POST/PUT /api/ni/settings/subnet-mappings).`,
          steps: [{ heading: 'Apply', lines: [`\`./${base}.sh\` (\`--dry-run\` first). By hand: Settings > IP Properties > East-West IPs / Internet IPs, and Physical Subnet VLAN.`] }],
          verify: ['The tag ids are read from GET /settings/ip-tags/v2/tag-ids and matched case-insensitively to EAST_WEST and INTERNET; the script stops and lists them if either is missing.', 'IPv6 subnets in subnet-mappings (the reference types cidr as a string).'],
          sources: [API_REF, 'Settings: ip-tags v2 (tag-ids, {tag-id}, add, remove; IpTagEntries {tag_id, entries[{parent {subnet | ip_address_range}, exclusions}]}; v1 is deprecated), subnet-mappings {cidr, vlan_id}.'],
        }),
      },
      findings,
    };
  },
});

// ---------------------------------------------------------------------------

export const VCFNET_SEARCH_ALERT: AutomationBlueprint = automationBlueprint({
  id: 'vcfnet_search_alert',
  platform: NET,
  label: 'Saved search → alert, with notification',
  group: 'Alerts',
  description:
    'Any Networks search as an alert: raised when its results change, or when it returns nothing — a VM that became internet-facing, a flow on a forbidden port, a host whose uplink went away — with a severity, and sent by e-mail, SNMP trap, syslog or webhook. Created enabled through the API; the search is run once first so a bad query stops before an alert exists.',
  inputs: [
    { id: 'alert_name', label: 'Alert name', control: 'text', default: 'Internet-facing VMs changed' },
    { id: 'query', label: 'Search', control: 'text', default: "vms where Internet Traffic = true", hint: 'The search bar’s language; run it there first' },
    {
      id: 'raise_when',
      label: 'Raise when',
      control: 'select',
      options: [
        { value: 'SEARCH_RESULT_CHANGE', label: 'The results change' },
        { value: 'ZERO_SEARCH_RESULTS', label: 'The search returns nothing' },
      ],
      default: 'SEARCH_RESULT_CHANGE',
    },
    {
      id: 'alert_type',
      label: 'Alert type',
      control: 'select',
      options: [
        { value: 'PROBLEM', label: 'Problem' },
        { value: 'CHANGE', label: 'Change' },
        { value: 'INTENT', label: 'Intent' },
      ],
      default: 'PROBLEM',
    },
    { id: 'severity', label: 'Severity', control: 'select', options: SEVERITY_OPTIONS, default: 'Warning' },
    ...notificationInputs(),
  ],
  automation: (values: BlueprintValues, name: string): Automation => {
    const alertName = str(values, 'alert_name', 'Search alert');
    const query = str(values, 'query', '');
    const when = str(values, 'raise_when', 'SEARCH_RESULT_CHANGE');
    const type = str(values, 'alert_type', 'PROBLEM');
    const severity = str(values, 'severity', 'Warning');
    const plan = notifyPlan(values);
    const base = slugOf(name || alertName, 'search-alert');
    const findings: Finding[] = [...plan.findings];
    if (!query) findings.push(error('vcfnet.alert.no-query', 'An alert needs a search.', { source: NET_SRC }));
    if (!notifyAny(plan)) findings.push(warning('vcfnet.alert.nobody-told', 'No destination is set: the alert shows in Networks and nobody is told.', { source: NET_SRC }));
    if (when === 'ZERO_SEARCH_RESULTS' && /\bwhere\b/i.test(query) === false) {
      findings.push(warning('vcfnet.alert.zero-broad', 'A search with no condition only returns nothing when collection itself has stopped; add a condition for what should always be there.', { source: NET_SRC }));
    }
    const body = { alert_name: alertName, search_criteria: query, generate_alert_criteria: when, alert_type: type, severity };

    const script = [
      '#!/usr/bin/env bash',
      `# Create or update the search-based alert "${alertName.replace(/[\n"]/g, ' ')}" in VCF Operations for Networks, enabled,`,
      '# with its notification destinations. --dry-run runs the search and prints the body.',
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      ...networksApi(),
      '',
      'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
      ...envCheck(plan.env),
      ...notifyShell('notify.json'),
      ...searchAlertShell(),
      '',
      '(( DRY_RUN )) || : > created-alert-ids.txt',
      'upsert_alert alert.json "$(setup_notify)"',
      '(( DRY_RUN )) && echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
      'exit 0',
      '',
    ].join('\n');

    return {
      platform: NET,
      title: `Alert "${alertName}" (${severity}) when the search ${when === 'ZERO_SEARCH_RESULTS' ? 'returns nothing' : 'results change'}`,
      effect: 'reversible',
      trigger: { kind: 'alert', detail: `Networks evaluates "${query}" and raises the alert when ${when === 'ZERO_SEARCH_RESULTS' ? 'it returns nothing' : 'its results change'}.`, worstCase: 'once per change, at the collection interval' },
      scope: { what: 'One alert definition in Networks and its notification destinations.', decidedBy: [`The search: ${query}.`], ifWrong: 'A broad search alerts on every collection; a wrong one never fires. Neither changes the network.' },
      guardrails: [
        { rule: 'The search is run once before the alert is written', because: 'A search the product rejects would make an alert that never fires.' },
        { rule: 'Updates by name instead of adding a duplicate', because: 'Two alerts on one search send everything twice.' },
      ],
      dryRun: [`Run ./${base}.sh --dry-run: it runs the search, prints the count and the body, and creates nothing.`],
      undo: ['DELETE /api/ni/settings/alerts/search-based-alerts/{id} (the id is in created-alert-ids.txt), or POST .../{id}/disable.'],
      told: notifyAny(plan) ? notifyDescribe(plan) : ['Nobody — set a destination.'],
      requires: ['A Networks admin account: VCFNET_USER and VCFNET_PASSWORD_FILE, or VCFNET_TOKEN.', ...plan.env.map((variable) => `${variable} from your vault.`), 'jq and curl.'],
      files: {
        [`${base}.sh`]: script,
        'alert.json': `${JSON.stringify(body, null, 2)}\n`,
        'notify.json': `${JSON.stringify(notifyJson(plan, `${base}-traps`), null, 2)}\n`,
        'IMPORT.md': importGuide({
          product: 'VCF Operations for Networks',
          intro: `${base}.sh sends alert.json to POST /api/ni/settings/alerts/search-based-alerts (PUT when an alert of that name exists), with the notification_settings built from notify.json, and enables it.`,
          steps: [mailServerStep(plan), { heading: 'Apply', lines: [`${plan.env.length > 0 ? `Export ${plan.env.join(', ')}, then` : ''} \`./${base}.sh\` (\`--dry-run\` first). By hand: run the search, then Settings > Alerts > Search based alerts > Add.`] }],
          verify: ['notification_settings type SNMP takes the SNMP trap profile id as its receiver.', 'That user-defined alerts reach the databus "problems" message group (the webhook).'],
          sources: [API_REF, 'Settings: Search Based Alert Config; SNMP trap destination profiles; syslog targets; databus subscribers. User-defined events are deprecated in favour of these.'],
        }),
      },
      findings,
    };
  },
});

// ---------------------------------------------------------------------------

const INTENT_TYPES: readonly { value: string; label: string; params?: readonly string[] }[] = [
  { value: 'MtuMismatch', label: 'MTU mismatch', params: ['CheckMgmtInterface', 'SkipWhenNoInfo'] },
  { value: 'DuplexMismatch', label: 'Duplex mismatch', params: ['CheckMgmtInterface', 'SkipWhenNoInfo', 'SkipAutoDuplex'] },
  { value: 'PortModeMismatch', label: 'Port mode mismatch' },
  { value: 'NativeVlanMismatch', label: 'Native VLAN mismatch' },
  { value: 'TrunkPortVlanMismatch', label: 'Trunk port VLAN mismatch' },
  { value: 'PortChannelMismatch', label: 'Port channel mismatch' },
  { value: 'HsrpStpColocation', label: 'HSRP / STP root colocation' },
  { value: 'StpMetricInconsistency', label: 'STP metric inconsistency' },
  { value: 'DuplicateMacAddress', label: 'Duplicate MAC address' },
  { value: 'DuplicateIPAddress', label: 'Duplicate IP address' },
  { value: 'Loop', label: 'Routing loop' },
  { value: 'Segmentation', label: 'Segmentation (these must not talk)' },
  { value: 'Reachability', label: 'Reachability (these must talk)' },
  { value: 'StigDefaultPasswd', label: 'STIG: default password on a device' },
  { value: 'StigPlaintextPasswd', label: 'STIG: plain-text password in config' },
  { value: 'StigAccountPasswd', label: 'STIG: account password policy' },
  { value: 'StigConsolePasswd', label: 'STIG: console password' },
  { value: 'StigMgmtPasswd', label: 'STIG: management password' },
];

export const VCFNET_INTENTS: AutomationBlueprint = automationBlueprint({
  id: 'vcfnet_intents',
  platform: NET,
  label: 'Network intents (MTU, duplex, VLAN, STP, duplicates, segmentation, reachability)',
  group: 'Alerts',
  description:
    'An intent is a rule the network has to keep — MTU consistent end to end, no duplex or VLAN mismatches, no duplicate IP or MAC, no default passwords, these groups never talk, those always can — which Networks checks continuously and alerts on when broken. Created enabled through the API, with severity, scope and notifications.',
  inputs: [
    { id: 'intent_name', label: 'Name', control: 'text', default: 'MTU consistent in the fabric' },
    { id: 'intent_type', label: 'Intent', control: 'select', options: INTENT_TYPES.map(({ value, label }) => ({ value, label })), default: 'MtuMismatch' },
    { id: 'severity', label: 'Severity', control: 'select', options: SEVERITY_OPTIONS.filter((option) => option.value !== 'Info'), default: 'Critical' },
    { id: 'scope_query', label: 'Scope (search)', control: 'text', default: '', hint: 'Empty: everything. e.g. switch ports where device = ‘leaf-01’' },
    { id: 'check_mgmt', label: 'Include management interfaces', control: 'toggle', default: false, showWhen: { input: 'intent_type', equals: ['MtuMismatch', 'DuplexMismatch'] } },
    { id: 'skip_no_info', label: 'Skip when a side has no data', control: 'toggle', default: true, showWhen: { input: 'intent_type', equals: ['MtuMismatch', 'DuplexMismatch'] } },
    { id: 'skip_auto', label: 'Skip auto-negotiated duplex', control: 'toggle', default: true, showWhen: { input: 'intent_type', equals: ['DuplexMismatch'] } },
    { id: 'source', label: 'From (search)', control: 'text', default: "vms where security group = 'PCI'", showWhen: { input: 'intent_type', equals: ['Segmentation', 'Reachability'] } },
    { id: 'destination', label: 'To (search)', control: 'text', default: "vms where security group = 'Corp'", showWhen: { input: 'intent_type', equals: ['Segmentation', 'Reachability'] } },
    { id: 'ports', label: 'Ports', control: 'text', default: 'any', hint: 'any, or 443, 8443, 1000-2000', showWhen: { input: 'intent_type', equals: ['Segmentation', 'Reachability'] } },
    { id: 'notes', label: 'Notes', control: 'text', default: '', section: 'More' },
    ...notificationInputs(),
  ],
  automation: (values: BlueprintValues, name: string): Automation => {
    const intentName = str(values, 'intent_name', 'Intent');
    const typeId = str(values, 'intent_type', 'MtuMismatch');
    const type = INTENT_TYPES.find((entry) => entry.value === typeId) ?? INTENT_TYPES[0]!;
    const severity = str(values, 'severity', 'Critical');
    const scopeQuery = str(values, 'scope_query', '');
    const plan = notifyPlan(values);
    const base = slugOf(name || intentName, 'intent');
    const findings: Finding[] = [...plan.findings];
    const flowIntent = type.value === 'Segmentation' || type.value === 'Reachability';

    const flag = (id: string, input: string, fallback: boolean) => ({ id, values: String(bool(values, input, fallback)), valueType: 'BOOLEAN' });
    const params = [
      ...(type.params?.includes('CheckMgmtInterface') ? [flag('CheckMgmtInterface', 'check_mgmt', false)] : []),
      ...(type.params?.includes('SkipWhenNoInfo') ? [flag('SkipWhenNoInfo', 'skip_no_info', true)] : []),
      ...(type.params?.includes('SkipAutoDuplex') ? [flag('SkipAutoDuplex', 'skip_auto', true)] : []),
      ...(flowIntent
        ? [
            { id: 'source', values: str(values, 'source', ''), valueType: 'STRING' },
            { id: 'destination', values: str(values, 'destination', ''), valueType: 'STRING' },
            { id: 'ports', values: str(values, 'ports', 'any'), valueType: 'STRING' },
          ]
        : []),
    ];
    if (flowIntent) {
      findings.push(
        warning('vcfnet.intent.params-verify', `The ${type.value} intent’s parameter ids (source, destination, ports) are not documented in the API reference; if the create is rejected, set this intent in the interface and read it back with GET /alert-configs/intents/{id} to get its shape.`, {
          remediation: 'vcfnet_intent_check checks the same thing from observed flows on a schedule, with nothing unverified.',
          source: NET_SRC,
        }),
      );
      if (!str(values, 'source', '') || !str(values, 'destination', '')) findings.push(error('vcfnet.intent.no-groups', 'A segmentation or reachability intent needs a From and a To.', { source: NET_SRC }));
    }
    if (!notifyAny(plan)) findings.push(warning('vcfnet.intent.nobody-told', 'No destination is set: a broken intent shows in Networks and nobody is told.', { source: NET_SRC }));

    const body = {
      name: intentName,
      alertType: 'Intent',
      intentTypeId: type.value,
      ...(scopeQuery ? { filterRules: { isValid: 'true', filterType: 'INCLUDE', rules: [{ membership: { membershipType: 'SearchMembershipCriteria', query: scopeQuery } }] } } : {}),
      paramValues: params,
      description: `${type.label}${scopeQuery ? ` in ${scopeQuery}` : ''}.`,
      enabled: true,
      severity,
      notes: str(values, 'notes', ''),
      tags: [type.label],
    };

    const script = [
      '#!/usr/bin/env bash',
      `# Create or update the ${type.label} intent "${intentName.replace(/[\n"]/g, ' ')}" in VCF Operations for Networks, enabled.`,
      '# --dry-run prints the body. The id is kept in created-intent-id.txt so a rerun updates it.',
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      ...networksApi(),
      '',
      'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
      ...envCheck(plan.env),
      ...notifyShell('notify.json'),
      '',
      'NS=$(setup_notify)',
      "BODY=$(jq --argjson ns \"$NS\" '. + {notificationSettings: $ns}' intent.json)",
      'if (( DRY_RUN )); then echo "DRY RUN: would send:"; echo "$BODY"; exit 0; fi',
      'ID=""; [[ -s created-intent-id.txt ]] && ID=$(cat created-intent-id.txt)',
      'if [[ -n "$ID" ]] && ni GET "/alert-configs/intents/$ID" >/dev/null 2>&1; then',
      '  ni PUT "/alert-configs/intents/$ID" --data "$BODY" >/dev/null; echo "intent $ID updated"',
      'else',
      "  ID=$(ni POST /alert-configs/intents/ --data \"$BODY\" | jq -r '.entity_id // .id // empty')",
      '  [[ -n "$ID" ]] || { echo "The intent was not created" >&2; exit 2; }',
      '  echo "$ID" > created-intent-id.txt; echo "intent $ID created"',
      'fi',
      'ni POST "/alert-configs/intents/$ID/enable" >/dev/null && echo "enabled"',
      '',
    ].join('\n');

    return {
      platform: NET,
      title: `Intent "${intentName}": ${type.label} (${severity})`,
      effect: 'reversible',
      trigger: { kind: 'alert', detail: `Networks checks the ${type.label} intent continuously${scopeQuery ? ` over ${scopeQuery}` : ''} and raises a ${severity} alert when it is broken.`, worstCase: 'once per violation, at the collection interval' },
      scope: { what: 'One intent in Networks and its notification destinations.', decidedBy: [scopeQuery ? `Scope: ${scopeQuery}.` : 'Scope: everything Networks collects.', ...params.map((param) => `${param.id} = ${param.values}.`)], ifWrong: 'A wide scope alerts on devices nobody owns; a wrong parameter hides the violation. Nothing on the network changes.' },
      guardrails: [{ rule: 'The id is kept and reused, so a rerun updates rather than duplicates', because: 'Two intents of the same kind double every alert.' }],
      dryRun: [`Run ./${base}.sh --dry-run: it prints the body and creates nothing.`],
      undo: ['DELETE /api/ni/alert-configs/intents/{id} (created-intent-id.txt), or POST .../{id}/disable.'],
      told: notifyAny(plan) ? notifyDescribe(plan) : ['Nobody — set a destination.'],
      requires: ['The switches and routers the intent covers added as data sources (vcfnet_data_sources), with SNMP where it needs interface data.', 'A Networks admin account.', ...plan.env.map((variable) => `${variable} from your vault.`), 'jq and curl.'],
      files: {
        [`${base}.sh`]: script,
        'intent.json': `${JSON.stringify(body, null, 2)}\n`,
        'notify.json': `${JSON.stringify(notifyJson(plan, `${base}-traps`), null, 2)}\n`,
        'IMPORT.md': importGuide({
          product: 'VCF Operations for Networks',
          intro: `${base}.sh sends intent.json (with notificationSettings from notify.json) to POST /api/ni/alert-configs/intents/ and enables it; a rerun PUTs to the id it saved.`,
          steps: [mailServerStep(plan), { heading: 'Apply', lines: [`\`./${base}.sh\` (\`--dry-run\` first). By hand: Settings > Alerts > Intents > Add.`] }],
          verify: [
            'filterRules for a search scope: membershipType SearchMembershipCriteria with the query; the reference’s example also carries objectType, left out here.',
            ...(flowIntent ? ['The Segmentation / Reachability parameter ids.'] : []),
          ],
          sources: [API_REF, 'Intents: POST /alert-configs/intents/ (name, alertType Intent, intentTypeId, filterRules, paramValues, severity, enabled, notificationSettings), /{id}/enable, /{id}/disable.'],
        }),
      },
      findings,
    };
  },
});

// ---------------------------------------------------------------------------

export const VCFNET_IP_TAGS_DNS: AutomationBlueprint = automationBlueprint({
  id: 'vcfnet_ip_tags_dns',
  platform: NET,
  label: 'IP tags, and physical IP ↔ DNS mapping',
  group: 'Settings',
  description:
    'Tag address ranges with any IP tag the instance has, applied through the API; and name the physical addresses flows come from — load balancers, bare-metal servers, appliances — with a DNS mapping file, which Networks imports in the interface (there is no API for it) or takes from Infoblox as a data source.',
  inputs: [
    { id: 'tags', label: 'IP tags', control: 'textarea', default: 'EAST_WEST | 10.50.0.0/16 | 10.50.99.0/24\nINTERNET | 198.51.100.0/24 | -', hint: 'Tag id | Subnet or range | Exclusions (comma-separated, - for none)' },
    { id: 'dns', label: 'IP ↔ DNS', control: 'textarea', default: '10.10.10.21 | lb01.example.com\n10.10.10.22 | lb02.example.com\n2001:db8:10::21 | lb01.example.com', hint: 'IP address | FQDN' },
  ],
  automation: (values: BlueprintValues, name: string): Automation => {
    const findings: Finding[] = [];
    const base = slugOf(name || 'ip-tags-dns', 'ip-tags-dns');
    const byTag = new Map<string, string[][]>();
    for (const [tag, what, excl] of pipeRows(str(values, 'tags', ''), 3).filter((row) => row[0] && row[1])) {
      const key = tag!.toUpperCase();
      if (!byTag.has(key)) byTag.set(key, []);
      byTag.get(key)!.push([what!, excl ?? '']);
    }
    const tagFiles: Record<string, string> = {};
    for (const [tag, rows] of byTag) tagFiles[`ip-tags/${slugOf(tag, 'tag')}.json`] = `${JSON.stringify({ tag, entries: tagEntries(rows, tag, findings) }, null, 2)}\n`;
    const dns = pipeRows(str(values, 'dns', ''), 2).filter((row) => row[0]);
    for (const [ip, fqdn] of dns) {
      if (!isIp(ip!)) findings.push(error('vcfnet.dns.bad-ip', `"${ip}" is not an IP address.`, { source: NET_SRC }));
      if (!fqdn || !/^[a-z0-9.-]+$/i.test(fqdn)) findings.push(error('vcfnet.dns.bad-name', `"${fqdn ?? ''}" is not a DNS name.`, { source: NET_SRC }));
    }
    if (byTag.size === 0 && dns.length === 0) findings.push(error('vcfnet.tags.none', 'Nothing to tag and nothing to map.', { source: NET_SRC }));

    const script = [
      '#!/usr/bin/env bash',
      '# Add IP tag entries in VCF Operations for Networks (additive). --dry-run prints them.',
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      ...networksApi(),
      '',
      'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
      ...ipTagShell(),
      '',
      'for f in ip-tags/*.json; do',
      '  [[ -e "$f" ]] || continue',
      '  T=$(tag_id "$(jq -r .tag "$f")")',
      '  jq .entries "$f" > "$f.entries"',
      '  add_tag "$T" "$f.entries" 0; rm -f "$f.entries"',
      'done',
      ...(dns.length > 0 ? ['echo "import/dns-mapping.csv: import it under Settings > IP Properties > Physical IP and DNS Mapping (no API for this)."'] : []),
      '',
    ].join('\n');

    return {
      platform: NET,
      title: `${byTag.size} IP tag${byTag.size === 1 ? '' : 's'} and ${dns.length} DNS mapping${dns.length === 1 ? '' : 's'}`,
      effect: 'reversible',
      trigger: { kind: 'manual', detail: 'Run when the address plan changes.', worstCase: 'once' },
      scope: { what: 'IP tag entries and the physical IP ↔ DNS names Networks shows; nothing on the network.', decidedBy: [...[...byTag.keys()].map((tag) => `Tag ${tag}.`), ...(dns.length > 0 ? ['import/dns-mapping.csv.'] : [])], ifWrong: 'A wrong tag misclassifies flows; a wrong name mislabels a flow endpoint. Both are corrected by running it again with the right values.' },
      guardrails: [{ rule: 'Additive; tag ids checked against the instance first', because: 'An unknown tag id stops the run instead of creating nothing silently.' }],
      dryRun: [`Run ./${base}.sh --dry-run.`],
      undo: ['POST /api/ni/settings/ip-tags/v2/{tag}/remove with the entries; re-import the DNS file without the rows.'],
      told: ['Nobody.'],
      requires: ['A Networks admin account.', 'jq and curl.'],
      files: {
        [`${base}.sh`]: script,
        ...tagFiles,
        ...(dns.length > 0 ? { 'import/dns-mapping.csv': `${['IP Address,FQDN', ...dns.map(([ip, fqdn]) => [ip!, fqdn ?? ''].map(csvCell).join(','))].join('\n')}\n` } : {}),
        'IMPORT.md': importGuide({
          product: 'VCF Operations for Networks',
          intro: `${base}.sh adds each file in ip-tags/ to its IP tag (POST /api/ni/settings/ip-tags/v2/{tag}/add).`,
          steps: [
            { heading: 'IP tags', lines: [`\`./${base}.sh\` (\`--dry-run\` first).`] },
            dns.length > 0
              ? {
                  heading: 'DNS mapping (by hand — the API has no call for it)',
                  lines: [
                    'Settings > IP Properties > Physical IP and DNS Mapping > Import > import/dns-mapping.csv.',
                    '',
                    'VERIFY: the column names against the sample file the import dialog offers. To keep the mapping current without a file, add Infoblox as a data source (vcfnet_data_sources, kind Infoblox).',
                  ],
                }
              : undefined,
          ],
          verify: ['The tag ids are those GET /settings/ip-tags/v2/tag-ids returns; the script stops on one it does not.'],
          sources: [API_REF, 'Settings: ip-tags v2. The backup data filter lists physical_ip_dns_mapping, but no operation sets it.'],
        }),
      },
      findings,
    };
  },
});

// ---------------------------------------------------------------------------

const ROLES = ['ADMIN', 'MEMBER', 'AUDITOR'];

export const VCFNET_ACCESS: AutomationBlueprint = automationBlueprint({
  id: 'vcfnet_access',
  platform: NET,
  label: 'Users and groups, with Admin / Member / Auditor',
  group: 'Settings',
  description:
    'Who can use Networks and as what: users and groups from VCF SSO (the identity broker) with the Admin, Member or Auditor role, added or re-roled through the API. Networks has those three roles only — no custom roles. LDAP and local users have no API and are given as steps.',
  inputs: [
    { id: 'principals', label: 'Users and groups', control: 'textarea', default: 'group | vcf-netadmins | example.com | ADMIN\ngroup | vcf-netops | example.com | MEMBER\ngroup | vcf-auditors | example.com | AUDITOR', hint: 'Kind (user or group) | Name | Domain | Role (ADMIN, MEMBER, AUDITOR)' },
    { id: 'ldap', label: 'Also set up LDAP (steps by hand)', control: 'toggle', default: false },
    { id: 'ldap_url', label: 'LDAP URL', control: 'text', default: 'ldaps://dc01.example.com:636', showWhen: { input: 'ldap', equals: ['true'] } },
    { id: 'ldap_domain', label: 'LDAP domain', control: 'text', default: 'example.com', showWhen: { input: 'ldap', equals: ['true'] } },
    { id: 'ldap_base', label: 'Base DN', control: 'text', default: 'DC=example,DC=com', showWhen: { input: 'ldap', equals: ['true'] } },
    { id: 'ldap_admin_group', label: 'Admin group DN', control: 'text', default: 'CN=vcf-netadmins,OU=Groups,DC=example,DC=com', showWhen: { input: 'ldap', equals: ['true'] } },
    { id: 'ldap_member_group', label: 'Member group DN', control: 'text', default: 'CN=vcf-netops,OU=Groups,DC=example,DC=com', showWhen: { input: 'ldap', equals: ['true'] } },
  ],
  automation: (values: BlueprintValues, name: string): Automation => {
    const findings: Finding[] = [];
    const base = slugOf(name || 'access', 'access');
    const principals = pipeRows(str(values, 'principals', ''), 4)
      .filter((row) => row[1])
      .map(([kind, who, domain, role]) => ({ kind: (kind ?? '').toLowerCase(), name: who!, domain: domain ?? '', role: (role ?? '').toUpperCase() }));
    for (const p of principals) {
      if (!['user', 'group'].includes(p.kind)) findings.push(error('vcfnet.access.kind', `${p.name}: kind "${p.kind}" is not user or group.`, { source: NET_SRC }));
      if (!ROLES.includes(p.role)) findings.push(error('vcfnet.access.role', `${p.name}: role "${p.role}" is not ADMIN, MEMBER or AUDITOR — Networks has no custom roles.`, { source: NET_SRC }));
      if (!p.domain) findings.push(error('vcfnet.access.domain', `${p.name}: no domain.`, { source: NET_SRC }));
    }
    const users = principals.filter((p) => p.kind === 'user').map((p) => ({ username: p.name, domain: p.domain, display_name: p.name, role: p.role }));
    const groups = principals.filter((p) => p.kind === 'group').map((p) => ({ group_name: p.name, domain: p.domain, role: p.role }));
    if (users.filter((u) => u.role === 'ADMIN').length > 0) findings.push(warning('vcfnet.access.admin-user', 'Admin granted to individual users: give it to a group, so leaving the team removes it.', { source: NET_SRC }));
    if (!principals.some((p) => p.role === 'ADMIN')) findings.push(warning('vcfnet.access.no-admin', 'No Admin in the list: only the built-in admin@local can administer the instance.', { source: NET_SRC }));
    const ldap = bool(values, 'ldap', false);
    const ldapUrl = str(values, 'ldap_url', '');
    if (ldap && /^ldap:\/\//i.test(ldapUrl)) findings.push(warning('vcfnet.access.ldap-plain', 'LDAP without TLS sends every login password in clear. Use ldaps://.', { source: NET_SRC }));

    const script = [
      '#!/usr/bin/env bash',
      '# Users and groups from VCF SSO in VCF Operations for Networks: added, or their',
      '# role changed when it differs. --dry-run prints what it would do.',
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      ...networksApi(),
      '',
      'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
      '# The identity source has to be connected first.',
      "if ! ni GET /settings/vidm | jq -e '(.enabled // .enable // false) == true' >/dev/null; then",
      '  echo "VCF SSO is not enabled in Networks (Settings > Identity & Access Management). Enable it first." >&2; exit 2',
      'fi',
      '',
      'USERS=$(ni GET /settings/users/all 2>/dev/null || ni GET /settings/users)',
      'GRPS=$(ni GET /settings/user-groups)',
      '',
      "while read -r row; do",
      "  U=$(jq -r .username <<<\"$row\"); D=$(jq -r .domain <<<\"$row\"); R=$(jq -r .role <<<\"$row\")",
      "  CUR=$(jq -r --arg u \"$U\" --arg d \"$D\" '[.. | objects | select((.username? // \"\" | ascii_downcase) == ($u | ascii_downcase) or (.username? // \"\" | ascii_downcase) == (($u + \"@\" + $d) | ascii_downcase)) | .role] | first // empty' <<<\"$USERS\")",
      '  if [[ "$CUR" == "$R" ]]; then echo "user $U: $R already"; continue; fi',
      '  if (( DRY_RUN )); then echo "DRY RUN: would ${CUR:+change }${CUR:-add }user $U as $R"; continue; fi',
      '  if [[ -z "$CUR" ]]; then ni POST /settings/users/vidm --data "$row" >/dev/null; else ni PUT /settings/users/vidm --data "$row" >/dev/null; fi',
      '  echo "user $U: $R"',
      "done < <(jq -c '.[]' users.json)",
      '',
      "while read -r row; do",
      "  G=$(jq -r .group_name <<<\"$row\"); R=$(jq -r .role <<<\"$row\")",
      "  CUR=$(jq -r --arg g \"$G\" '[.. | objects | select((.group_name? // .name? // \"\" | ascii_downcase) == ($g | ascii_downcase)) | .role] | first // empty' <<<\"$GRPS\")",
      '  if [[ "$CUR" == "$R" ]]; then echo "group $G: $R already"; continue; fi',
      '  if (( DRY_RUN )); then echo "DRY RUN: would ${CUR:+change }${CUR:-add }group $G as $R"; continue; fi',
      '  if [[ -z "$CUR" ]]; then ni POST /settings/user-groups/vidm --data "$row" >/dev/null; else ni PUT /settings/user-groups/vidm --data "$row" >/dev/null; fi',
      '  echo "group $G: $R"',
      "done < <(jq -c '.[]' groups.json)",
      '',
    ].join('\n');

    return {
      platform: NET,
      title: `${groups.length} group${groups.length === 1 ? '' : 's'} and ${users.length} user${users.length === 1 ? '' : 's'} from VCF SSO${ldap ? ', and LDAP (by hand)' : ''}`,
      effect: 'reversible',
      trigger: { kind: 'manual', detail: 'Run once, and when the roles change.', worstCase: 'once' },
      scope: { what: 'Role assignments in Networks for the listed users and groups.', decidedBy: principals.map((p) => `${p.kind} ${p.name}@${p.domain}: ${p.role}.`), ifWrong: 'Admin to the wrong group lets its members change data sources, settings and backups. Removing it is one call.' },
      guardrails: [
        { rule: 'Stops unless VCF SSO is connected', because: 'Adding users from an identity source Networks cannot reach creates accounts nobody can log in with.' },
        { rule: 'Changes a role only when it differs', because: 'A rerun is a no-op, and says so.' },
      ],
      dryRun: [`Run ./${base}.sh --dry-run.`],
      undo: ['DELETE /api/ni/settings/users/{id} or /settings/user-groups/{id}; or change the role back and rerun.'],
      told: ['Nobody; the change is in the Networks audit log.'],
      requires: ['VCF SSO (the identity broker) enabled in Networks.', 'The groups existing in the directory behind it.', 'A Networks admin account.'],
      files: {
        [`${base}.sh`]: script,
        'users.json': `${JSON.stringify(users, null, 2)}\n`,
        'groups.json': `${JSON.stringify(groups, null, 2)}\n`,
        'IMPORT.md': importGuide({
          product: 'VCF Operations for Networks',
          intro: `${base}.sh adds the users in users.json (POST /api/ni/settings/users/vidm) and groups in groups.json (POST /api/ni/settings/user-groups/vidm), or re-roles them with PUT.`,
          steps: [
            { heading: 'Users and groups', lines: [`\`./${base}.sh\` (\`--dry-run\` first). By hand: Settings > Identity & Access Management > User Management.`] },
            ldap
              ? {
                  heading: 'LDAP (by hand — the API has no LDAP call)',
                  lines: [
                    `Settings > Identity & Access Management > LDAP > Edit: URL ${ldapUrl}, domain ${str(values, 'ldap_domain', '')}, base DN ${str(values, 'ldap_base', '')}, admin group DN ${str(values, 'ldap_admin_group', '')}, member group DN ${str(values, 'ldap_member_group', '')}, a bind account (its password from your vault, typed there), then Test and Save.`,
                  ],
                }
              : undefined,
            {
              heading: 'Local users (by hand, if you need one)',
              lines: ['The API can only change a local user’s password (PUT /settings/users/password). Create local users under Settings > Identity & Access Management > User Management > Add User.'],
            },
          ],
          verify: ['The API names the identity source vidm; in 9.x it is VCF SSO through the identity broker.', 'The shape of GET /settings/users and /settings/user-groups (read generically for username / group_name and role).'],
          sources: [API_REF, 'Settings: users/vidm, user-groups/vidm (role MEMBER | ADMIN | AUDITOR), vidm, users/password.'],
        }),
      },
      findings,
    };
  },
});

// ---------------------------------------------------------------------------

const DATA_FILTER = [
  'data_sources', 'applications', 'policies', 'events', 'custom_dashboards', 'east_west_ip', 'north_south_ip', 'physical_subnet_vlan', 'physical_ip_dns_mapping',
  'snmp', 'smtp', 'syslog', 'web_proxy', 'ldap', 'vidm', 'user_data', 'system_configuration', 'data_management', 'analytics_outliers', 'analytics_thresholds',
  'online_update_status', 'ceip_status', 'audit_logs_pii_status',
];

export const VCFNET_BACKUP: AutomationBlueprint = automationBlueprint({
  id: 'vcfnet_backup',
  platform: NET,
  label: 'Scheduled configuration backup',
  group: 'Settings',
  description:
    'Back up the Networks configuration — data sources, applications, IP settings, alerts, SNMP, syslog, mail, users and the rest — to an SSH or FTP server on a daily or weekly schedule, with the server password from your vault; created enabled and run once now.',
  inputs: [
    {
      id: 'server_type',
      label: 'To',
      control: 'select',
      options: [
        { value: 'SSH', label: 'SSH (SFTP/SCP) server' },
        { value: 'FTP', label: 'FTP server' },
        { value: 'LOCAL', label: 'The platform appliance’s own disk' },
      ],
      default: 'SSH',
    },
    { id: 'server', label: 'Server', control: 'text', default: 'backup01.example.com', hint: 'FQDN, IPv4 or IPv6', showWhen: { input: 'server_type', notEquals: ['LOCAL'] } },
    { id: 'port', label: 'Port', control: 'number', default: 22, min: 1, max: 65535, showWhen: { input: 'server_type', notEquals: ['LOCAL'] } },
    { id: 'username', label: 'Username', control: 'text', default: 'svc-vcfnet-backup', showWhen: { input: 'server_type', notEquals: ['LOCAL'] } },
    { id: 'directory', label: 'Directory', control: 'text', default: '/backups/vcfnet' },
    { id: 'file_name', label: 'File name', control: 'text', default: 'vcfnet-config-backup.tar' },
    {
      id: 'period',
      label: 'Schedule',
      control: 'select',
      options: [
        { value: 'DAILY', label: 'Daily' },
        { value: 'WEEKLY', label: 'Weekly' },
      ],
      default: 'DAILY',
    },
    { id: 'day_of_week', label: 'Day', control: 'select', options: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, i) => ({ value: String(i + 1), label: day })), default: '1', showWhen: { input: 'period', equals: ['WEEKLY'] } },
    { id: 'hour', label: 'Hour (UTC)', control: 'number', default: 1, min: 0, max: 23 },
    { id: 'minute', label: 'Minute', control: 'number', default: 30, min: 0, max: 59 },
    { id: 'what', label: 'Back up', control: 'checklist', options: DATA_FILTER.map((key) => ({ value: key, label: key.replace(/_/g, ' ') })), default: DATA_FILTER.join(',') },
    { id: 'run_now', label: 'Run one backup now', control: 'toggle', default: true },
  ],
  automation: (values: BlueprintValues, name: string): Automation => {
    const serverType = str(values, 'server_type', 'SSH');
    const server = str(values, 'server', '');
    const port = num(values, 'port', serverType === 'FTP' ? 21 : 22);
    const user = str(values, 'username', '');
    const directory = str(values, 'directory', '/backups/vcfnet');
    const fileName = str(values, 'file_name', 'vcfnet-config-backup.tar');
    const period = str(values, 'period', 'DAILY');
    const hour = num(values, 'hour', 1);
    const minute = num(values, 'minute', 30);
    const day = num(values, 'day_of_week', 1);
    const what = listOf(str(values, 'what', DATA_FILTER.join(',')));
    const runNow = bool(values, 'run_now', true);
    const base = slugOf(name || 'backup', 'backup');
    const findings: Finding[] = [];
    if (serverType !== 'LOCAL' && !server) findings.push(error('vcfnet.backup.no-server', 'Name the backup server.', { source: NET_SRC }));
    if (serverType === 'FTP') findings.push(warning('vcfnet.backup.ftp', 'FTP sends the backup — data source credentials included, encrypted or not — and the server password in clear. Use SSH.', { source: NET_SRC }));
    if (serverType === 'LOCAL') findings.push(warning('vcfnet.backup.local', 'A backup on the appliance’s own disk is lost with the appliance. Use SSH to another host.', { source: NET_SRC }));
    for (const key of ['data_sources', 'applications', 'user_data']) {
      if (!what.includes(key)) findings.push(warning('vcfnet.backup.partial', `${key.replace(/_/g, ' ')} is not backed up; a restore would need it rebuilt by hand.`, { source: NET_SRC }));
    }

    const serverBlock = serverType === 'SSH' ? 'ssh_file_server' : serverType === 'FTP' ? 'ftp_file_server' : 'local_file_server';
    const body = {
      data_filter: Object.fromEntries(DATA_FILTER.map((key) => [key, what.includes(key)])),
      backup_schedule: { enable: true, schedule_period: period, minute, hour, ...(period === 'WEEKLY' ? { day_of_week: day } : {}) },
      backup_file_server_type: serverType,
      [serverBlock]: serverType === 'LOCAL' ? { backup_directory: directory, backup_file_name: fileName } : { server_address: server, port, username: user, backup_directory: directory, backup_file_name: fileName },
      schedule_now: runNow,
    };

    const script = [
      '#!/usr/bin/env bash',
      `# Configure the VCF Operations for Networks configuration backup (${serverType}, ${period.toLowerCase()}), enabled.`,
      '# The server password comes from VCFNET_BACKUP_PASSWORD through jq $ENV. --dry-run prints the body.',
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      ...networksApi(),
      '',
      'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
      ...(serverType !== 'LOCAL' ? envCheck(['VCFNET_BACKUP_PASSWORD']) : []),
      `BLOCK=${shq(serverBlock)}`,
      `BODY=$(jq --arg b "$BLOCK" '${serverType !== 'LOCAL' ? 'if .[$b].server_address then .[$b].password = $ENV.VCFNET_BACKUP_PASSWORD else . end' : '.'}' backup.json)`,
      "if (( DRY_RUN )); then echo \"DRY RUN: would send:\"; jq --arg b \"$BLOCK\" 'del(.[$b].password)' <<<\"$BODY\"; exit 0; fi",
      '',
      '# PUT when a backup configuration exists, POST when not.',
      "if ni GET /settings/backup 2>/dev/null | jq -e '.backup_file_server_type? // .backup_schedule? // empty' >/dev/null; then",
      '  ni PUT /settings/backup --data @- <<<"$BODY" >/dev/null; echo "backup configuration updated"',
      'else',
      '  ni POST /settings/backup --data @- <<<"$BODY" >/dev/null; echo "backup configuration created"',
      'fi',
      ...(runNow
        ? [
            'for n in $(seq 1 30); do',
            '  S=$(ni GET /settings/backup/status || echo "{}")',
            "  jq -e '[.. | strings] | any(test(\"SUCCESS|COMPLETE|FAIL\"; \"i\"))' <<<\"$S\" >/dev/null && { jq . <<<\"$S\"; break; }",
            '  sleep 20',
            'done',
          ]
        : []),
      '',
    ].join('\n');

    return {
      platform: NET,
      title: `Configuration backup to ${serverType === 'LOCAL' ? 'the appliance' : `${serverType} ${server}`}, ${period.toLowerCase()} at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC${runNow ? ', and now' : ''}`,
      effect: 'reversible',
      trigger: { kind: 'schedule', detail: `${period === 'WEEKLY' ? `Weekly (day ${day})` : 'Daily'} at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC, run by Networks itself.`, worstCase: period === 'WEEKLY' ? 'once a week' : 'once a day' },
      scope: { what: `The Networks configuration (${what.length} of ${DATA_FILTER.length} sections), written to ${serverType === 'LOCAL' ? directory : `${server}:${directory}`}.`, decidedBy: ['backup.json, written from the choices above.'], ifWrong: 'A backup that silently fails is found on the day it is needed. The script waits for the first one and prints its status.' },
      guardrails: [
        { rule: 'Password only from the environment', because: 'The backup server credential in a file is a credential in the repository.' },
        ...(runNow ? [{ rule: 'Runs one backup now and waits for its status', because: 'A schedule that has never produced a file is not a backup.' }] : []),
      ],
      dryRun: [`Run ./${base}.sh --dry-run: it prints the body without the password.`],
      undo: ['DELETE /api/ni/settings/backup removes the configuration; the files on the server stay.'],
      told: ['Nobody on success. A failed backup shows under Settings > Backup and Restore; alert on it with vcfnet_search_alert if you want a page.'],
      requires: [...(serverType !== 'LOCAL' ? [`A ${serverType} account on ${server} with write access to ${directory}; VCFNET_BACKUP_PASSWORD from your vault.`] : []), 'A Networks admin account.', 'jq and curl.'],
      files: {
        [`${base}.sh`]: script,
        'backup.json': `${JSON.stringify(body, null, 2)}\n`,
        'IMPORT.md': importGuide({
          product: 'VCF Operations for Networks',
          intro: `${base}.sh sends backup.json, with the password from VCFNET_BACKUP_PASSWORD, to POST (or PUT) /api/ni/settings/backup.`,
          steps: [{ heading: 'Apply', lines: [`\`./${base}.sh\` (\`--dry-run\` first). By hand: Settings > Backup and Restore > Configure.`] }],
          verify: ['day_of_week numbering (1 = Sunday is assumed).', 'Retention: the API has no retention field. Keep a fixed file name and rotate on the server (e.g. logrotate or a daily copy with the date), or vary the name per run.'],
          sources: [API_REF, 'Settings: backup (BackupRestoreRequest: data_filter, backup_schedule {enable, schedule_period DAILY | WEEKLY, minute, hour, day_of_week}, backup_file_server_type LOCAL | SSH | FTP | S3, *_file_server, schedule_now), backup/status.'],
        }),
      },
      notes: ['The S3 target in the API is for the cloud offering and is not offered here.', ...(isIpv6(server) ? ['An IPv6 server address is sent as it is.'] : [])],
      findings,
    };
  },
});
