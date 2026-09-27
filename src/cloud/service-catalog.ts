/**
 * The cloud service catalog: every service AWS, Azure, Google Cloud and OCI
 * list, under its official name and category, with the Terraform resources
 * (and CloudFormation or ARM types) that build it.
 *
 * The data is generated per cloud by tools/fetch-service-catalog.mjs from the
 * providers' own lists and the Terraform registry, one file per cloud
 * (./service-catalog-<cloud>.ts), and is read here as one catalog. Nothing in
 * it is hand-written: a service the sources could not place is listed in
 * `unmatched` with the reason, not guessed at.
 *
 * Each resource's arguments are not repeated here; they are in the provider
 * schemas (src/terraform/cloud-schema-index.ts and web/data/terraform/).
 */

import { SERVICE_CATALOG_AWS } from './service-catalog-aws.ts';
import { SERVICE_CATALOG_AZURE } from './service-catalog-azure.ts';
import { SERVICE_CATALOG_GOOGLE } from './service-catalog-google.ts';
import { SERVICE_CATALOG_OCI } from './service-catalog-oci.ts';

export type ServiceCloud = 'aws' | 'azure' | 'google' | 'oci';

export type ServiceCategoryId =
  | 'compute'
  | 'containers'
  | 'serverless'
  | 'storage'
  | 'database'
  | 'networking'
  | 'security-identity'
  | 'management-governance'
  | 'monitoring'
  | 'analytics'
  | 'ai-ml'
  | 'integration-messaging'
  | 'migration'
  | 'developer-tools'
  | 'end-user-computing'
  | 'iot'
  | 'other';

export interface ServiceCategory {
  readonly id: ServiceCategoryId;
  readonly label: string;
}

/**
 * How a service can be built from the toolkit: with Terraform, only with the
 * provider's own templates (CloudFormation or ARM), or not at all.
 */
export type Buildable = 'terraform' | 'native' | 'none';

export interface CloudService {
  /** Stable within its cloud: a slug of the official name. */
  readonly id: string;
  /** The official name, as the provider's own list gives it. */
  readonly name: string;
  readonly category: ServiceCategoryId;
  /** The provider's own grouping for it, where its list gives one. */
  readonly providerCategory: string | null;
  readonly description?: string;
  /** Terraform resource types, with the provider prefix (aws_db_instance). */
  readonly terraform: readonly string[];
  /** AWS only: CloudFormation types (AWS::RDS::DBInstance). */
  readonly cloudformation?: readonly string[];
  /** Azure only: top-level ARM types (Microsoft.Sql/servers). */
  readonly arm?: readonly string[];
  /**
   * Azure only: the resource provider namespace(s) Microsoft Learn lists the
   * service under. A namespace shared by several services (Microsoft.Network)
   * is named here, but its types are not split between them in `arm`.
   */
  readonly armNamespaces?: readonly string[];
  readonly buildable: Buildable;
  /** Why it cannot be built, where the source says (e.g. preview). */
  readonly reason?: string;
  /** The lists it was found in (see the cloud's `sources`). */
  readonly source: readonly string[];
  /**
   * True when the service is in the provider's own service or price list;
   * false when it comes only from an API directory (botocore, Google APIs
   * Discovery) or is a Terraform registry subcategory no list names.
   */
  readonly verified: boolean;
  readonly note?: string;
  /** Other names the sources give it. */
  readonly aka?: readonly string[];
  /** The service it is part of, where the list nests it. */
  readonly parent?: string;
  readonly preview?: boolean;
  readonly government?: boolean;
}

export interface CatalogSource {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly status: 'ok' | 'failed' | 'unavailable';
  readonly note?: string;
}

/** Something the generator could not place, and why. */
export interface UnmatchedEntry {
  readonly kind: 'terraform-subcategory' | 'terraform-resource' | 'cloudformation-namespace' | 'arm-namespace';
  readonly name: string;
  readonly reason: string;
  /** How many resources or types it covers. */
  readonly count: number;
  readonly items?: readonly string[];
}

export interface CatalogSummary {
  readonly services: number;
  /** Distinct names in the provider's own service or price lists. */
  readonly officialListed: number;
  readonly withTerraform: number;
  readonly withoutTerraform: number;
  readonly terraformResourcesMapped: number;
  readonly terraformResourcesUnmapped: number;
  readonly registryOnlyServices: number;
  readonly unmatchedSubcategories: number;
  readonly cloudformationMapped?: number;
  readonly armMapped?: number;
  readonly registryDocsNotInCatalog: number;
}

