/**
 * Cisco IOS-XR network changes: ASR 9000, NCS 540/560/5500 and Cisco 8000.
 *
 * Every change is IOS-XR CLI, pushed with cisco.iosxr.iosxr_config, which
 * applies the file and commits it. Pasted by hand, the file is entered in
 * `configure` and applied with `commit` (or `commit confirmed` where the change
 * could cut off the session). Interfaces, addressing and routing are here;
 * MPLS, L2VPN, security, management and first-hop redundancy are in
 * iosxr-services.ts.
 */

import { bool, num, str,                                           } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
                                                         
import { description, isIpv4, listOf, parseCidrDual,                   } from '../device.js';
import { dualCidrs, dualFindings, routerIdFindings } from './nxos-eos-dual.js';
import { asnFinding, COMMIT_CONFIRMED, PLATFORM, ROLLBACK_NOTE, SECRET, SRC, xrAddress, xrBlueprint, xrInterface, xrName } from './iosxr-common.js';
import { IOSXR_SERVICES } from './iosxr-services.js';

/** The address lines for a dual-stack field, and the findings for what could not be read. */
function addressing(value        , code        , label        , example        )                                                                     {
  const dual = dualCidrs(value);
  const findings = dualFindings(code, label, dual, example);
  const out           = [];
  if (dual.v4) out.push(` ${xrAddress(dual.v4)}`);
  if (dual.v6) out.push(` ${xrAddress(dual.v6)}`);
  return { lines: out, findings, v4: dual.v4 !== null, v6: dual.v6 !== null };
}

