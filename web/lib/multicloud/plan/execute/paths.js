/**
 * From method to path (addendum A.6.1): which generated script family moves
 * each item.
 *
 *   resolveMovePath(workload, plan, decision) → the server's path, its
 *       alternatives, the valid overrides and the findings;
 *   resolveDbPath(database, plan, decision)   → the same for a database;
 *   movePathFor / dbPathFor                   → just the path;
 *   checkPathOverride                         → whether an override is valid, and why not;
 *   pathFindings                              → the warnings a chosen path carries
 *       (no automatic fallback, a retired or renamed tool, HCX underlay).
 *
 * Every resolution also carries the provider-style `ExecutionMethod`
 * (`METHOD_OF_PATH`), so the UI can show the tool in the provider's words.
 *
 * The server table is A.6.1's, first match wins, for vSphere sources; other
 * sources take their default from the source × target matrix (A.3.4,
 * `matrix.ts`); pattern components take the pattern's path (A.4.2), new
 * services `deploy` (A.9.3), non-x86 sources `specialist` (A.4.8).
 *
 * Pure.
 */

import { info, warning,              } from '../../../core/findings.js';
import { isIaasService } from '../design/compute.js';
import { serviceStatus, shouldWarn } from '../methodology.js';
import {
  DB_MOVE_PATH_OPTIONS, DB_SERVICE_LABELS, defaultExecution, labelOf, METHOD_OF_PATH, MOVE_PATH_OPTIONS, OS_LABELS,
  SOURCE_PLATFORM_OPTIONS,
} from '../options.js';
import { osKind } from '../os.js';
             
                                                                                                                              
                                         
                     
                                              
import { EXEC_TARGET_LABELS, execTargetOf, matrixCell, NON_X86_SOURCES,                 } from './matrix.js';

                                                     
                        
                                         
                                                                      
                    
                                                       
                                    
                                    
                               
                                       
                                 
                                   
                                                       
                       
                                      
                                                                  
                               
                               
                                                                    
                                                                        
                       
                                        
 

export const pathLabel = (path          )         => (isMovePath(path) ? labelOf(MOVE_PATH_OPTIONS, path) : labelOf(DB_MOVE_PATH_OPTIONS, path));
export const isMovePath = (p        )                => MOVE_PATH_OPTIONS.some((o) => o.value === p);
export const isDbMovePath = (p        )                  => DB_MOVE_PATH_OPTIONS.some((o) => o.value === p);

// ---------------------------------------------------------------------------
// Facts the warnings rest on
// ---------------------------------------------------------------------------

                               
                        
                               
                          
                                       
 
/**
 * Paths whose tool gives no automatic way back once cut over (methodology
 * research 6(e) 16): the rollback is manual, or the source is gone.
 */
export const NO_AUTO_FALLBACK                                                    = Object.freeze({
  'aws-mgn': {
    text: 'AWS Transform MGN has no failback: once cut over, the way back is a manual restart of the source.',
    remediation: 'Keep the source stopped, not deleted, until the keep-days end; where a failback path is needed, use AWS Elastic Disaster Recovery for the move instead.',
    source: 'https://docs.aws.amazon.com/mgn/latest/ug/General-Questions-FAQ.html',
    verification: 'V-DOC',
  },
  'hcx-rav': {
    text: 'HCX Replication Assisted vMotion removes the source VM at switchover, so there is no retained copy to fall back to.',
    remediation: 'Plan a reverse migration as the rollback, or use HCX Bulk Migration, which keeps the source renamed and powered off.',
    source: 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/workload-mobility/vmware-hcx-user-guide-vcf-9-0/migrating-virtual-machines-with-vmware-hcx/understanding-vmware-hcx-replication-assisted-vmotion.html',
    verification: 'I',
  },
  'gcp-m2vm': {
    text: 'Migrate to Virtual Machines rollback is not automated, and data written on the Compute Engine instance is not pushed back to the source.',
    remediation: 'Agree the point of no return with the app owner; after it, a rollback loses the target’s writes unless the app replays them.',
    source: 'https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/discover/lifecycle',
    verification: 'V-DOC',
  },
  'oracle-zdm-physical': {
    text: 'Zero Downtime Migration does not handle reverse role switches: the fallback to the source standby is manual.',
    remediation: 'Keep the fallback with TGT_RETAIN_DB_UNIQUE_NAME through the observation period and rehearse the manual switchover back.',
    source: 'https://docs.oracle.com/en/database/oracle/zero-downtime-migration/21.5/zdmug/introduction-to-zero-downtime-migration.html',
    verification: 'V-DOC',
  },
  'oracle-zdm-logical': {
    text: 'Zero Downtime Migration (logical) has no automatic reverse replication: a fallback after switchover is set up by hand.',
    remediation: 'Configure reverse replication before cutover, or accept that a rollback loses the target’s writes.',
    source: 'https://docs.oracle.com/en/database/oracle/zero-downtime-migration/21.5/zdmug/introduction-to-zero-downtime-migration.html',
    verification: 'I',
  },
});

