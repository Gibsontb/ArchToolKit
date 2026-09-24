/**
 * Splunk forwarder: the operating systems, and getting the forwarder there.
 *
 * Windows and Linux inputs are where most licence goes and most detections
 * start, and both go wrong in the same few ways. On Windows: the Security log
 * collected in full on a domain controller, where directory-service access
 * events (4662) and filtering-platform connections (5156) are most of the
 * volume and almost none of the value; and classic text rendering, which
 * indexes the same paragraph of boilerplate on every event. On Linux: the
 * whole of /var/log monitored recursively, and a forwarder that cannot read
 * /var/log/secure or audit.log because it is — correctly — not root, and so
 * silently collects nothing from the two files that matter most.
 *
 * The install blueprint writes the scripts that put the universal forwarder on
 * the imported estate's Windows and Linux machines, pointed at a deployment
 * server, running as a non-root account, with an admin password that never
 * exists in plain text in a file or on a command line.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { currentEstate } from '../../kit/estate-store.ts';
import { splunkBlueprint, type SplunkBlueprint } from '../from-app.ts';
import { defaultMeta, listOf, splunkName, type SplunkApp } from '../splunk.ts';
import { formatHostPort, isIpv6, splitHostPort } from '../../core/ip.ts';

const TIER = 'forwarder' as const;

// --- estate ---------------------------------------------------------------

/** Something a shell or WinRM will accept as a host name, or nothing. */
function hostAddress(value: string | undefined): string {
  const v = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v) ? v : '';
}

const LINUX_OS = /linux|rhel|red hat|centos|ubuntu|debian|suse|sles|oracle|rocky|alma|photon|amazon|fedora/i;

/**
 * The powered-on Windows and Linux VMs of the imported estate, by the address
 * the guest reported — DNS name first, then IP, then the VM name when that is
 * a plausible host name. Null when no estate is loaded.
 */
function estateHosts(): { windows: string[]; linux: string[]; skipped: number } | null {
  const inventory = currentEstate()?.inventory;
  if (!inventory) return null;
  const windows = new Set<string>();
  const linux = new Set<string>();
  let skipped = 0;
  for (const vm of inventory.vms) {
    if (vm.template || vm.srmPlaceholder || vm.powerState !== 'poweredOn') continue;
    const os = `${vm.guestOsTools ?? ''} ${vm.guestOs ?? ''}`;
    const address = hostAddress(vm.dnsName) || hostAddress(vm.ipAddress) || hostAddress(vm.name);
    if (!address) {
      skipped += 1;
      continue;
    }
    if (/windows/i.test(os)) windows.add(address);
    else if (LINUX_OS.test(os)) linux.add(address);
    else skipped += 1;
  }
  return { windows: [...windows].sort(), linux: [...linux].sort(), skipped };
}

// --- Windows event codes --------------------------------------------------

/**
 * The Security events a SOC actually builds detections on. Used for the lean
 * profile as a whitelist; everything else is dropped at the forwarder.
 */
const SECURITY_CORE = [
  '1102', // audit log cleared
  '4624', '4625', '4634', '4647', '4648', // logon, failed logon, logoff, explicit credentials
  '4672', // special privileges at logon
  '4688', // process creation (with command line if the GPO enables it)
  '4697', '4698', '4702', // service installed, scheduled task created / updated
  '4719', // audit policy changed
  '4720', '4722', '4723', '4724', '4725', '4726', '4738', '4740', '4767', // account lifecycle, lockout, unlock
  '4728', '4732', '4756', '4729', '4733', '4757', // group membership changes
  '4768', '4769', '4771', '4776', // Kerberos and NTLM on domain controllers
  '4662', // kept in the whitelist; the replication-only filter below still applies
  '5140', '5145', // share access — noisy on file servers, see the note
];

// --- Linux ----------------------------------------------------------------

/** Splunk_TA_nix scripted inputs worth running, with the intervals the add-on ships. */
const NIX_SCRIPTS: readonly { script: string; interval: number; why: string }[] = [
  { script: 'cpu', interval: 30, why: 'per-CPU utilisation' },
  { script: 'vmstat', interval: 60, why: 'memory and swap' },
  { script: 'iostat', interval: 60, why: 'disk latency and throughput' },
  { script: 'df', interval: 300, why: 'filesystem capacity' },
  { script: 'ps', interval: 30, why: 'process list — the busiest of these, raise it on large fleets' },
  { script: 'netstat', interval: 60, why: 'socket state counts' },
  { script: 'interfaces', interval: 60, why: 'NIC counters and errors' },
  { script: 'openPorts', interval: 300, why: 'listening ports — useful for drift detection' },
  { script: 'package', interval: 3600, why: 'installed packages, for vulnerability joins' },
];

