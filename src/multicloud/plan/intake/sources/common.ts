/**
 * The shared end of every source parser: `SourceServer` records (a
 * `ServerRecord` plus where the machine runs and what the guest reported) to
 * planner rows, through the WP-2 `intakeFromServers`, then:
 *
 * 1. app grouping (`../grouping.ts`) for servers the source did not name an app for;
 * 2. `origin` and `sourceRef` on each row;
 * 3. workload-type detection (`../../patterns/detect.ts`, the one detector), honest about doubt;
 * 4. the sizing basis (`sizing-basis.ts`): nameplate into `facts.nameplate`,
 *    demand into `vcpu` / `ramGib`.
 *
 * Also the utilisation maths every time-series source shares: percentiles
 * and coverage from samples.
 */

import { warning, type Finding } from '../../../../core/findings.ts';
import type { GroupingRule, SourcePlatform, SourceRef, Utilisation, Workload } from '../../types.ts';
import { applyDetection, detectType, type DetectionFacts } from '../../patterns/detect.ts';
import { intakeFromServers, type IntakeResult, type ServerRecord } from '../adapter.ts';
import { DEFAULT_GROUPING, UNASSIGNED_APP, groupApp } from '../grouping.ts';
import { applySizingBasis } from './sizing-basis.ts';

/** What a collector saw that detection weighs beyond the row's facts. */
export interface DetectInput {
  readonly shares?: number;
  readonly printers?: number;
  readonly sessions?: number;
  /** Appliance product text (vApp product, OVA name). */
  readonly product?: string;
}

/** One machine from any source, before it becomes a row. */
export interface SourceServer extends ServerRecord {
  readonly origin: SourcePlatform;
  readonly sourceRef?: SourceRef;
  /** Cloud tags, labels, Nutanix categories, Migration Center tags. */
  readonly tags?: Readonly<Record<string, string>>;
  /** For detection: shares, printers, sessions, product text. */
  readonly detect?: DetectInput;
  /** Grouping inputs beyond tags and attributes. */
  readonly folder?: string;
  readonly csvApp?: string;
}

export interface SourceIntakeOptions {
  /** ISO date for the end-of-support checks; default today. */
  readonly on?: string;
  /** 'server', 'VM', 'instance'. */
  readonly noun?: string;
  /** App grouping rules for servers with no app; default `DEFAULT_GROUPING`. */
  readonly grouping?: readonly GroupingRule[];
  /** Run type detection (default true). */
  readonly detect?: boolean;
  /** Apply the A.3.6 sizing basis (default true). */
  readonly basis?: boolean;
}

/** Database engine hints for `dbFromVm`, from what the guest runs (it reads attribute values). */
const DB_HINTS: readonly (readonly [RegExp, string])[] = [
  [/^mssql(server|\$)|microsoft sql server \d|sqlservr/i, 'mssql'],
  [/oracleservice|tnslsnr|oracle database/i, 'oracle'],
  [/postgres/i, 'postgres'],
  [/mariadb/i, 'mariadb'],
  [/mysqld|mysql server/i, 'mysql'],
  [/mongod/i, 'mongodb'],
  [/db2sysc/i, 'db2'],
];
const DB_PORT_HINTS: Readonly<Record<number, string>> = { 1433: 'mssql', 1521: 'oracle', 5432: 'postgres', 3306: 'mysql', 27017: 'mongodb' };

/** The engine a server's software, services or listening ports reveal, or undefined. */
export function dbHint(s: Pick<ServerRecord, 'facts'>): string | undefined {
  const f = s.facts ?? {};
  const texts = [...(f.services ?? []), ...(f.software ?? []), ...(f.listening ?? []).map((l) => l.process ?? '')];
  for (const [re, engine] of DB_HINTS) if (texts.some((t) => re.test(t))) return engine;
  for (const l of f.listening ?? []) if (DB_PORT_HINTS[l.port]) return DB_PORT_HINTS[l.port];
  return undefined;
}

