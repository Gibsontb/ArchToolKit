/**
 * The target design: `designPlan(plan, decision)` turns a decided plan into a
 * `TargetDesign`, one `PlatformDesign` per platform in the decision.
 *
 * It is a pipeline of per-concern mappers, run in order for each platform,
 * each taking the design so far and returning it with its part filled:
 *
 *   network → compute → database → identity → connectivity → backup → relocate → overrides
 *
 * Every mapper is pure. The item overrides from `plan.designOverrides`
 * (`compute:<id>:size`, `db:<id>:class`, …) are applied last; the
 * landing-zone card's fields (`<platform>:lz:<field>`) are inputs the network
 * mapper reads first.
 *
 * **Adding a mapper** (SAP HANA certified sizes, VDI host pools, file shares,
 * container clusters, another source type): write a `DesignMapper` and put it
 * in the list with `insertMapper`, then pass the list to `designPlan`.
 * A mapper that takes over items (a HANA workload the generic compute mapper
 * must not size) lists them in `claims`; they are then left out of
 * `ctx.workloads` / `ctx.databases` for every mapper, and the claiming mapper
 * reads them from `ctx.claimedWorkloads` / `ctx.claimedDatabases`.
 */

import { info, warning,              } from '../../../core/findings.js';
import { overlapsAny as overlaps } from '../../../core/ip.js';
import { DEFAULT_REGIONS, overrideKey, PLATFORM_VALUES } from '../options.js';
             
                                                                                                                   
                                         
                     
import { backupMapper } from './backup.js';
import { computeMapper, sizeInCatalog } from './compute.js';
import { connectivityMapper } from './connectivity.js';
import { classInCatalog, databaseMapper } from './database.js';
import { identityMapper, strategyFor } from './identity.js';
import { landingZoneSettings, networkMapper, networkZones,                          } from './network.js';
import { relocateMapper } from './relocate.js';

export { carveSubnets, foundationPlansFor, ula48, zoneNames, landingZoneSettings, siteCidrs, networkForEnv } from './network.js';
                                                                      
export { computeTargetFor, sizeInCatalog, tierForRole, diskTypes, licenceKeyOf, LICENCE_HANDLING_TEXT, isIaasService } from './compute.js';
                                                       
export { classFor, classInCatalog, rdsClass, cloudSqlTier } from './database.js';
export { dcWorkloads, designWorkloads, MANAGED_AD } from './identity.js';
export { tunnelsFor, methodFor, CIRCUITS_FOR } from './connectivity.js';
export { backupSchedule } from './backup.js';
export { relocateNodes, relocateService, RELOCATE_HOSTS } from './relocate.js';

// ---------------------------------------------------------------------------
// The mapper contract
// ---------------------------------------------------------------------------

                                
                      
                                  
                              
                                                        
                                   
                                                                                               
                                          
                                                                                        
                                           
                                                                          
                                          
                                                                
                                        
                                                 
                                                 
                                                   
                                                     
 

                               
                                  
                                         
 

                               
                                
                      
                                                                                               
                                                                                    
                                                                
 

// ---------------------------------------------------------------------------
// Overrides (last)
// ---------------------------------------------------------------------------

const TIERS                         = ['web', 'app', 'db', 'mgmt'];
const BACKUP                          = ['gold', 'silver', 'bronze'];

/**
 * The item overrides, applied last:
 * - `compute:<id>:size | cores | zone | tier | backup`
 * - `db:<id>:class | backup | ha | version`
 * A size or class the catalog does not know is applied with a warning.
 */
