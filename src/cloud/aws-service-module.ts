import { error, type Finding } from '../core/findings.ts';
import type { BlueprintInput } from '../kit/blueprint.ts';
import { placementRegionOptions } from '../kit/placement-regions.ts';
import { blk, x } from '../terraform/blueprints/migration/common.ts';
import { renderFile, type HclBlock } from '../terraform/hcl.ts';
import { asRootModule } from '../terraform/layout.ts';

export const awsServiceRegion: BlueprintInput = {
  id: 'aws_region', label: 'Region / site', control: 'select',
  options: placementRegionOptions('aws'), blankLabel: 'Select a region',
};

export function awsServiceModule(location: string, resources: readonly HclBlock[], guide: string, findings: Finding[]): ReturnType<typeof asRootModule> & { files: Record<string, string>; findings: Finding[] } {
  if (!awsServiceRegion.options!.some(option => option.value === location)) {
    findings.push(error('aws.service.region', 'Select a supported region.', { path: 'aws_region' }));
  }
  return { ...asRootModule({
    files: {
      'main.tf': renderFile([
        blk('terraform', {}, [blk('required_providers', { aws: x('{ source = "hashicorp/aws", version = "~> 5.0" }') })]),
        blk('provider', { region: location }, [], ['aws']),
        ...resources,
      ]),
      'SERVICE-SETUP.md': guide,
    },
    findings,
  }), findings };
}

export function awsServicePartition(region: string): string {
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  if (region.startsWith('cn-')) return 'aws-cn';
  if (region.startsWith('eusc-')) return 'aws-eusc';
  return 'aws';
}
