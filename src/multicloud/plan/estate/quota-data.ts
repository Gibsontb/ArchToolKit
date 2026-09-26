/**
 * Default service quotas (addendum A.5.4), as sourced data.
 *
 * Every default here is "(verify)": defaults differ by account or subscription
 * age and offer, and are raised on request. So each carries verification `I`
 * (not read from the vendor's page in this build) unless the research read it
 * from the provider's own documentation, and a default the research could not
 * find is left out (`default` undefined): the check then asks for the real
 * figure from `capacity/fetch-quotas.sh` instead of guessing.
 *
 * `metric` names the capacity total the quota limits (capacity.ts), and
 * `fetch` how the generated script reads the real value.
 */

import type { Platform, Verification } from '../types.ts';

/** What a quota limits, in capacity.ts's totals. */
export type QuotaMetric =
  | 'vcpu' | 'vcpu-family' | 'storage-ssd-tib' | 'public-ips' | 'networks' | 'nat-per-zone'
  | 'replicating-servers' | 'concurrent-replications' | 'block-storage-tib';

export type QuotaScope = 'region' | 'account' | 'zone';

export type QuotaFetch =
  | { readonly cli: 'aws'; readonly serviceCode: string; readonly quotaCode: string }
  | { readonly cli: 'azure'; readonly command: 'vm' | 'network'; readonly usageName: string }
  | { readonly cli: 'gcloud'; readonly metric: string }
  | { readonly cli: 'oci'; readonly service: string; readonly limitName: string };

export interface QuotaDefault {
  readonly id: string;
  readonly platform: Platform;
  /** The provider's own name for the quota. */
  readonly quota: string;
  readonly metric: QuotaMetric;
  readonly scope: QuotaScope;
  /** undefined: no default the research could source; fetch the real one. */
  readonly default?: number;
  readonly unit: string;
  /** How long a raise usually takes to plan for, days (a planning assumption). */
  readonly leadDays: number;
  /** Per-wave tool quota (checked per wave, not for the estate). */
  readonly perWave?: boolean;
  readonly fetch?: QuotaFetch;
  readonly note?: string;
  readonly source: string;
  readonly verification: Verification;
}

const AWS_Q = 'https://docs.aws.amazon.com/general/latest/gr/ec2-service.html#limits_ec2';
const AZ_Q = 'https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits';
const GCP_Q = 'https://cloud.google.com/compute/resource-usage';
const OCI_Q = 'https://docs.oracle.com/en-us/iaas/Content/General/Concepts/servicelimits.htm';
const VARIES = 'Defaults differ by account age and offer, and are raised on request: fetch the real value.';

