import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { overlapsAny } from '../../../core/ip.ts';
import { inCatalog, instanceSpec, type SpecPlatform } from '../../../kit/instance-specs.ts';
import { fitCluster, sizeWorkloadDomain } from '../../../vcf/sizing.ts';
import { classInCatalog } from '../design/database.ts';
import { defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../index.ts';
import type {
  AppComponent, AppPlan, Database, PatternComponent, Plan, Platform, SizingPolicy, SizingRecommendation, Utilisation, Workload,
} from '../types.ts';
import { PLAN_KIND } from '../types.ts';
import {
  applyOverrides, chooseInstance, DEFAULT_SIZING_POLICY, rowsOf, serverDemand, SIZING_ENGINES, sizeApp, sizeComponent, sizeServer,
  withEngine, type SizingEngine, type SizingPolicyExt,
} from './index.ts';
import { CNI_RULES, CONTROL_PLANE_TIERS, allocatable } from './k8s-data.ts';
import { cpuMillis, memMib, parseGrid, parseKubectlWorkloads, toGrid, type K8sWorkload } from './k8s-import.ts';
import { planCluster, type K8sSettings } from './k8s.ts';
import { LOAD_ASSUMPTIONS, sizeFromLoad } from './load.ts';
import { sizeSap } from './sap.ts';
import { chooseTier, volumeDemands, volumeRow, type VolumeDemand } from './storage.ts';
import { STORAGE_TIERS } from './storage-tiers.ts';
import { sizeFile } from './file.ts';
import { sizeVdi } from './vdi.ts';
import { sizeVcfDemand, vcfDomainInput, vcfOptionsOf } from './vcf.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLOUDS: readonly Exclude<Platform, 'vmware'>[] = ['aws', 'azure', 'google', 'oci'];

function workload(name: string, over: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app: 'shop', env: 'prod', role: 'app', os: 'rhel-9', vcpu: 4, ramGib: 16, disksGib: [64, 200],
    criticality: 'tier2', rpo: '1h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
  };
}
const util = (over: Partial<Utilisation> = {}): Utilisation => ({ days: 30, samples: 8500, coverage: 0.97, ...over });

function plan(over: Partial<Plan> = {}): Plan {
  return {
    kind: PLAN_KIND, version: 1, id: 'p-1', name: 'test', savedAt: '2026-09-26T00:00:00Z',
    workloads: [], databases: [], apps: [], edges: [], requirements: defaultRequirements(), designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] }, mode: 'migrate', appPlans: [], ...over,
  };
}
function comp(id: string, over: Partial<PatternComponent> = {}): PatternComponent {
  return { kind: 'pattern', id: `c:shop:${id}`, name: id, tier: 'app', servers: [], databases: [], settings: {}, ...over };
}
const policy = (over: Partial<SizingPolicyExt> = {}): SizingPolicyExt => ({ ...DEFAULT_SIZING_POLICY, ...over });

