/**
 * Derive every item's status, and each wave's roll-up, from the event log
 * (addendum A.8.2 step 5).
 *
 * The fold always starts from `planned` and replays every event in time
 * order, so the result depends only on the set of events: importing files
 * twice, or in any order, gives the same tracker. Blockers come from the RAID
 * issues' `blocks` cells; a database's host VM that follows it (method
 * `managed-db`) is decommissioned once the database is accepted.
 *
 * Pure.
 */

import { ITEM_STATE_PHASE, ITEM_STATE_RANK, ITEM_STATE_VALUES } from '../options.js';
                                                                                               
import { blockersByItem,                    } from './raid.js';
import { foldItem, sortEvents } from './states.js';

                                                      
                                           
                                                   
 

                                                

/** One wave's roll-up. */
                             
                        
                         
                                                        
                                                
                             
                                                                                                     
                                
                                                              
                              
                                                      
                           
                          
                              
 

/** The events of one item, in time order, including dry runs (the history lists them, marked). */
export function eventsByItem(events                        )                             {
  const out = new Map                       ();
  for (const e of sortEvents(events)) {
    if (!e.item) continue;
    const list = out.get(e.item) ?? [];
    list.push(e);
    out.set(e.item, list);
  }
  return out;
}

/** The latest recorded decision per gate for a wave. */
export function gateStates(tracker         , wave                      )                            {
  const out                            = { G1: 'none', G2: 'none', G3: 'none', G4: 'none', G5: 'none' };
  const latest = new Map                ();
  for (const g of tracker.gates) {
    if (g.wave !== wave) continue;
    const t = Date.parse(g.at);
    if ((latest.get(g.gate) ?? -Infinity) <= t) {
      latest.set(g.gate, t);
      out[g.gate] = g.decision;
    }
  }
  return out;
}

/** Every item's status and every wave's roll-up, from the events. */
export function deriveStatus(tracker         , ctx                = {})                                                             {
  const byItem = eventsByItem(tracker.events);
  const blockers = blockersByItem(tracker, ctx);
  const items                             = {};
  for (const [id, base] of Object.entries(tracker.items)) {
    items[id] = foldItem(base, byItem.get(id) ?? [], blockers.get(id) ?? [], createdAt(tracker, base));
  }
  // A replatformed database's host VM follows its database.
  for (const [host, db] of ctx.followers ?? []) {
    const h = items[host];
    const d = items[db];
    if (!h || !d) continue;
    if (ITEM_STATE_RANK[d.state] >= ITEM_STATE_RANK.accepted && ITEM_STATE_RANK[h.state] < ITEM_STATE_RANK.decommissioned) {
      items[host] = { ...h, state: 'decommissioned', since: d.since, phase: ITEM_STATE_PHASE.decommissioned };
    }
  }
  return { items, waves: waveStatuses(tracker, items, byItem) };
}

function createdAt(tracker         , base            )         {
  return base.state === 'planned' ? base.since : tracker.savedAt || base.since;
}

/** The tracker with its items re-derived (keeps everything else). */
export function withDerived(tracker         , ctx                = {})          {
  return { ...tracker, items: deriveStatus(tracker, ctx).items };
}

function emptyCounts()                            {
  return Object.fromEntries(ITEM_STATE_VALUES.map((s) => [s, 0]))                             ;
}

function waveStatuses(tracker         , items                                      , byItem                                    )               {
  const waves = new Map                      ();
  for (const s of Object.values(items)) {
    if (s.removed) continue;
    const list = waves.get(s.wave) ?? [];
    list.push(s);
    waves.set(s.wave, list);
  }
  return [...waves.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wave, list]) => {
      const byState = emptyCounts();
      let lowest            = 'decommissioned';
      let start                    ;
      let end                    ;
      for (const s of list) {
        byState[s.state] += 1;
        if (ITEM_STATE_RANK[s.state] < ITEM_STATE_RANK[lowest]) lowest = s.state;
        for (const e of byItem.get(s.item) ?? []) {
          if (e.dryRun) continue;
          const t = Date.parse(e.at);
          if (e.step === 'replicate' || ((e.step === 'prepare' || e.step === 'deploy') && s.path !== 'retire')) start = start === undefined ? t : Math.min(start, t);
          if (e.step === 'validate' && e.outcome === 'succeeded') end = end === undefined ? t : Math.max(end, t);
        }
      }
      return {
        wave,
        items: list.length,
        byState,
        lowest: list.length ? lowest : 'planned',
        ...(start !== undefined ? { actualStart: new Date(start).toISOString() } : {}),
        ...(end !== undefined ? { actualEnd: new Date(end).toISOString() } : {}),
        gates: gateStates(tracker, wave),
        blocked: list.filter((s) => s.flags.includes('blocked')).length,
        failed: list.filter((s) => s.flags.includes('failed')).length,
        rolledBack: list.filter((s) => s.flags.includes('rolled-back')).length,
      };
    });
}

/** One line of an item's history, for the detail panel. */
                              
                      
                                     
                                           
                           
                                                      
                             
                           
                                               
                        
 

/** An item's event history, oldest first; dry-run events are listed and marked "dry run". */
export function itemHistory(tracker         , item        )                {
  return sortEvents(tracker.events.filter((e) => e.item === item)).map((e) => ({
    at: e.at,
    step: e.step,
    outcome: e.outcome,
    dryRun: e.dryRun,
    source: e.source ?? 'script',
    ...(e.state ? { state: e.state } : {}),
    ...(e.detail ? { detail: e.detail } : {}),
    note: e.dryRun ? 'dry run' : '',
  }));
}
