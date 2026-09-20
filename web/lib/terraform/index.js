/**
 * The Terraform authoring kit.
 *
 * One entry point, so a caller picks a cloud rather than an emitter.
 */

                                                  
                                                                        
import { emitAwsFoundation } from './aws.js';
import { emitAzureFoundation } from './azure.js';
import { emitGoogleFoundation } from './google.js';
import { emitOciFoundation } from './oci.js';
import { emitVsphereFoundation } from './vsphere.js';
import { warning } from '../core/findings.js';

export * from './hcl.js';
export * from './providers.js';
export * from './foundation.js';
export * from './scaffold.js';
export * from './catalog.js';
export * from './resource.js';
export { emitTerraform } from './vcf.js';
export { emitAwsFoundation } from './aws.js';
export { emitAzureFoundation } from './azure.js';
export { emitGoogleFoundation } from './google.js';
export { emitOciFoundation } from './oci.js';
export { emitVsphereFoundation } from './vsphere.js';

export function emitFoundation(target             , plan                )                   {
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
