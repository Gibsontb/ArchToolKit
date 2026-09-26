/**
 * The VCF 9.1 / 9.1.1 sizing audit: every correctness fix and every capability
 * added after it. Figures cite the audit's source ids (S1 … S24), whose URLs
 * live in `SOURCES` in sizing-data.ts.
 */
import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  sizeDeployment,
  sizeFleet,
  sizeWorkloadCluster,
  sizeWorkloadDomain,
  sizeRecoverySite,
  recommendHostCount,
  minimumHosts,
  computeCapacity,
  computeLicensing,
  computeFleetLicensing,
  computeIpRequirements,
  computeStorage,
  managementBreakdown,
  projectGrowth,
  logManagementPlan,
  additionalInstanceInput,
  type SizingInput,
  type HostSpec,
  type WorkloadClusterInput,
} from './sizing.ts';
import {
  SOURCES,
  VCENTER_SIZES,
  VCENTER_CAPACITY,
  VCENTER_DISK_GIB,
  LICENSE_SERVER,
  OPS_COLLECTOR_SIZES,
  VCFMS_FOOTPRINT,
  FLEET_FIRST_INSTANCE_911,
  VSAN_OPERATIONS_RESERVE_DEFAULT,
  PROFILE_AUTOMATION,
  AUTOMATION_NODE_SIZES,
  NSX_MANAGER_SIZES,
  SUPERVISOR_CP_SIZES,
  PROTECTION_RECOVERY,
  HCX_APPLIANCES,
  OPS_NETWORKS_PLATFORM,
  OPS_NETWORKS_COLLECTOR,
  AVI_CONTROLLER_SIZES,
  CONVERGE_STRETCHED_UNCONFIRMED,
  MANAGEMENT_TOPOLOGIES,
  fleetEntry,
  vcfRelease,
  profilesForRelease,
  raidOverhead,
  haReserveFraction,
  vcenterSizeFor,
  type Basis,
} from './sizing-data.ts';
import { automationIpCount } from './version.ts';
import { sizingToPlan } from './bridge.ts';
import { planEstate, sourceClusters } from './estate-plan.ts';
import { emptyInventory, type Inventory, type InventoryHost, type InventoryVm } from '../vmware/inventory.ts';

const BIG_HOST: HostSpec = { cpuSockets: 2, coresPerCpu: 32, hyperthreading: true, ramGib: 1024, rawStorageGib: 15360 };

function input(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    path: 'greenfield',
    profile: 'simple',
    instanceCount: 1,
    topology: 'standard',
    storage: 'vsan-esa',
    hostCount: 4,
    host: BIG_HOST,
    ...overrides,
  };
}

function codes(r: { findings: readonly { code: string }[] }): string[] {
  return r.findings.map((f) => f.code);
}

// ---------------------------------------------------------------------------

describe('target version: 9.1.0 vs 9.1.1', () => {
  it('defaults to 9.1.1 and reads partial and full version strings', () => {
    expect(vcfRelease(undefined)).toBe('9.1.1');
    expect(vcfRelease('9.1.0')).toBe('9.1.0');
    expect(vcfRelease('9.1.0.400')).toBe('9.1.0');
    expect(vcfRelease('9.1.1.0')).toBe('9.1.1');
    expect(sizeDeployment(input()).release).toBe('9.1.1');
    expect(sizeDeployment(input()).version).toBe('9.1.1.0');
  });

  it('has no HA-Small on 9.1.0', () => {
    expect(profilesForRelease('9.1.0').includes('ha-small')).toBe(false);
    expect(profilesForRelease('9.1.1').includes('ha-small')).toBe(true);
    expect(fleetEntry('9.1.0', 'ha-small', 'first')).toBeUndefined();
    const r = sizeDeployment(input({ profile: 'ha-small', version: '9.1.0' }));
    expect(codes(r)).toContain('vcf.profile.not-in-release');
  });

  it('takes the 9.1.1 fleet table from the 9.1.1 workbook, which matches S1', () => {
    const e = fleetEntry('9.1.1', 'simple', 'first');
    expect(e?.vcpu).toBe(76);
    expect(e?.ramGib).toBe(251);
    expect(e?.diskGib).toBe(7448);
    expect(e?.basis).toBe('published');
    expect(e?.sourceUrl).toBe(SOURCES.workbook911);
    expect(e?.note?.includes('Matches TechDocs')).toBe(true);
    // Two additional-instance disks disagree with S1 by 100 GB; the workbook wins and the note says so.
    expect(fleetEntry('9.1.1', 'simple', 'additional')?.diskGib).toBe(4662);
    expect(fleetEntry('9.1.1', 'simple', 'additional')?.note?.includes('4562')).toBe(true);
  });

  it('sizes 9.1.0 from the 9.1 workbook: Simple has the third VCFMS worker', () => {
    const r = sizeDeployment(input({ version: '9.1.0' }));
    expect(r.managementFootprint.vcpu).toBe(76 + 12);
    expect(r.managementFootprint.ramGib).toBe(251 + 24);
    expect(fleetEntry('9.1.0', 'simple', 'first')?.basis).toBe('published');
    expect(fleetEntry('9.1.0', 'simple', 'first')?.sourceUrl).toBe(SOURCES.workbook910);
    expect(codes(r)).not.toContain('vcf.fleet.figure-not-published');
  });

  it('gives the 9.1.0 HA and additional-instance figures the 9.1 workbook computes', () => {
    const f = (p: 'ha-medium' | 'ha-large', role: 'first' | 'additional') => {
      const e = fleetEntry('9.1.0', p, role);
      return [e?.vcpu, e?.ramGib, e?.diskGib];
    };
    expect(f('ha-medium', 'first')).toEqual([220, 728, 11445]);
    expect(f('ha-large', 'first')).toEqual([330, 1013, 15457]);
    expect(f('ha-medium', 'additional')).toEqual([98, 292, 5813]);
    expect(f('ha-large', 'additional')).toEqual([160, 433, 8421]);
    expect(fleetEntry('9.1.0', 'simple', 'additional')?.vcpu).toBe(46);
  });

  it('splits management services by version, from the workbooks', () => {
    expect(VCFMS_FOOTPRINT['9.1.0'].simple.vcpu).toBe(40);
    expect(VCFMS_FOOTPRINT['9.1.0'].simple.ramGib).toBe(82);
    expect(VCFMS_FOOTPRINT['9.1.0'].simple.diskGib).toBe(3000);
    expect(VCFMS_FOOTPRINT['9.1.0'].ha.vcpu).toBe(84);
    expect(VCFMS_FOOTPRINT['9.1.0'].ha.ramGib).toBe(174);
    expect(VCFMS_FOOTPRINT['9.1.1'].simple.vcpu).toBe(28);
    expect(VCFMS_FOOTPRINT['9.1.1'].simple.ramGib).toBe(58);
    expect(VCFMS_FOOTPRINT['9.1.1'].ha.vcpu).toBe(48);
    expect(VCFMS_FOOTPRINT['9.1.1'].ha.ramGib).toBe(102);
    expect(VCFMS_FOOTPRINT['9.1.1'].simple.basis).toBe('published');
    expect(VCFMS_FOOTPRINT['9.1.1'].ha.basis).toBe('published');
  });

  it('takes the Automation pool from the one version rule', () => {
    expect(computeIpRequirements(input({ version: '9.1.0' })).automationIps).toBe(automationIpCount('9.1.0.0'));
    expect(computeIpRequirements(input({ version: '9.1.0.400' })).automationIps).toBe(6);
    expect(computeIpRequirements(input()).automationIps).toBe(automationIpCount('9.1.1.0'));
  });
});

