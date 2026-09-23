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

const NETWORKS = 'vcf-operations-networks'         ;
const LOGS = 'vcf-operations-logs'         ;

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
      { id: 'source', label: 'From', control: 'text', default: 'security_group == "PCI"', hint: 'A Networks search expression' },
      { id: 'destination', label: 'To', control: 'text', default: 'security_group != "PCI"' },
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

      const search = `flow where ${source} and destination.${destination.replace(/^\s*/, '')}${allowed.length > 0 ? ` and port not in (${allowed.join(', ')})` : ''} in last ${hours} hours`;

      const findings            = [];
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
        dryRun: ['Run the search in the interface first and look at what comes back. The result is the dry run; there is no acting version of this.'],
        undo: ['Nothing to undo. It reads.'],
        told: webhook ? [`Posted to ${webhook}.`, 'Send it somewhere a person reviews weekly rather than to an alert channel — this is a review, not an incident.'] : ['Nobody — set a destination, or this is a search nobody runs.'],
        requires: ['Flow collection from the relevant vCenter and NSX sources, and enough retention to cover the window.'],
        files: {
          [`${base}.json`]: `${JSON.stringify({ name: checkName, search, schedule: 'daily', destination: webhook || '<REQUIRED>', reportOnly: true }, null, 2)}\n`,
          'run-check.sh': [
            '#!/usr/bin/env bash',
            '# Run the saved search and post the result. Reads only.',
            'set -euo pipefail',
            ': "${VCFNET_HOST:?set VCFNET_HOST}"',
            ': "${VCFNET_TOKEN:?set VCFNET_TOKEN — POST /api/ni/auth/token}"',
            '',
            'RESULT=$(curl -sS -f \\',
            '  -X POST "https://${VCFNET_HOST}/api/ni/search" \\',
            '  -H "Authorization: NetworkInsight ${VCFNET_TOKEN}" \\',
            '  -H "Content-Type: application/json" \\',
            `  --data @${base}.json)`,
            '',
            'echo "$RESULT"',
            ...(webhook ? ['', `curl -sS -f -X POST "${webhook}" -H "Content-Type: application/json" --data "$RESULT"`] : []),
            '',
          ].join('\n'),
        },
        notes: [
          'Networks sees flows, not intent. A flow that appears here may be perfectly legitimate and undocumented, which is itself the finding.',
          'Run it for a month before anyone proposes acting on it. The first four weeks are mostly discovering what the boundary really carries.',
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
      'A log alert with a rate limit on it. The thing that goes wrong here is not the query — it is that the query matches ten thousand events an hour and the alert becomes its own incident.',
    inputs: [
      { id: 'alert_name', label: 'Alert name', control: 'text', default: 'ESXi storage path failure' },
      { id: 'query', label: 'Matches', control: 'textarea', default: 'text CONTAINS "Lost path redundancy" OR text CONTAINS "Path failover"', hint: 'The Logs query' },
      { id: 'source_filter', label: 'From hosts matching', control: 'text', default: 'hostname STARTS_WITH "esx"' },
      { id: 'threshold', label: 'Fire when more than', control: 'number', default: 5, min: 1, max: 10000, hint: 'Events in the window' },
      { id: 'window_minutes', label: 'In (minutes)', control: 'number', default: 15, min: 1, max: 1440 },
      { id: 'webhook', label: 'Send to', control: 'text', default: 'https://runbooks.example.com/hooks/logs' },
      { id: 'rate_limit_minutes', label: 'Do not re-fire for (minutes)', control: 'number', default: 60, min: 0, max: 1440 },
    ],
    automation: (values                 , name        )             => {
      const alertName = str(values, 'alert_name', 'Log alert');
      const query = str(values, 'query', '');
      const sourceFilter = str(values, 'source_filter', '');
      const threshold = num(values, 'threshold', 5);
      const windowMinutes = num(values, 'window_minutes', 15);
      const webhook = str(values, 'webhook', '');
      const rateLimit = num(values, 'rate_limit_minutes', 60);
      const base = slugOf(name || alertName, 'log-alert');

      const findings            = [];
      if (rateLimit === 0) {
        findings.push(
          error('vcflog.alert.no-rate-limit', 'This alert has no rate limit, so a log storm becomes a notification storm.', {
            remediation: 'Set a re-fire interval. An hour is usually right: long enough to stop the flood, short enough that a continuing problem is still visible.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (threshold <= 1) {
        findings.push(
          warning('vcflog.alert.hair-trigger', 'A threshold of one event means a single line pages somebody.', {
            remediation: 'For a genuinely fatal message that is right. For anything that happens transiently it is not — use a count over a window.',
            source: 'ArchToolKit',
          }),
        );
      }

      const definition = {
        name: alertName,
        description: 'Generated by ArchToolKit.',
        chartQuery: { query, filter: sourceFilter },
        alertType: 'count',
        threshold,
        windowMinutes,
        rateLimitMinutes: rateLimit,
        notify: { webhook: webhook || '<REQUIRED>', payloadFormat: 'json' },
        enabled: false,
      };

      return {
        platform: LOGS,
        title: `${alertName} — fire when more than ${threshold} matching events arrive in ${windowMinutes} minutes`,
        effect: 'read',
        trigger: {
          kind: 'alert',
          detail: `More than ${threshold} events matching the query in any ${windowMinutes} minutes`,
          worstCase: rateLimit > 0 ? `once every ${rateLimit} minutes while the condition holds` : 'continuously — there is no rate limit set',
        },
        scope: {
          what: `Log events matching the query${sourceFilter ? `, from sources where ${sourceFilter}` : ', from every source'}.`,
          decidedBy: [`The query: ${query || '(none set)'}.`, sourceFilter ? `The source filter: ${sourceFilter}.` : 'No source filter, so every host shipping logs.', `The threshold: more than ${threshold} in ${windowMinutes} minutes.`],
          ifWrong: 'Either nobody is told about a real failure, or everybody is told about a normal one until they mute the channel. The second is more common and more damaging.',
        },
        guardrails: [
          ...(rateLimit > 0 ? [{ rule: `Will not re-fire for ${rateLimit} minutes`, because: 'A storage failure writes thousands of lines a minute. Without this, the alert is the outage.' }] : []),
          { rule: `A count over ${windowMinutes} minutes, not a single line`, because: 'Almost every log message worth alerting on appears once harmlessly before it appears repeatedly.' },
          { rule: 'Created disabled', because: 'Turn it on after you have run the query over a week of history and know what it would have done.' },
        ],
        dryRun: [
          'Run the query over the last seven days in the interface.',
          'Count the times it would have crossed the threshold. That is how often this will page somebody.',
        ],
        undo: ['Set enabled to false, or DELETE /api/v2/alerts/{id}. Nothing that already fired is recalled.'],
        told: webhook ? [`Posted to ${webhook} as JSON.`] : ['Nobody — no destination set.'],
        requires: ['The relevant hosts shipping logs, and enough retention to cover the window you test against.'],
        files: {
          [`${base}.json`]: `${JSON.stringify(definition, null, 2)}\n`,
          'apply.sh': [
            '#!/usr/bin/env bash',
            '# Create the alert in VCF Operations for Logs. It is created disabled.',
            'set -euo pipefail',
            ': "${VCFLOGS_HOST:?set VCFLOGS_HOST}"',
            ': "${VCFLOGS_TOKEN:?set VCFLOGS_TOKEN — POST /api/v2/sessions}"',
            '',
            'DRY_RUN=1',
            '[[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
            'if (( DRY_RUN )); then',
            `  echo "DRY RUN: would create the alert in ${base}.json (disabled). Re-run with --execute."`,
            '  exit 0',
            'fi',
            '',
            'curl -sS -f -X POST "https://${VCFLOGS_HOST}/api/v2/alerts" \\',
            '  -H "Authorization: Bearer ${VCFLOGS_TOKEN}" \\',
            '  -H "Content-Type: application/json" \\',
            `  --data @${base}.json`,
            '',
          ].join('\n'),
        },
        notes: [
          'A log alert tells you something was written, not that something is broken. Pair it with the metric that confirms it before anybody is woken up.',
          'Queries that use CONTAINS across all sources are expensive. Narrow by source first, then by text.',
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
