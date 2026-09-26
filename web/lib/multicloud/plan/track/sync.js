/**
 * The tracker's items from the plan (addendum A.8.1 "Initialisation and
 * sync"), and the context every other tracker module reads the plan through.
 *
 * - Workloads and databases are tracked items; apps are roll-ups.
 * - Retained items are not tracked (they are counted under "Retained").
 * - Retired items are tracked on the path `retire`.
 * - A replatformed database's host VM (method `managed-db`) is a `retire`
 *   item that follows its database: it is decommissioned when the database
 *   is accepted (`TrackContext.followers`).
 * - New services (disposition `new`, synthetic workloads) are `app-deploy`
 *   items on the path `deploy`.
 *
 * `syncTracker` adds new items as `planned`, marks items that left the plan
 * `removed` (kept for history), re-waves only items still `planned`, and
 * writes a Decisions-log entry for every re-wave.
 *
 * The move path comes from `plan.execution.pathOverrides`, then the caller's
 * `pathOf`, then WP-11's `movePathFor` / `dbPathFor` (execute/paths.ts), then
 * a default read from the decision's method and platform.
 *
 * Pure: the time is passed in.
 */

import { DEFAULT_HYPERCARE_DAYS, DEFAULT_KEEP_DAYS, platformOfService } from '../options.js';
             
                                                                                                                                     
                     
import { recordDecision,                    } from './raid.js';
import { plannedStatus,                } from './states.js';
import { emptyTracker } from '../store.js';
import { dbPathFor, movePathFor } from '../execute/paths.js';

/** What the tracker needs to know about the plan, gathered once. */
                                                     
                          
                            
                         
                                              
                             
                                             
                          
                                               
                                           
                                                    
                                                         
                                                                  
                                                                                                                      
                                                                         
                                                  
                                                        
                                                    
                                                           
                                                                
                                                                        
                            
                                                                                          
                                   
                                
                                                   
                            
 

/** The context for a plan (the decision and waves when there are any). */
export function trackContext(plan      , decision                           = plan.decision, waves           )               {
  const names = new Map                ();
  const apps = new Map                ();
  const byName = new Map                  ();
  const platforms = new Map                  ();
  const criticality = new Map                     ();
  const size = new Map                                                              ();
  const sourceHosts = new Map                ();
  const strategies = new Map                ();
  const push = (key        , id        )       => {
    const k = key.trim().toLowerCase();
    if (!k) return;
    const list = byName.get(k) ?? [];
    if (!list.includes(id)) list.push(id);
    byName.set(k, list);
  };
  const appCrit = new Map(plan.apps.map((a) => [a.name.toLowerCase(), a.criticality]));
  let retained = 0;
  for (const w of plan.workloads) {
    names.set(w.id, w.name);
    apps.set(w.id, w.app);
    push(w.name, w.id);
    push(w.app, w.id);
    criticality.set(w.id, w.criticality);
    size.set(w.id, { vcpu: w.vcpu, ramGib: w.ramGib, storageGib: w.disksGib.reduce((a, b) => a + b, 0) });
    const host = w.sourceRef?.host;
    if (host) sourceHosts.set(w.id, host);
    const d = decision?.items[w.id];
    if (d?.chosen) platforms.set(w.id, d.chosen.platform);
    const disp = d?.disposition ?? w.disposition;
    if (disp === 'retain') retained += 1;
    const strategy = w.strategy ?? disp;
    if (strategy) strategies.set(w.id, strategy);
  }
  for (const db of plan.databases) {
    names.set(db.id, db.name);
    apps.set(db.id, db.app);
    push(db.name, db.id);
    push(db.app, db.id);
    criticality.set(db.id, appCrit.get(db.app.toLowerCase()) ?? 'tier2');
    size.set(db.id, { vcpu: db.vcpu, ramGib: db.ramGib, storageGib: db.sizeGib });
    const d = decision?.items[db.id];
    if (d?.chosen) platforms.set(db.id, d.chosen.service ? platformOfService(d.chosen.service) : d.chosen.platform);
    if (d?.disposition === 'retain') retained += 1;
    const strategy = db.strategy ?? d?.disposition;
    if (strategy) strategies.set(db.id, strategy);
  }
  const exec = plan.execution;
  return {
    planId: plan.id,
    planName: plan.name,
    names,
    apps,
    byName,
    owners: new Map(plan.apps.filter((a) => a.owner || a.businessOwner).map((a) => [a.name, (a.owner ?? a.businessOwner)          ])),
    platforms,
    criticality,
    size,
    followers: followersFor(plan, decision),
    sourceHosts,
    keepDays: exec?.keepDays ?? DEFAULT_KEEP_DAYS,
    hypercareDays: exec?.hypercareDays ?? DEFAULT_HYPERCARE_DAYS,
    lagSeconds: exec?.lagSeconds ?? { server: 60, db: 0 },
    ...(waves ? { waves } : {}),
    timelineMonths: plan.requirements.timelineMonths,
    planSavedAt: plan.savedAt,
    strategies,
    retained,
  };
}

