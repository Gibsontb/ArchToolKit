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

import { el, append } from '../dom.js';
import { card, findingItem } from '../components.js';
                                                    
                                                      
import {
  ASSUMPTION_STATUS_OPTIONS, DECISION_SOURCE_OPTIONS, ISSUE_ORIGIN_OPTIONS, ISSUE_SEVERITY_OPTIONS, ISSUE_STATUS_OPTIONS, RACI_ROLE_OPTIONS,
  RAID_SCORE_OPTIONS, RISK_RESPONSE_OPTIONS, RISK_STATUS_OPTIONS, optionValue,                 
} from '../../multicloud/plan/options.js';
                                                                                                                            
import {
  RAID_PREFIX, addFindingAsRisk, raidFromCsv, raidToCsv, raiseAssumptionAsRisk, raiseRiskAsIssue, riskScore, suggestedRisks,              
} from '../../multicloud/plan/track/raid.js';
import { withDerived } from '../../multicloud/plan/track/derive.js';
                                                                          
import { planGrid,               } from '../multicloud/grid.js';
import { modelFindings, planModel } from '../multicloud/plan-model.js';
import { fill, note } from '../multicloud/pane-kit.js';
import { commitTracker, otherPlanNode, todayIso, watchTrack,                } from './track-kit.js';

// ---------------------------------------------------------------------------
// Column builders (also used by the governance grids)
// ---------------------------------------------------------------------------

                                   
const ok =    (patch            )                => ({ patch });

/** A text cell; `optional` writes undefined for blank. */
export function textColumn   (key                  , label        , optional = false)                {
  return {
    key, label,
    get: (row) => String((row       )[key] ?? ''),
    set: (_row, text) => ok   ({ [key]: optional ? text.trim() || undefined : text.trim() }              ),
  };
}
/** A dropdown cell; with `blank`, the blank entry writes undefined. */
export function selectColumn   (key                  , label        , options                       , blank         , parse                         = (v) => v)                {
  return {
    key, label,
    options: blank !== undefined ? [{ value: '', label: blank }, ...options] : options,
    get: (row) => String((row       )[key] ?? ''),
    set: (_row, text) => {
      if (text.trim() === '') return blank !== undefined ? ok   ({ [key]: undefined }              ) : { error: `${label} cannot be blank.` };
      const v = optionValue(options                                 , text);
      return v === undefined ? { error: `${label}: “${text.trim()}” is not one of the choices.` } : ok   ({ [key]: parse(v) }              );
    },
  };
}
/** A whole number ≥ 0; `optional` allows blank. */
export function numberColumn   (key                  , label        , optional = false, decimals = false)                {
  return {
    key, label,
    get: (row) => {
      const v = (row       )[key];
      return v === undefined || v === null ? '' : String(v);
    },
    set: (_row, text) => {
      const t = text.trim();
      if (t === '') return optional ? ok   ({ [key]: undefined }              ) : { error: `${label} needs a number.` };
      const n = Number(t);
      return Number.isFinite(n) && n >= 0 && (decimals || Number.isInteger(n)) ? ok   ({ [key]: n }              ) : { error: `${label}: “${t}” is not a number of 0 or more.` };
    },
  };
}
/** Space-separated words into a list. */
export function listColumn   (key                  , label        )                {
  return {
    key, label,
    get: (row) => ((row       )[key]                                  ?? []).join(' '),
    set: (_row, text) => ok   ({ [key]: text.split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean) }              ),
  };
}
/** A read-only computed cell. */
export function computedColumn   (key        , label        , get                    )                {
  return { key, label, get, set: () => ({ patch: {} }) };
}

const score = (v         )            => Number(v)             ;

// ---------------------------------------------------------------------------
// The four logs
// ---------------------------------------------------------------------------

export function riskColumns(apps                   )                                  {
  return [
    textColumn          ('id', 'ID'),
    textColumn          ('risk', 'Risk'),
    numberColumn          ('wave', 'Wave', true),
    apps.length ? selectColumn          ('app', 'App', apps.map((a) => ({ value: a, label: a })), '—') : textColumn          ('app', 'App', true),
    selectColumn          ('probability', 'Probability', RAID_SCORE_OPTIONS, undefined, score),
    selectColumn          ('impact', 'Impact', RAID_SCORE_OPTIONS, undefined, score),
    computedColumn          ('score', 'Score', (r) => String(riskScore(r))),
    textColumn          ('owner', 'Owner', true),
    selectColumn          ('response', 'Response', RISK_RESPONSE_OPTIONS),
    textColumn          ('mitigation', 'Mitigation', true),
    selectColumn          ('status', 'Status', RISK_STATUS_OPTIONS),
    textColumn          ('reviewBy', 'Review by', true),
  ];
}
export const ASSUMPTION_COLUMNS                                        = [
  textColumn                ('id', 'ID'),
  textColumn                ('assumption', 'Assumption'),
  textColumn                ('owner', 'Owner', true),
  textColumn                ('validateBy', 'Validate by', true),
  selectColumn                ('status', 'Status', ASSUMPTION_STATUS_OPTIONS),
  textColumn                ('evidence', 'Evidence', true),
];
export const ISSUE_COLUMNS                                   = [
  textColumn           ('id', 'ID'),
  textColumn           ('issue', 'Issue'),
  selectColumn           ('severity', 'Severity', ISSUE_SEVERITY_OPTIONS),
  numberColumn           ('wave', 'Wave', true),
  listColumn           ('blocks', 'Blocks'),
  textColumn           ('owner', 'Owner', true),
  textColumn           ('opened', 'Opened'),
  textColumn           ('due', 'Due', true),
  selectColumn           ('status', 'Status', ISSUE_STATUS_OPTIONS),
  textColumn           ('resolution', 'Resolution', true),
  selectColumn           ('origin', 'Origin', ISSUE_ORIGIN_OPTIONS, '—'),
];
export const DECISION_COLUMNS                                      = [
  textColumn              ('id', 'ID'),
  textColumn              ('decision', 'Decision'),
  textColumn              ('rationale', 'Rationale', true),
  selectColumn              ('by', 'Decided by', RACI_ROLE_OPTIONS, '—'),
  textColumn              ('date', 'Date'),
  selectColumn              ('source', 'Source', DECISION_SOURCE_OPTIONS),
  listColumn              ('links', 'Links'),
];

