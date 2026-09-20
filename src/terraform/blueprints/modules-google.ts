/**
 * GCP blueprints that call registry modules.
 *
 * `terraform-google-modules/*` is the Cloud Foundation Toolkit — Google's own
 * reference modules, which is what a project factory, a shared VPC or a GKE
 * cluster gets built from in practice rather than resource by resource.
 *
 * Two of these are submodules. `sql-db` has no inputs at its root: the root is
 * a wrapper and the usable modules are `//modules/postgresql` and
 * `//modules/mysql`, which is the sort of thing you find out by reading the
 * repository rather than the registry page, and is why the catalog reads the
 * directory Terraform would read.
 */

import type { BlueprintGroup } from '../../kit/blueprint.ts';
import { moduleBlueprint, type ModuleBlueprintSpec } from '../module-blueprint.ts';

const SPECS: readonly ModuleBlueprintSpec[] = [
  {
    id: 'google_module_network',
    label: 'VPC network (terraform-google-modules/network)',
    description:
      'A VPC with its subnets, secondary ranges, routes and firewall rules. Subnets are a list of objects, so a new region is a list entry.',
    source: 'terraform-google-modules/network/google',
    name: 'network',
    fields: [
      { input: 'project_id', default: 'my-gcp-project' },
      { input: 'network_name', default: 'court-vpc' },
      { input: 'routing_mode', default: 'REGIONAL' },
      {
        input: 'subnets',
        default: '',
        hint: 'Required. A list of objects — write it in the file',
      },
      { input: 'secondary_ranges', default: '', hint: 'key=value, comma-separated' },
      { input: 'delete_default_internet_gateway_routes', default: 'false' },
      { input: 'shared_vpc_host', default: 'false' },
      { input: 'mtu', default: '1460' },
    ],
    outputs: ['network_name', 'network_id', 'subnets_names', 'subnets_ids'],
  },
  {
    id: 'google_module_gke',
    label: 'GKE cluster (terraform-google-modules/kubernetes-engine)',
    description:
      'A cluster with its node pools, workload identity, release channel and the firewall rules GKE needs. The module is the reference implementation.',
    source: 'terraform-google-modules/kubernetes-engine/google',
    name: 'gke',
    fields: [
      { input: 'project_id', default: 'my-gcp-project' },
      { input: 'name', label: 'Cluster name', default: 'court-gke' },
      { input: 'region', default: 'us-central1' },
      { input: 'regional', label: 'Regional cluster', default: 'true' },
      { input: 'network', default: 'court-vpc' },
      { input: 'subnetwork', default: 'court-subnet' },
      { input: 'ip_range_pods', default: 'court-pods', hint: 'Secondary range name for pods' },
      { input: 'ip_range_services', default: 'court-services' },
      { input: 'release_channel', default: 'REGULAR' },
      { input: 'kubernetes_version', default: 'latest' },
      { input: 'enable_shielded_nodes', default: 'true' },
      { input: 'remove_default_node_pool', default: 'true' },
      { input: 'deletion_protection', default: 'true' },
    ],
    outputs: ['name', 'endpoint', 'ca_certificate', 'location'],
  },
  {
    id: 'google_module_project_factory',
    label: 'Project (terraform-google-modules/project-factory)',
    description:
      'A project with its billing, APIs, service accounts and shared-VPC attachment — the unit of isolation on GCP, created properly.',
    source: 'terraform-google-modules/project-factory/google',
    name: 'project',
    fields: [
      { input: 'name', label: 'Project name', default: 'court-prod' },
      { input: 'org_id', default: '', hint: 'Numeric organization id' },
      { input: 'billing_account', default: '' },
      { input: 'folder_id', default: '', hint: 'Blank to create under the organization' },
      { input: 'activate_apis', default: 'compute.googleapis.com,iam.googleapis.com' },
      { input: 'random_project_id', default: 'true', hint: 'Appends a suffix so the id is free' },
      { input: 'auto_create_network', default: 'false', hint: 'The default network is rarely wanted' },
    ],
    outputs: ['project_id', 'project_number', 'service_account_email'],
  },
  {
    id: 'google_module_storage',
    label: 'Cloud Storage buckets (terraform-google-modules/cloud-storage)',
    description:
      'One or more buckets with their IAM, lifecycle rules, versioning and retention. The module takes a list of names, so a set of buckets is one call.',
    source: 'terraform-google-modules/cloud-storage/google',
    name: 'storage',
    fields: [
      { input: 'project_id', default: 'my-gcp-project' },
      { input: 'names', label: 'Bucket names', default: 'court-archive,court-evidence' },
      { input: 'prefix', default: 'court', hint: 'Prepended to every name' },
      { input: 'location', default: 'US' },
      { input: 'storage_class', default: 'STANDARD' },
      { input: 'versioning', default: '', hint: 'key=value per bucket, e.g. court-archive=true' },
      { input: 'public_access_prevention', default: 'enforced' },
      { input: 'force_destroy', default: '', hint: 'key=value per bucket' },
    ],
    outputs: ['names', 'urls', 'buckets'],
  },
  {
    id: 'google_module_sql_postgres',
    label: 'Cloud SQL for PostgreSQL (terraform-google-modules/sql-db//modules/postgresql)',
    description:
      'A PostgreSQL instance with its backups, maintenance window, read replicas and private IP configuration.',
    source: 'terraform-google-modules/sql-db/google//modules/postgresql',
    name: 'postgresql',
    fields: [
      { input: 'project_id', default: 'my-gcp-project' },
      { input: 'name', label: 'Instance name', default: 'court-pgsql-01' },
      { input: 'database_version', default: 'POSTGRES_16' },
      { input: 'region', default: 'us-central1' },
      { input: 'zone', default: 'us-central1-a' },
      { input: 'tier', default: 'db-custom-2-7680' },
      { input: 'disk_size', default: '100' },
      { input: 'disk_type', default: 'PD_SSD' },
      { input: 'availability_type', default: 'REGIONAL', hint: 'REGIONAL is the high-availability one' },
      { input: 'db_name', default: 'court' },
      { input: 'deletion_protection', default: 'true' },
    ],
    outputs: ['instance_name', 'instance_connection_name', 'private_ip_address'],
  },
  {
    id: 'google_module_sql_mysql',
    label: 'Cloud SQL for MySQL (terraform-google-modules/sql-db//modules/mysql)',
    description: 'The same, for MySQL.',
    source: 'terraform-google-modules/sql-db/google//modules/mysql',
    name: 'mysql',
    fields: [
      { input: 'project_id', default: 'my-gcp-project' },
      { input: 'name', label: 'Instance name', default: 'court-mysql-01' },
      { input: 'database_version', default: 'MYSQL_8_0' },
      { input: 'region', default: 'us-central1' },
      { input: 'zone', default: 'us-central1-a' },
      { input: 'tier', default: 'db-custom-2-7680' },
      { input: 'disk_size', default: '100' },
      { input: 'availability_type', default: 'REGIONAL' },
      { input: 'db_name', default: 'court' },
      { input: 'deletion_protection', default: 'true' },
    ],
    outputs: ['instance_name', 'instance_connection_name', 'private_ip_address'],
  },
  {
    id: 'google_module_service_accounts',
    label: 'Service accounts (terraform-google-modules/service-accounts)',
    description: 'Service accounts with their project and billing roles, created as a set.',
    source: 'terraform-google-modules/service-accounts/google',
    name: 'service_accounts',
    fields: [
      { input: 'project_id', default: 'my-gcp-project' },
      { input: 'names', default: 'court-automation,court-app' },
      { input: 'prefix', default: 'sa' },
      { input: 'project_roles', default: '', hint: 'Comma-separated "project=>role"' },
      { input: 'generate_keys', default: 'false', hint: 'Keys are a liability; prefer workload identity' },
    ],
    outputs: ['emails', 'iam_emails', 'service_accounts'],
  },
  {
    id: 'google_module_cloud_nat',
    label: 'Cloud NAT (terraform-google-modules/cloud-nat)',
    description: 'Egress for private instances, with logging and the address allocation.',
    source: 'terraform-google-modules/cloud-nat/google',
    name: 'cloud_nat',
    fields: [
      { input: 'project_id', default: 'my-gcp-project' },
      { input: 'region', default: 'us-central1' },
      { input: 'name', default: 'court-nat' },
      { input: 'router', default: 'court-router', hint: 'An existing Cloud Router' },
      { input: 'source_subnetwork_ip_ranges_to_nat', default: 'ALL_SUBNETWORKS_ALL_IP_RANGES' },
      { input: 'log_config_enable', label: 'NAT logging', default: 'true' },
      { input: 'log_config_filter', default: 'ERRORS_ONLY' },
    ],
    outputs: ['name', 'router_name'],
  },
  {
    id: 'google_module_cloud_router',
    label: 'Cloud Router (terraform-google-modules/cloud-router)',
    description: 'The router NAT and hybrid connectivity hang off, with its BGP configuration.',
    source: 'terraform-google-modules/cloud-router/google',
    name: 'cloud_router',
    fields: [
      { input: 'project_id', default: 'my-gcp-project' },
      { input: 'name', default: 'court-router' },
      { input: 'region', default: 'us-central1' },
      { input: 'network', default: 'court-vpc' },
      { input: 'bgp', default: '', hint: 'key=value, comma-separated. Blank for none' },
    ],
    outputs: ['router', 'name'],
  },
  {
    id: 'google_module_dns',
    label: 'Cloud DNS zone (terraform-google-modules/cloud-dns)',
    description: 'A managed zone — public, private or forwarding — with its records.',
    source: 'terraform-google-modules/cloud-dns/google',
    name: 'dns',
    fields: [
      { input: 'project_id', default: 'my-gcp-project' },
      { input: 'name', label: 'Zone name', default: 'court-internal' },
      { input: 'domain', default: 'court.internal.', hint: 'Trailing dot required' },
      { input: 'type', label: 'Zone type', default: 'private' },
      { input: 'private_visibility_config_networks', default: '', hint: 'Network self-links, comma-separated' },
      { input: 'recordsets', default: '', hint: 'A list of objects — write it in the file' },
    ],
    outputs: ['name', 'domain', 'name_servers'],
  },
  {
    id: 'google_module_kms',
    label: 'KMS keyring and keys (terraform-google-modules/kms)',
    description: 'A key ring with its keys, rotation period and IAM bindings.',
    source: 'terraform-google-modules/kms/google',
    name: 'kms',
    fields: [
      { input: 'project_id', default: 'my-gcp-project' },
      { input: 'location', default: 'us-central1' },
      { input: 'keyring', default: 'court-keyring' },
      { input: 'keys', default: 'court-data-key', hint: 'Comma-separated key names' },
      { input: 'key_rotation_period', default: '7776000s', hint: '90 days' },
      { input: 'prevent_destroy', default: 'true' },
    ],
    outputs: ['keyring', 'keys', 'keyring_resource'],
  },
  {
    id: 'google_module_log_export',
    label: 'Log export (terraform-google-modules/log-export)',
    description:
      'A logging sink to a bucket, dataset or topic — the way audit logs leave the project they were written in.',
    source: 'terraform-google-modules/log-export/google',
    name: 'log_export',
    fields: [
      { input: 'destination_uri', default: '', hint: 'From the destination module’s output' },
      { input: 'filter', default: 'logName:"logs/cloudaudit.googleapis.com"' },
      { input: 'log_sink_name', default: 'court-audit-sink' },
      { input: 'parent_resource_id', default: 'my-gcp-project' },
      { input: 'parent_resource_type', default: 'project' },
      { input: 'unique_writer_identity', default: 'true' },
    ],
    outputs: ['writer_identity', 'log_sink_resource_name'],
  },
  {
    id: 'google_module_bigquery',
    label: 'BigQuery dataset (terraform-google-modules/bigquery)',
    description: 'A dataset with its tables, views, access and encryption.',
    source: 'terraform-google-modules/bigquery/google',
    name: 'bigquery',
    fields: [
      { input: 'project_id', default: 'my-gcp-project' },
      { input: 'dataset_id', default: 'court_analytics' },
      { input: 'dataset_name', default: 'Court analytics' },
      { input: 'location', default: 'US' },
      { input: 'description', default: 'Managed by Terraform' },
      { input: 'delete_contents_on_destroy', default: 'false' },
      { input: 'tables', default: '', hint: 'A list of objects — write it in the file' },
    ],
    outputs: ['bigquery_dataset', 'bigquery_tables', 'project'],
  },
];

export const GOOGLE_TERRAFORM_MODULES: BlueprintGroup = {
  target: 'google',
  label: 'Google Cloud Platform (GCP)',
  blueprints: SPECS.map((spec) => moduleBlueprint('google', spec)),
};
