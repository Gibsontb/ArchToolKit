/**
 * The Migration page's portfolio as App rows.
 *
 * The Migration page assesses applications; the planner places their servers.
 * Each evaluated application becomes an App carrying its criticality, its
 * evaluated route (the default disposition for its workloads), its hard gates
 * as the Special column, and its readiness, risk, cloud and compliance for
 * wave triage and the `plan.portfolio.cloud-differs` finding.
 *
 * The Migration page spells Google `gcp` and has no VMware target and no
 * Relocate route; `toMigrationCloud` and `fromMigrationCloud` translate.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import type { Criticality as PortfolioCriticality } from '../../../migration/options.ts';
import type { PortfolioEntry, Route } from '../../../migration/types.ts';
import { itemId } from '../options.ts';
import type { App, Criticality, Disposition, MigrationCloud, Platform, Special } from '../types.ts';
import type { IntakeAdapter, IntakeResult } from './adapter.ts';

export const CRITICALITY_FROM_PORTFOLIO: Readonly<Record<PortfolioCriticality, Criticality>> = {
  'Mission Critical': 'tier0',
  High: 'tier1',
  Medium: 'tier2',
  Low: 'tier3',
};

export const ROUTE_FROM_PORTFOLIO: Readonly<Record<Route, Disposition>> = {
  Rehost: 'rehost',
  Replatform: 'replatform',
  Refactor: 'refactor',
  Repurchase: 'repurchase',
  Retain: 'retain',
  Retire: 'retire',
};

/** The Migration page's criticality, case-insensitive; undefined when it is none of the four. */
export function criticalityFromPortfolio(value: string): Criticality | undefined {
  const t = value.trim().toLowerCase();
  const key = (Object.keys(CRITICALITY_FROM_PORTFOLIO) as PortfolioCriticality[]).find((k) => k.toLowerCase() === t);
  return key ? CRITICALITY_FROM_PORTFOLIO[key] : undefined;
}

/** The Migration page's route, case-insensitive; undefined when it is none of the six. */
export function routeFromPortfolio(value: string): Disposition | undefined {
  const t = value.trim().toLowerCase();
  const key = (Object.keys(ROUTE_FROM_PORTFOLIO) as Route[]).find((k) => k.toLowerCase() === t);
  return key ? ROUTE_FROM_PORTFOLIO[key] : undefined;
}

/** A planner platform in the Migration page's spelling: google is 'gcp'; vmware has none. */
export function toMigrationCloud(p: Platform): MigrationCloud | undefined {
  switch (p) {
    case 'aws':
    case 'azure':
    case 'oci':
      return p;
    case 'google':
      return 'gcp';
    default:
      return undefined;
  }
}

/** The Migration page's cloud as a planner platform ('gcp' is google). Undefined for anything else. */
export function fromMigrationCloud(c: string): Platform | undefined {
  const t = c.trim().toLowerCase();
  if (t === 'gcp' || t === 'google') return 'google';
  if (t === 'aws' || t === 'azure' || t === 'oci') return t;
  return undefined;
}

/** Hard gates that make an app special for placement; the first that applies. */
function specialOf(entry: PortfolioEntry): Special {
  const g = entry.application.gates;
  if (g?.mainframeBound) return 'mainframe-link';
  if (g?.hardwareBound) return 'physical-dongle';
  return 'none';
}

/** One App row per portfolio entry (the first of any repeated name). */
export function appsFromPortfolio(entries: readonly PortfolioEntry[]): App[] {
  const out = new Map<string, App>();
  for (const entry of entries) {
    const a = entry.application;
    const name = (a.name ?? '').trim();
    if (!name) continue;
    const id = itemId('app', name);
    if (out.has(id)) continue;
    const e = entry.evaluation;
    const cloud = e ? fromMigrationCloud(e.cloud) : undefined;
    const migrationCloud = cloud ? toMigrationCloud(cloud) : undefined;
    const route = e ? routeFromPortfolio(e.route) : undefined;
    const notes = (a.notes ?? '').trim();
    out.set(id, {
      id,
      name,
      ...(a.owner?.trim() ? { owner: a.owner.trim() } : {}),
      criticality: criticalityFromPortfolio(a.criticality ?? '') ?? 'tier2',
      residency: 'any',
      latencyToOnPrem: 'tolerant',
      special: specialOf(entry),
      ...(route ? { route } : {}),
      ...(notes ? { notes } : {}),
      ...(e
        ? {
          portfolio: {
            readiness: e.readiness,
            risk: e.risk,
            ...(migrationCloud ? { cloud: migrationCloud } : {}),
            compliance: [...(a.compliance ?? [])],
          },
        }
        : {}),
      source: 'portfolio',
    });
  }
  return [...out.values()];
}

/** The portfolio as an intake result: the apps, and what the import noticed. */
export function intakeFromPortfolio(entries: readonly PortfolioEntry[]): IntakeResult {
  const apps = appsFromPortfolio(entries);
  const findings: Finding[] = [];
  if (entries.length === 0) {
    findings.push(info('plan.sources.portfolio-empty', 'The Migration portfolio is empty in this browser.', {
      remediation: 'Evaluate or import applications on the Migration page first.',
    }));
    return { workloads: [], databases: [], apps, findings };
  }
  findings.push(info('plan.sources.portfolio-loaded', `${apps.length} application${apps.length === 1 ? '' : 's'} read from the Migration portfolio.`));
  const drafts = entries.filter((e) => e.draft).map((e) => e.application.name);
  if (drafts.length > 0) {
    findings.push(info('plan.sources.portfolio-drafts', `${drafts.length} portfolio application(s) are drafts with default ratings, so their route is provisional: ${drafts.slice(0, 5).join(', ')}${drafts.length > 5 ? ' …' : ''}.`));
  }
  const sovereign = entries.filter((e) => e.application.gates?.dataSovereigntyRequired).map((e) => e.application.name);
  if (sovereign.length > 0) {
    findings.push(warning('plan.sources.portfolio-residency', `${sovereign.length} application(s) need data sovereignty, but the portfolio does not say where: ${sovereign.slice(0, 5).join(', ')}${sovereign.length > 5 ? ' …' : ''}.`, {
      remediation: 'Set Residency for them on the Apps screen.',
    }));
  }
  const dup = entries.length - apps.length - entries.filter((e) => !(e.application.name ?? '').trim()).length;
  if (dup > 0) {
    findings.push(warning('plan.sources.duplicate-name', `${dup} portfolio application(s) repeated a name; the first of each was kept.`));
  }
  return { workloads: [], databases: [], apps, findings };
}

export const PORTFOLIO_ADAPTER: IntakeAdapter<readonly PortfolioEntry[]> = {
  id: 'portfolio',
  label: 'Migration portfolio (this browser)',
  itemSource: 'portfolio',
  parse: (entries: readonly PortfolioEntry[]) => intakeFromPortfolio(entries),
};
