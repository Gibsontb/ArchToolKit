/**
 * The `database` engine (addendum A.2.8.6): per database, the class or tier on
 * its service, the storage and IOPS, and the HA / replica shape.
 *
 * - Class / shape: WP-4's `classFor` (design/database.ts), so the sizing and
 *   the design write the same `classOrShape`; Azure SQL MI / DB take Business
 *   Critical when the RPO is 0 or the database is tier 0.
 * - Demand: the database row (vCPU, RAM, size); when its hosts carry usable
 *   utilisation, the host's peak (p99 / max) with memory never below the row's.
 * - Perf columns (A.2.8.6): `iops_p95`, `read_pct`, `connections`, `tps` as the
 *   component's settings `db.<name>.<column>` (or the hosts' measured IOPS).
 * - IaaS services go through the `server` and `storage` engines.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { classFor, classInCatalog } from '../design/database.ts';
import { isIaasService, isPerCoreByol } from '../design/compute.ts';
import type { AppComponent, Database, DbServiceId, Plan, Platform, SizingReason, SizingRow, Workload } from '../types.ts';
import type { SizingEngine } from './index.ts';
import {
  chooseInstance, databasesOf, gib, isPattern, isProd, num, reason, rec, serverDemand, serviceFor, type SizingPolicyExt,
} from './server.ts';

export { serviceFor };
import { growthFactor } from './storage.ts';

export interface DbPerf {
  readonly iopsP95?: number;
  readonly readPct?: number;
  readonly connections?: number;
  readonly tps?: number;
}

/** RDS gp3 storage: 3,000 IOPS / 125 MiB/s under 400 GiB, 12,000 / 500 from 400 GiB for most engines; up to 64,000 IOPS (verify). */
export const RDS_GP3 = { thresholdGib: 400, below: [3000, 125], above: [12000, 500], maxIops: 64000, source: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html', verification: 'I' } as const;
/** Azure SQL MI storage maxima by tier, GiB (verify). */
export const SQLMI_MAX_GIB = { GP: 16384, BC: 16384 } as const;

function perfOf(c: AppComponent, db: Database, hosts: readonly Workload[]): DbPerf {
  const k = (col: string): number | undefined => {
    const v = num(c, `db.${db.name}.${col}`, Number.NaN);
    return Number.isFinite(v) ? v : undefined;
  };
  const hostIops = hosts.reduce((s, w) => s + (w.facts?.utilisation?.iopsP95 ?? 0), 0);
  const iops = k('iops_p95') ?? (hostIops > 0 ? hostIops : undefined);
  const readPct = k('read_pct');
  const connections = k('connections');
  const tps = k('tps');
  return { ...(iops !== undefined ? { iopsP95: iops } : {}), ...(readPct !== undefined ? { readPct } : {}), ...(connections !== undefined ? { connections } : {}), ...(tps !== undefined ? { tps } : {}) };
}

export interface DbInput {
  readonly component: AppComponent;
  readonly plan: Plan;
  readonly databases: readonly Database[];
}

/** One database row. */
export function sizeDatabase(db: Database, service: DbServiceId, platform: Platform, plan: Plan, c: AppComponent, policy: SizingPolicyExt): { row: SizingRow; findings: Finding[] } {
  const findings: Finding[] = [];
  const reasons: SizingReason[] = [];
  const hosts = db.hosts.map((h) => plan.workloads.find((w) => w.name === h)).filter((w): w is Workload => !!w);
  const crit = hosts[0]?.criticality ?? plan.apps.find((a) => a.name === db.app)?.criticality ?? 'tier2';
  const rpo = hosts[0]?.rpo ?? plan.apps.find((a) => a.name === db.app)?.rpo;
  const prod = hosts.length === 0 || hosts.some((w) => isProd(w.env));
  const perf = perfOf(c, db, hosts);

  // Demand
  let vcpu = db.vcpu;
  let ramGib = db.ramGib;
  const withUtil = hosts.find((w) => w.facts?.utilisation);
  if (withUtil) {
    const d = serverDemand({ ...withUtil, vcpu: db.vcpu, ramGib: db.ramGib }, policy, { peak: true, floorRamGib: db.ramGib });
    vcpu = d.vcpu;
    ramGib = d.ramGib;
    reasons.push(...d.reasons);
    findings.push(...d.findings);
  } else {
    reasons.push(reason(`${db.vcpu} vCPU / ${gib(db.ramGib)} GiB from the database row.`));
  }
  const grow = growthFactor(policy);
  const storageGib = Math.ceil(db.sizeGib * grow);
  reasons.push(reason(`Storage ${gib(db.sizeGib)} GiB × ${grow.toFixed(3)} growth → ${storageGib} GiB.`, { assumption: grow > 1 }));

  const detail: Record<string, string | number> = { service, storageGib, criticality: crit };
  let choice = '';
  const alternatives: string[] = [];

  if (isIaasService(service)) {
    const optimised = isPerCoreByol(db);
    const ch = chooseInstance(platform, vcpu, ramGib, { families: policy.families.filter((f) => f !== 'burstable'), allowArm: false, latest: policy.latestGeneration, burstable: false, licenceOptimised: optimised && policy.licenceOptimised });
    choice = ch.fit?.type ?? '';
    alternatives.push(...ch.alternatives);
    reasons.push(...ch.reasons);
    reasons.push(reason('On IaaS: each host is sized by the server engine and its volumes by the storage engine (data, log and temp on separate volumes).'));
    detail['hosts'] = hosts.length;
  } else {
    const cls = classFor(service, { vcpu, ramGib, ha: db.ha });
    choice = cls ?? '';
    if ((service === 'azure-sqlmi' || service === 'azure-sqldb') && cls && (rpo === '0' || crit === 'tier0')) {
      choice = cls.replace(/^GP_/, 'BC_');
      reasons.push(reason('Business Critical: RPO 0 or tier 0 (built-in replicas).', { source: 'https://learn.microsoft.com/en-us/azure/azure-sql/managed-instance/service-tiers-managed-instance-vcore' }));
    }
    if (service === 'azure-sqldb' && storageGib > 4096) {
      choice = choice.replace(/^(GP|BC)_/, 'HS_');
      reasons.push(reason('Hyperscale: more than 4 TiB.', { source: 'https://learn.microsoft.com/en-us/azure/azure-sql/database/service-tier-hyperscale' }));
    }
    if (!cls || !classInCatalog(service, choice)) {
      findings.push(warning('size.db.no-class', `${db.name}: no ${service} class carries ${vcpu} vCPU / ${Math.ceil(ramGib)} GiB.`, { path: `sizing.overrides.db:${db.name}` }));
    } else {
      reasons.push(reason(`${choice} on ${service} (the class the design writes).`));
    }

    // Storage type and IOPS
    const iops = Math.ceil((perf.iopsP95 ?? (perf.tps ? perf.tps * 10 : 0)) * (1 + policy.headroomPct / 100));
    if (perf.tps && perf.iopsP95 === undefined) reasons.push(reason(`IOPS ${perf.tps} TPS × 10 (assumption).`, { assumption: true }));
    detail['iops'] = iops;
    if (service === 'aws-rds' || service === 'aws-rds-custom') {
      const [baseIops] = storageGib >= RDS_GP3.thresholdGib ? RDS_GP3.above : RDS_GP3.below;
      const io2 = iops > RDS_GP3.maxIops || crit === 'tier0' || crit === 'tier1';
      detail['storageType'] = io2 ? 'io2' : 'gp3';
      if (!io2 && iops > baseIops) detail['provisionedIops'] = iops;
      if (io2) detail['provisionedIops'] = Math.max(1000, iops);
      reasons.push(reason(io2 ? `io2: ${iops > RDS_GP3.maxIops ? `${iops} IOPS is above gp3's ${RDS_GP3.maxIops}` : 'tier-0/1 database (latency and durability)'}.` : `gp3: ${baseIops} IOPS baseline at ${storageGib} GiB${iops > baseIops ? `, ${iops} provisioned` : ''} (RDS baselines change at 400 GiB; verify for the engine).`, { source: RDS_GP3.source }));
    } else if (service === 'aws-aurora') {
      detail['storageType'] = 'aurora';
      reasons.push(reason('Aurora storage grows automatically; IOPS are not provisioned (I/O-Optimized when I/O is over a quarter of the bill).', { source: 'https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Overview.StorageReliability.html' }));
    } else if (service === 'azure-sqlmi') {
      const tier = choice.startsWith('BC') ? 'BC' : 'GP';
      if (storageGib > SQLMI_MAX_GIB[tier]) findings.push(warning('size.db.mi-storage', `${db.name}: ${storageGib} GiB is above SQL Managed Instance's ${SQLMI_MAX_GIB[tier]} GiB (${tier}, verify).`));
    } else if (service === 'google-cloudsql' || service === 'google-alloydb') {
      detail['storageType'] = service === 'google-cloudsql' ? 'PD_SSD' : 'auto';
      reasons.push(reason(service === 'google-cloudsql' ? 'SSD storage with automatic increase; IOPS scale with size.' : 'AlloyDB storage is managed and grows automatically.'));
    } else if (service === 'oci-adb' || service.endsWith('-odb-adb')) {
      reasons.push(reason('Autonomous Database: ECPU auto-scaling can run up to three times the base ECPUs.', { source: 'https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/autonomous-auto-scale.html' }));
    }
  }

  // HA and replicas
  const multiAz = prod && (crit === 'tier0' || crit === 'tier1');
  const readReplicas = perf.readPct !== undefined && perf.readPct >= 50 ? Math.ceil(perf.readPct / 50) : 0;
  const haText = service.startsWith('aws-rds') || service === 'aws-aurora' ? (multiAz ? 'Multi-AZ' : 'single-AZ')
    : service === 'google-cloudsql' ? (multiAz ? 'REGIONAL' : 'ZONAL')
      : service === 'azure-sqlmi' || service === 'azure-sqldb' ? (choice.startsWith('BC') ? 'built-in replicas (BC)' : prod ? 'zone redundant' : 'local')
        : service === 'azure-pg-flex' || service === 'azure-mysql-flex' ? (multiAz ? 'ZoneRedundant' : 'Disabled')
          : service === 'oci-adb' ? (multiAz ? 'Autonomous Data Guard' : 'none')
            : db.ha;
  detail['ha'] = haText;
  if (readReplicas > 0) {
    detail['readReplicas'] = readReplicas;
    reasons.push(reason(`${readReplicas} read replica(s): ${perf.readPct}% reads (ceil(read % ÷ 50)).`, { assumption: true }));
  }
  if (perf.connections !== undefined) detail['connections'] = perf.connections;
  if (service === 'oci-exacs' || service.endsWith('-odb-exadata')) {
    findings.push(info('size.db.exadata', `${db.name}: Exadata infrastructure is sized as a shape and a database-server count (${db.ha === 'rac' ? 'two or more for RAC' : 'two minimum'}); confirm the shape in the region.`));
  }

  return {
    row: { key: `db:${db.name}`, demand: { vcpu, ramGib: Math.ceil(ramGib), storageGib, ...(detail['iops'] !== undefined ? { iops: Number(detail['iops']) } : {}) }, choice, detail, fits: choice !== '', reasons, alternatives },
    findings,
  };
}

export const databaseEngine: SizingEngine<DbInput> = {
  id: 'database',
  applies: (c) => isPattern(c) && c.databases.length > 0,
  inputs: (c, plan) => ({ component: c, plan, databases: databasesOf(c, plan) }),
  size(input, platform, policy) {
    const rows: SizingRow[] = [];
    const findings: Finding[] = [];
    for (const db of input.databases) {
      const r = sizeDatabase(db, serviceFor(db, platform, input.plan), platform, input.plan, input.component, policy);
      rows.push(r.row);
      findings.push(...r.findings);
    }
    return rec('database', platform, rows, findings);
  },
};
