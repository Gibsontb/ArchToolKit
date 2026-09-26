/**
 * WP-UI-B: the blueprint form shared by the generator and migration pages,
 * the local wave grouping (the swap point for WP-9's planWaves), the
 * landing-zone and wave settings as the panes write them, and the migration
 * project's assembly and archive.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { tableShape } from './multi-editors.ts';
import { itemId, defaultRequirements, DEFAULT_WAVE_SETTINGS, overrideKey } from '../multicloud/plan/options.ts';
import { emptyPlan } from '../multicloud/plan/store.ts';
import type { App, Database, ItemDecision, Method, Plan, PlanDecision, Platform, Workload } from '../multicloud/plan/types.ts';
import { localWavePlan, wavePlanFor, waveLoads } from './multicloud/wave-model.ts';
import { freezesText, parseFreezes, withPinnedWave, withWaveSetting, DEFAULT_CAPACITY } from './multicloud/waves.ts';
import {
  DEFAULT_TAGS, governanceInputs, governanceKey, landingZoneInputs, landingZoneMode, withLandingZoneMode, withLandingZoneValue,
} from './multicloud/design.ts';
import { planModel, migrationApps } from './multicloud/plan-model.ts';
import { PROJECT_PARTS, archiveProject, assembleMigrationProject, projectDate } from './multicloud/project.ts';
import { renderBlueprintForm, controlValue } from './blueprint-form.ts';
import type { BlueprintInput, BlueprintValues } from '../kit/blueprint.ts';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const workload = (name: string, app: string, over: Partial<Workload> = {}): Workload => ({
  id: itemId('workload', name), name, app, env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
  criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
});
const database = (name: string, app: string, over: Partial<Database> = {}): Database => ({
  id: itemId('database', name), name, engine: 'postgres', edition: 'community', version: 'pg-16', hosts: [], vcpu: 4, ramGib: 32,
  sizeGib: 200, ha: 'none', dr: 'none', features: [], licence: 'community', app, source: 'manual', ...over,
} as Database);
const app = (name: string, over: Partial<App> = {}): App => ({
  id: itemId('app', name), name, criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', ...over,
});

function plan(over: Partial<Plan> = {}): Plan {
  const base = emptyPlan('Wave Test', '2026-09-26T00:00:00.000Z');
  const req = defaultRequirements();
  return {
    ...base,
    id: 'plan-uib',
    workloads: [
      workload('a1', 'alpha'), workload('a2', 'alpha'),
      workload('b1', 'beta'), workload('b2', 'beta'), workload('b3', 'beta'),
      workload('c1', 'gamma', { criticality: 'tier0' }),
      workload('d1', 'delta'),
      workload('old1', 'legacy'),
    ],
    databases: [database('adb', 'alpha')],
    apps: [app('alpha'), app('beta'), app('gamma', { criticality: 'tier0' }), app('delta'), app('legacy')],
    edges: [],
    requirements: {
      ...req,
      allowed: ['aws', 'azure'],
      maxPlatforms: 2,
      regions: { aws: { primary: 'eu-west-2' }, azure: { primary: 'uksouth' } },
      sites: [{ name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.0.0.0/16', 'fd00:10::/48'], bandwidth: '1g', circuit: 'none' }],
      connection: 'vpn',
    },
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    ...over,
  };
}

/** Everything replicates to AWS except the legacy app, which is retired. */
function decisionFor(p: Plan, method: (id: string) => Method = (id) => (id.includes('old1') ? 'none' : 'replicate')): PlanDecision {
  const items: Record<string, ItemDecision> = {};
  const one = (id: string, kind: 'workload' | 'database'): ItemDecision => {
    const m = method(id);
    const chosen = m === 'none' ? undefined : { platform: 'aws' as Platform, score: 10, hits: [] };
    return { id, kind, disposition: m === 'none' ? 'retire' : 'rehost', method: m, options: chosen ? [chosen] : [], ...(chosen ? { chosen } : {}), pinned: false, margin: 5, findings: [] };
  };
  for (const w of p.workloads) items[w.id] = one(w.id, 'workload');
  for (const d of p.databases) items[d.id] = one(d.id, 'database');
  return { engineVersion: 'test', platforms: ['aws'], subsetScores: [], items, findings: [] };
}

// ---------------------------------------------------------------------------
// a minimal DOM, for the form
// ---------------------------------------------------------------------------

