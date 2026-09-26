/**
 * Licence reclaim (addendum A.10.8): the ledger of what the move frees.
 *
 * At decommission, per item, from the source row and the design:
 *  - Windows Server cores freed (per VM by the core model: max(8, vCPU));
 *  - SQL Server cores (max(4, vCPU));
 *  - Oracle processors: all hosts of the Oracle cluster, once it empties
 *    (licensing on VMware counts every host the VM could run on);
 *  - RHEL / SLES subscriptions (one per VM);
 *  - VCF cores, when hosts are removed (from the VCF sizing);
 *  - third-party licences from the coupling licence bindings.
 *
 * Only licences the organisation owned are freed: an item that already runs
 * licence-included in a cloud frees nothing. The ledger rows are the tracker's
 * `LicenceReclaim`: Licence | Count | Source | Freed on | Reassigned to | Status.
 * BYOL portability is shown against the target need, e.g. "SQL Server 16
 * cores freed; 8 needed on Amazon Web Services via Licence Mobility".
 */

import { PLATFORM_INFO } from '../../platforms.ts';
import { labelOf, LICENCE_RECLAIM_STATUS_OPTIONS, RECLAIMED_LICENCE_OPTIONS } from '../options.ts';
import { osInfo } from '../os.ts';
import type {
  Database, ItemId, LicenceModel, LicenceNeed, LicenceReclaim, Plan, Platform, ReclaimedLicence, SourcePlatform, Tracker, Workload,
} from '../types.ts';

const CLOUD_ORIGINS: ReadonlySet<SourcePlatform> = new Set(['aws', 'azure', 'google', 'oci']);
/** An item on owned infrastructure (anything but a hyperscaler) holds its own licences. */
export const ownsLicences = (w: Pick<Workload, 'origin'>): boolean => !CLOUD_ORIGINS.has(w.origin ?? 'vsphere');

export interface OracleCluster {
  readonly name: string;
  readonly hosts: number;
  readonly coresPerHost: number;
  /** Oracle's core factor for the processors (0.5 for x86). */
  readonly coreFactor?: number;
  /** The Oracle items (database or workload ids) the cluster carries. */
  readonly items: readonly ItemId[];
}

export interface ReclaimOptions {
  /** Oracle clusters on VMware: their processors free when every item on them is decommissioned. */
  readonly oracleClusters?: readonly OracleCluster[];
  /** VCF cores freed by host removals (from computeLicensing), with the date. */
  readonly vcfCores?: { readonly count: number; readonly freedOn: string; readonly source: string };
  /** Third-party licences bound to items (the coupling licence bindings). */
  readonly thirdParty?: readonly { readonly item: ItemId; readonly licence: string; readonly count: number }[];
}

/** What one decommissioned item frees (Oracle clusters are handled at ledger level). */
export function reclaimForItem(item: Workload | Database, freedOn: string, plan: Pick<Plan, 'workloads'>): LicenceReclaim[] {
  const out: LicenceReclaim[] = [];
  if ('engine' in item) {
    const hosts = plan.workloads.filter((w) => item.hosts.includes(w.name));
    if (hosts.length > 0 && !hosts.some(ownsLicences)) return out;
    if (item.engine === 'sqlserver' && !['sql-express', 'sql-developer'].includes(item.edition) && item.licence !== 'li') {
      out.push({ licence: 'sql-core', count: Math.max(4, item.vcpu), source: item.name, freedOn, status: 'freed' });
    }
    return out;
  }
  if (!ownsLicences(item)) return out;
  const os = osInfo(item.os);
  if (os.kind === 'windows' && item.os !== 'windows-client') out.push({ licence: 'windows-core', count: Math.max(8, item.vcpu), source: item.name, freedOn, status: 'freed' });
  if (item.os.startsWith('rhel-')) out.push({ licence: 'rhel', count: 1, source: item.name, freedOn, status: 'freed' });
  if (item.os.startsWith('sles-')) out.push({ licence: 'sles', count: 1, source: item.name, freedOn, status: 'freed' });
  return out;
}

const key = (r: Pick<LicenceReclaim, 'licence' | 'source'>): string => `${r.licence}\u0000${r.source}`;

/**
 * The ledger: the tracker's rows, plus a new row for everything each
 * decommission frees that is not in it yet. Existing rows (with their
 * reassignment and status) are kept as they are.
 */
