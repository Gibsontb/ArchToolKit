import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { buildSddcSpec, type DeploymentPlan } from './spec-builder.ts';
import { validateSddcSpec } from './spec-validate.ts';
import { estateToPlan } from './bridge.ts';
import { emitTerraform } from '../terraform/vcf.ts';
import { scopedKey, type Inventory } from '../vmware/inventory.ts';
import type { SddcNetworkSpec, SddcSpec } from './spec-types.ts';
import type { Finding } from '../core/findings.ts';

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

/** A dual-stack plan the way the page builds it with every IPv6 field filled. */
function dualPlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return basePlan({
    dualStack: true,
    internalClusterCidrIpv6: 'fd00::/111',
    management: { cidr: '172.30.0.0/24', vlanId: 30, ipv6Cidr: '2001:db8:30::/64', ipv6Gateway: '2001:db8:30::1' },
    vmotion: { cidr: '172.30.40.0/24', vlanId: 40, ipv6Cidr: '2001:db8:40::/64' },
    vsan: { cidr: '172.30.50.0/24', vlanId: 50, ipv6Cidr: '2001:db8:50::/64' },
    ...overrides,
  });
}

const errorCodes = (findings: readonly Finding[]): string[] =>
  findings.filter((f) => f.severity === 'error').map((f) => f.code);
const codes = (findings: readonly Finding[]): string[] => findings.map((f) => f.code);
const v6Of = (spec: SddcSpec, type: string): SddcNetworkSpec | undefined =>
  spec.networkSpecs.find((n) => n.networkType === type && n.ipAddressVersion === 'IPv6');

describe('VCF dual stack — the validator accepts the builder’s own output', () => {
  it('raises no error on a dual-stack spec that the IPv4-only spec does not raise', () => {
    const v4 = validateSddcSpec(buildSddcSpec(basePlan()).spec);
    const dual = validateSddcSpec(buildSddcSpec(dualPlan()).spec);
    expect(errorCodes(dual)).toEqual(errorCodes(v4));
    expect(codes(dual)).not.toContain('vcf.spec.duplicate-network-type');
    expect(codes(dual)).not.toContain('vcf.spec.invalid-subnet');
    expect(codes(dual)).not.toContain('vcf.spec.invalid-gateway');
  });

  it('still flags the same networkType twice in the same family', () => {
    const { spec } = buildSddcSpec(dualPlan());
    const mgmtV6 = v6Of(spec, 'MANAGEMENT')!;
    const doubled = { ...spec, networkSpecs: [...spec.networkSpecs, { ...mgmtV6 }] };
    expect(codes(validateSddcSpec(doubled))).toContain('vcf.spec.duplicate-network-type');
  });
});

