/**
 * Fleet scenarios: the document each of Broadcom's eight published rows must
 * produce, compared with Broadcom's own sample specifications where one exists.
 *
 * Samples (key sets and component shapes transcribed, secrets omitted):
 *  - domainSpec-sfo-m01-example02.json — new fleet;
 *  - domainSpec-sfo-m01-example03.json — converge to a new fleet;
 *  - domainSpec-example-VMSPonVVF.json — VCF management services for VVF;
 *  - "Deploy Deferred Components" on the shared network, a dedicated network
 *    and NSX segments (VCF 9.1 TechDocs) — VCF_COMPLETE.
 */
import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { buildSddcSpec, SIZE_PRESETS, PLACEHOLDER_SECRET, type DeploymentPlan, type SizePreset } from './spec-builder.ts';
import { validateSddcSpec } from './spec-validate.ts';
import { SCENARIO_RULES, scenarioRule } from './scenarios.ts';
import type { SddcSpec } from './spec-types.ts';
import type { Finding } from '../core/findings.ts';

/** A well-formed SHA256 thumbprint. */
const TP = Array.from({ length: 32 }, () => 'AB').join(':');
const TP2 = Array.from({ length: 32 }, () => 'CD').join(':');

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

const codes = (findings: readonly Finding[]): string[] => findings.map((f) => f.code);
const keys = (spec: SddcSpec): string[] => Object.keys(spec).sort();
const sorted = (list: string[]): string[] => [...list].sort();

/**
 * Validator errors, less the two schema-required keys Broadcom's own minimal
 * examples omit (networkSpecs and dnsSpec; unconfirmed whether the installer
 * insists on them for these workflows).
 */
function realErrors(spec: SddcSpec): string[] {
  return validateSddcSpec(spec)
    .filter((f) => f.severity === 'error')
    .filter((f) => !(f.code === 'vcf.spec.missing-required' && (f.path === 'networkSpecs' || f.path === 'dnsSpec')))
    .map((f) => `${f.code}${f.path ? ` @ ${f.path}` : ''}`);
}

// --- existing components used across the scenarios ---------------------------
const existingVcenter = { fqdn: 'vcenter-1.vrack.rainpole.io', sslThumbprint: TP };
const existingSddcm = { fqdn: 'sddc-manager.vrack.rainpole.io', sslThumbprint: TP };
const existingOps = { fqdn: 'flt-ops01a.rainpole.io', sslThumbprint: TP2 };
const existingAutomation = { fqdn: 'flt-auto01.rainpole.io', sslThumbprint: TP };
const existingNsx = {
  fqdn: 'sfo-m01-nsx01.sfo.rainpole.io',
  sslThumbprint: TP,
  nodeFqdns: ['sfo-m01-nsx01a.sfo.rainpole.io'],
};

