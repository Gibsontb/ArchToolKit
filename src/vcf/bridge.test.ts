import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { sizingToPlan, scenarioForPath, describeSizingHandoff } from './bridge.ts';
import { sizeDeployment, type SizingInput } from './sizing.ts';
import { buildSddcSpec, type DeploymentPlan } from './spec-builder.ts';
import { validateSddcSpec } from './spec-validate.ts';
import { toSizingInput } from '../vmware/analyze.ts';
import { emptyInventory, type Inventory, type InventoryHost } from '../vmware/inventory.ts';
import { hasErrors } from '../core/findings.ts';

function sizingInput(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    path: 'greenfield',
    profile: 'simple',
    instanceCount: 1,
    topology: 'standard',
    storage: 'vsan-esa',
    hostCount: 4,
    host: {
      cpuSockets: 2,
      coresPerCpu: 32,
      hyperthreading: true,
      ramGib: 1024,
      rawStorageGib: 15360,
    },
    ...overrides,
  };
}

function host(name: string): InventoryHost {
  return {
    name,
    cpuSockets: 2,
    coresPerSocket: 24,
    totalCores: 48,
    threads: 96,
    memoryGib: 768,
  };
}

function estate(hostCount = 6): Inventory {
  return {
    ...emptyInventory({ kind: 'rvtools', label: 'prod-vc01' }),
    hosts: Array.from({ length: hostCount }, (_, i) => host(`esx${i + 1}`)),
  };
}

describe('sizing path to deployment scenario', () => {
  it('maps greenfield and converge', () => {
    expect(scenarioForPath('greenfield')).toBe('new-vcf-fleet');
    expect(scenarioForPath('brownfield-converge')).toBe('converge-to-vcf-fleet');
  });

  it('maps nothing for a workload-domain import', () => {
    // Importing an estate as a workload domain is a day-2 operation, not a
    // bring-up, so inventing a bring-up scenario for it would be wrong.
    expect(scenarioForPath('brownfield-import')).toBeUndefined();
  });
});

describe('sizing result to deployment plan', () => {
  it('carries the facts both tools share', () => {
    const result = sizeDeployment(sizingInput({ hostCount: 8, storage: 'vsan-osa' }));
    const plan = sizingToPlan(result);
    expect(plan.hostCount).toBe(8);
    expect(plan.storage).toBe('vsan-osa');
    expect(plan.failuresToTolerate).toBe(result.storage.ftt);
    expect(plan.scenario).toBe('new-vcf-fleet');
  });

  it('collapses the sizing profile to the builder’s HA split', () => {
    expect(sizingToPlan(sizeDeployment(sizingInput({ profile: 'simple' }))).profile).toBe('simple');
    expect(sizingToPlan(sizeDeployment(sizingInput({ profile: 'ha-large' }))).profile).toBe('ha');
  });

  it('carries the pool counts, which no form field represents', () => {
    const result = sizeDeployment(sizingInput());
    const plan = sizingToPlan(result);
    expect(plan.vcfmsPool?.count).toBe(result.ips.vcfmsRecommended);
    expect(plan.automationPool?.count).toBe(result.ips.automationIps);
    expect(plan.tepPool?.count).toBe(result.ips.tepIps);
  });

  it('describes itself for the banner', () => {
    const text = describeSizingHandoff(sizeDeployment(sizingInput({ hostCount: 5 })));
    expect(text).toContain('5 hosts');
    expect(text).toContain('vsan-esa');
  });
});

describe('inventory to sizing to spec, end to end', () => {
  it('turns an imported estate into a valid specification', () => {
    // The whole point of the toolkit: what is there, what it must become, and
    // the document that builds it, without retyping between the three.
    const inventory = estate(6);

    const sizing = toSizingInput(inventory);
    expect(sizing).toBeDefined();
    expect(sizing?.hostCount).toBe(6);

    const result = sizeDeployment(sizing as SizingInput);
    const carried = sizingToPlan(result);
    expect(carried.scenario).toBe('converge-to-vcf-fleet');

    // The page supplies what sizing cannot know: names, domains, VLANs.
    const plan: DeploymentPlan = {
      sddcId: 'vcf-m01',
      domainSuffix: 'vcf.lab',
      namePrefix: 'vcf-m01',
      esxHostnameBase: 'esx',
      dnsServers: ['192.168.30.29', '192.168.30.30'],
      ntpServers: ['192.168.30.1'],
      management: { cidr: '172.30.0.0/23', vlanId: 30 },
      vmotion: { cidr: '172.30.40.0/24', vlanId: 40 },
      vsan: { cidr: '172.30.50.0/24', vlanId: 50 },
      hostTep: { cidr: '172.30.60.0/23', vlanId: 60 },
      existing: { vcenter: { fqdn: 'vcenter.vcf.lab', sslThumbprint: 'AA:BB' } },
      ...carried,
      hostCount: carried.hostCount ?? 6,
      storage: carried.storage ?? 'vsan-esa',
    };

    const { spec } = buildSddcSpec(plan);
    expect(spec.hostSpecs).toHaveLength(6);
    expect(spec.workflowType).toBe('VCF');

    const findings = validateSddcSpec(spec);
    if (hasErrors(findings)) {
      throw new Error(
        `End-to-end spec failed validation:\n${findings
          .filter((f) => f.severity === 'error')
          .map((f) => `  ${f.code}: ${f.message}`)
          .join('\n')}`,
      );
    }
    expect(hasErrors(findings)).toBe(false);
  });
});
