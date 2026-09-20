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

import type { Finding } from '../core/findings.ts';
import type { CloudTarget } from './providers.ts';

export interface FoundationSubnet {
  /** Short name; emitters prefix it with the foundation name. */
  readonly name: string;
  readonly cidr: string;
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
  readonly cidr: string;
  readonly subnets: readonly FoundationSubnet[];
  readonly region?: string;
  readonly tags?: Readonly<Record<string, string>>;
  /** CIDRs allowed to reach the network. Defaults to nothing, not to the world. */
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

export const FOUNDATION_TARGETS: readonly CloudTarget[] = [
  'aws',
  'azure',
  'google',
  'oci',
  'vsphere',
];
