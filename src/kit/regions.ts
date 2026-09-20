/**
 * Regions and zones, in one place.
 *
 * Read from each vendor's own documentation rather than from memory, because a
 * region list written from memory is wrong within a quarter and the failure is
 * a plan-time error naming the argument rather than the value.
 *
 * Verified 2026-09-20 against:
 *   AWS    docs.aws.amazon.com/global-infrastructure/latest/regions
 *   Azure  learn.microsoft.com/azure/reliability/regions-list
 *   Google docs.cloud.google.com/compute/docs/regions-zones
 *   OCI    docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm
 *
 * Restricted regions are included on purpose. For the work this toolkit is built
 * for, GovCloud, DoD, Secret and the ISO partitions are the point rather than an
 * afterthought, and they are the ones nobody can recall the spelling of.
 */

/** AWS: commercial, then GovCloud, China, and the ISO partitions. */
export const AWS_REGIONS: readonly string[] = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ca-central-1', 'ca-west-1', 'mx-central-1', 'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2',
  'eu-north-1', 'eu-south-1', 'eu-south-2',
  'af-south-1', 'il-central-1', 'me-south-1', 'me-central-1',
  'ap-east-1', 'ap-east-2', 'ap-south-1', 'ap-south-2',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
  'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7',
  // GovCloud
  'us-gov-east-1', 'us-gov-west-1',
  // China (a separate partition, with its own accounts)
  'cn-north-1', 'cn-northwest-1',
  // ISO partitions, air-gapped
  'us-iso-east-1', 'us-iso-west-1', 'us-isob-east-1', 'us-isof-south-1', 'us-isof-east-1',
  'eu-isoe-west-1',
];

/** Azure: public, then Government, DoD and Secret. */
export const AZURE_REGIONS: readonly string[] = [
  'eastus', 'eastus2', 'centralus', 'northcentralus', 'southcentralus', 'westcentralus',
  'westus', 'westus2', 'westus3',
  'canadacentral', 'canadaeast', 'mexicocentral', 'brazilsouth', 'brazilsoutheast', 'chilecentral',
  'northeurope', 'westeurope', 'uksouth', 'ukwest',
  'francecentral', 'francesouth', 'germanynorth', 'germanywestcentral',
  'italynorth', 'norwayeast', 'norwaywest', 'polandcentral', 'spaincentral',
  'swedencentral', 'switzerlandnorth', 'switzerlandwest',
  'austriaeast', 'belgiumcentral', 'denmarkeast',
  'israelcentral', 'qatarcentral', 'uaecentral', 'uaenorth',
  'southafricanorth', 'southafricawest',
  'australiacentral', 'australiacentral2', 'australiaeast', 'australiasoutheast',
  'newzealandnorth',
  'centralindia', 'southindia', 'westindia', 'indiasouthcentral',
  'eastasia', 'southeastasia', 'indonesiacentral', 'malaysiawest',
  'japaneast', 'japanwest', 'koreacentral', 'koreasouth',
  // Azure Government
  'usgovvirginia', 'usgovtexas', 'usgovarizona', 'usgoviowa',
  // Department of Defense
  'usdodcentral', 'usdodeast',
  // Secret and Top Secret
  'usseceast', 'ussecwest', 'ussecwestcentral',
];

/** Google Cloud: every Compute Engine region. */
export const GCP_REGIONS: readonly string[] = [
  'us-central1', 'us-east1', 'us-east4', 'us-east5', 'us-south1',
  'us-west1', 'us-west2', 'us-west3', 'us-west4',
  'northamerica-northeast1', 'northamerica-northeast2', 'northamerica-south1',
  'southamerica-east1', 'southamerica-west1',
  'europe-central2', 'europe-north1', 'europe-north2', 'europe-southwest1',
  'europe-west1', 'europe-west2', 'europe-west3', 'europe-west4',
  'europe-west6', 'europe-west8', 'europe-west9',
  'africa-south1', 'me-central1', 'me-central2', 'me-west1',
  'asia-east1', 'asia-east2',
  'asia-northeast1', 'asia-northeast2', 'asia-northeast3',
  'asia-south1', 'asia-south2',
  'asia-southeast1', 'asia-southeast2', 'asia-southeast3',
  'australia-southeast1', 'australia-southeast2',
];

