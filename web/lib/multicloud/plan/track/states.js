/**
 * The tracker's state machine (addendum A.8.2): how one status event moves
 * one item.
 *
 * `foldItem` replays an item's events in time order from `planned`. The
 * tracker always derives from the whole event log, never from the previous
 * result, so an older status file imported late lands in its place and the
 * outcome is the same whatever order the files came in.
 *
 * The rules:
 * - A dry-run event never changes anything (it is only history).
 * - Script events move an item forward only; the two backward moves are the
 *   ones the table names (`rollback`, and `test-cleanup` that did not pass).
 * - A manual event (`source: 'manual'`) sets the state it names, either way,
 *   and is the only way to move a `specialist` item or to accept one.
 * - A failed step sets the flag `failed` and `lastError`; the flag clears on
 *   the next success of the same step.
 * - A provider's own state (`data.providerState`, e.g. MGN "Ready for
 *   cutover") is read through `fromProviderState`, so an operator can record
 *   what a console shows while the toolkit is offline.
 *
 * Pure: no DOM, no storage, no clock.
 */

import { ITEM_STATE_PHASE, ITEM_STATE_RANK, ITEM_STATE_VALUES, LIFECYCLE_TOOL_VALUES } from '../options.js';
import { fromProviderState, providerStateLabel } from '../methodology.js';
             
                                                                                                                    
                     

                                              

/** True when `a` is at or past `b`. */
export function atOrPast(a           , b           )          {
  return ITEM_STATE_RANK[a] >= ITEM_STATE_RANK[b];
}
/** The earlier of two states. */
export function lowerState(a           , b           )            {
  return ITEM_STATE_RANK[a] <= ITEM_STATE_RANK[b] ? a : b;
}
export function isItemState(x         )                 {
  return typeof x === 'string' && (ITEM_STATE_VALUES                     ).includes(x);
}

/**
 * Paths whose rollback leaves replication running, so a rolled-back item goes
 * back to `in-sync` (MGN before finalize keeps replicating; Azure Migrate,
 * Migrate to VMs and Oracle Cloud Migrations keep the replication until it is
 * completed; HCX Bulk and RAV keep the source; the continuous DB paths keep
 * their reverse replication). Every other path goes back to `tested`.
 */
export const REPLICATION_SURVIVES                         = new Set           ([
  'aws-mgn', 'azure-migrate', 'azure-migrate-hyperv', 'azure-migrate-agent', 'gcp-m2vm', 'oci-ocm', 'hcx-bulk', 'hcx-rav',
  'sap-hsr',
  'oracle-zdm-physical', 'oracle-zdm-logical', 'oracle-dataguard', 'oci-dms', 'aws-dms', 'azure-dms', 'gcp-dms', 'azure-pg-migration',
  'sql-ag-seeding', 'sql-log-shipping', 'sql-mi-link', 'sql-mi-lrs', 'pg-logical', 'mysql-replication', 'db2-hadr', 'mongo-mongosync',
  'redis-replicaof', 'cassandra-zdm-proxy',
]);

/** Paths with no replication stage: `prepared` is as far as they get before the test (G1 accepts that). */
export const BUILD_PATHS                         = new Set           (['rebuild', 'deploy', 'appliance-rebuild', 'retire', 'with-db']);

/** The provider tool whose lifecycle vocabulary fits a path, if any. */
export function lifecycleToolOf(path           )                            {
  if (path === 'aws-mgn') return 'aws-transform-mgn';
  if (path.startsWith('azure-migrate')) return 'azure-migrate';
  if (path === 'gcp-m2vm') return 'gcp-m2vm';
  if (path === 'gcp-dms') return 'gcp-dms';
  if (path.startsWith('hcx-')) return 'hcx-mobility-group';
  if (path === 'oci-ocm') return 'oci-ocm';
  return undefined;
}

/** The item's state in its provider's own words ("Ready for cutover"), when the path has a vocabulary for it. */
export function providerLabelOf(status                                    )                     {
  const tool = lifecycleToolOf(status.path);
  return tool ? providerStateLabel(tool, status.state) : undefined;
}

/** A new item at `planned`. */
export function plannedStatus(item        , kind                , wave        , path           , since        , moveGroup         )             {
  return {
    item, kind, wave, path, state: 'planned', since, flags: [], rollbacks: 0,
    phase: ITEM_STATE_PHASE.planned,
    ...(moveGroup ? { moveGroup } : {}),
  };
}

// ---------------------------------------------------------------------------
// Event order
// ---------------------------------------------------------------------------

const OUTCOME_ORDER                                   = { started: 0, skipped: 1, succeeded: 2, failed: 3 };

/** Time order; at the same instant `started` comes before its result. Stable otherwise. */
export function compareEvents(a             , b             )         {
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  if (ta !== tb) return ta - tb;
  return (OUTCOME_ORDER[a.outcome] ?? 9) - (OUTCOME_ORDER[b.outcome] ?? 9);
}
export function sortEvents(events                        )                {
  return events.map((e, i) => ({ e, i })).sort((x, y) => compareEvents(x.e, y.e) || x.i - y.i).map((x) => x.e);
}