/** The `SERVICE_STATUS` rows (methodology.ts) an execution method's tool is tracked under. */
export const METHOD_STATUS_IDS                                                                = Object.freeze({
  'aws-transform-mgn': ['aws-mgn'],
});

/** Broadcom's HCX network underlay minimums (Mbps): below them "HCX operations … are not supported". */
export const HCX_UNDERLAY                                                                                                                                                     = Object.freeze({
  'hcx-vmotion': { mbps: 250, mbpsWanOpt: 150, lossPct: 0.1, latencyMs: 150 },
  'hcx-rav': { mbps: 250, mbpsWanOpt: 150, lossPct: 0.1, latencyMs: 150 },
  'hcx-bulk': { mbps: 50, lossPct: 1, latencyMs: 150 },
  'hcx-cold': { mbps: 50, lossPct: 1, latencyMs: 150 },
  'hcx-osam': { mbps: 50, lossPct: 1, latencyMs: 150 },
});
export const HCX_UNDERLAY_SOURCE = 'https://techdocs.broadcom.com/us/en/vmware-cis/hcx/vmware-hcx/4-11/vmware-hcx-user-guide-4-11/preparing-for-hcx-installations/network-underlay-minimum-requirements.html';
const BANDWIDTH_MBPS                                      = { '50m': 50, '100m': 100, '200m': 200, '500m': 500, '1g': 1000, '2g': 2000, '5g': 5000, '10g': 10000, '100g': 100000 };

/**
 * What a chosen path warns about: no automatic fallback; the tool is
 * retired, closed to new customers or out of support (`shouldWarn`), or
 * renamed; HCX paths below Broadcom's underlay minimums, or needing a
 * network extension that is not configured.
 */
                               
                                               
                                         
 
const METHODOLOGY               = { serviceStatus, shouldWarn };

