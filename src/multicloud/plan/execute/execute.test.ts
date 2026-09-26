/**
 * WP-11a: the path resolver (A.6.1), the source × target matrix (A.3.4),
 * the registry and the execution kit's assembly.
 */

import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import {
  DB_MOVE_PATH_VALUES, defaultExecution, defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId, METHOD_OF_PATH, MOVE_PATH_VALUES, SOURCE_PLATFORM_VALUES,
} from '../options.ts';
import type {
  App, Database, DbServiceId, ExecutionSettings, ItemDecision, Method, Plan, PlanDecision, Platform, ServiceStatusEntry, Site, Workload, WavePlan,
} from '../types.ts';
import { contractViolations, planId8, resourceName, type ExecPath } from './contract.ts';
import { executionKit } from './kit.ts';
import { shScript } from './lib-sh.ts';
import { psScript } from './lib-ps.ts';
import { EXEC_TARGET_VALUES, execTargetOf, matrixCell, SOURCE_TARGET_MATRIX, validPathsFor } from './matrix.ts';
import {
  checkPathOverride, dbPathFor, movePathFor, NO_AUTO_FALLBACK, pathFindings, resolveDbPath, resolveMovePath,
} from './paths.ts';
import { ALL_EXEC_PATHS, createRegistry, PATH_OWNERS, pendingGenerator, type PackageId, type PathGenerator } from './registry.ts';
import { statusEventProblems } from './schema.ts';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function workload(name: string, over: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app: 'shop', env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
  };
}
function database(name: string, over: Partial<Database> = {}): Database {
  return {
    id: itemId('database', name), name, engine: 'postgres', edition: 'community', version: 'pg-16', hosts: [], vcpu: 4, ramGib: 32,
    sizeGib: 200, ha: 'none', dr: 'none', features: [], licence: 'community', app: 'shop', source: 'manual', ...over,
  };
}
function app(name: string, over: Partial<App> = {}): App {
  return { id: itemId('app', name), name, criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', ...over };
}
function dec(id: string, kind: 'workload' | 'database', platform: Platform | undefined, method: Method, over: Partial<ItemDecision> = {}, service?: DbServiceId): ItemDecision {
  const chosen = platform ? { platform, score: 10, hits: [], ...(service ? { service } : {}) } : undefined;
  return {
    id, kind, disposition: method === 'relocate-hcx' ? 'relocate' : method === 'none' ? 'retire' : 'rehost', method,
    options: chosen ? [chosen] : [], ...(chosen ? { chosen } : {}), pinned: false, margin: 5, findings: [], ...over,
  };
}
function planOf(workloads: readonly Workload[], databases: readonly Database[] = [], over: Partial<Plan> = {}, execution: Partial<ExecutionSettings> = {}): Plan {
  return {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'Plan-7f3a9c21-x', name: 'Shop move', savedAt: '2026-09-26T00:00:00.000Z',
    workloads, databases, apps: [app('shop')], edges: [], requirements: defaultRequirements(), designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] }, execution: { ...defaultExecution(), ...execution }, ...over,
  };
}
function decisionOf(items: readonly ItemDecision[]): PlanDecision {
  return { engineVersion: 'test', platforms: [], subsetScores: [], items: Object.fromEntries(items.map((i) => [i.id, i])), findings: [] };
}
/** One workload, one decision: the path. */
function pathOf(w: Workload, platform: Platform | undefined, method: Method, over: Partial<ItemDecision> = {}, plan?: Partial<Plan>, execution?: Partial<ExecutionSettings>) {
  const p = planOf([w], [], plan, execution);
  return resolveMovePath(w, p, decisionOf([dec(w.id, 'workload', platform, method, over)]));
}
const codes = (fs: readonly { code: string }[]): string[] => fs.map((f) => f.code);

// ---------------------------------------------------------------------------
// The server table (A.6.1), one fixture per row
// ---------------------------------------------------------------------------