describe('fleet scenarios: every row builds the documented workflowType and shape', () => {
  it('new VCF fleet: VCF, everything new', () => {
    const { spec, findings } = buildSddcSpec(basePlan({ scenario: 'new-vcf-fleet' }));
    expect(spec.workflowType).toBe('VCF');
    expect(spec.vcenterSpec.useExistingDeployment).toBeUndefined();
    expect(spec.vcfOperationsSpec?.useExistingDeployment).toBeUndefined();
    expect(spec.vcfAutomationSpec?.useExistingDeployment).toBeUndefined();
    expect(spec.nsxtSpec?.useExistingDeployment).toBeUndefined();
    expect(spec.vspClusterSpec?.fleetFqdn).toBeDefined();
    expect(spec.licenseServerSpec).toBeDefined();
    expect(spec.vidbSpec).toBeDefined();
    expect(realErrors(spec)).toEqual([]);
    expect(codes(findings)).not.toContain('vcf.build.scenario-existing-mismatch');
  });

  it('new VCF fleet: VCF Automation may be an existing one (T/F)', () => {
    const { spec } = buildSddcSpec(
      basePlan({ scenario: 'new-vcf-fleet', existing: { automation: existingAutomation } }),
    );
    expect(spec.vcfAutomationSpec?.useExistingDeployment).toBe(true);
    expect(spec.vcfAutomationSpec?.hostname).toBe('flt-auto01.rainpole.io');
  });

  it('new VCF instance: VCF_EXTEND, existing Operations and Automation, no fleetFqdn', () => {
    const { spec, findings } = buildSddcSpec(
      basePlan({
        scenario: 'new-vcf-instance',
        existing: { operations: existingOps, automation: existingAutomation },
      }),
    );
    expect(spec.workflowType).toBe('VCF_EXTEND');
    expect(spec.vcenterSpec.useExistingDeployment).toBeUndefined();
    expect(spec.vcfOperationsSpec?.useExistingDeployment).toBe(true);
    expect(spec.vcfAutomationSpec?.useExistingDeployment).toBe(true);
    expect(spec.vspClusterSpec).toBeDefined();
    expect(spec.vspClusterSpec?.fleetFqdn).toBeUndefined();
    // A further instance carries no fleet-level lifecycle block.
    expect(spec.fleetLcmSpec).toBeUndefined();
    expect(spec.sddcLcmSpec?.hostname).toBe(spec.vspClusterSpec?.instanceFqdn);
    expect(codes(findings)).not.toContain('vcf.build.scenario-existing-mismatch');
    expect(realErrors(spec)).toEqual([]);
  });

  it('deferred components: VCF_COMPLETE, existing vCenter and SDDC Manager, new Operations and Automation', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        scenario: 'deferred-components',
        existing: { vcenter: existingVcenter, sddcManager: existingSddcm },
      }),
    );
    expect(spec.workflowType).toBe('VCF_COMPLETE');
    expect(spec.vcenterSpec.useExistingDeployment).toBe(true);
    expect(spec.sddcManagerSpec?.useExistingDeployment).toBe(true);
    expect(spec.vcfOperationsSpec?.useExistingDeployment).toBe(false);
    expect(spec.vcfAutomationSpec?.useExistingDeployment).toBeUndefined();
    expect(spec.vcfAutomationSpec?.platformFqdn).toBeDefined();
    expect(spec.vspClusterSpec).toBeUndefined();
    expect(spec.nsxtSpec).toBeUndefined();
    expect(spec.vidbSpec).toBeUndefined();
    expect(spec.licenseServerSpec).toBeDefined();
    expect(realErrors(spec)).toEqual([]);
  });

  it('converge to a new fleet: VCF, existing vCenter, NSX either way', () => {
    const plan = basePlan({ scenario: 'converge-to-vcf-fleet', existing: { vcenter: existingVcenter } });
    const newNsx = buildSddcSpec(plan).spec;
    expect(newNsx.workflowType).toBe('VCF');
    expect(newNsx.vcenterSpec.useExistingDeployment).toBe(true);
    expect(newNsx.nsxtSpec?.useExistingDeployment).toBeUndefined();
    expect(newNsx.vspClusterSpec?.fleetFqdn).toBeDefined();
    expect(realErrors(newNsx)).toEqual([]);

    const importedNsx = buildSddcSpec({ ...plan, existing: { vcenter: existingVcenter, nsx: existingNsx } }).spec;
    expect(importedNsx.nsxtSpec?.useExistingDeployment).toBe(true);
    expect(importedNsx.nsxtSpec?.vipFqdn).toBe('sfo-m01-nsx01.sfo.rainpole.io');
    expect(importedNsx.nsxtSpec?.nsxtManagers).toEqual([{ hostname: 'sfo-m01-nsx01a.sfo.rainpole.io' }]);
    // Nothing is sized on a component that already exists.
    expect(importedNsx.nsxtSpec?.nsxtManagerSize).toBeUndefined();
  });

  it('converge to a new instance: VCF_EXTEND, existing vCenter, Operations and Automation', () => {
    const { spec, findings } = buildSddcSpec(
      basePlan({
        scenario: 'converge-to-vcf-instance',
        existing: { vcenter: existingVcenter, operations: existingOps, automation: existingAutomation },
      }),
    );
    expect(spec.workflowType).toBe('VCF_EXTEND');
    expect(spec.vcenterSpec.useExistingDeployment).toBe(true);
    expect(spec.vcfOperationsSpec?.useExistingDeployment).toBe(true);
    expect(spec.vcfAutomationSpec?.useExistingDeployment).toBe(true);
    expect(spec.vspClusterSpec?.fleetFqdn).toBeUndefined();
    expect(codes(findings)).not.toContain('vcf.build.scenario-existing-mismatch');
    expect(realErrors(spec)).toEqual([]);
  });

  it('new VVF: VVF, no NSX and no Automation, management services optional', () => {
    const { spec } = buildSddcSpec(basePlan({ scenario: 'new-vvf' }));
    expect(spec.workflowType).toBe('VVF');
    expect(spec.nsxtSpec).toBeUndefined();
    expect(spec.vcfAutomationSpec).toBeUndefined();
    expect(spec.vcfOperationsSpec?.useExistingDeployment).toBeUndefined();
    expect(spec.vspClusterSpec).toBeDefined();
    expect(spec.licenseServerSpec).toBeDefined();
    expect(spec.vidbSpec).toBeDefined();
    expect(realErrors(spec)).toEqual([]);
  });

  it('converge to VVF: VVF, existing vCenter, no identity broker', () => {
    const { spec } = buildSddcSpec(basePlan({ scenario: 'converge-to-vvf', existing: { vcenter: existingVcenter } }));
    expect(spec.workflowType).toBe('VVF');
    expect(spec.vcenterSpec.useExistingDeployment).toBe(true);
    expect(spec.vidbSpec).toBeUndefined();
    expect(spec.nsxtSpec).toBeUndefined();
    expect(spec.vcfAutomationSpec).toBeUndefined();
    expect(realErrors(spec)).toEqual([]);
  });

  it('VCF management services for VVF: VVF, existing vCenter and Operations, new services', () => {
    const { spec, findings } = buildSddcSpec(
      basePlan({
        scenario: 'vvf-management-services',
        existing: { vcenter: existingVcenter, operations: existingOps },
      }),
    );
    expect(spec.workflowType).toBe('VVF');
    expect(spec.vcenterSpec.useExistingDeployment).toBe(true);
    expect(spec.vcfOperationsSpec?.useExistingDeployment).toBe(true);
    expect(spec.vspClusterSpec?.useExistingDeployment).toBe(false);
    expect(spec.vcfAutomationSpec).toBeUndefined();
    expect(spec.nsxtSpec).toBeUndefined();
    expect(spec.licenseServerSpec).toBeDefined();
    expect(codes(findings)).not.toContain('vcf.build.scenario-existing-mismatch');
    expect(realErrors(spec)).toEqual([]);
  });

  it('covers all eight rows', () => {
    // Each row above is one of Broadcom's eight; a new row must get a test here.
    expect(SCENARIO_RULES.map((r) => r.scenario)).toEqual([
      'new-vcf-fleet',
      'new-vcf-instance',
      'deferred-components',
      'converge-to-vcf-fleet',
      'converge-to-vcf-instance',
      'new-vvf',
      'converge-to-vvf',
      'vvf-management-services',
    ]);
  });
});

describe('fleet scenarios: existing FQDNs are honoured', () => {
  it('uses every existing.*.fqdn instead of a generated name', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        scenario: 'converge-to-vcf-instance',
        existing: {
          vcenter: existingVcenter,
          nsx: existingNsx,
          sddcManager: existingSddcm,
          operations: existingOps,
          automation: existingAutomation,
          licenseServer: { fqdn: 'ls.vrack.rainpole.io', sslThumbprint: TP },
          collector: { fqdn: 'vcfopscp-1.vrack.rainpole.io', sslThumbprint: TP },
        },
      }),
    );
    expect(spec.vcenterSpec.vcenterHostname).toBe('vcenter-1.vrack.rainpole.io');
    expect(spec.nsxtSpec?.vipFqdn).toBe('sfo-m01-nsx01.sfo.rainpole.io');
    expect(spec.sddcManagerSpec?.hostname).toBe('sddc-manager.vrack.rainpole.io');
    expect(spec.vcfOperationsSpec?.nodes[0]?.hostname).toBe('flt-ops01a.rainpole.io');
    expect(spec.vcfAutomationSpec?.hostname).toBe('flt-auto01.rainpole.io');
    expect(spec.licenseServerSpec?.hostname).toBe('ls.vrack.rainpole.io');
    expect(spec.vcfOperationsCollectorSpec?.hostname).toBe('vcfopscp-1.vrack.rainpole.io');
    expect(JSON.stringify(spec)).not.toContain('vcf-m01-vc01');
    expect(JSON.stringify(spec)).not.toContain('vcf-m01-sddcm01');
  });

  it('references an existing vCenter without sizing it', () => {
    const { spec } = buildSddcSpec(
      basePlan({ scenario: 'converge-to-vcf-fleet', existing: { vcenter: existingVcenter } }),
    );
    expect(spec.vcenterSpec.sslThumbprint).toBe(TP);
    expect(spec.vcenterSpec.vmSize).toBeUndefined();
    expect(spec.vcenterSpec.storageSize).toBeUndefined();
    expect(spec.vcenterSpec.adminUserSsoUsername).toBe('administrator@vsphere.local');
  });
});

