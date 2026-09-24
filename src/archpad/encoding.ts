/**
 * Bytes <-> text for ArchPad, and line endings.
 *
 * The host hands the core raw bytes and gets raw bytes back, so the core owns
 * every encoding decision. That keeps the browser and the exe identical: a
 * file saved as "UTF-16 LE" or "ANSI" from either one is byte-for-byte the
 * same. Nothing here touches the DOM, so it is unit tested under node.
 *
 * Windows-1252 is implemented with our own table rather than TextDecoder:
 * encoding is not available through TextEncoder at all, and decoding through
 * the platform would make the round trip depend on the ICU build.
 */

import type { Encoding, Eol } from './types.ts';

export const ENCODING_LABELS: Readonly<Record<Encoding, string>> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8-BOM',
  'utf-16le': 'UTF-16 LE BOM',
  'utf-16be': 'UTF-16 BE BOM',
  'windows-1252': 'ANSI (Windows-1252)',
};

export const ALL_ENCODINGS: readonly Encoding[] = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'windows-1252'];

export const EOL_LABELS: Readonly<Record<Eol, string>> = {
  CRLF: 'Windows (CR LF)',
  LF: 'Unix (LF)',
  CR: 'Macintosh (CR)',
};

export const EOL_TEXT: Readonly<Record<Eol, string>> = { CRLF: '\r\n', LF: '\n', CR: '\r' };

/**
 * 0x80..0x9F of Windows-1252. The five holes (0x81, 0x8D, 0x8F, 0x90, 0x9D)
 * map to the C1 control with the same number, as the WHATWG decoder does, so
 * any byte string survives decode -> encode unchanged.
 */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** Code point -> byte for everything above 0x7F that Windows-1252 can hold. */
const CP1252_ENCODE: ReadonlyMap<number, number> = (() => {
  const map = new Map<number, number>();
  CP1252_HIGH.forEach((cp, i) => map.set(cp, 0x80 + i));
  for (let b = 0xa0; b <= 0xff; b++) map.set(b, b);
  return map;
})();

export interface Detection {
  readonly encoding: Encoding;
  /** True when the encoding came from a byte order mark rather than a guess. */
  readonly fromBom: boolean;
}

/** Is this a well-formed UTF-8 byte string (no overlongs, surrogates or truncation)? */
export function isValidUtf8(bytes: Uint8Array, start = 0): boolean {
  let i = start;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i]!;
    if (b < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let min: number;
    let cp: number;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      min = 0x80;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      min = 0x800;
      cp = b & 0x0f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      min = 0x10000;
      cp = b & 0x07;
    } else {
      return false;
    }
    // A sequence cut off by the end of the file is not UTF-8.
    if (i + need >= n) return false;
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += need + 1;
  }
  return true;
}

/**
 * Guess how a file is encoded, the way Notepad++ does: a BOM wins; otherwise
 * UTF-16 without a BOM shows up as a wall of zero bytes on one side; otherwise
 * valid UTF-8 is UTF-8 (plain ASCII included) and anything else is ANSI.
 */
export function detectEncoding(bytes: Uint8Array): Detection {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: 'utf-8-bom', fromBom: true };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', fromBom: true };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', fromBom: true };

  const sample = Math.min(bytes.length, 8192) & ~1;
  if (sample >= 4) {
    let evenZeros = 0;
    let oddZeros = 0;
    for (let i = 0; i < sample; i += 2) {
      if (bytes[i] === 0) evenZeros++;
      if (bytes[i + 1] === 0) oddZeros++;
    }
    const pairs = sample / 2;
    // ASCII text in UTF-16 LE is "x\0x\0"; a real 8-bit file almost never has NULs.
    if (oddZeros / pairs > 0.4 && evenZeros / pairs < 0.05) return { encoding: 'utf-16le', fromBom: false };
    if (evenZeros / pairs > 0.4 && oddZeros / pairs < 0.05) return { encoding: 'utf-16be', fromBom: false };
  }

  return { encoding: isValidUtf8(bytes) ? 'utf-8' : 'windows-1252', fromBom: false };
}

function bomLength(bytes: Uint8Array, encoding: Encoding): number {
  if ((encoding === 'utf-8' || encoding === 'utf-8-bom') && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 3;
  if (encoding === 'utf-16le' && bytes[0] === 0xff && bytes[1] === 0xfe) return 2;
  if (encoding === 'utf-16be' && bytes[0] === 0xfe && bytes[1] === 0xff) return 2;
  return 0;
}

function decodeUtf16(bytes: Uint8Array, start: number, littleEndian: boolean): string {
  const parts: string[] = [];
  const chunk: number[] = [];
  for (let i = start; i + 1 < bytes.length; i += 2) {
    chunk.push(littleEndian ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!);
    // Flush in slices: String.fromCharCode with a huge argument list overflows the stack.
    if (chunk.length === 8192) {
      parts.push(String.fromCharCode(...chunk));
      chunk.length = 0;
    }
  }
  if (chunk.length) parts.push(String.fromCharCode(...chunk));
  // A dangling odd byte cannot be a character; keep it visible rather than drop data silently.
  if ((bytes.length - start) % 2 === 1) parts.push('�');
  return parts.join('');
}

function decode1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunk: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    chunk.push(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b);
    if (chunk.length === 8192) {
      parts.push(String.fromCharCode(...chunk));
      chunk.length = 0;
    }
  }
  if (chunk.length) parts.push(String.fromCharCode(...chunk));
  return parts.join('');
}