export const overridesMapper               = {
  id: 'overrides',
  map(ctx, design) {
    const findings            = [];
    const o = ctx.plan.designOverrides;
    const get = (scope        , id        , field        )                     => {
      const v = o[overrideKey(scope, id, field)];
      return v === undefined || v.trim() === '' ? undefined : v.trim();
    };
    const compute = design.compute.map((c)                => {
      let t                = c;
      const size = get('compute', c.workload, 'size');
      if (size !== undefined && size !== c.size) {
        if (!sizeInCatalog(ctx.platform, size)) {
          findings.push(warning('design.override.unknown-size', `${c.workload}: ${size} is not in the ${ctx.platform} catalog.`, { path: overrideKey('compute', c.workload, 'size') }));
        }
        const { coreCount: _c, ...rest } = t;
        t = { ...rest, size };
      }
      const cores = get('compute', c.workload, 'cores');
      if (cores !== undefined && Number.isInteger(Number(cores)) && Number(cores) > 0) t = { ...t, coreCount: Number(cores) };
      const zone = get('compute', c.workload, 'zone');
      if (zone !== undefined) {
        const net = design.networks.find((n) => n.name === t.network);
        if (net && !networkZones(net).includes(zone)) {
          findings.push(warning('design.override.unknown-zone', `${c.workload}: zone ${zone} is not one of the ${t.network} network's.`, { path: overrideKey('compute', c.workload, 'zone') }));
        } else {
          t = { ...t, zone };
        }
      }
      const tier = get('compute', c.workload, 'tier');
      if (tier !== undefined && (TIERS                     ).includes(tier)) t = { ...t, tier: tier                };
      const backup = get('compute', c.workload, 'backup');
      if (backup !== undefined && (BACKUP                     ).includes(backup)) t = { ...t, backupTier: backup                 };
      return t;
    });
    const databases = design.databases.map((d)           => {
      let t           = d;
      const cls = get('db', d.database, 'class');
      if (cls !== undefined && cls !== d.classOrShape) {
        if (!classInCatalog(d.service, cls)) {
          findings.push(warning('design.override.unknown-class', `${d.database}: ${cls} is not a known ${d.service} class.`, { path: overrideKey('db', d.database, 'class') }));
        }
        t = { ...t, classOrShape: cls };
      }
      const backup = get('db', d.database, 'backup');
      if (backup !== undefined && (BACKUP                     ).includes(backup)) t = { ...t, backupTier: backup                 };
      const ha = get('db', d.database, 'ha');
      if (ha !== undefined) t = { ...t, ha };
      const version = get('db', d.database, 'version');
      if (version !== undefined) t = { ...t, engineVersion: version };
      return t;
    });
    return { design: { ...design, compute, databases }, findings };
  },
};

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export const DESIGN_MAPPERS                          = Object.freeze([
  networkMapper,
  computeMapper,
  databaseMapper,
  identityMapper,
  connectivityMapper,
  backupMapper,
  relocateMapper,
  overridesMapper,
]);

/**
 * A copy of `list` with `mapper` added before or after the mapper with that
 * id (or at the end, before the overrides). A mapper with the same id is
 * replaced in place.
 */
export function insertMapper(
  mapper              ,
  where                                                                   = 'end',
  list                          = DESIGN_MAPPERS,
)                 {
  const at = list.findIndex((m) => m.id === mapper.id);
  if (at >= 0) return list.map((m, i) => (i === at ? mapper : m));
  const out = [...list];
  if (where === 'end') {
    const overrides = out.findIndex((m) => m.id === 'overrides');
    out.splice(overrides >= 0 ? overrides : out.length, 0, mapper);
    return out;
  }
  const ref = 'before' in where ? where.before : where.after;
  const i = out.findIndex((m) => m.id === ref);
  if (i < 0) throw new RangeError(`No design mapper "${ref}".`);
  out.splice('before' in where ? i : i + 1, 0, mapper);
  return out;
}

const MOVES                      = new Set(['replicate', 'rebuild']);

/** The platforms the design covers: the decision's, plus any an item was placed on outside it. */
function platformsOf(plan      , decision              , findings           )             {
  const chosen = new Set          (decision.platforms);
  for (const d of Object.values(decision.items)) {
    if (d.chosen && d.method !== 'none' && !chosen.has(d.chosen.platform)) {
      chosen.add(d.chosen.platform);
      findings.push(warning('design.platform-outside-decision', `${d.id} is placed on ${d.chosen.platform}, which is not in the decision's platforms; it is designed there anyway.`));
    }
  }
  return PLATFORM_VALUES.filter((p) => chosen.has(p));
}

