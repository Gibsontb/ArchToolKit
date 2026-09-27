/**
 * An application's components (addendum A.2.1, A.2.6, A.2.10).
 *
 * A migrating app's components are derived from its servers: a server's
 * component is keyed by (tier, workload type), the tier coming from the
 * grouping's `name-regex` tier group when there is one, otherwise from its
 * Role (`tierOf`, intake/grouping.ts). Databases join the `data` component of
 * their host servers' app; a database with no host joins its own `data`
 * component. The user edits them afterwards; nothing here overwrites a saved
 * variant.
 *
 * A new application (greenfield, `origin: 'new'`) has no servers: it starts
 * from a greenfield pattern's template (patterns/greenfield.ts), one variant
 * per allowed platform with that platform's default tier pattern, and each
 * component becomes a **synthetic item** — a `Workload` or `Database` row
 * with `source: 'manual'`, `synthetic: true` and the disposition `new`, sized
 * from the load profile by the `load` engine — so `decidePlan` and
 * `recommendApp` recommend a cloud for it exactly as for a migrating app.
 * Synthetic rows are regenerated whenever the load profile changes.
 *
 * Pure: every function returns a new Plan and never touches storage.
 */

import { info, type Finding } from '../../../core/findings.ts';
import { tierOf } from '../intake/grouping.ts';
import { itemId, PLATFORM_VALUES, slugName } from '../options.ts';
import { defaultTierPattern, GREENFIELD_INGRESS, PATTERN_CATALOG, workloadTypeOf, type ComponentTemplate } from '../patterns/index.ts';
import { loadEngine } from '../sizing/load.ts';
import { sizeComponent } from '../sizing/index.ts';
import type {
  App, AppComponent, AppIngress, AppPattern, AppPlan, ComponentTier, Criticality, Database, DbEngine, Env, LoadProfile, OsId,
  PatternComponent, Plan, Platform, Role, SizingRow, TargetDesign, TierPattern, Workload, WorkloadType,
} from '../types.ts';
import { translateVariant } from './translate.ts';

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** An app by id or name. */
export function findApp(plan: Pick<Plan, 'apps'>, ref: string): App | undefined {
  return plan.apps.find((a) => a.id === ref) ?? plan.apps.find((a) => a.name === ref) ?? plan.apps.find((a) => slugName(a.name) === slugName(ref));
}

/** The app's workloads (by `Workload.app`). */
export function appWorkloads(plan: Pick<Plan, 'workloads'>, app: Pick<App, 'name'>): Workload[] {
  return plan.workloads.filter((w) => w.app === app.name);
}

/** The app's databases: its own, and any hosted on its servers. */
export function appDatabases(plan: Pick<Plan, 'workloads' | 'databases'>, app: Pick<App, 'name'>): Database[] {
  const hosts = new Set(appWorkloads(plan, app).map((w) => w.name));
  return plan.databases.filter((d) => d.app === app.name || d.hosts.some((h) => hosts.has(h)));
}

/** A component id: `c:<app-slug>:<slug>`. */
export const componentId = (appName: string, slug: string): string => `c:${slugName(appName)}:${slugName(slug)}`;

/** The app's plan, if one exists. */
export function appPlanOf(plan: Pick<Plan, 'apps' | 'appPlans'>, ref: string): AppPlan | undefined {
  const app = findApp(plan, ref);
  return app ? (plan.appPlans ?? []).find((p) => p.app === app.id) : undefined;
}

/** A plan with one app plan added or replaced (by `app`), order kept. */
export function withAppPlan(plan: Plan, ap: AppPlan): Plan {
  const list = plan.appPlans ?? [];
  const at = list.findIndex((p) => p.app === ap.app);
  return { ...plan, appPlans: at >= 0 ? list.map((p, i) => (i === at ? ap : p)) : [...list, ap] };
}

/** A fresh app plan: draft, following the recommendation, the landing zone included. */
export function defaultAppPlan(app: App, origin: AppPlan['origin'] = app.route === 'new' ? 'new' : 'migrate'): AppPlan {
  return { app: app.id, origin, status: 'draft', variants: {}, answers: {}, landingZone: 'included', ...(app.route && app.route !== 'new' ? { route: app.route } : {}) };
}

// ---------------------------------------------------------------------------
// Derivation from grouping (migrating apps)
// ---------------------------------------------------------------------------

