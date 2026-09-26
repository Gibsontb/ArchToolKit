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

export const DISPOSITION_VALUES = all             ()(['rehost', 'relocate', 'replatform', 'refactor', 'repurchase', 'retire', 'retain']);
export const DISPOSITION_OPTIONS = table(DISPOSITION_VALUES, {
  rehost: 'Rehost (lift and shift)',
  relocate: 'Relocate (VMware to VMware)',
  replatform: 'Replatform',
  refactor: 'Refactor',
  repurchase: 'Repurchase (SaaS)',
  retire: 'Retire',
  retain: 'Retain on premises',
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

export const DB_ENGINE_VALUES = all          ()(['oracle', 'sqlserver', 'postgres', 'mysql', 'mariadb', 'db2', 'mongodb', 'sybase-ase', 'other']);
export const DB_ENGINE_OPTIONS = table(DB_ENGINE_VALUES, {
  oracle: 'Oracle Database',
  sqlserver: 'Microsoft SQL Server',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  db2: 'IBM Db2',
  mongodb: 'MongoDB',
  'sybase-ase': 'SAP ASE (Sybase)',
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
