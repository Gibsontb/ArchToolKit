/**
 * The user's own rate card (addendum A.10.7).
 *
 * The toolkit is offline and carries no prices: a built-in price list would be
 * a confident wrong answer. What it carries is a rate card the user supplies,
 * imported or entered, stored in IndexedDB `plan` / key `ratecard` (store.ts)
 * and exported as ratecard.csv:
 *
 *   platform,region,category,key,unit,rate,currency,source
 *
 * The estimator (WP-19 `estate/estimate.ts`) multiplies sized counts by the
 * matching rates through `findRate`; unmatched counts are listed as "no rate".
 * Every figure carries "estimate from your rates (source: …)". Run cost and
 * one-time migration cost stay separate (category `service` rows with unit
 * `one-time` are the migration cost; the rest are run cost). The on-premises
 * run-rate being exited is the `on-prem` / `facility` rows.
 */

import { parseCsv } from '../../../core/csv.ts';
import { error, warning, type Finding } from '../../../core/findings.ts';
import { PLATFORMS } from '../../platforms.ts';
import type { Database, OsLicence, Plan, Platform, RateCard, RateCategory, RateRow, TargetDesign } from '../types.ts';
import { RATECARD_KIND } from '../types.ts';

export const RATECARD_COLUMNS = Object.freeze(['platform', 'region', 'category', 'key', 'unit', 'rate', 'currency', 'source'] as const);
export const RATECARD_HEADER = RATECARD_COLUMNS.join(',');
export const RATE_CATEGORIES: readonly RateCategory[] = Object.freeze(['compute', 'storage', 'db', 'network', 'licence', 'service', 'facility']);
/** Units that make a row a one-time (migration) cost rather than a run cost. */
export const ONE_TIME_UNITS: ReadonlySet<string> = new Set(['one-time', 'each', 'per-migration', 'per-server']);

export const estimateLabel = (source: string): string => `estimate from your rates (source: ${source || 'not given'})`;

export function emptyRateCard(): RateCard {
  return { kind: RATECARD_KIND, v: 1, rows: [] };
}

