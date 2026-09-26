/**
 * The affinity pass: things that talk synchronously should land together.
 *
 * After assignment, for every synchronous dependency (and every app) whose
 * ends landed on different platforms, move the smaller side onto the other's
 * platform when the score it gives up is at most 2 per item. Pinned items do
 * not move, a move must stay inside the chosen subset and on a surviving
 * option, and the pass repeats until nothing changes (three passes at most).
 *
 * Edges to `site:*` add nothing here: the latency rules already scored them.
 */

import { PLATFORMS, platformInfo, type Platform } from '../../platforms.ts';
import type { DependencyEdge, Plan } from '../types.ts';
import type { Assignment, Unit } from './estate.ts';

/** The most a moved item may lose, per item. */
export const AFFINITY_MAX_LOSS = 2;
export const AFFINITY_PASSES = 3;

const IDX = (p: Platform): number => PLATFORMS.indexOf(p);

/** plan.edges, plus each workload's "Depends on" as a sync edge where no explicit edge says otherwise. */
export function dependencyEdges(plan: Plan): DependencyEdge[] {
  const seen = new Set(plan.edges.map((e) => `${e.from}\u0000${e.to}`));
  const out: DependencyEdge[] = [...plan.edges];
  for (const w of plan.workloads) {
    for (const to of w.dependsOn) {
      const key = `${w.name}\u0000${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: w.name, to, kind: 'sync' });
    }
  }
  return out;
}

/**
 * Moves units in `assignment` (and marks them in `assignment.affinity`).
 * Returns the reason per moved unit key.
 */
export function affinityPass(plan: Plan, units: readonly Unit[], assignment: Assignment, platforms: readonly Platform[]): Map<string, string> {
  const notes = new Map<string, string>();
  if (platforms.length < 2) return notes;
  const byName = new Map<string, Unit>();
  const byApp = new Map<string, Unit[]>();
  for (const u of units) {
    for (const n of u.names) if (!byName.has(n)) byName.set(n, u);
    for (const a of u.apps) {
      const list = byApp.get(a) ?? [];
      list.push(u);
      byApp.set(a, list);
    }
  }
  const resolve = (name: string): Unit[] => {
    if (name.startsWith('site:')) return [];
    const u = byName.get(name);
    if (u) return [u];
    return byApp.get(name) ?? [];
  };
  const size = (us: readonly Unit[]): number => us.reduce((n, u) => n + u.members.length, 0);
  const scoreOn = (u: Unit, p: Platform): number => u.scores[IDX(p)]!;

  const tryMove = (side: readonly Unit[], target: Platform, why: string): boolean => {
    let loss = 0;
    const moving = side.filter((u) => assignment.platform.get(u.key) !== target);
    if (moving.length === 0) return false;
    for (const u of moving) {
      if (u.pin) return false;
      const to = scoreOn(u, target);
      if (to === -Infinity) return false;
      const from = assignment.platform.get(u.key);
      loss += (from ? scoreOn(u, from) : -Infinity) - to;
    }
    if (loss > AFFINITY_MAX_LOSS * size(moving)) return false;
    for (const u of moving) {
      assignment.platform.set(u.key, target);
      assignment.affinity.add(u.key);
      notes.set(u.key, why);
    }
    return true;
  };

  const edges = dependencyEdges(plan).filter((e) => e.kind === 'sync');
  for (let pass = 0; pass < AFFINITY_PASSES; pass += 1) {
    let changed = false;

    for (const e of edges) {
      const a = resolve(e.from).filter((u) => assignment.platform.has(u.key));
      const b = resolve(e.to).filter((u) => assignment.platform.has(u.key));
      if (a.length === 0 || b.length === 0) continue;
      const pa = new Set(a.map((u) => assignment.platform.get(u.key)!));
      const pb = new Set(b.map((u) => assignment.platform.get(u.key)!));
      if (pa.size !== 1 || pb.size !== 1) continue;
      const [ta] = pa;
      const [tb] = pb;
      if (ta === tb || !ta || !tb) continue;
      const why = `keeps ${e.from} and ${e.to} on one platform; the dependency is synchronous.`;
      const order: [Unit[], Platform][] = size(a) <= size(b) ? [[a, tb], [b, ta]] : [[b, ta], [a, tb]];
      for (const [side, target] of order) {
        if (tryMove(side, target, `${why} Moved to ${platformInfo(target).shortLabel}.`)) {
          changed = true;
          break;
        }
      }
    }

    for (const [app, members] of byApp) {
      const placed = members.filter((u) => assignment.platform.has(u.key));
      const count = new Map<Platform, number>();
      for (const u of placed) {
        const p = assignment.platform.get(u.key)!;
        count.set(p, (count.get(p) ?? 0) + u.members.length);
      }
      if (count.size < 2) continue;
      let target: Platform | undefined;
      let most = -1;
      for (const p of PLATFORMS) {
        const c = count.get(p) ?? 0;
        if (c > most) {
          most = c;
          target = p;
        }
      }
      if (!target) continue;
      for (const u of placed) {
        if (assignment.platform.get(u.key) === target) continue;
        if (tryMove([u], target, `keeps the app ${app} on one platform (${platformInfo(target).shortLabel}).`)) changed = true;
      }
    }

    if (!changed) break;
  }
  return notes;
}
