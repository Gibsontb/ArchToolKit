import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { buildSddcSpec, redactSpec, serializeSpec, PLACEHOLDER_SECRET, type DeploymentPlan } from './spec-builder.ts';
import { validateSddcSpec, validateSddcSpecJson } from './spec-validate.ts';
import { SDDC_SPEC_TOP_LEVEL_KEYS, type SddcSpec } from './spec-types.ts';
import { hasErrors } from '../core/findings.ts';

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

function codes(findings: readonly { code: string }[]): string[] {
  return findings.map((f) => f.code);
}

describe('buildSddcSpec — structure', () => {
  it('produces a spec that passes its own validator', () => {
    const { spec } = buildSddcSpec(basePlan());
    const findings = validateSddcSpec(spec);
    if (hasErrors(findings)) {
      throw new Error(
        `Generated spec failed validation:\n${findings
          .filter((f) => f.severity === 'error')
          .map((f) => `  ${f.code}: ${f.message}`)
          .join('\n')}`,
      );
    }
    expect(hasErrors(findings)).toBe(false);
  });

  it('emits all four required top-level keys', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(spec.sddcId).toBe('vcf-m01');
    expect(spec.dnsSpec).toBeDefined();
    expect(spec.vcenterSpec).toBeDefined();
    expect(Array.isArray(spec.networkSpecs)).toBe(true);
  });

  it('emits the 9.1 components both public builders omit', () => {
    const { spec } = buildSddcSpec(basePlan());
    // These are the differentiators — neither reference builder emits them.
    expect(spec.vspClusterSpec).toBeDefined();
    expect(spec.vidbSpec).toBeDefined();
    expect(spec.licenseServerSpec).toBeDefined();
    expect(spec.fleetLcmSpec).toBeDefined();
    expect(spec.sddcLcmSpec).toBeDefined();
    expect(spec.fleetDepotSpec).toBeDefined();
    expect(spec.telemetryAcceptorSpec).toBeDefined();
    expect(spec.saltSpec).toBeDefined();
    expect(spec.saltRaasSpec).toBeDefined();
  });

  it('never emits the field removed in 9.1', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect('vcfOperationsFleetManagementSpec' in spec).toBe(false);
  });

  it('only emits keys the 9.1 schema defines', () => {
    const { spec } = buildSddcSpec(basePlan());
    const known = new Set<string>(SDDC_SPEC_TOP_LEVEL_KEYS);
    const unknown = Object.keys(spec).filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  it('emits no license key fields, since licensing is post-deployment in 9.1', () => {
    const json = serializeSpec(buildSddcSpec(basePlan()).spec);
    expect(/licenseKey|licenseFile/i.test(json)).toBe(false);
  });
});

describe('buildSddcSpec — hosts and naming', () => {
  it('generates zero-padded short hostnames, not FQDNs', () => {
    const { spec } = buildSddcSpec(basePlan({ hostCount: 3 }));
    expect(spec.hostSpecs?.map((h) => h.hostname)).toEqual(['esx01', 'esx02', 'esx03']);
  });

  it('builds component FQDNs from the prefix and domain, lowercased', () => {
    const { spec } = buildSddcSpec(basePlan({ domainSuffix: 'VCF.LAB' }));
    expect(spec.vcenterSpec.vcenterHostname).toBe('vcf-m01-vc01.vcf.lab');
    expect(spec.nsxtSpec?.vipFqdn).toBe('vcf-m01-nsx.vcf.lab');
    expect(spec.dnsSpec.subdomain).toBe('vcf.lab');
  });

  it('caps nameservers at the documented maximum of two', () => {
    const { spec } = buildSddcSpec(
      basePlan({ dnsServers: ['10.0.0.1', '10.0.0.2', '10.0.0.3'] }),
    );
    expect(spec.dnsSpec.nameservers).toHaveLength(2);
  });
});

