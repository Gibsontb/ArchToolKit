/**
 * The tracker's exports (addendum A.8.6): CSVs, the weekly status report in
 * Markdown, and the whole set as files for one download.
 *
 * File names carry the plan slug and the report date the user picked, and
 * nothing else (`<plan>-tracker-items-<date>.csv`, `<plan>-status-report-<date>.md`).
 * The contents carry no user, machine or path; the report's one date is the
 * one picked.
 */

import { toCsv } from '../../../core/csv.js';
import { ITEM_STATE_OPTIONS, ITEM_STATE_RANK, ISSUE_SEVERITY_OPTIONS, labelOf, slugName } from '../options.js';
                                                      
import { deriveStatus, eventsByItem } from './derive.js';
import { allRows } from './board.js';
import { gateFile } from './gates.js';
import {
  burnDown, dayOf, decommissionDue, forecast, ragStatus, stateChanges, waveTable, waveWindows,                 
} from './metrics.js';
import { RAID_COLUMNS, isOpenIssue, raidToCsv, riskScore, topRisks,              } from './raid.js';
import { trackerEnvelopeText } from './store.js';
                                              

const csv = (rows                                    , cols                   )         => (rows.length ? toCsv(rows, [...cols]) : `${cols.join(',')}\n`);

/** `<plan-slug>-<base>-<date>.<ext>`. */
export function exportName(planName        , base        , date        , ext        )         {
  const slug = slugName(planName) || 'plan';
  return `${slug}-${base}-${date.slice(0, 10)}.${ext}`;
}

export const ITEM_CSV_COLUMNS = ['item', 'kind', 'name', 'app', 'wave', 'path', 'platform', 'state', 'flag', 'since', 'last_step', 'last_outcome', 'last_at', 'sync', 'blocked_by', 'owner']         ;
export const WAVE_CSV_COLUMNS = ['wave', 'items', 'planned_start', 'planned_end', 'actual_start', 'actual_end', 'pct', 'g1', 'g2', 'g3', 'g4', 'state']         ;
export const EVENT_CSV_COLUMNS = ['at', 'wave', 'item', 'name', 'path', 'step', 'outcome', 'dry_run', 'state', 'detail']         ;

/** tracker-items.csv (removed items left out). */
export function itemsCsv(tracker         , ctx               )         {
  const rows = allRows(tracker, ctx).filter((r) => !r.removed).sort((a, b) => a.wave - b.wave || a.name.localeCompare(b.name)).map((r) => ({
    item: r.item, kind: r.kind, name: r.name, app: r.app, wave: r.wave, path: r.path, platform: r.platform ?? '', state: r.state,
    flag: r.flags.join(' '), since: r.since, last_step: r.lastStep ?? '', last_outcome: r.lastOutcome ?? '', last_at: r.lastAt ?? '',
    sync: r.sync, blocked_by: r.blockers.join(' '), owner: r.owner,
  }));
  return csv(rows, ITEM_CSV_COLUMNS);
}

/** tracker-waves.csv; `state` is the wave's lowest item state. */
export function wavesCsv(tracker         , ctx               )         {
  const { waves } = deriveStatus(tracker, ctx ?? {});
  const windows = new Map(waveWindows(ctx?.waves).map((w) => [w.wave, w]));
  const pct = new Map(waveTable(tracker, ctx?.waves).map((r) => [r.wave, r.pct]));
  const rows = waves.map((w) => ({
    wave: w.wave, items: w.items, planned_start: windows.get(w.wave)?.start ?? '', planned_end: windows.get(w.wave)?.end ?? '',
    actual_start: w.actualStart ?? '', actual_end: w.actualEnd ?? '', pct: pct.get(w.wave) ?? 0,
    g1: w.gates.G1 === 'none' ? '' : w.gates.G1, g2: w.gates.G2 === 'none' ? '' : w.gates.G2,
    g3: w.gates.G3 === 'none' ? '' : w.gates.G3, g4: w.gates.G4 === 'none' ? '' : w.gates.G4, state: w.lowest,
  }));
  return csv(rows, WAVE_CSV_COLUMNS);
}

/** tracker-events.csv, oldest first. */
export function eventsCsv(tracker         , ctx               )         {
  const rows = tracker.events.map((e) => ({
    at: e.at, wave: e.wave ?? '', item: e.item ?? '', name: e.name ?? (e.item ? ctx?.names.get(e.item) ?? '' : ''), path: e.path, step: e.step,
    outcome: e.outcome, dry_run: e.dryRun ? 'true' : 'false', state: e.state ?? '', detail: e.detail ?? '',
  }));
  return csv(rows, EVENT_CSV_COLUMNS);
}

// ---------------------------------------------------------------------------
// The weekly status report
// ---------------------------------------------------------------------------

