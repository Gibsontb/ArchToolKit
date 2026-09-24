/**
 * The network calculator's arithmetic: one subnet described in full, a network
 * split into pieces, VLSM allocation, containment and overlap, the covering
 * supernet, and the IPv6 basics.
 *
 * Built on core/net.ts, so a /31 and a /32 mean the same thing here as they
 * do in the VCF spec checks. Everything is pure and total: bad input returns
 * an error string, never a throw.
 */

import {
  broadcastAddress,
  cidrsOverlap,
  containsAddress,
  formatCidr,
  formatIPv4,
  maskToPrefix,
  parseCidr,
  parseIPv4,
  prefixToMask,
  totalAddresses,
  usableAddresses,
  usableRange,
            
} from './net.js';

                                
                        
                           
                           
                             
                           
                            
                          
                             
                            
                          
                         
                        
                               
                               
                              
                                                       
                                
 

/** What an address is, by the ranges IANA and the RFCs reserve. */
export function addressKind(address        )         {
  const inRange = (cidr        )          => containsAddress(parseCidr(cidr) , address);
  if (inRange('10.0.0.0/8') || inRange('172.16.0.0/12') || inRange('192.168.0.0/16')) return 'Private (RFC 1918)';
  if (inRange('100.64.0.0/10')) return 'Shared address space / CGNAT (RFC 6598)';
  if (inRange('127.0.0.0/8')) return 'Loopback';
  if (inRange('169.254.0.0/16')) return 'Link-local (APIPA)';
  if (inRange('224.0.0.0/4')) return 'Multicast';
  if (inRange('240.0.0.0/4')) return 'Reserved';
  if (inRange('192.0.2.0/24') || inRange('198.51.100.0/24') || inRange('203.0.113.0/24')) return 'Documentation (RFC 5737)';
  if (inRange('198.18.0.0/15')) return 'Benchmarking (RFC 2544)';
  if (inRange('0.0.0.0/8')) return '"This network"';
  return 'Public';
}

const bits = (n        )         =>
  (n >>> 0)
    .toString(2)
    .padStart(32, '0')
    .replace(/(.{8})(?!$)/g, '$1.');

/** The in-addr.arpa zone that holds the reverse records of the network, on an octet boundary. */
function reverseZone(cidr      )         {
  const octets = formatIPv4(cidr.network).split('.');
  const whole = Math.max(1, Math.floor(cidr.prefix / 8));
  return `${octets.slice(0, whole).reverse().join('.')}.in-addr.arpa`;
}

/**
 * Read "10.1.2.3/24", "10.1.2.3 255.255.255.0", "10.1.2.3 /24" or a bare
 * address (taken as /32).
 */
export function parseSubnetInput(text        )                                           {
  const t = text.trim().replace(/\s*\/\s*/, '/');
  if (!t) return 'Type an address, e.g. 10.20.30.40/22 or 10.20.30.40 255.255.252.0.';
  const [addrPart = '', rest = ''] = t.includes('/') ? t.split('/') : t.split(/\s+/);
  const address = parseIPv4(addrPart);
  if (address === null) return `"${addrPart}" is not an IPv4 address.`;
  let prefix                = 32;
  if (rest) {
    if (/^\d{1,2}$/.test(rest)) prefix = Number(rest);
    else {
      const mask = parseIPv4(rest);
      prefix = mask === null ? null : maskToPrefix(mask);
    }
  }
  if (prefix === null || prefix < 0 || prefix > 32) return `"${rest}" is not a prefix (0–32) or a valid netmask.`;
  return { cidr: { network: (address & prefixToMask(prefix)) >>> 0, prefix }, address };
}

export function describeSubnet(text        )                         {
  const parsed = parseSubnetInput(text);
  if (typeof parsed === 'string') return parsed;
  const { cidr, address } = parsed;
  const mask = prefixToMask(cidr.prefix);
  const range = usableRange(cidr);
  const end = broadcastAddress(cidr);
  return {
    cidr: formatCidr(cidr),
    address: formatIPv4(address),
    network: formatIPv4(cidr.network),
    broadcast: cidr.prefix >= 31 ? 'none (/31 and /32 have no broadcast)' : formatIPv4(end),
    netmask: formatIPv4(mask),
    wildcard: formatIPv4((~mask) >>> 0),
    prefix: cidr.prefix,
    firstHost: formatIPv4(range.first),
    lastHost: formatIPv4(range.last),
    usable: usableAddresses(cidr),
    total: totalAddresses(cidr),
    kind: addressKind(address),
    reverseZone: reverseZone(cidr),
    next: end === 0xffffffff ? null : formatCidr({ network: (end + 1) >>> 0, prefix: cidr.prefix }),
    binaryMask: bits(mask),
    hostBitsSet: address !== cidr.network,
  };
}

                           
                        
                             
                            
                          
 

