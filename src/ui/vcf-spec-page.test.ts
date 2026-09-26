/**
 * The VCF spec builder page's plan assembly (src/ui/vcf-spec-plan.ts), tested
 * without a DOM: the page reads its controls into a record of values and hands
 * it to `planFromForm`, so a record built from FORM_DEFAULTS is exactly what an
 * untouched page builds.
 */
import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  FORM_DEFAULTS,
  DVS_SWITCH_GRID,
  RESOURCE_POOL_GRID,
  defaultValues,
  existingFrom,
  isSecretControl,
  migrateFields,
  networkAdvanced,
  parseDvsSwitches,
  parseIpRanges,
  parseResourcePools,
  parseRootCaCerts,
  parseTransportZones,
  parseVmnicMapping,
  planFromForm,
  scenarioView,
  specSummary,
} from './vcf-spec-plan.ts';
import { buildSddcSpec } from '../vcf/spec-builder.ts';
import { validateSddcSpec } from '../vcf/spec-validate.ts';
import { SCENARIO_RULES } from '../vcf/scenarios.ts';
import { emitTerraform } from '../terraform/vcf.ts';

const THUMB = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

describe('every scenario builds from the page', () => {
  for (const rule of SCENARIO_RULES) {
    it(`${rule.scenario} builds and validates without throwing`, () => {
      const plan = planFromForm(defaultValues(rule.scenario));
      expect(plan.scenario).toBe(rule.scenario);
      const built = buildSddcSpec(plan);
      expect(built.spec.workflowType).toBe(rule.workflowType);
      validateSddcSpec(built.spec, { secondaryInstance: plan.instanceRole === 'secondary' });
      expect(specSummary(built.spec).length).toBeGreaterThan(0);
    });

    it(`${rule.scenario} builds with every option set`, () => {
      const values = {
        ...defaultValues(rule.scenario),
        sizePreset: 'ha-medium',
        documentShape: 'full',
        skipGatewayPingValidation: true,
        autoGeneratePasswords: true,
        includeFleetServiceSpecs: false,
        size_sddcLcm: 'small',
        ver_vcenter: '9.1.1.0',
        fqdn_vcenter: 'VC-A.corp.example',
        vcenterSsoDomain: 'corp.local',
        identityBrokerModel: 'instance',
        identityBrokerSize: 'medium',
        automationNodePrefix: 'Auto-Node',
        automationInternalClusterCidr: '240.0.0.0/15',
        vspName: 'msr-a',
        existingVcenterFqdn: 'vc.corp.example',
        existingVcenterThumbprint: THUMB,
        existingOpsFqdn: 'ops.corp.example',
        existingOpsThumbprint: THUMB,
        existingSddcManagerFqdn: 'sddcm.corp.example',
        existingSddcManagerThumbprint: THUMB,
        password_opsAdmin: 'existing-admin-password',
        net_mgmt_portGroup: 'pg-mgmt',
        rootCaCerts: 'corp-ca | MIIBxyz, MIIBabc',
        resourcePools: 'rp-mgmt | management | high |  | 10 |  |  | true | normal |  | 20 |  |  | false',
      };
      const built = buildSddcSpec(planFromForm(values));
      validateSddcSpec(built.spec);
      expect(built.spec.sddcId).toBe('vcf-m01');
    });
  }

  it('a minimal document summarises without networkSpecs', () => {
    const built = buildSddcSpec(planFromForm(defaultValues('deferred-components')));
    expect(built.spec.networkSpecs).toBeUndefined();
    expect(built.spec.dnsSpec).toBeUndefined();
    expect(specSummary(built.spec)).toBe('Minimal document: no hosts, networks or DNS');
  });

  it('a full document summarises its hosts and networks', () => {
    const built = buildSddcSpec(planFromForm(defaultValues('new-vcf-fleet')));
    expect(specSummary(built.spec)).toBe(`4 hosts, ${built.spec.networkSpecs!.length} networks`);
  });
});

