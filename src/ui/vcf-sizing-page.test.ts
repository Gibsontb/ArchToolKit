/**
 * The VCF sizing page's input assembly (src/ui/vcf-sizing-form.ts), tested
 * without a DOM: the page reads its controls into a record of strings and hands
 * it to `planFromForm` / `sizeFromForm`, so a record built from
 * SIZING_FORM_DEFAULTS is exactly what an untouched page builds.
 *
 * No assertion depends on a specific footprint number: those belong to the
 * engine's tests and its data.
 */
import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  SIZING_FORM_DEFAULTS,
  TOPOLOGY_OPTIONS,
  INSTANCE_GRID,
  WORKLOAD_DOMAIN_GRID,
  WORKLOAD_CLUSTER_GRID,
  ESTATE_EXTRAS_DEFAULTS,
  gridRows,
  parseInstances,
  parseWorkloadDomains,
  parseWorkloadClusters,
  planFromForm,
  sizeFromForm,
  formFromSizingInput,
  workloadDomainsToGrid,
  estateOptions,
  managementLines,
  type FormValues,
} from './vcf-sizing-form.ts';
import { sizeDeployment, type HostSpec, type SizingInput } from '../vcf/sizing.ts';
import { sizingToPlan, describeSizingHandoff } from '../vcf/bridge.ts';
import { planEstate, type EstatePlan } from '../vcf/estate-plan.ts';
import { emptyInventory, type Inventory, type InventoryHost, type InventoryVm } from '../vmware/inventory.ts';

const HOST: HostSpec = { cpuSockets: 2, coresPerCpu: 32, hyperthreading: true, ramGib: 1024, rawStorageGib: 15360 };

/** Every option on. */
const FULL: FormValues = {
  ...SIZING_FORM_DEFAULTS,
  version: '9.1.1',
  profile: 'ha-medium',
  topology: 'stretched',
  storage: 'vsan-osa',
  hostCount: '8',
  hostFailures: '2',
  nicSpeedGbps: '25',
  loadBalancer: 'true',
  workloadVcpu: '64',
  workloadRamGib: '256',
  workloadCapacityGib: '2048',
  includeEdge: 'true',
  edgeSize: 'large',
  edgeNodeCount: '2',
  includeAutomation: 'true',
  automationSize: 'medium',
  automationNodes: '3',
  osaPolicy: 'raid1-ftt1',
  dedupRatio: '1.5',
  operationsReservePct: '10',
  reserveAzFailure: 'true',
  interAzBandwidthGbps: '25',
  interAzRttMs: '2',
  witnessSize: 'large',
  tiering: 'true',
  tieringRatio: '1',
  tieringActivePct: '40',
  growthCpuPct: '10',
  growthRamPct: '10',
  growthStoragePct: '20',
  growthYears: '3',
  instances: 'site-b |  | ha-small |  | standard\nsite-c | 4 |  | nfs | ',
  workloadDomains:
    'wld01 |  | 4 | 400 |  | dedicated | large | 3 | large | 2 | 1 | small | 3\n' +
    'wld02 | site-b | 3 | 100 | small | shared |  |  |  |  |  |  | ',
  workloadClusters:
    'wld01-c1 | wld01 | 200 | 1024 | 4096 |  | vsan-esa | stretched |  |  |  |  |  | \n' +
    'solo | | 100 | 512 | 1024 | 4 | vsan-osa | | 5 | 2 | 2 | 24 | 768 | 20000',
  addLog: 'true',
  logReplicaSize: 'medium',
  logEps: '50000',
  logDailyGib: '100',
  logRetentionDays: '30',
  logNPlusOne: 'true',
  addRtm: 'true',
  addOpsNet: 'true',
  opsNetVms: '12000',
  opsNetCollectors: '2',
  opsNetCollectorSize: 'large',
  addDepot: 'true',
  addIdentityBroker: 'true',
  addAvi: 'true',
  aviSize: 'medium',
  aviNodes: '3',
  addPr: 'true',
  prProtectedVms: '6000',
  prScaleOut: '1',
  addHcx: 'true',
  hcxSitePairs: '2',
  hcxNetworkExtensions: '2',
  hcxWanOpt: 'true',
  hcxSgw: 'true',
  addOpsScale: 'true',
  opsDataNodes: '2',
  opsDataNodeSize: 'large',
  opsCloudProxies: '2',
  opsCloudProxySize: 'standard',
  vcfEdge: 'true',
  edgeSites: '12',
  subscriptionYears: '3',
  dr: 'true',
  drVcpu: '400',
  drRamGib: '2048',
  drStorageGib: '8192',
  drVms: '6000',
  drReservePct: '50',
  drStorage: 'vsan-esa',
  drHostFailures: '1',
};

