/**
 * An application's design in the decision wizard (`AppPlan.design`), on the
 * plan: which cloud it is designed for, and the answers the user gave.
 *
 *  - The answers shown are the plan's (`answersFromApp`, read fresh each time
 *    so they follow the plan) overlaid with the user's own. The user's are the
 *    only ones stored, so a prefill never overwrites what the user changed.
 *  - The cloud IS the app's chosen platform: switching it calls
 *    `chooseAppPlatform` (the variant there is kept, or translated), stores
 *    it on the design, and re-applies the answers to that cloud's components.
 *  - Every answer change re-applies the answers (`applyWizard`), so the
 *    components, and what `generateAppStack` builds, follow the wizard.
 *
 * Pure: every function returns a new plan; the page stores it with
 * `ctx.session.update`, so it persists and syncs like the rest of the plan.
 */

import type { Finding } from '../../../core/findings.ts';
import { answersFromApp } from '../../estate-answers.ts';
import { PLATFORM_VALUES } from '../options.ts';
import type { App, AppDesign, AppPlan, Disposition, Plan, Platform } from '../types.ts';
import { appPlanOf, defaultAppPlan, findApp, withAppPlan } from './components.ts';
import { appPeers, placedOn } from './connectors.ts';
import { chooseAppPlatform } from './recommend.ts';
import { applyWizard, type Answers } from './wizard-map.ts';

/** The stored design, cleaned: a known cloud, and answers that are text or lists of text. */
export function designOf(ap: AppPlan | undefined): AppDesign | undefined {
  const d = ap?.design;
  if (!d || typeof d !== 'object') return undefined;
  const cloud = (PLATFORM_VALUES as readonly string[]).includes(d.cloud as string) ? d.cloud : undefined;
  const answers: Record<string, string | readonly string[]> = {};
  for (const [k, v] of Object.entries(d.answers ?? {})) {
    if (typeof v === 'string') answers[k] = v;
    else if (Array.isArray(v)) answers[k] = v.filter((x): x is string => typeof x === 'string');
  }
  return cloud ? { cloud, answers } : { cloud: ap?.platform ?? 'aws', answers };
}

export interface DesignAnswers {
  /** What the wizard shows: the plan's answers, then the user's over them. */
  readonly answers: Record<string, string | readonly string[]>;
  /** The ids whose answer is the plan's (not overridden by the user). */
  readonly prefilled: ReadonlySet<string>;
  /** The user's own answers. */
  readonly user: Readonly<Record<string, string | readonly string[]>>;
  /** Id → the plan fact a prefilled answer came from. */
  readonly why: Readonly<Record<string, string>>;
}

export function designAnswers(plan: Plan, appId: string): DesignAnswers {
  const app = findApp(plan, appId);
  if (!app) return { answers: {}, prefilled: new Set(), user: {}, why: {} };
  const fromPlan = answersFromApp(plan, app.id);
  const user = designOf(appPlanOf(plan, app.id))?.answers ?? {};
  const answers: Record<string, string | readonly string[]> = { ...fromPlan.answers, ...user };
  const prefilled = new Set(Object.keys(fromPlan.answers).filter((k) => !(k in user)));
  return { answers, prefilled, user, why: fromPlan.why };
}

/** The cloud the app is designed for: its chosen platform (the design sets it), else the design's, else the fallback (its recommendation). */
export function designCloud(plan: Plan, appId: string, fallback: Platform): Platform {
  const ap = appPlanOf(plan, appId);
  // The chosen platform and the design's cloud are one decision; the chosen platform wins if they ever differ.
  return ap?.platform ?? designOf(ap)?.cloud ?? fallback;
}

function withDesign(plan: Plan, appId: string, change: (d: AppDesign, ap: AppPlan) => AppDesign): Plan {
  const app = findApp(plan, appId);
  if (!app) return plan;
  const ap = appPlanOf(plan, app.id) ?? defaultAppPlan(app);
  const d = designOf(ap) ?? { cloud: ap.platform ?? plan.requirements.allowed[0] ?? 'aws', answers: {} };
  return withAppPlan(plan, { ...ap, design: change(d, ap) });
}

export interface DesignEdit {
  readonly plan: Plan;
  readonly notes: readonly Finding[];
}

/**
 * Store one answer the user gave, then re-apply the answers to the app's
 * components on its cloud. An empty value is stored too (the user cleared
 * it), so the plan's answer does not come back over it.
 */
export function setDesignAnswer(plan: Plan, appId: string, id: string, value: string | readonly string[], cloud: Platform): DesignEdit {
  let stored = withDesign(plan, appId, (d) => ({ cloud: d.cloud ?? cloud, answers: { ...d.answers, [id]: Array.isArray(value) ? [...value] : String(value) } }));
  if (id === 'migrationApproach') stored = withRoute(stored, appId, String(Array.isArray(value) ? value[0] ?? '' : value));
  const placed = appPlanOf(stored, appId)?.platform === cloud ? stored : chooseAppPlatform(allowPlatform(stored, cloud), appId, cloud).plan;
  const r = applyWizard(placed, appId, cloud, designAnswers(placed, appId).answers as Answers);
  return { plan: assignLandingZones(refreshPeers(r.plan, appId)), notes: r.notes };
}

/**
 * Re-apply the designs of the apps connected to this one: their connectors
 * depend on where this app is, so moving it (or re-answering) changes their
 * cross-cloud connectors too.
 */
