/**
 * Arista EOS: the rest of the gaps.
 *
 * The first two files build a fabric — MLAG, VXLAN, BGP underlay — and the
 * operational scaffolding around it. What they never covered is the ordinary
 * work: an access port, a port-channel that is not an MLAG member, a VRF, DHCP
 * relay, IPv6, BFD, VARP, SNMPv3, lossless queuing, streaming telemetry, and
 * the event handlers that are the reason people reach for EOS in the first
 * place.
 *
 * Every change here is meant to be applied inside a configure session with a
 * commit timer. That is the safest way to change a switch you are reaching
 * through, and each verification section says so.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { containsAny, familyOf, formatHostPort, isIpv6, splitHostPort } from '../../core/ip.js';
import { description, listOf, parseCidrDual, vlanIds, vlanRange,                   } from '../device.js';
import { addressList, dualAddresses, dualCidrs, dualFindings, prefixEntry } from './nxos-eos-dual.js';

const PLATFORM = 'arista_eos'         ;
const SECRET = '<REQUIRED>';

/** Every EOS change opens a session, so a lost connection rolls back by itself. */
const session = (name        )           => [`configure session ${name}`, '  commit timer 00:05:00'];

export const EOS_EXTRA_2                             = [
  deviceBlueprint({
    id: 'eos_switchport',
    platform: PLATFORM,
    label: 'Access or trunk port',
    group: 'Interfaces',
    description: 'The ordinary port change: an access port in one VLAN with the edge protections, or a trunk with an explicit allowed list.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Ethernet10', hint: 'Ethernet10, or Ethernet10-20' },
      { id: 'mode', label: 'Mode', control: 'select', default: 'access', options: [
        { value: 'access', label: 'Access' },
        { value: 'trunk', label: 'Trunk' },
      ] },
      { id: 'access_vlan', label: 'VLAN', control: 'number', default: 10, min: 1, max: 4094, showWhen: { input: 'mode', equals: ['access'] } },
      { id: 'voice_vlan', label: 'Voice VLAN', control: 'number', default: 0, min: 0, max: 4094, hint: '0 for none', showWhen: { input: 'mode', equals: ['access'] } },
      { id: 'allowed', label: 'Allowed VLANs', control: 'text', default: '10,20,30', showWhen: { input: 'mode', equals: ['trunk'] } },
      { id: 'native_vlan', label: 'Native VLAN', control: 'number', default: 999, min: 1, max: 4094, showWhen: { input: 'mode', equals: ['trunk'] } },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Access port' },
      { id: 'speed', label: 'Speed', control: 'select', default: 'auto', options: [
        { value: 'auto', label: 'Auto-negotiate' },
        { value: 'forced 1000full', label: '1G full, forced' },
        { value: 'forced 10000full', label: '10G full, forced' },
      ] },
      { id: 'protections', label: 'Edge protections', control: 'toggle', default: true, hint: 'BPDU guard, portfast and storm control on an access port' },
      { id: 'storm_level', label: 'Broadcast storm control (%)', control: 'number', default: 1, min: 0, max: 100, showWhen: { input: 'protections', equals: ['true'] } },
    ],
    change: (values                 )               => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const trunk = str(values, 'mode', 'access') === 'trunk';
      const allowed = vlanIds(str(values, 'allowed', ''));
      const native = num(values, 'native_vlan', 999);
      const voice = num(values, 'voice_vlan', 0);
      const protections = bool(values, 'protections', true);
      const findings            = [];
      if (ifaces.length === 0) findings.push(error('network.eos.no-interfaces', 'No interface was named.', { source: 'ArchToolKit' }));
      if (trunk && allowed.length === 0) {
        findings.push(error('network.eos.trunk-no-vlans', 'A trunk with no allowed VLAN list carries every VLAN, including ones added later by someone else.', { remediation: 'Name the VLANs this trunk is meant to carry.', source: 'ArchToolKit' }));
      }
      if (trunk && allowed.includes(native)) {
        findings.push(warning('network.eos.native-in-allowed', `VLAN ${native} is both the native VLAN and in the allowed list, so its traffic crosses untagged. That is a VLAN-hopping path unless it is deliberate.`, { source: 'ArchToolKit' }));
      }
      if (trunk && protections) {
        findings.push(warning('network.eos.bpduguard-trunk', 'BPDU guard on a trunk will shut the port the moment the switch at the other end speaks spanning tree, which is immediately.', { remediation: 'Leave the edge protections off for a trunk to another switch.', source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `${trunk ? 'Trunk' : 'Access'} port ${ifaces.join(', ')}`,
        impact: 'brief',
        notes: [
          'Applied in a configure session with a commit timer: if the session is not confirmed within five minutes the switch rolls the change back on its own. That is what makes this safe to run on the port you are connected through.',
          ...(trunk ? ['An allowed list is a whitelist. VLANs created later do not appear on this trunk until it is edited, which is the point.'] : []),
          ...(voice > 0 ? [`Voice VLAN ${voice} is tagged while the data VLAN is untagged. The phone has to be told which VLAN to use, usually by LLDP-MED.`] : []),
        ],
        before: [...ifaces.map((i) => `show running-config interfaces ${i}`), 'show interfaces status', 'show vlan'],
        config: [
          ...session('port-change'),
          ...ifaces.flatMap((iface) => [
            `  interface ${iface}`,
            `    description ${description(str(values, 'port_description', ''), trunk ? 'Trunk' : 'Access port')}`,
            ...(str(values, 'speed', 'auto') !== 'auto' ? [`    speed ${str(values, 'speed', 'auto')}`] : []),
            ...(trunk
              ? [
                  '    switchport mode trunk',
                  `    switchport trunk allowed vlan ${vlanRange(allowed)}`,
                  `    switchport trunk native vlan ${native}`,
                ]
              : [
                  '    switchport mode access',
                  `    switchport access vlan ${num(values, 'access_vlan', 10)}`,
                  ...(voice > 0 ? [`    switchport voice vlan ${voice}`] : []),
                  ...(protections
                    ? [
                        '    spanning-tree portfast',
                        '    spanning-tree bpduguard enable',
                        `    storm-control broadcast level ${num(values, 'storm_level', 1)}`,
                        `    storm-control multicast level ${num(values, 'storm_level', 1)}`,
                      ]
                    : []),
                ]),
            '    no shutdown',
            '  !',
          ]),
        ],
        verify: [
          '  show session-config diffs',
          'configure session port-change commit',
          'show interfaces status',
          ...ifaces.map((i) => `show running-config interfaces ${i}`),
          ...(trunk ? ['show interfaces trunk'] : ['show vlan', 'show spanning-tree interface ' + (ifaces[0] ?? '')]),
        ],
        backout: [...session('port-rollback'), ...ifaces.flatMap((i) => [`  default interface ${i}`, '  !']), '  commit'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_port_channel',
    platform: PLATFORM,
    label: 'Port-channel (LACP)',
    group: 'Interfaces',
    description: 'A plain LACP bundle to a server or another switch, separate from the MLAG case: members, mode, load balancing and minimum links.',
    inputs: [
      { id: 'channel_id', label: 'Port-channel id', control: 'number', default: 10, min: 1, max: 999999 },
      { id: 'members', label: 'Member interfaces', control: 'text', default: 'Ethernet10, Ethernet11' },
      { id: 'lacp_mode', label: 'LACP mode', control: 'select', default: 'active', options: [
        { value: 'active', label: 'Active — this side initiates' },
        { value: 'passive', label: 'Passive — waits to be asked' },
        { value: 'on', label: 'On — static, no LACP' },
      ] },
      { id: 'rate', label: 'LACP rate', control: 'select', default: 'normal', options: [
        { value: 'normal', label: 'Normal — 30 second keepalives' },
        { value: 'fast', label: 'Fast — 1 second keepalives' },
      ] },
      { id: 'min_links', label: 'Minimum links', control: 'number', default: 1, min: 1, max: 16 },
      { id: 'mode', label: 'Port mode', control: 'select', default: 'trunk', options: [
        { value: 'trunk', label: 'Trunk' },
        { value: 'access', label: 'Access' },
        { value: 'routed', label: 'Routed' },
      ] },
      { id: 'vlans', label: 'VLANs', control: 'text', default: '10,20,30', showWhen: { input: 'mode', equals: ['trunk', 'access'] } },
      { id: 'address', label: 'Address', control: 'text', default: '10.0.12.1/31', hint: 'IPv4, IPv6, or one of each', showWhen: { input: 'mode', equals: ['routed'] } },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Bundle to server' },
    ],
    change: (values                 )               => {
      const id = num(values, 'channel_id', 10);
      const members = listOf(str(values, 'members', ''));
      const lacp = str(values, 'lacp_mode', 'active');
      const mode = str(values, 'mode', 'trunk');
      const vlans = vlanIds(str(values, 'vlans', ''));
      const address = dualCidrs(mode === 'routed' ? str(values, 'address', '') : '');
      const findings            = dualFindings('network.eos.bad-address', 'the port-channel address', address, '10.0.12.1/31 or 2001:db8:0:12::/127');
      if (mode === 'routed' && !address.v4 && !address.v6) findings.push(error('network.eos.bad-address', 'A routed port-channel needs an address and prefix.', { source: 'ArchToolKit' }));
      if (members.length === 0) findings.push(error('network.eos.no-members', 'A port-channel with no members carries nothing.', { source: 'ArchToolKit' }));
      if (lacp === 'on') {
        findings.push(warning('network.eos.lacp-static', 'A static bundle has no way to notice that the far end is not bundling. A miswired link stays in the channel and blackholes its share of the traffic.', { remediation: 'Use active mode unless the far end genuinely cannot do LACP.', source: 'ArchToolKit' }));
      }
      if (num(values, 'min_links', 1) > members.length) {
        findings.push(error('network.eos.min-links', 'The minimum links setting is higher than the number of members, so the port-channel can never come up.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Port-Channel${id} with ${members.length} member${members.length === 1 ? '' : 's'}`,
        impact: 'brief',
        notes: [
          'Members inherit the port-channel’s configuration. Anything configured on a member interface directly is a source of confusion later — put it on the channel.',
          'Both ends must agree about mode and about which links are in the bundle. LACP tells you when they do not; static mode does not.',
        ],
        before: ['show port-channel summary', ...members.map((m) => `show running-config interfaces ${m}`), 'show lacp neighbor'],
        config: [
          ...session('port-channel'),
          ...(address.v6 ? ['  ipv6 unicast-routing', '  !'] : []),
          `  interface Port-Channel${id}`,
          `    description ${description(str(values, 'port_description', ''), 'Bundle')}`,
          ...(mode === 'routed'
            ? ['    no switchport', ...(address.v4 ? [`    ip address ${address.v4.text}`] : []), ...(address.v6 ? [`    ipv6 address ${address.v6.text}`] : [])]
            : mode === 'trunk'
              ? ['    switchport mode trunk', `    switchport trunk allowed vlan ${vlanRange(vlans)}`]
              : ['    switchport mode access', `    switchport access vlan ${vlans[0] ?? 10}`]),
          `    port-channel min-links ${num(values, 'min_links', 1)}`,
          '    no shutdown',
          '  !',
          ...members.flatMap((member) => [
            `  interface ${member}`,
            `    description Member of Port-Channel${id}`,
            ...(lacp === 'fast' ? [] : []),
            ...(str(values, 'rate', 'normal') === 'fast' ? ['    lacp rate fast'] : []),
            `    channel-group ${id} mode ${lacp}`,
            '    no shutdown',
            '  !',
          ]),
        ],
        verify: ['  show session-config diffs', 'configure session port-channel commit', 'show port-channel summary', `show port-channel ${id} detailed`, 'show lacp neighbor', 'show interfaces status'],
        backout: [...session('pc-rollback'), `  no interface Port-Channel${id}`, ...members.flatMap((m) => [`  default interface ${m}`, '  !']), '  commit'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_vrf',
    platform: PLATFORM,
    label: 'VRF',
    group: 'Routing',
    description: 'A routing table of its own for a tenant or for management, with the interfaces moved into it and the route distinguisher an EVPN fabric needs.',
    inputs: [
      { id: 'name', label: 'VRF name', control: 'text', default: 'TENANT-A' },
      { id: 'rd', label: 'Route distinguisher', control: 'text', default: '10.255.0.11:10010' },
      { id: 'route_target', label: 'Route target', control: 'text', default: '10010:10010' },
      { id: 'interfaces', label: 'Interfaces to move', control: 'text', default: 'Vlan10, Vlan20', hint: 'Moving an interface clears its address' },
      { id: 'vni', label: 'L3 VNI', control: 'number', default: 0, min: 0, max: 16777214, hint: '0 for a VRF that is not in the overlay' },
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65101, min: 1, showWhen: { input: 'vni', notEquals: ['0', ''] } },
      { id: 'default_route', label: 'Default route in the VRF', control: 'text', default: '', hint: 'Next hop, or empty for none. One IPv4 and one IPv6 next hop for a dual-stack VRF' },
    ],
    change: (values                 )               => {
      const name = str(values, 'name', 'TENANT-A');
      const ifaces = listOf(str(values, 'interfaces', ''));
      const vni = num(values, 'vni', 0);
      const hops = dualAddresses(str(values, 'default_route', ''));
      const findings            = dualFindings('network.eos.bad-next-hop', 'the default route next hop', hops, '10.0.0.1 or 2001:db8::1');
      if (hops.v6 && /^fe[89ab]/i.test(hops.v6)) {
        findings.push(error('network.eos.link-local-hop', 'A link-local next hop needs the outgoing interface named, which this change does not take.', { remediation: 'Use the neighbour’s global IPv6 address.', source: 'ArchToolKit' }));
      }
      if (ifaces.length > 0) {
        findings.push(
          warning('network.eos.vrf-clears-address', 'Moving an interface into a VRF removes the address it already had. Capture the addresses first — the back-out here restores the VRF membership, not the addressing.', { source: 'ArchToolKit' }),
        );
      }
      if (vni > 0 && !str(values, 'rd', '')) {
        findings.push(error('network.eos.vrf-no-rd', 'A VRF in an EVPN overlay needs a route distinguisher. Without one its routes are not advertised.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `VRF ${name}`,
        impact: ifaces.length > 0 ? 'outage' : 'none',
        notes: [
          'A VRF is empty until something is in it. Creating it has no effect; moving interfaces into it is the change with the impact.',
          ...(vni > 0 ? [`L3 VNI ${vni} carries this VRF across the fabric. Every leaf that routes for the VRF needs the same VNI and a matching route target.`] : []),
          'Management traffic sourced from an interface in this VRF will not reach anything in the default VRF. Syslog, NTP and TACACS+ all need to be told which VRF to use.',
        ],
        before: ['show vrf', ...ifaces.map((i) => `show running-config interfaces ${i}`), 'show ip route summary'],
        config: [
          ...session(`vrf-${name.toLowerCase()}`),
          `  vrf instance ${name}`,
          '  !',
          '  ip routing vrf ' + name,
          ...(hops.v6 ? [`  ipv6 unicast-routing vrf ${name}`] : []),
          '  !',
          ...(vni > 0
            ? [
                `  interface Vxlan1`,
                `    vxlan vrf ${name} vni ${vni}`,
                '  !',
                `  router bgp ${num(values, 'local_as', 65101)}`,
                `    vrf ${name}`,
                `      rd ${str(values, 'rd', '')}`,
                `      route-target import evpn ${str(values, 'route_target', '')}`,
                `      route-target export evpn ${str(values, 'route_target', '')}`,
                '      redistribute connected',
                '  !',
              ]
            : []),
          ...ifaces.flatMap((iface) => [`  interface ${iface}`, `    vrf ${name}`, '  !']),
          ...(hops.v4 || hops.v6
            ? [...(hops.v4 ? [`  ip route vrf ${name} 0.0.0.0/0 ${hops.v4}`] : []), ...(hops.v6 ? [`  ipv6 route vrf ${name} ::/0 ${hops.v6}`] : []), '  !']
            : []),
        ],
        verify: [
          '  show session-config diffs',
          `configure session vrf-${name.toLowerCase()} commit`,
          'show vrf',
          `show ip route vrf ${name}`,
          ...(hops.v6 ? [`show ipv6 route vrf ${name}`] : []),
          ...(vni > 0 ? ['show bgp evpn route-type ip-prefix ipv4', ...(hops.v6 ? ['show bgp evpn route-type ip-prefix ipv6'] : []), 'show vxlan vni'] : []),
          `ping vrf ${name} <a host in the VRF>`,
        ],
        backout: [...session('vrf-rollback'), ...ifaces.flatMap((i) => [`  interface ${i}`, `    no vrf ${name}`, '  !']), `  no vrf instance ${name}`, '  commit', `${'!'} Then restore the interface addresses from the capture above.`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_varp',
    platform: PLATFORM,
    label: 'VARP or VRRP gateway',
    group: 'Routing',
    description: 'The default gateway for a VLAN: VARP, where both MLAG peers answer for the same address and neither is standby, or VRRP where something needs a conventional election.',
    inputs: [
      { id: 'style', label: 'Style', control: 'select', default: 'varp', options: [
        { value: 'varp', label: 'VARP — both peers active, no election' },
        { value: 'vrrp', label: 'VRRP — one master, one backup' },
      ] },
      { id: 'vlan_id', label: 'VLAN', control: 'number', default: 10, min: 1, max: 4094 },
      { id: 'real_address', label: 'This switch’s address', control: 'text', default: '10.0.10.2/24', hint: 'IPv4, IPv6, or one of each: 10.0.10.2/24, 2001:db8:0:10::2/64' },
      { id: 'virtual_address', label: 'Gateway address', control: 'text', default: '10.0.10.1', hint: 'One per family the VLAN routes: 10.0.10.1, 2001:db8:0:10::1' },
      { id: 'virtual_mac', label: 'Virtual MAC', control: 'text', default: '00:1c:73:00:00:01', showWhen: { input: 'style', equals: ['varp'] } },
      { id: 'group', label: 'VRRP group', control: 'number', default: 10, min: 1, max: 255, showWhen: { input: 'style', equals: ['vrrp'] } },
      { id: 'priority', label: 'VRRP priority', control: 'number', default: 110, min: 1, max: 254, showWhen: { input: 'style', equals: ['vrrp'] } },
      { id: 'vrf', label: 'VRF', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const varp = str(values, 'style', 'varp') === 'varp';
      const vlan = num(values, 'vlan_id', 10);
      const real = dualCidrs(str(values, 'real_address', ''));
      const gw = dualAddresses(str(values, 'virtual_address', ''));
      const virtual = [gw.v4, gw.v6].filter((v)              => v !== null).join(', ');
      const vrf = str(values, 'vrf', '');
      const group = num(values, 'group', 10);
      const findings            = [
        ...dualFindings('network.eos.bad-address', 'this switch’s address', real, '10.0.10.2/24 or 2001:db8:0:10::2/64'),
        ...dualFindings('network.eos.bad-address', 'the gateway address', gw, '10.0.10.1 or 2001:db8:0:10::1'),
      ];
      if (!real.v4 && !real.v6) findings.push(error('network.eos.bad-address', 'This switch’s address is not a valid address and prefix.', { source: 'ArchToolKit' }));
      for (const family of [4, 6]         ) {
        const v = family === 4 ? gw.v4 : gw.v6;
        const r = family === 4 ? real.v4 : real.v6;
        if (v && !r && (real.v4 || real.v6)) findings.push(error('network.eos.gateway-family', `The gateway ${v} is IPv${family}, and this switch has no IPv${family} address in the VLAN.`, { source: 'ArchToolKit' }));
        if (v && r && !containsAny(`${r.network}/${r.prefix}`, v)) findings.push(error('network.eos.gateway-subnet', `The gateway ${v} is not in ${r.network}/${r.prefix}.`, { source: 'ArchToolKit' }));
      }
      if (varp) {
        findings.push(
          warning('network.eos.varp-mac', 'The virtual MAC must be identical on both MLAG peers and different from every other VARP MAC in the network. Two VLANs sharing one virtual MAC is a fault that only appears when a host moves.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: varp ? `VARP gateway on VLAN ${vlan}` : `VRRP group ${num(values, 'group', 10)} on VLAN ${vlan}`,
        impact: 'brief',
        notes: [
          varp
            ? 'With VARP both peers answer ARP for the gateway and both route. There is no failover to wait for, and no way to tell which peer a given host is using — which is the point.'
            : 'VRRP elects one master. The backup does nothing until the master fails, so half the capacity sits idle. VARP is usually the better answer on an MLAG pair.',
          'Hosts hold the old gateway MAC until their ARP entry ages. Changing gateway style under a live VLAN leaves some hosts talking to a MAC that stopped answering.',
          ...(!varp && gw.v6 ? ['IPv6 VRRP is VRRPv3; EOS runs IPv6 groups as version 3 without being told.'] : []),
          ...(!varp && gw.v4 && gw.v6 ? ['VERIFY: both families share group number and priority here. Confirm the release in use keeps IPv4 and IPv6 in one group id, or give IPv6 its own.'] : []),
        ],
        before: [`show running-config interfaces Vlan${vlan}`, 'show ip virtual-router', 'show vrrp', `show ip arp vrf ${vrf || 'default'}`, ...(gw.v6 ? [`show ipv6 neighbors vrf ${vrf || 'default'}`] : [])],
        config: [
          ...session(`gateway-vlan${vlan}`),
          ...(real.v6 ? [`  ipv6 unicast-routing${vrf ? ` vrf ${vrf}` : ''}`, '  !'] : []),
          ...(varp ? [`  ip virtual-router mac-address ${str(values, 'virtual_mac', '')}`, '  !'] : []),
          `  interface Vlan${vlan}`,
          ...(vrf ? [`    vrf ${vrf}`] : []),
          ...(real.v4 ? [`    ip address ${real.v4.text}`] : []),
          ...(real.v6 ? [`    ipv6 address ${real.v6.text}`] : []),
          ...(varp
            ? [...(gw.v4 ? [`    ip virtual-router address ${gw.v4}`] : []), ...(gw.v6 ? [`    ipv6 virtual-router address ${gw.v6}`] : [])]
            : [
                ...(gw.v4 ? [`    vrrp ${group} ipv4 ${gw.v4}`] : []),
                ...(gw.v6 ? [`    vrrp ${group} ipv6 ${gw.v6}`] : []),
                `    vrrp ${group} priority-level ${num(values, 'priority', 110)}`,
                `    vrrp ${group} preempt delay minimum 180`,
              ]),
          '    no shutdown',
          '  !',
        ],
        verify: [
          '  show session-config diffs',
          `configure session gateway-vlan${vlan} commit`,
          ...(varp ? ['show ip virtual-router', 'show ip virtual-router mac-address'] : [`show vrrp group ${group}`, 'show vrrp brief']),
          ...(gw.v4 || !gw.v6 ? [`ping ${gw.v4 ?? virtual}`] : []),
          ...(gw.v6 ? [`ping${vrf ? ` vrf ${vrf}` : ''} ipv6 ${gw.v6}`] : []),
          `${'!'} From a host in the VLAN: ping the gateway, then something beyond it`,
        ],
        backout: [
          ...session('gateway-rollback'),
          `  interface Vlan${vlan}`,
          ...(varp ? [...(gw.v4 ? [`    no ip virtual-router address ${gw.v4}`] : []), ...(gw.v6 ? [`    no ipv6 virtual-router address ${gw.v6}`] : [])] : [`    no vrrp ${group}`]),
          '  !',
          '  commit',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_dhcp_relay',
    platform: PLATFORM,
    label: 'DHCP relay',
    group: 'Services',
    description: 'Relay DHCP from an SVI to servers elsewhere, with the source interface a fabric with anycast gateways needs.',
    inputs: [
      { id: 'interfaces', label: 'SVIs', control: 'text', default: 'Vlan10, Vlan20' },
      { id: 'servers', label: 'DHCP servers', control: 'text', default: '10.0.1.10, 10.0.2.10', hint: 'IPv4 servers get DHCP relay, IPv6 servers DHCPv6 relay; both may be listed' },
      { id: 'source_interface', label: 'Relay source interface', control: 'text', default: 'Loopback0' },
      { id: 'option_82', label: 'Insert option 82', control: 'toggle', default: false },
      { id: 'vrf', label: 'VRF', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const servers = listOf(str(values, 'servers', ''));
      const { v4, v6, invalid } = addressList(str(values, 'servers', ''));
      const source = str(values, 'source_interface', '');
      const vrf = str(values, 'vrf', '') ? ` vrf ${str(values, 'vrf', '')}` : '';
      const findings            = invalid.map((s) => error('network.eos.bad-server', `The DHCP server "${s}" is not an IPv4 or IPv6 address.`, { source: 'ArchToolKit' }));
      if (servers.length === 0) findings.push(error('network.eos.no-servers', 'No DHCP server address was given.', { source: 'ArchToolKit' }));
      if (servers.length === 1) findings.push(warning('network.eos.single-dhcp', 'One relay destination means one server failure takes addressing down for this VLAN.', { source: 'ArchToolKit' }));
      if (!source) {
        findings.push(warning('network.eos.relay-source', 'With VARP, every leaf relays from the same gateway address and the reply can come back to the wrong switch. A per-switch loopback as the relay source is what makes this work.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `DHCP relay to ${servers.join(', ')}`,
        impact: 'brief',
        notes: [
          'Existing leases survive. The effect appears at renewal, so a mistake here can look fine for hours.',
          'The server needs a scope selected by the giaddr and a route back to the relay source.',
          ...(v6.length > 0 ? ['DHCPv6 relay is set per interface with `ipv6 dhcp relay destination`. The SVI needs an IPv6 address, and router advertisements must set the managed flag or clients never ask.'] : []),
          ...(v6.length > 0 && source ? [`VERIFY: the relay source ${source} is written for DHCP (IPv4) only. Check how the release in use sets the DHCPv6 relay source before relying on it with anycast gateways.`] : []),
        ],
        before: ['show dhcp relay', 'show dhcp relay counters', ...ifaces.map((i) => `show running-config interfaces ${i}`)],
        config: [
          ...session('dhcp-relay'),
          ...(source ? [`  ip dhcp relay all-subnets default`, `  dhcp relay source-interface ${source}`, '  !'] : []),
          ...(bool(values, 'option_82', false) ? ['  ip dhcp relay information option', '  !'] : []),
          ...ifaces.flatMap((iface) => [
            `  interface ${iface}`,
            ...v4.map((server) => `    ip helper-address ${server}${vrf}`),
            ...v6.map((server) => `    ipv6 dhcp relay destination ${server}${vrf}`),
            '  !',
          ]),
        ],
        verify: ['  show session-config diffs', 'configure session dhcp-relay commit', 'show dhcp relay', 'show dhcp relay counters', `${'!'} From a client: release and renew, and confirm the address and gateway`],
        backout: [
          ...session('dhcp-rollback'),
          ...ifaces.flatMap((i) => [`  interface ${i}`, ...v4.map((s) => `    no ip helper-address ${s}`), ...v6.map((s) => `    no ipv6 dhcp relay destination ${s}${vrf}`), '  !']),
          '  commit',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_event_handler',
    platform: PLATFORM,
    label: 'Event handler',
    group: 'Operations',
    description: 'Run something when the switch notices something: capture state on an interface flap, log a BGP session going down, or push a file when the configuration changes.',
    inputs: [
      { id: 'name', label: 'Handler name', control: 'text', default: 'CAPTURE-ON-FLAP' },
      { id: 'trigger', label: 'Trigger', control: 'select', default: 'on-intf', options: [
        { value: 'on-intf', label: 'An interface changes state' },
        { value: 'on-counters', label: 'A counter crosses a threshold' },
        { value: 'on-startup-config', label: 'The startup configuration is saved' },
        { value: 'on-boot', label: 'The switch boots' },
      ] },
      { id: 'interface', label: 'Interface', control: 'text', default: 'Ethernet1', showWhen: { input: 'trigger', equals: ['on-intf'] } },
      { id: 'condition', label: 'Interface condition', control: 'select', default: 'operstatus', options: [
        { value: 'operstatus', label: 'Link up or down' },
        { value: 'ip', label: 'IPv4 address changes' },
      ], showWhen: { input: 'trigger', equals: ['on-intf'] } },
      { id: 'action', label: 'Action', control: 'select', default: 'capture', options: [
        { value: 'capture', label: 'Capture state to a file' },
        { value: 'log', label: 'Write a syslog message' },
        { value: 'custom', label: 'Run the commands below' },
      ] },
      { id: 'commands', label: 'Commands', control: 'textarea', default: 'show interfaces counters errors\nshow logging last 50', hint: 'One per line', showWhen: { input: 'action', equals: ['custom', 'capture'] } },
      { id: 'delay', label: 'Delay before running (seconds)', control: 'number', default: 0, min: 0, max: 3600 },
      { id: 'asynchronous', label: 'Run asynchronously', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const name = str(values, 'name', 'HANDLER').toUpperCase().replace(/\s+/g, '-');
      const trigger = str(values, 'trigger', 'on-intf');
      const action = str(values, 'action', 'capture');
      const commands = str(values, 'commands', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const findings            = [];
      if (action !== 'log' && commands.length === 0) {
        findings.push(error('network.eos.handler-no-commands', 'The handler has nothing to run.', { source: 'ArchToolKit' }));
      }
      findings.push(
        warning('network.eos.handler-runs-as-root', 'An event handler action runs as a shell command on the switch, outside the command authorisation that applies to a logged-in user. Anything it can do, it will do unattended and without an approval.', {
          remediation: 'Keep handlers to read-only capture and logging. A handler that changes configuration should be a deliberate, reviewed decision.',
          source: 'ArchToolKit',
        }),
      );
      if (!bool(values, 'asynchronous', true)) {
        findings.push(warning('network.eos.handler-sync', 'A synchronous handler blocks the process that triggered it until it finishes. On a flapping interface that is a switch that stops responding.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Event handler ${name}`,
        impact: 'none',
        notes: [
          'The handler does not run when it is created. Test it by causing the trigger deliberately, on a port that does not matter.',
          'Output goes to flash. A handler that writes on every flap will fill the filesystem on a port that is flapping, which is exactly when it was needed.',
        ],
        before: ['show event-handler', 'show running-config section event-handler', 'dir flash:'],
        config: [
          ...session(`handler-${name.toLowerCase()}`),
          `  event-handler ${name}`,
          ...(trigger === 'on-intf'
            ? [`    trigger on-intf ${str(values, 'interface', '')} ${str(values, 'condition', 'operstatus')}`]
            : [`    trigger ${trigger}`]),
          '    action bash',
          ...(action === 'log'
            ? [`      logger -p local4.notice -t ${name} "Triggered"`]
            : commands.map((command) => `      FastCli -p 15 -c '${command}' >> /mnt/flash/${name.toLowerCase()}.log 2>&1`)),
          '    !',
          ...(num(values, 'delay', 0) > 0 ? [`    delay ${num(values, 'delay', 0)}`] : []),
          ...(bool(values, 'asynchronous', true) ? ['    asynchronous'] : []),
          '  !',
        ],
        verify: [
          '  show session-config diffs',
          `configure session handler-${name.toLowerCase()} commit`,
          'show event-handler',
          `show event-handler ${name}`,
          `${'!'} Cause the trigger deliberately on something that does not matter, then:`,
          `bash cat /mnt/flash/${name.toLowerCase()}.log`,
        ],
        backout: [...session('handler-rollback'), `  no event-handler ${name}`, '  commit'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_pfc_qos',
    platform: PLATFORM,
    label: 'Lossless queuing (PFC and ETS)',
    group: 'QoS',
    description: 'Priority flow control and bandwidth guarantees for storage or RDMA traffic that cannot tolerate a drop.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Ethernet1-8' },
      { id: 'lossless_priority', label: 'Lossless priority', control: 'select', default: '3', options: [
        { value: '3', label: '3 — the usual answer for FCoE and RoCEv2' },
        { value: '4', label: '4' },
      ] },
      { id: 'lossless_bandwidth', label: 'Guaranteed bandwidth (%)', control: 'number', default: 50, min: 1, max: 99 },
      { id: 'ecn', label: 'ECN marking', control: 'toggle', default: true, hint: 'Mark rather than drop, so senders slow down first' },
      { id: 'ecn_min', label: 'ECN minimum threshold (KB)', control: 'number', default: 100, min: 1, max: 100000, showWhen: { input: 'ecn', equals: ['true'] } },
      { id: 'ecn_max', label: 'ECN maximum threshold (KB)', control: 'number', default: 500, min: 1, max: 100000, showWhen: { input: 'ecn', equals: ['true'] } },
      { id: 'trust', label: 'Trust', control: 'select', default: 'dscp', options: [
        { value: 'dscp', label: 'DSCP' },
        { value: 'cos', label: 'CoS' },
      ] },
    ],
    change: (values                 )               => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const priority = str(values, 'lossless_priority', '3');
      const bandwidth = num(values, 'lossless_bandwidth', 50);
      const ecnMin = num(values, 'ecn_min', 100);
      const ecnMax = num(values, 'ecn_max', 500);
      const findings            = [];
      if (ifaces.length === 0) findings.push(error('network.eos.no-interfaces', 'No interface was named.', { source: 'ArchToolKit' }));
      if (ecnMin >= ecnMax) findings.push(error('network.eos.ecn-thresholds', 'The ECN minimum threshold must be below the maximum, or marking behaves as an abrupt cliff rather than a gradient.', { source: 'ArchToolKit' }));
      findings.push(
        warning('network.eos.pfc-end-to-end', 'PFC only works if every hop between the two endpoints honours the same priority, including the host NICs. One device in the path that does not is where the drops happen, and it will not be this one.', {
          remediation: 'Confirm the NIC configuration and every switch on the path before relying on this.',
          source: 'ArchToolKit',
        }),
      );
      if (bandwidth > 70) {
        findings.push(warning('network.eos.pfc-bandwidth', 'Guaranteeing most of the link to one priority starves everything else during congestion, including the routing protocols if they are not separately protected.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Lossless priority ${priority} on ${ifaces.join(', ')}`,
        impact: 'brief',
        notes: [
          'Enabling PFC on an interface can bounce it on some platforms, because the buffer carving changes.',
          'PFC pauses a priority rather than dropping it. A misbehaving sender can therefore pause the link for everybody on that priority — which is why the bandwidth guarantee and ECN matter as much as the PFC itself.',
        ],
        before: ['show qos interfaces', 'show priority-flow-control', 'show interfaces counters queue', 'show platform trident counters'],
        config: [
          ...session('lossless'),
          ...ifaces.flatMap((iface) => [
            `  interface ${iface}`,
            `    qos trust ${str(values, 'trust', 'dscp')}`,
            '    priority-flow-control on',
            `    priority-flow-control priority ${priority} no-drop`,
            '  !',
          ]),
          '  policy-map type quality-of-service LOSSLESS',
          `    class class-default`,
          '  !',
          `  tx-queue ${priority}`,
          `    bandwidth percent ${bandwidth}`,
          ...(bool(values, 'ecn', true) ? [`    random-detect ecn minimum-threshold ${ecnMin} kbytes maximum-threshold ${ecnMax} kbytes max-mark-probability 100`] : []),
          '  !',
        ],
        verify: [
          '  show session-config diffs',
          'configure session lossless commit',
          'show priority-flow-control',
          'show priority-flow-control counters',
          'show qos interfaces',
          'show interfaces counters queue',
          `${'!'} Watch the PFC pause counters under load — they should be non-zero and not constant`,
        ],
        backout: [...session('lossless-rollback'), ...ifaces.flatMap((i) => [`  interface ${i}`, '    no priority-flow-control', '  !']), '  commit'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_bfd',
    platform: PLATFORM,
    label: 'BFD',
    group: 'Routing',
    description: 'Sub-second failure detection, attached to BGP or OSPF, with the timers written down rather than left at the default.',
    inputs: [
      { id: 'interval', label: 'Transmit interval (ms)', control: 'number', default: 300, min: 50, max: 9000 },
      { id: 'min_rx', label: 'Minimum receive (ms)', control: 'number', default: 300, min: 50, max: 9000 },
      { id: 'multiplier', label: 'Multiplier', control: 'number', default: 3, min: 3, max: 50 },
      { id: 'protocol', label: 'Attach to', control: 'select', default: 'bgp', options: [
        { value: 'bgp', label: 'BGP' },
        { value: 'ospf', label: 'OSPF' },
      ] },
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65101, min: 1, showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'peer_group', label: 'Peer group', control: 'text', default: 'UNDERLAY', showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Ethernet1-4', showWhen: { input: 'protocol', equals: ['ospf'] } },
    ],
    change: (values                 )               => {
      const interval = num(values, 'interval', 300);
      const multiplier = num(values, 'multiplier', 3);
      const protocol = str(values, 'protocol', 'bgp');
      const ifaces = listOf(str(values, 'interfaces', ''));
      const findings            = [];
      if (interval < 150) {
        findings.push(warning('network.eos.bfd-aggressive', `${interval}ms × ${multiplier} declares a neighbour dead in ${(interval * multiplier) / 1000}s. Below 150ms a control-plane spike can flap every session at once.`, { source: 'ArchToolKit' }));
      }
      if (protocol === 'ospf' && ifaces.length === 0) {
        findings.push(error('network.eos.no-interfaces', 'OSPF BFD needs the interfaces naming.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `BFD for ${protocol.toUpperCase()}`,
        impact: 'brief',
        notes: [
          'Both ends need BFD. One side only gives a session that never comes up and a protocol that keeps its own timers.',
          `Failure is declared after ${(interval * multiplier) / 1000}s with these numbers.`,
          'Enabling BFD on an established session can bounce it once. Do one link at a time across a redundant pair.',
        ],
        before: ['show bfd peers', 'show ip bgp summary', 'show ip ospf neighbor'],
        config: [
          ...session('bfd'),
          '  router bfd',
          `    interval ${interval} min-rx ${num(values, 'min_rx', 300)} multiplier ${multiplier}`,
          '  !',
          ...(protocol === 'bgp'
            ? [`  router bgp ${num(values, 'local_as', 65101)}`, `    neighbor ${str(values, 'peer_group', 'UNDERLAY')} bfd`, '  !']
            : [...ifaces.flatMap((i) => [`  interface ${i}`, '    ospf bfd', '  !'])]),
        ],
        verify: ['  show session-config diffs', 'configure session bfd commit', 'show bfd peers detail', `show ip ${protocol === 'bgp' ? 'bgp summary' : 'ospf neighbor'}`, `${'!'} Fail one link and time the reconvergence`],
        backout: [...session('bfd-rollback'), ...(protocol === 'bgp' ? [`  router bgp ${num(values, 'local_as', 65101)}`, `    no neighbor ${str(values, 'peer_group', 'UNDERLAY')} bfd`, '  !'] : ifaces.flatMap((i) => [`  interface ${i}`, '    no ospf bfd', '  !'])), '  commit'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_snmpv3',
    platform: PLATFORM,
    label: 'SNMPv3',
    group: 'Management',
    description: 'An authenticated, encrypted SNMPv3 user restricted to a view and a manager, in the management VRF.',
    inputs: [
      { id: 'group', label: 'Group', control: 'text', default: 'MONITOR-RO' },
      { id: 'user', label: 'User', control: 'text', default: 'monitoring' },
      { id: 'auth', label: 'Authentication', control: 'select', default: 'sha', options: [
        { value: 'sha', label: 'SHA' },
        { value: 'sha256', label: 'SHA-256' },
      ] },
      { id: 'privacy', label: 'Encryption', control: 'select', default: 'aes', options: [
        { value: 'aes', label: 'AES-128' },
        { value: 'aes256', label: 'AES-256' },
        { value: 'none', label: 'None' },
      ] },
      { id: 'host', label: 'Trap receiver', control: 'text', default: '10.0.1.50', hint: 'IPv4 or IPv6 address, or a name' },
      { id: 'vrf', label: 'Management VRF', control: 'text', default: 'MGMT' },
      { id: 'source_interface', label: 'Source interface', control: 'text', default: 'Management1' },
      { id: 'remove_v2c', label: 'Remove the v2c strings', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const user = str(values, 'user', 'monitoring');
      const group = str(values, 'group', 'MONITOR-RO');
      const auth = str(values, 'auth', 'sha');
      const privacy = str(values, 'privacy', 'aes');
      const host = str(values, 'host', '');
      const vrf = str(values, 'vrf', 'MGMT');
      const findings            = [];
      if (privacy === 'none') findings.push(warning('network.eos.snmp-noencrypt', 'authNoPriv sends every reply in clear text.', { source: 'ArchToolKit' }));
      if (!bool(values, 'remove_v2c', true)) findings.push(warning('network.eos.snmp-v2c-left', 'A v2c string left in place is the way in, whatever v3 is configured alongside it.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `SNMPv3 user ${user}`,
        impact: 'none',
        notes: [
          'Both passphrases are `<REQUIRED>` and typed at apply time. They belong in the vault the playbook reads, not in the change record.',
          'EOS will not display the passphrases afterwards. Losing them means creating the user again.',
        ],
        before: ['show snmp user', 'show snmp group', 'show snmp host', 'show running-config section snmp'],
        config: [
          ...session('snmpv3'),
          `  snmp-server view ${group}-VIEW iso included`,
          `  snmp-server group ${group} v3 ${privacy === 'none' ? 'auth' : 'priv'} read ${group}-VIEW`,
          `  snmp-server user ${user} ${group} v3 auth ${auth} ${SECRET}${privacy === 'none' ? '' : ` priv ${privacy} ${SECRET}`}`,
          ...(host ? [`  snmp-server host ${host} vrf ${vrf} version 3 ${privacy === 'none' ? 'auth' : 'priv'} ${user}`] : []),
          `  snmp-server vrf ${vrf}`,
          ...(str(values, 'source_interface', '') ? [`  snmp-server source-interface ${str(values, 'source_interface', '')}`] : []),
          '  snmp-server enable traps snmp linkdown linkup',
          '  snmp-server enable traps bgp',
          '  !',
          ...(bool(values, 'remove_v2c', true) ? [`  ${'!'} Remove every v2c string the device still has. The capture above lists them.`, `  ${'!'} no snmp-server community <name>`] : []),
        ],
        verify: ['  show session-config diffs', 'configure session snmpv3 commit', 'show snmp user', 'show snmp host', `${'!'} From the manager: snmpwalk -v3 -l authPriv -u ${user} <device> sysName`],
        backout: [...session('snmp-rollback'), `  no snmp-server user ${user} ${group} v3`, `  no snmp-server group ${group} v3 ${privacy === 'none' ? 'auth' : 'priv'}`, '  commit'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_telemetry',
    platform: PLATFORM,
    label: 'Streaming telemetry (TerminAttr)',
    group: 'Operations',
    description: 'Stream state to CloudVision or an OpenConfig collector instead of polling it — the switch pushes what changed, when it changes.',
    inputs: [
      { id: 'destination', label: 'Collector', control: 'select', default: 'cvp', options: [
        { value: 'cvp', label: 'CloudVision' },
        { value: 'grpc', label: 'A gNMI or OpenConfig collector' },
      ] },
      { id: 'servers', label: 'Collector addresses', control: 'text', default: '10.0.1.80:9910', hint: 'address:port, comma separated; IPv6 as [2001:db8::80]:9910' },
      { id: 'vrf', label: 'VRF', control: 'text', default: 'MGMT' },
      { id: 'ingest_auth', label: 'Authentication', control: 'select', default: 'token', options: [
        { value: 'token', label: 'Token from the collector' },
        { value: 'certs', label: 'Mutual TLS certificates' },
        { value: 'none', label: 'None — a lab or a trusted segment' },
      ] },
      { id: 'compression', label: 'Compression', control: 'select', default: 'gzip', options: [
        { value: 'gzip', label: 'gzip' },
        { value: 'none', label: 'None' },
      ] },
      { id: 'smash_excludes', label: 'Exclude high-churn state', control: 'toggle', default: true, hint: 'Counters that change constantly and are rarely wanted' },
    ],
    change: (values                 )               => {
      // TerminAttr takes host:port, and an IPv6 host has to be in brackets or its colons read as the port.
      const endpoints = listOf(str(values, 'servers', '')).map((text) => ({ text, ...splitHostPort(text) }));
      const servers = endpoints.map((e) => (e.port === null ? e.text : formatHostPort(e.host, e.port)));
      const vrf = str(values, 'vrf', 'MGMT');
      const auth = str(values, 'ingest_auth', 'token');
      const findings            = endpoints
        .filter((e) => e.port === null)
        .map((e) => error('network.eos.collector-port', `"${e.text}" has no port. The collector is written as address:port${familyOf(e.host) === 6 ? ', and an IPv6 address goes in brackets: [2001:db8::80]:9910' : ''}.`, { source: 'ArchToolKit' }));
      if (servers.length === 0) findings.push(error('network.eos.no-collector', 'No collector address was given, so the agent would start and stream to nothing.', { source: 'ArchToolKit' }));
      if (auth === 'none') {
        findings.push(warning('network.eos.telemetry-unauthenticated', 'An unauthenticated telemetry stream carries the switch’s full state to whoever is listening, and accepts configuration from CloudVision in the other direction.', { remediation: 'Use a token or certificates on anything that is not a lab.', source: 'ArchToolKit' }));
      }
      findings.push(
        warning('network.eos.terminattr-restart', 'Changing the TerminAttr daemon restarts it. The stream stops for a few seconds and the collector shows a gap — which looks identical to the switch going away.', { source: 'ArchToolKit' }),
      );

      return {
        platform: PLATFORM,
        title: `Streaming telemetry to ${servers.join(', ')}`,
        impact: 'none',
        notes: [
          'The token or certificate is `<REQUIRED>` and is placed on the switch separately. It is not written into this configuration and must not go in the change record.',
          'Telemetry is a management path in both directions when CloudVision is the collector: it can push configuration back. That is the point of it, and it is also a thing to know before enabling it.',
          ...(bool(values, 'smash_excludes', true) ? ['The excluded tables are the ones that change constantly and are almost never queried. Including them multiplies the volume for very little.'] : []),
        ],
        before: ['show daemon TerminAttr', 'show agent TerminAttr', 'show version', 'show management api http-commands'],
        config: [
          ...session('telemetry'),
          '  daemon TerminAttr',
          `    exec /usr/bin/TerminAttr -ingestgrpcurl=${servers.join(',')} -taillogs${vrf ? ` -ingestvrf=${vrf}` : ''}${auth === 'token' ? ' -ingestauth=key,<REQUIRED>' : auth === 'certs' ? ' -cafile=/persist/secure/ssl/cacert.pem -certfile=/persist/secure/ssl/client.crt -keyfile=/persist/secure/ssl/client.key' : ''}${str(values, 'compression', 'gzip') === 'gzip' ? ' -grpcaddr=127.0.0.1:6042' : ''}${bool(values, 'smash_excludes', true) ? ' -smashexcludes=ale,flexCounter,hardware,kni,pulse,strata' : ''}`,
          '    no shutdown',
          '  !',
          ...(str(values, 'destination', 'cvp') === 'grpc'
            ? ['  management api gnmi', `    transport grpc default`, ...(vrf ? [`      vrf ${vrf}`] : []), '  !']
            : []),
        ],
        verify: ['  show session-config diffs', 'configure session telemetry commit', 'show daemon TerminAttr', 'show agent TerminAttr logs | tail 30', `${'!'} On the collector: confirm this switch appears and its state is current`],
        backout: [...session('telemetry-rollback'), '  daemon TerminAttr', '    shutdown', '  !', '  commit'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_prefix_list_routemap',
    platform: PLATFORM,
    label: 'Prefix list and route-map',
    group: 'Routing',
    description: 'The filter on its own: a prefix list of what may pass and a route-map that sets what it looks like, ready to be applied to a neighbour in a separate change.',
    inputs: [
      { id: 'list_name', label: 'Prefix list name', control: 'text', default: 'PL-TENANT-IN' },
      { id: 'prefixes', label: 'Prefixes', control: 'textarea', default: '10.10.0.0/16 le 24\n10.20.0.0/16', hint: 'One per line, with optional ge/le. IPv6 prefixes go into a companion ipv6 prefix-list' },
      { id: 'default_action', label: 'Anything not listed', control: 'select', default: 'deny', options: [
        { value: 'deny', label: 'Deny — an allow list' },
        { value: 'permit', label: 'Permit — a deny list' },
      ] },
      { id: 'map_name', label: 'Route-map name', control: 'text', default: 'RM-TENANT-IN' },
      { id: 'set_local_pref', label: 'Set local preference', control: 'number', default: 0, min: 0, hint: '0 to leave it alone' },
      { id: 'set_community', label: 'Set community', control: 'text', default: '', hint: 'e.g. 65101:100' },
      { id: 'prepend', label: 'AS prepends', control: 'number', default: 0, min: 0, max: 10 },
      { id: 'local_as', label: 'Local AS to prepend', control: 'number', default: 65101, min: 1, showWhen: { input: 'prepend', notEquals: ['0', ''] } },
    ],
    change: (values                 )               => {
      const list = str(values, 'list_name', 'PL-IN').toUpperCase();
      const map = str(values, 'map_name', 'RM-IN').toUpperCase();
      const lines = str(values, 'prefixes', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const deny = str(values, 'default_action', 'deny') === 'deny';
      const prepend = num(values, 'prepend', 0);
      const findings            = [];
      if (lines.length === 0) findings.push(error('network.eos.no-prefixes', 'A prefix list with no entries denies everything.', { source: 'ArchToolKit' }));
      const entries = lines.map((line) => prefixEntry(line));
      for (const entry of entries) if (typeof entry === 'string') findings.push(error('network.eos.bad-prefix', entry, { source: 'ArchToolKit' }));
      if (!deny) findings.push(warning('network.eos.permit-default', 'Permitting anything not listed makes this a deny list, which is how an unexpected prefix gets through.', { source: 'ArchToolKit' }));
      // IPv4 and IPv6 are separate prefix lists; the route-map matches each in its own entry.
      const v4 = entries.flatMap((e) => (typeof e !== 'string' && e.family === 4 ? [e.text] : []));
      const v6 = entries.flatMap((e) => (typeof e !== 'string' && e.family === 6 ? [e.text] : []));
      const with4 = v4.length > 0 || v6.length === 0;
      const list6 = `${list}-V6`;
      const sets = [
        ...(num(values, 'set_local_pref', 0) > 0 ? [`    set local-preference ${num(values, 'set_local_pref', 0)}`] : []),
        ...(str(values, 'set_community', '') ? [`    set community ${str(values, 'set_community', '')}`] : []),
        ...(prepend > 0 ? [`    set as-path prepend${` ${num(values, 'local_as', 65101)}`.repeat(prepend)}`] : []),
      ];

      return {
        platform: PLATFORM,
        title: `Prefix list ${list} and route-map ${map}`,
        impact: 'none',
        notes: [
          'This builds the filter and applies it to nothing. Attaching it to a neighbour is the change with the impact — do it separately and watch the table.',
          'A prefix list ends with an implicit deny; the last entry here makes that explicit.',
        ],
        before: [...(with4 ? [`show ip prefix-list ${list}`] : []), ...(v6.length > 0 ? [`show ipv6 prefix-list ${list6}`] : []), `show route-map ${map}`, 'show ip bgp neighbors'],
        config: [
          ...session('routing-policy'),
          ...(with4
            ? [
                `  no ip prefix-list ${list}`,
                ...(v4.length > 0 ? v4 : lines).map((line, index) => `  ip prefix-list ${list} seq ${(index + 1) * 5} permit ${line}`),
                `  ip prefix-list ${list} seq ${((v4.length > 0 ? v4 : lines).length + 1) * 5} ${deny ? 'deny' : 'permit'} 0.0.0.0/0 le 32`,
                '  !',
              ]
            : []),
          // EOS writes an IPv6 prefix list as a mode with seq entries under it.
          ...(v6.length > 0
            ? [
                `  no ipv6 prefix-list ${list6}`,
                `  ipv6 prefix-list ${list6}`,
                ...v6.map((line, index) => `    seq ${(index + 1) * 5} permit ${line}`),
                `    seq ${(v6.length + 1) * 5} ${deny ? 'deny' : 'permit'} ::/0 le 128`,
                '  !',
              ]
            : []),
          ...(with4 ? [`  route-map ${map} permit 10`, `    match ip address prefix-list ${list}`, ...sets, '  !'] : []),
          ...(v6.length > 0 ? [`  route-map ${map} permit 15`, `    match ipv6 address prefix-list ${list6}`, ...sets, '  !'] : []),
          `  route-map ${map} ${deny ? 'deny' : 'permit'} 20`,
          '  !',
        ],
        verify: [
          '  show session-config diffs',
          'configure session routing-policy commit',
          ...(with4 ? [`show ip prefix-list ${list}`] : []),
          ...(v6.length > 0 ? [`show ipv6 prefix-list ${list6}`] : []),
          `show route-map ${map}`,
          `${'!'} Once applied: clear ip bgp <neighbour> soft in`,
          'show ip bgp neighbors <neighbour> received-routes',
        ],
        backout: [...session('policy-rollback'), `  no route-map ${map}`, ...(with4 ? [`  no ip prefix-list ${list}`] : []), ...(v6.length > 0 ? [`  no ipv6 prefix-list ${list6}`] : []), '  commit'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_ipv6_interface',
    platform: PLATFORM,
    label: 'IPv6 on an interface',
    group: 'IPv6',
    description: 'Address an interface for IPv6 and decide what it advertises, including the VARP case where both peers answer for the gateway.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'Vlan10' },
      { id: 'address', label: 'IPv6 address', control: 'text', default: '2001:db8:0:10::2/64' },
      { id: 'virtual_address', label: 'VARP gateway address', control: 'text', default: '', hint: 'Empty for no virtual gateway' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '' },
      { id: 'ra', label: 'Router advertisements', control: 'select', default: 'slaac', options: [
        { value: 'slaac', label: 'SLAAC' },
        { value: 'stateful', label: 'Stateful DHCPv6' },
        { value: 'suppress', label: 'Suppressed — routed link' },
      ] },
      { id: 'ra_interval', label: 'Advertisement interval (seconds)', control: 'number', default: 200, min: 4, max: 1800 },
    ],
    change: (values                 )               => {
      const iface = str(values, 'interface', '');
      const address = str(values, 'address', '');
      const virtual = str(values, 'virtual_address', '');
      const ra = str(values, 'ra', 'slaac');
      const findings            = [];
      if (parseCidrDual(address)?.family !== 6) findings.push(error('network.eos.bad-ipv6', 'The IPv6 address is not an address and prefix length.', { source: 'ArchToolKit' }));
      if (virtual && !isIpv6(virtual)) findings.push(error('network.eos.bad-ipv6', `The VARP gateway "${virtual}" is not an IPv6 address. The IPv4 gateway goes in the VARP or VLAN change.`, { source: 'ArchToolKit' }));
      else if (virtual && parseCidrDual(address)?.family === 6 && !containsAny(address, virtual)) {
        findings.push(error('network.eos.gateway-subnet', `The VARP gateway ${virtual} is not in ${address}.`, { source: 'ArchToolKit' }));
      }
      if (ra === 'slaac' && !address.endsWith('/64')) findings.push(error('network.eos.slaac-prefix', 'SLAAC only works on a /64.', { source: 'ArchToolKit' }));
      if (virtual && ra === 'suppress') {
        findings.push(warning('network.eos.varp6-no-ra', 'A VARP gateway with advertisements suppressed gives hosts no way to learn it. SLAAC hosts will have an address and no route off the subnet.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `IPv6 on ${iface}`,
        impact: 'brief',
        notes: [
          '`ipv6 unicast-routing` has to be on before anything forwards. Without it the interface addresses and routes nothing.',
          'Hosts hold an address until it expires; changing the prefix does not withdraw the old one.',
        ],
        before: [`show running-config interfaces ${iface}`, 'show ipv6 interface brief', `show ipv6 interface ${iface}`],
        config: [
          ...session('ipv6'),
          '  ipv6 unicast-routing',
          '  !',
          `  interface ${iface}`,
          ...(str(values, 'vrf', '') ? [`    vrf ${str(values, 'vrf', '')}`] : []),
          `    ipv6 enable`,
          ...(address ? [`    ipv6 address ${address}`] : []),
          ...(virtual ? [`    ipv6 virtual-router address ${virtual}`] : []),
          ...(ra === 'suppress'
            ? ['    ipv6 nd ra disabled']
            : [`    ipv6 nd ra interval ${num(values, 'ra_interval', 200)}`, ...(ra === 'stateful' ? ['    ipv6 nd managed-config-flag', '    ipv6 nd other-config-flag'] : [])]),
          '    no shutdown',
          '  !',
        ],
        verify: ['  show session-config diffs', 'configure session ipv6 commit', `show ipv6 interface ${iface}`, 'show ipv6 route', 'show ipv6 neighbors', ...(virtual ? ['show ipv6 virtual-router'] : [])],
        backout: [...session('ipv6-rollback'), `  interface ${iface}`, ...(address ? [`    no ipv6 address ${address}`] : []), '    no ipv6 enable', '  !', '  commit'],
        findings,
      };
    },
  }),
];
