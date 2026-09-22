/**
 * Palo Alto PAN-OS, the rest of it.
 *
 * Objects and one rule are where a firewall starts, not where it ends. This
 * adds the pieces a real deployment needs: service objects, dynamic address
 * groups, static routes and a virtual router, the security profiles a rule
 * should reference, log forwarding, the IPsec tunnel, the management and
 * logging servers, zone protection, decryption, and the administrator
 * accounts — all as `set` commands, with the matching object module for the
 * push half.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint, withPush,                      } from '../from-change.js';
import { listOf, parseCidr,                   } from '../device.js';

const PLATFORM = 'panos'         ;
const PROVIDER = '{{ provider }}';

/** Panorama puts everything under a device group; a firewall does not. */
const prefixFor = (dg        )         => (dg ? `set device-group ${dg}` : 'set');

const BLUEPRINTS                             = [
  deviceBlueprint({
    id: 'panos_service_objects',
    platform: PLATFORM,
    label: 'Service objects and a group',
    group: 'Objects',
    description: 'Named TCP and UDP services and a group, so a rule can say "APP-PORTS" rather than a list of numbers.',
    inputs: [
      { id: 'group_name', label: 'Group name', control: 'text', default: 'SVC-APP-PORTS' },
      { id: 'services', label: 'Services', control: 'textarea', default: 'SVC-HTTPS tcp 443\nSVC-APP tcp 8080-8081\nSVC-SYSLOG udp 514', hint: 'One per line: NAME protocol port(s)' },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const group = str(values, 'group_name', 'SVC-GROUP').toUpperCase().replace(/\s+/g, '-');
      const dg = str(values, 'device_group', '');
      const prefix = prefixFor(dg);
      const entries = str(values, 'services', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 3)
        .map(([name, protocol, port]) => ({ name: String(name), protocol: String(protocol).toLowerCase(), port: String(port) }));
      const findings            = [];
      for (const entry of entries) {
        if (entry.protocol !== 'tcp' && entry.protocol !== 'udp') {
          findings.push(error('network.panos.bad-protocol', `"${entry.protocol}" for ${entry.name} is not tcp or udp.`, { source: 'ArchToolKit' }));
        }
      }
      if (entries.length === 0) findings.push(error('network.panos.no-services', 'No service objects were given.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `${entries.length} service object(s) and the group ${group}`,
        impact: 'none',
        notes: ['Objects change nothing until a rule uses them, and nothing at all until the commit.', 'Prefer application-default on a rule where the App-ID knows the port; a service object is for the cases where it does not.'],
        before: ['show object service', `show object service-group ${group}`],
        config: [
          ...entries.map((entry) => `${prefix} service ${entry.name} protocol ${entry.protocol} port ${entry.port}`),
          `${prefix} service-group ${group} members [ ${entries.map((e) => e.name).join(' ')} ]`,
        ],
        verify: [`show object service-group ${group}`, 'show config diff', 'commit description "ArchToolKit: service objects"'],
        backout: [`${prefix.replace('set', 'delete')} service-group ${group}`, ...entries.map((entry) => `${prefix.replace('set', 'delete')} service ${entry.name}`)],
        push: {
          module: 'paloaltonetworks.panos.panos_service_object',
          args: {
            provider: PROVIDER,
            name: '{{ item.name }}',
            protocol: '{{ item.protocol }}',
            destination_port: '{{ item.port }}',
            ...(dg ? { device_group: dg } : {}),
            state: 'present',
          },
          after: [
            {
              name: `Group them as ${group}`,
              module: 'paloaltonetworks.panos.panos_service_group',
              args: { provider: PROVIDER, name: group, value: entries.map((e) => e.name), ...(dg ? { device_group: dg } : {}), state: 'present' },
            },
            { name: 'Commit', module: 'paloaltonetworks.panos.panos_commit_firewall', args: { provider: PROVIDER, description: 'ArchToolKit: service objects' } },
          ],
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_dynamic_address_group',
    platform: PLATFORM,
    label: 'Tag-based dynamic address group',
    group: 'Objects',
    description: 'A group whose membership is a tag match rather than a list — how a rule keeps up with a cloud or a VM estate that changes without a commit.',
    inputs: [
      { id: 'group_name', label: 'Group name', control: 'text', default: 'DAG-WEB-TIER' },
      { id: 'tags', label: 'Tags to create', control: 'text', default: 'web-tier, prod', hint: 'Tags must exist before anything can match them' },
      { id: 'filter', label: 'Match filter', control: 'text', default: "'web-tier' and 'prod'", hint: "PAN-OS filter syntax: 'tag-a' and 'tag-b', or 'tag-a' or 'tag-b'" },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const group = str(values, 'group_name', 'DAG').toUpperCase().replace(/\s+/g, '-');
      const tags = listOf(str(values, 'tags', ''));
      const filter = str(values, 'filter', '');
      const dg = str(values, 'device_group', '');
      const prefix = prefixFor(dg);

      return {
        platform: PLATFORM,
        title: `Dynamic address group ${group}`,
        impact: 'none',
        notes: [
          'Membership changes without a commit, which is the point: something registers a tag through the API or an agent and the rule follows.',
          'The rule that uses this group still needs a commit once. After that the membership is live.',
          'Nothing tags addresses on its own. A VM-Series plugin, Panorama, or your own API call has to register them.',
        ],
        before: [`show object dynamic-address-group name ${group}`, 'show object registered-ip all'],
        config: [
          ...tags.map((tag) => `${prefix} tag ${tag} color color7`),
          `${prefix} address-group ${group} dynamic filter "${filter}"`,
          `${prefix} address-group ${group} description "Generated by ArchToolKit"`,
        ],
        verify: [`show object dynamic-address-group name ${group}`, 'show object registered-ip all', 'commit description "ArchToolKit: dynamic address group"'],
        backout: [`${prefix.replace('set', 'delete')} address-group ${group}`, ...tags.map((tag) => `${prefix.replace('set', 'delete')} tag ${tag}`)],
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_static_route',
    platform: PLATFORM,
    label: 'Static route',
    group: 'Network',
    description: 'A static route in a virtual router, optionally with path monitoring so it withdraws when the next hop stops answering.',
    inputs: [
      { id: 'virtual_router', label: 'Virtual router', control: 'text', default: 'default' },
      { id: 'route_name', label: 'Route name', control: 'text', default: 'default-route' },
      { id: 'destination', label: 'Destination', control: 'text', default: '0.0.0.0/0' },
      { id: 'next_hop', label: 'Next hop', control: 'text', default: '203.0.113.1' },
      { id: 'interface', label: 'Interface', control: 'text', default: 'ethernet1/1' },
      { id: 'metric', label: 'Metric', control: 'number', default: 10, min: 1, max: 65535 },
      { id: 'monitor', label: 'Path monitoring', control: 'toggle', default: true, hint: 'Pings the next hop and withdraws the route when it stops answering' },
    ],
    change: (values                 )               => {
      const vr = str(values, 'virtual_router', 'default');
      const name = str(values, 'route_name', 'route');
      const cidr = parseCidr(str(values, 'destination', ''));
      const hop = str(values, 'next_hop', '');
      const monitor = bool(values, 'monitor', true);
      const findings            = [];
      if (!cidr) findings.push(error('network.panos.bad-destination', 'The destination is not a valid prefix.', { source: 'ArchToolKit' }));

      const base = `set network virtual-router ${vr} routing-table ip static-route ${name}`;
      return {
        platform: PLATFORM,
        title: `Static route ${cidr ? `${cidr.address}/${cidr.prefix}` : '(invalid)'} via ${hop}`,
        impact: cidr && cidr.prefix === 0 ? 'outage' : 'brief',
        notes: [
          ...(cidr && cidr.prefix === 0 ? ['This is the default route. If it is wrong, the firewall loses its path out — including to whatever you are managing it from.'] : []),
          ...(monitor ? ['Path monitoring removes the route when the next hop stops answering, which is what lets a backup route take over. Without it a dead next hop keeps a live route.'] : []),
        ],
        before: [`show routing route virtual-router ${vr}`, 'show config diff'],
        config: [
          `${base} destination ${cidr ? `${cidr.address}/${cidr.prefix}` : '0.0.0.0/0'}`,
          `${base} nexthop ip-address ${hop}`,
          `${base} interface ${str(values, 'interface', '')}`,
          `${base} metric ${num(values, 'metric', 10)}`,
          ...(monitor
            ? [
                `${base} path-monitor enable yes`,
                `${base} path-monitor failure-condition any`,
                `${base} path-monitor hold-time 2`,
                `${base} path-monitor monitor-destinations ${name}-probe destination ${hop}`,
                `${base} path-monitor monitor-destinations ${name}-probe source ${str(values, 'interface', '')}`,
                `${base} path-monitor monitor-destinations ${name}-probe enable yes`,
              ]
            : []),
        ],
        verify: [`show routing route virtual-router ${vr}`, ...(monitor ? [`show routing path-monitor virtual-router ${vr}`] : []), 'commit description "ArchToolKit: static route"'],
        backout: [`delete network virtual-router ${vr} routing-table ip static-route ${name}`],
        push: {
          module: 'paloaltonetworks.panos.panos_static_route',
          args: {
            provider: PROVIDER,
            name,
            destination: cidr ? `${cidr.address}/${cidr.prefix}` : '0.0.0.0/0',
            nexthop_type: 'ip-address',
            nexthop: hop,
            interface: str(values, 'interface', ''),
            metric: num(values, 'metric', 10),
            virtual_router: vr,
            state: 'present',
          },
          after: [{ name: 'Commit', module: 'paloaltonetworks.panos.panos_commit_firewall', args: { provider: PROVIDER, description: 'ArchToolKit: static route' } }],
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_security_profiles',
    platform: PLATFORM,
    label: 'Security profile group',
    group: 'Policy',
    description: 'The antivirus, anti-spyware, vulnerability, URL filtering and file blocking profiles a rule should carry, collected into one group.',
    inputs: [
      { id: 'group_name', label: 'Profile group name', control: 'text', default: 'PG-STANDARD' },
      { id: 'base_profiles', label: 'Base profiles', control: 'select', default: 'strict', options: [
        { value: 'strict', label: 'Predefined strict' },
        { value: 'default', label: 'Predefined default' },
      ] },
      { id: 'url_profile', label: 'URL filtering profile', control: 'text', default: 'URL-CORP', hint: 'Created here with the categories below blocked' },
      { id: 'blocked_categories', label: 'Blocked URL categories', control: 'text', default: 'malware, phishing, command-and-control, newly-registered-domain' },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const group = str(values, 'group_name', 'PG').toUpperCase().replace(/\s+/g, '-');
      const base = str(values, 'base_profiles', 'strict');
      const url = str(values, 'url_profile', '').toUpperCase().replace(/\s+/g, '-');
      const categories = listOf(str(values, 'blocked_categories', ''));
      const dg = str(values, 'device_group', '');
      const prefix = prefixFor(dg);

      return {
        platform: PLATFORM,
        title: `Security profile group ${group}`,
        impact: 'none',
        notes: [
          'A profile group changes nothing until a rule references it. Attach it to the allow rules that carry user traffic.',
          'Blocking a URL category will block something legitimate eventually. Watch the URL filtering log for a week before anyone complains.',
          'Threat prevention and URL filtering need their licences and their content updates, or the profiles do nothing.',
        ],
        before: ['show config diff', `show object profile-group ${group}`, 'request license info'],
        config: [
          ...(url
            ? [
                ...categories.map((category) => `${prefix} profiles url-filtering ${url} block [ ${category} ]`),
                `${prefix} profiles url-filtering ${url} credential-enforcement mode disabled`,
                `${prefix} profiles url-filtering ${url} log-http-hdr-xff yes`,
              ]
            : []),
          `${prefix} profile-group ${group} virus [ ${base} ]`,
          `${prefix} profile-group ${group} spyware [ ${base} ]`,
          `${prefix} profile-group ${group} vulnerability [ ${base} ]`,
          ...(url ? [`${prefix} profile-group ${group} url-filtering [ ${url} ]`] : []),
          `${prefix} profile-group ${group} file-blocking [ "basic file blocking" ]`,
          `${prefix} profile-group ${group} wildfire-analysis [ default ]`,
        ],
        verify: [`show object profile-group ${group}`, 'show config diff', 'commit description "ArchToolKit: profile group"'],
        backout: [`${prefix.replace('set', 'delete')} profile-group ${group}`, ...(url ? [`${prefix.replace('set', 'delete')} profiles url-filtering ${url}`] : [])],
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_ipsec_tunnel',
    platform: PLATFORM,
    label: 'Site-to-site IPsec tunnel',
    group: 'Network',
    description: 'An IKE gateway, the crypto profiles, the tunnel interface and the IPsec tunnel — a route-based VPN to another site or a cloud.',
    inputs: [
      { id: 'tunnel_name', label: 'Tunnel name', control: 'text', default: 'VPN-BRANCH-01' },
      { id: 'peer_address', label: 'Peer address', control: 'text', default: '198.51.100.10' },
      { id: 'local_interface', label: 'Local interface', control: 'text', default: 'ethernet1/1' },
      { id: 'tunnel_interface', label: 'Tunnel interface', control: 'text', default: 'tunnel.1' },
      { id: 'tunnel_address', label: 'Tunnel address', control: 'text', default: '10.254.1.1/30', hint: 'Empty for a numberless tunnel' },
      { id: 'zone', label: 'Zone for the tunnel', control: 'text', default: 'vpn' },
      { id: 'virtual_router', label: 'Virtual router', control: 'text', default: 'default' },
      { id: 'ike_version', label: 'IKE version', control: 'select', default: 'ikev2', options: [{ value: 'ikev2', label: 'IKEv2 only' }, { value: 'ikev2-preferred', label: 'IKEv2 preferred' }] },
      { id: 'dh_group', label: 'DH group', control: 'select', default: 'group20', options: [
        { value: 'group20', label: 'Group 20 (ECP-384)' },
        { value: 'group19', label: 'Group 19 (ECP-256)' },
        { value: 'group14', label: 'Group 14 (MODP-2048)' },
      ] },
      { id: 'monitor', label: 'Tunnel monitoring', control: 'toggle', default: true },
      { id: 'monitor_destination', label: 'Monitor destination', control: 'text', default: '10.254.1.2', showWhen: { input: 'monitor', equals: ['true'] } },
    ],
    change: (values                 )               => {
      const name = str(values, 'tunnel_name', 'VPN').toUpperCase().replace(/\s+/g, '-');
      const peer = str(values, 'peer_address', '');
      const tunnelIface = str(values, 'tunnel_interface', 'tunnel.1');
      const address = parseCidr(str(values, 'tunnel_address', ''));
      const zone = str(values, 'zone', 'vpn');
      const vr = str(values, 'virtual_router', 'default');
      const dh = str(values, 'dh_group', 'group20');
      const monitor = bool(values, 'monitor', true);

      return {
        platform: PLATFORM,
        title: `IPsec tunnel ${name} to ${peer}`,
        impact: 'brief',
        notes: [
          'The pre-shared key is <REQUIRED>. Put the real one in by hand or from a vault — it is never written into a generated file.',
          'Both ends must agree on the proposals, the DH group and the identities. A mismatch shows as phase 1 or phase 2 failing in the system log.',
          'A route-based tunnel carries nothing until there is a route pointing into the tunnel interface and a security rule permitting the zone pair.',
          ...(monitor ? ['Tunnel monitoring needs something at the far end that answers ICMP, or the tunnel will be brought down for being healthy-but-quiet.'] : []),
        ],
        before: ['show vpn ike-sa', 'show vpn ipsec-sa', 'show vpn flow', 'show config diff'],
        config: [
          `set network ike crypto-profiles ike-crypto-profiles ${name}-IKE dh-group [ ${dh} ]`,
          `set network ike crypto-profiles ike-crypto-profiles ${name}-IKE encryption [ aes-256-gcm ]`,
          `set network ike crypto-profiles ike-crypto-profiles ${name}-IKE hash [ sha384 ]`,
          `set network ike crypto-profiles ike-crypto-profiles ${name}-IKE lifetime hours 8`,
          `set network ike crypto-profiles ipsec-crypto-profiles ${name}-IPSEC esp encryption [ aes-256-gcm ]`,
          `set network ike crypto-profiles ipsec-crypto-profiles ${name}-IPSEC esp authentication [ none ]`,
          `set network ike crypto-profiles ipsec-crypto-profiles ${name}-IPSEC dh-group ${dh}`,
          `set network ike crypto-profiles ipsec-crypto-profiles ${name}-IPSEC lifetime hours 1`,
          `set network ike gateway ${name}-GW authentication pre-shared-key key <REQUIRED>`,
          `set network ike gateway ${name}-GW protocol version ${str(values, 'ike_version', 'ikev2')}`,
          `set network ike gateway ${name}-GW protocol ikev2 ike-crypto-profile ${name}-IKE`,
          `set network ike gateway ${name}-GW protocol ikev2 dpd enable yes`,
          `set network ike gateway ${name}-GW local-address interface ${str(values, 'local_interface', '')}`,
          `set network ike gateway ${name}-GW peer-address ip ${peer}`,
          `set network interface tunnel units ${tunnelIface} comment "${name}"`,
          ...(address ? [`set network interface tunnel units ${tunnelIface} ip ${address.address}/${address.prefix}`] : []),
          `set zone ${zone} network layer3 [ ${tunnelIface} ]`,
          `set network virtual-router ${vr} interface [ ${tunnelIface} ]`,
          `set network tunnel ipsec ${name} auto-key ike-gateway [ ${name}-GW ]`,
          `set network tunnel ipsec ${name} auto-key ipsec-crypto-profile ${name}-IPSEC`,
          `set network tunnel ipsec ${name} tunnel-interface ${tunnelIface}`,
          ...(monitor
            ? [
                `set network tunnel ipsec ${name} tunnel-monitor enable yes`,
                `set network tunnel ipsec ${name} tunnel-monitor destination-ip ${str(values, 'monitor_destination', '')}`,
              ]
            : []),
        ],
        verify: ['show vpn ike-sa gateway ' + name + '-GW', `show vpn ipsec-sa tunnel ${name}`, `show vpn flow tunnel-id 1`, 'commit description "ArchToolKit: IPsec tunnel"'],
        backout: [
          `delete network tunnel ipsec ${name}`,
          `delete network virtual-router ${vr} interface ${tunnelIface}`,
          `delete zone ${zone} network layer3 ${tunnelIface}`,
          `delete network interface tunnel units ${tunnelIface}`,
          `delete network ike gateway ${name}-GW`,
          `delete network ike crypto-profiles ike-crypto-profiles ${name}-IKE`,
          `delete network ike crypto-profiles ipsec-crypto-profiles ${name}-IPSEC`,
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_log_forwarding',
    platform: PLATFORM,
    label: 'Log forwarding and syslog',
    group: 'Operations',
    description: 'A syslog server profile and a log forwarding profile, so traffic and threat logs reach a SIEM instead of only the firewall.',
    inputs: [
      { id: 'profile_name', label: 'Log forwarding profile', control: 'text', default: 'LF-DEFAULT' },
      { id: 'syslog_server', label: 'Syslog server', control: 'text', default: '10.0.0.20' },
      { id: 'syslog_port', label: 'Port', control: 'number', default: 514, min: 1, max: 65535 },
      { id: 'transport', label: 'Transport', control: 'select', default: 'UDP', options: [{ value: 'UDP', label: 'UDP' }, { value: 'TCP', label: 'TCP' }, { value: 'SSL', label: 'SSL' }] },
      { id: 'format', label: 'Format', control: 'select', default: 'BSD', options: [{ value: 'BSD', label: 'BSD' }, { value: 'IETF', label: 'IETF (RFC 5424)' }] },
      { id: 'log_types', label: 'Log types to forward', control: 'text', default: 'traffic, threat, url, wildfire, system, configuration' },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const profile = str(values, 'profile_name', 'LF').toUpperCase().replace(/\s+/g, '-');
      const server = str(values, 'syslog_server', '');
      const types = listOf(str(values, 'log_types', ''));
      const dg = str(values, 'device_group', '');
      const prefix = prefixFor(dg);
      const findings            = [];
      if (str(values, 'transport', 'UDP') === 'UDP') {
        findings.push(
          warning('network.panos.syslog-udp', 'UDP syslog is unacknowledged: a busy firewall or a congested link loses log entries silently.', {
            remediation: 'TCP or SSL where the collector supports it.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Log forwarding to ${server}`,
        impact: 'none',
        notes: [
          'The profile forwards nothing until rules reference it. Set it as the default on the security rules, or attach it rule by rule.',
          'Traffic logs are high volume. Check what the collector charges you for before forwarding every session.',
        ],
        before: ['show log-collector preference-list', 'show config diff', `show config running | match ${profile}`],
        config: [
          `set shared log-settings syslog SYSLOG-${server.replace(/\./g, '-')} server SYSLOG-${server.replace(/\./g, '-')} server ${server}`,
          `set shared log-settings syslog SYSLOG-${server.replace(/\./g, '-')} server SYSLOG-${server.replace(/\./g, '-')} transport ${str(values, 'transport', 'UDP')}`,
          `set shared log-settings syslog SYSLOG-${server.replace(/\./g, '-')} server SYSLOG-${server.replace(/\./g, '-')} port ${num(values, 'syslog_port', 514)}`,
          `set shared log-settings syslog SYSLOG-${server.replace(/\./g, '-')} server SYSLOG-${server.replace(/\./g, '-')} format ${str(values, 'format', 'BSD')}`,
          `set shared log-settings syslog SYSLOG-${server.replace(/\./g, '-')} server SYSLOG-${server.replace(/\./g, '-')} facility LOG_USER`,
          ...types.flatMap((type) => [
            `${prefix} log-settings profiles ${profile} match-list ${type}-all log-type ${type}`,
            `${prefix} log-settings profiles ${profile} match-list ${type}-all send-syslog [ SYSLOG-${server.replace(/\./g, '-')} ]`,
          ]),
        ],
        verify: ['show config diff', 'commit description "ArchToolKit: log forwarding"', 'tail follow yes mp-log ms.log', 'Check the collector is receiving.'],
        backout: [`${prefix.replace('set', 'delete')} log-settings profiles ${profile}`, `delete shared log-settings syslog SYSLOG-${server.replace(/\./g, '-')}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_zone_protection',
    platform: PLATFORM,
    label: 'Zone protection profile',
    group: 'Policy',
    description: 'Flood protection and reconnaissance protection on an internet-facing zone — the profile that absorbs a SYN flood rather than the session table.',
    inputs: [
      { id: 'profile_name', label: 'Profile name', control: 'text', default: 'ZP-UNTRUST' },
      { id: 'zone', label: 'Apply to zone', control: 'text', default: 'untrust' },
      { id: 'syn_alarm', label: 'SYN alarm rate (per second)', control: 'number', default: 10000, min: 100 },
      { id: 'syn_activate', label: 'SYN activate rate', control: 'number', default: 15000, min: 100, hint: 'Where SYN cookies start' },
      { id: 'syn_maximum', label: 'SYN maximum rate', control: 'number', default: 40000, min: 100, hint: 'Where new SYNs are dropped' },
      { id: 'recon', label: 'Reconnaissance protection', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const profile = str(values, 'profile_name', 'ZP').toUpperCase().replace(/\s+/g, '-');
      const zone = str(values, 'zone', 'untrust');
      const base = `set network profiles zone-protection-profile ${profile}`;

      return {
        platform: PLATFORM,
        title: `Zone protection ${profile} on ${zone}`,
        impact: 'brief',
        notes: [
          'The rates here are a starting point, not an answer. Measure the zone’s normal connection rate first — a threshold below what the site does on a Monday morning is a self-inflicted outage.',
          'SYN cookies cost CPU. Activating them at a rate the firewall cannot sustain trades one problem for another.',
        ],
        before: [`show counter global filter delta yes | match flood`, 'show session info', 'show config diff'],
        config: [
          `${base} flood tcp-syn enable yes`,
          `${base} flood tcp-syn syn-cookies alarm-rate ${num(values, 'syn_alarm', 10000)}`,
          `${base} flood tcp-syn syn-cookies activate-rate ${num(values, 'syn_activate', 15000)}`,
          `${base} flood tcp-syn syn-cookies maximal-rate ${num(values, 'syn_maximum', 40000)}`,
          `${base} flood udp enable yes`,
          `${base} flood icmp enable yes`,
          `${base} flood other-ip enable yes`,
          ...(bool(values, 'recon', true)
            ? [
                `${base} scan TCP-Port-Scan action block-ip track-by source-and-destination duration 600`,
                `${base} scan Host-Sweep action block-ip track-by source-and-destination duration 600`,
                `${base} scan UDP-Port-Scan action block-ip track-by source-and-destination duration 600`,
              ]
            : []),
          `set zone ${zone} network zone-protection-profile ${profile}`,
        ],
        verify: ['show counter global filter delta yes | match flood', `show config running | match ${profile}`, 'commit description "ArchToolKit: zone protection"'],
        backout: [`delete zone ${zone} network zone-protection-profile`, `delete network profiles zone-protection-profile ${profile}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_management',
    platform: PLATFORM,
    label: 'Management access and services',
    group: 'Baseline',
    description: 'Permitted management addresses, NTP, DNS, the update schedule and an administrator account — the baseline a firewall should have before it carries traffic.',
    inputs: [
      { id: 'permitted', label: 'Permitted management addresses', control: 'text', default: '10.0.0.0/24' },
      { id: 'ntp_primary', label: 'NTP primary', control: 'text', default: '10.0.0.10' },
      { id: 'ntp_secondary', label: 'NTP secondary', control: 'text', default: '10.0.0.11' },
      { id: 'dns_primary', label: 'DNS primary', control: 'text', default: '10.0.0.10' },
      { id: 'dns_secondary', label: 'DNS secondary', control: 'text', default: '10.0.0.11' },
      { id: 'admin_user', label: 'Administrator username', control: 'text', default: 'netadmin' },
      { id: 'content_updates', label: 'Content update schedule', control: 'select', default: 'daily', options: [
        { value: 'daily', label: 'Daily, download and install' },
        { value: 'hourly', label: 'Hourly, download only' },
        { value: 'none', label: 'Leave as it is' },
      ] },
    ],
    change: (values                 )               => {
      const permitted = listOf(str(values, 'permitted', ''));
      const updates = str(values, 'content_updates', 'daily');
      const user = str(values, 'admin_user', 'netadmin');
      const findings            = [];
      if (permitted.length === 0) {
        findings.push(error('network.panos.no-permitted-ip', 'Without a permitted address list, the management interface answers anything that can reach it.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: 'Management access, NTP, DNS and updates',
        impact: 'brief',
        notes: [
          'The permitted address list takes effect on commit. If your own address is not in it, that is the last commit you make from here.',
          'The administrator password is <REQUIRED>: set it interactively or from your vault.',
          'Content updates need a licence and a path out. A firewall with expired content is a firewall with no threat prevention.',
        ],
        before: ['show system info', 'show config running | match permitted-ip', 'request content upgrade info'],
        config: [
          ...permitted.map((prefix) => `set deviceconfig system permitted-ip ${prefix}`),
          `set deviceconfig system ntp-servers primary-ntp-server ntp-server-address ${str(values, 'ntp_primary', '')}`,
          `set deviceconfig system ntp-servers secondary-ntp-server ntp-server-address ${str(values, 'ntp_secondary', '')}`,
          `set deviceconfig system dns-setting servers primary ${str(values, 'dns_primary', '')}`,
          `set deviceconfig system dns-setting servers secondary ${str(values, 'dns_secondary', '')}`,
          'set deviceconfig system service disable-telnet yes',
          'set deviceconfig system service disable-http yes',
          'set deviceconfig setting management idle-timeout 30',
          `set mgt-config users ${user} permissions role-based superuser yes`,
          `set mgt-config users ${user} password <REQUIRED>`,
          ...(updates === 'daily'
            ? [
                'set deviceconfig system update-schedule threats recurring daily at 02:00',
                'set deviceconfig system update-schedule threats recurring daily action download-and-install',
                'set deviceconfig system update-schedule anti-virus recurring daily at 03:00',
                'set deviceconfig system update-schedule anti-virus recurring daily action download-and-install',
                'set deviceconfig system update-schedule wildfire recurring every-15-mins action download-and-install',
              ]
            : updates === 'hourly'
              ? ['set deviceconfig system update-schedule threats recurring hourly at 5 action download-only']
              : []),
        ],
        verify: ['show system info', 'show ntp', 'show config running | match permitted-ip', 'commit description "ArchToolKit: management baseline"'],
        backout: [...permitted.map((prefix) => `delete deviceconfig system permitted-ip ${prefix}`), `delete mgt-config users ${user}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_decryption',
    platform: PLATFORM,
    label: 'Decryption policy',
    group: 'Policy',
    description: 'A forward-proxy decryption rule with the exclusions that keep banking, health and certificate-pinned applications out of it.',
    inputs: [
      { id: 'rule_name', label: 'Rule name', control: 'text', default: 'Decrypt-Outbound' },
      { id: 'source_zone', label: 'Source zone', control: 'text', default: 'trust' },
      { id: 'dest_zone', label: 'Destination zone', control: 'text', default: 'untrust' },
      { id: 'certificate', label: 'Forward trust certificate', control: 'text', default: 'DECRYPT-CA', hint: 'A CA certificate that already exists on the firewall and is trusted by the clients' },
      { id: 'exclude_categories', label: 'Categories to leave alone', control: 'text', default: 'financial-services, health-and-medicine, government, insurance' },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const name = str(values, 'rule_name', 'Decrypt');
      const exclusions = listOf(str(values, 'exclude_categories', ''));
      const dg = str(values, 'device_group', '');
      const prefix = dg ? `set device-group ${dg} pre-rulebase` : 'set rulebase';

      return {
        platform: PLATFORM,
        title: `Decryption rule ${name}`,
        impact: 'outage',
        notes: [
          'Decryption breaks things. Certificate pinning, mutual TLS and anything that checks the chain will fail the moment this applies — which is why the exclusions come first and the rollout is a pilot group.',
          'The clients must trust the forward trust certificate, or every site shows a certificate error.',
          'There are legal and HR implications to decrypting user traffic. Get that agreed before the technical change, not after.',
          'The certificate is referenced, never generated here.',
        ],
        before: ['show config diff', 'show system setting ssl-decrypt certificate', 'show session all filter ssl-decrypt yes | count'],
        config: [
          `${prefix} decryption rules NO-DECRYPT-SENSITIVE from [ ${str(values, 'source_zone', 'trust')} ]`,
          `${prefix} decryption rules NO-DECRYPT-SENSITIVE to [ ${str(values, 'dest_zone', 'untrust')} ]`,
          `${prefix} decryption rules NO-DECRYPT-SENSITIVE source [ any ]`,
          `${prefix} decryption rules NO-DECRYPT-SENSITIVE destination [ any ]`,
          `${prefix} decryption rules NO-DECRYPT-SENSITIVE category [ ${exclusions.join(' ')} ]`,
          `${prefix} decryption rules NO-DECRYPT-SENSITIVE action no-decrypt`,
          `${prefix} decryption rules ${name} from [ ${str(values, 'source_zone', 'trust')} ]`,
          `${prefix} decryption rules ${name} to [ ${str(values, 'dest_zone', 'untrust')} ]`,
          `${prefix} decryption rules ${name} source [ any ]`,
          `${prefix} decryption rules ${name} destination [ any ]`,
          `${prefix} decryption rules ${name} service [ any ]`,
          `${prefix} decryption rules ${name} action decrypt`,
          `${prefix} decryption rules ${name} type ssl-forward-proxy`,
          `${prefix} decryption rules ${name} profile default`,
        ],
        verify: ['show config diff', 'show session all filter ssl-decrypt yes | count', 'Check a pilot client can browse before widening the source.', 'commit description "ArchToolKit: decryption"'],
        backout: [`${prefix.replace('set', 'delete')} decryption rules ${name}`, `${prefix.replace('set', 'delete')} decryption rules NO-DECRYPT-SENSITIVE`],
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_ha_pair',
    platform: PLATFORM,
    label: 'High availability pair',
    group: 'Baseline',
    description: 'Active/passive HA: the control link, the data link, the device priority and the monitoring that decides when to fail over.',
    inputs: [
      { id: 'group_id', label: 'HA group id', control: 'number', default: 1, min: 1, max: 63 },
      { id: 'role', label: 'This firewall is', control: 'select', default: 'primary', options: [{ value: 'primary', label: 'Primary (priority 100)' }, { value: 'secondary', label: 'Secondary (priority 110)' }] },
      { id: 'peer_ha1', label: 'Peer HA1 address', control: 'text', default: '10.0.100.2' },
      { id: 'local_ha1', label: 'This firewall’s HA1 address', control: 'text', default: '10.0.100.1/30' },
      { id: 'ha1_interface', label: 'HA1 interface', control: 'text', default: 'ha1-a' },
      { id: 'ha2_interface', label: 'HA2 interface', control: 'text', default: 'ha2-a' },
      { id: 'preemptive', label: 'Preemptive', control: 'toggle', default: false, hint: 'Off is usually right: a flapping primary should not keep taking over' },
      { id: 'monitored_interfaces', label: 'Link monitoring', control: 'text', default: 'ethernet1/1, ethernet1/2' },
    ],
    change: (values                 )               => {
      const group = num(values, 'group_id', 1);
      const priority = str(values, 'role', 'primary') === 'primary' ? 100 : 110;
      const local = parseCidr(str(values, 'local_ha1', ''));
      const monitored = listOf(str(values, 'monitored_interfaces', ''));
      const findings            = [];
      if (bool(values, 'preemptive', false)) {
        findings.push(
          warning('network.panos.ha-preemptive', 'Preemption makes a recovering firewall take over again, which turns one failover into two.', {
            remediation: 'Leave it off unless the pair is not symmetric.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `HA group ${group}, ${str(values, 'role', 'primary')}`,
        impact: 'outage',
        notes: [
          'Both firewalls need the same group id and the same HA mode, with the priorities the other way round. Configure the passive one first.',
          'The pair must be on the same PAN-OS version and content version, or they will not synchronise.',
          'Enabling HA on a firewall already passing traffic will cause a brief interruption while sessions synchronise.',
        ],
        before: ['show high-availability state', 'show high-availability all', 'show system info | match version'],
        config: [
          `set deviceconfig high-availability enabled yes`,
          `set deviceconfig high-availability group group-id ${group}`,
          `set deviceconfig high-availability group mode active-passive passive-link-state auto`,
          `set deviceconfig high-availability group election-option device-priority ${priority}`,
          `set deviceconfig high-availability group election-option preemptive ${bool(values, 'preemptive', false) ? 'yes' : 'no'}`,
          `set deviceconfig high-availability group peer-ip ${str(values, 'peer_ha1', '')}`,
          `set deviceconfig high-availability interface ha1 port ${str(values, 'ha1_interface', 'ha1-a')}`,
          ...(local ? [`set deviceconfig high-availability interface ha1 ip-address ${local.address}`, `set deviceconfig high-availability interface ha1 netmask ${'255.255.255.252'}`] : []),
          `set deviceconfig high-availability interface ha2 port ${str(values, 'ha2_interface', 'ha2-a')}`,
          'set deviceconfig high-availability group state-synchronization enabled yes',
          'set deviceconfig high-availability group monitoring link-monitoring enabled yes',
          ...monitored.map((iface) => `set deviceconfig high-availability group monitoring link-monitoring link-group MONITORED interface [ ${iface} ]`),
          'set deviceconfig high-availability group monitoring link-monitoring link-group MONITORED failure-condition any',
        ],
        verify: ['show high-availability state', 'show high-availability all', 'show high-availability state-synchronization', 'commit description "ArchToolKit: HA"'],
        backout: ['set deviceconfig high-availability enabled no'],
        findings,
      };
    },
  }),
];

/**
 * The modules that apply these changes, where the collection has one.
 *
 * The rest — log forwarding, zone protection, decryption, the profile group
 * and HA — have no module in `paloaltonetworks.panos`, so they are CLI and API
 * only, and each one says so in its findings rather than quietly producing no
 * playbook.
 */
const PUSHES                                                                                            = {
  panos_dynamic_address_group: (values) => ({
    module: 'paloaltonetworks.panos.panos_address_group',
    args: {
      provider: PROVIDER,
      name: str(values, 'group_name', 'DAG').toUpperCase().replace(/\s+/g, '-'),
      dynamic_value: str(values, 'filter', ''),
      ...(str(values, 'device_group', '') ? { device_group: str(values, 'device_group', '') } : {}),
      state: 'present',
    },
    after: [{ name: 'Commit', module: 'paloaltonetworks.panos.panos_commit_firewall', args: { provider: PROVIDER, description: 'ArchToolKit: dynamic address group' } }],
  }),
  panos_ipsec_tunnel: (values) => {
    const name = str(values, 'tunnel_name', 'VPN').toUpperCase().replace(/\s+/g, '-');
    return {
      module: 'paloaltonetworks.panos.panos_ike_gateway',
      args: {
        provider: PROVIDER,
        name: `${name}-GW`,
        interface: str(values, 'local_interface', ''),
        peer_ip_value: str(values, 'peer_address', ''),
        pre_shared_key: '{{ vault_vpn_psk }}',
        version: str(values, 'ike_version', 'ikev2') === 'ikev2' ? 'ikev2' : 'ikev2-preferred',
        ikev2_crypto_profile: `${name}-IKE`,
        state: 'present',
      },
      after: [
        {
          name: 'The IPsec tunnel itself',
          module: 'paloaltonetworks.panos.panos_ipsec_tunnel',
          args: { provider: PROVIDER, name, tunnel_interface: str(values, 'tunnel_interface', 'tunnel.1'), ak_ike_gateway: `${name}-GW`, ak_ipsec_crypto_profile: `${name}-IPSEC`, state: 'present' },
        },
        { name: 'Commit', module: 'paloaltonetworks.panos.panos_commit_firewall', args: { provider: PROVIDER, description: 'ArchToolKit: IPsec tunnel' } },
      ],
    };
  },
  panos_management: (values) => ({
    module: 'paloaltonetworks.panos.panos_mgtconfig',
    args: {
      provider: PROVIDER,
      dns_server_primary: str(values, 'dns_primary', ''),
      dns_server_secondary: str(values, 'dns_secondary', ''),
      ntp_server_primary: str(values, 'ntp_primary', ''),
      ntp_server_secondary: str(values, 'ntp_secondary', ''),
      commit: false,
    },
    after: [{ name: 'Commit', module: 'paloaltonetworks.panos.panos_commit_firewall', args: { provider: PROVIDER, description: 'ArchToolKit: management baseline' } }],
  }),
};

export const PANOS_EXTRA                             = BLUEPRINTS.map((blueprint) => {
  const push = PUSHES[blueprint.id];
  return push ? withPush(blueprint, push) : blueprint;
});
