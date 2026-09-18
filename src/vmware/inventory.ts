/**
 * Canonical VMware inventory model.
 *
 * Every import path — RVTools export, PowerCLI collection, live vCenter —
 * normalises into this one shape, so analysis, VCF brownfield sizing and
 * migration planning all read the same structure rather than each learning a
 * different vendor's column names.
 *
 * Unit discipline: capacity is GiB throughout, memory is GiB, frequency is MHz.
 * Importers convert at the boundary (RVTools is MiB, the vSphere API is MiB or
 * KiB) so nothing downstream has to guess.
 */

export type PowerState = 'poweredOn' | 'poweredOff' | 'suspended' | 'unknown';
export type DatastoreType = 'VMFS' | 'NFS' | 'vsan' | 'vVol' | 'other';

/** Physical NIC. Link speed decides vSAN ESA viability, so it is first-class. */
export interface PhysicalNic {
  readonly name: string;
  /** Link speed in Mb/s. 25000 is the ESA recommendation, 10000 the floor. */
  readonly speedMb?: number;
  readonly mac?: string;
  readonly driver?: string;
  readonly firmware?: string;
  readonly linkUp?: boolean;
  /** vSwitch or vDS this uplink belongs to. */
  readonly switchName?: string;
}

/** VMkernel adapter — the basis for planning the VCF network spec. */
export interface VmkernelAdapter {
  readonly name: string;
  readonly ip?: string;
  readonly subnetMask?: string;
  readonly mac?: string;
  readonly mtu?: number;
  readonly portGroup?: string;
  readonly vlanId?: number | string;
  /** Enabled services: management, vMotion, vSAN, provisioning, and so on. */
  readonly services?: string[];
  readonly stack?: string;
}

export type StorageDeviceType = 'NVMe' | 'SSD' | 'HDD' | 'unknown';

/**
 * Physical storage device.
 *
 * vSAN ESA requires NVMe TLC devices and forbids RAID controllers, so device
 * type and the controller in front of it decide whether ESA is possible at all.
 */
export interface StorageDevice {
  readonly name: string;
  readonly type: StorageDeviceType;
  readonly capacityGib?: number;
  readonly model?: string;
  readonly vendor?: string;
  /** vSAN role when claimed: cache or capacity (OSA), or storage tier (ESA). */
  readonly vsanRole?: 'cache' | 'capacity' | 'storage' | 'unclaimed';
  readonly isSsd?: boolean;
  readonly isLocal?: boolean;
}

export interface HostBusAdapter {
  readonly name: string;
  readonly type?: string;
  readonly model?: string;
  readonly driver?: string;
  readonly status?: string;
  readonly wwn?: string;
}

/** Boot configuration. VCF 9 forbids SD cards and sets minimum sizes. */
export interface BootConfig {
  readonly deviceType?: string;
  readonly capacityGib?: number;
}

export interface InventoryHost {
  readonly name: string;
  readonly cluster?: string;
  readonly datacenter?: string;
  readonly vendor?: string;
  readonly model?: string;
  readonly cpuModel?: string;
  /** Physical sockets. */
  readonly cpuSockets: number;
  readonly coresPerSocket: number;
  /** Physical cores across all sockets. */
  readonly totalCores: number;
  /** Logical processors; equals totalCores when SMT is off. */
  readonly threads?: number;
  readonly cpuSpeedMhz?: number;
  readonly memoryGib: number;
  /** Point-in-time utilisation, 0-1. RVTools captures no historical peak. */
  readonly cpuUsage?: number;
  readonly memoryUsage?: number;
  readonly nicCount?: number;
  readonly esxVersion?: string;
  readonly build?: string;
  readonly connectionState?: string;
  readonly inMaintenanceMode?: boolean;
  /** vCPUs allocated to VMs on this host, for consolidation ratios. */
  readonly allocatedVcpu?: number;
  readonly allocatedMemoryGib?: number;

  // --- hardware detail, for VCF readiness ---------------------------------
  readonly serialNumber?: string;
  readonly biosVersion?: string;
  readonly numaNodes?: number;
  readonly hyperthreadingActive?: boolean;
  /** Required for vSphere security baselines and some VCF configurations. */
  readonly tpmPresent?: boolean;
  readonly secureBootEnabled?: boolean;
  readonly uptimeDays?: number;
  readonly licenseKey?: string;

  /** Physical uplinks. Link speed gates vSAN ESA. */
  readonly physicalNics?: PhysicalNic[];
  /** VMkernel adapters — the existing network design, for brownfield planning. */
  readonly vmkernelAdapters?: VmkernelAdapter[];
  /** Local storage devices. ESA requires NVMe. */
  readonly storageDevices?: StorageDevice[];
  readonly hbas?: HostBusAdapter[];
  readonly boot?: BootConfig;
}

