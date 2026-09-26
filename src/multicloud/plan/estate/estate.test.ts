import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { chooseAppPlatform, decideApps } from '../apps/recommend.ts';
import { designPlan } from '../design/index.ts';
import { defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../options.ts';
import { withPatternMappers } from '../patterns/index.ts';
import type { App, Database, Plan, RateRow, Workload } from '../types.ts';
import { checkQuotas, estateCapacity, familyOf, parseQuotasJson } from './capacity.ts';
import { estateCheck } from './check.ts';
import { designCounts, estimate, estimateDesign, NO_RATE_CARD } from './estimate.ts';
import { fetchQuotasScript } from './fetch-quotas.ts';
import { QUOTA_DEFAULTS } from './quota-data.ts';
import { offlineOptions, OFFLINE_DEVICES, transferDays, transferPlan } from './transfer.ts';

const TODAY = '2026-09-26';
const ENGINE = { today: TODAY };

const workload = (name: string, app: string, over: Partial<Workload> = {}): Workload => ({
  id: itemId('workload', name), name, app, env: 'prod', role: 'app', os: 'rhel-9', vcpu: 8, ramGib: 32, disksGib: [100],
  criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
});
const database = (name: string, app: string, over: Partial<Database> = {}): Database => ({
  id: itemId('database', name), name, engine: 'postgres', edition: 'community', version: 'pg-16', hosts: [], vcpu: 4, ramGib: 32,
  sizeGib: 200, ha: 'none', dr: 'none', features: [], licence: 'community', app, source: 'manual', ...over,
});
const app = (name: string, over: Partial<App> = {}): App => ({
  id: itemId('app', name), name, criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', ...over,
});

function estate(over: Partial<Plan> = {}): Plan {
  return {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'plan-estate', name: 'Estate', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: [
      ...Array.from({ length: 8 }, (_, i) => workload(`erp${i}`, 'erp', { disksGib: [100, 500], dependsOn: i === 0 ? ['hr0'] : [] })),
      workload('hr0', 'hr'),
      workload('hr1', 'hr'),
    ],
    databases: [database('erpdb', 'erp'), database('hrdb', 'hr', { sizeGib: 50 })],
    apps: [app('erp', { wave: 1 }), app('hr', { wave: 2 })],
    edges: [],
    requirements: {
      ...defaultRequirements(),
      maxPlatforms: 1,
      sites: [{ name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.0.0.0/16'], bandwidth: '100m', circuit: 'none' }],
    },
    designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    appPlans: [],
    ...over,
  };
}

/** erp and hr both on AWS by choice. */
function onAws(): Plan {
  let p = estate();
  p = chooseAppPlatform(p, 'erp', 'aws').plan;
  p = chooseAppPlatform(p, 'hr', 'aws').plan;
  return p;
}

// ---------------------------------------------------------------------------
// Capacity and quotas
// ---------------------------------------------------------------------------

describe('estate/capacity', () => {
  const plan = onAws();
  const decision = decideApps(plan, ENGINE);
  const design = designPlan(plan, decision, withPatternMappers());
  const cap = estateCapacity(plan, decision, { design });

  it('totals vCPU, RAM, instances by family, storage by type, databases and backup per platform', () => {
    const aws = cap.platforms.find((p) => p.platform === 'aws')!;
    const pd = design.platforms.find((p) => p.platform === 'aws')!;
    expect(aws.instances).toBe(pd.compute.length);
    expect(aws.vcpu).toBe(pd.compute.reduce((s, c) => s + c.vcpu, 0));
    expect(aws.families.reduce((s, f) => s + f.instances, 0)).toBe(aws.instances);
    expect(aws.storage.reduce((s, x) => s + x.gib, 0)).toBe(pd.compute.flatMap((c) => c.disks).reduce((s, d) => s + d.gib, 0));
    expect(aws.databases.reduce((s, d) => s + d.count, 0)).toBe(pd.databases.length);
    expect(aws.backupGib).toBeGreaterThan(0);
    expect(aws.region).toBe('us-east-1');
    expect(familyOf('aws', 'm7i.2xlarge')).toBe('m7i');
    expect(familyOf('azure', 'Standard_D4s_v5')).toBe('Dsv5');
    expect(familyOf('google', 'n2-standard-4')).toBe('n2');
    expect(familyOf('oci', 'VM.Standard.E5.Flex')).toBe('Standard.E5');
  });

  it('flags a need over the default quota (capacity.quota), and clears it with a real, higher quota', () => {
    const q = checkQuotas(cap);
    const vcpu = q.rows.find((r) => r.quotaId === 'aws.ec2.standard-vcpu')!;
    expect(vcpu.needed).toBeGreaterThan(5);
    expect(vcpu.default).toBe(5);
    expect(vcpu.status).toBe('over');
    expect(q.findings.some((f) => f.code === 'capacity.quota' && f.severity === 'error')).toBe(true);
    const raised = checkQuotas(cap, [{ platform: 'aws', region: 'us-east-1', quota: 'aws.ec2.standard-vcpu', actual: 1152 }]);
    const row = raised.rows.find((r) => r.quotaId === 'aws.ec2.standard-vcpu')!;
    expect(row.status).toBe('ok');
    expect(row.actual).toBe(1152);
    expect(row.headroom).toBe(1152 - row.needed);
  });

  it('marks a quota with no sourced default as unknown, never assumed', () => {
    const q = checkQuotas({ platforms: [{ ...cap.platforms[0]!, platform: 'oci', region: 'us-ashburn-1' }] });
    const oci = q.rows.find((r) => r.quotaId === 'oci.compute.standard-e5-cores')!;
    expect(oci.status).toBe('unknown');
    expect(oci.default).toBeUndefined();
    expect(q.findings.some((f) => f.code === 'capacity.quota-unknown')).toBe(true);
  });

  it('checks the migration tools\' own quotas per wave (MGN 150 replicating per region)', () => {
    const many = { platforms: [{ ...cap.platforms.find((p) => p.platform === 'aws')!, replicationPerWave: [{ wave: 'wave 1', replicating: 200 }, { wave: 'wave 2', replicating: 20 }] }] };
    const rows = checkQuotas(many).rows.filter((r) => r.quotaId === 'aws.mgn.replicating');
    expect(rows.map((r) => `${r.wave}:${r.status}`)).toEqual(['wave 1:over', 'wave 2:ok']);
  });

  it('every default quota carries a source and a verification tag', () => {
    for (const q of QUOTA_DEFAULTS) {
      expect(/^https:\/\//.test(q.source)).toBe(true);
      expect(['V-DOC', 'I', 'C'].includes(q.verification)).toBe(true);
    }
  });
});

describe('estate/fetch-quotas', () => {
  const script = fetchQuotasScript({ requirements: { ...defaultRequirements(), regions: { aws: { primary: 'eu-west-1' }, azure: { primary: 'westeurope' }, google: { primary: 'europe-west1' }, oci: { primary: 'eu-frankfurt-1' } } } });

  it('reads each provider\'s quotas with its own CLI and writes quotas.json', () => {
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain("aws service-quotas get-service-quota --region 'eu-west-1' --service-code 'ec2' --quota-code 'L-1216C47A'");
    expect(script).toContain("az vm list-usage --location 'westeurope' -o json");
    expect(script).toContain("gcloud compute regions describe 'europe-west1' --format='json(quotas)'");
    expect(script).toContain("oci limits resource-availability get --region 'eu-frankfurt-1' --service-name 'compute' --limit-name 'standard-e5-core-count'");
    expect(script).toContain('"$OCI_TENANCY_OCID"');
    expect(script).toContain('archtoolkit.quotas');
    expect(/password|secret|--dry-run|Generated by/i.test(script)).toBe(false);
  });

  it('round-trips quotas.json into actuals', () => {
    const json = JSON.stringify({ kind: 'archtoolkit.quotas', v: 1, quotas: [
      { platform: 'aws', region: 'eu-west-1', quota: 'aws.ec2.standard-vcpu', actual: 640 },
      { platform: 'google', region: 'europe-west1', quota: 'google.compute.ssd', actual: 2048 },
      { platform: 'aws', region: 'eu-west-1', quota: 'not-a-quota', actual: 1 },
    ] });
    const r = parseQuotasJson(json);
    expect(r.actuals).toEqual([
      { platform: 'aws', region: 'eu-west-1', quota: 'aws.ec2.standard-vcpu', actual: 640 },
      { platform: 'google', region: 'europe-west1', quota: 'google.compute.ssd', actual: 2 },
    ]);
    expect(parseQuotasJson('nope').findings[0]!.code).toBe('capacity.quotas-json');
  });
});

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

describe('estate/estimate', () => {
  const plan = onAws();
  const decision = decideApps(plan, ENGINE);
  const design = designPlan(plan, decision, withPatternMappers());
  const counts = designCounts(plan, decision, design);

  it('without a rate card: no figures at all, and says so', () => {
    for (const card of [undefined, { rows: [] as RateRow[] }]) {
      const e = estimate(counts, card);
      expect(e.available).toBe(false);
      expect(e.label).toBe(NO_RATE_CARD);
      expect(e.priced).toEqual([]);
      expect(e.monthly).toEqual({});
    }
    expect(counts.length).toBeGreaterThan(0);
  });

  it('with a rate card: every figure carries "estimate from your rates", run and one-time kept apart', () => {
    const size = design.platforms[0]!.compute[0]!.size;
    const card = { rows: [
      { platform: 'aws', region: '', category: 'compute', key: size, unit: 'hour', rate: 0.2, currency: 'USD', source: 'our 2026 EDP rates' },
      { platform: 'aws', region: '', category: 'service', key: 'migration-per-server', unit: 'one-time', rate: 500, currency: 'USD', source: 'partner SOW' },
    ] as RateRow[] };
    const e = estimateDesign(plan, decision, design, card);
    expect(e.available).toBe(true);
    expect(e.label).toBe('estimate from your rates (source: our 2026 EDP rates; partner SOW)');
    expect(e.priced.every((l) => l.label.startsWith('estimate from your rates (source: '))).toBe(true);
    const sameSize = design.platforms[0]!.compute.filter((c) => c.size === size).length;
    expect(e.monthly.aws![0]!.amount).toBeCloseTo(sameSize * 730 * 0.2, 2);
    expect(e.oneTime.aws![0]!.amount).toBe(500 * 10);
    expect(e.noRate.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

describe('estate/transfer', () => {
  it('uses AWS\'s formula: 100 TB over 1 Gbps at 80 % is about 11.57 days', () => {
    expect(transferDays(100e12, 1e9, 0.8)).toBeCloseTo(11.57, 2);
  });

  it('flags seed-slow on 50 TiB over 100 Mbit/s', () => {
    const fifty = estate({
      workloads: [workload('files01', 'files', { role: 'file', disksGib: [50 * 1024] })],
      databases: [],
      apps: [app('files')],
    });
    const decision = decideApps(fifty, ENGINE);
    const t = transferPlan(fifty, decision, { groupBy: 'app' });
    const g = t.groups[0]!;
    expect(g.volumeGib).toBe(50 * 1024);
    expect(g.linkMbps).toBe(100);
    expect(g.seedSlow).toBe(true);
    expect(g.seedDays).toBeGreaterThan(100);
    expect(t.findings.some((f) => f.code === 'transfer.seed-slow')).toBe(true);
  });

  it('flags cannot-keep-up when the daily change outruns the link', () => {
    const busy = estate({
      workloads: [workload('db01', 'busy', { disksGib: [100], facts: { utilisation: { days: 30, samples: 8640, coverage: 1, mbpsP95: 200 } } })],
      databases: [],
      apps: [app('busy')],
    });
    const t = transferPlan(busy, decideApps(busy, ENGINE));
    expect(t.groups[0]!.keepsUp).toBe(false);
    expect(t.findings.map((f) => f.code)).toContain('transfer.cannot-keep-up');
    // Block replication seeds over the network: no offline device is offered for it.
    expect(t.groups[0]!.offline).toEqual({});
  });

  it('offers only the offline devices a new customer can order', () => {
    expect(offlineOptions('aws').map((d) => d.id)).toEqual(['aws-data-transfer-terminal']);
    expect(offlineOptions('azure').map((d) => d.id)).toEqual(['azure-data-box', 'azure-data-box-disk']);
    expect(offlineOptions('google').map((d) => d.id)).toEqual(['google-transfer-appliance']);
    expect(offlineOptions('oci').map((d) => d.id)).toEqual(['oci-roving-edge']);
    expect(OFFLINE_DEVICES.every((d) => /^https:\/\//.test(d.source))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The estate check
// ---------------------------------------------------------------------------

describe('estate/check', () => {
  it('reports platforms over the maximum, sync edges across platforms, and what the unconstrained optimum prefers', () => {
    let p = estate();
    p = chooseAppPlatform(p, 'erp', 'aws').plan;
    p = chooseAppPlatform(p, 'hr', 'oci').plan;
    const d = decideApps(p, ENGINE);
    const c = estateCheck(p, d, { engine: ENGINE });
    expect(c.chosenPlatforms).toEqual(['aws', 'oci']);
    expect(c.placement).toEqual({ erp: 'aws', hr: 'oci' });
    const codes = c.findings.map((f) => f.code);
    expect(codes).toContain('estate.platforms-exceed-max');
    expect(codes).toContain('estate.sync-crosses-platforms');
    const prefers = c.findings.filter((f) => f.code === 'estate.subset-prefers');
    expect(prefers.every((f) => /left unconstrained/.test(f.message))).toBe(true);
  });

  it('is quiet when the choices agree with each other and the maximum', () => {
    const p = onAws();
    const c = estateCheck(p, decideApps(p, ENGINE), { engine: ENGINE });
    expect(c.findings.filter((f) => f.code !== 'estate.subset-prefers')).toEqual([]);
  });
});
