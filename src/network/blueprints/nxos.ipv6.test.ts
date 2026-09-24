/**
 * NX-OS, dual stack.
 *
 * Every address field on a Nexus takes IPv6 as well as IPv4, and what comes
 * out has to be what NX-OS actually accepts: `ipv6 address`, `hsrp N ipv6`
 * under `hsrp version 2`, `ipv6 access-class`, `ipv6 traffic-filter`, a
 * separate `ipv6 prefix-list`. Where IPv6 is not confirmed for a feature
 * (vPC keepalive, PIM6, PTP) the change refuses it with an error rather than
 * writing something the switch rejects. And IPv4 input still produces exactly
 * what it did before.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { defaultValues } from '../../kit/blueprint.ts';
import { NXOS_CHANGES } from './nxos.ts';
import { dualAddresses, dualCidrs, ipv6Rule, prefixEntry, routerIdFindings, ruleFamily } from './nxos-eos-dual.ts';
import type { DeviceChange } from '../device.ts';

const blueprint = (id: string) => {
  const b = NXOS_CHANGES.find((x) => x.id === id);
  if (!b) throw new Error(`no blueprint ${id}`);
  return b;
};
const build = (id: string, values: Record<string, string | number | boolean> = {}): DeviceChange => {
  const b = blueprint(id);
  return b.change({ ...defaultValues(b), ...values }, id);
};
const errors = (c: DeviceChange) => (c.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code);
const has = (lines: readonly string[], line: string) => lines.map((l) => l.trim()).includes(line);

describe('the dual-stack helpers', () => {
  it('split one address of each family and flag the rest', () => {
    const d = dualCidrs('10.0.0.2/24, 2001:DB8:0:0::2/64');
    expect(d.v4?.text).toBe('10.0.0.2/24');
    expect(d.v6?.text).toBe('2001:db8::2/64');
    expect(dualCidrs('10.0.0.2/24, 10.0.1.2/24').repeated).toEqual([4]);
    expect(dualCidrs('nonsense').invalid).toEqual(['nonsense']);
    expect(dualAddresses('10.0.0.1, 2001:db8::1').v6).toBe('2001:db8::1');
    expect(dualAddresses('2001:db8::1/64').invalid).toHaveLength(1);
  });

  it('tells an ACL rule’s family, and rewrites the protocol for an IPv6 list', () => {
    expect(ruleFamily('permit tcp 10.0.0.0/24 any eq 443')).toBe(4);
    expect(ruleFamily('permit tcp 2001:db8::/64 any eq 443')).toBe(6);
    expect(ruleFamily('permit tcp any any eq 22')).toBeNull();
    expect(ruleFamily('permit ip 10.0.0.0/8 2001:db8::/32')).toBe('mixed');
    expect(ipv6Rule('permit ip 2001:db8::/64 any', 'icmp')).toBe('permit ipv6 2001:db8::/64 any');
    expect(ipv6Rule('permit icmp any any', 'icmpv6')).toBe('permit icmpv6 any any');
  });

  it('checks prefix-list ge/le against the family’s width', () => {
    expect(prefixEntry('2001:db8::/32 le 64')).toEqual({ family: 6, text: '2001:db8::/32 le 64' });
    expect(typeof prefixEntry('2001:db8::/32 le 129')).toBe('string');
    expect(typeof prefixEntry('10.0.0.0/8 le 33')).toBe('string');
  });

  it('keeps a router id dotted', () => {
    expect(routerIdFindings('x', '10.255.0.1')).toHaveLength(0);
    expect(routerIdFindings('x', '2001:db8::1')).toHaveLength(1);
  });
});

describe('NX-OS accepts and writes IPv6', () => {
  it('SVI: dual-stack address and an IPv6 HSRP group under version 2', () => {
    const c = build('nxos_vlan_svi', { address: '10.20.100.2/24, 2001:db8:100::2/64', hsrp: '10.20.100.1, 2001:db8:100::1' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'ip address 10.20.100.2/24')).toBe(true);
    expect(has(c.config, 'ipv6 address 2001:db8:100::2/64')).toBe(true);
    const v2 = c.config.findIndex((l) => l.trim() === 'hsrp version 2');
    const g6 = c.config.findIndex((l) => l.trim() === 'hsrp 100 ipv6');
    expect(v2 > -1 && g6 > v2).toBe(true);
    expect(c.config[g6 + 1]!.trim()).toBe('ip 2001:db8:100::1');
    expect(has(c.config, 'hsrp 100')).toBe(true);
  });

  it('SVI: an IPv6 virtual address with no IPv6 on the SVI is refused', () => {
    expect(errors(build('nxos_vlan_svi', { hsrp: '2001:db8:100::1' }))).toContain('network.nxos.hsrp-family');
  });

  it('management: IPv6 sources get their own list and ipv6 access-class', () => {
    const c = build('nxos_management_baseline', { management_acl: '10.0.0.0/24, 2001:db8:0:100::/64', ntp_servers: '2001:db8::10' });
    expect(has(c.config, 'ipv6 access-list ACL-MGMT-V6')).toBe(true);
    expect(has(c.config, '10 permit ipv6 2001:db8:0:100::/64 any')).toBe(true);
    expect(has(c.config, 'ipv6 access-class ACL-MGMT-V6 in')).toBe(true);
    expect(has(c.config, 'access-class ACL-MGMT in')).toBe(true);
    expect(has(c.config, 'ntp server 2001:db8::10 use-vrf management')).toBe(true);
    // Nothing IPv6 in the IPv4 list, and the reverse.
    const v4 = c.config.slice(c.config.indexOf('ip access-list ACL-MGMT'), c.config.indexOf('ipv6 access-list ACL-MGMT-V6'));
    expect(v4.some((l) => l.includes(':'))).toBe(false);
  });

  it('routed interface and port-channel: ipv6 address, and never on a member', () => {
    const r = build('nxos_routed_interface', { address: '2001:db8:0:12::1/64' });
    expect(errors(r)).toEqual([]);
    expect(has(r.config, 'ipv6 address 2001:db8:0:12::1/64')).toBe(true);
    expect(r.config.some((l) => l.trim().startsWith('ip address'))).toBe(false);
    const p = build('nxos_port_channel', { mode: 'routed', address: '10.0.12.1/30, 2001:db8:0:12::1/64' });
    const member = p.config.indexOf('interface Ethernet1/9');
    expect(p.config.slice(member).some((l) => l.includes('address'))).toBe(false);
    expect(has(p.config, 'ipv6 address 2001:db8:0:12::1/64')).toBe(true);
  });

  it('VXLAN: anycast gateway with ipv6 address and the VRF’s IPv6 family', () => {
    const c = build('nxos_vxlan_vni', { anycast_gateway: '10.100.0.1/24, 2001:db8:100::1/64' });
    expect(has(c.config, 'ipv6 address 2001:db8:100::1/64')).toBe(true);
    expect(has(c.config, 'fabric forwarding mode anycast-gateway')).toBe(true);
    expect(has(c.config, 'address-family ipv6 unicast')).toBe(true);
  });

  it('anycast and HSRP gateways take IPv6', () => {
    const a = build('nxos_fhrp', { gateway: '2001:db8:0:10::1/64' });
    expect(errors(a)).toEqual([]);
    expect(has(a.config, 'ipv6 address 2001:db8:0:10::1/64')).toBe(true);
    const h = build('nxos_fhrp', { style: 'hsrp', gateway: '10.0.10.1/24, 2001:db8:0:10::1/64', real_address: '10.0.10.2/24, 2001:db8:0:10::2/64' });
    expect(errors(h)).toEqual([]);
    expect(has(h.config, 'hsrp version 2')).toBe(true);
    expect(has(h.config, 'hsrp 10 ipv6')).toBe(true);
    expect(has(h.config, 'ip 2001:db8:0:10::1')).toBe(true);
  });

  it('BGP: an IPv6 neighbour activates ipv6 unicast', () => {
    const c = build('nxos_bgp_neighbor', { neighbor: '2001:db8::1' });
    expect(errors(c)).toEqual([]);
    expect(has(c.config, 'neighbor 2001:db8::1')).toBe(true);
    expect(has(c.config, 'address-family ipv6 unicast')).toBe(true);
    expect(has(c.config, 'address-family ipv4 unicast')).toBe(false);
  });

  it('static route: ipv6 route, and a mixed-family route is refused', () => {
    const c = build('nxos_static_route', { prefix: '::/0', next_hop: '2001:db8::1' });
    expect(c.config).toEqual(['ipv6 route ::/0 2001:db8::1']);
    expect(c.impact).toBe('outage');
    expect(errors(build('nxos_static_route', { prefix: '::/0', next_hop: '10.0.0.1' }))).toContain('network.nxos.route-family');
    expect(errors(build('nxos_static_route', { prefix: '::/0', next_hop: 'fe80::1' }))).toContain('network.nxos.link-local-hop');
  });

  it('ACL: IPv6 rules in an ipv6 access-list on ipv6 traffic-filter; mixed rules refused', () => {
    const c = build('nxos_acl', { rules: 'permit tcp 10.0.0.0/24 any eq 443\npermit tcp 2001:db8::/64 any eq 443\npermit tcp any any eq 22', apply_to: 'Vlan10' });
    const v6 = c.config.slice(c.config.indexOf('ipv6 access-list ACL-TENANT-IN-V6'));
    expect(has(v6, '10 permit tcp 2001:db8::/64 any eq 443')).toBe(true);
    expect(has(v6, '20 permit tcp any any eq 22')).toBe(true);
    expect(has(v6, '30 deny ipv6 any any log')).toBe(true);
    expect(has(c.config, 'ipv6 traffic-filter ACL-TENANT-IN-V6 in')).toBe(true);
    const v4 = c.config.slice(0, c.config.indexOf('ipv6 access-list ACL-TENANT-IN-V6'));
    expect(v4.some((l) => l.includes('2001:'))).toBe(false);
    expect(errors(build('nxos_acl', { rules: 'permit ip 10.0.0.0/8 2001:db8::/32' }))).toContain('network.nxos.acl-mixed-family');
  });

  it('DHCP relay: ipv6 dhcp relay address beside the IPv4 relay', () => {
    const c = build('nxos_dhcp_relay', { servers: '10.0.1.10, 2001:db8::10' });
    expect(has(c.config, 'ip dhcp relay address 10.0.1.10')).toBe(true);
    expect(has(c.config, 'ipv6 dhcp relay address 2001:db8::10')).toBe(true);
    expect(has(c.config, 'ipv6 dhcp relay')).toBe(true);
    expect(c.config.some((l) => l.includes('ip dhcp relay address 2001'))).toBe(false);
  });

  it('VRF leak: ipv6 prefix-list, its own route-map and address family', () => {
    const c = build('nxos_vrf_leak', { prefixes: '10.99.0.0/24\n2001:db8:99::/64' });
    expect(has(c.config, 'ipv6 prefix-list LEAK-SHARED-SERVICES-V6 seq 5 permit 2001:db8:99::/64')).toBe(true);
    expect(has(c.config, 'match ipv6 address prefix-list LEAK-SHARED-SERVICES-V6')).toBe(true);
    expect(has(c.config, 'import map LEAK-SHARED-SERVICES-V6-IN')).toBe(true);
    expect(c.config.some((l) => l.startsWith('ip prefix-list') && l.includes(':'))).toBe(false);
  });
});

describe('NX-OS refuses IPv6 where it is not confirmed', () => {
  it('vPC peer-keepalive', () => {
    const c = build('nxos_vpc_domain', { peer_keepalive_local: '2001:db8::11', peer_keepalive_remote: '2001:db8::12' });
    expect(errors(c)).toContain('network.nxos.keepalive-ipv6');
    expect(c.config.some((l) => l.includes('peer-keepalive'))).toBe(false);
  });

  it('PIM6 and the PTP source', () => {
    const p = build('nxos_pim', { rp_address: '2001:db8::1', groups: 'ff05::/16' });
    expect(errors(p)).toContain('network.nxos.pim6');
    expect(p.config.some((l) => l.includes('2001:db8::1'))).toBe(false);
    const t = build('nxos_ptp', { source_address: '2001:db8::11' });
    expect(errors(t)).toContain('network.nxos.ptp-ipv6');
    expect(t.config.some((l) => l.startsWith('ptp source'))).toBe(false);
  });

  it('EVPN over an IPv6 neighbour, and an IPv6 router id', () => {
    const c = build('nxos_bgp_neighbor', { family: 'evpn', neighbor: '2001:db8::1' });
    expect(errors(c)).toContain('network.nxos.evpn-ipv6-peer');
    expect(c.config.some((l) => l.includes('2001:db8::1'))).toBe(false);
    expect(errors(build('nxos_ospf_underlay', { router_id: '2001:db8::11' }))).toContain('network.nxos.router-id');
  });
});

describe('NX-OS IPv4 output is unchanged', () => {
  it('SVI with HSRP', () => {
    const c = build('nxos_vlan_svi');
    expect(c.config.filter((l) => l.startsWith('  ')).map((l) => l.trim())).toEqual([
      'name APP-TIER',
      'description APP-TIER',
      'mtu 9216',
      'ip address 10.20.100.2/24',
      'no shutdown',
      'hsrp 100',
      'ip 10.20.100.1',
      'priority 110',
      'preempt',
    ]);
  });

  it('management ACL, static route and ACL', () => {
    const m = build('nxos_management_baseline');
    expect(m.config.slice(m.config.indexOf('ip access-list ACL-MGMT'), m.config.indexOf('ip access-list ACL-MGMT') + 8)).toEqual([
      'ip access-list ACL-MGMT',
      '  10 permit ip 10.0.0.0/24 any',
      '  20 deny ip any any log',
      '!',
      'line vty',
      '  access-class ACL-MGMT in',
      '  exec-timeout 10',
      '!',
    ]);
    expect(build('nxos_static_route').config).toEqual(['ip route 0.0.0.0/0 10.0.0.1']);
    expect(build('nxos_acl').config).toEqual([
      'ip access-list ACL-TENANT-IN',
      '  10 permit tcp 10.100.0.0/24 any eq 443',
      '  20 permit udp 10.100.0.0/24 10.0.0.10/32 eq 53',
      '  30 deny ip any any log',
      '!',
    ]);
  });

  it('no default build carries an error, or an IPv6 line', () => {
    for (const b of NXOS_CHANGES) {
      if (b.id === 'nxos_ipv6_interface') continue;
      const c = b.change(defaultValues(b), b.id);
      expect([b.id, errors(c)]).toEqual([b.id, []]);
      expect([b.id, c.config.some((l) => /\bipv6\b/.test(l))]).toEqual([b.id, false]);
    }
  });
});
