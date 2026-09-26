/**
 * Cisco IOS and IOS-XE: the parts a change list keeps hitting that the first
 * two files did not cover.
 *
 * `ios.ts` is the campus basics and `ios-extra.ts` is what a real device also
 * carries. What was still missing is everything that is not unicast IPv4 on a
 * switch: multicast, IPv6, policy routing, control plane protection, DMVPN, the
 * VLAN database, the stack itself, and the protections and licensing a modern
 * IOS-XE box will not run properly without.
 *
 * Same contract: capture first, verify after, a back-out that is the exact
 * commands, and never a credential — keys, secrets and pre-shared keys are
 * `<REQUIRED>` and the playbook reads them from a vault.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { description, listOf, netmask, parseCidrDual, vlanIds, vlanRange, wildcard, type DeviceChange } from '../device.ts';
import { familyOf } from '../../core/ip.ts';
import { V6, aclOperand, addressList, cidrList, interfaceAddressLines, invalidEntries, isLinkLocal, noIpv6, routerIdFindings, type IosCidr } from './ios-v6.ts';

const PLATFORM = 'cisco_ios' as const;
const SECRET = '<REQUIRED>';

export const IOS_EXTRA_2: readonly ChangeBlueprint[] = [
  /* ---------------------------------------------------------------- Multicast */
  deviceBlueprint({
    id: 'ios_multicast_pim',
    platform: PLATFORM,
    label: 'Multicast routing (PIM sparse mode)',
    group: 'Multicast',
    description: 'Turn on multicast routing, put PIM sparse mode on the interfaces that carry it, and point the network at a rendezvous point.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Vlan10, Vlan20, GigabitEthernet1/0/24', hint: 'Every interface multicast must cross, including the one towards the RP' },
      { id: 'rp_mode', label: 'Rendezvous point', control: 'select', default: 'static', options: [
        { value: 'static', label: 'Static RP — one address every router is told about' },
        { value: 'anycast', label: 'Anycast RP with MSDP — two RPs sharing one address' },
        { value: 'bsr', label: 'BSR — RPs advertise themselves' },
      ] },
      { id: 'rp_address', label: 'RP address', control: 'text', default: '10.255.0.1', hint: 'IPv4, IPv6 or one of each — an IPv6 RP turns on IPv6 multicast (PIMv6 and MLD)' },
      { id: 'rp_group_acl', label: 'Groups this RP serves', control: 'text', default: '239.0.0.0/8', hint: 'Empty for every group. IPv4 and/or IPv6 ranges: 239.0.0.0/8, ff05::/16' },
      { id: 'msdp_peer', label: 'MSDP peer', control: 'text', default: '10.255.0.3', showWhen: { input: 'rp_mode', equals: ['anycast'] } },
      { id: 'loopback', label: 'Anycast RP loopback', control: 'number', default: 1, min: 0, max: 2147483647, showWhen: { input: 'rp_mode', equals: ['anycast'] } },
      { id: 'igmp_version', label: 'IGMP version', control: 'select', default: '2', options: [
        { value: '2', label: 'Version 2 — any-source multicast, the usual answer' },
        { value: '3', label: 'Version 3 — source-specific multicast' },
      ] },
      { id: 'sparse_dense', label: 'Also accept dense mode groups', control: 'toggle', default: false, hint: 'Sparse-dense-mode. Leave off unless something old needs it' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const mode = str(values, 'rp_mode', 'static');
      const rps = addressList(str(values, 'rp_address', ''));
      const rp6Given = rps.v6[0];
      // A value that is not IPv6 stays on the IPv4 side, as it always did.
      const rp = rps.v4[0] ?? (rp6Given ? undefined : str(values, 'rp_address', ''));
      const v4 = rp !== undefined;
      const ifaces = listOf(str(values, 'interfaces', ''));
      const groupList = cidrList(str(values, 'rp_group_acl', ''));
      const groups = groupList.v4[0];
      const groups6 = groupList.v6[0];
      const version = str(values, 'igmp_version', '2');
      const pim = bool(values, 'sparse_dense', false) ? 'sparse-dense-mode' : 'sparse-mode';
      const loopback = num(values, 'loopback', 1);
      const msdpPeer = str(values, 'msdp_peer', '');
      const findings: Finding[] = [...invalidEntries('network.ios.bad-groups', 'Groups this RP serves', groupList.invalid)];
      if (ifaces.length === 0) findings.push(error('network.ios.no-interfaces', 'No interface was named, so multicast would be routed nowhere.', { remediation: 'Name every interface multicast has to cross, including the path to the RP.', source: 'ArchToolKit' }));
      // MSDP is IPv4 only, so the anycast-RP-with-MSDP design has no IPv6 form here.
      if (mode === 'anycast' && rp6Given) {
        findings.push(noIpv6('network.ios.msdp-ipv6', 'Anycast RP with MSDP', 'Use a static or BSR RP for IPv6. VERIFY: PIM anycast-RP for IPv6 (RFC 4610) exists on some IOS-XE releases, but is not generated here.'));
      }
      if (mode === 'anycast' && familyOf(msdpPeer) === 6) {
        findings.push(noIpv6('network.ios.msdp-ipv6', 'An MSDP peer', 'MSDP peers are IPv4 addresses.'));
      }
      if (groups6 && !rp6Given) {
        findings.push(error('network.ios.groups6-no-rp', 'An IPv6 group range was given but no IPv6 RP, so it was left out.', { remediation: 'Add the IPv6 RP address as well.', source: 'ArchToolKit' }));
      }
      if (groups && !v4) {
        findings.push(error('network.ios.groups4-no-rp', 'An IPv4 group range was given but no IPv4 RP, so it was left out.', { source: 'ArchToolKit' }));
      }
      const rp6 = mode === 'anycast' ? undefined : rp6Given;
      if (version === '3' && mode !== 'bsr') {
        findings.push(warning('network.ios.ssm-rp', 'Source-specific multicast does not use a rendezvous point for the SSM range. The RP here only serves any-source groups.', { remediation: 'Add `ip pim ssm default` if 232.0.0.0/8 is the range in use.', source: 'ArchToolKit' }));
      }
      if (bool(values, 'sparse_dense', false)) {
        findings.push(warning('network.ios.dense-mode', 'Sparse-dense-mode floods any group with no RP to every interface. It is a common cause of unexplained multicast load.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Multicast routing with ${mode === 'static' ? 'a static RP' : mode === 'anycast' ? 'an anycast RP' : 'BSR'}`,
        impact: 'brief',
        notes: [
          '`ip multicast-routing` changes how the platform forwards. On a switch it moves multicast into hardware replication, and the first few seconds after it is enabled can drop traffic already flowing.',
          'Every router on the path needs PIM, and every one of them needs the same answer about where the RP is. A router that disagrees will blackhole the group rather than route it another way.',
          ...(mode === 'anycast' ? ['Both anycast RPs share one address on a loopback and learn each other’s sources over MSDP. The loopback address must be advertised by the IGP from both.'] : []),
          ...(rp6 ? ['`ipv6 multicast-routing` turns PIM on for every IPv6 interface at once and uses MLD, not IGMP, towards hosts. Turn it off per interface with `no ipv6 pim` where multicast must not go. `ipv6 unicast-routing` must be on.'] : []),
        ],
        before: [
          ...(v4 ? ['show ip multicast', 'show ip pim interface', 'show ip pim rp mapping', 'show ip mroute summary'] : []),
          ...(rp6 ? ['show ipv6 pim interface', 'show ipv6 pim group-map', 'show ipv6 mroute'] : []),
        ],
        config: [
          ...(v4
            ? [
                'ip multicast-routing distributed',
                '!',
                ...ifaces.flatMap((iface) => [
                  `interface ${iface}`,
                  ` ip pim ${pim}`,
                  ...(version === '3' ? [' ip igmp version 3'] : []),
                  '!',
                ]),
                ...(mode === 'anycast'
                  ? [
                      `interface Loopback${loopback}`,
                      ` description Anycast RP`,
                      ` ip address ${rp} 255.255.255.255`,
                      ` ip pim ${pim}`,
                      '!',
                      `ip pim rp-address ${rp}${groups ? ' MCAST-GROUPS' : ''}`,
                      `ip msdp peer ${msdpPeer} connect-source Loopback${loopback}`,
                      `ip msdp originator-id Loopback${loopback}`,
                      '!',
                    ]
                  : mode === 'static'
                    ? [`ip pim rp-address ${rp}${groups ? ' MCAST-GROUPS' : ''}`, '!']
                    : ['ip pim bsr-candidate Loopback0 30', 'ip pim rp-candidate Loopback0', '!']),
                ...(groups
                  ? [
                      'ip access-list standard MCAST-GROUPS',
                      ` permit ${groups.address} ${wildcard(groups.prefix)}`,
                      '!',
                    ]
                  : []),
                ...(version === '3' ? ['ip pim ssm default', '!'] : []),
              ]
            : []),
          // IPv6: PIM runs on every IPv6 interface once multicast routing is on,
          // MLDv2 is the default, and the SSM range ff3x::/32 needs nothing.
          ...(rp6
            ? [
                'ipv6 multicast-routing',
                '!',
                ...(groups6 ? [`ipv6 access-list MCAST-GROUPS${V6}`, ` permit ipv6 any ${aclOperand(groups6)}`, '!'] : []),
                ...(mode === 'static'
                  ? [`ipv6 pim rp-address ${rp6}${groups6 ? ` MCAST-GROUPS${V6}` : ''}`]
                  : [`ipv6 pim bsr candidate bsr ${rp6}`, `ipv6 pim bsr candidate rp ${rp6}${groups6 ? ` group-list MCAST-GROUPS${V6}` : ''}`]),
                '!',
              ]
            : []),
        ],
        verify: [
          ...(v4
            ? [
                'show ip pim interface',
                'show ip pim neighbor',
                'show ip pim rp mapping',
                ...(mode === 'anycast' ? ['show ip msdp peer', 'show ip msdp sa-cache'] : []),
                'show ip mroute',
                'show ip igmp groups',
              ]
            : []),
          ...(rp6 ? ['show ipv6 pim neighbor', 'show ipv6 pim group-map', ...(mode === 'bsr' ? ['show ipv6 pim bsr election'] : []), 'show ipv6 mroute', 'show ipv6 mld groups'] : []),
        ],
        backout: [
          ...(v4
            ? [
                ...ifaces.flatMap((iface) => [`interface ${iface}`, ` no ip pim ${pim}`, '!']),
                ...(mode === 'anycast' ? [`no ip msdp peer ${msdpPeer}`] : []),
                ...(mode !== 'bsr' ? [`no ip pim rp-address ${rp}`] : ['no ip pim bsr-candidate Loopback0', 'no ip pim rp-candidate Loopback0']),
                'no ip multicast-routing distributed',
              ]
            : []),
          ...(rp6
            ? [
                ...(mode === 'static' ? [`no ipv6 pim rp-address ${rp6}`] : [`no ipv6 pim bsr candidate bsr ${rp6}`, `no ipv6 pim bsr candidate rp ${rp6}`]),
                ...(groups6 ? [`no ipv6 access-list MCAST-GROUPS${V6}`] : []),
                'no ipv6 multicast-routing',
              ]
            : []),
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_igmp_snooping',
    platform: PLATFORM,
    label: 'IGMP snooping and querier',
    group: 'Multicast',
    description: 'Keep multicast off the ports that did not ask for it, and give a layer 2 only VLAN the querier it needs for snooping to work at all.',
    inputs: [
      { id: 'vlans', label: 'VLANs', control: 'text', default: '10,20', hint: '10,20,30-32' },
      { id: 'querier', label: 'Querier', control: 'select', default: 'querier', options: [
        { value: 'querier', label: 'This switch is the querier — no multicast router in the VLAN' },
        { value: 'none', label: 'A router is already querying this VLAN' },
      ] },
      { id: 'querier_address', label: 'Querier source address', control: 'text', default: '10.0.10.2', hint: 'IPv4 only — IGMP has no IPv6 (that is MLD)', showWhen: { input: 'querier', equals: ['querier'] } },
      { id: 'immediate_leave', label: 'Immediate leave', control: 'toggle', default: false, hint: 'Only safe where each port has one receiver' },
      { id: 'report_suppression', label: 'Report suppression', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vlans = vlanIds(str(values, 'vlans', ''));
      const querier = str(values, 'querier', 'querier') === 'querier';
      const given = str(values, 'querier_address', '');
      // IGMP is IPv4 only; IPv6 hosts are tracked by MLD snooping, a separate feature.
      const address = familyOf(given) === 6 ? '' : given;
      const findings: Finding[] = [];
      if (querier && familyOf(given) === 6) {
        findings.push(noIpv6('network.ios.igmp-querier-ipv6', 'The IGMP snooping querier address', 'Give an IPv4 address in the VLAN. IPv6 multicast on a VLAN is MLD snooping (`ipv6 mld snooping`), configured separately.'));
      }
      if (vlans.length === 0) findings.push(error('network.ios.no-vlans', 'No valid VLAN id was given.', { remediation: 'Write them as 10,20,30-32.', source: 'ArchToolKit' }));
      if (bool(values, 'immediate_leave', false)) {
        findings.push(warning('network.ios.immediate-leave', 'Immediate leave drops the group the moment one receiver leaves. On a port with more than one receiver the others lose the stream.', { source: 'ArchToolKit' }));
      }
      if (!querier) {
        findings.push(warning('network.ios.no-querier', 'Snooping with nothing querying the VLAN ages out its groups and then floods. Confirm a router really is querying before choosing this.', { remediation: 'Check `show ip igmp snooping querier` on the VLAN.', source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `IGMP snooping on VLAN ${vlanRange(vlans)}`,
        impact: 'brief',
        notes: [
          'Snooping is on by default on most platforms. This change is usually about the querier, not the snooping.',
          'Turning snooping off floods every multicast group to every port in the VLAN, which on a busy VLAN is a saturated access port.',
        ],
        before: ['show ip igmp snooping', ...vlans.map((v) => `show ip igmp snooping querier vlan ${v}`), 'show ip igmp snooping groups'],
        config: [
          'ip igmp snooping',
          ...(bool(values, 'report_suppression', true) ? ['ip igmp snooping report-suppression'] : ['no ip igmp snooping report-suppression']),
          ...vlans.flatMap((vlan) => [
            `ip igmp snooping vlan ${vlan}`,
            ...(querier ? [`ip igmp snooping vlan ${vlan} querier`, ...(address ? [`ip igmp snooping vlan ${vlan} querier address ${address}`] : [])] : []),
            ...(bool(values, 'immediate_leave', false) ? [`ip igmp snooping vlan ${vlan} immediate-leave`] : []),
          ]),
          '!',
        ],
        verify: [
          'show ip igmp snooping',
          ...vlans.map((v) => `show ip igmp snooping querier vlan ${v}`),
          ...vlans.map((v) => `show ip igmp snooping groups vlan ${v}`),
          'show mac address-table multicast',
        ],
        backout: [
          ...vlans.flatMap((vlan) => [
            ...(querier ? [`no ip igmp snooping vlan ${vlan} querier`] : []),
            ...(bool(values, 'immediate_leave', false) ? [`no ip igmp snooping vlan ${vlan} immediate-leave`] : []),
          ]),
          // Report suppression is on by default: turning it off is the one thing to put back.
          ...(bool(values, 'report_suppression', true) ? [] : ['ip igmp snooping report-suppression']),
          '! Snooping itself stays on: it is the default, and turning it off floods multicast to every port.',
        ],
        findings,
      };
    },
  }),

  /* --------------------------------------------------------------------- IPv6 */
  deviceBlueprint({
    id: 'ios_ipv6_interface',
    platform: PLATFORM,
    label: 'IPv6 on an interface',
    group: 'IPv6',
    description: 'Address an interface for IPv6 and decide what it tells hosts: router advertisements, SLAAC, DHCPv6 or nothing at all.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'Vlan10' },
      { id: 'address', label: 'IPv6 address', control: 'text', default: '2001:db8:0:10::1/64' },
      { id: 'link_local', label: 'Link-local address', control: 'text', default: 'fe80::1', hint: 'A readable link-local makes a default gateway you can recognise' },
      { id: 'host_config', label: 'How hosts get addressed', control: 'select', default: 'slaac', options: [
        { value: 'slaac', label: 'SLAAC — hosts build their own address from the prefix' },
        { value: 'stateless-dhcp', label: 'SLAAC with stateless DHCPv6 for DNS' },
        { value: 'stateful-dhcp', label: 'Stateful DHCPv6 — the server assigns the address' },
        { value: 'none', label: 'No advertisements — a point-to-point or routed link' },
      ] },
      { id: 'dhcp_server', label: 'DHCPv6 server', control: 'text', default: '2001:db8:0:1::10', showWhen: { input: 'host_config', equals: ['stateless-dhcp', 'stateful-dhcp'] } },
      { id: 'ra_lifetime', label: 'Router lifetime (seconds)', control: 'number', default: 1800, min: 0, max: 9000 },
      { id: 'ra_guard', label: 'Block rogue advertisements on access ports', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const iface = str(values, 'interface', '');
      const address = str(values, 'address', '');
      const mode = str(values, 'host_config', 'slaac');
      const server = str(values, 'dhcp_server', '');
      const lifetime = num(values, 'ra_lifetime', 1800);
      const parsed = parseCidrDual(address);
      const linkLocal = str(values, 'link_local', '');
      const findings: Finding[] = [];
      if (parsed?.family !== 6) {
        findings.push(error('network.ios.bad-ipv6', 'The IPv6 address is not an address and prefix length.', { remediation: 'Write it as 2001:db8:0:10::1/64.', source: 'ArchToolKit' }));
      }
      if (linkLocal && !isLinkLocal(linkLocal)) {
        findings.push(error('network.ios.bad-link-local', `${linkLocal} is not a link-local address; IOS only takes fe80::/10 with the link-local keyword.`, { remediation: 'Write it as fe80::1, with no prefix length.', source: 'ArchToolKit' }));
      }
      if (server && familyOf(server) !== 6 && mode !== 'slaac' && mode !== 'none') {
        findings.push(error('network.ios.bad-dhcp6-server', `${server} is not an IPv6 address. A DHCPv6 relay destination has to be one.`, { source: 'ArchToolKit' }));
      }
      if (mode === 'slaac' && parsed?.family === 6 && parsed.prefix !== 64) {
        findings.push(error('network.ios.slaac-prefix', 'SLAAC only works on a /64. Hosts on any other prefix length will not address themselves.', { remediation: 'Use a /64, or hand out addresses with stateful DHCPv6.', source: 'ArchToolKit' }));
      }
      if (lifetime === 0) {
        findings.push(warning('network.ios.ra-lifetime-zero', 'A router lifetime of 0 tells hosts not to use this router as a default gateway. That is deliberate on a non-forwarding interface and a mistake anywhere else.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `IPv6 on ${iface}`,
        impact: 'brief',
        notes: [
          '`ipv6 unicast-routing` is global and has to be on before any of this forwards. Without it the interface addresses but routes nothing.',
          'Hosts that already have an IPv6 address keep it until it expires. Changing the prefix does not withdraw the old one — deprecate it by advertising it with a zero preferred lifetime first if that matters.',
          ...(mode === 'stateful-dhcp' ? ['Stateful DHCPv6 needs the managed-config flag, which this sets. Hosts that ignore it will still build a SLAAC address unless autoconfig is switched off as well.'] : []),
        ],
        before: [`show run interface ${iface}`, 'show ipv6 interface brief', `show ipv6 interface ${iface}`, 'show run | include ipv6 unicast-routing'],
        config: [
          'ipv6 unicast-routing',
          '!',
          `interface ${iface}`,
          ...(str(values, 'link_local', '') ? [` ipv6 address ${str(values, 'link_local', '')} link-local`] : []),
          ...(address ? [` ipv6 address ${address}`] : []),
          ' ipv6 enable',
          ...(mode === 'none'
            ? [' ipv6 nd ra suppress all']
            : [
                ` ipv6 nd ra lifetime ${lifetime}`,
                ...(mode === 'stateless-dhcp' ? [' ipv6 nd other-config-flag'] : []),
                ...(mode === 'stateful-dhcp' ? [' ipv6 nd managed-config-flag', ' ipv6 nd prefix default no-autoconfig'] : []),
              ]),
          ...(server && mode !== 'slaac' && mode !== 'none' ? [` ipv6 dhcp relay destination ${server}`] : []),
          '!',
          ...(bool(values, 'ra_guard', true)
            ? [
                'ipv6 nd raguard policy HOST-PORTS',
                ' device-role host',
                '!',
                `${'!'} Apply to access ports: interface range <ports> / ipv6 nd raguard attach-policy HOST-PORTS`,
              ]
            : []),
        ],
        verify: [
          `show ipv6 interface ${iface}`,
          'show ipv6 route',
          'show ipv6 neighbors',
          ...(mode !== 'none' ? ['debug ipv6 nd   ! briefly, then undebug all'] : []),
          ...(server ? ['show ipv6 dhcp relay binding'] : []),
        ],
        backout: [`interface ${iface}`, ...(address ? [` no ipv6 address ${address}`] : []), ' no ipv6 enable', '!'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_ipv6_routing',
    platform: PLATFORM,
    label: 'IPv6 routing (OSPFv3, static or BGP)',
    group: 'IPv6',
    description: 'Route IPv6: a static default, an OSPFv3 process across named interfaces, or an IPv6 address family on an existing BGP peer.',
    inputs: [
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'ospfv3', options: [
        { value: 'ospfv3', label: 'OSPFv3' },
        { value: 'static', label: 'Static route' },
        { value: 'bgp', label: 'BGP IPv6 address family' },
      ] },
      { id: 'process', label: 'OSPFv3 process', control: 'number', default: 1, min: 1, max: 65535, showWhen: { input: 'protocol', equals: ['ospfv3'] } },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.1', hint: 'Still an IPv4-shaped id, even for IPv6', showWhen: { input: 'protocol', equals: ['ospfv3', 'bgp'] } },
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Vlan10, GigabitEthernet1/0/24', showWhen: { input: 'protocol', equals: ['ospfv3'] } },
      { id: 'area', label: 'Area', control: 'text', default: '0', showWhen: { input: 'protocol', equals: ['ospfv3'] } },
      { id: 'prefix', label: 'Destination prefix', control: 'text', default: '::/0', showWhen: { input: 'protocol', equals: ['static'] } },
      { id: 'next_hop', label: 'Next hop', control: 'text', default: '2001:db8:0:12::2', showWhen: { input: 'protocol', equals: ['static'] } },
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65001, min: 1, showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'peer', label: 'Peer address', control: 'text', default: '2001:db8:0:12::2', showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'peer_as', label: 'Peer AS', control: 'number', default: 65002, min: 1, showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'advertise', label: 'Prefix to advertise', control: 'text', default: '2001:db8::/48', showWhen: { input: 'protocol', equals: ['bgp'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const protocol = str(values, 'protocol', 'ospfv3');
      const process = num(values, 'process', 1);
      const routerId = str(values, 'router_id', '');
      const ifaces = listOf(str(values, 'interfaces', ''));
      const area = str(values, 'area', '0');
      const findings: Finding[] = [];
      if (protocol === 'ospfv3' && ifaces.length === 0) {
        findings.push(error('network.ios.no-interfaces', 'OSPFv3 was asked for with no interface to run it on, which would bring up a process that peers with nothing.', { source: 'ArchToolKit' }));
      }
      if (protocol !== 'static' && !routerId) {
        findings.push(warning('network.ios.no-router-id', 'With no router id and no IPv4 address anywhere, an IPv6-only device will refuse to start the process.', { remediation: 'Set a router id explicitly — it is a 32-bit number, not an address that has to exist.', source: 'ArchToolKit' }));
      }
      if (protocol !== 'static') findings.push(...routerIdFindings(routerId));
      const v6Prefix = (id: string, label: string, fallback: string) => {
        const value = str(values, id, fallback);
        if (parseCidrDual(value)?.family !== 6) findings.push(error('network.ios.bad-ipv6-prefix', `${label} "${value}" is not an IPv6 prefix. This change builds IPv6 routing only — IPv4 goes in the static route, OSPF or BGP changes.`, { remediation: 'Write it as 2001:db8::/48, or ::/0 for a default route.', source: 'ArchToolKit' }));
      };
      const v6Address = (id: string, label: string) => {
        const value = str(values, id, '');
        const tokens = value.split(/\s+/).filter(Boolean);
        const address = tokens.find((t) => familyOf(t) !== null);
        if (!address || familyOf(address) !== 6 || address.includes('/')) {
          findings.push(error('network.ios.bad-ipv6-address', `${label} "${value}" is not an IPv6 address.`, { remediation: 'Write it as 2001:db8:0:12::2.', source: 'ArchToolKit' }));
        } else if (isLinkLocal(address) && tokens.length === 1) {
          findings.push(error('network.ios.route-link-local', `${address} is link-local; IOS needs the interface in front of it.`, { remediation: `Write it as GigabitEthernet0/0 ${address}.`, source: 'ArchToolKit' }));
        }
      };
      if (protocol === 'static') {
        v6Prefix('prefix', 'The destination', '::/0');
        v6Address('next_hop', 'The next hop');
      }
      if (protocol === 'bgp') {
        v6Prefix('advertise', 'The prefix to advertise', '');
        v6Address('peer', 'The peer');
      }

      const config =
        protocol === 'ospfv3'
          ? [
              `ipv6 unicast-routing`,
              '!',
              `router ospfv3 ${process}`,
              ...(routerId ? [` router-id ${routerId}`] : []),
              ' address-family ipv6 unicast',
              '  passive-interface default',
              ...ifaces.map((i) => `  no passive-interface ${i}`),
              ' exit-address-family',
              '!',
              ...ifaces.flatMap((iface) => [`interface ${iface}`, ` ospfv3 ${process} ipv6 area ${area}`, '!']),
            ]
          : protocol === 'static'
            ? ['ipv6 unicast-routing', `ipv6 route ${str(values, 'prefix', '::/0')} ${str(values, 'next_hop', '')}`, '!']
            : [
                'ipv6 unicast-routing',
                '!',
                `router bgp ${num(values, 'local_as', 65001)}`,
                ...(routerId ? [` bgp router-id ${routerId}`] : []),
                // Without this an IPv6 neighbour is also activated for IPv4 unicast.
                ' no bgp default ipv4-unicast',
                ` neighbor ${str(values, 'peer', '')} remote-as ${num(values, 'peer_as', 65002)}`,
                ' address-family ipv6 unicast',
                `  neighbor ${str(values, 'peer', '')} activate`,
                `  network ${str(values, 'advertise', '')}`,
                ' exit-address-family',
                '!',
              ];

      return {
        platform: PLATFORM,
        title: protocol === 'ospfv3' ? `OSPFv3 process ${process} in area ${area}` : protocol === 'static' ? `IPv6 static route to ${str(values, 'prefix', '')}` : 'BGP IPv6 address family',
        impact: protocol === 'static' ? 'none' : 'brief',
        notes: [
          'OSPFv3 and BGP for IPv6 both need an IPv4-shaped router id. On a device with no IPv4 address at all the process will not start until one is configured by hand.',
          ...(protocol === 'ospfv3' ? ['`passive-interface default` means an interface added later does not start peering by accident. Every interface that should peer is named explicitly.'] : []),
          ...(protocol === 'bgp' ? ['A neighbour is activated per address family. Configuring the neighbour without activating it under IPv6 gives a session that carries no IPv6 routes at all.'] : []),
        ],
        before: ['show ipv6 route summary', 'show ipv6 protocols', ...(protocol === 'ospfv3' ? ['show ospfv3 neighbor'] : []), ...(protocol === 'bgp' ? ['show bgp ipv6 unicast summary'] : [])],
        config,
        verify:
          protocol === 'ospfv3'
            ? ['show ospfv3 neighbor', 'show ospfv3 interface brief', 'show ipv6 route ospf']
            : protocol === 'static'
              ? [`show ipv6 route ${str(values, 'prefix', '')}`, `ping ipv6 ${str(values, 'next_hop', '')}`]
              : ['show bgp ipv6 unicast summary', 'show bgp ipv6 unicast', 'show ipv6 route bgp'],
        backout:
          protocol === 'ospfv3'
            ? [...ifaces.flatMap((i) => [`interface ${i}`, ` no ospfv3 ${process} ipv6 area ${area}`, '!']), `no router ospfv3 ${process}`]
            : protocol === 'static'
              ? [`no ipv6 route ${str(values, 'prefix', '::/0')} ${str(values, 'next_hop', '')}`]
              : [`router bgp ${num(values, 'local_as', 65001)}`, ` no neighbor ${str(values, 'peer', '')}`, '!'],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------------ Policy routing */
  deviceBlueprint({
    id: 'ios_pbr',
    platform: PLATFORM,
    label: 'Policy-based routing',
    group: 'Routing',
    description: 'Send traffic somewhere the routing table would not: a guest VLAN out of a second circuit, a subnet through an inspection device.',
    inputs: [
      { id: 'map_name', label: 'Route-map name', control: 'text', default: 'PBR-GUEST-OUT' },
      { id: 'apply_to', label: 'Apply to interface', control: 'text', default: 'Vlan30', hint: 'The interface traffic arrives on, not the one it leaves by' },
      { id: 'match_source', label: 'Match source', control: 'text', default: '10.30.0.0/16', hint: 'IPv4, IPv6 or one of each: 10.30.0.0/16, 2001:db8:30::/48' },
      { id: 'match_destination', label: 'Match destination', control: 'text', default: '', hint: 'Empty for any destination; otherwise one per source family' },
      { id: 'action', label: 'Action', control: 'select', default: 'next-hop', options: [
        { value: 'next-hop', label: 'Set next hop' },
        { value: 'interface', label: 'Set output interface' },
        { value: 'default-next-hop', label: 'Set next hop only if there is no route' },
        { value: 'drop', label: 'Drop it' },
      ] },
      { id: 'next_hop', label: 'Next hop', control: 'text', default: '10.0.99.1', hint: 'One per source family: 10.0.99.1, 2001:db8:99::1', showWhen: { input: 'action', equals: ['next-hop', 'default-next-hop'] } },
      { id: 'out_interface', label: 'Output interface', control: 'text', default: 'GigabitEthernet0/0/1', showWhen: { input: 'action', equals: ['interface'] } },
      { id: 'track', label: 'Track object for the next hop', control: 'number', default: 0, min: 0, hint: '0 for none — otherwise policy holds even when the next hop is dead' },
      { id: 'local_policy', label: 'Also apply to traffic the router itself generates', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'map_name', 'PBR').toUpperCase();
      const iface = str(values, 'apply_to', '');
      const sources = cidrList(str(values, 'match_source', ''));
      const destinations = cidrList(str(values, 'match_destination', ''));
      const hops = addressList(str(values, 'next_hop', ''));
      const source = sources.v4[0];
      const destination = destinations.v4[0];
      const source6 = sources.v6[0];
      const destination6 = destinations.v6[0];
      const hop4 = hops.v4[0] ?? hops.other[0] ?? '';
      const hop6 = hops.v6[0];
      const action = str(values, 'action', 'next-hop');
      const track = num(values, 'track', 0);
      const needsHop = action === 'next-hop' || action === 'default-next-hop';
      // With no IPv6 source this is the IPv4 policy it always was.
      const v4 = !!source || !source6;
      const v6 = !!source6;
      const findings: Finding[] = [...invalidEntries('network.ios.bad-source', 'Match source', sources.invalid), ...invalidEntries('network.ios.bad-destination', 'Match destination', destinations.invalid)];
      if (!source && !source6) findings.push(error('network.ios.bad-source', 'The source to match is not a valid prefix.', { remediation: 'Write it as 10.30.0.0/16 or 2001:db8:30::/48.', source: 'ArchToolKit' }));
      if (destination && !source) findings.push(error('network.ios.pbr-family', 'The IPv4 destination has no IPv4 source to pair with; a policy match is one family, so it was left out.', { source: 'ArchToolKit' }));
      if (destination6 && !source6) findings.push(error('network.ios.pbr-family', 'The IPv6 destination has no IPv6 source to pair with; a policy match is one family, so it was left out.', { source: 'ArchToolKit' }));
      if (v6 && needsHop && !hop6) {
        findings.push(error('network.ios.pbr-no-hop6', 'IPv6 traffic is matched but no IPv6 next hop was given, and an IPv4 next hop cannot forward it. The IPv6 policy was not written.', { remediation: 'Add an IPv6 next hop, such as 2001:db8:99::1.', source: 'ArchToolKit' }));
      }
      if (v6 && needsHop && hop6 && track > 0) {
        findings.push(warning('network.ios.pbr6-track', `Track object ${track} was not applied to the IPv6 next hop. VERIFY that your release accepts \`set ipv6 next-hop verify-availability\` before adding it; without it the IPv6 policy holds even when the next hop is dead.`, { source: 'ArchToolKit' }));
      }
      const write6 = v6 && (!needsHop || !!hop6);
      const name6 = `${name}${V6}`;
      if (track === 0 && (action === 'next-hop' || action === 'interface')) {
        findings.push(warning('network.ios.pbr-untracked', 'Policy routing to an untracked next hop keeps sending traffic there after it fails. The routing table will not rescue it, because policy is consulted first.', { remediation: 'Point this at an IP SLA track object, or use "set ip default next-hop" so the routing table wins when it has a route.', source: 'ArchToolKit' }));
      }
      if (action === 'drop') {
        findings.push(warning('network.ios.pbr-drop', 'A `set interface Null0` drops silently — no unreachable is sent, so the sender waits for a timeout rather than failing fast.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Policy routing ${name} on ${iface}`,
        impact: 'brief',
        notes: [
          'Policy routing is consulted before the routing table, for traffic arriving on this interface only. Anything it matches stops following the routes you can see in `show ip route`, which is what makes it hard to troubleshoot later. Say so in the interface description.',
          'On many switch platforms policy routing is only accelerated for some actions; the rest is punted to the CPU. Check the platform before pointing a busy VLAN at it.',
          ...(track > 0 ? [`Track object ${track} must already exist — an IP SLA change builds one.`] : []),
        ],
        before: [`show run interface ${iface}`, `show route-map ${v4 ? name : name6}`, ...(v4 ? ['show ip policy'] : []), ...(write6 ? ['show ipv6 policy'] : []), ...(track > 0 ? [`show track ${track}`] : [])],
        config: [
          ...(v4
            ? [
                `ip access-list extended ${name}-MATCH`,
                ` permit ip ${source ? `${source.address} ${wildcard(source.prefix)}` : 'any'} ${destination ? `${destination.address} ${wildcard(destination.prefix)}` : 'any'}`,
                '!',
                `route-map ${name} permit 10`,
                ` match ip address ${name}-MATCH`,
                ...(action === 'next-hop' ? [` set ip next-hop${track > 0 ? ` verify-availability ${hop4} 10 track ${track}` : ` ${hop4}`}`] : []),
                ...(action === 'default-next-hop' ? [` set ip default next-hop ${hop4}`] : []),
                ...(action === 'interface' ? [` set interface ${str(values, 'out_interface', '')}`] : []),
                ...(action === 'drop' ? [' set interface Null0'] : []),
                '!',
                `route-map ${name} permit 20`,
                `${'!'} everything else follows the routing table`,
                '!',
              ]
            : []),
          // IPv6 gets its own list and route map: `ipv6 access-list` with a
          // prefix length, `match ipv6 address`, `set ipv6 next-hop`.
          ...(write6
            ? [
                `ipv6 access-list ${name}-MATCH${V6}`,
                ` permit ipv6 ${aclOperand(source6!)} ${destination6 ? aclOperand(destination6) : 'any'}`,
                '!',
                `route-map ${name6} permit 10`,
                ` match ipv6 address ${name}-MATCH${V6}`,
                ...(action === 'next-hop' ? [` set ipv6 next-hop ${hop6}`] : []),
                ...(action === 'default-next-hop' ? [` set ipv6 default next-hop ${hop6}`] : []),
                ...(action === 'interface' ? [` set interface ${str(values, 'out_interface', '')}`] : []),
                ...(action === 'drop' ? [' set interface Null0'] : []),
                '!',
                `route-map ${name6} permit 20`,
                '!',
              ]
            : []),
          `interface ${iface}`,
          ...(v4 ? [` ip policy route-map ${name}`] : []),
          ...(write6 ? [` ipv6 policy route-map ${name6}`] : []),
          '!',
          ...(bool(values, 'local_policy', false) && v4 ? [`ip local policy route-map ${name}`, '!'] : []),
          ...(bool(values, 'local_policy', false) && write6 ? [`ipv6 local policy route-map ${name6}`, '!'] : []),
        ],
        verify: [
          ...(v4 ? ['show ip policy', `show route-map ${name}`, `show ip access-lists ${name}-MATCH`] : []),
          ...(write6 ? ['show ipv6 policy', `show route-map ${name6}`, `show ipv6 access-list ${name}-MATCH${V6}`] : []),
          `traceroute <a host in ${str(values, 'match_source', '')}> source ${iface}`,
          'debug ip policy   ! briefly, on a quiet device only',
        ],
        backout: [
          `interface ${iface}`,
          ...(v4 ? [` no ip policy route-map ${name}`] : []),
          ...(write6 ? [` no ipv6 policy route-map ${name6}`] : []),
          '!',
          ...(bool(values, 'local_policy', false) && v4 ? [`no ip local policy route-map ${name}`] : []),
          ...(bool(values, 'local_policy', false) && write6 ? [`no ipv6 local policy route-map ${name6}`] : []),
          ...(v4 ? [`no route-map ${name}`, `no ip access-list extended ${name}-MATCH`] : []),
          ...(write6 ? [`no route-map ${name6}`, `no ipv6 access-list ${name}-MATCH${V6}`] : []),
        ],
        findings,
      };
    },
  }),

  /* ---------------------------------------------------------- Control plane */
  deviceBlueprint({
    id: 'ios_copp',
    platform: PLATFORM,
    label: 'Control plane policing',
    group: 'Hardening',
    description: 'Rate-limit what reaches the CPU, so a scan or a loop cannot take the device’s management and routing down with it.',
    inputs: [
      { id: 'management_sources', label: 'Management sources', control: 'text', default: '10.0.0.0/8', hint: 'Where SSH and SNMP legitimately come from: IPv4 and/or IPv6, comma separated' },
      { id: 'ipv6_classes', label: 'Classify IPv6 control traffic', control: 'toggle', default: false, hint: 'OSPFv3, BGP, neighbour discovery and ICMPv6 get their classes. On automatically when an IPv6 source is given' },
      { id: 'ssh_rate', label: 'Management rate (bps)', control: 'number', default: 500000, min: 8000 },
      { id: 'routing_rate', label: 'Routing protocol rate (bps)', control: 'number', default: 1000000, min: 8000 },
      { id: 'icmp_rate', label: 'ICMP rate (bps)', control: 'number', default: 100000, min: 8000 },
      { id: 'undesirable_action', label: 'Everything else', control: 'select', default: 'police', options: [
        { value: 'police', label: 'Police it to a trickle' },
        { value: 'drop', label: 'Drop it' },
        { value: 'monitor', label: 'Count it only — no action' },
      ] },
      { id: 'monitor_first', label: 'Start in monitor mode', control: 'toggle', default: true, hint: 'Counts for a week before anything is dropped' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const sourceList = cidrList(str(values, 'management_sources', ''));
      const sources = sourceList.v4[0];
      const sources6 = sourceList.v6;
      // Once a device runs IPv6, neighbour discovery and OSPFv3 reach the CPU
      // too; left unclassified they fall into class-default and get policed.
      const v6 = sources6.length > 0 || bool(values, 'ipv6_classes', false);
      const monitor = bool(values, 'monitor_first', true);
      const otherwise = str(values, 'undesirable_action', 'police');
      const rate = (id: string, fallback: number) => {
        const bps = num(values, id, fallback);
        return { bps, burst: Math.max(1500, Math.round(bps / 8 / 10)) };
      };
      const ssh = rate('ssh_rate', 500000);
      const routing = rate('routing_rate', 1000000);
      const icmp = rate('icmp_rate', 100000);
      const findings: Finding[] = [];
      if (!sources && sources6.length === 0) findings.push(error('network.ios.bad-sources', 'The management source prefix is not valid, so the management class would match nothing and management traffic would fall into the catch-all.', { source: 'ArchToolKit' }));
      findings.push(...invalidEntries('network.ios.bad-sources', 'Management sources', sourceList.invalid));
      const classMap = (name: string) => (v6 ? [`class-map match-any ${name}`, ` match access-group name ${name}`, ` match access-group name ${name}${V6}`] : [`class-map match-all ${name}`, ` match access-group name ${name}`]);
      if (!monitor && otherwise === 'drop') {
        findings.push(warning('network.ios.copp-blind-drop', 'Dropping the catch-all without watching it first is the usual way a CoPP policy locks someone out of a device. The class matches more than people expect.', { remediation: 'Leave monitor mode on for a week, read the counters, then tighten.', source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: 'Control plane policing',
        impact: 'brief',
        notes: [
          'This applies to traffic destined for the CPU, not traffic passing through. A policy that is too tight takes out SSH, routing adjacencies, or both, and you will be fixing it on the console.',
          'Rates here are a starting point. Read `show policy-map control-plane` after a week of normal load and set them from what you see, not from what a document said.',
          ...(monitor ? ['Monitor mode is on: every class counts and nothing is dropped. Take the policing lines out of the comment when the counters look right.'] : []),
          ...(v6 && sources6.length === 0 ? ['IPv6 classes are on but no IPv6 management source was given, so SSH and SNMP over IPv6 fall into class-default. Add the IPv6 management prefix.'] : []),
          ...(!v6 ? ['Only IPv4 is classified. If this device runs IPv6, turn on the IPv6 classes: otherwise neighbour discovery and OSPFv3 land in class-default and are policed with everything else.'] : []),
        ],
        before: ['show policy-map control-plane', 'show processes cpu sorted | exclude 0.00', 'show run | section control-plane'],
        config: [
          `ip access-list extended COPP-MANAGEMENT`,
          ...sourceList.v4.flatMap((s) => [
            ` permit tcp ${s.address} ${wildcard(s.prefix)} any eq 22`,
            ` permit udp ${s.address} ${wildcard(s.prefix)} any eq snmp`,
            ` permit udp ${s.address} ${wildcard(s.prefix)} any eq ntp`,
          ]),
          '!',
          'ip access-list extended COPP-ROUTING',
          ' permit ospf any any',
          ' permit tcp any any eq bgp',
          ' permit tcp any eq bgp any',
          ' permit eigrp any any',
          ' permit pim any any',
          '!',
          'ip access-list extended COPP-ICMP',
          ' permit icmp any any echo',
          ' permit icmp any any echo-reply',
          ' permit icmp any any ttl-exceeded',
          ' permit icmp any any unreachable',
          '!',
          // IPv6 twins. Protocol numbers where `ipv6 access-list` has no
          // keyword: 89 OSPFv3, 88 EIGRP, 103 PIM. Neighbour discovery sits
          // with routing, because policing it breaks every IPv6 neighbour.
          ...(v6
            ? [
                `ipv6 access-list COPP-MANAGEMENT${V6}`,
                ...sources6.flatMap((s) => [` permit tcp ${aclOperand(s)} any eq 22`, ` permit udp ${aclOperand(s)} any eq 161`, ` permit udp ${aclOperand(s)} any eq 123`]),
                '!',
                `ipv6 access-list COPP-ROUTING${V6}`,
                ' permit 89 any any',
                ' permit tcp any any eq 179',
                ' permit tcp any eq 179 any',
                ' permit 88 any any',
                ' permit 103 any any',
                ' permit icmp any any nd-na',
                ' permit icmp any any nd-ns',
                ' permit icmp any any router-advertisement',
                ' permit icmp any any router-solicitation',
                '!',
                `ipv6 access-list COPP-ICMP${V6}`,
                ' permit icmp any any echo-request',
                ' permit icmp any any echo-reply',
                ' permit icmp any any time-exceeded',
                ' permit icmp any any unreachable',
                ' permit icmp any any packet-too-big',
                '!',
              ]
            : []),
          ...classMap('COPP-MANAGEMENT'),
          ...classMap('COPP-ROUTING'),
          ...classMap('COPP-ICMP'),
          '!',
          'policy-map COPP',
          ' class COPP-ROUTING',
          ...(monitor ? [`${'!'}  police ${routing.bps} ${routing.burst} conform-action transmit exceed-action drop`] : [`  police ${routing.bps} ${routing.burst} conform-action transmit exceed-action drop`]),
          ' class COPP-MANAGEMENT',
          ...(monitor ? [`${'!'}  police ${ssh.bps} ${ssh.burst} conform-action transmit exceed-action drop`] : [`  police ${ssh.bps} ${ssh.burst} conform-action transmit exceed-action drop`]),
          ' class COPP-ICMP',
          ...(monitor ? [`${'!'}  police ${icmp.bps} ${icmp.burst} conform-action transmit exceed-action drop`] : [`  police ${icmp.bps} ${icmp.burst} conform-action transmit exceed-action drop`]),
          ' class class-default',
          ...(monitor || otherwise === 'monitor'
            ? [`${'!'}  police 32000 1500 conform-action transmit exceed-action drop`]
            : otherwise === 'drop'
              ? ['  drop']
              : ['  police 32000 1500 conform-action transmit exceed-action drop']),
          '!',
          'control-plane',
          ' service-policy input COPP',
          '!',
        ],
        verify: [
          'show policy-map control-plane',
          'show policy-map control-plane input class class-default',
          'show processes cpu sorted | exclude 0.00',
          `${'!'} From a management host: ssh to the device, and confirm routing adjacencies stayed up`,
          'show ip ospf neighbor',
          'show ip bgp summary',
        ],
        backout: [
          'control-plane',
          ' no service-policy input COPP',
          '!',
          'no policy-map COPP',
          'no class-map COPP-MANAGEMENT',
          'no class-map COPP-ROUTING',
          'no class-map COPP-ICMP',
          ...(v6 ? [`no ipv6 access-list COPP-MANAGEMENT${V6}`, `no ipv6 access-list COPP-ROUTING${V6}`, `no ipv6 access-list COPP-ICMP${V6}`] : []),
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_udld_errdisable',
    platform: PLATFORM,
    label: 'UDLD and errdisable recovery',
    group: 'Hardening',
    description: 'Catch a fibre that is only working one way, and decide which errdisable causes recover by themselves instead of waiting for someone.',
    inputs: [
      { id: 'udld_mode', label: 'UDLD mode', control: 'select', default: 'aggressive', options: [
        { value: 'aggressive', label: 'Aggressive — errdisable the port when the neighbour stops answering' },
        { value: 'normal', label: 'Normal — log it only' },
        { value: 'off', label: 'Off — recovery settings only' },
      ] },
      { id: 'udld_interfaces', label: 'Fibre interfaces', control: 'text', default: 'TenGigabitEthernet1/1/1-4', hint: 'UDLD belongs on fibre; copper has its own link detection' },
      { id: 'recover_causes', label: 'Recover automatically from', control: 'text', default: 'bpduguard, link-flap, psecure-violation, udld', hint: 'Comma separated' },
      { id: 'recover_interval', label: 'Recovery interval (seconds)', control: 'number', default: 300, min: 30, max: 86400 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const mode = str(values, 'udld_mode', 'aggressive');
      const ifaces = listOf(str(values, 'udld_interfaces', ''));
      const causes = listOf(str(values, 'recover_causes', ''));
      const interval = num(values, 'recover_interval', 300);
      const findings: Finding[] = [];
      if (causes.includes('all')) {
        findings.push(warning('network.ios.recover-all', 'Recovering from every cause includes the ones that are protecting you. A port errdisabled by BPDU guard on a loop will come back, loop again, and keep going round.', { remediation: 'Name the causes, and leave loop detection out unless someone is watching.', source: 'ArchToolKit' }));
      }
      if (interval < 60) {
        findings.push(warning('network.ios.recover-fast', 'A short recovery interval turns a hard failure into a flap, which is harder to find than the failure was.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: 'UDLD and errdisable recovery',
        impact: mode === 'aggressive' ? 'brief' : 'none',
        notes: [
          'UDLD needs the neighbour to run it too. On a link where only one end has it, aggressive mode will errdisable the port when the far end is simply not answering — which is exactly what it is for, and also exactly what a one-sided rollout looks like.',
          'Errdisable recovery does not fix the cause. It hides a recurring fault behind an automatic reset, so anything recovering repeatedly should be on a report.',
        ],
        before: ['show udld neighbors', 'show errdisable recovery', 'show interfaces status err-disabled'],
        config: [
          ...(mode !== 'off' ? [`udld ${mode === 'aggressive' ? 'aggressive' : 'enable'}`] : []),
          '!',
          ...(mode !== 'off' && ifaces.length > 0
            ? ifaces.flatMap((iface) => [`interface ${iface.includes('-') ? `range ${iface}` : iface}`, ` udld port ${mode === 'aggressive' ? 'aggressive' : 'enable'}`, '!'])
            : []),
          ...causes.map((cause) => `errdisable recovery cause ${cause}`),
          `errdisable recovery interval ${interval}`,
          '!',
        ],
        verify: ['show udld neighbors', 'show udld fast-hello', 'show errdisable recovery', 'show interfaces status err-disabled', 'show logging | include UDLD|ERR_DISABLE'],
        backout: [
          ...(mode !== 'off' ? [`no udld ${mode === 'aggressive' ? 'aggressive' : 'enable'}`] : []),
          ...causes.map((cause) => `no errdisable recovery cause ${cause}`),
          'no errdisable recovery interval',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_snmpv3',
    platform: PLATFORM,
    label: 'SNMPv3',
    group: 'Management',
    description: 'Replace a read-only community with an authenticated, encrypted SNMPv3 user restricted to one view and one manager.',
    inputs: [
      { id: 'group', label: 'Group name', control: 'text', default: 'MONITOR-RO' },
      { id: 'user', label: 'User name', control: 'text', default: 'monitoring' },
      { id: 'auth', label: 'Authentication', control: 'select', default: 'sha', options: [
        { value: 'sha', label: 'SHA' },
        { value: 'sha256', label: 'SHA-256 — where the platform supports it' },
      ] },
      { id: 'privacy', label: 'Encryption', control: 'select', default: 'aes 128', options: [
        { value: 'aes 128', label: 'AES-128' },
        { value: 'aes 256', label: 'AES-256 — where the platform supports it' },
        { value: 'none', label: 'None — authenticated but not encrypted' },
      ] },
      { id: 'manager', label: 'Manager address', control: 'text', default: '10.0.1.50', hint: 'IPv4, IPv6 or one of each' },
      { id: 'view', label: 'View', control: 'select', default: 'restricted', options: [
        { value: 'restricted', label: 'Interfaces, system and health only' },
        { value: 'iso', label: 'Everything readable' },
      ] },
      { id: 'remove_v2c', label: 'Remove the v2c communities', control: 'toggle', default: true },
      { id: 'source_interface', label: 'Source interface', control: 'text', default: 'Loopback0' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const group = str(values, 'group', 'MONITOR-RO');
      const user = str(values, 'user', 'monitoring');
      const auth = str(values, 'auth', 'sha');
      const privacy = str(values, 'privacy', 'aes 128');
      const managers = addressList(str(values, 'manager', ''));
      // A value that is not IPv6 stays on the IPv4 side, as it always did.
      const manager = managers.v4[0] ?? (managers.v6.length === 0 ? str(values, 'manager', '') : '');
      const manager6 = managers.v6[0];
      const acl6 = `SNMP-MANAGERS${V6}`;
      const access = `${manager6 ? ` access ipv6 ${acl6}` : manager ? ' access' : ''}${manager ? ' SNMP-MANAGERS' : ''}`;
      const view = str(values, 'view', 'restricted');
      const viewName = view === 'iso' ? 'FULL' : 'HEALTH';
      const findings: Finding[] = [];
      if (privacy === 'none') {
        findings.push(warning('network.ios.snmp-noencrypt', 'authNoPriv authenticates the manager but sends every reply in clear text, including the interface and configuration detail an attacker would want first.', { remediation: 'Use AES unless something genuinely cannot.', source: 'ArchToolKit' }));
      }
      if (!bool(values, 'remove_v2c', true)) {
        findings.push(warning('network.ios.snmp-v2c-left', 'A v2c community left in place is the way in, whatever v3 is configured alongside it.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `SNMPv3 user ${user}`,
        impact: 'none',
        notes: [
          'Both passphrases are prompted for rather than written here. Type them when you apply the change, and put them in the vault the playbook reads — never in the change record.',
          'An SNMPv3 user cannot be displayed after it is created. `show snmp user` shows the group and the algorithms, not the passphrases, so losing them means creating the user again.',
          ...(bool(values, 'remove_v2c', true) ? ['Removing the communities breaks any monitoring still polling with v2c. Confirm the platform has been moved to v3 first, or it goes quiet and nobody notices for a week.'] : []),
        ],
        before: ['show snmp user', 'show snmp group', 'show run | include snmp-server', 'show snmp host'],
        config: [
          ...(view === 'iso'
            ? [`snmp-server view ${viewName} iso included`]
            : [
                `snmp-server view ${viewName} system included`,
                `snmp-server view ${viewName} interfaces included`,
                `snmp-server view ${viewName} ip included`,
                `snmp-server view ${viewName} cisco included`,
              ]),
          '!',
          ...(manager
            ? [
                'ip access-list standard SNMP-MANAGERS',
                ` permit ${manager}`,
                ' deny   any log',
                '!',
              ]
            : []),
          ...(manager6 ? [`ipv6 access-list ${acl6}`, ` permit ipv6 host ${manager6} any`, ' deny ipv6 any any log', '!'] : []),
          `snmp-server group ${group} v3 ${privacy === 'none' ? 'auth' : 'priv'} read ${viewName}${access}`,
          `snmp-server user ${user} ${group} v3 auth ${auth} ${SECRET}${privacy === 'none' ? '' : ` priv ${privacy} ${SECRET}`}`,
          '!',
          ...(str(values, 'source_interface', '') ? [`snmp-server source-interface traps ${str(values, 'source_interface', '')}`] : []),
          ...(manager ? [`snmp-server host ${manager} version 3 ${privacy === 'none' ? 'auth' : 'priv'} ${user}`] : []),
          ...(manager6 ? [`snmp-server host ${manager6} version 3 ${privacy === 'none' ? 'auth' : 'priv'} ${user}`] : []),
          'snmp-server enable traps snmp linkdown linkup coldstart warmstart',
          'snmp-server enable traps config',
          '!',
          ...(bool(values, 'remove_v2c', true)
            ? [`${'!'} Remove every v2c string the device still has. The capture above lists them.`, `${'!'} no snmp-server community <name>`]
            : []),
        ],
        verify: [
          'show snmp user',
          'show snmp group',
          'show snmp host',
          `${'!'} From the manager: snmpwalk -v3 -l authPriv -u ${user} -a ${auth.toUpperCase()} -x AES <device> sysName`,
          'show run | include snmp-server community',
        ],
        backout: [
          `no snmp-server user ${user} ${group} v3`,
          `no snmp-server group ${group} v3 ${privacy === 'none' ? 'auth' : 'priv'}`,
          `no snmp-server view ${viewName}`,
          ...(manager ? [`no snmp-server host ${manager}`] : []),
          ...(manager6 ? [`no snmp-server host ${manager6}`, `no ipv6 access-list ${acl6}`] : []),
        ],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------------------- DMVPN */
  deviceBlueprint({
    id: 'ios_dmvpn',
    platform: PLATFORM,
    label: 'DMVPN hub or spoke',
    group: 'VPN',
    description: 'A multipoint GRE tunnel with NHRP and IPsec — the usual way a branch reaches head office over any circuit it happens to have.',
    inputs: [
      { id: 'role', label: 'This device is', control: 'select', default: 'spoke', options: [
        { value: 'hub', label: 'The hub' },
        { value: 'spoke', label: 'A spoke' },
      ] },
      { id: 'tunnel', label: 'Tunnel number', control: 'number', default: 100, min: 0, max: 2147483647 },
      { id: 'tunnel_address', label: 'Tunnel address', control: 'text', default: '10.254.0.11/24', hint: 'Every hub and spoke sits in this subnet. IPv4, IPv6 or one of each: 10.254.0.11/24, 2001:db8:fe::11/64' },
      { id: 'transport', label: 'Transport (underlay)', control: 'select', default: 'ipv4', options: [
        { value: 'ipv4', label: 'IPv4 — tunnel mode gre multipoint' },
        { value: 'ipv6', label: 'IPv6 — tunnel mode gre multipoint ipv6' },
      ] },
      { id: 'source_interface', label: 'Tunnel source interface', control: 'text', default: 'GigabitEthernet0/0/0' },
      { id: 'hub_public', label: 'Hub public address', control: 'text', default: '203.0.113.10', hint: 'Same family as the transport', showWhen: { input: 'role', equals: ['spoke'] } },
      { id: 'hub_tunnel', label: 'Hub tunnel address', control: 'text', default: '10.254.0.1', hint: 'One per tunnel family: 10.254.0.1, 2001:db8:fe::1', showWhen: { input: 'role', equals: ['spoke'] } },
      { id: 'network_id', label: 'NHRP network id', control: 'number', default: 100, min: 1, max: 4294967295 },
      { id: 'phase', label: 'Phase', control: 'select', default: '3', options: [
        { value: '3', label: 'Phase 3 — hub sends shortcuts, spokes build direct tunnels' },
        { value: '2', label: 'Phase 2 — spoke-to-spoke, no summarisation at the hub' },
        { value: '1', label: 'Phase 1 — everything via the hub' },
      ] },
      { id: 'routing', label: 'Routing over the tunnel', control: 'select', default: 'eigrp', options: [
        { value: 'eigrp', label: 'EIGRP' },
        { value: 'bgp', label: 'BGP' },
        { value: 'none', label: 'Static — no dynamic routing' },
      ] },
      { id: 'routing_id', label: 'EIGRP AS or BGP AS', control: 'number', default: 100, min: 1, showWhen: { input: 'routing', equals: ['eigrp', 'bgp'] } },
      { id: 'encrypt', label: 'Protect with IPsec', control: 'toggle', default: true },
      { id: 'mtu', label: 'Tunnel MTU', control: 'number', default: 1400, min: 576, max: 9216 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const hub = str(values, 'role', 'spoke') === 'hub';
      const tunnel = num(values, 'tunnel', 100);
      const addresses = cidrList(str(values, 'tunnel_address', ''));
      const cidr = addresses.v4[0];
      const cidr6: IosCidr | undefined = addresses.v6[0];
      const transport6 = str(values, 'transport', 'ipv4') === 'ipv6';
      const hubPublic = str(values, 'hub_public', '');
      const hubTunnels = addressList(str(values, 'hub_tunnel', ''));
      const hubTunnel = hubTunnels.v4[0] ?? hubTunnels.other[0] ?? '';
      const hubTunnel6 = hubTunnels.v6[0];
      const networkId = num(values, 'network_id', 100);
      const phase = str(values, 'phase', '3');
      const routing = str(values, 'routing', 'eigrp');
      const asn = num(values, 'routing_id', 100);
      const encrypt = bool(values, 'encrypt', true);
      const mtu = num(values, 'mtu', 1400);
      const findings: Finding[] = [...invalidEntries('network.ios.bad-address', 'Tunnel address', addresses.invalid)];
      if (!cidr && !cidr6) findings.push(error('network.ios.bad-address', 'The tunnel address is not a valid address and prefix.', { source: 'ArchToolKit' }));
      if (!hub && familyOf(hubPublic) !== null && familyOf(hubPublic) !== (transport6 ? 6 : 4)) {
        findings.push(error('network.ios.dmvpn-transport-family', `The hub public address ${hubPublic} is not IPv${transport6 ? 6 : 4}, but the transport is. The NBMA address has to be in the transport family.`, { source: 'ArchToolKit' }));
      }
      if (!hub && cidr6 && !hubTunnel6) {
        findings.push(error('network.ios.dmvpn-no-hub6', 'The tunnel has an IPv6 address but no IPv6 hub tunnel address was given, so the spoke cannot register for IPv6 and no IPv6 NHRP was written.', { remediation: 'Add the hub’s IPv6 tunnel address, such as 2001:db8:fe::1.', source: 'ArchToolKit' }));
      }
      if (cidr6 && cidr6.prefix !== 64) {
        findings.push(warning('network.ios.dmvpn-subnet6', 'An IPv6 DMVPN overlay is normally a /64 shared by the hub and every spoke.', { source: 'ArchToolKit' }));
      }
      // With no IPv6 overlay this is the IPv4 tunnel it always was.
      const v4 = !!cidr || !cidr6;
      const write6 = !!cidr6 && (hub || !!hubTunnel6);
      if (cidr && cidr.prefix > 24) {
        findings.push(warning('network.ios.dmvpn-subnet', 'Every hub and spoke shares the tunnel subnet. A prefix this small will run out of spokes.', { source: 'ArchToolKit' }));
      }
      if (!encrypt) {
        findings.push(warning('network.ios.dmvpn-clear', 'GRE without IPsec carries everything in clear over whatever circuit this is. That is only acceptable on a private circuit that is already encrypted.', { source: 'ArchToolKit' }));
      }
      if (mtu > 1400) {
        findings.push(warning('network.ios.dmvpn-mtu', 'GRE and IPsec overhead comes off the path MTU. Above about 1400 the tunnel works until something sends a full-size packet with DF set, and then it does not.', { remediation: 'Set the tunnel MTU to 1400 and the TCP MSS to 1360.', source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `DMVPN ${hub ? 'hub' : 'spoke'} on Tunnel${tunnel}`,
        impact: 'brief',
        notes: [
          'The pre-shared key is `<REQUIRED>` here and must match at both ends. Put it in the vault the playbook reads, not in the change record.',
          'Phase 3 needs `ip nhrp redirect` on the hub and `ip nhrp shortcut` on the spokes. A mismatched pair gives tunnels that come up and then never build spoke-to-spoke.',
          ...(hub ? ['The hub keeps the NHRP registrations. Rebuilding its tunnel drops every spoke until they re-register, which takes one registration interval.'] : ['A spoke registers itself with the hub. If the tunnel comes up but no routes arrive, look at NHRP before looking at the routing protocol.']),
          ...(routing === 'eigrp' && hub ? ['Split horizon is off on the hub tunnel so spokes learn each other’s prefixes, and the next hop is left alone so traffic does not trombone through the hub.'] : []),
          ...(write6 ? ['IPv6 routing over the tunnel peers on link-local addresses, which must be unique on the tunnel. If two routers generate the same one, set it by hand: `ipv6 address fe80::<site> link-local`. `ipv6 unicast-routing` must be on.'] : []),
          ...(transport6 ? ['The transport is IPv6: the tunnel source interface needs an IPv6 address, and the hub and every spoke must run `tunnel mode gre multipoint ipv6`.'] : []),
        ],
        before: ['show dmvpn detail', 'show ip nhrp', `show run interface Tunnel${tunnel}`, 'show crypto session', 'show ip route'],
        config: [
          ...(encrypt
            ? [
                'crypto ikev2 proposal DMVPN-PROPOSAL',
                ' encryption aes-cbc-256',
                ' integrity sha256',
                ' group 14',
                '!',
                'crypto ikev2 policy DMVPN-POLICY',
                ' proposal DMVPN-PROPOSAL',
                '!',
                'crypto ikev2 keyring DMVPN-KEYRING',
                ' peer ANY',
                transport6 ? '  address ::/0' : '  address 0.0.0.0 0.0.0.0',
                `  pre-shared-key ${SECRET}`,
                '!',
                'crypto ikev2 profile DMVPN-PROFILE',
                transport6 ? ' match identity remote address ::/0' : ' match identity remote address 0.0.0.0',
                ' authentication local pre-share',
                ' authentication remote pre-share',
                ' keyring local DMVPN-KEYRING',
                '!',
                'crypto ipsec transform-set DMVPN-TS esp-aes 256 esp-sha256-hmac',
                ' mode transport',
                '!',
                'crypto ipsec profile DMVPN-IPSEC',
                ' set transform-set DMVPN-TS',
                ' set ikev2-profile DMVPN-PROFILE',
                '!',
              ]
            : []),
          `interface Tunnel${tunnel}`,
          ` description DMVPN ${hub ? 'hub' : 'spoke'}`,
          ...(v4
            ? [
                ...(cidr ? [` ip address ${cidr.address} ${netmask(cidr.prefix)}`] : []),
                ` ip mtu ${mtu}`,
                ` ip tcp adjust-mss ${mtu - 40}`,
                ` ip nhrp network-id ${networkId}`,
                ' ip nhrp holdtime 600',
                ...(hub
                  ? [
                      ' ip nhrp map multicast dynamic',
                      ...(phase === '3' ? [' ip nhrp redirect'] : []),
                      ...(routing === 'eigrp' ? [` no ip split-horizon eigrp ${asn}`, ...(phase === '1' ? [` ip next-hop-self eigrp ${asn}`] : [` no ip next-hop-self eigrp ${asn}`])] : []),
                    ]
                  : [
                      ` ip nhrp nhs ${hubTunnel} nbma ${hubPublic} multicast`,
                      ...(phase === '3' ? [' ip nhrp shortcut'] : []),
                    ]),
              ]
            : []),
          // IPv6 inside the tunnel: the same NHRP, under `ipv6 nhrp`, with
          // IPv6 EIGRP enabled on the interface rather than by a network line.
          ...(write6
            ? [
                ...interfaceAddressLines(undefined, [cidr6!]),
                ` ipv6 mtu ${mtu}`,
                ` ipv6 tcp adjust-mss ${mtu - 60}`,
                ` ipv6 nhrp network-id ${networkId}`,
                ' ipv6 nhrp holdtime 600',
                ...(hub
                  ? [
                      ' ipv6 nhrp map multicast dynamic',
                      ...(phase === '3' ? [' ipv6 nhrp redirect'] : []),
                      ...(routing === 'eigrp' ? [` ipv6 eigrp ${asn}`, ` no ipv6 split-horizon eigrp ${asn}`, ...(phase === '1' ? [] : [` no ipv6 next-hop-self eigrp ${asn}`])] : []),
                    ]
                  : [
                      ` ipv6 nhrp nhs ${hubTunnel6} nbma ${hubPublic} multicast`,
                      ...(phase === '3' ? [' ipv6 nhrp shortcut'] : []),
                      ...(routing === 'eigrp' ? [` ipv6 eigrp ${asn}`] : []),
                    ]),
              ]
            : []),
          ` tunnel source ${str(values, 'source_interface', '')}`,
          transport6 ? ' tunnel mode gre multipoint ipv6' : ' tunnel mode gre multipoint',
          ` tunnel key ${networkId}`,
          ...(encrypt ? [' tunnel protection ipsec profile DMVPN-IPSEC'] : []),
          '!',
          ...(routing === 'eigrp' && cidr
            ? [`router eigrp ${asn}`, ` network ${cidr.address} ${wildcard(cidr.prefix)}`, ' no auto-summary', '!']
            : []),
          ...(routing === 'eigrp' && write6 ? [`ipv6 router eigrp ${asn}`, ' no shutdown', '!'] : []),
          ...(routing === 'bgp'
            ? [
                `router bgp ${asn}`,
                ...(v4 ? [` bgp listen range ${cidr ? `${cidr.address}/${cidr.prefix}` : '10.254.0.0/24'} peer-group SPOKES`, ' neighbor SPOKES peer-group', ` neighbor SPOKES remote-as ${asn}`] : []),
                // IPv6 spokes in their own peer group, activated in the IPv6 family.
                ...(write6
                  ? [
                      ` bgp listen range ${cidr6!.network}/${cidr6!.prefix} peer-group SPOKES${V6}`,
                      ` neighbor SPOKES${V6} peer-group`,
                      ` neighbor SPOKES${V6} remote-as ${asn}`,
                      ' address-family ipv6 unicast',
                      `  neighbor SPOKES${V6} activate`,
                      ' exit-address-family',
                    ]
                  : []),
                '!',
              ]
            : []),
        ],
        verify: [
          'show dmvpn detail',
          ...(v4 ? ['show ip nhrp'] : []),
          ...(write6 ? ['show ipv6 nhrp'] : []),
          'show crypto ikev2 sa',
          'show crypto ipsec sa',
          ...(routing === 'eigrp' ? [`show ip eigrp neighbors`] : routing === 'bgp' ? ['show ip bgp summary'] : []),
          ...(write6 && routing === 'eigrp' ? ['show ipv6 eigrp neighbors'] : write6 && routing === 'bgp' ? ['show bgp ipv6 unicast summary'] : []),
          `ping ${hub ? '<a spoke tunnel address>' : hubTunnel || hubTunnel6} source Tunnel${tunnel}`,
        ],
        backout: [`interface Tunnel${tunnel}`, ' shutdown', '!', `no interface Tunnel${tunnel}`, ...(encrypt ? ['no crypto ipsec profile DMVPN-IPSEC', 'no crypto ikev2 profile DMVPN-PROFILE', 'no crypto ikev2 keyring DMVPN-KEYRING'] : [])],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------------- VLAN database */
  deviceBlueprint({
    id: 'ios_vtp',
    platform: PLATFORM,
    label: 'VTP mode and domain',
    group: 'Switching',
    description: 'Decide how this switch learns VLANs — and in almost every case, that it does not: transparent or off, so a switch arriving with a higher revision number cannot wipe the VLAN database.',
    inputs: [
      { id: 'mode', label: 'Mode', control: 'select', default: 'transparent', options: [
        { value: 'transparent', label: 'Transparent — keeps its own VLANs, passes advertisements through' },
        { value: 'off', label: 'Off — does not even forward advertisements' },
        { value: 'server', label: 'Server — the domain’s source of VLANs' },
        { value: 'client', label: 'Client — takes VLANs from a server' },
      ] },
      { id: 'domain', label: 'Domain', control: 'text', default: 'CAMPUS', showWhen: { input: 'mode', notEquals: ['off'] } },
      { id: 'version', label: 'Version', control: 'select', default: '3', options: [
        { value: '3', label: 'Version 3 — primary server has to be claimed explicitly' },
        { value: '2', label: 'Version 2' },
        { value: '1', label: 'Version 1' },
      ] },
      { id: 'pruning', label: 'Pruning', control: 'toggle', default: false, hint: 'Server and client modes only' },
      { id: 'vlans', label: 'VLANs to create locally', control: 'text', default: '10,20,30', hint: 'Transparent and server modes' },
      { id: 'vlan_prefix', label: 'VLAN name prefix', control: 'text', default: 'VLAN' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const mode = str(values, 'mode', 'transparent');
      const version = str(values, 'version', '3');
      const domain = str(values, 'domain', 'CAMPUS');
      const vlans = vlanIds(str(values, 'vlans', ''));
      const prefix = str(values, 'vlan_prefix', 'VLAN');
      const findings: Finding[] = [];
      if (mode === 'server' || mode === 'client') {
        findings.push(warning('network.ios.vtp-propagating', 'In server or client mode this switch takes its VLAN database from the domain. A switch plugged in with a higher revision number and a smaller database will delete VLANs across the whole domain, and the ports in them go dead.', { remediation: 'Transparent or off is the safe answer unless the domain genuinely depends on VTP. Version 3 with one claimed primary server is the next best.', source: 'ArchToolKit' }));
      }
      if (mode === 'client' && vlans.length > 0) {
        findings.push(error('network.ios.vtp-client-vlans', 'A VTP client cannot create VLANs locally — the ones listed here would be rejected.', { remediation: 'Create them on the server, or put this switch in transparent mode.', source: 'ArchToolKit' }));
      }
      if (bool(values, 'pruning', false) && (mode === 'transparent' || mode === 'off')) {
        findings.push(warning('network.ios.vtp-pruning-moot', 'Pruning does nothing in transparent or off mode. Trim trunks with an allowed VLAN list instead.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `VTP ${mode}${mode === 'off' ? '' : ` in domain ${domain}`}`,
        impact: mode === 'client' || mode === 'server' ? 'outage' : 'brief',
        notes: [
          'Changing VTP mode resets the revision number, which is the point. Write down the VLAN database before the change — `show vlan brief` — because that is what you will be rebuilding from if it goes wrong.',
          'Version 3 will not let a switch become primary server by accident: it has to be claimed from exec mode with `vtp primary`. That is the one version worth running if VTP is running at all.',
          ...(mode === 'transparent' ? ['In transparent mode the VLANs live in the running configuration, so they are in the backup with everything else. That alone is a good reason for it.'] : []),
        ],
        before: ['show vtp status', 'show vtp password', 'show vlan brief', 'show interfaces trunk'],
        config: [
          `vtp version ${version}`,
          ...(mode === 'off' ? ['vtp mode off'] : [`vtp domain ${domain}`, `vtp mode ${mode}`]),
          ...(bool(values, 'pruning', false) && (mode === 'server' || mode === 'client') ? ['vtp pruning'] : []),
          '!',
          ...(mode === 'transparent' || mode === 'server' || mode === 'off'
            ? vlans.flatMap((vlan) => [`vlan ${vlan}`, ` name ${prefix}${vlan}`, '!'])
            : []),
          ...(version === '3' && mode === 'server' ? [`${'!'} Then, from exec mode: vtp primary vlan`] : []),
        ],
        verify: ['show vtp status', 'show vlan brief', 'show interfaces trunk', `${'!'} Confirm the revision number and that the VLAN list is the one you expected`],
        backout: [`${'!'} Restore the previous mode and domain from the capture taken above`, 'vtp mode transparent', ...vlans.map((vlan) => `vlan ${vlan}`)],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_stackwise',
    platform: PLATFORM,
    label: 'Switch stack membership and priority',
    group: 'Switching',
    description: 'Set which member of a stack is active, provision a member before it arrives, or renumber one — the three things anyone ever does to a stack.',
    inputs: [
      { id: 'action', label: 'Action', control: 'select', default: 'priority', options: [
        { value: 'priority', label: 'Set priorities so the active switch is predictable' },
        { value: 'provision', label: 'Provision a member that is not plugged in yet' },
        { value: 'renumber', label: 'Renumber a member' },
      ] },
      { id: 'members', label: 'Members', control: 'number', default: 3, min: 1, max: 9, showWhen: { input: 'action', equals: ['priority'] } },
      { id: 'active_member', label: 'Preferred active switch', control: 'number', default: 1, min: 1, max: 9, showWhen: { input: 'action', equals: ['priority'] } },
      { id: 'member', label: 'Member number', control: 'number', default: 4, min: 1, max: 9, showWhen: { input: 'action', equals: ['provision', 'renumber'] } },
      { id: 'model', label: 'Model', control: 'text', default: 'C9300-48P', showWhen: { input: 'action', equals: ['provision'] } },
      { id: 'new_number', label: 'New member number', control: 'number', default: 2, min: 1, max: 9, showWhen: { input: 'action', equals: ['renumber'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const action = str(values, 'action', 'priority');
      const members = num(values, 'members', 3);
      const preferred = num(values, 'active_member', 1);
      const member = num(values, 'member', 4);
      const findings: Finding[] = [];
      if (action === 'priority' && preferred > members) {
        findings.push(error('network.ios.stack-member-range', 'The preferred active switch is not one of the members.', { source: 'ArchToolKit' }));
      }
      if (action === 'renumber') {
        findings.push(warning('network.ios.stack-renumber', 'Renumbering takes a reload of that member, and every interface on it changes name. Any configuration referring to the old numbers — interface ranges, port-channels, descriptions — has to be rewritten to match.', { source: 'ArchToolKit' }));
      }
      if (action === 'provision') {
        findings.push(warning('network.ios.stack-provision-model', 'The provisioned model has to match what actually arrives. A mismatch leaves the configuration applied to a member that will never come up.', { remediation: 'Take the model string from `show inventory` on an identical switch.', source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title:
          action === 'priority'
            ? `Stack priorities, member ${preferred} preferred`
            : action === 'provision'
              ? `Provision stack member ${member}`
              : `Renumber member ${member} to ${num(values, 'new_number', 2)}`,
        impact: action === 'renumber' ? 'outage' : 'none',
        notes: [
          'Priority does not cause a failover on its own — the active switch stays active until it reloads. Setting it is how you decide which switch comes back as active next time, not a change you can watch take effect.',
          'The member with the highest priority wins; ties go to the longest uptime, then the lowest MAC. Leaving every member at the default is how a stack ends up with an active switch nobody chose.',
          ...(action === 'renumber' ? ['The renumber command is exec mode, not configuration, and it takes effect on reload. Nothing here is in the running configuration to back out.'] : []),
        ],
        before: ['show switch detail', 'show switch stack-ports', 'show inventory', 'show redundancy'],
        config:
          action === 'priority'
            ? Array.from({ length: Math.max(1, members) }, (_, i) => {
                const number = i + 1;
                const priority = number === preferred ? 15 : Math.max(1, 14 - i);
                return `switch ${number} priority ${priority}`;
              }).concat('!')
            : action === 'provision'
              ? [`switch ${member} provision ${str(values, 'model', '')}`, '!']
              : [
                  `${'!'} Exec mode, not configuration:`,
                  `${'!'} switch ${member} renumber ${num(values, 'new_number', 2)}`,
                  `${'!'} Then: reload slot ${member}`,
                  '!',
                ],
        verify: ['show switch detail', 'show switch stack-ports summary', 'show module', ...(action === 'provision' ? ['show run | include provision'] : [])],
        backout:
          action === 'priority'
            ? Array.from({ length: Math.max(1, members) }, (_, i) => `switch ${i + 1} priority 1`)
            : action === 'provision'
              ? [`no switch ${member} provision`]
              : [`${'!'} switch ${num(values, 'new_number', 2)} renumber ${member}, then reload that member`],
        findings,
      };
    },
  }),

  /* ----------------------------------------------------------- Routing policy */
  deviceBlueprint({
    id: 'ios_prefix_list_routemap',
    platform: PLATFORM,
    label: 'Prefix list and route-map',
    group: 'Routing',
    description: 'The filter itself, separate from whatever applies it: a prefix list of what may pass and a route-map that sets what it looks like on the way through.',
    inputs: [
      { id: 'list_name', label: 'Prefix list name', control: 'text', default: 'PL-CUSTOMER-IN' },
      { id: 'prefixes', label: 'Prefixes', control: 'textarea', default: '10.10.0.0/16 le 24\n10.20.0.0/16', hint: 'One per line, with optional ge/le. IPv6 prefixes (2001:db8::/32 le 48) go into a separate IPv6 prefix list' },
      { id: 'default_action', label: 'Anything not listed', control: 'select', default: 'deny', options: [
        { value: 'deny', label: 'Deny — an allow list' },
        { value: 'permit', label: 'Permit — a deny list' },
      ] },
      { id: 'map_name', label: 'Route-map name', control: 'text', default: 'RM-CUSTOMER-IN' },
      { id: 'set_local_pref', label: 'Set local preference', control: 'number', default: 0, min: 0, max: 4294967295, hint: '0 to leave it alone' },
      { id: 'set_med', label: 'Set MED', control: 'number', default: 0, min: 0, hint: '0 to leave it alone' },
      { id: 'set_community', label: 'Set BGP community', control: 'text', default: '', hint: 'e.g. 65001:100 — empty to leave it alone' },
      { id: 'prepend', label: 'AS prepends', control: 'number', default: 0, min: 0, max: 10 },
      { id: 'local_as', label: 'Local AS to prepend', control: 'number', default: 65001, min: 1, showWhen: { input: 'prepend', notEquals: ['0', ''] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const list = str(values, 'list_name', 'PL-IN').toUpperCase();
      const map = str(values, 'map_name', 'RM-IN').toUpperCase();
      const lines = str(values, 'prefixes', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const deny = str(values, 'default_action', 'deny') === 'deny';
      const localPref = num(values, 'set_local_pref', 0);
      const med = num(values, 'set_med', 0);
      const community = str(values, 'set_community', '');
      const prepend = num(values, 'prepend', 0);
      const findings: Finding[] = [];
      if (lines.length === 0) {
        findings.push(error('network.ios.no-prefixes', 'A prefix list with no entries denies everything, which is almost certainly not what was meant.', { source: 'ArchToolKit' }));
      }
      for (const line of lines) {
        if (!parseCidrDual(line.split(/\s+/)[0] ?? '')) {
          findings.push(error('network.ios.bad-prefix', `"${line}" is not a prefix. Write it as 10.10.0.0/16 or 2001:db8::/32, optionally followed by ge or le.`, { source: 'ArchToolKit' }));
        }
      }
      // IPv4 and IPv6 cannot share a prefix list: IPv6 lines build their own
      // `ipv6 prefix-list` and route-map entry, next to the IPv4 ones.
      const lines6 = lines.filter((line) => parseCidrDual(line.split(/\s+/)[0] ?? '')?.family === 6);
      const lines4 = lines.filter((line) => !lines6.includes(line));
      const v6 = lines6.length > 0;
      const v4 = lines4.length > 0 || !v6;
      const list6 = `${list}${V6}`;
      const setLines = [
        ...(localPref > 0 ? [` set local-preference ${localPref}`] : []),
        ...(med > 0 ? [` set metric ${med}`] : []),
        ...(community ? [` set community ${community}`] : []),
        ...(prepend > 0 ? [` set as-path prepend${` ${num(values, 'local_as', 65001)}`.repeat(prepend)}`] : []),
      ];
      if (!deny) {
        findings.push(warning('network.ios.permit-default', 'Permitting anything not listed makes this a deny list. On a peering session that is how a full table arrives when someone adds a prefix you did not expect.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Prefix list ${list} and route-map ${map}`,
        impact: 'none',
        notes: [
          'This builds the filter but does not apply it. Applying it to a BGP neighbour is a separate change, and it is the one with the impact — clear the session soft in one direction and watch the table.',
          'A prefix list ends with an implicit deny. The final entry here makes that explicit so nobody has to remember it.',
          ...(prepend > 0 ? ['Prepending makes a path less attractive to whoever receives it. It does not change anything about how this device chooses a path.'] : []),
        ],
        before: [...(v4 ? [`show ip prefix-list ${list}`] : []), ...(v6 ? [`show ipv6 prefix-list ${list6}`] : []), `show route-map ${map}`, 'show ip bgp neighbors | include Inbound|Outbound'],
        config: [
          ...(v4
            ? [
                `no ip prefix-list ${list}`,
                ...lines4.map((line, index) => `ip prefix-list ${list} seq ${(index + 1) * 5} permit ${line}`),
                ...(deny ? [`ip prefix-list ${list} seq ${(lines4.length + 1) * 5} deny 0.0.0.0/0 le 32`] : [`ip prefix-list ${list} seq ${(lines4.length + 1) * 5} permit 0.0.0.0/0 le 32`]),
                '!',
              ]
            : []),
          ...(v6
            ? [
                `no ipv6 prefix-list ${list6}`,
                ...lines6.map((line, index) => `ipv6 prefix-list ${list6} seq ${(index + 1) * 5} permit ${line}`),
                `ipv6 prefix-list ${list6} seq ${(lines6.length + 1) * 5} ${deny ? 'deny' : 'permit'} ::/0 le 128`,
                '!',
              ]
            : []),
          ...(v4 ? [`route-map ${map} permit 10`, ` match ip address prefix-list ${list}`, ...setLines, '!'] : []),
          ...(v6 ? [`route-map ${map} permit 15`, ` match ipv6 address prefix-list ${list6}`, ...setLines, '!'] : []),
          ...(deny ? [`route-map ${map} deny 20`, '!'] : [`route-map ${map} permit 20`, '!']),
        ],
        verify: [
          ...(v4 ? [`show ip prefix-list ${list}`] : []),
          ...(v6 ? [`show ipv6 prefix-list ${list6}`] : []),
          `show route-map ${map}`,
          `${'!'} Once applied: clear ip bgp <neighbour> soft in`,
          'show ip bgp neighbors <neighbour> routes',
          'show ip bgp neighbors <neighbour> received-routes',
        ],
        backout: [`no route-map ${map}`, ...(v4 ? [`no ip prefix-list ${list}`] : []), ...(v6 ? [`no ipv6 prefix-list ${list6}`] : [])],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_bfd',
    platform: PLATFORM,
    label: 'BFD for fast failure detection',
    group: 'Routing',
    description: 'Detect a dead neighbour in milliseconds instead of waiting out a routing protocol’s hold time — the difference between a sub-second reroute and forty seconds of black hole.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'GigabitEthernet1/0/24' },
      { id: 'interval', label: 'Transmit interval (ms)', control: 'number', default: 300, min: 50, max: 9000 },
      { id: 'min_rx', label: 'Minimum receive interval (ms)', control: 'number', default: 300, min: 50, max: 9000 },
      { id: 'multiplier', label: 'Multiplier', control: 'number', default: 3, min: 3, max: 50 },
      { id: 'protocol', label: 'Attach to', control: 'select', default: 'ospf', options: [
        { value: 'ospf', label: 'OSPF' },
        { value: 'bgp', label: 'BGP' },
        { value: 'eigrp', label: 'EIGRP' },
        { value: 'static', label: 'A static route' },
      ] },
      { id: 'process', label: 'Process or AS', control: 'number', default: 1, min: 1, showWhen: { input: 'protocol', equals: ['ospf', 'eigrp', 'bgp'] } },
      { id: 'neighbor', label: 'Neighbour address', control: 'text', default: '10.0.12.2', hint: 'IPv4 or IPv6', showWhen: { input: 'protocol', equals: ['bgp', 'static'] } },
      { id: 'echo', label: 'Echo mode', control: 'toggle', default: false, hint: 'Lower CPU, but needs the neighbour to loop the packets back' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const interval = num(values, 'interval', 300);
      const minRx = num(values, 'min_rx', 300);
      const multiplier = num(values, 'multiplier', 3);
      const protocol = str(values, 'protocol', 'ospf');
      const process = num(values, 'process', 1);
      const findings: Finding[] = [];
      if (ifaces.length === 0) findings.push(error('network.ios.no-interfaces', 'No interface was named to run BFD on.', { source: 'ArchToolKit' }));
      if (interval < 150) {
        findings.push(warning('network.ios.bfd-aggressive', `A ${interval}ms interval with a multiplier of ${multiplier} declares the neighbour dead after ${(interval * multiplier) / 1000}s. On a platform that processes BFD in software, a busy CPU will trip that on its own and flap the adjacency.`, { remediation: 'Confirm the platform does BFD in hardware before going below 150ms.', source: 'ArchToolKit' }));
      }
      if (multiplier < 3) {
        findings.push(warning('network.ios.bfd-multiplier', 'A multiplier below 3 means one lost packet is a dead neighbour.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `BFD on ${ifaces.join(', ') || 'no interface'} for ${protocol.toUpperCase()}`,
        impact: 'brief',
        notes: [
          'Both ends have to run BFD. Configured on one side only, the session stays down and the routing protocol carries on with its own timers — no harm, but no benefit either.',
          `Failure is declared after interval × multiplier: ${(interval * multiplier) / 1000} seconds with these numbers.`,
          'Turning BFD on for an existing adjacency can bounce it once as the session comes up. Do it on one link at a time in a redundant pair.',
        ],
        before: ['show bfd neighbors details', ...ifaces.map((i) => `show run interface ${i}`), `show ip ${protocol === 'bgp' ? 'bgp summary' : protocol === 'eigrp' ? 'eigrp neighbors' : 'ospf neighbor'}`],
        config: [
          ...ifaces.flatMap((iface) => [
            `interface ${iface}`,
            ` bfd interval ${interval} min_rx ${minRx} multiplier ${multiplier}`,
            ...(bool(values, 'echo', false) ? [' bfd echo'] : [' no bfd echo']),
            '!',
          ]),
          ...(protocol === 'ospf' ? [`router ospf ${process}`, ' bfd all-interfaces', '!'] : []),
          ...(protocol === 'eigrp' ? [`router eigrp ${process}`, ...ifaces.map((i) => ` bfd interface ${i}`), '!'] : []),
          ...(protocol === 'bgp' ? [`router bgp ${process}`, ` neighbor ${str(values, 'neighbor', '')} fall-over bfd`, '!'] : []),
          ...(protocol === 'static' ? [...ifaces.map((i) => `${familyOf(str(values, 'neighbor', '')) === 6 ? 'ipv6' : 'ip'} route static bfd ${i} ${str(values, 'neighbor', '')}`), '!'] : []),
        ],
        verify: ['show bfd neighbors details', 'show bfd summary', `show ip ${protocol === 'bgp' ? 'bgp summary' : protocol === 'eigrp' ? 'eigrp neighbors' : 'ospf neighbor'}`, `${'!'} Pull the far end’s cable and time the reconvergence`],
        backout: [
          ...(protocol === 'ospf' ? [`router ospf ${process}`, ' no bfd all-interfaces', '!'] : []),
          ...(protocol === 'bgp' ? [`router bgp ${process}`, ` no neighbor ${str(values, 'neighbor', '')} fall-over bfd`, '!'] : []),
          ...ifaces.flatMap((iface) => [`interface ${iface}`, ` no bfd interval ${interval} min_rx ${minRx} multiplier ${multiplier}`, '!']),
        ],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------------------ Services */
  deviceBlueprint({
    id: 'ios_dhcp_relay',
    platform: PLATFORM,
    label: 'DHCP relay',
    group: 'Services',
    description: 'Point a VLAN at DHCP servers somewhere else, with the option 82 and snooping decisions that come with it.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Vlan10, Vlan20', hint: 'The SVI the clients are on' },
      { id: 'servers', label: 'DHCP servers', control: 'text', default: '10.0.1.10, 10.0.2.10', hint: 'Two is the usual answer. IPv6 servers get an ipv6 dhcp relay destination' },
      { id: 'source_interface', label: 'Relay source interface', control: 'text', default: '', hint: 'Empty to use the SVI address, which is normally right' },
      { id: 'option_82', label: 'Insert option 82', control: 'select', default: 'off', options: [
        { value: 'off', label: 'Off — the server does not use it' },
        { value: 'on', label: 'On — the server keys on circuit id' },
      ] },
      { id: 'snooping', label: 'Also enable DHCP snooping', control: 'toggle', default: false },
      { id: 'trusted', label: 'Trusted uplinks', control: 'text', default: 'Port-channel1', showWhen: { input: 'snooping', equals: ['true'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const all = addressList(str(values, 'servers', ''));
      // Anything that is not IPv6 stays a helper address, as it always did.
      const servers = [...all.v4, ...all.other];
      const servers6 = all.v6;
      const source = str(values, 'source_interface', '');
      const option82 = str(values, 'option_82', 'off') === 'on';
      const snooping = bool(values, 'snooping', false);
      const trusted = listOf(str(values, 'trusted', ''));
      const findings: Finding[] = [];
      if (servers.length === 0 && servers6.length === 0) findings.push(error('network.ios.no-servers', 'No DHCP server address was given, so clients on these VLANs would get no address at all.', { source: 'ArchToolKit' }));
      if (servers6.length > 0 && snooping) {
        findings.push(warning('network.ios.snooping-v4-only', 'DHCP snooping watches DHCPv4 only. The IPv6 relay is not protected by it — DHCPv6 guard is the IPv6 equivalent and is configured separately.', { source: 'ArchToolKit' }));
      }
      if (servers6.length === 1) {
        findings.push(warning('network.ios.single-dhcp6', 'One IPv6 relay destination means one server failure takes IPv6 addressing down for this VLAN.', { source: 'ArchToolKit' }));
      }
      if (servers.length === 1) {
        findings.push(warning('network.ios.single-dhcp', 'One relay destination means one server failure takes addressing down for this VLAN.', { source: 'ArchToolKit' }));
      }
      if (snooping && trusted.length === 0) {
        findings.push(error('network.ios.snooping-no-trust', 'DHCP snooping with no trusted port drops the offers coming back from the server, and every client on the VLAN loses its address as its lease expires.', { remediation: 'Trust the uplink the server is reached through before enabling snooping.', source: 'ArchToolKit' }));
      }
      if (option82 && !snooping) {
        findings.push(warning('network.ios.option82-relay', 'Many servers drop a relayed packet carrying option 82 from an untrusted relay, and IOS drops option 82 packets arriving on an untrusted port by default. Confirm both ends agree before turning this on.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `DHCP relay to ${[...servers, ...servers6].join(', ')}`,
        impact: 'brief',
        notes: [
          'Existing leases survive this. The effect shows up at renewal, which means a mistake here can look fine for hours and then take a floor out at lunchtime.',
          'The server needs a scope for the subnet the relay is coming from, selected by the giaddr — the SVI address, unless a source interface says otherwise.',
          ...(servers6.length > 0 ? ['The IPv6 relay stamps the interface’s global IPv6 address into each request so the DHCPv6 server can pick a scope. Each interface needs one, and router advertisements with the managed or other-config flag set (the "IPv6 on an interface" change) so hosts ask at all.'] : []),
          ...(snooping ? ['Snooping builds its binding table from traffic it sees. Clients already holding a lease are not in it until they renew, so anything that depends on the table — dynamic ARP inspection, IP source guard — has to wait or be seeded.'] : []),
        ],
        before: [...ifaces.map((i) => `show run interface ${i}`), 'show ip dhcp snooping', 'show ip dhcp snooping binding'],
        config: [
          ...(snooping
            ? [
                'ip dhcp snooping',
                `ip dhcp snooping vlan ${ifaces.map((i) => i.replace(/\D/g, '')).filter(Boolean).join(',')}`,
                ...(option82 ? [] : ['no ip dhcp snooping information option']),
                '!',
                ...trusted.flatMap((iface) => [`interface ${iface}`, ' ip dhcp snooping trust', '!']),
              ]
            : []),
          ...ifaces.flatMap((iface) => [
            `interface ${iface}`,
            ...servers.map((server) => ` ip helper-address ${server}`),
            ...(source && servers.length > 0 ? [` ip dhcp relay source-interface ${source}`] : []),
            ...servers6.map((server) => ` ipv6 dhcp relay destination ${server}`),
            ...(source && servers6.length > 0 ? [` ipv6 dhcp relay source-interface ${source}`] : []),
            '!',
          ]),
          ...(option82 && !snooping ? ['ip dhcp relay information option', '!'] : []),
        ],
        verify: [
          ...ifaces.map((i) => `show run interface ${i} | include helper${servers6.length > 0 ? '|relay' : ''}`),
          ...(servers6.length > 0 ? ['show ipv6 dhcp relay binding'] : []),
          'show ip dhcp snooping',
          'show ip dhcp snooping binding',
          'debug ip dhcp server packet   ! briefly, while one client renews',
          `${'!'} From a client: release and renew, and confirm the address and the gateway`,
        ],
        backout: [
          ...ifaces.flatMap((iface) => [
            `interface ${iface}`,
            ...servers.map((server) => ` no ip helper-address ${server}`),
            ...servers6.map((server) => ` no ipv6 dhcp relay destination ${server}`),
            '!',
          ]),
          ...(snooping ? ['no ip dhcp snooping'] : []),
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_zbfw',
    platform: PLATFORM,
    label: 'Zone-based firewall',
    group: 'Security',
    description: 'Put the router’s own interfaces in zones and write the policy between them — the branch router doing the job a firewall would, where there is no firewall.',
    inputs: [
      { id: 'inside_zone', label: 'Inside zone name', control: 'text', default: 'INSIDE' },
      { id: 'inside_interfaces', label: 'Inside interfaces', control: 'text', default: 'Vlan10, Vlan20' },
      { id: 'outside_zone', label: 'Outside zone name', control: 'text', default: 'OUTSIDE' },
      { id: 'outside_interfaces', label: 'Outside interfaces', control: 'text', default: 'GigabitEthernet0/0/0' },
      { id: 'allow', label: 'Protocols out', control: 'text', default: 'tcp, udp, icmp', hint: 'Inspected, so return traffic comes back automatically' },
      { id: 'inbound', label: 'Traffic in from outside', control: 'select', default: 'none', options: [
        { value: 'none', label: 'None — nothing initiated from outside' },
        { value: 'named', label: 'Only the services named below' },
      ] },
      { id: 'inbound_services', label: 'Services published inbound', control: 'text', default: '443', showWhen: { input: 'inbound', equals: ['named'] } },
      { id: 'inbound_host', label: 'Published host', control: 'text', default: '10.10.0.20', hint: 'IPv4, IPv6 or one of each', showWhen: { input: 'inbound', equals: ['named'] } },
      { id: 'log_drops', label: 'Log dropped traffic', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const inside = str(values, 'inside_zone', 'INSIDE').toUpperCase();
      const outside = str(values, 'outside_zone', 'OUTSIDE').toUpperCase();
      const insideIfaces = listOf(str(values, 'inside_interfaces', ''));
      const outsideIfaces = listOf(str(values, 'outside_interfaces', ''));
      const allow = listOf(str(values, 'allow', 'tcp udp icmp')).map((p) => p.toLowerCase());
      const inbound = str(values, 'inbound', 'none') === 'named';
      const ports = listOf(str(values, 'inbound_services', ''));
      const hosts = addressList(str(values, 'inbound_host', ''));
      // Anything that is not IPv6 stays on the IPv4 list, as it always did.
      const host = hosts.v4[0] ?? (hosts.v6.length === 0 ? str(values, 'inbound_host', '') : undefined);
      const host6 = hosts.v6[0];
      const inAcl = `${outside}-TO-${inside}-ACL`;
      const findings: Finding[] = [];
      if (insideIfaces.length === 0 || outsideIfaces.length === 0) {
        findings.push(error('network.ios.zbfw-zones', 'Both zones need at least one interface. An interface not in any zone can still pass traffic, which makes the policy look like it is not working.', { source: 'ArchToolKit' }));
      }
      findings.push(
        warning('network.ios.zbfw-selfzone', 'Traffic to and from the router itself is in the self zone, which is unrestricted until a policy is written for it. This change does not touch it — SSH from outside still reaches the router unless a self-zone policy says otherwise.', {
          remediation: 'Write a self-zone policy in a separate change, and test it from the console.',
          source: 'ArchToolKit',
        }),
      );
      if (allow.length === 0) {
        findings.push(error('network.ios.zbfw-no-protocols', 'No protocol was allowed outbound, so this policy drops everything leaving the site.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Zone-based firewall ${inside} to ${outside}`,
        impact: 'outage',
        notes: [
          'The moment an interface joins a zone, everything between zones without a policy is dropped. Apply the whole change at once, not interface by interface.',
          'Inspected traffic is stateful: the return path is opened automatically and does not need a rule of its own.',
          'Test from the console or an inside host, not over a session that crosses the zones you are about to police.',
        ],
        before: ['show zone security', 'show zone-pair security', 'show policy-map type inspect zone-pair', ...[...insideIfaces, ...outsideIfaces].map((i) => `show run interface ${i}`)],
        config: [
          ...allow.map((protocol) => `class-map type inspect match-any ${inside}-TO-${outside}-${protocol.toUpperCase()}`).flatMap((line, index) => [line, ` match protocol ${allow[index]}`, '!']),
          `policy-map type inspect ${inside}-TO-${outside}`,
          ...allow.flatMap((protocol) => [` class type inspect ${inside}-TO-${outside}-${protocol.toUpperCase()}`, '  inspect']),
          ' class class-default',
          ...(bool(values, 'log_drops', true) ? ['  drop log'] : ['  drop']),
          '!',
          ...(inbound && ports.length > 0
            ? [
                `object-group service ${outside}-PUBLISHED`,
                ...ports.map((port) => ` tcp eq ${port}`),
                '!',
                ...(host !== undefined ? [`ip access-list extended ${inAcl}`, ...ports.map((port) => ` permit tcp any host ${host} eq ${port}`), '!'] : []),
                ...(host6 ? [`ipv6 access-list ${inAcl}${V6}`, ...ports.map((port) => ` permit tcp any host ${host6} eq ${port}`), '!'] : []),
                `class-map type inspect ${host !== undefined && host6 ? 'match-any' : 'match-all'} ${outside}-TO-${inside}-CLASS`,
                ...(host !== undefined ? [` match access-group name ${inAcl}`] : []),
                ...(host6 ? [` match access-group name ${inAcl}${V6}`] : []),
                '!',
                `policy-map type inspect ${outside}-TO-${inside}`,
                ` class type inspect ${outside}-TO-${inside}-CLASS`,
                '  inspect',
                ' class class-default',
                ...(bool(values, 'log_drops', true) ? ['  drop log'] : ['  drop']),
                '!',
              ]
            : []),
          `zone security ${inside}`,
          ` description Trusted networks`,
          `zone security ${outside}`,
          ` description Untrusted`,
          '!',
          `zone-pair security ${inside}-TO-${outside} source ${inside} destination ${outside}`,
          ` service-policy type inspect ${inside}-TO-${outside}`,
          '!',
          ...(inbound && ports.length > 0
            ? [`zone-pair security ${outside}-TO-${inside} source ${outside} destination ${inside}`, ` service-policy type inspect ${outside}-TO-${inside}`, '!']
            : []),
          ...insideIfaces.flatMap((iface) => [`interface ${iface}`, ` zone-member security ${inside}`, '!']),
          ...outsideIfaces.flatMap((iface) => [`interface ${iface}`, ` zone-member security ${outside}`, '!']),
        ],
        verify: [
          'show zone security',
          'show zone-pair security',
          `show policy-map type inspect zone-pair ${inside}-TO-${outside}`,
          'show policy-firewall sessions',
          `${'!'} From an inside host: browse out, and confirm the session appears`,
          ...(inbound ? [`${'!'} From outside: connect to the published service`] : []),
          'show logging | include FW-6-DROP',
        ],
        backout: [
          ...insideIfaces.flatMap((iface) => [`interface ${iface}`, ` no zone-member security ${inside}`, '!']),
          ...outsideIfaces.flatMap((iface) => [`interface ${iface}`, ` no zone-member security ${outside}`, '!']),
          `no zone-pair security ${inside}-TO-${outside}`,
          ...(inbound ? [`no zone-pair security ${outside}-TO-${inside}`] : []),
          `no policy-map type inspect ${inside}-TO-${outside}`,
          `no zone security ${inside}`,
          `no zone security ${outside}`,
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'ios_smart_licensing',
    platform: PLATFORM,
    label: 'Smart licensing using policy',
    group: 'Management',
    description: 'Point an IOS-XE device at wherever its licence usage is reported — CSLU, on-premises SSM, Smart Software Manager, or an air-gapped report you carry out by hand.',
    inputs: [
      { id: 'transport', label: 'Transport', control: 'select', default: 'cslu', options: [
        { value: 'cslu', label: 'CSLU — a utility on the network collects from the device' },
        { value: 'smart', label: 'Smart — direct to Cisco over the internet' },
        { value: 'callhome', label: 'Call-home — direct, using the older transport' },
        { value: 'off', label: 'Off — air-gapped, reported by file' },
      ] },
      { id: 'url', label: 'CSLU or SSM URL', control: 'text', default: 'http://10.0.1.60:8182/cslu/v1/pi', showWhen: { input: 'transport', equals: ['cslu', 'callhome'] } },
      { id: 'source_interface', label: 'Source interface', control: 'text', default: 'Loopback0' },
      { id: 'vrf', label: 'Management VRF', control: 'text', default: '', hint: 'Empty for the global table' },
      { id: 'hostname_privacy', label: 'Withhold the hostname from reports', control: 'toggle', default: false },
      { id: 'usage_interval', label: 'Report interval (days)', control: 'number', default: 30, min: 1, max: 365 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const transport = str(values, 'transport', 'cslu');
      const url = str(values, 'url', '');
      const vrf = str(values, 'vrf', '');
      const findings: Finding[] = [];
      if ((transport === 'cslu' || transport === 'callhome') && !url) {
        findings.push(error('network.ios.no-licence-url', 'No URL was given, so the device has nowhere to report to and will keep counting days since its last report.', { source: 'ArchToolKit' }));
      }
      if (transport === 'off') {
        findings.push(warning('network.ios.licence-offline', 'With transport off, usage has to be exported and uploaded by hand on the reporting interval. Nothing stops working if it is missed, but the licence position drifts from reality and is a problem at renewal.', { remediation: 'Put the export on the same schedule as the configuration backup: `license smart save usage all file flash:usage.txt`.', source: 'ArchToolKit' }));
      }
      if (transport === 'smart') {
        findings.push(warning('network.ios.licence-internet', 'Direct transport needs the device to reach Cisco over HTTPS, and a trust token installed from exec mode. A device behind a firewall with no outbound access will report nothing and say very little about why.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Smart licensing transport ${transport}`,
        impact: 'none',
        notes: [
          'Smart licensing using policy does not enforce. Nothing stops working because a report was missed — but an unreported device is an unlicensed device at audit, and the RUM reports accumulate on flash until they are collected.',
          'The trust token, if one is needed, is installed from exec mode and is not part of the configuration. It is not written here and must not go in the change record.',
          ...(vrf ? [`Reporting goes through VRF ${vrf}, which has to be able to reach the collector.`] : []),
        ],
        before: ['show license status', 'show license summary', 'show license usage', 'show license tech support | include Transport|Trust'],
        config: [
          ...(vrf ? [`ip http client source-interface ${str(values, 'source_interface', 'Loopback0')}`] : [`ip http client source-interface ${str(values, 'source_interface', 'Loopback0')}`]),
          `license smart transport ${transport}`,
          ...(transport === 'cslu' && url ? [`license smart url cslu ${url}`] : []),
          ...(transport === 'callhome' && url ? [`license smart url ${url}`] : []),
          ...(vrf ? [`license smart vrf ${vrf}`] : []),
          `license smart usage interval ${num(values, 'usage_interval', 30)}`,
          ...(bool(values, 'hostname_privacy', false) ? ['license smart privacy hostname'] : []),
          '!',
          ...(transport === 'smart' ? [`${'!'} Then, from exec mode, with a token from Smart Software Manager:`, `${'!'} license smart trust idtoken <token> local`] : []),
          ...(transport === 'off' ? [`${'!'} On the reporting interval: license smart save usage all file flash:usage.txt`] : []),
        ],
        verify: ['show license status', 'show license summary', 'show license usage', 'show license eventlog 20', ...(transport !== 'off' ? [`${'!'} Force one now: license smart sync all`] : [])],
        backout: ['no license smart transport', ...(url ? ['no license smart url'] : []), 'license smart transport cslu'],
        findings,
      };
    },
  }),
];
