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
  readonly gateway?: string;
  readonly dhcp?: boolean;
  readonly ipv6?: string;
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

  // --- everything else RVTools records about a host -----------------------
  /** The vCenter that manages it — RVTools' "VI SDK Server". */
  readonly vcenter?: string;
  readonly objectId?: string;
  readonly uuid?: string;
  readonly configStatus?: string;
  readonly complianceState?: string;
  readonly inQuarantineMode?: boolean;
  readonly vsanFaultDomain?: string;
  readonly hyperthreadingAvailable?: boolean;
  readonly memoryTieringType?: string;
  readonly hbaCount?: number;
  /** Running VMs, and every VM registered including powered-off ones. */
  readonly vmCount?: number;
  readonly vmCountTotal?: number;
  readonly vmsPerCore?: number;
  readonly vcpusPerCore?: number;
  readonly vmUsedMemoryGib?: number;
  readonly vmSwappedGib?: number;
  readonly vmBalloonedGib?: number;
  readonly vmotionSupported?: boolean;
  readonly storageVmotionSupported?: boolean;
  readonly currentEvcMode?: string;
  readonly maxEvcMode?: string;
  readonly atsHeartbeat?: boolean;
  readonly atsLocking?: boolean;
  readonly cpuPowerPolicy?: string;
  readonly hostPowerPolicy?: string;
  readonly bootTime?: string;
  readonly dnsServers?: string[];
  readonly dhcp?: boolean;
  readonly domain?: string;
  readonly dnsSearchDomains?: string[];
  readonly ntpServers?: string[];
  readonly ntpRunning?: boolean;
  readonly timeZone?: string;
  readonly serviceTag?: string;
  readonly oemString?: string;
  readonly biosVendor?: string;
  readonly biosDate?: string;
  readonly certificate?: HostCertificate;
  /** Standard vSwitches, with their security and teaming policy. */
  readonly standardSwitches?: StandardSwitch[];
  /** Standard port groups on this host. Distributed ones are in `networks`. */
  readonly portGroups?: InventoryNetwork[];
  /** Storage paths, summarised per device, from vMultiPath. */
  readonly storagePaths?: StoragePathSummary;
}

export interface HostCertificate {
  readonly issuer?: string;
  readonly subject?: string;
  readonly validFrom?: string;
  readonly expires?: string;
  readonly status?: string;
}

export interface StandardSwitch {
  readonly name: string;
  readonly ports?: number;
  readonly freePorts?: number;
  readonly mtu?: number;
  readonly promiscuous?: boolean;
  readonly macChanges?: boolean;
  readonly forgedTransmits?: boolean;
  readonly teamingPolicy?: string;
  readonly uplinks?: string[];
}

export interface StoragePathSummary {
  /** Devices (LUNs) the host sees. */
  readonly devices: number;
  /** Devices with fewer than two paths — a single point of failure. */
  readonly singlePathDevices: number;
  /** Paths not in an active or standby state. */
  readonly deadPaths: number;
  /** Path selection policies in use, with how many devices use each. */
  readonly policies: Record<string, number>;
  readonly vendors: string[];
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

