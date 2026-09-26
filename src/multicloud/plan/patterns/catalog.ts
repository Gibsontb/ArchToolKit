/**
 * The pattern catalogue (addendum A.4.2): one entry per `AppPattern`, from the
 * family files, plus the lookups the app workspace uses — the default tier
 * pattern per component and platform, the ranked tier patterns for "Add from
 * patterns", the Terraform types a pattern builds, the honest-path set and
 * the facts the UI must flag.
 */

import type { AppPattern, Platform, TierPattern, WorkloadType } from '../types.ts';
import { APPLIANCE_PATTERNS } from './appliances.ts';
import { CONTAINER_PATTERNS } from './containers.ts';
import { FILE_PATTERNS } from './file.ts';
import { GREENFIELD_PATTERNS } from './greenfield.ts';
import { INFRA_PATTERNS } from './infra.ts';
import { LEGACY_PATTERNS } from './legacy.ts';
import { MICROSOFT_PATTERNS } from './microsoft.ts';
import { MIDDLEWARE_PATTERNS } from './middleware.ts';
import { isNone, isUnverified, type ComponentTemplate, type Fact, type PatternEntry, type PatternFamily } from './model.ts';
import { ORACLE_APP_PATTERNS } from './oracle-apps.ts';
import { SAP_PATTERNS } from './sap.ts';
import { tierAvailable, tierTarget, TIER_PATTERNS } from './tier-patterns.ts';
import { VDI_PATTERNS } from './vdi.ts';

export const GENERIC_PATTERN: PatternEntry = {
  id: 'generic',
  family: 'generic',
  kind: 'unknown',
  detectFrom: ['generic-windows', 'generic-linux', 'db-host', 'batch', 'unknown'],
  questions: [],
  rules: [],
  components: [
    { name: 'Servers', tier: 'app', tierPattern: 'vm', alternatives: ['vmware-service', 'containers', 'paas-web'] },
    { name: 'Databases', tier: 'data', workloadTypes: ['db-host'], tierPattern: 'managed-db', alternatives: ['vm'] },
  ],
  methods: ['aws-mgn', 'azure-migrate', 'gcp-m2vm', 'oci-ocm', 'hcx-bulk', 'rebuild'],
  artefacts: { ansibleModules: ['ansible.builtin.package', 'ansible.windows.win_feature'] },
  sizing: 'server',
  status: 'automated',
  facts: [],
};

const ALL: readonly PatternEntry[] = [
  GENERIC_PATTERN, ...SAP_PATTERNS, ...ORACLE_APP_PATTERNS, ...MICROSOFT_PATTERNS, ...VDI_PATTERNS, ...FILE_PATTERNS,
  ...MIDDLEWARE_PATTERNS, ...INFRA_PATTERNS, ...CONTAINER_PATTERNS, ...LEGACY_PATTERNS, ...APPLIANCE_PATTERNS, ...GREENFIELD_PATTERNS,
];

/** Every pattern, by id. */
export const PATTERN_CATALOG: Readonly<Record<AppPattern, PatternEntry>> = Object.freeze(
  Object.fromEntries(ALL.map((e) => [e.id, Object.freeze(e)])) as Record<AppPattern, PatternEntry>,
);

export const PATTERN_LIST: readonly PatternEntry[] = Object.freeze([...ALL]);

export const patternEntry = (id: AppPattern): PatternEntry => PATTERN_CATALOG[id];

export function patternsOfFamily(family: PatternFamily): PatternEntry[] {
  return ALL.filter((e) => e.family === family);
}

/** Patterns that are assessment + target recommendation + runbook only (A.4.8). */
export const HONEST_PATH_PATTERNS: readonly AppPattern[] = Object.freeze(ALL.filter((e) => e.status === 'honest-path').map((e) => e.id));

/** The patterns a workload type suggests, catalogue order. */
export function patternsForType(type: WorkloadType): AppPattern[] {
  return ALL.filter((e) => e.id !== 'generic' && e.family !== 'greenfield' && e.detectFrom.includes(type)).map((e) => e.id);
}

/**
 * A component's default tier pattern on a platform: its per-platform default,
 * else its own when the platform has it, else the first alternative the
 * platform has, else `vm`.
 */