describe('movePathFor: the A.6.1 server table', () => {
  it('retire: method none, disposition retire', () => {
    expect(pathOf(workload('old01'), undefined, 'none').path).toBe('retire');
  });
  it('retained items have no path', () => {
    const r = pathOf(workload('keep01'), undefined, 'none', { disposition: 'retain' });
    expect(r.path).toBeUndefined();
    expect(r.why).toContain('retained');
  });
  it('vcf-import: relocate to VCF with the source cluster converged as a whole', () => {
    const w = workload('conv01', { sourceRef: { platform: 'vsphere', cluster: 'cl-a' } });
    expect(pathOf(w, 'vmware', 'relocate-hcx', {}, {}, { vcfImportClusters: ['cl-a'] }).path).toBe('vcf-import');
    expect(pathOf(w, 'vmware', 'relocate-hcx').path).toBe('hcx-bulk');
  });
  it('hcx-rav: latency-critical app or tier 0', () => {
    expect(pathOf(workload('t0', { criticality: 'tier0' }), 'azure', 'relocate-hcx').path).toBe('hcx-rav');
    const r = resolveMovePath(workload('lat'), planOf([workload('lat')], [], { apps: [app('shop', { latencyToOnPrem: 'critical' })] }), decisionOf([dec(itemId('workload', 'lat'), 'workload', 'google', 'relocate-hcx')]));
    expect(r.path).toBe('hcx-rav');
    expect(r.alternatives).toEqual(['hcx-vmotion', 'hcx-bulk', 'rebuild']);
  });
  it('hcx-cold: powered off', () => {
    const r = pathOf(workload('off', { facts: { powerState: 'poweredOff' } }), 'oci', 'relocate-hcx');
    expect(r.path).toBe('hcx-cold');
    expect(r.valid).toContain('hcx-bulk');
  });
  it('hcx-bulk: the vSphere default; xvc-vmotion only when both ends are VCF', () => {
    const toVcf = pathOf(workload('w1'), 'vmware', 'relocate-hcx');
    expect(toVcf.path).toBe('hcx-bulk');
    expect(toVcf.target).toBe('vcf');
    expect(toVcf.valid).toContain('xvc-vmotion');
    const toAvs = pathOf(workload('w1'), 'azure', 'relocate-hcx');
    expect(toAvs.target).toBe('vmware-cloud');
    expect(toAvs.valid.includes('xvc-vmotion')).toBe(false);
  });
  it('hcx-osam: KVM or Hyper-V sources to VMware', () => {
    expect(pathOf(workload('hv', { origin: 'hyperv' }), 'vmware', 'relocate-hcx').path).toBe('hcx-osam');
    expect(pathOf(workload('kv', { origin: 'kvm' }), 'aws', 'relocate-hcx').path).toBe('hcx-osam');
  });
  it('replicate to each hyperscaler', () => {
    expect(pathOf(workload('a'), 'aws', 'replicate').path).toBe('aws-mgn');
    expect(pathOf(workload('a'), 'azure', 'replicate').path).toBe('azure-migrate');
    expect(pathOf(workload('a'), 'google', 'replicate').path).toBe('gcp-m2vm');
    expect(pathOf(workload('a'), 'oci', 'replicate').path).toBe('oci-ocm');
    expect(pathOf(workload('ec2', { origin: 'aws' }), 'oci', 'replicate').path).toBe('oci-ocm');
  });
  it('replicate to OCI from another source: rebuild, with exec.oci.source-unsupported', () => {
    const r = pathOf(workload('hv', { origin: 'hyperv' }), 'oci', 'replicate');
    expect(r.path).toBe('rebuild');
    expect(codes(r.findings)).toContain('exec.oci.source-unsupported');
  });
  it('rebuild and managed-db', () => {
    expect(pathOf(workload('r'), 'aws', 'rebuild').path).toBe('rebuild');
    expect(pathOf(workload('d'), 'aws', 'managed-db').path).toBe('with-db');
  });
  it('the method of each path is the provider-style ExecutionMethod, with the current tool name', () => {
    const r = pathOf(workload('a'), 'aws', 'replicate');
    expect(r.method).toBe('aws-transform-mgn');
    expect(r.method).toBe(METHOD_OF_PATH['aws-mgn']);
  });
});

