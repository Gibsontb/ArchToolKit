/**
 * The utility log (addendum A.9.1, "the change log"; Lead decision 1: the
 * Utilities area): one `ChangeRecord` per generated change bundle, stored in
 * IndexedDB `plan` / key `changes` (store.ts), shown as the grid
 * `Id | Utility | Target | Summary | Generated | Applied | Rolled back | CR`.
 *
 * The bundles' scripts write StatusEvents (`path: 'change'`, `item: <change
 * id>`, step `deploy` for the apply and `rollback` for the rollback); importing
 * a `status/events.jsonl` sets Applied and Rolled back from the successful,
 * non-dry-run events. Import is idempotent: the same file twice changes
 * nothing. Deploy-a-new-service bundles report on the `deploy` path under
 * the app's item id; they are matched by the record's `values.app` too.
 *
 * The pure functions work on arrays; the async ones read and write the store.
 */

                                                                  
import { STATUS_EVENT_KIND } from '../plan/types.js';
import { slugName } from '../plan/options.js';
import { loadChangeRecords, saveChangeRecords } from '../plan/store.js';
                                                

export const CHANGE_LOG_COLUMNS = Object.freeze(['Id', 'Utility', 'Target', 'Summary', 'Generated', 'Applied', 'Rolled back', 'CR']         );
                                                                  

/** Where a change stands: rolled back after its last apply, applied, or only generated. */
export function changeState(r              )              {
  if (r.rolledBackAt && (!r.appliedAt || r.rolledBackAt >= r.appliedAt)) return 'rolled-back';
  if (r.appliedAt) return 'applied';
  return 'generated';
}

/** The records with this one added, or replacing the record with its id (a re-generation keeps Applied / Rolled back / CR). */
export function upsertChangeRecord(records                         , record              )                 {
  const had = records.find((r) => r.id === record.id);
  if (!had) return [...records, record];
  const merged               = {
    ...record,
    ...(had.appliedAt ? { appliedAt: had.appliedAt } : {}),
    ...(had.rolledBackAt ? { rolledBackAt: had.rolledBackAt } : {}),
    ...(had.cr ? { cr: had.cr } : {}),
  };
  return records.map((r) => (r.id === record.id ? merged : r));
}

/** The record a bundle adds to the log. */
export const recordOf = (bundle                              )               => bundle.record;

/** The CR number (or id) of a change; '' clears it. */
export function setChangeCr(records                         , id        , cr        )                 {
  return records.map((r) => {
    if (r.id !== id) return r;
    const { cr: _old, ...rest } = r;
    return cr.trim() ? { ...rest, cr: cr.trim() } : rest;
  });
}

export function removeChangeRecord(records                         , id        )                 {
  return records.filter((r) => r.id !== id);
}

/** Status events from a `status/events.jsonl` text: the valid lines, the rest counted. */
export function parseStatusEvents(text        )                                              {
  const events                = [];
  let rejected = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t)                        ;
      if (e.kind === STATUS_EVENT_KIND && e.v === 1 && typeof e.at === 'string' && typeof e.step === 'string' && typeof e.outcome === 'string' && typeof e.path === 'string') {
        events.push(e               );
      } else {
        rejected += 1;
      }
    } catch {
      rejected += 1;
    }
  }
  return { events, rejected };
}

                               
                                   
                                                                    
                           
                              
                                                      
                           
                           
 

const later = (a                    , b        )         => (a && a >= b ? a : b);

/**
 * Applied / Rolled back from the scripts' events: the latest successful
 * `deploy` (Applied) and `rollback` (Rolled back) event of each change, dry
 * runs left out. A change bundle's events carry `path: 'change'` and the
 * change id; a Deploy a new service bundle's carry `path: 'deploy'` and the
 * app's item id (`a:<app>`), matched to the latest record of that utility for
 * that app.
 */
export function applyChangeEvents(records                         , events                        )               {
  const out = records.map((r) => ({ ...r }));
  const byId = new Map(out.map((r, i) => [r.id, i]));
  let applied = 0;
  let rolledBack = 0;
  let unknown = 0;
  for (const e of events) {
    if (e.dryRun || e.outcome !== 'succeeded' || (e.step !== 'deploy' && e.step !== 'rollback') || !e.item) continue;
    let i                    ;
    if (e.path === 'change') {
      i = byId.get(e.item);
    } else if (e.path === 'deploy') {
      const app = e.item.replace(/^a:/, '');
      const hits = out.map((r, k) => ({ r, k })).filter(({ r }) => r.utility === 'deploy-service' && slugName(r.values.app ?? '') === app);
      i = hits.sort((a, b) => b.r.generatedAt.localeCompare(a.r.generatedAt))[0]?.k;
    } else {
      continue;
    }
    if (i === undefined) {
      unknown += 1;
      continue;
    }
    const r = out[i] ;
    if (e.step === 'deploy') {
      const next = later(r.appliedAt, e.at);
      if (next !== r.appliedAt) {
        out[i] = { ...r, appliedAt: next };
        applied += 1;
      }
    } else {
      const next = later(r.rolledBackAt, e.at);
      if (next !== r.rolledBackAt) {
        out[i] = { ...r, rolledBackAt: next };
        rolledBack += 1;
      }
    }
  }
  const summary = `${applied} change${applied === 1 ? '' : 's'} applied, ${rolledBack} rolled back${unknown ? `; ${unknown} event${unknown === 1 ? '' : 's'} for changes not in the log` : ''}`;
  return { records: out, applied, rolledBack, unknown, summary };
}

const cell = (s                    )         => (s ?? '').replace(/[|\r\n]+/g, ' ').trim();
const day = (iso                    )         => (iso ? iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, 'Z') : '');

/** The log as rows of the grid's columns, newest first. */
export function changeLogRows(records                         )             {
  return [...records]
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || a.id.localeCompare(b.id))
    .map((r) => [r.id, r.utility, cell(r.target), cell(r.summary), day(r.generatedAt), day(r.appliedAt), day(r.rolledBackAt), cell(r.cr)]);
}

/** The log as the " | " grid text the page shows (and a CSV-free export). */
export function changeLogGrid(records                         )         {
  return changeLogRows(records).map((r) => r.join(' | ')).join('\n');
}

// ---------------------------------------------------------------------------
// The store (IndexedDB `plan` / `changes`)
// ---------------------------------------------------------------------------

/** The utility log, oldest first; [] when none. */
export function loadUtilityLog()                                   {
  return loadChangeRecords();
}

/** Record a generated bundle (replacing a re-generation of the same change). */
export async function recordUtilityRun(bundle                              )                   {
  const records = await loadChangeRecords();
  return saveChangeRecords(upsertChangeRecord(records, bundle.record));
}

/** Import a `status/events.jsonl` into the log. */
export async function importUtilityEvents(text        )                                                                                 {
  const { events, rejected } = parseStatusEvents(text);
  const result = applyChangeEvents(await loadChangeRecords(), events);
  const saved = result.applied + result.rolledBack > 0 ? await saveChangeRecords(result.records) : true;
  return { ...result, rejected, saved };
}

/** Set a change's CR number in the log. */
export async function setUtilityCr(id        , cr        )                   {
  return saveChangeRecords(setChangeCr(await loadChangeRecords(), id, cr));
}