  // --- everything else RVTools records about a VM -------------------------
  readonly vcenter?: string;
  /** Managed object id, e.g. vm-1234. Unique within a vCenter only. */
  readonly vmId?: string;
  readonly smbiosUuid?: string;
  /** Templates are counted apart from VMs: they occupy disk and nothing else. */
  readonly template?: boolean;
  /** An SRM placeholder is a shadow of a VM protected elsewhere, not a VM. */
  readonly srmPlaceholder?: boolean;
  readonly configStatus?: string;
  readonly connectionState?: string;
  readonly guestState?: string;
  readonly heartbeat?: string;
  readonly consolidationNeeded?: boolean;
  readonly dnsName?: string;
  readonly createdAt?: string;
  readonly poweredOnAt?: string;
  /** CPU ready as a percentage at the moment of capture. */
  readonly cpuReadyPct?: number;
  /** Memory the guest was actively touching at capture — a demand signal. */
  readonly activeMemoryGib?: number;
  readonly nicCount?: number;
  readonly diskCount?: number;
  readonly totalDiskGib?: number;
  /** Storage used by this VM alone, excluding what it shares with clones. */
  readonly unsharedGib?: number;
  /** Raw device mappings, which are LUNs rather than files and move differently. */
  readonly rdmGib?: number;
  readonly passthroughHotplug?: boolean;
  readonly minEvcMode?: string;
  readonly latencySensitivity?: string;
  readonly enableUuid?: boolean;
  readonly changedBlockTracking?: boolean;
  readonly monitors?: number;
  readonly videoRamKib?: number;
  readonly resourcePool?: string;
  readonly folder?: string;
  readonly folderId?: string;
  readonly vApp?: string;
  readonly haProtected?: boolean;
  readonly haRestartPriority?: string;
  readonly haIsolationResponse?: string;
  readonly haVmMonitoring?: string;
  readonly ftState?: string;
  readonly ftRole?: string;
  /** DRS rules this VM is in, by kind and by name. */
  readonly clusterRules?: string[];
  readonly clusterRuleNames?: string[];
  readonly bootDelayMs?: number;
  readonly firmware?: string;
  readonly efiSecureBoot?: boolean;
  readonly hwUpgradeStatus?: string;
  readonly hwUpgradePolicy?: string;
  readonly vmxPath?: string;
  readonly annotation?: string;
  /**
   * vCenter custom attributes — backup stamps, owners, cost centres. Named by
   * whoever set up the vCenter, so kept by their own names rather than mapped.
   */
  readonly customAttributes?: Record<string, string>;
  /** The OS as VMware Tools reports it, which beats the configured one. */
  readonly guestOsTools?: string;
  /** Tools' detailed guest data: distro, kernel, bitness, pretty name. */
  readonly guestDetail?: Record<string, string>;
  readonly customizationInfo?: string;
  /** Every address the guest reports, across all NICs. */
  readonly ipAddresses?: string[];
  readonly cpu?: VmCpuDetail;
  readonly memory?: VmMemoryDetail;
  readonly disks?: VmDisk[];
  readonly partitions?: VmPartition[];
  readonly nics?: VmNic[];
  readonly cdroms?: VmDevice[];
  readonly usbDevices?: VmDevice[];
  readonly snapshots?: VmSnapshot[];
  readonly tools?: VmToolsDetail;
}

export interface VmCpuDetail {
  readonly sockets?: number;
  readonly coresPerSocket?: number;
  /** MHz the VM could use, and was using at capture. */
  readonly maxMhz?: number;
  readonly overallMhz?: number;
  readonly sharesLevel?: string;
  readonly shares?: number;
  readonly reservationMhz?: number;
  /** -1 in vSphere means unlimited; kept as undefined here. */
  readonly limitMhz?: number;
  readonly entitlementMhz?: number;
  readonly hotAdd?: boolean;
  readonly hotRemove?: boolean;
  readonly numaHotAddExposed?: boolean;
}

export interface VmMemoryDetail {
  readonly sizeGib?: number;
  readonly lockedToMax?: boolean;
  readonly overheadMib?: number;
  readonly consumedGib?: number;
  readonly privateGib?: number;
  readonly sharedGib?: number;
  readonly swappedGib?: number;
  readonly balloonedGib?: number;
  readonly activeGib?: number;
  readonly entitlementGib?: number;
  readonly sharesLevel?: string;
  readonly reservationGib?: number;
  readonly limitGib?: number;
  readonly hotAdd?: boolean;
}

export interface VmDisk {
  readonly label: string;
  readonly key?: string;
  readonly uuid?: string;
  readonly capacityGib: number;
  readonly raw: boolean;
  /** physicalMode or virtualMode, for an RDM. */
  readonly rawCompatibilityMode?: string;
  readonly rawLunId?: string;
  readonly mode?: string;
  /** sharingMultiWriter marks a disk several VMs write to — clusters, GPFS. */
  readonly sharing?: string;
  readonly thin?: boolean;
  readonly eagerlyScrub?: boolean;
  readonly split?: boolean;
  readonly writeThrough?: boolean;
  readonly sharesLevel?: string;
  readonly iopsLimit?: number;
  readonly controller?: string;
  readonly unit?: string;
  readonly sharedBus?: string;
  readonly datastore?: string;
  readonly file?: string;
}