describe('buildSddcSpec — networks', () => {
  it('always includes a MANAGEMENT and VM_MANAGEMENT network', () => {
    const { spec } = buildSddcSpec(basePlan());
    const types = spec.networkSpecs.map((n) => n.networkType);
    expect(types).toContain('MANAGEMENT');
    expect(types).toContain('VM_MANAGEMENT');
  });

  it('derives the gateway as the first usable address when not supplied', () => {
    const { spec } = buildSddcSpec(basePlan());
    const mgmt = spec.networkSpecs.find((n) => n.networkType === 'MANAGEMENT');
    expect(mgmt?.gateway).toBe('172.30.0.1');
  });

  it('honours an explicit gateway', () => {
    const { spec } = buildSddcSpec(
      basePlan({ management: { cidr: '172.30.0.0/24', vlanId: 30, gateway: '172.30.0.254' } }),
    );
    const mgmt = spec.networkSpecs.find((n) => n.networkType === 'MANAGEMENT');
    expect(mgmt?.gateway).toBe('172.30.0.254');
  });

  it('allocates one vMotion and one vSAN address per host', () => {
    const { spec } = buildSddcSpec(basePlan({ hostCount: 4 }));
    const vmotion = spec.networkSpecs.find((n) => n.networkType === 'VMOTION');
    const range = vmotion?.includeIpAddressRanges?.[0];
    expect(range?.startIpAddress).toBe('172.30.40.10');
    expect(range?.endIpAddress).toBe('172.30.40.13');
  });

  it('omits the vSAN network when using external storage', () => {
    const { spec } = buildSddcSpec(basePlan({ storage: 'nfs', nfs: { cidr: '172.30.70.0/24', vlanId: 70 } }));
    const types = spec.networkSpecs.map((n) => n.networkType);
    expect(types).not.toContain('VSAN');
    expect(types).toContain('NFS');
  });

  it('adds a FLEET_MANAGEMENT network when planned', () => {
    const { spec } = buildSddcSpec(
      basePlan({ fleetManagement: { cidr: '172.30.80.0/24', vlanId: 80 } }),
    );
    expect(spec.networkSpecs.map((n) => n.networkType)).toContain('FLEET_MANAGEMENT');
  });

  it('sets jumbo frames on vMotion and vSAN by default', () => {
    const { spec } = buildSddcSpec(basePlan());
    const vmotion = spec.networkSpecs.find((n) => n.networkType === 'VMOTION');
    const vsan = spec.networkSpecs.find((n) => n.networkType === 'VSAN');
    expect(vmotion?.mtu).toBe(9000);
    expect(vsan?.mtu).toBe(9000);
  });
});

describe('buildSddcSpec — NSX and TEP pool', () => {
  it('uses the start/end range shape for the TEP pool, not startIpAddress/endIpAddress', () => {
    const { spec } = buildSddcSpec(basePlan());
    const range = spec.nsxtSpec?.ipAddressPoolSpec?.subnets?.[0]?.ipAddressPoolRanges?.[0];
    expect(range).toBeDefined();
    expect('start' in (range as object)).toBe(true);
    expect('startIpAddress' in (range as object)).toBe(false);
  });

  it('sizes the TEP pool for hosts times pNICs', () => {
    const { spec } = buildSddcSpec(basePlan({ hostCount: 4, pnicsPerHost: 2 }));
    const range = spec.nsxtSpec?.ipAddressPoolSpec?.subnets?.[0]?.ipAddressPoolRanges?.[0];
    // 4 hosts x 2 pNICs = 8 addresses, starting at .10
    expect(range?.start).toBe('172.30.60.10');
    expect(range?.end).toBe('172.30.60.17');
  });

  it('deploys one NSX Manager for simple and three for HA', () => {
    expect(buildSddcSpec(basePlan({ profile: 'simple' })).spec.nsxtSpec?.nsxtManagers).toHaveLength(1);
    expect(buildSddcSpec(basePlan({ profile: 'ha' })).spec.nsxtSpec?.nsxtManagers).toHaveLength(3);
  });

  it('defaults the manager size to medium, the smallest bring-up option', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(spec.nsxtSpec?.nsxtManagerSize).toBe('medium');
  });

  it('emits a VPC and DTGW spec when planned', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        dtgw: {
          vlan: 70,
          gatewayCidr: '172.30.70.1/24',
          externalIpBlockCidr: '172.30.70.0/26',
          privateTgwIpBlockCidr: '172.31.0.0/16',
        },
      }),
    );
    expect(spec.nsxtSpec?.vpcSpec?.dtgwSpec?.vlan).toBe(70);
    expect(spec.nsxtSpec?.vpcSpec?.vpcNetworkConfigurationType).toBe('FULL_STACK_VPC');
  });
});