// A physical server: 32 cores / 256 GiB, p95 CPU 20 %, p95 memory 60 GiB over 30 days.
const physical = workload('db-phys', {
  origin: 'physical', vcpu: 32, ramGib: 256, disksGib: [100, 900],
  facts: { nameplate: { cores: 32, ramGib: 256, disksGib: [100, 900] }, utilisation: util({ cpuP50Pct: 8, cpuP95Pct: 20, cpuP99Pct: 35, cpuMaxPct: 60, memP95Gib: 60, memMaxGib: 90, iopsP95: 4000, mbpsP95: 120 }) },
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('registry', () => {
  it('one engine per concern', () => {
    expect(SIZING_ENGINES.map((e) => e.id).sort()).toEqual(['database', 'file', 'k8s', 'load', 'sap', 'server', 'storage', 'vcf', 'vdi']);
  });
  it('withEngine replaces by id or appends', () => {
    const fake: SizingEngine = { id: 'server', applies: () => true, inputs: () => null, size: (_i, platform) => ({ concern: 'server', platform, rows: [], findings: [] }) };
    const list = withEngine(fake);
    expect(list.length).toBe(SIZING_ENGINES.length);
    expect(list.find((e) => e.id === 'server')).toBe(fake);
    const c = comp('web', { servers: ['web1'] });
    const p = plan({ workloads: [workload('web1')] });
    const out = sizeComponent(c, 'aws', p, [fake]);
    expect(out).toHaveLength(1);
    expect(out[0]!.rows).toHaveLength(0);
  });
  it('sizeComponent runs every engine that applies, and only on its platforms', () => {
    const c = comp('web', { servers: ['web1'] });
    const p = plan({ workloads: [workload('web1')] });
    expect(sizeComponent(c, 'aws', p).map((r) => r.concern)).toEqual(['server', 'storage']);
    expect(sizeComponent(c, 'vmware', p).map((r) => r.concern)).toEqual(['server', 'storage', 'vcf']);
  });
  it('sizeApp sizes an app plan\'s variant', () => {
    const ap: AppPlan = { app: 'a:shop', origin: 'migrate', status: 'draft', variants: { azure: [comp('web', { servers: ['web1'] })] }, answers: {}, landingZone: 'shared' };
    const r = sizeApp(plan({ workloads: [workload('web1')], appPlans: [ap] }), 'a:shop', 'azure');
    expect(rowsOf(r).some((x) => x.key === 'server:web1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

describe('server engine: sizing from utilisation, not nameplate (A.3.6)', () => {
  it('a physical server sized from utilisation is smaller than its nameplate, with the reason', () => {
    const r = sizeServer(physical, 'aws', policy());
    expect(r.demand.vcpu).toBe(9); // 32 × 20 % × 1.3 = 8.32 → 9
    expect(r.demand.ramGib).toBe(78); // 60 × 1.3
    const s = instanceSpec('aws', r.row.choice)!;
    expect(s.vcpu).toBeLessThan(32);
    expect(s.ramGib).toBeLessThan(256);
    expect(r.row.reasons[0]!.text).toContain('p95 CPU 20% of 32 cores × 1.3 → 9 vCPU');
    expect(r.row.reasons[0]!.text).toContain('p95 memory 60 GiB × 1.3 → 78 GiB');
    expect(r.row.detail['mode']).toBe('performance');
    expect(r.row.detail['basis']).toBe('utilisation p95 (30 d, 97%)');
    expect(r.row.detail['coveragePct']).toBe(97);
    expect(r.row.detail['confidence']).toBe(5);
  });
  it('as-is mode keeps the allocation', () => {
    const r = sizeServer(physical, 'aws', policy({ mode: 'as-is' }));
    expect([r.demand.vcpu, r.demand.ramGib, r.row.detail['mode']]).toEqual([32, 256, 'as-is']);
    expect(policy({ basis: 'allocated' }) && serverDemand(physical, policy({ basis: 'allocated' })).vcpu).toBe(32);
  });
  it('every percentile, the target-utilisation headroom and the benchmark multiplier', () => {
    expect(serverDemand(physical, policy({ percentile: 'p50' })).vcpu).toBe(4); // 32 × 8 % × 1.3 = 3.33
    expect(serverDemand(physical, policy({ percentile: 'p99' })).vcpu).toBe(15); // 32 × 35 % × 1.3 = 14.56
    expect(serverDemand(physical, policy({ percentile: 'max' })).vcpu).toBe(25); // 32 × 60 % × 1.3
    expect(serverDemand(physical, policy({ percentile: 'max' })).ramGib).toBe(117); // 90 × 1.3
    const p90 = serverDemand(physical, policy({ percentile: 'p90' }));
    expect(p90.reasons[0]!.text).toContain('p90 is not collected; p95 used');
    const g = serverDemand(physical, policy({ headroomStyle: 'target-utilisation', cpuTargetPct: 70, memoryTargetPct: 85 }));
    expect([g.vcpu, g.ramGib]).toEqual([10, 71]); // 6.4 / 0.7 = 9.14; 60 / 0.85 = 70.6
    expect(serverDemand(physical, policy({ benchmarkMultiplier: 0.8 })).vcpu).toBe(7); // 8.32 × 0.8
    const perResource = serverDemand(physical, policy({ cpuStrategy: 'p95', memoryStrategy: 'as-is' }));
    expect([perResource.vcpu, perResource.ramGib]).toEqual([9, 256]);
  });
  it('data confidence: a warning below 80 %, and the allocation below 60 % or 3 days', () => {
    const w70 = workload('w70', { vcpu: 16, ramGib: 64, facts: { utilisation: util({ coverage: 0.7, cpuP95Pct: 25, memP95Gib: 20 }) } });
    const d70 = serverDemand(w70, policy());
    expect(d70.mode).toBe('performance');
    expect(d70.stars).toBe(4);
    expect(d70.findings.some((f) => f.code === 'size.low-confidence' && f.severity === 'warning' && (f.source ?? '').includes('confidence-ratings'))).toBe(true);
    const w50 = workload('w50', { vcpu: 16, ramGib: 64, facts: { utilisation: util({ coverage: 0.5, cpuP95Pct: 25, memP95Gib: 20 }) } });
    const d50 = serverDemand(w50, policy());
    expect([d50.mode, d50.vcpu, d50.ramGib]).toEqual(['as-is', 16, 64]);
    expect(d50.findings.map((f) => f.code)).toContain('size.low-coverage');
    const short = serverDemand(workload('s', { facts: { utilisation: util({ days: 2, cpuP95Pct: 10, memP95Gib: 2 }) } }), policy());
    expect(short.mode).toBe('as-is');
    const none = serverDemand(workload('n'), policy({ basis: 'utilisation-only' }));
    expect(none.findings.map((f) => f.code)).toContain('size.no-perf-data');
  });
  it('SAP / database hosts: peak basis and never below memory nameplate', () => {
    const d = serverDemand(physical, policy(), { peak: true, floorRamGib: 256 });
    expect(d.percentile).toBe('p99/max');
    expect(d.ramGib).toBe(256);
    expect(d.findings.map((f) => f.code)).toContain('size.peak-basis');
  });
  it('every recommended type is in the catalogue and carries the demand', () => {
    const demands: [number, number][] = [[1, 1], [2, 4], [2, 16], [3, 7], [7, 13], [8, 64], [16, 32], [24, 400], [48, 190], [64, 900], [96, 700]];
    for (const p of CLOUDS) {
      for (const [v, r] of demands) {
        for (const latest of [true, false]) {
          const c = chooseInstance(p, v, r, { families: ['general', 'compute', 'memory'], allowArm: false, latest, burstable: false });
          expect(c.fit).toBeDefined();
          expect(inCatalog(p, c.fit!.type)).toBe(true);
          expect(c.fit!.vcpu).toBeGreaterThanOrEqual(v);
          expect(c.fit!.ramGib).toBeGreaterThanOrEqual(r);
          for (const a of c.alternatives) expect(p === 'oci' ? inCatalog(p, a.split(':')[0]!) : inCatalog(p, a)).toBe(true);
        }
      }
    }
  });
  it('ranks by size, then ratio, then generation; x86 unless Arm is allowed', () => {
    const c = chooseInstance('aws', 7, 13, { families: ['general', 'compute', 'memory'], allowArm: false, latest: false, burstable: false });
    expect(/^c\d/.test(c.fit!.type)).toBe(true);
    expect(c.rejected).toContain('fails');
    const arm = chooseInstance('aws', 8, 32, { families: ['general'], allowArm: true, latest: true, burstable: false });
    expect(arm.alternatives.some((a) => instanceSpec('aws', a)?.arch === 'arm')).toBe(true);
    expect(instanceSpec('aws', arm.fit!.type)!.arch).toBe('x86');
  });
  it('licence-optimised hosts go through rightsizeFor (Azure constrained sizes are accepted)', () => {
    const c = chooseInstance('azure', 16, 128, { families: ['memory'], allowArm: false, latest: true, burstable: false, licenceOptimised: true });
    expect(c.fit!.type).toBe('Standard_E16-8ds_v5');
    expect(inCatalog('azure', c.fit!.type)).toBe(true);
  });
  it('VMware keeps the demand; OCI takes the exact Flex OCPUs', () => {
    expect(chooseInstance('vmware', 6, 20, { families: ['general'], allowArm: false, latest: true, burstable: false }).fit!.type).toBe('6x20GiB');
    const o = chooseInstance('oci', 6, 40, { families: ['general'], allowArm: false, latest: true, burstable: false });
    expect([o.fit!.type, o.fit!.ocpus, o.fit!.ramGib]).toEqual(['VM.Standard.E5.Flex', 3, 40]);
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const vol = (over: Partial<VolumeDemand> = {}): VolumeDemand => ({ server: 's', index: 1, os: false, provisionedGib: 300, sizeGib: 300, iops: 20000, mbps: 200, prod: true, latencyCritical: false, reasons: [], ...over });

describe('storage engine', () => {
  it('a 20,000 IOPS volume: io2 / PremiumV2 / hyperdisk-balanced / VPU 20', () => {
    expect(chooseTier('aws', vol({ latencyCritical: true })).fit!.tier.id).toBe('io2');
    expect(chooseTier('azure', vol()).fit!.tier.id).toBe('PremiumV2_LRS');
    expect(chooseTier('google', vol()).fit!.tier.id).toBe('hyperdisk-balanced');
    const oci = volumeRow('oci', vol({ mbps: 150 })); // VPU 20: 75 IOPS and 600 KB/s per GB
    expect(oci.row.detail['vpusPerGb']).toBe(20);
  });
  it('gp3 carries 20,000 IOPS since its 2025 limits (80,000): io2 only for latency-critical or above gp3', () => {
    const f = chooseTier('aws', vol()).fit!;
    expect([f.tier.id, f.provisionedIops]).toEqual(['gp3', 20000]);
    expect(chooseTier('aws', vol({ iops: 120000 })).fit!.tier.id).toBe('io2');
  });
  it('OS disks never on Premium SSD v2 / Ultra; nonprod may use Standard SSD; Hyperdisk-only series skip PD', () => {
    expect(chooseTier('azure', vol({ os: true, index: 0, iops: 400, mbps: 50, sizeGib: 128 })).fit!.tier.id).toBe('Premium_LRS');
    expect(chooseTier('azure', vol({ prod: false, iops: 300, mbps: 50, sizeGib: 100 })).fit!.tier.id).toBe('StandardSSD_LRS');
    expect(chooseTier('google', vol({ iops: 1000, mbps: 50, hyperdiskOnly: true })).fit!.tier.id).toBe('hyperdisk-balanced');
    expect(chooseTier('google', vol({ iops: 1000, mbps: 50 })).fit!.tier.id).toBe('pd-balanced');
  });
  it('provisioned tiers raise IOPS to reach throughput', () => {
    const f = chooseTier('aws', vol({ iops: 3000, mbps: 1000 })).fit!;
    expect(f.provisionedIops).toBe(4000);
    expect(f.provisionedMbps).toBe(1000);
  });
  it('volumes: capacity with growth, IOPS split by share with the boot disk at least 10 %', () => {
    const v = volumeDemands(physical, 'aws', policy());
    expect(v).toHaveLength(2);
    expect(v[1]!.sizeGib).toBe(Math.ceil(900 * 1.1 ** 3));
    expect(v[0]!.iops).toBe(Math.ceil(4000 * 0.1 * 1.3));
    expect(v[1]!.iops).toBe(Math.ceil(4000 * 0.9 * 1.3));
    const used = volumeDemands({ ...physical, facts: { ...physical.facts, disksUsedGib: [40, 300] } }, 'aws', policy({ diskBasis: 'used-plus-headroom', growthPctYear: 0 }));
    expect(used[1]!.sizeGib).toBe(390);
  });
  it('every tier the engine can pick has a source, and each platform\'s list is ordered cheapest first', () => {
    for (const p of CLOUDS) for (const t of STORAGE_TIERS[p]) expect(t.source.startsWith('https://')).toBe(true);
  });
  it('VMware volumes carry the vSAN policy and raw capacity', () => {
    const c = comp('app', { servers: ['v1'] });
    const r = sizeComponent(c, 'vmware', plan({ workloads: [workload('v1')] })).find((x) => x.concern === 'storage')!;
    expect(r.rows[1]!.detail['raid']).toBeDefined();
    expect(Number(r.rows[1]!.detail['rawGib'])).toBeGreaterThan(Number(r.rows[1]!.detail['sizeGib']));
  });
});

// ---------------------------------------------------------------------------
// Kubernetes
// ---------------------------------------------------------------------------

function fortyDeployments(): K8sWorkload[] {
  const out: K8sWorkload[] = [];
  for (let i = 0; i < 40; i += 1) {
    out.push({ name: `ns/app-${i}`, kind: i % 5 === 0 ? 'StatefulSet' : 'Deployment', replicas: 2 + (i % 4), cpuRequestM: 250 + (i % 3) * 250, cpuLimitM: 1000, memRequestMib: 512 + (i % 4) * 256, memLimitMib: 2048, arch: 'any', pool: i < 30 ? 'user' : 'batch' });
  }
  out.push({ name: 'kube-system/node-agent', kind: 'DaemonSet', replicas: 1, cpuRequestM: 100, cpuLimitM: 200, memRequestMib: 128, memLimitMib: 256, arch: 'any', pool: 'system' });
  return out;
}
const LZ = { vpc: '10.20.0.0/16', other: ['10.21.0.0/16', '10.244.0.0/16', '172.20.0.0/16'], used: ['10.20.0.0/20'], sites: ['192.168.0.0/16', '10.0.0.0/16'] };
const k8sSettings = (p: Platform): K8sSettings => ({
  targetUtil: 0.7, surge: 'one-node', cni: ({ aws: 'eks-vpc-cni-prefix', azure: 'aks-cni-overlay', google: 'gke-vpc-native', oci: 'oke-vcn-native', vmware: 'vks-antrea' } as const)[p],
  nodeVcpu: 8, zones: 3, prod: true, vpcCidr: LZ.vpc, avoid: [LZ.vpc, ...LZ.other, ...LZ.sites], used: LZ.used, ipv6: true,
});

describe('k8s engine', () => {
  for (const p of ['aws', 'azure', 'google', 'oci', 'vmware'] as const) {
    it(`${p}: 40 deployments → pools with allocatable × 0.7 ≥ requests, CNI pod density, ranges clear of the landing zone`, () => {
      const plan0 = planCluster(p, fortyDeployments(), k8sSettings(p), policy());
      expect(plan0.pools.length).toBeGreaterThanOrEqual(2);
      for (const pool of plan0.pools) {
        expect(pool.allocCpuM * 0.7 * pool.count).toBeGreaterThanOrEqual(pool.requestsCpuM);
        expect(pool.allocMemMib * 0.7 * pool.count).toBeGreaterThanOrEqual(pool.requestsMemMib);
        expect(pool.count).toBeGreaterThanOrEqual(3);
        expect(pool.max).toBe(Math.ceil(pool.count * 1.5));
        const rule = plan0.cni;
        expect(pool.podsPerNode).toBeLessThanOrEqual(Math.min(rule.maxPodsLimit, rule.nodeCeiling ? rule.nodeCeiling(instanceSpec(p as SpecPlatform, pool.type)) : Infinity));
        expect(Math.ceil(pool.pods / pool.count)).toBeLessThanOrEqual(pool.podsPerNode);
        if (p !== 'vmware') expect(inCatalog(p as SpecPlatform, pool.type)).toBe(true);
      }
      expect(plan0.findings.filter((f) => f.severity === 'error')).toEqual([]);
      for (const r of plan0.ip) {
        for (const x of [...LZ.other, ...LZ.sites, ...LZ.used]) expect(overlapsAny(r.cidr, x)).toBe(false);
        if (r.purpose.startsWith('nodes') || (r.purpose.startsWith('pods (zone') )) expect(overlapsAny(r.cidr, LZ.vpc)).toBe(true);
      }
      for (let i = 0; i < plan0.ip.length; i += 1) for (let j = i + 1; j < plan0.ip.length; j += 1) expect(overlapsAny(plan0.ip[i]!.cidr, plan0.ip[j]!.cidr)).toBe(false);
      expect(CONTROL_PLANE_TIERS[p].tiers.some((t) => t.id === plan0.tier && t.sla)).toBe(true);
    });
  }
  it('EKS without prefix delegation: max pods from the ENI limits', () => {
    const r = planCluster('aws', fortyDeployments(), { ...k8sSettings('aws'), cni: 'eks-vpc-cni', nodeVcpu: 2 }, policy());
    const pool = r.pools.find((x) => x.pool === 'user')!;
    expect(pool.podsPerNode).toBeLessThanOrEqual(CNI_RULES['eks-vpc-cni'].nodeCeiling!(instanceSpec('aws', pool.type)));
  });
  it('AKS picks Standard for production and warns on Free', () => {
    expect(planCluster('azure', fortyDeployments(), k8sSettings('azure'), policy()).tier).toBe('standard');
    const free = planCluster('azure', fortyDeployments(), { ...k8sSettings('azure'), tier: 'free' }, policy());
    expect(free.findings.map((f) => f.code)).toContain('size.k8s.tier-no-sla');
  });
  it('allocatable is capacity less reservation and eviction', () => {
    const a = allocatable('google', 8, 32, 110);
    expect(a.cpuMillis).toBe(8000 - (60 + 10 + 10 + 10));
    expect(Math.round(a.memMib)).toBe(Math.round(32 * 1024 - (4 * 0.25 + 4 * 0.2 + 8 * 0.1 + 16 * 0.06) * 1024 - 100));
  });
  it('the engine reads the grid from the component', () => {
    const c = comp('k8s', { tierPattern: 'containers', settings: { 'k8s.workloads': toGrid(fortyDeployments()), 'k8s.vpcCidr': LZ.vpc, 'k8s.lzCidrs': LZ.other.join(',') } });
    const r = sizeComponent(c, 'google', plan())[0]!;
    expect(r.concern).toBe('k8s');
    expect(r.rows.some((x) => x.key.startsWith('pool:c:shop:k8s:user'))).toBe(true);
    expect(r.rows.some((x) => x.key.startsWith('ip:') && x.detail['purpose'] === 'services')).toBe(true);
  });
});

describe('k8s import', () => {
  it('quantities', () => {
    expect([cpuMillis('500m'), cpuMillis('1'), cpuMillis('0.25'), cpuMillis('2000000n')]).toEqual([500, 1000, 250, 2]);
    expect([memMib('512Mi'), memMib('1Gi'), memMib('1G'), memMib('134217728')]).toEqual([512, 1024, 953.67, 128]);
  });
  it('parses a kubectl List, sums containers and keeps the init maximum', () => {
    const json = {
      apiVersion: 'v1', kind: 'List', items: [
        { kind: 'Deployment', metadata: { name: 'web', namespace: 'shop' }, spec: { replicas: 3, template: { spec: { containers: [{ resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } } }, { resources: { requests: { cpu: '50m', memory: '64Mi' } } }], initContainers: [{ resources: { requests: { cpu: '1', memory: '32Mi' } } }] } } } },
        { kind: 'DaemonSet', metadata: { name: 'agent', namespace: 'kube-system' }, spec: { template: { spec: { containers: [{ resources: { requests: { cpu: '100m', memory: '128Mi' } } }] } } } },
        { kind: 'StatefulSet', metadata: { name: 'db', namespace: 'shop' }, spec: { replicas: 1, template: { spec: { nodeSelector: { 'kubernetes.io/arch': 'arm64' }, containers: [{}] } } } },
        { kind: 'Service', metadata: { name: 'ignored' } },
      ],
    };
    const r = parseKubectlWorkloads(JSON.stringify(json));
    expect(r.workloads).toHaveLength(3);
    const web = r.workloads[0]!;
    expect([web.name, web.replicas, web.cpuRequestM, web.memRequestMib, web.cpuLimitM]).toEqual(['shop/web', 3, 1000, 320, 1050]);
    expect(r.workloads[1]!.pool).toBe('system');
    expect(r.workloads[2]!.arch).toBe('arm64');
    expect(r.findings.map((f) => f.code)).toContain('size.k8s.no-requests');
    const round = parseGrid(toGrid(r.workloads));
    expect(round.workloads).toEqual(r.workloads);
  });
});

// ---------------------------------------------------------------------------
// VCF
// ---------------------------------------------------------------------------

describe('vcf engine', () => {
  it('host counts are sizeWorkloadDomain\'s for the same input', () => {
    const o = vcfOptionsOf(undefined, policy(), 'wld01');
    for (const d of [{ vcpu: 400, ramGib: 1600, storageGib: 20000, vms: 60 }, { vcpu: 2400, ramGib: 12000, storageGib: 120000, vms: 400 }, { vcpu: 20, ramGib: 64, storageGib: 500, vms: 3 }]) {
      const mine = sizeVcfDemand(d, o);
      const page = sizeWorkloadDomain(vcfDomainInput(d, o));
      expect(mine.hosts).toBe(page.hosts);
      expect(mine.hosts).toBe(page.clusters[0]!.hosts);
    }
  });
  it('and fitCluster agrees when there is no growth', () => {
    const o = vcfOptionsOf(undefined, policy({ growthPctYear: 0 }), 'wld01');
    const d = { vcpu: 900, ramGib: 5000, storageGib: 60000, vms: 120 };
    const mine = sizeVcfDemand(d, o);
    const fit = fitCluster({ vcpu: d.vcpu, ramGib: d.ramGib, storageGib: d.storageGib }, { host: o.host, storage: o.storage, cpuRatio: o.cpuRatio, memoryCeiling: o.memoryCeiling, hostFailures: o.hostFailures, minimum: mine.fit.minimum });
    expect(fit.hosts).toBe(mine.hosts);
  });
  it('the engine row carries hosts, binding and licensed cores', () => {
    const ws = Array.from({ length: 30 }, (_, i) => workload(`vm${i}`, { vcpu: 8, ramGib: 64, disksGib: [80, 400] }));
    const c = comp('app', { servers: ws.map((w) => w.name) });
    const r = sizeComponent(c, 'vmware', plan({ workloads: ws })).find((x) => x.concern === 'vcf')!;
    const row = r.rows[0]!;
    expect(row.choice).toBe(`${row.detail['hosts']} hosts`);
    expect(Number(row.detail['billableCores'])).toBeGreaterThan(0);
    const page = sizeWorkloadDomain(vcfDomainInput({ vcpu: 240, ramGib: 30 * 64, storageGib: 30 * 480, vms: 30 }, vcfOptionsOf(c, policy(), 'wld-app')));
    expect(row.detail['hosts']).toBe(page.hosts);
  });
});

// ---------------------------------------------------------------------------
// Database, SAP, VDI, file, load
// ---------------------------------------------------------------------------

const db = (over: Partial<Database> = {}): Database => ({
  id: itemId('database', 'orders'), name: 'orders', engine: 'postgres', edition: 'community', version: 'pg-16', hosts: ['dbh'], vcpu: 8, ramGib: 64, sizeGib: 500,
  ha: 'pg-streaming', dr: 'none', features: [], licence: 'community', app: 'shop', source: 'manual', ...over,
});

describe('database engine', () => {
  it('RDS: a catalogued class, gp3 or io2, Multi-AZ for tier 1, read replicas by read %', () => {
    const p = plan({ workloads: [workload('dbh', { role: 'db', criticality: 'tier1' })], databases: [db({ pinService: 'aws-rds' })] });
    const c = comp('data', { databases: ['orders'], settings: { 'db.orders.read_pct': '70', 'db.orders.iops_p95': '5000' } });
    const r = sizeComponent(c, 'aws', p).find((x) => x.concern === 'database')!.rows[0]!;
    expect(classInCatalog('aws-rds', r.choice)).toBe(true);
    expect(r.detail['storageType']).toBe('io2');
    expect(r.detail['ha']).toBe('Multi-AZ');
    expect(r.detail['readReplicas']).toBe(2);
  });
  it('Azure SQL MI: Business Critical for tier 0', () => {
    const p = plan({ workloads: [workload('dbh', { role: 'db', criticality: 'tier0' })], databases: [db({ engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2022', ha: 'none', pinService: 'azure-sqlmi' })] });
    const r = sizeComponent(comp('data', { databases: ['orders'] }), 'azure', p).find((x) => x.concern === 'database')!.rows[0]!;
    expect(r.choice).toBe('BC_Gen5_8');
  });
  it('IaaS: the host type from the catalogue', () => {
    const p = plan({ workloads: [workload('dbh', { role: 'db' })], databases: [db()] });
    const r = sizeComponent(comp('data', { databases: ['orders'] }), 'google', p).find((x) => x.concern === 'database')!.rows[0]!;
    expect(r.detail['service']).toBe('google-gce');
    expect(inCatalog('google', r.choice)).toBe(true);
  });
});

describe('sap engine', () => {
  const input = { component: 'c:erp:hana', hanaMemoryGib: 1000, saps: 120000, ha: true, hanaHosts: [], appServers: [] };
  it('the smallest certified type per cloud, in the catalogue; SAPS → app servers on AWS', () => {
    for (const p of CLOUDS) {
      const r = sizeSap(input, p, policy());
      const hana = r.rows.find((x) => x.key.startsWith('sap-hana'))!;
      expect(hana.fits).toBe(true);
      expect(inCatalog(p, hana.choice)).toBe(true);
      expect(Number(hana.detail['certifiedMemoryGib'])).toBeGreaterThanOrEqual(1000);
    }
    const aws = sizeSap(input, 'aws', policy());
    const app = aws.rows.find((x) => x.key.startsWith('sap-app'))!;
    expect([app.choice, app.detail['count']]).toEqual(['r7i.8xlarge', 3]); // 120,000 / (66,480 × 0.65) = 2.78
    expect(aws.rows.find((x) => x.detail['mount'] === '/hana/log')!.detail['sizeGib']).toBe(500);
  });
  it('no certified type large enough → an error naming the largest', () => {
    const r = sizeSap({ ...input, hanaMemoryGib: 40000 }, 'azure', policy());
    expect(r.findings.find((f) => f.code === 'size.sap.no-certified')!.message).toContain('Standard_M416ms_v2');
  });
  it('VMware: a VM within the VCF 9 limit', () => {
    expect(/^\d+x1000GiB$/.test(sizeSap(input, 'vmware', policy()).rows[0]!.choice)).toBe(true);
    expect(sizeSap({ ...input, hanaMemoryGib: 20000 }, 'vmware', policy()).findings.map((f) => f.code)).toContain('size.sap.vcf-too-large');
  });
});

describe('vdi and file engines', () => {
  const vdi = { component: 'c:vdi:desk', users: 500, concurrentPct: 60, persona: 'medium' as const, persistent: false, profileGib: 30, gpu: false, hostVcpu: 16 };
  it('multi-session hosts from density; FSLogix profiles', () => {
    const r = sizeVdi(vdi, 'azure', policy());
    expect(r.rows[0]!.detail['hosts']).toBe(5); // 300 / 64
    expect(inCatalog('azure', r.rows[0]!.choice)).toBe(true);
    expect(r.rows[1]!.choice).toBe('18000 GiB');
    expect(sizeVdi(vdi, 'aws', policy()).rows[0]!.choice).toBe('WorkSpaces Pools Power');
    expect(sizeVdi({ ...vdi, persistent: true }, 'google', policy()).rows[0]!.detail['count']).toBe(500);
  });
  it('file services by capacity and throughput', () => {
    const f = { component: 'c:fs', tib: 10, users: 800, changePctDay: 2, protocol: 'smb' as const, ontap: false, regional: false };
    expect(sizeFile(f, 'aws', policy()).rows[0]!.choice).toBe('FSx for Windows 128 MB/s');
    expect(sizeFile(f, 'google', policy()).rows[0]!.choice).toContain('NetApp Volumes');
    expect(sizeFile({ ...f, protocol: 'nfs' }, 'google', policy()).rows[0]!.choice).toContain('Filestore');
    expect(sizeFile(f, 'oci', policy()).findings.map((x) => x.code)).toContain('size.file.oci-smb');
    expect(sizeFile(f, 'azure', policy()).rows[0]!.detail['provisionedIops']).toBeGreaterThan(3000);
  });
});

describe('load engine', () => {
  const load = { peakRps: 800, costClass: 'typical' as const, slo: '99.9' as const, dataGib: 200, growthPctYear: 20, horizonYears: 3 as const, tps: 300, environments: ['prod' as const, 'dev' as const], nonprodPct: 25 as const };
  const ap = (c: AppComponent): AppPlan => ({ app: 'a:new', origin: 'new', status: 'draft', variants: { aws: [c] }, answers: {}, landingZone: 'shared', load });
  it('instances from peak requests', () => {
    const c = comp('web', { tierPattern: 'vm' });
    const r = sizeFromLoad({ component: c, plan: plan({ appPlans: [ap(c)] }), load }, 'aws', policy());
    expect(r.rows[0]!.detail['instances']).toBe(17); // 800 / (40 × 2 × 0.6) = 16.7
    expect(r.rows[0]!.detail['nonprodInstances']).toBe(5);
  });
  it('constants flagged, zones from the SLO, and the database branch', () => {
    const c = comp('web', { tierPattern: 'vm' });
    const r = sizeFromLoad({ component: c, plan: plan({ appPlans: [ap(c)] }), load }, 'aws', policy());
    const row = r.rows[0]!;
    for (const x of row.reasons.filter((y) => !y.source)) expect(x.assumption).toBe(true);
    expect(row.reasons.filter((y) => y.assumption).every((y) => y.text.includes('replace with your load-test numbers'))).toBe(true);
    expect(inCatalog('aws', String(row.detail['type']))).toBe(true);
    const d = sizeFromLoad({ component: comp('db', { tierPattern: 'managed-db', tier: 'data' }), plan: plan(), load }, 'aws', policy()).rows[0]!;
    expect(d.detail['storageGib']).toBe(Math.ceil(200 * 1.2 ** 3 * 1.2));
    expect(d.detail['iops']).toBe(3000);
    expect(d.reasons.every((y) => y.assumption)).toBe(true);
    expect(Object.keys(LOAD_ASSUMPTIONS).length).toBeGreaterThan(10);
  });
  it('serverless and containers', () => {
    const fn = sizeFromLoad({ component: comp('fn', { tierPattern: 'serverless' }), plan: plan(), load }, 'aws', policy()).rows[0]!;
    expect(fn.detail['concurrency']).toBe(160);
    const k = sizeFromLoad({ component: comp('k', { tierPattern: 'containers', settings: { 'k8s.vpcCidr': '10.30.0.0/16' } }), plan: plan(), load }, 'azure', policy());
    expect(k.rows.some((x) => x.key.startsWith('pool:'))).toBe(true);
    for (const x of k.rows[0]!.reasons) expect(x.assumption).toBe(true);
  });
  it('the registry applies it to new apps only', () => {
    const c = comp('web', { tierPattern: 'vm' });
    const p = plan({ appPlans: [ap(c)] });
    expect(sizeComponent(c, 'aws', p).map((r) => r.concern)).toContain('load');
    expect(sizeComponent(comp('x', { tierPattern: 'vm' }), 'aws', p).map((r) => r.concern)).not.toContain('load');
  });
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

describe('overrides', () => {
  it('win over the engine; one below the demand is kept with a warning', () => {
    const c = comp('web', { servers: ['web1'] });
    const p0 = plan({ workloads: [workload('web1', { vcpu: 8, ramGib: 32 })] });
    const base = sizeComponent(c, 'aws', p0)[0]!;
    const small: SizingRecommendation = applyOverrides(base, { 'server:web1': 'm7i.large' });
    expect(small.rows[0]!.choice).toBe('m7i.large');
    expect(small.rows[0]!.fits).toBe(false);
    expect(small.findings.map((f) => f.code)).toContain('size.override-below-demand');
    const p1 = plan({ ...p0, sizing: { policy: DEFAULT_SIZING_POLICY as SizingPolicy, overrides: { 'server:web1': 'r7i.2xlarge' } } });
    const big = sizeComponent(c, 'aws', p1)[0]!.rows[0]!;
    expect([big.choice, big.fits, big.detail['engineChoice']]).toEqual(['r7i.2xlarge', true, base.rows[0]!.choice]);
  });
});
