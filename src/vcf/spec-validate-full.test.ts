/**
 * The validator against the whole published 9.1 / 9.1.1 SddcSpec: every enum,
 * thumbprints on every existing component, unknown keys, required fields,
 * FQDN rules, IPv6 formats, and the per-workflowType shape of Broadcom's
 * decision table. Also holds the editor's CHOICES to real schema paths.
 *
 * The specs here are written by hand rather than built, so these tests pin the
 * validator and nothing else.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import type { Finding } from '../core/findings.ts';
import { validateSddcSpec, schemaPaths, SDDC_SCHEMA } from './spec-validate.ts';
import { CHOICES, labelFor } from './spec-edit.ts';
import { SDDC_SPEC_TOP_LEVEL_KEYS } from './spec-types.ts';

type Doc = Record<string, any>;

const TP = Array.from({ length: 32 }, () => 'AB').join(':');
const TP_SHA1 = Array.from({ length: 20 }, () => 'AB').join(':');

/** A complete, valid new-fleet (workflowType VCF) specification. */
function fleet(): Doc {
  return {
    sddcId: 'vcf-m01',
    version: '9.1.1.0',
    vcfInstanceName: 'vcf-m01',
    workflowType: 'VCF',
    ceipEnabled: false,
    skipEsxThumbprintValidation: true,
    dnsSpec: { subdomain: 'vcf.lab', nameservers: ['192.168.30.29', '192.168.30.30'] },
    ntpServers: ['192.168.30.1', 'ntp.vcf.lab'],
    hostSpecs: ['esx01', 'esx02', 'esx03', 'esx04'].map((hostname) => ({
      hostname,
      credentials: { username: 'root', password: 'VMware1!VMware1!' },
    })),
    networkSpecs: [
      { networkType: 'MANAGEMENT', vlanId: 30, subnet: '172.30.0.0/24', gateway: '172.30.0.1', ipAddressVersion: 'IPv4', ipAddressAssignmentMode: 'STATIC', teamingPolicy: 'loadbalance_loadbased', activeUplinks: ['uplink1', 'uplink2'] },
      { networkType: 'VM_MANAGEMENT', vlanId: 30, subnet: '172.30.0.0/24', gateway: '172.30.0.1' },
      { networkType: 'VMOTION', vlanId: 40, subnet: '172.30.40.0/24', gateway: '172.30.40.1', mtu: 9000, includeIpAddressRanges: [{ startIpAddress: '172.30.40.10', endIpAddress: '172.30.40.13' }] },
      { networkType: 'VSAN', vlanId: 50, subnet: '172.30.50.0/24', gateway: '172.30.50.1', mtu: 9000, includeIpAddressRanges: [{ startIpAddress: '172.30.50.10', endIpAddress: '172.30.50.13' }] },
    ],
    clusterSpec: { datacenterName: 'dc01', clusterName: 'cl01', clusterEvcMode: 'INTEL_ICELAKE' },
    vcenterSpec: { vcenterHostname: 'vc01.vcf.lab', rootVcenterPassword: 'VMware1!VMware1!', vmSize: 'small', storageSize: 'lstorage', ssoDomain: 'vsphere.local' },
    nsxtSpec: {
      nsxtManagers: [{ hostname: 'nsx01a.vcf.lab' }],
      vipFqdn: 'nsx01.vcf.lab',
      nsxtManagerSize: 'medium',
      transportVlanId: 60,
      ipAddressPoolSpec: {
        name: 'tep01',
        subnets: [{ cidr: '172.30.60.0/24', gateway: '172.30.60.1', ipAddressPoolRanges: [{ start: '172.30.60.10', end: '172.30.60.20' }] }],
      },
    },
    datastoreSpec: { vsanSpec: { datastoreName: 'vsan01', failuresToTolerate: 1, esaConfig: { enabled: true } } },
    dvsSpecs: [
      {
        dvsName: 'vds01',
        networks: ['MANAGEMENT', 'VM_MANAGEMENT', 'VMOTION', 'VSAN'],
        mtu: 9000,
        nsxtSwitchConfig: { transportZones: [{ name: 'overlay', transportType: 'OVERLAY' }] },
        vmnicsToUplinks: [{ id: 'vmnic0', uplink: 'uplink1' }, { id: 'vmnic1', uplink: 'uplink2' }],
        nsxTeamings: [{ policy: 'LOADBALANCE_SRCID', activeUplinks: ['uplink1', 'uplink2'] }],
      },
    ],
    sddcManagerSpec: { hostname: 'sddcm01.vcf.lab' },
    vspClusterSpec: {
      platformFqdn: 'msr01.vcf.lab',
      instanceFqdn: 'int01.vcf.lab',
      fleetFqdn: 'flt01.vcf.lab',
      ipv4Pool: { ipRange: { startIpAddress: '172.30.0.32', endIpAddress: '172.30.0.61' } },
      size: 'small',
      internalClusterCidrIpv4: '198.18.0.0/15',
    },
    vidbSpec: { hostname: 'idb01.vcf.lab', size: 'small' },
    licenseServerSpec: { hostname: 'lic01.vcf.lab' },
    vcfOperationsSpec: { nodes: [{ hostname: 'ops01.vcf.lab', type: 'master' }], applianceSize: 'small' },
    vcfOperationsCollectorSpec: { hostname: 'proxy01.vcf.lab', applianceSize: 'small' },
    vcfAutomationSpec: {
      hostname: 'auto01.vcf.lab',
      platformFqdn: 'asr01.vcf.lab',
      internalClusterCidr: '198.18.0.0/15',
      nodePrefix: 'vcf-auto',
      ipPool: ['172.30.0.62', '172.30.0.63', '172.30.0.64', '172.30.0.65', '172.30.0.66'],
      size: 'small',
    },
  };
}

