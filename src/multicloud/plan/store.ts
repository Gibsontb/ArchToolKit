/**
 * Where the plan lives: one record in IndexedDB (store `plan`, key `current`),
 * and a settings file the user can save and load.
 *
 * "No footprints": the plan is kept only here, and `forgetPlan` (the page's
 * "Forget this plan") and Clear all both remove it. The file carries no user
 * name, machine name or path; its `savedAt` is the one date in it, and the
 * generated zip reuses that date so a re-generation is byte-identical.
 *
 * Every call is safe where IndexedDB is missing (tests, locked-down browsers):
 * a load resolves to null and a save to false.
 */

import { run } from '../../kit/idb.ts';
import { openEnvelope, stripSecrets, SETTINGS_KINDS, type SettingsEnvelope } from '../../kit/settings-file.ts';
import { isRecord, type Json } from '../../editor/doc.ts';
import { DEFAULT_WAVE_SETTINGS, defaultRequirements } from './options.ts';
import { PLAN_KIND, type Plan, type Requirements } from './types.ts';

export const PLAN_STORE = 'plan' as const;
export const PLAN_KEY = 'current';
export const DEFAULT_PLAN_NAME = 'Migration plan';

/** A random id: `crypto.randomUUID()` where the browser has it (a secure context), else v4 from getRandomValues. */
export function newPlanId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A new plan with nothing in it and the default requirements. */
export function emptyPlan(name: string = DEFAULT_PLAN_NAME, savedAt: string = new Date().toISOString()): Plan {
  return {
    kind: PLAN_KIND,
    version: 1,
    id: newPlanId(),
    name: name.trim() || DEFAULT_PLAN_NAME,
    savedAt,
    workloads: [],
    databases: [],
    apps: [],
    edges: [],
    requirements: defaultRequirements(),
    designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
  };
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

/** The stored plan, or null when there is none (or it is not a plan this build reads). */
export async function loadPlan(): Promise<Plan | null> {
  const value = await run<unknown>(PLAN_STORE, 'readonly', (store) => store.get(PLAN_KEY));
  if (value === null || value === undefined) return null;
  const read = planFromEnvelope(value as Json);
  return 'ok' in read ? read.ok : null;
}

/** Keep the plan. Resolves false when the browser will not. */
export async function savePlan(plan: Plan): Promise<boolean> {
  const ok = await run(PLAN_STORE, 'readwrite', (store) => store.put(planEnvelope(plan), PLAN_KEY));
  return ok !== null;
}

/** Delete the stored plan. */
export async function forgetPlan(): Promise<void> {
  await run(PLAN_STORE, 'readwrite', (store) => store.delete(PLAN_KEY));
}

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

/**
 * The plan as a settings envelope (`archtoolkit.multicloud-plan`, version 1).
 * The plan already carries kind, version and savedAt, so the envelope is the
 * plan as plain JSON, with any secret-named field removed for good measure.
 */
export function planEnvelope(plan: Plan): SettingsEnvelope {
  const json = JSON.parse(JSON.stringify(plan)) as Json;
  return stripSecrets(json) as unknown as SettingsEnvelope;
}

/**
 * A plan from a loaded file (or the stored record). Fields a newer or older
 * build left out come back as their defaults, so an old file still opens; a
 * file from another page, or a different plan version, is an error sentence.
 */
export function planFromEnvelope(value: Json): { ok: Plan } | { error: string } {
  const opened = openEnvelope(value, PLAN_KIND, SETTINGS_KINDS);
  if ('error' in opened) return opened;
  const v = opened.ok;
  if (v.version !== 1) return { error: `That plan was saved by a different version of the planner (version ${String(v.version)}).` };

  const arr = <T>(x: Json | undefined): T[] => (Array.isArray(x) ? (x as unknown as T[]) : []);
  const rec = (x: Json | undefined): Record<string, Json> => (isRecord(x) ? x : {});
  const str = (x: Json | undefined, fallback: string): string => (typeof x === 'string' ? x : fallback);

  const defaults = defaultRequirements();
  const r = rec(v.requirements);
  const requirements: Requirements = {
    ...defaults,
    ...(r as unknown as Partial<Requirements>),
    identity: { ...defaults.identity, ...(rec(r.identity) as unknown as Partial<Requirements['identity']>) },
    licensing: { ...defaults.licensing, ...(rec(r.licensing) as unknown as Partial<Requirements['licensing']>) },
    drPattern: { ...defaults.drPattern, ...(rec(r.drPattern) as unknown as Partial<Requirements['drPattern']>) },
    regions: isRecord(r.regions) ? (r.regions as unknown as Requirements['regions']) : defaults.regions,
    skills: isRecord(r.skills) ? (r.skills as unknown as Requirements['skills']) : defaults.skills,
  };
  const w = rec(v.waveSettings);

  const plan: Plan = {
    kind: PLAN_KIND,
    version: 1,
    id: str(v.id, '') || newPlanId(),
    name: str(v.name, DEFAULT_PLAN_NAME),
    savedAt: str(v.savedAt, new Date().toISOString()),
    workloads: arr(v.workloads),
    databases: arr(v.databases),
    apps: arr(v.apps),
    edges: arr(v.edges),
    requirements,
    ...(isRecord(v.decision) ? { decision: v.decision as unknown as NonNullable<Plan['decision']> } : {}),
    designOverrides: rec(v.designOverrides) as unknown as Plan['designOverrides'],
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, ...(w as unknown as Partial<Plan['waveSettings']>), freezes: arr(w.freezes) },
    ...(isRecord(v.intake) ? { intake: v.intake as unknown as NonNullable<Plan['intake']> } : {}),
    ...(isRecord(v.generate) ? { generate: v.generate as unknown as NonNullable<Plan['generate']> } : {}),
  };
  return { ok: plan };
}
