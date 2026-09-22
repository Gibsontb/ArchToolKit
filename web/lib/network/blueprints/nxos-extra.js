/**
 * Cisco NX-OS, the rest of it.
 *
 * A Nexus in a data centre is mostly four things the first file did not cover:
 * the vPC domain itself (not just a member port), the VXLAN/EVPN overlay, the
 * underlay peering, and the operational scaffolding — ACLs, SPAN, AAA, jumbo
 * MTU. This is those.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { description, listOf, parseCidr,                   } from '../device.js';

const PLATFORM = 'cisco_nxos'         ;
const SECRET = '<REQUIRED>';

export const NXOS_EXTRA                             = [
  deviceBlueprint({
    id: 'nxos_vpc_domain',
    platform: PLATFORM,
    label: 'vPC domain and peer-link',
    group: 'Switching',
    description: 'The foundation a vPC pair needs: the domain, the peer-keepalive over the management VRF, the peer-link port-channel, and the consistency settings that stop a split brain.',
    inputs: [
      { id: 'domain_id', label: 'vPC domain id', control: 'number', default: 1, min: 1, max: 1000, hint: 'The same on both peers' },
      { id: 'role_priority', label: 'Role priority', control: 'number', default: 1000, min: 1, max: 65535, hint: 'Lower is primary. 1000 here, 2000 on the other' },
      { id: 'peer_keepalive_local', label: 'This switch’s management address', control: 'text', default: '10.0.0.11' },
      { id: 'peer_keepalive_remote', label: 'Peer’s management address', control: 'text', default: '10.0.0.12' },
      { id: 'peer_link_channel', label: 'Peer-link port-channel', control: 'number', default: 1, min: 1, max: 4096 },
      { id: 'peer_link_members', label: 'Peer-link members', control: 'text', default: 'Ethernet1/51, Ethernet1/52' },
      { id: 'peer_switch', label: 'peer-switch (one spanning-tree root)', control: 'toggle', default: true },
      { id: 'peer_gateway', label: 'peer-gateway', control: 'toggle', default: true, hint: 'Lets each peer route for the other’s MAC — needed by some storage and load balancers' },
    ],
    change: (values                 )               => {
      const domain = num(values, 'domain_id', 1);
      const po = num(values, 'peer_link_channel', 1);
      const members = listOf(str(values, 'peer_link_members', ''));
      const findings            = [];
      if (members.length < 2) {
        findings.push(warning('network.nxos.peer-link-members', 'A peer-link with one member is a single point of failure for the whole pair.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `vPC domain ${domain} with its peer-link`,
        impact: 'outage',
        notes: [
          'This is the change that builds the pair. Do it on both switches in a window, peer-keepalive first, and confirm `show vpc` says peer adjacency is up before attaching anything.',
          'peer-keepalive must not run over the peer-link. Over the management VRF is the normal answer, and it is what this writes.',
          'peer-switch requires both peers to have the same spanning-tree priority. Set that first, or spanning tree will re-converge when this applies.',
        ],
        before: ['show vpc brief', 'show port-channel summary', 'show vrf management interface', 'show spanning-tree summary'],
        config: [
          'feature vpc',
          'feature lacp',
          '!',
          `vpc domain ${domain}`,
          `  role priority ${num(values, 'role_priority', 1000)}`,
          `  peer-keepalive destination ${str(values, 'peer_keepalive_remote', '')} source ${str(values, 'peer_keepalive_local', '')} vrf management`,
          ...(bool(values, 'peer_switch', true) ? ['  peer-switch'] : []),
          ...(bool(values, 'peer_gateway', true) ? ['  peer-gateway'] : []),
          '  delay restore 150',
          '  auto-recovery reload-delay 240',
          '  ip arp synchronize',
          '!',
          `interface port-channel${po}`,
          '  description vPC peer-link',
          '  switchport mode trunk',
          '  spanning-tree port type network',
          '  vpc peer-link',
          '  no shutdown',
          '!',
          ...members.flatMap((port) => [`interface ${port}`, '  description vPC peer-link member', '  switchport mode trunk', `  channel-group ${po} mode active`, '  no shutdown', '!']),
        ],
        verify: ['show vpc brief', 'show vpc consistency-parameters global', 'show vpc peer-keepalive', 'show port-channel summary'],
        backout: [...members.flatMap((port) => [`interface ${port}`, `  no channel-group ${po}`, '!']), `no interface port-channel${po}`, `no vpc domain ${domain}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_port_channel',
    platform: PLATFORM,
    label: 'Port-channel (LACP)',
    group: 'Switching',
    description: 'A plain LACP bundle that is not a vPC — an uplink from one switch, or a link to a single-homed device.',
    inputs: [
      { id: 'channel_id', label: 'Port-channel id', control: 'number', default: 10, min: 1, max: 4096 },
      { id: 'members', label: 'Members', control: 'text', default: 'Ethernet1/9, Ethernet1/10' },
      { id: 'mode', label: 'Mode', control: 'select', default: 'trunk', options: [{ value: 'trunk', label: 'Trunk' }, { value: 'access', label: 'Access' }, { value: 'routed', label: 'Routed (no switchport)' }] },
      { id: 'allowed', label: 'Allowed VLANs', control: 'text', default: '100,200', showWhen: { input: 'mode', equals: ['trunk'] } },
      { id: 'vlan_id', label: 'Access VLAN', control: 'number', default: 100, min: 1, max: 4094, showWhen: { input: 'mode', equals: ['access'] } },
      { id: 'address', label: 'Address', control: 'text', default: '10.0.12.1/30', showWhen: { input: 'mode', equals: ['routed'] } },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Uplink' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 9216, min: 1500, max: 9216 },
    ],
    change: (values                 )               => {
      const po = num(values, 'channel_id', 10);
      const members = listOf(str(values, 'members', ''));
      const mode = str(values, 'mode', 'trunk');
      const cidr = parseCidr(str(values, 'address', ''));
      const text = description(str(values, 'port_description', ''), 'Port-channel');
      const body =
        mode === 'trunk'
          ? ['  switchport mode trunk', `  switchport trunk allowed vlan ${str(values, 'allowed', '')}`]
          : mode === 'access'
            ? ['  switchport mode access', `  switchport access vlan ${num(values, 'vlan_id', 100)}`]
            : ['  no switchport', ...(cidr ? [`  ip address ${cidr.address}/${cidr.prefix}`] : [])];

      return {
        platform: PLATFORM,
        title: `Port-channel ${po} (${mode})`,
        impact: 'brief',
        notes: ['Members have to match in speed, duplex and mode or NX-OS suspends them. Configure both ends before expecting the bundle to come up.'],
        before: ['show port-channel summary', ...members.map((port) => `show run interface ${port}`)],
        config: [
          'feature lacp',
          '!',
          `interface port-channel${po}`,
          `  description ${text}`,
          ...body,
          `  mtu ${num(values, 'mtu', 9216)}`,
          '  no shutdown',
          '!',
          ...members.flatMap((port) => [`interface ${port}`, `  description ${text} member`, ...body, `  channel-group ${po} mode active`, '  no shutdown', '!']),
        ],
        verify: ['show port-channel summary', `show interface port-channel${po}`, 'show lacp neighbor'],
        backout: [...members.flatMap((port) => [`interface ${port}`, `  no channel-group ${po}`, '!']), `no interface port-channel${po}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_routed_interface',
    platform: PLATFORM,
    label: 'Routed interface',
    group: 'Interfaces',
    description: 'A layer 3 interface with an address, optionally in a VRF and in a routing process.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'Ethernet1/1' },
      { id: 'address', label: 'Address', control: 'text', default: '10.0.12.1/30' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 9216, min: 1500, max: 9216 },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Routed link' },
      { id: 'ospf_tag', label: 'OSPF process tag', control: 'text', default: '', hint: 'Empty for no OSPF' },
      { id: 'ospf_area', label: 'OSPF area', control: 'text', default: '0.0.0.0' },
    ],
    change: (values                 )               => {
      const iface = str(values, 'interface', '');
      const cidr = parseCidr(str(values, 'address', ''));
      const vrf = str(values, 'vrf', '');
      const ospf = str(values, 'ospf_tag', '');
      const findings            = [];
      if (!cidr) findings.push(error('network.nxos.bad-address', 'The address is not a valid address and prefix.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `Routed interface ${iface}`,
        impact: 'outage',
        notes: ['`no switchport` clears the layer 2 configuration on the port. Anything it was carrying stops.', ...(vrf ? ['Moving into a VRF removes the address; it is re-applied here, inside the VRF.'] : [])],
        before: [`show run interface ${iface}`, `show interface ${iface} status`],
        config: [
          `interface ${iface}`,
          `  description ${description(str(values, 'port_description', ''), 'Routed link')}`,
          '  no switchport',
          ...(vrf ? [`  vrf member ${vrf}`] : []),
          ...(cidr ? [`  ip address ${cidr.address}/${cidr.prefix}`] : []),
          `  mtu ${num(values, 'mtu', 9216)}`,
          ...(ospf ? [`  ip router ospf ${ospf} area ${str(values, 'ospf_area', '0.0.0.0')}`, '  ip ospf network point-to-point'] : []),
          '  no shutdown',
          '!',
        ],
        verify: [`show interface ${iface}`, `show ip interface brief${vrf ? ` vrf ${vrf}` : ''}`, ...(ospf ? ['show ip ospf neighbors'] : [])],
        backout: [`default interface ${iface}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_vxlan_vni',
    platform: PLATFORM,
    label: 'VXLAN EVPN: a VNI',
    group: 'Overlay',
    description: 'Map a VLAN to an L2 VNI on the NVE interface and advertise it in EVPN, with an optional anycast gateway and an L3 VNI for routing between them.',
    inputs: [
      { id: 'vlan_id', label: 'VLAN id', control: 'number', default: 100, min: 1, max: 4094 },
      { id: 'l2_vni', label: 'L2 VNI', control: 'number', default: 10100, min: 1, max: 16777214 },
      { id: 'nve_interface', label: 'NVE interface', control: 'number', default: 1, min: 1, max: 1 },
      { id: 'multicast_group', label: 'Multicast group', control: 'text', default: '', hint: 'Leave empty for ingress replication (BGP EVPN), which is the usual answer' },
      { id: 'anycast_gateway', label: 'Anycast gateway address', control: 'text', default: '10.100.0.1/24', hint: 'The same on every leaf; empty for layer 2 only' },
      { id: 'vrf', label: 'Tenant VRF', control: 'text', default: 'TENANT-1', showWhen: { input: 'anycast_gateway', equals: [] } },
      { id: 'l3_vni', label: 'L3 VNI for the VRF', control: 'number', default: 50001, min: 0, max: 16777214, hint: '0 if the VRF is already configured' },
      { id: 'route_target', label: 'Route target', control: 'text', default: 'auto' },
    ],
    change: (values                 )               => {
      const vlan = num(values, 'vlan_id', 100);
      const vni = num(values, 'l2_vni', 10100);
      const nve = num(values, 'nve_interface', 1);
      const group = str(values, 'multicast_group', '');
      const gateway = parseCidr(str(values, 'anycast_gateway', ''));
      const vrf = str(values, 'vrf', '');
      const l3vni = num(values, 'l3_vni', 0);
      const rt = str(values, 'route_target', 'auto');
      const findings            = [];
      if (gateway && !vrf) {
        findings.push(warning('network.nxos.anycast-no-vrf', 'An anycast gateway without a tenant VRF puts the SVI in the default VRF, which is rarely what a fabric wants.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `VXLAN VNI ${vni} for VLAN ${vlan}`,
        impact: 'brief',
        notes: [
          'Every leaf that carries this VLAN needs the same VNI, the same anycast gateway address and the same MAC. A mismatch gives you hosts that can talk within a leaf and nowhere else.',
          'The fabric has to be there first: the underlay, the NVE source loopback, BGP EVPN, and `fabric forwarding anycast-gateway-mac` configured globally.',
          ...(group ? ['This uses multicast replication, so PIM has to be running in the underlay.'] : ['Ingress replication needs no multicast in the underlay — BGP EVPN distributes the peer list.']),
        ],
        before: [`show nve vni ${vni}`, 'show nve peers', `show vlan id ${vlan}`, 'show bgp l2vpn evpn summary'],
        config: [
          'feature nv overlay',
          'feature vn-segment-vlan-based',
          'nv overlay evpn',
          '!',
          `vlan ${vlan}`,
          `  vn-segment ${vni}`,
          '!',
          ...(gateway && vrf
            ? [
                `interface Vlan${vlan}`,
                `  description L2VNI ${vni} gateway`,
                '  no shutdown',
                `  vrf member ${vrf}`,
                '  ip address ' + `${gateway.address}/${gateway.prefix}`,
                '  fabric forwarding mode anycast-gateway',
                '!',
              ]
            : []),
          ...(vrf && l3vni > 0
            ? [
                `vrf context ${vrf}`,
                `  vni ${l3vni}`,
                `  rd ${rt === 'auto' ? 'auto' : rt}`,
                '  address-family ipv4 unicast',
                `    route-target both ${rt}`,
                `    route-target both ${rt} evpn`,
                '!',
                `vlan ${l3vni - 50000 + 900}`,
                `  vn-segment ${l3vni}`,
                '!',
              ]
            : []),
          `interface nve${nve}`,
          '  no shutdown',
          '  host-reachability protocol bgp',
          `  member vni ${vni}`,
          group ? `    mcast-group ${group}` : '    ingress-replication protocol bgp',
          ...(vrf && l3vni > 0 ? [`  member vni ${l3vni} associate-vrf`] : []),
          '!',
          'evpn',
          `  vni ${vni} l2`,
          `    rd ${rt === 'auto' ? 'auto' : rt}`,
          `    route-target import ${rt}`,
          `    route-target export ${rt}`,
          '!',
        ],
        verify: [`show nve vni ${vni}`, 'show nve peers', 'show bgp l2vpn evpn summary', `show l2route evpn mac evi ${vlan}`, ...(gateway ? [`show ip interface Vlan${vlan}`] : [])],
        backout: [
          `interface nve${nve}`,
          `  no member vni ${vni}`,
          '!',
          `no evpn vni ${vni} l2`,
          ...(gateway ? [`no interface Vlan${vlan}`] : []),
          `vlan ${vlan}`,
          `  no vn-segment ${vni}`,
          '!',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_bgp_neighbor',
    platform: PLATFORM,
    label: 'BGP neighbour',
    group: 'Routing',
    description: 'A BGP peer — underlay, overlay EVPN, or a tenant VRF peering — with a peer template so the next one is one line.',
    inputs: [
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65001, min: 1 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.11' },
      { id: 'neighbor', label: 'Neighbour address', control: 'text', default: '10.255.0.1' },
      { id: 'remote_as', label: 'Remote AS', control: 'number', default: 65000, min: 1 },
      { id: 'family', label: 'Address family', control: 'select', default: 'ipv4', options: [
        { value: 'ipv4', label: 'IPv4 unicast (underlay)' },
        { value: 'evpn', label: 'L2VPN EVPN (overlay)' },
        { value: 'vrf', label: 'IPv4 unicast inside a VRF' },
      ] },
      { id: 'vrf', label: 'VRF', control: 'text', default: 'TENANT-1', showWhen: { input: 'family', equals: ['vrf'] } },
      { id: 'update_source', label: 'Update source', control: 'text', default: 'loopback0', showWhen: { input: 'family', equals: ['evpn'] } },
      { id: 'auth', label: 'Authenticate the session', control: 'toggle', default: true },
      { id: 'peer_description', label: 'Description', control: 'text', default: 'spine-01' },
    ],
    change: (values                 )               => {
      const asn = num(values, 'local_as', 65001);
      const peer = str(values, 'neighbor', '');
      const remote = num(values, 'remote_as', 65000);
      const family = str(values, 'family', 'ipv4');
      const vrf = str(values, 'vrf', '');
      const auth = bool(values, 'auth', true);

      const neighborBody = [
        `    remote-as ${remote}`,
        `    description ${description(str(values, 'peer_description', ''), 'peer')}`,
        ...(auth ? [`    password 3 ${SECRET}`] : []),
        ...(family === 'evpn' ? [`    update-source ${str(values, 'update_source', 'loopback0')}`, '    ebgp-multihop 3'] : []),
        family === 'evpn' ? '    address-family l2vpn evpn' : '    address-family ipv4 unicast',
        ...(family === 'evpn' ? ['      send-community', '      send-community extended'] : ['      soft-reconfiguration inbound always']),
      ];

      return {
        platform: PLATFORM,
        title: `BGP ${asn} neighbour ${peer}${family === 'vrf' ? ` in VRF ${vrf}` : ''}`,
        impact: 'brief',
        notes: [
          ...(family === 'evpn' ? ['The underlay must be up first: this peers over loopbacks, and they have to be reachable.'] : []),
          ...(auth ? [`Replace ${SECRET} with the session password from your vault.`] : []),
          'NX-OS needs `feature bgp`; it is included and safe to run again.',
        ],
        before: ['show bgp sessions', `show bgp ${family === 'evpn' ? 'l2vpn evpn' : 'ipv4 unicast'} summary${family === 'vrf' ? ` vrf ${vrf}` : ''}`, 'show running-config bgp'],
        config: [
          'feature bgp',
          '!',
          `router bgp ${asn}`,
          `  router-id ${str(values, 'router_id', '')}`,
          '  log-neighbor-changes',
          ...(family === 'vrf'
            ? [`  vrf ${vrf}`, `    neighbor ${peer}`, ...neighborBody.map((line) => `  ${line}`)]
            : [`  neighbor ${peer}`, ...neighborBody]),
          '!',
        ],
        verify: [`show bgp sessions neighbor ${peer}`, family === 'evpn' ? 'show bgp l2vpn evpn summary' : `show bgp ipv4 unicast summary${family === 'vrf' ? ` vrf ${vrf}` : ''}`, `show bgp neighbors ${peer}`],
        backout: [`router bgp ${asn}`, ...(family === 'vrf' ? [`  vrf ${vrf}`, `    no neighbor ${peer}`] : [`  no neighbor ${peer}`]), '!'],
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_static_route',
    platform: PLATFORM,
    label: 'Static route',
    group: 'Routing',
    description: 'A static route, in the default table or a VRF, with a distance that can make it a backup.',
    inputs: [
      { id: 'prefix', label: 'Destination', control: 'text', default: '0.0.0.0/0' },
      { id: 'next_hop', label: 'Next hop', control: 'text', default: '10.0.0.1' },
      { id: 'interface', label: 'Out of interface', control: 'text', default: '', hint: 'Optional; needed on a point-to-point link without a next hop' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '' },
      { id: 'distance', label: 'Distance', control: 'number', default: 1, min: 1, max: 255 },
    ],
    change: (values                 )               => {
      const cidr = parseCidr(str(values, 'prefix', '0.0.0.0/0'));
      const hop = str(values, 'next_hop', '');
      const iface = str(values, 'interface', '');
      const vrf = str(values, 'vrf', '');
      const distance = num(values, 'distance', 1);
      const line = `ip route ${cidr ? `${cidr.address}/${cidr.prefix}` : '<REQUIRED>'} ${iface ? `${iface} ` : ''}${hop}${distance !== 1 ? ` ${distance}` : ''}`;

      return {
        platform: PLATFORM,
        title: `Static route ${cidr ? `${cidr.address}/${cidr.prefix}` : '(invalid)'}${vrf ? ` in VRF ${vrf}` : ''}`,
        impact: cidr && cidr.prefix === 0 ? 'outage' : 'brief',
        notes: cidr && cidr.prefix === 0 ? ['This is the default route. A wrong next hop takes the switch off the network, including your session.'] : [],
        before: [`show ip route${vrf ? ` vrf ${vrf}` : ''} ${cidr ? `${cidr.address}/${cidr.prefix}` : ''}`.trim(), `show running-config | include 'ip route'`],
        config: vrf ? [`vrf context ${vrf}`, `  ${line}`, '!'] : [line],
        verify: [`show ip route${vrf ? ` vrf ${vrf}` : ''} ${cidr ? cidr.address : ''}`.trim(), `ping ${hop}${vrf ? ` vrf ${vrf}` : ''}`],
        backout: vrf ? [`vrf context ${vrf}`, `  no ${line}`, '!'] : [`no ${line}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_acl',
    platform: PLATFORM,
    label: 'IP access list',
    group: 'Security',
    description: 'A named IP access list with sequence numbers, applied to an interface or as a VLAN access map.',
    inputs: [
      { id: 'acl_name', label: 'Access list name', control: 'text', default: 'ACL-TENANT-IN' },
      { id: 'rules', label: 'Rules', control: 'textarea', default: 'permit tcp 10.100.0.0/24 any eq 443\npermit udp 10.100.0.0/24 10.0.0.10/32 eq 53', hint: 'One per line; NX-OS takes prefixes directly' },
      { id: 'apply_to', label: 'Apply to interface', control: 'text', default: '', hint: 'Empty to create the list only' },
      { id: 'direction', label: 'Direction', control: 'select', default: 'in', options: [{ value: 'in', label: 'Inbound' }, { value: 'out', label: 'Outbound' }] },
      { id: 'log_denies', label: 'Log the final deny', control: 'toggle', default: true },
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
      if (rules.length === 0) findings.push(error('network.nxos.empty-acl', 'An access list with no rules denies everything.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `Access list ${name}${target ? ` on ${target} ${direction}` : ''}`,
        impact: target ? 'outage' : 'none',
        notes: [
          'NX-OS applies an access list update atomically by default, so replacing one does not open a gap — but it can fail if the device cannot fit both copies. `no hardware access-list update atomic` changes that, at the cost of a gap.',
          ...(target ? ['This filters live traffic as soon as it is applied. Make sure your own management path is permitted.'] : []),
        ],
        before: [`show ip access-lists ${name}`, ...(target ? [`show run interface ${target}`] : [])],
        config: [
          `ip access-list ${name}`,
          ...rules.map((rule, i) => `  ${(i + 1) * 10} ${rule}`),
          `  ${(rules.length + 1) * 10} deny ip any any${bool(values, 'log_denies', true) ? ' log' : ''}`,
          '!',
          ...(target ? [`interface ${target}`, `  ip access-group ${name} ${direction}`, '!'] : []),
        ],
        verify: [`show ip access-lists ${name}`, ...(target ? [`show run interface ${target}`] : []), `show ip access-lists ${name} | include match`],
        backout: [...(target ? [`interface ${target}`, `  no ip access-group ${name} ${direction}`, '!'] : []), `no ip access-list ${name}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_span',
    platform: PLATFORM,
    label: 'SPAN session',
    group: 'Operations',
    description: 'Mirror interfaces or a VLAN to a destination port. NX-OS sessions are shut by default; this brings it up.',
    inputs: [
      { id: 'session', label: 'Session', control: 'number', default: 1, min: 1, max: 32 },
      { id: 'source', label: 'Source', control: 'text', default: 'Ethernet1/1', hint: 'Interfaces, or "vlan 100"' },
      { id: 'direction', label: 'Direction', control: 'select', default: 'both', options: [{ value: 'both', label: 'Both' }, { value: 'rx', label: 'Received' }, { value: 'tx', label: 'Transmitted' }] },
      { id: 'destination', label: 'Destination interface', control: 'text', default: 'Ethernet1/48' },
    ],
    change: (values                 )               => {
      const session = num(values, 'session', 1);
      const source = str(values, 'source', '');
      const destination = str(values, 'destination', '');
      const isVlan = /^vlan\s/i.test(source);

      return {
        platform: PLATFORM,
        title: `SPAN session ${session}`,
        impact: 'brief',
        notes: [
          'The destination interface must be configured as a SPAN destination first — it stops passing normal traffic the moment it is.',
          'Take the session out when the capture is finished. A forgotten session holds a port hostage.',
        ],
        before: ['show monitor', `show monitor session ${session}`, `show run interface ${destination}`],
        config: [
          `interface ${destination}`,
          '  switchport',
          '  switchport monitor',
          '  no shutdown',
          '!',
          `monitor session ${session}`,
          `  source ${isVlan ? source.toLowerCase() : `interface ${source}`} ${str(values, 'direction', 'both')}`,
          `  destination interface ${destination}`,
          '  no shut',
          '!',
        ],
        verify: [`show monitor session ${session}`, 'show monitor'],
        backout: [`no monitor session ${session}`, `default interface ${destination}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_aaa_tacacs',
    platform: PLATFORM,
    label: 'AAA with TACACS+',
    group: 'Baseline',
    description: 'Administrative login through TACACS+ over the management VRF, with a local fallback and command accounting.',
    inputs: [
      { id: 'servers', label: 'TACACS+ servers', control: 'text', default: '10.0.0.30, 10.0.0.31' },
      { id: 'vrf', label: 'VRF to reach them over', control: 'text', default: 'management' },
      { id: 'local_user', label: 'Local fallback username', control: 'text', default: 'netadmin' },
      { id: 'accounting', label: 'Command accounting', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const servers = listOf(str(values, 'servers', ''));
      const vrf = str(values, 'vrf', 'management');
      const user = str(values, 'local_user', 'netadmin');

      return {
        platform: PLATFORM,
        title: 'AAA through TACACS+ with a local fallback',
        impact: 'brief',
        notes: [
          `Replace every ${SECRET}: the TACACS+ key and the local account's password.`,
          'Keep a second session open. A wrong key means the next login fails, and only the local account gets you back.',
          'The `test` keyword on the server host is what marks a dead server dead — without it, logins hang waiting for a server that is gone.',
        ],
        before: ['show tacacs-server', 'show aaa authentication', 'show users'],
        config: [
          'feature tacacs+',
          `username ${user} password ${SECRET} role network-admin`,
          '!',
          ...servers.flatMap((server) => [`tacacs-server host ${server} key 0 ${SECRET}`, `tacacs-server host ${server} test username probe-user idle-time 5`]),
          'tacacs-server timeout 3',
          'tacacs-server deadtime 5',
          '!',
          'aaa group server tacacs+ TACACS-GROUP',
          ...servers.map((server) => `  server ${server}`),
          `  use-vrf ${vrf}`,
          `  source-interface mgmt0`,
          '!',
          'aaa authentication login default group TACACS-GROUP local',
          'aaa authentication login error-enable',
          'aaa authorization config-commands default group TACACS-GROUP local',
          ...(bool(values, 'accounting', true) ? ['aaa accounting default group TACACS-GROUP'] : []),
          '!',
        ],
        verify: ['show tacacs-server', 'test aaa group TACACS-GROUP <user> <password>', 'show aaa authentication', 'Log in from a second session before closing this one.'],
        backout: ['no aaa authentication login default group TACACS-GROUP local', 'no aaa group server tacacs+ TACACS-GROUP', ...servers.map((server) => `no tacacs-server host ${server}`), 'no feature tacacs+'],
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_jumbo_qos',
    platform: PLATFORM,
    label: 'Jumbo MTU and a QoS policy',
    group: 'Operations',
    description: 'The network-qos policy that lets jumbo frames through the fabric — the thing everyone forgets until storage traffic starts fragmenting.',
    inputs: [
      { id: 'mtu', label: 'Fabric MTU', control: 'number', default: 9216, min: 1500, max: 9216 },
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'JUMBO' },
      { id: 'no_drop_class', label: 'Lossless class for storage', control: 'toggle', default: false, hint: 'PFC for iSCSI, FCoE or RoCE. Only with a design that expects it' },
    ],
    change: (values                 )               => {
      const mtu = num(values, 'mtu', 9216);
      const name = str(values, 'policy_name', 'JUMBO').toUpperCase();
      const lossless = bool(values, 'no_drop_class', false);
      const findings            = [];
      if (lossless) {
        findings.push(
          warning('network.nxos.pfc', 'A no-drop class changes how the switch buffers everything. Get it wrong and you get pause storms rather than dropped frames, which is harder to see and worse.', {
            remediation: 'Only apply this where the design calls for PFC, and check it hop by hop.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Fabric MTU ${mtu} (network-qos policy ${name})`,
        impact: 'outage',
        notes: [
          'A network-qos policy is applied system-wide and can reset the forwarding engine on some platforms — treat it as a reload, in a window.',
          'Every device in the path needs the same MTU. One hop at 1500 and jumbo frames are dropped silently.',
          'The interface MTU is separate from this: routed interfaces still need `mtu 9216` individually.',
        ],
        before: ['show running-config ipqos', 'show queuing interface brief | include MTU', 'show interface | include MTU'],
        config: [
          `policy-map type network-qos ${name}`,
          '  class type network-qos class-default',
          `    mtu ${mtu}`,
          ...(lossless ? ['  class type network-qos class-fcoe', '    pause no-drop', `    mtu ${mtu}`] : []),
          '!',
          'system qos',
          `  service-policy type network-qos ${name}`,
          '!',
        ],
        verify: ['show running-config ipqos', 'show queuing interface brief', 'ping <far end> packet-size 9000 df-bit'],
        backout: ['system qos', '  no service-policy type network-qos ' + name, '!', `no policy-map type network-qos ${name}`],
        findings,
      };
    },
  }),
];
