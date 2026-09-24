/**
 * Cisco IOS and IOS-XE, dual stack.
 *
 * Every address field on an IOS blueprint takes IPv6 as well as IPv4 where
 * IOS has IPv6 for the feature, and what comes out is IOS syntax: `ipv6
 * address x/len`, `ipv6 route`, `ipv6 access-list` with prefix lengths and
 * neighbour discovery before the final deny, `ipv6 traffic-filter`, `ipv6
 * prefix-list`, `address-family ipv6`, HSRP version 2 IPv6 groups, VRRPv3,
 * `ipv6 dhcp relay destination`, OSPFv3. Where IOS has no IPv6 — PAT, IGMP,
 * MSDP, `ip dhcp excluded-address` — an IPv6 value is refused with an error and
 * nothing is written for it. IPv4 input still produces exactly what it did.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { defaultValues } from '../../kit/blueprint.ts';
import { IOS_CHANGES } from './ios.ts';
import type { DeviceChange } from '../device.ts';

const blueprint = (id: string) => {
  const b = IOS_CHANGES.find((x) => x.id === id);
  if (!b) throw new Error(`no blueprint ${id}`);
  return b;
};
const build = (id: string, values: Record<string, string | number | boolean> = {}): DeviceChange => {
  const b = blueprint(id);
  return b.change({ ...defaultValues(b), ...values }, id);
};
const errors = (c: DeviceChange) => (c.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code);
const warnings = (c: DeviceChange) => (c.findings ?? []).filter((f) => f.severity === 'warning').map((f) => f.code);
const has = (lines: readonly string[], line: string) => lines.map((l) => l.trim()).includes(line);
const text = (c: DeviceChange) => c.config.join('\n');

/** The lines of one named block: from its header to the next top-level line. */
function block(lines: readonly string[], header: string): string[] {
  const start = lines.findIndex((l) => l === header);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(' ')) break;
    out.push(line.trim());
  }
  return out;
}

