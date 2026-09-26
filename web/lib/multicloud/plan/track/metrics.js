/**
 * The tracker's numbers (addendum A.8.3–A.8.6): % complete, the tiles, the %
 * by wave table, the wave timeline, burn-down, cumulative flow, velocity,
 * the forecast and the RAG status.
 *
 * - % complete is weighted by state rank: rank(state) / rank('decommissioned')
 *   averaged over the items, except `retire` items, which count 0 or 1.
 * - Velocity is the items cut over per week, averaged over the last four weeks.
 * - The forecast finish is remaining / velocity, against the deadline
 *   (`requirements.timelineMonths` from the plan's `savedAt`); a slip raises
 *   `track.forecast.late` with the weeks late.
 * - RAG: green when the forecast meets the deadline and no Sev1 is open;
 *   amber when the slip is 2 weeks or less, a Sev2 is open, or a blocker is
 *   older than 5 days; red otherwise.
 *
 * Methodology additions: counts per phase (P0–P9) and per strategy, and
 * "migrated / decommissioned vs plan" (the KPIs every provider's governance
 * track asks for).
 *
 * Pure: `today` is passed in (yyyy-mm-dd or ISO).
 */

                                                         
import { ITEM_STATE_PHASE, ITEM_STATE_RANK, ITEM_STATE_VALUES, MIGRATION_PHASE_VALUES } from '../options.js';
             
                                                                                                                    
                     
import { eventsByItem, gateStates,                } from './derive.js';
import { isOpenIssue } from './raid.js';
import { foldItem, sortEvents } from './states.js';
                                              

const DAY = 86_400_000;
const RANK_DONE = ITEM_STATE_RANK.decommissioned;

/** yyyy-mm-dd of a time (UTC). */
export function dayOf(t                 )         {
  return new Date(typeof t === 'number' ? t : Date.parse(t)).toISOString().slice(0, 10);
}
/** The end of a day (UTC) as epoch ms. */
function endOf(day        )         {
  return Date.parse(`${day.slice(0, 10)}T23:59:59.999Z`);
}
function addDays(day        , n        )         {
  return dayOf(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + n * DAY);
}
/** Same day of the month, `n` months later (clamped to the month's end). */
export function addMonths(day        , n        )         {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return dayOf(target.getTime());
}
const today0 = (today         )         => dayOf(today ?? Date.now());

/** Items counted: everything not removed. */
export function liveItems(tracker         )               {
  return Object.values(tracker.items).filter((s) => !s.removed);
}

/** One item's share of "done", 0–1. */
export function itemProgress(s                                    )         {
  if (s.path === 'retire') return s.state === 'decommissioned' ? 1 : 0;
  return ITEM_STATE_RANK[s.state] / RANK_DONE;
}
/** % complete by count (0–100, one decimal), weighted by state rank. */
export function pctComplete(items                                                        )         {
  if (!items.length) return 0;
  return round1((items.reduce((a, s) => a + itemProgress(s), 0) / items.length) * 100);
}
/** % complete weighted by vCPU. */
export function pctCompleteByVcpu(items                                                        , ctx                            )         {
  let total = 0;
  let done = 0;
  for (const s of items) {
    const v = ctx.size.get(s.item)?.vcpu ?? 0;
    total += v;
    done += v * itemProgress(s);
  }
  return total ? round1((done / total) * 100) : 0;
}
const round1 = (x        )         => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------------
// State over time
// ---------------------------------------------------------------------------

/** When an item's state changed, in order: [time ms, new state]. Starts at planned. */
export function stateChanges(base            , events                        )                        {
  const sorted = sortEvents(events).filter((e) => !e.dryRun);
  const out                        = [];
  let last            = 'planned';
  for (let i = 0; i < sorted.length; i += 1) {
    const s = foldItem(base, sorted.slice(0, i + 1)).state;
    if (s !== last) {
      out.push([Date.parse((sorted[i]               ).at), s]);
      last = s;
    }
  }
  return out;
}
function stateAt(changes                                , t        )            {
  let s            = 'planned';
  for (const [at, st] of changes) {
    if (at > t) break;
    s = st;
  }
  return s;
}
/** The first time an item reached `target` or later, or undefined. */
function reachedAt(changes                                , target           )                     {
  return changes.find(([, s]) => ITEM_STATE_RANK[s] >= ITEM_STATE_RANK[target])?.[0];
}

                    
                               
                                                       
 
