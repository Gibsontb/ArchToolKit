/**
 * RAID (`#raid`) on Multi-Cloud Migration & Utilities (addendum A.8.5): the
 * Risks, Assumptions, Issues and Decisions logs of the tracker.
 *
 * Each log is a " | " grid (`planGrid`) with a dropdown in every closed column
 * (probability and impact 1–5, response, status, severity, origin, the RACI
 * role that decided, the decision's source), Import CSV, Export CSV and Clear.
 * The risk score is P × I, computed. Blockers are issues with a Blocks cell:
 * every named item is flagged blocked on the board until the issue is
 * resolved or closed. An occurred risk can be raised as an issue, a false
 * assumption as a risk; the plan's warnings and errors are offered as
 * suggested risks, never added on their own.
 */

import { el, append } from '../dom.ts';
import { card, findingItem } from '../components.ts';
import type { PaneContext } from '../plan-shell.ts';
import type { Finding } from '../../core/findings.ts';
import {
  ASSUMPTION_STATUS_OPTIONS, DECISION_SOURCE_OPTIONS, ISSUE_ORIGIN_OPTIONS, ISSUE_SEVERITY_OPTIONS, ISSUE_STATUS_OPTIONS, RACI_ROLE_OPTIONS,
  RAID_SCORE_OPTIONS, RISK_RESPONSE_OPTIONS, RISK_STATUS_OPTIONS, optionValue, type PlanOption,
} from '../../multicloud/plan/options.ts';
import type { RaidAssumption, RaidDecision, RaidIssue, RaidRisk, RaidScore, Tracker } from '../../multicloud/plan/types.ts';
import {
  RAID_PREFIX, addFindingAsRisk, raidFromCsv, raidToCsv, raiseAssumptionAsRisk, raiseRiskAsIssue, riskScore, suggestedRisks, type RaidLog,
} from '../../multicloud/plan/track/raid.ts';
import { withDerived } from '../../multicloud/plan/track/derive.ts';
import type { CellColumn, CellResult } from '../multicloud/grid-model.ts';
import { planGrid, type PlanGrid } from '../multicloud/grid.ts';
import { modelFindings, planModel } from '../multicloud/plan-model.ts';
import { fill, note } from '../multicloud/pane-kit.ts';
import { commitTracker, otherPlanNode, todayIso, watchTrack, type TrackView } from './track-kit.ts';

// ---------------------------------------------------------------------------
// Column builders (also used by the governance grids)
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const ok = <T>(patch: Partial<T>): CellResult<T> => ({ patch });

/** A text cell; `optional` writes undefined for blank. */
export function textColumn<T>(key: keyof T & string, label: string, optional = false): CellColumn<T> {
  return {
    key, label,
    get: (row) => String((row as Rec)[key] ?? ''),
    set: (_row, text) => ok<T>({ [key]: optional ? text.trim() || undefined : text.trim() } as Partial<T>),
  };
}
/** A dropdown cell; with `blank`, the blank entry writes undefined. */
export function selectColumn<T>(key: keyof T & string, label: string, options: readonly PlanOption[], blank?: string, parse: (v: string) => unknown = (v) => v): CellColumn<T> {
  return {
    key, label,
    options: blank !== undefined ? [{ value: '', label: blank }, ...options] : options,
    get: (row) => String((row as Rec)[key] ?? ''),
    set: (_row, text) => {
      if (text.trim() === '') return blank !== undefined ? ok<T>({ [key]: undefined } as Partial<T>) : { error: `${label} cannot be blank.` };
      const v = optionValue(options as readonly PlanOption<string>[], text);
      return v === undefined ? { error: `${label}: “${text.trim()}” is not one of the choices.` } : ok<T>({ [key]: parse(v) } as Partial<T>);
    },
  };
}
/** A whole number ≥ 0; `optional` allows blank. */
export function numberColumn<T>(key: keyof T & string, label: string, optional = false, decimals = false): CellColumn<T> {
  return {
    key, label,
    get: (row) => {
      const v = (row as Rec)[key];
      return v === undefined || v === null ? '' : String(v);
    },
    set: (_row, text) => {
      const t = text.trim();
      if (t === '') return optional ? ok<T>({ [key]: undefined } as Partial<T>) : { error: `${label} needs a number.` };
      const n = Number(t);
      return Number.isFinite(n) && n >= 0 && (decimals || Number.isInteger(n)) ? ok<T>({ [key]: n } as Partial<T>) : { error: `${label}: “${t}” is not a number of 0 or more.` };
    },
  };
}
/** Space-separated words into a list. */
export function listColumn<T>(key: keyof T & string, label: string): CellColumn<T> {
  return {
    key, label,
    get: (row) => ((row as Rec)[key] as readonly string[] | undefined ?? []).join(' '),
    set: (_row, text) => ok<T>({ [key]: text.split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean) } as Partial<T>),
  };
}
/** A read-only computed cell. */
export function computedColumn<T>(key: string, label: string, get: (row: T) => string): CellColumn<T> {
  return { key, label, get, set: () => ({ patch: {} }) };
}