const row = (c      )           => {
  const r = usableRange(c);
  return { cidr: formatCidr(c), firstHost: formatIPv4(r.first), lastHost: formatIPv4(r.last), usable: usableAddresses(c) };
};

/** Split into pieces of a new prefix length, or into at least `count` equal pieces. Lists at most 1024. */
export function splitSubnet(text        , by                                     )                                               {
  const parent = parseCidr(text.includes('/') ? text : `${text}/32`);
  if (!parent) return 'Type the network to split, e.g. 10.0.0.0/16.';
  let prefix = by.prefix;
  if (by.count !== undefined) {
    if (!Number.isInteger(by.count) || by.count < 1) return 'The number of subnets must be 1 or more.';
    prefix = parent.prefix + Math.ceil(Math.log2(by.count));
  }
  if (prefix === undefined || !Number.isInteger(prefix) || prefix < parent.prefix || prefix > 32) return `The new prefix must be between /${parent.prefix} and /32.`;
  const total = 2 ** (prefix - parent.prefix);
  const step = 2 ** (32 - prefix);
  const rows             = [];
  for (let i = 0; i < Math.min(total, 1024); i += 1) rows.push(row({ network: (parent.network + i * step) >>> 0, prefix }));
  return { rows, total };
}

                                           
                        
                          
 

/**
 * Allocate the smallest subnet that holds each need, biggest first, from the
 * start of the parent. Returns what fitted and what did not.
 */
export function vlsm(parentText        , needs                                            )                                                                           {
  const parent = parseCidr(parentText);
  if (!parent) return 'Type the network to allocate from, e.g. 10.10.0.0/22.';
  const sorted = [...needs].filter((n) => n.name.trim() || n.hosts > 0).sort((a, b) => b.hosts - a.hosts);
  const end = broadcastAddress(parent);
  let cursor = parent.network;
  const rows            = [];
  const unallocated           = [];
  for (const need of sorted) {
    if (!Number.isInteger(need.hosts) || need.hosts < 1) {
      unallocated.push(`${need.name || '(no name)'}: hosts must be a whole number of 1 or more`);
      continue;
    }
    // Smallest prefix whose usable count covers the need (a /31 holds 2, a /32 one).
    let prefix = 32;
    while (prefix > 0 && usableAddresses({ network: 0, prefix }) < need.hosts) prefix -= 1;
    const size = 2 ** (32 - prefix);
    const aligned = Math.ceil(cursor / size) * size;
    if (prefix < parent.prefix || aligned + size - 1 > end) {
      unallocated.push(`${need.name || '(no name)'}: ${need.hosts} hosts needs a /${prefix}, and there is no room left`);
      continue;
    }
    rows.push({ name: need.name, needed: need.hosts, ...row({ network: aligned >>> 0, prefix }) });
    cursor = aligned + size;
  }
  return { rows, unallocated, free: cursor <= end ? `${formatIPv4(cursor >>> 0)} – ${formatIPv4(end)}` : null };
}

/** Is the address inside the network. */
export function checkContains(networkText        , addressText        )         {
  const cidr = parseCidr(networkText);
  const address = parseIPv4(addressText.trim());
  if (!cidr) return 'Type a network, e.g. 10.0.0.0/16.';
  if (address === null) return 'Type an address, e.g. 10.0.4.7.';
  return containsAddress(cidr, address) ? `Yes — ${formatIPv4(address)} is inside ${formatCidr(cidr)}.` : `No — ${formatIPv4(address)} is outside ${formatCidr(cidr)}.`;
}

/** Do two networks overlap, and how. */
export function checkOverlap(aText        , bText        )         {
  const a = parseCidr(aText);
  const b = parseCidr(bText);
  if (!a || !b) return 'Type two networks, e.g. 10.0.0.0/16 and 10.0.128.0/20.';
  if (!cidrsOverlap(a, b)) return `No overlap between ${formatCidr(a)} and ${formatCidr(b)}.`;
  if (a.network === b.network && a.prefix === b.prefix) return `They are the same network, ${formatCidr(a)}.`;
  const [outer, inner] = a.prefix <= b.prefix ? [a, b] : [b, a];
  return `Overlap: ${formatCidr(inner)} is inside ${formatCidr(outer)}.`;
}

