/**
 * The estate step: which platforms, at most `maxPlatforms` of them, carry the
 * whole plan best once each platform's running cost is counted.
 *
 * An item is scored as a unit: a workload on its own, or a database together
 * with the VMs that host it (they cannot land apart). For every subset S of
 * the allowed platforms (at most 31), the score is the sum of each unit's best
 * surviving score inside S, minus an overhead per platform for a second (or
 * third) set of guardrails, skills and contracts. A unit with nothing
 * surviving in S counts -20 per item.
 *
 * Pins force their platform into the subset. When there are more pinned
 * platforms than `maxPlatforms`, the pins win and the finding says so.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { PLATFORMS, platformInfo, type Platform } from '../../platforms.ts';
import { DB_SERVICES } from '../db-catalog.ts';
import { platformOfService } from '../options.ts';
import type { DbServiceId, ItemId, Option, Plan, Workload } from '../types.ts';
import type { ItemEvaluation, RuleContext } from './engine.ts';

/** Per item with nothing surviving in the subset. */
export const UNPLACED_PENALTY = 20;
export const BASE_OVERHEAD = 10;
export const OVERHEAD_FLOOR = 2;

export interface Unit {
  /** The lead item's id (the database, for a database group). */
  readonly key: string;
  /** Every item in the unit, lead first. */
  readonly members: readonly ItemId[];
  /** Host workload ids, for a database group. */
  readonly hosts: readonly ItemId[];
  /** Item names, for resolving dependency edges. */
  readonly names: readonly string[];
  readonly apps: readonly string[];
  readonly pin?: Platform;
  readonly pinSource?: 'pin' | 'service' | 'retain';
  /** Best score per platform (PLATFORMS order); -Infinity when nothing survives there. */
  readonly scores: readonly number[];
  /** For a database group: the service that scored best on each platform. */
  readonly choice: ReadonlyMap<Platform, { readonly service?: DbServiceId }>;
  /** Unconstrained best platform. */
  readonly best?: Platform;
}

export interface Assignment {
  readonly platform: Map<string, Platform>;
  /** Units moved by the affinity pass. */
  readonly affinity: Set<string>;
}

export interface SubsetResult {
  readonly platforms: readonly Platform[];
  readonly scores: readonly { readonly platforms: readonly Platform[]; readonly score: number }[];
}

const IDX = (p: Platform): number => PLATFORMS.indexOf(p);

