/**
 * Pattern designers (addendum A.2.4, A.4): pattern → `ComputeTarget` /
 * `DbTarget` / pattern targets. They plug into WP-4's design pipeline with
 * `insertMapper`:
 *
 * - `sapCertifiedMapper` (after `compute`) claims the SAP HANA workloads on a
 *   platform and sizes them with the smallest SAP HANA certified type ≥ the
 *   HANA memory (A.4.4), with the SAP disk layout (/hana/data, /hana/log,
 *   /hana/shared, /usr/sap: WP-23's ratios). No certified type: an error
 *   finding and an empty size.
 * - `extraDbMapper` (after `database`) designs the A.4.9 services (DocumentDB,
 *   ElastiCache, MemoryDB, Keyspaces, OpenSearch, Azure DocumentDB, Azure
 *   Managed Redis, Cassandra MI, Memorystore, OCI Cache / OpenSearch / ADB
 *   MongoDB API), which the generic database mapper has no classes for.
 *
 * `patternTargets` lists, per app and component, the tier pattern, its
 * service and Terraform types on a platform, and the WP-23 sizing
 * (`sizeFor`), for the Target tab and the pattern generators (WP-17).
 */

import { error, info, type Finding } from '../../../core/findings.ts';
import { createContext } from '../decide/engine.ts';
import { DB_SERVICES } from '../db-catalog.ts';
import {
  computeTargetFor, diskTypes, DESIGN_MAPPERS, insertMapper, placeWorkload, type DesignMapper,
} from '../design/index.ts';
import { networkZones } from '../design/network.ts';
import { networkOf, hash32 } from '../design/compute.ts';
import { BACKUP_TIER_BY_CRITICALITY } from '../options.ts';
import { sizeComponent, type SizingEngine } from '../sizing/index.ts';
import { hanaDisks } from '../sizing/sap.ts';
import type {
  AppComponent, AppPattern, ComputeTarget, Database, DbServiceId, DbTarget, ExtraDbServiceId, ItemId, PatternComponent, Plan,
  PlanDecision, Platform, SizingRecommendation, TierPattern,
} from '../types.ts';
import { defaultTierPattern, PATTERN_CATALOG } from './catalog.ts';
import { isNone, type TierOption } from './model.ts';
import { hanaMemoryOf, isHanaItem } from './sap.ts';
import { SAP_FETCHED_AT, SAP_SOURCES, sapFit } from './sap-data.ts';
import { tierTarget } from './tier-patterns.ts';

const MOVES = new Set(['replicate', 'rebuild']);

// ---------------------------------------------------------------------------
// SAP HANA certified compute
// ---------------------------------------------------------------------------

/** The HANA workloads of a plan placed on `platform` that move by replicate / rebuild. */
export function hanaWorkloadsOn(plan: Plan, decision: PlanDecision, platform: Platform): ItemId[] {
  const ctx = createContext(plan);
  return plan.workloads
    .filter((w) => {
      const d = decision.items[w.id];
      return d?.chosen?.platform === platform && MOVES.has(d.method) && isHanaItem(w, ctx);
    })
    .map((w) => w.id);
}

export const sapCertifiedMapper: DesignMapper = {
  id: 'pattern-sap',
  claims: (plan, decision, platform) => hanaWorkloadsOn(plan, decision, platform),
  map(ctx, design) {
    const findings: Finding[] = [];
    const rctx = createContext(ctx.plan);
    const compute: ComputeTarget[] = [...design.compute];
    let n = 0;
    for (const w of ctx.claimedWorkloads) {
      const d = ctx.decisionOf(w.id);
      if (!d || !MOVES.has(d.method)) continue;
      const placed = placeWorkload(design, w.env, 'db');
      if (!placed) {
        findings.push(error('pattern.sap.no-network', `${w.name}: ${ctx.platform} has no data-tier subnet in a network of its environment to place it in: add one on Landing zones.`));
        continue;
      }
      const { network, zones } = placed;
      const zone = zones.length > 0 ? zones[(hash32(w.app) + n++) % zones.length]! : '';
      const base = computeTargetFor(ctx, w, { network, zone, replicate: d.method === 'replicate' });
      const need = hanaMemoryOf(w, rctx);
      const fit = sapFit(ctx.platform, need);
      if (!fit.type) {
        findings.push(error('pattern.sap.no-certified', `${w.name}: no SAP HANA certified ${ctx.platform} type has ${need} GiB${fit.largest ? `; the largest is ${fit.largest.type} (${fit.largest.memoryGib} GiB)` : ''}.`, {
          source: fit.source,
          remediation: 'Scale out (where certified), or choose another platform.',
        }));
      } else if (fit.verification !== 'V-DOC') {
        findings.push(info('pattern.sap.unverified-certification', `${w.name}: ${fit.type}'s SAP HANA certification is not confirmed from a ${ctx.platform} page [U]; check SAP's directory.`, { source: SAP_SOURCES.directory }));
      }
      const types = diskTypes(ctx.platform, 'db', w.criticality, zone !== '' && zone !== 'default');
      const boot = base.target.disks[0] ?? { gib: 64, type: types.boot };
      compute.push({
        ...base.target,
        size: fit.type ?? '',
        vcpu: fit.vcpu ?? base.target.vcpu,
        ramGib: fit.memoryGib ?? need,
        disks: [boot, ...hanaDisks(need).map((x) => ({ gib: x.gib, type: types.data }))],
        tier: 'db',
        backupTier: BACKUP_TIER_BY_CRITICALITY[w.criticality],
      });
      findings.push(...base.findings.filter((f) => f.code !== 'design.compute.no-size'));
      findings.push(info('pattern.sap.check-directory', `${w.name}: SAP HANA certification changes monthly (lists read ${SAP_FETCHED_AT}); check SAP's certified hardware directory before ordering.`, { source: SAP_SOURCES.directory }));
    }
    return { design: { ...design, compute }, findings };
  },
};

