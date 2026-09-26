/**
 * VCF Operations 9.1 log management: the rest of what the service configures.
 *
 *   vcflog91_sources           which VCF components send, at what level
 *   vcflog91_access            who can search which logs
 *   vcflog91_archive_import    archived logs brought back into a partition
 *   vcflog91_extracted_fields  fields extracted from events, on their own
 *
 * Everything applies through the KB 450054 ops-li exchange (vcf-logs91-api.ts),
 * except ESX syslog, which is a host setting and is applied with govc against
 * vCenter. Content packs are End of General Support in 9.1 and are not here.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { conditionRows, describeAll, json, logsApplyNote, logsApplyScript, md, rowsOf, sq,               } from './vcf-logs91-api.js';

const LOGS = 'vcf-operations-logs'         ;
const SRC = 'ArchToolKit';
const CONFIGURATIONS = 'Operate → Administration → Configurations';

/** The VCF components 9.1 log management collects from itself. */
const COMPONENTS                                                              = [
  { value: 'esx', label: 'ESX hosts', audit: true },
  { value: 'vcenter', label: 'vCenter', audit: true },
  { value: 'nsx', label: 'NSX', audit: true },
  { value: 'sddc_manager', label: 'SDDC Manager (9.1.1)', audit: true },
  { value: 'vcf_automation', label: 'VCF Automation', audit: false },
  { value: 'vcf_operations', label: 'VCF Operations', audit: true },
  { value: 'cloud_proxy', label: 'Cloud proxies', audit: false },
  { value: 'identity_broker', label: 'VCF Identity Broker', audit: true },
  { value: 'vks', label: 'vSphere Kubernetes Service clusters', audit: false },
];
const LEVELS = [
  { value: 'Error', label: 'Error' },
  { value: 'Warning', label: 'Warning' },
  { value: 'Info', label: 'Info (the 9.1 default)' },
  { value: 'Debug', label: 'Debug (troubleshooting only)' },
];
const LEVEL_NAMES = new Set(LEVELS.map((level) => level.value));

/** ESX host agent log levels for the same words. */
const ESX_LEVEL                                   = { Error: 'error', Warning: 'warning', Info: 'info', Debug: 'verbose' };