class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, (() => void)[]>();
  className = '';
  textContent = '';
  value = '';
  selected = false;
  checked = false;
  hidden = false;
  id = '';
  parentNode: FakeElement | null = null;
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get classList() {
    return { contains: (c: string) => this.className.split(/\s+/).includes(c), add: (c: string) => (this.className = `${this.className} ${c}`.trim()), toggle: () => undefined };
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, v);
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  appendChild(c: FakeElement) {
    c.parentNode = this;
    this.children.push(c);
    if (this.tagName === 'SELECT' && c.selected) this.value = c.getAttribute('value') ?? '';
    if (this.tagName === 'SELECT' && !this.value && this.all().filter((x) => x.tagName === 'OPTION').length === 1) this.value = c.getAttribute('value') ?? '';
    return c;
  }
  addEventListener(e: string, f: () => void) {
    this.listeners.set(e, [...(this.listeners.get(e) ?? []), f]);
  }
  dispatch(e: string) {
    for (const f of this.listeners.get(e) ?? []) f();
  }
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelector(sel: string): FakeElement | null {
    return this.all().find((x) => (sel.startsWith('.') ? x.classList.contains(sel.slice(1)) : x.tagName === sel.toUpperCase())) ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    return this.all().filter((x) => (sel.startsWith('.') ? x.classList.contains(sel.slice(1)) : x.tagName === sel.toUpperCase()));
  }
}

function withFakeDom<T>(run: () => T): T {
  const g = globalThis as unknown as { document?: unknown; Node?: unknown };
  const had = { document: g.document, Node: g.Node };
  g.document = { createElement: (t: string) => new FakeElement(t), createTextNode: (t: string) => Object.assign(new FakeElement('#text'), { textContent: t }) };
  g.Node = FakeElement;
  try {
    return run();
  } finally {
    g.document = had.document;
    g.Node = had.Node;
  }
}

// ---------------------------------------------------------------------------

describe('blueprint-form: one form for the generator and migration pages', () => {
  const inputs: BlueprintInput[] = [
    { id: 'size', label: 'Size', control: 'select', options: [{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }] },
    { id: 'name', label: 'Name', control: 'text' },
    { id: 'extra', label: 'Extra', control: 'text', showWhen: { input: 'size', equals: ['l'] } },
    { id: 'rare', label: 'Rare', control: 'text', section: 'More' },
  ];

  it('renders dropdowns for closed sets, leaves hidden follow-ups out, and groups sections', () => {
    withFakeDom(() => {
      let values: BlueprintValues = { size: 's', name: 'x' };
      const fields = renderBlueprintForm({ inputs }, { values: () => values, set: (id, v) => (values = { ...values, [id]: v }) }) as unknown as FakeElement[];
      expect(fields).toHaveLength(3);
      const select = fields[0]!.querySelector('select')!;
      expect(select.getAttribute('data-input')).toBe('size');
      expect(fields[2]!.tagName).toBe('DETAILS');
    });
  });

  it('writes each change through set, and redraws when a follow-up appears', () => {
    withFakeDom(() => {
      let values: BlueprintValues = { size: 's' };
      let redraws = 0;
      const fields = renderBlueprintForm({ inputs }, { values: () => values, set: (id, v) => (values = { ...values, [id]: v }), rerender: () => (redraws += 1) }) as unknown as FakeElement[];
      const select = fields[0]!.querySelector('select')!;
      select.value = 'l';
      select.dispatch('change');
      expect(values.size).toBe('l');
      expect(redraws).toBe(1);
      const text = fields[1]!.querySelector('input')!;
      text.value = 'web';
      text.dispatch('input');
      expect(values.name).toBe('web');
      expect(redraws).toBe(1);
      expect(controlValue(select as unknown as HTMLElement)).toBe('l');
    });
  });

  it('skips the inputs a workspace owns', () => {
    withFakeDom(() => {
      const fields = renderBlueprintForm({ inputs }, { values: () => ({}), set: () => undefined, skip: (id) => id === 'name' });
      expect(fields).toHaveLength(2);
    });
  });
});

