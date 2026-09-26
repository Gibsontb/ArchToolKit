/**
 * One cloud at a time on Multi-Cloud Migration & Utilities.
 *
 * The cloud-specific panes (Landing zones, Estate capacity, the Execute
 * settings, Utilities) show one cloud, chosen from a dropdown first. Nothing
 * defaults to a cloud the viewer did not choose: with no choice and no app
 * placed by choice, the panes show only the dropdown and a one-line prompt.
 *
 * - `cloudUsage` says which clouds the plan's applications use: an app's own
 *   choice (`appPlans[].platform`, or its design's `cloud`), else, marked as a
 *   recommendation, where the decision places its items.
 * - `resolveCloud` picks the cloud a pane shows: the hash argument, else the
 *   viewer's remembered choice, else the cloud most applications chose.
 * - `cloudPicker` is the dropdown; the choice is remembered per viewer
 *   (localStorage) and shared by every cloud-specific pane of the page.
 */

import { el, append } from '../dom.ts';
import type { Plan, PlanDecision, Platform } from '../../multicloud/plan/types.ts';

export const CLOUD_ORDER: readonly Platform[] = Object.freeze(['aws', 'azure', 'google', 'oci', 'vmware'] as const);

/** The name of each cloud in the dropdown. */
export const CLOUD_NAMES: Readonly<Record<Platform, string>> = {
  aws: 'AWS',
  azure: 'Microsoft Azure',
  google: 'Google Cloud (GCP)',
  oci: 'OCI',
  vmware: 'VMware Cloud Foundation (VCF) 9.1',
};

/** The provider's own name for its landing zone. */
export const LANDING_ZONE_NAMES: Readonly<Record<Platform, string>> = {
  aws: 'Landing zone (Control Tower + Landing Zone Accelerator)',
  azure: 'Azure landing zone',
  google: 'Foundation (enterprise foundations blueprint)',
  oci: 'Core Landing Zone',
  vmware: 'Management and workload domains',
};

/** The provider's service for connectivity back to the data centre. */
export const DC_LINK_NAMES: Readonly<Record<Platform, string>> = {
  aws: 'AWS Direct Connect',
  azure: 'Azure ExpressRoute',
  google: 'Cloud Interconnect',
  oci: 'OCI FastConnect',
  vmware: 'HCX + NSX',
};

export const isCloud = (v: unknown): v is Platform => typeof v === 'string' && (CLOUD_ORDER as readonly string[]).includes(v);

export interface CloudUse {
  readonly cloud: Platform;
  /** Apps placed here by their own choice, in plan order. */
  readonly chosen: readonly string[];
  /** Apps not yet placed by choice that the decision recommends here. */
  readonly recommended: readonly string[];
}

/** An app's own cloud: the chosen platform, else its design's cloud. Read defensively (the design may be absent). */
export function chosenCloudOf(plan: Pick<Plan, 'appPlans'>, appId: string): Platform | undefined {
  const ap = (plan.appPlans ?? []).find((x) => x.app === appId) as ({ platform?: unknown; design?: { cloud?: unknown } } | undefined);
  if (isCloud(ap?.platform)) return ap.platform;
  const cloud = ap?.design && typeof ap.design === 'object' ? ap.design.cloud : undefined;
  return isCloud(cloud) ? cloud : undefined;
}

/** Where the decision places most of an app's items (or its recommendation), for apps with no choice. */
function recommendedCloudOf(plan: Pick<Plan, 'apps' | 'appPlans' | 'workloads' | 'databases'>, appId: string, decision?: Pick<PlanDecision, 'items'>): Platform | undefined {
  const app = plan.apps.find((a) => a.id === appId);
  if (!app) return undefined;
  const count = new Map<Platform, number>();
  if (decision) {
    const mine = (x: { app?: string }) => x.app === app.name || x.app === app.id;
    for (const item of [...plan.workloads.filter(mine), ...plan.databases.filter(mine)]) {
      const d = decision.items[item.id];
      if (d?.chosen && d.method !== 'none') count.set(d.chosen.platform, (count.get(d.chosen.platform) ?? 0) + 1);
    }
  }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1] || CLOUD_ORDER.indexOf(a[0]) - CLOUD_ORDER.indexOf(b[0]))[0]?.[0];
  if (best) return best;
  const rec = (plan.appPlans ?? []).find((x) => x.app === appId)?.recommendation?.platform;
  return isCloud(rec) ? rec : undefined;
}

