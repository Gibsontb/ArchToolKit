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
 * Nothing here is a substitute for a commercial conversation. What it does is
 * stop the same six considerations being rediscovered on every engagement, and
 * carry the answer into the Terraform and Ansible kits rather than leaving it
 * in a slide.
 */

import { info, warning, type Finding } from '../core/findings.ts';
import type { Verification } from '../vcf/provenance.ts';
import { PLATFORMS, platformInfo, isHyperscaler, type Platform } from './platforms.ts';
import { gapsFor } from './services.ts';
import { vmwareCloudService } from './vmware-on-cloud.ts';

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

/** Every hyperscaler at once, for a rule that treats them alike. */
function allHyperscalers(weight: number): Partial<Record<Platform, number>> {
  return { aws: weight, azure: weight, google: weight, oci: weight };
}

function evaluate(profile: WorkloadProfile, constraints: Constraints): {
  rules: RuleOutcome[];
  findings: Finding[];
} {
  const rules: RuleOutcome[] = [];
  const findings: Finding[] = [];
  const latency = profile.latencyToOnPrem ?? 'tolerant';
  const vmCount = profile.vmCount ?? 0;

  // --- eliminations ---------------------------------------------------------

  if (constraints.excluded && constraints.excluded.length > 0) {
    rules.push({
      id: 'excluded-by-policy',
      reason: `Policy rules out ${constraints.excluded.map((p) => platformInfo(p).shortLabel).join(', ')}.`,
      verification: 'I',
      effects: {},
      eliminates: constraints.excluded,
    });
  }

  if (profile.specialHardware?.includes('physical-dongle')) {
    // The one constraint that genuinely admits no cloud answer: a licence dongle
    // has to be plugged into something, and no hyperscaler will plug it in.
    rules.push({
      id: 'physical-dongle',
      reason:
        'A physical licence dongle has to be attached to a host, which no hyperscaler offers. The workload stays on hardware you control.',
      verification: 'I',
      effects: { vmware: 4 },
      eliminates: ['aws', 'azure', 'google', 'oci'],
    });
  }

  // --- shape of the workload ------------------------------------------------

  if (profile.disposition === 'retain') {
    rules.push({
      id: 'retain',
      reason: 'The workload is being kept where it is, so the question is capacity rather than platform.',
      verification: 'I',
      effects: { vmware: 5 },
    });
  }

  if (profile.disposition === 'rehost') {
    // Rehosting is precisely the case the VMware services exist for: the guest
    // does not change, the hypervisor does not change, and the tooling around
    // it does not change either.
    rules.push({
      id: 'rehost-suits-vmware-services',
      reason:
        'A rehost keeps the guest, the hypervisor and the operational tooling, which is what the hyperscalers’ VMware services are for.',
      verification: 'I',
      effects: { vmware: 2, ...allHyperscalers(1) },
    });

    if (vmCount >= 200) {
      rules.push({
        id: 'rehost-at-scale',
        reason: `${vmCount} virtual machines is too many to re-platform one at a time; a VMware service moves them as they are.`,
        verification: 'I',
        effects: { vmware: 2, aws: 2, azure: 2, google: 1, oci: 1 },
      });
    }
  }

  if (profile.disposition === 'refactor') {
    // Breadth is measured from the capability table rather than asserted, so
    // this rule moves when the table does.
    const gaps = Object.fromEntries(PLATFORMS.map((p) => [p, gapsFor(p).length])) as Record<Platform, number>;
    const effects: Partial<Record<Platform, number>> = {};
    for (const platform of PLATFORMS) {
      if (platform === 'vmware') continue;
      // Fewer gaps in the capability table, more managed services to refactor on to.
      effects[platform] = Math.max(0, 3 - gaps[platform]);
    }
    rules.push({
      id: 'refactor-needs-managed-services',
      reason:
        'Refactoring trades virtual machines for managed services, so the platform with fewer gaps in the capability table has more to land on.',
      verification: 'I',
      source: 'ArchToolKit capability table',
      effects: { ...effects, vmware: -2 },
    });
  }

  // --- latency --------------------------------------------------------------

  if (latency === 'critical') {
    rules.push({
      id: 'latency-critical',
      reason:
        'A latency-critical dependency on something staying on premises is the one thing a private circuit cannot remove; the round trip is the distance.',
      verification: 'I',
      effects: { vmware: 4, ...allHyperscalers(-1) },
    });
    findings.push(
      warning(
        'multicloud.latency.measure-first',
        'Measure the actual round trip to the nearest region of each candidate before ruling any of them out.',
        {
          remediation:
            'A circuit to a region 20 ms away is fine for most applications and fatal for a few. Which of the two this is should be measured, not assumed.',
          source: 'ArchToolKit',
        },
      ),
    );
  } else if (latency === 'sensitive') {
    rules.push({
      id: 'latency-sensitive',
      reason:
        'A latency-sensitive dependency needs a private circuit on day one, which is the longest lead item in the plan.',
      verification: 'I',
      effects: { vmware: 1 },
    });
    findings.push(
      info(
        'multicloud.latency.circuit-lead-time',
        'A private circuit is the long-lead item and usually sets the cutover date, not the migration tooling.',
        { source: 'ArchToolKit' },
      ),
    );
  }

  // --- timeline -------------------------------------------------------------

  if (profile.timelineMonths !== undefined && profile.timelineMonths <= 6) {
    rules.push({
      id: 'short-timeline',
      reason: `${profile.timelineMonths} months does not allow applications to be rewritten, so the answer has to be one that moves them unchanged.`,
      verification: 'I',
      effects: { vmware: 2, ...allHyperscalers(1) },
    });
    if (profile.disposition === 'refactor') {
      findings.push(
        warning(
          'multicloud.timeline.refactor-unrealistic',
          `A refactor in ${profile.timelineMonths} months is the plan that most often becomes a rushed rehost.`,
          {
            remediation:
              'Rehost first to get off the hardware, then refactor from a position where the deadline has passed.',
            source: 'ArchToolKit',
          },
        ),
      );
    }
  }

  // --- commercial ----------------------------------------------------------

  if (constraints.existingCommitment && constraints.existingCommitment.length > 0) {
    const effects: Partial<Record<Platform, number>> = {};
    for (const platform of constraints.existingCommitment) effects[platform] = 3;
    rules.push({
      id: 'existing-commitment',
      reason:
        'Spend already committed on a platform is spend that has to be used, and a second platform rarely earns its second set of guardrails.',
      verification: 'I',
      effects,
    });
  }

  if (constraints.skills && constraints.skills.length > 0) {
    const effects: Partial<Record<Platform, number>> = {};
    for (const platform of constraints.skills) effects[platform] = 2;
    rules.push({
      id: 'operational-skills',
      reason: 'A platform the team can already operate is worth more than one that scores better on paper.',
      verification: 'I',
      effects,
    });
  }

  // --- licensing -----------------------------------------------------------

  if (constraints.portableVcfSubscription) {
    // AVS is the one confirmed in writing; EVS follows from being self-managed
    // VCF; the other two were not confirmed, and saying so is the point.
    rules.push({
      id: 'portable-vcf-subscription',
      reason:
        'VCF subscriptions bought from Broadcom can be carried onto Azure VMware Solution rather than repurchased, and Amazon EVS is self-managed VCF, so the licence is yours there by construction.',
      verification: 'V-DOC',
      source:
        'Microsoft Azure blog: run VCF private clouds in AVS with support for portable VCF subscriptions.',
      effects: { azure: 2, aws: 2, vmware: 1 },
    });
    findings.push(
      warning(
        'multicloud.licensing.portability-unconfirmed',
        'Whether a portable VCF subscription can be carried onto Google Cloud VMware Engine or Oracle Cloud VMware Solution was not confirmed against either vendor.',
        {
          remediation: 'Confirm with the provider before pricing either of them on a carried licence.',
          source: 'ArchToolKit',
        },
      ),
    );
  }

  if (constraints.microsoftSoftwareAssurance && (profile.osFamily === 'windows' || profile.osFamily === 'mixed')) {
    rules.push({
      id: 'microsoft-licensing',
      reason:
        'Windows Server and SQL Server licences with active Software Assurance can be applied to Azure compute, which the other platforms cannot do for you.',
      verification: 'C',
      source: 'Microsoft Azure Hybrid Benefit.',
      effects: { azure: 3 },
    });
  }

  if (profile.databases?.includes('oracle')) {
    // The rule most often repeated out of date. Oracle Database is now a
    // first-party service inside AWS, Azure and Google Cloud, so an Oracle
    // estate no longer forces OCI — it constrains which regions are usable.
    rules.push({
      id: 'oracle-database',
      reason:
        'Oracle Database no longer forces OCI: Oracle Database@AWS, @Azure and @Google Cloud run Oracle hardware inside those clouds. OCI still avoids the region constraint those services carry.',
      verification: 'V-DOC',
      source: 'Oracle: Oracle Database@AWS generally available, July 2025, now in 20 regions.',
      effects: { oci: 2, aws: 1, azure: 1, google: 1 },
    });
    findings.push(
      warning(
        'multicloud.oracle.region-constrained',
        'Oracle Database@AWS, @Azure and @Google Cloud are available only in specific regions, which may not include the one the rest of the estate needs.',
        {
          remediation:
            "Check Oracle's multicloud regional availability list against the region this workload has to sit in.",
          source: 'Oracle multicloud regional availability.',
        },
      ),
    );
  }

  if (profile.databases?.includes('sqlserver') && !constraints.microsoftSoftwareAssurance) {
    findings.push(
      info(
        'multicloud.sqlserver.licensing',
        'SQL Server licensing dominates the cost of a Windows estate, and the answer differs per platform depending on whether Software Assurance is current.',
        {
          remediation: 'Establish the Software Assurance position before comparing prices.',
          source: 'ArchToolKit',
        },
      ),
    );
  }

  // --- things that must be reported rather than scored ---------------------

  if (constraints.dataResidency) {
    findings.push(
      warning(
        'multicloud.residency.check-regions',
        `Data must stay in ${constraints.dataResidency}, and region coverage differs per platform and changes constantly.`,
        {
          remediation:
            'Check each candidate’s current region list; this toolkit is offline and deliberately does not carry one.',
          source: 'ArchToolKit',
        },
      ),
    );
  }

  if (constraints.sovereigntyRequired) {
    findings.push(
      warning(
        'multicloud.sovereignty.differs-in-shape',
        'All four hyperscalers offer something called sovereign, and the four offerings differ in who holds the keys, who operates the hardware and which law applies.',
        {
          remediation:
            'Compare the operating model rather than the label, and involve whoever owns the regulatory obligation.',
          source: 'ArchToolKit',
        },
      ),
    );
  }

  if (profile.specialHardware?.includes('gpu')) {
    findings.push(
      info(
        'multicloud.gpu.availability-not-capability',
        'Every platform has GPU instances; the question is whether the model you need is obtainable in the region you need, which changes week to week.',
        { source: 'ArchToolKit' },
      ),
    );
  }

  if (profile.specialHardware?.includes('large-memory')) {
    findings.push(
      info(
        'multicloud.large-memory.check-shapes',
        'Very large memory footprints narrow the instance shapes available, and the largest shapes are not in every region.',
        { source: 'ArchToolKit' },
      ),
    );
  }

  return { rules, findings };
}

export function decide(profile: WorkloadProfile, constraints: Constraints = {}): Decision {
  const { rules, findings } = evaluate(profile, constraints);

  const eliminated = new Set<Platform>();
  for (const rule of rules) for (const platform of rule.eliminates ?? []) eliminated.add(platform);

  const ranked: PlatformScore[] = PLATFORMS.map((platform) => {
    const reasons = rules
      .filter((rule) => (rule.effects[platform] ?? 0) !== 0)
      .map((rule) => ({ rule: rule.id, delta: rule.effects[platform] as number, reason: rule.reason }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const score = reasons.reduce((sum, r) => sum + r.delta, 0);
    return { platform, score, eliminated: eliminated.has(platform), reasons };
  }).sort((a, b) => {
    if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
    return b.score - a.score;
  });

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
