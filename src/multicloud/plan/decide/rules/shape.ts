/**
 * The shape of the workload: rules carried over from decide.ts, now scored
 * per item. Retention, relocation onto VMware, refactoring, latency to what
 * stays on premises, the deadline, and hardware that narrows the choice.
 */

import { info, warning } from '../../../../core/findings.ts';
import { rightsize } from '../../../../kit/rightsize.ts';
import { PLATFORMS, isHyperscaler, type Platform } from '../../../platforms.ts';
import { gapsFor } from '../../../services.ts';
import { vmwareCloudService } from '../../../vmware-on-cloud.ts';
import { DB_SERVICES } from '../../db-catalog.ts';
import type { Workload } from '../../types.ts';
import { DC_SOURCE, isDatabase, type PlanItem } from '../disposition.ts';
import { rule, type AnyRule, type RuleContext } from '../engine.ts';

/** Memory from which instance shapes start to narrow (from-inventory.ts). */
export const LARGE_MEMORY_GIB = 384;
/** Workloads relocated as they are, from which a VMware service moves them in bulk (decide.ts `rehost-at-scale`). */
export const AT_SCALE_VMS = 200;
/** A deadline this close or closer only allows moves that do not change the application. */
export const SHORT_TIMELINE_MONTHS = 6;

function dispositionOf(item: PlanItem, ctx: RuleContext) {
  return isDatabase(item) ? ctx.dbRouteOf(item) : ctx.placementOf(item).disposition;
}

function timelineOf(item: PlanItem, ctx: RuleContext): number {
  return ctx.appOf(item)?.deadlineMonths ?? ctx.requirements.timelineMonths;
}

let refactorEffects: Partial<Record<Platform, number>> | undefined;
/** Fewer gaps in the capability table, more managed services to refactor on to. */
function refactorEffect(p: Platform): number {
  if (!refactorEffects) {
    refactorEffects = { vmware: -2 };
    for (const q of PLATFORMS) if (q !== 'vmware') refactorEffects[q] = Math.max(0, 3 - gapsFor(q).length);
  }
  return refactorEffects[p] ?? 0;
}

