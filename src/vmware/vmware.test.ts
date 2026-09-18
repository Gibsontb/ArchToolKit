import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { importRvTools, importRvToolsFiles, detectSheet } from './rvtools.ts';
import { computeTotals, rollupByCluster, mergeInventories, toSizingHostProfile } from './inventory.ts';
import { analyzeEstate, estimateLicensing, toSizingInput } from './analyze.ts';
import { sizeDeployment } from '../vcf/sizing.ts';

/**
 * Fixtures use the documented RVTools column headers, including the
 * inconsistent "# " prefixes and MiB units, so the importer is exercised
 * against the real shape rather than a tidied one.
 */
const V_HOST_CSV = `Host,Datacenter,Cluster,CPU Model,Speed,# CPU,Cores per CPU,# Cores,CPU usage %,# Memory,Memory usage %,#NICs,# vCPUs,vRAM,ESX Version,Vendor,Model,in Maintenance Mode
esx01.corp.local,DC1,Prod-Cluster,Intel Xeon Gold 6338,2000,2,32,64,42,1048576,71,4,180,786432,8.0.3,Dell Inc.,PowerEdge R750,False
esx02.corp.local,DC1,Prod-Cluster,Intel Xeon Gold 6338,2000,2,32,64,38,1048576,68,4,172,753664,8.0.3,Dell Inc.,PowerEdge R750,False
esx03.corp.local,DC1,Prod-Cluster,Intel Xeon Gold 6338,2000,2,32,64,45,1048576,74,4,190,802816,8.0.3,Dell Inc.,PowerEdge R750,False
esx04.corp.local,DC1,Prod-Cluster,Intel Xeon Gold 6338,2000,2,32,64,30,1048576,55,4,150,655360,8.0.3,Dell Inc.,PowerEdge R750,True
esx05.corp.local,DC1,Legacy-Cluster,Intel Xeon E5-2650 v4,2200,2,12,24,60,262144,80,2,90,196608,6.7.0,HP,ProLiant DL380 Gen9,False`;

const V_INFO_CSV = `VM,VM UUID,Powerstate,Host,Cluster,Datacenter,CPUs,Memory,Provisioned MiB,In Use MiB,OS according to the configuration file,HW version
app-web-01,564d1111-0000-0000-0000-000000000001,poweredOn,esx01.corp.local,Prod-Cluster,DC1,4,16384,204800,102400,Microsoft Windows Server 2019 (64-bit),vmx-19
app-web-02,564d1111-0000-0000-0000-000000000002,poweredOn,esx01.corp.local,Prod-Cluster,DC1,4,16384,204800,98304,Microsoft Windows Server 2019 (64-bit),vmx-19
app-db-01,564d1111-0000-0000-0000-000000000003,poweredOn,esx02.corp.local,Prod-Cluster,DC1,16,131072,1048576,838860,"Red Hat Enterprise Linux 8 (64-bit)",vmx-19
app-db-02,564d1111-0000-0000-0000-000000000004,poweredOff,esx02.corp.local,Prod-Cluster,DC1,16,131072,1048576,524288,"Red Hat Enterprise Linux 8 (64-bit)",vmx-19
legacy-app-01,564d1111-0000-0000-0000-000000000005,poweredOn,esx05.corp.local,Legacy-Cluster,DC1,2,8192,102400,81920,CentOS 7 (64-bit),vmx-13`;

const V_DATASTORE_CSV = `Name,Object ID,Type,Hosts,Capacity MiB,Provisioned MiB,In Use MiB
vsanDatastore,datastore-01,vsan,4,41943040,3145728,2097152
nfs-archive-01,datastore-02,NFS,5,10485760,9961472,9961472
vmfs-legacy-01,datastore-03,VMFS,1,2097152,1048576,1048576`;

const V_CLUSTER_CSV = `Name,Datacenter,NumHosts,HA enabled,DRS enabled,DRS default VM behavior,Current EVC Mode,VSAN enabled
Prod-Cluster,DC1,4,True,True,fullyAutomated,intel-skylake,True
Legacy-Cluster,DC1,1,False,True,partiallyAutomated,,False`;

function fullImport() {
  return importRvTools({
    sheets: {
      vHost: V_HOST_CSV,
      vInfo: V_INFO_CSV,
      vDatastore: V_DATASTORE_CSV,
      vCluster: V_CLUSTER_CSV,
    },
    label: 'test-estate',
  });
}

function codes(findings: readonly { code: string }[]): string[] {
  return findings.map((f) => f.code);
}