export function defaultTierPattern(c: ComponentTemplate, platform: Platform): TierPattern {
  const own = c.perPlatform?.[platform];
  if (own) return own;
  if (tierAvailable(c.tierPattern, platform) || c.tierPattern === 'retire' || c.tierPattern === 'retain') return c.tierPattern;
  return (c.alternatives ?? []).find((a) => tierAvailable(a, platform)) ?? 'vm';
}

/** The Terraform types a pattern names on a platform: every component's tier patterns (default and alternatives) plus its extra artefacts. */
export function patternTerraformTypes(id: AppPattern, platform: Platform): string[] {
  const e = PATTERN_CATALOG[id];
  const out = new Set<string>();
  for (const c of e.components) {
    for (const tp of [defaultTierPattern(c, platform), c.tierPattern, ...(c.alternatives ?? [])]) {
      const o = tierTarget(tp, platform);
      if (!isNone(o)) for (const t of o.terraform) out.add(t);
    }
  }
  for (const t of e.artefacts.terraform?.[platform] ?? []) out.add(t);
  return [...out].sort();
}

export interface RankedTierPattern {
  readonly tierPattern: TierPattern;
  readonly score: number;
  /** Set when the tier pattern is ruled out on the platform: the reason. */
  readonly eliminated?: string;
  readonly reasons: readonly { readonly rule: string; readonly delta: number; readonly reason: string; readonly source: string; readonly verification: Fact['verification'] }[];
}

/**
 * The tier patterns offered for a component on a platform, best first
 * ("Add from patterns"): the default (+1), then the alternatives, scored by
 * the pattern's preferences; a tier pattern the platform lacks is eliminated
 * with the tier table's reason.
 */
export function rankTierPatterns(id: AppPattern, component: ComponentTemplate, platform: Platform, answers: Readonly<Record<string, string>> = {}): RankedTierPattern[] {
  const e = PATTERN_CATALOG[id];
  const def = defaultTierPattern(component, platform);
  const candidates = [...new Set<TierPattern>([def, component.tierPattern, ...(component.alternatives ?? [])])];
  const ranked = candidates.map((tp): RankedTierPattern => {
    const reasons: { rule: string; delta: number; reason: string; source: string; verification: Fact['verification'] }[] = [];
    let score = tp === def ? 1 : 0;
    let eliminated: string | undefined;
    const target = tierTarget(tp, platform);
    if (isNone(target) && tp !== 'retire' && tp !== 'retain') eliminated = target.none;
    for (const pref of e.preferences ?? []) {
      if (pref.tierPattern !== tp) continue;
      if (pref.platforms && !pref.platforms.includes(platform)) continue;
      if (pref.when && !pref.when.values.includes(answers[pref.when.key] ?? e.questions.find((q) => q.key === pref.when!.key)?.default ?? '')) continue;
      if (pref.eliminate) eliminated ??= pref.reason;
      else score += pref.delta;
      reasons.push({ rule: pref.rule, delta: pref.eliminate ? 0 : pref.delta, reason: pref.reason, source: pref.source, verification: pref.verification });
    }
    return { tierPattern: tp, score, ...(eliminated ? { eliminated } : {}), reasons };
  });
  return ranked.sort((a, b) => (!!a.eliminated === !!b.eliminated ? b.score - a.score : a.eliminated ? 1 : -1));
}

/** Every fact in the catalogue (patterns and tier patterns) with where it sits, for the UI and the audit test. */
export function allFacts(): { readonly where: string; readonly fact: Fact }[] {
  const out: { where: string; fact: Fact }[] = [];
  for (const e of ALL) for (const f of e.facts) out.push({ where: `pattern:${e.id}`, fact: f });
  for (const info of Object.values(TIER_PATTERNS)) for (const f of info.facts) out.push({ where: `tier:${info.id}`, fact: f });
  return out;
}

/** The facts the UI flags: not verified from the vendor's own documentation ([U] / [C]). */
export function flaggedFacts(): { readonly where: string; readonly fact: Fact }[] {
  return allFacts().filter((x) => isUnverified(x.fact));
}