export const SHAPE_RULES: readonly AnyRule[] = [
  rule<Workload>({
    id: 'shape.dc-rebuild',
    kind: 'workload',
    verification: 'C',
    source: DC_SOURCE,
    applies: (w) => w.role === 'ad-dc',
    evaluate: () => ({ reason: 'A domain controller is rebuilt and promoted, never replicated: a restored or replicated DC risks USN rollback.' }),
  }),

  rule<PlanItem>({
    id: 'shape.retain',
    kind: 'any',
    aliases: ['retain'],
    verification: 'I',
    applies: (item, ctx) => dispositionOf(item, ctx) === 'retain',
    evaluate: (_item, o) =>
      o.platform === 'vmware' ? { delta: 5, reason: 'The workload is being kept where it is, so the question is capacity rather than platform.' } : undefined,
  }),

  rule<Workload>({
    id: 'shape.relocate-suits-vmware-services',
    kind: 'workload',
    aliases: ['rehost-suits-vmware-services'],
    verification: 'I',
    applies: (w, ctx) => ctx.placementOf(w).method === 'relocate-hcx',
    evaluate: (_w, o) => {
      if (o.platform === 'vmware') return { delta: 2, reason: 'A relocation keeps the guest, the hypervisor and the operational tooling.' };
      return vmwareCloudService(o.platform)
        ? { delta: 1, reason: 'A relocation keeps the guest, the hypervisor and the operational tooling, which is what the hyperscalers’ VMware services are for.' }
        : undefined;
    },
  }),

  rule<Workload>({
    id: 'shape.relocate-at-scale',
    kind: 'workload',
    aliases: ['rehost-at-scale'],
    verification: 'I',
    applies: (w, ctx) => ctx.placementOf(w).method === 'relocate-hcx' && ctx.workloadCount >= AT_SCALE_VMS,
    evaluate: (_w, o, ctx) => {
      const delta = ({ vmware: 2, aws: 2, azure: 2, google: 1, oci: 1 } as const)[o.platform];
      return { delta, reason: `${ctx.workloadCount} virtual machines is too many to re-platform one at a time; a VMware service moves them as they are.` };
    },
  }),

  rule<Workload>({
    id: 'shape.refactor-needs-managed-services',
    kind: 'workload',
    aliases: ['refactor-needs-managed-services'],
    verification: 'I',
    source: 'ArchToolKit capability table',
    applies: (w, ctx) => ctx.placementOf(w).disposition === 'refactor',
    evaluate: (_w, o) => {
      const delta = refactorEffect(o.platform);
      return delta === 0
        ? undefined
        : { delta, reason: 'Refactoring trades virtual machines for managed services, so the platform with fewer gaps in the capability table has more to land on.' };
    },
  }),

  rule<PlanItem>({
    id: 'shape.latency-critical',
    kind: 'any',
    aliases: ['latency-critical'],
    verification: 'I',
    applies: (item, ctx) => ctx.appOf(item)?.latencyToOnPrem === 'critical',
    evaluate: (_item, o) =>
      o.platform === 'vmware'
        ? { delta: 4, reason: 'A latency-critical dependency on something staying on premises is the one thing a private circuit cannot remove; the round trip is the distance.' }
        : { delta: -1, reason: 'A latency-critical dependency on premises: every region is further away than the next rack.' },
    findings: () => [
      warning('multicloud.latency.measure-first', 'Measure the actual round trip to the nearest region of each candidate before ruling any of them out.', {
        remediation: 'A circuit to a region 20 ms away is fine for most applications and fatal for a few. Which of the two this is should be measured, not assumed.',
        source: 'ArchToolKit',
      }),
    ],
  }),

  rule<PlanItem>({
    id: 'shape.latency-sensitive',
    kind: 'any',
    aliases: ['latency-sensitive'],
    verification: 'I',
    applies: (item, ctx) => ctx.appOf(item)?.latencyToOnPrem === 'sensitive',
    evaluate: (_item, o) =>
      o.platform === 'vmware' ? { delta: 1, reason: 'A latency-sensitive dependency needs a private circuit on day one, which is the longest lead item in the plan.' } : undefined,
    findings: () => [
      info('multicloud.latency.circuit-lead-time', 'A private circuit is the long-lead item and usually sets the cutover date, not the migration tooling.', { source: 'ArchToolKit' }),
    ],
  }),

  rule<PlanItem>({
    id: 'shape.short-timeline',
    kind: 'any',
    aliases: ['short-timeline'],
    verification: 'I',
    applies: (item, ctx) => timelineOf(item, ctx) <= SHORT_TIMELINE_MONTHS,
    evaluate: (item, o, ctx) => {
      const months = timelineOf(item, ctx);
      if (isDatabase(item)) {
        if (!o.service) return undefined;
        return DB_SERVICES[o.service].managed
          ? { delta: -1, reason: `${months} months is short for a move onto a managed service, which changes how the database is run.` }
          : { delta: 1, reason: `${months} months favours moving the database with its VM, unchanged.` };
      }
      const method = ctx.placementOf(item).method;
      if (method === 'rebuild') return { delta: -1, reason: `${months} months does not leave much time to rebuild; replication moves it unchanged.` };
      if (method === 'replicate' || method === 'relocate-hcx') return { delta: 1, reason: `${months} months does not allow applications to be rewritten, and this one moves unchanged.` };
      return undefined;
    },
    findings: (item, ctx) => {
      if (isDatabase(item) || ctx.placementOf(item).disposition !== 'refactor') return [];
      const months = timelineOf(item, ctx);
      return [
        warning('multicloud.timeline.refactor-unrealistic', `A refactor in ${months} months is the plan that most often becomes a rushed rehost.`, {
          remediation: 'Rehost first to get off the hardware, then refactor from a position where the deadline has passed.',
          source: 'ArchToolKit',
        }),
      ];
    },
  }),

  rule<Workload>({
    id: 'shape.large-memory',
    kind: 'workload',
    verification: 'C',
    source: 'src/kit/rightsize.ts (the machine ladders)',
    applies: (w, ctx) => ctx.appOf(w)?.special === 'large-memory' || w.ramGib >= LARGE_MEMORY_GIB,
    evaluate: (w, o, ctx) => {
      if (!isHyperscaler(o.platform) || ctx.placementOf(w).method === 'relocate-hcx') return undefined;
      const fit = rightsize(o.platform as 'aws' | 'azure' | 'google' | 'oci', w.vcpu, w.ramGib);
      return fit ? undefined : { eliminate: true, reason: `${w.vcpu} vCPU / ${w.ramGib} GiB is larger than the largest shape on the ${o.platform} ladder.` };
    },
    findings: (w, ctx) =>
      ctx.appOf(w)?.special === 'large-memory'
        ? [info('multicloud.large-memory.check-shapes', 'Very large memory footprints narrow the instance shapes available, and the largest shapes are not in every region.', { source: 'ArchToolKit' })]
        : [],
  }),

  rule<PlanItem>({
    id: 'shape.gpu',
    kind: 'any',
    verification: 'I',
    applies: (item, ctx) => ctx.appOf(item)?.special === 'gpu',
    findings: () => [
      info('multicloud.gpu.availability-not-capability', 'Every platform has GPU instances; the question is whether the model you need is obtainable in the region you need, which changes week to week.', { source: 'ArchToolKit' }),
    ],
  }),
];