/** A secondary instance joining the fleet (VCF_EXTEND). */
function extend(): Doc {
  const doc = fleet();
  doc.workflowType = 'VCF_EXTEND';
  delete doc.vspClusterSpec.fleetFqdn;
  delete doc.vidbSpec;
  delete doc.licenseServerSpec;
  doc.vcfOperationsSpec = { nodes: [{ hostname: 'ops01.vcf.lab', type: 'master', sslThumbprint: TP }], useExistingDeployment: true };
  doc.vcfAutomationSpec = { hostname: 'auto01.vcf.lab', internalClusterCidr: '198.18.0.0/15', useExistingDeployment: true, sslThumbprint: TP };
  return doc;
}

/** Deferred components (VCF_COMPLETE), shaped like Broadcom's worked example. */
function deferred(): Doc {
  const f = fleet();
  return {
    sddcId: 'vcf-m01',
    workflowType: 'VCF_COMPLETE',
    vcfInstanceName: 'vcf-m01',
    version: '9.1.1.0',
    ceipEnabled: false,
    vcenterSpec: { vcenterHostname: 'vc01.vcf.lab', adminUserSsoUsername: 'administrator@vsphere.local', adminUserSsoPassword: 'VMware1!VMware1!', useExistingDeployment: true, sslThumbprint: TP },
    sddcManagerSpec: { hostname: 'sddcm01.vcf.lab', useExistingDeployment: true, sslThumbprint: TP },
    vcfOperationsSpec: f.vcfOperationsSpec,
    vcfOperationsCollectorSpec: f.vcfOperationsCollectorSpec,
    licenseServerSpec: f.licenseServerSpec,
    vcfAutomationSpec: f.vcfAutomationSpec,
    vcfManagementComponentsInfrastructureSpec: {
      xRegionNetwork: { networkName: 'vcf-mgmt-pg', subnetMask: '255.255.255.0', gateway: '172.30.10.1' },
    },
  };
}

/** A new vSphere Foundation platform (VVF). */
function vvf(): Doc {
  const doc = fleet();
  doc.workflowType = 'VVF';
  delete doc.nsxtSpec;
  delete doc.vcfAutomationSpec;
  doc.dvsSpecs[0].nsxtSwitchConfig = undefined;
  delete doc.dvsSpecs[0].nsxtSwitchConfig;
  delete doc.dvsSpecs[0].nsxTeamings;
  return doc;
}

/** VCF management services and License Server for an existing VVF. */
function vvfManagementServices(): Doc {
  const f = fleet();
  return {
    sddcId: 'vvf-m01',
    workflowType: 'VVF',
    version: '9.1.1.0',
    vcenterSpec: { vcenterHostname: 'vc01.vcf.lab', useExistingDeployment: true, sslThumbprint: TP },
    sddcManagerSpec: { hostname: 'sddcm01.vcf.lab', useExistingDeployment: true, sslThumbprint: TP },
    vcfOperationsSpec: { nodes: [{ hostname: 'ops01.vcf.lab', type: 'master', sslThumbprint: TP }], useExistingDeployment: true },
    vspClusterSpec: f.vspClusterSpec,
    licenseServerSpec: f.licenseServerSpec,
  };
}

const codes = (findings: readonly Finding[]): string[] => findings.map((f) => f.code);
const errorsOf = (findings: readonly Finding[]): Finding[] => findings.filter((f) => f.severity === 'error');
const find = (findings: readonly Finding[], code: string, path?: string): Finding | undefined =>
  findings.find((f) => f.code === code && (path === undefined || f.path === path));
const run = (doc: Doc): Finding[] => validateSddcSpec(doc);

function expectClean(doc: Doc, allowWarnings = false): void {
  const findings = run(doc);
  const bad = findings.filter((f) => f.severity === 'error' || (!allowWarnings && f.severity === 'warning'));
  if (bad.length > 0) {
    throw new Error(`Expected a clean spec:\n${bad.map((f) => `  ${f.severity} ${f.code} @ ${f.path ?? '-'}: ${f.message}`).join('\n')}`);
  }
}

describe('full schema: valid specifications stay clean', () => {
  it('accepts a complete new fleet with no errors or warnings', () => expectClean(fleet()));
  it('accepts a secondary instance', () => expectClean(extend()));
  it('accepts a deferred-components document without networks or DNS', () => {
    expectClean(deferred());
    expect(codes(run(deferred()))).toContain('vcf.spec.required-omitted-by-example');
  });
  it('accepts a new VVF platform', () => expectClean(vvf()));
  it('accepts VCF management services for VVF without networks or DNS', () => expectClean(vvfManagementServices()));
});

