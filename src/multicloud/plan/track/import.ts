/**
 * Import status files into the tracker (addendum A.8.2, "Import").
 *
 * Accepted inputs:
 * - `*.jsonl`, one event per line (what `atk_event` appends to `status/events.jsonl`);
 * - `*.json` holding one event or an array of events;
 * - WP-7's `validation-<host>.json` (`archtoolkit.validation`), read as a
 *   `validate` event for the item;
 * - `*.zip` (`importStatusFiles`, async), taking `status/**∕*.jsonl|json` and
 *   `reports/validation-*.json`.
 *
 * Each event is checked (kind, version, the closed sets, a real time), then:
 * - a `planId` other than the tracker's is rejected (`track.import.other-plan`, counted);
 * - an `item` the tracker does not know is matched by name against the
 *   workloads and databases; no match is `track.import.unknown-item`;
 * - duplicates (`runId|item|step|outcome|at`) are dropped, so importing the
 *   same file twice changes nothing;
 * - the rest are appended, sorted by time, and the items re-derived.
 *
 * Nothing that describes the controller is kept: `data` keys that name a
 * user, host, path or secret are dropped, and `detail` is cut to one line.
 */

import { openZip } from '../../../core/zip.ts';
import type { Finding } from '../../../core/findings.ts';
import {
  DB_MOVE_PATH_VALUES, ITEM_STATE_VALUES, MOVE_PATH_VALUES, OUTCOME_VALUES, STATUS_CHANNEL_VALUES, STATUS_EVENT_SOURCE_VALUES, STEP_ID_VALUES,
  itemId,
} from '../options.ts';
import { STATUS_EVENT_KIND, type ItemId, type RaidIssue, type StatusEvent, type Tracker } from '../types.ts';
import { deriveStatus, type DeriveContext } from './derive.ts';
import { nextRaidId, recordDecision, upsertRaid } from './raid.ts';
import { eventKey, sortEvents } from './states.ts';

/** A file as the page read it. */
export interface StatusFile {
  readonly name: string;
  readonly text: string;
}
/** A file that may be a zip. */
export interface StatusUpload {
  readonly name: string;
  readonly text?: string;
  readonly bytes?: Uint8Array | ArrayBuffer;
}

export interface ImportContext extends DeriveContext {
  /** Item → name (the workloads' and databases' names), for matching an unknown `item`. */
  readonly names?: ReadonlyMap<ItemId, string>;
}

export interface ImportReport {
  readonly imported: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly changed: number;
  readonly dryRun: number;
  readonly findings: readonly Finding[];
  /** "n events imported, n duplicates, n rejected; n items changed state". */
  readonly summary: string;
}

export const VALIDATION_KIND = 'archtoolkit.validation';

const PATHS = new Set<string>([...MOVE_PATH_VALUES, ...DB_MOVE_PATH_VALUES, ...STATUS_CHANNEL_VALUES]);
const has = (list: readonly string[], x: unknown): boolean => typeof x === 'string' && list.includes(x);
/** `data` keys never kept: they would describe the controller or carry a secret. */
const FOOTPRINT_KEY = /^(user(name)?|host(name)?|controller|machine|cwd|path|dir|file|home|ip|password|passwd|secret|token|key|credential)s?$/i;
const SECRET_KEY = /(password|passwd|secret|token|credential|api[-_]?key)/i;

type Raw = Record<string, unknown>;
const isObj = (x: unknown): x is Raw => typeof x === 'object' && x !== null && !Array.isArray(x);

/** One line, as far as 500 characters. */
function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 500 ? `${t.slice(0, 497)}...` : t;
}

