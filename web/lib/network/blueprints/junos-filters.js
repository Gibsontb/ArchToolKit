/**
 * Junos stateless firewall filters and class of service, and EVPN-VXLAN for
 * the data center (QFX).
 *
 * A Junos firewall filter ends in an implicit `discard`, and a filter on lo0
 * protects the routing engine from everything that reaches it on any
 * interface — which includes the routing protocols and the SSH session doing
 * the change. That is why the lo0 filter names every protocol explicitly and
 * the notes insist on `commit confirmed`.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { isAnyNetwork, isIpv4Address, parseCidrAny } from '../../core/ip.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { listOf, vlanIds,                   } from '../device.js';
import { addressList } from './nxos-eos-dual.js';
import { COMMIT_CONFIRMED, ident, ifl, interfaceFindings, isRdValue, PLATFORM, ports, prefixes, prefixFindings, SECRET, SRC } from './junos-common.js';

const RE_PROTOCOLS = ['bgp', 'ospf', 'bfd', 'vrrp', 'ldp', 'rsvp'];

export const JUNOS_FILTERS                             = [
  deviceBlueprint({
    id: 'junos_protect_re',
    platform: PLATFORM,
    label: 'Protect the routing engine (lo0 filter)',
    group: 'Filters & QoS',
    description: 'An input filter on lo0 that lets management in only from named prefixes, admits the routing protocols from their peers, polices ICMP, and discards and counts the rest — IPv4 and IPv6.',
    inputs: [
      { id: 'mgmt', label: 'Management prefixes', control: 'text', default: '10.0.0.0/24', hint: 'Where SSH, NETCONF and SNMP come from; IPv4 and IPv6' },
      { id: 'protocols', label: 'Routing protocols in use', control: 'checklist', default: 'bgp,ospf,bfd', options: RE_PROTOCOLS.map((p) => ({ value: p, label: p.toUpperCase() })) },
      { id: 'icmp_rate', label: 'ICMP policer', control: 'select', default: '1m', options: [{ value: '500k', label: '500 kb/s' }, { value: '1m', label: '1 Mb/s' }, { value: '5m', label: '5 Mb/s' }] },
      { id: 'inet6', label: 'IPv6 filter too', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const mgmt = prefixes(str(values, 'mgmt', ''));
      const protocols = listOf(str(values, 'protocols', '')).filter((p) => RE_PROTOCOLS.includes(p));
      const has = (p        ) => protocols.includes(p);
      const v6 = bool(values, 'inet6', true);
      const findings            = [...prefixFindings('network.junos.bad-prefix', 'the management prefixes', mgmt.invalid)];
      if (mgmt.v4.length + mgmt.v6.length === 0) {
        findings.push(error('network.junos.protect-re-no-mgmt', 'No management prefixes: this filter would lock every SSH and NETCONF session out, including the one applying it.', SRC));
      }
      if ([...mgmt.v4, ...mgmt.v6].some(isAnyNetwork)) findings.push(warning('network.junos.protect-re-any', 'A management prefix of 0/0 lets anyone reach SSH: the filter protects nothing.', SRC));
      if (v6 && mgmt.v6.length === 0) findings.push(warning('network.junos.protect-re-v6-mgmt', 'The IPv6 filter has no IPv6 management prefix: management over IPv6 will be discarded.', SRC));
      const f = 'set firewall family inet filter PROTECT-RE';
      const f6 = 'set firewall family inet6 filter PROTECT-RE6';
      const term = (base        , name        , lines          ) => lines.map((l) => `${base} term ${name} ${l}`);

      return {
        platform: PLATFORM,
        title: `Protect-RE filter on lo0${v6 ? ' (IPv4 and IPv6)' : ''}`,
        impact: 'brief',
        notes: [
          COMMIT_CONFIRMED,
          'This filter sees everything addressed to the box on every interface. A protocol that is in use and not listed here (DHCP relay, RADIUS replies, TACACS+, IS-IS is not IP and is unaffected) stops at commit. Check `show firewall filter PROTECT-RE` counters after the confirmed commit, before the final one.',
          'BGP peers, NTP and DNS servers are taken from the configuration with apply-path, so the prefix lists follow the configuration as it changes.',
        ],
        findings,
        before: ['show configuration interfaces lo0 | display set', 'show firewall', 'show bgp summary', 'show ospf neighbor', 'show system connections | match ESTABLISHED'],
        config: [
          ...[...mgmt.v4, ...mgmt.v6].map((p) => `set policy-options prefix-list MGMT-NETS ${p}`),
          'set policy-options prefix-list BGP-PEERS apply-path "protocols bgp group <*> neighbor <*>"',
          'set policy-options prefix-list NTP-SERVERS apply-path "system ntp server <*>"',
          'set policy-options prefix-list DNS-SERVERS apply-path "system name-server <*>"',
          `set firewall policer RE-ICMP if-exceeding bandwidth-limit ${str(values, 'icmp_rate', '1m')}`,
          'set firewall policer RE-ICMP if-exceeding burst-size-limit 15k',
          'set firewall policer RE-ICMP then discard',
          ...term(f, 'MGMT', ['from source-prefix-list MGMT-NETS', 'from protocol tcp', 'from destination-port ssh', 'from destination-port 830', 'then accept']),
          ...term(f, 'SNMP', ['from source-prefix-list MGMT-NETS', 'from protocol udp', 'from destination-port snmp', 'then accept']),
          ...(has('bgp') ? term(f, 'BGP', ['from source-prefix-list BGP-PEERS', 'from protocol tcp', 'from port bgp', 'then accept']) : []),
          ...(has('ospf') ? term(f, 'OSPF', ['from protocol ospf', 'then accept']) : []),
          ...(has('bfd') ? term(f, 'BFD', ['from protocol udp', 'from destination-port 3784-3785', 'then accept']) : []),
          ...(has('vrrp') ? term(f, 'VRRP', ['from protocol vrrp', 'then accept']) : []),
          ...(has('ldp') ? term(f, 'LDP', ['from protocol tcp', 'from protocol udp', 'from port ldp', 'then accept']) : []),
          ...(has('rsvp') ? term(f, 'RSVP', ['from protocol rsvp', 'then accept']) : []),
          ...term(f, 'NTP', ['from source-prefix-list NTP-SERVERS', 'from protocol udp', 'from port ntp', 'then accept']),
          ...term(f, 'DNS', ['from source-prefix-list DNS-SERVERS', 'from protocol [ udp tcp ]', 'from source-port domain', 'then accept']),
          ...term(f, 'ICMP', ['from protocol icmp', 'from icmp-type [ echo-request echo-reply unreachable time-exceeded ]', 'then policer RE-ICMP', 'then accept']),
          ...term(f, 'TCP-ESTABLISHED', ['from protocol tcp', 'from tcp-established', 'then accept']),
          ...term(f, 'DISCARD', ['then count RE-DISCARD', 'then syslog', 'then discard']),
          'set interfaces lo0 unit 0 family inet filter input PROTECT-RE',
          ...(v6
            ? [
                ...term(f6, 'MGMT', ['from source-prefix-list MGMT-NETS', 'from next-header tcp', 'from destination-port ssh', 'from destination-port 830', 'then accept']),
                ...(has('bgp') ? term(f6, 'BGP', ['from source-prefix-list BGP-PEERS', 'from next-header tcp', 'from port bgp', 'then accept']) : []),
                ...(has('ospf') ? term(f6, 'OSPF3', ['from next-header ospf', 'then accept']) : []),
                ...(has('bfd') ? term(f6, 'BFD', ['from next-header udp', 'from destination-port 3784-3785', 'then accept']) : []),
                ...(has('vrrp') ? term(f6, 'VRRP', ['from next-header vrrp', 'then accept']) : []),
                ...term(f6, 'ICMP6', ['from next-header icmp6', 'then policer RE-ICMP', 'then accept']),
                ...term(f6, 'TCP-ESTABLISHED', ['from next-header tcp', 'from tcp-established', 'then accept']),
                ...term(f6, 'DISCARD', ['then count RE-DISCARD6', 'then syslog', 'then discard']),
                'set interfaces lo0 unit 0 family inet6 filter input PROTECT-RE6',
              ]
            : []),
        ],
        verify: ['show firewall filter PROTECT-RE', ...(v6 ? ['show firewall filter PROTECT-RE6'] : []), 'show bgp summary', 'show ospf neighbor', 'show log messages | match PFE_FW_SYSLOG'],
        backout: [
          'delete interfaces lo0 unit 0 family inet filter',
          ...(v6 ? ['delete interfaces lo0 unit 0 family inet6 filter', 'delete firewall family inet6 filter PROTECT-RE6'] : []),
          'delete firewall family inet filter PROTECT-RE',
          'delete firewall policer RE-ICMP',
          'delete policy-options prefix-list MGMT-NETS',
          'delete policy-options prefix-list BGP-PEERS',
          'delete policy-options prefix-list NTP-SERVERS',
          'delete policy-options prefix-list DNS-SERVERS',
          'commit',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_firewall_filter',
    platform: PLATFORM,
    label: 'Stateless firewall filter',
    group: 'Filters & QoS',
    description: 'A stateless filter (the Junos access list) for IPv4 or IPv6, term by term, applied in or out on an interface.',
    inputs: [
      { id: 'name', label: 'Filter name', control: 'text', default: 'WEB-IN' },
      { id: 'family', label: 'Family', control: 'select', default: 'inet', options: [{ value: 'inet', label: 'IPv4 (inet)' }, { value: 'inet6', label: 'IPv6 (inet6)' }] },
      {
        id: 'rules',
        label: 'Terms',
        control: 'textarea',
        default: 'accept tcp any 10.20.0.10/32 443\naccept tcp any 10.20.0.10/32 80\naccept icmp any 10.20.0.0/24\ndiscard any any 10.20.0.0/24',
        hint: 'One per line: action (accept, discard, reject) protocol (tcp, udp, icmp, any) source destination [port]',
      },
      { id: 'default_action', label: 'Everything else', control: 'select', default: 'accept', options: [{ value: 'accept', label: 'Accept' }, { value: 'discard', label: 'Discard' }] },
      { id: 'interface', label: 'Apply to interface', control: 'text', default: 'ge-0/0/1.0', hint: 'Empty to create the filter only' },
      { id: 'direction', label: 'Direction', control: 'select', default: 'output', options: [{ value: 'input', label: 'Input' }, { value: 'output', label: 'Output' }] },
    ],
    change: (values                 )               => {
      const name = ident(str(values, 'name', 'FILTER'), 'FILTER');
      const family = str(values, 'family', 'inet');
      const want = family === 'inet6' ? 6 : 4;
      const lines = str(values, 'rules', '')
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean);
      const findings            = [];
      const terms             = [];
      const base = `set firewall family ${family} filter ${name}`;
      const protoKey = family === 'inet6' ? 'next-header' : 'protocol';
      lines.forEach((line, i) => {
        const [action = '', proto = '', src = '', dst = '', port] = line.split(/\s+/);
        const t = `${base} term T${(i + 1) * 10}`;
        if (!['accept', 'discard', 'reject'].includes(action) || !['tcp', 'udp', 'icmp', 'any'].includes(proto) || !src || !dst) {
          findings.push(error('network.junos.bad-term', `"${line}" is not "action protocol source destination [port]".`, SRC));
          return;
        }
        const out           = [];
        for (const [key, value] of [['source-address', src], ['destination-address', dst]]         ) {
          if (value === 'any') continue;
          const c = parseCidrAny(value);
          if (!c) findings.push(error('network.junos.bad-term', `"${value}" in "${line}" is not a prefix or any.`, SRC));
          else if (c.family !== want) findings.push(error('network.junos.term-family', `${value} is IPv${c.family} in an IPv${want} filter.`, SRC));
          else out.push(`${t} from ${key} ${c.network}/${c.prefix}`);
        }
        if (proto !== 'any') out.push(`${t} from ${protoKey} ${proto === 'icmp' && want === 6 ? 'icmp6' : proto}`);
        if (port) {
          if (proto !== 'tcp' && proto !== 'udp') findings.push(error('network.junos.port-without-protocol', `"${line}" names a port without tcp or udp.`, SRC));
          else out.push(`${t} from destination-port ${port}`);
        }
        out.push(`${t} then count T${(i + 1) * 10}`, `${t} then ${action}`);
        terms.push(out);
      });
      if (terms.length === 0) findings.push(error('network.junos.empty-filter', 'The filter has no terms; with the implicit discard it drops everything.', SRC));
      const target = str(values, 'interface', '');
      const direction = str(values, 'direction', 'output');
      const defaultAction = str(values, 'default_action', 'accept');
      const { ifd, unit } = ifl(target);
      if (target) findings.push(...interfaceFindings([target]));
      if (target && defaultAction === 'discard' && direction === 'input') {
        findings.push(warning('network.junos.input-discard', 'An input filter ending in discard also drops routing protocols, ARP-resolved next hops and management arriving on this interface unless a term accepts them.', SRC));
      }

      return {
        platform: PLATFORM,
        title: `Filter ${name} (${family})${target ? ` ${direction} on ${ifd}.${unit}` : ''}`,
        impact: target ? 'brief' : 'none',
        notes: [
          COMMIT_CONFIRMED,
          'Terms are evaluated in order. Every Junos filter ends in an implicit discard; the last term here makes the default explicit either way.',
          'This filter is stateless: return traffic needs its own term (or `tcp-established`) when it is filtered too.',
        ],
        findings,
        before: [`show configuration firewall family ${family} filter ${name} | display set`, ...(target ? [`show interfaces ${ifd}.${unit} extensive | match Filter`] : [])],
        config: [
          `delete firewall family ${family} filter ${name}`,
          ...terms.flat(),
          `${base} term DEFAULT then count DEFAULT`,
          `${base} term DEFAULT then ${defaultAction}`,
          ...(target ? [`set interfaces ${ifd} unit ${unit} family ${family} filter ${direction} ${name}`] : []),
        ],
        verify: [`show firewall filter ${name}`, ...(target ? [`show interfaces ${ifd}.${unit} extensive | match Filter`] : [])],
        backout: [...(target ? [`delete interfaces ${ifd} unit ${unit} family ${family} filter ${direction}`] : []), `delete firewall family ${family} filter ${name}`, 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_cos',
    platform: PLATFORM,
    label: 'Class of service: DSCP trust and schedulers',
    group: 'Filters & QoS',
    description: 'Trust DSCP on the way in, and share each egress port between expedited forwarding (voice), assured forwarding, network control and best effort.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'ge-0/0/0' },
      { id: 'ef', label: 'Expedited forwarding %', control: 'number', default: 20, min: 0, max: 100 },
      { id: 'af', label: 'Assured forwarding %', control: 'number', default: 30, min: 0, max: 100 },
      { id: 'nc', label: 'Network control %', control: 'number', default: 5, min: 0, max: 100 },
      { id: 'trust', label: 'Trust DSCP on these interfaces', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const list = ports(str(values, 'interfaces', ''));
      const ef = num(values, 'ef', 20);
      const af = num(values, 'af', 30);
      const nc = num(values, 'nc', 5);
      const trust = bool(values, 'trust', true);
      const findings            = [...interfaceFindings(list)];
      if (ef + af + nc >= 100) findings.push(error('network.junos.cos-over', `EF, AF and NC take ${ef + af + nc}% and leave nothing for best effort.`, SRC));
      if (ef > 33) findings.push(warning('network.junos.cos-ef-high', `${ef}% strict-high can starve every other queue; voice rarely needs more than a third of a link.`, SRC));
      if (list.length === 0) findings.push(error('network.junos.no-ports', 'No interfaces to apply the scheduler map to.', SRC));
      const c = 'set class-of-service';

      return {
        platform: PLATFORM,
        title: `Class of service on ${list.length} interfaces (EF ${ef}%)`,
        impact: 'brief',
        notes: ['CoS is platform-specific: EX and QFX have fixed queues and name some knobs differently (shaping-rate, `excess-rate`), and SRX needs a license-free but explicit `class-of-service` on the egress interface. Check `show class-of-service forwarding-class` first.'],
        findings,
        before: ['show class-of-service forwarding-class', 'show class-of-service interface ' + (list[0] ?? '')],
        config: [
          `${c} schedulers SCHED-EF transmit-rate percent ${ef}`,
          `${c} schedulers SCHED-EF priority strict-high`,
          `${c} schedulers SCHED-AF transmit-rate percent ${af}`,
          `${c} schedulers SCHED-NC transmit-rate percent ${nc}`,
          `${c} schedulers SCHED-BE transmit-rate remainder`,
          `${c} scheduler-maps SM-EDGE forwarding-class expedited-forwarding scheduler SCHED-EF`,
          `${c} scheduler-maps SM-EDGE forwarding-class assured-forwarding scheduler SCHED-AF`,
          `${c} scheduler-maps SM-EDGE forwarding-class network-control scheduler SCHED-NC`,
          `${c} scheduler-maps SM-EDGE forwarding-class best-effort scheduler SCHED-BE`,
          ...list.flatMap((i) => [`${c} interfaces ${i} scheduler-map SM-EDGE`, ...(trust ? [`${c} interfaces ${i} unit 0 classifiers dscp default`] : [])]),
        ],
        verify: [...list.map((i) => `show class-of-service interface ${i}`), ...list.map((i) => `show interfaces queue ${i}`)],
        backout: [...list.map((i) => `delete class-of-service interfaces ${i}`), 'delete class-of-service scheduler-maps SM-EDGE', 'delete class-of-service schedulers SCHED-EF', 'delete class-of-service schedulers SCHED-AF', 'delete class-of-service schedulers SCHED-NC', 'delete class-of-service schedulers SCHED-BE', 'commit'],
      };
    },
  }),
];

export const JUNOS_DATA_CENTER                             = [
  deviceBlueprint({
    id: 'junos_evpn_vxlan_leaf',
    platform: PLATFORM,
    label: 'EVPN-VXLAN leaf (QFX)',
    group: 'Data center',
    description: 'A QFX leaf in an EVPN-VXLAN fabric: the iBGP EVPN overlay to the spines, the VTEP source, the route distinguisher and target, and VLAN-to-VNI mappings.',
    inputs: [
      { id: 'loopback', label: 'Loopback (VTEP) address', control: 'text', default: '10.255.0.11' },
      { id: 'overlay_as', label: 'Overlay AS', control: 'number', default: 65000, min: 1, max: 4294967295 },
      { id: 'spines', label: 'Spine loopbacks (route reflectors)', control: 'text', default: '10.255.0.1, 10.255.0.2' },
      { id: 'vrf_target', label: 'Route target', control: 'text', default: '65000:9999', hint: 'ASN:n; written as target:65000:9999' },
      { id: 'vnis', label: 'VLAN to VNI', control: 'text', default: '100:10100, 200:10200', hint: 'vlan:vni pairs, comma separated' },
      { id: 'auth', label: 'Authenticate the overlay sessions', control: 'toggle', default: false },
    ],
    change: (values                 )               => {
      const lo = str(values, 'loopback', '');
      const asn = num(values, 'overlay_as', 65000);
      const spines = addressList(str(values, 'spines', ''));
      const rt = str(values, 'vrf_target', '').replace(/^target:/, '');
      const auth = bool(values, 'auth', false);
      const pairs = listOf(str(values, 'vnis', '')).map((p) => {
        const [v = '', n = ''] = p.split(':');
        return { text: p, vlan: vlanIds(v)[0], vni: Number(n) };
      });
      const findings            = [
        ...(isIpv4Address(lo) ? [] : [error('network.junos.bad-loopback', `The loopback "${lo}" is not an IPv4 address.`, SRC)]),
        ...spines.invalid.map((s) => error('network.junos.bad-neighbor', `"${s}" is not an address.`, SRC)),
        ...spines.v6.map((s) => warning('network.junos.evpn-v6-underlay', `${s} is IPv6: an IPv6 VTEP underlay is release-specific on QFX and is not written here.`, SRC)),
        ...(isRdValue(rt) ? [] : [error('network.junos.bad-rt', `"${rt}" is not a route target. Write ASN:number.`, SRC)]),
      ];
      if (spines.v4.length === 0) findings.push(error('network.junos.no-neighbors', 'No spine addresses for the overlay.', SRC));
      const good = pairs.filter((p) => p.vlan !== undefined && Number.isInteger(p.vni) && p.vni >= 1 && p.vni <= 16777214);
      for (const p of pairs) if (!good.includes(p)) findings.push(error('network.junos.bad-vni', `"${p.text}" is not vlan:vni (VNI 1–16777214).`, SRC));
      if (new Set(good.map((p) => p.vni)).size !== good.length) findings.push(error('network.junos.duplicate-vni', 'A VNI is mapped twice.', SRC));
      if (new Set(good.map((p) => p.vlan)).size !== good.length) findings.push(error('network.junos.duplicate-vlan', 'A VLAN is mapped twice.', SRC));
      const g = 'set protocols bgp group OVERLAY';

      return {
        platform: PLATFORM,
        title: `EVPN-VXLAN leaf ${lo} with ${good.length} VNIs`,
        impact: 'brief',
        notes: [
          COMMIT_CONFIRMED,
          'The underlay has to be up first: the loopbacks must be reachable (eBGP or OSPF between leaf and spine) before the overlay sessions come up.',
          `lo0.0 must carry ${lo}/32. Every leaf uses the same route target for a fabric with \`vrf-target\`; per-VNI targets are \`vrf-target auto\` instead.`,
          ...(auth ? [`Replace ${SECRET} with the session key from your vault.`] : []),
        ],
        findings,
        before: ['show bgp summary', 'show evpn database', 'show ethernet-switching vxlan-tunnel-end-point remote', 'show configuration switch-options | display set'],
        config: [
          `set routing-options router-id ${lo}`,
          `set routing-options autonomous-system ${asn}`,
          `${g} type internal`,
          `${g} local-address ${lo}`,
          `${g} family evpn signaling`,
          ...(auth ? [`${g} authentication-key "${SECRET}"`] : []),
          `${g} bfd-liveness-detection minimum-interval 1000`,
          `${g} bfd-liveness-detection multiplier 3`,
          ...spines.v4.map((s) => `${g} neighbor ${s}`),
          'set protocols evpn encapsulation vxlan',
          'set protocols evpn extended-vni-list all',
          'set switch-options vtep-source-interface lo0.0',
          `set switch-options route-distinguisher ${lo}:1`,
          `set switch-options vrf-target target:${rt}`,
          ...good.flatMap((p) => [`set vlans VNI${p.vni} vlan-id ${p.vlan}`, `set vlans VNI${p.vni} vxlan vni ${p.vni}`]),
        ],
        verify: ['show bgp summary', 'show evpn database', 'show ethernet-switching vxlan-tunnel-end-point remote', 'show ethernet-switching vxlan-tunnel-end-point source', 'show route table bgp.evpn.0'],
        backout: [
          ...good.map((p) => `delete vlans VNI${p.vni}`),
          'delete switch-options vtep-source-interface',
          'delete switch-options route-distinguisher',
          'delete switch-options vrf-target',
          'delete protocols evpn',
          'delete protocols bgp group OVERLAY',
          'commit',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_evpn_esi_lag',
    platform: PLATFORM,
    label: 'EVPN multihoming (ESI-LAG)',
    group: 'Data center',
    description: 'An all-active ESI on an ae bundle so a server or switch dual-homes to two EVPN leaves — the EVPN replacement for MC-LAG.',
    inputs: [
      { id: 'ae', label: 'ae interface', control: 'text', default: 'ae0' },
      { id: 'esi', label: 'ESI', control: 'text', default: '00:00:00:00:00:00:01:00:00:01', hint: 'Ten bytes, the same on both leaves, unique per bundle' },
      { id: 'system_id', label: 'LACP system id', control: 'text', default: '00:00:00:01:00:01', hint: 'The same on both leaves' },
      { id: 'vlans', label: 'VLANs', control: 'text', default: '100,200' },
    ],
    change: (values                 )               => {
      const ae = ifl(str(values, 'ae', 'ae0')).ifd;
      const esi = str(values, 'esi', '').toLowerCase();
      const sys = str(values, 'system_id', '').toLowerCase();
      const vlans = vlanIds(str(values, 'vlans', ''));
      const findings            = [];
      if (!/^ae\d+$/.test(ae)) findings.push(error('network.junos.esi-not-ae', `"${ae}" is not an ae interface.`, SRC));
      if (!/^([0-9a-f]{2}:){9}[0-9a-f]{2}$/.test(esi)) findings.push(error('network.junos.bad-esi', `"${esi}" is not a ten-byte ESI (00:00:00:00:00:00:01:00:00:01).`, SRC));
      else if (/^(00:){9}00$|^(ff:){9}ff$/.test(esi)) findings.push(error('network.junos.reserved-esi', 'The all-zero and all-FF ESIs are reserved.', SRC));
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(sys)) findings.push(error('network.junos.bad-system-id', `"${sys}" is not a MAC-format LACP system id.`, SRC));
      if (vlans.length === 0) findings.push(error('network.junos.no-vlans', 'No VLANs on the bundle.', SRC));

      return {
        platform: PLATFORM,
        title: `ESI-LAG ${ae} (${esi})`,
        impact: 'brief',
        notes: ['Apply the same ESI, LACP system id and VLANs on both leaves. The member ports and `chassis aggregated-devices` come from the ae blueprint.', 'Until both leaves have it, the host sees two different LACP partners and bundles only one side.'],
        findings,
        before: [`show interfaces ${ae} terse`, 'show evpn instance extensive | match ESI', 'show lacp interfaces'],
        config: [
          `set interfaces ${ae} esi ${esi}`,
          `set interfaces ${ae} esi all-active`,
          `set interfaces ${ae} aggregated-ether-options lacp active`,
          `set interfaces ${ae} aggregated-ether-options lacp system-id ${sys}`,
          `set interfaces ${ae} unit 0 family ethernet-switching interface-mode trunk`,
          ...vlans.map((v) => `set interfaces ${ae} unit 0 family ethernet-switching vlan members ${v}`),
        ],
        verify: ['show evpn instance extensive', 'show lacp interfaces', `show interfaces ${ae} extensive | match "ESI|Link"`, 'show route table bgp.evpn.0 | match "^[14]:"'],
        backout: [`delete interfaces ${ae} esi`, `delete interfaces ${ae} aggregated-ether-options lacp system-id`, 'commit'],
      };
    },
  }),
];