// ---------------------------------------------------------------------------
// A.4.9 database services
// ---------------------------------------------------------------------------

const EXTRA: ReadonlySet<string> = new Set<ExtraDbServiceId>([
  'aws-rds-db2', 'aws-docdb', 'aws-elasticache', 'aws-memorydb', 'aws-keyspaces', 'aws-opensearch',
  'azure-documentdb', 'azure-managed-redis', 'azure-cassandra-mi', 'google-memorystore', 'oci-cache', 'oci-opensearch', 'oci-adb-mongo',
]);

/** Memory-ladder classes per service: [name, GiB]. Starting points, verified against the providers' class lists only where tagged. */
const LADDERS: Readonly<Partial<Record<ExtraDbServiceId, readonly (readonly [string, number])[]>>> = {
  'aws-docdb': [['db.r6g.large', 16], ['db.r6g.xlarge', 32], ['db.r6g.2xlarge', 64], ['db.r6g.4xlarge', 128], ['db.r6g.8xlarge', 256], ['db.r6g.12xlarge', 384], ['db.r6g.16xlarge', 512]],
  'aws-elasticache': [['cache.r7g.large', 13], ['cache.r7g.xlarge', 26], ['cache.r7g.2xlarge', 52], ['cache.r7g.4xlarge', 105], ['cache.r7g.8xlarge', 209], ['cache.r7g.12xlarge', 317], ['cache.r7g.16xlarge', 419]],
  'aws-memorydb': [['db.r7g.large', 13], ['db.r7g.xlarge', 26], ['db.r7g.2xlarge', 52], ['db.r7g.4xlarge', 105], ['db.r7g.8xlarge', 209], ['db.r7g.12xlarge', 317], ['db.r7g.16xlarge', 419]],
  'aws-opensearch': [['r7g.large.search', 16], ['r7g.xlarge.search', 32], ['r7g.2xlarge.search', 64], ['r7g.4xlarge.search', 128], ['r7g.8xlarge.search', 256], ['r7g.12xlarge.search', 384], ['r7g.16xlarge.search', 512]],
  'azure-documentdb': [['M30', 8], ['M40', 16], ['M50', 32], ['M60', 64], ['M80', 128], ['M200', 256]],
  'azure-managed-redis': [['Balanced_B1', 1], ['Balanced_B3', 3], ['Balanced_B5', 6], ['Balanced_B10', 12], ['Balanced_B20', 24], ['Balanced_B50', 60], ['Balanced_B100', 120], ['Balanced_B150', 180], ['Balanced_B250', 240], ['Balanced_B350', 360], ['Balanced_B500', 480], ['Balanced_B700', 720], ['Balanced_B1000', 960]],
  'azure-cassandra-mi': [['Standard_E8s_v5', 64], ['Standard_E16s_v5', 128], ['Standard_E32s_v5', 256], ['Standard_E64s_v5', 512]],
};

/** A class for an A.4.9 service: the smallest ladder step with the database's memory, else a service-specific form. */
export function extraClassFor(service: ExtraDbServiceId, db: Pick<Database, 'vcpu' | 'ramGib'>): string {
  const ladder = LADDERS[service];
  if (ladder) return (ladder.find(([, gib]) => gib >= db.ramGib) ?? ladder[ladder.length - 1]!)[0];
  switch (service) {
    case 'aws-keyspaces': return 'on-demand';
    case 'google-memorystore': return `SHARED_CORE_NANO x ${Math.max(1, Math.ceil(db.ramGib / 13))} shard(s)`;
    case 'oci-cache': return `${Math.max(2, Math.ceil(db.ramGib))} GB x 3 nodes`;
    case 'oci-opensearch': return `${Math.max(1, Math.ceil(db.vcpu / 2))} OCPU / ${Math.max(16, Math.ceil(db.ramGib))} GB data nodes`;
    case 'oci-adb-mongo': return `${Math.max(2, db.vcpu)} ECPU`;
    default: return '';
  }
}

