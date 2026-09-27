/**
 * Where the plan lives: one record in IndexedDB (store `plan`, key `current`),
 * and a settings file the user can save and load.
 *
 * Two pages share that record (Application Migration and Multi-Cloud
 * Migration & Utilities), so a save can be made conditional on nobody else
 * having saved since (`savePlanIfUnchanged`), and every save is announced on
 * the `archtoolkit.plan` BroadcastChannel so the other page reloads.
 *
 * The same store holds four more records under their own keys (addendum
 * A.11.2): the tracker, the utility log (`changes`), the rate card and the
 * audit trail. They are separate from the plan so that writing them never
 * makes the design "dirty".
 *
 * "No footprints": the plan is kept only here, and `forgetPlan` (the page's
 * "Forget this plan") and Clear all both remove it. The file carries no user
 * name, machine name or path; its `savedAt` is the one date in it, and the
 * generated zip reuses that date so a re-generation is byte-identical.
 *
 * Every call is safe where IndexedDB is missing (tests, locked-down browsers):
 * a load resolves to null (or an empty list) and a save to false / 'failed'.
 */

import { open, run } from '../../kit/idb.js';
import { openEnvelope, stripSecrets, SETTINGS_KINDS,                       } from '../../kit/settings-file.js';
import { isRecord,           } from '../../editor/doc.js';
import {
  DEFAULT_SIZING_POLICY, DEFAULT_WAVE_SETTINGS, PLAN_MODE_VALUES, defaultDcExit, defaultExecution, defaultGovernance,
  defaultRequirements,
} from './options.js';
import {
  PLAN_KIND, RATECARD_KIND, TRACKER_KIND,                                                                                                
                                                     
                                                                                                              
} from './types.js';

export const PLAN_STORE = 'plan'         ;
export const PLAN_KEY = 'current';
/** The other records in the `plan` store (addendum A.11.2). `changes` holds the Utilities log. */
export const TRACKER_KEY = 'tracker';
export const CHANGES_KEY = 'changes';
export const RATECARD_KEY = 'ratecard';
export const AUDIT_KEY = 'audit';
/** Every key the `plan` store uses; Clear all deletes each of them. */
export const PLAN_RECORD_KEYS = Object.freeze([PLAN_KEY, TRACKER_KEY, CHANGES_KEY, RATECARD_KEY, AUDIT_KEY]         );
                                                              
export const DEFAULT_PLAN_NAME = 'Migration plan';

/** The BroadcastChannel a save is announced on. */
export const PLAN_CHANNEL = 'archtoolkit.plan';
/** What a save announces. */
                                   
                          
                           
 