describe('appliance figures corrected from the report', () => {
  it('uses the 9.1 vCenter disk sizes and X-Large capacity', () => {
    expect([VCENTER_SIZES.tiny, VCENTER_SIZES.small, VCENTER_SIZES.medium, VCENTER_SIZES.large, VCENTER_SIZES.xlarge].map((v) => v.diskGib)).toEqual([619, 734, 933, 1383, 2308]);
    expect(VCENTER_SIZES.small.verification).toBe('V-DOC');
    expect(VCENTER_DISK_GIB.xlarge.xlarge).toBe(4668);
    expect(VCENTER_DISK_GIB.tiny.large).toBe(2059);
    expect(VCENTER_CAPACITY.xlarge).toEqual({ hosts: 2000, vms: 35000 });
  });

  it('uses the workbook License Server size, noting the TechDocs 8 GB', () => {
    expect([LICENSE_SERVER.vcpu, LICENSE_SERVER.ramGib, LICENSE_SERVER.diskGib]).toEqual([2, 4, 12]);
    expect(LICENSE_SERVER.basis).toBe('published');
    expect(LICENSE_SERVER.sourceUrl).toBe(SOURCES.workbook911);
    expect(LICENSE_SERVER.note?.includes('8 GB')).toBe(true);
  });

  it('uses the 9.1 cloud proxy sizes', () => {
    expect([OPS_COLLECTOR_SIZES.small.vcpu, OPS_COLLECTOR_SIZES.small.ramGib]).toEqual([4, 16]);
    expect([OPS_COLLECTOR_SIZES.standard.vcpu, OPS_COLLECTOR_SIZES.standard.ramGib]).toEqual([8, 48]);
  });

  it('breaks every profile down appliance by appliance, adding up to the fleet total', () => {
    for (const release of ['9.1.0', '9.1.1'] as const) {
      for (const p of profilesForRelease(release)) {
        for (const role of ['first', 'additional'] as const) {
          const lines = managementBreakdown(release, p, role);
          const sum = lines.reduce((s, l) => [s[0] + l.footprint.vcpu, s[1] + l.footprint.ramGib, s[2] + l.footprint.diskGib], [0, 0, 0]);
          const e = fleetEntry(release, p, role);
          expect(sum).toEqual([e?.vcpu, e?.ramGib, e?.diskGib]);
          for (const l of lines) expect(l.basis).toBe('published');
        }
      }
    }
    const simple = managementBreakdown(undefined, 'simple');
    const workers = simple.find((l) => l.name.startsWith('VCF management services worker'));
    expect(workers?.footprint.vcpu).toBe(24);
    expect(workers?.name.endsWith('× 2')).toBe(true);
  });
});

