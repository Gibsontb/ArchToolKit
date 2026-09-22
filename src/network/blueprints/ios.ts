/**
 * Cisco IOS and IOS-XE: the changes a campus or branch switch actually gets.
 *
 * Each one is written the way a network engineer would write it by hand — the
 * same order, the same defaults, the descriptions filled in — and comes with
 * the show commands to capture first, the ones that prove it worked, and the
 * commands that take it back out.
 *
 * Nothing here writes a password, an enable secret, an SNMP community or a
 * pre-shared key. Where one is needed the configuration carries a placeholder
 * and the notes say where it belongs.
 */

import { bool, num, str, type BlueprintValues, type BlueprintGroup } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { description, listOf, netmask, parseCidr, vlanIds, vlanRange, wildcard, type DeviceChange } from '../device.ts';
import { IOS_EXTRA } from './ios-extra.ts';
import { IOS_EXTRA_2 } from './ios-extra2.ts';

const PLATFORM = 'cisco_ios' as const;

const SECRET = '<REQUIRED>';

/** The interface list typed as "Gi1/0/1-4, Gi1/0/9", expanded. */
function interfaces(value: string): string[] {
  const out: string[] = [];
  for (const part of listOf(value)) {
    const range = /^([A-Za-z]+[\d/]*?)(\d+)-(\d+)$/.exec(part);
    if (range) {
      const prefix = range[1] as string;
      const from = Number(range[2]);
      const to = Number(range[3]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) out.push(`${prefix}${i}`);
      continue;
    }
    out.push(part);
  }
  return out;
}

const VLAN_INPUT = { id: 'vlan_id', label: 'VLAN id', control: 'number' as const, default: 10, min: 1, max: 4094, hint: '1–4094' };