describe('full schema: enumerations', () => {
  const cases: [path: string, set: (d: Doc) => void][] = [
    ['workflowType', (d) => (d.workflowType = 'vcf')],
    ['vcenterSpec.vmSize', (d) => (d.vcenterSpec.vmSize = 'huge')],
    ['vcenterSpec.storageSize', (d) => (d.vcenterSpec.storageSize = 'large')],
    ['networkSpecs[0].teamingPolicy', (d) => (d.networkSpecs![0].teamingPolicy = 'LOADBALANCE_LOADBASED')],
    ['networkSpecs[0].ipAddressVersion', (d) => (d.networkSpecs![0].ipAddressVersion = 'ipv4')],
    ['networkSpecs[0].ipAddressAssignmentMode', (d) => (d.networkSpecs![0].ipAddressAssignmentMode = 'MANUAL')],
    ['clusterSpec.clusterEvcMode', (d) => (d.clusterSpec.clusterEvcMode = 'INTEL_NEHALEM')],
    ['clusterSpec.resourcePoolSpecs[0].type', (d) => (d.clusterSpec.resourcePoolSpecs = [{ name: 'rp', type: 'workload' }])],
    ['dvsSpecs[0].nsxTeamings[0].policy', (d) => (d.dvsSpecs[0].nsxTeamings[0].policy = 'loadbalance_srcid')],
    ['dvsSpecs[0].nsxtSwitchConfig.transportZones[0].transportType', (d) => (d.dvsSpecs[0].nsxtSwitchConfig.transportZones[0].transportType = 'GENEVE')],
    ['dvsSpecs[0].nsxtSwitchConfig.hostSwitchOperationalMode', (d) => (d.dvsSpecs[0].nsxtSwitchConfig.hostSwitchOperationalMode = 'EDP')],
    ['dvsSpecs[0].lagSpecs[0].lacpMode', (d) => (d.dvsSpecs[0].lagSpecs = [{ name: 'lag1', uplinksCount: 2, lacpMode: 'ON', lacpTimeoutMode: 'FAST', loadBalancingMode: 'SOURCE_AND_DESTINATION_IP' }])],
    ['dvsSpecs[0].lagSpecs[0].lacpTimeoutMode', (d) => (d.dvsSpecs[0].lagSpecs = [{ name: 'lag1', uplinksCount: 2, lacpMode: 'ACTIVE', lacpTimeoutMode: 'QUICK', loadBalancingMode: 'SOURCE_AND_DESTINATION_IP' }])],
    ['dvsSpecs[0].lagSpecs[0].loadBalancingMode', (d) => (d.dvsSpecs[0].lagSpecs = [{ name: 'lag1', uplinksCount: 2, lacpMode: 'ACTIVE', lacpTimeoutMode: 'FAST', loadBalancingMode: 'SRC_DST_IP' }])],
    ['nsxtSpec.vpcSpec.vpcNetworkConfigurationType', (d) => (d.nsxtSpec.vpcSpec = { vpcNetworkConfigurationType: 'CENTRALIZED' })],
    ['nsxtSpec.overlayVtepSpec.vtepType', (d) => (d.nsxtSpec.overlayVtepSpec = { vtepType: 'DHCP' })],
    ['securitySpec.esxiCertsMode', (d) => (d.securitySpec = { esxiCertsMode: 'vmca' })],
    ['vcfOperationsSpec.applianceSize', (d) => (d.vcfOperationsSpec.applianceSize = 'standard')],
    ['vcfOperationsSpec.nodes[0].type', (d) => (d.vcfOperationsSpec.nodes[0].type = 'primary')],
    ['vcfOperationsCollectorSpec.applianceSize', (d) => (d.vcfOperationsCollectorSpec.applianceSize = 'medium')],
    ['vspClusterSpec.size', (d) => (d.vspClusterSpec.size = 'xlarge')],
  ];
  for (const [path, set] of cases) {
    it(`rejects a value outside the enum at ${path}`, () => {
      const doc = fleet();
      set(doc);
      expect(find(run(doc), 'vcf.spec.invalid-enum', path)?.severity).toBe('error');
    });
  }

  it('suggests the right case for a case-only mismatch', () => {
    const doc = fleet();
    doc.networkSpecs![0].teamingPolicy = 'LOADBALANCE_LOADBASED';
    expect(find(run(doc), 'vcf.spec.invalid-enum')?.remediation).toContain('"loadbalance_loadbased"');
  });

  it('accepts a custom network type but flags a known one in the wrong case', () => {
    const custom = fleet();
    custom.networkSpecs!.push({ networkType: 'BACKUP', vlanId: 70, subnet: '172.30.70.0/24', gateway: '172.30.70.1' });
    expect(codes(run(custom))).not.toContain('vcf.spec.invalid-enum');
    expect(codes(run(custom))).not.toContain('vcf.spec.enum-case');
    const wrongCase = fleet();
    wrongCase.dvsSpecs[0].networks[3] = 'vsan';
    expect(find(run(wrongCase), 'vcf.spec.enum-case', 'dvsSpecs[0].networks[3]')?.severity).toBe('warning');
  });

  it('warns rather than errs on the sizes the API publishes no enum for', () => {
    const doc = fleet();
    doc.vidbSpec.size = 'tiny';
    doc.vcfAutomationSpec.size = 'huge';
    const found = run(doc);
    expect(find(found, 'vcf.spec.undocumented-value', 'vidbSpec.size')?.severity).toBe('warning');
    expect(find(found, 'vcf.spec.undocumented-value', 'vcfAutomationSpec.size')?.severity).toBe('warning');
  });

  it('keeps the existing NSX size and internal CIDR codes without doubling them', () => {
    const doc = fleet();
    doc.nsxtSpec.nsxtManagerSize = 'small';
    doc.vspClusterSpec.internalClusterCidrIpv4 = '10.0.0.0/15';
    const found = run(doc);
    expect(codes(found)).toContain('vcf.spec.nsx-size-not-supported');
    expect(codes(found)).toContain('vcf.spec.invalid-internal-cidr');
    expect(codes(found)).not.toContain('vcf.spec.invalid-enum');
  });
});