/** Google Cloud: every Compute Engine zone. */
export const GCP_ZONES: readonly string[] = [
  'us-central1-a', 'us-central1-b', 'us-central1-c', 'us-central1-f',
  'us-east1-b', 'us-east1-c', 'us-east1-d',
  'us-east4-a', 'us-east4-b', 'us-east4-c',
  'us-east5-a', 'us-east5-b', 'us-east5-c',
  'us-south1-a', 'us-south1-b', 'us-south1-c',
  'us-west1-a', 'us-west1-b', 'us-west1-c',
  'us-west2-a', 'us-west2-b', 'us-west2-c',
  'us-west3-a', 'us-west3-b', 'us-west3-c',
  'us-west4-a', 'us-west4-b', 'us-west4-c',
  'northamerica-northeast1-a', 'northamerica-northeast1-b', 'northamerica-northeast1-c',
  'northamerica-northeast2-a', 'northamerica-northeast2-b', 'northamerica-northeast2-c',
  'northamerica-south1-a', 'northamerica-south1-b', 'northamerica-south1-c',
  'southamerica-east1-a', 'southamerica-east1-b', 'southamerica-east1-c',
  'southamerica-west1-a', 'southamerica-west1-b', 'southamerica-west1-c',
  'europe-central2-a', 'europe-central2-b', 'europe-central2-c',
  'europe-north1-a', 'europe-north1-b', 'europe-north1-c',
  'europe-north2-a', 'europe-north2-b', 'europe-north2-c',
  'europe-southwest1-a', 'europe-southwest1-b', 'europe-southwest1-c',
  'europe-west1-b', 'europe-west1-c', 'europe-west1-d',
  'europe-west2-a', 'europe-west2-b', 'europe-west2-c',
  'europe-west3-a', 'europe-west3-b', 'europe-west3-c',
  'europe-west4-a', 'europe-west4-b', 'europe-west4-c',
  'europe-west6-a', 'europe-west6-b', 'europe-west6-c',
  'europe-west8-a', 'europe-west8-b', 'europe-west8-c',
  'europe-west9-a', 'europe-west9-b', 'europe-west9-c',
  'africa-south1-a', 'africa-south1-b', 'africa-south1-c',
  'me-central1-a', 'me-central1-b', 'me-central1-c',
  'me-central2-a', 'me-central2-b', 'me-central2-c',
  'me-west1-a', 'me-west1-b', 'me-west1-c',
  'asia-east1-a', 'asia-east1-b', 'asia-east1-c',
  'asia-east2-a', 'asia-east2-b', 'asia-east2-c',
  'asia-northeast1-a', 'asia-northeast1-b', 'asia-northeast1-c',
  'asia-northeast2-a', 'asia-northeast2-b', 'asia-northeast2-c',
  'asia-northeast3-a', 'asia-northeast3-b', 'asia-northeast3-c',
  'asia-south1-a', 'asia-south1-b', 'asia-south1-c',
  'asia-south2-a', 'asia-south2-b', 'asia-south2-c',
  'asia-southeast1-a', 'asia-southeast1-b', 'asia-southeast1-c',
  'asia-southeast2-a', 'asia-southeast2-b', 'asia-southeast2-c',
  'asia-southeast3-a', 'asia-southeast3-b', 'asia-southeast3-c',
  'australia-southeast1-a', 'australia-southeast1-b', 'australia-southeast1-c',
  'australia-southeast2-a', 'australia-southeast2-b', 'australia-southeast2-c',
];

/** OCI: commercial, then the government and sovereign realms. */
export const OCI_REGIONS: readonly string[] = [
  'us-ashburn-1', 'us-chicago-1', 'us-phoenix-1', 'us-sanjose-1',
  'ca-montreal-1', 'ca-toronto-1',
  'mx-queretaro-1', 'mx-monterrey-1',
  'sa-saopaulo-1', 'sa-vinhedo-1', 'sa-santiago-1', 'sa-valparaiso-1', 'sa-bogota-1',
  'uk-london-1', 'uk-cardiff-1',
  'eu-frankfurt-1', 'eu-amsterdam-1', 'eu-zurich-1', 'eu-madrid-1', 'eu-madrid-3',
  'eu-milan-1', 'eu-turin-1', 'eu-marseille-1', 'eu-paris-1', 'eu-stockholm-1',
  'eu-jovanovac-1',
  'af-johannesburg-1', 'af-casablanca-1',
  'il-jerusalem-1', 'me-abudhabi-1', 'me-dubai-1', 'me-jeddah-1', 'me-riyadh-1',
  'ap-mumbai-1', 'ap-hyderabad-1', 'ap-singapore-1', 'ap-singapore-2', 'ap-batam-1',
  'ap-kulai-2', 'ap-tokyo-1', 'ap-osaka-1', 'ap-seoul-1', 'ap-chuncheon-1',
  'ap-sydney-1', 'ap-melbourne-1',
  // US Government and Defense realms, which have their own tenancies
  'us-langley-1', 'us-luke-1', 'us-gov-ashburn-1', 'us-gov-chicago-1', 'us-gov-phoenix-1',
  // UK sovereign
  'uk-gov-london-1', 'uk-gov-cardiff-1',
];

export function asOptions(values: readonly string[]): readonly { value: string; label: string }[] {
  return values.map((value) => ({ value, label: value }));
}

export const BOOL_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];
