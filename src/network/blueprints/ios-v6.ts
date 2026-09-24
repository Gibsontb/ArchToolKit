/**
 * IPv6 on Cisco IOS and IOS-XE: the syntax the three IOS blueprint files share.
 *
 * IOS keeps the two families apart almost everywhere. An interface takes
 * `ip address a.b.c.d mask` and `ipv6 address x::y/len`; an access list is
 * either `ip access-list extended` with wildcards or `ipv6 access-list` with
 * prefix lengths, never both in one list; a prefix list, a policy route-map
 * match and an HSRP group are the same. So a field that takes "an address" takes
 * either family (or one of each), and each family is written its own way here.
 *
 * Where a feature has no IPv6 on IOS at all — IGMP, MSDP, PAT — the blueprint
 * says so with an error finding and writes nothing for the IPv6 value.
 */

import { error, type Finding } from '../../core/findings.ts';
import { familyOf, parseCidrAny } from '../../core/ip.ts';
import { listOf, netmask, parseCidrDual, wildcard } from '../device.ts';

export interface IosCidr {
  readonly address: string;
  readonly prefix: number;
  readonly family: 4 | 6;
  readonly network: string;
}

/** The suffix IPv6 twins of a named list get, so they never clash with the IPv4 one. */
export const V6 = '-V6';

/**
 * "10.0.0.1/24, 2001:db8::1/64" — any list of prefixes split by family. What
 * is neither goes to `invalid`, so the caller can say which entry was wrong.
 */
export function cidrList(text: string): { v4: IosCidr[]; v6: IosCidr[]; invalid: string[] } {
  const out = { v4: [] as IosCidr[], v6: [] as IosCidr[], invalid: [] as string[] };
  for (const item of listOf(text)) {
    const c = parseCidrDual(item);
    if (!c) out.invalid.push(item);
    else (c.family === 6 ? out.v6 : out.v4).push(c);
  }
  return out;
}

/** Bare addresses (no prefix) split by family; hostnames and junk go to `other`. */
export function addressList(text: string): { v4: string[]; v6: string[]; other: string[] } {
  const out = { v4: [] as string[], v6: [] as string[], other: [] as string[] };
  for (const item of listOf(text)) {
    const f = item.includes('/') ? null : familyOf(item);
    (f === 4 ? out.v4 : f === 6 ? out.v6 : out.other).push(item);
  }
  return out;
}

/** fe80::/10 — an address that means nothing off its own link. */
export function isLinkLocal(address: string): boolean {
  const c = parseCidrAny(address.split('/')[0] ?? '');
  return !!c && c.family === 6 && /^fe[89ab]/i.test(c.address);
}

/**
 * The address lines for an interface: `ip address` with a dotted mask for
 * IPv4, `ipv6 address x/len` for each IPv6 prefix and `ipv6 enable` so the
 * link-local exists even before a global address is reachable.
 */
export function interfaceAddressLines(v4: IosCidr | undefined, v6: readonly IosCidr[]): string[] {
  return [...(v4 ? [` ip address ${v4.address} ${netmask(v4.prefix)}`] : []), ...v6.map((c) => ` ipv6 address ${c.address}/${c.prefix}`), ...(v6.length > 0 ? [' ipv6 enable'] : [])];
}

/**
 * A network as an access-list operand. IPv4 keeps the wildcard form IOS has
 * always wanted (host for a /32); IPv6 takes the prefix length, host for a
 * /128 and any for ::/0 — `ipv6 access-list` has no wildcard masks at all.
 */
export function aclOperand(c: IosCidr): string {
  if (c.family === 4) return c.prefix === 32 ? `host ${c.address}` : `${c.address} ${wildcard(c.prefix)}`;
  if (c.prefix === 128) return `host ${c.address}`;
  if (c.prefix === 0) return 'any';
  return `${c.network}/${c.prefix}`;
}

/**
 * The end of every IPv6 access list written here. Neighbour discovery is
 * permitted before the final deny: IOS adds implicit nd-na/nd-ns permits only
 * when there is no explicit deny, and an explicit `deny ipv6 any any` without
 * them stops the interface resolving its neighbours — IPv6's ARP — at all.
 */
export function v6AclTail(log: boolean): string[] {
  return [' permit icmp any any nd-na', ' permit icmp any any nd-ns', ` deny ipv6 any any${log ? ' log' : ''}`];
}

/** A router id, OSPF area or BGP id is a 32-bit number written as dotted IPv4, for IPv6 too. */
export function routerIdFindings(value: string, what = 'The router id'): Finding[] {
  const v = String(value ?? '').trim();
  if (!v || (familyOf(v) === 4 && !v.includes('/'))) return [];
  return [
    error('network.ios.router-id', `${what} "${v}" is not dotted IPv4. It is a 32-bit identifier, even for OSPFv3 and IPv6 BGP — not an address, and never an IPv6 one.`, {
      remediation: 'Write it as 10.255.0.1, usually the IPv4 loopback address.',
      source: 'ArchToolKit',
    }),
  ];
}

/** "<feature> on Cisco IOS/IOS-XE does not support IPv6" — nothing is written for the IPv6 value. */
export function noIpv6(code: string, feature: string, remediation?: string): Finding {
  return error(code, `${feature} on Cisco IOS/IOS-XE does not support IPv6, so the IPv6 value was not used.`, { ...(remediation ? { remediation } : {}), source: 'ArchToolKit' });
}

/** One finding for the entries of a list that are not a prefix of either family. */
export function invalidEntries(code: string, what: string, invalid: readonly string[]): Finding[] {
  return invalid.length === 0
    ? []
    : [error(code, `${what}: ${invalid.join(', ')} is not an address with a prefix length, so it was left out.`, { remediation: 'Write it as 10.0.0.0/24 or 2001:db8::/64.', source: 'ArchToolKit' })];
}