export const extraDbMapper: DesignMapper = {
  id: 'pattern-db-extra',
  claims(plan, decision, platform) {
    return plan.databases
      .filter((db) => {
        const d = decision.items[db.id];
        return d?.chosen?.platform === platform && d.method !== 'none' && !!d.chosen.service && EXTRA.has(d.chosen.service);
      })
      .map((db) => db.id);
  },
  map(ctx, design) {
    const findings: Finding[] = [];
    const databases: DbTarget[] = [...design.databases];
    for (const db of ctx.claimedDatabases) {
      const service = ctx.decisionOf(db.id)?.chosen?.service as DbServiceId | undefined;
      if (!service || !EXTRA.has(service)) continue;
      const crit = ctx.plan.apps.find((a) => a.name === db.app)?.criticality ?? 'tier2';
      databases.push({
        database: db.id,
        service,
        classOrShape: extraClassFor(service as ExtraDbServiceId, db),
        storageGib: Math.max(1, Math.ceil(db.sizeGib)),
        ha: crit === 'tier0' || crit === 'tier1' ? 'multi-zone' : 'single-zone',
        licenceModel: DB_SERVICES[service].licence.includes('li') ? 'Licence included' : 'BYOL',
        backupTier: BACKUP_TIER_BY_CRITICALITY[crit],
        engineVersion: '',
      });
      findings.push(info('pattern.db.class-starting-point', `${db.name}: ${DB_SERVICES[service].label} class ${extraClassFor(service as ExtraDbServiceId, db)} is a starting point from its memory; confirm it against the service's current class list.`, {
        source: DB_SERVICES[service].source,
      }));
    }
    return { design: { ...design, databases }, findings };
  },
};

/** The pattern mappers, in the positions they take. */
export const PATTERN_MAPPERS: readonly DesignMapper[] = Object.freeze([sapCertifiedMapper, extraDbMapper]);

/** WP-4's pipeline with the pattern mappers inserted (SAP after compute, the A.4.9 databases after database). */
export function withPatternMappers(list: readonly DesignMapper[] = DESIGN_MAPPERS): DesignMapper[] {
  return insertMapper(extraDbMapper, { after: 'database' }, insertMapper(sapCertifiedMapper, { after: 'compute' }, list));
}

// ---------------------------------------------------------------------------
// Pattern targets
// ---------------------------------------------------------------------------

export interface PatternTarget {
  readonly app: ItemId;
  readonly pattern: AppPattern;
  readonly component: string;
  readonly tierPattern: TierPattern;
  /** The service, or why there is none. */
  readonly target: TierOption;
  readonly terraform: readonly string[];
  readonly sizing: readonly SizingRecommendation[];
}

/**
 * Size a pattern component on a platform (A.4.3 `sizeFor`): the WP-23
 * engines that apply to it, which read the pattern answers from the plan's
 * app plan and the component's settings. Returns the rows and findings.
 */
export function sizeFor(plan: Plan, component: AppComponent, platform: Platform, engines?: readonly SizingEngine[]): { rows: SizingRecommendation['rows']; findings: Finding[]; recommendations: SizingRecommendation[] } {
  const recs = engines ? sizeComponent(component, platform, plan, engines) : sizeComponent(component, platform, plan);
  return { rows: recs.flatMap((r) => r.rows), findings: recs.flatMap((r) => r.findings), recommendations: recs };
}

/** Every pattern component of every app plan on a platform, with its tier pattern, service, types and sizing. */
export function patternTargets(plan: Plan, platform: Platform): PatternTarget[] {
  const out: PatternTarget[] = [];
  for (const ap of plan.appPlans ?? []) {
    const app = plan.apps.find((a) => a.id === ap.app);
    const pattern: AppPattern = app?.pattern ?? 'generic';
    const entry = PATTERN_CATALOG[pattern];
    const comps = (ap.variants[platform] ?? []).filter((c): c is PatternComponent => c.kind === 'pattern');
    for (const c of comps) {
      const template = entry.components.find((t) => t.name === c.name || t.tier === c.tier) ?? entry.components[0];
      const tp = c.tierPattern ?? (template ? defaultTierPattern(template, platform) : 'vm');
      const target = tierTarget(tp, platform);
      out.push({
        app: ap.app,
        pattern,
        component: c.id,
        tierPattern: tp,
        target,
        terraform: isNone(target) ? [] : target.terraform,
        sizing: sizeFor(plan, c, platform).recommendations,
      });
    }
  }
  return out;
}