/** Which clouds the plan's applications use, by choice and by recommendation (clouds with none left out). */
export function cloudUsage(plan: Pick<Plan, 'apps' | 'appPlans' | 'workloads' | 'databases'>, decision?: Pick<PlanDecision, 'items'>): CloudUse[] {
  const chosen = new Map<Platform, string[]>();
  const recommended = new Map<Platform, string[]>();
  for (const app of plan.apps) {
    const c = chosenCloudOf(plan, app.id);
    if (c) {
      chosen.set(c, [...(chosen.get(c) ?? []), app.name]);
      continue;
    }
    const r = recommendedCloudOf(plan, app.id, decision);
    if (r) recommended.set(r, [...(recommended.get(r) ?? []), app.name]);
  }
  return CLOUD_ORDER
    .map((cloud) => ({ cloud, chosen: chosen.get(cloud) ?? [], recommended: recommended.get(cloud) ?? [] }))
    .filter((u) => u.chosen.length > 0 || u.recommended.length > 0);
}

const apps = (n: number): string => `${n} app${n === 1 ? '' : 's'}`;

/** "Microsoft Azure: 3 apps", with the recommended-only apps said apart. */
export function usageText(u: CloudUse): string {
  const parts: string[] = [];
  if (u.chosen.length) parts.push(apps(u.chosen.length));
  if (u.recommended.length) parts.push(`${apps(u.recommended.length)} recommended, not chosen`);
  return `${CLOUD_NAMES[u.cloud]}: ${parts.join(', ')}`;
}

/** The dropdown's option text for a cloud. */
export function optionText(cloud: Platform, usage: readonly CloudUse[]): string {
  const u = usage.find((x) => x.cloud === cloud);
  return u ? usageText(u) : CLOUD_NAMES[cloud];
}

/**
 * The cloud a pane shows: the hash argument, else the remembered choice,
 * else the cloud most apps chose (ties: the first app's). Never a default:
 * with none of these it is undefined.
 */
export function resolveCloud(arg: string | undefined, remembered: string | null | undefined, usage: readonly CloudUse[]): Platform | undefined {
  const a = (arg ?? '').split('/')[0]?.trim().toLowerCase();
  if (isCloud(a)) return a;
  if (isCloud(remembered)) return remembered;
  const byChoice = usage.filter((u) => u.chosen.length > 0);
  if (byChoice.length === 0) return undefined;
  return [...byChoice].sort((x, y) => y.chosen.length - x.chosen.length)[0]!.cloud;
}

/**
 * Who builds a cloud's landing zone. The agreed rule: the first app on a
 * cloud builds it, the later apps reuse it (shared). When it is designed on
 * this page it is shared from the start.
 */
export type LandingZoneBuild =
  | { readonly kind: 'page'; readonly state: 'designed' | 'generated' }
  | { readonly kind: 'app'; readonly app: string; readonly reusedBy: readonly string[] }
  | { readonly kind: 'none'; readonly recommended: readonly string[] };

export function landingZoneBuild(plan: Pick<Plan, 'apps' | 'appPlans' | 'workloads' | 'databases' | 'execution'>, cloud: Platform, decision?: Pick<PlanDecision, 'items'>): LandingZoneBuild {
  const state = plan.execution?.landingZones?.[cloud];
  if (state) return { kind: 'page', state: state === 'generated' ? 'generated' : 'designed' };
  const u = cloudUsage(plan, decision).find((x) => x.cloud === cloud);
  const [first, ...rest] = u?.chosen ?? [];
  if (first) return { kind: 'app', app: first, reusedBy: rest };
  return { kind: 'none', recommended: u?.recommended ?? [] };
}

