/**
 * Every closed set in the planner, as an option table with labels: the single
 * source for the dropdowns, the CSV validation and the defaults.
 *
 * Each union in `types.ts` has a `*_VALUES` list here, checked at compile time
 * to name every member exactly once (`all<U>()`), and an options table built
 * from that list and a `Record<U, string>` of labels (which the compiler also
 * holds to the union, in both directions). `options.test.ts` checks the same at
 * run time, so a new union member without a dropdown entry fails twice.
 *
 * Google is "Google Cloud (GCP)" everywhere a person reads it; its id stays
 * `google`.
 */

             
                                                                                                          
                                                                                                                  
                                                                                                              
                                                                                                                   
                                                                                                                
                                                                                                        
                                                                                                                     
                                                                                                            
                                                                                                                
                                                                                                                     
                                                                                                               
                                                                                                                 
                                                                                                                
                                                                                                              
                                                                                                                  
                                                                                                                  
                                                                                                        
                                                                                                             
                                                                                                          
                                                                                                                 
                   
                    

// ---------------------------------------------------------------------------
// The machinery
// ---------------------------------------------------------------------------

/** One dropdown entry. `group` is the `<optgroup>` heading, where the set is long enough to need one. */
                                                        
                    
                         
                          
 

/**
 * A list that names every member of `U` (a missing member makes the argument
 * `never`, and an extra one is not a `U`): the type-level exhaustiveness check.
 */
export function all                  () {
  return                               (list                                                                 )    =>
    Object.freeze([...list])                ;
}

function table                  (
  values              ,
  labels                             ,
  group                                   ,
)                           {
  return Object.freeze(
    values.map((value) => {
      const g = group?.(value);
      return Object.freeze(g ? { value, label: labels[value], group: g } : { value, label: labels[value] });
    }),
  );
}

/** True when `value` is one of the table's values. */
export function isOption                  (options                          , value         )             {
  return typeof value === 'string' && options.some((o) => o.value === value);
}

