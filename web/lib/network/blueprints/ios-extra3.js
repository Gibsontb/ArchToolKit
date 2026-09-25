/**
 * Cisco IOS and IOS-XE: the service-provider and campus-edge gaps.
 *
 * The first three files cover a campus switch and a branch router. What they
 * never wrote is the core: IS-IS, LDP, a BGP route reflector and EVPN-VXLAN on
 * a Catalyst 9000. And on the access side, two things every campus change list
 * eventually needs: private VLANs and PoE budgets.
 *
 * Same contract as the rest: capture first, verify after, a back-out that is
 * the exact commands, and never a credential. Keys are `<REQUIRED>`.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { isIpv4, listOf, vlanIds, vlanRange,                   } from '../device.js';

const PLATFORM = 'cisco_ios'         ;
const SECRET = '<REQUIRED>';
const SOURCE = { source: 'ArchToolKit' }         ;

/** An IS-IS NET: area, a six-byte system id and the 00 selector. */
const isNet = (net        )          => /^[0-9a-f]{2}(\.[0-9a-f]{4}){4,9}\.00$/i.test(net);

/** A BGP cluster id: a dotted quad or a 32-bit number. */
const isClusterId = (value        )          => isIpv4(value) || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 4294967295);

export const IOS_EXTRA_3                             = [
  /* ------------------------------------------------------------------ IS-IS */
  deviceBlueprint({
    id: 'ios_isis',
    platform: PLATFORM,
    label: 'IS-IS',
    group: 'Routing',
    description: 'An IS-IS process with wide metrics, point-to-point core links, a passive loopback, MD5 authentication and an overload bit on startup.',
    inputs: [
      { id: 'tag', label: 'Process tag', control: 'text', default: 'CORE' },
      { id: 'net', label: 'NET', control: 'text', default: '49.0001.0100.0000.0001.00', hint: 'Area, system id, selector 00. The system id is often the loopback written out: 10.0.0.1 is 0100.0000.0001' },
      { id: 'level', label: 'Level', control: 'select', default: 'level-2-only', options: [
        { value: 'level-2-only', label: 'Level 2 only (a flat core)' },
        { value: 'level-1', label: 'Level 1 only' },
        { value: 'level-1-2', label: 'Level 1 and 2' },
      ] },
      { id: 'metric_style', label: 'Metric style', control: 'select', default: 'wide', options: [
        { value: 'wide', label: 'Wide' },
        { value: 'transition', label: 'Transition (during a migration)' },
        { value: 'narrow', label: 'Narrow (the IOS default)' },
      ] },
      { id: 'interfaces', label: 'Core interfaces', control: 'text', default: 'TenGigabitEthernet1/1/1, TenGigabitEthernet1/1/2' },
      { id: 'passive', label: 'Passive interfaces', control: 'text', default: 'Loopback0', hint: 'Advertised, but no adjacency formed' },
      { id: 'point_to_point', label: 'Point-to-point links', control: 'toggle', default: true, hint: 'No DIS election on a two-router Ethernet link' },
      { id: 'auth', label: 'MD5 authentication', control: 'toggle', default: true },
      { id: 'bfd', label: 'BFD on all IS-IS interfaces', control: 'toggle', default: false },
    ],
    change: (values                 )               => {
      const tag = str(values, 'tag', 'CORE');
      const net = str(values, 'net', '');
      const level = str(values, 'level', 'level-2-only');
      const style = str(values, 'metric_style', 'wide');
      const ifaces = listOf(str(values, 'interfaces', ''));
      const passive = listOf(str(values, 'passive', ''));
      const p2p = bool(values, 'point_to_point', true);
      const auth = bool(values, 'auth', true);
      const bfd = bool(values, 'bfd', false);
      const authLevels = level === 'level-1' ? [' level-1'] : level === 'level-2-only' ? [' level-2'] : [''];
      const findings            = [];
      if (!isNet(net)) findings.push(error('network.ios.isis-bad-net', `"${net}" is not a NET. It is an area, a six-byte system id and the selector 00, for example 49.0001.0100.0000.0001.00.`, SOURCE));
      if (ifaces.length === 0) findings.push(error('network.ios.isis-no-interfaces', 'No interface was named, so the process forms no adjacency.', SOURCE));
      if (style === 'narrow') {
        findings.push(warning('network.ios.isis-narrow', 'Narrow metrics cap an interface at 63 and cannot carry traffic-engineering or segment-routing information. Every other vendor in the domain will be sending wide metrics, and a router that speaks only narrow ignores them.', { remediation: 'Use metric-style wide, or transition for the duration of a migration only.', ...SOURCE }));
      }
      if (style === 'transition') findings.push(info('network.ios.isis-transition', 'Transition sends both narrow and wide TLVs. Move to wide once every router in the area understands it.', SOURCE));
      if (level === 'level-1-2') findings.push(warning('network.ios.isis-l1l2', 'Level 1-2 keeps two link-state databases and forms two adjacencies on every link. Unless this router is genuinely a boundary between areas, pick one level.', SOURCE));
      if (!auth) findings.push(warning('network.ios.isis-no-auth', 'Without authentication, anything that can send a hello on a core link can join the routing domain.', SOURCE));

      return {
        platform: PLATFORM,
        title: `IS-IS ${tag} (${level}, ${style} metrics)`,
        impact: 'brief',
        notes: [
          'Every router in the domain must agree on the metric style. A wide-only router and a narrow-only router form an adjacency and then ignore each other\'s routes.',
          'The overload bit is set for five minutes after a reload, so the router is not used for transit until BGP has converged behind it.',
          ...(auth ? [`Replace ${SECRET} with the IS-IS key from your vault. Both ends of every link must use the same key and mode, or the adjacency drops.`] : []),
          ...(bfd ? ['BFD needs an interval on each interface (bfd interval 150 min_rx 150 multiplier 3) before it runs. The BFD change sets it.'] : []),
          ...(p2p ? ['Changing an interface to point-to-point resets its adjacency. Do the far end in the same window.'] : []),
        ],
        before: ['show isis neighbors', 'show clns neighbors', 'show isis database', 'show ip route isis', `show running-config | section router isis`],
        config: [
          ...(auth ? ['key chain ISIS-KEY', ' key 1', `  key-string ${SECRET}`, '!'] : []),
          `router isis ${tag}`,
          ` net ${net}`,
          ` is-type ${level}`,
          ` metric-style ${style}`,
          ' log-adjacency-changes',
          ' set-overload-bit on-startup 300',
          ...passive.map((p) => ` passive-interface ${p}`),
          ...(auth ? authLevels.flatMap((l) => [` authentication mode md5${l}`, ` authentication key-chain ISIS-KEY${l}`]) : []),
          ...(bfd ? [' bfd all-interfaces'] : []),
          '!',
          ...ifaces.flatMap((iface) => [`interface ${iface}`, ` ip router isis ${tag}`, ...(p2p ? [' isis network point-to-point'] : []), '!']),
        ],
        verify: ['show isis neighbors', 'show isis database detail', 'show ip route isis', 'show isis topology', 'show clns interface', ...(bfd ? ['show bfd neighbors'] : [])],
        backout: [
          ...ifaces.flatMap((iface) => [`interface ${iface}`, ` no ip router isis ${tag}`, ...(p2p ? [' no isis network point-to-point'] : []), '!']),
          `no router isis ${tag}`,
          ...(auth ? ['no key chain ISIS-KEY'] : []),
        ],
        findings,
      };
    },
  }),

  /* --------------------------------------------------------------- MPLS LDP */
  deviceBlueprint({
    id: 'ios_mpls_ldp',
    platform: PLATFORM,
    label: 'MPLS LDP',
    group: 'Routing',
    description: 'Label distribution on core links: LDP with a loopback router id, session protection and LDP-IGP synchronisation.',
    inputs: [
      { id: 'interfaces', label: 'Core interfaces', control: 'text', default: 'TenGigabitEthernet1/1/1, TenGigabitEthernet1/1/2' },
      { id: 'router_id', label: 'LDP router id interface', control: 'text', default: 'Loopback0', hint: 'A loopback advertised by the IGP as a /32' },
      { id: 'igp', label: 'LDP-IGP synchronisation', control: 'select', default: 'ospf', options: [
        { value: 'ospf', label: 'OSPF' },
        { value: 'isis', label: 'IS-IS' },
        { value: 'none', label: 'None' },
      ] },
      { id: 'igp_process', label: 'IGP process id or tag', control: 'text', default: '1', showWhen: { input: 'igp', equals: ['ospf', 'isis'] } },
      { id: 'session_protection', label: 'Session protection', control: 'toggle', default: true, hint: 'Keeps the LDP session up over a backup path when a link fails' },
      { id: 'neighbor_auth', label: 'MD5 on the LDP sessions', control: 'toggle', default: false },
      { id: 'neighbors', label: 'LDP neighbour router ids', control: 'text', default: '10.255.0.2', hint: 'Their LDP router ids', showWhen: { input: 'neighbor_auth', equals: ['true'] } },
    ],
    change: (values                 )               => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const rid = str(values, 'router_id', 'Loopback0');
      const igp = str(values, 'igp', 'ospf');
      const proc = str(values, 'igp_process', '1');
      const protection = bool(values, 'session_protection', true);
      const auth = bool(values, 'neighbor_auth', false);
      const neighbors = auth ? listOf(str(values, 'neighbors', '')) : [];
      const findings            = [];
      if (ifaces.length === 0) findings.push(error('network.ios.ldp-no-interfaces', 'No interface was named, so LDP discovers nobody.', SOURCE));
      if (!/^loopback/i.test(rid)) findings.push(warning('network.ios.ldp-router-id', `The LDP router id is taken from ${rid}. If that is a physical interface, a link failure changes the router id and every session resets.`, { remediation: 'Use a loopback that the IGP advertises as a /32.', ...SOURCE }));
      if (igp === 'none') findings.push(warning('network.ios.ldp-no-sync', 'Without LDP-IGP synchronisation, the IGP starts using a link before LDP has labels on it, and labelled traffic is black-holed until LDP catches up.', SOURCE));
      if (auth && neighbors.length === 0) findings.push(error('network.ios.ldp-no-neighbors', 'MD5 was asked for but no LDP neighbour was named.', SOURCE));
      for (const n of neighbors) if (!isIpv4(n)) findings.push(error('network.ios.ldp-bad-neighbor', `"${n}" is not an IPv4 LDP router id.`, SOURCE));
      const igpOpen = igp === 'ospf' ? `router ospf ${proc}` : `router isis ${proc}`;

      return {
        platform: PLATFORM,
        title: `MPLS LDP on ${ifaces.length} interface${ifaces.length === 1 ? '' : 's'}`,
        impact: 'brief',
        notes: [
          `The router id comes from ${rid}; the far end must have a route to it as a /32, or the TCP session never establishes.`,
          'Labels add four bytes per label. Core links need an MTU that carries a full 1500-byte packet plus the label stack (mpls mtu, or a larger interface MTU), or large packets are dropped.',
          ...(auth ? [`Replace ${SECRET} with the LDP password. The neighbour must use the same one, and changing it resets the session.`] : []),
          'Enable LDP on both ends of a link in the same window. With synchronisation on, the IGP advertises the link at maximum metric until LDP is up.',
        ],
        before: ['show mpls interfaces', 'show mpls ldp neighbor', 'show mpls ldp discovery', `show running-config | section ${igp === 'isis' ? 'router isis' : 'router ospf'}`],
        config: [
          'mpls label protocol ldp',
          `mpls ldp router-id ${rid} force`,
          ...(protection ? ['mpls ldp session protection'] : []),
          ...neighbors.map((n) => `mpls ldp neighbor ${n} password ${SECRET}`),
          '!',
          ...ifaces.flatMap((iface) => [`interface ${iface}`, ' mpls ip', '!']),
          ...(igp !== 'none' ? [igpOpen, ' mpls ldp sync', '!'] : []),
        ],
        verify: ['show mpls ldp neighbor', 'show mpls ldp discovery detail', 'show mpls interfaces', 'show mpls forwarding-table', ...(igp !== 'none' ? ['show mpls ldp igp sync'] : []), ...(protection ? ['show mpls ldp neighbor detail | include Protection'] : [])],
        backout: [
          ...ifaces.flatMap((iface) => [`interface ${iface}`, ' no mpls ip', '!']),
          ...(igp !== 'none' ? [igpOpen, ' no mpls ldp sync', '!'] : []),
          ...neighbors.map((n) => `no mpls ldp neighbor ${n} password`),
          ...(protection ? ['no mpls ldp session protection'] : []),
          `no mpls ldp router-id ${rid}`,
        ],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------- Route reflector */
  deviceBlueprint({
    id: 'ios_bgp_route_reflector',
    platform: PLATFORM,
    label: 'BGP route reflector',
    group: 'Routing',
    description: 'Make this router a route reflector: a cluster id, a peer group of iBGP clients from their loopbacks, and the address family they are reflected in.',
    inputs: [
      { id: 'asn', label: 'AS number', control: 'number', default: 65000, min: 1, max: 4294967295 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.1' },
      { id: 'cluster_id', label: 'Cluster id', control: 'text', default: '10.255.0.1', hint: 'The same on both reflectors of a redundant pair; blank uses the router id' },
      { id: 'clients', label: 'Client loopbacks', control: 'textarea', default: '10.255.0.11\n10.255.0.12', hint: 'One per line' },
      { id: 'update_source', label: 'Update source', control: 'text', default: 'Loopback0' },
      { id: 'family', label: 'Address family', control: 'select', default: 'ipv4', options: [
        { value: 'ipv4', label: 'IPv4 unicast' },
        { value: 'vpnv4', label: 'VPNv4 (MPLS L3VPN)' },
        { value: 'l2vpn evpn', label: 'L2VPN EVPN' },
      ] },
      { id: 'auth', label: 'MD5 on the sessions', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const asn = num(values, 'asn', 65000);
      const rid = str(values, 'router_id', '');
      const cluster = str(values, 'cluster_id', '');
      const clients = listOf(str(values, 'clients', ''));
      const family = str(values, 'family', 'ipv4');
      const auth = bool(values, 'auth', true);
      const src = str(values, 'update_source', 'Loopback0');
      const findings            = [];
      if (!isIpv4(rid)) findings.push(error('network.ios.bad-router-id', `"${rid}" is not a dotted router id.`, SOURCE));
      if (!cluster) {
        findings.push(warning('network.ios.rr-no-cluster-id', 'No cluster id: the router id is used instead. Two reflectors serving the same clients then have different cluster ids, each accepts the other\'s reflected routes, and the clients hold twice the paths.', { remediation: 'Give both reflectors of a pair the same cluster id.', ...SOURCE }));
      } else if (!isClusterId(cluster)) {
        findings.push(error('network.ios.rr-bad-cluster-id', `"${cluster}" is not a cluster id. Use a dotted quad or a number.`, SOURCE));
      }
      if (clients.length === 0) findings.push(error('network.ios.rr-no-clients', 'A route reflector with no clients reflects nothing.', SOURCE));
      for (const c of clients) {
        if (!isIpv4(c)) findings.push(error('network.ios.rr-bad-client', `"${c}" is not an IPv4 loopback address.`, SOURCE));
        if (c === rid) findings.push(error('network.ios.rr-self-client', `${c} is this router's own router id.`, SOURCE));
      }
      if (clients.length === 1) findings.push(info('network.ios.rr-one-client', 'One client does not need a reflector. This is fine as the first of several.', SOURCE));
      const af = family === 'ipv4' ? 'ipv4' : family;

      return {
        platform: PLATFORM,
        title: `BGP route reflector for ${clients.length} client${clients.length === 1 ? '' : 's'} (AS ${asn}, ${af})`,
        impact: 'brief',
        notes: [
          'Clients peer only with the reflectors; the full mesh between them can be removed once every client sees routes through both reflectors, and not before.',
          'Setting or changing the cluster id on a running process can reset the iBGP sessions. Do it in a window.',
          'no bgp default ipv4-unicast only affects neighbours added after it; IOS writes an explicit activate for the existing ones, so they are not dropped.',
          ...(family !== 'ipv4' ? ['Extended communities carry the route targets. Without send-community extended nothing in this address family is usable at the client.'] : []),
          ...(auth ? [`Replace ${SECRET} with the session password. Each client must use the same one, and setting it resets the session.`] : []),
          'The reflector is usually out of the forwarding path. If it is in it, keep next-hop-self off for reflected routes.',
        ],
        before: ['show running-config | section router bgp', 'show ip bgp summary', ...(family === 'vpnv4' ? ['show bgp vpnv4 unicast all summary'] : family === 'l2vpn evpn' ? ['show bgp l2vpn evpn summary'] : [])],
        config: [
          `router bgp ${asn}`,
          ` bgp router-id ${rid}`,
          ...(cluster ? [` bgp cluster-id ${cluster}`] : []),
          ' bgp log-neighbor-changes',
          ' no bgp default ipv4-unicast',
          ' neighbor RR-CLIENTS peer-group',
          ` neighbor RR-CLIENTS remote-as ${asn}`,
          ` neighbor RR-CLIENTS update-source ${src}`,
          ...(auth ? [` neighbor RR-CLIENTS password ${SECRET}`] : []),
          ...clients.map((c) => ` neighbor ${c} peer-group RR-CLIENTS`),
          ' !',
          ` address-family ${af}`,
          '  neighbor RR-CLIENTS send-community both',
          '  neighbor RR-CLIENTS route-reflector-client',
          ...clients.map((c) => `  neighbor ${c} activate`),
          ' exit-address-family',
          '!',
        ],
        verify: [
          'show ip bgp summary',
          ...(family === 'vpnv4' ? ['show bgp vpnv4 unicast all summary'] : family === 'l2vpn evpn' ? ['show bgp l2vpn evpn summary'] : []),
          ...clients.slice(0, 2).map((c) => `show ip bgp neighbors ${c} | include Route-Reflector|BGP state`),
          'show ip bgp cluster-ids',
        ],
        backout: [
          `router bgp ${asn}`,
          ...clients.map((c) => ` no neighbor ${c}`),
          ' no neighbor RR-CLIENTS peer-group',
          ...(cluster ? [` no bgp cluster-id ${cluster}`] : []),
          '!',
        ],
        findings,
      };
    },
  }),

  /* ----------------------------------------------------------- Private VLANs */
  deviceBlueprint({
    id: 'ios_private_vlan',
    platform: PLATFORM,
    label: 'Private VLANs',
    group: 'Switching',
    description: 'A primary VLAN with an isolated and community secondaries, host ports, a promiscuous uplink and the SVI mapping that routes for them.',
    inputs: [
      { id: 'primary', label: 'Primary VLAN', control: 'number', default: 100, min: 2, max: 4094 },
      { id: 'isolated', label: 'Isolated VLAN', control: 'number', default: 101, min: 0, max: 4094, hint: '0 for none. At most one per primary' },
      { id: 'community', label: 'Community VLANs', control: 'text', default: '', hint: 'Blank for none, or a list: 102, 103' },
      { id: 'host_vlan', label: 'Secondary VLAN for the host ports', control: 'number', default: 101, min: 2, max: 4094 },
      { id: 'host_ports', label: 'Host ports', control: 'text', default: 'GigabitEthernet1/0/10, GigabitEthernet1/0/11' },
      { id: 'promiscuous_ports', label: 'Promiscuous ports', control: 'text', default: 'GigabitEthernet1/0/48', hint: 'The router or firewall port; blank for none' },
      { id: 'svi', label: 'Map the primary SVI', control: 'toggle', default: true, hint: 'So the switch routes for every secondary' },
      { id: 'vtp_transparent', label: 'Set VTP transparent', control: 'toggle', default: true, hint: 'Private VLANs need VTP transparent, or VTP version 3' },
    ],
    change: (values                 )               => {
      const primary = num(values, 'primary', 100);
      const isolated = num(values, 'isolated', 101);
      const community = vlanIds(str(values, 'community', ''));
      const secondaries = [...(isolated > 0 ? [isolated] : []), ...community];
      const hostVlan = num(values, 'host_vlan', 101);
      const hosts = listOf(str(values, 'host_ports', ''));
      const promiscuous = listOf(str(values, 'promiscuous_ports', ''));
      const svi = bool(values, 'svi', true);
      const vtp = bool(values, 'vtp_transparent', true);
      const all = [primary, ...secondaries];
      const findings            = [];
      if (secondaries.length === 0) findings.push(error('network.ios.pvlan-no-secondary', 'A primary VLAN with no isolated or community VLAN is just a VLAN.', SOURCE));
      if (new Set(all).size !== all.length) findings.push(error('network.ios.pvlan-duplicate', 'The primary and the secondary VLANs must all be different.', SOURCE));
      if (hosts.length > 0 && !secondaries.includes(hostVlan)) findings.push(error('network.ios.pvlan-host-vlan', `VLAN ${hostVlan} is not one of this primary's secondaries, so the host ports would be associated with nothing.`, SOURCE));
      if (promiscuous.length === 0 && !svi) findings.push(warning('network.ios.pvlan-no-exit', 'With no promiscuous port and no SVI mapping, hosts in the secondary VLANs can reach nothing but (in a community) each other.', SOURCE));
      if (!vtp) findings.push(info('network.ios.pvlan-vtp', 'Private VLANs are refused in VTP server or client mode unless the domain runs VTP version 3. Confirm with show vtp status.', SOURCE));
      const map = vlanRange(secondaries);

      return {
        platform: PLATFORM,
        title: `Private VLAN ${primary} with ${map || 'no'} secondaries`,
        impact: 'brief',
        notes: [
          'Hosts in the isolated VLAN reach only the promiscuous ports; hosts in a community reach each other and the promiscuous ports.',
          'A port in private-VLAN host mode loses its access VLAN, so the device behind it moves VLAN and renews its address.',
          ...(vtp ? ['VTP transparent stops this switch from taking or sending VLAN updates. If it was a VTP server, the rest of the domain no longer learns new VLANs from it.'] : []),
          'Private VLANs are local to a switch unless the secondary VLANs are also defined and associated on every switch the trunk reaches.',
        ],
        before: ['show vtp status', 'show vlan private-vlan', ...hosts.slice(0, 2).map((p) => `show running-config interface ${p}`), ...promiscuous.map((p) => `show running-config interface ${p}`)],
        config: [
          ...(vtp ? ['vtp mode transparent', '!'] : []),
          ...(isolated > 0 ? [`vlan ${isolated}`, ' private-vlan isolated', '!'] : []),
          ...community.flatMap((v) => [`vlan ${v}`, ' private-vlan community', '!']),
          `vlan ${primary}`,
          ' private-vlan primary',
          ` private-vlan association ${map}`,
          '!',
          ...hosts.flatMap((p) => [`interface ${p}`, ' switchport mode private-vlan host', ` switchport private-vlan host-association ${primary} ${hostVlan}`, ' spanning-tree portfast', '!']),
          ...promiscuous.flatMap((p) => [`interface ${p}`, ' switchport mode private-vlan promiscuous', ` switchport private-vlan mapping ${primary} ${map}`, '!']),
          ...(svi ? [`interface Vlan${primary}`, ` private-vlan mapping ${map}`, '!'] : []),
        ],
        verify: ['show vlan private-vlan', 'show interfaces private-vlan mapping', ...hosts.slice(0, 2).map((p) => `show interfaces ${p} switchport | include private`), 'show mac address-table vlan ' + primary],
        backout: [
          ...(svi ? [`interface Vlan${primary}`, ' no private-vlan mapping', '!'] : []),
          ...promiscuous.flatMap((p) => [`interface ${p}`, ' no switchport private-vlan mapping', ' switchport mode access', '!']),
          ...hosts.flatMap((p) => [`interface ${p}`, ' no switchport private-vlan host-association', ' switchport mode access', '!']),
          `vlan ${primary}`,
          ' no private-vlan association',
          ' no private-vlan primary',
          '!',
          ...secondaries.map((v) => `no vlan ${v}`),
        ],
        findings,
      };
    },
  }),

  /* -------------------------------------------------------------------- PoE */
  deviceBlueprint({
    id: 'ios_poe',
    platform: PLATFORM,
    label: 'Power over Ethernet (power inline)',
    group: 'Switching',
    description: 'PoE on a set of ports: automatic, static (reserved) or off, a per-port ceiling, priority for the ports that must stay powered, and policing.',
    inputs: [
      { id: 'interfaces', label: 'Ports', control: 'text', default: 'GigabitEthernet1/0/1, GigabitEthernet1/0/2' },
      { id: 'mode', label: 'Mode', control: 'select', default: 'auto', options: [
        { value: 'auto', label: 'Auto: power what asks for it' },
        { value: 'static', label: 'Static: reserve the power up front' },
        { value: 'never', label: 'Never: no power on these ports' },
      ] },
      { id: 'max_mw', label: 'Maximum (milliwatts)', control: 'number', default: 30000, min: 4000, max: 90000, hint: '15400 PoE, 30000 PoE+, 60000 UPOE, 90000 UPOE+', showWhen: { input: 'mode', equals: ['auto', 'static'] } },
      { id: 'priority', label: 'Port priority', control: 'select', default: 'default', options: [
        { value: 'default', label: 'Leave as is' },
        { value: 'high', label: 'High: shed last' },
        { value: 'low', label: 'Low: shed first' },
      ], showWhen: { input: 'mode', equals: ['auto', 'static'] } },
      { id: 'police', label: 'Police the draw (log only)', control: 'toggle', default: true, showWhen: { input: 'mode', equals: ['auto', 'static'] } },
    ],
    change: (values                 )               => {
      const ports = listOf(str(values, 'interfaces', ''));
      const mode = str(values, 'mode', 'auto');
      const max = num(values, 'max_mw', 30000);
      const priority = str(values, 'priority', 'default');
      const police = bool(values, 'police', true);
      const on = mode !== 'never';
      const findings            = [];
      if (ports.length === 0) findings.push(error('network.ios.poe-no-ports', 'No port was named.', SOURCE));
      if (on && (max < 4000 || max > 90000)) findings.push(error('network.ios.poe-max', 'The ceiling must be between 4000 and 90000 milliwatts.', SOURCE));
      if (on && max > 30000) findings.push(warning('network.ios.poe-upoe', `${max} mW is above PoE+ (30 W). Only UPOE (60 W) or UPOE+ (90 W) ports and power supplies can deliver it; a PoE+ port refuses the command.`, SOURCE));
      if (mode === 'static' && ports.length > 8) findings.push(warning('network.ios.poe-static-budget', `Static mode reserves ${max} mW on each of ${ports.length} ports whether anything is drawing it or not, which can exhaust the budget and leave other ports unpowered.`, SOURCE));
      if (mode === 'never') findings.push(warning('network.ios.poe-never', 'Every phone, access point or camera on these ports loses power the moment this is applied.', SOURCE));

      return {
        platform: PLATFORM,
        title: `PoE ${mode} on ${ports.length} port${ports.length === 1 ? '' : 's'}`,
        impact: mode === 'never' ? 'outage' : 'brief',
        notes: [
          'Changing the power mode or ceiling can make the port renegotiate power, and the device behind it may reboot.',
          'Check the budget before and after: the power supplies decide what is available, not the ports.',
          ...(priority !== 'default' ? ['Priority decides which ports are shed first when the budget runs short, for example when a power supply fails. VERIFY the platform supports per-port priority (Catalyst 9300 and 9400 do).'] : []),
          ...(police ? ['Policing with action log reports a device that draws more than it negotiated, without cutting it off.'] : []),
        ],
        before: ['show power inline', ...ports.slice(0, 2).map((p) => `show power inline ${p} detail`), 'show environment power all'],
        config: ports.flatMap((p) => [
          `interface ${p}`,
          on ? ` power inline ${mode} max ${max}` : ' power inline never',
          ...(on && priority !== 'default' ? [` power inline port priority ${priority}`] : []),
          ...(on && police ? [' power inline police action log'] : []),
          '!',
        ]),
        verify: ['show power inline', ...ports.slice(0, 2).map((p) => `show power inline ${p} detail`), ...(on && police ? ['show power inline police'] : []), 'show logging | include ILPOWER'],
        backout: ports.flatMap((p) => [
          `interface ${p}`,
          ' power inline auto',
          ...(on && priority !== 'default' ? [' no power inline port priority'] : []),
          ...(on && police ? [' no power inline police'] : []),
          '!',
        ]),
        findings,
      };
    },
  }),

  /* -------------------------------------------------------- EVPN-VXLAN, Cat9k */
  deviceBlueprint({
    id: 'ios_evpn_vxlan',
    platform: PLATFORM,
    label: 'EVPN VXLAN layer 2 VNI (Catalyst 9000)',
    group: 'Overlay',
    description: 'A layer 2 VNI on a Catalyst 9000 leaf: the EVPN instance, the VLAN-to-VNI mapping, the NVE interface and the L2VPN EVPN family towards the spines.',
    inputs: [
      { id: 'vlan', label: 'VLAN', control: 'number', default: 101, min: 2, max: 4094 },
      { id: 'evi', label: 'EVPN instance', control: 'number', default: 101, min: 1, max: 65535 },
      { id: 'vni', label: 'VNI', control: 'number', default: 10101, min: 1, max: 16777214 },
      { id: 'source', label: 'NVE source loopback', control: 'text', default: 'Loopback1' },
      { id: 'asn', label: 'BGP AS', control: 'number', default: 65001, min: 1, max: 4294967295 },
      { id: 'spines', label: 'Spine loopbacks (BGP peers)', control: 'text', default: '10.255.0.1, 10.255.0.2', hint: 'Already configured as BGP neighbours' },
      { id: 'replication', label: 'BUM replication', control: 'select', default: 'ingress', options: [
        { value: 'ingress', label: 'Ingress replication (no multicast underlay)' },
        { value: 'static', label: 'Multicast group' },
      ] },
      { id: 'mcast_group', label: 'Multicast group', control: 'text', default: '239.1.1.101', showWhen: { input: 'replication', equals: ['static'] } },
    ],
    change: (values                 )               => {
      const vlan = num(values, 'vlan', 101);
      const evi = num(values, 'evi', 101);
      const vni = num(values, 'vni', 10101);
      const source = str(values, 'source', 'Loopback1');
      const asn = num(values, 'asn', 65001);
      const spines = listOf(str(values, 'spines', ''));
      const ingress = str(values, 'replication', 'ingress') === 'ingress';
      const group = str(values, 'mcast_group', '');
      const findings            = [];
      if (vni < 1 || vni > 16777214) findings.push(error('network.ios.evpn-bad-vni', 'A VNI is between 1 and 16777214.', SOURCE));
      if (spines.length === 0) findings.push(error('network.ios.evpn-no-spines', 'No BGP peer was named, so no EVPN route is exchanged.', SOURCE));
      for (const s of spines) if (!isIpv4(s)) findings.push(error('network.ios.evpn-bad-spine', `"${s}" is not an IPv4 address.`, SOURCE));
      if (!ingress) {
        const first = Number(group.split('.')[0]);
        if (!isIpv4(group) || first < 224 || first > 239) findings.push(error('network.ios.evpn-bad-group', `"${group}" is not a multicast group address.`, SOURCE));
      }
      if (!/^loopback/i.test(source)) findings.push(warning('network.ios.evpn-source', `The NVE source is ${source}. It should be a loopback the underlay advertises, or the VTEP address moves with a link.`, SOURCE));

      return {
        platform: PLATFORM,
        title: `EVPN VXLAN: VLAN ${vlan} as VNI ${vni}`,
        impact: 'brief',
        notes: [
          'Needs Network Advantage licensing and IOS-XE 16.12 or later. The underlay (loopbacks reachable, jumbo MTU of at least 1550 on fabric links) and the BGP sessions to the spines must already exist.',
          ingress
            ? 'Ingress replication copies broadcast and unknown traffic to every remote VTEP from this switch. Fine for a small fabric; a large one wants a multicast underlay.'
            : `Multicast replication needs ip multicast-routing and PIM on every underlay link, and a rendezvous point for ${group}.`,
          'The spines must reflect or re-advertise the L2VPN EVPN family with extended communities, or the route targets never arrive.',
        ],
        before: ['show nve peers', 'show nve vni', 'show l2vpn evpn evi', 'show bgp l2vpn evpn summary', `show vlan id ${vlan}`],
        config: [
          'l2vpn evpn',
          ` replication-type ${ingress ? 'ingress' : 'static'}`,
          ` router-id ${source}`,
          '!',
          `l2vpn evpn instance ${evi} vlan-based`,
          ' encapsulation vxlan',
          '!',
          `vlan configuration ${vlan}`,
          ` member evpn-instance ${evi} vni ${vni}`,
          '!',
          'interface nve1',
          ' no ip address',
          ` source-interface ${source}`,
          ' host-reachability protocol bgp',
          ingress ? ` member vni ${vni} ingress-replication` : ` member vni ${vni} mcast-group ${group}`,
          '!',
          `router bgp ${asn}`,
          ' address-family l2vpn evpn',
          ...spines.flatMap((s) => [`  neighbor ${s} activate`, `  neighbor ${s} send-community both`]),
          ' exit-address-family',
          '!',
        ],
        verify: ['show nve peers', `show nve vni ${vni} detail`, `show l2vpn evpn evi ${evi} detail`, 'show bgp l2vpn evpn summary', `show l2vpn evpn mac evi ${evi}`],
        backout: [
          'interface nve1',
          ` no member vni ${vni}`,
          '!',
          `vlan configuration ${vlan}`,
          ` no member evpn-instance ${evi} vni ${vni}`,
          '!',
          `no l2vpn evpn instance ${evi}`,
        ],
        findings,
      };
    },
  }),
];