describe('Terraform from a minimal document', () => {
  for (const scenario of ['deferred-components', 'vvf-management-services'] as const) {
    it(`${scenario}: reports the missing dns and network blocks instead of throwing`, () => {
      const built = buildSddcSpec(planFromForm(defaultValues(scenario)));
      const out = emitTerraform(built.spec);
      const ids = out.findings.map((f) => f.code);
      expect(ids).toContain('vcf.terraform.no-dns');
      expect(ids).toContain('vcf.terraform.no-networks');
      expect(out.mainTf.includes('dns {')).toBe(false);
    });
  }
});

describe('scenarioView', () => {
  it('offers existing components only where the scenario can reuse them', () => {
    const fleet = scenarioView('new-vcf-fleet');
    expect(fleet.existing.vcenter).toBe(false);
    expect(fleet.existing.operations).toBe(false);
    expect(fleet.existing.automation).toBe(true);
    expect(fleet.existing.nsx).toBe(false);

    const instance = scenarioView('new-vcf-instance');
    expect(instance.existing.operations).toBe(true);
    expect(instance.existing.licenseServer).toBe(true);
    expect(instance.existing.collector).toBe(true);
    expect(instance.existingOpsAdminPassword).toBe(true);
    expect(instance.licenseServerOptional).toBe(true);
    expect(instance.identityBrokerOptional).toBe(true);

    const converge = scenarioView('converge-to-vcf-fleet');
    expect(converge.existing.vcenter).toBe(true);
    expect(converge.existing.nsx).toBe(true);
    expect(converge.nsxMayExist).toBe(true);
    expect(converge.existing.managementServices).toBe(true);

    const deferred = scenarioView('deferred-components');
    expect(deferred.existing.sddcManager).toBe(true);
    expect(deferred.nsx).toBe(false);
    expect(deferred.defaultShape).toBe('minimal');

    const vvf = scenarioView('new-vvf');
    expect(vvf.automation).toBe(false);
    expect(vvf.existing.nsx).toBe(false);
    expect(vvf.existing.vcenter).toBe(false);
    expect(scenarioView('new-vvf', true).existing.vcenter).toBe(true);

    const vvfServices = scenarioView('vvf-management-services');
    expect(vvfServices.existing.collector).toBe(false);
    expect(vvfServices.identityBroker).toBe(false);
  });
});

