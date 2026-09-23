/**
 * VCF Operations for Networks, and VCF Operations for Logs.
 *
 * Two capabilities of the same platform in 9.1, and the two most common places
 * an automation is *triggered* rather than executed: a flow that should not
 * exist, a log line that means something is about to fail. Neither of them acts
 * on its own — they raise something, and what listens is a webhook, a VCF
 * Automation action or a runbook.
 *
 * Which is why both of these emit a search or a query and the thing that
 * receives its result. A search on its own is a saved question nobody asks.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { applyScript } from '../apply.js';

const NETWORKS = 'vcf-operations-networks'         ;
const LOGS = 'vcf-operations-logs'         ;

// ---------------------------------------------------------------------------
// Shared: Networks login, and the Logs query structure
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
 * The body is the one PowervRNI's Connect-vRNIServer sends: username, password
 * and a domain of LOCAL/local, or LDAP and the directory domain.
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

/** The environment a scheduled Networks job needs, for a crontab line: no secret in it. */
export function networksScheduledEnv(account = 'svc-archtoolkit')         {
  return `VCFNET_HOST=vcfnet.example.com VCFNET_USER=${account} VCFNET_PASSWORD_FILE=/etc/archtoolkit/vcfnet-password`;
}

                                 
                                
                                                
                         
 

/**
 * A Logs chartQuery: a count of the events matching every constraint.
 *
 * The API takes it as a string holding JSON, not as an object. The keys are
 * the ones in the POST /api/v1/alerts example at vmw-loginsight.github.io,
 * without the start and end times, which an alert replaces with its own
 * search period. The platform does not publish a grammar for it; the reliable
 * way to get one right is to build the query in Explore Logs, save an alert
 * from it, and read its chartQuery back from GET /api/v1/alerts.
 */
