/**
 * Splunk forwarder, 10.x: the inputs that need more than a stanza.
 *
 * Three kinds of collection that go wrong in ways a monitor stanza does not.
 * A Windows Event Collector gathers thousands of machines' logs into one
 * channel, ForwardedEvents, so one forwarder reads for all of them — and a
 * subscription nobody sized fills a 20 MB channel in minutes and overwrites
 * what the forwarder has not read yet. A scripted input runs whatever is in
 * bin/ as the forwarder's account on every host it is mapped to, on a timer,
 * and a script that asks for sudo or waits on a prompt simply never returns.
 * A modular input is a small program with a contract — a scheme, a
 * validation step, a stream of events — and one that skips validation starts
 * with bad settings and fails in splunkd.log where nobody looks.
 *
 * Python is the thread through the last two. Splunk 10 runs Python 3.9 or
 * 3.13 and nothing else, the universal forwarder ships no Python at all, and
 * an app must not carry compiled modules. So a Python input goes to a heavy
 * forwarder, says python.required, and brings only pure-Python libraries.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { splunkBlueprint,                      } from '../from-app.js';
import { defaultMeta, listOf, splunkName,                                 } from '../splunk.js';

const TIER = 'forwarder'         ;

/** What Splunk 10.x runs: 3.9 on 10.0 and later, 3.13 added in 10.4. */
const PYTHON_REQUIRED = 'python.required = 3.9, 3.13';

// --- helpers ---------------------------------------------------------------

/**
 * A script as a template, with the script's own `${...}` written `\${...}`.
 *
 * String.raw keeps backslashes as they are, so `\n` in a printf stays `\n`
 * and a Windows path keeps its separators; the one thing it cannot leave
 * alone is `${`, which is interpolation.
 */
function script(strings                      , ...values           )           {
  return String.raw(strings, ...values)
    .replace(/\\\$\{/g, '${')
    .replace(/^\n/, '')
    .replace(/\n$/, '')
    .split('\n');
}

/** Lines of a textarea split into columns on `|`, with comments and blanks dropped. */
function rows(value        , columns        )             {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split('|');
      // The last column keeps any further pipes: a regex or an XPath may have them.
      const head = parts.slice(0, columns - 1).map((p) => p.trim());
      const tail = parts.slice(columns - 1).join('|').trim();
      return [...head, tail];
    });
}

