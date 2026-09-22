/**
 * What to do with an application, and why.
 *
 * Ported from the previous toolkit's EAMME engine, with its rules intact —
 * the hard gates, the readiness bands, the cloud signals, the risk points —
 * and one thing corrected. The ratings tab says 1 is the worst case and 5 the
 * best; the old scoring then inverted technical debt, vendor lock, compliance
 * complexity and refactor effort, so rating one of them 5 ("best") lowered
 * readiness. Here every factor reads the way the form says it does: higher is
 * better for a move, and the weights are unchanged.
 *
 * Nothing here decides anything on its own that the person cannot see: each
 * result carries the sentence that explains it.
 */

import type { Cloud } from './options.ts';
import type { Application, Evaluation, Ratings, Risk, Route } from './types.ts';
import { playbookFor } from './playbook.ts';
import { EMPTY_CATALOG, recommendServices, type ServiceCatalog } from './services.ts';

/** How much each factor counts towards readiness. Unchanged from the original. */
export const WEIGHTS: Readonly<Record<keyof Ratings, number>> = {
  cloudCompatibility: 20,
  technicalDebt: 20,
  vendorLockRisk: 10,
  complianceComplexity: 15,
  architectureModularity: 15,
  refactorEffort: 20,
};

/** What 1 and 5 mean, per factor, so the form can say it beside the control. */
export const RATING_MEANING: Readonly<Record<keyof Ratings, { label: string; low: string; high: string }>> = {
  cloudCompatibility: { label: 'Cloud compatibility', low: '1 — will not run as it is', high: '5 — runs on a cloud platform unchanged' },
  technicalDebt: { label: 'Technical debt', low: '1 — heavy debt, unsupported versions', high: '5 — current and maintained' },
  vendorLockRisk: { label: 'Vendor lock-in', low: '1 — tied to one vendor', high: '5 — portable' },
  complianceComplexity: { label: 'Compliance', low: '1 — heavily regulated data', high: '5 — no special obligations' },
  architectureModularity: { label: 'Modularity', low: '1 — one monolith', high: '5 — separable services' },
  refactorEffort: { label: 'Refactor effort', low: '1 — a rewrite', high: '5 — little or no code change' },
};

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

/** 1–5 as 0–100. */
function percent(rating: number): number {
  return ((clamp(Number.isFinite(rating) ? rating : 3, 1, 5) - 1) / 4) * 100;
}

/** The weighted readiness score, 0–100. Higher is readier to move. */
export function readinessScore(ratings: Ratings): number {
  const keys = Object.keys(WEIGHTS) as (keyof Ratings)[];
  const total = keys.reduce((sum, key) => sum + WEIGHTS[key], 0);
  const weighted = keys.reduce((sum, key) => sum + percent(ratings[key]) * WEIGHTS[key], 0);
  return Math.round(weighted / total);
}

/**
 * Compliance scopes as the rest of the engine reads them.
 *
 * FedRAMP implies a FedRAMP-authorised commercial boundary, so it adds
 * `commercial`; the shorthands people type are folded into the long names.
 */
export function normalizeCompliance(list: readonly string[] | string): string[] {
  const raw = Array.isArray(list) ? list : String(list ?? '').split(/[;,]/);
  const out = new Set(raw.map((x) => String(x).trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean));
  if (out.has('fedramp')) out.add('fedramp_moderate');
  if (out.has('fedramp_low') || out.has('fedramp_moderate') || out.has('fedramp_high')) out.add('commercial');
  if (out.has('pci')) {
    out.delete('pci');
    out.add('pci_dss');
  }
  if (out.has('iso_27001')) {
    out.delete('iso_27001');
    out.add('iso27001');
  }
  if (out.has('soc_2')) {
    out.delete('soc_2');
    out.add('soc2');
  }
  if (out.has('itar')) out.add('itars');
  return [...out];
}

const REGULATED = ['fedramp_low', 'fedramp_moderate', 'fedramp_high', 'cjis', 'itar', 'itars', 'cmmc', 'fisma'];

export function isRegulated(compliance: readonly string[]): boolean {
  return normalizeCompliance(compliance).some((c) => REGULATED.includes(c));
}

/** The course of action: a hard gate first, then the readiness bands. */
export function courseOfAction(app: Application, readiness: number): { route: Route; rationale: string } {
  const gates = app.gates;
  if (gates.isObsolete) return { route: 'Retire', rationale: 'Marked obsolete or no longer used: retire it and stop paying for it.' };
  if (gates.vendorSaaSAvailable && !gates.mustStayOnPrem) {
    return { route: 'Repurchase', rationale: 'A vendor SaaS replacement exists, and nothing requires this to stay on-premises.' };
  }
  if (gates.mustStayOnPrem || gates.hardwareBound || gates.mainframeBound) {
    return { route: 'Retain', rationale: 'A hard dependency — policy, hardware or mainframe — blocks a move for now.' };
  }
  if (readiness >= 80) return { route: 'Refactor', rationale: `Readiness ${readiness}: high enough to modernise rather than move as it is.` };
  if (readiness >= 60) return { route: 'Replatform', rationale: `Readiness ${readiness}: good, so move it onto managed services with little code change.` };
  if (readiness >= 40) return { route: 'Rehost', rationale: `Readiness ${readiness}: moderate, so lift and shift now and improve it afterwards.` };
  if (readiness >= 20) return { route: 'Retain', rationale: `Readiness ${readiness}: too low to move well. Keep it where it is and work on the blockers.` };
  return { route: 'Retire', rationale: `Readiness ${readiness}: very low. Retire it unless the business case says otherwise.` };
}

