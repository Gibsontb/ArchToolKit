/**
 * Network text tools: pull addresses, networks, MACs, URLs and emails out of
 * logs and configs; sort and check lists of addresses; rewrite IPv6 in
 * compressed or expanded form.
 *
 * Deciding what is an address is core/ip.ts's job (and the IPv6 arithmetic
 * core/net-calc.ts's). The regexes here only find candidates; every one is
 * confirmed by the core before it is kept, so "999.1.1.1" and "std::map"
 * never come out as addresses.
 */

import { familyOf, parseCidrAny } from '../../core/ip.js';
import { formatIPv4, parseIPv4 } from '../../core/net.js';
import { compressIPv6, parseIPv6, v6ToBig } from '../../core/net-calc.js';

// Candidates. Word boundaries are lookarounds so "10.0.0.1." at the end of a
// sentence still matches but "1.2.3.4.5" does not.
const V4 = String.raw`(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w]|\.\d)`;
const V6 = String.raw`(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?:%[\w.-]+)?(?![\w:]|\.\d)`;
const PREFIX = String.raw`\/\d{1,3}(?!\d)`;

const cleanV6 = (s        )         => s.replace(/%.*$/, '');

/** IPv4 addresses in the text, in order of appearance, as written (canonical dotted form). */
export function findIPv4(text        )           {
  const out           = [];
  for (const m of text.matchAll(new RegExp(V4, 'g'))) {
    const v = parseIPv4(m[0]);
    if (v !== null) out.push(formatIPv4(v));
  }
  return out;
}

/** IPv6 addresses, compressed (RFC 5952), zone IDs dropped. */
export function findIPv6(text        )           {
  const out           = [];
  for (const m of text.matchAll(new RegExp(V6, 'g'))) {
    // A bare "::" is far more often C++ or Perl than the unspecified address.
    const groups = /[0-9A-Fa-f]/.test(cleanV6(m[0])) ? parseIPv6(cleanV6(m[0])) : null;
    if (groups) out.push(compressIPv6(groups));
  }
  return out;
}

/** Networks written with a prefix length, either family, canonical address, host bits kept as written. */
export function findCidrs(text        )           {
  const out           = [];
  for (const re of [new RegExp(`${V4.replace(String.raw`(?![\w]|\.\d)`, '')}${PREFIX}`, 'g'), new RegExp(`${V6.replace(String.raw`(?:%[\w.-]+)?(?![\w:]|\.\d)`, '')}${PREFIX}`, 'g')]) {
    for (const m of text.matchAll(re)) {
      const c = parseCidrAny(m[0]);
      if (c) out.push(`${c.address}/${c.prefix}`);
    }
  }
  return out;
}

/**
 * MAC addresses in the three common spellings — 00:1a:2b:3c:4d:5e,
 * 00-1A-2B-3C-4D-5E, 001a.2b3c.4d5e (Cisco) — normalised to lower-case
 * colon form so the same NIC seen by different tools dedupes.
 */
export function findMacs(text        )           {
  const re = /(?<![\w:.-])(?:[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4})(?![\w:.-]*[0-9A-Fa-f:])/g;
  const out           = [];
  for (const m of text.matchAll(re)) {
    const hex = m[0].replace(/[^0-9A-Fa-f]/g, '').toLowerCase();
    out.push(hex.match(/../g) .join(':'));
  }
  return out;
}

export function findUrls(text        )           {
  const out           = [];
  for (const m of text.matchAll(/\b(?:https?|ftps?|sftp|ssh|ldaps?|wss?|file):\/\/[^\s<>"'`{}|\\^]+/gi)) {
    // Sentence punctuation and an unbalanced closing bracket are not part of the URL.
    let url = m[0].replace(/[.,;:!?]+$/, '');
    while (/[)\]]$/.test(url) && (url.match(/[(\[]/g) ?? []).length < (url.match(/[)\]]/g) ?? []).length) url = url.slice(0, -1);
    out.push(url);
  }
  return out;
}

