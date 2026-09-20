/**
 * The Terraform authoring kit.
 *
 * One entry point, so a caller picks a cloud rather than an emitter.
 */

import type { CloudTarget } from './providers.ts';
import type { FoundationPlan, FoundationOutput } from './foundation.ts';
import { emitAwsFoundation } from './aws.ts';
import { emitAzureFoundation } from './azure.ts';
import { emitGoogleFoundation } from './google.ts';
import { emitOciFoundation } from './oci.ts';
import { emitVsphereFoundation } from './vsphere.ts';
import { warning } from '../core/findings.ts';

export * from './hcl.ts';
export * from './providers.ts';
export * from './foundation.ts';
export * from './scaffold.ts';
export { emitTerraform } from './vcf.ts';
export { emitAwsFoundation } from './aws.ts';
export { emitAzureFoundation } from './azure.ts';
export { emitGoogleFoundation } from './google.ts';
export { emitOciFoundation } from './oci.ts';
export { emitVsphereFoundation } from './vsphere.ts';

export function emitFoundation(target: CloudTarget, plan: FoundationPlan): FoundationOutput {
  switch (target) {
    case 'aws':
      return emitAwsFoundation(plan);
    case 'azure':
      return emitAzureFoundation(plan);
    case 'google':
      return emitGoogleFoundation(plan);
    case 'oci':
      return emitOciFoundation(plan);
    case 'vsphere':
      return emitVsphereFoundation(plan);
    case 'vcf':
      // VCF bring-up is a specification, not a network foundation; it is emitted
      // from an SddcSpec by emitTerraform rather than from a foundation plan.
      return {
        files: {},
        findings: [
          warning(
            'terraform.foundation.vcf-not-a-foundation',
            'VCF is deployed from a specification rather than a network foundation. Build a spec and use the VCF emitter.',
            { source: 'ArchToolKit' },
          ),
        ],
      };
    default:
      return {
        files: {},
        findings: [
          warning('terraform.foundation.unknown-target', `No emitter for target "${target}".`),
        ],
      };
  }
}