describe('full schema: thumbprints', () => {
  const existing: [key: string, set: (d: Doc) => void, path: string][] = [
    ['nsxtSpec', (d) => (d.nsxtSpec.useExistingDeployment = true), 'nsxtSpec.sslThumbprint'],
    ['vcfOperationsSpec', (d) => (d.vcfOperationsSpec.useExistingDeployment = true), 'vcfOperationsSpec.nodes[0].sslThumbprint'],
    ['vcfOperationsCollectorSpec', (d) => (d.vcfOperationsCollectorSpec.useExistingDeployment = true), 'vcfOperationsCollectorSpec.sslThumbprint'],
    ['vcfAutomationSpec', (d) => (d.vcfAutomationSpec.useExistingDeployment = true), 'vcfAutomationSpec.sslThumbprint'],
    ['licenseServerSpec', (d) => (d.licenseServerSpec.useExistingDeployment = true), 'licenseServerSpec.sslThumbprint'],
    ['vspClusterSpec', (d) => (d.vspClusterSpec.useExistingDeployment = true), 'vspClusterSpec.sslThumbprint'],
  ];
  for (const [key, set, path] of existing) {
    it(`warns when an existing ${key} has no thumbprint`, () => {
      const doc = fleet();
      set(doc);
      expect(find(run(doc), 'vcf.spec.existing-without-thumbprint', path)?.severity).toBe('warning');
    });
  }

  it('keeps the vCenter error code for a missing thumbprint', () => {
    const doc = fleet();
    doc.vcenterSpec.useExistingDeployment = true;
    expect(find(run(doc), 'vcf.spec.missing-thumbprint')?.severity).toBe('error');
  });

  it('does not ask for an SDDC Manager thumbprint, as specs that deployed carry none', () => {
    const doc = fleet();
    doc.sddcManagerSpec.useExistingDeployment = true;
    expect(codes(run(doc))).not.toContain('vcf.spec.existing-without-thumbprint');
  });

  const components = ['vcenterSpec', 'nsxtSpec', 'sddcManagerSpec', 'vcfOperationsCollectorSpec', 'vcfAutomationSpec', 'licenseServerSpec', 'vspClusterSpec'];
  for (const key of components) {
    it(`checks the thumbprint format on ${key}`, () => {
      const good = fleet();
      good[key].sslThumbprint = TP.toLowerCase();
      expect(codes(run(good)).filter((c) => c.startsWith('vcf.spec.thumbprint'))).toEqual([]);
      const sha1 = fleet();
      sha1[key].sslThumbprint = TP_SHA1;
      expect(find(run(sha1), 'vcf.spec.thumbprint-sha1', `${key}.sslThumbprint`)?.severity).toBe('error');
      const bare = fleet();
      bare[key].sslThumbprint = 'ab'.repeat(32);
      const bareFinding = find(run(bare), 'vcf.spec.thumbprint-format', `${key}.sslThumbprint`);
      expect(bareFinding?.severity).toBe('warning');
      expect(bareFinding?.remediation).toContain(TP);
      const junk = fleet();
      junk[key].sslThumbprint = 'AA:BB';
      expect(find(run(junk), 'vcf.spec.thumbprint-format', `${key}.sslThumbprint`)?.severity).toBe('error');
    });
  }

  it('checks the Operations node and host thumbprints', () => {
    const doc = fleet();
    doc.vcfOperationsSpec.nodes[0].sslThumbprint = TP_SHA1;
    doc.hostSpecs[0].sslThumbprint = 'nope';
    doc.hostSpecs[1].sshThumbprint = 'SHA256:' + 'A'.repeat(43);
    doc.hostSpecs[2].sshThumbprint = 'md5:aa:bb';
    const found = run(doc);
    expect(find(found, 'vcf.spec.thumbprint-sha1', 'vcfOperationsSpec.nodes[0].sslThumbprint')).toBeDefined();
    expect(find(found, 'vcf.spec.thumbprint-format', 'hostSpecs[0].sslThumbprint')?.severity).toBe('error');
    expect(find(found, 'vcf.spec.thumbprint-format', 'hostSpecs[1].sshThumbprint')).toBeUndefined();
    expect(find(found, 'vcf.spec.thumbprint-format', 'hostSpecs[2].sshThumbprint')?.severity).toBe('warning');
  });

  it('reports a placeholder thumbprint as unfilled, not malformed', () => {
    const doc = fleet();
    doc.nsxtSpec.useExistingDeployment = true;
    doc.nsxtSpec.sslThumbprint = '<REQUIRED>';
    const found = run(doc);
    expect(find(found, 'vcf.spec.placeholder-credential', 'nsxtSpec.sslThumbprint')).toBeDefined();
    expect(find(found, 'vcf.spec.thumbprint-format')).toBeUndefined();
  });
});

describe('full schema: unknown keys', () => {
  it('warns on an unknown top-level key with a did-you-mean', () => {
    const doc = fleet();
    doc.vcenterSepc = {};
    const f = find(run(doc), 'vcf.spec.unknown-key', 'vcenterSepc');
    expect(f?.severity).toBe('warning');
    expect(f?.remediation).toContain('vcenterSpec');
  });

  it('finds unknown keys deep in the tree', () => {
    const doc = fleet();
    doc.networkSpecs![0].assignmentMode = 'STATIC';
    doc.dvsSpecs[0].nsxTeamings[0].standbyUplinks = [];
    doc.vspClusterSpec.ipv4Pool.ipRange.start = '172.30.0.32';
    const found = run(doc);
    expect(find(found, 'vcf.spec.unknown-key', 'networkSpecs[0].assignmentMode')?.remediation).toContain('ipAddressAssignmentMode');
    expect(find(found, 'vcf.spec.unknown-key', 'dvsSpecs[0].nsxTeamings[0].standbyUplinks')?.remediation).toContain('standByUplinks');
    expect(find(found, 'vcf.spec.unknown-key', 'vspClusterSpec.ipv4Pool.ipRange.start')).toBeDefined();
  });

  it('does not double-report keys that have their own finding', () => {
    const doc = fleet();
    doc.vcfOperationsFleetManagementSpec = {};
    doc.licenseKey = 'X';
    const found = run(doc);
    expect(codes(found)).toContain('vcf.spec.removed-9.0-field');
    expect(codes(found)).toContain('vcf.spec.license-key-in-spec');
    expect(codes(found)).not.toContain('vcf.spec.unknown-key');
  });

  it('accepts the undocumented keys that specs which deployed carry', () => {
    const doc = fleet();
    doc.vspClusterSpec.name = 'vmsp-01';
    doc.fleetLcmSpec = { hostname: 'flt01.vcf.lab' };
    expect(codes(run(doc))).not.toContain('vcf.spec.unknown-key');
  });
});