export function refreshPeers(plan: Plan, appId: string): Plan {
  let out = plan;
  for (const peer of appPeers(plan, appId)) {
    const app = findApp(out, peer.app);
    const ap = app ? appPlanOf(out, app.id) : undefined;
    const d = designOf(ap);
    if (!app || !ap?.design || !d) continue;
    out = applyWizard(out, app.id, d.cloud, designAnswers(out, app.id).answers as Answers).plan;
  }
  return out;
}

const ROUTES: readonly Disposition[] = ['rehost', 'relocate', 'replatform', 'refactor', 'repurchase', 'retire', 'retain'];

/**
 * The wizard's strategy (the R) is the app's route: the decision engine places
 * the app's workloads by it (`disposition.ts`), which decides the method, and
 * the execution kit's path per server follows from the method.
 */
export function withRoute(plan: Plan, appId: string, route: string): Plan {
  const app = findApp(plan, appId);
  if (!app || app.route === 'new') return plan;
  const r = (ROUTES as readonly string[]).includes(route) ? (route as Disposition) : undefined;
  const apps = plan.apps.map((a): App => {
    if (a.id !== app.id) return a;
    const { route: _r, ...rest } = a;
    const edited = [...new Set([...(a.edited ?? []), 'route' as const])] as App['edited'];
    return r ? { ...rest, route: r, edited } : { ...rest, edited };
  });
  const ap = appPlanOf(plan, app.id);
  const next = { ...plan, apps };
  if (!ap) return next;
  const { route: _ar, ...apRest } = ap;
  return withAppPlan(next, r ? { ...apRest, route: r } : apRest);
}

/** Who builds a cloud's landing zone: the landing-zone project (designed on Migration & Utilities), or the first app placed on it. */
export function landingZoneBuilder(plan: Plan, p: Platform): { readonly kind: 'project' } | { readonly kind: 'app'; readonly app: App } | undefined {
  if (plan.execution?.landingZones?.[p]) return { kind: 'project' };
  const first = plan.apps.find((a) => placedOn(appPlanOf(plan, a.id)) === p);
  return first ? { kind: 'app', app: first } : undefined;
}

/**
 * The approved rule: the first app on a cloud builds that cloud's landing
 * zone and its connectivity (`included`); the later apps on it reuse it
 * (`shared`). When the landing zone is designed on Migration & Utilities, every
 * app on the cloud reuses that one. Only apps that are placed are touched.
 */
export function assignLandingZones(plan: Plan): Plan {
  let out = plan;
  for (const ap of plan.appPlans ?? []) {
    const p = placedOn(ap);
    if (!p || p === 'vmware') continue;
    const b = landingZoneBuilder(plan, p);
    const mode = b?.kind === 'app' && b.app.id === ap.app ? 'included' : 'shared';
    if (ap.landingZone !== mode) out = withAppPlan(out, { ...ap, landingZone: mode });
  }
  return out;
}

/**
 * Design the app for another cloud: it becomes the app's chosen platform
 * (`chooseAppPlatform`: the cloud's variant kept, or translated from the
 * current one), the design remembers it, and the answers are applied to that
 * cloud's components. The other clouds' variants are kept, so switching back
 * restores them.
 */
export function setDesignCloud(plan: Plan, appId: string, cloud: Platform): DesignEdit & { readonly logEntry: string } {
  const chosen = chooseAppPlatform(allowPlatform(plan, cloud), appId, cloud);
  const stored = withDesign(chosen.plan, appId, (d) => ({ ...d, cloud }));
  const r = applyWizard(stored, appId, cloud, designAnswers(stored, appId).answers as Answers);
  return { plan: assignLandingZones(refreshPeers(r.plan, appId)), notes: [...chosen.findings, ...r.notes], logEntry: chosen.logEntry };
}

/**
 * Choosing a cloud for an app in the wizard allows it: the cloud is added to
 * the allowed platforms, and the cap on platforms is raised to the clouds the
 * designed apps use,
 * so the decision places the app there instead of leaving it unplaced.
 */
export function allowPlatform(plan: Plan, cloud: Platform): Plan {
  const req = plan.requirements;
  const allowed = req.allowed.includes(cloud) ? req.allowed : [...req.allowed, cloud];
  const used = new Set([...(plan.appPlans ?? []).map((a) => placedOn(a)).filter((p): p is Platform => !!p), cloud]);
  const maxPlatforms = Math.min(5, Math.max(req.maxPlatforms, used.size)) as Plan['requirements']['maxPlatforms'];
  if (allowed === req.allowed && maxPlatforms === req.maxPlatforms) return plan;
  return { ...plan, requirements: { ...req, allowed, maxPlatforms } };
}

/** Forget the user's answers (the plan's come back); the cloud is kept. */
export function resetDesignAnswers(plan: Plan, appId: string): Plan {
  return withDesign(plan, appId, (d) => ({ ...d, answers: {} }));
}

/** The design as it would be applied, without storing anything: the plan with the answers applied on `cloud` (for the preview cards). */
export function previewDesign(plan: Plan, appId: string, cloud: Platform): Plan {
  const placed = appPlanOf(plan, appId)?.platform === cloud ? plan : chooseAppPlatform(plan, appId, cloud).plan;
  return applyWizard(placed, appId, cloud, designAnswers(placed, appId).answers as Answers).plan;
}
