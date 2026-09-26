/**
 * The estate check (addendum A.2.3): with apps placed by choice, the base
 * design's subset optimisation becomes a check, not an override. It can only
 * confirm the choices or report what they cost:
 *
 *   estate.platforms-exceed-max    the chosen platforms outnumber `maxPlatforms`;
 *   estate.sync-crosses-platforms  a sync edge joins apps on different platforms;
 *   estate.subset-prefers          the unconstrained optimum would place a chosen
 *                                  app elsewhere, with the reason.
 *
 * These show on `#overview` and as findings on the app.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { dependencyEdges } from '../decide/index.ts';
import type { EngineOptions } from '../decide/index.ts';
import { PLATFORM_LABELS } from '../options.ts';
import type { AppRecommendation, Plan, PlanDecision, Platform } from '../types.ts';
import { findApp } from '../apps/components.ts';
import { recommendApp, recommendationDecision } from '../apps/recommend.ts';

export interface EstateCheck {
  /** App name → the platform it lands on (its choice, else the platform most of its items were placed on). */
  readonly placement: Readonly<Record<string, Platform>>;
  readonly chosenPlatforms: readonly Platform[];
  readonly findings: readonly Finding[];
}

export interface EstateCheckOptions {
  /** The unconstrained decision (the apps' choices left out); made when absent. */
  readonly unconstrained?: PlanDecision;
  readonly engine?: EngineOptions;
}

/** The platform an app's items mostly landed on in a decision. */
function decidedPlatform(plan: Plan, decision: PlanDecision, appName: string): Platform | undefined {
  const counts = new Map<Platform, number>();
  for (const w of plan.workloads.filter((x) => x.app === appName)) {
    const p = decision.items[w.id]?.chosen?.platform;
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  for (const d of plan.databases.filter((x) => x.app === appName)) {
    const p = decision.items[d.id]?.chosen?.platform;
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function estateCheck(plan: Plan, decision: PlanDecision, options: EstateCheckOptions = {}): EstateCheck {
  const findings: Finding[] = [];
  const plans = new Map((plan.appPlans ?? []).map((p) => [p.app, p]));
  const placement: Record<string, Platform> = {};
  for (const a of plan.apps) {
    const p = plans.get(a.id)?.platform ?? decidedPlatform(plan, decision, a.name);
    if (p) placement[a.name] = p;
  }
  const chosenPlatforms = [...new Set(plan.apps.map((a) => plans.get(a.id)?.platform).filter((p): p is Platform => !!p))];
  if (chosenPlatforms.length > plan.requirements.maxPlatforms) {
    findings.push(warning('estate.platforms-exceed-max', `The apps are placed by choice on ${chosenPlatforms.length} platforms (${chosenPlatforms.map((p) => PLATFORM_LABELS[p]).join(', ')}), more than the ${plan.requirements.maxPlatforms} allowed.`, {
      path: 'requirements.maxPlatforms',
      remediation: 'Move an app to a platform already in use, or raise the maximum number of platforms.',
    }));
  }

  // Sync edges between apps on different platforms.
  const appOfItem = new Map<string, string>();
  for (const w of plan.workloads) appOfItem.set(w.name, w.app);
  for (const d of plan.databases) appOfItem.set(d.name, d.app);
  for (const a of plan.apps) appOfItem.set(a.name, a.name);
  const seen = new Set<string>();
  for (const e of dependencyEdges(plan)) {
    if (e.kind !== 'sync' || e.to.startsWith('site:')) continue;
    const from = appOfItem.get(e.from);
    const to = appOfItem.get(e.to);
    if (!from || !to || from === to) continue;
    const pf = placement[from];
    const pt = placement[to];
    if (!pf || !pt || pf === pt) continue;
    const key = [from, to].sort().join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(warning('estate.sync-crosses-platforms', `${from} (${PLATFORM_LABELS[pf]}) calls ${to} (${PLATFORM_LABELS[pt]}) synchronously across platforms: every call pays the inter-cloud latency and egress.`, {
      path: `apps.${findApp(plan, from)?.id ?? from}`,
      remediation: 'Place both apps on one platform, make the call asynchronous, or accept the latency (and check it against the app\'s latency needs).',
    }));
  }

  // The unconstrained optimum, for apps placed by choice.
  const chosenApps = plan.apps.filter((a) => plans.get(a.id)?.platform);
  if (chosenApps.length > 0) {
    const free = options.unconstrained ?? recommendationDecision(plan, options.engine);
    for (const a of chosenApps) {
      const chosen = plans.get(a.id)!.platform!;
      const rec: AppRecommendation = recommendApp(plan, free, a.id);
      if (!rec.recommended || rec.recommended === chosen) continue;
      const best = rec.perPlatform.find((x) => x.platform === rec.recommended)!;
      const mine = rec.perPlatform.find((x) => x.platform === chosen);
      const why = best.topHits.slice(0, 2).map((h) => h.reason).join(' ');
      findings.push(info('estate.subset-prefers', `${a.name}: left unconstrained, the engine would place it on ${PLATFORM_LABELS[rec.recommended]} (${best.score} points against ${mine ? `${mine.score} on ${PLATFORM_LABELS[chosen]}` : `${PLATFORM_LABELS[chosen]}, which is not eligible`}).${why ? ` ${why}` : ''}`, {
        path: `appPlans.${a.id}.platform`,
        remediation: 'Keep the choice if it is deliberate (it is recorded in the decisions log), or follow the recommendation.',
      }));
    }
  }
  return { placement, chosenPlatforms, findings };
}
