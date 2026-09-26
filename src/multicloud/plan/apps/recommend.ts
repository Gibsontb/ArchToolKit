/**
 * Recommendation, switching and saving per application (addendum A.2.3, A.2.5).
 *
 * There is no second engine. One `decidePlan(plan, { extraRules })` (WP-3,
 * with the pattern rules of WP-16 as the extra rules) scores every item on
 * every platform and service; the per-app view is read from that output:
 *
 *   score(p)   Σ over the app's items of the best non-eliminated option on p;
 *              an item with no option on p makes p ineligible for the app,
 *              and the eliminating rules are named;
 *   recommended the highest-scoring eligible platform of `requirements.allowed`;
 *   margin     its lead over the runner-up; "too close to call" is the base
 *              design's 2 points per item, scaled to the item count;
 *   reasons    the rule hits summed by rule id across the app's items, the
 *              top five by |Σ delta| per platform.
 *
 * Choosing a platform writes `AppPlan.platform` (through `switchPlatform`,
 * so the variant for it is selected or translated, never lost); the pattern
 * rule `app.chosen-platform` then eliminates the other platforms for every
 * item of the app on the next decision. A recommendation is read from a
 * decision made without the app's own choice (`recommendationDecision`),
 * otherwise the choice would recommend itself.
 */

import { info, type Finding } from '../../../core/findings.ts';
import { CLOSE_MARGIN, decidePlan, ENGINE_VERSION, type AnyRule, type EngineOptions } from '../decide/index.ts';
import { PLATFORM_LABELS, PLATFORM_VALUES } from '../options.ts';
import { PATTERN_CATALOG, PATTERN_RULES, rankTierPatterns, type RankedTierPattern } from '../patterns/index.ts';
import type { AppPlan, AppRecommendation, ItemDecision, Option, Plan, PlanDecision, Platform, RuleHit, TierPattern } from '../types.ts';
import { appDatabases, appPlanOf, appWorkloads, defaultAppPlan, ensureVariant, findApp, regionsOf, templateFor, withAppPlan } from './components.ts';
import { switchPlatform } from './translate.ts';

/** How many summed rule hits a platform's reasons show. */
export const TOP_REASONS = 5;

/** The engine options every app view uses: the registry plus the pattern rules. */
export function appEngineOptions(extra: EngineOptions = {}): EngineOptions {
  const extraRules: readonly AnyRule[] = [...PATTERN_RULES, ...(extra.extraRules ?? [])];
  return { ...extra, extraRules };
}

/** `decidePlan` with the pattern rules: the decision every app view reads. */
export function decideApps(plan: Plan, options: EngineOptions = {}): PlanDecision {
  return decidePlan(plan, appEngineOptions(options));
}

/** The plan with the chosen platform of these apps (default: every app) cleared: what a recommendation is read from. */
export function withoutChoices(plan: Plan, appIds?: readonly string[]): Plan {
  const ids = appIds ? new Set(appIds.map((r) => findApp(plan, r)?.id ?? r)) : null;
  if (!(plan.appPlans ?? []).some((p) => p.platform && (!ids || ids.has(p.app)))) return plan;
  return {
    ...plan,
    appPlans: (plan.appPlans ?? []).map((p) => {
      if (!p.platform || (ids && !ids.has(p.app))) return p;
      const { platform: _chosen, ...rest } = p;
      return rest;
    }),
  };
}

/** The decision a recommendation is read from: the apps' own choices left out. */
export function recommendationDecision(plan: Plan, options: EngineOptions = {}, appIds?: readonly string[]): PlanDecision {
  return decideApps(withoutChoices(plan, appIds), options);
}

/** The app's items that take part in placement (not retired, retained or repurchased). */
export function appItemDecisions(plan: Plan, decision: PlanDecision, appRef: string): ItemDecision[] {
  const app = findApp(plan, appRef);
  if (!app) return [];
  const ids = [...appWorkloads(plan, app).map((w) => w.id), ...appDatabases(plan, app).map((d) => d.id)];
  return ids.map((id) => decision.items[id]).filter((d): d is ItemDecision => !!d && d.method !== 'none');
}

/** The best surviving option of an item on a platform. */
export const bestOn = (d: ItemDecision, p: Platform): Option | undefined => d.options.find((o) => o.platform === p && !o.eliminated);

/** The rule ids that eliminated every option of an item on a platform. */
export function eliminatorsOn(d: ItemDecision, p: Platform): string[] {
  const out = new Set<string>();
  for (const o of d.options) if (o.platform === p && o.eliminated) out.add(o.eliminated);
  if (out.size === 0) out.add('no-option');
  return [...out];
}

