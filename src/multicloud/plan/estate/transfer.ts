/**
 * Data volume, bandwidth and transfer time (addendum A.10.10).
 *
 * The time a seed takes is AWS's large-migration formula (DataSync):
 *
 *   days = (DATA_SIZE bytes × 8) / (CIRCUIT bps × NETWORK_UTILIZATION × 3600 × AVAILABLE_HOURS)
 *
 * AWS's worked example: 100 TB over 1 Gbps at 80 % utilisation, 24 hours a
 * day, is about 11.57 days. Here the circuit is the site's bandwidth, the
 * utilisation the link efficiency (default 0.8, AWS's figure) times the
 * share given to migration (default 50 %, a setting).
 *
 * Per app, wave or site:
 *   volume       Σ used GiB of the items' disks (used where measured, else
 *                provisioned) and databases;
 *   daily change the measured write throughput (`mbpsP95` MB/s × 0.3 ×
 *                86 400 s, an assumption) or the change rate (default 5 % a
 *                day, a setting);
 *   seed days    by the formula; `transfer.seed-slow` above the setting
 *                (default 7 days);
 *   keep-up      daily change ≤ what the link moves in a day, else
 *                `transfer.cannot-keep-up`.
 *
 * When either fires, offline seeding is recommended by platform from the
 * device catalogue below, which respects the service status table
 * (methodology.ts): AWS Snowball Edge is closed to new customers, Azure Data
 * Box Heavy is retired and OCI's Data Transfer appliance is at end of life,
 * so none of them is offered. Offline seeding carries file, object and
 * database-backup data only: block replication tools (AWS Transform MGN,
 * Azure Migrate, Migrate to Virtual Machines, HCX) seed over the network, so
 * for those the finding recommends a faster link, a smaller wave or a
 * staggered start instead.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { serviceStatus, shouldWarn } from '../methodology.ts';
import { PLATFORM_LABELS } from '../options.ts';
import type { Bandwidth, Database, Plan, PlanDecision, Platform, ServiceStatusKind, Verification, Workload } from '../types.ts';

/** The formula's source. */
export const TRANSFER_FORMULA_SOURCE = 'https://docs.aws.amazon.com/datasync/latest/userguide/datasync-large-migration-timelines.html';

export const TRANSFER_DEFAULTS = Object.freeze({
  /** AWS's NETWORK_UTILIZATION in its worked example. */
  efficiency: 0.8,
  /** The share of the link given to migration (a setting). */
  share: 0.5,
  /** Change rate per day when no throughput is measured (a setting). */
  changeRatePct: 5,
  /** The fraction of measured disk throughput that is writes (an assumption). */
  writeFraction: 0.3,
  /** Seed days above which `transfer.seed-slow` fires (a setting). */
  seedDaysMax: 7,
  hoursPerDay: 24,
});

const GIB = 1024 ** 3;

/** Bits per second of a Bandwidth option. */
export function bandwidthBps(b: Bandwidth): number {
  const m = /^(\d+)([mg])$/.exec(b);
  if (!m) return 0;
  return Number(m[1]) * (m[2] === 'g' ? 1e9 : 1e6);
}

/** AWS's formula: days to move `bytes` over `bps` at `utilisation`, `hoursPerDay` hours a day. */
export function transferDays(bytes: number, bps: number, utilisation: number, hoursPerDay = 24): number {
  if (bytes <= 0) return 0;
  const denom = bps * utilisation * 3600 * hoursPerDay;
  return denom > 0 ? (bytes * 8) / denom : Infinity;
}

// ---------------------------------------------------------------------------
// Offline devices
// ---------------------------------------------------------------------------

export interface OfflineDevice {
  readonly id: string;
  readonly platform: Platform;
  readonly name: string;
  /** Usable capacity per device or order, TB (decimal), where the vendor states one. */
  readonly usableTb?: number;
  readonly note: string;
  /** The service status entry id it follows, when it has one. */
  readonly statusId?: string;
  /** The standing when no status entry covers it. */
  readonly status: ServiceStatusKind;
  readonly source: string;
  readonly verification: Verification;
}

/**
 * The offline transfer catalogue (research 2026-09-26: cloud-migration-methodologies.md
 * 1.7, 2.7, 3.7, 4.7). Capacities are the vendors' published figures; the
 * product lines changed in 2024–2026, so re-check before ordering.
 */
