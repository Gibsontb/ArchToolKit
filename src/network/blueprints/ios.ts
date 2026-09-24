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
import { description, listOf, netmask, parseCidr, parseCidrDual, vlanIds, vlanRange, wildcard, type DeviceChange } from '../device.ts';
import { containsAny, familyOf, parseCidrAny } from '../../core/ip.ts';
import { V6, aclOperand, addressList, cidrList, interfaceAddressLines, invalidEntries, isLinkLocal, routerIdFindings, v6AclTail } from './ios-v6.ts';
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
      { id: 'address', label: 'SVI address', control: 'text', default: '10.10.10.1/24', placeholder: '10.10.10.1/24, 2001:db8:10::1/64', hint: 'IPv4, IPv6 or one of each, comma separated', showWhen: { input: 'svi', equals: ['true'] } },
      { id: 'helper', label: 'DHCP helper address', control: 'text', default: '', placeholder: '10.0.0.10, 2001:db8::10', hint: 'IPv4 servers get a helper address, IPv6 servers a DHCPv6 relay destination', showWhen: { input: 'svi', equals: ['true'] } },
      { id: 'hsrp', label: 'HSRP virtual address', control: 'text', default: '', placeholder: '10.10.10.254, fe80::1', hint: 'Leave empty on a single switch. IPv6: a link-local, or a global address in the SVI prefix', showWhen: { input: 'svi', equals: ['true'] } },
      { id: 'hsrp_priority', label: 'HSRP priority', control: 'number', default: 110, min: 1, max: 255, hint: 'Higher wins; 110 on the primary, 100 on the secondary', showWhen: { input: 'svi', equals: ['true'] } },
      { id: 'mtu', label: 'SVI MTU', control: 'number', default: 1500, min: 1500, max: 9216, showWhen: { input: 'svi', equals: ['true'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'vlan_id', 10);
      const name = str(values, 'vlan_name', 'USERS').replace(/\s+/g, '_').toUpperCase();
      const wantsSvi = bool(values, 'svi', true);
      const addresses = cidrList(str(values, 'address', ''));
      const cidr = addresses.v4[0];
      const cidr6 = addresses.v6;
      const helpers = addressList(str(values, 'helper', ''));
      const hsrpList = listOf(str(values, 'hsrp', ''));
      const hsrp4 = hsrpList.filter((a) => familyOf(a) === 4 && !a.includes('/'));
      const hsrp6 = hsrpList.filter((a) => familyOf(a) === 6);
      const hsrpBad = hsrpList.filter((a) => !hsrp4.includes(a) && !hsrp6.includes(a));
      const hsrp = hsrpList.length > 0;
      const priority = num(values, 'hsrp_priority', 110);
      const mtu = num(values, 'mtu', 1500);
      const findings: Finding[] = [];

      const config = ['vlan ' + id, ` name ${name}`, '!'];

      if (wantsSvi) {
        if (!cidr && cidr6.length === 0) {
          findings.push(
            error('network.ios.svi-address', 'The SVI address is not a valid address and prefix, so the interface was left without one.', {
              remediation: 'Write it as 10.10.10.1/24, 2001:db8:10::1/64, or both.',
              source: 'ArchToolKit',
            }),
          );
        }
        if (addresses.v4.length > 1) {
          findings.push(warning('network.ios.svi-second-v4', `An SVI has one primary IPv4 address; ${addresses.v4.slice(1).map((c) => c.address).join(', ')} was left out.`, { remediation: 'Add a secondary address by hand if it is really wanted.', source: 'ArchToolKit' }));
        }
        findings.push(...invalidEntries('network.ios.svi-address', 'SVI address', addresses.invalid));
        if (helpers.other.length > 0) {
          findings.push(error('network.ios.bad-helper', `${helpers.other.join(', ')} is not an IPv4 or IPv6 address, so no helper was written for it.`, { source: 'ArchToolKit' }));
        }
        if (helpers.v6.length > 0 && cidr6.length === 0) {
          findings.push(error('network.ios.relay6-no-address', 'An IPv6 DHCP relay destination was given but the SVI has no IPv6 address. The relay stamps the SVI’s global address into every request so the server can pick a scope — without one, clients get nothing.', { remediation: 'Add an IPv6 address to the SVI, such as 2001:db8:10::1/64.', source: 'ArchToolKit' }));
        }
        if (hsrpBad.length > 0) {
          findings.push(error('network.ios.bad-hsrp', `${hsrpBad.join(', ')} is not a virtual address HSRP can use.`, { remediation: 'IPv4 as 10.10.10.254; IPv6 as fe80::1 or 2001:db8:10::254.', source: 'ArchToolKit' }));
        }
        if (hsrp6.length > 0 && cidr6.length === 0) {
          findings.push(error('network.ios.hsrp6-no-address', 'An IPv6 HSRP address was given but the SVI has no IPv6 address, so the IPv6 group was not written.', { remediation: 'Give the SVI an IPv6 address as well.', source: 'ArchToolKit' }));
        }

        // HSRP version 1 stops at group 255 and has no IPv6; a VLAN above 255
        // or an IPv6 group needs version 2. IPv4 and IPv6 groups on one
        // interface are separate groups, so the IPv6 one gets its own number.
        const v6Group = hsrp4.length > 0 ? (id <= 2047 ? id + 2048 : id - 2048) : id;
        const hsrp6Lines: string[] = [];
        if (hsrp6.length > 0 && cidr6.length > 0) {
          const linkLocal = hsrp6.find((a) => isLinkLocal(a));
          hsrp6Lines.push(linkLocal ? ` standby ${v6Group} ipv6 ${linkLocal}` : ` standby ${v6Group} ipv6 autoconfig`);
          for (const a of hsrp6.filter((x) => !isLinkLocal(x))) {
            const own = parseCidrAny(a);
            const home = cidr6.find((c) => containsAny(`${c.network}/${c.prefix}`, own?.address ?? '')) ?? cidr6[0]!;
            hsrp6Lines.push(` standby ${v6Group} ipv6 ${own?.address ?? a}/${a.includes('/') ? own?.prefix : home.prefix}`);
          }
          hsrp6Lines.push(` standby ${v6Group} priority ${priority}`, ` standby ${v6Group} preempt`);
        }

        config.push(`interface Vlan${id}`, ` description ${name} gateway`);
        config.push(...interfaceAddressLines(cidr, cidr6));
        if (mtu !== 1500) config.push(` mtu ${mtu}`);
        for (const server of helpers.v4) config.push(` ip helper-address ${server}`);
        if (cidr6.length > 0) for (const server of helpers.v6) config.push(` ipv6 dhcp relay destination ${server}`);
        if (hsrp6Lines.length > 0 || (hsrp4.length > 0 && id > 255)) config.push(' standby version 2');
        if (hsrp4.length > 0) {
          config.push(` standby ${id} ip ${hsrp4[0]}`, ` standby ${id} priority ${priority}`, ` standby ${id} preempt`);
        }
        config.push(...hsrp6Lines);
        config.push(' no shutdown', '!');
      }

      return {
        platform: PLATFORM,
        title: `VLAN ${id} (${name})${wantsSvi ? ' and its SVI' : ''}`,
        impact: 'none',
        notes: [
          ...(hsrp ? ['Configure the partner switch with the same HSRP group and a lower priority, or the pair will both claim the address.'] : []),
          ...(wantsSvi && cidr6.length > 0 ? ['IPv6 routing is global: `ipv6 unicast-routing` has to be on (the "IPv6 on an interface" change sets it) before the SVI sends router advertisements and hosts use it as their gateway.'] : []),
          ...(hsrp4.length > 0 && hsrp6.length > 0 ? ['The IPv6 HSRP group uses its own group number; the partner switch needs the same pair of numbers.'] : []),
        ],
        before: [`show vlan id ${id}`, wantsSvi ? `show run interface Vlan${id}` : 'show vlan brief'],
        config,
        verify: [
          `show vlan id ${id}`,
          ...(wantsSvi ? [`show ip interface brief | include Vlan${id}`, cidr ? `ping ${cidr.address}` : 'show ip interface brief'] : []),
          ...(wantsSvi && cidr6.length > 0 ? [`show ipv6 interface brief Vlan${id}`, `ping ${cidr6[0]!.address}`] : []),
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
      { id: 'prefix', label: 'Destination', control: 'combo', default: '0.0.0.0/0', hint: 'An IPv4 or IPv6 prefix; 0.0.0.0/0 or ::/0 for a default route', options: [
        { value: '0.0.0.0/0', label: '0.0.0.0/0 — IPv4 default route' },
        { value: '::/0', label: '::/0 — IPv6 default route' },
      ] },
      { id: 'next_hop', label: 'Next hop', control: 'text', default: '10.0.0.1', placeholder: '10.0.0.1 or 2001:db8::1', hint: 'Same family as the destination. A link-local next hop needs its interface first: GigabitEthernet0/0 fe80::1' },
      { id: 'distance', label: 'Administrative distance', control: 'number', default: 1, min: 1, max: 255, hint: 'Above the routing protocol’s distance makes it a floating backup' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Leave empty for the global table' },
      { id: 'track', label: 'Track object', control: 'number', default: 0, min: 0, max: 500, hint: '0 for none; an IP SLA track withdraws the route when the hop dies' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const cidr = parseCidrDual(str(values, 'prefix', '0.0.0.0/0'));
      const hop = str(values, 'next_hop', '').replace(/\s+/g, ' ');
      const hopTokens = hop.split(' ').filter(Boolean);
      const hopAddress = hopTokens.find((t) => familyOf(t) !== null && !t.includes('/'));
      const hopInterface = hopTokens.find((t) => familyOf(t) === null);
      const v6 = cidr?.family === 6;
      const distance = num(values, 'distance', 1);
      const vrf = str(values, 'vrf', '');
      const track = num(values, 'track', 0);
      const findings: Finding[] = [];
      if (!cidr) findings.push(error('network.ios.bad-prefix', 'The destination is not a valid prefix.', { remediation: 'Write it as 10.0.0.0/24 or 2001:db8::/48.', source: 'ArchToolKit' }));
      if (cidr && hopAddress && familyOf(hopAddress) !== cidr.family) {
        findings.push(error('network.ios.route-family', `The destination is IPv${cidr.family} but the next hop ${hopAddress} is IPv${familyOf(hopAddress)}. IOS routes each family through a next hop of the same family.`, { source: 'ArchToolKit' }));
      }
      if (v6 && hopAddress && isLinkLocal(hopAddress) && !hopInterface) {
        findings.push(error('network.ios.route-link-local', `${hopAddress} is a link-local address, which exists on every link at once. IOS needs the interface in front of it.`, { remediation: `Write the next hop as GigabitEthernet0/0 ${hopAddress}.`, source: 'ArchToolKit' }));
      }
      if (v6 && track > 0) {
        findings.push(
          warning('network.ios.route6-track', `Track object ${track} was not attached to the IPv6 route. VERIFY: \`ipv6 route ... track\` is not accepted by every IOS/IOS-XE release — check the release before adding it by hand.`, {
            source: 'ArchToolKit',
          }),
        );
      }

      const parts = v6
        ? ['ipv6 route', ...(vrf ? ['vrf', vrf] : []), `${cidr.network}/${cidr.prefix}`, hop, ...(distance !== 1 ? [String(distance)] : [])]
        : [
            'ip route',
            ...(vrf ? ['vrf', vrf] : []),
            cidr ? cidr.address : '0.0.0.0',
            cidr ? netmask(cidr.prefix) : '0.0.0.0',
            hop,
            ...(distance !== 1 ? [String(distance)] : []),
            ...(track > 0 ? ['track', String(track)] : []),
          ];
      const show = `show ${v6 ? 'ipv6' : 'ip'} route${vrf ? ` vrf ${vrf}` : ''}`;
      const where = cidr ? (v6 ? `${cidr.network}/${cidr.prefix}` : cidr.address) : '';

      return {
        platform: PLATFORM,
        title: `Static route ${cidr ? `${v6 ? cidr.network : cidr.address}/${cidr.prefix}` : '(invalid prefix)'} via ${hop}`,
        impact: cidr && cidr.prefix === 0 ? 'outage' : 'brief',
        notes: [
          ...(cidr && cidr.prefix === 0 ? ['This is the default route. Getting it wrong takes everything off the network, including the session you are typing in.'] : []),
          ...(track > 0 && !v6 ? [`Track object ${track} has to exist already, with an IP SLA behind it, or the route will never install.`] : []),
          ...(v6 ? ['An IPv6 route only forwards once `ipv6 unicast-routing` is on.'] : []),
        ],
        before: [`${show} ${where}`.trim(), `${show} static`],
        config: [parts.join(' ')],
        verify: [`${show} ${where}`.trim(), `ping ${hopAddress ?? hop}`, `show ${v6 ? 'ipv6' : 'ip'} route summary`],
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
      { id: 'ospfv3', label: 'Also run OSPFv3 for IPv6', control: 'toggle', default: false, hint: 'Same process number, router id and area; OSPFv2 itself carries IPv4 only' },
      { id: 'v6_interfaces', label: 'IPv6 interfaces to advertise', control: 'text', default: '', hint: 'Passive; OSPFv3 is enabled per interface, not with network statements. The adjacency interfaces above are included', showWhen: { input: 'ospfv3', equals: ['true'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const process = num(values, 'process', 1);
      const area = str(values, 'area', '0');
      const lines = str(values, 'networks', '')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const nets = lines.map((line) => parseCidr(line)).filter((c): c is { address: string; prefix: number } => c !== null);
      const nets6 = lines.filter((line) => parseCidrDual(line)?.family === 6);
      const active = interfaces(str(values, 'active', ''));
      const auth = bool(values, 'auth', true);
      const v3 = bool(values, 'ospfv3', false);
      const v3Ifaces = [...new Set([...active, ...interfaces(str(values, 'v6_interfaces', ''))])];
      const findings: Finding[] = [...routerIdFindings(str(values, 'router_id', '10.255.0.1'))];
      if (nets.length === 0 && !v3) findings.push(error('network.ios.no-networks', 'No valid networks were given, so OSPF would advertise nothing.', { source: 'ArchToolKit' }));
      if (nets6.length > 0) {
        findings.push(
          error('network.ios.ospf-v6-network', `OSPFv2 network statements on Cisco IOS/IOS-XE do not support IPv6, so ${nets6.join(', ')} was not used.`, {
            remediation: 'Turn on "Also run OSPFv3 for IPv6" and list the interfaces that carry those prefixes.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (v3 && auth) {
        findings.push(
          warning('network.ios.ospfv3-auth', 'The MD5 area key is OSPFv2 only; the OSPFv3 adjacencies are left unauthenticated. VERIFY which OSPFv3 authentication your release takes (IPsec `ospfv3 authentication ipsec`, or a key chain on newer IOS-XE) and add it in a separate change.', {
            source: 'ArchToolKit',
          }),
        );
      }
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
        ...(v3
          ? [
              'ipv6 unicast-routing',
              `router ospfv3 ${process}`,
              ` router-id ${str(values, 'router_id', '10.255.0.1')}`,
              ' address-family ipv6 unicast',
              `  auto-cost reference-bandwidth ${num(values, 'reference_bandwidth', 100000)}`,
              '  passive-interface default',
              ...active.map((port) => `  no passive-interface ${port}`),
              ' exit-address-family',
              '!',
              ...v3Ifaces.flatMap((port) => [`interface ${port}`, ` ospfv3 ${process} ipv6 area ${area}`, '!']),
            ]
          : []),
      ];

      return {
        platform: PLATFORM,
        title: `OSPF ${process} in area ${area}${v3 ? ' with OSPFv3' : ''}`,
        impact: 'brief',
        notes: [
          'Passive by default, then explicitly not passive on the links that should form adjacencies. The other way round is how a user VLAN ends up peering with something it should not.',
          'The reference bandwidth has to be the same on every router in the area, or the costs will not compare.',
          ...(auth ? [`Replace ${SECRET} with the area key. Do not commit it.`] : []),
          ...(v3 ? ['OSPFv3 runs on the interfaces named, and advertises every IPv6 prefix on them. Each needs an IPv6 address (or at least `ipv6 enable`) first.'] : []),
        ],
        before: ['show ip ospf neighbor', 'show ip protocols', 'show run | section router ospf', ...(v3 ? ['show ospfv3 neighbor'] : [])],
        config,
        verify: ['show ip ospf neighbor', `show ip ospf ${process}`, 'show ip route ospf', ...(v3 ? ['show ospfv3 neighbor', 'show ospfv3 interface brief', 'show ipv6 route ospf'] : [])],
        backout: [...(v3 ? [...v3Ifaces.flatMap((port) => [`interface ${port}`, ` no ospfv3 ${process} ipv6 area ${area}`, '!']), `no router ospfv3 ${process}`] : []), `no router ospf ${process}`],
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
      { id: 'neighbor', label: 'Neighbour address', control: 'text', default: '203.0.113.1', placeholder: '203.0.113.1, 2001:db8:ffff::1', hint: 'IPv4, IPv6, or one of each for a dual-stack peer' },
      { id: 'remote_as', label: 'Remote AS', control: 'number', default: 65001, min: 1 },
      { id: 'peer_description', label: 'Description', control: 'text', default: 'Transit provider' },
      { id: 'advertise', label: 'Prefixes to advertise', control: 'textarea', default: '10.10.0.0/16', hint: 'One per line, IPv4 or IPv6; each family gets its own outbound prefix list and address family' },
      { id: 'max_prefix', label: 'Maximum prefixes accepted', control: 'number', default: 1000, min: 0, hint: '0 for no limit — not advised on a transit peer' },
      { id: 'auth', label: 'Authenticate the session', control: 'toggle', default: true },
      { id: 'ebgp_multihop', label: 'eBGP multihop', control: 'number', default: 0, min: 0, max: 255, hint: '0 unless the peer is more than one hop away' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const localAs = num(values, 'local_as', 65000);
      const peers = addressList(str(values, 'neighbor', ''));
      const peer6 = peers.v6[0];
      // Anything that is not an IPv6 address stays on the IPv4 side, as before.
      const peer = peers.v4[0] ?? (peer6 ? undefined : str(values, 'neighbor', ''));
      const remoteAs = num(values, 'remote_as', 65001);
      const prefixes = cidrList(str(values, 'advertise', ''));
      const advertise = prefixes.v4;
      const advertise6 = prefixes.v6;
      const maxPrefix = num(values, 'max_prefix', 1000);
      const auth = bool(values, 'auth', true);
      const multihop = num(values, 'ebgp_multihop', 0);
      const findings: Finding[] = [...routerIdFindings(str(values, 'router_id', '10.255.0.1')), ...invalidEntries('network.ios.bad-prefix', 'Prefixes to advertise', prefixes.invalid)];
      if (peers.v4.length === 0 && peers.v6.length === 0) {
        findings.push(error('network.ios.bad-neighbor', 'The neighbour is not an IPv4 or IPv6 address.', { remediation: 'Write it as 203.0.113.1, 2001:db8:ffff::1, or both.', source: 'ArchToolKit' }));
      }
      if (peers.v4.length > 1 || peers.v6.length > 1) {
        findings.push(warning('network.ios.bgp-one-peer-per-family', 'Only the first address of each family was used. Add further neighbours as their own changes.', { source: 'ArchToolKit' }));
      }
      if (advertise6.length > 0 && !peer6) {
        findings.push(error('network.ios.bgp-v6-no-peer', `${advertise6.map((c) => `${c.network}/${c.prefix}`).join(', ')} is IPv6 but there is no IPv6 neighbour to advertise it to, so it was left out.`, { remediation: 'Add the peer’s IPv6 address to the neighbour field.', source: 'ArchToolKit' }));
      }
      if (advertise.length > 0 && peer === undefined) {
        findings.push(error('network.ios.bgp-v4-no-peer', `${advertise.map((c) => `${c.address}/${c.prefix}`).join(', ')} is IPv4 but there is no IPv4 neighbour to advertise it to, so it was left out.`, { remediation: 'Add the peer’s IPv4 address to the neighbour field.', source: 'ArchToolKit' }));
      }
      if (maxPrefix === 0) {
        findings.push(
          warning('network.ios.no-max-prefix', 'No maximum-prefix limit. A peer that leaks a full table will fill this router’s memory and take the session — and the box — down.', {
            remediation: 'Set a limit a little above what the peer should send.',
            source: 'ArchToolKit',
          }),
        );
      }
      if ((peer !== undefined ? advertise.length : 0) + (peer6 ? advertise6.length : 0) === 0) {
        findings.push(
          warning('network.ios.no-outbound-filter', 'Nothing was listed to advertise, so no outbound prefix list is generated and the neighbour may receive everything this router knows.', {
            remediation: 'List the prefixes this router should originate.',
            source: 'ArchToolKit',
          }),
        );
      }

      const outName = `PL-OUT-${(peer ?? '').replace(/\./g, '-') || 'PEER'}`;
      const inName = `PL-IN-${(peer ?? '').replace(/\./g, '-') || 'PEER'}`;
      const outName6 = `PL-OUT-${(peer6 ?? '').replace(/:/g, '-')}`;
      const inName6 = `PL-IN-${(peer6 ?? '').replace(/:/g, '-')}`;
      const peerLines = (p: string) => [
        ` neighbor ${p} remote-as ${remoteAs}`,
        ` neighbor ${p} description ${description(str(values, 'peer_description', ''), 'Peer')}`,
        ...(auth ? [` neighbor ${p} password ${SECRET}`] : []),
        ...(multihop > 0 ? [` neighbor ${p} ebgp-multihop ${multihop}`] : []),
      ];
      const policyLines = (p: string, inList: string, outList: string) => [
        `  neighbor ${p} activate`,
        `  neighbor ${p} soft-reconfiguration inbound`,
        ...(maxPrefix > 0 ? [`  neighbor ${p} maximum-prefix ${maxPrefix} 80 restart 15`] : []),
        `  neighbor ${p} prefix-list ${inList} in`,
        `  neighbor ${p} prefix-list ${outList} out`,
      ];

      const config = [
        ...(peer !== undefined
          ? [
              ...advertise.map((n, i) => `ip prefix-list ${outName} seq ${(i + 1) * 5} permit ${n.address}/${n.prefix}`),
              `ip prefix-list ${inName} seq 5 deny 0.0.0.0/0 le 7`,
              `ip prefix-list ${inName} seq 10 deny 10.0.0.0/8 le 32`,
              `ip prefix-list ${inName} seq 15 deny 172.16.0.0/12 le 32`,
              `ip prefix-list ${inName} seq 20 deny 192.168.0.0/16 le 32`,
              `ip prefix-list ${inName} seq 25 permit 0.0.0.0/0 le 24`,
              '!',
            ]
          : []),
        // IPv6: the default and anything shorter than a /16, documentation,
        // unique-local, link-local and multicast space out; global unicast in,
        // up to a /48 — the IPv6 equivalent of the IPv4 /24 rule.
        ...(peer6
          ? [
              ...advertise6.map((n, i) => `ipv6 prefix-list ${outName6} seq ${(i + 1) * 5} permit ${n.network}/${n.prefix}`),
              `ipv6 prefix-list ${inName6} seq 5 deny ::/0 le 15`,
              `ipv6 prefix-list ${inName6} seq 10 deny 2001:db8::/32 le 128`,
              `ipv6 prefix-list ${inName6} seq 15 deny fc00::/7 le 128`,
              `ipv6 prefix-list ${inName6} seq 20 deny fe80::/10 le 128`,
              `ipv6 prefix-list ${inName6} seq 25 deny ff00::/8 le 128`,
              `ipv6 prefix-list ${inName6} seq 30 permit 2000::/3 le 48`,
              '!',
            ]
          : []),
        `router bgp ${localAs}`,
        ` bgp router-id ${str(values, 'router_id', '10.255.0.1')}`,
        ' bgp log-neighbor-changes',
        ' no bgp default ipv4-unicast',
        ...(peer !== undefined ? peerLines(peer) : []),
        ...(peer6 ? peerLines(peer6) : []),
        ...(peer !== undefined
          ? [
              ' address-family ipv4 unicast',
              ...policyLines(peer, inName, outName),
              ...advertise.map((n) => `  network ${n.address} mask ${netmask(n.prefix)}`),
              ' exit-address-family',
            ]
          : []),
        ...(peer6
          ? [
              ' address-family ipv6 unicast',
              ...policyLines(peer6, inName6, outName6),
              ...advertise6.map((n) => `  network ${n.network}/${n.prefix}`),
              ' exit-address-family',
            ]
          : []),
        '!',
      ];
      const named = [peer, peer6].filter((p): p is string => !!p);

      return {
        platform: PLATFORM,
        title: `BGP ${localAs} neighbour ${named.join(' and ') || peer} (AS ${remoteAs})`,
        impact: 'brief',
        notes: [
          ...(peer !== undefined ? ['The inbound prefix list drops martians and anything longer than a /24. Check it against what this peer is meant to send before you apply it.'] : []),
          ...(peer6 ? ['The IPv6 inbound prefix list accepts global unicast (2000::/3) up to a /48 and drops documentation, unique-local, link-local and multicast space. Check it against what this peer is meant to send.', 'IPv6 routing has to be on (`ipv6 unicast-routing`) for the IPv6 routes to be installed and forwarded.'] : []),
          ...(auth ? [`Replace ${SECRET} with the session password from your vault.`] : []),
          'A network statement only advertises a prefix this router already has in its table from somewhere else.',
        ],
        before: [
          ...(peer !== undefined ? ['show ip bgp summary'] : []),
          ...(peer6 ? ['show bgp ipv6 unicast summary'] : []),
          'show run | section router bgp',
          ...(peer !== undefined ? [`show ip bgp neighbors ${peer}`] : []),
          ...(peer6 ? [`show bgp ipv6 unicast neighbors ${peer6}`] : []),
        ],
        config,
        verify: [
          ...(peer !== undefined ? [`show ip bgp neighbors ${peer}`, 'show ip bgp summary', `show ip bgp neighbors ${peer} advertised-routes`, `show ip bgp neighbors ${peer} received-routes`] : []),
          ...(peer6 ? [`show bgp ipv6 unicast neighbors ${peer6}`, 'show bgp ipv6 unicast summary', `show bgp ipv6 unicast neighbors ${peer6} advertised-routes`, `show bgp ipv6 unicast neighbors ${peer6} received-routes`] : []),
        ],
        backout: [
          `router bgp ${localAs}`,
          ...(peer !== undefined ? [` no neighbor ${peer}`] : []),
          ...(peer6 ? [` no neighbor ${peer6}`] : []),
          '!',
          ...(peer !== undefined ? [`no ip prefix-list ${outName}`, `no ip prefix-list ${inName}`] : []),
          ...(peer6 ? [`no ipv6 prefix-list ${outName6}`, `no ipv6 prefix-list ${inName6}`] : []),
        ],
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
        hint: 'One per line: permit|deny protocol source[/prefix|any|host x] destination [eq port]. IPv6 rules (2001:db8::/64) go into a separate IPv6 list; one rule cannot mix families',
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
      /**
       * The same rule as `ipv6 access-list` wants it: prefix lengths instead of
       * wildcards, `ipv6` instead of `ip`, a bare address as `host`, and the
       * ICMPv6 names for the ICMP messages that were renamed.
       */
      const ICMP6: Readonly<Record<string, string>> = { echo: 'echo-request', 'ttl-exceeded': 'time-exceeded' };
      const asIos6 = (rule: string): string => {
        const tokens = rule.split(/\s+/);
        return tokens
          .map((token, i) => {
            if (i === 1 && token.toLowerCase() === 'ip') return 'ipv6';
            if (familyOf(token) === 6) {
              if (!token.includes('/')) return tokens[i - 1]?.toLowerCase() === 'host' ? token : `host ${token}`;
              const c = parseCidrDual(token);
              return c ? aclOperand(c) : token;
            }
            return tokens[1]?.toLowerCase() === 'icmp' && ICMP6[token.toLowerCase()] ? ICMP6[token.toLowerCase()]! : token;
          })
          .join(' ');
      };
      const familiesIn = (rule: string) => new Set(rule.split(/\s+/).map((t) => familyOf(t)).filter((f): f is 4 | 6 => f !== null));
      const rules4: string[] = [];
      const rules6: string[] = [];
      const neutral: string[] = [];
      const mixed: string[] = [];
      for (const rule of rules) {
        const families = familiesIn(rule);
        if (families.size > 1) mixed.push(rule);
        else if (families.has(6)) rules6.push(rule);
        else if (families.has(4)) rules4.push(rule);
        else neutral.push(rule);
      }
      if (mixed.length > 0) {
        findings.push(
          error('network.ios.acl-mixed-family', `A rule cannot match an IPv4 source and an IPv6 destination, or the other way round: ${mixed.join(' | ')}. It was left out.`, {
            remediation: 'Write one rule per family. IPv4 rules go into the IPv4 list and IPv6 rules into the IPv6 list.',
            source: 'ArchToolKit',
          }),
        );
      }
      const log = bool(values, 'log_denies', true);
      const hasV6 = rules6.length > 0;
      // With no IPv6 rule this is the IPv4 list it always was. A rule with no
      // address in it (any to any) belongs to both lists once there are two.
      const hasV4 = rules4.length > 0 || !hasV6 || neutral.length > 0;
      const name6 = `${name}${V6}`;
      const translated = rules
        .filter((rule) => rules4.includes(rule) || neutral.includes(rule))
        .map((rule) =>
          rule
            .split(/\s+/)
            .map((token) => (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(token) ? asIos(token) : token))
            .join(' '),
        );
      const translated6 = rules.filter((rule) => rules6.includes(rule) || (hasV6 && neutral.includes(rule))).map(asIos6);

      const config = [
        ...(hasV4 ? [`ip access-list extended ${name}`, ...translated.map((rule) => ` ${rule}`), ` deny ip any any${log ? ' log' : ''}`, '!'] : []),
        ...(hasV6 ? [`ipv6 access-list ${name6}`, ...translated6.map((rule) => ` ${rule}`), ...v6AclTail(log), '!'] : []),
        ...(target ? [`interface ${target}`, ...(hasV4 ? [` ip access-group ${name} ${direction}`] : []), ...(hasV6 ? [` ipv6 traffic-filter ${name6} ${direction}`] : []), '!'] : []),
      ];

      return {
        platform: PLATFORM,
        title: `Access list ${hasV4 ? name : name6}${hasV4 && hasV6 ? ` and ${name6}` : ''}${target ? ` on ${target} ${direction}` : ''}`,
        impact: target ? 'outage' : 'none',
        notes: [
          'Replacing a named access list that is already applied empties it for a moment on some IOS versions. Build it under a new name and swap the interface over instead.',
          ...(target ? ['This filters live traffic the moment it is applied. Make sure your own session is permitted, or you will lock yourself out.'] : []),
          'The final deny is explicit so its hits can be counted. It is what the implicit rule does anyway.',
          ...(hasV6 ? [`IPv6 rules are in their own list, ${name6}, applied with \`ipv6 traffic-filter\`. Neighbour discovery (nd-na, nd-ns) is permitted just before its final deny — without it the interface cannot find its IPv6 neighbours.`] : []),
        ],
        before: [...(hasV4 ? [`show ip access-lists ${name}`] : []), ...(hasV6 ? [`show ipv6 access-list ${name6}`] : []), ...(target ? [`show run interface ${target}`] : [])],
        config,
        verify: [
          ...(hasV4 ? [`show ip access-lists ${name}`] : []),
          ...(hasV6 ? [`show ipv6 access-list ${name6}`] : []),
          ...(target ? [`show run interface ${target}`] : []),
          'show logging | include list ' + name,
        ],
        backout: [
          ...(target ? [`interface ${target}`, ...(hasV4 ? [` no ip access-group ${name} ${direction}`] : []), ...(hasV6 ? [` no ipv6 traffic-filter ${name6} ${direction}`] : []), '!'] : []),
          ...(hasV4 ? [`no ip access-list extended ${name}`] : []),
          ...(hasV6 ? [`no ipv6 access-list ${name6}`] : []),
        ],
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
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '10.0.0.10, 10.0.0.11', hint: 'IPv4 or IPv6 addresses' },
      { id: 'syslog_servers', label: 'Syslog servers', control: 'text', default: '10.0.0.20', hint: 'IPv4 or IPv6 addresses' },
      { id: 'timezone', label: 'Timezone', control: 'text', default: 'UTC 0', hint: 'As IOS writes it: "UTC 0", "EST -5 0"' },
      { id: 'snmp_user', label: 'SNMPv3 user', control: 'text', default: 'monitor', hint: 'v3 only; no communities are generated' },
      { id: 'management_acl', label: 'Management source prefix', control: 'text', default: '10.0.0.0/24', hint: 'Only these addresses may reach SSH and SNMP. IPv4 and IPv6, comma separated: 10.0.0.0/24, 2001:db8:0:1::/64' },
      { id: 'banner', label: 'Login banner', control: 'textarea', default: 'Authorised access only. Activity is logged.' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const syslog = listOf(str(values, 'syslog_servers', ''));
      const sources = cidrList(str(values, 'management_acl', '10.0.0.0/24'));
      const mgmt = sources.v4[0];
      const mgmt6 = sources.v6;
      const acl6 = `ACL-MGMT${V6}`;
      const user = str(values, 'snmp_user', 'monitor');
      const banner = str(values, 'banner', 'Authorised access only.');
      const findings: Finding[] = [...invalidEntries('network.ios.bad-management-acl', 'Management source prefix', sources.invalid)];
      if (!mgmt && mgmt6.length === 0) {
        findings.push(
          warning('network.ios.no-management-acl', 'Without a management source prefix, SSH and SNMP are reachable from anywhere the device can be reached from.', {
            source: 'ArchToolKit',
          }),
        );
      }
      const badServers = [...ntp, ...syslog].filter((s) => familyOf(s) === null || s.includes('/'));
      if (badServers.length > 0) {
        findings.push(warning('network.ios.server-not-address', `${badServers.join(', ')} is not an IPv4 or IPv6 address. IOS will try to resolve it as a name, and domain lookup is often off.`, { source: 'ArchToolKit' }));
      }
      // `logging host` takes an IPv6 server only with the ipv6 keyword.
      const logHost = (server: string) => (familyOf(server) === 6 ? `logging host ipv6 ${server}` : `logging host ${server}`);
      const snmpAccess = mgmt6.length > 0 ? ` access ipv6 ${acl6}${mgmt ? ' ACL-MGMT' : ''}` : mgmt ? ' access ACL-MGMT' : '';

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
        ...syslog.map(logHost),
        'logging trap informational',
        '!',
        ...(mgmt
          ? [
              'ip access-list standard ACL-MGMT',
              ...sources.v4.map((c) => ` permit ${c.address} ${wildcard(c.prefix)}`),
              ' deny any log',
              '!',
            ]
          : []),
        ...(mgmt6.length > 0 ? [`ipv6 access-list ${acl6}`, ...mgmt6.map((c) => ` permit ipv6 ${aclOperand(c)} any`), ' deny ipv6 any any log', '!'] : []),
        'ip ssh version 2',
        'ip ssh time-out 60',
        'ip ssh authentication-retries 3',
        'line vty 0 15',
        ' transport input ssh',
        ' exec-timeout 10 0',
        ' logging synchronous',
        ...(mgmt ? [' access-class ACL-MGMT in'] : []),
        ...(mgmt6.length > 0 ? [` ipv6 access-class ${acl6} in`] : []),
        '!',
        `snmp-server group MONITOR v3 priv${snmpAccess}`,
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
          ...(mgmt && mgmt6.length === 0 ? ['`access-class` filters IPv4 sessions only. If this device has an IPv6 address, add an IPv6 management prefix, or SSH over IPv6 is open to anything that can reach it.'] : []),
        ],
        before: ['show run | section line vty', 'show ntp associations', 'show logging | include Logging to', 'show snmp user'],
        config,
        verify: ['show ntp status', 'show logging | include Logging to', 'show ip ssh', 'show snmp user', 'show run | section line vty', ...(mgmt6.length > 0 ? [`show ipv6 access-list ${acl6}`] : [])],
        backout: [
          'line vty 0 15',
          ' no access-class ACL-MGMT in',
          ...(mgmt6.length > 0 ? [` no ipv6 access-class ${acl6} in`] : []),
          '!',
          'no ip access-list standard ACL-MGMT',
          ...(mgmt6.length > 0 ? [`no ipv6 access-list ${acl6}`] : []),
          ...ntp.map((server) => `no ntp server ${server}`),
          ...syslog.map((server) => `no ${logHost(server)}`),
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
