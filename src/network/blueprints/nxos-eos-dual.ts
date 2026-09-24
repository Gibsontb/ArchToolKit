/**
 * Dual-stack input for the NX-OS and EOS blueprints.
 *
 * Both platforms route IPv6 natively, so an address field here takes an IPv4
 * value, an IPv6 value, or one of each separated by a comma: a dual-stack SVI
 * is one interface with two addresses, not two changes. These helpers split
 * what was typed by family so a builder can write `ip …` and `ipv6 …` lines
 * from the same field, and say what could not be read rather than guess.
 *
 * The family decisions themselves come from core/ip.ts; nothing here parses
 * an address on its own.
 */

import { error, type Finding } from '../../core/findings.ts';
import { familyOf, isIpv4Address, parseCidrAny, type Family } from '../../core/ip.ts';
import { listOf, parseCidrDual } from '../device.ts';

export interface DualCidr {
  readonly family: Family;
  /** Canonical address (IPv6 compressed, IPv4 as typed). */
  readonly address: string;
  readonly prefix: number;
  readonly network: string;
  /** "address/prefix", ready to write after `ip address` or `ipv6 address`. */
  readonly text: string;
}

export interface Dual<T> {
  readonly v4: T | null;
  readonly v6: T | null;
  /** Entries that are not an address of either family. */
  readonly invalid: readonly string[];
  /** A family given more than once, where the field takes one of each. */
  readonly repeated: readonly Family[];
}

function split<T>(value: string, read: (item: string) => { family: Family; value: T } | null): Dual<T> {
  let v4: T | null = null;
  let v6: T | null = null;
  const invalid: string[] = [];
  const repeated: Family[] = [];
  for (const item of listOf(value)) {
    const parsed = read(item);
    if (!parsed) invalid.push(item);
    else if (parsed.family === 4) v4 === null ? (v4 = parsed.value) : repeated.push(4);
    else v6 === null ? (v6 = parsed.value) : repeated.push(6);
  }
  return { v4, v6, invalid, repeated };
}

/** "10.0.0.2/24, 2001:db8::2/64" — addresses with a prefix, one per family. */
export function dualCidrs(value: string): Dual<DualCidr> {
  return split(value, (item) => {
    const c = parseCidrDual(item);
    return c ? { family: c.family, value: { ...c, text: `${c.address}/${c.prefix}` } } : null;
  });
}

/** "10.0.0.1, 2001:db8::1" — bare addresses (a virtual gateway), one per family. */
export function dualAddresses(value: string): Dual<string> {
  return split(value, (item) => {
    const c = item.includes('/') ? null : parseCidrAny(item);
    return c ? { family: c.family, value: c.address } : null;
  });
}

/** The findings for a dual field: an error per unreadable entry or repeated family. */
export function dualFindings(code: string, label: string, dual: Dual<unknown>, example: string): Finding[] {
  return [
    ...dual.invalid.map((item) => error(code, `"${item}" in ${label} is not a valid IPv4 or IPv6 address${example.includes('/') ? ' and prefix' : ''}.`, { remediation: `Write it as ${example}.`, source: 'ArchToolKit' })),
    ...dual.repeated.map((family) => error(code, `${label} has more than one IPv${family} value. It takes one IPv4 and one IPv6 at most.`, { source: 'ArchToolKit' })),
  ];
}

/** Addresses from a list, split by family, with the unreadable ones kept apart. */
export function addressList(value: string): { v4: string[]; v6: string[]; invalid: string[] } {
  const out = { v4: [] as string[], v6: [] as string[], invalid: [] as string[] };
  for (const item of listOf(value)) {
    const c = item.includes('/') ? null : parseCidrAny(item);
    if (!c) out.invalid.push(item);
    else (c.family === 4 ? out.v4 : out.v6).push(c.address);
  }
  return out;
}

/** The feature takes no IPv6 on this platform: say so, and write nothing for it. */
export function noIpv6(code: string, feature: string, platform: string): Finding {
  return error(code, `${feature} on ${platform} does not support IPv6.`, { remediation: 'Use an IPv4 address here.', source: 'ArchToolKit' });
}

/**
 * IPv6 support for this feature could not be confirmed for the platform, so
 * no IPv6 configuration is written rather than something the device rejects.
 */
export function unverifiedIpv6(code: string, feature: string, platform: string): Finding {
  return error(code, `${feature} on ${platform}: IPv6 is not confirmed for this feature, so no IPv6 configuration was written.`, {
    remediation: 'VERIFY: check the configuration guide for the release in use. Until then, use an IPv4 address here.',
    source: 'ArchToolKit',
  });
}

/** A BGP or OSPF router id is a 32-bit number written dotted, whatever the address families. */
export function routerIdFindings(code: string, value: string): Finding[] {
  const v = String(value ?? '').trim();
  if (!v || isIpv4Address(v)) return [];
  return [error(code, `The router id "${v}" is not in dotted IPv4 form. It is a 32-bit identifier, not an address, and stays dotted even on an IPv6-only router.`, { remediation: 'Write it as 10.255.0.11.', source: 'ArchToolKit' })];
}

/**
 * The family an access-list rule is written for, from the addresses in it:
 * 4, 6, null when it names none ("permit tcp any any eq 22"), or 'mixed' when
 * it names both — which no platform accepts in one entry.
 */
export function ruleFamily(rule: string): Family | null | 'mixed' {
  const families = new Set<Family>();
  for (const token of rule.split(/\s+/)) {
    const f = familyOf(token);
    if (f !== null) families.add(f);
  }
  if (families.size > 1) return 'mixed';
  return families.size === 1 ? [...families][0]! : null;
}

/**
 * A rule rewritten for an IPv6 list: the protocol `ip` becomes `ipv6`, and
 * `icmp` becomes whatever the platform calls ICMPv6 in an IPv6 list.
 */
export function ipv6Rule(rule: string, icmp: 'icmp' | 'icmpv6'): string {
  const tokens = rule.trim().split(/\s+/);
  const at = /^\d+$/.test(tokens[0] ?? '') ? 2 : 1;
  if (tokens[at] === 'ip') tokens[at] = 'ipv6';
  else if (tokens[at] === 'icmp') tokens[at] = icmp;
  return tokens.join(' ');
}

export interface PrefixEntry {
  readonly family: Family;
  /** The prefix and its ge/le, as written after `permit`. */
  readonly text: string;
}

/** A prefix-list line — "10.10.0.0/16 le 24" — checked for family and ge/le bounds. */
export function prefixEntry(line: string): PrefixEntry | string {
  const [first = '', ...rest] = line.trim().split(/\s+/);
  const c = parseCidrDual(first);
  if (!c) return `"${line}" is not a prefix.`;
  const max = c.family === 6 ? 128 : 32;
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const n = Number(rest[i + 1]);
    if ((key !== 'ge' && key !== 'le') || !Number.isInteger(n)) return `"${line}" has something other than ge or le after the prefix.`;
    if (n < c.prefix || n > max) return `"${line}": ${key} ${n} must be between the prefix length ${c.prefix} and ${max}.`;
  }
  // IPv4 is kept as typed; IPv6 is written as its compressed network.
  return { family: c.family, text: [c.family === 4 ? first : `${c.network}/${c.prefix}`, ...rest].join(' ') };
}
