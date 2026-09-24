import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { byFamily, containsAny, familyOf, formatHostPort, isAnyNetwork, isIp, overlapsAny, parseCidrAny, splitHostPort, urlHost } from './ip.ts';

describe('ip: one door for both families', () => {
  it('tells the family, and rejects what is neither', () => {
    expect(familyOf('10.0.0.1')).toBe(4);
    expect(familyOf('10.0.0.0/8')).toBe(4);
    expect(familyOf('2001:db8::1')).toBe(6);
    expect(familyOf('2001:db8::/32')).toBe(6);
    expect(familyOf('10.0.0.0/33')).toBe(null);
    expect(familyOf('2001:db8::/129')).toBe(null);
    expect(familyOf('host.example.com')).toBe(null);
    expect(isIp('fe80::1')).toBe(true);
    expect(isIp('10.0.0.0/24')).toBe(false);
  });

  it('parses networks of both families to canonical form', () => {
    expect(parseCidrAny('10.0.0.5/24')).toEqual({ family: 4, address: '10.0.0.5', prefix: 24, network: '10.0.0.0' });
    expect(parseCidrAny('2001:0DB8:0:0::5/64')).toEqual({ family: 6, address: '2001:db8::5', prefix: 64, network: '2001:db8::' });
    expect(parseCidrAny('2001:db8::1')?.prefix).toBe(128);
  });

  it('checks overlap, containment and "everything" for both', () => {
    expect(overlapsAny('10.0.0.0/16', '10.0.5.0/24')).toBe(true);
    expect(overlapsAny('2001:db8::/32', '2001:db8:5::/48')).toBe(true);
    expect(overlapsAny('2001:db8::/32', '2001:db9::/32')).toBe(false);
    expect(overlapsAny('10.0.0.0/8', '::/0')).toBe(false);
    expect(containsAny('2001:db8::/32', '2001:db8:ff::1')).toBe(true);
    expect(containsAny('10.0.0.0/16', '10.1.0.1')).toBe(false);
    expect(isAnyNetwork('::/0')).toBe(true);
    expect(isAnyNetwork('0.0.0.0/0')).toBe(true);
    expect(isAnyNetwork('10.0.0.0/8')).toBe(false);
  });

  it('writes and reads host:port with IPv6 in brackets', () => {
    expect(formatHostPort('2001:db8::10', 9997)).toBe('[2001:db8::10]:9997');
    expect(formatHostPort('10.0.0.10', 9997)).toBe('10.0.0.10:9997');
    expect(splitHostPort('[2001:db8::10]:9997')).toEqual({ host: '2001:db8::10', port: 9997 });
    expect(splitHostPort('2001:db8::10')).toEqual({ host: '2001:db8::10', port: null });
    expect(splitHostPort('idx01.example.com:9997')).toEqual({ host: 'idx01.example.com', port: 9997 });
    expect(urlHost('2001:db8::1')).toBe('[2001:db8::1]');
    expect(byFamily(['10.0.0.1', '2001:db8::1', 'nope'])).toEqual({ v4: ['10.0.0.1'], v6: ['2001:db8::1'], invalid: ['nope'] });
  });
});
