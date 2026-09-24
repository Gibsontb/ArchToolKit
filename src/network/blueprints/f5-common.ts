/**
 * What every F5 blueprint needs to read an address the same way.
 *
 * A BIG-IP is dual-stack throughout: a virtual address, a pool member, a SNAT
 * address and a GSLB answer can each be IPv4 or IPv6, and one pool may hold
 * both. What differs is how an address is written next to a port — tmsh uses
 * `10.0.0.1:80` for IPv4 but `2001:db8::1.80` for IPv6, because the colon is
 * already taken — and what happens when the client side and the server side
 * are different families: the BIG-IP translates between them, but only with a
 * source translation, because the server cannot answer an address family it
 * does not have.
 *
 * Kept in its own file because f5.ts imports the other two F5 files, and they
 * cannot import back from it.
 */

import { error, type Finding } from '../../core/findings.ts';
import { familyOf, isIp, splitHostPort, type Family } from '../../core/ip.ts';
import { listOf } from '../device.ts';

/** One AS3 `members` entry: the addresses that share a service port. */
export interface MemberGroup {
  readonly servicePort: number;
  readonly serverAddresses: string[];
}

export interface Members {
  /** Every valid address, in the order typed. */
  readonly servers: string[];
  /** The first port, for the places that name one. */
  readonly port: number;
  /** Grouped by port, which is how AS3 wants members with different ports. */
  readonly groups: MemberGroup[];
  /** Entries that are not an address (a hostname, a typo). */
  readonly invalid: string[];
  readonly families: ReadonlySet<Family>;
}

/**
 * Pool members typed as "10.20.30.11:8080", "[2001:db8::11]:8080", the tmsh
 * form "2001:db8::11.8080", or a bare address that takes the default port.
 * Separated by commas, spaces or new lines.
 */
export function parseMembers(value: string, defaultPort: number): Members {
  const servers: string[] = [];
  const invalid: string[] = [];
  const families = new Set<Family>();
  const byPort = new Map<number, string[]>();
  for (const part of listOf(String(value ?? '').replace(/\n/g, ','))) {
    let { host, port } = splitHostPort(part);
    // tmsh writes an IPv6 member as address.port; a valid address wins over that reading.
    const dotted = /^(.+:.*)\.(\d{1,5})$/.exec(part);
    if (!isIp(host) && dotted && isIp(dotted[1]!)) {
      host = dotted[1]!;
      port = Number(dotted[2]);
    }
    if (!isIp(host)) {
      invalid.push(part);
      continue;
    }
    const servicePort = port !== null && port >= 1 && port <= 65535 ? port : defaultPort;
    servers.push(host);
    families.add(familyOf(host)!);
    byPort.set(servicePort, [...(byPort.get(servicePort) ?? []), host]);
  }
  const groups = [...byPort.entries()].map(([servicePort, serverAddresses]) => ({ servicePort, serverAddresses }));
  return { servers, port: groups[0]?.servicePort ?? defaultPort, groups, invalid, families };
}

/** The AS3 `members` array, one entry per port, with any extra properties each entry needs. */
export function as3Members(members: Members, extra: Record<string, unknown> = {}): Record<string, unknown>[] {
  return members.groups.map((group) => ({ servicePort: group.servicePort, serverAddresses: group.serverAddresses, ...extra }));
}

/** A pool member as tmsh names it: 10.0.0.1:80, 2001:db8::1.80. */
export const tmshMember = (address: string, port: number): string => `${address}${familyOf(address) === 6 ? '.' : ':'}${port}`;

/**
 * The checks every virtual server shares: the address is one, the members are
 * addresses, and a virtual and pool of different families have the source
 * translation that makes the answer come back.
 */
export function virtualFindings(
  virtual: string,
  members: Members,
  snat: 'auto' | 'none' | string,
  code = 'network.f5.bad-virtual-address',
): { findings: Finding[]; notes: string[] } {
  const findings: Finding[] = [];
  const notes: string[] = [];
  if (!isIp(virtual)) findings.push(error(code, 'The virtual address is not a valid IPv4 or IPv6 address.', { source: 'ArchToolKit' }));
  if (members.invalid.length > 0) {
    findings.push(
      error('network.f5.bad-member', `Not a pool member address: ${members.invalid.join(', ')}.`, {
        remediation: 'Write each as 10.20.30.11:8080, [2001:db8::11]:8080 or 2001:db8::11.8080. A name belongs in an FQDN pool, not here.',
        source: 'ArchToolKit',
      }),
    );
  }
  const vip = familyOf(virtual);
  const crossed = vip !== null && [...members.families].some((f) => f !== vip);
  if (crossed && snat === 'none') {
    findings.push(
      error('network.f5.cross-family-no-snat', `The virtual address is IPv${vip} but the pool has IPv${vip === 4 ? 6 : 4} members. The BIG-IP translates between families only with a source translation, so with SNAT off those members can never answer.`, {
        remediation: 'Turn SNAT automap on, or use a SNAT pool of the members’ family.',
        source: 'ArchToolKit',
      }),
    );
  } else if (crossed) {
    notes.push(`The virtual address is IPv${vip} and some members are IPv${vip === 4 ? 6 : 4}: the BIG-IP translates between the families, and SNAT automap needs a self IP of the members’ family on their VLAN to use as the source.`);
  }
  return { findings, notes };
}