describe('detectSheet', () => {
  it('identifies vHost by its CPU columns', () => {
    expect(detectSheet(V_HOST_CSV)).toBe('vHost');
  });

  it('identifies vInfo by powerstate and provisioned capacity', () => {
    expect(detectSheet(V_INFO_CSV)).toBe('vInfo');
  });

  it('identifies vDatastore by its capacity columns', () => {
    expect(detectSheet(V_DATASTORE_CSV)).toBe('vDatastore');
  });

  it('identifies vCluster by its HA/DRS columns', () => {
    expect(detectSheet(V_CLUSTER_CSV)).toBe('vCluster');
  });

  it('returns null for something unrecognisable', () => {
    expect(detectSheet('foo,bar\n1,2')).toBeNull();
  });
});

describe('importRvTools — hosts', () => {
  it('imports every host row', () => {
    const { inventory } = fullImport();
    expect(inventory.hosts).toHaveLength(5);
  });

  it('converts memory from MiB to GiB', () => {
    const { inventory } = fullImport();
    const host = inventory.hosts.find((h) => h.name === 'esx01.corp.local');
    // 1,048,576 MiB = 1024 GiB
    expect(host?.memoryGib).toBe(1024);
  });

  it('reads socket and core counts', () => {
    const { inventory } = fullImport();
    const host = inventory.hosts[0];
    expect(host?.cpuSockets).toBe(2);
    expect(host?.coresPerSocket).toBe(32);
    expect(host?.totalCores).toBe(64);
  });

  it('converts usage percentages to fractions', () => {
    const { inventory } = fullImport();
    const host = inventory.hosts.find((h) => h.name === 'esx01.corp.local');
    expect(host?.cpuUsage).toBeCloseTo(0.42, 3);
    expect(host?.memoryUsage).toBeCloseTo(0.71, 3);
  });

  it('reads maintenance mode as a boolean', () => {
    const { inventory } = fullImport();
    expect(inventory.hosts.find((h) => h.name === 'esx04.corp.local')?.inMaintenanceMode).toBe(true);
    expect(inventory.hosts.find((h) => h.name === 'esx01.corp.local')?.inMaintenanceMode).toBe(false);
  });
});

describe('importRvTools — VMs', () => {
  it('imports every VM row', () => {
    const { inventory } = fullImport();
    expect(inventory.vms).toHaveLength(5);
  });

  it('normalises power state', () => {
    const { inventory } = fullImport();
    expect(inventory.vms.find((v) => v.name === 'app-web-01')?.powerState).toBe('poweredOn');
    expect(inventory.vms.find((v) => v.name === 'app-db-02')?.powerState).toBe('poweredOff');
  });

  it('converts VM memory and capacity to GiB', () => {
    const { inventory } = fullImport();
    const vm = inventory.vms.find((v) => v.name === 'app-db-01');
    expect(vm?.memoryGib).toBe(128);
    expect(vm?.provisionedGib).toBe(1024);
    expect(vm?.usedGib).toBeCloseTo(819.2, 1);
  });

  it('handles quoted guest OS fields containing commas', () => {
    const { inventory } = fullImport();
    const vm = inventory.vms.find((v) => v.name === 'app-db-01');
    expect(vm?.guestOs).toBe('Red Hat Enterprise Linux 8 (64-bit)');
  });
});

describe('importRvTools — datastores and clusters', () => {
  it('classifies datastore types', () => {
    const { inventory } = fullImport();
    expect(inventory.datastores.find((d) => d.name === 'vsanDatastore')?.type).toBe('vsan');
    expect(inventory.datastores.find((d) => d.name === 'nfs-archive-01')?.type).toBe('NFS');
    expect(inventory.datastores.find((d) => d.name === 'vmfs-legacy-01')?.type).toBe('VMFS');
  });

  it('derives free capacity from capacity minus in-use', () => {
    const { inventory } = fullImport();
    const vsan = inventory.datastores.find((d) => d.name === 'vsanDatastore');
    // 41,943,040 MiB capacity = 40960 GiB; 2,097,152 MiB used = 2048 GiB
    expect(vsan?.capacityGib).toBe(40960);
    expect(vsan?.freeGib).toBe(38912);
  });

  it('imports cluster flags', () => {
    const { inventory } = fullImport();
    const prod = inventory.clusters.find((c) => c.name === 'Prod-Cluster');
    expect(prod?.haEnabled).toBe(true);
    expect(prod?.vsanEnabled).toBe(true);
    expect(prod?.evcMode).toBe('intel-skylake');
  });
});

describe('importRvTools — findings', () => {
  it('always notes the point-in-time limitation', () => {
    const { findings } = fullImport();
    expect(codes(findings)).toContain('inventory.rvtools.point-in-time');
  });

  it('warns when VMs are imported without hosts', () => {
    const { findings } = importRvTools({ sheets: { vInfo: V_INFO_CSV } });
    expect(codes(findings)).toContain('inventory.rvtools.no-hosts');
  });

  it('warns when nothing at all was imported', () => {
    const { findings } = importRvTools({ sheets: {} });
    expect(codes(findings)).toContain('inventory.rvtools.no-data');
  });

  it('flags host rows with no core count', () => {
    const broken = `Host,Cluster,# CPU,Cores per CPU,# Cores,# Memory\nesx99,C1,,,,1048576`;
    const { findings } = importRvTools({ sheets: { vHost: broken } });
    expect(codes(findings)).toContain('inventory.rvtools.hosts-missing-cores');
  });
});