export interface VmPartition {
  readonly mount: string;
  readonly diskKey?: string;
  readonly capacityGib: number;
  readonly consumedGib: number;
  readonly freeGib: number;
}

export interface VmNic {
  readonly label: string;
  readonly adapter?: string;
  readonly network?: string;
  readonly switchName?: string;
  readonly connected?: boolean;
  readonly startsConnected?: boolean;
  readonly mac?: string;
  readonly macType?: string;
  readonly ipv4?: string[];
  readonly ipv6?: string[];
  readonly directPathIo?: boolean;
}

export interface VmDevice {
  readonly node: string;
  readonly type?: string;
  readonly connected?: boolean;
  readonly startsConnected?: boolean;
}

export interface VmSnapshot {
  readonly name: string;
  readonly description?: string;
  readonly createdAt?: string;
  readonly sizeGib?: number;
  readonly quiesced?: boolean;
  readonly state?: string;
}

export interface VmToolsDetail {
  readonly status?: string;
  readonly version?: string;
  readonly requiredVersion?: string;
  readonly upgradeable?: boolean;
  readonly upgradePolicy?: string;
  readonly syncTime?: boolean;
  readonly appStatus?: string;
  readonly heartbeatStatus?: string;
  readonly kernelCrashState?: string;
  readonly operationReady?: boolean;
  readonly interactiveGuestReady?: boolean;
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

  readonly vcenter?: string;
  readonly objectId?: string;
  readonly configStatus?: string;
  readonly overallStatus?: string;
  readonly effectiveHostCount?: number;
  readonly totalCpuMhz?: number;
  readonly cores?: number;
  readonly threads?: number;
  readonly effectiveCpuMhz?: number;
  readonly totalMemoryGib?: number;
  readonly effectiveMemoryGib?: number;
  readonly vmotions?: number;
  /** Host failures HA reserves for. */
  readonly haFailoverLevel?: number;
  readonly haAdmissionControl?: boolean;
  readonly haHostMonitoring?: string;
  readonly haHeartbeatDatastorePolicy?: string;
  readonly haIsolationResponse?: string;
  readonly haRestartPriority?: string;
  readonly haVmMonitoring?: string;
  readonly haSettings?: string;
  readonly drsVmotionRate?: number;
  readonly dpmEnabled?: boolean;
  readonly dpmBehavior?: string;
}

export interface InventoryDatastore {
  readonly name: string;
  readonly type: DatastoreType;
  readonly capacityGib: number;
  readonly freeGib: number;
  readonly provisionedGib?: number;
  readonly hostCount?: number;
  readonly cluster?: string;

  readonly vcenter?: string;
  readonly objectId?: string;
  /** As RVTools names it — VMFS, NFS41, vsan, vvol. `type` is the family. */
  readonly typeDetail?: string;
  readonly configStatus?: string;
  /** NFS server or backing address. */
  readonly address?: string;
  readonly accessible?: boolean;
  readonly vmCount?: number;
  readonly vmCountTotal?: number;
  readonly inUseGib?: number;
  readonly siocEnabled?: boolean;
  readonly siocThreshold?: string;
  readonly hosts?: string[];
  /** Datastore cluster, when it belongs to one. */
  readonly datastoreClusterCapacityGib?: number;
  readonly datastoreClusterFreeGib?: number;
  readonly blockSizeMb?: number;
  readonly extents?: number;
  readonly majorVersion?: number;
  readonly version?: string;
  readonly vmfsUpgradeable?: boolean;
  readonly url?: string;
}

export interface InventoryNetwork {
  readonly name: string;
  readonly switchName?: string;
  readonly vlanId?: number | string;
  readonly type?: string;

