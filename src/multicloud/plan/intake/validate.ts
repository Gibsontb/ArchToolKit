/**
 * The standing checks on the plan's intake screens (design section 2.2):
 * Sources, Workloads, Databases and Apps. Each finding's code names its
 * screen (`plan.<screen>.<check>`), and per-row findings carry a path such as
 * `workloads[3].os`, so each screen's findings list can show its own and a
 * grid can mark the cell.
 *
 * The import's own findings (what a load noticed: unknown OS, inferred
 * databases, renamed duplicates, RDMs) come from the adapters, with codes
 * `plan.sources.*` and `plan.csv.*`, and belong to the Sources screen.
 */

import { error, info, warning, type Finding } from '../../../core/findings.ts';
import { DB_SERVICES, DB_VERSIONS, isVersionEol } from '../db-catalog.ts';
import { LICENSING_FACTS } from '../licensing-facts.ts';
import {
  APP_COLUMNS, DATABASE_COLUMNS, EDITIONS_BY_ENGINE, WORKLOAD_COLUMNS, isOption, labelOf, DB_EDITION_OPTIONS, OS_OPTIONS,
  PLATFORM_OPTIONS, platformOfService, versionsFor, type GridColumn,
} from '../options.ts';
import { osFamily, osKind } from '../os.ts';
import type { App, Database, Plan, Workload } from '../types.ts';
import { isoDay, type IntakeFacts } from './adapter.ts';

export type IntakeScreen = 'sources' | 'workloads' | 'databases' | 'apps';

/** Every finding code the intake screens raise, by screen. */
export const PLAN_FINDING_IDS = Object.freeze({
  sources: Object.freeze([
    // validatePlan
    'plan.sources.empty',
    'plan.sources.name-empty',
    // the adapters (from-inventory, from-portfolio, adapter)
    'plan.sources.os-unknown',
    'plan.sources.db-inferred',
    'plan.sources.duplicate-name',
    'plan.sources.rdm',
    'plan.sources.blocked',
    'plan.sources.os-eol',
    'plan.sources.powered-off-skipped',
    'plan.sources.scope-empty',
    'plan.sources.env-unread',
    'plan.sources.affinity-hints',
    'plan.sources.portfolio-empty',
    'plan.sources.portfolio-loaded',
    'plan.sources.portfolio-drafts',
    'plan.sources.portfolio-residency',
    // csv.ts (any grid's Import CSV)
    'plan.csv.empty',
    'plan.csv.no-name-column',
    'plan.csv.unknown-column',
    'plan.csv.unknown-value',
    'plan.csv.name-missing',
    'plan.csv.duplicate-name',
  ] as const),
  workloads: Object.freeze([
    'plan.workloads.name-empty',
    'plan.workloads.duplicate-name',
    'plan.workloads.invalid-value',
    'plan.workloads.os-unknown',
    'plan.workloads.size-invalid',
    'plan.workloads.no-disks',
    'plan.workloads.disks-mismatch',
    'plan.workloads.dependency-unknown',
    'plan.workloads.pin-excluded',
    'plan.workloads.licence-mismatch',
  ] as const),
  databases: Object.freeze([
    'plan.databases.name-empty',
    'plan.databases.duplicate-name',
    'plan.databases.invalid-value',
    'plan.databases.edition-mismatch',
    'plan.databases.version-mismatch',
    'plan.databases.version-eol',
    'plan.databases.se2-over-cap',
    'plan.databases.rac-single-host',
    'plan.databases.no-hosts',
    'plan.databases.host-unknown',
    'plan.databases.licence-mismatch',
    'plan.databases.pin-service-mismatch',
    'plan.databases.pin-excluded',
    'plan.databases.size-invalid',
    'plan.databases.inferred',
  ] as const),
  apps: Object.freeze([
    'plan.apps.name-empty',
    'plan.apps.duplicate-name',
    'plan.apps.invalid-value',
    'plan.apps.missing',
    'plan.apps.unused',
    'plan.apps.wave-invalid',
    'plan.apps.deadline-invalid',
    'plan.apps.deadline-after-timeline',
    'plan.apps.edge-unknown',
  ] as const),
});

/** The screen a finding belongs on, from its code. */
export function screenOf(code: string): IntakeScreen | undefined {
  if (code.startsWith('plan.sources.') || code.startsWith('plan.csv.')) return 'sources';
  if (code.startsWith('plan.workloads.')) return 'workloads';
  if (code.startsWith('plan.databases.')) return 'databases';
  if (code.startsWith('plan.apps.')) return 'apps';
  return undefined;
}