describe('management domain host minimums by profile', () => {
  const m = (storage: SizingInput['storage'], topology: SizingInput['topology'], profile: SizingInput['profile'], path: SizingInput['path'] = 'greenfield') =>
    minimumHosts({ path, storage, topology, profile }).hosts;

  it('follows the Single-Rack and Stretched cluster models', () => {
    expect(m('vsan-esa', 'standard', 'simple')).toBe(3);
    expect(m('vsan-esa', 'standard', 'ha-small')).toBe(4);
    expect(m('nfs', 'standard', 'simple')).toBe(2);
    expect(m('vmfs-fc', 'standard', 'ha-large')).toBe(4);
    expect(m('vsan-esa', 'stretched', 'simple')).toBe(6);
    expect(m('vsan-esa', 'stretched', 'ha-medium')).toBe(8);
    // Converge needs what greenfield does; HA needs 4.
    expect(m('vsan-esa', 'standard', 'ha-medium', 'brownfield-converge')).toBe(4);
    expect(m('nfs', 'standard', 'simple', 'brownfield-converge')).toBe(2);
  });

  it('gives workload-domain minimums: 3 vSAN, 2 external, 6 stretched', () => {
    expect(minimumHosts({ path: 'brownfield-import', storage: 'vsan-esa', topology: 'standard' }).hosts).toBe(3);
    expect(minimumHosts({ path: 'greenfield', storage: 'nfs', topology: 'standard', role: 'workload' }).hosts).toBe(2);
    expect(minimumHosts({ path: 'greenfield', storage: 'vsan-osa', topology: 'stretched', role: 'workload' }).hosts).toBe(6);
  });

  it('follows S5 for a converged stretched cluster and reports the 4-host claim as unconfirmed', () => {
    expect(CONVERGE_STRETCHED_UNCONFIRMED.basis).toBe('unconfirmed');
    const r = sizeDeployment(input({ path: 'brownfield-converge', topology: 'stretched', hostCount: 4 }));
    expect(r.hostMinimum.hosts).toBe(6);
    expect(codes(r)).toContain('vcf.hosts.converge-stretched-unconfirmed');
    expect(codes(r)).toContain('vcf.hosts.below-minimum');
  });

  it('reports the HA reserve share: 33%, 25%, 50%', () => {
    expect(haReserveFraction(3, 1)).toBeCloseTo(1 / 3, 5);
    expect(haReserveFraction(4, 1)).toBe(0.25);
    expect(haReserveFraction(2, 1)).toBe(0.5);
    expect(computeCapacity(4, BIG_HOST, 1).haReserveFraction).toBe(0.25);
  });

  it('offers N+2', () => {
    const r = sizeDeployment(input({ hostFailuresToTolerate: 2 }));
    expect(r.capacity.survivingHosts).toBe(2);
    expect(r.capacity.hostFailuresReserved).toBe(2);
    expect(r.storage.availableRawGib).toBe(2 * 15360);
  });

  it('flags a 2-node management domain and does not offer it', () => {
    expect(MANAGEMENT_TOPOLOGIES.includes('two-node')).toBe(false);
    expect(codes(sizeDeployment(input({ topology: 'two-node', hostCount: 2 })))).toContain('vcf.topology.two-node-management');
  });

  it('marks a 2-node workload-domain cluster unconfirmed', () => {
    expect(minimumHosts({ path: 'brownfield-import', storage: 'vsan-esa', topology: 'two-node' }).basis).toBe('unconfirmed');
    const c = sizeWorkloadCluster({ vcpu: 10, ramGib: 10, storageGib: 0, host: BIG_HOST, storage: 'vsan-esa', topology: 'two-node' });
    expect(codes(c)).toContain('vcf.wld.two-node-unconfirmed');
  });
});

describe('vSAN per architecture', () => {
  it('ESA stretched with fewer than 3 hosts per site is a 2.0x site mirror', () => {
    const r = raidOverhead('stretched', 2, 'esa');
    expect(r.multiplier).toBe(2.0);
    expect(r.ftt).toBe(0);
    expect(raidOverhead('stretched', 3, 'esa').multiplier).toBe(3.0);
  });

  it('ESA under 3 hosts is FTT=0 and not valid, and the engine flags it', () => {
    const r = raidOverhead('standard', 2, 'esa');
    expect(r.multiplier).toBe(1.0);
    expect(r.valid).toBe(false);
    expect(codes(sizeDeployment(input({ hostCount: 2 })))).toContain('vcf.vsan.under-three-hosts');
  });

  it('OSA has no Auto-RAID: RAID-1 2x at 3 hosts, RAID-5 (3+1) 1.33x from 4', () => {
    expect(raidOverhead('standard', 3, 'osa').multiplier).toBe(2.0);
    expect(raidOverhead('standard', 4, 'osa').multiplier).toBeCloseTo(4 / 3, 5);
    expect(raidOverhead('standard', 4, 'osa').raid).toBe('RAID-5 (3+1)');
    expect(raidOverhead('standard', 8, 'osa', 'raid6-ftt2').multiplier).toBe(1.5);
    expect(raidOverhead('standard', 5, 'osa', 'raid6-ftt2').valid).toBe(false);
    expect(raidOverhead('standard', 5, 'osa', 'raid1-ftt2').multiplier).toBe(3.0);
    expect(raidOverhead('stretched', 4, 'osa').multiplier).toBeCloseTo(8 / 3, 5);
    // ESA keeps 1.5x at the same host counts.
    expect(raidOverhead('standard', 4, 'esa').multiplier).toBe(1.5);
  });

  it('sizes a vsan-osa cluster with the OSA policy', () => {
    const esa = sizeDeployment(input({ storage: 'vsan-esa', hostCount: 3 }));
    const osa = sizeDeployment(input({ storage: 'vsan-osa', hostCount: 3 }));
    expect(esa.storage.multiplier).toBe(1.5);
    expect(osa.storage.multiplier).toBe(2.0);
    expect(osa.storage.architecture).toBe('osa');
  });

  it('applies a dedup ratio and an optional operations reserve', () => {
    const plain = computeStorage('vsan-esa', 'standard', 4, BIG_HOST, 1, 10000);
    const dedup = computeStorage('vsan-esa', 'standard', 4, BIG_HOST, 1, 10000, { dedupRatio: 2 });
    const reserve = computeStorage('vsan-esa', 'standard', 4, BIG_HOST, 1, 10000, { operationsReserve: 0.1 });
    expect(plain.rawRequiredGib).toBe(15000);
    expect(dedup.rawRequiredGib).toBe(7500);
    expect(reserve.rawRequiredGib).toBeCloseTo(15000 / 0.9, 3);
    expect(plain.effectiveCapacityGib).toBe((3 * 15360) / 1.5);
  });
});

describe('no double slack', () => {
  it('holds back only the failure host(s) as the rebuild reserve', () => {
    const r = sizeDeployment(input({ workloadCapacityGib: 10000 }));
    expect(r.storage.slackFraction).toBe(0);
    expect(VSAN_OPERATIONS_RESERVE_DEFAULT).toBe(0);
    expect(r.storage.rawRequiredGib).toBe((7448 + 10000) * 1.5);
    expect(r.storage.availableRawGib).toBe(3 * 15360);
    expect(r.storage.rebuildReserveGib).toBe(15360);
    // The provenance note says no percentage is published rather than inventing one.
    expect(r.storage.note.includes('no operations reserve is added')).toBe(true);
    expect(r.storage.basis === 'published').toBe(false);
  });

  it('offers the workbook model: swap, ×1.3 reserve, ×1.1 growth, N-1 hosts', () => {
    const r = sizeDeployment(input({ vsan: { model: 'workbook' } }));
    expect(r.storage.rawRequiredGib).toBeCloseTo((7448 + 251) * 1.5 * 1.3 * 1.1, 3);
    expect(r.storage.availableRawGib).toBe(3 * 15360);
    expect(r.storage.slackFraction).toBe(0.3);
    expect(r.storage.basis).toBe('published');
  });
});