  readonly vcenter?: string;
  /** Distributed port group, or standard port group on a host. */
  readonly kind?: 'distributed' | 'standard';
  readonly host?: string;
  readonly datacenter?: string;
  readonly ports?: number;
  readonly activeUplinks?: string[];
  readonly standbyUplinks?: string[];
  readonly teamingPolicy?: string;
  readonly promiscuous?: boolean;
  readonly macChanges?: boolean;
  readonly forgedTransmits?: boolean;
  readonly blocked?: boolean;
  readonly objectId?: string;
}

export interface InventoryVcenter {
  readonly name: string;
  readonly uuid?: string;
  readonly fullName?: string;
  readonly version?: string;
  readonly build?: string;
  readonly apiVersion?: string;
  readonly osType?: string;
  readonly productLine?: string;
}

export interface InventoryResourcePool {
  readonly name: string;
  readonly path?: string;
  readonly vcenter?: string;
  readonly status?: string;
  readonly vmCount?: number;
  readonly vmCountTotal?: number;
  readonly vcpus?: number;
  readonly cpuReservationMhz?: number;
  readonly cpuLimitMhz?: number;
  readonly cpuSharesLevel?: string;
  readonly cpuExpandable?: boolean;
  readonly cpuUsageMhz?: number;
  readonly memoryConfiguredGib?: number;
  readonly memoryReservationGib?: number;
  readonly memoryLimitGib?: number;
  readonly memorySharesLevel?: string;
  readonly memoryExpandable?: boolean;
  readonly memoryUsageGib?: number;
  readonly objectId?: string;
}

export interface InventoryDistributedSwitch {
  readonly name: string;
  readonly vcenter?: string;
  readonly datacenter?: string;
  readonly vendor?: string;
  readonly version?: string;
  readonly hostMembers?: string[];
  readonly maxPorts?: number;
  readonly ports?: number;
  readonly vmCount?: number;
  readonly maxMtu?: number;
  readonly discoveryProtocol?: string;
  readonly lacp?: string;
  readonly objectId?: string;
}

export interface InventoryLicense {
  readonly name: string;
  /** Only the last five characters. A licence key is a credential. */
  readonly keyTail?: string;
  readonly vcenter?: string;
  readonly costUnit?: string;
  readonly total?: number;
  readonly used?: number;
  readonly expires?: string;
  readonly features?: string;
}

export interface InventoryHealthMessage {
  readonly subject: string;
  readonly message: string;
  readonly type?: string;
  readonly vcenter?: string;
}

export interface InventoryFile {
  readonly path: string;
  readonly name: string;
  readonly type?: string;
  readonly sizeBytes?: number;
  readonly vcenter?: string;
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
  /** The collecting tool's version, e.g. RVTools 4.7.1.4. */
  readonly toolVersion?: string;
  /** When each vCenter was collected — they differ by minutes or hours. */
  readonly collectedPerVcenter?: Record<string, string>;
  /** Tabs read, with their row counts. */
  readonly tabs?: Record<string, number>;
}

export interface Inventory {
  readonly source: InventorySource;
  readonly hosts: InventoryHost[];
  readonly vms: InventoryVm[];
  readonly clusters: InventoryCluster[];
  readonly datastores: InventoryDatastore[];
  readonly networks: InventoryNetwork[];
  readonly vcenters?: InventoryVcenter[];
  readonly resourcePools?: InventoryResourcePool[];
  readonly distributedSwitches?: InventoryDistributedSwitch[];
  readonly licenses?: InventoryLicense[];
  readonly health?: InventoryHealthMessage[];
  readonly files?: InventoryFile[];
}

/**
 * A key that is unique across vCenters.
 *
 * An estate collected from thirteen vCenters has thirteen clusters that could be
 * called "Cluster01" and managed-object ids that restart in each one, so a name
 * alone is not an identity. Anything that joins or de-duplicates goes through
 * this.
 */
export function scopedKey(vcenter: string | undefined, name: string): string {
  return `${(vcenter ?? '').toLowerCase()}|${name}`;
}