describe('the page builds through the engine', () => {
  it('the default form sizes without throwing', () => {
    const o = sizeFromForm(SIZING_FORM_DEFAULTS);
    expect(o.fleet.instances).toHaveLength(1);
    expect(o.result.role).toBe('first');
    expect(o.result.hostMinimum.hosts).toBeGreaterThan(0);
    expect(o.growth).toHaveLength(0);
    expect(o.clusters).toHaveLength(0);
    expect(o.recovery).toBeUndefined();
    expect(o.licensing.items).toHaveLength(1);
  });

  it('the default form is what the engine sizes directly', () => {
    const plan = planFromForm(SIZING_FORM_DEFAULTS);
    const direct = sizeDeployment(plan.primary);
    const o = sizeFromForm(SIZING_FORM_DEFAULTS);
    expect(o.result.totalDemand).toEqual(direct.totalDemand);
    expect(o.result.hostMinimum).toEqual(direct.hostMinimum);
  });

  it('a fully loaded form sizes without throwing', () => {
    const o = sizeFromForm(FULL);
    expect(o.fleet.instances).toHaveLength(3);
    expect(o.fleet.instances[1]?.role).toBe('additional');
    expect(o.growth).toHaveLength(4);
    expect(o.clusters).toHaveLength(1);
    expect(o.recovery).toBeDefined();
    expect(o.result.witness).toBeDefined();
    expect(o.result.dramUtilization).toBeDefined();
    expect(o.result.workloadDomains).toHaveLength(1);
    expect(o.result.workloadDomains[0]?.clusters).toHaveLength(1);
    expect(o.fleet.instances[1]?.workloadDomains).toHaveLength(1);
    expect(o.licensing.coreYears).toBeDefined();
    // Every license item: 3 management domains, 1 domain cluster, 1 solo cluster, the recovery site.
    expect(o.licenseItems).toHaveLength(6);
  });

  it('the handoff to the spec builder still builds from the first instance', () => {
    const o = sizeFromForm(FULL);
    const plan = sizingToPlan(o.result);
    expect(plan.hostCount).toBe(8);
    expect(plan.storage).toBe('vsan-osa');
    expect(plan.profile).toBe('ha');
    expect(describeSizingHandoff(o.result)).toContain('8 hosts');
  });

  it('management lines leave the tenant workloads out', () => {
    const o = sizeFromForm(FULL);
    expect(o.result.components.some((c) => c.name === 'Tenant workloads')).toBe(true);
    expect(managementLines(o.result).some((c) => c.name === 'Tenant workloads')).toBe(false);
  });
});