describe('CPU on physical cores with one host down', () => {
  it('ignores hyperthreading and measures on the surviving hosts', () => {
    const on = sizeDeployment(input({ host: { ...BIG_HOST, hyperthreading: true } }));
    const off = sizeDeployment(input({ host: { ...BIG_HOST, hyperthreading: false } }));
    expect(on.cpuRatio).toBe(off.cpuRatio);
    expect(on.capacity.usablePhysicalCores).toBe(3 * 64);
    expect(on.cpuRatio).toBeCloseTo(76 / 192, 5);
  });

  it('warns past 2:1 and the recommended size respects it', () => {
    const narrow: HostSpec = { cpuSockets: 1, coresPerCpu: 16, hyperthreading: true, ramGib: 2048, rawStorageGib: 30000 };
    const i = input({ profile: 'ha-large', host: narrow });
    const hosts = recommendHostCount(i);
    expect(hosts).toBe(11); // 298 vCPU / 2 = 149 cores = 10 surviving 16-core hosts, plus N+1
    const r = sizeDeployment({ ...i, hostCount: hosts ?? 0 });
    expect(r.cpuRatio <= 2).toBe(true);
    expect(codes(r)).not.toContain('vcf.cpu.over-target-ratio');
    expect(codes(sizeDeployment({ ...i, hostCount: 10 }))).toContain('vcf.cpu.over-target-ratio');
  });

  it('reserves a whole AZ on a stretched cluster', () => {
    const r = sizeDeployment(input({ topology: 'stretched', hostCount: 6 }));
    expect(r.capacity.survivingHosts).toBe(3);
    expect(r.capacity.haReserveFraction).toBe(0.5);
  });
});

describe('each VCF instance is its own management domain', () => {
  it('sizes a fleet per instance with its own hosts, IPs and licensing', () => {
    const fleet = sizeFleet({ instances: [input({ hostCount: 4 }), input({ hostCount: 3 })] });
    expect(fleet.instances.length).toBe(2);
    const [first, second] = fleet.instances;
    expect(first?.managementFootprint.vcpu).toBe(76);
    expect(second?.role).toBe('additional');
    expect(second?.managementFootprint.vcpu).toBe(34);
    expect(second?.ips.componentFqdns).toBe(6);
    expect(second?.ips.automationIps).toBe(0);
    expect(fleet.totals.managementHosts).toBe(7);
    expect(fleet.licensing.billableCores).toBe(7 * 64);
    expect(fleet.totals.ipsMinimum).toBe((first?.ips.totalMinimum ?? 0) + (second?.ips.totalMinimum ?? 0));
  });

  it('gives additional instances their own minimum rather than stacking them', () => {
    const r = sizeDeployment(input({ instanceCount: 3 }));
    expect(r.managementFootprint.vcpu).toBe(76);
    expect(r.fleet?.totals.instances).toBe(3);
    // Each additional Simple instance needs at least the 3-host minimum.
    for (const inst of r.fleet?.instances.slice(1) ?? []) expect(inst.input.hostCount >= 3).toBe(true);
    expect(r.fleet?.totals.hosts).toBe(4 + 3 + 3);
    expect(additionalInstanceInput(input({ profile: 'ha-medium' })).hostCount >= 4).toBe(true);
  });

  it('uses 6 / 8 component FQDNs for an additional instance', () => {
    expect(computeIpRequirements(input({ instanceRole: 'additional' })).componentFqdns).toBe(6);
    expect(computeIpRequirements(input({ instanceRole: 'additional', profile: 'ha-large' })).componentFqdns).toBe(8);
  });
});

describe('workload domains', () => {
  it('put a vCenter sized by hosts and VMs, and a dedicated NSX Manager cluster, in the management domain', () => {
    const base = sizeDeployment(input());
    const r = sizeDeployment(input({ workloadDomains: [{ name: 'wld01', hosts: 10, vms: 200 }] }));
    const nsx = NSX_MANAGER_SIZES.medium;
    expect(r.workloadDomains[0]?.vcenterSize).toBe('small');
    expect(r.totalDemand.vcpu - base.totalDemand.vcpu).toBe(VCENTER_SIZES.small.vcpu + 3 * nsx.vcpu);
    expect(r.totalDemand.ramGib - base.totalDemand.ramGib).toBe(VCENTER_SIZES.small.ramGib + 3 * nsx.ramGib);
  });

  it('adds only the vCenter when NSX is shared', () => {
    const r = sizeDeployment(input({ workloadDomains: [{ name: 'a', hosts: 3 }, { name: 'b', hosts: 3, nsx: 'shared' }] }));
    expect(r.workloadDomains[1]?.overheadFootprint.vcpu).toBe(VCENTER_SIZES.tiny.vcpu);
  });

  it('picks the vCenter size by capacity and warns when a chosen size is too small', () => {
    expect(vcenterSizeFor(10, 100)).toBe('tiny');
    expect(vcenterSizeFor(500, 1000)).toBe('large');
    expect(vcenterSizeFor(2001, 10)).toBeUndefined();
    const d = sizeWorkloadDomain({ hosts: 150, vms: 500, vcenterSize: 'small' });
    expect(codes(d)).toContain('vcf.wld.vcenter-too-small');
  });

  it('require a stretched management domain for a stretched workload cluster', () => {
    const cluster: WorkloadClusterInput = { vcpu: 100, ramGib: 100, storageGib: 100, host: BIG_HOST, storage: 'vsan-esa', topology: 'stretched' };
    const r = sizeDeployment(input({ workloadDomains: [{ clusters: [cluster] }] }));
    expect(codes(r)).toContain('vcf.wld.stretched-needs-stretched-management');
  });
});

