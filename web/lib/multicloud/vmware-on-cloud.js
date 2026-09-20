/**
 * The four VMware-on-hyperscaler services.
 *
 * This is the row of the matrix that decides most real migrations, because it is
 * the only one where a vSphere estate moves without being rewritten. It is also
 * the row that goes stale fastest: all four services changed hands, versions or
 * licensing model between 2024 and 2026, and a toolkit repeating the 2023 shape
 * of this market would send people to offerings that no longer work that way.
 *
 * So each entry says which VCF version it runs and how it is licensed, and
 * carries its own provenance. Where something was not confirmed against the
 * vendor's own material it is tagged and said so, rather than filled in from
 * what the others do.
 *
 * The single largest change: VCF subscriptions became portable. Licences bought
 * from Broadcom can be carried onto a hyperscaler's VMware service rather than
 * repurchased through it, which turns "which cloud already has our licences"
 * from a constraint into a question of infrastructure price.
 */

import { sourced,              } from '../vcf/provenance.js';
                                               

                            
                                                                                      
                  
                                                                                      
                       

                                     
                                                 
                        
                                
                                                   
                                       
                                                   
                                                         
                                      
                                    
                                      
                                          
                                     
 

export const VMWARE_CLOUD_SERVICES                                = [
  {
    platform: 'aws',
    name: 'Amazon Elastic VMware Service',
    abbreviation: 'Amazon EVS',
    operatingModel: sourced(
      'self-managed',
      'V-DOC',
      'AWS: VCF runs directly within your own Amazon VPC and you control the VCF environment as you would on premises.',
    ),
    vcfVersions: sourced(
      ['9.1', '9.0', '5.2.1'],
      'V-DOC',
      'AWS, VMware Explore 2026: EVS supports VCF 9.0 and 9.1; it went GA in August 2025 on VCF 5.2.1.',
    ),
    placement: sourced(
      'Inside your own Amazon VPC, not a provider-owned account.',
      'V-DOC',
      'AWS GA announcement, August 2025.',
    ),
    licensing: sourced(
      'Bring your own VCF subscription. The service is self-managed VCF, so the licence is yours.',
      'I',
      undefined,
      'Follows from the service being self-managed VCF; the commercial terms were not read directly.',
    ),
    hostHardware: sourced(
      'EC2 bare metal. i4i.metal at GA; EC2 bare metal generally as of the 2026 expansion.',
      'V-DOC',
      'AWS GA announcement (i4i.metal) and the VMware Explore 2026 expansion (EC2 bare metal).',
    ),
    regions: sourced(
      '22 AWS Regions as of September 2026, from six at GA.',
      'V-DOC',
      'AWS, VMware Explore 2026.',
    ),
  },
  {
    platform: 'azure',
    name: 'Azure VMware Solution',
    abbreviation: 'AVS',
    operatingModel: sourced(
      'provider-managed',
      'V-DOC',
      'Microsoft: a fully managed Azure VMware Solution environment.',
    ),
    vcfVersions: sourced(
      ['VCF private clouds'],
      'C',
      'Microsoft Azure blog: VCF private clouds on AVS.',
      'Microsoft states VCF private clouds without naming a version in the material read.',
    ),
    placement: sourced(
      'An Azure private cloud, peered into your virtual network.',
      'V-DOC',
      'Microsoft Azure product documentation.',
    ),
    licensing: sourced(
      'Either bundled with the Azure purchase, or a portable VCF subscription bought from Broadcom and carried in — in which case only Microsoft is paid, for the service and infrastructure.',
      'V-DOC',
      'Microsoft Azure blog: run VCF private clouds in AVS with support for portable VCF subscriptions.',
    ),
  },
  {
    platform: 'google',
    name: 'Google Cloud VMware Engine',
    abbreviation: 'GCVE',
    operatingModel: sourced(
      'provider-managed',
      'C',
      'Google Cloud VMware Engine product documentation.',
    ),
    vcfVersions: sourced(
      [],
      'I',
      undefined,
      'Not confirmed against Google Cloud documentation in this session. Check the VMware Engine release notes before relying on a version.',
    ),
    placement: sourced(
      'A VMware Engine private cloud, reached over a VPC peering.',
      'C',
      'Google Cloud VMware Engine product documentation.',
    ),
    licensing: sourced(
      'Bundled with the Google Cloud purchase; portable subscription support was not confirmed here.',
      'I',
      undefined,
      'Verify before assuming existing VCF subscriptions can be carried in.',
    ),
  },
  {
    platform: 'oci',
    name: 'Oracle Cloud VMware Solution',
    abbreviation: 'OCVS',
    operatingModel: sourced(
      'self-managed',
      'C',
      'Oracle: the customer holds full administrative control of the VMware stack.',
    ),
    vcfVersions: sourced(
      [],
      'I',
      undefined,
      'Not confirmed in this session.',
    ),
    placement: sourced(
      'Bare-metal hosts inside your own OCI tenancy and VCN.',
      'C',
      'Oracle Cloud VMware Solution product documentation.',
    ),
    licensing: sourced(
      'Bring your own VCF subscription, following the same model as the other providers.',
      'C',
      'Reported industry coverage of Oracle adopting the BYOL model for VMware.',
      'Reported rather than read from Oracle; confirm with Oracle before pricing on it.',
    ),
  },
];

export function vmwareCloudService(platform          )                                 {
  return VMWARE_CLOUD_SERVICES.find((s) => s.platform === platform);
}

/**
 * Whether a VCF version is one the service is known to run.
 *
 * An empty list means unknown, not unsupported, and the two must not be
 * conflated: reporting GCVE as unable to run 9.1 because nobody checked would
 * be a confident wrong answer, which is worse than an honest gap.
 */
                                                                    

export function supportsVcfVersion(service                    , version        )                 {
  const known = service.vcfVersions.value;
  if (known.length === 0) return 'unknown';
  // The spec builder carries a four-part version (9.1.1.0) while the services
  // are described by their line (9.1), so compare on the first two parts.
  const line = version.split('.').slice(0, 2).join('.');
  return known.some((v) => v === version || v.split('.').slice(0, 2).join('.') === line)
    ? 'supported'
    : 'not-listed';
}