export const OFFLINE_DEVICES: readonly OfflineDevice[] = Object.freeze([
  {
    id: 'aws-snowball-edge', platform: 'aws', name: 'AWS Snowball Edge', statusId: 'aws-snowball-edge', status: 'closed-to-new-customers',
    note: 'No longer available to new customers; not offered.',
    source: 'https://docs.aws.amazon.com/snowball/latest/developer-guide/snowball-edge-availability-change.html', verification: 'V-DOC',
  },
  {
    id: 'aws-data-transfer-terminal', platform: 'aws', name: 'AWS Data Transfer Terminal', status: 'available',
    note: 'You bring your own storage devices to an AWS facility and upload over its high-speed connection; or use a partner offline service.',
    source: 'https://docs.aws.amazon.com/snowball/latest/developer-guide/snowball-edge-availability-change.html', verification: 'V-DOC',
  },
  {
    id: 'azure-data-box', platform: 'azure', name: 'Azure Data Box (next generation)', usableTb: 525, status: 'available',
    note: '120 TB or 525 TB usable per device; suited to more than 40 TB. Import and export.',
    source: 'https://learn.microsoft.com/en-us/azure/databox/data-box-overview', verification: 'V-DOC',
  },
  {
    id: 'azure-data-box-disk', platform: 'azure', name: 'Azure Data Box Disk', usableTb: 35, status: 'available',
    note: '1–5 SSDs of 8 TB, about 35 TB usable per order; import only.',
    source: 'https://learn.microsoft.com/en-us/azure/databox/data-box-disk-overview', verification: 'V-DOC',
  },
  {
    id: 'azure-data-box-heavy', platform: 'azure', name: 'Azure Data Box Heavy', statusId: 'azure-data-box-heavy', status: 'retired',
    note: 'Retired; not offered.',
    source: 'https://learn.microsoft.com/en-us/azure/databox/data-box-overview', verification: 'V-DOC',
  },
  {
    id: 'google-transfer-appliance', platform: 'google', name: 'Google Transfer Appliance', usableTb: 300, status: 'available',
    note: 'TA40 / TA40F (40 TB class) and TA300 / TA300F (300 TB); Google suggests it when a network upload would take more than about a week.',
    source: 'https://docs.cloud.google.com/transfer-appliance/docs/4.0/specifications', verification: 'V-DOC',
  },
  {
    id: 'oci-data-transfer', platform: 'oci', name: 'OCI Data Transfer (disk and appliance)', statusId: 'oci-data-transfer', status: 'retired',
    note: 'End of life on 2025-02-06; not offered.',
    source: 'https://docs.oracle.com/en-us/iaas/releasenotes/datatransfer/eol.htm', verification: 'V-DOC',
  },
  {
    id: 'oci-roving-edge', platform: 'oci', name: 'OCI Roving Edge as a Data Transfer Gateway', usableTb: 45, status: 'available',
    note: 'Up to 45 TB; Oracle also names Seagate Lyve and `oci os object sync`.',
    source: 'https://docs.oracle.com/en-us/iaas/Content/DataTransfer/home.htm', verification: 'V-DOC',
  },
]);

/** A device's standing, from the service status table when it has an entry. */
export function deviceStatus(d: OfflineDevice): ServiceStatusKind {
  return (d.statusId ? serviceStatus(d.statusId)?.status : undefined) ?? d.status;
}

/** Devices that can be ordered on a platform today (closed, retired and removed ones left out). */
export function offlineOptions(platform: Platform): OfflineDevice[] {
  return OFFLINE_DEVICES.filter((d) => d.platform === platform && !(d.statusId ? shouldWarn(d.statusId) : ['closed-to-new-customers', 'end-of-support', 'retired', 'removed'].includes(d.status)));
}

/** Devices that are not offered on a platform, and why (for the report's note). */
export function offlineWithdrawn(platform: Platform): OfflineDevice[] {
  return OFFLINE_DEVICES.filter((d) => d.platform === platform && !offlineOptions(platform).includes(d));
}

// ---------------------------------------------------------------------------
// The calculator
// ---------------------------------------------------------------------------

export type TransferGroupBy = 'app' | 'wave' | 'site';

export interface TransferOptions {
  readonly groupBy?: TransferGroupBy;
  /** The site the data leaves from (default: the first); its bandwidth is the link. */
  readonly site?: string;
  /** A link in Mbit/s, overriding the site's bandwidth. */
  readonly linkMbps?: number;
  readonly efficiency?: number;
  readonly share?: number;
  readonly changeRatePct?: number;
  readonly seedDaysMax?: number;
  readonly hoursPerDay?: number;
}

export type DataClass = 'block' | 'file' | 'database';

export interface TransferItem {
  readonly id: string;
  readonly name: string;
  readonly platform?: Platform;
  readonly dataClass: DataClass;
  readonly gib: number;
  readonly dailyChangeGib: number;
  /** How daily change was found: measured throughput or the change-rate setting. */
  readonly changeBasis: 'measured' | 'rate';
}

