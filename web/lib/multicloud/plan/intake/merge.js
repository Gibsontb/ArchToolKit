/**
 * Bringing rows in again without losing what the user typed.
 *
 * Every grid row records, in `edited`, the columns a person set (by typing in
 * the grid, or by importing a CSV that filled them). A reload in merge mode
 * matches rows by name (case-insensitive): an edited cell keeps its value, and
 * every other cell takes the fresh one. Rows only in the plan stay; rows only
 * in the import are added at the end. Replace mode takes the import as it is.
 */

import { RPO_BY_CRITICALITY, RTO_BY_CRITICALITY } from '../options.js';
                                                                      
import { appsForNames,                   } from './adapter.js';

/** What `mergeRows` needs of a row. */
                               
                      
                        
                                      
 

const keyOf = (row              )         => row.name.trim().toLowerCase();

/** Provenance: from the fresh import when it has it, else kept. */
const PROVENANCE = ['facts', 'sourceKey', 'portfolio']         ;

function mergeOne                        (existing   , incoming   )    {
  const kept = new Set        (existing.edited ?? []);
  const out                          = { ...(incoming                                      ) };
  const old = existing                                      ;
  for (const k of kept) {
    if (k in old && old[k] !== undefined) out[k] = old[k];
    else delete out[k];
  }
  out.id = existing.id;
  out.name = existing.name;
  for (const k of PROVENANCE) if (out[k] === undefined && old[k] !== undefined) out[k] = old[k];
  if (old.source !== undefined) out.source = old.source;
  // A confirmed (no longer inferred) database stays confirmed.
  if ('inferred' in old || 'inferred' in out) {
    if (old.inferred !== true) {
      if (old.inferred === undefined) delete out.inferred;
      else out.inferred = old.inferred;
    }
  }
  const edited = [...new Set([...(existing.edited ?? []), ...(incoming.edited ?? [])])];
  if (edited.length > 0) out.edited = edited;
  else delete out.edited;
  return out                ;
}

/**
 * Existing rows merged with incoming ones. `replace` returns the incoming rows;
 * `merge` keeps every existing row (with its edited cells) in its place,
 * refreshes the rest from the matching incoming row, and appends new rows.
 */
export function mergeRows                        (existing              , incoming              , mode           )      {
  if (mode === 'replace') return [...incoming];
  const fresh = new Map           ();
  for (const row of incoming) if (!fresh.has(keyOf(row))) fresh.set(keyOf(row), row);
  const used = new Set        ();
  const out      = existing.map((row) => {
    const k = keyOf(row);
    const match = fresh.get(k);
    if (!match) return row;
    used.add(k);
    return mergeOne(row, match);
  });
  const present = new Set(existing.map(keyOf));
  for (const [k, row] of fresh) if (!used.has(k) && !present.has(k)) out.push(row);
  return out;
}

/**
 * A grid edit: the patch applied, its changed keys added to `edited`, and an
 * inferred database confirmed. A key patched to undefined is cleared.
 */
export function editRow                        (row   , patch            )    {
  const out                          = { ...(row                                      ) };
  const changed           = [];
  for (const [k, v] of Object.entries(patch                                      )) {
    if (k === 'id' || k === 'edited') continue;
    if (JSON.stringify(out[k]) === JSON.stringify(v)) continue;
    changed.push(k);
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  if (changed.length === 0) return row;
  out.edited = [...new Set([...(row.edited ?? []), ...changed])];
  if (out.inferred === true) out.inferred = false;
  return out                ;
}

const isEdited = (row                                         , key        )          => (row.edited ?? []).includes(key);

/**
 * Screen 3's "Hosts" link: a workload named as a database host gets role db,
 * unless its role was edited.
 */
export function applyDbHostRoles(workloads                     , databases                     )             {
  const hosts = new Set(databases.flatMap((d) => d.hosts.map((h) => h.trim().toLowerCase())));
  return workloads.map((w)           => (w.role !== 'db' && hosts.has(w.name.toLowerCase()) && !isEdited(w, 'role') ? { ...w, role: 'db' } : w));
}

/**
 * Workloads inherit their app's criticality (and the RPO and RTO that follow
 * from it) unless those cells were edited.
 */
export function applyAppDefaults(workloads                     , apps                )             {
  const byName = new Map(apps.map((a) => [a.name.trim().toLowerCase(), a]));
  return workloads.map((w)           => {
    const app = byName.get(w.app.trim().toLowerCase());
    if (!app || isEdited(w, 'criticality') || w.criticality === app.criticality) return w;
    const c = app.criticality;
    return {
      ...w,
      criticality: c,
      ...(isEdited(w, 'rpo') ? {} : { rpo: RPO_BY_CRITICALITY[c] }),
      ...(isEdited(w, 'rto') ? {} : { rto: RTO_BY_CRITICALITY[c] }),
    };
  });
}

/** App rows for every app name on a workload or database that has none yet, appended. */
export function ensureApps(apps                , workloads                     , databases                     )        {
  const have = new Set(apps.map((a) => a.name.trim().toLowerCase()));
  const missing = [...workloads.map((w) => w.app), ...databases.map((d) => d.app)].filter((n) => n.trim() && !have.has(n.trim().toLowerCase()));
  return [...apps, ...appsForNames(missing, 'manual')];
}

                             
                                          
                                          
                                
 

/**
 * An intake result merged into the plan's rows: each list merged by name,
 * missing app rows added, database hosts marked, app criticality inherited.
 * In replace mode, a list the import did not fill is kept as it was (loading
 * the portfolio does not empty the Workloads screen).
 */
export function mergeIntake(current            , incoming              , mode           )                                                                {
  const pick =                         (have              , got              )      =>
    mode === 'replace' && got.length === 0 ? [...have] : mergeRows(have, got, mode);
  const databases = pick(current.databases, incoming.databases);
  // Apps: an app from a richer source (the portfolio, a CSV) replaces the
  // estate's default row of the same name unless that row was edited.
  const apps0 = pick(current.apps, incoming.apps);
  const wl0 = pick(current.workloads, incoming.workloads);
  const apps = ensureApps(apps0, wl0, databases);
  const workloads = applyAppDefaults(applyDbHostRoles(wl0, databases), apps);
  return { workloads, databases, apps };
}
