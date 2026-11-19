import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, OCI_REGIONS } from '../lib/kit/regions.js';

const awsSource = 'https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/using-govcloud.html';
const azureSource = 'https://learn.microsoft.com/en-us/azure/azure-government/documentation-government-welcome';
const googleSource = 'https://docs.cloud.google.com/assured-workloads/docs/locations';
const oracleSource = 'https://docs.oracle.com/en-us/iaas/Content/gov-cloud/govfedramp.htm';
const govRegions = ['us-langley-1', 'us-luke-1'];
const defenseRegions = ['us-gov-ashburn-1', 'us-gov-chicago-1', 'us-gov-phoenix-1'];
const ukRegions = ['uk-gov-london-1', 'uk-gov-cardiff-1'];
const isolatedAws = /^(us-iso|eu-isoe-)/;
const azureSpecial = /^(usgov|usdod|ussec|china)/;
const entry = (regions, kind, source) => ({ regions, kind, source });
export const cloudOfferings = {
  AWS: {
    'AWS commercial': entry(AWS_REGIONS.filter(region => !/^(us-gov-|cn-)/.test(region) && !isolatedAws.test(region)), 'commercial', 'https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html'),
    'AWS GovCloud (US)': entry(['us-gov-east-1', 'us-gov-west-1'], 'government', awsSource),
    'AWS China': entry(AWS_REGIONS.filter(region => region.startsWith('cn-')), 'sovereign', 'https://docs.amazonaws.cn/en_us/aws/latest/userguide/regions-and-endpoints.html'),
    'AWS restricted partition': entry(AWS_REGIONS.filter(region => isolatedAws.test(region)), 'restricted', awsSource),
  },
  Azure: {
    'Azure commercial': entry(AZURE_REGIONS.filter(region => !azureSpecial.test(region)), 'commercial', 'https://learn.microsoft.com/en-us/azure/reliability/regions-list'),
    'Azure Government': entry(['usgovarizona', 'usgovtexas', 'usgovvirginia'], 'government', azureSource),
    'Azure DoD': entry(['usdodcentral', 'usdodeast'], 'defense', 'https://learn.microsoft.com/en-us/azure/azure-government/documentation-government-overview-dod'),
    'Azure restricted cloud': entry(AZURE_REGIONS.filter(region => region.startsWith('ussec')), 'restricted', azureSource),
  },
  'Google Cloud': {
    'Google Cloud commercial': entry(GCP_REGIONS, 'commercial', 'https://cloud.google.com/about/locations'),
    'Assured Workloads — US Data Boundary': entry(GCP_REGIONS.filter(region => region.startsWith('us-')), 'assured', googleSource),
    'Assured Workloads — EU Data Boundary': entry(['europe-central2', 'europe-west1', 'europe-west3', 'europe-west4', 'europe-west8', 'europe-west9', 'europe-west10', 'europe-west12', 'europe-southwest1', 'europe-north1', 'europe-north2'], 'assured', googleSource),
    'Assured Workloads — UK Data Boundary': entry(['europe-west2'], 'assured', googleSource),
    'Assured Workloads — Canada Data Boundary': entry(['northamerica-northeast1', 'northamerica-northeast2'], 'assured', googleSource),
    'Assured Workloads — Australia Data Boundary': entry(['australia-southeast1', 'australia-southeast2'], 'assured', googleSource),
  },
  'Oracle Cloud': {
    'OCI commercial': entry(OCI_REGIONS.filter(region => ![...govRegions, ...defenseRegions, ...ukRegions].includes(region)), 'commercial', 'https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm'),
    'OCI government': entry(govRegions, 'government', oracleSource),
    'OCI US Defense': entry(defenseRegions, 'defense', 'https://docs.oracle.com/en-us/iaas/Content/gov-cloud/govdod.htm'),
    'OCI UK Government': entry(ukRegions, 'sovereign', 'https://docs.oracle.com/en-us/iaas/Content/gov-cloud/ukgov.htm'),
    'OCI EU Sovereign': entry(['eu-frankfurt-2', 'eu-madrid-2'], 'sovereign', 'https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm'),
    'OCI Dedicated Region': entry(['Customer dedicated primary site', 'Customer dedicated recovery site'], 'dedicated', 'https://www.oracle.com/cloud/cloud-at-customer/dedicated-region/'),
  },
};
export function offeringNames(platform) {
  if (!platform) return [];
  if (cloudOfferings[platform]) return Object.keys(cloudOfferings[platform]);
  return [platform + ' — organization-managed', platform + ' — managed hosting', platform + ' — isolated deployment'];
}
export function offeringOptions(platform, offering) {
  if (!offeringNames(platform).includes(offering)) return { regions: [], boundaries: [], destinations: [], authorities: [], source: '' };
  const cloud = cloudOfferings[platform]?.[offering];
  const kind = cloud?.kind ?? (offering.endsWith('isolated deployment') ? 'isolated' : offering.endsWith('managed hosting') ? 'managed' : 'private');
  const regions = cloud?.regions ?? (kind === 'managed' ? ['Provider primary site', 'Provider recovery site', 'Colocation site'] : kind === 'isolated' ? ['Primary enclave site', 'Secondary enclave site', 'Isolated recovery site'] : ['Primary data center', 'Secondary data center', 'Disaster recovery site', 'Edge / remote site']);
  const boundaries = {
    commercial: ['Dedicated cloud account / subscription / project', 'Shared organization cloud boundary', 'Hybrid cloud and on-premises boundary'],
    government: ['Government cloud account / subscription / tenancy', 'Government hybrid boundary'],
    defense: ['DoD cloud account / subscription / tenancy', 'DoD hybrid boundary'],
    sovereign: ['Sovereign cloud tenancy', 'Sovereign hybrid boundary'],
    restricted: ['Restricted cloud enclave', 'Approved restricted interconnection boundary'],
    assured: ['Assured Workloads folder boundary', 'Assured Workloads hybrid boundary'],
    dedicated: ['Customer dedicated-region boundary', 'Customer dedicated-region recovery boundary'],
    isolated: ['Disconnected / isolated enclave', 'Isolated recovery enclave'],
    managed: ['Managed hosting tenant', 'Provider dedicated hosting boundary'],
    private: ['Organization data-center boundary', 'Private cloud tenant', 'Hybrid data-center boundary'],
  }[kind];
  const destinations = cloud ? ['Selected offering region / site only', 'Multiple approved regions / sites within this offering'] : kind === 'isolated' ? ['Selected enclave site only', 'Approved isolated enclave sites only'] : kind === 'managed' ? ['Selected provider site only', 'Approved hosting-provider sites only'] : ['Selected site only', 'Organization-owned sites only', 'Multiple explicitly approved organization sites'];
  const authorities = ['Data owner / steward', 'Privacy / data protection authority', 'Export compliance authority', 'Contract-designated handling authority'];
  if (['government', 'defense', 'restricted', 'isolated'].includes(kind)) authorities.push('Agency authorizing official', 'Agency CUI program authority');
  else authorities.push('Organization security authority', 'Agency authorizing official', 'Agency CUI program authority');
  if (['restricted', 'isolated'].includes(kind)) authorities.push('Original / derivative classification authority');
  return { regions, boundaries, destinations, authorities, source: cloud?.source ?? '' };
}
