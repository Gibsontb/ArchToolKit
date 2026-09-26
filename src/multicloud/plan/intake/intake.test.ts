import { describe, it, before } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { estateWorkbook } from '../../../testing/estate-fixture.ts';
import { importRvToolsWorkbook } from '../../../vmware/rvtools.ts';
import { emptyInventory, isWorkload, scopedKey, type Inventory, type InventoryVm } from '../../../vmware/inventory.ts';
import { assessVm } from '../../../vmware/vm-readiness.ts';
import type { PortfolioEntry, Evaluation, Route } from '../../../migration/types.ts';
import { EMPTY_APPLICATION } from '../../../migration/types.ts';
import type { Criticality as PortfolioCriticality } from '../../../migration/options.ts';
import { emptyPlan } from '../store.ts';
import { csvHeader, WORKLOAD_COLUMNS, DATABASE_COLUMNS, APP_COLUMNS, SITE_COLUMNS, itemId } from '../options.ts';
import type { App, Database, Plan, Site, Workload } from '../types.ts';
import {
  INTAKE_ADAPTERS, intakeAdapter, intakeStats, intakeFromServers,
  workloadsFromInventory, scopeInventory, scopeChoices, defaultAttributes, movableDisks, envFromText, VMWARE_ADAPTER,
  appsFromPortfolio, intakeFromPortfolio, toMigrationCloud, fromMigrationCloud, criticalityFromPortfolio, routeFromPortfolio,
  parseWorkloadsCsv, parseDatabasesCsv, parseAppsCsv, parseSitesCsv, toCsv, CSV_TEMPLATES, intakeFromCsv,
  mergeRows, editRow, mergeIntake, applyDbHostRoles, applyAppDefaults, ensureApps,
  validatePlan, validateScreen, screenOf, findingsForRow, PLAN_FINDING_IDS, type IntakeFacts,
} from './index.ts';

const ON = '2026-09-26';
const vm = (over: Partial<InventoryVm> & { name: string }): InventoryVm => ({
  powerState: 'poweredOn', vcpu: 2, memoryGib: 8, provisionedGib: 100, ...over,
});
const inventoryOf = (vms: InventoryVm[]): Inventory => ({ ...emptyInventory({ collectedAt: `${ON}T00:00:00Z` }), vms });
const strip = <T extends object>(rows: readonly T[]): T[] => rows.map((r) => {
  const { edited: _e, ...rest } = r as T & { edited?: unknown };
  return rest as unknown as T;
});

// ---------------------------------------------------------------------------
// The VMware estate
// ---------------------------------------------------------------------------

