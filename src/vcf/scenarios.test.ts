import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { buildSddcSpec, type DeploymentPlan } from './spec-builder.ts';
import { validateSddcSpec } from './spec-validate.ts';
import { SCENARIO_RULES, componentTakesPart, scenarioRule } from './scenarios.ts';
import { hasErrors } from '../core/findings.ts';
import type { SddcSpec } from './spec-types.ts';

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

describe('deployment scenarios: the published decision table', () => {
  it('covers all eight rows Broadcom publishes', () => {
    expect(SCENARIO_RULES).toHaveLength(8);
  });

  it('builds every scenario with its documented workflowType', () => {
    for (const rule of SCENARIO_RULES) {
      const { spec } = buildSddcSpec(basePlan({ scenario: rule.scenario }));
      expect(spec.workflowType).toBe(rule.workflowType);
    }
  });

  it('produces a valid spec for every scenario', () => {
    for (const rule of SCENARIO_RULES) {
      const { spec } = buildSddcSpec(basePlan({ scenario: rule.scenario }));
      const findings = validateSddcSpec(spec);
      if (hasErrors(findings)) {
        throw new Error(
          `${rule.scenario} produced an invalid spec:\n${findings
            .filter((f) => f.severity === 'error')
            .map((f) => `  ${f.code}: ${f.message}`)
            .join('\n')}`,
        );
      }
    }
  });
});

describe('deployment scenarios: vSphere Foundation', () => {
  it('omits NSX and VCF Automation, which VVF does not have', () => {
    const { spec } = buildSddcSpec(basePlan({ scenario: 'new-vvf' }));
    expect(spec.nsxtSpec).toBeUndefined();
    expect(spec.vcfAutomationSpec).toBeUndefined();
  });

  it('still deploys vCenter, Operations and the License Server', () => {
    const { spec } = buildSddcSpec(basePlan({ scenario: 'new-vvf' }));
    expect(spec.vcenterSpec).toBeDefined();
    expect(spec.vcfOperationsSpec).toBeDefined();
    expect(spec.licenseServerSpec).toBeDefined();
  });

  it('surfaces the manual appliance prerequisite when management services are dropped', () => {
    const { findings } = buildSddcSpec(
      basePlan({ scenario: 'new-vvf', includeManagementServices: false }),
    );
    const prereq = findings.find((f) => f.code === 'vcf.build.vvf-without-management-services');
    expect(prereq).toBeDefined();
    // The step is an SSH edit on the appliance; no JSON field expresses it, so
    // the remediation has to carry the commands.
    expect(prereq?.remediation).toContain('explicit.management.components.deployment=true');
  });

  it('drops vspClusterSpec and the LCM hostnames together', () => {
    const { spec } = buildSddcSpec(
      basePlan({ scenario: 'new-vvf', includeManagementServices: false }),
    );
    expect(spec.vspClusterSpec).toBeUndefined();
    expect(spec.fleetLcmSpec).toBeUndefined();
    expect(spec.sddcLcmSpec).toBeUndefined();
  });
});

describe('deployment scenarios: NSX presence is not the n/a cell', () => {
  it('keeps NSX for a new VCF fleet even though the table marks the flag n/a', () => {
    // The n/a in that column means the useExistingDeployment flag is moot, not
    // that NSX is absent. Reading it the other way removes NSX from every
    // greenfield VCF deployment.
    const rule = scenarioRule('new-vcf-fleet');
    expect(rule.nsxExisting).toBe('na');
    expect(componentTakesPart(rule, rule.nsxExisting)).toBe(true);

    const { spec } = buildSddcSpec(basePlan());
    expect(spec.nsxtSpec).toBeDefined();
  });
});

describe('deployment scenarios: deferred components', () => {
  it('omits VCF management services and the Identity Broker', () => {
    const { spec } = buildSddcSpec(basePlan({ scenario: 'deferred-components' }));
    expect(spec.workflowType).toBe('VCF_COMPLETE');
    expect(spec.vspClusterSpec).toBeUndefined();
    expect(spec.vidbSpec).toBeUndefined();
  });

  it('is no longer reported as an undocumented workflow type', () => {
    const { findings } = buildSddcSpec(
      basePlan({ scenario: 'deferred-components', workflowType: 'VCF_COMPLETE' }),
    );
    expect(codes(findings)).not.toContain('vcf.build.undocumented-workflow-type');
  });

  it('still reports VCF_BOOTSTRAP, which genuinely has no published definition', () => {
    const { findings } = buildSddcSpec(basePlan({ workflowType: 'VCF_BOOTSTRAP' }));
    expect(codes(findings)).toContain('vcf.build.undocumented-workflow-type');
  });
});

