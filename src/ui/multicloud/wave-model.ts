/**
 * The waves the `#waves` and `#generate` panes show, as a `WavePlan`.
 *
 * **Swap point.** `wavePlanFor` is the one function the panes call. The wave
 * engine (WP-9 `planWaves`) is not built yet, so it runs `localWavePlan`, a
 * simple grouping: one move group per application (joined with the apps it
 * has a synchronous dependency on), the pinned `App.wave` honoured, the rest
 * filled in order under the per-wave limits and the team's capacity, dated
 * from the start date around the freeze windows, then the data-centre exit
 * waves after the last app wave. When `planWaves` lands, `wavePlanFor`'s body
 * becomes a call to it and nothing else changes.
 */

import { info, warning, type Finding } from '../../core/findings.ts';
import { DEFAULT_WAVE_SETTINGS, slugName } from '../../multicloud/plan/options.ts';
import { exitSequence, exitWaves, wavesFromPlan, type ExitSequence } from '../../multicloud/plan/dcexit/sequence.ts';
import type {
  App, Criticality, Disposition, ItemId, Method, MoveGroup, Plan, PlanDecision, Wave, WavePlan, WaveSettings,
} from '../../multicloud/plan/types.ts';

/** The waves of a plan: the swap point for WP-9's `planWaves`. */
export function wavePlanFor(plan: Plan, decision: PlanDecision): WavePlan {
  return localWavePlan(plan, decision);
}

/** The plan's wave settings with the defaults filled in. */
export function waveSettingsOf(plan: Pick<Plan, 'waveSettings'>): WaveSettings {
  return { ...DEFAULT_WAVE_SETTINGS, ...(plan.waveSettings ?? {}), freezes: plan.waveSettings?.freezes ?? [] };
}

// ---------------------------------------------------------------------------
// The local grouping
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const CRIT_RANK: Readonly<Record<Criticality, number>> = { tier3: 0, tier2: 1, tier1: 2, tier0: 3 };
const MOVES_FAST: ReadonlySet<Method> = new Set(['replicate', 'relocate-hcx']);
const MODERNISE: ReadonlySet<Disposition> = new Set(['refactor', 'replatform']);

interface Draft {
  readonly id: string;
  readonly apps: string[];
  readonly items: ItemId[];
  readonly workloads: number;
  readonly databases: number;
  readonly method: Method;
  readonly criticality: number;
  readonly fast: boolean;
  readonly modernise: boolean;
  readonly pin?: number;
  readonly formedBy: string[];
}