function argmax(scores: readonly number[], among: readonly Platform[]): Platform | undefined {
  let best: Platform | undefined;
  let bestScore = -Infinity;
  for (const p of PLATFORMS) {
    if (!among.includes(p)) continue;
    const s = scores[IDX(p)]!;
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return best;
}

function optionOn(options: readonly Option[], platform: Platform): Option | undefined {
  return options.find((o) => o.platform === platform);
}

/** Units for every item that is placed (not retired or repurchased), with pins resolved. */
export function buildUnits(plan: Plan, ctx: RuleContext, evals: ReadonlyMap<ItemId, ItemEvaluation>, findings: Finding[]): Unit[] {
  const allowed = ctx.requirements.allowed;
  const units: Unit[] = [];
  const grouped = new Set<ItemId>();
  const retainPlatform: Platform | undefined = allowed.includes('vmware') ? 'vmware' : undefined;
  const outOfScope: string[] = [];
  const pinNotAllowed: string[] = [];

  const checkPin = (name: string, pin: Platform | undefined): Platform | undefined => {
    if (!pin) return undefined;
    if (allowed.includes(pin)) return pin;
    pinNotAllowed.push(`${name} (${platformInfo(pin).shortLabel})`);
    return undefined;
  };

  for (const db of plan.databases) {
    const ev = evals.get(db.id);
    if (!ev) continue;
    const route = ctx.dbRouteOf(db);
    const hosts = ctx.hostsOf(db);
    if (route === 'retire' || route === 'repurchase') continue;
    if (hosts.length > 0 && hosts.every((h) => ctx.placementOf(h).disposition === 'retire')) continue;
    let pin: Platform | undefined;
    let pinSource: Unit['pinSource'];
    let pinService: DbServiceId | undefined;
    if (route === 'retain') {
      if (!retainPlatform) {
        outOfScope.push(db.name);
        continue;
      }
      pin = retainPlatform;
      pinSource = 'retain';
      pinService = 'vmware-vm';
    } else if (db.pinService) {
      pin = checkPin(db.name, platformOfService(db.pinService));
      if (pin) {
        pinSource = 'service';
        pinService = db.pinService;
      }
    }
    const hostWorkloads: Workload[] = [];
    if (route !== 'retain') {
      for (const h of hosts) {
        if (grouped.has(h.id)) continue;
        const d = ctx.placementOf(h).disposition;
        if (d === 'retire' || d === 'repurchase' || d === 'retain') continue;
        hostWorkloads.push(h);
      }
    }
    if (!pin) {
      for (const h of hostWorkloads) {
        const hp = checkPin(h.name, h.pin);
        if (hp) {
          pin = hp;
          pinSource = 'pin';
          break;
        }
      }
    }
    for (const h of hostWorkloads) grouped.add(h.id);
    const hostOptions = hostWorkloads.map((h) => evals.get(h.id)?.options ?? []);
    const scores: number[] = [];
    const choice = new Map<Platform, { service?: DbServiceId }>();
    for (const p of PLATFORMS) {
      let best = -Infinity;
      let svc: DbServiceId | undefined;
      if (!pin || pin === p) {
        for (const o of ev.options) {
          if (o.platform !== p || !o.service) continue;
          if (pinService && o.service !== pinService) continue;
          if (o.eliminated && !pinService) continue;
          const managed = DB_SERVICES[o.service].managed;
          let s = o.score;
          let ok = true;
          for (const opts of hostOptions) {
            const ho = optionOn(opts, p);
            if (!ho || ho.eliminated) {
              if (!managed && !pin) {
                ok = false;
                break;
              }
            } else s += ho.score;
          }
          if (ok && s > best) {
            best = s;
            svc = o.service;
          }
        }
      }
      scores.push(best);
      if (svc) choice.set(p, { service: svc });
    }
    const best = argmax(scores, PLATFORMS);
    units.push({
      key: db.id,
      members: [db.id, ...hostWorkloads.map((h) => h.id)],
      hosts: hostWorkloads.map((h) => h.id),
      names: [db.name, ...hostWorkloads.map((h) => h.name)],
      apps: [...new Set([db.app, ...hostWorkloads.map((h) => h.app)].filter((a) => a !== ''))],
      ...(pin ? { pin, pinSource } : {}),
      scores,
      choice,
      ...(best ? { best } : {}),
    });
  }

  for (const w of plan.workloads) {
    if (grouped.has(w.id)) continue;
    const ev = evals.get(w.id);
    if (!ev) continue;
    const d = ctx.placementOf(w).disposition;
    if (d === 'retire' || d === 'repurchase') continue;
    let pin: Platform | undefined;
    let pinSource: Unit['pinSource'];
    if (d === 'retain') {
      if (!retainPlatform) {
        outOfScope.push(w.name);
        continue;
      }
      pin = retainPlatform;
      pinSource = 'retain';
    } else {
      pin = checkPin(w.name, w.pin);
      if (pin) pinSource = 'pin';
    }
    const scores = PLATFORMS.map((p) => {
      const o = optionOn(ev.options, p);
      if (!o) return -Infinity;
      if (pin) return p === pin ? o.score : -Infinity;
      return o.eliminated ? -Infinity : o.score;
    });
    const best = argmax(scores, PLATFORMS);
    units.push({
      key: w.id,
      members: [w.id],
      hosts: [],
      names: [w.name],
      apps: w.app ? [w.app] : [],
      ...(pin ? { pin, pinSource } : {}),
      scores,
      choice: new Map(),
      ...(best ? { best } : {}),
    });
  }

  if (outOfScope.length > 0) {
    findings.push(warning('plan.retain.out-of-scope', `${outOfScope.length} retained item(s) cannot stay on VMware because VMware is not an allowed platform: ${outOfScope.slice(0, 10).join(', ')}${outOfScope.length > 10 ? ', …' : ''}.`, {
      remediation: 'Allow VMware, or give these items another route.',
    }));
  }
  if (pinNotAllowed.length > 0) {
    findings.push(warning('plan.pin.not-allowed', `${pinNotAllowed.length} pin(s) name a platform policy does not allow, so they were ignored: ${pinNotAllowed.slice(0, 10).join(', ')}${pinNotAllowed.length > 10 ? ', …' : ''}.`, {
      remediation: 'Allow the platform, or change the pin.',
    }));
  }
  return units;
}

/** The running cost of one more platform: 10, less 5 for a commitment, less 3 (strong) or 1 (some) for skills; at least 2. VCF is 2 when the estate already runs on it. */
export function overheadOf(p: Platform, ctx: RuleContext): number {
  const req = ctx.requirements;
  if (p === 'vmware' && ctx.plan.workloads.some((w) => w.source === 'estate')) return OVERHEAD_FLOOR;
  let o = BASE_OVERHEAD;
  if (req.commitments.some((c) => c.platform === p)) o -= 5;
  const skill = req.skills[p];
  if (skill === 'strong') o -= 3;
  else if (skill === 'some') o -= 1;
  return Math.max(OVERHEAD_FLOOR, o);
}

function compareSubsets(a: { platforms: readonly Platform[]; score: number }, b: { platforms: readonly Platform[]; score: number }): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.platforms.length !== b.platforms.length) return a.platforms.length - b.platforms.length;
  for (let i = 0; i < a.platforms.length; i += 1) {
    const d = IDX(a.platforms[i]!) - IDX(b.platforms[i]!);
    if (d !== 0) return d;
  }
  return 0;
}

