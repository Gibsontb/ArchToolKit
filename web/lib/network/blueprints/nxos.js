/**
 * Cisco NX-OS: data-centre switching.
 *
 * NX-OS is not IOS with a different prompt. Features are off until they are
 * enabled by name, VLANs and VRFs are configured differently, and vPC is a
 * whole domain of its own — so these are written for NX-OS rather than
 * translated from the IOS group.
 */

import { bool, num, str,                                           } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { NXOS_EXTRA } from './nxos-extra.js';
import { NXOS_EXTRA_2 } from './nxos-extra2.js';
import { description, listOf, parseCidr, vlanIds, vlanRange,                   } from '../device.js';

const PLATFORM = 'cisco_nxos'         ;
const SECRET = '<REQUIRED>';

const BLUEPRINTS                             = [
  deviceBlueprint({
    id: 'nxos_vlan_svi',
    platform: PLATFORM,
    label: 'VLAN and SVI',
    group: 'Switching',
    description: 'A VLAN with a routed interface, in a VRF, with HSRP where there is a pair. Enables the features it needs.',
    inputs: [
      { id: 'vlan_id', label: 'VLAN id', control: 'number', default: 100, min: 1, max: 4094 },
      { id: 'vlan_name', label: 'VLAN name', control: 'text', default: 'APP-TIER' },
      { id: 'address', label: 'SVI address', control: 'text', default: '10.20.100.2/24' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Leave empty for the default VRF' },
      { id: 'hsrp', label: 'HSRP virtual address', control: 'text', default: '10.20.100.1', hint: 'Empty on a single switch' },
      { id: 'hsrp_priority', label: 'HSRP priority', control: 'number', default: 110, min: 1, max: 255 },
      { id: 'mtu', label: 'MTU', control: 'number', default: 9216, min: 1500, max: 9216, hint: '9216 is the usual data-centre value' },
    ],
    change: (values                 )               => {
      const id = num(values, 'vlan_id', 100);
      const name = str(values, 'vlan_name', 'VLAN').replace(/\s+/g, '_').toUpperCase();
      const cidr = parseCidr(str(values, 'address', ''));
      const vrf = str(values, 'vrf', '');
      const hsrp = str(values, 'hsrp', '');
      const findings            = [];
      if (!cidr) findings.push(error('network.nxos.svi-address', 'The SVI address is not a valid address and prefix.', { remediation: 'Write it as 10.20.100.2/24.', source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `VLAN ${id} (${name}) and its SVI`,
        impact: 'none',
        notes: [
          'NX-OS needs the features enabled before the commands exist. They are included and are safe to run again.',
          ...(hsrp ? ['The partner switch takes the same group with a lower priority.'] : []),
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
          ...(cidr ? [`  ip address ${cidr.address}/${cidr.prefix}`] : []),
          '  no shutdown',
          ...(hsrp
            ? [`  hsrp ${id}`, `    ip ${hsrp}`, `    priority ${num(values, 'hsrp_priority', 110)}`, '    preempt']
            : []),
          '!',
        ],
        verify: [`show vlan id ${id}`, `show ip interface brief${vrf ? ` vrf ${vrf}` : ''} | include Vlan${id}`, ...(hsrp ? [`show hsrp brief`] : [])],
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
    change: (values                 )               => {
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
    change: (values                 )               => {
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
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '10.0.0.10, 10.0.0.11' },
      { id: 'syslog_servers', label: 'Syslog servers', control: 'text', default: '10.0.0.20' },
      { id: 'snmp_user', label: 'SNMPv3 user', control: 'text', default: 'monitor' },
      { id: 'management_acl', label: 'Management source prefix', control: 'text', default: '10.0.0.0/24' },
      { id: 'vrf', label: 'Management VRF', control: 'text', default: 'management' },
    ],
    change: (values                 )               => {
      const vrf = str(values, 'vrf', 'management');
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const syslog = listOf(str(values, 'syslog_servers', ''));
      const mgmt = parseCidr(str(values, 'management_acl', ''));
      const user = str(values, 'snmp_user', 'monitor');
      const findings            = [];
      if (!mgmt) findings.push(warning('network.nxos.no-management-acl', 'No management prefix, so management services answer anything that can reach them.', { source: 'ArchToolKit' }));

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
          ...(mgmt
            ? ['ip access-list ACL-MGMT', `  10 permit ip ${mgmt.address}/${mgmt.prefix} any`, '  20 deny ip any any log', '!', 'line vty', '  access-class ACL-MGMT in', '  exec-timeout 10', '!']
            : []),
          `snmp-server user ${user} network-operator auth sha ${SECRET} priv aes-128 ${SECRET}`,
          'snmp-server enable traps link',
          '!',
        ],
        verify: ['show ntp peer-status', 'show logging server', 'show snmp user', 'show ssh server'],
        backout: [
          ...(mgmt ? ['line vty', '  no access-class ACL-MGMT in', '!', 'no ip access-list ACL-MGMT'] : []),
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
    change: (values                 )               => {
      const tag = str(values, 'process', 'UNDERLAY').toUpperCase();
      const rid = str(values, 'router_id', '10.255.0.11');
      const area = str(values, 'area', '0.0.0.0');
      const links = listOf(str(values, 'fabric_links', ''));
      const bfd = bool(values, 'bfd', true);

      return {
        platform: PLATFORM,
        title: `OSPF underlay ${tag}`,
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
const ALL                             = [...BLUEPRINTS, ...NXOS_EXTRA, ...NXOS_EXTRA_2];

export const NXOS_NETWORK                 = { target: PLATFORM, label: 'Cisco NX-OS', blueprints: ALL };
export const NXOS_CHANGES                             = ALL;