export const VCF_LOGS91_MORE                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog91_sources',
    platform: LOGS,
    label: 'Log sources: which VCF components send, at what level (9.1)',
    group: 'Log management 9.1',
    description:
      'The collection configuration for VCF itself: which components send to log management — ESX, vCenter, NSX, SDDC Manager, VCF Automation, VCF Operations, cloud proxies, the Identity Broker, VKS — each on or off, at a volume level, with application names dropped at collection. apply.sh sets it through the log management API, and points every ESX host at log management over syslog TLS with govc.',
    inputs: [
      {
        id: 'components',
        label: 'Collect from',
        control: 'checklist',
        options: COMPONENTS.map((component) => ({ value: component.value, label: component.label })),
        default: 'esx,vcenter,nsx,sddc_manager,vcf_automation,vcf_operations,cloud_proxy,identity_broker',
      },
      { id: 'default_level', label: 'Volume level', control: 'select', options: LEVELS, default: 'Info' },
      {
        id: 'overrides',
        label: 'Per component',
        control: 'textarea',
        default: 'nsx | Warning | nsx-edge-healthcheck\nvcf_automation | Info | ',
        hint: 'component | level | drop these appnames',
        help: `component: ${COMPONENTS.map((c) => c.value).join(', ')}. level: Error, Warning, Info, Debug. appnames: comma separated, dropped at collection.`,
      },
      { id: 'ingest_host', label: 'Log management ingestion FQDN or address', control: 'text', default: 'logmgmt.example.com', hint: 'Where ESX hosts send syslog. IPv6 addresses are fine' },
      {
        id: 'esx_transport',
        label: 'ESX syslog transport',
        control: 'select',
        options: [
          { value: 'ssl', label: 'TLS (ssl://)' },
          { value: 'tcp', label: 'TCP' },
          { value: 'udp', label: 'UDP' },
        ],
        default: 'ssl',
      },
      { id: 'esx_port', label: 'ESX syslog port', control: 'number', default: 6514, min: 1, max: 65535, hint: '6514 TLS, 514 plain' },
      { id: 'esx_scope', label: 'ESX hosts under', control: 'text', default: '/', hint: 'When ESX is ticked. A govc inventory path: / for every host, or /DC1/host/Cluster-A' },
      { id: 'set_esx_level', label: 'Also set the ESX host agent log level', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const picked = new Set(listOf(str(values, 'components', '')));
      const level = str(values, 'default_level', 'Info');
      const overrides = rowsOf(str(values, 'overrides', ''), 3).filter((row) => row[0]);
      const ingest = str(values, 'ingest_host', '');
      const transport = str(values, 'esx_transport', 'ssl');
      const esxPort = num(values, 'esx_port', 6514);
      const esxScope = str(values, 'esx_scope', '/');
      const setLevel = bool(values, 'set_esx_level', true);
      const base = slugOf(name || 'log-sources', 'log-sources');
      const esx = picked.has('esx');

      const findings            = [];
      if (picked.size === 0) findings.push(error('vcflog91.src.nothing', 'No component is ticked: log management would collect nothing from VCF.', { source: SRC }));
      for (const row of overrides) {
        if (!COMPONENTS.some((c) => c.value === row[0])) findings.push(error('vcflog91.src.unknown', `"${row[0]}" is not a component: ${COMPONENTS.map((c) => c.value).join(', ')}.`, { source: SRC }));
        if (row[1] && !LEVEL_NAMES.has(row[1])) findings.push(error('vcflog91.src.level', `"${row[1]}" for ${row[0]} is not Error, Warning, Info or Debug.`, { source: SRC }));
        if (row[0] && !picked.has(row[0])) findings.push(warning('vcflog91.src.override-off', `A row sets ${row[0]}, which is not ticked, so the row changes nothing.`, { source: SRC }));
      }
      const offAudit = COMPONENTS.filter((c) => c.audit && !picked.has(c.value));
      if (offAudit.length > 0 && picked.size > 0) {
        findings.push(
          warning('vcflog91.src.audit-off', `${offAudit.map((c) => c.label).join(', ')} not collected: their sign-in and configuration-change events will not be in the log store.`, {
            remediation: 'Security investigations start from these. Collect them at Warning rather than not at all.',
            source: SRC,
          }),
        );
      }
      const levelOf = (component        )         => overrides.find((row) => row[0] === component)?.[1] || level;
      const debug = [...picked].filter((c) => levelOf(c) === 'Debug');
      if (debug.length > 0) findings.push(warning('vcflog91.src.debug', `Debug on ${debug.join(', ')}: many times the volume. Set it back when the troubleshooting is over.`, { source: SRC }));
      if (esx && !ingest) findings.push(error('vcflog91.src.no-ingest', 'ESX is ticked but there is no ingestion host to point it at.', { source: SRC }));
      if (esx && transport === 'udp') findings.push(warning('vcflog91.src.udp', 'ESX syslog over UDP loses events under load and is not encrypted.', { remediation: 'Use ssl:// — ESX verifies the log management certificate against its own trust store.', source: SRC }));

      const config = {
        sources: COMPONENTS.map((c) => {
          const row = overrides.find((r) => r[0] === c.value);
          return { component: c.value, enabled: picked.has(c.value), level: levelOf(c.value), excludeAppnames: row ? listOf(row[2] ?? '') : [] };
        }),
      };

      const hostLiteral = ingest.includes(':') && !ingest.startsWith('[') ? `[${ingest}]` : ingest;
      const logHost = `${transport}://${hostLiteral}:${esxPort}`;
      const esxScript = [
        '#!/usr/bin/env bash',
        `# Point every ESX host under ${esxScope} at log management: ${logHost}.`,
        '#',
        '# Uses govc against vCenter (GOVC_URL, GOVC_USERNAME, and GOVC_PASSWORD from',
        '# your own secret store — never in this file). Saves each host’s current',
        '# Syslog.global.logHost first (esx-syslog-before-<time>.tsv, the undo), opens',
        '# the syslog firewall ruleset, reloads syslog. --dry-run lists the hosts only.',
        'set -euo pipefail',
        'command -v govc >/dev/null || { echo "govc is required" >&2; exit 2; }',
        ': "${GOVC_URL:?set GOVC_URL to the vCenter}"',
        `LOGHOST=${sq(logHost)}`,
        `SCOPE=${sq(esxScope)}`,
        'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        'BEFORE="esx-syslog-before-$(date +%Y%m%d-%H%M%S).tsv"',
        'mapfile -t HOSTS < <(govc find "$SCOPE" -type h)',
        '(( ${#HOSTS[@]} > 0 )) || { echo "No ESX hosts under $SCOPE." >&2; exit 1; }',
        'echo "${#HOSTS[@]} host(s) under $SCOPE."',
        'FAILED=0',
        'for h in "${HOSTS[@]}"; do',
        '  now=$(govc host.option.ls -host "$h" Syslog.global.logHost 2>/dev/null | awk -F": *" \'{print $2}\' || true)',
        '  if (( DRY_RUN )); then echo "DRY RUN: $h: ${now:-<none>} -> $LOGHOST"; continue; fi',
        '  printf "%s\\t%s\\n" "$h" "$now" >> "$BEFORE"',
        '  if govc host.option.set -host "$h" Syslog.global.logHost "$LOGHOST" \\',
        '    && govc host.esxcli -host "$h" network firewall ruleset set -r syslog -e true >/dev/null \\',
        ...(setLevel ? [`    && govc host.option.set -host "$h" Config.HostAgent.log.level ${ESX_LEVEL[levelOf('esx')] ?? 'info'} \\`] : []),
        '    && govc host.esxcli -host "$h" system syslog reload >/dev/null; then',
        '    echo "ok     $h"',
        '  else',
        '    echo "FAILED $h" >&2; FAILED=$((FAILED + 1))',
        '  fi',
        'done',
        '(( DRY_RUN )) && { echo "Dry run: nothing was changed."; exit 0; }',
        'echo "Previous values: $BEFORE (the undo: set each host back with govc host.option.set)."',
        '(( FAILED == 0 )) || { echo "$FAILED host(s) failed." >&2; exit 1; }',
        '',
      ].join('\n');

      const calls             = [{ what: 'log source configuration', key: 'log sources', path: '/api/v2/log-sources', method: 'PUT', payload: 'log-sources.json' }];
      const apply = logsApplyScript({
        purpose: 'Set which VCF components send to VCF Operations 9.1 log management, and at what level.',
        calls,
        undo: 'PUT the saved before-<time>/log-sources-before.json back to the same path.',
        manual: `${base}-APPLY.md`,
        after: esx ? ['bash "$HERE/esx-syslog.sh"'] : [],
      });

      const vksValues = picked.has('vks')
        ? md([
            '# Values for the VKS standard package fluent-bit, pointing at log management.',
            '# VERIFY: 9.1 configures the VKS clusters it manages itself; use this only for a',
            '# cluster where it does not, and check the package values schema on your release.',
            'fluent_bit:',
            '  config:',
            '    outputs: |',
            '      [OUTPUT]',
            '          Name                syslog',
            '          Match               *',
            `          Host                ${ingest}`,
            '          Port                6514',
            '          Mode                tls',
            '          tls                 On',
            '          tls.verify          On',
            '          Syslog_Format       rfc5424',
            '          Syslog_Message_Key  log',
          ])
        : undefined;

      return {
        platform: LOGS,
        title: `Log sources — ${[...picked].length} component(s) at ${level}${esx ? `, ESX to ${logHost}` : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once by apply.sh; from then each component sends what its level lets through.', worstCase: 'every component’s full log rate, continuously' },
        scope: {
          what: `${[...picked].map((c) => COMPONENTS.find((x) => x.value === c)?.label ?? c).join(', ') || 'Nothing'}${esx ? `; ESX hosts under ${esxScope} in the vCenter govc points at` : ''}.`,
          decidedBy: ['The components ticked.', 'The level for each: the default, or its row.', 'The appnames dropped per component.', ...(esx ? [`The govc inventory path ${esxScope}.`] : [])],
          ifWrong: 'A component switched off leaves a hole in the audit trail that is found during an incident. A level too verbose fills the store and shortens every partition’s real retention.',
        },
        guardrails: [
          { rule: 'The configuration as it was is saved before the PUT, and ESX hosts’ previous log host is saved per host', because: 'The undo is putting those back, and it needs them.' },
          { rule: 'The generator warns when an audit-relevant component (ESX, vCenter, NSX, SDDC Manager, VCF Operations, Identity Broker) is left out', because: 'Sign-in and change events are the first thing an investigation asks for.' },
          ...(esx ? [{ rule: 'esx-syslog.sh exits 1 when any host fails, and names it', because: 'A host that kept its old log host sends nowhere, silently.' }] : []),
        ],
        dryRun: ['Run ./apply.sh --dry-run: it prints what it would send and signs in to nothing.', ...(esx ? ['Run ./esx-syslog.sh --dry-run: it lists every host and the change, and changes nothing.'] : [])],
        undo: ['PUT before-<time>/log-sources-before.json back.', ...(esx ? ['Set each host’s Syslog.global.logHost back from esx-syslog-before-<time>.tsv.'] : [])],
        told: ['Nobody. The Log Collection page shows each source’s state; record the change.'],
        requires: ['Log management 9.1 integrated with VCF Operations.', ...(esx ? ['govc with GOVC_URL and credentials for vCenter from your secret store.', `ESX hosts able to reach ${ingest}:${esxPort}${ingest.includes(':') ? ' over IPv6' : ''}, and trusting its certificate (for ssl://).`] : [])],
        files: {
          'log-sources.json': json(config),
          'apply.sh': apply,
          ...(esx ? { 'esx-syslog.sh': esxScript } : {}),
          ...(vksValues ? { 'vks-fluent-bit-values.yaml': vksValues } : {}),
          [`${base}-APPLY.md`]: md([
            '# Log sources by hand (only when apply.sh stops with exit 3)',
            '',
            `1. VCF Operations → ${CONFIGURATIONS} → **Log Collection**.`,
            ...COMPONENTS.map((c, i) => `${i + 2}. ${c.label}: ${picked.has(c.value) ? `on, level ${levelOf(c.value)}${(overrides.find((r) => r[0] === c.value)?.[2] ?? '') ? `, drop ${overrides.find((r) => r[0] === c.value)?.[2]}` : ''}` : 'off'}.`),
            '',
            'vCenter and NSX log collection is also a setting on each adapter account in VCF Operations (Log collection on).',
            ...(esx ? ['', `ESX: esx-syslog.sh sets Syslog.global.logHost to ${logHost} on every host; it does not depend on the log management API.`] : []),
          ]),
        },
        notes: [
          logsApplyNote(),
          'VERIFY: the log source configuration payload (component keys, level names, excludeAppnames) is not in the 9.1 API reference; compare with before-<time>/log-sources-before.json after the first run.',
          '9.1 enables VCF management service logs automatically; 9.1.1 moves SDDC Manager log configuration into VCF Operations.',
          ...(picked.has('vks') ? ['VKS: vks-fluent-bit-values.yaml is for the fluent-bit standard package on a cluster 9.1 does not already configure; install it with your usual package tooling (VERIFY the command on your release).'] : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog91_access',
    platform: LOGS,
    label: 'Control who can search which logs (9.1)',
    group: 'Log management 9.1',
    description:
      'Log access control: a data set — the partitions and filter rows a role may see — and the role that grants it, assigned to Identity Broker groups. apply.sh creates both through the log management API, enabled.',
    inputs: [
      { id: 'role_name', label: 'Role', control: 'text', default: 'Application team — orders' },
      {
        id: 'permission',
        label: 'May',
        control: 'select',
        options: [
          { value: 'view', label: 'Search and view logs' },
          { value: 'view_export', label: 'Search, view and export' },
          { value: 'view_alerts', label: 'Search, view and create log alerts and queries' },
        ],
        default: 'view',
      },
      { id: 'partitions', label: 'Partitions', control: 'text', default: 'Audit & Logs', hint: 'Comma separated' },
      {
        id: 'filters',
        label: 'Only events where (all must match)',
        control: 'textarea',
        default: 'appname | Starts with | orders\nhostname | Starts with | app-',
        hint: 'field | operator | value',
        help: 'Operators: Contains, Does not contain, Starts with, Does not start with, Matches Regex, Exists, Does not exist. No rows: everything in the partitions.',
      },
      { id: 'groups', label: 'Identity Broker groups', control: 'text', default: 'app-orders-ops@example.com', hint: 'Comma separated' },
    ],
    automation: (values                 , name        )             => {
      const role = str(values, 'role_name', 'Log role');
      const permission = str(values, 'permission', 'view');
      const partitions = listOf(str(values, 'partitions', ''));
      const { conditions: filters, bad } = conditionRows(str(values, 'filters', ''));
      const groups = listOf(str(values, 'groups', ''));
      const base = slugOf(name || role, 'log-access');
      const dataSet = `${role} — data`;

      const findings            = [];
      if (partitions.length === 0) findings.push(error('vcflog91.access.no-partition', 'No partition: the role could search nothing.', { source: SRC }));
      for (const row of bad) findings.push(error('vcflog91.access.bad-filter', `Filter row "${row}" has an operator 9.1 does not offer, or no value.`, { source: SRC }));
      if (groups.length === 0) findings.push(warning('vcflog91.access.no-groups', 'No group is given the role, so nobody gets this access yet.', { source: SRC }));
      if (filters.length === 0 && partitions.some((p) => /audit/i.test(p))) {
        findings.push(
          warning('vcflog91.access.everything', 'No filter on a partition that holds the audit logs: this role can read every event in it, including other teams’ and the platform’s own sign-ins.', {
            remediation: 'Add filter rows that narrow it to the team’s own hosts or applications.',
            source: SRC,
          }),
        );
      }
      if (permission === 'view_export') findings.push(info('vcflog91.access.export', 'Export lets the role take events out of the log store, where masking and retention no longer apply.', { source: SRC }));

      const dataSetPayload = { name: dataSet, description: `What ${role} may see.`, partitions, filterOperator: 'AND', filters };
      const rolePayload = {
        name: role,
        description: `Log access for ${groups.join(', ') || 'no group yet'}.`,
        permissions: permission === 'view' ? ['LOGS_VIEW'] : permission === 'view_export' ? ['LOGS_VIEW', 'LOGS_EXPORT'] : ['LOGS_VIEW', 'LOGS_QUERIES', 'LOGS_ALERTS'],
        dataSets: [dataSet],
        groups,
        enabled: true,
      };

      return {
        platform: LOGS,
        title: `Log role "${role}" — ${partitions.join(', ') || 'no partition'}${filters.length > 0 ? `, where ${describeAll(filters)}` : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once by apply.sh; from then members of the groups can search what the data set allows.' },
        scope: {
          what: `Members of ${groups.join(', ') || '(no group)'}, searching ${partitions.join(', ')}${filters.length > 0 ? ` where ${describeAll(filters)}` : ''}.`,
          decidedBy: ['Membership of the Identity Broker groups.', 'The partitions in the data set.', 'The filter rows, all of which must match.', 'Any other role the same people hold: access adds up across roles.'],
          ifWrong: 'Too wide, and a team reads another team’s logs, or the platform’s sign-in audit; too narrow, and they cannot investigate their own incident.',
        },
        guardrails: [
          { rule: 'The data set and role are left alone when one with the same name exists', because: 'A second role with the same name is a second grant nobody reviews.' },
          { rule: 'The generator warns when the audit partition is granted with no filter', because: 'That is everyone’s events, not the team’s.' },
        ],
        dryRun: ['Run ./apply.sh --dry-run: it prints what it would send and signs in to nothing.', 'After applying, sign in as a member of one group and search: only the permitted events come back.'],
        undo: ['Delete the role, then the data set (ids under before-<time>/). Access ends at the next sign-in.'],
        told: ['Nobody. Record the grant with its owner and review it with the other access reviews.'],
        requires: ['Log management 9.1.', `The groups ${groups.join(', ') || '(none)'} in the Identity Broker.`, `The partitions ${partitions.join(', ')}.`],
        files: {
          'data-set.json': json(dataSetPayload),
          'role.json': json(rolePayload),
          'apply.sh': logsApplyScript({
            purpose: `Create the log data set and role "${role}" in VCF Operations 9.1 log management.`,
            calls: [
              { what: `data set ${dataSet}`, key: 'data sets', path: '/api/v1/datasets', payload: 'data-set.json', name: dataSet },
              { what: `role ${role}`, key: 'roles', path: '/api/v1/roles', payload: 'role.json', name: role },
            ],
            undo: 'delete the role, then the data set.',
            manual: `${base}-APPLY.md`,
          }),
          [`${base}-APPLY.md`]: md([
            `# "${role}" by hand (only when apply.sh stops with exit 3)`,
            '',
            `1. VCF Operations → ${CONFIGURATIONS} → log management access control (VERIFY the card name on 9.1).`,
            `2. Data set \`${dataSet}\`: partitions ${partitions.join(', ')}${filters.length > 0 ? `; filters (all): ${describeAll(filters)}` : ''}.`,
            `3. Role \`${role}\`: ${rolePayload.permissions.join(', ')}; data set \`${dataSet}\`.`,
            `4. Assign the role to ${groups.join(', ') || '(no group)'}.`,
          ]),
        },
        notes: [logsApplyNote(), 'VERIFY: the data set and role payloads (permissions names, partitions, groups) follow the 8.18 access-control API; compare with before-<time>/ after the first run.'],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog91_archive_import',
    platform: LOGS,
    label: 'Import archived logs into a partition (9.1)',
    group: 'Log management 9.1',
    description:
      'An import task that brings archived logs back from S3 or NFS, for a time range, into a target partition — so events past retention can be searched again for an investigation or an audit. apply.sh creates the task; a partition used only for imports keeps them apart from live events.',
    inputs: [
      { id: 'task_name', label: 'Import task', control: 'text', default: 'Audit 2025 Q4' },
      {
        id: 'source',
        label: 'From',
        control: 'select',
        options: [
          { value: 's3', label: 'S3-compatible object storage' },
          { value: 'nfs', label: 'NFS v3 export' },
        ],
        default: 's3',
      },
      { id: 'location', label: 'Archive location (as configured in External Storage)', control: 'text', default: 'security-audit-archive' },
      { id: 'path', label: 'Path or prefix', control: 'text', default: '2025/', hint: 'Within the location. Empty imports the whole range from its root' },
      { id: 'start', label: 'From (date)', control: 'text', default: '2025-10-01', hint: 'YYYY-MM-DD, UTC' },
      { id: 'end', label: 'To (date)', control: 'text', default: '2025-12-31', hint: 'YYYY-MM-DD, UTC, inclusive' },
      { id: 'target_partition', label: 'Into partition', control: 'text', default: 'restored-audit', hint: 'A partition used for imports keeps them out of live searches' },
      { id: 'restored_days', label: 'Keep the imported events for (days)', control: 'number', default: 30, min: 1, max: 365, hint: 'The target partition’s retention' },
    ],
    automation: (values                 , name        )             => {
      const task = str(values, 'task_name', 'Import');
      const source = str(values, 'source', 's3');
      const location = str(values, 'location', '');
      const path = str(values, 'path', '');
      const start = str(values, 'start', '');
      const end = str(values, 'end', '');
      const target = str(values, 'target_partition', '');
      const days = num(values, 'restored_days', 30);
      const base = slugOf(name || task, 'log-import');
      const dateOk = (d        )          => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

      const findings            = [];
      if (!location) findings.push(error('vcflog91.import.no-location', 'No archive location to import from.', { source: SRC }));
      if (!dateOk(start) || !dateOk(end)) findings.push(error('vcflog91.import.date', 'Dates must be YYYY-MM-DD.', { source: SRC }));
      const span = dateOk(start) && dateOk(end) ? Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1 : 0;
      if (dateOk(start) && dateOk(end) && span < 1) findings.push(error('vcflog91.import.range', `The range ends (${end}) before it starts (${start}).`, { source: SRC }));
      if (span > 92) findings.push(warning('vcflog91.import.large', `${span} days in one import: it competes with ingestion for the same nodes, and fills the target partition.`, { remediation: 'Import a month at a time, and search each before the next.', source: SRC }));
      if (!target || /^(audit\s*&?\s*logs|logs)$/i.test(target)) {
        findings.push(
          warning('vcflog91.import.default-partition', 'Importing into the default partition mixes old events into live searches and alerts.', {
            remediation: 'Create a partition for imports ("A partition with its own retention and archive (9.1)") and import into that.',
            source: SRC,
          }),
        );
      }

      const payload = { name: task, sourceType: source.toUpperCase(), archiveLocation: location, path, startTime: `${start}T00:00:00Z`, endTime: `${end}T23:59:59Z`, targetPartition: target, enabled: true };

      return {
        platform: LOGS,
        title: `Import ${start} to ${end} from ${location || 'the archive'} into ${target || 'the default partition'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Created once by apply.sh; the task runs until the range is imported.', worstCase: 'once, for as long as the range takes to read' },
        scope: {
          what: `Archived events from ${start} to ${end} under ${location}${path ? `/${path}` : ''}, into ${target || 'the default partition'}.`,
          decidedBy: ['The archive location and path.', 'The time range.', `The target partition, whose retention (${days} days) decides how long they stay.`],
          ifWrong: 'Too wide a range slows ingestion while it runs and fills the target; the wrong target puts years-old events into live searches and alerts.',
        },
        guardrails: [
          { rule: 'The generator refuses a range that ends before it starts, and warns above three months', because: 'An import competes with live ingestion for the same nodes.' },
          { rule: 'A task with the same name is left alone', because: 'Importing the same range twice doubles every count in it.' },
        ],
        dryRun: ['Run ./apply.sh --dry-run: it prints what it would send and signs in to nothing.'],
        undo: ['Delete the task to stop it. Imported events age out of the target partition after its retention; deleting that partition removes them at once.'],
        told: ['Nobody. Tell whoever asked for the import that it has finished; the task shows its state.'],
        requires: [`The archive location "${location}" configured in External Storage.`, `The partition "${target}" with a retention of about ${days} days.`, 'Log management 9.1.'],
        files: {
          'import-task.json': json(payload),
          'apply.sh': logsApplyScript({
            purpose: `Create the log import task "${task}" in VCF Operations 9.1 log management.`,
            calls: [{ what: `import task ${task}`, key: 'import tasks', path: '/api/v2/import-tasks', payload: 'import-task.json', name: task }],
            undo: 'delete the task; imported events age out of the target partition.',
            manual: `${base}-APPLY.md`,
          }),
          [`${base}-APPLY.md`]: md([
            `# Import "${task}" by hand (only when apply.sh stops with exit 3)`,
            '',
            `1. VCF Operations → ${CONFIGURATIONS} → log import and export tasks (Configuring Log Import and Export Tasks).`,
            `2. New import: source ${source.toUpperCase()}, location \`${location}\`${path ? `, path \`${path}\`` : ''}.`,
            `3. Range ${start} 00:00 to ${end} 23:59 UTC; target partition \`${target}\`.`,
            '4. Start it, and watch its progress in the task list.',
          ]),
        },
        notes: [logsApplyNote(), 'VERIFY: the import task path and payload; 9.1 documents import and export tasks in the interface.'],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog91_extracted_fields',
    platform: LOGS,
    label: 'Extracted fields, with a test for each (9.1)',
    group: 'Log management 9.1',
    description:
      'Fields extracted from log events — each a name, the text before the value, the value regex, the text after it and the events it applies to — tested against real sample lines, then created through the log management API. Queries, dashboards, alerts and access filters can then use them by name.',
    inputs: [
      {
        id: 'fields',
        label: 'Fields',
        control: 'textarea',
        default: 'gateway_latency_ms | latency= | \\d+ | ms | appname=orders-api\norder_id | order= | [A-Z]-\\d+ | \\b | appname=orders-api\nhttp_status | HTTP/1\\.\\d"\\s | \\d{3} | \\s | appname=nginx',
        hint: 'name | before (regex) | value regex | after (regex) | only where field=value',
      },
      {
        id: 'samples',
        label: 'Sample lines',
        control: 'textarea',
        default:
          '2026-05-01T10:00:00Z app01 orders-api: ERROR payment gateway timeout latency=30012ms order=A-1001\n10.0.0.5 - - [01/May/2026:10:00:01 +0000] "GET /orders HTTP/1.1" 200 512',
        hint: 'Real lines, secrets replaced. Every field must extract from at least one',
      },
    ],
    automation: (values                 , name        )             => {
      const rows = rowsOf(str(values, 'fields', ''), 5).filter((row) => row[0]);
      const samples = str(values, 'samples', '').split('\n').map((line) => line.trim()).filter(Boolean);
      const base = slugOf(name || 'extracted-fields', 'extracted-fields');

      const findings            = [];
      if (rows.length === 0) findings.push(error('vcflog91.fields.none', 'No field rows.', { source: SRC }));
      const seen = new Set        ();
      for (const [field, pre, value, post] of rows) {
        if (seen.has(field )) findings.push(error('vcflog91.fields.duplicate', `"${field}" is defined twice.`, { source: SRC }));
        seen.add(field );
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field )) findings.push(error('vcflog91.fields.name', `"${field}": a field name is letters, digits and underscores, starting with a letter.`, { source: SRC }));
        if (!value) findings.push(error('vcflog91.fields.no-value', `"${field}" has no value regex.`, { source: SRC }));
        if (!pre && !post) findings.push(error('vcflog91.fields.no-context', `"${field}" has no text before or after the value, so it matches anywhere in every line.`, { source: SRC }));
        for (const part of [pre, value, post]) {
          try {
            new RegExp(part || '.');
          } catch {
            findings.push(error('vcflog91.fields.regex', `"${field}": "${part}" does not compile as a regex.`, { source: SRC }));
          }
        }
      }
      if (samples.length === 0) findings.push(warning('vcflog91.fields.no-samples', 'No sample lines: the test proves nothing.', { source: SRC }));

      const fieldFiles                         = {};
      const calls             = [];
      for (const [field, pre, value, post, where] of rows) {
        const [whereField, whereValue] = (where ?? '').split('=').map((part) => part.trim());
        const payload = {
          name: field,
          preContext: pre,
          valueRegex: value,
          postContext: post,
          ...(whereField && whereValue ? { filters: [{ field: whereField, operator: 'Contains', value: whereValue }] } : {}),
        };
        const file = `fields/${slugOf(field , 'field')}.json`;
        fieldFiles[file] = json(payload);
        calls.push({ what: `extracted field ${field}`, key: 'extracted fields', path: '/api/v2/extracted-fields', payload: file, name: field });
      }

      const test = [
        '#!/usr/bin/env bash',
        '# Does every field extract a value from at least one sample line?',
        '# Local only. Exits 1 when a field extracts nothing from every sample.',
        'set -euo pipefail',
        'command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 2; }',
        'cd "$(dirname "$0")"',
        "python3 - samples.txt fields/*.json <<'PY'",
        'import json, re, sys',
        'samples = [l.rstrip("\\n") for l in open(sys.argv[1], encoding="utf-8") if l.strip() and not l.startswith("#")]',
        'bad = 0',
        'for path in sys.argv[2:]:',
        '    f = json.load(open(path, encoding="utf-8"))',
        '    rx = re.compile("(?:" + f["preContext"] + ")(" + f["valueRegex"] + ")(?:" + f["postContext"] + ")")',
        '    hits = [m for line in samples for m in rx.findall(line)]',
        '    if hits:',
        '        print("ok    %s = %s" % (f["name"], ", ".join(hits[:5])))',
        '    else:',
        '        print("FAIL  %s extracts nothing from any sample line" % f["name"])',
        '        bad += 1',
        'sys.exit(1 if bad else 0)',
        'PY',
        '',
      ].join('\n');

      return {
        platform: LOGS,
        title: `${rows.length} extracted field(s): ${rows.map((row) => row[0]).join(', ')}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Created once by apply.sh; from then each field is extracted from matching events at search time.' },
        scope: {
          what: `Events matching each field’s filter: ${rows.map((row) => `${row[0]} (${row[4] || 'all events'})`).join('; ')}.`,
          decidedBy: ['Each field’s filter.', 'The text before and after the value, which anchor it.'],
          ifWrong: 'A loose field extracts the wrong number from the wrong lines, and every chart, alert and access filter built on it is wrong without saying so.',
        },
        guardrails: [
          { rule: 'apply.sh runs test-fields.sh first and applies nothing when a field extracts nothing from every sample', because: 'A field that never matches makes everything built on it empty.' },
          { rule: 'A field with the same name is left alone', because: 'Two definitions of one field name make the value depend on which one wins.' },
        ],
        dryRun: ['Run ./test-fields.sh.', 'Run ./apply.sh --dry-run: it prints what it would send and signs in to nothing.'],
        undo: ['Delete the fields (ids under before-<time>/). Nothing stored changes: extraction is at search time.'],
        told: ['Nobody. The fields appear in the field list in Explore Logs.'],
        requires: ['Log management 9.1.', 'python3, jq and curl.'],
        files: {
          ...fieldFiles,
          'samples.txt': md(['# Real lines, secrets replaced.', ...samples]),
          'test-fields.sh': test,
          'apply.sh': logsApplyScript({
            purpose: 'Test, then create the extracted fields in VCF Operations 9.1 log management.',
            extraTools: ['python3'],
            first: ['bash "$HERE/test-fields.sh" || { echo "test-fields.sh failed: nothing applied." >&2; exit 1; }', ''],
            calls,
            undo: 'delete the fields by the ids saved under before-<time>/.',
            manual: `${base}-APPLY.md`,
          }),
          [`${base}-APPLY.md`]: md([
            '# Extracted fields by hand (only when apply.sh stops with exit 3)',
            '',
            'Explore Logs → select the value in a matching event → Extract Field, for each:',
            '',
            ...rows.map((row) => `- \`${row[0]}\`: before \`${row[1]}\`, value \`${row[2]}\`, after \`${row[3]}\`${row[4] ? `, only where ${row[4]}` : ''}.`),
          ]),
        },
        notes: [logsApplyNote(), 'The text before and after the value are regular expressions, as in the Extract Field form; escape . and other metacharacters meant literally.'],
        findings,
      };
    },
  }),
];
