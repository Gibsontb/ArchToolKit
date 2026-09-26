/**
 * What if: one item's every option in full, and the estate re-decided under a
 * changed requirement, as a diff with the reasons and the licence delta.
 */

import type { Platform } from '../../platforms.ts';
import type {
  ItemDecision, ItemId, LicenceKind, LicenceTotals, Option, Plan, PlanDecision, RequirementsPatch, RuleHit,
} from '../types.ts';
import { createContext, decidePlan, evaluateItem, type EngineOptions } from './engine.ts';

/** Every option of one item, best first, with hits and licence. Empty when the id is unknown. */
export function whatIfItem(plan: Plan, id: ItemId, options: EngineOptions = {}): readonly Option[] {
  const item = plan.workloads.find((w) => w.id === id) ?? plan.databases.find((d) => d.id === id);
  if (!item) return [];
  return evaluateItem(item, createContext(plan, options), options.rules).options;
}

export interface EstateMove {
  readonly id: ItemId;
  readonly from?: Option;
  readonly to?: Option;
  /** Rules that no longer apply to the old choice (delta negated), then rules that favour the new one. */
  readonly why: readonly RuleHit[];
}

export interface EstateWhatIf {
  readonly before: PlanDecision;
  readonly after: PlanDecision;
  readonly moves: readonly EstateMove[];
  /** after minus before, per platform and licence kind; zero entries left out. */
  readonly licenceDelta: LicenceTotals;
}

/** Licence counts of every chosen option, per platform and kind. */
export function licenceTotals(decision: PlanDecision): LicenceTotals {
  const out: Partial<Record<Platform, Partial<Record<LicenceKind, number>>>> = {};
  for (const d of Object.values(decision.items)) {
    const l = d.chosen?.licence;
    if (!d.chosen || !l || l.kind === 'none' || l.count === 0) continue;
    const row = (out[d.chosen.platform] ??= {});
    row[l.kind] = (row[l.kind] ?? 0) + l.count;
  }
  return out;
}

function diffTotals(before: LicenceTotals, after: LicenceTotals): LicenceTotals {
  const out: Partial<Record<Platform, Partial<Record<LicenceKind, number>>>> = {};
  const platforms = new Set([...Object.keys(before), ...Object.keys(after)] as Platform[]);
  for (const p of platforms) {
    const kinds = new Set([...Object.keys(before[p] ?? {}), ...Object.keys(after[p] ?? {})] as LicenceKind[]);
    for (const k of kinds) {
      const d = (after[p]?.[k] ?? 0) - (before[p]?.[k] ?? 0);
      if (d === 0) continue;
      (out[p] ??= {})[k] = d;
    }
  }
  return out;
}

const same = (a: Option | undefined, b: Option | undefined): boolean =>
  a?.platform === b?.platform && a?.service === b?.service;

const matching = (d: ItemDecision | undefined, o: Option | undefined): Option | undefined =>
  o ? d?.options.find((x) => x.platform === o.platform && x.service === o.service) : undefined;

const hitKey = (h: RuleHit): string => `${h.rule}\u0000${h.delta}`;

function why(before: ItemDecision, after: ItemDecision): RuleHit[] {
  const out: RuleHit[] = [];
  const from = before.chosen;
  const to = after.chosen;
  const fromNow = matching(after, from);
  if (from) {
    const still = new Set((fromNow?.hits ?? []).map(hitKey));
    for (const h of from.hits) {
      if (!still.has(hitKey(h)) && h.delta !== 0) out.push({ ...h, delta: -h.delta, reason: `No longer applies: ${h.reason}` });
    }
    if (fromNow?.eliminated) {
      const e = fromNow.hits.find((h) => h.rule === fromNow.eliminated);
      if (e) out.push(e);
    }
  }
  if (to) {
    const had = new Set((matching(before, to)?.hits ?? []).map(hitKey));
    for (const h of to.hits) if (!had.has(hitKey(h)) && h.delta !== 0) out.push(h);
  }
  if (out.length === 0 && after.snapped) {
    out.push({ rule: after.snapped.rule, delta: 0, reason: 'The platform set changed, and this item moved with it.', verification: 'I' });
  }
  return out;
}

/** Re-decide with `patch` applied to the requirements, and diff. */
export function whatIfEstate(plan: Plan, patch: RequirementsPatch, options: EngineOptions = {}): EstateWhatIf {
  const before = decidePlan(plan, options);
  const after = decidePlan({ ...plan, requirements: { ...plan.requirements, ...patch } }, options);
  const moves: EstateMove[] = [];
  for (const id of Object.keys(after.items)) {
    const b = before.items[id];
    const a = after.items[id];
    if (!b || !a || same(b.chosen, a.chosen)) continue;
    moves.push({ id, ...(b.chosen ? { from: b.chosen } : {}), ...(a.chosen ? { to: a.chosen } : {}), why: why(b, a) });
  }
  return { before, after, moves, licenceDelta: diffTotals(licenceTotals(before), licenceTotals(after)) };
}
