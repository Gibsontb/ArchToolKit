/**
 * FortiOS addressing, both families.
 *
 * FortiOS 7.x keeps IPv4 and IPv6 in parallel tables rather than one: an IPv4
 * object is `firewall address` with a dotted mask, an IPv6 one is
 * `firewall address6` with `set ip6 <prefix>/<len>`; routes go in
 * `router static` or `router static6`; pools in `ippool` or `ippool6`. The
 * consolidated policy table (7.0 onwards) is the exception — one policy carries
 * `srcaddr`/`dstaddr` and `srcaddr6`/`dstaddr6` side by side, and `policy6` no
 * longer exists.
 *
 * These helpers decide the family once and write each value the way its table
 * wants it, so the blueprints do not each reinvent the split.
 */

import { error,              } from '../../core/findings.js';
import { byFamily, familyOf, isIp, parseCidrAny,                           } from '../../core/ip.js';
import { parseIPv4 } from '../../core/net.js';
import { bigToV6, compressIPv6, parseIPv6, v6ToBig } from '../../core/net-calc.js';
import { netmask } from '../device.js';

/** A prefix of either family, written with its length (a bare address is refused, as parseCidr does). */
export const fgtCidr = (text        )                 => (String(text ?? '').includes('/') ? parseCidrAny(text) : null);

/** The value `set subnet` (IPv4, dotted mask) or `set ip6` (IPv6, prefix length) takes. */
export function fgtSubnet(c         )         {
  return c.family === 4 ? `${c.address} ${netmask(c.prefix)}` : `${c.network}/${c.prefix}`;
}

/** An interface address: IPv4 with its mask, IPv6 as address/length (the host part matters). */
export function fgtInterfaceAddress(c         )         {
  return c.family === 4 ? `${c.address} ${netmask(c.prefix)}` : `${c.address}/${c.prefix}`;
}

/** The address object table for a family. */
export const addressTable = (family        )         => (family === 6 ? 'firewall address6' : 'firewall address');
export const addrgrpTable = (family        )         => (family === 6 ? 'firewall addrgrp6' : 'firewall addrgrp');

/** One address object, in its own table's syntax (the lines inside `edit`). */
export function addressBody(c         , indent        )           {
  return c.family === 4 ? [`${indent}set type ipmask`, `${indent}set subnet ${fgtSubnet(c)}`] : [`${indent}set ip6 ${fgtSubnet(c)}`];
}

/** A bare address of either family, canonical (IPv6 compressed); null when it is not one. */
export function fgtHost(text        )                                             {
  const t = String(text ?? '').trim();
  if (!isIp(t)) return null;
  const c = parseCidrAny(t);
  return c ? { family: c.family, address: c.address } : null;
}

/** -1, 0 or 1 comparing two addresses of the same family; null when they differ or are invalid. */
export function compareHosts(a        , b        )                {
  const x = fgtHost(a);
  const y = fgtHost(b);
  if (!x || !y || x.family !== y.family) return null;
  if (x.family === 4) {
    const p = parseIPv4(x.address) ;
    const q = parseIPv4(y.address) ;
    return p === q ? 0 : p < q ? -1 : 1;
  }
  const p = v6ToBig(parseIPv6(x.address) );
  const q = v6ToBig(parseIPv6(y.address) );
  return p === q ? 0 : p < q ? -1 : 1;
}

/** The n-th address in a network (n = 1 is the first after the network address). */
export function nthHost(c         , n        )         {
  if (c.family === 4) {
    const v = (parseIPv4(c.network)  + n) >>> 0;
    return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
  }
  return compressIPv6(bigToV6(v6ToBig(parseIPv6(c.network) ) + BigInt(n)));
}

/** Split a comma list into families, with an error for each entry that is neither. */
export function splitFamilies(list                   , what        , findings           )                                 {
  const { v4, v6, invalid } = byFamily(list);
  for (const bad of invalid) findings.push(error('network.fortios.bad-address', `"${bad}" in ${what} is not an IPv4 or IPv6 address or prefix.`, { source: 'ArchToolKit' }));
  return { v4, v6 };
}

/** An address object name typed where an address was expected, or the other way round. */
export const looksLikeAddress = (text        )          => familyOf(text) !== null;

/** The IPv6 twin of an object name, when both families need one. */
export const v6Name = (name        , both         )         => (both ? `${name}-V6` : name);

/** The finding for an IPv6 value where FortiOS has no IPv6 form. */
export function noIpv6(code        , feature        )          {
  return error(`network.fortios.${code}`, `${feature} on FortiOS 7.x does not support IPv6.`, { source: 'ArchToolKit' });
}
