/**
 * Database rules that are not licensing: managed services for open-source
 * engines, SQL Server instance features and clustering, Oracle RAC and Data
 * Guard, and the coupling of an IaaS database to its host VMs.
 */

import { warning } from '../../../../core/findings.js';
import { platformInfo,               } from '../../../platforms.js';
import { DB_SERVICES } from '../../db-catalog.js';
                                                                           
import { compareOptions, rule,              } from '../engine.js';

/** SQL Server features that need an instance (Agent, cross-database, linked servers, unsafe CLR). */
export const SQL_INSTANCE_FEATURES                       = ['agent-jobs', 'cross-db-queries', 'linked-servers', 'clr-unsafe'];

export const HOSTS_FOLLOW = 'db.hosts-follow';

const ADB = new Set(['aws-odb-adb', 'azure-odb-adb', 'google-odb-adb', 'oci-adb']);

export const DATABASE_RULES                     = [
  rule          ({
    id: 'db.managed-default',
    kind: 'database',
    verification: 'I',
    applies: (db) => db.engine === 'postgres' || db.engine === 'mysql' || db.engine === 'mariadb',
    evaluate: (_db, o) =>
      o.service && DB_SERVICES[o.service].managed
        ? { delta: 2, reason: 'An open-source engine on a managed service: patching, backup and failover are the provider’s.' }
        : undefined,
  }),

  rule          ({
    id: 'db.sql-instance-features',
    kind: 'database',
    verification: 'C',
    source: 'https://learn.microsoft.com/azure/azure-sql/database/transact-sql-tsql-differences-sql-server',
    applies: (db) => db.engine === 'sqlserver' && db.features.some((f) => SQL_INSTANCE_FEATURES.includes(f)),
    evaluate: (_db, o) => {
      if (o.service === 'azure-sqlmi') return { delta: 2, reason: 'SQL Managed Instance keeps instance features (Agent jobs, cross-database queries, linked servers).' };
      if (o.service === 'aws-rds') return { delta: 1, reason: 'RDS for SQL Server keeps most instance features (Agent jobs, linked servers).' };
      if (o.service === 'azure-sqldb') return { eliminate: true, reason: 'Azure SQL Database is a single database: no Agent jobs, cross-database queries or linked servers.' };
      return undefined;
    },
  }),

  rule          ({
    id: 'db.sql-fci',
    kind: 'database',
    verification: 'C',
    source: 'https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/failover-cluster-instance-overview',
    applies: (db) => db.ha === 'sql-fci',
    evaluate: (_db, o) => {
      if (o.service === 'azure-sqlvm') return { delta: 2, reason: 'Azure shared disks carry a failover cluster instance on SQL Server VMs.' };
      if (o.service === 'aws-ec2') return { delta: 1, reason: 'FSx for Windows File Server gives an FCI its shared storage on EC2.' };
      return undefined;
    },
    findings: (db) => [
      warning('plan.db.fci-shared-storage', `${db.name}: a failover cluster instance needs shared storage; consider an availability group instead.`, {
        path: `databases.${db.id}.ha`,
      }),
    ],
  }),

  rule          ({
    id: 'db.oracle-rac',
    kind: 'database',
    verification: 'C',
    source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
    applies: (db) => db.engine === 'oracle' && (db.ha === 'rac' || db.ha === 'rac-one-node'),
    evaluate: (_db, o) => {
      switch (o.service) {
        case 'oci-exacs':
          return { delta: 4, reason: 'Exadata is where RAC is native.' };
        case 'oci-basedb':
          return { delta: 3, reason: 'OCI Base Database runs two-node RAC on VM DB systems.' };
        case 'aws-odb-exadata':
        case 'azure-odb-exadata':
        case 'google-odb-exadata':
          return { delta: 3, reason: 'Oracle Database@ Exadata runs RAC inside this cloud.' };
        case 'vmware-vm':
          return { delta: 1, reason: 'RAC runs on vSphere with multi-writer shared disks, as it does today.' };
        default:
          return undefined;
      }
    },
  }),

  rule          ({
    id: 'db.oracle-dataguard',
    kind: 'database',
    verification: 'C',
    source: 'https://docs.oracle.com/en/database/oracle/oracle-database/19/sbydb/',
    applies: (db) => db.engine === 'oracle' && (db.dr === 'data-guard-remote' || db.dr === 'active-data-guard'),
    evaluate: (_db, o) => {
      if (!o.service) return undefined;
      if (ADB.has(o.service)) return { reason: 'Autonomous Data Guard stands in for Data Guard.' };
      return DB_SERVICES[o.service].ha.includes('data-guard-local')
        ? { delta: 1, reason: 'Carries the Data Guard standby as it is today.' }
        : undefined;
    },
  }),

  /**
   * Applied by the engine after assignment, not per option: an IaaS database
   * pulls its host VMs to its own platform. Listed here so the registry names
   * every rule id the decision can carry.
   */
  rule          ({
    id: HOSTS_FOLLOW,
    kind: 'database',
    verification: 'I',
    applies: () => false,
  }),
];

/**
 * `db.hosts-follow`: the host's options on every other platform are
 * eliminated, and its option on the database's platform says why.
 */
export function hostsFollow(options                   , platform          , db          )           {
  const hit = (reason        )          => ({ rule: HOSTS_FOLLOW, delta: 0, reason, verification: 'I' });
  return options
    .map((o)         => {
      if (o.platform === platform) return { ...o, hits: [...o.hits, hit(`Hosts ${db.name}, which lands on ${platformInfo(platform).shortLabel} on a VM.`)] };
      if (o.eliminated) return o;
      return { ...o, eliminated: HOSTS_FOLLOW, hits: [...o.hits, hit(`Hosts ${db.name}, which lands on ${platformInfo(platform).shortLabel}: the VM goes with it.`)] };
    })
    .sort(compareOptions);
}