/** A status event from parsed JSON, or the reason it is not one. */
export function parseEvent(x: unknown): { ok: StatusEvent } | { error: string } {
  if (!isObj(x)) return { error: 'not an object' };
  if (x.kind !== STATUS_EVENT_KIND) return { error: `kind is ${JSON.stringify(x.kind)}, not ${STATUS_EVENT_KIND}` };
  if (x.v !== 1) return { error: `version ${JSON.stringify(x.v)} is not 1` };
  if (typeof x.planId !== 'string' || !x.planId) return { error: 'no planId' };
  if (typeof x.runId !== 'string' || !x.runId) return { error: 'no runId' };
  if (typeof x.at !== 'string' || Number.isNaN(Date.parse(x.at))) return { error: 'no valid time (at)' };
  if (!(x.wave === null || x.wave === undefined || (typeof x.wave === 'number' && Number.isInteger(x.wave) && x.wave >= 0))) return { error: 'wave is not a number' };
  if (!(x.item === null || x.item === undefined || typeof x.item === 'string')) return { error: 'item is not a string' };
  if (!PATHS.has(x.path as string)) return { error: `unknown path ${JSON.stringify(x.path)}` };
  if (!has(STEP_ID_VALUES, x.step)) return { error: `unknown step ${JSON.stringify(x.step)}` };
  if (!has(OUTCOME_VALUES, x.outcome)) return { error: `unknown outcome ${JSON.stringify(x.outcome)}` };
  if (x.dryRun !== undefined && typeof x.dryRun !== 'boolean') return { error: 'dryRun is not true or false' };
  if (x.state !== undefined && !has(ITEM_STATE_VALUES, x.state)) return { error: `unknown state ${JSON.stringify(x.state)}` };
  if (x.source !== undefined && !has(STATUS_EVENT_SOURCE_VALUES, x.source)) return { error: `unknown source ${JSON.stringify(x.source)}` };
  const data: Record<string, string | number | boolean> = {};
  if (isObj(x.data)) {
    for (const [k, v] of Object.entries(x.data)) {
      if (FOOTPRINT_KEY.test(k) || SECRET_KEY.test(k)) continue;
      if (typeof v === 'string') data[k] = oneLine(v);
      else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') data[k] = v;
    }
  }
  const e: StatusEvent = {
    kind: STATUS_EVENT_KIND,
    v: 1,
    planId: x.planId,
    runId: x.runId,
    at: new Date(x.at).toISOString(),
    wave: typeof x.wave === 'number' ? x.wave : null,
    item: typeof x.item === 'string' && x.item ? x.item : null,
    ...(typeof x.name === 'string' && x.name.trim() ? { name: x.name.trim() } : {}),
    path: x.path as StatusEvent['path'],
    step: x.step as StatusEvent['step'],
    outcome: x.outcome as StatusEvent['outcome'],
    dryRun: x.dryRun === true,
    ...(x.state ? { state: x.state as StatusEvent['state'] } : {}),
    ...(typeof x.detail === 'string' && x.detail.trim() ? { detail: oneLine(x.detail) } : {}),
    ...(Object.keys(data).length ? { data } : {}),
    ...(x.source ? { source: x.source as StatusEvent['source'] } : {}),
  };
  return { ok: e };
}

/** One check of a validation report (A.7.5). */
export interface ValidationCheck {
  readonly id: string;
  readonly kind: string;
  readonly target?: string;
  readonly passed: boolean;
  readonly observed?: unknown;
  readonly expected?: unknown;
  readonly ms?: number;
  /** 'warning' marks a check that does not fail the report (a performance regression beyond the tolerance). */
  readonly severity?: string;
}

/**
 * WP-7's `validation-<host>.json` as a `validate` event: succeeded when the
 * report passed, failed otherwise, with the failed checks in the detail.
 * The run id is derived from the report, so importing it twice is one event.
 * Performance warnings (`kind: 'performance'` or `severity: 'warning'`, not
 * passed) are returned for the RAID log.
 */
export function validationToEvent(
  x: unknown, lookup: (idOrName: string) => { item: ItemId; wave: number; path: StatusEvent['path'] } | undefined,
): { ok: StatusEvent; warnings: ValidationCheck[] } | { error: string; item?: string } {
  if (!isObj(x) || x.kind !== VALIDATION_KIND) return { error: 'not a validation report' };
  if (x.v !== 1) return { error: `validation report version ${JSON.stringify(x.v)} is not 1` };
  if (typeof x.planId !== 'string') return { error: 'the validation report has no planId' };
  if (typeof x.at !== 'string' || Number.isNaN(Date.parse(x.at))) return { error: 'the validation report has no valid time' };
  if (typeof x.passed !== 'boolean') return { error: 'the validation report does not say whether it passed' };
  const ref = typeof x.item === 'string' && x.item ? x.item : typeof x.host === 'string' ? x.host : '';
  const found = ref ? lookup(ref) ?? (typeof x.host === 'string' ? lookup(x.host) : undefined) : undefined;
  if (!found) return { error: 'unknown item', item: ref };
  const checks: ValidationCheck[] = Array.isArray(x.checks)
    ? x.checks.filter(isObj).map((c) => ({
      id: String(c.id ?? ''), kind: String(c.kind ?? ''), ...(typeof c.target === 'string' ? { target: c.target } : {}), passed: c.passed === true,
      ...(typeof c.severity === 'string' ? { severity: c.severity } : {}),
    }))
    : [];
  const isWarning = (c: ValidationCheck): boolean => c.kind === 'performance' || c.severity === 'warning';
  const failed = checks.filter((c) => !c.passed && !isWarning(c));
  const warnings = checks.filter((c) => !c.passed && isWarning(c));
  const phase = typeof x.phase === 'string' ? x.phase : 'cutover';
  const at = new Date(x.at).toISOString();
  return {
    ok: {
      kind: STATUS_EVENT_KIND,
      v: 1,
      planId: x.planId,
      runId: `validation-${phase}-${at}`,
      at,
      wave: found.wave,
      item: found.item,
      path: found.path,
      step: 'validate',
      outcome: x.passed ? 'succeeded' : 'failed',
      dryRun: false,
      ...(failed.length ? { detail: oneLine(`Failed checks: ${failed.map((c) => c.id + (c.target ? ` (${c.target})` : '')).join(', ')}`) } : {}),
      data: { phase, passed: x.passed, checks: checks.length, failedChecks: failed.length, warnings: warnings.length },
      source: 'validation',
    },
    warnings,
  };
}