describe('workloadsFromInventory: the estate fixture', () => {
  let inv: Inventory;
  before(async () => {
    inv = (await importRvToolsWorkbook(await estateWorkbook(), { label: 'estate.xlsx' })).inventory;
  });

  it('gives one workload per workload VM, with OS ids, disks and readiness facts', () => {
    const r = workloadsFromInventory(inv, { includePoweredOff: true, on: ON });
    const vms = inv.vms.filter(isWorkload);
    expect(r.workloads).toHaveLength(vms.length);
    expect(r.workloads.map((w) => w.name).sort()).toEqual(vms.map((v) => v.name).sort());
    expect(r.workloads.some((w) => w.name === 'tpl-linux')).toBe(false);

    const byName = new Map(r.workloads.map((w) => [w.name, w]));
    expect(byName.get('app-01')?.os).toBe('win-2019');
    expect(byName.get('db-01')?.os).toBe('rhel-8');
    expect(byName.get('old-01')?.os).toBe('win-2008r2');
    for (const w of r.workloads) {
      expect(w.id).toBe(itemId('workload', w.name));
      expect(w.source).toBe('estate');
      expect(w.disksGib.length).toBeGreaterThan(0);
      expect(w.disksGib.every((d) => d > 0)).toBe(true);
      const src = vms.find((v) => v.name === w.name) as InventoryVm;
      expect(w.sourceKey).toBe(scopedKey(src.vcenter, src.name));
      expect(w.vcpu).toBe(src.vcpu);
      expect(w.ramGib).toBe(Math.ceil(src.memoryGib));
      expect(w.facts?.powerState).toBe(src.powerState);
      expect((w.facts?.readiness ?? []).map((x) => x.id)).toEqual(assessVm(src, inv.source.collectedAt).map((f) => f.check.id));
      expect(w.rpo).toBe('4h');
      expect(w.licence).toBe(w.os.startsWith('win-') || w.os.startsWith('rhel-') ? 'li' : 'free');
    }
    // The shared physical RDM does not move as a VMDK: it is a fact and a blocker.
    const db1 = byName.get('db-01') as Workload;
    expect(db1.facts?.rdmGib ?? 0).toBeGreaterThan(1000);
    expect(db1.disksGib.reduce((s, d) => s + d, 0)).toBeLessThan(1000);
    expect((db1.facts?.readiness ?? []).some((x) => x.severity === 'blocker')).toBe(true);
    expect(r.findings.map((f) => f.code)).toContain('plan.sources.rdm');
    expect(r.findings.map((f) => f.code)).toContain('plan.sources.os-eol');
  });

  it('leaves powered-off VMs out unless asked, and says so', () => {
    const r = workloadsFromInventory(inv, { includePoweredOff: false, on: ON });
    expect(r.workloads.some((w) => w.name === 'old-01')).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain('plan.sources.powered-off-skipped');
  });

  it('reads app, owner and env from the attributes and patterns', () => {
    expect(defaultAttributes(inv)).toEqual({ appAttribute: 'folder-leaf', envAttribute: 'name-pattern', ownerAttribute: 'Owner' });
    const r = workloadsFromInventory(inv, { includePoweredOff: true, on: ON });
    const app01 = r.workloads.find((w) => w.name === 'app-01') as Workload;
    expect(app01.app).toBe('Web');
    expect(r.apps.find((a) => a.name === 'Web')?.owner).toBe('team-a');
    expect(r.apps.every((a) => a.id === itemId('app', a.name))).toBe(true);
    const none = workloadsFromInventory(inv, { includePoweredOff: true, appAttribute: '', envAttribute: '', ownerAttribute: '' });
    expect(none.workloads.every((w) => w.app === '' && w.env === 'prod')).toBe(true);
    expect(none.apps).toHaveLength(0);
    expect(envFromText('APP-UAT-01')).toBe('test');
    expect(envFromText('Pre-production')).toBe('preprod');
    expect(envFromText('something')).toBeUndefined();
  });

  it('scopes to a cluster or a folder prefix', () => {
    expect(scopeInventory(inv, 'Cluster01').vms.every((v) => v.cluster === 'Cluster01')).toBe(true);
    const apps = workloadsFromInventory(inv, { scope: '/DC1/Apps', includePoweredOff: true });
    expect(apps.workloads.map((w) => w.name).sort()).toEqual(['app-01', 'app-02', 'old-01']);
    const choices = scopeChoices(inv);
    expect(choices.clusters).toContain('mgmt-cl01');
    expect(choices.folders).toContain('/DC1/Apps');
    const nothing = workloadsFromInventory(inv, { scope: 'no-such', includePoweredOff: true });
    expect(nothing.workloads).toHaveLength(0);
    expect(nothing.findings.map((f) => f.code)).toContain('plan.sources.scope-empty');
  });

  it('is the vmware adapter', () => {
    expect(VMWARE_ADAPTER.parse(inv, { includePoweredOff: true }).workloads.length).toBe(inv.vms.filter(isWorkload).length);
    expect(INTAKE_ADAPTERS.map((a) => a.id)).toEqual(['vmware', 'csv', 'portfolio']);
    expect(intakeAdapter('vmware')).toBe(VMWARE_ADAPTER as unknown as NonNullable<ReturnType<typeof intakeAdapter>>);
  });
});