function sumHits(options: readonly Option[]): RuleHit[] {
  const by = new Map<string, RuleHit>();
  for (const o of options) {
    for (const h of o.hits) {
      const seen = by.get(h.rule);
      by.set(h.rule, seen ? { ...seen, delta: seen.delta + h.delta } : { ...h });
    }
  }
  return [...by.values()]
    .filter((h) => h.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.rule.localeCompare(b.rule));
}

/** The "too close to call" threshold for an app of `items` items. */
export const closeThreshold = (items: number): number => CLOSE_MARGIN * Math.max(1, items);

/**
 * The app's recommendation from a decision. Pass a decision made without the
 * app's own choice (`recommendationDecision`) for the catalogue's
 * Recommended column; with the choice, the other platforms show as
 * eliminated by `app.chosen-platform`.
 */
export function recommendApp(plan: Plan, decision: PlanDecision, appId: string): AppRecommendation {
  const app = findApp(plan, appId);
  const items = app ? appItemDecisions(plan, decision, app.id) : [];
  const allowed = PLATFORM_VALUES.filter((p) => plan.requirements.allowed.includes(p));
  const perPlatform = allowed.map((platform) => {
    let score = 0;
    const eliminatedBy = new Set<string>();
    const best: Option[] = [];
    for (const d of items) {
      const o = bestOn(d, platform);
      if (!o) {
        for (const r of eliminatorsOn(d, platform)) eliminatedBy.add(r);
        continue;
      }
      score += o.score;
      best.push(o);
    }
    return {
      platform,
      eligible: eliminatedBy.size === 0,
      score,
      eliminatedBy: [...eliminatedBy].sort(),
      topHits: sumHits(best).slice(0, TOP_REASONS),
    };
  });
  const eligible = perPlatform.filter((x) => x.eligible).sort((a, b) => b.score - a.score || PLATFORM_VALUES.indexOf(a.platform) - PLATFORM_VALUES.indexOf(b.platform));
  const first = items.length > 0 ? eligible[0] : undefined;
  const second = eligible[1];
  const margin = first ? (second ? first.score - second.score : Infinity) : 0;
  return {
    app: app?.id ?? appId,
    perPlatform,
    ...(first ? { recommended: first.platform } : {}),
    margin: Number.isFinite(margin) ? margin : 99,
    tooClose: !first || (second !== undefined && margin < closeThreshold(items.length)),
  };
}

/** Every app's recommendation, from one decision. */
export function recommendApps(plan: Plan, decision: PlanDecision): Record<string, AppRecommendation> {
  return Object.fromEntries(plan.apps.map((a) => [a.id, recommendApp(plan, decision, a.id)]));
}

/** The platform an app lands on: its choice, else its recommendation. */
export function appPlatform(plan: Plan, appId: string, recommendation?: AppRecommendation): Platform | undefined {
  const ap = appPlanOf(plan, appId);
  return ap?.platform ?? recommendation?.recommended ?? ap?.recommendation?.platform;
}

// ---------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------

export interface ChooseResult {
  readonly plan: Plan;
  readonly appPlan: AppPlan;
  /** True when the platform's variant was created now (translated or derived). */
  readonly created: boolean;
  readonly findings: readonly Finding[];
  /** The decisions-log line (RAID, source `platform-switch`) for the caller to record. */
  readonly logEntry: string;
}

/**
 * Choose a platform for an app ("Choose this cloud"): writes
 * `AppPlan.platform`, selecting the platform's variant unchanged when it
 * exists, else translating the current one (or deriving it from the servers).
 * The next `decideApps` eliminates the other platforms for the app's items.
 */