const cell = (x         )         => String(x ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
function table(head                   , rows                                 )         {
  if (!rows.length) return '_None._\n';
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') + '\n';
}
const addDays = (day        , n        )         => dayOf(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000);

                                
                                                                
                        
                                           
                               
                                                   
                               
 

/** status-report-<date>.md: RAG, progress by wave, done this period, next period, risks, issues, blockers, decisions, burn-down, decommission due. */
export function statusReport(tracker         , ctx                          , options               )         {
  const date = options.date.slice(0, 10);
  const period = options.periodDays ?? 7;
  const from = addDays(date, -period + 1);
  const name = (id        )         => ctx?.names.get(id) ?? id;
  const rag = ragStatus(tracker, ctx, date);
  const f = forecast(tracker, ctx, date);
  const out           = [];
  out.push(`# Migration status report: ${ctx?.planName ?? 'plan'}`, '', `Report date: ${date}`, '');
  out.push(`## Status: ${rag.rag.toUpperCase()}`, '', rag.reason, '');
  if (f.finish || f.deadline) {
    out.push(`Forecast finish ${f.finish ?? 'not yet known'}${f.deadline ? `; deadline ${f.deadline}` : ''}; velocity ${f.velocity} item(s) a week; ${f.remaining} item(s) still to cut over.`, '');
  }

  out.push('## Progress by wave', '');
  out.push(table(['Wave', 'Items', 'Planned end', 'Cut over', 'Validated', 'Decommissioned', '%', 'Forecast end', 'On track'],
    waveTable(tracker, ctx?.waves, date).map((w) => [w.wave, w.items, w.plannedEnd ?? '', w.cutOver, w.validated, w.decommissioned, `${w.pct}%`, w.forecastEnd ?? '', w.onTrack === undefined ? '' : w.onTrack ? 'yes' : 'no'])));

  out.push(`## Done this period (${from} to ${date})`, '');
  const byItem = eventsByItem(tracker.events);
  const done                                        = [];
  const lo = Date.parse(`${from}T00:00:00Z`);
  const hi = Date.parse(`${date}T23:59:59.999Z`);
  for (const s of Object.values(tracker.items)) {
    if (s.removed) continue;
    for (const [t, st] of stateChanges(s, byItem.get(s.item) ?? [])) {
      if (t >= lo && t <= hi && ITEM_STATE_RANK[st] >= ITEM_STATE_RANK['cut-over']) done.push([dayOf(t), name(s.item), st, String(s.wave)]);
    }
  }
  done.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  out.push(table(['Date', 'Item', 'Reached', 'Wave'], done.map((d) => [d[0], d[1], labelOf(ITEM_STATE_OPTIONS, d[2]), d[3]])));

  out.push('## Planned next period (waves starting within 14 days)', '');
  const soon = waveWindows(ctx?.waves).filter((w) => w.start && w.start > date && w.start <= addDays(date, 14));
  out.push(table(['Wave', 'Start', 'End', 'Items'], soon.map((w) => [w.wave, w.start ?? '', w.end ?? '', Object.values(tracker.items).filter((s) => !s.removed && s.wave === w.wave).length])));

  out.push('## Top five risks', '');
  out.push(table(['ID', 'Risk', 'Score', 'Owner', 'Response', 'Status'], topRisks(tracker, 5).map((r) => [r.id, r.risk, riskScore(r), r.owner ?? '', r.response, r.status])));

  out.push('## Open Sev1 and Sev2 issues', '');
  const sev = tracker.raid.issues.filter((i) => isOpenIssue(i) && (i.severity === 'sev1' || i.severity === 'sev2'));
  out.push(table(['ID', 'Issue', 'Severity', 'Wave', 'Owner', 'Opened'], sev.map((i) => [i.id, i.issue, labelOf(ISSUE_SEVERITY_OPTIONS, i.severity), i.wave ?? '', i.owner ?? '', i.opened])));

  out.push('## Blockers', '');
  const blockers = tracker.raid.issues.filter((i) => isOpenIssue(i) && i.blocks.length > 0);
  out.push(table(['ID', 'Issue', 'Blocks', 'Owner', 'Opened'], blockers.map((i) => [i.id, i.issue, i.blocks.join(' '), i.owner ?? '', i.opened])));

  out.push('## Decisions this period', '');
  const decisions = tracker.raid.decisions.filter((d) => d.date >= from && d.date <= date);
  out.push(table(['ID', 'Decision', 'By', 'Date', 'Source'], decisions.map((d) => [d.id, d.decision, d.by ?? '', d.date, d.source])));

  const target = options.target ?? 'cut-over';
  out.push(`## Burn-down (items not yet ${labelOf(ITEM_STATE_OPTIONS, target).toLowerCase()})`, '');
  const points = burnDown(tracker, target, ctx?.waves, date).filter((p) => p.day <= date);
  const weekly = points.filter((_, i) => (points.length - 1 - i) % 7 === 0);
  out.push(table(['Date', 'Ideal', 'Actual'], weekly.map((p) => [p.day, p.ideal ?? '', p.actual ?? ''])));

  out.push('## Decommission due', '');
  out.push(table(['Item', 'Wave', 'Cut over', 'Due'], decommissionDue(tracker, ctx).map((d) => [name(d.item), d.wave, dayOf(d.cutOverAt), d.due])));
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * Every export as files (name → text): the three tracker CSVs, the four RAID
 * CSVs, the status report, the tracker envelope and the gate files of the
 * latest decision per wave and gate.
 */
export function exportFiles(tracker         , ctx                          , date        )                         {
  const plan = ctx?.planName ?? 'plan';
  const files                         = {
    [exportName(plan, 'tracker-items', date, 'csv')]: itemsCsv(tracker, ctx),
    [exportName(plan, 'tracker-waves', date, 'csv')]: wavesCsv(tracker, ctx),
    [exportName(plan, 'tracker-events', date, 'csv')]: eventsCsv(tracker, ctx),
    [exportName(plan, 'status-report', date, 'md')]: statusReport(tracker, ctx, { date }),
    [exportName(plan, 'archtoolkit-migration-tracker', date, 'json')]: trackerEnvelopeText(tracker),
  };
  for (const log of Object.keys(RAID_COLUMNS)             ) files[exportName(plan, `raid-${log}`, date, 'csv')] = raidToCsv(tracker, log);
  const latest = new Map                                        ();
  for (const g of tracker.gates) {
    const k = `${g.wave}|${g.gate}`;
    const cur = latest.get(k);
    if (!cur || cur.at <= g.at) latest.set(k, g);
  }
  for (const g of latest.values()) {
    const f = gateFile(tracker, g, ctx);
    files[f.path] = f.text;
  }
  return files;
}