describe('VCF dual stack — emitted IPv6 syntax', () => {
  it('writes an IPv6 twin with ipAddressVersion IPv6, on the same VLAN', () => {
    const { spec } = buildSddcSpec(dualPlan());
    const mgmt = v6Of(spec, 'MANAGEMENT')!;
    expect(mgmt.subnet).toBe('2001:db8:30::/64');
    expect(mgmt.gateway).toBe('2001:db8:30::1');
    expect(mgmt.vlanId).toBe(30);
    expect(mgmt.portGroupKey).toBe('vcf-m01-pg-management-v6');
  });

  it('writes the subnet canonically even when typed with host bits or zeros', () => {
    const { spec } = buildSddcSpec(
      dualPlan({ management: { cidr: '172.30.0.0/24', vlanId: 30, ipv6Cidr: '2001:0db8:0030:0000::5/64', ipv6Gateway: '2001:db8:30::1' } }),
    );
    expect(v6Of(spec, 'MANAGEMENT')?.subnet).toBe('2001:db8:30::/64');
  });

  it('hands vMotion and vSAN hosts the same host numbers as IPv4', () => {
    const { spec } = buildSddcSpec(dualPlan());
    const v4vmotion = spec.networkSpecs.find((n) => n.networkType === 'VMOTION' && n.ipAddressVersion === 'IPv4');
    expect(v4vmotion?.includeIpAddressRanges).toEqual([{ startIpAddress: '172.30.40.10', endIpAddress: '172.30.40.13' }]);
    expect(v6Of(spec, 'VMOTION')?.includeIpAddressRanges).toEqual([
      { startIpAddress: '2001:db8:40::a', endIpAddress: '2001:db8:40::d' },
    ]);
    expect(v6Of(spec, 'VSAN')?.includeIpAddressRanges).toEqual([
      { startIpAddress: '2001:db8:50::2', endIpAddress: '2001:db8:50::5' },
    ]);
  });

  it('allocates no static range for a SLAAC network', () => {
    const { spec } = buildSddcSpec(
      dualPlan({ vmotion: { cidr: '172.30.40.0/24', vlanId: 40, ipv6Cidr: '2001:db8:40::/64', assignmentMode: 'SLAAC' } }),
    );
    expect(v6Of(spec, 'VMOTION')?.ipAddressAssignmentMode).toBe('SLAAC');
    expect(v6Of(spec, 'VMOTION')?.includeIpAddressRanges).toBeUndefined();
    // SLAAC is IPv6 only, so the IPv4 twin stays static.
    const v4 = spec.networkSpecs.find((n) => n.networkType === 'VMOTION' && n.ipAddressVersion === 'IPv4');
    expect(v4?.ipAddressAssignmentMode).toBe('STATIC');
  });

  it('carves the VCF Management Services IPv6 pool from the management IPv6 prefix', () => {
    const { spec } = buildSddcSpec(dualPlan());
    expect(spec.vspClusterSpec?.ipv6Pool).toEqual({
      ipRange: { startIpAddress: '2001:db8:30::20', endIpAddress: '2001:db8:30::3d' },
    });
    // The IPv4 pool sits at the same host numbers.
    expect(spec.vspClusterSpec?.ipv4Pool.ipRange).toEqual({ startIpAddress: '172.30.0.32', endIpAddress: '172.30.0.61' });
    expect(spec.vspClusterSpec?.internalClusterCidrIpv6).toBe('fd00::/111');
  });

  it('takes the IPv6 pool from the dedicated fleet network when the model uses one', () => {
    const { spec } = buildSddcSpec(
      dualPlan({
        managementNetworkModel: 'dedicated-vlan' as DeploymentPlan['managementNetworkModel'],
        fleetManagement: { cidr: '172.30.80.0/24', vlanId: 80, ipv6Cidr: '2001:db8:80::/64', ipv6Gateway: '2001:db8:80::1' },
      }),
    );
    expect(v6Of(spec, 'FLEET_MANAGEMENT')?.subnet).toBe('2001:db8:80::/64');
    const start = spec.vspClusterSpec?.ipv6Pool?.ipRange?.startIpAddress ?? '';
    expect(start.startsWith('2001:db8:80::')).toBe(true);
  });

  it('keeps an explicit IPv6 pool as given', () => {
    const { spec } = buildSddcSpec(dualPlan({ vcfmsIpv6Pool: { mode: 'addresses', addresses: ['2001:db8:30::100', '2001:db8:30::101'] } }));
    expect(spec.vspClusterSpec?.ipv6Pool).toEqual({ addresses: ['2001:db8:30::100', '2001:db8:30::101'] });
  });

  it('keeps the API maxLength note and notes Automation stays IPv4', () => {
    const { findings } = buildSddcSpec(dualPlan());
    const note = findings.find((f) => f.code === 'vcf.build.dual-stack');
    expect(note?.message).toContain('maxLength');
    expect(codes(findings)).toContain('vcf.build.automation-ipv4-only');
    expect(codes(findings)).not.toContain('vcf.build.dual-stack-without-v6');
  });

  it('warns when a routed IPv6 network has no gateway rather than inventing one', () => {
    const { spec, findings } = buildSddcSpec(
      dualPlan({ management: { cidr: '172.30.0.0/24', vlanId: 30, ipv6Cidr: '2001:db8:30::/64' } }),
    );
    expect(v6Of(spec, 'MANAGEMENT')?.gateway).toBeUndefined();
    expect(codes(findings)).toContain('vcf.build.ipv6-no-gateway');
  });
});