describe('movePathFor: other sources, patterns, new services', () => {
  it('takes the default from the source × target matrix', () => {
    expect(pathOf(workload('hv', { origin: 'hyperv' }), 'azure', 'replicate').path).toBe('azure-migrate-hyperv');
    expect(pathOf(workload('ph', { origin: 'physical' }), 'azure', 'replicate').path).toBe('azure-migrate-agent');
    expect(pathOf(workload('kv', { origin: 'kvm' }), 'google', 'replicate').path).toBe('gcp-image-import');
    expect(pathOf(workload('ph', { origin: 'physical' }), 'vmware', 'replicate').path).toBe('vcf-converter');
    expect(pathOf(workload('az', { origin: 'azure' }), 'google', 'replicate').path).toBe('gcp-m2vm');
  });
  it('non-x86 sources are specialist', () => {
    const r = pathOf(workload('aix', { origin: 'power', os: 'other' }), 'aws', 'replicate');
    expect(r.path).toBe('specialist');
  });
  it('pattern components take the pattern path', () => {
    expect(pathOf(workload('hana', { workloadType: 'sap-hana' }), 'azure', 'replicate').path).toBe('sap-hsr');
    expect(pathOf(workload('node1', { workloadType: 'k8s-node' }), 'aws', 'rebuild').path).toBe('rebuild');
    expect(pathOf(workload('node1', { workloadType: 'k8s-node' }), 'aws', 'replicate').path).toBe('k8s-velero');
    expect(pathOf(workload('fw', { workloadType: 'appliance-f5' }), 'azure', 'replicate').path).toBe('appliance-rebuild');
    expect(pathOf(workload('mbx', { workloadType: 'exchange' }), undefined, 'none', { disposition: 'repurchase' }).path).toBe('saas-exchange');
  });
  it('new services deploy', () => {
    expect(pathOf(workload('api'), 'aws', 'rebuild', { disposition: 'new' }).path).toBe('deploy');
  });
  it('no target: no path, with a finding', () => {
    const r = pathOf(workload('lost'), undefined, 'replicate');
    expect(r.path).toBeUndefined();
    expect(codes(r.findings)).toContain('exec.path.no-target');
  });
  it('an OS the tool does not take falls back to a valid path', () => {
    const r = pathOf(workload('odd', { os: 'other' }), 'aws', 'replicate');
    expect(r.path).toBe('rebuild');
    expect(codes(r.findings)).toContain('exec.path.default-invalid');
  });
});

describe('path overrides', () => {
  it('applies a valid override', () => {
    const w = workload('w1');
    const r = pathOf(w, 'vmware', 'relocate-hcx', {}, {}, { pathOverrides: { [w.id]: 'hcx-vmotion' } });
    expect(r.path).toBe('hcx-vmotion');
    expect(r.overridden).toBe(true);
    expect(r.default).toBe('hcx-bulk');
  });
  it('refuses an override for another source or target, with the reason', () => {
    const w = workload('w1');
    const r = pathOf(w, 'aws', 'replicate', {}, {}, { pathOverrides: { [w.id]: 'hcx-bulk' } });
    expect(r.path).toBe('aws-mgn');
    expect(r.refused?.path).toBe('hcx-bulk');
    expect(r.refused?.reason).toContain('not a path for this item');
    expect(codes(r.findings)).toContain('exec.path.override-refused');
  });
  it('refuses a live migration of a powered-off VM, and a database path on a server', () => {
    const off = workload('off', { facts: { powerState: 'poweredOff' } });
    const r = pathOf(off, 'vmware', 'relocate-hcx', {}, {}, { pathOverrides: { [off.id]: 'hcx-rav' } });
    expect(r.path).toBe('hcx-cold');
    expect(r.refused?.reason).toContain('powered-on');
    const w = workload('w1');
    expect(pathOf(w, 'aws', 'replicate', {}, {}, { pathOverrides: { [w.id]: 'aws-dms' } }).refused?.reason).toContain('database path');
  });
  it('refuses Cross-vCenter vMotion to a VMware service in the cloud', () => {
    const w = workload('w1');
    const plan = planOf([w]);
    const decision = decisionOf([dec(w.id, 'workload', 'azure', 'relocate-hcx')]);
    const check = checkPathOverride(w, plan, decision, 'xvc-vmotion');
    expect(check.ok).toBe(false);
    expect(checkPathOverride(w, plan, decision, 'hcx-vmotion').ok).toBe(true);
    expect(checkPathOverride(w, plan, decision, 'rebuild').ok).toBe(true);
  });
});