export interface InventoryVm {
  readonly name: string;
  readonly uuid?: string;
  readonly powerState: PowerState;
  readonly host?: string;
  readonly cluster?: string;
  readonly datacenter?: string;
  readonly vcpu: number;
  readonly coresPerSocket?: number;
  readonly memoryGib: number;
  /** Provisioned (allocated) disk. */
  readonly provisionedGib: number;
  /** Actually consumed disk. The delta is thin-provisioning headroom. */
  readonly usedGib?: number;
  readonly guestOs?: string;
  readonly hardwareVersion?: string;
  readonly toolsVersion?: string;
  readonly toolsStatus?: string;
  readonly ipAddress?: string;
  readonly datastores?: string[];
  readonly networks?: string[];
  readonly snapshotCount?: number;
  readonly snapshotGib?: number;
}

export interface InventoryCluster {
  readonly name: string;
  readonly datacenter?: string;
  readonly haEnabled?: boolean;
  readonly drsEnabled?: boolean;
  readonly drsAutomationLevel?: string;
  readonly evcMode?: string;
  readonly vsanEnabled?: boolean;
  readonly hostCount?: number;
}

export interface InventoryDatastore {
  readonly name: string;
  readonly type: DatastoreType;
  readonly capacityGib: number;
  readonly freeGib: number;
  readonly provisionedGib?: number;
  readonly hostCount?: number;
  readonly cluster?: string;
}

export interface InventoryNetwork {
  readonly name: string;
  readonly switchName?: string;
  readonly vlanId?: number | string;
  readonly type?: string;
}

export interface InventorySource {
  /** Where the data came from, for provenance in downstream reports. */
  readonly kind: 'rvtools' | 'powercli' | 'vcenter-api' | 'manual' | 'unknown';
  /** Original filename, vCenter FQDN, or similar. */
  readonly label?: string;
  /** When the data was collected, not when it was imported. */
  readonly collectedAt?: string;
  readonly importedAt: string;
  /** Anything notable about the import, e.g. unmapped columns. */
  readonly notes?: string[];
}

export interface Inventory {
  readonly source: InventorySource;
  readonly hosts: InventoryHost[];
  readonly vms: InventoryVm[];
  readonly clusters: InventoryCluster[];
  readonly datastores: InventoryDatastore[];
  readonly networks: InventoryNetwork[];
}

export function emptyInventory(source: Partial<InventorySource> = {}): Inventory {
  return {
    source: {
      kind: 'unknown',
      importedAt: new Date().toISOString(),
      ...source,
    },
    hosts: [],
    vms: [],
    clusters: [],
    datastores: [],
    networks: [],
  };
}

/** Merge inventories, e.g. several RVTools exports covering different vCenters. */
export function mergeInventories(inventories: readonly Inventory[]): Inventory {
  if (inventories.length === 0) return emptyInventory();
  if (inventories.length === 1) return inventories[0] as Inventory;

  const notes = inventories.flatMap((inv) => inv.source.notes ?? []);
  return {
    source: {
      kind: inventories[0]?.source.kind ?? 'unknown',
      label: `${inventories.length} merged sources`,
      importedAt: new Date().toISOString(),
      notes,
    },
    hosts: dedupeBy(inventories.flatMap((i) => i.hosts), (h) => h.name),
    vms: dedupeBy(inventories.flatMap((i) => i.vms), (v) => v.uuid ?? v.name),
    clusters: dedupeBy(inventories.flatMap((i) => i.clusters), (c) => c.name),
    datastores: dedupeBy(inventories.flatMap((i) => i.datastores), (d) => d.name),
    networks: dedupeBy(inventories.flatMap((i) => i.networks), (n) => n.name),
  };
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) seen.set(k, item);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export interface InventoryTotals {
  readonly hostCount: number;
  readonly vmCount: number;
  readonly poweredOnVmCount: number;
  readonly clusterCount: number;
  readonly physicalCores: number;
  readonly physicalSockets: number;
  readonly physicalMemoryGib: number;
  readonly allocatedVcpu: number;
  readonly allocatedMemoryGib: number;
  readonly provisionedStorageGib: number;
  readonly usedStorageGib: number;
  readonly datastoreCapacityGib: number;
  readonly datastoreFreeGib: number;
  /** vCPU allocated per physical core. */
  readonly cpuOvercommit: number;
  /** Allocated VM memory per GiB of physical memory. */
  readonly memoryOvercommit: number;
  /** Provisioned minus used — the thin-provisioning gap. */
  readonly thinProvisioningGib: number;
}

/**
 * Totals across the estate.
 *
 * Powered-off VMs are counted in provisioned capacity (they still occupy disk)
 * but excluded from vCPU and memory allocation, which only matters for running
 * workloads.
 */