describe('VCF dual stack — IPv4 output is unchanged', () => {
  it('emits the same IPv4 networks and pools with or without dual stack', () => {
    const v4 = buildSddcSpec(basePlan()).spec;
    const dual = buildSddcSpec(dualPlan()).spec;
    expect(dual.networkSpecs.filter((n) => n.ipAddressVersion === 'IPv4')).toEqual(v4.networkSpecs);
    expect(dual.vspClusterSpec?.ipv4Pool).toEqual(v4.vspClusterSpec?.ipv4Pool);
    expect(dual.nsxtSpec?.ipAddressPoolSpec).toEqual(v4.nsxtSpec?.ipAddressPoolSpec);
    expect(dual.vcfAutomationSpec?.ipPool).toEqual(v4.vcfAutomationSpec?.ipPool);
  });

  it('emits no IPv6 when prefixes are set but dual stack is off, and says so', () => {
    const { spec, findings } = buildSddcSpec(dualPlan({ dualStack: false }));
    expect(spec.networkSpecs.some((n) => n.ipAddressVersion === 'IPv6')).toBe(false);
    expect(spec.vspClusterSpec?.ipv6Pool).toBeUndefined();
    expect(codes(findings)).toContain('vcf.build.ipv6-without-dual-stack');
  });
});

describe('VCF dual stack — unsupported IPv6 is refused', () => {
  it('rejects IPv6 for the NSX host TEP pool in the builder', () => {
    const { spec, findings } = buildSddcSpec(
      dualPlan({ hostTep: { cidr: '172.30.60.0/24', vlanId: 60, ipv6Cidr: '2001:db8:60::/64' } }),
    );
    const f = findings.find((x) => x.code === 'vcf.build.tep-ipv6-unsupported');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('NSX host TEP pool on VCF 9.1 does not support IPv6');
    expect(JSON.stringify(spec.nsxtSpec)).not.toContain('2001:db8:60');
  });

  it('rejects an IPv6 host TEP subnet in the validator', () => {
    const { spec } = buildSddcSpec(basePlan());
    const pool = spec.nsxtSpec!.ipAddressPoolSpec!;
    const bad = {
      ...spec,
      nsxtSpec: {
        ...spec.nsxtSpec!,
        ipAddressPoolSpec: {
          ...pool,
          subnets: [{ cidr: '2001:db8:60::/64', gateway: '2001:db8:60::1', ipAddressPoolRanges: [{ start: '2001:db8:60::a', end: '2001:db8:60::d' }] }],
        },
      },
    };
    const f = validateSddcSpec(bad).find((x) => x.code === 'vcf.spec.tep-ipv6-unsupported');
    expect(f?.severity).toBe('error');
  });

  it('rejects an IPv6 prefix in the IPv4 cidr field (VCF IPv6 is dual stack)', () => {
    const { findings } = buildSddcSpec(basePlan({ vmotion: { cidr: '2001:db8:40::/64', vlanId: 40 } }));
    expect(errorCodes(findings)).toContain('vcf.build.ipv6-only-network');
  });

  it('rejects an IPv4 value in ipv6Cidr or ipv6Gateway', () => {
    const { findings } = buildSddcSpec(
      dualPlan({ management: { cidr: '172.30.0.0/24', vlanId: 30, ipv6Cidr: '10.0.0.0/24', ipv6Gateway: '10.0.0.1' } }),
    );
    expect(errorCodes(findings)).toContain('vcf.build.invalid-ipv6-cidr');
    expect(errorCodes(findings)).toContain('vcf.build.invalid-ipv6-gateway');
  });

  it('does not emit an IPv6 distributed transit gateway, and says to verify', () => {
    const { spec, findings } = buildSddcSpec(
      basePlan({ dtgw: { vlan: 70, gatewayCidr: '2001:db8:70::1/64', externalIpBlockCidr: '2001:db8:71::/56' } }),
    );
    expect(spec.nsxtSpec?.vpcSpec?.dtgwSpec).toBeUndefined();
    const f = findings.find((x) => x.code === 'vcf.build.dtgw-ipv6-unverified');
    expect(f?.message.startsWith('VERIFY:')).toBe(true);
  });
});

