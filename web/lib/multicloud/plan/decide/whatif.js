/**
 * What if: one item's every option in full, and the estate re-decided under a
 * changed requirement, as a diff with the reasons and the licence delta.
 */

                                                   
             
                                                                                                           
                     
import { createContext, decidePlan, evaluateItem,                    } from './engine.js';

/** Every option of one item, best first, with hits and licence. Empty when the id is unknown. */
export function whatIfItem(plan      , id        , options                = {})                    {
  const item = plan.workloads.find((w) => w.id === id) ?? plan.databases.find((d) => d.id === id);
  if (!item) return [];
  return evaluateItem(item, createContext(plan, options), options.rules).options;
}

                             
                      
                         
                       
                                                                                                          
                                   
 

                               
                                
                               
                                        
                                                                                  
                                       
 

/** Licence counts of every chosen option, per platform and kind. */
export function licenceTotals(decision              )                {
  const out                                                                  = {};
  for (const d of Object.values(decision.items)) {
    const l = d.chosen?.licence;
    if (!d.chosen || !l || l.kind === 'none' || l.count === 0) continue;
    const row = (out[d.chosen.platform] ??= {});
    row[l.kind] = (row[l.kind] ?? 0) + l.count;
  }
  return out;
}

function diffTotals(before               , after               )                {
  const out                                                                  = {};
  const platforms = new Set([...Object.keys(before), ...Object.keys(after)]              );
  for (const p of platforms) {
    const kinds = new Set([...Object.keys(before[p] ?? {}), ...Object.keys(after[p] ?? {})]                 );
    for (const k of kinds) {
      const d = (after[p]?.[k] ?? 0) - (before[p]?.[k] ?? 0);
      if (d === 0) continue;
      (out[p] ??= {})[k] = d;
    }
  }
  return out;
}

const same = (a                    , b                    )          =>
  a?.platform === b?.platform && a?.service === b?.service;

const matching = (d                          , o                    )                     =>
  o ? d?.options.find((x) => x.platform === o.platform && x.service === o.service) : undefined;

const hitKey = (h         )         => `${h.rule}\u0000${h.delta}`;

function why(before              , after              )            {
  const out            = [];
  const from = before.chosen;
  const to = after.chosen;
  const fromNow = matching(after, from);
  if (from) {
    const still = new Set((fromNow?.hits ?? []).map(hitKey));
    for (const h of from.hits) {
      if (!still.has(hitKey(h)) && h.delta !== 0) out.push({ ...h, delta: -h.delta, reason: `No longer applies: ${h.reason}` });
    }
    if (fromNow?.eliminated) {
      const e = fromNow.hits.find((h) => h.rule === fromNow.eliminated);
      if (e) out.push(e);
    }
  }
  if (to) {
    const had = new Set((matching(before, to)?.hits ?? []).map(hitKey));
    for (const h of to.hits) if (!had.has(hitKey(h)) && h.delta !== 0) out.push(h);
  }
  if (out.length === 0 && after.snapped) {
    out.push({ rule: after.snapped.rule, delta: 0, reason: 'The platform set changed, and this item moved with it.', verification: 'I' });
  }
  return out;
}

/** Re-decide with `patch` applied to the requirements, and diff. */
export function whatIfEstate(plan      , patch                   , options                = {})               {
  const before = decidePlan(plan, options);
  const after = decidePlan({ ...plan, requirements: { ...plan.requirements, ...patch } }, options);
  const moves               = [];
  for (const id of Object.keys(after.items)) {
    const b = before.items[id];
    const a = after.items[id];
    if (!b || !a || same(b.chosen, a.chosen)) continue;
    moves.push({ id, ...(b.chosen ? { from: b.chosen } : {}), ...(a.chosen ? { to: a.chosen } : {}), why: why(b, a) });
  }
  return { before, after, moves, licenceDelta: diffTotals(licenceTotals(before), licenceTotals(after)) };
}
