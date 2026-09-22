/**
 * Cisco IOS and IOS-XE, the rest of it.
 *
 * The first IOS file covers the campus basics — VLANs, ports, trunks, bundles,
 * static routes, OSPF, BGP, access lists, the management baseline and spanning
 * tree. This one covers what a real device also ends up carrying: routed
 * interfaces and loopbacks, VRFs, EIGRP, first-hop redundancy, redistribution,
 * IP SLA and tracking, NAT, DHCP, edge protections, 802.1X, SPAN, NetFlow, QoS,
 * tunnels and site-to-site VPN, AAA, NETCONF, archive and an EEM rollback
 * timer.
 *
 * Same contract as everything else in the kit: each change says what to capture
 * first, what proves it worked and what undoes it, and no credential is ever
 * written — keys, secrets and pre-shared keys are `<REQUIRED>`.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { description, listOf, netmask, parseCidr, wildcard, type DeviceChange } from '../device.ts';

const PLATFORM = 'cisco_ios' as const;
const SECRET = '<REQUIRED>';

export const IOS_EXTRA: readonly ChangeBlueprint[] = [
  /* ---------------------------------------------------------------- Interfaces */
  deviceBlueprint({
    id: 'ios_routed_port',
    platform: PLATFORM,
    label: 'Routed port (no switchport)',
    group: 'Interfaces',
    description: 'Turn a switch port into a routed interface with an address — the usual way to connect a router, a firewall or another layer 3 device.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'GigabitEthernet1/0/24' },
      { id: 'address', label: 'Address', control: 'text', default: '10.0.12.1/30', hint: 'A /30 or /31 on a point-to-point link' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Link to core' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 1500, min: 1500, max: 9216 },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Leave empty for the global table' },
      { id: 'ospf_process', label: 'Add to OSPF process', control: 'number', default: 0, min: 0, hint: '0 for none' },
      { id: 'ospf_area', label: 'OSPF area', control: 'text', default: '0', showWhen: { input: 'ospf_process', equals: [] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const iface = str(values, 'interface', '');
      const cidr = parseCidr(str(values, 'address', ''));
      const vrf = str(values, 'vrf', '');
      const ospf = num(values, 'ospf_process', 0);
      const findings: Finding[] = [];
      if (!cidr) findings.push(error('network.ios.bad-address', 'The address is not a valid address and prefix.', { remediation: 'Write it as 10.0.12.1/30.', source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `Routed interface ${iface}`,
        impact: 'outage',
        notes: [
          '`no switchport` drops the interface out of layer 2 and clears its switchport configuration. Whatever was passing through it stops until this is complete.',
          ...(vrf ? [`Putting the interface in VRF ${vrf} removes any address it already had. The VRF has to exist first.`] : []),
        ],
        before: [`show run interface ${iface}`, `show interfaces ${iface} status`, 'show ip interface brief'],
        config: [
          `interface ${iface}`,
          ` description ${description(str(values, 'port_description', ''), 'Routed link')}`,
          ' no switchport',
          ...(vrf ? [` vrf forwarding ${vrf}`] : []),
          ...(cidr ? [` ip address ${cidr.address} ${netmask(cidr.prefix)}`] : []),
          ...(num(values, 'mtu', 1500) !== 1500 ? [` mtu ${num(values, 'mtu', 1500)}`] : []),
          ...(ospf > 0 ? [` ip ospf ${ospf} area ${str(values, 'ospf_area', '0')}`, ' ip ospf network point-to-point'] : []),
          ' no shutdown',
          '!',
        ],
        verify: [`show ip interface brief | include ${iface}`, `show interfaces ${iface}`, ...(ospf > 0 ? ['show ip ospf neighbor'] : []), ...(cidr ? [`ping ${cidr.address}`] : [])],
        backout: [`interface ${iface}`, ' shutdown', ' default interface', '!', `interface ${iface}`, ' switchport', '!'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_loopback',
    platform: PLATFORM,
    label: 'Loopback interface',
    group: 'Interfaces',
    description: 'A loopback for the router id, management, and as the source for BGP, TACACS+, SNMP and syslog.',
    inputs: [
      { id: 'number', label: 'Loopback number', control: 'number', default: 0, min: 0, max: 2147483647 },
      { id: 'address', label: 'Address', control: 'text', default: '10.255.0.1/32' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Router id and management source' },
      { id: 'source_for', label: 'Use as the source for', control: 'select', default: 'all', options: [
        { value: 'all', label: 'Everything (SNMP, syslog, NTP, TACACS+, SSH)' },
        { value: 'logging', label: 'Syslog only' },
        { value: 'none', label: 'Nothing — just the interface' },
      ] },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'number', 0);
      const cidr = parseCidr(str(values, 'address', ''));
      const use = str(values, 'source_for', 'all');
      const findings: Finding[] = [];
      if (cidr && cidr.prefix !== 32) {
        findings.push(warning('network.ios.loopback-mask', 'A loopback is normally a /32. Anything else advertises a subnet that does not exist.', { source: 'ArchToolKit' }));
      }
      if (!cidr) findings.push(error('network.ios.bad-address', 'The loopback address is not a valid address and prefix.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `Loopback${id}`,
        impact: 'none',
        notes: ['Changing a source-interface moves where management traffic comes from. Whatever it talks to — syslog, TACACS+, SNMP — has to permit the new address.'],
        before: [`show run interface Loopback${id}`, 'show run | include source-interface'],
        config: [
          `interface Loopback${id}`,
          ` description ${description(str(values, 'port_description', ''), 'Loopback')}`,
          ...(cidr ? [` ip address ${cidr.address} ${netmask(cidr.prefix)}`] : []),
          '!',
          ...(use === 'all'
            ? [
                `ip ssh source-interface Loopback${id}`,
                `logging source-interface Loopback${id}`,
                `ntp source Loopback${id}`,
                `snmp-server source-interface traps Loopback${id}`,
                `ip tacacs source-interface Loopback${id}`,
              ]
            : use === 'logging'
              ? [`logging source-interface Loopback${id}`]
              : []),
        ],
        verify: [`show ip interface brief | include Loopback${id}`, 'show run | include source-interface', ...(cidr ? [`ping ${cidr.address}`] : [])],
        backout: [
          ...(use !== 'none' ? ['no logging source-interface'] : []),
          ...(use === 'all' ? ['no ip ssh source-interface', 'no ntp source', 'no snmp-server source-interface traps', 'no ip tacacs source-interface'] : []),
          `no interface Loopback${id}`,
        ],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------------------ Routing */
  deviceBlueprint({
    id: 'ios_vrf',
    platform: PLATFORM,
    label: 'VRF',
    group: 'Routing',
    description: 'A VRF with its route distinguisher and route targets, and the interfaces that go into it.',
    inputs: [
      { id: 'vrf_name', label: 'VRF name', control: 'text', default: 'GUEST' },
      { id: 'rd', label: 'Route distinguisher', control: 'text', default: '65000:100', hint: 'ASN:nn or address:nn' },
      { id: 'rt', label: 'Route target', control: 'text', default: '65000:100', hint: 'Imported and exported; empty for neither' },
      { id: 'interfaces', label: 'Interfaces to put in it', control: 'text', default: '', hint: 'Careful: this removes their addresses' },
      { id: 'ipv6', label: 'Include IPv6', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'vrf_name', 'VRF').toUpperCase();
      const rt = str(values, 'rt', '');
      const members = listOf(str(values, 'interfaces', ''));
      const ipv6 = bool(values, 'ipv6', false);

      return {
        platform: PLATFORM,
        title: `VRF ${name}${members.length > 0 ? ` with ${members.length} interface(s)` : ''}`,
        impact: members.length > 0 ? 'outage' : 'none',
        notes: [
          'Creating the VRF changes nothing. Moving an interface into it **removes its IP address** and drops everything that interface was carrying — re-apply the address inside the VRF afterwards.',
          'Routes in a VRF are separate. Anything the interface needs to reach must be reachable inside that VRF.',
        ],
        before: ['show vrf', ...members.map((iface) => `show run interface ${iface}`)],
        config: [
          `vrf definition ${name}`,
          ` description ${name} routing table`,
          ` rd ${str(values, 'rd', '65000:100')}`,
          ' address-family ipv4',
          ...(rt ? [`  route-target export ${rt}`, `  route-target import ${rt}`] : []),
          ' exit-address-family',
          ...(ipv6 ? [' address-family ipv6', ...(rt ? [`  route-target export ${rt}`, `  route-target import ${rt}`] : []), ' exit-address-family'] : []),
          '!',
          ...members.flatMap((iface) => [`interface ${iface}`, ` vrf forwarding ${name}`, ' ! re-apply the address here: ip address <address> <mask>', '!']),
        ],
        verify: [`show vrf ${name}`, `show ip route vrf ${name}`, ...members.map((iface) => `show run interface ${iface}`)],
        backout: [...members.flatMap((iface) => [`interface ${iface}`, ` no vrf forwarding ${name}`, '!']), `no vrf definition ${name}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_eigrp',
    platform: PLATFORM,
    label: 'EIGRP (named mode)',
    group: 'Routing',
    description: 'An EIGRP named-mode instance with authentication, passive interfaces by default and summarisation.',
    inputs: [
      { id: 'instance', label: 'Instance name', control: 'text', default: 'CAMPUS' },
      { id: 'as_number', label: 'Autonomous system', control: 'number', default: 100, min: 1, max: 65535 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.1' },
      { id: 'networks', label: 'Networks', control: 'textarea', default: '10.10.0.0/16', hint: 'One prefix per line' },
      { id: 'active', label: 'Interfaces that should form neighbours', control: 'text', default: 'GigabitEthernet1/0/24' },
      { id: 'auth', label: 'Authenticate neighbours', control: 'toggle', default: true },
      { id: 'summary', label: 'Summary to advertise', control: 'text', default: '', hint: 'Optional: a prefix to summarise outbound' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'instance', 'CAMPUS').toUpperCase();
      const asn = num(values, 'as_number', 100);
      const nets = str(values, 'networks', '')
        .split(/\n+/)
        .map((line) => parseCidr(line.trim()))
        .filter((c): c is { address: string; prefix: number } => c !== null);
      const active = listOf(str(values, 'active', ''));
      const auth = bool(values, 'auth', true);
      const summary = parseCidr(str(values, 'summary', ''));
      const findings: Finding[] = [];
      if (nets.length === 0) findings.push(error('network.ios.no-networks', 'No valid networks, so EIGRP would advertise nothing.', { source: 'ArchToolKit' }));
      if (auth) findings.push(warning('network.ios.eigrp-key', `The key chain is left as ${SECRET}. Put the real key in from your vault.`, { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `EIGRP ${name} (AS ${asn})`,
        impact: 'brief',
        notes: [
          'Named mode, not classic: it keeps the authentication and the timers with the address family rather than on each interface.',
          ...(auth ? [`Replace ${SECRET} with the key. Both ends need the same key and key id.`] : []),
          ...(summary ? ['A summary suppresses the components behind it. Make sure nothing needs them individually.'] : []),
        ],
        before: ['show ip eigrp neighbors', 'show ip protocols', 'show run | section router eigrp'],
        config: [
          ...(auth ? ['key chain EIGRP-KEYS', ' key 1', `  key-string ${SECRET}`, '  cryptographic-algorithm hmac-sha-256', '!'] : []),
          `router eigrp ${name}`,
          ' !',
          ` address-family ipv4 unicast autonomous-system ${asn}`,
          `  eigrp router-id ${str(values, 'router_id', '10.255.0.1')}`,
          ...nets.map((n) => `  network ${n.address} ${wildcard(n.prefix)}`),
          '  af-interface default',
          '   passive-interface',
          '  exit-af-interface',
          ...active.flatMap((iface) => [
            `  af-interface ${iface}`,
            '   no passive-interface',
            ...(auth ? ['   authentication mode hmac-sha-256 0 ' + SECRET] : []),
            ...(summary ? [`   summary-address ${summary.address} ${netmask(summary.prefix)}`] : []),
            '  exit-af-interface',
          ]),
          ' exit-address-family',
          '!',
        ],
        verify: ['show ip eigrp neighbors', 'show ip eigrp topology', 'show ip route eigrp', 'show ip protocols'],
        backout: [`no router eigrp ${name}`, ...(auth ? ['no key chain EIGRP-KEYS'] : [])],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_fhrp',
    platform: PLATFORM,
    label: 'First-hop redundancy (HSRP or VRRP)',
    group: 'Routing',
    description: 'HSRP or VRRP on an existing interface, with preemption, a priority that says which switch is primary, and tracking so the gateway follows the uplink.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'Vlan10' },
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'hsrp', options: [{ value: 'hsrp', label: 'HSRP' }, { value: 'vrrp', label: 'VRRP' }] },
      { id: 'group', label: 'Group', control: 'number', default: 10, min: 0, max: 255 },
      { id: 'virtual_address', label: 'Virtual address', control: 'text', default: '10.10.10.254' },
      { id: 'role', label: 'This switch is', control: 'select', default: 'primary', options: [{ value: 'primary', label: 'Primary (priority 110)' }, { value: 'secondary', label: 'Secondary (priority 100)' }] },
      { id: 'track', label: 'Track object', control: 'number', default: 0, min: 0, max: 500, hint: '0 for none; the priority drops when the tracked object goes down' },
      { id: 'auth', label: 'Authenticate', control: 'toggle', default: true },
      { id: 'version2', label: 'HSRP version 2', control: 'toggle', default: true, showWhen: { input: 'protocol', equals: ['hsrp'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const iface = str(values, 'interface', 'Vlan10');
      const hsrp = str(values, 'protocol', 'hsrp') === 'hsrp';
      const group = num(values, 'group', 10);
      const address = str(values, 'virtual_address', '');
      const priority = str(values, 'role', 'primary') === 'primary' ? 110 : 100;
      const track = num(values, 'track', 0);
      const auth = bool(values, 'auth', true);
      const keyword = hsrp ? 'standby' : 'vrrp';

      return {
        platform: PLATFORM,
        title: `${hsrp ? 'HSRP' : 'VRRP'} group ${group} on ${iface}`,
        impact: 'brief',
        notes: [
          'The partner switch takes the same group and virtual address with the other priority. Two primaries, or two different virtual addresses, and hosts lose their gateway.',
          ...(hsrp && bool(values, 'version2', true) ? ['Version 2 has to match on both ends. Mixing versions means two routers that never see each other and both go active.'] : []),
          ...(track > 0 ? [`Track object ${track} has to exist already — the IP SLA change creates one.`] : []),
          ...(auth ? [`Replace ${SECRET} with the group key.`] : []),
        ],
        before: [`show run interface ${iface}`, hsrp ? 'show standby brief' : 'show vrrp brief'],
        config: [
          `interface ${iface}`,
          ...(hsrp && bool(values, 'version2', true) ? [' standby version 2'] : []),
          ` ${keyword} ${group} ip ${address}`,
          ` ${keyword} ${group} priority ${priority}`,
          ` ${keyword} ${group} preempt${hsrp ? ' delay minimum 60' : ''}`,
          ...(auth ? [hsrp ? ` standby ${group} authentication md5 key-string ${SECRET}` : ` vrrp ${group} authentication text ${SECRET}`] : []),
          ...(track > 0 ? [` ${keyword} ${group} track ${track} decrement 20`] : []),
          ` ${keyword} ${group} name GW-${group}`,
          '!',
        ],
        verify: [hsrp ? `show standby ${iface} brief` : 'show vrrp brief', `ping ${address}`, hsrp ? 'show standby all' : 'show vrrp all'],
        backout: [`interface ${iface}`, ` no ${keyword} ${group}`, ...(hsrp && bool(values, 'version2', true) ? [' no standby version 2'] : []), '!'],
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_ipsla_track',
    platform: PLATFORM,
    label: 'IP SLA and tracked object',
    group: 'Routing',
    description: 'An IP SLA probe and the track object that follows it — what makes a floating static route or an HSRP priority react to a path that has gone away.',
    inputs: [
      { id: 'sla_id', label: 'IP SLA id', control: 'number', default: 1, min: 1, max: 2147483647 },
      { id: 'track_id', label: 'Track object id', control: 'number', default: 1, min: 1, max: 500 },
      { id: 'probe', label: 'Probe', control: 'select', default: 'icmp-echo', options: [
        { value: 'icmp-echo', label: 'ICMP echo — can the address be reached' },
        { value: 'http', label: 'HTTP GET — does the service answer' },
        { value: 'tcp-connect', label: 'TCP connect — does the port answer' },
      ] },
      { id: 'destination', label: 'Destination', control: 'text', default: '8.8.8.8' },
      { id: 'port', label: 'Port', control: 'number', default: 443, min: 1, max: 65535, showWhen: { input: 'probe', equals: ['tcp-connect'] } },
      { id: 'source', label: 'Source interface', control: 'text', default: '', hint: 'Optional, but a probe without one can take a different path than the traffic' },
      { id: 'frequency', label: 'Frequency (seconds)', control: 'number', default: 5, min: 1, max: 604800 },
      { id: 'threshold', label: 'Timeout (milliseconds)', control: 'number', default: 1000, min: 10 },
      { id: 'delay_up', label: 'Delay before up (seconds)', control: 'number', default: 30, min: 0, hint: 'Stops a flapping path from flapping the route' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const sla = num(values, 'sla_id', 1);
      const track = num(values, 'track_id', 1);
      const probe = str(values, 'probe', 'icmp-echo');
      const destination = str(values, 'destination', '');
      const source = str(values, 'source', '');
      const frequency = num(values, 'frequency', 5);

      const probeLine =
        probe === 'icmp-echo'
          ? ` icmp-echo ${destination}${source ? ` source-interface ${source}` : ''}`
          : probe === 'http'
            ? ` http get http://${destination}${source ? ` source-interface ${source}` : ''}`
            : ` tcp-connect ${destination} ${num(values, 'port', 443)}${source ? ` source-interface ${source}` : ''}`;

      return {
        platform: PLATFORM,
        title: `IP SLA ${sla} (${probe} to ${destination}) and track ${track}`,
        impact: 'none',
        notes: [
          'On its own this measures and nothing else. It only changes anything when a static route or an FHRP group tracks the object.',
          'Probe something that proves the path, not something that is always up. Pinging your own next hop tells you the cable is in, not that the internet is reachable.',
        ],
        before: [`show ip sla configuration ${sla}`, `show track ${track}`],
        config: [
          `ip sla ${sla}`,
          probeLine,
          ` frequency ${frequency}`,
          ` threshold ${num(values, 'threshold', 1000)}`,
          ` timeout ${Math.max(num(values, 'threshold', 1000), 1000)}`,
          '!',
          `ip sla schedule ${sla} life forever start-time now`,
          '!',
          `track ${track} ip sla ${sla} reachability`,
          ` delay up ${num(values, 'delay_up', 30)} down 10`,
          '!',
        ],
        verify: [`show ip sla statistics ${sla}`, `show track ${track}`, 'show ip route static'],
        backout: [`no track ${track}`, `no ip sla schedule ${sla}`, `no ip sla ${sla}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_redistribute',
    platform: PLATFORM,
    label: 'Redistribution with a route map',
    group: 'Routing',
    description: 'Redistribute between two protocols through a route map and a prefix list, so only what should cross does.',
    inputs: [
      { id: 'from_protocol', label: 'From', control: 'select', default: 'static', options: [
        { value: 'static', label: 'Static routes' },
        { value: 'connected', label: 'Connected' },
        { value: 'ospf', label: 'OSPF' },
        { value: 'eigrp', label: 'EIGRP' },
        { value: 'bgp', label: 'BGP' },
      ] },
      { id: 'from_id', label: 'From process or AS', control: 'text', default: '', hint: 'Needed for OSPF, EIGRP and BGP' },
      { id: 'into_protocol', label: 'Into', control: 'select', default: 'ospf', options: [
        { value: 'ospf', label: 'OSPF' },
        { value: 'eigrp', label: 'EIGRP' },
        { value: 'bgp', label: 'BGP' },
      ] },
      { id: 'into_id', label: 'Into process or AS', control: 'text', default: '1' },
      { id: 'prefixes', label: 'Prefixes allowed to cross', control: 'textarea', default: '10.20.0.0/16', hint: 'One per line; everything else is denied' },
      { id: 'metric', label: 'Metric', control: 'text', default: '', hint: 'Optional. EIGRP needs a full metric; OSPF takes a cost' },
      { id: 'tag', label: 'Route tag', control: 'number', default: 100, min: 0, hint: 'Tag what crosses so it can be filtered coming back' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const from = str(values, 'from_protocol', 'static');
      const fromId = str(values, 'from_id', '');
      const into = str(values, 'into_protocol', 'ospf');
      const intoId = str(values, 'into_id', '1');
      const prefixes = str(values, 'prefixes', '')
        .split(/\n+/)
        .map((line) => parseCidr(line.trim()))
        .filter((c): c is { address: string; prefix: number } => c !== null);
      const tag = num(values, 'tag', 100);
      const metric = str(values, 'metric', '');
      const findings: Finding[] = [];
      if (prefixes.length === 0) {
        findings.push(
          error('network.ios.no-redistribute-filter', 'No prefixes were listed, so the route map would deny everything — redistribution would do nothing.', {
            remediation: 'List what should cross between the protocols.',
            source: 'ArchToolKit',
          }),
        );
      }

      const listName = `PL-${from.toUpperCase()}-TO-${into.toUpperCase()}`;
      const mapName = `RM-${from.toUpperCase()}-TO-${into.toUpperCase()}`;
      const source = `${from}${fromId ? ` ${fromId}` : ''}`;

      return {
        platform: PLATFORM,
        title: `Redistribute ${source} into ${into} ${intoId}`,
        impact: 'brief',
        notes: [
          'Redistribution without a filter is how a routing loop starts. Everything here goes through the prefix list, and the route map denies what it does not name.',
          `Routes that cross are tagged ${tag}. Use that tag to stop them coming back the other way.`,
          ...(into === 'eigrp' && !metric ? ['EIGRP will not install redistributed routes without a metric. Set one, or add `default-metric` to the instance.'] : []),
        ],
        before: [`show run | section router ${into}`, 'show ip route', `show route-map ${mapName}`],
        config: [
          ...prefixes.map((p, i) => `ip prefix-list ${listName} seq ${(i + 1) * 5} permit ${p.address}/${p.prefix}`),
          '!',
          `route-map ${mapName} permit 10`,
          ` match ip address prefix-list ${listName}`,
          ...(tag > 0 ? [` set tag ${tag}`] : []),
          '!',
          `route-map ${mapName} deny 99`,
          '!',
          `router ${into} ${intoId}`,
          ` redistribute ${source}${metric ? ` metric ${metric}` : ''} route-map ${mapName}${into === 'ospf' ? ' subnets' : ''}`,
          '!',
        ],
        verify: [`show route-map ${mapName}`, `show ip route ${into === 'ospf' ? 'ospf' : into}`, 'show ip route summary', `show ip prefix-list ${listName}`],
        backout: [`router ${into} ${intoId}`, ` no redistribute ${source}`, '!', `no route-map ${mapName}`, `no ip prefix-list ${listName}`],
        findings,
      };
    },
  }),

  /* ----------------------------------------------------------------- Services */
  deviceBlueprint({
    id: 'ios_nat',
    platform: PLATFORM,
    label: 'NAT: overload and static entries',
    group: 'Services',
    description: 'PAT for a inside network behind an interface address, plus any static one-to-one entries, with the inside and outside interfaces marked.',
    inputs: [
      { id: 'inside_interfaces', label: 'Inside interfaces', control: 'text', default: 'Vlan10' },
      { id: 'outside_interface', label: 'Outside interface', control: 'text', default: 'GigabitEthernet0/0/0' },
      { id: 'inside_networks', label: 'Networks to translate', control: 'textarea', default: '10.10.10.0/24', hint: 'One per line' },
      { id: 'static_entries', label: 'Static translations', control: 'textarea', default: '', hint: 'One per line: inside-address outside-address [port]' },
      { id: 'acl_name', label: 'Access list name', control: 'text', default: 'ACL-NAT' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const inside = listOf(str(values, 'inside_interfaces', ''));
      const outside = str(values, 'outside_interface', '');
      const networks = str(values, 'inside_networks', '')
        .split(/\n+/)
        .map((line) => parseCidr(line.trim()))
        .filter((c): c is { address: string; prefix: number } => c !== null);
      const statics = str(values, 'static_entries', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2);
      const acl = str(values, 'acl_name', 'ACL-NAT').toUpperCase();
      const findings: Finding[] = [];
      if (networks.length === 0 && statics.length === 0) {
        findings.push(error('network.ios.nat-empty', 'Nothing to translate: no networks and no static entries.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `NAT behind ${outside}`,
        impact: 'brief',
        notes: [
          'Existing translations do not change until they time out. `clear ip nat translation *` forces it, and drops the sessions using them.',
          'The access list decides what is translated. Anything not matched goes out untranslated, which usually means it goes nowhere.',
        ],
        before: ['show ip nat translations | count', 'show ip nat statistics', `show run | include ip nat`],
        config: [
          ...inside.flatMap((iface) => [`interface ${iface}`, ' ip nat inside', '!']),
          `interface ${outside}`,
          ' ip nat outside',
          '!',
          ...(networks.length > 0
            ? [
                `ip access-list extended ${acl}`,
                ...networks.map((n) => ` permit ip ${n.address} ${wildcard(n.prefix)} any`),
                ' deny ip any any',
                '!',
                `ip nat inside source list ${acl} interface ${outside} overload`,
              ]
            : []),
          ...statics.map((parts) => `ip nat inside source static ${parts[0]} ${parts[1]}${parts[2] ? ` ${parts[2]}` : ''}`),
        ],
        verify: ['show ip nat statistics', 'show ip nat translations', `show run | include ip nat`],
        backout: [
          ...statics.map((parts) => `no ip nat inside source static ${parts[0]} ${parts[1]}${parts[2] ? ` ${parts[2]}` : ''}`),
          ...(networks.length > 0 ? [`no ip nat inside source list ${acl} interface ${outside} overload`, `no ip access-list extended ${acl}`] : []),
          ...inside.flatMap((iface) => [`interface ${iface}`, ' no ip nat inside', '!']),
          `interface ${outside}`,
          ' no ip nat outside',
          '!',
          'clear ip nat translation *',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_dhcp_server',
    platform: PLATFORM,
    label: 'DHCP pool',
    group: 'Services',
    description: 'A DHCP pool on the switch itself, with the excluded addresses, the gateway, DNS and lease.',
    inputs: [
      { id: 'pool_name', label: 'Pool name', control: 'text', default: 'USERS' },
      { id: 'network', label: 'Network', control: 'text', default: '10.10.10.0/24' },
      { id: 'gateway', label: 'Default gateway', control: 'text', default: '10.10.10.1' },
      { id: 'dns', label: 'DNS servers', control: 'text', default: '10.0.0.10, 10.0.0.11' },
      { id: 'domain', label: 'Domain name', control: 'text', default: 'corp.local' },
      { id: 'exclude_from', label: 'Exclude from', control: 'text', default: '10.10.10.1' },
      { id: 'exclude_to', label: 'Exclude to', control: 'text', default: '10.10.10.20', hint: 'Keep the infrastructure addresses out of the pool' },
      { id: 'lease_days', label: 'Lease (days)', control: 'number', default: 1, min: 0, max: 365 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'pool_name', 'POOL').toUpperCase();
      const network = parseCidr(str(values, 'network', ''));
      const dns = listOf(str(values, 'dns', ''));
      const from = str(values, 'exclude_from', '');
      const to = str(values, 'exclude_to', '');
      const findings: Finding[] = [];
      if (!network) findings.push(error('network.ios.bad-network', 'The pool network is not a valid prefix.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `DHCP pool ${name}`,
        impact: 'none',
        notes: [
          'Exclude the gateway, the HSRP addresses and anything static before the pool is live, or the switch will hand out an address something is already using.',
          'A switch handing out addresses is convenient and hard to see. If there is a DHCP server, use a helper address instead.',
        ],
        before: [`show run | section ip dhcp pool ${name}`, 'show ip dhcp binding', 'show ip dhcp conflict'],
        config: [
          ...(from && to ? [`ip dhcp excluded-address ${from} ${to}`] : []),
          '!',
          `ip dhcp pool ${name}`,
          ...(network ? [` network ${network.address} ${netmask(network.prefix)}`] : []),
          ` default-router ${str(values, 'gateway', '')}`,
          ...(dns.length > 0 ? [` dns-server ${dns.join(' ')}`] : []),
          ` domain-name ${str(values, 'domain', 'corp.local')}`,
          ` lease ${num(values, 'lease_days', 1)}`,
          '!',
        ],
        verify: ['show ip dhcp binding', 'show ip dhcp pool ' + name, 'show ip dhcp conflict'],
        backout: [`no ip dhcp pool ${name}`, ...(from && to ? [`no ip dhcp excluded-address ${from} ${to}`] : [])],
        findings,
      };
    },
  }),

  /* ----------------------------------------------------------------- Security */
  deviceBlueprint({
    id: 'ios_edge_protection',
    platform: PLATFORM,
    label: 'DHCP snooping, ARP inspection, source guard',
    group: 'Security',
    description: 'The three edge protections that stop a rogue DHCP server, ARP poisoning and address spoofing, with the uplinks trusted.',
    inputs: [
      { id: 'vlans', label: 'VLANs to protect', control: 'text', default: '10,20', hint: 'A list or ranges' },
      { id: 'trusted', label: 'Trusted interfaces', control: 'text', default: 'GigabitEthernet1/0/48', hint: 'Uplinks towards the real DHCP server — everything else is untrusted' },
      { id: 'rate_limit', label: 'DHCP packets per second on untrusted ports', control: 'number', default: 15, min: 0, max: 2048, hint: '0 for no limit' },
      { id: 'arp_inspection', label: 'Dynamic ARP inspection', control: 'toggle', default: true },
      { id: 'source_guard', label: 'IP source guard on access ports', control: 'toggle', default: false, hint: 'Strict: a port may only use the address DHCP gave it' },
      { id: 'access_ports', label: 'Access ports for source guard', control: 'text', default: '', showWhen: { input: 'source_guard', equals: ['true'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vlans = str(values, 'vlans', '10');
      const trusted = listOf(str(values, 'trusted', ''));
      const rate = num(values, 'rate_limit', 15);
      const arp = bool(values, 'arp_inspection', true);
      const guard = bool(values, 'source_guard', false);
      const access = listOf(str(values, 'access_ports', ''));
      const findings: Finding[] = [];
      if (trusted.length === 0) {
        findings.push(
          error('network.ios.no-trusted-uplink', 'No trusted interface. With snooping on and nothing trusted, the switch will drop the offers from your real DHCP server and nothing will get an address.', {
            remediation: 'Trust the uplinks that face the DHCP server.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (guard) {
        findings.push(
          warning('network.ios.source-guard', 'IP source guard drops traffic from any address the switch has no binding for — including anything statically addressed.', {
            remediation: 'Add static bindings for the devices that do not use DHCP before enabling it.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Edge protection on VLANs ${vlans}`,
        impact: 'outage',
        notes: [
          'Order matters: trust the uplinks in the same change as enabling snooping, not after. Between the two, DHCP stops working.',
          ...(arp ? ['ARP inspection uses the snooping bindings. A device with a static address needs an ARP ACL or it will be dropped.'] : []),
        ],
        before: ['show ip dhcp snooping', 'show ip dhcp snooping binding', ...(arp ? ['show ip arp inspection'] : [])],
        config: [
          'ip dhcp snooping',
          `ip dhcp snooping vlan ${vlans}`,
          'no ip dhcp snooping information option',
          ...(arp ? [`ip arp inspection vlan ${vlans}`, 'ip arp inspection validate src-mac dst-mac ip'] : []),
          '!',
          ...trusted.flatMap((iface) => [
            `interface ${iface}`,
            ' ip dhcp snooping trust',
            ...(arp ? [' ip arp inspection trust'] : []),
            '!',
          ]),
          ...(rate > 0 && access.length > 0
            ? access.flatMap((iface) => [`interface ${iface}`, ` ip dhcp snooping limit rate ${rate}`, ...(guard ? [' ip verify source'] : []), '!'])
            : []),
          ...(guard && access.length === 0 ? ['! IP source guard needs the access ports listed to apply `ip verify source`.'] : []),
          'errdisable recovery cause dhcp-rate-limit',
          ...(arp ? ['errdisable recovery cause arp-inspection'] : []),
          'errdisable recovery interval 300',
        ],
        verify: ['show ip dhcp snooping', 'show ip dhcp snooping binding', ...(arp ? ['show ip arp inspection', 'show ip arp inspection statistics'] : []), ...(guard ? ['show ip verify source'] : [])],
        backout: [
          ...(guard ? access.flatMap((iface) => [`interface ${iface}`, ' no ip verify source', '!']) : []),
          ...(arp ? [`no ip arp inspection vlan ${vlans}`] : []),
          `no ip dhcp snooping vlan ${vlans}`,
          'no ip dhcp snooping',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_dot1x',
    platform: PLATFORM,
    label: '802.1X and MAB port authentication',
    group: 'Security',
    description: 'RADIUS servers, the global 802.1X configuration, and ports set to authenticate with MAC authentication bypass behind it.',
    inputs: [
      { id: 'radius_servers', label: 'RADIUS servers', control: 'text', default: '10.0.0.30, 10.0.0.31', hint: 'ISE or NPS' },
      { id: 'ports', label: 'Ports to authenticate', control: 'text', default: 'GigabitEthernet1/0/1-4' },
      { id: 'host_mode', label: 'Host mode', control: 'select', default: 'multi-domain', options: [
        { value: 'multi-domain', label: 'Multi-domain — one data device and one phone' },
        { value: 'single-host', label: 'Single host' },
        { value: 'multi-auth', label: 'Multi-auth — every device authenticates' },
      ] },
      { id: 'mode', label: 'Enforcement', control: 'select', default: 'monitor', options: [
        { value: 'monitor', label: 'Monitor mode — authenticate, but let everything through' },
        { value: 'low-impact', label: 'Low impact — a pre-auth ACL, then the full policy' },
        { value: 'closed', label: 'Closed — nothing passes until it authenticates' },
      ] },
      { id: 'mab', label: 'MAC authentication bypass', control: 'toggle', default: true, hint: 'For printers and anything without a supplicant' },
      { id: 'critical_vlan', label: 'Critical VLAN', control: 'number', default: 0, min: 0, max: 4094, hint: 'Where ports land when RADIUS is unreachable; 0 for none' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const servers = listOf(str(values, 'radius_servers', ''));
      const ports = listOf(str(values, 'ports', ''));
      const mode = str(values, 'mode', 'monitor');
      const mab = bool(values, 'mab', true);
      const critical = num(values, 'critical_vlan', 0);
      const findings: Finding[] = [];
      if (mode === 'closed') {
        findings.push(
          warning('network.ios.dot1x-closed', 'Closed mode from the start will lock out anything that cannot authenticate — printers, cameras, badge readers, the lot.', {
            remediation: 'Run monitor mode first and read the authentication sessions for a week.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (critical === 0) {
        findings.push(
          warning('network.ios.no-critical-vlan', 'With no critical VLAN, a RADIUS outage means no new device can get onto the network at all.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `802.1X on ${ports.length} port(s), ${mode} mode`,
        impact: mode === 'closed' ? 'outage' : 'brief',
        notes: [
          `Replace every ${SECRET} with the RADIUS shared secret from your vault.`,
          'Monitor mode authenticates and logs but lets everything through, which is how this is rolled out without an incident.',
          'The switch must be added to RADIUS as a network device with the same shared secret first, or every port fails authentication.',
        ],
        before: ['show authentication sessions', 'show aaa servers', 'show run | section dot1x'],
        config: [
          'aaa new-model',
          ...servers.map((server, i) => [`radius server RADIUS-${i + 1}`, ` address ipv4 ${server} auth-port 1812 acct-port 1813`, ` key ${SECRET}`, ' automate-tester username probe-user ignore-acct-port', '!'].join('\n')),
          'aaa group server radius ISE',
          ...servers.map((_, i) => ` server name RADIUS-${i + 1}`),
          ' deadtime 5',
          '!',
          'aaa authentication dot1x default group ISE',
          'aaa authorization network default group ISE',
          'aaa accounting dot1x default start-stop group ISE',
          'aaa server radius dynamic-author',
          ...servers.map((server) => ` client ${server} server-key ${SECRET}`),
          '!',
          'radius-server attribute 6 on-for-login-auth',
          'radius-server attribute 8 include-in-access-req',
          'radius-server attribute 25 access-request include',
          'radius-server dead-criteria time 10 tries 3',
          '!',
          'dot1x system-auth-control',
          'dot1x critical eapol',
          ...(critical > 0 ? [`authentication critical recovery delay 1000`] : []),
          '!',
          ...ports.flatMap((port) => [
            `interface ${port}`,
            ' authentication periodic',
            ' authentication timer reauthenticate server',
            ` authentication host-mode ${str(values, 'host_mode', 'multi-domain')}`,
            ` authentication port-control ${mode === 'closed' ? 'auto' : 'auto'}`,
            ...(mode === 'monitor' ? [' authentication open'] : []),
            ' authentication order dot1x mab',
            ' authentication priority dot1x mab',
            ...(mab ? [' mab'] : []),
            ' dot1x pae authenticator',
            ' dot1x timeout tx-period 7',
            ...(critical > 0 ? [` authentication event server dead action authorize vlan ${critical}`, ' authentication event server alive action reinitialize'] : []),
            '!',
          ]),
        ],
        verify: ['show authentication sessions', `show authentication sessions interface ${ports[0] ?? 'Gi1/0/1'} details`, 'show aaa servers | include RADIUS|state', 'show dot1x all summary'],
        backout: [
          ...ports.flatMap((port) => [`interface ${port}`, ' no authentication port-control auto', ' no dot1x pae authenticator', ' no mab', ' no authentication open', '!']),
          'no dot1x system-auth-control',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_aaa_tacacs',
    platform: PLATFORM,
    label: 'AAA with TACACS+',
    group: 'Baseline',
    description: 'Administrative login through TACACS+ with a local fallback, privilege from the server, and command accounting.',
    inputs: [
      { id: 'servers', label: 'TACACS+ servers', control: 'text', default: '10.0.0.30, 10.0.0.31' },
      { id: 'source_interface', label: 'Source interface', control: 'text', default: 'Loopback0' },
      { id: 'local_user', label: 'Local fallback username', control: 'text', default: 'netadmin', hint: 'The account that works when TACACS+ does not' },
      { id: 'command_accounting', label: 'Account for commands', control: 'toggle', default: true, hint: 'Logs every configuration command to the server' },
      { id: 'authorize_commands', label: 'Authorise commands', control: 'toggle', default: false, hint: 'The server decides which commands are allowed — powerful and easy to lock yourself out with' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const servers = listOf(str(values, 'servers', ''));
      const source = str(values, 'source_interface', '');
      const user = str(values, 'local_user', 'netadmin');
      const authorize = bool(values, 'authorize_commands', false);
      const findings: Finding[] = [];
      if (authorize) {
        findings.push(
          warning('network.ios.command-authorization', 'Command authorisation will lock you out of everything the server does not explicitly allow, including on the console.', {
            remediation: 'Test it from a second session before you close the first, and keep the local fallback working.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: 'AAA through TACACS+ with a local fallback',
        impact: 'brief',
        notes: [
          `Replace every ${SECRET}: the TACACS+ key and the local account's secret. Neither is generated here.`,
          'Keep a second session open while you apply this. If the key is wrong, the next login fails and only the local account gets you back in.',
          'The local fallback only works when the server is unreachable — a rejection from a reachable server is still a rejection.',
        ],
        before: ['show run | section aaa', 'show tacacs', 'show users'],
        config: [
          'aaa new-model',
          `username ${user} privilege 15 algorithm-type sha256 secret ${SECRET}`,
          '!',
          ...servers.map((server, i) => [`tacacs server TACACS-${i + 1}`, ` address ipv4 ${server}`, ` key ${SECRET}`, ' timeout 3', '!'].join('\n')),
          'aaa group server tacacs+ TACACS-GROUP',
          ...servers.map((_, i) => ` server name TACACS-${i + 1}`),
          ...(source ? [` ip tacacs source-interface ${source}`] : []),
          '!',
          'aaa authentication login default group TACACS-GROUP local',
          'aaa authentication enable default group TACACS-GROUP enable',
          'aaa authorization exec default group TACACS-GROUP local if-authenticated',
          ...(authorize ? ['aaa authorization commands 15 default group TACACS-GROUP local if-authenticated'] : []),
          ...(bool(values, 'command_accounting', true) ? ['aaa accounting commands 15 default start-stop group TACACS-GROUP', 'aaa accounting exec default start-stop group TACACS-GROUP'] : []),
          'aaa session-id common',
          '!',
        ],
        verify: ['show tacacs', 'show aaa servers | include TACACS|state', 'show run | section aaa', 'Open a second session and log in before closing this one.'],
        backout: ['no aaa authentication login default', 'no aaa authorization exec default', ...(authorize ? ['no aaa authorization commands 15 default'] : []), 'no aaa new-model'],
        findings,
      };
    },
  }),

  /* --------------------------------------------------------------- Operations */
  deviceBlueprint({
    id: 'ios_span',
    platform: PLATFORM,
    label: 'SPAN / RSPAN session',
    group: 'Operations',
    description: 'Mirror traffic from ports or a VLAN to a destination port, locally or across a remote SPAN VLAN.',
    inputs: [
      { id: 'session', label: 'Session number', control: 'number', default: 1, min: 1, max: 66 },
      { id: 'kind', label: 'Kind', control: 'select', default: 'local', options: [{ value: 'local', label: 'Local SPAN' }, { value: 'rspan-source', label: 'RSPAN source' }, { value: 'rspan-destination', label: 'RSPAN destination' }] },
      { id: 'source', label: 'Source interfaces or VLAN', control: 'text', default: 'GigabitEthernet1/0/1', hint: 'Interfaces, or "vlan 10"' },
      { id: 'direction', label: 'Direction', control: 'select', default: 'both', options: [{ value: 'both', label: 'Both' }, { value: 'rx', label: 'Received only' }, { value: 'tx', label: 'Transmitted only' }] },
      { id: 'destination', label: 'Destination interface', control: 'text', default: 'GigabitEthernet1/0/47' },
      { id: 'rspan_vlan', label: 'RSPAN VLAN', control: 'number', default: 999, min: 2, max: 4094, showWhen: { input: 'kind', equals: ['rspan-source', 'rspan-destination'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const session = num(values, 'session', 1);
      const kind = str(values, 'kind', 'local');
      const source = str(values, 'source', '');
      const direction = str(values, 'direction', 'both');
      const destination = str(values, 'destination', '');
      const rspanVlan = num(values, 'rspan_vlan', 999);
      const isVlanSource = /^vlan\s/i.test(source);

      return {
        platform: PLATFORM,
        title: `${kind === 'local' ? 'SPAN' : 'RSPAN'} session ${session}`,
        impact: 'brief',
        notes: [
          'A destination port stops being a normal port: it carries only mirrored traffic and drops anything plugged into it. Never use an uplink.',
          'Mirroring a busy VLAN to a slower port drops frames silently — the capture will be incomplete and look like packet loss.',
          'Take the session out when the capture is done. A forgotten SPAN session is a port nobody can use.',
        ],
        before: ['show monitor session all', `show run interface ${destination}`],
        config: [
          ...(kind !== 'local' ? [`vlan ${rspanVlan}`, ' name RSPAN', ' remote-span', '!'] : []),
          ...(kind === 'rspan-destination'
            ? [`monitor session ${session} source remote vlan ${rspanVlan}`, `monitor session ${session} destination interface ${destination}`]
            : [
                `monitor session ${session} source ${isVlanSource ? source.toLowerCase() : `interface ${source}`}${direction !== 'both' ? ` ${direction}` : ''}`,
                kind === 'rspan-source' ? `monitor session ${session} destination remote vlan ${rspanVlan}` : `monitor session ${session} destination interface ${destination}`,
              ]),
        ],
        verify: ['show monitor session ' + session, 'show monitor session all'],
        backout: [`no monitor session ${session}`, ...(kind !== 'local' ? [`no vlan ${rspanVlan}`] : [])],
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_netflow',
    platform: PLATFORM,
    label: 'Flexible NetFlow export',
    group: 'Operations',
    description: 'A flow record, an exporter and a monitor applied to interfaces — what feeds a collector like Splunk, SolarWinds or Stealthwatch.',
    inputs: [
      { id: 'collector', label: 'Collector address', control: 'text', default: '10.0.0.40' },
      { id: 'port', label: 'Collector port', control: 'number', default: 2055, min: 1, max: 65535, hint: '2055 for NetFlow v9, 4739 for IPFIX' },
      { id: 'source_interface', label: 'Source interface', control: 'text', default: 'Loopback0' },
      { id: 'interfaces', label: 'Interfaces to monitor', control: 'text', default: 'GigabitEthernet1/0/48' },
      { id: 'direction', label: 'Direction', control: 'select', default: 'input', options: [{ value: 'input', label: 'Input' }, { value: 'output', label: 'Output' }, { value: 'both', label: 'Both' }] },
      { id: 'version', label: 'Export version', control: 'select', default: 'netflow-v9', options: [{ value: 'netflow-v9', label: 'NetFlow v9' }, { value: 'ipfix', label: 'IPFIX' }] },
      { id: 'active_timeout', label: 'Active timeout (seconds)', control: 'number', default: 60, min: 1, max: 604800 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const collector = str(values, 'collector', '');
      const interfaces = listOf(str(values, 'interfaces', ''));
      const direction = str(values, 'direction', 'input');
      const directions = direction === 'both' ? ['input', 'output'] : [direction];

      return {
        platform: PLATFORM,
        title: `NetFlow export to ${collector}`,
        impact: 'none',
        notes: [
          'Flow export costs CPU on a switch that does it in software. Watch the CPU after applying it to a busy interface.',
          'Export both directions only if the collector needs it — it roughly doubles the records.',
        ],
        before: ['show flow monitor', 'show flow exporter statistics', 'show processes cpu sorted | include CPU'],
        config: [
          'flow record ATK-RECORD',
          ' description Generated by ArchToolKit',
          ' match ipv4 tos',
          ' match ipv4 protocol',
          ' match ipv4 source address',
          ' match ipv4 destination address',
          ' match transport source-port',
          ' match transport destination-port',
          ' match interface input',
          ' collect interface output',
          ' collect counter bytes long',
          ' collect counter packets long',
          ' collect timestamp absolute first',
          ' collect timestamp absolute last',
          '!',
          'flow exporter ATK-EXPORT',
          ` destination ${collector}`,
          ...(str(values, 'source_interface', '') ? [` source ${str(values, 'source_interface', '')}`] : []),
          ' transport udp ' + num(values, 'port', 2055),
          ` export-protocol ${str(values, 'version', 'netflow-v9')}`,
          ' template data timeout 60',
          '!',
          'flow monitor ATK-MONITOR',
          ' exporter ATK-EXPORT',
          ' record ATK-RECORD',
          ` cache timeout active ${num(values, 'active_timeout', 60)}`,
          ' cache timeout inactive 15',
          '!',
          ...interfaces.flatMap((iface) => [`interface ${iface}`, ...directions.map((d) => ` ip flow monitor ATK-MONITOR ${d}`), '!']),
        ],
        verify: ['show flow monitor ATK-MONITOR cache', 'show flow exporter ATK-EXPORT statistics', 'show processes cpu sorted | include CPU'],
        backout: [
          ...interfaces.flatMap((iface) => [`interface ${iface}`, ...directions.map((d) => ` no ip flow monitor ATK-MONITOR ${d}`), '!']),
          'no flow monitor ATK-MONITOR',
          'no flow exporter ATK-EXPORT',
          'no flow record ATK-RECORD',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_qos_voice',
    platform: PLATFORM,
    label: 'QoS: priority queue for voice',
    group: 'Operations',
    description: 'Class maps by DSCP, a policy with low-latency queueing for voice and a bandwidth share for signalling and video, applied outbound.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'GigabitEthernet0/0/0', hint: 'Usually the WAN or uplink side' },
      { id: 'voice_percent', label: 'Voice (priority) %', control: 'number', default: 10, min: 1, max: 80 },
      { id: 'video_percent', label: 'Video %', control: 'number', default: 20, min: 0, max: 80 },
      { id: 'signalling_percent', label: 'Signalling %', control: 'number', default: 5, min: 0, max: 20 },
      { id: 'trust_edge', label: 'Trust DSCP on these access ports', control: 'text', default: '', hint: 'Optional: where phones connect' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const interfaces = listOf(str(values, 'interfaces', ''));
      const voice = num(values, 'voice_percent', 10);
      const video = num(values, 'video_percent', 20);
      const signalling = num(values, 'signalling_percent', 5);
      const edge = listOf(str(values, 'trust_edge', ''));
      const findings: Finding[] = [];
      if (voice + video + signalling > 85) {
        findings.push(
          warning('network.ios.qos-oversubscribed', `Voice, video and signalling add up to ${voice + video + signalling}%, leaving little for everything else.`, {
            remediation: 'Priority queueing above about a third of the link starves normal traffic.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: 'QoS: priority queue for voice',
        impact: 'brief',
        notes: [
          'QoS only does something when the link is congested. On an uncongested link this changes nothing you can measure.',
          'Marking has to be trusted end to end. If the far end re-marks, the priority queue here protects nothing.',
          'Applying a policy replaces whatever policy is on the interface. Capture the current one first.',
        ],
        before: [...interfaces.map((iface) => `show policy-map interface ${iface}`), 'show run | section policy-map'],
        config: [
          'class-map match-any VOICE',
          ' match dscp ef',
          '!',
          'class-map match-any VIDEO',
          ' match dscp af41 af42 af43',
          ' match dscp cs4',
          '!',
          'class-map match-any SIGNALLING',
          ' match dscp cs3 af31',
          '!',
          'policy-map WAN-OUT',
          ' class VOICE',
          `  priority percent ${voice}`,
          '  set dscp ef',
          ...(video > 0 ? [' class VIDEO', `  bandwidth percent ${video}`, '  random-detect dscp-based'] : []),
          ...(signalling > 0 ? [' class SIGNALLING', `  bandwidth percent ${signalling}`] : []),
          ' class class-default',
          '  fair-queue',
          '  random-detect',
          '!',
          ...interfaces.flatMap((iface) => [`interface ${iface}`, ' service-policy output WAN-OUT', '!']),
          ...edge.flatMap((iface) => [`interface ${iface}`, ' auto qos voip cisco-phone', '!']),
        ],
        verify: [...interfaces.map((iface) => `show policy-map interface ${iface}`), 'show policy-map WAN-OUT', 'show mls qos interface'],
        backout: [
          ...interfaces.flatMap((iface) => [`interface ${iface}`, ' no service-policy output WAN-OUT', '!']),
          'no policy-map WAN-OUT',
          'no class-map match-any VOICE',
          'no class-map match-any VIDEO',
          'no class-map match-any SIGNALLING',
        ],
        findings,
      };
    },
  }),

  /* -------------------------------------------------------------- WAN and VPN */
  deviceBlueprint({
    id: 'ios_gre_tunnel',
    platform: PLATFORM,
    label: 'GRE tunnel',
    group: 'WAN and VPN',
    description: 'A point-to-point GRE tunnel with the MTU and MSS set so nothing fragments, and a keepalive so it goes down when it should.',
    inputs: [
      { id: 'number', label: 'Tunnel number', control: 'number', default: 0, min: 0, max: 2147483647 },
      { id: 'address', label: 'Tunnel address', control: 'text', default: '10.254.0.1/30' },
      { id: 'source', label: 'Tunnel source', control: 'text', default: 'GigabitEthernet0/0/0', hint: 'An interface or an address' },
      { id: 'destination', label: 'Tunnel destination', control: 'text', default: '203.0.113.2' },
      { id: 'protected', label: 'Protect with IPsec profile', control: 'text', default: '', hint: 'The profile name from the VPN change; empty for plain GRE' },
      { id: 'keepalive', label: 'Keepalive (seconds)', control: 'number', default: 10, min: 0, max: 3600, hint: '0 for none — but then the tunnel stays up even when the far end is gone' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'number', 0);
      const cidr = parseCidr(str(values, 'address', ''));
      const source = str(values, 'source', '');
      const destination = str(values, 'destination', '');
      const profile = str(values, 'protected', '');
      const keepalive = num(values, 'keepalive', 10);
      const findings: Finding[] = [];
      if (!cidr) findings.push(error('network.ios.bad-address', 'The tunnel address is not a valid address and prefix.', { source: 'ArchToolKit' }));
      if (profile && keepalive > 0) {
        findings.push(
          warning('network.ios.gre-keepalive-ipsec', 'GRE keepalives do not work through an IPsec-protected tunnel. Use a routing protocol or IP SLA to detect failure instead.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `GRE tunnel ${id} to ${destination}`,
        impact: 'brief',
        notes: [
          'GRE adds 24 bytes. The MTU and the TCP MSS are set here so packets do not fragment — the usual symptom of getting this wrong is that small things work and large ones hang.',
          'Both ends need the mirror image: source and destination swapped, same tunnel subnet.',
        ],
        before: [`show run interface Tunnel${id}`, 'show ip interface brief | include Tunnel', `ping ${destination}`],
        config: [
          `interface Tunnel${id}`,
          ` description GRE to ${destination}`,
          ...(cidr ? [` ip address ${cidr.address} ${netmask(cidr.prefix)}`] : []),
          ' ip mtu 1400',
          ' ip tcp adjust-mss 1360',
          ` tunnel source ${source}`,
          ` tunnel destination ${destination}`,
          ' tunnel mode gre ip',
          ...(keepalive > 0 && !profile ? [` keepalive ${keepalive} 3`] : []),
          ...(profile ? [` tunnel protection ipsec profile ${profile}`] : []),
          ' no shutdown',
          '!',
        ],
        verify: [`show interfaces Tunnel${id}`, `ping ${cidr ? cidr.address.replace(/\.\d+$/, '.2') : destination}`, ...(profile ? ['show crypto ipsec sa', 'show crypto ikev2 sa'] : [])],
        backout: [`no interface Tunnel${id}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_ipsec_vpn',
    platform: PLATFORM,
    label: 'Site-to-site VPN (IKEv2)',
    group: 'WAN and VPN',
    description: 'An IKEv2 proposal, policy, keyring and profile with a transform set and an IPsec profile — the crypto half of a route-based VPN.',
    inputs: [
      { id: 'peer', label: 'Peer address', control: 'text', default: '203.0.113.2' },
      { id: 'local_id', label: 'Local identity', control: 'text', default: '203.0.113.1', hint: 'Usually the public address of this device' },
      { id: 'profile_name', label: 'Profile name', control: 'text', default: 'VPN-PROFILE' },
      { id: 'encryption', label: 'Encryption', control: 'select', default: 'aes-gcm-256', options: [
        { value: 'aes-gcm-256', label: 'AES-GCM-256 (preferred)' },
        { value: 'aes-cbc-256', label: 'AES-CBC-256 with SHA-256' },
      ] },
      { id: 'dh_group', label: 'Diffie-Hellman group', control: 'select', default: '20', options: [
        { value: '20', label: 'Group 20 (ECP-384)' },
        { value: '19', label: 'Group 19 (ECP-256)' },
        { value: '14', label: 'Group 14 (MODP-2048)' },
      ] },
      { id: 'lifetime', label: 'IPsec lifetime (seconds)', control: 'number', default: 3600, min: 120, max: 86400 },
      { id: 'dpd', label: 'Dead peer detection (seconds)', control: 'number', default: 10, min: 0, max: 3600 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const peer = str(values, 'peer', '');
      const profile = str(values, 'profile_name', 'VPN-PROFILE').toUpperCase();
      const gcm = str(values, 'encryption', 'aes-gcm-256') === 'aes-gcm-256';
      const dh = str(values, 'dh_group', '20');
      const dpd = num(values, 'dpd', 10);

      return {
        platform: PLATFORM,
        title: `IKEv2 site-to-site VPN to ${peer}`,
        impact: 'brief',
        notes: [
          `The pre-shared keys are ${SECRET}. Put the real key in from your vault — it is the one thing that must never be committed anywhere.`,
          'Both ends must agree on the proposal, the group and the lifetimes. A mismatch shows as a tunnel that negotiates and immediately drops.',
          'This is the crypto only. Apply the profile to a tunnel interface (the GRE change takes a profile name), or the VPN protects nothing.',
          ...(dpd === 0 ? ['Without dead peer detection, a peer that disappears leaves a tunnel that looks up and passes nothing.'] : []),
        ],
        before: ['show crypto ikev2 sa', 'show crypto ipsec sa', 'show run | section crypto'],
        config: [
          'crypto ikev2 proposal ATK-PROPOSAL',
          gcm ? ' encryption aes-gcm-256' : ' encryption aes-cbc-256',
          ...(gcm ? [] : [' integrity sha256']),
          ' prf sha256',
          ` group ${dh}`,
          '!',
          'crypto ikev2 policy ATK-POLICY',
          ' proposal ATK-PROPOSAL',
          '!',
          'crypto ikev2 keyring ATK-KEYRING',
          ` peer ${peer}`,
          `  address ${peer}`,
          `  pre-shared-key local ${SECRET}`,
          `  pre-shared-key remote ${SECRET}`,
          '!',
          `crypto ikev2 profile ${profile}`,
          ` match identity remote address ${peer} 255.255.255.255`,
          ` identity local address ${str(values, 'local_id', '')}`,
          ' authentication local pre-share',
          ' authentication remote pre-share',
          ' keyring local ATK-KEYRING',
          ...(dpd > 0 ? [` dpd ${dpd} 3 periodic`] : []),
          '!',
          `crypto ipsec transform-set ATK-TS ${gcm ? 'esp-gcm 256' : 'esp-aes 256 esp-sha256-hmac'}`,
          ' mode tunnel',
          '!',
          `crypto ipsec profile ${profile}`,
          ' set transform-set ATK-TS',
          ` set ikev2-profile ${profile}`,
          ` set security-association lifetime seconds ${num(values, 'lifetime', 3600)}`,
          ' set pfs group' + dh,
          '!',
        ],
        verify: ['show crypto ikev2 sa detailed', 'show crypto ipsec sa peer ' + peer, 'show crypto session', 'show crypto ikev2 statistics'],
        backout: [
          `no crypto ipsec profile ${profile}`,
          'no crypto ipsec transform-set ATK-TS',
          `no crypto ikev2 profile ${profile}`,
          'no crypto ikev2 keyring ATK-KEYRING',
          'no crypto ikev2 policy ATK-POLICY',
          'no crypto ikev2 proposal ATK-PROPOSAL',
        ],
      };
    },
  }),

  /* --------------------------------------------------- Automation and safety */
  deviceBlueprint({
    id: 'ios_netconf',
    platform: PLATFORM,
    label: 'NETCONF and RESTCONF (IOS-XE)',
    group: 'Baseline',
    description: 'Turn on the programmatic interfaces Ansible, Terraform and a controller use, restricted to the management network.',
    inputs: [
      { id: 'netconf', label: 'NETCONF (port 830)', control: 'toggle', default: true },
      { id: 'restconf', label: 'RESTCONF (HTTPS)', control: 'toggle', default: false },
      { id: 'management_acl', label: 'Management source prefix', control: 'text', default: '10.0.0.0/24' },
      { id: 'user', label: 'Automation username', control: 'text', default: 'automation', hint: 'Privilege 15; its secret is not written here' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const netconf = bool(values, 'netconf', true);
      const restconf = bool(values, 'restconf', false);
      const mgmt = parseCidr(str(values, 'management_acl', ''));
      const user = str(values, 'user', 'automation');
      const findings: Finding[] = [];
      if (!mgmt) {
        findings.push(
          warning('network.ios.netconf-unrestricted', 'Without a management prefix, NETCONF and RESTCONF answer anything that can reach the device.', {
            remediation: 'Restrict them to the management network with a control-plane access list.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (restconf) {
        findings.push(
          warning('network.ios.restconf-http', 'RESTCONF needs the HTTPS server enabled. Make sure the HTTP server stays off — it is enabled by the same command family.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `${[netconf ? 'NETCONF' : '', restconf ? 'RESTCONF' : ''].filter(Boolean).join(' and ') || 'Programmatic access'} for automation`,
        impact: 'none',
        notes: [
          'IOS-XE only. Classic IOS has neither.',
          `Create the ${user} account with its own secret from your vault: this change does not write one.`,
          'The first NETCONF connection can take a minute while the YANG models load.',
        ],
        before: ['show platform software yang-management process', 'show run | include netconf|restconf|ip http'],
        config: [
          'aaa new-model',
          'aaa authorization exec default local',
          `username ${user} privilege 15 algorithm-type sha256 secret ${SECRET}`,
          '!',
          ...(netconf ? ['netconf-yang', 'netconf-yang feature candidate-datastore'] : []),
          ...(restconf ? ['ip http secure-server', 'no ip http server', 'restconf'] : ['no ip http server', 'no ip http secure-server']),
          '!',
          ...(mgmt
            ? [
                'ip access-list standard ACL-AUTOMATION',
                ` permit ${mgmt.address} ${wildcard(mgmt.prefix)}`,
                ' deny any log',
                '!',
                ...(restconf ? ['ip http access-class ipv4 ACL-AUTOMATION'] : []),
              ]
            : []),
        ],
        verify: [
          'show platform software yang-management process',
          ...(netconf ? ['ssh -p 830 <user>@<device> -s netconf   (from the control node)'] : []),
          ...(restconf ? ['curl -k https://<device>/restconf/data/Cisco-IOS-XE-native:native/hostname -u <user>'] : []),
        ],
        backout: [...(netconf ? ['no netconf-yang'] : []), ...(restconf ? ['no restconf', 'no ip http secure-server'] : []), ...(mgmt ? ['no ip access-list standard ACL-AUTOMATION'] : [])],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_archive_rollback',
    platform: PLATFORM,
    label: 'Config archive and an EEM rollback timer',
    group: 'Baseline',
    description: 'Keep every configuration change in an archive, log who changed what, and arm an EEM applet that rolls the device back if nobody confirms the change.',
    inputs: [
      { id: 'archive_path', label: 'Archive path', control: 'text', default: 'flash:/archive/$h-config', hint: '$h is the hostname; a URL such as scp://user@host/ also works' },
      { id: 'maximum', label: 'Versions to keep', control: 'number', default: 10, min: 1, max: 14 },
      { id: 'time_period', label: 'Also archive every (minutes)', control: 'number', default: 1440, min: 0, hint: '0 for on-change only' },
      { id: 'rollback_minutes', label: 'Rollback timer (minutes)', control: 'number', default: 10, min: 0, max: 120, hint: 'The safety net for a remote change; 0 for none' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const path = str(values, 'archive_path', 'flash:/archive/$h-config');
      const minutes = num(values, 'rollback_minutes', 10);

      return {
        platform: PLATFORM,
        title: `Config archive${minutes > 0 ? ` and a ${minutes}-minute rollback timer` : ''}`,
        impact: 'none',
        notes: [
          'The archive is what makes `configure replace` possible — the only real undo a router has.',
          ...(minutes > 0
            ? [
                `Arm the timer immediately before a risky change: \`event manager run ROLLBACK-TIMER\`. If you can still reach the device, cancel it with \`event manager run CANCEL-ROLLBACK\`. If you cannot, the device restores the saved configuration by itself in ${minutes} minutes.`,
                'Test the applet on something that does not matter first. An applet that fires when it should not is its own outage.',
              ]
            : []),
        ],
        before: ['show archive', 'show run | section archive', 'show event manager policy registered'],
        config: [
          'archive',
          ` path ${path}`,
          ` maximum ${num(values, 'maximum', 10)}`,
          ...(num(values, 'time_period', 1440) > 0 ? [` time-period ${num(values, 'time_period', 1440)}`] : []),
          ' write-memory',
          ' log config',
          '  logging enable',
          '  logging size 500',
          '  hidekeys',
          '  notify syslog contenttype plaintext',
          '!',
          ...(minutes > 0
            ? [
                'event manager applet ROLLBACK-TIMER',
                ' event none maxrun 60',
                ' action 1.0 cli command "enable"',
                ' action 1.1 cli command "configure replace flash:rollback-safe.cfg force time ' + minutes + '"',
                ' action 2.0 syslog msg "ArchToolKit: rollback armed for ' + minutes + ' minutes"',
                '!',
                'event manager applet CANCEL-ROLLBACK',
                ' event none maxrun 60',
                ' action 1.0 cli command "enable"',
                ' action 1.1 cli command "configure confirm"',
                ' action 2.0 syslog msg "ArchToolKit: rollback cancelled, change confirmed"',
                '!',
              ]
            : []),
        ],
        verify: ['show archive', 'show archive config log all', ...(minutes > 0 ? ['show event manager policy registered'] : [])],
        backout: [...(minutes > 0 ? ['no event manager applet ROLLBACK-TIMER', 'no event manager applet CANCEL-ROLLBACK'] : []), 'no archive'],
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_hardening',
    platform: PLATFORM,
    label: 'Device hardening',
    group: 'Baseline',
    description: 'Turn off what should not be on, recover ports that error-disable themselves, and set the small defaults that stop a bad day.',
    inputs: [
      { id: 'disable_http', label: 'Disable the HTTP servers', control: 'toggle', default: true },
      { id: 'cdp_policy', label: 'CDP and LLDP', control: 'select', default: 'internal-only', options: [
        { value: 'internal-only', label: 'On, but off on edge ports' },
        { value: 'on', label: 'On everywhere' },
        { value: 'off', label: 'Off everywhere' },
      ] },
      { id: 'edge_ports', label: 'Edge ports', control: 'text', default: '', showWhen: { input: 'cdp_policy', equals: ['internal-only'] } },
      { id: 'errdisable_recovery', label: 'Recover error-disabled ports after (seconds)', control: 'number', default: 300, min: 0, max: 86400, hint: '0 to leave them down until someone looks' },
      { id: 'udld', label: 'UDLD on fibre uplinks', control: 'toggle', default: true },
      { id: 'password_policy', label: 'Login protections', control: 'toggle', default: true, hint: 'Block repeated failed logins and log them' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const cdp = str(values, 'cdp_policy', 'internal-only');
      const edges = listOf(str(values, 'edge_ports', ''));
      const recovery = num(values, 'errdisable_recovery', 300);

      return {
        platform: PLATFORM,
        title: 'Device hardening',
        impact: 'brief',
        notes: [
          'CDP off everywhere makes troubleshooting harder and breaks phone discovery. Off on edge ports only is the usual compromise.',
          'Error-disable recovery brings a port back by itself. That is right for a rate limit and wrong for a loop — the causes enabled here are the safe ones.',
          'UDLD on both ends or not at all: one end alone detects nothing.',
        ],
        before: ['show run | include ip http|cdp|udld', 'show errdisable recovery', 'show interfaces status err-disabled'],
        config: [
          ...(bool(values, 'disable_http', true) ? ['no ip http server', 'no ip http secure-server'] : []),
          'no service pad',
          'no ip source-route',
          'no ip finger',
          'no ip bootp server',
          'no ip domain-lookup',
          'service tcp-keepalives-in',
          'service tcp-keepalives-out',
          '!',
          ...(cdp === 'off' ? ['no cdp run', 'no lldp run'] : ['cdp run', 'lldp run']),
          ...(cdp === 'internal-only' ? edges.flatMap((iface) => [`interface ${iface}`, ' no cdp enable', ' no lldp transmit', '!']) : []),
          '!',
          ...(bool(values, 'udld', true) ? ['udld enable'] : []),
          ...(recovery > 0
            ? [
                'errdisable recovery cause link-flap',
                'errdisable recovery cause udld',
                'errdisable recovery cause storm-control',
                'errdisable recovery cause security-violation',
                `errdisable recovery interval ${recovery}`,
              ]
            : []),
          '!',
          ...(bool(values, 'password_policy', true)
            ? ['login block-for 120 attempts 5 within 60', 'login on-failure log', 'login on-success log', 'login delay 3']
            : []),
        ],
        verify: ['show run | include ip http|cdp run|lldp run|udld', 'show errdisable recovery', 'show login', 'show cdp neighbors'],
        backout: [
          ...(recovery > 0 ? ['no errdisable recovery cause link-flap', 'no errdisable recovery cause udld', 'no errdisable recovery cause storm-control', 'no errdisable recovery cause security-violation'] : []),
          ...(bool(values, 'udld', true) ? ['no udld enable'] : []),
          ...(bool(values, 'password_policy', true) ? ['no login block-for', 'no login on-failure log', 'no login on-success log'] : []),
          'ip domain-lookup',
        ],
      };
    },
  }),
];
