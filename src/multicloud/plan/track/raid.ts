/**
 * Risks, assumptions, issues and decisions (addendum A.8.5): the four logs,
 * their ids, the "raise as" moves, blockers, automatic decision entries,
 * suggested risks from the plan's findings, and CSV in and out.
 *
 * Blockers are not a list of their own: an issue with a non-empty `blocks`
 * cell blocks every item (or every item of every app) it names, until it is
 * resolved or closed. `blockersByItem` is the one place that reads it.
 *
 * Pure: every change returns a new tracker.
 */

import { parseCsv, toCsv } from '../../../core/csv.ts';
import type { Finding } from '../../../core/findings.ts';
import {
  ASSUMPTION_STATUS_OPTIONS, DECISION_SOURCE_OPTIONS, ISSUE_ORIGIN_OPTIONS, ISSUE_SEVERITY_OPTIONS, ISSUE_STATUS_OPTIONS,
  RACI_ROLE_OPTIONS, RISK_RESPONSE_OPTIONS, RISK_STATUS_OPTIONS, itemId, optionValue, type PlanOption,
} from '../options.ts';
import type {
  ItemId, RaidAssumption, RaidDecision, RaidIssue, RaidRisk, RaidScore, Tracker, TrackerRaid,
} from '../types.ts';

export type RaidLog = keyof TrackerRaid;
export type RaidRow<L extends RaidLog> = TrackerRaid[L][number];

/** The id prefix per log: R-001, A-001, I-001, D-001. */
export const RAID_PREFIX: Readonly<Record<RaidLog, string>> = { risks: 'R', assumptions: 'A', issues: 'I', decisions: 'D' };