describe('VCF_EXTEND: the existing VCF Operations master node', () => {
  it('references exactly one node, the existing master, whatever the profile', () => {
    for (const sizePreset of ['simple', 'ha-small', 'ha-medium', 'ha-large'] as const) {
      const { spec } = buildSddcSpec(
        basePlan({ scenario: 'new-vcf-instance', sizePreset, existing: { operations: existingOps } }),
      );
      const ops = spec.vcfOperationsSpec!;
      expect(ops.nodes).toEqual([{ hostname: 'flt-ops01a.rainpole.io', type: 'master', sslThumbprint: TP2 }]);
      expect(ops.useExistingDeployment).toBe(true);
      expect(ops.applianceSize).toBeUndefined();
      expect(ops.loadBalancerFqdn).toBeUndefined();
    }
  });

  it('keeps the existing admin password required even when passwords are auto-generated', () => {
    const { spec, placeholders } = buildSddcSpec(
      basePlan({ instanceRole: 'secondary', autoGeneratePasswords: true, existing: { operations: existingOps } }),
    );
    expect(spec.vcfOperationsSpec?.adminUserPassword).toBe(PLACEHOLDER_SECRET);
    expect(placeholders).toContain('vcfOperationsSpec.adminUserPassword');
    expect(
      buildSddcSpec(
        basePlan({ instanceRole: 'secondary', existing: { operations: existingOps }, passwords: { opsAdmin: 'Existing!Admin99' } }),
      ).spec.vcfOperationsSpec?.adminUserPassword,
    ).toBe('Existing!Admin99');
  });

  it('reports a further instance that does not name the fleet’s Operations', () => {
    const { spec, findings, placeholders } = buildSddcSpec(basePlan({ instanceRole: 'secondary' }));
    expect(codes(findings)).toContain('vcf.build.existing-component-not-supplied');
    expect(spec.vcfOperationsSpec?.nodes).toHaveLength(1);
    expect(spec.vcfOperationsSpec?.nodes[0]?.sslThumbprint).toBe(PLACEHOLDER_SECRET);
    expect(placeholders).toContain('vcfOperationsSpec.nodes[0].sslThumbprint');
  });

  it('matches Broadcom’s existing-Operations block from the VVF example', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        scenario: 'vvf-management-services',
        existing: { vcenter: existingVcenter, operations: existingOps },
        passwords: { opsAdmin: 'Existing!Admin99' },
      }),
    );
    expect(spec.vcfOperationsSpec).toEqual({
      nodes: [{ hostname: 'flt-ops01a.rainpole.io', type: 'master', sslThumbprint: TP2 }],
      adminUserPassword: 'Existing!Admin99',
      useExistingDeployment: true,
    });
  });
});

describe('existing License Server, cloud proxy, management services and Automation', () => {
  it('references an existing License Server with its thumbprint only', () => {
    const { spec } = buildSddcSpec(
      basePlan({ instanceRole: 'secondary', existing: { operations: existingOps, licenseServer: { fqdn: 'ls.vcf.lab', sslThumbprint: TP } } }),
    );
    expect(spec.licenseServerSpec).toEqual({ hostname: 'ls.vcf.lab', useExistingDeployment: true, sslThumbprint: TP });
  });

  it('can leave the License Server out where the * footnote makes it conditional', () => {
    const { spec, findings } = buildSddcSpec(
      basePlan({ scenario: 'new-vcf-instance', includeLicenseServer: false, existing: { operations: existingOps } }),
    );
    expect(spec.licenseServerSpec).toBeUndefined();
    expect(codes(findings)).toContain('vcf.build.scenario-conditional-omitted');
    expect(codes(findings)).not.toContain('vcf.build.scenario-conflict');
    expect(scenarioRule('new-vcf-instance').conditionalPresence).toContain('licenseServer');
  });

  it('refuses to drop the License Server where it is unconditional', () => {
    const { spec, findings } = buildSddcSpec(basePlan({ includeLicenseServer: false }));
    expect(spec.licenseServerSpec).toBeDefined();
    expect(codes(findings)).toContain('vcf.build.scenario-conflict');
  });

  it('can leave the identity broker out when converging onto an Operations that has one', () => {
    const { spec } = buildSddcSpec(
      basePlan({ scenario: 'converge-to-vcf-fleet', includeIdentityBroker: false, existing: { vcenter: existingVcenter } }),
    );
    expect(spec.vidbSpec).toBeUndefined();
  });

  it('references an existing cloud proxy with no size or password', () => {
    const { spec } = buildSddcSpec(
      basePlan({ existing: { collector: { fqdn: 'proxy.vcf.lab', sslThumbprint: TP } } }),
    );
    expect(spec.vcfOperationsCollectorSpec).toEqual({
      hostname: 'proxy.vcf.lab',
      useExistingDeployment: true,
      sslThumbprint: TP,
    });
  });

  it('sizes a new cloud proxy from the plan', () => {
    expect(buildSddcSpec(basePlan({ collectorSize: 'standard' })).spec.vcfOperationsCollectorSpec?.applianceSize).toBe(
      'standard',
    );
    expect(buildSddcSpec(basePlan()).spec.vcfOperationsCollectorSpec?.applianceSize).toBe('small');
  });

  it('references existing VCF management services with no pool, size or password', () => {
    const { spec } = buildSddcSpec(
      basePlan({ existing: { managementServices: { fqdn: 'platform.vcf.lab', sslThumbprint: TP } } }),
    );
    const vsp = spec.vspClusterSpec!;
    expect(vsp.useExistingDeployment).toBe(true);
    expect(vsp.sslThumbprint).toBe(TP);
    expect(vsp.platformFqdn).toBe('platform.vcf.lab');
    expect(vsp.ipv4Pool).toBeUndefined();
    expect(vsp.size).toBeUndefined();
    expect(vsp.systemUserPassword).toBeUndefined();
  });

  it('references an existing VCF Automation with only the fields the API wants', () => {
    const { spec } = buildSddcSpec(basePlan({ existing: { automation: existingAutomation } }));
    expect(spec.vcfAutomationSpec).toEqual({
      hostname: 'flt-auto01.rainpole.io',
      internalClusterCidr: '198.18.0.0/15',
      useExistingDeployment: true,
      sslThumbprint: TP,
    });
  });

  it('sets the Automation node prefix and internal CIDR separately from the services runtime', () => {
    const { spec } = buildSddcSpec(
      basePlan({ automationNodePrefix: 'vcfa-node', automationInternalClusterCidr: '240.0.0.0/15' }),
    );
    expect(spec.vcfAutomationSpec?.nodePrefix).toBe('vcfa-node');
    expect(spec.vcfAutomationSpec?.internalClusterCidr).toBe('240.0.0.0/15');
    expect(spec.vspClusterSpec?.internalClusterCidrIpv4).toBe('198.18.0.0/15');
  });
});

