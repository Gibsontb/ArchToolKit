/**
 * Region and zone lists, in one place.
 *
 * The Terraform and Ansible generators came from two files that each kept their
 * own list, and the two had drifted: one knew about `ap-northeast-1`, the other
 * about the ISO regions. Two generators disagreeing about which regions exist is
 * the kind of thing nobody notices until a configuration is written for a region
 * the other tool would not offer, so the lists are merged here and both kits
 * read them.
 *
 * Commercial, Gov, DoD and ISO regions are all included. For the work this
 * toolkit is built for, the restricted regions are the point rather than an
 * afterthought, and a region typed by hand into a text box is a plan-time error
 * with a message about the argument and not the value.
 */

/** AWS: commercial, then GovCloud, then the ISO partitions. */
export const AWS_REGIONS: readonly string[] = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'ap-northeast-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'us-gov-east-1',
  'us-gov-west-1',
  'us-iso-east-1',
  'us-iso-west-1',
  'us-isob-east-1',
];

/** Azure: commercial, then Government, then DoD, then Secret. */
export const AZURE_REGIONS: readonly string[] = [
  'eastus',
  'eastus2',
  'centralus',
  'westus',
  'westus2',
  'southcentralus',
  'northeurope',
  'westeurope',
  'uksouth',
  'usgovvirginia',
  'usgovtexas',
  'usgovarizona',
  'usdodcentral',
  'usdodeast',
  'usseceast',
  'ussecwest',
  'ussecwestcentral',
];

export const GCP_REGIONS: readonly string[] = [
  'us-central1',
  'us-east1',
  'us-east4',
  'us-west1',
  'us-west2',
  'europe-west1',
  'europe-west2',
  'europe-west3',
  'asia-east1',
  'asia-southeast1',
];

export const GCP_ZONES: readonly string[] = [
  'us-central1-a',
  'us-central1-b',
  'us-central1-c',
  'us-east1-b',
  'us-east1-c',
  'us-east4-a',
  'us-east4-b',
  'us-west1-a',
  'us-west1-b',
  'us-west2-a',
  'europe-west1-b',
  'europe-west1-c',
  'europe-west2-a',
  'europe-west3-a',
  'asia-east1-a',
  'asia-southeast1-a',
];

export const OCI_REGIONS: readonly string[] = [
  'us-ashburn-1',
  'us-phoenix-1',
  'us-sanjose-1',
  'us-chicago-1',
  'ca-toronto-1',
  'ca-montreal-1',
  'uk-london-1',
  'eu-frankfurt-1',
  'eu-amsterdam-1',
  'eu-zurich-1',
  'ap-tokyo-1',
  'ap-osaka-1',
  'ap-sydney-1',
  'ap-melbourne-1',
  'ap-mumbai-1',
  'sa-saopaulo-1',
  'us-langley-1',
  'us-luke-1',
];

/** A list as a set of dropdown options. */
export function asOptions(values: readonly string[]): readonly { value: string; label: string }[] {
  return values.map((value) => ({ value, label: value }));
}

export const BOOL_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];
