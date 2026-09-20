import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  parseIPv4,
  formatIPv4,
  prefixToMask,
  maskToPrefix,
  parseCidr,
  formatCidr,
  broadcastAddress,
  totalAddresses,
  usableAddresses,
  usableRange,
  containsAddress,
  cidrsOverlap,
  rangeSize,
  rangesOverlap,
  allocateRange,
  enumerateRange,
} from './net.ts';

describe('parseIPv4', () => {
  it('parses dotted-quad addresses', () => {
    expect(parseIPv4('0.0.0.0')).toBe(0);
    expect(parseIPv4('10.0.0.1')).toBe(0x0a000001);
    expect(parseIPv4('172.30.0.1')).toBe(0xac1e0001);
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseIPv4('  10.0.0.1  ')).toBe(0x0a000001);
  });

  it('rejects malformed input', () => {
    expect(parseIPv4('10.0.0')).toBeNull();
    expect(parseIPv4('10.0.0.256')).toBeNull();
    expect(parseIPv4('10.0.0.1.1')).toBeNull();
    expect(parseIPv4('ten.0.0.1')).toBeNull();
    expect(parseIPv4('')).toBeNull();
    expect(parseIPv4('10.0.0.-1')).toBeNull();
  });

  it('rejects leading zeros, which are ambiguous', () => {
    expect(parseIPv4('10.0.0.01')).toBeNull();
    expect(parseIPv4('010.0.0.1')).toBeNull();
  });

  it('round-trips through formatIPv4', () => {
    for (const addr of ['0.0.0.0', '10.20.30.40', '192.168.1.254', '255.255.255.255']) {
      expect(formatIPv4(parseIPv4(addr) as number)).toBe(addr);
    }
  });

  it('formats addresses above 2^31 without sign errors', () => {
    // 255.x addresses set the high bit; a signed shift would produce negatives.
    expect(formatIPv4(0xffffffff)).toBe('255.255.255.255');
    expect(formatIPv4(0x80000000)).toBe('128.0.0.0');
  });
});

describe('prefixToMask / maskToPrefix', () => {
  it('converts common prefixes', () => {
    expect(formatIPv4(prefixToMask(24))).toBe('255.255.255.0');
    expect(formatIPv4(prefixToMask(16))).toBe('255.255.0.0');
    expect(formatIPv4(prefixToMask(32))).toBe('255.255.255.255');
    expect(formatIPv4(prefixToMask(0))).toBe('0.0.0.0');
  });

  it('handles /0 without shift overflow', () => {
    expect(prefixToMask(0)).toBe(0);
  });

  it('rejects out-of-range prefixes', () => {
    expect(() => prefixToMask(33)).toThrow(RangeError);
    expect(() => prefixToMask(-1)).toThrow(RangeError);
  });

  it('round-trips every valid prefix', () => {
    for (let p = 0; p <= 32; p += 1) {
      expect(maskToPrefix(prefixToMask(p))).toBe(p);
    }
  });

  it('rejects non-contiguous masks', () => {
    expect(maskToPrefix(parseIPv4('255.0.255.0') as number)).toBeNull();
    expect(maskToPrefix(parseIPv4('255.255.0.255') as number)).toBeNull();
  });
});

