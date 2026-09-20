/**
 * Every Terraform Map, in the order the platform picker offers them.
 *
 * Three came out of the previous toolkit and are generated into map-data.ts;
 * the AWS one is written here in the repository because the original was a
 * mislabelled copy of the Azure page. They are the same shape either way, and
 * the page does not know which is which.
 */

import type { CloudMap } from './map.ts';
import { AWS_MAP } from './map-aws.ts';
import { AZURE_MAP, GOOGLE_MAP, OCI_MAP } from './map-data.ts';
import type { CloudTarget } from './providers.ts';

export const MAPS: readonly CloudMap[] = [AWS_MAP, AZURE_MAP, GOOGLE_MAP, OCI_MAP];

export function mapFor(target: string): CloudMap | undefined {
  return MAPS.find((map) => map.target === target);
}

export function mappedTargets(): readonly CloudTarget[] {
  return MAPS.map((map) => map.target);
}
