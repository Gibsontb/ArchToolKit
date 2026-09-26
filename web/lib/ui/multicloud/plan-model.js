/**
 * The decided and designed plan, as the Migrate panes read it.
 *
 * The decision honours every app's chosen platform (`decideApps`), and the
 * design runs the pattern designers, as the capacity and app-stack engines
 * do, so every pane shows the same placements. Both are worked out once per
 * plan object: the session hands out a new object on every change, so the
 * cache never goes stale.
 */

import { decideApps } from '../../multicloud/plan/apps/recommend.js';
import { withoutServiceSynthetics } from '../../multicloud/plan/apps/components.js';
import { plannedApps } from '../../multicloud/plan/apps/generate.js';
import { designPlan } from '../../multicloud/plan/design/index.js';
import { withPatternMappers } from '../../multicloud/plan/patterns/index.js';
                                                      
                                                                                       

                            
                                  
                                
                                                                                
                            
 

const cache = new WeakMap                 ();

const EMPTY_DECISION               = { engineVersion: '', platforms: [], subsetScores: [], items: {}, findings: [] };

/** The plan's decision and target design. */
export function planModel(plan      )            {
  const hit = cache.get(plan);
  if (hit) return hit;
  let model           ;
  try {
    const decision = decideApps(plan);
    const design = withoutServiceSynthetics(plan, designPlan(plan, decision, withPatternMappers()));
    model = { decision, design };
  } catch (e) {
    model = { decision: EMPTY_DECISION, design: { platforms: [], findings: [] }, failure: e instanceof Error ? e.message : String(e) };
  }
  cache.set(plan, model);
  return model;
}

/** Every finding the decision and design raised, errors first. */
export function modelFindings(model           )            {
  const rank = { error: 0, warning: 1, info: 2 }         ;
  return [...model.decision.findings, ...model.design.findings].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
}

/**
 * The apps the migration takes: those whose application plan is planned or
 * approved (addendum A.2.5), or every app while none is — a plan still being
 * drawn up is shown whole rather than empty.
 */
export function migrationApps(plan      )                                                        {
  const planned = plannedApps(plan);
  if (planned.length > 0) return { ids: planned, planned: true };
  return { ids: plan.apps.map((a) => a.id), planned: false };
}