/** VMs that are workloads: not templates and not SRM placeholders. */
export function isWorkload(vm: InventoryVm): boolean {
  return !vm.template && !vm.srmPlaceholder;
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
    hosts: dedupeBy(inventories.flatMap((i) => i.hosts), (h) => scopedKey(h.vcenter, h.name)),
    vms: dedupeBy(inventories.flatMap((i) => i.vms), (v) => scopedKey(v.vcenter, v.uuid ?? v.name)),
    clusters: dedupeBy(inventories.flatMap((i) => i.clusters), (c) => scopedKey(c.vcenter, c.name)),
    datastores: dedupeBy(inventories.flatMap((i) => i.datastores), (d) => scopedKey(d.vcenter, d.name)),
    networks: dedupeBy(
      inventories.flatMap((i) => i.networks),
      (n) => scopedKey(n.vcenter, `${n.host ?? ''}/${n.switchName ?? ''}/${n.name}`),
    ),
    vcenters: dedupeBy(inventories.flatMap((i) => i.vcenters ?? []), (v) => v.name.toLowerCase()),
    resourcePools: dedupeBy(
      inventories.flatMap((i) => i.resourcePools ?? []),
      (p) => scopedKey(p.vcenter, p.path ?? p.name),
    ),
    distributedSwitches: dedupeBy(
      inventories.flatMap((i) => i.distributedSwitches ?? []),
      (d) => scopedKey(d.vcenter, d.name),
    ),
    licenses: dedupeBy(
      inventories.flatMap((i) => i.licenses ?? []),
      (l) => scopedKey(l.vcenter, `${l.name}/${l.keyTail ?? ''}`),
    ),
    health: inventories.flatMap((i) => i.health ?? []),
    files: inventories.flatMap((i) => i.files ?? []),
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
  /** Workload VMs — templates and SRM placeholders are counted separately. */
  readonly vmCount: number;
  readonly poweredOnVmCount: number;
  readonly templateCount: number;
  readonly clusterCount: number;
  readonly vcenterCount: number;
  readonly physicalCores: number;
  readonly physicalSockets: number;
  readonly physicalMemoryGib: number;
  readonly allocatedVcpu: number;
  readonly allocatedMemoryGib: number;
  /** Memory the running VMs were actively using at capture. */
  readonly activeMemoryGib: number;
  readonly provisionedStorageGib: number;
  /** Consumed VMDK storage, RDMs excluded — they are counted once, below. */
  readonly usedStorageGib: number;
  /** Raw device mappings, each LUN once however many VMs share it. */
  readonly rdmGib: number;
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
 * The VMDK storage a VM consumes.
 *
 * RVTools' "In Use" includes the full size of a physical-mode RDM, so a VM
 * with a 1.2 PB GPFS LUN mapped reports 1.2 PB in use — and seven such VMs
 * report 8.4 PB for one LUN. The RDM is taken out here and counted once, by
 * LUN, in `rdmCapacityGib`.
 */
export function vmdkUsedGib(vm: InventoryVm): number {
  const used = vm.usedGib ?? vm.provisionedGib;
  return Math.max(0, used - (vm.rdmGib ?? 0));
}

export function vmdkProvisionedGib(vm: InventoryVm): number {
  return Math.max(0, vm.provisionedGib - (vm.rdmGib ?? 0));
}

/** RDM capacity across a set of VMs, each LUN counted once. */
export function rdmCapacityGib(vms: readonly InventoryVm[]): number {
  const luns = new Map<string, number>();
  let unidentified = 0;
  for (const vm of vms) {
    for (const disk of vm.disks ?? []) {
      if (!disk.raw) continue;
      if (disk.rawLunId) luns.set(scopedKey(vm.vcenter, disk.rawLunId), disk.capacityGib);
      else unidentified += disk.capacityGib;
    }
    // A VM imported without its disks still knows its RDM total.
    if (!vm.disks && vm.rdmGib) unidentified += vm.rdmGib;
  }
  return [...luns.values()].reduce((a, b) => a + b, 0) + unidentified;
}

/**
 * Totals across the estate.
 *
 * Powered-off VMs and templates are counted in storage (they still occupy
 * disk) but excluded from vCPU and memory allocation, which only matters for
 * running workloads.
 */
export function computeTotals(inventory: Inventory): InventoryTotals {
  const { hosts, vms, clusters, datastores } = inventory;

  const physicalCores = hosts.reduce((sum, h) => sum + h.totalCores, 0);
  const physicalSockets = hosts.reduce((sum, h) => sum + h.cpuSockets, 0);
  const physicalMemoryGib = hosts.reduce((sum, h) => sum + h.memoryGib, 0);

  const workloads = vms.filter(isWorkload);
  const running = workloads.filter((v) => v.powerState === 'poweredOn');
  const allocatedVcpu = running.reduce((sum, v) => sum + v.vcpu, 0);
  const allocatedMemoryGib = running.reduce((sum, v) => sum + v.memoryGib, 0);
  const activeMemoryGib = running.reduce((sum, v) => sum + (v.activeMemoryGib ?? v.memoryGib), 0);

  const onDisk = vms.filter((v) => !v.srmPlaceholder);
  const provisionedStorageGib = onDisk.reduce((sum, v) => sum + vmdkProvisionedGib(v), 0);
  const usedStorageGib = onDisk.reduce((sum, v) => sum + vmdkUsedGib(v), 0);
  const rdmGib = rdmCapacityGib(onDisk);

  const datastoreCapacityGib = datastores.reduce((sum, d) => sum + d.capacityGib, 0);
  const datastoreFreeGib = datastores.reduce((sum, d) => sum + d.freeGib, 0);

  const vcenters = new Set(
    [...hosts.map((h) => h.vcenter), ...vms.map((v) => v.vcenter), ...(inventory.vcenters ?? []).map((v) => v.name)]
      .filter(Boolean)
      .map((v) => (v as string).toLowerCase()),
  );

  return {
    hostCount: hosts.length,
    vmCount: workloads.length,
    poweredOnVmCount: running.length,
    templateCount: vms.filter((v) => v.template).length,
    clusterCount: clusters.length,
    vcenterCount: vcenters.size,
    physicalCores,
    physicalSockets,
    physicalMemoryGib,
    allocatedVcpu,
    allocatedMemoryGib,
    activeMemoryGib,
    provisionedStorageGib,
    usedStorageGib,
    rdmGib,
    datastoreCapacityGib,
    datastoreFreeGib,
    cpuOvercommit: physicalCores > 0 ? allocatedVcpu / physicalCores : 0,
    memoryOvercommit: physicalMemoryGib > 0 ? allocatedMemoryGib / physicalMemoryGib : 0,
    thinProvisioningGib: Math.max(0, provisionedStorageGib - usedStorageGib),
  };
}

export interface ClusterRollup {
  /** scopedKey(vcenter, name) — what to select a cluster by. */
  readonly key: string;
  readonly name: string;
  readonly vcenter?: string;
  readonly datacenter?: string;
  readonly hostCount: number;
  readonly vmCount: number;
  readonly poweredOnVmCount: number;
  readonly physicalCores: number;
  readonly memoryGib: number;
  readonly allocatedVcpu: number;
  readonly allocatedMemoryGib: number;
  readonly activeMemoryGib: number;
  readonly usedStorageGib: number;
  readonly provisionedStorageGib: number;
  readonly rdmGib: number;
  readonly cpuOvercommit: number;
  readonly memoryOvercommit: number;
  /** Distinct CPU models present — mixed models constrain EVC and vMotion. */
  readonly cpuModels: string[];
  /** Host CPU utilisation at capture, weighted by cores. */
  readonly cpuUsage?: number;
  readonly memoryUsage?: number;
}

/** Which cluster a VM belongs to, as a scoped key. */
export function clusterKeyOf(inventory: Inventory, vm: InventoryVm, hostIndex?: Map<string, InventoryHost>): string {
  if (vm.cluster) return scopedKey(vm.vcenter, vm.cluster);
  const index = hostIndex ?? new Map(inventory.hosts.map((h) => [scopedKey(h.vcenter, h.name), h]));
  const host = vm.host ? index.get(scopedKey(vm.vcenter, vm.host)) : undefined;
  return scopedKey(vm.vcenter, host?.cluster ?? '(standalone)');
}

export function rollupByCluster(inventory: Inventory): ClusterRollup[] {
  const groups = new Map<string, { name: string; vcenter?: string; datacenter?: string; hosts: InventoryHost[]; vms: InventoryVm[] }>();

  const ensure = (vcenter: string | undefined, name: string) => {
    const key = scopedKey(vcenter, name);
    let group = groups.get(key);
    if (!group) {
      group = { name, ...(vcenter ? { vcenter } : {}), hosts: [], vms: [] };
      groups.set(key, group);
    }
    return group;
  };

  const hostIndex = new Map(inventory.hosts.map((h) => [scopedKey(h.vcenter, h.name), h]));
  for (const host of inventory.hosts) {
    const group = ensure(host.vcenter, host.cluster ?? '(standalone)');
    group.hosts.push(host);
    group.datacenter ??= host.datacenter;
  }
  for (const vm of inventory.vms) {
    if (vm.srmPlaceholder) continue;
    const host = vm.host ? hostIndex.get(scopedKey(vm.vcenter, vm.host)) : undefined;
    ensure(vm.vcenter, vm.cluster ?? host?.cluster ?? '(standalone)').vms.push(vm);
  }

  return [...groups.entries()]
    .map(([key, group]): ClusterRollup => {
      const physicalCores = group.hosts.reduce((s, h) => s + h.totalCores, 0);
      const memoryGib = group.hosts.reduce((s, h) => s + h.memoryGib, 0);
      const workloads = group.vms.filter(isWorkload);
      const running = workloads.filter((v) => v.powerState === 'poweredOn');
      const allocatedVcpu = running.reduce((s, v) => s + v.vcpu, 0);
      const allocatedMemoryGib = running.reduce((s, v) => s + v.memoryGib, 0);
      const activeMemoryGib = running.reduce((s, v) => s + (v.activeMemoryGib ?? v.memoryGib), 0);
      const cpuModels = [...new Set(group.hosts.map((h) => h.cpuModel).filter(Boolean))] as string[];
      const withCpu = group.hosts.filter((h) => h.cpuUsage !== undefined && h.totalCores > 0);
      const withMem = group.hosts.filter((h) => h.memoryUsage !== undefined && h.memoryGib > 0);
      const coreSum = withCpu.reduce((s, h) => s + h.totalCores, 0);
      const memSum = withMem.reduce((s, h) => s + h.memoryGib, 0);

      return {
        key,
        name: group.name,
        ...(group.vcenter ? { vcenter: group.vcenter } : {}),
        ...(group.datacenter ? { datacenter: group.datacenter } : {}),
        hostCount: group.hosts.length,
        vmCount: workloads.length,
        poweredOnVmCount: running.length,
        physicalCores,
        memoryGib,
        allocatedVcpu,
        allocatedMemoryGib,
        activeMemoryGib,
        usedStorageGib: group.vms.reduce((s, v) => s + vmdkUsedGib(v), 0),
        provisionedStorageGib: group.vms.reduce((s, v) => s + vmdkProvisionedGib(v), 0),
        rdmGib: rdmCapacityGib(group.vms),
        cpuOvercommit: physicalCores > 0 ? allocatedVcpu / physicalCores : 0,
        memoryOvercommit: memoryGib > 0 ? allocatedMemoryGib / memoryGib : 0,
        cpuModels,
        ...(coreSum > 0 ? { cpuUsage: withCpu.reduce((s, h) => s + (h.cpuUsage ?? 0) * h.totalCores, 0) / coreSum } : {}),
        ...(memSum > 0 ? { memoryUsage: withMem.reduce((s, h) => s + (h.memoryUsage ?? 0) * h.memoryGib, 0) / memSum } : {}),
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