/** The next id among rows (R-001 …). */
export function nextId(rows                           , log         )         {
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
export function blankRow(log         , rows                           , today        )                                                       {
  const id = nextId(rows, log);
  switch (log) {
    case 'risks': return { id, risk: '', probability: 3, impact: 3, response: 'reduce', status: 'open' };
    case 'assumptions': return { id, assumption: '', status: 'open' };
    case 'issues': return { id, issue: '', severity: 'sev3', blocks: [], opened: today, status: 'open', origin: 'manual' };
    default: return { id, decision: '', date: today, source: 'manual', links: [] };
  }
}

/** Rows with blank ids given the next free ones, and blank text rows dropped. */
export function tidyRows                          (log         , rows              )      {
  const out      = [];
  for (const r of rows) out.push(r.id.trim() ? r : { ...r, id: nextId([...rows, ...out], log) });
  return out;
}

/** A log's CSV read into rows merged by id with the current ones (the grid's Import CSV). */
export function importLog                   (log   , text        , current                           )                                                  {
  const read = raidFromCsv(log, text);
  const rows = [...current];
  for (const r of read.rows                               ) {
    const id = r.id.trim() || nextId(rows, log);
    const i = rows.findIndex((x) => x.id === id);
    if (i >= 0) rows[i] = { ...r, id };
    else rows.push({ ...r, id });
  }
  return { rows, findings: read.findings };
}

const LOGS                                                           = [
  { log: 'risks', title: 'Risks', noun: 'risk' },
  { log: 'assumptions', title: 'Assumptions', noun: 'assumption' },
  { log: 'issues', title: 'Issues and blockers', noun: 'issue' },
  { log: 'decisions', title: 'Decisions', noun: 'decision' },
];

export function mount(root             , ctx             )       {
  let current                       ;
  const written                                    = {};
  const grids = new Map                   ();
  const banner = el('div');
  const suggested = el('div', { attrs: { 'data-control': 'raid-suggested' } });
  const actions = el('div', { class: 'btn-row' });
  const holders = new Map                      (LOGS.map((l) => [l.log, el('div')]));
  append(root, el('div', { class: 'stack', style: { minWidth: '0', overflowWrap: 'anywhere' } },
    banner,
    ...LOGS.map((l) => card(l.title,
      l.log === 'issues' ? note('An issue with names in Blocks (item or app names, space-separated) blocks those items on the board until it is resolved or closed.') : null,
      l.log === 'decisions' ? note('Gate decisions, rollbacks and re-waves are logged here on their own; add the rest by hand.') : null,
      holders.get(l.log)               ,
      l.log === 'risks' ? el('div', { class: 'stack' }, actions, suggested) : null,
    )),
  ));

  const write = (log         , rows                           ) => {
    const v = current;
    if (!v) return;
    const tidy = tidyRows(log, rows);
    written[log] = tidy;
    const t          = withDerived({ ...v.tracker, raid: { ...v.tracker.raid, [log]: tidy } }, v.ctx);
    current = { ...v, tracker: t };
    void commitTracker(t, ctx);
  };

  const gridFor = (log         , v           )           => {
    const apps = [...new Set([...v.ctx.apps.values()].filter(Boolean))].sort();
    const common = {
      id: `raid-${log}`,
      noun: LOGS.find((l) => l.log === log)?.noun ?? 'row',
      read: () => (current?.tracker.raid[log] ?? [])           ,
      write: (rows         ) => write(log, rows                    ),
      create: (rows                  ) => blankRow(log, rows                             , todayIso())         ,
      pageSize: 50,
      csv: {
        fileName: `raid-${log}.csv`,
        export: () => (current ? raidToCsv(current.tracker, log) : ''),
        import: (text        , rows                  ) => {
          const r = importLog(log, text, rows                             );
          return { rows: r.rows           , findings: r.findings };
        },
      },
    };
    switch (log) {
      case 'risks': return planGrid({ ...common, columns: riskColumns(apps)         , filterKeys: ['status', 'response', 'app'], bulkKeys: ['wave', 'app', 'probability', 'impact', 'owner', 'response', 'status', 'reviewBy'] });
      case 'assumptions': return planGrid({ ...common, columns: ASSUMPTION_COLUMNS         , filterKeys: ['status'] });
      case 'issues': return planGrid({ ...common, columns: ISSUE_COLUMNS         , filterKeys: ['severity', 'status', 'origin'] });
      default: return planGrid({ ...common, columns: DECISION_COLUMNS         , filterKeys: ['source', 'by'] });
    }
  };

  const draw = (v           )       => {
    current = v;
    fill(banner, otherPlanNode(v, ctx));
    for (const { log } of LOGS) {
      const holder = holders.get(log)               ;
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