describe('minimal documents', () => {
  it('deferred components: the key set of Broadcom’s VCF_COMPLETE examples', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        scenario: 'deferred-components',
        managementNetworkModel: 'dedicated-vlan',
        fleetManagement: { cidr: '10.11.99.0/24', vlanId: 99, portGroupName: 'mgmt-components-pg' },
        existing: { vcenter: existingVcenter, sddcManager: existingSddcm },
      }),
    );
    // The dedicated-network example; "version" is the builder's addition.
    expect(keys(spec)).toEqual(
      sorted([
        'sddcId',
        'workflowType',
        'vcenterSpec',
        'sddcManagerSpec',
        'ceipEnabled',
        'vcfInstanceName',
        'vcfOperationsSpec',
        'vcfOperationsCollectorSpec',
        'licenseServerSpec',
        'vcfAutomationSpec',
        'vcfManagementComponentsInfrastructureSpec',
        'version',
      ]),
    );
    expect(sorted(Object.keys(spec.vcenterSpec))).toEqual(
      sorted(['vcenterHostname', 'sslThumbprint', 'adminUserSsoPassword', 'adminUserSsoUsername', 'useExistingDeployment']),
    );
    expect(spec.vcfManagementComponentsInfrastructureSpec?.xRegionNetwork).toEqual({
      networkName: 'mgmt-components-pg',
      subnetMask: '255.255.255.0',
      gateway: '10.11.99.1',
    });
    expect(spec.vcfOperationsCollectorSpec?.useExistingDeployment).toBe(false);
  });

  it('deferred components on the shared network carry no xRegionNetwork, as that example has none', () => {
    const { spec } = buildSddcSpec(
      basePlan({ scenario: 'deferred-components', existing: { vcenter: existingVcenter, sddcManager: existingSddcm } }),
    );
    expect(spec.vcfManagementComponentsInfrastructureSpec).toBeUndefined();
    expect(spec.hostSpecs).toBeUndefined();
    expect(spec.dvsSpecs).toBeUndefined();
    expect(spec.datastoreSpec).toBeUndefined();
    expect(spec.clusterSpec).toBeUndefined();
  });

  it('deferred components on an NSX segment name the segment', () => {
    const segment = { networkName: 'overlay-seg', subnetMask: '255.255.255.0', gateway: '192.168.11.1' };
    const { spec } = buildSddcSpec(
      basePlan({
        scenario: 'deferred-components',
        managementNetworkModel: 'dedicated-vlan-overlay',
        fleetManagement: { cidr: '10.11.99.0/24', vlanId: 99 },
        managementComponentNetworks: { xRegion: segment },
        existing: { vcenter: existingVcenter, sddcManager: existingSddcm },
      }),
    );
    expect(spec.vcfManagementComponentsInfrastructureSpec?.xRegionNetwork).toEqual(segment);
  });

  it('only counts placeholders that are in the minimal document', () => {
    const { placeholders } = buildSddcSpec(
      basePlan({ scenario: 'deferred-components', existing: { vcenter: existingVcenter, sddcManager: existingSddcm } }),
    );
    expect(placeholders.some((p) => p.startsWith('hostSpecs'))).toBe(false);
    expect(placeholders.some((p) => p.startsWith('nsxtSpec'))).toBe(false);
  });

  it('VCF management services for VVF: the key set of domainSpec-example-VMSPonVVF.json', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        scenario: 'vvf-management-services',
        vmManagement: { cidr: '25.0.0.0/22', vlanId: 25, portGroupName: 'vm-mgmt-pg' },
        existing: { vcenter: existingVcenter, operations: existingOps },
      }),
    );
    // "vcfInstanceName" is the builder's addition.
    expect(keys(spec)).toEqual(
      sorted([
        'version',
        'ceipEnabled',
        'workflowType',
        'vcfOperationsSpec',
        'vcenterSpec',
        'skipEsxThumbprintValidation',
        'sddcId',
        'vcfManagementComponentsInfrastructureSpec',
        'vspClusterSpec',
        'licenseServerSpec',
        'vcfInstanceName',
      ]),
    );
    expect(spec.skipEsxThumbprintValidation).toBe(true);
    expect(spec.vcfManagementComponentsInfrastructureSpec?.xRegionNetwork).toEqual({
      networkName: 'vm-mgmt-pg',
      subnetMask: '255.255.252.0',
      gateway: '25.0.0.1',
    });
    expect(spec.vcenterSpec.rootVcenterPassword).toBeDefined();
    expect(spec.vspClusterSpec?.fleetFqdn).toBeDefined();
    expect(spec.licenseServerSpec).toEqual({ hostname: 'vcf-m01-lic01.vcf.lab' });
  });

  it('converge, on request: the key set of domainSpec-sfo-m01-example03.json', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        scenario: 'converge-to-vcf-fleet',
        documentShape: 'minimal',
        includeFleetServiceSpecs: false,
        managementPoolName: 'sfo01-m01-r01-network-pool-01',
        existing: { vcenter: existingVcenter },
      }),
    );
    expect(keys(spec)).toEqual(
      sorted([
        'sddcId',
        'vcfInstanceName',
        'workflowType',
        'version',
        'ceipEnabled',
        'managementPoolName',
        'vcenterSpec',
        'nsxtSpec',
        'vcfManagementComponentsInfrastructureSpec',
        'sddcManagerSpec',
        'vspClusterSpec',
        'vcfAutomationSpec',
        'vidbSpec',
        'vcfOperationsSpec',
        'vcfOperationsCollectorSpec',
        'licenseServerSpec',
      ]),
    );
  });

  it('keeps the full document for a converge unless asked', () => {
    const { spec } = buildSddcSpec(basePlan({ scenario: 'converge-to-vcf-fleet', existing: { vcenter: existingVcenter } }));
    expect(spec.hostSpecs).toBeDefined();
    expect(spec.networkSpecs!.length).toBeGreaterThan(0);
  });
});

