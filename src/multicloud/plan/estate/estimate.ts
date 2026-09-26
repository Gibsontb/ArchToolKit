/**
 * Estimates from the user's own rate card (addendum A.10.7).
 *
 * The toolkit carries no prices. With a rate card, the sized counts (the
 * design's instance types, disks, database classes, licences, links, and the
 * one-off per-server migration cost) are multiplied by the matching rates
 * (`findRate`, governance/ratecard.ts); a count with no rate is listed as
 * "no rate", never guessed. Every figure carries the label "estimate from your
 * rates (source: …)". Without a rate card there is no estimate at all: the
 * result says so and holds the counts only.
 *
 * Run cost (monthly) and one-time migration cost stay separate. Unit
 * conversions are planning assumptions, stated in the result: an hourly rate
 * is × 730 hours a month; a yearly rate ÷ 12.
 */

import { estimateLabel, findRate, ONE_TIME_UNITS } from '../governance/ratecard.ts';
import { PLATFORM_VALUES } from '../options.ts';
import type { Plan, PlanDecision, Platform, RateCard, RateCategory, TargetDesign } from '../types.ts';

/** Hours in a month, for hourly rates (a planning assumption: 365 × 24 ÷ 12). */
export const HOURS_PER_MONTH = 730;

/** One thing to price: a count of something, in the rate card's key and unit. */
export interface CountLine {
  readonly platform: Platform;
  readonly region: string;
  readonly category: RateCategory;
  readonly key: string;
  /** The unit the rate card keys it by (hour, gib-month, core-month, vm-month, processor-year, one-time …). */
  readonly unit: string;
  readonly quantity: number;
  /** What was counted, for the grid. */
  readonly what: string;
}

export interface PricedLine extends CountLine {
  readonly rate: number;
  readonly currency: string;
  /** Monthly for run costs, the whole amount for one-time costs. */
  readonly amount: number;
  readonly oneTime: boolean;
  readonly label: string;
  readonly source: string;
}

export interface CurrencyTotal { readonly currency: string; readonly amount: number; readonly label: string }

export interface Estimate {
  /** False without a rate card (or with an empty one): no figures at all. */
  readonly available: boolean;
  /** "estimate from your rates (source: …)", or the sentence saying there is no rate card. */
  readonly label: string;
  readonly counts: readonly CountLine[];
  readonly priced: readonly PricedLine[];
  /** Counts the rate card has no rate for. */
  readonly noRate: readonly CountLine[];
  /** Monthly run cost per platform and currency. */
  readonly monthly: Readonly<Partial<Record<Platform, readonly CurrencyTotal[]>>>;
  /** One-time migration cost per platform and currency. */
  readonly oneTime: Readonly<Partial<Record<Platform, readonly CurrencyTotal[]>>>;
  readonly assumptions: readonly string[];
}

export const NO_RATE_CARD = 'No rate card: counts only. Import or enter your own rates to see an estimate; the toolkit carries no prices.';

/** The counts a design needs rates for: compute, storage, databases, licences, links and the one-off migration. */
export function designCounts(plan: Plan, decision: PlanDecision, design: TargetDesign): CountLine[] {
  const out: CountLine[] = [];
  const add = (l: CountLine): void => {
    const same = out.find((x) => x.platform === l.platform && x.region === l.region && x.category === l.category && x.key === l.key && x.unit === l.unit);
    if (same) (same as { quantity: number }).quantity += l.quantity;
    else out.push({ ...l });
  };
  const wById = new Map(plan.workloads.map((w) => [w.id, w]));
  const dbById = new Map(plan.databases.map((d) => [d.id, d]));
  for (const pd of design.platforms) {
    const { platform, region } = pd;
    for (const c of pd.compute) {
      add({ platform, region, category: 'compute', key: c.size, unit: 'hour', quantity: HOURS_PER_MONTH, what: `${c.size} instance-hours a month` });
      for (const d of c.disks) add({ platform, region, category: 'storage', key: d.type, unit: 'gib-month', quantity: d.gib, what: `${d.type} GiB` });
      const lic = decision.items[c.workload]?.chosen?.licence;
      if (lic && lic.count > 0 && lic.model === 'li') {
        if (lic.kind === 'windows-core') add({ platform, region, category: 'licence', key: 'windows-core-month', unit: 'core-month', quantity: lic.count, what: 'Windows cores (licence included)' });
        if (lic.kind === 'rhel') add({ platform, region, category: 'licence', key: 'rhel-vm-month', unit: 'vm-month', quantity: 1, what: 'RHEL VMs' });
        if (lic.kind === 'sles') add({ platform, region, category: 'licence', key: 'sles-vm-month', unit: 'vm-month', quantity: 1, what: 'SLES VMs' });
      }
      const w = wById.get(c.workload);
      if (w && (w.licence === 'rhel-byos' || w.licence === 'sles-byos')) {
        add({ platform, region, category: 'licence', key: w.licence === 'rhel-byos' ? 'rhel-vm-month' : 'sles-vm-month', unit: 'vm-month', quantity: 1, what: 'Subscriptions brought (for the comparison)' });
      }
    }
    for (const d of pd.databases) {
      add({ platform, region, category: 'db', key: d.classOrShape, unit: 'hour', quantity: HOURS_PER_MONTH, what: `${d.classOrShape} hours a month` });
      add({ platform, region, category: 'storage', key: `${d.service}-storage`, unit: 'gib-month', quantity: d.storageGib, what: `${d.service} storage GiB` });
      const lic = decision.items[d.database]?.chosen?.licence;
      const db = dbById.get(d.database);
      if (lic && lic.count > 0 && lic.model === 'li') {
        if (lic.kind === 'sql-core') add({ platform, region, category: 'licence', key: 'sql-core-month', unit: 'core-month', quantity: lic.count, what: `SQL Server cores (${db?.name ?? d.database})` });
        if (lic.kind === 'oracle-processor') add({ platform, region, category: 'licence', key: 'oracle-processor-year', unit: 'processor-year', quantity: lic.count, what: `Oracle processors (${db?.name ?? d.database})` });
      }
    }
    for (const c of pd.connectivity) {
      if (c.method === 'vpn') add({ platform, region, category: 'network', key: 'vpn-hour', unit: 'hour', quantity: 2 * HOURS_PER_MONTH, what: `VPN tunnels to ${c.site} (2) hours a month` });
      else add({ platform, region, category: 'network', key: 'circuit-month', unit: 'month', quantity: 1, what: `Circuit to ${c.site}` });
    }
    const moving = Object.values(decision.items).filter((i) => i.kind === 'workload' && i.chosen?.platform === platform && (i.method === 'replicate' || i.method === 'rebuild' || i.method === 'relocate-hcx') && i.disposition !== 'new').length;
    if (moving > 0) add({ platform, region, category: 'service', key: 'migration-per-server', unit: 'one-time', quantity: moving, what: 'Servers migrated (one-time)' });
  }
  return out;
}

