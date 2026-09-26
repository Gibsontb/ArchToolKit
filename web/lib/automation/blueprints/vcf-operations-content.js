/**
 * VCF Operations: the content an automation stands on.
 *
 * The first set of VCF Operations blueprints wires things together — a rule, a
 * group, a schedule. This set writes the content itself: the symptom and the
 * alert, the recommendation and the action behind it, alert groups, the super
 * metric, the policy for a class of workload, the Security Posture Management
 * benchmark, the payload a notification sends, the nightly backup of all of it,
 * and the check that VCF Operations is still collecting at all. What changes a
 * policy applies it (policy-apply.sh: export, merge, import, read back).
 *
 * The VCF Ops content page finds what is wrong with an estate's content. These are the
 * shapes it should have been written in.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { authHeader, authPreamble, readScript, scheduledEnv,                  } from '../apply.js';
import {
  FORMAT_SOURCES,
  contentImportScript,
  contentPackage,
  contentStep,
  importMd,
  nothingToImportMd,
  stableId,
  superMetricsJson,
} from '../vcfops-import.js';
import {
  OBJECT_TYPES,
  SYMPTOM_KINDS,
  alertJson,
  alertModelXml,
  cells,
  kindInfo,
  kindLabel,
  policyApplyScript,
  policyChangesJson,
  rows,
  severityOf,
  splitKind,
  symptomJson,
                 
              
                    
                     
                  
                
                   
                      
                   
} from './vcf-ops-symptoms.js';

const PLATFORM = 'vcf-operations'         ;
const SRC = 'ArchToolKit';

/**
 * send-sample.sh for ServiceNow: sends when run (--dry-run previews), the credential from a
 * mode-600 file on stdin, and no second incident for the same correlation_id.
 */
function serviceNowSample(endpoint        , sampleFile        )         {
  return [
    '#!/usr/bin/env bash',
    '# Post the filled-in sample to ServiceNow, to test the receiving end.',
    '#',
    '# This CREATES AN INCIDENT when run. With --dry-run it only prints what it would send.',
    '# The Table API needs a credential: SN_USER, and SN_PASSWORD_FILE, a file holding',
    '# the password with mode 600. It goes to curl as a config on stdin (curl -K -),',
    '# never as an argument.',
    '#',
    '# The Table API does not deduplicate: every POST is a new incident. Against it,',
    '# this first looks for an open incident with the same correlation_id and stops',
    '# if there is one.',
    'set -euo pipefail',
    `ENDPOINT="\${ENDPOINT:-${endpoint.replace(/["$`\\]/g, '\\$&')}}"`,
    `SAMPLE="$(cd "$(dirname "$0")" && pwd)/${sampleFile}"`,
    'EXECUTE=1',
    '[[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    'CORR=$(jq -r \'.correlation_id // empty\' "$SAMPLE")',
    '[[ -n "$CORR" ]] || { echo "The sample has no correlation_id." >&2; exit 2; }',
    '',
    'if (( ! EXECUTE )); then',
    '  echo "DRY RUN: would POST $SAMPLE to $ENDPOINT, creating one incident with correlation_id $CORR:"',
    '  jq . "$SAMPLE"',
    '  echo "Dry run: nothing was sent. Run it without --dry-run to send, against a sub-production instance first."',
    '  exit 0',
    'fi',
    '',
    ': "${SN_USER:?set SN_USER to the ServiceNow integration user}"',
    ': "${SN_PASSWORD_FILE:?set SN_PASSWORD_FILE to a file holding its password, mode 600}"',
    '[[ -r "$SN_PASSWORD_FILE" ]] || { echo "Cannot read $SN_PASSWORD_FILE" >&2; exit 2; }',
    'PERM=$(stat -c %a "$SN_PASSWORD_FILE" 2>/dev/null || stat -f %Lp "$SN_PASSWORD_FILE")',
    '[[ "$PERM" == 600 || "$PERM" == 400 ]] || { echo "$SN_PASSWORD_FILE is mode $PERM: make it 600 so only you can read it." >&2; exit 2; }',
    '',
    '# user:password as a curl config on stdin; quotes and backslashes escaped for it.',
    'sn() {',
    '  { printf \'user = "%s:\' "$SN_USER"; tr -d \'\\n\' < "$SN_PASSWORD_FILE" | sed \'s/[\\\\"]/\\\\&/g\'; printf \'"\\n\'; } |',
    '    curl -sS -f -K - "$@"',
    '}',
    '',
    'if [[ "$ENDPOINT" == */api/now/table/incident* ]]; then',
    '  BASE="${ENDPOINT%%/api/now/*}"',
    '  EXISTING=$(sn -G "$BASE/api/now/table/incident" -H "Accept: application/json" \\',
    '    --data-urlencode "sysparm_query=correlation_id=${CORR}^active=true" \\',
    '    --data-urlencode "sysparm_fields=number" --data-urlencode "sysparm_limit=1" | jq -r \'.result[0].number // empty\')',
    '  if [[ -n "$EXISTING" ]]; then',
    '    echo "Open incident $EXISTING already has correlation_id $CORR; not creating a second. Close it to test again." >&2',
    '    exit 1',
    '  fi',
    'else',
    '  echo "Not the Table API incident endpoint: this cannot check for an existing incident first. The receiving Import Set or Scripted REST API must upsert on correlation_id."',
    'fi',
    '',
    'sn -X POST "$ENDPOINT" -H "Content-Type: application/json" -H "Accept: application/json" --data-binary @"$SAMPLE" |',
    '  jq -r \'"created \\(.result.number // "?") (sys_id \\(.result.sys_id // "?"))"\'',
    'echo "Check it reads correctly, then close it."',
    '',
  ].join('\n');
}

/**
 * The Security Posture Management benchmarks 9.1 ships, and how their
 * compliance alert definitions are usually named. VERIFY per release.
 * Compliance and its CIS / DISA STIG / HIPAA / ISO packs are deprecated in 9.1.
 */
const BENCHMARK_ALERT_RX                                   = {
  'VCF 9.x Security Configuration Guide v1.0': 'VCF 9.*Security Configuration Guide',
  'PCI DSS v4.0.1 for VCF 9 v1.0': 'PCI DSS',
  'VCF 9 General Controls v1.0': 'General Controls',
};

// ---------------------------------------------------------------------------
// Shared bash helpers (also used by vcf-ops-operate.ts and vcf-ops-build.ts)
// ---------------------------------------------------------------------------