const score = (v: unknown): RaidScore => Number(v) as RaidScore;

// ---------------------------------------------------------------------------
// The four logs
// ---------------------------------------------------------------------------

export function riskColumns(apps: readonly string[]): readonly CellColumn<RaidRisk>[] {
  return [
    textColumn<RaidRisk>('id', 'ID'),
    textColumn<RaidRisk>('risk', 'Risk'),
    numberColumn<RaidRisk>('wave', 'Wave', true),
    apps.length ? selectColumn<RaidRisk>('app', 'App', apps.map((a) => ({ value: a, label: a })), '—') : textColumn<RaidRisk>('app', 'App', true),
    selectColumn<RaidRisk>('probability', 'Probability', RAID_SCORE_OPTIONS, undefined, score),
    selectColumn<RaidRisk>('impact', 'Impact', RAID_SCORE_OPTIONS, undefined, score),
    computedColumn<RaidRisk>('score', 'Score', (r) => String(riskScore(r))),
    textColumn<RaidRisk>('owner', 'Owner', true),
    selectColumn<RaidRisk>('response', 'Response', RISK_RESPONSE_OPTIONS),
    textColumn<RaidRisk>('mitigation', 'Mitigation', true),
    selectColumn<RaidRisk>('status', 'Status', RISK_STATUS_OPTIONS),
    textColumn<RaidRisk>('reviewBy', 'Review by', true),
  ];
}
export const ASSUMPTION_COLUMNS: readonly CellColumn<RaidAssumption>[] = [
  textColumn<RaidAssumption>('id', 'ID'),
  textColumn<RaidAssumption>('assumption', 'Assumption'),
  textColumn<RaidAssumption>('owner', 'Owner', true),
  textColumn<RaidAssumption>('validateBy', 'Validate by', true),
  selectColumn<RaidAssumption>('status', 'Status', ASSUMPTION_STATUS_OPTIONS),
  textColumn<RaidAssumption>('evidence', 'Evidence', true),
];
export const ISSUE_COLUMNS: readonly CellColumn<RaidIssue>[] = [
  textColumn<RaidIssue>('id', 'ID'),
  textColumn<RaidIssue>('issue', 'Issue'),
  selectColumn<RaidIssue>('severity', 'Severity', ISSUE_SEVERITY_OPTIONS),
  numberColumn<RaidIssue>('wave', 'Wave', true),
  listColumn<RaidIssue>('blocks', 'Blocks'),
  textColumn<RaidIssue>('owner', 'Owner', true),
  textColumn<RaidIssue>('opened', 'Opened'),
  textColumn<RaidIssue>('due', 'Due', true),
  selectColumn<RaidIssue>('status', 'Status', ISSUE_STATUS_OPTIONS),
  textColumn<RaidIssue>('resolution', 'Resolution', true),
  selectColumn<RaidIssue>('origin', 'Origin', ISSUE_ORIGIN_OPTIONS, '—'),
];
export const DECISION_COLUMNS: readonly CellColumn<RaidDecision>[] = [
  textColumn<RaidDecision>('id', 'ID'),
  textColumn<RaidDecision>('decision', 'Decision'),
  textColumn<RaidDecision>('rationale', 'Rationale', true),
  selectColumn<RaidDecision>('by', 'Decided by', RACI_ROLE_OPTIONS, '—'),
  textColumn<RaidDecision>('date', 'Date'),
  selectColumn<RaidDecision>('source', 'Source', DECISION_SOURCE_OPTIONS),
  listColumn<RaidDecision>('links', 'Links'),
];