describe('xRegionNetwork per placement model', () => {
  it('shared VLAN greenfield: none', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(spec.vcfManagementComponentsInfrastructureSpec).toBeUndefined();
  });

  it('dedicated VLAN: the dedicated port group', () => {
    const { spec } = buildSddcSpec(
      basePlan({ fleetManagement: { cidr: '172.30.80.0/24', vlanId: 80 } }),
    );
    expect(spec.vcfManagementComponentsInfrastructureSpec?.xRegionNetwork).toEqual({
      networkName: 'vcf-m01-pg-fleet',
      subnetMask: '255.255.255.0',
      gateway: '172.30.80.1',
    });
    const fleet = spec.networkSpecs!.find((n) => n.networkType === 'FLEET_MANAGEMENT');
    expect(fleet?.portGroupKey).toBe('vcf-m01-pg-fleet');
  });

  it('dedicated VLAN with dual stack carries the IPv6 gateway and prefix', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        dualStack: true,
        fleetManagement: { cidr: '172.30.80.0/24', vlanId: 80, ipv6Cidr: '2001:db8:80::/64', ipv6Gateway: '2001:db8:80::1' },
      }),
    );
    const x = spec.vcfManagementComponentsInfrastructureSpec?.xRegionNetwork;
    expect(x?.ipv6Gateway).toBe('2001:db8:80::1');
    expect(x?.ipv6Prefix).toBe(64);
  });

  it('NSX overlay and stretched overlay: the named segment', () => {
    const segment = { networkName: 'xregion-seg', subnetMask: '255.255.255.0', gateway: '172.30.100.1' };
    for (const managementNetworkModel of ['dedicated-vlan-overlay', 'dedicated-vlan-stretched-overlay'] as const) {
      const { spec } = buildSddcSpec(
        basePlan({
          managementNetworkModel,
          fleetManagement: { cidr: '172.30.80.0/24', vlanId: 80 },
          managementComponentNetworks: { xRegion: segment, local: segment },
        }),
      );
      expect(spec.vcfManagementComponentsInfrastructureSpec?.xRegionNetwork).toEqual(segment);
    }
  });

  it('converge on the shared network: the existing VM management port group', () => {
    const { spec, findings } = buildSddcSpec(
      basePlan({
        scenario: 'converge-to-vcf-fleet',
        existing: { vcenter: existingVcenter },
        vmManagement: { cidr: '10.12.10.0/24', vlanId: 1110, portGroupName: 'vm-management-dvpg' },
      }),
    );
    expect(spec.vcfManagementComponentsInfrastructureSpec?.xRegionNetwork).toEqual({
      networkName: 'vm-management-dvpg',
      subnetMask: '255.255.255.0',
      gateway: '10.12.10.1',
    });
    expect(codes(findings)).not.toContain('vcf.build.xregion-port-group-unnamed');
  });

  it('warns when a converge must guess the existing port group name', () => {
    const { findings } = buildSddcSpec(
      basePlan({ scenario: 'converge-to-vcf-fleet', existing: { vcenter: existingVcenter } }),
    );
    expect(codes(findings)).toContain('vcf.build.xregion-port-group-unnamed');
  });
});

describe('NFS network', () => {
  it('emits the NFS network from its CIDR and VLAN', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        storage: 'nfs',
        nfsServers: ['172.30.70.10'],
        nfs: { cidr: '172.30.70.0/24', vlanId: 70 },
      }),
    );
    const nfs = spec.networkSpecs!.find((n) => n.networkType === 'NFS');
    expect(nfs?.subnet).toBe('172.30.70.0/24');
    expect(nfs?.vlanId).toBe(70);
    expect(nfs?.mtu).toBe(9000);
    expect(spec.dvsSpecs?.[0]?.networks).toContain('NFS');
    expect(realErrors(spec)).toEqual([]);
  });

  it('is an error to choose NFS storage without the NFS network', () => {
    const { findings } = buildSddcSpec(basePlan({ storage: 'nfs', nfsServers: ['172.30.70.10'] }));
    expect(codes(findings)).toContain('vcf.build.nfs-network-missing');
  });
});

describe('installer-generated passwords', () => {
  it('leaves every auto-generatable password blank', () => {
    const { spec, placeholders, findings } = buildSddcSpec(basePlan({ autoGeneratePasswords: true }));
    expect(spec.vcenterSpec.rootVcenterPassword).toBe('');
    expect(spec.vcenterSpec.adminUserSsoPassword).toBe('');
    expect(spec.nsxtSpec?.rootNsxtManagerPassword).toBe('');
    expect(spec.nsxtSpec?.nsxtAdminPassword).toBe('');
    expect(spec.nsxtSpec?.nsxtAuditPassword).toBe('');
    expect(spec.sddcManagerSpec?.rootPassword).toBe('');
    expect(spec.sddcManagerSpec?.sshPassword).toBe('');
    expect(spec.sddcManagerSpec?.localUserPassword).toBe('');
    expect(spec.vspClusterSpec?.systemUserPassword).toBe('');
    expect(spec.vcfOperationsSpec?.adminUserPassword).toBe('');
    expect(spec.vcfAutomationSpec?.adminUserPassword).toBe('');
    expect(codes(findings)).toContain('vcf.build.auto-generated-passwords');
    // Not documented as auto-generated: these stay required.
    expect(spec.hostSpecs?.[0]?.credentials?.password).toBe(PLACEHOLDER_SECRET);
    expect(spec.vcfOperationsSpec?.nodes[0]?.rootUserPassword).toBe(PLACEHOLDER_SECRET);
    expect(spec.vcfOperationsCollectorSpec?.rootUserPassword).toBe(PLACEHOLDER_SECRET);
    expect(placeholders).not.toContain('vcenterSpec.rootVcenterPassword');
    expect(realErrors(spec)).toEqual([]);
  });

  it('keeps an existing component’s passwords required', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        scenario: 'converge-to-vcf-fleet',
        autoGeneratePasswords: true,
        existing: { vcenter: existingVcenter, nsx: existingNsx },
      }),
    );
    expect(spec.vcenterSpec.rootVcenterPassword).toBe(PLACEHOLDER_SECRET);
    expect(spec.vcenterSpec.adminUserSsoPassword).toBe(PLACEHOLDER_SECRET);
    expect(spec.nsxtSpec?.nsxtAdminPassword).toBe(PLACEHOLDER_SECRET);
    expect(spec.sddcManagerSpec?.rootPassword).toBe('');
  });

  it('still uses a supplied password', () => {
    const { spec } = buildSddcSpec(
      basePlan({ autoGeneratePasswords: true, passwords: { vcenterRoot: 'CorrectHorse!99x' } }),
    );
    expect(spec.vcenterSpec.rootVcenterPassword).toBe('CorrectHorse!99x');
  });
});

