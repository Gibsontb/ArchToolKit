/**
 * A network foundation, described once and emitted for any cloud.
 *
 * Every cloud asks the same first question — a private network, some subnets, a
 * way out to the internet, and rules about what may enter — and then answers it
 * with entirely different nouns. A VPC is a VNet is a VCN. This holds the
 * question; the per-cloud modules hold each answer.
 *
 * The shape is deliberately small. It covers what an architect decides early and
 * has to keep consistent across clouds, not everything a provider can express.
 * Anything past this belongs in hand-written Terraform: a generator that tries to
 * cover every argument becomes one nobody can predict.
 */

import { error, warning, type Finding } from '../core/findings.ts';
import { familyOf, isAnyNetwork, parseCidrAny, containsAny } from '../core/ip.ts';
import { nthSlash64 } from './blueprints/dual-stack.ts';
import type { CloudTarget } from './providers.ts';

export interface FoundationSubnet {
  /** Short name; emitters prefix it with the foundation name. */
  readonly name: string;
  /** The subnet's IPv4 range. IPv6 goes in `ipv6Cidr`, with `ipv6` on the plan. */
  readonly cidr: string;
  /**
   * The subnet's IPv6 /64, for a cloud that wants it written (Azure). AWS, Google
   * and OCI allocate the network's IPv6 block themselves and carve a /64 per
   * subnet from it, so there it may be left out.
   */
  readonly ipv6Cidr?: string;
  /** A public subnet routes to the internet gateway and may assign public IPs. */
  readonly public?: boolean;
  /**
   * Availability zone, region zone or availability domain, where the cloud
   * places subnets in one. Omitted means regional, which most clouds prefer.
   */
  readonly zone?: string;
}

export interface FoundationPlan {
  /** Prefix for every generated name. Lowercase, hyphenated. */
  readonly name: string;
  /** The network's IPv4 range. Every cloud here requires one, even dual-stack. */
  readonly cidr: string;
  readonly subnets: readonly FoundationSubnet[];
  readonly region?: string;
  readonly tags?: Readonly<Record<string, string>>;
  /**
   * Dual stack: IPv6 on the network and every subnet, alongside IPv4. Off by
   * default. AWS, Google and OCI allocate the IPv6 block; Azure needs `ipv6Cidr`.
   */
  readonly ipv6?: boolean;
  /** The network's IPv6 range where the cloud does not allocate one (Azure, e.g. a /48). */
  readonly ipv6Cidr?: string;
  /**
   * CIDRs allowed to reach the network, either family. Defaults to nothing, not
   * to the world. Each becomes its own rule, so no rule mixes families.
   */
  readonly allowedIngressCidrs?: readonly string[];
  readonly allowedTcpPorts?: readonly number[];
  /** OCI places everything in a compartment; nothing can be emitted without it. */
  readonly compartmentId?: string;
  /** vSphere: the datacenter that existing infrastructure is looked up in. */
  readonly datacenter?: string;
  /** vSphere: the cluster whose root resource pool is the parent. */
  readonly cluster?: string;
  /** vSphere: physical NICs to map to uplinks, in order. */
  readonly vmnics?: readonly string[];
}

export interface FoundationOutput {
  readonly files: Readonly<Record<string, string>>;
  readonly findings: readonly Finding[];
}

export type FoundationEmitter = (plan: FoundationPlan) => FoundationOutput;