export interface DeriveOptions {
  /** Workload id or name → the `name-regex` tier group, as `regroup` returns it. */
  readonly regexTiers?: Readonly<Record<string, string>>;
}

/** The pattern's template a component falls into: by workload type, then by tier. */
export function templateFor(pattern: AppPattern | undefined, tier: ComponentTier, type?: WorkloadType): ComponentTemplate | undefined {
  const entry = PATTERN_CATALOG[pattern ?? 'generic'] ?? PATTERN_CATALOG.generic;
  return (type ? entry.components.find((c) => c.workloadTypes?.includes(type)) : undefined)
    ?? entry.components.find((c) => c.tier === tier)
    ?? undefined;
}

/**
 * The app's pattern components from its servers and databases. Ids are stable
 * (`c:<app>:<tier>` or `c:<app>:<tier>-<type>` when a tier holds several
 * types), so re-deriving never renames what the user already refers to.
 */
export function deriveComponents(plan: Pick<Plan, 'apps' | 'workloads' | 'databases'>, appRef: string, options: DeriveOptions = {}): PatternComponent[] {
  const app = findApp(plan, appRef);
  if (!app) return [];
  const workloads = appWorkloads(plan, app);
  const groups = new Map<string, { tier: ComponentTier; type?: WorkloadType; servers: string[]; databases: string[] }>();
  const keyOf = (tier: ComponentTier, type?: WorkloadType): string => `${tier}\u0000${type ?? ''}`;
  const tierOfServer = new Map<string, ComponentTier>();
  for (const w of workloads) {
    const tier = tierOf(w.role, options.regexTiers?.[w.id] ?? options.regexTiers?.[w.name]);
    const type = workloadTypeOf(w);
    tierOfServer.set(w.name, tier);
    const k = keyOf(tier, type);
    const g = groups.get(k) ?? { tier, ...(type ? { type } : {}), servers: [], databases: [] };
    g.servers.push(w.name);
    groups.set(k, g);
  }
  for (const d of appDatabases(plan, app)) {
    // The data component of its hosts (the first host that is this app's), else its own data component.
    const host = d.hosts.find((h) => tierOfServer.has(h));
    const hostKey = host ? [...groups.entries()].find(([, g]) => g.servers.includes(host) && g.tier === 'data')?.[0] : undefined;
    const k = hostKey ?? keyOf('data', undefined);
    const g = groups.get(k) ?? { tier: 'data' as ComponentTier, servers: [], databases: [] };
    g.databases.push(d.name);
    groups.set(k, g);
  }
  const perTier = new Map<ComponentTier, number>();
  for (const g of groups.values()) perTier.set(g.tier, (perTier.get(g.tier) ?? 0) + 1);
  const out: PatternComponent[] = [];
  for (const g of groups.values()) {
    const slug = (perTier.get(g.tier) ?? 0) > 1 && g.type ? `${g.tier}-${g.type}` : g.tier;
    const template = templateFor(app.pattern, g.tier, g.type);
    out.push({
      id: componentId(app.name, slug),
      name: slug,
      tier: g.tier,
      kind: 'pattern',
      ...(g.type ? { workloadType: g.type } : {}),
      servers: g.servers,
      databases: g.databases,
      settings: template && app.pattern && app.pattern !== 'generic' ? { template: template.name } : {},
    });
  }
  return out.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.id.localeCompare(b.id));
}

const TIER_ORDER: readonly ComponentTier[] = ['edge', 'web', 'app', 'integration', 'platform', 'data', 'file', 'vdi', 'infra', 'other'];

/**
 * The app's plan with a variant on `platform`: kept when it exists; else
 * translated from another variant (the current platform's first); else
 * derived from the servers (migrating) or the template (new). The chosen
 * platform is not changed.
 */
