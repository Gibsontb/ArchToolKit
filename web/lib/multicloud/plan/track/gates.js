/**
 * Go / no-go gates (addendum A.7.3): the criteria evaluated from the
 * tracker, recording a decision, and the gate file the scripts check.
 *
 * | Gate | Auto (from the tracker) | Manual (sign-offs) |
 * |---|---|---|
 * | G1 Ready | every item in-sync (prepared for build paths) and tested, or a test skip with a rollback rehearsal; no open blockers; quotas checked; the change request approved | the app owners' test sign-off; comms T−14 and T−2 sent |
 * | G2 Go | pre-checks pass; lag within the setting; a rollback path per item | the go decision (wave sign-off `go`); the rollback decision-maker named |
 * | G3 Commit | validation passed for every item; no Sev1 / Sev2 open for the wave | the app owners' acceptance |
 * | G4 Decommission | keep-days elapsed since cut-over; a target backup per item; no Sev1 / Sev2 for 7 days; no `source-still-on` | the decommission approval |
 * | G5 Lights-out | every item decommissioned or retired | the `lights-out` sign-off |
 *
 * Gate files are `gates/wave-<n>-<slug>.json` (slug ready, go, commit,
 * decommission; `gates/programme-lights-out.json`), matching the name
 * `cutover.sh` checks (`status/gates/wave-<n>-go.json`). They carry the
 * role that decided, never a person's name.
 */

                                                         
import { ITEM_STATE_RANK } from '../options.js';
                                                                                                                                               
import { blockersByItem, isOpenIssue, recordDecision } from './raid.js';
import { BUILD_PATHS, sortEvents } from './states.js';
                                              

export const GATE_FILE_KIND = 'archtoolkit.migration-gate';
/** The word in the gate file's name. */
export const GATE_SLUG                                   = { G1: 'ready', G2: 'go', G3: 'commit', G4: 'decommission', G5: 'lights-out' };

/** The sign-off id for an app in a wave ("app per wave" kinds: test-passed, accepted). */
export function signOffId(app        , wave         )         {
  return wave === undefined ? app : `${app}@wave-${wave}`;
}

/** The latest sign-off of a kind for a scope and id (an app's per-wave id falls back to the app's). */
export function latestSignOff(tracker         , kind             , scope                  , id        , fallbackId         )                      {
  const pick = (want        )                      =>
    tracker.signoffs.filter((s) => s.kind === kind && s.scope === scope && s.id === want).sort((a, b) => a.at.localeCompare(b.at)).pop();
  return pick(id) ?? (fallbackId !== undefined ? pick(fallbackId) : undefined);
}
/** Add a sign-off (role only; a name goes in the comment if the user wants one). */
export function addSignOff(tracker         , s         )          {
  return { ...tracker, signoffs: [...tracker.signoffs, s] };
}

                            
                              
                                                               
                          
                                                                         
                                          
                                                                                              
                                                      
                                                                                                                             
                                    
 

const DAY = 86_400_000;
const crit = (id        , auto         , met         , detail        )                => ({ id, auto, met, detail });
const names = (ids                   , ctx               , max = 5)         => {
  const list = ids.map((i) => ctx?.names.get(i) ?? i);
  return list.length > max ? `${list.slice(0, max).join(', ')} and ${list.length - max} more` : list.join(', ');
};

function waveItems(tracker         , wave        )               {
  return Object.values(tracker.items).filter((s) => !s.removed && s.wave === wave);
}
function eventsOf(tracker         , ids                     )                {
  return sortEvents(tracker.events.filter((e) => !e.dryRun && e.item !== null && ids.has(e.item)));
}
function appsOf(items                       , ctx               )           {
  return [...new Set(items.map((s) => ctx?.apps.get(s.item)).filter((a)              => !!a))].sort();
}
function waveIssues(tracker         , wave        , ids                     , ctx               ) {
  const blocking = blockersByItem(tracker, ctx ?? {});
  const linked = new Set        ();
  for (const id of ids) for (const i of blocking.get(id) ?? []) linked.add(i);
  return tracker.raid.issues.filter((i) => i.wave === wave || linked.has(i.id));
}
function manualSignOffs(tracker         , kind             , apps                   , wave        , label        )                {
  if (!apps.length) return crit(`sign-off.${kind}`, false, false, `No apps known for wave ${wave}; record the ${label} for the wave.`);
  const missing = apps.filter((a) => latestSignOff(tracker, kind, 'app', signOffId(a, wave), a)?.decision !== 'approved');
  return crit(`sign-off.${kind}`, false, missing.length === 0, missing.length ? `No ${label} yet from: ${missing.join(', ')}.` : `${label} recorded for every app.`);
}