describe('planFromForm', () => {
  it('maps every option into the engine input', () => {
    const { primary, fleet, workloadClusters, recovery } = planFromForm(FULL);
    expect(primary.version).toBe('9.1.1');
    expect(primary.instanceCount).toBe(3);
    expect(primary.hostFailuresToTolerate).toBe(2);
    expect(primary.nicSpeedGbps).toBe(25);
    expect(primary.loadBalancer).toBe(true);
    expect(primary.automationSize).toBe('medium');
    expect(primary.automationNodes).toBe(3);
    expect(primary.vsan).toEqual({ osaPolicy: 'raid1-ftt1', dedupRatio: 1.5, operationsReserve: 0.1 });
    expect(primary.stretched).toEqual({ reserveAzFailure: true, interAzBandwidthGbps: 25, interAzRttMs: 2, witnessSize: 'large' });
    expect(primary.memoryTiering?.enabled).toBe(true);
    expect(primary.memoryTiering?.activeMemoryFraction).toBe(0.4);
    expect(primary.growth).toEqual({ cpuPct: 10, ramPct: 10, storagePct: 20, years: 3 });
    expect(primary.addOns?.logManagement?.replicaSize).toBe('medium');
    expect(primary.addOns?.logManagement?.nPlusOne).toBe(true);
    expect(primary.addOns?.realTimeMetrics).toBe(true);
    expect(primary.addOns?.operationsForNetworks?.vms).toBe(12000);
    expect(primary.addOns?.operationsForNetworks?.collectors).toBe(2);
    expect(primary.addOns?.operationsForNetworks?.collectorSize).toBe('large');
    expect(primary.addOns?.softwareDepot).toBeUndefined();
    expect(fleet.instances[1]?.addOns).toEqual({ softwareDepot: true, identityBroker: true });
    expect(primary.addOns?.avi).toEqual({ size: 'medium', nodes: 3 });
    expect(primary.addOns?.protectionRecovery).toEqual({ protectedVms: 6000, scaleOutAppliances: 1 });
    expect(primary.addOns?.hcx).toEqual({ sitePairs: 2, networkExtensions: 2, wanOptimization: true, sentinelGateway: true });
    expect(primary.addOns?.operationsScaleOut).toEqual({ dataNodes: 2, dataNodeSize: 'large', cloudProxies: 2, cloudProxySize: 'standard' });
    expect(primary.vcfEdge).toBe(true);
    expect(primary.edgeSites).toBe(12);
    expect(primary.subscriptionYears).toBe(3);
    expect(fleet.subscriptionYears).toBe(3);
    expect(fleet.vcfEdge).toBe(true);
    expect(workloadClusters).toHaveLength(1);
    expect(workloadClusters[0]?.host.coresPerCpu).toBe(24);
    expect(workloadClusters[0]?.hostFailures).toBe(2);
    expect(recovery?.reserveFraction).toBe(0.5);
    expect(recovery?.protectedVms).toBe(6000);
  });

  it('the default form carries no optional blocks', () => {
    const { primary, fleet, recovery } = planFromForm(SIZING_FORM_DEFAULTS);
    expect(primary.vsan).toBeUndefined();
    expect(primary.stretched).toBeUndefined();
    expect(primary.memoryTiering).toBeUndefined();
    expect(primary.growth).toBeUndefined();
    expect(primary.addOns).toBeUndefined();
    expect(primary.workloadDomains).toBeUndefined();
    expect(primary.automationSize).toBeUndefined();
    expect(primary.hostFailuresToTolerate).toBe(1);
    expect(fleet.instances).toHaveLength(1);
    expect(recovery).toBeUndefined();
  });

  it('the OSA policy is ignored for ESA, and stretched options for a standard cluster', () => {
    const { primary } = planFromForm({ ...SIZING_FORM_DEFAULTS, osaPolicy: 'raid5-ftt1', interAzRttMs: '9' });
    expect(primary.vsan).toBeUndefined();
    expect(primary.stretched).toBeUndefined();
  });

  it('additional instances follow the first unless a row overrides them', () => {
    const { fleet } = planFromForm(FULL);
    const [first, b, c] = fleet.instances;
    expect(b?.instanceRole).toBe('additional');
    expect(b?.profile).toBe('ha-small');
    expect(b?.topology).toBe('standard');
    expect(b?.storage).toBe(first?.storage);
    expect(b?.hostCount).toBeGreaterThan(0);
    expect(c?.hostCount).toBe(4);
    expect(c?.storage).toBe('nfs');
    expect(c?.profile).toBe(first?.profile);
    // Only the per-instance services; the first instance’s add-ons stay with it.
    expect(c?.addOns).toEqual({ softwareDepot: true, identityBroker: true });
  });

  it('a workload domain naming an unknown instance lands on the first, with a note', () => {
    const plan = planFromForm({ ...SIZING_FORM_DEFAULTS, workloadDomains: 'wldx | nowhere | 3 | 10 |  | dedicated |  |  |  |  |  |  | ' });
    expect(plan.primary.workloadDomains).toHaveLength(1);
    expect(plan.notes.some((n) => n.code === 'sizing.page.domain-instance-unknown')).toBe(true);
  });

  it('a cluster naming an unknown domain is sized on its own, with a note', () => {
    const plan = planFromForm({ ...SIZING_FORM_DEFAULTS, workloadClusters: 'x | ghost | 10 | 10 | 10 |  |  |  |  |  |  |  |  | ' });
    expect(plan.workloadClusters).toHaveLength(1);
    expect(plan.notes.some((n) => n.code === 'sizing.page.cluster-domain-unknown')).toBe(true);
  });

  it('two-node is not a management topology on the page', () => {
    expect(TOPOLOGY_OPTIONS.some((o) => o.value === 'two-node')).toBe(false);
    const { primary } = planFromForm({ ...SIZING_FORM_DEFAULTS, topology: 'two-node' });
    expect(primary.topology).toBe('standard');
  });

  it('out-of-range numbers are clamped and junk falls back to defaults', () => {
    const { primary } = planFromForm({ ...SIZING_FORM_DEFAULTS, hostCount: '999', cpuSockets: 'abc', hostFailures: '7' });
    expect(primary.hostCount).toBe(64);
    expect(primary.host.cpuSockets).toBe(2);
    expect(primary.hostFailuresToTolerate).toBe(1);
  });
});