describe('VCF validator — families never mix in one entry', () => {
  const base = (): SddcSpec => buildSddcSpec(dualPlan()).spec;
  const withNetworks = (spec: SddcSpec, networks: SddcNetworkSpec[]): SddcSpec => ({ ...spec, networkSpecs: networks });

  it('rejects an IPv6 subnet on an IPv4 entry', () => {
    const spec = base();
    const nets = spec.networkSpecs.map((n) =>
      n.networkType === 'VMOTION' && n.ipAddressVersion === 'IPv4' ? { ...n, subnet: '2001:db8:99::/64' } : n,
    );
    expect(errorCodes(validateSddcSpec(withNetworks(spec, nets)))).toContain('vcf.spec.subnet-version-mismatch');
  });

  it('rejects an IPv4 gateway on an IPv6 entry', () => {
    const spec = base();
    const nets = spec.networkSpecs.map((n) =>
      n.networkType === 'MANAGEMENT' && n.ipAddressVersion === 'IPv6' ? { ...n, gateway: '172.30.0.1' } : n,
    );
    expect(errorCodes(validateSddcSpec(withNetworks(spec, nets)))).toContain('vcf.spec.gateway-version-mismatch');
  });

  it('rejects an IPv6 gateway outside its prefix', () => {
    const spec = base();
    const nets = spec.networkSpecs.map((n) =>
      n.networkType === 'MANAGEMENT' && n.ipAddressVersion === 'IPv6' ? { ...n, gateway: '2001:db8:31::1' } : n,
    );
    expect(errorCodes(validateSddcSpec(withNetworks(spec, nets)))).toContain('vcf.spec.gateway-outside-subnet');
  });

  it('rejects an IPv4 range on an IPv6 entry', () => {
    const spec = base();
    const nets = spec.networkSpecs.map((n) =>
      n.networkType === 'VMOTION' && n.ipAddressVersion === 'IPv6'
        ? { ...n, includeIpAddressRanges: [{ startIpAddress: '172.30.40.10', endIpAddress: '172.30.40.13' }] }
        : n,
    );
    expect(errorCodes(validateSddcSpec(withNetworks(spec, nets)))).toContain('vcf.spec.invalid-network-range');
  });

  it('rejects SLAAC on IPv4 and on anything but a /64', () => {
    const spec = base();
    const nets = spec.networkSpecs.map((n) => {
      if (n.networkType === 'VMOTION' && n.ipAddressVersion === 'IPv4') return { ...n, ipAddressAssignmentMode: 'SLAAC' as const };
      if (n.networkType === 'VSAN' && n.ipAddressVersion === 'IPv6') {
        return { ...n, subnet: '2001:db8:50::/80', ipAddressAssignmentMode: 'SLAAC' as const, includeIpAddressRanges: [] };
      }
      return n;
    });
    const found = errorCodes(validateSddcSpec(withNetworks(spec, nets)));
    expect(found).toContain('vcf.spec.slaac-needs-ipv6');
    expect(found).toContain('vcf.spec.slaac-needs-64');
  });

  it('checks overlap within a family only', () => {
    const spec = base();
    const nets = spec.networkSpecs.map((n) =>
      n.networkType === 'VMOTION' && n.ipAddressVersion === 'IPv6'
        ? { ...n, subnet: '2001:db8:30::/64', includeIpAddressRanges: [] }
        : n,
    );
    expect(errorCodes(validateSddcSpec(withNetworks(spec, nets)))).toContain('vcf.spec.overlapping-subnets');
    // The untouched dual-stack spec has IPv4 and IPv6 on every VLAN and no overlap.
    expect(codes(validateSddcSpec(base()))).not.toContain('vcf.spec.overlapping-subnets');
  });

  it('sizes the IPv6 management prefix separately', () => {
    const spec = base();
    const nets = spec.networkSpecs.map((n) =>
      n.networkType === 'MANAGEMENT' && n.ipAddressVersion === 'IPv6'
        ? { ...n, subnet: '2001:db8:30::/124', gateway: '2001:db8:30::1' }
        : n,
    );
    const f = validateSddcSpec(withNetworks(spec, nets)).find((x) => x.code === 'vcf.spec.management-subnet-too-small');
    expect(f?.path).toBe('networkSpecs[MANAGEMENT/IPv6].subnet');
  });

  it('keeps each VCFMS pool in its own family', () => {
    const spec = base();
    const bad = {
      ...spec,
      vspClusterSpec: { ...spec.vspClusterSpec!, ipv4Pool: { cidr: '2001:db8:30::/64' }, ipv6Pool: { cidr: '172.30.0.0/24' } },
    };
    const f = validateSddcSpec(bad).filter((x) => x.code === 'vcf.spec.vsp-pool-family');
    expect(f.map((x) => x.path)).toEqual(['vspClusterSpec.ipv4Pool.cidr', 'vspClusterSpec.ipv6Pool.cidr']);
  });

  it('applies the VCFMS minimum to the IPv6 pool', () => {
    const spec = base();
    const bad = {
      ...spec,
      vspClusterSpec: {
        ...spec.vspClusterSpec!,
        ipv6Pool: { ipRange: { startIpAddress: '2001:db8:30::20', endIpAddress: '2001:db8:30::22' } },
      },
    };
    const f = validateSddcSpec(bad).find((x) => x.code === 'vcf.spec.vcfms-pool-too-small');
    expect(f?.path).toBe('vspClusterSpec.ipv6Pool');
  });

  it('warns about an IPv6 pool with no IPv6 network to carry it', () => {
    const { spec } = buildSddcSpec(basePlan({ vcfmsIpv6Pool: { cidr: '2001:db8:ff::/112' } }));
    expect(codes(validateSddcSpec(spec))).toContain('vcf.spec.ipv6-pool-without-ipv6-network');
  });
});