describe('parseCidr', () => {
  it('parses and normalises to the network address', () => {
    expect(formatCidr(parseCidr('10.0.0.0/24') as NonNullable<ReturnType<typeof parseCidr>>)).toBe('10.0.0.0/24');
    // Host bits are masked off.
    expect(formatCidr(parseCidr('10.0.0.57/24') as NonNullable<ReturnType<typeof parseCidr>>)).toBe('10.0.0.0/24');
    expect(formatCidr(parseCidr('172.30.0.1/16') as NonNullable<ReturnType<typeof parseCidr>>)).toBe('172.30.0.0/16');
  });

  it('rejects malformed input', () => {
    expect(parseCidr('10.0.0.0')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.0/')).toBeNull();
    expect(parseCidr('/24')).toBeNull();
    expect(parseCidr('10.0.0.0/abc')).toBeNull();
  });
});

describe('block arithmetic', () => {
  const slash24 = parseCidr('10.0.0.0/24') as NonNullable<ReturnType<typeof parseCidr>>;

  it('computes the broadcast address', () => {
    expect(formatIPv4(broadcastAddress(slash24))).toBe('10.0.0.255');
  });

  it('counts total and usable addresses', () => {
    expect(totalAddresses(slash24)).toBe(256);
    expect(usableAddresses(slash24)).toBe(254);
  });

  it('treats /31 as RFC 3021 point-to-point and /32 as a single host', () => {
    const slash31 = parseCidr('10.0.0.0/31') as NonNullable<ReturnType<typeof parseCidr>>;
    const slash32 = parseCidr('10.0.0.5/32') as NonNullable<ReturnType<typeof parseCidr>>;
    expect(usableAddresses(slash31)).toBe(2);
    expect(usableAddresses(slash32)).toBe(1);
    expect(formatIPv4(usableRange(slash31).first)).toBe('10.0.0.0');
    expect(formatIPv4(usableRange(slash31).last)).toBe('10.0.0.1');
  });

  it('reports the usable range', () => {
    const { first, last } = usableRange(slash24);
    expect(formatIPv4(first)).toBe('10.0.0.1');
    expect(formatIPv4(last)).toBe('10.0.0.254');
  });

  it('tests containment', () => {
    expect(containsAddress(slash24, parseIPv4('10.0.0.99') as number)).toBe(true);
    expect(containsAddress(slash24, parseIPv4('10.0.1.1') as number)).toBe(false);
  });
});

describe('cidrsOverlap', () => {
  it('detects a subnet nested inside a supernet', () => {
    const a = parseCidr('10.0.0.0/16') as NonNullable<ReturnType<typeof parseCidr>>;
    const b = parseCidr('10.0.5.0/24') as NonNullable<ReturnType<typeof parseCidr>>;
    expect(cidrsOverlap(a, b)).toBe(true);
    expect(cidrsOverlap(b, a)).toBe(true);
  });

  it('returns false for disjoint blocks', () => {
    const a = parseCidr('10.0.0.0/24') as NonNullable<ReturnType<typeof parseCidr>>;
    const b = parseCidr('10.0.1.0/24') as NonNullable<ReturnType<typeof parseCidr>>;
    expect(cidrsOverlap(a, b)).toBe(false);
  });

  it('detects adjacent blocks as non-overlapping', () => {
    const a = parseCidr('172.30.0.0/24') as NonNullable<ReturnType<typeof parseCidr>>;
    const b = parseCidr('172.30.1.0/24') as NonNullable<ReturnType<typeof parseCidr>>;
    expect(cidrsOverlap(a, b)).toBe(false);
  });
});

describe('ranges', () => {
  it('sizes an inclusive range', () => {
    expect(rangeSize({ start: 10, end: 20 })).toBe(11);
    expect(rangeSize({ start: 10, end: 10 })).toBe(1);
  });

  it('returns 0 for an inverted range rather than a negative count', () => {
    expect(rangeSize({ start: 20, end: 10 })).toBe(0);
  });

  it('detects overlap', () => {
    expect(rangesOverlap({ start: 1, end: 10 }, { start: 10, end: 20 })).toBe(true);
    expect(rangesOverlap({ start: 1, end: 9 }, { start: 10, end: 20 })).toBe(false);
  });
});

describe('allocateRange', () => {
  const slash24 = parseCidr('172.30.0.0/24') as NonNullable<ReturnType<typeof parseCidr>>;

  it('carves a range at an offset into the usable space', () => {
    const r = allocateRange(slash24, 0, 5) as NonNullable<ReturnType<typeof allocateRange>>;
    expect(formatIPv4(r.start)).toBe('172.30.0.1');
    expect(formatIPv4(r.end)).toBe('172.30.0.5');
  });

  it('respects the offset', () => {
    const r = allocateRange(slash24, 31, 14) as NonNullable<ReturnType<typeof allocateRange>>;
    expect(formatIPv4(r.start)).toBe('172.30.0.32');
    expect(formatIPv4(r.end)).toBe('172.30.0.45');
  });

  it('refuses to run past the broadcast address', () => {
    // 254 usable; asking for 255 must fail rather than wrap into the next block.
    expect(allocateRange(slash24, 0, 255)).toBeNull();
    expect(allocateRange(slash24, 250, 10)).toBeNull();
  });

  it('rejects nonsensical arguments', () => {
    expect(allocateRange(slash24, 0, 0)).toBeNull();
    expect(allocateRange(slash24, -1, 5)).toBeNull();
  });
});

describe('enumerateRange', () => {
  it('expands a small range', () => {
    const r = { start: parseIPv4('10.0.0.1') as number, end: parseIPv4('10.0.0.3') as number };
    expect(enumerateRange(r)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });

  it('caps runaway expansion', () => {
    const r = { start: 0, end: 0xffffffff };
    expect(enumerateRange(r, 5)).toHaveLength(5);
  });

  it('returns empty for an inverted range', () => {
    expect(enumerateRange({ start: 20, end: 10 })).toEqual([]);
  });
});
