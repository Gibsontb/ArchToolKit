/**
 * Commercial rules: money already committed, skills already held, the exit
 * strategy, and the two licence positions that are commercial rather than
 * vendor-specific (portable VCF subscriptions, Linux bring-your-own).
 */

import { info, warning } from '../../../../core/findings.js';
import { DB_SERVICES } from '../../db-catalog.js';
                                                                   
                                                  
import { rule,                                } from '../engine.js';

function committed(ctx             )                        {
  return new Set(ctx.requirements.commitments.map((c) => c.platform));
}

export const COMMERCIAL_RULES                     = [
  rule          ({
    id: 'commercial.existing-commitment',
    kind: 'any',
    aliases: ['existing-commitment'],
    verification: 'I',
    applies: (_item, ctx) => ctx.requirements.commitments.length > 0,
    evaluate: (_item, o, ctx) =>
      committed(ctx).has(o.platform)
        ? { delta: 3, reason: 'Spend already committed on a platform is spend that has to be used, and a second platform rarely earns its second set of guardrails.' }
        : undefined,
  }),

  rule          ({
    id: 'commercial.operational-skills',
    kind: 'any',
    aliases: ['operational-skills'],
    verification: 'I',
    applies: (_item, ctx) => Object.values(ctx.requirements.skills).some((s) => s === 'some' || s === 'strong'),
    evaluate: (_item, o, ctx) => {
      const s = ctx.requirements.skills[o.platform];
      if (s === 'strong') return { delta: 2, reason: 'A platform the team can already operate is worth more than one that scores better on paper.' };
      if (s === 'some') return { delta: 1, reason: 'The team has some experience operating this platform.' };
      return undefined;
    },
  }),

  rule          ({
    id: 'exit.portable-first',
    kind: 'database',
    verification: 'I',
    applies: (_db, ctx) => ctx.requirements.exit === 'portable-first',
    evaluate: (_db, o) => {
      if (!o.service) return undefined;
      return DB_SERVICES[o.service].managed
        ? { delta: -1, reason: 'Portable first: a managed service is harder to leave than a database on a VM.' }
        : { delta: 1, reason: 'Portable first: a database on a VM moves off the platform as it came.' };
    },
  }),

  rule          ({
    id: 'exit.managed-first',
    kind: 'database',
    verification: 'I',
    applies: (_db, ctx) => ctx.requirements.exit === 'managed-first',
    evaluate: (_db, o) =>
      o.service && DB_SERVICES[o.service].managed ? { delta: 1, reason: 'Managed first: the provider runs the database.' } : undefined,
  }),

  rule          ({
    id: 'lic.vcf.portable',
    kind: 'workload',
    aliases: ['portable-vcf-subscription'],
    verification: 'V-DOC',
    source: 'Microsoft Azure blog: run VCF private clouds in AVS with support for portable VCF subscriptions.',
    applies: (w, ctx) => ctx.requirements.licensing.portableVcf && ctx.placementOf(w).method === 'relocate-hcx',
    evaluate: (_w, o) => {
      const delta = ({ azure: 2, aws: 2, vmware: 1 }                                     )[o.platform];
      return delta
        ? { delta, reason: 'VCF subscriptions bought from Broadcom can be carried onto Azure VMware Solution rather than repurchased, and Amazon EVS is self-managed VCF, so the licence is yours there by construction.' }
        : undefined;
    },
    findings: () => [
      warning('multicloud.licensing.portability-unconfirmed', 'Whether a portable VCF subscription can be carried onto Google Cloud VMware Engine or Oracle Cloud VMware Solution was not confirmed against either vendor.', {
        remediation: 'Confirm with the provider before pricing either of them on a carried licence.',
        source: 'ArchToolKit',
      }),
    ],
  }),

  rule          ({
    id: 'lic.linux.byos',
    kind: 'workload',
    verification: 'C',
    source: 'https://access.redhat.com/public-cloud',
    applies: (w) => w.licence === 'rhel-byos' || w.licence === 'sles-byos',
    findings: (w, ctx) => [
      info('plan.licence.linux-byos', `${w.name}: ${w.licence === 'rhel-byos' ? 'RHEL (Cloud Access)' : 'SLES'} subscriptions come with it; all four hyperscalers accept them.`, {
        path: `workloads.${w.id}.licence`,
        source: ctx.facts['rhel.cloud-access'].source,
      }),
    ],
  }),
];
