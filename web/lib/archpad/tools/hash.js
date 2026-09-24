/**
 * Checksums: MD5 and CRC32 written here, SHA-1/256/384/512 from WebCrypto.
 *
 * WebCrypto has no MD5 (it is broken for security and was left out on
 * purpose), but MD5 is still what vendors publish next to firmware images
 * and what old configs compare against, so an editor needs it. It is for
 * integrity checks, not for anything secret.
 */

import { toHex, utf8 } from './encode.js';

// --- MD5 (RFC 1321) -------------------------------------------------------------

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
// K[i] = floor(abs(sin(i + 1)) * 2^32), computed once rather than pasted as 64 magic numbers.
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(input                     )         {
  const data = typeof input === 'string' ? utf8(input) : input;
  const bitLength = data.length * 8;
  // Pad to 56 mod 64, then the 64-bit little-endian length.
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let j = 0; j < 16; j += 1) M[j] = view.getUint32(off + j * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i += 1) {
      let F        ;
      let g        ;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const sum = (A + F + K[i]  + M[g] ) >>> 0;
      const s = S[(i >> 4) * 4 + (i % 4)] ;
      A = D;
      D = C;
      C = B;
      B = (B + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return toHex(new Uint8Array(out.buffer));
}

// --- CRC32 (IEEE 802.3, as zip and Ethernet use) ------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(input                     )         {
  const data = typeof input === 'string' ? utf8(input) : input;
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]  ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

// --- SHA family -------------------------------------------------------------------

                                                                  
export const SHA_NAMES                     = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];

/**
 * WebCrypto only exists in a secure context. file:// and the exe's virtual
 * host both count; a page served over plain http from another machine does
 * not, and then the SHA rows say so rather than failing the whole panel.
 */
export async function sha(name         , input                     )                  {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto is not available here (the page is not in a secure context).');
  const data = typeof input === 'string' ? utf8(input) : input;
  return toHex(new Uint8Array(await subtle.digest(name, data)));
}

/** Every hash of the same bytes, in the order the panel lists them. */
export async function allHashes(input                     )                                             {
  const data = typeof input === 'string' ? utf8(input) : input;
  const rows                                    = [
    { name: 'CRC32', value: crc32(data) },
    { name: 'MD5', value: md5(data) },
  ];
  for (const name of SHA_NAMES) {
    try {
      rows.push({ name, value: await sha(name, data) });
    } catch (e) {
      rows.push({ name, value: e instanceof Error ? e.message : String(e) });
    }
  }
  return rows;
}
