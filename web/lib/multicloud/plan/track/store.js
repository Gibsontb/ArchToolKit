/**
 * Where the tracker lives (addendum A.8.1): the `plan` store's `tracker`
 * record, and the settings file `archtoolkit.migration-tracker` (version 1).
 *
 * Built on plan/store.ts's `loadTrackerRecord` / `saveTrackerRecord` /
 * `normaliseTracker`. Every call is null-safe: with no IndexedDB a load
 * resolves to null and a save to false.
 *
 * The file carries no user, machine or path; `savedAt` is its one date.
 */

import { openEnvelope, stripSecrets, SETTINGS_KINDS,                       } from '../../../kit/settings-file.js';
                                                   
import { ITEM_STATE_RANK } from '../options.js';
import { forgetTrackerRecord, loadTrackerRecord, normaliseTracker, saveTrackerRecord } from '../store.js';
import { TRACKER_KIND,                         } from '../types.js';

/** The stored tracker, or null. */
export function loadTracker()                          {
  return loadTrackerRecord();
}
/** Keep the tracker (its `savedAt` set to `at`, default now). Resolves false when the browser will not. */
export function saveTracker(tracker         , at         = new Date().toISOString())                   {
  return saveTrackerRecord({ ...tracker, savedAt: at });
}
/** Delete the stored tracker. */
export function forgetTracker()                {
  return forgetTrackerRecord();
}

/** The tracker as a settings envelope (it already carries kind, version and savedAt). */
export function trackerEnvelope(tracker         )                   {
  return stripSecrets(JSON.parse(JSON.stringify(tracker))        )                               ;
}
/** The envelope as file text (JSON, two-space indent, newline-terminated). */
export function trackerEnvelopeText(tracker         )         {
  return `${JSON.stringify(trackerEnvelope(tracker), null, 2)}\n`;
}

/** A tracker from a loaded file, or an error sentence (another page's file, another version). */
export function trackerFromEnvelope(value      )                                      {
  const opened = openEnvelope(value, TRACKER_KIND, SETTINGS_KINDS);
  if ('error' in opened) return opened;
  const v = opened.ok;
  if (v.version !== 1) return { error: `That tracker was saved by a different version (version ${String(v.version)}).` };
  const t = normaliseTracker(v);
  return t ? { ok: t } : { error: 'That tracker file has no plan id.' };
}

/** True when the tracker belongs to the plan. */
export function trackerMatchesPlan(tracker                         , plan                  )          {
  return tracker.planId === plan.id;
}

/** The banner for a tracker of another plan: "This tracker belongs to plan <name> (<first 8 of id>)". */
export function otherPlanBanner(tracker                         , planName         )         {
  return `This tracker belongs to plan ${planName ?? 'another plan'} (${tracker.planId.slice(0, 8)}).`;
}

/** How many items are past `planned` (the forget confirmation names it). */
export function countPastPlanned(tracker         )         {
  return Object.values(tracker.items).filter((s) => !s.removed && ITEM_STATE_RANK[s.state] > ITEM_STATE_RANK.planned).length;
}

/** The confirmation "Forget this plan" shows when a tracker exists. */
export function forgetConfirmation(tracker         )         {
  const n = countPastPlanned(tracker);
  return n
    ? `This also forgets the migration tracker, where ${n} item${n === 1 ? ' is' : 's are'} past planned. Export it first if you need the history.`
    : 'This also forgets the migration tracker (nothing has started yet).';
}