const BLUEPRINTS: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'ios_vlan_svi',
    platform: PLATFORM,
    label: 'VLAN and SVI',
    group: 'Switching',
    description: 'Create a VLAN, name it, and give it a routed interface with an address — optionally an HSRP virtual address and a DHCP helper.',
    inputs: [
      VLAN_INPUT,
      { id: 'vlan_name', label: 'VLAN name', control: 'text', default: 'USERS', hint: 'No spaces; IOS rejects them' },
      { id: 'svi', label: 'Give it an SVI', control: 'toggle', default: true, hint: 'A routed interface for the VLAN' },
      { id: 'address', label: 'SVI address', control: 'text', default: '10.10.10.1/24', placeholder: '10.10.10.1/24', showWhen: { input: 'svi', equals: ['true'] } },
      { id: 'helper', label: 'DHCP helper address', control: 'text', default: '', placeholder: '10.0.0.10', showWhen: { input: 'svi', equals: ['true'] } },
      { id: 'hsrp', label: 'HSRP virtual address', control: 'text', default: '', placeholder: '10.10.10.254', hint: 'Leave empty on a single switch', showWhen: { input: 'svi', equals: ['true'] } },
      { id: 'hsrp_priority', label: 'HSRP priority', control: 'number', default: 110, min: 1, max: 255, hint: 'Higher wins; 110 on the primary, 100 on the secondary', showWhen: { input: 'svi', equals: ['true'] } },
      { id: 'mtu', label: 'SVI MTU', control: 'number', default: 1500, min: 1500, max: 9216, showWhen: { input: 'svi', equals: ['true'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'vlan_id', 10);
      const name = str(values, 'vlan_name', 'USERS').replace(/\s+/g, '_').toUpperCase();
      const wantsSvi = bool(values, 'svi', true);
      const cidr = parseCidr(str(values, 'address', ''));
      const helper = str(values, 'helper', '');
      const hsrp = str(values, 'hsrp', '');
      const mtu = num(values, 'mtu', 1500);
      const findings: Finding[] = [];

      const config = ['vlan ' + id, ` name ${name}`, '!'];

      if (wantsSvi) {
        if (!cidr) {
          findings.push(
            error('network.ios.svi-address', 'The SVI address is not a valid address and prefix, so the interface was left without one.', {
              remediation: 'Write it as 10.10.10.1/24.',
              source: 'ArchToolKit',
            }),
          );
        }
        config.push(`interface Vlan${id}`, ` description ${name} gateway`);
        if (cidr) config.push(` ip address ${cidr.address} ${netmask(cidr.prefix)}`);
        if (mtu !== 1500) config.push(` mtu ${mtu}`);
        if (helper) config.push(` ip helper-address ${helper}`);
        if (hsrp) {
          config.push(` standby ${id} ip ${hsrp}`, ` standby ${id} priority ${num(values, 'hsrp_priority', 110)}`, ` standby ${id} preempt`);
        }
        config.push(' no shutdown', '!');
      }

      return {
        platform: PLATFORM,
        title: `VLAN ${id} (${name})${wantsSvi ? ' and its SVI' : ''}`,
        impact: 'none',
        notes: hsrp ? ['Configure the partner switch with the same HSRP group and a lower priority, or the pair will both claim the address.'] : [],
        before: [`show vlan id ${id}`, wantsSvi ? `show run interface Vlan${id}` : 'show vlan brief'],
        config,
        verify: [
          `show vlan id ${id}`,
          ...(wantsSvi ? [`show ip interface brief | include Vlan${id}`, cidr ? `ping ${cidr.address}` : 'show ip interface brief'] : []),
          ...(hsrp ? [`show standby Vlan${id} brief`] : []),
        ],
        backout: [...(wantsSvi ? [`interface Vlan${id}`, ' shutdown', '!', `no interface Vlan${id}`] : []), `no vlan ${id}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_access_port',
    platform: PLATFORM,
    label: 'Access ports',
    group: 'Switching',
    description: 'Put one or more ports in a VLAN with the edge protections on: portfast, BPDU guard, storm control, and an optional voice VLAN.',
    inputs: [
      { id: 'ports', label: 'Interfaces', control: 'text', default: 'GigabitEthernet1/0/1-4', hint: 'A list or a range: Gi1/0/1-4, Gi1/0/9' },
      VLAN_INPUT,
      { id: 'port_description', label: 'Description', control: 'text', default: 'User access', hint: 'Goes on every port in the list' },
      { id: 'voice_vlan', label: 'Voice VLAN', control: 'number', default: 0, min: 0, max: 4094, hint: '0 for none' },
      { id: 'portfast', label: 'PortFast and BPDU guard', control: 'toggle', default: true, hint: 'Edge ports only — never towards another switch' },
      { id: 'storm', label: 'Broadcast storm control (%)', control: 'number', default: 5, min: 0, max: 100, hint: '0 to leave it off' },
      { id: 'port_security', label: 'Port security', control: 'toggle', default: false, hint: 'Sticky MAC, maximum 2 addresses, restrict on violation' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ports = interfaces(str(values, 'ports', ''));
      const vlan = num(values, 'vlan_id', 10);
      const voice = num(values, 'voice_vlan', 0);
      const text = description(str(values, 'port_description', ''), 'User access');
      const storm = num(values, 'storm', 5);
      const findings: Finding[] = [];
      if (ports.length === 0) {
        findings.push(error('network.ios.no-ports', 'No interfaces were given, so this change configures nothing.', { remediation: 'List the ports, for example Gi1/0/1-4.', source: 'ArchToolKit' }));
      }

      const config: string[] = [];
      for (const port of ports) {
        config.push(
          `interface ${port}`,
          ` description ${text}`,
          ' switchport mode access',
          ` switchport access vlan ${vlan}`,
          ...(voice > 0 ? [` switchport voice vlan ${voice}`] : []),
          ...(bool(values, 'portfast', true) ? [' spanning-tree portfast', ' spanning-tree bpduguard enable'] : []),
          ...(storm > 0 ? [` storm-control broadcast level ${storm}.00`, ' storm-control action trap'] : []),
          ...(bool(values, 'port_security', false)
            ? [' switchport port-security', ' switchport port-security maximum 2', ' switchport port-security mac-address sticky', ' switchport port-security violation restrict']
            : []),
          ' no shutdown',
          '!',
        );
      }

      return {
        platform: PLATFORM,
        title: `${ports.length} access port(s) in VLAN ${vlan}`,
        impact: 'brief',
        notes: [
          'PortFast and BPDU guard belong on edge ports only. On a port facing another switch, BPDU guard will shut the port down the moment it sees a BPDU.',
          ...(bool(values, 'port_security', false) ? ['Port security with sticky MAC pins whatever is plugged in now. Moving a device needs the sticky address cleared.'] : []),
        ],
        before: [`show run interface ${ports[0] ?? 'Gi1/0/1'}`, 'show interfaces status', `show vlan id ${vlan}`],
        config,
        verify: ['show interfaces status', `show vlan id ${vlan}`, 'show spanning-tree interface ' + (ports[0] ?? 'Gi1/0/1') + ' detail | include portfast|BPDU'],
        backout: ports.flatMap((port) => [`interface ${port}`, ' default interface', ' shutdown', '!']),
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_trunk_port',
    platform: PLATFORM,
    label: 'Trunk port',
    group: 'Switching',
    description: 'Configure a trunk with an explicit allowed VLAN list and a native VLAN that is not VLAN 1.',
    inputs: [
      { id: 'ports', label: 'Interfaces', control: 'text', default: 'GigabitEthernet1/0/48', hint: 'A list or a range' },
      { id: 'allowed', label: 'Allowed VLANs', control: 'text', default: '10,20,30', hint: 'A list or ranges: 10,20,30-34' },
      { id: 'native', label: 'Native VLAN', control: 'number', default: 999, min: 1, max: 4094, hint: 'Something other than 1, and unused' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Trunk to distribution', hint: 'Say what is on the other end' },
      { id: 'nonegotiate', label: 'Disable DTP (nonegotiate)', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ports = interfaces(str(values, 'ports', ''));
      const allowed = vlanIds(str(values, 'allowed', ''));
      const native = num(values, 'native', 999);
      const findings: Finding[] = [];

      if (allowed.length === 0) {
        findings.push(error('network.ios.no-vlans', 'No allowed VLANs were given. A trunk with an empty list carries nothing.', { source: 'ArchToolKit' }));
      }
      if (native === 1) {
        findings.push(
          warning('network.ios.native-vlan-1', 'The native VLAN is 1. Untagged traffic then lands in the default VLAN, which is what VLAN hopping relies on.', {
            remediation: 'Use an unused VLAN, such as 999, and make it the native VLAN on both ends.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (allowed.includes(native)) {
        findings.push(
          warning('network.ios.native-in-allowed', `VLAN ${native} is both the native VLAN and in the allowed list, so its traffic crosses the trunk untagged.`, {
            remediation: 'Keep the native VLAN out of the allowed list unless you mean it.',
            source: 'ArchToolKit',
          }),
        );
      }

      const config = ports.flatMap((port) => [
        `interface ${port}`,
        ` description ${description(str(values, 'port_description', ''), 'Trunk')}`,
        ' switchport trunk encapsulation dot1q',
        ' switchport mode trunk',
        ` switchport trunk native vlan ${native}`,
        ` switchport trunk allowed vlan ${vlanRange(allowed)}`,
        ...(bool(values, 'nonegotiate', true) ? [' switchport nonegotiate'] : []),
        ' no shutdown',
        '!',
      ]);

      return {
        platform: PLATFORM,
        title: `Trunk on ${ports.join(', ') || 'no interface'} carrying VLANs ${vlanRange(allowed)}`,
        impact: 'brief',
        notes: [
          'The allowed list replaces whatever is there now. Capture the current list first, or VLANs that were crossing this trunk will stop.',
          'Both ends need the same native VLAN, or spanning tree will report a mismatch and may block the port.',
        ],
        before: ports.map((port) => `show run interface ${port}`).concat('show interfaces trunk'),
        config,
        verify: ['show interfaces trunk', 'show spanning-tree blockedports', `show vlan brief`],
        backout: ports.flatMap((port) => [`interface ${port}`, ' default interface', '!']),
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_port_channel',
    platform: PLATFORM,
    label: 'Port-channel (LACP)',
    group: 'Switching',
    description: 'Bundle interfaces into a LACP port-channel, as a trunk or an access port, with the members configured identically.',
    inputs: [
      { id: 'channel_id', label: 'Channel group', control: 'number', default: 1, min: 1, max: 128 },
      { id: 'members', label: 'Member interfaces', control: 'text', default: 'GigabitEthernet1/0/47-48', hint: 'Two or more, same speed and duplex' },
      { id: 'mode', label: 'Mode', control: 'select', default: 'trunk', options: [{ value: 'trunk', label: 'Trunk' }, { value: 'access', label: 'Access' }] },
      { id: 'allowed', label: 'Allowed VLANs', control: 'text', default: '10,20,30', showWhen: { input: 'mode', equals: ['trunk'] } },
      { id: 'native', label: 'Native VLAN', control: 'number', default: 999, min: 1, max: 4094, showWhen: { input: 'mode', equals: ['trunk'] } },
      { id: 'vlan_id', label: 'Access VLAN', control: 'number', default: 10, min: 1, max: 4094, showWhen: { input: 'mode', equals: ['access'] } },
      { id: 'lacp_mode', label: 'LACP mode', control: 'select', default: 'active', options: [{ value: 'active', label: 'Active — sends LACP' }, { value: 'passive', label: 'Passive — answers only' }] },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Uplink to core' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'channel_id', 1);
      const members = interfaces(str(values, 'members', ''));
      const trunk = str(values, 'mode', 'trunk') === 'trunk';
      const allowed = vlanIds(str(values, 'allowed', ''));
      const native = num(values, 'native', 999);
      const text = description(str(values, 'port_description', ''), 'Port-channel');
      const findings: Finding[] = [];
      if (members.length < 2) {
        findings.push(
          warning('network.ios.single-member', 'A port-channel with fewer than two members gains nothing and hides a single point of failure behind a bundle name.', {
            source: 'ArchToolKit',
          }),
        );
      }

      const logical = [
        `interface Port-channel${id}`,
        ` description ${text}`,
        ...(trunk
          ? [' switchport mode trunk', ' switchport trunk encapsulation dot1q', ` switchport trunk native vlan ${native}`, ` switchport trunk allowed vlan ${vlanRange(allowed)}`]
          : [' switchport mode access', ` switchport access vlan ${num(values, 'vlan_id', 10)}`]),
        ' no shutdown',
        '!',
      ];

      const memberConfig = members.flatMap((port) => [
        `interface ${port}`,
        ` description ${text} member`,
        ...(trunk
          ? [' switchport mode trunk', ' switchport trunk encapsulation dot1q', ` switchport trunk native vlan ${native}`, ` switchport trunk allowed vlan ${vlanRange(allowed)}`]
          : [' switchport mode access', ` switchport access vlan ${num(values, 'vlan_id', 10)}`]),
        ` channel-group ${id} mode ${str(values, 'lacp_mode', 'active')}`,
        ' no shutdown',
        '!',
      ]);

      return {
        platform: PLATFORM,
        title: `Port-channel ${id} from ${members.length} interface(s)`,
        impact: 'outage',
        notes: [
          'Members must match: same speed, duplex, and switchport configuration. IOS will refuse the bundle, or suspend a member, when they do not.',
          'Configure one side at a time and watch the far end. A bundle that is up on one side only will drop traffic.',
        ],
        before: ['show etherchannel summary', ...members.map((port) => `show run interface ${port}`)],
        config: [...logical, ...memberConfig],
        verify: ['show etherchannel summary', `show interfaces Port-channel${id} switchport`, 'show lacp neighbor'],
        backout: [...members.flatMap((port) => [`interface ${port}`, ` no channel-group ${id} mode ${str(values, 'lacp_mode', 'active')}`, '!']), `no interface Port-channel${id}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_static_route',
    platform: PLATFORM,
    label: 'Static route',
    group: 'Routing',
    description: 'Add a static route, optionally as a floating backup behind a better path.',
    inputs: [
      { id: 'prefix', label: 'Destination', control: 'text', default: '0.0.0.0/0', hint: 'A prefix, or 0.0.0.0/0 for a default route' },
      { id: 'next_hop', label: 'Next hop', control: 'text', default: '10.0.0.1', placeholder: '10.0.0.1' },
      { id: 'distance', label: 'Administrative distance', control: 'number', default: 1, min: 1, max: 255, hint: 'Above the routing protocol’s distance makes it a floating backup' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Leave empty for the global table' },
      { id: 'track', label: 'Track object', control: 'number', default: 0, min: 0, max: 500, hint: '0 for none; an IP SLA track withdraws the route when the hop dies' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const cidr = parseCidr(str(values, 'prefix', '0.0.0.0/0'));
      const hop = str(values, 'next_hop', '');
      const distance = num(values, 'distance', 1);
      const vrf = str(values, 'vrf', '');
      const track = num(values, 'track', 0);
      const findings: Finding[] = [];
      if (!cidr) findings.push(error('network.ios.bad-prefix', 'The destination is not a valid prefix.', { remediation: 'Write it as 10.0.0.0/24.', source: 'ArchToolKit' }));

      const parts = [
        'ip route',
        ...(vrf ? ['vrf', vrf] : []),
        cidr ? cidr.address : '0.0.0.0',
        cidr ? netmask(cidr.prefix) : '0.0.0.0',
        hop,
        ...(distance !== 1 ? [String(distance)] : []),
        ...(track > 0 ? ['track', String(track)] : []),
      ];

      return {
        platform: PLATFORM,
        title: `Static route ${cidr ? `${cidr.address}/${cidr.prefix}` : '(invalid prefix)'} via ${hop}`,
        impact: cidr && cidr.prefix === 0 ? 'outage' : 'brief',
        notes: [
          ...(cidr && cidr.prefix === 0 ? ['This is the default route. Getting it wrong takes everything off the network, including the session you are typing in.'] : []),
          ...(track > 0 ? [`Track object ${track} has to exist already, with an IP SLA behind it, or the route will never install.`] : []),
        ],
        before: [`show ip route${vrf ? ` vrf ${vrf}` : ''} ${cidr ? cidr.address : ''}`.trim(), `show ip route${vrf ? ` vrf ${vrf}` : ''} static`],
        config: [parts.join(' ')],
        verify: [`show ip route${vrf ? ` vrf ${vrf}` : ''} ${cidr ? cidr.address : ''}`.trim(), `ping ${hop}`, 'show ip route summary'],
        backout: [`no ${parts.join(' ')}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_ospf',
    platform: PLATFORM,
    label: 'OSPF process',
    group: 'Routing',
    description: 'Start an OSPF process with a router id, advertise networks, set passive interfaces by default, and optionally authenticate the area.',
    inputs: [
      { id: 'process', label: 'Process id', control: 'number', default: 1, min: 1, max: 65535 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.1', hint: 'A stable address, usually the loopback' },
      { id: 'area', label: 'Area', control: 'text', default: '0' },
      { id: 'networks', label: 'Networks', control: 'textarea', default: '10.10.10.0/24\n10.10.20.0/24', hint: 'One prefix per line' },
      { id: 'active', label: 'Interfaces that should form adjacencies', control: 'text', default: 'GigabitEthernet1/0/48', hint: 'Everything else is passive' },
      { id: 'auth', label: 'Authenticate the area (MD5)', control: 'toggle', default: true },
      { id: 'reference_bandwidth', label: 'Reference bandwidth (Mbps)', control: 'number', default: 100000, min: 1, hint: '100000 makes 100G cost 1; it must match on every router' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const process = num(values, 'process', 1);
      const area = str(values, 'area', '0');
      const nets = str(values, 'networks', '')
        .split(/\n+/)
        .map((line) => parseCidr(line.trim()))
        .filter((c): c is { address: string; prefix: number } => c !== null);
      const active = interfaces(str(values, 'active', ''));
      const auth = bool(values, 'auth', true);
      const findings: Finding[] = [];
      if (nets.length === 0) findings.push(error('network.ios.no-networks', 'No valid networks were given, so OSPF would advertise nothing.', { source: 'ArchToolKit' }));
      if (auth) {
        findings.push(
          warning('network.ios.ospf-key', 'The MD5 key is left as a placeholder. Put the real key in from a vault or by hand — it is never written into a generated file.', {
            source: 'ArchToolKit',
          }),
        );
      }

      const config = [
        `router ospf ${process}`,
        ` router-id ${str(values, 'router_id', '10.255.0.1')}`,
        ` auto-cost reference-bandwidth ${num(values, 'reference_bandwidth', 100000)}`,
        ' passive-interface default',
        ...active.map((port) => ` no passive-interface ${port}`),
        ...nets.map((n) => ` network ${n.address} ${wildcard(n.prefix)} area ${area}`),
        ...(auth ? [` area ${area} authentication message-digest`] : []),
        '!',
        ...(auth ? active.flatMap((port) => [`interface ${port}`, ` ip ospf message-digest-key 1 md5 ${SECRET}`, '!']) : []),
      ];

      return {
        platform: PLATFORM,
        title: `OSPF ${process} in area ${area}`,
        impact: 'brief',
        notes: [
          'Passive by default, then explicitly not passive on the links that should form adjacencies. The other way round is how a user VLAN ends up peering with something it should not.',
          'The reference bandwidth has to be the same on every router in the area, or the costs will not compare.',
          ...(auth ? [`Replace ${SECRET} with the area key. Do not commit it.`] : []),
        ],
        before: ['show ip ospf neighbor', 'show ip protocols', 'show run | section router ospf'],
        config,
        verify: ['show ip ospf neighbor', `show ip ospf ${process}`, 'show ip route ospf'],
        backout: [`no router ospf ${process}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_bgp_peer',
    platform: PLATFORM,
    label: 'BGP neighbour',
    group: 'Routing',
    description: 'Add an eBGP or iBGP neighbour with inbound and outbound prefix lists, a maximum prefix limit, and authentication.',
    inputs: [
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65000, min: 1 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.1' },
      { id: 'neighbor', label: 'Neighbour address', control: 'text', default: '203.0.113.1' },
      { id: 'remote_as', label: 'Remote AS', control: 'number', default: 65001, min: 1 },
      { id: 'peer_description', label: 'Description', control: 'text', default: 'Transit provider' },
      { id: 'advertise', label: 'Prefixes to advertise', control: 'textarea', default: '10.10.0.0/16', hint: 'One per line; an outbound prefix list is built from them' },
      { id: 'max_prefix', label: 'Maximum prefixes accepted', control: 'number', default: 1000, min: 0, hint: '0 for no limit — not advised on a transit peer' },
      { id: 'auth', label: 'Authenticate the session', control: 'toggle', default: true },
      { id: 'ebgp_multihop', label: 'eBGP multihop', control: 'number', default: 0, min: 0, max: 255, hint: '0 unless the peer is more than one hop away' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const localAs = num(values, 'local_as', 65000);
      const peer = str(values, 'neighbor', '');
      const remoteAs = num(values, 'remote_as', 65001);
      const advertise = str(values, 'advertise', '')
        .split(/\n+/)
        .map((line) => parseCidr(line.trim()))
        .filter((c): c is { address: string; prefix: number } => c !== null);
      const maxPrefix = num(values, 'max_prefix', 1000);
      const auth = bool(values, 'auth', true);
      const multihop = num(values, 'ebgp_multihop', 0);
      const findings: Finding[] = [];
      if (maxPrefix === 0) {
        findings.push(
          warning('network.ios.no-max-prefix', 'No maximum-prefix limit. A peer that leaks a full table will fill this router’s memory and take the session — and the box — down.', {
            remediation: 'Set a limit a little above what the peer should send.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (advertise.length === 0) {
        findings.push(
          warning('network.ios.no-outbound-filter', 'Nothing was listed to advertise, so no outbound prefix list is generated and the neighbour may receive everything this router knows.', {
            remediation: 'List the prefixes this router should originate.',
            source: 'ArchToolKit',
          }),
        );
      }

      const outName = `PL-OUT-${peer.replace(/\./g, '-') || 'PEER'}`;
      const inName = `PL-IN-${peer.replace(/\./g, '-') || 'PEER'}`;

      const config = [
        ...advertise.map((n, i) => `ip prefix-list ${outName} seq ${(i + 1) * 5} permit ${n.address}/${n.prefix}`),
        `ip prefix-list ${inName} seq 5 deny 0.0.0.0/0 le 7`,
        `ip prefix-list ${inName} seq 10 deny 10.0.0.0/8 le 32`,
        `ip prefix-list ${inName} seq 15 deny 172.16.0.0/12 le 32`,
        `ip prefix-list ${inName} seq 20 deny 192.168.0.0/16 le 32`,
        `ip prefix-list ${inName} seq 25 permit 0.0.0.0/0 le 24`,
        '!',
        `router bgp ${localAs}`,
        ` bgp router-id ${str(values, 'router_id', '10.255.0.1')}`,
        ' bgp log-neighbor-changes',
        ' no bgp default ipv4-unicast',
        ` neighbor ${peer} remote-as ${remoteAs}`,
        ` neighbor ${peer} description ${description(str(values, 'peer_description', ''), 'Peer')}`,
        ...(auth ? [` neighbor ${peer} password ${SECRET}`] : []),
        ...(multihop > 0 ? [` neighbor ${peer} ebgp-multihop ${multihop}`] : []),
        ' address-family ipv4 unicast',
        `  neighbor ${peer} activate`,
        `  neighbor ${peer} soft-reconfiguration inbound`,
        ...(maxPrefix > 0 ? [`  neighbor ${peer} maximum-prefix ${maxPrefix} 80 restart 15`] : []),
        `  neighbor ${peer} prefix-list ${inName} in`,
        `  neighbor ${peer} prefix-list ${outName} out`,
        ...advertise.map((n) => `  network ${n.address} mask ${netmask(n.prefix)}`),
        ' exit-address-family',
        '!',
      ];

      return {
        platform: PLATFORM,
        title: `BGP ${localAs} neighbour ${peer} (AS ${remoteAs})`,
        impact: 'brief',
        notes: [
          'The inbound prefix list drops martians and anything longer than a /24. Check it against what this peer is meant to send before you apply it.',
          ...(auth ? [`Replace ${SECRET} with the session password from your vault.`] : []),
          'A network statement only advertises a prefix this router already has in its table from somewhere else.',
        ],
        before: ['show ip bgp summary', 'show run | section router bgp', `show ip bgp neighbors ${peer}`],
        config,
        verify: [`show ip bgp neighbors ${peer}`, 'show ip bgp summary', `show ip bgp neighbors ${peer} advertised-routes`, `show ip bgp neighbors ${peer} received-routes`],
        backout: [`router bgp ${localAs}`, ` no neighbor ${peer}`, '!', `no ip prefix-list ${outName}`, `no ip prefix-list ${inName}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_acl',
    platform: PLATFORM,
    label: 'Named access list',
    group: 'Security',
    description: 'Build an extended access list from a list of rules and apply it to an interface, with the implicit deny made explicit and logged.',
    inputs: [
      { id: 'acl_name', label: 'Access list name', control: 'text', default: 'ACL-USERS-IN' },
      {
        id: 'rules',
        label: 'Rules',
        control: 'textarea',
        default: 'permit tcp 10.10.10.0/24 any eq 443\npermit tcp 10.10.10.0/24 any eq 80\npermit udp 10.10.10.0/24 host 10.0.0.10 eq 53',
        hint: 'One per line: permit|deny protocol source[/prefix|any|host x] destination [eq port]',
      },
      { id: 'apply_to', label: 'Apply to interface', control: 'text', default: '', hint: 'Leave empty to create the list without applying it' },
      { id: 'direction', label: 'Direction', control: 'select', default: 'in', options: [{ value: 'in', label: 'Inbound' }, { value: 'out', label: 'Outbound' }] },
      { id: 'log_denies', label: 'Log what the final deny drops', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'acl_name', 'ACL-IN').toUpperCase().replace(/\s+/g, '-');
      const rules = str(values, 'rules', '')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const target = str(values, 'apply_to', '');
      const direction = str(values, 'direction', 'in');
      const findings: Finding[] = [];
      if (rules.length === 0) {
        findings.push(error('network.ios.empty-acl', 'An access list with no rules denies everything, which is almost never what is wanted.', { source: 'ArchToolKit' }));
      }

      /** Turn "10.10.10.0/24" into the wildcard form IOS wants; pass anything else through. */
      const asIos = (token: string): string => {
        const cidr = parseCidr(token);
        if (!cidr) return token;
        if (cidr.prefix === 32) return `host ${cidr.address}`;
        return `${cidr.address} ${wildcard(cidr.prefix)}`;
      };
      const translated = rules.map((rule) =>
        rule
          .split(/\s+/)
          .map((token) => (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(token) ? asIos(token) : token))
          .join(' '),
      );

      const config = [
        `ip access-list extended ${name}`,
        ...translated.map((rule) => ` ${rule}`),
        ` deny ip any any${bool(values, 'log_denies', true) ? ' log' : ''}`,
        '!',
        ...(target ? [`interface ${target}`, ` ip access-group ${name} ${direction}`, '!'] : []),
      ];

      return {
        platform: PLATFORM,
        title: `Access list ${name}${target ? ` on ${target} ${direction}` : ''}`,
        impact: target ? 'outage' : 'none',
        notes: [
          'Replacing a named access list that is already applied empties it for a moment on some IOS versions. Build it under a new name and swap the interface over instead.',
          ...(target ? ['This filters live traffic the moment it is applied. Make sure your own session is permitted, or you will lock yourself out.'] : []),
          'The final deny is explicit so its hits can be counted. It is what the implicit rule does anyway.',
        ],
        before: [`show ip access-lists ${name}`, ...(target ? [`show run interface ${target}`] : [])],
        config,
        verify: [`show ip access-lists ${name}`, ...(target ? [`show run interface ${target}`] : []), 'show logging | include list ' + name],
        backout: [...(target ? [`interface ${target}`, ` no ip access-group ${name} ${direction}`, '!'] : []), `no ip access-list extended ${name}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_management_baseline',
    platform: PLATFORM,
    label: 'Management baseline',
    group: 'Baseline',
    description: 'NTP, syslog, SNMPv3, SSH-only access, timestamps and a login banner — the things every device should have before it carries traffic.',
    inputs: [
      { id: 'hostname', label: 'Hostname', control: 'text', default: 'sw-access-01' },
      { id: 'domain', label: 'Domain name', control: 'text', default: 'corp.local', hint: 'Needed before a key can be generated for SSH' },
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '10.0.0.10, 10.0.0.11' },
      { id: 'syslog_servers', label: 'Syslog servers', control: 'text', default: '10.0.0.20' },
      { id: 'timezone', label: 'Timezone', control: 'text', default: 'UTC 0', hint: 'As IOS writes it: "UTC 0", "EST -5 0"' },
      { id: 'snmp_user', label: 'SNMPv3 user', control: 'text', default: 'monitor', hint: 'v3 only; no communities are generated' },
      { id: 'management_acl', label: 'Management source prefix', control: 'text', default: '10.0.0.0/24', hint: 'Only these addresses may reach SSH and SNMP' },
      { id: 'banner', label: 'Login banner', control: 'textarea', default: 'Authorised access only. Activity is logged.' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const syslog = listOf(str(values, 'syslog_servers', ''));
      const mgmt = parseCidr(str(values, 'management_acl', '10.0.0.0/24'));
      const user = str(values, 'snmp_user', 'monitor');
      const banner = str(values, 'banner', 'Authorised access only.');
      const findings: Finding[] = [];
      if (!mgmt) {
        findings.push(
          warning('network.ios.no-management-acl', 'Without a management source prefix, SSH and SNMP are reachable from anywhere the device can be reached from.', {
            source: 'ArchToolKit',
          }),
        );
      }

      const config = [
        `hostname ${str(values, 'hostname', 'switch')}`,
        `ip domain name ${str(values, 'domain', 'corp.local')}`,
        'service timestamps log datetime msec localtime show-timezone',
        'service timestamps debug datetime msec localtime show-timezone',
        'service password-encryption',
        `clock timezone ${str(values, 'timezone', 'UTC 0')}`,
        '!',
        ...ntp.map((server) => `ntp server ${server}`),
        '!',
        'logging buffered 65536 informational',
        ...syslog.map((server) => `logging host ${server}`),
        'logging trap informational',
        '!',
        ...(mgmt
          ? [
              'ip access-list standard ACL-MGMT',
              ` permit ${mgmt.address} ${wildcard(mgmt.prefix)}`,
              ' deny any log',
              '!',
            ]
          : []),
        'ip ssh version 2',
        'ip ssh time-out 60',
        'ip ssh authentication-retries 3',
        'line vty 0 15',
        ' transport input ssh',
        ' exec-timeout 10 0',
        ' logging synchronous',
        ...(mgmt ? [' access-class ACL-MGMT in'] : []),
        '!',
        `snmp-server group MONITOR v3 priv${mgmt ? ' access ACL-MGMT' : ''}`,
        `snmp-server user ${user} MONITOR v3 auth sha ${SECRET} priv aes 128 ${SECRET}`,
        'snmp-server enable traps snmp linkdown linkup coldstart',
        '!',
        `banner login ^C`,
        banner,
        `^C`,
        '!',
      ];

      return {
        platform: PLATFORM,
        title: 'Management baseline: NTP, syslog, SNMPv3, SSH',
        impact: 'brief',
        notes: [
          `Replace every ${SECRET} with the real credential, from your vault. Nothing generated here contains one.`,
          'Generate the SSH key separately and interactively: crypto key generate rsa modulus 4096. It is not a configuration line and cannot be pasted in a block.',
          'The vty access class takes effect immediately. Check your own address is inside the management prefix first.',
        ],
        before: ['show run | section line vty', 'show ntp associations', 'show logging | include Logging to', 'show snmp user'],
        config,
        verify: ['show ntp status', 'show logging | include Logging to', 'show ip ssh', 'show snmp user', 'show run | section line vty'],
        backout: [
          'line vty 0 15',
          ' no access-class ACL-MGMT in',
          '!',
          'no ip access-list standard ACL-MGMT',
          ...ntp.map((server) => `no ntp server ${server}`),
          ...syslog.map((server) => `no logging host ${server}`),
          `no snmp-server user ${user} MONITOR v3`,
          'no snmp-server group MONITOR v3 priv',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_spanning_tree',
    platform: PLATFORM,
    label: 'Spanning-tree hardening',
    group: 'Baseline',
    description: 'Rapid PVST, an explicit root, root guard on downlinks, BPDU guard on edge ports and loop guard everywhere else.',
    inputs: [
      { id: 'mode', label: 'Mode', control: 'select', default: 'rapid-pvst', options: [{ value: 'rapid-pvst', label: 'Rapid PVST+' }, { value: 'mst', label: 'MST' }] },
      { id: 'vlans', label: 'VLANs', control: 'text', default: '1-100', hint: 'Which VLANs this priority applies to' },
      { id: 'role', label: 'This switch is', control: 'select', default: 'primary', options: [
        { value: 'primary', label: 'The root (priority 4096)' },
        { value: 'secondary', label: 'The backup root (priority 8192)' },
        { value: 'leaf', label: 'Neither (priority 32768, guards only)' },
      ] },
      { id: 'downlinks', label: 'Downlink interfaces', control: 'text', default: '', hint: 'Root guard goes on these — ports towards access switches' },
      { id: 'edge_ports', label: 'Edge interfaces', control: 'text', default: '', hint: 'PortFast and BPDU guard go on these' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const mode = str(values, 'mode', 'rapid-pvst');
      const vlans = vlanRange(vlanIds(str(values, 'vlans', '1-100')));
      const role = str(values, 'role', 'primary');
      const priority = role === 'primary' ? 4096 : role === 'secondary' ? 8192 : 32768;
      const downlinks = interfaces(str(values, 'downlinks', ''));
      const edges = interfaces(str(values, 'edge_ports', ''));

      const config = [
        `spanning-tree mode ${mode}`,
        'spanning-tree extend system-id',
        'spanning-tree portfast bpduguard default',
        'spanning-tree loopguard default',
        ...(role !== 'leaf' && vlans ? [`spanning-tree vlan ${vlans} priority ${priority}`] : []),
        '!',
        ...downlinks.flatMap((port) => [`interface ${port}`, ' spanning-tree guard root', '!']),
        ...edges.flatMap((port) => [`interface ${port}`, ' spanning-tree portfast', ' spanning-tree bpduguard enable', '!']),
      ];

      return {
        platform: PLATFORM,
        title: `Spanning tree: ${mode}, ${role === 'leaf' ? 'guards only' : `${role} root for VLANs ${vlans}`}`,
        impact: 'outage',
        notes: [
          'Changing the root re-converges the whole layer 2 domain. Traffic stops for a few seconds on rapid PVST, longer if anything in the path is not.',
          'Root guard on a link towards the real root will put that link into a blocking state. Put it on downlinks only.',
          'Loop guard and BPDU guard together are what stop a loop from a mis-patched cable, which is the most common cause of a campus outage.',
        ],
        before: ['show spanning-tree summary', 'show spanning-tree root', 'show spanning-tree blockedports'],
        config,
        verify: ['show spanning-tree summary', 'show spanning-tree root', 'show spanning-tree inconsistentports', 'show spanning-tree blockedports'],
        backout: [
          ...(role !== 'leaf' && vlans ? [`no spanning-tree vlan ${vlans} priority ${priority}`] : []),
          'no spanning-tree loopguard default',
          'no spanning-tree portfast bpduguard default',
          ...downlinks.flatMap((port) => [`interface ${port}`, ' no spanning-tree guard root', '!']),
        ],
      };
    },
  }),
];

/**
 * The campus basics are above; the rest — routed ports, VRFs, EIGRP, FHRP,
 * NAT, DHCP, 802.1X, SPAN, NetFlow, QoS, tunnels, VPN, AAA, NETCONF and the
 * archive — are in ios-extra.ts, because one file of thirty changes is a file
 * nobody can find anything in.
 */
const ALL: readonly ChangeBlueprint[] = [...BLUEPRINTS, ...IOS_EXTRA, ...IOS_EXTRA_2];

export const IOS_NETWORK: BlueprintGroup = {
  target: PLATFORM,
  label: 'Cisco IOS / IOS-XE',
  blueprints: ALL,
};

export const IOS_CHANGES: readonly ChangeBlueprint[] = ALL;
