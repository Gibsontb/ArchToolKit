/**
 * Eliminations: rules that rule an option out rather than penalise it.
 *
 * An elimination is a statement that the option does not work (policy forbids
 * it, the service cannot carry the feature, the licence does not allow it),
 * not that it is worse. Each one names what it looked at, so the what-if can
 * show why an option is gone.
 */

import { HYPERSCALERS, isHyperscaler, platformInfo, type Platform } from '../../../platforms.ts';
import { vmwareCloudService } from '../../../vmware-on-cloud.ts';
import { DB_SERVICES, serviceLicences, unsupportedOn } from '../../db-catalog.ts';
import { imageFor, isUnavailable } from '../../images.ts';
import { DB_FEATURE_OPTIONS, labelOf } from '../../options.ts';
import type { Database, DbServiceId, Workload } from '../../types.ts';
import type { PlanItem } from '../disposition.ts';
import { rule, type AnyRule, type RuleContext } from '../engine.ts';

const short = (p: Platform): string => platformInfo(p).shortLabel;

/** Government-region names per hyperscaler. Google Cloud (GCP) has no separate government regions (Assured Workloads runs in commercial ones). */
export const GOVERNMENT_REGION: Readonly<Record<Exclude<Platform, 'vmware'>, RegExp>> = {
  aws: /^us-gov-/i,
  azure: /^(usgov|usdod)/i,
  google: /gov/i,
  oci: /^us-(langley|luke)-1$|gov/i,
};

/** The Oracle Database@ services: Oracle hardware, licensed as on OCI. */
export const ODB_SERVICES: readonly DbServiceId[] = ['aws-odb-exadata', 'aws-odb-adb', 'azure-odb-exadata', 'azure-odb-adb', 'google-odb-exadata', 'google-odb-adb', 'google-odb-basedb'];

function isProd(db: Database, ctx: RuleContext): boolean {
  const hosts = ctx.hostsOf(db);
  if (hosts.length > 0) return hosts.some((h) => h.env === 'prod');
  const app = ctx.appOf(db);
  return app ? app.criticality === 'tier0' || app.criticality === 'tier1' : true;
}