describe('full schema: required fields and types', () => {
  it('still reports exactly the four top-level required keys on an empty document', () => {
    expect(run({}).filter((f) => f.code === 'vcf.spec.missing-required')).toHaveLength(4);
  });

  it('reports a missing required nested field with its path', () => {
    const doc = fleet();
    delete doc.nsxtSpec.vipFqdn;
    doc.dvsSpecs[0].lagSpecs = [{ name: 'lag1', uplinksCount: 2, lacpTimeoutMode: 'FAST', loadBalancingMode: 'VLAN' }];
    delete doc.vspClusterSpec.ipv4Pool;
    delete doc.hostSpecs[0].credentials.password;
    const found = run(doc);
    for (const path of ['nsxtSpec.vipFqdn', 'dvsSpecs[0].lagSpecs[0].lacpMode', 'vspClusterSpec.ipv4Pool', 'hostSpecs[0].credentials.password']) {
      expect(find(found, 'vcf.spec.missing-required', path)?.severity).toBe('error');
    }
  });

  it('requires Automation platformFqdn only for a new deployment', () => {
    const fresh = fleet();
    delete fresh.vcfAutomationSpec.platformFqdn;
    expect(find(run(fresh), 'vcf.spec.missing-required', 'vcfAutomationSpec.platformFqdn')).toBeDefined();
    const reused = fleet();
    reused.vcfAutomationSpec = { hostname: 'auto01.vcf.lab', internalClusterCidr: '198.18.0.0/15', useExistingDeployment: true, sslThumbprint: TP };
    expect(find(run(reused), 'vcf.spec.missing-required', 'vcfAutomationSpec.platformFqdn')).toBeUndefined();
  });

  it('rejects a list where an object belongs, and the reverse', () => {
    const doc = fleet();
    doc.vcenterSpec = [];
    doc.hostSpecs = { hostname: 'esx01' };
    const found = run(doc);
    expect(find(found, 'vcf.spec.wrong-type', 'vcenterSpec')).toBeDefined();
    expect(find(found, 'vcf.spec.wrong-type', 'hostSpecs')).toBeDefined();
  });

  it('checks vcfInstanceName length', () => {
    const doc = fleet();
    doc.vcfInstanceName = 'x'.repeat(301);
    expect(codes(run(doc))).toContain('vcf.spec.instance-name-length');
  });
});

describe('full schema: FQDN rules', () => {
  it('refuses upper case in management services, identity broker and Automation FQDNs', () => {
    const doc = fleet();
    doc.vspClusterSpec.platformFqdn = 'MSR01.vcf.lab';
    doc.vidbSpec.hostname = 'IDB01.vcf.lab';
    doc.vcfAutomationSpec.platformFqdn = 'Asr01.vcf.lab';
    const found = run(doc).filter((f) => f.code === 'vcf.spec.fqdn-not-lowercase');
    expect(found.map((f) => f.severity)).toEqual(['error', 'error', 'error']);
  });

  it('only warns on upper case elsewhere', () => {
    const doc = fleet();
    doc.vcenterSpec.vcenterHostname = 'VC01.vcf.lab';
    expect(find(run(doc), 'vcf.spec.fqdn-not-lowercase', 'vcenterSpec.vcenterHostname')?.severity).toBe('warning');
  });

  it('refuses .local for the strict components', () => {
    const doc = fleet();
    doc.vcfAutomationSpec.hostname = 'auto01.corp.local';
    expect(find(run(doc), 'vcf.spec.fqdn-local-suffix', 'vcfAutomationSpec.hostname')?.severity).toBe('error');
  });

  it('refuses the same FQDN on two components', () => {
    const doc = fleet();
    doc.licenseServerSpec.hostname = 'ops01.vcf.lab';
    expect(find(run(doc), 'vcf.spec.duplicate-fqdn', 'licenseServerSpec.hostname')?.severity).toBe('error');
  });

  it('refuses an IP address and a malformed name', () => {
    const doc = fleet();
    doc.vcfOperationsCollectorSpec.hostname = '172.30.0.20';
    doc.vidbSpec.hostname = 'idb_01.vcf.lab';
    const found = run(doc);
    expect(find(found, 'vcf.spec.fqdn-is-ip', 'vcfOperationsCollectorSpec.hostname')).toBeDefined();
    expect(find(found, 'vcf.spec.invalid-fqdn', 'vidbSpec.hostname')).toBeDefined();
  });
});

describe('full schema: VCF Automation IP count', () => {
  const pool = (n: number): string[] => Array.from({ length: n }, (_, i) => `172.30.0.${62 + i}`);
  for (const version of ['9.1.0.0', '9.1.0.400', '9.1.1.0']) {
    it(`accepts 5 addresses on ${version}`, () => {
      const doc = fleet();
      doc.version = version;
      doc.vcfAutomationSpec.ipPool = pool(5);
      expect(codes(run(doc))).not.toContain('vcf.spec.automation-pool-too-small');
    });
  }
  for (const version of ['9.1.0.400', '9.1.1.0']) {
    it(`accepts 6 addresses on ${version}`, () => {
      const doc = fleet();
      doc.version = version;
      doc.vcfAutomationSpec.ipPool = pool(6);
      expect(codes(run(doc))).not.toContain('vcf.spec.automation-pool-too-small');
    });
  }
  it('rejects 4, and names both counts from 9.1.0.400', () => {
    const doc = fleet();
    doc.version = '9.1.0.400';
    doc.vcfAutomationSpec.ipPool = pool(4);
    expect(find(run(doc), 'vcf.spec.automation-pool-too-small')?.message).toContain('5 or 6');
  });
});

describe('full schema: address formats', () => {
  it('checks NTP servers, including IPv6', () => {
    const doc = fleet();
    doc.ntpServers = ['2001:db8::123', '2001:db8:::1', '10.0.0.300'];
    const found = run(doc);
    expect(find(found, 'vcf.spec.invalid-ntp-server', 'ntpServers[0]')).toBeUndefined();
    expect(find(found, 'vcf.spec.invalid-ntp-server', 'ntpServers[1]')).toBeDefined();
    expect(find(found, 'vcf.spec.invalid-ntp-server', 'ntpServers[2]')).toBeDefined();
  });

  it('checks subnet masks', () => {
    const doc = fleet();
    doc.networkSpecs![0].subnetMask = '255.0.255.0';
    doc.vcfManagementComponentsInfrastructureSpec = { xRegionNetwork: { networkName: 'pg', subnetMask: '64', gateway: '172.30.10.1' } };
    const found = run(doc);
    expect(find(found, 'vcf.spec.invalid-subnet-mask', 'networkSpecs[0].subnetMask')).toBeDefined();
    expect(find(found, 'vcf.spec.invalid-subnet-mask', 'vcfManagementComponentsInfrastructureSpec.xRegionNetwork.subnetMask')).toBeDefined();
  });

  it('accepts IPv6 transit gateway blocks and rejects malformed ones', () => {
    const doc = fleet();
    doc.nsxtSpec.vpcSpec = {
      vpcNetworkConfigurationType: 'FULL_STACK_VPC',
      dtgwSpec: { vlan: 80, gatewayCidr: '2001:db8:80::1/64', externalIpBlockCidr: '10.80.0.0/16', privateTgwIpBlockCidr: '2001:db8:zz::/48' },
    };
    const found = run(doc);
    expect(find(found, 'vcf.spec.invalid-dtgw-cidr', 'nsxtSpec.vpcSpec.dtgwSpec.gatewayCidr')).toBeUndefined();
    expect(find(found, 'vcf.spec.invalid-dtgw-cidr', 'nsxtSpec.vpcSpec.dtgwSpec.privateTgwIpBlockCidr')).toBeDefined();
  });

  it('notes IPv6 values that exceed the schema’s IPv4-sized lengths', () => {
    const doc = fleet();
    doc.networkSpecs!.push({ networkType: 'MANAGEMENT', ipAddressVersion: 'IPv6', vlanId: 30, subnet: '2001:db8:30:1::/64', gateway: '2001:db8:30:1::1' });
    expect(find(run(doc), 'vcf.spec.ipv6-length-unverified')?.severity).toBe('info');
  });

  it('rejects an Automation internal CIDR that is not a CIDR', () => {
    const doc = fleet();
    doc.vcfAutomationSpec.internalClusterCidr = '198.18.0.0';
    expect(codes(run(doc))).toContain('vcf.spec.invalid-automation-internal-cidr');
  });
});