export function logsChartQuery(constraints                           )         {
  const count = { label: 'Count', value: 'COUNT', requiresField: false, numericOnly: false };
  return JSON.stringify({
    query: '',
    piqlFunctionGroups: [{ functions: [count], field: null }],
    shouldGroupByTime: true,
    eventSortOrder: 'DESC',
    summarySortOrder: 'DESC',
    compareQueryOrderBy: 'TREND',
    compareQuerySortOrder: 'DESC',
    compareQueryOptions: null,
    messageViewType: 'EVENTS',
    constraintToggle: 'ALL',
    piqlFunction: count,
    piqlFunctionField: null,
    fieldConstraints: constraints.map((constraint) => ({ internalName: constraint.internalName, operator: constraint.operator, value: constraint.value })),
    supplementalConstraints: [],
    groupByFields: [],
    extractedFields: [],
  });
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
            '  -H "Authorization: NetworkInsight ${VCFNET_TOKEN}" \\',
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
          'crontab.txt': `# Daily at 05:30, from the directory holding run-check.sh and ${base}.json.\n# The password file is mode 600 and owned by the account that runs this.\n30 5 * * * cd /opt/archtoolkit/${base} && ${networksScheduledEnv()} ./run-check.sh\n`,
        },
        notes: [
          'Networks sees flows, not intent. A flow that appears here may be perfectly legitimate and undocumented, which is itself the finding.',
          'Run it for a month before anyone proposes acting on it. The first four weeks are mostly discovering what the boundary really carries.',
          'The body {query, size} for POST /api/ni/search/ql, the entity_list_response it returns, and the {username, password, domain} login body all follow PowervRNI (Invoke-vRNISearch, Connect-vRNIServer). The search condition names — source security group, destination security group, port — are the search bar’s; check the query returns what you expect there before scheduling it.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfnet_change_watch',
    platform: NETWORKS,
    label: 'Watch for NSX changes nobody raised',
    group: 'Change control',
    description:
      'A scheduled comparison of the NSX configuration against what it was, so a firewall rule added out of process is found in a day rather than at the next audit. Reports the difference; changes nothing.',
    inputs: [
      { id: 'watch_name', label: 'Name', control: 'text', default: 'NSX change watch' },
      {
        id: 'watch_what',
        label: 'Watch',
        control: 'select',
        options: [
          { value: 'dfw', label: 'Distributed firewall rules' },
          { value: 'groups', label: 'Security groups and their membership' },
          { value: 'segments', label: 'Segments and gateways' },
          { value: 'all', label: 'All of it' },
        ],
        default: 'dfw',
      },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/nsx-change' },
      { id: 'ignore_users', label: 'Ignore changes by', control: 'text', default: 'svc-terraform, svc-automation', hint: 'The accounts that are supposed to make changes' },
    ],
    automation: (values                 , name        )             => {
      const watchName = str(values, 'watch_name', 'NSX change watch');
      const what = str(values, 'watch_what', 'dfw');
      const webhook = str(values, 'webhook', '');
      const ignore = listOf(str(values, 'ignore_users', ''));
      const base = slugOf(name || watchName, 'nsx-change-watch');

      const findings            = [];
      if (ignore.length === 0) {
        findings.push(
          warning('vcfnet.change.no-exclusions', 'Nothing is excluded, so every change your own automation makes will be reported as unexpected.', {
            remediation: 'List the service accounts that are meant to change NSX. What is left is the interesting part.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: NETWORKS,
        title: `${watchName} — report NSX changes made outside the expected accounts`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Daily, comparing against the previous run', worstCase: 'once a day' },
        scope: {
          what: what === 'all' ? 'Firewall rules, security groups and segments.' : what === 'dfw' ? 'Distributed firewall rules.' : what === 'groups' ? 'Security groups and membership.' : 'Segments and gateways.',
          decidedBy: ['What the previous run recorded.', ignore.length > 0 ? `Changes by ${ignore.join(', ')} are ignored.` : 'No accounts are ignored.'],
          ifWrong: 'A noisy report, or one that misses a change because the account making it was on the ignore list. Review that list as carefully as the report.',
        },
        guardrails: [
          { rule: 'Compares and reports; never reverts', because: 'Reverting a network change automatically, without knowing why it was made, is how a fix becomes an outage.' },
          ...(ignore.length > 0 ? [{ rule: `Changes by ${ignore.join(', ')} are expected`, because: 'Your own automation changing NSX is not a finding. Everything else is.' }] : []),
        ],
        dryRun: ['The first run has nothing to compare against and simply records the baseline. Keep that file; it is the reference.'],
        undo: ['Nothing to undo. Reverting an NSX change is a change of its own and belongs in the change process.'],
        told: webhook ? [`Posted to ${webhook}.`] : ['Nobody. Set a destination.'],
        requires: ['Read access to the NSX manager through Networks, and somewhere to keep the previous run’s baseline.'],
        files: {
          [`${base}.json`]: `${JSON.stringify({ name: watchName, watch: what, ignoreAccounts: ignore, destination: webhook || '<REQUIRED>', reportOnly: true, baselineFile: `${base}-baseline.json` }, null, 2)}\n`,
        },
        notes: [
          'An out-of-process firewall change is usually somebody fixing something at speed. The value here is the conversation the next morning, not the blame.',
          'Keep the baseline in version control rather than on the appliance. Then the diff is a commit, and the history is free.',
        ],
        findings,
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// VCF Operations for Logs
// ---------------------------------------------------------------------------

export const LOGS_AUTOMATIONS                                 = [
  automationBlueprint({
    id: 'vcflog_alert_webhook',
    platform: LOGS,
    label: 'Raise an alert from a log query',
    group: 'Alerting',
    description:
      'A count alert: more than so many matching lines in a window, posted to a webhook. The thing that goes wrong here is not the query — it is that the query matches ten thousand events an hour and the alert becomes its own incident. Logs has no separate rate limit; after a count alert fires it stays quiet for its own window, so the window is the rate limit.',
    inputs: [
      { id: 'alert_name', label: 'Alert name', control: 'text', default: 'ESXi storage path failure' },
      { id: 'match_text', label: 'Lines containing', control: 'text', default: 'Lost path redundancy', hint: 'One phrase. A second phrase is a second alert, or an OR built in Explore Logs' },
      { id: 'host_prefix', label: 'From hosts starting with', control: 'text', default: 'esx', hint: 'Empty matches every source' },
      { id: 'threshold', label: 'Fire when more than', control: 'number', default: 5, min: 0, max: 100000, hint: 'Events in the window' },
      { id: 'window_minutes', label: 'In (minutes)', control: 'number', default: 15, min: 1, max: 1440, hint: 'Also how long it stays quiet after firing' },
      { id: 'webhook', label: 'Send to', control: 'text', default: 'https://runbooks.example.com/hooks/logs' },
    ],
    automation: (values                 , name        )             => {
      const alertName = str(values, 'alert_name', 'Log alert');
      const matchText = str(values, 'match_text', '');
      const hostPrefix = str(values, 'host_prefix', '');
      const threshold = num(values, 'threshold', 5);
      const windowMinutes = Math.max(1, num(values, 'window_minutes', 15));
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || alertName, 'log-alert');

      const findings            = [];
      if (windowMinutes < 5) {
        findings.push(
          error('vcflog.alert.no-rate-limit', `A ${windowMinutes}-minute window is, in effect, no rate limit: through a log storm this notifies every ${windowMinutes} minute${windowMinutes === 1 ? '' : 's'}.`, {
            remediation: 'Logs has no separate re-fire setting. After a count alert fires it is snoozed for its own time period, so the window is the quiet period. Fifteen to sixty minutes is usually right; raise the threshold with it.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (threshold <= 1) {
        findings.push(
          warning('vcflog.alert.hair-trigger', `A threshold of ${threshold} means one or two lines page somebody.`, {
            remediation: 'For a genuinely fatal message that is right. For anything that happens transiently it is not — use a count over a window.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!matchText) {
        findings.push(error('vcflog.alert.no-match', 'No text to match, so the alert counts every line from these sources.', { source: 'ArchToolKit' }));
      }
      if (/\s/.test(webhook)) {
        findings.push(error('vcflog.alert.webhook-space', 'The webhook address contains a space. Logs reads webhookURLs as a space-separated list, so this becomes two addresses.', { source: 'ArchToolKit' }));
      }

      const constraints                   = [
        ...(matchText ? [{ internalName: 'text', operator: 'CONTAINS'         , value: matchText }] : []),
        ...(hostPrefix ? [{ internalName: 'hostname', operator: 'STARTS_WITH'         , value: hostPrefix }] : []),
      ];

      // The POST /api/v1/alerts schema: a RATE_BASED alert fires when the count
      // of events matching chartQuery in searchPeriod milliseconds is more than
      // hitCount. chartQuery is a string holding JSON. webhookURLs is a
      // space-separated string.
      const definition = {
        name: alertName,
        info: `Generated by ArchToolKit. More than ${threshold} matching events in ${windowMinutes} minutes.`,
        recommendation: 'Confirm against the metric before acting: a log line says something was written, not that something is broken.',
        alertType: 'RATE_BASED',
        hitCount: threshold,
        hitOperator: 'GREATER_THAN',
        searchPeriod: windowMinutes * 60000,
        chartQuery: logsChartQuery(constraints),
        enabled: false,
        emailEnabled: false,
        vcopsEnabled: false,
        webhookEnabled: Boolean(webhook),
        webhookURLs: webhook,
        autoClearAlertAfterTimeout: false,
      };

      return {
        platform: LOGS,
        title: `${alertName} — fire when more than ${threshold} matching events arrive in ${windowMinutes} minutes`,
        effect: 'read',
        trigger: {
          kind: 'alert',
          detail: `More than ${threshold} events matching the query in the last ${windowMinutes} minutes, evaluated on the platform’s own schedule`,
          worstCase: `once every ${windowMinutes} minutes while the condition holds — after firing, a count alert is snoozed for its own window`,
        },
        scope: {
          what: `Log events whose text contains "${matchText || '(anything)'}"${hostPrefix ? `, from hosts whose name starts with ${hostPrefix}` : ', from every source'}.`,
          decidedBy: [
            matchText ? `text CONTAINS "${matchText}".` : 'No text constraint.',
            hostPrefix ? `hostname STARTS_WITH "${hostPrefix}".` : 'No source filter, so every host shipping logs.',
            `The threshold: more than ${threshold} in ${windowMinutes} minutes.`,
          ],
          ifWrong: 'Either nobody is told about a real failure, or everybody is told about a normal one until they mute the channel. The second is more common and more damaging.',
        },
        guardrails: [
          { rule: `Quiet for ${windowMinutes} minutes after it fires`, because: 'Logs snoozes a count alert for the duration of its time period once it has fired, so a storm that lasts an hour notifies about once per window rather than once per line. That is the only rate limit there is: to hear less often, lengthen the window and raise the threshold with it.' },
          { rule: `A count over ${windowMinutes} minutes, not a single line`, because: 'Almost every log message worth alerting on appears once harmlessly before it appears repeatedly.' },
          { rule: 'Sent with enabled set to false', because: 'Turn it on after you have run the query over a week of history and know what it would have done. The published create schema does not list enabled, so check the created alert rather than trusting the request.' },
        ],
        dryRun: [
          'Build the same query in Explore Logs over the last seven days.',
          'Count the times it would have crossed the threshold. That is how often this will notify somebody.',
          'apply.sh prints what it would send unless given --execute. After it runs, GET /api/v1/alerts/{id} and confirm enabled is false; if it is not, disable it under Alerts before anything fires.',
        ],
        undo: ['Disable it under Alerts > Alert Definitions, or DELETE /api/v1/alerts/{id}. Nothing that already fired is recalled.'],
        told: webhook
          ? [`Posted to ${webhook}. The notification carries up to 200 of the matching events, the total count and a link back to Explore Logs.`, 'A delivery that does not get a 2xx back is retried later by Logs.']
          : ['Nobody — no destination set. The alert still appears under Triggered Alerts.'],
        requires: ['The relevant hosts shipping logs, and enough retention to cover the window you test against.', 'A Logs account allowed to create alerts: VCFLOGS_USER and VCFLOGS_PASSWORD_FILE, or VCFLOGS_TOKEN by hand.'],
        files: {
          [`${base}.json`]: `${JSON.stringify(definition, null, 2)}\n`,
          'apply.sh': applyScript(LOGS, [{ method: 'POST', path: '/api/v1/alerts', payload: `${base}.json` }], 'disable the alert under Alerts > Alert Definitions, or DELETE /api/v1/alerts/{id} with the id it returned.'),
        },
        notes: [
          'A log alert tells you something was written, not that something is broken. Pair it with the metric that confirms it before anybody is woken up.',
          'The payload follows the POST /api/v1/alerts schema published at vmw-loginsight.github.io: alertType, hitCount, hitOperator, searchPeriod in milliseconds (at least 60000), chartQuery as a JSON string, webhookEnabled and a space-separated webhookURLs. Recent releases choose a named webhook in the interface instead; if the URL list is ignored on yours, pick the webhook there after creating the alert.',
          'The chartQuery was written from the published example, not exported from 9.1. The surest check is to build the query in Explore Logs, save an alert from it, and compare its chartQuery (GET /api/v1/alerts) with the one here.',
          'Narrow by source first, then by text. A CONTAINS across every source is the expensive query.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcflog_audit_trail',
    platform: LOGS,
    label: 'Keep an audit trail of what automation did',
    group: 'Audit',
    description:
      'The other half of every automation in this kit: somewhere the record goes that is not the appliance that did it. A query and a scheduled export, so "what changed last night" is answerable without logging into four systems.',
    inputs: [
      { id: 'trail_name', label: 'Name', control: 'text', default: 'Automation audit trail' },
      { id: 'accounts', label: 'Service accounts to follow', control: 'text', default: 'svc-automation, svc-vcfops, svc-terraform' },
      { id: 'retention_days', label: 'Keep for (days)', control: 'number', default: 400, min: 30, max: 3650, hint: '400 covers a year plus the audit' },
      { id: 'export_to', label: 'Export to', control: 'text', default: 's3://audit-archive/vcf/', hint: 'Somewhere outside the platform being audited' },
    ],
    automation: (values                 , name        )             => {
      const trailName = str(values, 'trail_name', 'Audit trail');
      const accounts = listOf(str(values, 'accounts', ''));
      const retention = num(values, 'retention_days', 400);
      const exportTo = str(values, 'export_to', '');
      const base = slugOf(name || trailName, 'audit-trail');

      const findings            = [];
      if (!exportTo) {
        findings.push(
          warning('vcflog.audit.no-export', 'The trail stays on the platform it is auditing.', {
            remediation: 'An audit trail that lives on the system being audited is not an audit trail. Export it somewhere with different credentials.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (retention < 90) {
        findings.push(
          warning('vcflog.audit.short-retention', `${retention} days will not cover an audit that asks about last quarter.`, { source: 'ArchToolKit' }),
        );
      }

      const query = accounts.length > 0 ? accounts.map((account) => `user CONTAINS "${account}"`).join(' OR ') : 'user EXISTS';

      return {
        platform: LOGS,
        title: `${trailName} — everything the automation accounts did, kept ${retention} days`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Daily export of the previous day', worstCase: 'once a day' },
        scope: {
          what: accounts.length > 0 ? `Events attributed to ${accounts.join(', ')}.` : 'Every event with a user on it.',
          decidedBy: ['The account list above.', 'Whatever those accounts are actually used for — check that none of them is also a human’s day-to-day login.'],
          ifWrong: 'The trail is incomplete and nobody notices until it is needed, which is the worst possible time to find out.',
        },
        guardrails: [
          { rule: 'Reads only', because: 'An audit trail that can be written to by the thing it audits is not evidence.' },
          ...(exportTo ? [{ rule: `Exported to ${exportTo}`, because: 'Different system, different credentials. That is what makes it a trail rather than a log.' }] : []),
        ],
        dryRun: ['Run the query for yesterday and read it. If an account you expected is absent, it is not logging what you think it is.'],
        undo: ['Nothing to undo.'],
        told: ['Nobody routinely — this is a record rather than an alert. Alert only on the trail going quiet, which means collection has stopped.'],
        requires: ['The automation accounts to be distinct from human accounts, or the trail cannot separate the two.'],
        files: {
          [`${base}.json`]: `${JSON.stringify({ name: trailName, query, schedule: 'daily', retentionDays: retention, exportTo: exportTo || '<REQUIRED>', format: 'json' }, null, 2)}\n`,
        },
        notes: [
          'Alert on the absence of events, not just their content. A trail that goes silent looks exactly like a quiet night.',
          'Every automation in this kit has a "who is told" section. This is where those records should end up.',
        ],
        findings,
      };
    },
  }),
];
