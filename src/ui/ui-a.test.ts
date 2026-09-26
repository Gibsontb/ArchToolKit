/**
 * WP-UI-A: the Application Migration intake panes' pure logic — the " | "
 * grids' conversion to and from the plan's rows (lossless, dropdowns offering
 * exactly the options.ts values), paging and page reconciliation, bulk edits,
 * type confirmation, the Sources imports and their merge summary, the
 * dependency review, and the constraint checks.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  BACKUP_TIER_GRID, BLANK_BACKUP_TIER, BLANK_SITE, DATABASE_GRID, SITE_GRID, WORKLOAD_GRID, afterDatabaseEdit, afterWorkloadEdit,
  applyCells, bulkSet, columnValues, confirmTypes, filterRows, gridText, listFromGrid, listToGrid, newDatabase, newWorkload,
  pageOf, parseGridText, readAddresses, reconcilePage, renameProblem, rowCells, siteProblems, splitGridLine, typeCheckText,
  typesToConfirm, type CellColumn,
} from './multicloud/grid-model.ts';
import {
  SOURCE_FORMATS, acceptReviewed, applyIntake, asReviewEdges, jsonKind, migrationCenterFiles, regroupPlan, reviewText,
  reviewedEdges, summaryText,
} from './multicloud/sources-model.ts';
import { connectivityFindings, constraintFindings, landingZoneState, regionChoices, setLandingZone } from './multicloud/constraints-model.ts';
import { serverGridFindings } from './multicloud/workloads.ts';
import { emptyPlan } from '../multicloud/plan/store.ts';
import {
  CRITICALITY_OPTIONS, DB_ENGINE_OPTIONS, ENV_OPTIONS, IP_STRATEGY_OPTIONS, OS_OPTIONS, OS_UPGRADE_OPTIONS, SIZING_BASIS_OPTIONS,
  SOURCE_PLATFORM_OPTIONS, WORKLOAD_TYPE_OPTIONS, type PlanOption,
} from '../multicloud/plan/options.ts';
import { intakeFromCsv } from '../multicloud/plan/intake/csv.ts';
import {
  intakeFromAhvCsv, intakeFromAwsImport, intakeFromAzureMigrate, intakeFromDiscovery, intakeFromMigrationCenter, intakeFromTier2,
  parseAzureDependencyCsv, proposeEdges as proposeAzureEdges, parsePerfCsv, applyPerf,
} from '../multicloud/plan/intake/sources/index.ts';
import { importFlows, proposeEdges as proposeFlowEdges } from '../multicloud/plan/discovery/flows.ts';
import type { AppPlan, Database, Plan, Workload } from '../multicloud/plan/types.ts';

const ON = '2026-09-26';

const wl = (over: Partial<Workload> = {}): Workload => ({
  id: 'w:app01', name: 'app01', app: 'crm', env: 'prod', role: 'app', os: 'rhel-9', vcpu: 4, ramGib: 16, disksGib: [60, 200],
  criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'rhel-byos', dependsOn: ['db01', 'site:london'], source: 'estate', sourceKey: 'vc|app01',
  facts: { ipAddresses: ['10.1.2.3', '2001:db8::3'] }, ...over,
});

const db = (over: Partial<Database> = {}): Database => ({
  id: 'd:crmdb', name: 'crmdb', engine: 'sqlserver', edition: 'sql-standard', version: 'sql-2019', hosts: ['db01'], vcpu: 8, ramGib: 64, sizeGib: 500,
  ha: 'sql-ag', dr: 'none', features: ['ssis', 'agent-jobs'], licence: 'byol-sa', app: 'crm', source: 'manual', ...over,
});

const plan = (over: Partial<Plan> = {}): Plan => ({ ...emptyPlan('Test', '2026-09-26T00:00:00.000Z'), ...over });

const values = (options: readonly PlanOption[] | undefined): string[] => (options ?? []).map((o) => o.value);
const col = <T>(cols: readonly CellColumn<T>[], key: string): CellColumn<T> => cols.find((c) => c.key === key)!;

// ---------------------------------------------------------------------------
// The grid text
// ---------------------------------------------------------------------------

describe('grid text', () => {
  it('splits on " | " only, so a cell may hold a bare pipe', () => {
    expect(splitGridLine('a | cpu|usage | c', 3)).toEqual(['a', 'cpu|usage', 'c']);
    expect(splitGridLine('a | b', 3)).toEqual(['a', 'b', '']);
  });
  it('round-trips rows, closing a spaced pipe up as the editor does', () => {
    const rows = [['a', 'b c', ''], ['x | y', '1', '2']];
    expect(parseGridText(gridText(rows), 3)).toEqual([['a', 'b c', ''], ['x|y', '1', '2']]);
  });
});

describe('page reconciliation', () => {
  const before = [['a', '1'], ['b', '2'], ['c', '3']];
  it('an edit is an edit of that row', () => {
    expect(reconcilePage(before, [['a', '1'], ['b', '9'], ['c', '3']])).toEqual([{ kind: 'edit', index: 1, cells: ['b', '9'] }]);
  });
  it('a row taken out is a removal of that row', () => {
    expect(reconcilePage(before, [['a', '1'], ['c', '3']])).toEqual([{ kind: 'remove', index: 1 }]);
  });
  it('a new last row is an addition', () => {
    expect(reconcilePage(before, [...before, ['d', '4']])).toEqual([{ kind: 'add', cells: ['d', '4'] }]);
  });
  it('after Edit as text, rows match by position', () => {
    expect(reconcilePage(before, [['z', '1']])).toEqual([{ kind: 'edit', index: 0, cells: ['z', '1'] }, { kind: 'remove', index: 1 }, { kind: 'remove', index: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// The Servers grid
// ---------------------------------------------------------------------------

describe('Servers grid columns', () => {
  it('has the addendum’s columns and the base columns, in order', () => {
    expect(WORKLOAD_GRID.map((c) => c.label)).toEqual([
      'Name', 'App', 'Source', 'Type', 'Type check', 'Env', 'Role', 'OS', 'vCPU', 'RAM GiB', 'Basis', 'Disks GiB', 'IP addresses',
      'IP strategy', 'Rename', 'Upgrade', 'Criticality', 'RPO', 'RTO', 'Licence', 'Residency', 'Disposition', 'Depends on', 'Pin',
    ]);
  });
  it('every dropdown offers exactly the options.ts values (with a blank where blank means something)', () => {
    expect(values(col(WORKLOAD_GRID, 'env').options)).toEqual(values(ENV_OPTIONS));
    expect(values(col(WORKLOAD_GRID, 'os').options)).toEqual(values(OS_OPTIONS));
    expect(values(col(WORKLOAD_GRID, 'criticality').options)).toEqual(values(CRITICALITY_OPTIONS));
    expect(values(col(WORKLOAD_GRID, 'origin').options)).toEqual(['', ...values(SOURCE_PLATFORM_OPTIONS)]);
    expect(values(col(WORKLOAD_GRID, 'workloadType').options)).toEqual(['', ...values(WORKLOAD_TYPE_OPTIONS)]);
    expect(values(col(WORKLOAD_GRID, 'basis').options)).toEqual(['', ...values(SIZING_BASIS_OPTIONS)]);
    expect(values(col(WORKLOAD_GRID, 'ipStrategy').options)).toEqual(['', ...values(IP_STRATEGY_OPTIONS)]);
    expect(values(col(WORKLOAD_GRID, 'upgrade').options)).toEqual(['', ...values(OS_UPGRADE_OPTIONS)]);
    expect(values(col(DATABASE_GRID, 'engine').options)).toEqual(values(DB_ENGINE_OPTIONS));
  });
  it('is lossless: every row’s cells, set back, change nothing', () => {
    const rows = [
      wl(),
      wl({ id: 'w:x', name: 'x', origin: 'hyperv', workloadType: 'sap-hana', typeConfirmed: true, basis: 'utilisation', ipStrategy: 'keep-ip-cloud', rename: 'x-new', upgrade: 'rebuild', residency: 'eu', disposition: 'rehost', pin: 'aws' }),
    ];
    for (const w of rows) {
      const r = applyCells(w, WORKLOAD_GRID, rowCells(w, WORKLOAD_GRID));
      expect(r.row).toBe(w);
      expect(r.errors).toEqual([]);
    }
    for (const d of [db(), db({ id: 'd:y', name: 'y', inferred: true, pinService: 'azure-sqlmi' })]) {
      expect(applyCells(d, DATABASE_GRID, rowCells(d, DATABASE_GRID)).row).toBe(d);
    }
  });
  it('an estate row with no origin shows vSphere', () => {
    expect(rowCells(wl(), WORKLOAD_GRID)[2]).toBe('vsphere');
  });
  it('a picked value is recorded as edited; a value not offered is refused with the reason', () => {
    const cells = rowCells(wl(), WORKLOAD_GRID);
    cells[5] = 'test';
    cells[16] = 'nonsense';
    const r = applyCells(wl(), WORKLOAD_GRID, cells);
    expect(r.row.env).toBe('test');
    expect(r.row.edited).toEqual(['env']);
    expect(r.row.criticality).toBe('tier2');
    expect(r.errors[0]).toContain('Criticality');
  });
  it('IP addresses take both families and refuse anything else; they are facts, not edited cells', () => {
    expect(readAddresses('10.0.0.1 2001:db8::1 fe80::1, nope')).toEqual({ ok: ['10.0.0.1', '2001:db8::1', 'fe80::1'], bad: ['nope'] });
    const cells = rowCells(wl(), WORKLOAD_GRID);
    cells[12] = '10.9.9.9 2001:db8:9::9';
    const r = applyCells(wl(), WORKLOAD_GRID, cells);
    expect(r.row.facts?.ipAddresses).toEqual(['10.9.9.9', '2001:db8:9::9']);
    expect(r.row.edited ?? []).toEqual([]);
    cells[12] = '10.9.9';
    expect(applyCells(wl(), WORKLOAD_GRID, cells).errors[0]).toContain('IP addresses');
  });
  it('Type check shows the confidence until Confirmed; picking a type confirms it', () => {
    const w = wl({ workloadType: 'tomcat', typeConfirmed: false, facts: { detection: { type: 'tomcat', confidence: 0.85, evidence: ['port 8080'] } } });
    expect(typeCheckText(w)).toBe('? 85%');
    const cells = rowCells(w, WORKLOAD_GRID);
    cells[4] = 'confirmed';
    const confirmed = applyCells(w, WORKLOAD_GRID, cells).row;
    expect([confirmed.typeConfirmed, confirmed.workloadType]).toEqual([true, 'tomcat']);
    expect(confirmed.edited).toContain('workloadType');
    expect(typeCheckText(confirmed)).toBe('confirmed');
    const cells2 = rowCells(w, WORKLOAD_GRID);
    cells2[3] = 'jboss';
    const picked = applyCells(w, WORKLOAD_GRID, cells2).row;
    expect([picked.workloadType, picked.typeConfirmed]).toEqual(['jboss', true]);
  });
  it('what follows an edit: id from the name, RPO/RTO from criticality, licence from OS, size from the basis', () => {
    const fresh = newWorkload([]);
    const named = afterWorkloadEdit(fresh, { ...fresh, name: 'web01' }, [fresh]);
    expect([named.id, named.role]).toEqual(['w:web01', 'web']);
    const crit = afterWorkloadEdit(wl(), { ...wl(), criticality: 'tier0', edited: ['criticality'] }, []);
    expect([crit.rpo, crit.rto]).toEqual(['0', '15m']);
    const os = afterWorkloadEdit(wl(), { ...wl(), os: 'win-2022' }, []);
    expect(os.licence).toBe('li');
    const util = { days: 14, samples: 20000, coverage: 0.99, cpuP95Pct: 20, memP95Gib: 6 };
    const base = wl({ origin: 'physical', vcpu: 16, ramGib: 64, facts: { utilisation: util } });
    const sized = afterWorkloadEdit(base, { ...base, basis: 'utilisation', edited: ['basis'] }, []);
    expect([sized.vcpu, sized.ramGib, sized.facts?.nameplate?.cores]).toEqual([Math.ceil(16 * 0.2 * 1.3), 8, 16]);
  });
  it('rename checks: host-name characters, and 15 characters for Windows', () => {
    expect(renameProblem('new-app01', false)).toBeUndefined();
    expect(renameProblem('-bad', false)).toContain('not a valid host name');
    expect(renameProblem('averyverylongwindowsname', true)).toContain('15 characters');
    const f = serverGridFindings([wl({ rename: 'app02' }), wl({ id: 'w:app02', name: 'app02' })]);
    expect(f.map((x) => x.code)).toEqual(['plan.workloads.rename-duplicate']);
  });
});

describe('filters, pages and bulk edits', () => {
  const rows = Array.from({ length: 450 }, (_, i) => wl({ id: `w:s${i}`, name: `s${i}`, app: i % 3 === 0 ? 'crm' : 'erp', env: i % 2 === 0 ? 'prod' : 'dev' }));
  it('filters apply first, then a page window', () => {
    const idx = filterRows(rows, WORKLOAD_GRID, { equals: { app: 'crm', env: 'prod' }, text: '' });
    expect(idx.length).toBe(75);
    const p = pageOf(idx, 0, 50);
    expect([p.indices.length, p.pages, p.indices[0]]).toEqual([50, 2, 0]);
    expect(pageOf(idx, 9, 50).page).toBe(1);
    expect(filterRows(rows, WORKLOAD_GRID, { equals: {}, text: 's44' }).length).toBe(11);
  });
  it('the filter dropdown lists each value with its count', () => {
    expect(columnValues(rows, col(WORKLOAD_GRID, 'env'))).toEqual([{ value: 'dev', label: 'Development (225)' }, { value: 'prod', label: 'Production (225)' }]);
  });
  it('“Set column … to …” sets every filtered row, records the edit and runs what follows', () => {
    const idx = filterRows(rows, WORKLOAD_GRID, { equals: { app: 'crm' }, text: '' });
    const r = bulkSet(rows, idx, WORKLOAD_GRID, 'criticality', 'tier1', afterWorkloadEdit);
    expect(r.changed).toBe(150);
    expect([r.rows[0]!.criticality, r.rows[0]!.rpo, r.rows[0]!.edited]).toEqual(['tier1', '15m', ['criticality']]);
    expect(r.rows[1]!.criticality).toBe('tier2');
    expect(bulkSet(rows, idx, WORKLOAD_GRID, 'env', 'weekly').errors[0]).toContain('Env');
  });
  it('a 5,000-row grid pages its first window quickly', () => {
    const big = Array.from({ length: 5000 }, (_, i) => wl({ id: `w:b${i}`, name: `b${i}` }));
    const t0 = performance.now();
    const idx = filterRows(big, WORKLOAD_GRID, { equals: {}, text: '' });
    const p = pageOf(idx, 0, 200);
    gridText(p.indices.map((i) => rowCells(big[i]!, WORKLOAD_GRID)));
    expect(performance.now() - t0).toBeLessThan(300);
  });
});

describe('type confirmation', () => {
  const rows = [
    wl({ id: 'w:a', name: 'a', workloadType: 'tomcat', typeConfirmed: false, facts: { detection: { type: 'tomcat', confidence: 0.8, evidence: [] } } }),
    wl({ id: 'w:b', name: 'b', workloadType: 'unknown', typeConfirmed: false, facts: { detection: { type: 'unknown', confidence: 0.5, evidence: [] } } }),
    wl({ id: 'w:c', name: 'c', workloadType: 'generic-linux', typeConfirmed: false, facts: { detection: { type: 'generic-linux', confidence: 0, evidence: [] } } }),
  ];
  it('lists detected and unknown types, not the generic ones', () => {
    expect(typesToConfirm(rows).map((x) => x.workload.name)).toEqual(['a', 'b']);
  });
  it('confirms detected types; unknown ones need a type', () => {
    const r = confirmTypes(rows, [0, 1]);
    expect(r.changed).toBe(1);
    expect(r.rows[0]!.typeConfirmed).toBe(true);
    expect(confirmTypes(rows, [1], 'ibm-mq').rows[1]!.workloadType).toBe('ibm-mq');
  });
});

describe('Databases grid', () => {
  it('a new engine brings its own edition and version (not recorded as edited)', () => {
    const cells = rowCells(db(), DATABASE_GRID);
    cells[2] = 'postgres';
    const r = applyCells(db(), DATABASE_GRID, cells).row;
    expect([r.engine, r.edition, r.version]).toEqual(['postgres', 'community', 'pg-11']);
    expect(r.edited).toEqual(['engine']);
  });
  it('features must be on the list; Confirmed confirms a suggestion', () => {
    const cells = rowCells(db({ inferred: true }), DATABASE_GRID);
    cells[11] = 'ssis bogus';
    expect(applyCells(db(), DATABASE_GRID, cells).errors[0]).toContain('bogus');
    const c2 = rowCells(db({ inferred: true }), DATABASE_GRID);
    c2[1] = 'confirmed';
    expect(applyCells(db({ inferred: true }), DATABASE_GRID, c2).row.inferred).toBe(false);
  });
  it('an id follows a typed name', () => {
    const d = newDatabase([]);
    expect(afterDatabaseEdit(d, { ...d, name: 'Ledger DB' }, [d]).id).toBe('d:ledger-db');
  });
});

describe('the small list grids', () => {
  it('sites: IPv4 and IPv6 peers and CIDRs; problems named', () => {
    const text = gridText([['London', '2001:db8::1', '65010', '10.0.0.0/16 2001:db8:100::/48', '1g', 'expressroute', 'LD5'], ['Paris', '10.0.0', '', '10.1.0.0/33', '100m', 'none', '']]);
    const { rows, errors } = listFromGrid(text, SITE_GRID, BLANK_SITE);
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual({ name: 'London', vpnPeer: '2001:db8::1', bgpAsn: 65010, cidrs: ['10.0.0.0/16', '2001:db8:100::/48'], bandwidth: '1g', circuit: 'expressroute', circuitLocation: 'LD5' });
    expect(siteProblems(rows)).toEqual(['Paris: VPN peer “10.0.0” is not an IPv4 or IPv6 address.', 'Paris: “10.1.0.0/33” is not a CIDR (IPv4 or IPv6, as network/prefix).']);
    expect(listFromGrid(listToGrid(rows, SITE_GRID), SITE_GRID, BLANK_SITE).rows).toEqual(rows);
  });
  it('backup tiers read yes / no', () => {
    const { rows } = listFromGrid('gold | 1h | 35 | yes | yes', BACKUP_TIER_GRID, BLANK_BACKUP_TIER);
    expect(rows).toEqual([{ tier: 'gold', frequency: '1h', retentionDays: 35, copyToDr: true, immutable: true }]);
  });
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const envelope = (platform: string, manager: string, servers: object[]) => JSON.stringify({ kind: 'archtoolkit.discovery', v: 1, source: { platform, manager }, collectedAt: '2026-09-20', servers });
const HYPERV = envelope('hyperv', 'hv-cluster-01', [{
  name: 'crm-app01', id: '5c1b', host: 'hv03', kind: 'vm', powerState: 'Running', vcpu: 4, ramGib: 16, firmware: 'efi',
  disks: [{ gib: 127, usedGib: 61.2 }], nics: [{ ipv4: ['10.1.2.3'], ipv6: ['2001:db8::3'] }], os: { raw: 'Windows Server 2019 Datacenter' },
  tags: { app: 'CRM' }, connections: [{ remote: '10.1.2.9', port: 1433, proto: 'tcp', count: 118 }],
}, {
  name: 'crm-db01', id: '5c1c', host: 'hv03', kind: 'vm', powerState: 'Running', vcpu: 8, ramGib: 64, firmware: 'efi',
  disks: [{ gib: 200 }], nics: [{ ipv4: ['10.1.2.9'], ipv6: [] }], os: { raw: 'Windows Server 2019 Datacenter' },
  tags: { app: 'CRM' }, services: ['MSSQLSERVER'], listening: [{ port: 1433, proto: 'tcp', process: 'sqlservr' }],
}]);

describe('Sources: formats', () => {
  it('offers every intake adapter the pane reads, each with a verification where the layout is a provider’s', () => {
    expect(SOURCE_FORMATS.map((f) => f.id)).toEqual(['discovery', 'azure-migrate', 'migration-center', 'aws-import', 'ahv', 'mgn', 'cmf', 'perf', 'azure-dependency']);
    expect(SOURCE_FORMATS.find((f) => f.id === 'ahv')!.verification).toBe('I');
    expect(SOURCE_FORMATS.filter((f) => f.source).every((f) => f.source!.startsWith('https://'))).toBe(true);
  });
  it('tells JSON files apart by kind', () => {
    expect(jsonKind(HYPERV)).toBe('discovery');
    expect(jsonKind('{"kind":"archtoolkit.coupling","v":1}')).toBe('coupling');
    expect(jsonKind('not json')).toBe('unknown');
  });
  it('finds Migration Center’s tables by file name or header', () => {
    const r = migrationCenterFiles([
      { name: 'export-1.csv', text: 'MachineId,MachineName,AllocatedProcessorCoreCount\nvm-1,a,2' },
      { name: 'perfInfo.csv', text: 'MachineId,TimeStamp,CpuUtilizationPercentage\n' },
      { name: 'tags.csv', text: 'MachineId,Key,Value\nvm-1,app,x' },
    ]);
    expect(Object.keys(r.files!).sort()).toEqual(['perfInfo', 'tagInfo', 'vmInfo']);
    expect(migrationCenterFiles([{ name: 'x.csv', text: 'MachineId,Key,Value' }]).problem).toContain('vmInfo');
  });
});

describe('Sources: imports merged into the plan', () => {
  it('collector files: rows added with origin, detection and apps; a second import refreshes and keeps edits', () => {
    const first = applyIntake(plan(), intakeFromDiscovery([HYPERV], { on: ON }), 'merge');
    expect(first.summary.workloads).toEqual({ added: 2, refreshed: 0, total: 2 });
    const app = first.plan.workloads.find((w) => w.name === 'crm-app01')!;
    expect([app.origin, app.app, app.facts?.ipAddresses]).toEqual(['hyperv', 'CRM', ['10.1.2.3', '2001:db8::3']]);
    expect(first.plan.apps.map((a) => a.name)).toEqual(['CRM']);
    // The user edits a cell, then imports again.
    const edited = { ...first.plan, workloads: first.plan.workloads.map((w) => (w.name === 'crm-app01' ? { ...w, env: 'test' as const, edited: ['env' as const] } : w)) };
    const second = applyIntake(edited, intakeFromDiscovery([HYPERV], { on: ON }), 'merge');
    expect(second.summary.workloads).toEqual({ added: 0, refreshed: 2, total: 2 });
    expect(second.plan.workloads.find((w) => w.name === 'crm-app01')!.env).toBe('test');
    expect(summaryText(second.summary)).toContain('2 refreshed (edited cells kept)');
  });
  it('estate-style rows without detection get it on import', () => {
    const csv = 'name,app,env,role,os,vcpu,ram_gib,disks_gib\nweb01,shop,prod,web,rhel-9,2,4,40';
    const r = applyIntake(plan(), intakeFromCsv({ kind: 'workloads', text: csv }), 'merge');
    expect(r.plan.workloads[0]!.facts?.detection).toBeDefined();
  });
  it('every provider format lands rows (samples from the parsers’ fixtures)', () => {
    const az = 'Server name,IP address,Cores,Memory (In MB),OS name,Server type\nfin-db01,10.9.0.10,8,65536,Microsoft Windows Server 2019 Datacenter,Physical';
    const mc = { vmInfo: 'MachineId,MachineName,PrimaryIPAddress,AllocatedProcessorCoreCount,MemoryGiB,OsName,IsPhysical,Source\nvm-001,shop-web01,10.60.0.4,4,16,Ubuntu 22.04,false,VMware vCenter' };
    const aws = 'ExternalId,IPAddress,HostName,CPU.NumberOfLogicalCores,OS.Name,RAM.TotalSizeInMB\nsrv-1,10.70.0.1,pay-app01,16,Red Hat Enterprise Linux 9,32768';
    const ahv = 'VM Name,IP Addresses,Cores,Memory Capacity,Storage,Power State,Categories\nerp-app02,10.3.0.30,4,16 GiB,61.2 GiB / 127 GiB,On,"App: ERP"';
    const mgn = 'mgn:app:name,mgn:wave:name,mgn:server:user-provided-id,mgn:server:platform,mgn:launch:instance-type\nPayments,Wave 3,pay-app02,LINUX,m6i.large';
    const cmf = 'wave_name,app_name,server_name,server_os_family,server_os_version,server_environment,r_type,instanceType\nWave1,Ledger,ledger-db01,windows,Microsoft Windows Server 2019 Datacenter,prod,Rehost,r6i.2xlarge';
    const results = [
      intakeFromAzureMigrate([az], { on: ON }), intakeFromMigrationCenter(mc, { on: ON }), intakeFromAwsImport([aws], { on: ON }),
      intakeFromAhvCsv([ahv], { on: ON }), intakeFromTier2('mgn', [mgn], { on: ON }), intakeFromTier2('cmf', [cmf], { on: ON }),
    ];
    let p = plan();
    for (const r of results) p = applyIntake(p, r, 'merge').plan;
    expect(p.workloads.map((w) => w.name)).toEqual(['fin-db01', 'shop-web01', 'pay-app01', 'erp-app02', 'pay-app02', 'ledger-db01']);
    expect(p.workloads.map((w) => w.origin)).toEqual(['physical', 'vsphere', 'other', 'ahv', 'other', 'other']);
    // Performance series then add utilisation to rows already there.
    const lines = ['host,timestamp,cpu %,mem_gib'];
    for (let i = 0; i < 4 * 288; i++) lines.push(`pay-app01,${1_790_000_000 + i * 300},20,6`);
    const perf = applyPerf(p.workloads, parsePerfCsv(lines.join('\n')));
    expect(perf.workloads.find((w) => w.name === 'pay-app01')!.facts?.utilisation?.days).toBe(4);
  });
  it('replace mode takes the import as it is', () => {
    const one = applyIntake(plan(), intakeFromDiscovery([HYPERV], { on: ON }), 'merge').plan;
    const csv = 'name,app,env,role,os,vcpu,ram_gib,disks_gib\nweb01,shop,prod,web,rhel-9,2,4,40';
    const r = applyIntake(one, intakeFromCsv({ kind: 'workloads', text: csv }), 'replace');
    expect(r.plan.workloads.map((w) => w.name)).toEqual(['web01']);
    expect(r.summary.mode).toBe('replace');
  });
  it('regroup: the rules run again, edited App cells kept', () => {
    const p = plan({
      workloads: [wl({ id: 'w:pay-web01', name: 'pay-web01', app: 'Unassigned' }), wl({ id: 'w:hr-web01', name: 'hr-web01', app: 'People', edited: ['app'] })],
    });
    const r = regroupPlan(p, []);
    expect(r.plan.workloads.map((w) => w.app)).toEqual(['pay', 'People']);
    expect(r.changed).toBe(1);
    expect(r.plan.apps.map((a) => a.name)).toContain('pay');
  });
});

describe('Sources: the dependency review', () => {
  const base = applyIntake(plan(), intakeFromDiscovery([HYPERV], { on: ON }), 'merge').plan;
  it('flows: proposed, reviewed in the grid, and only the ticked ones written', () => {
    const imp = importFlows('source_ip,dest_ip,dest_port,protocol,observations\n10.1.2.3,10.1.2.9,1433,tcp,40\n10.1.2.3,52.1.2.3,443,tcp,3\n');
    const p = proposeFlowEdges(imp.flows, base);
    expect(p.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['crm-app01>crm-db01', 'crm-app01>external:52.1.2.3']);
    const text = reviewText(p.edges);
    expect(parseGridText(text, 8)[0]).toEqual(['crm-app01', 'crm-db01', '1433', 'tcp', '40', '', 'sync', 'no']);
    const ticked = reviewedEdges(p.edges, text.replace(/\| sync \| no/, '| async | yes'));
    expect([ticked[0]!.accept, ticked[0]!.proposedKind, ticked[1]!.accept]).toEqual([true, 'async', false]);
    const r = acceptReviewed(base, ticked);
    expect(r.accepted).toBe(1);
    expect(r.plan.edges).toEqual([{ from: 'crm-app01', to: 'crm-db01', kind: 'async' }]);
    expect(r.plan.workloads.find((w) => w.name === 'crm-app01')!.dependsOn).toContain('crm-db01');
  });
  it('flows with an unknown layout ask for the columns', () => {
    expect(importFlows('a,b,c\n1,2,3\n').missing).toEqual(['sourceIp', 'destIp', 'destPort']);
  });
  it('the Azure dependency export goes through the same review', () => {
    const csv = 'Timeslot,Source server name,Destination server name,Destination IP,Destination process,Destination port\n2026-09-10 00:00,crm-app01,crm-db01,10.1.2.9,sqlservr,1433';
    const deps = parseAzureDependencyCsv(csv).dependencies;
    const e = proposeAzureEdges(deps, base.workloads);
    const edges = asReviewEdges(e.edges.map((x) => ({ from: x.from, to: x.to, port: x.port, kind: x.kind, observations: x.observations })), base.workloads, 'test');
    expect(edges[0]!.fromKind).toBe('workload');
    const r = acceptReviewed(base, edges.map((x) => ({ ...x, accept: true })));
    expect(r.plan.edges).toEqual([{ from: 'crm-app01', to: 'crm-db01', kind: 'sync' }]);
  });
});

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

describe('Constraints', () => {
  it('checks: no platform, government regions, commitments on excluded platforms, missing tiers', () => {
    const base = plan();
    expect(constraintFindings(base).map((f) => [f.code, f.severity])).toEqual([['constraints.region-missing', 'info']]);
    const r = base.requirements;
    const bad = plan({
      requirements: {
        ...r, allowed: ['aws'], sovereignty: 'government-region', regions: { aws: { primary: 'us-east-1' } },
        commitments: [{ platform: 'azure', agreement: 'edp' }], backupTiers: r.backupTiers.filter((t) => t.tier !== 'bronze'),
      },
    });
    expect(constraintFindings(bad).map((f) => f.code)).toEqual([
      'constraints.max-over-allowed', 'constraints.sovereignty-region', 'constraints.commitment-excluded', 'constraints.commitment-platform', 'constraints.backup-tier-missing',
    ]);
    expect(constraintFindings(plan({ requirements: { ...r, allowed: [] } }))[0]!.severity).toBe('error');
    expect(constraintFindings(plan({ requirements: { ...r, allowed: ['aws'], maxPlatforms: 1, sovereignty: 'government-region', regions: { aws: { primary: 'us-gov-west-1' } } } }))).toEqual([]);
  });
  it('connectivity: sites of either family, circuit without a site', () => {
    const r = plan().requirements;
    const f = connectivityFindings({ ...r, connection: 'circuit', sites: [{ name: 'dc1', vpnPeer: '2001:db8::1', cidrs: ['10.0.0.0/8'], bandwidth: '1g', circuit: 'none' }] });
    expect(f.map((x) => x.code)).toEqual(['constraints.connection-no-circuit', 'constraints.site-ipv4-only']);
  });
  it('the landing-zone mode across the application plans', () => {
    const ap = (app: string, landingZone: 'shared' | 'included'): AppPlan => ({ app, origin: 'migrate', status: 'draft', variants: {}, answers: {}, landingZone });
    expect(landingZoneState(plan())).toBe('none');
    const mixed = plan({ appPlans: [ap('a:x', 'shared'), ap('a:y', 'included')] });
    expect(landingZoneState(mixed)).toBe('mixed');
    expect(landingZoneState(setLandingZone(mixed, 'shared'))).toBe('shared');
  });
  it('region choices keep a typed region that is not on the list', () => {
    expect(regionChoices('aws', 'eu-west-1').some((o) => o.value === 'eu-west-1')).toBe(true);
    expect(regionChoices('aws', 'my-region', 'No DR region').slice(0, 2).map((o) => o.value)).toEqual(['', 'my-region']);
  });
});