describe('VCF validator — IPv6 servers and component networks', () => {
  it('accepts IPv6 nameservers, with a verify note', () => {
    const { spec } = buildSddcSpec(basePlan({ dnsServers: ['192.168.30.29', '2001:db8:30::53'] }));
    const found = validateSddcSpec(spec);
    expect(codes(found)).not.toContain('vcf.spec.invalid-nameserver');
    expect(found.find((f) => f.code === 'vcf.spec.ipv6-nameserver')?.message.startsWith('VERIFY:')).toBe(true);
  });

  it('still rejects a nameserver that is not an address', () => {
    const { spec } = buildSddcSpec(basePlan({ dnsServers: ['dns.example', '2001:db8::zz'] }));
    expect(errorCodes(validateSddcSpec(spec)).filter((c) => c === 'vcf.spec.invalid-nameserver')).toHaveLength(2);
  });

  it('checks the IPv6 half of a management component network', () => {
    const { spec } = buildSddcSpec(basePlan());
    const good = {
      ...spec,
      vcfManagementComponentsInfrastructureSpec: {
        xRegionNetwork: { networkName: 'seg', subnetMask: '255.255.255.0', gateway: '192.168.11.1', ipv6Gateway: '2001:db8:11::1', ipv6Prefix: 64 },
      },
    };
    expect(codes(validateSddcSpec(good)).filter((c) => c.startsWith('vcf.spec.management-network'))).toEqual([]);
    const bad = {
      ...spec,
      vcfManagementComponentsInfrastructureSpec: {
        xRegionNetwork: { networkName: 'seg', subnetMask: '255.255.255.0', gateway: '2001:db8:11::1', ipv6Gateway: '192.168.11.1', ipv6Prefix: 200 },
      },
    };
    const found = errorCodes(validateSddcSpec(bad));
    expect(found).toContain('vcf.spec.management-network-gateway');
    expect(found).toContain('vcf.spec.management-network-ipv6-gateway');
    expect(found).toContain('vcf.spec.management-network-ipv6-prefix');
  });
});

