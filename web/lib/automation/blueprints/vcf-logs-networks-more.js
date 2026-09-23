/**
 * VCF Operations for Logs and for Networks: the groundwork.
 *
 * The first Logs and Networks blueprints raise things — an alert, a flow that
 * should not exist. These are what those stand on: the content pack that turns
 * an application's log lines into fields, the agent that ships them, where they
 * are forwarded and how long they are kept; the data sources Networks collects
 * from, the application definitions it groups flows by, and the check that
 * says whether what is reachable is what was intended.
 *
 * The Logs and Networks APIs have moved more between releases than most of
 * VCF. Where a path or a field is not certain for 9.1 the file says so; export
 * the same object from your own instance and compare before applying.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { applyScript } from '../apply.js';
import { logsChartQuery, networksPreamble, networksScheduledEnv,                     } from './vcf-networks-logs.js';

const LOGS = 'vcf-operations-logs'         ;
const NETWORKS = 'vcf-operations-networks'         ;
const SRC = 'ArchToolKit';

// ---------------------------------------------------------------------------
// VCF Operations for Logs
// ---------------------------------------------------------------------------

/** A regex fragment that swallows everything, which makes a context match anything. */
function isGreedy(pattern        )          {
  return /\.\*(?!\?)/.test(pattern) || /\.\+(?!\?)/.test(pattern);
}