describe('importRvToolsFiles', () => {
  it('routes files by detected content, not filename', () => {
    const { inventory } = importRvToolsFiles([
      { name: 'export-a.csv', content: V_HOST_CSV },
      { name: 'export-b.csv', content: V_INFO_CSV },
    ]);
    expect(inventory.hosts).toHaveLength(5);
    expect(inventory.vms).toHaveLength(5);
  });

  it('reports files it cannot identify', () => {
    const { findings } = importRvToolsFiles([
      { name: 'good.csv', content: V_HOST_CSV },
      { name: 'mystery.csv', content: 'x,y\n1,2' },
    ]);
    expect(codes(findings)).toContain('inventory.rvtools.unrecognised-file');
  });
});

describe('computeTotals', () => {
  it('sums physical capacity across hosts', () => {
    const { inventory } = fullImport();
    const totals = computeTotals(inventory);
    // 4 x 64 cores + 1 x 24 cores
    expect(totals.physicalCores).toBe(280);
    expect(totals.hostCount).toBe(5);
  });

  it('counts only powered-on VMs toward allocation', () => {
    const { inventory } = fullImport();
    const totals = computeTotals(inventory);
    expect(totals.vmCount).toBe(5);
    expect(totals.poweredOnVmCount).toBe(4);
    // 4 + 4 + 16 + 2 = 26 vCPU, excluding the powered-off 16-vCPU VM.
    expect(totals.allocatedVcpu).toBe(26);
  });

  it('counts powered-off VMs toward provisioned storage', () => {
    const { inventory } = fullImport();
    const totals = computeTotals(inventory);
    // All five VMs' provisioned capacity, including the powered-off one.
    expect(totals.provisionedStorageGib).toBe(200 + 200 + 1024 + 1024 + 100);
  });

  it('measures the thin-provisioning gap', () => {
    const { inventory } = fullImport();
    const totals = computeTotals(inventory);
    expect(totals.thinProvisioningGib).toBeGreaterThan(0);
    expect(totals.usedStorageGib).toBeLessThan(totals.provisionedStorageGib);
  });

  it('computes overcommit ratios', () => {
    const { inventory } = fullImport();
    const totals = computeTotals(inventory);
    expect(totals.cpuOvercommit).toBeCloseTo(26 / 280, 4);
  });

  it('returns zeros rather than NaN for an empty inventory', () => {
    const { inventory } = importRvTools({ sheets: {} });
    const totals = computeTotals(inventory);
    expect(totals.cpuOvercommit).toBe(0);
    expect(totals.memoryOvercommit).toBe(0);
  });
});

describe('rollupByCluster', () => {
  it('groups hosts and VMs by cluster', () => {
    const { inventory } = fullImport();
    const clusters = rollupByCluster(inventory);
    const prod = clusters.find((c) => c.name === 'Prod-Cluster');
    expect(prod?.hostCount).toBe(4);
    expect(prod?.vmCount).toBe(4);
    expect(prod?.physicalCores).toBe(256);
  });

  it('sorts the largest cluster first', () => {
    const { inventory } = fullImport();
    expect(rollupByCluster(inventory)[0]?.name).toBe('Prod-Cluster');
  });

  it('lists distinct CPU models per cluster', () => {
    const { inventory } = fullImport();
    const legacy = rollupByCluster(inventory).find((c) => c.name === 'Legacy-Cluster');
    expect(legacy?.cpuModels).toEqual(['Intel Xeon E5-2650 v4']);
  });
});

describe('estimateLicensing', () => {
  it('applies the 16-core floor per CPU', () => {
    const { inventory } = fullImport();
    const licensing = estimateLicensing(inventory);
    // 4 hosts x 2 CPUs x 32 cores = 256 billed as-is.
    // 1 host x 2 CPUs x 12 cores = 24 physical, billed at 16 each = 32.
    expect(licensing.physicalCores).toBe(280);
    expect(licensing.billableCores).toBe(288);
    expect(licensing.floorPenaltyCores).toBe(8);
  });

  it('names the hosts below the floor', () => {
    const { inventory } = fullImport();
    const licensing = estimateLicensing(inventory);
    expect(licensing.hostsBelowFloor).toHaveLength(1);
    expect(licensing.hostsBelowFloor[0]?.name).toBe('esx05.corp.local');
    expect(licensing.hostsBelowFloor[0]?.wastedCores).toBe(8);
  });
});

