/**
 * Arista EOS, dual stack.
 *
 * Every address field on an EOS switch takes IPv6 as well as IPv4, and what
 * comes out is EOS syntax: `ipv6 address`, `ipv6 virtual-router address`,
 * `ipv6 address virtual`, `ipv6 access-group`, an `ipv6 prefix-list` mode,
 * `ipv6 dhcp relay destination`, IPv6 peers in their own peer group activated
 * in `address-family ipv6`. MLAG peering and sFlow collectors over IPv6 are
 * not confirmed, so those refuse it with an error. IPv4 input still produces
 * exactly what it did before.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { defaultValues } from '../../kit/blueprint.ts';
import { EOS_CHANGES } from './eos.ts';
import type { DeviceChange } from '../device.ts';

const blueprint = (id: string) => {
  const b = EOS_CHANGES.find((x) => x.id === id);
  if (!b) throw new Error(`no blueprint ${id}`);
  return b;
};
const build = (id: string, values: Record<string, string | number | boolean> = {}): DeviceChange => {
  const b = blueprint(id);
  return b.change({ ...defaultValues(b), ...values }, id);
};
const errors = (c: DeviceChange) => (c.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code);
const has = (lines: readonly string[], line: string) => lines.map((l) => l.trim()).includes(line);

describe('EOS accepts and writes IPv6', () => {
  it('SVI: dual-stack address, VARP for both families, and IPv6 routing on', () => {
    const c = build('eos_vlan_svi', { address: '10.30.100.2/24, 2001:db8:100::2/64', varp: '10.30.100.1, 2001:db8:100::1' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ipv6 unicast-routing')).toBe(true);
    expect(has(c.config, 'ip address 10.30.100.2/24')).toBe(true);
    expect(has(c.config, 'ipv6 address 2001:db8:100::2/64')).toBe(true);
    expect(has(c.config, 'ip virtual-router address 10.30.100.1')).toBe(true);
    expect(has(c.config, 'ipv6 virtual-router address 2001:db8:100::1')).toBe(true);
  });

  it('management: an ipv6 access-list on management ssh', () => {
    const c = build('eos_management_baseline', { management_acl: '10.0.0.0/24, 2001:db8:0:100::/64', syslog_servers: '2001:db8::20' });
    expect(has(c.config, 'ipv6 access-list ACL-MGMT-V6')).toBe(true);
    expect(has(c.config, '10 permit ipv6 2001:db8:0:100::/64 any')).toBe(true);
    expect(has(c.config, 'ipv6 access-group ACL-MGMT-V6 in')).toBe(true);
    expect(has(c.config, 'ip access-group ACL-MGMT in')).toBe(true);
    expect(has(c.config, 'logging vrf MGMT host 2001:db8::20')).toBe(true);
  });

  it('VXLAN: ipv6 address virtual for the anycast gateway', () => {
    const c = build('eos_vxlan_vtep', { anycast_gateway: '10.100.0.1/24, 2001:db8:100::1/64', vrf: 'TENANT-A' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ip address virtual 10.100.0.1/24')).toBe(true);
    expect(has(c.config, 'ipv6 address virtual 2001:db8:100::1/64')).toBe(true);
    expect(has(c.config, 'ipv6 unicast-routing vrf TENANT-A')).toBe(true);
  });

  it('routed port, port-channel and loopback', () => {
    const r = build('eos_routed_port', { address: '2001:db8:0:12::/127' });
    expect(errors(r)).toEqual([]);
    expect(has(r.config, 'ipv6 address 2001:db8:0:12::/127')).toBe(true);
    expect(r.config.some((l) => l.trim().startsWith('ip address'))).toBe(false);
    const p = build('eos_port_channel', { mode: 'routed', address: '10.0.12.1/31, 2001:db8:0:12::/127' });
    expect(has(p.config, 'ipv6 address 2001:db8:0:12::/127')).toBe(true);
    expect(has(p.config, 'ip address 10.0.12.1/31')).toBe(true);
    const l = build('eos_loopback', { address: '10.255.0.11/32, 2001:db8::11/128', local_as: 65101 });
    const af6 = l.config.findIndex((x) => x.trim() === 'address-family ipv6');
    expect(af6 > -1).toBe(true);
    expect(l.config[af6 + 1]!.trim()).toBe('network 2001:db8::11/128');
  });

  it('BGP underlay: IPv6 peers in their own group, activated only in address-family ipv6', () => {
    const c = build('eos_bgp_underlay', { peers: '10.0.1.0 65100\n2001:db8:0:1:: 65100', advertise: '10.255.0.11/32\n2001:db8::11/128' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'neighbor 2001:db8:0:1:: peer group UNDERLAY-V6')).toBe(true);
    expect(has(c.config, 'neighbor 10.0.1.0 peer group UNDERLAY')).toBe(true);
    const af4 = c.config.findIndex((x) => x.trim() === 'address-family ipv4');
    const af6 = c.config.findIndex((x) => x.trim() === 'address-family ipv6');
    expect(c.config.slice(af4, af6).map((x) => x.trim())).toEqual(['address-family ipv4', 'neighbor UNDERLAY activate', 'network 10.255.0.11/32', '!']);
    expect(c.config.slice(af6).map((x) => x.trim())).toEqual(['address-family ipv6', 'neighbor UNDERLAY-V6 activate', 'network 2001:db8::11/128', '!']);
  });

  it('static route: ipv6 route, and a mixed-family route is refused', () => {
    const c = build('eos_static_route', { prefix: '::/0', next_hop: '2001:db8::1' });
    expect(c.config).toEqual(['ipv6 route ::/0 2001:db8::1 name DEFAULT']);
    expect(errors(build('eos_static_route', { prefix: '::/0', next_hop: '10.0.0.1' }))).toContain('network.eos.route-family');
    expect(errors(build('eos_static_route', { prefix: '::/0', next_hop: 'fe80::1' }))).toContain('network.eos.link-local-hop');
  });

  it('ACL: an ipv6 access-list with icmpv6, applied with ipv6 access-group', () => {
    const c = build('eos_acl', { rules: 'permit tcp 2001:db8::/64 any eq https\npermit icmp any any', apply_to: 'Ethernet1' });
    expect(has(c.config, 'ipv6 access-list ACL-TENANT-IN-V6')).toBe(true);
    expect(has(c.config, '10 permit tcp 2001:db8::/64 any eq https')).toBe(true);
    expect(has(c.config, '20 permit icmpv6 any any')).toBe(true);
    expect(has(c.config, '30 deny ipv6 any any log')).toBe(true);
    expect(has(c.config, 'ipv6 access-group ACL-TENANT-IN-V6 in')).toBe(true);
    // The rule with no address still protects IPv4.
    expect(has(c.config, '10 permit icmp any any')).toBe(true);
    expect(errors(build('eos_acl', { rules: 'permit ip 10.0.0.0/8 2001:db8::/32' }))).toContain('network.eos.acl-mixed-family');
  });

  it('VARP and VRRP gateways for IPv6', () => {
    const v = build('eos_varp', { real_address: '10.0.10.2/24, 2001:db8:0:10::2/64', virtual_address: '10.0.10.1, 2001:db8:0:10::1' });
    expect(errors(v)).toEqual([]);
    expect(has(v.config, 'ipv6 virtual-router address 2001:db8:0:10::1')).toBe(true);
    expect(has(v.config, 'ipv6 address 2001:db8:0:10::2/64')).toBe(true);
    const r = build('eos_varp', { style: 'vrrp', real_address: '2001:db8:0:10::2/64', virtual_address: '2001:db8:0:10::1' });
    expect(errors(r)).toEqual([]);
    expect(has(r.config, 'vrrp 10 ipv6 2001:db8:0:10::1')).toBe(true);
    expect(r.config.some((l) => l.includes('ipv4'))).toBe(false);
    expect(errors(build('eos_varp', { virtual_address: '2001:db8:0:10::1' }))).toContain('network.eos.gateway-family');
  });

  it('DHCP relay, VRF default route, prefix list and telemetry', () => {
    const d = build('eos_dhcp_relay', { servers: '10.0.1.10, 2001:db8::10' });
    expect(has(d.config, 'ip helper-address 10.0.1.10')).toBe(true);
    expect(has(d.config, 'ipv6 dhcp relay destination 2001:db8::10')).toBe(true);
    const f = build('eos_vrf', { default_route: '10.0.0.1, 2001:db8::1' });
    expect(has(f.config, 'ip route vrf TENANT-A 0.0.0.0/0 10.0.0.1')).toBe(true);
    expect(has(f.config, 'ipv6 route vrf TENANT-A ::/0 2001:db8::1')).toBe(true);
    expect(has(f.config, 'ipv6 unicast-routing vrf TENANT-A')).toBe(true);
    const p = build('eos_prefix_list_routemap', { prefixes: '10.10.0.0/16 le 24\n2001:db8::/32 le 48' });
    expect(errors(p)).toEqual([]);
    expect(has(p.config, 'ipv6 prefix-list PL-TENANT-IN-V6')).toBe(true);
    expect(has(p.config, 'seq 5 permit 2001:db8::/32 le 48')).toBe(true);
    expect(has(p.config, 'seq 10 deny ::/0 le 128')).toBe(true);
    expect(has(p.config, 'match ipv6 address prefix-list PL-TENANT-IN-V6')).toBe(true);
    expect(p.config.some((l) => l.includes('ip prefix-list') && l.includes('2001'))).toBe(false);
    expect(errors(build('eos_prefix_list_routemap', { prefixes: '2001:db8::/32 le 129' }))).toContain('network.eos.bad-prefix');
    const t = build('eos_telemetry', { servers: '[2001:db8::80]:9910' });
    expect(t.config.some((l) => l.includes('-ingestgrpcurl=[2001:db8::80]:9910'))).toBe(true);
    expect(errors(build('eos_telemetry', { servers: '2001:db8::80' }))).toContain('network.eos.collector-port');
  });
});

describe('EOS refuses IPv6 where it is not confirmed', () => {
  it('MLAG peering over IPv6', () => {
    const c = build('eos_mlag_domain', { local_address: '2001:db8:ffff::1/64', peer_address: '2001:db8:ffff::2' });
    expect(errors(c)).toContain('network.eos.mlag-ipv6');
    expect(c.config.some((l) => l.includes('2001:'))).toBe(false);
  });

  it('an IPv6 sFlow collector, EVPN to IPv6 spines, and an IPv6 router id', () => {
    const s = build('eos_sflow', { collector: '2001:db8::40' });
    expect(errors(s)).toContain('network.eos.sflow-ipv6');
    expect(s.config.some((l) => l.includes('destination'))).toBe(false);
    const e = build('eos_bgp_evpn_leaf', { spines: '10.255.0.1, 2001:db8::1' });
    expect(errors(e)).toContain('network.eos.evpn-ipv6-peer');
    expect(e.config.some((l) => l.includes('2001:'))).toBe(false);
    expect(errors(build('eos_bgp_underlay', { router_id: '2001:db8::11' }))).toContain('network.eos.router-id');
  });
});

describe('EOS IPv4 output is unchanged', () => {
  it('SVI, static route, ACL and prefix list', () => {
    expect(build('eos_vlan_svi').config).toEqual([
      'vlan 100',
      '   name APP_TIER',
      '!',
      'interface Vlan100',
      '   description APP_TIER',
      '   mtu 9214',
      '   ip address 10.30.100.2/24',
      '   ip virtual-router address 10.30.100.1',
      '   no shutdown',
      '!',
    ]);
    expect(build('eos_static_route').config).toEqual(['ip route 0.0.0.0/0 10.0.0.1 name DEFAULT']);
    expect(build('eos_acl').config).toEqual([
      'ip access-list ACL-TENANT-IN',
      '   counters per-entry',
      '   10 permit tcp 10.100.0.0/24 any eq https',
      '   20 permit udp 10.100.0.0/24 host 10.0.0.10 eq domain',
      '   30 deny ip any any log',
      '!',
    ]);
    const p = build('eos_prefix_list_routemap').config;
    expect(p.filter((l) => l.includes('prefix-list'))).toEqual([
      '  no ip prefix-list PL-TENANT-IN',
      '  ip prefix-list PL-TENANT-IN seq 5 permit 10.10.0.0/16 le 24',
      '  ip prefix-list PL-TENANT-IN seq 10 permit 10.20.0.0/16',
      '  ip prefix-list PL-TENANT-IN seq 15 deny 0.0.0.0/0 le 32',
      '    match ip address prefix-list PL-TENANT-IN',
    ]);
  });

  it('no default build carries an error, or an IPv6 line', () => {
    for (const b of EOS_CHANGES) {
      if (b.id === 'eos_ipv6_interface') continue;
      const c = b.change(defaultValues(b), b.id);
      expect([b.id, errors(c)]).toEqual([b.id, []]);
      expect([b.id, c.config.some((l) => /\bipv6\b/.test(l))]).toEqual([b.id, false]);
    }
  });
});