describe('planFromForm', () => {
  it('leaves every size to the preset unless one is chosen', () => {
    const plan = planFromForm({ ...FORM_DEFAULTS, sizePreset: 'ha-large' });
    expect(plan.sizePreset).toBe('ha-large');
    expect(plan.vcenterSize).toBeUndefined();
    expect(plan.nsxManagerSize).toBeUndefined();
    const built = buildSddcSpec(plan);
    expect(built.spec.vcenterSpec.vmSize).toBe('large');
    expect(built.spec.nsxtSpec?.nsxtManagers).toHaveLength(3);
    expect(built.spec.vcfOperationsCollectorSpec?.applianceSize).toBe('standard');

    const overridden = buildSddcSpec(planFromForm({ ...FORM_DEFAULTS, sizePreset: 'ha-large', vcenterSize: 'xlarge', nsxManagerCount: '1' })).spec;
    expect(overridden.vcenterSpec.vmSize).toBe('xlarge');
    expect(overridden.nsxtSpec?.nsxtManagers).toHaveLength(1);
  });

  it('an untouched page emits the sizes it always did', () => {
    const spec = buildSddcSpec(planFromForm(FORM_DEFAULTS)).spec;
    expect(spec.vcenterSpec.vmSize).toBe('small');
    expect(spec.nsxtSpec?.nsxtManagerSize).toBe('medium');
    expect(spec.vcenterSpec.adminUserSsoUsername).toBe('administrator@vsphere.local');
  });

  it('Ops node count and load balancer', () => {
    const plan = planFromForm({ ...FORM_DEFAULTS, opsNodeCount: '2', opsLoadBalancer: 'true', fqdn_opsLoadBalancer: 'ops-lb.vcf.lab' });
    expect(plan.opsNodeCount).toBe(2);
    expect(plan.opsLoadBalancer).toBe(true);
    const ops = buildSddcSpec(plan).spec.vcfOperationsSpec!;
    expect(ops.nodes).toHaveLength(2);
    expect(ops.loadBalancerFqdn).toBe('ops-lb.vcf.lab');
    expect(planFromForm(FORM_DEFAULTS).opsLoadBalancer).toBeUndefined();
  });

  it('secondary instance: the existing Ops master and its admin password', () => {
    const plan = planFromForm({
      ...defaultValues('new-vcf-instance'),
      existingOpsFqdn: 'ops.fleet.example',
      existingOpsThumbprint: THUMB,
      password_opsAdmin: 'fleet-admin',
      includeLicenseServer: false,
    });
    expect(plan.instanceRole).toBe('secondary');
    expect(plan.passwords?.opsAdmin).toBe('fleet-admin');
    expect(plan.includeLicenseServer).toBe(false);
    const spec = buildSddcSpec(plan).spec;
    expect(spec.vcfOperationsSpec?.nodes).toHaveLength(1);
    expect(spec.vcfOperationsSpec?.nodes[0]?.hostname).toBe('ops.fleet.example');
    expect(spec.vcfOperationsSpec?.adminUserPassword).toBe('fleet-admin');
    expect(spec.licenseServerSpec).toBeUndefined();
  });

  it('includeLicenseServer only where the License Server is conditional', () => {
    expect(planFromForm({ ...FORM_DEFAULTS, includeLicenseServer: false }).includeLicenseServer).toBeUndefined();
    expect(planFromForm({ ...defaultValues('converge-to-vvf'), includeLicenseServer: false }).includeLicenseServer).toBe(false);
  });

  it('existing components hidden by the scenario never reach the plan', () => {
    const values = {
      ...FORM_DEFAULTS,
      existingOpsFqdn: 'ops.example',
      existingNsxFqdn: 'nsx.example',
      existingAutomationFqdn: 'auto.example',
      existingAutomationThumbprint: THUMB,
    };
    const existing = existingFrom(values)?.existing;
    expect(existing?.operations).toBeUndefined();
    expect(existing?.nsx).toBeUndefined();
    expect(existing?.automation?.fqdn).toBe('auto.example');
  });

  it('existing NSX with node FQDNs, License Server, cloud proxy and management services on converge', () => {
    const values = {
      ...defaultValues('converge-to-vcf-fleet'),
      existingVcenterFqdn: 'vc.example',
      existingVcenterThumbprint: THUMB,
      existingNsxFqdn: 'nsx.example',
      existingNsxThumbprint: THUMB,
      existingNsxNodes: 'nsx-a.example, nsx-b.example, nsx-c.example',
      existingLicenseFqdn: 'lic.example',
      existingLicenseThumbprint: THUMB,
      existingOpsFqdn: 'ops.example',
      existingOpsThumbprint: THUMB,
      existingCollectorFqdn: 'proxy.example',
      existingCollectorThumbprint: THUMB,
      existingVspFqdn: 'msr.example',
      existingVspThumbprint: THUMB,
      enableEdgeClusterSync: false,
    };
    const plan = planFromForm(values);
    expect(plan.existing?.nsx?.nodeFqdns).toEqual(['nsx-a.example', 'nsx-b.example', 'nsx-c.example']);
    expect(plan.enableEdgeClusterSync).toBe(false);
    const spec = buildSddcSpec(plan).spec;
    expect(spec.nsxtSpec?.nsxtManagers.map((m) => m.hostname)).toEqual(['nsx-a.example', 'nsx-b.example', 'nsx-c.example']);
    expect(spec.nsxtSpec?.enableEdgeClusterSync).toBe(false);
    expect(spec.licenseServerSpec?.useExistingDeployment).toBe(true);
    expect(spec.vcfOperationsCollectorSpec?.hostname).toBe('proxy.example');
    expect(spec.vspClusterSpec?.useExistingDeployment).toBe(true);
    // Edge sync is not sent when no existing NSX is named.
    expect(planFromForm({ ...values, existingNsxFqdn: '' }).enableEdgeClusterSync).toBeUndefined();
  });

  it('the NFS network is planned when NFS is the storage', () => {
    const plan = planFromForm({ ...FORM_DEFAULTS, storage: 'nfs', nfsServers: '10.0.0.5', nfsCidr: '172.30.90.0/24', nfsVlan: '95' });
    expect(plan.nfs).toEqual({ cidr: '172.30.90.0/24', vlanId: 95, ipv6Cidr: undefined, ipv6Gateway: undefined });
    const nfs = buildSddcSpec(plan).spec.networkSpecs!.find((n) => n.networkType === 'NFS');
    expect(nfs?.vlanId).toBe(95);
    expect(planFromForm({ ...FORM_DEFAULTS, nfsCidr: '172.30.90.0/24' }).nfs).toBeUndefined();
  });

  it('per-network advanced settings reach the network', () => {
    const values = {
      ...FORM_DEFAULTS,
      net_vmotion_portGroup: 'pg-vmo',
      net_vmotion_ranges: '172.30.40.20-172.30.40.29, 172.30.40.40',
      net_vmotion_addresses: '172.30.40.50',
      net_vmotion_teaming: 'failover_explicit',
      net_vmotion_active: 'uplink1',
      net_vmotion_standby: 'uplink2',
      net_vmotion_mtu: '8900',
      net_vmotion_gateway: '172.30.40.254',
      net_vmotion_assignment: 'DHCP',
    };
    expect(networkAdvanced(values, 'mgmt')).toEqual({});
    const vmotion = buildSddcSpec(planFromForm(values)).spec.networkSpecs!.find((n) => n.networkType === 'VMOTION')!;
    expect(vmotion.portGroupKey).toBe('pg-vmo');
    expect(vmotion.includeIpAddressRanges).toEqual([
      { startIpAddress: '172.30.40.20', endIpAddress: '172.30.40.29' },
      { startIpAddress: '172.30.40.40', endIpAddress: '172.30.40.40' },
    ]);
    expect(vmotion.includeIpAddress).toEqual(['172.30.40.50']);
    expect(vmotion.teamingPolicy).toBe('failover_explicit');
    expect(vmotion.standbyUplinks).toEqual(['uplink2']);
    expect(vmotion.mtu).toBe(8900);
    expect(vmotion.gateway).toBe('172.30.40.254');
    expect(vmotion.ipAddressAssignmentMode).toBe('DHCP');
  });

  it('a VM management port group alone applies on the management addressing', () => {
    const plan = planFromForm({ ...FORM_DEFAULTS, net_vmMgmt_portGroup: 'existing-vm-pg' });
    expect(plan.vmManagement?.cidr).toBe('172.30.0.0/24');
    expect(plan.vmManagement?.portGroupName).toBe('existing-vm-pg');
    expect(planFromForm(FORM_DEFAULTS).vmManagement).toBeUndefined();
  });

  it('IP pools: untouched controls keep what sizing supplied', () => {
    const inherited = { vcfmsPool: { count: 40 } };
    expect(planFromForm(FORM_DEFAULTS, [], inherited).vcfmsPool).toEqual({ count: 40 });
    expect(planFromForm({ ...FORM_DEFAULTS, pool_vcfms_mode: 'addresses', pool_vcfms_addresses: '172.30.0.50, 172.30.0.51' }, [], inherited).vcfmsPool).toEqual({
      count: 40,
      mode: 'addresses',
      addresses: ['172.30.0.50', '172.30.0.51'],
    });
    expect(planFromForm({ ...FORM_DEFAULTS, pool_tep_offset: '20' }).tepPool).toEqual({ mode: 'range', offset: 20 });
  });

  it('VPC modes', () => {
    expect(planFromForm(FORM_DEFAULTS).vpcNetworkConfigurationType).toBeUndefined();
    const distributed = planFromForm({ ...FORM_DEFAULTS, vpcMode: 'full-distributed' });
    expect(distributed.vpcNetworkConfigurationType).toBe('FULL_STACK_VPC');
    expect(distributed.dtgw?.vlan).toBe(70);
    const centralized = planFromForm({ ...FORM_DEFAULTS, vpcMode: 'full-centralized' });
    expect(centralized.vpcNetworkConfigurationType).toBe('FULL_STACK_VPC');
    expect(centralized.dtgw).toBeUndefined();
    const vlan = buildSddcSpec(planFromForm({ ...FORM_DEFAULTS, vpcMode: 'vlan-backed', version: '9.1.1.0' })).spec;
    expect(vlan.nsxtSpec?.vpcSpec?.vpcNetworkConfigurationType).toBe('VLAN_BACKED_VPC');
    expect(vlan.nsxtSpec?.overlayVtepSpec?.vtepType).toBe('NO_IP');
    expect(vlan.nsxtSpec?.ipAddressPoolSpec).toBeUndefined();
  });

  it('TEP modes, pool name and NSX flags', () => {
    const existingPool = buildSddcSpec(planFromForm({ ...FORM_DEFAULTS, tepMode: 'existing-pool', tepPoolName: 'tep-shared', ignoreUnavailableNsxtCluster: true })).spec;
    expect(existingPool.nsxtSpec?.ipAddressPoolSpec).toEqual({ name: 'tep-shared', ignoreUnavailableNsxtCluster: true });
    const dhcp = buildSddcSpec(planFromForm({ ...FORM_DEFAULTS, tepMode: 'dhcp', tepPoolName: 'ignored' })).spec;
    expect(dhcp.nsxtSpec?.ipAddressPoolSpec).toBeUndefined();
    expect(planFromForm(FORM_DEFAULTS).skipNsxOverlayOverManagementNetwork).toBeUndefined();
    expect(planFromForm({ ...FORM_DEFAULTS, skipNsxOverlayOverManagementNetwork: 'true' }).skipNsxOverlayOverManagementNetwork).toBe(true);
  });

  it('LACP with every parameter, NSX teaming and host switch mode', () => {
    const plan = planFromForm({
      ...FORM_DEFAULTS,
      enableLacp: true,
      lacpName: 'lag-a',
      lacpUplinksCount: '4',
      lacpMode: 'PASSIVE',
      lacpTimeoutMode: 'SLOW',
      lacpLoadBalancingMode: 'SOURCE_PORT_ID',
      nsxTeamingPolicy: 'FAILOVER_ORDER',
      nsxActiveUplinks: 'uplink1',
      nsxStandbyUplinks: 'uplink2',
      hostSwitchOperationalMode: 'ENS',
    });
    const dvs = buildSddcSpec(plan).spec.dvsSpecs![0]!;
    expect(dvs.lagSpecs).toEqual([{ name: 'lag-a', uplinksCount: 4, lacpMode: 'PASSIVE', lacpTimeoutMode: 'SLOW', loadBalancingMode: 'SOURCE_PORT_ID' }]);
    expect(dvs.nsxTeamings).toEqual([{ policy: 'FAILOVER_ORDER', activeUplinks: ['uplink1'], standByUplinks: ['uplink2'] }]);
    expect(dvs.nsxtSwitchConfig?.hostSwitchOperationalMode).toBe('ENS');
  });

  it('custom switches from the grid', () => {
    const plan = planFromForm({
      ...FORM_DEFAULTS,
      dvsProfile: 'custom',
      dvsSwitches: [
        'sw-a | MANAGEMENT, VM_MANAGEMENT, VMOTION | vmnic0:uplink1, vmnic1:uplink2 | 1500 | no |  |  |  |  |  |  | ',
        'sw-b | VSAN | vmnic2, vmnic3 |  | yes | ov:OVERLAY, vl:VLAN | ENS_INTERRUPT | DHCP | FAILOVER_ORDER | uplink1 | uplink2 | yes',
      ].join('\n'),
    });
    expect(plan.dvsSwitches).toHaveLength(2);
    const [a, b] = buildSddcSpec(plan).spec.dvsSpecs!;
    expect(a?.dvsName).toBe('sw-a');
    expect(a?.mtu).toBe(1500);
    expect(a?.nsxtSwitchConfig).toBeUndefined();
    expect(b?.vmnicsToUplinks).toEqual([{ id: 'vmnic2', uplink: 'uplink1' }, { id: 'vmnic3', uplink: 'uplink2' }]);
    expect(b?.nsxtSwitchConfig).toEqual({
      transportZones: [{ name: 'ov', transportType: 'OVERLAY' }, { name: 'vl', transportType: 'VLAN' }],
      hostSwitchOperationalMode: 'ENS_INTERRUPT',
      ipAssignmentType: 'DHCP',
    });
    expect(b?.nsxTeamings?.[0]?.policy).toBe('FAILOVER_ORDER');
    expect(b?.lagSpecs).toHaveLength(1);
    // The grid is ignored for a predefined profile.
    expect(planFromForm({ ...FORM_DEFAULTS, dvsSwitches: 'x | | vmnic0 | | no | | | | | | | ' }).dvsSwitches).toBeUndefined();
  });

  it('FQDN overrides, versions, service sizes, SSO and identity broker', () => {
    const plan = planFromForm({
      ...FORM_DEFAULTS,
      fqdn_vcenter: 'VC-Custom.vcf.lab',
      ver_nsx: '9.1.1.0',
      size_fleetDepot: 'medium',
      vcenterSsoDomain: 'corp.local',
      vcenterSsoUsername: 'admin@corp.local',
      vcenterStorageSize: 'xlstorage',
      collectorSize: 'standard',
    });
    const spec = buildSddcSpec(plan).spec;
    expect(spec.vcenterSpec.vcenterHostname).toBe('vc-custom.vcf.lab');
    expect(spec.vcenterSpec.ssoDomain).toBe('corp.local');
    expect(spec.vcenterSpec.adminUserSsoUsername).toBe('admin@corp.local');
    expect(spec.vcenterSpec.storageSize).toBe('xlstorage');
    expect(spec.nsxtSpec?.version).toBe('9.1.1.0');
    expect(spec.fleetDepotSpec?.size).toBe('medium');
    expect(spec.vcfOperationsCollectorSpec?.applianceSize).toBe('standard');
  });

  it('the identity broker model is offered only where the broker is optional', () => {
    // Mandatory for a new fleet, so the model is not the page's to choose.
    expect(planFromForm({ ...FORM_DEFAULTS, identityBrokerModel: 'embedded' }).identityBrokerModel).toBeUndefined();
    const plan = planFromForm({ ...defaultValues('new-vcf-instance'), identityBrokerModel: 'embedded', identityBrokerSize: 'large' });
    expect(plan.identityBrokerModel).toBe('embedded');
    expect(buildSddcSpec(plan).spec.vidbSpec).toBeUndefined();
    const instance = buildSddcSpec(planFromForm({ ...FORM_DEFAULTS, identityBrokerSize: 'large' })).spec;
    expect(instance.vidbSpec?.size).toBe('large');
  });

  it('auto-generated passwords leave the generatable ones blank', () => {
    const spec = buildSddcSpec(planFromForm({ ...FORM_DEFAULTS, autoGeneratePasswords: true })).spec;
    expect(spec.vcenterSpec.rootVcenterPassword).toBe('');
    expect(spec.nsxtSpec?.nsxtAdminPassword).toBe('');
    expect(spec.hostSpecs![0]?.credentials?.password).toBe('<REQUIRED>');
  });

  it('root CA certificates and resource pools from their grids', () => {
    const spec = buildSddcSpec(
      planFromForm({
        ...FORM_DEFAULTS,
        esxiCertsMode: 'Custom',
        rootCaCerts: 'corp-root | MIIBroot, MIIBinter',
        resourcePools: 'rp-a | compute | custom | 4000 |  | 1000 |  | true |  |  |  | 2048 |  | ',
      }),
    ).spec;
    expect(spec.securitySpec?.rootCaCerts).toEqual([{ alias: 'corp-root', certChain: ['MIIBroot', 'MIIBinter'] }]);
    expect(spec.clusterSpec?.resourcePoolSpecs).toEqual([
      { name: 'rp-a', type: 'compute', cpuSharesLevel: 'custom', cpuSharesValue: 4000, cpuReservationMhz: 1000, cpuReservationExpandable: true, memoryReservationMb: 2048 },
    ]);
  });

  it('the overlay or port group name reaches xRegionNetwork on any model', () => {
    const spec = buildSddcSpec(
      planFromForm({ ...FORM_DEFAULTS, managementNetworkModel: 'dedicated-vlan', overlaySegment: 'pg-fleet-existing', overlayMask: '255.255.255.0', overlayGateway: '172.30.80.1' }),
    ).spec;
    expect(spec.vcfManagementComponentsInfrastructureSpec?.xRegionNetwork?.networkName).toBe('pg-fleet-existing');
  });
});