describe('buildSddcSpec — vDS profiles', () => {
  it('builds a single switch for the default profile', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(spec.dvsSpecs).toHaveLength(1);
    expect(spec.dvsSpecs?.[0]?.nsxtSwitchConfig).toBeDefined();
  });

  it('splits uplinks across two switches for storage separation', () => {
    const { spec } = buildSddcSpec(
      basePlan({ dvsProfile: 'storage-separation', vmnics: ['vmnic0', 'vmnic1', 'vmnic2', 'vmnic3'] }),
    );
    expect(spec.dvsSpecs).toHaveLength(2);
    expect(spec.dvsSpecs?.[0]?.vmnicsToUplinks).toHaveLength(2);
    expect(spec.dvsSpecs?.[1]?.vmnicsToUplinks).toHaveLength(2);
  });

  it('builds three switches for storage and NSX separation', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        dvsProfile: 'storage-and-nsx-separation',
        vmnics: ['vmnic0', 'vmnic1', 'vmnic2', 'vmnic3', 'vmnic4', 'vmnic5'],
      }),
    );
    expect(spec.dvsSpecs).toHaveLength(3);
  });

  it('warns when there are too few vmnics for the chosen profile', () => {
    const { findings } = buildSddcSpec(
      basePlan({ dvsProfile: 'storage-and-nsx-separation', vmnics: ['vmnic0', 'vmnic1'] }),
    );
    expect(codes(findings)).toContain('vcf.build.insufficient-vmnics');
  });

  it('emits LACP when planned', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        lacp: {
          uplinksCount: 2,
          lacpMode: 'ACTIVE',
          lacpTimeoutMode: 'FAST',
          loadBalancingMode: 'SOURCE_AND_DESTINATION_IP',
        },
      }),
    );
    expect(spec.dvsSpecs?.[0]?.lagSpecs).toHaveLength(1);
    expect(spec.dvsSpecs?.[0]?.lagSpecs?.[0]?.lacpMode).toBe('ACTIVE');
  });

  it('keeps LAG names within the 16-character limit', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        namePrefix: 'a-very-long-instance-prefix',
        lacp: {
          uplinksCount: 2,
          lacpMode: 'ACTIVE',
          lacpTimeoutMode: 'SLOW',
          loadBalancingMode: 'SOURCE_IP',
        },
      }),
    );
    const name = spec.dvsSpecs?.[0]?.lagSpecs?.[0]?.name ?? '';
    expect(name.length).toBeLessThanOrEqual(16);
  });
});

describe('buildSddcSpec — storage', () => {
  it('enables ESA and disables dedup for vSAN ESA', () => {
    const { spec } = buildSddcSpec(basePlan({ storage: 'vsan-esa' }));
    expect(spec.datastoreSpec?.vsanSpec?.esaConfig?.enabled).toBe(true);
    expect(spec.datastoreSpec?.vsanSpec?.vsanDedup).toBe(false);
  });

  it('derives FTT=1 below six hosts and FTT=2 at six or more', () => {
    expect(buildSddcSpec(basePlan({ hostCount: 4 })).spec.datastoreSpec?.vsanSpec?.failuresToTolerate).toBe(1);
    expect(buildSddcSpec(basePlan({ hostCount: 6 })).spec.datastoreSpec?.vsanSpec?.failuresToTolerate).toBe(2);
  });

  it('always emits FTT explicitly, because the documented default is ambiguous', () => {
    const { spec, findings } = buildSddcSpec(basePlan());
    expect(spec.datastoreSpec?.vsanSpec?.failuresToTolerate).toBeDefined();
    expect(codes(findings)).toContain('vcf.build.ftt-derived');
  });

  it('builds an NFS datastore spec for NFS storage', () => {
    const { spec } = buildSddcSpec(
      basePlan({ storage: 'nfs', nfsServer: '10.0.0.50', nfsPath: '/export/vcf' }),
    );
    expect(spec.datastoreSpec?.nfsDatastoreSpec?.nasVolume.serverName).toEqual(['10.0.0.50']);
    expect(spec.datastoreSpec?.vsanSpec).toBeUndefined();
  });

  it('builds a VMFS-FC datastore spec', () => {
    const { spec } = buildSddcSpec(basePlan({ storage: 'vmfs-fc', datastoreName: 'fc-ds01' }));
    expect(spec.datastoreSpec?.vmfsDatastoreSpec?.fcSpec?.[0]?.datastoreName).toBe('fc-ds01');
  });
});