/** The criteria of a gate for a wave (or the programme, for G5), each auto or manual, met or not. */
export function evaluateGate(tracker         , wave                      , gate        , input            = {})                  {
  const { ctx } = input;
  const today = input.today ?? new Date().toISOString();
  if (gate === 'G5' || wave === 'programme') {
    const live = Object.values(tracker.items).filter((s) => !s.removed);
    const left = live.filter((s) => s.state !== 'decommissioned').map((s) => s.item);
    const lo = tracker.signoffs.filter((s) => s.kind === 'lights-out' && s.scope === 'dc').sort((a, b) => a.at.localeCompare(b.at)).pop();
    return [
      crit('g5.all-decommissioned', true, left.length === 0, left.length ? `${left.length} item(s) not decommissioned: ${names(left, ctx)}.` : 'Every item is decommissioned.'),
      crit('g5.lights-out', false, lo?.decision === 'approved', lo ? `Lights-out ${lo.decision} by ${lo.role}.` : 'No lights-out sign-off yet.'),
    ];
  }
  const items = waveItems(tracker, wave);
  const ids = new Set(items.map((s) => s.item));
  const events = eventsOf(tracker, ids);
  const apps = appsOf(items, ctx);
  const issues = waveIssues(tracker, wave, ids, ctx);
  const attest = (id        )          => input.attest?.[id] === true;
  const out                  = [];

  if (gate === 'G1') {
    const notReady           = [];
    for (const s of items) {
      const floor = BUILD_PATHS.has(s.path) ? 'prepared' : 'in-sync';
      if (ITEM_STATE_RANK[s.state] < ITEM_STATE_RANK[floor]) {
        notReady.push(s.item);
        continue;
      }
      if (ITEM_STATE_RANK[s.state] >= ITEM_STATE_RANK.tested || s.path === 'retire') continue;
      const mine = events.filter((e) => e.item === s.item);
      const skipped = mine.some((e) => e.step === 'test' && e.outcome === 'skipped');
      const rehearsed = events.some((e) => e.step === 'rollback' && e.outcome === 'succeeded' && e.data?.rehearsal === true && e.path === s.path)
        || tracker.events.some((e) => !e.dryRun && e.step === 'rollback' && e.outcome === 'succeeded' && e.data?.rehearsal === true && e.path === s.path);
      if (!(skipped && rehearsed)) notReady.push(s.item);
    }
    out.push(crit('g1.items-ready', true, items.length > 0 && notReady.length === 0,
      notReady.length ? `Not yet in sync and tested (or test skipped with a rollback rehearsal): ${names(notReady, ctx)}.` : `All ${items.length} item(s) ready.`));
    const blocked = items.filter((s) => s.flags.includes('blocked')).map((s) => s.item);
    out.push(crit('g1.no-blockers', true, blocked.length === 0, blocked.length ? `Blocked: ${names(blocked, ctx)}.` : 'No open blockers.'));
    const quota = events.filter((e) => e.step === 'precheck' && e.data?.check === 'quotas');
    const lastQuota = quota[quota.length - 1];
    out.push(crit('g1.quotas', true, lastQuota?.outcome === 'succeeded',
      lastQuota ? `Quota check ${lastQuota.outcome} at ${lastQuota.at}.` : 'No quota pre-check recorded for the wave.'));
    const cr = tracker.crs.filter((c) => c.status === 'approved');
    const crNeeded = input.changeRequests !== false;
    out.push(crit('g1.change-request', true, !crNeeded || cr.length > 0 || attest('g1.change-request'),
      !crNeeded ? 'No change-request system in use.' : cr.length ? `Change request ${cr.map((c) => c.number ?? c.id).join(', ')} approved.` : 'No approved change request recorded.'));
    out.push(manualSignOffs(tracker, 'test-passed', apps, wave, 'test sign-off'));
    const sent = (tpl        )          => tracker.notices.some((n) => (n.wave === undefined || n.wave === wave) && n.template.toLowerCase().includes(tpl));
    const t14 = sent('t-14');
    const t2 = sent('t-2');
    out.push(crit('g1.comms', false, t14 && t2, t14 && t2 ? 'T−14 and T−2 notices sent.' : `Not yet sent: ${[!t14 ? 'T−14' : '', !t2 ? 'T−2' : ''].filter(Boolean).join(', ')}.`));
  } else if (gate === 'G2') {
    const lastPre = new Map                     ();
    for (const e of events) if (e.step === 'precheck' && e.item) lastPre.set(e.item, e);
    const failedPre = [...lastPre.values()].filter((e) => e.outcome === 'failed').map((e) => e.item          );
    const noPre = items.filter((s) => !lastPre.has(s.item)).map((s) => s.item);
    out.push(crit('g2.precheck', true, items.length > 0 && failedPre.length === 0 && noPre.length === 0,
      failedPre.length ? `Pre-checks failed: ${names(failedPre, ctx)}.` : noPre.length ? `No pre-check recorded: ${names(noPre, ctx)}.` : 'Pre-checks passed.'));
    const lagging           = [];
    for (const s of items) {
      const limit = s.kind === 'database' ? ctx?.lagSeconds.db ?? 0 : ctx?.lagSeconds.server ?? 60;
      if (s.sync?.lagSeconds !== undefined && s.sync.lagSeconds > limit) lagging.push(s.item);
    }
    out.push(crit('g2.lag', true, lagging.length === 0, lagging.length ? `Replication lag over the setting: ${names(lagging, ctx)}.` : 'Lag within the setting.'));
    const noRollback = items.filter((s) => s.path === 'specialist').map((s) => s.item);
    out.push(crit('g2.rollback-path', true, noRollback.length === 0,
      noRollback.length ? `No generated rollback for: ${names(noRollback, ctx)} (specialist path).` : 'A rollback path is known for every item.'));
    const go = latestSignOff(tracker, 'go', 'wave', String(wave));
    out.push(crit('sign-off.go', false, go?.decision === 'approved', go ? `Go ${go.decision} by ${go.role}.` : 'No go decision recorded.'));
    out.push(crit('g2.rollback-owner', false, attest('g2.rollback-owner'), attest('g2.rollback-owner') ? 'Rollback decision-maker named and present.' : 'Name the rollback decision-maker.'));
  } else if (gate === 'G3') {
    const notValid = items.filter((s) => s.path !== 'retire' && (ITEM_STATE_RANK[s.state] < ITEM_STATE_RANK.validated || s.flags.includes('failed'))).map((s) => s.item);
    out.push(crit('g3.validated', true, items.length > 0 && notValid.length === 0,
      notValid.length ? `Not validated: ${names(notValid, ctx)}.` : 'Validation passed for every item.'));
    const sev = issues.filter((i) => isOpenIssue(i) && (i.severity === 'sev1' || i.severity === 'sev2'));
    out.push(crit('g3.no-sev12', true, sev.length === 0, sev.length ? `Open Sev1/Sev2: ${sev.map((i) => i.id).join(', ')}.` : 'No open Sev1 or Sev2 for the wave.'));
    out.push(manualSignOffs(tracker, 'accepted', apps, wave, 'acceptance'));
  } else if (gate === 'G4') {
    const t = Date.parse(today.length === 10 ? `${today}T23:59:59Z` : today);
    const early           = [];
    for (const s of items) {
      if (s.path === 'retire') continue;
      const cut = events.filter((e) => e.item === s.item && e.step === 'cutover' && e.outcome === 'succeeded').pop();
      const keep = ctx?.keepDays[ctx.criticality.get(s.item) ?? 'tier2'] ?? 14;
      if (!cut || t - Date.parse(cut.at) < keep * DAY) early.push(s.item);
    }
    out.push(crit('g4.keep-days', true, items.length > 0 && early.length === 0, early.length ? `Keep-days not yet elapsed: ${names(early, ctx)}.` : 'Keep-days elapsed for every item.'));
    const backed = new Set        ();
    for (const e of events) if (e.item && e.outcome === 'succeeded' && (e.data?.check === 'target-backup' || e.data?.targetBackup === true)) backed.add(e.item);
    for (const d of tracker.decommissions) if (d.backupVerified) backed.add(d.item);
    const noBackup = items.filter((s) => s.path !== 'retire' && !backed.has(s.item)).map((s) => s.item);
    out.push(crit('g4.target-backup', true, noBackup.length === 0, noBackup.length ? `No target backup recorded: ${names(noBackup, ctx)}.` : 'A target backup succeeded for every item.'));
    const recent = issues.filter((i) => (i.severity === 'sev1' || i.severity === 'sev2')
      && (isOpenIssue(i) || (i.opened && t - Date.parse(i.opened.slice(0, 10)) < 7 * DAY)));
    out.push(crit('g4.no-sev12-7d', true, recent.length === 0, recent.length ? `Sev1/Sev2 open or raised in the last 7 days: ${recent.map((i) => i.id).join(', ')}.` : 'No Sev1 or Sev2 for 7 days.'));
    const stillOn = (input.reconcile ?? []).filter((f) => f.code === 'track.reconcile.source-still-on' && (!f.path || ids.has(f.path)));
    out.push(crit('g4.reconcile', true, input.reconcile !== undefined && stillOn.length === 0,
      input.reconcile === undefined ? 'Reconcile with a newer estate import first.' : stillOn.length ? `${stillOn.length} source(s) still powered on.` : 'No source still powered on.'));
    const ok = latestSignOff(tracker, 'decom-approved', 'wave', String(wave));
    out.push(crit('sign-off.decom-approved', false, ok?.decision === 'approved', ok ? `Decommission ${ok.decision} by ${ok.role}.` : 'No decommission approval yet.'));
  }
  return out;
}