/** Escape for a bash single-quoted string. */
export function shq(text        )         {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** The variable authPreamble keeps its private header file in. */
export function authFileVar(target             )         {
  return authHeader(target).slice(3, -1);
}

/**
 * A private work directory, removed on exit together with the auth header file.
 * One trap for both: a second `trap … EXIT` would replace the one authPreamble
 * set, and the token file would be left behind.
 */
export function workDirLines(target              = PLATFORM, extra                    = [])           {
  const files = [`"$WORK"`, `"\${${authFileVar(target)}:-}"`, ...extra.map((name) => `"\${${name}:-}"`)].join(' ');
  return ['WORK=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/work.XXXXXX")', `trap 'rm -rf ${files}' EXIT`];
}

/**
 * Paged reads for a readScript, all through files so no list is ever an argument
 * (an argument over 128 KB fails with "Argument list too long").
 *
 * get_all and post_all follow page= until a short page or pageInfo.totalCount,
 * and fail — rather than return an empty list — when a page cannot be read or
 * has neither the list key nor pageInfo. They need WORK (workDirLines).
 */
export const PAGED_HELPERS                    = [
  'post() {',
  `  curl -sS -f -X POST "https://\${VCFOPS_HOST}$1" -H "${authHeader(PLATFORM)}" \\`,
  '    -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @-',
  '}',
  '',
  '# pages METHOD PATH KEY OUT [BODYFILE]: every item of .KEY across all pages, as',
  '# one JSON array in the file OUT.',
  'pages() {',
  '  local method="$1" path="$2" key="$3" out="$4" body="${5:-}" page=0 size="${PAGE_SIZE:-1000}" sep="?" n total',
  '  [[ "$path" == *\\?* ]] && sep="&"',
  '  : > "$out.items"',
  '  while :; do',
  '    if [[ "$method" == GET ]]; then',
  '      get "${path}${sep}page=${page}&pageSize=${size}" > "$WORK/page.json" || { echo "GET ${path} (page ${page}) failed" >&2; return 1; }',
  '    else',
  '      post "${path}${sep}page=${page}&pageSize=${size}" < "$body" > "$WORK/page.json" || { echo "POST ${path} (page ${page}) failed" >&2; return 1; }',
  '    fi',
  '    jq -e --arg k "$key" \'type == "object" and (has($k) or has("pageInfo"))\' "$WORK/page.json" >/dev/null \\',
  '      || { echo "${path}: the response has no .${key} — VERIFY the response shape" >&2; return 1; }',
  '    jq -c --arg k "$key" \'(.[$k] // [])[]\' "$WORK/page.json" >> "$out.items" || return 1',
  '    n=$(jq --arg k "$key" \'(.[$k] // []) | length\' "$WORK/page.json") || return 1',
  '    total=$(jq \'.pageInfo.totalCount // -1\' "$WORK/page.json") || return 1',
  '    page=$((page + 1))',
  '    if (( n < size )) || (( total >= 0 && page * size >= total )); then break; fi',
  '    (( page < 10000 )) || { echo "${path}: still paging after 10000 pages" >&2; return 1; }',
  '  done',
  '  jq -s . "$out.items" > "$out" || return 1',
  '  rm -f "$out.items"',
  '}',
  'get_all() { pages GET "$@"; }',
  'post_all() { pages POST "$1" "$2" "$3" "$4"; }',
];

/**
 * Posting a report to a webhook. curl -f makes an HTTP error a failure, and a
 * failed post turns the exit code into 3, so an undelivered report is never
 * mistaken for a delivered one (1 stays "problems found", 2 "could not run").
 */
export const WEBHOOK_HELPER                    = [
  'WEBHOOK_FAILED=0',
  'post_webhook() {',
  '  curl -sS -f -X POST "$1" -H "Content-Type: application/json" --data-binary @"$2" >/dev/null \\',
  '    || { echo "webhook post to $1 failed: the report was NOT delivered" >&2; WEBHOOK_FAILED=1; }',
  '}',
  '# Exit with $1, or with 3 when a webhook post failed.',
  'finish() { if (( WEBHOOK_FAILED )); then exit 3; fi; exit "$1"; }',
];

/** Object kinds people write alerts against, with the metrics that matter on each. */
const KINDS                                                                                                                = {
  VirtualMachine: {
    label: 'Virtual machine',
    metrics: [
      { key: 'cpu|readyPct', label: 'CPU ready %', unit: '%' },
      { key: 'cpu|usage_average', label: 'CPU usage %', unit: '%' },
      { key: 'mem|guest_usage', label: 'Guest memory usage %', unit: '%' },
      { key: 'mem|balloonPct', label: 'Memory ballooned %', unit: '%' },
      { key: 'guestfilesystem|percentage_total', label: 'Guest disk used %', unit: '%' },
      { key: 'virtualDisk|totalLatency', label: 'Disk latency (ms)', unit: 'ms' },
      { key: 'diskspace|snapshot', label: 'Snapshot space (GB)', unit: 'GB' },
    ],
  },
  HostSystem: {
    label: 'ESX host',
    metrics: [
      { key: 'cpu|usage_average', label: 'CPU usage %', unit: '%' },
      { key: 'mem|host_usagePct', label: 'Memory usage %', unit: '%' },
      { key: 'cpu|capacity_contentionPct', label: 'CPU contention %', unit: '%' },
      { key: 'net|droppedPct', label: 'Network packets dropped %', unit: '%' },
      { key: 'sys|uptime_latest', label: 'Uptime (seconds)', unit: 's' },
    ],
  },
  ClusterComputeResource: {
    label: 'Cluster',
    metrics: [
      { key: 'cpu|demandPct', label: 'CPU demand %', unit: '%' },
      { key: 'mem|host_usagePct', label: 'Memory usage %', unit: '%' },
      { key: 'OnlineCapacityAnalytics|timeRemaining', label: 'Capacity time remaining (days)', unit: 'days' },
    ],
  },
  Datastore: {
    label: 'Datastore',
    metrics: [
      { key: 'capacity|usedSpacePct', label: 'Used space %', unit: '%' },
      { key: 'devices|totalLatency_average', label: 'Latency (ms)', unit: 'ms' },
      { key: 'OnlineCapacityAnalytics|diskspace|timeRemaining', label: 'Disk time remaining (days)', unit: 'days' },
    ],
  },
};

const METRIC_OPTIONS = Object.entries(KINDS).flatMap(([kind, info]) =>
  info.metrics.map((metric) => ({ value: `${kind}::${metric.key}`, label: metric.label, group: info.label })),
);

function metricOf(value        )                                                             {
  const [kind = 'HostSystem', key = 'cpu|usage_average'] = value.split('::');
  const found = KINDS[kind]?.metrics.find((metric) => metric.key === key);
  return { kind, key, label: found?.label ?? key, unit: found?.unit ?? '' };
}

/** The alert classification VCF Operations files every alert definition under. */
const ALERT_TYPES                                              = [
  { value: '16', label: 'Virtualization/Hypervisor' },
  { value: '15', label: 'Application' },
  { value: '17', label: 'Hardware (OSI)' },
  { value: '18', label: 'Storage' },
  { value: '19', label: 'Network' },
];
const ALERT_SUBTYPES                                              = [
  { value: '19', label: 'Performance' },
  { value: '18', label: 'Availability' },
  { value: '20', label: 'Capacity' },
  { value: '21', label: 'Compliance' },
  { value: '22', label: 'Configuration' },
];

const OPERATORS = [
  { value: 'GT', label: 'is above' },
  { value: 'GT_EQ', label: 'is at or above' },
  { value: 'LT', label: 'is below' },
  { value: 'LT_EQ', label: 'is at or below' },
];

const CRITICALITIES = [
  { value: 'AUTO', label: 'From the symptoms (the worst that holds)' },
  { value: 'CRITICAL', label: 'Critical' },
  { value: 'IMMEDIATE', label: 'Immediate' },
  { value: 'WARNING', label: 'Warning' },
  { value: 'INFO', label: 'Info' },
];

const IMPACTS = [
  { value: 'auto', label: 'From the subtype (capacity → efficiency, compliance / configuration → risk, else health)' },
  { value: 'HEALTH', label: 'Health' },
  { value: 'RISK', label: 'Risk' },
  { value: 'EFFICIENCY', label: 'Efficiency' },
];

/** The actions VCF Operations can run from a recommendation, by the name the action list shows. */
const ACTIONS                                                                                                                           = [
  { value: 'DeleteUnusedSnapshotsForVM', label: 'Delete Unused Snapshots for VM', group: 'Virtual machine', target: 'VirtualMachine', irreversible: true },
  { value: 'DeletePoweredOffVM', label: 'Delete Powered Off VM', group: 'Virtual machine', target: 'VirtualMachine', irreversible: true },
  { value: 'PowerOffVM', label: 'Power Off VM', group: 'Virtual machine', target: 'VirtualMachine', disruptive: true },
  { value: 'ShutDownGuestOSForVM', label: 'Shut Down Guest OS for VM', group: 'Virtual machine', target: 'VirtualMachine', disruptive: true },
  { value: 'PowerOnVM', label: 'Power On VM', group: 'Virtual machine', target: 'VirtualMachine' },
  { value: 'SetCPUCountForVM', label: 'Set CPU Count for VM', group: 'Virtual machine', target: 'VirtualMachine', disruptive: true },
  { value: 'SetMemoryForVM', label: 'Set Memory for VM', group: 'Virtual machine', target: 'VirtualMachine', disruptive: true },
  { value: 'SetCPUCountAndMemoryForVM', label: 'Set CPU Count and Memory for VM', group: 'Virtual machine', target: 'VirtualMachine', disruptive: true },
  { value: 'SetCPUResourcesForVM', label: 'Set CPU Resources for VM', group: 'Virtual machine', target: 'VirtualMachine' },
  { value: 'SetMemoryResourcesForVM', label: 'Set Memory Resources for VM', group: 'Virtual machine', target: 'VirtualMachine' },
  { value: 'MoveVM', label: 'Move VM', group: 'Virtual machine', target: 'VirtualMachine' },
  { value: 'DeleteUnusedSnapshotsForDatastore', label: 'Delete Unused Snapshots for Datastore', group: 'Datastore', target: 'Datastore', irreversible: true },
  { value: 'RebalanceContainer', label: 'Rebalance Container', group: 'Cluster', target: 'ClusterComputeResource' },
  { value: 'SetDRSAutomation', label: 'Set DRS Automation', group: 'Cluster', target: 'ClusterComputeResource' },
];

function actionOf(value        )                                       {
  return ACTIONS.find((action) => action.value === value);
}

/**
 * The bash that finds an action's id by the name the action list shows.
 * VERIFY: GET /suite-api/api/actiondefinitions and its list key.
 */
const ACTION_ID_LINES                    = [
  '# action_id NAME: the id of the action with this name (or id). VERIFY the list key on your release.',
  'action_id() {',
  '  get "/suite-api/api/actiondefinitions?pageSize=1000" > "$WORK/actions.json" || { echo "Cannot read the action definitions." >&2; return 1; }',
  "  jq -r --arg n \"$1\" '[(.actionDefinitions // .actions // .actionDefinition // [])[] | select((.name // \"\") == $n or (.id // \"\") == $n)][0].id // empty' \"$WORK/actions.json\"",
  '}',
];

const RELATIONS                      = ['SELF', 'CHILD', 'PARENT', 'DESCENDANT', 'ANCESTOR'];
const POPULATIONS                        = ['ALL', 'ANY', 'COUNT', 'PERCENT'];

export const VCF_OPERATIONS_CONTENT                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_alert_definition',
    platform: PLATFORM,
    label: 'An alert, with its symptoms and a recommendation',
    group: 'Alerts',
    description:
      'The objects an alert actually is: symptoms of any kind (metric static or dynamic thresholds, text and number properties, message events, faults, metric events, log queries), grouped into symptom sets on the object itself or its children, parents, descendants or ancestors, an alert definition raised when all or any of the sets hold, and a recommendation — with an action behind it if you want one. apply.sh creates them in the order they refer to each other and enables the alert in the policies you name.',
    inputs: [
      { id: 'alert_name', label: 'Alert name', control: 'text', default: 'Host memory pressure sustained' },
      { id: 'description', label: 'Description', control: 'textarea', default: '', hint: 'Empty writes one from the symptoms' },
      {
        id: 'base_kind',
        label: 'Raised on',
        control: 'select',
        options: [{ value: 'metric', label: 'The object type of the threshold metric below' }, ...OBJECT_TYPES, { value: 'custom', label: 'Another adapter and object type', group: 'Other' }],
        default: 'metric',
      },
      { id: 'adapter_kind', label: 'Adapter kind', control: 'combo', options: ['VMWARE', 'VirtualAndPhysicalSANAdapter', 'NSXTAdapter', 'KubernetesAdapter', 'VCFAdapter', 'LogInsightAdapter', 'NETWORK_INSIGHT'].map((v) => ({ value: v, label: v })), default: 'VMWARE', showWhen: { input: 'base_kind', equals: ['custom'] } },
      { id: 'resource_kind', label: 'Object type (resource kind)', control: 'text', default: 'VirtualMachine', showWhen: { input: 'base_kind', equals: ['custom'] } },
      { id: 'threshold_pair', label: 'Warning and critical metric thresholds (symptom set 1)', control: 'toggle', default: true },
      { id: 'metric', label: 'When', control: 'select', options: METRIC_OPTIONS, default: 'HostSystem::mem|host_usagePct', showWhen: { input: 'threshold_pair', equals: ['true'] } },
      { id: 'operator', label: 'Is', control: 'select', options: OPERATORS, default: 'GT', showWhen: { input: 'threshold_pair', equals: ['true'] } },
      { id: 'warning_at', label: 'Warning at', control: 'number', default: 85, min: 0, max: 1000000, showWhen: { input: 'threshold_pair', equals: ['true'] } },
      { id: 'critical_at', label: 'Critical at', control: 'number', default: 95, min: 0, max: 1000000, showWhen: { input: 'threshold_pair', equals: ['true'] } },
      { id: 'wait_cycles', label: 'For (collection cycles)', control: 'number', default: 3, min: 1, max: 60, hint: 'One cycle is five minutes by default. Three means fifteen minutes of it being true' },
      { id: 'cancel_cycles', label: 'Clear after (cycles)', control: 'number', default: 3, min: 1, max: 60 },
      {
        id: 'symptoms',
        label: 'More symptoms',
        control: 'textarea',
        default: '',
        placeholder: '2 | property | warning | summary|runtime|isIdle | EQ | true\n3 | dynamic | immediate | cpu|usage_average | DT_ABOVE\n1 | fault | critical | fault|hardware|memory\n2 | message | warning | MESSAGE_EVENT | CONTAINS | HA agent\n2 | log | critical | ESX lost access to volume | GT | 0',
        hint: 'One per line: set | kind | criticality | key | operator | value | wait | cancel. Kinds: metric, dynamic, property, property-numeric, message, fault, metric-event, log. Operators: GT GT_EQ LT LT_EQ EQ NOT_EQ; text: CONTAINS NOT_CONTAINS STARTS_WITH ENDS_WITH REGEX NOT_REGEX; dynamic: DT_ABOVE DT_BELOW DT_ABNORMAL. Wait and cancel default to the cycles above',
      },
      {
        id: 'symptom_sets',
        label: 'Symptom sets',
        control: 'textarea',
        default: '1 | self | - | all | 0 | or',
        hint: 'set | applies to | object type | population | n | combine',
        help: 'One row per set. Applies to: self, child, parent, descendant, ancestor. Object type (for anything but self): adapter:kind, e.g. VMWARE:VirtualMachine. Population (for anything but self): all, any, count (at least n objects), percent (at least n %). Combine: and (every symptom in the set) or or (any one). Set 1 holds the warning / critical pair.',
      },
      {
        id: 'sets_operator',
        label: 'Raise when',
        control: 'select',
        options: [
          { value: 'AND', label: 'All symptom sets hold' },
          { value: 'OR', label: 'Any symptom set holds' },
        ],
        default: 'AND',
      },
      { id: 'criticality', label: 'Criticality', control: 'select', options: CRITICALITIES, default: 'AUTO' },
      { id: 'alert_type', label: 'Type', control: 'select', options: ALERT_TYPES, default: '16' },
      { id: 'alert_subtype', label: 'Subtype', control: 'select', options: ALERT_SUBTYPES, default: '19' },
      { id: 'impact', label: 'Impact badge', control: 'select', options: IMPACTS, default: 'auto' },
      { id: 'recommendation', label: 'Recommendation', control: 'textarea', default: 'Check for VMs with memory reservations or limits on this host, then migrate the largest consumers with vMotion. If the whole cluster is above 85%, this is a capacity request, not a tuning one.', hint: 'What the person who receives it should do. An alert with no answer to "and then what" is noise' },
      { id: 'rec_action', label: 'Action behind the recommendation', control: 'select', options: [{ value: 'none', label: 'None — the recommendation is advice' }, ...ACTIONS.map((a) => ({ value: a.value, label: a.label, group: a.group }))], default: 'none' },
      { id: 'policies', label: 'Enable in policies', control: 'text', default: 'Default Policy', hint: 'Comma separated policy names. "Default Policy" means whichever policy is the default' },
    ],
    automation: (values                 , name        )             => {
      const alertName = str(values, 'alert_name', 'Custom alert');
      const pair = bool(values, 'threshold_pair', true);
      const metric = metricOf(str(values, 'metric', 'HostSystem::mem|host_usagePct'));
      const operator = str(values, 'operator', 'GT');
      const warnAt = num(values, 'warning_at', 85);
      const critAt = num(values, 'critical_at', 95);
      const wait = num(values, 'wait_cycles', 3);
      const cancel = num(values, 'cancel_cycles', 3);
      const type = Number(str(values, 'alert_type', '16'));
      const subType = Number(str(values, 'alert_subtype', '19'));
      const recommendation = str(values, 'recommendation', '');
      const recAction = actionOf(str(values, 'rec_action', 'none'));
      const policies = listOf(str(values, 'policies', ''));
      const criticality = str(values, 'criticality', 'AUTO')                            ;
      const setsOperator = str(values, 'sets_operator', 'AND') === 'OR' ? 'OR' : 'AND';
      const baseChoice = str(values, 'base_kind', 'metric');
      const base = baseChoice === 'metric'
        ? { adapterKind: 'VMWARE', resourceKind: metric.kind }
        : baseChoice === 'custom'
          ? { adapterKind: str(values, 'adapter_kind', 'VMWARE'), resourceKind: str(values, 'resource_kind', 'VirtualMachine') }
          : splitKind(baseChoice);
      const baseLabel = kindLabel(base.adapterKind, base.resourceKind);
      const slug = slugOf(name || alertName, 'alert');
      const rising = operator.startsWith('GT');
      const opLabel = OPERATORS.find((o) => o.value === operator)?.label ?? operator;
      const subtypeImpact         = subType === 20 ? 'EFFICIENCY' : subType === 21 || subType === 22 ? 'RISK' : 'HEALTH';
      const impactChoice = str(values, 'impact', 'auto');
      const impact         = impactChoice === 'HEALTH' || impactChoice === 'RISK' || impactChoice === 'EFFICIENCY' ? impactChoice : subtypeImpact;

      const findings            = [];

      // ---- symptom sets
      const setRows = rows(str(values, 'symptom_sets', '1 | self | - | all | 0 | or')).map(cells);
      const setDefs = new Map                                                                                                                                     ();
      for (const row of setRows) {
        const [setText = '', applies = 'self', objectType = '-', population = 'all', nText = '0', combine = 'or'] = row;
        const setNo = Number(setText);
        if (!Number.isInteger(setNo) || setNo < 1) {
          findings.push(error('vcfops.alert.bad-set', `"${row.join(' | ')}" does not start with a set number.`, { source: SRC }));
          continue;
        }
        const relation = (RELATIONS                     ).includes(applies.toUpperCase()) ? (applies.toUpperCase()            ) : 'SELF';
        if (relation === 'SELF' && applies.toUpperCase() !== 'SELF') findings.push(warning('vcfops.alert.bad-relation', `Set ${setNo}: "${applies}" is not self, child, parent, descendant or ancestor; it is treated as self.`, { source: SRC }));
        const kind = relation === 'SELF' || !objectType || objectType === '-' ? base : splitKind(objectType);
        const pop = (POPULATIONS                     ).includes(population.toUpperCase()) ? (population.toUpperCase()              ) : 'ALL';
        const n = Number(nText) || 0;
        if ((pop === 'COUNT' || pop === 'PERCENT') && n < 1) findings.push(error('vcfops.alert.population-n', `Set ${setNo}: a ${pop.toLowerCase()} population needs n of at least 1.`, { source: SRC }));
        if (pop === 'PERCENT' && n > 100) findings.push(error('vcfops.alert.population-pct', `Set ${setNo}: ${n}% of the related objects can never hold.`, { source: SRC }));
        if (relation !== 'SELF' && kind.resourceKind === base.resourceKind && kind.adapterKind === base.adapterKind) {
          findings.push(warning('vcfops.alert.relation-same-kind', `Set ${setNo} applies to the ${applies} objects but names the alert’s own object type.`, { remediation: 'Name the related object type in the third column, e.g. VMWARE:VirtualMachine for the VMs of a host.', source: SRC }));
        }
        setDefs.set(setNo, { relation, adapterKind: kind.adapterKind, resourceKind: kind.resourceKind, population: pop, n, combine: combine.toUpperCase() === 'AND' ? 'AND' : 'OR' });
      }
      if (!setDefs.has(1)) setDefs.set(1, { relation: 'SELF', adapterKind: base.adapterKind, resourceKind: base.resourceKind, population: 'ALL', n: 0, combine: 'OR' });

      // ---- symptoms
      const bySet = new Map                       ();
      const addTo = (setNo        , spec             ) => bySet.set(setNo, [...(bySet.get(setNo) ?? []), spec]);
      let counter = 0;
      const pairSymptom = (severity                        , value        )              => {
        counter += 1;
        return {
          id: `SymptomDefinition-${stableId(`symptom:${alertName}:${severity.toLowerCase()}`)}`,
          placeholder: `__SYMPTOM_${counter}__`,
          kind: 'metric',
          name: `${alertName} — ${metric.label} ${opLabel} ${value}${metric.unit === '%' ? '%' : ` ${metric.unit}`} (${severity.toLowerCase()})`,
          adapterKind: 'VMWARE',
          resourceKind: metric.kind,
          severity,
          key: metric.key,
          operator,
          value: String(value),
          wait,
          cancel,
        };
      };
      if (pair) {
        const set1 = setDefs.get(1) ;
        if (set1.resourceKind !== metric.kind) {
          findings.push(
            error('vcfops.alert.kind-mismatch', `The threshold metric is on ${KINDS[metric.kind]?.label.toLowerCase() ?? metric.kind}, but set 1 tests ${kindLabel(set1.adapterKind, set1.resourceKind).toLowerCase()} objects.`, {
              remediation: `Raise the alert on "${KINDS[metric.kind]?.label ?? metric.kind}", or make set 1 apply to the related ${metric.kind} objects (e.g. "1 | descendant | VMWARE:${metric.kind} | any | 0 | or").`,
              source: SRC,
            }),
          );
        }
        addTo(1, pairSymptom('WARNING', warnAt));
        addTo(1, pairSymptom('CRITICAL', critAt));
      }
      const usedKinds = new Set             (pair ? ['metric'] : []);
      rows(str(values, 'symptoms', '')).forEach((line, index) => {
        const [setText = '1', kindText = 'metric', critText = 'warning', key = '', opText = '', value = '', waitText = '', cancelText = ''] = cells(line);
        const setNo = Number(setText) || 1;
        const kinfo = kindInfo(kindText.toLowerCase() === 'dt' ? 'dynamic' : kindText.toLowerCase());
        if (kinfo.value !== kindText.toLowerCase() && kindText.toLowerCase() !== 'dt') {
          findings.push(error('vcfops.alert.bad-kind', `"${kindText}" is not a symptom kind. Use one of: ${SYMPTOM_KINDS.map((k) => k.value).join(', ')}.`, { source: SRC }));
          return;
        }
        if (!key) {
          findings.push(error('vcfops.alert.symptom-no-key', `Symptom row ${index + 1} has no ${kinfo.keyIs}.`, { source: SRC }));
          return;
        }
        const op = kinfo.operators.some((o) => o.value === opText.toUpperCase()) ? opText.toUpperCase() : kinfo.operators[0] .value;
        if (opText && op !== opText.toUpperCase()) findings.push(warning('vcfops.alert.bad-operator', `Symptom row ${index + 1}: ${opText} is not an operator for ${kinfo.label}; ${op} is used.`, { source: SRC }));
        if (kinfo.valueIs && value === '' ) findings.push(error('vcfops.alert.symptom-no-value', `Symptom row ${index + 1} (${kinfo.label}) has no ${kinfo.valueIs}.`, { source: SRC }));
        const set = setDefs.get(setNo);
        if (!set) {
          findings.push(error('vcfops.alert.undefined-set', `Symptom row ${index + 1} is in set ${setNo}, which has no row under Symptom sets.`, { source: SRC }));
          return;
        }
        const severity = severityOf(critText);
        usedKinds.add(kinfo.value);
        counter += 1;
        addTo(setNo, {
          id: `SymptomDefinition-${stableId(`symptom:${alertName}:row:${index}:${line}`)}`,
          placeholder: `__SYMPTOM_${counter}__`,
          kind: kinfo.value,
          name: `${alertName} — ${key} ${kinfo.operators.find((o) => o.value === op)?.label ?? op}${value ? ` ${value}` : ''} (${severity.toLowerCase()})`,
          adapterKind: set.adapterKind,
          resourceKind: set.resourceKind,
          severity,
          key,
          operator: op,
          value,
          wait: Number(waitText) || wait,
          cancel: Number(cancelText) || cancel,
        });
      });

      const sets                   = [...setDefs.entries()]
        .sort(([a], [b]) => a - b)
        .map(([setNo, def]) => {
          const symptoms = bySet.get(setNo) ?? [];
          if (symptoms.length === 0) findings.push(warning('vcfops.alert.empty-set', `Symptom set ${setNo} has no symptoms and is left out.`, { source: SRC }));
          return { ...def, symptoms };
        })
        .filter((set) => set.symptoms.length > 0);
      const symptoms = sets.flatMap((set) => set.symptoms);

      if (symptoms.length === 0) findings.push(error('vcfops.alert.no-symptoms', 'The alert has no symptoms, so it can never be raised.', { remediation: 'Turn on the warning and critical thresholds, or add symptom rows.', source: SRC }));
      if (pair && metric.unit === '%' && (warnAt > 100 || critAt > 100)) {
        findings.push(error('vcfops.alert.over-100', `${metric.label} is a percentage, and a threshold above 100 can never be reached.`, { source: SRC }));
      }
      if (pair && (rising ? critAt <= warnAt : critAt >= warnAt)) {
        findings.push(
          error('vcfops.alert.inverted', `The critical threshold (${critAt}) is not beyond the warning threshold (${warnAt}) in the direction of the test.`, {
            remediation: rising ? 'For an "is above" test, critical must be higher than warning.' : 'For an "is below" test, critical must be lower than warning.',
            source: SRC,
          }),
        );
      }
      if (wait === 1) {
        findings.push(
          warning('vcfops.alert.one-cycle', 'A single collection cycle raises this on one five-minute spike.', {
            remediation: 'Most metrics worth alerting on are only a problem when they are sustained. Three cycles is fifteen minutes and filters almost every transient.',
            source: SRC,
          }),
        );
      }
      if (!recommendation.trim()) {
        findings.push(
          warning('vcfops.alert.no-recommendation', 'This alert tells somebody something is wrong and not what to do about it.', {
            remediation: 'The recommendation is what turns an alert into an action. Write the first thing an engineer would check.',
            source: SRC,
          }),
        );
      }
      if (recAction && !recommendation.trim()) {
        findings.push(error('vcfops.alert.action-no-recommendation', 'An action is attached to a recommendation, and there is no recommendation.', { source: SRC }));
      }
      if (recAction && recAction.target !== base.resourceKind) {
        findings.push(warning('vcfops.alert.action-target', `${recAction.label} acts on a ${recAction.target}, and this alert is raised on ${baseLabel.toLowerCase()} objects.`, { remediation: 'An action runs on the object that raised the alert; pick one for that object type.', source: SRC }));
      }
      if (policies.length === 0) {
        findings.push(warning('vcfops.alert.no-policy', 'No policy is named, so the alert is created and enabled nowhere explicitly.', { remediation: 'Name the policies that cover the objects it is for. "Default Policy" is the default one, whatever it is called.', source: SRC }));
      }
      if (usedKinds.has('log')) {
        findings.push(warning('vcfops.alert.log-symptom', 'A log-based symptom is created from a saved query in Log Explorer; its REST shape is not documented.', { remediation: 'Create the log alert with "Log alert from a saved query" (vcflog91_alert_query), then use its symptom here by id. VERIFY the log rows on a test instance first.', source: SRC }));
      }
      if (criticality !== 'AUTO' && symptoms.some((s) => s.severity !== criticality)) {
        findings.push(warning('vcfops.alert.fixed-criticality', `The alert is always ${criticality.toLowerCase()}, so the symptoms’ own criticalities are ignored.`, { remediation: 'Leave criticality to the symptoms to get one alert that escalates from warning to critical.', source: SRC }));
      }

      const describe = (s             ) => `${s.key} ${kindInfo(s.kind).operators.find((o) => o.value === s.operator)?.label ?? s.operator}${s.value ? ` ${s.value}` : ''}`;
      const summary = pair ? `${metric.label} ${opLabel} ${warnAt} (warning) or ${critAt} (critical) for ${wait} cycles` : symptoms.slice(0, 3).map(describe).join('; ') || 'no symptoms';
      const description = str(values, 'description', '') || `Raised when ${summary}${sets.length > 1 ? `, with ${sets.length} symptom sets (${setsOperator === 'AND' ? 'all' : 'any'} must hold)` : ''}.`;

      const ids = { alert: `AlertDefinition-${stableId(`alert:${alertName}`)}`, rec: `Recommendation-ud-${stableId(`recommendation:${alertName}`)}` };
      const spec            = {
        id: ids.alert,
        name: alertName,
        description,
        adapterKind: base.adapterKind,
        resourceKind: base.resourceKind,
        type,
        subType,
        criticality,
        impact,
        setsOperator,
        sets,
        recommendations: recommendation.trim() ? [{ key: ids.rec, placeholder: '__RECOMMENDATION_ID__', description: recommendation }] : [],
      };
      const symptomFile = (s             , index        ) => `${slug}-symptom-${index + 1}-${s.severity.toLowerCase()}.json`;
      const recPayload = recommendation.trim()
        ? { description: recommendation, ...(recAction ? { action: { actionAdapterKindId: 'VMWARE', actionId: '__ACTION_ID__', targetAdapterKindId: 'VMWARE', targetResourceKindId: recAction.target } } : {}) }
        : undefined;
      const changes                = {
        policies,
        changes: [{ label: `alert "${alertName}" enabled`, block: 'Alerts', item: 'Alert', adapterKind: base.adapterKind, resourceKind: base.resourceKind, id: '__ALERT_ID__', set: { enabled: 'true' } }],
      };

      const apply = [
        '#!/usr/bin/env bash',
        `# Create "${alertName}" in VCF Operations: ${symptoms.length} symptom(s),${recPayload ? ' a recommendation,' : ''}`,
        '# the alert that refers to them, and the alert enabled in its policies. Order',
        '# matters — each step needs the ids the previous one returned, which is why',
        '# this is one script.',
        '#',
        '# Applies when run. With --dry-run it only prints what it would send.',
        'set -euo pipefail',
        ...authPreamble('vcf-operations'),
        'command -v jq >/dev/null || { echo "jq 1.6 or later is required" >&2; exit 2; }',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...workDirLines(),
        '',
        'DRY_RUN=0',
        '[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        '',
        `get() { curl -sS -f "https://\${VCFOPS_HOST}$1" -H "${authHeader('vcf-operations')}" -H "Accept: application/json"; }`,
        ...PAGED_HELPERS,
        ...ACTION_ID_LINES,
        '# create KIND FILE: POST it and print the id, or stop: a missing id is not a',
        '# success, and the next step would otherwise refer to "null".',
        'create() {',
        '  local kind="$1" file="$2" id',
        `  id=$(curl -sS -f -X POST "https://\${VCFOPS_HOST}/suite-api/api/$kind" -H "${authHeader('vcf-operations')}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @"$file" | jq -r '.id // empty')`,
        '  [[ -n "$id" ]] || { echo "POST $kind returned no id; see created-ids.txt for what exists so far." >&2; return 1; }',
        '  echo "$id"',
        '}',
        "echo '{}' > \"$WORK/ids.json\"",
        "add_id() { jq --arg k \"$1\" --arg v \"$2\" '. + {($k): $v}' \"$WORK/ids.json\" > \"$WORK/ids.tmp\" && mv \"$WORK/ids.tmp\" \"$WORK/ids.json\"; }",
        '# fill FILE: every placeholder, as a value or a key, replaced by the id it stands for.',
        "fill() { jq --slurpfile m \"$WORK/ids.json\" '$m[0] as $m | walk(if type == \"object\" then with_entries(.key |= ($m[.] // .)) elif type == \"string\" then ($m[.] // .) else . end)' \"$1\"; }",
        '',
        '# Refuse to make a second alert of the same name: the API would accept it.',
        'get_all /suite-api/api/alertdefinitions alertDefinitions "$WORK/defs.json" || exit 2',
        `EXISTING=$(jq -r --arg n ${shq(alertName)} '[.[] | select(.name == $n)][0].id // empty' "$WORK/defs.json")`,
        `[[ -z "$EXISTING" ]] || { echo "An alert definition named ${alertName.replace(/["$`\\]/g, '')} already exists ($EXISTING). Delete it first, or import import/alert-definitions.xml with Overwrite." >&2; exit 1; }`,
        ...(recAction
          ? ['', `ACTION_ID=$(action_id ${shq(recAction.label)}) || exit 2`, `[[ -n "$ACTION_ID" ]] || { echo "No action named ${recAction.label} on this instance: enable actions on the vCenter adapter." >&2; exit 2; }`, 'add_id __ACTION_ID__ "$ACTION_ID"']
          : []),
        '',
        'if (( DRY_RUN )); then',
        `  echo "DRY RUN: would create ${symptoms.length} symptom(s)${recPayload ? ', 1 recommendation' : ''} and the alert in ${slug}-alert.json, then enable it in: ${policies.join(', ') || '(no policy)'}"`,
        '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'fi',
        '',
        ': > created-ids.txt',
        ...symptoms.flatMap((s, index) => [
          `ID=$(create symptomdefinitions "$HERE/${symptomFile(s, index)}")`,
          `add_id ${s.placeholder} "$ID"; echo "symptom ${index + 1} (${s.severity.toLowerCase()})  $ID" | tee -a created-ids.txt`,
        ]),
        ...(recPayload
          ? [`fill "$HERE/${slug}-recommendation.json" > "$WORK/rec.json"`, 'REC_ID=$(create recommendations "$WORK/rec.json")', 'add_id __RECOMMENDATION_ID__ "$REC_ID"; echo "recommendation  $REC_ID" | tee -a created-ids.txt']
          : []),
        `fill "$HERE/${slug}-alert.json" > "$WORK/alert.json"`,
        'ALERT_ID=$(create alertdefinitions "$WORK/alert.json")',
        'echo "alert definition  $ALERT_ID" | tee -a created-ids.txt',
        ...(policies.length > 0
          ? ['', '# Enabled in each policy named: export, merge, import, read back.', 'add_id __ALERT_ID__ "$ALERT_ID"', `fill "$HERE/policy-changes.json" > "$WORK/policy-changes.json"`, '"$HERE/policy-apply.sh" "$WORK/policy-changes.json"']
          : ['echo "Named in no policy: it fires wherever a policy enables it."']),
        '',
      ].join('\n');

      const verify = [...usedKinds].map((k) => kindInfo(k)).filter((k) => k.verify).map((k) => `${k.label}: ${k.verify}.`);
      const contentXml = (only                                            ) => alertModelXml([spec], symptoms, only);

      const importFiles                         = {
        'import/alert-definitions.xml': contentXml(),
        ...contentPackage(
          {
            'alertdefs.xml': contentXml('alerts'),
            'symptomdefs.xml': contentXml('symptoms'),
            ...(spec.recommendations.length > 0 ? { 'recommendationdefs.xml': contentXml('recommendations') } : {}),
          },
          { alertDefinitions: 1, symptomDefinitions: symptoms.length, recommendationDefinitions: spec.recommendations.length },
        ),
        'import-content.sh': contentImportScript({ what: `the alert "${alertName}" with its symptoms${recommendation.trim() ? ' and recommendation' : ''}`, contentType: 'ALERT_DEFINITIONS', needles: [ids.alert, `name="${alertName.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`] }),
      };

      return {
        platform: PLATFORM,
        title: `${alertName} — ${pair ? metric.label : `${symptoms.length} symptom(s)`} on ${baseLabel.toLowerCase()}`,
        // Creating content is a change, even if the alert itself only reports.
        effect: 'reversible',
        trigger: {
          kind: 'alert',
          detail: summary + (sets.length > 1 ? `; ${sets.length} symptom sets, ${setsOperator === 'AND' ? 'all' : 'any'} must hold` : ''),
          worstCase: `once per ${baseLabel.toLowerCase()} while the condition holds — on a busy cluster, that is every object at once`,
        },
        scope: {
          what: `Every ${baseLabel.toLowerCase()} where the alert is enabled by policy${policies.length > 0 ? ` (${policies.join(', ')})` : ''}.`,
          decidedBy: [
            `Object type: ${base.adapterKind}:${base.resourceKind}.`,
            ...sets.filter((set) => set.relation !== 'SELF').map((set) => `Its ${set.relation.toLowerCase()} ${kindLabel(set.adapterKind, set.resourceKind).toLowerCase()} objects: ${set.population === 'COUNT' ? `at least ${set.n}` : set.population === 'PERCENT' ? `at least ${set.n}%` : set.population.toLowerCase()} of them.`),
            policies.length > 0 ? `The policies it is enabled in: ${policies.join(', ')}, and the custom groups those are assigned to.` : 'Which policies enable it — none is named here.',
            'Policy priority: a higher-priority policy covering the same object that disables it wins.',
            'The notification rules that match it, which decide whether anybody hears.',
          ],
          ifWrong: 'An alert raised across the whole estate for a threshold tuned for one cluster. Nothing breaks; people learn to ignore the alert, which is worse.',
        },
        guardrails: [
          { rule: `Sustained for ${wait} cycles before it is raised`, because: 'Every metric spikes. An alert on a spike is an alert people mute.' },
          ...(pair ? [{ rule: 'Warning and critical are separate symptoms', because: 'One alert that escalates is read; two alerts for the same thing are deduplicated by hand at 3am.' }] : []),
          ...(recommendation.trim() ? [{ rule: 'Carries a recommendation', because: 'The person receiving it knows the first thing to check without opening a runbook.' }] : []),
          { rule: 'apply.sh stops if an alert definition of the same name exists', because: 'The API accepts duplicates, and two alerts of one name are two alerts nobody can tell apart.' },
          ...(policies.length > 0 ? [{ rule: 'Each policy is exported before it is changed, and read back after', because: 'The export is the undo, and a setting the import dropped is reported rather than assumed.' }] : []),
          ...(recAction ? [{ rule: 'The action is attached, not automated', because: 'Running it still takes a person clicking it on the alert. "Act on an alert automatically" is the separate, deliberate step.' }] : []),
        ],
        dryRun: [
          'Run apply.sh --dry-run to see what would be created; policy-apply.sh --dry-run exports and merges without importing.',
          pair
            ? `Before enabling it anywhere, open a ${metric.kind} in the interface, chart ${metric.key} over the last 30 days, and count how often it crossed ${warnAt}. That is how often this will fire.`
            : 'Before enabling it, check each symptom on one object in the interface (Alerts → Symptom Definitions → the symptom → the objects it is active on).',
        ],
        undo: [
          'DELETE /suite-api/api/alertdefinitions/{id}, then the symptoms and the recommendation, using the ids in created-ids.txt.',
          'Delete the alert first: a symptom that an alert still refers to cannot be deleted.',
          ...(policies.length > 0 ? ['Re-import the policy-before-*.zip policy-apply.sh saved, to put each policy back as it was.'] : []),
        ],
        told: ['Nobody until a notification rule matches it. Pair it with "Send an alert to a webhook" in this kit, filtered to this alert id.'],
        requires: [
          'jq 1.6 or later on the machine running apply.sh, and python3 for policy-apply.sh.',
          ...(policies.length > 0 ? [`The policies ${policies.join(', ')}.`] : []),
          ...(recAction ? ['Actions enabled on the vCenter adapter instance.'] : []),
        ],
        files: {
          ...Object.fromEntries(symptoms.map((s, index) => [symptomFile(s, index), `${JSON.stringify(symptomJson(s), null, 2)}\n`])),
          ...(recPayload ? { [`${slug}-recommendation.json`]: `${JSON.stringify(recPayload, null, 2)}\n` } : {}),
          [`${slug}-alert.json`]: `${JSON.stringify(alertJson(spec), null, 2)}\n`,
          'apply.sh': apply,
          ...(policies.length > 0 ? { 'policy-changes.json': policyChangesJson(changes), 'policy-apply.sh': policyApplyScript() } : {}),
          ...(symptoms.length > 0 ? importFiles : {}),
          'IMPORT.md': importMd({
            title: `the alert "${alertName}"`,
            steps: [
              {
                heading: 'By the REST API — symptoms, recommendation, alert, and the policies',
                files: [...symptoms.map(symptomFile), ...(recPayload ? [`${slug}-recommendation.json`] : []), `${slug}-alert.json`, 'apply.sh', ...(policies.length > 0 ? ['policy-changes.json', 'policy-apply.sh'] : [])],
                how: [
                  `./apply.sh (add --dry-run first to preview) creates the symptoms, ${recPayload ? `the recommendation${recAction ? ` (with the ${recAction.label} action, found by name)` : ''}, ` : ''}then the alert, through /suite-api/api/symptomdefinitions, /recommendations and /alertdefinitions — the API assigns the ids, and each is written into the next payload.`,
                  ...(policies.length > 0 ? [`It then runs policy-apply.sh, which enables the alert in ${policies.join(', ')}: exports each policy (kept as the undo), merges <Alert enabled="true">, imports it (POST /suite-api/api/policies/import?forceImport=true) and exports it again to check the setting took.`] : []),
                ],
              },
              {
                heading: 'Or the alert, its symptoms and its recommendation — one file',
                files: ['import/alert-definitions.xml'],
                how: [
                  'Alerts → Configure → Alert Definitions → ⋯ → Import (8.x: Configure → Alerts → Alert Definitions → Import), and choose import/alert-definitions.xml. The symptoms and the recommendation it refers to are in the same file and are created with it.',
                  `Ids in the file are fixed (${ids.alert}), so importing it again with "Overwrite" replaces this alert and nothing else.`,
                  ...(recAction ? ['The action behind the recommendation is not in the XML: attach it under Alerts → Configure → Recommendations, or use apply.sh.'] : []),
                  ...(policies.length > 0 ? [`Then enable it: POLICY names in policy-changes.json, with __ALERT_ID__ replaced by ${ids.alert}, and ./policy-apply.sh policy-changes.json.`] : []),
                ],
                verify: [
                  ...(sets.length > 1 || sets.some((set) => set.relation !== 'SELF') ? ['the SymptomSet attributes for related objects (aggregation, value, adapterKind, resourceKind) against an export of a built-in alert with a child symptom set.'] : []),
                  ...verify,
                ],
              },
              contentStep('ALERT_DEFINITIONS'),
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          ...(pair ? [`Metric key ${metric.key} is the VMware adapter’s. If an object shows it under a different key in your version, open the object’s metric picker and copy the key from there.`] : []),
          'The type and subtype decide where the alert is filed; the impact decides which badge it affects. Neither changes when it fires.',
          `Impact: ${impact.toLowerCase()} badge. Criticality: ${criticality === 'AUTO' ? 'from the symptoms, so one alert escalates from warning to critical' : criticality.toLowerCase()}.`,
          ...(sets.length > 1 || sets.some((set) => set.relation !== 'SELF') ? ['VERIFY: the symptom set fields for related objects and populations (relation, aggregation ALL / ANY / COUNT / PERCENT, value) and the composite set (SYMPTOM_SET_COMPOSITE, operator, symptom-sets) against GET /suite-api/api/alertdefinitions/{id} of a built-in alert that uses them.'] : []),
          ...verify.map((line) => `VERIFY: ${line}`),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_alert_action',
    platform: PLATFORM,
    label: 'Act on an alert automatically',
    group: 'Alerts',
    description:
      'The step from "it tells somebody" to "it fixes it": a recommendation with an action behind it, attached to the alert, and the policy setting that lets VCF Operations run that action without asking — applied, in a policy assigned to a group built for the purpose, because automating an action in a policy applies it to every object that policy covers.',
    inputs: [
      { id: 'alert_id', label: 'Alert definition', control: 'text', default: 'AlertDefinition-VMWARE-VMSnapshotsOld', hint: 'Its id, or its exact name. The alert whose recommendation this action is attached to' },
      { id: 'action', label: 'Action', control: 'select', options: ACTIONS.map((a) => ({ value: a.value, label: a.label, group: a.group })), default: 'DeleteUnusedSnapshotsForVM' },
      { id: 'policy_name', label: 'Automate it in policy', control: 'text', default: 'Automation — non-production' },
      { id: 'parent_policy', label: 'If that policy does not exist, create it under', control: 'text', default: 'Default Policy' },
      { id: 'group_name', label: 'That policy covers the group', control: 'text', default: 'Automation — safe to act on' },
      { id: 'snapshot_age', label: 'Snapshots older than (days)', control: 'number', default: 14, min: 1, max: 365, showWhen: { input: 'action', equals: ['DeleteUnusedSnapshotsForVM', 'DeleteUnusedSnapshotsForDatastore'] } },
      { id: 'attach', label: 'Attach the recommendation to the alert definition', control: 'toggle', default: true },
      { id: 'change_ticket', label: 'Require a change ticket before the policy is changed', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const alertRef = str(values, 'alert_id', '');
      const action = actionOf(str(values, 'action', 'DeleteUnusedSnapshotsForVM')) ?? ACTIONS[0] ;
      const policy = str(values, 'policy_name', 'Automation');
      const parent = str(values, 'parent_policy', 'Default Policy');
      const group = str(values, 'group_name', '');
      const age = num(values, 'snapshot_age', 14);
      const attach = bool(values, 'attach', true);
      const ticket = bool(values, 'change_ticket', true);
      const base = slugOf(name || `${action.value}-automation`, 'alert-action');
      const irreversible = Boolean(action.irreversible);
      const disruptive = Boolean(action.disruptive);
      const target = action.target;
      const snapshots = action.value.startsWith('DeleteUnusedSnapshots');

      const findings            = [];
      if (/default/i.test(policy) || !group.trim()) {
        findings.push(
          error('vcfops.action.default-policy', 'Automating an action in the default policy, or with no group, applies it to every object the policy covers.', {
            remediation: 'Create a policy for automation, assign it only to a group built for the purpose, and automate the action there.',
            source: SRC,
          }),
        );
      }
      if (!alertRef) findings.push(error('vcfops.action.no-alert', 'No alert definition is named, so there is nothing to attach the action to.', { source: SRC }));
      if (irreversible && !ticket) {
        findings.push(
          warning('vcfops.action.no-change', 'An irreversible action is being automated with no change record.', {
            remediation: 'The policy change that turns automation on is the moment to record. After that it acts on its own.',
            source: SRC,
          }),
        );
      }
      if (action.value === 'PowerOffVM' || action.value === 'ShutDownGuestOSForVM') {
        findings.push(
          warning('vcfops.action.power-off', 'Powering off a VM on an alert takes a service down on a metric.', {
            remediation: 'Reserve it for groups where that is the intended outcome — expired test environments, quarantined machines — and nowhere else.',
            source: SRC,
          }),
        );
      }
      if (action.value === 'DeletePoweredOffVM') {
        findings.push(warning('vcfops.action.delete-vm', 'Deleting a VM on an alert cannot be undone, and a powered-off VM is sometimes somebody’s cold standby.', { remediation: 'Automate it only on a group of VMs whose owners have agreed, in writing, that powered off means disposable.', source: SRC }));
      }
      if (!attach) {
        findings.push(warning('vcfops.action.not-attached', 'The recommendation is created but not attached to the alert, so automating the alert runs nothing.', { remediation: 'Attach it here, or add it under Alerts → Alert Definitions → the alert → Recommendations.', source: SRC }));
      }

      const recommendation = {
        description: `Run ${action.label} on the object that raised the alert. Automated in "${policy}" only.`,
        action: { actionAdapterKindId: 'VMWARE', actionId: '__ACTION_ID__', targetAdapterKindId: 'VMWARE', targetResourceKindId: target },
      };
      const changes                = {
        policies: [policy],
        create: { parent, description: `Automated actions for "${group}" only.` },
        changes: [{ label: `alert ${alertRef} enabled and automated`, block: 'Alerts', item: 'Alert', adapterKind: 'VMWARE', resourceKind: target, id: '__ALERT_ID__', set: { enabled: 'true', automate: 'true' } }],
        ...(group.trim() ? { groups: [group] } : {}),
      };

      const apply = [
        '#!/usr/bin/env bash',
        `# Automate ${action.label} for ${alertRef || 'the alert'} in "${policy}":`,
        '# the recommendation with the action behind it, attached to the alert, then the',
        `# alert enabled with automate="true" in "${policy}", which is assigned to "${group}".`,
        '#',
        '# Applies when run. With --dry-run it resolves the alert and the action and stops.',
        'set -euo pipefail',
        ...authPreamble('vcf-operations'),
        'command -v jq >/dev/null || { echo "jq 1.6 or later is required" >&2; exit 2; }',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...workDirLines(),
        'DRY_RUN=0',
        '[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        ...(ticket ? [': "${CHANGE_TICKET:?set CHANGE_TICKET to the change record that approves automating this — it is written into created-ids.txt}"'] : []),
        '',
        `get() { curl -sS -f "https://\${VCFOPS_HOST}$1" -H "${authHeader('vcf-operations')}" -H "Accept: application/json"; }`,
        `send() { curl -sS -f -X "$1" "https://\${VCFOPS_HOST}$2" -H "${authHeader('vcf-operations')}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @"$3"; }`,
        ...PAGED_HELPERS,
        ...ACTION_ID_LINES,
        '',
        `ALERT_REF=${shq(alertRef)}`,
        'get_all /suite-api/api/alertdefinitions alertDefinitions "$WORK/defs.json" || exit 2',
        'ALERT_ID=$(jq -r --arg r "$ALERT_REF" \'[.[] | select(.id == $r or .name == $r)][0].id // empty\' "$WORK/defs.json")',
        '[[ -n "$ALERT_ID" ]] || { echo "No alert definition with id or name $ALERT_REF." >&2; exit 2; }',
        `ACTION_ID=$(action_id ${shq(action.label)}) || exit 2`,
        `[[ -n "$ACTION_ID" ]] || { echo "No action named ${action.label}: enable actions on the vCenter adapter instance." >&2; exit 2; }`,
        'echo "alert $ALERT_ID, action $ACTION_ID"',
        'if (( DRY_RUN )); then',
        `  echo "DRY RUN: would create the recommendation${attach ? ', attach it to the alert' : ''}, then set automate on the alert in \\"${policy.replace(/["$`\\]/g, '')}\\" and assign it to \\"${group.replace(/["$`\\]/g, '')}\\" (policy-apply.sh --dry-run shows the merge)."`,
        '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'fi',
        '',
        `: > created-ids.txt${ticket ? '; echo "change $CHANGE_TICKET" >> created-ids.txt' : ''}`,
        `jq --arg a "$ACTION_ID" '.action.actionId = $a' "$HERE/${base}-recommendation.json" > "$WORK/rec.json"`,
        'REC_ID=$(send POST /suite-api/api/recommendations "$WORK/rec.json" | jq -r \'.id // empty\')',
        '[[ -n "$REC_ID" ]] || { echo "POST /recommendations returned no id." >&2; exit 2; }',
        'echo "recommendation $REC_ID" | tee -a created-ids.txt',
        ...(attach
          ? [
              '',
              '# The alert as it is now is the undo for the attachment.',
              'get "/suite-api/api/alertdefinitions/$ALERT_ID" > "$HERE/alert-before-$(date +%Y%m%d-%H%M%S).json"',
              'get "/suite-api/api/alertdefinitions/$ALERT_ID" > "$WORK/alert.json"',
              '# Add the recommendation to every state, after the ones it already has.',
              'jq --arg r "$REC_ID" \'.states |= map(.recommendationPriorityMap = ((.recommendationPriorityMap // {}) + {($r): (((.recommendationPriorityMap // {}) | length) + 1)}))\' "$WORK/alert.json" > "$WORK/alert-new.json"',
              '# VERIFY: PUT /suite-api/api/alertdefinitions with the id in the body, on your release.',
              'send PUT /suite-api/api/alertdefinitions "$WORK/alert-new.json" >/dev/null || { echo "Could not attach the recommendation: Alerts > Alert Definitions > the alert > Edit > Recommendations > add it. Then run policy-apply.sh." >&2; exit 4; }',
              'echo "attached to $ALERT_ID" | tee -a created-ids.txt',
            ]
          : []),
        '',
        `jq --arg id "$ALERT_ID" 'walk(if . == "__ALERT_ID__" then $id else . end)' "$HERE/policy-changes.json" > "$WORK/policy-changes.json"`,
        '"$HERE/policy-apply.sh" "$WORK/policy-changes.json"',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${action.label} automatically when ${alertRef || 'the alert'} is raised`,
        effect: irreversible ? 'irreversible' : 'reversible',
        trigger: { kind: 'alert', detail: `${alertRef || 'the alert'} raised on a ${kindLabel('VMWARE', target).toLowerCase()} covered by "${policy}"`, worstCase: `once per object in "${group || 'every group on the policy'}" — all at once, if the alert fires across the group` },
        scope: {
          what: `${kindLabel('VMWARE', target)} objects in the group "${group || '(none set)'}" on which ${alertRef || 'the alert'} is raised.`,
          decidedBy: [
            `The policy "${policy}" — the automate flag is set there and nowhere else.`,
            `The group "${group || '(none)'}", which policy-apply.sh assigns the policy to.`,
            'Policy priority: if a higher-priority policy covers the same object without automation, it wins and nothing is automated.',
            `The alert’s own symptoms${snapshots ? `, and a snapshot age above ${age} days (the alert’s symptom threshold)` : ''}.`,
          ],
          ifWrong: irreversible
            ? 'Data is deleted on objects nobody meant to include — snapshots that were somebody’s rollback plan, or a VM that was somebody’s standby.'
            : disruptive
              ? 'VMs are powered off or resized on the strength of a metric, and the first anybody hears is the outage.'
              : 'Objects are moved, rebalanced or reconfigured unexpectedly. Recoverable, but noticed.',
        },
        guardrails: [
          { rule: 'Automated in a dedicated policy only', because: 'The automate flag applies to everything the policy covers. A dedicated policy on a dedicated group is the only way to bound that.' },
          { rule: `Only objects in "${group || '(none)'}"`, because: 'The group is built with an exclusion tag — see "A custom group to scope automation".' },
          ...(ticket ? [{ rule: 'apply.sh refuses to run without CHANGE_TICKET', because: 'The policy edit is the last moment a human is involved. Record it.' }] : []),
          { rule: 'The policy and the alert are exported before they are changed, and the policy is read back after', because: 'Those exports are the undo; a setting the import dropped is reported, not assumed.' },
          { rule: 'Run the action by hand from the alert first', because: 'Running it once from the recommendation shows exactly what it does, on one object, while someone is watching.' },
        ],
        dryRun: [
          'apply.sh --dry-run resolves the alert and the action and stops. policy-apply.sh policy-changes.json --dry-run exports and merges without importing.',
          'Before automating, let the alert fire for a week with the recommendation run by hand each time, and count the objects. If that surprises you, the group is wrong.',
        ],
        undo: irreversible
          ? ['What the action deleted cannot be restored. Turning automation off stops the next one; it does not bring back the last.', `Re-import the policy-before-*.zip policy-apply.sh saved, or set automate="false" on the alert in "${policy}".`]
          : [`Re-import the policy-before-*.zip policy-apply.sh saved, or set automate="false" on the alert in "${policy}".`, 'Objects already changed are put back by hand, using the Automated Actions history.', ...(attach ? ['PUT the alert-before-*.json back to detach the recommendation, then DELETE /suite-api/api/recommendations/{id}.'] : [])],
        told: ['Every automated run appears under Administration → History → Recent Tasks, with the object and the result.', 'Wire the alert to a webhook as well, so a person sees it acted rather than only that it fired.'],
        requires: ['Actions enabled on the vCenter adapter, with a credential that has exactly the rights this action needs.', `The group "${group}" (the policy "${policy}" is created under "${parent}" if it does not exist).`, 'jq 1.6 or later and python3.'],
        files: {
          [`${base}-recommendation.json`]: `${JSON.stringify(recommendation, null, 2)}\n`,
          'policy-changes.json': policyChangesJson(changes),
          'apply.sh': apply,
          'policy-apply.sh': policyApplyScript(),
          'IMPORT.md': importMd({
            title: `automating ${action.label} for ${alertRef || 'the alert'}`,
            steps: [
              {
                heading: 'Everything, by the REST API',
                files: [`${base}-recommendation.json`, 'policy-changes.json', 'apply.sh', 'policy-apply.sh'],
                how: [
                  `${ticket ? 'CHANGE_TICKET=<change> ' : ''}./apply.sh (add --dry-run first). It finds the alert by id or name and the action by name, creates the recommendation (POST /suite-api/api/recommendations)${attach ? ', attaches it to the alert (PUT /suite-api/api/alertdefinitions, the alert exported first)' : ''}, then runs policy-apply.sh.`,
                  `policy-apply.sh creates "${policy}" under "${parent}" if it does not exist, exports it (the undo), sets enabled and automate on the alert, imports it (POST /suite-api/api/policies/import?forceImport=true), reads it back, and assigns it to "${group}".`,
                ],
                verify: ['the automate attribute name, against an export of your own policy: the merge writes the attribute names as written here, and the read-back reports it if the import dropped it.'],
              },
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          'The automate attribute is set on the alert inside the policy, not on the alert definition. The same alert can be automated in one policy and only reported in another — that is the mechanism for scoping it.',
          ...(snapshots ? [`The ${age}-day age is the alert’s symptom threshold. If the built-in symptom uses another value, override it in "${policy}" under Alerts and Symptoms → Symptom Definitions.`] : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_symptom_definition',
    platform: PLATFORM,
    label: 'A symptom definition, on its own',
    group: 'Alerts',
    description:
      'One symptom, of any kind — a static or dynamic metric threshold, a text or number property test, a message event, a fault, a metric event or a log query — created so alert definitions (built here or in the interface) can use it. For a whole alert, use "An alert, with its symptoms and a recommendation".',
    inputs: [
      { id: 'symptom_name', label: 'Name', control: 'text', default: 'VM CPU ready above 10%' },
      { id: 'kind', label: 'Kind', control: 'select', options: SYMPTOM_KINDS.map((k) => ({ value: k.value, label: k.label })), default: 'metric' },
      { id: 'object_type', label: 'On object type', control: 'select', options: [...OBJECT_TYPES, { value: 'custom', label: 'Another adapter and object type', group: 'Other' }], default: 'VMWARE:VirtualMachine' },
      { id: 'adapter_kind', label: 'Adapter kind', control: 'combo', options: ['VMWARE', 'VirtualAndPhysicalSANAdapter', 'NSXTAdapter', 'KubernetesAdapter', 'VCFAdapter'].map((v) => ({ value: v, label: v })), default: 'VMWARE', showWhen: { input: 'object_type', equals: ['custom'] } },
      { id: 'resource_kind', label: 'Object type (resource kind)', control: 'text', default: 'VirtualMachine', showWhen: { input: 'object_type', equals: ['custom'] } },
      { id: 'key', label: 'Key', control: 'text', default: 'cpu|readyPct', hint: 'Metric or property key; the event type for a message event; the fault key; the saved query name for a log symptom' },
      { id: 'op_numeric', label: 'Is', control: 'select', options: kindInfo('metric').operators.map((o) => ({ ...o })), default: 'GT', showWhen: { input: 'kind', equals: ['metric', 'property-numeric', 'metric-event'] } },
      { id: 'op_text', label: 'Is', control: 'select', options: kindInfo('property').operators.map((o) => ({ ...o })), default: 'EQ', showWhen: { input: 'kind', equals: ['property', 'message'] } },
      { id: 'op_dynamic', label: 'Is', control: 'select', options: kindInfo('dynamic').operators.map((o) => ({ ...o })), default: 'DT_ABOVE', showWhen: { input: 'kind', equals: ['dynamic'] } },
      { id: 'op_log', label: 'Query', control: 'select', options: kindInfo('log').operators.map((o) => ({ ...o })), default: 'GT', showWhen: { input: 'kind', equals: ['log'] } },
      { id: 'value', label: 'Value', control: 'text', default: '10', showWhen: { input: 'kind', notEquals: ['dynamic', 'fault'] } },
      { id: 'criticality', label: 'Criticality', control: 'select', options: CRITICALITIES.filter((c) => c.value !== 'AUTO'), default: 'WARNING' },
      { id: 'wait_cycles', label: 'Wait (cycles)', control: 'number', default: 3, min: 1, max: 60 },
      { id: 'cancel_cycles', label: 'Cancel (cycles)', control: 'number', default: 3, min: 1, max: 60 },
    ],
    automation: (values                 , name        )             => {
      const symptomName = str(values, 'symptom_name', 'Symptom');
      const info = kindInfo(str(values, 'kind', 'metric'));
      const choice = str(values, 'object_type', 'VMWARE:VirtualMachine');
      const on = choice === 'custom' ? { adapterKind: str(values, 'adapter_kind', 'VMWARE'), resourceKind: str(values, 'resource_kind', 'VirtualMachine') } : splitKind(choice);
      const key = str(values, 'key', '');
      const opInput = info.value === 'dynamic' ? 'op_dynamic' : info.value === 'log' ? 'op_log' : info.value === 'property' || info.value === 'message' ? 'op_text' : 'op_numeric';
      const operator = info.value === 'fault' ? 'EQ' : str(values, opInput, info.operators[0] .value);
      const value = info.value === 'dynamic' || info.value === 'fault' ? '' : str(values, 'value', '');
      const severity = severityOf(str(values, 'criticality', 'WARNING'));
      const wait = num(values, 'wait_cycles', 3);
      const cancel = num(values, 'cancel_cycles', 3);
      const base = slugOf(name || symptomName, 'symptom');

      const spec              = {
        id: `SymptomDefinition-${stableId(`symptom:${symptomName}`)}`,
        placeholder: '__SYMPTOM__',
        kind: info.value,
        name: symptomName,
        adapterKind: on.adapterKind,
        resourceKind: on.resourceKind,
        severity,
        key,
        operator,
        value,
        wait,
        cancel,
      };

      const findings            = [];
      if (!key) findings.push(error('vcfops.symptom.no-key', `There is no ${info.keyIs}.`, { source: SRC }));
      if (info.valueIs && !value) findings.push(error('vcfops.symptom.no-value', `A ${info.label.toLowerCase()} symptom needs a ${info.valueIs}.`, { source: SRC }));
      if (info.valueIs && value && info.value !== 'property' && info.value !== 'message' && !Number.isFinite(Number(value))) {
        findings.push(error('vcfops.symptom.not-a-number', `"${value}" is not a number, and ${info.label.toLowerCase()} compares numbers.`, { source: SRC }));
      }
      if ((operator === 'REGEX' || operator === 'NOT_REGEX') && value) {
        try {
          new RegExp(value);
        } catch {
          findings.push(error('vcfops.symptom.bad-regex', `"${value}" is not a valid regular expression.`, { source: SRC }));
        }
      }
      if (/pct|percent/i.test(key) && (info.value === 'metric' || info.value === 'property-numeric') && Number(value) > 100) {
        findings.push(error('vcfops.symptom.over-100', `${key} is a percentage, and ${value} can never be reached.`, { source: SRC }));
      }
      if (wait === 1 && (info.value === 'metric' || info.value === 'dynamic')) {
        findings.push(warning('vcfops.symptom.one-cycle', 'One collection cycle makes this symptom true on a single five-minute spike.', { remediation: 'Three cycles filters almost every transient.', source: SRC }));
      }
      if (info.value === 'log') {
        findings.push(warning('vcfops.symptom.log', 'A log symptom is created from a saved query in Log Explorer; its REST shape here is not documented.', { remediation: 'Use "Log alert from a saved query" (vcflog91_alert_query), which is the documented route. VERIFY this file on a test instance first.', source: SRC }));
      }

      const payload = symptomJson(spec);
      const apply = [
        '#!/usr/bin/env bash',
        `# Create the symptom "${symptomName}" in VCF Operations. Stops if one of that name exists.`,
        '#',
        '# Applies when run. With --dry-run it only prints what it would send.',
        'set -euo pipefail',
        ...authPreamble('vcf-operations'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...workDirLines(),
        `get() { curl -sS -f "https://\${VCFOPS_HOST}$1" -H "${authHeader('vcf-operations')}" -H "Accept: application/json"; }`,
        ...PAGED_HELPERS,
        'get_all /suite-api/api/symptomdefinitions symptomDefinitions "$WORK/symptoms.json" || exit 2',
        `EXISTING=$(jq -r --arg n ${shq(symptomName)} '[.[] | select(.name == $n)][0].id // empty' "$WORK/symptoms.json")`,
        '[[ -z "$EXISTING" ]] || { echo "A symptom of this name exists: $EXISTING. Nothing was created." >&2; exit 1; }',
        'if [[ "${1:-}" == "--dry-run" ]]; then',
        `  echo "DRY RUN: would POST ${base}.json to /suite-api/api/symptomdefinitions:"`,
        `  jq . "$HERE/${base}.json"`,
        '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'fi',
        `ID=$(curl -sS -f -X POST "https://\${VCFOPS_HOST}/suite-api/api/symptomdefinitions" -H "${authHeader('vcf-operations')}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @"$HERE/${base}.json" | jq -r '.id // empty')`,
        '[[ -n "$ID" ]] || { echo "The API returned no id." >&2; exit 2; }',
        'echo "symptom $ID" | tee created-ids.txt',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Symptom "${symptomName}" — ${info.label.toLowerCase()} on ${kindLabel(on.adapterKind, on.resourceKind).toLowerCase()}`,
        effect: 'reversible',
        trigger: { kind: 'alert', detail: `${key} ${info.operators.find((o) => o.value === operator)?.label ?? operator}${value ? ` ${value}` : ''}, for ${wait} cycles`, worstCase: 'never on its own — a symptom raises nothing until an alert definition uses it' },
        scope: {
          what: `Every ${kindLabel(on.adapterKind, on.resourceKind).toLowerCase()} the symptom is evaluated on.`,
          decidedBy: [`Object type ${on.adapterKind}:${on.resourceKind}.`, 'The alert definitions that use it, and the policies that enable those.'],
          ifWrong: 'Nothing happens until an alert uses it; then the alert inherits whatever this symptom gets wrong.',
        },
        guardrails: [
          { rule: 'apply.sh stops if a symptom of the same name exists', because: 'The API accepts duplicates, and an alert built on the wrong one of two identical names is hard to find.' },
          { rule: `Sustained for ${wait} cycles`, because: 'A symptom true for one cycle makes every alert built on it fire on a spike.' },
        ],
        dryRun: ['apply.sh --dry-run prints the payload and sends nothing.', 'After creating it, Alerts → Configure → Symptom Definitions → the symptom shows the objects it is true on now, before any alert uses it.'],
        undo: ['DELETE /suite-api/api/symptomdefinitions/{id} with the id in created-ids.txt — after removing it from any alert that uses it.'],
        told: ['Nobody: a symptom only shows on the object. Build an alert on it for anyone to hear.'],
        requires: ['jq on the machine that runs apply.sh.'],
        files: {
          [`${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'apply.sh': apply,
          'import/symptom-definitions.xml': alertModelXml([], [spec]),
          'IMPORT.md': importMd({
            title: `the symptom "${symptomName}"`,
            steps: [
              { heading: 'By the REST API', files: [`${base}.json`, 'apply.sh'], how: ['./apply.sh (add --dry-run first) — POST /suite-api/api/symptomdefinitions. The API assigns the id; it is written to created-ids.txt.'] },
              {
                heading: 'Or import it',
                files: ['import/symptom-definitions.xml'],
                how: ['Alerts → Configure → Symptom Definitions → ⋯ → Import, and choose import/symptom-definitions.xml (the alert-content format, with only a symptom in it).'],
                verify: [...(info.verify ? [`${info.label}: ${info.verify}.`] : []), 'that the Symptom Definitions page imports a file holding only symptoms; if not, use apply.sh.'],
              },
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [...(info.verify ? [`VERIFY: ${info.verify}.`] : []), 'To use it in an alert built here, put it in the alert’s symptom rows with the same kind, key, operator and value — or reference the id apply.sh prints when building the alert in the interface.'],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_alert_group',
    platform: PLATFORM,
    label: 'An alert group — definitions managed and routed together',
    group: 'Alerts',
    description:
      'A named set of alert definitions that belong together — everything about one service, one hardware vendor, one compliance area — enabled or disabled together in the policies you name, and routed by one notification rule to one outbound instance. apply.sh resolves each definition by id or name, applies the policy change and creates the rule.',
    inputs: [
      { id: 'group_name', label: 'Group name', control: 'text', default: 'Storage — capacity and latency' },
      {
        id: 'alerts',
        label: 'Alert definitions',
        control: 'textarea',
        default: 'AlertDefinition-VMWARE-DatastoreUsage\nAlertDefinition-VMWARE-DatastoreLatency',
        hint: 'One per line: an alert definition id or its exact name',
      },
      {
        id: 'direction',
        label: 'In the policies',
        control: 'select',
        options: [
          { value: 'enable', label: 'Enable every alert in the group' },
          { value: 'disable', label: 'Disable every alert in the group' },
          { value: 'leave', label: 'Leave them as they are — only route them' },
        ],
        default: 'enable',
      },
      { id: 'policies', label: 'Policies', control: 'text', default: 'Default Policy', hint: 'Comma separated policy names', showWhen: { input: 'direction', notEquals: ['leave'] } },
      { id: 'route', label: 'Route the group with one notification rule', control: 'toggle', default: true },
      { id: 'plugin_instance', label: 'To the outbound instance named', control: 'text', default: 'Storage team — email', showWhen: { input: 'route', equals: ['true'] } },
      {
        id: 'criticality',
        label: 'At',
        control: 'select',
        options: [
          { value: 'CRITICAL', label: 'Critical only' },
          { value: 'CRITICAL,IMMEDIATE', label: 'Critical and immediate' },
          { value: 'CRITICAL,IMMEDIATE,WARNING', label: 'Critical, immediate and warning' },
          { value: 'CRITICAL,IMMEDIATE,WARNING,INFO', label: 'Every criticality' },
        ],
        default: 'CRITICAL,IMMEDIATE',
        showWhen: { input: 'route', equals: ['true'] },
      },
    ],
    automation: (values                 , name        )             => {
      const groupName = str(values, 'group_name', 'Alert group');
      const refs = rows(str(values, 'alerts', ''));
      const direction = str(values, 'direction', 'enable');
      const policies = direction === 'leave' ? [] : listOf(str(values, 'policies', ''));
      const route = bool(values, 'route', true);
      const plugin = str(values, 'plugin_instance', '');
      const criticalities = listOf(str(values, 'criticality', 'CRITICAL,IMMEDIATE'));
      const base = slugOf(name || groupName, 'alert-group');

      const findings            = [];
      if (refs.length === 0) findings.push(error('vcfops.alertgroup.empty', 'The group has no alert definitions.', { source: SRC }));
      if (direction !== 'leave' && policies.length === 0) findings.push(error('vcfops.alertgroup.no-policy', `The group is to be ${direction}d, and no policy is named.`, { source: SRC }));
      if (direction === 'disable' && refs.length > 20) {
        findings.push(warning('vcfops.alertgroup.mass-disable', `Turning off ${refs.length} alert definitions at once leaves a large hole in the monitoring.`, { remediation: 'Disable what is noisy, and fix what is noisy for a reason.', source: SRC }));
      }
      if (route && !plugin) findings.push(error('vcfops.alertgroup.no-plugin', 'The group is to be routed, and no outbound instance is named.', { source: SRC }));
      if (route && direction === 'disable') findings.push(warning('vcfops.alertgroup.route-disabled', 'A rule routing alerts that the same change disables sends nothing where they are disabled.', { source: SRC }));

      const apply = [
        '#!/usr/bin/env bash',
        `# Apply the alert group "${groupName}": resolve each definition, ${direction === 'leave' ? 'leave the policies alone' : `${direction} them in ${policies.join(', ')}`}${route ? `, and route them to "${plugin}"` : ''}.`,
        '#',
        '# Applies when run. With --dry-run it resolves everything and stops before changing anything.',
        'set -euo pipefail',
        ...authPreamble('vcf-operations'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...workDirLines(),
        'DRY_RUN=0',
        '[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        `get() { curl -sS -f "https://\${VCFOPS_HOST}$1" -H "${authHeader('vcf-operations')}" -H "Accept: application/json"; }`,
        ...PAGED_HELPERS,
        '',
        '# Every definition, by id or exact name, with its object type. One that is not found stops the run.',
        'get_all /suite-api/api/alertdefinitions alertDefinitions "$WORK/defs.json" || exit 2',
        `jq -R . "$HERE/${base}-alerts.txt" | jq -s . > "$WORK/refs.json"`,
        "jq --slurpfile r \"$WORK/refs.json\" '[$r[0][] as $x | (map(select(.id == $x or .name == $x))[0] // {missing: $x})]' \"$WORK/defs.json\" > \"$WORK/group.json\"",
        'MISSING=$(jq -r \'[.[] | select(.missing) | .missing] | join(", ")\' "$WORK/group.json")',
        '[[ -z "$MISSING" ]] || { echo "Not found: $MISSING" >&2; exit 2; }',
        'jq -r \'.[] | "  \\(.id)  \\(.name)  (\\(.adapterKindKey)/\\(.resourceKindKey))"\' "$WORK/group.json"',
        ...(direction !== 'leave'
          ? [
              '',
              `jq --argjson p ${shq(JSON.stringify(policies))} '{policies: $p, changes: [.[] | {label: ("alert " + .name + " ${direction}d"), block: "Alerts", item: "Alert", adapterKind: .adapterKindKey, resourceKind: .resourceKindKey, id: .id, set: {enabled: "${direction === 'enable'}"}}]}' "$WORK/group.json" > "$WORK/policy-changes.json"`,
              'if (( DRY_RUN )); then "$HERE/policy-apply.sh" "$WORK/policy-changes.json" --dry-run; else "$HERE/policy-apply.sh" "$WORK/policy-changes.json"; fi',
            ]
          : []),
        ...(route
          ? [
              '',
              '# The outbound instance by name. VERIFY: GET /suite-api/api/alertplugins and its list key.',
              'get /suite-api/api/alertplugins > "$WORK/plugins.json" || { echo "Cannot list outbound instances." >&2; exit 2; }',
              `PLUGIN_ID=$(jq -r --arg n ${shq(plugin)} '[(.notificationPluginInstances // .pluginInstances // [])[] | select(.name == $n)][0].pluginId // empty' "$WORK/plugins.json")`,
              `[[ -n "$PLUGIN_ID" ]] || { echo "No outbound instance named ${plugin.replace(/["$`\\]/g, '')}." >&2; exit 2; }`,
              `jq --arg p "$PLUGIN_ID" --arg n ${shq(`${groupName} — alert group`)} --argjson c ${shq(JSON.stringify(criticalities))} '{name: $n, pluginId: $p, alertControlStates: ["OPEN"], alertStatuses: ["NEW", "UPDATED", "CANCELED"], criticalities: $c, alertDefinitionIdFilters: {values: [.[].id]}}' "$WORK/group.json" > "$WORK/rule.json"`,
              'if (( DRY_RUN )); then echo "DRY RUN: would create the notification rule:"; jq . "$WORK/rule.json"; echo "Dry run: nothing was changed."; exit 0; fi',
              `curl -sS -f -X POST "https://\${VCFOPS_HOST}/suite-api/api/notifications/rules" -H "${authHeader('vcf-operations')}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @"$WORK/rule.json" | jq -r '"notification rule \\(.id // "?")"' | tee created-ids.txt`,
            ]
          : ['if (( DRY_RUN )); then echo "Dry run: nothing was changed."; fi']),
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Alert group "${groupName}" — ${refs.length} definition${refs.length === 1 ? '' : 's'}${direction !== 'leave' ? `, ${direction}d in ${policies.join(', ')}` : ''}${route ? `, routed to ${plugin}` : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once, as a change; re-run it when the group’s list changes.' },
        scope: {
          what: `The ${refs.length} alert definitions listed, on whatever objects the policies cover.`,
          decidedBy: [`The list in ${base}-alerts.txt.`, ...(policies.length > 0 ? [`The policies ${policies.join(', ')} and the groups they are assigned to.`] : []), ...(route ? [`The notification rule, at ${criticalities.join(' / ').toLowerCase()}.`] : [])],
          ifWrong: direction === 'disable' ? 'Alerts stop firing and nothing reports that they stopped.' : 'More alerts fire, and are routed, than the receiving team expected.',
        },
        guardrails: [
          { rule: 'Every name must resolve to exactly one definition before anything changes', because: 'A typo would otherwise enable or route a different alert, or none, silently.' },
          ...(policies.length > 0 ? [{ rule: 'Each policy is exported first and read back after', because: 'The export is the undo; a setting the import dropped is reported.' }] : []),
        ],
        dryRun: ['apply.sh --dry-run resolves every definition, runs the policy merge without importing, and prints the notification rule.'],
        undo: [...(policies.length > 0 ? ['Re-import the policy-before-*.zip files policy-apply.sh saved.'] : []), ...(route ? ['DELETE /suite-api/api/notifications/rules/{id} with the id in created-ids.txt.'] : [])],
        told: route ? [`The outbound instance "${plugin}", for every alert in the group at ${criticalities.join(' / ').toLowerCase()}.`] : ['Nobody — no rule is created.'],
        requires: ['jq and python3.', ...(route ? [`The outbound instance "${plugin}" (see "An outbound plugin instance").`] : [])],
        files: {
          [`${base}-alerts.txt`]: `${refs.join('\n')}\n`,
          'apply.sh': apply,
          ...(policies.length > 0 ? { 'policy-apply.sh': policyApplyScript() } : {}),
          'IMPORT.md': importMd({
            title: `the alert group "${groupName}"`,
            steps: [
              {
                heading: 'By the REST API',
                files: [`${base}-alerts.txt`, 'apply.sh', ...(policies.length > 0 ? ['policy-apply.sh'] : [])],
                how: [
                  './apply.sh (add --dry-run first) reads the list, resolves each line to an alert definition (GET /suite-api/api/alertdefinitions), and stops if any is not found.',
                  ...(policies.length > 0 ? [`It then ${direction}s them in ${policies.join(', ')} through policy-apply.sh (export, merge, import, read back).`] : []),
                  ...(route ? ['And creates one notification rule for all of them (POST /suite-api/api/notifications/rules, alertDefinitionIdFilters).'] : []),
                ],
              },
            ],
          }),
        },
        notes: [
          'VERIFY: the 9.1 suite API reference has no alert-group object; the group is the list file kept with this output. Change the list and re-run to change the group.',
          'Keep one list per team or service: the same definition can be in more than one group, and each group’s rule routes it independently.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_super_metric',
    platform: PLATFORM,
    label: 'A super metric',
    group: 'Metrics',
    description:
      'A metric that does not exist until you compute it: the worst CPU ready of any VM in a cluster, the number of powered-off VMs per host, free space across a datastore cluster. From a preset, from the formula builder (function, object type, metric, depth, where, fresh data only) or your own formula; assigned to the object types you pick and enabled in the policies you name, applied. Written with the depth kept small, because a super metric is evaluated every cycle for every object it is enabled on.',
    inputs: [
      { id: 'metric_name', label: 'Name', control: 'text', default: 'Cluster — worst VM CPU ready %' },
      { id: 'description', label: 'Description', control: 'textarea', default: '', hint: 'Empty uses the preset’s own description' },
      {
        id: 'preset',
        label: 'Computes',
        control: 'select',
        options: [
          { value: 'max-vm-ready', label: 'Worst VM CPU ready % in a cluster' },
          { value: 'avg-vm-ready', label: 'Average VM CPU ready % in a cluster' },
          { value: 'poweredoff-per-host', label: 'Powered-off VMs per host' },
          { value: 'ds-free-sum', label: 'Free space across datastores in a cluster (GB)' },
          { value: 'vcpu-ratio', label: 'vCPU to physical core ratio of a cluster' },
          { value: 'builder', label: 'Build one: function, object type, metric' },
          { value: 'custom', label: 'My own formula' },
        ],
        default: 'max-vm-ready',
      },
      {
        id: 'fn',
        label: 'Function',
        control: 'select',
        options: [
          { value: 'avg', label: 'avg — the average' },
          { value: 'sum', label: 'sum — the total' },
          { value: 'min', label: 'min — the lowest' },
          { value: 'max', label: 'max — the highest' },
          { value: 'count', label: 'count — how many' },
          { value: 'combine', label: 'combine — every value as one series' },
        ],
        default: 'max',
        showWhen: { input: 'preset', equals: ['builder'] },
      },
      { id: 'src_kind', label: 'Of object type', control: 'select', options: OBJECT_TYPES, default: 'VMWARE:VirtualMachine', showWhen: { input: 'preset', equals: ['builder'] } },
      { id: 'src_metric', label: 'Metric', control: 'combo', options: METRIC_OPTIONS.map((o) => ({ value: o.value.split('::')[1] ?? o.value, label: `${o.label} (${o.value.split('::')[1] ?? ''})`, group: o.group })), default: 'cpu|readyPct', showWhen: { input: 'preset', equals: ['builder'] } },
      { id: 'depth', label: 'Depth', control: 'number', default: 2, min: -5, max: 5, hint: 'Levels of relationship from the object it is assigned to: 1 children, 2 grandchildren, -1 parents', showWhen: { input: 'preset', equals: ['builder'] } },
      { id: 'where', label: 'Only where', control: 'text', default: '', placeholder: '$value > 0', hint: 'A condition on the value, e.g. $value == 0. Empty takes every object', showWhen: { input: 'preset', equals: ['builder'] } },
      { id: 'fresh', label: 'Only fresh data (isFresh)', control: 'toggle', default: false, hint: 'Leaves out objects that did not report this cycle', showWhen: { input: 'preset', equals: ['builder'] } },
      { id: 'formula', label: 'Formula', control: 'textarea', default: '', hint: 'Only used for "My own formula"', showWhen: { input: 'preset', equals: ['custom'] } },
      { id: 'object_types', label: 'Assign to object types', control: 'checklist', options: OBJECT_TYPES.map((o) => ({ value: o.value, label: o.label })), default: '', hint: 'Empty assigns it to the type the preset is written for' },
      {
        id: 'unit',
        label: 'Unit',
        control: 'select',
        options: [
          { value: 'percent', label: '%' },
          { value: 'none', label: 'No unit (a count or a ratio)' },
          { value: 'ms', label: 'ms' },
          { value: 'sec', label: 'seconds' },
          { value: 'day', label: 'days' },
          { value: 'KB', label: 'KB' },
          { value: 'MB', label: 'MB' },
          { value: 'GB', label: 'GB' },
          { value: 'TB', label: 'TB' },
          { value: 'KBps', label: 'KB/s' },
          { value: 'Mbps', label: 'Mbit/s' },
          { value: 'MHz', label: 'MHz' },
          { value: 'GHz', label: 'GHz' },
          { value: 'iops', label: 'IOPS' },
        ],
        default: 'percent',
      },
      { id: 'policies', label: 'Enable in policies', control: 'text', default: 'Default Policy', hint: 'Comma separated policy names. "Default Policy" means whichever policy is the default' },
    ],
    automation: (values                 , name        )             => {
      const metricName = str(values, 'metric_name', 'Super metric');
      const preset = str(values, 'preset', 'max-vm-ready');
      const custom = str(values, 'formula', '');
      const unit = str(values, 'unit', 'percent');
      const policies = listOf(str(values, 'policies', ''));
      const base = slugOf(name || metricName, 'super-metric');

      const PRESETS                                                                 = {
        'max-vm-ready': { formula: 'max(${adaptertype=VMWARE, objecttype=VirtualMachine, metric=cpu|readyPct, depth=2})', on: 'VMWARE:ClusterComputeResource', about: 'The worst VM, not the average one — the average hides the VM that is actually suffering.' },
        'avg-vm-ready': { formula: 'avg(${adaptertype=VMWARE, objecttype=VirtualMachine, metric=cpu|readyPct, depth=2})', on: 'VMWARE:ClusterComputeResource', about: 'Useful as a trend line. Alert on the max, chart the average.' },
        'poweredoff-per-host': { formula: 'count(${adaptertype=VMWARE, objecttype=VirtualMachine, metric=sys|poweredOn, depth=1, where=($value==0)})', on: 'VMWARE:HostSystem', about: 'A cheap reclamation indicator, per host.' },
        'ds-free-sum': { formula: 'sum(${adaptertype=VMWARE, objecttype=Datastore, metric=capacity|available_space, depth=1})', on: 'VMWARE:ClusterComputeResource', about: 'Free space the cluster can actually reach, across its datastores.' },
        'vcpu-ratio': { formula: '${this, metric=summary|number_running_vcpus} / ${this, metric=cpu|corecount_provisioned}', on: 'VMWARE:ClusterComputeResource', about: 'The consolidation ratio. Watch the trend, not the number.' },
      };
      let chosen                                                ;
      if (preset === 'custom') chosen = { formula: custom, on: '', about: 'Your own formula.' };
      else if (preset === 'builder') {
        const fn = str(values, 'fn', 'max');
        const src = splitKind(str(values, 'src_kind', 'VMWARE:VirtualMachine'));
        const metricKey = str(values, 'src_metric', 'cpu|readyPct');
        const depth = num(values, 'depth', 2);
        const where = str(values, 'where', '');
        const fresh = bool(values, 'fresh', false);
        const parts = [`adaptertype=${src.adapterKind}`, `objecttype=${src.resourceKind}`, `metric=${metricKey}`, `depth=${depth}`, ...(where ? [`where=(${where})`] : []), ...(fresh ? ['isFresh=true'] : [])];
        chosen = { formula: `${fn}(\${${parts.join(', ')}})`, on: '', about: `${fn} of ${metricKey} across the ${kindLabel(src.adapterKind, src.resourceKind).toLowerCase()} objects ${depth >= 0 ? `${depth} level${depth === 1 ? '' : 's'} below` : `${-depth} level${depth === -1 ? '' : 's'} above`}${where ? `, where ${where}` : ''}.` };
      } else chosen = PRESETS[preset] ?? PRESETS['max-vm-ready'] ;
      const picked = str(values, 'object_types', '').split(',').map((v) => v.trim()).filter(Boolean);
      const assigned = (picked.length > 0 ? picked : chosen.on ? [chosen.on] : []).map((v) => splitKind(v));
      const description = str(values, 'description', '') || chosen.about;

      const findings            = [];
      if (!chosen.formula.trim()) findings.push(error('vcfops.supermetric.empty', 'There is no formula.', { source: SRC }));
      if (assigned.length === 0) findings.push(error('vcfops.supermetric.no-type', 'The super metric is assigned to no object type, so it computes nothing.', { remediation: 'Tick the object types it is for under "Assign to object types".', source: SRC }));
      const depths = [...chosen.formula.matchAll(/depth\s*=\s*(-?\d+)/g)].map((m) => Number(m[1]));
      if (depths.some((depth) => depth > 3 || depth < -3)) {
        findings.push(
          warning('vcfops.supermetric.deep', 'This formula walks more than three levels of relationships.', {
            remediation: 'It is evaluated every collection cycle for every object it is enabled on. Enable it on the level you need rather than reaching down from the top.',
            source: SRC,
          }),
        );
      }
      if (depths.some((depth) => depth === 0)) findings.push(error('vcfops.supermetric.depth-zero', 'depth=0 reaches no related object; use ${this, metric=…} for the object itself.', { source: SRC }));
      if (/\$\{adaptertype=[^}]*\}/.test(chosen.formula) && !/depth\s*=/.test(chosen.formula)) {
        findings.push(warning('vcfops.supermetric.no-depth', 'A resource entry with no depth defaults to one level, which may not be what you meant.', { source: SRC }));
      }
      if (policies.length === 0) {
        findings.push(warning('vcfops.supermetric.no-policy', 'No policy is named, so the super metric is created and computes nothing until one enables it.', { remediation: 'Name the policies that cover the objects it is for.', source: SRC }));
      }
      if (unit === 'percent' && /^(sum|count)\(/.test(chosen.formula)) {
        findings.push(warning('vcfops.supermetric.unit', 'A sum or a count is rarely a percentage.', { remediation: 'Pick the unit of what the formula returns: "No unit" for a count.', source: SRC }));
      }

      const payload = {
        name: metricName,
        formula: chosen.formula,
        description,
        unitId: unit,
        // VERIFY: that POST /supermetrics takes the object types here; the export format does.
        resourceKinds: assigned.map((kind) => ({ adapterKindKey: kind.adapterKind, resourceKindKey: kind.resourceKind })),
      };
      const smId = stableId(`supermetric:${metricName}`);
      const exportJson = superMetricsJson([{ id: smId, name: metricName, formula: chosen.formula, description, unitId: unit, resourceKinds: assigned.map((kind) => ({ adapterKindKey: kind.adapterKind, resourceKindKey: kind.resourceKind })) }]);
      const onText = assigned.map((kind) => kindLabel(kind.adapterKind, kind.resourceKind)).join(', ') || '(no object type)';
      const changes                = {
        policies,
        changes: assigned.map((kind)               => ({ label: `super metric "${metricName}" enabled on ${kind.resourceKind}`, block: 'SuperMetrics', item: 'SuperMetric', adapterKind: kind.adapterKind, resourceKind: kind.resourceKind, id: '__SM_ID__', set: { enabled: 'true' } })),
      };

      const apply = [
        '#!/usr/bin/env bash',
        `# Create the super metric "${metricName}", assigned to ${onText}, and enable it`,
        `# in ${policies.join(', ') || 'no policy'}. If one of that name exists it is used as it is.`,
        '#',
        '# Applies when run. With --dry-run it only prints what it would do.',
        'set -euo pipefail',
        ...authPreamble('vcf-operations'),
        'command -v jq >/dev/null || { echo "jq 1.6 or later is required" >&2; exit 2; }',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...workDirLines(),
        'DRY_RUN=0',
        '[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        `get() { curl -sS -f "https://\${VCFOPS_HOST}$1" -H "${authHeader('vcf-operations')}" -H "Accept: application/json"; }`,
        ...PAGED_HELPERS,
        'get_all /suite-api/api/supermetrics superMetrics "$WORK/sms.json" || exit 2',
        `SM_ID=$(jq -r --arg n ${shq(metricName)} '[.[] | select(.name == $n)][0].id // empty' "$WORK/sms.json")`,
        'if [[ -n "$SM_ID" ]]; then',
        '  echo "A super metric of this name exists ($SM_ID): it is used as it is, and only enabled. Delete it first to change its formula."',
        'elif (( DRY_RUN )); then',
        `  echo "DRY RUN: would POST ${base}.json to /suite-api/api/supermetrics:"; jq . "$HERE/${base}.json"`,
        `  echo "then enable it in: ${policies.join(', ') || '(no policy)'}"`,
        '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'else',
        `  SM_ID=$(curl -sS -f -X POST "https://\${VCFOPS_HOST}/suite-api/api/supermetrics" -H "${authHeader('vcf-operations')}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @"$HERE/${base}.json" | jq -r '.id // empty')`,
        '  [[ -n "$SM_ID" ]] || { echo "POST /supermetrics returned no id." >&2; exit 2; }',
        '  echo "super metric $SM_ID" | tee created-ids.txt',
        'fi',
        ...(policies.length > 0 && assigned.length > 0
          ? [
              '',
              `jq --arg id "$SM_ID" 'walk(if . == "__SM_ID__" then $id else . end)' "$HERE/policy-changes.json" > "$WORK/policy-changes.json"`,
              'if (( DRY_RUN )); then "$HERE/policy-apply.sh" "$WORK/policy-changes.json" --dry-run; else "$HERE/policy-apply.sh" "$WORK/policy-changes.json"; fi',
            ]
          : []),
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${metricName} — a super metric on ${onText}`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `Every collection cycle, in ${policies.join(', ') || 'no policy yet'}`, worstCase: 'every five minutes, for every object of the types it is enabled on' },
        scope: {
          what: `Objects of type ${onText} covered by ${policies.length > 0 ? policies.join(', ') : 'a policy that enables it'}.`,
          decidedBy: ['The object types it is assigned to.', policies.length > 0 ? `The policies it is enabled in: ${policies.join(', ')}.` : 'The policies that enable it — none is named here.', 'The custom groups those policies are assigned to.'],
          ifWrong: 'Nothing is changed. The cost is load on the cluster, and a number nobody checked being used in a capacity decision.',
        },
        guardrails: [
          { rule: 'Depth kept to the level it needs', because: 'Super metric cost grows with every object it reaches. A formula from the vCenter down is evaluated across the whole inventory.' },
          { rule: 'apply.sh reuses a super metric of the same name rather than making a second', because: 'Two super metrics of one name are two metric keys, and dashboards pick whichever was first.' },
          ...(policies.length > 0 ? [{ rule: 'Each policy is exported first and read back after', because: 'The export is the undo, and a policy import that dropped the setting is reported rather than assumed.' }] : []),
        ],
        dryRun: ['apply.sh --dry-run prints what it would create and runs the policy merge without importing.', 'Paste the formula into the super metric editor and use Preview against one object: it shows the last week’s values.'],
        undo: ['DELETE /suite-api/api/supermetrics/{id} with the id in created-ids.txt. Its history goes with it.', ...(policies.length > 0 ? ['Re-import the policy-before-*.zip files to put the policies back.'] : [])],
        told: ['Nobody — it is a metric. Alert on it with "An alert, with its symptoms and a recommendation" if it needs watching.'],
        requires: ['The adapters collecting the metrics the formula reads.', 'jq 1.6 or later and python3.'],
        files: {
          [`${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'apply.sh': apply,
          ...(policies.length > 0 && assigned.length > 0 ? { 'policy-changes.json': policyChangesJson(changes), 'policy-apply.sh': policyApplyScript() } : {}),
          'import/supermetric.json': exportJson,
          ...contentPackage({ 'supermetrics.json': exportJson }, { superMetrics: 1 }),
          'import-content.sh': contentImportScript({ what: `the super metric "${metricName}"`, contentType: 'SUPER_METRICS', needles: [smId, `"name": ${JSON.stringify(metricName)}`, `"name":${JSON.stringify(metricName)}`] }),
          'IMPORT.md': importMd({
            title: `the super metric "${metricName}"`,
            steps: [
              {
                heading: 'By the REST API — created, assigned and enabled',
                files: [`${base}.json`, 'apply.sh', ...(policies.length > 0 && assigned.length > 0 ? ['policy-changes.json', 'policy-apply.sh'] : [])],
                how: [
                  `./apply.sh (add --dry-run first) — POST /suite-api/api/supermetrics with its object types (${onText}); the API assigns its id.`,
                  ...(policies.length > 0 && assigned.length > 0 ? [`Then policy-apply.sh enables it in ${policies.join(', ')}: export (the undo), merge, import, read back.`] : []),
                ],
                verify: ['that POST /supermetrics takes resourceKinds; if the metric arrives unassigned, assign it under the super metric’s Object Types.', 'the policy XML block for super metrics (<SuperMetrics adapterKind resourceKind><SuperMetric id enabled/>) against an export of a policy with a super metric enabled — policy-apply.sh reads it back and reports it if the import dropped it.'],
              },
              {
                heading: 'Or import the super metric',
                files: ['import/supermetric.json'],
                how: [
                  'Configure → Super Metrics → ⋯ → Import (8.x: Administration → Configuration → Super Metrics → Import Super Metric), and choose import/supermetric.json. A super metric with the same name is skipped unless you choose to overwrite.',
                  assigned.length > 0 ? `It arrives assigned to ${onText}, keyed by id ${smId}; its metric key is Super Metric|sm_${smId}.` : 'It arrives assigned to no object type: assign it under the super metric’s Object Types after import.',
                  ...(policies.length > 0 && assigned.length > 0 ? [`Then enable it: replace __SM_ID__ in policy-changes.json with ${smId} and run ./policy-apply.sh policy-changes.json.`] : []),
                ],
              },
              contentStep('SUPER_METRICS'),
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          'A super metric only starts from the moment it is enabled. There is no backfill, so the first week of charts is empty — create it before you need it.',
          'VERIFY: the unitId values against the unit list in the super metric editor of your release.',
          ...(preset === 'builder' ? ['VERIFY: the where= and isFresh= options against the super metric editor’s function help on your release.'] : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_workload_policy',
    platform: PLATFORM,
    label: 'A policy for a class of workload',
    group: 'Policy',
    description:
      'The VCF Ops content page finds most custom groups on the default policy, which makes the group decorative. This creates a policy for one class of workload under its parent, sets the capacity values that differ, assigns it to its groups at its priority, and reads it back — with the parent’s export kept as the undo.',
    inputs: [
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'Tier 1 production' },
      { id: 'parent', label: 'Inherits from', control: 'text', default: 'Default Policy' },
      { id: 'groups', label: 'Applies to groups', control: 'text', default: 'Tier 1 VMs, Tier 1 hosts' },
      { id: 'priority', label: 'Priority', control: 'number', default: 1, min: 1, max: 100, hint: '1 is highest. A higher-priority policy wins outright where two cover the same object' },
      {
        id: 'capacity_model',
        label: 'Capacity based on',
        control: 'select',
        options: [
          { value: 'demand', label: 'Demand — what is used' },
          { value: 'allocation', label: 'Allocation — what is promised' },
        ],
        default: 'allocation',
      },
      { id: 'cpu_overcommit', label: 'CPU overcommit ratio (allocation model)', control: 'number', default: 4, min: 1, max: 20, showWhen: { input: 'capacity_model', equals: ['allocation'] } },
      { id: 'mem_overcommit', label: 'Memory overcommit ratio (allocation model)', control: 'number', default: 1, min: 1, max: 4, showWhen: { input: 'capacity_model', equals: ['allocation'] } },
      { id: 'buffer_pct', label: 'Capacity buffer %', control: 'number', default: 20, min: 0, max: 50 },
      { id: 'time_remaining_days', label: 'Warn when capacity runs out within (days)', control: 'number', default: 120, min: 30, max: 365 },
      {
        id: 'capacity_on',
        label: 'Capacity settings on',
        control: 'select',
        options: [
          { value: 'ClusterComputeResource', label: 'Clusters' },
          { value: 'HostSystem', label: 'ESX hosts' },
          { value: 'Datastore', label: 'Datastores' },
        ],
        default: 'ClusterComputeResource',
      },
    ],
    automation: (values                 , name        )             => {
      const policyName = str(values, 'policy_name', 'Workload policy');
      const parent = str(values, 'parent', 'Default Policy');
      const groups = listOf(str(values, 'groups', ''));
      const priority = num(values, 'priority', 1);
      const model = str(values, 'capacity_model', 'allocation');
      const cpuRatio = num(values, 'cpu_overcommit', 4);
      const memRatio = num(values, 'mem_overcommit', 1);
      const buffer = num(values, 'buffer_pct', 20);
      const days = num(values, 'time_remaining_days', 120);
      const on = str(values, 'capacity_on', 'ClusterComputeResource');

      const findings            = [];
      if (groups.length === 0) {
        findings.push(error('vcfops.policy.unassigned', 'A policy assigned to no group applies to nothing.', { source: SRC }));
      }
      if (policyName.trim().toLowerCase() === parent.trim().toLowerCase()) {
        findings.push(error('vcfops.policy.own-parent', 'The policy inherits from itself.', { source: SRC }));
      }
      if (model === 'allocation' && memRatio > 1.5) {
        findings.push(
          warning('vcfops.policy.mem-overcommit', `A ${memRatio}:1 memory overcommit in the capacity model will plan for ballooning and swapping.`, {
            remediation: 'For production, plan memory at 1:1 and let the demand model show where the real headroom is.',
            source: SRC,
          }),
        );
      }
      if (buffer === 0) {
        findings.push(warning('vcfops.policy.no-buffer', 'With no buffer, capacity is reported as available right up to the moment a host failure makes it unavailable.', { remediation: 'The buffer should at least cover one host per cluster — N+1 is what HA already assumes.', source: SRC }));
      }

      // VERIFY: element and attribute names below are written from the policy
      // editor's labels, not a published schema. policy-apply.sh reads the
      // policy back and prints any setting the import did not keep.
      const setting = (label        , item        , set                        )               => ({ label, block: 'CapacitySettings', item, adapterKind: 'VMWARE', resourceKind: on, set });
      const changes                = {
        policies: [policyName],
        create: { parent, description: `Capacity and thresholds for ${groups.join(', ') || 'its groups'}.` },
        changes: [
          setting(`capacity model: ${model}`, 'AllocationModel', model === 'allocation' ? { enabled: 'true', cpuOvercommitRatio: String(cpuRatio), memoryOvercommitRatio: String(memRatio) } : { enabled: 'false' }),
          setting(`capacity buffer: ${buffer}%`, 'CapacityBuffer', { cpu: String(buffer), memory: String(buffer), disk: String(buffer) }),
          setting(`time remaining warning: ${days} days`, 'TimeRemaining', { warningDays: String(days) }),
        ],
        groups,
        priority,
      };
      const table = [
        '| Setting | Value | Why |',
        '|---|---|---|',
        `| Inherits from | ${parent} | Everything not listed here comes from the parent, and changes when it changes. |`,
        `| Priority | ${priority} | Where two policies cover the same object, the higher priority wins outright — they do not combine. |`,
        `| Applies to | ${groups.join(', ') || '(nothing)'} | The group is what makes the policy mean anything. |`,
        `| Capacity model | ${model} | ${model === 'allocation' ? 'Plans against what has been promised, which is what a production service can call on.' : 'Plans against what is used, which reclaims more and protects less.'} |`,
        ...(model === 'allocation' ? [`| CPU overcommit | ${cpuRatio}:1 | ${cpuRatio > 6 ? 'High for production; check CPU ready first.' : 'A common production ratio.'} |`, `| Memory overcommit | ${memRatio}:1 | ${memRatio > 1 ? 'Relies on memory reclamation under load.' : 'No reliance on ballooning or swap.'} |`] : []),
        `| Capacity buffer | ${buffer}% | Held back from what is reported as available. |`,
        `| Time-remaining warning | ${days} days | Long enough to buy and rack hardware, which is the only thing this warning is for. |`,
      ];

      return {
        platform: PLATFORM,
        title: `${policyName} — its own capacity model for ${groups.join(', ') || 'no group yet'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once, as a change; re-run it to put the values back after a hand edit.' },
        scope: {
          what: `Every object in ${groups.join(', ') || '(no groups)'}, unless a higher-priority policy also covers it.`,
          decidedBy: ['The groups it is assigned to.', `Its priority (${priority}) against every other policy covering the same objects.`, `Everything not set here, inherited from "${parent}".`],
          ifWrong: 'Alerts and capacity figures change for objects you did not mean to include. The capacity report is what people buy hardware from, so a wrong model is an expensive mistake made slowly.',
        },
        guardrails: [
          { rule: 'The policy is exported before it is changed, and read back after', because: 'The export is the undo, and a setting this release does not know is dropped on import without a word — the read-back is what catches it.' },
          { rule: 'Only differences from the parent are set', because: 'A policy that restates every inherited value stops following its parent, and nobody notices which values froze.' },
          { rule: 'Stops if a group does not exist', because: 'A policy assigned to half its groups looks applied and covers half the estate it was meant to.' },
        ],
        dryRun: ['./apply.sh --dry-run finds or plans the policy, exports and merges without importing, and prints each change.', 'After applying, open one object in each group and check Policy in its summary shows this policy — not a higher-priority one.'],
        undo: ['Re-import the policy-before-*.zip policy-apply.sh saved; or unassign the groups, which fall back to whichever policy covers them next. Deleting the policy does the same.'],
        told: ['Nobody. A policy change is silent, which is why it belongs in a change record.'],
        requires: [`The groups ${groups.join(', ') || '(none)'} to exist.`, `The parent policy "${parent}".`, 'jq and python3.'],
        files: {
          'policy-changes.json': policyChangesJson(changes),
          'policy-apply.sh': policyApplyScript(),
          'apply.sh': ['#!/usr/bin/env bash', `# Create or update the policy "${policyName}" and assign it. --dry-run previews.`, 'set -euo pipefail', 'HERE=$(cd "$(dirname "$0")" && pwd)', 'exec "$HERE/policy-apply.sh" "$HERE/policy-changes.json" "$@"', ''].join('\n'),
          'IMPORT.md': importMd({
            title: `the policy "${policyName}"`,
            steps: [
              {
                heading: 'By the REST API',
                files: ['policy-changes.json', 'policy-apply.sh', 'apply.sh'],
                how: [
                  `./apply.sh (add --dry-run first). It creates "${policyName}" under "${parent}" if it does not exist (POST /suite-api/api/policies), exports it (the undo), merges the capacity settings, imports it (POST /suite-api/api/policies/import?forceImport=true), reads it back, and assigns it to ${groups.join(', ') || 'its groups'} (PUT /suite-api/api/policies/apply).`,
                  'Exit 4 means applied in part: the settings or groups that did not take are printed, with where to set them by hand.',
                ],
                verify: ['POST /suite-api/api/policies and PUT /suite-api/api/policies/apply on your release; policy-apply.sh prints the manual step if either is refused.', 'the capacity setting element names (CapacitySettings / AllocationModel, CapacityBuffer, TimeRemaining) against an export of a policy with those set in the editor. Correct them in policy-changes.json once; the read-back reports any that did not take.'],
              },
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          'Policies do not combine. An object covered by two policies gets all of the higher-priority one and none of the other, which is the most common reason an alert "should" be firing and is not.',
          `What it sets, and why:\n${table.join('\n')}`,
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_compliance',
    platform: PLATFORM,
    label: 'Security Posture Management benchmark on a group — enable and report',
    group: 'Compliance',
    description:
      'VCF 9.1 retires Compliance in favour of Security Posture Management. This enables one of its benchmarks (VCF Security Configuration Guide, PCI DSS v4.0.1 for VCF 9, VCF 9 General Controls) in the policy for a group and sends a weekly list of what in that group fails it. Reports only — the fixes belong in a change. For drift week on week across the policy, use "Security Posture Management drift report".',
    inputs: [
      {
        id: 'benchmark',
        label: 'Benchmark',
        control: 'select',
        options: [
          { value: 'VCF 9.x Security Configuration Guide v1.0', label: 'VCF Security Configuration Guide (VCF 9.x SCG v1.0)' },
          { value: 'PCI DSS v4.0.1 for VCF 9 v1.0', label: 'PCI DSS v4.0.1 for VCF 9' },
          { value: 'VCF 9 General Controls v1.0', label: 'VCF 9 General Controls' },
        ],
        default: 'VCF 9.x Security Configuration Guide v1.0',
      },
      { id: 'group_name', label: 'For group', control: 'text', default: 'Production hosts' },
      { id: 'policy_name', label: 'Enabled in policy', control: 'text', default: 'Tier 1 production' },
      { id: 'webhook', label: 'Weekly drift report to', control: 'text', default: 'https://runbooks.example.com/hooks/compliance' },
      { id: 'fail_on', label: 'Exit non-zero when more than (failing objects)', control: 'number', default: 0, min: 0, max: 100000 },
      { id: 'definition_regex', label: 'Benchmark alert definitions named like', control: 'text', default: '', hint: 'Regex on the compliance alert definition name. Empty uses the usual name for the chosen benchmark — VERIFY it under Alerts > Alert Definitions' },
    ],
    automation: (values                 , name        )             => {
      const requested = str(values, 'benchmark', 'VCF 9.x Security Configuration Guide v1.0');
      const retired = !Object.hasOwn(BENCHMARK_ALERT_RX, requested);
      const benchmark = retired ? 'VCF 9.x Security Configuration Guide v1.0' : requested;
      const group = str(values, 'group_name', '');
      const policy = str(values, 'policy_name', '');
      const webhook = str(values, 'webhook', '');
      const failOn = num(values, 'fail_on', 0);
      const base = slugOf(name || `${benchmark}-compliance`, 'compliance');

      const findings            = [];
      if (retired) {
        findings.push(
          warning('vcfops.compliance.retired', `"${requested}" was a Compliance benchmark. VCF 9.1 deprecates Compliance; Security Posture Management replaces it, and this uses ${benchmark} instead.`, {
            remediation: 'Pick the Security Posture Management benchmark that covers the same controls: PCI DSS v4.0.1 for VCF 9 for PCI, the VCF Security Configuration Guide for hardening.',
            source: SRC,
          }),
        );
      }
      if (!str(values, 'definition_regex', '')) {
        findings.push(
          warning('vcfops.compliance.spm-names', `The name pattern for ${benchmark}'s alert definitions is a guess: 9.1 does not document how Security Posture Management names them.`, {
            remediation: 'Open Alerts > Alert Definitions, filter on the benchmark, and set "Benchmark alert definitions named like" to match. Both scripts stop (exit 2) rather than act on nothing when nothing matches.',
            source: SRC,
          }),
        );
      }
      if (/default/i.test(policy)) {
        findings.push(
          warning('vcfops.compliance.default-policy', 'Enabling a benchmark in the default policy applies it to every object in the estate.', {
            remediation: 'A benchmark is a list of alerts. Across the whole estate that is thousands of them on the first day, most on things nobody intends to harden.',
            source: SRC,
          }),
        );
      }
      if (!policy) findings.push(error('vcfops.compliance.no-policy', 'No policy is named, so the benchmark is enabled nowhere.', { source: SRC }));

      const defRx = str(values, 'definition_regex', '') || BENCHMARK_ALERT_RX[benchmark] || benchmark;
      const report = readScript('vcf-operations', `Weekly ${benchmark} drift report for "${group}".`, [
        `THRESHOLD=${failOn}`,
        `BENCH=${shq(benchmark)}`,
        `DEF_RX="\${DEF_RX:-${defRx.replace(/["$`\\]/g, '\\$&')}}"`,
        ': "${GROUP_ID:?set GROUP_ID — GET /suite-api/api/resources/groups?name=... and take its id}"',
        ...workDirLines(),
        ...PAGED_HELPERS,
        ...WEBHOOK_HELPER,
        'STAMP=$(date +%Y%m%d)',
        'OUT="compliance-$STAMP.json"',
        '',
        '# 1. This benchmark’s alert definitions: compliance (subType 21) definitions whose',
        '#    name matches DEF_RX. The API has no name filter, so every page is read and',
        '#    filtered here. VERIFY DEF_RX against the names under Alerts > Alert Definitions.',
        'get_all /suite-api/api/alertdefinitions alertDefinitions "$WORK/defs.json" || exit 2',
        'jq --arg rx "$DEF_RX" \'[.[] | select(.subType == 21 and ((.name // "") | test($rx; "i"))) | {id, name}]\' "$WORK/defs.json" > "$WORK/bench-defs.json"',
        'ND=$(jq length "$WORK/bench-defs.json")',
        'echo "$ND alert definition(s) for $BENCH (name matches /$DEF_RX/):"',
        'jq -r \'.[].name | "  " + .\' "$WORK/bench-defs.json"',
        '(( ND > 0 )) || { echo "No compliance alert definition matches /$DEF_RX/. Nothing to report on is not the same as compliant: fix DEF_RX." >&2; exit 2; }',
        '',
        '# 2. The group, so the report covers it and nothing else.',
        'get_all "/suite-api/api/resources/groups/${GROUP_ID}/members" resourceList "$WORK/members.json" || exit 2',
        'NM=$(jq length "$WORK/members.json")',
        '(( NM > 0 )) || { echo "Group $GROUP_ID has no members: nothing would be checked." >&2; exit 2; }',
        '',
        '# 3. Active alerts of those definitions only, paged, then narrowed to the group.',
        'jq \'{activeOnly: true, alertDefinitionId: [.[].id]}\' "$WORK/bench-defs.json" > "$WORK/alert-query.json"',
        'post_all /suite-api/api/alerts/query alerts "$WORK/alerts.json" "$WORK/alert-query.json" || exit 2',
        'jq --slurpfile m "$WORK/members.json" \'($m[0] | map({key: .identifier, value: (.resourceKey.name // .identifier)}) | from_entries) as $in',
        '  | [.[] | select($in[.resourceId] != null) | . + {resourceName: $in[.resourceId]}]\' "$WORK/alerts.json" > "$WORK/group-alerts.json"',
        '',
        '# 4. The failing rules are the alert’s contributing symptoms, 50 alerts a call.',
        '#    VERIFY the nesting of contributingSymptoms on your release: the ids are',
        '#    found wherever symptomDefinitionId appears under each entry.',
        'jq -r \'.[].alertId\' "$WORK/group-alerts.json" > "$WORK/alert-ids.txt"',
        ': > "$WORK/symptoms.items"',
        'while mapfile -t -n 50 batch && (( ${#batch[@]} )); do',
        '  q=$(printf "id=%s&" "${batch[@]}")',
        '  get "/suite-api/api/alerts/contributingsymptoms?${q%&}" > "$WORK/cs.json" || { echo "Could not read contributing symptoms." >&2; exit 2; }',
        '  jq -c \'(.contributingSymptoms // [])[] | {alertId: (.alertId // .id), defs: ([.. | objects | .symptomDefinitionId? // empty] | unique)}\' "$WORK/cs.json" >> "$WORK/symptoms.items"',
        'done < "$WORK/alert-ids.txt"',
        'jq -s . "$WORK/symptoms.items" > "$WORK/symptoms.json"',
        'jq -r \'[.[].defs[]] | unique[]\' "$WORK/symptoms.json" > "$WORK/symptom-ids.txt"',
        ': > "$WORK/names.items"',
        'while mapfile -t -n 50 batch && (( ${#batch[@]} )); do',
        '  q=$(printf "id=%s&" "${batch[@]}")',
        '  get "/suite-api/api/symptomdefinitions?${q%&}" > "$WORK/sd.json" || { echo "Could not read symptom definitions." >&2; exit 2; }',
        '  jq -c \'(.symptomDefinitions // [])[] | {id, name}\' "$WORK/sd.json" >> "$WORK/names.items"',
        'done < "$WORK/symptom-ids.txt"',
        'jq -s . "$WORK/names.items" > "$WORK/names.json"',
        '',
        'jq -n --slurpfile a "$WORK/group-alerts.json" --slurpfile s "$WORK/symptoms.json" --slurpfile n "$WORK/names.json" \'',
        '  ($s[0] | map({key: .alertId, value: .defs}) | from_entries) as $sym',
        '  | ($n[0] | map({key: .id, value: .name}) | from_entries) as $name',
        '  | $a[0] | group_by(.resourceId)',
        '  | map({resourceId: .[0].resourceId, resource: .[0].resourceName, alerts: (map(.alertDefinitionName) | unique),',
        '         failingRules: ([.[] | ($sym[.alertId] // [])[] | ($name[.] // .)] | unique)})\' > "$OUT"',
        '',
        'COUNT=$(jq length "$OUT")',
        'RULES=$(jq \'[.[].failingRules[]] | unique | length\' "$OUT")',
        `echo "$BENCH: $COUNT of $NM object(s) in ${group.replace(/["$`\\]/g, '')} fail, across $RULES distinct rule(s). Report: $OUT"`,
        'jq -r \'.[] | "\\(.resource): \\(if (.failingRules | length) > 0 then (.failingRules | join("; ")) else "(no contributing symptoms returned: open the alert)" end)"\' "$OUT"',
        ...(webhook
          ? ['', `jq -n --arg b "$BENCH" --slurpfile r "$OUT" '{benchmark: $b, objects: $r[0]}' > "$WORK/webhook.json"`, `post_webhook ${shq(webhook)} "$WORK/webhook.json"`]
          : []),
        '',
        'if (( COUNT > THRESHOLD )); then finish 1; fi',
        'finish 0',
      ]);

      const enable = [
        '#!/usr/bin/env bash',
        `# Enable ${benchmark} in "${policy}": its alert definitions, enabled in the policy,`,
        '# through policy-apply.sh (export, merge, import, read back).',
        '#',
        '# VERIFY: 9.1 documents no API for Security Posture Management’s "Enable Benchmark".',
        '# This enables the benchmark’s compliance alert definitions in the policy, which is',
        '# what enabling a benchmark in a policy did before 9.1. If the benchmark does not show',
        '# as enabled under Protect > Security Posture Management afterwards, do the three',
        `# clicks in ${base}-ENABLE.md instead — this script changes nothing else.`,
        '#',
        '# Applies when run. With --dry-run it lists the definitions and merges without importing.',
        'set -euo pipefail',
        ...authPreamble('vcf-operations'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...workDirLines(),
        `get() { curl -sS -f "https://\${VCFOPS_HOST}$1" -H "${authHeader('vcf-operations')}" -H "Accept: application/json"; }`,
        ...PAGED_HELPERS,
        `DEF_RX="\${DEF_RX:-${defRx.replace(/["$`\\]/g, '\\$&')}}"`,
        'get_all /suite-api/api/alertdefinitions alertDefinitions "$WORK/defs.json" || exit 2',
        'jq --arg rx "$DEF_RX" \'[.[] | select(.subType == 21 and ((.name // "") | test($rx; "i")))]\' "$WORK/defs.json" > "$WORK/bench.json"',
        '(( $(jq length "$WORK/bench.json") > 0 )) || { echo "No compliance alert definition matches /$DEF_RX/: nothing to enable. Set DEF_RX." >&2; exit 2; }',
        'echo "$(jq length "$WORK/bench.json") definition(s) to enable."',
        `jq --arg p ${shq(policy)} '{policies: [$p], changes: [.[] | {label: ("benchmark rule " + .name), block: "Alerts", item: "Alert", adapterKind: .adapterKindKey, resourceKind: .resourceKindKey, id: .id, set: {enabled: "true"}}]}' "$WORK/bench.json" > "$WORK/policy-changes.json"`,
        'exec "$HERE/policy-apply.sh" "$WORK/policy-changes.json" "$@"',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${benchmark} on "${group}" — enabled in "${policy}", with a weekly list of what fails it`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: 'Enabled once; the report weekly, from wherever report.sh is scheduled', worstCase: 'once a week' },
        scope: {
          what: `Objects in "${group}", checked against ${benchmark}.`,
          decidedBy: [
            `The policy "${policy}", where the benchmark is enabled — its scope is every object that policy covers.`,
            `The group "${group}" (GROUP_ID): only its members are reported.`,
            `The benchmark's compliance alert definitions, found by name (/${defRx}/); only their active alerts count.`,
          ],
          ifWrong: 'The benchmark is assessed on objects nobody meant to harden, and its alerts land on the wrong team. Nothing is remediated either way.',
        },
        guardrails: [
          { rule: 'Reports; never remediates', because: 'Hardening changes break things — SSH disabled on a host an engineer is in, a TLS setting a backup agent needed. They go through change.' },
          { rule: 'Enabled for a group’s policy, not the estate', because: 'A benchmark across everything is thousands of alerts on day one, and alert fatigue before the first fix.' },
          { rule: 'The policy is exported before it is changed and read back after', because: 'The export is the undo; a rule the import dropped is reported.' },
          { rule: 'Both scripts exit 2 when no alert definition matches the benchmark name pattern, the group is empty, or any read fails', because: 'A report built from nothing says "0 failing", which reads as compliant.' },
          ...(webhook ? [{ rule: 'The webhook post uses curl -f; a failed post exits 3', because: 'Otherwise an undelivered report looks exactly like a delivered one.' }] : []),
        ],
        dryRun: ['enable-benchmark.sh --dry-run lists the benchmark’s definitions and merges them into an export of the policy without importing.', 'Run report.sh by hand once and check the alert definitions it lists are this benchmark’s and no other’s.'],
        undo: [`Re-import the policy-before-*.zip policy-apply.sh saved, or Protect → Security Posture Management → ⋮ → Disable Benchmark for "${policy}". Its alerts clear on the next cycle.`],
        told: webhook ? [`${webhook}, weekly, with each failing object, the benchmark alerts on it, and the rules (the alerts’ contributing symptoms) it fails.`] : ['The JSON file the script writes. Set a webhook if somebody should read it.'],
        requires: [
          `VCF Operations 9.1 or later; ${benchmark} ships with Security Posture Management. VERIFY licensing — the 9.1 Security Posture Management pages are published under VMware Advanced Cyber Compliance.`,
          'jq and python3 on the machine running the scripts.',
        ],
        files: {
          [`${base}-ENABLE.md`]: [
            `# Enable ${benchmark} (Security Posture Management, 9.1)`,
            '',
            'enable-benchmark.sh does this through the policy. If the benchmark does not show as enabled afterwards, or you would rather click:',
            '',
            `1. Protect → Security Posture Management → ⋮ next to ${benchmark} → Enable Benchmark → assign "${policy}".`,
            '2. View Control Set: set any rule marked * (a site-specific value), then Run Assessment.',
            `3. Check "${policy}" is assigned to "${group}" and that no higher-priority policy covers the same objects.`,
            '4. Schedule report.sh weekly with GROUP_ID set. Exit 0: at or under the threshold; 1: over it; 2: could not read, or found no alert definitions for the benchmark; 3: the webhook post failed.',
            '',
          ].join('\n'),
          'enable-benchmark.sh': enable,
          'policy-apply.sh': policyApplyScript(),
          'report.sh': report,
          'crontab.txt': `# Weekly, Monday 07:30. Set GROUP_ID to the group id (GET /suite-api/api/resources/groups?name=...).
# The script logs in for itself from the password file (mode 600).\n30 7 * * 1 GROUP_ID=00000000-0000-0000-0000-000000000000 ${scheduledEnv('vcf-operations', 'svc-vcfops-readonly')} /usr/local/bin/report.sh >> /var/log/vcf-compliance.log 2>&1\n`,
          'IMPORT.md': nothingToImportMd('the Security Posture Management benchmark on a group', [
            `enable-benchmark.sh (with policy-apply.sh beside it) enables ${benchmark}’s alert definitions in "${policy}": export, merge, import, read back. --dry-run stops before the import.`,
            'report.sh reads the benchmark’s active alerts for the group over the API and changes nothing. Run it from cron (crontab.txt); it exits non-zero on drift.',
            `${base}-ENABLE.md is the three clicks, for when the API route is refused.`,
          ]),
        },
        notes: [
          'VCF 9.1 deprecates Compliance (and the CIS, DISA STIG, HIPAA and ISO compliance packs under it); Security Posture Management ships these three benchmarks. Other frameworks install from the Solutions Catalog.',
          'The first run is a baseline, not a failure. Agree the number that is acceptable this quarter and set the threshold to it, then lower it.',
          'Documented calls: GET /api/alertdefinitions (paged; no name filter, so names are matched here), POST /api/alerts/query {activeOnly, alertDefinitionId} (paged), GET /api/alerts/contributingsymptoms?id=…, GET /api/symptomdefinitions?id=….',
          'VERIFY: that Security Posture Management results raise compliance alerts (subType 21) named after the benchmark in your build, and the nesting of contributingSymptoms entries.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_webhook_payload',
    platform: PLATFORM,
    label: 'The payload a notification sends',
    group: 'Notification',
    description:
      'The body that arrives, shaped for where it lands — an email (HTML), a Slack message, a ServiceNow incident with your field mapping, an SNMP trap’s fields, a Teams card or a runbook runner — using the alert fields VCF Operations substitutes. apply-template.sh creates the payload template for the outbound instance you name and binds it to the notification rule; send-sample.sh posts a filled-in sample so the receiving end can be tested before a real alert depends on it.',
    inputs: [
      {
        id: 'destination',
        label: 'Lands in',
        control: 'select',
        options: [
          { value: 'runbook', label: 'A runbook runner (generic JSON, Webhook plug-in)' },
          { value: 'servicenow', label: 'ServiceNow incident (Webhook plug-in to the Table API or an Import Set)' },
          { value: 'email', label: 'Email (Standard Email plug-in, HTML)' },
          { value: 'slack', label: 'Slack (Slack plug-in, or an incoming webhook)' },
          { value: 'snmp', label: 'SNMP trap (SNMP Trap plug-in)' },
          { value: 'teams', label: 'Microsoft Teams (Workflows, Webhook plug-in)' },
        ],
        default: 'runbook',
      },
      { id: 'endpoint', label: 'Endpoint', control: 'text', default: 'https://runbooks.example.com/hooks/vcfops', showWhen: { input: 'destination', equals: ['runbook', 'servicenow', 'slack', 'teams'] } },
      { id: 'assignment_group', label: 'ServiceNow assignment group', control: 'text', default: 'Platform Operations', showWhen: { input: 'destination', equals: ['servicenow'] } },
      {
        id: 'sn_fields',
        label: 'ServiceNow field mapping',
        control: 'textarea',
        default: 'short_description | [VCF Operations] ${ALERT_DEFINITION} on ${RESOURCE_NAME}\nurgency | 2\nimpact | 2\ncategory | Infrastructure\ncmdb_ci | ${RESOURCE_NAME}',
        hint: 'field | value',
        help: 'Incident fields and what goes in them; ${...} are alert fields. description, assignment_group and correlation_id are always set.',
        showWhen: { input: 'destination', equals: ['servicenow'] },
      },
      { id: 'email_subject', label: 'Email subject', control: 'text', default: '[${ALERT_CRITICALITY}] ${ALERT_DEFINITION} on ${RESOURCE_NAME}', showWhen: { input: 'destination', equals: ['email'] } },
      {
        id: 'snmp_fields',
        label: 'Trap fields',
        control: 'checklist',
        options: ['ALERT_DEFINITION', 'ALERT_CRITICALITY', 'STATUS', 'RESOURCE_NAME', 'RESOURCE_KIND', 'ALERT_ID', 'CREATE_TIME', 'ALERT_URL', 'ALERT_RECOMMENDATIONS'].map((f) => ({ value: f, label: f })),
        default: 'ALERT_DEFINITION,ALERT_CRITICALITY,STATUS,RESOURCE_NAME,ALERT_ID',
        showWhen: { input: 'destination', equals: ['snmp'] },
      },
      { id: 'include_link', label: 'Link back to the alert', control: 'toggle', default: true },
      { id: 'template_name', label: 'Template name', control: 'text', default: 'Alert payload' },
      { id: 'plugin_instance', label: 'For the outbound instance named', control: 'text', default: 'Runbook webhook', hint: 'The outbound instance the template belongs to — "An outbound plugin instance" creates one' },
      { id: 'rule_name', label: 'Bind to the notification rule named', control: 'text', default: 'Alert to webhook', hint: 'Empty creates the template and binds it to nothing' },
    ],
    automation: (values                 , name        )             => {
      const destination = str(values, 'destination', 'runbook');
      const webhookish = destination === 'runbook' || destination === 'servicenow' || destination === 'slack' || destination === 'teams';
      const endpoint = webhookish ? str(values, 'endpoint', '') : '';
      const assignment = str(values, 'assignment_group', 'Platform Operations');
      const link = bool(values, 'include_link', true);
      const templateName = str(values, 'template_name', 'Alert payload');
      const plugin = str(values, 'plugin_instance', '');
      const ruleName = str(values, 'rule_name', '');
      const subject = str(values, 'email_subject', '[${ALERT_CRITICALITY}] ${ALERT_DEFINITION} on ${RESOURCE_NAME}');
      const snmpFields = str(values, 'snmp_fields', '').split(',').map((f) => f.trim()).filter(Boolean);
      const base = slugOf(name || `${destination}-payload`, 'payload');
      const sn = destination === 'servicenow';
      const email = destination === 'email';
      const snmp = destination === 'snmp';
      const LABELS                         = { servicenow: 'ServiceNow', teams: 'Teams', slack: 'Slack', email: 'email', snmp: 'SNMP trap', runbook: 'a runbook runner' };
      // VERIFY: the plug-in type names a payload template is filed under.
      const pluginType = email ? 'StandardEmailPlugin' : snmp ? 'SNMPTrapPlugin' : destination === 'slack' ? 'SlackPlugin' : 'WebhookPlugin';

      const findings            = [];
      if (destination === 'teams' && /outlook\.office\.com\/webhook|webhook\.office\.com/i.test(endpoint)) {
        findings.push(
          error('vcfops.payload.teams-connector', 'This is an Office 365 connector URL, and Microsoft has retired those connectors.', {
            remediation: 'Create a Teams workflow with the "When a Teams webhook request is received" trigger and use its URL instead.',
            source: SRC,
          }),
        );
      }
      if (/^http:\/\//i.test(endpoint)) {
        findings.push(warning('vcfops.payload.plain-http', 'The endpoint is plain HTTP, so alert details cross the network unencrypted.', { source: SRC }));
      }
      if (/[?&](token|key|secret|signature|sig)=/i.test(endpoint)) {
        findings.push(error('vcfops.payload.secret-in-url', 'The endpoint carries a secret in its query string.', { remediation: 'Put it in the outbound instance’s authentication or a header; a URL is logged and exported everywhere.', source: SRC }));
      }
      if (snmp && snmpFields.length === 0) findings.push(error('vcfops.payload.snmp-empty', 'No trap fields are ticked, so the trap says nothing about the alert.', { source: SRC }));
      if (email && !/\$\{ALERT_DEFINITION\}/.test(subject)) findings.push(warning('vcfops.payload.subject', 'The subject does not name the alert, so every email looks the same in an inbox.', { source: SRC }));
      if (!plugin) findings.push(error('vcfops.payload.no-plugin', 'No outbound instance is named, and a payload template belongs to one.', { source: SRC }));

      const snRows = rows(str(values, 'sn_fields', '')).map(cells);
      const badRow = snRows.find((row) => row.length < 2 || !row[0]);
      if (sn && badRow) findings.push(error('vcfops.payload.sn-row', `"${badRow.join(' | ')}" is not "field | value".`, { source: SRC }));
      if (sn && snRows.some((row) => row[0] === 'correlation_id')) findings.push(warning('vcfops.payload.sn-correlation', 'correlation_id is set to the alert id already; mapping it again replaces that.', { source: SRC }));

      const fields = {
        alert: '${ALERT_DEFINITION}',
        criticality: '${ALERT_CRITICALITY}',
        status: '${STATUS}',
        object: '${RESOURCE_NAME}',
        objectKind: '${RESOURCE_KIND}',
        alertId: '${ALERT_ID}',
        raised: '${CREATE_TIME}',
        ...(link ? { url: '${ALERT_URL}' } : {}),
      };

      const html = [
        '<html><body style="font-family: sans-serif">',
        '<h2>${ALERT_DEFINITION}</h2>',
        '<table cellpadding="4">',
        '<tr><td><b>Object</b></td><td>${RESOURCE_NAME} (${RESOURCE_KIND})</td></tr>',
        '<tr><td><b>Criticality</b></td><td>${ALERT_CRITICALITY}</td></tr>',
        '<tr><td><b>Status</b></td><td>${STATUS}</td></tr>',
        '<tr><td><b>Raised</b></td><td>${CREATE_TIME}</td></tr>',
        '<tr><td><b>Recommendation</b></td><td>${ALERT_RECOMMENDATIONS}</td></tr>',
        '</table>',
        ...(link ? ['<p><a href="${ALERT_URL}">Open in VCF Operations</a></p>'] : []),
        '</body></html>',
        '',
      ].join('\n');

      const bodies                          = {
        // 9.1: ${SYMPTOMS} is a structured JSON object and must be the whole value of its own key.
        runbook: { source: 'vcf-operations', ...fields, recommendations: '${ALERT_RECOMMENDATIONS}', symptoms: '${SYMPTOMS}' },
        servicenow: {
          ...Object.fromEntries(snRows.filter((row) => row[0] && row.length >= 2).map((row) => [row[0] , row.slice(1).join(' | ')])),
          // Real newlines: JSON.stringify writes them as \n, which ServiceNow renders as a line break.
          description: `Criticality: \${ALERT_CRITICALITY}\nStatus: \${STATUS}\nRaised: \${CREATE_TIME}\nRecommendation: \${ALERT_RECOMMENDATIONS}${link ? '\n${ALERT_URL}' : ''}`,
          assignment_group: assignment,
          correlation_id: '${ALERT_ID}',
        },
        teams: {
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                  { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: '${ALERT_DEFINITION}' },
                  { type: 'FactSet', facts: [{ title: 'Object', value: '${RESOURCE_NAME}' }, { title: 'Criticality', value: '${ALERT_CRITICALITY}' }, { title: 'Status', value: '${STATUS}' }] },
                ],
                ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in VCF Operations', url: '${ALERT_URL}' }] } : {}),
              },
            },
          ],
        },
        slack: {
          text: '${ALERT_CRITICALITY}: ${ALERT_DEFINITION} on ${RESOURCE_NAME}',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*\${ALERT_DEFINITION}*\n\${RESOURCE_NAME} — \${ALERT_CRITICALITY}, \${STATUS}${link ? '\n<${ALERT_URL}|Open in VCF Operations>' : ''}` } },
          ],
        },
        email: { subject, body: html },
        snmp: { varbinds: snmpFields.map((field) => ({ field, value: `\${${field}}` })) },
      };
      const body = bodies[destination] ?? bodies['runbook'];

      const fill = (text        ) =>
        text
          .replaceAll('${ALERT_DEFINITION}', 'Host memory pressure sustained')
          .replaceAll('${ALERT_CRITICALITY}', 'CRITICAL')
          .replaceAll('${STATUS}', 'ACTIVE')
          .replaceAll('${RESOURCE_NAME}', 'esx-test-01.example.com')
          .replaceAll('${RESOURCE_KIND}', 'HostSystem')
          .replaceAll('${ALERT_ID}', 'sample-0000')
          .replaceAll('${CREATE_TIME}', '2026-01-01T00:00:00Z')
          .replaceAll('${ALERT_URL}', 'https://vcfops.example.com/ui/')
          .replaceAll('${ALERT_RECOMMENDATIONS}', 'This is a test payload.');
      const sample = fill(JSON.stringify(body, null, 2))
        // The object VCF Operations 9.1 substitutes for "${SYMPTOMS}", quotes and all.
        .replaceAll(
          '"${SYMPTOMS}"',
          JSON.stringify({
            definedOn: 'self',
            symptoms: [{ name: 'Host memory usage above 95% (critical)', resourceName: 'esx-test-01.example.com', resourceId: '00000000-0000-0000-0000-000000000000', metricName: 'mem|host_usagePct', messageInfo: '96.2 > 95' }],
            conditions: [],
          }),
        );

      const templateFile = email ? `${base}-template.html` : `${base}-template.json`;
      const templateBody = email ? html : `${JSON.stringify(body, null, 2)}\n`;
      const sampleFile = email ? `${base}-sample.html` : snmp ? `${base}-sample.txt` : `${base}-sample.json`;
      const sampleBody = email ? fill(html) : snmp ? `${snmpFields.map((field) => `${field} = ${fill(`\${${field}}`)}`).join('\n')}\n` : `${sample}\n`;

      const applyTemplate = [
        '#!/usr/bin/env bash',
        `# Create the payload template "${templateName}" for the outbound instance "${plugin}"`,
        ruleName ? `# and bind it to the notification rule "${ruleName}".` : '# (bound to no rule).',
        '#',
        '# Applies when run. With --dry-run it checks the instance and the rule and stops.',
        '# Exit 4: this release refused the template API — the steps to add it by hand are printed.',
        'set -euo pipefail',
        ...authPreamble('vcf-operations'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...workDirLines(),
        'DRY_RUN=0',
        '[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        `get() { curl -sS -f "https://\${VCFOPS_HOST}$1" -H "${authHeader('vcf-operations')}" -H "Accept: application/json"; }`,
        `send() { curl -sS -f -X "$1" "https://\${VCFOPS_HOST}$2" -H "${authHeader('vcf-operations')}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @"$3"; }`,
        'manual() {',
        '  echo "Add it by hand: Configure > Alerts > Payload Templates > Add; outbound method: the plug-in of' + ` ${plugin.replace(/["$`\\]/g, '')}; paste ${templateFile}` + '." >&2',
        ...(ruleName ? [`  echo "Then Configure > Alerts > Notifications > ${ruleName.replace(/["$`\\]/g, '')} > Edit > Payload template: ${templateName.replace(/["$`\\]/g, '')}." >&2`] : []),
        '}',
        '',
        '# The outbound instance. VERIFY: GET /suite-api/api/alertplugins and its list key.',
        'get /suite-api/api/alertplugins > "$WORK/plugins.json" || { echo "Cannot list outbound instances." >&2; exit 2; }',
        `PLUGIN_ID=$(jq -r --arg n ${shq(plugin)} '[(.notificationPluginInstances // .pluginInstances // [])[] | select(.name == $n)][0].pluginId // empty' "$WORK/plugins.json")`,
        `[[ -n "$PLUGIN_ID" ]] || { echo "No outbound instance named ${plugin.replace(/["$`\\]/g, '')}. Instances:" >&2; jq -r '(.notificationPluginInstances // .pluginInstances // [])[].name | "  " + .' "$WORK/plugins.json" >&2; exit 2; }`,
        ...(ruleName
          ? [
              'get /suite-api/api/notifications/rules > "$WORK/rules.json" || { echo "Cannot list notification rules." >&2; exit 2; }',
              `jq --arg n ${shq(ruleName)} '[(.rules // .notificationRules // [])[] | select(.name == $n)][0] // empty' "$WORK/rules.json" > "$WORK/rule.json"`,
              `[[ -s "$WORK/rule.json" ]] || { echo "No notification rule named ${ruleName.replace(/["$`\\]/g, '')}: create it first (\\"Send an alert to a webhook\\")." >&2; exit 2; }`,
            ]
          : []),
        `jq -n --arg n ${shq(templateName)} --arg p "$PLUGIN_ID" --arg t '${pluginType}' --rawfile b "$HERE/${templateFile}" '{name: $n, description: "Alert payload for ${LABELS[destination] ?? destination}", pluginId: $p, pluginType: $t, payload: $b}' > "$WORK/template.json"`,
        'if (( DRY_RUN )); then',
        `  echo "DRY RUN: would create the template for $PLUGIN_ID${ruleName ? ' and bind it to the rule' : ''}:"; jq . "$WORK/template.json"`,
        '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'fi',
        '# VERIFY: the payload template API path and fields on your release.',
        'if ! send POST /suite-api/api/notifications/payloadtemplates "$WORK/template.json" > "$WORK/created.json"; then',
        '  echo "This release refused POST /suite-api/api/notifications/payloadtemplates." >&2',
        '  manual; exit 4',
        'fi',
        'TEMPLATE_ID=$(jq -r \'.id // empty\' "$WORK/created.json")',
        '[[ -n "$TEMPLATE_ID" ]] || { echo "The template API returned no id." >&2; manual; exit 4; }',
        'echo "payload template $TEMPLATE_ID" | tee created-ids.txt',
        ...(ruleName
          ? [
              '# Bind: the rule as it is, with templateId set. VERIFY: PUT /suite-api/api/notifications/rules with the id in the body.',
              'cp "$WORK/rule.json" "$HERE/rule-before-$(date +%Y%m%d-%H%M%S).json"',
              'jq --arg t "$TEMPLATE_ID" \'.templateId = $t\' "$WORK/rule.json" > "$WORK/rule-new.json"',
              'send PUT /suite-api/api/notifications/rules "$WORK/rule-new.json" >/dev/null || { echo "Created the template, but could not bind it to the rule." >&2; manual; exit 4; }',
              `echo "bound to ${ruleName.replace(/["$`\\]/g, '')}" | tee -a created-ids.txt`,
            ]
          : []),
        '',
      ].join('\n');

      const sendSample = sn
        ? serviceNowSample(endpoint, sampleFile)
        : webhookish
          ? [
              '#!/usr/bin/env bash',
              '# Post a filled-in sample to the endpoint, to test the receiving end.',
              'set -euo pipefail',
              `ENDPOINT="\${ENDPOINT:-${endpoint.replace(/["$`\\]/g, '\\$&')}}"`,
              'if [[ "${1:-}" == "--dry-run" ]]; then echo "DRY RUN: would POST the sample to $ENDPOINT"; exit 0; fi',
              `curl -sS -f -X POST "$ENDPOINT" -H "Content-Type: application/json" --data-binary @"$(dirname "$0")/${sampleFile}"`,
              'echo',
              'echo "Sent. Check it arrived and reads correctly before a rule depends on it."',
              '',
            ].join('\n')
          : '';

      return {
        platform: PLATFORM,
        title: `Alert payload for ${LABELS[destination] ?? destination}${ruleName ? `, bound to "${ruleName}"` : ''}`,
        effect: 'reversible',
        trigger: { kind: 'alert', detail: `Whatever notification rule uses the outbound instance "${plugin}"${ruleName ? ` — "${ruleName}"` : ''}`, worstCase: 'as often as that rule fires' },
        scope: {
          what: 'The body sent for every alert the notification rule matches.',
          decidedBy: ['The notification rule the template is bound to — this payload changes the shape, not the scope.'],
          ifWrong: 'The receiving end rejects it and nobody knows, because a rejected notification is logged on the sender and read by nobody.',
        },
        guardrails: [
          { rule: 'Tested with a sample before a real alert depends on it', because: 'A payload the receiver cannot parse fails silently on the sending side.' },
          { rule: 'apply-template.sh stops if the outbound instance or the rule does not exist, and keeps the rule as it was before binding', because: 'A template bound to the wrong rule reshapes somebody else’s notifications; the saved rule is the undo.' },
          ...(sn
            ? [
                { rule: 'send-sample.sh --dry-run prints the incident it would create and sends nothing; run it that way first', because: 'Each real run opens an incident in a queue somebody works; a test should not page the service desk by accident.' },
                { rule: 'Against the Table API, send-sample.sh refuses when an open incident already has the sample’s correlation_id', because: 'The Table API never deduplicates, so re-running a test would open a second incident for the same alert.' },
                { rule: 'The ServiceNow password is read from a mode-600 file (checked) and given to curl as a config on stdin', because: 'On a command line it would be visible to every user of the host through ps.' },
              ]
            : []),
        ],
        dryRun: [
          'apply-template.sh --dry-run checks the outbound instance and the rule and prints the template it would create.',
          ...(sn
            ? ['send-sample.sh --dry-run prints the sample and the endpoint and sends nothing; then point ENDPOINT at a sub-production instance and run it; check the incident, then close it.']
            : webhookish
              ? ['send-sample.sh posts a filled-in sample to the endpoint. Check it arrives, and arrives looking right.']
              : [`${sampleFile} is what one alert will look like. Use Test on the outbound instance to send one for real.`]),
        ],
        undo: [
          'Unbind the template from the rule (PUT the rule-before-*.json back), then delete the template under Payload Templates. Alerts go on being sent; they stop being sent in this shape.',
          ...(sn ? ['Close (or delete) the incident send-sample.sh created: its number and sys_id are printed when it is created.'] : []),
        ],
        told: [email ? 'The recipients on the notification rule, per alert.' : snmp ? 'The trap receiver on the outbound instance, per alert.' : `${endpoint || 'The endpoint'}, per alert.`],
        requires: [
          `The outbound instance "${plugin}" (${pluginType.replace('Plugin', ' plug-in')}).`,
          ...(ruleName ? [`The notification rule "${ruleName}".`] : []),
          sn ? 'A ServiceNow integration user with rights to create incidents, stored on the outbound instance — not in the payload.' : 'Whatever the receiving end needs to accept it.',
          'jq on the machine that runs the scripts.',
        ],
        files: {
          [templateFile]: templateBody,
          [sampleFile]: sampleBody,
          'apply-template.sh': applyTemplate,
          ...(sendSample ? { 'send-sample.sh': sendSample } : {}),
          'IMPORT.md': importMd({
            title: 'the payload template',
            steps: [
              {
                heading: 'The payload template, created and bound',
                files: [templateFile, 'apply-template.sh'],
                how: [
                  `./apply-template.sh (add --dry-run first) finds "${plugin}", creates the template "${templateName}" from ${templateFile}${ruleName ? `, and sets it on the rule "${ruleName}" (the rule is saved first)` : ''}.`,
                  'If the template API is refused (exit 4) it prints the steps: Configure → Alerts → Payload Templates → Add, the outbound method, paste the file; then select the template on the notification rule.',
                ],
                verify: ['POST /suite-api/api/notifications/payloadtemplates, its fields (name, pluginId, pluginType, payload) and binding by templateId on the rule: not in the published 9.1 API reference.', `which outbound methods take a payload template on your release (${pluginType}).`],
              },
              ...(sendSample ? [{ heading: 'Test the receiving end', files: [sampleFile, 'send-sample.sh'], how: ['./send-sample.sh posts the filled-in sample straight to the endpoint, without VCF Operations.'] }] : []),
            ],
          }),
        },
        notes: [
          'The ${...} fields are substituted by VCF Operations. If one arrives literally, it is not a field your version supports — check the list in the payload template editor.',
          ...(destination === 'runbook'
            ? ['9.1: ${SYMPTOMS} is now a structured JSON object (symptom sets, conditions and context), not a string. It must be the whole value of its own key — "symptoms": "${SYMPTOMS}" — and embedding it inside a longer string no longer works. VERIFY the object’s fields against a real alert: the sample uses definedOn, symptoms[] (name, resourceName, resourceId, metricName, messageInfo) and conditions[], as published examples show.']
            : []),
          ...(email ? ['The subject and the HTML body are separate fields of an email template; the recipients belong to the notification rule, not the template.'] : []),
          ...(snmp ? ['VERIFY: an SNMP trap’s layout is fixed by the VCF Operations MIB; the template chooses which alert fields go into it. Load the MIB on the receiver to read them.'] : []),
          ...(destination === 'slack' ? ['9.1 has a Slack outbound plug-in (webhook URL and channel on the instance). The same blocks body works for a Slack incoming webhook through the Webhook plug-in.'] : []),
          ...(sn
            ? [
                'For the Service-Now Notification plug-in, the instance itself maps alert fields to the incident; this body is for the Webhook plug-in pointed at ServiceNow, where you own the mapping.',
                'correlation_id carries the alert id, but the Table API (POST /api/now/table/incident) does not deduplicate on it: every post is a new incident, including the update and the cancel VCF Operations sends for the same alert. To get one incident per alert, point the outbound instance at an Import Set (POST /api/now/import/<staging table>) whose Transform Map coalesces on correlation_id, or at a Scripted REST API that updates the open incident.',
                'send-sample.sh needs the ServiceNow credential for a real Table API endpoint: SN_USER and SN_PASSWORD_FILE (the password, mode 600). The script checks the mode and passes user:password to curl as a config on stdin (curl -K -), never as an argument.',
                'The description uses real line breaks (\\n in the JSON), which ServiceNow shows as new lines. A literal backslash-n would show as the two characters.',
              ]
            : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_content_backup',
    platform: PLATFORM,
    label: 'Back up the content to git, nightly',
    group: 'Content',
    description:
      'Alert definitions, symptoms, recommendations, super metrics, custom groups and policies, pulled nightly as JSON and committed to a repository. The history of who changed which threshold is then a git log, and the content can be compared between environments or put back after a bad import.',
    inputs: [
      { id: 'repo_path', label: 'Repository folder', control: 'text', default: '/srv/vcfops-content', hint: 'A git working copy on the machine that runs this' },
      { id: 'environment', label: 'Environment name', control: 'text', default: 'production' },
      { id: 'push', label: 'Push after committing', control: 'toggle', default: true },
      { id: 'include_policies', label: 'Include policy exports', control: 'toggle', default: true },
      { id: 'runner', label: 'Scheduled on', control: 'select', options: [{ value: 'bash', label: 'Linux (cron)' }, { value: 'powershell', label: 'Windows (Task Scheduler)' }], default: 'bash' },
    ],
    automation: (values                 , name        )             => {
      const repo = str(values, 'repo_path', '/srv/vcfops-content');
      const env = slugOf(str(values, 'environment', 'production'), 'production');
      const push = bool(values, 'push', true);
      const policies = bool(values, 'include_policies', true);
      const runner = str(values, 'runner', 'bash');

      const types = [
        ['alertdefinitions', 'alertDefinitions'],
        ['symptomdefinitions', 'symptomDefinitions'],
        ['recommendations', 'recommendations'],
        ['supermetrics', 'superMetrics'],
        ['resources/groups', 'groups'],
      ]         ;

      const bash = readScript('vcf-operations', `Nightly backup of VCF Operations content (${env}) to ${repo}.`, [
        `REPO="${repo}"`,
        `OUT="$REPO/${env}"`,
        'mkdir -p "$OUT"',
        ...workDirLines(),
        ...PAGED_HELPERS,
        '',
        '# Every page of each list is read into a file first; only when the whole list',
        '# was read is the folder replaced, so an object deleted in VCF Operations shows',
        '# as a deletion in git and a failed read never empties the backup.',
        '# One file per object, sorted keys, so a diff is about the change and not the order.',
        ...types.flatMap(([path, key]) => [
          `get_all /suite-api/api/${path} ${key} "$WORK/${key}.json" || exit 2`,
          `rm -rf "$OUT/${key}" && mkdir -p "$OUT/${key}"`,
          `jq -c '.[]' "$WORK/${key}.json" > "$WORK/${key}.items"`,
          'while IFS= read -r item; do',
          `  id=$(jq -r '.id // .resourceKey.name' <<<"$item" | tr -c 'A-Za-z0-9._-' '_')`,
          `  jq -S . <<<"$item" > "$OUT/${key}/$id.json"`,
          `done < "$WORK/${key}.items"`,
          `echo "${key}: $(jq length "$WORK/${key}.json")"`,
        ]),
        ...(policies
          ? [
              '',
              'get_all /suite-api/api/policies policySummaries "$WORK/policies.json" || exit 2',
              'rm -rf "$OUT/policies" && mkdir -p "$OUT/policies"',
              'jq -r \'.[].id\' "$WORK/policies.json" > "$WORK/policy-ids.txt"',
              'while IFS= read -r id; do',
              `  curl -sS -f "https://\${VCFOPS_HOST}/suite-api/api/policies/export?id=$id" -H "${authHeader('vcf-operations')}" -o "$OUT/policies/$id.zip"`,
              'done < "$WORK/policy-ids.txt"',
            ]
          : []),
        '',
        'cd "$REPO"',
        'git add -A',
        'if git diff --cached --quiet; then',
        '  echo "No content changed."',
        '  exit 0',
        'fi',
        `git -c user.name="vcfops-backup" -c user.email="vcfops-backup@localhost" commit -q -m "VCF Operations content, ${env}, $(date +%F)"`,
        ...(push ? ['git push -q'] : []),
        'git log --stat -1 | head -30',
      ]);

      const ps = [
        '<#',
        '.SYNOPSIS',
        `    Nightly backup of VCF Operations content (${env}) to a git repository.`,
        '.DESCRIPTION',
        '    Reads only from VCF Operations. The token is',
        '    read from the VCFOPS_TOKEN environment variable, never from this file.',
        '#>',
        '[CmdletBinding()]',
        `param([string]$Repo = '${repo}')`,
        'Set-StrictMode -Version Latest',
        "$ErrorActionPreference = 'Stop'",
        "if (-not $env:VCFOPS_HOST) { throw 'Set VCFOPS_HOST' }",
        '# A token can be handed in; a scheduled task logs in for itself from a',
        '# password file that only its account can read (or a DPAPI-protected one).',
        '$token = $env:VCFOPS_TOKEN',
        'if (-not $token) {',
        "    if (-not $env:VCFOPS_USER -or -not $env:VCFOPS_PASSWORD_FILE) { throw 'Set VCFOPS_TOKEN, or VCFOPS_USER and VCFOPS_PASSWORD_FILE' }",
        '    $body = @{ username = $env:VCFOPS_USER; password = (Get-Content -Raw $env:VCFOPS_PASSWORD_FILE).TrimEnd() } | ConvertTo-Json',
        "    $token = (Invoke-RestMethod -Method Post -Uri \"https://$($env:VCFOPS_HOST)/suite-api/api/auth/token/acquire\" -ContentType 'application/json' -Body $body).token",
        '}',
        "$headers = @{ Authorization = \"OpsToken $token\"; Accept = 'application/json' }",
        `$out = Join-Path $Repo '${env}'`,
        '',
        `$types = @{ ${types.map(([path, key]) => `'${path}' = '${key}'`).join('; ')} }`,
        'foreach ($path in $types.Keys) {',
        '    $key = $types[$path]',
        '    $dir = Join-Path $out $key',
        '    New-Item -ItemType Directory -Force -Path $dir | Out-Null',
        '    # Every page, and stop rather than back up nothing when the list key is missing.',
        '    $items = @(); $page = 0; $size = 1000',
        '    do {',
        '        $resp = Invoke-RestMethod -Uri "https://$($env:VCFOPS_HOST)/suite-api/api/$($path)?page=$page&pageSize=$size" -Headers $headers',
        '        $prop = $resp.PSObject.Properties[$key]',
        '        $info = $resp.PSObject.Properties[\'pageInfo\']',
        '        if (-not $prop -and -not $info) { throw "No $key in the response from $path" }',
        '        $batch = if ($prop -and $null -ne $prop.Value) { @($prop.Value) } else { @() }',
        '        $items += $batch',
        '        $page++',
        '        $total = if ($info -and $info.Value.PSObject.Properties[\'totalCount\']) { [int]$info.Value.totalCount } else { -1 }',
        '    } while ($batch.Count -eq $size -and ($total -lt 0 -or $page * $size -lt $total))',
        '    Remove-Item -Recurse -Force $dir',
        '    New-Item -ItemType Directory -Force -Path $dir | Out-Null',
        '    foreach ($item in $items) {',
        "        $id = ($item.id, $item.resourceKey.name | Where-Object { $_ } | Select-Object -First 1) -replace '[^A-Za-z0-9._-]', '_'",
        '        $item | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 (Join-Path $dir "$id.json")',
        '    }',
        '}',
        '',
        'Push-Location $Repo',
        'try {',
        '    git add -A',
        '    git diff --cached --quiet',
        "    if ($LASTEXITCODE -eq 0) { Write-Output 'No content changed.'; return }",
        `    git -c user.name=vcfops-backup -c user.email=vcfops-backup@localhost commit -q -m "VCF Operations content, ${env}, $(Get-Date -Format yyyy-MM-dd)"`,
        ...(push ? ['    git push -q'] : []),
        '} finally { Pop-Location }',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Nightly content backup — ${env} to git`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Nightly, from cron or Task Scheduler', worstCase: 'once a night' },
        scope: {
          what: 'Custom content in VCF Operations: alert and symptom definitions, recommendations, super metrics, custom groups' + (policies ? ' and policies.' : '.'),
          decidedBy: ['What the token’s account can read. A read-only account sees everything this needs.'],
          ifWrong: 'Something is missing from the backup, and you find out the day you need it. Restore a file from it into a test instance once a quarter.',
        },
        guardrails: [
          { rule: 'Reads only, with a read-only account', because: 'A backup job holding an administrator token is a larger risk than the one it mitigates.' },
          { rule: 'Every list is read page by page and must be read whole before its folder is replaced; a failed read stops the run (exit 2)', because: 'A backup that silently wrote an empty folder would commit the deletion of every alert definition, and the history would say it was intended.' },
          { rule: 'One file per object, keys sorted', because: 'So the git history shows which threshold changed, not that a 4 MB export differs.' },
        ],
        dryRun: ['Run it once by hand into an empty repository and read the tree it produces.'],
        undo: ['Nothing to undo. To restore an object, POST its JSON back — without the id, which the target will assign.'],
        told: ['The git log. Point your repository’s notifications at a channel and every content change in VCF Operations becomes visible.'],
        requires: ['git and jq on the machine that runs it, and a working copy already cloned at ' + repo + '.', push ? 'Credentials for the push held by git’s own credential helper, not in the script.' : 'Nothing else.'],
        files: {
          ...(runner === 'powershell' ? { 'Backup-VcfOpsContent.ps1': ps } : { 'backup-content.sh': bash, 'crontab.txt': `# Nightly at 01:30. The script logs in for itself from the password file\n# (mode 600, owned by the job's user); no token or password is in this line.\n30 1 * * * cd ${repo} && ${scheduledEnv('vcf-operations', 'svc-vcfops-readonly')} /usr/local/bin/backup-content.sh >> /var/log/vcfops-backup.log 2>&1\n` }),
          'IMPORT.md': nothingToImportMd('the nightly content backup', [
            runner === 'powershell'
              ? 'Backup-VcfOpsContent.ps1 runs from Task Scheduler on a host of your own; it reads the API and writes JSON into the repository. Nothing is imported into VCF Operations.'
              : 'backup-content.sh goes in /usr/local/bin and crontab.txt in the service account’s crontab; it reads the API and writes JSON into the repository. Nothing is imported into VCF Operations.',
            'What it writes is the API’s GET responses, one folder per content type: a record of what changed and when, readable in a diff. It is not an import format. To put content back, POST the object to the same API path, or restore from a Content Management export (Administration → Control Panel → Content Management → Export, then Import) — which is the backup to keep for a rebuild.',
          ]),
        },
        notes: [
          'Tokens from /suite-api/api/auth/token/acquire expire after a few hours, so the job logs in for itself each run from VCFOPS_PASSWORD_FILE — a file only the job’s user can read. The password is sent on stdin, never on a command line.',
          'Committing two environments into one repository makes "what differs between test and production" a directory diff.',
        ],
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_self_health',
    platform: PLATFORM,
    label: 'Check that VCF Operations is still collecting',
    group: 'Health',
    description:
      'The failure nothing alerts on: VCF Operations itself stops collecting. A cloud proxy goes down, an adapter’s credential expires, and every alert in this kit goes quiet — which looks exactly like a healthy estate. This checks the nodes, the collectors and every adapter instance’s last collection, and exits non-zero so something outside VCF Operations can page.',
    inputs: [
      { id: 'stale_minutes', label: 'An adapter is stale after (minutes)', control: 'number', default: 30, min: 10, max: 1440 },
      { id: 'ignore_adapters', label: 'Ignore adapter instances named', control: 'text', default: '', hint: 'Ones that are known to be off' },
      { id: 'webhook', label: 'Post failures to', control: 'text', default: 'https://runbooks.example.com/hooks/vcfops-health', hint: 'Somewhere that is not VCF Operations' },
    ],
    automation: (values                 , name        )             => {
      const stale = num(values, 'stale_minutes', 30);
      const ignore = listOf(str(values, 'ignore_adapters', ''));
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'vcfops-health', 'vcfops-health');

      const findings            = [];
      if (/vcfops|aria|vrops/i.test(webhook) && !/hooks/i.test(webhook)) {
        findings.push(
          warning('vcfops.health.self-report', 'The failure report goes to VCF Operations, which is the thing that may have failed.', {
            remediation: 'Send it somewhere independent — a chat webhook, a pager, a different monitoring system.',
            source: SRC,
          }),
        );
      }
      if (stale < 15) {
        findings.push(warning('vcfops.health.tight', `A ${stale}-minute threshold is inside two collection cycles and will report a slow cycle as a failure.`, { source: SRC }));
      }

      const script = readScript('vcf-operations', 'Is VCF Operations itself healthy and collecting?', [
        `STALE_MS=$(( ${stale} * 60 * 1000 ))`,
        'NOW_MS=$(( $(date +%s) * 1000 ))',
        `IGNORE='${JSON.stringify(ignore)}'`,
        'PROBLEMS=()',
        '',
        ...workDirLines(),
        ...WEBHOOK_HELPER,
        '',
        '# Each answer is saved to a file first: a read that fails stops the check',
        '# (exit 2) instead of feeding an empty list into a loop that then finds',
        '# nothing wrong.',
        '# 1. The node answering this call.',
        'get /suite-api/api/deployment/node/status > "$WORK/node.json" || { echo "Cannot read the node status." >&2; exit 2; }',
        'NODE=$(jq -r ".status // \\"UNKNOWN\\"" "$WORK/node.json")',
        '[[ "$NODE" == "ONLINE" ]] || PROBLEMS+=("node status is $NODE")',
        '',
        '# 2. Collectors and cloud proxies.',
        'get /suite-api/api/collectors > "$WORK/collectors.json" || { echo "Cannot read the collectors." >&2; exit 2; }',
        '(( $(jq "[.collector[]?] | length" "$WORK/collectors.json") > 0 )) || PROBLEMS+=("no collectors listed at all")',
        'while read -r cname cstate; do',
        '  [[ "$cstate" == "UP" ]] || PROBLEMS+=("collector $cname is $cstate")',
        'done < <(jq -r ".collector[]? | \\"\\(.name|gsub(\\" \\";\\"_\\")) \\(.state)\\"" "$WORK/collectors.json")',
        '',
        '# 3. Every adapter instance: when did it last collect?',
        'get /suite-api/api/adapters > "$WORK/adapters.json" || { echo "Cannot read the adapter instances." >&2; exit 2; }',
        '(( $(jq "[.adapterInstancesInfoDto[]?] | length" "$WORK/adapters.json") > 0 )) || PROBLEMS+=("no adapter instances listed at all")',
        'while read -r aname last count; do',
        '  echo "$IGNORE" | jq -e --arg n "$aname" "index(\\$n)" >/dev/null && continue',
        '  if [[ "$last" == "null" ]] || (( NOW_MS - last > STALE_MS )); then',
        `    PROBLEMS+=("adapter $aname has not collected for more than ${stale} minutes")`,
        '  elif [[ "$count" == "0" ]]; then',
        '    PROBLEMS+=("adapter $aname is collecting nothing — check its credential")',
        '  fi',
        'done < <(jq -r ".adapterInstancesInfoDto[]? | \\"\\(.resourceKey.name|gsub(\\" \\";\\"_\\")) \\(.lastCollected) \\(.numberOfResourcesCollected // 0)\\"" "$WORK/adapters.json")',
        '',
        'if (( ${#PROBLEMS[@]} == 0 )); then',
        '  echo "VCF Operations: healthy"',
        '  exit 0',
        'fi',
        '',
        'printf "VCF Operations: %s\\n" "${PROBLEMS[@]}" >&2',
        ...(webhook
          ? [`printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "vcf-operations-health", problems: .}' > "$WORK/webhook.json"`, `post_webhook ${shq(webhook)} "$WORK/webhook.json"`]
          : []),
        'finish 1',
      ]);

      return {
        platform: PLATFORM,
        title: 'VCF Operations self-check — nodes, collectors and adapter freshness',
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Every 15 minutes, from a scheduler outside VCF Operations', worstCase: 'every 15 minutes while it is broken' },
        scope: {
          what: 'VCF Operations itself: the node that answers, every collector and cloud proxy, every adapter instance.',
          decidedBy: [ignore.length > 0 ? `Everything except ${ignore.join(', ')}.` : 'Every adapter instance — nothing is ignored.'],
          ifWrong: 'An adapter left on the ignore list after it was meant to come back fails silently. Review that list whenever it changes.',
        },
        guardrails: [
          { rule: 'Runs outside VCF Operations', because: 'A monitoring system cannot reliably report its own failure.' },
          { rule: 'Reports to an independent destination', because: 'Otherwise the failure report is queued behind the failure.' },
          { rule: 'A read that fails, or a collector or adapter list that comes back empty, is a failure (exit 2 or 1), never "healthy"', because: 'An API that answers nothing is exactly what a broken VCF Operations looks like.' },
          ...(webhook ? [{ rule: 'The webhook post uses curl -f and a failed post exits 3', because: 'A report that did not arrive must not look like one that did.' }] : []),
        ],
        dryRun: ['It only reads. Run it once by hand and check each adapter it names is one you expect.'],
        undo: ['Nothing to undo.'],
        told: webhook ? [`${webhook}, whenever a check fails.`] : ['The exit code only. Set a webhook, or have the scheduler alert on a non-zero exit.'],
        requires: ['jq and bash 4 on the machine that runs it.', 'A read-only VCF Operations account for the token.'],
        files: {
          [`${base}.sh`]: script,
          'crontab.txt': `# Every 15 minutes. The script logs in for itself from the password file\n# (mode 600); no token or password is in this line.\n*/15 * * * * ${scheduledEnv('vcf-operations', 'svc-vcfops-readonly')} /usr/local/bin/${base}.sh\n`,
          'IMPORT.md': nothingToImportMd('the VCF Operations self-health check', [`${base}.sh goes in /usr/local/bin on a host outside VCF Operations (it has to keep working when VCF Operations does not), and crontab.txt in the service account’s crontab. It only reads.`]),
        },
        notes: [
          'An adapter collecting zero objects is almost always an expired or changed credential, and it is the most common reason an estate goes quiet.',
          'Run the same check against every VCF Operations instance in the fleet; each one only knows about its own collectors.',
        ],
        findings,
      };
    },
  }),
];