describe('buildSddcSpec — brownfield', () => {
  it('marks reused components and carries their thumbprints', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        existing: {
          vcenter: { fqdn: 'vc01.vcf.lab', sslThumbprint: 'AA:BB:CC' },
          nsx: { fqdn: 'nsx01.vcf.lab', sslThumbprint: 'DD:EE:FF' },
        },
      }),
    );
    expect(spec.vcenterSpec.useExistingDeployment).toBe(true);
    expect(spec.vcenterSpec.sslThumbprint).toBe('AA:BB:CC');
    expect(spec.nsxtSpec?.useExistingDeployment).toBe(true);
    expect(spec.nsxtSpec?.enableEdgeClusterSync).toBe(true);
  });

  it('uses an existing datastore when converging', () => {
    const { spec } = buildSddcSpec(basePlan({ existing: { datastoreName: 'existing-vsan' } }));
    expect(spec.datastoreSpec?.existingDatastoreName).toBe('existing-vsan');
    expect(spec.datastoreSpec?.vsanSpec).toBeUndefined();
  });
});

describe('buildSddcSpec — fleet position', () => {
  it('includes fleetFqdn for a primary instance', () => {
    const { spec } = buildSddcSpec(basePlan({ instanceRole: 'primary' }));
    expect(spec.vspClusterSpec?.fleetFqdn).toBeDefined();
  });

  it('omits fleetFqdn and reuses Operations for a secondary instance', () => {
    const { spec, findings } = buildSddcSpec(basePlan({ instanceRole: 'secondary' }));
    expect(spec.vspClusterSpec?.fleetFqdn).toBeUndefined();
    expect(spec.vcfOperationsSpec?.useExistingDeployment).toBe(true);
    expect(codes(findings)).toContain('vcf.build.secondary-instance');
  });

  it('declares VCF_EXTEND for a secondary instance and VCF for a primary', () => {
    // Broadcom documents this explicitly; emitting VCF for a secondary is a
    // silent misconfiguration that prevents it joining the fleet.
    expect(buildSddcSpec(basePlan({ instanceRole: 'primary' })).spec.workflowType).toBe('VCF');
    expect(buildSddcSpec(basePlan({ instanceRole: 'secondary' })).spec.workflowType).toBe(
      'VCF_EXTEND',
    );
  });

  it('warns when an undocumented workflow type is requested', () => {
    const { findings } = buildSddcSpec(basePlan({ workflowType: 'VCF_BOOTSTRAP' }));
    expect(codes(findings)).toContain('vcf.build.undocumented-workflow-type');
  });

  it('restricts the internal cluster CIDR to a permitted block', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(['198.18.0.0/15', '240.0.0.0/15', '250.0.0.0/15']).toContain(
      spec.vspClusterSpec?.internalClusterCidrIpv4,
    );
  });
});