/** Host VMs of replatformed databases → the database each follows. */
export function followersFor(plan      , decision                           = plan.decision)                      {
  const out = new Map                ();
  if (!decision) return out;
  const byName = new Map(plan.workloads.map((w) => [w.name.toLowerCase(), w]));
  for (const db of plan.databases) {
    for (const host of db.hosts) {
      const w = byName.get(host.toLowerCase());
      if (w && decision.items[w.id]?.method === 'managed-db') out.set(w.id, db.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which items, which path, which wave
// ---------------------------------------------------------------------------

                                                                                          

const REPLICATE_PATH                                        = {
  aws: 'aws-mgn', azure: 'azure-migrate', google: 'gcp-m2vm', oci: 'oci-ocm', vmware: 'hcx-bulk',
};
const MANAGED_DB_PATH                                        = {
  aws: 'aws-dms', azure: 'azure-dms', google: 'gcp-dms', oci: 'oci-dms', vmware: 'with-vm',
};

/**
 * The default path until WP-11's `movePathFor` / `dbPathFor` is passed as
 * `pathOf`: read from the decision's method and target platform (A.6.1's
 * first rows). An override in `plan.execution.pathOverrides` wins over both.
 */
export function defaultTrackPath(kind                         , d                          , w           )            {
  const disposition = d?.disposition ?? w?.disposition;
  if (disposition === 'new' || w?.synthetic) return 'deploy';
  if (kind === 'database') {
    if (d?.method === 'managed-db') {
      const svc = d.chosen?.service;
      const p = svc ? platformOfService(svc) : d.chosen?.platform;
      return p ? MANAGED_DB_PATH[p] : 'with-vm';
    }
    return 'with-vm';
  }
  if (!d) return disposition === 'retire' || disposition === 'repurchase' ? 'retire' : 'rebuild';
  switch (d.method) {
    case 'none':
      return 'retire';
    case 'managed-db':
      return 'retire';
    case 'rebuild':
      return 'rebuild';
    case 'relocate-hcx':
      return w?.facts?.powerState === 'poweredOff' ? 'hcx-cold' : 'hcx-bulk';
    case 'replicate':
      return d.chosen ? REPLICATE_PATH[d.chosen.platform] : 'rebuild';
    default:
      return 'rebuild';
  }
}

/** WP-11's path for the item, when there is a decision (undefined when it has none, or cannot say). */
function executePath(plan      , decision                          , kind                         , id        , w           )                        {
  if (!decision?.items[id]) return undefined;
  try {
    if (kind === 'workload') return w ? movePathFor(w, plan, decision) : undefined;
    const db = plan.databases.find((x) => x.id === id);
    return db ? dbPathFor(db, plan, decision) : undefined;
  } catch {
    return undefined;
  }
}

                   
                      
                                
                           
                        
                              
 

/** The items the plan tracks now, with their kind, path and wave. */
export function plannedItems(plan      , decision                          , waves                      , pathOf         )            {
  const groupOf = new Map                                      ();
  for (const g of waves?.groups ?? []) for (const id of g.items) groupOf.set(id, { wave: g.wave, id: g.id });
  const appWave = new Map(plan.apps.filter((a) => a.wave !== undefined).map((a) => [a.name.toLowerCase(), a.wave          ]));
  const overrides = plan.execution?.pathOverrides ?? {};
  const out            = [];
  const add = (id        , app        , kind                         , w           )       => {
    const d = decision?.items[id];
    const disposition = d?.disposition ?? w?.disposition;
    if (disposition === 'retain') return;
    const followsDb = kind === 'workload' && d?.method === 'managed-db';
    const path = followsDb ? 'retire' : overrides[id] ?? pathOf?.(id, kind) ?? executePath(plan, decision, kind, id, w) ?? defaultTrackPath(kind, d, w);
    const g = groupOf.get(id);
    const isNew = disposition === 'new' || w?.synthetic === true;
    out.push({
      id,
      kind: isNew ? 'app-deploy' : kind,
      path,
      wave: g?.wave ?? appWave.get(app.toLowerCase()) ?? 0,
      ...(g ? { moveGroup: g.id } : w?.moveGroup ? { moveGroup: w.moveGroup } : {}),
    });
  };
  for (const w of plan.workloads) add(w.id, w.app, 'workload', w);
  for (const db of plan.databases                       ) add(db.id, db.app, 'database');
  return out;
}

                              
                                                                             
                       
                           
 

/** A new tracker for a plan: one `planned` item per in-scope workload and database. */
export function trackerFor(plan      , decision                           = plan.decision, waves           , options              = {})          {
  const at = options.at ?? new Date().toISOString();
  const items                             = {};
  for (const p of plannedItems(plan, decision, waves, options.pathOf)) items[p.id] = plannedStatus(p.id, p.kind, p.wave, p.path, at, p.moveGroup);
  return { ...emptyTracker(plan.id, at), items };
}

                             
                                    
                                      
                                       
                                                                                                     
                                                                                                                   
                                       
 

/**
 * Bring the tracker in line with the plan's decision and waves (A.8.1). Items
 * under way keep their wave and path; the report lists them as `heldBack`.
 */
export function syncTracker(
  tracker         , plan      , decision                           = plan.decision, waves           , options              = {},
)                                           {
  const at = options.at ?? new Date().toISOString();
  const wanted = plannedItems(plan, decision, waves, options.pathOf);
  const wantedIds = new Set(wanted.map((p) => p.id));
  const items                             = { ...tracker.items };
  const added           = [];
  const removed           = [];
  const restored           = [];
  const rewaved                                               = [];
  const heldBack           = [];
  const names = new Map([...plan.workloads, ...plan.databases].map((x) => [x.id, x.name]));

  for (const p of wanted) {
    const cur = items[p.id];
    if (!cur) {
      items[p.id] = plannedStatus(p.id, p.kind, p.wave, p.path, at, p.moveGroup);
      added.push(p.id);
      continue;
    }
    let next             = cur;
    if (cur.removed) {
      const { removed: _gone, ...rest } = cur;
      next = rest;
      restored.push(p.id);
    }
    if (cur.state === 'planned') {
      if (cur.wave !== p.wave) rewaved.push({ item: p.id, from: cur.wave, to: p.wave });
      next = {
        ...next, wave: p.wave, path: p.path, kind: p.kind,
        ...(p.moveGroup ? { moveGroup: p.moveGroup } : {}),
      };
      if (!p.moveGroup && 'moveGroup' in next) {
        const { moveGroup: _g, ...rest } = next;
        next = rest;
      }
    } else if (cur.wave !== p.wave || cur.path !== p.path) {
      heldBack.push(p.id);
    }
    items[p.id] = next;
  }
  for (const [id, cur] of Object.entries(items)) {
    if (!wantedIds.has(id) && !cur.removed) {
      items[id] = { ...cur, removed: true };
      removed.push(id);
    }
  }

  let t          = { ...tracker, items };
  for (const r of rewaved) {
    t = recordDecision(t, {
      decision: `Re-waved ${names.get(r.item) ?? r.item} from wave ${r.from} to wave ${r.to}.`,
      rationale: 'The plan’s waves changed while the item was still planned.',
      date: at.slice(0, 10),
      source: 're-wave',
      links: [r.item],
    });
  }
  return { tracker: t, report: { added, removed, restored, rewaved, heldBack } };
}