/** The smallest single network that covers every network listed. */
export function supernet(list                   )         {
  const cidrs = list.map((t) => parseCidr(t.trim())).filter((c)            => c !== null);
  if (cidrs.length === 0) return 'List networks, one per line or comma separated.';
  const low = Math.min(...cidrs.map((c) => c.network));
  const high = Math.max(...cidrs.map((c) => broadcastAddress(c)));
  let prefix = 32;
  while (prefix > 0 && (((low & prefixToMask(prefix)) >>> 0) !== ((high & prefixToMask(prefix)) >>> 0))) prefix -= 1;
  const net = { network: (low & prefixToMask(prefix)) >>> 0, prefix };
  const covered = cidrs.reduce((n, c) => n + totalAddresses(c), 0);
  return `${formatCidr(net)} covers all ${cidrs.length} (${covered.toLocaleString()} of its ${totalAddresses(net).toLocaleString()} addresses are in the list).`;
}

// --- IPv6 ---------------------------------------------------------------------

/** Parse an IPv6 address to eight 16-bit groups, or null. */
export function parseIPv6(text        )                  {
  const t = text.trim().toLowerCase();
  if (!/^[0-9a-f:]+$/.test(t) || (t.match(/::/g) ?? []).length > 1) return null;
  const [head = '', tail = ''] = t.includes('::') ? t.split('::') : [t, ''];
  const h = head ? head.split(':') : [];
  const tl = tail ? tail.split(':') : [];
  if (!t.includes('::') && h.length !== 8) return null;
  const fill = 8 - h.length - tl.length;
  if (fill < 0 || (t.includes('::') && fill < 1)) return null;
  const groups = [...h, ...Array        (t.includes('::') ? fill : 0).fill('0'), ...tl];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** RFC 5952 form: lower case, no leading zeros, the longest run of zero groups as "::". */
export function compressIPv6(groups                   )         {
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > best.len && j - i > 1) best = { at: i, len: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.at < 0) return hex.join(':');
  return `${hex.slice(0, best.at).join(':')}::${hex.slice(best.at + best.len).join(':')}`;
}

                            
                              
                            
                          
                           
                        
                             
                        
 

export function describeIPv6(text        )                     {
  const [addr = '', p = '128'] = text.trim().split('/');
  const groups = parseIPv6(addr);
  if (!groups) return `"${addr}" is not an IPv6 address.`;
  const prefix = Number(p);
  if (!/^\d{1,3}$/.test(p) || prefix > 128) return 'The prefix must be 0–128.';
  const net = groups.map((g, i) => {
    const keep = Math.max(0, Math.min(16, prefix - i * 16));
    const mask = keep === 0 ? 0 : (0xffff << (16 - keep)) & 0xffff;
    return g & mask;
  });
  const last = net.map((g, i) => {
    const keep = Math.max(0, Math.min(16, prefix - i * 16));
    return g | (~((keep === 0 ? 0 : (0xffff << (16 - keep)) & 0xffff)) & 0xffff);
  });
  const first = groups[0] ;
  const kind =
    first >= 0xfe80 && first <= 0xfebf ? 'Link-local' : first >= 0xfc00 && first <= 0xfdff ? 'Unique local (ULA)' : first >= 0xff00 ? 'Multicast' : groups.every((g) => g === 0) ? 'Unspecified' : groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1 ? 'Loopback' : first >= 0x2000 && first <= 0x3fff ? 'Global unicast' : 'Reserved';
  return {
    compressed: compressIPv6(groups),
    expanded: groups.map((g) => g.toString(16).padStart(4, '0')).join(':'),
    prefix,
    network: `${compressIPv6(net)}/${prefix}`,
    last: compressIPv6(last),
    subnets64: prefix > 64 ? 'none — smaller than a /64' : prefix === 64 ? '1' : `2^${64 - prefix}${64 - prefix <= 20 ? ` (${(2 ** (64 - prefix)).toLocaleString()})` : ''}`,
    kind,
  };
}

// --- IPv6 networks: the same questions, in 128-bit arithmetic -------------------

const V6_MAX = (1n << 128n) - 1n;

                        
                           
                          
 

export function v6ToBig(groups                   )         {
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}

export function bigToV6(value        )           {
  const out           = [];
  for (let i = 7; i >= 0; i -= 1) out.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  return out;
}

const mask6 = (prefix        )         => (prefix === 0 ? 0n : (V6_MAX << BigInt(128 - prefix)) & V6_MAX);
const last6 = (c       )         => c.network | (~mask6(c.prefix) & V6_MAX);
export const formatCidr6 = (c       )         => `${compressIPv6(bigToV6(c.network))}/${c.prefix}`;
const fmt6 = (v        )         => compressIPv6(bigToV6(v));

export function parseCidr6(text        )               {
  const [addr = '', p = '128'] = text.trim().split('/');
  const groups = parseIPv6(addr);
  if (!groups || !/^\d{1,3}$/.test(p) || Number(p) > 128) return null;
  const prefix = Number(p);
  return { network: v6ToBig(groups) & mask6(prefix), prefix };
}

/** Which family the text is: an IPv6 address has a colon. */
export const isV6 = (text        )          => text.includes(':');

