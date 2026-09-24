/**
 * Encoders and decoders: Base64 (standard and URL-safe), URL, hex,
 * quoted-printable, ROT13, and JWT decoding.
 *
 * Text always goes to bytes as UTF-8 first. btoa() alone throws on anything
 * outside Latin-1 and silently mangles what it does accept, which is the bug
 * every "Base64 this" tool ships with at least once.
 */

const encoder = new TextEncoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);

/** Strict UTF-8: bytes that are not text are reported, not turned into U+FFFD. */
export function fromUtf8(bytes: Uint8Array, what = 'The decoded bytes'): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${what} are not UTF-8 text (${bytes.length} bytes). Hex: ${toHex(bytes.slice(0, 64))}${bytes.length > 64 ? '…' : ''}`);
  }
}

// --- Base64 -----------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // In chunks: String.fromCharCode(...bigArray) overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  let t = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t)) throw new Error('Not Base64: only A–Z a–z 0–9 + / (or - _) and = padding are allowed.');
  t = t.replace(/=+$/, '');
  if (t.length % 4 === 1) throw new Error('Not Base64: the length is one character too long or short.');
  t += '='.repeat((4 - (t.length % 4)) % 4);
  const binary = atob(t);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export const base64Encode = (text: string): string => bytesToBase64(utf8(text));
export const base64Decode = (text: string): string => fromUtf8(base64ToBytes(text));

export const base64UrlEncode = (text: string): string => base64Encode(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** Accepts either alphabet, with or without padding. */
export const base64UrlDecode = base64Decode;

// --- URL --------------------------------------------------------------------------

export const urlEncodeComponent = (text: string): string => encodeURIComponent(text);
export const urlEncodeFull = (text: string): string => encodeURI(text);

function urlDecodeWith(text: string, fn: (s: string) => string): string {
  try {
    return fn(text);
  } catch {
    throw new Error('Not URL-encoded: a % is not followed by valid UTF-8 escapes.');
  }
}
export const urlDecodeComponent = (text: string): string => urlDecodeWith(text, decodeURIComponent);
export const urlDecodeFull = (text: string): string => urlDecodeWith(text, decodeURI);
/** Form encoding writes a space as '+'. */
export const urlDecodeForm = (text: string): string => urlDecodeWith(text.replace(/\+/g, ' '), decodeURIComponent);

// --- Hex ---------------------------------------------------------------------------

export function toHex(bytes: Uint8Array, separator = ''): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(separator);
}

/** Accepts "48656c6c6f", "48 65 6c", "0x48,0x65", "48:65:6C". */
export function hexToBytes(text: string): Uint8Array {
  const t = text.replace(/0x/gi, '').replace(/[\s,:;-]+/g, '');
  if (!/^[0-9a-f]*$/i.test(t)) throw new Error('Not hex: only 0–9 and a–f are allowed (spaces, colons, commas and 0x are ignored).');
  if (t.length % 2) throw new Error('Not hex: an odd number of digits.');
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const hexEncode = (text: string, separator = ''): string => toHex(utf8(text), separator);
export const hexDecode = (text: string): string => fromUtf8(hexToBytes(text));

// --- Quoted-printable (RFC 2045) ----------------------------------------------------

export function qpEncode(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const bytes = utf8(line);
    let encoded = '';
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i]!;
      const last = i === bytes.length - 1;
      // Printable ASCII except '='; a space or tab at the end of a line must be encoded or it is lost in transit.
      const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      encoded += literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    // Soft line breaks keep every line at 76 characters or fewer, never splitting an =XX.
    let rest = encoded;
    while (rest.length > 76) {
      let cut = 75;
      const eq = rest.lastIndexOf('=', cut - 1);
      if (eq >= cut - 2) cut = eq;
      out.push(`${rest.slice(0, cut)}=`);
      rest = rest.slice(cut);
    }
    out.push(rest);
  }
  return out.join('\r\n');
}

export function qpDecode(text: string): string {
  const joined = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const c = joined[i]!;
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...utf8(c));
    }
  }
  return fromUtf8(Uint8Array.from(bytes));
}

// --- ROT13 -------------------------------------------------------------------------

export const rot13 = (text: string): string =>
  text.replace(/[A-Za-z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });

// --- JWT ----------------------------------------------------------------------------

export interface JwtDecoded {
  readonly header: Record<string, unknown>;
  readonly payload: unknown;
  readonly signature: string;
  /** exp / iat / nbf / auth_time as ISO dates. */
  readonly dates: readonly { claim: string; epoch: number; iso: string }[];
  /** True when exp is in the past at `now`. Null when there is no exp. */
  readonly expired: boolean | null;
}

/**
 * Split and decode a JWT. The signature is not verified — there is no key
 * here, and the point is to read what a token claims, not to trust it.
 */
export function decodeJwt(token: string, now = Date.now()): JwtDecoded {
  const t = token.trim().replace(/^Bearer\s+/i, '');
  const parts = t.split('.');
  if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) throw new Error('Not a JWT: expected header.payload.signature.');
  const part = (s: string, what: string): unknown => {
    let json: string;
    try {
      json = base64Decode(s);
    } catch {
      throw new Error(`The ${what} is not Base64URL.`);
    }
    try {
      return JSON.parse(json);
    } catch {
      throw new Error(`The ${what} is not JSON.`);
    }
  };
  const header = part(parts[0], 'header') as Record<string, unknown>;
  const payload = part(parts[1], 'payload');
  const dates: { claim: string; epoch: number; iso: string }[] = [];
  let expired: boolean | null = null;
  if (payload && typeof payload === 'object') {
    for (const claim of ['iat', 'nbf', 'exp', 'auth_time']) {
      const v = (payload as Record<string, unknown>)[claim];
      if (typeof v === 'number' && Number.isFinite(v)) {
        dates.push({ claim, epoch: v, iso: new Date(v * 1000).toISOString() });
        if (claim === 'exp') expired = v * 1000 < now;
      }
    }
  }
  return { header, payload, signature: parts[2] ?? '', dates, expired };
}