describe('full schema: VCF Operations and NSX VPC rules', () => {
  it('refuses xsmall for more than one node', () => {
    const doc = fleet();
    doc.vcfOperationsSpec.applianceSize = 'xsmall';
    doc.vcfOperationsSpec.nodes.push({ hostname: 'ops02.vcf.lab', type: 'replica' });
    expect(codes(run(doc))).toContain('vcf.spec.ops-xsmall-ha');
  });

  it('checks the Operations node count on VVF too, where there is no NSX', () => {
    const doc = vvf();
    doc.vcfOperationsSpec.nodes = ['a', 'b', 'c', 'd'].map((n) => ({ hostname: `ops-${n}.vcf.lab` }));
    expect(codes(run(doc))).toContain('vcf.spec.too-many-ops-nodes');
  });

  it('couples VLAN-backed VPC with TEP-less, and both with 9.1.1', () => {
    const vpcOnly = fleet();
    vpcOnly.nsxtSpec.vpcSpec = { vpcNetworkConfigurationType: 'VLAN_BACKED_VPC' };
    expect(codes(run(vpcOnly))).toContain('vcf.spec.vlan-vpc-without-tepless');
    const tepOnly = fleet();
    tepOnly.nsxtSpec.overlayVtepSpec = { vtepType: 'NO_IP' };
    tepOnly.nsxtSpec.vpcSpec = { vpcNetworkConfigurationType: 'FULL_STACK_VPC' };
    expect(codes(run(tepOnly))).toContain('vcf.spec.tepless-without-vlan-vpc');
    const old = fleet();
    old.version = '9.1.0.0';
    old.nsxtSpec.overlayVtepSpec = { vtepType: 'NO_IP' };
    expect(codes(run(old))).toContain('vcf.spec.vlan-vpc-needs-911');
  });
});

describe('workflow shape: VCF (new fleet and converge)', () => {
  it('needs NSX and VCF management services', () => {
    const doc = fleet();
    delete doc.nsxtSpec;
    delete doc.vspClusterSpec;
    const found = run(doc);
    expect(find(found, 'vcf.spec.workflow-missing-block', 'nsxtSpec')?.severity).toBe('error');
    expect(find(found, 'vcf.spec.workflow-missing-block', 'vspClusterSpec')?.severity).toBe('error');
  });

  it('treats all four management components absent as deferred, and some absent as a mistake', () => {
    const all = fleet();
    for (const k of ['vcfOperationsSpec', 'vcfOperationsCollectorSpec', 'licenseServerSpec', 'vcfAutomationSpec']) delete all[k];
    expect(find(run(all), 'vcf.spec.components-deferred')?.severity).toBe('info');
    const some = fleet();
    delete some.vcfAutomationSpec;
    expect(find(run(some), 'vcf.spec.components-partly-deferred')?.severity).toBe('warning');
  });

  it('warns when a new fleet has no identity broker', () => {
    const doc = fleet();
    delete doc.vidbSpec;
    expect(codes(run(doc))).toContain('vcf.spec.workflow-missing-identity-broker');
  });

  it('allows an existing VCF Operations when converging to a new fleet', () => {
    const doc = fleet();
    doc.vcenterSpec = { ...doc.vcenterSpec, useExistingDeployment: true, sslThumbprint: TP };
    doc.vcfOperationsSpec = { nodes: [{ hostname: 'ops01.vcf.lab', type: 'master', sslThumbprint: TP }], useExistingDeployment: true };
    const found = run(doc);
    expect(codes(found)).not.toContain('vcf.spec.secondary-needs-vcf-extend');
    expect(errorsOf(found)).toEqual([]);
  });

  it('still rejects VCF without fleetFqdn', () => {
    const doc = fleet();
    delete doc.vspClusterSpec.fleetFqdn;
    expect(codes(run(doc))).toContain('vcf.spec.secondary-needs-vcf-extend');
  });
});