/** The JSON values in one file: lines of a .jsonl, or the value / array of a .json. */
function valuesOf(file: StatusFile): { values: unknown[]; errors: string[] } {
  const text = file.text.charCodeAt(0) === 0xfeff ? file.text.slice(1) : file.text;
  const errors: string[] = [];
  const values: unknown[] = [];
  const lower = file.name.toLowerCase();
  const asLines = (): void => {
    text.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      try {
        values.push(JSON.parse(t));
      } catch {
        errors.push(`${file.name} line ${i + 1} is not JSON`);
      }
    });
  };
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) asLines();
  else {
    try {
      const v = JSON.parse(text) as unknown;
      if (Array.isArray(v)) values.push(...v);
      else values.push(v);
    } catch {
      asLines();
    }
  }
  return { values, errors };
}

/**
 * Import status files (already read as text). Returns the new tracker, items
 * re-derived, and the report. Rollbacks and performance warnings write their
 * RAID entries (a decision per rollback, an issue per regressed item).
 */
export function importStatus(tracker: Tracker, files: readonly StatusFile[], ctx: ImportContext = {}): { tracker: Tracker; report: ImportReport } {
  const findings: Finding[] = [];
  const known = new Set(tracker.events.map(eventKey));
  const fresh: StatusEvent[] = [];
  let duplicates = 0;
  let rejected = 0;
  let otherPlan = 0;
  let dryRun = 0;
  const unknown = new Set<string>();
  const perfWarnings: { item: ItemId; wave: number; checks: ValidationCheck[]; at: string; phase: string }[] = [];

  // Name → item: the workloads' and databases' names, and the ids their names would have.
  const byName = new Map<string, ItemId>();
  for (const [id, name] of ctx.names ?? []) byName.set(name.toLowerCase(), id);
  const resolve = (ref: string): ItemId | undefined => {
    if (ref in tracker.items) return ref;
    const byN = byName.get(ref.toLowerCase());
    if (byN) return byN;
    for (const kind of ['workload', 'database'] as const) {
      const id = itemId(kind, ref);
      if (id in tracker.items) return id;
    }
    return undefined;
  };
  const lookup = (ref: string): { item: ItemId; wave: number; path: StatusEvent['path'] } | undefined => {
    const id = resolve(ref);
    const s = id ? tracker.items[id] : undefined;
    return s ? { item: s.item, wave: s.wave, path: s.path } : undefined;
  };

  const accept = (e: StatusEvent): void => {
    if (e.planId !== tracker.planId) {
      otherPlan += 1;
      rejected += 1;
      return;
    }
    let ev = e;
    if (e.item !== null && !(e.item in tracker.items)) {
      const id = resolve(e.name ?? '') ?? resolve(e.item);
      if (!id) {
        unknown.add(e.name ?? e.item);
        rejected += 1;
        return;
      }
      ev = { ...e, item: id };
    }
    const key = eventKey(ev);
    if (known.has(key)) {
      duplicates += 1;
      return;
    }
    known.add(key);
    if (ev.dryRun) dryRun += 1;
    fresh.push(ev);
  };

  for (const file of files) {
    const { values, errors } = valuesOf(file);
    for (const err of errors) {
      rejected += 1;
      findings.push({ code: 'track.import.bad-line', severity: 'warning', message: `${err}; it was skipped.` });
    }
    values.forEach((v, i) => {
      if (isObj(v) && v.kind === VALIDATION_KIND) {
        const r = validationToEvent(v, lookup);
        if ('error' in r) {
          if (r.error === 'unknown item') {
            if (isObj(v) && v.planId !== tracker.planId) {
              otherPlan += 1;
            } else unknown.add(r.item ?? '(none)');
          } else findings.push({ code: 'track.import.bad-event', severity: 'warning', message: `${file.name}: ${r.error}; it was skipped.` });
          rejected += 1;
          return;
        }
        accept(r.ok);
        if (r.warnings.length && r.ok.planId === tracker.planId && r.ok.item) {
          perfWarnings.push({ item: r.ok.item, wave: r.ok.wave ?? 0, checks: r.warnings, at: r.ok.at, phase: String(r.ok.data?.phase ?? '') });
        }
        return;
      }
      const r = parseEvent(v);
      if ('error' in r) {
        rejected += 1;
        findings.push({ code: 'track.import.bad-event', severity: 'warning', message: `${file.name} event ${i + 1}: ${r.error}; it was skipped.` });
        return;
      }
      accept(r.ok);
    });
  }

  if (otherPlan) {
    findings.push({
      code: 'track.import.other-plan', severity: 'warning',
      message: `${otherPlan} event${otherPlan === 1 ? '' : 's'} belong${otherPlan === 1 ? 's' : ''} to another plan and ${otherPlan === 1 ? 'was' : 'were'} not imported.`,
    });
  }
  for (const name of [...unknown].sort()) {
    findings.push({
      code: 'track.import.unknown-item', severity: 'warning', path: name,
      message: `"${name}" is not a workload or database in this plan; its events were not imported.`,
      remediation: 'Check the name, or add the item to the plan and import the file again.',
    });
  }

  const before = tracker.items;
  let next: Tracker = { ...tracker, events: sortEvents([...tracker.events, ...fresh]) };
  next = { ...next, items: deriveStatus(next, ctx).items };

  // Automatic decisions: every rollback (A.8.5).
  for (const e of fresh) {
    if (e.step !== 'rollback' || e.outcome !== 'succeeded' || e.dryRun || e.data?.rehearsal === true || !e.item) continue;
    next = recordDecision(next, {
      decision: `Rolled back ${ctx.names?.get(e.item) ?? e.item}${e.wave !== null ? ` in wave ${e.wave}` : ''}.`,
      ...(e.detail ? { rationale: e.detail } : {}),
      date: e.at.slice(0, 10),
      source: 'rollback',
      links: [e.item, `run:${e.runId}`],
    });
  }
  // Performance regressions beyond the tolerance become RAID issues (A.7.5).
  for (const w of perfWarnings) {
    const text = `Performance regression on ${ctx.names?.get(w.item) ?? w.item} after the move (${w.phase}): ${w.checks.map((c) => c.id).join(', ')}.`;
    if (next.raid.issues.some((i) => i.issue === text)) continue;
    const issue: RaidIssue = {
      id: nextRaidId(next, 'issues'), issue: text, severity: 'sev3', wave: w.wave, blocks: [], opened: w.at.slice(0, 10), status: 'open', origin: 'validation',
    };
    next = upsertRaid(next, 'issues', issue);
  }

  let changed = 0;
  for (const [id, s] of Object.entries(next.items)) if (before[id]?.state !== s.state) changed += 1;
  const imported = fresh.length;
  const summary = `${imported} event${imported === 1 ? '' : 's'} imported, ${duplicates} duplicate${duplicates === 1 ? '' : 's'}, ${rejected} rejected; ${changed} item${changed === 1 ? '' : 's'} changed state`;
  return { tracker: next, report: { imported, duplicates, rejected, changed, dryRun, findings, summary } };
}