export interface TransferGroup {
  readonly key: string;
  readonly items: readonly TransferItem[];
  readonly volumeGib: number;
  readonly dailyChangeGib: number;
  readonly linkMbps: number;
  /** The link after efficiency and share, in Mbit/s. */
  readonly effectiveMbps: number;
  readonly seedDays: number;
  /** GiB the link moves in a day. */
  readonly linkGibPerDay: number;
  readonly keepsUp: boolean;
  readonly seedSlow: boolean;
  /** Offline options per platform the group lands on, when a finding fired and offline data exists. */
  readonly offline: Readonly<Partial<Record<Platform, readonly OfflineDevice[]>>>;
  readonly findings: readonly Finding[];
}

export interface TransferPlan {
  readonly groups: readonly TransferGroup[];
  readonly findings: readonly Finding[];
  readonly assumptions: readonly string[];
  readonly source: string;
}

function usedGib(w: Workload): number {
  const used = w.facts?.disksUsedGib;
  if (used && used.length > 0) return used.reduce((s, x) => s + x, 0);
  return w.disksGib.reduce((s, x) => s + x, 0);
}

function classOf(w: Workload, method: string | undefined): DataClass {
  if (method === 'rebuild' && (w.role === 'file' || w.workloadType === 'file-server' || w.workloadType === 'nas-gateway')) return 'file';
  return 'block';
}

/**
 * The transfer plan for the items that move (not retired, retained or new),
 * grouped by app, wave or site.
 */
