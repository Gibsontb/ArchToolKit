/**
 * WP-11d: the database path generators (addendum A.6.5–A.6.9), tested through
 * `createRegistry([...GENERATORS])` and `executionKit(..., { registry })`.
 */

import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { expect } from '../../../../testing/expect.ts';
import { defaultExecution, defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../../options.ts';
import type { Database, DbServiceId, ItemDecision, Plan, PlanDecision, Platform, PlatformDesign, TargetDesign, WavePlan, Workload } from '../../types.ts';
import { contractViolations, type ExecPath } from '../contract.ts';
import { executionKit, type ExecutionKit } from '../kit.ts';
import { createRegistry, PATH_OWNERS, type PathGenerator } from '../registry.ts';
import { GENERATORS as CLOUD_DMS } from './cloud-dms.ts';
import { envToken, itemTokens, myReverseSupported, rdsMysqlProcs, rdsMysqlWord } from './common.ts';
import { GENERATORS as OPEN_SOURCE } from './open-source.ts';
import { GENERATORS as ORACLE, zdmPlatformType } from './oracle.ts';
import { GENERATORS as SQLSERVER } from './sqlserver.ts';

const ALL: readonly PathGenerator[] = [...ORACLE, ...SQLSERVER, ...OPEN_SOURCE, ...CLOUD_DMS];

// ---------------------------------------------------------------------------
// Fixture: one database per path (and per target kind where the script branches)
// ---------------------------------------------------------------------------

interface DbCase { readonly name: string; readonly db: Partial<Database>; readonly service: DbServiceId; readonly override?: ExecPath; readonly engineVersion?: string }

const CASES: readonly DbCase[] = [
  { name: 'ORA_PHYS', db: { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', hosts: ['oradb1'] }, service: 'oci-basedb' },
  { name: 'ORA_EXA', db: { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c' }, service: 'azure-odb-exadata' },
  { name: 'ORA_DG', db: { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', hosts: ['oradb1'] }, service: 'oci-basedb', override: 'oracle-dataguard' },
  { name: 'ORA_RMAN', db: { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c' }, service: 'oci-basedb', override: 'oracle-rman' },
  { name: 'ORA_ADB', db: { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c' }, service: 'oci-adb' },
  { name: 'ORA_ODMS', db: { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c' }, service: 'oci-adb', override: 'oci-dms' },
  { name: 'ORA_DP', db: { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c' }, service: 'oci-adb', override: 'oracle-datapump' },
  { name: 'ORA_RDS', db: { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c' }, service: 'aws-rds' },
  { name: 'SQL_AG', db: { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2019', ha: 'sql-ag', hosts: ['sqlsrv1'] }, service: 'azure-vm' },
  { name: 'SQL_LS', db: { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2019', hosts: ['sqlsrv1'] }, service: 'azure-vm' },
  { name: 'SQL_URL', db: { engine: 'sqlserver', edition: 'sql-standard', version: 'sql-2022' }, service: 'azure-vm', override: 'sql-backup-url' },
  { name: 'SQL_MI', db: { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2019' }, service: 'azure-sqlmi' },
  { name: 'SQL_MI22', db: { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2022' }, service: 'azure-sqlmi' },
  { name: 'SQL_LRS', db: { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2014' }, service: 'azure-sqlmi' },
  { name: 'SQL_DB', db: { engine: 'sqlserver', edition: 'sql-standard', version: 'sql-2019' }, service: 'azure-sqldb' },
  { name: 'SQL_RDS', db: { engine: 'sqlserver', edition: 'sql-standard', version: 'sql-2019' }, service: 'aws-rds' },
  { name: 'SQL_GCP', db: { engine: 'sqlserver', edition: 'sql-standard', version: 'sql-2019' }, service: 'google-cloudsql' },
  { name: 'PG_AZ', db: { engine: 'postgres', version: 'pg-16', hosts: ['pgsrv1'] }, service: 'azure-pg-flex' },
  { name: 'PG_OCI', db: { engine: 'postgres', version: 'pg-16', hosts: ['pgsrv1'] }, service: 'oci-pg' },
  { name: 'PG_DUMP', db: { engine: 'postgres', version: 'pg-15' }, service: 'oci-pg', override: 'pg-dump' },
  { name: 'PG_GCP', db: { engine: 'postgres', version: 'pg-16' }, service: 'google-cloudsql' },
  { name: 'PG_AWS', db: { engine: 'postgres', version: 'pg-16' }, service: 'aws-aurora' },
  { name: 'MY84', db: { engine: 'mysql', version: 'mysql-8.0', hosts: ['mysrv1'] }, service: 'aws-rds', engineVersion: '8.4.3' },
  { name: 'MY80', db: { engine: 'mysql', version: 'mysql-8.0' }, service: 'aws-rds', engineVersion: '8.0.39' },
  { name: 'MY_AZ', db: { engine: 'mysql', version: 'mysql-8.0' }, service: 'azure-mysql-flex' },
  { name: 'MY_DUMP', db: { engine: 'mysql', version: 'mysql-8.0' }, service: 'azure-mysql-flex', override: 'mysql-dump' },
  { name: 'MY_HW', db: { engine: 'mysql', version: 'mysql-8.0' }, service: 'oci-mysql-heatwave' },
  { name: 'MY_GCP', db: { engine: 'mysql', version: 'mysql-8.0' }, service: 'google-cloudsql' },
  { name: 'MARIA_RDS', db: { engine: 'mariadb', version: 'mariadb-10.11' }, service: 'aws-rds' },
  { name: 'MONGO_DOC', db: { engine: 'mongodb', version: 'other' }, service: 'aws-docdb' },
];

const platformOf = (s: DbServiceId): Platform => (s.startsWith('aws') ? 'aws' : s.startsWith('azure') ? 'azure' : s.startsWith('google') ? 'google' : s.startsWith('oci') ? 'oci' : 'vmware');

function workload(name: string): Workload {
  return {
    id: itemId('workload', name), name, app: 'shop', env: 'prod', role: 'db', os: 'rhel-9', vcpu: 4, ramGib: 32, disksGib: [200],
    criticality: 'tier1', rpo: '15m', rto: '1h', licence: 'li', dependsOn: [], source: 'manual',
  };
}
function database(c: DbCase): Database {
  return {
    id: itemId('database', c.name), name: c.name, engine: 'postgres', edition: 'community', version: 'pg-16', hosts: [], vcpu: 4, ramGib: 32,
    sizeGib: 200, ha: 'none', dr: 'none', features: [], licence: 'community', app: 'shop', source: 'manual', ...c.db,
  };
}
function dec(id: string, kind: 'workload' | 'database', platform: Platform, service?: DbServiceId): ItemDecision {
  const chosen = { platform, score: 10, hits: [], ...(service ? { service } : {}) };
  return { id, kind, disposition: 'rehost', method: 'managed-db', options: [chosen], chosen, pinned: false, margin: 5, findings: [] };
}

function fixture(cases: readonly DbCase[] = CASES): { plan: Plan; decision: PlanDecision; design: TargetDesign; waves: WavePlan } {
  const hosts = [...new Set(cases.flatMap((c) => c.db.hosts ?? []))].map(workload);
  const dbs = cases.map(database);
  const overrides = Object.fromEntries(cases.filter((c) => c.override).map((c) => [itemId('database', c.name), c.override!]));
  const plan: Plan = {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'Plan-db11d-x', name: 'DB move', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: hosts, databases: dbs, apps: [{ id: itemId('app', 'shop'), name: 'shop', criticality: 'tier1', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none' }],
    edges: [], requirements: defaultRequirements(), designOverrides: {}, waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    execution: { ...defaultExecution(), pathOverrides: overrides },
  } as Plan;
  const decision: PlanDecision = {
    engineVersion: 'test', platforms: [], subsetScores: [], findings: [],
    items: Object.fromEntries([
      ...hosts.map((w) => dec(w.id, 'workload', 'azure')),
      ...cases.map((c) => dec(itemId('database', c.name), 'database', platformOf(c.service), c.service)),
    ].map((d) => [d.id, d])),
  };
  const platforms = [...new Set(cases.map((c) => platformOf(c.service)))].map((p) => ({
    platform: p, region: p === 'aws' ? 'eu-west-1' : p === 'azure' ? 'westeurope' : p === 'google' ? 'europe-west1' : 'eu-frankfurt-1',
    compute: [], databases: cases.filter((c) => platformOf(c.service) === p).map((c) => ({
      database: itemId('database', c.name), service: c.service, classOrShape: 'x', storageGib: 200, ha: 'none', licenceModel: 'li', backupTier: 'standard',
      engineVersion: c.engineVersion ?? '',
    })),
  })) as unknown as PlatformDesign[];
  const ids = [...hosts.map((w) => w.id), ...dbs.map((d) => d.id)];
  const waves = {
    settings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    groups: [{ id: 'g1', items: ids, why: 'app', wave: 1, method: 'managed-db' }],
    waves: [{ n: 1, groups: ['g1'] }],
    findings: [],
  } as unknown as WavePlan;
  return { plan, decision, design: { platforms, findings: [] }, waves };
}

let cached: ExecutionKit | undefined;
function kit(): ExecutionKit {
  if (!cached) {
    const { plan, decision, design, waves } = fixture();
    cached = executionKit(plan, decision, design, waves, undefined, { registry: createRegistry(ALL) });
  }
  return cached;
}
const itemOf = (name: string) => kit().manifest.items.find((i) => i.name === name)!;
const fileOf = (name: string): string => kit().files[itemOf(name).script!]!;
const codes = (fs: readonly { code: string }[]): string[] => fs.map((f) => f.code);

/** The body of a verb: `verb_<v>() { ... }` in bash, `'<v>' = { ... }` in PowerShell. */
function verbBody(text: string, verb: string): string {
  const sh = new RegExp(`^verb_${verb.replace(/-/g, '_')}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`, 'm').exec(text);
  if (sh) return sh[1]!;
  const ps = new RegExp(`^  '${verb}' = \\{\\n([\\s\\S]*?)\\n  \\}`, 'm').exec(text);
  return ps ? ps[1]! : '';
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('WP-11d generators in the registry', () => {
  it('cover exactly the paths PATH_OWNERS gives WP-11d, once each', () => {
    const owned = (Object.keys(PATH_OWNERS) as ExecPath[]).filter((p) => PATH_OWNERS[p] === 'WP-11d').sort();
    const mine = ALL.flatMap((g) => g.paths).slice().sort();
    expect(mine).toEqual(owned);
    const registry = createRegistry(ALL);
    for (const p of owned) expect(registry.get(p)?.owner).toBe('WP-11d');
    expect(registry.missing().filter((p) => PATH_OWNERS[p] === 'WP-11d')).toEqual([]);
    for (const g of ALL) expect(g.owner).toBe('WP-11d');
  });
  it('every module exports GENERATORS', () => {
    for (const list of [ORACLE, SQLSERVER, OPEN_SOURCE, CLOUD_DMS]) expect(list.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------------

describe('the database scripts in the execution kit', () => {
  it('give every database a WP-11d script, with no generator missing and no error', () => {
    const k = kit();
    const dbs = k.manifest.items.filter((i) => i.kind === 'database');
    expect(dbs.length).toBe(CASES.length);
    for (const i of dbs) {
      expect(i.script!.startsWith('paths/db/')).toBe(true);
      expect(typeof k.files[i.script!]).toBe('string');
    }
    expect(codes(k.findings).includes('exec.path.no-generator')).toBe(false);
    expect(k.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
  it('resolve each case to the path the fixture intends', () => {
    const want: Record<string, string> = {
      ORA_PHYS: 'oracle-zdm-physical', ORA_EXA: 'oracle-zdm-physical', ORA_DG: 'oracle-dataguard', ORA_RMAN: 'oracle-rman', ORA_ADB: 'oracle-zdm-logical',
      ORA_ODMS: 'oci-dms', ORA_DP: 'oracle-datapump', ORA_RDS: 'aws-dms', SQL_AG: 'sql-ag-seeding', SQL_LS: 'sql-log-shipping', SQL_URL: 'sql-backup-url',
      SQL_MI: 'sql-mi-link', SQL_MI22: 'sql-mi-link', SQL_LRS: 'sql-mi-lrs', SQL_DB: 'azure-dms', SQL_RDS: 'sql-rds-native', SQL_GCP: 'gcp-dms',
      PG_AZ: 'azure-pg-migration', PG_OCI: 'pg-logical', PG_DUMP: 'pg-dump', PG_GCP: 'gcp-dms', PG_AWS: 'aws-dms', MY84: 'mysql-replication',
      MY80: 'mysql-replication', MY_AZ: 'mysql-replication', MY_DUMP: 'mysql-dump', MY_HW: 'oci-dms', MY_GCP: 'gcp-dms', MARIA_RDS: 'mysql-replication', MONGO_DOC: 'aws-dms',
    };
    for (const [name, path] of Object.entries(want)) expect(`${name} ${itemOf(name).path}`).toBe(`${name} ${path}`);
  });
  it('keep the contract in every file (contractViolations over every generated file)', () => {
    const k = kit();
    const violations = Object.entries(k.files).flatMap(([p, t]) => contractViolations(p, t));
    expect(violations).toEqual([]);
    const dbFiles = Object.keys(k.files).filter((f) => f.startsWith('paths/db/') || f.startsWith('ansible/db-oracle'));
    expect(dbFiles.length).toBeGreaterThan(20);
  });
  it('emit prepare, replicate, cutover, rollback and finalize for every database path', () => {
    const k = kit();
    const scripts = new Set(k.manifest.items.filter((i) => i.kind === 'database').map((i) => i.script!));
    for (const s of scripts) {
      for (const v of ['prepare', 'replicate', 'cutover', 'rollback', 'finalize', 'status', 'commit', 'test', 'test-cleanup']) {
        const body = verbBody(k.files[s]!, v);
        expect(`${s} ${v} ${body.trim().length > 0}`).toBe(`${s} ${v} true`);
      }
      // cutover and rollback do real work on every path (never the shared test skip)
      for (const v of ['prepare', 'cutover', 'rollback']) expect(`${s} ${v} ${/db_skip_test|Skip-DbTest/.test(verbBody(k.files[s]!, v))}`).toBe(`${s} ${v} false`);
      // the test verbs use the skip of the script's own language
      const skip = s.endsWith('.ps1') ? 'Skip-DbTest' : 'db_skip_test "$id"';
      expect(`${s} ${verbBody(k.files[s]!, 'test').trim().split('\n').pop()!.trim()}`).toBe(`${s} ${skip}`);
    }
  });
  it('is reproducible and carries no footprint', () => {
    const { plan, decision, design, waves } = fixture();
    const a = executionKit(plan, decision, design, waves, undefined, { registry: createRegistry(ALL) });
    const b = executionKit(plan, decision, design, waves, undefined, { registry: createRegistry(ALL) });
    expect(a.files).toEqual(b.files);
  });
  it('declares what the controller needs', () => {
    const cc = kit().files['controller-check.sh']!;
    for (const n of ['psql', 'mysqlsh', 'aws', 'gcloud', 'oci', 'sqlplus', 'ansible-playbook', 'jq']) expect(cc).toContain(`check_command '${n}'`);
    for (const m of ['dbatools', 'Az.Sql', 'Az.DataMigration']) expect(cc).toContain(`check_pwsh_module '${m}'`);
  });
});

// ---------------------------------------------------------------------------
// Reverse replication at cutover
// ---------------------------------------------------------------------------

describe('reverse replication is set up in cutover', () => {
  it('PostgreSQL (pg-logical, the Azure migration service, the DMS paths): the target publishes, the source subscribes with copy_data = false', () => {
    for (const name of ['PG_OCI', 'PG_AZ']) expect(verbBody(fileOf(name), 'cutover')).toContain('pg_reverse "$id"');
    expect(verbBody(fileOf('PG_AWS'), 'cutover')).toContain('dms_reverse "$id"');
    expect(verbBody(fileOf('PG_GCP'), 'cutover')).toContain('gdms_reverse "$id"');
    const pg = fileOf('PG_OCI');
    expect(pg).toContain('pg_subscribe "$id" src "$name" false');
    expect(pg).toContain('WITH (copy_data = $copy)');
    // the rollback waits for the reverse lag, carries the sequences back and detaches the source
    expect(verbBody(pg, 'rollback')).toContain('pg_reverse_rollback "$id"');
    expect(pg).toContain('pg_sync_sequences "$id" tgt src');
  });
  it('MySQL: the source replicates from the target where the service exposes binlogs, and is made read-only', () => {
    const my = fileOf('MY84');
    expect(verbBody(my, 'cutover')).toContain('my_reverse "$id"');
    expect(my).toContain('point the source at the target (reverse replication)');
    expect(my).toContain("SET GLOBAL super_read_only = ON;");
    expect(my).toContain("CALL mysql.rds_set_configuration('binlog retention hours', 24);");
    // after a tool's copy (DMS), the reverse starts from the target's binlog position, not by GTID
    expect(fileOf('PG_AWS')).toContain('my_reverse "$1" pos');
    expect(myReverseSupported('mysql', 'rds')).toBe(true);
    expect(myReverseSupported('mysql', 'heatwave')).toBe(false);
    expect(myReverseSupported('mariadb', 'azure')).toBe(false);
  });
  it('log shipping: tail-log WITH NORECOVERY, recovery, then reverse log shipping target to source with no new full backup', () => {
    const ls = fileOf('SQL_LS');
    const cut = verbBody(ls, 'cutover');
    expect(cut).toContain('Move-DbLsTail -Id $Id -From src -To tgt');
    expect(cut).toContain('Invoke-DbaDbLogShipping -SourceSqlInstance $tgt -DestinationSqlInstance $src');
    expect(cut).toContain('-NoInitialization');
    expect(ls).toContain('WITH NORECOVERY, INIT, CHECKSUM');
    expect(verbBody(ls, 'rollback')).toContain('Move-DbLsTail -Id $Id -From tgt -To src');
  });
  it('paths with no way back say so', () => {
    const f = kit().findings;
    const noReverse = f.filter((x) => x.code === 'exec.db.no-reverse').map((x) => x.path);
    for (const name of ['PG_DUMP', 'MY_DUMP', 'SQL_URL', 'SQL_LRS', 'SQL_RDS', 'SQL_DB', 'ORA_ADB', 'ORA_DP', 'ORA_RMAN', 'ORA_ODMS', 'MY_HW', 'MONGO_DOC', 'SQL_MI']) {
      expect(`${name} ${noReverse.includes(itemOf(name).id)}`).toBe(`${name} true`);
    }
    for (const name of ['PG_OCI', 'MY84', 'SQL_LS', 'SQL_AG', 'SQL_MI22']) expect(`${name} ${noReverse.includes(itemOf(name).id)}`).toBe(`${name} false`);
  });
});

// ---------------------------------------------------------------------------
// RDS for MySQL procedures by version
// ---------------------------------------------------------------------------

describe('the RDS for MySQL replication procedures switch by version', () => {
  it('_source on 8.4, _master on 8.0', () => {
    expect(rdsMysqlWord('8.4.3')).toBe('source');
    expect(rdsMysqlWord('8.4')).toBe('source');
    expect(rdsMysqlWord('9.1.0')).toBe('source');
    expect(rdsMysqlWord('8.0.39')).toBe('master');
    expect(rdsMysqlWord('5.7.44')).toBe('master');
    expect(rdsMysqlProcs('8.4.3')).toEqual({ set: 'mysql.rds_set_external_source_with_auto_position', reset: 'mysql.rds_reset_external_source', start: 'mysql.rds_start_replication', stop: 'mysql.rds_stop_replication' });
    expect(rdsMysqlProcs('8.0.39').set).toBe('mysql.rds_set_external_master_with_auto_position');
    expect(rdsMysqlProcs('8.0.39').reset).toBe('mysql.rds_reset_external_master');
  });
  it('the script carries the planned procedure per database and re-reads the target version at run time', () => {
    const my = fileOf('MY84');
    expect(my).toContain(`['${itemOf('MY84').id}|rds_set_proc']='mysql.rds_set_external_source_with_auto_position'`);
    expect(my).toContain(`['${itemOf('MY80').id}|rds_set_proc']='mysql.rds_set_external_master_with_auto_position'`);
    expect(my).toContain('CALL mysql.rds_set_external_%s_with_auto_position(');
    expect(my).toContain('CALL mysql.rds_reset_external_%s;');
  });
  it('my_rds_word picks the word from the version, in bash', { skip: !hasBash() }, () => {
    const fn = /^my_rds_word\(\) \{[\s\S]*?\n\}/m.exec(fileOf('MY84'))![0];
    const run = (answer: string, planned: string): string => {
      const script = `set -euo pipefail\nmy_version() { if [[ -n "${answer}" ]]; then printf '%s' "${answer}"; else return 1; fi; }\ndb_get() { printf '%s' "${planned}"; }\n${fn}\nmy_rds_word x`;
      return runBash(script);
    };
    expect(run('8.4.3', '8.0.39')).toBe('source');
    expect(run('8.0.39', '8.4.3')).toBe('master');
    expect(run('', '8.4.3')).toBe('source');
    expect(run('', '8.0.36')).toBe('master');
    expect(run('10.11.6-MariaDB', '')).toBe('master');
  });
});

// ---------------------------------------------------------------------------
// Secrets reach the tools only through the environment or stdin
// ---------------------------------------------------------------------------

/** Tools that would show an argument in the process list. */
const TOOLS = /\b(psql|pg_dump|pg_restore|mysql|mysqlsh|mysqldump|mariadb-dump|sqlplus|sqlcmd|aws|az|gcloud|oci|zdmcli|ansible-playbook|curl|jq)\b/g;
/** Variables that hold a secret in the bash scripts. */
const SH_SECRET = /\$\{?(pw|spw|tpw|_PG_PW|_MY_PW|_MS_PW|ATK_AZPG_SRC_PW|ATK_AZPG_TGT_PW|next|cur|gpw)\b/g;

function runBash(script: string): string {
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}
function hasBash(): boolean {
  try { runBash('exit 0'); return true; } catch { return false; }
}

describe('secrets reach tools only through the environment or stdin', () => {
  it('no bash line passes a secret as an argument to a tool (a grep over the rendered scripts)', () => {
    const k = kit();
    const bad: string[] = [];
    for (const [file, text] of Object.entries(k.files)) {
      if (!file.startsWith('paths/db/') || !file.endsWith('.sh')) continue;
      text.split('\n').forEach((line, n) => {
        if (/^\s*#/.test(line)) return;
        const secrets = [...line.matchAll(SH_SECRET)].map((m) => m.index!);
        if (!secrets.length) return;
        for (const t of line.matchAll(TOOLS)) {
          // the tool name inside a function name or a message is not a call
          if (/[-_]$/.test(line.slice(0, t.index!)) || /^[-_]/.test(line.slice(t.index! + t[0].length))) continue;
          for (const s of secrets) {
            if (s < t.index!) continue;
            const between = line.slice(t.index!, s);
            // allowed: an option file on an unnamed pipe
            if (/<\(my_cnf "?$/.test(between) || /--defaults-extra-file=<\(my_cnf\s+"?$/.test(between)) continue;
            bad.push(`${file}:${n + 1}: ${line.trim().slice(0, 120)}`);
          }
        }
      });
    }
    expect(bad).toEqual([]);
  });
  it('passwords go in PGPASSWORD / SQLCMDPASSWORD, an option file on a pipe, stdin or a jq environment variable', () => {
    const pg = fileOf('PG_OCI');
    expect(pg).toContain('PGPASSWORD="$_PG_PW"');
    expect(pg).toContain("printf '%s\\n' \"$4\" | PGPASSWORD=\"$_PG_PW\"");
    const my = fileOf('MY84');
    expect(my).toContain('--defaults-extra-file=<(my_cnf "$_MY_PW")');
    expect(my).toContain('--passwords-from-stdin');
    const dms = fileOf('PG_AWS');
    expect(dms).toContain('ATK_DMS_PW="$pw" jq -cn');
    expect(dms).toContain('--cli-input-json file:///dev/stdin');
    expect(dms).toContain('SQLCMDPASSWORD="$_MS_PW"');
    // the one file the contract allows: a mode-600 runtime file removed at exit
    expect(fileOf('PG_AZ')).toContain('atk_tmpfile props');
    // no password flags anywhere
    for (const [file, text] of Object.entries(kit().files)) {
      if (!file.startsWith('paths/db/')) continue;
      expect(`${file} ${/\s--password[= ]|\s-p"\$|-SourcePassword\s+\$plain|-Password\s+\$plain/.test(text)}`).toBe(`${file} false`);
    }
  });
  it('PowerShell passes SQL logins as in-memory PSCredentials and secrets as SecureStrings, never to an external command', () => {
    const k = kit();
    for (const [file, text] of Object.entries(k.files)) {
      if (!file.startsWith('paths/db/') || !file.endsWith('.ps1')) continue;
      for (const line of text.split('\n')) {
        if (/^\s*&\s/.test(line) || /\s&\s+(aws|az|sqlcmd)\b/.test(line)) expect(`${file}: ${/\$(plain|sas|mk|key|pw)\b/.test(line)}`).toBe(`${file}: false`);
      }
    }
    expect(k.files['paths/db/sql-ag-seeding.ps1']).toContain('[pscredential]::new($User, (ConvertTo-SecureString -String $plain -AsPlainText -Force))');
    expect(k.files['paths/db/sql-backup-url.ps1']).toContain('-SecurePassword (ConvertTo-SecureString -String $plain -AsPlainText -Force)');
  });
  it('the generated tree holds no credential value and names the credentials only', () => {
    const k = kit();
    const readme = k.files['paths/db/README-open-source.md']!;
    expect(readme).toContain('`SRC_DB_PASSWORD_PG_OCI`');
    expect(readme).toContain('`REPL_DB_PASSWORD_PG_OCI`');
    for (const [file, text] of Object.entries(k.files)) {
      expect(`${file} ${/-----BEGIN|AKIA[0-9A-Z]{16}/.test(text)}`).toBe(`${file} false`);
    }
  });
});

// ---------------------------------------------------------------------------
// ZDM
// ---------------------------------------------------------------------------

describe('Zero Downtime Migration', () => {
  it('writes a response file per database, physical and logical, with no credential', () => {
    const phys = kit().files[`paths/db/zdm/${itemOf('ORA_PHYS').resource}.rsp`]!;
    for (const l of ['MIGRATION_METHOD=ONLINE_PHYSICAL', 'DATA_TRANSFER_MEDIUM=DIRECT', 'ZDM_RMAN_DIRECT_METHOD=RESTORE_FROM_SERVICE', 'PLATFORM_TYPE=VMDB', 'SKIP_FALLBACK=FALSE', 'SHUTDOWN_SRC=FALSE', 'TGT_DB_UNIQUE_NAME={{tgt_unique}}']) {
      expect(phys).toContain(l);
    }
    expect(kit().files[`paths/db/zdm/${itemOf('ORA_EXA').resource}.rsp`]).toContain('PLATFORM_TYPE=EXACS');
    const logical = kit().files[`paths/db/zdm/${itemOf('ORA_ADB').resource}.rsp`]!;
    expect(logical).toContain('MIGRATION_METHOD=ONLINE_LOGICAL');
    expect(logical).toContain('TARGETDATABASE_OCID={{target_ocid}}');
    expect(/PASSWORD/i.test(logical.replace(/^#.*$/gm, ''))).toBe(false);
    expect(zdmPlatformType('google-odb-basedb')).toBe('VMDB');
    expect(zdmPlatformType('aws-odb-exadata')).toBe('EXACS');
  });
  it('raises the no-automatic-fallback warning, and the script says it at cutover and rollback', () => {
    const f = kit().findings;
    const fallback = f.filter((x) => x.code === 'exec.path.no-fallback').map((x) => x.message).join(' ');
    expect(fallback).toContain('Zero Downtime Migration does not handle reverse role switches');
    expect(fallback).toContain('Zero Downtime Migration (logical)');
    expect(codes(f)).toContain('exec.db.zdm-fallback');
    const zdm = fileOf('ORA_PHYS');
    expect(verbBody(zdm, 'cutover')).toContain('zdm_warn_fallback "$id"');
    expect(verbBody(zdm, 'rollback')).toContain('zdm_warn_fallback "$id"');
    expect(zdm).toContain('no automatic fallback: ZDM does not handle reverse role switches');
    expect(verbBody(zdm, 'rollback')).toContain('zdm_dg "$id" switchover-back');
    expect(kit().files['ansible/db-oracle-dataguard.yml']).toContain("dg_action == 'switchover-back' and dg_mode == 'sql'");
  });
  it('runs -eval at prepare, -pauseafter at replicate and resume at cutover', () => {
    const zdm = fileOf('ORA_PHYS');
    expect(verbBody(zdm, 'prepare')).toContain('zdm_submit "$id" eval -eval');
    expect(verbBody(zdm, 'replicate')).toContain('-pauseafter "$(zdm_pause_phase "$id")"');
    expect(verbBody(zdm, 'cutover')).toContain('resume job -jobid "$job"');
    expect(zdm).toContain('printf ZDM_CONFIGURE_DG_SRC');
    expect(zdm).toContain('-sourcesyswallet "$ZDM_SRC_WALLET"');
  });
});

// ---------------------------------------------------------------------------
// The rest of the house rules
// ---------------------------------------------------------------------------

describe('house rules', () => {
  it('applies by default: --dry-run is opt-in and nothing prompts', () => {
    for (const [file, text] of Object.entries(kit().files)) {
      if (!file.startsWith('paths/db/')) continue;
      if (file.endsWith('.sh')) expect(text).toContain('atk_init ');
      if (file.endsWith('.ps1')) expect(text).toContain('[switch] $DryRun');
      expect(`${file} ${/--yes|Read-Host/.test(text)}`).toBe(`${file} false`);
    }
  });
  it('brackets IPv6 literals in URLs, EZConnect strings and SqlClient instances', () => {
    const sh = fileOf('ORA_DP');
    expect(sh).toContain('db_host_url() { if [[ "$1" == *:* && "$1" != \\[* ]]; then printf \'[%s]\' "$1"');
    expect(sh).toContain('ora_ez() { printf \'//%s:%s/%s\' "$(db_host_url');
    expect(kit().files['paths/db/sql-log-shipping.ps1']).toContain("if ($h.Contains(':') -and -not $h.StartsWith('[')) { $h = \"[$h]\" }");
  });
  it('db_host_url brackets an IPv6 literal, in bash', { skip: !hasBash() }, () => {
    const fn = /^db_host_url\(\) \{.*\}$/m.exec(fileOf('PG_OCI'))![0];
    const out = runBash(`${fn}\ndb_host_url 2001:db8::5; echo; db_host_url db.corp.example; echo; db_host_url '[::1]'`);
    expect(out.trim().split('\n')).toEqual(['[2001:db8::5]', 'db.corp.example', '[::1]']);
  });
  it('writes the AWS DMS table mappings: every schema but the engine\'s own', () => {
    const ora = JSON.parse(kit().files[`paths/db/aws-dms/${itemOf('ORA_RDS').resource}.table-mappings.json`]!) as { rules: { 'rule-action': string; 'object-locator': { 'schema-name': string } }[] };
    expect(ora.rules[0]!['rule-action']).toBe('include');
    expect(ora.rules.filter((r) => r['rule-action'] === 'exclude').map((r) => r['object-locator']['schema-name'])).toContain('SYS');
    const pg = JSON.parse(kit().files[`paths/db/aws-dms/${itemOf('PG_AWS').resource}.table-mappings.json`]!) as { rules: unknown[] };
    expect(pg.rules.length).toBeGreaterThan(1);
  });
  it('tokens are upper-case, unique and never start with a digit', () => {
    expect(envToken('pg-orders.v2')).toBe('PG_ORDERS_V2');
    expect(envToken('2fa')).toBe('DB_2FA');
    const items = kit().manifest.items.filter((i) => i.kind === 'database');
    const clash = [{ ...items[0]!, id: 'd:a-b', name: 'a-b' }, { ...items[0]!, id: 'd:a_b', name: 'a_b' }];
    const t = itemTokens(clash);
    expect(t.get('d:a-b') === t.get('d:a_b')).toBe(false);
  });
  it('a kit with a single database writes only that path\'s script', () => {
    const { plan, decision, design, waves } = fixture(CASES.filter((c) => c.name === 'PG_OCI'));
    const k = executionKit(plan, decision, design, waves, undefined, { registry: createRegistry(ALL) });
    const db = Object.keys(k.files).filter((f) => f.startsWith('paths/db/'));
    expect(db.sort()).toEqual(['paths/db/README-open-source.md', 'paths/db/pg-logical.sh']);
    expect(k.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});