describe('buildSddcSpec — secrets', () => {
  it('emits placeholders rather than inventing credentials', () => {
    const { spec, placeholders } = buildSddcSpec(basePlan());
    expect(placeholders.length).toBeGreaterThan(0);
    expect(spec.vcenterSpec.rootVcenterPassword).toBe(PLACEHOLDER_SECRET);
  });

  it('uses supplied passwords when the plan provides them', () => {
    const { spec, placeholders } = buildSddcSpec(
      basePlan({ passwords: { vcenterRoot: 'CorrectHorse!99x' } }),
    );
    expect(spec.vcenterSpec.rootVcenterPassword).toBe('CorrectHorse!99x');
    expect(placeholders).not.toContain('vcenterSpec.rootVcenterPassword');
  });

  it('warns that placeholders must be filled before deployment', () => {
    const { findings } = buildSddcSpec(basePlan());
    expect(codes(findings)).toContain('vcf.build.placeholder-secrets');
  });

  it('always notes that the spec is not installer-validated', () => {
    const { findings } = buildSddcSpec(basePlan());
    expect(codes(findings)).toContain('vcf.build.not-validated');
  });
});

describe('redactSpec', () => {
  it('removes every password and thumbprint', () => {
    const { spec } = buildSddcSpec(basePlan({ passwords: { vcenterRoot: 'Secret!Value99' } }));
    const json = JSON.stringify(redactSpec(spec));
    expect(json.includes('Secret!Value99')).toBe(false);
    expect(json).toContain('<REDACTED>');
  });

  it('leaves non-secret fields intact', () => {
    const { spec } = buildSddcSpec(basePlan());
    const redacted = redactSpec(spec);
    expect(redacted.sddcId).toBe('vcf-m01');
    expect(redacted.networkSpecs).toHaveLength(spec.networkSpecs.length);
  });
});

describe('validateSddcSpec — version drift', () => {
  it('rejects the 9.0 fleet management field', () => {
    const { spec } = buildSddcSpec(basePlan());
    const withRemoved = { ...spec, vcfOperationsFleetManagementSpec: { hostname: 'fleet.vcf.lab' } };
    const findings = validateSddcSpec(withRemoved);
    expect(codes(findings)).toContain('vcf.spec.removed-9.0-field');
    expect(hasErrors(findings)).toBe(true);
  });

  it('rejects license key fields left over from VCF 4.x/5.x habits', () => {
    const { spec } = buildSddcSpec(basePlan());
    const findings = validateSddcSpec({ ...spec, licenseKey: 'ABCDE-12345' });
    expect(codes(findings)).toContain('vcf.spec.license-key-in-spec');
  });
});

describe('validateSddcSpec — required fields and formats', () => {
  it('reports every missing required key', () => {
    const findings = validateSddcSpec({});
    const missing = findings.filter((f) => f.code === 'vcf.spec.missing-required');
    expect(missing).toHaveLength(4);
  });

  it('rejects a malformed sddcId', () => {
    const findings = validateSddcSpec({ sddcId: 'a' } as never);
    expect(codes(findings)).toContain('vcf.spec.sddc-id-format');
  });

  it('rejects uppercase and .local domains', () => {
    const upper = validateSddcSpec({ dnsSpec: { subdomain: 'VCF.LAB' } } as never);
    expect(codes(upper)).toContain('vcf.spec.dns-subdomain-case');
    const local = validateSddcSpec({ dnsSpec: { subdomain: 'vcf.local' } } as never);
    expect(codes(local)).toContain('vcf.spec.dns-unsupported-suffix');
  });

  it('rejects more than two nameservers', () => {
    const findings = validateSddcSpec({
      dnsSpec: { subdomain: 'vcf.lab', nameservers: ['1.1.1.1', '2.2.2.2', '3.3.3.3'] },
    } as never);
    expect(codes(findings)).toContain('vcf.spec.too-many-nameservers');
  });
});