describe('workloadsFromInventory: inferred databases and details', () => {
  it('a SQL-named Windows VM gives an inferred sqlserver database and role db', () => {
    const inv = inventoryOf([
      vm({ name: 'PAY-SQL-PRD-01', vcpu: 8, memoryGib: 64, provisionedGib: 600, guestOs: 'Microsoft Windows Server 2019 (64-bit)' }),
      vm({ name: 'pay-web-01', guestOs: 'Microsoft Windows Server 2022 (64-bit)' }),
    ]);
    const r = workloadsFromInventory(inv, { includePoweredOff: false });
    const sql = r.workloads.find((w) => w.name === 'PAY-SQL-PRD-01') as Workload;
    expect(sql.role).toBe('db');
    expect(sql.env).toBe('prod');
    expect(r.databases).toHaveLength(1);
    const db = r.databases[0] as Database;
    expect(db.engine).toBe('sqlserver');
    expect(db.inferred).toBe(true);
    expect(db.hosts).toEqual(['PAY-SQL-PRD-01']);
    expect(db.vcpu).toBe(8);
    expect(db.ramGib).toBe(64);
    expect(db.edition).toBe('commercial');
    expect(db.version).toBe('other');
    expect(db.licence).toBe('li');
    expect(r.findings.map((f) => f.code)).toContain('plan.sources.db-inferred');
    expect(r.workloads.find((w) => w.name === 'pay-web-01')?.role).toBe('web');
  });

  it('keeps two VMs of the same name, renames the second, and says so', () => {
    const r = workloadsFromInventory(inventoryOf([vm({ name: 'app1', vcenter: 'a' }), vm({ name: 'app1', vcenter: 'b' })]), { includePoweredOff: false });
    expect(r.workloads.map((w) => w.name)).toEqual(['app1', 'app1-2']);
    expect(new Set(r.workloads.map((w) => w.id)).size).toBe(2);
    expect(r.findings.map((f) => f.code)).toContain('plan.sources.duplicate-name');
  });

  it('flags an unknown OS, orders disks boot first, and turns keep-together rules into dependency hints', () => {
    const inv = inventoryOf([
      vm({
        name: 'n1', guestOs: '', clusterRules: ['Affinity'], clusterRuleNames: ['together'], cluster: 'c',
        disks: [
          { label: 'Hard disk 2', capacityGib: 200.2, raw: false },
          { label: 'Hard disk 1', capacityGib: 60, raw: false },
          { label: 'Hard disk 3', capacityGib: 1024, raw: true, rawCompatibilityMode: 'physicalMode' },
        ],
      }),
      vm({ name: 'n2', guestOs: 'rhel9_64Guest', clusterRules: ['Affinity'], clusterRuleNames: ['together'], cluster: 'c' }),
    ]);
    const r = workloadsFromInventory(inv, { includePoweredOff: false });
    const n1 = r.workloads[0] as Workload;
    expect(n1.os).toBe('unknown');
    expect(n1.disksGib).toEqual([60, 201]);
    expect(n1.facts?.rdmGib).toBe(1024);
    expect(n1.dependsOn).toEqual(['n2']);
    expect(r.workloads[1]?.dependsOn).toEqual(['n1']);
    expect(r.findings.map((f) => f.code)).toContain('plan.sources.os-unknown');
    expect(movableDisks(vm({ name: 'x', provisionedGib: 50 })).sizes).toEqual([50]);
  });

  it('counts the stat tiles', () => {
    const r = workloadsFromInventory(inventoryOf([
      vm({ name: 'sql01', guestOs: 'windows2019srv_64Guest', vcpu: 4, memoryGib: 16 }),
      vm({ name: 'lx01', guestOs: 'Red Hat Enterprise Linux 7 (64-bit)' }),
      vm({ name: 'mystery' }),
    ]), { includePoweredOff: false });
    const s = intakeStats(r.workloads, r.databases, ON);
    expect(s.workloads).toBe(3);
    expect(s.windows).toBe(1);
    expect(s.linux).toBe(1);
    expect(s.unknownOs).toBe(1);
    expect(s.vcpu).toBe(8);
    expect(s.dbCandidates).toBe(1);
  });

  it('shares its mapping with other server sources', () => {
    const r = intakeFromServers([{ name: 'hv-ora-01', os: 'ol-8', vcpu: 4, memoryGib: 32, disksGib: [80, 500], provisionedGib: 580 }], { source: 'manual' });
    expect(r.workloads[0]?.role).toBe('db');
    expect(r.databases[0]?.engine).toBe('oracle');
    expect(r.databases[0]?.licence).toBe('oracle-processor');
  });
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const WORKLOADS: Workload[] = [
  {
    id: 'w:pay-app-01', name: 'pay-app-01', app: 'Payroll, EMEA', env: 'preprod', role: 'app', os: 'win-2022', vcpu: 4, ramGib: 16.5,
    disksGib: [100, 250], criticality: 'tier1', rpo: '15m', rto: '1h', licence: 'byol-sa', residency: 'eu', disposition: 'rehost',
    dependsOn: ['pay-sql-01', 'site:London'], pin: 'azure', source: 'csv',
  },
  {
    id: 'w:lx-01', name: 'lx-01', app: 'He said "hi"', env: 'dev', role: 'other', os: 'unknown', vcpu: 1, ramGib: 2,
    disksGib: [], criticality: 'tier3', rpo: '24h', rto: '72h', licence: 'free', dependsOn: [], source: 'csv',
  },
];
const DATABASES: Database[] = [
  {
    id: 'd:pay-sql-01', name: 'pay-sql-01', engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2019', hosts: ['pay-sql-01', 'pay-sql-02'],
    vcpu: 8, ramGib: 64, sizeGib: 900, ha: 'sql-ag', dr: 'sql-ag-async', features: ['ssis', 'agent-jobs'], licence: 'byol-sa', app: 'Payroll, EMEA',
    pinService: 'azure-sqlmi', source: 'csv',
  },
  {
    id: 'd:pg', name: 'pg', engine: 'postgres', edition: 'community', version: 'pg-16', hosts: [], vcpu: 2, ramGib: 8, sizeGib: 50,
    ha: 'none', dr: 'none', features: [], licence: 'community', app: '', source: 'csv',
  },
];
const APPS: App[] = [
  {
    id: 'a:payroll-emea', name: 'Payroll, EMEA', owner: 'Finance', criticality: 'tier0', residency: 'uk', latencyToOnPrem: 'sensitive',
    deadlineMonths: 9, special: 'none', route: 'replatform', wave: 0, notes: 'Line one\nline two', source: 'csv',
  },
  { id: 'a:crm', name: 'CRM', criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'gpu', source: 'csv' },
];
const SITES: Site[] = [
  { name: 'London', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.10.0.0/16', 'fd00:10::/48'], bandwidth: '10g', circuit: 'expressroute', circuitLocation: 'London2' },
  { name: 'Leeds', cidrs: [], bandwidth: '1g', circuit: 'none' },
];

describe('CSV', () => {
  it('writes the design headers, and templates for all four files', () => {
    expect(toCsv('workloads', []).trim()).toBe('name,app,env,role,os,vcpu,ram_gib,disks_gib,criticality,rpo,rto,licence,residency,disposition,depends_on,pin');
    expect(toCsv('databases', []).trim()).toBe('name,engine,edition,version,hosts,vcpu,ram_gib,size_gib,ha,dr,features,licence,app,pin_service');
    expect(toCsv('apps', []).trim()).toBe('app,owner,criticality,residency,latency,deadline_months,special,route,wave,notes');
    expect(toCsv('sites', []).trim()).toBe('site,vpn_peer,bgp_asn,cidrs,bandwidth,circuit,circuit_location');
    expect(CSV_TEMPLATES).toEqual({
      'workloads.csv': `${csvHeader(WORKLOAD_COLUMNS)}\n`,
      'databases.csv': `${csvHeader(DATABASE_COLUMNS)}\n`,
      'apps.csv': `${csvHeader(APP_COLUMNS)}\n`,
      'sites.csv': `${csvHeader(SITE_COLUMNS)}\n`,
    });
  });

  it('round-trips losslessly, in both directions', () => {
    const w = toCsv('workloads', WORKLOADS);
    const pw = parseWorkloadsCsv(w);
    expect(pw.findings).toEqual([]);
    expect(strip(pw.rows)).toEqual(WORKLOADS);
    expect(toCsv('workloads', pw.rows)).toBe(w);

    const d = toCsv('databases', DATABASES);
    const pd = parseDatabasesCsv(d);
    expect(pd.findings).toEqual([]);
    expect(strip(pd.rows)).toEqual(DATABASES);
    expect(toCsv('databases', pd.rows)).toBe(d);

    const a = toCsv('apps', APPS);
    const pa = parseAppsCsv(a);
    expect(pa.findings).toEqual([]);
    expect(strip(pa.rows)).toEqual(APPS);
    expect(toCsv('apps', pa.rows)).toBe(a);

    const s = toCsv('sites', SITES);
    const ps = parseSitesCsv(s);
    expect(ps.findings).toEqual([]);
    expect(ps.rows).toEqual(SITES);
    expect(toCsv('sites', ps.rows)).toBe(s);
  });

  it('records the filled columns as edited', () => {
    const r = parseWorkloadsCsv('name,app,os\nweb1,Shop,\n');
    expect(r.rows[0]?.edited).toEqual(['app']);
    expect(r.rows[0]?.os).toBe('unknown');
    expect(r.rows[0]?.role).toBe('web');
  });

  it('turns an unknown cell into a blank and a finding, never a guess', () => {
    const text = [
      'name,env,os,disposition,pin,criticality,disks_gib',
      'w1,production-ish,BeOS 5,lift-and-shift,alibaba,Tier 1 business-critical,40 x',
      'w2,Pre-production,Windows Server 2019 Standard,,,,',
    ].join('\n');
    const r = parseWorkloadsCsv(text);
    const w1 = r.rows[0] as Workload;
    expect(w1.env).toBe('prod'); // blank: the column default
    expect(w1.os).toBe('unknown');
    expect(w1.disposition).toBeUndefined();
    expect(w1.pin).toBeUndefined();
    expect(w1.criticality).toBe('tier1'); // a label reads as its value
    expect(w1.disksGib).toEqual([40]);
    expect(w1.edited ?? []).not.toContain('env');
    const bad = r.findings.filter((f) => f.code === 'plan.csv.unknown-value').map((f) => f.path).sort();
    expect(bad).toEqual(['workloads[0].disksGib', 'workloads[0].disposition', 'workloads[0].env', 'workloads[0].os', 'workloads[0].pin']);
    // Free text OS is classified, which is the classifier, not a guess.
    expect(r.rows[1]?.os).toBe('win-2019');
    expect(r.rows[1]?.env).toBe('preprod');
    expect(r.rows[1]?.licence).toBe('li');

    const db = parseDatabasesCsv('name,engine,features\nd1,sql server 2019,ssis nonsense\n');
    expect(db.rows[0]?.engine).toBe('other');
    expect(db.rows[0]?.features).toEqual(['ssis']);
    expect(db.findings.filter((f) => f.code === 'plan.csv.unknown-value')).toHaveLength(2);
  });

  it('reports a missing name column, unknown columns, repeats and blank names', () => {
    expect(parseWorkloadsCsv('vm,app\nx,y\n').findings.map((f) => f.code)).toEqual(['plan.csv.no-name-column']);
    const r = parseWorkloadsCsv('Name,RAM GiB,colour\na,4,red\n,2,blue\nA,8,green\n');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.ramGib).toBe(4);
    expect(r.findings.map((f) => f.code).sort()).toEqual(['plan.csv.duplicate-name', 'plan.csv.name-missing', 'plan.csv.unknown-column']);
  });

  it('defaults a database’s size from its host, and proposes app rows', () => {
    const r = intakeFromCsv({ kind: 'databases', text: 'name,engine,hosts,app\nora1,oracle,pay-app-01,Payroll\n', workloads: WORKLOADS });
    expect(r.databases[0]?.vcpu).toBe(4);
    expect(r.databases[0]?.edition).toBe('commercial');
    expect(r.databases[0]?.licence).toBe('oracle-processor');
    expect(r.apps.map((a) => a.name)).toEqual(['Payroll']);
  });
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe('merge', () => {
  const estate = (over: Partial<Workload> = {}): Workload => ({
    id: 'w:web1', name: 'web1', app: 'Web', env: 'prod', role: 'web', os: 'win-2019', vcpu: 2, ramGib: 8, disksGib: [60],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'estate', ...over,
  });

  it('keeps edited cells and refreshes the rest', () => {
    const edited = editRow(estate(), { app: 'Shop', criticality: 'tier0', vcpu: 2 });
    expect(edited.edited).toEqual(['app', 'criticality']);
    const fresh = estate({ app: 'Web', vcpu: 8, facts: { powerState: 'poweredOn' } });
    const [merged, added] = mergeRows([edited], [fresh, estate({ id: 'w:web2', name: 'web2' })], 'merge');
    expect(merged?.app).toBe('Shop');
    expect(merged?.criticality).toBe('tier0');
    expect(merged?.vcpu).toBe(8);
    expect(merged?.facts?.powerState).toBe('poweredOn');
    expect(merged?.edited).toEqual(['app', 'criticality']);
    expect(added?.name).toBe('web2');
    expect(mergeRows([edited], [fresh], 'replace')).toEqual([fresh]);
  });

  it('keeps a cleared optional cell cleared, and a row only in the plan', () => {
    const pinned = editRow(estate({ pin: 'aws' }), { pin: undefined });
    expect('pin' in pinned).toBe(false);
    const manual = estate({ id: 'w:mine', name: 'mine', source: 'manual' });
    const out = mergeRows([pinned, manual], [estate({ pin: 'oci' })], 'merge');
    expect(out[0]?.pin).toBeUndefined();
    expect(out[1]).toBe(manual);
  });

  it('matches names case-insensitively and keeps a confirmed database confirmed', () => {
    const inferred: Database = { ...(DATABASES[1] as Database), inferred: true, source: 'estate', version: 'other' };
    const confirmed = editRow(inferred, { version: 'pg-16' });
    expect(confirmed.inferred).toBe(false);
    const out = mergeRows([confirmed], [{ ...inferred, name: 'PG', vcpu: 16 }], 'merge');
    expect(out).toHaveLength(1);
    expect(out[0]?.version).toBe('pg-16');
    expect(out[0]?.vcpu).toBe(16);
    expect(out[0]?.inferred).toBe(false);
  });

  it('marks database hosts, inherits app criticality, and adds missing apps', () => {
    const w = [estate({ name: 'sqlhost', id: 'w:sqlhost', role: 'app' }), estate({ edited: ['criticality'] })];
    const d: Database[] = [{ ...(DATABASES[0] as Database), hosts: ['SQLHOST'] }];
    expect(applyDbHostRoles(w, d)[0]?.role).toBe('db');
    const apps: App[] = [{ ...(APPS[1] as App), name: 'Web', criticality: 'tier0' }];
    const inherited = applyAppDefaults(w, apps);
    expect(inherited[0]?.criticality).toBe('tier0');
    expect(inherited[0]?.rpo).toBe('0');
    expect(inherited[1]?.criticality).toBe('tier2');
    expect(ensureApps([], w, d).map((a) => a.name)).toEqual(['Web', 'Payroll, EMEA']);
    const all = mergeIntake({ workloads: w, databases: [], apps: [] }, { workloads: [], databases: d, apps: apps, findings: [] }, 'replace');
    expect(all.workloads).toHaveLength(2);
    expect(all.workloads[0]?.role).toBe('db');
  });
});

// ---------------------------------------------------------------------------
// The Migration portfolio
// ---------------------------------------------------------------------------

function entry(name: string, criticality: PortfolioCriticality, route: Route, over: Partial<Evaluation> = {}, draft = false): PortfolioEntry {
  const evaluation = {
    readiness: 72, route, rationale: '', cloud: 'gcp', cloudRationale: '', risk: 'Medium', riskBecause: [], plan: [], services: [], ...over,
  } as Evaluation;
  return {
    id: name.toLowerCase(),
    application: { ...EMPTY_APPLICATION, name, owner: 'Ops', criticality, compliance: ['PCI-DSS'], notes: 'n' },
    evaluation,
    evaluatedAt: `${ON}T00:00:00Z`,
    draft,
  };
}

describe('from the Migration portfolio', () => {
  it('maps criticality and routes one to one', () => {
    const routes: Route[] = ['Rehost', 'Replatform', 'Refactor', 'Repurchase', 'Retain', 'Retire'];
    const crit: [PortfolioCriticality, App['criticality']][] = [['Mission Critical', 'tier0'], ['High', 'tier1'], ['Medium', 'tier2'], ['Low', 'tier3']];
    const entries = crit.map(([c], i) => entry(`App ${i}`, c, routes[i] as Route));
    const apps = appsFromPortfolio(entries);
    expect(apps.map((a) => a.criticality)).toEqual(crit.map(([, t]) => t));
    expect(apps.map((a) => a.route)).toEqual(['rehost', 'replatform', 'refactor', 'repurchase']);
    expect(routes.map((r) => routeFromPortfolio(r))).toEqual(['rehost', 'replatform', 'refactor', 'repurchase', 'retain', 'retire']);
    expect(criticalityFromPortfolio('mission critical')).toBe('tier0');
    expect(criticalityFromPortfolio('Urgent')).toBeUndefined();
    const a0 = apps[0] as App;
    expect(a0.id).toBe('a:app-0');
    expect(a0.owner).toBe('Ops');
    expect(a0.source).toBe('portfolio');
    expect(a0.portfolio).toEqual({ readiness: 72, risk: 'Medium', cloud: 'gcp', compliance: ['PCI-DSS'] });
  });

  it('translates the clouds', () => {
    expect(toMigrationCloud('google')).toBe('gcp');
    expect(toMigrationCloud('aws')).toBe('aws');
    expect(toMigrationCloud('vmware')).toBeUndefined();
    expect(fromMigrationCloud('gcp')).toBe('google');
    expect(fromMigrationCloud('oci')).toBe('oci');
    expect(fromMigrationCloud('ibm')).toBeUndefined();
  });

  it('reports drafts and gates', () => {
    const e = entry('Ledger', 'High', 'Rehost', {}, true);
    const gated: PortfolioEntry = { ...e, application: { ...e.application, gates: { ...e.application.gates, mainframeBound: true, dataSovereigntyRequired: true } } };
    const r = intakeFromPortfolio([gated, entry('ledger', 'Low', 'Retire')]);
    expect(r.apps).toHaveLength(1);
    expect(r.apps[0]?.special).toBe('mainframe-link');
    expect(r.findings.map((f) => f.code)).toEqual([
      'plan.sources.portfolio-loaded', 'plan.sources.portfolio-drafts', 'plan.sources.portfolio-residency', 'plan.sources.duplicate-name',
    ]);
    expect(intakeFromPortfolio([]).findings.map((f) => f.code)).toEqual(['plan.sources.portfolio-empty']);
  });
});

// ---------------------------------------------------------------------------
// validatePlan
// ---------------------------------------------------------------------------

function planWith(over: Partial<Plan>): Plan {
  return { ...emptyPlan('Test', `${ON}T00:00:00Z`), ...over };
}

describe('validatePlan', () => {
  const allIds = new Set(Object.values(PLAN_FINDING_IDS).flat() as string[]);

  it('is clean for a good plan', () => {
    const plan = planWith({ workloads: [WORKLOADS[0] as Workload], databases: [], apps: [APPS[0] as App], requirements: { ...emptyPlan().requirements, sites: [SITES[0] as Site] } });
    const f = validatePlan({ ...plan, workloads: [{ ...(WORKLOADS[0] as Workload), dependsOn: ['site:London'] }] }, ON);
    expect(f.filter((x) => x.severity !== 'info')).toEqual([]);
  });

  it('raises each Workloads check with its row path', () => {
    const base: Workload = { ...(WORKLOADS[0] as Workload), dependsOn: [] };
    const workloads: Workload[] = [
      { ...base, name: 'a', os: 'unknown', licence: 'li' },
      { ...base, name: 'b', disksGib: [10], facts: { provisionedGib: 100 } as IntakeFacts },
      { ...base, name: 'c', dependsOn: ['nowhere', 'site:Mars'] },
      { ...base, name: 'd', pin: 'oci' },
      { ...base, name: 'e', os: 'ubuntu-22.04', licence: 'rhel-byos' },
      { ...base, name: 'f', vcpu: 0, disksGib: [] },
      { ...base, name: 'A' },
      { ...base, name: 'g', env: 'staging' as unknown as Workload['env'] },
    ];
    const req = { ...emptyPlan().requirements, allowed: ['aws', 'azure'] as Plan['requirements']['allowed'] };
    const f = validatePlan(planWith({ workloads, requirements: req, apps: [APPS[0] as App] }), ON);
    const at = (code: string) => f.filter((x) => x.code === code).map((x) => x.path);
    expect(at('plan.workloads.os-unknown')).toEqual(['workloads[0].os']);
    expect(at('plan.workloads.disks-mismatch')).toEqual(['workloads[1].disksGib']);
    expect(at('plan.workloads.dependency-unknown')).toEqual(['workloads[2].dependsOn', 'workloads[2].dependsOn']);
    expect(at('plan.workloads.pin-excluded')).toEqual(['workloads[3].pin']);
    expect(at('plan.workloads.licence-mismatch')).toEqual(['workloads[4].licence']);
    expect(at('plan.workloads.size-invalid')).toEqual(['workloads[5].vcpu']);
    expect(at('plan.workloads.no-disks')).toEqual(['workloads[5].disksGib']);
    expect(at('plan.workloads.duplicate-name')).toEqual(['workloads[6].name']);
    expect(at('plan.workloads.invalid-value')).toEqual(['workloads[7].env']);
    expect(findingsForRow(f, 'workloads', 5).map((x) => x.code)).toEqual(['plan.workloads.size-invalid', 'plan.workloads.no-disks']);
    for (const x of f) expect(allIds.has(x.code)).toBe(true);
  });

  it('raises each Databases check', () => {
    const base = DATABASES[0] as Database;
    const databases: Database[] = [
      { ...base, name: 'se2', engine: 'oracle', edition: 'oracle-se2', version: 'oracle-19c', vcpu: 16, licence: 'oracle-processor', pinService: undefined, features: [] },
      { ...base, name: 'rac', engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', ha: 'rac', hosts: ['pay-app-01'], licence: 'oracle-processor', pinService: undefined },
      { ...base, name: 'old', version: 'sql-2014', hosts: ['pay-app-01'] },
      { ...base, name: 'mix', edition: 'oracle-ee', hosts: ['pay-app-01'], pinService: undefined },
      { ...base, name: 'ver', version: 'pg-16', hosts: ['pay-app-01'] },
      { ...base, name: 'pin', engine: 'postgres', edition: 'community', version: 'pg-16', licence: 'community', pinService: 'azure-sqlmi', hosts: ['ghost'] },
      { ...base, name: 'inf', inferred: true, hosts: [], licence: 'oracle-nup' },
    ];
    const f = validatePlan(planWith({ databases, workloads: [WORKLOADS[0] as Workload], apps: [APPS[0] as App] }), ON);
    const codes = (name: string) => f.filter((x) => x.message.startsWith(`${name}:`) || x.message.startsWith(`${name} `)).map((x) => x.code);
    expect(codes('se2')).toContain('plan.databases.se2-over-cap');
    expect(f.find((x) => x.code === 'plan.databases.se2-over-cap')?.severity).toBe('error');
    expect(codes('rac')).toContain('plan.databases.rac-single-host');
    expect(codes('old')).toEqual(['plan.databases.version-eol']);
    expect(codes('mix')).toEqual(['plan.databases.edition-mismatch']);
    expect(codes('ver')).toEqual(['plan.databases.version-mismatch']);
    expect(codes('pin')).toEqual(['plan.databases.host-unknown', 'plan.databases.pin-service-mismatch']);
    expect(codes('inf')).toEqual(['plan.databases.no-hosts', 'plan.databases.licence-mismatch']);
    expect(f.map((x) => x.code)).toContain('plan.databases.inferred');
    expect(f.some((x) => x.message.startsWith('se2') && x.code === 'plan.databases.version-eol')).toBe(false);
    for (const x of f) expect(allIds.has(x.code)).toBe(true);
  });

  it('raises each Apps and Sources check, and sorts findings by screen', () => {
    const apps: App[] = [
      { ...(APPS[0] as App), wave: 12, deadlineMonths: 40 },
      { ...(APPS[1] as App), deadlineMonths: 0 },
    ];
    const plan = planWith({
      name: ' ',
      workloads: [{ ...(WORKLOADS[0] as Workload), app: 'Billing' }],
      apps,
      edges: [{ from: 'pay-app-01', to: 'nowhere', kind: 'sync' }],
    });
    const f = validatePlan(plan, ON);
    const codes = f.map((x) => x.code);
    for (const c of ['plan.sources.name-empty', 'plan.apps.missing', 'plan.apps.unused', 'plan.apps.wave-invalid', 'plan.apps.deadline-after-timeline', 'plan.apps.deadline-invalid', 'plan.apps.edge-unknown']) {
      expect(codes).toContain(c);
    }
    expect(validatePlan(planWith({}), ON).map((x) => x.code)).toEqual(['plan.sources.empty']);
    expect(validateScreen(plan, 'apps', ON).every((x) => screenOf(x.code) === 'apps')).toBe(true);
    expect(screenOf('plan.csv.unknown-value')).toBe('sources');
    expect(screenOf('plan.workloads.os-unknown')).toBe('workloads');
    expect(screenOf('tf.other')).toBeUndefined();
    for (const x of f) expect(allIds.has(x.code)).toBe(true);
  });
});
