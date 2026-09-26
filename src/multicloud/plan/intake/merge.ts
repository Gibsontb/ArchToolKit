/**
 * Bringing rows in again without losing what the user typed.
 *
 * Every grid row records, in `edited`, the columns a person set (by typing in
 * the grid, or by importing a CSV that filled them). A reload in merge mode
 * matches rows by name (case-insensitive): an edited cell keeps its value, and
 * every other cell takes the fresh one. Rows only in the plan stay; rows only
 * in the import are added at the end. Replace mode takes the import as it is.
 */

import { RPO_BY_CRITICALITY, RTO_BY_CRITICALITY } from '../options.ts';
import type { App, Database, MergeMode, Workload } from '../types.ts';
import { appsForNames, type IntakeResult } from './adapter.ts';

/** What `mergeRows` needs of a row. */
export interface MergeableRow {
  readonly id: string;
  readonly name: string;
  readonly edited?: readonly string[];
}

const keyOf = (row: MergeableRow): string => row.name.trim().toLowerCase();

/** Provenance: from the fresh import when it has it, else kept. */
const PROVENANCE = ['facts', 'sourceKey', 'portfolio'] as const;

function mergeOne<T extends MergeableRow>(existing: T, incoming: T): T {
  const kept = new Set<string>(existing.edited ?? []);
  const out: Record<string, unknown> = { ...(incoming as unknown as Record<string, unknown>) };
  const old = existing as unknown as Record<string, unknown>;
  for (const k of kept) {
    if (k in old && old[k] !== undefined) out[k] = old[k];
    else delete out[k];
  }
  out.id = existing.id;
  out.name = existing.name;
  for (const k of PROVENANCE) if (out[k] === undefined && old[k] !== undefined) out[k] = old[k];
  if (old.source !== undefined) out.source = old.source;
  // A confirmed (no longer inferred) database stays confirmed.
  if ('inferred' in old || 'inferred' in out) {
    if (old.inferred !== true) {
      if (old.inferred === undefined) delete out.inferred;
      else out.inferred = old.inferred;
    }
  }
  const edited = [...new Set([...(existing.edited ?? []), ...(incoming.edited ?? [])])];
  if (edited.length > 0) out.edited = edited;
  else delete out.edited;
  return out as unknown as T;
}

/**
 * Existing rows merged with incoming ones. `replace` returns the incoming rows;
 * `merge` keeps every existing row (with its edited cells) in its place,
 * refreshes the rest from the matching incoming row, and appends new rows.
 */
export function mergeRows<T extends MergeableRow>(existing: readonly T[], incoming: readonly T[], mode: MergeMode): T[] {
  if (mode === 'replace') return [...incoming];
  const fresh = new Map<string, T>();
  for (const row of incoming) if (!fresh.has(keyOf(row))) fresh.set(keyOf(row), row);
  const used = new Set<string>();
  const out: T[] = existing.map((row) => {
    const k = keyOf(row);
    const match = fresh.get(k);
    if (!match) return row;
    used.add(k);
    return mergeOne(row, match);
  });
  const present = new Set(existing.map(keyOf));
  for (const [k, row] of fresh) if (!used.has(k) && !present.has(k)) out.push(row);
  return out;
}

/**
 * A grid edit: the patch applied, its changed keys added to `edited`, and an
 * inferred database confirmed. A key patched to undefined is cleared.
 */
export function editRow<T extends MergeableRow>(row: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...(row as unknown as Record<string, unknown>) };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(patch as unknown as Record<string, unknown>)) {
    if (k === 'id' || k === 'edited') continue;
    if (JSON.stringify(out[k]) === JSON.stringify(v)) continue;
    changed.push(k);
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  if (changed.length === 0) return row;
  out.edited = [...new Set([...(row.edited ?? []), ...changed])];
  if (out.inferred === true) out.inferred = false;
  return out as unknown as T;
}

const isEdited = (row: { readonly edited?: readonly string[] }, key: string): boolean => (row.edited ?? []).includes(key);

/**
 * Screen 3's "Hosts" link: a workload named as a database host gets role db,
 * unless its role was edited.
 */
export function applyDbHostRoles(workloads: readonly Workload[], databases: readonly Database[]): Workload[] {
  const hosts = new Set(databases.flatMap((d) => d.hosts.map((h) => h.trim().toLowerCase())));
  return workloads.map((w): Workload => (w.role !== 'db' && hosts.has(w.name.toLowerCase()) && !isEdited(w, 'role') ? { ...w, role: 'db' } : w));
}

/**
 * Workloads inherit their app's criticality (and the RPO and RTO that follow
 * from it) unless those cells were edited.
 */
export function applyAppDefaults(workloads: readonly Workload[], apps: readonly App[]): Workload[] {
  const byName = new Map(apps.map((a) => [a.name.trim().toLowerCase(), a]));
  return workloads.map((w): Workload => {
    const app = byName.get(w.app.trim().toLowerCase());
    if (!app || isEdited(w, 'criticality') || w.criticality === app.criticality) return w;
    const c = app.criticality;
    return {
      ...w,
      criticality: c,
      ...(isEdited(w, 'rpo') ? {} : { rpo: RPO_BY_CRITICALITY[c] }),
      ...(isEdited(w, 'rto') ? {} : { rto: RTO_BY_CRITICALITY[c] }),
    };
  });
}

/** App rows for every app name on a workload or database that has none yet, appended. */
export function ensureApps(apps: readonly App[], workloads: readonly Workload[], databases: readonly Database[]): App[] {
  const have = new Set(apps.map((a) => a.name.trim().toLowerCase()));
  const missing = [...workloads.map((w) => w.app), ...databases.map((d) => d.app)].filter((n) => n.trim() && !have.has(n.trim().toLowerCase()));
  return [...apps, ...appsForNames(missing, 'manual')];
}

export interface IntakeRows {
  readonly workloads: readonly Workload[];
  readonly databases: readonly Database[];
  readonly apps: readonly App[];
}

/**
 * An intake result merged into the plan's rows: each list merged by name,
 * missing app rows added, database hosts marked, app criticality inherited.
 * In replace mode, a list the import did not fill is kept as it was (loading
 * the portfolio does not empty the Workloads screen).
 */
export function mergeIntake(current: IntakeRows, incoming: IntakeResult, mode: MergeMode): { workloads: Workload[]; databases: Database[]; apps: App[] } {
  const pick = <T extends MergeableRow>(have: readonly T[], got: readonly T[]): T[] =>
    mode === 'replace' && got.length === 0 ? [...have] : mergeRows(have, got, mode);
  const databases = pick(current.databases, incoming.databases);
  // Apps: an app from a richer source (the portfolio, a CSV) replaces the
  // estate's default row of the same name unless that row was edited.
  const apps0 = pick(current.apps, incoming.apps);
  const wl0 = pick(current.workloads, incoming.workloads);
  const apps = ensureApps(apps0, wl0, databases);
  const workloads = applyAppDefaults(applyDbHostRoles(wl0, databases), apps);
  return { workloads, databases, apps };
}
