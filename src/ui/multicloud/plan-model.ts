/**
 * The decided and designed plan, as the Migrate panes read it.
 *
 * The decision honours every app's chosen platform (`decideApps`), and the
 * design runs the pattern designers, as the capacity and app-stack engines
 * do, so every pane shows the same placements. Both are worked out once per
 * plan object: the session hands out a new object on every change, so the
 * cache never goes stale.
 */

import { decideApps } from '../../multicloud/plan/apps/recommend.ts';
import { withoutServiceSynthetics } from '../../multicloud/plan/apps/components.ts';
import { plannedApps } from '../../multicloud/plan/apps/generate.ts';
import { designPlan, designPlatform } from '../../multicloud/plan/design/index.ts';
import { withPatternMappers } from '../../multicloud/plan/patterns/index.ts';
import type { Finding } from '../../core/findings.ts';
import type { Plan, PlanDecision, Platform, PlatformDesign, TargetDesign } from '../../multicloud/plan/types.ts';

export interface PlanModel {
  readonly decision: PlanDecision;
  readonly design: TargetDesign;
  /** Set when the engines threw: the panes show it instead of their content. */
  readonly failure?: string;
}

const cache = new WeakMap<Plan, PlanModel>();

const EMPTY_DECISION: PlanDecision = { engineVersion: '', platforms: [], subsetScores: [], items: {}, findings: [] };

/** The plan's decision and target design. */
export function planModel(plan: Plan): PlanModel {
  const hit = cache.get(plan);
  if (hit) return hit;
  let model: PlanModel;
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

const single = new WeakMap<Plan, Map<Platform, { design: PlatformDesign; findings: Finding[] } | null>>();

/**
 * One platform's design, whether or not the decision places anything there:
 * the plan's own design when the platform is in it, else the landing zone
 * alone (no workloads), so a landing zone can be designed for a cloud before
 * any application lands on it. Null when the engines threw.
 */
export function platformDesignFor(plan: Plan, platform: Platform): { design: PlatformDesign; findings: Finding[]; inPlan: boolean } | null {
  const model = planModel(plan);
  const inPlan = model.design.platforms.find((d) => d.platform === platform);
  if (inPlan) return { design: inPlan, findings: [], inPlan: true };
  if (model.failure) return null;
  const perPlan = single.get(plan) ?? new Map();
  single.set(plan, perPlan);
  if (!perPlan.has(platform)) {
    try {
      perPlan.set(platform, designPlatform(plan, model.decision, platform, withPatternMappers()));
    } catch {
      perPlan.set(platform, null);
    }
  }
  const hit = perPlan.get(platform);
  return hit ? { ...hit, inPlan: false } : null;
}

/** Every finding the decision and design raised, errors first. */
export function modelFindings(model: PlanModel): Finding[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...model.decision.findings, ...model.design.findings].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
}

/**
 * The apps the migration takes: those whose application plan is planned or
 * approved (addendum A.2.5), or every app while none is — a plan still being
 * drawn up is shown whole rather than empty.
 */
export function migrationApps(plan: Plan): { readonly ids: string[]; readonly planned: boolean } {
  const planned = plannedApps(plan);
  if (planned.length > 0) return { ids: planned, planned: true };
  return { ids: plan.apps.map((a) => a.id), planned: false };
}