describe('manual workload-domain cluster sizing', () => {
  const demand: WorkloadClusterInput = { name: 'app', vcpu: 1000, ramGib: 4000, storageGib: 50000, host: BIG_HOST, storage: 'vsan-esa' };

  it('finds the smallest cluster and what binds it', () => {
    const c = sizeWorkloadCluster(demand);
    expect(c.byCpu).toBe(5); // 1000 / (4 × 64) → 4 surviving + 1
    expect(c.byMemory).toBe(6); // 4000 / (0.9 × 1024) → 5 surviving + 1
    expect(c.byStorage).toBe(6); // 50000 × 1.5 / 15360 → 5 surviving + 1
    expect(c.hosts).toBe(6);
    expect(c.minimum).toBe(3);
  });

  it('adds a host for N+2 and honours the minimum', () => {
    expect(sizeWorkloadCluster({ ...demand, hostFailures: 2 }).hosts).toBe(7);
    expect(sizeWorkloadCluster({ ...demand, vcpu: 1, ramGib: 1, storageGib: 0 }).hosts).toBe(3);
    expect(sizeWorkloadCluster({ ...demand, vcpu: 1, ramGib: 1, storageGib: 0, storage: 'nfs' }).hosts).toBe(2);
  });

  it('checks a fixed host count', () => {
    const c = sizeWorkloadCluster({ ...demand, hosts: 4 });
    expect(c.binding).toBe('fixed');
    expect(codes(c)).toContain('vcf.wld.memory');
  });

  it('places edges and Supervisor control planes in the domain’s first cluster', () => {
    const d = sizeWorkloadDomain({
      clusters: [{ ...demand, vcpu: 0, ramGib: 0, storageGib: 0 }],
      edgeCluster: { size: 'large', nodes: 2 },
      supervisor: { count: 1, size: 'small', controlPlaneVms: 3 },
    });
    const c = d.clusters[0];
    expect(c?.demand.vcpu).toBe(2 * 8 + 3 * SUPERVISOR_CP_SIZES.small.vcpu);
    expect(c?.demand.ramGib).toBe(2 * 32 + 3 * 16);
    expect(d.edgeTepIps).toBe(4);
    expect(SUPERVISOR_CP_SIZES.tiny).toEqual({ ...SUPERVISOR_CP_SIZES.tiny, vcpu: 2, ramGib: 8, diskGib: 48 });
    expect([SUPERVISOR_CP_SIZES.medium.vcpu, SUPERVISOR_CP_SIZES.medium.ramGib, SUPERVISOR_CP_SIZES.large.vcpu, SUPERVISOR_CP_SIZES.large.ramGib]).toEqual([8, 24, 16, 32]);
    expect([SUPERVISOR_CP_SIZES.xlarge.vcpu, SUPERVISOR_CP_SIZES.xlarge.ramGib]).toEqual([32, 64]);
  });

  it('applies growth over years', () => {
    const grown = sizeWorkloadCluster({ ...demand, growth: { cpuPct: 10, ramPct: 10, storagePct: 10, years: 2 } });
    expect(grown.demand.vcpu).toBeCloseTo(1000 * 1.21, 5);
    expect(grown.hosts >= 6).toBe(true);
  });

  it('adds a witness for a stretched vSAN cluster, marked unconfirmed', () => {
    const c = sizeWorkloadCluster({ ...demand, topology: 'stretched' });
    expect(c.witness?.basis).toBe('unconfirmed');
    expect(c.hosts % 2).toBe(0);
    expect(c.hosts >= 6).toBe(true);
  });
});

describe('VCF Automation changes the footprint', () => {
  it('subtracts the profile’s Automation when excluded', () => {
    const r = sizeDeployment(input({ includeAutomation: false }));
    expect(r.managementFootprint.vcpu).toBe(76 - 24);
    expect(r.managementFootprint.ramGib).toBe(251 - 96);
    expect(r.ips.automationIps).toBe(0);
    expect(r.automation.included).toBe(false);
  });

  it('adds the difference for a size above the default', () => {
    const r = sizeDeployment(input({ automationSize: 'large' }));
    const delta = AUTOMATION_NODE_SIZES.large.vcpu - AUTOMATION_NODE_SIZES.small.vcpu;
    expect(r.managementFootprint.vcpu).toBe(76 + delta);
    expect(r.managementFootprint.diskGib).toBe(7448 + 1200 - 600);
    expect(r.automation.basis).toBe('published');
    expect(codes(r)).not.toContain('vcf.automation.size-unconfirmed');
  });

  it('adds nodes: 3 nodes on HA-Small is two more than its 1 × Small (workbook; S1 says Medium)', () => {
    expect(PROFILE_AUTOMATION['ha-small']).toEqual({ size: 'small', nodes: 1 });
    const r = sizeDeployment(input({ profile: 'ha-small', automationNodes: 3 }));
    expect(r.managementFootprint.vcpu).toBe(106 + 2 * AUTOMATION_NODE_SIZES.small.vcpu);
  });

  it('leaves the published total alone at the profile default', () => {
    const r = sizeDeployment(input({ profile: 'ha-large', automationSize: 'large', hostCount: 8 }));
    expect(r.managementFootprint.vcpu).toBe(298);
    expect(r.verification).toBe('V-DOC');
  });

  it('checks the per-node vCPU of the chosen size', () => {
    const host: HostSpec = { cpuSockets: 1, coresPerCpu: 14, hyperthreading: true, ramGib: 1024, rawStorageGib: 20000 };
    expect(codes(sizeDeployment(input({ host })))).not.toContain('vcf.automation.host-too-small');
    expect(codes(sizeDeployment(input({ host, automationSize: 'large' })))).toContain('vcf.automation.host-too-small');
    expect(codes(sizeDeployment(input({ host: { ...host, coresPerCpu: 8 }, includeAutomation: false })))).not.toContain('vcf.automation.host-too-small');
  });
});

