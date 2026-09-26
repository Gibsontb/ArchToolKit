/**
 * The decision engine: every item's options scored by named rules, then the
 * platform subset chosen for the estate, then each item assigned inside it.
 *
 * Pure: no DOM, no storage, no clock unless `today` is left to default. The
 * same plan always gives the same `PlanDecision`, and `ENGINE_VERSION` is
 * stored with it so a loaded plan shows the answer it was saved with.
 *
 * Rules are data: an array of `ItemRule` objects with ids (the registry in
 * `rules/index.ts`). A rule scores or eliminates one option at a time, and
 * may raise findings per item (`findings`) or after assignment (`review`).
 * Adding a rule is adding an object to a rule file; the engine never names a
 * rule except the two it applies after assignment (`db.hosts-follow` and the
 * estate snaps).
 *
 * The algorithm is design section 2.5:
 *   1. disposition and method per workload (`disposition.ts`);
 *   2. options per item (five platforms per workload; every service that runs
 *      the engine, per platform, for a database);
 *   3. rules per option, summed into a score, with eliminations;
 *   4. the estate subset (`estate.ts`);
 *   5. assignment inside the subset;
 *   6. the affinity pass (`affinity.ts`);
 *   7. margins, findings and database coupling.
 */

import { info, warning,              } from '../../../core/findings.js';
import { PLATFORMS,               } from '../../platforms.js';
import { DB_SERVICES, servicesFor } from '../db-catalog.js';
import { LICENSING_FACTS, licenceNeed,                     } from '../licensing-facts.js';
             
                                                                                                              
                                                              
                     
import { isDatabase, workloadPlacement,                               } from './disposition.js';
import { RULES } from './rules/index.js';
import { buildUnits, chooseSubset, assignUnits,                            } from './estate.js';
import { affinityPass } from './affinity.js';
import { HOSTS_FOLLOW, hostsFollow } from './rules/databases.js';

                                                            

/** Bumped whenever a rule, weight or the algorithm changes. */
export const ENGINE_VERSION = '1';

/** The margin recorded when an item has no alternative on another platform. */
export const NO_ALTERNATIVE_MARGIN = 99;
/** A margin under this is "close", as decide.ts had it. */
export const CLOSE_MARGIN = 2;

// ---------------------------------------------------------------------------
// The rule contract
// ---------------------------------------------------------------------------

                             
                              
                                 
 

                             
                          
                               
                          
 

                              
                      
                                      
                                 
                                                         
                         
                                                                                     
                                 
                                                      
                                                          
                                                             
                                                         
                                                   
                                                                                                              
                                                                
 

                                                          
                                                                 
                      
                                                 
                                                 
                                       
                                      
                           
                                                                        
                                                            
                                                         
                                                                                                
                                                      
                                                                        
                                                                      
                                                                                                  
 

/** A rule of any kind, as the registry holds them. */
                                                                                   