/** The label for a value, or the value itself when it is not in the table. */
export function labelOf                  (options                          , value        )         {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * A cell as typed, read back to a value: the value itself, or its label, in
 * any case, with the surrounding space trimmed. Undefined when it is neither;
 * the caller raises a finding and leaves the cell blank, never guesses.
 */
export function optionValue                  (options                          , raw        )                {
  const t = raw.trim().toLowerCase();
  if (t === '') return undefined;
  return (options.find((o) => o.value.toLowerCase() === t) ?? options.find((o) => o.label.toLowerCase() === t))?.value;
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

/** In the order the planner shows them. `PLATFORMS` in platforms.ts keeps its own order. */
export const PLATFORM_VALUES = all          ()(['aws', 'azure', 'google', 'oci', 'vmware']);
export const PLATFORM_LABELS                                     = {
  aws: 'AWS',
  azure: 'Azure',
  google: 'Google Cloud (GCP)',
  oci: 'OCI',
  vmware: 'VMware / VCF (private cloud)',
};
export const PLATFORM_OPTIONS = table(PLATFORM_VALUES, PLATFORM_LABELS);
export const HYPERSCALER_VALUES = Object.freeze(['aws', 'azure', 'google', 'oci']         );

/** Name-prefix suffix per platform: `slug(plan name)-{suffix}`. */
export const PLATFORM_PREFIX                                     = { aws: 'aws', azure: 'az', google: 'gcp', oci: 'oci', vmware: 'vcf' };

export const MIGRATION_CLOUD_VALUES = all                ()(['aws', 'azure', 'gcp', 'oci']);

// ---------------------------------------------------------------------------
// Operating systems
// ---------------------------------------------------------------------------

export const OS_VALUES = all      ()([
  'win-2008r2', 'win-2012', 'win-2012r2', 'win-2016', 'win-2019', 'win-2022', 'win-2025',
  'rhel-6', 'rhel-7', 'rhel-8', 'rhel-9', 'rhel-10',
  'centos-6', 'centos-7', 'centos-8', 'centos-stream-9', 'centos-stream-10',
  'rocky-8', 'rocky-9', 'rocky-10', 'alma-8', 'alma-9', 'alma-10',
  'ol-6', 'ol-7', 'ol-8', 'ol-9', 'ol-10',
  'sles-11', 'sles-12', 'sles-15', 'sles-16',
  'ubuntu-16.04', 'ubuntu-18.04', 'ubuntu-20.04', 'ubuntu-22.04', 'ubuntu-24.04',
  'debian-9', 'debian-10', 'debian-11', 'debian-12', 'debian-13',
  'linux-other', 'windows-client', 'other', 'unknown',
]);
export const OS_LABELS                                 = {
  'win-2008r2': 'Windows Server 2008 R2',
  'win-2012': 'Windows Server 2012',
  'win-2012r2': 'Windows Server 2012 R2',
  'win-2016': 'Windows Server 2016',
  'win-2019': 'Windows Server 2019',
  'win-2022': 'Windows Server 2022',
  'win-2025': 'Windows Server 2025',
  'rhel-6': 'Red Hat Enterprise Linux 6',
  'rhel-7': 'Red Hat Enterprise Linux 7',
  'rhel-8': 'Red Hat Enterprise Linux 8',
  'rhel-9': 'Red Hat Enterprise Linux 9',
  'rhel-10': 'Red Hat Enterprise Linux 10',
  'centos-6': 'CentOS 6',
  'centos-7': 'CentOS 7',
  'centos-8': 'CentOS 8',
  'centos-stream-9': 'CentOS Stream 9',
  'centos-stream-10': 'CentOS Stream 10',
  'rocky-8': 'Rocky Linux 8',
  'rocky-9': 'Rocky Linux 9',
  'rocky-10': 'Rocky Linux 10',
  'alma-8': 'AlmaLinux 8',
  'alma-9': 'AlmaLinux 9',
  'alma-10': 'AlmaLinux 10',
  'ol-6': 'Oracle Linux 6',
  'ol-7': 'Oracle Linux 7',
  'ol-8': 'Oracle Linux 8',
  'ol-9': 'Oracle Linux 9',
  'ol-10': 'Oracle Linux 10',
  'sles-11': 'SUSE Linux Enterprise Server 11',
  'sles-12': 'SUSE Linux Enterprise Server 12',
  'sles-15': 'SUSE Linux Enterprise Server 15',
  'sles-16': 'SUSE Linux Enterprise Server 16',
  'ubuntu-16.04': 'Ubuntu 16.04 LTS',
  'ubuntu-18.04': 'Ubuntu 18.04 LTS',
  'ubuntu-20.04': 'Ubuntu 20.04 LTS',
  'ubuntu-22.04': 'Ubuntu 22.04 LTS',
  'ubuntu-24.04': 'Ubuntu 24.04 LTS',
  'debian-9': 'Debian 9',
  'debian-10': 'Debian 10',
  'debian-11': 'Debian 11',
  'debian-12': 'Debian 12',
  'debian-13': 'Debian 13',
  'linux-other': 'Other Linux',
  'windows-client': 'Windows (client)',
  other: 'Other',
  unknown: 'Unknown',
};
export function osGroup(id      )         {
  if (id.startsWith('win-')) return 'Windows Server';
  if (/^(rhel|centos|rocky|alma|ol)-/.test(id)) return 'RHEL family';
  if (id.startsWith('sles-')) return 'SUSE';
  if (/^(ubuntu|debian)-/.test(id)) return 'Debian family';
  return 'Other';
}
export const OS_OPTIONS = table(OS_VALUES, OS_LABELS, osGroup);
export const OS_FAMILY_VALUES = all          ()(['windows', 'rhel', 'suse', 'debian', 'other']);
export const OS_KIND_VALUES = all        ()(['windows', 'linux', 'other']);

// ---------------------------------------------------------------------------
// Workloads (Screen 2)
// ---------------------------------------------------------------------------

export const ITEM_KIND_VALUES = all          ()(['workload', 'database', 'app']);

export const ENV_VALUES = all     ()(['prod', 'preprod', 'test', 'dev', 'dr']);
export const ENV_OPTIONS = table(ENV_VALUES, {
  prod: 'Production',
  preprod: 'Pre-production',
  test: 'Test',
  dev: 'Development',
  dr: 'Disaster recovery',
});

export const ROLE_VALUES = all      ()([
  'web', 'app', 'db', 'file', 'ad-dc', 'dns-dhcp', 'rds-vdi', 'middleware',
  'messaging', 'batch', 'monitoring', 'backup', 'jump', 'appliance', 'other',
]);
export const ROLE_OPTIONS = table(ROLE_VALUES, {
  web: 'Web',
  app: 'Application',
  db: 'Database',
  file: 'File server',
  'ad-dc': 'Active Directory domain controller',
  'dns-dhcp': 'DNS / DHCP',
  'rds-vdi': 'Remote Desktop / Citrix',
  middleware: 'Middleware',
  messaging: 'Messaging',
  batch: 'Batch',
  monitoring: 'Monitoring',
  backup: 'Backup',
  jump: 'Jump host',
  appliance: 'Appliance',
  other: 'Other',
});

export const CRITICALITY_VALUES = all             ()(['tier0', 'tier1', 'tier2', 'tier3']);
export const CRITICALITY_OPTIONS = table(CRITICALITY_VALUES, {
  tier0: 'Tier 0 mission-critical',
  tier1: 'Tier 1 business-critical',
  tier2: 'Tier 2 business-operational',
  tier3: 'Tier 3 administrative',
});

export const RPO_VALUES = all     ()(['0', '15m', '1h', '4h', '24h']);
export const RPO_OPTIONS = table(RPO_VALUES, { '0': 'Zero', '15m': '15 minutes', '1h': '1 hour', '4h': '4 hours', '24h': '24 hours' });

export const RTO_VALUES = all     ()(['15m', '1h', '4h', '24h', '72h']);
export const RTO_OPTIONS = table(RTO_VALUES, { '15m': '15 minutes', '1h': '1 hour', '4h': '4 hours', '24h': '24 hours', '72h': '72 hours' });

/** The defaults the Workloads grid derives from criticality. */
export const RPO_BY_CRITICALITY                                     = { tier0: '0', tier1: '15m', tier2: '4h', tier3: '24h' };
export const RTO_BY_CRITICALITY                                     = { tier0: '15m', tier1: '1h', tier2: '4h', tier3: '24h' };
/** Screen 5, "Tier by criticality": fixed. */
export const BACKUP_TIER_BY_CRITICALITY                                              = {
  tier0: 'gold',
  tier1: 'gold',
  tier2: 'silver',
  tier3: 'bronze',
};

export const OS_LICENCE_VALUES = all           ()(['li', 'byol-sa', 'byol-perpetual', 'rhel-byos', 'sles-byos', 'free']);
export const OS_LICENCE_OPTIONS = table(OS_LICENCE_VALUES, {
  li: 'Licence included / pay-as-you-go',
  'byol-sa': 'BYOL with Software Assurance or subscription',
  'byol-perpetual': 'BYOL perpetual, no SA',
  'rhel-byos': 'RHEL Cloud Access / BYOS',
  'sles-byos': 'SLES BYOS',
  free: 'Community Linux (no licence)',
});

export const RESIDENCY_VALUES = all           ()([
  'any', 'eu', 'uk', 'us', 'ca', 'de', 'fr', 'ch', 'nl', 'se', 'au', 'nz', 'jp', 'kr', 'in', 'sg', 'ae', 'sa', 'br', 'za',
]);
export const RESIDENCY_OPTIONS = table(RESIDENCY_VALUES, {
  any: 'Any',
  eu: 'European Union',
  uk: 'United Kingdom',
  us: 'United States',
  ca: 'Canada',
  de: 'Germany',
  fr: 'France',
  ch: 'Switzerland',
  nl: 'Netherlands',
  se: 'Sweden',
  au: 'Australia',
  nz: 'New Zealand',
  jp: 'Japan',
  kr: 'South Korea',
  in: 'India',
  sg: 'Singapore',
  ae: 'United Arab Emirates',
  sa: 'Saudi Arabia',
  br: 'Brazil',
  za: 'South Africa',
});

export const DISPOSITION_VALUES = all             ()(['rehost', 'relocate', 'replatform', 'refactor', 'repurchase', 'retire', 'retain', 'new']);
export const DISPOSITION_OPTIONS = table(DISPOSITION_VALUES, {
  rehost: 'Rehost (lift and shift)',
  relocate: 'Relocate (VMware to VMware)',
  replatform: 'Replatform',
  refactor: 'Refactor',
  repurchase: 'Repurchase (SaaS)',
  retire: 'Retire',
  retain: 'Retain on premises',
  new: 'New (greenfield: nothing moves)',
});

export const METHOD_VALUES = all        ()(['replicate', 'rebuild', 'relocate-hcx', 'managed-db', 'none']);
export const METHOD_OPTIONS = table(METHOD_VALUES, {
  replicate: 'Replicate (AWS MGN / Azure Migrate / Migrate to Virtual Machines / OCI Cloud Migrations)',
  rebuild: 'Rebuild from image, configure, copy data',
  'relocate-hcx': 'Relocate with HCX / vMotion',
  'managed-db': 'Move the database to a managed service',
  none: 'No move',
});

export const POWER_STATE_VALUES = all            ()(['poweredOn', 'poweredOff', 'suspended', 'unknown']);
export const READINESS_SEVERITY_VALUES = all                   ()(['blocker', 'caution', 'note']);

// ---------------------------------------------------------------------------
// Databases (Screen 3)
// ---------------------------------------------------------------------------

export const DB_ENGINE_VALUES = all          ()([
  'oracle', 'sqlserver', 'postgres', 'mysql', 'mariadb', 'db2', 'mongodb', 'sybase-ase',
  'informix', 'sap-hana', 'redis', 'cassandra', 'elasticsearch', 'other',
]);
export const DB_ENGINE_OPTIONS = table(DB_ENGINE_VALUES, {
  oracle: 'Oracle Database',
  sqlserver: 'Microsoft SQL Server',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  db2: 'IBM Db2',
  mongodb: 'MongoDB',
  'sybase-ase': 'SAP ASE (Sybase)',
  informix: 'IBM Informix',
  'sap-hana': 'SAP HANA',
  redis: 'Redis / Valkey',
  cassandra: 'Apache Cassandra',
  elasticsearch: 'Elasticsearch / OpenSearch',
  other: 'Other',
});

export const DB_EDITION_VALUES = all           ()([
  'oracle-ee', 'oracle-se2', 'oracle-xe', 'sql-enterprise', 'sql-standard', 'sql-web', 'sql-express', 'sql-developer',
  'community', 'commercial',
]);
export const DB_EDITION_OPTIONS = table(
  DB_EDITION_VALUES,
  {
    'oracle-ee': 'Oracle Enterprise Edition',
    'oracle-se2': 'Oracle Standard Edition 2',
    'oracle-xe': 'Oracle Express Edition',
    'sql-enterprise': 'SQL Server Enterprise',
    'sql-standard': 'SQL Server Standard',
    'sql-web': 'SQL Server Web',
    'sql-express': 'SQL Server Express',
    'sql-developer': 'SQL Server Developer',
    community: 'Community / open source',
    commercial: 'Commercial (other engines’ paid editions)',
  },
  (v) => (v.startsWith('oracle-') ? 'Oracle' : v.startsWith('sql-') ? 'SQL Server' : 'Other engines'),
);
/**
 * Which editions belong to which engine: anything else is an `edition-mismatch` error.
 * `commercial` on Oracle or SQL Server means "paid, edition not yet confirmed": what
 * `dbFromVm` infers from a VM name. The rules treat it as the Enterprise edition,
 * the conservative licence position, until the user picks one.
 */
export const EDITIONS_BY_ENGINE                                                   = {
  oracle: ['oracle-ee', 'oracle-se2', 'oracle-xe', 'commercial'],
  sqlserver: ['sql-enterprise', 'sql-standard', 'sql-web', 'sql-express', 'sql-developer', 'commercial'],
  postgres: ['community', 'commercial'],
  mysql: ['community', 'commercial'],
  mariadb: ['community', 'commercial'],
  db2: ['community', 'commercial'],
  mongodb: ['community', 'commercial'],
  'sybase-ase': ['commercial'],
  informix: ['commercial'],
  'sap-hana': ['commercial'],
  redis: ['community', 'commercial'],
  cassandra: ['community', 'commercial'],
  elasticsearch: ['community', 'commercial'],
  other: ['community', 'commercial'],
};

export const DB_VERSION_VALUES = all             ()([
  'oracle-11.2', 'oracle-12.1', 'oracle-12.2', 'oracle-18c', 'oracle-19c', 'oracle-21c', 'oracle-26ai',
  'sql-2012', 'sql-2014', 'sql-2016', 'sql-2017', 'sql-2019', 'sql-2022', 'sql-2025',
  'pg-11', 'pg-12', 'pg-13', 'pg-14', 'pg-15', 'pg-16', 'pg-17', 'pg-18',
  'mysql-5.7', 'mysql-8.0', 'mysql-8.4',
  'mariadb-10.6', 'mariadb-10.11', 'mariadb-11.4',
  'other',
]);
export const DB_VERSION_OPTIONS = table(
  DB_VERSION_VALUES,
  {
    'oracle-11.2': 'Oracle 11g Release 2',
    'oracle-12.1': 'Oracle 12c Release 1',
    'oracle-12.2': 'Oracle 12c Release 2',
    'oracle-18c': 'Oracle 18c',
    'oracle-19c': 'Oracle 19c',
    'oracle-21c': 'Oracle 21c',
    'oracle-26ai': 'Oracle AI Database 26ai (was 23ai)',
    'sql-2012': 'SQL Server 2012',
    'sql-2014': 'SQL Server 2014',
    'sql-2016': 'SQL Server 2016',
    'sql-2017': 'SQL Server 2017',
    'sql-2019': 'SQL Server 2019',
    'sql-2022': 'SQL Server 2022',
    'sql-2025': 'SQL Server 2025',
    'pg-11': 'PostgreSQL 11',
    'pg-12': 'PostgreSQL 12',
    'pg-13': 'PostgreSQL 13',
    'pg-14': 'PostgreSQL 14',
    'pg-15': 'PostgreSQL 15',
    'pg-16': 'PostgreSQL 16',
    'pg-17': 'PostgreSQL 17',
    'pg-18': 'PostgreSQL 18',
    'mysql-5.7': 'MySQL 5.7',
    'mysql-8.0': 'MySQL 8.0',
    'mysql-8.4': 'MySQL 8.4 LTS',
    'mariadb-10.6': 'MariaDB 10.6',
    'mariadb-10.11': 'MariaDB 10.11',
    'mariadb-11.4': 'MariaDB 11.4',
    other: 'Other',
  },
  (v) =>
    v.startsWith('oracle-') ? 'Oracle' : v.startsWith('sql-') ? 'SQL Server' : v.startsWith('pg-') ? 'PostgreSQL'
      : v.startsWith('mysql-') ? 'MySQL' : v.startsWith('mariadb-') ? 'MariaDB' : 'Other',
);
/** The versions that belong to an engine (`other` belongs to every engine). */
export function versionsFor(engine          )                         {
  const prefix                                    = { oracle: 'oracle-', sqlserver: 'sql-', postgres: 'pg-', mysql: 'mysql-', mariadb: 'mariadb-' };
  const p = prefix[engine];
  return DB_VERSION_VALUES.filter((v) => v === 'other' || (p !== undefined && v.startsWith(p)));
}

export const DB_HA_VALUES = all      ()([
  'none', 'rac', 'rac-one-node', 'data-guard-local', 'sql-ag', 'sql-fci', 'sql-mirroring', 'log-shipping',
  'pg-streaming', 'mysql-group-replication', 'other-cluster',
]);
export const DB_HA_OPTIONS = table(DB_HA_VALUES, {
  none: 'None (single instance)',
  rac: 'Oracle RAC',
  'rac-one-node': 'Oracle RAC One Node',
  'data-guard-local': 'Oracle Data Guard (local standby)',
  'sql-ag': 'SQL Server Always On availability group',
  'sql-fci': 'SQL Server failover cluster instance',
  'sql-mirroring': 'SQL Server database mirroring',
  'log-shipping': 'Log shipping',
  'pg-streaming': 'PostgreSQL streaming replication',
  'mysql-group-replication': 'MySQL group replication',
  'other-cluster': 'Other cluster',
});

export const DB_DR_VALUES = all      ()([
  'none', 'data-guard-remote', 'active-data-guard', 'sql-ag-async', 'log-shipping', 'backup-restore', 'storage-replication', 'goldengate',
]);
export const DB_DR_OPTIONS = table(DB_DR_VALUES, {
  none: 'None',
  'data-guard-remote': 'Oracle Data Guard (remote standby)',
  'active-data-guard': 'Oracle Active Data Guard',
  'sql-ag-async': 'SQL Server AG, asynchronous replica',
  'log-shipping': 'Log shipping',
  'backup-restore': 'Backup and restore',
  'storage-replication': 'Storage replication',
  goldengate: 'Oracle GoldenGate',
});

export const DB_FEATURE_VALUES = all           ()([
  'ssis', 'ssrs', 'ssas', 'clr-unsafe', 'linked-servers', 'cross-db-queries', 'agent-jobs', 'filestream', 'dtc',
  'service-broker', 'partitioning', 'advanced-security', 'diagnostics-pack', 'tuning-pack', 'in-memory', 'apex', 'ords', 'spatial',
]);
export const DB_FEATURE_OPTIONS = table(
  DB_FEATURE_VALUES,
  {
    ssis: 'SQL Server Integration Services',
    ssrs: 'SQL Server Reporting Services',
    ssas: 'SQL Server Analysis Services',
    'clr-unsafe': 'CLR assemblies (UNSAFE / EXTERNAL_ACCESS)',
    'linked-servers': 'Linked servers',
    'cross-db-queries': 'Cross-database queries',
    'agent-jobs': 'SQL Server Agent jobs',
    filestream: 'FILESTREAM / FileTable',
    dtc: 'Distributed transactions (DTC)',
    'service-broker': 'Service Broker',
    partitioning: 'Oracle Partitioning',
    'advanced-security': 'Oracle Advanced Security (TDE)',
    'diagnostics-pack': 'Oracle Diagnostics Pack',
    'tuning-pack': 'Oracle Tuning Pack',
    'in-memory': 'In-Memory',
    apex: 'Oracle APEX',
    ords: 'Oracle REST Data Services',
    spatial: 'Spatial',
  },
  (v) => (['partitioning', 'advanced-security', 'diagnostics-pack', 'tuning-pack', 'apex', 'ords'].includes(v) ? 'Oracle'
    : ['in-memory', 'spatial'].includes(v) ? 'Either' : 'SQL Server'),
);

export const DB_LICENCE_VALUES = all           ()([
  'li', 'byol-sa', 'byol-perpetual', 'oracle-processor', 'oracle-nup', 'oracle-ula', 'community', 'commercial-other',
]);
export const DB_LICENCE_OPTIONS = table(DB_LICENCE_VALUES, {
  li: 'Licence included',
  'byol-sa': 'SQL Server with SA / subscription (Licence Mobility)',
  'byol-perpetual': 'SQL Server without SA',
  'oracle-processor': 'Oracle BYOL (Processor)',
  'oracle-nup': 'Oracle BYOL (Named User Plus)',
  'oracle-ula': 'Oracle ULA',
  community: 'Open source',
  'commercial-other': 'Other commercial licence',
});

export const DB_SERVICE_VALUES = all             ()([
  'aws-rds', 'aws-rds-custom', 'aws-aurora', 'aws-ec2', 'aws-odb-exadata', 'aws-odb-adb',
  'azure-sqldb', 'azure-sqlmi', 'azure-sqlvm', 'azure-pg-flex', 'azure-mysql-flex', 'azure-vm', 'azure-odb-exadata', 'azure-odb-adb',
  'google-cloudsql', 'google-alloydb', 'google-gce', 'google-odb-exadata', 'google-odb-adb', 'google-odb-basedb',
  'oci-adb', 'oci-basedb', 'oci-exacs', 'oci-mysql-heatwave', 'oci-pg', 'oci-compute',
  'vmware-vm',
  // Databases beyond the core (A.4.9); catalogue rows from db-catalog-extra.ts (WP-16).
  'aws-rds-db2', 'aws-docdb', 'aws-elasticache', 'aws-memorydb', 'aws-keyspaces', 'aws-opensearch',
  'azure-documentdb', 'azure-managed-redis', 'azure-cassandra-mi',
  'google-memorystore', 'oci-cache', 'oci-opensearch', 'oci-adb-mongo',
]);
export const DB_SERVICE_LABELS                                        = {
  'aws-rds': 'Amazon RDS',
  'aws-rds-custom': 'Amazon RDS Custom',
  'aws-aurora': 'Amazon Aurora',
  'aws-ec2': 'Amazon EC2 (self-managed)',
  'aws-odb-exadata': 'Oracle Database@AWS, Exadata',
  'aws-odb-adb': 'Oracle Database@AWS, Autonomous Database',
  'azure-sqldb': 'Azure SQL Database',
  'azure-sqlmi': 'Azure SQL Managed Instance',
  'azure-sqlvm': 'SQL Server on Azure Virtual Machines',
  'azure-pg-flex': 'Azure Database for PostgreSQL flexible server',
  'azure-mysql-flex': 'Azure Database for MySQL flexible server',
  'azure-vm': 'Azure Virtual Machine (self-managed)',
  'azure-odb-exadata': 'Oracle Database@Azure, Exadata',
  'azure-odb-adb': 'Oracle Database@Azure, Autonomous Database',
  'google-cloudsql': 'Cloud SQL',
  'google-alloydb': 'AlloyDB for PostgreSQL',
  'google-gce': 'Compute Engine (self-managed)',
  'google-odb-exadata': 'Oracle Database@Google Cloud, Exadata',
  'google-odb-adb': 'Oracle Database@Google Cloud, Autonomous Database',
  'google-odb-basedb': 'Oracle Database@Google Cloud, Base Database',
  'oci-adb': 'OCI Autonomous Database',
  'oci-basedb': 'OCI Base Database Service',
  'oci-exacs': 'OCI Exadata Database Service',
  'oci-mysql-heatwave': 'OCI HeatWave MySQL',
  'oci-pg': 'OCI Database with PostgreSQL',
  'oci-compute': 'OCI Compute (self-managed)',
  'vmware-vm': 'vSphere VM (self-managed)',
  'aws-rds-db2': 'Amazon RDS for Db2',
  'aws-docdb': 'Amazon DocumentDB',
  'aws-elasticache': 'Amazon ElastiCache',
  'aws-memorydb': 'Amazon MemoryDB',
  'aws-keyspaces': 'Amazon Keyspaces (for Apache Cassandra)',
  'aws-opensearch': 'Amazon OpenSearch Service',
  'azure-documentdb': 'Azure DocumentDB (with MongoDB compatibility)',
  'azure-managed-redis': 'Azure Managed Redis',
  'azure-cassandra-mi': 'Azure Managed Instance for Apache Cassandra',
  'google-memorystore': 'Memorystore',
  'oci-cache': 'OCI Cache',
  'oci-opensearch': 'OCI Search with OpenSearch',
  'oci-adb-mongo': 'OCI Autonomous Database (MongoDB API)',
};
/** The platform a service runs on, from its id. */
export function platformOfService(service             )           {
  return service.slice(0, service.indexOf('-'))            ;
}
export const DB_SERVICE_OPTIONS = table(DB_SERVICE_VALUES, DB_SERVICE_LABELS, (v) => PLATFORM_LABELS[platformOfService(v)]);

// ---------------------------------------------------------------------------
// Apps and dependencies (Screen 4)
// ---------------------------------------------------------------------------

export const SPECIAL_VALUES = all         ()(['none', 'gpu', 'large-memory', 'physical-dongle', 'mainframe-link', 'ot-network']);
export const SPECIAL_OPTIONS = table(SPECIAL_VALUES, {
  none: 'None',
  gpu: 'GPU',
  'large-memory': 'Large memory',
  'physical-dongle': 'Physical dongle / hardware key',
  'mainframe-link': 'Mainframe link',
  'ot-network': 'OT / plant network',
});

export const LATENCY_VALUES = all         ()(['critical', 'sensitive', 'tolerant']);
export const LATENCY_OPTIONS = table(LATENCY_VALUES, {
  critical: 'Critical: must stay near on-premises systems',
  sensitive: 'Sensitive: needs a private circuit',
  tolerant: 'Tolerant',
});

export const EDGE_KIND_VALUES = all          ()(['sync', 'async']);
export const EDGE_KIND_OPTIONS = table(EDGE_KIND_VALUES, { sync: 'Synchronous', async: 'Asynchronous' });

/** The Apps grid's Wave column: blank (planned) or a pinned wave. */
export const WAVE_PIN_VALUES = Object.freeze(['wave-0', 'wave-1', 'wave-2', 'wave-3', 'wave-4', 'wave-5', 'wave-6', 'wave-7', 'wave-8', 'wave-9']         );
                                                       
export const WAVE_PIN_OPTIONS                                 = Object.freeze(
  WAVE_PIN_VALUES.map((value, n) => Object.freeze({ value, label: n === 0 ? 'Wave 0 (foundations)' : `Wave ${n}` })),
);
export function waveFromPin(pin        )                     {
  const m = /^(?:wave-)?([0-9])$/i.exec(pin.trim());
  return m ? Number(m[1]) : undefined;
}
export function pinForWave(n        )                      {
  return Number.isInteger(n) && n >= 0 && n <= 9 ? (`wave-${n}`           ) : undefined;
}

export const PORTFOLIO_RISK_VALUES = all               ()(['Low', 'Medium', 'High']);

// ---------------------------------------------------------------------------
// Requirements (Screen 5)
// ---------------------------------------------------------------------------

export const MAX_PLATFORMS_VALUES = all                   ()(['1', '2', '3', '4', '5']);
export const MAX_PLATFORMS_OPTIONS = table(MAX_PLATFORMS_VALUES, { '1': '1', '2': '2', '3': '3', '4': '4', '5': '5' });

export const FRAMEWORK_VALUES = all           ()([
  'pci-dss-4', 'hipaa', 'soc2', 'iso27001', 'gdpr', 'uk-gdpr', 'fedramp-moderate', 'fedramp-high',
  'dod-il2', 'dod-il4', 'dod-il5', 'cjis', 'irap-protected', 'bsi-c5', 'ens-high', 'nis2', 'dora',
]);
export const FRAMEWORK_OPTIONS = table(FRAMEWORK_VALUES, {
  'pci-dss-4': 'PCI DSS 4.0',
  hipaa: 'HIPAA',
  soc2: 'SOC 2',
  iso27001: 'ISO 27001',
  gdpr: 'GDPR',
  'uk-gdpr': 'UK GDPR',
  'fedramp-moderate': 'FedRAMP Moderate',
  'fedramp-high': 'FedRAMP High',
  'dod-il2': 'DoD IL2',
  'dod-il4': 'DoD IL4',
  'dod-il5': 'DoD IL5',
  cjis: 'CJIS',
  'irap-protected': 'IRAP PROTECTED',
  'bsi-c5': 'BSI C5',
  'ens-high': 'ENS High',
  nis2: 'NIS2',
  dora: 'DORA',
});

export const SOVEREIGNTY_VALUES = all             ()(['none', 'sovereign-region', 'government-region', 'dedicated', 'air-gapped']);
export const SOVEREIGNTY_OPTIONS = table(SOVEREIGNTY_VALUES, {
  none: 'None',
  'sovereign-region': 'Sovereign region (AWS European Sovereign Cloud / Azure sovereign / Google Cloud sovereign / OCI EU Sovereign Cloud)',
  'government-region': 'Government region (AWS GovCloud / Azure Government / Assured Workloads / OCI US Government)',
  dedicated: 'Dedicated (OCI Dedicated Region / Azure Local / AWS Outposts / Google Distributed Cloud)',
  'air-gapped': 'Air-gapped',
});

export const SECURITY_BASELINE_VALUES = all                  ()(['cis-l1', 'cis-l2', 'stig', 'internal']);
export const SECURITY_BASELINE_OPTIONS = table(SECURITY_BASELINE_VALUES, {
  'cis-l1': 'CIS Level 1',
  'cis-l2': 'CIS Level 2',
  stig: 'DISA STIG',
  internal: 'Internal standard',
});

export const KEY_MANAGEMENT_VALUES = all               ()(['provider-managed', 'customer-managed', 'hsm']);
export const KEY_MANAGEMENT_OPTIONS = table(KEY_MANAGEMENT_VALUES, {
  'provider-managed': 'Provider-managed keys',
  'customer-managed': 'Customer-managed keys (KMS / Key Vault / Cloud KMS / OCI Vault)',
  hsm: 'HSM-backed keys',
});

export const BANDWIDTH_VALUES = all           ()(['50m', '100m', '200m', '500m', '1g', '2g', '5g', '10g', '100g']);
export const BANDWIDTH_OPTIONS = table(BANDWIDTH_VALUES, {
  '50m': '50 Mbps',
  '100m': '100 Mbps',
  '200m': '200 Mbps',
  '500m': '500 Mbps',
  '1g': '1 Gbps',
  '2g': '2 Gbps',
  '5g': '5 Gbps',
  '10g': '10 Gbps',
  '100g': '100 Gbps',
});

export const CIRCUIT_VALUES = all         ()(['none', 'direct-connect', 'expressroute', 'interconnect-dedicated', 'interconnect-partner', 'fastconnect']);
export const CIRCUIT_OPTIONS = table(CIRCUIT_VALUES, {
  none: 'None',
  'direct-connect': 'AWS Direct Connect',
  expressroute: 'Azure ExpressRoute',
  'interconnect-dedicated': 'Google Cloud Dedicated Interconnect',
  'interconnect-partner': 'Google Cloud Partner Interconnect',
  fastconnect: 'OCI FastConnect',
});
/** The platform a private circuit reaches. */
export const CIRCUIT_PLATFORM                                                       = {
  'direct-connect': 'aws',
  expressroute: 'azure',
  'interconnect-dedicated': 'google',
  'interconnect-partner': 'google',
  fastconnect: 'oci',
};

export const CONNECTION_VALUES = all            ()(['vpn', 'circuit', 'circuit-with-vpn-backup']);
export const CONNECTION_OPTIONS = table(CONNECTION_VALUES, {
  vpn: 'VPN (IPsec + BGP)',
  circuit: 'Private circuit',
  'circuit-with-vpn-backup': 'Private circuit with VPN backup',
});

export const AD_STRATEGY_VALUES = all            ()(['extend-dcs', 'managed-ad', 'none']);
export const AD_STRATEGY_OPTIONS = table(AD_STRATEGY_VALUES, {
  'extend-dcs': 'New domain controllers in each cloud (promoted, never replicated)',
  'managed-ad': 'Managed AD (AWS Managed Microsoft AD / Microsoft Entra Domain Services / Managed Service for Microsoft AD; OCI has none)',
  none: 'None',
});

export const LINUX_JOIN_VALUES = all           ()(['realmd-sssd', 'no']);
export const LINUX_JOIN_OPTIONS = table(LINUX_JOIN_VALUES, { 'realmd-sssd': 'Yes, with realmd and SSSD', no: 'No' });

export const CLOUD_SIGN_IN_VALUES = all             ()(['entra-id', 'aws-iam-identity-center', 'google-cloud-identity', 'oci-identity-domains', 'existing-idp-saml']);
export const CLOUD_SIGN_IN_OPTIONS = table(CLOUD_SIGN_IN_VALUES, {
  'entra-id': 'Microsoft Entra ID',
  'aws-iam-identity-center': 'AWS IAM Identity Center',
  'google-cloud-identity': 'Google Cloud Identity',
  'oci-identity-domains': 'OCI IAM identity domains',
  'existing-idp-saml': 'Existing identity provider (SAML)',
});

export const DNS_STRATEGY_VALUES = all             ()(['forward-to-dcs', 'cloud-private-dns-with-conditional-forwarders']);
export const DNS_STRATEGY_OPTIONS = table(DNS_STRATEGY_VALUES, {
  'forward-to-dcs': 'Forward to the domain controllers',
  'cloud-private-dns-with-conditional-forwarders': 'Cloud private DNS with conditional forwarders',
});

export const BACKUP_TIER_VALUES = all              ()(['gold', 'silver', 'bronze']);
export const BACKUP_TIER_OPTIONS = table(BACKUP_TIER_VALUES, { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' });

export const BACKUP_FREQUENCY_VALUES = all                 ()(['1h', '4h', '12h', '24h']);
export const BACKUP_FREQUENCY_OPTIONS = table(BACKUP_FREQUENCY_VALUES, { '1h': 'Every hour', '4h': 'Every 4 hours', '12h': 'Every 12 hours', '24h': 'Daily' });

export const DR_PATTERN_VALUES = all           ()(['backup-restore', 'pilot-light', 'warm-standby', 'active-active']);
export const DR_PATTERN_OPTIONS = table(DR_PATTERN_VALUES, {
  'backup-restore': 'Backup and restore',
  'pilot-light': 'Pilot light',
  'warm-standby': 'Warm standby',
  'active-active': 'Active-active',
});

export const COST_MODEL_VALUES = all           ()(['payg', 'reserved-1y', 'reserved-3y', 'savings-plan-3y']);
export const COST_MODEL_OPTIONS = table(COST_MODEL_VALUES, {
  payg: 'Pay as you go',
  'reserved-1y': 'Reserved / committed use, 1 year',
  'reserved-3y': 'Reserved / committed use, 3 years',
  'savings-plan-3y': 'Savings plan, 3 years',
});

export const AGREEMENT_VALUES = all           ()(['edp', 'macc', 'google-commit', 'oci-uc', 'vcf-subscription', 'enterprise-agreement']);
export const AGREEMENT_OPTIONS = table(AGREEMENT_VALUES, {
  edp: 'AWS EDP / PPA',
  macc: 'Azure MACC',
  'google-commit': 'Google Cloud commit',
  'oci-uc': 'OCI Universal Credits',
  'vcf-subscription': 'Broadcom VCF subscription',
  'enterprise-agreement': 'Microsoft Enterprise Agreement',
});
/** The platform an agreement is with; the EA is Microsoft licensing, counted towards Azure. */
export const AGREEMENT_PLATFORM                                        = {
  edp: 'aws',
  macc: 'azure',
  'google-commit': 'google',
  'oci-uc': 'oci',
  'vcf-subscription': 'vmware',
  'enterprise-agreement': 'azure',
};

export const MICROSOFT_SA_VALUES = all             ()(['yes-all', 'yes-some', 'no']);
export const MICROSOFT_SA_OPTIONS = table(MICROSOFT_SA_VALUES, { 'yes-all': 'Yes, on all licences', 'yes-some': 'Yes, on some', no: 'No' });

export const ORACLE_LICENCES_VALUES = all                ()(['processor', 'nup', 'ula', 'none']);
export const ORACLE_LICENCES_OPTIONS = table(ORACLE_LICENCES_VALUES, {
  processor: 'Processor licences',
  nup: 'Named User Plus',
  ula: 'Unlimited License Agreement (ULA)',
  none: 'None',
});

export const YES_NO_VALUES = all       ()(['yes', 'no']);
export const YES_NO_OPTIONS = table(YES_NO_VALUES, { yes: 'Yes', no: 'No' });
export const yesNo = (b         )        => (b ? 'yes' : 'no');

export const SKILL_VALUES = all       ()(['none', 'some', 'strong']);
export const SKILL_OPTIONS = table(SKILL_VALUES, { none: 'None', some: 'Some', strong: 'Strong' });

export const EXIT_STRATEGY_VALUES = all              ()(['portable-first', 'balanced', 'managed-first']);
export const EXIT_STRATEGY_OPTIONS = table(EXIT_STRATEGY_VALUES, {
  'portable-first': 'Portable first (prefers IaaS and open engines)',
  balanced: 'Balanced',
  'managed-first': 'Managed services first',
});

export const SIZE_BY_VALUES = all        ()(['allocated', 'active-memory']);
export const SIZE_BY_OPTIONS = table(SIZE_BY_VALUES, { allocated: 'Allocated', 'active-memory': 'Active memory + 20% headroom' });

export const MONITORING_VALUES = all            ()(['cloud-native', 'vcf-operations', 'both']);
export const MONITORING_OPTIONS = table(MONITORING_VALUES, { 'cloud-native': 'Cloud-native', 'vcf-operations': 'VCF Operations', both: 'Both' });

export const SIEM_VALUES = all      ()(['none', 'splunk', 'sentinel', 'google-secops', 'qradar']);
export const SIEM_OPTIONS = table(SIEM_VALUES, {
  none: 'None',
  splunk: 'Splunk',
  sentinel: 'Microsoft Sentinel',
  'google-secops': 'Google Security Operations',
  qradar: 'IBM QRadar',
});

// ---------------------------------------------------------------------------
// Target design (Screen 7)
// ---------------------------------------------------------------------------

export const NETWORK_TIER_VALUES = all             ()(['web', 'app', 'db', 'mgmt']);
export const NETWORK_TIER_OPTIONS = table(NETWORK_TIER_VALUES, { web: 'Web', app: 'Application', db: 'Database', mgmt: 'Management' });

export const SUBNET_PREFIX_VALUES = all              ()(['/20', '/21', '/22', '/23', '/24']);
export const SUBNET_PREFIX_OPTIONS = table(SUBNET_PREFIX_VALUES, { '/20': '/20', '/21': '/21', '/22': '/22', '/23': '/23', '/24': '/24' });

export const ZONE_COUNT_VALUES = all                ()(['1', '2', '3']);
export const ZONE_COUNT_OPTIONS = table(ZONE_COUNT_VALUES, { '1': '1 zone', '2': '2 zones', '3': '3 zones' });

export const BASTION_VALUES = all         ()(['cloud-native', 'jump-vm', 'none']);
export const BASTION_OPTIONS = table(BASTION_VALUES, {
  'cloud-native': 'Cloud-native (SSM Session Manager / Azure Bastion / IAP / OCI Bastion)',
  'jump-vm': 'Jump VM',
  none: 'None',
});

export const LOG_RETENTION_VALUES = all                       ()(['90', '180', '365', '400', '730', '2555']);
export const LOG_RETENTION_OPTIONS = table(LOG_RETENTION_VALUES, {
  '90': '90 days',
  '180': '180 days',
  '365': '1 year',
  '400': '400 days',
  '730': '2 years',
  '2555': '7 years',
});

export const IMAGE_KIND_VALUES = all           ()(['aws-ssm', 'aws-ami-filter', 'azure-marketplace', 'gcp-family', 'oci-platform', 'vsphere-template', 'replicated', 'custom']);

/** The first octet pair of each platform's networks: prod `10.{n}.0.0/16`, nonprod `10.{n+1}.0.0/16`. */
export const NETWORK_BASE                                     = { aws: 10, azure: 20, google: 30, oci: 40, vmware: 50 };

/**
 * The cloud side's BGP ASN. Azure's 65515 is fixed by Azure. OCI's 31898 is
 * Oracle's ASN for the commercial cloud (Oracle FastConnect docs, checked
 * 2026-09-26; Serbia Central uses 14544 and government realms differ).
 * The others are private ASNs this planner picks and the user can change.
 */
export const CLOUD_ASN                                     = { aws: 64512, azure: 65515, google: 64514, oci: 31898, vmware: 65000 };

/** Keys the design screen writes into `Plan.designOverrides`. `scope` is a platform or `compute`/`db`. */
export function overrideKey(scope        , id        , field        )         {
  return `${scope}:${id}:${field}`;
}
/** The landing-zone card's fields, as `overrideKey(platform, 'lz', field)`. */
export const LANDING_ZONE_FIELDS = Object.freeze(['prefix', 'scope', 'subnet-size', 'zones-prod', 'zones-nonprod', 'bastion', 'log-retention']         );

// ---------------------------------------------------------------------------
// Waves (Screen 8)
// ---------------------------------------------------------------------------

export const WAVE_MODE_VALUES = all          ()(['default', 'fast', 'modernize']);
export const WAVE_MODE_OPTIONS = table(WAVE_MODE_VALUES, { default: 'Default', fast: 'Fast', modernize: 'Modernize' });

export const WAVE_PARALLEL_VALUES = all                   ()(['1', '2', '3']);
export const WAVE_PARALLEL_OPTIONS = table(WAVE_PARALLEL_VALUES, { '1': 'One at a time', '2': 'Two in parallel', '3': 'Three in parallel' });

export const WAVE_WEEKS_VALUES = all                ()(['1', '2', '3', '4']);
export const WAVE_WEEKS_OPTIONS = table(WAVE_WEEKS_VALUES, { '1': '1 week', '2': '2 weeks', '3': '3 weeks', '4': '4 weeks' });

// ---------------------------------------------------------------------------
// Sources (Screen 1) and Generate (Screen 9)
// ---------------------------------------------------------------------------

export const MERGE_MODE_VALUES = all           ()(['replace', 'merge']);
export const MERGE_MODE_OPTIONS = table(MERGE_MODE_VALUES, { replace: 'Replace rows', merge: 'Add new rows, keep edited ones' });

export const APP_ATTRIBUTE_SOURCE_VALUES = all                    ()(['folder-leaf', 'vapp']);
export const APP_ATTRIBUTE_SOURCE_OPTIONS = table(APP_ATTRIBUTE_SOURCE_VALUES, { 'folder-leaf': 'Folder leaf', vapp: 'vApp' });
export const ENV_ATTRIBUTE_SOURCE_VALUES = all                    ()(['name-pattern']);
export const ENV_ATTRIBUTE_SOURCE_OPTIONS = table(ENV_ATTRIBUTE_SOURCE_VALUES, { 'name-pattern': 'Name pattern' });

export const GENERATE_PART_VALUES = all              ()(['terraform', 'ansible', 'waves', 'bom', 'record']);
export const GENERATE_PART_OPTIONS = table(GENERATE_PART_VALUES, {
  terraform: 'Terraform (per platform)',
  ansible: 'Ansible',
  waves: 'Waves & runbooks',
  bom: 'Bill of materials',
  record: 'Decision record',
});

export const STATE_BACKEND_VALUES = all              ()(['platform', 'local', 's3', 'azurerm', 'gcs', 'oci']);
export const STATE_BACKEND_OPTIONS = table(STATE_BACKEND_VALUES, {
  platform: 'Each platform’s own',
  local: 'Local',
  s3: 'Amazon S3',
  azurerm: 'Azure Storage',
  gcs: 'Google Cloud Storage',
  oci: 'OCI Object Storage',
});

export const ARCHIVE_FORMAT_VALUES = all               ()(['zip', 'tar.gz']);
export const ARCHIVE_FORMAT_OPTIONS = table(ARCHIVE_FORMAT_VALUES, { zip: 'zip', 'tar.gz': 'tar.gz' });

// ---------------------------------------------------------------------------
// Licences (decision, BOM)
// ---------------------------------------------------------------------------

export const LICENCE_KIND_VALUES = all             ()(['oracle-processor', 'oracle-se2-socket', 'windows-core', 'sql-core', 'rhel', 'sles', 'none']);
export const LICENCE_KIND_OPTIONS = table(LICENCE_KIND_VALUES, {
  'oracle-processor': 'Oracle processor licences',
  'oracle-se2-socket': 'Oracle SE2 sockets',
  'windows-core': 'Windows Server core licences',
  'sql-core': 'SQL Server core licences',
  rhel: 'RHEL subscriptions',
  sles: 'SLES subscriptions',
  none: 'None',
});

export const LICENCE_MODEL_VALUES = all              ()(['li', 'byol', 'ahb', 'dedicated-host', 'fvb', 'licence-mobility', 'n/a']);
export const LICENCE_MODEL_OPTIONS = table(LICENCE_MODEL_VALUES, {
  li: 'Licence included',
  byol: 'Bring your own licence',
  ahb: 'Azure Hybrid Benefit',
  'dedicated-host': 'Dedicated host / sole-tenant node',
  fvb: 'Flexible Virtualization Benefit',
  'licence-mobility': 'Licence Mobility through SA',
  'n/a': 'Not applicable',
});

// ---------------------------------------------------------------------------
// Addendum A.11: modes, sources, types and patterns
// ---------------------------------------------------------------------------

export const PLAN_MODE_VALUES = all          ()(['dc-exit', 'migrate', 'single', 'new']);
export const PLAN_MODE_OPTIONS = table(PLAN_MODE_VALUES, {
  'dc-exit': 'Data-centre exit',
  migrate: 'Migrate applications',
  single: 'One application or service',
  new: 'New services only (nothing moves)',
});

export const APP_ORIGIN_VALUES = all           ()(['migrate', 'new']);
export const APP_ORIGIN_OPTIONS = table(APP_ORIGIN_VALUES, { migrate: 'Migrating', new: 'New (greenfield)' });

export const SOURCE_PLATFORM_VALUES = all                ()([
  'vsphere', 'hyperv', 'ahv', 'kvm', 'proxmox', 'ovirt', 'xen', 'physical',
  'aws', 'azure', 'google', 'oci', 'power', 'sparc', 'itanium', 'pa-risc', 'mainframe', 'other',
]);
export const SOURCE_PLATFORM_OPTIONS = table(
  SOURCE_PLATFORM_VALUES,
  {
    vsphere: 'VMware vSphere',
    hyperv: 'Microsoft Hyper-V',
    ahv: 'Nutanix AHV',
    kvm: 'KVM / libvirt',
    proxmox: 'Proxmox VE',
    ovirt: 'RHV / oVirt / Oracle Linux Virtualization Manager',
    xen: 'Xen / XCP-ng',
    physical: 'Physical x86 server',
    aws: 'AWS (EC2)',
    azure: 'Azure (virtual machines)',
    google: 'Google Cloud (GCP) (Compute Engine)',
    oci: 'OCI (Compute)',
    power: 'IBM Power (AIX / IBM i / Linux)',
    sparc: 'SPARC (Solaris)',
    itanium: 'Itanium (HP-UX / OpenVMS)',
    'pa-risc': 'PA-RISC (HP-UX)',
    mainframe: 'Mainframe',
    other: 'Other',
  },
  (v) => (['vsphere', 'hyperv', 'ahv', 'kvm', 'proxmox', 'ovirt', 'xen'].includes(v) ? 'Hypervisors'
    : v === 'physical' ? 'Physical' : ['aws', 'azure', 'google', 'oci'].includes(v) ? 'Clouds'
      : v === 'other' ? 'Other' : 'Non-x86 and mainframe'),
);

export const SIZING_BASIS_VALUES = all             ()(['allocated', 'utilisation', 'observed', 'load']);
export const SIZING_BASIS_OPTIONS = table(SIZING_BASIS_VALUES, {
  allocated: 'Allocated (as configured)',
  utilisation: 'Utilisation (percentile × headroom)',
  observed: 'Observed on the target',
  load: 'Load model (new service)',
});

export const IP_STRATEGY_VALUES = all            ()(['re-ip', 'keep-ip-l2-extension', 'keep-ip-cloud']);
export const IP_STRATEGY_OPTIONS = table(IP_STRATEGY_VALUES, {
  're-ip': 'New address on the target (re-IP)',
  'keep-ip-l2-extension': 'Keep the address (HCX network extension)',
  'keep-ip-cloud': 'Keep the address (same CIDR in the cloud)',
});

export const OS_UPGRADE_VALUES = all           ()(['none', 'before-move', 'during-move', 'rebuild', 'extended-support', 'accept-risk']);
export const OS_UPGRADE_OPTIONS = table(OS_UPGRADE_VALUES, {
  none: 'None',
  'before-move': 'Upgrade in place before the move',
  'during-move': 'Upgrade during the move (where the tool offers it)',
  rebuild: 'Rebuild on a current OS',
  'extended-support': 'Buy extended support',
  'accept-risk': 'Accept the risk (recorded)',
});

export const LISTEN_PROTO_VALUES = all             ()(['tcp', 'udp']);
export const LISTEN_PROTO_OPTIONS = table(LISTEN_PROTO_VALUES, { tcp: 'TCP', udp: 'UDP' });

const WORKLOAD_TYPE_GROUP                                   = {
  'generic-windows': 'Generic', 'generic-linux': 'Generic', unknown: 'Generic',
  'sap-hana': 'SAP and ERP', 'sap-netweaver': 'SAP and ERP', 'sap-java': 'SAP and ERP', 'oracle-ebs': 'SAP and ERP',
  peoplesoft: 'SAP and ERP', 'jd-edwards': 'SAP and ERP', siebel: 'SAP and ERP',
  exchange: 'Microsoft', sharepoint: 'Microsoft', 'dynamics-crm': 'Microsoft', 'iis-dotnet': 'Microsoft',
  'citrix-vda': 'End-user computing', 'citrix-infra': 'End-user computing', 'rds-host': 'End-user computing', horizon: 'End-user computing',
  'file-server': 'File and print', 'nas-gateway': 'File and print', print: 'File and print',
  weblogic: 'Middleware and messaging', websphere: 'Middleware and messaging', jboss: 'Middleware and messaging',
  tomcat: 'Middleware and messaging', 'ibm-mq': 'Middleware and messaging', rabbitmq: 'Middleware and messaging', kafka: 'Middleware and messaging',
  'ad-ds': 'Infrastructure services', dns: 'Infrastructure services', dhcp: 'Infrastructure services', adcs: 'Infrastructure services',
  ntp: 'Infrastructure services', 'jump-host': 'Infrastructure services',
  'k8s-node': 'Containers', 'openshift-node': 'Containers', 'docker-host': 'Containers',
  'db-host': 'Databases and batch', batch: 'Databases and batch',
  aix: 'Unix, legacy and mainframe', 'ibm-i': 'Unix, legacy and mainframe', 'solaris-sparc': 'Unix, legacy and mainframe',
  'solaris-x86': 'Unix, legacy and mainframe', 'hp-ux': 'Unix, legacy and mainframe', mainframe: 'Unix, legacy and mainframe',
};
export const WORKLOAD_TYPE_VALUES = all              ()([
  'generic-windows', 'generic-linux',
  'sap-hana', 'sap-netweaver', 'sap-java', 'oracle-ebs', 'peoplesoft', 'jd-edwards', 'siebel', 'weblogic',
  'exchange', 'sharepoint', 'dynamics-crm', 'iis-dotnet', 'citrix-vda', 'citrix-infra', 'rds-host', 'horizon',
  'file-server', 'nas-gateway', 'print', 'websphere', 'jboss', 'tomcat', 'ibm-mq', 'rabbitmq', 'kafka',
  'ad-ds', 'dns', 'dhcp', 'adcs', 'ntp', 'jump-host', 'k8s-node', 'openshift-node', 'docker-host',
  'db-host', 'batch', 'aix', 'ibm-i', 'solaris-sparc', 'solaris-x86', 'hp-ux', 'mainframe',
  'appliance-f5', 'appliance-paloalto', 'appliance-fortinet', 'appliance-checkpoint', 'appliance-cisco', 'appliance-other',
  'unknown',
]);
export const WORKLOAD_TYPE_OPTIONS = table(
  WORKLOAD_TYPE_VALUES,
  {
    'generic-windows': 'Windows server (generic)',
    'generic-linux': 'Linux server (generic)',
    'sap-hana': 'SAP HANA database',
    'sap-netweaver': 'SAP NetWeaver ABAP application server',
    'sap-java': 'SAP NetWeaver Java application server',
    'oracle-ebs': 'Oracle E-Business Suite',
    peoplesoft: 'PeopleSoft',
    'jd-edwards': 'JD Edwards',
    siebel: 'Siebel',
    weblogic: 'Oracle WebLogic Server',
    exchange: 'Microsoft Exchange Server',
    sharepoint: 'Microsoft SharePoint Server',
    'dynamics-crm': 'Microsoft Dynamics CRM (on-premises)',
    'iis-dotnet': 'IIS / .NET web server',
    'citrix-vda': 'Citrix VDA (session or desktop host)',
    'citrix-infra': 'Citrix infrastructure (Delivery Controller, StoreFront)',
    'rds-host': 'Remote Desktop Session Host',
    horizon: 'Omnissa Horizon (formerly VMware Horizon)',
    'file-server': 'File server',
    'nas-gateway': 'NAS gateway',
    print: 'Print server',
    websphere: 'IBM WebSphere',
    jboss: 'JBoss / WildFly',
    tomcat: 'Apache Tomcat',
    'ibm-mq': 'IBM MQ',
    rabbitmq: 'RabbitMQ',
    kafka: 'Apache Kafka',
    'ad-ds': 'Active Directory domain controller',
    dns: 'DNS server',
    dhcp: 'DHCP server',
    adcs: 'Active Directory Certificate Services',
    ntp: 'NTP server',
    'jump-host': 'Jump host',
    'k8s-node': 'Kubernetes node',
    'openshift-node': 'OpenShift node',
    'docker-host': 'Docker host',
    'db-host': 'Database host',
    batch: 'Batch / scheduler',
    aix: 'IBM AIX',
    'ibm-i': 'IBM i',
    'solaris-sparc': 'Solaris on SPARC',
    'solaris-x86': 'Solaris on x86',
    'hp-ux': 'HP-UX',
    mainframe: 'Mainframe',
    'appliance-f5': 'F5 BIG-IP',
    'appliance-paloalto': 'Palo Alto Networks firewall',
    'appliance-fortinet': 'Fortinet FortiGate',
    'appliance-checkpoint': 'Check Point firewall',
    'appliance-cisco': 'Cisco appliance',
    'appliance-other': 'Other appliance',
    unknown: 'Unknown',
  },
  (v) => (v.startsWith('appliance-') ? 'Appliances' : WORKLOAD_TYPE_GROUP[v] ?? 'Generic'),
);

export const APP_KIND_VALUES = all         ()(['cots', 'packaged', 'home-grown', 'infrastructure', 'unknown']);
export const APP_KIND_OPTIONS = table(APP_KIND_VALUES, {
  cots: 'Commercial off-the-shelf',
  packaged: 'Packaged (vendor platform, customised)',
  'home-grown': 'Built in-house',
  infrastructure: 'Infrastructure service',
  unknown: 'Unknown',
});

const GREENFIELD_PATTERNS                    = ['web-app', 'api', 'microservices', 'batch-pipeline', 'database', 'file-share', 'vdi', 'messaging', 'static-site', 'event-driven', 'blank'];
const PATTERN_FAMILY                                   = {
  generic: 'Generic',
  'oracle-ebs': 'ERP and CRM', peoplesoft: 'ERP and CRM', 'jd-edwards': 'ERP and CRM', siebel: 'ERP and CRM', weblogic: 'Middleware',
  exchange: 'Microsoft', sharepoint: 'Microsoft', 'dynamics-crm': 'Microsoft', 'iis-dotnet': 'Microsoft',
  'citrix-vad': 'End-user computing', rds: 'End-user computing', horizon: 'End-user computing',
  'file-server': 'File and print', nas: 'File and print', print: 'File and print',
  websphere: 'Middleware', jboss: 'Middleware', tomcat: 'Middleware', 'ibm-mq': 'Middleware', rabbitmq: 'Middleware', kafka: 'Middleware',
  'ad-ds': 'Infrastructure services', dns: 'Infrastructure services', dhcp: 'Infrastructure services', adcs: 'Infrastructure services',
  ntp: 'Infrastructure services', 'jump-host': 'Infrastructure services',
  kubernetes: 'Containers', openshift: 'Containers', 'docker-host': 'Containers',
  aix: 'Unix, legacy and mainframe', 'ibm-i': 'Unix, legacy and mainframe', 'solaris-sparc': 'Unix, legacy and mainframe',
  'solaris-x86': 'Unix, legacy and mainframe', 'hp-ux': 'Unix, legacy and mainframe', mainframe: 'Unix, legacy and mainframe',
};
export const APP_PATTERN_VALUES = all            ()([
  'generic',
  'sap-s4hana', 'sap-ecc-hana', 'sap-ecc-anydb', 'sap-bw', 'sap-netweaver-java', 'sap-po', 'sap-hana-native',
  'oracle-ebs', 'peoplesoft', 'jd-edwards', 'siebel', 'weblogic',
  'exchange', 'sharepoint', 'dynamics-crm', 'iis-dotnet',
  'citrix-vad', 'rds', 'horizon', 'file-server', 'nas', 'print',
  'websphere', 'jboss', 'tomcat', 'ibm-mq', 'rabbitmq', 'kafka',
  'ad-ds', 'dns', 'dhcp', 'adcs', 'ntp', 'jump-host',
  'kubernetes', 'openshift', 'docker-host',
  'aix', 'ibm-i', 'solaris-sparc', 'solaris-x86', 'hp-ux', 'mainframe',
  'appliance-f5', 'appliance-paloalto', 'appliance-fortinet', 'appliance-checkpoint', 'appliance-cisco',
  'web-app', 'api', 'microservices', 'batch-pipeline', 'database', 'file-share', 'vdi', 'messaging',
  'static-site', 'event-driven', 'blank',
]);
export const APP_PATTERN_OPTIONS = table(
  APP_PATTERN_VALUES,
  {
    generic: 'Generic application',
    'sap-s4hana': 'SAP S/4HANA',
    'sap-ecc-hana': 'SAP ECC on HANA',
    'sap-ecc-anydb': 'SAP ECC on AnyDB',
    'sap-bw': 'SAP BW / BW/4HANA',
    'sap-netweaver-java': 'SAP NetWeaver Java',
    'sap-po': 'SAP Process Orchestration',
    'sap-hana-native': 'SAP HANA (native applications)',
    'oracle-ebs': 'Oracle E-Business Suite',
    peoplesoft: 'PeopleSoft',
    'jd-edwards': 'JD Edwards',
    siebel: 'Siebel CRM',
    weblogic: 'Oracle WebLogic applications',
    exchange: 'Microsoft Exchange',
    sharepoint: 'Microsoft SharePoint',
    'dynamics-crm': 'Microsoft Dynamics CRM',
    'iis-dotnet': 'IIS / .NET application',
    'citrix-vad': 'Citrix Virtual Apps and Desktops',
    rds: 'Remote Desktop Services',
    horizon: 'Omnissa Horizon (formerly VMware Horizon)',
    'file-server': 'File server',
    nas: 'NAS',
    print: 'Print services',
    websphere: 'IBM WebSphere applications',
    jboss: 'JBoss / WildFly applications',
    tomcat: 'Tomcat applications',
    'ibm-mq': 'IBM MQ',
    rabbitmq: 'RabbitMQ',
    kafka: 'Apache Kafka',
    'ad-ds': 'Active Directory',
    dns: 'DNS',
    dhcp: 'DHCP',
    adcs: 'Certificate services (AD CS)',
    ntp: 'Time service (NTP)',
    'jump-host': 'Jump hosts',
    kubernetes: 'Kubernetes',
    openshift: 'Red Hat OpenShift',
    'docker-host': 'Docker hosts',
    aix: 'IBM AIX',
    'ibm-i': 'IBM i',
    'solaris-sparc': 'Solaris on SPARC',
    'solaris-x86': 'Solaris on x86',
    'hp-ux': 'HP-UX',
    mainframe: 'Mainframe',
    'appliance-f5': 'F5 BIG-IP',
    'appliance-paloalto': 'Palo Alto Networks',
    'appliance-fortinet': 'Fortinet FortiGate',
    'appliance-checkpoint': 'Check Point',
    'appliance-cisco': 'Cisco',
    'web-app': 'Web application',
    api: 'API service',
    microservices: 'Microservices',
    'batch-pipeline': 'Batch / data pipeline',
    database: 'Database',
    'file-share': 'File share',
    vdi: 'Virtual desktops',
    messaging: 'Messaging',
    'static-site': 'Static website',
    'event-driven': 'Event-driven (serverless)',
    blank: 'Blank (start from nothing)',
  },
  (v) => (GREENFIELD_PATTERNS.includes(v) ? 'New service' : v.startsWith('sap-') ? 'SAP' : v.startsWith('appliance-') ? 'Appliances' : PATTERN_FAMILY[v] ?? 'Generic'),
);

export const TIER_PATTERN_VALUES = all             ()([
  'vm', 'vmware-service', 'paas-web', 'containers', 'serverless', 'static-site', 'api-gateway',
  'batch', 'workflow', 'object-storage', 'managed-db', 'file-service', 'vdi-service', 'saas', 'sap-certified',
  'managed-messaging', 'managed-kafka', 'managed-cache', 'managed-search', 'appliance', 'specialist', 'retire', 'retain',
]);
export const TIER_PATTERN_OPTIONS = table(TIER_PATTERN_VALUES, {
  vm: 'Virtual machines',
  'vmware-service': 'VMware service (Amazon EVS / Azure VMware Solution / Google Cloud VMware Engine / Oracle Cloud VMware Solution)',
  'paas-web': 'Managed web platform',
  containers: 'Containers (Kubernetes)',
  serverless: 'Serverless functions',
  'static-site': 'Static site (object storage + CDN)',
  'api-gateway': 'API gateway',
  batch: 'Managed batch',
  workflow: 'Workflow / orchestration service',
  'object-storage': 'Object storage',
  'managed-db': 'Managed database',
  'file-service': 'Managed file service',
  'vdi-service': 'Managed desktop service',
  saas: 'Software as a service',
  'sap-certified': 'SAP-certified infrastructure',
  'managed-messaging': 'Managed messaging',
  'managed-kafka': 'Managed Kafka',
  'managed-cache': 'Managed cache',
  'managed-search': 'Managed search',
  appliance: 'Vendor appliance image',
  specialist: 'Specialist platform (partner)',
  retire: 'Retire',
  retain: 'Retain on premises',
});

export const COMPONENT_TIER_VALUES = all               ()(['web', 'app', 'integration', 'data', 'file', 'vdi', 'infra', 'edge', 'platform', 'other']);
export const COMPONENT_TIER_OPTIONS = table(COMPONENT_TIER_VALUES, {
  web: 'Web',
  app: 'Application',
  integration: 'Integration',
  data: 'Data',
  file: 'File',
  vdi: 'Desktops',
  infra: 'Infrastructure',
  edge: 'Edge',
  platform: 'Platform',
  other: 'Other',
});

export const COMPONENT_KIND_VALUES = all               ()(['pattern', 'resource', 'config']);
export const COMPONENT_KIND_OPTIONS = table(COMPONENT_KIND_VALUES, { pattern: 'Pattern', resource: 'Cloud resource', config: 'Configuration' });

export const CHANGE_WINDOW_VALUES = all              ()(['weekday-night', 'weekend', 'any', 'blackout-only']);
export const CHANGE_WINDOW_OPTIONS = table(CHANGE_WINDOW_VALUES, {
  'weekday-night': 'Weekday nights',
  weekend: 'Weekends',
  any: 'Any time',
  'blackout-only': 'Only outside blackout periods',
});

export const APP_PLAN_STATUS_VALUES = all               ()(['draft', 'planned', 'approved']);
export const APP_PLAN_STATUS_OPTIONS = table(APP_PLAN_STATUS_VALUES, { draft: 'Draft', planned: 'Planned', approved: 'Approved' });

export const COMPONENT_STATUS_VALUES = all                 ()(['ok', 'partial', 'unresolved', 'invalid']);
export const COMPONENT_STATUS_OPTIONS = table(COMPONENT_STATUS_VALUES, { ok: 'OK', partial: 'Partly translated', unresolved: 'Unresolved', invalid: 'Invalid' });

export const INGRESS_EXPOSURE_VALUES = all                 ()(['internal', 'public']);
export const INGRESS_EXPOSURE_OPTIONS = table(INGRESS_EXPOSURE_VALUES, { internal: 'Internal', public: 'Public' });
export const INGRESS_LB_VALUES = all           ()(['none', 'l4', 'l7']);
export const INGRESS_LB_OPTIONS = table(INGRESS_LB_VALUES, { none: 'None', l4: 'Layer 4 (TCP/UDP)', l7: 'Layer 7 (HTTP/S)' });
export const INGRESS_TLS_VALUES = all            ()(['terminate', 'passthrough']);
export const INGRESS_TLS_OPTIONS = table(INGRESS_TLS_VALUES, { terminate: 'Terminate at the load balancer', passthrough: 'Pass through to the servers' });

export const COST_CLASS_VALUES = all           ()(['static', 'light', 'typical', 'heavy']);
export const COST_CLASS_OPTIONS = table(COST_CLASS_VALUES, { static: 'Static content', light: 'Light requests', typical: 'Typical requests', heavy: 'Heavy requests' });
export const SLO_VALUES = all     ()(['99.0', '99.5', '99.9', '99.95', '99.99']);
export const SLO_OPTIONS = table(SLO_VALUES, { '99.0': '99.0%', '99.5': '99.5%', '99.9': '99.9%', '99.95': '99.95%', '99.99': '99.99%' });
export const HORIZON_YEARS_VALUES = all                   ()(['1', '3', '5']);
export const HORIZON_YEARS_OPTIONS = table(HORIZON_YEARS_VALUES, { '1': '1 year', '3': '3 years', '5': '5 years' });
export const NONPROD_PCT_VALUES = all                 ()(['10', '25', '50', '100']);
export const NONPROD_PCT_OPTIONS = table(NONPROD_PCT_VALUES, { '10': '10% of production', '25': '25% of production', '50': '50% of production', '100': 'Same as production' });
export const SMOKE_KIND_VALUES = all           ()(['http', 'tcp', 'sql']);
export const SMOKE_KIND_OPTIONS = table(SMOKE_KIND_VALUES, { http: 'HTTP(S) request', tcp: 'TCP connect', sql: 'SQL query' });
export const LANDING_ZONE_MODE_VALUES = all                 ()(['shared', 'included']);
export const LANDING_ZONE_MODE_OPTIONS = table(LANDING_ZONE_MODE_VALUES, {
  shared: 'Shared landing zone (designed on Migration & Utilities)',
  included: 'Included in the app’s own project',
});

// ---------------------------------------------------------------------------
// Addendum A.2.8: sizing
// ---------------------------------------------------------------------------

export const SIZING_CONCERN_VALUES = all               ()(['server', 'storage', 'k8s', 'database', 'sap', 'vdi', 'file', 'vcf', 'load']);
export const SIZING_CONCERN_OPTIONS = table(SIZING_CONCERN_VALUES, {
  server: 'Servers and VMs',
  storage: 'Storage',
  k8s: 'Kubernetes',
  database: 'Databases',
  sap: 'SAP',
  vdi: 'Virtual desktops',
  file: 'File services',
  vcf: 'VCF hosts',
  load: 'Load model',
});
export const PERCENTILE_VALUES = all            ()(['p50', 'p90', 'p95', 'p99', 'max']);
export const PERCENTILE_OPTIONS = table(PERCENTILE_VALUES, { p50: '50th percentile', p90: '90th percentile', p95: '95th percentile', p99: '99th percentile', max: 'Maximum' });
export const SIZING_POLICY_BASIS_VALUES = all                   ()(['auto', 'allocated', 'utilisation-only']);
export const SIZING_POLICY_BASIS_OPTIONS = table(SIZING_POLICY_BASIS_VALUES, {
  auto: 'Utilisation where the data is good enough, else allocated',
  allocated: 'Allocated',
  'utilisation-only': 'Utilisation only (rows without data are flagged)',
});
export const HEADROOM_PCT_VALUES = all                  ()(['0', '10', '20', '30', '50']);
export const HEADROOM_PCT_OPTIONS = table(HEADROOM_PCT_VALUES, { '0': '0%', '10': '10%', '20': '20%', '30': '30%', '50': '50%' });
export const DISK_BASIS_VALUES = all           ()(['provisioned', 'used-plus-headroom']);
export const DISK_BASIS_OPTIONS = table(DISK_BASIS_VALUES, { provisioned: 'Provisioned', 'used-plus-headroom': 'Used + headroom' });
export const GROWTH_PCT_YEAR_VALUES = all                    ()(['0', '10', '20', '30']);
export const GROWTH_PCT_YEAR_OPTIONS = table(GROWTH_PCT_YEAR_VALUES, { '0': 'None', '10': '10% a year', '20': '20% a year', '30': '30% a year' });
export const INSTANCE_FAMILY_VALUES = all                ()(['general', 'compute', 'memory', 'burstable', 'storage', 'gpu']);
export const INSTANCE_FAMILY_OPTIONS = table(INSTANCE_FAMILY_VALUES, {
  general: 'General purpose',
  compute: 'Compute optimised',
  memory: 'Memory optimised',
  burstable: 'Burstable',
  storage: 'Storage optimised',
  gpu: 'GPU',
});

// ---------------------------------------------------------------------------
// Addendum A.6: execution
// ---------------------------------------------------------------------------

export const MOVE_PATH_VALUES = all          ()([
  'hcx-bulk', 'hcx-rav', 'hcx-vmotion', 'hcx-cold', 'hcx-osam', 'xvc-vmotion', 'vcf-import', 'vcf-converter',
  'aws-mgn', 'azure-migrate', 'azure-migrate-hyperv', 'azure-migrate-agent', 'gcp-m2vm', 'gcp-image-import', 'oci-ocm',
  'rebuild', 'with-db', 'retire', 'specialist', 'deploy',
  'sap-hsr', 'sap-backup-restore', 'saas-exchange', 'saas-sharepoint', 'k8s-velero', 'appliance-rebuild',
]);
const PATTERN_PATHS                    = ['sap-hsr', 'sap-backup-restore', 'saas-exchange', 'saas-sharepoint', 'k8s-velero', 'appliance-rebuild'];
export const MOVE_PATH_OPTIONS = table(
  MOVE_PATH_VALUES,
  {
    'hcx-bulk': 'HCX Bulk Migration',
    'hcx-rav': 'HCX Replication Assisted vMotion',
    'hcx-vmotion': 'HCX vMotion',
    'hcx-cold': 'HCX Cold Migration',
    'hcx-osam': 'HCX OS Assisted Migration',
    'xvc-vmotion': 'Cross-vCenter vMotion',
    'vcf-import': 'VCF Import (bring under management in place)',
    'vcf-converter': 'vCenter Converter',
    'aws-mgn': 'AWS Transform MGN (formerly AWS Application Migration Service)',
    'azure-migrate': 'Azure Migrate (agentless, VMware)',
    'azure-migrate-hyperv': 'Azure Migrate (agentless, Hyper-V)',
    'azure-migrate-agent': 'Azure Migrate (agent-based)',
    'gcp-m2vm': 'Migrate to Virtual Machines',
    'gcp-image-import': 'Compute Engine image import',
    'oci-ocm': 'Oracle Cloud Migrations',
    rebuild: 'Rebuild from image, configure, copy data',
    'with-db': 'Moves with its database',
    retire: 'Retire',
    specialist: 'Specialist (partner or manual)',
    deploy: 'Deploy (new service)',
    'sap-hsr': 'SAP HANA System Replication',
    'sap-backup-restore': 'SAP backup and restore',
    'saas-exchange': 'Move to Exchange Online',
    'saas-sharepoint': 'Move to SharePoint Online',
    'k8s-velero': 'Velero backup and restore',
    'appliance-rebuild': 'Rebuild from the vendor’s image',
  },
  (v) => (v.startsWith('hcx-') || v === 'xvc-vmotion' || v.startsWith('vcf-') ? 'VMware'
    : v.startsWith('aws-') ? 'AWS' : v.startsWith('azure-') ? 'Azure' : v.startsWith('gcp-') ? 'Google Cloud (GCP)' : v.startsWith('oci-') ? 'OCI'
      : PATTERN_PATHS.includes(v) ? 'Patterns' : 'Any platform'),
);

export const DB_MOVE_PATH_VALUES = all            ()([
  'with-vm', 'oracle-zdm-physical', 'oracle-zdm-logical', 'oracle-dataguard', 'oracle-rman', 'oracle-datapump',
  'oci-dms', 'aws-dms', 'azure-dms', 'azure-pg-migration', 'gcp-dms',
  'sql-ag-seeding', 'sql-log-shipping', 'sql-backup-url', 'sql-mi-link', 'sql-mi-lrs', 'sql-rds-native',
  'pg-logical', 'pg-dump', 'mysql-replication', 'mysql-dump',
  'db2-backup-restore', 'db2-hadr', 'ase-dump-load', 'informix-backup-restore', 'mongo-mongosync',
  'redis-replicaof', 'redis-rdb-import', 'cassandra-zdm-proxy', 'cassandra-ring-join', 'es-snapshot-restore', 'es-reindex-remote',
]);
export const DB_MOVE_PATH_OPTIONS = table(
  DB_MOVE_PATH_VALUES,
  {
    'with-vm': 'Moves inside its server',
    'oracle-zdm-physical': 'Oracle Zero Downtime Migration (physical)',
    'oracle-zdm-logical': 'Oracle Zero Downtime Migration (logical)',
    'oracle-dataguard': 'Oracle Data Guard switchover',
    'oracle-rman': 'Oracle RMAN backup and restore',
    'oracle-datapump': 'Oracle Data Pump',
    'oci-dms': 'OCI Database Migration',
    'aws-dms': 'AWS Database Migration Service',
    'azure-dms': 'Azure Database Migration Service',
    'azure-pg-migration': 'Azure Database for PostgreSQL migration service',
    'gcp-dms': 'Database Migration Service (Google Cloud (GCP))',
    'sql-ag-seeding': 'SQL Server availability group (automatic seeding)',
    'sql-log-shipping': 'SQL Server log shipping',
    'sql-backup-url': 'SQL Server backup to URL and restore',
    'sql-mi-link': 'Managed Instance link',
    'sql-mi-lrs': 'Log Replay Service (SQL Managed Instance)',
    'sql-rds-native': 'Amazon RDS native backup and restore',
    'pg-logical': 'PostgreSQL logical replication',
    'pg-dump': 'pg_dump and restore',
    'mysql-replication': 'MySQL replication',
    'mysql-dump': 'MySQL Shell dump and load',
    'db2-backup-restore': 'Db2 backup and restore',
    'db2-hadr': 'Db2 HADR',
    'ase-dump-load': 'SAP ASE dump and load',
    'informix-backup-restore': 'Informix backup and restore',
    'mongo-mongosync': 'MongoDB mongosync',
    'redis-replicaof': 'Redis replication (REPLICAOF)',
    'redis-rdb-import': 'Redis RDB import',
    'cassandra-zdm-proxy': 'Cassandra ZDM proxy (dual write)',
    'cassandra-ring-join': 'Cassandra ring join and decommission',
    'es-snapshot-restore': 'Elasticsearch / OpenSearch snapshot and restore',
    'es-reindex-remote': 'Reindex from remote',
  },
  (v) => (v.startsWith('oracle-') ? 'Oracle' : v.startsWith('sql-') ? 'SQL Server' : v.endsWith('-dms') || v === 'azure-pg-migration' ? 'Migration services'
    : v.startsWith('pg-') ? 'PostgreSQL' : v.startsWith('mysql-') ? 'MySQL' : v === 'with-vm' ? 'With the server' : 'Other engines'),
);

export const DNS_PROVIDER_VALUES = all             ()(['route53', 'azure-dns', 'azure-private-dns', 'cloud-dns', 'oci-dns', 'windows-dns', 'infoblox']);
export const DNS_PROVIDER_OPTIONS = table(DNS_PROVIDER_VALUES, {
  route53: 'Amazon Route 53',
  'azure-dns': 'Azure DNS (public)',
  'azure-private-dns': 'Azure Private DNS',
  'cloud-dns': 'Cloud DNS',
  'oci-dns': 'OCI DNS',
  'windows-dns': 'Windows DNS (Active Directory)',
  infoblox: 'Infoblox',
});
export const LB_KIND_VALUES = all        ()(['none', 'aws-elbv2', 'azure-lb', 'gcp-neg', 'oci-lb', 'f5-bigip', 'avi']);
export const LB_KIND_OPTIONS = table(LB_KIND_VALUES, {
  none: 'None',
  'aws-elbv2': 'Elastic Load Balancing (ALB / NLB)',
  'azure-lb': 'Azure Load Balancer / Application Gateway',
  'gcp-neg': 'Cloud Load Balancing (network endpoint group)',
  'oci-lb': 'OCI Load Balancer',
  'f5-bigip': 'F5 BIG-IP',
  avi: 'VMware Avi Load Balancer',
});
export const DATA_COPY_METHOD_VALUES = all                ()(['robocopy', 'rsync', 'datasync', 'storage-mover', 'storage-transfer', 'azcopy', 'rclone']);
export const DATA_COPY_METHOD_OPTIONS = table(DATA_COPY_METHOD_VALUES, {
  robocopy: 'Robocopy',
  rsync: 'rsync',
  datasync: 'AWS DataSync',
  'storage-mover': 'Azure Storage Mover',
  'storage-transfer': 'Storage Transfer Service',
  azcopy: 'AzCopy',
  rclone: 'rclone',
});
export const LANDING_ZONE_STATE_VALUES = all                  ()(['designed', 'generated']);
export const LANDING_ZONE_STATE_OPTIONS = table(LANDING_ZONE_STATE_VALUES, { designed: 'Designed', generated: 'Generated' });
export const MGN_REPLICATION_VALUES = all                ()(['agent', 'agentless']);
export const MGN_REPLICATION_OPTIONS = table(MGN_REPLICATION_VALUES, { agent: 'Agent-based', agentless: 'Agentless (vCenter sources only)' });
export const MGN_IP_PROTOCOL_VALUES = all               ()(['IPV4', 'IPV6']);
export const MGN_IP_PROTOCOL_OPTIONS = table(MGN_IP_PROTOCOL_VALUES, { IPV4: 'IPv4', IPV6: 'IPv6' });
export const AZURE_MIGRATE_DISK_TYPE_VALUES = all                      ()(['Premium_LRS', 'PremiumV2_LRS', 'StandardSSD_LRS']);
export const AZURE_MIGRATE_DISK_TYPE_OPTIONS = table(AZURE_MIGRATE_DISK_TYPE_VALUES, {
  Premium_LRS: 'Premium SSD',
  PremiumV2_LRS: 'Premium SSD v2',
  StandardSSD_LRS: 'Standard SSD',
});
export const AZURE_SECURITY_TYPE_VALUES = all                   ()(['TrustedLaunch', 'None']);
export const AZURE_SECURITY_TYPE_OPTIONS = table(AZURE_SECURITY_TYPE_VALUES, { TrustedLaunch: 'Trusted Launch', None: 'Standard' });
export const DMS_CAPACITY_UNITS_VALUES = all                       ()(['4', '8', '16', '32', '64']);
export const DMS_CAPACITY_UNITS_OPTIONS = table(DMS_CAPACITY_UNITS_VALUES, { '4': '4 DCU', '8': '8 DCU', '16': '16 DCU', '32': '32 DCU', '64': '64 DCU' });
export const HCX_WINDOW_HOURS_VALUES = all                     ()(['1', '2', '4', '8']);
export const HCX_WINDOW_HOURS_OPTIONS = table(HCX_WINDOW_HOURS_VALUES, { '1': '1 hour', '2': '2 hours', '4': '4 hours', '8': '8 hours' });

// ---------------------------------------------------------------------------
// Addendum A.5, A.10: waves, grouping, governance, data-centre exit, records
// ---------------------------------------------------------------------------

export const WAVE_KIND_VALUES = all          ()(['foundation', 'app', 'exit']);
export const WAVE_KIND_OPTIONS = table(WAVE_KIND_VALUES, { foundation: 'Foundation', app: 'Applications', exit: 'Data-centre exit' });
export const GROUPING_RULE_VALUES = all                  ()(['attribute', 'folder-leaf', 'vapp', 'resource-pool', 'name-regex', 'cloud-tag', 'csv-column']);
export const GROUPING_RULE_OPTIONS = table(GROUPING_RULE_VALUES, {
  attribute: 'Custom attribute or tag',
  'folder-leaf': 'Folder (last part)',
  vapp: 'vApp',
  'resource-pool': 'Resource pool',
  'name-regex': 'Name pattern (regular expression)',
  'cloud-tag': 'Cloud tag or label',
  'csv-column': 'CSV app column',
});

export const RACI_ROLE_VALUES = all          ()([
  'migration-lead', 'app-owner', 'infra-vmware', 'cloud-platform', 'network', 'security', 'dba', 'service-desk', 'change-manager', 'vendor',
]);
export const RACI_ROLE_OPTIONS = table(RACI_ROLE_VALUES, {
  'migration-lead': 'Migration lead',
  'app-owner': 'Application owner',
  'infra-vmware': 'VMware infrastructure',
  'cloud-platform': 'Cloud platform',
  network: 'Network',
  security: 'Security',
  dba: 'Database administration',
  'service-desk': 'Service desk',
  'change-manager': 'Change manager',
  vendor: 'Vendor',
});
export const RACI_CELL_VALUES = all          ()(['R', 'A', 'C', 'I']);
export const RACI_CELL_OPTIONS = table(RACI_CELL_VALUES, { R: 'Responsible', A: 'Accountable', C: 'Consulted', I: 'Informed' });
export const RACI_PHASE_VALUES = all           ()(['migrate', 'run']);
export const RACI_PHASE_OPTIONS = table(RACI_PHASE_VALUES, { migrate: 'During the migration', run: 'In operation' });
export const CR_SYSTEM_VALUES = all          ()(['none', 'servicenow', 'csv']);
export const CR_SYSTEM_OPTIONS = table(CR_SYSTEM_VALUES, { none: 'None', servicenow: 'ServiceNow', csv: 'CSV export' });
export const CICD_VALUES = all      ()(['none', 'github-actions', 'azure-devops', 'gitlab-ci']);
export const CICD_OPTIONS = table(CICD_VALUES, { none: 'None', 'github-actions': 'GitHub Actions', 'azure-devops': 'Azure Pipelines', 'gitlab-ci': 'GitLab CI/CD' });

export const INFRA_CATEGORY_VALUES = all               ()([
  'network-device', 'circuit', 'subnet', 'net-service', 'storage-array', 'backup', 'archive',
  'security-service', 'ops-tool', 'job', 'telephony', 'print', 'ot-iot', 'other',
]);
export const INFRA_CATEGORY_OPTIONS = table(INFRA_CATEGORY_VALUES, {
  'network-device': 'Network device',
  circuit: 'Circuit',
  subnet: 'Subnet',
  'net-service': 'Network service',
  'storage-array': 'Storage array',
  backup: 'Backup',
  archive: 'Archive',
  'security-service': 'Security service',
  'ops-tool': 'Operations tool',
  job: 'Scheduled job',
  telephony: 'Telephony',
  print: 'Print',
  'ot-iot': 'OT / IoT',
  other: 'Other',
});
export const INFRA_DISPOSITION_VALUES = all                  ()(['migrate', 'replace', 'retire', 'stays', 'n/a']);
export const INFRA_DISPOSITION_OPTIONS = table(INFRA_DISPOSITION_VALUES, { migrate: 'Migrate', replace: 'Replace', retire: 'Retire', stays: 'Stays', 'n/a': 'Not applicable' });
export const EXTERNAL_KIND_VALUES = all              ()(['partner-allowlist', 'b2b-edi', 'sftp', 'inbound-api', 'vendor-support', 'user-access', 'outbound-saas']);
export const EXTERNAL_KIND_OPTIONS = table(EXTERNAL_KIND_VALUES, {
  'partner-allowlist': 'Partner allow-list',
  'b2b-edi': 'B2B / EDI',
  sftp: 'SFTP',
  'inbound-api': 'Inbound API',
  'vendor-support': 'Vendor support access',
  'user-access': 'User access',
  'outbound-saas': 'Outbound to SaaS',
});
export const EXTERNAL_DIRECTION_VALUES = all                   ()(['in', 'out', 'both']);
export const EXTERNAL_DIRECTION_OPTIONS = table(EXTERNAL_DIRECTION_VALUES, { in: 'Inbound', out: 'Outbound', both: 'Both' });
export const CONTRACT_KIND_VALUES = all              ()(['support', 'maintenance', 'colocation', 'power', 'circuit', 'licence', 'lease']);
export const CONTRACT_KIND_OPTIONS = table(CONTRACT_KIND_VALUES, {
  support: 'Support',
  maintenance: 'Maintenance',
  colocation: 'Colocation',
  power: 'Power',
  circuit: 'Circuit',
  licence: 'Licence',
  lease: 'Lease',
});
export const SANITISATION_VALUES = all              ()(['clear', 'purge', 'destroy']);
export const SANITISATION_OPTIONS = table(SANITISATION_VALUES, { clear: 'Clear (NIST SP 800-88)', purge: 'Purge (NIST SP 800-88)', destroy: 'Destroy (NIST SP 800-88)' });

export const RATE_CATEGORY_VALUES = all              ()(['compute', 'storage', 'db', 'network', 'licence', 'service', 'facility']);
export const RATE_CATEGORY_OPTIONS = table(RATE_CATEGORY_VALUES, {
  compute: 'Compute',
  storage: 'Storage',
  db: 'Database',
  network: 'Network',
  licence: 'Licence',
  service: 'Service',
  facility: 'Facility',
});
/** Lead decision 1: the second page is "Multi-Cloud Migration & Utilities"; its key stays `migration-change`. */
export const AUDIT_PAGE_VALUES = all           ()(['application-migration', 'migration-change']);
export const AUDIT_PAGE_OPTIONS = table(AUDIT_PAGE_VALUES, {
  'application-migration': 'Application Migration',
  'migration-change': 'Multi-Cloud Migration & Utilities',
});

// ---------------------------------------------------------------------------
// Addendum A.11.3: the tracker and the status contract
// ---------------------------------------------------------------------------

export const ITEM_STATE_VALUES = all           ()([
  'planned', 'prepared', 'replicating', 'in-sync', 'testing', 'tested', 'cutting-over', 'cut-over', 'validated', 'accepted', 'decommissioned',
]);
export const ITEM_STATE_OPTIONS = table(ITEM_STATE_VALUES, {
  planned: 'Planned',
  prepared: 'Prepared',
  replicating: 'Replicating',
  'in-sync': 'In sync',
  testing: 'Testing',
  tested: 'Tested',
  'cutting-over': 'Cutting over',
  'cut-over': 'Cut over',
  validated: 'Validated',
  accepted: 'Accepted',
  decommissioned: 'Decommissioned',
});
/** 0..10, in the order an item moves through them. */
export const ITEM_STATE_RANK                                      = Object.freeze(
  Object.fromEntries(ITEM_STATE_VALUES.map((s, i) => [s, i]))                             ,
);
export const ITEM_FLAG_VALUES = all          ()(['blocked', 'failed', 'rolled-back', 'on-hold']);
export const ITEM_FLAG_OPTIONS = table(ITEM_FLAG_VALUES, { blocked: 'Blocked', failed: 'Failed', 'rolled-back': 'Rolled back', 'on-hold': 'On hold' });
export const STEP_ID_VALUES = all        ()([
  'precheck', 'prepare', 'replicate', 'in-sync', 'test', 'test-cleanup', 'freeze', 'final-sync',
  'stop-source', 'cutover', 'start-target', 'adopt', 'dns-switch', 'lb-switch', 'post-config', 'identity',
  'validate', 'commit', 'accept', 'rollback', 'decommission', 'finalize', 'notice', 'gate', 'deploy', 'manual',
]);
export const STEP_ID_OPTIONS = table(STEP_ID_VALUES, {
  precheck: 'Pre-checks',
  prepare: 'Prepare',
  replicate: 'Replicate',
  'in-sync': 'In sync',
  test: 'Test',
  'test-cleanup': 'Test clean-up',
  freeze: 'Change freeze',
  'final-sync': 'Final sync',
  'stop-source': 'Stop the source',
  cutover: 'Cutover',
  'start-target': 'Start the target',
  adopt: 'Adopt into Terraform state',
  'dns-switch': 'DNS switch',
  'lb-switch': 'Load-balancer switch',
  'post-config': 'Post-configuration',
  identity: 'Identity (domain join)',
  validate: 'Validate',
  commit: 'Commit',
  accept: 'Accept (owner sign-off)',
  rollback: 'Roll back',
  decommission: 'Decommission',
  finalize: 'Finalize',
  notice: 'Notice sent',
  gate: 'Gate',
  deploy: 'Deploy',
  manual: 'Manual change',
});
export const OUTCOME_VALUES = all         ()(['started', 'succeeded', 'failed', 'skipped']);
export const OUTCOME_OPTIONS = table(OUTCOME_VALUES, { started: 'Started', succeeded: 'Succeeded', failed: 'Failed', skipped: 'Skipped' });
export const STATUS_CHANNEL_VALUES = all               ()(['orchestrator', 'dns', 'lb', 'change', 'gate']);
export const STATUS_CHANNEL_OPTIONS = table(STATUS_CHANNEL_VALUES, {
  orchestrator: 'Wave orchestrator',
  dns: 'DNS',
  lb: 'Load balancer',
  change: 'Utility (day-2)',
  gate: 'Gate',
});
export const STATUS_EVENT_SOURCE_VALUES = all                   ()(['script', 'manual', 'validation']);
export const STATUS_EVENT_SOURCE_OPTIONS = table(STATUS_EVENT_SOURCE_VALUES, { script: 'Script', manual: 'Manual', validation: 'Validation report' });
export const ITEM_STATUS_KIND_VALUES = all                ()(['workload', 'database', 'app-deploy', 'infra']);
export const ITEM_STATUS_KIND_OPTIONS = table(ITEM_STATUS_KIND_VALUES, { workload: 'Server', database: 'Database', 'app-deploy': 'New-service deployment', infra: 'Infrastructure' });
export const GATE_ID_VALUES = all        ()(['G1', 'G2', 'G3', 'G4', 'G5']);
export const GATE_ID_OPTIONS = table(GATE_ID_VALUES, {
  G1: 'G1 Ready to test',
  G2: 'G2 Go',
  G3: 'G3 Accept',
  G4: 'G4 Decommission',
  G5: 'G5 Programme close',
});
export const GATE_DECISION_VALUES = all              ()(['go', 'no-go']);
export const GATE_DECISION_OPTIONS = table(GATE_DECISION_VALUES, { go: 'Go', 'no-go': 'No go' });
export const SIGN_OFF_SCOPE_VALUES = all              ()(['app', 'wave', 'plan', 'dc']);
export const SIGN_OFF_SCOPE_OPTIONS = table(SIGN_OFF_SCOPE_VALUES, { app: 'Application', wave: 'Wave', plan: 'Plan', dc: 'Data centre' });
export const SIGN_OFF_KIND_VALUES = all             ()(['plan-approved', 'design-approved', 'test-passed', 'go', 'accepted', 'decom-approved', 'lights-out']);
export const SIGN_OFF_KIND_OPTIONS = table(SIGN_OFF_KIND_VALUES, {
  'plan-approved': 'Plan approved',
  'design-approved': 'Design approved',
  'test-passed': 'Test passed',
  go: 'Go',
  accepted: 'Accepted',
  'decom-approved': 'Decommission approved',
  'lights-out': 'Lights out',
});
export const SIGN_OFF_DECISION_VALUES = all                 ()(['approved', 'rejected']);
export const SIGN_OFF_DECISION_OPTIONS = table(SIGN_OFF_DECISION_VALUES, { approved: 'Approved', rejected: 'Rejected' });
export const RAID_SCORE_VALUES = all                ()(['1', '2', '3', '4', '5']);
export const RAID_SCORE_OPTIONS = table(RAID_SCORE_VALUES, { '1': '1 Very low', '2': '2 Low', '3': '3 Medium', '4': '4 High', '5': '5 Very high' });
export const RISK_RESPONSE_VALUES = all              ()(['avoid', 'reduce', 'transfer', 'accept']);
export const RISK_RESPONSE_OPTIONS = table(RISK_RESPONSE_VALUES, { avoid: 'Avoid', reduce: 'Reduce', transfer: 'Transfer', accept: 'Accept' });
export const RISK_STATUS_VALUES = all            ()(['open', 'mitigating', 'closed', 'occurred']);
export const RISK_STATUS_OPTIONS = table(RISK_STATUS_VALUES, { open: 'Open', mitigating: 'Mitigating', closed: 'Closed', occurred: 'Occurred' });
export const ASSUMPTION_STATUS_VALUES = all                  ()(['open', 'confirmed', 'false']);
export const ASSUMPTION_STATUS_OPTIONS = table(ASSUMPTION_STATUS_VALUES, { open: 'Open', confirmed: 'Confirmed', false: 'Proved false' });
export const ISSUE_SEVERITY_VALUES = all               ()(['sev1', 'sev2', 'sev3', 'sev4']);
export const ISSUE_SEVERITY_OPTIONS = table(ISSUE_SEVERITY_VALUES, { sev1: 'Sev 1', sev2: 'Sev 2', sev3: 'Sev 3', sev4: 'Sev 4' });
export const ISSUE_STATUS_VALUES = all             ()(['open', 'in-progress', 'resolved', 'closed']);
export const ISSUE_STATUS_OPTIONS = table(ISSUE_STATUS_VALUES, { open: 'Open', 'in-progress': 'In progress', resolved: 'Resolved', closed: 'Closed' });
export const ISSUE_ORIGIN_VALUES = all             ()(['manual', 'coupling', 'capacity', 'validation', 'licence']);
export const ISSUE_ORIGIN_OPTIONS = table(ISSUE_ORIGIN_VALUES, { manual: 'Manual', coupling: 'Coupling', capacity: 'Capacity', validation: 'Validation', licence: 'Licence' });
export const DECISION_SOURCE_VALUES = all                ()(['manual', 'gate', 'rollback', 're-wave', 'pin', 'what-if', 'platform-switch', 'left-out']);
export const DECISION_SOURCE_OPTIONS = table(DECISION_SOURCE_VALUES, {
  manual: 'Manual',
  gate: 'Gate',
  rollback: 'Rollback',
  're-wave': 'Re-wave',
  pin: 'Pin',
  'what-if': 'What-if',
  'platform-switch': 'Platform switch',
  'left-out': 'Component left out',
});
export const RECLAIMED_LICENCE_VALUES = all                  ()([
  'oracle-processor', 'oracle-se2-socket', 'windows-core', 'sql-core', 'rhel', 'sles', 'none', 'vcf-core', 'third-party',
]);
export const RECLAIMED_LICENCE_OPTIONS = table(RECLAIMED_LICENCE_VALUES, {
  'oracle-processor': 'Oracle processor licences',
  'oracle-se2-socket': 'Oracle SE2 sockets',
  'windows-core': 'Windows Server core licences',
  'sql-core': 'SQL Server core licences',
  rhel: 'RHEL subscriptions',
  sles: 'SLES subscriptions',
  none: 'None',
  'vcf-core': 'VCF cores',
  'third-party': 'Third-party licences',
});
export const LICENCE_RECLAIM_STATUS_VALUES = all                      ()(['freed', 'reassigned', 'terminated']);
export const LICENCE_RECLAIM_STATUS_OPTIONS = table(LICENCE_RECLAIM_STATUS_VALUES, { freed: 'Freed', reassigned: 'Reassigned', terminated: 'Terminated' });
export const CR_STATUS_VALUES = all          ()(['draft', 'submitted', 'approved', 'rejected', 'closed']);
export const CR_STATUS_OPTIONS = table(CR_STATUS_VALUES, { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected', closed: 'Closed' });

// ---------------------------------------------------------------------------
// Methodology: phases, strategies and execution methods (research 6(a), 6(d), 6(e))
// ---------------------------------------------------------------------------

export const MIGRATION_PHASE_VALUES = all                ()([
  'strategy', 'discover-assess', 'plan', 'foundation', 'prepare-pilot', 'replicate-test', 'cutover', 'hypercare', 'decommission', 'optimize',
]);
const PHASE_LABELS                                           = {
  strategy: 'P0 Strategy & business case',
  'discover-assess': 'P1 Discover & assess',
  plan: 'P2 Plan: strategy, move groups & waves',
  foundation: 'P3 Foundation / landing zone',
  'prepare-pilot': 'P4 Prepare & pilot',
  'replicate-test': 'P5 Replicate & test',
  cutover: 'P6 Cutover (and rollback)',
  hypercare: 'P7 Hypercare & handover',
  decommission: 'P8 Decommission & retire',
  optimize: 'P9 Optimize & operate',
};
export const MIGRATION_PHASE_OPTIONS = table(MIGRATION_PHASE_VALUES, PHASE_LABELS);
export const WORKSTREAM_VALUES = all            ()([
  'strategy', 'discover-assess', 'plan', 'foundation', 'prepare-pilot', 'replicate-test', 'cutover', 'hypercare', 'decommission', 'optimize',
  'governance',
]);
export const WORKSTREAM_OPTIONS = table(WORKSTREAM_VALUES, { ...PHASE_LABELS, governance: 'G Governance (runs throughout)' });
/** The phase an item is in, from its tracker state. */
export const ITEM_STATE_PHASE                                              = {
  planned: 'plan',
  prepared: 'prepare-pilot',
  replicating: 'replicate-test',
  'in-sync': 'replicate-test',
  testing: 'replicate-test',
  tested: 'replicate-test',
  'cutting-over': 'cutover',
  'cut-over': 'hypercare',
  validated: 'hypercare',
  accepted: 'hypercare',
  decommissioned: 'decommission',
};

export const MIGRATION_STRATEGY_VALUES = all                   ()([
  'retire', 'retain', 'rehost', 'relocate', 'replatform', 'refactor', 'revise', 'rearchitect', 'rebuild', 'repurchase', 'reimagine',
]);
/** Neutral labels; `strategyLabel(s, platform)` in methodology.ts gives the provider's own word. */
export const MIGRATION_STRATEGY_OPTIONS = table(MIGRATION_STRATEGY_VALUES, {
  retire: 'Retire',
  retain: 'Retain',
  rehost: 'Rehost',
  relocate: 'Relocate',
  replatform: 'Replatform',
  refactor: 'Refactor',
  revise: 'Revise',
  rearchitect: 'Rearchitect',
  rebuild: 'Rebuild',
  repurchase: 'Replace / Repurchase',
  reimagine: 'Reimagine',
});
/** The strategy a plan disposition implies ('new' is greenfield: no R). */
export const STRATEGY_OF_DISPOSITION                                                               = {
  rehost: 'rehost',
  relocate: 'relocate',
  replatform: 'replatform',
  refactor: 'refactor',
  repurchase: 'repurchase',
  retire: 'retire',
  retain: 'retain',
  new: undefined,
};
/** The plan disposition a strategy runs as (the engine knows the six Rs plus new). */
export const DISPOSITION_OF_STRATEGY                                                   = {
  retire: 'retire',
  retain: 'retain',
  rehost: 'rehost',
  relocate: 'relocate',
  replatform: 'replatform',
  refactor: 'refactor',
  revise: 'refactor',
  rearchitect: 'refactor',
  rebuild: 'refactor',
  repurchase: 'repurchase',
  reimagine: 'refactor',
};
/** An item's strategy: its own, else the one its disposition implies. */
export function strategyOf(item                                                                               )                                {
  return item.strategy ?? (item.disposition ? STRATEGY_OF_DISPOSITION[item.disposition] : undefined);
}

export const EXECUTION_METHOD_VALUES = all                 ()([
  'aws-transform-mgn', 'aws-vm-import', 'aws-dms', 'aws-datasync', 'aws-app2container',
  'azure-migrate-agentless', 'azure-migrate-agent', 'azure-dms', 'azure-data-box', 'azure-storage-mover',
  'gcp-m2vm', 'gcp-m2c', 'gcp-image-import', 'gcp-dms', 'gcp-sts', 'gcp-transfer-appliance',
  'oci-ocm', 'oci-zdm-physical', 'oci-zdm-logical', 'oci-dms', 'oracle-data-guard',
  'hcx-bulk', 'hcx-vmotion', 'hcx-cold', 'hcx-rav', 'hcx-osam', 'hcx-assisted-vmotion', 'xvc-vmotion',
  'vcf-import', 'vcf-converter',
  'rebuild', 'with-server', 'native-db', 'sap-hsr', 'saas-migration', 'k8s-velero', 'deploy', 'specialist', 'none',
]);
/** The provider each method belongs to ('any' = not one provider's tool). */
export const EXECUTION_METHOD_PROVIDER                                                    = {
  'aws-transform-mgn': 'aws', 'aws-vm-import': 'aws', 'aws-dms': 'aws', 'aws-datasync': 'aws', 'aws-app2container': 'aws',
  'azure-migrate-agentless': 'azure', 'azure-migrate-agent': 'azure', 'azure-dms': 'azure', 'azure-data-box': 'azure', 'azure-storage-mover': 'azure',
  'gcp-m2vm': 'google', 'gcp-m2c': 'google', 'gcp-image-import': 'google', 'gcp-dms': 'google', 'gcp-sts': 'google', 'gcp-transfer-appliance': 'google',
  'oci-ocm': 'oci', 'oci-zdm-physical': 'oci', 'oci-zdm-logical': 'oci', 'oci-dms': 'oci', 'oracle-data-guard': 'any',
  'hcx-bulk': 'vmware', 'hcx-vmotion': 'vmware', 'hcx-cold': 'vmware', 'hcx-rav': 'vmware', 'hcx-osam': 'vmware',
  'hcx-assisted-vmotion': 'vmware', 'xvc-vmotion': 'vmware', 'vcf-import': 'vmware', 'vcf-converter': 'vmware',
  rebuild: 'any', 'with-server': 'any', 'native-db': 'any', 'sap-hsr': 'any', 'saas-migration': 'any', 'k8s-velero': 'any',
  deploy: 'any', specialist: 'any', none: 'any',
};
export const EXECUTION_METHOD_OPTIONS = table(
  EXECUTION_METHOD_VALUES,
  {
    'aws-transform-mgn': 'AWS Transform MGN (formerly AWS Application Migration Service)',
    'aws-vm-import': 'VM Import/Export',
    'aws-dms': 'AWS Database Migration Service',
    'aws-datasync': 'AWS DataSync',
    'aws-app2container': 'AWS App2Container',
    'azure-migrate-agentless': 'Azure Migrate (agentless)',
    'azure-migrate-agent': 'Azure Migrate (agent-based)',
    'azure-dms': 'Azure Database Migration Service',
    'azure-data-box': 'Azure Data Box',
    'azure-storage-mover': 'Azure Storage Mover',
    'gcp-m2vm': 'Migrate to Virtual Machines',
    'gcp-m2c': 'Migrate to Containers',
    'gcp-image-import': 'Compute Engine image import',
    'gcp-dms': 'Database Migration Service (Google Cloud (GCP))',
    'gcp-sts': 'Storage Transfer Service',
    'gcp-transfer-appliance': 'Transfer Appliance',
    'oci-ocm': 'Oracle Cloud Migrations',
    'oci-zdm-physical': 'Zero Downtime Migration (physical)',
    'oci-zdm-logical': 'Zero Downtime Migration (logical)',
    'oci-dms': 'OCI Database Migration',
    'oracle-data-guard': 'Oracle Data Guard',
    'hcx-bulk': 'HCX Bulk Migration',
    'hcx-vmotion': 'HCX vMotion',
    'hcx-cold': 'HCX Cold Migration',
    'hcx-rav': 'HCX Replication Assisted vMotion',
    'hcx-osam': 'HCX OS Assisted Migration',
    'hcx-assisted-vmotion': 'HCX Assisted vMotion (Direct)',
    'xvc-vmotion': 'Cross-vCenter vMotion',
    'vcf-import': 'VCF Import / Converge (in place)',
    'vcf-converter': 'vCenter Converter',
    rebuild: 'Rebuild from image',
    'with-server': 'Moves inside its server',
    'native-db': 'Database-native replication or backup and restore',
    'sap-hsr': 'SAP HANA System Replication',
    'saas-migration': 'SaaS migration tooling',
    'k8s-velero': 'Velero backup and restore',
    deploy: 'Deploy (new service)',
    specialist: 'Specialist (partner or manual)',
    none: 'No move',
  },
  (v) => {
    const p = EXECUTION_METHOD_PROVIDER[v];
    return p === 'any' ? 'Any platform' : p === 'vmware' ? 'VMware' : PLATFORM_LABELS[p];
  },
);
/** The execution method a generated move path uses. */
export const METHOD_OF_PATH                                                           = {
  'hcx-bulk': 'hcx-bulk', 'hcx-rav': 'hcx-rav', 'hcx-vmotion': 'hcx-vmotion', 'hcx-cold': 'hcx-cold', 'hcx-osam': 'hcx-osam',
  'xvc-vmotion': 'xvc-vmotion', 'vcf-import': 'vcf-import', 'vcf-converter': 'vcf-converter',
  'aws-mgn': 'aws-transform-mgn', 'azure-migrate': 'azure-migrate-agentless', 'azure-migrate-hyperv': 'azure-migrate-agentless',
  'azure-migrate-agent': 'azure-migrate-agent', 'gcp-m2vm': 'gcp-m2vm', 'gcp-image-import': 'gcp-image-import', 'oci-ocm': 'oci-ocm',
  rebuild: 'rebuild', 'with-db': 'with-server', retire: 'none', specialist: 'specialist', deploy: 'deploy',
  'sap-hsr': 'sap-hsr', 'sap-backup-restore': 'native-db', 'saas-exchange': 'saas-migration', 'saas-sharepoint': 'saas-migration',
  'k8s-velero': 'k8s-velero', 'appliance-rebuild': 'rebuild',
  'with-vm': 'with-server', 'oracle-zdm-physical': 'oci-zdm-physical', 'oracle-zdm-logical': 'oci-zdm-logical',
  'oracle-dataguard': 'oracle-data-guard', 'oracle-rman': 'native-db', 'oracle-datapump': 'native-db',
  'oci-dms': 'oci-dms', 'aws-dms': 'aws-dms', 'azure-dms': 'azure-dms', 'azure-pg-migration': 'azure-dms', 'gcp-dms': 'gcp-dms',
  'sql-ag-seeding': 'native-db', 'sql-log-shipping': 'native-db', 'sql-backup-url': 'native-db', 'sql-mi-link': 'native-db',
  'sql-mi-lrs': 'native-db', 'sql-rds-native': 'native-db', 'pg-logical': 'native-db', 'pg-dump': 'native-db',
  'mysql-replication': 'native-db', 'mysql-dump': 'native-db', 'db2-backup-restore': 'native-db', 'db2-hadr': 'native-db',
  'ase-dump-load': 'native-db', 'informix-backup-restore': 'native-db', 'mongo-mongosync': 'native-db',
  'redis-replicaof': 'native-db', 'redis-rdb-import': 'native-db', 'cassandra-zdm-proxy': 'native-db', 'cassandra-ring-join': 'native-db',
  'es-snapshot-restore': 'native-db', 'es-reindex-remote': 'native-db',
};
/** The methods a platform offers: its own tools and the platform-neutral ones. */
export function executionMethodsFor(platform          )                             {
  return EXECUTION_METHOD_VALUES.filter((m) => EXECUTION_METHOD_PROVIDER[m] === platform || EXECUTION_METHOD_PROVIDER[m] === 'any');
}
export const METHOD_PROVIDER_VALUES = all                ()(['aws', 'azure', 'google', 'oci', 'vmware', 'any']);
export const METHOD_PROVIDER_OPTIONS = table(METHOD_PROVIDER_VALUES, { ...PLATFORM_LABELS, any: 'Any platform' });

export const PROVIDER_TERM_VALUES = all              ()([
  'framework', 'phases', 'move-group', 'wave', 'iteration', 'factory', 'readiness', 'sizing-basis', 'data-quality',
  'cost-document', 'test-run', 'cutover', 'rollback', 'hypercare', 'landing-zone', 'collector',
]);
/** The neutral (ArchToolKit) word for each concept; `providerTerm` in methodology.ts gives each provider's. */
export const PROVIDER_TERM_OPTIONS = table(PROVIDER_TERM_VALUES, {
  framework: 'Framework',
  phases: 'Phases',
  'move-group': 'Move group',
  wave: 'Wave',
  iteration: 'Iteration',
  factory: 'Migration factory',
  readiness: 'Readiness',
  'sizing-basis': 'Sizing basis',
  'data-quality': 'Data quality',
  'cost-document': 'Business case',
  'test-run': 'Test migration',
  cutover: 'Cutover',
  rollback: 'Rollback',
  hypercare: 'Hypercare',
  'landing-zone': 'Landing zone',
  collector: 'Discovery collector',
});
export const SERVICE_STATUS_KIND_VALUES = all                   ()(['available', 'renamed', 'closed-to-new-customers', 'end-of-support', 'retired', 'removed', 'reintroduced', 'ga']);
export const SERVICE_STATUS_KIND_OPTIONS = table(SERVICE_STATUS_KIND_VALUES, {
  available: 'Available',
  renamed: 'Renamed',
  'closed-to-new-customers': 'Closed to new customers',
  'end-of-support': 'End of support',
  retired: 'Retired',
  removed: 'Removed',
  reintroduced: 'Reintroduced',
  ga: 'Generally available',
});
export const LIFECYCLE_TOOL_VALUES = all               ()(['aws-transform-mgn', 'azure-migrate', 'gcp-m2vm', 'gcp-dms', 'hcx-mobility-group', 'oci-ocm']);
export const LIFECYCLE_TOOL_OPTIONS = table(LIFECYCLE_TOOL_VALUES, {
  'aws-transform-mgn': 'AWS Transform MGN',
  'azure-migrate': 'Azure Migrate',
  'gcp-m2vm': 'Migrate to Virtual Machines',
  'gcp-dms': 'Database Migration Service (Google Cloud (GCP))',
  'hcx-mobility-group': 'HCX Mobility Group',
  'oci-ocm': 'Oracle Cloud Migrations',
});

// ---------------------------------------------------------------------------
// Addendum defaults
// ---------------------------------------------------------------------------

/** A.2.8: auto basis, p95, 30% headroom (the 1.3 comfort factor), provisioned disks, 10% growth over 3 years. */
export const DEFAULT_SIZING_POLICY               = Object.freeze({
  basis: 'auto',
  percentile: 'p95',
  headroomPct: 30,
  diskBasis: 'provisioned',
  growthPctYear: 10,
  horizonYears: 3,
  families: Object.freeze(['general', 'compute', 'memory', 'burstable', 'storage'])                             ,
  burstableInProd: false,
  allowArm: false,
  latestGeneration: true,
  licenceOptimised: true,
  assumptions: Object.freeze({}),
});
export function defaultSizing()              {
  return { policy: { ...DEFAULT_SIZING_POLICY, families: [...DEFAULT_SIZING_POLICY.families], assumptions: {} }, overrides: {} };
}
/** A.6.1: keep the source after cutover, by criticality. */
export const DEFAULT_KEEP_DAYS                                        = Object.freeze({ tier0: 30, tier1: 21, tier2: 14, tier3: 7 });
/** A.7.5: hypercare length, by criticality. */
export const DEFAULT_HYPERCARE_DAYS                                        = Object.freeze({ tier0: 14, tier1: 10, tier2: 7, tier3: 3 });
export function defaultExecution()                    {
  return {
    pathOverrides: {},
    keepDays: { ...DEFAULT_KEEP_DAYS },
    hypercareDays: { ...DEFAULT_HYPERCARE_DAYS },
    lagSeconds: { server: 60, db: 0 },
    dnsZones: [],
    lbs: [],
    dataSets: [],
    vcfImportClusters: [],
    landingZones: {},
  };
}
export function defaultGovernance()             {
  return { raci: [], cr: { system: 'none', perWave: false }, comms: {}, cicd: 'none', environments: ['prod'] };
}
export function defaultDcExit()         {
  return { dualRunningDays: 0, hardwareRemovalDays: 0, infra: [], external: [], contracts: [], assets: [] };
}
/** A.2.1: the default grouping order. */
export const DEFAULT_GROUPING                          = Object.freeze([
  Object.freeze({ rule: 'attribute', key: 'app|application|service' }),
  Object.freeze({ rule: 'cloud-tag', key: 'app|application' }),
  Object.freeze({ rule: 'folder-leaf' }),
  Object.freeze({ rule: 'name-regex' }),
]                  );

// ---------------------------------------------------------------------------
// Every table, for tests and for anything that walks them
// ---------------------------------------------------------------------------

                              
                        
                                     
                                          
 
export const OPTION_TABLES                         = Object.freeze([
  { name: 'Platform', values: PLATFORM_VALUES, options: PLATFORM_OPTIONS },
  { name: 'OsId', values: OS_VALUES, options: OS_OPTIONS },
  { name: 'Env', values: ENV_VALUES, options: ENV_OPTIONS },
  { name: 'Role', values: ROLE_VALUES, options: ROLE_OPTIONS },
  { name: 'Criticality', values: CRITICALITY_VALUES, options: CRITICALITY_OPTIONS },
  { name: 'Rpo', values: RPO_VALUES, options: RPO_OPTIONS },
  { name: 'Rto', values: RTO_VALUES, options: RTO_OPTIONS },
  { name: 'OsLicence', values: OS_LICENCE_VALUES, options: OS_LICENCE_OPTIONS },
  { name: 'Residency', values: RESIDENCY_VALUES, options: RESIDENCY_OPTIONS },
  { name: 'Disposition', values: DISPOSITION_VALUES, options: DISPOSITION_OPTIONS },
  { name: 'Method', values: METHOD_VALUES, options: METHOD_OPTIONS },
  { name: 'DbEngine', values: DB_ENGINE_VALUES, options: DB_ENGINE_OPTIONS },
  { name: 'DbEdition', values: DB_EDITION_VALUES, options: DB_EDITION_OPTIONS },
  { name: 'DbVersionId', values: DB_VERSION_VALUES, options: DB_VERSION_OPTIONS },
  { name: 'DbHa', values: DB_HA_VALUES, options: DB_HA_OPTIONS },
  { name: 'DbDr', values: DB_DR_VALUES, options: DB_DR_OPTIONS },
  { name: 'DbFeature', values: DB_FEATURE_VALUES, options: DB_FEATURE_OPTIONS },
  { name: 'DbLicence', values: DB_LICENCE_VALUES, options: DB_LICENCE_OPTIONS },
  { name: 'DbServiceId', values: DB_SERVICE_VALUES, options: DB_SERVICE_OPTIONS },
  { name: 'Special', values: SPECIAL_VALUES, options: SPECIAL_OPTIONS },
  { name: 'Latency', values: LATENCY_VALUES, options: LATENCY_OPTIONS },
  { name: 'EdgeKind', values: EDGE_KIND_VALUES, options: EDGE_KIND_OPTIONS },
  { name: 'WavePin', values: WAVE_PIN_VALUES, options: WAVE_PIN_OPTIONS },
  { name: 'MaxPlatforms', values: MAX_PLATFORMS_VALUES, options: MAX_PLATFORMS_OPTIONS },
  { name: 'Framework', values: FRAMEWORK_VALUES, options: FRAMEWORK_OPTIONS },
  { name: 'Sovereignty', values: SOVEREIGNTY_VALUES, options: SOVEREIGNTY_OPTIONS },
  { name: 'SecurityBaseline', values: SECURITY_BASELINE_VALUES, options: SECURITY_BASELINE_OPTIONS },
  { name: 'KeyManagement', values: KEY_MANAGEMENT_VALUES, options: KEY_MANAGEMENT_OPTIONS },
  { name: 'Bandwidth', values: BANDWIDTH_VALUES, options: BANDWIDTH_OPTIONS },
  { name: 'Circuit', values: CIRCUIT_VALUES, options: CIRCUIT_OPTIONS },
  { name: 'Connection', values: CONNECTION_VALUES, options: CONNECTION_OPTIONS },
  { name: 'AdStrategy', values: AD_STRATEGY_VALUES, options: AD_STRATEGY_OPTIONS },
  { name: 'LinuxJoin', values: LINUX_JOIN_VALUES, options: LINUX_JOIN_OPTIONS },
  { name: 'CloudSignIn', values: CLOUD_SIGN_IN_VALUES, options: CLOUD_SIGN_IN_OPTIONS },
  { name: 'DnsStrategy', values: DNS_STRATEGY_VALUES, options: DNS_STRATEGY_OPTIONS },
  { name: 'BackupTierId', values: BACKUP_TIER_VALUES, options: BACKUP_TIER_OPTIONS },
  { name: 'BackupFrequency', values: BACKUP_FREQUENCY_VALUES, options: BACKUP_FREQUENCY_OPTIONS },
  { name: 'DrPattern', values: DR_PATTERN_VALUES, options: DR_PATTERN_OPTIONS },
  { name: 'CostModel', values: COST_MODEL_VALUES, options: COST_MODEL_OPTIONS },
  { name: 'Agreement', values: AGREEMENT_VALUES, options: AGREEMENT_OPTIONS },
  { name: 'MicrosoftSa', values: MICROSOFT_SA_VALUES, options: MICROSOFT_SA_OPTIONS },
  { name: 'OracleLicences', values: ORACLE_LICENCES_VALUES, options: ORACLE_LICENCES_OPTIONS },
  { name: 'YesNo', values: YES_NO_VALUES, options: YES_NO_OPTIONS },
  { name: 'Skill', values: SKILL_VALUES, options: SKILL_OPTIONS },
  { name: 'ExitStrategy', values: EXIT_STRATEGY_VALUES, options: EXIT_STRATEGY_OPTIONS },
  { name: 'SizeBy', values: SIZE_BY_VALUES, options: SIZE_BY_OPTIONS },
  { name: 'Monitoring', values: MONITORING_VALUES, options: MONITORING_OPTIONS },
  { name: 'Siem', values: SIEM_VALUES, options: SIEM_OPTIONS },
  { name: 'NetworkTier', values: NETWORK_TIER_VALUES, options: NETWORK_TIER_OPTIONS },
  { name: 'SubnetPrefix', values: SUBNET_PREFIX_VALUES, options: SUBNET_PREFIX_OPTIONS },
  { name: 'ZoneCount', values: ZONE_COUNT_VALUES, options: ZONE_COUNT_OPTIONS },
  { name: 'Bastion', values: BASTION_VALUES, options: BASTION_OPTIONS },
  { name: 'LogRetentionDays', values: LOG_RETENTION_VALUES, options: LOG_RETENTION_OPTIONS },
  { name: 'WaveMode', values: WAVE_MODE_VALUES, options: WAVE_MODE_OPTIONS },
  { name: 'WaveParallel', values: WAVE_PARALLEL_VALUES, options: WAVE_PARALLEL_OPTIONS },
  { name: 'WaveWeeks', values: WAVE_WEEKS_VALUES, options: WAVE_WEEKS_OPTIONS },
  { name: 'MergeMode', values: MERGE_MODE_VALUES, options: MERGE_MODE_OPTIONS },
  { name: 'AppAttributeSource', values: APP_ATTRIBUTE_SOURCE_VALUES, options: APP_ATTRIBUTE_SOURCE_OPTIONS },
  { name: 'EnvAttributeSource', values: ENV_ATTRIBUTE_SOURCE_VALUES, options: ENV_ATTRIBUTE_SOURCE_OPTIONS },
  { name: 'GeneratePart', values: GENERATE_PART_VALUES, options: GENERATE_PART_OPTIONS },
  { name: 'StateBackend', values: STATE_BACKEND_VALUES, options: STATE_BACKEND_OPTIONS },
  { name: 'ArchiveFormat', values: ARCHIVE_FORMAT_VALUES, options: ARCHIVE_FORMAT_OPTIONS },
  { name: 'LicenceKind', values: LICENCE_KIND_VALUES, options: LICENCE_KIND_OPTIONS },
  { name: 'LicenceModel', values: LICENCE_MODEL_VALUES, options: LICENCE_MODEL_OPTIONS },
  { name: 'PlanMode', values: PLAN_MODE_VALUES, options: PLAN_MODE_OPTIONS },
  { name: 'AppOrigin', values: APP_ORIGIN_VALUES, options: APP_ORIGIN_OPTIONS },
  { name: 'SourcePlatform', values: SOURCE_PLATFORM_VALUES, options: SOURCE_PLATFORM_OPTIONS },
  { name: 'SizingBasis', values: SIZING_BASIS_VALUES, options: SIZING_BASIS_OPTIONS },
  { name: 'IpStrategy', values: IP_STRATEGY_VALUES, options: IP_STRATEGY_OPTIONS },
  { name: 'OsUpgrade', values: OS_UPGRADE_VALUES, options: OS_UPGRADE_OPTIONS },
  { name: 'ListenProto', values: LISTEN_PROTO_VALUES, options: LISTEN_PROTO_OPTIONS },
  { name: 'WorkloadType', values: WORKLOAD_TYPE_VALUES, options: WORKLOAD_TYPE_OPTIONS },
  { name: 'AppKind', values: APP_KIND_VALUES, options: APP_KIND_OPTIONS },
  { name: 'AppPattern', values: APP_PATTERN_VALUES, options: APP_PATTERN_OPTIONS },
  { name: 'TierPattern', values: TIER_PATTERN_VALUES, options: TIER_PATTERN_OPTIONS },
  { name: 'ComponentTier', values: COMPONENT_TIER_VALUES, options: COMPONENT_TIER_OPTIONS },
  { name: 'ComponentKind', values: COMPONENT_KIND_VALUES, options: COMPONENT_KIND_OPTIONS },
  { name: 'ChangeWindow', values: CHANGE_WINDOW_VALUES, options: CHANGE_WINDOW_OPTIONS },
  { name: 'AppPlanStatus', values: APP_PLAN_STATUS_VALUES, options: APP_PLAN_STATUS_OPTIONS },
  { name: 'ComponentStatus', values: COMPONENT_STATUS_VALUES, options: COMPONENT_STATUS_OPTIONS },
  { name: 'IngressExposure', values: INGRESS_EXPOSURE_VALUES, options: INGRESS_EXPOSURE_OPTIONS },
  { name: 'IngressLb', values: INGRESS_LB_VALUES, options: INGRESS_LB_OPTIONS },
  { name: 'IngressTls', values: INGRESS_TLS_VALUES, options: INGRESS_TLS_OPTIONS },
  { name: 'CostClass', values: COST_CLASS_VALUES, options: COST_CLASS_OPTIONS },
  { name: 'Slo', values: SLO_VALUES, options: SLO_OPTIONS },
  { name: 'HorizonYears', values: HORIZON_YEARS_VALUES, options: HORIZON_YEARS_OPTIONS },
  { name: 'NonprodPct', values: NONPROD_PCT_VALUES, options: NONPROD_PCT_OPTIONS },
  { name: 'SmokeKind', values: SMOKE_KIND_VALUES, options: SMOKE_KIND_OPTIONS },
  { name: 'LandingZoneMode', values: LANDING_ZONE_MODE_VALUES, options: LANDING_ZONE_MODE_OPTIONS },
  { name: 'SizingConcern', values: SIZING_CONCERN_VALUES, options: SIZING_CONCERN_OPTIONS },
  { name: 'Percentile', values: PERCENTILE_VALUES, options: PERCENTILE_OPTIONS },
  { name: 'SizingPolicyBasis', values: SIZING_POLICY_BASIS_VALUES, options: SIZING_POLICY_BASIS_OPTIONS },
  { name: 'HeadroomPct', values: HEADROOM_PCT_VALUES, options: HEADROOM_PCT_OPTIONS },
  { name: 'DiskBasis', values: DISK_BASIS_VALUES, options: DISK_BASIS_OPTIONS },
  { name: 'GrowthPctYear', values: GROWTH_PCT_YEAR_VALUES, options: GROWTH_PCT_YEAR_OPTIONS },
  { name: 'InstanceFamily', values: INSTANCE_FAMILY_VALUES, options: INSTANCE_FAMILY_OPTIONS },
  { name: 'MovePath', values: MOVE_PATH_VALUES, options: MOVE_PATH_OPTIONS },
  { name: 'DbMovePath', values: DB_MOVE_PATH_VALUES, options: DB_MOVE_PATH_OPTIONS },
  { name: 'DnsProvider', values: DNS_PROVIDER_VALUES, options: DNS_PROVIDER_OPTIONS },
  { name: 'LbKind', values: LB_KIND_VALUES, options: LB_KIND_OPTIONS },
  { name: 'DataCopyMethod', values: DATA_COPY_METHOD_VALUES, options: DATA_COPY_METHOD_OPTIONS },
  { name: 'LandingZoneState', values: LANDING_ZONE_STATE_VALUES, options: LANDING_ZONE_STATE_OPTIONS },
  { name: 'MgnReplication', values: MGN_REPLICATION_VALUES, options: MGN_REPLICATION_OPTIONS },
  { name: 'MgnIpProtocol', values: MGN_IP_PROTOCOL_VALUES, options: MGN_IP_PROTOCOL_OPTIONS },
  { name: 'AzureMigrateDiskType', values: AZURE_MIGRATE_DISK_TYPE_VALUES, options: AZURE_MIGRATE_DISK_TYPE_OPTIONS },
  { name: 'AzureSecurityType', values: AZURE_SECURITY_TYPE_VALUES, options: AZURE_SECURITY_TYPE_OPTIONS },
  { name: 'DmsCapacityUnits', values: DMS_CAPACITY_UNITS_VALUES, options: DMS_CAPACITY_UNITS_OPTIONS },
  { name: 'HcxWindowHours', values: HCX_WINDOW_HOURS_VALUES, options: HCX_WINDOW_HOURS_OPTIONS },
  { name: 'WaveKind', values: WAVE_KIND_VALUES, options: WAVE_KIND_OPTIONS },
  { name: 'GroupingRuleKind', values: GROUPING_RULE_VALUES, options: GROUPING_RULE_OPTIONS },
  { name: 'RaciRole', values: RACI_ROLE_VALUES, options: RACI_ROLE_OPTIONS },
  { name: 'RaciCell', values: RACI_CELL_VALUES, options: RACI_CELL_OPTIONS },
  { name: 'RaciPhase', values: RACI_PHASE_VALUES, options: RACI_PHASE_OPTIONS },
  { name: 'CrSystem', values: CR_SYSTEM_VALUES, options: CR_SYSTEM_OPTIONS },
  { name: 'Cicd', values: CICD_VALUES, options: CICD_OPTIONS },
  { name: 'InfraCategory', values: INFRA_CATEGORY_VALUES, options: INFRA_CATEGORY_OPTIONS },
  { name: 'InfraDisposition', values: INFRA_DISPOSITION_VALUES, options: INFRA_DISPOSITION_OPTIONS },
  { name: 'ExternalKind', values: EXTERNAL_KIND_VALUES, options: EXTERNAL_KIND_OPTIONS },
  { name: 'ExternalDirection', values: EXTERNAL_DIRECTION_VALUES, options: EXTERNAL_DIRECTION_OPTIONS },
  { name: 'ContractKind', values: CONTRACT_KIND_VALUES, options: CONTRACT_KIND_OPTIONS },
  { name: 'Sanitisation', values: SANITISATION_VALUES, options: SANITISATION_OPTIONS },
  { name: 'RateCategory', values: RATE_CATEGORY_VALUES, options: RATE_CATEGORY_OPTIONS },
  { name: 'AuditPage', values: AUDIT_PAGE_VALUES, options: AUDIT_PAGE_OPTIONS },
  { name: 'ItemState', values: ITEM_STATE_VALUES, options: ITEM_STATE_OPTIONS },
  { name: 'ItemFlag', values: ITEM_FLAG_VALUES, options: ITEM_FLAG_OPTIONS },
  { name: 'StepId', values: STEP_ID_VALUES, options: STEP_ID_OPTIONS },
  { name: 'Outcome', values: OUTCOME_VALUES, options: OUTCOME_OPTIONS },
  { name: 'StatusChannel', values: STATUS_CHANNEL_VALUES, options: STATUS_CHANNEL_OPTIONS },
  { name: 'StatusEventSource', values: STATUS_EVENT_SOURCE_VALUES, options: STATUS_EVENT_SOURCE_OPTIONS },
  { name: 'ItemStatusKind', values: ITEM_STATUS_KIND_VALUES, options: ITEM_STATUS_KIND_OPTIONS },
  { name: 'GateId', values: GATE_ID_VALUES, options: GATE_ID_OPTIONS },
  { name: 'GateDecision', values: GATE_DECISION_VALUES, options: GATE_DECISION_OPTIONS },
  { name: 'SignOffScope', values: SIGN_OFF_SCOPE_VALUES, options: SIGN_OFF_SCOPE_OPTIONS },
  { name: 'SignOffKind', values: SIGN_OFF_KIND_VALUES, options: SIGN_OFF_KIND_OPTIONS },
  { name: 'SignOffDecision', values: SIGN_OFF_DECISION_VALUES, options: SIGN_OFF_DECISION_OPTIONS },
  { name: 'RaidScore', values: RAID_SCORE_VALUES, options: RAID_SCORE_OPTIONS },
  { name: 'RiskResponse', values: RISK_RESPONSE_VALUES, options: RISK_RESPONSE_OPTIONS },
  { name: 'RiskStatus', values: RISK_STATUS_VALUES, options: RISK_STATUS_OPTIONS },
  { name: 'AssumptionStatus', values: ASSUMPTION_STATUS_VALUES, options: ASSUMPTION_STATUS_OPTIONS },
  { name: 'IssueSeverity', values: ISSUE_SEVERITY_VALUES, options: ISSUE_SEVERITY_OPTIONS },
  { name: 'IssueStatus', values: ISSUE_STATUS_VALUES, options: ISSUE_STATUS_OPTIONS },
  { name: 'IssueOrigin', values: ISSUE_ORIGIN_VALUES, options: ISSUE_ORIGIN_OPTIONS },
  { name: 'DecisionSource', values: DECISION_SOURCE_VALUES, options: DECISION_SOURCE_OPTIONS },
  { name: 'ReclaimedLicence', values: RECLAIMED_LICENCE_VALUES, options: RECLAIMED_LICENCE_OPTIONS },
  { name: 'LicenceReclaimStatus', values: LICENCE_RECLAIM_STATUS_VALUES, options: LICENCE_RECLAIM_STATUS_OPTIONS },
  { name: 'CrStatus', values: CR_STATUS_VALUES, options: CR_STATUS_OPTIONS },
  { name: 'MigrationPhase', values: MIGRATION_PHASE_VALUES, options: MIGRATION_PHASE_OPTIONS },
  { name: 'Workstream', values: WORKSTREAM_VALUES, options: WORKSTREAM_OPTIONS },
  { name: 'MigrationStrategy', values: MIGRATION_STRATEGY_VALUES, options: MIGRATION_STRATEGY_OPTIONS },
  { name: 'ExecutionMethod', values: EXECUTION_METHOD_VALUES, options: EXECUTION_METHOD_OPTIONS },
  { name: 'MethodProvider', values: METHOD_PROVIDER_VALUES, options: METHOD_PROVIDER_OPTIONS },
  { name: 'ProviderTerm', values: PROVIDER_TERM_VALUES, options: PROVIDER_TERM_OPTIONS },
  { name: 'ServiceStatusKind', values: SERVICE_STATUS_KIND_VALUES, options: SERVICE_STATUS_KIND_OPTIONS },
  { name: 'LifecycleTool', values: LIFECYCLE_TOOL_VALUES, options: LIFECYCLE_TOOL_OPTIONS },
]);

// ---------------------------------------------------------------------------
// Grid columns: the hint, the CSV header and the dropdown per column
// ---------------------------------------------------------------------------

                                                                
                             
                                  
                       
                                    
                        
                                                                                     
                         
                            
                                                                                     
                                           
                                                               
                          
 
const col = (key        , slug        , label        , kind            , options                        , blank         )             =>
  Object.freeze({ key, slug, label, kind, ...(options ? { options } : {}), ...(blank !== undefined ? { blank } : {}) });

/** Screen 2 and `workloads.csv`, in column order. */
export const WORKLOAD_COLUMNS                        = Object.freeze([
  col('name', 'name', 'Name', 'text'),
  col('app', 'app', 'App', 'text'),
  col('env', 'env', 'Env', 'select', ENV_OPTIONS),
  col('role', 'role', 'Role', 'select', ROLE_OPTIONS),
  col('os', 'os', 'OS', 'select', OS_OPTIONS),
  col('vcpu', 'vcpu', 'vCPU', 'number'),
  col('ramGib', 'ram_gib', 'RAM GiB', 'number'),
  col('disksGib', 'disks_gib', 'Disks GiB', 'text'),
  col('criticality', 'criticality', 'Criticality', 'select', CRITICALITY_OPTIONS),
  col('rpo', 'rpo', 'RPO', 'select', RPO_OPTIONS),
  col('rto', 'rto', 'RTO', 'select', RTO_OPTIONS),
  col('licence', 'licence', 'Licence', 'select', OS_LICENCE_OPTIONS),
  col('residency', 'residency', 'Residency', 'select', RESIDENCY_OPTIONS, 'App’s / any'),
  col('disposition', 'disposition', 'Disposition', 'select', DISPOSITION_OPTIONS, 'Decided by rules'),
  col('dependsOn', 'depends_on', 'Depends on', 'text'),
  col('pin', 'pin', 'Pin', 'select', PLATFORM_OPTIONS, 'Decided'),
]);

/** Screen 3 and `databases.csv`. */
export const DATABASE_COLUMNS                        = Object.freeze([
  col('name', 'name', 'Name', 'text'),
  col('engine', 'engine', 'Engine', 'select', DB_ENGINE_OPTIONS),
  col('edition', 'edition', 'Edition', 'select', DB_EDITION_OPTIONS),
  col('version', 'version', 'Version', 'select', DB_VERSION_OPTIONS),
  col('hosts', 'hosts', 'Hosts', 'text'),
  col('vcpu', 'vcpu', 'vCPU', 'number'),
  col('ramGib', 'ram_gib', 'RAM GiB', 'number'),
  col('sizeGib', 'size_gib', 'Size GiB', 'number'),
  col('ha', 'ha', 'HA', 'select', DB_HA_OPTIONS),
  col('dr', 'dr', 'DR', 'select', DB_DR_OPTIONS),
  col('features', 'features', 'Features', 'multi', DB_FEATURE_OPTIONS),
  col('licence', 'licence', 'Licence', 'select', DB_LICENCE_OPTIONS),
  col('app', 'app', 'App', 'text'),
  col('pinService', 'pin_service', 'Pin service', 'select', DB_SERVICE_OPTIONS, 'Decided'),
]);

/** Screen 4 and `apps.csv`. */
export const APP_COLUMNS                        = Object.freeze([
  col('name', 'app', 'App', 'text'),
  col('owner', 'owner', 'Owner', 'text'),
  col('criticality', 'criticality', 'Criticality', 'select', CRITICALITY_OPTIONS),
  col('residency', 'residency', 'Residency', 'select', RESIDENCY_OPTIONS),
  col('latencyToOnPrem', 'latency', 'Latency to on-prem', 'select', LATENCY_OPTIONS),
  col('deadlineMonths', 'deadline_months', 'Deadline (months)', 'number'),
  col('special', 'special', 'Special', 'select', SPECIAL_OPTIONS),
  col('route', 'route', 'Route', 'select', DISPOSITION_OPTIONS, 'Decided by rules'),
  col('wave', 'wave', 'Wave', 'select', WAVE_PIN_OPTIONS, 'Planned'),
  col('notes', 'notes', 'Notes', 'text'),
]);

/** Screen 4's dependency-kind grid. */
export const EDGE_COLUMNS                        = Object.freeze([
  col('from', 'from', 'From', 'text'),
  col('to', 'to', 'To', 'text'),
  col('kind', 'kind', 'Kind', 'select', EDGE_KIND_OPTIONS),
]);

/** Screen 5's sites grid and `sites.csv`. */
export const SITE_COLUMNS                        = Object.freeze([
  col('name', 'site', 'Site', 'text'),
  col('vpnPeer', 'vpn_peer', 'VPN peer address', 'text'),
  col('bgpAsn', 'bgp_asn', 'BGP ASN', 'number'),
  col('cidrs', 'cidrs', 'On-prem CIDRs', 'text'),
  col('bandwidth', 'bandwidth', 'Bandwidth', 'select', BANDWIDTH_OPTIONS),
  col('circuit', 'circuit', 'Private circuit', 'select', CIRCUIT_OPTIONS),
  col('circuitLocation', 'circuit_location', 'Circuit location', 'text'),
]);

export const BACKUP_TIER_COLUMNS                        = Object.freeze([
  col('tier', 'tier', 'Tier', 'select', BACKUP_TIER_OPTIONS),
  col('frequency', 'frequency', 'Frequency', 'select', BACKUP_FREQUENCY_OPTIONS),
  col('retentionDays', 'retention_days', 'Retention days', 'number'),
  col('copyToDr', 'copy_to_dr', 'Copy to DR region', 'select', YES_NO_OPTIONS),
  col('immutable', 'immutable', 'Immutable', 'select', YES_NO_OPTIONS),
]);

export const COMMITMENT_COLUMNS                        = Object.freeze([
  col('platform', 'platform', 'Platform', 'select', PLATFORM_OPTIONS),
  col('agreement', 'agreement', 'Agreement', 'select', AGREEMENT_OPTIONS),
  col('annual', 'annual', 'Annual commit', 'number'),
  col('ends', 'ends', 'Ends', 'text'),
]);

export const SKILL_COLUMNS                        = Object.freeze([
  col('platform', 'platform', 'Platform', 'select', PLATFORM_OPTIONS),
  col('skill', 'skill', 'Skill', 'select', SKILL_OPTIONS),
]);

export const NETWORK_COLUMNS                        = Object.freeze([
  col('name', 'network', 'Network', 'text'),
  col('envs', 'environments', 'Environments', 'multi', ENV_OPTIONS),
  col('cidr', 'ipv4_cidr', 'IPv4 CIDR', 'text'),
  col('ipv6', 'ipv6', 'IPv6', 'select', YES_NO_OPTIONS),
  col('tiers', 'tiers', 'Tiers', 'multi', NETWORK_TIER_OPTIONS),
]);

export const FREEZE_COLUMNS                        = Object.freeze([
  col('from', 'from', 'From', 'text'),
  col('to', 'to', 'To', 'text'),
  col('reason', 'reason', 'Reason', 'text'),
]);

// ---------------------------------------------------------------------------
// Addendum A.3.2: the server columns workloads.csv also accepts
// ---------------------------------------------------------------------------

/**
 * Read from `workloads.csv` (and `servers.csv`, which is the same file with
 * these filled) after `WORKLOAD_COLUMNS`. They land in `origin`, `sourceRef`,
 * `workloadType` and `facts`, not in grid columns.
 */
export const WORKLOAD_SOURCE_COLUMNS                        = Object.freeze([
  col('origin', 'origin', 'Origin', 'select', SOURCE_PLATFORM_OPTIONS),
  col('sourceManager', 'source_manager', 'Source manager', 'text'),
  col('sourceId', 'source_id', 'Source id', 'text'),
  col('host', 'host', 'Host', 'text'),
  col('bmc', 'bmc', 'BMC address', 'text'),
  col('workloadType', 'workload_type', 'Workload type', 'select', WORKLOAD_TYPE_OPTIONS),
  col('cpuP95Pct', 'cpu_p95_pct', 'CPU p95 %', 'number'),
  col('memP95Gib', 'mem_p95_gib', 'Memory p95 GiB', 'number'),
  col('iopsP95', 'iops_p95', 'IOPS p95', 'number'),
  col('mbpsP95', 'mbps_p95', 'MB/s p95', 'number'),
  col('utilDays', 'util_days', 'Utilisation days', 'number'),
  col('software', 'software', 'Software', 'text'),
  col('ports', 'ports', 'Listening ports', 'text'),
]);

/** The grid hint: column labels joined with " | ", as `tableEditor` takes it. */
export function gridHint(columns                       )         {
  return columns.map((c) => c.label).join(' | ');
}
/** The CSV header line. */
export function csvHeader(columns                       )         {
  return columns.map((c) => c.slug).join(',');
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** A name as it appears in an id: lower case, runs of anything else become one hyphen. */
export function slugName(name        )         {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
const ID_PREFIX                                     = { workload: 'w', database: 'd', app: 'a' };
/** `'w:<slug(name)>'` | `'d:<slug(name)>'` | `'a:<slug(app)>'`. Stable for a name. */
export function itemId(kind          , name        )         {
  return `${ID_PREFIX[kind]}:${slugName(name)}`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_REGIONS                                                                    = {
  aws: { primary: 'us-east-1' },
  azure: { primary: 'eastus' },
  google: { primary: 'us-central1' },
  oci: { primary: 'us-ashburn-1' },
};

export const DEFAULT_BACKUP_TIERS                        = Object.freeze([
  { tier: 'gold', frequency: '1h', retentionDays: 35, copyToDr: true, immutable: true },
  { tier: 'silver', frequency: '4h', retentionDays: 30, copyToDr: true, immutable: false },
  { tier: 'bronze', frequency: '24h', retentionDays: 14, copyToDr: false, immutable: false },
]);

export const DEFAULT_DR_PATTERN                                           = {
  tier0: 'warm-standby',
  tier1: 'pilot-light',
  tier2: 'backup-restore',
  tier3: 'backup-restore',
};

/** A fresh plan's requirements: every platform allowed, at most two, the design's defaults. */
export function defaultRequirements()               {
  return {
    allowed: [...PLATFORM_VALUES],
    maxPlatforms: 2,
    regions: { ...DEFAULT_REGIONS },
    timelineMonths: 12,
    frameworks: [],
    sovereignty: 'none',
    defaultResidency: 'any',
    securityBaseline: 'cis-l1',
    keys: 'customer-managed',
    sites: [],
    connection: 'vpn',
    identity: {
      adStrategy: 'extend-dcs',
      domain: 'corp.example.com',
      computerOu: 'OU=Servers,DC=corp,DC=example,DC=com',
      linuxJoin: 'realmd-sssd',
      cloudSignIn: 'entra-id',
      dns: 'cloud-private-dns-with-conditional-forwarders',
    },
    backupTiers: DEFAULT_BACKUP_TIERS.map((t) => ({ ...t })),
    drPattern: { ...DEFAULT_DR_PATTERN },
    costModel: 'reserved-3y',
    commitments: [],
    licensing: {
      microsoftSa: 'no',
      windowsPre2019Licences: false,
      oracle: 'none',
      oracleSupportRewards: false,
      portableVcf: false,
      linuxBring: false,
    },
    skills: {},
    exit: 'balanced',
    sizeBy: 'allocated',
    // "both when vmware is allowed", and it is by default.
    monitoring: 'both',
    siem: 'none',
  };
}

/** Screen 5: circuit-with-vpn-backup when any site has a circuit, else vpn. */
export function defaultConnection(sites                       )             {
  return sites.some((s) => s.circuit !== 'none') ? 'circuit-with-vpn-backup' : 'vpn';
}

export const DEFAULT_WAVE_SETTINGS               = Object.freeze({
  mode: 'default',
  maxPerWave: 50,
  parallel: 1,
  weeks: 2,
  freezes: Object.freeze([]),
});

export const DEFAULT_INTAKE                 = Object.freeze({
  scope: '',
  includePoweredOff: false,
  appAttribute: '',
  envAttribute: '',
  ownerAttribute: '',
  mergeMode: 'merge',
});

export const DEFAULT_GENERATE                   = Object.freeze({
  parts: GENERATE_PART_VALUES,
  backend: 'platform',
  archive: 'zip',
});

/** Screen 7 landing-zone defaults. */
export const DEFAULT_LANDING_ZONE = Object.freeze({
  subnetPrefix: '/22'                ,
  zonesProd: 3             ,
  zonesNonprod: 1             ,
  bastion: 'cloud-native'           ,
  logRetentionDays: 365                    ,
  tiers: Object.freeze(['web', 'app', 'db', 'mgmt']         ),
});