describe('workflow shape: VCF_EXTEND (new instance and converge to an instance)', () => {
  it('requires an existing VCF Operations', () => {
    const doc = extend();
    delete doc.vcfOperationsSpec.useExistingDeployment;
    expect(find(run(doc), 'vcf.spec.extend-needs-existing-operations')?.severity).toBe('error');
    const none = extend();
    delete none.vcfOperationsSpec;
    expect(find(run(none), 'vcf.spec.workflow-missing-block', 'vcfOperationsSpec')).toBeDefined();
  });

  it('allows exactly one Operations node, the existing master', () => {
    const doc = extend();
    doc.vcfOperationsSpec.nodes.push({ hostname: 'ops02.vcf.lab', type: 'replica' }, { hostname: 'ops03.vcf.lab', type: 'replica' });
    expect(find(run(doc), 'vcf.spec.extend-operations-node-count')?.severity).toBe('error');
  });

  it('refuses fleetFqdn on a secondary instance', () => {
    const doc = extend();
    doc.vspClusterSpec.fleetFqdn = 'flt01.vcf.lab';
    expect(find(run(doc), 'vcf.spec.fleet-fqdn-on-secondary')?.severity).toBe('error');
  });

  it('does not ask a secondary instance for fleetFqdn', () => {
    expect(codes(run(extend()))).not.toContain('vcf.spec.missing-fleet-fqdn');
  });

  it('expects the fleet’s existing VCF Automation', () => {
    const doc = extend();
    doc.vcfAutomationSpec = fleet().vcfAutomationSpec;
    expect(find(run(doc), 'vcf.spec.workflow-existing-mismatch', 'vcfAutomationSpec.useExistingDeployment')?.severity).toBe('error');
  });

  it('flags new-deployment fields on the existing Operations and Automation', () => {
    const doc = extend();
    doc.vcfOperationsSpec.applianceSize = 'medium';
    doc.vcfAutomationSpec.ipPool = ['172.30.0.62'];
    const found = run(doc);
    expect(codes(found)).toContain('vcf.spec.existing-operations-extra-fields');
    expect(codes(found)).toContain('vcf.spec.existing-automation-extra-fields');
  });

  it('treats a missing License Server as a note, since the fleet’s may serve', () => {
    expect(find(run(extend()), 'vcf.spec.no-license-server')?.severity).toBe('info');
  });

  it('needs NSX and VCF management services, as every VCF instance does', () => {
    const doc = extend();
    delete doc.vspClusterSpec;
    expect(find(run(doc), 'vcf.spec.workflow-missing-block', 'vspClusterSpec')).toBeDefined();
  });
});

describe('workflow shape: VCF_COMPLETE (deferred components)', () => {
  it('requires the existing vCenter', () => {
    const doc = deferred();
    delete doc.vcenterSpec.useExistingDeployment;
    expect(find(run(doc), 'vcf.spec.workflow-existing-mismatch', 'vcenterSpec.useExistingDeployment')?.severity).toBe('error');
  });

  it('expects the existing SDDC Manager and new Operations and Automation', () => {
    const doc = deferred();
    delete doc.sddcManagerSpec.useExistingDeployment;
    doc.vcfOperationsSpec = { ...doc.vcfOperationsSpec, useExistingDeployment: true, nodes: [{ hostname: 'ops01.vcf.lab', sslThumbprint: TP }] };
    const found = run(doc);
    expect(find(found, 'vcf.spec.workflow-existing-mismatch', 'sddcManagerSpec.useExistingDeployment')?.severity).toBe('warning');
    expect(find(found, 'vcf.spec.workflow-existing-mismatch', 'vcfOperationsSpec.useExistingDeployment')?.severity).toBe('warning');
  });

  it('flags a full bring-up document carried into this workflow', () => {
    const f = fleet();
    const doc = { ...deferred(), hostSpecs: f.hostSpecs, networkSpecs: f.networkSpecs, dnsSpec: f.dnsSpec, dvsSpecs: f.dvsSpecs, nsxtSpec: f.nsxtSpec, datastoreSpec: f.datastoreSpec, clusterSpec: f.clusterSpec, saltSpec: {} };
    const blocks = run(doc).filter((x) => x.code === 'vcf.spec.workflow-unexpected-block').map((x) => x.path);
    expect(blocks).toEqual(['hostSpecs', 'networkSpecs', 'dvsSpecs', 'nsxtSpec', 'datastoreSpec', 'clusterSpec', 'saltSpec']);
  });

  it('keeps the existing finding for management services, and wants xRegionNetwork', () => {
    const doc = deferred();
    doc.vspClusterSpec = fleet().vspClusterSpec;
    delete doc.vcfManagementComponentsInfrastructureSpec;
    const found = run(doc);
    expect(codes(found)).toContain('vcf.spec.deferred-components-with-vsp');
    expect(codes(found)).toContain('vcf.spec.deferred-without-xregion-network');
  });

  it('does not want an identity broker', () => {
    const doc = deferred();
    doc.vidbSpec = { hostname: 'idb01.vcf.lab' };
    expect(find(run(doc), 'vcf.spec.workflow-unexpected-block', 'vidbSpec')?.severity).toBe('warning');
  });
});

describe('workflow shape: VVF', () => {
  it('refuses NSX and VCF Automation on a new VVF platform', () => {
    const doc = vvf();
    doc.nsxtSpec = fleet().nsxtSpec;
    doc.vcfAutomationSpec = fleet().vcfAutomationSpec;
    const found = run(doc);
    expect(find(found, 'vcf.spec.workflow-unexpected-block', 'nsxtSpec')?.severity).toBe('error');
    expect(find(found, 'vcf.spec.workflow-unexpected-block', 'vcfAutomationSpec')?.severity).toBe('error');
  });

  it('notes VVF without management services and its appliance prerequisite', () => {
    const doc = vvf();
    delete doc.vspClusterSpec;
    expect(find(run(doc), 'vcf.spec.vvf-without-management-services')?.message).toContain('explicit.management.components.deployment=true');
  });

  it('does not want an identity broker when converging to VVF', () => {
    const doc = vvf();
    doc.vcenterSpec = { ...doc.vcenterSpec, useExistingDeployment: true, sslThumbprint: TP };
    expect(find(run(doc), 'vcf.spec.workflow-unexpected-block', 'vidbSpec')?.severity).toBe('warning');
  });

  it('refuses an existing VCF Operations on a new vCenter', () => {
    const doc = vvf();
    doc.vcfOperationsSpec = { nodes: [{ hostname: 'ops01.vcf.lab', sslThumbprint: TP }], useExistingDeployment: true };
    expect(find(run(doc), 'vcf.spec.workflow-existing-mismatch', 'vcfOperationsSpec.useExistingDeployment')?.severity).toBe('error');
  });

  it('management services for VVF: needs vspClusterSpec, and not NSX, Automation, identity broker or bring-up blocks', () => {
    const missing = vvfManagementServices();
    delete missing.vspClusterSpec;
    expect(find(run(missing), 'vcf.spec.workflow-missing-block', 'vspClusterSpec')?.severity).toBe('error');

    const f = fleet();
    const extra = { ...vvfManagementServices(), nsxtSpec: f.nsxtSpec, vcfAutomationSpec: f.vcfAutomationSpec, vidbSpec: f.vidbSpec, hostSpecs: f.hostSpecs };
    const found = run(extra).filter((x) => x.code === 'vcf.spec.workflow-unexpected-block');
    expect(found.map((x) => `${x.path}:${x.severity}`).sort()).toEqual([
      'hostSpecs:warning',
      'nsxtSpec:warning',
      'vcfAutomationSpec:warning',
      'vidbSpec:warning',
    ]);
  });
});