/** Type a rule without widening its item parameter. */
export function rule                    (r             )          {
  return r                      ;
}

                                
                                                                                  
                                      
                                                            
                          
                                                                              
                                  
                                                                   
                                  
 

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export function createContext(plan      , options                = {})              {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const apps = new Map             ();
  for (const a of plan.apps) apps.set(a.name, a);
  const workloadsByName = new Map                  ();
  for (const w of plan.workloads) workloadsByName.set(w.name, w);
  const dbsByHost = new Map                    ();
  for (const d of plan.databases) {
    for (const h of d.hosts) {
      const list = dbsByHost.get(h) ?? [];
      list.push(d);
      dbsByHost.set(h, list);
    }
  }
  const placements = new Map                   ();
  const appOf = (item          )                  => (item.app ? apps.get(item.app) : undefined);
  return {
    plan,
    requirements: plan.requirements,
    facts: options.facts ?? LICENSING_FACTS,
    today,
    workloadCount: options.workloadCount ?? plan.workloads.length,
    appOf,
    hostsOf: (db) => db.hosts.map((n) => workloadsByName.get(n)).filter((w)                => w !== undefined),
    databasesOf: (w) => dbsByHost.get(w.name) ?? [],
    placementOf: (w) => {
      let p = placements.get(w.id);
      if (!p) {
        p = workloadPlacement(w, appOf(w), plan.requirements, today);
        placements.set(w.id, p);
      }
      return p;
    },
    dbRouteOf: (db) => {
      const route = appOf(db)?.route;
      return route === 'retire' || route === 'retain' || route === 'repurchase' ? route : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Options per item
// ---------------------------------------------------------------------------

/** `commercial` on Oracle / SQL Server is "edition not confirmed": treated as Enterprise, the conservative position. */
export function effectiveEdition(db          )            {
  if (db.edition !== 'commercial') return db.edition;
  if (db.engine === 'oracle') return 'oracle-ee';
  if (db.engine === 'sqlserver') return 'sql-enterprise';
  return 'commercial';
}

/** The options an item is scored on: every platform for a workload; every (platform, service) that runs the engine for a database. */
export function optionSpecs(item          )               {
  if (!isDatabase(item)) return PLATFORMS.map((platform) => ({ platform }));
  const edition = effectiveEdition(item);
  const specs               = [];
  for (const platform of PLATFORMS) {
    for (const s of servicesFor(item.engine, platform, edition)) specs.push({ platform, service: s.id });
  }
  return specs;
}

const PLATFORM_INDEX                                     = Object.fromEntries(PLATFORMS.map((p, i) => [p, i]))                            ;
const SERVICE_INDEX = new Map                     (Object.keys(DB_SERVICES).map((s, i) => [s               , i]));

/** Best first: surviving before eliminated, then score, then platform order, then catalog order. */
export function compareOptions(a        , b        )         {
  if (!!a.eliminated !== !!b.eliminated) return a.eliminated ? 1 : -1;
  if (b.score !== a.score) return b.score - a.score;
  const p = PLATFORM_INDEX[a.platform] - PLATFORM_INDEX[b.platform];
  if (p !== 0) return p;
  return (a.service ? SERVICE_INDEX.get(a.service) ?? 0 : 0) - (b.service ? SERVICE_INDEX.get(b.service) ?? 0 : 0);
}

function kindOf(item          )                          {
  return isDatabase(item) ? 'database' : 'workload';
}

/** The rules that apply to an item (kind and gate). */
export function activeRules(item          , ctx             , rules                     = RULES)                       {
  const kind = kindOf(item);
  const out                       = [];
  for (const r0 of rules) {
    const r = r0                      ;
    if (r.kind !== 'any' && r.kind !== kind) continue;
    if (r.applies && !r.applies(item, ctx)) continue;
    out.push(r);
  }
  return out;
}

function licenceFor(item          , spec            , ctx             , eliminated         )              {
  const need = licenceNeed(item, spec.platform, spec.service, { licensing: ctx.requirements.licensing, facts: ctx.facts });
  if (!need.eliminated || eliminated) return need;
  // The licence position alone would rule it out, but no rule did: the option
  // stands on a licence-included basis (e.g. RDS SE2 over the ACE cap).
  return { kind: need.kind, count: 0, model: 'li', note: `Licence included: ${need.note}`, ...(need.facts ? { facts: need.facts } : {}) };
}

                                 
                             
                               
                                                
 

/** Every option of one item, scored and sorted best first, plus the rules' per-item findings. */
export function evaluateItem(item          , ctx             , rules                     = RULES)                 {
  const active = activeRules(item, ctx, rules);
  const scorers = active.filter((r) => r.evaluate);
  const options           = [];
  for (const spec of optionSpecs(item)) {
    let score = 0;
    let eliminated                    ;
    const hits            = [];
    for (const r of scorers) {
      const res = r.evaluate (item, spec, ctx);
      if (!res) continue;
      const delta = res.delta ?? 0;
      score += delta;
      if (res.eliminate && eliminated === undefined) eliminated = r.id;
      hits.push({
        rule: r.id,
        ...(r.aliases && r.aliases.length > 0 ? { aliases: r.aliases } : {}),
        delta,
        reason: res.reason,
        verification: r.verification,
        ...(r.source ? { source: r.source } : {}),
      });
    }
    options.push({
      platform: spec.platform,
      ...(spec.service ? { service: spec.service } : {}),
      score,
      ...(eliminated ? { eliminated } : {}),
      hits,
      licence: licenceFor(item, spec, ctx, eliminated !== undefined),
    });
  }
  options.sort(compareOptions);
  const findings            = [];
  for (const r of active) if (r.findings) findings.push(...r.findings(item, ctx));
  if (!isDatabase(item)) findings.push(...ctx.placementOf(item).findings);
  return { options, findings, rules: active };
}

// ---------------------------------------------------------------------------
// decidePlan
// ---------------------------------------------------------------------------

function bestOn(options                   , platform          )                     {
  return options.find((o) => o.platform === platform && !o.eliminated);
}

function marginOf(options                   , chosen                    )         {
  if (!chosen) return 0;
  const alt = options.find((o) => !o.eliminated && o.platform !== chosen.platform);
  return alt ? chosen.score - alt.score : NO_ALTERNATIVE_MARGIN;
}

/** Group item findings by code: one plan finding per code, with a count when the messages differ. */
function summarise(itemFindings                    )            {
  const byCode = new Map                   ();
  for (const f of itemFindings) {
    const list = byCode.get(f.code) ?? [];
    list.push(f);
    byCode.set(f.code, list);
  }
  const out            = [];
  for (const list of byCode.values()) {
    const first = list[0] ;
    const distinct = new Set(list.map((f) => f.message)).size;
    if (distinct === 1) out.push(first);
    else {
      const { path: _path, ...rest } = first;
      out.push({ ...rest, message: `${first.message} (and ${distinct - 1} more like it)` });
    }
  }
  return out;
}

                            
                            
                                     
                                                      
 

/** Steps 1–3 for every item. */
export function evaluatePlan(plan      , options                = {})            {
  const rules = options.rules ?? RULES;
  const ctx = createContext(plan, options);
  const evals = new Map                        ();
  for (const d of plan.databases) evals.set(d.id, evaluateItem(d, ctx, rules));
  for (const w of plan.workloads) evals.set(w.id, evaluateItem(w, ctx, rules));
  return { ctx, rules, evals };
}

/** The whole decision for a plan. */
export function decidePlan(plan      , options                = {})               {
  const { ctx, evals } = evaluatePlan(plan, options);
  const findings            = [];

  // Step 4: units (a workload, or a database with its host VMs) and the subset.
  const units = buildUnits(plan, ctx, evals, findings);
  const subset = chooseSubset(units, ctx, findings);

  // Step 5: assignment inside the subset.
  const assignment             = assignUnits(units, subset.platforms);

  // Step 6: affinity.
  const affinityNotes = affinityPass(plan, units, assignment, subset.platforms);

  // Step 7: item decisions.
  const items                               = {};
  const unitOf = new Map              ();
  for (const u of units) for (const id of u.members) unitOf.set(id, u);
  const allItemFindings            = [];

  const finish = (d              )       => {
    items[d.id] = d;
    allItemFindings.push(...d.findings);
  };

  const reviewFindings = (item          , chosen                    )            => {
    const out            = [];
    for (const r of evals.get(item.id)?.rules ?? []) if (r.review) out.push(...r.review(item, chosen, ctx));
    return out;
  };

  const snappedOf = (u                  , platform                      )                          => {
    if (!u || !platform || !u.best || u.best === platform) return undefined;
    return { from: u.best, rule: assignment.affinity.has(u.key) ? 'estate.affinity' : 'estate.subset' };
  };

  // Databases first: their choice decides their hosts.
  const hostOverride = new Map                                                                ();
  for (const db of plan.databases) {
    const ev = evals.get(db.id) ;
    const u = unitOf.get(db.id);
    const platform = u ? assignment.platform.get(u.key) : undefined;
    const chosenService = u && platform ? u.choice.get(platform)?.service : undefined;
    const chosen = chosenService ? ev.options.find((o) => o.platform === platform && o.service === chosenService) : undefined;
    const route = ctx.dbRouteOf(db);
    const hosts = ctx.hostsOf(db);
    const liveHosts = hosts.filter((h) => ctx.placementOf(h).disposition !== 'retire');
    let disposition             ;
    let method        ;
    const itemFindings            = [...ev.findings];
    if (route) {
      disposition = route;
      method = 'none';
    } else if (hosts.length > 0 && liveHosts.length === 0) {
      disposition = 'retire';
      method = 'none';
    } else if (chosen && chosen.service && DB_SERVICES[chosen.service].managed) {
      disposition = 'replatform';
      method = 'managed-db';
    } else {
      const host = liveHosts[0];
      const hp = host ? ctx.placementOf(host) : undefined;
      disposition = hp && hp.method !== 'none' ? hp.disposition : 'rehost';
      method = hp && hp.method !== 'none' ? hp.method : 'rebuild';
    }
    if (chosen && u) {
      for (const h of u.hosts) hostOverride.set(h, { platform: chosen.platform, managed: DB_SERVICES[chosen.service ].managed, db });
    }
    if (!chosen && u && disposition !== 'retire' && disposition !== 'repurchase') {
      itemFindings.push(warning('plan.item.unplaced', `${db.name}: no service survives the rules on the chosen platforms.`, {
        path: `databases.${db.id}`,
        remediation: 'Open the what-if for this database to see what eliminated each option, or pin a service.',
      }));
    }
    itemFindings.push(...reviewFindings(db, chosen));
    finish({
      id: db.id,
      kind: 'database',
      disposition,
      method,
      options: ev.options,
      ...(chosen ? { chosen } : {}),
      pinned: !!db.pinService || (u?.pin !== undefined && u.pinSource === 'retain'),
      ...(snappedOf(u, chosen?.platform) ? { snapped: snappedOf(u, chosen?.platform)  } : {}),
      margin: marginOf(ev.options, chosen),
      findings: itemFindings,
    });
  }

  for (const w of plan.workloads) {
    const ev = evals.get(w.id) ;
    const u = unitOf.get(w.id);
    const placement = ctx.placementOf(w);
    let { disposition, method } = placement;
    let options = ev.options;
    const itemFindings            = [...ev.findings];
    let chosen                    ;
    const coupled = hostOverride.get(w.id);
    if (coupled) {
      if (coupled.managed) {
        if (!placement.explicit) {
          disposition = 'replatform';
          method = 'managed-db';
        }
        chosen = bestOn(options, coupled.platform);
      } else {
        options = hostsFollow(options, coupled.platform, coupled.db);
        chosen = options.find((o) => o.platform === coupled.platform && !o.eliminated);
      }
    } else if (u) {
      const platform = assignment.platform.get(u.key);
      chosen = platform ? options.find((o) => o.platform === platform) : undefined;
      if (chosen?.eliminated && !u.pin) chosen = undefined;
    }
    if (!chosen && u && disposition !== 'retire' && disposition !== 'repurchase' && method !== 'managed-db') {
      itemFindings.push(warning('plan.item.unplaced', `${w.name}: no platform survives the rules within the chosen set.`, {
        path: `workloads.${w.id}`,
        remediation: 'Open the what-if for this workload to see what eliminated each platform, or pin one.',
      }));
    }
    const note = affinityNotes.get(u?.key ?? '');
    if (note && chosen) itemFindings.push(info('plan.affinity', `${w.name}: ${note}`, { path: `workloads.${w.id}` }));
    if (chosen && marginOf(options, chosen) < CLOSE_MARGIN) {
      itemFindings.push(info('plan.item.close', `${w.name}: ${chosen.platform} leads the next platform by under ${CLOSE_MARGIN} points; a close call.`, {
        path: `workloads.${w.id}`,
      }));
    }
    itemFindings.push(...reviewFindings(w, chosen));
    const snapped = snappedOf(u, chosen?.platform);
    finish({
      id: w.id,
      kind: 'workload',
      disposition,
      method,
      options,
      ...(chosen ? { chosen } : {}),
      pinned: !!w.pin || (u?.pinSource === 'retain'),
      ...(snapped && !coupled ? { snapped } : {}),
      margin: marginOf(options, chosen),
      findings: itemFindings,
    });
  }

  // Plan findings: the estate's own, then one per item finding code.
  const planFindings = [...findings, ...summarise(allItemFindings.filter((f) => f.code !== 'plan.item.close'))];
  const closeCount = allItemFindings.filter((f) => f.code === 'plan.item.close').length;
  if (closeCount > 0) {
    planFindings.push(info('plan.items.close', `${closeCount} item(s) lead their next platform by under ${CLOSE_MARGIN} points.`, {
      remediation: 'Those are the ones to settle on price or preference; pin them if the answer is already known.',
    }));
  }
  const placed = Object.values(items).filter((d) => d.chosen).length;
  const wanted = units.length;
  if (subset.platforms.length === 0 || (wanted > 0 && placed === 0)) {
    if (!planFindings.some((f) => f.code === 'multicloud.no-platform')) {
      planFindings.push(warning('multicloud.no-platform', 'Every platform was ruled out, so the constraints as stated cannot all be met.', {
        remediation: 'Relax one of them, or accept that the workload does not move.',
      }));
    }
  }

  return {
    engineVersion: ENGINE_VERSION,
    platforms: subset.platforms,
    subsetScores: subset.scores,
    items,
    findings: planFindings,
  };
}

export { HOSTS_FOLLOW };
