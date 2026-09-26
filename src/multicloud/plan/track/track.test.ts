import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { zip } from '../../../kit/archive.ts';
import type { Inventory } from '../../../vmware/inventory.ts';
import { emptyPlan } from '../store.ts';
import type {
  Database, ItemDecision, ItemState, Plan, PlanDecision, RaidIssue, StatusEvent, Tracker, WavePlan, Workload,
} from '../types.ts';
import { trackContext, trackerFor, syncTracker, defaultTrackPath } from './sync.ts';
import { importStatus, importStatusFiles, parseEvent, validationToEvent } from './import.ts';
import { deriveStatus, itemHistory, withDerived } from './derive.ts';
import { foldItem, manualEvent, providerLabelOf, eventKey, lifecycleToolOf } from './states.ts';
import {
  addFindingAsRisk, blockersByItem, importRaidCsv, nextRaidId, raidToCsv, raiseAssumptionAsRisk, raiseRiskAsIssue, recordDecision,
  suggestedRisks, upsertRaid,
} from './raid.ts';
import {
  burnDown, cumulativeFlow, decommissionDue, forecast, hypercareOverdue, pctComplete, ragStatus, tiles, velocity, waveTable, waveTimeline,
  waveWindows, addMonths,
} from './metrics.ts';
import { evaluateGate, gateFile, gateMet, gateRecord, recordGate, signOffId, addSignOff } from './gates.ts';
import { reconcileEstate } from './reconcile.ts';
import { appRows, boardRows, filterValues, syncText, waveCards } from './board.ts';
import { eventsCsv, exportFiles, exportName, itemsCsv, statusReport, wavesCsv, ITEM_CSV_COLUMNS } from './export.ts';
import {
  countPastPlanned, forgetConfirmation, loadTracker, otherPlanBanner, saveTracker, trackerEnvelope, trackerFromEnvelope, trackerMatchesPlan,
} from './store.ts';
import type { Json } from '../../../editor/doc.ts';

// ---------------------------------------------------------------------------
// Fixture: one shop app on AWS (two servers, a database going to RDS and its
// host VM), one retired server, one retained server and one new service.
// ---------------------------------------------------------------------------

const T0 = '2026-01-01T00:00:00.000Z';

function wl(name: string, app: string, extra: Partial<Workload> = {}): Workload {
  return {
    id: `w:${name}`, name, app, env: 'prod', role: 'app', os: 'rhel-9', vcpu: 4, ramGib: 16, disksGib: [100], criticality: 'tier2',
    rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'estate', sourceKey: `vc1|${name}`,
    sourceRef: { platform: 'vsphere', host: 'esx01' }, ...extra,
  };
}
const db: Database = {
  id: 'd:shopdb', name: 'shopdb', engine: 'postgres', edition: 'community', version: 'pg-16', hosts: ['dbhost01'], vcpu: 8, ramGib: 32,
  sizeGib: 500, ha: 'none', dr: 'none', features: [], licence: 'community', app: 'Shop', source: 'estate',
};
function dec(id: string, kind: 'workload' | 'database', disposition: ItemDecision['disposition'], method: ItemDecision['method'], extra: Partial<ItemDecision> = {}): ItemDecision {
  return {
    id, kind, disposition, method, options: [], pinned: false, margin: 0, findings: [],
    ...(method === 'replicate' ? { chosen: { platform: 'aws', score: 1, hits: [] } } : {}),
    ...extra,
  };
}