describe('addresses', () => {
  it('counts 13 component FQDNs for Simple, 17 for HA, 18 with a load balancer', () => {
    expect(computeIpRequirements(input()).componentFqdns).toBe(13);
    expect(computeIpRequirements(input({ profile: 'ha-small' })).componentFqdns).toBe(17);
    expect(computeIpRequirements(input({ profile: 'ha-small', loadBalancer: true })).componentFqdns).toBe(18);
  });

  it('gives VMFS on FC hosts two VMkernel addresses, vSAN and NFS three', () => {
    expect(computeIpRequirements(input({ storage: 'vmfs-fc' })).hostIps).toBe(8);
    expect(computeIpRequirements(input({ storage: 'nfs' })).hostIps).toBe(12);
  });

  it('hands the builder the same version and Automation count', () => {
    const plan = sizingToPlan(sizeDeployment(input({ version: '9.1.0' })));
    expect(plan.version).toBe('9.1.0.0');
    expect(plan.automationPool?.count).toBe(automationIpCount('9.1.0.0'));
    expect(sizingToPlan(sizeDeployment(input({ includeAutomation: false }))).automationPool).toBeUndefined();
  });
});

describe('licensing', () => {
  it('includes 1 TiB of vSAN per licensed core and the add-on beyond it', () => {
    const host: HostSpec = { cpuSockets: 2, coresPerCpu: 16, hyperthreading: false, ramGib: 512, rawStorageGib: 40 * 1024 };
    const l = computeLicensing(4, host, false, true);
    expect(l.billableCores).toBe(128);
    expect(l.vsanEntitlementTib).toBe(128);
    expect(l.vsanRawTib).toBe(160);
    expect(l.vsanAddOnTib).toBe(32);
    expect(codes(sizeDeployment(input({ host }))).includes('vcf.licensing.vsan-addon')).toBe(true);
    expect(computeLicensing(4, host, false, false).vsanRawTib).toBe(0);
  });

  it('bills 16 cores per CPU, 8 for VCF Edge, and checks the Edge rules', () => {
    const small: HostSpec = { cpuSockets: 1, coresPerCpu: 6, hyperthreading: false, ramGib: 256, rawStorageGib: 0 };
    expect(computeLicensing(3, small).billableCores).toBe(48);
    expect(computeLicensing(3, small, true).billableCores).toBe(24);
    const fleet = computeFleetLicensing([{ name: 'site-1', hosts: 3, host: small, vsan: false }], { vcfEdge: true });
    expect(fleet.findings.map((f) => f.code)).toContain('vcf.licensing.edge-host-cores');
    expect(fleet.findings.map((f) => f.code)).toContain('vcf.licensing.edge-sites');
    const big = computeFleetLicensing([{ name: 's', hosts: 5, host: BIG_HOST, vsan: false, site: 'x' }], { vcfEdge: true, sites: 12 });
    expect(big.findings.map((f) => f.code)).toContain('vcf.licensing.edge-site-cores');
  });

  it('covers the whole fleet: management domains and workload clusters, with a term', () => {
    const cluster: WorkloadClusterInput = { name: 'app', vcpu: 1000, ramGib: 4000, storageGib: 50000, host: BIG_HOST, storage: 'vsan-esa' };
    const fleet = sizeFleet({
      instances: [input({ workloadDomains: [{ name: 'wld01', clusters: [cluster] }] }), input({ hostCount: 3 })],
      subscriptionYears: 3,
    });
    expect(fleet.totals.workloadHosts).toBe(6);
    expect(fleet.totals.hosts).toBe(4 + 3 + 6);
    expect(fleet.licensing.billableCores).toBe(13 * 64);
    expect(fleet.licensing.coreYears).toBe(13 * 64 * 3);
    expect(fleet.licensing.items.length).toBe(3);
  });
});

