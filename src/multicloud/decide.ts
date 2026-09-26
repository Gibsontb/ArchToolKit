/**
 * Route a workload to a platform, and say why.
 *
 * A decision matrix that produces a winner and no reasoning is worse than no
 * matrix, because it cannot be argued with and it cannot be reviewed. So this
 * is a set of named rules, each of which states what it looked at, which way it
 * pushed, and where the claim comes from. The output is a ranking plus the rules
 * that produced it, and any rule can be read and disagreed with on its own.
 *
 * Two kinds of rule are kept apart on purpose:
 *
 *  - Rules that score. They encode something structural — licensing that
 *    genuinely is cheaper on one platform, a workload shape that genuinely does
 *    not move.
 *  - Rules that only report. Region availability, sovereign offerings and
 *    pricing change constantly and cannot be checked from an offline toolkit.
 *    Scoring on a stale region list would be a confident wrong answer, which is
 *    worse than an honest gap, so those rules raise a finding and move nothing.
 *
 * Since the Multi-Cloud Planner, this is a wrapper: the profile becomes a
 * one-workload plan (plus a database row per engine named), the planner's
 * per-item rules score it (`plan/decide/engine.ts`), and the result is mapped
 * back to the `Decision` shape. Rule ids decide.ts always emitted are kept:
 * where a planner rule has a new id, its decide.ts id is its alias.
 */

import { info, warning, type Finding } from '../core/findings.ts';
import type { Verification } from '../vcf/provenance.ts';
import { PLATFORMS, platformInfo, isHyperscaler, type Platform } from './platforms.ts';
import { vmwareCloudService } from './vmware-on-cloud.ts';
import { defaultRequirements, RESIDENCY_OPTIONS } from './plan/options.ts';
import { PLAN_KIND } from './plan/types.ts';
import type {
  Agreement, App, Database, Plan, Residency, RuleHit, Special, Workload, Disposition as PlanDisposition,
} from './plan/types.ts';
import { createContext, evaluateItem, type ItemEvaluation } from './plan/decide/engine.ts';

export type Disposition = 'retain' | 'rehost' | 'replatform' | 'refactor';

export type Latency = 'critical' | 'sensitive' | 'tolerant';

export type SpecialHardware = 'gpu' | 'large-memory' | 'physical-dongle';

export interface WorkloadProfile {
  readonly name?: string;
  readonly disposition: Disposition;
  readonly vmCount?: number;
  readonly osFamily?: 'linux' | 'windows' | 'mixed';
  /** Databases in the estate, which drive licensing more than anything else. */
  readonly databases?: readonly ('oracle' | 'sqlserver' | 'postgres' | 'mysql' | 'other')[];
  readonly latencyToOnPrem?: Latency;
  /** Months until the workload has to be off its current hardware. */
  readonly timelineMonths?: number;
  readonly specialHardware?: readonly SpecialHardware[];
}

export interface Constraints {
  /** Platforms there is already a commercial agreement with. */
  readonly existingCommitment?: readonly Platform[];
  /** Platforms the team can actually operate today. */
  readonly skills?: readonly Platform[];
  /** Platforms policy forbids. Eliminated, not merely penalised. */
  readonly excluded?: readonly Platform[];
  /** VCF subscriptions bought from Broadcom that could be carried onto a cloud. */
  readonly portableVcfSubscription?: boolean;
  /** Microsoft licences with active Software Assurance. */
  readonly microsoftSoftwareAssurance?: boolean;
  /** Data must stay in a named country or region. */
  readonly dataResidency?: string;
  /** A sovereign or air-gapped environment is required. */
  readonly sovereigntyRequired?: boolean;
}

export interface RuleOutcome {
  readonly id: string;
  /** What the rule looked at and which way it pushed, in one sentence. */
  readonly reason: string;
  readonly verification: Verification;
  readonly source?: string;
  /** Signed weight per platform. Absent means the rule said nothing about it. */
  readonly effects: Partial<Record<Platform, number>>;
  /** Platforms this rule rules out entirely. */
  readonly eliminates?: readonly Platform[];
}

export interface PlatformScore {
  readonly platform: Platform;
  readonly score: number;
  readonly eliminated: boolean;
  /** Rules that moved this platform, strongest first. */
  readonly reasons: readonly { readonly rule: string; readonly delta: number; readonly reason: string }[];
}

export interface Decision {
  readonly ranked: readonly PlatformScore[];
  /** The leader, or undefined when everything was eliminated or nothing separated them. */
  readonly recommended?: Platform;
  readonly rules: readonly RuleOutcome[];
  readonly findings: readonly Finding[];
  /** What to generate next, once a platform is chosen. */
  readonly handoff?: {
    readonly platform: Platform;
    readonly terraformTarget: string;
    readonly ansibleTarget: string;
    readonly vmwareService?: string;
  };
}

// ---------------------------------------------------------------------------
// Profile to plan
// ---------------------------------------------------------------------------

/** decide.ts "rehost" moved the VM unchanged onto VMware or a VMware service: the planner's relocate. */
const ROUTE: Readonly<Record<Disposition, PlanDisposition>> = {
  retain: 'retain',
  rehost: 'relocate',
  replatform: 'replatform',
  refactor: 'refactor',
};