const lc = (s: string): string => s.trim().toLowerCase();

/** Duplicate and empty names in a list of rows. */
function nameChecks(screen: IntakeScreen, rows: readonly { readonly name: string }[], noun: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const n = lc(r.name ?? '');
    if (!n) {
      out.push(error(`plan.${screen}.name-empty`, `Row ${i + 1} has no name.`, { path: `${screen}[${i}].name`, remediation: `Give every ${noun} a name.` }));
      return;
    }
    const first = seen.get(n);
    if (first !== undefined) {
      out.push(error(`plan.${screen}.duplicate-name`, `${noun[0]?.toUpperCase()}${noun.slice(1)} “${r.name}” appears twice (rows ${first + 1} and ${i + 1}).`, {
        path: `${screen}[${i}].name`,
        remediation: 'Names identify rows across the screens; make each one unique.',
      }));
    } else seen.set(n, i);
  });
  return out;
}

/** Dropdown cells holding something that is not an option (a hand-edited or old plan file). */
function valueChecks(screen: IntakeScreen, columns: readonly GridColumn[], rows: readonly object[]): Finding[] {
  const out: Finding[] = [];
  rows.forEach((row, i) => {
    const r = row as Record<string, unknown>;
    for (const c of columns) {
      if (!c.options || (c.kind !== 'select' && c.kind !== 'multi')) continue;
      if (c.key === 'wave') continue; // a number in the model; checked below
      const v = r[c.key];
      const values = c.kind === 'multi' ? (Array.isArray(v) ? v : []) : v === undefined || v === null || v === '' ? [] : [v];
      for (const x of values) {
        if (isOption(c.options, x)) continue;
        out.push(error(`plan.${screen}.invalid-value`, `“${String(x)}” is not a ${c.label} option (row ${i + 1}).`, {
          path: `${screen}[${i}].${c.key}`,
          remediation: `Pick one of: ${c.options.map((o) => o.value).join(', ')}.`,
        }));
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

function licenceMismatch(w: Workload): string | undefined {
  if (!isOption(OS_OPTIONS, w.os)) return undefined;
  const kind = osKind(w.os);
  const fam = osFamily(w.os);
  switch (w.licence) {
    case 'byol-sa':
    case 'byol-perpetual':
      return kind === 'linux' ? 'Windows licence terms on a Linux server' : undefined;
    case 'rhel-byos':
      return /^rhel-/.test(w.os) || w.os === 'unknown' ? undefined : 'RHEL Cloud Access on an OS that is not RHEL';
    case 'sles-byos':
      return fam === 'suse' || w.os === 'unknown' ? undefined : 'SLES BYOS on an OS that is not SLES';
    case 'free':
      return kind === 'windows' ? 'no licence on Windows' : /^(rhel|sles)-/.test(w.os) ? 'no licence on an enterprise Linux that needs a subscription' : undefined;
    default:
      return undefined;
  }
}

function workloadChecks(plan: Plan): Finding[] {
  const out: Finding[] = [
    ...nameChecks('workloads', plan.workloads, 'workload'),
    ...valueChecks('workloads', WORKLOAD_COLUMNS, plan.workloads),
  ];
  const workloadNames = new Set(plan.workloads.map((w) => lc(w.name)));
  const known = new Set([...workloadNames, ...plan.apps.map((a) => lc(a.name)), ...plan.databases.map((d) => lc(d.name)),
    ...plan.workloads.map((w) => lc(w.app)).filter(Boolean)]);
  const sites = new Set(plan.requirements.sites.map((s) => lc(s.name)));
  const allowed = new Set(plan.requirements.allowed);

  plan.workloads.forEach((w, i) => {
    const at = (key: string) => ({ path: `workloads[${i}].${key}` });
    if (w.os === 'unknown') {
      out.push(warning('plan.workloads.os-unknown', `${w.name}: the operating system is unknown.`, {
        ...at('os'), remediation: 'Pick the OS; images, licences and the move method depend on it.',
      }));
    }
    if (!(w.vcpu >= 1) || !(w.ramGib > 0)) {
      out.push(error('plan.workloads.size-invalid', `${w.name}: ${!(w.vcpu >= 1) ? 'vCPU' : 'RAM'} is missing or zero.`, {
        ...at(!(w.vcpu >= 1) ? 'vcpu' : 'ramGib'), remediation: 'Enter the size the server has today.',
      }));
    }
    if (w.disksGib.length === 0 || w.disksGib.some((d) => !(d > 0))) {
      out.push(warning('plan.workloads.no-disks', `${w.name}: ${w.disksGib.length === 0 ? 'no disks are listed' : 'a disk size is zero or not a number'}.`, {
        ...at('disksGib'), remediation: 'List the disk sizes in GiB, boot disk first, separated by spaces.',
      }));
    } else {
      const provisioned = (w.facts as IntakeFacts | undefined)?.provisionedGib;
      const sum = w.disksGib.reduce((s, d) => s + d, 0);
      if (provisioned !== undefined && provisioned > 0 && Math.abs(sum - provisioned) > provisioned * 0.1) {
        out.push(warning('plan.workloads.disks-mismatch', `${w.name}: the disks add up to ${Math.round(sum)} GiB but ${Math.round(provisioned)} GiB is provisioned today (more than 10% apart).`, {
          ...at('disksGib'), remediation: 'Check the disk list against the VM.',
        }));
      }
    }
    for (const dep of w.dependsOn) {
      const site = /^site:(.+)$/i.exec(dep);
      const ok = site ? sites.has(lc(site[1] ?? '')) : known.has(lc(dep));
      if (ok) continue;
      out.push(warning('plan.workloads.dependency-unknown', `${w.name} depends on “${dep}”, which is ${site ? 'not a site on the Requirements screen' : 'not a workload, database or app in the plan'}.`, {
        ...at('dependsOn'), remediation: 'Use a workload, database or app name, or site:<name> for something staying on premises.',
      }));
    }
    if (w.pin && !allowed.has(w.pin)) {
      out.push(error('plan.workloads.pin-excluded', `${w.name} is pinned to ${labelOf(PLATFORM_OPTIONS, w.pin)}, which the requirements exclude.`, {
        ...at('pin'), remediation: 'Allow that platform, or clear the pin.',
      }));
    }
    const lic = licenceMismatch(w);
    if (lic) {
      out.push(warning('plan.workloads.licence-mismatch', `${w.name}: ${lic} (${labelOf(OS_OPTIONS, w.os)}).`, {
        ...at('licence'), remediation: 'Pick the licence that matches the OS.',
      }));
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const BYOL_ORACLE = new Set(['oracle-processor', 'oracle-nup', 'oracle-ula']);

function dbLicenceMismatch(d: Database): string | undefined {
  if (BYOL_ORACLE.has(d.licence) && d.engine !== 'oracle') return 'an Oracle licence on an engine that is not Oracle';
  if ((d.licence === 'byol-sa' || d.licence === 'byol-perpetual') && d.engine !== 'sqlserver') return 'a SQL Server licence on an engine that is not SQL Server';
  if (d.licence === 'community' && d.edition !== 'community') return 'an open-source licence on a commercial edition';
  return undefined;
}

function databaseChecks(plan: Plan, on: string): Finding[] {
  const out: Finding[] = [
    ...nameChecks('databases', plan.databases, 'database'),
    ...valueChecks('databases', DATABASE_COLUMNS, plan.databases),
  ];
  const hosts = new Set(plan.workloads.map((w) => lc(w.name)));
  const allowed = new Set(plan.requirements.allowed);
  const se2 = LICENSING_FACTS['oracle.ace.se2.max-vcpu'];
  let inferred = 0;

  plan.databases.forEach((d, i) => {
    const at = (key: string) => ({ path: `databases[${i}].${key}` });
    if (d.inferred) inferred += 1;
    const engineOk = d.engine in EDITIONS_BY_ENGINE;
    if (engineOk && !EDITIONS_BY_ENGINE[d.engine].includes(d.edition)) {
      out.push(error('plan.databases.edition-mismatch', `${d.name}: ${labelOf(DB_EDITION_OPTIONS, d.edition)} is not an edition of ${d.engine}.`, {
        ...at('edition'), remediation: `Pick one of: ${EDITIONS_BY_ENGINE[d.engine].join(', ')}.`,
      }));
    }
    if (engineOk && !versionsFor(d.engine).includes(d.version)) {
      out.push(error('plan.databases.version-mismatch', `${d.name}: version ${d.version} is not a ${d.engine} version.`, {
        ...at('version'), remediation: `Pick one of: ${versionsFor(d.engine).join(', ')}.`,
      }));
    } else if (d.version in DB_VERSIONS && isVersionEol(d.version, on)) {
      const ver = DB_VERSIONS[d.version];
      out.push(warning('plan.databases.version-eol', `${d.name}: ${d.version} is past the vendor’s support (ended ${ver.endOfSupport ?? 'already'}).`, {
        ...at('version'), remediation: 'Plan the upgrade with the move; managed services may not offer this version.',
        ...(ver.source ? { source: ver.source } : {}),
      }));
    }
    if (d.engine === 'oracle' && d.edition === 'oracle-se2' && d.vcpu > se2.value && BYOL_ORACLE.has(d.licence)) {
      out.push(error('plan.databases.se2-over-cap', `${d.name}: Oracle SE2 on ${d.vcpu} vCPU is over the ${se2.value}-vCPU limit for bring-your-own licences on AWS, Azure and Google Cloud.`, {
        ...at('vcpu'), remediation: 'Size it to 8 vCPU or fewer, move it to Enterprise Edition, or place it on OCI.', source: se2.source,
      }));
    }
    if (d.ha === 'rac' && d.hosts.length < 2) {
      out.push(warning('plan.databases.rac-single-host', `${d.name}: RAC with ${d.hosts.length === 0 ? 'no hosts' : 'one host'} listed.`, {
        ...at('hosts'), remediation: 'List every RAC node in Hosts, or set HA to RAC One Node or none.',
      }));
    }
    if (d.hosts.length === 0) {
      out.push(info('plan.databases.no-hosts', `${d.name}: no host workloads are listed.`, {
        ...at('hosts'), remediation: 'List the VMs it runs on, so the decision can retire them with it.',
      }));
    }
    for (const h of d.hosts) {
      if (hosts.has(lc(h))) continue;
      out.push(warning('plan.databases.host-unknown', `${d.name}: host “${h}” is not a workload in the plan.`, {
        ...at('hosts'), remediation: 'Use the names on the Workloads screen.',
      }));
    }
    const lic = dbLicenceMismatch(d);
    if (lic) out.push(warning('plan.databases.licence-mismatch', `${d.name}: ${lic}.`, { ...at('licence') }));
    if (d.pinService && d.pinService in DB_SERVICES) {
      const s = DB_SERVICES[d.pinService];
      if (!s.engines.includes(d.engine) || (s.editions && !s.editions.includes(d.edition))) {
        out.push(error('plan.databases.pin-service-mismatch', `${d.name}: ${s.label} does not run ${d.engine}${s.editions && s.engines.includes(d.engine) ? ` ${d.edition}` : ''}.`, {
          ...at('pinService'), remediation: 'Pick a service that runs this engine and edition, or clear the pin.',
        }));
      }
      if (!allowed.has(platformOfService(d.pinService))) {
        out.push(error('plan.databases.pin-excluded', `${d.name} is pinned to ${s.label}, on a platform the requirements exclude.`, {
          ...at('pinService'), remediation: 'Allow that platform, or clear the pin.',
        }));
      }
    }
    if (!(d.vcpu >= 1) || !(d.ramGib > 0) || !(d.sizeGib > 0)) {
      const key = !(d.vcpu >= 1) ? 'vcpu' : !(d.ramGib > 0) ? 'ramGib' : 'sizeGib';
      out.push(warning('plan.databases.size-invalid', `${d.name}: ${key === 'vcpu' ? 'vCPU' : key === 'ramGib' ? 'RAM' : 'size'} is missing or zero.`, {
        ...at(key), remediation: 'Target sizes and storage come from these numbers.',
      }));
    }
  });
  if (inferred > 0) {
    out.push(info('plan.databases.inferred', `${inferred} database row(s) were suggested from VM names and are not confirmed yet.`, {
      remediation: 'Check the engine, edition, version and licence; editing a row confirms it.',
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

function appChecks(plan: Plan): Finding[] {
  const out: Finding[] = [
    ...nameChecks('apps', plan.apps, 'app'),
    ...valueChecks('apps', APP_COLUMNS, plan.apps),
  ];
  const appNames = new Set(plan.apps.map((a) => lc(a.name)));
  const used = new Set([...plan.workloads.map((w) => lc(w.app)), ...plan.databases.map((d) => lc(d.app))].filter(Boolean));
  const missing = [...new Set([...plan.workloads.map((w) => w.app.trim()), ...plan.databases.map((d) => d.app.trim())])]
    .filter((n) => n && !appNames.has(lc(n)));
  if (missing.length > 0) {
    out.push(info('plan.apps.missing', `${missing.length} app name(s) on workloads or databases have no app row: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}.`, {
      remediation: 'Add them on the Apps screen to set their criticality and route.',
    }));
  }
  plan.apps.forEach((a: App, i) => {
    const at = (key: string) => ({ path: `apps[${i}].${key}` });
    if (a.name.trim() && !used.has(lc(a.name))) {
      out.push(info('plan.apps.unused', `App “${a.name}” has no workloads or databases.`, { ...at('name') }));
    }
    if (a.wave !== undefined && !(Number.isInteger(a.wave) && a.wave >= 0 && a.wave <= 9)) {
      out.push(error('plan.apps.wave-invalid', `${a.name}: wave ${String(a.wave)} is not 0 to 9.`, { ...at('wave') }));
    }
    if (a.deadlineMonths !== undefined) {
      if (!(a.deadlineMonths > 0)) {
        out.push(error('plan.apps.deadline-invalid', `${a.name}: the deadline must be a number of months above zero.`, { ...at('deadlineMonths') }));
      } else if (a.deadlineMonths > plan.requirements.timelineMonths) {
        out.push(warning('plan.apps.deadline-after-timeline', `${a.name}: the ${a.deadlineMonths}-month deadline is after the plan’s ${plan.requirements.timelineMonths}-month timeline.`, {
          ...at('deadlineMonths'), remediation: 'Shorten the deadline, or extend the timeline on the Requirements screen.',
        }));
      }
    }
  });
  const names = new Set([...plan.workloads.map((w) => lc(w.name)), ...plan.databases.map((d) => lc(d.name)), ...appNames]);
  const sites = new Set(plan.requirements.sites.map((s) => lc(s.name)));
  const knownEnd = (n: string): boolean => {
    const site = /^site:(.+)$/i.exec(n);
    return site ? sites.has(lc(site[1] ?? '')) : names.has(lc(n));
  };
  plan.edges.forEach((e, i) => {
    const bad = [e.from, e.to].filter((n) => !knownEnd(n));
    if (bad.length > 0) {
      out.push(warning('plan.apps.edge-unknown', `Dependency ${e.from} → ${e.to}: ${bad.map((b) => `“${b}”`).join(' and ')} not in the plan.`, {
        path: `edges[${i}]`,
      }));
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// The whole plan
// ---------------------------------------------------------------------------

function sourceChecks(plan: Plan): Finding[] {
  const out: Finding[] = [];
  if (!plan.name.trim()) out.push(warning('plan.sources.name-empty', 'The plan has no name.', { path: 'name' }));
  if (plan.workloads.length === 0 && plan.databases.length === 0) {
    out.push(info('plan.sources.empty', 'The plan has no workloads or databases yet.', {
      remediation: 'Load the estate, import a CSV, or add rows on the Workloads screen.',
    }));
  }
  return out;
}

/**
 * Every intake-screen finding for the plan. `on` (ISO date, default today) is
 * the day version support is judged on.
 */
export function validatePlan(plan: Plan, on?: string): Finding[] {
  const day = isoDay(on);
  return [...sourceChecks(plan), ...workloadChecks(plan), ...databaseChecks(plan, day), ...appChecks(plan)];
}

/** One screen's findings. */
export function validateScreen(plan: Plan, screen: IntakeScreen, on?: string): Finding[] {
  switch (screen) {
    case 'sources':
      return sourceChecks(plan);
    case 'workloads':
      return workloadChecks(plan);
    case 'databases':
      return databaseChecks(plan, isoDay(on));
    case 'apps':
      return appChecks(plan);
  }
}

/** Findings for one row, by its path prefix (e.g. 'workloads[3]'): for the grid's detail panel. */
export function findingsForRow(findings: readonly Finding[], kind: 'workloads' | 'databases' | 'apps', index: number): Finding[] {
  const prefix = `${kind}[${index}]`;
  return findings.filter((f) => f.path === prefix || (f.path ?? '').startsWith(`${prefix}.`));
}
