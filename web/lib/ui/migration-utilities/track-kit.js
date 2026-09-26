/**
 * What the Track panes of Multi-Cloud Migration & Utilities share (WP-UI-C):
 * the tracker record, the plan as the tracker sees it, importing status files
 * and recording a gate.
 *
 * **One tracker for every pane.** The stored record (the `plan` store's
 * `tracker` key) is read once and kept here; every pane that changes it goes
 * through `commitTracker`, which saves it and tells the other panes, so the
 * Board, Execute, Timeline, RAID and Reports agree without a reload.
 *
 * **The view.** `trackView(plan, record)` is pure: the decision and design
 * (cached by plan-model), the waves (`wavePlanFor`), the `TrackContext`
 * (`trackContext(plan, decision, waves)`), and the tracker brought in line with
 * the plan (`syncTracker`, then `withDerived`). With no record it is a fresh
 * `trackerFor`, saved the first time something is recorded. A record of
 * another plan is kept aside for the banner ("This tracker belongs to plan
 * …"), and a fresh tracker is shown instead.
 */

import { el, append, downloadFile } from '../dom.js';
                                                    
                                                      
import { error } from '../../core/findings.js';
import { withDerived } from '../../multicloud/plan/track/derive.js';
import { evaluateGate, gateFile, gateRecord, recordGate,                } from '../../multicloud/plan/track/gates.js';
import { importStatusFiles,                                      } from '../../multicloud/plan/track/import.js';
import { loadTracker, otherPlanBanner, saveTracker, trackerEnvelopeText } from '../../multicloud/plan/track/store.js';
import { syncTracker, trackContext, trackerFor,                   } from '../../multicloud/plan/track/sync.js';
import { gateFileProblems } from '../../multicloud/plan/execute/waves/gates.js';
             
                                                                                                                  
                                        
import { planModel } from '../multicloud/plan-model.js';
import { wavePlanFor } from '../multicloud/wave-model.js';

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Today, yyyy-mm-dd (UTC). */
export function todayIso(now       = new Date())         {
  return now.toISOString().slice(0, 10);
}
/** Now, UTC ISO to the second (the gate file schema wants no more). */
export function nowIso(now       = new Date())         {
  return `${now.toISOString().slice(0, 19)}Z`;
}

// ---------------------------------------------------------------------------
// The view (pure)
// ---------------------------------------------------------------------------

                            
                      
                                  
                                
                           
                             
                                                                              
                            
                                                                            
                           
                                                       
                               
                                                
                            
 

/** The plan as the tracker sees it, and the tracker in line with it. */
export function trackView(plan      , record                , at         = new Date().toISOString())            {
  const model = planModel(plan);
  const decision = model.decision;
  let waves          ;
  try {
    waves = wavePlanFor(plan, decision);
  } catch {
    waves = { settings: plan.waveSettings, waves: [], groups: [], findings: [] };
  }
  const ctx = trackContext(plan, decision, waves);
  const base = { plan, decision, design: model.design, waves, ctx, ...(model.failure ? { failure: model.failure } : {}) };
  if (record && record.planId === plan.id) {
    const synced = syncTracker(record, plan, decision, waves, { at }).tracker;
    return { ...base, tracker: withDerived(synced, ctx), stored: true };
  }
  const fresh = withDerived(trackerFor(plan, decision, waves, { at }), ctx);
  return { ...base, tracker: fresh, stored: false, ...(record ? { otherPlan: record } : {}) };
}

// ---------------------------------------------------------------------------
// The record, shared by the panes
// ---------------------------------------------------------------------------

let record                            ;
let loading                                     ;
const listeners = new Set                             ();

/** The stored tracker (read once, then kept). */
export function trackerRecord()                          {
  if (record !== undefined) return Promise.resolve(record);
  loading ??= loadTracker().catch(() => null).then((t) => {
    if (record === undefined) record = t;
    return record;
  });
  return loading;
}
/** The stored tracker as last read (undefined until `trackerRecord` resolved). */
export function trackerNow()                             {
  return record;
}

/** Hear every committed tracker. Returns the unsubscribe. */
export function onTracker(listener                             )             {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Keep a tracker: saved in the browser, every pane told, the step bar refreshed. */
export async function commitTracker(tracker         , pane                               )                   {
  record = tracker;
  const ok = await saveTracker(tracker).catch(() => false);
  for (const l of [...listeners]) l(tracker);
  await pane?.refresh().catch(() => undefined);
  return ok;
}

/** Forget the in-memory copy (the next `trackerRecord` reads the store again). */
export function resetTrackerCache()       {
  record = undefined;
  loading = undefined;
}

/**
 * Keep a pane in step with the plan and the tracker: `draw(view)` runs now,
 * after a plan change (debounced) and after any pane commits a tracker.
 */
export function watchTrack(ctx             , draw                           , delay = 250)                              {
  let last                       ;
  let timer                                           ;
  const run = () => {
    last = trackView(ctx.session.plan(), record ?? null);
    draw(last);
  };
  void trackerRecord().then(run);
  ctx.session.subscribe((_p, kind) => {
    if (kind === 'saved') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, kind === 'edit' ? delay : 0);
  });
  onTracker(() => run());
  return () => last;
}

// ---------------------------------------------------------------------------
// Status import
// ---------------------------------------------------------------------------

/** Read picked or dropped files: zips as bytes, the rest as text. */
export async function readUploads(files                 )                          {
  return Promise.all(files.map(async (f) => (/\.zip$/i.test(f.name)
    ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }
    : { name: f.name, text: await f.text() })));
}

/** Import status files into the view's tracker (A.8.2): the report says what changed. */
export async function importIntoView(view           , uploads                         )                                                      {
  return importStatusFiles(view.tracker, uploads, view.ctx);
}

