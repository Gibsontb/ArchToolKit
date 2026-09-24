/**
 * PAN-OS and the two address families.
 *
 * PAN-OS 11.x is dual-stack almost everywhere an address goes: objects, rules,
 * interfaces, routes, server profiles, the management interface. The places it
 * is not — dynamic-IP-and-port NAT, or a feature whose IPv6 support could not
 * be confirmed — are decided here once, so the three blueprint files give the
 * same answer and the same wording.
 */

import { familyOf, type Family } from '../../core/ip.ts';
import { error, warning, type Finding } from '../../core/findings.ts';

/** The release the PAN-OS blueprints are written against. */
export const PANOS_VERSION = 'PAN-OS 11.x';

/**
 * An entry typed as an address rather than as an object name. PAN-OS names
 * cannot contain a colon, and a name that is only digits and dots is an
 * address someone mistyped rather than a name.
 */
export const looksLikeAddress = (text: string): boolean => /^[\d.]+(\/\d+)?$/.test(text.trim()) || text.includes(':');

/** The entries written as addresses that are not valid addresses or prefixes of either family. */
export const badAddresses = (items: readonly string[]): string[] => items.filter((item) => looksLikeAddress(item) && familyOf(item) === null);

/** The families of the entries written as addresses; object names and "any" say nothing. */
export function familiesOf(items: readonly string[]): Set<Family> {
  const out = new Set<Family>();
  for (const item of items) {
    const family = looksLikeAddress(item) ? familyOf(item) : null;
    if (family) out.add(family);
  }
  return out;
}

/**
 * Two hosts for `test security-policy-match`, one from each side and of the
 * same family: the rule's own addresses where it names some, and documentation
 * addresses where it names only objects. IPv6 only when the rule is IPv6 only.
 */
export function testAddresses(source: readonly string[], destination: readonly string[]): { source: string; destination: string; family: Family } {
  const families = familiesOf([...source, ...destination]);
  const family: Family = families.has(6) && !families.has(4) ? 6 : 4;
  const host = (items: readonly string[]) => items.find((item) => looksLikeAddress(item) && familyOf(item) === family)?.split('/')[0];
  return {
    source: host(source) ?? (family === 6 ? '2001:db8::1' : '10.0.0.1'),
    destination: host(destination) ?? (family === 6 ? '2001:db8::2' : '10.0.0.2'),
    family,
  };
}

/** An error for a field that holds something that is not an address. */
export function badAddressFinding(field: string, bad: readonly string[]): Finding {
  return error('network.panos.bad-address', `${field}: ${bad.map((b) => `"${b}"`).join(', ')} ${bad.length === 1 ? 'is' : 'are'} not a valid IPv4 or IPv6 address or prefix.`, {
    remediation: 'Write addresses as 10.20.30.11/32 or 2001:db8::11/128, or use an object name.',
    source: 'ArchToolKit',
  });
}

/** An IPv6 value given to a feature PAN-OS does not support IPv6 for. */
export function ipv6Unsupported(code: string, feature: string, remediation?: string): Finding {
  return error(code, `${feature} on ${PANOS_VERSION} does not support IPv6.`, { ...(remediation ? { remediation } : {}), source: 'ArchToolKit' });
}

/**
 * An IPv6 value for a feature whose IPv6 support is not confirmed: the line
 * is left out rather than guessed, and the finding says what is missing.
 */
export function ipv6Unverified(code: string, feature: string, severity: 'error' | 'warning' = 'warning'): Finding {
  const message = `${feature} was left out: IPv6 support for it on ${PANOS_VERSION} is not confirmed.`;
  const extra = { remediation: 'VERIFY against the release notes for the exact version, and add it by hand if it is supported.', source: 'ArchToolKit' };
  return severity === 'error' ? error(code, message, extra) : warning(code, message, extra);
}
