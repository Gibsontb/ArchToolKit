/**
 * One capability, five platforms.
 *
 * The usual form of this table is a list of marketing names, which is pleasant
 * to read and useless to act on: product names get renamed, and knowing that
 * Azure's object store is called Blob Storage does not help anyone build one.
 *
 * So every entry carries the Terraform resource type as well as the name, and a
 * test checks every one of those against the committed provider catalog. That
 * makes the table self-verifying — a resource that gets renamed in a provider
 * release fails the suite instead of quietly becoming wrong — and it makes the
 * table do something, because choosing a platform hands the Terraform kit a
 * type it can emit.
 *
 * Product names are indicative and tagged as such. Resource types are not: they
 * are checked.
 */

import type { Platform } from './platforms.ts';

export type Capability =
  | 'virtual-machine'
  | 'kubernetes'
  | 'serverless-function'
  | 'object-storage'
  | 'block-storage'
  | 'file-storage'
  | 'relational-postgres'
  | 'relational-sqlserver'
  | 'nosql'
  | 'data-warehouse'
  | 'cache'
  | 'message-queue'
  | 'load-balancer'
  | 'dns'
  | 'cdn'
  | 'container-registry'
  | 'private-connectivity'
  | 'site-to-site-vpn'
  | 'key-management'
  | 'secrets'
  | 'backup';

export interface ServiceEntry {
  /** Product name as the vendor writes it. Indicative — names change. */
  readonly name: string;
  /**
   * Terraform resource type that builds it. Checked against the committed
   * provider catalog by the test suite, so this is the trustworthy half.
   */
  readonly terraformType: string;
}

export interface CapabilityRow {
  readonly capability: Capability;
  readonly label: string;
  /** What the capability is, in the terms someone choosing would use. */
  readonly summary: string;
  /**
   * Per-platform equivalents. A platform may be absent, which means it has no
   * equivalent worth naming rather than that nobody looked — the gaps are the
   * interesting part of a matrix.
   */
  readonly on: Partial<Record<Platform, ServiceEntry>>;
}