export function transferPlan(plan: Plan, decision: PlanDecision | undefined, options: TransferOptions = {}): TransferPlan {
  const o = { ...TRANSFER_DEFAULTS, ...stripUndefined(options) };
  const groupBy = options.groupBy ?? 'app';
  const site = options.site ? plan.requirements.sites.find((s) => s.name === options.site) : plan.requirements.sites[0];
  const linkMbps = options.linkMbps ?? (site ? bandwidthBps(site.bandwidth) / 1e6 : 0);
  const findings: Finding[] = [];
  if (linkMbps <= 0) {
    findings.push(info('transfer.no-link', 'No site bandwidth is set, so transfer times cannot be worked out.', { path: 'requirements.sites', remediation: 'Give the site its bandwidth on the Sites grid.' }));
  }
  const moving = (id: string): { platform?: Platform; method?: string } | null => {
    const d = decision?.items[id];
    if (d && (d.method === 'none' || d.disposition === 'new')) return null;
    return { ...(d?.chosen ? { platform: d.chosen.platform } : {}), ...(d ? { method: d.method } : {}) };
  };
  const items: { item: TransferItem; app: string; wave: string }[] = [];
  const appOf = new Map(plan.apps.map((a) => [a.name, a]));
  const waveOf = (appName: string): string => {
    const w = appOf.get(appName)?.wave;
    return w === undefined ? 'unwaved' : `wave ${w}`;
  };
  const change = (gib: number, mbpsP95: number | undefined): { gib: number; basis: 'measured' | 'rate' } => (mbpsP95 !== undefined
    ? { gib: (mbpsP95 * 1e6 * o.writeFraction * 86400) / GIB, basis: 'measured' }
    : { gib: gib * o.changeRatePct / 100, basis: 'rate' });
  const managedHosts = new Set<string>();
  for (const db of plan.databases) {
    const m = moving(db.id);
    if (!m) continue;
    if (m.method === 'managed-db') for (const h of db.hosts) managedHosts.add(h);
  }
  for (const w of plan.workloads) {
    if (w.synthetic) continue;
    const m = moving(w.id);
    if (!m || m.method === 'managed-db') continue;
    const gib = usedGib(w);
    const c = change(gib, w.facts?.utilisation?.mbpsP95);
    items.push({
      item: { id: w.id, name: w.name, ...(m.platform ? { platform: m.platform } : {}), dataClass: classOf(w, m.method), gib, dailyChangeGib: c.gib, changeBasis: c.basis },
      app: w.app, wave: waveOf(w.app),
    });
  }
  for (const db of plan.databases) {
    const m = moving(db.id);
    if (!m || m.method !== 'managed-db') continue; // IaaS databases move with their host's disks
    const c = change(db.sizeGib, undefined);
    items.push({
      item: { id: db.id, name: db.name, ...(m.platform ? { platform: m.platform } : {}), dataClass: 'database', gib: db.sizeGib, dailyChangeGib: c.gib, changeBasis: c.basis },
      app: db.app, wave: waveOf(db.app),
    });
  }
  const keyOf = (x: { app: string; wave: string }): string => (groupBy === 'app' ? x.app : groupBy === 'wave' ? x.wave : site?.name ?? 'site');
  const byKey = new Map<string, TransferItem[]>();
  for (const x of items) {
    const k = keyOf(x);
    byKey.set(k, [...(byKey.get(k) ?? []), x.item]);
  }
  const effectiveMbps = linkMbps * o.efficiency * o.share;
  const groups: TransferGroup[] = [];
  for (const [key, list] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const volumeGib = list.reduce((s, i) => s + i.gib, 0);
    const dailyChangeGib = list.reduce((s, i) => s + i.dailyChangeGib, 0);
    const seedDays = transferDays(volumeGib * GIB, linkMbps * 1e6, o.efficiency * o.share, o.hoursPerDay);
    const linkGibPerDay = (effectiveMbps * 1e6 * 3600 * o.hoursPerDay) / 8 / GIB;
    const keepsUp = dailyChangeGib <= linkGibPerDay;
    const seedSlow = seedDays > o.seedDaysMax;
    const gf: Finding[] = [];
    const platforms = [...new Set(list.map((i) => i.platform).filter((p): p is Platform => !!p))];
    const offlineData = list.filter((i) => i.dataClass !== 'block');
    const blockOnly = offlineData.length === 0;
    const offline: Partial<Record<Platform, readonly OfflineDevice[]>> = {};
    if ((seedSlow || !keepsUp) && !blockOnly) {
      for (const p of platforms) {
        const opts = offlineOptions(p);
        if (opts.length > 0) offline[p] = opts;
      }
    }
    const advice = blockOnly
      ? 'Block replication (AWS Transform MGN, Azure Migrate, Migrate to Virtual Machines, HCX) seeds over the network: give migration a larger share of the link, add bandwidth, split the group into smaller waves or stagger the starts.'
      : `Seed the file and database-backup data offline (${platforms.map((p) => `${PLATFORM_LABELS[p]}: ${offlineOptions(p).map((d) => d.name).join(', ') || 'no offline device'}`).join('; ') || 'no platform yet'}), or add bandwidth; block-replicated servers still seed over the network.`;
    if (seedSlow) {
      gf.push(warning('transfer.seed-slow', `${key}: seeding ${round1(volumeGib / 1024)} TiB over ${round1(linkMbps)} Mbit/s (${round1(effectiveMbps)} Mbit/s for migration) takes ${round1(seedDays)} days, over the ${o.seedDaysMax}-day setting.`, {
        remediation: advice, source: TRANSFER_FORMULA_SOURCE,
      }));
    }
    if (!keepsUp) {
      gf.push(warning('transfer.cannot-keep-up', `${key}: about ${round1(dailyChangeGib)} GiB changes a day, more than the ${round1(linkGibPerDay)} GiB a day the migration share of the link moves; replication would fall behind.`, {
        remediation: `Upgrade the link, stagger the wave or seed offline. ${advice}`, source: TRANSFER_FORMULA_SOURCE,
      }));
    }
    for (const p of platforms) {
      const gone = offlineWithdrawn(p);
      if ((seedSlow || !keepsUp) && gone.length > 0 && !blockOnly) {
        gf.push(info('transfer.device-withdrawn', `${PLATFORM_LABELS[p]}: ${gone.map((d) => `${d.name} (${deviceStatus(d)})`).join(', ')} not offered.`, { source: gone[0]!.source }));
      }
    }
    groups.push({ key, items: list, volumeGib: round1(volumeGib), dailyChangeGib: round1(dailyChangeGib), linkMbps, effectiveMbps: round1(effectiveMbps), seedDays: round2(seedDays), linkGibPerDay: round1(linkGibPerDay), keepsUp, seedSlow, offline, findings: gf });
    findings.push(...gf);
  }
  return {
    groups,
    findings,
    assumptions: [
      `Link efficiency ${o.efficiency} (AWS's NETWORK_UTILIZATION example) × migration share ${Math.round(o.share * 100)} %.`,
      `Daily change: measured disk throughput × ${o.writeFraction} writes × 86 400 s (an assumption), else ${o.changeRatePct} % of the volume a day (a setting).`,
      `Seed-slow above ${o.seedDaysMax} days; ${o.hoursPerDay} transfer hours a day.`,
    ],
    source: TRANSFER_FORMULA_SOURCE,
  };
}

/** The items of a plan with their volumes, for callers that group differently. */
export function dataVolumeGib(items: { readonly workloads: readonly Workload[]; readonly databases: readonly Database[] }): number {
  return items.workloads.reduce((s, w) => s + usedGib(w), 0) + items.databases.reduce((s, d) => s + d.sizeGib, 0);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