function timeline(tracker         )           {
  const byItem = eventsByItem(tracker.events);
  const items = liveItems(tracker);
  const changes = new Map                               ();
  for (const s of items) changes.set(s.item, stateChanges(s, byItem.get(s.item) ?? []));
  return { items, changes };
}

// ---------------------------------------------------------------------------
// Wave windows
// ---------------------------------------------------------------------------

                             
                        
                          
                        
                                                  
                         
 

/**
 * Each wave's planned window: its own dates, else counted from the plan's
 * start in `weeks`-long windows in wave order, else "Week N" with no dates.
 */
export function waveWindows(waves                      )               {
  if (!waves) return [];
  const sorted = [...waves.waves].sort((a, b) => a.n - b.n);
  const weeks = waves.settings.weeks;
  const start = waves.settings.start;
  return sorted.map((w, i) => {
    const s = w.start ?? (start ? addDays(start, i * weeks * 7) : undefined);
    const e = w.end ?? (start ? addDays(start, (i + 1) * weeks * 7 - 1) : undefined);
    return { wave: w.n, ...(s ? { start: s } : {}), ...(e ? { end: e } : {}), label: s && e ? `${s} to ${e}` : `Week ${i * weeks + 1}` };
  });
}

// ---------------------------------------------------------------------------
// Burn-down and cumulative flow
// ---------------------------------------------------------------------------

                                                                     
                            
                       
                                                                     
                           
                                                                                          
                          
 

