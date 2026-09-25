/**
 * Arista EOS: the remaining gaps.
 *
 * The first files build an EVPN leaf on a BGP underlay. What was missing is an
 * IGP (OSPF and IS-IS), LDP for an MPLS core, the spine that serves EVPN, and
 * the device basics a security review asks about first: RADIUS, a login
 * banner, LLDP, port security, storm control and spanning-tree defaults.
 *
 * Changes that touch routing or ports are applied in a configure session with
 * a commit timer, like the rest of the EOS kit, so a lost session rolls back by
 * itself. The banner is not: its text is taken literally, indentation and all.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { isIp } from '../../core/ip.js';
import { isIpv4, listOf, vlanIds, vlanRange,                   } from '../device.js';

const PLATFORM = 'arista_eos'         ;
const SECRET = '<REQUIRED>';
const SOURCE = { source: 'ArchToolKit' }         ;

const isNet = (net        )          => /^[0-9a-f]{2}(\.[0-9a-f]{4}){4,9}\.00$/i.test(net);
const isClusterId = (value        )          => isIpv4(value) || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 4294967295);
const plural = (n        , word        )         => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The body of a change, inside a session that rolls back unless committed. */
const inSession = (name        , body                   )           => [`configure session ${name}`, ...body.map((l) => `  ${l}`), '  commit timer 00:05:00'];
/** The back-out, in its own session, committed straight away. */
const rollback = (name        , body                   )           => [`configure session ${name}`, ...body.map((l) => `  ${l}`), '  commit'];
/** The first two verification steps of every session change. */
const confirm = (name        )           => [`show session-config named ${name} diffs`, `configure session ${name} commit`];

