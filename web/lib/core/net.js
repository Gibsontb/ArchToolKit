/**
 * IPv4 / CIDR arithmetic.
 *
 * VCF network planning needs exact answers to questions like "does this /24 hold
 * 10 + hostCount addresses", "do the management and TEP subnets overlap", and
 * "give me the usable range". Getting this wrong produces a spec that fails at
 * bring-up, so everything here is pure, total, and unit-tested.
 *
 * All addresses are handled as unsigned 32-bit integers. JavaScript bitwise
 * operators are signed, so every conversion routes through `>>> 0`.
 */

export const IPV4_MAX = 0xffffffff;

/** Parse dotted-quad to a uint32. Returns null on any malformed input. */
export function parseIPv4(input        )                {
  const trimmed = input.trim();
  // Reject anything that is not exactly four decimal octets. Deliberately strict:
  // "10.0.0.01" and "10.0.0" are both rejected rather than silently coerced.
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
  if (!match) return null;

  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const part = match[i]          ;
    // Leading zeros are ambiguous (octal in some parsers) so they are rejected.
    if (part.length > 1 && part.startsWith('0')) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** Format a uint32 as dotted-quad. */
export function formatIPv4(value        )         {
  const v = value >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

export function isValidIPv4(input        )          {
  return parseIPv4(input) !== null;
}

/** Convert a prefix length (0-32) to a subnet mask as uint32. */
export function prefixToMask(prefix        )         {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new RangeError(`prefix must be an integer 0-32, got ${prefix}`);
  }
  // A shift of 32 is a no-op in JS, so /0 is special-cased.
  return prefix === 0 ? 0 : ((IPV4_MAX << (32 - prefix)) >>> 0);
}

/**
 * Convert a subnet mask to a prefix length.
 * Returns null for non-contiguous masks (e.g. 255.0.255.0), which are invalid.
 */
export function maskToPrefix(mask        )                {
  const m = mask >>> 0;
  if (m === 0) return 0;
  // A valid mask is a run of 1s then a run of 0s. Inverting gives n, and a
  // contiguous mask satisfies (n & (n+1)) === 0.
  const inverted = (~m) >>> 0;
  if (((inverted & (inverted + 1)) >>> 0) !== 0) return null;
  let prefix = 0;
  for (let bit = 31; bit >= 0; bit -= 1) {
    if ((m & (1 << bit)) === 0) break;
    prefix += 1;
  }
  return prefix;
}

                       
                                   
                           
                             
                          
 

/**
 * Parse "10.0.0.0/24". Host bits are masked off, so "10.0.0.5/24" yields the
 * 10.0.0.0/24 network rather than an error — callers that care should compare
 * against the original.
 */
export function parseCidr(input        )              {
  const trimmed = input.trim();
  const slash = trimmed.indexOf('/');
  if (slash === -1) return null;

  const addr = parseIPv4(trimmed.slice(0, slash));
  if (addr === null) return null;

  const prefixPart = trimmed.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  if (prefix < 0 || prefix > 32) return null;

  return { network: (addr & prefixToMask(prefix)) >>> 0, prefix };
}

export function formatCidr(cidr      )         {
  return `${formatIPv4(cidr.network)}/${cidr.prefix}`;
}

/** Broadcast (last) address of the block, as uint32. */
export function broadcastAddress(cidr      )         {
  return (cidr.network | (~prefixToMask(cidr.prefix) >>> 0)) >>> 0;
}

/** Total addresses in the block, including network and broadcast. */
export function totalAddresses(cidr      )         {
  return 2 ** (32 - cidr.prefix);
}

/**
 * Addresses assignable to hosts.
 *
 * /31 (RFC 3021 point-to-point) has 2 usable and /32 has 1; every larger block
 * loses the network and broadcast addresses.
 */
export function usableAddresses(cidr      )         {
  if (cidr.prefix >= 31) return totalAddresses(cidr);
  return totalAddresses(cidr) - 2;
}

/** First and last host-assignable address, as uint32s. */
export function usableRange(cidr      )                                  {
  if (cidr.prefix >= 31) {
    return { first: cidr.network, last: broadcastAddress(cidr) };
  }
  return { first: (cidr.network + 1) >>> 0, last: (broadcastAddress(cidr) - 1) >>> 0 };
}

export function containsAddress(cidr      , address        )          {
  return ((address & prefixToMask(cidr.prefix)) >>> 0) === cidr.network;
}

/** True when two blocks share any address. */
export function cidrsOverlap(a      , b      )          {
  const aEnd = broadcastAddress(a);
  const bEnd = broadcastAddress(b);
  return a.network <= bEnd && b.network <= aEnd;
}

                          
                         
                       
 

/** Inclusive count of addresses in a range; 0 when the range is inverted. */
export function rangeSize(range         )         {
  if (range.end < range.start) return 0;
  return range.end - range.start + 1;
}

export function rangesOverlap(a         , b         )          {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Carve `count` consecutive addresses out of a CIDR, starting `offset`
 * addresses into the usable range.
 *
 * Used to lay out VCF pools (host TEP, VCFMS, Automation) inside a management
 * subnet without collisions. Returns null when the block cannot accommodate it.
 */
export function allocateRange(cidr      , offset        , count        )                 {
  if (count <= 0 || offset < 0) return null;
  const { first, last } = usableRange(cidr);
  const start = first + offset;
  const end = start + count - 1;
  if (start > last || end > last) return null;
  return { start, end };
}

/** Expand a range into dotted-quad strings. Capped to avoid runaway expansion. */
export function enumerateRange(range         , limit = 1024)           {
  const size = rangeSize(range);
  if (size === 0) return [];
  const take = Math.min(size, limit);
  const out           = new Array(take);
  for (let i = 0; i < take; i += 1) {
    out[i] = formatIPv4((range.start + i) >>> 0);
  }
  return out;
}
