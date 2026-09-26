/**
 * WP-17: the pattern paths (`paths/patterns.ts`) and the databases beyond the
 * core (`db/beyond.ts`), built end to end through `executionKit` with a plan
 * whose items resolve to every WP-17 path.
 */

import { describe, it } from 'node:test';
import { expect } from '../../../../testing/expect.ts';
import { defaultExecution, defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../../options.ts';
import type { App, AppPlan, Database, DbServiceId, ItemDecision, Method, Plan, PlanDecision, Platform, WavePlan, Workload } from '../../types.ts';
import { contractViolations, CREDENTIAL_PATTERNS, DATE_LITERAL, VERBS, type ExecPath } from '../contract.ts';
import { GENERATORS as BEYOND } from '../db/beyond.ts';
import { executionKit, type ExecutionKit } from '../kit.ts';
import { createRegistry, PATH_OWNERS } from '../registry.ts';
import { envToken, GENERATORS as PATTERNS, HOST_STEP_FILE, renderSettingsSh, settingTokens } from './patterns.ts';

// ---------------------------------------------------------------------------
// Fixture: one item (or more) on every WP-17 path
// ---------------------------------------------------------------------------

function workload(name: string, over: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app: 'data', env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
  };
}
function database(name: string, over: Partial<Database> = {}): Database {
  return {
    id: itemId('database', name), name, engine: 'postgres', edition: 'community', version: 'other', hosts: [], vcpu: 4, ramGib: 32,
    sizeGib: 200, ha: 'none', dr: 'none', features: [], licence: 'community', app: 'data', source: 'manual', ...over,
  };
}
function app(name: string, over: Partial<App> = {}): App {
  return { id: itemId('app', name), name, criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', ...over };
}
function appPlan(name: string, answers: Record<string, string>): AppPlan {
  return { app: itemId('app', name), origin: 'migrate', status: 'draft', variants: {}, answers, landingZone: 'shared' };
}
function dec(id: string, kind: 'workload' | 'database', platform: Platform | undefined, method: Method, over: Partial<ItemDecision> = {}, service?: DbServiceId): ItemDecision {
  const chosen = platform ? { platform, score: 10, hits: [], ...(service ? { service } : {}) } : undefined;
  return {
    id, kind, disposition: method === 'none' ? 'retire' : 'rehost', method,
    options: chosen ? [chosen] : [], ...(chosen ? { chosen } : {}), pinned: false, margin: 5, findings: [], ...over,
  };
}
const W = (n: string): string => itemId('workload', n);
const D = (n: string): string => itemId('database', n);

function fixture(): { plan: Plan; decision: PlanDecision; waves: WavePlan } {
  const ws: Workload[] = [
    workload('hana01', { app: 'erp', workloadType: 'sap-hana', facts: { ipAddresses: ['10.0.0.5'] } }),
    workload('hana02', { app: 'erp', workloadType: 'sap-hana' }),
    workload('exch01', { app: 'mail', workloadType: 'exchange', os: 'win-2019' }),
    workload('sp01', { app: 'intranet', workloadType: 'sharepoint', os: 'win-2019' }),
    workload('node1', { app: 'shopk8s', workloadType: 'k8s-node' }),
    workload('node2', { app: 'shopk8s', workloadType: 'k8s-node' }),
    workload('bigip01', { app: 'edge', workloadType: 'appliance-f5', facts: { ipAddresses: ['2001:db8::10'] } }),
    workload('pa01', { app: 'edge', workloadType: 'appliance-paloalto' }),
    workload('fgt01', { app: 'edge', workloadType: 'appliance-fortinet' }),
    ...['db2vm', 'asevm', 'ifxvm', 'redisvm', 'cass1', 'cass2', 'mongovm'].map((n) => workload(n)),
    workload('esvm', { facts: { ipAddresses: ['2001:db8::30'] } }),
  ];
  const dbs: Database[] = [
    database('DB2RDS', { engine: 'db2', hosts: ['db2vm'] }),
    database('DB2HA', { engine: 'db2', hosts: ['db2vm'] }),
    database('ASE1', { engine: 'sybase-ase', hosts: ['asevm'] }),
    database('IFX1', { engine: 'informix', hosts: ['ifxvm'] }),
    database('MONGO1', { engine: 'mongodb', hosts: ['mongovm'] }),
    database('REDIS1', { engine: 'redis', hosts: ['redisvm'] }),
    database('REDIS2', { engine: 'redis', hosts: ['redisvm'] }),
    database('CASSK', { engine: 'cassandra', hosts: ['cass1', 'cass2'] }),
    database('CASSMI', { engine: 'cassandra', hosts: ['cass1', 'cass2'] }),
    database('ES1', { engine: 'elasticsearch', hosts: ['esvm'] }),
    database('ES2', { engine: 'elasticsearch', hosts: ['esvm'] }),
  ];
  const plan: Plan = {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'Plan-7f3a9c21-x', name: 'Patterns', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: ws, databases: dbs,
    apps: [app('erp', { pattern: 'sap-s4hana' }), app('mail', { pattern: 'exchange' }), app('intranet', { pattern: 'sharepoint' }), app('shopk8s', { pattern: 'kubernetes' }), app('edge'), app('data')],
    appPlans: [appPlan('erp', { sids: 'prd' }), appPlan('shopk8s', { namespaces: 'shop, payments' })],
    edges: [], requirements: defaultRequirements(), designOverrides: {}, waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    execution: { ...defaultExecution(), pathOverrides: { [W('hana02')]: 'sap-backup-restore', [D('ES2')]: 'es-reindex-remote' } },
  };
  const decision: PlanDecision = {
    engineVersion: 'test', platforms: [], subsetScores: [], findings: [],
    items: Object.fromEntries([
      dec(W('hana01'), 'workload', 'aws', 'replicate'),
      dec(W('hana02'), 'workload', 'azure', 'replicate'),
      dec(W('exch01'), 'workload', undefined, 'none', { disposition: 'repurchase' }),
      dec(W('sp01'), 'workload', undefined, 'none', { disposition: 'repurchase' }),
      dec(W('node1'), 'workload', 'aws', 'replicate'),
      dec(W('node2'), 'workload', 'aws', 'replicate'),
      dec(W('bigip01'), 'workload', 'azure', 'replicate'),
      dec(W('pa01'), 'workload', 'aws', 'replicate'),
      dec(W('fgt01'), 'workload', 'google', 'replicate'),
      ...['db2vm', 'asevm', 'ifxvm', 'redisvm', 'cass1', 'cass2', 'esvm', 'mongovm'].map((n) => dec(W(n), 'workload', 'aws', 'rebuild')),
      dec(D('DB2RDS'), 'database', 'aws', 'managed-db', {}, 'aws-rds-db2'),
      dec(D('DB2HA'), 'database', 'aws', 'managed-db', {}, 'aws-ec2'),
      dec(D('ASE1'), 'database', 'aws', 'managed-db', {}, 'aws-ec2'),
      dec(D('IFX1'), 'database', 'aws', 'managed-db', {}, 'aws-ec2'),
      dec(D('MONGO1'), 'database', 'azure', 'managed-db', {}, 'azure-documentdb'),
      dec(D('REDIS1'), 'database', 'aws', 'managed-db', {}, 'aws-ec2'),
      dec(D('REDIS2'), 'database', 'aws', 'managed-db', {}, 'aws-elasticache'),
      dec(D('CASSK'), 'database', 'aws', 'managed-db', {}, 'aws-keyspaces'),
      dec(D('CASSMI'), 'database', 'azure', 'managed-db', {}, 'azure-cassandra-mi'),
      dec(D('ES1'), 'database', 'aws', 'managed-db', {}, 'aws-opensearch'),
      dec(D('ES2'), 'database', 'oci', 'managed-db', {}, 'oci-compute'),
    ].map((d) => [d.id, d])),
  };
  const all = [...ws.map((w) => w.id), ...dbs.map((d) => d.id)];
  const waves: WavePlan = {
    settings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    groups: [{ id: 'g1', items: all, why: 'app', wave: 1, method: 'replicate' }],
    waves: [{ n: 1, groups: ['g1'] }],
    findings: [],
  };
  return { plan, decision, waves };
}

const EMPTY_DESIGN = { platforms: [], findings: [] };
const WP17_GENERATORS = [...PATTERNS, ...BEYOND];
const WP17_PATHS = (Object.keys(PATH_OWNERS) as ExecPath[]).filter((p) => PATH_OWNERS[p] === 'WP-17').sort();

function build(): ExecutionKit {
  const { plan, decision, waves } = fixture();
  return executionKit(plan, decision, EMPTY_DESIGN, waves, undefined, { registry: createRegistry(WP17_GENERATORS) });
}
const KIT = build();
const byName = new Map(KIT.manifest.items.map((i) => [i.name, i]));
const wp17Files = (): [string, string][] => {
  const scripts = new Set(KIT.manifest.items.filter((i) => PATH_OWNERS[i.path] === 'WP-17').map((i) => i.script!));
  const dirs = [...scripts].map((s) => s.replace(/[^/]+$/, ''));
  return Object.entries(KIT.files).filter(([f]) => dirs.some((d) => f.startsWith(d)) || f.startsWith('ansible/'));
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('WP-17 generators: registration', () => {
  it('cover exactly the paths PATH_OWNERS gives WP-17, each once, owned by WP-17', () => {
    const claimed = WP17_GENERATORS.flatMap((g) => g.paths);
    expect([...claimed].sort()).toEqual(WP17_PATHS);
    expect(new Set(claimed).size).toBe(claimed.length);
    for (const g of WP17_GENERATORS) expect(g.owner).toBe('WP-17');
    expect(WP17_PATHS.length).toBe(17);
  });
  it('register in createRegistry without an ownership error, and leave no WP-17 path missing', () => {
    const r = createRegistry(WP17_GENERATORS);
    for (const p of WP17_PATHS) expect(r.get(p)?.owner).toBe('WP-17');
    expect(r.missing().filter((p) => PATH_OWNERS[p] === 'WP-17')).toEqual([]);
  });
  it('have unique ids and declare what the controller needs', () => {
    const ids = WP17_GENERATORS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of WP17_GENERATORS) expect(g.needs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The kit, end to end
// ---------------------------------------------------------------------------

describe('WP-17 generators: the execution kit', () => {
  it('resolves an item to every WP-17 path and gives each a WP-17 script', () => {
    const inKit = new Set(KIT.manifest.items.map((i) => i.path));
    for (const p of WP17_PATHS) expect(inKit.has(p)).toBe(true);
    for (const i of KIT.manifest.items.filter((x) => PATH_OWNERS[x.path] === 'WP-17')) {
      expect(i.script!.startsWith('paths/pending/')).toBe(false);
      expect(typeof KIT.files[i.script!]).toBe('string');
    }
    expect(byName.get('hana01')?.script).toBe('paths/sap/sap.sh');
    expect(byName.get('exch01')?.script).toBe('paths/m365/exchange.ps1');
    expect(byName.get('sp01')?.script).toBe('paths/m365/sharepoint.sh');
    expect(byName.get('DB2HA')?.script).toBe('paths/db/db2/db2.sh');
    expect(byName.get('ES2')?.path).toBe('es-reindex-remote');
  });
  it('has no pending finding and no error for the WP-17 paths', () => {
    const pending = KIT.findings.filter((f) => f.code === 'exec.path.no-generator' && WP17_PATHS.some((p) => f.message.includes(` ${p} `)));
    expect(pending).toEqual([]);
    expect(KIT.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
  it('keeps the contract in every file it writes', () => {
    const v = Object.entries(KIT.files).flatMap(([f, t]) => contractViolations(f, t));
    expect(v).toEqual([]);
  });
  it('implements every verb in every script', () => {
    for (const [f, t] of wp17Files()) {
      if (f.endsWith('.sh')) for (const v of VERBS) expect(t).toContain(`verb_${v.replace(/-/g, '_')}() {`);
      if (f.endsWith('.ps1')) for (const v of VERBS) expect(t).toContain(`  '${v}' = {`);
    }
  });
  it('names the entry of each path among its files', () => {
    const { plan, decision, waves } = fixture();
    const kit = executionKit(plan, decision, EMPTY_DESIGN, waves, undefined, { registry: createRegistry(WP17_GENERATORS) });
    for (const g of WP17_GENERATORS) for (const p of g.paths) expect(kit.files[g.entry(p)] !== undefined).toBe(true);
  });
  it('is reproducible', () => {
    expect(build().files).toEqual(KIT.files);
  });
  it('writes no credential, no date literal in scripts or plays, and no footprint', () => {
    for (const [f, t] of wp17Files()) {
      for (const re of CREDENTIAL_PATTERNS) expect(re.test(t)).toBe(false);
      if (!f.endsWith('.md')) expect(DATE_LITERAL.test(t)).toBe(false);
      expect(/Generated (by|on|at)|Aria|vRealize|ESXi/.test(t)).toBe(false);
    }
  });
  it('writes the shared host-step play once, identically, for every host-bound family', () => {
    expect(KIT.files[HOST_STEP_FILE]).toContain('atk_stdin_env');
    expect(KIT.files[HOST_STEP_FILE]).toContain('no_log');
    expect(KIT.findings.filter((f) => f.code === 'exec.kit.file-clash')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What the scripts carry
// ---------------------------------------------------------------------------

describe('WP-17 generators: settings and credentials', () => {
  it('derive the per-item settings from the plan, leaving the unknown ones to the environment', () => {
    const sap = KIT.files['paths/sap/sap.sh']!;
    expect(sap).toContain(`['w:hana01|sid']='PRD'`);
    expect(sap).toContain(`['w:hana01|source_host']='src-hana01'`);
    expect(sap.includes(`['w:hana01|instance']`)).toBe(false);
    expect(KIT.files['paths/sap/README.md']).toContain('ATK_SET_HANA01_INSTANCE');
    const velero = KIT.files['paths/velero/velero.sh']!;
    expect(velero).toContain(`['w:node1|namespaces']='shop,payments'`);
    expect(velero).toContain(`['w:node1|backup']='atk-plan7f3a-1-shopk8s'`);
    expect(velero).toContain(`['w:node2|backup']='atk-plan7f3a-1-shopk8s'`);
    const appl = KIT.files['paths/appliance/appliance.sh']!;
    expect(appl).toContain(`['w:bigip01|vendor']='f5'`);
    expect(appl).toContain(`['w:bigip01|source_addr']='2001:db8::10'`);
    expect(appl).toContain(`['w:fgt01|vendor']='fortinet'`);
    expect(KIT.files['paths/db/es/es.sh']).toContain(`['d:es1|source_url']='https://[2001:db8::30]:9200'`);
    expect(KIT.files['paths/db/db2/db2.sh']).toContain(`['d:db2rds|target']='rds'`);
  });
  it('read credentials only through atk_secret / Get-AtkSecret, passed on stdin or in the environment', () => {
    for (const [f, t] of wp17Files()) {
      if (!f.endsWith('.sh')) continue;
      expect(/--password[= ]\S*\$|-p "\$pw"|using \$pw/.test(t)).toBe(false);
    }
    expect(KIT.files['paths/sap/sap.sh']).toContain('secret_for pw SAP_HANA_SYSTEM_PASSWORD');
    expect(KIT.files['paths/db/redis/redis.sh']).toContain('REDISCLI_AUTH="$pw"');
    expect(KIT.files['paths/m365/exchange.ps1']).toContain('Get-AtkSecret -Name EXO_ONPREM_PASSWORD');
    expect(KIT.files['paths/m365/exchange.ps1']).toContain('-CertificateThumbprint');
  });
  it('record the steps only a person can do as skipped with the runbook step', () => {
    expect(KIT.files['paths/appliance/appliance.sh']).toContain('FortiManager or FortiConverter');
    expect(KIT.files['paths/m365/exchange.ps1']).toContain('Hybrid Configuration Wizard');
    expect(KIT.files['paths/sap/README.md']).toContain('DMO with System Move');
    expect(KIT.files['ansible/spmt.yml']).toContain('Windows PowerShell 5.1');
  });
  it('report the paths without a way back and the runbook vendors', () => {
    const codes = KIT.findings.map((f) => `${f.code} ${f.message}`);
    expect(codes.some((c) => c.startsWith('exec.db.no-reverse') && c.includes('hana02'))).toBe(true);
    expect(codes.some((c) => c.startsWith('exec.db.no-reverse') && c.includes('ASE1'))).toBe(true);
    expect(codes.some((c) => c.startsWith('exec.pattern.runbook') && c.includes('fgt01'))).toBe(true);
    expect(codes.some((c) => c.startsWith('exec.db.no-reverse') && c.includes('REDIS1'))).toBe(false);
  });
});

describe('WP-17 helpers', () => {
  it('make environment tokens, unique among the items', () => {
    expect(envToken('web-01.corp')).toBe('WEB_01_CORP');
    expect(envToken('9lives')).toBe('I_9LIVES');
    const items = KIT.manifest.items.filter((i) => i.name === 'REDIS1');
    const twin = { ...items[0]!, id: 'd:redis1-other' };
    const t = settingTokens([items[0]!, twin]);
    expect(t.get(items[0]!.id)).not.toBe(t.get(twin.id));
    expect(t.get(twin.id)!.startsWith('REDIS1_')).toBe(true);
  });
  it('quote setting values for bash', () => {
    const item = KIT.manifest.items[0]!;
    const text = renderSettingsSh([{ item, values: { note: "it's" } }], new Map([[item.id, 'X']]));
    expect(text).toContain(`|note']='it'\\''s'`);
    expect(() => renderSettingsSh([{ item, values: { 'Bad-Key': 'x' } }], new Map())).toThrow(/setting key/);
  });
});