describe('add-on components', () => {
  it('sizes log management as Day-N load on the VCFMS workers, as the workbook does', () => {
    // Simple 9.1.1: 3 small replicas (8/16 each) take the workers from 2 to 5.
    const p = logManagementPlan({ replicaSize: 'small', replicas: 3 });
    expect(p.workers).toBe(3);
    expect(p.footprint.vcpu).toBe(3 * 12);
    expect(p.footprint.ramGib).toBe(3 * 24);
    expect(p.footprint.diskGib).toBe(3 * 575);
    expect(p.ips).toBe(6 + 2 * 3);
    const large = logManagementPlan({ replicaSize: 'large', replicas: 3 }, { profile: 'ha-large' });
    expect(large.workers > p.workers).toBe(true);
    expect(logManagementPlan({ replicaSize: 'large', replicas: 3 }).findings.map((f) => f.code)).toContain('vcf.addon.log-size-over-profile');
    expect(logManagementPlan({ replicaSize: 'medium', replicas: 1 }).findings.map((f) => f.code)).toContain('vcf.addon.log-replicas-min');
    // 9.1.0 adds one worker of the profile's size per replica.
    expect(logManagementPlan({ replicaSize: 'small', replicas: 3 }, { version: '9.1.0' }).workers).toBe(3);
    const r = sizeDeployment(input({ addOns: { logManagement: { replicaSize: 'small', replicas: 3 } } }));
    expect(r.ips.logManagementIps).toBe(12);
  });

  it('sizes real-time metrics on the VCFMS workers', () => {
    const base = sizeDeployment(input());
    const r = sizeDeployment(input({ addOns: { realTimeMetrics: true } }));
    expect(r.totalDemand.vcpu - base.totalDemand.vcpu).toBe(2 * 12);
    expect(r.totalDemand.diskGib - base.totalDemand.diskGib).toBe(205);
  });

  it('adds Operations for Networks, Avi, Protection and Recovery, HCX and Operations scale-out', () => {
    const base = sizeDeployment(input());
    const r = sizeDeployment(
      input({
        hostCount: 6,
        addOns: {
          operationsForNetworks: { size: 'xlarge' },
          avi: { size: 'small', nodes: 3 },
          protectionRecovery: { protectedVms: 100, scaleOutAppliances: 1 },
          hcx: { sitePairs: 1, networkExtensions: 1 },
          operationsScaleOut: { dataNodes: 1, dataNodeSize: 'small', cloudProxies: 1, cloudProxySize: 'small' },
        },
      }),
    );
    const expected =
      OPS_NETWORKS_PLATFORM.xlarge.vcpu +
      OPS_NETWORKS_COLLECTOR.xlarge.vcpu +
      3 * AVI_CONTROLLER_SIZES.small.vcpu +
      PROTECTION_RECOVERY.appliance.vcpu +
      PROTECTION_RECOVERY.scaleOut.vcpu +
      HCX_APPLIANCES.manager.vcpu +
      HCX_APPLIANCES.ix.vcpu +
      HCX_APPLIANCES.ne.vcpu +
      4 +
      4;
    expect(r.totalDemand.vcpu - base.totalDemand.vcpu).toBe(expected);
    expect([PROTECTION_RECOVERY.appliance.vcpu, PROTECTION_RECOVERY.appliance.ramGib, PROTECTION_RECOVERY.appliance.diskGib]).toEqual([8, 24, 800]);
    expect([PROTECTION_RECOVERY.scaleOut.vcpu, PROTECTION_RECOVERY.scaleOut.ramGib, PROTECTION_RECOVERY.scaleOut.diskGib]).toEqual([4, 8, 110]);
    expect([AVI_CONTROLLER_SIZES.small.vcpu, AVI_CONTROLLER_SIZES.small.ramGib, AVI_CONTROLLER_SIZES.small.diskGib]).toEqual([6, 32, 512]);
    expect(AVI_CONTROLLER_SIZES.small.basis).toBe('published');
    expect(AVI_CONTROLLER_SIZES.medium.basis).toBe('unconfirmed');
    expect(HCX_APPLIANCES.manager.diskGib).toBe(65);
    // 9.1 names only.
    const names = r.components.map((c) => c.name).join(' ');
    expect(/Aria|Live Recovery|Operations for Logs/.test(names)).toBe(false);
    expect(names.includes('Protection and Recovery')).toBe(true);
  });

  it('warns when Protection and Recovery needs scale-out, or Operations for Networks is too small alone', () => {
    const r = sizeDeployment(input({ addOns: { protectionRecovery: { protectedVms: 6000 }, operationsForNetworks: { size: 'medium', nodes: 1 } } }));
    expect(codes(r)).toContain('vcf.addon.pr-scale-out');
    expect(codes(r)).toContain('vcf.addon.ops-networks-single-node');
  });
});

describe('stretched clusters', () => {
  it('adds a third-site witness and checks the inter-AZ link', () => {
    const r = sizeDeployment(input({ topology: 'stretched', hostCount: 6, stretched: { interAzBandwidthGbps: 1, interAzRttMs: 8 } }));
    expect(r.witness?.basis).toBe('unconfirmed');
    expect(codes(r)).toContain('vcf.stretched.bandwidth');
    expect(codes(r)).toContain('vcf.stretched.rtt');
  });
});

describe('memory tiering', () => {
  const tiered = (version: string, extra: Partial<SizingInput> = {}) =>
    sizeDeployment(input({ version, host: { ...BIG_HOST, ramGib: 256 }, hostCount: 4, workloadRamGib: 800, memoryTiering: { enabled: true }, ...extra }));

  it('adds the NVMe tier to workload memory at 1:1 by default', () => {
    const r = tiered('9.1.1');
    expect(r.capacity.usableMemoryGib).toBe(2 * 3 * 256);
    expect(r.dramUtilization !== undefined).toBe(true);
  });

  it('checks DRAM separately and warns before 9.1.1', () => {
    // 251 GiB of appliances + half of the workload must fit the 768 GiB of DRAM left after N+1.
    expect(codes(tiered('9.1.1'))).not.toContain('vcf.tiering.dram-ha');
    expect(codes(tiered('9.1.1', { workloadRamGib: 1300 }))).toContain('vcf.tiering.dram-ha');
    expect(codes(tiered('9.1.0'))).toContain('vcf.tiering.no-ha-support');
    expect(codes(tiered('9.1.1', { memoryTiering: { enabled: true, ratio: 5 } }))).toContain('vcf.tiering.ratio');
    expect(codes(tiered('9.1.1', { memoryTiering: { enabled: true, nvmeSharedWithVsan: true } }))).toContain('vcf.tiering.nvme-shared');
  });
});

describe('growth over years', () => {
  it('projects hosts per year for the management domain and workload domains', () => {
    const years = projectGrowth(
      input({
        workloadVcpu: 100,
        workloadRamGib: 1500,
        growth: { cpuPct: 50, ramPct: 50, storagePct: 50, years: 2 },
        workloadDomains: [{ clusters: [{ vcpu: 1000, ramGib: 4000, storageGib: 0, host: BIG_HOST, storage: 'nfs' }] }],
      }),
    );
    expect(years.length).toBe(3);
    expect((years[2]?.managementHosts ?? 0) >= (years[0]?.managementHosts ?? 0)).toBe(true);
    expect((years[2]?.workloadHosts ?? 0) > (years[0]?.workloadHosts ?? 0)).toBe(true);
    expect((years[2]?.demand.ramGib ?? 0) > (years[0]?.demand.ramGib ?? 0)).toBe(true);
  });
});