describe('analyzeEstate', () => {
  it('flags ESX versions too old to converge into VCF 9.1', () => {
    const { inventory } = fullImport();
    const analysis = analyzeEstate(inventory);
    // esx05 runs 6.7.0.
    expect(codes(analysis.findings)).toContain('estate.vcf.esx-too-old');
  });

  it('flags hosts below the vSAN ESA memory floor', () => {
    const { inventory } = fullImport();
    // esx05 has 262,144 MiB = 256 GiB... above the 128 GiB floor, so build a
    // host that is genuinely below it.
    const lean = {
      ...inventory,
      hosts: inventory.hosts.map((h) =>
        h.name === 'esx05.corp.local' ? { ...h, memoryGib: 64 } : h,
      ),
    };
    expect(codes(analyzeEstate(lean).findings)).toContain('estate.vsan.esa-memory-floor');
  });

  it('flags datastores above 90% used', () => {
    const { inventory } = fullImport();
    // nfs-archive-01 is fully consumed.
    expect(codes(analyzeEstate(inventory).findings)).toContain('estate.storage.datastores-near-full');
  });

  it('notes hosts in maintenance mode', () => {
    const { inventory } = fullImport();
    expect(codes(analyzeEstate(inventory).findings)).toContain('estate.hosts.in-maintenance');
  });

  it('reports the licensing core floor penalty', () => {
    const { inventory } = fullImport();
    expect(codes(analyzeEstate(inventory).findings)).toContain('estate.licensing.core-floor');
  });

  it('warns about memory overcommit', () => {
    const { inventory } = fullImport();
    const overcommitted = {
      ...inventory,
      hosts: inventory.hosts.map((h) => ({ ...h, memoryGib: 8 })),
    };
    expect(codes(analyzeEstate(overcommitted).findings)).toContain('estate.memory.overcommitted');
  });

  it('flags mixed CPU models within a cluster', () => {
    const { inventory } = fullImport();
    const mixed = {
      ...inventory,
      hosts: inventory.hosts.map((h) =>
        h.name === 'esx02.corp.local' ? { ...h, cpuModel: 'AMD EPYC 7763' } : h,
      ),
    };
    expect(codes(analyzeEstate(mixed).findings)).toContain('estate.cluster.mixed-cpu-models');
  });
});

describe('toSizingHostProfile', () => {
  it('uses the smallest host rather than an average', () => {
    const { inventory } = fullImport();
    const profile = toSizingHostProfile(inventory);
    // esx05 is the weakest: 2 x 12 cores, 256 GiB.
    expect(profile?.coresPerCpu).toBe(12);
    expect(profile?.ramGib).toBe(256);
  });

  it('returns null for an empty inventory', () => {
    const { inventory } = importRvTools({ sheets: {} });
    expect(toSizingHostProfile(inventory)).toBeNull();
  });
});

describe('toSizingInput', () => {
  it('bridges an estate into a VCF sizing input', () => {
    const { inventory } = fullImport();
    const input = toSizingInput(inventory);
    expect(input).toBeDefined();
    expect(input?.path).toBe('brownfield-converge');
    expect(input?.hostCount).toBe(5);
  });

  it('sizes against consumed rather than provisioned capacity', () => {
    const { inventory } = fullImport();
    const totals = computeTotals(inventory);
    const input = toSizingInput(inventory);
    expect(input?.workloadCapacityGib).toBe(totals.usedStorageGib);
    expect(input?.workloadCapacityGib).toBeLessThan(totals.provisionedStorageGib);
  });

  it('produces an input the sizing engine accepts', () => {
    const { inventory } = fullImport();
    const input = toSizingInput(inventory);
    const result = sizeDeployment(input!);
    expect(result.totalDemand.vcpu).toBeGreaterThan(0);
    expect(result.capacity.physicalCores).toBeGreaterThan(0);
  });

  it('honours overrides', () => {
    const { inventory } = fullImport();
    const input = toSizingInput(inventory, { profile: 'ha-large', storage: 'nfs' });
    expect(input?.profile).toBe('ha-large');
    expect(input?.storage).toBe('nfs');
  });

  it('returns null when there are no hosts to profile', () => {
    const { inventory } = importRvTools({ sheets: {} });
    expect(toSizingInput(inventory)).toBeNull();
  });
});

describe('mergeInventories', () => {
  it('combines estates and de-duplicates by identity', () => {
    const a = fullImport().inventory;
    const b = fullImport().inventory;
    const merged = mergeInventories([a, b]);
    // Identical data imported twice must not double the host count.
    expect(merged.hosts).toHaveLength(5);
    expect(merged.vms).toHaveLength(5);
  });

  it('returns the single inventory unchanged', () => {
    const a = fullImport().inventory;
    expect(mergeInventories([a])).toBe(a);
  });

  it('handles an empty list', () => {
    expect(mergeInventories([]).hosts).toEqual([]);
  });
});
