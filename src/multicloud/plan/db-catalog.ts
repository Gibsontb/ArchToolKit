/**
 * Where a database can land: every managed service and IaaS option per
 * platform, with the engines, editions and HA forms it carries, the features it
 * cannot, its licence models and the Terraform types that build it.
 *
 * The Terraform types are checked against the pinned provider catalog
 * (`terraform/catalog-data.ts`) by `catalogs.test.ts`, so a renamed resource
 * fails a test instead of a plan. The limits and feature gaps are vendor facts
 * that move; each service carries its source and how far it was verified, and
 * the rules read them as data, never as logic.
 */

import type { Platform } from '../platforms.ts';
import { DB_SERVICE_LABELS, DB_SERVICE_VALUES, platformOfService } from './options.ts';
import type { DbEdition, DbEngine, DbFeature, DbHa, DbServiceId, DbVersionId, Verification } from './types.ts';

export type ServiceLicence = 'li' | 'byol';

export interface DbServiceInfo {
  readonly id: DbServiceId;
  readonly platform: Platform;
  readonly label: string;
  readonly engines: readonly DbEngine[];
  /** Editions it runs; undefined = any edition of its engines. */
  readonly editions?: readonly DbEdition[];
  /** A managed service (the provider runs the database), as opposed to a VM you run it on. */
  readonly managed: boolean;
  /** HA forms it can carry (as itself, or as the provider's equivalent). */
  readonly ha: readonly DbHa[];
  readonly unsupportedFeatures: readonly DbFeature[];
  /** The largest database it holds, where that is a real limit. (verify) */
  readonly maxStorageGib?: number;
  readonly licence: readonly ServiceLicence[];
  /** Per-engine licence models where they differ from `licence` (e.g. SQL Server on RDS is LI only). */
  readonly licenceByEngine?: Partial<Record<DbEngine, readonly ServiceLicence[]>>;
  /** Dual-stack endpoint supported. */
  readonly ipv6: boolean;
  /** Checked against CATALOG_DATA in tests. */
  readonly terraformTypes: readonly string[];
  readonly source: string;
  /** How far the limits and gaps above were verified. */
  readonly verification: Verification;
  readonly notes?: readonly string[];
}

const ALL_ENGINES: readonly DbEngine[] = ['oracle', 'sqlserver', 'postgres', 'mysql', 'mariadb', 'db2', 'mongodb', 'sybase-ase', 'other'];
/** Every HA form a self-managed VM can carry, bar the ones that need shared storage the platform lacks. */
const VM_HA: readonly DbHa[] = ['none', 'data-guard-local', 'sql-ag', 'sql-mirroring', 'log-shipping', 'pg-streaming', 'mysql-group-replication', 'other-cluster'];

type Row = Omit<DbServiceInfo, 'id' | 'platform' | 'label'>;