export function ensureVariant(plan: Plan, appRef: string, platform: Platform): { plan: Plan; appPlan: AppPlan; created: boolean; findings: Finding[] } {
  const app = findApp(plan, appRef);
  if (!app) return { plan, appPlan: { app: appRef, origin: 'migrate', status: 'draft', variants: {}, answers: {}, landingZone: 'included' }, created: false, findings: [info('apps.unknown', `There is no application ${appRef}.`)] };
  const ap = appPlanOf(plan, app.id) ?? defaultAppPlan(app);
  if (ap.variants[platform]) return { plan, appPlan: ap, created: false, findings: [] };
  const from = (ap.platform && ap.variants[ap.platform]) ? ap.platform : PLATFORM_VALUES.find((p) => ap.variants[p]);
  let components: readonly AppComponent[];
  let findings: Finding[] = [];
  if (from) {
    const t = translateVariant(ap.variants[from] ?? [], from, platform, { regions: regionsOf(plan) });
    components = t.components;
    findings = [...t.findings];
  } else {
    components = deriveComponents(plan, app.id);
  }
  const next: AppPlan = { ...ap, variants: { ...ap.variants, [platform]: components } };
  return { plan: withAppPlan(plan, next), appPlan: next, created: true, findings };
}

export function regionsOf(plan: Pick<Plan, 'requirements'>): Partial<Record<Platform, string>> {
  const out: Partial<Record<Platform, string>> = {};
  for (const p of PLATFORM_VALUES) {
    const r = plan.requirements.regions[p]?.primary?.trim();
    if (r) out[p] = r;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Greenfield: new applications and their synthetic items
// ---------------------------------------------------------------------------

export const DEFAULT_LOAD: LoadProfile = Object.freeze({ environments: Object.freeze(['prod'] as Env[]), nonprodPct: 25 });

export interface NewAppOptions {
  readonly name: string;
  /** A greenfield pattern; default `blank`. */
  readonly pattern?: AppPattern;
  readonly load?: LoadProfile;
  readonly owner?: string;
  readonly criticality?: Criticality;
}

const DB_TIER_PATTERNS: ReadonlySet<TierPattern> = new Set(['managed-db', 'managed-cache']);

/**
 * A new application (`origin: 'new'`): the App row (route `new`), its plan
 * with one variant per allowed platform from the pattern's template, and the
 * synthetic items sized from the load profile.
 */
export function newApplication(plan: Plan, options: NewAppOptions): { plan: Plan; app: App; findings: Finding[] } {
  const pattern = options.pattern ?? 'blank';
  const name = options.name.trim();
  const app: App = {
    id: itemId('app', name),
    name,
    ...(options.owner ? { owner: options.owner } : {}),
    criticality: options.criticality ?? 'tier2',
    residency: plan.requirements.defaultResidency,
    latencyToOnPrem: 'tolerant',
    special: 'none',
    route: 'new',
    kind: 'home-grown',
    pattern,
    source: 'manual',
  };
  const entry = PATTERN_CATALOG[pattern];
  const variants: Partial<Record<Platform, AppComponent[]>> = {};
  for (const p of plan.requirements.allowed.length > 0 ? plan.requirements.allowed : PLATFORM_VALUES) {
    variants[p] = entry.components.map((t): PatternComponent => ({
      id: componentId(name, t.name),
      name: t.name,
      tier: t.tier,
      kind: 'pattern',
      tierPattern: defaultTierPattern(t, p),
      servers: [],
      databases: [],
      settings: {},
    }));
  }
  const ingress: AppIngress | undefined = GREENFIELD_INGRESS.has(pattern)
    ? { fqdns: [], exposure: 'public', lb: 'l7', tls: 'terminate', waf: true }
    : undefined;
  const ap: AppPlan = {
    app: app.id,
    origin: 'new',
    status: 'draft',
    variants,
    answers: {},
    load: options.load ?? DEFAULT_LOAD,
    landingZone: 'included',
    ...(ingress ? { ingress } : {}),
  };
  const others = plan.apps.filter((a) => a.id !== app.id);
  const base = withAppPlan({ ...plan, apps: [...others, app] }, ap);
  const r = regenerateSynthetic(base, app.id);
  return { plan: r.plan, app, findings: r.findings };
}

/** A plan with the app's load profile replaced, and its synthetic items regenerated. */
export function setLoadProfile(plan: Plan, appRef: string, load: LoadProfile): { plan: Plan; findings: Finding[] } {
  const ap = appPlanOf(plan, appRef);
  if (!ap) return { plan, findings: [info('apps.no-plan', `${appRef} has no application plan.`)] };
  return regenerateSynthetic(withAppPlan(plan, { ...ap, load }), appRef);
}

const ROLE_OF_TIER: Readonly<Record<ComponentTier, Role>> = {
  web: 'web', app: 'app', integration: 'messaging', data: 'db', file: 'file', vdi: 'rds-vdi', infra: 'other', edge: 'web', platform: 'app', other: 'app',
};

const num = (row: SizingRow | undefined, key: string): number | undefined => {
  const v = row?.detail[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

export interface SyntheticItems {
  readonly workloads: readonly Workload[];
  readonly databases: readonly Database[];
  /** Component id → the synthetic names it carries. */
  readonly carried: Readonly<Record<string, { readonly servers: readonly string[]; readonly databases: readonly string[] }>>;
  readonly findings: readonly Finding[];
}

/**
 * The synthetic items of a new app, from its variant on `platform` (default:
 * the chosen platform, else the first variant). A `vm` component gives one
 * workload per sized prod instance plus the nonprod instances per nonprod
 * environment; a `managed-db` / `managed-cache` component gives one database;
 * any other tier pattern gives one workload that carries the decision (and is
 * built by its pattern item, never as a VM).
 */
export function syntheticItems(plan: Plan, appRef: string, platform?: Platform): SyntheticItems {
  const app = findApp(plan, appRef);
  const ap = app ? appPlanOf(plan, app.id) : undefined;
  if (!app || !ap || ap.origin !== 'new') return { workloads: [], databases: [], carried: {}, findings: [] };
  const p = platform ?? (ap.platform && ap.variants[ap.platform] ? ap.platform : PLATFORM_VALUES.find((x) => ap.variants[x]));
  if (!p) return { workloads: [], databases: [], carried: {}, findings: [] };
  const load = ap.load ?? DEFAULT_LOAD;
  const slug = slugName(app.name);
  const workloads: Workload[] = [];
  const databases: Database[] = [];
  const carried: Record<string, { servers: string[]; databases: string[] }> = {};
  const findings: Finding[] = [];
  const rpo = app.rpo ?? '4h';
  const rto = app.rto ?? '4h';
  for (const c of ap.variants[p] ?? []) {
    if (c.kind !== 'pattern') continue;
    const tp = c.tierPattern ?? 'vm';
    if (tp === 'retire' || tp === 'retain' || tp === 'saas') continue;
    const recs = sizeComponent(c, p, plan, [loadEngine]);
    const rows = recs.flatMap((r) => r.rows);
    for (const r of recs) findings.push(...r.findings);
    const entry = { servers: [] as string[], databases: [] as string[] };
    carried[c.id] = entry;
    const base = `${slug}-${slugName(c.name)}`;
    if (DB_TIER_PATTERNS.has(tp)) {
      const row = rows.find((r) => r.key.endsWith(':db'));
      const engine = (c.settings.engine?.trim() || (tp === 'managed-cache' ? 'redis' : 'postgres')) as DbEngine;
      const dbName = base;
      databases.push({
        id: itemId('database', dbName), name: dbName, engine,
        edition: 'community',
        version: engine === 'postgres' ? 'pg-16' : engine === 'mysql' ? 'mysql-8.4' : 'other',
        hosts: [],
        vcpu: num(row, 'vcpu') ?? 2,
        ramGib: num(row, 'ramGib') ?? 8,
        sizeGib: Math.max(20, num(row, 'storageGib') ?? 20),
        ha: 'none', dr: 'none', features: [], licence: 'community', app: app.name, source: 'manual',
      });
      entry.databases.push(dbName);
      continue;
    }
    const row = rows.find((r) => r.key.endsWith(':instances')) ?? rows[0];
    const vcpu = num(row, 'vcpu') ?? 2;
    const ramGib = num(row, 'ramGib') ?? 8;
    const make = (name: string, env: Env): Workload => ({
      id: itemId('workload', name), name, app: app.name, env, role: ROLE_OF_TIER[c.tier], os: (c.settings.os?.trim() || 'ubuntu-24.04') as OsId,
      vcpu, ramGib, disksGib: [64], criticality: app.criticality, rpo, rto, licence: 'free', disposition: 'new', dependsOn: [],
      source: 'manual', synthetic: true, basis: 'load',
    });
    const mine: Workload[] = [];
    if (tp === 'vm') {
      const prod = Math.max(1, num(row, 'instances') ?? 1);
      for (let i = 1; i <= prod; i += 1) mine.push(make(`${base}-${String(i).padStart(2, '0')}`, 'prod'));
      const nonprod = Math.max(1, num(row, 'nonprodInstances') ?? 1);
      for (const env of load.environments.filter((e) => e !== 'prod')) {
        for (let i = 1; i <= nonprod; i += 1) mine.push(make(`${base}-${env}-${String(i).padStart(2, '0')}`, env));
      }
    } else {
      mine.push(make(base, 'prod'));
    }
    workloads.push(...mine);
    entry.servers.push(...mine.map((w) => w.name));
  }
  if (workloads.length + databases.length === 0 && (ap.variants[p] ?? []).some((c) => c.kind === 'pattern')) {
    findings.push(info('apps.new.no-items', `${app.name}: no component needs a synthetic item on ${p}.`));
  }
  return { workloads, databases, carried, findings };
}

/**
 * Replace the app's synthetic rows with freshly sized ones, and point every
 * variant's components at them (same names on every platform).
 */
export function regenerateSynthetic(plan: Plan, appRef: string, platform?: Platform): { plan: Plan; findings: Finding[] } {
  const app = findApp(plan, appRef);
  const ap = app ? appPlanOf(plan, app.id) : undefined;
  if (!app || !ap || ap.origin !== 'new') return { plan, findings: [] };
  const s = syntheticItems(plan, app.id, platform);
  const keepW = plan.workloads.filter((w) => !(w.app === app.name && w.synthetic));
  const keepD = plan.databases.filter((d) => !(d.app === app.name && d.source === 'manual' && d.hosts.length === 0 && isSyntheticDbName(app.name, d.name, ap)));
  const variants: Partial<Record<Platform, readonly AppComponent[]>> = {};
  for (const [p, list] of Object.entries(ap.variants) as [Platform, readonly AppComponent[]][]) {
    variants[p] = list.map((c) => {
      if (c.kind !== 'pattern') return c;
      const carried = s.carried[c.id];
      return carried ? { ...c, servers: [...carried.servers], databases: [...carried.databases] } : { ...c, servers: [], databases: [] };
    });
  }
  const next: Plan = { ...plan, workloads: [...keepW, ...s.workloads], databases: [...keepD, ...s.databases] };
  return { plan: withAppPlan(next, { ...ap, variants }), findings: [...s.findings] };
}

function isSyntheticDbName(appName: string, dbName: string, ap: AppPlan): boolean {
  const slug = slugName(appName);
  return Object.values(ap.variants).some((list) => (list ?? []).some((c) => c.kind === 'pattern' && dbName === `${slug}-${slugName(c.name)}`));
}

/**
 * The synthetic workloads that stand for a non-VM component (paas-web,
 * serverless, containers …) on a platform: they carry the decision, but their
 * pattern item builds them, so they are never VMs.
 */
export function serviceSyntheticIds(plan: Pick<Plan, 'workloads' | 'appPlans'>, platform: Platform): Set<string> {
  const synthetic = new Map(plan.workloads.filter((w) => w.synthetic).map((w) => [w.name, w.id]));
  const out = new Set<string>();
  if (synthetic.size === 0) return out;
  for (const ap of plan.appPlans ?? []) {
    for (const c of ap.variants[platform] ?? []) {
      if (c.kind !== 'pattern' || !c.tierPattern || c.tierPattern === 'vm') continue;
      for (const n of c.servers) {
        const id = synthetic.get(n);
        if (id) out.add(id);
      }
    }
  }
  return out;
}

/** The design without the compute targets of `serviceSyntheticIds` (for Ansible, Compare and capacity). */
export function withoutServiceSynthetics(plan: Pick<Plan, 'workloads' | 'appPlans'>, design: TargetDesign): TargetDesign {
  let changed = false;
  const names = new Set<string>();
  const platforms = design.platforms.map((pd) => {
    const drop = serviceSyntheticIds(plan, pd.platform);
    if (drop.size === 0) return pd;
    changed = true;
    for (const w of plan.workloads) if (drop.has(w.id)) names.add(w.name);
    return { ...pd, compute: pd.compute.filter((c) => !drop.has(c.workload)) };
  });
  // A service the pattern item builds (not a VM) needs no VM subnet: its "no subnet" finding goes too.
  const findings = design.findings.filter((f) => f.code !== 'design.compute.no-subnet' || ![...names].some((n) => f.message.startsWith(`${n}:`)));
  return changed ? { ...design, platforms, findings } : design;
}