/** Sanitise a name for use as a Terraform identifier. */
export function identifier(...parts: readonly string[]): string {
  return parts
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

/** Sanitise a name for use as a cloud resource name. */
export function resourceName(...parts: readonly string[]): string {
  return parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * The checks every cloud makes on addresses before emitting anything.
 *
 * The network and subnet `cidr` fields are the IPv4 ranges — none of these
 * clouds builds a network without one — so an IPv6 value there is pointed at
 * `ipv6`. Ingress CIDRs may be either family; each is checked, "the whole
 * internet" is caught for both 0.0.0.0/0 and ::/0, and an IPv6 source on a
 * network that is not dual-stack is flagged, because the rule can never match.
 */
export function checkFoundationAddresses(plan: FoundationPlan, cloud: string, label: string): Finding[] {
  const findings: Finding[] = [];
  const v4Only = (value: string, path: string): void => {
    const c = parseCidrAny(value);
    if (!c || !value.includes('/')) {
      findings.push(error(`terraform.${cloud}.invalid-cidr`, `"${value}" is not a CIDR.`, { path }));
    } else if (c.family === 6) {
      findings.push(
        error(`terraform.${cloud}.ipv4-range-required`, `${label} needs an IPv4 range at ${path}; "${value}" is IPv6.`, {
          path,
          remediation: 'Give the IPv4 range here and set ipv6 for dual stack.',
        }),
      );
    }
  };
  v4Only(plan.cidr, 'cidr');
  plan.subnets.forEach((s, i) => v4Only(s.cidr, `subnets[${i}].cidr`));

  for (const [i, cidr] of (plan.allowedIngressCidrs ?? []).entries()) {
    const family = familyOf(cidr);
    if (family === null) {
      findings.push(
        error(`terraform.${cloud}.invalid-ingress-cidr`, `"${cidr}" is not an IPv4 or IPv6 address or CIDR.`, {
          path: `allowedIngressCidrs[${i}]`,
        }),
      );
    } else if (family === 6 && !plan.ipv6) {
      findings.push(
        warning(
          `terraform.${cloud}.ipv6-ingress-without-ipv6`,
          `Ingress from ${cidr} is IPv6, but the network is not dual-stack, so the rule can never match.`,
          { path: `allowedIngressCidrs[${i}]`, remediation: 'Set ipv6 on the plan, or remove the IPv6 source.' },
        ),
      );
    }
  }
  return findings;
}

/** Is any ingress source "the whole internet", in either family. */
export const worldIngress = (plan: FoundationPlan): string[] =>
  (plan.allowedIngressCidrs ?? []).filter((c) => isAnyNetwork(c));

/**
 * The IPv6 /64 for each subnet, for a cloud where they are written out (Azure).
 * A subnet's own `ipv6Cidr` wins; otherwise the n-th /64 of the network's range.
 */
export function subnetIpv6Ranges(plan: FoundationPlan, cloud: string): { ranges: string[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const network = plan.ipv6Cidr ? parseCidrAny(plan.ipv6Cidr) : null;
  if (!network || network.family !== 6 || !plan.ipv6Cidr!.includes('/') || network.prefix > 64) {
    findings.push(
      error(`terraform.${cloud}.ipv6-cidr-required`, 'Dual stack here needs the network\'s IPv6 range (ipv6Cidr), a /64 or larger, e.g. a /48.', {
        path: 'ipv6Cidr',
        remediation: 'Give a ULA (fd00::/8) or an assigned global /48 in ipv6Cidr.',
      }),
    );
    return { ranges: [], findings };
  }
  const size = 1n << BigInt(64 - network.prefix);
  const ranges = plan.subnets.map((s, i) => {
    if (s.ipv6Cidr) {
      const c = parseCidrAny(s.ipv6Cidr);
      if (!c || c.family !== 6 || c.prefix !== 64) {
        findings.push(
          error(`terraform.${cloud}.subnet-ipv6-not-64`, `Subnet ${s.name}: "${s.ipv6Cidr}" is not an IPv6 /64, which is the only size a subnet takes.`, {
            path: `subnets[${i}].ipv6Cidr`,
          }),
        );
      } else if (!containsAny(`${network.network}/${network.prefix}`, c.network)) {
        findings.push(
          error(`terraform.${cloud}.subnet-ipv6-outside`, `Subnet ${s.name}: ${s.ipv6Cidr} is not inside ${plan.ipv6Cidr}.`, {
            path: `subnets[${i}].ipv6Cidr`,
          }),
        );
      }
      return c ? `${c.network}/${c.prefix}` : s.ipv6Cidr;
    }
    if (BigInt(i) >= size) {
      findings.push(error(`terraform.${cloud}.ipv6-cidr-too-small`, `${plan.ipv6Cidr} has no /64 left for subnet ${s.name}.`, { path: 'ipv6Cidr' }));
      return '';
    }
    return nthSlash64(network.network, i);
  });
  return { ranges, findings };
}


export const FOUNDATION_TARGETS: readonly CloudTarget[] = [
  'aws',
  'azure',
  'google',
  'oci',
  'vsphere',
];