describe('grids', () => {
  it('column counts match their hints', () => {
    expect(INSTANCE_GRID.hint.split(' | ')).toHaveLength(5);
    expect(WORKLOAD_DOMAIN_GRID.hint.split(' | ')).toHaveLength(13);
    expect(WORKLOAD_CLUSTER_GRID.hint.split(' | ')).toHaveLength(14);
  });

  it('every dropdown group names a column', () => {
    for (const spec of [INSTANCE_GRID, WORKLOAD_DOMAIN_GRID, WORKLOAD_CLUSTER_GRID]) {
      const columns = spec.hint.split(' | ');
      for (const o of spec.options) expect(columns).toContain(o.group);
    }
  });

  it('rows skip blanks and comments and pad short rows', () => {
    expect(gridRows('# note\n\na | b\n |  \nc', 3)).toEqual([
      ['a', 'b', ''],
      ['c', '', ''],
    ]);
  });

  it('parses instances', () => {
    const rows = parseInstances('dr | 5 | ha-large | vmfs-fc | stretched\n | | junk | | ');
    expect(rows[0]).toEqual({ name: 'dr', hosts: 5, profile: 'ha-large', storage: 'vmfs-fc', topology: 'stretched' });
    // A row with no name is still an instance; a value no dropdown offers is dropped.
    expect(rows[1]).toEqual({ name: 'instance 3' });
  });

  it('parses workload domains with edge cluster and Supervisor', () => {
    const [row] = parseWorkloadDomains('w1 | 2 | 6 | 500 | medium | shared | large | 1 | xlarge | 4 | 2 | medium | 1');
    expect(row?.instance).toBe('2');
    expect(row?.domain).toEqual({
      name: 'w1',
      hosts: 6,
      vms: 500,
      vcenterSize: 'medium',
      nsx: 'shared',
      nsxSize: 'large',
      nsxNodes: 1,
      edgeCluster: { size: 'xlarge', nodes: 4 },
      supervisor: { count: 2, size: 'medium', controlPlaneVms: 1 },
    });
  });

  it('a workload domain with blanks takes the engine defaults', () => {
    const [row] = parseWorkloadDomains('w1 |  |  |  |  |  |  |  |  |  |  |  | ');
    expect(row?.domain).toEqual({ name: 'w1', nsx: 'dedicated' });
  });

  it('parses workload clusters, with blank host columns from the management host', () => {
    const [row] = parseWorkloadClusters('c | d | 10 | 20 | 30 |  |  |  |  |  |  |  |  | ', { host: HOST, storage: 'vsan-esa', version: '9.1.0' });
    expect(row?.domain).toBe('d');
    expect(row?.cluster.host).toEqual(HOST);
    expect(row?.cluster.storage).toBe('vsan-esa');
    expect(row?.cluster.hosts).toBeUndefined();
    expect(row?.cluster.version).toBe('9.1.0');
  });
});

describe('engine input to form', () => {
  const derived: SizingInput = {
    path: 'brownfield-converge',
    profile: 'ha-large',
    version: '9.1.0.400',
    instanceCount: 2,
    topology: 'standard',
    storage: 'nfs',
    hostCount: 6,
    host: { ...HOST, rawStorageGib: 0 },
    workloadVcpu: 120.4,
    hostFailuresToTolerate: 2,
    workloadDomains: [{ name: 'wld-a', hosts: 5, vms: 80, nsx: 'dedicated', nsxSize: 'large' }],
  };

  it('round-trips the fields the input carries', () => {
    const values = { ...SIZING_FORM_DEFAULTS, ...formFromSizingInput(derived) } as FormValues;
    const { primary } = planFromForm(values);
    expect(primary.path).toBe('brownfield-converge');
    expect(primary.profile).toBe('ha-large');
    expect(primary.version).toBe('9.1.0');
    expect(primary.storage).toBe('nfs');
    expect(primary.hostCount).toBe(6);
    expect(primary.workloadVcpu).toBe(120);
    expect(primary.hostFailuresToTolerate).toBe(2);
    expect(primary.instanceCount).toBe(2);
    expect(primary.workloadDomains?.[0]?.name).toBe('wld-a');
    expect(primary.workloadDomains?.[0]?.nsxSize).toBe('large');
  });

  it('keeps manual clusters when the input has none', () => {
    expect(formFromSizingInput(derived).workloadClusters).toBeUndefined();
  });

  it('maps the old reserve flag to host failures', () => {
    expect(formFromSizingInput({ ...derived, hostFailuresToTolerate: undefined, reserveHostFailure: false }).hostFailures).toBe('0');
  });

  it('workload domains serialize to rows the grid parses back', () => {
    const text = workloadDomainsToGrid([{ name: 'a', edgeCluster: { size: 'medium', nodes: 2 }, supervisor: { count: 1, size: 'tiny' } }]);
    const [row] = parseWorkloadDomains(text);
    expect(row?.domain.edgeCluster).toEqual({ size: 'medium', nodes: 2 });
    expect(row?.domain.supervisor?.size).toBe('tiny');
  });
});