describe('parsers', () => {
  it('parseIpRanges', () => {
    expect(parseIpRanges('')).toEqual([]);
    expect(parseIpRanges('10.0.0.1 - 10.0.0.9')).toEqual([{ startIpAddress: '10.0.0.1', endIpAddress: '10.0.0.9' }]);
  });
  it('parseVmnicMapping', () => {
    expect(parseVmnicMapping('vmnic0, vmnic1')).toEqual(['vmnic0', 'vmnic1']);
    expect(parseVmnicMapping('vmnic4:uplink2')).toEqual([{ id: 'vmnic4', uplink: 'uplink2' }]);
  });
  it('parseTransportZones', () => {
    expect(parseTransportZones('VLAN, tz-o:overlay')).toEqual([{ transportType: 'VLAN' }, { name: 'tz-o', transportType: 'OVERLAY' }]);
  });
  it('parseDvsSwitches skips blank rows and comments', () => {
    expect(parseDvsSwitches('# comment\n\n', {})).toEqual([]);
  });
  it('parseRootCaCerts and parseResourcePools skip blank rows', () => {
    expect(parseRootCaCerts(' | ')).toEqual([]);
    expect(parseResourcePools('')).toEqual([]);
  });
  it('grid hints name one column per dropdown group', () => {
    for (const grid of [DVS_SWITCH_GRID, RESOURCE_POOL_GRID]) {
      const columns = grid.hint.split(' | ');
      for (const option of grid.options) expect(columns).toContain(option.group);
    }
  });
});

describe('settings', () => {
  it('secrets are never pre-filled and never saved', () => {
    for (const [key, value] of Object.entries(FORM_DEFAULTS)) {
      if (isSecretControl(key)) expect(value).toBe('');
    }
    expect(isSecretControl('password_opsAdmin')).toBe(true);
    expect(isSecretControl('esxRootPassword')).toBe(true);
    expect(isSecretControl('existingOpsThumbprint')).toBe(false);
  });
  it('an old file with enableVpc becomes the VPC mode', () => {
    expect(migrateFields({ enableVpc: true })).toEqual({ vpcMode: 'full-distributed' });
    expect(migrateFields({ enableVpc: false })).toEqual({ vpcMode: '' });
  });
});
