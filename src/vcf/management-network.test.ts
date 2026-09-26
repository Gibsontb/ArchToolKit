import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { buildSddcSpec, type DeploymentPlan } from './spec-builder.ts';
import { MANAGEMENT_NETWORK_MODELS, managementNetworkModel } from './management-network.ts';

function basePlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    sddcId: 'vcf-m01',
    domainSuffix: 'vcf.lab',
    namePrefix: 'vcf-m01',
    esxHostnameBase: 'esx',
    hostCount: 4,
    dnsServers: ['192.168.30.29', '192.168.30.30'],
    ntpServers: ['192.168.30.1', '192.168.30.2'],
    management: { cidr: '172.30.0.0/24', vlanId: 30 },
    vmotion: { cidr: '172.30.40.0/24', vlanId: 40 },
    vsan: { cidr: '172.30.50.0/24', vlanId: 50 },
    hostTep: { cidr: '172.30.60.0/24', vlanId: 60 },
    storage: 'vsan-esa',
    ...overrides,
  };
}

const codes = (findings: readonly { code: string }[]): string[] => findings.map((f) => f.code);
const fleet = { cidr: '172.30.80.0/24', vlanId: 80 };
const segment = { networkName: 'seg-vcf-mgmt', subnetMask: '255.255.255.0', gateway: '192.168.11.1' };

describe('VCF Management Network Models', () => {
  it('covers all four models the design library documents', () => {
    expect(MANAGEMENT_NETWORK_MODELS).toHaveLength(4);
  });

  it('names the chosen model in the build output', () => {
    const { findings } = buildSddcSpec(basePlan());
    const note = findings.find((f) => f.code === 'vcf.build.management-network-model');
    expect(note).toBeDefined();
    expect(note?.message).toContain('Shared VLAN');
  });

  it('always states that the cloud proxy stays on VM management', () => {
    // It is an Instance-level component, so no model moves it. This is the
    // single most common wrong assumption about the dedicated models.
    const { findings } = buildSddcSpec(basePlan({ managementNetworkModel: 'dedicated-vlan', fleetManagement: fleet }));
    expect(codes(findings)).toContain('vcf.build.cloud-proxy-network');
  });
});

describe('management network model: placement follows the model', () => {
  it('shares the Instance-level network by default', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(spec.networkSpecs!.map((n) => n.networkType)).not.toContain('FLEET_MANAGEMENT');
    // Pool comes out of the management subnet.
    expect(JSON.stringify(spec.vspClusterSpec?.ipv4Pool)).toContain('172.30.0.');
  });

  it('moves the pool onto the dedicated network', () => {
    const { spec } = buildSddcSpec(
      basePlan({ managementNetworkModel: 'dedicated-vlan', fleetManagement: fleet }),
    );
    expect(spec.networkSpecs!.map((n) => n.networkType)).toContain('FLEET_MANAGEMENT');
    expect(JSON.stringify(spec.vspClusterSpec?.ipv4Pool)).toContain('172.30.80.');
  });

  it('prefers the VM management network when one is planned separately', () => {
    // The shared model shares the port group the Instance-level components use,
    // which is VM management when it is not the same subnet as management.
    const { spec } = buildSddcSpec(
      basePlan({ vmManagement: { cidr: '172.31.0.0/24', vlanId: 31 } }),
    );
    expect(JSON.stringify(spec.vspClusterSpec?.ipv4Pool)).toContain('172.31.0.');
  });

  it('names the overlay segment through the management components spec', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        managementNetworkModel: 'dedicated-vlan-overlay',
        fleetManagement: fleet,
        managementComponentNetworks: { xRegion: segment },
      }),
    );
    expect(spec.vcfManagementComponentsInfrastructureSpec?.xRegionNetwork?.networkName).toBe(
      'seg-vcf-mgmt',
    );
  });
});

describe('management network model: inconsistent plans are reported', () => {
  it('warns when a dedicated model has no dedicated network', () => {
    const { findings } = buildSddcSpec(basePlan({ managementNetworkModel: 'dedicated-vlan' }));
    expect(codes(findings)).toContain('vcf.build.management-network-missing-dedicated');
  });

  it('warns when a shared model is given a dedicated network it will not use', () => {
    const { findings } = buildSddcSpec(
      basePlan({ managementNetworkModel: 'shared-vlan', fleetManagement: fleet }),
    );
    expect(codes(findings)).toContain('vcf.build.management-network-unused-dedicated');
  });

  it('warns when an overlay model names no segment', () => {
    const { findings } = buildSddcSpec(
      basePlan({ managementNetworkModel: 'dedicated-vlan-overlay', fleetManagement: fleet }),
    );
    expect(codes(findings)).toContain('vcf.build.management-network-missing-overlay');
  });

  it('warns when a stretched model has no local region network', () => {
    const { findings } = buildSddcSpec(
      basePlan({
        managementNetworkModel: 'dedicated-vlan-stretched-overlay',
        fleetManagement: fleet,
        managementComponentNetworks: { xRegion: segment },
      }),
    );
    expect(codes(findings)).toContain('vcf.build.management-network-missing-local-region');
  });

  it('is quiet when the plan matches the model', () => {
    const { findings } = buildSddcSpec(
      basePlan({
        managementNetworkModel: 'dedicated-vlan-stretched-overlay',
        fleetManagement: fleet,
        managementComponentNetworks: { local: segment, xRegion: segment },
      }),
    );
    expect(codes(findings).filter((c) => c.startsWith('vcf.build.management-network-missing'))).toEqual(
      [],
    );
  });
});

describe('management network model: inference', () => {
  it('infers dedicated from a fleet network', () => {
    const { findings } = buildSddcSpec(basePlan({ fleetManagement: fleet }));
    const note = findings.find((f) => f.code === 'vcf.build.management-network-model');
    expect(note?.message).toContain('Dedicated VLAN Network Model');
  });

  it('infers the overlay model from a named segment', () => {
    const { findings } = buildSddcSpec(
      basePlan({ fleetManagement: fleet, managementComponentNetworks: { xRegion: segment } }),
    );
    const note = findings.find((f) => f.code === 'vcf.build.management-network-model');
    expect(note?.message).toContain('NSX Overlay Segment');
  });

  it('never infers stretched, which is a deliberate two-region choice', () => {
    for (const plan of [basePlan(), basePlan({ fleetManagement: fleet })]) {
      const { findings } = buildSddcSpec(plan);
      const note = findings.find((f) => f.code === 'vcf.build.management-network-model');
      expect(note?.message).not.toContain('Stretched');
    }
    expect(managementNetworkModel('dedicated-vlan-stretched-overlay').stretched).toBe(true);
  });
});