function fixture(): { plan: Plan; decision: PlanDecision; waves: WavePlan } {
  const base = emptyPlan('Shop move', T0);
  const plan: Plan = {
    ...base,
    id: 'plan-1234567890',
    workloads: [
      wl('web01', 'Shop'), wl('app01', 'Shop'), wl('dbhost01', 'Shop'), wl('old01', 'Legacy', { sourceRef: { platform: 'vsphere', host: 'esx02' } }),
      wl('keep01', 'Legacy'), wl('newsvc', 'NewApp', { source: 'manual', sourceKey: undefined }),
    ],
    databases: [db],
    apps: [
      { id: 'a:shop', name: 'Shop', owner: 'Shop owner', criticality: 'tier1', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none' },
      { id: 'a:legacy', name: 'Legacy', criticality: 'tier3', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none' },
    ],
    requirements: { ...base.requirements, timelineMonths: 6 },
  };
  const decision: PlanDecision = {
    engineVersion: 't', platforms: ['aws'], subsetScores: [], findings: [],
    items: {
      'w:web01': dec('w:web01', 'workload', 'rehost', 'replicate'),
      'w:app01': dec('w:app01', 'workload', 'rehost', 'replicate'),
      'w:dbhost01': dec('w:dbhost01', 'workload', 'replatform', 'managed-db'),
      'w:old01': dec('w:old01', 'workload', 'retire', 'none'),
      'w:keep01': dec('w:keep01', 'workload', 'retain', 'none'),
      'w:newsvc': dec('w:newsvc', 'workload', 'new', 'rebuild'),
      'd:shopdb': dec('d:shopdb', 'database', 'replatform', 'managed-db', { chosen: { platform: 'aws', service: 'aws-rds', score: 1, hits: [] } }),
    },
  };
  const waves: WavePlan = {
    settings: { ...plan.waveSettings, start: '2026-01-05', weeks: 2 },
    waves: [{ n: 1, groups: ['g1'] }, { n: 2, groups: ['g2'] }],
    groups: [
      { id: 'g1', items: ['w:web01', 'w:app01', 'w:dbhost01', 'd:shopdb'], why: 'app', wave: 1, method: 'replicate' },
      { id: 'g2', items: ['w:old01', 'w:newsvc'], why: 'app', wave: 2, method: 'rebuild' },
    ],
    findings: [],
  };
  return { plan, decision, waves };
}

function setup(): { plan: Plan; decision: PlanDecision; waves: WavePlan; tracker: Tracker; ctx: ReturnType<typeof trackContext> } {
  const f = fixture();
  return { ...f, tracker: trackerFor(f.plan, f.decision, f.waves, { at: T0 }), ctx: trackContext(f.plan, f.decision, f.waves) };
}

let seq = 0;
function ev(item: string | null, step: StatusEvent['step'], outcome: StatusEvent['outcome'], at: string, extra: Partial<StatusEvent> = {}): StatusEvent {
  seq += 1;
  return {
    kind: 'archtoolkit.migration-status', v: 1, planId: 'plan-1234567890', runId: `run-${seq}`, at, wave: 1, item, path: 'aws-mgn', step, outcome,
    dryRun: false, ...extra,
  };
}
const jsonl = (events: readonly StatusEvent[]): string => events.map((e) => JSON.stringify(e)).join('\n');
const imp = (t: Tracker, events: readonly StatusEvent[], ctx?: ReturnType<typeof trackContext>) =>
  importStatus(t, [{ name: 'events.jsonl', text: jsonl(events) }], ctx ?? {});

/** The whole happy path for web01 up to decommission. */
function happy(item = 'w:web01'): StatusEvent[] {
  return [
    ev(item, 'prepare', 'succeeded', '2026-01-06T10:00:00Z'),
    ev(item, 'replicate', 'started', '2026-01-06T11:00:00Z'),
    ev(item, 'replicate', 'succeeded', '2026-01-07T11:00:00Z', { data: { inSync: true, progressPct: 100 } }),
    ev(item, 'test', 'succeeded', '2026-01-08T09:00:00Z'),
    ev(item, 'test-cleanup', 'succeeded', '2026-01-08T12:00:00Z', { data: { passed: true } }),
    ev(item, 'cutover', 'started', '2026-01-10T01:00:00Z'),
    ev(item, 'cutover', 'succeeded', '2026-01-10T02:00:00Z'),
    ev(item, 'validate', 'succeeded', '2026-01-10T03:00:00Z'),
  ];
}

// ---------------------------------------------------------------------------

describe('track/sync: items from the plan', () => {
  it('tracks workloads and databases, not retained items; retired and replatformed hosts on retire; new services on deploy', () => {
    const { tracker } = setup();
    expect(Object.keys(tracker.items).sort()).toEqual(['d:shopdb', 'w:app01', 'w:dbhost01', 'w:newsvc', 'w:old01', 'w:web01']);
    expect(tracker.items['w:web01']?.path).toBe('aws-mgn');
    expect(tracker.items['w:web01']?.wave).toBe(1);
    expect(tracker.items['w:web01']?.moveGroup).toBe('g1');
    expect(tracker.items['w:old01']?.path).toBe('retire');
    expect(tracker.items['w:dbhost01']?.path).toBe('retire');
    expect(tracker.items['d:shopdb']?.path).toBe('aws-dms');
    expect(tracker.items['w:newsvc']?.kind).toBe('app-deploy');
    expect(tracker.items['w:newsvc']?.path).toBe('deploy');
    expect(tracker.items['w:web01']?.state).toBe('planned');
    expect(tracker.items['w:web01']?.phase).toBe('plan');
    expect(trackContext(fixture().plan, fixture().decision).retained).toBe(1);
  });

  it('a path override wins', () => {
    const f = fixture();
    const plan: Plan = { ...f.plan, execution: { ...({} as NonNullable<Plan['execution']>), pathOverrides: { 'w:web01': 'rebuild' } } as NonNullable<Plan['execution']> };
    expect(trackerFor(plan, f.decision, f.waves, { at: T0 }).items['w:web01']?.path).toBe('rebuild');
    expect(defaultTrackPath('workload', dec('x', 'workload', 'relocate', 'relocate-hcx'))).toBe('hcx-bulk');
  });

  it('syncTracker adds, removes, re-waves only planned items (with a decision) and holds back items under way', () => {
    const { plan, decision, waves } = setup();
    let t = setup().tracker;
    t = imp(t, happy('w:app01').slice(0, 2)).tracker; // app01 replicating
    const moved: WavePlan = {
      ...waves,
      groups: [
        { id: 'g1', items: ['w:app01', 'w:dbhost01', 'd:shopdb'], why: 'app', wave: 1, method: 'replicate' },
        { id: 'g2', items: ['w:old01', 'w:newsvc', 'w:web01'], why: 'app', wave: 2, method: 'rebuild' },
      ],
    };
    const plan2: Plan = { ...plan, workloads: [...plan.workloads.filter((w) => w.name !== 'old01'), wl('extra01', 'Shop')] };
    const d2: PlanDecision = { ...decision, items: { ...decision.items, 'w:extra01': dec('w:extra01', 'workload', 'rehost', 'replicate'), 'w:app01': dec('w:app01', 'workload', 'rehost', 'rebuild') } };
    const r = syncTracker(t, plan2, d2, moved, { at: '2026-01-07T00:00:00Z' });
    expect(r.report.added).toEqual(['w:extra01']);
    expect(r.report.removed).toEqual(['w:old01']);
    expect(r.tracker.items['w:old01']?.removed).toBe(true);
    expect(r.report.rewaved).toEqual([{ item: 'w:web01', from: 1, to: 2 }]);
    expect(r.tracker.items['w:web01']?.wave).toBe(2);
    expect(r.report.heldBack).toEqual(['w:app01']);
    expect(r.tracker.items['w:app01']?.path).toBe('aws-mgn');
    expect(r.tracker.raid.decisions.length).toBe(1);
    expect(r.tracker.raid.decisions[0]?.source).toBe('re-wave');
    // Coming back clears `removed`.
    const back = syncTracker(r.tracker, plan, decision, waves, { at: '2026-01-08T00:00:00Z' });
    expect(back.report.restored).toEqual(['w:old01']);
    expect(back.tracker.items['w:old01']?.removed).toBeUndefined();
  });
});

describe('track/import: the status contract', () => {
  it('is idempotent: importing the same file twice changes nothing', () => {
    const { tracker, ctx } = setup();
    const events = happy();
    const once = imp(tracker, events, ctx);
    expect(once.report.imported).toBe(events.length);
    expect(once.report.changed).toBe(1);
    const twice = imp(once.tracker, events, ctx);
    expect(twice.report.imported).toBe(0);
    expect(twice.report.duplicates).toBe(events.length);
    expect(twice.report.changed).toBe(0);
    expect(twice.tracker).toEqual(once.tracker);
    expect(once.report.summary).toBe('8 events imported, 0 duplicates, 0 rejected; 1 item changed state');
  });

  it('handles out-of-order files: the result is the same whatever order they come in', () => {
    const { tracker } = setup();
    const events = happy();
    const a = events.slice(0, 4);
    const b = events.slice(4);
    const ab = imp(imp(tracker, a).tracker, b).tracker;
    const ba = imp(imp(tracker, b).tracker, a).tracker;
    expect(ba.items).toEqual(ab.items);
    expect(ba.events).toEqual(ab.events);
    expect(ab.items['w:web01']?.state).toBe('validated');
    // Events are kept sorted by time.
    const times = ab.events.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  it('dry-run events are listed in the history, marked, and never change state', () => {
    const { tracker } = setup();
    const dry = happy().map((e) => ({ ...e, dryRun: true }));
    const r = imp(tracker, dry);
    expect(r.report.imported).toBe(dry.length);
    expect(r.report.dryRun).toBe(dry.length);
    expect(r.report.changed).toBe(0);
    expect(r.tracker.items['w:web01']?.state).toBe('planned');
    expect(r.tracker.items['w:web01']?.lastEvent).toBeUndefined();
    const h = itemHistory(r.tracker, 'w:web01');
    expect(h.length).toBe(dry.length);
    expect(h.every((l) => l.note === 'dry run')).toBe(true);
  });

  it('rejects another plan (counted once), matches an unknown item by name, rejects an unknown name', () => {
    const { tracker, ctx } = setup();
    const other = [ev('w:web01', 'prepare', 'succeeded', '2026-01-06T00:00:00Z', { planId: 'other' }), ev('w:web01', 'prepare', 'succeeded', '2026-01-06T01:00:00Z', { planId: 'other' })];
    const byName = ev('WEB01-renamed', 'prepare', 'succeeded', '2026-01-06T02:00:00Z', { name: 'APP01' });
    const nobody = ev('w:ghost', 'prepare', 'succeeded', '2026-01-06T03:00:00Z', { name: 'ghost' });
    const r = imp(tracker, [...other, byName, nobody], ctx);
    expect(r.report.rejected).toBe(3);
    expect(r.report.imported).toBe(1);
    expect(r.report.findings.filter((f) => f.code === 'track.import.other-plan').length).toBe(1);
    expect(r.report.findings.find((f) => f.code === 'track.import.other-plan')?.message).toContain('2 events');
    expect(r.report.findings.filter((f) => f.code === 'track.import.unknown-item').length).toBe(1);
    expect(r.tracker.items['w:app01']?.state).toBe('prepared');
    expect(r.tracker.events[0]?.item).toBe('w:app01');
  });

  it('validates the event shape and keeps no footprints', () => {
    expect('error' in parseEvent({ kind: 'x' })).toBe(true);
    expect('error' in parseEvent({ ...ev('w:a', 'prepare', 'succeeded', T0), step: 'nope' })).toBe(true);
    expect('error' in parseEvent({ ...ev('w:a', 'prepare', 'succeeded', T0), at: 'yesterday' })).toBe(true);
    const ok = parseEvent({ ...ev('w:a', 'prepare', 'succeeded', '2026-01-01T01:00:00+01:00'), detail: 'a\nb', data: { user: 'bob', hostname: 'ctl', token: 'x', lagSeconds: 4, nested: { a: 1 } } });
    expect('ok' in ok).toBe(true);
    if ('ok' in ok) {
      expect(ok.ok.at).toBe('2026-01-01T00:00:00.000Z');
      expect(ok.ok.detail).toBe('a b');
      expect(ok.ok.data).toEqual({ lagSeconds: 4 });
    }
    const { tracker } = setup();
    const r = importStatus(tracker, [{ name: 'events.jsonl', text: `not json\n${JSON.stringify({ kind: 'archtoolkit.migration-status', v: 2 })}` }]);
    expect(r.report.rejected).toBe(2);
    expect(r.report.findings.map((f) => f.code).sort()).toEqual(['track.import.bad-event', 'track.import.bad-line']);
    // A .json array is read too.
    const arr = importStatus(tracker, [{ name: 'batch.json', text: JSON.stringify(happy().slice(0, 1)) }]);
    expect(arr.report.imported).toBe(1);
  });

  it('a WP-7 validation JSON imports as a validate event (passed, failed, and a performance warning raised as an issue)', () => {
    const { tracker, ctx } = setup();
    let t = imp(tracker, happy().slice(0, 7), ctx).tracker; // cut-over
    expect(t.items['w:web01']?.state).toBe('cut-over');
    const report = (passed: boolean, at: string, checks: unknown[]): string => JSON.stringify({
      kind: 'archtoolkit.validation', v: 1, planId: 'plan-1234567890', item: 'w:web01', host: 'web01', phase: 'cutover', at, passed, checks,
    });
    const failed = importStatus(t, [{ name: 'validation-web01.json', text: report(false, '2026-01-10T03:00:00Z', [{ id: 'port-443', kind: 'port', target: '443/tcp', passed: false }]) }], ctx);
    expect(failed.report.imported).toBe(1);
    const e = failed.tracker.events.find((x) => x.step === 'validate');
    expect(e?.source).toBe('validation');
    expect(e?.outcome).toBe('failed');
    expect(e?.detail).toContain('port-443');
    expect(failed.tracker.items['w:web01']?.flags).toContain('failed');
    expect(failed.tracker.items['w:web01']?.state).toBe('cut-over');
    t = failed.tracker;
    // Found by host name when no item id; the performance regression is a warning and becomes a RAID issue.
    const passed = importStatus(t, [{
      name: 'validation-web01.json',
      text: JSON.stringify({
        kind: 'archtoolkit.validation', v: 1, planId: 'plan-1234567890', host: 'web01', phase: 'cutover', at: '2026-01-10T05:00:00Z', passed: true,
        checks: [{ id: 'port-443', kind: 'port', passed: true }, { id: 'perf-cpu', kind: 'performance', passed: false }],
      }),
    }], ctx);
    expect(passed.tracker.items['w:web01']?.state).toBe('validated');
    expect(passed.tracker.items['w:web01']?.flags).not.toContain('failed');
    expect(passed.tracker.raid.issues.length).toBe(1);
    expect(passed.tracker.raid.issues[0]?.origin).toBe('validation');
    // Importing it again changes nothing (same derived run id).
    const again = importStatus(passed.tracker, [{ name: 'v.json', text: JSON.stringify({ kind: 'archtoolkit.validation', v: 1, planId: 'plan-1234567890', host: 'web01', phase: 'cutover', at: '2026-01-10T05:00:00Z', passed: true, checks: [{ id: 'perf-cpu', kind: 'performance', passed: false }] }) }], ctx);
    expect(again.report.duplicates).toBe(1);
    expect(again.tracker.raid.issues.length).toBe(1);
    // A test-phase validation is history only.
    const lookup = () => ({ item: 'w:app01', wave: 1, path: 'aws-mgn' as const });
    const v = validationToEvent({ kind: 'archtoolkit.validation', v: 1, planId: 'p', item: 'x', phase: 'test', at: T0, passed: true, checks: [] }, lookup);
    expect('ok' in v && v.ok.step).toBe('validate');
  });

  it('opens a zip and takes status/**/*.jsonl and reports/validation-*.json', async () => {
    const { tracker, ctx } = setup();
    const bytes = await zip({
      'project/status/events.jsonl': jsonl(happy().slice(0, 3)),
      'project/reports/validation-web01.json': JSON.stringify({ kind: 'archtoolkit.validation', v: 1, planId: 'plan-1234567890', host: 'app01', phase: 'cutover', at: '2026-01-12T00:00:00Z', passed: true, checks: [] }),
      'project/README.md': '# not read',
    });
    const r = await importStatusFiles(tracker, [{ name: 'run.zip', bytes }], ctx);
    expect(r.report.imported).toBe(4);
    expect(r.tracker.items['w:web01']?.state).toBe('in-sync');
  });
});

describe('track/states: the transition table (A.8.2)', () => {
  const base = () => setup().tracker.items['w:web01']!;
  const fold = (events: StatusEvent[]) => foldItem(base(), events);

  it('walks prepare → … → decommissioned', () => {
    const steps = happy();
    const expected: ItemState[] = ['prepared', 'replicating', 'in-sync', 'testing', 'tested', 'cutting-over', 'cut-over', 'validated'];
    steps.forEach((_, i) => expect(fold(steps.slice(0, i + 1)).state).toBe(expected[i] as ItemState));
    const accepted = fold([...steps, (manualEvent({ planId: 'p', item: 'w:web01', wave: 1, path: 'aws-mgn', state: 'accepted', reason: 'Owner signed off', at: '2026-01-15T00:00:00Z' }) as { ok: StatusEvent }).ok]);
    expect(accepted.state).toBe('accepted');
    expect(accepted.phase).toBe('hypercare');
    const decom = fold([...steps, ev('w:web01', 'decommission', 'succeeded', '2026-02-01T00:00:00Z')]);
    expect(decom.state).toBe('decommissioned');
    expect(decom.phase).toBe('decommission');
    expect(fold(steps.slice(0, 3)).sync).toEqual({ progressPct: 100 });
  });

  it('`replicate` succeeded without inSync is replicating; the `in-sync` step is in-sync; scripts never move an item back', () => {
    expect(fold([ev('w:web01', 'replicate', 'succeeded', T0)]).state).toBe('replicating');
    expect(fold([ev('w:web01', 'in-sync', 'succeeded', T0)]).state).toBe('in-sync');
    expect(fold([...happy().slice(0, 5), ev('w:web01', 'replicate', 'started', '2026-01-09T00:00:00Z')]).state).toBe('tested');
    expect(fold([ev('w:web01', 'deploy', 'succeeded', T0)]).state).toBe('prepared');
  });

  it('test-cleanup that did not pass goes back to in-sync with the flag failed; the next pass clears it', () => {
    const e = happy().slice(0, 4);
    const bad = fold([...e, ev('w:web01', 'test-cleanup', 'succeeded', '2026-01-08T12:00:00Z', { data: { passed: false } })]);
    expect(bad.state).toBe('in-sync');
    expect(bad.flags).toEqual(['failed']);
    const good = fold([...e, ev('w:web01', 'test-cleanup', 'succeeded', '2026-01-08T12:00:00Z', { data: { passed: false } }),
      ev('w:web01', 'test', 'succeeded', '2026-01-09T09:00:00Z'), ev('w:web01', 'test-cleanup', 'succeeded', '2026-01-09T12:00:00Z', { data: { passed: true } })]);
    expect(good.state).toBe('tested');
    expect(good.flags).toEqual([]);
  });

  it('any failed step keeps the state, flags failed with lastError, and clears on the next success of the same step only', () => {
    const e = happy().slice(0, 3);
    const failed = fold([...e, ev('w:web01', 'test', 'failed', '2026-01-08T09:00:00Z', { detail: 'Launch failed: quota' })]);
    expect(failed.state).toBe('in-sync');
    expect(failed.flags).toEqual(['failed']);
    expect(failed.lastError).toBe('Launch failed: quota');
    const other = fold([...e, ev('w:web01', 'test', 'failed', '2026-01-08T09:00:00Z'), ev('w:web01', 'precheck', 'succeeded', '2026-01-08T10:00:00Z')]);
    expect(other.flags).toEqual(['failed']);
    const cleared = fold([...e, ev('w:web01', 'test', 'failed', '2026-01-08T09:00:00Z'), ev('w:web01', 'test', 'succeeded', '2026-01-08T10:00:00Z')]);
    expect(cleared.flags).toEqual([]);
    expect(cleared.lastError).toBeUndefined();
    expect(cleared.state).toBe('testing');
    // A failed validate sets the flag.
    const v = fold([...happy().slice(0, 7), ev('w:web01', 'validate', 'failed', '2026-01-10T03:00:00Z')]);
    expect(v.state).toBe('cut-over');
    expect(v.flags).toEqual(['failed']);
  });

  it('rollback: in-sync when replication survived, else tested; flag rolled-back; rollbacks += 1', () => {
    const cut = happy().slice(0, 7);
    const mgn = fold([...cut, ev('w:web01', 'rollback', 'succeeded', '2026-01-10T05:00:00Z')]);
    expect(mgn.state).toBe('in-sync');
    expect(mgn.flags).toEqual(['rolled-back']);
    expect(mgn.rollbacks).toBe(1);
    const afterCommit = fold([...cut, ev('w:web01', 'commit', 'succeeded', '2026-01-10T04:00:00Z'), ev('w:web01', 'rollback', 'succeeded', '2026-01-10T05:00:00Z')]);
    expect(afterCommit.state).toBe('tested');
    const rebuild = foldItem({ ...base(), path: 'rebuild' }, [...cut.map((e) => ({ ...e, path: 'rebuild' as const })), ev('w:web01', 'rollback', 'succeeded', '2026-01-10T05:00:00Z', { path: 'rebuild' })]);
    expect(rebuild.state).toBe('tested');
    const told = fold([...cut, ev('w:web01', 'rollback', 'succeeded', '2026-01-10T05:00:00Z', { data: { replicationSurvived: false } })]);
    expect(told.state).toBe('tested');
    const twice = fold([...cut, ev('w:web01', 'rollback', 'succeeded', '2026-01-10T05:00:00Z'), ev('w:web01', 'cutover', 'succeeded', '2026-01-11T02:00:00Z'), ev('w:web01', 'rollback', 'succeeded', '2026-01-11T05:00:00Z')]);
    expect(twice.rollbacks).toBe(2);
    const recut = fold([...cut, ev('w:web01', 'rollback', 'succeeded', '2026-01-10T05:00:00Z'), ev('w:web01', 'cutover', 'succeeded', '2026-01-11T02:00:00Z')]);
    expect(recut.state).toBe('cut-over');
    expect(recut.flags).toEqual([]);
    const rehearsal = fold([...happy().slice(0, 3), ev('w:web01', 'rollback', 'succeeded', '2026-01-09T05:00:00Z', { data: { rehearsal: true } })]);
    expect(rehearsal.state).toBe('in-sync');
    expect(rehearsal.rollbacks).toBe(0);
  });

  it('a rollback writes a Decisions-log entry once', () => {
    const { tracker, ctx } = setup();
    const events = [...happy().slice(0, 7), ev('w:web01', 'rollback', 'succeeded', '2026-01-10T05:00:00Z', { detail: 'App smoke test failed' })];
    const r = imp(tracker, events, ctx);
    expect(r.tracker.raid.decisions.length).toBe(1);
    expect(r.tracker.raid.decisions[0]?.source).toBe('rollback');
    expect(r.tracker.raid.decisions[0]?.decision).toContain('web01');
    expect(imp(r.tracker, events, ctx).tracker.raid.decisions.length).toBe(1);
  });

  it('accept is manual only; specialist items move by hand only; the validate phase must be cutover', () => {
    const e = happy();
    expect(fold([...e, ev('w:web01', 'accept', 'succeeded', '2026-01-12T00:00:00Z')]).state).toBe('validated');
    const sp = { ...base(), path: 'specialist' as const };
    expect(foldItem(sp, [ev('w:web01', 'cutover', 'succeeded', T0, { path: 'specialist' })]).state).toBe('planned');
    const m = manualEvent({ planId: 'p', item: 'w:web01', wave: 1, path: 'specialist', state: 'cut-over', reason: 'Partner confirmed cutover', at: T0 });
    expect(foldItem(sp, ['ok' in m ? m.ok : (null as never)]).state).toBe('cut-over');
    expect(fold([...e.slice(0, 7), ev('w:web01', 'validate', 'succeeded', '2026-01-10T03:00:00Z', { data: { phase: 'test' } })]).state).toBe('cut-over');
  });

  it('manual transitions need a reason, may move back, and can hold an item', () => {
    expect('error' in manualEvent({ planId: 'p', item: 'w:web01', wave: 1, path: 'aws-mgn', state: 'planned', reason: '  ', at: T0 })).toBe(true);
    const back = manualEvent({ planId: 'p', item: 'w:web01', wave: 1, path: 'aws-mgn', state: 'in-sync', reason: 'Re-test after the fix', at: '2026-01-11T00:00:00Z', hold: true });
    if (!('ok' in back)) throw new Error('expected an event');
    expect(back.ok.source).toBe('manual');
    expect(back.ok.runId.startsWith('manual-')).toBe(true);
    const s = fold([...happy(), back.ok]);
    expect(s.state).toBe('in-sync');
    expect(s.flags).toEqual(['on-hold']);
  });

  it('reads the provider’s own state (MGN "Ready for cutover") and shows it', () => {
    const s = fold([ev('w:web01', 'replicate', 'succeeded', T0, { data: { providerState: 'Ready for cutover' } })]);
    expect(s.state).toBe('tested');
    expect(providerLabelOf(s)).toBe('Ready for cutover');
    expect(providerLabelOf({ path: 'hcx-bulk', state: 'prepared' })).toBe('Configured');
    const stalled = fold([...happy().slice(0, 3), ev('w:web01', 'replicate', 'succeeded', '2026-01-09T00:00:00Z', { data: { providerState: 'Stalled' } })]);
    expect(stalled.flags).toEqual(['failed']);
    expect(lifecycleToolOf('azure-migrate-agent')).toBe('azure-migrate');
    expect(lifecycleToolOf('rebuild')).toBeUndefined();
  });

  it('eventKey is the dedupe key', () => {
    expect(eventKey({ runId: 'r', item: null, step: 'gate', outcome: 'succeeded', at: T0 })).toBe(`r||gate|succeeded|${T0}`);
  });
});

describe('track/derive and raid: blockers, followers, RAID operations', () => {
  it('blockers derive from issues’ blocks (item names, ids and app names); resolving clears the flag', () => {
    const { tracker, ctx } = setup();
    const issue: RaidIssue = { id: 'I-001', issue: 'Firewall change pending', severity: 'sev2', blocks: ['web01', 'Legacy'], opened: '2026-01-02', status: 'open' };
    const t = upsertRaid(tracker, 'issues', issue);
    const d = deriveStatus(t, ctx);
    expect(d.items['w:web01']?.flags).toEqual(['blocked']);
    expect(d.items['w:old01']?.flags).toEqual(['blocked']);
    expect(d.items['w:app01']?.flags).toEqual([]);
    // Without the context, the item name still resolves through its id.
    expect(blockersByItem(t).get('w:web01')).toEqual(['I-001']);
    const resolved = upsertRaid(t, 'issues', { ...issue, status: 'resolved' });
    expect(deriveStatus(resolved, ctx).items['w:web01']?.flags).toEqual([]);
    expect(d.waves.find((w) => w.wave === 1)?.blocked).toBe(1);
  });

  it('a replatformed database’s host VM is decommissioned when the database is accepted', () => {
    const { tracker, ctx } = setup();
    expect(ctx.followers.get('w:dbhost01')).toBe('d:shopdb');
    const acc = manualEvent({ planId: 'plan-1234567890', item: 'd:shopdb', wave: 1, path: 'aws-dms', state: 'accepted', reason: 'DBA signed off', at: '2026-01-20T00:00:00Z' });
    const r = imp(tracker, ['ok' in acc ? acc.ok : (null as never)], ctx);
    expect(r.tracker.items['d:shopdb']?.state).toBe('accepted');
    expect(r.tracker.items['w:dbhost01']?.state).toBe('decommissioned');
  });

  it('ids, raise-as, decisions, suggested risks and CSV round trips', () => {
    let t = setup().tracker;
    expect(nextRaidId(t, 'risks')).toBe('R-001');
    t = upsertRaid(t, 'risks', { id: '', risk: 'Oracle licences on VMware clusters', probability: 4, impact: 5, response: 'reduce', status: 'open' });
    expect(t.raid.risks[0]?.id).toBe('R-001');
    t = raiseRiskAsIssue(t, 'R-001', '2026-01-03');
    expect(t.raid.risks[0]?.status).toBe('occurred');
    expect(t.raid.issues[0]?.id).toBe('I-001');
    t = upsertRaid(t, 'assumptions', { id: '', assumption: 'Bandwidth is 1 Gbps', status: 'open' });
    t = raiseAssumptionAsRisk(t, 'A-001');
    expect(t.raid.assumptions[0]?.status).toBe('false');
    expect(t.raid.risks.length).toBe(2);
    t = recordDecision(t, { decision: 'Chose AWS for Shop', date: '2026-01-02', source: 'platform-switch', links: ['a:shop'] });
    t = recordDecision(t, { decision: 'Chose AWS for Shop', date: '2026-01-02', source: 'platform-switch', links: ['a:shop'] });
    expect(t.raid.decisions.length).toBe(1);
    const sugg = suggestedRisks(t, [
      { code: 'plan.os.eol-replicate', severity: 'warning', message: 'RHEL 6 is past end of support.' },
      { code: 'x.info', severity: 'info', message: 'fine' },
    ]);
    expect(sugg.map((f) => f.code)).toEqual(['plan.os.eol-replicate']);
    t = addFindingAsRisk(t, sugg[0]!);
    expect(suggestedRisks(t, sugg)).toEqual([]);

    const csv = raidToCsv(t, 'risks');
    expect(csv.split('\n')[0]).toBe('id,risk,wave,app,probability,impact,score,owner,response,mitigation,status,review_by');
    expect(csv).toContain(',20,');
    const back = importRaidCsv({ ...t, raid: { ...t.raid, risks: [] } }, 'risks', csv);
    expect(back.findings).toEqual([]);
    expect(back.tracker.raid.risks).toEqual(t.raid.risks);
    const issues = importRaidCsv(t, 'issues', 'ID,Issue,Severity,Blocks,Opened,Status\n,Switch down,Sev 1,web01 app01,2026-01-04,Open\n,Bad,sev9,,2026-01-04,open\n');
    expect(issues.findings.length).toBe(1);
    const added = issues.tracker.raid.issues.find((i) => i.issue === 'Switch down');
    expect(added?.severity).toBe('sev1');
    expect(added?.blocks).toEqual(['web01', 'app01']);
    expect(added?.id).toBe('I-002');
    expect(raidToCsv(setup().tracker, 'decisions')).toBe('id,decision,rationale,decided_by,date,source,links\n');
  });
});

describe('track/metrics: %, burn-down, flow, velocity, forecast, RAG', () => {
  const progressed = () => {
    const { tracker, ctx, waves } = setup();
    const t = imp(tracker, [...happy('w:web01'), ...happy('w:app01').slice(0, 3), ev('w:old01', 'decommission', 'succeeded', '2026-01-20T00:00:00Z', { wave: 2, path: 'retire' })], ctx).tracker;
    return { t, ctx, waves };
  };

  it('% complete is rank-weighted, retire items count 0 or 1', () => {
    expect(pctComplete([{ item: 'a', state: 'decommissioned', path: 'retire' }, { item: 'b', state: 'cut-over', path: 'retire' }])).toBe(50);
    expect(pctComplete([{ item: 'a', state: 'cut-over', path: 'aws-mgn' }])).toBe(70);
    const { t, ctx } = progressed();
    const tl = tiles(t, ctx, '2026-01-21');
    expect(tl.inScope).toBe(6);
    expect(tl.cutOver).toBe(1);
    expect(tl.validated).toBe(1);
    expect(tl.decommissioned).toBe(1);
    expect(tl.retired).toBe(2);
    expect(tl.retained).toBe(1);
    expect(tl.moved.vcpu).toBe(4);
    expect(tl.byPhase.hypercare).toBe(1);
    expect(tl.byStrategy.rehost).toBe(2);
    expect(tl.plannedByNow).toBe(3); // wave 1 ends 2026-01-18: web01, app01, shopdb
    expect(tl.pctByVcpu).toBeGreaterThan(0);
  });

  it('wave windows, burn-down (actual and ideal) and cumulative flow', () => {
    const { t, waves } = progressed();
    expect(waveWindows(waves)).toEqual([
      { wave: 1, start: '2026-01-05', end: '2026-01-18', label: '2026-01-05 to 2026-01-18' },
      { wave: 2, start: '2026-01-19', end: '2026-02-01', label: '2026-01-19 to 2026-02-01' },
    ]);
    const bd = burnDown(t, 'cut-over', waves, '2026-01-21');
    const at = (day: string) => bd.find((p) => p.day === day);
    expect(at('2026-01-09')?.actual).toBe(6);
    expect(at('2026-01-10')?.actual).toBe(5);
    expect(at('2026-01-20')?.actual).toBe(4); // old01 decommissioned (at or past cut-over)
    expect(at('2026-01-25')?.actual).toBeUndefined();
    expect(at('2026-01-10')?.ideal).toBe(6);
    expect(at('2026-01-18')?.ideal).toBe(2);
    expect(at('2026-02-01')?.ideal).toBe(0);
    const flow = cumulativeFlow(t, waves, '2026-01-21');
    const last = flow[flow.length - 1]!;
    expect(last.counts.validated + last.counts['in-sync'] + last.counts.decommissioned + last.counts.planned).toBe(6);
    expect(last.counts['in-sync']).toBe(1);
  });

  it('velocity, forecast (late finding) and RAG', () => {
    const { t, ctx } = progressed();
    expect(velocity(t, '2026-01-21')).toBe(0.3); // 1 cut over in 4 weeks
    const tight = { ...ctx, timelineMonths: 2 };
    const f = forecast(t, tight, '2026-01-21');
    expect(f.remaining).toBe(3); // app01, shopdb, newsvc (retire items are not cut over)
    expect(f.deadline).toBe(addMonths('2026-01-01', 2));
    expect(f.finish).toBe('2026-04-15'); // 3 items at 0.25 a week = 84 days
    expect(f.weeksLate).toBe(7);
    expect(f.findings.map((x) => x.code)).toEqual(['track.forecast.late']);
    expect(ragStatus(t, tight, '2026-01-21').rag).toBe('red');
    expect(forecast(t, ctx, '2026-01-21').findings).toEqual([]);
    // Plenty of time: green; an open Sev2: amber; a Sev1: red.
    const roomy = { ...ctx, timelineMonths: 60 };
    expect(ragStatus(t, roomy, '2026-01-21').rag).toBe('green');
    const sev2 = upsertRaid(t, 'issues', { id: '', issue: 'x', severity: 'sev2', blocks: [], opened: '2026-01-20', status: 'open' });
    expect(ragStatus(sev2, roomy, '2026-01-21').rag).toBe('amber');
    const oldBlocker = upsertRaid(t, 'issues', { id: '', issue: 'y', severity: 'sev4', blocks: ['app01'], opened: '2026-01-01', status: 'open' });
    expect(ragStatus(oldBlocker, roomy, '2026-01-21').reason).toContain('older than 5 days');
    const sev1 = upsertRaid(t, 'issues', { id: '', issue: 'z', severity: 'sev1', blocks: [], opened: '2026-01-20', status: 'open' });
    expect(ragStatus(sev1, roomy, '2026-01-21').rag).toBe('red');
    expect(ragStatus(setup().tracker, roomy, '2026-01-02').rag).toBe('green');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('wave table, timeline, decommission-due and hypercare overdue', () => {
    const { t, ctx, waves } = progressed();
    const rows = waveTable(t, waves, '2026-01-21');
    expect(rows.map((r) => r.wave)).toEqual([1, 2]);
    expect(rows[0]?.items).toBe(4);
    expect(rows[0]?.cutOver).toBe(1);
    expect(rows[0]?.plannedEnd).toBe('2026-01-18');
    expect(rows[0]?.onTrack).toBe(false);
    const tl = waveTimeline(t, ctx);
    expect(tl[0]?.actualStart).toBe('2026-01-06T11:00:00.000Z');
    expect(tl[0]?.actualEnd).toBe('2026-01-10T03:00:00.000Z');
    const due = decommissionDue(t, ctx);
    expect(due).toEqual([{ item: 'w:web01', wave: 1, cutOverAt: '2026-01-10T02:00:00.000Z', due: '2026-01-24' }]); // tier2 keeps 14 days
    expect(tl[0]?.decomDue.length).toBe(1);
    expect(hypercareOverdue(t, ctx, '2026-01-15')).toEqual([]);
    expect(hypercareOverdue(t, ctx, '2026-01-25').map((f) => f.code)).toEqual(['track.hypercare.overdue']);
  });
});

describe('track/gates', () => {
  it('G1 criteria, sign-offs, recording a decision and the gate file', () => {
    const { tracker, ctx } = setup();
    let t = imp(tracker, happy('w:web01').slice(0, 5), ctx).tracker;
    const g1 = evaluateGate(t, 1, 'G1', { ctx, changeRequests: false });
    expect(g1.find((c) => c.id === 'g1.items-ready')?.met).toBe(false);
    expect(g1.find((c) => c.id === 'g1.change-request')?.met).toBe(true);
    expect(g1.find((c) => c.id === 'sign-off.test-passed')?.met).toBe(false);
    expect(gateMet(g1)).toBe(false);
    t = addSignOff(t, { scope: 'app', id: signOffId('Shop', 1), kind: 'test-passed', role: 'app-owner', decision: 'approved', at: '2026-01-09T00:00:00Z' });
    expect(evaluateGate(t, 1, 'G1', { ctx }).find((c) => c.id === 'sign-off.test-passed')?.met).toBe(true);
    const rec = gateRecord(1, 'G2', 'go', 'migration-lead', '2026-01-09T12:00:00Z', evaluateGate(t, 1, 'G2', { ctx }), 'Proceed');
    t = recordGate(t, rec);
    expect(t.gates.length).toBe(1);
    expect(t.raid.decisions[0]?.source).toBe('gate');
    expect(deriveStatus(t, ctx).waves.find((w) => w.wave === 1)?.gates.G2).toBe('go');
    const file = gateFile(t, rec, ctx);
    expect(file.path).toBe('gates/wave-1-go.json');
    const body = JSON.parse(file.text) as Record<string, unknown>;
    expect(body.kind).toBe('archtoolkit.migration-gate');
    expect(body.planId).toBe('plan-1234567890');
    expect(body.by).toBe('migration-lead');
    expect(body.decision).toBe('go');
  });

  it('G3 and G4 read validation, issues, keep-days and the reconciliation', () => {
    const { tracker, ctx } = setup();
    const t = imp(tracker, happy('w:web01'), ctx).tracker;
    const g3 = evaluateGate(t, 1, 'G3', { ctx });
    expect(g3.find((c) => c.id === 'g3.validated')?.met).toBe(false); // app01 and others not validated
    const g4 = evaluateGate(t, 1, 'G4', { ctx, today: '2026-03-01' });
    expect(g4.find((c) => c.id === 'g4.reconcile')?.met).toBe(false);
    const g4b = evaluateGate(t, 1, 'G4', { ctx, today: '2026-03-01', reconcile: [] });
    expect(g4b.find((c) => c.id === 'g4.reconcile')?.met).toBe(true);
    const g5 = evaluateGate(t, 'programme', 'G5', { ctx });
    expect(g5.map((c) => c.id)).toEqual(['g5.all-decommissioned', 'g5.lights-out']);
  });
});

describe('track/reconcile: against a newer estate', () => {
  it('flags source-still-on, decom-still-present, missing-source, new-vm and hosts-free', () => {
    const { tracker, ctx, plan } = setup();
    let t = imp(tracker, [...happy('w:web01').slice(0, 7), ev('w:old01', 'decommission', 'succeeded', '2026-01-20T00:00:00Z', { path: 'retire', wave: 2 })], ctx).tracker;
    t = imp(t, happy('w:app01').slice(0, 1), ctx).tracker; // app01 prepared, its VM gone from the estate
    const vm = (name: string, powerState: 'poweredOn' | 'poweredOff', host: string) => ({ name, vcenter: 'vc1', powerState, host, vcpu: 1, memoryGib: 1, provisionedGib: 1 });
    const inventory = {
      source: { kind: 'rvtools', importedAt: T0 },
      hosts: [{ name: 'esx01' }, { name: 'esx02' }],
      vms: [vm('web01', 'poweredOn', 'esx01'), vm('dbhost01', 'poweredOn', 'esx01'), vm('keep01', 'poweredOn', 'esx01'), vm('stranger', 'poweredOn', 'esx01')],
      clusters: [], datastores: [], networks: [],
    } as unknown as Inventory;
    const f = reconcileEstate(t, plan, inventory);
    const codes = (c: string) => f.filter((x) => x.code === c).map((x) => x.path);
    expect(codes('track.reconcile.source-still-on')).toEqual(['w:web01']);
    expect(f.find((x) => x.code === 'track.reconcile.source-still-on')?.severity).toBe('error');
    expect(codes('track.reconcile.missing-source')).toEqual(['w:app01']);
    expect(codes('track.reconcile.new-vm')).toEqual(['stranger']);
    expect(codes('track.reconcile.hosts-free')).toEqual(['esx02']);
    const withOld = reconcileEstate(t, plan, { ...inventory, vms: [...inventory.vms, vm('old01', 'poweredOff', 'esx02')] } as Inventory);
    expect(withOld.filter((x) => x.code === 'track.reconcile.decom-still-present').map((x) => x.path)).toEqual(['w:old01']);
    expect(reconcileEstate(t, plan, undefined)).toEqual([]);
  });
});

describe('track/board', () => {
  it('rows, filters, wave cards and the app grid', () => {
    const { tracker, ctx } = setup();
    let t = imp(tracker, happy('w:web01').slice(0, 3), ctx).tracker;
    t = upsertRaid(t, 'issues', { id: '', issue: 'x', severity: 'sev3', blocks: ['app01'], opened: '2026-01-02', status: 'open' });
    t = withDerived(t, ctx);
    const rows = boardRows(t, ctx);
    const web = rows.find((r) => r.item === 'w:web01')!;
    expect(web.name).toBe('web01');
    expect(web.app).toBe('Shop');
    expect(web.platformLabel).toBeTruthy();
    expect(web.state).toBe('in-sync');
    expect(web.providerState).toBe('Ready for testing');
    expect(web.sync).toBe('100%');
    expect(web.owner).toBe('Shop owner');
    expect(web.lastEvent).toBe('replicate succeeded');
    expect(rows.find((r) => r.item === 'w:app01')?.blockers).toEqual(['I-001']);
    expect(boardRows(t, ctx, { flag: 'blocked' }).map((r) => r.item)).toEqual(['w:app01']);
    expect(boardRows(t, ctx, { wave: 2 }).length).toBe(2);
    expect(filterValues(rows).waves).toEqual([1, 2]);
    expect(syncText({ lagSeconds: 42 })).toBe('lag 42 s');
    const cards = waveCards(t, ctx);
    expect(cards[0]?.gates).toEqual({ G1: 'grey', G2: 'grey', G3: 'grey', G4: 'grey' });
    expect(cards[0]?.blockers).toBe(1);
    expect(cards[0]?.bar.map((b) => b.state)).toEqual(['planned', 'in-sync']);
    const apps = appRows(t, ctx);
    const shop = apps.find((a) => a.app === 'Shop')!;
    expect(shop.items).toBe(4);
    expect(shop.lowest).toBe('planned');
    expect(shop.openIssues).toBe(1);
    expect(shop.testSignOff).toBe('');
  });
});

describe('track/export and store', () => {
  it('CSVs, the status report and the file names', () => {
    const { tracker, ctx } = setup();
    const t = imp(tracker, [...happy('w:web01'), ev('w:web01', 'test', 'started', '2026-01-08T08:00:00Z', { dryRun: true })], ctx).tracker;
    const items = itemsCsv(t, ctx);
    expect(items.split('\n')[0]).toBe(ITEM_CSV_COLUMNS.join(','));
    expect(items).toContain('w:web01,workload,web01,Shop,1,aws-mgn,aws,validated');
    expect(wavesCsv(t, ctx).split('\n')[0]).toBe('wave,items,planned_start,planned_end,actual_start,actual_end,pct,g1,g2,g3,g4,state');
    const events = eventsCsv(t, ctx);
    expect(events.split('\n')[0]).toBe('at,wave,item,name,path,step,outcome,dry_run,state,detail');
    expect(events).toContain(',true,');
    const md = statusReport(t, { ...ctx, waves: fixture().waves }, { date: '2026-01-12' });
    for (const h of ['## Status:', '## Progress by wave', '## Done this period', '## Planned next period', '## Top five risks', '## Open Sev1 and Sev2 issues', '## Blockers', '## Decisions this period', '## Burn-down', '## Decommission due']) {
      expect(md).toContain(h);
    }
    expect(md).toContain('| 2026-01-10 | web01 | Cut over | 1 |');
    expect(md).not.toContain('Generated');
    expect(exportName('Shop move', 'tracker-items', '2026-01-12', 'csv')).toBe('shop-move-tracker-items-2026-01-12.csv');
    const files = exportFiles(t, ctx, '2026-01-12');
    expect(Object.keys(files).sort()).toEqual([
      'shop-move-archtoolkit-migration-tracker-2026-01-12.json', 'shop-move-raid-assumptions-2026-01-12.csv', 'shop-move-raid-decisions-2026-01-12.csv',
      'shop-move-raid-issues-2026-01-12.csv', 'shop-move-raid-risks-2026-01-12.csv', 'shop-move-status-report-2026-01-12.md',
      'shop-move-tracker-events-2026-01-12.csv', 'shop-move-tracker-items-2026-01-12.csv', 'shop-move-tracker-waves-2026-01-12.csv',
    ]);
  });

  it('the envelope round-trips; another page’s file is refused; the storage calls are null-safe', async () => {
    const { tracker, plan } = setup();
    const env = trackerEnvelope(tracker) as unknown as Json;
    const back = trackerFromEnvelope(env);
    expect('ok' in back && back.ok).toEqual(tracker);
    const other = trackerFromEnvelope({ kind: 'archtoolkit.multicloud-plan', version: 1, savedAt: T0 });
    expect('error' in other && other.error).toContain('Multi-Cloud Planner');
    expect('error' in trackerFromEnvelope({ ...(env as Record<string, Json>), version: 2 })).toBe(true);
    expect(trackerMatchesPlan(tracker, plan)).toBe(true);
    expect(otherPlanBanner(tracker, 'Shop move')).toBe('This tracker belongs to plan Shop move (plan-123).');
    expect(countPastPlanned(tracker)).toBe(0);
    expect(forgetConfirmation(tracker)).toContain('nothing has started');
    expect(await loadTracker()).toBeNull();
    expect(await saveTracker(tracker)).toBe(false);
  });
});
