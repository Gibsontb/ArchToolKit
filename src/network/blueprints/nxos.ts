/**
 * Cisco NX-OS: data-centre switching.
 *
 * NX-OS is not IOS with a different prompt. Features are off until they are
 * enabled by name, VLANs and VRFs are configured differently, and vPC is a
 * whole domain of its own — so these are written for NX-OS rather than
 * translated from the IOS group.
 */

import { bool, num, str, type BlueprintValues, type BlueprintGroup } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { NXOS_EXTRA } from './nxos-extra.ts';
import { NXOS_EXTRA_2 } from './nxos-extra2.ts';
import { NXOS_EXTRA_3 } from './nxos-extra3.ts';
import { description, listOf, parseCidrDual, vlanIds, vlanRange, type DeviceChange } from '../device.ts';
import { dualAddresses, dualCidrs, dualFindings, routerIdFindings } from './nxos-eos-dual.ts';

const PLATFORM = 'cisco_nxos' as const;
const SECRET = '<REQUIRED>';

const BLUEPRINTS: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'nxos_vlan_svi',
    platform: PLATFORM,
    label: 'VLAN and SVI',
    group: 'Switching',
    description: 'A VLAN with a routed interface, in a VRF, with HSRP where there is a pair. Enables the features it needs.',
    inputs: [
      { id: 'vlan_id', label: 'VLAN id', control: 'number', default: 100, min: 1, max: 4094 },
      { id: 'vlan_name', label: 'VLAN name', control: 'text', default: 'APP-TIER' },
      { id: 'address', label: 'SVI address', control: 'text', default: '10.20.100.2/24', hint: 'IPv4, IPv6, or one of each: 10.20.100.2/24, 2001:db8:100::2/64' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Leave empty for the default VRF' },
      { id: 'hsrp', label: 'HSRP virtual address', control: 'text', default: '10.20.100.1', hint: 'Empty on a single switch; one IPv4 and one IPv6 for a dual-stack pair' },
      { id: 'hsrp_priority', label: 'HSRP priority', control: 'number', default: 110, min: 1, max: 255 },
      { id: 'mtu', label: 'MTU', control: 'number', default: 9216, min: 1500, max: 9216, hint: '9216 is the usual data-centre value' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'vlan_id', 100);
      const name = str(values, 'vlan_name', 'VLAN').replace(/\s+/g, '_').toUpperCase();
      const address = dualCidrs(str(values, 'address', ''));
      const vrf = str(values, 'vrf', '');
      const virtual = dualAddresses(str(values, 'hsrp', ''));
      const hsrp = virtual.v4 !== null || virtual.v6 !== null;
      // HSRP version 1 stops at group 255 and has no IPv6; the group here is the VLAN id.
      const version2 = virtual.v6 !== null || (hsrp && id > 255);
      const priority = num(values, 'hsrp_priority', 110);
      const findings: Finding[] = [
        ...dualFindings('network.nxos.svi-address', 'the SVI address', address, '10.20.100.2/24 or 2001:db8:100::2/64'),
        ...dualFindings('network.nxos.hsrp-address', 'the HSRP virtual address', virtual, '10.20.100.1 or 2001:db8:100::1'),
      ];
      if (!address.v4 && !address.v6) findings.push(error('network.nxos.svi-address', 'The SVI address is not a valid address and prefix.', { remediation: 'Write it as 10.20.100.2/24.', source: 'ArchToolKit' }));
      for (const family of [4, 6] as const) {
        const has = family === 4 ? address.v4 : address.v6;
        const wants = family === 4 ? virtual.v4 : virtual.v6;
        if (wants && !has && (address.v4 || address.v6)) {
          findings.push(error('network.nxos.hsrp-family', `The HSRP virtual address ${wants} is IPv${family}, and the SVI has no IPv${family} address for the group to run on.`, { remediation: `Add an IPv${family} address to the SVI, or remove the IPv${family} virtual address.`, source: 'ArchToolKit' }));
        }
      }

      return {
        platform: PLATFORM,
        title: `VLAN ${id} (${name}) and its SVI`,
        impact: 'none',
        notes: [
          'NX-OS needs the features enabled before the commands exist. They are included and are safe to run again.',
          ...(hsrp ? ['The partner switch takes the same group with a lower priority.'] : []),
          ...(version2 ? ['`hsrp version 2` changes the virtual MAC to 0000.0c9f.fxxx. Set it on both peers in the same window, or the pair disagrees about the gateway.'] : []),
          ...(virtual.v6 ? ['VERIFY: the IPv6 group reuses the IPv4 group number with the `ipv6` keyword. Confirm the release in use accepts the same number for both families on one SVI.'] : []),
        ],
        before: [`show vlan id ${id}`, `show run interface Vlan${id}`, 'show feature | include hsrp|interface-vlan'],
        config: [
          'feature interface-vlan',
          ...(hsrp ? ['feature hsrp'] : []),
          '!',
          `vlan ${id}`,
          `  name ${name}`,
          '!',
          `interface Vlan${id}`,
          `  description ${name}`,
          `  mtu ${num(values, 'mtu', 9216)}`,
          ...(vrf ? [`  vrf member ${vrf}`] : []),
          ...(address.v4 ? [`  ip address ${address.v4.text}`] : []),
          ...(address.v6 ? [`  ipv6 address ${address.v6.text}`] : []),
          '  no shutdown',
          ...(version2 ? ['  hsrp version 2'] : []),
          ...(virtual.v4 ? [`  hsrp ${id}`, `    ip ${virtual.v4}`, `    priority ${priority}`, '    preempt'] : []),
          ...(virtual.v6 ? [`  hsrp ${id} ipv6`, `    ip ${virtual.v6}`, `    priority ${priority}`, '    preempt'] : []),
          '!',
        ],
        verify: [
          `show vlan id ${id}`,
          ...(address.v4 || !address.v6 ? [`show ip interface brief${vrf ? ` vrf ${vrf}` : ''} | include Vlan${id}`] : []),
          ...(address.v6 ? [`show ipv6 interface brief${vrf ? ` vrf ${vrf}` : ''} | include Vlan${id}`] : []),
          ...(hsrp ? [`show hsrp brief`] : []),
        ],
        backout: [`no interface Vlan${id}`, `no vlan ${id}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_vpc_member',
    platform: PLATFORM,
    label: 'vPC member port-channel',
    group: 'Switching',
    description: 'A port-channel bound to a vPC id, with its member interfaces — the way a dual-homed server or switch is attached.',
    inputs: [
      { id: 'channel_id', label: 'Port-channel id', control: 'number', default: 101, min: 1, max: 4096 },
      { id: 'vpc_id', label: 'vPC id', control: 'number', default: 101, min: 1, max: 4096, hint: 'Usually the same number as the port-channel' },
      { id: 'members', label: 'Member interfaces', control: 'text', default: 'Ethernet1/1', hint: 'On this switch; the peer gets the same vPC id' },
      { id: 'mode', label: 'Mode', control: 'select', default: 'trunk', options: [{ value: 'trunk', label: 'Trunk' }, { value: 'access', label: 'Access' }] },
      { id: 'allowed', label: 'Allowed VLANs', control: 'text', default: '100,200', showWhen: { input: 'mode', equals: ['trunk'] } },
      { id: 'vlan_id', label: 'Access VLAN', control: 'number', default: 100, min: 1, max: 4094, showWhen: { input: 'mode', equals: ['access'] } },
      { id: 'port_description', label: 'Description', control: 'text', default: 'esx-host-01 vPC' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const po = num(values, 'channel_id', 101);
      const vpc = num(values, 'vpc_id', 101);
      const members = listOf(str(values, 'members', ''));
      const trunk = str(values, 'mode', 'trunk') === 'trunk';
      const allowed = vlanRange(vlanIds(str(values, 'allowed', '')));
      const text = description(str(values, 'port_description', ''), 'vPC member');

      return {
        platform: PLATFORM,
        title: `vPC ${vpc} on port-channel ${po}`,
        impact: 'brief',
        notes: [
          'Both peers need the identical configuration under the same vPC id. A mismatch puts the vPC into a consistency failure and suspends the VLANs.',
          'The vPC domain and peer-link must already exist. This change adds a member, not the domain.',
        ],
        before: ['show vpc brief', `show vpc consistency-parameters vpc ${vpc}`, 'show port-channel summary'],
        config: [
          `interface port-channel${po}`,
          `  description ${text}`,
          ...(trunk ? ['  switchport mode trunk', `  switchport trunk allowed vlan ${allowed}`] : ['  switchport mode access', `  switchport access vlan ${num(values, 'vlan_id', 100)}`]),
          '  spanning-tree port type edge' + (trunk ? ' trunk' : ''),
          `  vpc ${vpc}`,
          '  no shutdown',
          '!',
          ...members.flatMap((port) => [
            `interface ${port}`,
            `  description ${text} member`,
            ...(trunk ? ['  switchport mode trunk', `  switchport trunk allowed vlan ${allowed}`] : ['  switchport mode access', `  switchport access vlan ${num(values, 'vlan_id', 100)}`]),
            `  channel-group ${po} mode active`,
            '  no shutdown',
            '!',
          ]),
        ],
        verify: ['show vpc brief', `show vpc consistency-parameters vpc ${vpc}`, `show port-channel summary | include ${po}`],
        backout: [...members.flatMap((port) => [`interface ${port}`, `  no channel-group ${po}`, '!']), `no interface port-channel${po}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_vrf',
    platform: PLATFORM,
    label: 'VRF',
    group: 'Routing',
    description: 'A VRF with its route distinguisher and route targets, ready for interfaces to be put into it.',
    inputs: [
      { id: 'vrf_name', label: 'VRF name', control: 'text', default: 'PROD' },
      { id: 'rd', label: 'Route distinguisher', control: 'text', default: 'auto', hint: '"auto", or ASN:nn such as 65000:100' },
      { id: 'rt', label: 'Route target', control: 'text', default: '65000:100' },
      { id: 'address_family', label: 'Address families', control: 'select', default: 'ipv4', options: [{ value: 'ipv4', label: 'IPv4 only' }, { value: 'both', label: 'IPv4 and IPv6' }] },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'vrf_name', 'PROD').toUpperCase();
      const rt = str(values, 'rt', '');
      const both = str(values, 'address_family', 'ipv4') === 'both';
      return {
        platform: PLATFORM,
        title: `VRF ${name}`,
        impact: 'none',
        notes: ['Creating the VRF changes nothing on its own. Moving an interface into it drops everything that interface was carrying in the default VRF.'],
        before: ['show vrf', `show vrf ${name} detail`],
        config: [
          'feature bgp',
          '!',
          `vrf context ${name}`,
          `  rd ${str(values, 'rd', 'auto')}`,
          '  address-family ipv4 unicast',
          ...(rt ? [`    route-target import ${rt}`, `    route-target export ${rt}`] : []),
          ...(both ? ['  address-family ipv6 unicast', ...(rt ? [`    route-target import ${rt}`, `    route-target export ${rt}`] : [])] : []),
          '!',
        ],
        verify: [`show vrf ${name} detail`, `show ip route vrf ${name}`],
        backout: [`no vrf context ${name}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_management_baseline',
    platform: PLATFORM,
    label: 'Management baseline',
    group: 'Baseline',
    description: 'NTP, syslog, SNMPv3 and SSH on the management VRF, with an access list in front of them.',
    inputs: [
      { id: 'hostname', label: 'Hostname', control: 'text', default: 'dc-leaf-01' },
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '10.0.0.10, 10.0.0.11', hint: 'IPv4 or IPv6 addresses, or names' },
      { id: 'syslog_servers', label: 'Syslog servers', control: 'text', default: '10.0.0.20', hint: 'IPv4 or IPv6 addresses, or names' },
      { id: 'snmp_user', label: 'SNMPv3 user', control: 'text', default: 'monitor' },
      { id: 'management_acl', label: 'Management source prefixes', control: 'text', default: '10.0.0.0/24', hint: 'IPv4 and IPv6, comma separated: 10.0.0.0/24, 2001:db8:0:100::/64' },
      { id: 'vrf', label: 'Management VRF', control: 'text', default: 'management' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vrf = str(values, 'vrf', 'management');
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const syslog = listOf(str(values, 'syslog_servers', ''));
      const prefixes = listOf(str(values, 'management_acl', '')).map((p) => ({ text: p, cidr: parseCidrDual(p) }));
      const mgmt4 = prefixes.flatMap((p) => (p.cidr?.family === 4 ? [`${p.cidr.address}/${p.cidr.prefix}`] : []));
      const mgmt6 = prefixes.flatMap((p) => (p.cidr?.family === 6 ? [`${p.cidr.network}/${p.cidr.prefix}`] : []));
      const user = str(values, 'snmp_user', 'monitor');
      const findings: Finding[] = prefixes
        .filter((p) => !p.cidr)
        .map((p) => error('network.nxos.bad-management-prefix', `"${p.text}" is not a valid IPv4 or IPv6 prefix.`, { remediation: 'Write it as 10.0.0.0/24 or 2001:db8:0:100::/64.', source: 'ArchToolKit' }));
      if (mgmt4.length === 0 && mgmt6.length === 0) findings.push(warning('network.nxos.no-management-acl', 'No management prefix, so management services answer anything that can reach them.', { source: 'ArchToolKit' }));
      const acl4 = mgmt4.length > 0
        ? ['ip access-list ACL-MGMT', ...mgmt4.map((p, i) => `  ${(i + 1) * 10} permit ip ${p} any`), `  ${(mgmt4.length + 1) * 10} deny ip any any log`, '!']
        : [];
      const acl6 = mgmt6.length > 0
        ? ['ipv6 access-list ACL-MGMT-V6', ...mgmt6.map((p, i) => `  ${(i + 1) * 10} permit ipv6 ${p} any`), `  ${(mgmt6.length + 1) * 10} deny ipv6 any any log`, '!']
        : [];
      const vty = [...(mgmt4.length > 0 ? ['  access-class ACL-MGMT in'] : []), ...(mgmt6.length > 0 ? ['  ipv6 access-class ACL-MGMT-V6 in'] : [])];

      return {
        platform: PLATFORM,
        title: 'Management baseline on the management VRF',
        impact: 'brief',
        notes: [`Replace every ${SECRET} with the real credential from your vault.`, 'The access list applies to the vty lines immediately. Check your own address is inside it.'],
        before: ['show ntp peers', 'show logging server', 'show snmp user', 'show run | section line vty'],
        config: [
          `hostname ${str(values, 'hostname', 'switch')}`,
          'feature ssh',
          'no feature telnet',
          '!',
          ...ntp.map((server) => `ntp server ${server} use-vrf ${vrf}`),
          ...syslog.map((server) => `logging server ${server} 6 use-vrf ${vrf}`),
          'logging timestamp milliseconds',
          '!',
          ...acl4,
          ...acl6,
          ...(vty.length > 0 ? ['line vty', ...vty, '  exec-timeout 10', '!'] : []),
          `snmp-server user ${user} network-operator auth sha ${SECRET} priv aes-128 ${SECRET}`,
          'snmp-server enable traps link',
          '!',
        ],
        verify: ['show ntp peer-status', 'show logging server', 'show snmp user', 'show ssh server'],
        backout: [
          ...(vty.length > 0 ? ['line vty', ...vty.map((line) => `  no ${line.trim()}`), '!'] : []),
          ...(mgmt4.length > 0 ? ['no ip access-list ACL-MGMT'] : []),
          ...(mgmt6.length > 0 ? ['no ipv6 access-list ACL-MGMT-V6'] : []),
          ...ntp.map((server) => `no ntp server ${server} use-vrf ${vrf}`),
          ...syslog.map((server) => `no logging server ${server}`),
          `no snmp-server user ${user}`,
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_ospf_underlay',
    platform: PLATFORM,
    label: 'OSPF underlay',
    group: 'Routing',
    description: 'A point-to-point OSPF underlay: the process, the loopback, and the fabric links as unnumbered point-to-point interfaces.',
    inputs: [
      { id: 'process', label: 'Process tag', control: 'text', default: 'UNDERLAY' },
      { id: 'router_id', label: 'Router id / loopback', control: 'text', default: '10.255.0.11' },
      { id: 'area', label: 'Area', control: 'text', default: '0.0.0.0' },
      { id: 'fabric_links', label: 'Fabric interfaces', control: 'text', default: 'Ethernet1/49, Ethernet1/50' },
      { id: 'bfd', label: 'Enable BFD on the links', control: 'toggle', default: true, hint: 'Sub-second failure detection' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const tag = str(values, 'process', 'UNDERLAY').toUpperCase();
      const rid = str(values, 'router_id', '10.255.0.11');
      const area = str(values, 'area', '0.0.0.0');
      const links = listOf(str(values, 'fabric_links', ''));
      const bfd = bool(values, 'bfd', true);
      // OSPFv2 carries IPv4 only, and the router id doubles as the loopback address here.
      const findings: Finding[] = routerIdFindings('network.nxos.router-id', rid);

      return {
        platform: PLATFORM,
        title: `OSPF underlay ${tag}`,
        findings,
        impact: 'brief',
        notes: [
          'Point-to-point on the fabric links: it skips the designated-router election and converges faster.',
          ...(bfd ? ['BFD needs to be enabled on both ends of every link, or the session never comes up and the neighbour stays on OSPF timers.'] : []),
        ],
        before: ['show ip ospf neighbors', 'show run ospf'],
        config: [
          'feature ospf',
          ...(bfd ? ['feature bfd'] : []),
          '!',
          `router ospf ${tag}`,
          `  router-id ${rid}`,
          '  log-adjacency-changes detail',
          '!',
          'interface loopback0',
          `  ip address ${rid}/32`,
          `  ip router ospf ${tag} area ${area}`,
          '!',
          ...links.flatMap((port) => [
            `interface ${port}`,
            '  description fabric link',
            '  no switchport',
            '  mtu 9216',
            '  ip ospf network point-to-point',
            `  ip router ospf ${tag} area ${area}`,
            ...(bfd ? ['  ip ospf bfd'] : []),
            '  no shutdown',
            '!',
          ]),
        ],
        verify: ['show ip ospf neighbors', 'show ip ospf interface brief', ...(bfd ? ['show bfd neighbors'] : []), 'show ip route ospf'],
        backout: [`no router ospf ${tag}`, ...links.flatMap((port) => [`interface ${port}`, `  no ip router ospf ${tag} area ${area}`, '!'])],
      };
    },
  }),
];

/** The rest — the domain-level and operational changes — live in nxos-extra.ts. */
const ALL: readonly ChangeBlueprint[] = [...BLUEPRINTS, ...NXOS_EXTRA, ...NXOS_EXTRA_2, ...NXOS_EXTRA_3];

export const NXOS_NETWORK: BlueprintGroup = { target: PLATFORM, label: 'Cisco NX-OS', blueprints: ALL };
export const NXOS_CHANGES: readonly ChangeBlueprint[] = ALL;