/** Source servers to planner rows (see the file comment for the steps). */
export function intakeFromSourceServers(servers: readonly SourceServer[], opts: SourceIntakeOptions = {}): IntakeResult {
  const rules = opts.grouping ?? DEFAULT_GROUPING;
  const unassigned: string[] = [];
  const records: ServerRecord[] = servers.map((s) => {
    let app = s.app?.trim() ?? '';
    if (!app) {
      const hit = groupApp({ name: s.name, ...(s.attributes ? { attributes: s.attributes } : {}), ...(s.tags ? { tags: s.tags } : {}), ...(s.folder ? { folder: s.folder } : {}), ...(s.csvApp ? { csvApp: s.csvApp } : {}) }, rules);
      app = hit?.app ?? UNASSIGNED_APP;
      if (!hit) unassigned.push(s.name);
    }
    const hint = dbHint(s);
    const attributes = { ...(s.tags ?? {}), ...(s.attributes ?? {}), ...(hint ? { 'db-engine': hint } : {}) };
    const { origin: _o, sourceRef: _r, tags: _t, detect: _d, folder: _f, csvApp: _c, ...rec } = s;
    return { ...rec, app, ...(Object.keys(attributes).length > 0 ? { attributes } : {}) };
  });

  const base = intakeFromServers(records, { source: 'estate', ...(opts.on ? { on: opts.on } : {}), noun: opts.noun ?? 'server' });
  const findings: Finding[] = [...base.findings];
  const workloads: Workload[] = base.workloads.map((w0, i) => {
    const s = servers[i]!;
    let w: Workload = { ...w0, origin: s.origin, ...(s.sourceRef ? { sourceRef: s.sourceRef } : {}) };
    if (opts.detect !== false) {
      const x = s.detect ?? {};
      const facts: DetectionFacts = {
        ...(x.shares !== undefined ? { shares: x.shares } : {}),
        ...(x.printers !== undefined ? { sharedPrinters: x.printers } : {}),
        ...(x.sessions !== undefined ? { sessions: x.sessions } : {}),
        ...(x.product ? { guestId: x.product } : {}),
        ...(s.annotation ? { annotation: s.annotation } : {}),
      };
      const d = applyDetection(w, detectType(w, facts));
      w = d.workload;
      findings.push(...d.findings);
    }
    if (opts.basis !== false) {
      const b = applySizingBasis(w);
      w = b.workload;
      findings.push(...b.findings);
    }
    return w;
  });
  if (unassigned.length > 0) {
    const shown = unassigned.slice(0, 5).join(', ') + (unassigned.length > 5 ? ` and ${unassigned.length - 5} more` : '');
    findings.push(warning('plan.sources.unassigned', `${unassigned.length} server${unassigned.length === 1 ? '' : 's'} matched no grouping rule and went to "${UNASSIGNED_APP}": ${shown}.`, {
      remediation: 'Add a grouping rule on the Sources screen (an attribute, a tag or a name pattern), or type the app on the Servers grid.',
    }));
  }
  return { workloads, databases: base.databases, apps: base.apps, findings };
}

// ---------------------------------------------------------------------------
// Utilisation from samples
// ---------------------------------------------------------------------------

/** Nearest-rank percentile of a list (0 < p ≤ 100); undefined for an empty list. */
export function percentile(values: readonly number[], p: number): number | undefined {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  const rank = Math.max(1, Math.ceil((p / 100) * v.length));
  return v[Math.min(v.length, rank) - 1];
}

export interface SampleSeries {
  /** Epoch milliseconds, one per sample (any order). */
  readonly at: readonly number[];
  readonly cpuPct?: readonly number[];
  readonly memGib?: readonly number[];
  readonly iops?: readonly number[];
  /** Disk MB/s. */
  readonly mbps?: readonly number[];
  /** Network Mbit/s. */
  readonly netMbps?: readonly number[];
}

const r1 = (n: number | undefined): number | undefined => (n === undefined ? undefined : Math.round(n * 10) / 10);

/**
 * Percentiles and coverage from a time series. The expected sample count is
 * the span divided by the median interval, plus one, so gaps lower the
 * coverage and a steady series has coverage 1.
 */
export function utilisationFromSeries(s: SampleSeries): Utilisation | undefined {
  const n = s.at.length;
  if (n === 0) return undefined;
  const at = [...s.at].sort((a, b) => a - b);
  const spanMs = at[n - 1]! - at[0]!;
  const gaps = at.slice(1).map((t, i) => t - at[i]!).filter((g) => g > 0).sort((a, b) => a - b);
  const interval = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)]! : 0;
  const expected = interval > 0 ? Math.floor(spanMs / interval) + 1 : n;
  const coverage = Math.round(Math.min(1, n / Math.max(1, expected)) * 100) / 100;
  const days = Math.round((spanMs / 86_400_000) * 10) / 10;
  const out: Record<string, number> = { days, samples: n, coverage };
  const put = (key: string, v: number | undefined): void => { if (v !== undefined) out[key] = v; };
  if (s.cpuPct && s.cpuPct.length > 0) {
    put('cpuP50Pct', r1(percentile(s.cpuPct, 50)));
    put('cpuP95Pct', r1(percentile(s.cpuPct, 95)));
    put('cpuP99Pct', r1(percentile(s.cpuPct, 99)));
    put('cpuMaxPct', r1(percentile(s.cpuPct, 100)));
  }
  if (s.memGib && s.memGib.length > 0) {
    put('memP95Gib', r1(percentile(s.memGib, 95)));
    put('memMaxGib', r1(percentile(s.memGib, 100)));
  }
  if (s.iops && s.iops.length > 0) {
    put('iopsP95', Math.round(percentile(s.iops, 95)!));
    put('iopsMax', Math.round(percentile(s.iops, 100)!));
  }
  if (s.mbps && s.mbps.length > 0) put('mbpsP95', r1(percentile(s.mbps, 95)));
  if (s.netMbps && s.netMbps.length > 0) put('netMbpsP95', r1(percentile(s.netMbps, 95)));
  return out as unknown as Utilisation;
}

/** A single figure with an unknown or stated window (import templates carry one value per server). */
export function pointUtilisation(fig: Omit<Utilisation, 'days' | 'samples' | 'coverage'>, days = 0): Utilisation {
  return { days, samples: 1, coverage: days > 0 ? 1 : 0, ...fig };
}

/** Parses a timestamp cell: ISO, "yyyy-mm-dd hh:mm:ss", or epoch seconds / milliseconds. */
export function parseTimestamp(text: string): number | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  if (/^\d{9,10}$/.test(t)) return Number(t) * 1000;
  if (/^\d{12,13}$/.test(t)) return Number(t);
  const iso = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(t) && !/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? `${t.replace(' ', 'T')}Z` : t;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}