describe('editor answer sets', () => {
  const paths = new Set(schemaPaths());

  it('covers every top-level key the types define', () => {
    for (const key of SDDC_SPEC_TOP_LEVEL_KEYS) expect(paths.has(key)).toBe(true);
    expect(Object.keys(SDDC_SCHEMA).sort()).toEqual([...SDDC_SPEC_TOP_LEVEL_KEYS].sort());
  });

  it('keys every CHOICES entry by a real schema path', () => {
    const unknown = Object.keys(CHOICES).filter((k) => !paths.has(k));
    expect(unknown).toEqual([]);
  });

  it('uses ipAddressAssignmentMode, not the non-existent assignmentMode', () => {
    expect(CHOICES['networkSpecs[].ipAddressAssignmentMode']).toEqual(['STATIC', 'DHCP', 'SLAAC']);
    expect(CHOICES['networkSpecs[].assignmentMode']).toBeUndefined();
  });

  it('offers a list for every enumerated field in the schema', () => {
    const enumerated: string[] = [];
    const walk = (schema: Record<string, any>, prefix: string): void => {
      for (const [key, field] of Object.entries(schema)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (field.enum) enumerated.push(field.kind === 'strings' ? `${path}[]` : path);
        if (field.of) walk(field.of, field.kind === 'array' ? `${path}[]` : path);
      }
    };
    walk(SDDC_SCHEMA, '');
    const missing = enumerated.filter((p) => !CHOICES[p]);
    expect(missing).toEqual([]);
  });

  it('offers only values the validator accepts', () => {
    // Setting each offered value into a valid spec must not produce an enum finding.
    const setters: Record<string, (d: Doc, v: string) => void> = {
      workflowType: () => undefined, // changes the workflow; covered by the shape tests
      'networkSpecs[].ipAddressAssignmentMode': (d, v) => (d.networkSpecs![2].ipAddressAssignmentMode = v),
      'dvsSpecs[].lagSpecs[].lacpMode': (d, v) => (d.dvsSpecs[0].lagSpecs = [{ name: 'l', uplinksCount: 2, lacpMode: v, lacpTimeoutMode: 'FAST', loadBalancingMode: 'VLAN' }]),
      'dvsSpecs[].lagSpecs[].loadBalancingMode': (d, v) => (d.dvsSpecs[0].lagSpecs = [{ name: 'l', uplinksCount: 2, lacpMode: 'ACTIVE', lacpTimeoutMode: 'FAST', loadBalancingMode: v }]),
      'dvsSpecs[].nsxtSwitchConfig.hostSwitchOperationalMode': (d, v) => (d.dvsSpecs[0].nsxtSwitchConfig.hostSwitchOperationalMode = v),
      'clusterSpec.resourcePoolSpecs[].type': (d, v) => (d.clusterSpec.resourcePoolSpecs = [{ name: 'rp', type: v }]),
      'securitySpec.esxiCertsMode': (d, v) => (d.securitySpec = { esxiCertsMode: v }),
      'vidbSpec.size': (d, v) => (d.vidbSpec.size = v),
      'vcfAutomationSpec.internalClusterCidr': (d, v) => (d.vcfAutomationSpec.internalClusterCidr = v),
      'vspClusterSpec.internalClusterCidrIpv6': (d, v) => (d.vspClusterSpec.internalClusterCidrIpv6 = v),
      'clusterSpec.clusterEvcMode': (d, v) => (d.clusterSpec.clusterEvcMode = v),
    };
    for (const [key, set] of Object.entries(setters)) {
      for (const value of CHOICES[key] ?? []) {
        const doc = fleet();
        set(doc, value);
        const bad = run(doc).filter((f) => /invalid-enum|undocumented-value|invalid-internal-cidr|invalid-automation-internal-cidr/.test(f.code));
        if (bad.length > 0) throw new Error(`${key}=${value}: ${bad.map((f) => f.code).join(', ')}`);
      }
    }
  });

  it('adds the lists the audit found missing', () => {
    for (const key of [
      'dvsSpecs[].lagSpecs[].lacpMode',
      'dvsSpecs[].lagSpecs[].lacpTimeoutMode',
      'dvsSpecs[].lagSpecs[].loadBalancingMode',
      'dvsSpecs[].nsxtSwitchConfig.hostSwitchOperationalMode',
      'nsxtSpec.vpcSpec.vpcNetworkConfigurationType',
      'nsxtSpec.overlayVtepSpec.vtepType',
      'securitySpec.esxiCertsMode',
      'clusterSpec.resourcePoolSpecs[].type',
      'vspClusterSpec.internalClusterCidrIpv4',
      'vspClusterSpec.internalClusterCidrIpv6',
      'vcfAutomationSpec.internalClusterCidr',
      'vidbSpec.size',
    ]) {
      expect((CHOICES[key]?.length ?? 0) > 0).toBe(true);
    }
    expect(CHOICES['dvsSpecs[].lagSpecs[].loadBalancingMode']).toHaveLength(20);
  });

  it('labels the vSAN ESA disk-claim flag the way the wizard does', () => {
    expect(labelFor('skipHclAutoDiskClaim')).toBe('Allow auto-claim of HCL-incompatible disks');
    expect(labelFor('vcenterHostname')).toBe('vCenter FQDN');
  });
});