describe('sizing presets', () => {
  const opsCount = (spec: SddcSpec): number => spec.vcfOperationsSpec?.nodes.length ?? 0;

  for (const [preset, v] of Object.entries(SIZE_PRESETS) as [SizePreset, (typeof SIZE_PRESETS)[SizePreset]][]) {
    it(`${v.label}: first instance`, () => {
      const { spec } = buildSddcSpec(basePlan({ sizePreset: preset }));
      expect(spec.vspClusterSpec?.size).toBe(v.vspSize);
      expect(spec.vcenterSpec.vmSize).toBe(v.vcenterSize);
      expect(spec.nsxtSpec?.nsxtManagers).toHaveLength(v.nsxManagerCount);
      expect(spec.nsxtSpec?.nsxtManagerSize).toBe(v.nsxManagerSize);
      expect(opsCount(spec)).toBe(v.opsNodeCount);
      expect(spec.vcfOperationsSpec?.applianceSize).toBe(v.opsSize);
      expect(spec.vcfOperationsCollectorSpec?.applianceSize).toBe(v.collectorSize);
      expect(spec.vcfAutomationSpec?.size).toBe(v.automationSize);
      expect(realErrors(spec)).toEqual([]);
    });

    it(`${v.label}: additional instance sizes vCenter from its own column`, () => {
      const { spec } = buildSddcSpec(
        basePlan({ sizePreset: preset, instanceRole: 'secondary', existing: { operations: existingOps } }),
      );
      expect(spec.vcenterSpec.vmSize).toBe(v.vcenterSizeAdditional);
      expect(spec.vcfOperationsCollectorSpec?.applianceSize).toBe(v.collectorSize);
    });
  }

  it('matches the published table', () => {
    expect(SIZE_PRESETS['ha-small'].opsNodeCount).toBe(2);
    expect(SIZE_PRESETS['ha-medium'].collectorSize).toBe('standard');
    expect(SIZE_PRESETS['ha-large'].nsxManagerSize).toBe('large');
    expect(SIZE_PRESETS.simple.nsxManagerCount).toBe(1);
  });

  it('lets an individual size override the preset', () => {
    const { spec } = buildSddcSpec(basePlan({ sizePreset: 'ha-large', vcenterSize: 'xlarge', opsNodeCount: 1 }));
    expect(spec.vcenterSpec.vmSize).toBe('xlarge');
    expect(spec.vcfOperationsSpec?.nodes).toHaveLength(1);
  });

  it('refuses xsmall Operations with more than one node', () => {
    const { findings } = buildSddcSpec(basePlan({ opsSize: 'xsmall', opsNodeCount: 3 }));
    expect(codes(findings)).toContain('vcf.build.ops-xsmall-ha');
  });
});

describe('VCF Operations node count and load balancer', () => {
  it('emits one to three nodes with their roles', () => {
    const two = buildSddcSpec(basePlan({ opsNodeCount: 2 })).spec.vcfOperationsSpec!;
    expect(two.nodes.map((n) => n.type)).toEqual(['master', 'replica']);
  });

  it('emits the load balancer only when chosen', () => {
    expect(buildSddcSpec(basePlan({ profile: 'ha' })).spec.vcfOperationsSpec?.loadBalancerFqdn).toBe('vcf-m01-ops.vcf.lab');
    expect(
      buildSddcSpec(basePlan({ profile: 'ha', opsLoadBalancer: false })).spec.vcfOperationsSpec?.loadBalancerFqdn,
    ).toBeUndefined();
    expect(
      buildSddcSpec(
        basePlan({ opsNodeCount: 3, opsLoadBalancer: true, fqdnOverrides: { opsLoadBalancer: 'ops-lb.vcf.lab' } }),
      ).spec.vcfOperationsSpec?.loadBalancerFqdn,
    ).toBe('ops-lb.vcf.lab');
  });
});

describe('identity broker model and size', () => {
  it('emits the Instance model with a size', () => {
    const { spec } = buildSddcSpec(basePlan({ identityBrokerModel: 'instance', identityBrokerSize: 'medium' }));
    expect(spec.vidbSpec).toEqual({ hostname: 'vcf-m01-idb01.vcf.lab', size: 'medium' });
  });

  it('expresses the Embedded model by leaving vidbSpec out, on a further instance', () => {
    const { spec, findings } = buildSddcSpec(
      basePlan({ instanceRole: 'secondary', identityBrokerModel: 'embedded', existing: { operations: existingOps } }),
    );
    expect(spec.vidbSpec).toBeUndefined();
    expect(codes(findings)).toContain('vcf.build.identity-broker-embedded');
  });
});

describe('VPC type and TEP-less', () => {
  it('VLAN-backed VPC implies NO_IP with no TEP pool and no DTGW', () => {
    const { spec, findings } = buildSddcSpec(
      basePlan({
        vpcNetworkConfigurationType: 'VLAN_BACKED_VPC',
        dtgw: { vlan: 70, gatewayCidr: '172.30.70.1/24', externalIpBlockCidr: '172.30.70.0/26' },
      }),
    );
    expect(spec.nsxtSpec?.overlayVtepSpec?.vtepType).toBe('NO_IP');
    expect(spec.nsxtSpec?.ipAddressPoolSpec).toBeUndefined();
    expect(spec.nsxtSpec?.vpcSpec).toEqual({ vpcNetworkConfigurationType: 'VLAN_BACKED_VPC' });
    expect(codes(findings)).toContain('vcf.build.dtgw-with-vlan-backed-vpc');
  });

  it('TEP-less alone declares the VLAN-backed VPC', () => {
    const { spec } = buildSddcSpec(basePlan({ tepLess: true }));
    expect(spec.nsxtSpec?.vpcSpec?.vpcNetworkConfigurationType).toBe('VLAN_BACKED_VPC');
  });

  it('warns on TEP-less with a full-stack VPC, and below 9.1.1', () => {
    expect(codes(buildSddcSpec(basePlan({ tepLess: true, vpcNetworkConfigurationType: 'FULL_STACK_VPC' })).findings)).toContain(
      'vcf.build.tepless-full-stack-vpc',
    );
    expect(codes(buildSddcSpec(basePlan({ tepLess: true, version: '9.1.0.0' })).findings)).toContain(
      'vcf.build.tepless-before-9-1-1',
    );
  });

  it('keeps a full-stack VPC with TEPs by default', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(spec.nsxtSpec?.overlayVtepSpec).toBeUndefined();
    expect(spec.nsxtSpec?.ipAddressPoolSpec).toBeDefined();
  });

  it('can reuse an existing TEP pool or use DHCP', () => {
    expect(
      buildSddcSpec(basePlan({ tepMode: 'existing-pool', tepPoolName: 'host-tep-pool' })).spec.nsxtSpec?.ipAddressPoolSpec,
    ).toEqual({ name: 'host-tep-pool' });
    expect(buildSddcSpec(basePlan({ tepMode: 'dhcp' })).spec.nsxtSpec?.ipAddressPoolSpec).toBeUndefined();
  });
});

