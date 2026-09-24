import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertEol,
  countEols,
  decode,
  decodeFile,
  detectEncoding,
  detectEol,
  encode,
  encodeFile,
  hasMixedEols,
  isValidUtf8,
  looksBinary,
  unmappableCount,
} from './encoding.ts';

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

test('BOMs decide the encoding', () => {
  assert.deepEqual(detectEncoding(bytes(0xef, 0xbb, 0xbf, 0x41)), { encoding: 'utf-8-bom', fromBom: true });
  assert.deepEqual(detectEncoding(bytes(0xff, 0xfe, 0x41, 0)), { encoding: 'utf-16le', fromBom: true });
  assert.deepEqual(detectEncoding(bytes(0xfe, 0xff, 0, 0x41)), { encoding: 'utf-16be', fromBom: true });
});

test('UTF-16 without a BOM is recognised from its zero bytes', () => {
  const le = new Uint8Array([...'hello world'].flatMap((c) => [c.charCodeAt(0), 0]));
  const be = new Uint8Array([...'hello world'].flatMap((c) => [0, c.charCodeAt(0)]));
  assert.equal(detectEncoding(le).encoding, 'utf-16le');
  assert.equal(detectEncoding(be).encoding, 'utf-16be');
});

test('valid UTF-8 (and plain ASCII) is UTF-8; anything else is ANSI', () => {
  assert.equal(detectEncoding(new TextEncoder().encode('plain ascii')).encoding, 'utf-8');
  assert.equal(detectEncoding(new TextEncoder().encode('café — ✓ 𝄞')).encoding, 'utf-8');
  assert.equal(detectEncoding(bytes(0x63, 0x61, 0x66, 0xe9)).encoding, 'windows-1252'); // "café" in 1252
  assert.equal(detectEncoding(bytes(0x93, 0x71, 0x94)).encoding, 'windows-1252');
});

test('the UTF-8 validator rejects overlongs, surrogates and truncation', () => {
  assert.equal(isValidUtf8(bytes(0xc0, 0x80)), false);
  assert.equal(isValidUtf8(bytes(0xe0, 0x80, 0x80)), false);
  assert.equal(isValidUtf8(bytes(0xed, 0xa0, 0x80)), false);
  assert.equal(isValidUtf8(bytes(0xe2, 0x82)), false);
  assert.equal(isValidUtf8(bytes(0xf4, 0x90, 0x80, 0x80)), false);
  assert.equal(isValidUtf8(bytes(0xe2, 0x82, 0xac)), true);
  assert.equal(isValidUtf8(bytes(0xf0, 0x9f, 0x98, 0x80)), true);
});

test('Windows-1252 decodes the 0x80-0x9F block through the table', () => {
  assert.equal(decode(bytes(0x80, 0x93, 0x94, 0x99, 0x9f), 'windows-1252'), '€“”™Ÿ');
  assert.equal(decode(bytes(0xe9, 0xff), 'windows-1252'), 'éÿ');
});

test('every byte survives a Windows-1252 round trip, holes included', () => {
  const all = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(encode(decode(all, 'windows-1252'), 'windows-1252'), all);
});

test('ANSI writes ? for what it cannot hold, and counts it first', () => {
  assert.equal(unmappableCount('a€b✓c😀', 'windows-1252'), 2);
  assert.equal(unmappableCount('✓', 'utf-8'), 0);
  assert.deepEqual(encode('a✓€', 'windows-1252'), bytes(0x61, 0x3f, 0x80));
  assert.deepEqual(encode('😀', 'windows-1252'), bytes(0x3f));
});

test('round trips through every Unicode encoding, BOM written and consumed', () => {
  const text = 'Line 1 café\nΣ ✓ 𝄞 end';
  for (const enc of ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be'] as const) {
    const out = encode(text, enc);
    assert.equal(decode(out, enc), text, enc);
    assert.equal(detectEncoding(out).encoding, enc, `${enc} detected back`);
  }
  assert.deepEqual(encode('A', 'utf-8-bom'), bytes(0xef, 0xbb, 0xbf, 0x41));
  assert.deepEqual(encode('A', 'utf-16le'), bytes(0xff, 0xfe, 0x41, 0));
  assert.deepEqual(encode('A', 'utf-16be'), bytes(0xfe, 0xff, 0, 0x41));
});

test('decoding plain UTF-8 keeps a leading BOM out of the text', () => {
  assert.equal(decode(bytes(0xef, 0xbb, 0xbf, 0x68, 0x69), 'utf-8'), 'hi');
});

test('a large UTF-16 file decodes without blowing the stack', () => {
  const text = 'x'.repeat(200_000);
  assert.equal(decode(encode(text, 'utf-16le'), 'utf-16le').length, 200_000);
});

test('EOL detection picks the majority and a fallback for one line', () => {
  assert.equal(detectEol('a\r\nb\r\nc'), 'CRLF');
  assert.equal(detectEol('a\nb\nc'), 'LF');
  assert.equal(detectEol('a\rb\rc'), 'CR');
  assert.equal(detectEol('a\r\nb\nc\nd'), 'LF');
  assert.equal(detectEol('single line', 'LF'), 'LF');
  assert.deepEqual(countEols('a\r\nb\nc\rd'), { crlf: 1, lf: 1, cr: 1 });
  assert.equal(hasMixedEols('a\r\nb\n'), true);
  assert.equal(hasMixedEols('a\nb\n'), false);
});

test('EOL conversion rewrites every ending', () => {
  assert.equal(convertEol('a\r\nb\nc\rd', 'CRLF'), 'a\r\nb\r\nc\r\nd');
  assert.equal(convertEol('a\r\nb\nc\rd', 'LF'), 'a\nb\nc\nd');
  assert.equal(convertEol('a\r\nb\nc\rd', 'CR'), 'a\rb\rc\rd');
});

test('decodeFile and encodeFile are inverse for a CRLF ANSI file', () => {
  const original = bytes(0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0x80, 0x0d, 0x0a);
  const file = decodeFile(original);
  assert.equal(file.encoding, 'windows-1252');
  assert.equal(file.eol, 'CRLF');
  // The editor holds \n internally.
  const editorText = file.text.replace(/\r\n/g, '\n');
  assert.deepEqual(encodeFile(editorText, file.encoding, file.eol), original);
});

test('binary files are flagged, UTF-16 text is not', () => {
  assert.equal(looksBinary(bytes(0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0)), true);
  assert.equal(looksBinary(encode('hello', 'utf-16le')), false);
  assert.equal(looksBinary(new TextEncoder().encode('plain')), false);
});