export function splitSubnet6(text        , by                                     )                                                                                    {
  const parent = parseCidr6(text);
  if (!parent) return 'Type the IPv6 network to split, e.g. 2001:db8::/48.';
  let prefix = by.prefix;
  if (by.count !== undefined) {
    if (!Number.isInteger(by.count) || by.count < 1) return 'The number of subnets must be 1 or more.';
    prefix = parent.prefix + Math.ceil(Math.log2(by.count));
  }
  if (prefix === undefined || !Number.isInteger(prefix) || prefix < parent.prefix || prefix > 128) return `The new prefix must be between /${parent.prefix} and /128.`;
  const total = 1n << BigInt(prefix - parent.prefix);
  const step = 1n << BigInt(128 - prefix);
  const rows                                                  = [];
  for (let i = 0n; i < total && i < 1024n; i += 1n) {
    const c = { network: parent.network + i * step, prefix };
    rows.push({ cidr: formatCidr6(c), first: fmt6(c.network), last: fmt6(last6(c)) });
  }
  return { rows, total };
}

/**
 * IPv6 VLSM: each need gets the smallest prefix that holds it, but never
 * smaller than a /64 unless it is a two-address point-to-point link, which
 * gets a /127 (RFC 6164) — SLAAC and most of the stack assume a /64 per LAN.
 */
export function vlsm6(parentText        , needs                                            )                                                                                                                          {
  const parent = parseCidr6(parentText);
  if (!parent) return 'Type the IPv6 network to allocate from, e.g. 2001:db8:100::/56.';
  const end = last6(parent);
  let cursor = parent.network;
  const rows                                                                                = [];
  const unallocated           = [];
  for (const need of [...needs].filter((n) => n.name.trim() || n.hosts > 0).sort((a, b) => b.hosts - a.hosts)) {
    if (!Number.isInteger(need.hosts) || need.hosts < 1) {
      unallocated.push(`${need.name || '(no name)'}: hosts must be a whole number of 1 or more`);
      continue;
    }
    let prefix = need.hosts <= 2 ? 127 : 128 - Math.ceil(Math.log2(need.hosts));
    if (prefix > 64 && prefix !== 127) prefix = 64;
    const size = 1n << BigInt(128 - prefix);
    const aligned = ((cursor + size - 1n) / size) * size;
    if (prefix < parent.prefix || aligned + size - 1n > end) {
      unallocated.push(`${need.name || '(no name)'}: needs a /${prefix}, and there is no room left`);
      continue;
    }
    const c = { network: aligned, prefix };
    rows.push({ name: need.name, needed: need.hosts, cidr: formatCidr6(c), first: fmt6(c.network), last: fmt6(last6(c)) });
    cursor = aligned + size;
  }
  return { rows, unallocated };
}

export function checkContains6(networkText        , addressText        )         {
  const c = parseCidr6(networkText);
  const a = parseIPv6(addressText);
  if (!c) return 'Type an IPv6 network, e.g. 2001:db8::/32.';
  if (!a) return 'Type an IPv6 address, e.g. 2001:db8:5::7.';
  const v = v6ToBig(a);
  return v >= c.network && v <= last6(c) ? `Yes — ${fmt6(v)} is inside ${formatCidr6(c)}.` : `No — ${fmt6(v)} is outside ${formatCidr6(c)}.`;
}

export function checkOverlap6(aText        , bText        )         {
  const a = parseCidr6(aText);
  const b = parseCidr6(bText);
  if (!a || !b) return 'Type two IPv6 networks, e.g. 2001:db8::/32 and 2001:db8:5::/48.';
  if (a.network > last6(b) || b.network > last6(a)) return `No overlap between ${formatCidr6(a)} and ${formatCidr6(b)}.`;
  if (a.network === b.network && a.prefix === b.prefix) return `They are the same network, ${formatCidr6(a)}.`;
  const [outer, inner] = a.prefix <= b.prefix ? [a, b] : [b, a];
  return `Overlap: ${formatCidr6(inner)} is inside ${formatCidr6(outer)}.`;
}

export function supernet6(list                   )         {
  const cidrs = list.map((t) => parseCidr6(t)).filter((c)             => c !== null);
  if (cidrs.length === 0) return 'List IPv6 networks, one per line or comma separated.';
  const low = cidrs.reduce((m, c) => (c.network < m ? c.network : m), cidrs[0] .network);
  const high = cidrs.reduce((m, c) => (last6(c) > m ? last6(c) : m), last6(cidrs[0] ));
  let prefix = 128;
  while (prefix > 0 && (low & mask6(prefix)) !== (high & mask6(prefix))) prefix -= 1;
  return `${formatCidr6({ network: low & mask6(prefix), prefix })} covers all ${cidrs.length}.`;
}
