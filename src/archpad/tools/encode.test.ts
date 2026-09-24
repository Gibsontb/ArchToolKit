/** Encoders round-trip, and Base64 handles text beyond Latin-1. */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import {
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  decodeJwt,
  hexDecode,
  hexEncode,
  qpDecode,
  qpEncode,
  rot13,
  urlDecodeComponent,
  urlDecodeForm,
  urlEncodeComponent,
} from './encode.ts';

describe('base64', () => {
  it('is UTF-8 safe', () => {
    expect(base64Encode('héllo wörld')).toBe('aMOpbGxvIHfDtnJsZA==');
    expect(base64Encode('✓ 🌍')).toBe('4pyTIPCfjI0=');
    expect(base64Decode('4pyTIPCfjI0=')).toBe('✓ 🌍');
    expect(base64Decode('aMOp bGxv\nIHfDtnJsZA')).toBe('héllo wörld');
  });

  it('rejects what is not Base64 or not text', () => {
    expect(() => base64Decode('ab$c')).toThrow(/Not Base64/);
    expect(() => base64Decode('/w==')).toThrow(/not UTF-8/);
  });

  it('has a URL-safe form without padding', () => {
    const text = 'subjects?_d=1&x=ÿÿ>>';
    const enc = base64UrlEncode(text);
    expect(/[+/=]/.test(enc)).toBe(false);
    expect(base64UrlDecode(enc)).toBe(text);
  });
});

describe('url, hex, quoted-printable, rot13', () => {
  it('round-trips', () => {
    expect(urlEncodeComponent('a b&c=d/é')).toBe('a%20b%26c%3Dd%2F%C3%A9');
    expect(urlDecodeComponent('a%20b%26c%3Dd%2F%C3%A9')).toBe('a b&c=d/é');
    expect(urlDecodeForm('a+b%2Bc')).toBe('a b+c');
    expect(() => urlDecodeComponent('%E0%A4%A')).toThrow(/Not URL-encoded/);
    expect(hexEncode('Hi é')).toBe('486920c3a9');
    expect(hexEncode('Hi', ' ')).toBe('48 69');
    expect(hexDecode('0x48, 0x69 20:c3:a9')).toBe('Hi é');
    expect(rot13('Hello, World!')).toBe('Uryyb, Jbeyq!');
    expect(rot13(rot13('abcXYZ'))).toBe('abcXYZ');
  });

  it('writes quoted-printable per RFC 2045', () => {
    expect(qpEncode('café = 1 ')).toBe('caf=C3=A9 =3D 1=20');
    const long = 'é'.repeat(40);
    const enc = qpEncode(long);
    for (const line of enc.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(qpDecode(enc)).toBe(long);
    expect(qpDecode('soft=\r\nbreak')).toBe('softbreak');
  });
});

describe('decodeJwt', () => {
  // {"alg":"HS256","typ":"JWT"} . {"sub":"1234567890","name":"John Doe","iat":1516239022,"exp":1516242622}
  const token = [
    base64UrlEncode('{"alg":"HS256","typ":"JWT"}'),
    base64UrlEncode('{"sub":"1234567890","name":"John Doe","iat":1516239022,"exp":1516242622}'),
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  ].join('.');

  it('decodes the header and payload and dates the claims', () => {
    const jwt = decodeJwt(`Bearer ${token}`, Date.UTC(2020, 0, 1));
    expect(jwt.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect((jwt.payload as { name: string }).name).toBe('John Doe');
    expect(jwt.dates.find((d) => d.claim === 'exp')!.iso).toBe('2018-01-18T02:30:22.000Z');
    expect(jwt.dates.find((d) => d.claim === 'iat')!.iso).toBe('2018-01-18T01:30:22.000Z');
    expect(jwt.expired).toBe(true);
    expect(decodeJwt(token, Date.UTC(2018, 0, 18, 2)).expired).toBe(false);
  });

  it('rejects a non-token', () => {
    expect(() => decodeJwt('hello')).toThrow(/Not a JWT/);
    expect(() => decodeJwt('abc.def.ghi')).toThrow(/not/);
  });
});
