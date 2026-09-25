/**
 * Cisco NX-OS: the remaining gaps.
 *
 * The first files build a VXLAN leaf and its operational scaffolding. What was
 * missing is the other side of the fabric and the edge of it: IS-IS and LDP
 * for an MPLS or IS-IS underlay, the spine that reflects EVPN, and the port
 * and switch protections (port security, storm control, private VLANs,
 * spanning-tree defaults), RADIUS and a login banner.
 *
 * Same contract: capture first, verify after, an exact back-out, and never a
 * credential. Keys are `<REQUIRED>`.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { isIp } from '../../core/ip.ts';
import { isIpv4, listOf, vlanIds, vlanRange, type DeviceChange } from '../device.ts';

const PLATFORM = 'cisco_nxos' as const;
const SECRET = '<REQUIRED>';
const SOURCE = { source: 'ArchToolKit' } as const;

const isNet = (net: string): boolean => /^[0-9a-f]{2}(\.[0-9a-f]{4}){4,9}\.00$/i.test(net);
const isClusterId = (value: string): boolean => isIpv4(value) || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 4294967295);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export const NXOS_EXTRA_3: readonly ChangeBlueprint[] = [
  /* ------------------------------------------------------------------ IS-IS */
  deviceBlueprint({
    id: 'nxos_isis',
    platform: PLATFORM,
    label: 'IS-IS',
    group: 'Routing',
    description: 'IS-IS as the fabric underlay: level 2, point-to-point fabric links, a passive loopback, MD5 authentication and an overload bit on startup.',
    inputs: [
      { id: 'tag', label: 'Process tag', control: 'text', default: 'UNDERLAY' },
      { id: 'net', label: 'NET', control: 'text', default: '49.0001.0100.0000.0001.00' },
      { id: 'level', label: 'Level', control: 'select', default: 'level-2', options: [
        { value: 'level-2', label: 'Level 2 only' },
        { value: 'level-1', label: 'Level 1 only' },
        { value: 'level-1-2', label: 'Level 1 and 2' },
      ] },
      { id: 'interfaces', label: 'Fabric interfaces', control: 'text', default: 'Ethernet1/49, Ethernet1/50' },
      { id: 'loopback', label: 'Loopback', control: 'text', default: 'loopback0' },
      { id: 'point_to_point', label: 'Point-to-point links', control: 'toggle', default: true },
      { id: 'auth', label: 'MD5 authentication', control: 'toggle', default: true },
      { id: 'bfd', label: 'BFD on fabric links', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const tag = str(values, 'tag', 'UNDERLAY');
      const net = str(values, 'net', '');
      const level = str(values, 'level', 'level-2');
      const ifaces = listOf(str(values, 'interfaces', ''));
      const loopback = str(values, 'loopback', 'loopback0');
      const p2p = bool(values, 'point_to_point', true);
      const auth = bool(values, 'auth', true);
      const bfd = bool(values, 'bfd', false);
      const levels = level === 'level-1-2' ? ['level-1', 'level-2'] : [level];
      const findings: Finding[] = [];
      if (!isNet(net)) findings.push(error('network.nxos.isis-bad-net', `"${net}" is not a NET: an area, a six-byte system id and the selector 00.`, SOURCE));
      if (ifaces.length === 0) findings.push(error('network.nxos.isis-no-interfaces', 'No fabric interface was named, so the process forms no adjacency.', SOURCE));
      if (level === 'level-1-2') findings.push(warning('network.nxos.isis-l1l2', 'Level 1-2 keeps two databases and two adjacencies on every link. A single-area fabric wants level 2 only.', SOURCE));
      if (!auth) findings.push(warning('network.nxos.isis-no-auth', 'Without authentication, anything that can send a hello on a fabric link joins the underlay.', SOURCE));

      return {
        platform: PLATFORM,
        title: `IS-IS ${tag} (${level})`,
        impact: 'brief',
        notes: [
          'NX-OS advertises wide metrics. An IOS router in the same domain needs metric-style wide, or it ignores these routes.',
          'The overload bit is held for five minutes after a reload, so the switch is not used for transit until BGP has converged.',
          ...(auth ? [`Replace ${SECRET} with the IS-IS key from your vault. Both ends of a link must match, or the adjacency drops.`] : []),
          ...(p2p ? ['medium p2p resets the adjacency on the interface. Change both ends in the same window.'] : []),
        ],
        before: ['show isis adjacency', 'show isis interface brief', 'show ip route isis', 'show running-config isis'],
        config: [
          'feature isis',
          ...(bfd ? ['feature bfd'] : []),
          ...(auth ? ['key chain ISIS-KEY', '  key 1', `    key-string ${SECRET}`, '!'] : []),
          `router isis ${tag}`,
          `  net ${net}`,
          `  is-type ${level}`,
          '  log-adjacency-changes',
          '  set-overload-bit on-startup 300',
          ...(auth ? levels.flatMap((l) => [`  authentication-type md5 ${l}`, `  authentication key-chain ISIS-KEY ${l}`]) : []),
          '!',
          `interface ${loopback}`,
          `  ip router isis ${tag}`,
          `  isis passive-interface ${level === 'level-1-2' ? 'level-1-2' : level}`,
          '!',
          ...ifaces.flatMap((iface) => [
            `interface ${iface}`,
            ...(p2p ? ['  medium p2p'] : []),
            `  ip router isis ${tag}`,
            ...(bfd ? ['  isis bfd'] : []),
            '!',
          ]),
        ],
        verify: ['show isis adjacency', 'show isis database', 'show ip route isis', 'show isis interface brief', ...(bfd ? ['show bfd neighbors'] : [])],
        backout: [
          ...ifaces.flatMap((iface) => [`interface ${iface}`, `  no ip router isis ${tag}`, ...(p2p ? ['  no medium p2p'] : []), ...(bfd ? ['  no isis bfd'] : []), '!']),
          `interface ${loopback}`,
          `  no ip router isis ${tag}`,
          '!',
          `no router isis ${tag}`,
          ...(auth ? ['no key chain ISIS-KEY'] : []),
        ],
        findings,
      };
    },
  }),

  /* --------------------------------------------------------------- MPLS LDP */
  deviceBlueprint({
    id: 'nxos_mpls_ldp',
    platform: PLATFORM,
    label: 'MPLS LDP',
    group: 'Routing',
    description: 'LDP on a Nexus 9000 or 7000: the MPLS feature set, LDP with a loopback router id, session protection and LDP-IGP synchronisation under OSPF.',
    inputs: [
      { id: 'interfaces', label: 'Core interfaces', control: 'text', default: 'Ethernet1/49, Ethernet1/50' },
      { id: 'router_id', label: 'LDP router id interface', control: 'text', default: 'loopback0' },
      { id: 'sync', label: 'LDP-IGP sync under OSPF', control: 'toggle', default: true },
      { id: 'ospf_tag', label: 'OSPF instance', control: 'text', default: 'UNDERLAY', showWhen: { input: 'sync', equals: ['true'] } },
      { id: 'session_protection', label: 'Session protection', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const rid = str(values, 'router_id', 'loopback0');
      const sync = bool(values, 'sync', true);
      const ospf = str(values, 'ospf_tag', 'UNDERLAY');
      const protection = bool(values, 'session_protection', true);
      const findings: Finding[] = [];
      if (ifaces.length === 0) findings.push(error('network.nxos.ldp-no-interfaces', 'No interface was named, so LDP discovers nobody.', SOURCE));
      if (!/^loopback/i.test(rid)) findings.push(warning('network.nxos.ldp-router-id', `The LDP router id comes from ${rid}. A physical interface changes the router id when it fails, and every session resets.`, SOURCE));
      if (!sync) findings.push(warning('network.nxos.ldp-no-sync', 'Without LDP-IGP synchronisation the IGP routes over a link before it has labels, and labelled traffic is black-holed until LDP catches up.', SOURCE));

      return {
        platform: PLATFORM,
        title: `MPLS LDP on ${plural(ifaces.length, 'interface')}`,
        impact: 'brief',
        notes: [
          'LDP needs hardware that forwards MPLS: Nexus 9500 or 9300 with the MPLS licence, or a Nexus 7000 with M-series or F3 modules. VERIFY your line cards before the window.',
          'On a Nexus 7000, install feature-set mpls runs once in the default (admin) VDC; feature-set mpls and the rest run in the VDC that routes.',
          'Core links need an MTU that carries a full packet plus the label stack.',
          ...(sync ? [`VERIFY the release accepts mpls ldp sync under router ospf ${ospf}; on releases that do not, leave sync off and rely on the IGP holding cost.`] : []),
        ],
        before: ['show feature-set', 'show mpls ldp neighbor', 'show mpls interface', 'show running-config ospf'],
        config: [
          'install feature-set mpls',
          'feature-set mpls',
          'feature mpls ldp',
          '!',
          'mpls ldp configuration',
          `  router-id ${rid} force`,
          ...(protection ? ['  session protection'] : []),
          '!',
          ...ifaces.flatMap((iface) => [`interface ${iface}`, '  mpls ip', '!']),
          ...(sync ? [`router ospf ${ospf}`, '  mpls ldp sync', '!'] : []),
        ],
        verify: ['show mpls ldp neighbor', 'show mpls ldp discovery', 'show mpls interface', 'show mpls switching', ...(sync ? ['show mpls ldp igp sync'] : [])],
        backout: [
          ...ifaces.flatMap((iface) => [`interface ${iface}`, '  no mpls ip', '!']),
          ...(sync ? [`router ospf ${ospf}`, '  no mpls ldp sync', '!'] : []),
          'no mpls ldp configuration',
          'no feature mpls ldp',
        ],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------------ EVPN spine */
  deviceBlueprint({
    id: 'nxos_evpn_spine',
    platform: PLATFORM,
    label: 'EVPN spine (BGP route reflector)',
    group: 'Overlay',
    description: 'The spine side of an iBGP EVPN fabric: the L2VPN EVPN family, a leaf template with route-reflector-client and extended communities, a cluster id and the leaves.',
    inputs: [
      { id: 'asn', label: 'Fabric AS', control: 'number', default: 65000, min: 1, max: 4294967295 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.1' },
      { id: 'cluster_id', label: 'Cluster id', control: 'text', default: '10.255.0.100', hint: 'The same on every spine; blank uses the router id' },
      { id: 'leaves', label: 'Leaf loopbacks', control: 'textarea', default: '10.255.0.11\n10.255.0.12', hint: 'One per line' },
      { id: 'update_source', label: 'Update source', control: 'text', default: 'loopback0' },
      { id: 'ipv4', label: 'Also reflect IPv4 unicast', control: 'toggle', default: false },
      { id: 'auth', label: 'MD5 on the sessions', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const asn = num(values, 'asn', 65000);
      const rid = str(values, 'router_id', '');
      const cluster = str(values, 'cluster_id', '');
      const leaves = listOf(str(values, 'leaves', ''));
      const src = str(values, 'update_source', 'loopback0');
      const v4 = bool(values, 'ipv4', false);
      const auth = bool(values, 'auth', false);
      const findings: Finding[] = [];
      if (!isIpv4(rid)) findings.push(error('network.nxos.bad-router-id', `"${rid}" is not a dotted router id.`, SOURCE));
      if (!cluster) {
        findings.push(warning('network.nxos.rr-no-cluster-id', 'No cluster id, so each spine uses its router id. The spines then accept each other\'s reflected routes and every leaf holds duplicate paths.', { remediation: 'Give every spine the same cluster id.', ...SOURCE }));
      } else if (!isClusterId(cluster)) {
        findings.push(error('network.nxos.rr-bad-cluster-id', `"${cluster}" is not a cluster id.`, SOURCE));
      }
      if (leaves.length === 0) findings.push(error('network.nxos.rr-no-clients', 'No leaf was named.', SOURCE));
      for (const l of leaves) {
        if (!isIpv4(l)) findings.push(error('network.nxos.rr-bad-client', `"${l}" is not an IPv4 loopback.`, SOURCE));
        if (l === rid) findings.push(error('network.nxos.rr-self-client', `${l} is this spine's own router id.`, SOURCE));
      }

      return {
        platform: PLATFORM,
        title: `EVPN spine reflecting to ${plural(leaves.length, 'leaf')} (AS ${asn})`.replace('leafs', 'leaves'),
        impact: 'brief',
        notes: [
          'The spine needs nv overlay evpn for the L2VPN EVPN family, but not feature nv overlay or any VNI: it carries routes, not VXLAN.',
          'Extended communities carry the route targets and the router MAC. Without send-community extended, leaves learn nothing usable.',
          'Every leaf should peer with at least two spines. Configure the second spine with the same cluster id.',
          ...(auth ? [`Replace ${SECRET} with the session password. The leaves must use the same one.`] : []),
        ],
        before: ['show bgp l2vpn evpn summary', 'show running-config bgp', 'show feature | include bgp'],
        config: [
          'feature bgp',
          'nv overlay evpn',
          '!',
          `router bgp ${asn}`,
          `  router-id ${rid}`,
          ...(cluster ? [`  cluster-id ${cluster}`] : []),
          '  log-neighbor-changes',
          ...(v4 ? ['  address-family ipv4 unicast'] : []),
          '  address-family l2vpn evpn',
          '  template peer EVPN-LEAVES',
          `    remote-as ${asn}`,
          `    update-source ${src}`,
          ...(auth ? [`    password 0 ${SECRET}`] : []),
          ...(v4 ? ['    address-family ipv4 unicast', '      send-community', '      send-community extended', '      route-reflector-client'] : []),
          '    address-family l2vpn evpn',
          '      send-community',
          '      send-community extended',
          '      route-reflector-client',
          ...leaves.flatMap((l) => [`  neighbor ${l}`, '    inherit peer EVPN-LEAVES', '    description EVPN leaf']),
          '!',
        ],
        verify: ['show bgp l2vpn evpn summary', ...(v4 ? ['show bgp ipv4 unicast summary'] : []), ...leaves.slice(0, 1).map((l) => `show bgp l2vpn evpn neighbors ${l} | include Route reflector|state`), 'show bgp l2vpn evpn | include Route Distinguisher'],
        backout: [`router bgp ${asn}`, ...leaves.map((l) => `  no neighbor ${l}`), '  no template peer EVPN-LEAVES', ...(cluster ? [`  no cluster-id ${cluster}`] : []), '!'],
        findings,
      };
    },
  }),

  /* ----------------------------------------------------------------- Banner */
  deviceBlueprint({
    id: 'nxos_banner',
    platform: PLATFORM,
    label: 'Login banner',
    group: 'Baseline',
    description: 'The message-of-the-day banner every login sees, stating that access is restricted and monitored.',
    inputs: [
      { id: 'banner', label: 'Banner text', control: 'textarea', default: 'Authorised access only.\nActivity on this device is monitored and logged.' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const text = str(values, 'banner', '');
      const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
      const findings: Finding[] = [];
      if (!text) findings.push(error('network.nxos.banner-empty', 'The banner is empty.', SOURCE));
      if (text.includes('^')) findings.push(error('network.nxos.banner-delimiter', 'The banner contains ^, which is the delimiter this change uses, so the banner would end early and the rest would be read as commands.', SOURCE));
      if (lines.some((l) => /^\s*[!#]/.test(l))) findings.push(error('network.nxos.banner-comment', 'A banner line starting with ! or # is taken as a comment when the file is pasted or pushed. Reword it.', SOURCE));
      if (/\bwelcome\b/i.test(text)) findings.push(warning('network.nxos.banner-welcome', 'A banner that welcomes people reads as an invitation. State that access is restricted instead.', SOURCE));

      return {
        platform: PLATFORM,
        title: 'Message-of-the-day banner',
        impact: 'none',
        notes: ['The banner says nothing about the device: no hostname, model, location or owner. It is shown before anyone has logged in.'],
        before: ['show banner motd'],
        config: ['banner motd ^', ...lines, '^'],
        verify: ['show banner motd'],
        backout: ['no banner motd'],
        findings,
      };
    },
  }),

  /* ---------------------------------------------------------- Port security */
  deviceBlueprint({
    id: 'nxos_port_security',
    platform: PLATFORM,
    label: 'Port security',
    group: 'Security',
    description: 'Limit the MAC addresses an access port will learn, with sticky learning and a violation action that does not take the port down by default.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Ethernet1/10, Ethernet1/11' },
      { id: 'maximum', label: 'Maximum MAC addresses', control: 'number', default: 2, min: 1, max: 1025 },
      { id: 'violation', label: 'On violation', control: 'select', default: 'restrict', options: [
        { value: 'restrict', label: 'Restrict: drop and count' },
        { value: 'protect', label: 'Protect: drop silently' },
        { value: 'shutdown', label: 'Shutdown: error-disable the port' },
      ] },
      { id: 'sticky', label: 'Sticky learning', control: 'toggle', default: true, hint: 'Learned addresses are kept in the running configuration' },
      { id: 'aging', label: 'Aging (minutes)', control: 'number', default: 0, min: 0, max: 1440, hint: '0 for no aging' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const max = num(values, 'maximum', 2);
      const violation = str(values, 'violation', 'restrict');
      const sticky = bool(values, 'sticky', true);
      const aging = num(values, 'aging', 0);
      const findings: Finding[] = [];
      if (ifaces.length === 0) findings.push(error('network.nxos.portsec-no-interfaces', 'No interface was named.', SOURCE));
      if (max < 1) findings.push(error('network.nxos.portsec-max', 'The maximum must be at least 1.', SOURCE));
      if (violation === 'shutdown') findings.push(warning('network.nxos.portsec-shutdown', 'Shutdown error-disables the port on the first unknown address, and it stays down until someone bounces it or errdisable recovery is configured for psecure-violation.', SOURCE));
      if (sticky && aging > 0) findings.push(info('network.nxos.portsec-sticky-aging', 'Sticky addresses do not age. The aging time applies only to dynamically learned ones.', SOURCE));
      if (max === 1) findings.push(info('network.nxos.portsec-one', 'A maximum of one breaks a phone with a PC behind it, and a virtualised host.', SOURCE));

      return {
        platform: PLATFORM,
        title: `Port security on ${plural(ifaces.length, 'interface')} (max ${max}, ${violation})`,
        impact: 'brief',
        notes: [
          'Port security is for layer 2 access ports. It is not supported on a vPC peer-link, and on a vPC or FEX port it has release-specific limits: VERIFY before applying there.',
          'Enabling it clears the dynamically learned addresses on the port; traffic pauses while they are relearned.',
          ...(sticky ? ['Sticky addresses are written to the running configuration. Save it, or they are forgotten on reload.'] : []),
        ],
        before: ['show port-security', ...ifaces.slice(0, 2).map((i) => `show running-config interface ${i}`), 'show mac address-table'],
        config: [
          'feature port-security',
          '!',
          ...ifaces.flatMap((iface) => [
            `interface ${iface}`,
            '  switchport port-security',
            `  switchport port-security maximum ${max}`,
            `  switchport port-security violation ${violation}`,
            ...(sticky ? ['  switchport port-security mac-address sticky'] : []),
            ...(aging > 0 ? [`  switchport port-security aging time ${aging}`, '  switchport port-security aging type inactivity'] : []),
            '!',
          ]),
        ],
        verify: ['show port-security', ...ifaces.slice(0, 2).map((i) => `show port-security interface ${i}`), 'show port-security address'],
        backout: ifaces.flatMap((iface) => [
          `interface ${iface}`,
          ...(sticky ? ['  no switchport port-security mac-address sticky'] : []),
          ...(aging > 0 ? ['  no switchport port-security aging time'] : []),
          '  no switchport port-security violation',
          '  no switchport port-security maximum',
          '  no switchport port-security',
          '!',
        ]),
        findings,
      };
    },
  }),

  /* ---------------------------------------------------------- Storm control */
  deviceBlueprint({
    id: 'nxos_storm_control',
    platform: PLATFORM,
    label: 'Storm control',
    group: 'Security',
    description: 'Cap broadcast, multicast and unknown-unicast flooding on a set of ports, with an SNMP trap or a shutdown when the cap is hit.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Ethernet1/10, Ethernet1/11' },
      { id: 'broadcast', label: 'Broadcast (% of bandwidth)', control: 'number', default: 1, min: 0, max: 100, hint: '0 for no limit' },
      { id: 'multicast', label: 'Multicast (% of bandwidth)', control: 'number', default: 5, min: 0, max: 100, hint: '0 for no limit' },
      { id: 'unicast', label: 'Unknown unicast (% of bandwidth)', control: 'number', default: 0, min: 0, max: 100, hint: '0 for no limit' },
      { id: 'action', label: 'When exceeded', control: 'select', default: 'trap', options: [
        { value: 'trap', label: 'Drop the excess and send a trap' },
        { value: 'none', label: 'Drop the excess only' },
        { value: 'shutdown', label: 'Error-disable the port' },
      ] },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const levels = (['broadcast', 'multicast', 'unicast'] as const).map((kind) => ({ kind, level: num(values, kind, 0) })).filter((l) => l.level > 0);
      const action = str(values, 'action', 'trap');
      const findings: Finding[] = [];
      if (ifaces.length === 0) findings.push(error('network.nxos.storm-no-interfaces', 'No interface was named.', SOURCE));
      if (levels.length === 0) findings.push(error('network.nxos.storm-no-levels', 'Every level is 0, so nothing is limited.', SOURCE));
      for (const l of levels) {
        if (l.level < 0.5) findings.push(warning('network.nxos.storm-too-low', `A ${l.kind} level of ${l.level}% is low enough to drop ordinary ARP, DHCP or routing-protocol traffic on a busy port.`, SOURCE));
      }
      if (action === 'shutdown') findings.push(warning('network.nxos.storm-shutdown', 'Shutdown error-disables the port when the level is crossed. On an uplink that takes a whole rack off the network for a burst of broadcasts.', { remediation: 'Use shutdown on access ports only, with errdisable recovery.', ...SOURCE }));

      return {
        platform: PLATFORM,
        title: `Storm control on ${plural(ifaces.length, 'interface')}`,
        impact: 'none',
        notes: [
          'Levels are a percentage of the port speed, measured each second. What is above the level is dropped for the rest of that interval.',
          'Unknown unicast is how a fabric floods to a host it has not yet learned. Limit it gently, if at all, on server-facing ports.',
        ],
        before: ['show interface counters storm-control', ...ifaces.slice(0, 2).map((i) => `show running-config interface ${i}`)],
        config: ifaces.flatMap((iface) => [
          `interface ${iface}`,
          ...levels.map((l) => `  storm-control ${l.kind} level ${l.level.toFixed(2)}`),
          ...(action !== 'none' ? [`  storm-control action ${action}`] : []),
          '!',
        ]),
        verify: ['show interface counters storm-control', ...ifaces.slice(0, 2).map((i) => `show running-config interface ${i} | include storm`)],
        backout: ifaces.flatMap((iface) => [`interface ${iface}`, ...levels.map((l) => `  no storm-control ${l.kind} level`), ...(action !== 'none' ? [`  no storm-control action ${action}`] : []), '!']),
        findings,
      };
    },
  }),

  /* ----------------------------------------------------------- Private VLANs */
  deviceBlueprint({
    id: 'nxos_private_vlan',
    platform: PLATFORM,
    label: 'Private VLANs',
    group: 'Switching',
    description: 'A primary VLAN with isolated and community secondaries, host ports, a promiscuous port and the SVI mapping.',
    inputs: [
      { id: 'primary', label: 'Primary VLAN', control: 'number', default: 100, min: 2, max: 3967 },
      { id: 'isolated', label: 'Isolated VLAN', control: 'number', default: 101, min: 0, max: 3967, hint: '0 for none' },
      { id: 'community', label: 'Community VLANs', control: 'text', default: '', hint: 'Blank for none, or a list: 102, 103' },
      { id: 'host_vlan', label: 'Secondary VLAN for the host ports', control: 'number', default: 101, min: 2, max: 3967 },
      { id: 'host_ports', label: 'Host ports', control: 'text', default: 'Ethernet1/10, Ethernet1/11' },
      { id: 'promiscuous_ports', label: 'Promiscuous ports', control: 'text', default: 'Ethernet1/48', hint: 'Blank for none' },
      { id: 'svi', label: 'Map the primary SVI', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const primary = num(values, 'primary', 100);
      const isolated = num(values, 'isolated', 101);
      const community = vlanIds(str(values, 'community', ''));
      const secondaries = [...(isolated > 0 ? [isolated] : []), ...community];
      const hostVlan = num(values, 'host_vlan', 101);
      const hosts = listOf(str(values, 'host_ports', ''));
      const promiscuous = listOf(str(values, 'promiscuous_ports', ''));
      const svi = bool(values, 'svi', true);
      const all = [primary, ...secondaries];
      const map = vlanRange(secondaries);
      const findings: Finding[] = [];
      if (secondaries.length === 0) findings.push(error('network.nxos.pvlan-no-secondary', 'A primary VLAN with no isolated or community VLAN is just a VLAN.', SOURCE));
      if (new Set(all).size !== all.length) findings.push(error('network.nxos.pvlan-duplicate', 'The primary and secondary VLANs must all be different.', SOURCE));
      if (hosts.length > 0 && !secondaries.includes(hostVlan)) findings.push(error('network.nxos.pvlan-host-vlan', `VLAN ${hostVlan} is not a secondary of VLAN ${primary}.`, SOURCE));
      if (promiscuous.length === 0 && !svi) findings.push(warning('network.nxos.pvlan-no-exit', 'With no promiscuous port and no SVI mapping, the hosts can reach nothing outside their community.', SOURCE));

      return {
        platform: PLATFORM,
        title: `Private VLAN ${primary} with secondaries ${map || 'none'}`,
        impact: 'brief',
        notes: [
          'A host port loses its access VLAN when it becomes a private-VLAN host, so the device behind it moves VLAN.',
          'On a vPC pair, configure the same private VLANs on both peers with the same associations, or the consistency check suspends the VLANs.',
          'Private VLANs are not supported on FEX host interfaces as promiscuous ports. VERIFY the release notes for your platform.',
        ],
        before: ['show vlan private-vlan', 'show feature | include private-vlan', ...hosts.slice(0, 2).map((p) => `show running-config interface ${p}`)],
        config: [
          'feature private-vlan',
          ...(svi ? ['feature interface-vlan'] : []),
          '!',
          ...(isolated > 0 ? [`vlan ${isolated}`, '  private-vlan isolated', '!'] : []),
          ...community.flatMap((v) => [`vlan ${v}`, '  private-vlan community', '!']),
          `vlan ${primary}`,
          '  private-vlan primary',
          `  private-vlan association ${map}`,
          '!',
          ...hosts.flatMap((p) => [`interface ${p}`, '  switchport', '  switchport mode private-vlan host', `  switchport private-vlan host-association ${primary} ${hostVlan}`, '!']),
          ...promiscuous.flatMap((p) => [`interface ${p}`, '  switchport', '  switchport mode private-vlan promiscuous', `  switchport private-vlan mapping ${primary} ${map}`, '!']),
          ...(svi ? [`interface Vlan${primary}`, `  private-vlan mapping ${map}`, '!'] : []),
        ],
        verify: ['show vlan private-vlan', 'show interface private-vlan mapping', ...hosts.slice(0, 2).map((p) => `show interface ${p} switchport`)],
        backout: [
          ...(svi ? [`interface Vlan${primary}`, '  no private-vlan mapping', '!'] : []),
          ...promiscuous.flatMap((p) => [`interface ${p}`, '  no switchport private-vlan mapping', '  switchport mode access', '!']),
          ...hosts.flatMap((p) => [`interface ${p}`, '  no switchport private-vlan host-association', '  switchport mode access', '!']),
          `vlan ${primary}`,
          '  no private-vlan association',
          '  no private-vlan primary',
          '!',
          ...secondaries.map((v) => `no vlan ${v}`),
        ],
        findings,
      };
    },
  }),

  /* ---------------------------------------------------------------- RADIUS */
  deviceBlueprint({
    id: 'nxos_aaa_radius',
    platform: PLATFORM,
    label: 'AAA with RADIUS',
    group: 'Baseline',
    description: 'Log in against RADIUS (ISE, NPS) through the management VRF, with a local fallback and accounting.',
    inputs: [
      { id: 'servers', label: 'RADIUS servers', control: 'text', default: '10.0.0.30, 10.0.0.31' },
      { id: 'vrf', label: 'VRF', control: 'text', default: 'management' },
      { id: 'source', label: 'Source interface', control: 'text', default: 'mgmt0' },
      { id: 'accounting', label: 'Accounting', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const servers = listOf(str(values, 'servers', ''));
      const vrf = str(values, 'vrf', 'management');
      const accounting = bool(values, 'accounting', true);
      const findings: Finding[] = [];
      if (servers.length === 0) findings.push(error('network.nxos.radius-no-servers', 'No RADIUS server was named.', SOURCE));
      for (const s of servers) if (!isIp(s)) findings.push(error('network.nxos.radius-bad-server', `"${s}" is not an IP address.`, SOURCE));
      if (servers.length === 1) findings.push(warning('network.nxos.radius-one-server', 'One RADIUS server means every login falls back to local accounts when it is down or patched.', SOURCE));

      return {
        platform: PLATFORM,
        title: `AAA with RADIUS (${plural(servers.length, 'server')})`,
        impact: 'none',
        notes: [
          `Replace every ${SECRET} with the RADIUS shared secret from your vault. The switch must be added to the RADIUS server as a network device first.`,
          'RADIUS authenticates and returns the role (shell:roles="network-admin" in a Cisco AV pair); it cannot authorise individual commands the way TACACS+ can.',
          'Keep a session open until a new login has been tested. The local fallback applies only when every server is unreachable, not when one rejects the password.',
        ],
        before: ['show radius-server', 'show aaa authentication', 'show running-config aaa'],
        config: [
          ...servers.map((s) => `radius-server host ${s} key 0 ${SECRET} authentication accounting`),
          'radius-server timeout 5',
          'radius-server retransmit 2',
          'radius-server deadtime 5',
          '!',
          'aaa group server radius RADIUS-GROUP',
          ...servers.map((s) => `  server ${s}`),
          `  use-vrf ${vrf}`,
          `  source-interface ${str(values, 'source', 'mgmt0')}`,
          '!',
          'aaa authentication login default group RADIUS-GROUP local',
          'aaa authentication login error-enable',
          ...(accounting ? ['aaa accounting default group RADIUS-GROUP'] : []),
          '!',
        ],
        verify: ['show radius-server', 'show radius-server groups RADIUS-GROUP', 'test aaa group RADIUS-GROUP <user> <password>', 'show aaa authentication'],
        backout: [
          'no aaa authentication login default group RADIUS-GROUP local',
          ...(accounting ? ['no aaa accounting default group RADIUS-GROUP'] : []),
          'no aaa group server radius RADIUS-GROUP',
          ...servers.map((s) => `no radius-server host ${s}`),
        ],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------- Spanning tree */
  deviceBlueprint({
    id: 'nxos_spanning_tree',
    platform: PLATFORM,
    label: 'Spanning-tree defaults',
    group: 'Switching',
    description: 'The switch-wide spanning-tree settings: mode, root priority, BPDU guard on edge ports by default, loop guard and long path costs.',
    inputs: [
      { id: 'mode', label: 'Mode', control: 'select', default: 'rapid-pvst', options: [
        { value: 'rapid-pvst', label: 'Rapid PVST+' },
        { value: 'mst', label: 'MST' },
      ] },
      { id: 'priority', label: 'Bridge priority', control: 'number', default: 4096, min: 0, max: 61440, hint: 'A multiple of 4096: 4096 on the primary root, 8192 on the secondary' },
      { id: 'vlans', label: 'VLANs', control: 'text', default: '1-3967', showWhen: { input: 'mode', equals: ['rapid-pvst'] } },
      { id: 'region', label: 'MST region name', control: 'text', default: 'DC1', showWhen: { input: 'mode', equals: ['mst'] } },
      { id: 'revision', label: 'MST revision', control: 'number', default: 1, min: 0, max: 65535, showWhen: { input: 'mode', equals: ['mst'] } },
      { id: 'bpduguard', label: 'BPDU guard on edge ports by default', control: 'toggle', default: true },
      { id: 'loopguard', label: 'Loop guard by default', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const mode = str(values, 'mode', 'rapid-pvst');
      const priority = num(values, 'priority', 4096);
      const vlans = vlanRange(vlanIds(str(values, 'vlans', '1-3967')));
      const bpduguard = bool(values, 'bpduguard', true);
      const loopguard = bool(values, 'loopguard', true);
      const mst = mode === 'mst';
      const findings: Finding[] = [];
      if (priority % 4096 !== 0 || priority < 0 || priority > 61440) findings.push(error('network.nxos.stp-priority', 'The bridge priority must be a multiple of 4096 between 0 and 61440.', SOURCE));
      if (priority === 0) findings.push(warning('network.nxos.stp-priority-zero', 'Priority 0 leaves nothing lower for a replacement root. Use 4096 on the primary root and 8192 on the secondary.', SOURCE));
      if (mst) findings.push(warning('network.nxos.stp-mode-change', 'Changing the spanning-tree mode restarts spanning tree on every VLAN, which blocks and relearns every port. It also has to match the rest of the layer 2 domain, including both vPC peers.', SOURCE));
      if (!mst && !vlans) findings.push(error('network.nxos.stp-no-vlans', 'No VLAN was named for the priority.', SOURCE));

      return {
        platform: PLATFORM,
        title: `Spanning tree: ${mode}, priority ${priority}`,
        impact: mst ? 'outage' : 'brief',
        notes: [
          'On a vPC pair with peer-switch, both peers must have the same priority, or the root moves when this applies.',
          'BPDU guard by default applies to ports marked spanning-tree port type edge. A port that receives a BPDU is error-disabled.',
          ...(mst ? ['Every switch in the MST region must have the same name, revision and VLAN-to-instance mapping, or it is treated as a separate region.'] : []),
        ],
        before: ['show spanning-tree summary', 'show spanning-tree root', ...(mst ? ['show spanning-tree mst configuration'] : [])],
        config: [
          `spanning-tree mode ${mst ? 'mst' : 'rapid-pvst'}`,
          'spanning-tree pathcost method long',
          ...(mst
            ? ['spanning-tree mst configuration', `  name ${str(values, 'region', 'DC1')}`, `  revision ${num(values, 'revision', 1)}`, '!', `spanning-tree mst 0 priority ${priority}`]
            : [`spanning-tree vlan ${vlans} priority ${priority}`]),
          ...(bpduguard ? ['spanning-tree port type edge bpduguard default'] : []),
          ...(loopguard ? ['spanning-tree loopguard default'] : []),
        ],
        verify: ['show spanning-tree summary', 'show spanning-tree root', ...(mst ? ['show spanning-tree mst'] : []), 'show spanning-tree inconsistentports'],
        backout: [
          ...(loopguard ? ['no spanning-tree loopguard default'] : []),
          ...(bpduguard ? ['no spanning-tree port type edge bpduguard default'] : []),
          ...(mst ? [`no spanning-tree mst 0 priority`, 'no spanning-tree mst configuration', 'spanning-tree mode rapid-pvst'] : [`no spanning-tree vlan ${vlans} priority`]),
          'no spanning-tree pathcost method long',
        ],
        findings,
      };
    },
  }),
];
