/**
 * Cisco ASA: dynamic routing, multiple contexts, clustering and EtherChannel.
 *
 * `asa.ts` covers a single firewall with static routes and a failover pair.
 * What it did not cover is the firewall that takes part in routing (OSPF, BGP,
 * EIGRP), the one carved into security contexts, the cluster of several units
 * behind a spanned EtherChannel, and the EtherChannel itself.
 *
 * Same rules as the rest of the ASA kit: every key is `<REQUIRED>`, IPv4 is
 * address and dotted mask, and each change says which mode it needs (routed or
 * transparent, single or multiple context).
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { familyOf } from '../../core/ip.ts';
import { isIpv4, listOf, netmask, parseCidr, parseCidrDual, type DeviceChange } from '../device.ts';

const PLATFORM = 'cisco_asa' as const;
const SECRET = '<REQUIRED>';
const SOURCE = { source: 'ArchToolKit' } as const;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "10.0.0.0/24 0" lines: a network and an optional area. */
function networkLines(text: string): { net: { address: string; prefix: number } | null; raw: string; area: string }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [raw = '', area = '0'] = l.split(/\s+/);
      return { net: parseCidr(raw), raw, area };
    });
}

export const ASA_EXTRA: readonly ChangeBlueprint[] = [
  /* ------------------------------------------------------------------- OSPF */
  deviceBlueprint({
    id: 'asa_ospf',
    platform: PLATFORM,
    label: 'OSPF',
    group: 'Network',
    description: 'OSPFv2 on the firewall: the process, the networks and their areas, MD5 on the interfaces, and optionally a default route or static routes into OSPF.',
    inputs: [
      { id: 'process', label: 'Process id', control: 'number', default: 1, min: 1, max: 65535 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.2' },
      { id: 'networks', label: 'Networks', control: 'textarea', default: '10.20.30.0/24 0\n10.0.254.0/30 0', hint: 'One per line: network/prefix and area' },
      { id: 'auth', label: 'MD5 authentication', control: 'toggle', default: true },
      { id: 'auth_interfaces', label: 'Physical interfaces for MD5', control: 'text', default: 'GigabitEthernet0/1', hint: 'The interfaces facing OSPF neighbours', showWhen: { input: 'auth', equals: ['true'] } },
      { id: 'default_originate', label: 'Originate a default route', control: 'toggle', default: false },
      { id: 'redistribute_static', label: 'Redistribute static routes', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const proc = num(values, 'process', 1);
      const rid = str(values, 'router_id', '');
      const nets = networkLines(str(values, 'networks', ''));
      const auth = bool(values, 'auth', true);
      const authIfaces = auth ? listOf(str(values, 'auth_interfaces', '')) : [];
      const originate = bool(values, 'default_originate', false);
      const redistribute = bool(values, 'redistribute_static', false);
      const areas = [...new Set(nets.map((n) => n.area))];
      const findings: Finding[] = [];
      if (!isIpv4(rid)) findings.push(error('network.asa.ospf-router-id', `"${rid}" is not a dotted router id.`, SOURCE));
      if (nets.length === 0) findings.push(error('network.asa.ospf-no-networks', 'No network was named, so no interface joins OSPF.', SOURCE));
      for (const n of nets) {
        if (!n.net) findings.push(error('network.asa.ospf-bad-network', `"${n.raw}" is not an IPv4 network and prefix. OSPFv2 on the ASA is IPv4 only.`, SOURCE));
        if (!isIpv4(n.area) && !/^\d+$/.test(n.area)) findings.push(error('network.asa.ospf-bad-area', `"${n.area}" is not an area.`, SOURCE));
      }
      if (!auth) findings.push(warning('network.asa.ospf-no-auth', 'Without authentication, anything on these segments can inject routes into the firewall, including a default route that pulls traffic around it.', SOURCE));
      if (auth && authIfaces.length === 0) findings.push(error('network.asa.ospf-no-auth-interfaces', 'MD5 was asked for but no interface was named to carry the key.', SOURCE));
      if (redistribute) findings.push(info('network.asa.ospf-redistribute', 'Every static route is redistributed, including the default route. Filter with a route map if only some should be.', SOURCE));

      return {
        platform: PLATFORM,
        title: `OSPF process ${proc} on ${plural(nets.length, 'network')}`,
        impact: 'brief',
        notes: [
          'Needs routed mode. In multiple-context mode OSPFv2 is supported per context from ASA 9.0.',
          'The ASA runs at most two OSPF processes. Neighbours form over the named networks only; the access list does not need to permit OSPF to the firewall itself.',
          ...(auth ? [`Replace ${SECRET} with the OSPF key. Every router on the segment must use the same key id and key.`] : []),
          'On a failover pair, configure the active unit only. The adjacency re-forms after a failover unless nonstop forwarding (graceful restart) is configured.',
        ],
        before: ['show ospf neighbor', 'show route ospf', 'show running-config router ospf', 'show ospf interface brief'],
        config: [
          `router ospf ${proc}`,
          ` router-id ${rid}`,
          ...nets.filter((n) => n.net).map((n) => ` network ${n.net?.address} ${netmask(n.net?.prefix ?? 32)} area ${n.area}`),
          ...(auth ? areas.map((a) => ` area ${a} authentication message-digest`) : []),
          ' log-adj-changes',
          ...(originate ? [' default-information originate'] : []),
          ...(redistribute ? [' redistribute static subnets'] : []),
          '!',
          ...authIfaces.flatMap((i) => [`interface ${i}`, ` ospf message-digest-key 1 md5 ${SECRET}`, ' ospf authentication message-digest', '!']),
        ],
        verify: ['show ospf neighbor', 'show ospf interface', 'show route ospf', 'show ospf database'],
        backout: [...authIfaces.flatMap((i) => [`interface ${i}`, ' no ospf authentication', ' no ospf message-digest-key 1', '!']), `no router ospf ${proc}`],
        findings,
      };
    },
  }),

  /* -------------------------------------------------------------------- BGP */
  deviceBlueprint({
    id: 'asa_bgp',
    platform: PLATFORM,
    label: 'BGP',
    group: 'Network',
    description: 'BGP on the firewall: the process, neighbours in the IPv4 unicast family with MD5 and a maximum-prefix limit, and the networks it advertises.',
    inputs: [
      { id: 'asn', label: 'Local AS', control: 'number', default: 65001, min: 1, max: 4294967295 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.2' },
      { id: 'neighbors', label: 'Neighbours', control: 'textarea', default: '203.0.113.2 65002', hint: 'One per line: address and AS' },
      { id: 'networks', label: 'Networks to advertise', control: 'textarea', default: '198.51.100.0/24', hint: 'One per line; each must be in the routing table' },
      { id: 'max_prefix', label: 'Maximum prefixes per neighbour', control: 'number', default: 1000, min: 0, hint: '0 for no limit' },
      { id: 'auth', label: 'MD5 on the sessions', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const asn = num(values, 'asn', 65001);
      const rid = str(values, 'router_id', '');
      const neighbors = str(values, 'neighbors', '')
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p[0])
        .map((p) => ({ address: p[0] ?? '', as: p[1] ?? '' }));
      const nets = listOf(str(values, 'networks', '')).map((raw) => ({ raw, net: parseCidr(raw) }));
      const max = num(values, 'max_prefix', 1000);
      const auth = bool(values, 'auth', true);
      const findings: Finding[] = [];
      if (!isIpv4(rid)) findings.push(error('network.asa.bgp-router-id', `"${rid}" is not a dotted router id.`, SOURCE));
      if (neighbors.length === 0) findings.push(error('network.asa.bgp-no-neighbors', 'No neighbour was named.', SOURCE));
      for (const n of neighbors) {
        if (!isIpv4(n.address)) findings.push(error('network.asa.bgp-bad-neighbor', `"${n.address}" is not an IPv4 address. This change writes the IPv4 unicast family only.`, SOURCE));
        if (!/^\d+$/.test(n.as)) findings.push(error('network.asa.bgp-neighbor-as', `Neighbour ${n.address} has no AS number.`, SOURCE));
      }
      for (const n of nets) if (!n.net) findings.push(error('network.asa.bgp-bad-network', `"${n.raw}" is not an IPv4 network and prefix.`, SOURCE));
      if (max === 0) findings.push(warning('network.asa.bgp-no-max-prefix', 'With no maximum-prefix limit, a neighbour that leaks a full table fills the firewall\'s memory.', { remediation: 'Set a limit a little above what the neighbour should send.', ...SOURCE }));
      if (!auth) findings.push(warning('network.asa.bgp-no-auth', 'Without MD5, anyone who can spoof the neighbour address can reset or hijack the session.', SOURCE));
      if (neighbors.some((n) => n.as !== String(asn))) {
        findings.push(info('network.asa.bgp-no-filter', 'No prefix list or route map is written. On an eBGP session, accept only what this firewall should route, with a route map, before this goes live.', SOURCE));
      }

      return {
        platform: PLATFORM,
        title: `BGP AS ${asn} with ${plural(neighbors.length, 'neighbour')}`,
        impact: 'brief',
        notes: [
          'Needs routed mode. In multiple-context mode, BGP runs per context from ASA 9.3; the router bgp AS is set once in the system context.',
          'A network statement advertises a prefix only when exactly that prefix is in the routing table, from a static route, a connected network or OSPF.',
          ...(auth ? [`Replace ${SECRET} with the session password. Setting it resets the session.`] : []),
          'On a failover pair the session re-forms after a failover unless BGP graceful restart is configured on both sides.',
        ],
        before: ['show bgp summary', 'show route bgp', 'show running-config router bgp'],
        config: [
          `router bgp ${asn}`,
          ' bgp log-neighbor-changes',
          ` bgp router-id ${rid}`,
          ' address-family ipv4 unicast',
          ...neighbors.flatMap((n) => [
            `  neighbor ${n.address} remote-as ${n.as}`,
            ...(auth ? [`  neighbor ${n.address} password 0 ${SECRET}`] : []),
            `  neighbor ${n.address} activate`,
            ...(max > 0 ? [`  neighbor ${n.address} maximum-prefix ${max} 90`] : []),
          ]),
          ...nets.filter((n) => n.net).map((n) => `  network ${n.net?.address} mask ${netmask(n.net?.prefix ?? 32)}`),
          ' exit-address-family',
          '!',
        ],
        verify: ['show bgp summary', ...neighbors.slice(0, 2).map((n) => `show bgp neighbors ${n.address} advertised-routes`), 'show route bgp'],
        backout: [
          `router bgp ${asn}`,
          ' address-family ipv4 unicast',
          ...neighbors.map((n) => `  no neighbor ${n.address} remote-as ${n.as}`),
          ...nets.filter((n) => n.net).map((n) => `  no network ${n.net?.address} mask ${netmask(n.net?.prefix ?? 32)}`),
          ' exit-address-family',
          '!',
        ],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------------------ EIGRP */
  deviceBlueprint({
    id: 'asa_eigrp',
    platform: PLATFORM,
    label: 'EIGRP',
    group: 'Network',
    description: 'EIGRP on the firewall: the AS, the networks, passive by default with named interfaces active, MD5 on those interfaces, and an optional stub.',
    inputs: [
      { id: 'as', label: 'EIGRP AS', control: 'number', default: 100, min: 1, max: 65535 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.2' },
      { id: 'networks', label: 'Networks', control: 'textarea', default: '10.20.30.0/24', hint: 'One per line' },
      { id: 'active', label: 'Active interfaces (nameif)', control: 'text', default: 'inside', hint: 'Everything else is passive' },
      { id: 'auth', label: 'MD5 authentication', control: 'toggle', default: true },
      { id: 'auth_interfaces', label: 'Physical interfaces for MD5', control: 'text', default: 'GigabitEthernet0/1', showWhen: { input: 'auth', equals: ['true'] } },
      { id: 'stub', label: 'Stub (advertise connected and summary only)', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const as = num(values, 'as', 100);
      const rid = str(values, 'router_id', '');
      const nets = listOf(str(values, 'networks', '')).map((raw) => ({ raw, net: parseCidr(raw) }));
      const active = listOf(str(values, 'active', ''));
      const auth = bool(values, 'auth', true);
      const authIfaces = auth ? listOf(str(values, 'auth_interfaces', '')) : [];
      const stub = bool(values, 'stub', true);
      const findings: Finding[] = [];
      if (!isIpv4(rid)) findings.push(error('network.asa.eigrp-router-id', `"${rid}" is not a dotted router id.`, SOURCE));
      if (nets.length === 0) findings.push(error('network.asa.eigrp-no-networks', 'No network was named.', SOURCE));
      for (const n of nets) if (!n.net) findings.push(error('network.asa.eigrp-bad-network', `"${n.raw}" is not an IPv4 network and prefix.`, SOURCE));
      if (active.length === 0) findings.push(error('network.asa.eigrp-all-passive', 'Every interface is passive, so no neighbour ever forms.', SOURCE));
      if (!auth) findings.push(warning('network.asa.eigrp-no-auth', 'Without authentication, anything on the segment can become a neighbour and inject routes.', SOURCE));
      if (auth && authIfaces.length === 0) findings.push(error('network.asa.eigrp-no-auth-interfaces', 'MD5 was asked for but no interface was named to carry the key.', SOURCE));

      return {
        platform: PLATFORM,
        title: `EIGRP AS ${as} on ${plural(nets.length, 'network')}`,
        impact: 'brief',
        notes: [
          'Needs routed mode and a single EIGRP process; multiple-context mode supports EIGRP per context from ASA 9.0.',
          'Passive by default keeps EIGRP hellos off the outside and DMZ interfaces while still advertising those networks.',
          ...(auth ? [`Replace ${SECRET} with the EIGRP key. Neighbours must use the same key id and key.`] : []),
          ...(stub ? ['As a stub, the firewall is never used as transit by its neighbours and is not queried when they lose a route.'] : []),
        ],
        before: ['show eigrp neighbors', 'show eigrp topology', 'show route eigrp', 'show running-config router eigrp'],
        config: [
          `router eigrp ${as}`,
          ` eigrp router-id ${rid}`,
          ...nets.filter((n) => n.net).map((n) => ` network ${n.net?.address} ${netmask(n.net?.prefix ?? 32)}`),
          ' no auto-summary',
          ' passive-interface default',
          ...active.map((a) => ` no passive-interface ${a}`),
          ...(stub ? [' eigrp stub connected summary'] : []),
          '!',
          ...authIfaces.flatMap((i) => [`interface ${i}`, ` authentication key eigrp ${as} ${SECRET} key-id 1`, ` authentication mode eigrp ${as} md5`, '!']),
        ],
        verify: ['show eigrp neighbors', 'show eigrp interfaces', 'show eigrp topology', 'show route eigrp'],
        backout: [...authIfaces.flatMap((i) => [`interface ${i}`, ` no authentication mode eigrp ${as} md5`, ` no authentication key eigrp ${as}`, '!']), `no router eigrp ${as}`],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------ Security context */
  deviceBlueprint({
    id: 'asa_context',
    platform: PLATFORM,
    label: 'Security context (multiple-context mode)',
    group: 'Baseline',
    description: 'A security context in the system execution space: the interfaces allocated to it, where its configuration lives, its failover group and resource class.',
    inputs: [
      { id: 'name', label: 'Context name', control: 'text', default: 'TENANT-A' },
      { id: 'context_description', label: 'Description', control: 'text', default: 'Tenant A firewall' },
      { id: 'interfaces', label: 'Allocated interfaces', control: 'text', default: 'GigabitEthernet0/1.100, GigabitEthernet0/2.100', hint: 'Subinterfaces or whole interfaces from the system context' },
      { id: 'config_url', label: 'Configuration URL', control: 'text', default: 'disk0:/TENANT-A.cfg' },
      { id: 'failover_group', label: 'Failover group', control: 'select', default: '0', options: [
        { value: '0', label: 'None (active/standby, or no failover)' },
        { value: '1', label: 'Group 1 (active/active)' },
        { value: '2', label: 'Group 2 (active/active)' },
      ] },
      { id: 'resource_class', label: 'Resource class', control: 'text', default: '', hint: 'An existing class; blank for default' },
      { id: 'convert', label: 'Convert this ASA to multiple-context mode first', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'name', '');
      const ifaces = listOf(str(values, 'interfaces', ''));
      const url = str(values, 'config_url', '');
      const group = str(values, 'failover_group', '0');
      const cls = str(values, 'resource_class', '');
      const convert = bool(values, 'convert', false);
      const findings: Finding[] = [];
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) findings.push(error('network.asa.context-name', `"${name}" is not a usable context name: letters, digits, - and _, up to 32 characters.`, SOURCE));
      if (/^(system|null|admin)$/i.test(name)) findings.push(error('network.asa.context-reserved', `"${name}" is reserved or already exists: system and null are reserved, and admin is created by the conversion.`, SOURCE));
      if (ifaces.length === 0) findings.push(error('network.asa.context-no-interfaces', 'A context with no allocated interface cannot pass traffic.', SOURCE));
      if (!/^(disk\d|flash|ftp|tftp|http|https|smb):/i.test(url)) findings.push(error('network.asa.context-url', `"${url}" is not a configuration URL. Use disk0:/NAME.cfg, or an ftp, tftp, http(s) or smb URL.`, SOURCE));
      if (convert) findings.push(warning('network.asa.context-convert', 'Converting to multiple-context mode reboots the ASA, moves the running configuration into the admin context and cannot be undone without another reboot and a restored configuration.', { remediation: 'Back up the running configuration and do this in a window with console access.', ...SOURCE }));

      return {
        platform: PLATFORM,
        title: `Security context ${name}`,
        impact: convert ? 'outage' : 'none',
        notes: [
          'Entered in the system execution space (changeto system). The context\'s own interfaces, nameifs, rules and NAT are configured inside it (changeto context NAME) afterwards.',
          'If the file at the configuration URL already exists it is loaded as the context\'s configuration; if not, an empty one is created there.',
          'Routing protocols, VPN and some features depend on the release in multiple-context mode. VERIFY the feature list for your version.',
          ...(group !== '0' ? [`Failover group ${group} decides which unit of an active/active pair runs this context.`] : []),
          ...(cls ? [`Resource class ${cls} must already exist (class ${cls} with its limit-resource lines).`] : []),
        ],
        before: ['show mode', 'show context', 'show running-config context', 'dir disk0:'],
        config: [
          ...(convert ? ['mode multiple noconfirm', '! The ASA reloads into multiple-context mode here. When it is back, enter the rest from the system context.'] : []),
          `context ${name}`,
          ` description ${str(values, 'context_description', name)}`,
          ...ifaces.map((i) => ` allocate-interface ${i}`),
          ` config-url ${url}`,
          ...(group !== '0' ? [` join-failover-group ${group}`] : []),
          ...(cls ? [` member ${cls}`] : []),
          '!',
        ],
        verify: ['show context', `show context ${name} detail`, `changeto context ${name}`, 'show interface ip brief', 'changeto system', ...(cls ? ['show resource allocation'] : [])],
        backout: [`no context ${name}`, ...(convert ? ['mode single noconfirm'] : [])],
        findings,
      };
    },
  }),

  /* ---------------------------------------------------------------- Cluster */
  deviceBlueprint({
    id: 'asa_cluster',
    platform: PLATFORM,
    label: 'Clustering (spanned EtherChannel)',
    group: 'Baseline',
    description: 'Bootstrap one unit of an ASA cluster: spanned EtherChannel mode, the cluster control link, the spanned data channel, and the cluster group with its unit name, priority and key.',
    inputs: [
      { id: 'group', label: 'Cluster group name', control: 'text', default: 'FW-CLUSTER' },
      { id: 'unit', label: 'This unit\'s name', control: 'text', default: 'unit-1' },
      { id: 'priority', label: 'Priority', control: 'number', default: 1, min: 1, max: 100, hint: '1 is the most preferred control unit' },
      { id: 'ccl_members', label: 'Cluster control link members', control: 'text', default: 'TenGigabitEthernet0/6, TenGigabitEthernet0/7' },
      { id: 'ccl_channel', label: 'Cluster control link port-channel', control: 'number', default: 48, min: 1, max: 48 },
      { id: 'ccl_address', label: 'This unit\'s CCL address', control: 'text', default: '10.0.250.1/24', hint: 'Unique per unit, same network on every unit' },
      { id: 'data_members', label: 'Spanned data channel members', control: 'text', default: 'TenGigabitEthernet0/8, TenGigabitEthernet0/9' },
      { id: 'data_channel', label: 'Spanned data port-channel', control: 'number', default: 10, min: 1, max: 48 },
      { id: 'key', label: 'Encrypt cluster control traffic (key)', control: 'toggle', default: true },
      { id: 'mtu', label: 'Cluster control link MTU', control: 'number', default: 1600, min: 1400, max: 9198, hint: 'At least 100 bytes above the largest data MTU' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const group = str(values, 'group', '');
      const unit = str(values, 'unit', '');
      const priority = num(values, 'priority', 1);
      const ccl = listOf(str(values, 'ccl_members', ''));
      const cclChannel = num(values, 'ccl_channel', 48);
      const cidr = parseCidrDual(str(values, 'ccl_address', ''));
      const data = listOf(str(values, 'data_members', ''));
      const dataChannel = num(values, 'data_channel', 10);
      const key = bool(values, 'key', true);
      const mtu = num(values, 'mtu', 1600);
      const findings: Finding[] = [];
      if (!group) findings.push(error('network.asa.cluster-no-group', 'The cluster group needs a name, the same on every unit.', SOURCE));
      if (!unit) findings.push(error('network.asa.cluster-no-unit', 'Each unit needs its own local-unit name.', SOURCE));
      if (priority < 1 || priority > 100) findings.push(error('network.asa.cluster-priority', 'The priority is between 1 and 100.', SOURCE));
      if (!cidr || cidr.family !== 4) findings.push(error('network.asa.cluster-ccl-address', 'The cluster control link needs an IPv4 address and prefix, for example 10.0.250.1/24.', SOURCE));
      if (ccl.length === 0) findings.push(error('network.asa.cluster-no-ccl', 'The cluster control link has no member interface.', SOURCE));
      if (ccl.length === 1) findings.push(warning('network.asa.cluster-single-ccl', 'A single-link cluster control link is a single point of failure: when it drops, the unit leaves the cluster.', { remediation: 'Use at least two members, to two switches in a vPC or VSS pair.', ...SOURCE }));
      if (data.length === 0) findings.push(error('network.asa.cluster-no-data', 'The spanned data channel has no member interface.', SOURCE));
      if (cclChannel === dataChannel) findings.push(error('network.asa.cluster-same-channel', 'The cluster control link and the data channel must be different port-channels.', SOURCE));
      if (ccl.some((i) => data.includes(i))) findings.push(error('network.asa.cluster-shared-member', 'An interface cannot be in both the cluster control link and the data channel.', SOURCE));
      if (!key) findings.push(error('network.asa.cluster-no-key', 'A cluster with no key sends its control and state traffic, including VPN session data, across the cluster control link in the clear.', { remediation: 'Set the same key on every unit.', ...SOURCE }));
      if (mtu < 1600) findings.push(warning('network.asa.cluster-mtu', 'The cluster control link carries data packets with a cluster header. An MTU below 1600 fragments forwarded 1500-byte traffic.', SOURCE));

      return {
        platform: PLATFORM,
        title: `Cluster ${group}, unit ${unit} (priority ${priority})`,
        impact: 'outage',
        notes: [
          'Bootstrap the control unit first and wait for it to become control; then each data unit with its own unit name, priority and CCL address, one at a time.',
          'Every unit must be the same model, software version and licence. Data units discard their own configuration and take the control unit\'s when they join.',
          'cluster interface-mode spanned force changes the interface mode without checking for conflicting configuration; clear the data interfaces\' nameif and address first.',
          'The spanned data channel must be a single EtherChannel on the switch side too, across a vPC or VSS pair, with LACP.',
          ...(key ? [`Replace ${SECRET} with the cluster key. It must be the same on every unit.`] : []),
        ],
        before: ['show cluster info', 'show interface ip brief', 'show port-channel summary', 'show version | include Version|Model'],
        config: [
          'cluster interface-mode spanned force',
          '!',
          ...ccl.flatMap((i) => [`interface ${i}`, ` channel-group ${cclChannel} mode on`, ' no shutdown', '!']),
          `interface Port-channel${cclChannel}`,
          ' description Cluster control link',
          '!',
          ...data.flatMap((i) => [`interface ${i}`, ` channel-group ${dataChannel} mode active`, ' no shutdown', '!']),
          `interface Port-channel${dataChannel}`,
          ' port-channel span-cluster',
          ' description Spanned data EtherChannel',
          '!',
          `mtu cluster ${mtu}`,
          '!',
          `cluster group ${group}`,
          ` local-unit ${unit}`,
          ` cluster-interface Port-channel${cclChannel} ip ${cidr?.address ?? SECRET} ${cidr ? netmask(cidr.prefix) : ''}`.trimEnd(),
          ` priority ${priority}`,
          ...(key ? [` key ${SECRET}`] : []),
          ' health-check holdtime 3',
          ' enable noconfirm',
          '!',
        ],
        verify: ['show cluster info', 'show cluster info health', 'show port-channel summary', 'show cluster history', 'show conn count'],
        backout: [`cluster group ${group}`, ' no enable', '!', `no cluster group ${group}`],
        findings,
      };
    },
  }),

  /* ----------------------------------------------------------- EtherChannel */
  deviceBlueprint({
    id: 'asa_etherchannel',
    platform: PLATFORM,
    label: 'EtherChannel interface',
    group: 'Network',
    description: 'Bundle physical interfaces into a port-channel with LACP, and give the port-channel its nameif, security level and address.',
    inputs: [
      { id: 'channel', label: 'Port-channel id', control: 'number', default: 1, min: 1, max: 48 },
      { id: 'members', label: 'Member interfaces', control: 'text', default: 'GigabitEthernet0/2, GigabitEthernet0/3' },
      { id: 'mode', label: 'LACP mode', control: 'select', default: 'active', options: [
        { value: 'active', label: 'Active' },
        { value: 'passive', label: 'Passive' },
        { value: 'on', label: 'On (static, no LACP)' },
      ] },
      { id: 'load_balance', label: 'Load balancing', control: 'select', default: 'src-dst-ip', options: [
        { value: 'src-dst-ip', label: 'Source and destination IP (default)' },
        { value: 'src-dst-ip-port', label: 'Source and destination IP and port' },
      ] },
      { id: 'nameif', label: 'Name (nameif)', control: 'text', default: 'inside' },
      { id: 'security_level', label: 'Security level', control: 'number', default: 100, min: 0, max: 100 },
      { id: 'address', label: 'Address', control: 'text', default: '10.20.30.1/24' },
      { id: 'standby', label: 'Standby address', control: 'text', default: '', hint: 'For a failover pair' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'channel', 1);
      const members = listOf(str(values, 'members', ''));
      const mode = str(values, 'mode', 'active');
      const cidr = parseCidrDual(str(values, 'address', ''));
      const standby = str(values, 'standby', '');
      const nameif = str(values, 'nameif', 'inside');
      const findings: Finding[] = [];
      if (members.length === 0) findings.push(error('network.asa.channel-no-members', 'A port-channel with no members carries nothing.', SOURCE));
      if (members.length > 8) findings.push(warning('network.asa.channel-many', 'Only eight members are active in an ASA EtherChannel; the rest are standby links.', SOURCE));
      if (!cidr) findings.push(error('network.asa.channel-bad-address', 'The address must be IPv4 or IPv6 with a prefix.', SOURCE));
      if (standby && cidr && familyOf(standby) !== cidr.family) findings.push(error('network.asa.channel-bad-standby', 'The standby address must be the same family as the address.', SOURCE));
      if (mode === 'on') findings.push(warning('network.asa.channel-static', 'A static channel cannot tell when the far end is not bundling, and a miswired link blackholes its share of the traffic.', SOURCE));
      const addr = cidr
        ? cidr.family === 4
          ? [` ip address ${cidr.address} ${netmask(cidr.prefix)}${standby ? ` standby ${standby}` : ''}`]
          : [` ipv6 address ${cidr.address}/${cidr.prefix}${standby ? ` standby ${standby}` : ''}`, ' ipv6 enable']
        : [];

      return {
        platform: PLATFORM,
        title: `Port-channel${id} (${nameif}) with ${plural(members.length, 'member')}`,
        impact: 'outage',
        notes: [
          'Members must be the same type and speed, and have no nameif or address of their own. Moving a live interface into the channel drops its traffic until the channel is up.',
          'The switch side must be a matching LACP port-channel. On a failover pair, configure the active unit; the channel replicates.',
        ],
        before: ['show port-channel summary', 'show interface ip brief', ...members.map((m) => `show running-config interface ${m}`)],
        config: [
          ...members.flatMap((m) => [`interface ${m}`, ' no nameif', ' no ip address', ` channel-group ${id} mode ${mode}`, ' no shutdown', '!']),
          `interface Port-channel${id}`,
          ...(str(values, 'load_balance', 'src-dst-ip') !== 'src-dst-ip' ? [` port-channel load-balance ${str(values, 'load_balance', 'src-dst-ip')}`] : []),
          ` nameif ${nameif}`,
          ` security-level ${num(values, 'security_level', 100)}`,
          ...addr,
          '!',
        ],
        verify: ['show port-channel summary', `show port-channel ${id} detail`, 'show lacp neighbor', 'show interface ip brief'],
        backout: [`no interface Port-channel${id}`, ...members.flatMap((m) => [`interface ${m}`, ` no channel-group ${id}`, '!'])],
        findings,
      };
    },
  }),
];
