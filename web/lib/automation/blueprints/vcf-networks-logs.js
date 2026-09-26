/**
 * VCF Operations for Networks.
 *
 * The place an automation is most often *triggered* rather than executed: a
 * flow that should not exist. Networks does not act on its own — it raises
 * something, and what listens is a webhook, a VCF Automation action or a
 * runbook.
 *
 * Which is why these emit a search and the thing that receives its result. A
 * search on its own is a saved question nobody asks.
 *
 * (The 9.1 log management blueprints are in vcf-ops-operate.ts; the shared
 * IMPORT.md builder stays here because the Networks and fleet files use it.)
 */

import { num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { envCheck, mailServerStep, NET_SRC, notificationInputs, notifyAny, notifyDescribe, notifyJson, notifyPlan, notifyShell, searchAlertShell, SEVERITY_OPTIONS } from './vcf-networks-common.js';

const NETWORKS = 'vcf-operations-networks'         ;

// ---------------------------------------------------------------------------
// Shared: Networks login
// ---------------------------------------------------------------------------

/**
 * The environment lines every Networks script opens with.
 *
 * apply.ts has no Networks target, so this is its authPreamble written out for
 * /api/ni. A token handed in directly suits a person at a terminal; a scheduled
 * job sets VCFNET_USER and VCFNET_PASSWORD_FILE instead and logs in for itself.
 * The password is read from a file only its owner can read and sent on stdin,
 * so it never appears in a crontab, a process list or the shell history.
 *
 * The body is POST /api/ni/auth/token's: username, password and a domain of
 * LOCAL/local, or LDAP and the directory domain.
 */
export function networksPreamble()           {
  return [
    'if [[ -z "${VCFNET_TOKEN:-}" && -n "${VCFNET_PASSWORD_FILE:-}" ]]; then',
    '  : "${VCFNET_HOST:?set VCFNET_HOST, e.g. vcfnet.example.com}"',
    '  : "${VCFNET_USER:?set VCFNET_USER to the account VCFNET_PASSWORD_FILE belongs to}"',
    '  command -v jq >/dev/null || { echo "jq is required to log in" >&2; exit 2; }',
    '  # LOCAL/local for a local account; LDAP and the directory domain otherwise.',
    '  VCFNET_TOKEN=$(jq -n --arg u "$VCFNET_USER" --arg t "${VCFNET_DOMAIN_TYPE:-LOCAL}" --arg d "${VCFNET_DOMAIN:-local}" \\',
    '      --rawfile p "$VCFNET_PASSWORD_FILE" \'($p | rtrimstr("\\n")) as $p | {username: $u, password: $p, domain: {domain_type: $t, value: $d}}\' |',
    '    curl -sS -f -X POST "https://${VCFNET_HOST}/api/ni/auth/token" -H "Accept: application/json" -H "Content-Type: application/json" --data @- | jq -r \'.token // empty\')',
    '  [[ -n "$VCFNET_TOKEN" ]] || { echo "Networks login returned no token" >&2; exit 2; }',
    'fi',
    ': "${VCFNET_HOST:?set VCFNET_HOST, e.g. vcfnet.example.com}"',
    ': "${VCFNET_TOKEN:?set VCFNET_TOKEN (POST /api/ni/auth/token), or set VCFNET_USER and VCFNET_PASSWORD_FILE to a file holding its password, mode 600}"',
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
  ];
}

/**
 * The login, then `ni METHOD PATH [curl args]` for JSON calls and
 * `ni_form METHOD PATH [curl args]` for multipart uploads. The token goes in a
 * header read from a process substitution, never on the command line.
 */
export function networksApi()           {
  return [
    ...networksPreamble(),
    '',
    'ni() {',
    '  local method="$1" path="$2"; shift 2',
    '  curl -sS -f -X "$method" "https://${VCFNET_HOST}/api/ni${path}" \\',
    '    -H @<(printf \'Authorization: NetworkInsight %s\\n\' "$VCFNET_TOKEN") \\',
    '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
    'ni_form() {',
    '  local method="$1" path="$2"; shift 2',
    '  curl -sS -f -X "$method" "https://${VCFNET_HOST}/api/ni${path}" \\',
    '    -H @<(printf \'Authorization: NetworkInsight %s\\n\' "$VCFNET_TOKEN") \\',
    '    -H "Accept: application/json" "$@"',
    '}',
  ];
}

/** The environment a scheduled Networks job needs, for a crontab line: no secret in it. */
export function networksScheduledEnv(account = 'svc-automation')         {
  return `VCFNET_HOST=vcfnet.example.com VCFNET_USER=${account} VCFNET_PASSWORD_FILE=/etc/vcf-automation/vcfnet-password`;
}

// ---------------------------------------------------------------------------
// Shared: IMPORT.md
// ---------------------------------------------------------------------------

                                 
                           
                                    
 

/**
 * IMPORT.md for the Logs, Networks and fleet blueprints: numbered steps in the
 * order they have to happen, each naming the file and exactly where it goes —
 * a menu path or one command — then what is confirmed, what is not, and where
 * it was established. Anything marked VERIFY was not in those sources.
 */
export function importGuide(opts   
                           
                         
                                                          
                                      
                                      
 )         {
  const steps = opts.steps.filter((step)                         => step !== undefined);
  return [
    `# Importing this into ${opts.product}`,
    '',
    opts.intro,
    '',
    ...(steps.length > 1 ? ['Do the steps in order. Every script applies when run; add `--dry-run` to preview.', ''] : []),
    ...steps.flatMap((step, index) => [`## ${index + 1}. ${step.heading}`, '', ...step.lines, '']),
    '## Confirmed, and what to verify',
    '',
    ...(opts.verify && opts.verify.length > 0 ? opts.verify.map((line) => `- ${line}`) : ['- Nothing beyond what the steps say.']),
    '',
    '## Sources',
    '',
    ...opts.sources.map((line) => `- ${line}`),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// VCF Operations for Networks
// ---------------------------------------------------------------------------

export const NETWORKS_AUTOMATIONS                                 = [
  automationBlueprint({
    id: 'vcfnet_flow_check',
    platform: NETWORKS,
    label: 'Check for flows that should not exist',
    group: 'Segmentation',
    description:
      'The question a segmentation project needs answered every week and nobody asks after the first month: is anything still talking across the boundary we closed? A saved search, on a schedule, that reports rather than blocks — because a network automation that blocks on its own findings is how a data centre goes dark.',
    inputs: [
      { id: 'check_name', label: 'Check name', control: 'text', default: 'PCI zone — unexpected flows' },
      { id: 'source', label: 'From', control: 'text', default: "source security group = 'PCI'", hint: 'A condition in the Networks search bar’s language' },
      { id: 'destination', label: 'To', control: 'text', default: "destination security group != 'PCI'" },
      { id: 'allowed_ports', label: 'Except on ports', control: 'text', default: '443, 53', hint: 'The flows you already accept' },
      { id: 'window_hours', label: 'Look back (hours)', control: 'number', default: 24, min: 1, max: 720 },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/segmentation' },
    ],
    automation: (values                 , name        )             => {
      const checkName = str(values, 'check_name', 'Flow check');
      const source = str(values, 'source', '');
      const destination = str(values, 'destination', '');
      const allowed = listOf(str(values, 'allowed_ports', ''));
      const hours = num(values, 'window_hours', 24);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || checkName, 'flow-check');

      // The search bar's language, sent as-is to POST /api/ni/search/ql. Each
      // excepted port is its own != so the query uses only plain comparisons.
      const conditions = [source, destination, ...allowed.map((port) => `port != ${port}`)].map((part) => part.trim()).filter(Boolean);
      const search = conditions.length > 0 ? `flows where ${conditions.join(' and ')} in last ${hours} hours` : `flows in last ${hours} hours`;

      const findings            = [];
      if (!source.trim() || !destination.trim()) {
        findings.push(error('vcfnet.flow.no-boundary', 'Without both a From and a To there is no boundary, so the check reports ordinary traffic.', { source: 'ArchToolKit' }));
      }
      if (allowed.length === 0) {
        findings.push(
          warning('vcfnet.flow.no-allowlist', 'No ports are excepted, so every legitimate flow across the boundary will be reported too.', {
            remediation: 'List what you already accept. A check that reports two thousand expected flows is a check somebody turns off.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: NETWORKS,
        title: `${checkName} — report flows crossing a boundary that should be closed`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Daily, over the last ${hours} hours`, worstCase: 'once a day' },
        scope: {
          what: 'Observed flows only. It reads what happened; it changes no rule and blocks nothing.',
          decidedBy: [
            `The search: ${source}.`,
            `To: ${destination}.`,
            allowed.length > 0 ? `Excluding ports ${allowed.join(', ')}.` : 'No port exclusions.',
            `Over the last ${hours} hours of collected flow data.`,
          ],
          ifWrong: 'You get a noisy report, or a quiet one that is hiding something. Neither breaks anything, which is the point of keeping this read-only.',
        },
        guardrails: [
          { rule: 'It reports; it never writes a firewall rule', because: 'An automation that closes flows on its own findings will close a flow that was load-bearing, at the worst possible moment, with no change record.' },
          { rule: 'Bounded to a time window', because: 'Flow data is large. An unbounded search is a slow query and an expensive one.' },
        ],
        dryRun: [`Paste the search into the Networks search bar first and look at what comes back: ${search}`, 'The result is the dry run; there is no acting version of this.'],
        undo: ['Nothing to undo. It reads.'],
        told: webhook
          ? [`Posted to ${webhook} when any flow matches: the count, the search and the first hundred flow ids. Nothing is posted on a clean run, and nothing when the search itself fails — that is the exit code’s job.`, 'Send it somewhere a person reviews weekly rather than to an alert channel — this is a review, not an incident.']
          : ['Nobody — set a destination, or this is a search nobody runs.'],
        requires: [
          'Flow collection from the relevant vCenter and NSX sources, and enough retention to cover the window.',
          'A read-only Networks account: VCFNET_USER and VCFNET_PASSWORD_FILE for a scheduled run, or VCFNET_TOKEN by hand.',
          'jq and curl.',
        ],
        files: {
          [`${base}.json`]: `${JSON.stringify({ name: checkName, search, schedule: 'daily', destination: webhook || '<REQUIRED>', reportOnly: true }, null, 2)}\n`,
          'run-check.sh': [
            '#!/usr/bin/env bash',
            '# Run the flow search and report what it found. Reads only.',
            '#',
            '# Exits 0 when nothing matched, 1 when flows crossed the boundary, and 2',
            '# when the search itself failed — so a scheduler can tell "something to',
            '# look at" from "the check is broken". A failed search is never posted as',
            '# if it were a result.',
            'set -euo pipefail',
            '',
            ...networksPreamble(),
            '',
            'RESULT=$(mktemp)',
            'trap \'rm -f "$RESULT"\' EXIT',
            '',
            '# POST /api/ni/search/ql takes the search bar’s language: {query, size}.',
            `HTTP=$(jq '{query: .search, size: 100}' ${base}.json | curl -sS -o "$RESULT" -w '%{http_code}' \\`,
            '  -X POST "https://${VCFNET_HOST}/api/ni/search/ql" \\',
            '  -H @<(printf \'Authorization: NetworkInsight %s\\n\' "$VCFNET_TOKEN") \\',
            '  -H "Accept: application/json" -H "Content-Type: application/json" \\',
            '  --data @-) || { echo "Networks did not answer" >&2; exit 2; }',
            'if [[ "$HTTP" != 2* ]]; then',
            '  echo "Search failed: HTTP ${HTTP}" >&2',
            '  head -c 500 "$RESULT" >&2; echo >&2',
            '  exit 2',
            'fi',
            '# A flow search answers with an entity list. Anything else is not a result.',
            'if ! jq -e \'.entity_list_response | type == "object"\' "$RESULT" >/dev/null; then',
            '  echo "Search returned no entity list; check the query in the search bar." >&2',
            '  exit 2',
            'fi',
            '',
            'TOTAL=$(jq -r \'.entity_list_response.total_count // 0\' "$RESULT")',
            `echo '${checkName.replace(/'/g, "'\\''")}'": \${TOTAL} flow(s)"`,
            'if (( TOTAL == 0 )); then',
            '  exit 0',
            'fi',
            'jq -r \'.entity_list_response.results[]? | .entity_id\' "$RESULT"',
            ...(webhook
              ? [
                  '',
                  `jq -n --arg check '${checkName.replace(/'/g, "'\\''")}' --arg search "$(jq -r .search ${base}.json)" --argjson total "$TOTAL" \\`,
                  '  --slurpfile r "$RESULT" \'{source: "vcfnet-flow-check", check: $check, search: $search, total: $total, flows: [$r[0].entity_list_response.results[]?.entity_id]}\' \\',
                  `  | curl -sS -f -X POST '${webhook.replace(/'/g, "'\\''")}' -H "Content-Type: application/json" --data @- >/dev/null \\`,
                  '  || echo "Could not post to the webhook." >&2',
                ]
              : []),
            'exit 1',
            '',
          ].join('\n'),
          'crontab.txt': `# Daily at 05:30, from the directory holding run-check.sh and ${base}.json.\n# The password file is mode 600 and owned by the account that runs this.\n30 5 * * * cd /opt/vcf-automation/${base} && ${networksScheduledEnv()} ./run-check.sh\n`,
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Networks',
            intro: `Networks has no file import for a search or a saved search. What goes into the product is the search text; what runs it is run-check.sh on a schedule. ${base}.json is read by run-check.sh, not by Networks.`,
            steps: [
              {
                heading: 'Put the search into Networks',
                lines: [
                  'Paste this into the search bar at the top of the Networks interface, run it, and read what comes back:',
                  '',
                  '```',
                  search,
                  '```',
                  '',
                  'To keep it in the product, save it from the results page (the save/bookmark action beside the search bar) under the check name. That is the only route: there is no import dialog or documented API for saved searches (VERIFY on your release).',
                ],
              },
              {
                heading: 'Schedule run-check.sh',
                lines: [
                  `Copy run-check.sh and ${base}.json to /opt/vcf-automation/${base} on a host that reaches Networks, run \`./run-check.sh\` once by hand, then install the line in crontab.txt with \`crontab -e\`. POST /api/ni/search/ql takes {query, size} — the body the script builds from ${base}.json.`,
                ],
              },
            ],
            verify: ['The search condition names (security group, port) are the search bar’s own; if the search bar rejects them, so will the API.'],
            sources: ['POST /api/ni/search/ql {query, size, time_range} and POST /api/ni/auth/token {username, password, domain}: VCF Operations for Networks API reference (Search, Authentication).'],
          }),
        },
        notes: [
          'Networks sees flows, not intent. A flow that appears here may be perfectly legitimate and undocumented, which is itself the finding.',
          'Run it for a month before anyone proposes acting on it. The first four weeks are mostly discovering what the boundary really carries.',
          'POST /api/ni/search/ql takes {query, size, time_range} and the login body is {username, password, domain}, both from the VCF Operations for Networks API reference. The entity_list_response shape is VERIFY: check the first run’s output. The search condition names — source security group, destination security group, port — are the search bar’s; check the query returns what you expect there before scheduling it.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfnet_change_watch',
    platform: NETWORKS,
    label: 'Alert on NSX changes (firewall rules, groups, segments, gateways)',
    group: 'Change control',
    description:
      'A search-based change alert in Networks for each part of NSX being watched: the alert fires whenever the search result changes — a firewall rule added, a group edited, a segment removed — and notifies by e-mail, SNMP trap, syslog or webhook. Applied through the API and created enabled; it reports the change and never reverts it.',
    inputs: [
      { id: 'watch_name', label: 'Name', control: 'text', default: 'NSX change watch' },
      {
        id: 'watch_what',
        label: 'Watch',
        control: 'select',
        options: [
          { value: 'dfw', label: 'Distributed firewall rules' },
          { value: 'groups', label: 'Security groups and their membership' },
          { value: 'segments', label: 'Segments' },
          { value: 'gateways', label: 'Tier-0 / Tier-1 gateways' },
          { value: 'all', label: 'All of it (one alert each)' },
        ],
        default: 'dfw',
      },
      { id: 'query', label: 'Search (override)', control: 'text', default: '', hint: 'Empty uses the search for what is watched. Try it in the search bar first' },
      { id: 'severity', label: 'Severity', control: 'select', options: SEVERITY_OPTIONS, default: 'Moderate' },
      ...notificationInputs().map((input) => (input.id === 'notify_webhook' ? { ...input, default: 'https://runbooks.example.com/hooks/nsx-change' } : input)),
    ],
    automation: (values                 , name        )             => {
      const watchName = str(values, 'watch_name', 'NSX change watch');
      const what = str(values, 'watch_what', 'dfw');
      const override = str(values, 'query', '');
      const severity = str(values, 'severity', 'Moderate');
      const plan = notifyPlan(values);
      const base = slugOf(name || watchName, 'nsx-change-watch');

      const parts = what === 'all' ? ['dfw', 'groups', 'segments', 'gateways'] : [CHANGE_WATCH[what] ? what : 'dfw'];
      const alerts = parts.map((part) => ({
        alert_name: parts.length > 1 ? `${watchName} — ${CHANGE_WATCH[part] .label}` : watchName,
        search_criteria: override && parts.length === 1 ? override : CHANGE_WATCH[part] .query,
        generate_alert_criteria: 'SEARCH_RESULT_CHANGE',
        alert_type: 'CHANGE',
        severity,
      }));

      const findings            = [...plan.findings];
      if (!notifyAny(plan)) {
        findings.push(warning('vcfnet.change.nobody-told', 'No destination is set: the alert shows in Networks and nobody is told.', { remediation: 'Give it an e-mail, a trap receiver, syslog or a webhook.', source: NET_SRC }));
      }
      if (override && parts.length > 1) {
        findings.push(warning('vcfnet.change.override-ignored', 'A search override applies to one watched part only; with "All of it" each part keeps its own search.', { source: NET_SRC }));
      }

      const script = [
        '#!/usr/bin/env bash',
        `# Create (or update) ${alerts.length} search-based change alert(s) in VCF Operations for Networks,`,
        '# enabled, with their notification destinations. --dry-run prints each body.',
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
        'NS=$(setup_notify)',
        'for body in alerts/*.json; do upsert_alert "$body" "$NS"; done',
        '(( DRY_RUN )) && echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        'exit 0',
        '',
      ].join('\n');

      const files                         = {
        [`${base}.sh`]: script,
        'notify.json': `${JSON.stringify(notifyJson(plan, `${base}-traps`), null, 2)}\n`,
      };
      for (const alert of alerts) files[`alerts/${slugOf(alert.alert_name, 'alert')}.json`] = `${JSON.stringify(alert, null, 2)}\n`;
      files['IMPORT.md'] = importGuide({
        product: 'VCF Operations for Networks',
        intro: `${base}.sh creates each alert in alerts/ through POST /api/ni/settings/alerts/search-based-alerts (or updates the one with the same name) and enables it. notify.json holds the destinations; secrets come from the environment.`,
        steps: [
          mailServerStep(plan),
          {
            heading: 'Apply',
            lines: [
              `${plan.env.length > 0 ? `Export ${plan.env.join(', ')} from your vault, then run` : 'Run'} \`./${base}.sh\` (\`--dry-run\` prints every body first). Each search is run once before its alert is written, so a search the product rejects stops the script.`,
              '',
              'By hand: Settings > Alerts > Search based alerts > Add, one per file in alerts/, alert type Change, raised when the search results change.',
            ],
          },
        ],
        verify: [
          'The search strings for firewall rules, security groups, segments and gateways are the search bar’s entity names; if one returns nothing there, put your own in Search (override).',
          'notification_settings type SNMP takes the SNMP trap profile id as its receiver (the API reference does not say what receivers holds for SNMP).',
          'That user-defined alerts reach the databus "problems" message group (the webhook): check the first alert arrives.',
        ],
        sources: [
          'VCF Operations for Networks API reference, Settings: Search Based Alert Config (alert_name, search_criteria, generate_alert_criteria SEARCH_RESULT_CHANGE | ZERO_SEARCH_RESULTS, alert_type PROBLEM | CHANGE | INTENT, severity, notification_settings type EMAIL | SNMP), SNMP trap destination profiles, syslog targets, databus subscribers. User-defined events are deprecated there in favour of search-based alerts.',
        ],
      });

      return {
        platform: NETWORKS,
        title: `${watchName} — alert when ${parts.map((part) => CHANGE_WATCH[part] .label.toLowerCase()).join(', ')} change`,
        effect: 'reversible',
        trigger: { kind: 'alert', detail: `Networks raises the alert whenever the search result changes: ${alerts.map((alert) => alert.search_criteria).join('; ')}.`, worstCase: 'once per change Networks sees, at its collection interval' },
        scope: {
          what: 'Alert definitions in Networks only. Nothing in NSX is changed; Networks already collects NSX.',
          decidedBy: alerts.map((alert) => `"${alert.alert_name}": ${alert.search_criteria}.`),
          ifWrong: 'A search wider than meant alerts on every change anywhere it matches; a narrower one misses the change you wanted to see. Neither touches NSX.',
        },
        guardrails: [
          { rule: 'Alerts; never reverts', because: 'Reverting a network change automatically, without knowing why it was made, is how a fix becomes an outage.' },
          { rule: 'Each search is run once before its alert is written', because: 'A search the product rejects would make an alert that never fires.' },
          { rule: 'Updates by name instead of adding a duplicate', because: 'Two alerts on the same search send every change twice.' },
        ],
        dryRun: [`Run ./${base}.sh --dry-run. It runs each search, then prints every alert body it would send, and creates nothing.`],
        undo: ['DELETE /api/ni/settings/alerts/search-based-alerts/{id} for each id in created-alert-ids.txt, or POST .../{id}/disable to switch it off; or Settings > Alerts.'],
        told: notifyAny(plan) ? notifyDescribe(plan) : ['Nobody — set a destination.'],
        requires: [
          'NSX Manager added as a data source in Networks.',
          'A Networks admin account: VCFNET_USER and VCFNET_PASSWORD_FILE, or VCFNET_TOKEN.',
          ...plan.env.map((variable) => `${variable} from your vault.`),
          'jq and curl.',
        ],
        files,
        notes: [
          'An out-of-process firewall change is usually somebody fixing something at speed. The value here is the conversation the next morning, not the blame.',
          'The alert says what changed, not who changed it: search-based alerts do not filter on the account. The NSX audit log (VCF Operations for Logs) has the who.',
        ],
        findings,
      };
    },
  }),
];

/** Search bar entity names for each watched part. VERIFY each in the search bar. */
const CHANGE_WATCH                                                             = {
  dfw: { label: 'Firewall rules', query: 'NSX-T Firewall Rule' },
  groups: { label: 'Security groups', query: 'NSX Policy Group' },
  segments: { label: 'Segments', query: 'NSX Policy Segment' },
  gateways: { label: 'Gateways', query: 'NSX-T Router' },
};