export function chooseAppPlatform(plan: Plan, appId: string, platform: Platform): ChooseResult {
  const app = findApp(plan, appId);
  if (!app) {
    const ap = { app: appId, origin: 'migrate', status: 'draft', variants: {}, answers: {}, landingZone: 'included' } as AppPlan;
    return { plan, appPlan: ap, created: false, findings: [info('apps.unknown', `There is no application ${appId}.`)], logEntry: '' };
  }
  const current = appPlanOf(plan, app.id) ?? defaultAppPlan(app);
  const from = current.platform;
  let working = withAppPlan(plan, current);
  let ap = current;
  let created = false;
  const findings: Finding[] = [];
  if (!PLATFORM_VALUES.some((p) => current.variants[p])) {
    // Nothing to translate from: derive the components for the platform first.
    const e = ensureVariant(working, app.id, platform);
    working = e.plan;
    ap = e.appPlan;
    created = e.created;
    findings.push(...e.findings);
  }
  const s = switchPlatform(ap, platform, { regions: regionsOf(plan) });
  created = created || s.created;
  findings.push(...s.findings);
  if (!plan.requirements.allowed.includes(platform)) {
    findings.push(info('apps.platform-not-allowed', `${PLATFORM_LABELS[platform]} is not among the allowed platforms, so every item of ${app.name} will be unplaced until it is allowed.`, { path: 'requirements.allowed' }));
  }
  const next = withAppPlan(working, s.plan);
  const logEntry = `${app.name}: placed on ${PLATFORM_LABELS[platform]} by choice${from && from !== platform ? ` (was ${PLATFORM_LABELS[from]})` : ''}.`;
  return { plan: next, appPlan: s.plan, created, findings, logEntry };
}

/** Clear an app's choice: it follows the recommendation again. Its variants are kept. */
export function clearAppPlatform(plan: Plan, appId: string): Plan {
  const ap = appPlanOf(plan, appId);
  if (!ap?.platform) return plan;
  const { platform: _p, ...rest } = ap;
  return withAppPlan(plan, rest);
}

/**
 * Set a component's tier pattern on a platform's variant (blank = the
 * pattern's default). The pattern rule `app.tier-pattern` restricts the
 * component's items to that tier pattern's services on the next decision.
 */
export function setTierPattern(plan: Plan, appId: string, componentId: string, tierPattern: TierPattern | undefined, platform?: Platform): Plan {
  const ap = appPlanOf(plan, appId);
  if (!ap) return plan;
  const targets = platform ? [platform] : PLATFORM_VALUES.filter((p) => ap.variants[p]);
  const variants = { ...ap.variants };
  for (const p of targets) {
    const list = variants[p];
    if (!list) continue;
    variants[p] = list.map((c) => {
      if (c.id !== componentId || c.kind !== 'pattern') return c;
      const { tierPattern: _t, ...rest } = c;
      return tierPattern ? { ...rest, tierPattern } : rest;
    });
  }
  return withAppPlan(plan, { ...ap, variants });
}

/**
 * "Add from patterns": the tier patterns offered for a component on a
 * platform, ranked by the app pattern's preferences (WP-16).
 */
export function rankComponentPatterns(plan: Plan, appId: string, componentId: string, platform: Platform): RankedTierPattern[] {
  const app = findApp(plan, appId);
  const ap = app ? appPlanOf(plan, app.id) : undefined;
  const c = ap ? PLATFORM_VALUES.flatMap((p) => ap.variants[p] ?? []).find((x) => x.id === componentId) : undefined;
  if (!app || !ap || !c || c.kind !== 'pattern') return [];
  const pattern = app.pattern ?? 'generic';
  const template = templateFor(pattern, c.tier, c.workloadType)
    ?? PATTERN_CATALOG[pattern].components[0]
    ?? PATTERN_CATALOG.generic.components[0]!;
  return rankTierPatterns(pattern, template, platform, ap.answers);
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * "Save application plans": status `planned` (an `approved` plan stays
 * approved), `savedAt`, and the recommendation cached with the engine version,
 * so a later engine change shows as "recommendation changed since saved".
 * `savedAt` is passed in: nothing here reads the clock.
 */
export function saveAppPlans(plan: Plan, appIds: readonly string[], recommendations: Readonly<Record<string, AppRecommendation>>, savedAt: string): Plan {
  let out = plan;
  for (const ref of appIds) {
    const app = findApp(out, ref);
    if (!app) continue;
    const ap = appPlanOf(out, app.id) ?? defaultAppPlan(app);
    const rec = recommendations[app.id];
    const score = rec?.recommended ? rec.perPlatform.find((x) => x.platform === rec.recommended)?.score ?? 0 : 0;
    out = withAppPlan(out, {
      ...ap,
      status: ap.status === 'approved' ? 'approved' : 'planned',
      savedAt,
      ...(rec?.recommended ? { recommendation: { platform: rec.recommended, score, engineVersion: ENGINE_VERSION } } : {}),
    });
  }
  return out;
}

/** True when the saved recommendation differs from the current one (platform or engine version). */
export function recommendationChanged(ap: AppPlan, current: AppRecommendation): boolean {
  if (!ap.recommendation) return false;
  return ap.recommendation.engineVersion !== ENGINE_VERSION || ap.recommendation.platform !== current.recommended;
}
