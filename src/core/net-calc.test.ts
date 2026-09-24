import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { checkContains, checkContains6, checkOverlap, checkOverlap6, describeIPv6, describeSubnet, splitSubnet, splitSubnet6, supernet, supernet6, vlsm, vlsm6 } from './net-calc.ts';

describe('net-calc: one subnet', () => {
  it('describes a /22 from an address inside it', () => {
    const d = describeSubnet('10.20.30.40/22');
    if (typeof d === 'string') throw new Error(d);
    expect(d.network).toBe('10.20.28.0');
    expect(d.broadcast).toBe('10.20.31.255');
    expect(d.netmask).toBe('255.255.252.0');
    expect(d.wildcard).toBe('0.0.3.255');
    expect(d.firstHost).toBe('10.20.28.1');
    expect(d.lastHost).toBe('10.20.31.254');
    expect(d.usable).toBe(1022);
    expect(d.kind).toBe('Private (RFC 1918)');
    expect(d.next).toBe('10.20.32.0/22');
    expect(d.hostBitsSet).toBe(true);
    expect(d.reverseZone).toBe('20.10.in-addr.arpa');
  });

  it('takes a dotted mask, and knows /31 and /32', () => {
    const d = describeSubnet('192.168.1.7 255.255.255.0');
    if (typeof d === 'string') throw new Error(d);
    expect(d.prefix).toBe(24);
    const p2p = describeSubnet('10.0.0.0/31');
    if (typeof p2p === 'string') throw new Error(p2p);
    expect(p2p.usable).toBe(2);
    expect(p2p.firstHost).toBe('10.0.0.0');
    expect(typeof describeSubnet('10.0.0.1 255.0.255.0')).toBe('string');
    expect(typeof describeSubnet('300.1.1.1/24')).toBe('string');
  });

  it('names the special ranges', () => {
    const k = (t: string) => (describeSubnet(t) as { kind: string }).kind;
    expect(k('100.64.1.1/10')).toBe('Shared address space / CGNAT (RFC 6598)');
    expect(k('169.254.10.1/16')).toBe('Link-local (APIPA)');
    expect(k('8.8.8.8')).toBe('Public');
  });
});

describe('net-calc: split, VLSM, checks', () => {
  it('splits by prefix and by count', () => {
    const byPrefix = splitSubnet('10.0.0.0/22', { prefix: 24 });
    if (typeof byPrefix === 'string') throw new Error(byPrefix);
    expect(byPrefix.rows.map((r) => r.cidr)).toEqual(['10.0.0.0/24', '10.0.1.0/24', '10.0.2.0/24', '10.0.3.0/24']);
    const byCount = splitSubnet('10.0.0.0/24', { count: 3 });
    if (typeof byCount === 'string') throw new Error(byCount);
    expect(byCount.total).toBe(4);
    expect(byCount.rows[0]!.cidr).toBe('10.0.0.0/26');
    expect(typeof splitSubnet('10.0.0.0/24', { prefix: 20 })).toBe('string');
  });

  it('allocates VLSM biggest first, aligned, and reports what does not fit', () => {
    const out = vlsm('10.10.0.0/24', [
      { name: 'mgmt', hosts: 20 },
      { name: 'vmotion', hosts: 100 },
      { name: 'p2p', hosts: 2 },
      { name: 'huge', hosts: 500 },
    ]);
    if (typeof out === 'string') throw new Error(out);
    expect(out.rows.map((r) => `${r.name} ${r.cidr}`)).toEqual(['vmotion 10.10.0.0/25', 'mgmt 10.10.0.128/27', 'p2p 10.10.0.160/31']);
    expect(out.unallocated.length).toBe(1);
    expect(out.unallocated[0]!.startsWith('huge')).toBe(true);
  });

  it('checks containment, overlap and the covering supernet', () => {
    expect(checkContains('10.0.0.0/16', '10.0.4.7').startsWith('Yes')).toBe(true);
    expect(checkContains('10.0.0.0/16', '10.1.0.1').startsWith('No')).toBe(true);
    expect(checkOverlap('10.0.0.0/16', '10.0.128.0/20')).toBe('Overlap: 10.0.128.0/20 is inside 10.0.0.0/16.');
    expect(checkOverlap('10.0.0.0/24', '10.0.1.0/24').startsWith('No overlap')).toBe(true);
    expect(supernet(['10.0.0.0/24', '10.0.1.0/24', '10.0.3.0/24']).startsWith('10.0.0.0/22 covers all 3')).toBe(true);
  });
});

describe('net-calc: IPv6', () => {
  it('compresses, expands and gives the prefix range', () => {
    const d = describeIPv6('2001:0db8:0000:0000:0000:ff00:0042:8329/48');
    if (typeof d === 'string') throw new Error(d);
    expect(d.compressed).toBe('2001:db8::ff00:42:8329');
    expect(d.expanded).toBe('2001:0db8:0000:0000:0000:ff00:0042:8329');
    expect(d.network).toBe('2001:db8::/48');
    expect(d.last).toBe('2001:db8:0:ffff:ffff:ffff:ffff:ffff');
    expect(d.subnets64).toBe('2^16 (65,536)');
    expect(d.kind).toBe('Global unicast');
    expect((describeIPv6('fe80::1/64') as { kind: string }).kind).toBe('Link-local');
    expect(typeof describeIPv6('2001:db8:::1')).toBe('string');
  });
});

describe('net-calc: IPv6 networks', () => {
  it('splits a /48 into /64s and by count', () => {
    const s = splitSubnet6('2001:db8:100::/48', { prefix: 64 });
    if (typeof s === 'string') throw new Error(s);
    expect(s.total).toBe(65536n);
    expect(s.rows.length).toBe(1024);
    expect(s.rows[1]!.cidr).toBe('2001:db8:100:1::/64');
    const c = splitSubnet6('2001:db8::/56', { count: 4 });
    if (typeof c === 'string') throw new Error(c);
    expect(c.rows.map((r) => r.cidr)).toEqual(['2001:db8::/58', '2001:db8:0:40::/58', '2001:db8:0:80::/58', '2001:db8:0:c0::/58']);
  });

  it('allocates /64 LANs and /127 links', () => {
    const v = vlsm6('2001:db8:100::/60', [
      { name: 'p2p', hosts: 2 },
      { name: 'servers', hosts: 300 },
      { name: 'users', hosts: 40 },
    ]);
    if (typeof v === 'string') throw new Error(v);
    expect(v.rows.map((r) => `${r.name} ${r.cidr}`)).toEqual(['servers 2001:db8:100::/64', 'users 2001:db8:100:1::/64', 'p2p 2001:db8:100:2::/127']);
  });

  it('checks containment, overlap and the supernet', () => {
    expect(checkContains6('2001:db8::/32', '2001:db8:5::7').startsWith('Yes')).toBe(true);
    expect(checkContains6('2001:db8::/32', '2001:db9::1').startsWith('No')).toBe(true);
    expect(checkOverlap6('2001:db8::/32', '2001:db8:5::/48')).toBe('Overlap: 2001:db8:5::/48 is inside 2001:db8::/32.');
    expect(supernet6(['2001:db8:0:1::/64', '2001:db8:0:2::/64', '2001:db8:0:3::/64'])).toBe('2001:db8::/62 covers all 3.');
  });
});