describe('path warnings', () => {
  it('warns where the method has no automatic fallback: MGN, HCX RAV, Migrate to VMs, ZDM', () => {
    for (const p of ['aws-mgn', 'hcx-rav', 'gcp-m2vm', 'oracle-zdm-physical'] as const) {
      expect(NO_AUTO_FALLBACK[p]).toBeDefined();
      expect(codes(pathFindings(p, planOf([])))).toContain('exec.path.no-fallback');
    }
    expect(codes(pathFindings('hcx-bulk', planOf([])))).not.toContain('exec.path.no-fallback');
  });
  it('names the tool by its current name: AWS Transform MGN', () => {
    const f = pathFindings('aws-mgn', planOf([]));
    expect(codes(f)).toContain('exec.path.tool-renamed');
    expect(f.find((x) => x.code === 'exec.path.tool-renamed')!.message).toContain('AWS Transform MGN');
  });
  it('warns when a chosen tool is retired or closed to new customers', () => {
    const closed: ServiceStatusEntry = {
      id: 'aws-mgn', platform: 'aws', name: 'AWS Application Migration Service', status: 'closed-to-new-customers', note: 'closed', source: 'https://example.invalid/x',
      verification: 'V-DOC', asOf: '2026-09-26', replacement: 'something else',
    };
    const f = pathFindings('aws-mgn', planOf([]), undefined, { serviceStatus: (id) => (id === 'aws-mgn' ? closed : undefined), shouldWarn: (id) => id === 'aws-mgn' });
    expect(codes(f)).toContain('exec.path.tool-retired');
  });
  it('HCX: underlay minimums and the network extension', () => {
    const slow: Site = { name: 'dc1', cidrs: ['10.0.0.0/16'], bandwidth: '100m', circuit: 'none' };
    const plan = planOf([], [], { requirements: { ...defaultRequirements(), sites: [slow] } });
    const rav = codes(pathFindings('hcx-rav', plan));
    expect(rav).toContain('exec.hcx.underlay');
    expect(rav).toContain('exec.hcx.needs-extension');
    expect(codes(pathFindings('hcx-bulk', plan))).not.toContain('exec.hcx.underlay');
    const extended = planOf([], [], { requirements: { ...defaultRequirements(), sites: [{ ...slow, bandwidth: '1g' }] } }, {
      hcx: { sourceSite: 'a', destSite: 'b', extend: ['pg-app'], mappings: [], windowHours: 2 },
    });
    expect(pathFindings('hcx-rav', extended).filter((f) => f.code.startsWith('exec.hcx.'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Databases (A.6.1 database table)
// ---------------------------------------------------------------------------

function dbPath(db: Database, platform: Platform, service: DbServiceId, hosts: readonly Workload[] = [], hostMethod: Method = 'rebuild', execution: Partial<ExecutionSettings> = {}) {
  const plan = planOf(hosts, [db], {}, execution);
  const decision = decisionOf([
    dec(db.id, 'database', platform, 'managed-db', {}, service),
    ...hosts.map((h) => dec(h.id, 'workload', platform, hostMethod)),
  ]);
  return resolveDbPath(db, plan, decision);
}

describe('dbPathFor', () => {
  const ora = database('ORA', { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', hosts: ['ora01'] });
  const oraHost = workload('ora01', { role: 'db', os: 'ol-8' });
  it('Oracle', () => {
    expect(dbPath(ora, 'oci', 'oci-exacs').path).toBe('oracle-zdm-physical');
    expect(dbPath(ora, 'oci', 'oci-adb').path).toBe('oracle-zdm-logical');
    expect(dbPath(ora, 'aws', 'aws-rds').path).toBe('aws-dms');
    expect(dbPath(ora, 'azure', 'azure-vm', [oraHost], 'rebuild').path).toBe('oracle-dataguard');
    expect(codes(dbPath(ora, 'oci', 'oci-exacs').findings)).toContain('exec.path.no-fallback');
  });
  it('with-vm when the IaaS host is itself replicated or relocated', () => {
    const r = dbPath(ora, 'aws', 'aws-ec2', [oraHost], 'replicate');
    expect(r.path).toBe('with-vm');
    expect(r.valid).toContain('oracle-dataguard');
  });
  it('refuses with-vm when the hosts are rebuilt', () => {
    const r = dbPath(ora, 'azure', 'azure-vm', [oraHost], 'rebuild', { pathOverrides: { [ora.id]: 'with-vm' } });
    expect(r.path).toBe('oracle-dataguard');
    expect(r.refused?.reason).toContain('rebuilt');
  });
  it('SQL Server', () => {
    const sql = (version: Database['version'], ha: Database['ha'] = 'none') => database('SALES', { engine: 'sqlserver', edition: 'sql-enterprise', version, ha, licence: 'byol-sa' });
    expect(dbPath(sql('sql-2019'), 'azure', 'azure-sqlmi').path).toBe('sql-mi-link');
    expect(dbPath(sql('sql-2014'), 'azure', 'azure-sqlmi').path).toBe('sql-mi-lrs');
    expect(codes(dbPath(sql('sql-2016'), 'azure', 'azure-sqlmi').findings)).toContain('exec.db.mi-link-sp3');
    expect(dbPath(sql('sql-2019'), 'azure', 'azure-sqldb').path).toBe('azure-dms');
    expect(dbPath(sql('sql-2019'), 'aws', 'aws-rds').path).toBe('sql-rds-native');
    expect(dbPath(sql('sql-2019'), 'google', 'google-cloudsql').path).toBe('gcp-dms');
    expect(dbPath(sql('sql-2019', 'sql-ag'), 'oci', 'oci-compute').path).toBe('sql-ag-seeding');
    expect(dbPath(sql('sql-2019'), 'oci', 'oci-compute').path).toBe('sql-log-shipping');
  });
  it('PostgreSQL and MySQL', () => {
    const pg = database('PG');
    expect(dbPath(pg, 'aws', 'aws-aurora').path).toBe('aws-dms');
    expect(dbPath(pg, 'azure', 'azure-pg-flex').path).toBe('azure-pg-migration');
    expect(dbPath(pg, 'google', 'google-alloydb').path).toBe('gcp-dms');
    expect(dbPath(pg, 'oci', 'oci-pg').path).toBe('pg-logical');
    const my = database('MY', { engine: 'mysql', version: 'mysql-8.0' });
    expect(dbPath(my, 'aws', 'aws-rds').path).toBe('mysql-replication');
    expect(dbPath(my, 'google', 'google-cloudsql').path).toBe('gcp-dms');
    expect(dbPath(my, 'oci', 'oci-mysql-heatwave').path).toBe('oci-dms');
  });
  it('dbPathFor gives the path alone', () => {
    const pg = database('PG');
    const plan = planOf([], [pg]);
    expect(dbPathFor(pg, plan, decisionOf([dec(pg.id, 'database', 'aws', 'managed-db', {}, 'aws-rds')]))).toBe('aws-dms');
    expect(movePathFor(workload('x'), planOf([workload('x')]), decisionOf([dec(itemId('workload', 'x'), 'workload', 'aws', 'replicate')]))).toBe('aws-mgn');
  });
});

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe('source × target matrix', () => {
  it('covers every source platform and target, with a valid path in every cell', () => {
    for (const s of SOURCE_PLATFORM_VALUES) {
      for (const t of EXEC_TARGET_VALUES) {
        const c = matrixCell(s, t);
        expect(MOVE_PATH_VALUES.includes(c.default)).toBe(true);
        expect(validPathsFor(s, t)).toContain('rebuild');
        for (const a of c.alternatives) expect(MOVE_PATH_VALUES.includes(a)).toBe(true);
      }
    }
    expect(Object.keys(SOURCE_TARGET_MATRIX).sort()).toEqual([...SOURCE_PLATFORM_VALUES].sort());
  });
  it('holds the A.3.4 defaults', () => {
    expect(matrixCell('vsphere', 'aws').default).toBe('aws-mgn');
    expect(matrixCell('hyperv', 'azure').default).toBe('azure-migrate-hyperv');
    expect(matrixCell('hyperv', 'google').default).toBe('gcp-image-import');
    expect(matrixCell('kvm', 'vcf').default).toBe('hcx-osam');
    expect(matrixCell('proxmox', 'vcf').default).toBe('vcf-converter');
    expect(matrixCell('physical', 'google').default).toBe('rebuild');
    expect(matrixCell('aws', 'oci').default).toBe('oci-ocm');
    expect(matrixCell('aws', 'aws').default).toBe('rebuild');
    expect(matrixCell('mainframe', 'azure').default).toBe('specialist');
    expect(matrixCell('ahv', 'vcf').verification).toBe('I');
  });
  it('places relocations onto a hyperscaler in its VMware service', () => {
    expect(execTargetOf('relocate-hcx', 'aws')).toBe('vmware-cloud');
    expect(execTargetOf('replicate', 'aws')).toBe('aws');
    expect(execTargetOf('replicate', 'vmware')).toBe('vcf');
  });
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** A stub path generator (WP-11b/c/d are not written yet). */
function stub(id: string, owner: PackageId, paths: readonly ExecPath[], kind: 'sh' | 'ps' = 'sh'): PathGenerator {
  const file = kind === 'sh' ? `paths/${id}/${id}.sh` : `paths/${id}/${id}.ps1`;
  const shBody = 'if [[ -f "$ATK_STATUS/made-$(atk_name "$id")" ]]; then atk_skip "$id" "already there"; fi\natk_run touch "$ATK_STATUS/made-$(atk_name "$id")"';
  const psBody = '$marker = Join-Path $env:ATK_STATUS_DIR ("made-" + (Get-AtkName -Id $Id))\nif (Test-Path -LiteralPath $marker) { Set-AtkOutcome skipped \'already there\'; return }\nInvoke-AtkStep "create $marker" { New-VMSnapshot -Marker $marker }';
  return {
    id, owner, paths, needs: [{ kind: kind === 'sh' ? 'command' : 'pwsh-module', name: kind === 'sh' ? 'aws' : 'VCF.PowerCLI', why: `the ${id} stub` }],
    entry: () => file,
    files: () => ({
      [file]: kind === 'sh'
        ? shScript({ file, paths, summary: `stub ${id}`, verbs: { prepare: shBody, replicate: shBody, test: shBody, 'test-cleanup': shBody, cutover: shBody, commit: shBody, rollback: shBody, finalize: shBody, status: shBody } })
        : psScript({ file, paths, summary: `stub ${id}`, verbs: { prepare: psBody, replicate: psBody, test: psBody, 'test-cleanup': psBody, cutover: psBody, commit: psBody, rollback: psBody, finalize: psBody, status: psBody } }),
    }),
  };
}

describe('the path registry', () => {
  it('every MovePath and DbMovePath has an owner and a registry slot', () => {
    for (const p of [...MOVE_PATH_VALUES, ...DB_MOVE_PATH_VALUES]) expect(PATH_OWNERS[p]).toBeDefined();
    expect(Object.keys(PATH_OWNERS).sort()).toEqual([...ALL_EXEC_PATHS].sort());
    // Type-level exhaustiveness: this assignment fails to compile if a path is missing.
    const slots: Record<ExecPath, PackageId> = PATH_OWNERS;
    expect(Object.keys(slots).length).toBe(MOVE_PATH_VALUES.length + DB_MOVE_PATH_VALUES.length);
  });
  it('holds the core paths from the start and reports the rest as missing', () => {
    const r = createRegistry();
    for (const p of ['with-db', 'with-vm', 'retire', 'specialist'] as const) expect(r.get(p)?.id).toBe('core');
    expect(r.missing()).toContain('aws-mgn');
    r.register(stub('mgn', 'WP-11c', ['aws-mgn']));
    expect(r.get('aws-mgn')?.id).toBe('mgn');
    expect(r.missing().includes('aws-mgn')).toBe(false);
  });
  it('refuses a path another package owns, and a path another generator has', () => {
    const r = createRegistry();
    expect(() => r.register(stub('hcx', 'WP-11c', ['hcx-bulk']))).toThrow(/WP-11b owns/);
    r.register(stub('hcx', 'WP-11b', ['hcx-bulk', 'hcx-rav']));
    expect(() => r.register(stub('hcx2', 'WP-11b', ['hcx-bulk']))).toThrow(/already generates/);
  });
});

// ---------------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------------

function kitFixture(): { plan: Plan; decision: PlanDecision; waves: WavePlan } {
  const ws = [
    workload('web01', { os: 'win-2022' }),
    workload('app01'),
    workload('hana01', { workloadType: 'sap-hana' }),
    workload('old01'),
    workload('pgvm'),
    workload('lift01', { criticality: 'tier0' }),
  ];
  const pg = database('PG', { hosts: ['pgvm'] });
  const plan = planOf(ws, [pg], { requirements: { ...defaultRequirements(), identity: { ...defaultRequirements().identity, domain: 'corp.example' } } }, {
    dnsZones: [{ zone: 'corp.example', provider: 'route53', zoneId: 'Z1', private: true }],
    lbs: [{ app: 'shop', kind: 'aws-elbv2', pool: 'tg-shop', port: 443 }],
  });
  const decision = decisionOf([
    dec(ws[0]!.id, 'workload', 'aws', 'replicate'),
    dec(ws[1]!.id, 'workload', 'aws', 'rebuild'),
    dec(ws[2]!.id, 'workload', 'aws', 'replicate'),
    dec(ws[3]!.id, 'workload', undefined, 'none'),
    dec(ws[4]!.id, 'workload', 'aws', 'managed-db'),
    dec(ws[5]!.id, 'workload', 'aws', 'relocate-hcx'),
    dec(pg.id, 'database', 'aws', 'managed-db', {}, 'aws-rds'),
  ]);
  const waves: WavePlan = {
    settings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    groups: [
      { id: 'g1', items: [ws[0]!.id, ws[1]!.id, ws[4]!.id, pg.id], why: 'app', wave: 1, method: 'replicate' },
      { id: 'g2', items: [ws[2]!.id, ws[3]!.id, ws[5]!.id], why: 'app', wave: 2, method: 'replicate' },
    ],
    waves: [{ n: 1, groups: ['g1'] }, { n: 2, groups: ['g2'], gates: ['G1', 'G2', 'G3'] }],
    findings: [],
  };
  return { plan, decision, waves };
}
const EMPTY_DESIGN = { platforms: [], findings: [] };

describe('executionKit', () => {
  it('assembles the core files, the manifest and a script per path, delegating to the registered generators', () => {
    const { plan, decision, waves } = kitFixture();
    const registry = createRegistry([stub('mgn', 'WP-11c', ['aws-mgn']), stub('hcx', 'WP-11b', ['hcx-bulk', 'hcx-rav', 'hcx-vmotion'], 'ps'), stub('rebuild', 'WP-11b', ['rebuild'])]);
    const kit = executionKit(plan, decision, EMPTY_DESIGN, waves, undefined, { registry });
    for (const f of ['README.md', 'controller-check.sh', 'lib/atk.sh', 'lib/Atk.psm1', 'status.schema.json', 'manifest/items.json', 'manifest/items.tsv', 'manifest/waves.json', 'hooks/README.md', 'paths/core/core.sh', 'paths/mgn/mgn.sh', 'paths/hcx/hcx.ps1', 'paths/rebuild/rebuild.sh', 'paths/pending/pending.sh']) {
      expect(typeof kit.files[f]).toBe('string');
    }
    const byName = new Map(kit.manifest.items.map((i) => [i.name, i]));
    expect(byName.get('web01')?.path).toBe('aws-mgn');
    expect(byName.get('web01')?.script).toBe('paths/mgn/mgn.sh');
    expect(byName.get('web01')?.method).toBe('aws-transform-mgn');
    expect(byName.get('lift01')?.path).toBe('hcx-rav');
    expect(byName.get('hana01')?.script).toBe('paths/pending/pending.sh');
    expect(byName.get('old01')?.script).toBe('paths/core/core.sh');
    expect(byName.get('pgvm')?.path).toBe('with-db');
    expect(byName.get('PG')?.path).toBe('aws-dms');
    expect(byName.get('web01')?.resource).toBe(resourceName(plan.id, 1, 'web01'));
    expect(byName.get('web01')?.dns[0]).toEqual({ fqdn: 'web01.corp.example', zone: 'corp.example', provider: 'route53', private: true });
    expect(byName.get('web01')?.lb[0]).toEqual({ kind: 'aws-elbv2', pool: 'tg-shop', port: 443 });
    // pending paths: sap-hsr (WP-17) and aws-dms (WP-11d)
    const pending = kit.findings.filter((f) => f.code === 'exec.path.no-generator').map((f) => f.message).join(' ');
    expect(pending).toContain('sap-hsr');
    expect(pending).toContain('aws-dms');
    expect(kit.files['paths/pending/pending.sh']).toContain('WP-11d');
    // warnings: no fallback (MGN, RAV), renamed tool; controller needs from the generators, pwsh for the .ps1
    expect(codes(kit.findings)).toContain('exec.path.no-fallback');
    expect(kit.files['README.md']).toContain('AWS Transform MGN');
    expect(kit.files['controller-check.sh']).toContain("check_pwsh_module 'VCF.PowerCLI'");
    expect(kit.files['controller-check.sh']).toContain("check_command 'pwsh'");
    expect(kit.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
  it('writes the manifest the libraries read: plan id, tsv rows, waves with gates', () => {
    const { plan, decision, waves } = kitFixture();
    const kit = executionKit(plan, decision, EMPTY_DESIGN, waves, undefined, { registry: createRegistry() });
    const tsv = kit.files['manifest/items.tsv']!.trim().split('\n');
    expect(tsv[0]).toBe(`#plan\t${plan.id}\t${planId8(plan.id)}`);
    expect(tsv.slice(2).every((l) => l.split('\t').length === 10)).toBe(true);
    const items = JSON.parse(kit.files['manifest/items.json']!) as { kind: string; planId8: string; items: unknown[] };
    expect(items.kind).toBe('archtoolkit.migration-manifest');
    expect(items.items.length).toBe(tsv.length - 2);
    const w = JSON.parse(kit.files['manifest/waves.json']!) as { waves: { n: number; gates: string[]; items: string[] }[] };
    expect(w.waves.map((x) => x.n)).toEqual([1, 2]);
    expect(w.waves[0]!.gates).toEqual(['G1', 'G2', 'G3', 'G4']);
    expect(w.waves[1]!.gates).toEqual(['G1', 'G2', 'G3']);
    expect(JSON.parse(kit.files['status.schema.json']!).$defs.statusEvent.properties.kind.const).toBe('archtoolkit.migration-status');
  });
  it('is reproducible and keeps the contract in every file', () => {
    const { plan, decision, waves } = kitFixture();
    const registry = createRegistry([stub('mgn', 'WP-11c', ['aws-mgn'])]);
    const a = executionKit(plan, decision, EMPTY_DESIGN, waves, undefined, { registry });
    const b = executionKit(plan, decision, EMPTY_DESIGN, waves, undefined, { registry });
    expect(a.files).toEqual(b.files);
    const violations = Object.entries(a.files).flatMap(([p, t]) => contractViolations(p, t));
    expect(violations).toEqual([]);
  });
  it('reports a generator that writes outside the kit or clashes', () => {
    const { plan, decision, waves } = kitFixture();
    const bad: PathGenerator = { ...stub('mgn', 'WP-11c', ['aws-mgn']), files: () => ({ '../evil.sh': 'x', 'lib/atk.sh': 'not the library' }) };
    const kit = executionKit(plan, decision, EMPTY_DESIGN, waves, undefined, { registry: createRegistry([bad]) });
    expect(codes(kit.findings)).toContain('exec.kit.bad-file');
    expect(codes(kit.findings)).toContain('exec.kit.no-entry');
  });
  it('the pending generator covers any path', () => {
    const g = pendingGenerator(['aws-mgn', 'oracle-rman']);
    expect(g.entry('aws-mgn')).toBe('paths/pending/pending.sh');
    const text = Object.values(g.files([], {} as never))[0]!;
    expect(text).toContain('aws-mgn) printf');
    expect(contractViolations('paths/pending/pending.sh', text)).toEqual([]);
  });
});

describe('deterministic names', () => {
  it('atk-<plan8>-<wave>-<slug>, at most 63 characters, stable', () => {
    expect(planId8('Plan-7f3a9c21-x')).toBe('plan7f3a');
    expect(resourceName('Plan-7f3a9c21-x', 3, 'WEB_01.corp')).toBe('atk-plan7f3a-3-web-01-corp');
    const long = resourceName('p', 12, 'a'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toBe(resourceName('p', 12, 'a'.repeat(80)));
    expect(long).not.toBe(resourceName('p', 12, `${'a'.repeat(79)}b`));
  });
});

describe('status events', () => {
  it('statusEventProblems accepts a valid event and names what is wrong', () => {
    const ok = { kind: 'archtoolkit.migration-status', v: 1, planId: 'p', runId: 'r', at: '2026-09-26T10:00:00Z', wave: 1, item: 'w:a', path: 'aws-mgn', step: 'cutover', outcome: 'started', dryRun: false };
    expect(statusEventProblems(ok)).toEqual([]);
    expect(statusEventProblems({ ...ok, step: 'jump', user: 'bob' })).toEqual(['unknown property user', 'step']);
  });
});