const INTERFACES                             = [
  xrBlueprint({
    id: 'iosxr_interface',
    platform: PLATFORM,
    label: 'Routed interface',
    group: 'Interfaces',
    description: 'A physical interface with an IPv4 and/or IPv6 address, a description and an MTU, brought up.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'GigabitEthernet0/0/0/0', hint: 'rack/slot/module/port: HundredGigE0/0/0/1, TenGigE0/0/0/4' },
      { id: 'address', label: 'Address', control: 'text', default: '10.0.12.1/30', hint: 'IPv4, IPv6, or one of each: 10.0.12.1/30, 2001:db8:12::1/64' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'to PE2 Gi0/0/0/0' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 9216, min: 1514, max: 9646, hint: 'IOS-XR counts the L2 header: 1514 is the default, 9216 is the usual core value' },
    ],
    change: (values                 )               => {
      const intf = xrInterface(str(values, 'interface', ''), 'GigabitEthernet0/0/0/0');
      const addr = addressing(str(values, 'address', ''), 'network.iosxr.bad-address', 'the interface address', '10.0.12.1/30 or 2001:db8:12::1/64');
      const mtu = num(values, 'mtu', 9216);
      const findings = [...addr.findings];
      if (!addr.v4 && !addr.v6) findings.push(warning('network.iosxr.no-address', 'No address is set, so the interface comes up unnumbered and routes nothing.', SRC));
      return {
        platform: PLATFORM,
        title: `Routed interface ${intf}`,
        impact: 'brief',
        notes: [
          'A physical interface keeps whatever is already on it: capture it first, because a leftover address or shutdown will survive this change.',
          'Both ends need the same MTU, or OSPF and IS-IS adjacencies stall at exchange.',
          COMMIT_CONFIRMED,
          ROLLBACK_NOTE,
        ],
        before: [`show running-config interface ${intf}`, `show interfaces ${intf} brief`, 'show ipv4 interface brief', 'show ipv6 interface brief'],
        config: [
          `interface ${intf}`,
          ` description ${description(str(values, 'port_description', ''), 'routed interface')}`,
          ` mtu ${mtu}`,
          ...addr.lines,
          ' no shutdown',
          '!',
        ],
        verify: [`show interfaces ${intf}`, `show ipv4 interface ${intf}`, ...(addr.v6 ? [`show ipv6 interface ${intf}`] : []), 'show configuration commit list 1'],
        backout: [`no interface ${intf}`, '! removes its configuration: a physical interface returns to the default, shut down', 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_subinterface',
    platform: PLATFORM,
    label: 'Dot1q sub-interface',
    group: 'Interfaces',
    description: 'A layer 3 sub-interface on a physical port or bundle, with an 802.1Q tag and an address, optionally in a VRF.',
    inputs: [
      { id: 'parent', label: 'Parent interface', control: 'text', default: 'GigabitEthernet0/0/0/1', hint: 'A physical port or Bundle-Ether' },
      { id: 'vlan', label: 'VLAN tag', control: 'number', default: 100, min: 1, max: 4094 },
      { id: 'address', label: 'Address', control: 'text', default: '10.1.100.1/24', hint: 'IPv4, IPv6, or one of each' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Empty for the global table; the VRF must already exist' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'customer A VLAN 100' },
    ],
    change: (values                 )               => {
      const parent = xrInterface(str(values, 'parent', ''), 'GigabitEthernet0/0/0/1');
      const vlan = num(values, 'vlan', 100);
      const intf = `${parent}.${vlan}`;
      const vrf = str(values, 'vrf', '');
      const addr = addressing(str(values, 'address', ''), 'network.iosxr.bad-address', 'the sub-interface address', '10.1.100.1/24');
      return {
        platform: PLATFORM,
        title: `Sub-interface ${intf} (VLAN ${vlan})`,
        impact: 'none',
        notes: [
          'The parent must be up and must not be an l2transport interface itself.',
          ...(vrf ? [`The VRF ${vrf} has to exist before the commit; \`vrf\` has to come before the address, which is the order written here.`] : []),
        ],
        before: [`show running-config interface ${parent}*`, `show interfaces ${parent} brief`, ...(vrf ? [`show vrf ${vrf}`] : [])],
        config: [
          `interface ${intf}`,
          ` description ${description(str(values, 'port_description', ''), `VLAN ${vlan}`)}`,
          ...(vrf ? [` vrf ${vrf}`] : []),
          ...addr.lines,
          ` encapsulation dot1q ${vlan}`,
          '!',
        ],
        verify: [`show interfaces ${intf}`, `show ipv4${vrf ? ` vrf ${vrf}` : ''} interface brief | include ${intf}`, `show arp${vrf ? ` vrf ${vrf}` : ''} ${intf}`],
        backout: [`no interface ${intf}`, 'commit'],
        findings: addr.findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_bundle',
    platform: PLATFORM,
    label: 'Bundle-Ether with LACP',
    group: 'Interfaces',
    description: 'A Bundle-Ether interface with LACP members (`bundle id … mode active`), minimum active links and an address.',
    inputs: [
      { id: 'bundle', label: 'Bundle id', control: 'number', default: 1, min: 1, max: 65535 },
      { id: 'members', label: 'Member interfaces', control: 'text', default: 'HundredGigE0/0/0/0, HundredGigE0/0/0/1' },
      { id: 'address', label: 'Address', control: 'text', default: '10.0.0.1/31', hint: 'Empty for a bundle that only carries sub-interfaces' },
      { id: 'min_links', label: 'Minimum active links', control: 'number', default: 1, min: 1, max: 64 },
      { id: 'lacp_fast', label: 'LACP fast timers', control: 'toggle', default: true, hint: '`lacp period short`: a dead member is noticed in about 3 s instead of 90' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 9216, min: 1514, max: 9646 },
      { id: 'port_description', label: 'Description', control: 'text', default: 'to P1 Bundle-Ether1' },
    ],
    change: (values                 )               => {
      const id = num(values, 'bundle', 1);
      const bundle = `Bundle-Ether${id}`;
      const members = listOf(str(values, 'members', '')).map((m) => xrInterface(m, m));
      const addressValue = str(values, 'address', '');
      const addr = addressValue ? addressing(addressValue, 'network.iosxr.bad-address', 'the bundle address', '10.0.0.1/31') : { lines: [], findings: [], v4: false, v6: false };
      const fast = bool(values, 'lacp_fast', true);
      const minLinks = num(values, 'min_links', 1);
      const findings            = [...addr.findings];
      if (members.length === 0) findings.push(error('network.iosxr.no-members', 'A bundle needs at least one member interface.', SRC));
      if (members.length === 1) findings.push(warning('network.iosxr.single-member', 'A bundle with one member has no redundancy: it is a single link with extra steps.', SRC));
      if (minLinks > members.length && members.length > 0) findings.push(warning('network.iosxr.min-links', `Minimum active links is ${minLinks} but only ${members.length} member(s) are listed, so the bundle never comes up.`, SRC));
      return {
        platform: PLATFORM,
        title: `${bundle} with ${members.length} member(s)`,
        impact: 'brief',
        notes: [
          'The far end needs the same members in an LACP bundle, active or passive, before this one comes up.',
          'A member that had an address or a sub-interface has to be cleared first: `bundle id` is refused on a configured interface.',
          COMMIT_CONFIRMED,
        ],
        before: [`show running-config interface ${bundle}`, ...members.map((m) => `show running-config interface ${m}`), 'show bundle brief'],
        config: [
          `interface ${bundle}`,
          ` description ${description(str(values, 'port_description', ''), bundle)}`,
          ` mtu ${num(values, 'mtu', 9216)}`,
          ...addr.lines,
          ` bundle minimum-active links ${minLinks}`,
          ...(fast ? [' lacp period short'] : []),
          '!',
          ...members.flatMap((m) => [`interface ${m}`, ` description member of ${bundle}`, ` bundle id ${id} mode active`, ...(fast ? [' lacp period short'] : []), ' no shutdown', '!']),
        ],
        verify: [`show bundle ${bundle}`, `show lacp ${bundle}`, `show interfaces ${bundle}`],
        backout: [...members.flatMap((m) => [`interface ${m}`, ` no bundle id ${id} mode active`, '!']), `no interface ${bundle}`, 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_loopback',
    platform: PLATFORM,
    label: 'Loopback',
    group: 'Interfaces',
    description: 'A loopback with a /32 (and optionally a /128), for the router id, BGP and LDP sessions or an SR prefix-SID.',
    inputs: [
      { id: 'number', label: 'Loopback number', control: 'number', default: 0, min: 0, max: 2147483647 },
      { id: 'address', label: 'Address', control: 'text', default: '10.255.0.1/32', hint: '10.255.0.1/32, 2001:db8::1/128 or both' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'router id' },
    ],
    change: (values                 )               => {
      const n = num(values, 'number', 0);
      const intf = `Loopback${n}`;
      const addr = addressing(str(values, 'address', ''), 'network.iosxr.bad-address', 'the loopback address', '10.255.0.1/32');
      const findings = [...addr.findings];
      const dual = dualCidrs(str(values, 'address', ''));
      if ((dual.v4 && dual.v4.prefix !== 32) || (dual.v6 && dual.v6.prefix !== 128)) findings.push(warning('network.iosxr.loopback-mask', 'A loopback is normally a /32 or a /128.', SRC));
      return {
        platform: PLATFORM,
        title: `${intf} ${dual.v4?.address ?? dual.v6?.address ?? ''}`.trim(),
        impact: 'none',
        notes: ['Advertise it into the IGP (the OSPF or IS-IS blueprint) before anything peers with it.'],
        before: [`show running-config interface ${intf}`, 'show ipv4 interface brief | include Loopback'],
        config: [`interface ${intf}`, ` description ${description(str(values, 'port_description', ''), 'loopback')}`, ...addr.lines, '!'],
        verify: [`show ipv4 interface ${intf}`, ...(dual.v6 ? [`show ipv6 interface ${intf}`] : [])],
        backout: [`no interface ${intf}`, 'commit'],
        findings,
      };
    },
  }),
];

const ROUTING                             = [
  xrBlueprint({
    id: 'iosxr_static_route',
    platform: PLATFORM,
    label: 'Static route',
    group: 'Routing',
    description: 'A static route under `router static`, in the global table or a VRF, with an optional distance for a floating route.',
    inputs: [
      { id: 'prefix', label: 'Destination', control: 'text', default: '10.50.0.0/16', hint: 'IPv4 or IPv6 prefix' },
      { id: 'next_hop', label: 'Next hop', control: 'text', default: '10.0.12.2' },
      { id: 'interface', label: 'Exit interface', control: 'text', default: '', hint: 'Optional; needed for a next hop that is link-local or not directly connected' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '' },
      { id: 'distance', label: 'Administrative distance', control: 'number', default: 1, min: 1, max: 254, hint: 'Above the IGP for a floating backup' },
      { id: 'route_description', label: 'Description', control: 'text', default: 'to branch 50' },
    ],
    change: (values                 )               => {
      const prefix = parseCidrDual(str(values, 'prefix', ''));
      const nextHop = str(values, 'next_hop', '');
      const intf = str(values, 'interface', '') ? xrInterface(str(values, 'interface', ''), '') : '';
      const vrf = str(values, 'vrf', '');
      const distance = num(values, 'distance', 1);
      const findings            = [];
      if (!prefix) findings.push(error('network.iosxr.bad-prefix', 'The destination is not a valid prefix.', { remediation: 'Write it as 10.50.0.0/16 or 2001:db8:50::/48.', ...SRC }));
      if (!nextHop && !intf) findings.push(error('network.iosxr.no-next-hop', 'A static route needs a next hop, an exit interface or both.', SRC));
      const family = prefix?.family === 6 ? 'ipv6' : 'ipv4';
      const dest = prefix ? `${prefix.network}/${prefix.prefix}` : str(values, 'prefix', '');
      const desc = description(str(values, 'route_description', ''), '').replace(/\s+/g, '_');
      const route = `${dest}${intf ? ` ${intf}` : ''}${nextHop ? ` ${nextHop}` : ''}${distance !== 1 ? ` ${distance}` : ''}${desc ? ` description ${desc}` : ''}`;
      const plain = `${dest}${intf ? ` ${intf}` : ''}${nextHop ? ` ${nextHop}` : ''}`;
      const scope = (body          ) => ['router static', ...(vrf ? [` vrf ${vrf}`, `  address-family ${family} unicast`, ...body.map((b) => `   ${b}`)] : [` address-family ${family} unicast`, ...body.map((b) => `  ${b}`)]), '!'];
      return {
        platform: PLATFORM,
        title: `Static route ${dest}${vrf ? ` in VRF ${vrf}` : ''}`,
        impact: 'brief',
        notes: [
          ...(distance === 1 ? ['At distance 1 this route wins over OSPF, IS-IS and BGP for the same prefix: traffic moves as soon as it is committed.'] : []),
          'A static route to a next hop that is not reachable stays out of the RIB silently: check `show route` after the commit.',
        ],
        before: [`show route${vrf ? ` vrf ${vrf}` : ''} ${family} unicast ${dest}`, 'show running-config router static'],
        config: scope([route]),
        verify: [`show route${vrf ? ` vrf ${vrf}` : ''} ${family} unicast ${dest}`, `show cef${vrf ? ` vrf ${vrf}` : ''} ${family} ${dest}`],
        backout: scope([`no ${plain}`]).concat('commit'),
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_ospf',
    platform: PLATFORM,
    label: 'OSPF process and area',
    group: 'Routing',
    description: 'An OSPFv2 process with a router id and interfaces in an area: point-to-point links, a passive loopback and optional BFD.',
    inputs: [
      { id: 'process', label: 'Process name', control: 'text', default: 'CORE' },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.1' },
      { id: 'area', label: 'Area', control: 'text', default: '0' },
      { id: 'interfaces', label: 'Links', control: 'text', default: 'GigabitEthernet0/0/0/0, GigabitEthernet0/0/0/1', hint: 'Point-to-point links in the area' },
      { id: 'passive', label: 'Passive interfaces', control: 'text', default: 'Loopback0', hint: 'Advertised, never peered on' },
      { id: 'bfd', label: 'BFD fast-detect', control: 'toggle', default: true },
      { id: 'cost', label: 'Link cost', control: 'number', default: 0, min: 0, max: 65535, hint: '0 leaves the reference-bandwidth default' },
    ],
    change: (values                 )               => {
      const process = xrName(str(values, 'process', ''), 'CORE');
      const rid = str(values, 'router_id', '');
      const area = str(values, 'area', '0');
      const links = listOf(str(values, 'interfaces', '')).map((i) => xrInterface(i, i));
      const passive = listOf(str(values, 'passive', '')).map((i) => xrInterface(i, i));
      const bfd = bool(values, 'bfd', true);
      const cost = num(values, 'cost', 0);
      const findings = [...routerIdFindings('network.iosxr.router-id', rid)];
      if (links.length === 0 && passive.length === 0) findings.push(error('network.iosxr.ospf-empty', 'No interfaces are given, so the area is empty.', SRC));
      return {
        platform: PLATFORM,
        title: `OSPF ${process} area ${area}`,
        impact: 'brief',
        notes: [
          'IOS-XR puts interfaces under the area, not a `network` statement: an interface not listed here is not in OSPF.',
          'Links are set to point-to-point, which the far end must match or the adjacency will not form.',
          ...(bfd ? ['BFD is enabled per process here; the far end needs BFD too, or the session stays down (the adjacency itself is unaffected).'] : []),
          COMMIT_CONFIRMED,
        ],
        before: [`show running-config router ospf ${process}`, 'show ospf neighbor', 'show route ospf'],
        config: [
          `router ospf ${process}`,
          ...(rid ? [` router-id ${rid}`] : []),
          ' log adjacency changes detail',
          ...(bfd ? [' bfd fast-detect', ' bfd minimum-interval 150', ' bfd multiplier 3'] : []),
          ` area ${area}`,
          ...passive.flatMap((i) => [`  interface ${i}`, '   passive enable', '  !']),
          ...links.flatMap((i) => [`  interface ${i}`, '   network point-to-point', ...(cost > 0 ? [`   cost ${cost}`] : []), '  !']),
          ' !',
          '!',
        ],
        verify: [`show ospf ${process} neighbor`, `show ospf ${process} interface brief`, 'show route ospf', ...(bfd ? ['show bfd session'] : [])],
        backout: [`router ospf ${process}`, ` area ${area}`, ...[...links, ...passive].map((i) => `  no interface ${i}`), '!', `! if this change created the process: no router ospf ${process}`, 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_isis',
    platform: PLATFORM,
    label: 'IS-IS process',
    group: 'Routing',
    description: 'An IS-IS instance: NET from the router id, level-2-only, wide metrics for IPv4 (and IPv6), point-to-point interfaces and a passive loopback.',
    inputs: [
      { id: 'instance', label: 'Instance', control: 'text', default: 'CORE' },
      { id: 'area', label: 'Area', control: 'text', default: '49.0001', hint: 'The NET area part' },
      { id: 'router_id', label: 'Router id (for the system id)', control: 'text', default: '10.255.0.1', hint: '10.255.0.1 becomes 0102.5500.0001' },
      { id: 'level', label: 'IS type', control: 'select', default: 'level-2-only', options: [{ value: 'level-2-only', label: 'Level 2 only' }, { value: 'level-1', label: 'Level 1 only' }, { value: 'level-1-2', label: 'Level 1 and 2' }] },
      { id: 'interfaces', label: 'Links', control: 'text', default: 'GigabitEthernet0/0/0/0, GigabitEthernet0/0/0/1' },
      { id: 'passive', label: 'Passive interfaces', control: 'text', default: 'Loopback0' },
      { id: 'ipv6', label: 'IPv6 too', control: 'toggle', default: false },
      { id: 'metric', label: 'Link metric', control: 'number', default: 10, min: 1, max: 16777214 },
    ],
    change: (values                 )               => {
      const instance = xrName(str(values, 'instance', ''), 'CORE');
      const area = str(values, 'area', '49.0001');
      const rid = str(values, 'router_id', '10.255.0.1');
      const level = str(values, 'level', 'level-2-only');
      const links = listOf(str(values, 'interfaces', '')).map((i) => xrInterface(i, i));
      const passive = listOf(str(values, 'passive', '')).map((i) => xrInterface(i, i));
      const v6 = bool(values, 'ipv6', false);
      const metric = num(values, 'metric', 10);
      const findings            = [];
      let systemId = '0000.0000.0001';
      if (isIpv4(rid)) {
        const digits = rid.split('.').map((o) => o.padStart(3, '0')).join('');
        systemId = `${digits.slice(0, 4)}.${digits.slice(4, 8)}.${digits.slice(8, 12)}`;
      } else findings.push(error('network.iosxr.router-id', `"${rid}" is not a dotted IPv4 router id, so no system id could be made from it.`, SRC));
      if (!/^[0-9a-f]{2}(\.[0-9a-f]{4}){0,6}$/i.test(area)) findings.push(error('network.iosxr.isis-area', `"${area}" is not an IS-IS area such as 49.0001.`, SRC));
      const net = `${area}.${systemId}.00`;
      const afs = ['ipv4', ...(v6 ? ['ipv6'] : [])];
      return {
        platform: PLATFORM,
        title: `IS-IS ${instance} (${net})`,
        impact: 'brief',
        notes: [
          'Wide metrics have to match across the area: a router still on narrow metrics sees wide-metric routes as unreachable.',
          'The system id must be unique in the domain; it is derived from the router id here.',
          COMMIT_CONFIRMED,
        ],
        before: [`show running-config router isis ${instance}`, 'show isis adjacency', 'show route isis'],
        config: [
          `router isis ${instance}`,
          ` is-type ${level}`,
          ` net ${net}`,
          ' log adjacency changes',
          ...afs.flatMap((af) => [` address-family ${af} unicast`, '  metric-style wide', ' !']),
          ...passive.flatMap((i) => [` interface ${i}`, '  passive', ...afs.map((af) => `  address-family ${af} unicast`), ' !']),
          ...links.flatMap((i) => [` interface ${i}`, '  point-to-point', ...afs.flatMap((af) => [`  address-family ${af} unicast`, `   metric ${metric}`, '  !']), ' !']),
          '!',
        ],
        verify: [`show isis ${instance} adjacency`, `show isis ${instance} interface brief`, 'show route isis', `show isis ${instance} database`],
        backout: [`router isis ${instance}`, ...[...links, ...passive].map((i) => ` no interface ${i}`), '!', `! if this change created the instance: no router isis ${instance}`, 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_bgp_neighbor',
    platform: PLATFORM,
    label: 'BGP neighbor',
    group: 'Routing',
    description: 'A BGP neighbor with its address family, route-policy in and out, maximum-prefix, and optional password, update-source and BFD.',
    inputs: [
      { id: 'asn', label: 'Local AS', control: 'text', default: '65000' },
      { id: 'router_id', label: 'BGP router id', control: 'text', default: '10.255.0.1' },
      { id: 'neighbor', label: 'Neighbor address', control: 'text', default: '192.0.2.2' },
      { id: 'remote_as', label: 'Remote AS', control: 'text', default: '65001' },
      { id: 'neighbor_description', label: 'Description', control: 'text', default: 'transit provider A' },
      { id: 'policy_in', label: 'Route-policy in', control: 'text', default: 'PASS', hint: 'IOS-XR eBGP accepts nothing without one' },
      { id: 'policy_out', label: 'Route-policy out', control: 'text', default: 'PASS', hint: 'IOS-XR eBGP advertises nothing without one' },
      { id: 'define_pass', label: 'Define PASS', control: 'toggle', default: true, hint: 'Write `route-policy PASS pass end-policy` if either policy is PASS' },
      { id: 'max_prefix', label: 'Maximum prefixes', control: 'number', default: 1000, min: 0, max: 10000000, hint: '0 for no limit' },
      { id: 'update_source', label: 'Update source', control: 'text', default: '', hint: 'Loopback0 for iBGP between loopbacks' },
      { id: 'password', label: 'MD5 password', control: 'toggle', default: false },
      { id: 'bfd', label: 'BFD fast-detect', control: 'toggle', default: false },
    ],
    change: (values                 )               => {
      const asn = str(values, 'asn', '65000');
      const rid = str(values, 'router_id', '');
      const neighbor = str(values, 'neighbor', '');
      const remote = str(values, 'remote_as', '');
      const policyIn = str(values, 'policy_in', '');
      const policyOut = str(values, 'policy_out', '');
      const maxPrefix = num(values, 'max_prefix', 1000);
      const source = str(values, 'update_source', '');
      const ebgp = remote !== asn;
      const family = neighbor.includes(':') ? 'ipv6' : 'ipv4';
      const findings            = [...routerIdFindings('network.iosxr.router-id', rid), ...asnFinding(asn, 'network.iosxr.bad-asn'), ...asnFinding(remote, 'network.iosxr.bad-asn')];
      if (!parseCidrDual(`${neighbor}/${family === 'ipv6' ? 128 : 32}`)) findings.push(error('network.iosxr.bad-neighbor', `"${neighbor}" is not an IPv4 or IPv6 address.`, SRC));
      if (ebgp && (!policyIn || !policyOut)) {
        findings.push(
          warning('network.iosxr.ebgp-no-policy', `IOS-XR drops every route to and from an eBGP neighbor that has no route-policy ${!policyIn && !policyOut ? 'in either direction' : !policyIn ? 'in' : 'out'}: the session comes up and exchanges nothing.`, {
            remediation: 'Attach a route-policy in and out (the route-policy blueprint writes one).',
            ...SRC,
          }),
        );
      }
      if (ebgp && policyOut.toUpperCase() === 'PASS') {
        findings.push(warning('network.iosxr.ebgp-pass-out', 'The out policy is PASS: every route in the BGP table is advertised to this eBGP neighbor, which is how route leaks start.', { remediation: 'Advertise only your own prefixes with a prefix-set.', ...SRC }));
      }
      if (maxPrefix <= 0) findings.push(warning('network.iosxr.no-max-prefix', 'No maximum-prefix limit: a neighbor that leaks a full table fills this router’s memory.', { remediation: 'Set a limit a little above what the neighbor should send.', ...SRC }));
      const definePass = bool(values, 'define_pass', true) && [policyIn, policyOut].some((p) => p.toUpperCase() === 'PASS');
      return {
        platform: PLATFORM,
        title: `BGP neighbor ${neighbor} (AS ${remote})`,
        impact: 'brief',
        notes: [
          ...(ebgp ? ['IOS-XR eBGP is deny-by-default: without a route-policy in and out, the session establishes and carries no routes.'] : []),
          'A route-policy named here that does not exist fails the commit, so define it first or in the same commit.',
          ROLLBACK_NOTE,
          ...(bool(values, 'password', false) ? ['Both ends need the same password: fill in `<REQUIRED>` from the vault, and expect the session to reset.'] : []),
          COMMIT_CONFIRMED,
        ],
        before: [`show running-config router bgp ${asn}`, `show bgp ${family} unicast summary`, `show bgp neighbor ${neighbor}`],
        config: [
          ...(definePass ? ['route-policy PASS', '  pass', 'end-policy', '!'] : []),
          `router bgp ${asn}`,
          ...(rid ? [` bgp router-id ${rid}`] : []),
          ` address-family ${family} unicast`,
          ' !',
          ` neighbor ${neighbor}`,
          `  remote-as ${remote}`,
          `  description ${description(str(values, 'neighbor_description', ''), `AS ${remote}`)}`,
          ...(source ? [`  update-source ${xrInterface(source, source)}`] : []),
          ...(bool(values, 'password', false) ? [`  password clear ${SECRET}`] : []),
          ...(bool(values, 'bfd', false) ? ['  bfd fast-detect', '  bfd minimum-interval 300', '  bfd multiplier 3'] : []),
          `  address-family ${family} unicast`,
          ...(policyIn ? [`   route-policy ${policyIn} in`] : []),
          ...(policyOut ? [`   route-policy ${policyOut} out`] : []),
          ...(maxPrefix > 0 ? [`   maximum-prefix ${maxPrefix} 90`] : []),
          ...(!ebgp && source ? ['   next-hop-self'] : []),
          '  !',
          ' !',
          '!',
        ],
        verify: [`show bgp ${family} unicast summary`, `show bgp neighbor ${neighbor}`, `show bgp ${family} unicast neighbors ${neighbor} routes`, `show bgp ${family} unicast neighbors ${neighbor} advertised-routes`],
        backout: [`router bgp ${asn}`, ` no neighbor ${neighbor}`, '!', 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_route_policy',
    platform: PLATFORM,
    label: 'Route-policy and prefix-set',
    group: 'Routing',
    description: 'A prefix-set and a route-policy that passes what is in it (optionally setting local-preference or community) and drops the rest.',
    inputs: [
      { id: 'policy', label: 'Route-policy name', control: 'text', default: 'CUSTOMER-A-IN' },
      { id: 'prefix_set', label: 'Prefix-set name', control: 'text', default: 'CUSTOMER-A-PREFIXES' },
      { id: 'prefixes', label: 'Prefixes', control: 'textarea', default: '198.51.100.0/24\n203.0.113.0/24 le 28', hint: 'One per line; `le`/`ge` allowed' },
      { id: 'local_pref', label: 'Local preference', control: 'number', default: 0, min: 0, max: 4294967295, hint: '0 to leave it alone' },
      { id: 'community', label: 'Set community', control: 'text', default: '', hint: 'e.g. 65000:100; empty for none' },
    ],
    change: (values                 )               => {
      const policy = xrName(str(values, 'policy', ''), 'POLICY');
      const set = xrName(str(values, 'prefix_set', ''), 'PREFIXES');
      const prefixes = String(values['prefixes'] ?? '')
        .split(/\r?\n|,/)
        .map((p) => p.trim())
        .filter(Boolean);
      const localPref = num(values, 'local_pref', 0);
      const community = str(values, 'community', '');
      const findings            = [];
      for (const p of prefixes) {
        const base = p.split(/\s+/)[0] ?? '';
        if (!parseCidrDual(base)) findings.push(error('network.iosxr.bad-prefix', `"${p}" does not start with a prefix.`, SRC));
      }
      if (prefixes.length === 0) findings.push(warning('network.iosxr.empty-prefix-set', 'The prefix-set is empty, so the policy drops everything.', SRC));
      return {
        platform: PLATFORM,
        title: `Route-policy ${policy} (prefix-set ${set})`,
        impact: 'none',
        notes: [
          'Nothing uses the policy until a neighbor, redistribution or VRF names it. Changing a policy already attached takes effect at commit, with a soft re-evaluation.',
          'RPL is checked at commit: a typo fails the whole commit rather than half-applying.',
        ],
        before: [`show running-config route-policy ${policy}`, `show running-config prefix-set ${set}`, `show rpl route-policy ${policy} attachment-points`],
        config: [
          `prefix-set ${set}`,
          ...prefixes.map((p, i) => `  ${p}${i < prefixes.length - 1 ? ',' : ''}`),
          'end-set',
          '!',
          `route-policy ${policy}`,
          `  if destination in ${set} then`,
          ...(localPref > 0 ? [`    set local-preference ${localPref}`] : []),
          ...(community ? [`    set community (${community}) additive`] : []),
          '    pass',
          '  else',
          '    drop',
          '  endif',
          'end-policy',
          '!',
        ],
        verify: [`show rpl route-policy ${policy}`, `show rpl prefix-set ${set}`, `show rpl route-policy ${policy} attachment-points`],
        backout: [`no route-policy ${policy}`, `no prefix-set ${set}`, '! refused while a neighbor still uses it: detach it first', 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_vrf',
    platform: PLATFORM,
    label: 'L3VPN VRF',
    group: 'Routing',
    description: 'A VRF with import and export route-targets, and its RD and address family under BGP so it is carried as an L3VPN.',
    inputs: [
      { id: 'vrf', label: 'VRF name', control: 'text', default: 'CUST-A' },
      { id: 'asn', label: 'BGP AS', control: 'text', default: '65000' },
      { id: 'rd', label: 'Route distinguisher', control: 'text', default: '65000:100', hint: 'auto is also accepted' },
      { id: 'import_rt', label: 'Import route-targets', control: 'text', default: '65000:100' },
      { id: 'export_rt', label: 'Export route-targets', control: 'text', default: '65000:100' },
      { id: 'redistribute_connected', label: 'Redistribute connected', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const vrf = xrName(str(values, 'vrf', ''), 'VRF');
      const asn = str(values, 'asn', '65000');
      const rd = str(values, 'rd', 'auto');
      const imports = listOf(str(values, 'import_rt', ''));
      const exports = listOf(str(values, 'export_rt', ''));
      const findings            = [...asnFinding(asn, 'network.iosxr.bad-asn')];
      for (const rt of [...imports, ...exports]) if (!/^[\d.]+:\d+$/.test(rt)) findings.push(error('network.iosxr.bad-rt', `"${rt}" is not a route-target (ASN:nn or IP:nn).`, SRC));
      if (imports.length === 0) findings.push(warning('network.iosxr.no-import', 'No import route-target: the VRF learns no routes from other PEs.', SRC));
      return {
        platform: PLATFORM,
        title: `VRF ${vrf} (RD ${rd})`,
        impact: 'none',
        notes: ['BGP needs the vpnv4 unicast address family towards the route reflectors for the VRF to be carried. Put interfaces in it with the sub-interface blueprint.'],
        before: [`show running-config vrf ${vrf}`, `show vrf ${vrf} detail`, `show running-config router bgp ${asn} vrf ${vrf}`],
        config: [
          `vrf ${vrf}`,
          ' address-family ipv4 unicast',
          '  import route-target',
          ...imports.map((rt) => `   ${rt}`),
          '  !',
          '  export route-target',
          ...exports.map((rt) => `   ${rt}`),
          '  !',
          ' !',
          '!',
          `router bgp ${asn}`,
          ` vrf ${vrf}`,
          `  rd ${rd}`,
          '  address-family ipv4 unicast',
          ...(bool(values, 'redistribute_connected', true) ? ['   redistribute connected'] : []),
          '  !',
          ' !',
          '!',
        ],
        verify: [`show vrf ${vrf} detail`, `show bgp vrf ${vrf} ipv4 unicast summary`, `show route vrf ${vrf}`],
        backout: [`router bgp ${asn}`, ` no vrf ${vrf}`, '!', `no vrf ${vrf}`, '! interfaces still in the VRF have to be moved or removed first', 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_bfd',
    platform: PLATFORM,
    label: 'BFD on a routing protocol',
    group: 'Routing',
    description: 'BFD fast-detect for an OSPF or IS-IS interface, a BGP neighbor or a static route, with its interval and multiplier.',
    inputs: [
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'isis', options: [{ value: 'isis', label: 'IS-IS interface' }, { value: 'ospf', label: 'OSPF interface' }, { value: 'bgp', label: 'BGP neighbor' }, { value: 'static', label: 'Static route' }] },
      { id: 'process', label: 'Process / AS', control: 'text', default: 'CORE', hint: 'IS-IS instance, OSPF process, or the BGP AS' },
      { id: 'area', label: 'OSPF area', control: 'text', default: '0', showWhen: { input: 'protocol', equals: ['ospf'] } },
      { id: 'interface', label: 'Interface', control: 'text', default: 'GigabitEthernet0/0/0/0', showWhen: { input: 'protocol', equals: ['isis', 'ospf', 'static'] } },
      { id: 'neighbor', label: 'BGP neighbor / static next hop', control: 'text', default: '10.0.12.2', showWhen: { input: 'protocol', equals: ['bgp', 'static'] } },
      { id: 'prefix', label: 'Static prefix', control: 'text', default: '10.50.0.0/16', showWhen: { input: 'protocol', equals: ['static'] } },
      { id: 'interval', label: 'Minimum interval (ms)', control: 'number', default: 150, min: 3, max: 30000 },
      { id: 'multiplier', label: 'Multiplier', control: 'number', default: 3, min: 2, max: 50 },
    ],
    change: (values                 )               => {
      const protocol = str(values, 'protocol', 'isis');
      const process = str(values, 'process', 'CORE');
      const intf = xrInterface(str(values, 'interface', ''), 'GigabitEthernet0/0/0/0');
      const neighbor = str(values, 'neighbor', '');
      const interval = num(values, 'interval', 150);
      const mult = num(values, 'multiplier', 3);
      const findings            = [];
      if (interval < 50) findings.push(warning('network.iosxr.bfd-aggressive', `${interval} ms is aggressive: below 50 ms needs hardware-offloaded BFD on both ends, or sessions flap under load.`, SRC));
      let config           = [];
      let backout           = [];
      let verify           = ['show bfd session', 'show bfd session detail'];
      if (protocol === 'ospf') {
        const area = str(values, 'area', '0');
        config = [`router ospf ${process}`, ` area ${area}`, `  interface ${intf}`, '   bfd fast-detect', `   bfd minimum-interval ${interval}`, `   bfd multiplier ${mult}`, '  !', ' !', '!'];
        backout = [`router ospf ${process}`, ` area ${area}`, `  interface ${intf}`, '   no bfd fast-detect', '   no bfd minimum-interval', '   no bfd multiplier', '!', 'commit'];
        verify = [...verify, `show ospf ${process} interface ${intf}`];
      } else if (protocol === 'bgp') {
        config = [`router bgp ${process}`, ` neighbor ${neighbor}`, '  bfd fast-detect', `  bfd minimum-interval ${interval}`, `  bfd multiplier ${mult}`, ' !', '!'];
        backout = [`router bgp ${process}`, ` neighbor ${neighbor}`, '  no bfd fast-detect', '  no bfd minimum-interval', '  no bfd multiplier', '!', 'commit'];
        verify = [...verify, `show bgp neighbor ${neighbor} | include BFD`];
      } else if (protocol === 'static') {
        const prefix = parseCidrDual(str(values, 'prefix', ''));
        if (!prefix) findings.push(error('network.iosxr.bad-prefix', 'The static prefix is not a valid prefix.', SRC));
        const family = prefix?.family === 6 ? 'ipv6' : 'ipv4';
        const dest = prefix ? `${prefix.network}/${prefix.prefix}` : str(values, 'prefix', '');
        config = ['router static', ` address-family ${family} unicast`, `  ${dest} ${intf} ${neighbor} bfd fast-detect minimum-interval ${interval} multiplier ${mult}`, ' !', '!'];
        backout = ['router static', ` address-family ${family} unicast`, `  no ${dest} ${intf} ${neighbor}`, `  ${dest} ${intf} ${neighbor}`, '!', 'commit'];
        verify = [...verify, `show route ${family} unicast ${dest}`];
      } else {
        config = [`router isis ${process}`, ` interface ${intf}`, '  bfd fast-detect ipv4', `  bfd minimum-interval ${interval}`, `  bfd multiplier ${mult}`, ' !', '!'];
        backout = [`router isis ${process}`, ` interface ${intf}`, '  no bfd fast-detect ipv4', '  no bfd minimum-interval', '  no bfd multiplier', '!', 'commit'];
        verify = [...verify, `show isis ${process} interface ${intf}`];
      }
      return {
        platform: PLATFORM,
        title: `BFD for ${protocol === 'bgp' ? `BGP neighbor ${neighbor}` : protocol === 'static' ? 'a static route' : `${protocol.toUpperCase()} on ${intf}`}`,
        impact: 'brief',
        notes: [
          'The far end needs BFD with compatible timers; until it has it, the session is down and the protocol ignores it.',
          'On a Bundle-Ether, BFD over bundle members also needs `bfd multipath include location <node>` on ASR 9000 line cards: check the platform guide.',
          COMMIT_CONFIRMED,
        ],
        before: ['show bfd session', `show running-config router ${protocol === 'static' ? 'static' : `${protocol} ${process}`}`],
        config,
        verify,
        backout,
        findings,
      };
    },
  }),
];

const ALL                             = [...INTERFACES, ...ROUTING, ...IOSXR_SERVICES];

export const IOSXR_NETWORK                 = {
  target: PLATFORM,
  label: 'Cisco IOS-XR',
  blueprints: ALL,
};

export const IOSXR_CHANGES                             = ALL;