describe('VCF Terraform — IPv6 networks the provider cannot express', () => {
  it('leaves IPv6 twins out of vcf_instance and says so, keeping IPv4 identical', () => {
    const v4 = emitTerraform(buildSddcSpec(basePlan()).spec);
    const dual = emitTerraform(buildSddcSpec(dualPlan()).spec);
    expect(dual.mainTf).not.toContain('2001:db8');
    expect(codes(dual.findings)).toContain('vcf.terraform.ipv6-network-not-expressible');
    expect(codes(v4.findings)).not.toContain('vcf.terraform.ipv6-network-not-expressible');
    const networks = (tf: string): string[] => tf.split('\n').filter((l) => /network_type|subnet|gateway/.test(l));
    expect(networks(dual.mainTf)).toEqual(networks(v4.mainTf));
  });
});

describe('VCF estate bridge — VMkernel IPv6', () => {
  const host = (name: string, mgmt6: string | undefined, vmotion6: string | undefined) => ({
    name: `${name}.corp.example`,
    cluster: 'mgmt',
    cpuSockets: 2,
    coresPerSocket: 16,
    totalCores: 32,
    memoryGib: 512,
    vmkernelAdapters: [
      { name: 'vmk0', ip: `10.1.0.${name.slice(-1)}`, subnetMask: '255.255.255.0', gateway: '10.1.0.1', ...(mgmt6 ? { ipv6: mgmt6 } : {}) },
      { name: 'vmk1', ip: `10.1.1.${name.slice(-1)}`, subnetMask: '255.255.255.0', portGroup: 'vMotion', ...(vmotion6 ? { ipv6: vmotion6 } : {}) },
    ],
  });
  const inventory = (hosts: unknown[]): Inventory =>
    ({ source: 'rvtools', hosts, vms: [], clusters: [], datastores: [], networks: [] }) as unknown as Inventory;

  it('carries the global IPv6 prefix of each network and turns on dual stack', () => {
    const plan = estateToPlan(
      inventory([
        host('esx1', 'fe80::1%vmk0/64, 2001:db8:10::11/64', '2001:db8:11::11/64'),
        host('esx2', '2001:db8:10::12/64', '2001:db8:11::12/64'),
      ]),
      scopedKey(undefined, 'mgmt'),
    );
    expect(plan.management?.cidr).toBe('10.1.0.0/24');
    expect(plan.management?.ipv6Cidr).toBe('2001:db8:10::/64');
    expect(plan.vmotion?.ipv6Cidr).toBe('2001:db8:11::/64');
    expect(plan.dualStack).toBe(true);
  });

  it('ignores link-local-only and prefix-less IPv6, and leaves IPv4-only estates alone', () => {
    const plan = estateToPlan(
      inventory([host('esx1', 'fe80::1/64', '2001:db8:11::11'), host('esx2', undefined, undefined)]),
      scopedKey(undefined, 'mgmt'),
    );
    expect(plan.management?.ipv6Cidr).toBeUndefined();
    expect(plan.vmotion?.ipv6Cidr).toBeUndefined();
    expect(plan.dualStack).toBeUndefined();
  });
});
