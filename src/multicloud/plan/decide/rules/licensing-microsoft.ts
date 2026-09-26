/**
 * Microsoft licensing: Azure Hybrid Benefit, the Flexible Virtualization
 * Benefit at OCI, dedicated hosts for pre-2019 Windows at the Listed
 * Providers, SQL Server Licence Mobility, and free ESUs on Azure.
 *
 * Every figure comes from `LICENSING_FACTS` (section 2.4.3); the rules only
 * decide which fact applies to which option.
 */

import { info, warning } from '../../../../core/findings.ts';
import { platformInfo } from '../../../platforms.ts';
import { osKind } from '../../os.ts';
import type { Database, DbServiceId, Workload } from '../../types.ts';
import type { PlanItem } from '../disposition.ts';
import { isDatabase } from '../disposition.ts';
import { rule, type AnyRule, type RuleContext } from '../engine.ts';

const AHB_SQL: readonly DbServiceId[] = ['azure-sqlmi', 'azure-sqlvm', 'azure-sqldb'];

const isWindows = (w: Workload): boolean => osKind(w.os) === 'windows';
const hasSa = (ctx: RuleContext): boolean => ctx.requirements.licensing.microsoftSa !== 'no';
const keptAsIs = (w: Workload, ctx: RuleContext): boolean => {
  const m = ctx.placementOf(w).method;
  return m === 'replicate' || m === 'relocate-hcx';
};

export const MICROSOFT_RULES: readonly AnyRule[] = [
  rule<PlanItem>({
    id: 'lic.ms.ahb',
    kind: 'any',
    aliases: ['microsoft-licensing'],
    verification: 'V-DOC',
    source: 'https://azure.microsoft.com/pricing/hybrid-benefit/',
    applies: (item, ctx) => hasSa(ctx) && (isDatabase(item) ? item.engine === 'sqlserver' : isWindows(item)),
    evaluate: (item, o) => {
      if (isDatabase(item)) {
        return o.service && AHB_SQL.includes(o.service)
          ? { delta: 2, reason: 'SQL Server licences with Software Assurance apply to Azure through Azure Hybrid Benefit, with a free passive DR replica.' }
          : undefined;
      }
      return o.platform === 'azure'
        ? { delta: 3, reason: 'Windows Server and SQL Server licences with active Software Assurance can be applied to Azure compute, which the other platforms cannot do for you.' }
        : undefined;
    },
  }),

  rule<PlanItem>({
    id: 'lic.ms.fvb',
    kind: 'any',
    verification: 'C',
    source: 'https://samexpert.com/flexible-virtualization/',
    applies: (item) => (isDatabase(item) ? item.engine === 'sqlserver' && item.licence === 'byol-sa' : isWindows(item) && item.licence === 'byol-sa'),
    evaluate: (item, o) => {
      if (o.platform !== 'oci') return undefined;
      if (isDatabase(item) && o.service !== 'oci-compute') return undefined;
      return { delta: 1, reason: 'OCI is not a Listed Provider, so licences with Software Assurance can be brought there under the Flexible Virtualization Benefit.' };
    },
  }),

  rule<Workload>({
    id: 'lic.ms.dedicated-host',
    kind: 'workload',
    verification: 'C',
    source: 'https://samexpert.com/windows-server-byol-azure-vs-spla-vs-csp/',
    applies: (w, ctx) => isWindows(w) && w.licence === 'byol-perpetual' && ctx.placementOf(w).method !== 'relocate-hcx' && ctx.placementOf(w).method !== 'none',
    evaluate: (_w, o, ctx) => {
      if (o.platform !== 'aws' && o.platform !== 'google') return undefined;
      return ctx.requirements.licensing.windowsPre2019Licences
        ? { delta: 1, reason: `Windows licences bought before 2019-10-01 can be brought to ${platformInfo(o.platform).shortLabel} on a dedicated host or sole-tenant node.` }
        : { reason: `Without pre-2019 licences, Windows at ${platformInfo(o.platform).shortLabel} is licence-included: the owned licence is stranded.` };
    },
    findings: (w, ctx) =>
      ctx.requirements.licensing.windowsPre2019Licences
        ? []
        : [warning('plan.licence.stranded', `${w.name}: Windows licences without Software Assurance cannot be brought to AWS or Google Cloud (GCP) shared tenancy; there they are licence-included and the owned licence is stranded.`, {
            path: `workloads.${w.id}.licence`,
            source: ctx.facts['ms.windows.byol-listed'].source,
          })],
  }),

  rule<Database>({
    id: 'lic.ms.sql-mobility',
    kind: 'database',
    verification: 'C',
    source: 'https://www.microsoft.com/licensing/licensing-programs/software-assurance-license-mobility',
    applies: (db) => db.engine === 'sqlserver' && db.licence === 'byol-sa',
    evaluate: (_db, o, ctx) => {
      if (o.service && ctx.facts['ms.licence-mobility.sql'].value.includes(o.service)) {
        return { delta: 1, reason: 'SQL Server with Software Assurance moves to this VM through Licence Mobility.' };
      }
      if (o.service === 'aws-rds' || o.service === 'google-cloudsql') {
        return { reason: 'Licence included only: the owned licence is not used.' };
      }
      return undefined;
    },
  }),

  rule<Database>({
    id: 'lic.ms.sql-sa-position',
    kind: 'database',
    verification: 'I',
    applies: (db, ctx) => db.engine === 'sqlserver' && ctx.requirements.licensing.microsoftSa === 'no',
    findings: () => [
      info('multicloud.sqlserver.licensing', 'SQL Server licensing dominates the cost of a Windows estate, and the answer differs per platform depending on whether Software Assurance is current.', {
        remediation: 'Establish the Software Assurance position before comparing prices.',
        source: 'ArchToolKit',
      }),
    ],
  }),

  rule<PlanItem>({
    id: 'lic.ms.esu-free',
    kind: 'any',
    verification: 'C',
    source: 'https://www.microsoft.com/en-us/windows-server/extended-security-updates',
    applies: (item, ctx) => {
      const free = ctx.facts['ms.esu.azure-free'].value;
      return isDatabase(item) ? item.engine === 'sqlserver' && free.sql.includes(item.version) : free.os.includes(item.os) && keptAsIs(item, ctx);
    },
    evaluate: (item, o) => {
      if (o.platform !== 'azure') return undefined;
      if (isDatabase(item) && o.service === undefined) return undefined;
      return { delta: 2, reason: 'Extended Security Updates are free on Azure for Windows Server 2012 / 2012 R2 and SQL Server 2014.' };
    },
    findings: (item) => [
      info('plan.licence.esu-paid', `${item.name}: kept as it is, it needs Extended Security Updates, which are paid everywhere except Azure.`, {
        remediation: 'Upgrade after landing, or budget the ESUs.',
        source: 'https://www.microsoft.com/en-us/windows-server/extended-security-updates',
      }),
    ],
  }),
];
