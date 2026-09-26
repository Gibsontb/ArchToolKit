/**
 * Rules that report and never score.
 *
 * Region availability, sovereign offerings and support dates are facts the
 * user has to act on, but scoring on a stale region list would be a confident
 * wrong answer. So these raise findings and move nothing.
 */

import { info, warning } from '../../../../core/findings.js';
                                                      
import { DB_VERSIONS, isVersionEol } from '../../db-catalog.js';
import { RESIDENCY_OPTIONS, SOVEREIGNTY_OPTIONS, labelOf } from '../../options.js';
import { OS_CATALOG, supportStatus } from '../../os.js';
                                                                                    
import { isDatabase,               } from '../disposition.js';
import { rule,                                } from '../engine.js';

const MIGRATION_CLOUD_PLATFORM                                             = { aws: 'aws', azure: 'azure', gcp: 'google', oci: 'oci' };

export function residencyOf(item          , ctx             )            {
  return (!isDatabase(item) ? item.residency : undefined) ?? ctx.appOf(item)?.residency ?? ctx.requirements.defaultResidency;
}

export const REPORT_RULES                     = [
  rule          ({
    id: 'residency.check-regions',
    kind: 'any',
    verification: 'I',
    applies: (item, ctx) => residencyOf(item, ctx) !== 'any',
    findings: (item, ctx) => [
      warning('multicloud.residency.check-regions', `Data must stay in ${labelOf(RESIDENCY_OPTIONS, residencyOf(item, ctx))}, and region coverage differs per platform and changes constantly.`, {
        remediation: 'Check each candidate’s current region list; this toolkit is offline and deliberately does not carry one.',
        source: 'ArchToolKit',
      }),
    ],
  }),

  rule          ({
    id: 'sovereignty.differs-in-shape',
    kind: 'any',
    verification: 'I',
    applies: (_item, ctx) => ctx.requirements.sovereignty !== 'none',
    findings: (_item, ctx) => [
      warning('multicloud.sovereignty.differs-in-shape', `${labelOf(SOVEREIGNTY_OPTIONS, ctx.requirements.sovereignty)}: all four hyperscalers offer something called sovereign, and the four offerings differ in who holds the keys, who operates the hardware and which law applies.`, {
        remediation: 'Compare the operating model rather than the label, and involve whoever owns the regulatory obligation.',
        source: 'ArchToolKit',
      }),
    ],
  }),

  rule          ({
    id: 'os.eol',
    kind: 'workload',
    verification: 'C',
    applies: (w, ctx) => {
      const s = supportStatus(w.os, ctx.today);
      return s === 'end-of-life' || s === 'extended';
    },
    findings: (w, ctx) => {
      const os = OS_CATALOG[w.os];
      const s = supportStatus(w.os, ctx.today);
      const upgrade = os.upgradeTo ? ` Upgrade to ${OS_CATALOG[os.upgradeTo].label}.` : '';
      return s === 'end-of-life'
        ? [warning('plan.os.eol', `${w.name}: ${os.label} is past the end of extended support (${os.endOfExtendedSupport ?? os.endOfStandardSupport}).${upgrade}`, { path: `workloads.${w.id}.os`, source: os.source })]
        : [info('plan.os.extended-support', `${w.name}: ${os.label} is past standard support (${os.endOfStandardSupport}) and on paid extended support until ${os.endOfExtendedSupport}.${upgrade}`, { path: `workloads.${w.id}.os`, source: os.source })];
    },
  }),

  rule          ({
    id: 'os.unknown',
    kind: 'workload',
    verification: 'I',
    applies: (w) => w.os === 'unknown',
    findings: (w) => [
      warning('plan.os.unknown', `${w.name}: the operating system is not known, so its image, licence and support date are not either.`, {
        path: `workloads.${w.id}.os`,
        remediation: 'Set the OS on the Workloads screen.',
      }),
    ],
  }),

  rule          ({
    id: 'db.version-eol',
    kind: 'database',
    verification: 'C',
    applies: (db, ctx) => isVersionEol(db.version, ctx.today),
    findings: (db) => {
      const v = DB_VERSIONS[db.version];
      return [
        warning('plan.db.version-eol', `${db.name}: ${db.version} is past the vendor's support (${v.endOfSupport}).${v.note ? ` ${v.note}` : ''}`, {
          path: `databases.${db.id}.version`,
          source: v.source,
        }),
      ];
    },
  }),

  rule          ({
    id: 'portfolio.cloud-differs',
    kind: 'any',
    verification: 'I',
    applies: (item, ctx) => ctx.appOf(item)?.portfolio?.cloud !== undefined,
    review: (item, chosen, ctx) => {
      const cloud = ctx.appOf(item)?.portfolio?.cloud;
      if (!cloud || !chosen) return [];
      const want = MIGRATION_CLOUD_PLATFORM[cloud];
      return want === chosen.platform
        ? []
        : [info('plan.portfolio.cloud-differs', `${item.name}: the Migration portfolio says ${want}; the decision says ${chosen.platform}.`, {
            remediation: 'Pin the item if the portfolio answer should stand.',
          })];
    },
  }),
];