/** A rate's unit → the multiplier that turns (quantity × rate) into a monthly (or one-time) amount. */
function monthlyFactor(rateUnit: string, countUnit: string): number {
  const r = rateUnit.toLowerCase();
  if (countUnit === 'hour' && (r === 'month' || r.endsWith('-month'))) return 1 / HOURS_PER_MONTH; // a monthly rate for something counted in hours
  if (r.endsWith('year')) return 1 / 12;
  return 1;
}

/**
 * Price the counts with a rate card. Without one (or an empty one) the
 * result has `available: false` and no figures.
 */
export function estimate(counts: readonly CountLine[], card: Pick<RateCard, 'rows'> | undefined): Estimate {
  const assumptions = [
    `An hourly rate is multiplied by ${HOURS_PER_MONTH} hours a month (planning assumption).`,
    'A yearly rate is divided by 12.',
    'Run cost (monthly) and one-time migration cost are kept separate.',
  ];
  if (!card || card.rows.length === 0) {
    return { available: false, label: NO_RATE_CARD, counts, priced: [], noRate: [], monthly: {}, oneTime: {}, assumptions };
  }
  const priced: PricedLine[] = [];
  const noRate: CountLine[] = [];
  const sources = new Set<string>();
  for (const c of counts) {
    const r = findRate(card, { platform: c.platform, region: c.region, category: c.category, key: c.key });
    if (!r) {
      noRate.push(c);
      continue;
    }
    const oneTime = ONE_TIME_UNITS.has(r.unit.toLowerCase()) || ONE_TIME_UNITS.has(c.unit);
    const amount = round2(c.quantity * r.rate * (oneTime ? 1 : monthlyFactor(r.unit, c.unit)));
    if (r.source) sources.add(r.source);
    priced.push({ ...c, rate: r.rate, currency: r.currency, amount, oneTime, label: estimateLabel(r.source), source: r.source });
  }
  const label = estimateLabel([...sources].sort().join('; '));
  const totals = (lines: readonly PricedLine[]): Partial<Record<Platform, CurrencyTotal[]>> => {
    const out: Partial<Record<Platform, CurrencyTotal[]>> = {};
    for (const p of PLATFORM_VALUES) {
      const mine = lines.filter((l) => l.platform === p);
      if (mine.length === 0) continue;
      const byCur = new Map<string, number>();
      for (const l of mine) byCur.set(l.currency, (byCur.get(l.currency) ?? 0) + l.amount);
      out[p] = [...byCur.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount: round2(amount), label }));
    }
    return out;
  };
  return {
    available: true,
    label,
    counts,
    priced,
    noRate,
    monthly: totals(priced.filter((l) => !l.oneTime)),
    oneTime: totals(priced.filter((l) => l.oneTime)),
    assumptions,
  };
}

/** The estimate for a designed plan (or an app slice's design). */
export function estimateDesign(plan: Plan, decision: PlanDecision, design: TargetDesign, card: Pick<RateCard, 'rows'> | undefined): Estimate {
  return estimate(designCounts(plan, decision, design), card);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