export const QUOTA_DEFAULTS: readonly QuotaDefault[] = Object.freeze([
  // AWS
  { id: 'aws.ec2.standard-vcpu', platform: 'aws', quota: 'Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances', metric: 'vcpu', scope: 'region', default: 5, unit: 'vCPU', leadDays: 3, fetch: { cli: 'aws', serviceCode: 'ec2', quotaCode: 'L-1216C47A' }, note: VARIES, source: AWS_Q, verification: 'I' },
  { id: 'aws.ebs.gp3-tib', platform: 'aws', quota: 'Storage for General Purpose SSD (gp3) volumes, in TiB', metric: 'storage-ssd-tib', scope: 'region', default: 50, unit: 'TiB', leadDays: 3, fetch: { cli: 'aws', serviceCode: 'ebs', quotaCode: 'L-7A658B76' }, note: VARIES, source: 'https://docs.aws.amazon.com/general/latest/gr/ebs-service.html', verification: 'I' },
  { id: 'aws.ec2.eips', platform: 'aws', quota: 'EC2-VPC Elastic IPs', metric: 'public-ips', scope: 'region', default: 5, unit: 'addresses', leadDays: 2, fetch: { cli: 'aws', serviceCode: 'ec2', quotaCode: 'L-0263D0A3' }, source: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html', verification: 'I' },
  { id: 'aws.vpc.per-region', platform: 'aws', quota: 'VPCs per Region', metric: 'networks', scope: 'region', default: 5, unit: 'VPCs', leadDays: 2, fetch: { cli: 'aws', serviceCode: 'vpc', quotaCode: 'L-F678F1CE' }, source: 'https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html', verification: 'I' },
  { id: 'aws.vpc.nat-per-az', platform: 'aws', quota: 'NAT gateways per Availability Zone', metric: 'nat-per-zone', scope: 'zone', default: 5, unit: 'gateways', leadDays: 2, fetch: { cli: 'aws', serviceCode: 'vpc', quotaCode: 'L-FE5A380F' }, source: 'https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html', verification: 'I' },
  { id: 'aws.mgn.replicating', platform: 'aws', quota: 'AWS Transform MGN actively replicating source servers', metric: 'replicating-servers', scope: 'region', default: 150, unit: 'servers', leadDays: 5, perWave: true, note: 'Per wave: the servers replicating at once.', source: 'https://docs.aws.amazon.com/mgn/latest/ug/General-Questions-FAQ.html', verification: 'V-DOC' },
  // Azure
  { id: 'azure.vcpu.regional', platform: 'azure', quota: 'Total Regional vCPUs', metric: 'vcpu', scope: 'region', default: 20, unit: 'vCPU', leadDays: 3, fetch: { cli: 'azure', command: 'vm', usageName: 'cores' }, note: VARIES, source: AZ_Q, verification: 'I' },
  { id: 'azure.vcpu.family', platform: 'azure', quota: 'vCPUs per VM family', metric: 'vcpu-family', scope: 'region', default: 10, unit: 'vCPU', leadDays: 3, note: `${VARIES} Checked against the largest family's need.`, source: AZ_Q, verification: 'I' },
  { id: 'azure.network.public-ips', platform: 'azure', quota: 'Public IP addresses - Standard', metric: 'public-ips', scope: 'region', default: 1000, unit: 'addresses', leadDays: 2, fetch: { cli: 'azure', command: 'network', usageName: 'StandardSkuPublicIpAddresses' }, source: 'https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits#networking-limits', verification: 'I' },
  { id: 'azure.migrate.agentless', platform: 'azure', quota: 'Azure Migrate concurrent agentless replications', metric: 'concurrent-replications', scope: 'region', default: 500, unit: 'VMs', leadDays: 0, perWave: true, note: 'Per wave: VMs replicating at once through the appliance(s).', source: 'https://learn.microsoft.com/en-us/azure/migrate/scale-vmware-assessment', verification: 'I' },
  // Google Cloud (GCP)
  { id: 'google.compute.cpus', platform: 'google', quota: 'CPUS (per region)', metric: 'vcpu', scope: 'region', default: 24, unit: 'vCPU', leadDays: 2, fetch: { cli: 'gcloud', metric: 'CPUS' }, note: VARIES, source: GCP_Q, verification: 'I' },
  { id: 'google.compute.ssd', platform: 'google', quota: 'SSD_TOTAL_GB (persistent disk SSD)', metric: 'storage-ssd-tib', scope: 'region', unit: 'TiB', leadDays: 2, fetch: { cli: 'gcloud', metric: 'SSD_TOTAL_GB' }, note: VARIES, source: GCP_Q, verification: 'I' },
  { id: 'google.compute.in-use-ips', platform: 'google', quota: 'IN_USE_ADDRESSES', metric: 'public-ips', scope: 'region', default: 8, unit: 'addresses', leadDays: 2, fetch: { cli: 'gcloud', metric: 'IN_USE_ADDRESSES' }, note: VARIES, source: GCP_Q, verification: 'I' },
  { id: 'google.m2vm.concurrent', platform: 'google', quota: 'Migrate to Virtual Machines concurrent migrations per host project and region', metric: 'concurrent-replications', scope: 'region', default: 200, unit: 'VMs', leadDays: 0, perWave: true, source: 'https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/migrate/migrating-vms', verification: 'V-DOC' },
  // OCI
  { id: 'oci.compute.standard-e5-cores', platform: 'oci', quota: 'standard-e5-core-count (Standard.E5 cores)', metric: 'vcpu', scope: 'zone', unit: 'OCPUs', leadDays: 3, fetch: { cli: 'oci', service: 'compute', limitName: 'standard-e5-core-count' }, note: `${VARIES} OCPUs: one OCPU is two vCPUs on x86.`, source: OCI_Q, verification: 'I' },
  { id: 'oci.block.volume-tb', platform: 'oci', quota: 'total-storage-tb (block volume)', metric: 'block-storage-tib', scope: 'zone', unit: 'TB', leadDays: 3, fetch: { cli: 'oci', service: 'block-storage', limitName: 'total-storage-tb' }, note: VARIES, source: OCI_Q, verification: 'I' },
] as QuotaDefault[]);

/** The quotas of a platform. */
export const quotasFor = (platform: Platform): QuotaDefault[] => QUOTA_DEFAULTS.filter((q) => q.platform === platform);