export interface CloudCatalogData {
  readonly cloud: ServiceCloud;
  /** ISO date the data was fetched. */
  readonly fetched: string;
  readonly terraform: { readonly source: string; readonly version: string };
  readonly sources: readonly CatalogSource[];
  readonly summary: CatalogSummary;
  /** Provider categories with no entry in the common set (so 'other'). */
  readonly unmappedCategories: readonly string[];
  readonly unmatched: readonly UnmatchedEntry[];
  readonly services: readonly CloudService[];
}

const DATA: Readonly<Record<ServiceCloud, CloudCatalogData>> = {
  aws: SERVICE_CATALOG_AWS,
  azure: SERVICE_CATALOG_AZURE,
  google: SERVICE_CATALOG_GOOGLE,
  oci: SERVICE_CATALOG_OCI,
};

const CATEGORIES: readonly ServiceCategory[] = [
  { id: 'compute', label: 'Compute' },
  { id: 'containers', label: 'Containers' },
  { id: 'serverless', label: 'Serverless' },
  { id: 'storage', label: 'Storage' },
  { id: 'database', label: 'Database' },
  { id: 'networking', label: 'Networking' },
  { id: 'security-identity', label: 'Security & identity' },
  { id: 'management-governance', label: 'Management & governance' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'ai-ml', label: 'AI / ML' },
  { id: 'integration-messaging', label: 'Integration & messaging' },
  { id: 'migration', label: 'Migration' },
  { id: 'developer-tools', label: 'Developer tools' },
  { id: 'end-user-computing', label: 'End-user computing' },
  { id: 'iot', label: 'IoT' },
  { id: 'other', label: 'Other' },
];

export const SERVICE_CLOUDS: readonly ServiceCloud[] = ['aws', 'azure', 'google', 'oci'];

/** The common categories, in display order. */
export function categories(): readonly ServiceCategory[] {
  return CATEGORIES;
}

/** The whole generated record for one cloud: sources, summary, unmatched. */
export function catalogFor(cloud: ServiceCloud): CloudCatalogData {
  return DATA[cloud];
}

/** Every service of a cloud, by id. */
export function services(cloud: ServiceCloud): readonly CloudService[] {
  return DATA[cloud].services;
}

const byId = new Map<ServiceCloud, Map<string, CloudService>>();
function idIndex(cloud: ServiceCloud): Map<string, CloudService> {
  let map = byId.get(cloud);
  if (!map) {
    map = new Map(DATA[cloud].services.map((s) => [s.id, s]));
    byId.set(cloud, map);
  }
  return map;
}

export function serviceById(cloud: ServiceCloud, id: string): CloudService | undefined {
  return idIndex(cloud).get(id);
}

/** The services of a cloud grouped by common category, in category order; empty categories are left out. */
export function servicesByCategory(cloud: ServiceCloud): ReadonlyMap<ServiceCategoryId, readonly CloudService[]> {
  const out = new Map<ServiceCategoryId, CloudService[]>();
  for (const c of CATEGORIES) out.set(c.id, []);
  for (const s of DATA[cloud].services) out.get(s.category)?.push(s);
  for (const [k, v] of out) {
    if (v.length === 0) out.delete(k);
    else v.sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

export interface ServiceResources {
  readonly terraform: readonly string[];
  readonly cloudformation: readonly string[];
  readonly arm: readonly string[];
}

/** What builds a service: its Terraform resource types, and CloudFormation or ARM types. */
export function resourcesFor(cloud: ServiceCloud, serviceId: string): ServiceResources {
  const s = serviceById(cloud, serviceId);
  return {
    terraform: s?.terraform ?? [],
    cloudformation: s?.cloudformation ?? [],
    arm: s?.arm ?? [],
  };
}

export interface ResourceOwner {
  readonly cloud: ServiceCloud;
  readonly service: CloudService;
}

let owners: Map<string, ResourceOwner> | undefined;

/**
 * The service a Terraform resource type (aws_db_instance), CloudFormation type
 * (AWS::RDS::DBInstance) or ARM type (Microsoft.Sql/servers) belongs to.
 * ARM types are compared without case, as Azure does.
 */
export function serviceForResource(type: string): ResourceOwner | undefined {
  if (!owners) {
    owners = new Map();
    for (const cloud of SERVICE_CLOUDS) {
      for (const service of DATA[cloud].services) {
        for (const t of service.terraform) owners.set(t, { cloud, service });
        for (const t of service.cloudformation ?? []) owners.set(t, { cloud, service });
        for (const t of service.arm ?? []) owners.set(t.toLowerCase(), { cloud, service });
      }
    }
  }
  return owners.get(type) ?? owners.get(type.toLowerCase());
}