export function findEmails(text        )           {
  return [...text.matchAll(/(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g)].map((m) => m[0]);
}

// --- Ordering ---------------------------------------------------------------------

/** Numeric sort key: family, then address, then prefix. IPv4 first. */
export function ipSortKey(text        )                                  {
  const c = parseCidrAny(text.trim());
  if (!c) return null;
  const value = c.family === 4 ? BigInt(parseIPv4(c.address) ) : v6ToBig(parseIPv6(c.address) );
  return [c.family, value, text.includes('/') ? c.prefix : c.family === 4 ? 32 : 128];
}

export function compareIps(a        , b        )         {
  const x = ipSortKey(a);
  const y = ipSortKey(b);
  if (!x || !y) return x ? -1 : y ? 1 : a.localeCompare(b);
  return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2];
}

/** Unique, numerically sorted. */
export const uniqueSortedIps = (list                   )           => [...new Set(list)].sort(compareIps);
export const uniqueSorted = (list                   )           => [...new Set(list)].sort((a, b) => a.localeCompare(b));

/**
 * Sort lines by the address or network each starts with — "10.0.0.2 web01"
 * sorts by 10.0.0.2 — both families, IPv4 first. Lines that do not start
 * with one keep their order at the end, so nothing is lost.
 */
export function sortLinesByIp(text        )         {
  const lines = text.split('\n');
  const keyed = lines.map((line, i) => ({ line, i, key: ipSortKey(/^\s*([^\s,;]+)/.exec(line)?.[1] ?? '') }));
  const withIp = keyed.filter((k) => k.key);
  const rest = keyed.filter((k) => !k.key && k.line.trim());
  const blank = keyed.filter((k) => !k.key && !k.line.trim());
  withIp.sort((a, b) => {
    const x = a.key ;
    const y = b.key ;
    return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2] || a.i - b.i;
  });
  // A trailing newline stays trailing, rather than sorting to the top as an empty line.
  const trailing = text.endsWith('\n') ? blank.pop() : undefined;
  return [...withIp, ...rest, ...blank, ...(trailing ? [trailing] : [])].map((k) => k.line).join('\n');
}

// --- Validation --------------------------------------------------------------------

                            
                        
                        
                           
 

/** Each non-blank line must be one address or network; notes for host bits set in a network. */
export function validateIpLines(text        )                                                            {
  const bad              = [];
  const notes              = [];
  let checked = 0;
  text.split('\n').forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith('#')) return;
    checked += 1;
    const c = parseCidrAny(t);
    if (!c) {
      bad.push({ line: i + 1, text: t, problem: t.includes('/') ? 'not a valid network (address/prefix)' : 'not a valid IPv4 or IPv6 address' });
      return;
    }
    if (t.includes('/') && c.network !== c.address) notes.push({ line: i + 1, text: t, problem: `host bits set — the network is ${c.network}/${c.prefix}` });
  });
  return { bad, notes, checked };
}

// --- IPv6 rewriting ---------------------------------------------------------------

/** Rewrite every IPv6 address in the text compressed or fully expanded; prefixes and zone IDs stay. */
export function rewriteIPv6(text        , mode                       )                                  {
  let count = 0;
  const out = text.replace(new RegExp(V6, 'g'), (whole) => {
    const zone = /%.*$/.exec(whole)?.[0] ?? '';
    const groups = /[0-9A-Fa-f]/.test(cleanV6(whole)) ? parseIPv6(cleanV6(whole)) : null;
    if (!groups) return whole;
    const next = mode === 'compress' ? compressIPv6(groups) : groups.map((g) => g.toString(16).padStart(4, '0')).join(':');
    if (next !== cleanV6(whole)) count += 1;
    return next + zone;
  });
  return { text: out, count };
}

/** Is it a single address or network, and which family — for the Subnet info command. */
export const selectionFamily = (text        )               => familyOf(text.trim());