/** Bytes to text. A BOM matching the encoding is consumed, never shown. */
export function decode(bytes: Uint8Array, encoding: Encoding): string {
  const skip = bomLength(bytes, encoding);
  switch (encoding) {
    case 'utf-8':
    case 'utf-8-bom':
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(skip));
    case 'utf-16le':
      return decodeUtf16(bytes, skip, true);
    case 'utf-16be':
      return decodeUtf16(bytes, skip, false);
    case 'windows-1252':
      return decode1252(bytes);
  }
}

/** Characters in `text` that `encoding` cannot represent (only ANSI can fail). */
export function unmappableCount(text: string, encoding: Encoding): number {
  if (encoding !== 'windows-1252') return 0;
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x80 && !CP1252_ENCODE.has(c)) {
      bad++;
      // A surrogate pair is one character, not two.
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) i++;
    }
  }
  return bad;
}

/**
 * Text to bytes, with a BOM for utf-8-bom and both UTF-16s (Notepad++ always
 * writes one for UTF-16). ANSI writes '?' for characters it cannot hold; call
 * unmappableCount first to warn about that.
 */
export function encode(text: string, encoding: Encoding): Uint8Array {
  switch (encoding) {
    case 'utf-8':
      return new TextEncoder().encode(text);
    case 'utf-8-bom': {
      const body = new TextEncoder().encode(text);
      const out = new Uint8Array(body.length + 3);
      out.set([0xef, 0xbb, 0xbf]);
      out.set(body, 3);
      return out;
    }
    case 'utf-16le':
    case 'utf-16be': {
      const le = encoding === 'utf-16le';
      const out = new Uint8Array(2 + text.length * 2);
      out[0] = le ? 0xff : 0xfe;
      out[1] = le ? 0xfe : 0xff;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out[2 + i * 2] = le ? c & 0xff : c >> 8;
        out[3 + i * 2] = le ? c >> 8 : c & 0xff;
      }
      return out;
    }
    case 'windows-1252': {
      const out: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else {
          const b = CP1252_ENCODE.get(c);
          out.push(b ?? 0x3f);
          if (b === undefined && c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) i++;
        }
      }
      return Uint8Array.from(out);
    }
  }
}

export interface EolCounts {
  readonly crlf: number;
  readonly lf: number;
  readonly cr: number;
}

export function countEols(text: string): EolCounts {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  return { crlf, lf, cr };
}

/** The dominant line ending, or `fallback` for a file with a single line. */
export function detectEol(text: string, fallback: Eol = 'CRLF'): Eol {
  const { crlf, lf, cr } = countEols(text);
  if (crlf === 0 && lf === 0 && cr === 0) return fallback;
  if (crlf >= lf && crlf >= cr) return 'CRLF';
  return lf >= cr ? 'LF' : 'CR';
}

/** True when a file mixes line endings (the editor normalises them on save). */
export function hasMixedEols(text: string): boolean {
  const { crlf, lf, cr } = countEols(text);
  return [crlf, lf, cr].filter((n) => n > 0).length > 1;
}

/** Rewrite every line ending in `text` to `eol`. */
export function convertEol(text: string, eol: Eol): string {
  return text.replace(/\r\n|\r|\n/g, EOL_TEXT[eol]);
}

/** A file as the editor sees it: decoded, with its encoding and line ending remembered for the save. */
export interface DecodedFile {
  readonly text: string;
  readonly encoding: Encoding;
  readonly eol: Eol;
  readonly mixedEol: boolean;
}

export function decodeFile(bytes: Uint8Array, defaultEol: Eol = 'CRLF'): DecodedFile {
  const { encoding } = detectEncoding(bytes);
  const raw = decode(bytes, encoding);
  return { text: raw, encoding, eol: detectEol(raw, defaultEol), mixedEol: hasMixedEols(raw) };
}

/** The bytes a save writes: `text` uses \n internally (CodeMirror's model); it goes out with the doc's EOL and encoding. */
export function encodeFile(text: string, encoding: Encoding, eol: Eol): Uint8Array {
  return encode(convertEol(text, eol), encoding);
}

/** Does the file look binary? Used to warn before opening an executable or image as text. */
export function looksBinary(bytes: Uint8Array): boolean {
  const { encoding } = detectEncoding(bytes);
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return false;
  const n = Math.min(bytes.length, 8192);
  let nul = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) nul++;
  return nul > 0 && nul / Math.max(1, n) > 0.01;
}
