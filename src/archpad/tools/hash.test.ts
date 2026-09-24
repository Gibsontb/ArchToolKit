/** Checksums against the published test vectors (RFC 1321, FIPS 180, the CRC "check" value). */

import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { expect } from '../../testing/expect.ts';
import { allHashes, crc32, md5, sha } from './hash.ts';

describe('md5', () => {
  it('matches the RFC 1321 test suite', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
    expect(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe('57edf4a22be3c955ac49da2e2107b67a');
    expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('agrees with node:crypto across padding boundaries and UTF-8', () => {
    for (const len of [55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const s = 'x'.repeat(len);
      expect(md5(s)).toBe(createHash('md5').update(s).digest('hex'));
    }
    const text = 'Grüße, 世界 🌍';
    expect(md5(text)).toBe(createHash('md5').update(text, 'utf8').digest('hex'));
  });
});

describe('crc32', () => {
  it('gives the standard check value', () => {
    expect(crc32('123456789')).toBe('cbf43926');
    expect(crc32('')).toBe('00000000');
    expect(crc32('The quick brown fox jumps over the lazy dog')).toBe('414fa339');
  });
});

describe('sha', () => {
  it('matches FIPS 180 vectors for "abc"', async () => {
    expect(await sha('SHA-1', 'abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(await sha('SHA-256', 'abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha('SHA-384', 'abc')).toBe('cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7');
    expect(await sha('SHA-512', 'abc')).toBe('ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
  });

  it('lists every hash in panel order', async () => {
    const rows = await allHashes('abc');
    expect(rows.map((r) => r.name)).toEqual(['CRC32', 'MD5', 'SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']);
    expect(rows[1]!.value).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});
