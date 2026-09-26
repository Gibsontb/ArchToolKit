import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import {
  OPTION_TABLES, OS_OPTIONS, PLATFORM_OPTIONS, PLATFORM_LABELS, DB_SERVICE_OPTIONS, WORKLOAD_COLUMNS, DATABASE_COLUMNS,
  APP_COLUMNS, SITE_COLUMNS, csvHeader, gridHint, itemId, optionValue, isOption, labelOf, EDITIONS_BY_ENGINE,
  DB_ENGINE_VALUES, DB_EDITION_VALUES, versionsFor, DB_VERSION_VALUES, defaultRequirements, platformOfService,
  DB_SERVICE_VALUES, waveFromPin, pinForWave, defaultConnection, RPO_BY_CRITICALITY, RTO_BY_CRITICALITY,
  DISPOSITION_VALUES, AUDIT_PAGE_OPTIONS, STATUS_CHANNEL_OPTIONS, ITEM_STATE_VALUES, ITEM_STATE_RANK, ITEM_STATE_PHASE,
  MIGRATION_PHASE_VALUES, MIGRATION_PHASE_OPTIONS, WORKSTREAM_VALUES, WORKSTREAM_OPTIONS, MIGRATION_STRATEGY_VALUES,
  STRATEGY_OF_DISPOSITION, DISPOSITION_OF_STRATEGY, strategyOf, MOVE_PATH_VALUES, DB_MOVE_PATH_VALUES, EXECUTION_METHOD_VALUES,
  METHOD_OF_PATH, executionMethodsFor, DEFAULT_SIZING_POLICY, defaultExecution, defaultGovernance, defaultDcExit, defaultSizing,
  WORKLOAD_SOURCE_COLUMNS, PROVIDER_TERM_VALUES, SERVICE_STATUS_KIND_VALUES, LIFECYCLE_TOOL_VALUES,
} from './options.ts';
import {
  emptyPlan, planEnvelope, planFromEnvelope, loadPlan, savePlan, forgetPlan, newPlanId, savePlanIfUnchanged, announcePlanSaved,
  onPlanSaved, PLAN_CHANNEL, PLAN_RECORD_KEYS, loadTrackerRecord, saveTrackerRecord, forgetTrackerRecord, loadChangeRecords,
  saveChangeRecords, appendChangeRecord, loadRateCard, saveRateCard, loadAuditEntries, saveAuditEntries, appendAuditEntry,
  forgetPlanRecord, normaliseTracker, emptyTracker, type PlanSavedMessage,
} from './store.ts';
import {
  providerTerm, PROVIDER_TERMS, TERM_SOURCES, strategyLabel, PROVIDER_STRATEGIES, serviceStatus, shouldWarn, SERVICE_STATUS,
  METHODOLOGY_AS_OF, PROVIDER_LIFECYCLE, providerStateLabel, fromProviderState,
} from './methodology.ts';
import { PLATFORMS } from '../platforms.ts';
import { SETTINGS_KINDS, writeSettings, readSettings } from '../../kit/settings-file.ts';
import type { Json } from '../../editor/doc.ts';
import type { Plan } from './types.ts';
import { PLAN_RECORD_KEYS as CLEAR_ALL_KEYS } from '../../ui/clear-all.ts';

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

// ---------------------------------------------------------------------------
// The addendum (A.11) and methodology additions
// ---------------------------------------------------------------------------

