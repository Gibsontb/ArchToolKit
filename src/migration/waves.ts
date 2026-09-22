/**
 * Which wave an application goes in.
 *
 * Waves are triage, not a schedule: they sort a portfolio into "do these
 * first", "these are the body of the work", "these need more than a
 * migration" and "these cannot move yet". Three planning modes are offered
 * because the first wave means different things to different programmes — a
 * data-centre exit wants the easy movers out early, a modernisation
 * programme wants the applications that will benefit most.
 *
 * Wave 0 is the landing zone itself: identity, network, logging, guardrails
 * and tooling. It is not an application, so nothing is ever placed in it;
 * it is listed so the plan says out loud that it comes first.
 *
 * Ported from the previous toolkit's portfolio dashboard, rules unchanged.
 */

import type { Risk, Route } from './types.ts';

export type Wave = 'Wave 1' | 'Wave 2' | 'Wave 3' | 'Blocked';
export type WaveMode = 'default' | 'fast' | 'modernize';

export const WAVE_MODES: readonly { readonly id: WaveMode; readonly label: string; readonly description: string }[] = [
  { id: 'default', label: 'Default — risk and readiness', description: 'The low-risk, ready applications go first, whatever their route.' },
  { id: 'fast', label: 'Fast exit — rehost and replatform early', description: 'For a data-centre exit: move the straightforward ones out first and improve them later.' },
  { id: 'modernize', label: 'Modernise first — refactor early', description: 'For a modernisation programme: the applications that gain most from a rewrite go first.' },
];

export const WAVE_MEANING: Readonly<Record<Wave | 'Wave 0', string>> = {
  'Wave 0': 'Foundations, before any application moves: landing zone, identity, network, logging, guardrails, tooling.',
  'Wave 1': 'Quick wins — low risk, ready to go, or an outcome that removes footprint immediately.',
  'Wave 2': 'The body of the work — the core migrations, once the first wave has proven the pattern.',
  'Wave 3': 'The long tail — high risk or heavy modernisation, planned with its own discovery.',
  Blocked: 'Cannot move yet. Something has to change first: a policy, a contract, hardware or a dependency.',
};

const riskScore = (risk: Risk): number => (risk === 'High' ? 3 : risk === 'Medium' ? 2 : 1);

/** The wave, and the sentence that explains it. */
export function wavePlan(route: Route, readiness: number, risk: Risk, mode: WaveMode = 'default'): { wave: Wave; rationale: string } {
  if (route === 'Retain') return { wave: 'Blocked', rationale: 'A policy, hardware or vendor constraint blocks a move for now.' };
  if (route === 'Retire' || route === 'Repurchase') {
    return { wave: 'Wave 1', rationale: 'Retiring or replacing it removes footprint straight away, so it goes early.' };
  }

  const score = riskScore(risk);

  if (mode === 'fast') {
    if (route === 'Rehost' && score <= 2) return { wave: 'Wave 1', rationale: 'Fast exit: a manageable rehost, so move it early and harden it afterwards.' };
    if (route === 'Replatform' && score <= 2) return { wave: 'Wave 1', rationale: 'Fast exit: a manageable replatform, so move it early.' };
  }
  if (mode === 'modernize' && route === 'Refactor' && score <= 2 && readiness >= 70) {
    return { wave: 'Wave 1', rationale: `Modernise first: readiness ${readiness} and ${risk.toLowerCase()} risk, so it gains most from going early.` };
  }

  if (score === 1 && readiness >= 55) return { wave: 'Wave 1', rationale: `Low risk and readiness ${readiness}: a quick win.` };
  if (score <= 2 && readiness >= 40) return { wave: 'Wave 2', rationale: `${risk} risk and readiness ${readiness}: the core migration band.` };
  return { wave: 'Wave 3', rationale: `${risk} risk and readiness ${readiness}: the long tail, with its own discovery first.` };
}

export interface WaveCounts {
  readonly total: number;
  readonly wave1: number;
  readonly wave2: number;
  readonly wave3: number;
  readonly blocked: number;
}

export function countWaves(waves: readonly Wave[]): WaveCounts {
  const count = (w: Wave) => waves.filter((x) => x === w).length;
  return { total: waves.length, wave1: count('Wave 1'), wave2: count('Wave 2'), wave3: count('Wave 3'), blocked: count('Blocked') };
}