export const LOGS_MORE                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog_content_pack',
    platform: LOGS,
    label: 'A content pack for an application’s logs',
    group: 'Content',
    description:
      'The package that makes an application’s logs usable rather than merely stored: an extracted field that pulls a value out of each line, a saved query, an alert and a minimal dashboard, under one namespace so it can be versioned and upgraded as a unit. With the import instructions, because a content pack nobody installed is a file.',
    inputs: [
      { id: 'app_name', label: 'Application', control: 'text', default: 'Orders API' },
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'com.example.orders', hint: 'Reverse DNS. It is the content pack’s identity; changing it makes a new pack' },
      { id: 'version', label: 'Version', control: 'text', default: '1.0.0' },
      { id: 'app_filter', label: 'Logs from', control: 'text', default: 'orders-api', hint: 'The appname the agent tags these lines with' },
      { id: 'field_name', label: 'Extracted field', control: 'text', default: 'orders_latency_ms' },
      { id: 'pre_context', label: 'Text before the value', control: 'text', default: 'latency=', hint: 'Regex. Keep it literal and short' },
      { id: 'value_regex', label: 'The value', control: 'text', default: '\\d+' },
      { id: 'post_context', label: 'Text after the value', control: 'text', default: 'ms\\b' },
      { id: 'error_query', label: 'Alert when lines contain', control: 'text', default: 'ERROR' },
      { id: 'alert_threshold', label: 'More than (in 5 minutes)', control: 'number', default: 20, min: 1, max: 100000 },
    ],
    automation: (values                 , name        )             => {
      const app = str(values, 'app_name', 'Application');
      const namespace = str(values, 'namespace', 'com.example.app');
      const version = str(values, 'version', '1.0.0');
      const appFilter = str(values, 'app_filter', '');
      const field = str(values, 'field_name', 'value');
      const pre = str(values, 'pre_context', '');
      const valueRe = str(values, 'value_regex', '\\d+');
      const post = str(values, 'post_context', '');
      const errorText = str(values, 'error_query', 'ERROR');
      const threshold = num(values, 'alert_threshold', 20);
      const base = slugOf(name || namespace, 'content-pack');

      const findings            = [];
      if (isGreedy(pre) && isGreedy(post)) {
        findings.push(
          warning('vcflog.cp.greedy-both', 'The extracted field has a greedy .* on both sides of the value.', {
            remediation: 'Each context should be the few literal characters next to the value. With .* on both sides the engine backtracks across the whole line for every event, and the value it lands on depends on what else is in the line.',
            source: SRC,
          }),
        );
      } else if (isGreedy(pre) || isGreedy(post) || isGreedy(valueRe)) {
        findings.push(info('vcflog.cp.greedy', 'One part of the extracted field is a greedy .* — fine if it is anchored, slow if it is not.', { source: SRC }));
      }
      if (!pre && !post) {
        findings.push(warning('vcflog.cp.no-context', 'The value has no context on either side, so it matches the first thing in any line that fits it.', { source: SRC }));
      }
      try {
        new RegExp(`${pre}(${valueRe})${post}`);
      } catch {
        findings.push(error('vcflog.cp.bad-regex', 'The extracted field does not compile as a regular expression.', { source: SRC }));
      }
      if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/i.test(namespace)) {
        findings.push(warning('vcflog.cp.namespace', `"${namespace}" is not reverse-DNS. Two packs with the same namespace overwrite each other.`, { source: SRC }));
      }
      if (!appFilter) {
        findings.push(warning('vcflog.cp.no-filter', 'The field is extracted from every log line in the system, not just this application’s.', { source: SRC }));
      }

      const appConstraint = appFilter
        ? [{ internalName: 'appname', displayName: 'appname', operator: 'CONTAINS', value: appFilter, fieldType: 'STRING', isExtracted: false, hidden: false }]
        : [];
      // Logs has no text query language to put here: a query in a pack is a
      // chartQuery, a string holding JSON field constraints, as the alerts API
      // takes it. Same structure as vcflog_alert_webhook.
      const errorConstraints                   = [
        ...(appFilter ? [{ internalName: 'appname', operator: 'CONTAINS'         , value: appFilter }] : []),
        { internalName: 'text', operator: 'CONTAINS', value: errorText },
      ];
      const chartQuery = logsChartQuery(errorConstraints);

      const pack = {
        name: app,
        namespace,
        contentPackId: namespace,
        version,
        author: 'Generated by ArchToolKit',
        contentVersion: version,
        info: `Extracted fields, a query, an alert and a dashboard for ${app}.`,
        upgradeInstructions: 'Import over the previous version with "Update" selected. Local copies of these objects are not overwritten.',
        instructions: `Configure the agent to tag ${app} logs with appname=${appFilter || '<your app>'}.`,
        requirements: [],
        extractedFields: [
          {
            displayName: field,
            internalName: `${namespace.replace(/\./g, '_')}_${slugOf(field, 'field').replace(/-/g, '_')}`,
            preContext: pre,
            regexValue: valueRe,
            postContext: post,
            constraints: JSON.stringify({ searchTerms: '', filters: appConstraint }),
            info: `Extracted from ${app} lines.`,
          },
        ],
        queries: [{ name: `${app} — errors`, info: 'Every error line from this application.', chartQuery }],
        alerts: [
          {
            name: `${app} — error rate`,
            info: `More than ${threshold} error lines in 5 minutes.`,
            alertType: 'RATE_BASED',
            hitCount: threshold,
            hitOperator: 'GREATER_THAN',
            searchPeriod: 300000,
            searchInterval: 60000,
            chartQuery,
            enabled: false,
          },
        ],
        dashboardSections: [
          {
            name: app,
            // The average-of-the-field chart is not written here: its query
            // needs the extracted field's definition inside the chartQuery, in
            // a form only an export shows. IMPORT.txt says how to add it.
            views: [{ name: 'Overview', widgets: [{ name: 'Errors', chartQuery }] }],
          },
        ],
      };

      const importText = [
        `Importing ${app} ${version}`,
        '',
        '1. In VCF Operations for Logs: Content Packs > Import Content Pack.',
        `2. Choose ${base}.vlcp. Install as content pack (shared), not "Import into my content".`,
        '3. If a previous version is installed, choose Update. Local edits to its',
        '   objects are kept as copies and are not overwritten.',
        '4. Open Interactive Analytics, filter to the application, and check the',
        `   ${field} field appears on recent lines before relying on it.`,
        `5. The alert "${app} — error rate" is imported disabled. Run its query`,
        '   over the last day, count the hits, then enable it.',
        `6. Build the ${field} chart in the interface: Explore Logs, filter`,
        `   ${appFilter ? `appname contains ${appFilter}` : 'to the application'}, choose Average of ${field}, grouped by time,`,
        '   and add it to this pack’s Overview dashboard. Then export the pack',
        `   from Content Packs and keep that export in place of ${base}.vlcp —`,
        '   it carries the exact query structure this release uses.',
        '',
        'The API route for import (apply.sh) is not the same in every release. If it',
        'returns 404, import through the interface as above.',
        '',
      ].join('\n');

      return {
        platform: LOGS,
        title: `${app} content pack ${version} — fields, query, alert and dashboard`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Imported by hand, once per version.', worstCase: 'once per import' },
        scope: {
          what: `Log lines from ${appFilter ? `appname ${appFilter}` : 'every source'} gain the ${field} field; the alert watches the same lines.`,
          decidedBy: [appFilter ? `The extracted field is constrained to appname CONTAINS ${appFilter}.` : 'No constraint — the field is tried against every line.', 'The agent configuration that sets appname on these lines.'],
          ifWrong: 'The field is tried against every line in the system: slower queries for everyone, and wrong values wherever the pattern happens to match.',
        },
        guardrails: [
          { rule: 'The alert is imported disabled', because: 'An alert that has never been run against real volume is a page storm waiting for its first busy hour.' },
          { rule: 'The extracted field is constrained to this application', because: 'An unconstrained field is evaluated against every line from every source.' },
        ],
        dryRun: ['Before importing, paste the extracted field into Interactive Analytics as an ad-hoc field on the last hour and check what it pulls out.', 'apply.sh prints what it would send unless given --execute.'],
        undo: ['Content Packs > the pack > Uninstall. Dashboards and alerts it installed go with it; user copies made from them do not.'],
        told: ['Nobody. Content is not an event. The alert, once enabled, notifies whatever its own notification is set to.'],
        requires: ['Agents or syslog sources that tag these lines with the appname above.', 'A Logs account with permission to install content packs.'],
        files: {
          [`${base}.vlcp`]: `${JSON.stringify(pack, null, 2)}\n`,
          'IMPORT.txt': importText,
          'apply.sh': applyScript(LOGS, [{ method: 'POST', path: '/api/v2/content/contentpack/import', payload: `${base}.vlcp` }], 'Uninstall the content pack from Content Packs in the interface.'),
        },
        notes: [
          'The .vlcp structure follows packs exported from recent releases, trimmed to the parts that matter. Export any installed pack from your own instance and compare field names before importing; the alert and dashboard blocks in particular carry more fields in a full export.',
          'Queries, the alert and the widget carry chartQuery — field constraints as a JSON string, the structure the alerts API documents — not a text query: Logs has no pipe-and-function query language to write one in. The chart of the extracted field is left to be built in the interface (IMPORT.txt, step 6), because its query has to reference the field in a form only an export shows.',
          'Version the namespace’s content in a repository. The pack is the unit of change: edit it there, bump the version, import over the old one.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog_forwarding',
    platform: LOGS,
    label: 'Forward logs to another system',
    group: 'Forwarding',
    description:
      'A forwarding destination: a Splunk heavy forwarder over syslog on TLS, or another Logs instance over its own ingestion API, with a filter so only what the other side needs is sent and a disk-backed queue so a restart at the far end does not drop events.',
    inputs: [
      { id: 'dest_name', label: 'Name', control: 'text', default: 'Splunk heavy forwarder' },
      { id: 'host', label: 'Destination host', control: 'text', default: 'splunk-hf01.example.com' },
      {
        id: 'protocol',
        label: 'Protocol',
        control: 'select',
        options: [
          { value: 'syslog-tls', label: 'Syslog over TLS' },
          { value: 'syslog-tcp', label: 'Syslog over TCP' },
          { value: 'syslog-udp', label: 'Syslog over UDP' },
          { value: 'cfapi', label: 'Another Logs instance (cfapi)' },
          { value: 'raw', label: 'Raw TCP' },
        ],
        default: 'syslog-tls',
      },
      { id: 'port', label: 'Port', control: 'number', default: 6514, min: 1, max: 65535, hint: '6514 syslog TLS, 514 plain, 9543 cfapi TLS' },
      { id: 'filter', label: 'Only forward', control: 'textarea', default: 'appname = "orders-api" OR hostname STARTS_WITH "esx"', hint: 'A Logs filter. Empty forwards everything' },
      { id: 'queue_mb', label: 'Disk queue (MB)', control: 'number', default: 2000, min: 0, max: 100000 },
      { id: 'workers', label: 'Worker connections', control: 'number', default: 8, min: 1, max: 32 },
      { id: 'add_tags', label: 'Tag forwarded events', control: 'text', default: 'forwarded_from=vcflogs01' },
    ],
    automation: (values                 , name        )             => {
      const destName = str(values, 'dest_name', 'Forwarder');
      const host = str(values, 'host', '');
      const protocol = str(values, 'protocol', 'syslog-tls');
      const port = num(values, 'port', 6514);
      const filter = str(values, 'filter', '');
      const queue = num(values, 'queue_mb', 2000);
      const workers = num(values, 'workers', 8);
      const tags = listOf(str(values, 'add_tags', ''));
      const base = slugOf(name || destName, 'forwarding');

      const findings            = [];
      if (protocol === 'syslog-udp') {
        findings.push(
          warning('vcflog.fwd.udp', 'Syslog over UDP drops events silently when the destination is busy or restarting, and sends them in clear text.', {
            remediation: 'Use syslog over TLS. If the destination cannot take TLS, TCP at least tells the sender that it did not arrive.',
            source: SRC,
          }),
        );
      }
      if (!filter) {
        findings.push(
          warning('vcflog.fwd.no-filter', 'No filter: every event is forwarded.', {
            remediation: 'The destination ingests — and usually licenses — everything sent to it. Forward what the other team asked for, not the firehose; the full copy already lives here.',
            source: SRC,
          }),
        );
      }
      if (queue === 0) {
        findings.push(warning('vcflog.fwd.no-queue', 'With no disk queue, anything sent while the destination is down is lost.', { source: SRC }));
      }
      if (protocol === 'cfapi' && port !== 9543 && port !== 9000) {
        findings.push(info('vcflog.fwd.cfapi-port', 'cfapi listens on 9543 (TLS) or 9000 (plain) by default.', { source: SRC }));
      }
      if (protocol === 'syslog-tls' && port === 514) {
        findings.push(warning('vcflog.fwd.tls-port', 'Port 514 is plain syslog; TLS syslog is normally 6514.', { source: SRC }));
      }

      const tls = protocol === 'syslog-tls' || protocol === 'cfapi';
      const payload = {
        name: destName,
        host,
        port,
        protocol: protocol.startsWith('syslog') ? 'syslog' : protocol,
        transport: protocol === 'syslog-udp' ? 'udp' : 'tcp',
        sslEnabled: tls,
        workerCount: workers,
        diskCacheSize: queue,
        filter: filter || '',
        tags: Object.fromEntries(tags.map((tag) => tag.split('=').map((part) => part.trim())                    )),
      };

      return {
        platform: LOGS,
        title: `Forward ${filter ? 'filtered' : 'all'} events to ${destName} (${protocol})`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Configured once; from then on every matching event is forwarded as it arrives.', worstCase: 'every matching event, continuously' },
        scope: {
          what: filter ? `Events matching: ${filter}` : 'Every event this Logs instance ingests.',
          decidedBy: ['The filter above, evaluated on each event as it is ingested.', 'Only events ingested after the destination is created — nothing historical is sent.'],
          ifWrong: 'The destination receives far more than it expected: a licence overrun on the Splunk side, a full disk on a receiving Logs instance, and nothing on this side to notice.',
        },
        guardrails: [
          { rule: 'Filtered at the source', because: 'The cheapest event to license is the one never sent.' },
          { rule: `Disk-backed queue of ${queue} MB`, because: 'A restart at the far end should delay events, not lose them.' },
          ...(tls ? [{ rule: 'Encrypted in transit', because: 'Logs carry usernames, hostnames and sometimes things that should never have been logged.' }] : []),
        ],
        dryRun: [filter ? `Run the filter in Interactive Analytics over the last day and read the event count — that is the daily volume this sends.` : 'Look at the ingestion rate on the system dashboard. That whole rate is what this sends.', 'apply.sh prints what it would send unless given --execute.'],
        undo: ['Delete the destination under Log Management > Log Forwarding, or DELETE it by id. Events already forwarded stay at the destination.'],
        told: ['Nobody. Watch the forwarder’s dropped and queued counters on the Log Forwarding page, or add them to the Logs health check.'],
        requires: [
          `${host}:${port} reachable from every Logs node.`,
          ...(tls ? ['The destination’s certificate chain trusted by Logs.'] : []),
          ...(protocol.startsWith('syslog') ? ['On Splunk: a TCP/TLS input on the heavy forwarder with the right sourcetype. Logs does not send to the HTTP Event Collector directly.'] : []),
        ],
        files: {
          [`${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'apply.sh': applyScript(LOGS, [{ method: 'POST', path: '/api/v2/forwarding', payload: `${base}.json` }], 'DELETE /api/v2/forwarding/{id}, or remove it under Log Forwarding.'),
        },
        notes: [
          'The forwarding API path and body are not stable across releases: /api/v2/forwarding in recent ones, /api/v1/forwarding in some older ones, with transport and sslEnabled named differently in places. Verify against your release, or create it in the interface once and export it.',
          'Forwarding to Splunk HEC is not supported natively. Syslog to a heavy forwarder is the supported route.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog_agent_group',
    platform: LOGS,
    label: 'Agent configuration for a group of servers',
    group: 'Agents',
    description:
      'The liagent.ini that tells the agent which files or event channels to ship and where to, and the agent group that applies it centrally to servers matching a filter — so configuration is set once in Logs rather than edited on each server.',
    inputs: [
      { id: 'group_name', label: 'Agent group', control: 'text', default: 'Orders API servers' },
      { id: 'os', label: 'Operating system', control: 'select', options: [{ value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' }], default: 'linux' },
      { id: 'hostname_filter', label: 'Servers named', control: 'text', default: 'orders-*', hint: 'Glob on the agent hostname' },
      { id: 'server', label: 'Logs server', control: 'text', default: 'vcflogs.example.com' },
      { id: 'ssl', label: 'TLS', control: 'toggle', default: true },
      { id: 'app', label: 'Application tag', control: 'text', default: 'orders-api' },
      { id: 'directory', label: 'Log directory', control: 'text', default: '/var/log/orders', showWhen: { input: 'os', equals: ['linux'] } },
      { id: 'include', label: 'Files', control: 'text', default: '*.log', showWhen: { input: 'os', equals: ['linux'] } },
      { id: 'channels', label: 'Event channels', control: 'text', default: 'Application, System, Security', showWhen: { input: 'os', equals: ['windows'] } },
      { id: 'win_directory', label: 'Also a log directory', control: 'text', default: 'C:\\ProgramData\\Orders\\Logs', showWhen: { input: 'os', equals: ['windows'] } },
    ],
    automation: (values                 , name        )             => {
      const group = str(values, 'group_name', 'Agent group');
      const os = str(values, 'os', 'linux');
      const filter = str(values, 'hostname_filter', '');
      const server = str(values, 'server', '');
      const ssl = bool(values, 'ssl', true);
      const app = str(values, 'app', 'app');
      const directory = str(values, 'directory', '/var/log');
      const include = str(values, 'include', '*.log');
      const channels = listOf(str(values, 'channels', ''));
      const winDir = str(values, 'win_directory', '');
      const base = slugOf(name || group, 'agent-group');
      const appSlug = slugOf(app, 'app');

      const findings            = [];
      if (!ssl) {
        findings.push(
          warning('vcflog.agent.no-ssl', 'ssl=no sends every log line in clear text across the network.', {
            remediation: 'Use ssl=yes on 9543. The agent trusts the Logs certificate on first connect unless ssl_ca_path is set, so set that too.',
            source: SRC,
          }),
        );
      }
      if (os === 'linux' && /^\/var\/log\/?$/.test(directory) && /^\*(\.\*)?$/.test(include)) {
        findings.push(
          warning('vcflog.agent.everything', 'include=* in /var/log ships every file there, including rotated and compressed ones and anything the OS already sends by syslog.', {
            remediation: 'Name the application’s files. Duplicate and binary lines cost ingest and make searches worse.',
            source: SRC,
          }),
        );
      }
      if (!filter) {
        findings.push(warning('vcflog.agent.no-filter', 'The agent group has no hostname filter, so it applies to every agent.', { source: SRC }));
      }

      const serverSection = ['[server]', `hostname=${server}`, 'proto=cfapi', `port=${ssl ? 9543 : 9000}`, `ssl=${ssl ? 'yes' : 'no'}`, ...(ssl ? ['; ssl_ca_path=/etc/pki/tls/certs/vcflogs-ca.pem   ; set this to pin the CA'] : []), ''];
      const body =
        os === 'linux'
          ? [`[filelog|${appSlug}]`, `directory=${directory}`, `include=${include}`, 'exclude=*.gz;*.zip;*.[0-9]', 'parser=auto', `tags={"appname":"${app}"}`, '']
          : [
              ...channels.flatMap((channel) => [`[winlog|${slugOf(channel, 'channel')}]`, `channel=${channel}`, `tags={"appname":"${app}"}`, '']),
              ...(winDir ? [`[filelog|${appSlug}]`, `directory=${winDir}`, 'include=*.log', 'parser=auto', `tags={"appname":"${app}"}`, ''] : []),
            ];
      const ini = ['; Generated by ArchToolKit. Central configuration for the agent group', `; "${group}". Agent-local settings in the file on each server still apply.`, '', ...serverSection, ...body].join('\n');

      const groupPayload = {
        name: group,
        info: `Generated by ArchToolKit for ${app} on ${os}.`,
        criteria: { hostname: filter || '*', os: os === 'linux' ? 'Linux' : 'Windows' },
        agentConfig: ini,
      };

      return {
        platform: LOGS,
        title: `Agent group "${group}" — ship ${app} logs from ${os === 'linux' ? directory : `${channels.join(', ')}`}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Created once. Agents matching the filter pick up the configuration on their next check-in.', worstCase: 'every matching agent within minutes' },
        scope: {
          what: `Agents on ${os} servers whose hostname matches ${filter || 'anything'}.`,
          decidedBy: [`The agent group filter: hostname ${filter || '*'}, OS ${os}.`, 'Agents register with this Logs instance — an agent pointed elsewhere is not affected.'],
          ifWrong: 'The configuration is pushed to servers it was not written for: they start shipping files that do not exist (harmless) or files that do and should not be shipped (not harmless).',
        },
        guardrails: [
          { rule: 'Scoped by hostname and OS', because: 'An agent group with no filter applies to every agent in the estate.' },
          { rule: 'Named files, not the whole directory', because: 'Shipping everything in a log directory ships the rotated copies and the binaries too.' },
        ],
        dryRun: ['Put the generated liagent.ini on one server by hand first and watch its lines arrive in Interactive Analytics filtered to the appname.', 'apply.sh prints what it would send unless given --execute.'],
        undo: ['Delete the agent group. Agents drop the central configuration at their next check-in and fall back to their local liagent.ini.'],
        told: ['Nobody. Agent status is on the Agents page; a missing agent is only noticed if something watches it.'],
        requires: ['The Logs agent installed on each server, pointed at this Logs instance.', ssl ? `Port 9543 open from the servers to ${server}.` : `Port 9000 open from the servers to ${server}.`],
        files: {
          'liagent.ini': `${ini}\n`,
          [`${base}.json`]: `${JSON.stringify(groupPayload, null, 2)}\n`,
          'apply.sh': applyScript(LOGS, [{ method: 'POST', path: '/api/v2/agent/groups', payload: `${base}.json` }], 'Delete the agent group under Management > Agents.'),
        },
        notes: [
          'Agent groups are most reliably created in the interface (Management > Agents > the group dropdown > New Group), pasting liagent.ini into the configuration box. The API route and body in apply.sh are the documented shape for recent releases; verify before --execute.',
          'Central configuration merges with the local file on each server. A setting in both places takes the central value.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog_retention',
    platform: LOGS,
    label: 'Index partitions, retention and archiving',
    group: 'Retention',
    description:
      'Keep different logs for different lengths of time: an index partition for a class of events with its own retention, and archiving to NFS so events older than that still exist somewhere when an auditor asks. Set against the retention the organisation is actually required to keep, not the disk that happens to be free.',
    inputs: [
      { id: 'partition', label: 'Partition name', control: 'text', default: 'audit' },
      { id: 'filter', label: 'Events in it', control: 'textarea', default: 'appname = "sshd" OR appname = "sudo" OR text CONTAINS "vpxd-svcs"' },
      { id: 'retention_days', label: 'Keep searchable for (days)', control: 'number', default: 90, min: 1, max: 3650 },
      { id: 'required_days', label: 'Required retention (days)', control: 'number', default: 365, min: 1, max: 3650, hint: 'What policy or regulation requires' },
      { id: 'archive', label: 'Archive to NFS', control: 'text', default: 'nfs://nas01.example.com/exports/vcflogs-archive', hint: 'Empty for no archive' },
    ],
    automation: (values                 , name        )             => {
      const partition = str(values, 'partition', 'partition');
      const filter = str(values, 'filter', '');
      const retention = num(values, 'retention_days', 90);
      const required = num(values, 'required_days', 365);
      const archive = str(values, 'archive', '');
      const base = slugOf(name || partition, 'retention');

      const findings            = [];
      if (!archive && retention < required) {
        findings.push(
          error('vcflog.retention.short', `Events are deleted after ${retention} days and not archived, against a requirement of ${required} days.`, {
            remediation: 'Either archive to NFS, or raise retention to the requirement and size the disk for it. As it stands, events the organisation must keep are deleted.',
            source: SRC,
          }),
        );
      } else if (archive && retention < required) {
        findings.push(info('vcflog.retention.archive-carries', `Days ${retention}–${required} exist only in the archive. Searching them means importing the archive back into a Logs instance.`, { source: SRC }));
      }
      if (archive && !/^nfs:\/\/[^/]+\/.+/.test(archive)) {
        findings.push(error('vcflog.retention.nfs-uri', `"${archive}" is not an nfs://server/export/path URI.`, { source: SRC }));
      }
      if (!filter) {
        findings.push(warning('vcflog.retention.no-filter', 'A partition with no filter is the default partition under another name.', { source: SRC }));
      }

      const partitionPayload = { name: partition, enabled: true, retentionPeriod: retention, filter };
      const archivePayload = archive ? { enabled: true, archiveUri: archive } : null;

      return {
        platform: LOGS,
        title: `Partition "${partition}" — ${retention} days searchable${archive ? `, archived to ${archive}` : ', not archived'}`,
        effect: 'irreversible',
        trigger: { kind: 'schedule', detail: `Configured once; from then on Logs deletes events in this partition older than ${retention} days, continuously.`, worstCase: 'every day, on every event past its retention' },
        scope: {
          what: `Events matching the partition filter, from the moment it is created. Older events stay where they were ingested.`,
          decidedBy: ['The partition filter, evaluated at ingest.', `Retention of ${retention} days on that partition.`, archive ? `Archiving of every event to ${archive}, which has no retention of its own — the NFS server’s is what applies.` : 'No archive.'],
          ifWrong: 'Shortening retention deletes events older than the new value at the next cleanup. They cannot be brought back unless an archive holds them.',
        },
        guardrails: [
          { rule: 'Applied by hand under an approved change', because: 'Reducing retention is a deletion. Somebody accountable for the requirement should agree to it.' },
          { rule: `Checked against the required ${required} days`, because: 'The number that matters is what the organisation must keep, not what fits on disk.' },
          ...(archive ? [{ rule: 'Archived before it is deleted', because: 'The archive is what makes the retention reversible for the auditor, if not for the search bar.' }] : []),
        ],
        dryRun: ['Run the filter in Interactive Analytics over the last day to see what the partition will hold and how fast it grows.', 'apply.sh prints what it would send unless given --execute.'],
        undo: [
          'Raise the retention back. Events already deleted are gone.',
          archive ? `Events past retention can be recovered from ${archive} by importing the archive into a Logs instance.` : 'Without an archive, nothing past retention can be recovered.',
        ],
        told: ['Nobody. Retention runs quietly; check the partition’s oldest event on the Index Partitions page.'],
        requires: [
          'Disk on every Logs node for the partition at its ingest rate times its retention.',
          ...(archive ? [`The NFS export writable by the Logs nodes, sized for ${required} days at least, with its own retention and backup.`] : []),
        ],
        files: {
          [`${base}-partition.json`]: `${JSON.stringify(partitionPayload, null, 2)}\n`,
          ...(archivePayload ? { [`${base}-archive.json`]: `${JSON.stringify(archivePayload, null, 2)}\n` } : {}),
          'apply.sh': applyScript(
            LOGS,
            [
              { method: 'POST', path: '/api/v2/partitions', payload: `${base}-partition.json` },
              ...(archivePayload ? [{ method: 'PUT'         , path: '/api/v2/archiving', payload: `${base}-archive.json` }] : []),
            ],
            'Edit the partition retention back up; delete the partition under Index Partitions. Deleted events do not come back.',
          ),
        },
        notes: [
          'Index partitions and archiving are in the interface under Management > Index Partitions and Management > Archiving. The API routes in apply.sh (/api/v2/partitions, /api/v2/archiving) are not documented identically across releases; verify both, or configure in the interface.',
          'Archives are written continuously, not at deletion time, so the archive grows from the day it is turned on — not from the first day of retention.',
        ],
        findings,
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// VCF Operations for Networks
// ---------------------------------------------------------------------------

/**
 * The preamble every Networks script opens with: log in (or take a token), then
 * the call helper. The login is shared with the flow check in
 * vcf-networks-logs.ts, because apply.ts has no Networks target.
 */
function netPreamble()           {
  return [
    ...networksPreamble(),
    '',
    'ni() {',
    '  local method="$1" path="$2"; shift 2',
    '  curl -sS -f -X "$method" "https://${VCFNET_HOST}/api/ni${path}" \\',
    '    -H "Authorization: NetworkInsight ${VCFNET_TOKEN}" \\',
    '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
  ];
}

const SOURCE_TYPES                                                                                                            = {
  vcenter: { label: 'vCenter', path: '/data-sources/vcenters', flows: true },
  nsxt: { label: 'NSX Manager', path: '/data-sources/nsxt-managers', flows: true },
  cisco: { label: 'Cisco switch', path: '/data-sources/cisco-switches', flows: false, extra: { switch_type: '<REQUIRED — e.g. CATALYST_3000, NEXUS_9K; verify>' } },
  arista: { label: 'Arista switch', path: '/data-sources/arista-switches', flows: false },
  juniper: { label: 'Juniper switch', path: '/data-sources/juniper-switches', flows: false, extra: { switch_type: '<REQUIRED — e.g. EX, QFX; verify>' } },
};

/** The quoted value in a Networks filter, for overlap checks. */
function quotedValues(filter        )           {
  return [...filter.matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => (match[1] ?? match[2] ?? '').toLowerCase()).filter(Boolean);
}

export const NETWORKS_MORE                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet_data_sources',
    platform: NETWORKS,
    label: 'Add data sources',
    group: 'Data sources',
    description:
      'Onboard the systems Networks collects from — vCenter, NSX, physical switches — through a named collector, with each credential read from the environment. And the setting that decides whether any of it produces flows: IPFIX on the distributed switches and NSX, without which Networks shows topology and nothing moving across it.',
    inputs: [
      {
        id: 'source_type',
        label: 'Source type',
        control: 'select',
        options: Object.entries(SOURCE_TYPES).map(([value, entry]) => ({ value, label: entry.label })),
        default: 'vcenter',
      },
      { id: 'fqdns', label: 'Sources', control: 'textarea', default: 'vcenter-mgmt.example.com\nvcenter-wld01.example.com', hint: 'One FQDN per line' },
      { id: 'collector_id', label: 'Collector id', control: 'text', default: '', hint: 'From GET /api/ni/infra/nodes. Empty resolves it by name below' },
      { id: 'collector_name', label: 'Collector name', control: 'text', default: 'vcfnet-collector01' },
      { id: 'username', label: 'Username', control: 'text', default: 'svc-vcfnet@vsphere.local' },
      { id: 'ipfix', label: 'Enable IPFIX / flow collection', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const type = str(values, 'source_type', 'vcenter');
      const source = SOURCE_TYPES[type] ?? SOURCE_TYPES.vcenter ;
      const fqdns = listOf(str(values, 'fqdns', ''));
      const collectorId = str(values, 'collector_id', '');
      const collectorName = str(values, 'collector_name', '');
      const user = str(values, 'username', '');
      const ipfix = bool(values, 'ipfix', true);
      const base = slugOf(name || `${type}-sources`, 'data-sources');

      const findings            = [];
      if (source.flows && !ipfix) {
        findings.push(
          warning('vcfnet.ds.no-ipfix', `IPFIX is not enabled, so these ${source.label} sources give Networks topology and configuration, and no flows.`, {
            remediation: 'Every flow-based feature — application discovery, micro-segmentation planning, the flow checks in this kit — needs IPFIX on the distributed switches (vCenter) or the NSX firewall.',
            source: SRC,
          }),
        );
      }
      if (fqdns.length === 0) findings.push(error('vcfnet.ds.none', 'No sources are listed.', { source: SRC }));
      if (!collectorId && !collectorName) findings.push(error('vcfnet.ds.no-collector', 'No collector is named. Every data source is polled through a collector.', { source: SRC }));
      if (/administrator@vsphere\.local|^admin$|^root$/i.test(user)) {
        findings.push(warning('vcfnet.ds.admin', `${user} is an administrator account. Networks needs read access plus the IPFIX privilege, not full admin.`, { source: SRC }));
      }

      const sources = fqdns.map((fqdn) => ({
        fqdn,
        nickname: fqdn.split('.')[0] ?? fqdn,
        envVar: `VCFNET_PW_${fqdn.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
      }));

      const specJq = [
        '# One data-source body per source, password from its own variable via $ENV.',
        '# Field names follow the Networks API data-source schema; verify for 9.1.',
        '{ fqdn: .fqdn, nickname: .nickname, proxy_id: $proxy, enabled: true,',
        '  notes: "Added by ArchToolKit",',
        `  credentials: { username: $user, password: $ENV[.envVar] }${source.extra ? ` } + ${JSON.stringify(source.extra)}` : ' }'}`,
        '',
      ].join('\n');

      const script = [
        '#!/usr/bin/env bash',
        `# Add ${fqdns.length} ${source.label} data source(s) to VCF Operations for Networks.`,
        '#',
        '# Each password comes from its own variable, named in sources.json. Without',
        '# --execute it prints each body with the password left out.',
        'set -euo pipefail',
        ...netPreamble(),
        '',
        'DRY_RUN=1; [[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
        '',
        'MISSING=()',
        '# Exported so jq can read each one through $ENV; never passed as an argument.',
        'for v in $(jq -r \'.[].envVar\' sources.json); do if [[ -n "${!v:-}" ]]; then export "$v"; else MISSING+=("$v"); fi; done',
        '(( ${#MISSING[@]} == 0 )) || { printf "Set from your vault: %s\\n" "${MISSING[@]}" >&2; exit 2; }',
        '',
        `PROXY='${collectorId}'`,
        'if [[ -z "$PROXY" ]]; then',
        '  # The node list carries ids only; each node is read to match its name.',
        `  for id in $(ni GET /infra/nodes | jq -r '.results[]? | .entity_id'); do`,
        `    PROXY=$(ni GET "/infra/nodes/$id" | jq -r --arg n '${collectorName}' --arg id "$id" 'select((.name // "") == $n) | .proxy_id // $id')`,
        '    [[ -n "$PROXY" ]] && break',
        '  done',
        `  [[ -n "$PROXY" ]] || { echo "No collector named ${collectorName}" >&2; exit 2; }`,
        'fi',
        'echo "collector ${PROXY}"',
        '',
        'jq -c \'.[]\' sources.json | while read -r src; do',
        `  BODY=$(echo "$src" | jq --arg proxy "$PROXY" --arg user '${user}' -f spec.jq)`,
        '  if (( DRY_RUN )); then',
        `    echo "DRY RUN: would POST ${source.path}:"; echo "$BODY" | jq 'del(.credentials.password)'`,
        '    continue',
        '  fi',
        `  echo "$BODY" | ni POST ${source.path} --data @- | jq -r '"added \\(.entity_id // "?") \\(.fqdn // .ip // "")"'`,
        'done',
        '',
        ...(source.flows && ipfix
          ? [
              '# IPFIX. The Networks API has no stable route for this across releases;',
              '# in the interface it is the "Enable NetFlow (IPFIX)" option on the data',
              `# source. Turn it on for each ${source.label} added above, then check flows`,
              '# appear under Flows within the hour.',
              'echo "Now enable IPFIX on each source (Settings > Accounts and Data Sources > edit)."',
            ]
          : []),
        '(( DRY_RUN )) && echo "Nothing was changed. Re-run with --execute."',
        'exit 0',
        '',
      ].join('\n');

      return {
        platform: NETWORKS,
        title: `Add ${fqdns.length} ${source.label} data source${fqdns.length === 1 ? '' : 's'}${source.flows ? (ipfix ? ', with IPFIX' : ', without flows') : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Run once when the sources are ready to be monitored.', worstCase: 'once per source' },
        scope: {
          what: `Exactly the listed ${source.label} sources: ${fqdns.join(', ') || 'none'}.`,
          decidedBy: ['sources.json, written from the list above.', `Collector ${collectorId || collectorName}.`],
          ifWrong: source.flows && ipfix
            ? 'IPFIX turned on for a distributed switch it was not meant for adds a flow export from every host on it. Nothing breaks, but the collector’s load rises with it.'
            : 'A source added twice is polled twice. Networks deduplicates the inventory, but the credential is used from two places.',
        },
        guardrails: [
          { rule: 'Each credential from its own variable, all present before anything is sent', because: 'A password in the payload is a password in the repository.' },
          { rule: 'Through a named collector', because: 'A source on the wrong collector is polled across a WAN link, or not at all.' },
        ],
        dryRun: ['Run without --execute. It prints every body it would send, with the password left out.'],
        undo: ['Delete the data source (DELETE /api/ni/data-sources/…/{id}, or in Settings). Collected history is kept until it ages out.', ...(source.flows && ipfix ? ['Turn IPFIX off on the source; the hosts stop exporting.'] : [])],
        told: ['Nobody. A failing data source shows on Settings > Accounts and Data Sources, and should be in the VCF Operations health checks.'],
        requires: [
          `A ${source.label} account with read access${source.flows ? ' and the privilege to change IPFIX settings' : ''}.`,
          ...sources.map((entry) => `${entry.envVar} set to ${entry.fqdn}’s password, from your vault.`),
          'The collector able to reach every source.',
        ],
        files: { [`${base}.sh`]: script, 'sources.json': `${JSON.stringify(sources, null, 2)}\n`, 'spec.jq': specJq },
        notes: [
          'The data-source routes (/api/ni/data-sources/vcenters, /nsxt-managers, /cisco-switches and so on) are long-standing. The switch_type values for physical switches vary by model and release; take them from the API reference.',
          'Collector lookup by name walks /api/ni/infra/nodes; if your release returns the name on the list directly, pass the id instead.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet_applications',
    platform: NETWORKS,
    label: 'Define an application and its tiers',
    group: 'Segmentation',
    description:
      'An application in Networks is a name and a set of tiers, each tier a search for the VMs in it. Once it exists, Networks can show what the tiers say to each other and to the outside, which is the input to a micro-segmentation rule set — and the tiers have to be disjoint, or the rules written from them will be too.',
    inputs: [
      { id: 'app_name', label: 'Application', control: 'text', default: 'Orders' },
      {
        id: 'tiers',
        label: 'Tiers',
        control: 'textarea',
        default: "web = name like 'orders-web'\napp = name like 'orders-app'\ndb = name like 'orders-db'",
        hint: "One per line: tier = filter. e.g. name like 'x', or security_tags = 'tier:web'",
      },
    ],
    automation: (values                 , name        )             => {
      const app = str(values, 'app_name', 'Application');
      const base = slugOf(name || app, 'application');
      const tiers = str(values, 'tiers', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf('=');
          return at < 0 ? { name: line, filter: '' } : { name: line.slice(0, at).trim(), filter: line.slice(at + 1).trim() };
        });

      const findings            = [];
      if (tiers.length === 0) findings.push(error('vcfnet.app.no-tiers', 'An application with no tiers groups nothing.', { source: SRC }));
      const empty = tiers.filter((tier) => !tier.filter);
      if (empty.length > 0) findings.push(error('vcfnet.app.empty-tier', `No filter for tier ${empty.map((tier) => tier.name).join(', ')}.`, { source: SRC }));
      const overlaps           = [];
      for (let i = 0; i < tiers.length; i += 1) {
        for (let j = i + 1; j < tiers.length; j += 1) {
          const a = tiers[i] ;
          const b = tiers[j] ;
          const va = quotedValues(a.filter);
          const vb = quotedValues(b.filter);
          const clash = a.filter === b.filter || va.some((x) => vb.some((y) => (/\blike\b/i.test(a.filter) && y.includes(x)) || (/\blike\b/i.test(b.filter) && x.includes(y)) || x === y));
          if (clash) overlaps.push(`${a.name} and ${b.name}`);
        }
      }
      if (overlaps.length > 0) {
        findings.push(
          warning('vcfnet.app.overlap', `Tier criteria overlap: ${overlaps.join('; ')}. A VM matching both is in both tiers.`, {
            remediation: '"name like" is a substring match, so like \'web\' also matches \'web-db\'. Make every tier’s criterion exclusive — a tag per tier is the cleanest way.',
            source: SRC,
          }),
        );
      }

      const tierBodies = tiers.map((tier) => ({
        name: tier.name,
        group_membership_criteria: [{ membership_type: 'SearchMembershipCriteria', search_membership_criteria: { entity_type: 'BaseVirtualMachine', filter: tier.filter } }],
      }));

      const script = [
        '#!/usr/bin/env bash',
        `# Create the application "${app}" and its ${tiers.length} tier(s) in VCF Operations for Networks.`,
        '#',
        '# Without --execute it shows how many VMs each tier matches today, and',
        '# creates nothing — the count is the check that the criteria are right.',
        'set -euo pipefail',
        ...netPreamble(),
        '',
        'DRY_RUN=1; [[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
        '',
        'jq -c \'.[]\' tiers.json | while read -r tier; do',
        '  NAME=$(echo "$tier" | jq -r .name)',
        '  FILTER=$(echo "$tier" | jq -r \'.group_membership_criteria[0].search_membership_criteria.filter\')',
        '  COUNT=$(ni POST /search --data "$(jq -n --arg f "$FILTER" \'{entity_type: "VirtualMachine", filter: $f, size: 1}\')" | jq -r \'.total_count // 0\')',
        '  echo "tier ${NAME}: ${COUNT} VM(s) match ${FILTER}"',
        'done',
        '',
        '(( DRY_RUN )) && { echo "DRY RUN: nothing created. Re-run with --execute."; exit 0; }',
        '',
        `APP_ID=$(ni POST /groups/applications --data '${JSON.stringify({ name: app }).replace(/'/g, "'\\''")}' | jq -r .entity_id)`,
        'echo "application ${APP_ID}"',
        'jq -c \'.[]\' tiers.json | while read -r tier; do',
        '  ni POST "/groups/applications/${APP_ID}/tiers" --data "$tier" | jq -r \'"tier \\(.name // "?") \\(.entity_id // "")"\'',
        'done',
        'echo "${APP_ID}" > created-application-id.txt',
        '',
      ].join('\n');

      return {
        platform: NETWORKS,
        title: `Application "${app}" with ${tiers.length} tier${tiers.length === 1 ? '' : 's'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Created once. Membership is re-evaluated as VMs come and go.', worstCase: 'membership changes whenever a VM matching a tier filter appears' },
        scope: {
          what: 'A definition only: it groups VMs for analysis and changes nothing on the network.',
          decidedBy: tiers.map((tier) => `Tier ${tier.name}: ${tier.filter || '(no filter)'}.`),
          ifWrong: 'The flow analysis shows the wrong VMs in a tier, and any firewall rules recommended from it are wrong in the same way. That is where the harm is — in the rules written later from this.',
        },
        guardrails: [
          { rule: 'Counts each tier’s members before creating anything', because: 'A tier that matches three hundred VMs instead of three is visible as a number before it is visible as a bad rule.' },
          { rule: 'Creates a definition, never a rule', because: 'Recommended rules are reviewed and applied in NSX by a person.' },
        ],
        dryRun: ['Run without --execute. It prints how many VMs each tier matches today and creates nothing.'],
        undo: ['DELETE /api/ni/groups/applications/{id} with the id in created-application-id.txt, or delete it under Applications.'],
        told: ['Nobody. It is a definition.'],
        requires: ['VM names or tags consistent enough for a filter to find them.', 'Flow collection (IPFIX) for the flow analysis to have anything in it.'],
        files: { [`${base}.sh`]: script, 'tiers.json': `${JSON.stringify(tierBodies, null, 2)}\n` },
        notes: [
          'The applications and tiers routes and the SearchMembershipCriteria shape follow the Networks API reference. The filter syntax is the search bar’s: try each filter there first.',
          'Networks can discover applications from flows and tags on its own. Use that to find candidates, then write the definition here so it is reviewed and versioned.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet_intent_check',
    platform: NETWORKS,
    label: 'Check that reachability matches intent',
    group: 'Segmentation',
    description:
      'A list of statements — this VM should reach that one, this one should not — checked against what Networks has observed. A flow the firewall allowed where the intent says deny, or blocked where it says allow, is reported and the script exits non-zero. It reads and reports; it never changes a rule.',
    inputs: [
      {
        id: 'intents',
        label: 'Intents',
        control: 'textarea',
        default: 'orders-web01 -> orders-db01 : deny\norders-app01 -> orders-db01 : allow\norders-web01 -> orders-app01 : allow',
        hint: 'One per line: source-vm -> destination-vm : allow | deny',
      },
      { id: 'window_hours', label: 'Look back (hours)', control: 'number', default: 24, min: 1, max: 720 },
      { id: 'strict', label: 'Fail when an allow has no flows at all', control: 'toggle', default: false, hint: 'Otherwise that is reported as no evidence' },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/segmentation' },
    ],
    automation: (values                 , name        )             => {
      const hours = num(values, 'window_hours', 24);
      const strict = bool(values, 'strict', false);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'intent-check', 'intent-check');

      const findings            = [];
      const intents                                                            = [];
      for (const line of str(values, 'intents', '').split('\n').map((l) => l.trim()).filter(Boolean)) {
        const match = /^(.+?)\s*->\s*(.+?)\s*:\s*(allow|deny)\s*$/i.exec(line);
        if (!match) {
          findings.push(warning('vcfnet.intent.unparsed', `Could not read "${line}". Write it as: source -> destination : allow|deny.`, { source: SRC }));
          continue;
        }
        intents.push({ source: match[1] , destination: match[2] , intent: match[3] .toLowerCase() });
      }
      if (intents.length === 0) findings.push(error('vcfnet.intent.none', 'No intents to check.', { source: SRC }));
      if (hours < 24) {
        findings.push(info('vcfnet.intent.short-window', `A ${hours}-hour window misses anything that runs daily or less often — backups, batch jobs.`, { source: SRC }));
      }

      const script = [
        '#!/usr/bin/env bash',
        '# Is what was observed on the network what was intended? Reads only.',
        '#',
        '# For each intent, search the flows between the two VMs over the window.',
        '#   deny  + flows the firewall allowed -> violation',
        '#   deny  + flows seen, none allowed   -> enforced, reported as such',
        '#   allow + flows the firewall blocked -> violation',
        `#   allow + no flows at all            -> ${strict ? 'violation (strict)' : 'no evidence, reported but not failed'}`,
        '# Exits 1 on any violation.',
        'set -euo pipefail',
        ...netPreamble(),
        '',
        'END=$(date +%s)',
        `START=$(( END - ${hours} * 3600 ))`,
        'PROBLEMS=()',
        '',
        'count() {',
        '  ni POST /search --data "$(jq -n --arg f "$1" --argjson s "$START" --argjson e "$END" \\',
        '    \'{entity_type: "Flow", filter: $f, size: 1, time_range: {start_time: $s, end_time: $e}}\')" | jq -r \'.total_count // 0\'',
        '}',
        '',
        'while IFS=$\'\\t\' read -r SRC_VM DST_VM INTENT; do',
        '  BETWEEN="source_vm.name = \'${SRC_VM}\' and destination_vm.name = \'${DST_VM}\'"',
        '  SEEN=$(count "$BETWEEN")',
        '  if [[ "$INTENT" == "deny" ]]; then',
        '    # A deny that the firewall enforced still shows up as flows, with the',
        '    # action DROP or REJECT. Only flows it allowed break the intent.',
        '    ALLOWED=$(count "${BETWEEN} and firewall_action = \'ALLOW\'")',
        '    (( ALLOWED == 0 )) || PROBLEMS+=("${SRC_VM} -> ${DST_VM}: intended deny, ${ALLOWED} flow(s) allowed by the firewall")',
        '    if (( SEEN > ALLOWED )); then',
        '      echo "enforced: ${SRC_VM} -> ${DST_VM} (deny) — $(( SEEN - ALLOWED )) flow(s) attempted and not allowed"',
        '    fi',
        '  else',
        '    DROPPED=$(count "${BETWEEN} and (firewall_action = \'DROP\' or firewall_action = \'REJECT\' or firewall_action = \'DENY\')")',
        '    (( DROPPED == 0 )) || PROBLEMS+=("${SRC_VM} -> ${DST_VM}: intended allow, ${DROPPED} flow(s) blocked by the firewall")',
        '    if (( SEEN == 0 )); then',
        strict
          ? '      PROBLEMS+=("${SRC_VM} -> ${DST_VM}: intended allow, no flows observed")'
          : '      echo "no evidence: ${SRC_VM} -> ${DST_VM} (allow) — no flows in the window"',
        '    fi',
        '  fi',
        '  echo "${SRC_VM} -> ${DST_VM} (${INTENT}): ${SEEN} flow(s)"',
        "done < <(jq -r '.[] | [.source, .destination, .intent] | @tsv' intents.json)",
        '',
        'if (( ${#PROBLEMS[@]} == 0 )); then',
        '  echo "Observed reachability matches intent."',
        '  exit 0',
        'fi',
        'printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...(webhook
          ? [`curl -sS -X POST "${webhook}" -H "Content-Type: application/json" --data "$(printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "vcfnet-intent-check", problems: .}')" || true`]
          : []),
        'exit 1',
        '',
      ].join('\n');

      return {
        platform: NETWORKS,
        title: `Reachability intent check — ${intents.length} statement${intents.length === 1 ? '' : 's'} over ${hours} hours`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Daily, over the last ${hours} hours of flows`, worstCase: 'once a day' },
        scope: {
          what: 'Observed flows between the named VM pairs. It reads flow records; it changes nothing.',
          decidedBy: intents.map((entry) => `${entry.source} -> ${entry.destination}: ${entry.intent}.`),
          ifWrong: 'A misnamed VM matches nothing, so a deny passes trivially. Check each name returns flows in the search bar before trusting a clean result.',
        },
        guardrails: [
          { rule: 'Reports; never writes a rule', because: 'An automation that closes a flow on its own finding will one day close one that was load-bearing.' },
          { rule: 'An allow with no flows is "no evidence", not a pass', because: 'Not having seen traffic is different from traffic being possible.' },
          { rule: 'A deny fails only on flows the firewall allowed', because: 'An enforced deny still leaves flow records — the attempts it dropped. Counting those would report a working rule as a violation.' },
        ],
        dryRun: ['It only reads. Run it by hand once and compare with a path search in the interface.'],
        undo: ['Nothing to undo.'],
        told: [webhook ? `${webhook}, on any violation.` : 'The exit code only.'],
        requires: ['IPFIX flow collection covering these VMs, from the NSX distributed firewall so each flow carries the action taken.', 'Flow retention at least as long as the window.', 'A read-only Networks account: VCFNET_USER and VCFNET_PASSWORD_FILE for the scheduled run, or VCFNET_TOKEN by hand.'],
        files: {
          [`${base}.sh`]: script,
          'intents.json': `${JSON.stringify(intents, null, 2)}\n`,
          'crontab.txt': `# Daily at 06:00, from the directory holding ${base}.sh and intents.json.\n# The password file is mode 600 and owned by the account that runs this.\n0 6 * * * cd /opt/archtoolkit/${base} && ${networksScheduledEnv()} ./${base}.sh\n`,
        },
        notes: [
          'This checks observed flows. Whether a path is possible — the "VM \'a\' to VM \'b\'" path search in the interface — is not exposed as a stable API in every release; use it by hand to confirm any violation this reports.',
          'The filter property names (source_vm.name, destination_vm.name, firewall_action) follow the Flow schema in the Networks API reference. The action values tested (ALLOW; DROP, REJECT, DENY) are the firewall’s — check which your release reports with a flow search in the interface. A wrong property name or value returns zero results, which reads as a pass for a deny.',
          'The deny check can only see what the firewall reported. A flow with no firewall action on it — one seen only through the distributed switch’s IPFIX, with no NSX distributed firewall in the path — is counted as seen but never as allowed, so it cannot fail a deny. The script prints those as "attempted and not allowed"; if a deny pair shows flows there and you have no DFW rule for it, look in the interface.',
        ],
        findings,
      };
    },
  }),
];