const AGREEMENT: Readonly<Record<Platform, Agreement>> = {
  aws: 'edp',
  azure: 'macc',
  google: 'google-commit',
  oci: 'oci-uc',
  vmware: 'vcf-subscription',
};

/** The one special the planner's App carries: the most restrictive wins. */
const SPECIAL_ORDER: readonly SpecialHardware[] = ['physical-dongle', 'large-memory', 'gpu'];

function residencyFrom(text: string): Residency {
  const t = text.trim().toLowerCase();
  const hit = RESIDENCY_OPTIONS.find((o) => o.value === t || o.label.toLowerCase() === t);
  // The finding's wording is replaced with the caller's text below, so an
  // unlisted place only needs to be "not any".
  return hit ? hit.value : 'eu';
}

function legacyPlan(profile: WorkloadProfile, constraints: Constraints, special: Special): Plan {
  const name = profile.name ?? 'workload';
  const req = defaultRequirements();
  const excluded = constraints.excluded ?? [];
  const residency: Residency = constraints.dataResidency ? residencyFrom(constraints.dataResidency) : 'any';
  const app: App = {
    id: 'a:profile',
    name,
    criticality: 'tier2',
    residency,
    latencyToOnPrem: profile.latencyToOnPrem ?? 'tolerant',
    ...(profile.timelineMonths !== undefined ? { deadlineMonths: profile.timelineMonths } : {}),
    special,
  };
  const windows = profile.osFamily === 'windows' || profile.osFamily === 'mixed';
  const workload: Workload = {
    id: 'w:profile',
    name,
    app: name,
    env: 'prod',
    role: 'app',
    // A current OS with an image everywhere, so no image or support-date rule fires on a profile that named none.
    os: windows ? 'win-2022' : 'ubuntu-24.04',
    vcpu: 4,
    ramGib: 16,
    disksGib: [100],
    criticality: 'tier2',
    rpo: '4h',
    rto: '4h',
    licence: windows ? 'li' : 'free',
    disposition: ROUTE[profile.disposition],
    dependsOn: [],
    source: 'manual',
  };
  const sa = !!constraints.microsoftSoftwareAssurance;
  const databases: Database[] = [...new Set(profile.databases ?? [])].map((engine) => ({
    id: `d:${engine}`,
    name: `${name}-${engine}`,
    engine,
    edition: engine === 'oracle' ? 'oracle-ee' : engine === 'sqlserver' ? 'sql-enterprise' : engine === 'other' ? 'commercial' : 'community',
    version: 'other',
    hosts: [],
    vcpu: 4,
    ramGib: 16,
    sizeGib: 100,
    ha: 'none',
    dr: 'none',
    features: [],
    licence: engine === 'sqlserver' ? (sa ? 'byol-sa' : 'li') : engine === 'oracle' ? 'li' : engine === 'other' ? 'commercial-other' : 'community',
    app: name,
    source: 'manual',
  }));
  return {
    kind: PLAN_KIND,
    version: 1,
    id: 'decide-profile',
    name,
    savedAt: '',
    workloads: [workload],
    databases,
    apps: [app],
    edges: [],
    requirements: {
      ...req,
      allowed: PLATFORMS.filter((p) => !excluded.includes(p)),
      maxPlatforms: 5,
      ...(profile.timelineMonths !== undefined ? { timelineMonths: profile.timelineMonths } : {}),
      sovereignty: constraints.sovereigntyRequired ? 'sovereign-region' : 'none',
      defaultResidency: residency,
      commitments: [...new Set(constraints.existingCommitment ?? [])].map((platform) => ({ platform, agreement: AGREEMENT[platform] })),
      skills: Object.fromEntries((constraints.skills ?? []).map((p) => [p, 'strong' as const])),
      licensing: {
        ...req.licensing,
        microsoftSa: sa ? 'yes-all' : 'no',
        portableVcf: !!constraints.portableVcfSubscription,
      },
    },
    designOverrides: {},
    waveSettings: { mode: 'default', maxPerWave: 50, parallel: 1, weeks: 2, freezes: [] },
  };
}

const legacyId = (h: RuleHit): string => h.aliases?.[0] ?? h.rule;

function evaluateProfile(profile: WorkloadProfile, constraints: Constraints, special: Special): { workload: ItemEvaluation; databases: ItemEvaluation[] } {
  const plan = legacyPlan(profile, constraints, special);
  const ctx = createContext(plan, { workloadCount: profile.vmCount ?? 0 });
  return {
    workload: evaluateItem(plan.workloads[0]!, ctx),
    databases: plan.databases.map((d) => evaluateItem(d, ctx)),
  };
}