/** Which cloud, and what signalled it. */
export function targetCloud(app: Application): { cloud: Cloud; rationale: string } {
  const lower = (s: string) => String(s ?? '').toLowerCase();
  const stack = lower(app.primaryStack);
  const db = lower(app.database);
  const vendor = lower(app.vendor);
  const workload = lower(app.workloadType);
  const compliance = normalizeCompliance(app.compliance);

  const oracleHeavy = db.includes('oracle') || vendor.includes('oracle');
  const microsoftHeavy =
    stack.includes('c#') || stack.includes('.net') || stack.includes('windows') || db.includes('sql server') || vendor.includes('microsoft');
  const analyticsHeavy = stack.includes('spark') || stack.includes('hadoop') || stack.includes('bigquery') || workload.includes('analytics');
  const aiHeavy = workload.includes('ai') || workload.includes('ml');

  if (app.enterpriseStandardCloud) {
    return { cloud: app.enterpriseStandardCloud, rationale: 'The enterprise has standardised on this cloud, which outranks every other signal.' };
  }
  if (app.gates.dataSovereigntyRequired || isRegulated(compliance)) {
    return microsoftHeavy
      ? { cloud: 'azure', rationale: 'Regulated or sovereign data, on a Microsoft-heavy stack: Azure has both the boundary and the licensing alignment.' }
      : { cloud: 'aws', rationale: 'Regulated or sovereign data: AWS has the widest authorised footprint, so it is the default here.' };
  }
  if (oracleHeavy) return { cloud: 'oci', rationale: 'Oracle database or vendor: OCI for the licensing and database alignment.' };
  if (microsoftHeavy) return { cloud: 'azure', rationale: 'Microsoft-heavy stack: Azure for the integration and licensing alignment.' };
  if (analyticsHeavy || aiHeavy) return { cloud: 'gcp', rationale: 'Analytics or AI workload: Google Cloud for its managed analytics stack.' };
  return { cloud: 'aws', rationale: 'No stronger signal, so the default landing zone.' };
}

/**
 * How risky the move is, and what made it so.
 *
 * A label for planning, not part of the routing: it decides which wave an
 * application lands in, and nothing else.
 */
export function riskOf(app: Application): { risk: Risk; because: string[] } {
  let points = 0;
  const because: string[] = [];
  const add = (n: number, why: string) => {
    points += n;
    because.push(why);
  };

  if (app.criticality === 'Mission Critical') add(3, 'mission critical');
  else if (app.criticality === 'High') add(2, 'high criticality');
  else if (app.criticality === 'Medium') add(1, 'medium criticality');

  if (app.rtoHours <= 4) add(2, `RTO ${app.rtoHours}h`);
  else if (app.rtoHours <= 24) add(1, `RTO ${app.rtoHours}h`);

  if (app.rpoHours <= 1) add(2, `RPO ${app.rpoHours}h`);
  else if (app.rpoHours <= 4) add(1, `RPO ${app.rpoHours}h`);

  if (app.integrationCount >= 20) add(2, `${app.integrationCount} integrations`);
  else if (app.integrationCount >= 10) add(1, `${app.integrationCount} integrations`);

  const compliance = normalizeCompliance(app.compliance);
  if (compliance.some((c) => c.startsWith('fedramp') || c === 'itars' || c === 'cjis')) add(2, 'regulated data');
  else if (compliance.length > 0) add(1, 'compliance obligations');

  const risk: Risk = points >= 8 ? 'High' : points >= 5 ? 'Medium' : 'Low';
  return { risk, because };
}

/**
 * The whole evaluation, in the order the parts depend on each other: the
 * score, then the route it implies, then the cloud, then the risk, then the
 * plan and the services for that route on that cloud.
 *
 * Pure: the same application evaluates the same way every time, which is what
 * lets the portfolio re-evaluate a saved record and get the same answer.
 */
export function evaluate(app: Application, catalog: ServiceCatalog = EMPTY_CATALOG): Evaluation {
  const readiness = readinessScore(app.ratings);
  const { route, rationale } = courseOfAction(app, readiness);
  const { cloud, rationale: cloudRationale } = targetCloud(app);
  const { risk, because } = riskOf(app);
  return {
    readiness,
    route,
    rationale,
    cloud,
    cloudRationale,
    risk,
    riskBecause: because,
    plan: playbookFor(route, cloud, isRegulated(app.compliance) || app.gates.dataSovereigntyRequired),
    services: recommendServices(cloud, route, app, catalog),
  };
}
