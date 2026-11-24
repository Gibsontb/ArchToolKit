import { error,              } from '../core/findings.js';
                                                          
import { placementRegionOptions } from '../kit/placement-regions.js';
import { blk, x } from '../terraform/blueprints/migration/common.js';
import { renderFile,               } from '../terraform/hcl.js';
import { asRootModule } from '../terraform/layout.js';

export const awsServiceRegion                 = {
  id: 'aws_region', label: 'Region / site', control: 'select',
  options: placementRegionOptions('aws'), blankLabel: 'Select a region',
};

export function awsServiceModule(location        , resources                     , guide        , findings           )                                                                                           {
  if (!awsServiceRegion.options .some(option => option.value === location)) {
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

export function awsServicePartition(region        )         {
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  if (region.startsWith('cn-')) return 'aws-cn';
  if (region.startsWith('eusc-')) return 'aws-eusc';
  return 'aws';
}