function evaluate(profile: WorkloadProfile, constraints: Constraints): {
  ranked: PlatformScore[];
  rules: RuleOutcome[];
  findings: Finding[];
} {
  const specials = SPECIAL_ORDER.filter((s) => profile.specialHardware?.includes(s));
  const primary = specials[0] ?? 'none';
  const { workload, databases } = evaluateProfile(profile, constraints, primary);

  const outcomes = new Map<string, { reason: string; verification: Verification; source?: string; effects: Partial<Record<Platform, number>>; eliminates: Platform[] }>();
  const outcome = (h: RuleHit) => {
    const id = legacyId(h);
    let o = outcomes.get(id);
    if (!o) {
      o = { reason: h.reason, verification: h.verification, ...(h.source ? { source: h.source } : {}), effects: {}, eliminates: [] };
      outcomes.set(id, o);
    }
    return o;
  };

  const ranked: PlatformScore[] = PLATFORMS.map((platform) => {
    const w = workload.options.find((o) => o.platform === platform)!;
    // Each database lands on its best surviving service on this platform.
    const dbHits = databases.flatMap((ev) => ev.options.find((o) => o.platform === platform && !o.eliminated)?.hits ?? []);
    const hits = [...w.hits, ...dbHits];
    for (const h of hits) {
      if (h.delta !== 0) {
        const o = outcome(h);
        o.effects[platform] = (o.effects[platform] ?? 0) + h.delta;
      }
    }
    if (w.eliminated) {
      const h = w.hits.find((x) => x.rule === w.eliminated);
      if (h) outcome(h).eliminates.push(platform);
    }
    const reasons = hits
      .filter((h) => h.delta !== 0)
      .map((h) => ({ rule: legacyId(h), delta: h.delta, reason: h.reason }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const score = reasons.reduce((sum, r) => sum + r.delta, 0);
    return { platform, score, eliminated: w.eliminated !== undefined, reasons };
  }).sort((a, b) => {
    if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
    return b.score - a.score;
  });

  const rules: RuleOutcome[] = [];
  for (const [id, o] of outcomes) {
    rules.push({
      id,
      reason: o.reason,
      verification: o.verification,
      ...(o.source ? { source: o.source } : {}),
      effects: o.effects,
      ...(o.eliminates.length > 0 ? { eliminates: o.eliminates } : {}),
    });
  }

  let raw: Finding[] = [...workload.findings, ...databases.flatMap((d) => d.findings)];
  // Specials beyond the first report their findings too.
  for (const extra of specials.slice(1)) {
    raw.push(...evaluateProfile({ ...profile, databases: [] }, constraints, extra).workload.findings);
  }
  if (constraints.dataResidency) {
    raw = raw.map((f) =>
      f.code === 'multicloud.residency.check-regions'
        ? { ...f, message: `Data must stay in ${constraints.dataResidency}, and region coverage differs per platform and changes constantly.` }
        : f,
    );
  }
  const seen = new Set<string>();
  const findings = raw.filter((f) => {
    const key = `${f.code}\u0000${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ranked, rules, findings };
}

export function decide(profile: WorkloadProfile, constraints: Constraints = {}): Decision {
  const { ranked, rules, findings } = evaluate(profile, constraints);

  const surviving = ranked.filter((r) => !r.eliminated);
  const leader = surviving[0];
  const runnerUp = surviving[1];

  // A one-point margin is noise, not a decision. Saying so is more useful than
  // naming a winner that the next conversation overturns.
  const decisive = leader !== undefined && (runnerUp === undefined || leader.score - runnerUp.score >= 2);

  if (surviving.length === 0) {
    findings.push(
      warning(
        'multicloud.no-platform',
        'Every platform was ruled out, so the constraints as stated cannot all be met.',
        { remediation: 'Relax one of them, or accept that the workload does not move.' },
      ),
    );
  } else if (!decisive) {
    findings.push(
      info(
        'multicloud.too-close-to-call',
        `${surviving
          .filter((r) => leader !== undefined && leader.score - r.score < 2)
          .map((r) => platformInfo(r.platform).shortLabel)
          .join(' and ')} score within a point of each other, which is not a difference these rules can resolve.`,
        {
          remediation:
            'Decide on price, on the commercial relationship, or on where the team would rather be in three years.',
          source: 'ArchToolKit',
        },
      ),
    );
  }

  const recommended = decisive && leader ? leader.platform : undefined;

  let handoff: Decision['handoff'];
  if (recommended) {
    const meta = platformInfo(recommended);
    const service = vmwareCloudService(recommended);
    handoff = {
      platform: recommended,
      terraformTarget: meta.terraform,
      ansibleTarget: meta.ansible,
      ...(service && (profile.disposition === 'rehost' || profile.disposition === 'retain')
        ? { vmwareService: service.abbreviation }
        : {}),
    };
    findings.push(
      info(
        'multicloud.handoff',
        `${meta.label}: generate the Terraform foundation for "${meta.terraform}" and the Ansible scaffold for "${meta.ansible}".`,
        { source: 'ArchToolKit' },
      ),
    );
    if (isHyperscaler(recommended) && profile.disposition === 'rehost' && service) {
      findings.push(
        info(
          'multicloud.vmware-service',
          `A rehost onto ${meta.shortLabel} means ${service.name} (${service.abbreviation}), not native instances — the guest does not change.`,
          { source: service.placement.source },
        ),
      );
    }
  }

  return { ranked, recommended, rules, findings, handoff };
}
