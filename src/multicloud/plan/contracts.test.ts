import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import {
  OPTION_TABLES, OS_OPTIONS, PLATFORM_OPTIONS, PLATFORM_LABELS, DB_SERVICE_OPTIONS, WORKLOAD_COLUMNS, DATABASE_COLUMNS,
  APP_COLUMNS, SITE_COLUMNS, csvHeader, gridHint, itemId, optionValue, isOption, labelOf, EDITIONS_BY_ENGINE,
  DB_ENGINE_VALUES, DB_EDITION_VALUES, versionsFor, DB_VERSION_VALUES, defaultRequirements, platformOfService,
  DB_SERVICE_VALUES, waveFromPin, pinForWave, defaultConnection, RPO_BY_CRITICALITY, RTO_BY_CRITICALITY,
} from './options.ts';
import { emptyPlan, planEnvelope, planFromEnvelope, loadPlan, savePlan, forgetPlan, newPlanId } from './store.ts';
import { PLATFORMS } from '../platforms.ts';
import { SETTINGS_KINDS, writeSettings, readSettings } from '../../kit/settings-file.ts';
import type { Json } from '../../editor/doc.ts';
import type { Plan } from './types.ts';

describe('plan/options: every union has its option table, and only its members', () => {
  it('has a table per union, each naming every value exactly once, in order', () => {
    expect(OPTION_TABLES.length).toBeGreaterThanOrEqual(60);
    for (const t of OPTION_TABLES) {
      expect(new Set(t.values).size).toBe(t.values.length);
      expect(t.options.map((o) => o.value)).toEqual([...t.values]);
      for (const o of t.options) expect(o.label.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(OPTION_TABLES.map((t) => t.name)).size).toBe(OPTION_TABLES.length);
  });

  it('covers every platform, with Google shown as "Google Cloud (GCP)"', () => {
    expect([...PLATFORM_OPTIONS.map((o) => o.value)].sort()).toEqual([...PLATFORMS].sort());
    expect(PLATFORM_LABELS.google).toBe('Google Cloud (GCP)');
    for (const t of OPTION_TABLES) for (const o of t.options) {
      expect(/Google Cloud Platform/.test(o.label)).toBe(false);
      expect(/Aria/.test(o.label)).toBe(false);
    }
  });

  it('groups the OS dropdown the way the design does', () => {
    const groups = new Set(OS_OPTIONS.map((o) => o.group));
    expect([...groups]).toEqual(['Windows Server', 'RHEL family', 'SUSE', 'Debian family', 'Other']);
    expect(OS_OPTIONS.find((o) => o.value === 'ol-9')?.group).toBe('RHEL family');
    expect(OS_OPTIONS.find((o) => o.value === 'ubuntu-24.04')?.group).toBe('Debian family');
  });

  it('groups database services by platform label, and each id names its platform', () => {
    for (const id of DB_SERVICE_VALUES) expect(PLATFORMS).toContain(platformOfService(id));
    expect(DB_SERVICE_OPTIONS.find((o) => o.value === 'google-cloudsql')?.group).toBe('Google Cloud (GCP)');
  });

  it('gives every engine its editions and versions, and every edition an engine', () => {
    for (const engine of DB_ENGINE_VALUES) expect(EDITIONS_BY_ENGINE[engine].length).toBeGreaterThan(0);
    const used = new Set(Object.values(EDITIONS_BY_ENGINE).flat());
    for (const e of DB_EDITION_VALUES) expect(used.has(e)).toBe(true);
    expect(versionsFor('oracle')).toContain('oracle-26ai');
    expect(versionsFor('sqlserver')).toContain('sql-2025');
    expect(versionsFor('postgres')).toContain('pg-18');
    expect(versionsFor('db2')).toEqual(['other']);
    const all = new Set(DB_ENGINE_VALUES.flatMap((e) => versionsFor(e)));
    for (const v of DB_VERSION_VALUES) expect(all.has(v)).toBe(true);
  });

  it('reads a typed cell back by value or label, never by guess', () => {
    expect(optionValue(OS_OPTIONS, 'win-2019')).toBe('win-2019');
    expect(optionValue(OS_OPTIONS, '  windows server 2019 ')).toBe('win-2019');
    expect(optionValue(OS_OPTIONS, 'Windows 2019-ish')).toBeUndefined();
    expect(optionValue(OS_OPTIONS, '')).toBeUndefined();
    expect(isOption(PLATFORM_OPTIONS, 'google')).toBe(true);
    expect(isOption(PLATFORM_OPTIONS, 'gcp')).toBe(false);
    expect(labelOf(PLATFORM_OPTIONS, 'oci')).toBe('OCI');
  });

  it('derives RPO and RTO from criticality as the design says', () => {
    expect(RPO_BY_CRITICALITY).toEqual({ tier0: '0', tier1: '15m', tier2: '4h', tier3: '24h' });
    expect(RTO_BY_CRITICALITY).toEqual({ tier0: '15m', tier1: '1h', tier2: '4h', tier3: '24h' });
  });

  it('pins waves 0 to 9', () => {
    expect(waveFromPin('wave-3')).toBe(3);
    expect(waveFromPin('7')).toBe(7);
    expect(waveFromPin('wave-10')).toBeUndefined();
    expect(pinForWave(0)).toBe('wave-0');
    expect(pinForWave(10)).toBeUndefined();
  });
});

describe('plan/options: grid columns and CSV headers', () => {
  it('writes the CSV headers of section 2.3.6 exactly', () => {
    expect(csvHeader(WORKLOAD_COLUMNS)).toBe('name,app,env,role,os,vcpu,ram_gib,disks_gib,criticality,rpo,rto,licence,residency,disposition,depends_on,pin');
    expect(csvHeader(DATABASE_COLUMNS)).toBe('name,engine,edition,version,hosts,vcpu,ram_gib,size_gib,ha,dr,features,licence,app,pin_service');
    expect(csvHeader(APP_COLUMNS)).toBe('app,owner,criticality,residency,latency,deadline_months,special,route,wave,notes');
    expect(csvHeader(SITE_COLUMNS)).toBe('site,vpn_peer,bgp_asn,cidrs,bandwidth,circuit,circuit_location');
  });

  it('writes the grid hints of section 2.2 exactly', () => {
    expect(gridHint(WORKLOAD_COLUMNS)).toBe('Name | App | Env | Role | OS | vCPU | RAM GiB | Disks GiB | Criticality | RPO | RTO | Licence | Residency | Disposition | Depends on | Pin');
    expect(gridHint(DATABASE_COLUMNS)).toBe('Name | Engine | Edition | Version | Hosts | vCPU | RAM GiB | Size GiB | HA | DR | Features | Licence | App | Pin service');
    expect(gridHint(APP_COLUMNS)).toBe('App | Owner | Criticality | Residency | Latency to on-prem | Deadline (months) | Special | Route | Wave | Notes');
  });

  it('gives every select column its options', () => {
    for (const c of [...WORKLOAD_COLUMNS, ...DATABASE_COLUMNS, ...APP_COLUMNS, ...SITE_COLUMNS]) {
      if (c.kind === 'select' || c.kind === 'multi') expect((c.options ?? []).length).toBeGreaterThan(0);
    }
  });
});

describe('plan/options: ids and defaults', () => {
  it('makes stable ids from names', () => {
    expect(itemId('workload', 'APP-01')).toBe('w:app-01');
    expect(itemId('database', ' ORA PROD 1 ')).toBe('d:ora-prod-1');
    expect(itemId('app', 'Payroll & HR')).toBe('a:payroll-hr');
  });

  it('defaults to every platform allowed, at most two, and the design regions', () => {
    const r = defaultRequirements();
    expect([...r.allowed].sort()).toEqual([...PLATFORMS].sort());
    expect(r.maxPlatforms).toBe(2);
    expect(r.regions.aws?.primary).toBe('us-east-1');
    expect(r.regions.google?.primary).toBe('us-central1');
    expect(r.backupTiers.map((t) => t.tier)).toEqual(['gold', 'silver', 'bronze']);
    expect(r.drPattern.tier0).toBe('warm-standby');
    expect(r.costModel).toBe('reserved-3y');
    expect(defaultConnection([])).toBe('vpn');
    expect(defaultConnection([{ name: 'dc1', cidrs: [], bandwidth: '1g', circuit: 'expressroute' }])).toBe('circuit-with-vpn-backup');
  });
});

describe('plan/store: the plan as a file and in the browser', () => {
  const sample = (): Plan => ({
    ...emptyPlan('Q3 migration', '2026-09-26T10:00:00.000Z'),
    workloads: [
      {
        id: 'w:app-01', name: 'app-01', app: 'Payroll', env: 'prod', role: 'app', os: 'win-2019', vcpu: 4, ramGib: 16,
        disksGib: [80, 200], criticality: 'tier1', rpo: '15m', rto: '1h', licence: 'li', dependsOn: ['db-01', 'site:London'],
        source: 'estate', facts: { powerState: 'poweredOn', ipAddresses: ['10.0.0.5', '2001:db8::5'] }, edited: ['role'],
      },
    ],
    databases: [
      {
        id: 'd:ora-01', name: 'ora-01', engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', hosts: ['db-01'], vcpu: 8,
        ramGib: 64, sizeGib: 2048, ha: 'rac', dr: 'data-guard-remote', features: ['partitioning'], licence: 'oracle-processor',
        app: 'Payroll', source: 'manual',
      },
    ],
    apps: [{ id: 'a:payroll', name: 'Payroll', criticality: 'tier1', residency: 'uk', latencyToOnPrem: 'tolerant', special: 'none' }],
    edges: [{ from: 'app-01', to: 'db-01', kind: 'sync' }],
    designOverrides: { 'compute:w:app-01:size': 'm7i.xlarge' },
  });

  it('starts empty, with a random id and the default requirements', () => {
    const a = emptyPlan();
    const b = emptyPlan();
    expect(a.kind).toBe('archtoolkit.multicloud-plan');
    expect(a.version).toBe(1);
    expect(a.name).toBe('Migration plan');
    expect(a.id === b.id).toBe(false);
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(newPlanId())).toBe(true);
    expect(a.workloads).toEqual([]);
    expect(a.waveSettings.maxPerWave).toBe(50);
  });

  it('round-trips through the envelope, in JSON, YAML and TXT', () => {
    const plan = sample();
    const env = planEnvelope(plan);
    expect(env.kind).toBe('archtoolkit.multicloud-plan');
    for (const format of ['json', 'yaml', 'txt'] as const) {
      const text = writeSettings(env as unknown as Json, format);
      const back = planFromEnvelope(readSettings(text, `plan.${format}`));
      expect('ok' in back ? back.ok : back).toEqual(plan);
    }
  });

  it('names the planner when a plan file is opened on another page', () => {
    expect(SETTINGS_KINDS['archtoolkit.multicloud-plan']).toBe('the Multi-Cloud Planner');
    const wrong = planFromEnvelope({ kind: 'archtoolkit.terraform-generator', version: 1, savedAt: '' });
    expect('error' in wrong ? wrong.error : '').toContain('Terraform');
    expect('error' in planFromEnvelope({ kind: 'archtoolkit.multicloud-plan', version: 2, savedAt: '' })).toBe(true);
    expect('error' in planFromEnvelope('nonsense')).toBe(true);
  });

  it('fills fields an older file left out with their defaults', () => {
    const back = planFromEnvelope({ kind: 'archtoolkit.multicloud-plan', version: 1, savedAt: '2026-01-01T00:00:00Z', id: 'x', name: 'old', requirements: { maxPlatforms: 3, licensing: { microsoftSa: 'yes-all' } } });
    if (!('ok' in back)) throw new Error(back.error);
    expect(back.ok.requirements.maxPlatforms).toBe(3);
    expect(back.ok.requirements.licensing.microsoftSa).toBe('yes-all');
    expect(back.ok.requirements.licensing.oracle).toBe('none');
    expect(back.ok.requirements.identity.linuxJoin).toBe('realmd-sssd');
    expect(back.ok.workloads).toEqual([]);
    expect(back.ok.waveSettings.freezes).toEqual([]);
  });

  it('carries nothing secret-named into the file', () => {
    const plan = { ...sample(), designOverrides: { 'db:d:ora-01:admin_password': 'hunter2' } };
    expect(JSON.stringify(planEnvelope(plan)).includes('hunter2')).toBe(false);
  });

  it('is safe where IndexedDB is missing', async () => {
    expect(await loadPlan()).toBeNull();
    expect(await savePlan(sample())).toBe(false);
    await forgetPlan();
  });
});
