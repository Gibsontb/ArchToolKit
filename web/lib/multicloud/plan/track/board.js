/**
 * The board's data (addendum A.8.3): filters, and the three views.
 *
 * - By workload: `Name | Kind | App | Wave | Path | Platform | State | Flag |
 *   Since | Last event | Sync | Blocker | Owner`, plus the provider's own word
 *   for the state (MGN "Ready for cutover", HCX "Configured" ...) and the
 *   phase (P0–P9).
 * - By wave: planned against actual window, a stacked state bar, gate chips
 *   G1–G4, item count, % complete, blockers, failed and rolled-back items.
 * - By app: `App | Owner | Items | Waves | Lowest state | % | Test sign-off |
 *   Cutover sign-off | Acceptance | Decom approval | Open issues`.
 *
 * Pure: the page renders these rows.
 */

import { ITEM_FLAG_OPTIONS, ITEM_STATE_OPTIONS, ITEM_STATE_RANK, MIGRATION_PHASE_OPTIONS, PLATFORM_LABELS, labelOf } from '../options.js';
                                                                                                                                                    
import { eventsByItem, gateStates,                } from './derive.js';
import { latestSignOff, signOffId } from './gates.js';
import { pctComplete, waveWindows } from './metrics.js';
import { blockersByItem, isOpenIssue } from './raid.js';
import { providerLabelOf,                } from './states.js';
                                              

                              
                         
                        
                               
                            
                             
                           
                          
                                                           
                                    
 

                           
                        
                        
                                    
                       
                        
                           
                               
                                 
                            
                              
                                                                       
                                  
                                 
                              
                                      
                                    
                        
                         
                                                                  
                             
                           
                                          
                                                
                                   
                        
                               
                                       
                         
                            
                              
 

/** The Sync cell: the last progress % or lag. */
export function syncText(sync                    )         {
  if (!sync) return '';
  if (sync.lagSeconds !== undefined) return `lag ${sync.lagSeconds} s`;
  if (sync.progressPct !== undefined) return `${Math.round(sync.progressPct)}%`;
  return '';
}

/** Every item as a board row (unfiltered, removed items included). */
export function allRows(tracker         , ctx               )             {
  const byItem = eventsByItem(tracker.events);
  const blockers = blockersByItem(tracker, ctx ?? {});
  return Object.values(tracker.items).map((s) => {
    const last = (byItem.get(s.item) ?? []).filter((e) => !e.dryRun).pop();
    const app = ctx?.apps.get(s.item) ?? '';
    const platform = ctx?.platforms.get(s.item);
    const phase = s.phase ?? 'plan';
    const provider = providerLabelOf(s);
    return {
      item: s.item,
      name: ctx?.names.get(s.item) ?? s.item,
      kind: s.kind,
      app,
      wave: s.wave,
      path: s.path,
      ...(platform ? { platform } : {}),
      platformLabel: platform ? PLATFORM_LABELS[platform] : '',
      state: s.state,
      stateLabel: labelOf(ITEM_STATE_OPTIONS, s.state),
      ...(provider ? { providerState: provider } : {}),
      phase,
      phaseLabel: labelOf(MIGRATION_PHASE_OPTIONS, phase),
      flags: s.flags,
      flag: s.flags.map((f) => labelOf(ITEM_FLAG_OPTIONS, f)).join(', '),
      since: s.since,
      lastEvent: last ? `${last.step} ${last.outcome}` : '',
      ...(last ? { lastAt: last.at, lastStep: last.step, lastOutcome: last.outcome } : {}),
      sync: syncText(s.sync),
      blockers: blockers.get(s.item) ?? [],
      owner: ctx?.owners.get(app) ?? '',
      removed: s.removed === true,
      ...(s.lastError ? { lastError: s.lastError } : {}),
    };
  });
}

/** The rows the filters keep, in wave then name order. */
export function boardRows(tracker         , ctx               , filter              = {})             {
  return allRows(tracker, ctx)
    .filter((r) => (filter.includeRemoved || !r.removed)
      && (filter.wave === undefined || r.wave === filter.wave)
      && (filter.app === undefined || r.app.toLowerCase() === filter.app.toLowerCase())
      && (filter.platform === undefined || r.platform === filter.platform)
      && (filter.path === undefined || r.path === filter.path)
      && (filter.state === undefined || r.state === filter.state)
      && (filter.flag === undefined || r.flags.includes(filter.flag))
      && (filter.owner === undefined || r.owner === filter.owner))
    .sort((a, b) => a.wave - b.wave || a.name.localeCompare(b.name));
}

/** The values each filter dropdown offers (only those present). */
export function filterValues(rows                     )   
                                                                                                                                       
  {
  const uniq =    (xs     )      => [...new Set(xs)];
  return {
    waves: uniq(rows.map((r) => r.wave)).sort((a, b) => a - b),
    apps: uniq(rows.map((r) => r.app).filter(Boolean)).sort(),
    platforms: uniq(rows.map((r) => r.platform).filter((p)                => !!p)).sort(),
    paths: uniq(rows.map((r) => r.path)).sort(),
    states: uniq(rows.map((r) => r.state)).sort((a, b) => ITEM_STATE_RANK[a] - ITEM_STATE_RANK[b]),
    flags: uniq(rows.flatMap((r) => [...r.flags])).sort(),
    owners: uniq(rows.map((r) => r.owner).filter(Boolean)).sort(),
  };
}