describe('validateSddcSpec — networks', () => {
  it('catches a gateway outside its own subnet', () => {
    const { spec } = buildSddcSpec(basePlan());
    const broken: SddcSpec = {
      ...spec,
      networkSpecs: spec.networkSpecs.map((n) =>
        n.networkType === 'MANAGEMENT' ? { ...n, gateway: '10.99.99.1' } : n,
      ),
    };
    expect(codes(validateSddcSpec(broken))).toContain('vcf.spec.gateway-outside-subnet');
  });

  it('catches overlapping subnets on different VLANs', () => {
    const { spec } = buildSddcSpec(basePlan());
    const broken: SddcSpec = {
      ...spec,
      networkSpecs: spec.networkSpecs.map((n) =>
        n.networkType === 'VMOTION' ? { ...n, subnet: '172.30.0.0/24' } : n,
      ),
    };
    expect(codes(validateSddcSpec(broken))).toContain('vcf.spec.overlapping-subnets');
  });

  it('rejects an out-of-range VLAN', () => {
    const { spec } = buildSddcSpec(basePlan());
    const broken: SddcSpec = {
      ...spec,
      networkSpecs: spec.networkSpecs.map((n) =>
        n.networkType === 'MANAGEMENT' ? { ...n, vlanId: 5000 } : n,
      ),
    };
    expect(codes(validateSddcSpec(broken))).toContain('vcf.spec.invalid-vlan');
  });

  it('accepts a VLAN supplied as a string, as a real working spec emits', () => {
    const { spec } = buildSddcSpec(basePlan());
    const asString: SddcSpec = {
      ...spec,
      networkSpecs: spec.networkSpecs.map((n) => ({ ...n, vlanId: String(n.vlanId) })),
    };
    expect(codes(validateSddcSpec(asString))).not.toContain('vcf.spec.invalid-vlan');
  });

  it('flags a management subnet too small for the component addresses', () => {
    const { spec } = buildSddcSpec(
      basePlan({ management: { cidr: '172.30.0.0/28', vlanId: 30 }, hostCount: 4 }),
    );
    expect(codes(validateSddcSpec(spec))).toContain('vcf.spec.management-subnet-too-small');
  });
});

describe('validateSddcSpec — component rules', () => {
  it('rejects an NSX Manager size that bring-up does not accept', () => {
    const { spec } = buildSddcSpec(basePlan());
    const broken = { ...spec, nsxtSpec: { ...spec.nsxtSpec!, nsxtManagerSize: 'small' as never } };
    expect(codes(validateSddcSpec(broken))).toContain('vcf.spec.nsx-size-not-supported');
  });

  it('rejects FTT=2 on a cluster with fewer than six hosts', () => {
    const { spec } = buildSddcSpec(basePlan({ hostCount: 4, failuresToTolerate: 2 }));
    expect(codes(validateSddcSpec(spec))).toContain('vcf.spec.ftt-needs-more-hosts');
  });

  it('rejects dedup combined with ESA', () => {
    const { spec } = buildSddcSpec(basePlan());
    const broken: SddcSpec = {
      ...spec,
      datastoreSpec: {
        vsanSpec: { ...spec.datastoreSpec!.vsanSpec!, vsanDedup: true, esaConfig: { enabled: true } },
      },
    };
    expect(codes(validateSddcSpec(broken))).toContain('vcf.spec.dedup-esa-conflict');
  });

  it('rejects an internal cluster CIDR outside the three permitted blocks', () => {
    const { spec } = buildSddcSpec(basePlan());
    const broken: SddcSpec = {
      ...spec,
      vspClusterSpec: { ...spec.vspClusterSpec!, internalClusterCidrIpv4: '10.10.0.0/15' },
    };
    expect(codes(validateSddcSpec(broken))).toContain('vcf.spec.invalid-internal-cidr');
  });

  it('rejects a VCFMS pool below the 12-address minimum', () => {
    const { spec } = buildSddcSpec(basePlan());
    const broken: SddcSpec = {
      ...spec,
      vspClusterSpec: {
        ...spec.vspClusterSpec!,
        ipv4Pool: { ipRange: { startIpAddress: '172.30.0.33', endIpAddress: '172.30.0.38' } },
      },
    };
    expect(codes(validateSddcSpec(broken))).toContain('vcf.spec.vcfms-pool-too-small');
  });

  it('rejects an Automation pool below five addresses', () => {
    const { spec } = buildSddcSpec(basePlan());
    const broken: SddcSpec = {
      ...spec,
      vcfAutomationSpec: { ...spec.vcfAutomationSpec!, ipPool: ['172.30.0.65', '172.30.0.66'] },
    };
    expect(codes(validateSddcSpec(broken))).toContain('vcf.spec.automation-pool-too-small');
  });

  it('warns when a primary instance omits fleetFqdn but not when secondary', () => {
    const primary = buildSddcSpec(basePlan({ instanceRole: 'primary' })).spec;
    const stripped: SddcSpec = {
      ...primary,
      vspClusterSpec: { ...primary.vspClusterSpec!, fleetFqdn: undefined },
    };
    expect(codes(validateSddcSpec(stripped))).toContain('vcf.spec.missing-fleet-fqdn');
    expect(codes(validateSddcSpec(stripped, { secondaryInstance: true }))).not.toContain(
      'vcf.spec.missing-fleet-fqdn',
    );
  });

  it('requires a thumbprint when reusing an existing vCenter', () => {
    const { spec } = buildSddcSpec(basePlan());
    const broken: SddcSpec = {
      ...spec,
      vcenterSpec: { ...spec.vcenterSpec, useExistingDeployment: true, sslThumbprint: undefined },
    };
    expect(codes(validateSddcSpec(broken))).toContain('vcf.spec.missing-thumbprint');
  });
});