/** The next id among rows (R-001 …). */
export function nextId(rows: readonly { id: string }[], log: RaidLog): string {
  const prefix = RAID_PREFIX[log];
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const r of rows) {
    const m = re.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

/** A blank row of a log, with the next id. */
export function blankRow(log: RaidLog, rows: readonly { id: string }[], today: string): RaidRisk | RaidAssumption | RaidIssue | RaidDecision {
  const id = nextId(rows, log);
  switch (log) {
    case 'risks': return { id, risk: '', probability: 3, impact: 3, response: 'reduce', status: 'open' };
    case 'assumptions': return { id, assumption: '', status: 'open' };
    case 'issues': return { id, issue: '', severity: 'sev3', blocks: [], opened: today, status: 'open', origin: 'manual' };
    default: return { id, decision: '', date: today, source: 'manual', links: [] };
  }
}

/** Rows with blank ids given the next free ones, and blank text rows dropped. */
export function tidyRows<T extends { id: string }>(log: RaidLog, rows: readonly T[]): T[] {
  const out: T[] = [];
  for (const r of rows) out.push(r.id.trim() ? r : { ...r, id: nextId([...rows, ...out], log) });
  return out;
}

/** A log's CSV read into rows merged by id with the current ones (the grid's Import CSV). */
export function importLog<L extends RaidLog>(log: L, text: string, current: readonly { id: string }[]): { rows: { id: string }[]; findings: Finding[] } {
  const read = raidFromCsv(log, text);
  const rows = [...current];
  for (const r of read.rows as unknown as { id: string }[]) {
    const id = r.id.trim() || nextId(rows, log);
    const i = rows.findIndex((x) => x.id === id);
    if (i >= 0) rows[i] = { ...r, id };
    else rows.push({ ...r, id });
  }
  return { rows, findings: read.findings };
}

const LOGS: readonly { log: RaidLog; title: string; noun: string }[] = [
  { log: 'risks', title: 'Risks', noun: 'risk' },
  { log: 'assumptions', title: 'Assumptions', noun: 'assumption' },
  { log: 'issues', title: 'Issues and blockers', noun: 'issue' },
  { log: 'decisions', title: 'Decisions', noun: 'decision' },
];

export function mount(root: HTMLElement, ctx: PaneContext): void {
  let current: TrackView | undefined;
  const written: Partial<Record<RaidLog, unknown>> = {};
  const grids = new Map<RaidLog, PlanGrid>();
  const banner = el('div');
  const suggested = el('div', { attrs: { 'data-control': 'raid-suggested' } });
  const actions = el('div', { class: 'btn-row' });
  const holders = new Map<RaidLog, HTMLElement>(LOGS.map((l) => [l.log, el('div')]));
  append(root, el('div', { class: 'stack', style: { minWidth: '0', overflowWrap: 'anywhere' } },
    banner,
    ...LOGS.map((l) => card(l.title,
      l.log === 'issues' ? note('An issue with names in Blocks (item or app names, space-separated) blocks those items on the board until it is resolved or closed.') : null,
      l.log === 'decisions' ? note('Gate decisions, rollbacks and re-waves are logged here on their own; add the rest by hand.') : null,
      holders.get(l.log) as HTMLElement,
      l.log === 'risks' ? el('div', { class: 'stack' }, actions, suggested) : null,
    )),
  ));

  const write = (log: RaidLog, rows: readonly { id: string }[]) => {
    const v = current;
    if (!v) return;
    const tidy = tidyRows(log, rows);
    written[log] = tidy;
    const t: Tracker = withDerived({ ...v.tracker, raid: { ...v.tracker.raid, [log]: tidy } }, v.ctx);
    current = { ...v, tracker: t };
    void commitTracker(t, ctx);
  };

  const gridFor = (log: RaidLog, v: TrackView): PlanGrid => {
    const apps = [...new Set([...v.ctx.apps.values()].filter(Boolean))].sort();
    const common = {
      id: `raid-${log}`,
      noun: LOGS.find((l) => l.log === log)?.noun ?? 'row',
      read: () => (current?.tracker.raid[log] ?? []) as never[],
      write: (rows: never[]) => write(log, rows as { id: string }[]),
      create: (rows: readonly never[]) => blankRow(log, rows as readonly { id: string }[], todayIso()) as never,
      pageSize: 50,
      csv: {
        fileName: `raid-${log}.csv`,
        export: () => (current ? raidToCsv(current.tracker, log) : ''),
        import: (text: string, rows: readonly never[]) => {
          const r = importLog(log, text, rows as readonly { id: string }[]);
          return { rows: r.rows as never[], findings: r.findings };
        },
      },
    };
    switch (log) {
      case 'risks': return planGrid({ ...common, columns: riskColumns(apps) as never, filterKeys: ['status', 'response', 'app'], bulkKeys: ['wave', 'app', 'probability', 'impact', 'owner', 'response', 'status', 'reviewBy'] });
      case 'assumptions': return planGrid({ ...common, columns: ASSUMPTION_COLUMNS as never, filterKeys: ['status'] });
      case 'issues': return planGrid({ ...common, columns: ISSUE_COLUMNS as never, filterKeys: ['severity', 'status', 'origin'] });
      default: return planGrid({ ...common, columns: DECISION_COLUMNS as never, filterKeys: ['source', 'by'] });
    }
  };

  const draw = (v: TrackView): void => {
    current = v;
    fill(banner, otherPlanNode(v, ctx));
    for (const { log } of LOGS) {
      const holder = holders.get(log) as HTMLElement;
      let grid = grids.get(log);
      if (!grid) {
        grid = gridFor(log, v);
        grids.set(log, grid);
        fill(holder, grid.root);
      } else if (written[log] !== v.tracker.raid[log] && !grid.busy()) {
        grid.render();
      }
    }
    // Raise as issue / as risk.
    const occurred = v.tracker.raid.risks.filter((r) => r.status === 'occurred' && !v.tracker.raid.issues.some((i) => i.issue.includes(`(from risk ${r.id})`)));
    const falseA = v.tracker.raid.assumptions.filter((a) => a.status === 'false' && !v.tracker.raid.risks.some((r) => r.risk.startsWith(`Assumption ${a.id} proved false`)));
    fill(actions,
      ...occurred.map((r) => el('button', {
        class: 'btn btn-small', text: `Raise ${r.id} as an issue`, attrs: { type: 'button', 'data-control': 'raid-raise-issue' },
        on: { click: () => void commitTracker(withDerived(raiseRiskAsIssue(v.tracker, r.id, todayIso()), v.ctx), ctx) },
      })),
      ...falseA.map((a) => el('button', {
        class: 'btn btn-small', text: `Raise ${a.id} as a risk`, attrs: { type: 'button', 'data-control': 'raid-raise-risk' },
        on: { click: () => void commitTracker(raiseAssumptionAsRisk(v.tracker, a.id), ctx) },
      })),
    );
    const findings = suggestedRisks(v.tracker, modelFindings(planModel(v.plan))).slice(0, 25);
    fill(suggested, findings.length === 0 ? null : el('div', { class: 'stack' },
      el('h3', { text: 'Suggested', style: { margin: 'var(--space-3) 0 0' } }),
      note('The plan’s warnings and errors. None is added until you choose to.'),
      ...findings.map((f) => el('div', { class: 'stack', style: { gap: 'var(--space-1)' } }, findingItem(f), el('div', { class: 'btn-row' }, el('button', {
        class: 'btn btn-small', text: 'Add as risk', attrs: { type: 'button', 'data-control': 'raid-add-suggested' },
        on: { click: () => void commitTracker(addFindingAsRisk(v.tracker, f), ctx) },
      }))))));
  };

  watchTrack(ctx, draw);
}
