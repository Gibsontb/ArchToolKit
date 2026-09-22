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
import { description, listOf, parseCidr,                   } from '../device.js';

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
      const local = parseCidr(str(values, 'local_address', ''));
      const po = num(values, 'peer_link_channel', 1000);
      const members = listOf(str(values, 'peer_link_members', ''));
      const findings            = [];
      if (!local) findings.push(error('network.eos.mlag-address', 'The peer address is not a valid address and prefix.', { source: 'ArchToolKit' }));
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
          `   peer-address ${str(values, 'peer_address', '')}`,
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
      { id: 'anycast_gateway', label: 'Anycast gateway address', control: 'text', default: '', hint: 'VARP address for the SVI; empty for layer 2 only' },
      { id: 'vrf', label: 'Tenant VRF', control: 'text', default: '', showWhen: { input: 'anycast_gateway', notEquals: [''] } },
    ],
    change: (values                 )               => {
      const vlan = num(values, 'vlan_id', 100);
      const vni = num(values, 'vni', 10100);
      const loopback = num(values, 'source_loopback', 1);
      const asn = num(values, 'local_as', 65101);
      const gateway = parseCidr(str(values, 'anycast_gateway', ''));
      const varp = str(values, 'anycast_gateway', '').split('/')[0] ?? '';
      const vrf = str(values, 'vrf', '');

      return {
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
          ...(gateway
            ? [
                `interface Vlan${vlan}`,
                `   description VNI ${vni} gateway`,
                ...(vrf ? [`   vrf ${vrf}`] : []),
                `   ip address virtual ${gateway.address}/${gateway.prefix}`,
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
        verify: [`show vxlan vni ${vni}`, 'show vxlan vtep', 'show bgp evpn route-type mac-ip', ...(gateway ? [`show ip virtual-router`, `ping ${varp}`] : [])],
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
      { id: 'address', label: 'Address', control: 'text', default: '10.0.12.1/31', hint: 'A /31 is normal on an Arista fabric link' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Fabric link' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 9214, min: 1500, max: 9214 },
      { id: 'ospf', label: 'Add to OSPF', control: 'toggle', default: false },
      { id: 'ospf_area', label: 'OSPF area', control: 'text', default: '0.0.0.0', showWhen: { input: 'ospf', equals: ['true'] } },
    ],
    change: (values                 )               => {
      const iface = str(values, 'interface', '');
      const cidr = parseCidr(str(values, 'address', ''));
      const vrf = str(values, 'vrf', '');
      const ospf = bool(values, 'ospf', false);
      const findings            = [];
      if (!cidr) findings.push(error('network.eos.bad-address', 'The address is not a valid address and prefix.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `Routed interface ${iface}`,
        impact: 'outage',
        notes: ['`no switchport` clears the layer 2 configuration. Whatever the port was carrying stops.'],
        before: [`show running-config interfaces ${iface}`, `show interfaces ${iface} status`],
        config: [
          `interface ${iface}`,
          `   description ${description(str(values, 'port_description', ''), 'Routed link')}`,
          '   no switchport',
          ...(vrf ? [`   vrf ${vrf}`] : []),
          ...(cidr ? [`   ip address ${cidr.address}/${cidr.prefix}`] : []),
          `   mtu ${num(values, 'mtu', 9214)}`,
          ...(ospf ? [`   ip ospf area ${str(values, 'ospf_area', '0.0.0.0')}`, '   ip ospf network point-to-point'] : []),
          '   no shutdown',
          '!',
        ],
        verify: [`show interfaces ${iface}`, `show ip interface brief${vrf ? ` vrf ${vrf}` : ''}`, ...(ospf ? ['show ip ospf neighbor'] : [])],
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
      { id: 'address', label: 'Address', control: 'text', default: '10.255.0.11/32' },
      { id: 'purpose', label: 'Purpose', control: 'select', default: 'router-id', options: [
        { value: 'router-id', label: 'Router id and peering source' },
        { value: 'vtep', label: 'VXLAN VTEP source' },
        { value: 'anycast-vtep', label: 'Shared VTEP address for an MLAG pair' },
      ] },
      { id: 'local_as', label: 'Advertise into BGP AS', control: 'number', default: 0, min: 0, hint: '0 to leave routing alone' },
    ],
    change: (values                 )               => {
      const id = num(values, 'number', 0);
      const cidr = parseCidr(str(values, 'address', ''));
      const purpose = str(values, 'purpose', 'router-id');
      const asn = num(values, 'local_as', 0);
      const findings            = [];
      if (cidr && cidr.prefix !== 32) findings.push(warning('network.eos.loopback-mask', 'A loopback is normally a /32.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `Loopback${id} (${purpose})`,
        impact: 'none',
        notes: [
          ...(purpose === 'anycast-vtep' ? ['Both MLAG peers carry the same anycast VTEP address on this loopback, so the fabric sees the pair as one VTEP.'] : []),
          'A loopback that is not advertised into the underlay is unreachable from the rest of the fabric, which is the usual reason EVPN peering never comes up.',
        ],
        before: [`show running-config interfaces Loopback${id}`, 'show ip route ' + (cidr?.address ?? '')],
        config: [
          `interface Loopback${id}`,
          `   description ${purpose === 'vtep' || purpose === 'anycast-vtep' ? 'VXLAN VTEP source' : 'Router id'}`,
          ...(cidr ? [`   ip address ${cidr.address}/${cidr.prefix}`] : []),
          '!',
          ...(asn > 0 ? [`router bgp ${asn}`, '   address-family ipv4', `      network ${cidr ? `${cidr.address}/${cidr.prefix}` : ''}`, '!'] : []),
        ],
        verify: [`show ip interface brief | include Loopback${id}`, ...(asn > 0 ? ['show bgp ipv4 unicast'] : []), ...(cidr ? [`ping ${cidr.address}`] : [])],
        backout: [...(asn > 0 ? [`router bgp ${asn}`, '   address-family ipv4', `      no network ${cidr ? `${cidr.address}/${cidr.prefix}` : ''}`, '!'] : []), `no interface Loopback${id}`],
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
      { id: 'peers', label: 'Peer addresses', control: 'textarea', default: '10.0.1.0 65100\n10.0.2.0 65100', hint: 'One per line: address AS' },
      { id: 'advertise', label: 'Prefixes to advertise', control: 'textarea', default: '10.255.0.11/32' },
      { id: 'ecmp', label: 'ECMP paths', control: 'number', default: 4, min: 1, max: 64 },
      { id: 'bfd', label: 'BFD', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const asn = num(values, 'local_as', 65101);
      const peers = str(values, 'peers', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2);
      const advertise = str(values, 'advertise', '')
        .split(/\n+/)
        .map((line) => parseCidr(line.trim()))
        .filter((c)                                           => c !== null);
      const ecmp = num(values, 'ecmp', 4);
      const bfd = bool(values, 'bfd', true);

      return {
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
          '   !',
          '   address-family ipv4',
          '      neighbor UNDERLAY activate',
          ...advertise.map((n) => `      network ${n.address}/${n.prefix}`),
          '!',
        ],
        verify: ['show bgp summary', 'show ip route bgp', 'show ip bgp neighbors', ...(bfd ? ['show bfd peers'] : [])],
        backout: [`router bgp ${asn}`, ...peers.map((parts) => `   no neighbor ${parts[0]}`), '   no neighbor UNDERLAY peer group', '!'],
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
      { id: 'prefix', label: 'Destination', control: 'text', default: '0.0.0.0/0' },
      { id: 'next_hop', label: 'Next hop', control: 'text', default: '10.0.0.1' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '' },
      { id: 'distance', label: 'Administrative distance', control: 'number', default: 1, min: 1, max: 255 },
      { id: 'route_name', label: 'Name', control: 'text', default: 'DEFAULT', hint: 'EOS can name a static route, which shows in the routing table' },
    ],
    change: (values                 )               => {
      const cidr = parseCidr(str(values, 'prefix', '0.0.0.0/0'));
      const hop = str(values, 'next_hop', '');
      const vrf = str(values, 'vrf', '');
      const distance = num(values, 'distance', 1);
      const label = str(values, 'route_name', '');
      const line = `ip route${vrf ? ` vrf ${vrf}` : ''} ${cidr ? `${cidr.address}/${cidr.prefix}` : '<REQUIRED>'} ${hop}${distance !== 1 ? ` ${distance}` : ''}${label ? ` name ${label}` : ''}`;

      return {
        platform: PLATFORM,
        title: `Static route ${cidr ? `${cidr.address}/${cidr.prefix}` : '(invalid)'}`,
        impact: cidr && cidr.prefix === 0 ? 'outage' : 'brief',
        notes: cidr && cidr.prefix === 0 ? ['This is the default route. Getting the next hop wrong takes the switch off the network.'] : [],
        before: [`show ip route${vrf ? ` vrf ${vrf}` : ''} ${cidr ? `${cidr.address}/${cidr.prefix}` : ''}`.trim(), 'show running-config | include ip route'],
        config: [line],
        verify: [`show ip route${vrf ? ` vrf ${vrf}` : ''} ${cidr ? cidr.address : ''}`.trim(), `ping${vrf ? ` vrf ${vrf}` : ''} ${hop}`],
        backout: [`no ${line}`],
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
      const findings            = [];
      if (rules.length === 0) findings.push(error('network.eos.empty-acl', 'An access list with no rules denies everything.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `Access list ${name}${target ? ` on ${target} ${direction}` : ''}`,
        impact: target ? 'outage' : 'none',
        notes: [
          'Build it in a configure session and commit with a timer if the list protects the path you are on.',
          ...(target ? ['This filters live traffic immediately. Make sure your own management path is permitted.'] : []),
        ],
        before: [`show ip access-lists ${name}`, ...(target ? [`show running-config interfaces ${target}`] : [])],
        config: [
          `ip access-list ${name}`,
          ...(bool(values, 'counters', true) ? ['   counters per-entry'] : []),
          ...rules.map((rule, i) => `   ${(i + 1) * 10} ${rule}`),
          `   ${(rules.length + 1) * 10} deny ip any any log`,
          '!',
          ...(target ? [`interface ${target}`, `   ip access-group ${name} ${direction}`, '!'] : []),
        ],
        verify: [`show ip access-lists ${name}`, `show ip access-lists ${name} summary`, ...(target ? [`show running-config interfaces ${target}`] : [])],
        backout: [...(target ? [`interface ${target}`, `   no ip access-group ${name} ${direction}`, '!'] : []), `no ip access-list ${name}`],
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

      return {
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
          `sflow${vrf ? ` vrf ${vrf}` : ''} destination ${collector} ${num(values, 'port', 6343)}`,
          `sflow sample ${num(values, 'sample_rate', 16384)}`,
          'sflow polling-interval 30',
          'sflow run',
          '!',
          ...interfaces.flatMap((iface) => [`interface ${iface}`, '   sflow enable', '!']),
        ],
        verify: ['show sflow', 'show sflow interfaces', 'show sflow counters'],
        backout: ['no sflow run', `no sflow${vrf ? ` vrf ${vrf}` : ''} destination ${collector}`, ...interfaces.flatMap((iface) => [`interface ${iface}`, '   no sflow enable', '!'])],
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
      { id: 'servers', label: 'TACACS+ servers', control: 'text', default: '10.0.0.30, 10.0.0.31' },
      { id: 'vrf', label: 'VRF', control: 'text', default: 'MGMT' },
      { id: 'source_interface', label: 'Source interface', control: 'text', default: 'Management1' },
      { id: 'local_user', label: 'Local fallback username', control: 'text', default: 'netadmin' },
      { id: 'accounting', label: 'Command accounting', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const servers = listOf(str(values, 'servers', ''));
      const vrf = str(values, 'vrf', 'MGMT');
      const user = str(values, 'local_user', 'netadmin');

      return {
        platform: PLATFORM,
        title: 'AAA through TACACS+ with a local fallback',
        impact: 'brief',
        notes: [
          `Replace every ${SECRET} with the real key and the local account's secret.`,
          'Commit this with a timer: if the key is wrong, the session you are in still works and the switch rolls it back.',
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