describe('vCenter SSO and storage', () => {
  it('defaults to administrator@vsphere.local, as Broadcom’s samples use', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(spec.vcenterSpec.adminUserSsoUsername).toBe('administrator@vsphere.local');
    expect(spec.vcenterSpec.ssoDomain).toBe('vsphere.local');
    expect(spec.vcenterSpec.storageSize).toBe('lstorage');
  });

  it('follows a custom SSO domain and storage size', () => {
    const { spec } = buildSddcSpec(basePlan({ vcenterSsoDomain: 'corp.sso', vcenterStorageSize: 'xlstorage' }));
    expect(spec.vcenterSpec.ssoDomain).toBe('corp.sso');
    expect(spec.vcenterSpec.adminUserSsoUsername).toBe('administrator@corp.sso');
    expect(spec.vcenterSpec.storageSize).toBe('xlstorage');
    expect(buildSddcSpec(basePlan({ vcenterSsoUsername: 'admin@corp.sso' })).spec.vcenterSpec.adminUserSsoUsername).toBe(
      'admin@corp.sso',
    );
  });
});

describe('switching', () => {
  it('builds a custom multi-switch layout with explicit vmnic mapping', () => {
    const { spec, findings } = buildSddcSpec(
      basePlan({
        dvsProfile: 'custom',
        hostSwitchOperationalMode: 'ENS',
        dvsSwitches: [
          {
            name: 'sfo-m01-cl01-vds01',
            networks: ['MANAGEMENT', 'VMOTION', 'VM_MANAGEMENT'],
            vmnicsToUplinks: [
              { id: 'vmnic0', uplink: 'uplink1' },
              { id: 'vmnic1', uplink: 'uplink2' },
            ],
          },
          { name: 'sfo-m01-cl01-vds02', networks: ['VSAN'], vmnicsToUplinks: ['vmnic2', 'vmnic3'] },
          {
            name: 'sfo-m01-cl01-vds03',
            nsx: true,
            vmnicsToUplinks: [
              { id: 'vmnic5', uplink: 'uplink1' },
              { id: 'vmnic4', uplink: 'uplink2' },
            ],
            nsxTeaming: { policy: 'FAILOVER_ORDER', activeUplinks: ['uplink1'], standByUplinks: ['uplink2'] },
          },
        ],
      }),
    );
    expect(spec.dvsSpecs).toHaveLength(3);
    expect(spec.dvsSpecs?.[0]?.nsxtSwitchConfig).toBeUndefined();
    expect(spec.dvsSpecs?.[1]?.vmnicsToUplinks).toEqual([
      { id: 'vmnic2', uplink: 'uplink1' },
      { id: 'vmnic3', uplink: 'uplink2' },
    ]);
    const nsx = spec.dvsSpecs?.[2];
    expect(nsx?.vmnicsToUplinks[0]).toEqual({ id: 'vmnic5', uplink: 'uplink1' });
    expect(nsx?.nsxtSwitchConfig?.hostSwitchOperationalMode).toBe('ENS');
    expect(nsx?.nsxTeamings).toEqual([
      { policy: 'FAILOVER_ORDER', activeUplinks: ['uplink1'], standByUplinks: ['uplink2'] },
    ]);
    expect(codes(findings)).not.toContain('vcf.build.custom-dvs-missing');
    expect(realErrors(spec)).toEqual([]);
  });

  it('does not fall back to the default switch for an empty custom profile', () => {
    const { spec, findings } = buildSddcSpec(basePlan({ dvsProfile: 'custom' }));
    expect(codes(findings)).toContain('vcf.build.custom-dvs-missing');
    expect(spec.dvsSpecs).toEqual([]);
  });

  it('rejects a vmnic mapped to two switches', () => {
    const { findings } = buildSddcSpec(
      basePlan({
        dvsSwitches: [
          { nsx: true, vmnicsToUplinks: ['vmnic0', 'vmnic1'] },
          { vmnicsToUplinks: ['vmnic1', 'vmnic2'] },
        ],
      }),
    );
    expect(codes(findings)).toContain('vcf.build.custom-dvs-shared-vmnic');
  });

  it('applies the NSX teaming policy and host switch mode to a predefined profile', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        hostSwitchOperationalMode: 'STANDARD',
        nsxTeaming: { policy: 'LOADBALANCE_SRC_MAC', standByUplinks: ['uplink2'] },
      }),
    );
    const dvs = spec.dvsSpecs?.[0];
    expect(dvs?.nsxtSwitchConfig?.hostSwitchOperationalMode).toBe('STANDARD');
    expect(dvs?.nsxTeamings).toEqual([
      { policy: 'LOADBALANCE_SRC_MAC', activeUplinks: ['uplink1'], standByUplinks: ['uplink2'] },
    ]);
  });

  it('keeps the earlier teaming and omits the host switch mode by default', () => {
    const dvs = buildSddcSpec(basePlan()).spec.dvsSpecs?.[0];
    expect(dvs?.nsxTeamings).toEqual([
      { policy: 'LOADBALANCE_SRCID', activeUplinks: ['uplink1', 'uplink2'], standByUplinks: null },
    ]);
    expect(dvs?.nsxtSwitchConfig?.hostSwitchOperationalMode).toBeUndefined();
  });

  it('fills LACP defaults and honours every parameter', () => {
    const defaults = buildSddcSpec(basePlan({ lacp: {} })).spec.dvsSpecs?.[0]?.lagSpecs?.[0];
    expect(defaults).toEqual({
      name: 'vcf-m01-lag01',
      uplinksCount: 2,
      lacpMode: 'ACTIVE',
      lacpTimeoutMode: 'FAST',
      loadBalancingMode: 'SOURCE_AND_DESTINATION_IP',
    });
    const chosen = buildSddcSpec(
      basePlan({
        lacp: { name: 'lag-a', uplinksCount: 4, lacpMode: 'PASSIVE', lacpTimeoutMode: 'SLOW', loadBalancingMode: 'SOURCE_PORT_ID' },
      }),
    ).spec.dvsSpecs?.[0]?.lagSpecs?.[0];
    expect(chosen).toEqual({
      name: 'lag-a',
      uplinksCount: 4,
      lacpMode: 'PASSIVE',
      lacpTimeoutMode: 'SLOW',
      loadBalancingMode: 'SOURCE_PORT_ID',
    });
  });
});

