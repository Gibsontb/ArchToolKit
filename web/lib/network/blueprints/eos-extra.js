/**
 * Arista EOS, the rest of it.
 *
 * The MLAG domain itself rather than one member port, the VXLAN VTEP, the
 * underlay peering from the spine side, and the operational pieces — routed
 * ports, loopbacks, static routes, ACLs, sFlow, SPAN and AAA.
 *
 * Every EOS change here is written to be applied inside a configure session
 * with a commit timer, which is the safest way to change a switch you reach
 * through — the verification steps say so.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { containsAny, familyOf } from '../../core/ip.js';
import { description, isIpAny, listOf, parseCidr, parseCidrDual,                   } from '../device.js';
import { dualCidrs, dualFindings, ipv6Rule, routerIdFindings, ruleFamily, unverifiedIpv6 } from './nxos-eos-dual.js';

const PLATFORM = 'arista_eos'         ;
const SECRET = '<REQUIRED>';

export const EOS_EXTRA                             = [
  deviceBlueprint({
    id: 'eos_mlag_domain',
    platform: PLATFORM,
    label: 'MLAG domain and peer-link',
    group: 'Switching',
    description: 'The MLAG pair itself: the peer VLAN and SVI, the peer-link port-channel, the domain, and the shared virtual MAC.',
    inputs: [
      { id: 'domain_id', label: 'Domain id', control: 'text', default: 'MLAG-1', hint: 'The same on both peers' },
      { id: 'peer_vlan', label: 'Peer VLAN', control: 'number', default: 4094, min: 2, max: 4094 },
      { id: 'local_address', label: 'This switch’s peer address', control: 'text', default: '10.255.255.1/30' },
      { id: 'peer_address', label: 'Peer’s address', control: 'text', default: '10.255.255.2' },
      { id: 'peer_link_channel', label: 'Peer-link port-channel', control: 'number', default: 1000, min: 1, max: 2000 },
      { id: 'peer_link_members', label: 'Peer-link members', control: 'text', default: 'Ethernet55, Ethernet56' },
      { id: 'virtual_mac', label: 'Shared virtual MAC', control: 'text', default: '00:1c:73:00:00:01', hint: 'The same on both peers; used by VARP and MLAG' },
    ],
    change: (values                 )               => {
      const domain = str(values, 'domain_id', 'MLAG-1');
      const vlan = num(values, 'peer_vlan', 4094);
      const typed = str(values, 'local_address', '');
      const peer = str(values, 'peer_address', '');
      // MLAG peering over IPv6 could not be confirmed across EOS releases, so it is not written.
      const mlag6 = familyOf(typed) === 6 || familyOf(peer) === 6;
      const local = mlag6 ? null : parseCidr(typed);
      const po = num(values, 'peer_link_channel', 1000);
      const members = listOf(str(values, 'peer_link_members', ''));
      const findings            = [];
      if (mlag6) findings.push(unverifiedIpv6('network.eos.mlag-ipv6', 'The MLAG local-interface and peer-address', 'EOS'));
      else {
        if (!local) findings.push(error('network.eos.mlag-address', 'The peer address is not a valid address and prefix.', { source: 'ArchToolKit' }));
        if (!isIpAny(peer)) findings.push(error('network.eos.mlag-peer', `The peer's address "${peer}" is not an address.`, { source: 'ArchToolKit' }));
        else if (local && !containsAny(`${local.address}/${local.prefix}`, peer)) {
          findings.push(error('network.eos.mlag-subnet', `The peer's address ${peer} is not in ${local.address}/${local.prefix}, so the peers can never reach each other over the peer VLAN.`, { source: 'ArchToolKit' }));
        }
      }
      if (members.length < 2) findings.push(warning('network.eos.peer-link-members', 'A peer-link with one member is a single point of failure for the pair.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `MLAG domain ${domain}`,
        impact: 'outage',
        notes: [
          'Both peers take the same domain id and the same virtual MAC, with the peer addresses swapped. A mismatch leaves the pair in an inconsistent state and MLAG ports down.',
          'The peer VLAN must be trunked on the peer-link and must not be carried anywhere else.',
          'Apply this in a configure session with a commit timer: `configure session mlag`, paste, `commit timer 00:05:00`.',
        ],
        before: ['show mlag', 'show mlag detail', 'show port-channel summary', 'show vlan'],
        config: [
          `vlan ${vlan}`,
          '   name MLAG-PEER',
          '   trunk group MLAGPEER',
          '!',
          'no spanning-tree vlan-id ' + vlan,
          '!',
          `interface Vlan${vlan}`,
          '   description MLAG peer link',
          '   no autostate',
          ...(local ? [`   ip address ${local.address}/${local.prefix}`] : []),
          '!',
          `interface Port-Channel${po}`,
          '   description MLAG peer link',
          '   switchport mode trunk',
          '   switchport trunk group MLAGPEER',
          '!',
          ...members.flatMap((port) => [`interface ${port}`, '   description MLAG peer link member', `   channel-group ${po} mode active`, '!']),
          'mlag configuration',
          `   domain-id ${domain}`,
          `   local-interface Vlan${vlan}`,
          ...(mlag6 ? [] : [`   peer-address ${peer}`]),
          `   peer-link Port-Channel${po}`,
          '   reload-delay mlag 300',
          '   reload-delay non-mlag 330',
          '!',
          `ip virtual-router mac-address ${str(values, 'virtual_mac', '')}`,
        ],
        verify: ['show mlag', 'show mlag detail', 'show mlag config-sanity', 'show ip virtual-router'],
        backout: ['no mlag configuration', `no interface Port-Channel${po}`, `no interface Vlan${vlan}`, `no vlan ${vlan}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_vxlan_vtep',
    platform: PLATFORM,
    label: 'VXLAN VTEP and a VNI',
    group: 'Overlay',
    description: 'The VXLAN interface with its source loopback, a VLAN-to-VNI mapping, and the EVPN VLAN so the fabric learns it.',
    inputs: [
      { id: 'vlan_id', label: 'VLAN id', control: 'number', default: 100, min: 1, max: 4094 },
      { id: 'vni', label: 'VNI', control: 'number', default: 10100, min: 1, max: 16777214 },
      { id: 'source_loopback', label: 'VTEP source loopback', control: 'number', default: 1, min: 0, max: 1000, hint: 'Loopback1 is the usual VTEP source; Loopback0 is the router id' },
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65101, min: 1 },
      { id: 'route_distinguisher', label: 'Route distinguisher', control: 'text', default: '10.255.0.11:10100' },
      { id: 'route_target', label: 'Route target', control: 'text', default: '10100:10100' },
      { id: 'anycast_gateway', label: 'Anycast gateway address', control: 'text', default: '', hint: 'Address and prefix for the SVI, IPv4, IPv6 or one of each; empty for layer 2 only' },
      { id: 'vrf', label: 'Tenant VRF', control: 'text', default: '', showWhen: { input: 'anycast_gateway', notEquals: [''] } },
    ],
    change: (values                 )               => {
      const vlan = num(values, 'vlan_id', 100);
      const vni = num(values, 'vni', 10100);
      const loopback = num(values, 'source_loopback', 1);
      const asn = num(values, 'local_as', 65101);
      const anycast = dualCidrs(str(values, 'anycast_gateway', ''));
      const gateway = anycast.v4 !== null || anycast.v6 !== null;
      const vrf = str(values, 'vrf', '');
      const findings            = dualFindings('network.eos.bad-address', 'the anycast gateway address', anycast, '10.100.0.1/24 or 2001:db8:100::1/64');

      return {
        findings,
        platform: PLATFORM,
        title: `VXLAN VNI ${vni} for VLAN ${vlan}`,
        impact: 'brief',
        notes: [
          'Every leaf carrying this VLAN needs the same VNI and, if it is routed, the same VARP address and virtual MAC.',
          'The underlay and BGP EVPN have to be up first — the VTEP source loopback must be reachable from every other leaf.',
          'Arista learns remote VTEPs through EVPN; no flood list or multicast group is needed.',
        ],
        before: [`show vxlan vni ${vni}`, 'show vxlan vtep', 'show bgp evpn summary', `show vlan ${vlan}`],
        config: [
          `vlan ${vlan}`,
          `   name VNI-${vni}`,
          '!',
          // IPv6 is not routed on EOS, in any VRF, until it is turned on for that VRF.
          ...(anycast.v6 ? [`ipv6 unicast-routing${vrf ? ` vrf ${vrf}` : ''}`, '!'] : []),
          ...(gateway
            ? [
                `interface Vlan${vlan}`,
                `   description VNI ${vni} gateway`,
                ...(vrf ? [`   vrf ${vrf}`] : []),
                ...(anycast.v4 ? [`   ip address virtual ${anycast.v4.text}`] : []),
                ...(anycast.v6 ? [`   ipv6 address virtual ${anycast.v6.text}`] : []),
                '   no shutdown',
                '!',
              ]
            : []),
          'interface Vxlan1',
          `   vxlan source-interface Loopback${loopback}`,
          '   vxlan udp-port 4789',
          `   vxlan vlan ${vlan} vni ${vni}`,
          ...(vrf ? [`   vxlan vrf ${vrf} vni ${vni + 40000}`] : []),
          '!',
          `router bgp ${asn}`,
          `   vlan ${vlan}`,
          `      rd ${str(values, 'route_distinguisher', '')}`,
          `      route-target both ${str(values, 'route_target', '')}`,
          '      redistribute learned',
          '!',
        ],
        verify: [
          `show vxlan vni ${vni}`,
          'show vxlan vtep',
          'show bgp evpn route-type mac-ip',
          ...(anycast.v4 ? [`show ip virtual-router`, `ping ${anycast.v4.address}`] : []),
          ...(anycast.v6 ? [`show ipv6 interface Vlan${vlan}`, `ping${vrf ? ` vrf ${vrf}` : ''} ipv6 ${anycast.v6.address}`] : []),
        ],
        backout: [`router bgp ${asn}`, `   no vlan ${vlan}`, '!', 'interface Vxlan1', `   no vxlan vlan ${vlan} vni ${vni}`, '!', ...(gateway ? [`no interface Vlan${vlan}`] : []), `no vlan ${vlan}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_routed_port',
    platform: PLATFORM,
    label: 'Routed port',
    group: 'Interfaces',
    description: 'A layer 3 interface with an address, optionally in a VRF and in the underlay routing.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'Ethernet1' },
      { id: 'address', label: 'Address', control: 'text', default: '10.0.12.1/31', hint: 'A /31 is normal on an Arista fabric link; IPv4, IPv6 (/127) or one of each' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Fabric link' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 9214, min: 1500, max: 9214 },
      { id: 'ospf', label: 'Add to OSPF', control: 'toggle', default: false, hint: 'OSPFv2: the IPv4 address only' },
      { id: 'ospf_area', label: 'OSPF area', control: 'text', default: '0.0.0.0', showWhen: { input: 'ospf', equals: ['true'] } },
    ],
    change: (values                 )               => {
      const iface = str(values, 'interface', '');
      const address = dualCidrs(str(values, 'address', ''));
      const vrf = str(values, 'vrf', '');
      const ospf = bool(values, 'ospf', false);
      const findings            = dualFindings('network.eos.bad-address', 'the address', address, '10.0.12.1/31 or 2001:db8:0:12::/127');
      if (!address.v4 && !address.v6) findings.push(error('network.eos.bad-address', 'The address is not a valid address and prefix.', { source: 'ArchToolKit' }));
      if (ospf && address.v6 && !address.v4) {
        findings.push(warning('network.eos.ospfv2-ipv6', 'OSPF here is OSPFv2, which only carries IPv4. With an IPv6-only address the interface joins the area and never forms an adjacency.', { remediation: 'Turn OSPF off here and use OSPFv3 or BGP for IPv6.', source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Routed interface ${iface}`,
        impact: 'outage',
        notes: [
          '`no switchport` clears the layer 2 configuration. Whatever the port was carrying stops.',
          ...(address.v6 ? ['`ipv6 unicast-routing` is included: without it EOS addresses the port and routes no IPv6.'] : []),
          ...(ospf && address.v6 ? ['OSPFv2 advertises the IPv4 address only. The IPv6 address needs OSPFv3 or BGP, which this change does not configure.'] : []),
        ],
        before: [`show running-config interfaces ${iface}`, `show interfaces ${iface} status`],
        config: [
          ...(address.v6 ? [`ipv6 unicast-routing${vrf ? ` vrf ${vrf}` : ''}`, '!'] : []),
          `interface ${iface}`,
          `   description ${description(str(values, 'port_description', ''), 'Routed link')}`,
          '   no switchport',
          ...(vrf ? [`   vrf ${vrf}`] : []),
          ...(address.v4 ? [`   ip address ${address.v4.text}`] : []),
          ...(address.v6 ? [`   ipv6 address ${address.v6.text}`] : []),
          `   mtu ${num(values, 'mtu', 9214)}`,
          ...(ospf ? [`   ip ospf area ${str(values, 'ospf_area', '0.0.0.0')}`, '   ip ospf network point-to-point'] : []),
          '   no shutdown',
          '!',
        ],
        verify: [
          `show interfaces ${iface}`,
          ...(address.v4 || !address.v6 ? [`show ip interface brief${vrf ? ` vrf ${vrf}` : ''}`] : []),
          ...(address.v6 ? [`show ipv6 interface brief${vrf ? ` vrf ${vrf}` : ''}`] : []),
          ...(ospf ? ['show ip ospf neighbor'] : []),
        ],
        backout: [`default interface ${iface}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_loopback',
    platform: PLATFORM,
    label: 'Loopback interface',
    group: 'Interfaces',
    description: 'A loopback for the router id or the VXLAN source, advertised into the underlay.',
    inputs: [
      { id: 'number', label: 'Loopback number', control: 'number', default: 0, min: 0, max: 1000 },
      { id: 'address', label: 'Address', control: 'text', default: '10.255.0.11/32', hint: 'IPv4 /32, IPv6 /128, or one of each' },
      { id: 'purpose', label: 'Purpose', control: 'select', default: 'router-id', options: [
        { value: 'router-id', label: 'Router id and peering source' },
        { value: 'vtep', label: 'VXLAN VTEP source' },
        { value: 'anycast-vtep', label: 'Shared VTEP address for an MLAG pair' },
      ] },
      { id: 'local_as', label: 'Advertise into BGP AS', control: 'number', default: 0, min: 0, hint: '0 to leave routing alone' },
    ],
    change: (values                 )               => {
      const id = num(values, 'number', 0);
      const address = dualCidrs(str(values, 'address', ''));
      const cidr = address.v4;
      const v6 = address.v6;
      const purpose = str(values, 'purpose', 'router-id');
      const asn = num(values, 'local_as', 0);
      const findings            = dualFindings('network.eos.bad-address', 'the loopback address', address, '10.255.0.11/32 or 2001:db8::11/128');
      if (cidr && cidr.prefix !== 32) findings.push(warning('network.eos.loopback-mask', 'A loopback is normally a /32.', { source: 'ArchToolKit' }));
      if (v6 && v6.prefix !== 128) findings.push(warning('network.eos.loopback-mask', 'An IPv6 loopback is normally a /128.', { source: 'ArchToolKit' }));
      if (!cidr && !v6) findings.push(error('network.eos.bad-address', 'The loopback address is not a valid address and prefix.', { remediation: 'Write it as 10.255.0.11/32.', source: 'ArchToolKit' }));
      // The VTEP source in this fabric is IPv4; a VXLAN-over-IPv6 underlay is a different design.
      if (v6 && !cidr && purpose !== 'router-id') {
        findings.push(warning('network.eos.vtep-ipv6', 'The VTEP source loopback has no IPv4 address, and the VXLAN changes here source from IPv4. VERIFY: a VXLAN-over-IPv6 underlay needs the platform and release to support it.', { source: 'ArchToolKit' }));
      }
      // Each family is advertised from its own address family, so one never carries the other's prefix.
      const af4 = asn > 0 && (cidr !== null || v6 === null);
      const af6 = asn > 0 && v6 !== null;

      return {
        platform: PLATFORM,
        title: `Loopback${id} (${purpose})`,
        impact: 'none',
        notes: [
          ...(purpose === 'anycast-vtep' ? ['Both MLAG peers carry the same anycast VTEP address on this loopback, so the fabric sees the pair as one VTEP.'] : []),
          'A loopback that is not advertised into the underlay is unreachable from the rest of the fabric, which is the usual reason EVPN peering never comes up.',
          ...(af6 ? ['The IPv6 network is only advertised to neighbours activated in `address-family ipv6`.'] : []),
        ],
        before: [`show running-config interfaces Loopback${id}`, ...(cidr || !v6 ? ['show ip route ' + (cidr?.address ?? '')] : []), ...(v6 ? [`show ipv6 route ${v6.address}`] : [])],
        config: [
          `interface Loopback${id}`,
          `   description ${purpose === 'vtep' || purpose === 'anycast-vtep' ? 'VXLAN VTEP source' : 'Router id'}`,
          ...(cidr ? [`   ip address ${cidr.address}/${cidr.prefix}`] : []),
          ...(v6 ? [`   ipv6 address ${v6.text}`] : []),
          '!',
          ...(af4 || af6
            ? [
                `router bgp ${asn}`,
                ...(af4 ? ['   address-family ipv4', `      network ${cidr ? `${cidr.address}/${cidr.prefix}` : ''}`] : []),
                ...(af6 ? ['   address-family ipv6', `      network ${v6 .network}/${v6 .prefix}`] : []),
                '!',
              ]
            : []),
        ],
        verify: [
          `show ip${v6 && !cidr ? 'v6' : ''} interface brief | include Loopback${id}`,
          ...(af4 ? ['show bgp ipv4 unicast'] : []),
          ...(af6 ? ['show bgp ipv6 unicast'] : []),
          ...(cidr ? [`ping ${cidr.address}`] : []),
          ...(v6 ? [`ping ipv6 ${v6.address}`] : []),
        ],
        backout: [
          ...(af4 || af6
            ? [
                `router bgp ${asn}`,
                ...(af4 ? ['   address-family ipv4', `      no network ${cidr ? `${cidr.address}/${cidr.prefix}` : ''}`] : []),
                ...(af6 ? ['   address-family ipv6', `      no network ${v6 .network}/${v6 .prefix}`] : []),
                '!',
              ]
            : []),
          `no interface Loopback${id}`,
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_bgp_underlay',
    platform: PLATFORM,
    label: 'BGP underlay peering',
    group: 'Routing',
    description: 'eBGP over the fabric links with ECMP and BFD — the underlay an EVPN overlay rides on.',
    inputs: [
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65101, min: 1 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.11' },
      { id: 'peers', label: 'Peer addresses', control: 'textarea', default: '10.0.1.0 65100\n10.0.2.0 65100', hint: 'One per line: address AS. IPv6 peers (2001:db8:0:1::0 65100) go in their own peer group' },
      { id: 'advertise', label: 'Prefixes to advertise', control: 'textarea', default: '10.255.0.11/32', hint: 'One per line, IPv4 or IPv6' },
      { id: 'ecmp', label: 'ECMP paths', control: 'number', default: 4, min: 1, max: 64 },
      { id: 'bfd', label: 'BFD', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const asn = num(values, 'local_as', 65101);
      const allPeers = str(values, 'peers', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2);
      const lines = str(values, 'advertise', '')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const ecmp = num(values, 'ecmp', 4);
      const bfd = bool(values, 'bfd', true);
      // IPv4 and IPv6 sessions are separate peer groups, each activated only in
      // its own address family, so no session carries the other family's routes.
      const peers = allPeers.filter((parts) => familyOf(parts[0] ?? '') === 4);
      const peers6 = allPeers.filter((parts) => familyOf(parts[0] ?? '') === 6);
      const advertise = lines.map((l) => parseCidrDual(l)).filter((c) => c?.family === 4)                                         ;
      const advertise6 = lines.flatMap((l) => {
        const c = parseCidrDual(l);
        return c?.family === 6 ? [`${c.network}/${c.prefix}`] : [];
      });
      const findings            = [
        ...routerIdFindings('network.eos.router-id', str(values, 'router_id', '')),
        ...allPeers.filter((parts) => !isIpAny(parts[0] ?? '')).map((parts) => error('network.eos.bad-peer', `The peer "${parts[0]}" is not an address.`, { source: 'ArchToolKit' })),
        ...lines.filter((l) => !parseCidrDual(l)).map((l) => error('network.eos.bad-prefix', `"${l}" is not an IPv4 or IPv6 prefix.`, { source: 'ArchToolKit' })),
      ];
      if (advertise6.length > 0 && peers6.length === 0) {
        findings.push(warning('network.eos.ipv6-no-peers', 'IPv6 prefixes are advertised but there is no IPv6 peer to send them to. They sit in the table and reach nobody.', { remediation: 'Add the IPv6 address of each fabric link as a peer.', source: 'ArchToolKit' }));
      }
      const group6 = peers6.length > 0 || advertise6.length > 0;

      return {
        findings,
        platform: PLATFORM,
        title: `BGP underlay in AS ${asn}`,
        impact: 'brief',
        notes: [
          'Point-to-point eBGP on the fabric links, one session per link. ECMP is what makes every link carry traffic rather than one.',
          ...(bfd ? ['BFD has to be enabled on both ends. On its own it does nothing but add a session that never comes up.'] : []),
        ],
        before: ['show bgp summary', 'show ip route summary', 'show running-config section bgp'],
        config: [
          'service routing protocols model multi-agent',
          '!',
          `router bgp ${asn}`,
          `   router-id ${str(values, 'router_id', '')}`,
          '   no bgp default ipv4-unicast',
          `   maximum-paths ${ecmp} ecmp ${ecmp}`,
          '   distance bgp 20 200 200',
          '   neighbor UNDERLAY peer group',
          '   neighbor UNDERLAY send-community',
          '   neighbor UNDERLAY maximum-routes 12000',
          ...(bfd ? ['   neighbor UNDERLAY bfd'] : []),
          ...peers.flatMap((parts) => [`   neighbor ${parts[0]} peer group UNDERLAY`, `   neighbor ${parts[0]} remote-as ${parts[1]}`]),
          ...(group6
            ? [
                '   neighbor UNDERLAY-V6 peer group',
                '   neighbor UNDERLAY-V6 send-community',
                '   neighbor UNDERLAY-V6 maximum-routes 12000',
                ...(bfd ? ['   neighbor UNDERLAY-V6 bfd'] : []),
                ...peers6.flatMap((parts) => [`   neighbor ${parts[0]} peer group UNDERLAY-V6`, `   neighbor ${parts[0]} remote-as ${parts[1]}`]),
              ]
            : []),
          '   !',
          '   address-family ipv4',
          '      neighbor UNDERLAY activate',
          ...advertise.map((n) => `      network ${n.address}/${n.prefix}`),
          ...(group6 ? ['   !', '   address-family ipv6', '      neighbor UNDERLAY-V6 activate', ...advertise6.map((n) => `      network ${n}`)] : []),
          '!',
        ],
        verify: ['show bgp summary', 'show ip route bgp', 'show ip bgp neighbors', ...(group6 ? ['show ipv6 bgp summary', 'show ipv6 route bgp'] : []), ...(bfd ? ['show bfd peers'] : [])],
        backout: [
          `router bgp ${asn}`,
          ...[...peers, ...peers6].map((parts) => `   no neighbor ${parts[0]}`),
          '   no neighbor UNDERLAY peer group',
          ...(group6 ? ['   no neighbor UNDERLAY-V6 peer group'] : []),
          '!',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_static_route',
    platform: PLATFORM,
    label: 'Static route',
    group: 'Routing',
    description: 'A static route, in the default table or a VRF.',
    inputs: [
      { id: 'prefix', label: 'Destination', control: 'combo', default: '0.0.0.0/0', options: ['0.0.0.0/0', '10.0.0.0/8', '::/0', '2001:db8::/32'].map((v) => ({ value: v, label: v })), hint: 'IPv4 or IPv6; ::/0 is the IPv6 default' },
      { id: 'next_hop', label: 'Next hop', control: 'text', default: '10.0.0.1', hint: 'The same family as the destination; a global IPv6 address, not link-local' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '' },
      { id: 'distance', label: 'Administrative distance', control: 'number', default: 1, min: 1, max: 255 },
      { id: 'route_name', label: 'Name', control: 'text', default: 'DEFAULT', hint: 'EOS can name a static route, which shows in the routing table' },
    ],
    change: (values                 )               => {
      const cidr = parseCidrDual(str(values, 'prefix', '0.0.0.0/0'));
      const hop = str(values, 'next_hop', '');
      const vrf = str(values, 'vrf', '');
      const distance = num(values, 'distance', 1);
      const label = str(values, 'route_name', '');
      const v6 = cidr?.family === 6;
      const ip = v6 ? 'ipv6' : 'ip';
      const dest = cidr ? (v6 ? `${cidr.network}/${cidr.prefix}` : `${cidr.address}/${cidr.prefix}`) : null;
      const findings            = [];
      if (!cidr) findings.push(error('network.eos.bad-prefix', `The destination "${str(values, 'prefix', '')}" is not an IPv4 or IPv6 prefix.`, { remediation: 'Write it as 10.0.0.0/8 or 2001:db8::/32.', source: 'ArchToolKit' }));
      if (hop && !isIpAny(hop)) findings.push(error('network.eos.bad-next-hop', `The next hop "${hop}" is not an address.`, { source: 'ArchToolKit' }));
      if (cidr && isIpAny(hop) && familyOf(hop) !== cidr.family) {
        findings.push(error('network.eos.route-family', `The destination is IPv${cidr.family} and the next hop ${hop} is not. A route and its next hop are one family.`, { source: 'ArchToolKit' }));
      }
      // This blueprint has no egress interface, and a link-local next hop is meaningless without one.
      if (v6 && /^fe[89ab]/i.test(hop)) {
        findings.push(error('network.eos.link-local-hop', 'A link-local next hop needs the outgoing interface named, which this change does not take.', { remediation: 'Use the neighbour’s global IPv6 address as the next hop.', source: 'ArchToolKit' }));
      }
      const line = `${ip} route${vrf ? ` vrf ${vrf}` : ''} ${dest ?? '<REQUIRED>'} ${hop}${distance !== 1 ? ` ${distance}` : ''}${label ? ` name ${label}` : ''}`;

      return {
        platform: PLATFORM,
        title: `Static route ${dest ?? '(invalid)'}`,
        impact: cidr && cidr.prefix === 0 ? 'outage' : 'brief',
        notes: cidr && cidr.prefix === 0 ? ['This is the default route. Getting the next hop wrong takes the switch off the network.'] : [],
        before: [`show ${ip} route${vrf ? ` vrf ${vrf}` : ''} ${dest ?? ''}`.trim(), `show running-config | include ${ip} route`],
        config: [line],
        verify: [`show ${ip} route${vrf ? ` vrf ${vrf}` : ''} ${cidr ? (v6 ? cidr.network : cidr.address) : ''}`.trim(), `ping${vrf ? ` vrf ${vrf}` : ''}${v6 ? ' ipv6' : ''} ${hop}`],
        backout: [`no ${line}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_acl',
    platform: PLATFORM,
    label: 'IP access list',
    group: 'Security',
    description: 'A named access list with sequence numbers, applied to an interface or to the control plane.',
    inputs: [
      { id: 'acl_name', label: 'Access list name', control: 'text', default: 'ACL-TENANT-IN' },
      { id: 'rules', label: 'Rules', control: 'textarea', default: 'permit tcp 10.100.0.0/24 any eq https\npermit udp 10.100.0.0/24 host 10.0.0.10 eq domain' },
      { id: 'apply_to', label: 'Apply to interface', control: 'text', default: '' },
      { id: 'direction', label: 'Direction', control: 'select', default: 'in', options: [{ value: 'in', label: 'Inbound' }, { value: 'out', label: 'Outbound' }] },
      { id: 'counters', label: 'Per-rule counters', control: 'toggle', default: true, hint: 'EOS can count hits per rule, which is how you find what a list is actually dropping' },
    ],
    change: (values                 )               => {
      const name = str(values, 'acl_name', 'ACL').toUpperCase().replace(/\s+/g, '-');
      const rules = str(values, 'rules', '')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const target = str(values, 'apply_to', '');
      const direction = str(values, 'direction', 'in');
      const counters = bool(values, 'counters', true) ? ['   counters per-entry'] : [];
      const findings            = [];
      if (rules.length === 0) findings.push(error('network.eos.empty-acl', 'An access list with no rules denies everything.', { source: 'ArchToolKit' }));
      // EOS keeps IPv4 and IPv6 in separate lists. A rule that names no
      // address ("permit tcp any any eq ssh") belongs in both.
      const families = rules.map((rule) => ({ rule, family: ruleFamily(rule) }));
      for (const { rule } of families.filter((r) => r.family === 'mixed')) {
        findings.push(error('network.eos.acl-mixed-family', `"${rule}" names both IPv4 and IPv6 addresses. One entry matches one family.`, { remediation: 'Split it into an IPv4 rule and an IPv6 rule.', source: 'ArchToolKit' }));
      }
      const rules4 = families.filter((r) => r.family === 4 || r.family === null).map((r) => r.rule);
      const has6 = families.some((r) => r.family === 6);
      const rules6 = has6 ? families.filter((r) => r.family === 6 || r.family === null).map((r) => ipv6Rule(r.rule, 'icmpv6')) : [];
      const name6 = `${name}-V6`;
      const list4 = rules4.length > 0 || !has6;

      return {
        platform: PLATFORM,
        title: `Access list ${name}${target ? ` on ${target} ${direction}` : ''}`,
        impact: target ? 'outage' : 'none',
        notes: [
          'Build it in a configure session and commit with a timer if the list protects the path you are on.',
          ...(target ? ['This filters live traffic immediately. Make sure your own management path is permitted.'] : []),
          ...(has6 ? [`IPv6 rules are in ${name6}. Each list ends in its own deny, so a family with no list on the interface is not filtered at all.`] : []),
        ],
        before: [...(list4 ? [`show ip access-lists ${name}`] : []), ...(has6 ? [`show ipv6 access-lists ${name6}`] : []), ...(target ? [`show running-config interfaces ${target}`] : [])],
        config: [
          ...(list4 ? [`ip access-list ${name}`, ...counters, ...rules4.map((rule, i) => `   ${(i + 1) * 10} ${rule}`), `   ${(rules4.length + 1) * 10} deny ip any any log`, '!'] : []),
          ...(has6 ? [`ipv6 access-list ${name6}`, ...counters, ...rules6.map((rule, i) => `   ${(i + 1) * 10} ${rule}`), `   ${(rules6.length + 1) * 10} deny ipv6 any any log`, '!'] : []),
          ...(target
            ? [`interface ${target}`, ...(list4 ? [`   ip access-group ${name} ${direction}`] : []), ...(has6 ? [`   ipv6 access-group ${name6} ${direction}`] : []), '!']
            : []),
        ],
        verify: [
          ...(list4 ? [`show ip access-lists ${name}`, `show ip access-lists ${name} summary`] : []),
          ...(has6 ? [`show ipv6 access-lists ${name6}`] : []),
          ...(target ? [`show running-config interfaces ${target}`] : []),
        ],
        backout: [
          ...(target
            ? [`interface ${target}`, ...(list4 ? [`   no ip access-group ${name} ${direction}`] : []), ...(has6 ? [`   no ipv6 access-group ${name6} ${direction}`] : []), '!']
            : []),
          ...(list4 ? [`no ip access-list ${name}`] : []),
          ...(has6 ? [`no ipv6 access-list ${name6}`] : []),
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_sflow',
    platform: PLATFORM,
    label: 'sFlow export',
    group: 'Operations',
    description: 'sFlow to a collector — Arista’s flow export, sampled in hardware and cheap to run.',
    inputs: [
      { id: 'collector', label: 'Collector address', control: 'text', default: '10.0.0.40' },
      { id: 'port', label: 'Collector port', control: 'number', default: 6343, min: 1, max: 65535 },
      { id: 'source_interface', label: 'Source interface', control: 'text', default: 'Loopback0' },
      { id: 'sample_rate', label: 'Sample rate (1 in N)', control: 'number', default: 16384, min: 1, hint: 'Higher is fewer samples; 16384 suits a 10G fabric' },
      { id: 'vrf', label: 'VRF to reach the collector', control: 'text', default: 'MGMT' },
      { id: 'interfaces', label: 'Interfaces (empty = all)', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const collector = str(values, 'collector', '');
      const vrf = str(values, 'vrf', '');
      const interfaces = listOf(str(values, 'interfaces', ''));
      // An IPv6 sFlow collector could not be confirmed for EOS, so the destination is not written.
      const collector6 = familyOf(collector) === 6;
      const findings            = [];
      if (collector6) findings.push(unverifiedIpv6('network.eos.sflow-ipv6', 'An sFlow collector address', 'EOS'));
      else if (!isIpAny(collector)) findings.push(error('network.eos.sflow-collector', `The collector "${collector}" is not an address.`, { source: 'ArchToolKit' }));

      return {
        findings,
        platform: PLATFORM,
        title: `sFlow to ${collector}`,
        impact: 'none',
        notes: [
          'sFlow samples; it does not capture every flow. That is what makes it cheap and what makes it wrong for billing or forensics.',
          'A sample rate that is too low floods the collector and the CPU. Start high and lower it if the picture is too coarse.',
        ],
        before: ['show sflow', 'show running-config section sflow'],
        config: [
          `sflow source-interface ${str(values, 'source_interface', 'Loopback0')}`,
          ...(collector6 ? [] : [`sflow${vrf ? ` vrf ${vrf}` : ''} destination ${collector} ${num(values, 'port', 6343)}`]),
          `sflow sample ${num(values, 'sample_rate', 16384)}`,
          'sflow polling-interval 30',
          'sflow run',
          '!',
          ...interfaces.flatMap((iface) => [`interface ${iface}`, '   sflow enable', '!']),
        ],
        verify: ['show sflow', 'show sflow interfaces', 'show sflow counters'],
        backout: ['no sflow run', ...(collector6 ? [] : [`no sflow${vrf ? ` vrf ${vrf}` : ''} destination ${collector}`]), ...interfaces.flatMap((iface) => [`interface ${iface}`, '   no sflow enable', '!'])],
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_span',
    platform: PLATFORM,
    label: 'Monitor session (SPAN)',
    group: 'Operations',
    description: 'Mirror interfaces to a destination port, optionally with an access list so only the interesting traffic is copied.',
    inputs: [
      { id: 'session', label: 'Session name', control: 'text', default: 'CAPTURE' },
      { id: 'source', label: 'Source interfaces', control: 'text', default: 'Ethernet1' },
      { id: 'direction', label: 'Direction', control: 'select', default: 'both', options: [{ value: 'both', label: 'Both' }, { value: 'rx', label: 'Received' }, { value: 'tx', label: 'Transmitted' }] },
      { id: 'destination', label: 'Destination interface', control: 'text', default: 'Ethernet48' },
      { id: 'filter_acl', label: 'Filter with access list', control: 'text', default: '', hint: 'Optional: mirror only what the list permits' },
    ],
    change: (values                 )               => {
      const session = str(values, 'session', 'CAPTURE').toUpperCase();
      const sources = listOf(str(values, 'source', ''));
      const direction = str(values, 'direction', 'both');
      const destination = str(values, 'destination', '');
      const acl = str(values, 'filter_acl', '');

      return {
        platform: PLATFORM,
        title: `Monitor session ${session}`,
        impact: 'brief',
        notes: [
          'The destination port stops forwarding normal traffic. Never point one at an uplink.',
          'Mirroring more than the destination link can carry drops silently, and the capture looks like packet loss that is not there.',
          'Remove the session when the capture is done.',
        ],
        before: ['show monitor session', `show running-config interfaces ${destination}`],
        config: [
          ...sources.map((source) => `monitor session ${session} source ${source} ${direction === 'both' ? '' : direction}`.trimEnd()),
          `monitor session ${session} destination ${destination}`,
          ...(acl ? [`monitor session ${session} ip access-group ${acl}`] : []),
        ],
        verify: [`show monitor session ${session}`, 'show monitor session'],
        backout: [`no monitor session ${session}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_aaa_tacacs',
    platform: PLATFORM,
    label: 'AAA with TACACS+',
    group: 'Baseline',
    description: 'Login through TACACS+ over the management VRF with a local fallback and command accounting.',
    inputs: [
      { id: 'servers', label: 'TACACS+ servers', control: 'text', default: '10.0.0.30, 10.0.0.31', hint: 'IPv4 or IPv6 addresses, or names' },
      { id: 'vrf', label: 'VRF', control: 'text', default: 'MGMT' },
      { id: 'source_interface', label: 'Source interface', control: 'text', default: 'Management1' },
      { id: 'local_user', label: 'Local fallback username', control: 'text', default: 'netadmin' },
      { id: 'accounting', label: 'Command accounting', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const servers = listOf(str(values, 'servers', ''));
      const vrf = str(values, 'vrf', 'MGMT');
      const user = str(values, 'local_user', 'netadmin');
      const any6 = servers.some((s) => familyOf(s) === 6);

      return {
        platform: PLATFORM,
        title: 'AAA through TACACS+ with a local fallback',
        impact: 'brief',
        notes: [
          `Replace every ${SECRET} with the real key and the local account's secret.`,
          'Commit this with a timer: if the key is wrong, the session you are in still works and the switch rolls it back.',
          ...(any6 ? ['VERIFY: `ip tacacs … source-interface` sets the IPv4 source. Confirm the source interface has an IPv6 address, and whether the release in use sources IPv6 TACACS+ from it.'] : []),
        ],
        before: ['show tacacs', 'show aaa', 'show users detail'],
        config: [
          `username ${user} privilege 15 role network-admin secret sha512 ${SECRET}`,
          '!',
          ...servers.map((server) => `tacacs-server host ${server} vrf ${vrf} key 7 ${SECRET}`),
          'tacacs-server timeout 3',
          `ip tacacs vrf ${vrf} source-interface ${str(values, 'source_interface', 'Management1')}`,
          '!',
          'aaa group server tacacs+ TACACS-GROUP',
          ...servers.map((server) => `   server ${server} vrf ${vrf}`),
          '!',
          'aaa authentication login default group TACACS-GROUP local',
          'aaa authentication enable default group TACACS-GROUP local',
          'aaa authorization exec default group TACACS-GROUP local',
          ...(bool(values, 'accounting', true) ? ['aaa accounting commands all default start-stop group TACACS-GROUP', 'aaa accounting exec default start-stop group TACACS-GROUP'] : []),
          '!',
        ],
        verify: ['show tacacs', 'show aaa', 'Log in from a second session before you commit.'],
        backout: ['no aaa authentication login default', 'no aaa authorization exec default', 'no aaa group server tacacs+ TACACS-GROUP', ...servers.map((server) => `no tacacs-server host ${server} vrf ${vrf}`)],
      };
    },
  }),
];