export const EOS_EXTRA_3                             = [
  /* ------------------------------------------------------------------- OSPF */
  deviceBlueprint({
    id: 'eos_ospf',
    platform: PLATFORM,
    label: 'OSPF (v2 or v3)',
    group: 'Routing',
    description: 'An OSPFv2 or OSPFv3 process with interfaces joined per interface, point-to-point links, a passive loopback, MD5 on OSPFv2 and optional BFD.',
    inputs: [
      { id: 'version', label: 'Version', control: 'select', default: 'v2', options: [
        { value: 'v2', label: 'OSPFv2 (IPv4)' },
        { value: 'v3', label: 'OSPFv3 (IPv6)' },
      ] },
      { id: 'process', label: 'Process id', control: 'number', default: 1, min: 1, max: 65535 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.1' },
      { id: 'area', label: 'Area', control: 'text', default: '0.0.0.0' },
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Ethernet1, Ethernet2' },
      { id: 'loopback', label: 'Passive loopback', control: 'text', default: 'Loopback0' },
      { id: 'point_to_point', label: 'Point-to-point links', control: 'toggle', default: true },
      { id: 'auth', label: 'MD5 authentication (OSPFv2)', control: 'toggle', default: true, showWhen: { input: 'version', equals: ['v2'] } },
      { id: 'bfd', label: 'BFD', control: 'toggle', default: false },
    ],
    change: (values                 )               => {
      const v3 = str(values, 'version', 'v2') === 'v3';
      const proc = num(values, 'process', 1);
      const rid = str(values, 'router_id', '');
      const area = str(values, 'area', '0.0.0.0');
      const ifaces = listOf(str(values, 'interfaces', ''));
      const loopback = str(values, 'loopback', '');
      const p2p = bool(values, 'point_to_point', true);
      const auth = !v3 && bool(values, 'auth', true);
      const bfd = bool(values, 'bfd', false);
      const af = v3 ? 'ipv6' : 'ip';
      const findings            = [];
      if (!isIpv4(rid)) findings.push(error('network.eos.ospf-router-id', `"${rid}" is not a dotted router id. OSPFv3 uses one too, even on an IPv6-only switch.`, SOURCE));
      if (!isIpv4(area) && !/^\d+$/.test(area)) findings.push(error('network.eos.ospf-area', `"${area}" is not an area: a number or dotted form.`, SOURCE));
      if (ifaces.length === 0) findings.push(error('network.eos.ospf-no-interfaces', 'No interface was named, so no adjacency forms.', SOURCE));
      if (!v3 && !auth) findings.push(warning('network.eos.ospf-no-auth', 'Without authentication, anything on these links can inject routes.', SOURCE));
      if (v3) findings.push(info('network.eos.ospfv3-auth', 'OSPFv3 authentication is IPsec-based and is not written here. Add it if the links are not physically trusted.', SOURCE));
      const joins = ()           => (v3 ? [`ipv6 ospf ${proc} area ${area}`] : [`ip ospf area ${area}`]);
      const session = v3 ? 'ospfv3' : 'ospf';

      return {
        platform: PLATFORM,
        title: `OSPF${v3 ? 'v3' : 'v2'} process ${proc}, area ${area}`,
        impact: 'brief',
        notes: [
          'Applied in a configure session with a five-minute commit timer. Confirm with the commit in the verification steps, or it rolls back.',
          `${v3 ? 'ipv6 unicast-routing' : 'ip routing'} is switched on as part of this change; an EOS switch ships with routing off.`,
          ...(auth ? [`Replace ${SECRET} with the OSPF key. Both ends of every link must match.`] : []),
          ...(p2p ? ['Point-to-point skips the DR election and brings the adjacency up faster. Both ends must agree, or the adjacency sticks in EXSTART.'] : []),
        ],
        before: [v3 ? 'show ipv6 ospf neighbor' : 'show ip ospf neighbor', v3 ? 'show ipv6 route ospf' : 'show ip route ospf', 'show running-config section ospf'],
        config: inSession(session, [
          v3 ? 'ipv6 unicast-routing' : 'ip routing',
          '!',
          `${v3 ? 'ipv6 router ospf' : 'router ospf'} ${proc}`,
          `   router-id ${rid}`,
          ...(loopback ? [`   passive-interface ${loopback}`] : []),
          '   log-adjacency-changes detail',
          ...(v3 ? [] : ['   max-lsa 12000']),
          '!',
          ...(loopback ? [`interface ${loopback}`, ...joins().map((l) => `   ${l}`), '!'] : []),
          ...ifaces.flatMap((iface) => [
            `interface ${iface}`,
            ...(p2p ? [`   ${af} ospf network point-to-point`] : []),
            ...joins().map((l) => `   ${l}`),
            ...(auth ? ['   ip ospf authentication message-digest', `   ip ospf message-digest-key 1 md5 ${SECRET}`] : []),
            ...(bfd ? [`   ${af} ospf neighbor bfd`] : []),
            '!',
          ]),
        ]),
        verify: [...confirm(session), v3 ? 'show ipv6 ospf neighbor' : 'show ip ospf neighbor', v3 ? 'show ipv6 ospf interface' : 'show ip ospf interface brief', v3 ? 'show ipv6 route ospf' : 'show ip route ospf', ...(bfd ? ['show bfd peers'] : [])],
        backout: rollback(`${session}-rollback`, [
          ...ifaces.flatMap((iface) => [
            `interface ${iface}`,
            ...(v3 ? [`   no ipv6 ospf ${proc} area ${area}`] : [`   no ip ospf area ${area}`]),
            ...(p2p ? [`   no ${af} ospf network point-to-point`] : []),
            ...(auth ? ['   no ip ospf authentication', '   no ip ospf message-digest-key 1'] : []),
            ...(bfd ? [`   no ${af} ospf neighbor bfd`] : []),
            '!',
          ]),
          ...(loopback ? [`interface ${loopback}`, v3 ? `   no ipv6 ospf ${proc} area ${area}` : `   no ip ospf area ${area}`, '!'] : []),
          `no ${v3 ? 'ipv6 router ospf' : 'router ospf'} ${proc}`,
        ]),
        findings,
      };
    },
  }),

  /* ------------------------------------------------------------------ IS-IS */
  deviceBlueprint({
    id: 'eos_isis',
    platform: PLATFORM,
    label: 'IS-IS',
    group: 'Routing',
    description: 'IS-IS as the underlay: the IPv4 address family, point-to-point links, a passive loopback, MD5 on the interfaces and an overload bit on startup.',
    inputs: [
      { id: 'instance', label: 'Instance', control: 'text', default: 'UNDERLAY' },
      { id: 'net', label: 'NET', control: 'text', default: '49.0001.0100.0000.0001.00' },
      { id: 'level', label: 'Level', control: 'select', default: 'level-2', options: [
        { value: 'level-2', label: 'Level 2 only' },
        { value: 'level-1', label: 'Level 1 only' },
        { value: 'level-1-2', label: 'Level 1 and 2 (the EOS default)' },
      ] },
      { id: 'interfaces', label: 'Fabric interfaces', control: 'text', default: 'Ethernet1, Ethernet2' },
      { id: 'loopback', label: 'Loopback', control: 'text', default: 'Loopback0' },
      { id: 'point_to_point', label: 'Point-to-point links', control: 'toggle', default: true },
      { id: 'auth', label: 'MD5 authentication', control: 'toggle', default: true },
      { id: 'bfd', label: 'BFD on all IS-IS interfaces', control: 'toggle', default: false },
    ],
    change: (values                 )               => {
      const inst = str(values, 'instance', 'UNDERLAY');
      const net = str(values, 'net', '');
      const level = str(values, 'level', 'level-2');
      const ifaces = listOf(str(values, 'interfaces', ''));
      const loopback = str(values, 'loopback', 'Loopback0');
      const p2p = bool(values, 'point_to_point', true);
      const auth = bool(values, 'auth', true);
      const bfd = bool(values, 'bfd', false);
      const findings            = [];
      if (!isNet(net)) findings.push(error('network.eos.isis-bad-net', `"${net}" is not a NET: an area, a six-byte system id and the selector 00.`, SOURCE));
      if (ifaces.length === 0) findings.push(error('network.eos.isis-no-interfaces', 'No fabric interface was named.', SOURCE));
      if (level === 'level-1-2') findings.push(warning('network.eos.isis-l1l2', 'Level 1-2 keeps two databases and two adjacencies per link. A single-area underlay wants level 2 only.', SOURCE));
      if (!auth) findings.push(warning('network.eos.isis-no-auth', 'Without authentication, anything on a fabric link can join the underlay.', SOURCE));

      return {
        platform: PLATFORM,
        title: `IS-IS ${inst} (${level})`,
        impact: 'brief',
        notes: [
          'Applied in a configure session with a five-minute commit timer.',
          'EOS advertises wide metrics. An IOS router in the same domain needs metric-style wide, or it ignores these routes.',
          'IS-IS carries nothing until an address family is enabled under the instance; this change enables IPv4 unicast.',
          ...(auth ? [`Replace ${SECRET} with the IS-IS key. Both ends of a link must match.`] : []),
        ],
        before: ['show isis neighbors', 'show isis interface brief', 'show ip route isis', 'show running-config section router isis'],
        config: inSession('isis', [
          'ip routing',
          '!',
          `router isis ${inst}`,
          `   net ${net}`,
          `   is-type ${level}`,
          '   log-adjacency-changes',
          '   set-overload-bit on-startup 300',
          `   passive-interface ${loopback}`,
          '   address-family ipv4 unicast',
          ...(bfd ? ['      bfd all-interfaces'] : []),
          '!',
          `interface ${loopback}`,
          `   isis enable ${inst}`,
          '!',
          ...ifaces.flatMap((iface) => [
            `interface ${iface}`,
            `   isis enable ${inst}`,
            ...(p2p ? ['   isis network point-to-point'] : []),
            ...(auth ? ['   isis authentication mode md5', `   isis authentication key 0 ${SECRET}`] : []),
            '!',
          ]),
        ]),
        verify: [...confirm('isis'), 'show isis neighbors', 'show isis database', 'show ip route isis', 'show isis interface brief', ...(bfd ? ['show bfd peers'] : [])],
        backout: rollback('isis-rollback', [
          ...ifaces.flatMap((iface) => [`interface ${iface}`, '   no isis enable', ...(p2p ? ['   no isis network point-to-point'] : []), ...(auth ? ['   no isis authentication mode', '   no isis authentication key'] : []), '!']),
          `interface ${loopback}`,
          '   no isis enable',
          '!',
          `no router isis ${inst}`,
        ]),
        findings,
      };
    },
  }),

  /* --------------------------------------------------------------- MPLS LDP */
  deviceBlueprint({
    id: 'eos_mpls_ldp',
    platform: PLATFORM,
    label: 'MPLS LDP',
    group: 'Routing',
    description: 'MPLS forwarding and LDP on core links: a loopback router id and transport address, and LDP-IGP synchronisation.',
    inputs: [
      { id: 'interfaces', label: 'Core interfaces', control: 'text', default: 'Ethernet1, Ethernet2' },
      { id: 'router_id', label: 'LDP router id interface', control: 'text', default: 'Loopback0' },
      { id: 'igp_sync', label: 'LDP-IGP synchronisation', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const rid = str(values, 'router_id', 'Loopback0');
      const sync = bool(values, 'igp_sync', true);
      const findings            = [];
      if (ifaces.length === 0) findings.push(error('network.eos.ldp-no-interfaces', 'No interface was named, so LDP discovers nobody.', SOURCE));
      if (!/^loopback/i.test(rid)) findings.push(warning('network.eos.ldp-router-id', `The LDP router id and transport address come from ${rid}. A physical interface changes them when it fails, and every session resets.`, SOURCE));
      if (!sync) findings.push(warning('network.eos.ldp-no-sync', 'Without LDP-IGP synchronisation the IGP uses a link before LDP has labels on it, and labelled traffic is black-holed.', SOURCE));

      return {
        platform: PLATFORM,
        title: `MPLS LDP on ${plural(ifaces.length, 'interface')}`,
        impact: 'brief',
        notes: [
          'Applied in a configure session with a five-minute commit timer.',
          'MPLS needs a platform that forwards it (7280R, 7500R, 7800R and similar). VERIFY with show platform before the window.',
          `The LDP router id and transport address come from ${rid}; the IGP must advertise it as a /32.`,
          'Core links need an MTU that carries a full packet plus the label stack.',
        ],
        before: ['show mpls ldp neighbor', 'show mpls ldp discovery', 'show running-config section mpls'],
        config: inSession('ldp', [
          'mpls ip',
          '!',
          'mpls ldp',
          `   router-id interface ${rid}`,
          `   transport-address interface ${rid}`,
          ...(sync ? ['   igp sync'] : []),
          '   no shutdown',
          '!',
          ...ifaces.flatMap((iface) => [`interface ${iface}`, '   mpls ip', '!']),
        ]),
        verify: [...confirm('ldp'), 'show mpls ldp neighbor', 'show mpls ldp discovery', 'show mpls ldp bindings', 'show mpls lfib route'],
        backout: rollback('ldp-rollback', [...ifaces.flatMap((iface) => [`interface ${iface}`, '   no mpls ip', '!']), 'no mpls ldp', 'no mpls ip']),
        findings,
      };
    },
  }),

  /* ------------------------------------------------------------ EVPN spine */
  deviceBlueprint({
    id: 'eos_evpn_spine',
    platform: PLATFORM,
    label: 'EVPN spine (route server or reflector)',
    group: 'Overlay',
    description: 'The spine side of the EVPN overlay: an eBGP route server that leaves the next hop alone, or an iBGP route reflector with a cluster id.',
    inputs: [
      { id: 'mode', label: 'Design', control: 'select', default: 'route-server', options: [
        { value: 'route-server', label: 'eBGP route server (each leaf its own AS)' },
        { value: 'route-reflector', label: 'iBGP route reflector (one AS)' },
      ] },
      { id: 'asn', label: 'Spine AS', control: 'number', default: 65000, min: 1, max: 4294967295 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.1' },
      { id: 'cluster_id', label: 'Cluster id', control: 'text', default: '10.255.0.100', hint: 'The same on every spine', showWhen: { input: 'mode', equals: ['route-reflector'] } },
      { id: 'leaves', label: 'Leaves', control: 'textarea', default: '10.255.0.11 65101\n10.255.0.12 65102', hint: 'One per line: loopback and AS. The AS is ignored for a route reflector' },
      { id: 'update_source', label: 'Update source', control: 'text', default: 'Loopback0' },
      { id: 'auth', label: 'MD5 on the sessions', control: 'toggle', default: false },
    ],
    change: (values                 )               => {
      const rr = str(values, 'mode', 'route-server') === 'route-reflector';
      const asn = num(values, 'asn', 65000);
      const rid = str(values, 'router_id', '');
      const cluster = rr ? str(values, 'cluster_id', '') : '';
      const auth = bool(values, 'auth', false);
      const leaves = str(values, 'leaves', '')
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p[0])
        .map((p) => ({ address: p[0] ?? '', as: p[1] ?? '' }));
      const findings            = [];
      if (!isIpv4(rid)) findings.push(error('network.eos.bad-router-id', `"${rid}" is not a dotted router id.`, SOURCE));
      if (leaves.length === 0) findings.push(error('network.eos.spine-no-leaves', 'No leaf was named.', SOURCE));
      for (const l of leaves) {
        if (!isIpv4(l.address)) findings.push(error('network.eos.spine-bad-leaf', `"${l.address}" is not an IPv4 loopback.`, SOURCE));
        if (!rr && !/^\d+$/.test(l.as)) findings.push(error('network.eos.spine-leaf-as', `Leaf ${l.address} has no AS number. A route server needs each leaf's AS.`, SOURCE));
        if (!rr && l.as === String(asn)) findings.push(error('network.eos.spine-leaf-same-as', `Leaf ${l.address} is in the spine's own AS ${asn}, which makes it iBGP. Use the route-reflector design for a single AS.`, SOURCE));
      }
      if (rr && !cluster) {
        findings.push(warning('network.eos.rr-no-cluster-id', 'No cluster id, so each spine uses its router id. The spines accept each other\'s reflected routes and every leaf holds duplicate paths.', { remediation: 'Give every spine the same cluster id.', ...SOURCE }));
      } else if (rr && !isClusterId(cluster)) {
        findings.push(error('network.eos.rr-bad-cluster-id', `"${cluster}" is not a cluster id.`, SOURCE));
      }

      return {
        platform: PLATFORM,
        title: `EVPN spine as ${rr ? 'route reflector' : 'route server'} for ${plural(leaves.length, 'leaf')}`.replace('leafs', 'leaves'),
        impact: 'brief',
        notes: [
          'Applied in a configure session with a five-minute commit timer.',
          'EVPN needs the multi-agent routing model: service routing protocols model multi-agent, which only takes effect after a reload. Check show ip route summary | include model before the window.',
          rr
            ? 'Every leaf peers with each spine from its loopback in the same AS. The leaves need no change beyond the peering; the reflector adds the cluster list.'
            : 'The route server keeps the leaf as the next hop (next-hop-unchanged), so VXLAN tunnels run leaf to leaf, not through the spine.',
          'Extended communities carry the route targets and router MAC. Without them the leaves learn nothing usable.',
          ...(auth ? [`Replace ${SECRET} with the session password. The leaves must use the same one.`] : []),
        ],
        before: ['show bgp evpn summary', 'show running-config section router bgp', 'show ip route summary | include model'],
        config: inSession('evpn-spine', [
          `router bgp ${asn}`,
          `   router-id ${rid}`,
          '   no bgp default ipv4-unicast',
          ...(cluster ? [`   bgp cluster-id ${cluster}`] : []),
          '   neighbor EVPN-OVERLAY peer group',
          `   neighbor EVPN-OVERLAY update-source ${str(values, 'update_source', 'Loopback0')}`,
          ...(rr ? [`   neighbor EVPN-OVERLAY remote-as ${asn}`, '   neighbor EVPN-OVERLAY route-reflector-client'] : ['   neighbor EVPN-OVERLAY ebgp-multihop 3', '   neighbor EVPN-OVERLAY next-hop-unchanged']),
          '   neighbor EVPN-OVERLAY send-community extended',
          '   neighbor EVPN-OVERLAY maximum-routes 0',
          ...(auth ? [`   neighbor EVPN-OVERLAY password ${SECRET}`] : []),
          ...leaves.flatMap((l) => [`   neighbor ${l.address} peer group EVPN-OVERLAY`, ...(rr ? [] : [`   neighbor ${l.address} remote-as ${l.as}`])]),
          '   !',
          '   address-family evpn',
          '      neighbor EVPN-OVERLAY activate',
          '!',
        ]),
        verify: [...confirm('evpn-spine'), 'show bgp evpn summary', 'show bgp evpn route-type mac-ip', 'show bgp evpn route-type imet'],
        backout: rollback('evpn-spine-rollback', [`router bgp ${asn}`, ...leaves.map((l) => `   no neighbor ${l.address}`), '   no neighbor EVPN-OVERLAY peer group', ...(cluster ? ['   no bgp cluster-id'] : []), '!']),
        findings,
      };
    },
  }),

  /* ---------------------------------------------------------------- RADIUS */
  deviceBlueprint({
    id: 'eos_aaa_radius',
    platform: PLATFORM,
    label: 'AAA with RADIUS',
    group: 'Baseline',
    description: 'Log in against RADIUS (ISE, NPS, ClearPass) through the management VRF, with a local fallback and accounting.',
    inputs: [
      { id: 'servers', label: 'RADIUS servers', control: 'text', default: '10.0.0.30, 10.0.0.31' },
      { id: 'vrf', label: 'VRF', control: 'text', default: 'MGMT' },
      { id: 'source', label: 'Source interface', control: 'text', default: 'Management1' },
      { id: 'accounting', label: 'Accounting', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const servers = listOf(str(values, 'servers', ''));
      const vrf = str(values, 'vrf', 'MGMT');
      const accounting = bool(values, 'accounting', true);
      const findings            = [];
      if (servers.length === 0) findings.push(error('network.eos.radius-no-servers', 'No RADIUS server was named.', SOURCE));
      for (const s of servers) if (!isIp(s)) findings.push(error('network.eos.radius-bad-server', `"${s}" is not an IP address.`, SOURCE));
      if (servers.length === 1) findings.push(warning('network.eos.radius-one-server', 'One RADIUS server means every login falls back to local accounts when it is down.', SOURCE));

      return {
        platform: PLATFORM,
        title: `AAA with RADIUS (${plural(servers.length, 'server')})`,
        impact: 'none',
        notes: [
          'Applied in a configure session with a five-minute commit timer. Log in from a second session before committing.',
          `Replace every ${SECRET} with the shared secret. The switch must be added to the RADIUS server as a network device first.`,
          'RADIUS returns the privilege level or role at login; it cannot authorise individual commands the way TACACS+ can.',
        ],
        before: ['show aaa', 'show radius', 'show running-config section aaa'],
        config: inSession('radius', [
          ...servers.map((s) => `radius-server host ${s} vrf ${vrf} key 0 ${SECRET}`),
          'radius-server timeout 5',
          'radius-server retransmit 3',
          'radius-server deadtime 5',
          `ip radius vrf ${vrf} source-interface ${str(values, 'source', 'Management1')}`,
          '!',
          'aaa group server radius RADIUS-GROUP',
          ...servers.map((s) => `   server ${s} vrf ${vrf}`),
          '!',
          'aaa authentication login default group RADIUS-GROUP local',
          'aaa authorization exec default group RADIUS-GROUP local',
          ...(accounting ? ['aaa accounting exec default start-stop group RADIUS-GROUP'] : []),
          '!',
        ]),
        verify: [...confirm('radius'), 'show radius', 'show aaa', 'show aaa sessions'],
        backout: rollback('radius-rollback', [
          'no aaa authentication login default',
          'no aaa authorization exec default',
          ...(accounting ? ['no aaa accounting exec default'] : []),
          'no aaa group server radius RADIUS-GROUP',
          ...servers.map((s) => `no radius-server host ${s} vrf ${vrf}`),
        ]),
        findings,
      };
    },
  }),

  /* ----------------------------------------------------------------- Banner */
  deviceBlueprint({
    id: 'eos_banner',
    platform: PLATFORM,
    label: 'Login banner',
    group: 'Baseline',
    description: 'The login or message-of-the-day banner, stating that access is restricted and monitored.',
    inputs: [
      { id: 'kind', label: 'Banner', control: 'select', default: 'login', options: [
        { value: 'login', label: 'Login: before the password prompt' },
        { value: 'motd', label: 'Message of the day: after login' },
      ] },
      { id: 'banner', label: 'Banner text', control: 'textarea', default: 'Authorised access only.\nActivity on this device is monitored and logged.' },
    ],
    change: (values                 )               => {
      const kind = str(values, 'kind', 'login');
      const text = str(values, 'banner', '');
      const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
      const findings            = [];
      if (!text) findings.push(error('network.eos.banner-empty', 'The banner is empty.', SOURCE));
      if (lines.some((l) => l.trim() === 'EOF')) findings.push(error('network.eos.banner-eof', 'A line reading EOF ends the banner early; everything after it would be read as commands.', SOURCE));
      if (lines.some((l) => /^\s*[!#]/.test(l))) findings.push(error('network.eos.banner-comment', 'A banner line starting with ! or # is taken as a comment when the file is pasted or pushed. Reword it.', SOURCE));
      if (/\bwelcome\b/i.test(text)) findings.push(warning('network.eos.banner-welcome', 'A banner that welcomes people reads as an invitation. State that access is restricted instead.', SOURCE));

      return {
        platform: PLATFORM,
        title: `${kind === 'login' ? 'Login' : 'Message-of-the-day'} banner`,
        impact: 'none',
        notes: [
          'Not wrapped in a configure session: the banner is typed literally, so the session indentation would become part of it.',
          'Say nothing about the device: no hostname, model, location or owner.',
        ],
        before: [`show banner ${kind}`],
        config: [`banner ${kind}`, ...lines, 'EOF'],
        verify: [`show banner ${kind}`],
        backout: [`no banner ${kind}`],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------------------- LLDP */
  deviceBlueprint({
    id: 'eos_lldp',
    platform: PLATFORM,
    label: 'LLDP',
    group: 'Operations',
    description: 'LLDP timers, the management address advertised, and LLDP switched off on ports that face another organisation.',
    inputs: [
      { id: 'timer', label: 'Transmit interval (seconds)', control: 'number', default: 30, min: 5, max: 32768 },
      { id: 'hold', label: 'Hold time (seconds)', control: 'number', default: 120, min: 10, max: 65535 },
      { id: 'management', label: 'Management address interface', control: 'text', default: 'Management1' },
      { id: 'disabled', label: 'Ports with LLDP off', control: 'text', default: '', hint: 'Internet or partner hand-offs; blank for none' },
    ],
    change: (values                 )               => {
      const timer = num(values, 'timer', 30);
      const hold = num(values, 'hold', 120);
      const mgmt = str(values, 'management', '');
      const off = listOf(str(values, 'disabled', ''));
      const findings            = [];
      if (hold <= timer) findings.push(error('network.eos.lldp-hold', 'The hold time must be longer than the transmit interval, or neighbours expire between advertisements.', SOURCE));
      else if (hold < timer * 3) findings.push(warning('network.eos.lldp-hold-short', 'A hold time under three intervals drops a neighbour after one or two lost advertisements.', SOURCE));

      return {
        platform: PLATFORM,
        title: `LLDP every ${timer}s, hold ${hold}s${off.length > 0 ? `, off on ${plural(off.length, 'port')}` : ''}`,
        impact: 'none',
        notes: [
          'Applied in a configure session with a five-minute commit timer.',
          'LLDP tells the neighbour the hostname, the port, the platform and the management address. On a port to someone else\'s network, that is information you are giving away.',
          'Phones and access points use LLDP-MED for their VLAN and power. Do not switch it off on access ports.',
        ],
        before: ['show lldp', 'show lldp neighbors'],
        config: inSession('lldp', [
          'lldp run',
          `lldp timer ${timer}`,
          `lldp hold-time ${hold}`,
          ...(mgmt ? [`lldp management-address ${mgmt}`] : []),
          ...off.flatMap((p) => [`interface ${p}`, '   no lldp transmit', '   no lldp receive', '!']),
        ]),
        verify: [...confirm('lldp'), 'show lldp', 'show lldp neighbors detail', 'show lldp local-info'],
        backout: rollback('lldp-rollback', ['no lldp timer', 'no lldp hold-time', ...(mgmt ? ['no lldp management-address'] : []), ...off.flatMap((p) => [`interface ${p}`, '   lldp transmit', '   lldp receive', '!'])]),
        findings,
      };
    },
  }),

  /* ---------------------------------------------------------- Port security */
  deviceBlueprint({
    id: 'eos_port_security',
    platform: PLATFORM,
    label: 'Port security',
    group: 'Security',
    description: 'Limit the MAC addresses an access port will learn, with shutdown or protect on violation and automatic recovery.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Ethernet10, Ethernet11' },
      { id: 'maximum', label: 'Maximum MAC addresses', control: 'number', default: 2, min: 1, max: 1000 },
      { id: 'violation', label: 'On violation', control: 'select', default: 'protect', options: [
        { value: 'protect', label: 'Protect: drop unknown addresses' },
        { value: 'shutdown', label: 'Shutdown: error-disable the port' },
      ] },
      { id: 'recovery', label: 'Error-disable recovery (5 minutes)', control: 'toggle', default: true, showWhen: { input: 'violation', equals: ['shutdown'] } },
    ],
    change: (values                 )               => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const max = num(values, 'maximum', 2);
      const protect = str(values, 'violation', 'protect') === 'protect';
      const recovery = !protect && bool(values, 'recovery', true);
      const findings            = [];
      if (ifaces.length === 0) findings.push(error('network.eos.portsec-no-interfaces', 'No interface was named.', SOURCE));
      if (max < 1) findings.push(error('network.eos.portsec-max', 'The maximum must be at least 1.', SOURCE));
      if (!protect && !recovery) findings.push(warning('network.eos.portsec-no-recovery', 'A port shut by a violation stays down until someone bounces it.', SOURCE));
      if (max === 1) findings.push(info('network.eos.portsec-one', 'A maximum of one breaks a phone with a PC behind it.', SOURCE));

      return {
        platform: PLATFORM,
        title: `Port security on ${plural(ifaces.length, 'interface')} (max ${max}, ${protect ? 'protect' : 'shutdown'})`,
        impact: 'brief',
        notes: [
          'Applied in a configure session with a five-minute commit timer.',
          'For access ports only. On an MLAG member or a trunk, VERIFY support for your platform and release first.',
          'Enabling it flushes the addresses learned on the port; traffic pauses while they are relearned.',
        ],
        before: ['show port-security', ...ifaces.slice(0, 2).map((i) => `show running-config interfaces ${i}`)],
        config: inSession('port-security', [
          ...ifaces.flatMap((iface) => [
            `interface ${iface}`,
            '   switchport port-security',
            `   switchport port-security mac-address maximum ${max}`,
            ...(protect ? ['   switchport port-security violation protect'] : []),
            '!',
          ]),
          ...(recovery ? ['errdisable recovery cause portsec', 'errdisable recovery interval 300'] : []),
        ]),
        verify: [...confirm('port-security'), 'show port-security', 'show port-security mac-address', ...(recovery ? ['show errdisable recovery'] : [])],
        backout: rollback('port-security-rollback', [
          ...ifaces.flatMap((iface) => [`interface ${iface}`, ...(protect ? ['   no switchport port-security violation protect'] : []), '   no switchport port-security mac-address maximum', '   no switchport port-security', '!']),
          ...(recovery ? ['no errdisable recovery cause portsec'] : []),
        ]),
        findings,
      };
    },
  }),

  /* ---------------------------------------------------------- Storm control */
  deviceBlueprint({
    id: 'eos_storm_control',
    platform: PLATFORM,
    label: 'Storm control',
    group: 'Security',
    description: 'Cap broadcast, multicast and unknown-unicast flooding on any port, uplinks and port-channels included, in percent or packets per second.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Ethernet10, Ethernet11' },
      { id: 'units', label: 'Units', control: 'select', default: 'percent', options: [
        { value: 'percent', label: 'Percent of bandwidth' },
        { value: 'pps', label: 'Packets per second' },
      ] },
      { id: 'broadcast', label: 'Broadcast', control: 'number', default: 1, min: 0, hint: '0 for no limit' },
      { id: 'multicast', label: 'Multicast', control: 'number', default: 5, min: 0, hint: '0 for no limit' },
      { id: 'unknown_unicast', label: 'Unknown unicast', control: 'number', default: 0, min: 0, hint: '0 for no limit' },
    ],
    change: (values                 )               => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const pps = str(values, 'units', 'percent') === 'pps';
      const levels = ([['broadcast', 'broadcast'], ['multicast', 'multicast'], ['unknown_unicast', 'unknown-unicast']]         )
        .map(([id, kind]) => ({ kind, level: num(values, id, 0) }))
        .filter((l) => l.level > 0);
      const findings            = [];
      if (ifaces.length === 0) findings.push(error('network.eos.storm-no-interfaces', 'No interface was named.', SOURCE));
      if (levels.length === 0) findings.push(error('network.eos.storm-no-levels', 'Every level is 0, so nothing is limited.', SOURCE));
      if (!pps && levels.some((l) => l.level > 100)) findings.push(error('network.eos.storm-percent', 'A percentage cannot be above 100.', SOURCE));
      for (const l of levels) {
        if (!pps && l.level < 0.5) findings.push(warning('network.eos.storm-too-low', `A ${l.kind} level of ${l.level}% can drop ordinary ARP and DHCP on a busy port.`, SOURCE));
        if (pps && l.level < 100) findings.push(warning('network.eos.storm-too-low', `A ${l.kind} level of ${l.level} packets per second can drop ordinary ARP and DHCP.`, SOURCE));
      }

      return {
        platform: PLATFORM,
        title: `Storm control on ${plural(ifaces.length, 'interface')}`,
        impact: 'none',
        notes: [
          'Applied in a configure session with a five-minute commit timer.',
          'The access-port change already sets broadcast and multicast on the ports it builds. This one is for ports it does not: uplinks, port-channels, server ports, and unknown unicast.',
          'Traffic above the level is dropped for the rest of the one-second interval; the port stays up.',
        ],
        before: ['show storm-control', ...ifaces.slice(0, 2).map((i) => `show running-config interfaces ${i}`)],
        config: inSession('storm-control', ifaces.flatMap((iface) => [`interface ${iface}`, ...levels.map((l) => `   storm-control ${l.kind} level ${pps ? 'pps ' : ''}${l.level}`), '!'])),
        verify: [...confirm('storm-control'), 'show storm-control', ...ifaces.slice(0, 2).map((i) => `show running-config interfaces ${i}`)],
        backout: rollback('storm-control-rollback', ifaces.flatMap((iface) => [`interface ${iface}`, ...levels.map((l) => `   no storm-control ${l.kind}`), '!'])),
        findings,
      };
    },
  }),

  /* ---------------------------------------------------------- Spanning tree */
  deviceBlueprint({
    id: 'eos_spanning_tree',
    platform: PLATFORM,
    label: 'Spanning-tree defaults',
    group: 'Switching',
    description: 'The switch-wide spanning-tree settings: mode, root priority, BPDU guard on edge ports by default and loop guard.',
    inputs: [
      { id: 'mode', label: 'Mode', control: 'select', default: 'mstp', options: [
        { value: 'mstp', label: 'MSTP (the EOS default)' },
        { value: 'rapid-pvst', label: 'Rapid PVST+' },
      ] },
      { id: 'priority', label: 'Bridge priority', control: 'number', default: 4096, min: 0, max: 61440, hint: 'A multiple of 4096' },
      { id: 'vlans', label: 'VLANs', control: 'text', default: '1-4094', showWhen: { input: 'mode', equals: ['rapid-pvst'] } },
      { id: 'bpduguard', label: 'BPDU guard on edge ports by default', control: 'toggle', default: true },
      { id: 'loopguard', label: 'Loop guard by default', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const pvst = str(values, 'mode', 'mstp') === 'rapid-pvst';
      const priority = num(values, 'priority', 4096);
      const vlans = vlanRange(vlanIds(str(values, 'vlans', '1-4094')));
      const bpduguard = bool(values, 'bpduguard', true);
      const loopguard = bool(values, 'loopguard', true);
      const findings            = [];
      if (priority % 4096 !== 0 || priority < 0 || priority > 61440) findings.push(error('network.eos.stp-priority', 'The bridge priority must be a multiple of 4096 between 0 and 61440.', SOURCE));
      if (priority === 0) findings.push(warning('network.eos.stp-priority-zero', 'Priority 0 leaves nothing lower for a replacement root. Use 4096 on the primary root and 8192 on the secondary.', SOURCE));
      if (pvst) findings.push(warning('network.eos.stp-mode-change', 'Changing the mode restarts spanning tree on every VLAN. It must match the rest of the layer 2 domain, and both MLAG peers.', SOURCE));
      if (pvst && !vlans) findings.push(error('network.eos.stp-no-vlans', 'No VLAN was named for the priority.', SOURCE));

      return {
        platform: PLATFORM,
        title: `Spanning tree: ${pvst ? 'rapid-pvst' : 'mstp'}, priority ${priority}`,
        impact: pvst ? 'outage' : 'brief',
        notes: [
          'Applied in a configure session with a five-minute commit timer.',
          'Both MLAG peers act as one bridge and must have the same spanning-tree configuration.',
          'BPDU guard by default applies to ports configured spanning-tree portfast. A port that receives a BPDU is error-disabled.',
        ],
        before: ['show spanning-tree', 'show spanning-tree root', 'show running-config section spanning-tree'],
        config: inSession('stp', [
          `spanning-tree mode ${pvst ? 'rapid-pvst' : 'mstp'}`,
          pvst ? `spanning-tree vlan-id ${vlans} priority ${priority}` : `spanning-tree mst 0 priority ${priority}`,
          ...(bpduguard ? ['spanning-tree edge-port bpduguard default'] : []),
          ...(loopguard ? ['spanning-tree guard loop default'] : []),
        ]),
        verify: [...confirm('stp'), 'show spanning-tree', 'show spanning-tree root', 'show spanning-tree blockedports'],
        backout: rollback('stp-rollback', [
          ...(loopguard ? ['no spanning-tree guard loop default'] : []),
          ...(bpduguard ? ['no spanning-tree edge-port bpduguard default'] : []),
          pvst ? `no spanning-tree vlan-id ${vlans} priority` : 'no spanning-tree mst 0 priority',
          'spanning-tree mode mstp',
        ]),
        findings,
      };
    },
  }),
];
