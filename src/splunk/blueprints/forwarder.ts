/**
 * Splunk forwarder: what to read, what to listen on, where to send it.
 *
 * A forwarder app is the smallest and most commonly wrong part of a Splunk
 * deployment. The recurring faults are always the same: a monitor stanza with a
 * wildcard broad enough to read the whole filesystem, an input with no index so
 * everything lands in main, a syslog listener on a port that only root can
 * bind, and an outputs.conf pointing at one indexer so a maintenance window on
 * that one stops ingestion from a thousand machines.
 *
 * Every app here is written against those.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { splunkBlueprint, type SplunkBlueprint } from '../from-app.ts';
import { defaultMeta, listOf, splunkName, type SplunkApp } from '../splunk.ts';

const TIER = 'forwarder' as const;

export const FORWARDER_BLUEPRINTS: readonly SplunkBlueprint[] = [
  splunkBlueprint({
    id: 'splunk_file_input',
    tier: TIER,
    label: 'File and directory monitoring',
    group: 'Inputs',
    description: 'Monitor logs on disk, with the index named, the recursion bounded, and the rotated and compressed files handled rather than re-read.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_inputs_app' },
      { id: 'paths', label: 'Paths', control: 'textarea', default: '/var/log/app/*.log\n/var/log/app/archive/...' },
      { id: 'index', label: 'Index', control: 'text', default: 'app_prod' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'app:json' },
      { id: 'recursive', label: 'Subdirectories', control: 'select', default: 'one', options: [
        { value: 'none', label: 'This directory only' },
        { value: 'one', label: 'One level down' },
        { value: 'all', label: 'Everything below — use sparingly' },
      ] },
      { id: 'exclude', label: 'Exclude', control: 'text', default: '\\.gz$, \\.zip$, \\.[0-9]+$', hint: 'Regexes — rotated and compressed files are usually already indexed' },
      { id: 'follow_tail', label: 'Start from', control: 'select', default: 'beginning', options: [
        { value: 'beginning', label: 'The beginning of each file' },
        { value: 'tail', label: 'The end — only new data' },
      ] },
      { id: 'host_from', label: 'Set host from', control: 'select', default: 'machine', options: [
        { value: 'machine', label: 'The machine name' },
        { value: 'segment', label: 'A path segment' },
        { value: 'regex', label: 'A pattern in the path' },
      ] },
      { id: 'host_segment', label: 'Segment number', control: 'number', default: 3, min: 1, max: 20, showWhen: { input: 'host_from', equals: ['segment'] } },
      { id: 'host_regex', label: 'Host pattern', control: 'text', default: '/logs/(\\w+)/', showWhen: { input: 'host_from', equals: ['regex'] } },
      { id: 'ignore_older', label: 'Ignore files older than (days)', control: 'number', default: 30, min: 0, max: 3650 },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_inputs_app'), 'org_inputs_app');
      const paths = listOf(str(values, 'paths', '').replace(/\n/g, ','));
      const index = splunkName(str(values, 'index', ''), '');
      const sourcetype = str(values, 'sourcetype', '');
      const recursive = str(values, 'recursive', 'one');
      const excludes = listOf(str(values, 'exclude', ''));
      const ignoreOlder = num(values, 'ignore_older', 30);
      const findings: Finding[] = [];

      if (!index) {
        findings.push(
          error('splunk.input-no-index', 'With no index named, everything this reads goes to main. Splitting it out afterwards means re-indexing, because an event cannot be moved between indexes.', {
            remediation: 'Name the index here, and make sure it exists on the indexers first.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!sourcetype) {
        findings.push(
          warning('splunk.input-no-sourcetype', 'Without a sourcetype Splunk guesses one per file, which produces a scatter of sourcetypes like app-2 and app-too_small, each parsed differently.', {
            source: 'ArchToolKit',
          }),
        );
      }
      for (const path of paths) {
        if (/^\/(\*|\.\.\.)|^\/var\/log\/?(\*|\.\.\.)?$|^C:\\\\?(\*|\.\.\.)/.test(path)) {
          findings.push(
            error('splunk.monitor-too-broad', `"${path}" monitors far more than it looks like. Splunk will read everything it can under there, index it, and charge the licence for it — including whatever someone drops in next month.`, {
              remediation: 'Name the directory and the file pattern.',
              source: 'ArchToolKit',
            }),
          );
        }
      }
      if (recursive === 'all') {
        findings.push(
          warning('splunk.recursive-all', 'Unbounded recursion follows every subdirectory created under that path for ever. A build system or an application that creates dated directories will fill the index with data nobody asked for.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (excludes.length === 0) {
        findings.push(
          warning('splunk.no-exclusions', 'Without exclusions, rotated files — app.log.1, app.log.gz — are read as new files and their contents indexed a second time. It looks like a volume spike and it is duplicated data.', {
            remediation: 'Exclude the rotation suffixes the log rotation actually produces.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        tier: TIER,
        title: `Monitor ${paths.length} path${paths.length === 1 ? '' : 's'} into ${index || 'main'}`,
        app,
        activation: 'restart',
        notes: [
          'A monitor input remembers how far it has read, by file, in the fishbucket. Deleting a file and putting back a file with the same name and size means the new one is not read — which is the usual reason "the logs stopped".',
          'crcSalt = <SOURCE> makes the position tracking include the full path. It is right for files whose first lines are identical — many rotated logs — and wrong for files that get renamed, where it causes the whole file to be re-read.',
          ...(ignoreOlder > 0 ? [`Files not modified for ${ignoreOlder} days are ignored, so turning this on against a directory of history does not index years of it at once.`] : []),
          'Restart the forwarder after deploying. A monitor input is not picked up by a reload.',
          index ? `The index "${index}" must already exist on the indexers. Data for an index that does not exist is dropped, and the forwarder logs it once.` : '',
        ].filter(Boolean),
        before: [
          'ls -la ' + (paths[0] ?? '/var/log'),
          'splunk list monitor',
          'splunk cmd btool inputs list --debug | head -40',
          `| rest /services/data/indexes | search title=${index || 'main'}`,
        ],
        files: {
          'default/inputs.conf': [
            ...paths.flatMap((path) => [
              `[monitor://${path}]`,
              'disabled = 0',
              ...(index ? [`index = ${index}`] : ['# No index set — everything lands in main.']),
              ...(sourcetype ? [`sourcetype = ${sourcetype}`] : []),
              ...(recursive === 'none' ? ['recursive = false'] : recursive === 'one' ? ['recursive = true', 'host_segment = 0'] : ['recursive = true']),
              ...(excludes.length > 0 ? [`blacklist = (${excludes.join('|')})`] : []),
              ...(str(values, 'follow_tail', 'beginning') === 'tail' ? ['followTail = 1'] : []),
              ...(ignoreOlder > 0 ? [`ignoreOlderThan = ${ignoreOlder}d`] : []),
              ...(str(values, 'host_from', 'machine') === 'segment' ? [`host_segment = ${num(values, 'host_segment', 3)}`] : []),
              ...(str(values, 'host_from', 'machine') === 'regex' ? [`host_regex = ${str(values, 'host_regex', '')}`] : []),
              '# crcSalt makes the read position depend on the full path. Right for',
              '# files with identical first lines; wrong for files that get renamed.',
              '# crcSalt = <SOURCE>',
              '',
            ]),
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk list monitor',
          'splunk list inputstatus',
          `index=${index || 'main'} ${sourcetype ? `sourcetype=${sourcetype}` : ''} earliest=-15m | stats count by host, source`,
          'index=_internal sourcetype=splunkd component=TailReader | tail 20',
          'index=_internal host=<this forwarder> component=TailingProcessor | search "will not be monitored" OR "Ignoring" | tail 20',
        ],
        backout: [`rm -rf $SPLUNK_HOME/etc/apps/${app}`, 'splunk restart', '# Data already indexed stays. Removing the input only stops new data.'],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_network_input',
    tier: TIER,
    label: 'Syslog and HEC listeners',
    group: 'Inputs',
    description: 'Receive data over the network: syslog on UDP or TCP, or HTTP Event Collector — with the port privilege, the queue size and the per-source routing that a busy listener needs.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_inputs_network' },
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'udp', options: [
        { value: 'udp', label: 'UDP syslog — lossy, and what most devices send' },
        { value: 'tcp', label: 'TCP syslog — reliable, fewer devices support it' },
        { value: 'hec', label: 'HTTP Event Collector' },
      ] },
      { id: 'port', label: 'Port', control: 'number', default: 5514, min: 1, max: 65535 },
      { id: 'index', label: 'Index', control: 'text', default: 'network' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'syslog' },
      { id: 'route_by_host', label: 'Split by sending host', control: 'toggle', default: true, hint: 'Different sourcetype and index per device type', showWhen: { input: 'protocol', equals: ['udp', 'tcp'] } },
      { id: 'routes', label: 'Routing', control: 'textarea', default: '10.0.1.0/24 | cisco:ios | network\n10.0.2.0/24 | pan:traffic | security', hint: 'CIDR or host | sourcetype | index', showWhen: { input: 'route_by_host', equals: ['true'] } },
      { id: 'queue_size', label: 'Receive queue', control: 'text', default: '10MB', showWhen: { input: 'protocol', equals: ['udp', 'tcp'] } },
      { id: 'hec_ssl', label: 'HEC over TLS', control: 'toggle', default: true, showWhen: { input: 'protocol', equals: ['hec'] } },
      { id: 'hec_ack', label: 'Require indexer acknowledgement', control: 'toggle', default: false, showWhen: { input: 'protocol', equals: ['hec'] } },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_inputs_network'), 'org_inputs_network');
      const protocol = str(values, 'protocol', 'udp');
      const port = num(values, 'port', 5514);
      const index = splunkName(str(values, 'index', ''), 'main');
      const sourcetype = str(values, 'sourcetype', 'syslog');
      const routeByHost = bool(values, 'route_by_host', true) && protocol !== 'hec';
      const routes = str(values, 'routes', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [source, type, target] = line.split('|').map((p) => p.trim());
          return { source: source ?? '', sourcetype: type ?? '', index: target ?? '' };
        })
        .filter((r) => r.source);
      const findings: Finding[] = [];

      if (port < 1024) {
        findings.push(
          error('splunk.privileged-port', `Port ${port} needs root to bind, and Splunk should not run as root. Listen on a high port and redirect to it, or grant the capability.`, {
            remediation: `iptables -t nat -A PREROUTING -p ${protocol === 'tcp' ? 'tcp' : 'udp'} --dport ${port} -j REDIRECT --to-port ${port + 5000}   # or setcap cap_net_bind_service=+ep on splunkd`,
            source: 'ArchToolKit',
          }),
        );
      }
      if (protocol === 'udp') {
        findings.push(
          warning('splunk.udp-syslog-loss', 'UDP syslog drops silently under load, and nothing anywhere records that it happened. For anything that matters — an audit trail, a security log — put a syslog server in front that writes to files, and monitor those files instead.', {
            remediation: 'syslog-ng or rsyslog writing to /var/log/remote/<host>/, with a file monitor over it, is the standard answer and gives you per-host files and buffering.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (protocol === 'hec' && !bool(values, 'hec_ssl', true)) {
        findings.push(
          error('splunk.hec-plaintext', 'HEC without TLS sends the token in clear on every request. The token is a credential that can write to any index it is allowed.', { source: 'ArchToolKit' }),
        );
      }
      if (protocol === 'hec') {
        findings.push(
          warning('splunk.hec-token-not-in-file', 'The token is deliberately left empty in this app. Splunk generates one when the input is created, and a token committed to version control is a credential in version control.', {
            remediation: 'Create the token through Settings or the REST API after deployment, then distribute it through whatever holds your secrets.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (routeByHost && routes.length === 0) {
        findings.push(warning('splunk.no-routes', 'Splitting by sending host is on, but no routes were given, so everything gets the default sourcetype.', { source: 'ArchToolKit' }));
      }

      return {
        tier: TIER,
        title: `${protocol.toUpperCase()} listener on ${port} into ${index}`,
        app,
        activation: 'restart',
        notes: [
          protocol === 'udp'
            ? 'A UDP listener has one receive buffer. When it fills, the kernel drops packets and neither Splunk nor the sender knows. That is acceptable for volume metrics and not acceptable for an audit trail.'
            : protocol === 'tcp'
              ? 'TCP syslog will not lose data silently — the sender blocks or errors instead. Fewer devices support it, and those that do often need it configuring explicitly.'
              : 'HEC is a token-authenticated HTTP endpoint. The token can write to whichever indexes it is allowed, so scope it to the ones it needs and no more.',
          ...(routeByHost && routes.length > 0
            ? ['Routing by sending address is what turns one syslog listener into per-device-type sourcetypes. Without it every device shares one sourcetype and one set of parsing rules, which cannot be right for all of them.']
            : []),
          ...(protocol !== 'hec' ? ['This is a heavy forwarder or an indexer receiving directly. A universal forwarder can listen too, but it does not parse — so the sourcetype is assigned and the parsing happens downstream.'] : []),
          'Restart after deploying. A network input is not picked up by a reload.',
        ],
        before: [
          `ss -lnu${protocol === 'tcp' ? 'p' : 'p'} | grep ${port}`,
          'splunk cmd btool inputs list --debug | grep -A5 "' + protocol + '://"',
          `| rest /services/data/indexes | search title=${index}`,
          ...(protocol === 'hec' ? ['| rest /services/data/inputs/http | table title, index, disabled'] : []),
        ],
        files: {
          'default/inputs.conf': [
            ...(protocol === 'hec'
              ? [
                  '[http]',
                  'disabled = 0',
                  `port = ${port}`,
                  `enableSSL = ${bool(values, 'hec_ssl', true) ? 1 : 0}`,
                  `useDeploymentServer = 0`,
                  'dedicatedIoThreads = 2',
                  '',
                  `[http://${app}]`,
                  'disabled = 0',
                  `index = ${index}`,
                  `indexes = ${index}`,
                  `sourcetype = ${sourcetype}`,
                  `useACK = ${bool(values, 'hec_ack', false) ? 1 : 0}`,
                  '# token is deliberately empty. Splunk generates one on creation;',
                  '# a token in a conf file is a credential in version control.',
                  'token =',
                ]
              : [
                  `[${protocol}://${port}]`,
                  'disabled = 0',
                  `index = ${index}`,
                  `sourcetype = ${sourcetype}`,
                  'connection_host = ip',
                  '# Keep the syslog priority rather than stripping it — it carries',
                  '# the facility and severity, which are often the only structure.',
                  'no_priority_stripping = false',
                  'no_appending_timestamp = false',
                  ...(protocol === 'udp' ? [`queueSize = ${str(values, 'queue_size', '10MB')}`, '_rcvbuf = 16777216'] : ['queueSize = ' + str(values, 'queue_size', '10MB')]),
                  ...(routeByHost && routes.length > 0 ? ['', '# Routing by sender is done in transforms.conf, keyed on _MetaData:Host.'] : []),
                ]),
            'metadata/default.meta',
          ].slice(0, -1),
          ...(routeByHost && routes.length > 0
            ? {
                'default/props.conf': [
                  `[source::${protocol}:${port}]`,
                  `TRANSFORMS-route = ${routes.map((_, i) => `route_${i}`).join(', ')}`,
                ],
                'default/transforms.conf': routes.flatMap((route, i) => [
                  `[route_${i}]`,
                  `# ${route.source}`,
                  `SOURCE_KEY = MetaData:Host`,
                  `REGEX = ${route.source.includes('/') ? `^host::${route.source.split('/')[0]?.split('.').slice(0, 3).join('\\.')}\\.` : `^host::${route.source}$`}`,
                  ...(route.index ? ['DEST_KEY = _MetaData:Index', `FORMAT = ${route.index}`] : []),
                  '',
                  ...(route.sourcetype
                    ? [`[route_${i}_sourcetype]`, `SOURCE_KEY = MetaData:Host`, `REGEX = ${route.source.includes('/') ? `^host::${route.source.split('/')[0]?.split('.').slice(0, 3).join('\\.')}\\.` : `^host::${route.source}$`}`, 'DEST_KEY = MetaData:Sourcetype', `FORMAT = sourcetype::${route.sourcetype}`, '']
                    : []),
                ]),
              }
            : {}),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `ss -ln${protocol === 'tcp' ? 't' : 'u'} | grep ${port}`,
          ...(protocol === 'udp' ? [`logger -n <this host> -P ${port} "archtoolkit test message"`, 'netstat -su | grep -i "packet receive errors"   # a rising count means the buffer is too small'] : []),
          ...(protocol === 'tcp' ? [`echo "archtoolkit test message" | nc <this host> ${port}`] : []),
          ...(protocol === 'hec'
            ? [`curl -k https://<this host>:${port}/services/collector/event -H "Authorization: Splunk <token>" -d '{"event":"archtoolkit test","sourcetype":"${sourcetype}"}'`, '| rest /services/data/inputs/http | table title, index, disabled']
            : []),
          `index=${index} earliest=-5m | stats count by host, sourcetype`,
          'index=_internal sourcetype=splunkd component=TcpInputProc OR component=UDPInputProcessor | tail 20',
        ],
        backout: [`rm -rf $SPLUNK_HOME/etc/apps/${app}`, 'splunk restart', `# Anything still sending to port ${port} will now get nothing, with no error at the sender for UDP.`],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_outputs',
    tier: TIER,
    label: 'Where the forwarder sends data',
    group: 'Delivery',
    description: 'outputs.conf pointing at every indexer rather than one, with indexer acknowledgement so nothing in flight is lost, a sensibly sized output queue, and the TLS that stops the data crossing the network in clear.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_forwarder_outputs' },
      { id: 'indexers', label: 'Indexers', control: 'textarea', default: 'idx01.example.com:9997\nidx02.example.com:9997\nidx03.example.com:9997', hint: 'Every one of them — a single entry is a single point of failure' },
      { id: 'discovery', label: 'How the forwarder finds them', control: 'select', default: 'list', options: [
        { value: 'list', label: 'The list above' },
        { value: 'discovery', label: 'Indexer discovery from the cluster manager' },
      ] },
      { id: 'manager_uri', label: 'Cluster manager', control: 'text', default: 'https://cm01.example.com:8089', showWhen: { input: 'discovery', equals: ['discovery'] } },
      { id: 'tls', label: 'TLS to the indexers', control: 'toggle', default: true },
      { id: 'queue_size', label: 'Output queue (in memory)', control: 'text', default: 'auto', hint: 'maxQueueSize: auto (7MB with useACK), or a few MB. It is RAM on every forwarder and does not survive a restart — it is not a disk buffer' },
      { id: 'auto_lb_seconds', label: 'Switch indexer every (seconds)', control: 'number', default: 30, min: 5, max: 300 },
      { id: 'compression', label: 'Compress on the wire', control: 'toggle', default: false, hint: 'Saves bandwidth, costs forwarder CPU' },
      { id: 'index_and_forward', label: 'Also keep a local copy', control: 'toggle', default: false, hint: 'Only on a heavy forwarder, and rarely wanted' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_forwarder_outputs'), 'org_forwarder_outputs');
      const indexers = listOf(str(values, 'indexers', '').replace(/\n/g, ','));
      const discovery = str(values, 'discovery', 'list') === 'discovery';
      const tls = bool(values, 'tls', true);
      const queueRaw = str(values, 'queue_size', 'auto').trim() || 'auto';
      const queueMatch = /^(\d+)\s*(KB|MB|GB)?$/i.exec(queueRaw);
      const queueSize = /^auto$/i.test(queueRaw) ? 'auto' : queueMatch ? `${queueMatch[1]}${(queueMatch[2] ?? '').toUpperCase()}` : 'auto';
      const queueMB = queueMatch && queueMatch[2] ? Number(queueMatch[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 } as Record<string, number>)[queueMatch[2].toUpperCase()]! : 0;
      const findings: Finding[] = [];

      if (queueSize === 'auto' && !/^auto$/i.test(queueRaw)) {
        findings.push(warning('splunk.queue-size-invalid', `"${queueRaw}" is not a maxQueueSize value (auto, a count, or a number with KB, MB or GB); auto is used instead.`, { source: 'outputs.conf spec' }));
      }
      if (queueMB > 100) {
        findings.push(
          warning('splunk.queue-size-large', `maxQueueSize = ${queueSize} is held in memory on every forwarder, and with useACK the wait queue is three times that again — about ${Math.round(queueMB * 4)} MB of RAM per forwarder when the indexers are away. It does not survive a restart, so it buys no durability for the memory it costs.`, {
            remediation: 'Leave it at auto (7MB with useACK) or a few MB. Monitored files need no buffer: the forwarder stops reading and resumes at its saved offset. For network, scripted or FIFO inputs that cannot pause, set persistentQueueSize on those input stanzas in inputs.conf.',
            source: 'outputs.conf and inputs.conf specification',
          }),
        );
      }

      if (!discovery && indexers.length === 0) {
        findings.push(error('splunk.no-indexers', 'No indexer was given, so the forwarder has nowhere to send data.', { source: 'ArchToolKit' }));
      }
      if (!discovery && indexers.length === 1) {
        findings.push(
          error('splunk.single-indexer', 'One indexer in the output list means a restart of that indexer stops ingestion from every forwarder using this app. Back-pressure and useACK keep monitored files from being lost while it is down; nothing keeps the data flowing.', {
            remediation: 'List every indexer, or use indexer discovery so the list maintains itself.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!tls) {
        findings.push(
          warning('splunk.forwarding-plaintext', 'Without TLS, everything the forwarder sends crosses the network in clear — which for most Splunk deployments is every log the organisation has.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (bool(values, 'index_and_forward', false)) {
        findings.push(
          warning('splunk.index-and-forward', 'Indexing locally as well as forwarding doubles the storage and gives two copies that can drift. It is occasionally right on a heavy forwarder and almost never right otherwise.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        tier: TIER,
        title: `Forward to ${discovery ? 'the cluster, via indexer discovery' : `${indexers.length} indexer${indexers.length === 1 ? '' : 's'}`}`,
        app,
        activation: 'restart',
        notes: [
          'Auto load balancing switches indexer on a timer, not per event. A forwarder sending one large file will stick to one indexer for the whole file unless forceTimebasedAutoLB is on — which is why one indexer sometimes looks far busier than the rest.',
          `The output queue (maxQueueSize = ${queueSize}) is memory, not disk: it smooths short stalls and is gone on a restart. What carries an indexer outage is back-pressure — the forwarder stops reading monitored files and resumes at its saved offset, so a file is only lost if it rotates out of the monitored path before the indexers return. useACK keeps a copy of each block in a wait queue until an indexer confirms it is written.`,
          'Inputs that cannot pause — TCP/UDP network inputs, scripted inputs, FIFOs — lose data under back-pressure. For those, the disk-backed buffer is persistentQueueSize on the input stanza in inputs.conf (for example [udp://514] persistentQueueSize = 5GB); outputs.conf has no persistent queue.',
          ...(discovery ? ['Indexer discovery means the list maintains itself as peers are added and removed. The forwarder needs to reach the cluster manager on 8089, and the manager needs a pass4SymmKey that matches.'] : []),
          ...(tls ? ['The certificate paths point at Splunk\u2019s defaults, which are the same self-signed certificate on every installation. Replace them with your own before this is anything but a lab.'] : []),
          'Restart after deploying. outputs.conf is not picked up by a reload.',
        ],
        before: [
          'splunk cmd btool outputs list --debug',
          'splunk list forward-server',
          'index=_internal host=<this forwarder> component=TcpOutputProc | tail 20',
          ...(discovery ? ['curl -k https://<cluster manager>:8089/services/cluster/manager/peers -u <user>'] : []),
        ],
        files: {
          'default/outputs.conf': [
            '[tcpout]',
            'defaultGroup = primary_indexers',
            ...(bool(values, 'index_and_forward', false) ? ['indexAndForward = 1'] : ['indexAndForward = 0']),
            '',
            '# maxQueueSize is the in-MEMORY output queue. auto = 7MB with useACK',
            '# (500KB without), and useACK adds a wait queue of three times this.',
            '# It is not persisted and does not survive a restart; a GB value here',
            '# is GBs of RAM on every forwarder for no durability. The disk-backed',
            '# buffer is persistentQueueSize, and it belongs on network, scripted and',
            '# FIFO input stanzas in inputs.conf, not here. Monitored files need none:',
            '# the forwarder stops reading and resumes at its saved offset.',
            `maxQueueSize = ${queueSize}`,
            '# The forwarder keeps each block until an indexer confirms it is written,',
            '# and resends it elsewhere if that indexer goes away first.',
            'useACK = true',
            '',
            '[tcpout:primary_indexers]',
            ...(discovery
              ? [
                  `indexerDiscovery = cluster_manager`,
                  '# The server list maintains itself as peers come and go.',
                ]
              : [`server = ${indexers.join(', ')}`]),
            'autoLB = true',
            `autoLBFrequency = ${num(values, 'auto_lb_seconds', 30)}`,
            '# Without this, a forwarder sending one large file stays on one',
            '# indexer for the whole file and the load looks uneven.',
            'forceTimebasedAutoLB = true',
            ...(bool(values, 'compression', false) ? ['compressed = true'] : []),
            '',
            ...(tls
              ? [
                  '# These are Splunk\u2019s default certificates, which are identical on',
                  '# every installation. Replace them before this is anything but a lab.',
                  'clientCert = $SPLUNK_HOME/etc/auth/server.pem',
                  'sslPassword = <REQUIRED>',
                  'useClientSSLCompression = true',
                  'sslVerifyServerCert = true',
                  'sslCommonNameToCheck = <the indexer certificate common name>',
                  '',
                ]
              : []),
            ...(discovery
              ? [
                  '[indexer_discovery:cluster_manager]',
                  `master_uri = ${str(values, 'manager_uri', '')}`,
                  'pass4SymmKey = <REQUIRED>',
                  '# The key must match the one on the cluster manager. It is',
                  '# encrypted in place on first restart.',
                ]
              : []),
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk list forward-server',
          'splunk cmd btool outputs list --debug',
          'index=_internal host=<this forwarder> component=TcpOutputProc | tail 20',
          'index=_internal host=<this forwarder> | stats count by host   # data from this forwarder is arriving',
          '| rest /services/data/inputs/tcp/cooked | table title, connection_host   # on the indexers',
          `index=_internal source=*metrics.log group=queue name=tcpout* | timechart avg(current_size_kb) by name   # a queue that stays full means the indexers cannot keep up`,
        ],
        backout: [
          `rm -rf $SPLUNK_HOME/etc/apps/${app}`,
          'splunk restart',
          '# Without an outputs.conf the forwarder sends nowhere and buffers until',
          '# its queue fills, then stops reading. Put a replacement in place first.',
        ],
        findings,
      };
    },
  }),
];