describe('waves: the local grouping (swap point for planWaves)', () => {
  const p = plan();
  const d = decisionFor(p);

  it('starts with the foundation wave and leaves retired items out', () => {
    const w = localWavePlan(p, d);
    expect(w.waves[0]!.n).toBe(0);
    expect(w.waves[0]!.kind).toBe('foundation');
    const moved = w.groups.flatMap((g) => g.items);
    expect(moved).not.toContain(itemId('workload', 'old1'));
    expect(moved).toContain(itemId('database', 'adb'));
    expect(wavePlanFor(p, d)).toEqual(w);
  });

  it('fills waves under the limit per wave, lowest criticality first', () => {
    const w = localWavePlan({ ...p, waveSettings: { ...p.waveSettings, maxPerWave: 3 } }, d);
    const loads = waveLoads(p, w).filter((l) => l.kind === 'app');
    for (const l of loads) expect(l.workloads + l.databases).toBeLessThanOrEqual(3);
    const gamma = w.groups.find((g) => g.apps?.includes('gamma'))!;
    expect(gamma.wave).toBe(Math.max(...loads.map((l) => l.n)));
    expect(w.waves.some((x) => x.limitedBy === 'maxPerWave')).toBe(true);
  });

  it('honours a pinned wave and joins apps with a synchronous dependency', () => {
    const pinned = withPinnedWave(p, ['delta'], 4);
    const synced: Plan = { ...pinned, edges: [{ from: 'a1', to: 'b1', kind: 'sync' }] };
    const w = localWavePlan(synced, decisionFor(synced));
    expect(w.groups.find((g) => g.apps?.includes('delta'))!.wave).toBe(4);
    const joined = w.groups.find((g) => g.apps?.includes('alpha'))!;
    expect(joined.apps).toEqual(['alpha', 'beta']);
    expect(joined.formedBy).toContain('dependency.sync');
    expect(withPinnedWave(pinned, ['delta'], 0).apps.find((a) => a.name === 'delta')!.wave).toBeUndefined();
  });

  it('limits by the team capacity when it is set', () => {
    const settings = withWaveSetting(withWaveSetting(p.waveSettings, 'limited', 'yes'), 'parallelAppTeams', '1');
    expect(settings.capacity).toEqual({ ...DEFAULT_CAPACITY, parallelAppTeams: 1 });
    const w = localWavePlan({ ...p, waveSettings: settings }, d);
    for (const wave of w.waves.filter((x) => x.kind === 'app')) expect(wave.groups.length).toBe(1);
    expect(withWaveSetting(settings, 'limited', 'no').capacity).toBeUndefined();
  });

  it('dates the waves from the start and moves a wave past a freeze', () => {
    const settings = { ...p.waveSettings, start: '2027-01-04', weeks: 1 as const, maxPerWave: 3, freezes: [{ from: '2027-01-13', to: '2027-01-20', reason: 'Year-end' }] };
    const w = localWavePlan({ ...p, waveSettings: settings }, d);
    expect(w.waves[0]!.start).toBe('2027-01-04');
    expect(w.waves[0]!.end).toBe('2027-01-10');
    expect(w.waves[1]!.start).toBe('2027-01-21');
    expect(w.findings.map((f) => f.code)).toContain('waves.moved-past-freeze');
  });

  it('round-trips the freeze grid', () => {
    const f = [{ from: '2027-12-20', to: '2028-01-02', reason: 'Year-end | trading' }];
    expect(parseFreezes(freezesText(f))).toEqual(f);
    expect(withWaveSetting(p.waveSettings, 'freezes', '2027-01-01 | 2027-01-02 | x').freezes).toEqual([{ from: '2027-01-01', to: '2027-01-02', reason: 'x' }]);
  });

  it('puts the data-centre exit waves after the last app wave', () => {
    const dc: Plan = {
      ...p, mode: 'dc-exit',
      dcExit: {
        exitDate: '2027-12-31', dualRunningDays: 14, hardwareRemovalDays: 30, external: [], contracts: [], assets: [],
        infra: [{ id: 'fw1', category: 'network-device', name: 'fw1', disposition: 'retire', facts: { kind: 'firewall' } }],
      },
    };
    const w = localWavePlan(dc, decisionFor(dc));
    const lastApp = Math.max(...w.waves.filter((x) => x.kind !== 'exit').map((x) => x.n));
    const exits = w.waves.filter((x) => x.kind === 'exit');
    expect(exits.length).toBeGreaterThan(0);
    for (const e of exits) expect(e.n).toBeGreaterThan(lastApp);
  });
});

