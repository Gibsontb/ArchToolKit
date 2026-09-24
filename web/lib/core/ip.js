/**
 * IPv4 and IPv6, through one door.
 *
 * Every field in the toolkit that takes an address, a network or a server
 * accepts either family. This is where a value's family is decided and where
 * the questions every generator asks — is it valid, what network is it in,
 * does it overlap, how is it written next to a port — get the same answer for
 * both. IPv4 arithmetic comes from core/net.ts, IPv6 from core/net-calc.ts.
 *
 * A generator for a platform that does not support IPv6 somewhere should not
 * offer it there: use `ipv4Only` findings, not IPv6 config the device rejects.
 */

import { formatCidr, formatIPv4, parseCidr as parseCidr4, parseIPv4, broadcastAddress, cidrsOverlap } from './net.js';
import { compressIPv6, parseCidr6, parseIPv6, v6ToBig, bigToV6,            } from './net-calc.js';

                           

/** The family of an address or network, or null when it is neither. */
export function familyOf(text        )                {
  const t = String(text ?? '').trim();
  const [addr = '', prefix] = t.split('/');
  if (addr.includes(':')) {
    if (!parseIPv6(addr)) return null;
    if (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > 128)) return null;
    return 6;
  }
  if (parseIPv4(addr) === null) return null;
  if (prefix !== undefined && (!/^\d{1,2}$/.test(prefix) || Number(prefix) > 32)) return null;
  return 4;
}

/** A bare address of either family (no prefix). */
export function isIp(text        )          {
  const t = String(text ?? '').trim();
  return !t.includes('/') && familyOf(t) !== null;
}

export const isIpv6 = (text        )          => isIp(text) && familyOf(text) === 6;
export const isIpv4Address = (text        )          => isIp(text) && familyOf(text) === 4;

                          
                          
                                                                   
                           
                          
                                        
                           
 

/**
 * "10.0.0.5/24" or "2001:db8::5/64" split into address and prefix, with the
 * network it is in. A bare address is a /32 or /128.
 */
export function parseCidrAny(text        )                 {
  const t = String(text ?? '').trim();
  const family = familyOf(t);
  if (family === null) return null;
  const [addr = '', p] = t.split('/');
  if (family === 4) {
    const prefix = p === undefined ? 32 : Number(p);
    const c = parseCidr4(`${addr}/${prefix}`);
    return c ? { family, address: addr, prefix, network: formatIPv4(c.network) } : null;
  }
  const prefix = p === undefined ? 128 : Number(p);
  const c = parseCidr6(`${addr}/${prefix}`);
  const groups = parseIPv6(addr);
  return c && groups ? { family, address: compressIPv6(groups), prefix, network: compressIPv6(bigToV6(c.network)) } : null;
}

/** The canonical way to write a network: 10.0.0.0/24, 2001:db8::/64. */
export function formatCidrAny(c         )         {
  return `${c.network}/${c.prefix}`;
}

/** The route and rule that mean "everything", for a family. */
export const anyRoute = (family        )         => (family === 6 ? '::/0' : '0.0.0.0/0');

/** True for 0.0.0.0/0 and ::/0 — the "open to the world" check must catch both. */
export function isAnyNetwork(text        )          {
  const c = parseCidrAny(text);
  return c !== null && c.prefix === 0;
}

const range6 = (c       )                   => {
  const size = 1n << BigInt(128 - c.prefix);
  return [c.network, c.network + size - 1n];
};

/** Do two networks overlap. Different families never do. */
export function overlapsAny(a        , b        )          {
  const fa = familyOf(a);
  const fb = familyOf(b);
  if (fa === null || fb === null || fa !== fb) return false;
  if (fa === 4) {
    const x = parseCidr4(a.includes('/') ? a : `${a}/32`);
    const y = parseCidr4(b.includes('/') ? b : `${b}/32`);
    return !!x && !!y && cidrsOverlap(x, y);
  }
  const x = parseCidr6(a);
  const y = parseCidr6(b);
  if (!x || !y) return false;
  const [x0, x1] = range6(x);
  const [y0, y1] = range6(y);
  return x0 <= y1 && y0 <= x1;
}

/** Is the address inside the network. */
export function containsAny(network        , address        )          {
  const n = parseCidrAny(network);
  const a = parseCidrAny(address);
  if (!n || !a || n.family !== a.family) return false;
  if (n.family === 4) {
    const c = parseCidr4(`${n.network}/${n.prefix}`) ;
    const v = parseIPv4(a.address) ;
    return v >= c.network && v <= broadcastAddress(c);
  }
  const c = parseCidr6(`${n.network}/${n.prefix}`) ;
  const [lo, hi] = range6(c);
  const v = v6ToBig(parseIPv6(a.address) );
  return v >= lo && v <= hi;
}

/**
 * An address next to a port, the way URLs and most daemons want it: IPv6
 * in brackets, [2001:db8::1]:9997. A hostname or IPv4 address is unchanged.
 */
export function formatHostPort(host        , port                 )         {
  const h = String(host ?? '').trim();
  return `${familyOf(h) === 6 ? `[${h}]` : h}:${port}`;
}

/** Split "host:port", "[v6]:port", "10.0.0.1:514" or a bare host (port null). */
export function splitHostPort(text        )                                        {
  const t = String(text ?? '').trim();
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (bracket) return { host: bracket[1] , port: bracket[2] ? Number(bracket[2]) : null };
  // An unbracketed IPv6 address has several colons and no port.
  if ((t.match(/:/g) ?? []).length > 1) return { host: t, port: null };
  const at = t.lastIndexOf(':');
  if (at > 0 && /^\d+$/.test(t.slice(at + 1))) return { host: t.slice(0, at), port: Number(t.slice(at + 1)) };
  return { host: t, port: null };
}

/** A URL host part: IPv6 literals in brackets. */
export const urlHost = (host        )         => (familyOf(host) === 6 ? `[${host.trim()}]` : host.trim());

/** Split a list of mixed addresses/networks by family, keeping order. */
export function byFamily(list                   )                                                    {
  const out = { v4: []            , v6: []            , invalid: []             };
  for (const item of list.map((s) => s.trim()).filter(Boolean)) {
    const f = familyOf(item);
    (f === 4 ? out.v4 : f === 6 ? out.v6 : out.invalid).push(item);
  }
  return out;
}

/** Common IPv6 examples for dropdowns: documentation, ULA and "everything". */
export const COMMON_V6_CIDRS                    = ['2001:db8::/32', '2001:db8:0:1::/64', 'fd00::/8', 'fc00::/7', '::/0'];

/** For messages: "10.0.0.0/24" or "2001:db8::/64" from an AnyCidr's parts. */
export const cidrText = (network        , prefix        )         => `${network}/${prefix}`;

// Re-exported so callers need one import for the IPv4 dotted helpers too.
export { formatCidr };