export function computeTotals(inventory: Inventory): InventoryTotals {
  const { hosts, vms, clusters, datastores } = inventory;

  const physicalCores = hosts.reduce((sum, h) => sum + h.totalCores, 0);
  const physicalSockets = hosts.reduce((sum, h) => sum + h.cpuSockets, 0);
  const physicalMemoryGib = hosts.reduce((sum, h) => sum + h.memoryGib, 0);

  const running = vms.filter((v) => v.powerState === 'poweredOn');
  const allocatedVcpu = running.reduce((sum, v) => sum + v.vcpu, 0);
  const allocatedMemoryGib = running.reduce((sum, v) => sum + v.memoryGib, 0);

  const provisionedStorageGib = vms.reduce((sum, v) => sum + v.provisionedGib, 0);
  const usedStorageGib = vms.reduce((sum, v) => sum + (v.usedGib ?? v.provisionedGib), 0);

  const datastoreCapacityGib = datastores.reduce((sum, d) => sum + d.capacityGib, 0);
  const datastoreFreeGib = datastores.reduce((sum, d) => sum + d.freeGib, 0);

  return {
    hostCount: hosts.length,
    vmCount: vms.length,
    poweredOnVmCount: running.length,
    clusterCount: clusters.length,
    physicalCores,
    physicalSockets,
    physicalMemoryGib,
    allocatedVcpu,
    allocatedMemoryGib,
    provisionedStorageGib,
    usedStorageGib,
    datastoreCapacityGib,
    datastoreFreeGib,
    cpuOvercommit: physicalCores > 0 ? allocatedVcpu / physicalCores : 0,
    memoryOvercommit: physicalMemoryGib > 0 ? allocatedMemoryGib / physicalMemoryGib : 0,
    thinProvisioningGib: Math.max(0, provisionedStorageGib - usedStorageGib),
  };
}

export interface ClusterRollup {
  readonly name: string;
  readonly hostCount: number;
  readonly vmCount: number;
  readonly physicalCores: number;
  readonly memoryGib: number;
  readonly allocatedVcpu: number;
  readonly allocatedMemoryGib: number;
  readonly cpuOvercommit: number;
  readonly memoryOvercommit: number;
  /** Distinct CPU models present — mixed models constrain EVC and vMotion. */
  readonly cpuModels: string[];
}

export function rollupByCluster(inventory: Inventory): ClusterRollup[] {
  const groups = new Map<string, { hosts: InventoryHost[]; vms: InventoryVm[] }>();

  const ensure = (name: string) => {
    let group = groups.get(name);
    if (!group) {
      group = { hosts: [], vms: [] };
      groups.set(name, group);
    }
    return group;
  };

  for (const host of inventory.hosts) ensure(host.cluster ?? '(standalone)').hosts.push(host);
  for (const vm of inventory.vms) {
    const cluster = vm.cluster ?? inventory.hosts.find((h) => h.name === vm.host)?.cluster;
    ensure(cluster ?? '(standalone)').vms.push(vm);
  }

  return [...groups.entries()]
    .map(([name, group]) => {
      const physicalCores = group.hosts.reduce((s, h) => s + h.totalCores, 0);
      const memoryGib = group.hosts.reduce((s, h) => s + h.memoryGib, 0);
      const running = group.vms.filter((v) => v.powerState === 'poweredOn');
      const allocatedVcpu = running.reduce((s, v) => s + v.vcpu, 0);
      const allocatedMemoryGib = running.reduce((s, v) => s + v.memoryGib, 0);
      const cpuModels = [...new Set(group.hosts.map((h) => h.cpuModel).filter(Boolean))] as string[];

      return {
        name,
        hostCount: group.hosts.length,
        vmCount: group.vms.length,
        physicalCores,
        memoryGib,
        allocatedVcpu,
        allocatedMemoryGib,
        cpuOvercommit: physicalCores > 0 ? allocatedVcpu / physicalCores : 0,
        memoryOvercommit: memoryGib > 0 ? allocatedMemoryGib / memoryGib : 0,
        cpuModels,
      };
    })
    .sort((a, b) => b.hostCount - a.hostCount || a.name.localeCompare(b.name));
}

/**
 * Aggregate the estate's hosts into the averaged per-host profile the VCF
 * sizing engine expects.
 *
 * Real estates are heterogeneous, so this rounds down to the smallest common
 * denominator rather than averaging: sizing against an average host would
 * over-promise when the weakest host is the one that has to run a workload.
 */
export function toSizingHostProfile(inventory: Inventory): {
  cpuSockets: number;
  coresPerCpu: number;
  hyperthreading: boolean;
  ramGib: number;
  rawStorageGib: number;
} | null {
  const hosts = inventory.hosts;
  if (hosts.length === 0) return null;

  const minSockets = Math.min(...hosts.map((h) => h.cpuSockets));
  const minCores = Math.min(...hosts.map((h) => h.coresPerSocket));
  const minMemory = Math.min(...hosts.map((h) => h.memoryGib));
  // SMT is assumed only when every host reports more threads than cores.
  const hyperthreading = hosts.every((h) => (h.threads ?? h.totalCores) > h.totalCores);

  const vsanCapacity = inventory.datastores
    .filter((d) => d.type === 'vsan')
    .reduce((sum, d) => sum + d.capacityGib, 0);

  return {
    cpuSockets: minSockets,
    coresPerCpu: minCores,
    hyperthreading,
    ramGib: minMemory,
    rawStorageGib: hosts.length > 0 ? vsanCapacity / hosts.length : 0,
  };
}