function contextFor(plan      , decision              , platform          , mappers                         , lz                     )                {
  const claimed = new Set        ();
  for (const m of mappers) for (const id of m.claims?.(plan, decision, platform) ?? []) claimed.add(id);
  const decisionOf = (id        )                           => decision.items[id];
  const on = (id        )                           => {
    const d = decision.items[id];
    return d?.chosen?.platform === platform && d.method !== 'none' ? d : undefined;
  };
  const placedWorkloads = plan.workloads.filter((w) => on(w.id));
  const placedDatabases = plan.databases.filter((db) => on(db.id));
  const byName = new Map(plan.workloads.map((w) => [w.name, w]));
  return {
    plan,
    decision,
    platform,
    lz,
    workloads: placedWorkloads.filter((w) => !claimed.has(w.id) && MOVES.has(on(w.id) .method)),
    relocating: placedWorkloads.filter((w) => !claimed.has(w.id) && on(w.id) .method === 'relocate-hcx'),
    databases: placedDatabases.filter((db) => !claimed.has(db.id)),
    claimed,
    claimedWorkloads: placedWorkloads.filter((w) => claimed.has(w.id)),
    claimedDatabases: placedDatabases.filter((db) => claimed.has(db.id)),
    decisionOf,
    workloadByName: (name) => byName.get(name),
  };
}

/** The empty design a platform starts from, with the landing-zone card's settings. */
export function platformSkeleton(plan      , platform          , lz                     )                 {
  const region = plan.requirements.regions[platform];
  const prefix = `${platform}:`;
  return {
    platform,
    prefix: lz.prefix,
    region: region?.primary?.trim() || DEFAULT_REGIONS[platform]?.primary || '',
    ...(region?.dr?.trim() ? { drRegion: region.dr.trim() } : {}),
    ...(lz.scope ? { scope: lz.scope } : {}),
    networks: [],
    bastion: lz.bastion,
    logRetentionDays: lz.logRetentionDays,
    compute: [],
    databases: [],
    connectivity: [],
    identity: { strategy: strategyFor(plan.requirements.identity.adStrategy, platform), dcNames: [] },
    backup: { tiers: [] },
    overrides: Object.fromEntries(Object.entries(plan.designOverrides).filter(([k]) => k.startsWith(prefix))),
  };
}

/** Keep, in `overrides`, the item overrides that touch this platform's targets. */
function withItemOverrides(plan      , design                )                 {
  const ids = new Set        ([...design.compute.map((c) => c.workload), ...design.databases.map((d) => d.database)]);
  const extra = Object.entries(plan.designOverrides).filter(([k]) => {
    const m = /^(compute|db):(.+):[^:]+$/.exec(k);
    return !!m && ids.has(m[2] );
  });
  return extra.length === 0 ? design : { ...design, overrides: { ...design.overrides, ...Object.fromEntries(extra) } };
}

/** The design for one platform, through `mappers` in order. */
export function designPlatform(plan      , decision              , platform          , mappers                          = DESIGN_MAPPERS)                                                  {
  const lz = landingZoneSettings(plan, platform);
  const findings            = [...lz.findings];
  const ctx = contextFor(plan, decision, platform, mappers, lz.settings);
  let design = platformSkeleton(plan, platform, lz.settings);
  if (!design.region) {
    findings.push(warning('design.no-region', `${platform}: no primary region is set.`, { path: `requirements.regions.${platform}.primary` }));
  }
  for (const m of mappers) {
    const r = m.map(ctx, design);
    design = r.design;
    findings.push(...(r.findings ?? []));
  }
  return { design: withItemOverrides(plan, design), findings };
}

/** The whole target design: every platform in the decision, through the mappers. */
export function designPlan(plan      , decision              , mappers                          = DESIGN_MAPPERS)               {
  const findings            = [];
  const platforms                   = [];
  for (const platform of platformsOf(plan, decision, findings)) {
    const r = designPlatform(plan, decision, platform, mappers);
    platforms.push(r.design);
    findings.push(...r.findings);
  }

  // Networks on different platforms must not overlap either: they will be routed to each other.
  const nets = platforms.flatMap((p) => p.networks.map((n) => ({ platform: p.platform, n })));
  for (let i = 0; i < nets.length; i += 1) {
    for (let j = i + 1; j < nets.length; j += 1) {
      const a = nets[i] ;
      const b = nets[j] ;
      if (a.platform !== b.platform && overlaps(a.n.cidr, b.n.cidr)) {
        findings.push(warning('design.network.cross-platform-overlap', `${a.platform} ${a.n.name} (${a.n.cidr}) overlaps ${b.platform} ${b.n.name} (${b.n.cidr}); they cannot be routed to each other.`, {
          path: overrideKey(b.platform, `network-${b.n.name}`, 'cidr'),
        }));
      }
    }
  }
  if (platforms.length === 0) findings.push(info('design.empty', 'The decision places nothing, so there is nothing to design.'));
  return { platforms, findings };
}