/** Union-find over app names. */
function syncClusters(plan: Plan, appNames: readonly string[]): Map<string, string> {
  const parent = new Map(appNames.map((a) => [a, a]));
  const find = (a: string): string => {
    let x = a;
    while (parent.get(x) !== x) x = parent.get(x) as string;
    return x;
  };
  const appOf = new Map<string, string>();
  for (const w of plan.workloads) appOf.set(w.name, w.app);
  for (const d of plan.databases) appOf.set(d.name, d.app);
  for (const a of plan.apps) appOf.set(a.name, a.name);
  for (const e of plan.edges) {
    if (e.kind !== 'sync') continue;
    const a = appOf.get(e.from);
    const b = appOf.get(e.to);
    if (a === undefined || b === undefined || a === b || !parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }
  return new Map(appNames.map((a) => [a, find(a)]));
}

/**
 * The simple wave plan: move groups per app (sync-joined), waves filled under
 * the limits, dates around the freezes, then the exit waves.
 */
export function localWavePlan(plan: Plan, decision: PlanDecision): WavePlan {
  const settings = waveSettingsOf(plan);
  const findings: Finding[] = [];
  const moving = (id: ItemId): boolean => (decision.items[id]?.method ?? 'rebuild') !== 'none';
  const appByName = new Map<string, App>(plan.apps.map((a) => [a.name, a]));

  // ---- the move groups ------------------------------------------------------
  const names = [...new Set([...plan.workloads.map((w) => w.app), ...plan.databases.map((d) => d.app)])];
  const cluster = syncClusters(plan, names);
  const byRoot = new Map<string, string[]>();
  for (const n of names) byRoot.set(cluster.get(n) as string, [...(byRoot.get(cluster.get(n) as string) ?? []), n]);

  const drafts: Draft[] = [];
  for (const apps of byRoot.values()) {
    apps.sort();
    const ws = plan.workloads.filter((w) => apps.includes(w.app) && moving(w.id));
    const ds = plan.databases.filter((d) => apps.includes(d.app) && moving(d.id));
    if (ws.length + ds.length === 0) continue;
    const items = [...ws.map((w) => w.id), ...ds.map((d) => d.id)];
    const methods = new Map<Method, number>();
    for (const id of items) {
      const m = decision.items[id]?.method ?? 'rebuild';
      methods.set(m, (methods.get(m) ?? 0) + 1);
    }
    const method = [...methods.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'rebuild';
    const pins = apps.map((a) => appByName.get(a)?.wave).filter((n): n is number => typeof n === 'number');
    const crit = Math.max(0, ...apps.map((a) => CRIT_RANK[appByName.get(a)?.criticality ?? 'tier2']), ...ws.map((w) => CRIT_RANK[w.criticality] ?? 1));
    const label = apps.map((a) => a || 'No application');
    const pin = pins.length > 0 ? Math.max(1, Math.min(...pins)) : undefined;
    if (pins.includes(0)) findings.push(info('waves.pin-zero', `${label.join(', ')}: wave 0 is the foundation wave, so the pin moves it to wave 1.`));
    if (new Set(pins).size > 1) findings.push(warning('waves.pin-conflict', `${label.join(', ')} are joined by synchronous dependencies but pinned to different waves (${[...new Set(pins)].join(', ')}); they move together in wave ${pin}.`, { remediation: 'Pin the apps to the same wave, or make the dependency asynchronous.' }));
    drafts.push({
      id: `mg-${slugName(label.join('-')) || 'group'}`,
      apps: label,
      items,
      workloads: ws.length,
      databases: ds.length,
      method,
      criticality: crit,
      fast: MOVES_FAST.has(method),
      modernise: items.some((id) => MODERNISE.has(decision.items[id]?.disposition as Disposition)),
      ...(pin !== undefined ? { pin } : {}),
      formedBy: [apps.length > 1 ? 'dependency.sync' : 'app', ...(pins.length > 0 ? ['pin'] : [])],
    });
  }

  // ---- the waves --------------------------------------------------------------
  const cap = settings.capacity;
  const limits: { readonly key: string; readonly limit: number; readonly of: (d: Draft) => number }[] = [
    { key: 'maxPerWave', limit: settings.maxPerWave > 0 ? settings.maxPerWave : Infinity, of: (d) => d.items.length },
    ...(cap
      ? [
          { key: 'cutoversPerWindow', limit: cap.cutoversPerWindow > 0 ? cap.cutoversPerWindow : Infinity, of: (d: Draft) => d.workloads },
          { key: 'dbaCutoversPerWindow', limit: cap.dbaCutoversPerWindow > 0 ? cap.dbaCutoversPerWindow : Infinity, of: (d: Draft) => d.databases },
          { key: 'parallelAppTeams', limit: cap.parallelAppTeams > 0 ? cap.parallelAppTeams : Infinity, of: (d: Draft) => d.apps.length },
        ]
      : []),
  ];
  const load = new Map<number, Draft[]>();
  const limitedBy = new Map<number, string>();
  const sum = (n: number, of: (d: Draft) => number): number => (load.get(n) ?? []).reduce((s, d) => s + of(d), 0);
  const blocking = (n: number, d: Draft): string | undefined => limits.find((l) => sum(n, l.of) + l.of(d) > l.limit)?.key;
  const put = (n: number, d: Draft): void => {
    load.set(n, [...(load.get(n) ?? []), d]);
  };

  for (const d of drafts.filter((x) => x.pin !== undefined)) {
    const over = blocking(d.pin as number, d);
    if (over) findings.push(warning('waves.pinned-over-limit', `Wave ${d.pin}: pinning ${d.apps.join(', ')} there goes over ${over}.`, { remediation: 'Move a pin, or raise the limit.' }));
    put(d.pin as number, d);
  }
  const order = (a: Draft, b: Draft): number => {
    if (settings.mode === 'fast' && a.fast !== b.fast) return a.fast ? -1 : 1;
    if (settings.mode === 'modernize' && a.modernise !== b.modernise) return a.modernise ? -1 : 1;
    return a.criticality - b.criticality || b.items.length - a.items.length || a.id.localeCompare(b.id);
  };
  for (const d of drafts.filter((x) => x.pin === undefined).sort(order)) {
    let n = 1;
    for (;;) {
      const why = blocking(n, d);
      if (!why) break;
      if ((load.get(n) ?? []).length === 0) {
        findings.push(warning('waves.group-over-limit', `${d.apps.join(', ')} alone goes over ${why} (${d.items.length} items); it gets a wave of its own.`, { remediation: 'Split the application into move groups, or raise the limit.' }));
        break;
      }
      if (!limitedBy.has(n)) limitedBy.set(n, why);
      n += 1;
    }
    put(n, d);
  }

  // ---- dates ------------------------------------------------------------------
  const length = settings.weeks * 7;
  const freezes = settings.freezes.filter((f) => {
    const ok = ISO.test(f.from) && ISO.test(f.to) && f.from <= f.to;
    if (!ok) findings.push(warning('waves.freeze-invalid', `The freeze "${f.reason || `${f.from}–${f.to}`}" needs a From and a To as yyyy-mm-dd, From first; it is ignored.`));
    return ok;
  });
  const start = settings.start && ISO.test(settings.start) ? settings.start : undefined;
  if (settings.start && !start) findings.push(warning('waves.start-invalid', `The start date "${settings.start}" is not yyyy-mm-dd; the waves are not dated.`));
  let cursor = start;
  const windowAt = (label: string): { start: string; end: string } | undefined => {
    if (!cursor) return undefined;
    let s = cursor;
    for (let guard = 0; guard < 100; guard++) {
      const e = addDays(s, length - 1);
      const hit = freezes.find((f) => f.from <= e && f.to >= s);
      if (!hit) break;
      findings.push(info('waves.moved-past-freeze', `${label} moved past the freeze ${hit.from}–${hit.to}${hit.reason ? ` (${hit.reason})` : ''}.`));
      s = addDays(hit.to, 1);
    }
    const e = addDays(s, length - 1);
    cursor = addDays(e, 1);
    return { start: s, end: e };
  };

  const groups: MoveGroup[] = [{ id: 'foundation', items: [], why: 'Landing zones, identity, connectivity and backup, stood up before any application moves.', wave: 0, method: 'none', name: 'Foundations', formedBy: ['foundation'], phase: 'foundation' }];
  const f0 = windowAt('Wave 0 (foundations)');
  const waves: Wave[] = [{ n: 0, groups: ['foundation'], kind: 'foundation', name: 'Wave 0: foundations', phase: 'foundation', ...(f0 ? { start: f0.start, end: f0.end } : {}) }];
  const numbers = [...load.keys()].sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i += settings.parallel) {
    const slot = numbers.slice(i, i + settings.parallel);
    const when = windowAt(slot.length > 1 ? `Waves ${slot.join(' and ')}` : `Wave ${slot[0]}`);
    for (const n of slot) {
      const list = load.get(n) ?? [];
      for (const d of list) {
        groups.push({
          id: d.id, items: d.items, wave: n, method: d.method, name: d.apps.join(', '), apps: d.apps.filter((a) => a !== 'No application'), formedBy: d.formedBy, phase: 'cutover',
          why: d.formedBy.includes('dependency.sync') ? `Synchronous dependencies join ${d.apps.join(', ')}: they cut over together.` : `One application: ${d.apps[0]}.`,
        });
      }
      waves.push({
        n, groups: list.map((d) => d.id), kind: 'app', name: `Wave ${n}`, phase: 'cutover',
        ...(when ? { start: when.start, end: when.end } : {}),
        ...(limitedBy.has(n) ? { limitedBy: limitedBy.get(n) as string } : {}),
      });
    }
  }

  // The team's replication set-ups per day, over the wave's working days.
  if (cap && cap.replicationSetupsPerDay > 0) {
    for (const w of waves.filter((x) => x.kind === 'app')) {
      const replicating = w.groups.flatMap((g) => groups.find((x) => x.id === g)?.items ?? []).filter((id) => {
        const m = decision.items[id]?.method;
        return m === 'replicate' || m === 'relocate-hcx';
      }).length;
      const room = cap.replicationSetupsPerDay * settings.weeks * 5;
      if (replicating > room) findings.push(warning('waves.replication-setups', `Wave ${w.n} sets up replication for ${replicating} servers; at ${cap.replicationSetupsPerDay} a day that needs more than its ${settings.weeks * 5} working days.`, { remediation: 'Raise the set-ups per day, lengthen the waves, or lower the limit per wave.' }));
    }
  }

  const draftPlan: WavePlan = { settings, waves, groups, findings };
  const exit = exitPlanOf(plan, draftPlan);
  if (!exit) return draftPlan;
  const last = Math.max(0, ...waves.map((w) => w.n));
  // The exit waves come after the last app wave; renumbered when they would not.
  const listed = exitWaves(exit);
  const exitWavesList = listed.some((w) => w.n <= last) ? listed.map((w, i) => ({ ...w, n: last + 1 + i })) : listed;
  return { settings, waves: [...waves, ...exitWavesList], groups, findings: [...findings, ...exit.findings] };
}

/** The data-centre exit sequence, in `dc-exit` mode with a data centre described; undefined otherwise. */
export function exitPlanOf(plan: Plan, wavePlan: WavePlan): ExitSequence | undefined {
  if (plan.mode !== 'dc-exit' || !plan.dcExit) return undefined;
  const { waveOf, waveEnds } = wavesFromPlan(plan, { ...wavePlan, waves: wavePlan.waves.filter((w) => w.kind !== 'exit') });
  return exitSequence({ dcExit: plan.dcExit, workloads: plan.workloads, waveOf, waveEnds, planId: plan.id });
}

// ---------------------------------------------------------------------------
// Per-wave totals
// ---------------------------------------------------------------------------

export interface WaveLoad {
  readonly n: number;
  readonly name: string;
  readonly kind: string;
  readonly groups: number;
  readonly apps: number;
  readonly workloads: number;
  readonly databases: number;
  readonly dataGib: number;
  readonly start?: string;
  readonly end?: string;
  readonly limitedBy?: string;
}

/** What each wave carries: groups, apps, servers, databases and data. */
export function waveLoads(plan: Plan, wavePlan: WavePlan): WaveLoad[] {
  const groups = new Map(wavePlan.groups.map((g) => [g.id, g]));
  const ws = new Map(plan.workloads.map((w) => [w.id, w]));
  const ds = new Map(plan.databases.map((d) => [d.id, d]));
  return [...wavePlan.waves].sort((a, b) => a.n - b.n).map((w) => {
    const items = w.groups.flatMap((g) => groups.get(g)?.items ?? []);
    const apps = new Set(w.groups.flatMap((g) => groups.get(g)?.apps ?? []));
    const workloads = items.filter((id) => ws.has(id));
    const databases = items.filter((id) => ds.has(id));
    const dataGib = workloads.reduce((s, id) => s + (ws.get(id)?.disksGib ?? []).reduce((a, b) => a + b, 0), 0)
      + databases.reduce((s, id) => s + (ds.get(id)?.sizeGib ?? 0), 0);
    return {
      n: w.n, name: w.name ?? `Wave ${w.n}`, kind: w.kind ?? 'app', groups: w.kind === 'exit' ? w.groups.length : w.groups.filter((g) => groups.has(g)).length,
      apps: apps.size, workloads: workloads.length, databases: databases.length, dataGib: Math.round(dataGib),
      ...(w.start ? { start: w.start } : {}), ...(w.end ? { end: w.end } : {}), ...(w.limitedBy ? { limitedBy: w.limitedBy } : {}),
    };
  });
}