describe('deployment scenarios: deferred components reuse the instance', () => {
  it('reports a missing existing SDDC Manager', () => {
    const { findings } = buildSddcSpec(basePlan({ scenario: 'deferred-components' }));
    expect(codes(findings)).toContain('vcf.build.deferred-without-existing-sddc-manager');
  });

  it('is quiet once the existing SDDC Manager is supplied', () => {
    const { spec, findings } = buildSddcSpec(
      basePlan({
        scenario: 'deferred-components',
        existing: {
          vcenter: { fqdn: 'vcenter.vcf.lab', sslThumbprint: 'AA:BB' },
          sddcManager: { fqdn: 'sddcm.vcf.lab', sslThumbprint: 'CC:DD' },
        },
      }),
    );
    expect(codes(findings)).not.toContain('vcf.build.deferred-without-existing-sddc-manager');
    expect(spec.sddcManagerSpec?.useExistingDeployment).toBe(true);
    expect(spec.vcenterSpec.useExistingDeployment).toBe(true);
  });
});

describe('deployment scenarios: identity broker', () => {
  it('is emitted for a primary instance', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(spec.vidbSpec).toBeDefined();
  });

  it('can be omitted for a further instance, which the footnote allows', () => {
    const { spec } = buildSddcSpec(
      basePlan({ instanceRole: 'secondary', includeIdentityBroker: false }),
    );
    expect(spec.workflowType).toBe('VCF_EXTEND');
    expect(spec.vidbSpec).toBeUndefined();
  });
});

describe('deployment scenarios: backward compatibility', () => {
  it('still builds a plain plan as a new VCF fleet', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(spec.workflowType).toBe('VCF');
    expect(spec.vspClusterSpec).toBeDefined();
    expect(spec.licenseServerSpec).toBeDefined();
  });

  it('still builds a secondary instance as VCF_EXTEND without a fleetFqdn', () => {
    const { spec } = buildSddcSpec(basePlan({ instanceRole: 'secondary' }));
    expect(spec.workflowType).toBe('VCF_EXTEND');
    expect(spec.vspClusterSpec?.fleetFqdn).toBeUndefined();
  });
});

describe('deployment scenarios: disagreement with the plan', () => {
  it('warns when a converge scenario has no existing vCenter to converge', () => {
    const { findings } = buildSddcSpec(basePlan({ scenario: 'converge-to-vcf-fleet' }));
    expect(codes(findings)).toContain('vcf.build.scenario-existing-mismatch');
  });

  it('warns when the plan overrides the row workflowType', () => {
    const { findings } = buildSddcSpec(
      basePlan({ scenario: 'new-vcf-fleet', workflowType: 'VVF' }),
    );
    expect(codes(findings)).toContain('vcf.build.workflow-type-override');
  });
});

describe('newly enforced required fields', () => {
  it('rejects an NFS volume with no readOnly flag', () => {
    const { spec } = buildSddcSpec(
      basePlan({ storage: 'nfs', nfsServers: ['172.30.0.9'], nfsPath: '/export/vcf' }),
    );
    // The builder always emits it; a hand-authored or imported spec may not.
    delete (spec.datastoreSpec?.nfsDatastoreSpec?.nasVolume as { readOnly?: boolean }).readOnly;
    expect(codes(validateSddcSpec(spec))).toContain('vcf.spec.nfs-readonly-missing');
  });

  it('accepts the NFS volume the builder actually emits', () => {
    const { spec } = buildSddcSpec(
      basePlan({ storage: 'nfs', nfsServers: ['172.30.0.9'], nfsPath: '/export/vcf' }),
    );
    expect(spec.datastoreSpec?.nfsDatastoreSpec?.nasVolume.readOnly).toBe(false);
    expect(codes(validateSddcSpec(spec))).not.toContain('vcf.spec.nfs-readonly-missing');
  });

  it('rejects a management component network missing its required trio', () => {
    const { spec } = buildSddcSpec(basePlan());
    const withPartialNetwork: SddcSpec = {
      ...spec,
      vcfManagementComponentsInfrastructureSpec: {
        xRegionNetwork: { networkName: 'xregion', subnetMask: '255.255.255.0' } as never,
      },
    };
    const findings = validateSddcSpec(withPartialNetwork);
    expect(codes(findings)).toContain('vcf.spec.management-network-incomplete');
    expect(hasErrors(findings)).toBe(true);
  });
});