function range(first        , last        )           {
  const out           = [];
  for (let d = first; d <= last && out.length < 3700; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The day span the charts cover: first event or wave start, to today or the last wave end. */
export function chartSpan(tracker         , waves                      , today         )                                  {
  const t = today0(today);
  const days           = [t];
  for (const e of tracker.events) if (!e.dryRun) days.push(dayOf(e.at));
  for (const w of waveWindows(waves)) {
    if (w.start) days.push(w.start);
    if (w.end) days.push(w.end);
  }
  days.sort();
  return { first: days[0]          , last: days[days.length - 1]           };
}

/** One point per day: the items not yet at `target` (actual, to today) and the ideal from the wave plan's end dates. */
export function burnDown(tracker         , target            , waves           , today         )              {
  const t = today0(today);
  const { items, changes } = timeline(tracker);
  const ends = new Map(waveWindows(waves).map((w) => [w.wave, w.end]));
  const hasIdeal = items.length > 0 && items.every((s) => ends.get(s.wave));
  const { first, last } = chartSpan(tracker, waves, today);
  return range(first, last).map((day) => {
    const tEnd = endOf(day);
    const actual = day <= t ? items.filter((s) => ITEM_STATE_RANK[stateAt(changes.get(s.item) ?? [], tEnd)] < ITEM_STATE_RANK[target]).length : undefined;
    const ideal = hasIdeal ? items.filter((s) => (ends.get(s.wave)          ) > day).length : undefined;
    return { day, ...(actual !== undefined ? { actual } : {}), ...(ideal !== undefined ? { ideal } : {}) };
  });
}

/** Count per state per day, to today (the stacked area). */
export function cumulativeFlow(tracker         , waves           , today         )                                                       {
  const t = today0(today);
  const { items, changes } = timeline(tracker);
  const { first } = chartSpan(tracker, waves, today);
  return range(first, t).map((day) => {
    const counts = Object.fromEntries(ITEM_STATE_VALUES.map((s) => [s, 0]))                             ;
    const tEnd = endOf(day);
    for (const s of items) counts[stateAt(changes.get(s.item) ?? [], tEnd)] += 1;
    return { day, counts };
  });
}

// ---------------------------------------------------------------------------
// Velocity, forecast, RAG
// ---------------------------------------------------------------------------

/** Items cut over per week, averaged over the four weeks to `today` (one decimal). */
export function velocity(tracker         , today         )         {
  return round1(rawVelocity(tracker, today));
}
function rawVelocity(tracker         , today         )         {
  const tEnd = endOf(today0(today));
  const from = tEnd - 28 * DAY;
  const { items, changes } = timeline(tracker);
  let n = 0;
  for (const s of items) {
    if (s.path === 'retire') continue;
    const at = reachedAt(changes.get(s.item) ?? [], 'cut-over');
    if (at !== undefined && at > from && at <= tEnd) n += 1;
  }
  return n / 4;
}

                           
                             
                            
                                                                                             
                           
                             
                                                         
                              
                                        
 

/** The forecast finish (remaining ÷ velocity) against the deadline. */
export function forecast(tracker         , ctx                                                                  , today         )           {
  const t = today0(today);
  const remaining = liveItems(tracker).filter((s) => s.path !== 'retire' && ITEM_STATE_RANK[s.state] < ITEM_STATE_RANK['cut-over']).length;
  const raw = rawVelocity(tracker, t);
  const v = round1(raw);
  const finish = remaining === 0 ? t : raw > 0 ? addDays(t, Math.ceil((remaining / raw) * 7)) : undefined;
  const deadline = ctx?.timelineMonths && ctx.planSavedAt ? addMonths(dayOf(ctx.planSavedAt), ctx.timelineMonths) : undefined;
  let weeksLate                    ;
  const findings            = [];
  if (finish && deadline) {
    const late = (Date.parse(finish) - Date.parse(deadline)) / DAY;
    weeksLate = late > 0 ? Math.ceil(late / 7) : 0;
    if (weeksLate > 0) {
      findings.push({
        code: 'track.forecast.late', severity: 'warning',
        message: `At ${v} item${v === 1 ? '' : 's'} a week, the last ${remaining} item${remaining === 1 ? '' : 's'} finish on ${finish}: ${weeksLate} week${weeksLate === 1 ? '' : 's'} after the deadline (${deadline}).`,
        remediation: 'Add capacity per window, run waves in parallel, or move the deadline.',
      });
    }
  }
  return { remaining, velocity: v, ...(finish ? { finish } : {}), ...(deadline ? { deadline } : {}), ...(weeksLate !== undefined ? { weeksLate } : {}), findings };
}

                                            
                            
                    
                       
                          
 

/** The RAG status (A.8.4). */
export function ragStatus(tracker         , ctx                                                                  , today         )            {
  const t = today0(today);
  const f = forecast(tracker, ctx, t);
  const open = tracker.raid.issues.filter(isOpenIssue);
  const sev1 = open.filter((i) => i.severity === 'sev1').length;
  const sev2 = open.filter((i) => i.severity === 'sev2').length;
  const oldBlockers = open.filter((i) => i.blocks.length > 0 && i.opened && Date.parse(t) - Date.parse(i.opened.slice(0, 10)) > 5 * DAY).length;
  const started = tracker.events.some((e) => !e.dryRun && e.item);
  const pastDeadline = f.deadline !== undefined && t > f.deadline && f.remaining > 0;
  const plural = (n        , w        )         => `${n} ${w}${n === 1 ? '' : 's'}`;

  if (sev1) return { rag: 'red', reason: `${plural(sev1, 'Sev1 issue')} open.` };
  if (pastDeadline) return { rag: 'red', reason: `The deadline (${f.deadline}) has passed with ${plural(f.remaining, 'item')} still to cut over.` };
  if (f.weeksLate !== undefined && f.weeksLate > 2) return { rag: 'red', reason: `The forecast finish (${f.finish}) is ${f.weeksLate} weeks after the deadline.` };
  const amber           = [];
  if (f.weeksLate !== undefined && f.weeksLate > 0) amber.push(`the forecast is ${plural(f.weeksLate, 'week')} late`);
  if (sev2) amber.push(`${plural(sev2, 'Sev2 issue')} open`);
  if (oldBlockers) amber.push(`${plural(oldBlockers, 'blocker')} older than 5 days`);
  if (started && f.remaining > 0 && f.velocity === 0) amber.push('nothing was cut over in the last four weeks');
  if (amber.length) return { rag: 'amber', reason: `${amber.join('; ').replace(/^./, (c) => c.toUpperCase())}.` };
  if (!started) return { rag: 'green', reason: 'Not started; no open Sev1 or Sev2 issues.' };
  if (f.remaining === 0) return { rag: 'green', reason: 'Every item is cut over.' };
  return { rag: 'green', reason: f.deadline ? `The forecast finish (${f.finish}) meets the deadline (${f.deadline}).` : `On course; forecast finish ${f.finish}.` };
}

// ---------------------------------------------------------------------------
// Tiles and the % by wave table
// ---------------------------------------------------------------------------

                        
                           
                           
                             
                            
                                  
                          
                           
                              
                       
                             
                                                                                                  
                              
                                     
                            
                           
                                                                                           
                                 
                                                        
                                                             
                                                             
                                                        
 

export function tiles(tracker         , ctx               , today         )        {
  const items = liveItems(tracker);
  const at = (s            , st           )          => ITEM_STATE_RANK[s.state] >= ITEM_STATE_RANK[st];
  const moving = items.filter((s) => s.path !== 'retire');
  const moved = { vcpu: 0, ramGib: 0, storageGib: 0 };
  for (const s of moving) {
    if (!at(s, 'cut-over')) continue;
    const z = ctx?.size.get(s.item);
    if (!z) continue;
    moved.vcpu += z.vcpu;
    moved.ramGib += z.ramGib;
    moved.storageGib += z.storageGib;
  }
  const byPhase = Object.fromEntries(MIGRATION_PHASE_VALUES.map((p) => [p, 0]))                                  ;
  for (const s of items) byPhase[s.phase ?? ITEM_STATE_PHASE[s.state]] += 1;
  const byStrategy                         = {};
  for (const s of items) {
    const st = ctx?.strategies.get(s.item);
    if (st) byStrategy[st] = (byStrategy[st] ?? 0) + 1;
  }
  let plannedByNow                    ;
  if (ctx?.waves) {
    const t = today0(today);
    const ends = new Map(waveWindows(ctx.waves).map((w) => [w.wave, w.end]));
    plannedByNow = moving.filter((s) => {
      const e = ends.get(s.wave);
      return e !== undefined && e <= t;
    }).length;
  }
  return {
    inScope: items.length,
    cutOver: moving.filter((s) => at(s, 'cut-over')).length,
    validated: moving.filter((s) => at(s, 'validated')).length,
    accepted: moving.filter((s) => at(s, 'accepted')).length,
    decommissioned: items.filter((s) => s.state === 'decommissioned').length,
    failed: items.filter((s) => s.flags.includes('failed')).length,
    blocked: items.filter((s) => s.flags.includes('blocked')).length,
    rolledBack: items.filter((s) => s.flags.includes('rolled-back')).length,
    pct: pctComplete(items),
    pctByVcpu: ctx ? pctCompleteByVcpu(items, ctx) : 0,
    moved,
    hostsFreed: tracker.decommissions.reduce((a, d) => a + (d.hostsFreed ?? 0), 0),
    licencesReclaimed: tracker.licences.reduce((a, l) => a + l.count, 0),
    retained: ctx?.retained ?? 0,
    retired: items.filter((s) => s.path === 'retire').length,
    ...(plannedByNow !== undefined ? { plannedByNow } : {}),
    byPhase,
    byStrategy,
  };
}

                          
                        
                         
                                 
                               
                           
                             
                                  
                       
                                
                                                               
                             
 

/** The % by wave table: Wave | Items | Planned end | Cut over | Validated | Decommissioned | % | Forecast end | On track. */
export function waveTable(tracker         , waves           , today         )            {
  const t = today0(today);
  const v = rawVelocity(tracker, t);
  const windows = new Map(waveWindows(waves).map((w) => [w.wave, w]));
  const { items, changes } = timeline(tracker);
  const groups = new Map                      ();
  for (const s of items) groups.set(s.wave, [...(groups.get(s.wave) ?? []), s]);
  for (const w of windows.keys()) if (!groups.has(w)) groups.set(w, []);
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([wave, list]) => {
    const at = (s            , st           )          => ITEM_STATE_RANK[s.state] >= ITEM_STATE_RANK[st];
    const moving = list.filter((s) => s.path !== 'retire');
    const remaining = moving.filter((s) => !at(s, 'cut-over')).length;
    let forecastEnd                    ;
    if (list.length && remaining === 0) {
      const last = Math.max(0, ...moving.map((s) => reachedAt(changes.get(s.item) ?? [], 'cut-over') ?? 0));
      forecastEnd = last ? dayOf(last) : t;
    } else if (remaining > 0 && v > 0) forecastEnd = addDays(t, Math.ceil((remaining / v) * 7));
    const w = windows.get(wave);
    return {
      wave,
      items: list.length,
      ...(w?.start ? { plannedStart: w.start } : {}),
      ...(w?.end ? { plannedEnd: w.end } : {}),
      cutOver: moving.filter((s) => at(s, 'cut-over')).length,
      validated: moving.filter((s) => at(s, 'validated')).length,
      decommissioned: list.filter((s) => s.state === 'decommissioned').length,
      pct: pctComplete(list),
      ...(forecastEnd ? { forecastEnd } : {}),
      ...(forecastEnd && w?.end ? { onTrack: forecastEnd <= w.end } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// The wave timeline (A.8.4 chart 1) and the decommission-due list
// ---------------------------------------------------------------------------

                           
                        
                        
                             
                       
 

/** Items at or past cut-over (not yet decommissioned): cut-over + keep days by criticality. */
export function decommissionDue(tracker         , ctx                                                 )             {
  const { items, changes } = timeline(tracker);
  const out             = [];
  for (const s of items) {
    if (s.path === 'retire' || s.state === 'decommissioned' || ITEM_STATE_RANK[s.state] < ITEM_STATE_RANK['cut-over']) continue;
    const at = reachedAt(changes.get(s.item) ?? [], 'cut-over');
    if (at === undefined) continue;
    const crit = ctx?.criticality.get(s.item) ?? 'tier2';
    const keep = ctx?.keepDays[crit] ?? 14;
    out.push({ item: s.item, wave: s.wave, cutOverAt: new Date(at).toISOString(), due: addDays(dayOf(at), keep) });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.item.localeCompare(b.item));
}

/** Items in hypercare past its length (A.7.5): `track.hypercare.overdue`. */
export function hypercareOverdue(tracker         , ctx                                                                           , today         )            {
  const t = today0(today);
  const { items, changes } = timeline(tracker);
  const out            = [];
  for (const s of items) {
    if (s.path === 'retire' || ITEM_STATE_RANK[s.state] < ITEM_STATE_RANK['cut-over'] || ITEM_STATE_RANK[s.state] >= ITEM_STATE_RANK.accepted) continue;
    const at = reachedAt(changes.get(s.item) ?? [], 'cut-over');
    if (at === undefined) continue;
    const days = ctx?.hypercareDays[ctx.criticality.get(s.item) ?? 'tier2'] ?? 7;
    const end = addDays(dayOf(at), days);
    if (end < t) {
      out.push({
        code: 'track.hypercare.overdue', severity: 'warning', path: s.item,
        message: `${ctx?.names.get(s.item) ?? s.item} has been in hypercare since ${dayOf(at)}; its ${days} days ended on ${end} without the owner's acceptance.`,
        remediation: 'Get the app owner’s acceptance, or record why hypercare is extended.',
      });
    }
  }
  return out;
}

                              
                        
                                           
                                
                              
                                                             
                                                                                                             
                                                          
                                                                                                                
                                            
                                                           
                                         
 

/** One row per wave: planned bar, actual bar (first replicate to last validate), gates, freezes, decommission ticks. */
export function waveTimeline(tracker         , ctx                                                           )                {
  const waves = ctx?.waves;
  const windows = new Map(waveWindows(waves).map((w) => [w.wave, w]));
  const byItem = eventsByItem(tracker.events);
  const items = liveItems(tracker);
  const due = decommissionDue(tracker, ctx);
  const numbers = new Set        ([...items.map((s) => s.wave), ...windows.keys()]);
  const freezes = waves?.settings.freezes ?? [];
  return [...numbers].sort((a, b) => a - b).map((wave) => {
    const planned = windows.get(wave);
    let start                    ;
    let end                    ;
    for (const s of items.filter((x) => x.wave === wave)) {
      for (const e of byItem.get(s.item) ?? []) {
        if (e.dryRun) continue;
        const t = Date.parse(e.at);
        if (e.step === 'replicate') start = start === undefined ? t : Math.min(start, t);
        if (e.step === 'validate' && e.outcome === 'succeeded') end = end === undefined ? t : Math.max(end, t);
      }
    }
    return {
      wave,
      planned,
      ...(start !== undefined ? { actualStart: new Date(start).toISOString() } : {}),
      ...(end !== undefined ? { actualEnd: new Date(end).toISOString() } : {}),
      gates: tracker.gates.filter((g) => g.wave === wave).map((g) => ({ gate: g.gate, at: g.at, decision: g.decision })).sort((a, b) => a.at.localeCompare(b.at)),
      gateState: gateStates(tracker, wave),
      freezes: planned?.start && planned.end ? freezes.filter((f) => f.from <= (planned.end          ) && f.to >= (planned.start          )) : freezes,
      decomDue: due.filter((d) => d.wave === wave),
    };
  });
}