/** The next free id in a log (one past the highest number used with the prefix). */
export function nextRaidId(tracker: Tracker, log: RaidLog): string {
  const prefix = RAID_PREFIX[log];
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const row of tracker.raid[log] as readonly { id: string }[]) {
    const m = re.exec(row.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function withLog<L extends RaidLog>(tracker: Tracker, log: L, rows: readonly RaidRow<L>[]): Tracker {
  return { ...tracker, raid: { ...tracker.raid, [log]: rows } };
}

/** Add a row, or replace the row with the same id. A blank id gets the next free one. */
export function upsertRaid<L extends RaidLog>(tracker: Tracker, log: L, row: RaidRow<L>): Tracker {
  const id = row.id.trim() || nextRaidId(tracker, log);
  const clean = { ...row, id } as RaidRow<L>;
  const rows = tracker.raid[log] as readonly RaidRow<L>[];
  const i = rows.findIndex((r) => r.id === id);
  return withLog(tracker, log, i < 0 ? [...rows, clean] : rows.map((r, j) => (j === i ? clean : r)));
}
export function removeRaid(tracker: Tracker, log: RaidLog, id: string): Tracker {
  return withLog(tracker, log, (tracker.raid[log] as readonly { id: string }[]).filter((r) => r.id !== id) as never);
}
/** The grid's Clear. */
export function clearRaid(tracker: Tracker, log: RaidLog): Tracker {
  return withLog(tracker, log, []);
}

/** Probability × impact, 1–25. */
export function riskScore(r: Pick<RaidRisk, 'probability' | 'impact'>): number {
  return r.probability * r.impact;
}
/** Open risks (not closed), highest score first. */
export function topRisks(tracker: Tracker, n = 5): RaidRisk[] {
  return tracker.raid.risks
    .filter((r) => r.status !== 'closed')
    .map((r, i) => ({ r, i }))
    .sort((a, b) => riskScore(b.r) - riskScore(a.r) || a.i - b.i)
    .slice(0, n)
    .map((x) => x.r);
}

/** An issue still stopping work. */
export function isOpenIssue(i: RaidIssue): boolean {
  return i.status === 'open' || i.status === 'in-progress';
}

/** A risk that occurred, raised as an issue (A.8.5 "raise as issue"). The risk is marked occurred. */
export function raiseRiskAsIssue(tracker: Tracker, riskId: string, opened: string, severity: RaidIssue['severity'] = 'sev3'): Tracker {
  const risk = tracker.raid.risks.find((r) => r.id === riskId);
  if (!risk) return tracker;
  let t = upsertRaid(tracker, 'risks', { ...risk, status: 'occurred' });
  const issue: RaidIssue = {
    id: nextRaidId(t, 'issues'),
    issue: `${risk.risk} (from risk ${risk.id})`,
    severity,
    ...(risk.wave !== undefined ? { wave: risk.wave } : {}),
    blocks: [],
    ...(risk.owner ? { owner: risk.owner } : {}),
    opened,
    status: 'open',
    origin: 'manual',
  };
  t = upsertRaid(t, 'issues', issue);
  return t;
}

/** An assumption proved false, raised as a risk (A.8.5 "raise as risk"). */
export function raiseAssumptionAsRisk(tracker: Tracker, assumptionId: string, probability: RaidScore = 3, impact: RaidScore = 3): Tracker {
  const a = tracker.raid.assumptions.find((x) => x.id === assumptionId);
  if (!a) return tracker;
  const t = upsertRaid(tracker, 'assumptions', { ...a, status: 'false' });
  return upsertRaid(t, 'risks', {
    id: nextRaidId(t, 'risks'),
    risk: `Assumption ${a.id} proved false: ${a.assumption}`,
    probability,
    impact,
    ...(a.owner ? { owner: a.owner } : {}),
    response: 'reduce',
    status: 'open',
  });
}

/**
 * An automatic Decisions-log entry (A.8.5): gates, rollbacks, re-waves,
 * platform switches, components left out and what-if adoptions. Both pages
 * call this when a tracker exists. A blank id gets the next free one; an
 * entry whose links already appear on an entry of the same source and text
 * is not written twice.
 */
export function recordDecision(tracker: Tracker, entry: Omit<RaidDecision, 'id'> & { readonly id?: string }): Tracker {
  const dup = tracker.raid.decisions.some(
    (d) => d.source === entry.source && d.decision === entry.decision && d.links.join(' ') === entry.links.join(' ') && entry.links.length > 0,
  );
  if (dup) return tracker;
  return upsertRaid(tracker, 'decisions', { ...entry, id: entry.id ?? '' });
}

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

/** How `blocks` names resolve: item ids, item names and app names. */
export interface BlockResolver {
  /** Lower-cased item or app name → the items it means. */
  readonly byName?: ReadonlyMap<string, readonly ItemId[]>;
}

/**
 * Item id → the open issues that block it. A name in `blocks` is matched as
 * an item id, then (case-insensitive) as an item or app name through the
 * resolver, then as the id a workload or database of that name would have.
 */
export function blockersByItem(tracker: Tracker, resolver: BlockResolver = {}): Map<ItemId, string[]> {
  const out = new Map<ItemId, string[]>();
  const add = (id: ItemId, issue: string): void => {
    if (!(id in tracker.items)) return;
    const list = out.get(id) ?? [];
    if (!list.includes(issue)) list.push(issue);
    out.set(id, list);
  };
  for (const issue of tracker.raid.issues) {
    if (!isOpenIssue(issue)) continue;
    for (const raw of issue.blocks) {
      const name = raw.trim();
      if (!name) continue;
      if (name in tracker.items) {
        add(name, issue.id);
        continue;
      }
      const named = resolver.byName?.get(name.toLowerCase());
      if (named && named.length) {
        for (const id of named) add(id, issue.id);
        continue;
      }
      add(itemId('workload', name), issue.id);
      add(itemId('database', name), issue.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suggested risks (A.8.5)
// ---------------------------------------------------------------------------

/** The plan's findings worth a risk: severity warning or error. Never added on their own. */
export function suggestedRisks(tracker: Tracker, findings: readonly Finding[]): Finding[] {
  const taken = new Set(tracker.raid.risks.map((r) => r.risk));
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    if (f.severity === 'info') continue;
    const key = `${f.code}|${f.message}`;
    if (seen.has(key) || taken.has(f.message)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
/** "Add as risk": the finding as an open risk (error: 4×4, warning: 3×3). */
export function addFindingAsRisk(tracker: Tracker, f: Finding, extra: Partial<Pick<RaidRisk, 'wave' | 'app' | 'owner'>> = {}): Tracker {
  const p: RaidScore = f.severity === 'error' ? 4 : 3;
  return upsertRaid(tracker, 'risks', {
    id: '',
    risk: f.message,
    ...extra,
    probability: p,
    impact: p,
    response: 'reduce',
    ...(f.remediation ? { mitigation: f.remediation } : {}),
    status: 'open',
  });
}

// ---------------------------------------------------------------------------
// CSV (Import CSV / Export CSV on each grid, and the raid-*.csv exports)
// ---------------------------------------------------------------------------

/** Column slugs per log, in the order of the grid (A.8.5). */
export const RAID_COLUMNS: Readonly<Record<RaidLog, readonly string[]>> = {
  risks: ['id', 'risk', 'wave', 'app', 'probability', 'impact', 'score', 'owner', 'response', 'mitigation', 'status', 'review_by'],
  assumptions: ['id', 'assumption', 'owner', 'validate_by', 'status', 'evidence'],
  issues: ['id', 'issue', 'severity', 'wave', 'blocks', 'owner', 'opened', 'due', 'status', 'resolution', 'origin'],
  decisions: ['id', 'decision', 'rationale', 'decided_by', 'date', 'source', 'links'],
};

const opt = (x: string | number | undefined): string => (x === undefined ? '' : String(x));

function rowOut(log: RaidLog, r: RaidRow<RaidLog>): Record<string, string> {
  switch (log) {
    case 'risks': {
      const x = r as RaidRisk;
      return {
        id: x.id, risk: x.risk, wave: opt(x.wave), app: opt(x.app), probability: String(x.probability), impact: String(x.impact),
        score: String(riskScore(x)), owner: opt(x.owner), response: x.response, mitigation: opt(x.mitigation), status: x.status, review_by: opt(x.reviewBy),
      };
    }
    case 'assumptions': {
      const x = r as RaidAssumption;
      return { id: x.id, assumption: x.assumption, owner: opt(x.owner), validate_by: opt(x.validateBy), status: x.status, evidence: opt(x.evidence) };
    }
    case 'issues': {
      const x = r as RaidIssue;
      return {
        id: x.id, issue: x.issue, severity: x.severity, wave: opt(x.wave), blocks: x.blocks.join(' '), owner: opt(x.owner), opened: x.opened,
        due: opt(x.due), status: x.status, resolution: opt(x.resolution), origin: opt(x.origin),
      };
    }
    default: {
      const x = r as RaidDecision;
      return { id: x.id, decision: x.decision, rationale: opt(x.rationale), decided_by: opt(x.by), date: x.date, source: x.source, links: x.links.join(' ') };
    }
  }
}

/** One log as CSV, header always present. */
export function raidToCsv(tracker: Tracker, log: RaidLog): string {
  const cols = [...RAID_COLUMNS[log]];
  const rows = (tracker.raid[log] as readonly RaidRow<RaidLog>[]).map((r) => rowOut(log, r));
  return rows.length ? toCsv(rows, cols) : `${cols.join(',')}\n`;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER_ALIASES: Readonly<Record<string, string>> = { decidedby: 'decided_by', by: 'decided_by', reviewby: 'review_by', validateby: 'validate_by' };

function cellMap(headers: readonly string[], row: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((h, i) => {
    const n = norm(h);
    const key = HEADER_ALIASES[n] ?? n;
    out[key] = (row[i] ?? '').trim();
  });
  return out;
}
const cell = (m: Record<string, string>, slug: string): string => m[slug] ?? m[norm(slug)] ?? '';

/**
 * A grid's Import CSV: rows by header name (any case or punctuation), closed
 * sets through their dropdown values or labels. A row with a bad value is
 * skipped with a finding naming the row and column, never guessed.
 */
export function raidFromCsv<L extends RaidLog>(log: L, text: string): { rows: RaidRow<L>[]; findings: Finding[] } {
  const table = parseCsv(text);
  const findings: Finding[] = [];
  const rows: RaidRow<L>[] = [];
  const bad = (line: number, column: string, value: string): void => {
    findings.push({
      code: 'track.raid.csv-value', severity: 'warning', path: `${log}[${line}].${column}`,
      message: `Row ${line + 2}: "${value}" is not a valid ${column.replace('_', ' ')}; the row was skipped.`,
    });
  };
  const pickOpt = <U extends string>(options: readonly PlanOption<U>[], raw: string): U | undefined => optionValue(options, raw);
  const num = (raw: string): number | undefined => (raw === '' ? undefined : Number.isFinite(Number(raw)) ? Number(raw) : Number.NaN);
  const score = (raw: string): RaidScore | undefined => {
    const n = Number(raw.trim().charAt(0));
    return n >= 1 && n <= 5 ? (n as RaidScore) : undefined;
  };
  const words = (raw: string): string[] => raw.split(/[\s,;|]+/).map((w) => w.trim()).filter(Boolean);

  table.rows.forEach((raw, line) => {
    const m: Record<string, string> = {};
    for (const [k, v] of Object.entries(cellMap(table.headers, raw))) m[k] = v;
    const id = cell(m, 'id');
    const text1 = (k: string): string | undefined => cell(m, k) || undefined;
    if (log === 'risks') {
      const risk = cell(m, 'risk');
      const probability = score(cell(m, 'probability'));
      const impact = score(cell(m, 'impact'));
      const response = pickOpt(RISK_RESPONSE_OPTIONS, cell(m, 'response') || 'reduce');
      const status = pickOpt(RISK_STATUS_OPTIONS, cell(m, 'status') || 'open');
      const wave = num(cell(m, 'wave'));
      if (!risk) return;
      if (!probability) return bad(line, 'probability', cell(m, 'probability'));
      if (!impact) return bad(line, 'impact', cell(m, 'impact'));
      if (!response) return bad(line, 'response', cell(m, 'response'));
      if (!status) return bad(line, 'status', cell(m, 'status'));
      if (Number.isNaN(wave)) return bad(line, 'wave', cell(m, 'wave'));
      rows.push({
        id, risk, ...(wave !== undefined ? { wave } : {}), ...(text1('app') ? { app: text1('app') } : {}), probability, impact,
        ...(text1('owner') ? { owner: text1('owner') } : {}), response, ...(text1('mitigation') ? { mitigation: text1('mitigation') } : {}), status,
        ...(text1('review_by') ? { reviewBy: text1('review_by') } : {}),
      } as RaidRow<L>);
    } else if (log === 'assumptions') {
      const assumption = cell(m, 'assumption');
      const status = pickOpt(ASSUMPTION_STATUS_OPTIONS, cell(m, 'status') || 'open');
      if (!assumption) return;
      if (!status) return bad(line, 'status', cell(m, 'status'));
      rows.push({
        id, assumption, ...(text1('owner') ? { owner: text1('owner') } : {}), ...(text1('validate_by') ? { validateBy: text1('validate_by') } : {}), status,
        ...(text1('evidence') ? { evidence: text1('evidence') } : {}),
      } as RaidRow<L>);
    } else if (log === 'issues') {
      const issue = cell(m, 'issue');
      const severity = pickOpt(ISSUE_SEVERITY_OPTIONS, cell(m, 'severity') || 'sev3');
      const status = pickOpt(ISSUE_STATUS_OPTIONS, cell(m, 'status') || 'open');
      const origin = cell(m, 'origin') ? pickOpt(ISSUE_ORIGIN_OPTIONS, cell(m, 'origin')) : 'manual';
      const wave = num(cell(m, 'wave'));
      if (!issue) return;
      if (!severity) return bad(line, 'severity', cell(m, 'severity'));
      if (!status) return bad(line, 'status', cell(m, 'status'));
      if (!origin) return bad(line, 'origin', cell(m, 'origin'));
      if (Number.isNaN(wave)) return bad(line, 'wave', cell(m, 'wave'));
      rows.push({
        id, issue, severity, ...(wave !== undefined ? { wave } : {}), blocks: words(cell(m, 'blocks')), ...(text1('owner') ? { owner: text1('owner') } : {}),
        opened: cell(m, 'opened'), ...(text1('due') ? { due: text1('due') } : {}), status, ...(text1('resolution') ? { resolution: text1('resolution') } : {}), origin,
      } as RaidRow<L>);
    } else {
      const decision = cell(m, 'decision');
      const source = pickOpt(DECISION_SOURCE_OPTIONS, cell(m, 'source') || 'manual');
      const by = cell(m, 'decided_by') ? pickOpt(RACI_ROLE_OPTIONS, cell(m, 'decided_by')) : undefined;
      if (!decision) return;
      if (!source) return bad(line, 'source', cell(m, 'source'));
      if (cell(m, 'decided_by') && !by) return bad(line, 'decided_by', cell(m, 'decided_by'));
      rows.push({
        id, decision, ...(text1('rationale') ? { rationale: text1('rationale') } : {}), ...(by ? { by } : {}), date: cell(m, 'date'), source,
        links: words(cell(m, 'links')),
      } as RaidRow<L>);
    }
  });
  return { rows, findings };
}

/** Import CSV into a log: rows with an id replace that row; rows without one are appended with the next id. */
export function importRaidCsv(tracker: Tracker, log: RaidLog, text: string): { tracker: Tracker; findings: Finding[] } {
  const { rows, findings } = raidFromCsv(log, text);
  let t = tracker;
  for (const r of rows) t = upsertRaid(t, log, r as never);
  return { tracker: t, findings };
}
