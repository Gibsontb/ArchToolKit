/**
 * WP-UI-C: the Migration & Utilities panes' model side (the panes themselves
 * need a browser). The acceptance of addendum A.12.1:
 * - a status zip imported changes the states;
 * - a recorded gate gives a valid gate file;
 * - the burn-down renders from the events;
 * - the utilities' forms render from their inputs;
 * plus the console's commands, the settings form round trip, the path
 * override refusal, the RAID and RACI grids, the sign-off ids the gates read,
 * the charts and the per-wave capacity.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { zip } from '../../kit/archive.ts';
import { emptyPlan } from '../../multicloud/plan/store.ts';
import { defaultExecution } from '../../multicloud/plan/options.ts';
import type { Database, ItemDecision, Plan, PlanDecision, StatusEvent, Tracker, WavePlan, Workload } from '../../multicloud/plan/types.ts';
import { trackContext, trackerFor } from '../../multicloud/plan/track/sync.ts';
import { withDerived } from '../../multicloud/plan/track/derive.ts';
import { burnDown, cumulativeFlow } from '../../multicloud/plan/track/metrics.ts';
import { evaluateGate } from '../../multicloud/plan/track/gates.ts';
import { raidToCsv } from '../../multicloud/plan/track/raid.ts';
import { gateFileProblems } from '../../multicloud/plan/execute/waves/gates.ts';
import { UTILITIES, buildChangeBundle, defaultUtilityValues, findUtility } from '../../multicloud/change/index.ts';
import { burnDownChart, cumulativeFlowChart, dayTicks, niceMax, stateBarChart, svgMarkup, timelineChart, walk } from './charts.ts';
import { decideGate, gateCriteria, importIntoView, waveEvent, withEvent, type TrackView } from './track-kit.ts';
import { chipText, filterFrom } from './board.ts';
import {
  STAGES, applyExecutionValue, executionInputs, executionValues, parseExecuteArg, setPathOverride, stageCommands, stageTasks, tickedTasks,
} from './execute.ts';
import { timelineWaves, waveMilestones } from './timeline.ts';
import { ASSUMPTION_COLUMNS, blankRow, importLog, nextId, riskColumns, tidyRows } from './raid.ts';
import { fromGridRows, neededSignOffs, raciColumns, sectionOf, toGridRows, upsertCr } from './governance.ts';
import { capacityByWave } from './capacity.ts';
import { nextGates } from './overview.ts';
import { reportDateOf } from './reports.ts';
import { catalogue, formInputs, logRows, planAfter, platformName, utilityContext } from './utilities.ts';
import { defaultRaci } from '../../multicloud/plan/governance/raci.ts';

// ---------------------------------------------------------------------------
// Fixture: a shop app on AWS in wave 1 (two servers, a database to RDS and its
// host VM), a retired server in wave 2.
// ---------------------------------------------------------------------------

const T0 = '2026-01-01T00:00:00.000Z';
const PLAN_ID = 'plan-uic-0001';

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

function view(): TrackView {
  const base = emptyPlan('Shop move', T0);
  const plan: Plan = {
    ...base,
    id: PLAN_ID,
    workloads: [wl('web01', 'Shop'), wl('app01', 'Shop'), wl('dbhost01', 'Shop'), wl('old01', 'Legacy', { sourceRef: { platform: 'vsphere', host: 'esx02' } })],
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
      'd:shopdb': dec('d:shopdb', 'database', 'replatform', 'managed-db', { chosen: { platform: 'aws', service: 'aws-rds', score: 1, hits: [] } }),
    },
  };
  const waves: WavePlan = {
    settings: { ...plan.waveSettings, start: '2026-01-05', weeks: 2, freezes: [{ from: '2026-01-12', to: '2026-01-14', reason: 'month end' }] },
    waves: [{ n: 1, groups: ['g1'] }, { n: 2, groups: ['g2'] }],
    groups: [
      { id: 'g1', items: ['w:web01', 'w:app01', 'w:dbhost01', 'd:shopdb'], why: 'app', wave: 1, method: 'replicate' },
      { id: 'g2', items: ['w:old01'], why: 'app', wave: 2, method: 'rebuild' },
    ],
    findings: [],
  };
  const ctx = trackContext(plan, decision, waves);
  const tracker = withDerived(trackerFor(plan, decision, waves, { at: T0 }), ctx);
  return { plan: { ...plan, decision }, decision, design: { platforms: [], findings: [] }, waves, ctx, tracker, stored: true };
}

let seq = 0;
function ev(item: string | null, step: StatusEvent['step'], outcome: StatusEvent['outcome'], at: string, extra: Partial<StatusEvent> = {}): StatusEvent {
  seq += 1;
  return { kind: 'archtoolkit.migration-status', v: 1, planId: PLAN_ID, runId: `run-${seq}`, at, wave: 1, item, path: 'aws-mgn', step, outcome, dryRun: false, ...extra };
}
function happy(item: string): StatusEvent[] {
  return [
    ev(item, 'precheck', 'succeeded', '2026-01-06T09:00:00Z', { data: { check: 'quotas' } }),
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
const jsonl = (events: readonly StatusEvent[]): string => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

async function statusZip(events: readonly StatusEvent[]): Promise<Uint8Array> {
  return zip({ 'status/events.jsonl': jsonl(events) }, new Date(Date.UTC(2026, 0, 11)));
}

// ---------------------------------------------------------------------------

describe('import a status zip and see the states change (A.12.1)', () => {
  it('moves items along the transition table and reports what changed; a second import changes nothing', async () => {
    const v = view();
    expect(v.tracker.items['w:web01']?.state).toBe('planned');
    const bytes = await statusZip([...happy('w:web01'), ...happy('w:app01').slice(0, 4)]);
    const r = await importIntoView(v, [{ name: 'project-status.zip', bytes }]);
    expect(r.tracker.items['w:web01']?.state).toBe('validated');
    expect(r.tracker.items['w:app01']?.state).toBe('in-sync');
    expect(r.report.changed).toBe(2);
    expect(r.report.summary).toContain('events imported');
    const again = await importIntoView({ ...v, tracker: r.tracker }, [{ name: 'project-status.zip', bytes }]);
    expect(again.report.imported).toBe(0);
    expect(again.tracker.items['w:web01']?.state).toBe('validated');
  });

  it('rejects the lines of another plan', async () => {
    const v = view();
    const other = { ...ev('w:web01', 'prepare', 'succeeded', '2026-01-06T10:00:00Z'), planId: 'plan-else' };
    const r = await importIntoView(v, [{ name: 'events.jsonl', text: jsonl([other]) }]);
    expect(r.report.rejected).toBe(1);
    expect(r.tracker.items['w:web01']?.state).toBe('planned');
  });
});

describe('record a gate and download a valid gate file (A.12.1)', () => {
  it('G2 go: the gate file passes the schema, is named wave-1-go.json and names the role', () => {
    const v = view();
    const r = decideGate(v, { wave: 1, gate: 'G2', decision: 'go', role: 'app-owner', at: '2026-01-09T18:00:00Z', comment: 'go', attest: { 'g2.rollback-owner': true } });
    expect(r.problems).toEqual([]);
    expect(r.file.path).toBe('gates/wave-1-go.json');
    const body = JSON.parse(r.file.text) as Record<string, unknown>;
    expect(body.kind).toBe('archtoolkit.migration-gate');
    expect(body.planId).toBe(PLAN_ID);
    expect(body.decision).toBe('go');
    expect(body.by).toBe('app-owner');
    expect(gateFileProblems(body)).toEqual([]);
    expect(r.tracker.gates).toHaveLength(1);
    expect(r.tracker.raid.decisions.some((d) => d.source === 'gate' && d.decision.startsWith('G2 Go for wave 1'))).toBeTruthy();
    const attested = (body.criteria as { id: string; met: boolean }[]).find((c) => c.id === 'g2.rollback-owner');
    expect(attested?.met).toBe(true);
  });

  it('the criteria follow the tracker: pre-checks recorded meet g2.precheck', async () => {
    const v = view();
    const before = gateCriteria(v, 1, 'G2').find((c) => c.id === 'g2.precheck');
    expect(before?.met).toBe(false);
    const events = ['w:web01', 'w:app01', 'w:dbhost01', 'd:shopdb'].map((id) => ev(id, 'precheck', 'succeeded', '2026-01-09T08:00:00Z'));
    const r = await importIntoView(v, [{ name: 'events.jsonl', text: jsonl(events) }]);
    const after = gateCriteria({ ...v, tracker: r.tracker }, 1, 'G2').find((c) => c.id === 'g2.precheck');
    expect(after?.met).toBe(true);
  });

  it('G1 does not ask for a change request when the plan uses no CR system', () => {
    const v = view();
    const c = gateCriteria(v, 1, 'G1').find((x) => x.id === 'g1.change-request');
    expect(c?.met).toBe(true);
    const withSn = { ...v, plan: { ...v.plan, governance: { raci: [], cr: { system: 'servicenow' as const, perWave: true }, comms: {}, cicd: 'none' as const, environments: ['prod' as const] } } };
    expect(gateCriteria(withSn, 1, 'G1').find((x) => x.id === 'g1.change-request')?.met).toBe(false);
  });
});

describe('the burn-down renders from events (A.12.1)', () => {
  it('the actual line falls as items are cut over; the chart draws it', async () => {
    const v = view();
    const r = await importIntoView(v, [{ name: 'events.jsonl', text: jsonl([...happy('w:web01'), ...happy('w:app01')]) }]);
    const points = burnDown(r.tracker, 'cut-over', v.waves, '2026-01-12');
    const first = points.find((p) => p.actual !== undefined)?.actual ?? 0;
    const last = [...points].reverse().find((p) => p.actual !== undefined)?.actual ?? 0;
    expect(first).toBeGreaterThan(last);
    const chart = burnDownChart(points, 'cut over');
    const actual = walk(chart).find((n) => n.attrs['data-series'] === 'actual');
    expect(actual).toBeDefined();
    expect(String(actual?.attrs.d).split('L').length).toBeGreaterThan(3);
    expect(walk(chart).some((n) => n.attrs['data-series'] === 'ideal')).toBe(true);
    const markup = svgMarkup(chart);
    expect(markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(markup).toContain('Burn-down: items not yet cut over');
  });

  it('the cumulative flow stacks one area per state present', async () => {
    const v = view();
    const r = await importIntoView(v, [{ name: 'events.jsonl', text: jsonl(happy('w:web01')) }]);
    const chart = cumulativeFlowChart(cumulativeFlow(r.tracker, v.waves, '2026-01-12'));
    const states = walk(chart).filter((n) => n.tag === 'path' && n.attrs['data-state']).map((n) => n.attrs['data-state']);
    expect(states).toContain('planned');
    expect(states).toContain('validated');
  });

  it('empty charts say so instead of drawing nothing', () => {
    expect(svgMarkup(burnDownChart([], 'cut over'))).toContain('No items to chart yet.');
    expect(svgMarkup(timelineChart([], [], '2026-01-01'))).toContain('No waves to chart yet.');
  });
});

describe('the utilities’ forms render from their inputs (A.12.1)', () => {
  it('every utility’s form has every input, the platform first as a dropdown of its platforms', () => {
    const v = view();
    const uctx = utilityContext(v.plan, v.tracker, '2026-02-01');
    expect(UTILITIES.length).toBeGreaterThan(15);
    for (const u of UTILITIES) {
      const inputs = formInputs(u, defaultUtilityValues(u), uctx);
      expect(inputs.map((i) => i.id)).toEqual(u.inputs.map((i) => i.id));
      const platform = inputs.find((i) => i.id === 'platform');
      expect(platform?.control).toBe('select');
      expect((platform?.options ?? []).map((o) => o.value)).toEqual([...u.platforms]);
      for (const i of inputs) if (i.control === 'select') expect((i.options ?? []).length).toBeGreaterThan(0);
    }
  });

  it('a plan-fed input offers the plan’s servers', () => {
    const v = view();
    const u = findUtility('add-disk');
    expect(u).toBeDefined();
    const server = formInputs(u!, defaultUtilityValues(u!), utilityContext(v.plan, null, '2026-02-01')).find((i) => i.id === 'server');
    expect((server?.options ?? []).map((o) => o.value)).toContain('web01');
  });

  it('three utilities on two platforms build downloadable bundles named by the change date', () => {
    const v = view();
    const uctx = utilityContext(v.plan, null, '2026-02-01');
    const builds: [string, 'aws' | 'azure'][] = [['add-disk', 'aws'], ['open-port', 'azure'], ['dns-record', 'aws']];
    for (const [id, platform] of builds) {
      const u = findUtility(id)!;
      const b = buildChangeBundle(u, { ...defaultUtilityValues(u, platform), platform }, uctx);
      expect(b.folder.startsWith(`change-20260201-${id}-`)).toBe(true);
      expect(Object.keys(b.files).every((f) => f.startsWith(`${b.folder}/`))).toBe(true);
      expect(Object.keys(b.files).some((f) => f.endsWith('/apply.sh'))).toBe(true);
      expect(b.platform).toBe(platform);
    }
  });

  it('the catalogue filters by platform and names the platforms as the house does', () => {
    expect(catalogue('').flatMap((g) => g.utilities).length).toBe(UTILITIES.length);
    expect(catalogue('vmware').every((g) => g.utilities.every((u) => u.platforms.includes('vmware')))).toBe(true);
    expect(platformName('vmware')).toBe('VMware Cloud Foundation (VCF 9.1)');
    expect(platformName('google')).toBe('Google Cloud (GCP)');
  });

  it('the log sorts newest first; a plan update keeps the plan’s own decision', () => {
    const rows = logRows([
      { id: 'c1', utility: 'add-disk', target: 'web01', summary: 's', values: {}, generatedAt: '2026-01-01T00:00:00Z' },
      { id: 'c2', utility: 'open-port', target: 'web01', summary: 's', values: {}, generatedAt: '2026-02-01T00:00:00Z', cr: 'CHG1' },
    ]);
    expect(rows[0]?.[0]).toBe('c2');
    expect(rows[0]?.[7]).toBe('CHG1');
    const original = emptyPlan('p', T0);
    const after = planAfter(original, { plan: { ...original, name: 'changed', decision: view().decision } });
    expect(after?.name).toBe('changed');
    expect(after?.decision).toBeUndefined();
  });
});

describe('Execute: the console and the settings', () => {
  it('reads the hash argument', () => {
    expect(parseExecuteArg('settings')).toEqual({ settings: true });
    expect(parseExecuteArg('3/cutover')).toEqual({ settings: false, wave: 3, stage: 'cutover' });
    expect(parseExecuteArg('')).toEqual({ settings: false, stage: 'precheck' });
    expect(parseExecuteArg('2/nonsense')).toEqual({ settings: false, wave: 2, stage: 'precheck' });
  });

  it('gives the exact commands of every stage from the kit', () => {
    for (const s of STAGES) expect(stageCommands(4, s).main).toBe(`./waves/wave-4/${s}.sh`);
    const c = stageCommands(4, 'replicate', [{ script: 'paths/aws-mgn.sh', path: 'aws-mgn', items: 2 }, { script: 'paths/azure-migrate.ps1', path: 'azure-migrate', items: 1 }]);
    expect(c.dryRun).toBe('./waves/wave-4/replicate.sh --dry-run');
    expect(c.paths).toContain('./paths/aws-mgn.sh replicate --wave 4');
    expect(c.paths).toContain('./paths/aws-mgn.sh status --wave 4 --once');
    expect(c.paths).toContain('pwsh -File ./paths/azure-migrate.ps1 replicate -Wave 4');
    expect(stageCommands(2, 'rollback').variants.map((x) => x.command)).toContain('./waves/wave-2/rollback.sh --rehearse --item <nonprod item>');
  });

  it('shows the runbook per stage and reads the ticks from manual events', () => {
    expect(stageTasks('cutover').map((t) => t.id)).toContain('C5');
    expect(stageTasks('decommission')).toEqual([]);
    const v = view();
    const t1 = withEvent(v, waveEvent(PLAN_ID, 1, 'C1 done', { task: 'C1', done: true }, '2026-01-10T00:00:00Z', 'm1'));
    expect([...tickedTasks(t1, 1)]).toEqual(['C1']);
    const t2 = withEvent({ tracker: t1, ctx: v.ctx }, waveEvent(PLAN_ID, 1, 'C1 reopened', { task: 'C1', done: false }, '2026-01-10T01:00:00Z', 'm2'));
    expect([...tickedTasks(t2, 1)]).toEqual([]);
    expect(t2.items['w:web01']?.state).toBe('planned');
  });

  it('the settings form round-trips, closed sets are dropdowns and bad values are refused', () => {
    const e = defaultExecution();
    const inputs = executionInputs(view().plan, ['aws', 'vmware']);
    const byId = new Map(inputs.map((i) => [i.id, i]));
    for (const id of ['mgn.replication', 'mgn.ip', 'azure.diskType', 'azure.securityType', 'dms.maxCapacityUnits', 'hcx.windowHours', 'lz.aws']) expect(byId.get(id)?.control).toBe('select');
    expect(byId.get('lz.vmware')?.label).toContain('VCF 9.1');
    expect(byId.get('dnsZones')?.hint).toBe('Zone | Provider | Zone id | View | Private');
    let x = applyExecutionValue(e, 'keep.tier0', '45');
    x = applyExecutionValue(x, 'dnsZones', 'corp.example.com | route53 | Z123 |  | yes\nbad.example | nonsense |  |  | no');
    x = applyExecutionValue(x, 'lbs', 'Shop | f5-bigip | web_pool | 443');
    x = applyExecutionValue(x, 'mgn.replication', 'agentless');
    x = applyExecutionValue(x, 'mgn.ip', 'IPV5');
    x = applyExecutionValue(x, 'hcx.mappings', 'vlan10 | seg-web');
    x = applyExecutionValue(x, 'lz.aws', 'generated');
    expect(x.keepDays.tier0).toBe(45);
    expect(x.dnsZones[0]).toEqual({ zone: 'corp.example.com', provider: 'route53', zoneId: 'Z123', private: true });
    expect(x.dnsZones[1]?.provider).toBe('route53');
    expect(x.lbs[0]).toEqual({ app: 'Shop', kind: 'f5-bigip', pool: 'web_pool', port: 443 });
    expect(x.mgn?.replication).toBe('agentless');
    expect(x.mgn?.ip).toBe('IPV4');
    expect(x.hcx?.mappings).toEqual([{ from: 'vlan10', to: 'seg-web' }]);
    expect(x.landingZones.aws).toBe('generated');
    const v = executionValues(x);
    expect(v['keep.tier0']).toBe('45');
    expect((v.dnsZones ?? '').split('\n')[0]).toBe('corp.example.com | route53 | Z123 |  | yes');
    expect(applyExecutionValue(x, 'lz.aws', '').landingZones.aws).toBeUndefined();
  });
});

describe('Execute: path overrides', () => {
  it('refuses a path the item cannot take, with the reason, and clears an override', () => {
    const v = view();
    const refused = setPathOverride(v.plan, 'w:web01', 'hcx-bulk', v.decision);
    expect(refused.refused).toBeDefined();
    expect(refused.plan).toBe(v.plan);
    const ok = setPathOverride(v.plan, 'w:web01', 'rebuild', v.decision);
    expect(ok.refused).toBeUndefined();
    expect(ok.plan.execution?.pathOverrides['w:web01']).toBe('rebuild');
    expect(setPathOverride(ok.plan, 'w:web01', '', v.decision).plan.execution?.pathOverrides['w:web01']).toBeUndefined();
    expect(setPathOverride({ ...v.plan, decision: undefined }, 'w:web01', 'rebuild', undefined).refused).toBe('The plan has no decision yet.');
  });
});

describe('Board, timeline, capacity and overview', () => {
  it('filters from the dropdowns and gate chips', () => {
    expect(filterFrom({ wave: '2', app: '', state: 'in-sync' })).toEqual({ wave: 2, state: 'in-sync' });
    expect(chipText('G2', 'green')).toEqual({ text: 'G2 go', tone: 'ok' });
    expect(chipText('G3', 'grey').tone).toBe('neutral');
  });

  it('puts the T-minus milestones and gates on the timeline, and the freezes', async () => {
    const v = view();
    const ms = waveMilestones('2026-02-02', 14, 7, true);
    expect(ms.find((m) => m.label === 'T-14')?.date).toBe('2026-01-19');
    expect(ms.some((m) => m.title.startsWith('Landing-zone gate'))).toBe(true);
    expect(waveMilestones('2026-02-02', 14, 7, false).some((m) => m.title.startsWith('Landing-zone gate'))).toBe(false);
    const g = decideGate(v, { wave: 1, gate: 'G1', decision: 'no-go', role: 'migration-lead', at: '2026-01-09T10:00:00Z' });
    const rows = timelineWaves(g.tracker, v.ctx, v.waves, v.plan);
    expect(rows.map((r) => r.wave)).toEqual([1, 2]);
    expect(rows[0]?.gates[0]?.decision).toBe('no-go');
    expect(rows[0]?.milestones.length).toBeGreaterThan(5);
    const chart = timelineChart(rows, v.waves.settings.freezes, '2026-01-09');
    const marks = walk(chart).map((n) => n.attrs['data-mark']).filter(Boolean);
    expect(marks).toContain('planned');
    expect(marks).toContain('gate');
    expect(marks).toContain('freeze');
    expect(marks).toContain('milestone');
  });

  it('sums capacity per wave and platform', () => {
    const rows = capacityByWave(view());
    const w1 = rows.find((r) => r.wave === 1 && r.platform === 'aws');
    expect(w1?.servers).toBe(2);
    expect(w1?.databases).toBe(1);
    expect(w1?.vcpu).toBe(16);
    expect(rows.some((r) => r.wave === 2)).toBe(false);
  });

  it('names each wave’s next gate with its due date', () => {
    const v = view();
    const gates = nextGates(v, '2026-01-02');
    expect(gates[0]).toEqual({ wave: 1, gate: 'G1', due: '2025-12-31', met: gates[0]!.met, total: gates[0]!.total, ready: false });
    const after = decideGate(v, { wave: 1, gate: 'G1', decision: 'go', role: 'migration-lead', at: '2026-01-02T10:00:00Z' });
    expect(nextGates({ ...v, tracker: after.tracker }, '2026-01-02')[0]?.gate).toBe('G2');
  });

  it('keeps the report date to yyyy-mm-dd', () => {
    expect(reportDateOf('2026-03-04')).toBe('2026-03-04');
    expect(/^\d{4}-\d{2}-\d{2}$/.test(reportDateOf('soon'))).toBe(true);
  });

  it('charts: tidy axis tops, day ticks and the state bar', () => {
    expect(niceMax(7)).toBe(10);
    expect(niceMax(23)).toBe(25);
    expect(dayTicks(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 3).map((t) => t.day)).toEqual(['a', 'e', 'h']);
    const bar = stateBarChart([{ state: 'planned', count: 3 }, { state: 'validated', count: 1 }]);
    expect(walk(bar).filter((n) => n.tag === 'rect').map((n) => n.attrs['data-state'])).toEqual(['planned', 'validated']);
  });
});

describe('RAID and governance grids', () => {
  it('gives new rows the next id and imports CSV merged by id', () => {
    expect(nextId([{ id: 'R-001' }, { id: 'R-007' }], 'risks')).toBe('R-008');
    expect(tidyRows('issues', [{ id: '' }, { id: 'I-002' }]).map((r) => r.id)).toEqual(['I-003', 'I-002']);
    const risk = blankRow('risks', [], '2026-01-01');
    expect(risk.id).toBe('R-001');
    const v = view();
    const withRisk: Tracker = { ...v.tracker, raid: { ...v.tracker.raid, risks: [{ id: 'R-001', risk: 'Old', probability: 2, impact: 2, response: 'accept', status: 'open' }] } };
    const csv = raidToCsv(withRisk, 'risks').replace('Old', 'New');
    const r = importLog('risks', `${csv}R-002,Second,,,4,5,20,,reduce,,open,\n`, withRisk.raid.risks);
    expect(r.rows.map((x) => x.id)).toEqual(['R-001', 'R-002']);
    expect((r.rows[0] as unknown as { risk: string }).risk).toBe('New');
  });

  it('RAID columns are dropdowns for the closed sets; the score is computed', () => {
    const cols = riskColumns(['Shop']);
    expect(cols.find((c) => c.key === 'probability')?.options?.length).toBe(5);
    expect(cols.find((c) => c.key === 'app')?.options?.map((o) => o.value)).toEqual(['', 'Shop']);
    const r = { id: 'R-1', risk: 'x', probability: 4, impact: 5, response: 'reduce', status: 'open' } as const;
    expect(cols.find((c) => c.key === 'score')?.get(r)).toBe('20');
    expect('error' in (cols.find((c) => c.key === 'response')!.set(r, 'ignore'))).toBe(true);
    expect(ASSUMPTION_COLUMNS.find((c) => c.key === 'status')?.options?.map((o) => o.value)).toEqual(['open', 'confirmed', 'false']);
  });

  it('the RACI grid round-trips and refuses anything but R, A, C, I', () => {
    const rows = defaultRaci({ requirements: emptyPlan().requirements });
    expect(fromGridRows(toGridRows(rows))).toEqual(rows);
    const col = raciColumns().find((c) => c.key === 'dba')!;
    const g = toGridRows(rows)[0]!;
    const set = col.set(g, 'a');
    expect('patch' in set && (set.patch.cells as Record<string, string>).dba).toBe('A');
    expect('error' in col.set(g, 'X')).toBe(true);
    const cleared = col.set({ ...g, cells: { ...g.cells, dba: 'C' } }, '');
    expect('patch' in cleared && (cleared.patch.cells as Record<string, string>).dba).toBe(undefined);
  });

  it('the sign-offs use the ids the gates read', () => {
    const v = view();
    const needed = neededSignOffs(v.plan, v.tracker, { Shop: 1 });
    const test = needed.find((n) => n.kind === 'test-passed');
    expect(test?.id).toBe('Shop@wave-1');
    const go = needed.find((n) => n.kind === 'go');
    expect(go?.id).toBe('1');
    const signed: Tracker = { ...v.tracker, signoffs: [{ scope: 'wave', id: '1', kind: 'go', role: 'app-owner', decision: 'approved', at: '2026-01-09T00:00:00Z' }] };
    expect(evaluateGate(signed, 1, 'G2', { ctx: v.ctx }).find((c) => c.id === 'sign-off.go')?.met).toBe(true);
    expect(neededSignOffs(v.plan, signed, { Shop: 1 }).find((n) => n.kind === 'go')?.state).toBe('approved');
    expect(sectionOf('governance/crs')).toBe('crs');
    expect(sectionOf('governance')).toBe('raci');
    expect(upsertCr([{ id: 'wave-1', status: 'draft' }], { id: 'wave-1', number: 'CHG1', status: 'approved' })).toEqual([{ id: 'wave-1', number: 'CHG1', status: 'approved' }]);
  });
});