/** Append one event and re-derive (manual transitions, runbook ticks, notices). */
export function withEvent(view                                    , event             )          {
  return withDerived({ ...view.tracker, events: [...view.tracker.events, event] }, view.ctx);
}

/** A wave-level manual event (a runbook task ticked, a notice sent): no item, so it never changes a state. */
export function waveEvent(planId        , wave        , detail        , data                                                     , at        , runId        )              {
  return {
    kind: 'archtoolkit.migration-status', v: 1, planId, runId, at, wave, item: null, path: 'orchestrator', step: 'manual', outcome: 'succeeded',
    dryRun: false, detail, data, source: 'manual',
  };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

                                    
                                      
                        
                                  
                          
                 
                      
                            
                                                      
 

/** The criteria of a gate for the view (auto from the tracker, plus the operator's attestations). */
export function gateCriteria(view                                             , wave                      , gate        , attest                                    = {}, today         )                  {
  const input            = {
    ctx: view.ctx, attest, ...(today ? { today } : {}),
    changeRequests: (view.plan.governance?.cr.system ?? 'none') !== 'none',
  };
  return evaluateGate(view.tracker, wave, gate, input);
}

/**
 * Record a gate decision (A.7.3): the tracker gets the record and a Decisions
 * log entry, and the gate file the scripts read is returned with its
 * `status/`-relative path, checked against the gate file schema.
 */
export function decideGate(view                                             , input                   )                                                                                                      {
  const criteria = gateCriteria(view, input.wave, input.gate, input.attest ?? {}, input.at);
  const rec = gateRecord(input.wave, input.gate, input.decision, input.role, input.at, criteria, input.comment?.trim() || undefined);
  const tracker = recordGate(view.tracker, rec);
  const file = gateFile(tracker, rec, view.ctx);
  const problems = gateFileProblems(JSON.parse(file.text));
  const findings = problems.map((p) => error('ui.gate.file', `The gate file failed its schema check at "${p}".`));
  return { tracker, file, problems, findings };
}

/** The download name of a gate file (`wave-<n>-<slug>.json`). */
export const gateDownloadName = (path        )         => path.split('/').pop() ?? path;

// ---------------------------------------------------------------------------
// Small shared pieces of UI
// ---------------------------------------------------------------------------

/**
 * The banner for a stored tracker of another plan: Export it, or Start a new
 * tracker (which downloads the old one first).
 */
export function otherPlanNode(view           , pane                              )                     {
  const other = view.otherPlan;
  if (!other) return null;
  const exportIt = () => downloadFile(`archtoolkit-migration-tracker-${other.planId.slice(0, 8)}.json`, trackerEnvelopeText(other));
  return el(
    'div',
    { class: 'tip warn', attrs: { role: 'status', 'data-control': 'tracker-other-plan' } },
    el('strong', { text: otherPlanBanner(other) }),
    ' The states shown are a fresh tracker for this plan.',
    el(
      'div',
      { class: 'btn-row', style: { marginTop: 'var(--space-2)' } },
      el('button', { class: 'btn btn-small', text: 'Export it', attrs: { type: 'button' }, on: { click: exportIt } }),
      el('button', {
        class: 'btn btn-small', text: 'Start a new tracker', attrs: { type: 'button', 'data-control': 'tracker-start-new' },
        on: {
          click: () => {
            exportIt();
            void commitTracker(view.tracker, pane);
          },
        },
      }),
    ),
  );
}

/** A file input (styled as a button) that hands over the picked files. */
export function filePicker(label        , accept        , multiple         , control        , onFiles                         )              {
  const input = el('input', { attrs: { type: 'file', accept, multiple, hidden: 'hidden', 'data-control': control } })                    ;
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) onFiles(files);
  });
  return el('label', { class: 'btn btn-small', attrs: { 'data-control': `${control}-button` } }, label, input);
}

/** Make `node` accept dropped files. */
export function onDrop(node             , onFiles                         )              {
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    node.classList.add('dragging');
  });
  node.addEventListener('dragleave', () => node.classList.remove('dragging'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('dragging');
    const files = Array.from((e             ).dataTransfer?.files ?? []);
    if (files.length) onFiles(files);
  });
  return node;
}

/**
 * The Import status control: pick or drop `.zip`, `.jsonl` or `.json` files;
 * the tracker is imported, saved, and the report shown.
 */
export function importStatusControl(get                             , pane                              , control = 'import-status')              {
  const report = el('div', { class: 'small', attrs: { role: 'status', 'data-control': `${control}-report` } });
  const run = (files        ) => {
    const view = get();
    if (!view) return;
    report.textContent = 'Importing…';
    void readUploads(files)
      .then((uploads) => importIntoView(view, uploads))
      .then(async (r) => {
        await commitTracker(r.tracker, pane);
        report.textContent = r.report.summary;
        if (r.report.findings.length) {
          append(report, el('ul', { class: 'small muted' }, ...r.report.findings.slice(0, 8).map((f) => el('li', { text: f.message }))));
        }
      })
      .catch((e         ) => {
        report.textContent = `The files could not be imported: ${e instanceof Error ? e.message : String(e)}`;
      });
  };
  return onDrop(el(
    'div',
    { class: 'stack', attrs: { 'data-control': control } },
    el('div', { class: 'btn-row' }, filePicker('Import status (.zip, .jsonl, .json)…', '.zip,.jsonl,.json,application/json,application/zip', true, `${control}-file`, run)),
    el('p', { class: 'small muted', text: 'Or drop the files here. The scripts write status/events.jsonl; a zip of the project’s status/ and reports/ folders works too. Importing the same file twice changes nothing.' }),
    report,
  ), run);
}