describe('plan/options: the addendum and methodology unions have their tables', () => {
  const NEW_TABLES = [
    'PlanMode', 'AppOrigin', 'SourcePlatform', 'SizingBasis', 'IpStrategy', 'OsUpgrade', 'ListenProto', 'WorkloadType', 'AppKind',
    'AppPattern', 'TierPattern', 'ComponentTier', 'ComponentKind', 'ChangeWindow', 'AppPlanStatus', 'ComponentStatus',
    'IngressExposure', 'IngressLb', 'IngressTls', 'CostClass', 'Slo', 'HorizonYears', 'NonprodPct', 'SmokeKind', 'LandingZoneMode',
    'SizingConcern', 'Percentile', 'SizingPolicyBasis', 'HeadroomPct', 'DiskBasis', 'GrowthPctYear', 'InstanceFamily',
    'MovePath', 'DbMovePath', 'DnsProvider', 'LbKind', 'DataCopyMethod', 'LandingZoneState', 'MgnReplication', 'MgnIpProtocol',
    'AzureMigrateDiskType', 'AzureSecurityType', 'DmsCapacityUnits', 'HcxWindowHours', 'WaveKind', 'GroupingRuleKind',
    'RaciRole', 'RaciCell', 'RaciPhase', 'CrSystem', 'Cicd', 'InfraCategory', 'InfraDisposition', 'ExternalKind', 'ExternalDirection',
    'ContractKind', 'Sanitisation', 'RateCategory', 'AuditPage', 'ItemState', 'ItemFlag', 'StepId', 'Outcome', 'StatusChannel',
    'StatusEventSource', 'ItemStatusKind', 'GateId', 'GateDecision', 'SignOffScope', 'SignOffKind', 'SignOffDecision', 'RaidScore',
    'RiskResponse', 'RiskStatus', 'AssumptionStatus', 'IssueSeverity', 'IssueStatus', 'IssueOrigin', 'DecisionSource',
    'ReclaimedLicence', 'LicenceReclaimStatus', 'CrStatus', 'MigrationPhase', 'Workstream', 'MigrationStrategy', 'ExecutionMethod',
    'MethodProvider', 'ProviderTerm', 'ServiceStatusKind', 'LifecycleTool',
  ];

  it('has a table for every new union', () => {
    const names = new Set(OPTION_TABLES.map((t) => t.name));
    for (const n of NEW_TABLES) expect(names.has(n)).toBe(true);
    expect(OPTION_TABLES.length).toBeGreaterThanOrEqual(58 + NEW_TABLES.length);
  });

  it('extends the existing unions: Disposition new, the A.4.9 engines and services', () => {
    expect(DISPOSITION_VALUES).toContain('new');
    for (const e of ['informix', 'sap-hana', 'redis', 'cassandra', 'elasticsearch'] as const) {
      expect(DB_ENGINE_VALUES).toContain(e);
      expect(EDITIONS_BY_ENGINE[e].length).toBeGreaterThan(0);
    }
    for (const s of ['aws-rds-db2', 'aws-docdb', 'azure-managed-redis', 'google-memorystore', 'oci-adb-mongo'] as const) {
      expect(DB_SERVICE_VALUES).toContain(s);
      expect(PLATFORMS).toContain(platformOfService(s));
    }
  });

  it('keeps the house names in every label: Utilities, not Change; Broadcom names; Google Cloud (GCP)', () => {
    for (const t of OPTION_TABLES.filter((x) => NEW_TABLES.includes(x.name))) for (const o of t.options) {
      expect(/Migration & Change|Change area/.test(o.label)).toBe(false);
      expect(/\bESXi\b|vRealize|Service Broker|\bAria\b/.test(o.label)).toBe(false);
      expect(/Google Cloud(?! \(GCP\))(?! (VMware Engine|Adoption Framework|Identity|Dedicated|Partner))/.test(o.label)).toBe(false);
    }
    expect(labelOf(AUDIT_PAGE_OPTIONS, 'migration-change')).toBe('Multi-Cloud Migration & Utilities');
    expect(labelOf(STATUS_CHANNEL_OPTIONS, 'change')).toBe('Utility (day-2)');
  });

  it('ranks the tracker states 0..10 in order, and gives each a phase', () => {
    expect(ITEM_STATE_VALUES.map((s) => ITEM_STATE_RANK[s])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const s of ITEM_STATE_VALUES) expect(MIGRATION_PHASE_VALUES).toContain(ITEM_STATE_PHASE[s]);
    expect(ITEM_STATE_PHASE.planned).toBe('plan');
    expect(ITEM_STATE_PHASE.decommissioned).toBe('decommission');
  });

  it('has ten phases plus the governance track, labelled P0 to P9 and G', () => {
    expect(MIGRATION_PHASE_VALUES.length).toBe(10);
    expect(WORKSTREAM_VALUES).toEqual([...MIGRATION_PHASE_VALUES, 'governance']);
    expect(MIGRATION_PHASE_OPTIONS.map((o) => o.label.slice(0, 2))).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9']);
    expect(labelOf(WORKSTREAM_OPTIONS, 'governance').startsWith('G ')).toBe(true);
  });

  it('keeps strategy and execution method apart, and maps each to the other side', () => {
    expect(MIGRATION_STRATEGY_VALUES.length).toBe(11);
    for (const d of DISPOSITION_VALUES) {
      const s = STRATEGY_OF_DISPOSITION[d];
      if (d === 'new') expect(s).toBeUndefined();
      else expect(DISPOSITION_OF_STRATEGY[s!]).toBe(d);
    }
    expect(strategyOf({ disposition: 'repurchase' })).toBe('repurchase');
    expect(strategyOf({ disposition: 'refactor', strategy: 'rearchitect' })).toBe('rearchitect');
    for (const p of [...MOVE_PATH_VALUES, ...DB_MOVE_PATH_VALUES]) expect(EXECUTION_METHOD_VALUES).toContain(METHOD_OF_PATH[p]);
    expect(METHOD_OF_PATH['aws-mgn']).toBe('aws-transform-mgn');
    expect(executionMethodsFor('vmware')).toContain('hcx-rav');
    expect(executionMethodsFor('vmware')).not.toContain('aws-transform-mgn');
    expect(executionMethodsFor('aws')).toContain('rebuild');
  });

  it('has sensible defaults for the new plan sections', () => {
    expect(DEFAULT_SIZING_POLICY.percentile).toBe('p95');
    expect(DEFAULT_SIZING_POLICY.headroomPct).toBe(30);
    expect(defaultExecution().keepDays).toEqual({ tier0: 30, tier1: 21, tier2: 14, tier3: 7 });
    expect(defaultExecution().hypercareDays).toEqual({ tier0: 14, tier1: 10, tier2: 7, tier3: 3 });
    expect(defaultExecution().lagSeconds).toEqual({ server: 60, db: 0 });
    expect(defaultGovernance().cr.system).toBe('none');
    expect(defaultDcExit().infra).toEqual([]);
    expect(defaultSizing().overrides).toEqual({});
    expect(csvHeader(WORKLOAD_SOURCE_COLUMNS)).toBe('origin,source_manager,source_id,host,bmc,workload_type,cpu_p95_pct,mem_p95_gib,iops_p95,mbps_p95,util_days,software,ports');
  });
});

