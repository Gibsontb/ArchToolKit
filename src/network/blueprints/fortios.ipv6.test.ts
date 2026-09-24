/**
 * FortiOS 7.x, dual-stack.
 *
 * Every address a FortiOS blueprint takes must accept IPv6 where FortiOS has
 * an IPv6 form, and write it into the IPv6 table (address6, static6, vip6,
 * ippool6, dhcp6, local-in-policy6, network6, ospf6) or the IPv6 attribute
 * (srcaddr6, ip6-address, ip6-trusthostN, remote-gw6, subnet6, notify-hosts6).
 * IPv4 output must not change, `policy6` must never appear (it does not exist
 * on 7.x), and where FortiOS has no IPv6 form the value is refused.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { readYaml } from '../../core/yaml-read.ts';
import { FORTIOS_CHANGES } from './fortios.ts';
import type { DeviceChange } from '../device.ts';

function run(id: string, values: BlueprintValues = {}): DeviceChange {
  const blueprint = FORTIOS_CHANGES.find((b) => b.id === id);
  if (!blueprint) throw new Error(`no blueprint ${id}`);
  return blueprint.change({ ...defaultValues(blueprint), ...values }, id);
}
const text = (change: DeviceChange): string => change.config.join('\n');
const codes = (change: DeviceChange, severity?: string): string[] => (change.findings ?? []).filter((f) => !severity || f.severity === severity).map((f) => f.code);

describe('FortiOS IPv4 output is unchanged by dual-stack support', () => {
  it('keeps the IPv4 defaults in the IPv4 tables', () => {
    expect(text(run('fortios_address_objects'))).toContain('config firewall address\n    edit "APP-WEB-01"\n        set type ipmask\n        set subnet 10.20.30.11 255.255.255.255');
    expect(text(run('fortios_address_objects'))).not.toContain('address6');
    expect(text(run('fortios_static_route'))).toContain('config router static\n    edit 10\n        set dst 0.0.0.0 0.0.0.0\n        set gateway 203.0.113.1');
    expect(text(run('fortios_vip'))).toContain('config firewall vip\n');
    expect(text(run('fortios_interface'))).toContain('set ip 10.20.30.1 255.255.255.0');
    expect(text(run('fortios_interface'))).not.toContain('config ipv6');
    expect(text(run('fortios_ipsec_vpn'))).toContain('set remote-gw 198.51.100.10');
    expect(text(run('fortios_ipsec_vpn'))).toContain('set src-subnet 10.20.0.0 255.255.0.0');
    expect(text(run('fortios_dhcp_server'))).toContain('config system dhcp server');
    expect(text(run('fortios_admin_access'))).toContain('set trusthost1 10.0.0.0 255.255.255.0');
    expect(text(run('fortios_logging'))).toContain('set notify-hosts 10.0.0.40');
    expect(text(run('fortios_ssl_vpn'))).toContain('set tunnel-ip-pools "SSLVPN-POOL"');
    expect(text(run('fortios_ssl_vpn'))).not.toContain('ipv6');
    expect(text(run('fortios_dynamic_routing'))).toContain('config network\n    edit 1\n      set prefix 10.20.0.0 255.255.0.0');
    expect(text(run('fortios_dynamic_routing'))).not.toContain('activate6');
  });

  it('produces no errors for any default', () => {
    for (const blueprint of FORTIOS_CHANGES) expect(codes(run(blueprint.id), 'error')).toEqual([]);
  });

  it('never emits policy6, which FortiOS 7.x removed', () => {
    const change = run('fortios_firewall_policy', { source6: 'all', destination6: 'GRP6-APP' });
    expect(text(change)).not.toContain('policy6');
  });
});

describe('FortiOS objects, policy and NAT accept IPv6', () => {
  it('writes IPv6 address objects to address6 with set ip6, grouped separately', () => {
    const change = run('fortios_address_objects', { addresses: 'APP-WEB-01 10.20.30.11/32\nAPP-WEB-V6 2001:db8:30::11/128' });
    const config = text(change);
    expect(config).toContain('config firewall address6\n    edit "APP-WEB-V6"\n        set ip6 2001:db8:30::11/128');
    expect(config).toContain('config firewall addrgrp6\n    edit "GRP-APP-SERVERS-V6"\n        set member "APP-WEB-V6"');
    // A group holds one family: the IPv4 group names only the IPv4 object.
    expect(config).toContain('config firewall addrgrp\n    edit "GRP-APP-SERVERS"\n        set member "APP-WEB-01"\n');
    expect(change.backout.join('\n')).toContain('config firewall address6\n    delete "APP-WEB-V6"');
    expect(codes(change, 'error')).toEqual([]);
  });

  it('keeps the group name for an IPv6-only list and pushes address6', () => {
    const change = run('fortios_address_objects', { addresses: 'V6-NET 2001:db8:40::/64' });
    expect(text(change)).toContain('config firewall addrgrp6\n    edit "GRP-APP-SERVERS"');
    expect(text(change)).not.toContain('config firewall address\n');
    expect(change.push?.module).toBe('fortinet.fortios.fortios_firewall_address6');
  });

  it('puts IPv6 objects in srcaddr6/dstaddr6 of the consolidated policy', () => {
    const change = run('fortios_firewall_policy', { source6: 'GRP6-USERS', destination6: 'GRP6-APP' });
    const config = text(change);
    expect(config).toContain('set srcaddr "GRP-USERS"');
    expect(config).toContain('set srcaddr6 "GRP6-USERS"');
    expect(config).toContain('set dstaddr6 "GRP6-APP"');
    expect((change.push?.args as { firewall_policy: { srcaddr6: unknown } }).firewall_policy.srcaddr6).toEqual([{ name: 'GRP6-USERS' }]);
  });

  it('builds an IPv6-only policy when the IPv4 side is cleared', () => {
    const config = text(run('fortios_firewall_policy', { source: '', destination: '', source6: 'all', destination6: 'GRP6-APP' }));
    expect(config).not.toContain('set srcaddr "');
    expect(config).toContain('set srcaddr6 "all"');
  });

  it('refuses half an IPv6 policy and literal addresses in place of objects', () => {
    expect(codes(run('fortios_firewall_policy', { source6: 'all' }), 'error')).toContain('network.fortios.policy-v6-half');
    expect(codes(run('fortios_firewall_policy', { destination6: '2001:db8::/64', source6: 'all' }), 'error')).toContain('network.fortios.policy-literal-address');
  });

  it('publishes an IPv6 server with vip6 and refuses a mixed-family VIP', () => {
    const change = run('fortios_vip', { external: '2001:db8:ffff::10', internal: '2001:db8:30::11' });
    const config = text(change);
    expect(config).toContain('config firewall vip6\n    edit "VIP-WEB"\n        set extip 2001:db8:ffff::10\n        set mappedip 2001:db8:30::11');
    expect(config).not.toContain('extintf');
    expect(config).not.toContain('arp-reply');
    expect(change.push?.module).toBe('fortinet.fortios.fortios_firewall_vip6');
    const mixed = run('fortios_vip', { external: '2001:db8:ffff::10', internal: '10.20.30.11' });
    expect(codes(mixed, 'error')).toContain('network.fortios.vip-mixed-family');
  });

  it('writes an IPv6 pool as ippool6 and refuses IPv4-only pool types for it', () => {
    const change = run('fortios_ip_pool', { start_ip: '2001:db8:ffff::20', end_ip: '2001:db8:ffff::2f' });
    expect(text(change)).toContain('config firewall ippool6\n    edit "POOL-OUTBOUND"\n        set startip 2001:db8:ffff::20\n        set endip 2001:db8:ffff::2f');
    expect(text(change)).not.toContain('arp-reply');
    expect(change.push?.module).toBe('fortinet.fortios.fortios_firewall_ippool6');
    const oneToOne = run('fortios_ip_pool', { kind: 'one-to-one', start_ip: '2001:db8:ffff::20', end_ip: '2001:db8:ffff::2f' });
    expect(codes(oneToOne, 'error')).toContain('network.fortios.ippool6-type');
    expect((oneToOne.findings ?? []).find((f) => f.code === 'network.fortios.ippool6-type')?.message).toContain('does not support IPv6');
    expect(codes(run('fortios_ip_pool', { start_ip: '203.0.113.20', end_ip: '2001:db8::1' }), 'error')).toContain('network.fortios.pool-mixed-family');
    expect(codes(run('fortios_ip_pool', { start_ip: '2001:db8::9', end_ip: '2001:db8::1' }), 'error')).toContain('network.fortios.pool-inverted');
  });
});

describe('FortiOS routing and interfaces accept IPv6', () => {
  it('writes an IPv6 route to router static6 as prefix/length', () => {
    const change = run('fortios_static_route', { prefix: '::/0', gateway: '2001:db8:1::1' });
    expect(text(change)).toContain('config router static6\n    edit 10\n        set dst ::/0\n        set gateway 2001:db8:1::1\n        set device "port1"');
    expect(change.impact).toBe('outage');
    expect(change.push?.module).toBe('fortinet.fortios.fortios_router_static6');
    expect(change.backout.join('\n')).toContain('config router static6');
  });

  it('refuses a route whose gateway is the other family', () => {
    expect(codes(run('fortios_static_route', { prefix: '2001:db8::/32', gateway: '203.0.113.1' }), 'error')).toContain('network.fortios.route-mixed-family');
    expect(codes(run('fortios_static_route', { prefix: '10.0.0.0/8', gateway: 'fe80::1' }), 'error')).toContain('network.fortios.route-mixed-family');
  });

  it('adds ip6-address and ip6-allowaccess inside config ipv6', () => {
    const change = run('fortios_interface', { address: '10.20.30.1/24, 2001:db8:30::1/64', allow_access: 'ping, https, probe-response' });
    const config = text(change);
    expect(config).toContain('set ip 10.20.30.1 255.255.255.0');
    expect(config).toContain('        config ipv6\n            set ip6-mode static\n            set ip6-address 2001:db8:30::1/64\n            set ip6-allowaccess ping https\n        end');
    expect(codes(change, 'warning')).toContain('network.fortios.ip6-allowaccess');
    const ipv6 = (change.push?.args as { system_interface: { ipv6: { ip6_address: string } } }).system_interface.ipv6;
    expect(ipv6.ip6_address).toBe('2001:db8:30::1/64');
  });

  it('builds an IPv6-only interface and refuses link-local or two of a family', () => {
    const config = text(run('fortios_interface', { address: '2001:db8:30::1/64' }));
    expect(config).not.toContain('set ip ');
    expect(config).toContain('set ip6-address 2001:db8:30::1/64');
    expect(codes(run('fortios_interface', { address: 'fe80::1/64' }), 'error')).toContain('network.fortios.interface-link-local');
    expect(codes(run('fortios_interface', { address: '2001:db8::1/64, 2001:db8:1::1/64' }), 'error')).toContain('network.fortios.interface-secondary');
  });

  it('peers BGP over IPv6 with activate6 and advertises with network6', () => {
    const change = run('fortios_dynamic_routing', { peer: '2001:db8:12::1', advertise: '2001:db8:20::/48' });
    const config = text(change);
    expect(config).toContain('edit "2001:db8:12::1"');
    expect(config).toContain('set activate6 enable');
    expect(config).toContain('set activate disable');
    expect(config).toContain('config network6\n    edit 1\n      set prefix6 2001:db8:20::/48\n    next\n  end');
    expect(config).not.toContain('config network\n');
    // The router id stays a dotted 32-bit id.
    expect(config).toContain('set router-id 10.255.2.1');
  });

  it('advertises both families from an IPv4 peer', () => {
    const config = text(run('fortios_dynamic_routing', { advertise: '10.20.0.0/16\n2001:db8:20::/48' }));
    expect(config).toContain('set prefix 10.20.0.0 255.255.0.0');
    expect(config).toContain('set prefix6 2001:db8:20::/48');
    expect(config).toContain('set activate6 enable');
    expect(config).not.toContain('set activate disable');
  });

  it('runs OSPFv3 per interface and refuses IPv6 in OSPFv2 network statements', () => {
    const change = run('fortios_dynamic_routing', { protocol: 'ospf', ospf6_interfaces: 'port2, port3' });
    const config = text(change);
    expect(config).toContain('config router ospf6\n  set router-id 10.255.2.1');
    expect(config).toContain('  config ospf6-interface\n    edit "port2"\n      set interface "port2"\n      set area-id 0.0.0.0');
    expect(codes(change, 'warning')).toContain('network.fortios.ospf6-unauthenticated');
    const bad = run('fortios_dynamic_routing', { protocol: 'ospf', ospf_networks: '2001:db8:12::/64' });
    expect(codes(bad, 'error')).toContain('network.fortios.ospf-network-ipv6');
    expect(text(bad)).not.toContain('2001:db8:12::');
  });

  it('refuses an IPv6 router id', () => {
    expect(codes(run('fortios_dynamic_routing', { router_id: '2001:db8::1' }), 'error')).toContain('network.fortios.router-id-ipv6');
  });

  it('addresses both ends of an inter-VDOM link in each family', () => {
    const change = run('fortios_vdom', { intervdom_link: 'root', link_subnet: '10.254.1.0/30, fd00:254:1::/64' });
    const config = text(change);
    // Hosts, not the network address.
    expect(config).toContain('edit "LINK10"\n    set vdom "CUSTOMER-A"\n    set ip 10.254.1.1 255.255.255.252');
    expect(config).toContain('edit "LINK11"\n    set vdom "root"\n    set ip 10.254.1.2 255.255.255.252');
    expect(config).toContain('set ip6-address fd00:254:1::1/64');
    expect(config).toContain('set ip6-address fd00:254:1::2/64');
    expect(text(run('fortios_vdom', { intervdom_link: 'root', link_subnet: 'fd00:254:1::/127' }))).toContain('set ip6-address fd00:254:1::/127');
  });
});

describe('FortiOS VPN accepts IPv6', () => {
  it('uses subnet6 selectors, address6 objects and a static6 route for IPv6 subnets', () => {
    const change = run('fortios_ipsec_vpn', { local_subnet: '2001:db8:20::/48', remote_subnet: '2001:db8:30::/48' });
    const config = text(change);
    expect(config).toContain('set src-addr-type subnet6\n        set src-subnet6 2001:db8:20::/48');
    expect(config).toContain('set dst-addr-type subnet6\n        set dst-subnet6 2001:db8:30::/48');
    expect(config).toContain('config firewall address6\n    edit "VPN-BRANCH-01-LOCAL"\n        set ip6 2001:db8:20::/48');
    expect(config).toContain('config router static6\n    edit 0\n        set dst 2001:db8:30::/48');
    expect(config).not.toContain('set src-subnet ');
  });

  it('reaches an IPv6 peer with ip-version 6 and remote-gw6', () => {
    const change = run('fortios_ipsec_vpn', { remote_gateway: '2001:db8:ffff::10' });
    expect(text(change)).toContain('set ip-version 6\n        set remote-gw6 2001:db8:ffff::10');
    expect(text(change)).not.toContain('set remote-gw ');
    const phase1 = (change.push?.args as { vpn_ipsec_phase1_interface: Record<string, unknown> }).vpn_ipsec_phase1_interface;
    expect(phase1.remote_gw6).toBe('2001:db8:ffff::10');
    expect(phase1.ip_version).toBe('6');
  });

  it('refuses a phase 2 whose selectors are different families', () => {
    expect(codes(run('fortios_ipsec_vpn', { local_subnet: '10.20.0.0/16', remote_subnet: '2001:db8:30::/48' }), 'error')).toContain('network.fortios.vpn-selector-family');
  });

  it('gives SSL VPN an IPv6 pool and IPv6 split tunnelling alongside IPv4', () => {
    const change = run('fortios_ssl_vpn', { pool_range6: 'fd00:212:134::200-fd00:212:134::250', split_networks6: 'CORP6-NETWORKS' });
    const config = text(change);
    expect(config).toContain('config firewall address6\n  edit "SSLVPN-POOL-V6"\n    set type iprange\n    set start-ip fd00:212:134::200\n    set end-ip fd00:212:134::250');
    expect(config).toContain('set ipv6-tunnel-mode enable\n    set ipv6-pools "SSLVPN-POOL-V6"\n    set ipv6-split-tunneling enable\n    set ipv6-split-tunneling-routing-address "CORP6-NETWORKS"');
    expect(config).toContain('set tunnel-ipv6-pools "SSLVPN-POOL-V6"');
    expect(config).toContain('set srcaddr6 "SSLVPN-POOL-V6"\n    set dstaddr6 "CORP6-NETWORKS"');
    expect(config).toContain('set tunnel-ip-pools "SSLVPN-POOL"');
    expect(codes(change, 'error')).toEqual([]);
  });

  it('refuses IPv6 split tunnelling without IPv6 networks, and a range that mixes families', () => {
    expect(codes(run('fortios_ssl_vpn', { pool_range6: 'fd00::200-fd00::250' }), 'error')).toContain('network.fortios.sslvpn-split6');
    expect(codes(run('fortios_ssl_vpn', { pool_range: '10.0.0.1-fd00::2' }), 'error')).toContain('network.fortios.range-mixed-family');
  });
});

describe('FortiOS services and management accept IPv6', () => {
  it('serves DHCPv6 from dhcp6 server with IPv6 DNS only', () => {
    const change = run('fortios_dhcp_server', { range_start: '2001:db8:30::100', range_end: '2001:db8:30::1ff', dns: '2001:db8::53', gateway: '' });
    const config = text(change);
    expect(config).toContain('config system dhcp6 server');
    expect(config).toContain('set subnet 2001:db8:30::/64');
    expect(config).toContain('set ip-mode range');
    expect(config).toContain('set dns-server1 2001:db8::53');
    expect(config).toContain('set start-ip 2001:db8:30::100');
    expect(config).not.toContain('default-gateway');
    expect(change.push?.module).toBe('fortinet.fortios.fortios_system_dhcp6_server');
    expect(codes(change, 'error')).toEqual([]);
  });

  it('refuses the wrong family of DNS server for a scope, and a mixed range', () => {
    expect(codes(run('fortios_dhcp_server', { range_start: '2001:db8:30::100', range_end: '2001:db8:30::1ff' }), 'error')).toContain('network.fortios.dhcp-dns-family');
    expect(codes(run('fortios_dhcp_server', { dns: '10.0.0.10, 2001:db8::53' }), 'error')).toContain('network.fortios.dhcp-dns-family');
    expect(codes(run('fortios_dhcp_server', { range_end: '2001:db8:30::1ff' }), 'error')).toContain('network.fortios.dhcp-mixed-family');
    expect(codes(run('fortios_dhcp_server', { range_start: '2001:db8:30::100', range_end: '2001:db8:30::1ff', dns: '2001:db8::53', subnet6: '2001:db8:99::/64' }), 'error')).toContain('network.fortios.dhcp6-range-outside');
  });

  it('writes IPv6 trusted hosts to ip6-trusthostN', () => {
    const change = run('fortios_admin_access', { trusted_hosts: '10.0.0.0/24, 2001:db8:a::/64' });
    const config = text(change);
    expect(config).toContain('set trusthost1 10.0.0.0 255.255.255.0');
    expect(config).toContain('set ip6-trusthost1 2001:db8:a::/64');
    expect(change.backout.join('\n')).toContain('unset ip6-trusthost1');
    expect(codes(change)).not.toContain('network.fortios.no-ip6-trusthost');
    expect(codes(run('fortios_admin_access', { trusted_hosts: '2001:db8:a::/64' }), 'error')).toEqual([]);
  });

  it('sends SNMP traps to IPv6 managers with notify-hosts6', () => {
    const config = text(run('fortios_logging', { snmp_host: '10.0.0.40, 2001:db8::40', syslog_server: '2001:db8::20' }));
    expect(config).toContain('set notify-hosts 10.0.0.40');
    expect(config).toContain('set notify-hosts6 2001:db8::40');
    expect(config).toContain('set server "2001:db8::20"');
  });

  it('health-checks SD-WAN over IPv6 and steers an IPv6 rule with dst6', () => {
    const change = run('fortios_sdwan', { members: 'port1 203.0.113.1 2001:db8:1::1 1\nport3 198.51.100.1 2001:db8:3::1 2', health_server: '2001:4860:4860::8888', rule_family: 'ipv6', rule_destination: 'all' });
    const config = text(change);
    expect(config).toContain('set gateway 203.0.113.1\n            set gateway6 2001:db8:1::1\n            set cost 1');
    expect(config).toContain('set addr-mode ipv6\n            set server "2001:4860:4860::8888"');
    expect(config).toContain('set addr-mode ipv6\n            set dst6 "all"');
    expect(codes(change, 'warning')).not.toContain('network.fortios.sdwan-no-gateway6');
    expect(codes(run('fortios_sdwan', { health_server: '2001:4860:4860::8888' }), 'warning')).toContain('network.fortios.sdwan-no-gateway6');
  });

  it('restricts IPv6 with local-in-policy6 naming an addrgrp6', () => {
    const change = run('fortios_local_in_policy', { allowed_addresses: '10.0.1.0/24, 2001:db8:1::/64' });
    const config = text(change);
    expect(config).toContain('config firewall local-in-policy\n');
    expect(config).toContain('config firewall address6\n  edit "MGMT-NETWORKS-V6-1"\n    set ip6 2001:db8:1::/64');
    expect(config).toContain('config firewall addrgrp6\n  edit "MGMT-NETWORKS-V6"');
    expect(config).toContain('config firewall local-in-policy6\n  edit 0\n    set intf "port1"\n    set srcaddr "MGMT-NETWORKS-V6"');
    // An IPv6 rule never names the IPv4 group, and the reverse.
    expect(config.split('config firewall local-in-policy6')[1]).not.toContain('"MGMT-NETWORKS"');
    expect(change.backout.join('\n')).not.toContain('purge');
  });

  it('shapes IPv6 traffic with srcaddr6/dstaddr6', () => {
    const config = text(run('fortios_traffic_shaping', { ip_version: '6', policy_kind: 'address', source: 'GRP6-USERS', destination: 'all' }));
    expect(config).toContain('set ip-version 6\n    set srcaddr6 "GRP6-USERS"\n    set dstaddr6 "all"');
  });
});

describe('FortiOS IPv6 changes build like any other', () => {
  const V6: readonly [string, BlueprintValues][] = [
    ['fortios_address_objects', { addresses: 'V6-NET 2001:db8:40::/64' }],
    ['fortios_firewall_policy', { source6: 'all', destination6: 'GRP6-APP' }],
    ['fortios_vip', { external: '2001:db8:ffff::10', internal: '2001:db8:30::11' }],
    ['fortios_static_route', { prefix: '::/0', gateway: '2001:db8:1::1' }],
    ['fortios_interface', { address: '2001:db8:30::1/64' }],
    ['fortios_ipsec_vpn', { remote_gateway: '2001:db8:ffff::10', local_subnet: '2001:db8:20::/48', remote_subnet: '2001:db8:30::/48' }],
    ['fortios_ip_pool', { start_ip: '2001:db8:ffff::20', end_ip: '2001:db8:ffff::2f' }],
    ['fortios_dhcp_server', { range_start: '2001:db8:30::100', range_end: '2001:db8:30::1ff', dns: '2001:db8::53', gateway: '' }],
    ['fortios_admin_access', { trusted_hosts: '2001:db8:a::/64' }],
    ['fortios_ssl_vpn', { pool_range: 'fd00::200-fd00::250', split_networks6: 'CORP6' }],
    ['fortios_local_in_policy', { allowed_addresses: '2001:db8:1::/64' }],
    ['fortios_dynamic_routing', { peer: '2001:db8:12::1', advertise: '2001:db8:20::/48' }],
  ];

  it('writes a configuration, a record and a playbook, with no errors', () => {
    for (const [id, values] of V6) {
      const blueprint = FORTIOS_CHANGES.find((b) => b.id === id)!;
      const merged = { ...defaultValues(blueprint), ...values };
      const change = blueprint.change(merged, id);
      expect([id, codes(change, 'error')]).toEqual([id, []]);
      expect([id, change.verify.length > 0 && change.backout.length > 0]).toEqual([id, true]);
      const result = blueprint.build(merged, id);
      expect([id, Object.keys(result.files).includes('change-record.md')]).toEqual([id, true]);
      for (const [name, body] of Object.entries(result.files)) if (name.endsWith('.yml')) expect([id, name, readYaml(body).documents.length]).toEqual([id, name, 1]);
    }
  });

  it('never mixes an IPv4 value into an IPv6 table line or the reverse', () => {
    for (const [id, values] of V6) {
      for (const line of run(id, values).config) {
        if (/\b(set ip6|ip6-address|ip6-trusthost\d|remote-gw6|subnet6|prefix6|notify-hosts6)\b/.test(line)) expect([id, line, /\d+\.\d+\.\d+\.\d+/.test(line)]).toEqual([id, line, false]);
        // dhcp6 server's `set subnet` is the IPv6 one; everywhere else these are IPv4 attributes.
        if (/set (subnet|trusthost\d|remote-gw|notify-hosts) /.test(line) && id !== 'fortios_dhcp_server') expect([id, line, line.includes(':')]).toEqual([id, line, false]);
      }
    }
  });
});
