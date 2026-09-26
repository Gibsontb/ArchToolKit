/**
 * The pattern model (addendum A.4.1): what a catalogue entry states, the
 * sourced facts it rests on, and the small helpers the pattern rules use to
 * find an item's app, app plan, answers and tier pattern.
 *
 * Every fact carries a source URL and a verification tag. `V-DOC` was read
 * from the vendor's own page; `C` is a community or secondary source; `I` is
 * inferred or recalled and not re-read — the UI shows it as "[U]" (unverified)
 * through `verificationBadge`.
 *
 * No behaviour beyond lookups lives here, and nothing here imports a family
 * file, so every family can import it without a cycle.
 */

import type { RuleContext } from '../decide/engine.ts';
import { isDatabase, type PlanItem } from '../decide/disposition.ts';
import type {
  App, AppKind, AppPattern, AppPlan, ComponentTier, DbMovePath, MovePath, PatternComponent, Platform, SizingConcern,
  TierPattern, Verification, Workload, WorkloadType,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface Fact {
  readonly text: string;
  /** URL (or several, separated by " ; "). */
  readonly source: string;
  readonly verification: Verification;
}

export const fact = (text: string, source: string, verification: Verification = 'V-DOC'): Fact => Object.freeze({ text, source, verification });

/** '' for vendor-verified, '[C]' for a community source, '[U]' for inferred / unverified. */
export function verificationBadge(v: Verification): '' | '[C]' | '[U]' {
  return v === 'I' ? '[U]' : v === 'C' ? '[C]' : '';
}

/** A fact the UI must flag: not verified from the vendor's own documentation. */
export const isUnverified = (f: Pick<Fact, 'verification'>): boolean => f.verification === 'I' || f.verification === 'C';

// ---------------------------------------------------------------------------
// Tier patterns per platform
// ---------------------------------------------------------------------------

/** What a tier pattern becomes on one platform. */
export interface TierTarget {
  /** The service, as the provider names it. */
  readonly service: string;
  /** Terraform types that build it (checked against `terraform/catalog-data.ts`). */
  readonly terraform: readonly string[];
  /** Set when there is a service but no Terraform resource: the reason, and it is a runbook step. */
  readonly noTerraform?: string;
  readonly note?: string;
  readonly source?: string;
}
/** The tier pattern does not exist on the platform: the reason. */
export interface TierNone { readonly none: string }
export type TierOption = TierTarget | TierNone;

export const isNone = (o: TierOption): o is TierNone => 'none' in o;

export interface TierPatternInfo {
  readonly id: TierPattern;
  readonly perPlatform: Readonly<Record<Platform, TierOption>>;
  readonly facts: readonly Fact[];
}

// ---------------------------------------------------------------------------
// Pattern entries
// ---------------------------------------------------------------------------

export type PatternFamily = 'generic' | 'sap' | 'oracle-apps' | 'microsoft' | 'vdi' | 'file' | 'middleware' | 'infra'
  | 'containers' | 'legacy' | 'appliances' | 'greenfield';

/**
 * - `automated`: the Factory generates the target and the move.
 * - `partial`: the target is generated; some steps are vendor tools run by hand (runbook).
 * - `honest-path`: assessment, a sourced target recommendation and a runbook only; nothing is automated
 *   because the replication cannot exist (non-x86, mainframe).
 */
export type PatternStatus = 'automated' | 'partial' | 'honest-path';

export type QuestionKind = 'select' | 'number' | 'text' | 'yesno';
export interface AssessQuestion {
  /** The `AppPlan.answers` key (the sizing engines read the same keys). */
  readonly key: string;
  readonly label: string;
  readonly kind: QuestionKind;
  /** For `select`: the closed set. */
  readonly options?: readonly string[];
  readonly unit?: string;
  readonly default?: string;
}

export interface ComponentTemplate {
  readonly name: string;
  readonly tier: ComponentTier;
  /** The workload types that fall into this component. */
  readonly workloadTypes?: readonly WorkloadType[];
  /** The default tier pattern. */
  readonly tierPattern: TierPattern;
  /** Per-platform defaults where they differ from `tierPattern`. */
  readonly perPlatform?: Readonly<Partial<Record<Platform, TierPattern>>>;
  /** Other tier patterns offered for this component, best first. */
  readonly alternatives?: readonly TierPattern[];
}

export interface PatternArtefacts {
  /** Extra Terraform types per platform beyond the components' tier patterns (transfer tasks, marketplace agreements …). */
  readonly terraform?: Readonly<Partial<Record<Platform, readonly string[]>>>;
  /** Ansible module FQCNs (checked against `ansible/module-schema-index.ts`). */
  readonly ansibleModules?: readonly string[];
  /** Ansible roles from a collection pulled in through requirements.yml (roles are not modules; verify their names). */
  readonly ansibleRoles?: readonly string[];
  /** Runbook steps (what is done by hand, or by a vendor tool). */
  readonly runbook?: readonly string[];
}

export interface PatternEntry {
  readonly id: AppPattern;
  readonly family: PatternFamily;
  readonly kind: AppKind;
  /** Workload types that suggest this pattern (detection → proposal). */
  readonly detectFrom: readonly WorkloadType[];
  readonly questions: readonly AssessQuestion[];
  /** The `pattern.*` rule ids that apply (A.4.3). */
  readonly rules: readonly string[];
  readonly components: readonly ComponentTemplate[];
  /** The move paths used (servers and databases). */
  readonly methods: readonly (MovePath | DbMovePath)[];
  readonly artefacts: PatternArtefacts;
  /** The sizing concern (WP-23 engine) that sizes it. */
  readonly sizing?: SizingConcern;
  readonly status: PatternStatus;
  /** Honest limits and the facts behind the rules, each sourced. */
  readonly facts: readonly Fact[];
  /** Tier-pattern preferences for "Add from patterns" (e.g. Exchange: saas +5). */
  readonly preferences?: readonly TierPreference[];
}

/** A score for a tier pattern of a pattern's component, optionally only on some platforms / answers. */
export interface TierPreference {
  readonly tierPattern: TierPattern;
  readonly delta: number;
  /** Rule id this preference reports as. */
  readonly rule: string;
  readonly reason: string;
  readonly source: string;
  readonly verification: Verification;
  readonly platforms?: readonly Platform[];
  /** Applies only when this answer has one of these values. */
  readonly when?: { readonly key: string; readonly values: readonly string[] };
  /** Eliminates the tier pattern instead of scoring it. */
  readonly eliminate?: boolean;
}

// ---------------------------------------------------------------------------
// Rule helpers: an item's app, plan, answers, tier pattern and type
// ---------------------------------------------------------------------------

export function appPlanFor(app: App | undefined, ctx: Pick<RuleContext, 'plan'>): AppPlan | undefined {
  if (!app) return undefined;
  return (ctx.plan.appPlans ?? []).find((p) => p.app === app.id);
}

export function patternOf(item: PlanItem, ctx: RuleContext): AppPattern | undefined {
  return ctx.appOf(item)?.pattern;
}

export function answersOf(item: PlanItem, ctx: RuleContext): Readonly<Record<string, string>> {
  return appPlanFor(ctx.appOf(item), ctx)?.answers ?? {};
}

/** The pattern component that carries the item on a platform's variant (else the chosen platform's, else any). */
export function componentOf(item: PlanItem, ctx: RuleContext, platform?: Platform): PatternComponent | undefined {
  const ap = appPlanFor(ctx.appOf(item), ctx);
  if (!ap) return undefined;
  const holds = (c: PatternComponent): boolean => (isDatabase(item) ? c.databases.includes(item.name) : c.servers.includes(item.name));
  const find = (p: Platform | undefined): PatternComponent | undefined => {
    if (!p) return undefined;
    for (const c of ap.variants[p] ?? []) if (c.kind === 'pattern' && holds(c)) return c;
    return undefined;
  };
  const direct = find(platform) ?? find(ap.platform);
  if (direct) return direct;
  for (const list of Object.values(ap.variants)) {
    for (const c of list ?? []) if (c.kind === 'pattern' && holds(c) && c.tierPattern) return c;
  }
  return undefined;
}

/** The tier pattern set for the item's component on `platform` (undefined = the pattern's default). */
export function tierPatternOf(item: PlanItem, ctx: RuleContext, platform: Platform): TierPattern | undefined {
  return componentOf(item, ctx, platform)?.tierPattern;
}

/** The workload's type: the set one, else a detection at or above the threshold. */
export function workloadTypeOf(w: Workload): WorkloadType | undefined {
  if (w.workloadType && w.workloadType !== 'unknown') return w.workloadType;
  const d = w.facts?.detection;
  return d && d.confidence >= 0.7 && d.type !== 'unknown' ? d.type : undefined;
}

/** A number from a component setting, then an answer, else undefined. */
export function numberAnswer(item: PlanItem, ctx: RuleContext, settingKey: string, answerKey: string): number | undefined {
  const c = componentOf(item, ctx);
  const raw = c?.settings[settingKey] ?? answersOf(item, ctx)[answerKey];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