const ROWS: Readonly<Record<DbServiceId, Row>> = {
  // ---- AWS ------------------------------------------------------------------
  'aws-rds': {
    engines: ['oracle', 'sqlserver', 'postgres', 'mysql', 'mariadb', 'db2'],
    editions: ['oracle-ee', 'oracle-se2', 'sql-enterprise', 'sql-standard', 'sql-web', 'sql-express', 'community', 'commercial'],
    managed: true,
    // Multi-AZ is the HA; SQL Server Multi-AZ uses AGs or mirroring; Oracle replicas use Data Guard. No RAC.
    ha: ['none', 'data-guard-local', 'sql-ag', 'sql-mirroring', 'pg-streaming', 'mysql-group-replication'],
    unsupportedFeatures: ['filestream', 'clr-unsafe'],
    maxStorageGib: 65536,
    licence: ['li', 'byol'],
    licenceByEngine: { sqlserver: ['li'], oracle: ['li', 'byol'], db2: ['byol'] },
    ipv6: true,
    terraformTypes: ['aws_db_instance', 'aws_db_subnet_group', 'aws_db_option_group', 'aws_db_parameter_group'],
    source: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_SQLServer.html ; https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Oracle.Concepts.Licensing.html',
    verification: 'C',
    notes: [
      'Oracle EE is BYOL only; SE2 is licence-included or BYOL.',
      'SQL Server is licence-included only: an owned licence is not used.',
      'SSAS is supported in Single-AZ only.',
    ],
  },
  'aws-rds-custom': {
    engines: ['oracle', 'sqlserver'],
    editions: ['oracle-ee', 'oracle-se2', 'sql-enterprise', 'sql-standard', 'sql-web', 'sql-developer', 'commercial'],
    managed: true,
    ha: ['none', 'data-guard-local', 'sql-ag'],
    unsupportedFeatures: [],
    maxStorageGib: 65536,
    licence: ['li', 'byol'],
    licenceByEngine: { oracle: ['byol'], sqlserver: ['li', 'byol'] },
    ipv6: false,
    terraformTypes: ['aws_db_instance', 'aws_db_subnet_group'],
    source: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-custom.html',
    verification: 'C',
    notes: ['OS and database access are yours; for features RDS itself does not allow.'],
  },
  'aws-aurora': {
    engines: ['postgres', 'mysql'],
    editions: ['community'],
    managed: true,
    ha: ['none', 'pg-streaming', 'mysql-group-replication'],
    unsupportedFeatures: [],
    maxStorageGib: 131072,
    licence: ['li'],
    ipv6: true,
    terraformTypes: ['aws_rds_cluster', 'aws_rds_cluster_instance', 'aws_db_subnet_group'],
    source: 'https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_Limits.html',
    verification: 'C',
  },
  'aws-ec2': {
    engines: ALL_ENGINES,
    managed: false,
    // FCI needs shared storage: FSx for Windows File Server provides it. No RAC: no supported shared block storage.
    ha: [...VM_HA, 'sql-fci'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: true,
    terraformTypes: ['aws_instance'],
    source: 'https://www.oracle.com/a/ocom/docs/cloud-licensing-070579.pdf',
    verification: 'C',
    notes: ['Oracle RAC is not supported on EC2.'],
  },
  'aws-odb-exadata': {
    engines: ['oracle'],
    editions: ['oracle-ee', 'commercial'],
    managed: true,
    ha: ['none', 'rac', 'rac-one-node', 'data-guard-local'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['aws_odb_network', 'aws_odb_cloud_exadata_infrastructure', 'aws_odb_cloud_vm_cluster'],
    source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
    verification: 'C',
    notes: ['Oracle Database@AWS is region-limited: report the region, do not score it.'],
  },
  'aws-odb-adb': {
    engines: ['oracle'],
    editions: ['oracle-ee', 'commercial'],
    managed: true,
    ha: ['none', 'data-guard-local'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['aws_odb_network', 'aws_odb_cloud_exadata_infrastructure', 'aws_odb_cloud_autonomous_vm_cluster'],
    source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
    verification: 'C',
    notes: ['Autonomous Data Guard stands in for Data Guard.'],
  },

  // ---- Azure ----------------------------------------------------------------
  'azure-sqldb': {
    engines: ['sqlserver'],
    editions: ['sql-enterprise', 'sql-standard', 'commercial'],
    managed: true,
    ha: ['none', 'sql-ag'],
    unsupportedFeatures: ['agent-jobs', 'cross-db-queries', 'linked-servers', 'clr-unsafe', 'filestream', 'ssis', 'ssrs', 'ssas', 'dtc', 'service-broker'],
    // Hyperscale; General Purpose and Business Critical stop at 4 TiB.
    maxStorageGib: 131072,
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['azurerm_mssql_server', 'azurerm_mssql_database'],
    source: 'https://learn.microsoft.com/azure/azure-sql/database/transact-sql-tsql-differences-sql-server',
    verification: 'C',
    notes: ['Azure Hybrid Benefit applies to vCore databases.'],
  },
  'azure-sqlmi': {
    engines: ['sqlserver'],
    editions: ['sql-enterprise', 'sql-standard', 'commercial'],
    managed: true,
    ha: ['none', 'sql-ag', 'sql-mirroring', 'log-shipping'],
    unsupportedFeatures: ['ssis', 'ssrs', 'ssas', 'filestream'],
    maxStorageGib: 16384,
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['azurerm_mssql_managed_instance', 'azurerm_mssql_managed_instance_failover_group'],
    source: 'https://learn.microsoft.com/azure/azure-sql/managed-instance/transact-sql-tsql-differences-sql-server',
    verification: 'C',
    notes: ['Business Critical has an AG built in; `license_type` BasePrice is AHB, LicenseIncluded is LI.', 'SSIS runs in Azure Data Factory.'],
  },
  'azure-sqlvm': {
    engines: ['sqlserver'],
    managed: false,
    ha: ['none', 'sql-ag', 'sql-fci', 'sql-mirroring', 'log-shipping'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: true,
    terraformTypes: [
      'azurerm_windows_virtual_machine',
      'azurerm_mssql_virtual_machine',
      'azurerm_mssql_virtual_machine_group',
      'azurerm_mssql_virtual_machine_availability_group_listener',
    ],
    source: 'https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/licensing-model-azure-hybrid-benefit-ahb-change',
    verification: 'C',
    notes: ['`sql_license_type` AHUB (AHB), PAYG or DR (free passive replica).'],
  },
  'azure-pg-flex': {
    engines: ['postgres'],
    editions: ['community'],
    managed: true,
    ha: ['none', 'pg-streaming'],
    unsupportedFeatures: [],
    maxStorageGib: 32768,
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['azurerm_postgresql_flexible_server'],
    source: 'https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-limits',
    verification: 'C',
  },
  'azure-mysql-flex': {
    engines: ['mysql'],
    editions: ['community'],
    managed: true,
    ha: ['none', 'mysql-group-replication'],
    unsupportedFeatures: [],
    maxStorageGib: 16384,
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['azurerm_mysql_flexible_server'],
    source: 'https://learn.microsoft.com/azure/mysql/flexible-server/concepts-limitations',
    verification: 'C',
    notes: ['Azure has no managed MariaDB: MariaDB lands on MySQL flexible server or a VM.'],
  },
  'azure-vm': {
    engines: ALL_ENGINES,
    managed: false,
    ha: [...VM_HA, 'sql-fci'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: true,
    terraformTypes: ['azurerm_linux_virtual_machine', 'azurerm_windows_virtual_machine'],
    source: 'https://www.oracle.com/a/ocom/docs/cloud-licensing-070579.pdf',
    verification: 'C',
    notes: ['Oracle RAC is not supported on Azure VMs.'],
  },
  'azure-odb-exadata': {
    engines: ['oracle'],
    editions: ['oracle-ee', 'commercial'],
    managed: true,
    ha: ['none', 'rac', 'rac-one-node', 'data-guard-local'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['azurerm_oracle_exadata_infrastructure', 'azurerm_oracle_cloud_vm_cluster'],
    source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
    verification: 'C',
    notes: ['Oracle Database@Azure is region-limited: report the region, do not score it.'],
  },
  'azure-odb-adb': {
    engines: ['oracle'],
    editions: ['oracle-ee', 'commercial'],
    managed: true,
    ha: ['none', 'data-guard-local'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['azurerm_oracle_autonomous_database'],
    source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
    verification: 'C',
  },

  // ---- Google Cloud (GCP) ---------------------------------------------------
  'google-cloudsql': {
    engines: ['postgres', 'mysql', 'sqlserver'],
    editions: ['community', 'sql-enterprise', 'sql-standard', 'sql-web', 'sql-express', 'commercial'],
    managed: true,
    ha: ['none', 'pg-streaming', 'mysql-group-replication', 'sql-ag'],
    unsupportedFeatures: ['ssas', 'ssrs', 'filestream', 'dtc'],
    maxStorageGib: 65536,
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['google_sql_database_instance', 'google_sql_database', 'google_sql_user'],
    source: 'https://cloud.google.com/sql/docs/sqlserver/features',
    verification: 'I',
    notes: ['SQL Server is licence-included only.', 'The SSRS gap is unconfirmed.'],
  },
  'google-alloydb': {
    engines: ['postgres'],
    editions: ['community'],
    managed: true,
    ha: ['none', 'pg-streaming'],
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['google_alloydb_cluster', 'google_alloydb_instance'],
    source: 'https://cloud.google.com/alloydb/docs/overview',
    verification: 'C',
  },
  'google-gce': {
    engines: ALL_ENGINES,
    managed: false,
    ha: [...VM_HA, 'sql-fci'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: true,
    terraformTypes: ['google_compute_instance'],
    source: 'https://www.oracle.com/a/ocom/docs/cloud-licensing-070579.pdf',
    verification: 'C',
    notes: ['Oracle RAC is not supported on Compute Engine VMs.'],
  },
  'google-odb-exadata': {
    engines: ['oracle'],
    editions: ['oracle-ee', 'commercial'],
    managed: true,
    ha: ['none', 'rac', 'rac-one-node', 'data-guard-local'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: [
      'google_oracle_database_cloud_exadata_infrastructure',
      'google_oracle_database_cloud_vm_cluster',
      'google_oracle_database_odb_network',
      'google_oracle_database_odb_subnet',
    ],
    source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
    verification: 'C',
    notes: ['Oracle Database@Google Cloud is region-limited: report the region, do not score it.'],
  },
  'google-odb-adb': {
    engines: ['oracle'],
    editions: ['oracle-ee', 'commercial'],
    managed: true,
    ha: ['none', 'data-guard-local'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['google_oracle_database_autonomous_database', 'google_oracle_database_odb_network', 'google_oracle_database_odb_subnet'],
    source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
    verification: 'C',
  },
  'google-odb-basedb': {
    engines: ['oracle'],
    editions: ['oracle-ee', 'oracle-se2', 'commercial'],
    managed: true,
    ha: ['none', 'data-guard-local'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['google_oracle_database_db_system', 'google_oracle_database_odb_network', 'google_oracle_database_odb_subnet'],
    source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
    verification: 'I',
  },

  // ---- OCI ------------------------------------------------------------------
  'oci-adb': {
    engines: ['oracle'],
    editions: ['oracle-ee', 'oracle-se2', 'commercial'],
    managed: true,
    ha: ['none', 'data-guard-local'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['oci_database_autonomous_database'],
    source: 'https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/autonomous-byol.html',
    verification: 'C',
    notes: ['Autonomous Data Guard stands in for Data Guard.'],
  },
  'oci-basedb': {
    engines: ['oracle'],
    editions: ['oracle-ee', 'oracle-se2', 'commercial'],
    managed: true,
    // Two-node RAC on VM DB systems (Enterprise Edition Extreme Performance).
    ha: ['none', 'rac', 'rac-one-node', 'data-guard-local'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['oci_database_db_system', 'oci_database_data_guard_association'],
    source: 'https://docs.oracle.com/en-us/iaas/base-database/doc/overview-db-systems.html',
    verification: 'C',
  },
  'oci-exacs': {
    engines: ['oracle'],
    editions: ['oracle-ee', 'commercial'],
    managed: true,
    ha: ['none', 'rac', 'rac-one-node', 'data-guard-local'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['oci_database_cloud_exadata_infrastructure', 'oci_database_cloud_vm_cluster'],
    source: 'https://docs.oracle.com/en-us/iaas/exadatacloud/doc/exa-service-desc.html',
    verification: 'C',
  },
  'oci-mysql-heatwave': {
    engines: ['mysql'],
    editions: ['community', 'commercial'],
    managed: true,
    ha: ['none', 'mysql-group-replication'],
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['oci_mysql_mysql_db_system'],
    source: 'https://docs.oracle.com/en-us/iaas/mysql-database/doc/overview-mysql-database-service.html',
    verification: 'C',
  },
  'oci-pg': {
    engines: ['postgres'],
    editions: ['community'],
    managed: true,
    ha: ['none', 'pg-streaming'],
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['oci_psql_db_system'],
    source: 'https://docs.oracle.com/en-us/iaas/Content/postgresql/overview.htm',
    verification: 'C',
  },
  'oci-compute': {
    engines: ALL_ENGINES,
    managed: false,
    ha: VM_HA,
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: true,
    terraformTypes: ['oci_core_instance'],
    source: 'https://samexpert.com/flexible-virtualization/',
    verification: 'C',
    notes: ['SQL Server on OCI has no managed service: it lands here, with Windows and SQL BYOL through the Flexible Virtualization Benefit.'],
  },

  // ---- VMware / VCF ---------------------------------------------------------
  'vmware-vm': {
    engines: ALL_ENGINES,
    managed: false,
    // Shared VMDKs (multi-writer) carry RAC and FCI on vSphere.
    ha: [...VM_HA, 'rac', 'rac-one-node', 'sql-fci'],
    unsupportedFeatures: [],
    licence: ['byol'],
    ipv6: true,
    terraformTypes: ['vsphere_virtual_machine'],
    source: 'https://www.oracle.com/assets/partitioning-070609.pdf',
    verification: 'C',
    notes: ['Oracle on vSphere is licensed on every host in the clusters it could run on.'],
  },
};

export const DB_SERVICES: Readonly<Record<DbServiceId, DbServiceInfo>> = Object.freeze(
  Object.fromEntries(
    DB_SERVICE_VALUES.map((id) => [id, Object.freeze({ id, platform: platformOfService(id), label: DB_SERVICE_LABELS[id], ...ROWS[id] })]),
  ) as Record<DbServiceId, DbServiceInfo>,
);

/** The services on `platform` that run `engine` (and, when given, that edition), in catalog order. */
export function servicesFor(engine: DbEngine, platform?: Platform, edition?: DbEdition): readonly DbServiceInfo[] {
  return DB_SERVICE_VALUES.map((id) => DB_SERVICES[id]).filter(
    (s) => (platform === undefined || s.platform === platform) && s.engines.includes(engine) && (!edition || !s.editions || s.editions.includes(edition)),
  );
}

/** The licence models a service offers for an engine. */
export function serviceLicences(service: DbServiceId, engine: DbEngine): readonly ServiceLicence[] {
  const s = DB_SERVICES[service];
  return s.licenceByEngine?.[engine] ?? s.licence;
}

/** The features of `features` a service cannot carry. */
export function unsupportedOn(service: DbServiceId, features: readonly DbFeature[]): DbFeature[] {
  const gaps = DB_SERVICES[service].unsupportedFeatures;
  return features.filter((f) => gaps.includes(f));
}

/** The IaaS (VM) service on each platform: where any engine can go. */
export const VM_SERVICE: Readonly<Record<Platform, DbServiceId>> = {
  aws: 'aws-ec2',
  azure: 'azure-vm',
  google: 'google-gce',
  oci: 'oci-compute',
  vmware: 'vmware-vm',
};

// ---------------------------------------------------------------------------
// Versions: support dates and each provider's spelling
// ---------------------------------------------------------------------------

export interface DbVersionInfo {
  readonly id: DbVersionId;
  readonly engine: DbEngine | undefined;
  /** End of the vendor's normal support (Oracle: Premier / error correction; Microsoft: extended support; community: EOL). */
  readonly endOfSupport?: string;
  /** Paid extension (Oracle Extended Support, Microsoft ESU). */
  readonly endOfExtendedSupport?: string;
  /** Provider spellings: RDS `engine_version` (major, or the full string), Cloud SQL `database_version` (SQL Server: a pattern with {EDITION}), Azure flexible server `version`, OCI `db_version`. */
  readonly providers: {
    readonly rds?: string;
    readonly cloudsql?: string;
    readonly azure?: string;
    readonly oci?: string;
  };
  readonly source: string;
  readonly verification: Verification;
  readonly note?: string;
}

const ORACLE_SUPPORT = 'https://www.oracle.com/us/assets/lifetime-support-technology-069183.pdf';
const SQL_LIFECYCLE = (v: string) => `https://learn.microsoft.com/lifecycle/products/sql-server-${v}`;
const PG = 'https://www.postgresql.org/support/versioning/';
const MYSQL = 'https://www.mysql.com/support/eol-notice.html';
const MARIADB = 'https://mariadb.org/about/#maintenance-policy';

type VRow = Omit<DbVersionInfo, 'id' | 'engine'>;
const VERSION_ROWS: Readonly<Record<DbVersionId, VRow>> = {
  'oracle-11.2': { endOfSupport: '2015-01-31', endOfExtendedSupport: '2020-12-31', providers: {}, source: ORACLE_SUPPORT, verification: 'C' },
  'oracle-12.1': { endOfSupport: '2018-07-31', endOfExtendedSupport: '2022-07-31', providers: {}, source: ORACLE_SUPPORT, verification: 'C' },
  'oracle-12.2': { endOfSupport: '2022-03-31', providers: {}, source: ORACLE_SUPPORT, verification: 'C' },
  'oracle-18c': { endOfSupport: '2021-06-30', providers: {}, source: ORACLE_SUPPORT, verification: 'C' },
  'oracle-19c': {
    endOfSupport: '2029-12-31', endOfExtendedSupport: '2032-12-31',
    providers: { rds: '19.0.0.0.ru-2025-01.rur-2025-01.r1', oci: '19.0.0.0' },
    source: ORACLE_SUPPORT, verification: 'C',
  },
  'oracle-21c': {
    endOfSupport: '2027-07-31',
    providers: { rds: '21.0.0.0.ru-2025-01.rur-2025-01.r1', oci: '21.0.0.0' },
    source: ORACLE_SUPPORT, verification: 'I',
    note: 'An innovation release: plan for 19c or 26ai.',
  },
  'oracle-26ai': {
    providers: { oci: '23.0.0.0' },
    source: 'https://blogs.oracle.com/database/oracle-announces-oracle-ai-database-26ai',
    verification: 'I',
    note: '26ai replaced 23ai with the October 2025 RU and is delivered as a 23.x release update, so OCI is given db_version 23.0.0.0 (verify).',
  },
  'sql-2012': { endOfSupport: '2022-07-12', endOfExtendedSupport: '2025-07-08', providers: {}, source: SQL_LIFECYCLE('2012'), verification: 'C' },
  'sql-2014': { endOfSupport: '2024-07-09', endOfExtendedSupport: '2027-07-13', providers: {}, source: SQL_LIFECYCLE('2014'), verification: 'C', note: 'ESUs are free on Azure.' },
  'sql-2016': { endOfSupport: '2026-07-14', providers: {}, source: SQL_LIFECYCLE('2016'), verification: 'C', note: 'Past support; ESUs are paid everywhere.' },
  'sql-2017': { endOfSupport: '2027-10-12', providers: { rds: '14.00.3465.1.v1' }, source: SQL_LIFECYCLE('2017'), verification: 'C' },
  'sql-2019': { endOfSupport: '2030-01-08', providers: { rds: '15.00.4420.2.v1', cloudsql: 'SQLSERVER_2019_{EDITION}' }, source: SQL_LIFECYCLE('2019'), verification: 'C' },
  'sql-2022': { endOfSupport: '2033-01-11', providers: { rds: '16.00.4185.3.v1', cloudsql: 'SQLSERVER_2022_{EDITION}' }, source: SQL_LIFECYCLE('2022'), verification: 'C' },
  'sql-2025': { providers: {}, source: SQL_LIFECYCLE('2025'), verification: 'I', note: 'Managed-service support not confirmed; lands on VMs until it is.' },
  'pg-11': { endOfSupport: '2023-11-09', providers: {}, source: PG, verification: 'C' },
  'pg-12': { endOfSupport: '2024-11-21', providers: {}, source: PG, verification: 'C' },
  'pg-13': { endOfSupport: '2025-11-13', providers: { rds: '13', cloudsql: 'POSTGRES_13', azure: '13' }, source: PG, verification: 'C' },
  'pg-14': { endOfSupport: '2026-11-12', providers: { rds: '14', cloudsql: 'POSTGRES_14', azure: '14' }, source: PG, verification: 'C' },
  'pg-15': { endOfSupport: '2027-11-11', providers: { rds: '15', cloudsql: 'POSTGRES_15', azure: '15' }, source: PG, verification: 'C' },
  'pg-16': { endOfSupport: '2028-11-09', providers: { rds: '16', cloudsql: 'POSTGRES_16', azure: '16' }, source: PG, verification: 'C' },
  'pg-17': { endOfSupport: '2029-11-08', providers: { rds: '17', cloudsql: 'POSTGRES_17', azure: '17' }, source: PG, verification: 'C' },
  'pg-18': { endOfSupport: '2030-11-14', providers: { rds: '18', cloudsql: 'POSTGRES_18' }, source: PG, verification: 'I', note: 'Provider support for 18 is not confirmed here.' },
  'mysql-5.7': { endOfSupport: '2023-10-31', providers: {}, source: MYSQL, verification: 'C', note: 'Past community EOL; RDS Extended Support is paid.' },
  'mysql-8.0': { endOfSupport: '2026-04-30', providers: { rds: '8.0', cloudsql: 'MYSQL_8_0', azure: '8.0.21' }, source: MYSQL, verification: 'C' },
  'mysql-8.4': { endOfSupport: '2032-04-30', providers: { rds: '8.4', cloudsql: 'MYSQL_8_4', azure: '8.4' }, source: MYSQL, verification: 'C' },
  'mariadb-10.6': { endOfSupport: '2026-07-06', providers: { rds: '10.6.21' }, source: MARIADB, verification: 'C' },
  'mariadb-10.11': { endOfSupport: '2028-02-16', providers: { rds: '10.11' }, source: MARIADB, verification: 'C' },
  'mariadb-11.4': { endOfSupport: '2029-05-29', providers: { rds: '11.4' }, source: MARIADB, verification: 'C' },
  other: { providers: {}, source: 'n/a', verification: 'I' },
};

function engineOfVersion(id: DbVersionId): DbEngine | undefined {
  if (id.startsWith('oracle-')) return 'oracle';
  if (id.startsWith('sql-')) return 'sqlserver';
  if (id.startsWith('pg-')) return 'postgres';
  if (id.startsWith('mysql-')) return 'mysql';
  if (id.startsWith('mariadb-')) return 'mariadb';
  return undefined;
}

export const DB_VERSIONS: Readonly<Record<DbVersionId, DbVersionInfo>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(VERSION_ROWS) as DbVersionId[]).map((id) => [id, Object.freeze({ id, engine: engineOfVersion(id), ...VERSION_ROWS[id] })]),
  ) as Record<DbVersionId, DbVersionInfo>,
);

/** Past the vendor's normal support on `on` (ISO date): the `db.version-eol` warning. */
export function isVersionEol(id: DbVersionId, on: string): boolean {
  const end = DB_VERSIONS[id].endOfSupport;
  return end !== undefined && on > end;
}

/** Cloud SQL's `database_version` for a version and edition, e.g. `SQLSERVER_2022_ENTERPRISE`. */
export function cloudSqlVersion(id: DbVersionId, edition: DbEdition): string | undefined {
  const pattern = DB_VERSIONS[id].providers.cloudsql;
  if (!pattern) return undefined;
  if (!pattern.includes('{EDITION}')) return pattern;
  const e: Partial<Record<DbEdition, string>> = {
    'sql-enterprise': 'ENTERPRISE', 'sql-standard': 'STANDARD', 'sql-web': 'WEB', 'sql-express': 'EXPRESS',
    commercial: 'ENTERPRISE',
  };
  const name = e[edition];
  return name ? pattern.replace('{EDITION}', name) : undefined;
}