/** Zip entries worth reading: status/**∕*.jsonl|json and reports/validation-*.json. */
export function isStatusEntry(name: string): boolean {
  const n = name.replace(/\\/g, '/');
  return /(^|\/)status\/.*\.(jsonl|json|ndjson)$/i.test(n) || /(^|\/)reports\/validation-[^/]*\.json$/i.test(n);
}

/** Expand uploads to text files: a zip gives its status and validation entries. */
export async function readStatusUploads(uploads: readonly StatusUpload[]): Promise<{ files: StatusFile[]; findings: Finding[] }> {
  const files: StatusFile[] = [];
  const findings: Finding[] = [];
  for (const u of uploads) {
    if (u.name.toLowerCase().endsWith('.zip') && u.bytes) {
      try {
        const zip = openZip(u.bytes);
        for (const name of zip.names.filter(isStatusEntry).filter((n) => !/\/gates\//i.test(n)).sort()) {
          files.push({ name, text: await zip.text(name) });
        }
      } catch (err) {
        findings.push({ code: 'track.import.bad-file', severity: 'warning', message: `${u.name} could not be opened as a zip: ${(err as Error).message}` });
      }
      continue;
    }
    if (typeof u.text === 'string') files.push({ name: u.name, text: u.text });
    else if (u.bytes) files.push({ name: u.name, text: new TextDecoder().decode(u.bytes instanceof Uint8Array ? u.bytes : new Uint8Array(u.bytes)) });
  }
  return { files, findings };
}

/** The UI's Import status: several files at once, zips included. */
export async function importStatusFiles(tracker: Tracker, uploads: readonly StatusUpload[], ctx: ImportContext = {}): Promise<{ tracker: Tracker; report: ImportReport }> {
  const { files, findings } = await readStatusUploads(uploads);
  const r = importStatus(tracker, files, ctx);
  return { tracker: r.tracker, report: { ...r.report, findings: [...findings, ...r.report.findings] } };
}