const label = (ps: readonly Platform[]): string => ps.map((p) => platformInfo(p).shortLabel).join(' + ');

/** Step 4: every subset scored, the best chosen. */
export function chooseSubset(units: readonly Unit[], ctx: RuleContext, findings: Finding[]): SubsetResult {
  const req = ctx.requirements;
  const allowed = PLATFORMS.filter((p) => req.allowed.includes(p));
  if (allowed.length === 0) {
    findings.push(warning('multicloud.no-platform', 'Every platform was ruled out, so the constraints as stated cannot all be met.', {
      remediation: 'Allow at least one platform.',
    }));
    return { platforms: [], scores: [] };
  }
  const forced = PLATFORMS.filter((p) => units.some((u) => u.pin === p));
  const max = req.maxPlatforms;
  let candidates: Platform[][];
  if (forced.length > max) {
    findings.push(warning('plan.pins-exceed-max', `Pins and retained items need ${forced.length} platforms (${label(forced)}), more than the maximum of ${max}: the pins win.`, {
      path: 'requirements.maxPlatforms',
      remediation: `Raise the maximum to ${forced.length}, or remove pins on the platforms you do not want.`,
    }));
    candidates = [forced];
  } else {
    candidates = [];
    const n = allowed.length;
    for (let mask = 1; mask < 1 << n; mask += 1) {
      const set = allowed.filter((_, i) => (mask & (1 << i)) !== 0);
      if (set.length > max) continue;
      if (!forced.every((p) => set.includes(p))) continue;
      candidates.push(set);
    }
  }

  const overhead = new Map<Platform, number>(PLATFORMS.map((p) => [p, overheadOf(p, ctx)]));
  const items = units.reduce((n, u) => n + u.members.length, 0);
  const scored = candidates.map((set) => {
    const idx = set.map(IDX);
    let score = 0;
    for (const u of units) {
      let best = -Infinity;
      for (const i of idx) {
        const s = u.scores[i]!;
        if (s > best) best = s;
      }
      score += best === -Infinity ? -UNPLACED_PENALTY * u.members.length : best;
    }
    for (const p of set) score -= overhead.get(p)!;
    return { platforms: set, score };
  });
  scored.sort(compareSubsets);
  const winner = scored[0]!;
  const runner = scored[1];
  if (runner && winner.score - runner.score < (2 * Math.max(1, items)) / 100) {
    findings.push(info('plan.too-close-to-call', `${label(winner.platforms)} and ${label(runner.platforms)} score within ${(winner.score - runner.score).toFixed(1)} points for ${items} item(s), which is not a difference these rules can resolve.`, {
      remediation: 'Decide on price, on the commercial relationship, or on where the team would rather be in three years.',
      source: 'ArchToolKit',
    }));
  }
  const stranded = units.filter((u) => winner.platforms.every((p) => u.scores[IDX(p)] === -Infinity));
  if (stranded.length > 0) {
    findings.push(warning('plan.subset.unplaced', `${stranded.reduce((n, u) => n + u.members.length, 0)} item(s) have no surviving option on ${label(winner.platforms)} (counted at -${UNPLACED_PENALTY} each).`, {
      remediation: 'Open their what-if to see what ruled each platform out, or allow another platform.',
    }));
  }
  return { platforms: winner.platforms, scores: scored };
}

/** Step 5: each unit takes its best surviving platform inside the subset (a pin always wins). */
export function assignUnits(units: readonly Unit[], platforms: readonly Platform[]): Assignment {
  const platform = new Map<string, Platform>();
  for (const u of units) {
    if (u.pin && platforms.includes(u.pin)) {
      platform.set(u.key, u.pin);
      continue;
    }
    const p = argmax(u.scores, platforms);
    if (p) platform.set(u.key, p);
  }
  return { platform, affinity: new Set() };
}