describe('estate options', () => {
  const base = {
    selected: [] as string[],
    managementSource: 'new',
    host: HOST,
    cpuRatio: 4,
    memoryCeiling: 0.9,
    growth: 0.2,
    storageBasis: 'used',
    includePoweredOff: false,
    reserveHostFailure: true,
    workloadStorage: 'same-as-source',
    grouping: 'vcenter',
    maxHostsPerCluster: 64,
    vsanArchitecture: 'esa',
    clusterStorage: {},
    nsxPerDomain: 'dedicated',
    nsxManagerSize: 'medium',
    profile: 'simple',
    version: '9.1.1.0',
  } as unknown as EstatePlan['options'];

  it('adds the page’s options and the form’s profile, version and failures', () => {
    const o = estateOptions(
      base,
      { vsanArchitecture: 'osa', nsxPerDomain: 'shared', nsxManagerSize: 'large', clusterStorage: { k: 'nfs' } },
      { ...SIZING_FORM_DEFAULTS, profile: 'ha-medium', version: '9.1.0', hostFailures: '2' },
    );
    expect(o.vsanArchitecture).toBe('osa');
    expect(o.nsxPerDomain).toBe('shared');
    expect(o.nsxManagerSize).toBe('large');
    expect(o.clusterStorage).toEqual({ k: 'nfs' });
    expect(o.profile).toBe('ha-medium');
    expect(o.version).toBe('9.1.0');
    expect(o.hostFailures).toBe(2);
    // An empty scope in a finished plan meant nothing was selected.
    expect(o.selected).toEqual(['(none)']);
  });

  it('leaves the vSAN architecture unset when the page does', () => {
    const o = estateOptions(base, ESTATE_EXTRAS_DEFAULTS, SIZING_FORM_DEFAULTS);
    expect(o.vsanArchitecture).toBeUndefined();
  });
});

describe('the estate flow', () => {
  const host = (name: string, cluster: string, vcenter: string): InventoryHost => ({ name, cluster, vcenter, cpuSockets: 2, coresPerSocket: 32, totalCores: 64, threads: 128, memoryGib: 1024 });
  const vm = (name: string, cluster: string, vcenter: string): InventoryVm => ({ name, cluster, vcenter, powerState: 'poweredOn', vcpu: 8, memoryGib: 64, provisionedGib: 200, usedGib: 100 });
  const inventory: Inventory = {
    ...emptyInventory({ kind: 'rvtools', label: 'test' }),
    hosts: [...Array.from({ length: 6 }, (_, i) => host(`p${i}`, 'prod', 'vc-a.lab')), ...Array.from({ length: 3 }, (_, i) => host(`d${i}`, 'dev', 'vc-b.lab'))],
    vms: [...Array.from({ length: 60 }, (_, i) => vm(`pvm${i}`, 'prod', 'vc-a.lab')), ...Array.from({ length: 20 }, (_, i) => vm(`dvm${i}`, 'dev', 'vc-b.lab'))],
    datastores: [{ name: 'vsan-prod', type: 'vsan', capacityGib: 6 * 15360, freeGib: 50000, hosts: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], vcenter: 'vc-a.lab' }],
  };

  it('re-plans with the page’s options and fills a form that sizes', () => {
    const first = planEstate(inventory, { host: HOST, managementSource: 'new' });
    const values = { ...SIZING_FORM_DEFAULTS, profile: 'ha-medium', hostFailures: '2' };
    const plan = planEstate(
      inventory,
      estateOptions(first.options, { vsanArchitecture: 'osa', nsxPerDomain: 'shared', nsxManagerSize: 'large', clusterStorage: {} }, values),
    );
    expect(plan.management.profile).toBe('ha-medium');
    expect(plan.management.hostFailuresToTolerate).toBe(2);
    const form = { ...values, ...formFromSizingInput(plan.management) } as FormValues;
    const o = sizeFromForm(form);
    expect(o.result.workloadDomains.length).toBe(plan.management.workloadDomains?.length ?? 0);
    expect(o.result.workloadDomains.length).toBeGreaterThan(0);
  });
});