/** True when every criterion is met. */
export function gateMet(criteria                          )          {
  return criteria.length > 0 && criteria.every((c) => c.met);
}

/**
 * Record a gate decision: added to the tracker's gates, and logged in the
 * Decisions log (source 'gate'). A go with unmet criteria is allowed (the
 * operator owns it) and the log says which were unmet.
 */
export function recordGate(tracker         , record            )          {
  const unmet = record.criteria.filter((c) => !c.met).map((c) => c.id);
  const where = record.wave === 'programme' ? 'the programme' : `wave ${record.wave}`;
  const t          = { ...tracker, gates: [...tracker.gates, record] };
  return recordDecision(t, {
    decision: `${record.gate} ${record.decision === 'go' ? 'Go' : 'No go'} for ${where}${record.decision === 'go' && unmet.length ? ` with ${unmet.length} criteria unmet (${unmet.join(', ')})` : ''}.`,
    ...(record.comment ? { rationale: record.comment } : {}),
    by: record.role,
    date: record.at.slice(0, 10),
    source: 'gate',
    links: [`gate:${record.wave}:${record.gate}:${record.at}`],
  });
}

/** A gate decision from its evaluated criteria. */
export function gateRecord(wave                      , gate        , decision                        , role          , at        , criteria                          , comment         )             {
  return { wave, gate, decision, at, role, ...(comment ? { comment } : {}), criteria };
}