/** Characters that end an XML text node or attribute early. */
function xmlText(value        )         {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A seconds count or a five-field cron expression, which is what `interval` takes. */
function scheduleKind(value        )                            {
  const v = value.trim();
  if (/^\d+$/.test(v) && Number(v) > 0) return 'seconds';
  const fields = v.split(/\s+/);
  if (fields.length === 5 && fields.every((f) => /^[\d*/,\-]+$/.test(f))) return 'cron';
  return null;
}

/** Packages with compiled parts: a copy in an app is a binary module. */
const BINARY_MODULES = ['numpy', 'pandas', 'scipy', 'orjson', 'ujson', 'pydantic_core', 'psycopg2', 'grpc', 'lxml', 'cryptography', 'bcrypt'];

// --- Windows Event Forwarding ------------------------------------------------

/** The keys a WinEventLog numbered allow or deny list can match on (inputs.conf.spec). */
const WINEVENTLOG_FILTER_KEYS = [
  'Category', 'CategoryString', 'ComputerName', 'EventCode', 'EventType', 'Keywords', 'LogName', 'Message',
  'OpCode', 'RecordNumber', 'Sid', 'SidType', 'SourceName', 'TaskCategory', 'Type', 'User', '$XmlRegex',
];

/** Well-known SDDL aliases for the groups a subscription usually admits. */
const SOURCE_SDDL                                   = {
  computers: '(A;;GA;;;DC)',
  dcs: '(A;;GA;;;DD)',
  both: '(A;;GA;;;DC)(A;;GA;;;DD)',
};

// --- modular input -------------------------------------------------------------

/** Keys Splunk itself reads from an input stanza; a parameter cannot reuse them. */
const RESERVED_PARAMS = ['name', 'index', 'sourcetype', 'source', 'host', 'interval', 'disabled', 'start_by_shell', 'passauth'];

                    
                        
                        
                             
                         
                               
 

export const FORWARDER_10X_BLUEPRINTS                             = [
  splunkBlueprint({
    id: 'splunk_wef_collector',
    tier: TIER,
    label: 'Windows Event Forwarding collector',
    group: 'Operating systems',
    description:
      'A source-initiated Windows Event Forwarding subscription and the script that sets up the collector, the Group Policy settings that point the sources at it, and a universal forwarder app that reads ForwardedEvents as XML with allow and deny lists, for the Splunk Add-on for Microsoft Windows 11.0.2.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_wef_collector' },
      { id: 'collector', label: 'Collector', control: 'text', default: 'wec01.example.com', hint: 'The FQDN the sources reach over WinRM (5985)' },
      { id: 'subscription', label: 'Subscription name', control: 'text', default: 'splunk-wef' },
      { id: 'sources', label: 'Machines that may forward', control: 'select', default: 'computers', options: [
        { value: 'computers', label: 'Domain Computers' },
        { value: 'dcs', label: 'Domain Controllers' },
        { value: 'both', label: 'Domain Computers and Domain Controllers' },
        { value: 'sid', label: 'A group, by its SID' },
      ] },
      { id: 'source_sid', label: 'Group SID', control: 'text', default: '', placeholder: 'S-1-5-21-1004336348-1177238915-682003330-1105', hint: 'Get-ADGroup <name> | Select-Object SID', showWhen: { input: 'sources', equals: ['sid'] } },
      {
        id: 'queries',
        label: 'Channels to collect',
        control: 'textarea',
        default: 'Security | *\nSystem | *[System[(Level=1 or Level=2 or Level=3)]]\nMicrosoft-Windows-Sysmon/Operational | *\nMicrosoft-Windows-PowerShell/Operational | *[System[(EventID=4103 or EventID=4104)]]',
        hint: 'channel | XPath filter (* for everything)',
      },
      { id: 'delivery', label: 'Delivery', control: 'select', default: 'MinLatency', options: [
        { value: 'MinLatency', label: 'Minimise latency — events within about 30 seconds' },
        { value: 'Normal', label: 'Normal — batched, up to about 15 minutes' },
        { value: 'MinBandwidth', label: 'Minimise bandwidth — batched, up to about 6 hours' },
      ] },
      { id: 'content_format', label: 'Content format', control: 'select', default: 'RenderedText', options: [
        { value: 'RenderedText', label: 'Rendered text — the message travels with the event' },
        { value: 'Events', label: 'Events — the XML only, smaller' },
      ] },
      { id: 'refresh', label: 'Sources re-check the subscription every (seconds)', control: 'number', default: 60, min: 30, max: 86400 },
      { id: 'log_mb', label: 'ForwardedEvents maximum size (MB)', control: 'number', default: 4096, min: 64, max: 65536 },
      { id: 'read_existing', label: 'Send the events already on the sources', control: 'toggle', default: false, hint: 'Off: only events written after a source subscribes' },
      { id: 'index', label: 'Index', control: 'text', default: 'wineventlog' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'XmlWinEventLog', hint: 'XmlWinEventLog with Render as XML; WinEventLog without' },
      { id: 'render_xml', label: 'Render as XML', control: 'toggle', default: true },
      { id: 'suppress_text', label: 'Drop the message text', control: 'toggle', default: true, showWhen: { input: 'render_xml', equals: ['true'] } },
      { id: 'allow_codes', label: 'Allow list (event codes)', control: 'text', default: '', placeholder: '4624, 4625, 4688, 4720-4767', hint: 'Codes and ranges, comma separated; empty sends every code' },
      { id: 'deny_codes', label: 'Deny list (event codes)', control: 'text', default: '5156, 5158', hint: 'Codes and ranges, comma separated' },
      { id: 'deny_rows', label: 'Deny rules', control: 'textarea', default: 'EventCode | ^4658$', hint: 'field | regex — at most 9' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_wef_collector'), 'org_wef_collector');
      const collector = str(values, 'collector', '');
      const subscription = str(values, 'subscription', 'splunk-wef').replace(/[^A-Za-z0-9._-]/g, '-');
      const sources = str(values, 'sources', 'computers');
      const sid = str(values, 'source_sid', '');
      const queries = rows(str(values, 'queries', ''), 2).map(([channel, xpath]) => ({ channel: channel ?? '', xpath: xpath || '*' })).filter((q) => q.channel);
      const delivery = str(values, 'delivery', 'MinLatency');
      const contentFormat = str(values, 'content_format', 'RenderedText');
      const refresh = Math.max(30, num(values, 'refresh', 60));
      const logBytes = Math.max(64, num(values, 'log_mb', 4096)) * 1024 * 1024;
      const readExisting = bool(values, 'read_existing', false);
      const index = splunkName(str(values, 'index', ''), '');
      const xml = bool(values, 'render_xml', true);
      const suppress = xml && bool(values, 'suppress_text', true);
      const automatic = xml ? 'XmlWinEventLog' : 'WinEventLog';
      const sourcetype = str(values, 'sourcetype', automatic);
      const allow = listOf(str(values, 'allow_codes', ''));
      const deny = listOf(str(values, 'deny_codes', ''));
      const denyRows = rows(str(values, 'deny_rows', ''), 2).map(([field, regex]) => ({ field: field ?? '', regex: regex ?? '' }));
      const findings            = [];

      if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(collector)) {
        findings.push(error('splunk.wef-collector', `"${collector}" is not a host name. The sources connect to the collector by name over WinRM, and Kerberos needs the FQDN its SPN is registered under.`, { source: 'Windows Event Forwarding: Configure target Subscription Manager' }));
      }
      if (sources === 'sid' && !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(sid)) {
        findings.push(error('splunk.wef-source-sid', `"${sid}" is not a domain group SID (S-1-5-21-…). The subscription admits sources by SID in its SDDL, and a malformed one makes wecutil reject the file.`, { source: 'wecutil cs — AllowedSourceDomainComputers' }));
      }
      if (queries.length === 0) {
        findings.push(error('splunk.wef-no-query', 'No channels to collect: a subscription without a query is rejected by wecutil.', { source: 'wecutil cs — Query' }));
      }
      for (const q of queries) {
        if (q.xpath.includes(']]>')) {
          findings.push(error('splunk.wef-query-cdata', `The filter for ${q.channel} contains "]]>", which ends the query's CDATA section in the subscription file.`, { source: 'wecutil cs — Query' }));
        }
      }
      if (!index) {
        findings.push(error('splunk.input-no-index', 'No index: ForwardedEvents from every source would land in main.', { source: 'inputs.conf.spec — index' }));
      }
      for (const [list, codes] of [['allow', allow], ['deny', deny]]         ) {
        for (const code of codes) {
          if (!/^\d+(-\d+)?$/.test(code)) {
            findings.push(error('splunk.wef-bad-code', `"${code}" in the ${list} list is not an event code or a range (4720-4767). The forwarder rejects the whole list.`, { source: 'inputs.conf.spec — whitelist / blacklist' }));
          }
        }
      }
      const both = allow.filter((c) => deny.includes(c));
      if (both.length > 0) {
        findings.push(warning('splunk.wef-allow-and-deny', `${both.join(', ')} ${both.length === 1 ? 'is' : 'are'} in both the allow and the deny list, so ${both.length === 1 ? 'it is' : 'they are'} dropped: the allow list only admits what the deny list then removes.`, { source: 'inputs.conf.spec — whitelist / blacklist' }));
      }
      if (denyRows.length > 9) {
        findings.push(error('splunk.wef-too-many-rules', `${denyRows.length} deny rules; WinEventLog numbers them blacklist1 to blacklist9 and ignores anything beyond.`, { source: 'inputs.conf.spec — blacklist1..9' }));
      }
      for (const r of denyRows) {
        if (!WINEVENTLOG_FILTER_KEYS.includes(r.field)) {
          findings.push(error('splunk.wef-bad-field', `"${r.field}" is not a field a WinEventLog deny rule can match. It takes ${WINEVENTLOG_FILTER_KEYS.join(', ')}.`, { source: 'inputs.conf.spec — blacklist1..9' }));
        }
        if (!r.regex) {
          findings.push(error('splunk.wef-empty-rule', `The deny rule on ${r.field} has no regex.`, { source: 'inputs.conf.spec — blacklist1..9' }));
        }
        if (r.regex.includes('"')) {
          findings.push(error('splunk.wef-rule-quote', `The deny rule on ${r.field} contains a double quote, which ends the regex early in inputs.conf. Match it with \\x22 instead.`, { source: 'inputs.conf.spec — blacklist1..9' }));
        }
        if (xml && r.field === 'Message') {
          findings.push(warning('splunk.wef-message-with-xml', 'A deny rule on Message does nothing with Render as XML on: the XML has no Message key to match.', { remediation: 'Match the XML with $XmlRegex instead.', source: 'inputs.conf.spec — renderXml' }));
        }
      }
      if (xml && sourcetype !== 'XmlWinEventLog') {
        findings.push(warning('splunk.wef-sourcetype', `Render as XML with sourcetype ${sourcetype}: the Splunk Add-on for Microsoft Windows parses XML events only as XmlWinEventLog, so these arrive with no Windows field extractions.`, { remediation: 'Leave the sourcetype as XmlWinEventLog.', source: 'Splunk Add-on for Microsoft Windows — sourcetypes' }));
      }
      if (!xml && sourcetype === 'XmlWinEventLog') {
        findings.push(warning('splunk.wef-sourcetype', 'Classic text rendering labelled XmlWinEventLog: the add-on parses those events as XML and extracts nothing.', { remediation: 'Turn Render as XML on, or use WinEventLog.', source: 'Splunk Add-on for Microsoft Windows — sourcetypes' }));
      }
      if (readExisting) {
        findings.push(warning('splunk.wef-read-existing', 'Sending existing events means every source replays its whole log when it subscribes — every machine at once on the first Group Policy refresh, into one ForwardedEvents channel.', { remediation: 'Leave it off, or admit a small group first and widen the group once the backlog has drained.', source: 'wecutil cs — ReadExistingEvents' }));
      }

      const sddl = sources === 'sid' ? `(A;;GA;;;${sid})` : SOURCE_SDDL[sources] ?? SOURCE_SDDL.computers;
      const subscriptionXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Subscription xmlns="http://schemas.microsoft.com/2006/03/windows/events/subscription">',
        `  <SubscriptionId>${xmlText(subscription)}</SubscriptionId>`,
        '  <SubscriptionType>SourceInitiated</SubscriptionType>',
        `  <Description>Windows events for Splunk, read from ForwardedEvents on ${xmlText(collector)}</Description>`,
        '  <Enabled>true</Enabled>',
        '  <Uri>http://schemas.microsoft.com/wbem/wsman/1/windows/EventLog</Uri>',
        `  <ConfigurationMode>${delivery}</ConfigurationMode>`,
        '  <Query><![CDATA[',
        '<QueryList>',
        ...queries.map((q, i) => `  <Query Id="${i}" Path="${xmlText(q.channel)}"><Select Path="${xmlText(q.channel)}">${q.xpath}</Select></Query>`),
        '</QueryList>]]></Query>',
        `  <ReadExistingEvents>${readExisting ? 'true' : 'false'}</ReadExistingEvents>`,
        '  <TransportName>HTTP</TransportName>',
        `  <ContentFormat>${contentFormat}</ContentFormat>`,
        '  <Locale Language="en-US"/>',
        '  <LogFile>ForwardedEvents</LogFile>',
        '  <PublisherName>Microsoft-Windows-EventCollector</PublisherName>',
        '  <AllowedSourceNonDomainComputers></AllowedSourceNonDomainComputers>',
        `  <AllowedSourceDomainComputers>O:NSG:BAD:P${sddl}S:</AllowedSourceDomainComputers>`,
        '</Subscription>',
      ];

      const managerValue = `Server=http://${collector}:5985/wsman/SubscriptionManager/WEC,Refresh=${refresh}`;

      return {
        tier: TIER,
        title: `Windows Event Forwarding: subscription ${subscription} on ${collector}, ForwardedEvents into ${index || 'main'}`,
        app,
        activation: 'restart',
        notes: [
          `Install the universal forwarder on ${collector} and map this app to it alone. The forwarder reads one channel, ForwardedEvents, for every source; nothing is installed on the sources.`,
          'Deploy the Splunk Add-on for Microsoft Windows 11.0.2 (Splunk_TA_windows) to the search heads and the indexers. This app only collects; the add-on parses the events and maps them to the CIM.',
          `Point the sources at the collector by Group Policy: ops/gpo-settings.txt has the settings, including the Subscription Manager value ${managerValue}. A source picks the subscription up at its next Group Policy refresh and then every ${refresh} seconds.`,
          'Sources read the Security log through the WinRM service, which runs as NETWORK SERVICE. Without NETWORK SERVICE in the Event Log Readers group on each source, the Security query returns nothing and wecutil gr shows the error per source.',
          'ops/wec-setup.ps1 applies when run, elevated, on the collector: WinRM listener, the Windows Event Collector service, the ForwardedEvents size, and the subscription (replaced if it exists). -DryRun previews and shows the current state.',
          'HTTP on 5985 is Kerberos-authenticated and encrypted by WinRM inside the domain. Machines outside the domain need HTTPS on 5986 with certificates, which this subscription does not set up.',
          'The allow and deny lists filter on the collector, after the events have crossed the network. The XPath filters in the subscription drop them on the source; put the bulk of the filtering there.',
          `ForwardedEvents keeps ${Math.round(logBytes / 1024 / 1024)} MB and overwrites the oldest events when full. If the forwarder stops for longer than that takes to fill, the gap is lost.`,
          'VERIFY: the host field. Events in ForwardedEvents are read on the collector, so host is the collector unless the add-on sets it from the event\u2019s Computer field at index time — check a sample on your indexers with the add-on version you run.',
          ...(contentFormat === 'Events' ? ['VERIFY: with the Events content format the rendered message and RenderingInfo are not in the XML; check that the fields your searches use come from EventData, not the message, before switching production to it.'] : []),
          'VERIFY: that the forwarder\u2019s service account (a virtual account on 10.x) can read ForwardedEvents: wevtutil gl ForwardedEvents shows the channel access, and splunk list inputstatus shows the error if it cannot.',
          'Restart the forwarder after deploying. WinEventLog inputs are not picked up by a reload.',
        ],
        before: [
          `Test-NetConnection ${collector} -Port 5985   # from a source`,
          `setspn -L ${collector.split('.')[0] || collector}   # WSMAN/${collector} must be registered for Kerberos`,
          '.\\ops\\wec-setup.ps1 -DryRun   # on the collector: current WinRM, service, channel and subscription',
          'wevtutil gl ForwardedEvents',
          `| rest /services/data/indexes | search title=${index || 'main'} | table title, splunk_server`,
        ],
        files: {
          'default/inputs.conf': [
            '# The Windows Event Collector channel: every source\u2019s subscribed events,',
            '# read once, here. Parsed by Splunk_TA_windows on the indexers and',
            '# search heads.',
            '[WinEventLog://ForwardedEvents]',
            'disabled = 0',
            `index = ${index || 'main'}`,
            `renderXml = ${xml ? 'true' : 'false'}`,
            ...(sourcetype !== automatic ? [`sourcetype = ${sourcetype}`] : []),
            ...(suppress ? ['# Drop the rendered explanatory text; the fields are all in the XML.', 'suppress_text = 1'] : []),
            '# Resume from the saved position after a restart, and save it every 5s.',
            'start_from = oldest',
            'current_only = 0',
            'checkpointInterval = 5',
            '# SID and GUID resolution against a domain controller, per event, for',
            '# thousands of sources: leave it to the add-on\u2019s lookups at search time.',
            'evt_resolve_ad_obj = 0',
            ...(allow.length > 0 ? ['# Only these event codes are indexed.', `whitelist = ${allow.join(',')}`] : []),
            ...(deny.length > 0 ? ['# These event codes are dropped on the collector.', `blacklist = ${deny.join(',')}`] : []),
            ...(denyRows.length > 0
              ? [
                  '# Deny rules: an event matching every key=regex on one line is dropped.',
                  ...denyRows.slice(0, 9).map((r, i) => `blacklist${i + 1} = ${r.field}="${r.regex}"`),
                ]
              : []),
            '',
          ],
          'metadata/default.meta': defaultMeta(),
          'ops/subscription.xml': subscriptionXml,
          'ops/gpo-settings.txt': [
            `Group Policy for the Windows Event Forwarding sources (subscription ${subscription})`,
            '',
            'Link to the OU of the machines that forward. Apply with the next refresh,',
            'or gpupdate /force on a test machine first.',
            '',
            '1. Computer Configuration > Policies > Administrative Templates > Windows Components',
            '   > Event Forwarding > Configure target Subscription Manager: Enabled',
            `   SubscriptionManagers: ${managerValue}`,
            '',
            '2. Computer Configuration > Preferences > Control Panel Settings > Local Users and Groups:',
            '   Update the group "Event Log Readers (built-in)", add member NT AUTHORITY\\NETWORK SERVICE.',
            '   Without it the Security channel cannot be read by WinRM and is not forwarded.',
            '',
            '3. Computer Configuration > Policies > Windows Settings > Security Settings > System Services:',
            '   Windows Remote Management (WS-Management): Automatic.',
            '',
            `Allowed sources in the subscription: ${sources === 'sid' ? `the group ${sid}` : sources === 'dcs' ? 'Domain Controllers' : sources === 'both' ? 'Domain Computers and Domain Controllers' : 'Domain Computers'}.`,
            'A machine outside that group is refused by the collector even with the policy applied.',
          ],
          'ops/wec-setup.ps1': script`
# Make this server a Windows Event Collector and create the source-initiated
# subscription in subscription.xml. Run elevated on the collector.
# Applies when run; -DryRun previews and shows the current state.
# Usage: .\wec-setup.ps1 [-DryRun]
param(
  [switch]$DryRun,
  [string]$SubscriptionFile = (Join-Path $PSScriptRoot 'subscription.xml')
)
$ErrorActionPreference = 'Stop'
$Execute = -not $DryRun
$name = '${subscription}'
$logBytes = ${logBytes}
if (-not (Test-Path $SubscriptionFile)) { throw "Subscription file not found: $SubscriptionFile" }

function Step([string]$what, [scriptblock]$action) {
  if (-not $Execute) { Write-Host "DRY RUN: $what"; return }
  Write-Host "== $what"
  $global:LASTEXITCODE = 0
  & $action
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

# The current state, in a dry run as well.
wevtutil gl ForwardedEvents | Select-String 'maxSize|channelAccess'
cmd /c "wecutil gs $name >nul 2>&1"
$exists = ($LASTEXITCODE -eq 0)
Write-Host ("Subscription {0}: {1}" -f $name, $(if ($exists) { 'exists, will be replaced' } else { 'not present, will be created' }))

Step 'WinRM listener (winrm quickconfig)' { winrm quickconfig -quiet }
Step 'Windows Event Collector service (wecutil qc)' { wecutil qc /q }
Step "ForwardedEvents maximum size $logBytes bytes" { wevtutil sl ForwardedEvents /ms:$logBytes }
if ($exists) { Step "Delete the existing subscription $name" { wecutil ds $name } }
Step "Create subscription $name from $SubscriptionFile" { wecutil cs $SubscriptionFile }
if ($Execute) {
  wecutil gs $name
  Write-Host 'Sources appear in wecutil gr after their next Group Policy refresh.'
}
`,
        },
        verify: [
          `wecutil gr ${subscription}   # on the collector: each source and its state (Active, or the error)`,
          'Get-WinEvent -LogName ForwardedEvents -MaxEvents 5 | Select-Object TimeCreated, MachineName, Id',
          '"C:\\Program Files\\SplunkUniversalForwarder\\bin\\splunk.exe" list inputstatus',
          `index=${index || 'main'} source="${xml ? 'XmlWinEventLog' : 'WinEventLog'}:ForwardedEvents" earliest=-15m | stats count by host, EventCode | sort - count`,
          `index=_internal host=${collector.split('.')[0] || collector}* sourcetype=splunkd component=WinEventLog* log_level IN (WARN, ERROR) | tail 20`,
        ],
        backout: [
          `Remove ${app} from the serverclass on the deployment server, then: splunk reload deploy-server`,
          `wecutil ds ${subscription}   # on the collector; sources stop forwarding at their next refresh`,
          'Unlink the Group Policy object from the sources\u2019 OU.',
          '# Data already indexed stays.',
        ],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_scripted_input',
    tier: TIER,
    label: 'Scripted input (bash, PowerShell or Python)',
    group: 'Inputs',
    description:
      'A script in bin/ run on a schedule, its output indexed: a bash script on Linux forwarders, a PowerShell script through the Windows forwarder\u2019s PowerShell input, or a Python 3 script with python.required on a heavy forwarder — the universal forwarder has no Python.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_scripted_input' },
      { id: 'script_name', label: 'Script name', control: 'text', default: 'disk_free', hint: 'The file in bin/, without the extension' },
      { id: 'language', label: 'Language', control: 'select', default: 'bash', options: [
        { value: 'bash', label: 'bash — Linux universal forwarders' },
        { value: 'powershell', label: 'PowerShell — Windows universal forwarders' },
        { value: 'python', label: 'Python 3 — heavy forwarders (no Python on a universal forwarder)' },
      ] },
      { id: 'interval', label: 'Run every', control: 'combo', default: '300', hint: 'Seconds, or a cron expression', options: [
        { value: '60', label: '60 seconds' },
        { value: '300', label: '5 minutes (300)' },
        { value: '900', label: '15 minutes (900)' },
        { value: '3600', label: 'Hourly (3600)' },
        { value: '86400', label: 'Daily (86400)' },
        { value: '0 * * * *', label: 'On the hour (cron)' },
        { value: '30 2 * * *', label: 'At 02:30 each day (cron)' },
      ] },
      { id: 'index', label: 'Index', control: 'text', default: 'os' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'script:disk_free' },
      { id: 'script_body', label: 'Script', control: 'textarea', default: '', hint: 'Empty for a starter script that reports disk space; paste your own to ship it' },
      { id: 'also_9x', label: 'Also runs on 9.x forwarders', control: 'toggle', default: false, hint: 'Adds python.version = python3', showWhen: { input: 'language', equals: ['python'] } },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_scripted_input'), 'org_scripted_input');
      const name = splunkName(str(values, 'script_name', 'disk_free'), 'disk_free');
      const language = str(values, 'language', 'bash');
      const interval = str(values, 'interval', '300');
      const kind = scheduleKind(interval);
      const index = splunkName(str(values, 'index', ''), '');
      const sourcetype = str(values, 'sourcetype', `script:${name}`);
      const body = String(values.script_body ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
      const also9x = language === 'python' && bool(values, 'also_9x', false);
      const tier             = language === 'python' ? 'heavy_forwarder' : TIER;
      const ext = language === 'python' ? 'py' : language === 'powershell' ? 'ps1' : 'sh';
      const file = `bin/${name}.${ext}`;
      const findings            = [];

      if (!kind) {
        findings.push(error('splunk.script-interval', `"${interval}" is neither a number of seconds nor a five-field cron expression; the input never runs.`, { source: 'inputs.conf.spec — interval' }));
      } else if (kind === 'seconds' && Number(interval) < 10) {
        findings.push(warning('splunk.script-interval-short', `Every ${interval} seconds starts a new ${language === 'python' ? 'Python interpreter' : language === 'powershell' ? 'PowerShell runspace' : 'shell'} on every host this app is mapped to; a run that takes longer than that overlaps the next.`, { remediation: 'Run it every 60 seconds or more, or collect continuously with a modular input.', source: 'inputs.conf.spec — interval' }));
      }
      if (!index) {
        findings.push(error('splunk.input-no-index', 'No index: the script\u2019s output would land in main.', { source: 'inputs.conf.spec — index' }));
      }
      if (body && language !== 'powershell' && !body.startsWith('#!')) {
        findings.push(warning('splunk.script-no-shebang', `The ${language} script has no #! line. ${language === 'bash' ? 'The forwarder runs it through /bin/sh, which is not bash on Debian and Ubuntu, so bash syntax fails there.' : 'Splunk runs a .py input with its own Python either way, but the script cannot then be tested by running it directly.'}`, { remediation: language === 'bash' ? 'Start it with #!/usr/bin/env bash.' : 'Start it with #!/usr/bin/env python3.', source: 'inputs.conf.spec — script' }));
      }
      if (language === 'bash' && /(^|[\s;&|(])sudo\s/m.test(body)) {
        findings.push(warning('splunk.script-sudo', 'The script calls sudo. The forwarder runs it as its own account with no terminal, so sudo either waits for a password until the input is killed or fails, and the input indexes nothing.', { remediation: 'Grant the forwarder account read access to what the script needs, or a sudoers rule with NOPASSWD for that one command.', source: 'Splunk 10.x — no root installs' }));
      }
      if (language === 'python') {
        const imported = BINARY_MODULES.filter((m) => new RegExp(`^\\s*(import|from)\\s+${m}\\b`, 'm').test(body));
        if (imported.length > 0) {
          findings.push(warning('splunk.script-binary-module', `The script imports ${imported.join(', ')}, which ${imported.length === 1 ? 'has' : 'have'} compiled parts. Splunk\u2019s Python does not include ${imported.length === 1 ? 'it' : 'them'}, and a copy in the app is a binary module, which Splunk 10 apps must not ship.`, { remediation: 'Use the standard library, or a pure-Python package vendored in bin/ or lib/.', source: 'Splunk 10.x — Python 3.9 / 3.13, no binary modules' }));
        }
      }

      const starter                           = {
        bash: script`
#!/usr/bin/env bash
# One event per local filesystem, key=value on one line, which Splunk
# indexes without any props.conf.
set -euo pipefail
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
df -P -k -x tmpfs -x devtmpfs -x overlay | awk -v t="$now" 'NR > 1 { sub(/%/, "", $5); printf "%s mount=%s filesystem=%s size_kb=%s used_kb=%s avail_kb=%s used_pct=%s\n", t, $6, $1, $2, $3, $4, $5 }'
`,
        powershell: script`
# One object per fixed disk. The PowerShell input turns each object's
# properties into key=value fields on one event.
Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType = 3' | ForEach-Object {
  [pscustomobject]@{
    drive    = $_.DeviceID
    size_mb  = [math]::Round($_.Size / 1MB)
    free_mb  = [math]::Round($_.FreeSpace / 1MB)
    free_pct = if ($_.Size) { [math]::Round(100 * $_.FreeSpace / $_.Size, 1) } else { $null }
  }
}
`,
        python: script`
#!/usr/bin/env python3
"""One event per mount point, key=value on one line.

Standard library only: Splunk runs this with its own Python (3.9 or 3.13
on 10.x), and an app must not ship compiled modules.
"""
import datetime
import os
import shutil
import sys


def main():
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    mounts = ['C:\\'] if os.name == 'nt' else ['/', '/opt', '/var', '/tmp']
    for mount in mounts:
        if not os.path.exists(mount):
            continue
        usage = shutil.disk_usage(mount)
        used_pct = round(100 * usage.used / usage.total, 1) if usage.total else 0
        sys.stdout.write(
            f'{now} mount={mount} size_kb={usage.total // 1024} used_kb={usage.used // 1024} '
            f'avail_kb={usage.free // 1024} used_pct={used_pct}\n'
        )
    sys.stdout.flush()


if __name__ == '__main__':
    main()
`,
      };
      const scriptLines = body ? body.split('\n') : starter[language] ?? starter.bash ;

      const stanza           =
        language === 'powershell'
          ? [
              '# The Windows forwarder\u2019s PowerShell input: one runspace, the script',
              '# dot-sourced into it, each output object one event.',
              `[powershell://${name}]`,
              'disabled = 0',
              `script = . "$SplunkHome\\etc\\apps\\${app}\\bin\\${name}.ps1"`,
              `schedule = ${interval}`,
              `index = ${index || 'main'}`,
              `sourcetype = ${sourcetype}`,
            ]
          : [
              `[script://./${file}]`,
              'disabled = 0',
              `interval = ${interval}`,
              `index = ${index || 'main'}`,
              `sourcetype = ${sourcetype}`,
              ...(language === 'python'
                ? [
                    '# The Python versions this script runs on: 3.9 on 10.0 and later, 3.13',
                    '# from 10.4.',
                    PYTHON_REQUIRED,
                    ...(also9x ? ['# For 9.x forwarders, which read python.version instead.', 'python.version = python3'] : []),
                  ]
                : []),
            ];

      const where = language === 'python' ? 'heavy forwarders' : language === 'powershell' ? 'Windows universal forwarders' : 'Linux universal forwarders';
      const splunkBin = language === 'powershell' ? '"C:\\Program Files\\SplunkUniversalForwarder\\bin\\splunk.exe"' : language === 'python' ? '/opt/splunk/bin/splunk' : '/opt/splunkforwarder/bin/splunk';

      return {
        tier,
        title: `Scripted input ${name} (${language === 'python' ? 'Python 3' : language === 'powershell' ? 'PowerShell' : 'bash'}) every ${kind === 'cron' ? `"${interval}"` : `${interval}s`} into ${index || 'main'}`,
        app,
        activation: 'restart',
        notes: [
          `Map this app to the ${where} only.${language === 'python' ? ' The universal forwarder ships no Python, so a Python scripted input goes on a heavy forwarder (or any full Splunk Enterprise instance), which is why this app is for the heavy forwarder tier.' : ''}`,
          `The script runs as the forwarder\u2019s own account (${language === 'powershell' ? 'the virtual account on Windows' : language === 'python' ? 'the splunk user' : 'splunkfwd'}), never as root, with no terminal: anything it reads must be readable by that account, and nothing may prompt.`,
          'Each line the script writes to standard output becomes an event, timestamped from the line if it starts with a time. Anything written to standard error goes to splunkd.log as ExecProcessor messages.',
          ...(language === 'bash' ? ['Set the execute bit on bin/' + `${name}.sh in deployment-apps (chmod 755) before reloading the deployment server: the forwarder runs the file itself, and without the bit it logs "permission denied" and indexes nothing.`] : []),
          ...(language === 'powershell'
            ? [
                'The [powershell://] input is part of the Windows universal forwarder; it does not exist on Linux.',
                `VERIFY: schedule = ${interval} — check the PowerShell input\u2019s schedule format (seconds, or which cron dialect) in inputs.conf.spec on the forwarder version you run; a value it does not accept stops the input from ever running.`,
              ]
            : []),
          ...(language === 'python' ? [`python.required = 3.9, 3.13 declares the Python versions this script works with. Test it on both: splunk cmd python3 ${file}.`] : []),
          ...(kind === 'cron' ? ['A cron schedule runs the script at those times on every host at once. An interval in seconds spreads the runs by when each forwarder started.'] : []),
          'Restart the forwarder after deploying. A new scripted input is not picked up by a reload.',
        ],
        before: [
          ...(language === 'bash' ? [`sudo -u splunkfwd bash ${file}   # runs as the forwarder account, prints what would be indexed`] : []),
          ...(language === 'powershell' ? [`powershell -NoProfile -File .\\${file.replace('/', '\\')}   # prints the objects that become events`] : []),
          ...(language === 'python' ? [`${splunkBin} cmd python3 ${file}   # with Splunk\u2019s own Python`] : []),
          `| rest /services/data/indexes | search title=${index || 'main'} | table title, splunk_server`,
          `${splunkBin} btool inputs list --debug | ${language === 'powershell' ? 'findstr' : 'grep'} "${name}"`,
        ],
        files: {
          'default/inputs.conf': stanza,
          [file]: scriptLines,
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `${splunkBin} list inputstatus`,
          `index=${index || 'main'} sourcetype="${sourcetype}" earliest=-1h | stats count, latest(_time) as last by host | convert ctime(last)`,
          `index=_internal sourcetype=splunkd component=ExecProcessor "${name}" earliest=-1h | stats count by host, log_level, message | sort - count`,
        ],
        backout: [
          `Remove ${app} from the serverclass on the deployment server, then: splunk reload deploy-server`,
          '# The script stops at the forwarder\u2019s restart; data already indexed stays.',
        ],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_modular_input',
    tier: 'heavy_forwarder',
    label: 'Modular input skeleton (Python 3)',
    group: 'Inputs',
    description:
      'A modular input app: its inputs.conf.spec, a scheme and validation written with the Splunk SDK for Python, checkpointing, python.required, one enabled input, and a script that checks the whole app before it is deployed. For heavy forwarders — the universal forwarder has no Python.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'ta_org_api' },
      { id: 'scheme', label: 'Input type (scheme)', control: 'text', default: 'org_api_poll', hint: 'Appears as org_api_poll://<name> in inputs.conf' },
      { id: 'scheme_title', label: 'Title', control: 'text', default: 'Organisation API poll', hint: 'Shown in Settings > Data inputs' },
      { id: 'scheme_description', label: 'Description', control: 'text', default: 'Polls the organisation API and indexes each record as JSON.' },
      {
        id: 'params',
        label: 'Parameters',
        control: 'textarea',
        default: 'endpoint | string | true | https://api.example.com/v1/records | Base URL of the API\npage_size | number | false | 500 | Records per request\nverify_tls | boolean | false | true | Verify the API\u2019s TLS certificate',
        hint: 'name | string/number/boolean | required (true/false) | value for the first input | description',
      },
      { id: 'instance', label: 'First input name', control: 'text', default: 'primary' },
      { id: 'interval', label: 'Run every (seconds)', control: 'number', default: 300, min: 10, max: 86400 },
      { id: 'index', label: 'Index', control: 'text', default: 'app' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'org:api:record' },
      { id: 'single_instance', label: 'One process for every input of this type', control: 'toggle', default: false, hint: 'Off: Splunk starts the script once per input' },
      { id: 'also_9x', label: 'Also runs on 9.x', control: 'toggle', default: false, hint: 'Adds python.version = python3' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'ta_org_api'), 'ta_org_api');
      const scheme = splunkName(str(values, 'scheme', 'org_api_poll'), 'org_api_poll');
      const title = str(values, 'scheme_title', scheme).replace(/[\r\n]+/g, ' ');
      const description = str(values, 'scheme_description', title).replace(/[\r\n]+/g, ' ');
      const instance = str(values, 'instance', 'primary').replace(/[^A-Za-z0-9_.-]/g, '_');
      const interval = Math.max(10, num(values, 'interval', 300));
      const index = splunkName(str(values, 'index', ''), '');
      const sourcetype = str(values, 'sourcetype', `${scheme}:record`);
      const single = bool(values, 'single_instance', false);
      const also9x = bool(values, 'also_9x', false);
      const findings            = [];

      const params             = rows(str(values, 'params', ''), 5).map(([name, type, required, value, desc]) => ({
        name: name ?? '',
        type: (type || 'string').toLowerCase(),
        required: /^(true|yes|1)$/i.test(required ?? ''),
        value: value ?? '',
        description: desc || name || '',
      }));

      if (/^\d/.test(scheme)) {
        findings.push(error('splunk.modinput-scheme', `"${scheme}" starts with a digit; the scheme is also the script\u2019s file name and a stanza prefix, and Splunk does not register it.`, { source: 'inputs.conf.spec — modular inputs' }));
      }
      if (!index) {
        findings.push(error('splunk.input-no-index', 'No index: every event from the input would land in main.', { source: 'inputs.conf.spec — index' }));
      }
      const seen = new Set        ();
      for (const p of params) {
        if (!/^[a-z][a-z0-9_]*$/.test(p.name)) {
          findings.push(error('splunk.modinput-param-name', `"${p.name}" is not a usable parameter name: lower case letters, digits and underscores, starting with a letter.`, { source: 'inputs.conf.spec — modular inputs' }));
        } else if (RESERVED_PARAMS.includes(p.name.toLowerCase()) || p.name.startsWith('python')) {
          findings.push(error('splunk.modinput-param-reserved', `"${p.name}" is a key Splunk reads itself from every input stanza; a parameter with that name is never passed to the script as a parameter.`, { source: 'inputs.conf.spec — common input settings' }));
        }
        if (seen.has(p.name)) {
          findings.push(error('splunk.modinput-param-duplicate', `"${p.name}" is declared twice.`, { source: 'inputs.conf.spec — modular inputs' }));
        }
        seen.add(p.name);
        if (!['string', 'number', 'boolean'].includes(p.type)) {
          findings.push(error('splunk.modinput-param-type', `"${p.type}" is not a parameter type; the scheme takes string, number or boolean.`, { source: 'Splunk SDK for Python — Argument.data_type' }));
        }
        if (p.required && !p.value) {
          findings.push(error('splunk.modinput-required-empty', `${p.name} is required and has no value for the first input, so it fails validation and never starts.`, { remediation: 'Give it a value, or mark it not required.', source: 'Splunk SDK for Python — required_on_create' }));
        }
        if (p.value && p.type === 'number' && !Number.isFinite(Number(p.value))) {
          findings.push(error('splunk.modinput-param-value', `${p.name} is a number, and "${p.value}" is not one; validation rejects the input.`, { source: 'Splunk SDK for Python — Argument.data_type_number' }));
        }
        if (p.value && p.type === 'boolean' && !/^(true|false|0|1)$/i.test(p.value)) {
          findings.push(error('splunk.modinput-param-value', `${p.name} is a boolean, and "${p.value}" is not true, false, 1 or 0; validation rejects the input.`, { source: 'Splunk SDK for Python — Argument.data_type_boolean' }));
        }
        if (/pass(word)?|secret|token|api_?key|credential/i.test(p.name) && p.value) {
          findings.push(warning('splunk.modinput-secret-param', `${p.name} looks like a credential, and its value would sit in plain text in inputs.conf on every heavy forwarder the app is deployed to.`, { remediation: 'Leave it out of the parameters; store it with storage/passwords and read it in the script through self.service.storage_passwords.', source: 'Splunk credential store — storage/passwords' }));
        }
      }

      const pyString = (value        )         => JSON.stringify(value);
      const pyParams = params.map((p) => `    (${pyString(p.name)}, ${pyString(p.type)}, ${p.required ? 'True' : 'False'}, ${pyString(p.description)}),`);

      const modinput = script`
#!/usr/bin/env python3
"""${title}: a Splunk modular input.

Splunk runs this with its own Python (3.9 or 3.13 on 10.x):
  --scheme                prints the scheme, which Splunk reads at start
  --validate-arguments    checks one input's settings before it is saved
  (no argument)           streams events for the inputs of this type
splunklib, the Splunk SDK for Python, is vendored in ../lib by
ops/vendor-sdk.sh. Nothing compiled may be shipped with the app.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))

from splunklib.modularinput import Argument, Event, EventWriter, Scheme, Script  # noqa: E402

# (name, type, required, description), matching README/inputs.conf.spec.
PARAMETERS = [
${pyParams.join('\n')}
]

DATA_TYPES = {
    'string': Argument.data_type_string,
    'number': Argument.data_type_number,
    'boolean': Argument.data_type_boolean,
}


def load_checkpoint(directory, input_name):
    path = os.path.join(directory, re.sub(r'[^A-Za-z0-9_.-]', '_', input_name) + '.json')
    try:
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def save_checkpoint(directory, input_name, state):
    path = os.path.join(directory, re.sub(r'[^A-Za-z0-9_.-]', '_', input_name) + '.json')
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        json.dump(state, handle)
    os.replace(temporary, path)


def collect(settings, state):
    """Yield one dict per event, and leave in state where the next run starts.

    Replace the body with the real collection: call settings['endpoint'],
    page from state, and set state to the newest record seen. A credential
    comes from storage/passwords (self.service.storage_passwords in
    stream_events), never from inputs.conf.
    """
    now = time.time()
    yield {
        'status': 'ok',
        'previous_run': state.get('last_run'),
        'parameters': sorted(name for name, _, _, _ in PARAMETERS if settings.get(name) not in (None, '')),
    }
    state['last_run'] = now


class ModularInput(Script):
    def get_scheme(self):
        scheme = Scheme(${pyString(title)})
        scheme.description = ${pyString(description)}
        scheme.use_external_validation = True
        scheme.use_single_instance = ${single ? 'True' : 'False'}
        for name, kind, required, description in PARAMETERS:
            argument = Argument(name)
            argument.title = name
            argument.description = description
            argument.data_type = DATA_TYPES.get(kind, Argument.data_type_string)
            argument.required_on_create = required
            argument.required_on_edit = False
            scheme.add_argument(argument)
        return scheme

    def validate_input(self, definition):
        settings = definition.parameters
        for name, kind, required, _ in PARAMETERS:
            value = settings.get(name)
            if value in (None, ''):
                if required:
                    raise ValueError(f'{name} is required')
                continue
            if kind == 'number':
                try:
                    float(value)
                except ValueError:
                    raise ValueError(f'{name} must be a number, not {value!r}')
            if kind == 'boolean' and str(value).lower() not in ('true', 'false', '1', '0'):
                raise ValueError(f'{name} must be true or false, not {value!r}')

    def stream_events(self, inputs, ew):
        checkpoint_dir = inputs.metadata['checkpoint_dir']
        for input_name, settings in inputs.inputs.items():
            state = load_checkpoint(checkpoint_dir, input_name)
            try:
                for record in collect(settings, state):
                    event = Event()
                    event.stanza = input_name
                    event.data = json.dumps(record, separators=(',', ':'), sort_keys=True)
                    ew.write_event(event)
                save_checkpoint(checkpoint_dir, input_name, state)
            except Exception as exc:  # one failing input does not stop the others
                ew.log(EventWriter.ERROR, f'{input_name}: {exc}')


if __name__ == '__main__':
    sys.exit(ModularInput().run(sys.argv))
`;

      const validate = script`
#!/usr/bin/env python3
"""Check the ${scheme} modular input app before it is deployed.

Standard library only. Run it with the Python that will run the input,
ideally Splunk's own:
    $SPLUNK_HOME/bin/splunk cmd python3 ops/validate_modinput.py [app directory]
    python3 ops/validate_modinput.py [app directory]
Prints OK or FAIL per check and exits 1 if anything failed.
"""
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

SCHEME = '${scheme}'
SPLUNK_KEYS = {'disabled', 'index', 'sourcetype', 'source', 'host', 'interval',
               'python.required', 'python.version', 'start_by_shell', 'passAuth'}
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..'))
failures = []


def check(ok, what):
    print(('OK    ' if ok else 'FAIL  ') + what)
    if not ok:
        failures.append(what)
    return ok


def read_conf(path):
    stanzas, current = {}, None
    with open(path, encoding='utf-8') as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith('#') or line.startswith('*'):
                continue
            if line.startswith('[') and line.endswith(']'):
                current = stanzas.setdefault(line[1:-1], {})
            elif '=' in line and current is not None:
                key, value = line.split('=', 1)
                current[key.strip()] = value.strip()
    return stanzas


spec_path = os.path.join(APP, 'README', 'inputs.conf.spec')
conf_path = os.path.join(APP, 'default', 'inputs.conf')
script_path = os.path.join(APP, 'bin', SCHEME + '.py')
lib_path = os.path.join(APP, 'lib')

# 1. The spec declares the input type and its parameters.
spec = read_conf(spec_path) if check(os.path.isfile(spec_path), 'README/inputs.conf.spec exists') else {}
declared = spec.get(SCHEME + '://<name>', {})
check(bool(declared), f'the spec declares [{SCHEME}://<name>] and its parameters')

# 2. inputs.conf declares the Python versions, and each input uses only declared keys.
conf = read_conf(conf_path) if check(os.path.isfile(conf_path), 'default/inputs.conf exists') else {}
required = conf.get(SCHEME, {}).get('python.required', '')
check(bool(re.search(r'\b3\.(9|13)\b', required)), f'[{SCHEME}] sets python.required to 3.9 and/or 3.13 (found: {required or "nothing"})')
instances = {k: v for k, v in conf.items() if k.startswith(SCHEME + '://')}
for stanza, keys in instances.items():
    unknown = sorted(k for k in keys if k not in declared and k not in SPLUNK_KEYS)
    check(not unknown, f'[{stanza}] uses only declared parameters' + (f' (unknown: {", ".join(unknown)})' if unknown else ''))

# 3. The script compiles with this Python; nothing compiled ships with the app.
try:
    with open(script_path, encoding='utf-8') as handle:
        compile(handle.read(), script_path, 'exec')
    check(True, f'bin/{SCHEME}.py compiles with Python {sys.version.split()[0]}')
except (OSError, SyntaxError) as exc:
    check(False, f'bin/{SCHEME}.py compiles: {exc}')
binaries = []
for top in (os.path.join(APP, 'bin'), lib_path):
    for root, dirs, files in os.walk(top):
        binaries += [os.path.relpath(os.path.join(root, f), APP) for f in files
                     if f.endswith(('.so', '.pyd', '.dll', '.dylib', '.pyc'))]
check(not binaries, 'no compiled files in bin/ or lib/' + (f' (found: {", ".join(binaries[:5])})' if binaries else ''))

# 4. The SDK is vendored, the scheme lists the declared parameters, and each input validates.
if check(os.path.isdir(os.path.join(lib_path, 'splunklib')), 'lib/splunklib is present (bash ops/vendor-sdk.sh)'):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    result = subprocess.run([sys.executable, script_path, '--scheme'], capture_output=True, text=True, timeout=60, env=env)
    try:
        args = {a.get('name') for a in ET.fromstring(result.stdout).iter('arg')}
        check(args == set(declared), f'--scheme lists the spec parameters (scheme: {sorted(args)}, spec: {sorted(declared)})')
    except ET.ParseError:
        check(False, f'--scheme prints a scheme: {result.stderr.strip()[:300]}')
    for stanza, keys in instances.items():
        items = ET.Element('items')
        for tag, text in (('server_host', 'localhost'), ('server_uri', 'https://127.0.0.1:8089'),
                          ('session_key', ''), ('checkpoint_dir', tempfile.gettempdir())):
            ET.SubElement(items, tag).text = text
        item = ET.SubElement(items, 'item', name=stanza.split('://', 1)[1])
        for key, value in keys.items():
            if key in declared:
                ET.SubElement(item, 'param', name=key).text = value
        run = subprocess.run([sys.executable, script_path, '--validate-arguments'], input=ET.tostring(items, encoding='unicode'),
                             capture_output=True, text=True, timeout=60, env=env)
        check(run.returncode == 0, f'[{stanza}] passes validation' + ('' if run.returncode == 0 else f': {(run.stdout + run.stderr).strip()[:300]}'))

print(f'{len(failures)} check(s) failed.' if failures else 'All checks passed.')
sys.exit(1 if failures else 0)
`;

      const vendor = script`
#!/usr/bin/env bash
# Put the Splunk SDK for Python (splunklib) into lib/, where the input
# looks for it. Refuses to leave anything compiled there.
# Applies when run; --dry-run prints what it would do.
# Usage: bash ops/vendor-sdk.sh [--dry-run]
# Env:   SDK=splunk-sdk==<version>   pin the version you tested
set -euo pipefail
EXECUTE=1; [[ "\${1:-}" == "--dry-run" ]] && EXECUTE=0
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib"
SDK="\${SDK:-splunk-sdk}"
if (( ! EXECUTE )); then
  echo "DRY RUN: python3 -m pip install --upgrade --no-compile --target $LIB $SDK"
  echo "DRY RUN: then fail if any .so, .pyd or .dylib is in $LIB, and remove __pycache__"
  exit 0
fi
python3 -m pip install --upgrade --no-compile --target "$LIB" "$SDK"
found="$(find "$LIB" -type f \( -name '*.so' -o -name '*.pyd' -o -name '*.dylib' \) | head -5)"
if [[ -n "$found" ]]; then
  echo "Compiled modules in lib/ — a Splunk 10 app must not ship these:" >&2
  echo "$found" >&2
  exit 1
fi
find "$LIB" -type d -name __pycache__ -prune -exec rm -rf {} +
echo "splunklib is in $LIB. Next: python3 ops/validate_modinput.py"
`;

      return {
        tier: 'heavy_forwarder',
        title: `Modular input ${scheme}://${instance} every ${interval}s into ${index || 'main'}`,
        app,
        activation: 'restart',
        notes: [
          'This goes on heavy forwarders (or another full Splunk Enterprise instance): the universal forwarder ships no Python, so it cannot run a Python modular input.',
          'Run bash ops/vendor-sdk.sh to put splunklib into lib/, then python3 ops/validate_modinput.py (better: splunk cmd python3 ops/validate_modinput.py). It checks the spec, python.required, that nothing compiled is in the app, that --scheme lists the spec\u2019s parameters, and that each input passes the script\u2019s own validation.',
          `The input ${scheme}://${instance} is created enabled and starts at the forwarder\u2019s restart. The starter collect() in bin/${scheme}.py indexes one status event per run; replace it with the real collection.`,
          `Checkpoints are one JSON file per input in $SPLUNK_HOME/var/lib/splunk/modinputs/${scheme}/, written after each successful run, so a failed run is retried from the same place.`,
          'python.required = 3.9, 3.13 declares the Python versions the script works with; test on both. Splunk 10.4 deprecates 3.9.',
          `Events are JSON: deploy props.conf [${sourcetype}] with KV_MODE = json to the search heads, and INDEXED_EXTRACTIONS only if you have a reason to.`,
          'A credential never goes in inputs.conf: store it with storage/passwords and read it in stream_events through self.service.storage_passwords.',
          `VERIFY: splunk cmd splunkd print-modinput-config ${scheme} ${scheme}://${instance} — prints the configuration Splunk would pass to the script; check the command on your version before relying on it.`,
          'Restart splunkd after deploying: a new input type is only registered at start.',
        ],
        before: [
          '$SPLUNK_HOME/bin/splunk cmd python3 --version',
          'bash ops/vendor-sdk.sh --dry-run',
          '$SPLUNK_HOME/bin/splunk cmd python3 ops/validate_modinput.py',
          `| rest /services/data/indexes | search title=${index || 'main'} | table title, splunk_server`,
        ],
        files: {
          'README/inputs.conf.spec': [
            `[${scheme}://<name>]`,
            ...params.flatMap((p) => [`${p.name} = <${p.type}>`, `* ${p.description.replace(/\.?$/, '.')}${p.required ? ' Required.' : ''}`]),
          ],
          'default/inputs.conf': [
            `# Defaults for every ${scheme} input on this node.`,
            `[${scheme}]`,
            '# The Python versions the script runs on: 3.9 on 10.0 and later, 3.13',
            '# from 10.4.',
            PYTHON_REQUIRED,
            ...(also9x ? ['# For 9.x, which reads python.version instead.', 'python.version = python3'] : []),
            `interval = ${interval}`,
            '',
            `[${scheme}://${instance}]`,
            'disabled = 0',
            `index = ${index || 'main'}`,
            `sourcetype = ${sourcetype}`,
            `interval = ${interval}`,
            ...params.filter((p) => p.value).map((p) => `${p.name} = ${p.value}`),
          ],
          [`bin/${scheme}.py`]: modinput,
          'metadata/default.meta': defaultMeta(),
          'ops/vendor-sdk.sh': vendor,
          'ops/validate_modinput.py': validate,
        },
        verify: [
          `$SPLUNK_HOME/bin/splunk cmd python3 $SPLUNK_HOME/etc/apps/${app}/bin/${scheme}.py --scheme`,
          `| rest /services/data/modular-inputs splunk_server=local | search title=${scheme} | table title, eai:acl.app`,
          `index=${index || 'main'} sourcetype="${sourcetype}" earliest=-1h | stats count, latest(_time) as last by host, source | convert ctime(last)`,
          `index=_internal sourcetype=splunkd (component=ModularInputs OR component=ExecProcessor) "${scheme}" log_level IN (WARN, ERROR) earliest=-1h | tail 20`,
        ],
        backout: [
          `Remove ${app} from the heavy forwarders (the serverclass, then splunk reload deploy-server) and restart splunkd.`,
          `# Checkpoints stay in $SPLUNK_HOME/var/lib/splunk/modinputs/${scheme}/; delete them to start from scratch on re-deploy.`,
          '# Data already indexed stays.',
        ],
        findings,
      };
    },
  }),
];