export const FORWARDER_MORE_BLUEPRINTS: readonly SplunkBlueprint[] = [
  splunkBlueprint({
    id: 'splunk_windows_inputs',
    tier: TIER,
    label: 'Windows event logs, Sysmon and perfmon',
    group: 'Operating systems',
    description: 'Security, System and Application event logs rendered as XML, with the domain-controller noise filtered at the forwarder; Sysmon, PowerShell and Defender channels; and a small perfmon set — in the shape Splunk_TA_windows expects.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_windows_inputs' },
      { id: 'role', label: 'These machines are', control: 'select', default: 'server', options: [
        { value: 'server', label: 'Member servers' },
        { value: 'dc', label: 'Domain controllers' },
        { value: 'workstation', label: 'Workstations' },
      ] },
      { id: 'index', label: 'Event log index', control: 'text', default: 'wineventlog' },
      { id: 'profile', label: 'Security log profile', control: 'select', default: 'soc', options: [
        { value: 'soc', label: 'SOC — everything except the known noise' },
        { value: 'lean', label: 'Lean — only the event codes detections use' },
        { value: 'all', label: 'Everything — no filtering' },
      ] },
      { id: 'render_xml', label: 'Render as XML', control: 'toggle', default: true, hint: 'XmlWinEventLog — what Splunk_TA_windows and the Sysmon add-on expect' },
      { id: 'suppress_text', label: 'Drop the message text', control: 'toggle', default: true, hint: 'The rendered paragraph of explanation on every event', showWhen: { input: 'render_xml', equals: ['true'] } },
      { id: 'backlog', label: 'Read the existing log on first start', control: 'toggle', default: false, hint: 'Off: start from now. On: read everything already in the log' },
      { id: 'sysmon', label: 'Sysmon', control: 'toggle', default: true },
      { id: 'sysmon_index', label: 'Sysmon index', control: 'text', default: 'sysmon', showWhen: { input: 'sysmon', equals: ['true'] } },
      { id: 'powershell', label: 'PowerShell Operational', control: 'toggle', default: true, hint: 'Script block logging (4104) must be enabled by Group Policy' },
      { id: 'defender', label: 'Defender Operational', control: 'toggle', default: true },
      { id: 'perfmon', label: 'Perfmon counters', control: 'toggle', default: true },
      { id: 'perfmon_index', label: 'Perfmon index', control: 'text', default: 'perfmon', showWhen: { input: 'perfmon', equals: ['true'] } },
      { id: 'perfmon_interval', label: 'Perfmon interval (seconds)', control: 'number', default: 60, min: 10, max: 3600, showWhen: { input: 'perfmon', equals: ['true'] } },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_windows_inputs'), 'org_windows_inputs');
      const role = str(values, 'role', 'server');
      const index = splunkName(str(values, 'index', 'wineventlog'), 'wineventlog');
      const profile = str(values, 'profile', 'soc');
      const xml = bool(values, 'render_xml', true);
      const suppress = xml && bool(values, 'suppress_text', true);
      const backlog = bool(values, 'backlog', false);
      const sysmon = bool(values, 'sysmon', true);
      const sysmonIndex = splunkName(str(values, 'sysmon_index', 'sysmon'), 'sysmon');
      const perfmon = bool(values, 'perfmon', true);
      const perfIndex = splunkName(str(values, 'perfmon_index', 'perfmon'), 'perfmon');
      const perfInterval = Math.max(10, num(values, 'perfmon_interval', 60));
      const sourcetype = xml ? 'XmlWinEventLog' : 'WinEventLog';
      const findings: Finding[] = [];

      if (!xml) {
        findings.push(
          warning('splunk.windows-classic-render', 'The Security log in classic text rendering indexes the full explanatory message on every event — often more than half of each event, and so more than half the licence — and the Sysmon add-on and current Splunk_TA_windows searches expect XmlWinEventLog.', {
            remediation: 'renderXml = true, with suppress_text = 1 to drop the rendered message. Field extraction from the XML is done by Splunk_TA_windows at search time.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (role === 'dc' && profile === 'all') {
        findings.push(
          warning('splunk.dc-4662-unfiltered', 'A domain controller logging directory-service access (4662) with no filter sends one event for every object read of every audited object. On a busy DC that is routinely the largest single source in the whole deployment, and nearly all of it is the DC talking to itself.', {
            remediation: 'Use the SOC profile: it drops 4662 except the directory-replication rights that DCSync detection needs.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (backlog) {
        findings.push(
          warning('splunk.windows-backlog', 'Reading the existing logs on first start sends everything already in them — on a server with a 4 GB Security log that is 4 GB per server in the first hour, from every server the app is mapped to at once.', {
            remediation: 'Map the app to a few machines first, or start from now and accept the gap.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (role === 'workstation' && profile === 'all') {
        findings.push(info('splunk.workstation-all', 'Every Security event from every workstation is a lot of licence for 4624 type 3 logons and 4634 logoffs. The lean profile is usually right for endpoints, with Sysmon carrying the process detail.', { source: 'ArchToolKit' }));
      }

      // The filter lines, as the SOC and lean profiles write them.
      // With renderXml the Message key is not available to a blacklist, so the
      // content match is done with $XmlRegex against the raw XML.
      const replicationGuids = [
        '1131f6aa-9c07-11d1-f79f-00c04fc2dcd2', // DS-Replication-Get-Changes
        '1131f6ad-9c07-11d1-f79f-00c04fc2dcd2', // DS-Replication-Get-Changes-All
        '89e95b76-444d-4c62-991a-0facbeda640c', // DS-Replication-Get-Changes-In-Filtered-Set
      ];
      const securityFilter: string[] =
        profile === 'all'
          ? ['# No filtering: every Security event is sent.']
          : [
              ...(profile === 'lean'
                ? [
                    '# Lean: only the event codes detections are built on. Anything',
                    '# not listed here is dropped on the forwarder and never licensed.',
                    `whitelist1 = EventCode="^(${SECURITY_CORE.join('|')})$"`,
                    '# The blacklists below still apply to what the whitelist lets',
                    '# through. VERIFY the precedence on your version with btool and a',
                    '# test host before rolling out.',
                  ]
                : []),
              '# 5156/5158: Windows Filtering Platform permitted a connection / a',
              '# bind. One event per connection — the firewall log, badly. Take',
              '# network data from the network.',
              'blacklist1 = EventCode="^(5156|5158)$"',
              '# 4662 on a domain controller: an event for every read of an audited',
              '# directory object. Dropped unless it carries one of the replication',
              '# rights, which is what DCSync detection looks for. VERIFY the',
              '# pattern against a sample of your own 4662 XML before relying on it.',
              ...(xml
                ? [`blacklist2 = $XmlRegex="<EventID>4662</EventID>(?!.*(${replicationGuids.join('|')}))"`]
                : ['blacklist2 = EventCode="4662" Message="(?s)^(?!.*(' + replicationGuids.join('|') + '))"']),
              '# 4658/4690: handle closed / handle duplicated. Pairs with 4656/4663',
              '# object access and says nothing on its own.',
              'blacklist3 = EventCode="^(4658|4690)$"',
              '# Splunk\u2019s own processes creating processes (4688) — the forwarder',
              '# running btool and its helpers. Present on every host, useless.',
              ...(xml
                ? ["blacklist4 = $XmlRegex=\"<EventID>4688</EventID>.*<Data Name='NewProcessName'>[C-F]:\\\\Program Files\\\\Splunk(?:UniversalForwarder)?\\\\bin\\\\\""]
                : ['blacklist4 = EventCode="4688" Message="New Process Name:\\s+[C-F]:\\\\Program Files\\\\Splunk(?:UniversalForwarder)?\\\\bin\\\\"']),
            ];

      const eventLog = (channel: string, extra: string[], idx = index): string[] => [
        `[WinEventLog://${channel}]`,
        'disabled = 0',
        `index = ${idx}`,
        `renderXml = ${xml ? 'true' : 'false'}`,
        ...(suppress ? ['# Drop the rendered explanatory text; the fields are all in the XML.', 'suppress_text = 1'] : []),
        '# Resume from the saved position after a restart, and save it every 5s.',
        `start_from = oldest`,
        `current_only = ${backlog ? 0 : 1}`,
        'checkpointInterval = 5',
        ...extra,
        '',
      ];

      return {
        tier: TIER,
        title: `Windows ${role === 'dc' ? 'domain controller' : role === 'workstation' ? 'workstation' : 'server'} event logs into ${index}${sysmon ? ', Sysmon' : ''}${perfmon ? ', perfmon' : ''}`,
        app,
        activation: 'restart',
        notes: [
          `Deploy Splunk_TA_windows (Splunk Add-on for Microsoft Windows) to the search heads and indexers as well. This app only collects; the add-on parses ${sourcetype} and maps it to the CIM. Keep its own inputs disabled on these forwarders so the two do not both collect.`,
          ...(sysmon ? ['Sysmon needs the Splunk Add-on for Sysmon (Splunk_TA_microsoft_sysmon) on the search heads, and Sysmon itself installed with a considered config — the default Sysmon config logs almost nothing useful and an unfiltered one logs everything.'] : []),
          ...(bool(values, 'powershell', true) ? ['PowerShell 4104 script block events only exist if "Turn on PowerShell Script Block Logging" is set by Group Policy. The input collects what the policy produces.'] : []),
          'Audit policy decides what the Security log contains at all. 4688 without "Include command line in process creation events" is a process name and little else.',
          backlog
            ? 'current_only = 0 with start_from = oldest reads the whole existing log on first start, then resumes from its checkpoint.'
            : 'current_only = 1 starts from now. VERIFY on your version: with current_only = 1 the input does not replay events written while the forwarder was stopped — accept that gap, or switch to 0 once the first rollout is done.',
          'evt_resolve_ad_obj asks a domain controller to resolve SIDs and GUIDs for every event. It is off here: Splunk_TA_windows lookups do the same at search time without a DC round-trip per event. VERIFY whether it applies at all with renderXml on your version.',
          'Restart the forwarder after deploying. WinEventLog inputs are not picked up by a reload.',
        ],
        before: [
          'wevtutil gl Security   # current log size and retention on a sample host',
          'auditpol /get /category:*   # the audit policy decides what exists to collect',
          `| rest /services/data/indexes | search title IN (${[index, ...(sysmon ? [sysmonIndex] : []), ...(perfmon ? [perfIndex] : [])].join(', ')}) | table title, splunk_server`,
          '"C:\\Program Files\\SplunkUniversalForwarder\\bin\\splunk.exe" cmd btool inputs list WinEventLog --debug',
          `index=${index} earliest=-24h | stats count by host, EventCode | sort - count | head 20   # what is volume today`,
        ],
        files: {
          'default/inputs.conf': [
            '# Windows event logs. Field extraction and CIM mapping are done by',
            `# Splunk_TA_windows at search time from sourcetype ${sourcetype}.`,
            '',
            ...eventLog('Security', [
              '# Leave SID and GUID resolution to the add-on\u2019s lookups at search',
              '# time, rather than a DC round-trip per event on the forwarder.',
              'evt_resolve_ad_obj = 0',
              ...securityFilter,
            ]),
            ...eventLog('System', []),
            ...eventLog('Application', []),
            ...(sysmon
              ? eventLog('Microsoft-Windows-Sysmon/Operational', [
                  '# Sysmon is only parsed as XML; the Sysmon add-on expects',
                  '# source XmlWinEventLog:Microsoft-Windows-Sysmon/Operational.',
                ], sysmonIndex).map((l) => (l.startsWith('renderXml') ? 'renderXml = true' : l))
              : []),
            ...(bool(values, 'powershell', true)
              ? eventLog('Microsoft-Windows-PowerShell/Operational', [
                  '# 4103 module logging and 4104 script blocks; 4105/4106 are',
                  '# start/stop markers that only exist with verbose logging on.',
                  'blacklist1 = EventCode="^(4105|4106)$"',
                ])
              : []),
            ...(bool(values, 'defender', true) ? eventLog('Microsoft-Windows-Windows Defender/Operational', ['# Detections (1116/1117), and real-time protection changes (5001).']) : []),
            ...(perfmon
              ? [
                  '# Perfmon: a small set at a modest interval. Every counter on every',
                  '# instance every 10s is how perfmon becomes the biggest sourcetype.',
                  ...[
                    { name: 'CPU', object: 'Processor', counters: '% Processor Time; % User Time; % Privileged Time; % Interrupt Time', instances: '_Total' },
                    { name: 'Memory', object: 'Memory', counters: 'Available MBytes; Pages/sec; % Committed Bytes In Use; Pool Nonpaged Bytes', instances: '' },
                    { name: 'LogicalDisk', object: 'LogicalDisk', counters: '% Free Space; Free Megabytes; Avg. Disk sec/Read; Avg. Disk sec/Write; Current Disk Queue Length', instances: '*' },
                    { name: 'Network', object: 'Network Interface', counters: 'Bytes Received/sec; Bytes Sent/sec; Packets Received Errors; Packets Outbound Errors', instances: '*' },
                  ].flatMap((p) => [
                    `[perfmon://${p.name}]`,
                    'disabled = 0',
                    `object = ${p.object}`,
                    `counters = ${p.counters}`,
                    ...(p.instances ? [`instances = ${p.instances}`] : []),
                    `interval = ${perfInterval}`,
                    '# One event per sample rather than one per counter.',
                    'mode = single',
                    '# Counter names in English whatever the OS language, so searches',
                    '# work on every host.',
                    'useEnglishOnly = true',
                    `index = ${perfIndex}`,
                    '',
                  ]),
                ]
              : []),
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          '"C:\\Program Files\\SplunkUniversalForwarder\\bin\\splunk.exe" list inputstatus',
          `index=${index} host=<a forwarder> earliest=-15m | stats count by source, sourcetype`,
          `index=${index} source="${sourcetype}:Security" earliest=-1h | stats count by EventCode | sort - count   # 5156 and 4658 should be absent`,
          ...(sysmon ? [`index=${sysmonIndex} source="XmlWinEventLog:Microsoft-Windows-Sysmon/Operational" earliest=-15m | stats count by EventCode`] : []),
          ...(perfmon ? [`index=${perfIndex} earliest=-15m | stats count by sourcetype, host`] : []),
          'index=_internal host=<a forwarder> sourcetype=splunkd (component=WinEventLogChannel OR component=ExecProcessor) log_level=ERROR | tail 20',
          `index=_internal source=*license_usage.log* type=Usage idx=${index} earliest=-24h | stats sum(b) as bytes by h | sort - bytes   # licence by host, before and after`,
        ],
        backout: [
          `Remove ${app} from the serverclass on the deployment server, then: splunk reload deploy-server`,
          '# Or on a single host: remove the app directory and restart the SplunkForwarder service.',
          '# Event log checkpoints stay in the forwarder\u2019s modinputs directory; re-adding the app resumes from them.',
        ],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_linux_inputs',
    tier: TIER,
    label: 'Linux logs, journald and OS metrics',
    group: 'Operating systems',
    description: 'The Linux files that matter — messages, secure/auth.log, audit.log — named one by one with the sourcetypes Splunk_TA_nix expects, optionally the journald input, and the add-on\u2019s scripted OS metrics at intervals that do not become the largest sourcetype.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_linux_inputs' },
      { id: 'index', label: 'Index', control: 'text', default: 'os' },
      { id: 'audit', label: 'auditd log', control: 'toggle', default: true },
      { id: 'journald', label: 'journald input', control: 'toggle', default: false, hint: 'For distributions that do not write /var/log/messages' },
      { id: 'journald_units', label: 'Only these units', control: 'text', default: '', placeholder: 'sshd.service, nginx.service', showWhen: { input: 'journald', equals: ['true'] } },
      { id: 'journald_priority', label: 'Up to priority', control: 'select', default: '0..5', options: [
        { value: '0..3', label: 'err and worse' },
        { value: '0..4', label: 'warning and worse' },
        { value: '0..5', label: 'notice and worse' },
        { value: '0..6', label: 'info and worse' },
        { value: '0..7', label: 'Everything, including debug' },
      ], showWhen: { input: 'journald', equals: ['true'] } },
      { id: 'extra_paths', label: 'More files', control: 'textarea', default: '', placeholder: '/var/log/nginx/access.log | nginx:plus:access', hint: 'path | sourcetype, one per line' },
      { id: 'metrics', label: 'Splunk_TA_nix OS metrics', control: 'toggle', default: true },
      { id: 'metrics_index', label: 'Metrics index', control: 'text', default: 'os', showWhen: { input: 'metrics', equals: ['true'] } },
      { id: 'rsyslog', label: 'rsyslog also writes /var/log/messages', control: 'toggle', default: true, hint: 'RHEL, SUSE and Debian do by default' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_linux_inputs'), 'org_linux_inputs');
      const index = splunkName(str(values, 'index', 'os'), 'os');
      const audit = bool(values, 'audit', true);
      const journald = bool(values, 'journald', false);
      const rsyslog = bool(values, 'rsyslog', true);
      const units = listOf(str(values, 'journald_units', ''));
      const metrics = bool(values, 'metrics', true);
      const metricsIndex = splunkName(str(values, 'metrics_index', 'os'), 'os');
      const extra = str(values, 'extra_paths', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [path, st] = l.split('|').map((p) => p.trim());
          return { path: path ?? '', sourcetype: st ?? '' };
        })
        .filter((e) => e.path);
      const findings: Finding[] = [];

      for (const e of extra) {
        if (/^\/var\/log\/?(\.\.\.|\*)?$|^\/var\/log\/\.\.\.|^\/(\*|\.\.\.)?$/.test(e.path)) {
          findings.push(
            error('splunk.linux-var-log-recursive', `"${e.path}" monitors all of /var/log recursively: journal binaries, lastlog and wtmp (binary), package manager logs, rotated and compressed copies — and every file an application drops there later. It is the most common reason a Linux fleet costs twice what it should.`, {
              remediation: 'Name the files. The ones that matter are listed in this app already.',
              source: 'ArchToolKit',
            }),
          );
        }
        if (!e.sourcetype) {
          findings.push(warning('splunk.input-no-sourcetype', `No sourcetype for ${e.path}; Splunk will guess one per file.`, { source: 'ArchToolKit' }));
        }
      }
      if (journald && rsyslog) {
        findings.push(
          warning('splunk.journald-duplicate', 'journald and /var/log/messages both on means every syslog message is indexed twice: once from the journal, once from the file rsyslog writes from it.', {
            remediation: 'Use one. On distributions where rsyslog writes /var/log/messages, the file is simpler; journald is for hosts with no rsyslog.',
            source: 'ArchToolKit',
          }),
        );
      }

      const monitor = (path: string, sourcetype: string, comment: string[]): string[] => [
        ...comment.map((c) => `# ${c}`),
        `[monitor://${path}]`,
        'disabled = 0',
        `index = ${index}`,
        `sourcetype = ${sourcetype}`,
        '# Rotated copies (.1, -20250101, .gz) are the same data again.',
        'blacklist = (\\.\\d+$|-\\d{8}$|\\.gz$|\\.bz2$|\\.xz$)',
        '',
      ];

      return {
        tier: TIER,
        title: `Linux OS logs${journald ? ' and journald' : ''}${metrics ? ' with OS metrics' : ''} into ${index}`,
        app,
        activation: 'restart',
        notes: [
          'The universal forwarder runs as splunkfwd (9.1 and later), and /var/log/secure, /var/log/auth.log and /var/log/audit/audit.log are readable only by root or the adm group. Without a grant the forwarder logs "Insufficient permissions" once and collects nothing. ops/grant-log-access.sh sets the ACLs and makes them survive rotation.',
          'Deploy Splunk_TA_nix (Splunk Add-on for Unix and Linux) to the search heads and indexers for linux_secure, linux_audit and syslog field extraction and CIM mapping.',
          ...(metrics
            ? ['The OS metrics are the add-on\u2019s own scripts, so they are enabled in the add-on, not here: copy ops/Splunk_TA_nix/local/inputs.conf into Splunk_TA_nix/local/ in deployment-apps and map the add-on to the same serverclass. A scripted input in another app cannot reliably point at the add-on\u2019s bin/.']
            : []),
          ...(journald ? ['The journald input needs the forwarder user in the systemd-journal group (usermod -aG systemd-journal splunkfwd), and journalctl 236 or later for the field include/exclude settings.'] : []),
          'Restart the forwarder after deploying. Monitor and journald inputs are not picked up by a reload.',
        ],
        before: [
          'ls -l /var/log/messages /var/log/secure /var/log/auth.log /var/log/audit/audit.log 2>/dev/null',
          'sudo -u splunkfwd head -c1 /var/log/secure /var/log/audit/audit.log   # can the forwarder user read them?',
          `| rest /services/data/indexes | search title IN (${[...new Set([index, metricsIndex])].join(', ')}) | table title, splunk_server`,
          '/opt/splunkforwarder/bin/splunk btool inputs list --debug | grep -E "^\\S+ +\\[(monitor|journald|script)"',
          ...(journald ? ['journalctl --version | head -1'] : []),
        ],
        files: {
          'default/inputs.conf': [
            ...(rsyslog || !journald
              ? [
                  ...monitor('/var/log/messages', 'syslog', ['RHEL and SUSE general syslog.']),
                  ...monitor('/var/log/syslog', 'syslog', ['Debian and Ubuntu general syslog. A monitor on a file that does not exist costs nothing.']),
                ]
              : []),
            ...monitor('/var/log/secure', 'linux_secure', ['RHEL and SUSE authentication: sshd, sudo, su, PAM.', 'Readable only by root — see ops/grant-log-access.sh.']),
            ...monitor('/var/log/auth.log', 'linux_secure', ['Debian and Ubuntu authentication.']),
            ...(audit ? monitor('/var/log/audit/audit.log', 'linux_audit', ['auditd. Mode 0600 root by default; set log_group in auditd.conf, or an ACL.']) : []),
            ...extra.flatMap((e) => monitor(e.path, e.sourcetype || 'syslog', ['Added by hand.'])),
            ...(journald
              ? [
                  '# journald, read through journalctl. Keep the field list short: every',
                  '# journal field becomes an indexed field otherwise.',
                  '[journald://system]',
                  'disabled = 0',
                  `index = ${index}`,
                  'sourcetype = journald',
                  'journalctl-include-fields = PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_COMM,_PID,_UID,_HOSTNAME',
                  `journalctl-priority = ${str(values, 'journald_priority', '0..5')}`,
                  ...(units.length > 0 ? [`journalctl-unit = ${units.join(',')}`, '# VERIFY: whether a comma list or one unit per stanza on your version.'] : []),
                  'journalctl-quiet = true',
                  '',
                ]
              : []),
          ],
          ...(metrics
            ? {
                'ops/Splunk_TA_nix/local/inputs.conf': [
                  '# Copy into $SPLUNK_HOME/etc/deployment-apps/Splunk_TA_nix/local/inputs.conf',
                  '# on the deployment server. These enable the add-on\u2019s own scripts;',
                  '# intervals are the add-on\u2019s shipped defaults. VERIFY the stanza names',
                  '# against the default/inputs.conf of the add-on version you deploy.',
                  '',
                  ...NIX_SCRIPTS.flatMap((s) => [
                    `# ${s.why}`,
                    `[script://./bin/${s.script}.sh]`,
                    'disabled = 0',
                    `interval = ${s.interval}`,
                    `sourcetype = ${s.script}`,
                    `source = ${s.script}`,
                    `index = ${metricsIndex}`,
                    '',
                  ]),
                ],
              }
            : {}),
          'ops/grant-log-access.sh': [
            '#!/usr/bin/env bash',
            '# Give the forwarder user read access to the root-only logs, and keep it',
            '# across log rotation. Run as root on each host, or from config management.',
            '# Usage: bash grant-log-access.sh',
            '#        bash grant-log-access.sh --dry-run  (prints what it would do)',
            'set -euo pipefail',
            'EXECUTE=1; [[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
            'FWD_USER="${FWD_USER:-splunkfwd}"',
            'run() { if (( EXECUTE )); then "$@"; else printf "DRY RUN:"; printf " %q" "$@"; printf "\\n"; fi; }',
            'id "$FWD_USER" >/dev/null',
            'for f in /var/log/secure /var/log/auth.log /var/log/messages /var/log/syslog; do',
            '  [[ -e "$f" ]] || continue',
            '  run setfacl -m "u:${FWD_USER}:r" "$f"',
            'done',
            '# Default ACL on the directory so files created at rotation inherit it.',
            'run setfacl -m "d:u:${FWD_USER}:r" /var/log',
            ...(audit
              ? [
                  '# auditd: the supported way is log_group in auditd.conf rather than an ACL,',
                  '# because auditd resets permissions when it rotates.',
                  'if [[ -f /etc/audit/auditd.conf ]]; then',
                  '  grp="$(id -gn "$FWD_USER")"',
                  '  if (( EXECUTE )); then',
                  '    sed -i.bak -E "s/^log_group *=.*/log_group = ${grp}/" /etc/audit/auditd.conf',
                  '    grep -q "^log_group" /etc/audit/auditd.conf || echo "log_group = ${grp}" >> /etc/audit/auditd.conf',
                  '    chgrp "$grp" /var/log/audit /var/log/audit/audit.log; chmod g+rx /var/log/audit; chmod g+r /var/log/audit/audit.log',
                  '    # auditd refuses systemctl restart; "service auditd reload" is the supported way.',
                  '    # If it fails the new log_group is not in effect, so that is a failure.',
                  '    if ! service auditd reload; then',
                  '      echo "auditd reload failed: log_group is not in effect until auditd reloads (service auditd reload)" >&2',
                  '      FAILED=1',
                  '    fi',
                  '  else',
                  '    echo "DRY RUN: set log_group = ${grp} in /etc/audit/auditd.conf, chgrp /var/log/audit, service auditd reload"',
                  '  fi',
                  'fi',
                ]
              : []),
            ...(journald ? ['run usermod -aG systemd-journal "$FWD_USER"'] : []),
            'if (( ${FAILED:-0} )); then echo "Finished with errors (above)." >&2; exit 1; fi',
            'echo "Done. Restart the forwarder so it retries the files: systemctl restart SplunkForwarder"',
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          '/opt/splunkforwarder/bin/splunk list inputstatus | grep -A3 -E "secure|auth.log|audit.log"',
          `index=${index} host=<a forwarder> earliest=-15m | stats count by sourcetype, source`,
          `index=${index} sourcetype=linux_secure earliest=-1h | stats count by host | sort count   # hosts with zero are the permission problem`,
          ...(metrics ? [`index=${metricsIndex} sourcetype IN (cpu, vmstat, df) earliest=-15m | stats count by host, sourcetype`] : []),
          'index=_internal host=<a forwarder> sourcetype=splunkd (component=TailReader OR component=WatchedFile OR component=JournaldInput) log_level IN (WARN, ERROR) | tail 20',
        ],
        backout: [
          `Remove ${app}${metrics ? ' (and the Splunk_TA_nix local/inputs.conf)' : ''} from the serverclass, then: splunk reload deploy-server`,
          'setfacl -x u:splunkfwd /var/log/secure /var/log/auth.log; setfacl -d -x u:splunkfwd /var/log   # remove the grants',
          '# Data already indexed stays.',
        ],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_uf_install',
    tier: TIER,
    label: 'Universal forwarder install and deployment client',
    group: 'Install',
    description: 'Install scripts for the universal forwarder on the imported estate\u2019s Linux and Windows machines — non-root, started by systemd, pointed at the deployment server — with the admin password hashed from stdin on Linux and randomly generated on Windows.',
    inputs: [
      { id: 'app_name', label: 'Deployment client app', control: 'text', default: 'org_all_deploymentclient' },
      { id: 'deployment_server', label: 'Deployment server', control: 'text', default: 'ds01.example.com:8089', hint: 'host:port or [IPv6]:port — leave empty only if something else will manage these forwarders' },
      { id: 'phone_home', label: 'Phone home every (seconds)', control: 'number', default: 60, min: 30, max: 3600 },
      { id: 'use_estate', label: 'Hosts from the imported estate', control: 'toggle', default: true, hint: 'Powered-on Windows and Linux VMs; falls back to the lists below when no estate is loaded' },
      { id: 'linux_hosts', label: 'Linux hosts', control: 'textarea', default: 'app01.example.com\napp02.example.com' },
      { id: 'windows_hosts', label: 'Windows hosts', control: 'textarea', default: 'win01.example.com\nwin02.example.com' },
      { id: 'linux_package', label: 'Linux package file', control: 'text', default: 'splunkforwarder-10.4.3-linux-amd64.rpm', hint: '.rpm, .deb or .tgz, as downloaded from splunk.com' },
      { id: 'windows_msi', label: 'Windows MSI file', control: 'text', default: 'splunkforwarder-10.4.3-windows-x64.msi' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_all_deploymentclient'), 'org_all_deploymentclient');
      const ds = str(values, 'deployment_server', '');
      const phoneHome = Math.max(30, num(values, 'phone_home', 60));
      const linuxPkg = str(values, 'linux_package', 'splunkforwarder-linux-amd64.rpm').replace(/[^A-Za-z0-9._-]/g, '');
      const msi = str(values, 'windows_msi', 'splunkforwarder-windows-x64.msi').replace(/[^A-Za-z0-9._-]/g, '');
      const findings: Finding[] = [];

      const estate = bool(values, 'use_estate', true) ? estateHosts() : null;
      const typed = (id: string) => listOf(str(values, id, '')).map(hostAddress).filter(Boolean);
      const linuxHosts = estate ? estate.linux : typed('linux_hosts');
      const windowsHosts = estate ? estate.windows : typed('windows_hosts');

      if (bool(values, 'use_estate', true) && !estate) {
        findings.push(info('splunk.uf-no-estate', 'No estate is loaded, so the host lists below were used. Import an RVTools export and the powered-on Windows and Linux VMs are listed for you.', { source: 'ArchToolKit' }));
      }
      if (estate && estate.skipped > 0) {
        findings.push(info('splunk.uf-estate-skipped', `${estate.skipped} powered-on VMs were left out: their guest OS is neither Windows nor Linux as VMware Tools reports it, or they have no usable host name or address.`, { source: 'ArchToolKit' }));
      }
      if (!ds) {
        findings.push(
          warning('splunk.uf-no-deployment-server', 'With no deployment server, every input, output and add-on on these forwarders has to be put there and kept current by something else — and a forwarder nobody manages is still running the inputs it was installed with years later.', {
            remediation: 'Name a deployment server (or the agent management server in 10.x) and let serverclasses carry the apps.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (linuxHosts.length === 0 && windowsHosts.length === 0) {
        findings.push(warning('splunk.uf-no-hosts', 'No hosts to install on.', { source: 'ArchToolKit' }));
      }

      // host:port, [IPv6]:port or a bare host; an IPv6 address is bracketed
      // wherever it sits next to a port (targetUri, URLs, the MSI property).
      const dsSplit = splitHostPort(ds);
      const dsPort = String(dsSplit.port ?? 8089);
      const dsHost = dsSplit.host;
      const dsHostPort = formatHostPort(dsHost, dsPort);
      if (ds && isIpv6(dsHost) && !ds.startsWith('[') && dsSplit.port === null && /:\d{2,5}$/.test(ds)) {
        findings.push(warning('splunk.uf-ds-ipv6-port', `"${ds}" is read as an IPv6 address with no port, so 8089 is used. Write [address]:port to give one.`, { source: 'ArchToolKit' }));
      }
      const deploymentClient = [
        '[deployment-client]',
        '# How often the forwarder asks for changes. 60s is fine to a few',
        '# thousand clients; raise it beyond that or the DS spends its day',
        '# answering "nothing new".',
        `phoneHomeIntervalInSecs = ${phoneHome}`,
        '',
        '[target-broker:deploymentServer]',
        `targetUri = ${dsHostPort}`,
      ];
      const fwdUser = 'splunkfwd';

      return {
        tier: TIER,
        title: `Install the universal forwarder on ${linuxHosts.length} Linux and ${windowsHosts.length} Windows host${linuxHosts.length + windowsHosts.length === 1 ? '' : 's'}${ds ? `, managed by ${dsHost}` : ''}`,
        app,
        activation: 'restart',
        notes: [
          estate ? `Hosts come from the imported estate (${currentEstate()?.origin ?? 'current estate'}): powered-on VMs by guest OS, addressed by DNS name, then IP.` : 'Hosts come from the lists entered on the form.',
          'The scripts apply when run. Add --dry-run (Linux) or -DryRun (Windows) first to preview: they then print every command they would run.',
          'Linux: ops/make-admin-hash.sh reads the admin password from the terminal with echo off and writes only its SHA-512 crypt hash, mode 600. The install writes that hash into user-seed.conf, which Splunk consumes and deletes on first start. The plain text never touches a file or a command line.',
          'Windows: GENRANDOMPASSWORD=1 gives each forwarder a random admin password nobody knows. That is deliberate — a managed forwarder needs no local login, and a shared admin password across a thousand hosts is one leak from all of them.',
          ds ? `The deployment client app is installed on each host by the script. Once a forwarder phones home, everything else — outputs, inputs, add-ons — comes from serverclasses on ${dsHost}.` : 'No deployment client app is written, because no deployment server was given.',
          'The forwarder never runs as root: splunkfwd on Linux (the rpm and deb create it; the script creates it for a .tgz), started by systemd, and the virtual account on Windows. Splunk 10 does not start as root without --run-as-root, which is not used. Upgrade to 10.4 directly from a 10.0.x or later forwarder.',
          'Outputs are deliberately not set here. Map an outputs app (splunk_outputs) to every forwarder in a serverclass so the indexer list is in one place.',
        ],
        before: [
          ...(ds ? [`curl -sk https://${dsHostPort}/services/server/info -o /dev/null -w "%{http_code}\\n"   # reachable from the hosts? 401 is fine`] : []),
          'ssh <a linux host> "sudo -n true && df -h /opt"   # passwordless sudo and space for /opt/splunkforwarder',
          'Test-WSMan <a windows host>   # WinRM reachable for Invoke-Command',
          `ls -l ${linuxPkg} ${msi}   # both packages downloaded and checksums compared with splunk.com`,
        ],
        files: {
          ...(ds ? { 'default/deploymentclient.conf': deploymentClient } : {}),
          'metadata/default.meta': defaultMeta(),
          'ops/linux-hosts.txt': linuxHosts.length > 0 ? linuxHosts : ['# no Linux hosts'],
          'ops/windows-hosts.txt': windowsHosts.length > 0 ? windowsHosts : ['# no Windows hosts'],
          'ops/make-admin-hash.sh': [
            '# Make the forwarder admin password hash, once, on your workstation.',
            '# The password is read with echo off and piped to openssl on stdin; only',
            '# the SHA-512 crypt hash is written, mode 600. Splunk accepts that hash',
            '# as HASHED_PASSWORD in user-seed.conf. ($SPLUNK_HOME/bin/splunk',
            '# hash-passwd produces the same kind of hash but takes the password as an',
            '# argument — VERIFY whether your version reads it from stdin before using it.)',
            '# Usage: bash make-admin-hash.sh [output file]',
            'set -euo pipefail',
            'OUT="${1:-$HOME/.splunk/uf-admin.hash}"',
            'umask 077',
            'mkdir -p "$(dirname "$OUT")"',
            'IFS= read -rsp "Forwarder admin password: " pw1; echo',
            'IFS= read -rsp "Again: " pw2; echo',
            '[[ "$pw1" == "$pw2" ]] || { echo "Passwords differ." >&2; exit 1; }',
            '(( ${#pw1} >= 12 )) || { echo "Use at least 12 characters." >&2; exit 1; }',
            'printf "%s" "$pw1" | openssl passwd -6 -stdin > "$OUT"',
            'unset pw1 pw2',
            'chmod 600 "$OUT"',
            'echo "Hash written to $OUT"',
          ],
          'ops/install-uf-linux.sh': [
            '# Install the universal forwarder on every host in linux-hosts.txt.',
            '# Runs from an admin workstation with ssh keys and passwordless sudo.',
            '# Usage: bash install-uf-linux.sh',
            '#        bash install-uf-linux.sh --dry-run   (prints what it would do)',
            '# Env:   PKG=<path to package>  HASH_FILE=<made by make-admin-hash.sh>',
            'set -euo pipefail',
            'EXECUTE=1; [[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
            'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
            `PKG="\${PKG:-$HERE/${linuxPkg}}"`,
            'HASH_FILE="${HASH_FILE:-$HOME/.splunk/uf-admin.hash}"',
            `FWD_USER="${fwdUser}"`,
            `DC_APP="${app}"`,
            `DS_URI="${ds ? dsHostPort : ''}"`,
            '',
            '[[ -f "$PKG" ]] || { echo "Package not found: $PKG" >&2; exit 1; }',
            '[[ -f "$HASH_FILE" ]] || { echo "No admin hash; run make-admin-hash.sh first." >&2; exit 1; }',
            '[[ "$(stat -c %a "$HASH_FILE")" == "600" ]] || { echo "$HASH_FILE must be mode 600." >&2; exit 1; }',
            'PKG_NAME="$(basename "$PKG")"',
            '',
            '# The script each host runs, sent on stdin so nothing sensitive is in',
            '# the remote command line. The hash is inside a quoted heredoc, so the',
            '# $ signs in it are not expanded.',
            'remote_script() {',
            '  cat <<EOF',
            'set -euo pipefail',
            'PKG=/tmp/${PKG_NAME}',
            'SH=/opt/splunkforwarder',
            'case "\\$PKG" in',
            '  *.rpm) rpm -Uvh --replacepkgs "\\$PKG" ;;',
            '  *.deb) dpkg -i "\\$PKG" ;;',
            '  *.tgz) id ${FWD_USER} >/dev/null 2>&1 || useradd -r -m -d /opt/splunkforwarder -s /sbin/nologin ${FWD_USER}',
            '         tar -xzf "\\$PKG" -C /opt ;;',
            'esac',
            'id ${FWD_USER} >/dev/null   # the rpm and deb create splunkfwd from 9.1',
            'umask 077',
            'install -d -m 700 "\\$SH/etc/system/local"',
            "cat > \"\\$SH/etc/system/local/user-seed.conf\" <<'SEED'",
            '[user_info]',
            'USERNAME = admin',
            'HASHED_PASSWORD = $(cat "$HASH_FILE")',
            'SEED',
            'if [[ -n "${DS_URI}" ]]; then',
            '  install -d -m 755 "\\$SH/etc/apps/${DC_APP}/default"',
            "  cat > \"\\$SH/etc/apps/${DC_APP}/default/deploymentclient.conf\" <<'DC'",
            ...deploymentClient,
            'DC',
            'fi',
            'chown -R ${FWD_USER}: "\\$SH"',
            '# First start as the forwarder user to accept the licence and consume',
            '# user-seed.conf, then hand it to systemd.',
            'sudo -u ${FWD_USER} "\\$SH/bin/splunk" start --accept-license --answer-yes --no-prompt',
            'sudo -u ${FWD_USER} "\\$SH/bin/splunk" stop',
            '"\\$SH/bin/splunk" enable boot-start -systemd-managed 1 -user ${FWD_USER} -group \\$(id -gn ${FWD_USER})',
            'systemctl start SplunkForwarder',
            'systemctl is-active SplunkForwarder',
            'rm -f "\\$PKG"',
            'EOF',
            '}',
            '',
            '# One host failing does not stop the rest: each failure is recorded, the',
            '# loop carries on, and the script exits 1 with the list at the end.',
            '# scp and ssh read from /dev/null or the pipe, never from the host list.',
            'FAILED=()',
            'while IFS= read -r host; do',
            '  host="${host%%$\'\\r\'}"',
            '  [[ -z "$host" || "$host" == \\#* ]] && continue',
            '  echo "== $host"',
            '  if (( EXECUTE )); then',
            '    if ! scp -q "$PKG" "$host:/tmp/$PKG_NAME" </dev/null; then',
            '      echo "FAILED: $host: copying the package" >&2; FAILED+=("$host"); continue',
            '    fi',
            '    if ! remote_script | ssh "$host" "sudo bash -s"; then',
            '      echo "FAILED: $host: install or first start (output above)" >&2; FAILED+=("$host"); continue',
            '    fi',
            '  else',
            '    echo "DRY RUN: scp $PKG $host:/tmp/$PKG_NAME"',
            '    echo "DRY RUN: ssh $host sudo bash -s  <<  (install, user-seed.conf with the hash, deployment client, boot-start as $FWD_USER)"',
            '  fi',
            'done < "$HERE/linux-hosts.txt"',
            'if (( ${#FAILED[@]} > 0 )); then',
            '  printf "%d host(s) failed: %s\\n" "${#FAILED[@]}" "${FAILED[*]}" >&2',
            '  exit 1',
            'fi',
          ],
          'ops/install-uf-windows.ps1': [
            '# Install the universal forwarder on every host in windows-hosts.txt over',
            '# WinRM. Applies when run; -DryRun previews.',
            '# Usage: .\\install-uf-windows.ps1 [-DryRun] [-Msi <path>]',
            'param(',
            '  [switch]$DryRun,',
            `  [string]$Msi = (Join-Path $PSScriptRoot '${msi}'),`,
            "  [string]$HostsFile = (Join-Path $PSScriptRoot 'windows-hosts.txt')",
            ')',
            "$ErrorActionPreference = 'Stop'",
            '$Execute = -not $DryRun',
            "if (-not (Test-Path $Msi)) { throw \"MSI not found: $Msi\" }",
            '$msiName = Split-Path $Msi -Leaf',
            '# No password anywhere: GENRANDOMPASSWORD=1 generates a random admin',
            '# password per host. AGREETOLICENSE is required for a silent install.',
            '$msiArgs = @(',
            "  '/i', \"C:\\Windows\\Temp\\$msiName\",",
            "  'AGREETOLICENSE=Yes',",
            "  'SPLUNKUSERNAME=admin',",
            "  'GENRANDOMPASSWORD=1',",
            ...(ds ? [`  'DEPLOYMENT_SERVER=${dsHostPort}',`] : []),
            "  # Runs as the least-privileged virtual account, with the rights to read",
            "  # the event logs granted by the installer. 10.2 and later no longer run",
            "  # as Local System or Administrator.",
            "  'USE_LOCAL_SYSTEM=0',",
            "  'LAUNCHSPLUNK=1',",
            "  'SERVICESTARTTYPE=auto',",
            "  '/quiet', '/norestart',",
            "  '/L*v', 'C:\\Windows\\Temp\\splunkforwarder-install.log'",
            ')',
            '# One host failing does not stop the rest: every failure is collected and',
            '# the script ends with the list and exit 1, so a caller or a pipeline sees it.',
            '$failed = [System.Collections.Generic.List[string]]::new()',
            '$hosts = Get-Content $HostsFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith(\'#\') }',
            'foreach ($computer in $hosts) {',
            '  Write-Host "== $computer"',
            '  if (-not $Execute) {',
            '    Write-Host "DRY RUN: copy $msiName to \\\\$computer\\C$\\Windows\\Temp; msiexec $($msiArgs -join \' \')"',
            '    continue',
            '  }',
            '  $session = $null',
            '  try {',
            '    $session = New-PSSession -ComputerName $computer',
            '    Copy-Item -Path $Msi -Destination "C:\\Windows\\Temp\\$msiName" -ToSession $session',
            '    $code = Invoke-Command -Session $session -ScriptBlock {',
            '      $p = Start-Process msiexec.exe -ArgumentList $using:msiArgs -Wait -PassThru',
            '      Remove-Item "C:\\Windows\\Temp\\$using:msiName" -ErrorAction SilentlyContinue',
            '      $p.ExitCode',
            '    }',
            '    # 0 = installed; 3010 = installed, a reboot is pending. Anything else failed.',
            "    if ($code -notin 0, 3010) { throw \"msiexec exit $code — see C:\\Windows\\Temp\\splunkforwarder-install.log on $computer\" }",
            "    $svc = Invoke-Command -Session $session -ScriptBlock { Get-Service SplunkForwarder -ErrorAction SilentlyContinue | Select-Object Status, StartType }",
            "    if (-not $svc -or \"$($svc.Status)\" -ne 'Running') { throw \"SplunkForwarder service is $(if ($svc) { $svc.Status } else { 'missing' }) after install\" }",
            "    Write-Host \"$computer OK ($code): SplunkForwarder $($svc.Status), $($svc.StartType)\"",
            '  } catch {',
            '    Write-Warning "$computer FAILED: $($_.Exception.Message)"',
            '    $failed.Add($computer)',
            '  } finally {',
            '    if ($session) { Remove-PSSession $session }',
            '  }',
            '}',
            'if ($failed.Count -gt 0) {',
            '  Write-Error "$($failed.Count) host(s) failed: $($failed -join \', \')" -ErrorAction Continue',
            '  exit 1',
            '}',
          ],
        },
        verify: [
          '/opt/splunkforwarder/bin/splunk list forward-server   # after the outputs app arrives from the DS',
          '/opt/splunkforwarder/bin/splunk btool deploymentclient list --debug',
          'ps -o user= -C splunkd   # splunkfwd, not root',
          '& "C:\\Program Files\\SplunkUniversalForwarder\\bin\\splunk.exe" btool deploymentclient list --debug',
          ...(ds ? ['| rest /services/deployment/server/clients splunk_server=local | table hostname, ip, utsname, lastPhoneHomeTime   # on the deployment server'] : []),
          'index=_internal source=*metrics.log group=tcpin_connections fwdType=uf earliest=-15m | stats latest(version) as version by hostname',
        ],
        backout: [
          'Linux: systemctl stop SplunkForwarder; /opt/splunkforwarder/bin/splunk disable boot-start; rpm -e splunkforwarder (or dpkg -r splunkforwarder; or rm -rf /opt/splunkforwarder for the tgz)',
          'Windows: msiexec /x <the same MSI> /quiet   # or Get-Package *UniversalForwarder* | Uninstall-Package',
          ...(ds ? ['On the deployment server: splunk remove deployment-client ... is not needed; stale clients age out of the list.'] : []),
        ],
        findings,
      };
    },
  }),
];