describe('plan/methodology: provider terms, strategy labels, service status, lifecycles', () => {
  it('relabels terms per provider and falls back to the neutral word', () => {
    expect(providerTerm('move-group', 'azure')).toBe('Dependency group');
    expect(providerTerm('move-group', 'vmware')).toBe('Mobility Group');
    expect(providerTerm('move-group')).toBe('Move group');
    expect(providerTerm('wave', 'oci')).toBe('Wave');
    expect(providerTerm('hypercare', 'azure')).toBe('Stabilization');
    for (const t of PROVIDER_TERM_VALUES) expect(t in PROVIDER_TERMS).toBe(true);
    for (const p of PLATFORMS) expect(/^https:\/\//.test(TERM_SOURCES[p])).toBe(true);
  });

  it('names Replace / Repurchase the way each provider does', () => {
    expect(strategyLabel('repurchase', 'aws')).toBe('Repurchase');
    expect(strategyLabel('repurchase', 'google')).toBe('Repurchase');
    expect(strategyLabel('repurchase', 'azure')).toBe('Replace');
    expect(strategyLabel('repurchase', 'oci')).toBe('Replace');
    expect(strategyLabel('rehost')).toBe('Rehost');
    for (const p of PLATFORMS) for (const s of PROVIDER_STRATEGIES[p]) expect(MIGRATION_STRATEGY_VALUES).toContain(s);
  });

  it('knows which tools are closed, renamed or retired, each with a source and a date checked', () => {
    expect(serviceStatus('aws-migration-hub')?.status).toBe('closed-to-new-customers');
    expect(serviceStatus('aws-migration-hub')?.since).toBe('2025-11-07');
    expect(serviceStatus('aws-mgn')?.replacement).toBe('AWS Transform MGN');
    expect(shouldWarn('aws-migration-hub')).toBe(true);
    expect(shouldWarn('oci-data-transfer')).toBe(true);
    expect(shouldWarn('aws-mgn')).toBe(false);
    expect(shouldWarn('hcx-wan-optimization')).toBe(false);
    expect(serviceStatus('nothing-here')).toBeUndefined();
    const ids = SERVICE_STATUS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of SERVICE_STATUS) {
      expect(/^https:\/\//.test(e.source)).toBe(true);
      expect(SERVICE_STATUS_KIND_VALUES).toContain(e.status);
      expect(e.asOf).toBe(METHODOLOGY_AS_OF);
    }
  });

  it('maps every tool lifecycle onto the tracker states', () => {
    for (const tool of LIFECYCLE_TOOL_VALUES) expect(PROVIDER_LIFECYCLE.some((s) => s.tool === tool)).toBe(true);
    for (const s of PROVIDER_LIFECYCLE) {
      expect(s.state !== undefined || s.flag !== undefined).toBe(true);
      if (s.state) expect(ITEM_STATE_VALUES).toContain(s.state);
      expect(/^https:\/\//.test(s.source)).toBe(true);
    }
    expect(providerStateLabel('aws-transform-mgn', 'tested')).toBe('Ready for cutover');
    expect(providerStateLabel('hcx-mobility-group', 'planned')).toBe('Partially Configured');
    expect(fromProviderState('gcp-m2vm', 'test-clone')?.state).toBe('testing');
    expect(fromProviderState('oci-ocm', 'needs_attention')?.flag).toBe('blocked');
  });
});

describe('plan/store: the addendum fields, the conditional save, the broadcast and the other records', () => {
  it('starts a plan in migrate mode with no app plans, and round-trips the new sections', () => {
    const plan: Plan = {
      ...emptyPlan('DC exit', '2026-09-26T10:00:00.000Z'),
      mode: 'dc-exit',
      appPlans: [{ app: 'a:payroll', origin: 'new', status: 'draft', variants: {}, answers: {}, landingZone: 'shared' }],
      sizing: defaultSizing(),
      execution: defaultExecution(),
      governance: defaultGovernance(),
      dcExit: { ...defaultDcExit(), exitDate: '2027-06-30', dualRunningDays: 30 },
    };
    expect(emptyPlan().mode).toBe('migrate');
    expect(emptyPlan().appPlans).toEqual([]);
    const back = planFromEnvelope(planEnvelope(plan) as unknown as Json);
    expect('ok' in back ? back.ok : back).toEqual(plan);
  });

  it('fills the new sections from their defaults, and leaves absent ones out', () => {
    const back = planFromEnvelope({
      kind: 'archtoolkit.multicloud-plan', version: 1, savedAt: '2026-01-01T00:00:00Z', id: 'x', name: 'old',
      mode: 'sideways', execution: { keepDays: { tier0: 45 } }, sizing: { policy: { percentile: 'p99' } },
    });
    if (!('ok' in back)) throw new Error(back.error);
    expect(back.ok.mode).toBe('migrate');
    expect(back.ok.appPlans).toEqual([]);
    expect(back.ok.execution?.keepDays).toEqual({ tier0: 45, tier1: 21, tier2: 14, tier3: 7 });
    expect(back.ok.execution?.lagSeconds).toEqual({ server: 60, db: 0 });
    expect(back.ok.sizing?.policy.percentile).toBe('p99');
    expect(back.ok.sizing?.policy.headroomPct).toBe(30);
    expect(back.ok.governance).toBeUndefined();
    expect(back.ok.dcExit).toBeUndefined();
  });

  it('is safe where IndexedDB is missing: every record reads empty and every write fails', async () => {
    expect(await savePlanIfUnchanged(emptyPlan(), '')).toBe('failed');
    expect(await loadTrackerRecord()).toBeNull();
    expect(await saveTrackerRecord(emptyTracker('p'))).toBe(false);
    await forgetTrackerRecord();
    expect(await loadChangeRecords()).toEqual([]);
    expect(await saveChangeRecords([])).toBe(false);
    expect(await appendChangeRecord({ id: 'c1', utility: 'resize', target: 'app-01', summary: 's', values: {}, generatedAt: '2026-09-26' })).toBe(false);
    expect(await loadRateCard()).toBeNull();
    expect(await saveRateCard({ kind: 'archtoolkit.ratecard', v: 1, rows: [] })).toBe(false);
    expect(await loadAuditEntries()).toEqual([]);
    expect(await saveAuditEntries([])).toBe(false);
    expect(await appendAuditEntry({ at: '2026-09-26T00:00:00Z', page: 'migration-change', area: 'utilities', action: 'x', targets: [], summary: '' })).toBe(false);
    await forgetPlanRecord('audit');
    expect([...PLAN_RECORD_KEYS]).toEqual(['current', 'tracker', 'changes', 'ratecard', 'audit']);
    // Clear all deletes every one of them (it repeats the list so the header does not load the planner).
    expect([...CLEAR_ALL_KEYS]).toEqual([...PLAN_RECORD_KEYS]);
    expect(SETTINGS_KINDS['archtoolkit.migration-tracker']).toBe('the migration tracker');
  });

  it('announces a save to the other pages on archtoolkit.plan, and is quiet where BroadcastChannel is missing', async () => {
    const got: PlanSavedMessage[] = [];
    let heard: () => void = () => undefined;
    const arrived = new Promise<void>((r) => { heard = r; });
    const stop = onPlanSaved((m) => { got.push(m); heard(); });
    announcePlanSaved({ id: 'plan-1', savedAt: '2026-09-26T10:00:00.000Z' });
    await Promise.race([arrived, new Promise((r) => setTimeout(r, 2000))]);
    stop();
    expect(got).toEqual([{ planId: 'plan-1', savedAt: '2026-09-26T10:00:00.000Z' }]);
    expect(PLAN_CHANNEL).toBe('archtoolkit.plan');

    const saved = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');
    Object.defineProperty(globalThis, 'BroadcastChannel', { value: undefined, configurable: true, writable: true });
    try {
      announcePlanSaved({ id: 'plan-2', savedAt: '' });
      onPlanSaved(() => undefined)();
    } finally {
      if (saved) Object.defineProperty(globalThis, 'BroadcastChannel', saved);
    }
  });

  it('reads a stored tracker back with any missing list filled, and refuses anything else', () => {
    const t = normaliseTracker({ kind: 'archtoolkit.migration-tracker', version: 1, planId: 'p1', savedAt: 's', items: { 'w:a': { state: 'planned' } } });
    expect(t?.planId).toBe('p1');
    expect(t?.events).toEqual([]);
    expect(t?.raid.decisions).toEqual([]);
    expect(Object.keys(t?.items ?? {})).toEqual(['w:a']);
    expect(normaliseTracker({ kind: 'archtoolkit.migration-tracker', version: 2, planId: 'p1' })).toBeNull();
    expect(normaliseTracker('nonsense')).toBeNull();
    expect(emptyTracker('p9', 'd').kind).toBe('archtoolkit.migration-tracker');
  });
});