const csvField = (t: string): string => (/[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
export function rateCardCsv(card: Pick<RateCard, 'rows'>): string {
  const lines = [RATECARD_HEADER];
  for (const r of card.rows) lines.push([r.platform, r.region, r.category, r.key, r.unit, String(r.rate), r.currency, r.source].map(csvField).join(','));
  return `${lines.join('\n')}\n`;
}

/** Read ratecard.csv. Rows with a bad platform, category or rate are skipped with a finding. */
export function parseRateCard(text: string): { card: RateCard; findings: Finding[] } {
  const table = parseCsv(text);
  const idx = new Map(table.headers.map((h, i) => [h.trim().toLowerCase(), i]));
  const findings: Finding[] = [];
  const missing = RATECARD_COLUMNS.filter((c) => c !== 'source' && !idx.has(c));
  if (missing.length > 0) return { card: emptyRateCard(), findings: [error('ratecard.columns', `The rate card has no ${missing.join(', ')} column.`, { remediation: `Use the header: ${RATECARD_HEADER}` })] };
  const get = (row: readonly string[], c: string) => (row[idx.get(c) ?? -1] ?? '').trim();
  const rows: RateRow[] = [];
  table.rows.forEach((row, i) => {
    const line = i + 2;
    const platform = get(row, 'platform');
    const category = get(row, 'category') as RateCategory;
    const rateText = get(row, 'rate').replace(/,/g, '');
    if (platform !== 'on-prem' && !PLATFORMS.includes(platform as Platform)) {
      findings.push(warning('ratecard.platform', `Line ${line}: "${platform}" is not a platform (${[...PLATFORMS, 'on-prem'].join(', ')}).`));
      return;
    }
    if (!RATE_CATEGORIES.includes(category)) {
      findings.push(warning('ratecard.category', `Line ${line}: "${category}" is not a category (${RATE_CATEGORIES.join(', ')}).`));
      return;
    }
    if (rateText === '') return; // a template row not filled in yet
    const rate = Number(rateText);
    if (!Number.isFinite(rate) || rate < 0) {
      findings.push(warning('ratecard.rate', `Line ${line}: "${rateText}" is not a rate.`));
      return;
    }
    rows.push({ platform: platform as Platform | 'on-prem', region: get(row, 'region'), category, key: get(row, 'key'), unit: get(row, 'unit'), rate, currency: get(row, 'currency') || 'USD', source: get(row, 'source') });
  });
  const currencies = new Set(rows.map((r) => r.currency));
  if (currencies.size > 1) findings.push(warning('ratecard.currencies', `The rate card mixes currencies (${[...currencies].join(', ')}); totals are per currency.`));
  return { card: { kind: RATECARD_KIND, v: 1, rows }, findings };
}

export interface RateQuery { readonly platform: Platform | 'on-prem'; readonly region?: string; readonly category: RateCategory; readonly key: string }

/**
 * The rate for a count: an exact region match first, then a region-less row
 * ('' or '*'). Keys compare case-insensitively. undefined = "no rate".
 */
export function findRate(card: Pick<RateCard, 'rows'>, q: RateQuery): RateRow | undefined {
  const k = q.key.toLowerCase();
  const candidates = card.rows.filter((r) => r.platform === q.platform && r.category === q.category && r.key.toLowerCase() === k);
  return candidates.find((r) => q.region && r.region === q.region) ?? candidates.find((r) => r.region === '' || r.region === '*');
}

export interface TemplateKey { readonly platform: Platform | 'on-prem'; readonly region: string; readonly category: RateCategory; readonly key: string; readonly unit: string }

const LICENCE_KEYS: Readonly<Partial<Record<OsLicence, string>>> = { 'rhel-byos': 'rhel-vm-month', 'sles-byos': 'sles-vm-month' };

/**
 * The keys the plan needs rates for, from the design (instance types, disk
 * types, database classes) and the licences, per platform and region; plus the
 * network, one-time migration and on-premises run-rate keys. Sorted and unique.
 */
export function rateCardKeys(plan: Plan, design?: TargetDesign): TemplateKey[] {
  const keys = new Map<string, TemplateKey>();
  const add = (k: TemplateKey) => keys.set(`${k.platform}|${k.region}|${k.category}|${k.key}|${k.unit}`, k);
  const dbs = new Map<string, Database>(plan.databases.map((d) => [d.id, d]));
  for (const p of design?.platforms ?? []) {
    const region = p.region;
    for (const c of p.compute) {
      add({ platform: p.platform, region, category: 'compute', key: c.size, unit: 'hour' });
      for (const d of c.disks) add({ platform: p.platform, region, category: 'storage', key: d.type, unit: 'gib-month' });
    }
    for (const d of p.databases) {
      add({ platform: p.platform, region, category: 'db', key: d.classOrShape, unit: 'hour' });
      add({ platform: p.platform, region, category: 'storage', key: `${d.service}-storage`, unit: 'gib-month' });
      const db = dbs.get(d.database);
      if (db?.engine === 'sqlserver') add({ platform: p.platform, region, category: 'licence', key: 'sql-core-month', unit: 'core-month' });
      if (db?.engine === 'oracle') add({ platform: p.platform, region, category: 'licence', key: 'oracle-processor-year', unit: 'processor-year' });
    }
    add({ platform: p.platform, region, category: 'network', key: 'egress-gib', unit: 'gib' });
    if (p.connectivity.length > 0) add({ platform: p.platform, region, category: 'network', key: p.connectivity.some((c) => c.method !== 'vpn') ? 'circuit-month' : 'vpn-hour', unit: p.connectivity.some((c) => c.method !== 'vpn') ? 'month' : 'hour' });
    if (p.compute.some((c) => plan.workloads.find((w) => w.id === c.workload)?.os.startsWith('win'))) add({ platform: p.platform, region, category: 'licence', key: 'windows-core-month', unit: 'core-month' });
    for (const c of p.compute) {
      const lk = LICENCE_KEYS[plan.workloads.find((w) => w.id === c.workload)?.licence ?? 'free'];
      if (lk) add({ platform: p.platform, region, category: 'licence', key: lk, unit: 'vm-month' });
    }
    add({ platform: p.platform, region, category: 'service', key: 'migration-per-server', unit: 'one-time' });
  }
  for (const k of ['host-month', 'colocation-month', 'power-kwh', 'support-month', 'licences-month']) add({ platform: 'on-prem', region: '', category: 'facility', key: k, unit: k.split('-').pop() ?? 'month' });
  return [...keys.values()].sort((a, b) => `${a.platform}|${a.region}|${a.category}|${a.key}`.localeCompare(`${b.platform}|${b.region}|${b.category}|${b.key}`));
}

/** The template CSV: the keys the plan needs, with empty rates for the user to fill. */
export function rateCardTemplate(plan: Plan, design?: TargetDesign): string {
  const lines = [RATECARD_HEADER];
  for (const k of rateCardKeys(plan, design)) lines.push([k.platform, k.region, k.category, k.key, k.unit, '', '', ''].map(csvField).join(','));
  return `${lines.join('\n')}\n`;
}

/** The on-premises run-rate being exited, per currency and unit: the facility rows. */
export function exitedRunRate(card: Pick<RateCard, 'rows'>): { currency: string; unit: string; total: number; sources: string[] }[] {
  const groups = new Map<string, { currency: string; unit: string; total: number; sources: Set<string> }>();
  for (const r of card.rows.filter((x) => x.platform === 'on-prem')) {
    const k = `${r.currency}|${r.unit}`;
    const g = groups.get(k) ?? { currency: r.currency, unit: r.unit, total: 0, sources: new Set<string>() };
    g.total += r.rate;
    if (r.source) g.sources.add(r.source);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({ ...g, sources: [...g.sources].sort() }));
}

/** Split rows into run cost and one-time migration cost (kept separate in every report). */
export function splitCosts(card: Pick<RateCard, 'rows'>): { run: RateRow[]; oneTime: RateRow[] } {
  const oneTime = card.rows.filter((r) => ONE_TIME_UNITS.has(r.unit.toLowerCase()));
  return { run: card.rows.filter((r) => !oneTime.includes(r)), oneTime };
}