describe('landing zones: the card as the plan holds it', () => {
  const p = plan();

  it('offers dropdowns for every closed set and grids for the governance lists', () => {
    const pd = planModel(p).design.platforms[0]!;
    const lz = landingZoneInputs(p, pd);
    for (const field of ['subnet-size', 'zones-prod', 'zones-nonprod', 'bastion', 'log-retention']) {
      const input = lz.inputs.find((i) => i.id === overrideKey(pd.platform, 'lz', field));
      if (pd.platform === 'vmware' && (field === 'bastion' || field === 'log-retention')) continue;
      expect(input?.control).toBe('select');
    }
    const gov = governanceInputs('aws');
    expect(tableShape(gov.inputs.find((i) => i.id === governanceKey('aws', 'tags'))!)?.columns).toEqual(['Tag', 'Default value', 'Required']);
    const budgets = tableShape(gov.inputs.find((i) => i.id === governanceKey('aws', 'budgets'))!)!;
    expect(budgets.columns).toEqual(['Scope', 'Monthly amount', 'Currency', 'Alert at %']);
    expect(budgets.choices?.[2]?.map((o) => o.value)).toContain('EUR');
    expect(gov.defaults[governanceKey('aws', 'tags')]).toBe(DEFAULT_TAGS);
  });

  it('writes the regions, the mode and the overrides, and a default removes the override', () => {
    const defaults = { [overrideKey('aws', 'lz', 'bastion')]: 'cloud-native' };
    let q = withLandingZoneValue(p, 'aws:region:dr', 'eu-west-1', defaults);
    expect(q.requirements.regions.aws).toEqual({ primary: 'eu-west-2', dr: 'eu-west-1' });
    q = withLandingZoneValue(q, overrideKey('aws', 'lz', 'bastion'), 'jump-vm', defaults);
    expect(q.designOverrides[overrideKey('aws', 'lz', 'bastion')]).toBe('jump-vm');
    q = withLandingZoneValue(q, overrideKey('aws', 'lz', 'bastion'), 'cloud-native', defaults);
    expect(q.designOverrides[overrideKey('aws', 'lz', 'bastion')]).toBeUndefined();
    expect(landingZoneMode(q, 'aws')).toBe('included');
    q = withLandingZoneValue(q, 'aws:lz-mode', 'shared', defaults);
    expect(q.execution?.landingZones.aws).toBe('designed');
    expect(landingZoneMode(withLandingZoneMode(q, 'aws', 'included'), 'aws')).toBe('included');
  });

  it('takes every app while none is planned', () => {
    expect(migrationApps(p)).toEqual({ ids: p.apps.map((a) => a.id), planned: false });
  });
});

describe('generate: the migration project (swap point for generateProject)', () => {
  const p = plan();
  const model = planModel(p);
  const waves = wavePlanFor(p, model.decision);
  const all = PROJECT_PARTS.map((x) => x.id);
  const project = assembleMigrationProject({ plan: p, decision: model.decision, design: model.design, waves }, { parts: all, apps: [p.apps[0]!.id] });

  it('writes every part under the plan folder, with its findings kept per part', () => {
    expect(project.root).toBe('wave-test');
    for (const path of Object.keys(project.files)) expect(path.startsWith('wave-test/')).toBe(true);
    expect(project.parts.map((x) => x.part)).toEqual(all);
    const has = (prefix: string) => Object.keys(project.files).some((f) => f.startsWith(`wave-test/${prefix}`));
    for (const prefix of ['plan/plan.json', 'terraform/', 'ansible/', 'migration/execute/', 'migration/waves.csv', 'migration/move-groups.csv', 'governance/', 'reports/', 'capacity/fetch-quotas.sh', 'discovery/', 'coupling/', 'apps/slices/', 'README.md']) {
      expect(has(prefix)).toBe(true);
    }
    expect(project.parts.every((x) => !x.findings.some((f) => f.code === 'project.part-failed'))).toBe(true);
  });

  it('leaves out what is not ticked', () => {
    const only = assembleMigrationProject({ plan: p, decision: model.decision, design: model.design, waves }, { parts: ['waves'] });
    expect(Object.keys(only.files).sort()).toEqual(['wave-test/README.md', 'wave-test/migration/move-groups.csv', 'wave-test/migration/waves.csv']);
  });

  it('has no footprint and no credential in any file', () => {
    const text = Object.values(project.files).join('\n');
    expect(/Generated by|generated on|gibso|E:\\Repos|C:\\Users/i.test(text)).toBe(false);
    expect(/(aws_secret_access_key|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16})/.test(text)).toBe(false);
  });

  it('zips reproducibly, dated from the plan, with every path in it', async () => {
    const a = await archiveProject(p, project.files);
    const b = await archiveProject(p, project.files);
    expect(a.length === b.length && a.every((x, i) => x === b[i])).toBe(true);
    expect(projectDate(p).getFullYear()).toBe(2026);
    // The central directory's names.
    const names: string[] = [];
    const view = new DataView(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i + 46 <= a.length; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      const n = view.getUint16(i + 28, true);
      names.push(new TextDecoder().decode(a.subarray(i + 46, i + 46 + n)));
    }
    expect(names.sort()).toEqual(Object.keys(project.files).sort());
  });
});