/** A random id: `crypto.randomUUID()` where the browser has it (a secure context), else v4 from getRandomValues. */
export function newPlanId()         {
  const c = (globalThis                       ).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A new plan with nothing in it and the default requirements. */
export function emptyPlan(name         = DEFAULT_PLAN_NAME, savedAt         = new Date().toISOString())       {
  return {
    kind: PLAN_KIND,
    version: 1,
    id: newPlanId(),
    name: name.trim() || DEFAULT_PLAN_NAME,
    savedAt,
    workloads: [],
    databases: [],
    apps: [],
    edges: [],
    requirements: defaultRequirements(),
    designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    mode: 'migrate',
    appPlans: [],
  };
}

// ---------------------------------------------------------------------------
// The other pages: announcing a save
// ---------------------------------------------------------------------------

                                                                                                                    
function channel()                 {
  try {
    const BC = (globalThis                                                        ).BroadcastChannel;
    return typeof BC === 'function' ? new BC(PLAN_CHANNEL) : null;
  } catch {
    return null;
  }
}

/** Tell every other open page that the plan was saved. A no-op where BroadcastChannel is missing. */
export function announcePlanSaved(plan                              )       {
  const ch = channel();
  if (!ch) return;
  try {
    const message                   = { planId: plan.id, savedAt: plan.savedAt };
    ch.postMessage(message);
  } catch {
    // Another page reloading is a convenience; losing it loses nothing stored.
  } finally {
    try {
      ch.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Call `listener` whenever another page saves the plan. Returns the unsubscribe.
 * A channel never hears its own posts, so a page is not told of its own saves.
 */
export function onPlanSaved(listener                                     )             {
  const ch = channel();
  if (!ch) return () => undefined;
  ch.onmessage = (e) => {
    const d = e.data;
    if (isRecord(d        ) && typeof (d                           ).planId === 'string' && typeof (d                           ).savedAt === 'string') {
      listener({ planId: (d                    ).planId, savedAt: (d                    ).savedAt });
    }
  };
  return () => {
    try {
      ch.close();
    } catch {
      // Already closed.
    }
  };
}

// ---------------------------------------------------------------------------
// IndexedDB: the plan
// ---------------------------------------------------------------------------

/** The stored plan, or null when there is none (or it is not a plan this build reads). */
export async function loadPlan()                       {
  const value = await run         (PLAN_STORE, 'readonly', (store) => store.get(PLAN_KEY));
  if (value === null || value === undefined) return null;
  const read = planFromEnvelope(value        );
  return 'ok' in read ? read.ok : null;
}

/** Keep the plan, whatever is stored. Resolves false when the browser will not. Announced on success. */
export async function savePlan(plan      )                   {
  const ok = await run(PLAN_STORE, 'readwrite', (store) => store.put(planEnvelope(plan), PLAN_KEY));
  if (ok !== null) announcePlanSaved(plan);
  return ok !== null;
}

                                                              

/**
 * Keep the plan only if the stored one is still the one this page loaded:
 * its `savedAt` equals `basedOnSavedAt` (or nothing is stored). The read and
 * the write are one transaction, so two pages cannot both win.
 *
 * - 'saved': written (and announced);
 * - 'conflict': another page saved since; nothing was written. Reload, merge, and save again.
 * - 'failed': the browser would not (no IndexedDB, quota, a blocked upgrade).
 *
 * The check is on `savedAt` alone, so replacing the stored plan with a
 * different one (a loaded file) is allowed when it is based on the stored one.
 */
export async function savePlanIfUnchanged(plan      , basedOnSavedAt        )                           {
  const db = await open();
  if (!db) return 'failed';
  const outcome = await new Promise                 ((resolve) => {
    let result                  = 'failed';
    try {
      const tx = db.transaction(PLAN_STORE, 'readwrite');
      const store = tx.objectStore(PLAN_STORE);
      const get = store.get(PLAN_KEY);
      get.onsuccess = () => {
        const current = get.result           ;
        const stored = isRecord(current        ) ? (current                           ).savedAt : undefined;
        if (current !== undefined && current !== null && stored !== basedOnSavedAt) {
          result = 'conflict';
          return;
        }
        store.put(planEnvelope(plan), PLAN_KEY);
        result = 'saved';
      };
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => {
        db.close();
        resolve('failed');
      };
      tx.onabort = () => {
        db.close();
        resolve('failed');
      };
    } catch {
      db.close();
      resolve('failed');
    }
  });
  if (outcome === 'saved') announcePlanSaved(plan);
  return outcome;
}

/** Delete the stored plan (only the plan: the tracker and the other records have their own forget). */
export async function forgetPlan()                {
  await run(PLAN_STORE, 'readwrite', (store) => store.delete(PLAN_KEY));
}

// ---------------------------------------------------------------------------
// IndexedDB: the other records (addendum A.11.2)
// ---------------------------------------------------------------------------

/** The raw value under a key of the `plan` store; undefined when none (or no IndexedDB). */
async function loadRecord(key               )                   {
  const value = await run         (PLAN_STORE, 'readonly', (store) => store.get(key));
  return value ?? undefined;
}

async function saveRecord(key               , value         )                   {
  const clean = stripSecrets(JSON.parse(JSON.stringify(value))        );
  const ok = await run(PLAN_STORE, 'readwrite', (store) => store.put(clean, key));
  return ok !== null;
}

/** Delete one record of the `plan` store. */
export async function forgetPlanRecord(key               )                {
  await run(PLAN_STORE, 'readwrite', (store) => store.delete(key));
}

/**
 * Read, change and write one record in a single transaction, so two pages
 * appending at once do not lose each other's entries. Resolves false when the
 * browser will not.
 */
async function updateRecord(key               , change                               )                   {
  const db = await open();
  if (!db) return false;
  return new Promise         ((resolve) => {
    try {
      const tx = db.transaction(PLAN_STORE, 'readwrite');
      const store = tx.objectStore(PLAN_STORE);
      const get = store.get(key);
      get.onsuccess = () => {
        const next = change(get.result           );
        store.put(stripSecrets(JSON.parse(JSON.stringify(next))        ), key);
      };
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
      tx.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

const list =    (x         )      => (Array.isArray(x) ? (x       ) : []);
const obj = (x         )                          => (isRecord(x        ) ? (x                           ) : {});

/** A fresh tracker for a plan. */
export function emptyTracker(planId        , savedAt         = new Date().toISOString())          {
  return {
    kind: TRACKER_KIND,
    version: 1,
    planId,
    savedAt,
    items: {},
    events: [],
    gates: [],
    signoffs: [],
    raid: { risks: [], assumptions: [], issues: [], decisions: [] },
    notices: [],
    crs: [],
    decommissions: [],
    licences: [],
  };
}

/**
 * A stored tracker record as a `Tracker`, with any list an older build left
 * out filled empty; null when it is not a version-1 tracker. (Reading a
 * tracker *file* is WP-13's `track/store.ts`, which can build on this.)
 */
export function normaliseTracker(value         )                 {
  const v = obj(value);
  if (v.kind !== TRACKER_KIND || v.version !== 1 || typeof v.planId !== 'string') return null;
  const raid = obj(v.raid);
  return {
    ...emptyTracker(v.planId, typeof v.savedAt === 'string' ? v.savedAt : ''),
    items: obj(v.items)                               ,
    events: list(v.events),
    gates: list(v.gates),
    signoffs: list(v.signoffs),
    raid: { risks: list(raid.risks), assumptions: list(raid.assumptions), issues: list(raid.issues), decisions: list(raid.decisions) },
    notices: list(v.notices),
    crs: list(v.crs),
    decommissions: list(v.decommissions),
    licences: list(v.licences),
  };
}

/** The stored tracker (key `tracker`), or null. */
export async function loadTrackerRecord()                          {
  return normaliseTracker(await loadRecord(TRACKER_KEY));
}
export function saveTrackerRecord(tracker         )                   {
  return saveRecord(TRACKER_KEY, tracker);
}
export function forgetTrackerRecord()                {
  return forgetPlanRecord(TRACKER_KEY);
}

/** The utility log (key `changes`, the Utilities area), oldest first; [] when none. */
export async function loadChangeRecords()                                   {
  return list              (await loadRecord(CHANGES_KEY));
}
export function saveChangeRecords(records                         )                   {
  return saveRecord(CHANGES_KEY, records);
}
/** Add one utility run to the log, in the same transaction as the read. */
export function appendChangeRecord(record              )                   {
  return updateRecord(CHANGES_KEY, (current) => [...list(current), record]);
}

/** The rate card (key `ratecard`), or null when none (or not a version-1 card). */
export async function loadRateCard()                           {
  const v = obj(await loadRecord(RATECARD_KEY));
  if (v.kind !== RATECARD_KIND || v.v !== 1) return null;
  return { kind: RATECARD_KIND, v: 1, rows: list(v.rows) };
}
export function saveRateCard(card          )                   {
  return saveRecord(RATECARD_KEY, card);
}

/** The audit trail (key `audit`), oldest first; [] when none. */
export async function loadAuditEntries()                                 {
  return list            (await loadRecord(AUDIT_KEY));
}
export function saveAuditEntries(entries                       )                   {
  return saveRecord(AUDIT_KEY, entries);
}
/** Add one entry to the audit trail, in the same transaction as the read. */
export function appendAuditEntry(entry            )                   {
  return updateRecord(AUDIT_KEY, (current) => [...list(current), entry]);
}

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

/**
 * The plan as a settings envelope (`archtoolkit.multicloud-plan`, version 1).
 * The plan already carries kind, version and savedAt, so the envelope is the
 * plan as plain JSON, with any secret-named field removed for good measure.
 */
export function planEnvelope(plan      )                   {
  const json = JSON.parse(JSON.stringify(plan))        ;
  return stripSecrets(json)                               ;
}

/**
 * A plan from a loaded file (or the stored record). Fields a newer or older
 * build left out come back as their defaults, so an old file still opens; a
 * file from another page, or a different plan version, is an error sentence.
 *
 * The addendum's fields: `mode` (default 'migrate') and `appPlans` (default
 * []) are always filled; `sizing`, `execution`, `governance` and `dcExit` are
 * filled from their defaults when present, and left out when absent (their
 * readers use `?? default…()`).
 */
export function planFromEnvelope(value      )                                   {
  const opened = openEnvelope(value, PLAN_KIND, SETTINGS_KINDS);
  if ('error' in opened) return opened;
  const v = opened.ok;
  if (v.version !== 1) return { error: `That plan was saved by a different version of the planner (version ${String(v.version)}).` };

  const arr =    (x                  )      => (Array.isArray(x) ? (x                  ) : []);
  const rec = (x                  )                       => (isRecord(x) ? x : {});
  const str = (x                  , fallback        )         => (typeof x === 'string' ? x : fallback);

  const defaults = defaultRequirements();
  const r = rec(v.requirements);
  const requirements               = {
    ...defaults,
    ...(r                                    ),
    identity: { ...defaults.identity, ...(rec(r.identity)                                                ) },
    licensing: { ...defaults.licensing, ...(rec(r.licensing)                                                 ) },
    drPattern: { ...defaults.drPattern, ...(rec(r.drPattern)                                                 ) },
    regions: isRecord(r.regions) ? (r.regions                                      ) : defaults.regions,
    skills: isRecord(r.skills) ? (r.skills                                     ) : defaults.skills,
  };
  const w = rec(v.waveSettings);
  const mode           = (PLAN_MODE_VALUES                     ).includes(v.mode          ) ? (v.mode            ) : 'migrate';

  const plan       = {
    kind: PLAN_KIND,
    version: 1,
    id: str(v.id, '') || newPlanId(),
    name: str(v.name, DEFAULT_PLAN_NAME),
    savedAt: str(v.savedAt, new Date().toISOString()),
    workloads: arr(v.workloads),
    databases: arr(v.databases),
    apps: arr(v.apps),
    edges: arr(v.edges),
    requirements,
    ...(isRecord(v.decision) ? { decision: v.decision                                             } : {}),
    designOverrides: rec(v.designOverrides)                                      ,
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, ...(w                                            ), freezes: arr(w.freezes) },
    ...(isRecord(v.intake) ? { intake: v.intake                                           } : {}),
    ...(isRecord(v.generate) ? { generate: v.generate                                             } : {}),
    mode,
    appPlans: arr(v.appPlans),
    ...(isRecord(v.sizing) ? { sizing: sizingFrom(v.sizing) } : {}),
    ...(isRecord(v.execution) ? { execution: executionFrom(v.execution) } : {}),
    ...(isRecord(v.governance) ? { governance: governanceFrom(v.governance) } : {}),
    ...(isRecord(v.dcExit) ? { dcExit: dcExitFrom(v.dcExit) } : {}),
    ...(isRecord(v.networks) ? { networks: networksFrom(v.networks) } : {}),
  };
  return { ok: plan };
}

function sizingFrom(x                      )              {
  const policy = obj(x.policy);
  return {
    policy: {
      ...DEFAULT_SIZING_POLICY,
      ...(policy                                             ),
      families: Array.isArray(policy.families) ? (policy.families                                     ) : [...DEFAULT_SIZING_POLICY.families],
      assumptions: obj(policy.assumptions)                                        ,
    },
    overrides: obj(x.overrides)                            ,
  };
}

function executionFrom(x                      )                    {
  const d = defaultExecution();
  const e = x                                         ;
  return {
    ...d,
    ...e,
    pathOverrides: obj(x.pathOverrides)                                      ,
    keepDays: { ...d.keepDays, ...(obj(x.keepDays)                                          ) },
    hypercareDays: { ...d.hypercareDays, ...(obj(x.hypercareDays)                                               ) },
    lagSeconds: { ...d.lagSeconds, ...(obj(x.lagSeconds)                                            ) },
    dnsZones: list(x.dnsZones),
    lbs: list(x.lbs),
    dataSets: list(x.dataSets),
    vcfImportClusters: list(x.vcfImportClusters),
    landingZones: obj(x.landingZones)                                     ,
  };
}

function governanceFrom(x                      )             {
  const d = defaultGovernance();
  return {
    ...d,
    ...(x                                  ),
    raci: list(x.raci),
    cr: { ...d.cr, ...(obj(x.cr)                             ) },
    comms: { ...d.comms, ...(obj(x.comms)                                ) },
    environments: Array.isArray(x.environments) ? (x.environments                                         ) : d.environments,
  };
}

/** The user's network rows per cloud: lists only, rows kept as saved. */
function networksFrom(x                      )               {
  const out                                            = {};
  for (const [cloud, v] of Object.entries(x)) {
    if (!isRecord(v)) continue;
    out[cloud] = { networks: list(v.networks)                           , subnets: list(v.subnets)                           };
  }
  return out                ;
}

function dcExitFrom(x                      )         {
  return {
    ...defaultDcExit(),
    ...(x                              ),
    infra: list(x.infra),
    external: list(x.external),
    contracts: list(x.contracts),
    assets: list(x.assets),
  };
}