/** The gate file's path in the project (under `status/`). */
export function gateFilePath(wave                      , gate        )         {
  return wave === 'programme' ? `gates/programme-${GATE_SLUG[gate]}.json` : `gates/wave-${wave}-${GATE_SLUG[gate]}.json`;
}

/**
 * The gate file the scripts check: `{kind, v, planId, wave, gate, decision,
 * at, criteria[], by: role}`, plus the wave's open blockers (the precheck's
 * coupling check reads them).
 */
export function gateFile(tracker         , record            , ctx               )                                 {
  const blockers = blockersByItem(tracker, ctx ?? {});
  const inWave = record.wave === 'programme' ? [] : waveItems(tracker, record.wave).map((s) => s.item);
  const body = {
    kind: GATE_FILE_KIND,
    v: 1,
    planId: tracker.planId,
    wave: record.wave,
    gate: record.gate,
    decision: record.decision,
    at: record.at,
    criteria: record.criteria,
    by: record.role,
    ...(record.comment ? { comment: record.comment } : {}),
    blockers: inWave.filter((id) => blockers.has(id)).map((id) => ({ item: id, issues: blockers.get(id) ?? [] })),
  };
  return { path: gateFilePath(record.wave, record.gate), text: `${JSON.stringify(body, null, 2)}\n` };
}
