/**
 * Arista EOS.
 *
 * Close enough to IOS to read, different enough to get wrong: MLAG rather than
 * vPC or stacking, `spanning-tree portfast` written as `spanning-tree portfast`
 * but edge ports declared per interface, and a configuration session that can
 * be committed with a timer — which is the safest way to change a switch you
 * are reached through, so it is what the verification steps use.
 */

import { bool, num, str, type BlueprintValues, type BlueprintGroup } from '../../kit/blueprint.ts';
import { error, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { EOS_EXTRA } from './eos-extra.ts';
import { EOS_EXTRA_2 } from './eos-extra2.ts';
import { description, listOf, parseCidrDual, vlanIds, vlanRange, type DeviceChange } from '../device.ts';
import { addressList, dualAddresses, dualCidrs, dualFindings, routerIdFindings, unverifiedIpv6 } from './nxos-eos-dual.ts';

const PLATFORM = 'arista_eos' as const;
const SECRET = '<REQUIRED>';

const BLUEPRINTS: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'eos_vlan_svi',
    platform: PLATFORM,
    label: 'VLAN and SVI',
    group: 'Switching',
    description: 'A VLAN with a routed interface, optionally with a VARP virtual address shared across an MLAG pair.',
    inputs: [
      { id: 'vlan_id', label: 'VLAN id', control: 'number', default: 100, min: 1, max: 4094 },
      { id: 'vlan_name', label: 'VLAN name', control: 'text', default: 'APP_TIER' },
      { id: 'address', label: 'SVI address', control: 'text', default: '10.30.100.2/24', hint: 'IPv4, IPv6, or one of each: 10.30.100.2/24, 2001:db8:100::2/64' },
      { id: 'varp', label: 'VARP virtual address', control: 'text', default: '10.30.100.1', hint: 'The same on both MLAG peers; one IPv4 and one IPv6 for dual stack; empty for none' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 9214, min: 1500, max: 9214 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'vlan_id', 100);
      const name = str(values, 'vlan_name', 'VLAN').replace(/\s+/g, '_');
      const address = dualCidrs(str(values, 'address', ''));
      const varp = dualAddresses(str(values, 'varp', ''));
      const findings: Finding[] = [
        ...dualFindings('network.eos.svi-address', 'the SVI address', address, '10.30.100.2/24 or 2001:db8:100::2/64'),
        ...dualFindings('network.eos.varp-address', 'the VARP virtual address', varp, '10.30.100.1 or 2001:db8:100::1'),
      ];
      if (!address.v4 && !address.v6) findings.push(error('network.eos.svi-address', 'The SVI address is not a valid address and prefix.', { source: 'ArchToolKit' }));
      for (const family of [4, 6] as const) {
        const v = family === 4 ? varp.v4 : varp.v6;
        if (v && !(family === 4 ? address.v4 : address.v6) && (address.v4 || address.v6)) {
          findings.push(error('network.eos.varp-family', `The VARP address ${v} is IPv${family}, and the SVI has no IPv${family} address in that subnet.`, { source: 'ArchToolKit' }));
        }
      }

      return {
        platform: PLATFORM,
        title: `VLAN ${id} (${name}) and its SVI`,
        impact: 'none',
        notes: [
          ...(varp.v4 || varp.v6 ? ['VARP puts the same virtual address on both peers. The virtual MAC (`ip virtual-router mac-address`) has to be configured once, globally, and match.'] : []),
          ...(address.v6 ? ['`ipv6 unicast-routing` is included: without it EOS addresses the SVI and routes no IPv6.'] : []),
        ],
        before: [`show vlan ${id}`, `show running-config interfaces Vlan${id}`],
        config: [
          ...(address.v6 ? ['ipv6 unicast-routing', '!'] : []),
          `vlan ${id}`,
          `   name ${name}`,
          '!',
          `interface Vlan${id}`,
          `   description ${name}`,
          `   mtu ${num(values, 'mtu', 9214)}`,
          ...(address.v4 ? [`   ip address ${address.v4.text}`] : []),
          ...(address.v6 ? [`   ipv6 address ${address.v6.text}`] : []),
          ...(varp.v4 ? [`   ip virtual-router address ${varp.v4}`] : []),
          ...(varp.v6 ? [`   ipv6 virtual-router address ${varp.v6}`] : []),
          '   no shutdown',
          '!',
        ],
        verify: [
          `show vlan ${id}`,
          ...(address.v4 || !address.v6 ? [`show ip interface brief | include Vlan${id}`] : []),
          ...(address.v6 ? [`show ipv6 interface Vlan${id}`] : []),
          ...(varp.v4 || varp.v6 ? ['show ip virtual-router'] : []),
        ],
        backout: [`no interface Vlan${id}`, `no vlan ${id}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_mlag_member',
    platform: PLATFORM,
    label: 'MLAG member port-channel',
    group: 'Switching',
    description: 'A port-channel with an MLAG id and its members — how a dual-homed host or switch attaches to an EOS pair.',
    inputs: [
      { id: 'channel_id', label: 'Port-channel id', control: 'number', default: 11, min: 1, max: 2000 },
      { id: 'mlag_id', label: 'MLAG id', control: 'number', default: 11, min: 1, max: 2000, hint: 'The same id on both peers' },
      { id: 'members', label: 'Member interfaces', control: 'text', default: 'Ethernet11' },
      { id: 'mode', label: 'Mode', control: 'select', default: 'trunk', options: [{ value: 'trunk', label: 'Trunk' }, { value: 'access', label: 'Access' }] },
      { id: 'allowed', label: 'Allowed VLANs', control: 'text', default: '100,200', showWhen: { input: 'mode', equals: ['trunk'] } },
      { id: 'vlan_id', label: 'Access VLAN', control: 'number', default: 100, min: 1, max: 4094, showWhen: { input: 'mode', equals: ['access'] } },
      { id: 'port_description', label: 'Description', control: 'text', default: 'server-01' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const po = num(values, 'channel_id', 11);
      const mlag = num(values, 'mlag_id', 11);
      const members = listOf(str(values, 'members', ''));
      const trunk = str(values, 'mode', 'trunk') === 'trunk';
      const allowed = vlanRange(vlanIds(str(values, 'allowed', '')));
      const text = description(str(values, 'port_description', ''), 'MLAG member');

      return {
        platform: PLATFORM,
        title: `MLAG ${mlag} on Port-Channel${po}`,
        impact: 'brief',
        notes: ['Both peers take the same MLAG id and the same VLAN list. EOS will report an inconsistency and the port-channel will stay down if they differ.'],
        before: ['show mlag', 'show mlag interfaces', 'show port-channel summary'],
        config: [
          `interface Port-Channel${po}`,
          `   description ${text}`,
          ...(trunk ? ['   switchport mode trunk', `   switchport trunk allowed vlan ${allowed}`] : ['   switchport mode access', `   switchport access vlan ${num(values, 'vlan_id', 100)}`]),
          '   spanning-tree portfast' + (trunk ? ' network' : ''),
          `   mlag ${mlag}`,
          '   no shutdown',
          '!',
          ...members.flatMap((port) => [`interface ${port}`, `   description ${text} member`, `   channel-group ${po} mode active`, '   no shutdown', '!']),
        ],
        verify: ['show mlag', 'show mlag interfaces detail', `show interfaces Port-Channel${po} status`],
        backout: [...members.flatMap((port) => [`interface ${port}`, `   no channel-group ${po}`, '!']), `no interface Port-Channel${po}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_bgp_evpn_leaf',
    platform: PLATFORM,
    label: 'BGP EVPN leaf',
    group: 'Routing',
    description: 'A leaf switch peering EVPN with the spines: the BGP process, the peer group, and the address families.',
    inputs: [
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65101, min: 1 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.11' },
      { id: 'spines', label: 'Spine addresses', control: 'text', default: '10.255.0.1, 10.255.0.2' },
      { id: 'spine_as', label: 'Spine AS', control: 'number', default: 65100, min: 1 },
      { id: 'auth', label: 'Authenticate the sessions', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const asn = num(values, 'local_as', 65101);
      const peers = addressList(str(values, 'spines', ''));
      const spines = peers.v4;
      const spineAs = num(values, 'spine_as', 65100);
      const auth = bool(values, 'auth', true);
      const findings: Finding[] = [
        ...routerIdFindings('network.eos.router-id', str(values, 'router_id', '10.255.0.11')),
        ...peers.invalid.map((p) => error('network.eos.bad-peer', `The spine "${p}" is not an address.`, { source: 'ArchToolKit' })),
      ];
      // EVPN over IPv6 loopback peering is release-specific on EOS; those spines are not written.
      if (peers.v6.length > 0) findings.push(unverifiedIpv6('network.eos.evpn-ipv6-peer', 'EVPN peering to an IPv6 spine address', 'EOS'));

      return {
        findings,
        platform: PLATFORM,
        title: `BGP ${asn} EVPN leaf`,
        impact: 'brief',
        notes: [
          'The underlay has to be up first: this peers over loopbacks, and the loopbacks have to be reachable.',
          ...(auth ? [`Replace ${SECRET} with the session password from your vault.`] : []),
        ],
        before: ['show bgp summary', 'show bgp evpn summary', 'show running-config section bgp'],
        config: [
          'service routing protocols model multi-agent',
          '!',
          `router bgp ${asn}`,
          `   router-id ${str(values, 'router_id', '10.255.0.11')}`,
          '   no bgp default ipv4-unicast',
          '   maximum-paths 4 ecmp 4',
          '   neighbor SPINE peer group',
          `   neighbor SPINE remote-as ${spineAs}`,
          '   neighbor SPINE update-source Loopback0',
          '   neighbor SPINE ebgp-multihop 3',
          '   neighbor SPINE send-community extended',
          ...(auth ? [`   neighbor SPINE password 7 ${SECRET}`] : []),
          ...spines.map((ip) => `   neighbor ${ip} peer group SPINE`),
          '   !',
          '   address-family evpn',
          '      neighbor SPINE activate',
          '   !',
          '   address-family ipv4',
          '      no neighbor SPINE activate',
          '!',
        ],
        verify: ['show bgp summary', 'show bgp evpn summary', 'show bgp evpn route-type mac-ip'],
        backout: [`router bgp ${asn}`, ...spines.map((ip) => `   no neighbor ${ip}`), '   no neighbor SPINE peer group', '!'],
      };
    },
  }),

  deviceBlueprint({
    id: 'eos_management_baseline',
    platform: PLATFORM,
    label: 'Management baseline',
    group: 'Baseline',
    description: 'NTP, syslog, SNMPv3, SSH and eAPI over the management VRF, with a control-plane access list.',
    inputs: [
      { id: 'hostname', label: 'Hostname', control: 'text', default: 'dc-leaf-01' },
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '10.0.0.10, 10.0.0.11', hint: 'IPv4 or IPv6 addresses, or names' },
      { id: 'syslog_servers', label: 'Syslog servers', control: 'text', default: '10.0.0.20', hint: 'IPv4 or IPv6 addresses, or names' },
      { id: 'snmp_user', label: 'SNMPv3 user', control: 'text', default: 'monitor' },
      { id: 'management_acl', label: 'Management source prefixes', control: 'text', default: '10.0.0.0/24', hint: 'IPv4 and IPv6, comma separated: 10.0.0.0/24, 2001:db8:0:100::/64' },
      { id: 'eapi', label: 'Enable eAPI (HTTPS)', control: 'toggle', default: true, hint: 'What the Ansible httpapi connection uses' },
      { id: 'vrf', label: 'Management VRF', control: 'text', default: 'MGMT' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vrf = str(values, 'vrf', 'MGMT');
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const syslog = listOf(str(values, 'syslog_servers', ''));
      const prefixes = listOf(str(values, 'management_acl', '')).map((p) => ({ text: p, cidr: parseCidrDual(p) }));
      const mgmt4 = prefixes.flatMap((p) => (p.cidr?.family === 4 ? [`${p.cidr.address}/${p.cidr.prefix}`] : []));
      const mgmt6 = prefixes.flatMap((p) => (p.cidr?.family === 6 ? [`${p.cidr.network}/${p.cidr.prefix}`] : []));
      const mgmt = mgmt4.length > 0;
      const user = str(values, 'snmp_user', 'monitor');
      const findings: Finding[] = prefixes
        .filter((p) => !p.cidr)
        .map((p) => error('network.eos.bad-management-prefix', `"${p.text}" is not a valid IPv4 or IPv6 prefix.`, { remediation: 'Write it as 10.0.0.0/24 or 2001:db8:0:100::/64.', source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: 'Management baseline on the management VRF',
        impact: 'brief',
        notes: [
          `Replace every ${SECRET} with the real credential from your vault.`,
          'On EOS, make this change inside a configure session with a commit timer: `configure session mgmt`, paste, `commit timer 00:05:00`. If you lock yourself out, the switch rolls it back.',
          ...(mgmt6.length > 0 ? ['IPv4 and IPv6 are filtered by separate lists. A family with no list on `management ssh` is not filtered at all.'] : []),
        ],
        findings,
        before: ['show ntp status', 'show logging', 'show management api http-commands', 'show ip access-lists ACL-MGMT', ...(mgmt6.length > 0 ? ['show ipv6 access-lists ACL-MGMT-V6'] : [])],
        config: [
          `hostname ${str(values, 'hostname', 'switch')}`,
          '!',
          ...ntp.map((server) => `ntp server vrf ${vrf} ${server} iburst`),
          ...syslog.map((server) => `logging vrf ${vrf} host ${server}`),
          'logging format timestamp high-resolution',
          '!',
          ...(mgmt ? ['ip access-list ACL-MGMT', ...mgmt4.map((p, i) => `   ${(i + 1) * 10} permit ip ${p} any`), `   ${(mgmt4.length + 1) * 10} deny ip any any log`, '!'] : []),
          ...(mgmt6.length > 0 ? ['ipv6 access-list ACL-MGMT-V6', ...mgmt6.map((p, i) => `   ${(i + 1) * 10} permit ipv6 ${p} any`), `   ${(mgmt6.length + 1) * 10} deny ipv6 any any log`, '!'] : []),
          `snmp-server vrf ${vrf} local-interface Management1`,
          `snmp-server user ${user} MONITOR v3 auth sha ${SECRET} priv aes ${SECRET}`,
          'snmp-server group MONITOR v3 priv',
          '!',
          'management ssh',
          '   idle-timeout 15',
          ...(mgmt ? ['   ip access-group ACL-MGMT in'] : []),
          ...(mgmt6.length > 0 ? ['   ipv6 access-group ACL-MGMT-V6 in'] : []),
          `   vrf ${vrf}`,
          '      no shutdown',
          '!',
          ...(bool(values, 'eapi', true)
            ? ['management api http-commands', '   protocol https', '   no shutdown', `   vrf ${vrf}`, '      no shutdown', '!']
            : []),
        ],
        verify: ['show ntp status', 'show logging | include Logging', 'show management api http-commands', 'show snmp user'],
        backout: [
          ...ntp.map((server) => `no ntp server vrf ${vrf} ${server}`),
          ...syslog.map((server) => `no logging vrf ${vrf} host ${server}`),
          `no snmp-server user ${user} MONITOR v3`,
          ...(mgmt ? ['management ssh', '   no ip access-group ACL-MGMT in', '!', 'no ip access-list ACL-MGMT'] : []),
          ...(mgmt6.length > 0 ? ['management ssh', '   no ipv6 access-group ACL-MGMT-V6 in', '!', 'no ipv6 access-list ACL-MGMT-V6'] : []),
        ],
      };
    },
  }),
];

/** The rest — the domain-level and operational changes — live in eos-extra.ts. */
const ALL: readonly ChangeBlueprint[] = [...BLUEPRINTS, ...EOS_EXTRA, ...EOS_EXTRA_2];

export const EOS_NETWORK: BlueprintGroup = { target: PLATFORM, label: 'Arista EOS', blueprints: ALL };
export const EOS_CHANGES: readonly ChangeBlueprint[] = ALL;
