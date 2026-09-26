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

import { el, append, downloadFile } from '../dom.ts';
import type { PaneContext } from '../plan-shell.ts';
import type { Finding } from '../../core/findings.ts';
import { error } from '../../core/findings.ts';
import { withDerived } from '../../multicloud/plan/track/derive.ts';
import { evaluateGate, gateFile, gateRecord, recordGate, type GateInput } from '../../multicloud/plan/track/gates.ts';
import { importStatusFiles, type ImportReport, type StatusUpload } from '../../multicloud/plan/track/import.ts';
import { loadTracker, otherPlanBanner, saveTracker, trackerEnvelopeText } from '../../multicloud/plan/track/store.ts';
import { syncTracker, trackContext, trackerFor, type TrackContext } from '../../multicloud/plan/track/sync.ts';
import { gateFileProblems } from '../../multicloud/plan/execute/waves/gates.ts';
import type {
  GateCriterion, GateDecision, GateId, Plan, PlanDecision, RaciRole, StatusEvent, TargetDesign, Tracker, WavePlan,
} from '../../multicloud/plan/types.ts';
import { planModel } from '../multicloud/plan-model.ts';
import { wavePlanFor } from '../multicloud/wave-model.ts';

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Today, yyyy-mm-dd (UTC). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
/** Now, UTC ISO to the second (the gate file schema wants no more). */
export function nowIso(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

// ---------------------------------------------------------------------------
// The view (pure)
// ---------------------------------------------------------------------------

export interface TrackView {
  readonly plan: Plan;
  readonly decision: PlanDecision;
  readonly design: TargetDesign;
  readonly waves: WavePlan;
  readonly ctx: TrackContext;
  /** The tracker shown: the stored one synced to the plan, or a fresh one. */
  readonly tracker: Tracker;
  /** True when the tracker shown is the stored record (not a fresh one). */
  readonly stored: boolean;
  /** A stored tracker of another plan (the banner). */
  readonly otherPlan?: Tracker;
  /** Set when the plan could not be decided. */
  readonly failure?: string;
}

/** The plan as the tracker sees it, and the tracker in line with it. */
export function trackView(plan: Plan, record: Tracker | null, at: string = new Date().toISOString()): TrackView {
  const model = planModel(plan);
  const decision = model.decision;
  let waves: WavePlan;
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

let record: Tracker | null | undefined;
let loading: Promise<Tracker | null> | undefined;
const listeners = new Set<(t: Tracker | null) => void>();

/** The stored tracker (read once, then kept). */
export function trackerRecord(): Promise<Tracker | null> {
  if (record !== undefined) return Promise.resolve(record);
  loading ??= loadTracker().catch(() => null).then((t) => {
    if (record === undefined) record = t;
    return record;
  });
  return loading;
}
/** The stored tracker as last read (undefined until `trackerRecord` resolved). */
export function trackerNow(): Tracker | null | undefined {
  return record;
}

/** Hear every committed tracker. Returns the unsubscribe. */
export function onTracker(listener: (t: Tracker | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Keep a tracker: saved in the browser, every pane told, the step bar refreshed. */
export async function commitTracker(tracker: Tracker, pane?: Pick<PaneContext, 'refresh'>): Promise<boolean> {
  record = tracker;
  const ok = await saveTracker(tracker).catch(() => false);
  for (const l of [...listeners]) l(tracker);
  await pane?.refresh().catch(() => undefined);
  return ok;
}

/** Forget the in-memory copy (the next `trackerRecord` reads the store again). */
export function resetTrackerCache(): void {
  record = undefined;
  loading = undefined;
}

/**
 * Keep a pane in step with the plan and the tracker: `draw(view)` runs now,
 * after a plan change (debounced) and after any pane commits a tracker.
 */
export function watchTrack(ctx: PaneContext, draw: (view: TrackView) => void, delay = 250): () => TrackView | undefined {
  let last: TrackView | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
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
export async function readUploads(files: readonly File[]): Promise<StatusUpload[]> {
  return Promise.all(files.map(async (f) => (/\.zip$/i.test(f.name)
    ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }
    : { name: f.name, text: await f.text() })));
}

/** Import status files into the view's tracker (A.8.2): the report says what changed. */
export async function importIntoView(view: TrackView, uploads: readonly StatusUpload[]): Promise<{ tracker: Tracker; report: ImportReport }> {
  return importStatusFiles(view.tracker, uploads, view.ctx);
}

/** Append one event and re-derive (manual transitions, runbook ticks, notices). */
export function withEvent(view: Pick<TrackView, 'tracker' | 'ctx'>, event: StatusEvent): Tracker {
  return withDerived({ ...view.tracker, events: [...view.tracker.events, event] }, view.ctx);
}

/** A wave-level manual event (a runbook task ticked, a notice sent): no item, so it never changes a state. */
export function waveEvent(planId: string, wave: number, detail: string, data: Readonly<Record<string, string | number | boolean>>, at: string, runId: string): StatusEvent {
  return {
    kind: 'archtoolkit.migration-status', v: 1, planId, runId, at, wave, item: null, path: 'orchestrator', step: 'manual', outcome: 'succeeded',
    dryRun: false, detail, data, source: 'manual',
  };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export interface GateDecisionInput {
  readonly wave: number | 'programme';
  readonly gate: GateId;
  readonly decision: GateDecision;
  readonly role: RaciRole;
  /** UTC ISO. */
  readonly at: string;
  readonly comment?: string;
  readonly attest?: Readonly<Record<string, boolean>>;
}

/** The criteria of a gate for the view (auto from the tracker, plus the operator's attestations). */
export function gateCriteria(view: Pick<TrackView, 'tracker' | 'ctx' | 'plan'>, wave: number | 'programme', gate: GateId, attest: Readonly<Record<string, boolean>> = {}, today?: string): GateCriterion[] {
  const input: GateInput = {
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
export function decideGate(view: Pick<TrackView, 'tracker' | 'ctx' | 'plan'>, input: GateDecisionInput): { tracker: Tracker; file: { path: string; text: string }; problems: string[]; findings: Finding[] } {
  const criteria = gateCriteria(view, input.wave, input.gate, input.attest ?? {}, input.at);
  const rec = gateRecord(input.wave, input.gate, input.decision, input.role, input.at, criteria, input.comment?.trim() || undefined);
  const tracker = recordGate(view.tracker, rec);
  const file = gateFile(tracker, rec, view.ctx);
  const problems = gateFileProblems(JSON.parse(file.text));
  const findings = problems.map((p) => error('ui.gate.file', `The gate file failed its schema check at "${p}".`));
  return { tracker, file, problems, findings };
}

/** The download name of a gate file (`wave-<n>-<slug>.json`). */
export const gateDownloadName = (path: string): string => path.split('/').pop() ?? path;

// ---------------------------------------------------------------------------
// Small shared pieces of UI
// ---------------------------------------------------------------------------

/**
 * The banner for a stored tracker of another plan: Export it, or Start a new
 * tracker (which downloads the old one first).
 */
export function otherPlanNode(view: TrackView, pane: Pick<PaneContext, 'refresh'>): HTMLElement | null {
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
export function filePicker(label: string, accept: string, multiple: boolean, control: string, onFiles: (files: File[]) => void): HTMLElement {
  const input = el('input', { attrs: { type: 'file', accept, multiple, hidden: 'hidden', 'data-control': control } }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) onFiles(files);
  });
  return el('label', { class: 'btn btn-small', attrs: { 'data-control': `${control}-button` } }, label, input);
}

/** Make `node` accept dropped files. */
export function onDrop(node: HTMLElement, onFiles: (files: File[]) => void): HTMLElement {
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    node.classList.add('dragging');
  });
  node.addEventListener('dragleave', () => node.classList.remove('dragging'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('dragging');
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    if (files.length) onFiles(files);
  });
  return node;
}

/**
 * The Import status control: pick or drop `.zip`, `.jsonl` or `.json` files;
 * the tracker is imported, saved, and the report shown.
 */
export function importStatusControl(get: () => TrackView | undefined, pane: Pick<PaneContext, 'refresh'>, control = 'import-status'): HTMLElement {
  const report = el('div', { class: 'small', attrs: { role: 'status', 'data-control': `${control}-report` } });
  const run = (files: File[]) => {
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
      .catch((e: unknown) => {
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