describe('buildSddcSpec — schema fidelity corrections', () => {
  it('reproduces Broadcom’s own EVC spelling rather than correcting it', () => {
    // INTEL_NEALEM and AMD_STREAMROLLER are misspelled in the API enum.
    // "Fixing" them produces values the installer rejects.
    const { spec } = buildSddcSpec(basePlan({ evcMode: 'INTEL_NEALEM' }));
    expect(spec.clusterSpec?.clusterEvcMode).toBe('INTEL_NEALEM');
    expect(buildSddcSpec(basePlan({ evcMode: 'AMD_STREAMROLLER' })).spec.clusterSpec?.clusterEvcMode).toBe(
      'AMD_STREAMROLLER',
    );
  });

  it('emits a securitySpec when a certificate mode is chosen', () => {
    const { spec } = buildSddcSpec(basePlan({ esxiCertsMode: 'VMCA' }));
    expect(spec.securitySpec?.esxiCertsMode).toBe('VMCA');
  });

  it('warns when custom certificates are requested without a CA chain', () => {
    const { findings } = buildSddcSpec(basePlan({ esxiCertsMode: 'Custom' }));
    expect(codes(findings)).toContain('vcf.build.custom-certs-without-ca');
  });

  it('emits managementPoolName only when named', () => {
    expect(buildSddcSpec(basePlan()).spec.managementPoolName).toBeUndefined();
    expect(buildSddcSpec(basePlan({ managementPoolName: 'mgmt-pool-01' })).spec.managementPoolName).toBe(
      'mgmt-pool-01',
    );
  });

  it('emits resource pools and honours the management-pool requirement', () => {
    const { spec } = buildSddcSpec(
      basePlan({ resourcePools: [{ name: 'Management', type: 'management' }] }),
    );
    expect(spec.clusterSpec?.resourcePoolSpecs).toHaveLength(1);
    expect(spec.clusterSpec?.resourcePoolSpecs?.[0]?.type).toBe('management');
  });

  it('drops the TEP pool for a TEP-less deployment', () => {
    const { spec, findings } = buildSddcSpec(basePlan({ tepLess: true }));
    expect(spec.nsxtSpec?.overlayVtepSpec?.vtepType).toBe('NO_IP');
    expect(spec.nsxtSpec?.ipAddressPoolSpec).toBeUndefined();
    expect(codes(findings)).toContain('vcf.build.tep-less');
  });

  it('applies per-component FQDN overrides', () => {
    const { spec } = buildSddcSpec(
      basePlan({
        fqdnOverrides: {
          vcenter: 'vcenter-prod.corp.example',
          nsxVip: 'nsx-vip.corp.example',
          licenseServer: 'lic.corp.example',
        },
      }),
    );
    expect(spec.vcenterSpec.vcenterHostname).toBe('vcenter-prod.corp.example');
    expect(spec.nsxtSpec?.vipFqdn).toBe('nsx-vip.corp.example');
    expect(spec.licenseServerSpec?.hostname).toBe('lic.corp.example');
    // Un-overridden names still derive from the prefix.
    expect(spec.sddcManagerSpec?.hostname).toBe('vcf-m01-sddcm01.vcf.lab');
  });

  it('keeps fleetLcmSpec and sddcLcmSpec aligned with the schema-backed FQDNs', () => {
    // These two hostnames are not in the published schema and may be dropped,
    // so the authoritative values must also appear on vspClusterSpec.
    const { spec } = buildSddcSpec(basePlan());
    expect(spec.fleetLcmSpec?.hostname).toBe(spec.vspClusterSpec?.fleetFqdn);
    expect(spec.sddcLcmSpec?.hostname).toBe(spec.vspClusterSpec?.instanceFqdn);
  });
});