describe('P3: recovery site and ReadyNode network', () => {
  it('sizes the recovery site with Protection and Recovery at both sites', () => {
    const dr = sizeRecoverySite({ protectedVcpu: 1000, protectedRamGib: 4000, protectedStorageGib: 50000, host: BIG_HOST, storage: 'vsan-esa', reserveFraction: 0.5 });
    expect(dr.appliances.length).toBe(2);
    expect(dr.cluster.demand.vcpu).toBe(500 + 8);
    expect(dr.cluster.hosts >= 3).toBe(true);
  });

  it('allows only ESA-AF-0 on 10GbE', () => {
    expect(codes(sizeDeployment(input({ nicSpeedGbps: 10 })))).toContain('vcf.vsan.esa-10gbe');
    expect(codes(sizeDeployment(input({ nicSpeedGbps: 25 })))).not.toContain('vcf.vsan.esa-10gbe');
  });
});

describe('estate plan', () => {
  function host(name: string, cluster: string, vcenter: string): InventoryHost {
    return { name, cluster, vcenter, cpuSockets: 2, coresPerSocket: 32, totalCores: 64, threads: 128, memoryGib: 1024 };
  }
  function vm(name: string, cluster: string, vcenter: string): InventoryVm {
    return { name, cluster, vcenter, powerState: 'poweredOn', vcpu: 8, memoryGib: 64, provisionedGib: 200, usedGib: 100 };
  }
  const inventory: Inventory = {
    ...emptyInventory({ kind: 'rvtools', label: 'test' }),
    hosts: [
      ...Array.from({ length: 4 }, (_, i) => host(`m${i}`, 'mgmt-cl01', 'vc-a.lab')),
      ...Array.from({ length: 6 }, (_, i) => host(`p${i}`, 'prod', 'vc-a.lab')),
      ...Array.from({ length: 3 }, (_, i) => host(`d${i}`, 'dev', 'vc-b.lab')),
    ],
    vms: [
      ...Array.from({ length: 10 }, (_, i) => vm(`mvm${i}`, 'mgmt-cl01', 'vc-a.lab')),
      ...Array.from({ length: 60 }, (_, i) => vm(`pvm${i}`, 'prod', 'vc-a.lab')),
      ...Array.from({ length: 20 }, (_, i) => vm(`dvm${i}`, 'dev', 'vc-b.lab')),
    ],
    datastores: [{ name: 'vsan-prod', type: 'vsan', capacityGib: 6 * 15360, freeGib: 50000, hosts: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], vcenter: 'vc-a.lab' }],
  };
  const target: HostSpec = { ...BIG_HOST, rawStorageGib: 15360 };

  it('puts each workload domain’s vCenter and NSX Managers in the management domain', () => {
    const plan = planEstate(inventory, { host: target, managementSource: 'new' });
    const wlds = plan.domains.filter((d) => d.kind === 'workload');
    expect(wlds.length).toBe(2);
    expect(plan.management.workloadDomains?.length).toBe(2);
    for (const d of wlds) expect((d.managementOverhead?.vcpu ?? 0) > 0).toBe(true);
    const sized = sizeDeployment(plan.management);
    expect(sized.components.filter((c) => c.name.includes('vCenter')).length).toBe(2);
    expect(plan.findings.map((f) => f.code)).toContain('estate.plan.workload-domain-overhead');
    // Shared NSX: only the first domain carries a Manager cluster.
    const shared = planEstate(inventory, { host: target, managementSource: 'new', nsxPerDomain: 'shared' });
    const [a, b] = shared.domains.filter((d) => d.kind === 'workload');
    expect((a?.managementOverhead?.vcpu ?? 0) > (b?.managementOverhead?.vcpu ?? 0)).toBe(true);
  });

  it('chooses ESA or OSA per cluster, and never gives OSA Auto-RAID', () => {
    const esa = planEstate(inventory, { host: target });
    expect(esa.findings.map((f) => f.code)).toContain('estate.plan.vsan-architecture-assumed');
    const prod = (p: ReturnType<typeof planEstate>) => p.domains.flatMap((d) => d.clusters).find((c) => c.name === 'prod');
    expect(prod(esa)?.storage).toBe('vsan-esa');
    const osa = planEstate(inventory, { host: target, vsanArchitecture: 'osa' });
    expect(prod(osa)?.storage).toBe('vsan-osa');
    expect(prod(osa)?.raid?.includes('RAID-1') || prod(osa)?.raid?.includes('3+1')).toBe(true);
    const key = sourceClusters(inventory).find((c) => c.name === 'prod')?.key ?? '';
    const per = planEstate(inventory, { host: target, clusterStorage: { [key]: 'vsan-osa' } });
    expect(prod(per)?.storage).toBe('vsan-osa');
  });

  it('applies growth to the converged management domain too', () => {
    const key = sourceClusters(inventory).find((c) => c.name === 'mgmt-cl01')?.key ?? '';
    const flat = planEstate(inventory, { host: target, managementSource: key, growth: 0 });
    const grown = planEstate(inventory, { host: target, managementSource: key, growth: 0.5 });
    expect(flat.management.workloadVcpu).toBe(80);
    expect(grown.management.workloadVcpu).toBe(120);
  });
});

describe('provenance', () => {
  it('never presents an unconfirmed or derived figure as published', () => {
    const r = sizeDeployment(
      input({
        hostCount: 8,
        automationSize: 'large',
        addOns: { avi: { size: 'medium' }, logManagement: { replicaSize: 'large', replicas: 3 } },
        workloadDomains: [{ hosts: 3 }],
        topology: 'stretched',
      }),
    );
    const allowed: Basis[] = ['published', 'derived', 'unconfirmed'];
    for (const c of r.components) {
      expect(allowed.includes(c.basis ?? 'unconfirmed')).toBe(true);
      if (c.basis === 'published') expect(c.verification === 'V-DOC' || c.verification === 'V-API').toBe(true);
    }
    expect(NSX_MANAGER_SIZES.medium.basis).toBe('published');
    expect(r.verification === 'V-DOC').toBe(false);
  });
});