/** The sentence for a landing zone's build state. */
export function landingZoneBuildText(b: LandingZoneBuild, cloud: Platform): string {
  const name = CLOUD_NAMES[cloud];
  if (b.kind === 'page') return `Shared: designed on this page${b.state === 'generated' ? ' and generated' : ', not generated yet'}. Every application on ${name} reuses it.`;
  if (b.kind === 'app') {
    return `Built by ${b.app}, the first application on ${name}.${b.reusedBy.length ? ` Reused (shared) by ${b.reusedBy.join(', ')}.` : ' Later applications here reuse it (shared).'}`;
  }
  return `Not built yet: no application is placed on ${name}. The first one placed here builds it${b.recommended.length ? ` (recommended here, not chosen: ${b.recommended.join(', ')})` : ''}.`;
}

// ---------------------------------------------------------------------------
// The viewer's choice, and the dropdown
// ---------------------------------------------------------------------------

const KEY = 'atk.migration-utilities.cloud';
let sessionChoice: Platform | undefined;
const EVENT = 'atk:migration-cloud';

export function rememberedCloud(): Platform | undefined {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return isCloud(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Remember the viewer's cloud and tell every cloud-specific pane on the page. */
export function rememberCloud(cloud: Platform | undefined, notify = true): void {
  try {
    if (cloud) globalThis.localStorage?.setItem(KEY, cloud);
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  sessionChoice = cloud;
  if (notify) notifyCloud(cloud);
}

/** Tell every cloud-specific pane on the page that the cloud changed. */
export function notifyCloud(cloud: Platform | undefined): void {
  globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: cloud ?? '' }));
}


/** The viewer's choice (remembered, or made on this page when storage is blocked). */
export function viewerCloud(): Platform | undefined {
  try {
    if (globalThis.localStorage) return rememberedCloud();
  } catch {
    // Storage blocked: fall through to the page's own choice.
  }
  return sessionChoice;
}

/** Called when another pane changes the cloud. Returns the unsubscribe. */
export function onCloudChange(listener: (cloud: Platform | undefined) => void): () => void {
  const handler = (e: Event) => {
    const v = (e as CustomEvent).detail;
    listener(isCloud(v) ? v : undefined);
  };
  globalThis.addEventListener?.(EVENT, handler);
  return () => globalThis.removeEventListener?.(EVENT, handler);
}

/**
 * The cloud dropdown with the usage line next to it: which clouds the plan's
 * applications use. With no cloud, the one-line prompt.
 */
export function cloudPicker(options: {
  readonly cloud: Platform | undefined;
  readonly usage: readonly CloudUse[];
  readonly onChange: (cloud: Platform | undefined) => void;
  readonly prompt: string;
  readonly control?: string;
}): HTMLElement {
  const { cloud, usage } = options;
  const s = el('select', { attrs: { 'aria-label': 'Cloud', 'data-control': options.control ?? 'cloud-choice' } }) as HTMLSelectElement;
  append(s, el('option', { text: 'Choose a cloud…', attrs: { value: '' } }));
  for (const c of CLOUD_ORDER) append(s, el('option', { text: optionText(c, usage), attrs: { value: c } }));
  s.value = cloud ?? '';
  s.addEventListener('change', () => {
    const v = isCloud(s.value) ? s.value : undefined;
    rememberCloud(v, false);
    options.onChange(v);
    notifyCloud(v);
  });
  const used = usage.length === 0
    ? 'No application is placed on a cloud yet.'
    : `In the plan: ${usage.map(usageText).join(' · ')}.`;
  return el('div', { class: 'stack', attrs: { 'data-control': 'cloud-picker' }, style: { gap: 'var(--space-2)', minWidth: '0' } },
    el('div', { class: 'field', style: { margin: '0', maxWidth: '100%' } }, el('label', { text: 'Cloud' }), s),
    el('p', { class: 'small muted', text: used, attrs: { 'data-control': 'cloud-usage' }, style: { margin: '0', overflowWrap: 'anywhere' } }),
    cloud ? null : el('p', { class: 'small', text: options.prompt, attrs: { 'data-control': 'cloud-prompt' }, style: { margin: '0' } }));
}