export const CAPABILITIES: readonly CapabilityRow[] = [
  {
    capability: 'virtual-machine',
    label: 'Virtual machine',
    summary: 'A guest OS you administer. The landing place for anything rehosted unchanged.',
    on: {
      vmware: { name: 'vSphere virtual machine', terraformType: 'vsphere_virtual_machine' },
      aws: { name: 'Amazon EC2', terraformType: 'aws_instance' },
      azure: { name: 'Azure Virtual Machines', terraformType: 'azurerm_linux_virtual_machine' },
      google: { name: 'Compute Engine', terraformType: 'google_compute_instance' },
      oci: { name: 'OCI Compute', terraformType: 'oci_core_instance' },
    },
  },
  {
    capability: 'kubernetes',
    label: 'Managed Kubernetes',
    summary: 'A control plane someone else patches.',
    on: {
      aws: { name: 'Amazon EKS', terraformType: 'aws_eks_cluster' },
      azure: { name: 'Azure Kubernetes Service', terraformType: 'azurerm_kubernetes_cluster' },
      google: { name: 'Google Kubernetes Engine', terraformType: 'google_container_cluster' },
      oci: { name: 'OCI Kubernetes Engine', terraformType: 'oci_containerengine_cluster' },
    },
  },
  {
    capability: 'serverless-function',
    label: 'Serverless function',
    summary: 'Code without a server to patch. Nothing rehosted lands here.',
    on: {
      aws: { name: 'AWS Lambda', terraformType: 'aws_lambda_function' },
      azure: { name: 'Azure Functions', terraformType: 'azurerm_linux_function_app' },
      google: { name: 'Cloud Run functions', terraformType: 'google_cloudfunctions2_function' },
      oci: { name: 'OCI Functions', terraformType: 'oci_functions_function' },
    },
  },
  {
    capability: 'object-storage',
    label: 'Object storage',
    summary: 'The cheapest durable store, and where backups and archives belong.',
    on: {
      aws: { name: 'Amazon S3', terraformType: 'aws_s3_bucket' },
      azure: { name: 'Azure Blob Storage', terraformType: 'azurerm_storage_account' },
      google: { name: 'Cloud Storage', terraformType: 'google_storage_bucket' },
      oci: { name: 'OCI Object Storage', terraformType: 'oci_objectstorage_bucket' },
    },
  },
  {
    capability: 'block-storage',
    label: 'Block storage',
    summary: 'A disk attached to one machine. What a VMDK becomes.',
    on: {
      aws: { name: 'Amazon EBS', terraformType: 'aws_ebs_volume' },
      azure: { name: 'Azure Managed Disks', terraformType: 'azurerm_managed_disk' },
      google: { name: 'Persistent Disk', terraformType: 'google_compute_disk' },
      oci: { name: 'OCI Block Volume', terraformType: 'oci_core_volume' },
    },
  },
  {
    capability: 'file-storage',
    label: 'Shared file storage',
    summary: 'NFS or SMB for several machines at once. What an NFS datastore becomes.',
    on: {
      aws: { name: 'Amazon EFS', terraformType: 'aws_efs_file_system' },
      azure: { name: 'Azure Files', terraformType: 'azurerm_storage_share' },
      google: { name: 'Filestore', terraformType: 'google_filestore_instance' },
      oci: { name: 'OCI File Storage', terraformType: 'oci_file_storage_file_system' },
    },
  },
  {
    capability: 'relational-postgres',
    label: 'Managed PostgreSQL',
    summary: 'A database you no longer patch, back up or fail over by hand.',
    on: {
      aws: { name: 'Amazon RDS for PostgreSQL', terraformType: 'aws_db_instance' },
      azure: {
        name: 'Azure Database for PostgreSQL flexible server',
        terraformType: 'azurerm_postgresql_flexible_server',
      },
      google: { name: 'Cloud SQL for PostgreSQL', terraformType: 'google_sql_database_instance' },
      oci: { name: 'OCI Database with PostgreSQL', terraformType: 'oci_psql_db_system' },
    },
  },
  {
    capability: 'relational-sqlserver',
    label: 'Managed SQL Server',
    summary: 'Where a Windows estate’s databases land, and where its licensing bites.',
    on: {
      aws: { name: 'Amazon RDS for SQL Server', terraformType: 'aws_db_instance' },
      azure: { name: 'Azure SQL Database', terraformType: 'azurerm_mssql_database' },
      google: { name: 'Cloud SQL for SQL Server', terraformType: 'google_sql_database_instance' },
    },
  },
  {
    capability: 'nosql',
    label: 'Managed NoSQL',
    summary: 'Key-value and document stores.',
    on: {
      aws: { name: 'Amazon DynamoDB', terraformType: 'aws_dynamodb_table' },
      azure: { name: 'Azure Cosmos DB', terraformType: 'azurerm_cosmosdb_account' },
      google: { name: 'Firestore', terraformType: 'google_firestore_database' },
      oci: { name: 'OCI NoSQL Database', terraformType: 'oci_nosql_table' },
    },
  },
  {
    capability: 'data-warehouse',
    label: 'Data warehouse',
    summary: 'Analytics over a lot of data at once.',
    on: {
      aws: { name: 'Amazon Redshift', terraformType: 'aws_redshift_cluster' },
      azure: { name: 'Azure Synapse Analytics', terraformType: 'azurerm_synapse_workspace' },
      google: { name: 'BigQuery', terraformType: 'google_bigquery_dataset' },
      oci: { name: 'OCI Big Data Service', terraformType: 'oci_bds_bds_instance' },
    },
  },
  {
    capability: 'cache',
    label: 'In-memory cache',
    summary: 'Redis or Memcached, managed.',
    on: {
      aws: { name: 'Amazon ElastiCache', terraformType: 'aws_elasticache_replication_group' },
      azure: { name: 'Azure Cache for Redis', terraformType: 'azurerm_redis_cache' },
      google: { name: 'Memorystore', terraformType: 'google_redis_instance' },
      oci: { name: 'OCI Cache', terraformType: 'oci_redis_redis_cluster' },
    },
  },
  {
    capability: 'message-queue',
    label: 'Message queue',
    summary: 'Decoupling between components that must not lose a message.',
    on: {
      aws: { name: 'Amazon SQS', terraformType: 'aws_sqs_queue' },
      azure: { name: 'Azure Service Bus', terraformType: 'azurerm_servicebus_queue' },
      google: { name: 'Pub/Sub', terraformType: 'google_pubsub_topic' },
      oci: { name: 'OCI Queue', terraformType: 'oci_queue_queue' },
    },
  },
  {
    capability: 'load-balancer',
    label: 'Load balancer',
    summary: 'What replaces the appliance in front of the application.',
    on: {
      aws: { name: 'Elastic Load Balancing', terraformType: 'aws_lb' },
      azure: { name: 'Azure Load Balancer', terraformType: 'azurerm_lb' },
      google: { name: 'Cloud Load Balancing', terraformType: 'google_compute_forwarding_rule' },
      oci: { name: 'OCI Load Balancer', terraformType: 'oci_load_balancer_load_balancer' },
    },
  },
  {
    capability: 'dns',
    label: 'Authoritative DNS',
    summary: 'Where the zone lives once the estate moves.',
    on: {
      aws: { name: 'Amazon Route 53', terraformType: 'aws_route53_zone' },
      azure: { name: 'Azure DNS', terraformType: 'azurerm_dns_zone' },
      google: { name: 'Cloud DNS', terraformType: 'google_dns_managed_zone' },
      oci: { name: 'OCI DNS', terraformType: 'oci_dns_zone' },
    },
  },
  {
    capability: 'cdn',
    label: 'Content delivery',
    summary: 'Caching at the edge.',
    on: {
      aws: { name: 'Amazon CloudFront', terraformType: 'aws_cloudfront_distribution' },
      azure: { name: 'Azure Front Door / CDN', terraformType: 'azurerm_cdn_profile' },
    },
  },
  {
    capability: 'container-registry',
    label: 'Container registry',
    summary: 'Where images live once a build pipeline exists.',
    on: {
      aws: { name: 'Amazon ECR', terraformType: 'aws_ecr_repository' },
      azure: { name: 'Azure Container Registry', terraformType: 'azurerm_container_registry' },
      google: { name: 'Artifact Registry', terraformType: 'google_artifact_registry_repository' },
      oci: { name: 'OCI Container Registry', terraformType: 'oci_artifacts_container_repository' },
    },
  },
  {
    capability: 'private-connectivity',
    label: 'Private circuit to on-premises',
    summary:
      'A dedicated circuit rather than the internet. The long-lead item in every migration, and the one that decides the cutover date.',
    on: {
      aws: { name: 'AWS Direct Connect', terraformType: 'aws_dx_connection' },
      azure: { name: 'Azure ExpressRoute', terraformType: 'azurerm_express_route_circuit' },
      google: { name: 'Cloud Interconnect', terraformType: 'google_compute_interconnect' },
      oci: { name: 'OCI FastConnect', terraformType: 'oci_core_virtual_circuit' },
    },
  },
  {
    capability: 'site-to-site-vpn',
    label: 'Site-to-site VPN',
    summary: 'The interim path while the circuit is provisioned, and the fallback after.',
    on: {
      aws: { name: 'AWS Site-to-Site VPN', terraformType: 'aws_vpn_connection' },
      azure: { name: 'Azure VPN Gateway', terraformType: 'azurerm_virtual_network_gateway' },
      google: { name: 'Cloud VPN', terraformType: 'google_compute_ha_vpn_gateway' },
      oci: { name: 'OCI Site-to-Site VPN', terraformType: 'oci_core_ipsec' },
    },
  },
  {
    capability: 'key-management',
    label: 'Key management',
    summary: 'Where encryption keys live, and who can reach them.',
    on: {
      aws: { name: 'AWS KMS', terraformType: 'aws_kms_key' },
      azure: { name: 'Azure Key Vault', terraformType: 'azurerm_key_vault' },
      google: { name: 'Cloud KMS', terraformType: 'google_kms_crypto_key' },
      oci: { name: 'OCI Vault', terraformType: 'oci_kms_key' },
    },
  },
  {
    capability: 'secrets',
    label: 'Secret storage',
    summary: 'Where the credentials go that this toolkit refuses to write into a file.',
    on: {
      aws: { name: 'AWS Secrets Manager', terraformType: 'aws_secretsmanager_secret' },
      azure: { name: 'Azure Key Vault secrets', terraformType: 'azurerm_key_vault_secret' },
      google: { name: 'Secret Manager', terraformType: 'google_secret_manager_secret' },
      oci: { name: 'OCI Vault secrets', terraformType: 'oci_vault_secret' },
    },
  },
  {
    capability: 'backup',
    label: 'Managed backup',
    summary: 'Policy-driven backup of the platform’s own resources.',
    on: {
      aws: { name: 'AWS Backup', terraformType: 'aws_backup_plan' },
      azure: { name: 'Azure Backup', terraformType: 'azurerm_recovery_services_vault' },
      google: { name: 'Backup and DR Service', terraformType: 'google_backup_dr_backup_plan' },
    },
  },
];

export function capabilityRow(capability: Capability): CapabilityRow | undefined {
  return CAPABILITIES.find((c) => c.capability === capability);
}

/** What a platform offers for a capability, if anything. */
export function serviceOn(capability: Capability, platform: Platform): ServiceEntry | undefined {
  return capabilityRow(capability)?.on[platform];
}

/** Capabilities a platform has no entry for. The gaps are the interesting part. */
export function gapsFor(platform: Platform): readonly Capability[] {
  return CAPABILITIES.filter((row) => row.on[platform] === undefined).map((row) => row.capability);
}

/** Capabilities every one of the given platforms covers. */
export function commonCapabilities(platforms: readonly Platform[]): readonly Capability[] {
  if (platforms.length === 0) return [];
  return CAPABILITIES.filter((row) => platforms.every((p) => row.on[p] !== undefined)).map(
    (row) => row.capability,
  );
}