/** The dedupe key (A.8.2 step 3): the same line imported twice is one event. */
export function eventKey(e                                                                 )         {
  return `${e.runId}|${e.item ?? ''}|${e.step}|${e.outcome}|${e.at}`;
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/** What the fold carries beside the status. */
                
                   
                
                     
                     
                    
                                                                                               
                           
                      
                  
                     
                                                       
 

/** The state a step's success moves an item to (the A.8.2 table), before the forward-only rule. */
function successState(e             )                        {
  const d = e.data ?? {};
  switch (e.step) {
    case 'prepare':
    case 'deploy':
      return 'prepared';
    case 'replicate':
      return d.inSync === true ? 'in-sync' : 'replicating';
    case 'in-sync':
      return 'in-sync';
    case 'test':
      return 'testing';
    case 'cutover':
      return 'cut-over';
    case 'validate': {
      const phase = d.phase;
      return phase === undefined || phase === 'cutover' ? 'validated' : undefined;
    }
    case 'decommission':
      return 'decommissioned';
    default:
      return undefined;
  }
}
function startedState(e             )                        {
  if (e.step === 'replicate') return 'replicating';
  if (e.step === 'cutover') return 'cutting-over';
  if (e.step === 'test') return 'testing';
  return undefined;
}

function moveTo(w      , state           , at        )       {
  if (w.state !== state) {
    w.state = state;
    w.since = at;
  }
}
function forward(w      , state                       , at        )       {
  if (state && ITEM_STATE_RANK[state] > ITEM_STATE_RANK[w.state]) moveTo(w, state, at);
}
function fail(w      , step        , detail        )       {
  w.failedSteps.add(step);
  w.lastError = detail;
}
function succeed(w      , step        )       {
  if (w.failedSteps.delete(step) && w.failedSteps.size === 0) delete w.lastError;
}

function applyProviderState(w      , path           , e             )       {
  const label = e.data?.providerState;
  if (typeof label !== 'string') return;
  const named = e.data?.tool;
  const tool = typeof named === 'string' && (LIFECYCLE_TOOL_VALUES                     ).includes(named) ? (named                 ) : lifecycleToolOf(path);
  if (!tool) return;
  const hit = fromProviderState(tool, label);
  if (!hit) return;
  forward(w, hit.state, e.at);
  if (hit.flag === 'failed') fail(w, e.step, `${label} (${tool})`);
  if (hit.flag === 'blocked') w.onHold = true;
}

function applyOne(w      , path           , e             )       {
  if (e.dryRun) return;
  w.lastEvent = e.at;
  const d = e.data ?? {};
  if (typeof d.progressPct === 'number' || typeof d.lagSeconds === 'number') {
    w.sync = {
      ...(typeof d.progressPct === 'number' ? { progressPct: d.progressPct } : w.sync?.progressPct !== undefined ? { progressPct: w.sync.progressPct } : {}),
      ...(typeof d.lagSeconds === 'number' ? { lagSeconds: d.lagSeconds } : w.sync?.lagSeconds !== undefined ? { lagSeconds: w.sync.lagSeconds } : {}),
    };
  }

  // Manual transitions: the state named, either way, with the reason as the detail.
  if (e.source === 'manual') {
    if (typeof d.hold === 'boolean') w.onHold = d.hold;
    if (d.clearFailed === true) {
      w.failedSteps.clear();
      delete w.lastError;
    }
    if (e.step === 'accept' && e.outcome === 'succeeded' && !e.state) moveTo(w, 'accepted', e.at);
    else if (e.state && e.outcome !== 'failed') moveTo(w, e.state, e.at);
    if (e.outcome === 'failed') fail(w, e.step, e.detail ?? `${e.step} failed`);
    return;
  }

  if (e.outcome === 'skipped') return;
  if (e.outcome === 'failed') {
    fail(w, e.step, e.detail ?? `${e.step} failed`);
    return;
  }

  // Specialist items (non-x86, mainframe) move by hand only.
  if (path === 'specialist') {
    if (e.outcome === 'succeeded') succeed(w, e.step);
    return;
  }

  if (e.outcome === 'started') {
    forward(w, startedState(e), e.at);
    return;
  }

  // succeeded
  succeed(w, e.step);
  switch (e.step) {
    case 'test-cleanup':
      if (d.passed === true) forward(w, 'tested', e.at);
      else {
        if (ITEM_STATE_RANK[w.state] <= ITEM_STATE_RANK.tested) moveTo(w, 'in-sync', e.at);
        fail(w, 'test-cleanup', e.detail ?? 'The test did not pass.');
      }
      break;
    case 'validate':
      if (d.passed === false) fail(w, 'validate', e.detail ?? 'Validation failed.');
      else forward(w, successState(e), e.at);
      break;
    case 'commit':
    case 'finalize':
      w.committed = true;
      break;
    case 'accept':
      // Acceptance is the app owner's sign-off: a manual event, never a script's.
      break;
    case 'rollback': {
      if (d.rehearsal === true) break;
      const survived = typeof d.replicationSurvived === 'boolean' ? d.replicationSurvived : REPLICATION_SURVIVES.has(path) && !w.committed;
      moveTo(w, survived ? 'in-sync' : 'tested', e.at);
      w.rolledBack = true;
      w.rollbacks += 1;
      break;
    }
    case 'cutover':
      forward(w, 'cut-over', e.at);
      w.rolledBack = false;
      break;
    default:
      forward(w, successState(e) ?? (e.state && e.step !== 'manual' ? e.state : undefined), e.at);
  }
  applyProviderState(w, path, e);
}

/**
 * The item's status after its events, from `planned`. `base` gives the fields
 * the events do not (kind, wave, path, move group, removed); its state is
 * ignored. `blockedBy` non-empty sets the flag `blocked`.
 */
export function foldItem(base            , events                        , blockedBy                    = [], createdAt         )             {
  const w       = {
    state: 'planned',
    since: createdAt ?? base.since,
    rollbacks: 0,
    failedSteps: new Set(),
    rolledBack: false,
    onHold: false,
    committed: false,
  };
  for (const e of sortEvents(events)) applyOne(w, base.path, e);
  return statusFrom(base, w, blockedBy);
}

function statusFrom(base            , w      , blockedBy                   )             {
  const flags             = [];
  if (blockedBy.length > 0) flags.push('blocked');
  if (w.failedSteps.size > 0) flags.push('failed');
  if (w.rolledBack) flags.push('rolled-back');
  if (w.onHold) flags.push('on-hold');
  return {
    item: base.item,
    kind: base.kind,
    wave: base.wave,
    path: base.path,
    state: w.state,
    since: w.since,
    flags,
    ...(w.lastEvent ? { lastEvent: w.lastEvent } : {}),
    ...(w.lastError && flags.includes('failed') ? { lastError: w.lastError } : {}),
    rollbacks: w.rollbacks,
    ...(w.sync ? { sync: w.sync } : {}),
    ...(base.removed ? { removed: true } : {}),
    phase: ITEM_STATE_PHASE[w.state],
    ...(base.moveGroup ? { moveGroup: base.moveGroup } : {}),
  };
}

/**
 * Apply one event to a status: the single-step form of `foldItem`. It cannot
 * know which step an existing `failed` flag came from, so only a manual
 * `clearFailed` clears that one; `deriveStatus` (which folds the whole log)
 * is what the tracker uses.
 */
export function applyEvent(status            , e             )             {
  const w       = {
    state: status.state,
    since: status.since,
    ...(status.lastEvent ? { lastEvent: status.lastEvent } : {}),
    ...(status.lastError ? { lastError: status.lastError } : {}),
    rollbacks: status.rollbacks,
    failedSteps: new Set(status.flags.includes('failed') ? ['*'] : []),
    rolledBack: status.flags.includes('rolled-back'),
    onHold: status.flags.includes('on-hold'),
    committed: false,
    ...(status.sync ? { sync: { ...status.sync } } : {}),
  };
  applyOne(w, status.path, e);
  const blocked = status.flags.includes('blocked') ? ['(kept)'] : [];
  return statusFrom(status, w, blocked);
}

// ---------------------------------------------------------------------------
// Manual transitions
// ---------------------------------------------------------------------------

                                   
                          
                        
                        
                           
                            
                                                             
                          
                 
                      
                                             
                          
                               
                          
                                 
 

/** A random run id (hex); runs are not described, only told apart. */
export function newRunId()         {
  const c = (globalThis                       ).crypto;
  const b = new Uint8Array(8);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < b.length; i += 1) b[i] = Math.floor(Math.random() * 256);
  return `manual-${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The event a manual transition writes (A.8.2): `source: 'manual'`, a new run
 * id, the time, and the reason as the detail. Returns an error sentence when
 * the reason is blank.
 */
export function manualEvent(t                  )                                          {
  const reason = t.reason.replace(/\s+/g, ' ').trim();
  if (!reason) return { error: 'Give a reason for the change of state.' };
  if (!isItemState(t.state)) return { error: `${String(t.state)} is not a tracker state.` };
  const data                          = {};
  if (t.hold !== undefined) data.hold = t.hold;
  if (t.clearFailed) data.clearFailed = true;
  return {
    ok: {
      kind: 'archtoolkit.migration-status',
      v: 1,
      planId: t.planId,
      runId: t.runId ?? newRunId(),
      at: new Date(t.at).toISOString(),
      wave: t.wave,
      item: t.item,
      path: t.path,
      step: t.state === 'accepted' ? 'accept' : 'manual',
      outcome: 'succeeded',
      dryRun: false,
      state: t.state,
      detail: reason,
      ...(Object.keys(data).length ? { data } : {}),
      source: 'manual',
    },
  };
}
