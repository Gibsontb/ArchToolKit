/**
 * Junos routing: static routes, OSPF, OSPFv3, BGP, IS-IS, MPLS, routing
 * instances, policy, BFD, VRRP and ECMP.
 *
 * Two Junos habits the findings lean on. First, BGP with no policy accepts
 * everything and advertises every active BGP route — an eBGP group with no
 * export policy re-advertises one provider's table to the other. Second,
 * nothing is load-balanced in the forwarding table until a policy exported
 * to it says `load-balance per-packet` (which, despite the name, is per flow).
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { containsAny, isAnyNetwork, isIpv4Address } from '../../core/ip.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import type { DeviceChange } from '../device.ts';
import { addressList, dualAddresses, dualCidrs, dualFindings } from './nxos-eos-dual.ts';
import { COMMIT_CONFIRMED, dottedArea, ident, ifl, interfaceFindings, isRdValue, logicals, PLATFORM, prefixes, prefixFindings, SECRET, SRC } from './junos-common.ts';

function routerIdFindings(value: string): Finding[] {
  return value && !isIpv4Address(value) ? [error('network.junos.router-id', `The router id "${value}" is not an IPv4 address. Junos needs a dotted router id, even for IPv6-only routing.`, SRC)] : [];
}

function areaFindings(value: string): Finding[] {
  return dottedArea(value) ? [] : [error('network.junos.area', `"${value}" is not an area id. Write 0, 10 or 0.0.0.10.`, SRC)];
}

const BFD_INPUTS = [
  { id: 'bfd_interval', label: 'BFD interval (ms)', control: 'number' as const, default: 300, min: 50, max: 30000 },
  { id: 'bfd_multiplier', label: 'BFD multiplier', control: 'number' as const, default: 3, min: 1, max: 255 },
];

export const JUNOS_ROUTING: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'junos_static_route',
    platform: PLATFORM,
    label: 'Static routes (IPv4 / IPv6)',
    group: 'Routing',
    description: 'Static routes to a next hop, IPv4 into inet.0 and IPv6 into inet6.0, in the global table or a routing instance.',
    inputs: [
      { id: 'prefixes', label: 'Destinations', control: 'text', default: '10.50.0.0/16, 10.60.0.0/16', hint: 'IPv4 and IPv6 prefixes, comma separated' },
      { id: 'next_hop', label: 'Next hop', control: 'text', default: '10.0.12.2', hint: 'One IPv4 and/or one IPv6 address, or "discard"' },
      { id: 'preference', label: 'Preference', control: 'number', default: 0, min: 0, max: 255, hint: '0 for the default (5). Higher than the dynamic route for a floating static' },
      { id: 'instance', label: 'Routing instance', control: 'text', default: '', hint: 'Empty for the global table' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const nets = prefixes(str(values, 'prefixes', ''));
      const hopText = str(values, 'next_hop', '');
      const discard = hopText.toLowerCase() === 'discard';
      const hop = dualAddresses(discard ? '' : hopText);
      const pref = num(values, 'preference', 0);
      const instance = str(values, 'instance', '') ? ident(str(values, 'instance', ''), 'VRF') : '';
      const findings: Finding[] = [...prefixFindings('network.junos.bad-prefix', 'the destinations', nets.invalid), ...(discard ? [] : dualFindings('network.junos.bad-next-hop', 'the next hop', hop, '10.0.12.2 or 2001:db8:12::2'))];
      if (nets.v4.length > 0 && !discard && !hop.v4) findings.push(error('network.junos.next-hop-family', 'There are IPv4 destinations and no IPv4 next hop.', SRC));
      if (nets.v6.length > 0 && !discard && !hop.v6) findings.push(error('network.junos.next-hop-family', 'There are IPv6 destinations and no IPv6 next hop.', SRC));
      if ([...nets.v4, ...nets.v6].some(isAnyNetwork)) findings.push(warning('network.junos.default-route', 'This is a default route: it will attract everything with no better match.', SRC));
      const top = instance ? `set routing-instances ${instance} routing-options` : 'set routing-options';
      const topDel = instance ? `delete routing-instances ${instance} routing-options` : 'delete routing-options';
      const rib6 = instance ? `rib ${instance}.inet6.0 ` : 'rib inet6.0 ';
      const routes = [...nets.v4.map((p) => ({ p, rib: '', nh: hop.v4 })), ...nets.v6.map((p) => ({ p, rib: rib6, nh: hop.v6 }))];

      return {
        platform: PLATFORM,
        title: `Static routes to ${[...nets.v4, ...nets.v6].join(', ')}${instance ? ` in ${instance}` : ''}`,
        impact: 'brief',
        notes: ['A static route with a preference of 5 beats OSPF (10) and BGP (170). Give it a higher preference to have it used only as a backup.'],
        findings,
        before: [...routes.map((r) => `show route ${r.p}${instance ? ` table ${instance}` : ''}`), `show configuration ${instance ? `routing-instances ${instance} ` : ''}routing-options | display set`],
        config: routes.flatMap((r) => [
          `${top} ${r.rib}static route ${r.p} ${discard ? 'discard' : `next-hop ${r.nh ?? '<next-hop>'}`}`,
          ...(pref > 0 ? [`${top} ${r.rib}static route ${r.p} preference ${pref}`] : []),
        ]),
        verify: [...routes.map((r) => `show route ${r.p} exact${instance ? ` table ${instance}` : ''}`), ...(hop.v4 ? [`ping ${hop.v4} count 3${instance ? ` routing-instance ${instance}` : ''}`] : [])],
        backout: [...routes.map((r) => `${topDel} ${r.rib}static route ${r.p}`), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_ospf',
    platform: PLATFORM,
    label: 'OSPF',
    group: 'Routing',
    description: 'OSPFv2 in one area: the router id, the interfaces, point-to-point links, passive interfaces and MD5 authentication.',
    inputs: [
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.1' },
      { id: 'area', label: 'Area', control: 'text', default: '0.0.0.0' },
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'ge-0/0/0.0, ge-0/0/1.0' },
      { id: 'passive', label: 'Passive interfaces', control: 'text', default: 'lo0.0' },
      { id: 'p2p', label: 'Point-to-point links', control: 'toggle', default: true },
      { id: 'auth', label: 'MD5 authentication', control: 'toggle', default: true },
      { id: 'reference_bandwidth', label: 'Reference bandwidth', control: 'select', default: '100g', options: [{ value: '10g', label: '10g' }, { value: '100g', label: '100g' }, { value: '400g', label: '400g' }] },
      { id: 'export', label: 'Export policy', control: 'text', default: '', hint: 'A policy that redistributes into OSPF; empty for none' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const rid = str(values, 'router_id', '');
      const areaText = str(values, 'area', '0');
      const area = dottedArea(areaText) ?? '0.0.0.0';
      const list = logicals(str(values, 'interfaces', ''));
      const passive = logicals(str(values, 'passive', ''));
      const auth = bool(values, 'auth', true);
      const p2p = bool(values, 'p2p', true);
      const exportPolicy = str(values, 'export', '');
      const findings: Finding[] = [...routerIdFindings(rid), ...areaFindings(areaText), ...interfaceFindings([...list, ...passive])];
      if (list.length === 0 && passive.length === 0) findings.push(error('network.junos.ospf-no-interfaces', 'OSPF has no interfaces.', SRC));
      const a = `set protocols ospf area ${area}`;

      return {
        platform: PLATFORM,
        title: `OSPF area ${area} on ${list.length + passive.length} interfaces`,
        impact: 'brief',
        notes: [COMMIT_CONFIRMED, ...(auth ? [`Replace ${SECRET} with the OSPF key from your vault; the neighbour needs the same key id and key, or the adjacency drops.`] : []), 'Both ends must agree on the network type: a p2p link to a broadcast neighbour never gets past ExStart.'],
        findings,
        before: ['show ospf neighbor', 'show ospf interface', 'show route protocol ospf | count'],
        config: [
          ...(rid ? [`set routing-options router-id ${rid}`] : []),
          `set protocols ospf reference-bandwidth ${str(values, 'reference_bandwidth', '100g')}`,
          ...list.flatMap((i) => [...(p2p && !i.startsWith('lo') ? [`${a} interface ${i} interface-type p2p`] : [`${a} interface ${i}`]), ...(auth ? [`${a} interface ${i} authentication md5 1 key "${SECRET}"`] : [])]),
          ...passive.map((i) => `${a} interface ${i} passive`),
          ...(exportPolicy ? [`set protocols ospf export ${ident(exportPolicy, 'OSPF-EXPORT')}`] : []),
        ],
        verify: ['show ospf neighbor', 'show ospf interface', 'show ospf database', 'show route protocol ospf'],
        backout: [...[...list, ...passive].map((i) => `delete protocols ospf area ${area} interface ${i}`), 'delete protocols ospf reference-bandwidth', ...(exportPolicy ? [`delete protocols ospf export ${ident(exportPolicy, 'OSPF-EXPORT')}`] : []), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_ospf3',
    platform: PLATFORM,
    label: 'OSPFv3 (IPv6)',
    group: 'Routing',
    description: 'OSPFv3 for IPv6 in one area, beside or instead of OSPFv2 — the interfaces need `family inet6`.',
    inputs: [
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.1', hint: 'IPv4 dotted, even for IPv6' },
      { id: 'area', label: 'Area', control: 'text', default: '0.0.0.0' },
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'ge-0/0/0.0, ge-0/0/1.0' },
      { id: 'passive', label: 'Passive interfaces', control: 'text', default: 'lo0.0' },
      { id: 'p2p', label: 'Point-to-point links', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const rid = str(values, 'router_id', '');
      const areaText = str(values, 'area', '0');
      const area = dottedArea(areaText) ?? '0.0.0.0';
      const list = logicals(str(values, 'interfaces', ''));
      const passive = logicals(str(values, 'passive', ''));
      const p2p = bool(values, 'p2p', true);
      const findings: Finding[] = [...routerIdFindings(rid), ...areaFindings(areaText), ...interfaceFindings([...list, ...passive])];
      if (!rid) findings.push(warning('network.junos.ospf3-no-router-id', 'With no router id, Junos takes one from an IPv4 address; on an IPv6-only box there is none and OSPFv3 does not start.', SRC));
      if (list.length === 0) findings.push(error('network.junos.ospf-no-interfaces', 'OSPFv3 has no interfaces.', SRC));
      const a = `set protocols ospf3 area ${area}`;

      return {
        platform: PLATFORM,
        title: `OSPFv3 area ${area} on ${list.length + passive.length} interfaces`,
        impact: 'brief',
        notes: ['OSPFv3 authenticates with IPsec (`ipsec-sa`), not a key on the interface; that is not written here.', 'Every interface listed needs `family inet6` (a link-local address is enough).'],
        findings,
        before: ['show ospf3 neighbor', 'show ospf3 interface', 'show route protocol ospf3 table inet6.0 | count'],
        config: [
          ...(rid ? [`set routing-options router-id ${rid}`] : []),
          ...list.map((i) => (p2p && !i.startsWith('lo') ? `${a} interface ${i} interface-type p2p` : `${a} interface ${i}`)),
          ...passive.map((i) => `${a} interface ${i} passive`),
        ],
        verify: ['show ospf3 neighbor', 'show ospf3 interface', 'show route protocol ospf3 table inet6.0'],
        backout: [...[...list, ...passive].map((i) => `delete protocols ospf3 area ${area} interface ${i}`), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_bgp',
    platform: PLATFORM,
    label: 'BGP group (eBGP / iBGP)',
    group: 'Routing',
    description: 'A BGP group with its neighbours, import and export policy, a prefix limit, authentication and BFD — IPv4 and IPv6 neighbours in the same group.',
    inputs: [
      { id: 'group', label: 'Group name', control: 'text', default: 'TRANSIT-A' },
      { id: 'type', label: 'Type', control: 'select', default: 'external', options: [{ value: 'external', label: 'External (eBGP)' }, { value: 'internal', label: 'Internal (iBGP)' }] },
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65001, min: 1, max: 4294967295 },
      { id: 'peer_as', label: 'Peer AS', control: 'number', default: 64511, min: 1, max: 4294967295, showWhen: { input: 'type', equals: ['external'] } },
      { id: 'neighbors', label: 'Neighbours', control: 'text', default: '203.0.113.1', hint: 'IPv4 and IPv6 addresses' },
      { id: 'local_address', label: 'Local address', control: 'text', default: '', hint: 'The loopback for iBGP; empty for the egress interface' },
      { id: 'import', label: 'Import policy', control: 'text', default: 'TRANSIT-IN' },
      { id: 'export', label: 'Export policy', control: 'text', default: 'TRANSIT-OUT' },
      { id: 'prefix_limit', label: 'Prefix limit', control: 'number', default: 1000000, min: 0, hint: '0 for none' },
      { id: 'auth', label: 'TCP MD5 authentication', control: 'toggle', default: true },
      { id: 'bfd', label: 'BFD', control: 'toggle', default: false },
      { id: 'multipath', label: 'Multipath', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const group = ident(str(values, 'group', 'PEERS'), 'PEERS');
      const external = str(values, 'type', 'external') === 'external';
      const localAs = num(values, 'local_as', 65001);
      const peerAs = num(values, 'peer_as', 64511);
      const peers = addressList(str(values, 'neighbors', ''));
      const local = str(values, 'local_address', '');
      const imp = str(values, 'import', '') ? ident(str(values, 'import', ''), 'IMPORT') : '';
      const exp = str(values, 'export', '') ? ident(str(values, 'export', ''), 'EXPORT') : '';
      const limit = num(values, 'prefix_limit', 0);
      const auth = bool(values, 'auth', true);
      const bfd = bool(values, 'bfd', false);
      const findings: Finding[] = peers.invalid.map((p) => error('network.junos.bad-neighbor', `"${p}" is not an address.`, SRC));
      if (peers.v4.length + peers.v6.length === 0) findings.push(error('network.junos.no-neighbors', 'The group has no neighbours.', SRC));
      if (external && peerAs === localAs) findings.push(error('network.junos.ebgp-same-as', 'The peer AS is the local AS: that is iBGP, not eBGP.', SRC));
      if (local && !dualAddresses(local).v4 && !dualAddresses(local).v6) findings.push(error('network.junos.bad-local-address', `The local address "${local}" is not an address.`, SRC));
      if (!external && !local) findings.push(warning('network.junos.ibgp-no-local-address', 'iBGP between loopbacks needs `local-address`; without it the session sources from the egress interface and fails when that link does.', SRC));
      if (limit === 0) {
        findings.push(
          warning('network.junos.no-prefix-limit', 'No prefix limit: a peer that leaks a full table fills the routing table and the forwarding hardware.', {
            remediation: 'Set a prefix limit a little above what the peer should send, with a teardown.',
            ...SRC,
          }),
        );
      }
      if (external && !exp) findings.push(warning('network.junos.no-export-policy', 'An eBGP group with no export policy advertises every active BGP route — this network becomes transit between its peers.', SRC));
      if (external && !imp) findings.push(warning('network.junos.no-import-policy', 'An eBGP group with no import policy accepts everything the peer sends, including your own prefixes and bogons.', SRC));
      if (imp || exp) findings.push(info('network.junos.policy-must-exist', `The policies (${[imp, exp].filter(Boolean).join(', ')}) must exist under policy-options, or the commit fails.`, SRC));
      const g = `set protocols bgp group ${group}`;
      const families = [...(peers.v4.length > 0 ? ['inet'] : []), ...(peers.v6.length > 0 ? ['inet6'] : [])];

      return {
        platform: PLATFORM,
        title: `BGP group ${group} (${external ? `eBGP to AS ${peerAs}` : 'iBGP'})`,
        impact: 'brief',
        notes: [COMMIT_CONFIRMED, ...(auth ? [`Replace ${SECRET} with the session key from your vault. Changing it resets the session.`] : [])],
        findings,
        before: ['show bgp summary', `show configuration protocols bgp group ${group} | display set`, 'show route summary'],
        config: [
          `set routing-options autonomous-system ${localAs}`,
          `${g} type ${external ? 'external' : 'internal'}`,
          ...(external ? [`${g} peer-as ${peerAs}`] : []),
          ...(local ? [`${g} local-address ${local}`] : []),
          `${g} log-updown`,
          ...(imp ? [`${g} import ${imp}`] : []),
          ...(exp ? [`${g} export ${exp}`] : []),
          ...families.flatMap((f) => [`${g} family ${f} unicast`, ...(limit > 0 ? [`${g} family ${f} unicast prefix-limit maximum ${limit}`, `${g} family ${f} unicast prefix-limit teardown 90 idle-timeout 30`] : [])]),
          ...(auth ? [`${g} authentication-key "${SECRET}"`] : []),
          ...(bfd ? [`${g} bfd-liveness-detection minimum-interval 300`, `${g} bfd-liveness-detection multiplier 3`] : []),
          ...(bool(values, 'multipath', false) ? [`${g} multipath`] : []),
          ...[...peers.v4, ...peers.v6].map((n) => `${g} neighbor ${n}`),
        ],
        verify: ['show bgp summary', `show bgp group ${group}`, ...[...peers.v4, ...peers.v6].map((n) => `show route receive-protocol bgp ${n} | count`), ...[...peers.v4, ...peers.v6].map((n) => `show route advertising-protocol bgp ${n}`)],
        backout: [`delete protocols bgp group ${group}`, 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_isis',
    platform: PLATFORM,
    label: 'IS-IS',
    group: 'Routing',
    description: 'IS-IS with a NET on the loopback, `family iso` on each interface, point-to-point links and wide metrics — the usual service-provider IGP.',
    inputs: [
      { id: 'net', label: 'NET', control: 'text', default: '49.0001.0100.0025.5001.00', hint: 'Area, system id (often the loopback address), 00' },
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'xe-0/0/0.0, xe-0/0/1.0' },
      { id: 'level', label: 'Levels', control: 'select', default: 'level-2', options: [{ value: 'level-2', label: 'Level 2 only' }, { value: 'level-1', label: 'Level 1 only' }, { value: 'both', label: 'Level 1 and 2' }] },
      { id: 'p2p', label: 'Point-to-point links', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const net = str(values, 'net', '').toLowerCase();
      const list = logicals(str(values, 'interfaces', ''));
      const level = str(values, 'level', 'level-2');
      const p2p = bool(values, 'p2p', true);
      const findings: Finding[] = [...interfaceFindings(list)];
      if (!/^[0-9a-f]{2}(\.[0-9a-f]{4}){3,8}\.00$/.test(net)) findings.push(error('network.junos.bad-net', `"${net}" is not a NET: an area, a six-byte system id and the 00 selector, like 49.0001.0100.0025.5001.00.`, SRC));
      if (list.length === 0) findings.push(error('network.junos.isis-no-interfaces', 'IS-IS has no interfaces.', SRC));

      return {
        platform: PLATFORM,
        title: `IS-IS ${level === 'both' ? 'L1/L2' : level.toUpperCase()} on ${list.length} interfaces`,
        impact: 'brief',
        notes: [COMMIT_CONFIRMED, 'An interface without `family iso` is silently left out of IS-IS. The system id must be unique in the domain.'],
        findings,
        before: ['show isis adjacency', 'show isis interface', 'show configuration protocols isis | display set'],
        config: [
          `set interfaces lo0 unit 0 family iso address ${net}`,
          ...list.map((i) => {
            const { ifd, unit } = ifl(i);
            return `set interfaces ${ifd} unit ${unit} family iso`;
          }),
          ...list.map((i) => (p2p ? `set protocols isis interface ${i} point-to-point` : `set protocols isis interface ${i}`)),
          'set protocols isis interface lo0.0 passive',
          ...(level === 'level-2' ? ['set protocols isis level 1 disable'] : []),
          ...(level === 'level-1' ? ['set protocols isis level 2 disable'] : []),
          ...(level !== 'level-1' ? ['set protocols isis level 2 wide-metrics-only'] : []),
          ...(level !== 'level-2' ? ['set protocols isis level 1 wide-metrics-only'] : []),
        ],
        verify: ['show isis adjacency', 'show isis interface', 'show isis database', 'show route protocol isis'],
        backout: [
          'delete protocols isis',
          ...list.map((i) => {
            const { ifd, unit } = ifl(i);
            return `delete interfaces ${ifd} unit ${unit} family iso`;
          }),
          'delete interfaces lo0 unit 0 family iso',
          'commit',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_mpls',
    platform: PLATFORM,
    label: 'MPLS with LDP or RSVP',
    group: 'Routing',
    description: 'MPLS on core interfaces with LDP, RSVP-TE or both, and optionally an RSVP label-switched path to another PE.',
    inputs: [
      { id: 'interfaces', label: 'Core interfaces', control: 'text', default: 'xe-0/0/0.0, xe-0/0/1.0' },
      { id: 'signaling', label: 'Label distribution', control: 'select', default: 'ldp', options: [{ value: 'ldp', label: 'LDP' }, { value: 'rsvp', label: 'RSVP-TE' }, { value: 'both', label: 'LDP and RSVP-TE' }] },
      { id: 'igp', label: 'IGP', control: 'select', default: 'isis', options: [{ value: 'isis', label: 'IS-IS' }, { value: 'ospf', label: 'OSPF' }] },
      { id: 'lsp_name', label: 'LSP name', control: 'text', default: 'TO-PE2', showWhen: { input: 'signaling', equals: ['rsvp', 'both'] } },
      { id: 'lsp_to', label: 'LSP destination (loopback)', control: 'text', default: '10.255.0.2', showWhen: { input: 'signaling', equals: ['rsvp', 'both'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const list = logicals(str(values, 'interfaces', ''));
      const sig = str(values, 'signaling', 'ldp');
      const ldp = sig === 'ldp' || sig === 'both';
      const rsvp = sig === 'rsvp' || sig === 'both';
      const igp = str(values, 'igp', 'isis');
      const lspName = ident(str(values, 'lsp_name', 'TO-PE2'), 'LSP');
      const lspTo = rsvp ? str(values, 'lsp_to', '') : '';
      const findings: Finding[] = [...interfaceFindings(list)];
      if (list.length === 0) findings.push(error('network.junos.mpls-no-interfaces', 'No core interfaces.', SRC));
      if (lspTo && !isIpv4Address(lspTo)) findings.push(error('network.junos.bad-lsp-to', `The LSP destination "${lspTo}" is not an IPv4 address.`, SRC));

      return {
        platform: PLATFORM,
        title: `MPLS with ${sig === 'both' ? 'LDP and RSVP' : sig.toUpperCase()} on ${list.length} interfaces`,
        impact: 'brief',
        notes: [
          COMMIT_CONFIRMED,
          'An interface needs `family mpls` and to be under `protocols mpls` — either alone does nothing.',
          'MPLS adds 4 bytes per label: raise the core MTU (9192 is usual) before labelled traffic arrives.',
          ...(rsvp && igp === 'ospf' ? ['RSVP-TE with CSPF needs the TE database: `ospf traffic-engineering` is included. IS-IS carries TE by default.'] : []),
        ],
        findings,
        before: ['show mpls interface', ...(ldp ? ['show ldp neighbor'] : []), ...(rsvp ? ['show rsvp neighbor', 'show mpls lsp'] : [])],
        config: [
          ...list.map((i) => {
            const { ifd, unit } = ifl(i);
            return `set interfaces ${ifd} unit ${unit} family mpls`;
          }),
          ...list.map((i) => `set protocols mpls interface ${i}`),
          ...(ldp ? [...list.map((i) => `set protocols ldp interface ${i}`), 'set protocols ldp interface lo0.0'] : []),
          ...(rsvp ? list.map((i) => `set protocols rsvp interface ${i}`) : []),
          ...(rsvp && igp === 'ospf' ? ['set protocols ospf traffic-engineering'] : []),
          ...(lspTo ? [`set protocols mpls label-switched-path ${lspName} to ${lspTo}`] : []),
        ],
        verify: ['show mpls interface', ...(ldp ? ['show ldp neighbor', 'show ldp session', 'show route table inet.3'] : []), ...(rsvp ? ['show rsvp neighbor', 'show mpls lsp'] : [])],
        backout: [
          ...(lspTo ? [`delete protocols mpls label-switched-path ${lspName}`] : []),
          ...(rsvp && igp === 'ospf' ? ['delete protocols ospf traffic-engineering'] : []),
          ...(rsvp ? list.map((i) => `delete protocols rsvp interface ${i}`) : []),
          ...(ldp ? [...list.map((i) => `delete protocols ldp interface ${i}`), 'delete protocols ldp interface lo0.0'] : []),
          ...list.map((i) => `delete protocols mpls interface ${i}`),
          ...list.map((i) => {
            const { ifd, unit } = ifl(i);
            return `delete interfaces ${ifd} unit ${unit} family mpls`;
          }),
          'commit',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_routing_instance',
    platform: PLATFORM,
    label: 'Routing instance (virtual router or VRF)',
    group: 'Routing',
    description: 'A separate routing table: a virtual-router for local segmentation, or an L3VPN VRF with a route distinguisher and route target.',
    inputs: [
      { id: 'name', label: 'Instance name', control: 'text', default: 'CUST-A' },
      { id: 'type', label: 'Type', control: 'select', default: 'vrf', options: [{ value: 'vrf', label: 'VRF (L3VPN)' }, { value: 'virtual-router', label: 'Virtual router' }] },
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'ge-0/0/2.0' },
      { id: 'rd', label: 'Route distinguisher', control: 'text', default: '10.255.0.1:100', showWhen: { input: 'type', equals: ['vrf'] } },
      { id: 'rt', label: 'Route target', control: 'text', default: '65000:100', hint: 'ASN:n; written as target:65000:100', showWhen: { input: 'type', equals: ['vrf'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = ident(str(values, 'name', 'CUST-A'), 'CUST-A');
      const vrf = str(values, 'type', 'vrf') === 'vrf';
      const list = logicals(str(values, 'interfaces', ''));
      const rd = str(values, 'rd', '');
      const rt = str(values, 'rt', '').replace(/^target:/, '');
      const findings: Finding[] = [...interfaceFindings(list)];
      if (vrf && !isRdValue(rd)) findings.push(error('network.junos.bad-rd', `"${rd}" is not a route distinguisher. Write ASN:number or router-id:number.`, SRC));
      if (vrf && !isRdValue(rt)) findings.push(error('network.junos.bad-rt', `"${rt}" is not a route target. Write ASN:number.`, SRC));
      if (list.length === 0) findings.push(warning('network.junos.instance-no-interfaces', 'The instance has no interfaces yet.', SRC));
      const r = `set routing-instances ${name}`;

      return {
        platform: PLATFORM,
        title: `${vrf ? 'VRF' : 'Virtual router'} ${name}`,
        impact: list.length > 0 ? 'brief' : 'none',
        notes: [
          'Moving an interface into the instance moves its routes out of inet.0: anything reaching it through the global table stops.',
          ...(vrf ? ['A VRF needs MP-BGP with `family inet-vpn unicast` between the PEs, and MPLS (LDP or RSVP) in the core.'] : []),
        ],
        findings,
        before: ['show route instance summary', ...list.map((i) => `show interfaces ${i} terse`)],
        config: [
          `${r} instance-type ${vrf ? 'vrf' : 'virtual-router'}`,
          ...list.map((i) => `${r} interface ${i}`),
          ...(vrf ? [`${r} route-distinguisher ${rd}`, `${r} vrf-target target:${rt}`, `${r} vrf-table-label`] : []),
        ],
        verify: [`show route instance ${name} detail`, `show route table ${name}.inet.0`, ...(vrf ? ['show bgp summary | match inet-vpn', `show route table bgp.l3vpn.0 community target:${rt}`] : [])],
        backout: [`delete routing-instances ${name}`, 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_policy',
    platform: PLATFORM,
    label: 'Prefix list and routing policy',
    group: 'Routing',
    description: 'A prefix list and a policy-statement that accepts it (optionally setting local preference or a community) and rejects the rest — for BGP import or export.',
    inputs: [
      { id: 'prefix_list', label: 'Prefix list name', control: 'text', default: 'PL-OWN-PREFIXES' },
      { id: 'prefixes', label: 'Prefixes', control: 'text', default: '198.51.100.0/24, 2001:db8:100::/48' },
      { id: 'match', label: 'Match', control: 'select', default: 'exact', options: [{ value: 'exact', label: 'Exactly these' }, { value: 'orlonger', label: 'These or longer' }, { value: 'longer', label: 'Only longer' }] },
      { id: 'policy', label: 'Policy name', control: 'text', default: 'TRANSIT-OUT' },
      { id: 'local_pref', label: 'Local preference', control: 'number', default: 0, min: 0, max: 4294967295, hint: '0 to leave it' },
      { id: 'community', label: 'Add community', control: 'text', default: '', hint: 'ASN:n; empty for none' },
      { id: 'reject_rest', label: 'Reject everything else', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const pl = ident(str(values, 'prefix_list', 'PL'), 'PL');
      const nets = prefixes(str(values, 'prefixes', ''));
      const policy = ident(str(values, 'policy', 'POLICY'), 'POLICY');
      const match = str(values, 'match', 'exact');
      const lp = num(values, 'local_pref', 0);
      const community = str(values, 'community', '');
      const reject = bool(values, 'reject_rest', true);
      const findings: Finding[] = [...prefixFindings('network.junos.bad-prefix', 'the prefix list', nets.invalid)];
      if (nets.v4.length + nets.v6.length === 0) findings.push(error('network.junos.empty-prefix-list', 'The prefix list is empty; an empty list matches nothing.', SRC));
      if (community && !/^\d+:\d+$/.test(community)) findings.push(error('network.junos.bad-community', `"${community}" is not a community. Write ASN:number.`, SRC));
      if (!reject) findings.push(warning('network.junos.policy-no-final', 'Without a final reject, routes that miss the term fall through to the protocol default — for BGP export, every active BGP route.', SRC));
      const p = `set policy-options policy-statement ${policy}`;
      const cname = `C-${community.replace(':', '-')}`;

      return {
        platform: PLATFORM,
        title: `Policy ${policy} matching ${pl}`,
        impact: 'none',
        notes: ['Nothing uses the policy until it is applied (`import` or `export` on a protocol or group). Check it first with `test policy ' + policy + ' 0.0.0.0/0`.'],
        findings,
        before: [`show configuration policy-options | display set | match "${pl}|${policy}"`],
        config: [
          ...[...nets.v4, ...nets.v6].map((n) => `set policy-options prefix-list ${pl} ${n}`),
          ...(community ? [`set policy-options community ${cname} members ${community}`] : []),
          `${p} term MATCH from prefix-list-filter ${pl} ${match}`,
          ...(lp > 0 ? [`${p} term MATCH then local-preference ${lp}`] : []),
          ...(community ? [`${p} term MATCH then community add ${cname}`] : []),
          `${p} term MATCH then accept`,
          ...(reject ? [`${p} term REJECT then reject`] : []),
        ],
        verify: [`show policy ${policy}`, `test policy ${policy} 0.0.0.0/0`, `show configuration policy-options prefix-list ${pl}`],
        backout: [`delete policy-options policy-statement ${policy}`, `delete policy-options prefix-list ${pl}`, ...(community ? [`delete policy-options community ${cname}`] : []), 'commit  (fails while a protocol still references the policy: remove that first)'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_bfd',
    platform: PLATFORM,
    label: 'BFD for a static route, OSPF or BGP',
    group: 'Routing',
    description: 'Bidirectional forwarding detection on a static route, an OSPF interface or a BGP group, so a dead path is noticed in about a second rather than a hold time.',
    inputs: [
      { id: 'target', label: 'Protect', control: 'select', default: 'bgp', options: [{ value: 'bgp', label: 'A BGP group' }, { value: 'ospf', label: 'An OSPF interface' }, { value: 'static', label: 'A static route' }] },
      { id: 'group', label: 'BGP group', control: 'text', default: 'TRANSIT-A', showWhen: { input: 'target', equals: ['bgp'] } },
      { id: 'area', label: 'OSPF area', control: 'text', default: '0.0.0.0', showWhen: { input: 'target', equals: ['ospf'] } },
      { id: 'interface', label: 'OSPF interface', control: 'text', default: 'ge-0/0/0.0', showWhen: { input: 'target', equals: ['ospf'] } },
      { id: 'prefix', label: 'Static route', control: 'text', default: '0.0.0.0/0', showWhen: { input: 'target', equals: ['static'] } },
      ...BFD_INPUTS,
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const target = str(values, 'target', 'bgp');
      const interval = num(values, 'bfd_interval', 300);
      const mult = num(values, 'bfd_multiplier', 3);
      const findings: Finding[] = [];
      if (interval < 300) findings.push(warning('network.junos.bfd-aggressive', `${interval} ms is below what EX and SRX run reliably in software (300 ms); a busy routing engine flaps the session and the routes with it.`, SRC));
      let base = '';
      let what = '';
      let check: string[] = ['show bfd session'];
      if (target === 'bgp') {
        const group = ident(str(values, 'group', 'PEERS'), 'PEERS');
        base = `protocols bgp group ${group}`;
        what = `BGP group ${group}`;
      } else if (target === 'ospf') {
        const areaText = str(values, 'area', '0');
        const i = logicals(str(values, 'interface', 'ge-0/0/0.0'))[0] ?? 'ge-0/0/0.0';
        findings.push(...areaFindings(areaText), ...interfaceFindings([i]));
        base = `protocols ospf area ${dottedArea(areaText) ?? '0.0.0.0'} interface ${i}`;
        what = `OSPF on ${i}`;
      } else {
        const c = dualCidrs(str(values, 'prefix', ''));
        const net = c.v4 ?? c.v6;
        if (!net) findings.push(error('network.junos.bad-prefix', 'The static route is not a valid prefix.', SRC));
        const p = net ? `${net.network}/${net.prefix}` : '0.0.0.0/0';
        base = `routing-options ${net?.family === 6 ? 'rib inet6.0 ' : ''}static route ${p}`;
        what = `static route ${p}`;
        check = ['show bfd session', `show route ${p} exact`];
      }

      return {
        platform: PLATFORM,
        title: `BFD on ${what}`,
        impact: 'brief',
        notes: ['Both ends need BFD with compatible timers; a session that does not come up does not take the route down, but one that comes up and then flaps does.', `Detection time is ${interval} ms × ${mult} = ${interval * mult} ms.`],
        findings,
        before: ['show bfd session', `show configuration ${base} | display set`],
        config: [`set ${base} bfd-liveness-detection minimum-interval ${interval}`, `set ${base} bfd-liveness-detection multiplier ${mult}`],
        verify: [...check, 'show bfd session detail'],
        backout: [`delete ${base} bfd-liveness-detection`, 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_vrrp',
    platform: PLATFORM,
    label: 'VRRP gateway',
    group: 'Routing',
    description: 'A VRRP group on an interface or IRB — a virtual gateway shared by two routers — with priority, preemption and interface tracking.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'irb.20' },
      { id: 'address', label: 'This router’s address', control: 'text', default: '10.20.0.2/24', hint: 'IPv4 or IPv6 with prefix' },
      { id: 'virtual', label: 'Virtual address', control: 'text', default: '10.20.0.1' },
      { id: 'group', label: 'Group', control: 'number', default: 20, min: 0, max: 255 },
      { id: 'priority', label: 'Priority', control: 'number', default: 110, min: 1, max: 254, hint: 'Higher wins; the other router 100' },
      { id: 'preempt', label: 'Preempt', control: 'toggle', default: true },
      { id: 'track', label: 'Track interface', control: 'text', default: '', hint: 'An uplink whose loss lowers the priority; empty for none' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const { ifd, unit, text } = ifl(str(values, 'interface', 'irb.20'));
      const address = dualCidrs(str(values, 'address', ''));
      const real = address.v4 ?? address.v6;
      const virtual = str(values, 'virtual', '');
      const group = num(values, 'group', 20);
      const priority = num(values, 'priority', 110);
      const track = str(values, 'track', '');
      const findings: Finding[] = [...interfaceFindings([text]), ...dualFindings('network.junos.vrrp-address', 'the address', address, '10.20.0.2/24')];
      if (!real) findings.push(error('network.junos.vrrp-address', 'The interface address is not a valid address and prefix.', SRC));
      if (address.v4 && address.v6) findings.push(warning('network.junos.vrrp-dual', 'One group per family: only the IPv4 address is used. Run this again for IPv6.', SRC));
      if (real && !containsAny(`${real.network}/${real.prefix}`, virtual)) findings.push(error('network.junos.vrrp-subnet', `The virtual address ${virtual} is not in ${real.network}/${real.prefix}.`, SRC));
      if (real && virtual === real.address) findings.push(error('network.junos.vrrp-same', 'The virtual address is this router’s own address. Use a third address in the subnet.', SRC));
      const v6 = real?.family === 6;
      const g = real ? `set interfaces ${ifd} unit ${unit} family ${v6 ? 'inet6' : 'inet'} address ${real.text} ${v6 ? 'vrrp-inet6-group' : 'vrrp-group'} ${group}` : '';

      return {
        platform: PLATFORM,
        title: `VRRP ${group} on ${text} (${virtual})`,
        impact: 'brief',
        notes: [
          'The other router takes the same group and virtual address, a different real address and a lower priority.',
          '`accept-data` lets the master answer ping on the virtual address, which monitoring usually expects.',
          ...(v6 ? ['IPv6 VRRP is VRRPv3 on Junos: `protocols vrrp version-3` is set, and applies to every group on the box.'] : []),
        ],
        findings,
        before: ['show vrrp summary', `show configuration interfaces ${ifd} unit ${unit} | display set`],
        config: real
          ? [
              ...(v6 ? ['set protocols vrrp version-3'] : []),
              `${g} ${v6 ? 'virtual-inet6-address' : 'virtual-address'} ${virtual}`,
              `${g} priority ${priority}`,
              `${g} accept-data`,
              bool(values, 'preempt', true) ? `${g} preempt` : `${g} no-preempt`,
              ...(track ? [`${g} track interface ${ifl(track).ifd} priority-cost 20`] : []),
            ]
          : [`# no valid address given for ${text}`],
        verify: ['show vrrp summary', 'show vrrp detail', `ping ${virtual} count 3`],
        backout: [real ? `delete interfaces ${ifd} unit ${unit} family ${v6 ? 'inet6' : 'inet'} address ${real.text} ${v6 ? 'vrrp-inet6-group' : 'vrrp-group'} ${group}` : '# nothing was configured', 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_ecmp',
    platform: PLATFORM,
    label: 'ECMP load balancing',
    group: 'Routing',
    description: 'Install every equal-cost next hop in the forwarding table — without this policy Junos routes over one path even when several are equal.',
    inputs: [
      { id: 'policy', label: 'Policy name', control: 'text', default: 'ECMP' },
      { id: 'bgp_group', label: 'BGP group to allow multipath on', control: 'text', default: '', hint: 'Empty for none' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const policy = ident(str(values, 'policy', 'ECMP'), 'ECMP');
      const group = str(values, 'bgp_group', '') ? ident(str(values, 'bgp_group', ''), 'PEERS') : '';
      return {
        platform: PLATFORM,
        title: `ECMP in the forwarding table (${policy})`,
        impact: 'brief',
        notes: ['`load-balance per-packet` hashes per flow on every current platform; the name is historical.', 'If the forwarding table already exports a policy, add this one to the list rather than replacing it.'],
        findings: [],
        before: ['show configuration routing-options forwarding-table', 'show route forwarding-table summary'],
        config: [`set policy-options policy-statement ${policy} then load-balance per-packet`, `set routing-options forwarding-table export ${policy}`, ...(group ? [`set protocols bgp group ${group} multipath`] : [])],
        verify: ['show route forwarding-table destination 0.0.0.0/0 extensive | match "ulst|Next-hop"', 'show route forwarding-table summary'],
        backout: [`delete routing-options forwarding-table export ${policy}`, `delete policy-options policy-statement ${policy}`, ...(group ? [`delete protocols bgp group ${group} multipath`] : []), 'commit'],
      };
    },
  }),
];
