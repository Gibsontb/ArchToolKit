/**
 * A light index of the migration tracker, for the VMware Inventory page: each
 * VM's tracker state and wave, without loading the planner.
 *
 * It reads the raw records of the `plan` store (the plan under `current`, the
 * tracker under `tracker`) and imports nothing from `src/multicloud`: the
 * Inventory page stays small, and a test holds this file to that. The shapes
 * it reads are the planner's `Plan` and `Tracker` (addendum A.11.3), checked
 * field by field here rather than imported.
 *
 * Keyed by the workload's `sourceKey` (`vcenter|name`, lower-cased), with the
 * lower-cased VM name as a fallback key. Items that left the plan, and a
 * tracker that belongs to another plan, are not indexed.
 *
 * Null-safe: with no IndexedDB (or nothing stored) the index is empty.
 */

import { run } from './idb.ts';

/** The tracker's states, repeated from the planner's `ItemState` (a test keeps them equal). */
export const TRACKER_STATES = [
  'planned', 'prepared', 'replicating', 'in-sync', 'testing', 'tested', 'cutting-over', 'cut-over', 'validated', 'accepted', 'decommissioned',
] as const;
export type TrackerState = (typeof TRACKER_STATES)[number];

export interface TrackerIndexEntry {
  readonly state: TrackerState;
  readonly wave: number;
}
export type TrackerIndex = ReadonlyMap<string, TrackerIndexEntry>;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isState = (x: unknown): x is TrackerState => typeof x === 'string' && (TRACKER_STATES as readonly string[]).includes(x);

/** The index from the raw plan and tracker records (pure; the test seam). */
export function trackerIndexFrom(planRaw: unknown, trackerRaw: unknown): Map<string, TrackerIndexEntry> {
  const out = new Map<string, TrackerIndexEntry>();
  if (!isObj(planRaw) || !isObj(trackerRaw)) return out;
  if (trackerRaw.kind !== 'archtoolkit.migration-tracker' || trackerRaw.version !== 1) return out;
  if (typeof planRaw.id !== 'string' || trackerRaw.planId !== planRaw.id) return out;
  const items = isObj(trackerRaw.items) ? trackerRaw.items : {};
  const workloads = Array.isArray(planRaw.workloads) ? planRaw.workloads : [];
  const byName: [string, TrackerIndexEntry][] = [];
  for (const w of workloads) {
    if (!isObj(w) || typeof w.id !== 'string' || typeof w.name !== 'string') continue;
    const s = items[w.id];
    if (!isObj(s) || s.removed === true || !isState(s.state)) continue;
    const entry: TrackerIndexEntry = { state: s.state, wave: typeof s.wave === 'number' ? s.wave : 0 };
    if (typeof w.sourceKey === 'string' && w.sourceKey) out.set(w.sourceKey.toLowerCase(), entry);
    byName.push([w.name.toLowerCase(), entry]);
  }
  // Names are the fallback: never overwrite a sourceKey, nor the first of two same-named VMs.
  for (const [name, entry] of byName) if (!out.has(name)) out.set(name, entry);
  return out;
}

/** The lookup the Inventory page makes for a VM: its scoped key first, then its name. */
export function trackerEntryFor(index: TrackerIndex, vcenter: string | undefined, name: string): TrackerIndexEntry | undefined {
  return index.get(`${(vcenter ?? '').toLowerCase()}|${name}`.toLowerCase()) ?? index.get(name.toLowerCase());
}

/** The index of the stored tracker; empty when there is none. */
export async function loadTrackerIndex(): Promise<TrackerIndex> {
  const [plan, tracker] = await Promise.all([
    run<unknown>('plan', 'readonly', (store) => store.get('current')),
    run<unknown>('plan', 'readonly', (store) => store.get('tracker')),
  ]);
  return trackerIndexFrom(plan, tracker);
}