export const ELIMINATION_RULES: readonly AnyRule[] = [
  rule<PlanItem>({
    id: 'policy.excluded',
    kind: 'any',
    aliases: ['excluded-by-policy'],
    verification: 'I',
    applies: (_item, ctx) => ctx.requirements.allowed.length < 5,
    evaluate: (_item, o, ctx) =>
      ctx.requirements.allowed.includes(o.platform) ? undefined : { eliminate: true, reason: `Policy rules out ${short(o.platform)}.` },
  }),

  rule<PlanItem>({
    id: 'shape.physical-dongle',
    kind: 'any',
    aliases: ['physical-dongle'],
    verification: 'I',
    applies: (item, ctx) => ctx.appOf(item)?.special === 'physical-dongle',
    evaluate: (_item, o) =>
      o.platform === 'vmware'
        ? { delta: 4, reason: 'A physical licence dongle has to be attached to a host, which no hyperscaler offers. The workload stays on hardware you control.' }
        : { eliminate: true, reason: `A physical licence dongle cannot be attached on ${short(o.platform)}.` },
  }),

  rule<Workload>({
    id: 'shape.relocate-needs-vmware',
    kind: 'workload',
    verification: 'V-DOC',
    applies: (w, ctx) => ctx.placementOf(w).method === 'relocate-hcx',
    evaluate: (_w, o) => {
      if (o.platform === 'vmware') return { reason: 'Moves by HCX / vMotion onto VCF: the VM does not change.' };
      const svc = vmwareCloudService(o.platform);
      if (!svc) return { eliminate: true, reason: `${short(o.platform)} has no VMware service to relocate onto.` };
      return { reason: `Moves as a VM onto ${svc.name} (${svc.abbreviation}), not native instances: the guest does not change.` };
    },
  }),

  rule<Database>({
    id: 'db.rac-needs-exadata',
    kind: 'database',
    verification: 'C',
    source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
    applies: (db) => db.engine === 'oracle' && (db.ha === 'rac' || db.ha === 'rac-one-node'),
    evaluate: (_db, o, ctx) => {
      if (!o.service) return undefined;
      const allowed = ctx.facts['oracle.rac.iaas'].value;
      return allowed.includes(o.service)
        ? undefined
        : { eliminate: true, reason: `${DB_SERVICES[o.service].label} cannot run Oracle RAC: ${ctx.facts['oracle.rac.iaas'].statement}` };
    },
  }),

  rule<Database>({
    id: 'db.feature-unsupported',
    kind: 'database',
    verification: 'C',
    applies: (db) => db.features.length > 0,
    evaluate: (db, o) => {
      if (!o.service) return undefined;
      const gaps = unsupportedOn(o.service, db.features);
      if (gaps.length === 0) return undefined;
      return {
        eliminate: true,
        reason: `${DB_SERVICES[o.service].label} does not support ${gaps.map((f) => labelOf(DB_FEATURE_OPTIONS, f)).join(', ')}.`,
      };
    },
  }),

  rule<Database>({
    id: 'db.size-limit',
    kind: 'database',
    verification: 'C',
    applies: (db) => db.sizeGib > 0,
    evaluate: (db, o) => {
      if (!o.service) return undefined;
      const max = DB_SERVICES[o.service].maxStorageGib;
      return max !== undefined && db.sizeGib > max
        ? { eliminate: true, reason: `${db.sizeGib} GiB is over ${DB_SERVICES[o.service].label}'s ${max} GiB limit.` }
        : undefined;
    },
  }),

  rule<Database>({
    id: 'db.edition-mismatch',
    kind: 'database',
    verification: 'C',
    source: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_SQLServer.html',
    applies: (db, ctx) => db.engine === 'sqlserver' && (db.edition === 'sql-express' || db.edition === 'sql-developer') && isProd(db, ctx),
    evaluate: (db, o) =>
      o.service === 'aws-rds'
        ? { eliminate: true, reason: `SQL Server ${db.edition === 'sql-express' ? 'Express' : 'Developer'} is not a production edition on Amazon RDS.` }
        : undefined,
  }),

  rule<Database>({
    id: 'lic.oracle.se2-cap',
    kind: 'database',
    verification: 'C',
    source: 'https://www.oracle.com/a/ocom/docs/cloud-licensing-070579.pdf',
    applies: (db, ctx) =>
      db.engine === 'oracle' && db.edition === 'oracle-se2' && db.licence !== 'li' && db.vcpu > ctx.facts['oracle.ace.se2.max-vcpu'].value,
    evaluate: (db, o, ctx) => {
      if (!o.service || !ctx.facts['oracle.ace.clouds'].value.includes(o.platform) || ODB_SERVICES.includes(o.service)) return undefined;
      const cap = ctx.facts['oracle.ace.se2.max-vcpu'].value;
      const info = DB_SERVICES[o.service];
      if (info.managed && serviceLicences(o.service, 'oracle').includes('li')) {
        return { reason: `SE2 BYOL is capped at ${cap} vCPU in an Authorized Cloud Environment (this has ${db.vcpu}); ${info.label} stays open licence-included, and the owned licence is not used.` };
      }
      return { eliminate: true, reason: `SE2 BYOL is capped at ${cap} vCPU in an Authorized Cloud Environment; this has ${db.vcpu}, so ${info.label} is out.` };
    },
  }),

  rule<PlanItem>({
    id: 'residency.government',
    kind: 'any',
    verification: 'I',
    applies: (_item, ctx) => ctx.requirements.sovereignty === 'government-region',
    evaluate: (_item, o, ctx) => {
      if (!isHyperscaler(o.platform)) return undefined;
      const region = ctx.requirements.regions[o.platform]?.primary ?? '';
      const re = GOVERNMENT_REGION[o.platform as Exclude<Platform, 'vmware'>];
      return re.test(region)
        ? undefined
        : { eliminate: true, reason: `A government region is required and the ${short(o.platform)} region "${region || 'none'}" is not one.` };
    },
  }),

  rule<Workload>({
    id: 'os.no-image-rebuild',
    kind: 'workload',
    verification: 'C',
    applies: (w, ctx) => ctx.placementOf(w).method === 'rebuild',
    evaluate: (w, o) => {
      if (!HYPERSCALERS.includes(o.platform)) return undefined;
      const img = imageFor(w.os, o.platform, { licence: w.licence });
      return isUnavailable(img) ? { eliminate: true, reason: `A rebuild needs an image, and ${short(o.platform)}: ${img.unavailable}` } : undefined;
    },
  }),
];