describe('IOS interfaces take IPv6', () => {
  it('SVI: dual-stack address, IPv6 relay, and an HSRP v2 IPv6 group of its own', () => {
    const c = build('ios_vlan_svi', { address: '10.10.10.1/24, 2001:db8:10::1/64', helper: '10.0.0.10, 2001:db8::10', hsrp: '10.10.10.254, 2001:db8:10::254' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ip address 10.10.10.1 255.255.255.0')).toBe(true);
    expect(has(c.config, 'ipv6 address 2001:db8:10::1/64')).toBe(true);
    expect(has(c.config, 'ipv6 enable')).toBe(true);
    expect(has(c.config, 'ip helper-address 10.0.0.10')).toBe(true);
    expect(has(c.config, 'ipv6 dhcp relay destination 2001:db8::10')).toBe(true);
    expect(has(c.config, 'standby version 2')).toBe(true);
    expect(has(c.config, 'standby 10 ip 10.10.10.254')).toBe(true);
    // The IPv6 group is a different group number, with a link-local virtual address and the global one in the SVI prefix.
    expect(has(c.config, 'standby 2058 ipv6 autoconfig')).toBe(true);
    expect(has(c.config, 'standby 2058 ipv6 2001:db8:10::254/64')).toBe(true);
    expect(c.config.indexOf(' standby version 2') < c.config.indexOf(' standby 10 ip 10.10.10.254')).toBe(true);
    // No IPv6 address ever sits on an `ip` line.
    expect(c.config.filter((l) => /^\s*ip /.test(l)).some((l) => l.includes(':'))).toBe(false);
  });

  it('SVI: IPv6-only works, and an IPv6 relay without an IPv6 address is refused', () => {
    const only6 = build('ios_vlan_svi', { address: '2001:db8:10::1/64', hsrp: 'fe80::1' });
    expect(errors(only6)).toEqual([]);
    expect(has(only6.config, 'standby 10 ipv6 fe80::1')).toBe(true);
    expect(only6.config.some((l) => l.includes('ip address'))).toBe(false);
    const bad = build('ios_vlan_svi', { helper: '2001:db8::10' });
    expect(errors(bad).includes('network.ios.relay6-no-address')).toBe(true);
    expect(bad.config.some((l) => l.includes('ipv6 dhcp relay'))).toBe(false);
  });

  it('routed port and loopback: ipv6 address with its prefix, OSPFv3 on the port', () => {
    const port = build('ios_routed_port', { address: '10.0.12.1/30, 2001:db8:0:12::1/127', ospf_process: 1 });
    expect(errors(port)).toEqual([]);
    expect(has(port.config, 'ipv6 address 2001:db8:0:12::1/127')).toBe(true);
    expect(has(port.config, 'ip ospf 1 area 0')).toBe(true);
    expect(has(port.config, 'ospfv3 1 ipv6 area 0')).toBe(true);
    const lo = build('ios_loopback', { address: '10.255.0.1/32, 2001:db8::1/128' });
    expect(errors(lo)).toEqual([]);
    expect(has(lo.config, 'ipv6 address 2001:db8::1/128')).toBe(true);
    expect(warnings(build('ios_loopback', { address: '2001:db8::1/64' })).includes('network.ios.loopback-mask')).toBe(true);
  });

  it('GRE: IPv6 inside the tunnel, and GRE over IPv6 as tunnel mode gre ipv6', () => {
    const c = build('ios_gre_tunnel', { address: '10.254.0.1/30, 2001:db8:fe::1/64', destination: '2001:db8:ffff::2', source: 'GigabitEthernet0/0/0' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'tunnel mode gre ipv6')).toBe(true);
    expect(has(c.config, 'ipv6 address 2001:db8:fe::1/64')).toBe(true);
    expect(has(c.config, 'ipv6 tcp adjust-mss 1340')).toBe(true);
    // Keepalives over IPv6 are not confirmed, so they are left out and said so.
    expect(c.config.some((l) => l.includes('keepalive'))).toBe(false);
    expect(warnings(c).includes('network.ios.gre6-keepalive')).toBe(true);
    const mixed = build('ios_gre_tunnel', { source: '198.51.100.1', destination: '2001:db8:ffff::2' });
    expect(errors(mixed).includes('network.ios.tunnel-family')).toBe(true);
  });
});

describe('IOS routing takes IPv6', () => {
  it('static route: ipv6 route with a prefix length, never a mask', () => {
    const c = build('ios_static_route', { prefix: '2001:db8:20::/48', next_hop: '2001:db8::1', distance: 200 });
    expect(errors(c)).toEqual([]);
    expect(c.config).toEqual(['ipv6 route 2001:db8:20::/48 2001:db8::1 200']);
    expect(c.backout).toEqual(['no ipv6 route 2001:db8:20::/48 2001:db8::1 200']);
    expect(build('ios_static_route', { prefix: '::/0', next_hop: 'GigabitEthernet0/0 fe80::1' }).config).toEqual(['ipv6 route ::/0 GigabitEthernet0/0 fe80::1']);
  });

  it('static route: families must match, a link-local needs its interface, tracking is not guessed', () => {
    expect(errors(build('ios_static_route', { prefix: '2001:db8:20::/48', next_hop: '10.0.0.1' })).includes('network.ios.route-family')).toBe(true);
    expect(errors(build('ios_static_route', { prefix: '::/0', next_hop: 'fe80::1' })).includes('network.ios.route-link-local')).toBe(true);
    const tracked = build('ios_static_route', { prefix: '::/0', next_hop: '2001:db8::1', track: 3 });
    expect(tracked.config[0]!.includes('track')).toBe(false);
    expect(warnings(tracked).includes('network.ios.route6-track')).toBe(true);
  });

  it('OSPF: IPv6 networks are refused for OSPFv2, OSPFv3 is its own process', () => {
    const refused = build('ios_ospf', { networks: '10.10.10.0/24\n2001:db8:10::/64' });
    expect(errors(refused).includes('network.ios.ospf-v6-network')).toBe(true);
    expect(refused.config.some((l) => l.includes('2001:db8'))).toBe(false);
    const v3 = build('ios_ospf', { ospfv3: true, v6_interfaces: 'Vlan10' });
    expect(errors(v3)).toEqual([]);
    expect(has(v3.config, 'router ospfv3 1')).toBe(true);
    expect(has(v3.config, 'router-id 10.255.0.1')).toBe(true);
    expect(has(v3.config, 'address-family ipv6 unicast')).toBe(true);
    expect(has(v3.config, 'ospfv3 1 ipv6 area 0')).toBe(true);
    expect(v3.config.filter((l) => l.trim() === 'ospfv3 1 ipv6 area 0').length).toBe(2);
    expect(warnings(v3).includes('network.ios.ospfv3-auth')).toBe(true);
  });

  it('router ids stay dotted IPv4, even for IPv6', () => {
    expect(errors(build('ios_ospf', { router_id: '2001:db8::1' })).includes('network.ios.router-id')).toBe(true);
    expect(errors(build('ios_bgp_peer', { router_id: '2001:db8::1' })).includes('network.ios.router-id')).toBe(true);
    expect(errors(build('ios_ipv6_routing', { router_id: '2001:db8::1' })).includes('network.ios.router-id')).toBe(true);
  });

  it('BGP: a dual-stack peer gets an IPv6 address family, IPv6 prefix lists and a network without a mask', () => {
    const c = build('ios_bgp_peer', { neighbor: '203.0.113.1, 2001:db8:ffff::1', advertise: '10.10.0.0/16\n2001:db8:100::/48' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ipv6 prefix-list PL-OUT-2001-db8-ffff--1 seq 5 permit 2001:db8:100::/48')).toBe(true);
    expect(has(c.config, 'ipv6 prefix-list PL-IN-2001-db8-ffff--1 seq 30 permit 2000::/3 le 48')).toBe(true);
    expect(has(c.config, 'neighbor 2001:db8:ffff::1 remote-as 65001')).toBe(true);
    const af6 = c.config.slice(c.config.indexOf(' address-family ipv6 unicast'));
    expect(af6.map((l) => l.trim())).toContain('neighbor 2001:db8:ffff::1 activate');
    expect(af6.map((l) => l.trim())).toContain('network 2001:db8:100::/48');
    expect(af6.map((l) => l.trim())).toContain('neighbor 2001:db8:ffff::1 prefix-list PL-IN-2001-db8-ffff--1 in');
    // The IPv4 family carries only the IPv4 neighbour and prefix.
    const af4 = c.config.slice(c.config.indexOf(' address-family ipv4 unicast'), c.config.indexOf(' address-family ipv6 unicast'));
    expect(af4.some((l) => l.includes(':'))).toBe(false);
    expect(has(c.config, 'network 10.10.0.0 mask 255.255.0.0')).toBe(true);
  });

  it('BGP: an IPv6 prefix with no IPv6 neighbour is refused', () => {
    const c = build('ios_bgp_peer', { advertise: '2001:db8:100::/48' });
    expect(errors(c).includes('network.ios.bgp-v6-no-peer')).toBe(true);
    expect(c.config.some((l) => l.includes('2001:db8:100::'))).toBe(false);
  });

  it('EIGRP named mode: an IPv6 address family with no network statements', () => {
    const c = build('ios_eigrp', { networks: '10.10.0.0/16\n2001:db8::/48', summary: '2001:db8::/48' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'address-family ipv6 unicast autonomous-system 100')).toBe(true);
    expect(has(c.config, 'summary-address 2001:db8::/48')).toBe(true);
    expect(c.config.some((l) => l.includes('network 2001'))).toBe(false);
  });

  it('first-hop redundancy: HSRP v2 IPv6 groups, and VRRPv3 for IPv6', () => {
    const hsrp = build('ios_fhrp', { virtual_address: '10.10.10.254, fe80::1, 2001:db8:10::254/64', version2: false });
    expect(errors(hsrp)).toEqual([]);
    expect(has(hsrp.config, 'standby version 2')).toBe(true);
    expect(has(hsrp.config, 'standby 2058 ipv6 fe80::1')).toBe(true);
    expect(has(hsrp.config, 'standby 2058 ipv6 2001:db8:10::254/64')).toBe(true);
    expect(warnings(hsrp).includes('network.ios.hsrp6-version')).toBe(true);
    const vrrp = build('ios_fhrp', { protocol: 'vrrp', virtual_address: '10.10.10.254, fe80::1, 2001:db8:10::254/64' });
    expect(errors(vrrp)).toEqual([]);
    expect(has(vrrp.config, 'fhrp version vrrp v3')).toBe(true);
    expect(has(vrrp.config, 'vrrp 10 address-family ipv4')).toBe(true);
    expect(has(vrrp.config, 'vrrp 10 address-family ipv6')).toBe(true);
    expect(has(vrrp.config, 'address fe80::1 primary')).toBe(true);
    expect(has(vrrp.config, 'address 2001:db8:10::254/64')).toBe(true);
    // VRRPv3 has no authentication and the old syntax is gone once it is on.
    expect(vrrp.config.some((l) => l.includes('authentication') || l.includes('vrrp 10 ip '))).toBe(false);
    expect(errors(build('ios_fhrp', { protocol: 'vrrp', virtual_address: '2001:db8:10::254/64' })).includes('network.ios.vrrp6-link-local')).toBe(true);
  });

  it('redistribution: IPv6 prefixes go through an ipv6 prefix-list into OSPFv3', () => {
    const c = build('ios_redistribute', { prefixes: '10.20.0.0/16\n2001:db8:20::/48', into_protocol: 'ospf', into_id: '1' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ipv6 prefix-list PL-STATIC-TO-OSPF-V6 seq 5 permit 2001:db8:20::/48')).toBe(true);
    expect(has(c.config, 'match ipv6 address prefix-list PL-STATIC-TO-OSPF-V6')).toBe(true);
    expect(has(c.config, 'router ospfv3 1')).toBe(true);
    expect(has(c.config, 'redistribute static route-map RM-STATIC-TO-OSPF-V6')).toBe(true);
    expect(has(c.config, 'redistribute static route-map RM-STATIC-TO-OSPF subnets')).toBe(true);
  });

  it('prefix list and route-map: an IPv6 list of its own, never mixed with IPv4', () => {
    const c = build('ios_prefix_list_routemap', { prefixes: '10.10.0.0/16 le 24\n2001:db8::/32 le 48' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ipv6 prefix-list PL-CUSTOMER-IN-V6 seq 5 permit 2001:db8::/32 le 48')).toBe(true);
    expect(has(c.config, 'ipv6 prefix-list PL-CUSTOMER-IN-V6 seq 10 deny ::/0 le 128')).toBe(true);
    expect(has(c.config, 'match ipv6 address prefix-list PL-CUSTOMER-IN-V6')).toBe(true);
    expect(c.config.filter((l) => l.startsWith('ip prefix-list')).some((l) => l.includes(':'))).toBe(false);
  });

  it('policy routing: ipv6 access list, set ipv6 next-hop, ipv6 policy route-map', () => {
    const c = build('ios_pbr', { match_source: '10.30.0.0/16, 2001:db8:30::/48', next_hop: '10.0.99.1, 2001:db8:99::1' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'permit ipv6 2001:db8:30::/48 any')).toBe(true);
    expect(has(c.config, 'match ipv6 address PBR-GUEST-OUT-MATCH-V6')).toBe(true);
    expect(has(c.config, 'set ipv6 next-hop 2001:db8:99::1')).toBe(true);
    expect(has(c.config, 'ipv6 policy route-map PBR-GUEST-OUT-V6')).toBe(true);
    expect(has(c.config, 'set ip next-hop 10.0.99.1')).toBe(true);
    expect(errors(build('ios_pbr', { match_source: '2001:db8:30::/48', next_hop: '10.0.99.1' })).includes('network.ios.pbr-no-hop6')).toBe(true);
  });

  it('BFD for an IPv6 static route', () => {
    expect(has(build('ios_bfd', { protocol: 'static', neighbor: '2001:db8:0:12::2' }).config, 'ipv6 route static bfd GigabitEthernet1/0/24 2001:db8:0:12::2')).toBe(true);
  });
});

describe('IOS security and services take IPv6', () => {
  it('access list: IPv6 rules go into an ipv6 access-list with prefix lengths and ND before the deny', () => {
    const c = build('ios_acl', {
      rules: 'permit tcp 10.10.10.0/24 any eq 443\npermit tcp 2001:db8:10::/64 any eq 443\npermit ip 2001:db8:10::5 host 2001:db8::53\npermit icmp any any echo',
      apply_to: 'Vlan10',
    });
    expect(errors(c)).toEqual([]);
    const v4 = block(c.config, 'ip access-list extended ACL-USERS-IN');
    const v6 = block(c.config, 'ipv6 access-list ACL-USERS-IN-V6');
    expect(v4).toEqual(['permit tcp 10.10.10.0 0.0.0.255 any eq 443', 'permit icmp any any echo', 'deny ip any any log']);
    expect(v6).toEqual([
      'permit tcp 2001:db8:10::/64 any eq 443',
      'permit ipv6 host 2001:db8:10::5 host 2001:db8::53',
      'permit icmp any any echo-request',
      'permit icmp any any nd-na',
      'permit icmp any any nd-ns',
      'deny ipv6 any any log',
    ]);
    // No wildcard mask in the IPv6 list, no IPv6 address in the IPv4 one.
    expect(v6.some((l) => /\d+\.\d+\.\d+\.\d+/.test(l))).toBe(false);
    expect(v4.some((l) => l.includes(':'))).toBe(false);
    expect(has(c.config, 'ip access-group ACL-USERS-IN in')).toBe(true);
    expect(has(c.config, 'ipv6 traffic-filter ACL-USERS-IN-V6 in')).toBe(true);
    expect(has(c.backout, 'no ipv6 access-list ACL-USERS-IN-V6')).toBe(true);
  });

  it('access list: a rule that mixes families is refused and left out', () => {
    const c = build('ios_acl', { rules: 'permit tcp 10.10.10.0/24 2001:db8::/64 eq 443' });
    expect(errors(c).includes('network.ios.acl-mixed-family')).toBe(true);
    expect(text(c).includes('2001:db8')).toBe(false);
  });

  it('management baseline: IPv6 syslog, IPv6 vty access class, SNMP restricted for both families', () => {
    const c = build('ios_management_baseline', { ntp_servers: '10.0.0.10, 2001:db8::123', syslog_servers: '10.0.0.20, 2001:db8::514', management_acl: '10.0.0.0/24, 2001:db8:0:1::/64' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ntp server 2001:db8::123')).toBe(true);
    expect(has(c.config, 'logging host 10.0.0.20')).toBe(true);
    expect(has(c.config, 'logging host ipv6 2001:db8::514')).toBe(true);
    expect(block(c.config, 'ipv6 access-list ACL-MGMT-V6')).toEqual(['permit ipv6 2001:db8:0:1::/64 any', 'deny ipv6 any any log']);
    expect(has(c.config, 'access-class ACL-MGMT in')).toBe(true);
    expect(has(c.config, 'ipv6 access-class ACL-MGMT-V6 in')).toBe(true);
    expect(has(c.config, 'snmp-server group MONITOR v3 priv access ipv6 ACL-MGMT-V6 ACL-MGMT')).toBe(true);
    expect(has(c.backout, 'no logging host ipv6 2001:db8::514')).toBe(true);
  });

  it('AAA: RADIUS and TACACS+ servers over IPv6', () => {
    const radius = build('ios_dot1x', { radius_servers: '10.0.0.30, 2001:db8::30' });
    expect(text(radius).includes(' address ipv6 2001:db8::30 auth-port 1812 acct-port 1813')).toBe(true);
    expect(text(radius).includes(' address ipv4 10.0.0.30 auth-port 1812 acct-port 1813')).toBe(true);
    // The CoA client form for IPv6 is not confirmed, so it is not written and is flagged.
    expect(text(radius).includes('client 2001:db8::30')).toBe(false);
    expect(warnings(radius).includes('network.ios.coa-ipv6')).toBe(true);
    const tacacs = build('ios_aaa_tacacs', { servers: '2001:db8::31' });
    expect(text(tacacs).includes(' address ipv6 2001:db8::31')).toBe(true);
  });

  it('NETCONF/RESTCONF: an IPv6 access list bound with ip http access-class ipv6', () => {
    const c = build('ios_netconf', { restconf: true, management_acl: '10.0.0.0/24, 2001:db8:0:1::/64' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ipv6 access-list ACL-AUTOMATION-V6')).toBe(true);
    expect(has(c.config, 'ip http access-class ipv6 ACL-AUTOMATION-V6')).toBe(true);
    expect(has(c.config, 'ip http access-class ipv4 ACL-AUTOMATION')).toBe(true);
  });

  it('IKEv2: an IPv6 peer is written with a prefix length', () => {
    const c = build('ios_ipsec_vpn', { peer: '2001:db8:ffff::2', local_id: '2001:db8:ffff::1' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'address 2001:db8:ffff::2/128')).toBe(true);
    expect(has(c.config, 'match identity remote address 2001:db8:ffff::2/128')).toBe(true);
    expect(has(c.config, 'identity local address 2001:db8:ffff::1')).toBe(true);
    expect(warnings(build('ios_ipsec_vpn', { peer: '2001:db8:ffff::2' })).includes('network.ios.ike-id-family')).toBe(true);
  });

  it('CoPP: IPv6 classes with neighbour discovery in the routing class', () => {
    const c = build('ios_copp', { management_sources: '10.0.0.0/8, 2001:db8::/32' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'class-map match-any COPP-ROUTING')).toBe(true);
    expect(has(c.config, 'match access-group name COPP-ROUTING-V6')).toBe(true);
    expect(block(c.config, 'ipv6 access-list COPP-ROUTING-V6')).toContain('permit icmp any any nd-ns');
    expect(block(c.config, 'ipv6 access-list COPP-MANAGEMENT-V6')).toContain('permit tcp 2001:db8::/32 any eq 22');
  });

  it('zone-based firewall: an IPv6 published host gets its own list in the same class', () => {
    const c = build('ios_zbfw', { inbound: 'named', inbound_host: '10.10.0.20, 2001:db8:10::20' });
    expect(has(c.config, 'ipv6 access-list OUTSIDE-TO-INSIDE-ACL-V6')).toBe(true);
    expect(has(c.config, 'permit tcp any host 2001:db8:10::20 eq 443')).toBe(true);
    expect(has(c.config, 'class-map type inspect match-any OUTSIDE-TO-INSIDE-CLASS')).toBe(true);
  });

  it('SNMPv3: an IPv6 manager, restricted with access ipv6', () => {
    const c = build('ios_snmpv3', { manager: '2001:db8:0:1::50' });
    expect(has(c.config, 'snmp-server group MONITOR-RO v3 priv read HEALTH access ipv6 SNMP-MANAGERS-V6')).toBe(true);
    expect(has(c.config, 'snmp-server host 2001:db8:0:1::50 version 3 priv monitoring')).toBe(true);
    expect(c.config.some((l) => l.startsWith('ip access-list standard'))).toBe(false);
  });

  it('DHCP: a stateful DHCPv6 pool on the named interface', () => {
    const c = build('ios_dhcp_server', { network: '10.10.10.0/24, 2001:db8:10::/64', dns: '10.0.0.10, 2001:db8::53', v6_interface: 'Vlan10' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ipv6 dhcp pool USERS')).toBe(true);
    expect(has(c.config, 'address prefix 2001:db8:10::/64 lifetime 86400 43200')).toBe(true);
    expect(has(c.config, 'dns-server 2001:db8::53')).toBe(true);
    expect(has(c.config, 'dns-server 10.0.0.10')).toBe(true);
    expect(has(c.config, 'ipv6 dhcp server USERS')).toBe(true);
    expect(has(c.config, 'ipv6 nd managed-config-flag')).toBe(true);
    expect(errors(build('ios_dhcp_server', { network: '2001:db8:10::/64' })).includes('network.ios.dhcp6-no-interface')).toBe(true);
  });

  it('DHCP relay: ipv6 dhcp relay destination next to the helper addresses', () => {
    const c = build('ios_dhcp_relay', { servers: '10.0.1.10, 2001:db8::10, 2001:db8::11', source_interface: 'Loopback0' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ip helper-address 10.0.1.10')).toBe(true);
    expect(has(c.config, 'ipv6 dhcp relay destination 2001:db8::11')).toBe(true);
    expect(has(c.config, 'ipv6 dhcp relay source-interface Loopback0')).toBe(true);
  });

  it('NetFlow: an IPv6 record and ipv6 flow monitor to an IPv6 collector', () => {
    const c = build('ios_netflow', { collector: '2001:db8::40', ipv6_flows: true });
    expect(has(c.config, 'destination 2001:db8::40')).toBe(true);
    expect(has(c.config, 'match ipv6 source address')).toBe(true);
    expect(has(c.config, 'ipv6 flow monitor CFG-MONITOR-V6 input')).toBe(true);
  });

  it('IP SLA: an IPv6 URL is bracketed', () => {
    expect(has(build('ios_ipsla_track', { probe: 'http', destination: '2001:db8::80' }).config, 'http get http://[2001:db8::80]')).toBe(true);
    expect(has(build('ios_ipsla_track', { destination: '2001:4860:4860::8888' }).config, 'icmp-echo 2001:4860:4860::8888')).toBe(true);
  });

  it('IPv6 on an interface: a link-local that is not fe80::/10 is refused', () => {
    expect(errors(build('ios_ipv6_interface', { link_local: '2001:db8::1' })).includes('network.ios.bad-link-local')).toBe(true);
    expect(errors(build('ios_ipv6_interface', { address: '10.0.0.1/24' })).includes('network.ios.bad-ipv6')).toBe(true);
    expect(has(build('ios_ipv6_routing', { protocol: 'bgp' }).config, 'no bgp default ipv4-unicast')).toBe(true);
  });

  it('multicast: an IPv6 RP turns on PIMv6 with ipv6 pim rp-address', () => {
    const c = build('ios_multicast_pim', { rp_address: '10.255.0.1, 2001:db8::1', rp_group_acl: '239.0.0.0/8, ff05::/16' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ipv6 multicast-routing')).toBe(true);
    expect(has(c.config, 'ipv6 pim rp-address 2001:db8::1 MCAST-GROUPS-V6')).toBe(true);
    expect(has(c.config, 'permit ipv6 any ff05::/16')).toBe(true);
    expect(has(c.config, 'ip pim rp-address 10.255.0.1 MCAST-GROUPS')).toBe(true);
  });

  it('DMVPN: IPv6 inside the tunnel with ipv6 nhrp, and an IPv6 transport', () => {
    const c = build('ios_dmvpn', { tunnel_address: '10.254.0.11/24, 2001:db8:fe::11/64', hub_tunnel: '10.254.0.1, 2001:db8:fe::1', transport: 'ipv6', hub_public: '2001:db8:ffff::10' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ipv6 address 2001:db8:fe::11/64')).toBe(true);
    expect(has(c.config, 'ipv6 nhrp nhs 2001:db8:fe::1 nbma 2001:db8:ffff::10 multicast')).toBe(true);
    expect(has(c.config, 'ip nhrp nhs 10.254.0.1 nbma 2001:db8:ffff::10 multicast')).toBe(true);
    expect(has(c.config, 'tunnel mode gre multipoint ipv6')).toBe(true);
    expect(has(c.config, 'address ::/0')).toBe(true);
    expect(has(c.config, 'ipv6 eigrp 100')).toBe(true);
    expect(errors(build('ios_dmvpn', { transport: 'ipv6' })).includes('network.ios.dmvpn-transport-family')).toBe(true);
  });
});

describe('IOS refuses IPv6 where it has none', () => {
  it('NAT overload and static NAT', () => {
    const c = build('ios_nat', { inside_networks: '10.10.10.0/24\n2001:db8:10::/64', static_entries: '2001:db8:10::5 2001:db8:ffff::5' });
    expect(errors(c).filter((e) => e === 'network.ios.nat-ipv6').length).toBe(2);
    expect(text(c).includes('2001:db8')).toBe(false);
    expect((c.findings ?? []).find((f) => f.code === 'network.ios.nat-ipv6')!.message.includes('does not support IPv6')).toBe(true);
  });

  it('an IGMP querier address, an MSDP anycast RP, and an IPv4 DHCP exclusion', () => {
    const q = build('ios_igmp_snooping', { querier_address: '2001:db8::2' });
    expect(errors(q).includes('network.ios.igmp-querier-ipv6')).toBe(true);
    expect(text(q).includes('2001:db8')).toBe(false);
    const msdp = build('ios_multicast_pim', { rp_mode: 'anycast', rp_address: '2001:db8::1', rp_group_acl: '' });
    expect(errors(msdp).includes('network.ios.msdp-ipv6')).toBe(true);
    expect(text(msdp).includes('2001:db8')).toBe(false);
    const dhcp = build('ios_dhcp_server', { network: '10.10.10.0/24', exclude_from: '2001:db8::1', exclude_to: '2001:db8::20' });
    expect(errors(dhcp).includes('network.ios.dhcp6-exclude')).toBe(true);
    expect(text(dhcp).includes('excluded-address')).toBe(false);
  });
});

describe('IOS IPv4 output is unchanged', () => {
  it('the SVI, static route and access list read exactly as before', () => {
    expect(build('ios_vlan_svi').config).toEqual(['vlan 10', ' name USERS', '!', 'interface Vlan10', ' description USERS gateway', ' ip address 10.10.10.1 255.255.255.0', ' no shutdown', '!']);
    expect(build('ios_static_route').config).toEqual(['ip route 0.0.0.0 0.0.0.0 10.0.0.1']);
    expect(build('ios_static_route', { prefix: '10.20.0.0/16', vrf: 'RED', track: 5 }).config).toEqual(['ip route vrf RED 10.20.0.0 255.255.0.0 10.0.0.1 track 5']);
    expect(build('ios_acl').config).toEqual([
      'ip access-list extended ACL-USERS-IN',
      ' permit tcp 10.10.10.0 0.0.0.255 any eq 443',
      ' permit tcp 10.10.10.0 0.0.0.255 any eq 80',
      ' permit udp 10.10.10.0 0.0.0.255 host 10.0.0.10 eq 53',
      ' deny ip any any log',
      '!',
    ]);
  });

  it('no default IOS change writes an IPv6 line or finds an error', () => {
    for (const b of IOS_CHANGES) {
      if (b.id.startsWith('ios_ipv6_')) continue;
      const c = b.change(defaultValues(b), b.id);
      expect([b.id, c.config.some((l) => /^\s*ipv6 /.test(l))]).toEqual([b.id, false]);
      expect([b.id, errors(c)]).toEqual([b.id, []]);
    }
  });

  it('a VLAN above 255 with HSRP gets version 2, which version 1 cannot number', () => {
    const c = build('ios_vlan_svi', { vlan_id: 300, address: '10.30.0.1/24', hsrp: '10.30.0.254' });
    expect(has(c.config, 'standby version 2')).toBe(true);
    expect(has(c.config, 'standby 300 ip 10.30.0.254')).toBe(true);
  });
});