describe('NSX brownfield flags', () => {
  it('emits skipNsxOverlayOverManagementNetwork only when set', () => {
    expect(buildSddcSpec(basePlan()).spec.nsxtSpec?.skipNsxOverlayOverManagementNetwork).toBeUndefined();
    expect(
      buildSddcSpec(basePlan({ skipNsxOverlayOverManagementNetwork: true })).spec.nsxtSpec
        ?.skipNsxOverlayOverManagementNetwork,
    ).toBe(true);
  });

  it('makes Edge cluster sync a choice, and warns that it resets Edge passwords', () => {
    const on = buildSddcSpec(
      basePlan({ scenario: 'converge-to-vcf-fleet', existing: { vcenter: existingVcenter, nsx: existingNsx } }),
    );
    expect(on.spec.nsxtSpec?.enableEdgeClusterSync).toBe(true);
    expect(codes(on.findings)).toContain('vcf.build.edge-cluster-sync');
    const off = buildSddcSpec(
      basePlan({
        scenario: 'converge-to-vcf-fleet',
        enableEdgeClusterSync: false,
        existing: { vcenter: existingVcenter, nsx: existingNsx },
      }),
    );
    expect(off.spec.nsxtSpec?.enableEdgeClusterSync).toBe(false);
    expect(codes(off.findings)).not.toContain('vcf.build.edge-cluster-sync');
  });
});

describe('per-network settings', () => {
  it('applies teaming, uplinks, MTU, port group name and explicit ranges', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        vmotion: {
          cidr: '172.30.40.0/24',
          vlanId: 40,
          mtu: 8900,
          teamingPolicy: 'failover_explicit',
          activeUplinks: ['uplink2'],
          standbyUplinks: ['uplink1'],
          portGroupName: 'sfo-m01-cl01-vds01-pg-vmotion',
          ipRanges: [{ startIpAddress: '172.30.40.101', endIpAddress: '172.30.40.116' }],
        },
      }),
    );
    const vmotion = spec.networkSpecs!.find((n) => n.networkType === 'VMOTION');
    expect(vmotion?.mtu).toBe(8900);
    expect(vmotion?.teamingPolicy).toBe('failover_explicit');
    expect(vmotion?.activeUplinks).toEqual(['uplink2']);
    expect(vmotion?.standbyUplinks).toEqual(['uplink1']);
    expect(vmotion?.portGroupKey).toBe('sfo-m01-cl01-vds01-pg-vmotion');
    expect(vmotion?.includeIpAddressRanges).toEqual([{ startIpAddress: '172.30.40.101', endIpAddress: '172.30.40.116' }]);
  });

  it('does not give the VM management network the management port group name', () => {
    const { spec } = buildSddcSpec(
      basePlan({ management: { cidr: '172.30.0.0/24', vlanId: 30, portGroupName: 'esx-mgmt-pg' } }),
    );
    const mgmt = spec.networkSpecs!.find((n) => n.networkType === 'MANAGEMENT');
    const vm = spec.networkSpecs!.find((n) => n.networkType === 'VM_MANAGEMENT');
    expect(mgmt?.portGroupKey).toBe('esx-mgmt-pg');
    expect(vm?.portGroupKey).toBe('vcf-m01-pg-vm-mgmt');
  });
});

describe('root CA certificates and other options', () => {
  it('emits root CA certificates, with or without a certificate mode', () => {
    const cert = { alias: 'corp-root', certChain: ['MIIB...'] };
    expect(buildSddcSpec(basePlan({ rootCaCerts: [cert] })).spec.securitySpec).toEqual({ rootCaCerts: [cert] });
    expect(buildSddcSpec(basePlan({ esxiCertsMode: 'Custom', rootCaCerts: [cert] })).spec.securitySpec).toEqual({
      esxiCertsMode: 'Custom',
      rootCaCerts: [cert],
    });
  });

  it('pins component versions and service sizes on request only', () => {
    const plain = buildSddcSpec(basePlan()).spec;
    expect(plain.vcenterSpec.version).toBeUndefined();
    expect(plain.fleetDepotSpec).toEqual({});
    const pinned = buildSddcSpec(
      basePlan({
        componentVersions: { vcenter: '9.1.1.0', operations: '9.1.1.0' },
        serviceSizes: { fleetDepot: 'small' },
        vspName: 'mgmt-vmsp',
      }),
    ).spec;
    expect(pinned.vcenterSpec.version).toBe('9.1.1.0');
    expect(pinned.vcfOperationsSpec?.version).toBe('9.1.1.0');
    expect(pinned.fleetDepotSpec).toEqual({ size: 'small' });
    expect(pinned.vspClusterSpec?.name).toBe('mgmt-vmsp');
  });

  it('can leave out the fleet service blocks Broadcom’s samples omit', () => {
    const { spec } = buildSddcSpec(basePlan({ includeFleetServiceSpecs: false }));
    expect(spec.fleetDepotSpec).toBeUndefined();
    expect(spec.telemetryAcceptorSpec).toBeUndefined();
    expect(spec.saltSpec).toBeUndefined();
    expect(spec.saltRaasSpec).toBeUndefined();
  });

  it('makes gateway ping validation a choice', () => {
    expect(buildSddcSpec(basePlan()).spec.skipGatewayPingValidation).toBe(false);
    expect(buildSddcSpec(basePlan({ skipGatewayPingValidation: true })).spec.skipGatewayPingValidation).toBe(true);
  });
});

describe('scenario table notes', () => {
  it('records the deferred row’s Automation cell as superseded', () => {
    const rule = scenarioRule('deferred-components');
    expect(rule.supersedesTable?.map((s) => s.column)).toContain('vcfAutomationSpec.useExistingDeployment');
  });

  it('marks the * footnote cells as conditional', () => {
    expect(scenarioRule('converge-to-vcf-fleet').conditionalPresence).toEqual(['licenseServer', 'identityBroker']);
    expect(scenarioRule('converge-to-vcf-instance').conditionalPresence).toEqual(['licenseServer', 'identityBroker']);
    expect(scenarioRule('converge-to-vvf').conditionalPresence).toEqual(['licenseServer']);
    expect(scenarioRule('new-vcf-fleet').conditionalPresence).toBeUndefined();
  });
});
