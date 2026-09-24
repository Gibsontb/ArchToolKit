/**
 * More onboarding: the parts of the estate the first onboarding blueprints
 * leave to a note.
 *
 * "Onboard the VCF / vSphere estate" gets ESXi, vCenter and the NSX Manager
 * nodes sending syslog, and says that SDDC Manager and VCF Automation reach
 * Splunk through VCF Operations for Logs. That is where most onboarding stops,
 * and it is not where the value is. For NSX the value is the distributed
 * firewall: every drop between two VMs is a packet log on the ESXi host that
 * enforced it, and those logs exist only for rules someone set to log. For the
 * VCF management components it is knowing that all of them are reporting,
 * when there is no add-on to tell you what any of their events mean.
 *
 * The automation platforms are the other half of "what you built": AWX and
 * Automation Platform run the playbooks, HCP Terraform runs the plans, and
 * both keep the only record of who changed what. Each has one supported way
 * out — the logging aggregator, the audit trail API — and each of those has a
 * credential that should never be on a command line or in a file Splunk reads.
 *
 * And Juniper, which "Onboard network devices" does not cover because the
 * Network page does not build Junos: the same SC4S route, the same
 * missing-device alert, the same shape of device file to paste.
 *
 * Every script here applies when run; --dry-run previews.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { INDEX_MEMORY } from '../choices.js';
import { splunkBlueprint,                      } from '../from-app.js';
import { defaultMeta, foldSearch, listOf, searchWindow, splunkName, spreadCron,                } from '../splunk.js';
import { appConfLines, csvCell, hostAddress, indexName, linesOf, splQuote } from './addon.js';

const TIER = 'addon'         ;
const GROUP = 'Onboard what you built';

// --- small helpers -----------------------------------------------------------

/** A value in single quotes for bash, with any single quote in it closed and reopened. */
function shq(value        )         {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Split "a | b | c" into its cells. */
function cells(line        )           {
  return line.split('|').map((c) => c.trim());
}

/** The syslog port for a transport on SC4S's default listeners. */
function sc4sPort(transport        )         {
  return transport === 'tls' ? 6514 : 514;
}

/** The alert settings every "something is silent / something happened" search here shares. */
function alertLines(name        , everyMinutes        , suppressField        , suppressPeriod        , email        , subject        )           {
  return [
    'enableSched = 1',
    `cron_schedule = ${spreadCron(name, everyMinutes)}`,
    'counttype = number of events',
    'relation = greater than',
    'quantity = 0',
    'alert.track = 1',
    'alert.severity = 4',
    '# One alert per result, then quiet for a while, rather than the same',
    '# result on every run.',
    'alert.digest_mode = 0',
    'alert.suppress = 1',
    `alert.suppress.fields = ${suppressField}`,
    `alert.suppress.period = ${suppressPeriod}`,
    ...(email ? ['action.email = 1', `action.email.to = ${email}`, `action.email.subject = ${subject}`] : []),
  ];
}

const SYSLOG_TRANSPORTS = [
  { value: 'tcp', label: 'TCP' },
  { value: 'tls', label: 'TLS' },
  { value: 'udp', label: 'UDP' },
];

const INFRA_INDEXES = [
  { value: 'infraops', label: 'infraops — SC4S default for infrastructure' },
  { value: 'vcf', label: 'vcf' },
  { value: 'nsx', label: 'nsx' },
  { value: 'netops', label: 'netops' },
  { value: 'main', label: 'main' },
];

// =============================================================================
// 1. NSX and the distributed firewall
// =============================================================================

/**
 * The fields of a DFW packet log line, for example
 *   INET match DROP 3048 IN 60 TCP 10.1.20.15/51514->10.1.30.7/443 S
 * Older releases write the rule as domain-c8/3048, ICMP has no ports.
 */
const DFW_REX =
  'rex field=_raw "(?<dfw_action>PASS|DROP|REJECT)\\s+(?:\\S+/)?(?<rule_id>\\d+)\\s+(?<direction>IN|OUT)\\s+\\d+\\s+(?<transport>[A-Za-z0-9]+)\\s+(?<src>[^\\s/>-]+)(?:/(?<src_port>\\d+))?->(?<dest>[^\\s/]+)(?:/(?<dest_port>\\d+))?"';

// =============================================================================
// 2. VCF management components
// =============================================================================

                                                                                          

const VCF_COMPONENTS                                         = {
  vcf_ops_logs: 'VCF Operations for Logs',
  sddc_manager: 'SDDC Manager',
  vcf_automation: 'VCF Automation',
  vcf_operations: 'VCF Operations',
};

/** Where the collector listens for the VCF forwarding destination. */
const VCF_LISTENERS                                                                                              = {
  udp514: { transport: 'udp', port: 514, label: 'UDP 514' },
  tcp514: { transport: 'tcp', port: 514, label: 'TCP 514' },
  tcp1514: { transport: 'tcp', port: 1514, label: 'TCP 1514' },
  tls6514: { transport: 'tls', port: 6514, label: 'TLS 6514' },
};

// =============================================================================
// 3. Ansible
// =============================================================================

const AWX_PRODUCTS                                                                            = {
  awx: { label: 'AWX', api: '/api/v2', verify: false },
  aap24: { label: 'Automation Platform 2.4 (automation controller)', api: '/api/v2', verify: false },
  aap25: { label: 'Automation Platform 2.5 and later (through the platform gateway)', api: '/api/controller/v2', verify: true },
};

const AWX_LOGGERS = [
  { value: 'awx', label: 'awx — the controller’s own log' },
  { value: 'activity_stream', label: 'activity_stream — who changed what' },
  { value: 'job_events', label: 'job_events — every task result of every job' },
  { value: 'system_tracking', label: 'system_tracking — gathered facts (large)' },
];

// =============================================================================
// 5. Juniper
// =============================================================================

                                             

const JUNOS_ROLES                                      = {
  srx: 'SRX firewall',
  ex: 'EX switch',
  qfx: 'QFX switch',
  mx: 'MX router',
};

                       
                        
                      
                                  
                       
 

function parseJunos(value        )                {
  return linesOf(value).map((line) => {
    const [name, ip, role] = cells(line);
    const r = String(role ?? '').toLowerCase();
    return {
      name: hostAddress(name) || splunkName(name ?? '', 'device'),
      ip: hostAddress(ip),
      role: r in JUNOS_ROLES ? (r             ) : null,
      raw: role ?? '',
    };
  });
}

/** The set commands that make one Junos device send its syslog to SC4S. */
function junosConfig(d                                   , target        , port        , transport        , ntp        )           {
  const srx = d.role === 'srx';
  return [
    `# ${d.name} (Juniper ${JUNOS_ROLES[d.role]}) — send syslog to ${target}:${port} over ${transport.toUpperCase()}`,
    '# Capture first, so the back-out is a paste:',
    '#   show configuration system syslog | display set',
    ...(srx ? ['#   show configuration security log | display set'] : []),
    '# Load with: configure private, load set terminal, paste this file, Ctrl-D,',
    '# show | compare, commit confirmed 10 — then commit once events arrive in',
    '# Splunk. Lines starting with # are comments to load set terminal (VERIFY',
    '# on your Junos release).',
    `set system ntp server ${ntp}`,
    '# UTC, and a time stamp with the year and milliseconds, so the indexer',
    '# never has to guess.',
    'set system time-zone UTC',
    'set system syslog time-format year millisecond',
    `set system syslog host ${target} any notice`,
    `set system syslog host ${target} authorization info`,
    `set system syslog host ${target} interactive-commands info`,
    `set system syslog host ${target} change-log info`,
    `set system syslog host ${target} port ${port}`,
    '# RFC 5424 with structured data: what SC4S parses Junos from most reliably.',
    `set system syslog host ${target} structured-data`,
    ...(transport !== 'udp'
      ? ['# TCP and TLS for system syslog need a recent Junos. VERIFY the transport', '# statement on your release.', `set system syslog host ${target} transport ${transport}`]
      : []),
    ...(srx
      ? [
          '# Security logs (sessions, IDP, screens) in stream mode: sent by the',
          '# data plane directly, in structured format.',
          'set security log mode stream',
          'set security log format sd-syslog',
          ...(d.ip ? [`set security log source-address ${d.ip}`] : ['# set security log source-address <this device’s management address>']),
          `set security log stream SPLUNK host ${target} port ${port}`,
          'set security log stream SPLUNK format sd-syslog',
          'set security log stream SPLUNK category all',
          `set security log transport protocol ${transport}`,
          ...(transport === 'tls' ? ['# TLS also needs a TLS profile: set security log transport tls-profile <name>. VERIFY.'] : []),
          '# A security policy logs only when it says so: add "then log session-close"',
          '# (and session-init on deny policies) to the policies you need. VERIFY the',
          '# stream host and transport statements on your Junos release.',
        ]
      : []),
    '# Back out:',
    `#   delete system syslog host ${target}`,
    ...(srx ? ['#   delete security log stream SPLUNK'] : []),
  ];
}

// =============================================================================
// The blueprints
// =============================================================================

export const ONBOARDING_MORE_BLUEPRINTS                             = [
  // ---------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_onboard_nsx',
    tier: TIER,
    label: 'Onboard NSX and its distributed firewall',
    group: GROUP,
    description:
      'NSX Manager syslog through SC4S as vmware:nsxlog:<program> into an infrastructure index, distributed firewall packet logs as vmware:nsxlog:dfwpktlogs into the firewall index, logging turned on for the chosen DFW policies through the NSX Policy API by a script that applies when run (--dry-run previews), and searches and an alert for what the firewall drops.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_nsx_onboarding' },
      { id: 'nsx_manager', label: 'NSX Manager (Policy API)', control: 'text', default: 'nsx01.example.com', hint: 'The cluster VIP or any Manager node — policy is cluster-wide' },
      { id: 'nsx_nodes', label: 'NSX Manager nodes', control: 'textarea', default: 'nsx01a.example.com\nnsx01b.example.com\nnsx01c.example.com', hint: 'Each node, not the VIP: the syslog exporter is set per node' },
      { id: 'sc4s_host', label: 'SC4S', control: 'text', default: 'sc4s01.example.com', hint: 'What NSX sends to — a VIP if there are several' },
      { id: 'transport', label: 'Transport', control: 'select', default: 'tcp', options: SYSLOG_TRANSPORTS },
      { id: 'level', label: 'Manager log level', control: 'select', default: 'INFO', options: [
        { value: 'INFO', label: 'INFO' },
        { value: 'NOTICE', label: 'NOTICE' },
        { value: 'WARNING', label: 'WARNING' },
        { value: 'ERR', label: 'ERR' },
      ] },
      { id: 'nsx_index', label: 'NSX index', control: 'combo', default: 'infraops', options: INFRA_INDEXES, offer: INDEX_MEMORY },
      { id: 'dfw_index', label: 'DFW packet log index', control: 'combo', default: 'netfw', options: [
        { value: 'netfw', label: 'netfw — SC4S default for firewalls' },
        { value: 'netops', label: 'netops' },
        { value: 'nsx', label: 'nsx' },
      ], offer: INDEX_MEMORY },
      {
        id: 'dfw_policies',
        label: 'DFW policies whose rules should log',
        control: 'textarea',
        default: 'app-tier\ndmz-inbound',
        hint: 'Policy API ids of security policies, one per line; * for every policy; empty to only report which rules do not log',
      },
      { id: 'drop_threshold', label: 'Alert when one source is dropped more than (per 15 minutes)', control: 'number', default: 200, min: 1, max: 1000000 },
      { id: 'alert_email', label: 'Alert email', control: 'text', default: '', placeholder: 'secops@example.com' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_nsx_onboarding'), 'org_nsx_onboarding');
      const manager = hostAddress(str(values, 'nsx_manager', ''));
      const nodes = linesOf(str(values, 'nsx_nodes', '')).map(hostAddress).filter(Boolean);
      const target = hostAddress(str(values, 'sc4s_host', ''));
      const transport = str(values, 'transport', 'tcp');
      const proto = transport === 'udp' ? 'UDP' : transport === 'tls' ? 'TLS' : 'TCP';
      const port = sc4sPort(transport);
      const level = str(values, 'level', 'INFO');
      const nsxIndex = indexName(str(values, 'nsx_index', 'infraops'), 'infraops');
      const dfwIndex = indexName(str(values, 'dfw_index', 'netfw'), 'netfw');
      const policyLines = linesOf(str(values, 'dfw_policies', ''));
      const allPolicies = policyLines.includes('*');
      const policies = allPolicies ? ['*'] : policyLines.filter((p) => /^[A-Za-z0-9_.-]+$/.test(p));
      const badPolicies = allPolicies ? [] : policyLines.filter((p) => !/^[A-Za-z0-9_.-]+$/.test(p));
      const threshold = Math.max(1, Math.round(num(values, 'drop_threshold', 200)));
      const email = str(values, 'alert_email', '');
      const findings            = [];

      if (!target) {
        findings.push(error('splunk.nsx-no-collector', 'The SC4S address is empty or not a host name or address, so there is nothing to send the NSX logs to.', { source: 'SC4S documentation' }));
      }
      if (!manager) {
        findings.push(error('splunk.nsx-no-manager', 'The NSX Manager address is empty or not a host name or address; the Policy API calls have nowhere to go.', { source: 'NSX API reference' }));
      }
      if (nodes.length === 0) {
        findings.push(
          warning('splunk.nsx-no-nodes', 'No NSX Manager nodes are listed, so no syslog exporter is set and the Manager logs (audit, policy changes, cluster health) are not sent. Only the DFW packet logs from the hosts will arrive.', {
            remediation: 'List each Manager node — not the cluster VIP, which reaches only one of them.',
            source: 'NSX API reference — /api/v1/node/services/syslog/exporters',
          }),
        );
      }
      if (transport === 'udp') {
        findings.push(
          warning('splunk.nsx-udp', 'UDP syslog for NSX: a busy distributed firewall writes a packet log line for every logged connection on every host, and UDP drops them with no record once a socket buffer fills — during a scan or an incident, which is when the drops matter.', {
            remediation: 'Use TCP, or TLS.',
            source: 'SC4S documentation',
          }),
        );
      }
      if (allPolicies) {
        findings.push(
          warning('splunk.nsx-log-every-rule', 'Every rule of every policy set to log, including the default rule at the bottom of the Application category: every connection in the data centre becomes a packet log line on the host that allowed it. On a busy cluster that is millions of events an hour, host CPU spent writing them, and licence spent on allowed traffic nobody reads.', {
            remediation: 'List the policies whose drops matter — the DMZ, the tier boundaries, the default deny — and leave allow-everything rules quiet.',
            source: 'NSX distributed firewall documentation',
          }),
        );
      }
      if (badPolicies.length > 0) {
        findings.push(
          warning('splunk.nsx-policy-id', `${badPolicies.length} polic${badPolicies.length === 1 ? 'y id is' : 'y ids are'} not a Policy API id and are left out: ${badPolicies.join(', ')}. The id is the last part of the policy path (/infra/domains/default/security-policies/<id>), not its display name.`, {
            source: 'NSX Policy API reference',
          }),
        );
      }

      const tgt = target || '<sc4s>';
      const mgr = manager || '<nsx-manager>';
      const dfwBase = `index=${dfwIndex} sourcetype="vmware:nsxlog:dfwpktlogs"`;
      const byRule = 'NSX DFW - drops by rule - last 24 hours';
      const alertName = `NSX DFW - source dropped more than ${threshold} times in 15 minutes`;
      const managerReport = 'NSX - Manager log volume by program - last 24 hours';
      const window = searchWindow(15);

      const script           = [
        '#!/usr/bin/env bash',
        '# NSX to Splunk: a syslog exporter on each Manager node, and logging on the',
        '# rules of the chosen distributed firewall policies through the Policy API.',
        '# Applies when run; --dry-run previews. --undo <file> turns logging back off',
        '# on the rules a previous run listed in that file.',
        '#',
        '# Credentials: a curl netrc file, mode 600, never on a command line, with a',
        '# machine line for the Policy API address and one for each Manager node:',
        `#   ~/.vcf/nsx.netrc   machine ${mgr} login admin password ...`,
        '# CACERT=<bundle> to verify the NSX certificates.',
        '#',
        '# Usage: bash nsx-syslog.sh [--dry-run] [--undo rules-logged-<time>.txt]',
        'set -euo pipefail',
        'EXECUTE=1; UNDO=""',
        'while [[ $# -gt 0 ]]; do',
        '  case "$1" in',
        '    --dry-run) EXECUTE=0; shift ;;',
        '    --undo) UNDO="$2"; shift 2 ;;',
        '    *) echo "unknown option: $1" >&2; exit 2 ;;',
        '  esac',
        'done',
        'NETRC="${NSX_NETRC:-$HOME/.vcf/nsx.netrc}"',
        `NSX=${shq(mgr)}`,
        `TARGET=${shq(tgt)}`,
        `PORT=${port}`,
        `PROTOCOL=${shq(proto)}`,
        `LEVEL=${shq(level)}`,
        `NODES=(${nodes.map(shq).join(' ')})`,
        `POLICIES=(${policies.map(shq).join(' ')})`,
        '',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }',
        '[[ -f "$NETRC" ]] || { echo "Missing $NETRC" >&2; exit 1; }',
        '[[ "$(stat -c %a "$NETRC")" == "600" ]] || { echo "$NETRC must be mode 600" >&2; exit 1; }',
        'CURL=(curl --silent --show-error --fail --netrc-file "$NETRC")',
        '[[ -n "${CACERT:-}" ]] && CURL+=(--cacert "$CACERT")',
        'API="https://$NSX/policy/api/v1/infra/domains/default/security-policies"',
        'FAILED=()',
        '',
        '# One rule, as the Policy API returns it, with logged set and the read-only',
        '# _fields dropped, PATCHed back whole so nothing else about the rule',
        '# changes. VERIFY on NSX 9.x.',
        'set_logged() {',
        '  local policy="$1" rule="$2" value="$3" body',
        `  body="$("\${CURL[@]}" "$API/$policy/rules/$rule" | jq -c --argjson v "$value" 'with_entries(select(.key | startswith("_") | not)) | .logged = $v')" || return 1`,
        '  "${CURL[@]}" -X PATCH -H "Content-Type: application/json" -d "$body" "$API/$policy/rules/$rule" >/dev/null',
        '}',
        '',
        'if [[ -n "$UNDO" ]]; then',
        '  [[ -f "$UNDO" ]] || { echo "Missing $UNDO" >&2; exit 1; }',
        '  while IFS=/ read -r policy rule; do',
        '    [[ -n "$policy" && -n "$rule" ]] || continue',
        '    if (( EXECUTE )); then',
        '      if set_logged "$policy" "$rule" false; then echo "$policy/$rule no longer logs"; else FAILED+=("$policy/$rule"); fi',
        '    else',
        '      echo "DRY RUN: $policy/rules/$rule logged -> false"',
        '    fi',
        '  done < "$UNDO"',
        '  if (( ${#FAILED[@]} > 0 )); then printf \'Not undone: %s\\n\' "${FAILED[@]}" >&2; exit 1; fi',
        '  exit 0',
        'fi',
        '',
        '# --- 1. A syslog exporter on each Manager node (node API) -------------------',
        '# /api/v1/node/services/syslog/exporters configures the node it is sent to,',
        '# so every node, not the VIP. An exporter already pointing at the target is',
        '# left alone — the vSphere onboarding script sets the same one. Edges: the',
        '# same path under /api/v1/transport-nodes/<edge-id>/node/, or',
        '# "set logging-server" on the edge CLI. TLS exporters also need tls_ca_pem.',
        '# VERIFY on NSX 9.x.',
        'for node in ${NODES[@]+"${NODES[@]}"}; do',
        '  echo "== Manager node $node"',
        '  if ! current="$("${CURL[@]}" "https://$node/api/v1/node/services/syslog/exporters")"; then',
        '    FAILED+=("exporter on $node"); continue',
        '  fi',
        `  if jq -e --arg h "$TARGET" 'any(.results[]?; .server == $h)' <<<"$current" >/dev/null; then`,
        '    echo "   already exporting to $TARGET"; continue',
        '  fi',
        `  body="$(jq -nc --arg h "$TARGET" --argjson p "$PORT" --arg proto "$PROTOCOL" --arg lvl "$LEVEL" '{exporter_name: "splunk_sc4s", server: $h, port: $p, protocol: $proto, level: $lvl}')"`,
        '  if (( EXECUTE )); then',
        '    if "${CURL[@]}" -X POST -H "Content-Type: application/json" -d "$body" "https://$node/api/v1/node/services/syslog/exporters" >/dev/null; then',
        '      echo "   exporter added"',
        '    else',
        '      FAILED+=("exporter on $node")',
        '    fi',
        '  else',
        '    echo "   DRY RUN: POST /api/v1/node/services/syslog/exporters $body"',
        '  fi',
        'done',
        '',
        '# --- 2. Logging on distributed firewall rules (Policy API) ------------------',
        '# Only rules that do not already log are changed; each one is written to',
        '# rules-logged-<time>.txt, which --undo reads.',
        'if [[ "${POLICIES[*]:-}" == "*" ]]; then',
        `  mapfile -t POLICIES < <("\${CURL[@]}" "$API" | jq -r '.results[]?.id')`,
        'fi',
        'BACKOUT="rules-logged-$(date +%Y%m%d%H%M%S).txt"',
        'for policy in ${POLICIES[@]+"${POLICIES[@]}"}; do',
        '  if ! rules="$("${CURL[@]}" "$API/$policy/rules")"; then',
        '    echo "== policy $policy: not found or not readable" >&2; FAILED+=("policy $policy"); continue',
        '  fi',
        `  mapfile -t quiet < <(jq -r '.results[]? | select(.logged != true) | .id' <<<"$rules")`,
        '  echo "== policy $policy: ${#quiet[@]} rule(s) not logging"',
        '  for rule in ${quiet[@]+"${quiet[@]}"}; do',
        '    if (( EXECUTE )); then',
        '      if set_logged "$policy" "$rule" true; then echo "$policy/$rule" >> "$BACKOUT"; echo "   $rule now logs"; else FAILED+=("rule $policy/$rule"); fi',
        '    else',
        '      echo "   DRY RUN: $policy/rules/$rule logged -> true"',
        '    fi',
        '  done',
        'done',
        'if [[ -f "$BACKOUT" ]]; then echo "Rules changed: $BACKOUT (bash nsx-syslog.sh --undo $BACKOUT)"; fi',
        'if (( ${#FAILED[@]} > 0 )); then printf \'Not done: %s\\n\' "${FAILED[@]}" >&2; exit 1; fi',
      ];

      const dropsByRule = [
        `${dfwBase} earliest=-24h (DROP OR REJECT)`,
        '| `nsx_dfw_fields`',
        '| where action="blocked"',
        '| stats count, dc(src) as sources, dc(dest) as destinations, values(dest_port) as dest_ports, latest(_time) as last_seen by rule_id, direction, host',
        '| eval last_seen=strftime(last_seen, "%F %T")',
        '| sort - count',
      ];
      const dropsAlert = [
        `${dfwBase} earliest=${window.earliest} latest=${window.latest} (DROP OR REJECT)`,
        '| `nsx_dfw_fields`',
        '| where action="blocked"',
        '| stats count as drops, dc(dest) as destinations, values(dest_port) as dest_ports, values(rule_id) as rules by src',
        `| where drops > ${threshold}`,
        '| sort - drops',
      ];

      return {
        tier: TIER,
        title: `Onboard NSX: Manager logs into ${nsxIndex}, DFW packet logs into ${dfwIndex}, through SC4S`,
        app,
        activation: 'reload',
        notes: [
          `SC4S sourcetypes NSX syslog vmware:nsxlog:<program> into ${nsxIndex}, and the distributed firewall packet logs vmware:nsxlog:dfwpktlogs into ${dfwIndex}. ops/sc4s/splunk_metadata.csv sets both indexes.`,
          'The DFW packet logs are written by each ESXi host that enforces the rule, not by NSX Manager, and they leave through the host’s own syslog (Syslog.global.logHost). The hosts must send to SC4S — "Onboard the VCF / vSphere estate" sets that — or no packet log reaches Splunk however the rules are set.',
          'A rule writes packet logs only when its logging is on. ops/nsx-syslog.sh turns it on for the rules of the listed policies through the Policy API, writes the rules it changed to rules-logged-<time>.txt, and --undo that file turns them off again. It also adds the SC4S exporter on each Manager node, skipping any node that already has it.',
          'Add-on: VMware NSX add-on (Splunkbase 6805) maps NSX syslog to the CIM, including IDS. It is not built or supported by Splunk. Install it on the search heads if you want Network_Traffic and Intrusion_Detection from NSX; the searches in this app do not need it, because the nsx_dfw_fields macro extracts what they read.',
          'VERIFY: the packet log line format differs between NSX releases (the rule is written as 3048 or domain-c8/3048, and ICMP has no ports). Run the first verify search and check that rule_id, src and dest are populated before trusting the alert.',
          `The alert "${alertName}" runs every 15 minutes and returns each source dropped more than ${threshold} times; one alert per source, then quiet for an hour.`,
          `Create the indexes first: ${[...new Set([nsxIndex, dfwIndex])].join(', ')}.`,
        ],
        before: [
          `| rest /services/data/indexes | search title IN (${[...new Set([nsxIndex, dfwIndex])].join(', ')}) | table title, splunk_server`,
          'bash ops/nsx-syslog.sh --dry-run   # the current exporters on each node, and which rules of each policy do not log',
          `curl -s --netrc-file ~/.vcf/nsx.netrc https://${mgr}/policy/api/v1/infra/domains/default/security-policies | jq -r '.results[] | [.id, .display_name, .category] | @tsv'   # the policy ids to list`,
          `esxcli system syslog config get   # on an ESXi host: Remote Host includes ${tgt}`,
        ],
        files: {
          'default/app.conf': appConfLines(app, 'NSX onboarding', 'NSX Manager and distributed firewall searches'),
          'default/macros.conf': [
            '# The fields of a DFW packet log line, for the searches in this app. The',
            '# VMware NSX add-on (Splunkbase 6805) extracts its own; this works without it.',
            '[nsx_dfw_fields]',
            `definition = ${DFW_REX} | eval action=case(dfw_action=="PASS", "allowed", in(dfw_action, "DROP", "REJECT"), "blocked"), transport=lower(transport)`,
            'iseval = 0',
          ],
          'default/savedsearches.conf': [
            `[${byRule}]`,
            'description = Every DFW rule that dropped or rejected traffic in the last 24 hours, with how many sources and destinations it affected and on which hosts.',
            ...foldSearch(dropsByRule),
            'dispatch.earliest_time = -24h',
            'dispatch.latest_time = now',
            'enableSched = 0',
            '',
            `[${alertName}]`,
            `description = Each source address the distributed firewall dropped more than ${threshold} times in 15 minutes: a scan, a misconfigured application, or a rule that is wrong.`,
            ...foldSearch(dropsAlert),
            `dispatch.earliest_time = ${window.earliest}`,
            `dispatch.latest_time = ${window.latest}`,
            ...alertLines(alertName, 15, 'src', '1h', email, 'NSX DFW drops from $result.src$'),
            '',
            `[${managerReport}]`,
            'description = NSX Manager and Edge events by host and program: a node that is missing here is not exporting.',
            ...foldSearch([`| tstats count, latest(_time) as last_seen where index=${nsxIndex} sourcetype=vmware:nsxlog:* earliest=-24h by host, sourcetype`, '| eval last_seen=strftime(last_seen, "%F %T")', '| sort host, - count']),
            'dispatch.earliest_time = -24h',
            'dispatch.latest_time = now',
            'enableSched = 0',
          ],
          'metadata/default.meta': defaultMeta(),
          'ops/sc4s/splunk_metadata.csv': [
            '# Merge into /opt/sc4s/local/context/splunk_metadata.csv, then restart SC4S.',
            '# SC4S defaults are infraops for NSX and netfw for the packet logs; these',
            '# lines make the choice explicit. VERIFY the key names against the SC4S',
            '# version you run.',
            `vmware_vsphere_nsx,index,${nsxIndex}`,
            `vmware_vsphere_nsxfw,index,${dfwIndex}`,
          ],
          ...(transport === 'tls'
            ? { 'ops/sc4s/env_file.snippet': ['# Add to /opt/sc4s/env_file, then restart SC4S.', '# TLS listens on 6514; the certificate goes in /opt/sc4s/tls/. VERIFY for your SC4S version.', 'SC4S_SOURCE_TLS_ENABLE=yes'] }
            : {}),
          'ops/nsx-syslog.sh': script,
        },
        verify: [
          `${dfwBase} earliest=-15m | \`nsx_dfw_fields\` | stats count by dfw_action, host | sort - count   # every enforcing host appears; rule_id, src, dest populated`,
          `${dfwBase} earliest=-15m | \`nsx_dfw_fields\` | where isnull(rule_id) | head 5   # nothing: the format matches this NSX release`,
          `| savedsearch "${managerReport}"`,
          `| savedsearch "${byRule}"`,
          'bash ops/nsx-syslog.sh --dry-run   # every node already exporting, every listed rule already logging',
        ],
        backout: [
          'bash ops/nsx-syslog.sh --undo rules-logged-<time>.txt   # logging off again on exactly the rules the run turned on',
          'NSX: DELETE /api/v1/node/services/syslog/exporters/splunk_sc4s on each Manager node',
          `Remove ${app} from the search heads, and the ops/sc4s entries from SC4S (restart it)`,
          '# Events already indexed stay until the index retention removes them.',
        ],
        findings,
      };
    },
  }),

  // ---------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_onboard_vcf_management',
    tier: TIER,
    label: 'Onboard VCF Operations for Logs, SDDC Manager and VCF Automation',
    group: GROUP,
    description:
      'The VCF management components into Splunk as syslog: forwarded from VCF Operations for Logs (VCF 9.1 log management forwarding in VCF Operations) to SC4S or a heavy forwarder on 514, 1514 or 6514 (TLS), host names taken from the syslog header, a lookup of which host is which component, and an alert for any component that stops reporting.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_vcf_management_onboarding' },
      {
        id: 'components',
        label: 'Components',
        control: 'textarea',
        default: 'vcfops-logs01.example.com | vcf_ops_logs\nsddc01.example.com | sddc_manager\nvcfa01.example.com | vcf_automation\nvcfops01.example.com | vcf_operations',
        hint: `host | component — component is ${Object.keys(VCF_COMPONENTS).join(', ')}`,
      },
      { id: 'collector', label: 'Collected by', control: 'select', default: 'sc4s', options: [
        { value: 'sc4s', label: 'Splunk Connect for Syslog (SC4S)' },
        { value: 'hf', label: 'Heavy forwarder' },
      ] },
      { id: 'collector_host', label: 'Collector', control: 'text', default: 'sc4s01.example.com', hint: 'The destination host in the VCF forwarding settings' },
      { id: 'listener', label: 'Protocol and port', control: 'select', default: 'tcp514', options: Object.entries(VCF_LISTENERS).map(([value, l]) => ({ value, label: l.label })) },
      { id: 'index', label: 'Index', control: 'combo', default: 'infraops', options: INFRA_INDEXES, offer: INDEX_MEMORY },
      { id: 'sourcetype', label: 'Sourcetype', control: 'combo', default: 'vcf:syslog', options: [
        { value: 'vcf:syslog', label: 'vcf:syslog' },
        { value: 'syslog', label: 'syslog' },
      ], hint: 'No add-on defines one; this name is yours' },
      { id: 'silent_minutes', label: 'Alert when a component is silent for (minutes)', control: 'number', default: 60, min: 5, max: 10080 },
      { id: 'alert_email', label: 'Alert email', control: 'text', default: '', placeholder: 'vcf-ops@example.com' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_vcf_management_onboarding'), 'org_vcf_management_onboarding');
      const collector = str(values, 'collector', 'sc4s');
      const target = hostAddress(str(values, 'collector_host', ''));
      const listener = VCF_LISTENERS[str(values, 'listener', 'tcp514')] ?? VCF_LISTENERS['tcp514'] ;
      const index = indexName(str(values, 'index', 'infraops'), 'infraops');
      const st = str(values, 'sourcetype', 'vcf:syslog').toLowerCase().replace(/[^a-z0-9:_.-]+/g, '_') || 'vcf:syslog';
      const silent = Math.max(5, Math.round(num(values, 'silent_minutes', 60)));
      const email = str(values, 'alert_email', '');
      const findings            = [];

      const rows = linesOf(str(values, 'components', '')).map((line) => {
        const [host, component] = cells(line);
        const c = String(component ?? '').toLowerCase();
        return { host: hostAddress(host).toLowerCase(), component: c in VCF_COMPONENTS ? (c                ) : null, raw: line };
      });
      const known = rows.filter((r)                                                              => r.host !== '' && r.component !== null);
      const rejected = rows.filter((r) => r.host === '' || r.component === null);

      if (!target) {
        findings.push(error('splunk.vcf-no-collector', 'The collector address is empty or not a host name or address; the VCF forwarding destination needs one.', { source: 'VCF Operations for Logs documentation' }));
      }
      if (collector === 'hf' && listener.port < 1024) {
        findings.push(
          error('splunk.vcf-hf-low-port', `A heavy forwarder cannot listen on ${listener.port}: ports below 1024 need root, and Splunk 10 runs as its own non-root user (running as root needs --run-as-root, which this does not generate). The input would fail to bind and nothing would arrive.`, {
            remediation: 'Use TCP 1514 or TLS 6514 on the heavy forwarder, or SC4S, which is built to listen on 514.',
            source: 'Splunk Enterprise 10.x installation manual — running Splunk as a non-root user',
          }),
        );
      }
      if (listener.transport === 'udp') {
        findings.push(
          warning('splunk.vcf-udp', 'UDP from VCF Operations for Logs: the forwarder sends everything it received from every component down one stream, and UDP drops lines with no record once a buffer fills — at an upgrade or an outage, which is when these logs are read.', {
            remediation: 'Use TCP 1514, or TLS 6514.',
            source: 'VCF Operations for Logs documentation — log forwarding',
          }),
        );
      }
      if (rejected.length > 0) {
        findings.push(
          warning('splunk.vcf-component-unknown', `${rejected.length} line${rejected.length === 1 ? ' is' : 's are'} left out: ${rejected.map((r) => `"${r.raw}"`).join(', ')}. They are not in the lookup, so their events get no component and the silent-component alert does not watch them.`, {
            remediation: `Write each as "host | component", with component one of ${Object.keys(VCF_COMPONENTS).join(', ')}.`,
            source: 'VCF 9.1 architecture — management components',
          }),
        );
      }
      if (rows.length === 0) findings.push(warning('splunk.vcf-no-components', 'No components listed: nothing is expected, so the silent-component alert never fires.', { source: 'VCF 9.1 architecture — management components' }));

      const tgt = target || '<collector>';
      const proto = listener.transport === 'udp' ? 'UDP' : 'TCP';
      const alertName = `VCF management component silent for ${silent} minutes`;
      const errorsReport = 'VCF management - errors by component - last 24 hours';
      const stName = splunkName(st, 'vcf_syslog');

      const alertSearch = [
        '| inputlookup expected_vcf_components.csv',
        '| eval key=lower(mvindex(split(host, "."), 0))',
        `| join type=left key [| tstats latest(_time) as last_seen where index=${index} earliest=-7d by host | eval key=lower(mvindex(split(host, "."), 0)) | stats max(last_seen) as last_seen by key]`,
        `| where isnull(last_seen) OR last_seen < relative_time(now(), "-${silent}m")`,
        '| eval last_seen=if(isnull(last_seen), "not in 7 days", strftime(last_seen, "%Y-%m-%d %H:%M:%S %Z"))',
        '| table host, component, last_seen',
      ];
      const errorsSearch = [
        `index=${index} sourcetype=${splQuote(st)} earliest=-24h (ERROR OR FATAL OR CRITICAL OR Exception)`,
        '| stats count, latest(_time) as last_seen by component, host, vcf_app',
        '| eval last_seen=strftime(last_seen, "%F %T")',
        '| sort - count',
      ];

      const forwarding = [
        'VCF 9.1: forward the management components to Splunk',
        '',
        'SDDC Manager, VCF Operations and VCF Automation send their logs to VCF',
        'Operations for Logs; none of them has a supported syslog destination of its',
        'own. Splunk gets them from a forwarding destination on VCF Operations for',
        'Logs. VERIFY: there is no Splunk add-on for any of these components, so',
        `the events arrive as plain syslog (${st}) and nothing maps them to the CIM.`,
        '',
        '1. In VCF Operations, open log management and its forwarding settings',
        '   (VERIFY the menu path on your 9.1 build), and add a destination:',
        '     Name:       splunk',
        `     Host:       ${tgt}`,
        '     Protocol:   Syslog. Not CFAPI — that is VMware’s own protocol between',
        '                 its log nodes, and neither SC4S nor Splunk speaks it.',
        `     Transport:  ${proto}`,
        `     Port:       ${listener.port}`,
        `     SSL:        ${listener.transport === 'tls' ? 'on — the collector certificate’s CA must be trusted by VCF Operations for Logs' : 'off'}`,
        '2. Filter the destination to the management components below. If ESXi,',
        '   vCenter and NSX already reach Splunk directly ("Onboard the VCF /',
        '   vSphere estate"), leave them out here, or every one of their events is',
        '   indexed twice.',
        ...known.map((k) => `     ${k.host.padEnd(36)}${VCF_COMPONENTS[k.component]}`),
        '3. Save, and use the destination’s test to send a message. It should',
        '   appear within a minute (see the verify searches).',
        '',
        'The same destination as code: the "Forward filtered logs out of VCF',
        'Operations (9.1)" blueprint (vcflog91_forwarding) on the Automation and',
        'Operations page.',
        '',
        'VERIFY: whether the forwarded lines are RFC 5424 or RFC 3164, and whether',
        'they keep the original host name in the header. props.conf in this app',
        'takes the host from either header; if the forwarder rewrites it to its own',
        'name, every event shows the VCF Operations for Logs node as its host.',
      ];

      const bySourceParser = collector === 'sc4s' && known.length > 0;
      const parserName = `app-vps-${splunkName(app, 'org')}-vmware_vcf`;
      const sc4sFiles                           =
        collector === 'sc4s'
          ? {
              'ops/sc4s/splunk_metadata.csv': [
                '# Merge into /opt/sc4s/local/context/splunk_metadata.csv, then restart SC4S.',
                '# The key is the vendor_product the app-parser below sets. VERIFY that',
                '# your SC4S version applies a sourcetype override to a source identified',
                '# only by sender; if not, the events arrive in SC4S’s default syslog',
                '# sourcetype and the searches here need that name instead.',
                `vmware_vcf,index,${index}`,
                `vmware_vcf,sourcetype,${st}`,
              ],
              ...(bySourceParser
                ? {
                    [`ops/sc4s/app_parsers/${parserName}.conf`]: [
                      `# Copy to /opt/sc4s/local/config/app_parsers/${parserName}.conf, then restart SC4S.`,
                      '# The VCF management components cannot be told apart from their messages,',
                      '# so SC4S identifies them by sender: vendor vmware, product vcf. The SC4S',
                      '# docs show both app_parsers and app-parsers for this directory — VERIFY',
                      '# which your version reads.',
                      `application ${parserName}[sc4s-vps] {`,
                      '    filter {',
                      ...known.map((k, i) => `        ${i > 0 ? 'or ' : ''}host("${k.host.split('.')[0]}*" type(glob))`),
                      '    };',
                      '    parser {',
                      '        p_set_netsource_fields(',
                      "            vendor('vmware')",
                      "            product('vcf')",
                      '        );',
                      '    };',
                      '};',
                    ],
                  }
                : {}),
              ...(listener.port !== 514 || listener.transport === 'tls'
                ? {
                    'ops/sc4s/env_file.snippet': [
                      '# Add to /opt/sc4s/env_file, then restart SC4S.',
                      ...(listener.transport === 'tls'
                        ? ['# TLS listens on 6514; the certificate goes in /opt/sc4s/tls/.', 'SC4S_SOURCE_TLS_ENABLE=yes']
                        : ['# 514 is the default listener; add 1514 beside it. VERIFY the variable', '# takes a list on your SC4S version.', `SC4S_LISTEN_DEFAULT_${listener.transport === 'udp' ? 'UDP' : 'TCP'}_PORT=514,${listener.port}`]),
                    ],
                  }
                : {}),
            }
          : {};

      const stanza = listener.transport === 'udp' ? `[udp://${listener.port}]` : listener.transport === 'tls' ? `[tcp-ssl:${listener.port}]` : `[tcp://${listener.port}]`;
      const hfInputs           = [
        '# The VCF forwarding destination, on the heavy forwarders only. Deploy as its',
        '# own app: a listener on a search head is a port nobody meant to open.',
        stanza,
        `sourcetype = ${st}`,
        `index = ${index}`,
        '# The sender is VCF Operations for Logs; props.conf takes the real host from',
        '# the syslog header.',
        'connection_host = dns',
        ...(listener.transport === 'udp' ? ['no_appending_timestamp = true'] : []),
        '# A disk queue for when the indexers push back.',
        'queueSize = 10MB',
        'persistentQueueSize = 5GB',
        ...(listener.transport === 'tls'
          ? [
              '',
              '[SSL]',
              '# The key password, if any, goes in local/inputs.conf on the host.',
              'serverCert = $SPLUNK_HOME/etc/auth/mycerts/syslog-server.pem',
              '# VCF Operations for Logs does not present a client certificate.',
              'requireClientCert = false',
              'sslVersions = tls1.2, tls1.3',
            ]
          : []),
      ];

      return {
        tier: TIER,
        title: `Onboard ${known.length} VCF management component${known.length === 1 ? '' : 's'} into ${index} as ${st}`,
        app,
        activation: collector === 'hf' ? 'restart' : 'bundle',
        notes: [
          'VERIFY: there is no Splunk add-on for VCF Operations for Logs, SDDC Manager, VCF Operations or VCF Automation. The events are syslog; this app gives them a host, a component and a searchable app name, and nothing more.',
          `In VCF 9.1 the components already send to VCF Operations for Logs. ops/VCF_FORWARDING.txt is the forwarding destination to add there: ${tgt}, ${listener.label}, protocol Syslog (not CFAPI).`,
          collector === 'sc4s'
            ? `SC4S on ${tgt}: ${listener.label}. ops/sc4s/ holds the app-parser that identifies the components by sender and the index and sourcetype overrides (VERIFY — see the comment in splunk_metadata.csv).`
            : `Heavy forwarder on ${tgt}: ops/heavy_forwarder/inputs.conf opens ${listener.label}. Deploy it as a separate app to the heavy forwarders only.`,
          `The index (${index}) follows SC4S’s convention of infraops for infrastructure syslog; VERIFY it is the one your SC4S uses for these, or set it in the override.`,
          'This app goes to the tier that parses (the heavy forwarder, or the indexers behind SC4S) for the host extraction, and to the search heads for the component lookup and the searches.',
          `The alert "${alertName}" compares lookups/expected_vcf_components.csv with what has arrived, by short host name. Keep the CSV current as nodes are added or retired.`,
        ],
        before: [
          `| rest /services/data/indexes | search title=${index} | table title, splunk_server`,
          collector === 'sc4s' ? `ss -ltnup | grep -E ':(514|${listener.port})\\b'   # on ${tgt}: SC4S listening` : `ss -ltnup | grep -E ':${listener.port}\\b'   # on ${tgt}: nothing already on the port`,
          `nc -vz ${tgt} ${listener.port}   # from the VCF Operations for Logs node: the collector is reachable`,
          `index=${index} sourcetype=${splQuote(st)} earliest=-24h | head 1   # nothing yet under this name, or plan for the old events`,
        ],
        files: {
          'default/app.conf': appConfLines(app, 'VCF management onboarding', 'VCF management components: host extraction, component lookup and the silent-component alert'),
          'default/props.conf': [
            `# ${st}: syslog forwarded by VCF Operations for Logs.`,
            `[${st}]`,
            '# --- Index time: the heavy forwarder, or the indexers ---------------------',
            'SHOULD_LINEMERGE = false',
            'LINE_BREAKER = ([\\r\\n]+)',
            '# The time stamp follows the priority, and the version in RFC 5424.',
            'TIME_PREFIX = ^(?:<\\d+>)?(?:1\\s)?',
            'MAX_TIMESTAMP_LOOKAHEAD = 40',
            'TRUNCATE = 20000',
            '# The host the event is about, from the syslog header — RFC 3164 through',
            '# Splunk’s own syslog-host, then RFC 5424 — rather than the forwarding node.',
            `TRANSFORMS-host = syslog-host, ${stName}_host_rfc5424`,
            '',
            '# --- Search time: the search heads ------------------------------------------',
            '# The program that wrote the line: APP-NAME in RFC 5424, the tag in RFC 3164.',
            'EXTRACT-vcf_app_5424 = ^(?:<\\d+>)?1\\s+\\S+\\s+\\S+\\s+(?<vcf_app>[^\\s\\[]+)',
            'EXTRACT-vcf_app_3164 = ^(?:<\\d+>)?\\w{3}\\s+\\d+\\s+[\\d:]+\\s+\\S+\\s+(?<vcf_app>[^\\s\\[:]+)',
            'EVAL-vendor_product = "VMware Cloud Foundation"',
            '# Which component each host is, from lookups/expected_vcf_components.csv.',
            'LOOKUP-component = expected_vcf_components host OUTPUTNEW component',
          ],
          'default/transforms.conf': [
            `[${stName}_host_rfc5424]`,
            '# <pri>1 TIMESTAMP HOSTNAME APP-NAME ...',
            'REGEX = ^<\\d+>1\\s+\\S+\\s+([^\\s-][^\\s]*)',
            'DEST_KEY = MetaData:Host',
            'FORMAT = host::$1',
            '',
            '[expected_vcf_components]',
            'filename = expected_vcf_components.csv',
            'case_sensitive_match = false',
          ],
          'lookups/expected_vcf_components.csv': ['host,component', ...known.flatMap((k) => [[k.host, k.component], ...(k.host.includes('.') ? [[k.host.split('.')[0] , k.component]] : [])].map((r) => r.map(csvCell).join(',')))],
          'default/savedsearches.conf': [
            `[${alertName}]`,
            `description = Every VCF management component in expected_vcf_components.csv that has sent nothing to ${index} for ${silent} minutes.`,
            ...foldSearch(alertSearch),
            'dispatch.earliest_time = -7d',
            'dispatch.latest_time = now',
            ...alertLines(alertName, 15, 'host', '4h', email, 'VCF component silent: $result.host$'),
            '',
            `[${errorsReport}]`,
            'description = Error lines from the VCF management components in the last 24 hours, by component, host and program.',
            ...foldSearch(errorsSearch),
            'dispatch.earliest_time = -24h',
            'dispatch.latest_time = now',
            'enableSched = 0',
          ],
          'metadata/default.meta': defaultMeta(),
          'ops/VCF_FORWARDING.txt': forwarding,
          ...(collector === 'hf' ? { 'ops/heavy_forwarder/inputs.conf': hfInputs } : {}),
          ...sc4sFiles,
        },
        verify: [
          `index=${index} sourcetype=${splQuote(st)} earliest=-15m | stats count, latest(_time) as last by host, component, vcf_app | eval last=strftime(last, "%F %T")   # each host by its own name, not the VCF Operations for Logs node`,
          `| savedsearch "${alertName}"   # nothing, once every component is sending`,
          `index=${index} sourcetype=${splQuote(st)} earliest=-15m | eval lag_s=_indextime-_time | stats avg(lag_s) as avg_lag_s, max(lag_s) as max_lag_s by host   # hours of lag = a time zone problem`,
          `index=${index} sourcetype=${splQuote(st)} earliest=-1h | where isnull(component) | stats count by host   # hosts the lookup does not know`,
        ],
        backout: [
          'VCF Operations: delete the "splunk" forwarding destination',
          `Remove ${app} from the search heads and the parsing tier${collector === 'hf' ? ', and the listener app from the heavy forwarders (restart them)' : ', and the ops/sc4s entries from SC4S (restart it)'}`,
          '# Events already indexed keep the host they were given.',
        ],
        findings,
      };
    },
  }),

  // ---------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_onboard_ansible',
    tier: TIER,
    label: 'Onboard Ansible AWX / Automation Platform job events',
    group: GROUP,
    description:
      'AWX or Automation Platform logs into Splunk HEC through the built-in logging aggregator: the HEC token created through REST and handed to the controller without ever being printed, the logging settings PATCHed by a script that saves the old ones first (--dry-run previews), and searches and an alert for failed jobs and for changes in the activity stream.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_ansible_onboarding' },
      { id: 'product', label: 'Product', control: 'select', default: 'aap24', options: Object.entries(AWX_PRODUCTS).map(([value, p]) => ({ value, label: p.label })) },
      { id: 'controller_url', label: 'Controller URL', control: 'text', default: 'https://aap.example.com', hint: 'Automation Platform 2.5 and later: the platform gateway' },
      { id: 'hec_url', label: 'HEC URL', control: 'text', default: 'https://hec.example.com:8088/services/collector/event', hint: 'The full URL with the path — the controller posts to exactly this' },
      { id: 'token_from', label: 'HEC token', control: 'select', default: 'create', options: [
        { value: 'create', label: 'Created by the script on Splunk Enterprise, through REST' },
        { value: 'file', label: 'Already exists — read from a file (Splunk Cloud: created with ACS)' },
      ] },
      { id: 'splunk_url', label: 'Splunk management URL', control: 'text', default: 'https://hec01.example.com:8089', hint: 'The HEC instance the token is created on', showWhen: { input: 'token_from', equals: ['create'] } },
      { id: 'token_name', label: 'HEC token name', control: 'text', default: 'ansible', showWhen: { input: 'token_from', equals: ['create'] } },
      { id: 'index', label: 'Index', control: 'combo', default: 'ansible', options: [
        { value: 'ansible', label: 'ansible' },
        { value: 'automation', label: 'automation' },
        { value: 'infraops', label: 'infraops' },
        { value: 'main', label: 'main' },
      ], offer: INDEX_MEMORY },
      { id: 'sourcetype', label: 'Sourcetype', control: 'combo', default: 'ansible:awx', options: [
        { value: 'ansible:awx', label: 'ansible:awx' },
        { value: '_json', label: '_json' },
      ], hint: 'The token’s default; no add-on defines one' },
      { id: 'loggers', label: 'Loggers', control: 'checklist', default: 'awx,activity_stream,job_events', options: AWX_LOGGERS },
      { id: 'level', label: 'Level (awx logger)', control: 'select', default: 'INFO', options: ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].map((v) => ({ value: v, label: v })) },
      { id: 'verify_cert', label: 'Verify the HEC certificate', control: 'toggle', default: true },
      { id: 'alert_email', label: 'Failed job alert email', control: 'text', default: '', placeholder: 'automation@example.com' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_ansible_onboarding'), 'org_ansible_onboarding');
      const productId = str(values, 'product', 'aap24');
      const product = AWX_PRODUCTS[productId] ?? AWX_PRODUCTS['aap24'] ;
      const controller = str(values, 'controller_url', '').replace(/\/+$/, '');
      const hecUrl = str(values, 'hec_url', '');
      const tokenFrom = str(values, 'token_from', 'create');
      const splunkUrl = str(values, 'splunk_url', '').replace(/\/+$/, '');
      const tokenName = splunkName(str(values, 'token_name', 'ansible'), 'ansible');
      const index = indexName(str(values, 'index', 'ansible'), 'ansible');
      const st = str(values, 'sourcetype', 'ansible:awx').replace(/[^A-Za-z0-9:_.-]+/g, '_') || 'ansible:awx';
      const loggers = listOf(str(values, 'loggers', '')).filter((l) => AWX_LOGGERS.some((o) => o.value === l));
      const level = str(values, 'level', 'INFO');
      const verifyCert = bool(values, 'verify_cert', true);
      const email = str(values, 'alert_email', '');
      const findings            = [];

      if (!/^https?:\/\/[^/\s]+\/services\/collector\/event(\/1\.0)?\/?$/.test(hecUrl)) {
        findings.push(
          error('splunk.ansible-hec-url', `"${hecUrl}" is not a HEC event URL. With the splunk aggregator type the controller posts to exactly the URL it is given, so a host name alone, or a URL without /services/collector/event, gets a 404 for every log record.`, {
            remediation: 'Give the whole URL: https://<hec host>:8088/services/collector/event.',
            source: 'AWX / Automation Platform documentation — logging aggregator, Splunk',
          }),
        );
      } else if (hecUrl.startsWith('http://')) {
        findings.push(
          warning('splunk.ansible-hec-http', 'The HEC URL is http: the token travels in clear with every log record, and anyone who sees it can write to the index.', {
            remediation: 'Use https, with a certificate the controller trusts.',
            source: 'Splunk HTTP Event Collector documentation',
          }),
        );
      }
      if (!/^https?:\/\/[^/\s]+$/.test(controller)) {
        findings.push(error('splunk.ansible-controller-url', `"${controller}" is not a controller URL (https://<host>, no path). The script builds the API path from it.`, { source: 'AWX / Automation Platform API reference' }));
      }
      if (tokenFrom === 'create' && !/^https:\/\/[^/\s]+$/.test(splunkUrl)) {
        findings.push(error('splunk.ansible-splunk-url', `"${splunkUrl}" is not a Splunk management URL (https://<host>:8089). The HEC token is created there.`, { source: 'Splunk REST API reference — data/inputs/http' }));
      }
      if (loggers.length === 0) {
        findings.push(error('splunk.ansible-no-loggers', 'No loggers chosen: the controller would send nothing.', { source: 'AWX / Automation Platform documentation — logging aggregator' }));
      } else if (!loggers.includes('job_events')) {
        findings.push(
          warning('splunk.ansible-no-job-events', 'job_events is not sent, so the failed-job searches and alert in this app will find nothing: a task failure is a job event.', {
            remediation: 'Add job_events to the loggers.',
            source: 'AWX / Automation Platform documentation — logging aggregator',
          }),
        );
      }
      if (!verifyCert) {
        findings.push(
          warning('splunk.ansible-no-verify', 'Certificate verification off: the controller will send the HEC token to whatever answers at that address.', {
            remediation: 'Add the HEC certificate’s CA to the controller’s trust store and leave verification on.',
            source: 'AWX / Automation Platform documentation — logging aggregator',
          }),
        );
      }
      if (level === 'DEBUG') {
        findings.push(warning('splunk.ansible-debug', 'DEBUG on the awx logger sends the controller’s internal chatter — task dispatch, websocket and database detail — for every job, many times the volume of the job events themselves.', { remediation: 'INFO, or WARNING once it is running.', source: 'AWX / Automation Platform documentation — logging aggregator' }));
      }

      const failedAlert = 'Ansible - job task failed';
      const failedReport = 'Ansible - failed tasks by job - last 24 hours';
      const activityReport = 'Ansible - activity stream changes - last 7 days';
      const window = searchWindow(15);
      const base = `index=${index} sourcetype=${splQuote(st)}`;
      const failed = `${base} logger_name="awx.analytics.job_events" event IN ("runner_on_failed", "runner_on_unreachable")`;

      const script           = [
        '#!/usr/bin/env bash',
        `# Send ${product.label} logs to Splunk HEC through the logging aggregator.`,
        '#   1. The HEC token: created on the Splunk HEC instance through REST, in',
        `#      the app ${app} — or read from a file when it already exists (Splunk`,
        '#      Cloud: created with ACS). Never printed, never an argument.',
        `#   2. The logging settings: saved to logging-before-<time>.json, then`,
        `#      PATCH ${product.api}/settings/logging/.`,
        `#   3. POST ${product.api}/settings/logging/test/, which sends a test record.`,
        '# Applies when run; --dry-run previews (the token is shown as <hidden>).',
        ...(product.verify ? ['# VERIFY the API path for your Automation Platform release.'] : []),
        '#',
        '# Credentials, each in a file of mode 600:',
        '#   --controller-token-file  an API token of a system administrator',
        ...(tokenFrom === 'create'
          ? ['#   --splunk-token-file      a Splunk authentication token on the HEC instance']
          : ['#   --hec-token-file         the existing HEC token']),
        '# CACERT=<bundle> to verify both ends.',
        '#',
        `# Usage: bash awx-logging.sh --controller-token-file F ${tokenFrom === 'create' ? '--splunk-token-file F' : '--hec-token-file F'} [--dry-run]`,
        'set -euo pipefail',
        `CONTROLLER=${shq(controller || 'https://<controller>')}`,
        `API="$CONTROLLER${product.api}"`,
        `SPLUNK_URL=${shq(splunkUrl || 'https://<hec-instance>:8089')}`,
        `APP=${shq(app)}`,
        `NAME=${shq(tokenName)}`,
        `INDEX=${shq(index)}`,
        `SOURCETYPE=${shq(st)}`,
        `HEC_URL=${shq(hecUrl)}`,
        `LOGGERS=${shq(JSON.stringify(loggers))}`,
        `LEVEL=${shq(level)}`,
        `VERIFY_CERT=${verifyCert ? 'true' : 'false'}`,
        'EXECUTE=1; CTRL_FILE=""; SPLUNK_FILE=""; HEC_FILE=""',
        'while [[ $# -gt 0 ]]; do',
        '  case "$1" in',
        '    --controller-token-file) CTRL_FILE="$2"; shift 2 ;;',
        '    --splunk-token-file) SPLUNK_FILE="$2"; shift 2 ;;',
        '    --hec-token-file) HEC_FILE="$2"; shift 2 ;;',
        '    --dry-run) EXECUTE=0; shift ;;',
        '    *) echo "unknown option: $1" >&2; exit 2 ;;',
        '  esac',
        'done',
        'die() { echo "$*" >&2; exit 1; }',
        'private() { [[ -f "$1" ]] || die "Missing $1"; [[ "$(stat -c %a "$1")" == "600" ]] || die "$1 must be mode 600"; }',
        'command -v jq >/dev/null || die "jq is required"',
        'umask 077',
        'WORK="$(mktemp -d)"; trap \'rm -rf "$WORK"\' EXIT',
        'CURL=(curl --silent --show-error)',
        '[[ -n "${CACERT:-}" ]] && CURL+=(--cacert "$CACERT")',
        '# One header file per credential. printf is a shell builtin, so the token',
        '# is never in the process list.',
        'header() { private "$1"; printf \'Authorization: Bearer %s\\n\' "$(tr -d \'\\r\\n\' < "$1")" > "$2"; }',
        '[[ -n "$CTRL_FILE" ]] || die "--controller-token-file is required"',
        'header "$CTRL_FILE" "$WORK/ctrl.h"',
        '',
        '# --- 1. The HEC token ---------------------------------------------------------',
        'if [[ -n "$HEC_FILE" ]]; then',
        '  private "$HEC_FILE"',
        '  tr -d \'\\r\\n\' < "$HEC_FILE" > "$WORK/hec"',
        'else',
        '  [[ -n "$SPLUNK_FILE" ]] || die "--splunk-token-file or --hec-token-file is required"',
        '  header "$SPLUNK_FILE" "$WORK/splunk.h"',
        '  # Created in this app, so the token stanza lands in its local/inputs.conf:',
        '  # the app must be installed on the HEC instance first.',
        '  EP="$SPLUNK_URL/servicesNS/nobody/$APP/data/inputs/http"',
        '  # 200 = exists, 404 = absent; anything else (401, 403, TLS) stops here',
        '  # rather than being mistaken for "absent".',
        '  code="$("${CURL[@]}" -o "$WORK/existing.json" -w "%{http_code}" -H @"$WORK/splunk.h" "$EP/http%3A%2F%2F$NAME?output_mode=json")" || die "cannot reach $SPLUNK_URL"',
        '  case "$code" in',
        '    200)',
        '      echo "HEC token $NAME already exists on $SPLUNK_URL: using it"',
        '      jq -er ".entry[0].content.token" "$WORK/existing.json" > "$WORK/hec" ;;',
        '    404)',
        '      if (( EXECUTE )); then',
        '        "${CURL[@]}" --fail -H @"$WORK/splunk.h" -X POST "$EP?output_mode=json" \\',
        '          --data-urlencode "name=$NAME" --data-urlencode "index=$INDEX" --data-urlencode "indexes=$INDEX" \\',
        '          --data-urlencode "sourcetype=$SOURCETYPE" --data-urlencode "useACK=0" \\',
        '          | jq -er ".entry[0].content.token" > "$WORK/hec"',
        '        echo "HEC token $NAME created in $APP on $SPLUNK_URL (index $INDEX, sourcetype $SOURCETYPE)"',
        '      else',
        '        echo "DRY RUN: create HEC token $NAME in $APP on $SPLUNK_URL (index $INDEX, sourcetype $SOURCETYPE)"',
        '        printf "%s" "<created on the real run>" > "$WORK/hec"',
        '      fi ;;',
        '    *) die "HTTP $code checking for HEC token $NAME on $SPLUNK_URL" ;;',
        '  esac',
        'fi',
        '',
        '# --- 2. The logging settings -------------------------------------------------',
        '"${CURL[@]}" --fail -H @"$WORK/ctrl.h" "$API/settings/logging/" > "$WORK/before.json" || die "cannot read $API/settings/logging/"',
        'jq -n --rawfile tok "$WORK/hec" --arg host "$HEC_URL" --argjson loggers "$LOGGERS" --arg level "$LEVEL" --argjson verify "$VERIFY_CERT" \\',
        `  '{LOG_AGGREGATOR_ENABLED: true, LOG_AGGREGATOR_TYPE: "splunk", LOG_AGGREGATOR_HOST: $host, LOG_AGGREGATOR_PASSWORD: $tok, LOG_AGGREGATOR_LOGGERS: $loggers, LOG_AGGREGATOR_LEVEL: $level, LOG_AGGREGATOR_PROTOCOL: "https", LOG_AGGREGATOR_VERIFY_CERT: $verify}' > "$WORK/body.json"`,
        'if (( EXECUTE )); then',
        '  BEFORE="logging-before-$(date +%Y%m%d%H%M%S).json"',
        '  cp "$WORK/before.json" "$BEFORE"',
        '  echo "Settings before the change: $BEFORE (secrets come back as \\$encrypted\\$ and are not in it)"',
        '  "${CURL[@]}" --fail -H @"$WORK/ctrl.h" -X PATCH -H "Content-Type: application/json" --data @"$WORK/body.json" "$API/settings/logging/" >/dev/null',
        '  echo "Logging aggregator set: $HEC_URL"',
        '  # --- 3. A test record. VERIFY the test endpoint on your release. ---------',
        '  if "${CURL[@]}" --fail -H @"$WORK/ctrl.h" -X POST -H "Content-Type: application/json" --data @"$WORK/body.json" "$API/settings/logging/test/" >/dev/null; then',
        '    echo "Test record sent: see the verify searches"',
        '  else',
        '    die "Settings saved, but the test failed: check the HEC URL, the token and the certificate"',
        '  fi',
        'else',
        '  echo "Current:"',
        `  jq '{LOG_AGGREGATOR_ENABLED, LOG_AGGREGATOR_TYPE, LOG_AGGREGATOR_HOST, LOG_AGGREGATOR_LOGGERS, LOG_AGGREGATOR_LEVEL, LOG_AGGREGATOR_VERIFY_CERT}' "$WORK/before.json"`,
        '  echo "DRY RUN: PATCH $API/settings/logging/"',
        `  jq '.LOG_AGGREGATOR_PASSWORD = "<hidden>"' "$WORK/body.json"`,
        'fi',
      ];

      return {
        tier: TIER,
        title: `Onboard ${product.label} logs (${loggers.join(', ') || 'no loggers'}) into ${index} through HEC`,
        app,
        activation: 'restart',
        notes: [
          `The controller’s logging aggregator, type splunk, posts each record to ${hecUrl} with the HEC token as its password. Loggers: ${loggers.join(', ') || 'none'}; level ${level} for the awx logger.`,
          tokenFrom === 'create'
            ? `ops/awx-logging.sh creates HEC token ${tokenName} in this app on ${splunkUrl} (index ${index}, only ${index} allowed, sourcetype ${st}) — so install this app on the HEC instance before running it, with HEC itself enabled (the HTTP Event Collector blueprint). The token goes from Splunk’s response into the controller’s settings in a mode-600 temporary file and is never printed.`
            : `ops/awx-logging.sh reads the existing HEC token from a mode-600 file. On Splunk Cloud create it with ACS (inputs/http-event-collectors), default index ${index}, sourcetype ${st}.`,
          'The script saves the current logging settings to logging-before-<time>.json before the PATCH. Secrets come back as $encrypted$, so the saved copy is for the non-secret settings.',
          'VERIFY: no Splunk add-on for AWX or Automation Platform. The records are JSON (KV_MODE = json here); the searches read logger_name, event, job, playbook, host_name, failed, and the activity stream’s actor, operation, object1 and changes — check them against a few real records before relying on the alert.',
          `The alert "${failedAlert}" runs every 15 minutes: one result per job with a failed or unreachable task, then quiet for that job for a day.`,
          `Create the index (${index}) first.`,
        ],
        before: [
          `| rest /services/data/indexes | search title=${index} | table title, splunk_server`,
          `curl -s ${hecUrl.replace(/\/services\/collector\/event.*$/, '')}/services/collector/health   # HEC is enabled and healthy`,
          `bash ops/awx-logging.sh --controller-token-file ~/.aap/admin.token ${tokenFrom === 'create' ? '--splunk-token-file ~/.splunk/admin.token' : '--hec-token-file ~/.splunk/hec-ansible.token'} --dry-run   # current settings, and the ones it would set`,
        ],
        files: {
          'default/app.conf': appConfLines(app, 'Ansible onboarding', 'AWX / Automation Platform records from HEC: fields, failed-job searches and alert'),
          'default/props.conf': [
            '# Records posted by the controller to /services/collector/event: one JSON',
            '# object per event, time from the request. Nothing to break or time-stamp.',
            `[${st}]`,
            'KV_MODE = json',
            'EVAL-vendor_product = "Ansible Automation Platform"',
            '# The managed host a task ran against, as the CIM names it.',
            'FIELDALIAS-dest = host_name AS dest',
          ],
          'default/savedsearches.conf': [
            `[${failedAlert}]`,
            'description = Each job with a failed or unreachable task in the last 15 minutes, with the playbook and the hosts. Tasks with ignore_errors are left out.',
            ...foldSearch([
              `${failed} earliest=${window.earliest} latest=${window.latest}`,
              '| search NOT "event_data.ignore_errors"=true',
              '| stats count as failed_tasks, values(host_name) as hosts, values(task) as tasks, latest(_time) as last by job, playbook',
              '| eval last=strftime(last, "%F %T")',
            ]),
            `dispatch.earliest_time = ${window.earliest}`,
            `dispatch.latest_time = ${window.latest}`,
            ...alertLines(failedAlert, 15, 'job', '24h', email, 'Ansible job $result.job$ failed: $result.playbook$'),
            '',
            `[${failedReport}]`,
            'description = Failed and unreachable tasks in the last 24 hours, by job, playbook and host.',
            ...foldSearch([`${failed} earliest=-24h`, '| stats count as failed_tasks, values(task) as tasks, latest(_time) as last by job, playbook, host_name', '| eval last=strftime(last, "%F %T")', '| sort - failed_tasks']),
            'dispatch.earliest_time = -24h',
            'dispatch.latest_time = now',
            'enableSched = 0',
            '',
            `[${activityReport}]`,
            'description = Who changed what in the controller: templates, credentials, inventories, settings.',
            ...foldSearch([`${base} logger_name="awx.analytics.activity_stream" earliest=-7d`, '| table _time, actor, operation, object1, object2, changes', '| sort - _time']),
            'dispatch.earliest_time = -7d',
            'dispatch.latest_time = now',
            'enableSched = 0',
          ],
          'metadata/default.meta': defaultMeta(),
          'ops/awx-logging.sh': script,
        },
        verify: [
          `${base} earliest=-15m | stats count by logger_name   # one line per chosen logger once jobs run`,
          `${base} earliest=-15m "test" | head 5   # the test record the script sent`,
          `index=_internal sourcetype=splunkd component=HttpInputDataHandler earliest=-15m | stats count by status_code   # HEC rejections, if any`,
          `| savedsearch "${failedReport}"`,
          `curl -s -H @auth.h ${controller || 'https://<controller>'}${product.api}/settings/logging/ | jq '{LOG_AGGREGATOR_ENABLED, LOG_AGGREGATOR_HOST, LOG_AGGREGATOR_LOGGERS}'`,
        ],
        backout: [
          `PATCH ${product.api}/settings/logging/ with {"LOG_AGGREGATOR_ENABLED": false} — or the non-secret values from logging-before-<time>.json`,
          ...(tokenFrom === 'create' ? [`DELETE ${splunkUrl}/servicesNS/nobody/${app}/data/inputs/http/http%3A%2F%2F${tokenName}   # the HEC token`] : []),
          `Remove ${app} from the search heads and the HEC instance`,
        ],
        findings,
      };
    },
  }),

  // ---------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_onboard_hcp_terraform',
    tier: TIER,
    label: 'Onboard HCP Terraform audit trails',
    group: GROUP,
    description:
      'HCP Terraform audit trails into Splunk with the HCP Terraform for Splunk app (Splunkbase 5141): where it can run, how the organization token is handled, a read-only script that proves the token can read the audit trail, and searches and alerts for destroys and for the input going quiet.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_terraform_audit' },
      { id: 'organization', label: 'HCP Terraform organization', control: 'text', default: 'example-org' },
      { id: 'tf_host', label: 'HCP Terraform address', control: 'combo', default: 'app.terraform.io', options: [
        { value: 'app.terraform.io', label: 'app.terraform.io — HCP Terraform' },
        { value: 'app.eu.terraform.io', label: 'app.eu.terraform.io — HCP Terraform Europe' },
      ], hint: 'Terraform Enterprise: your own host name (VERIFY the app supports it)' },
      { id: 'deployment', label: 'Splunk deployment', control: 'select', default: 'cloud', options: [
        { value: 'cloud', label: 'Splunk Cloud Platform' },
        { value: 'standalone', label: 'Splunk Enterprise — a standalone instance or one heavy forwarder' },
        { value: 'clustered', label: 'Splunk Enterprise — search head cluster' },
      ] },
      { id: 'index', label: 'Index', control: 'combo', default: 'terraform', options: [
        { value: 'terraform', label: 'terraform' },
        { value: 'audit', label: 'audit' },
        { value: 'infraops', label: 'infraops' },
        { value: 'main', label: 'main' },
      ], offer: INDEX_MEMORY },
      { id: 'sourcetype', label: 'Sourcetype the app writes', control: 'combo', default: 'terraform_cloud', options: [{ value: 'terraform_cloud', label: 'terraform_cloud' }], hint: 'VERIFY against the events once they arrive' },
      { id: 'quiet_hours', label: 'Alert when no audit event arrives for (hours)', control: 'number', default: 4, min: 1, max: 168 },
      { id: 'alert_email', label: 'Alert email', control: 'text', default: '', placeholder: 'platform@example.com' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_terraform_audit'), 'org_terraform_audit');
      const org = str(values, 'organization', '');
      const host = hostAddress(str(values, 'tf_host', 'app.terraform.io'));
      const deployment = str(values, 'deployment', 'cloud');
      const index = indexName(str(values, 'index', 'terraform'), 'terraform');
      const st = str(values, 'sourcetype', 'terraform_cloud').replace(/[^A-Za-z0-9:_.-]+/g, '_') || 'terraform_cloud';
      const quiet = Math.max(1, Math.round(num(values, 'quiet_hours', 4)));
      const email = str(values, 'alert_email', '');
      const findings            = [];

      if (!/^[A-Za-z0-9_-]+$/.test(org)) {
        findings.push(error('splunk.tfc-org', `"${org}" is not an HCP Terraform organization name (letters, digits, - and _).`, { source: 'HCP Terraform documentation — organizations' }));
      }
      if (!host) {
        findings.push(error('splunk.tfc-host', 'The HCP Terraform address is empty or not a host name.', { source: 'HCP Terraform documentation' }));
      }
      if (deployment === 'clustered') {
        findings.push(
          warning('splunk.tfc-clustered', 'The HCP Terraform for Splunk app is not supported on clustered Splunk Enterprise. In a search head cluster its input runs on every member and its setup is not replicated the way it expects: duplicate audit events at best, an input that never runs at worst.', {
            remediation: 'Run the app’s input on one standalone instance or one heavy forwarder that forwards to the indexers, and deploy only this app (the searches) to the cluster. VERIFY that layout with HashiCorp for your version.',
            source: 'Splunkbase 5141 — HCP Terraform for Splunk',
          }),
        );
      }

      const base = `index=${index} sourcetype=${splQuote(st)}`;
      const destroyAlert = 'HCP Terraform - destroy or delete';
      const quietAlert = `HCP Terraform - no audit events for ${quiet} hours`;
      const byUser = 'HCP Terraform - changes by user - last 7 days';
      const window = searchWindow(15);

      const check           = [
        '#!/usr/bin/env bash',
        '# Prove the organization token can read the audit trail, before it goes',
        '# into the app. Read only: it changes nothing.',
        '#',
        '# The token is read from a file of mode 600 and sent from a header file,',
        '# never as an argument.',
        '#',
        '# Usage: bash check-audit-trail.sh ~/.terraform/org.token',
        'set -euo pipefail',
        `HOST=${shq(host || 'app.terraform.io')}`,
        `ORG=${shq(org)}`,
        'FILE="${1:?usage: check-audit-trail.sh <token file>}"',
        '[[ -f "$FILE" ]] || { echo "Missing $FILE" >&2; exit 1; }',
        '[[ "$(stat -c %a "$FILE")" == "600" ]] || { echo "$FILE must be mode 600" >&2; exit 1; }',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }',
        'umask 077',
        'WORK="$(mktemp -d)"; trap \'rm -rf "$WORK"\' EXIT',
        'printf \'Authorization: Bearer %s\\n\' "$(tr -d \'\\r\\n\' < "$FILE")" > "$WORK/auth.h"',
        '# The audit trail belongs to the organization of the token; there is no',
        '# organization in the path.',
        'code="$(curl -sS -o "$WORK/out.json" -w "%{http_code}" -H @"$WORK/auth.h" -H "Content-Type: application/vnd.api+json" "https://$HOST/api/v2/organization/audit-trail?page%5Bsize%5D=1")"',
        'case "$code" in',
        '  200) echo "OK: the token reads the audit trail of $ORG. Latest event:"; jq -c \'.data[0] // "none yet"\' "$WORK/out.json" ;;',
        '  401|403|404) echo "HTTP $code: the audit trail needs an organization token (not a user or team token) and a plan that includes audit trails." >&2; exit 1 ;;',
        '  *) echo "HTTP $code from $HOST" >&2; exit 1 ;;',
        'esac',
      ];

      return {
        tier: TIER,
        title: `Onboard HCP Terraform audit trails for ${org || 'the organization'} into ${index}`,
        app,
        activation: 'reload',
        notes: [
          'Install HCP Terraform for Splunk (Splunkbase 5141). It is built and supported by HashiCorp, not Splunk. It polls the audit trail API over HTTPS 443 from the instance it runs on, so that instance needs outbound access to ' + (host || 'app.terraform.io') + '.',
          deployment === 'cloud'
            ? 'Splunk Cloud: install it with ACS (apps/victoria with splunkbase=true) or from the app browser, then configure it in its setup page. VERIFY it is on the Cloud-vetted list for your stack.'
            : deployment === 'clustered'
              ? 'Clustered Enterprise is not supported by the app: run its input on one standalone instance or heavy forwarder (see the finding), and deploy this app to the search heads.'
              : 'Splunk Enterprise: install it on this one instance (or heavy forwarder) and configure it in its setup page.',
          'The token: an organization API token — user and team tokens cannot read the audit trail — entered in the app’s setup page, which keeps it in Splunk’s credential store. Never in a .conf file. Check it first with ops/check-audit-trail.sh, which reads it from a mode-600 file.',
          'VERIFY: an organization has had one organization token at a time, and regenerating it revokes the old one, breaking whatever else uses it. Check with the organization owners before regenerating, and rotate on a schedule they know.',
          `VERIFY: the sourcetype the app writes (${st} here). Once events arrive, | tstats count where index=${index} by sourcetype shows the real one; change it on the form and redeploy if it differs.`,
          'The searches read the audit trail’s own fields: auth.description (who), auth.type, resource.type, resource.action, resource.id, request.id.',
          `Create the index (${index}) first.`,
        ],
        before: [
          `| rest /services/data/indexes | search title=${index} | table title, splunk_server`,
          'bash ops/check-audit-trail.sh ~/.terraform/org.token   # the token reads the audit trail',
          `curl -sS -o /dev/null -w "%{http_code}\\n" https://${host || 'app.terraform.io'}/api/v2/ping   # from the instance that will run the input: outbound 443 works`,
        ],
        files: {
          'default/app.conf': appConfLines(app, 'HCP Terraform audit searches', 'Searches and alerts over HCP Terraform audit trails'),
          'default/savedsearches.conf': [
            `[${destroyAlert}]`,
            'description = Every destroy or delete in HCP Terraform in the last 15 minutes: who, what kind of resource, and which.',
            ...foldSearch([
              `${base} earliest=${window.earliest} latest=${window.latest}`,
              '| search "resource.action"=destroy OR "resource.action"=delete',
              '| table _time, auth.description, auth.type, resource.type, resource.action, resource.id, request.id',
            ]),
            `dispatch.earliest_time = ${window.earliest}`,
            `dispatch.latest_time = ${window.latest}`,
            ...alertLines(destroyAlert, 15, 'resource.id', '1h', email, 'HCP Terraform: $result.resource.action$ of $result.resource.type$ by $result.auth.description$'),
            '',
            `[${quietAlert}]`,
            `description = No audit event for ${quiet} hours: the input has stopped, or the token was revoked or regenerated.`,
            ...foldSearch([`| tstats count where index=${index} sourcetype=${splQuote(st)} earliest=-${quiet}h`, '| where count=0']),
            `dispatch.earliest_time = -${quiet}h`,
            'dispatch.latest_time = now',
            ...alertLines(quietAlert, 60, 'count', `${quiet}h`, email, 'HCP Terraform audit trail quiet'),
            '',
            `[${byUser}]`,
            'description = What each user and token changed in the last 7 days, by resource type and action.',
            ...foldSearch([`${base} earliest=-7d`, '| stats count by auth.description, auth.type, resource.type, resource.action', '| sort - count']),
            'dispatch.earliest_time = -7d',
            'dispatch.latest_time = now',
            'enableSched = 0',
          ],
          'metadata/default.meta': defaultMeta(),
          'ops/check-audit-trail.sh': check,
        },
        verify: [
          `| tstats count, latest(_time) as last where index=${index} earliest=-24h by sourcetype | eval last=strftime(last, "%F %T")   # the sourcetype the app really writes`,
          `${base} earliest=-24h | stats count by resource.type, resource.action`,
          `| savedsearch "${byUser}"`,
          `index=_internal source=*terraform* log_level=ERROR earliest=-1h | stats count by source   # the input’s own errors (VERIFY its log name)`,
        ],
        backout: [
          'Disable the input in the HCP Terraform for Splunk app, and remove its token from the setup page',
          `Remove ${app} from the search heads`,
          '# Revoke the organization token in HCP Terraform only if nothing else uses it.',
        ],
        findings,
      };
    },
  }),

  // ---------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_onboard_juniper',
    tier: TIER,
    label: 'Onboard Juniper Junos devices through SC4S',
    group: GROUP,
    description:
      'Juniper SRX, EX, QFX and MX syslog through SC4S — firewall to netfw, IDP to netids, everything else to netops — with the Juniper add-on, the set commands each device needs (structured syslog, SRX security log streams, commit confirmed), and an alert for any device that stops reporting. Palo Alto, Fortinet and Arista are in "Onboard network devices".',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_juniper_onboarding' },
      {
        id: 'devices',
        label: 'Devices',
        control: 'textarea',
        default: 'srx-edge01 | 10.0.1.31 | srx\nex-access01 | 10.0.0.51 | ex\nqfx-leaf01 | 10.0.0.61 | qfx\nmx-wan01 | 10.0.0.71 | mx',
        hint: `hostname | ip | role — role is ${Object.keys(JUNOS_ROLES).join(', ')}`,
      },
      { id: 'sc4s_host', label: 'SC4S address', control: 'text', default: '10.0.5.10', hint: 'An IP address: SRX security log streams take no host name' },
      { id: 'transport', label: 'Transport', control: 'select', default: 'tcp', options: SYSLOG_TRANSPORTS },
      { id: 'netfw_index', label: 'Firewall index', control: 'combo', default: 'netfw', options: [{ value: 'netfw', label: 'netfw — SC4S default' }], offer: INDEX_MEMORY },
      { id: 'netids_index', label: 'IDP index', control: 'combo', default: 'netids', options: [{ value: 'netids', label: 'netids — SC4S default' }], offer: INDEX_MEMORY },
      { id: 'netops_index', label: 'Network operations index', control: 'combo', default: 'netops', options: [{ value: 'netops', label: 'netops — SC4S default' }], offer: INDEX_MEMORY },
      { id: 'ntp', label: 'NTP server', control: 'text', default: '10.0.0.1' },
      { id: 'silent_minutes', label: 'Alert when a device is silent for (minutes)', control: 'number', default: 60, min: 5, max: 10080 },
      { id: 'alert_email', label: 'Alert email', control: 'text', default: '', placeholder: 'netops@example.com' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_juniper_onboarding'), 'org_juniper_onboarding');
      const devices = parseJunos(str(values, 'devices', ''));
      const known = devices.filter((d)                                         => d.role !== null);
      const unknown = devices.filter((d) => d.role === null);
      const target = hostAddress(str(values, 'sc4s_host', ''));
      const transport = str(values, 'transport', 'tcp');
      const port = sc4sPort(transport);
      const netfw = indexName(str(values, 'netfw_index', 'netfw'), 'netfw');
      const netids = indexName(str(values, 'netids_index', 'netids'), 'netids');
      const netops = indexName(str(values, 'netops_index', 'netops'), 'netops');
      const ntp = hostAddress(str(values, 'ntp', '')) || '<ntp server>';
      const silent = Math.max(5, Math.round(num(values, 'silent_minutes', 60)));
      const email = str(values, 'alert_email', '');
      const srxs = known.filter((d) => d.role === 'srx');
      const findings            = [];

      if (!target) {
        findings.push(error('splunk.junos-no-collector', 'The SC4S address is empty or not a host name or address; the devices have nothing to send to.', { source: 'SC4S documentation' }));
      } else if (srxs.length > 0 && !/^[\d.]+$|:/.test(target)) {
        findings.push(
          warning('splunk.junos-stream-host', `SC4S is given as a name (${target}), and an SRX security log stream takes an IP address only: the ${srxs.length} SRX file${srxs.length === 1 ? '' : 's'} would fail to commit on the stream line.`, {
            remediation: 'Give SC4S (or its VIP) as an IP address.',
            source: 'Junos OS documentation — security log stream',
          }),
        );
      }
      if (unknown.length > 0) {
        findings.push(
          warning('splunk.junos-unknown-role', `${unknown.length} device${unknown.length === 1 ? ' has' : 's have'} no known role: ${unknown.map((d) => `${d.name} ("${d.raw}")`).join(', ')}. They get no configuration and are left out of the missing-device alert.`, {
            remediation: `Use one of ${Object.keys(JUNOS_ROLES).join(', ')}.`,
            source: 'Junos OS documentation',
          }),
        );
      }
      if (devices.length === 0) findings.push(warning('splunk.junos-no-devices', 'No devices listed.', { source: 'SC4S documentation — Juniper' }));
      if (transport === 'udp' && srxs.length > 0) {
        findings.push(
          warning('splunk.junos-udp-srx', `UDP from ${srxs.length} SRX firewall${srxs.length === 1 ? '' : 's'}: session logs at load are thousands a second, and UDP drops them with no record once a buffer fills or SC4S restarts — the moments an incident needs them.`, {
            remediation: 'Use TCP or TLS.',
            source: 'SC4S documentation; Junos OS documentation — security log transport',
          }),
        );
      }
      const custom = [
        ...(netfw !== 'netfw' ? [`firewall → ${netfw}`] : []),
        ...(netids !== 'netids' ? [`IDP → ${netids}`] : []),
        ...(netops !== 'netops' ? [`operations → ${netops}`] : []),
      ];
      if (custom.length > 0) {
        findings.push(
          warning('splunk.junos-index-override', `Indexes other than SC4S’s defaults (${custom.join(', ')}). SC4S sends Juniper to netfw, netids and netops on its own, so until its splunk_metadata.csv overrides the Juniper keys the events land in the defaults and the searches here find nothing.`, {
            remediation: 'Add the index overrides for the Juniper keys to /opt/sc4s/local/context/splunk_metadata.csv — take the key names from the SC4S Juniper source page for your version — or keep the defaults.',
            source: 'SC4S documentation — Juniper',
          }),
        );
      }

      const tgt = target || '<sc4s>';
      const deviceFiles                           = {};
      for (const d of known) deviceFiles[`ops/device-config/${splunkName(d.name, 'device')}.txt`] = junosConfig(d, tgt, port, transport, ntp);

      const indexOf = (r           ) => (r === 'srx' ? netfw : netops);
      const indexes = [...new Set([...known.map((d) => indexOf(d.role)), ...(srxs.length > 0 ? [netids] : [])])];
      const indexList = indexes.length > 0 ? indexes.join(', ') : netops;
      const alertName = `Juniper device silent for ${silent} minutes`;
      const deniesReport = 'Juniper SRX - denied sessions - last 24 hours';
      const alertSearch = [
        '| inputlookup expected_juniper_devices.csv',
        '| eval key=mvappend(lower(device), ip)',
        '| mvexpand key',
        `| join type=left key [| tstats latest(_time) as last_seen where index IN (${indexList}) earliest=-7d by host | eval key=lower(host) | fields key, last_seen]`,
        '| stats max(last_seen) as last_seen, values(role) as role, values(ip) as ip by device',
        `| where isnull(last_seen) OR last_seen < relative_time(now(), "-${silent}m")`,
        '| eval last_seen=if(isnull(last_seen), "not in 7 days", strftime(last_seen, "%Y-%m-%d %H:%M:%S %Z"))',
        '| table device, ip, role, last_seen',
      ];
      const hostList = known.flatMap((d) => [d.name.toLowerCase(), ...(d.ip ? [d.ip] : [])]);

      return {
        tier: TIER,
        title: `Onboard ${known.length} Juniper device${known.length === 1 ? '' : 's'} into ${indexList} through SC4S`,
        app,
        activation: 'reload',
        notes: [
          'Add-on: Splunk Add-on for Juniper 1.6.1 (Splunkbase 2847), on the search heads — SC4S does the parsing and sends over HEC, so nothing is installed on SC4S itself.',
          `SC4S identifies Junos from the message: firewall (RT_FLOW and the other SRX session logs) as juniper:junos:firewall into ${netfw}, IDP as juniper:junos:idp into ${netids}, everything else into ${netops}.`,
          `ops/device-config/ has one file per device: NTP, UTC with the year and milliseconds, structured syslog to ${tgt}:${port} (${transport.toUpperCase()})${srxs.length > 0 ? ', and on SRX a security log stream so session logs come straight from the data plane' : ''}. Each file says what to capture first, how to load it with commit confirmed, and how to back it out.`,
          ...(srxs.length > 0 ? ['An SRX logs a session only where a security policy says "then log": the stream sends what the policies produce. Add session-close to the policies you need, and session-init to the deny policies.'] : []),
          `The alert "${alertName}" compares lookups/expected_juniper_devices.csv with what has arrived, by host name and by IP.`,
          'Palo Alto, Fortinet, Arista and Cisco go through "Onboard network devices", which has their device lines and add-ons.',
        ],
        before: [
          `| rest /services/data/indexes | search title IN (${indexList}) | table title, splunk_server`,
          '| rest /services/apps/local | search title=Splunk_TA_juniper | table title, version, splunk_server',
          `ss -ltnup | grep -E ':(514|6514)\\b'   # on ${tgt}: SC4S listening`,
          'show ntp associations   # on each device: synchronised before logging is turned on',
        ],
        files: {
          'default/app.conf': appConfLines(app, 'Juniper onboarding', 'Expected Juniper devices, the missing-device alert and SRX deny searches'),
          'default/transforms.conf': ['[expected_juniper_devices]', 'filename = expected_juniper_devices.csv', 'case_sensitive_match = false'],
          'lookups/expected_juniper_devices.csv': ['device,ip,role,index', ...known.map((d) => [d.name.toLowerCase(), d.ip, d.role, indexOf(d.role)].map(csvCell).join(','))],
          'default/savedsearches.conf': [
            `[${alertName}]`,
            `description = Every device in expected_juniper_devices.csv that has sent nothing to ${indexList} for ${silent} minutes.`,
            ...foldSearch(alertSearch),
            'dispatch.earliest_time = -7d',
            'dispatch.latest_time = now',
            ...alertLines(alertName, 15, 'device', '4h', email, 'Juniper device silent: $result.device$'),
            ...(srxs.length > 0
              ? [
                  '',
                  `[${deniesReport}]`,
                  'description = Sessions the SRX firewalls denied in the last 24 hours, by source, destination and policy. Field names are the Juniper add-on’s (VERIFY for 1.6.1).',
                  ...foldSearch([`index=${netfw} sourcetype=juniper:junos:firewall* earliest=-24h RT_FLOW_SESSION_DENY`, '| stats count by host, src, dest, dest_port, policy_name', '| sort - count']),
                  'dispatch.earliest_time = -24h',
                  'dispatch.latest_time = now',
                  'enableSched = 0',
                ]
              : []),
          ],
          'metadata/default.meta': defaultMeta(),
          ...(transport === 'tls'
            ? { 'ops/sc4s/env_file.snippet': ['# Add to /opt/sc4s/env_file, then restart SC4S.', '# TLS listens on 6514; the certificate goes in /opt/sc4s/tls/. VERIFY for your SC4S version.', 'SC4S_SOURCE_TLS_ENABLE=yes'] }
            : {}),
          ...deviceFiles,
        },
        verify: [
          `| tstats latest(_time) as last_seen, count where index IN (${indexList}) host IN (${hostList.length > 0 ? hostList.join(', ') : '*'}) earliest=-1h by host, sourcetype | eval last_seen=strftime(last_seen, "%F %T")`,
          `index IN (${indexList}) sourcetype=juniper:* earliest=-15m | stats count by sourcetype, index   # juniper:junos:firewall in ${netfw}, not only netops`,
          `index IN (${indexList}) sourcetype=juniper:* earliest=-15m | eval skew_s=_indextime-_time | stats avg(skew_s) as avg_skew_s by host   # hours of skew = a time zone problem`,
          `| savedsearch "${alertName}"   # nothing, once every device is sending`,
        ],
        backout: [
          'On each device: the "Back out" lines at the end of its file in ops/device-config/, then commit',
          `Remove ${app} from the search heads`,
          '# Events already indexed stay until the index retention removes them.',
        ],
        findings,
      };
    },
  }),
];