/** A gate chip: grey (no decision), green (go), red (no-go). */
                                                
const chip = (g           )           => (g === 'go' ? 'green' : g === 'no-go' ? 'red' : 'grey');

                           
                        
                                 
                               
                                
                                
                              
                                                                          
                                                                                 
                                                                    
                         
                       
                            
                          
                              
 

/** One card per wave (of the filtered rows). */
export function waveCards(tracker         , ctx               , filter              = {})             {
  const rows = boardRows(tracker, ctx, filter);
  const windows = new Map(waveWindows(ctx?.waves).map((w) => [w.wave, w]));
  const byItem = eventsByItem(tracker.events);
  const waves = new Map                    ();
  for (const r of rows) waves.set(r.wave, [...(waves.get(r.wave) ?? []), r]);
  return [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([wave, list]) => {
    const counts = new Map                   ();
    for (const r of list) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
    let start                    ;
    let end                    ;
    for (const r of list) {
      for (const e of byItem.get(r.item) ?? []) {
        if (e.dryRun) continue;
        const t = Date.parse(e.at);
        if (e.step === 'replicate') start = start === undefined ? t : Math.min(start, t);
        if (e.step === 'validate' && e.outcome === 'succeeded') end = end === undefined ? t : Math.max(end, t);
      }
    }
    const g = gateStates(tracker, wave);
    const w = windows.get(wave);
    return {
      wave,
      ...(w?.start ? { plannedStart: w.start } : {}),
      ...(w?.end ? { plannedEnd: w.end } : {}),
      plannedLabel: w?.label ?? '',
      ...(start !== undefined ? { actualStart: new Date(start).toISOString() } : {}),
      ...(end !== undefined ? { actualEnd: new Date(end).toISOString() } : {}),
      bar: [...counts.entries()].sort((a, b) => ITEM_STATE_RANK[a[0]] - ITEM_STATE_RANK[b[0]]).map(([state, count]) => ({ state, count })),
      gates: { G1: chip(g.G1), G2: chip(g.G2), G3: chip(g.G3), G4: chip(g.G4) },
      items: list.length,
      pct: pctComplete(list),
      blockers: list.filter((r) => r.blockers.length > 0).length,
      failed: list.filter((r) => r.flags.includes('failed')).length,
      rolledBack: list.filter((r) => r.flags.includes('rolled-back')).length,
    };
  });
}

                         
                       
                         
                         
                                    
                             
                       
                               
                                             
                                                
                                            
                                               
                              
 

/**
 * The By-app grid. An app's sign-off is its own (per wave, else the app's),
 * except the go and the decommission approval, which are the wave's: the
 * app shows approved only when every wave it is in is approved.
 */
export function appRows(tracker         , ctx               , filter              = {})           {
  const rows = boardRows(tracker, ctx, filter);
  const apps = new Map                    ();
  for (const r of rows) apps.set(r.app, [...(apps.get(r.app) ?? []), r]);
  const openIssues = tracker.raid.issues.filter(isOpenIssue);
  return [...apps.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([app, list]) => {
    const waves = [...new Set(list.map((r) => r.wave))].sort((a, b) => a - b);
    const appSign = (kind                            )                       => {
      const ds = waves.map((w) => latestSignOff(tracker, kind, 'app', signOffId(app, w), app)?.decision);
      if (ds.some((d) => d === 'rejected')) return 'rejected';
      return ds.length && ds.every((d) => d === 'approved') ? 'approved' : '';
    };
    const waveSign = (kind                         )                       => {
      const ds = waves.map((w) => latestSignOff(tracker, kind, 'wave', String(w))?.decision ?? latestSignOff(tracker, kind, 'app', signOffId(app, w), app)?.decision);
      if (ds.some((d) => d === 'rejected')) return 'rejected';
      return ds.length && ds.every((d) => d === 'approved') ? 'approved' : '';
    };
    const ids = new Set(list.map((r) => r.item));
    const names = new Set([app.toLowerCase(), ...list.map((r) => r.name.toLowerCase()), ...ids]);
    let lowest            = 'decommissioned';
    for (const r of list) if (ITEM_STATE_RANK[r.state] < ITEM_STATE_RANK[lowest]) lowest = r.state;
    return {
      app,
      owner: ctx?.owners.get(app) ?? '',
      items: list.length,
      waves,
      lowest,
      pct: pctComplete(list),
      testSignOff: appSign('test-passed'),
      cutoverSignOff: waveSign('go'),
      acceptance: appSign('accepted'),
      decomApproval: waveSign('decom-approved'),
      openIssues: openIssues.filter((i) => i.blocks.some((b) => names.has(b.toLowerCase()) || ids.has(b))).length,
    };
  });
}