export function pathFindings(path          , plan      , item         , status               = METHODOLOGY)            {
  const out            = [];
  const at = item ? { path: item } : {};
  const fb = NO_AUTO_FALLBACK[path];
  if (fb) {
    out.push(warning('exec.path.no-fallback', `${fb.text}${fb.verification === 'I' ? ' (unverified on the vendor page)' : ''}`, { ...at, remediation: fb.remediation, source: fb.source }));
  }
  const method = METHOD_OF_PATH[path];
  for (const id of [method, ...(METHOD_STATUS_IDS[method] ?? [])]) {
    const s = status.serviceStatus(id);
    if (!s) continue;
    if (status.shouldWarn(id)) {
      out.push(warning('exec.path.tool-retired', `${s.name} is ${s.status.replace(/-/g, ' ')}${s.since ? ` since ${s.since}` : ''}: ${s.note}`, {
        ...at, source: s.source, ...(s.replacement ? { remediation: `Use ${s.replacement}.` } : {}),
      }));
    } else if (s.status === 'renamed' && s.replacement) {
      out.push(info('exec.path.tool-renamed', `${s.name} is now ${s.replacement}; the kit uses the current name.`, { ...at, source: s.source }));
    }
  }
  if (path.startsWith('hcx-')) {
    const hcx = HCX_UNDERLAY[path            ];
    const sites = plan.requirements.sites;
    if (hcx && sites.length) {
      const mbps = Math.min(...sites.map((s) => BANDWIDTH_MBPS[s.bandwidth]));
      if (mbps < (hcx.mbpsWanOpt ?? hcx.mbps)) {
        out.push(warning('exec.hcx.underlay', `${pathLabel(path)} needs at least ${hcx.mbpsWanOpt ?? hcx.mbps} Mbps between the sites (${hcx.lossPct}% loss, ${hcx.latencyMs} ms at most); the slowest site link is ${mbps} Mbps.`, { ...at, source: HCX_UNDERLAY_SOURCE, remediation: 'Raise the link, or use HCX Bulk Migration.' }));
      } else if (hcx.mbpsWanOpt && mbps < hcx.mbps) {
        out.push(info('exec.hcx.underlay-wan-opt', `${pathLabel(path)} at ${mbps} Mbps needs HCX WAN Optimization (${hcx.mbpsWanOpt} Mbps with it, ${hcx.mbps} without); WAN Optimization is in VCF 9.1, not 9.0.`, { ...at, source: HCX_UNDERLAY_SOURCE }));
      }
    }
    if ((path === 'hcx-vmotion' || path === 'hcx-rav') && !(plan.execution?.hcx?.extend.length)) {
      out.push(warning('exec.hcx.needs-extension', `${pathLabel(path)} needs the item's network extended, and no port group is extended in the HCX settings.`, { ...at, remediation: 'Tick the port groups to extend under Execute › Settings › HCX, or use HCX Bulk Migration.' }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

                                          
                       
                                      
                                                                                
                                                
                       
                                        
                               
                                 
                                                                            
                                                            
 

const TOOL_PATHS                      = ['aws-mgn', 'azure-migrate', 'azure-migrate-hyperv', 'azure-migrate-agent', 'gcp-m2vm', 'gcp-image-import', 'oci-ocm', 'hcx-osam', 'vcf-converter'];
const POWERED_ON_PATHS                      = ['hcx-rav', 'hcx-vmotion', 'xvc-vmotion'];
const LEGACY_TYPES = new Set(['aix', 'ibm-i', 'solaris-sparc', 'hp-ux', 'mainframe']);

export function originOf(w          )                 {
  return w.origin ?? w.sourceRef?.platform ?? 'vsphere';
}

function appOf(plan      , w          )                  {
  return plan.apps.find((a) => a.name === w.app);
}

function settingsOf(plan      )                                                                 {
  return { pathOverrides: plan.execution?.pathOverrides ?? {}, vcfImportClusters: plan.execution?.vcfImportClusters ?? [] };
}

/** Why a server path is not valid for this workload (whatever the matrix says), or undefined. */
function serverInvalidReason(path          , w          , plan      , target                        )                     {
  const kind = osKind(w.os);
  if (TOOL_PATHS.includes(path) && kind === 'other' && w.os !== 'unknown') {
    return `the guest OS (${OS_LABELS[w.os]}) is not one ${pathLabel(path)} supports`;
  }
  if (POWERED_ON_PATHS.includes(path) && w.facts?.powerState === 'poweredOff') return `${pathLabel(path)} needs a powered-on VM`;
  if (path === 'xvc-vmotion' && target !== 'vcf') return 'Cross-vCenter vMotion needs both vCenters under your control (VCF on-premises), 7.0 U1c or later';
  if (path === 'vcf-import') {
    const cluster = w.sourceRef?.cluster;
    if (target !== 'vcf') return 'VCF Import converges a cluster in place, so the target must be VCF on-premises';
    if (!cluster || !settingsOf(plan).vcfImportClusters.includes(cluster)) return 'the source cluster is not converged as a whole (add it to the VCF Import clusters)';
  }
  if ((path === 'sap-hsr' || path === 'sap-backup-restore') && w.workloadType !== 'sap-hana') return 'SAP HANA paths are for SAP HANA servers';
  return undefined;
}

function patternPath(w          , app                 )                       {
  const type = w.workloadType;
  const pattern = app?.pattern;
  if (type === 'sap-hana') return 'sap-hsr';
  if (type === 'k8s-node' || type === 'openshift-node' || ((pattern === 'kubernetes' || pattern === 'openshift') && w.role !== 'db')) return 'k8s-velero';
  if (type?.startsWith('appliance-') || pattern?.startsWith('appliance-')) return 'appliance-rebuild';
  return undefined;
}

function saasPath(w          , app                 )                       {
  if (w.workloadType === 'exchange' || app?.pattern === 'exchange') return 'saas-exchange';
  if (w.workloadType === 'sharepoint' || app?.pattern === 'sharepoint') return 'saas-sharepoint';
  return undefined;
}

function serverCandidates(w          , plan      , d                          )                       {
  const none = (why        , findings            = [])                       => ({ alternatives: [], invalid: new Map(), why, findings });
  const one = (p          , why        , alternatives                      = [], extra                                = {})                       =>
    ({ default: p, alternatives, invalid: new Map(), why, findings: [], ...extra });
  if (!d) return none('not in the decision');
  const app = appOf(plan, w);
  const origin = originOf(w);

  if (d.method === 'none') {
    if (d.disposition === 'retire') return one('retire', 'retired');
    if (d.disposition === 'repurchase') {
      const saas = saasPath(w, app);
      return saas ? one(saas, 'replaced by the SaaS service: the content moves with the provider’s tooling', ['retire']) : one('retire', 'replaced by a bought product or service; the server is retired after the switch');
    }
    return none('retained: not moved');
  }
  if (d.disposition === 'new' || w.synthetic) return one('deploy', 'a new service: built and deployed, not moved');

  const platform = d.chosen?.platform;
  if (!platform) {
    return none('no target platform', [warning('exec.path.no-target', `${w.name} has no target platform, so it has no move path.`, { path: w.id, remediation: 'Resolve the eliminations in the decision, or pin a platform.' })]);
  }
  const target = execTargetOf(d.method, platform);
  const findings            = [];

  if (d.method === 'rebuild') return one('rebuild', 'rebuilt from an image, configured, and its data copied', [], { target });
  if (d.method === 'managed-db') return one('with-db', 'the server is not moved: its database moves to a managed service', [], { target });

  // Non-x86 and legacy platforms: no replication tool exists.
  if (NON_X86_SOURCES.includes(origin) || (w.workloadType && LEGACY_TYPES.has(w.workloadType))) {
    return one('specialist', `no replication tool moves ${labelOf(SOURCE_PLATFORM_OPTIONS, origin)}: assessment, target recommendation and runbook`, ['rebuild'], { target });
  }

  const pattern = patternPath(w, app);
  const cell = matrixCell(origin, target);
  let def          ;
  let alternatives            ;
  let why        ;
  if (pattern) {
    def = pattern;
    alternatives = pattern === 'sap-hsr' ? ['sap-backup-restore', cell.default, ...cell.alternatives] : [cell.default];
    why = `a component of a ${pattern === 'sap-hsr' ? 'SAP HANA' : pattern === 'k8s-velero' ? 'Kubernetes' : 'network appliance'} pattern`;
  } else if (origin === 'vsphere' && (target === 'vcf' || target === 'vmware-cloud')) {
    const cluster = w.sourceRef?.cluster;
    const critical = app?.latencyToOnPrem === 'critical' || w.criticality === 'tier0';
    const off = w.facts?.powerState === 'poweredOff';
    const xvc             = target === 'vcf' ? ['xvc-vmotion'] : [];
    if (target === 'vcf' && cluster && settingsOf(plan).vcfImportClusters.includes(cluster)) {
      def = 'vcf-import';
      alternatives = [];
      why = `its source cluster (${cluster}) is converged into VCF as a whole`;
    } else if (off) {
      def = 'hcx-cold';
      alternatives = ['hcx-bulk'];
      why = 'powered off: HCX Cold Migration';
    } else if (critical) {
      def = 'hcx-rav';
      alternatives = ['hcx-vmotion', 'hcx-bulk', ...xvc];
      why = app?.latencyToOnPrem === 'critical' ? 'its app is latency-critical: a live switchover' : 'tier 0: a live switchover';
    } else {
      def = 'hcx-bulk';
      alternatives = ['hcx-rav', 'hcx-vmotion', ...xvc];
      why = 'vSphere to VMware: HCX Bulk Migration, switched over in the window';
    }
  } else {
    def = cell.default;
    alternatives = [...cell.alternatives];
    why = `${labelOf(SOURCE_PLATFORM_OPTIONS, origin)} to ${EXEC_TARGET_LABELS[target]}${cell.note ? `: ${cell.note}` : ''}`;
    if (def === 'rebuild' && (d.method === 'replicate' || d.method === 'relocate-hcx')) {
      const oci = target === 'oci';
      findings.push(info(oci ? 'exec.oci.source-unsupported' : 'exec.path.no-replication-tool',
        `${w.name}: no replication tool moves ${labelOf(SOURCE_PLATFORM_OPTIONS, origin)} to ${EXEC_TARGET_LABELS[target]}, so it is rebuilt.`,
        { path: w.id, ...(cell.source ? { source: cell.source } : {}) }));
    }
    if (cell.verification === 'I') findings.push(info('exec.path.unverified', `${w.name}: ${pathLabel(def)} from ${labelOf(SOURCE_PLATFORM_OPTIONS, origin)} is unconfirmed on the vendor page.`, { path: w.id, ...(cell.source ? { source: cell.source } : {}) }));
  }
  if (!alternatives.includes('rebuild') && def !== 'rebuild') alternatives.push('rebuild');

  const invalid = new Map                ();
  for (const p of [def, ...alternatives]) {
    const reason = serverInvalidReason(p, w, plan, target);
    if (reason) invalid.set(p, reason);
  }
  if (invalid.has(def)) {
    const next = alternatives.find((p) => !invalid.has(p)) ?? 'rebuild';
    findings.push(info('exec.path.default-invalid', `${w.name}: ${pathLabel(def)} does not apply (${invalid.get(def)}), so ${pathLabel(next)} is used.`, { path: w.id }));
    why = `${why}; ${pathLabel(def)} does not apply`;
    def = next;
  }
  return {
    default: def, alternatives: dedupe(alternatives.filter((p) => p !== def)), invalid, why, findings, target,
    reasonFor: (p) => (isMovePath(p) ? serverInvalidReason(p, w, plan, target) : undefined),
  };
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const ORACLE_PHYSICAL                         = ['oci-basedb', 'oci-exacs', 'aws-odb-exadata', 'azure-odb-exadata', 'google-odb-exadata', 'google-odb-basedb'];
const ORACLE_LOGICAL                         = ['oci-adb', 'aws-odb-adb', 'azure-odb-adb', 'google-odb-adb'];
const MI_LINK_VERSIONS = new Set(['sql-2016', 'sql-2017', 'sql-2019', 'sql-2022', 'sql-2025']);
const MI_LINK_SOURCE = 'https://learn.microsoft.com/en-us/azure/azure-sql/managed-instance/managed-instance-link-feature-overview';

                                                                                                                                                           

/** The engine's own path to a service, when its VM does not carry it (A.6.1 database table, A.4.9). */
function nativeDbPath(db          , service             , iaas         )                     {
  const s = service;
  const on = (...ids               )          => ids.includes(s);
  switch (db.engine) {
    case 'oracle':
      if (ORACLE_PHYSICAL.includes(s)) return { default: 'oracle-zdm-physical', alternatives: ['oracle-dataguard', 'oracle-rman'], why: 'Oracle to a Base Database / Exadata service: ZDM physical' };
      if (ORACLE_LOGICAL.includes(s)) return { default: 'oracle-zdm-logical', alternatives: ['oci-dms', 'oracle-datapump'], why: 'Oracle to Autonomous Database: ZDM logical' };
      if (on('aws-rds', 'aws-rds-custom')) return { default: 'aws-dms', alternatives: ['oracle-datapump'], why: 'Oracle to Amazon RDS: AWS DMS with a Data Pump full load' };
      if (iaas) return { default: 'oracle-dataguard', alternatives: ['oracle-rman', 'oracle-datapump'], why: 'Oracle on a rebuilt VM: a Data Guard standby, then switchover' };
      return undefined;
    case 'sqlserver':
      if (on('azure-sqlmi')) {
        if (MI_LINK_VERSIONS.has(db.version)) {
          const f = db.version === 'sql-2016' ? [info('exec.db.mi-link-sp3', `${db.name}: the Managed Instance link needs SQL Server 2016 SP3 or later; check the service pack.`, { path: db.id, source: MI_LINK_SOURCE })] : [];
          return { default: 'sql-mi-link', alternatives: ['sql-mi-lrs'], why: 'SQL Server to Managed Instance: the Managed Instance link', findings: f };
        }
        return { default: 'sql-mi-lrs', alternatives: [], why: 'SQL Server before 2016 to Managed Instance: Log Replay Service' };
      }
      if (on('azure-sqldb')) return { default: 'azure-dms', alternatives: [], why: 'SQL Server to Azure SQL Database: Azure DMS (offline)' };
      if (on('aws-rds', 'aws-rds-custom')) return { default: 'sql-rds-native', alternatives: ['aws-dms'], why: 'SQL Server to Amazon RDS: native backup, NORECOVERY and a log chain' };
      if (on('google-cloudsql')) return { default: 'gcp-dms', alternatives: [], why: 'SQL Server to Cloud SQL: Database Migration Service from backup files' };
      if (iaas) {
        return db.ha === 'sql-ag'
          ? { default: 'sql-ag-seeding', alternatives: ['sql-log-shipping', 'sql-backup-url'], why: 'SQL Server with an availability group, on a rebuilt VM: AG automatic seeding' }
          : { default: 'sql-log-shipping', alternatives: ['sql-ag-seeding', 'sql-backup-url'], why: 'SQL Server on a rebuilt VM: log shipping' };
      }
      return undefined;
    case 'postgres':
      if (on('aws-rds', 'aws-aurora')) return { default: 'aws-dms', alternatives: ['pg-logical'], why: 'PostgreSQL to Amazon RDS / Aurora: AWS DMS' };
      if (on('azure-pg-flex')) return { default: 'azure-pg-migration', alternatives: ['pg-logical'], why: 'PostgreSQL to Flexible Server: the Azure migration service' };
      if (on('google-cloudsql', 'google-alloydb')) return { default: 'gcp-dms', alternatives: ['pg-logical'], why: 'PostgreSQL to Cloud SQL / AlloyDB: Database Migration Service' };
      if (on('oci-pg') || iaas) return { default: 'pg-logical', alternatives: ['pg-dump'], why: 'PostgreSQL: logical replication' };
      return undefined;
    case 'mysql':
    case 'mariadb':
      if (on('google-cloudsql')) {
        return db.engine === 'mysql'
          ? { default: 'gcp-dms', alternatives: [], why: 'MySQL to Cloud SQL: Database Migration Service' }
          : { default: 'mysql-dump', alternatives: [], why: 'MariaDB to Cloud SQL for MySQL: dump and load (Cloud SQL has no MariaDB)' };
      }
      if (on('oci-mysql-heatwave')) {
        return db.engine === 'mysql'
          ? { default: 'oci-dms', alternatives: ['mysql-replication'], why: 'MySQL to HeatWave: OCI Database Migration' }
          : { default: 'mysql-dump', alternatives: ['mysql-replication'], why: 'MariaDB to HeatWave MySQL: dump and load' };
      }
      if (on('aws-rds', 'aws-aurora')) return { default: 'mysql-replication', alternatives: ['aws-dms', 'mysql-dump'], why: `${db.engine === 'mysql' ? 'MySQL' : 'MariaDB'} to Amazon RDS / Aurora: binlog replication` };
      if (on('azure-mysql-flex') || iaas) return { default: 'mysql-replication', alternatives: ['mysql-dump'], why: `${db.engine === 'mysql' ? 'MySQL' : 'MariaDB'}: binlog replication` };
      return undefined;
    case 'db2':
      if (on('aws-rds-db2')) return { default: 'db2-backup-restore', alternatives: [], why: 'Db2 to Amazon RDS for Db2: online backup and logs' };
      if (iaas) return { default: 'db2-hadr', alternatives: ['db2-backup-restore'], why: 'Db2 on a rebuilt VM: HADR' };
      return undefined;
    case 'sybase-ase':
      return iaas ? { default: 'ase-dump-load', alternatives: [], why: 'SAP ASE: dump and load' } : undefined;
    case 'informix':
      return iaas ? { default: 'informix-backup-restore', alternatives: [], why: 'Informix: onbar / ontape backup and restore' } : undefined;
    case 'mongodb':
      if (on('aws-docdb')) return { default: 'aws-dms', alternatives: [], why: 'MongoDB to DocumentDB: AWS DMS' };
      if (on('azure-documentdb', 'oci-adb-mongo') || iaas) return { default: 'mongo-mongosync', alternatives: [], why: 'MongoDB: mongosync' };
      return undefined;
    case 'redis':
      if (iaas) return { default: 'redis-replicaof', alternatives: ['redis-rdb-import'], why: 'Redis on a VM: REPLICAOF' };
      if (on('aws-elasticache', 'aws-memorydb', 'azure-managed-redis', 'google-memorystore', 'oci-cache')) return { default: 'redis-rdb-import', alternatives: [], why: 'Redis to a managed cache: RDB import' };
      return undefined;
    case 'cassandra':
      if (on('aws-keyspaces')) return { default: 'cassandra-zdm-proxy', alternatives: [], why: 'Cassandra to Keyspaces: ZDM proxy (dual write)' };
      if (on('azure-cassandra-mi') || iaas) return { default: 'cassandra-ring-join', alternatives: iaas ? ['cassandra-zdm-proxy'] : [], why: 'Cassandra: join the ring, then decommission' };
      return undefined;
    case 'elasticsearch':
      if (on('aws-opensearch', 'oci-opensearch') || iaas) return { default: 'es-snapshot-restore', alternatives: ['es-reindex-remote'], why: 'Elasticsearch / OpenSearch: snapshot and restore' };
      return undefined;
    default:
      return undefined;
  }
}

function dbCandidates(db          , plan      , decision              )                         {
  const none = (why        , findings            = [])                         => ({ alternatives: [], invalid: new Map(), why, findings });
  const d = decision.items[db.id];
  if (!d) return none('not in the decision');
  if (d.method === 'none') return none(d.disposition === 'retire' ? 'retired with its servers' : 'not moved');
  const service = d.chosen?.service;
  if (!service) {
    return none('no target service', [warning('exec.path.no-target', `${db.name} has no target service, so it has no move path.`, { path: db.id, remediation: 'Resolve the eliminations in the decision, or pin a service.' })]);
  }
  const iaas = isIaasService(service);
  const hosts = plan.workloads.filter((w) => db.hosts.includes(w.name));
  const hostsMove = hosts.length > 0 && hosts.every((h) => {
    const m = decision.items[h.id]?.method;
    return m === 'replicate' || m === 'relocate-hcx';
  });
  const native = nativeDbPath(db, service, iaas);
  const invalid = new Map                ();
  if (!hostsMove) invalid.set('with-vm', hosts.length ? 'its servers are rebuilt, so the database does not move inside them' : 'no host server is known for it');
  if (iaas && hostsMove) {
    const alternatives = native ? [native.default, ...native.alternatives] : [];
    return { default: 'with-vm', alternatives, invalid, why: 'IaaS on a server that is itself replicated or relocated: it moves inside its VM', findings: [], service };
  }
  if (db.engine === 'sap-hana') {
    return none('SAP HANA moves with its server on the SAP HANA path (sap-hsr)', [info('exec.db.sap-hana', `${db.name}: SAP HANA moves by HANA System Replication on its server's path.`, { path: db.id })]);
  }
  if (!native) {
    return none(`no path for ${db.engine} to ${DB_SERVICE_LABELS[service]}`, [warning('exec.db.no-path', `${db.name}: the kit has no path for ${db.engine} to ${DB_SERVICE_LABELS[service]}.`, { path: db.id, remediation: 'Move it by hand and record the transitions in the tracker, or choose another service.' })]);
  }
  return { default: native.default, alternatives: native.alternatives, invalid, why: native.why, findings: native.findings ?? [], service };
}

// ---------------------------------------------------------------------------
// Resolution and overrides
// ---------------------------------------------------------------------------

function dedupe   (xs              )      {
  return [...new Set(xs)];
}

function resolve                    (
  id        , kind                         , name        , c               , plan      , isKind                       , source                 ,
)                    {
  const valid = c.default ? dedupe([c.default, ...c.alternatives]).filter((p) => !c.invalid.has(p)) : [];
  const findings            = [...c.findings];
  let path = c.default;
  let overridden = false;
  let refused                              ;
  const override = plan.execution?.pathOverrides[id];
  if (override !== undefined && override !== c.default) {
    const reason = !isKind(override)
      ? `${override} is a ${kind === 'workload' ? 'database' : 'server'} path`
      : !c.default
        ? 'the item is not moved'
        : c.invalid.get(override) ?? (valid.includes(override) ? undefined : c.reasonFor?.(override) ?? `${pathLabel(override)} is not a path for this item (${c.why})`);
    if (reason === undefined && isKind(override)) {
      path = override;
      overridden = true;
    } else {
      refused = { path: override, reason: reason ?? 'not valid' };
      findings.push(warning('exec.path.override-refused', `${name}: the path override ${override} is refused: ${refused.reason}.`, {
        path: `execution.pathOverrides.${id}`, remediation: `Choose one of: ${valid.join(', ') || 'none'}.`,
      }));
    }
  }
  if (path) findings.push(...pathFindings(path, plan, id));
  return {
    item: id, kind, alternatives: c.alternatives, valid, overridden, why: overridden ? `overridden (default ${c.default}: ${c.why})` : c.why, findings,
    ...(path ? { path, method: METHOD_OF_PATH[path] } : {}),
    ...(c.default ? { default: c.default } : {}),
    ...(c.target ? { target: c.target } : {}),
    ...(c.service ? { service: c.service } : {}),
    ...(source ? { source } : {}),
    ...(refused ? { refused } : {}),
  };
}

/** A server's path with its alternatives, valid overrides and findings. */
export function resolveMovePath(w          , plan      , decision              )                           {
  return resolve(w.id, 'workload', w.name, serverCandidates(w, plan, decision.items[w.id]), plan, isMovePath, originOf(w));
}

/** A database's path with its alternatives, valid overrides and findings. */
export function resolveDbPath(db          , plan      , decision              )                             {
  return resolve(db.id, 'database', db.name, dbCandidates(db, plan, decision), plan, isDbMovePath);
}

/** The server's move path (override applied when valid); undefined when it is not moved. */
export function movePathFor(w          , plan      , decision              )                       {
  return resolveMovePath(w, plan, decision).path;
}

/** The database's move path (override applied when valid); undefined when it is not moved. */
export function dbPathFor(db          , plan      , decision              )                         {
  return resolveDbPath(db, plan, decision).path;
}

/** Whether `path` may be chosen for the item, and the reason when it may not (for the Path dropdown). */
export function checkPathOverride(
  item                     , plan      , decision              , path          ,
)                                                                          {
  const probe       = { ...plan, execution: { ...(plan.execution ?? defaultExecution()), pathOverrides: { ...(plan.execution?.pathOverrides ?? {}), [item.id]: path } } };
  const r = 'engine' in item ? resolveDbPath(item, probe, decision) : resolveMovePath(item, probe, decision);
  if (r.path === path) return { ok: true };
  return { ok: false, reason: r.refused?.reason ?? 'not valid for this item' };
}


/** Every workload and database of the plan, resolved (retained items included, with no path). */
export function resolvePlanPaths(plan      , decision              )   
                                                          
                                                            
  {
  return {
    workloads: plan.workloads.map((w) => resolveMovePath(w, plan, decision)),
    databases: plan.databases.map((db) => resolveDbPath(db, plan, decision)),
  };
}
