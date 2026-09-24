/** Address extraction, sorting and validation — both families, confirmed by core/ip.ts. */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import {
  compareIps,
  findCidrs,
  findEmails,
  findIPv4,
  findIPv6,
  findMacs,
  findUrls,
  rewriteIPv6,
  sortLinesByIp,
  uniqueSortedIps,
  validateIpLines,
} from './network.ts';

const LOG = `Jan 1 12:30:45 fw1 deny tcp 10.0.0.10:443 -> 192.168.1.5 (not 999.1.1.1, not 1.2.3.4.5)
peer FE80::1%eth0 and 2001:DB8:0:0:0:0:0:5, routes 10.1.0.0/16 2001:db8:100::/48 and 10.1.2.3/24.
std::vector<int> and Foo::Bar are code, 00:11:22:33:44:55 is a MAC, as is 0011.2233.4455 and AA-BB-CC-DD-EE-FF.
See https://example.com/path?q=1 (or http://10.0.0.1:8000/x). Mail ops@example.com. Last 10.0.0.9.`;

describe('extraction', () => {
  it('finds valid IPv4 only', () => {
    expect(findIPv4(LOG)).toEqual(['10.0.0.10', '192.168.1.5', '10.1.0.0', '10.1.2.3', '10.0.0.1', '10.0.0.9']);
  });

  it('finds IPv6, compressed, without code or MACs', () => {
    expect(findIPv6(LOG)).toEqual(['fe80::1', '2001:db8::5', '2001:db8:100::']);
  });

  it('finds networks in both families', () => {
    expect(findCidrs(LOG)).toEqual(['10.1.0.0/16', '10.1.2.3/24', '2001:db8:100::/48']);
  });

  it('finds MACs in all three spellings, normalised', () => {
    expect(findMacs(LOG)).toEqual(['00:11:22:33:44:55', '00:11:22:33:44:55', 'aa:bb:cc:dd:ee:ff']);
  });

  it('finds URLs and emails without trailing punctuation', () => {
    expect(findUrls(LOG)).toEqual(['https://example.com/path?q=1', 'http://10.0.0.1:8000/x']);
    expect(findEmails(LOG)).toEqual(['ops@example.com']);
  });
});

describe('sorting', () => {
  it('sorts numerically, IPv4 before IPv6, unique', () => {
    expect(uniqueSortedIps(['10.0.0.10', '::1', '10.0.0.9', '2001:db8::1', '9.9.9.9', '10.0.0.9', 'fe80::1', '2001:db8::/32'])).toEqual([
      '9.9.9.9',
      '10.0.0.9',
      '10.0.0.10',
      '::1',
      '2001:db8::/32',
      '2001:db8::1',
      'fe80::1',
    ]);
    expect(compareIps('10.0.0.0/8', '10.0.0.0/24')).toBeLessThan(0);
  });

  it('sorts lines by their leading address, others last, trailing newline kept', () => {
    expect(sortLinesByIp('10.0.0.10 b\n::1\nhost x\n10.0.0.9,a\n\n2001:db8::1\n')).toBe('10.0.0.9,a\n10.0.0.10 b\n::1\n2001:db8::1\nhost x\n\n');
  });
});

describe('validateIpLines', () => {
  it('reports bad lines and host bits', () => {
    const r = validateIpLines('10.0.0.1\n# comment\n10.0.0.300\n10.0.0.5/24\n2001:db8::/129\n\nfe80::1');
    expect(r.checked).toBe(5);
    expect(r.bad.map((b) => b.line)).toEqual([3, 5]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]!.problem).toContain('10.0.0.0/24');
  });
});

describe('rewriteIPv6', () => {
  it('expands and compresses, keeping prefixes and zones', () => {
    const expanded = rewriteIPv6('a 2001:db8::1/64 fe80::1%eth0 10.0.0.1 std::map', 'expand');
    expect(expanded.text).toBe('a 2001:0db8:0000:0000:0000:0000:0000:0001/64 fe80:0000:0000:0000:0000:0000:0000:0001%eth0 10.0.0.1 std::map');
    expect(expanded.count).toBe(2);
    expect(rewriteIPv6(expanded.text, 'compress').text).toBe('a 2001:db8::1/64 fe80::1%eth0 10.0.0.1 std::map');
  });
});
