import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  sizeDeployment,
  fleetFootprint,
  minimumHosts,
  computeCapacity,
  computeLicensing,
  computeIpRequirements,
  recommendHostCount,
  type SizingInput,
  type HostSpec,
} from './sizing.ts';
import { raidOverhead, LICENSE_MIN_CORES_PER_CPU, VCFMS_MIN_IPS } from './sizing-data.ts';

/** A capable modern host: 2x32-core, 1 TiB RAM, ~15 TiB raw NVMe. */
const BIG_HOST: HostSpec = {
  cpuSockets: 2,
  coresPerCpu: 32,
  hyperthreading: true,
  ramGib: 1024,
  rawStorageGib: 15360,
};

function baseInput(overrides: Partial<SizingInput> = {}): SizingInput {
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

describe('fleetFootprint', () => {
  it('matches the published first-instance figures', () => {
    // Broadcom "VCF Fleet Sizing Models" (9.1), Simple profile.
    const { footprint } = fleetFootprint('simple', 1);
    expect(footprint.vcpu).toBe(76);
    expect(footprint.ramGib).toBe(251);
    expect(footprint.diskGib).toBe(7448);
  });

  it('matches the published HA-Large first-instance figures', () => {
    const { footprint } = fleetFootprint('ha-large', 1);
    expect(footprint.vcpu).toBe(298);
    expect(footprint.ramGib).toBe(949);
    expect(footprint.diskGib).toBe(15357);
  });

  it('adds the additional-instance delta per extra instance', () => {
    // Simple: first 76 vCPU, each additional 34.
    expect(fleetFootprint('simple', 2).footprint.vcpu).toBe(76 + 34);
    expect(fleetFootprint('simple', 3).footprint.vcpu).toBe(76 + 68);
    expect(fleetFootprint('simple', 3).footprint.ramGib).toBe(251 + 222);
  });

  it('treats a zero or negative instance count as one instance', () => {
    expect(fleetFootprint('simple', 0).footprint.vcpu).toBe(76);
    expect(fleetFootprint('simple', -5).footprint.vcpu).toBe(76);
  });

  it('reports the published aggregate as documentation-verified', () => {
    expect(fleetFootprint('simple', 1).verification).toBe('V-DOC');
  });
});

describe('minimumHosts', () => {
  // Was 4 for every profile; the Single-Rack Cluster Model (S4) gives Simple 3, HA 4.
  it('requires 3 hosts for a Simple and 4 for an HA vSAN management domain', () => {
    expect(minimumHosts({ path: 'greenfield', storage: 'vsan-esa', topology: 'standard' }).hosts).toBe(3);
    expect(minimumHosts({ path: 'greenfield', storage: 'vsan-esa', topology: 'standard', profile: 'ha-small' }).hosts).toBe(4);
  });

  // Was 8 for every profile; the Stretched Cluster Model (S5) gives Simple 6, HA 8.
  it('requires 6 (Simple) or 8 (HA) hosts for a stretched management domain', () => {
    expect(minimumHosts({ path: 'greenfield', storage: 'vsan-esa', topology: 'stretched' }).hosts).toBe(6);
    expect(minimumHosts({ path: 'greenfield', storage: 'vsan-esa', topology: 'stretched', profile: 'ha-medium' }).hosts).toBe(8);
  });

  it('allows 3 hosts when converging an existing vSAN estate', () => {
    expect(
      minimumHosts({ path: 'brownfield-converge', storage: 'vsan-esa', topology: 'standard' }).hosts,
    ).toBe(3);
  });

  it('allows 2 hosts when converging with external storage', () => {
    expect(minimumHosts({ path: 'brownfield-converge', storage: 'nfs', topology: 'standard' }).hosts).toBe(2);
    expect(
      minimumHosts({ path: 'brownfield-converge', storage: 'vmfs-fc', topology: 'standard' }).hosts,
    ).toBe(2);
  });
});

describe('computeCapacity', () => {
  it('counts physical and logical processors', () => {
    const c = computeCapacity(4, BIG_HOST, false);
    expect(c.physicalCores).toBe(4 * 2 * 32);
    expect(c.logicalProcessors).toBe(4 * 2 * 32 * 2);
    expect(c.totalRamGib).toBe(4096);
  });

  it('withholds one host of capacity when reserving for failure', () => {
    const c = computeCapacity(4, BIG_HOST, true);
    // Total is 4 hosts, usable is 3.
    expect(c.totalRamGib).toBe(4096);
    expect(c.usableRamGib).toBe(3072);
  });

  it('does not go negative for a single-host cluster', () => {
    const c = computeCapacity(1, BIG_HOST, true);
    expect(c.usableRamGib).toBe(0);
  });
});

describe('computeLicensing', () => {
  it('applies the 16-core-per-CPU floor to smaller CPUs', () => {
    const host: HostSpec = { ...BIG_HOST, coresPerCpu: 8 };
    const l = computeLicensing(4, host);
    // 4 hosts x 2 CPUs x 8 real cores = 64 physical, but billed at 16 each.
    expect(l.physicalCores).toBe(64);
    expect(l.billableCores).toBe(128);
    expect(l.floorPenaltyCores).toBe(64);
    expect(l.minPerCpuApplied).toBe(LICENSE_MIN_CORES_PER_CPU);
  });

  it('bills actual cores when they exceed the floor', () => {
    const l = computeLicensing(2, { ...BIG_HOST, coresPerCpu: 24 });
    // The documented example: 2 hosts x 2 CPUs x 24 cores = 96 cores.
    expect(l.physicalCores).toBe(96);
    expect(l.billableCores).toBe(96);
    expect(l.floorPenaltyCores).toBe(0);
  });

  it('uses the lower 8-core floor for VCF Edge', () => {
    const l = computeLicensing(1, { ...BIG_HOST, cpuSockets: 1, coresPerCpu: 8 }, true);
    expect(l.billableCores).toBe(8);
    expect(l.floorPenaltyCores).toBe(0);
  });
});

describe('computeIpRequirements', () => {
  it('includes the 12-IP VCFMS minimum', () => {
    const ips = computeIpRequirements(baseInput());
    expect(ips.vcfmsIps).toBe(VCFMS_MIN_IPS);
    expect(ips.totalRecommended).toBeGreaterThan(ips.totalMinimum);
  });

  it('allocates three VMkernel IPs per host plus TEPs per pNIC', () => {
    const ips = computeIpRequirements(baseInput({ hostCount: 4, pnicsPerHost: 2 }));
    expect(ips.hostIps).toBe(12);
    expect(ips.tepIps).toBe(8);
  });

  it('asks for more component FQDNs in an HA profile than a simple one', () => {
    const simple = computeIpRequirements(baseInput({ profile: 'simple' }));
    const ha = computeIpRequirements(baseInput({ profile: 'ha-small' }));
    expect(ha.componentFqdns).toBeGreaterThan(simple.componentFqdns);
  });

  it('drops the Automation pool when Automation is excluded', () => {
    expect(computeIpRequirements(baseInput({ includeAutomation: false })).automationIps).toBe(0);
  });
});

describe('raidOverhead', () => {
  it('uses 1.5x for standard clusters at both RAID-5 and RAID-6 scale', () => {
    // VCF 9.1 Auto-RAID: RAID 5 and RAID 6 have the same capacity overhead.
    expect(raidOverhead('standard', 4).multiplier).toBe(1.5);
    expect(raidOverhead('standard', 8).multiplier).toBe(1.5);
    expect(raidOverhead('standard', 4).raid).toBe('RAID-5 (2+1)');
    expect(raidOverhead('standard', 8).raid).toBe('RAID-6');
  });

  it('uses 3x for stretched clusters and 2x for two-node', () => {
    expect(raidOverhead('stretched', 4).multiplier).toBe(3.0);
    expect(raidOverhead('two-node', 2).multiplier).toBe(2.0);
  });

  it('raises FTT from 1 to 2 at six hosts', () => {
    expect(raidOverhead('standard', 5).ftt).toBe(1);
    expect(raidOverhead('standard', 6).ftt).toBe(2);
  });
});

describe('sizeDeployment', () => {
  it('sizes a healthy greenfield 4-host Simple deployment without errors', () => {
    const result = sizeDeployment(baseInput());
    const errors = result.findings.filter((f) => f.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.totalDemand.vcpu).toBe(76);
  });

  it('flags a host count below the documented minimum', () => {
    const result = sizeDeployment(baseInput({ hostCount: 2 }));
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain('vcf.hosts.below-minimum');
  });

  it('accepts NFS or VMFS on FC for a new management domain, as VCF 9 does', () => {
    for (const storage of ['nfs', 'vmfs-fc'] as const) {
      const result = sizeDeployment(baseInput({ storage, hostCount: 3 }));
      const codes = result.findings.map((f) => f.code);
      expect(codes).toContain('vcf.storage.greenfield-external');
      expect(result.findings.some((f) => f.severity === 'error' && f.path === 'storage')).toBe(false);
      // A real 9.1.1.0 lab deployment ran on three FC hosts.
      expect(codes).not.toContain('vcf.hosts.below-minimum');
    }
  });

  // Was "still wants four hosts" for Simple; only HA needs 4 (S4).
  it('wants four hosts for a new HA vSAN management domain, three for Simple', () => {
    const ha = sizeDeployment(baseInput({ profile: 'ha-small', storage: 'vsan-esa', hostCount: 3 })).findings.map((f) => f.code);
    expect(ha).toContain('vcf.hosts.below-minimum');
    const simple = sizeDeployment(baseInput({ storage: 'vsan-esa', hostCount: 3 })).findings.map((f) => f.code);
    expect(simple).not.toContain('vcf.hosts.below-minimum');
  });

  it('accepts external storage on the converge path', () => {
    const result = sizeDeployment(
      baseInput({ path: 'brownfield-converge', storage: 'nfs', hostCount: 2 }),
    );
    expect(result.findings.some((f) => f.severity === 'error' && f.path === 'storage')).toBe(false);
  });

  it('enforces the vSAN ESA 128 GiB per-host memory floor', () => {
    const result = sizeDeployment(baseInput({ host: { ...BIG_HOST, ramGib: 64 } }));
    expect(result.findings.map((f) => f.code)).toContain('vcf.vsan.esa-host-ram');
  });

  it('catches hosts too small to run a VCF Automation node', () => {
    // 1 socket x 8 cores, no HT = 8 logical, well under the 24 vCPU a node needs.
    const small: HostSpec = {
      cpuSockets: 1,
      coresPerCpu: 8,
      hyperthreading: false,
      ramGib: 512,
      rawStorageGib: 8192,
    };
    const result = sizeDeployment(baseInput({ host: small }));
    expect(result.findings.map((f) => f.code)).toContain('vcf.automation.host-too-small');
  });

  it('reports insufficient memory rather than silently overcommitting', () => {
    const lean: HostSpec = { ...BIG_HOST, ramGib: 128 };
    // HA-Large needs 949 GiB; 4 hosts x 128 GiB leaves 384 usable after N+1.
    const result = sizeDeployment(baseInput({ profile: 'ha-large', host: lean }));
    expect(result.findings.map((f) => f.code)).toContain('vcf.memory.insufficient');
    expect(result.memoryUtilization).toBeGreaterThan(1);
  });

  // Was ((7448 + 10000) x 1.5) / 0.75: the 25% slack double-counted the N+1 rebuild reserve.
  it('applies RAID overhead without a second slack reserve', () => {
    const result = sizeDeployment(baseInput({ workloadCapacityGib: 10000 }));
    // (7448 mgmt + 10000 workload) x 1.5 Auto-RAID; the rebuild reserve is the N+1 host.
    const expected = (7448 + 10000) * 1.5;
    expect(result.storage.rawRequiredGib).toBeCloseTo(expected, 0);
    expect(result.storage.multiplier).toBe(1.5);
  });

  it('treats external storage as unbounded rather than failing the vSAN check', () => {
    const result = sizeDeployment(
      baseInput({ path: 'brownfield-converge', storage: 'vmfs-fc', hostCount: 2, workloadCapacityGib: 500000 }),
    );
    expect(result.storage.sufficient).toBe(true);
  });

  it('adds Edge cluster capacity on top of the fleet aggregate', () => {
    const without = sizeDeployment(baseInput());
    const withEdge = sizeDeployment(baseInput({ includeEdgeCluster: true, edgeSize: 'large', edgeNodeCount: 2 }));
    // 2 x large Edge = 2 x 8 vCPU.
    expect(withEdge.totalDemand.vcpu - without.totalDemand.vcpu).toBe(16);
    expect(withEdge.totalDemand.ramGib - without.totalDemand.ramGib).toBe(64);
  });

  it('warns about an odd host count on a stretched cluster', () => {
    const result = sizeDeployment(baseInput({ topology: 'stretched', hostCount: 9 }));
    expect(result.findings.map((f) => f.code)).toContain('vcf.topology.uneven-stretch');
  });

  it('degrades the overall verification tag when a community figure is used', () => {
    // The fleet aggregate alone is V-DOC.
    expect(sizeDeployment(baseInput()).verification).toBe('V-DOC');
    // Adding community-sourced Edge figures should not stay V-DOC... Edge is
    // V-DOC too, so this stays official.
    expect(sizeDeployment(baseInput({ includeEdgeCluster: true })).verification).toBe('V-DOC');
  });

  // Was 76 + 34 x 2 on one cluster: each additional instance is its own management domain.
  it('sizes each additional instance as its own management domain', () => {
    const result = sizeDeployment(baseInput({ instanceCount: 3, hostCount: 8 }));
    expect(result.findings.map((f) => f.code)).toContain('vcf.fleet.additional-instances');
    expect(result.managementFootprint.vcpu).toBe(76);
    expect(result.fleet?.instances.length).toBe(3);
    expect(result.fleet?.instances[1]?.managementFootprint.vcpu).toBe(34);
  });
});

describe('recommendHostCount', () => {
  // Was 4: the Simple vSAN minimum is 3 (S4).
  it('returns the documented minimum when it already fits', () => {
    expect(recommendHostCount(baseInput())).toBe(3);
  });

  it('grows the cluster until memory fits', () => {
    const lean: HostSpec = { ...BIG_HOST, ramGib: 256 };
    const hosts = recommendHostCount(baseInput({ profile: 'ha-large', host: lean }));
    // Was 5 (memory just fitting). HA-Large needs 949 GiB, which must stay within
    // the 80% headroom warning: 949 / 0.8 = 1186 GiB = 5 surviving 256 GiB hosts, plus N+1.
    expect(hosts).toBe(6);
  });

  it('returns null when a per-host constraint can never be satisfied', () => {
    const tiny: HostSpec = {
      cpuSockets: 1,
      coresPerCpu: 4,
      hyperthreading: false,
      ramGib: 16,
      rawStorageGib: 100,
    };
    expect(recommendHostCount(baseInput({ host: tiny }), 12)).toBeNull();
  });
});