export function reclaimLedger(plan: Plan, tracker: Pick<Tracker, 'decommissions' | 'licences'>, options: ReclaimOptions = {}): LicenceReclaim[] {
  const rows = new Map<string, LicenceReclaim>(tracker.licences.map((r) => [key(r), r]));
  const add = (r: LicenceReclaim) => {
    if (!rows.has(key(r))) rows.set(key(r), r);
  };
  const byId = new Map<string, Workload | Database>([...plan.workloads, ...plan.databases].map((i) => [i.id, i]));
  const done = new Map(tracker.decommissions.map((d) => [d.item, d.at.slice(0, 10)]));
  for (const [id, at] of done) {
    const item = byId.get(id);
    if (item) for (const r of reclaimForItem(item, at, plan)) add(r);
  }
  for (const c of options.oracleClusters ?? []) {
    if (c.items.length === 0 || !c.items.every((i) => done.has(i))) continue;
    const at = c.items.map((i) => done.get(i) as string).sort().pop() as string;
    add({ licence: 'oracle-processor', count: Math.ceil(c.hosts * c.coresPerHost * (c.coreFactor ?? 0.5)), source: `cluster ${c.name}`, freedOn: at, status: 'freed' });
  }
  if (options.vcfCores && options.vcfCores.count > 0) add({ licence: 'vcf-core', count: options.vcfCores.count, source: options.vcfCores.source, freedOn: options.vcfCores.freedOn, status: 'freed' });
  for (const t of options.thirdParty ?? []) {
    const at = done.get(t.item);
    if (at) add({ licence: 'third-party', count: t.count, source: `${t.licence} (${byId.get(t.item)?.name ?? t.item})`, freedOn: at, status: 'freed' });
  }
  return [...rows.values()].sort((a, b) => a.freedOn.localeCompare(b.freedOn) || a.licence.localeCompare(b.licence) || a.source.localeCompare(b.source));
}

export const LEDGER_COLUMNS = Object.freeze(['Licence', 'Count', 'Source', 'Freed on', 'Reassigned to', 'Status'] as const);

const csvField = (t: string): string => (/[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
export function ledgerCsv(rows: readonly LicenceReclaim[]): string {
  const lines = [LEDGER_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([labelOf(RECLAIMED_LICENCE_OPTIONS, r.licence), String(r.count), r.source, r.freedOn, r.reassignedTo ?? '', labelOf(LICENCE_RECLAIM_STATUS_OPTIONS, r.status)].map(csvField).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Totals per licence kind and status: the "freed" columns for the base licences.csv and the reports tile. */
export function ledgerTotals(rows: readonly LicenceReclaim[]): Record<ReclaimedLicence, { freed: number; reassigned: number; terminated: number }> {
  const out = {} as Record<ReclaimedLicence, { freed: number; reassigned: number; terminated: number }>;
  for (const r of rows) {
    const t = out[r.licence] ?? { freed: 0, reassigned: 0, terminated: 0 };
    t[r.status] += r.count;
    out[r.licence] = t;
  }
  return out;
}

const MODEL_TEXT: Readonly<Partial<Record<LicenceModel, string>>> = {
  byol: 'bring your own licence', ahb: 'Azure Hybrid Benefit', 'licence-mobility': 'Licence Mobility', fvb: 'Flexible Virtualization Benefit',
  'dedicated-host': 'a dedicated host', li: 'licence-included (the freed licences are not needed there)',
};
const UNIT: Readonly<Partial<Record<ReclaimedLicence, string>>> = {
  'windows-core': 'Windows Server cores', 'sql-core': 'SQL Server cores', 'oracle-processor': 'Oracle processors', rhel: 'RHEL subscriptions', sles: 'SLES subscriptions',
};

/** "SQL Server cores 16 freed; 8 needed on Amazon Web Services via Licence Mobility." */
export function portabilityLine(freed: Pick<LicenceReclaim, 'licence' | 'count'>, need: LicenceNeed | undefined, platform: Platform): string {
  const unit = UNIT[freed.licence] ?? labelOf(RECLAIMED_LICENCE_OPTIONS, freed.licence);
  const target = PLATFORM_INFO[platform].label;
  if (!need || need.kind === 'none' || need.count === 0) return `${unit}: ${freed.count} freed; none needed on ${target}.`;
  const how = MODEL_TEXT[need.model] ?? need.model;
  const spare = freed.count - need.count;
  return `${unit}: ${freed.count} freed; ${need.count} needed on ${target} via ${how}${spare >= 0 ? ` (${spare} spare)` : ` (${-spare} short)`}.`;
}