describe('validateSddcSpec — newly confirmed constraints', () => {
  it('rejects a secondary-shaped spec that still declares workflowType VCF', () => {
    const { spec } = buildSddcSpec(basePlan({ instanceRole: 'secondary' }));
    const mislabelled: SddcSpec = { ...spec, workflowType: 'VCF' };
    expect(codes(validateSddcSpec(mislabelled))).toContain('vcf.spec.secondary-needs-vcf-extend');
  });

  it('accepts a correctly labelled secondary instance', () => {
    const { spec } = buildSddcSpec(basePlan({ instanceRole: 'secondary' }));
    const findings = validateSddcSpec(spec, { secondaryInstance: true });
    expect(codes(findings)).not.toContain('vcf.spec.secondary-needs-vcf-extend');
  });

  it('rejects a vCenter password above the 20-character maximum', () => {
    const { spec } = buildSddcSpec(
      basePlan({ passwords: { vcenterRoot: 'ThisPasswordIsFarTooLongForVcenter!1' } }),
    );
    expect(codes(validateSddcSpec(spec))).toContain('vcf.spec.vcenter-password-too-long');
  });

  it('rejects more than one NSX teaming policy', () => {
    const { spec } = buildSddcSpec(basePlan());
    const broken: SddcSpec = {
      ...spec,
      dvsSpecs: [
        {
          ...spec.dvsSpecs![0]!,
          nsxTeamings: [
            { policy: 'LOADBALANCE_SRCID', activeUplinks: ['uplink1'] },
            { policy: 'FAILOVER_ORDER', activeUplinks: ['uplink2'] },
          ],
        },
      ],
    };
    expect(codes(validateSddcSpec(broken))).toContain('vcf.spec.too-many-nsx-teamings');
  });

  it('rejects more than three VCF Operations nodes', () => {
    const { spec } = buildSddcSpec(basePlan({ profile: 'ha' }));
    const broken: SddcSpec = {
      ...spec,
      vcfOperationsSpec: {
        ...spec.vcfOperationsSpec!,
        nodes: [...spec.vcfOperationsSpec!.nodes, { hostname: 'ops04.vcf.lab', type: 'data' }],
      },
    };
    expect(codes(validateSddcSpec(broken))).toContain('vcf.spec.too-many-ops-nodes');
  });

  it('warns about a TEP pool alongside a TEP-less deployment', () => {
    const { spec } = buildSddcSpec(basePlan());
    const contradictory: SddcSpec = {
      ...spec,
      nsxtSpec: { ...spec.nsxtSpec!, overlayVtepSpec: { vtepType: 'NO_IP' } },
    };
    expect(codes(validateSddcSpec(contradictory))).toContain('vcf.spec.tep-pool-with-tepless');
  });
});

describe('validateSddcSpecJson', () => {
  it('reports malformed JSON as a finding rather than throwing', () => {
    const findings = validateSddcSpecJson('{ not json');
    expect(codes(findings)).toContain('vcf.spec.invalid-json');
  });

  it('rejects a JSON array', () => {
    expect(codes(validateSddcSpecJson('[]'))).toContain('vcf.spec.not-an-object');
  });

  it('validates a generated spec round-tripped through JSON', () => {
    const { spec } = buildSddcSpec(basePlan());
    const findings = validateSddcSpecJson(serializeSpec(spec));
    expect(hasErrors(findings)).toBe(false);
  });
});
