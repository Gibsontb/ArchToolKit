/**
 * VCF 9.1 sizing engine.
 *
 * Answers "will this hardware run this VCF design, and what will it cost to
 * license" for greenfield, brownfield-converge and brownfield-import paths, at
 * single-instance or fleet scale, for 9.1.0 or 9.1.1.
 *
 * Design notes:
 *  - The management-plane footprint comes from Broadcom's published fleet
 *    sizing table (S1) rather than being summed from per-component figures.
 *    The per-appliance breakdown (`managementBreakdown`) is reported beside it,
 *    with the provenance of each line.
 *  - Each VCF instance is its own management domain on its own hosts
 *    (`sizeFleet`). Additional instances are never piled onto the first
 *    instance's cluster.
 *  - CPU is measured on physical cores with the failure reserve taken off
 *    (N+1 by default), like memory. Management domain target: 2:1 (S7).
 *  - One vSAN reserve: the host(s) held back for failure. No blanket slack on
 *    top of it.
 *  - Where a live VCF Installer is reachable, `POST /v1/sddcs/resources-calculation`
 *    is authoritative and should override this engine.
 *  - Every result carries the weakest provenance tag of its inputs.
 */

import { error, warning, info, type Finding } from '../core/findings.ts';
import { weakestVerification, type Verification } from './provenance.ts';
import { automationIpCount, atLeastVcfVersion } from './version.ts';
import {
  SOURCES,
  fleetEntry,
  fullVcfVersion,
  vcfRelease,
  isHaProfile,
  FLEET_ADDITIONAL_INSTANCE_911,
  FLEET_FIRST_INSTANCE_911,
  NSX_EDGE_SIZES,
  NSX_MANAGER_SIZES,
  NSX_EDGE_CLUSTER_MIN_NODES,
  NSX_EDGE_CLUSTER_MAX_NODES,
  EDGE_TEP_IPS_PER_NODE,
  AUTOMATION_NODE_SIZES,
  profileAutomation,
  profileSize,
  vcfmsFootprint,
  logReplicaDiskGib,
  workbookUrl,
  workbookSource,
  workbookManagementPlane,
  opsNetworksPlatform,
  opsNetworksCollector,
  profilesForRelease,
  automationFootprint,
  VSAN_ESA_MIN_HOST_RAM_GIB,
  VSAN_ESA_AF0_MAX_NIC_GBPS,
  HOST_MINIMUMS,
  CONVERGE_STRETCHED_UNCONFIRMED,
  haReserveFraction,
  LICENSE_MIN_CORES_PER_CPU,
  LICENSE_MIN_CORES_PER_CPU_EDGE,
  VCF_EDGE_MIN_CORES_PER_HOST,
  VCF_EDGE_MAX_CORES_PER_SITE,
  VCF_EDGE_MIN_SITES,
  VSAN_TIB_PER_CORE,
  VCFMS_MIN_IPS,
  VCFMS_RECOMMENDED_IPS,
  FIRST_INSTANCE_FQDNS,
  ADDITIONAL_INSTANCE_FQDNS,
  hostVmkernelIps,
  VSAN_OPERATIONS_RESERVE_DEFAULT,
  VSAN_DEDUP_RATIO_DEFAULT,
  VSAN_RESERVE_NOTE,
  VSAN_WORKBOOK_HOST_AND_OPERATIONS_RESERVE,
  VSAN_WORKBOOK_STORAGE_GROWTH,
  VSAN_WITNESS_SIZES,
  STRETCHED_MIN_BANDWIDTH_GBPS,
  STRETCHED_MAX_RTT_MS,
  MEMORY_TIERING_DEFAULT_RATIO,
  MEMORY_TIERING_MAX_RATIO,
  MEMORY_TIERING_MAX_ACTIVE_FRACTION,
  MEMORY_TIERING_HA_VERSION,
  LOG_MANAGEMENT_REPLICAS,
  LOG_MANAGEMENT_DISK_PER_REPLICA_GIB,
  LOG_MANAGEMENT_BASE_IPS,
  LOG_MANAGEMENT_IPS_PER_REPLICA,
  REAL_TIME_METRICS_IPS,
  OPS_NETWORKS_CLUSTER,
  AVI_CONTROLLER_SIZES,
  PROTECTION_RECOVERY,
  HCX_APPLIANCES,
  SUPERVISOR_CP_SIZES,
  OPS_SIZES,
  OPS_COLLECTOR_SIZES,
  VCENTER_SIZES,
  VCENTER_CAPACITY,
  vcenterSizeFor,
  SDDC_MANAGER,
  LICENSE_SERVER,
  raidOverhead,
  addFootprints,
  subtractFootprints,
  scaleFootprint,
  footprintOf,
  weakestBasis,
  ZERO_FOOTPRINT,
  type Basis,
  type SizedEntry,
  type Footprint,
  type DeploymentProfile,
  type DeploymentPath,
  type ClusterTopology,
  type NsxEdgeSize,
  type NsxManagerSize,
  type AutomationSize,
  type VcfRelease,
  type InstanceRole,
  type DomainRole,
  type HostMinimum,
  type OsaPolicy,
  type VsanArchitecture,
  type WitnessSize,
  type VcenterSize,
  type LogReplicaSize,
  type OpsNetworksSize,
  type AviControllerSize,
  type SupervisorSize,
  type OpsSize,
  type OpsCollectorSize,
} from './sizing-data.ts';

export type StorageType = 'vsan-esa' | 'vsan-osa' | 'nfs' | 'vmfs-fc';

export interface HostSpec {
  /** Physical CPU sockets per host. */
  readonly cpuSockets: number;
  /** Physical cores per socket. */
  readonly coresPerCpu: number;
  /** Whether hyperthreading/SMT is enabled. Not counted as CPU capacity. */
  readonly hyperthreading: boolean;
  /** DRAM per host, GiB. */
  readonly ramGib: number;
  /** Raw storage contributed to the vSAN datastore per host, in GiB. Ignored for external storage. */
  readonly rawStorageGib: number;
}

/** vSAN model inputs. The architecture comes from the storage type (vsan-esa / vsan-osa). */
export interface VsanOptions {
  /** OSA only: an explicit policy. Default: RAID-1 at 3 hosts, RAID-5 (3+1) from 4. */
  readonly osaPolicy?: OsaPolicy;
  /** Expected dedup/compression ratio. Default 1.0 (none assumed). */
  readonly dedupRatio?: number;
  /** Operations reserve as a fraction of raw. Default 0 (the engine counts the rebuild reserve once, as the failure hosts). */
  readonly operationsReserve?: number;
  /**
   * 'engine' (default): RAID overhead on the data, rebuild reserve = the failure hosts.
   * 'workbook': Broadcom's Planning and Preparation Workbook model — data plus a
   * swap file equal to VM memory, × FTT overhead, × 1.3 host-and-operations
   * reserve, × 1.1 growth, over N-1 hosts.
   */
  readonly model?: 'engine' | 'workbook';
  /** Swap to store (GiB), for the workbook model. The management domain fills it with its memory demand. */
  readonly swapGib?: number;
}

export interface StretchedOptions {
  /** Hold back one availability zone (50% CPU and memory). Default true. [S5] */
  readonly reserveAzFailure?: boolean;
  readonly interAzBandwidthGbps?: number;
  readonly interAzRttMs?: number;
  /** vSAN witness appliance size at the third site. Default medium. Unconfirmed sizes. */
  readonly witnessSize?: WitnessSize;
}

export interface MemoryTieringInput {
  readonly enabled: boolean;
  /** NVMe tier as a fraction of DRAM: 1 = 1:1 (default), up to 4. */
  readonly ratio?: number;
  /** Share of workload memory that is active. Default 0.5. */
  readonly activeMemoryFraction?: number;
  /** True when the tiering NVMe device is also a vSAN device (not allowed). */
  readonly nvmeSharedWithVsan?: boolean;
}

/** Annual growth, compounded over `years`. Percentages: 10 = 10% a year. */
export interface GrowthInput {
  readonly cpuPct?: number;
  readonly ramPct?: number;
  readonly storagePct?: number;
  readonly years?: number;
}

export interface EdgeClusterInput {
  readonly size: NsxEdgeSize;
  readonly nodes: number;
}

export interface SupervisorInput {
  /** Supervisors in the domain. */
  readonly count: number;
  readonly size: SupervisorSize;
  /** 1 (Simple) or 3 (HA / three-zone). Default 3. */
  readonly controlPlaneVms?: 1 | 3;
}

/** A workload-domain cluster sized from a manual demand. */
export interface WorkloadClusterInput {
  readonly name?: string;
  readonly vcpu: number;
  readonly ramGib: number;
  /** Data to store, GiB, before RAID overhead. */
  readonly storageGib: number;
  readonly host: HostSpec;
  readonly storage: StorageType;
  readonly topology?: ClusterTopology;
  /** vCPU per physical core. Default 4 (toolkit planning default, not a Broadcom figure). */
  readonly cpuRatio?: number;
  /** Fraction of surviving memory to plan to use. Default 0.9 (toolkit default). */
  readonly memoryCeiling?: number;
  /** Host failures to reserve: 0, 1 (N+1, default) or 2 (N+2). */
  readonly hostFailures?: 0 | 1 | 2;
  readonly vsan?: VsanOptions;
  readonly growth?: GrowthInput;
  readonly memoryTiering?: MemoryTieringInput;
  readonly stretched?: StretchedOptions;
  /** Evaluate this host count instead of finding the smallest. */
  readonly hosts?: number;
  /** Target VCF release, for rules that depend on it. */
  readonly version?: string;
  readonly pnicsPerHost?: number;
  /** vSAN ESA NIC speed per host, Gbps, for the ReadyNode check. */
  readonly nicSpeedGbps?: number;
}

/** A VI workload domain: its management load lands in the management domain. */
export interface WorkloadDomainInput {
  readonly name?: string;
  /** Hosts, when no clusters are given (clusters' host counts win). */
  readonly hosts?: number;
  /** VMs managed, for vCenter sizing. */
  readonly vms?: number;
  /** vCenter size; default the smallest that manages the hosts and VMs. */
  readonly vcenterSize?: VcenterSize;
  /** A dedicated NSX Manager cluster (default) or shared with another workload domain. */
  readonly nsx?: 'dedicated' | 'shared';
  /** Default medium. Footprints unconfirmed for 9.1. */
  readonly nsxSize?: NsxManagerSize;
  /** Default 3. */
  readonly nsxNodes?: 1 | 3;
  readonly clusters?: readonly WorkloadClusterInput[];
  /** An NSX Edge cluster placed in the domain's first cluster. */
  readonly edgeCluster?: EdgeClusterInput;
  /** Supervisor control planes placed in the domain's first cluster. */
  readonly supervisor?: SupervisorInput;
}

export interface LogManagementInput {
  readonly replicaSize?: LogReplicaSize;
  readonly replicas?: number;
  /** Events per second to ingest; sets replicas when `replicas` is not given. */
  readonly eps?: number;
  readonly dailyGib?: number;
  readonly retentionDays?: number;
  /** One spare replica. */
  readonly nPlusOne?: boolean;
}

export interface AddOnsInput {
  readonly logManagement?: LogManagementInput;
  readonly realTimeMetrics?: boolean;
  readonly operationsForNetworks?: {
    readonly size?: OpsNetworksSize;
    readonly nodes?: number;
    readonly vms?: number;
    readonly flows?: number;
    /** Collectors (default 1, the workbook's), sized like the platform unless given. */
    readonly collectors?: number;
    readonly collectorSize?: OpsNetworksSize;
  };
  /** Additional instance (9.1.1): its own Software Depot, on its VCFMS workers. */
  readonly softwareDepot?: boolean;
  /** Additional instance (9.1.1): its own Identity Broker, on its VCFMS workers. */
  readonly identityBroker?: boolean;
  readonly avi?: { readonly size?: AviControllerSize; readonly nodes?: 1 | 3 };
  readonly protectionRecovery?: { readonly protectedVms?: number; readonly scaleOutAppliances?: number };
  readonly hcx?: { readonly sitePairs?: number; readonly networkExtensions?: number; readonly wanOptimization?: boolean; readonly sentinelGateway?: boolean };
  readonly operationsScaleOut?: {
    readonly dataNodes?: number;
    readonly dataNodeSize?: OpsSize;
    readonly cloudProxies?: number;
    readonly cloudProxySize?: OpsCollectorSize;
  };
}

export interface SizingInput {
  readonly path: DeploymentPath;
  readonly profile: DeploymentProfile;
  /** How many VCF instances in the fleet. Each additional one is its own management domain. */
  readonly instanceCount: number;
  readonly topology: ClusterTopology;
  readonly storage: StorageType;
  /** Hosts in this management domain's cluster (total, across both AZs if stretched). */
  readonly hostCount: number;
  readonly host: HostSpec;

  /** Target VCF version: "9.1.0", "9.1.1", or a full "9.1.0.400". Default 9.1.1.0. */
  readonly version?: string;
  /** First (default) or additional instance in the fleet. */
  readonly instanceRole?: InstanceRole;
  /** Hosts for each additional instance when instanceCount > 1. Default: the smallest that works. */
  readonly additionalInstanceHostCount?: number;

  /** Tenant/workload data to be stored, in GiB, before RAID overhead. */
  readonly workloadCapacityGib?: number;
  /** Workload vCPU on the management domain (a converged cluster). */
  readonly workloadVcpu?: number;
  /** Workload RAM in GiB. */
  readonly workloadRamGib?: number;

  readonly includeEdgeCluster?: boolean;
  readonly edgeSize?: NsxEdgeSize;
  readonly edgeNodeCount?: number;
  /** Default true. Excluding subtracts the profile's Automation from the published total. */
  readonly includeAutomation?: boolean;
  /** Default: the profile's (S1). A different size adds or removes the difference. */
  readonly automationSize?: AutomationSize;
  /** 1 or 3. Default: the profile's. */
  readonly automationNodes?: 1 | 3;

  /** Target vCPU:physical-core ratio, measured with the failure reserve off. Default 2 (S7). */
  readonly targetCpuRatio?: number;
  /** Reserve capacity for one host failure (N+1). Default true. Superseded by hostFailuresToTolerate. */
  readonly reserveHostFailure?: boolean;
  /** 0, 1 (N+1) or 2 (N+2). Default 1, or 0 when reserveHostFailure is false. */
  readonly hostFailuresToTolerate?: 0 | 1 | 2;
  /** Number of physical NICs per host, for TEP IP pool sizing. */
  readonly pnicsPerHost?: number;
  /** NIC speed per host, Gbps, for the vSAN ESA ReadyNode check. */
  readonly nicSpeedGbps?: number;
  /** HA profile with a load balancer for Operations: one more FQDN. */
  readonly loadBalancer?: boolean;

  readonly vsan?: VsanOptions;
  readonly stretched?: StretchedOptions;
  readonly memoryTiering?: MemoryTieringInput;
  /** Growth applied to the tenant workloads and to every workload-domain cluster, at the horizon. */
  readonly growth?: GrowthInput;
  /** VI workload domains of this instance. Their vCenter and NSX Managers run here. */
  readonly workloadDomains?: readonly WorkloadDomainInput[];
  readonly addOns?: AddOnsInput;

  /** License as VCF Edge (8-core floor, S24 rules). */
  readonly vcfEdge?: boolean;
  /** VCF Edge sites, for the 10-site minimum. */
  readonly edgeSites?: number;
  readonly subscriptionYears?: number;
}

export interface ComponentLine {
  readonly name: string;
  readonly footprint: Footprint;
  readonly verification: Verification;
  readonly basis?: Basis;
  readonly sourceUrl?: string;
  readonly note?: string;
}

export interface CapacityResult {
  /** Physical cores across all hosts. */
  readonly physicalCores: number;
  /** Logical processors (physical x2 when SMT is on). Informational only. */
  readonly logicalProcessors: number;
  readonly totalRamGib: number;
  readonly totalRawStorageGib: number;
  /** Hosts left after the failure (and AZ) reserve. */
  readonly survivingHosts: number;
  readonly hostFailuresReserved: number;
  /** Share of the cluster held back: 33% at 3 hosts N+1, 25% at 4, 50% at 2 or for an AZ. */
  readonly haReserveFraction: number;
  /** Physical cores on the surviving hosts. */
  readonly usablePhysicalCores: number;
  /** DRAM on the surviving hosts. */
  readonly usableRamGib: number;
  /** DRAM plus the NVMe memory tier on the surviving hosts (= usableRamGib without tiering). */
  readonly usableMemoryGib: number;
  /** Raw vSAN capacity less the rebuild reserve (the failure hosts). */
  readonly usableRawStorageGib: number;
}

export interface StorageResult {
  readonly required: number;
  readonly architecture?: VsanArchitecture;
  readonly multiplier: number;
  readonly raid: string;
  readonly ftt: number;
  /** False when the host count cannot carry the policy. */
  readonly valid: boolean;
  /** Operations reserve fraction (default 0). Kept under its old name for callers. */
  readonly slackFraction: number;
  readonly dedupRatio: number;
  /** Raw capacity needed once RAID overhead, dedup and the operations reserve are applied. */
  readonly rawRequiredGib: number;
  readonly availableRawGib: number;
  /** Raw held back as the rebuild reserve (the failure hosts). */
  readonly rebuildReserveGib: number;
  /** Data the cluster can hold after RAID, reserve and dedup. */
  readonly effectiveCapacityGib: number;
  readonly sufficient: boolean;
  readonly basis: Basis;
  readonly note: string;
}

export interface LicensingResult {
  /** Cores actually present. */
  readonly physicalCores: number;
  /** Cores billed, after applying the per-CPU floor. */
  readonly billableCores: number;
  readonly minPerCpuApplied: number;
  /** Extra cores paid for but not present, due to the floor. */
  readonly floorPenaltyCores: number;
  /** vSAN included with the cores: 1 TiB per licensed core (S12b). */
  readonly vsanEntitlementTib: number;
  /** Raw vSAN capacity, TiB (0 for external storage). */
  readonly vsanRawTib: number;
  /** vSAN capacity beyond the entitlement, TiB. Metering on raw is unconfirmed (KB 95927). */
  readonly vsanAddOnTib: number;
}

export interface IpRequirements {
  readonly role: InstanceRole;
  readonly hostVmkernelPerHost: number;
  readonly hostIps: number;
  readonly tepIps: number;
  readonly edgeTepIps: number;
  readonly vcfmsIps: number;
  readonly vcfmsRecommended: number;
  readonly automationIps: number;
  readonly logManagementIps: number;
  readonly realTimeMetricsIps: number;
  readonly componentFqdns: number;
  readonly totalMinimum: number;
  readonly totalRecommended: number;
}

export interface AutomationResult {
  readonly applicable: boolean;
  readonly included: boolean;
  readonly profileDefault: { readonly size: AutomationSize; readonly nodes: number };
  readonly size: AutomationSize;
  readonly nodes: number;
  /** What was added to (or, negative, taken off) the published total. */
  readonly delta: Footprint;
  readonly basis: Basis;
}

export interface WorkloadClusterResult {
  readonly name: string;
  /** Demand after growth, plus edges and Supervisor where placed here. */
  readonly demand: Footprint;
  readonly hosts: number;
  readonly byCpu: number;
  readonly byMemory: number;
  readonly byStorage: number;
  readonly minimum: number;
  readonly binding: 'cpu' | 'memory' | 'storage' | 'minimum' | 'fixed';
  readonly capacity: CapacityResult;
  readonly cpuRatio: number;
  readonly memoryUtilization: number;
  readonly storage: StorageResult;
  readonly licensing: LicensingResult;
  readonly hostIps: number;
  readonly tepIps: number;
  readonly witness?: ComponentLine;
  readonly components: readonly ComponentLine[];
  readonly findings: readonly Finding[];
}

export interface WorkloadDomainResult {
  readonly name: string;
  readonly vcenterSize: VcenterSize;
  /** vCenter and NSX Manager lines placed in the management domain. */
  readonly managementOverhead: readonly ComponentLine[];
  readonly overheadFootprint: Footprint;
  readonly clusters: readonly WorkloadClusterResult[];
  readonly hosts: number;
  readonly edgeTepIps: number;
  readonly findings: readonly Finding[];
}

export interface SizingResult {
  readonly input: SizingInput;
  readonly version: string;
  readonly release: VcfRelease;
  readonly role: InstanceRole;
  /** This instance's management plane (the published aggregate, Automation-adjusted). */
  readonly managementFootprint: Footprint;
  readonly components: readonly ComponentLine[];
  /** Per-appliance view of the published aggregate, with provenance per line. */
  readonly breakdown: readonly ComponentLine[];
  readonly totalDemand: Footprint;
  readonly capacity: CapacityResult;
  /** vCPU per physical core on the surviving hosts. */
  readonly cpuRatio: number;
  /** Memory demand over usable memory (DRAM plus tier) on the surviving hosts. */
  readonly memoryUtilization: number;
  /** With memory tiering: DRAM-resident demand over surviving DRAM. */
  readonly dramUtilization?: number;
  readonly storage: StorageResult;
  readonly licensing: LicensingResult;
  readonly ips: IpRequirements;
  readonly hostMinimum: HostMinimum;
  readonly automation: AutomationResult;
  readonly workloadDomains: readonly WorkloadDomainResult[];
  /** vSAN witness at a third site, for a stretched vSAN cluster (not in the cluster demand). */
  readonly witness?: ComponentLine;
  /** Present when instanceCount > 1: every instance as its own management domain. */
  readonly fleet?: FleetResult;
  readonly findings: readonly Finding[];
  readonly verification: Verification;
}

/** Default management-domain vCPU:physical-core target. [V-DOC S7] */
export const DEFAULT_TARGET_CPU_RATIO = 2;
/** Memory utilization above which the engine warns. Toolkit threshold. */
export const MEMORY_WARN_UTILIZATION = 0.8;
/** Toolkit defaults for workload clusters (not Broadcom figures). */
export const WORKLOAD_CLUSTER_DEFAULTS = { cpuRatio: 4, memoryCeiling: 0.9, hostFailures: 1 } as const;

const EXTERNAL: readonly StorageType[] = ['nfs', 'vmfs-fc'];

function isExternal(storage: StorageType): boolean {
  return EXTERNAL.includes(storage);
}

function isVsan(storage: StorageType): boolean {
  return !isExternal(storage);
}

function coresPerHost(host: HostSpec): number {
  return host.cpuSockets * host.coresPerCpu;
}

function line(name: string, footprint: Footprint, entry: Partial<SizedEntry> | undefined, note?: string): ComponentLine {
  return {
    name,
    footprint,
    verification: entry?.verification ?? 'I',
    basis: entry?.basis ?? 'unconfirmed',
    ...(entry?.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
    ...(note ?? entry?.note ? { note: note ?? entry?.note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** The failures to reserve for an input. */
export function hostFailures(input: Pick<SizingInput, 'reserveHostFailure' | 'hostFailuresToTolerate'>): number {
  if (input.hostFailuresToTolerate !== undefined) return input.hostFailuresToTolerate;
  return input.reserveHostFailure === false ? 0 : 1;
}

/**
 * Minimum hosts, by domain, storage, topology and profile (S4, S5, S6). The
 * brownfield-import path is a workload domain. Two-node is not a management
 * topology; for one, the standard minimum is returned and the engine flags it.
 */
export function minimumHosts(
  input: Pick<SizingInput, 'path' | 'storage' | 'topology'> & { readonly profile?: DeploymentProfile; readonly role?: DomainRole },
): HostMinimum {
  const role: DomainRole = input.role ?? (input.path === 'brownfield-import' ? 'workload' : 'management');
  const ext = isExternal(input.storage);
  if (role === 'workload') {
    if (input.topology === 'two-node') return HOST_MINIMUMS['workload-two-node'];
    if (input.topology === 'stretched') return ext ? HOST_MINIMUMS['workload-external-stretched'] : HOST_MINIMUMS['workload-vsan-stretched'];
    return ext ? HOST_MINIMUMS['workload-external'] : HOST_MINIMUMS['workload-vsan'];
  }
  const ha = isHaProfile(input.profile ?? 'simple');
  if (input.topology === 'stretched') {
    if (ext) return ha ? HOST_MINIMUMS['management-external-stretched-ha'] : HOST_MINIMUMS['management-external-stretched-simple'];
    return ha ? HOST_MINIMUMS['management-vsan-stretched-ha'] : HOST_MINIMUMS['management-vsan-stretched-simple'];
  }
  if (ext) return ha ? HOST_MINIMUMS['management-external-ha'] : HOST_MINIMUMS['management-external-simple'];
  return ha ? HOST_MINIMUMS['management-vsan-ha'] : HOST_MINIMUMS['management-vsan-simple'];
}

/**
 * Aggregate management-plane footprint across a fleet: the first instance plus
 * each additional one. Each instance still needs its own hosts — see sizeFleet.
 */
export function fleetFootprint(
  profile: DeploymentProfile,
  instanceCount: number,
  version?: string,
): { footprint: Footprint; verification: Verification; basis: Basis } {
  const count = Math.max(1, Math.floor(instanceCount));
  const release = vcfRelease(version);
  const first = fleetEntry(release, profile, 'first') ?? FLEET_FIRST_INSTANCE_911[profile];
  const additional = fleetEntry(release, profile, 'additional') ?? FLEET_ADDITIONAL_INSTANCE_911[profile];
  const footprint = addFootprints(footprintOf(first), scaleFootprint(footprintOf(additional), count - 1));
  const used = count > 1 ? [first, additional] : [first];
  return {
    footprint,
    verification: weakestVerification(used.map((e) => e.verification)),
    basis: weakestBasis(used.map((e) => e.basis)),
  };
}

/** Compounded growth factor. */
function growthFactor(pct: number | undefined, years: number | undefined): number {
  const y = Math.max(0, years ?? 0);
  return Math.pow(1 + Math.max(0, pct ?? 0) / 100, y);
}

/** Growth factors for CPU, RAM and storage at the horizon. */
export function growthFactors(growth: GrowthInput | undefined): { cpu: number; ram: number; storage: number } {
  return {
    cpu: growthFactor(growth?.cpuPct, growth?.years),
    ram: growthFactor(growth?.ramPct, growth?.years),
    storage: growthFactor(growth?.storagePct, growth?.years),
  };
}

export function computeCapacity(
  hostCount: number,
  host: HostSpec,
  reserveFailure: boolean | number,
  options: { topology?: ClusterTopology; reserveAzFailure?: boolean; tieringRatio?: number } = {},
): CapacityResult {
  const failures = typeof reserveFailure === 'number' ? reserveFailure : reserveFailure ? 1 : 0;
  const physicalCores = hostCount * coresPerHost(host);
  const logicalProcessors = physicalCores * (host.hyperthreading ? 2 : 1);
  const totalRamGib = hostCount * host.ramGib;
  const totalRawStorageGib = hostCount * host.rawStorageGib;

  let surviving = Math.max(0, hostCount - failures);
  // A stretched cluster reserves a whole availability zone (S5).
  if (options.topology === 'stretched' && options.reserveAzFailure !== false) {
    surviving = Math.min(surviving, Math.floor(hostCount / 2));
  }
  const tier = options.tieringRatio ?? 0;
  return {
    physicalCores,
    logicalProcessors,
    totalRamGib,
    totalRawStorageGib,
    survivingHosts: surviving,
    hostFailuresReserved: failures,
    haReserveFraction: hostCount > 0 ? 1 - surviving / hostCount : 1,
    usablePhysicalCores: surviving * coresPerHost(host),
    usableRamGib: surviving * host.ramGib,
    usableMemoryGib: surviving * host.ramGib * (1 + tier),
    usableRawStorageGib: Math.max(0, hostCount - failures) * host.rawStorageGib,
  };
}

/**
 * Licensing for one cluster: per-core with a 16-core-per-CPU floor (8 for VCF
 * Edge), and the 1 TiB of vSAN per licensed core. [S12, S12b, S24]
 */
export function computeLicensing(hostCount: number, host: HostSpec, isEdge = false, vsan = false): LicensingResult {
  const floor = isEdge ? LICENSE_MIN_CORES_PER_CPU_EDGE : LICENSE_MIN_CORES_PER_CPU;
  const physicalCores = hostCount * host.cpuSockets * host.coresPerCpu;
  const billedPerCpu = Math.max(host.coresPerCpu, floor);
  const billableCores = hostCount * host.cpuSockets * billedPerCpu;
  const vsanRawTib = vsan ? (hostCount * host.rawStorageGib) / 1024 : 0;
  const vsanEntitlementTib = billableCores * VSAN_TIB_PER_CORE;
  return {
    physicalCores,
    billableCores,
    minPerCpuApplied: floor,
    floorPenaltyCores: billableCores - physicalCores,
    vsanEntitlementTib,
    vsanRawTib,
    vsanAddOnTib: Math.max(0, Math.ceil(vsanRawTib - vsanEntitlementTib)),
  };
}

/** Where log management runs: it is sized on that instance's VCFMS workers. */
export interface LogContext {
  readonly version?: string;
  readonly profile?: DeploymentProfile;
  readonly role?: InstanceRole;
}

/**
 * Log management replicas, the VCFMS workers they add, disk and addresses.
 * The workers are the workbook's: the replicas' vCPU and RAM are Day-N load on
 * the instance's VCFMS workers (`vcfmsFootprint`), and the extra workers are the
 * difference. Default context: 9.1.1, Simple, first instance.
 */
export function logManagementPlan(input: LogManagementInput, context: LogContext = {}): {
  size: LogReplicaSize;
  replicas: number;
  workers: number;
  footprint: Footprint;
  diskPerReplicaGib: number;
  ips: number;
  findings: Finding[];
} {
  const findings: Finding[] = [];
  const size = input.replicaSize ?? 'small';
  const spec = LOG_MANAGEMENT_REPLICAS[size];
  const release = vcfRelease(context.version);
  const profile = context.profile ?? 'simple';
  const role = context.role ?? 'first';
  let replicas = input.replicas ?? Math.max(spec.minReplicas, Math.ceil((input.eps ?? 0) / spec.eps));
  if (input.nPlusOne) replicas += 1;
  if (replicas < spec.minReplicas) {
    findings.push(warning('vcf.addon.log-replicas-min', `A ${size} log management deployment needs at least ${spec.minReplicas} replicas; ${replicas} configured.`, { source: SOURCES.logManagement }));
    replicas = spec.minReplicas;
  }
  if (replicas > spec.maxReplicas) {
    findings.push(error('vcf.addon.log-replicas-max', `Log management tops out at ${spec.maxReplicas} ${size} replicas; ${replicas} are needed.`, { remediation: 'Use a larger replica size.', source: SOURCES.logManagement }));
  }
  const order: Record<LogReplicaSize, number> = { small: 0, medium: 1, large: 2 };
  if (order[size] > order[profileSize(profile)]) {
    findings.push(warning('vcf.addon.log-size-over-profile', `Log management ${size} is larger than the ${profile} profile; the workbook says it should be the same size or smaller.`, { source: workbookUrl(release) }));
  }
  const base = vcfmsFootprint(release, profile, role);
  const withLogs = vcfmsFootprint(release, profile, role, { logReplicas: replicas, logSize: size });
  const workers = withLogs.workers - base.workers;
  const wbDisk = logReplicaDiskGib(release, size);
  const total = input.dailyGib && input.retentionDays ? input.dailyGib * input.retentionDays : 0;
  const perReplica = Math.min(LOG_MANAGEMENT_DISK_PER_REPLICA_GIB.max, Math.max(wbDisk, total / Math.max(1, replicas)));
  if (total / Math.max(1, replicas) > LOG_MANAGEMENT_DISK_PER_REPLICA_GIB.max) {
    findings.push(warning('vcf.addon.log-retention', `Retention needs ${Math.round(total / replicas)} GB per replica, over the ${LOG_MANAGEMENT_DISK_PER_REPLICA_GIB.max} GB maximum.`, { remediation: 'Add replicas or shorten retention.', source: SOURCES.logManagement }));
  }
  const added = subtractFootprints(withLogs.total, base.total);
  return {
    size,
    replicas,
    workers,
    footprint: { vcpu: added.vcpu, ramGib: added.ramGib, diskGib: perReplica * replicas },
    diskPerReplicaGib: perReplica,
    ips: LOG_MANAGEMENT_BASE_IPS + LOG_MANAGEMENT_IPS_PER_REPLICA * replicas,
    findings,
  };
}

/**
 * Address counts, per family. IPv4 counts; on dual stack the host, VCFMS and
 * component counts apply again inside each network's IPv6 prefix.
 */
export function computeIpRequirements(input: SizingInput): IpRequirements {
  const role = input.instanceRole ?? 'first';
  const pnics = input.pnicsPerHost ?? 2;
  const perHost = hostVmkernelIps(input.storage);
  const hostIps = input.hostCount * perHost;
  const tepIps = input.hostCount * pnics;
  const edgeTepIps = input.includeEdgeCluster ? (input.edgeNodeCount ?? 2) * EDGE_TEP_IPS_PER_NODE : 0;
  const version = fullVcfVersion(input.version);
  const automationIps = role === 'first' && input.includeAutomation !== false ? automationIpCount(version) : 0;
  const ha = isHaProfile(input.profile);
  const componentFqdns =
    role === 'first'
      ? ha
        ? input.loadBalancer
          ? FIRST_INSTANCE_FQDNS.haWithLoadBalancer
          : FIRST_INSTANCE_FQDNS.ha
        : FIRST_INSTANCE_FQDNS.simple
      : ha
        ? ADDITIONAL_INSTANCE_FQDNS.ha
        : ADDITIONAL_INSTANCE_FQDNS.simple;
  const logManagementIps = input.addOns?.logManagement ? logManagementPlan(input.addOns.logManagement, { version, profile: input.profile, role }).ips : 0;
  const realTimeMetricsIps = input.addOns?.realTimeMetrics ? REAL_TIME_METRICS_IPS : 0;
  const fixed = hostIps + tepIps + edgeTepIps + automationIps + componentFqdns + logManagementIps + realTimeMetricsIps;
  return {
    role,
    hostVmkernelPerHost: perHost,
    hostIps,
    tepIps,
    edgeTepIps,
    vcfmsIps: VCFMS_MIN_IPS,
    vcfmsRecommended: VCFMS_RECOMMENDED_IPS,
    automationIps,
    logManagementIps,
    realTimeMetricsIps,
    componentFqdns,
    totalMinimum: fixed + VCFMS_MIN_IPS,
    totalRecommended: fixed + VCFMS_RECOMMENDED_IPS,
  };
}

/** vSAN (or external) storage for a cluster. */
export function computeStorage(
  storage: StorageType,
  topology: ClusterTopology,
  hostCount: number,
  host: HostSpec,
  failures: number,
  requiredGib: number,
  vsan: VsanOptions = {},
): StorageResult {
  const hostsPerSite = topology === 'stretched' ? Math.floor(hostCount / 2) : hostCount;
  const architecture: VsanArchitecture = storage === 'vsan-osa' ? 'osa' : 'esa';
  const dedupRatio = Math.max(1, vsan.dedupRatio ?? VSAN_DEDUP_RATIO_DEFAULT);
  const workbookModel = vsan.model === 'workbook';
  const reserve = Math.min(0.9, Math.max(0, vsan.operationsReserve ?? VSAN_OPERATIONS_RESERVE_DEFAULT));
  if (isExternal(storage)) {
    return {
      required: requiredGib,
      multiplier: 1,
      raid: 'External array',
      ftt: 1,
      valid: true,
      slackFraction: 0,
      dedupRatio: 1,
      rawRequiredGib: requiredGib,
      availableRawGib: Number.POSITIVE_INFINITY,
      rebuildReserveGib: 0,
      effectiveCapacityGib: Number.POSITIVE_INFINITY,
      sufficient: true,
      basis: 'derived',
      note: 'Capacity and protection are the array’s; not modelled here.',
    };
  }
  const overhead = raidOverhead(topology, hostsPerSite, architecture, vsan.osaPolicy);
  const wbFactor = (1 + VSAN_WORKBOOK_HOST_AND_OPERATIONS_RESERVE) * (1 + VSAN_WORKBOOK_STORAGE_GROWTH);
  const rawRequiredGib = workbookModel
    ? ((requiredGib + (vsan.swapGib ?? 0)) * overhead.multiplier * wbFactor) / dedupRatio
    : (requiredGib * overhead.multiplier) / dedupRatio / (1 - reserve);
  const availableRawGib = Math.max(0, hostCount - (workbookModel ? Math.max(1, failures) : failures)) * host.rawStorageGib;
  const effectiveCapacityGib = workbookModel
    ? (availableRawGib * dedupRatio) / overhead.multiplier / wbFactor
    : (availableRawGib * (1 - reserve) * dedupRatio) / overhead.multiplier;
  return {
    required: requiredGib,
    architecture,
    multiplier: overhead.multiplier,
    raid: overhead.raid,
    ftt: overhead.ftt,
    valid: overhead.valid,
    slackFraction: workbookModel ? VSAN_WORKBOOK_HOST_AND_OPERATIONS_RESERVE : reserve,
    dedupRatio,
    rawRequiredGib,
    availableRawGib,
    rebuildReserveGib: Math.min(hostCount, failures) * host.rawStorageGib,
    effectiveCapacityGib,
    sufficient: availableRawGib >= rawRequiredGib,
    basis: workbookModel ? weakestBasis([overhead.basis, 'published']) : weakestBasis([overhead.basis, 'derived']),
    note: `${architecture === 'esa' ? 'vSAN ESA Auto-RAID' : 'vSAN OSA (no Auto-RAID)'}: ${overhead.raid} at ${overhead.multiplier.toFixed(2)}x${dedupRatio > 1 ? `, ${dedupRatio}:1 dedup/compression assumed` : ''}. ${workbookModel ? `Workbook model: swap included, ×${1 + VSAN_WORKBOOK_HOST_AND_OPERATIONS_RESERVE} host-and-operations reserve, ×${1 + VSAN_WORKBOOK_STORAGE_GROWTH} growth, over N-1 hosts.` : VSAN_RESERVE_NOTE}${overhead.note ? ` ${overhead.note}` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Cluster fitting (shared by workload domains and the estate plan)
// ---------------------------------------------------------------------------

export interface ClusterDemand {
  readonly vcpu: number;
  /** All memory demand. */
  readonly ramGib: number;
  readonly storageGib: number;
  /** Memory that must sit in DRAM (appliances, reserved VMs). Default: all, when tiering is off. */
  readonly dramRamGib?: number;
}

export interface ClusterFitOptions {
  readonly host: HostSpec;
  readonly storage: StorageType;
  readonly topology?: ClusterTopology;
  readonly cpuRatio: number;
  readonly memoryCeiling: number;
  readonly hostFailures: number;
  readonly vsan?: VsanOptions;
  readonly tieringRatio?: number;
  readonly reserveAzFailure?: boolean;
  readonly minimum: number;
  readonly ceiling?: number;
}

export interface ClusterFit {
  readonly hosts: number;
  readonly byCpu: number;
  readonly byMemory: number;
  readonly byStorage: number;
  readonly minimum: number;
  readonly binding: 'cpu' | 'memory' | 'storage' | 'minimum';
  readonly raid?: string;
}

function fits(n: number, d: ClusterDemand, o: ClusterFitOptions): { cpu: boolean; memory: boolean; storage: boolean } {
  const cap = computeCapacity(n, o.host, o.hostFailures, {
    topology: o.topology ?? 'standard',
    reserveAzFailure: o.reserveAzFailure !== false,
    tieringRatio: o.tieringRatio ?? 0,
  });
  const cpu = d.vcpu <= 0 || d.vcpu <= o.cpuRatio * cap.usablePhysicalCores;
  const memory =
    d.ramGib <= 0 ||
    (d.ramGib <= o.memoryCeiling * cap.usableMemoryGib && (d.dramRamGib ?? 0) <= o.memoryCeiling * cap.usableRamGib);
  let storage = true;
  if (isVsan(o.storage) && d.storageGib > 0 && o.host.rawStorageGib > 0) {
    const s = computeStorage(o.storage, o.topology ?? 'standard', n, o.host, o.hostFailures, d.storageGib, o.vsan);
    storage = s.valid && s.sufficient;
  }
  return { cpu, memory, storage };
}

function firstFit(pred: (n: number) => boolean, start: number, ceiling: number, step = 1): number {
  for (let n = Math.max(1, start); n <= ceiling; n += step) if (pred(n)) return n;
  return ceiling + 1;
}

/** The smallest cluster for a demand, with what binds it. */
export function fitCluster(demand: ClusterDemand, o: ClusterFitOptions): ClusterFit {
  const ceiling = o.ceiling ?? 10_000;
  const stretched = o.topology === 'stretched';
  const start = stretched ? 2 : 1;
  const step = stretched ? 2 : 1;
  const byCpu = demand.vcpu > 0 ? firstFit((n) => fits(n, demand, o).cpu, start, ceiling, step) : 0;
  const byMemory = demand.ramGib > 0 ? firstFit((n) => fits(n, demand, o).memory, start, ceiling, step) : 0;
  const byStorage =
    isVsan(o.storage) && demand.storageGib > 0 && o.host.rawStorageGib > 0
      ? firstFit((n) => fits(n, demand, o).storage, stretched ? 2 : 3, ceiling, step)
      : 0;
  let hosts = Math.max(byCpu, byMemory, byStorage, o.minimum);
  if (stretched && hosts % 2 !== 0) hosts += 1;
  // Constraints interact only through the host count; confirm the chosen size holds.
  while (hosts <= ceiling) {
    const f = fits(hosts, demand, o);
    if (f.cpu && f.memory && f.storage) break;
    hosts += step;
  }
  const binding: ClusterFit['binding'] =
    hosts === o.minimum && o.minimum > Math.max(byCpu, byMemory, byStorage)
      ? 'minimum'
      : hosts === byStorage && byStorage >= Math.max(byCpu, byMemory)
        ? 'storage'
        : hosts === byMemory && byMemory >= byCpu
          ? 'memory'
          : 'cpu';
  const raid =
    isVsan(o.storage)
      ? raidOverhead(o.topology ?? 'standard', stretched ? Math.floor(hosts / 2) : hosts, o.storage === 'vsan-osa' ? 'osa' : 'esa', o.vsan?.osaPolicy).raid
      : undefined;
  return { hosts, byCpu, byMemory, byStorage, minimum: o.minimum, binding, ...(raid ? { raid } : {}) };
}

function tieringRatioOf(t: MemoryTieringInput | undefined): number {
  return t?.enabled ? (t.ratio ?? MEMORY_TIERING_DEFAULT_RATIO) : 0;
}

function tieringFindings(t: MemoryTieringInput | undefined, version: string, path: string): Finding[] {
  if (!t?.enabled) return [];
  const out: Finding[] = [];
  const ratio = t.ratio ?? MEMORY_TIERING_DEFAULT_RATIO;
  if (ratio <= 0 || ratio > MEMORY_TIERING_MAX_RATIO) {
    out.push(error('vcf.tiering.ratio', `The NVMe memory tier is ${ratio}× DRAM; vSphere 9.1 allows up to ${MEMORY_TIERING_MAX_RATIO}× (1:${MEMORY_TIERING_MAX_RATIO}).`, { path, source: SOURCES.memoryTiering }));
  }
  if (t.nvmeSharedWithVsan) {
    out.push(error('vcf.tiering.nvme-shared', 'The memory-tiering NVMe device must not also be a vSAN device.', { path, source: SOURCES.memoryTiering }));
  }
  if (!atLeastVcfVersion(version, MEMORY_TIERING_HA_VERSION)) {
    out.push(warning('vcf.tiering.no-ha-support', 'Before 9.1.1, DRS and HA do not account for memory tiering; HA admission control may admit more than DRAM can hold.', { path, remediation: 'Target 9.1.1, or size on DRAM alone.', source: SOURCES.vcenter911Notes }));
  }
  return out;
}

/**
 * Size one workload-domain cluster from a manual demand: the smallest host
 * count (or the given one), N+1 or N+2, vSAN per architecture, growth and
 * memory tiering.
 */
export function sizeWorkloadCluster(
  c: WorkloadClusterInput,
  extra: { readonly lines?: readonly ComponentLine[] } = {},
): WorkloadClusterResult {
  const findings: Finding[] = [];
  const name = c.name ?? 'cluster';
  const version = fullVcfVersion(c.version);
  const topology = c.topology ?? 'standard';
  const failures = c.hostFailures ?? WORKLOAD_CLUSTER_DEFAULTS.hostFailures;
  const cpuRatio = c.cpuRatio ?? WORKLOAD_CLUSTER_DEFAULTS.cpuRatio;
  const memoryCeiling = c.memoryCeiling ?? WORKLOAD_CLUSTER_DEFAULTS.memoryCeiling;
  const g = growthFactors(c.growth);
  const tier = tieringRatioOf(c.memoryTiering);
  const active = c.memoryTiering?.activeMemoryFraction ?? 0.5;

  const workload: Footprint = { vcpu: c.vcpu * g.cpu, ramGib: c.ramGib * g.ram, diskGib: c.storageGib * g.storage };
  const components: ComponentLine[] = [
    { name: 'Workloads', footprint: workload, verification: 'I', basis: 'derived', note: g.cpu > 1 || g.ram > 1 || g.storage > 1 ? `Grown over ${c.growth?.years ?? 0} year(s)` : 'As entered' },
    ...(extra.lines ?? []),
  ];
  const overhead = (extra.lines ?? []).reduce((s, l) => addFootprints(s, l.footprint), ZERO_FOOTPRINT);
  const demand = addFootprints(workload, overhead);
  // Appliances (edges, Supervisor) sit in DRAM; workloads only their active share with tiering.
  const dramRamGib = tier > 0 ? overhead.ramGib + workload.ramGib * active : demand.ramGib;

  const min = minimumHosts({ path: 'brownfield-import', storage: c.storage, topology, role: 'workload' });
  const fitOptions: ClusterFitOptions = {
    host: c.host,
    storage: c.storage,
    topology,
    cpuRatio,
    memoryCeiling,
    hostFailures: failures,
    ...(c.vsan ? { vsan: c.vsan } : {}),
    tieringRatio: tier,
    reserveAzFailure: c.stretched?.reserveAzFailure !== false,
    minimum: min.hosts,
  };
  const d: ClusterDemand = { vcpu: demand.vcpu, ramGib: demand.ramGib, storageGib: demand.diskGib, dramRamGib };
  const fit = fitCluster(d, fitOptions);
  const hosts = c.hosts ?? fit.hosts;

  const capacity = computeCapacity(hosts, c.host, failures, { topology, reserveAzFailure: c.stretched?.reserveAzFailure !== false, tieringRatio: tier });
  const cpuUsed = capacity.usablePhysicalCores > 0 ? demand.vcpu / capacity.usablePhysicalCores : Number.POSITIVE_INFINITY;
  const memoryUtilization = capacity.usableMemoryGib > 0 ? demand.ramGib / capacity.usableMemoryGib : Number.POSITIVE_INFINITY;
  const storage = computeStorage(c.storage, topology, hosts, c.host, failures, demand.diskGib, c.vsan);
  const licensing = computeLicensing(hosts, c.host, false, isVsan(c.storage));

  if (c.hosts !== undefined) {
    const f = fits(hosts, d, fitOptions);
    if (hosts < min.hosts) findings.push(error('vcf.wld.below-minimum', `${name}: ${hosts} hosts is below the ${min.hosts}-host minimum.`, { source: min.source }));
    if (!f.cpu) findings.push(warning('vcf.wld.cpu', `${name}: ${cpuUsed.toFixed(2)} vCPU per physical core with ${failures} host(s) down, above ${cpuRatio}:1.`, {}));
    if (!f.memory) findings.push(error('vcf.wld.memory', `${name}: memory demand exceeds ${Math.round(memoryCeiling * 100)}% of what survives ${failures} host failure(s).`, {}));
    if (!f.storage) findings.push(error('vcf.wld.storage', `${name}: vSAN needs ${Math.round(storage.rawRequiredGib)} GiB raw but ${Math.round(storage.availableRawGib)} GiB is available after the rebuild reserve.`, {}));
  }
  if (topology === 'two-node') {
    findings.push(warning('vcf.wld.two-node-unconfirmed', `${name}: a 2-node vSAN cluster is not a documented VCF 9.1 cluster model; support in a 9.1 workload domain is unconfirmed.`, {}));
  }
  if (isVsan(c.storage) && topology === 'standard' && hosts < 3) {
    findings.push(error('vcf.wld.vsan-under-three', `${name}: a vSAN cluster under 3 hosts runs FTT=0 and is not a valid VCF domain cluster.`, { source: SOURCES.autoRaid }));
  }
  if (!storage.valid && hosts >= 3) {
    findings.push(error('vcf.wld.policy-needs-more-hosts', `${name}: ${storage.raid} needs more hosts than ${hosts}.`, {}));
  }
  if (c.storage === 'vsan-esa' && c.host.ramGib < VSAN_ESA_MIN_HOST_RAM_GIB) {
    findings.push(error('vcf.wld.esa-host-ram', `${name}: vSAN ESA requires at least ${VSAN_ESA_MIN_HOST_RAM_GIB} GiB per host.`, { source: SOURCES.esxDesign }));
  }
  if (c.storage === 'vsan-esa' && c.nicSpeedGbps !== undefined && c.nicSpeedGbps <= VSAN_ESA_AF0_MAX_NIC_GBPS) {
    findings.push(warning('vcf.wld.esa-10gbe', `${name}: on ${c.nicSpeedGbps} GbE only the vSAN ESA-AF-0 ReadyNode profile is allowed.`, { source: SOURCES.storageModels }));
  }
  if (tier > 0) {
    findings.push(...tieringFindings(c.memoryTiering, version, 'memoryTiering'));
    if (workload.ramGib * active > MEMORY_TIERING_MAX_ACTIVE_FRACTION * capacity.totalRamGib) {
      findings.push(warning('vcf.wld.tiering-active', `${name}: active memory exceeds half of DRAM, where memory tiering stops helping.`, { source: SOURCES.memoryTiering }));
    }
  }
  if (fit.hosts > 10_000) findings.push(error('vcf.wld.unfittable', `${name}: no cluster size fits this demand on this host.`, {}));

  let witness: ComponentLine | undefined;
  if (topology === 'stretched' && isVsan(c.storage)) {
    const w = VSAN_WITNESS_SIZES[c.stretched?.witnessSize ?? 'medium'];
    witness = line(`vSAN witness (${c.stretched?.witnessSize ?? 'medium'}, third site)`, footprintOf(w), w);
  }
  const pnics = c.pnicsPerHost ?? 2;

  return {
    name,
    demand,
    hosts,
    byCpu: fit.byCpu,
    byMemory: fit.byMemory,
    byStorage: fit.byStorage,
    minimum: min.hosts,
    binding: c.hosts !== undefined ? 'fixed' : fit.binding,
    capacity,
    cpuRatio: cpuUsed,
    memoryUtilization,
    storage,
    licensing,
    hostIps: hosts * hostVmkernelIps(c.storage),
    tepIps: hosts * pnics,
    ...(witness ? { witness } : {}),
    components,
    findings,
  };
}

/** A workload domain: its clusters, and the vCenter and NSX Managers it puts in the management domain. */
export function sizeWorkloadDomain(
  d: WorkloadDomainInput,
  context: { readonly version?: string; readonly index?: number; readonly nsxProvider?: string } = {},
): WorkloadDomainResult {
  const findings: Finding[] = [];
  const name = d.name ?? `wld${String((context.index ?? 0) + 1).padStart(2, '0')}`;

  // Edges and Supervisor control planes run in the domain's first cluster.
  const placed: ComponentLine[] = [];
  let edgeTepIps = 0;
  if (d.edgeCluster) {
    const e = NSX_EDGE_SIZES[d.edgeCluster.size];
    placed.push(line(`NSX Edge cluster (${d.edgeCluster.nodes} × ${d.edgeCluster.size})`, scaleFootprint(footprintOf(e), d.edgeCluster.nodes), e, 'Edge nodes reserve 100% of their memory'));
    edgeTepIps = d.edgeCluster.nodes * EDGE_TEP_IPS_PER_NODE;
    if (d.edgeCluster.nodes < NSX_EDGE_CLUSTER_MIN_NODES || d.edgeCluster.nodes > NSX_EDGE_CLUSTER_MAX_NODES) {
      findings.push(warning('vcf.wld.edge-nodes', `${name}: an NSX Edge cluster takes ${NSX_EDGE_CLUSTER_MIN_NODES}–${NSX_EDGE_CLUSTER_MAX_NODES} nodes; ${d.edgeCluster.nodes} configured.`, { source: SOURCES.edgeVm }));
    }
  }
  if (d.supervisor && d.supervisor.count > 0) {
    const s = SUPERVISOR_CP_SIZES[d.supervisor.size];
    const vms = d.supervisor.controlPlaneVms ?? 3;
    placed.push(line(`Supervisor control plane (${d.supervisor.count} × ${vms} × ${d.supervisor.size})`, scaleFootprint(footprintOf(s), d.supervisor.count * vms), s));
  }

  const clusterInputs = d.clusters ?? [];
  const clusters = clusterInputs.map((c, i) =>
    sizeWorkloadCluster({ ...c, ...(context.version && !c.version ? { version: context.version } : {}), name: c.name ?? `${name}-cl${String(i + 1).padStart(2, '0')}` }, i === 0 ? { lines: placed } : {}),
  );
  if (clusterInputs.length === 0 && placed.length > 0) {
    findings.push(info('vcf.wld.no-cluster-for-placement', `${name}: edges or Supervisor are configured but no cluster is sized to carry them.`, {}));
  }
  for (const c of clusters) findings.push(...c.findings);
  const hosts = clusters.length > 0 ? clusters.reduce((s, c) => s + c.hosts, 0) : (d.hosts ?? 0);
  const vms = d.vms ?? 0;

  const auto = vcenterSizeFor(hosts, vms);
  const vcenterSize = d.vcenterSize ?? auto ?? 'xlarge';
  if (!auto) {
    findings.push(error('vcf.wld.vcenter-capacity', `${name}: ${hosts} hosts / ${vms} VMs exceed an X-Large vCenter (${VCENTER_CAPACITY.xlarge.hosts} hosts / ${VCENTER_CAPACITY.xlarge.vms} VMs).`, { remediation: 'Split the domain.', source: SOURCES.vcenterHardware }));
  } else if (d.vcenterSize && (VCENTER_CAPACITY[d.vcenterSize].hosts < hosts || VCENTER_CAPACITY[d.vcenterSize].vms < vms)) {
    findings.push(warning('vcf.wld.vcenter-too-small', `${name}: a ${d.vcenterSize} vCenter manages ${VCENTER_CAPACITY[d.vcenterSize].hosts} hosts / ${VCENTER_CAPACITY[d.vcenterSize].vms} VMs; this domain has ${hosts} / ${vms}. ${auto} is needed.`, { source: SOURCES.vcenterHardware }));
  }
  const vc = VCENTER_SIZES[vcenterSize];
  const managementOverhead: ComponentLine[] = [line(`${name}: vCenter (${vcenterSize})`, footprintOf(vc), vc)];
  if ((d.nsx ?? 'dedicated') === 'dedicated') {
    const size = d.nsxSize ?? 'medium';
    const nodes = d.nsxNodes ?? 3;
    const nsx = NSX_MANAGER_SIZES[size];
    managementOverhead.push(line(`${name}: NSX Manager (${nodes} × ${size})`, scaleFootprint(footprintOf(nsx), nodes), nsx));
  } else if (!context.nsxProvider) {
    findings.push(warning('vcf.wld.nsx-shared-without-provider', `${name} shares NSX, but no earlier workload domain has a dedicated NSX Manager cluster to share.`, {}));
  }
  const overheadFootprint = managementOverhead.reduce((s, l) => addFootprints(s, l.footprint), ZERO_FOOTPRINT);
  return { name, vcenterSize, managementOverhead, overheadFootprint, clusters, hosts, edgeTepIps, findings };
}

// ---------------------------------------------------------------------------
// Add-ons (P2)
// ---------------------------------------------------------------------------

function addOnLines(
  a: AddOnsInput | undefined,
  release: VcfRelease,
  context: { readonly profile: DeploymentProfile; readonly role: InstanceRole; readonly version: string } = { profile: 'simple', role: 'first', version: '9.1.1.0' },
): { lines: ComponentLine[]; findings: Finding[] } {
  const lines: ComponentLine[] = [];
  const findings: Finding[] = [];
  if (!a) return { lines, findings };
  const wb = workbookSource(release);

  // Log management, real-time metrics and an additional instance's own Software
  // Depot / Identity Broker all run on the VCFMS workers: the workbook adds
  // their load and recounts the workers.
  if (a.logManagement) {
    const plan = logManagementPlan(a.logManagement, context);
    findings.push(...plan.findings);
    lines.push({
      name: `Log management (${plan.replicas} × ${plan.size} replica: +${plan.workers} VCFMS worker(s))`,
      footprint: plan.footprint,
      verification: 'V-DOC',
      basis: 'published',
      ...wb,
      note: `Replicas are Day-N load on the VCFMS workers, which the workbook recounts; ${Math.round(plan.diskPerReplicaGib)} GB per replica`,
    });
  }
  const dayN = {
    ...(a.logManagement ? { logReplicas: logManagementPlan(a.logManagement, context).replicas, logSize: a.logManagement.replicaSize ?? 'small' } : {}),
  };
  const extra = {
    ...(a.realTimeMetrics ? { realTimeMetrics: true } : {}),
    ...(context.role === 'additional' && a.softwareDepot ? { softwareDepot: true } : {}),
    ...(context.role === 'additional' && a.identityBroker ? { identityBroker: true } : {}),
  };
  if (Object.keys(extra).length > 0) {
    const before = vcfmsFootprint(release, context.profile, context.role, dayN);
    const after = vcfmsFootprint(release, context.profile, context.role, { ...dayN, ...extra });
    const names = [a.realTimeMetrics ? 'real-time metrics' : '', 'softwareDepot' in extra ? 'Software Depot' : '', 'identityBroker' in extra ? 'Identity Broker' : ''].filter(Boolean).join(', ');
    lines.push({
      name: `VCF management services Day-N: ${names} (+${after.workers - before.workers} worker(s))`,
      footprint: subtractFootprints(after.total, before.total),
      verification: 'V-DOC',
      basis: 'published',
      ...wb,
    });
  }
  if ((a.softwareDepot || a.identityBroker) && context.role === 'first') {
    findings.push(info('vcf.addon.first-instance-services', 'The first instance already runs the Software Depot and Identity Broker; they are optional only for an additional instance.', { source: wb.sourceUrl }));
  }
  if (a.operationsForNetworks) {
    const o = a.operationsForNetworks;
    const needsCluster = (o.vms ?? 0) > OPS_NETWORKS_CLUSTER.vmThreshold || (o.flows ?? 0) > OPS_NETWORKS_CLUSTER.flowThreshold;
    const largest: OpsNetworksSize = release === '9.1.0' ? 'large' : 'xlarge';
    let size: OpsNetworksSize = needsCluster ? largest : (o.size ?? largest);
    let e = opsNetworksPlatform(release, size);
    if (!e) {
      findings.push(warning('vcf.addon.ops-networks-size', `VCF Operations for Networks ${size} is not in the ${release} workbook; ${largest} is used.`, { source: wb.sourceUrl }));
      size = largest;
      e = opsNetworksPlatform(release, size) as SizedEntry;
    }
    const nodes = o.nodes ?? (needsCluster ? OPS_NETWORKS_CLUSTER.minNodes : 1);
    lines.push(line(`VCF Operations for Networks platform (${nodes} × ${size})`, scaleFootprint(footprintOf(e), nodes), e, '100% CPU and memory reservation (S14)'));
    const collectors = o.collectors ?? 1;
    const cSize = o.collectorSize ?? size;
    const c = opsNetworksCollector(release, cSize);
    if (collectors > 0) lines.push(line(`VCF Operations for Networks collector (${collectors} × ${cSize})`, scaleFootprint(footprintOf(c), collectors), c));
    if (nodes === 1 && size !== largest) {
      findings.push(warning('vcf.addon.ops-networks-single-node', `A single-node VCF Operations for Networks production deployment must be ${largest === 'xlarge' ? 'X-Large' : 'Large'}.`, { source: SOURCES.operationsForNetworks }));
    }
    if (nodes > 1 && (nodes < OPS_NETWORKS_CLUSTER.minNodes || nodes > OPS_NETWORKS_CLUSTER.maxNodes || size !== largest)) {
      findings.push(warning('vcf.addon.ops-networks-cluster', `A VCF Operations for Networks cluster is ${OPS_NETWORKS_CLUSTER.minNodes}–${OPS_NETWORKS_CLUSTER.maxNodes} ${largest === 'xlarge' ? 'X-Large' : 'Large'} nodes.`, { source: SOURCES.operationsForNetworks }));
    }
  }
  if (a.avi) {
    const size = a.avi.size ?? 'small';
    const nodes = a.avi.nodes ?? 3;
    const e = AVI_CONTROLLER_SIZES[size];
    if (size === 'medium') {
      findings.push(info('vcf.addon.avi-medium', 'Medium is not a VCF 9.1 Avi controller size (Small, Large, X-Large); its figures are Avi 30.1 and unconfirmed.', { source: SOURCES.avi }));
    }
    lines.push(line(`Avi Load Balancer controllers (${nodes} × ${size})`, scaleFootprint(footprintOf(e), nodes), e));
    if (nodes === 1) {
      findings.push(info('vcf.addon.avi-single', release === '9.1.1' ? 'A single Avi controller is selectable in the 9.1.1 UI; it has no controller redundancy.' : 'On 9.1.0 a single Avi controller (small only) is set up by KB, not the UI.', { source: SOURCES.avi }));
    }
  }
  if (a.protectionRecovery) {
    const p = a.protectionRecovery;
    const scale = p.scaleOutAppliances ?? 0;
    lines.push(line('Protection and Recovery appliance', footprintOf(PROTECTION_RECOVERY.appliance), PROTECTION_RECOVERY.appliance));
    if (scale > 0) lines.push(line(`Protection and Recovery scale-out (${scale})`, scaleFootprint(footprintOf(PROTECTION_RECOVERY.scaleOut), scale), PROTECTION_RECOVERY.scaleOut));
    if ((p.protectedVms ?? 0) > PROTECTION_RECOVERY.scaleOutAboveVms && scale === 0) {
      findings.push(warning('vcf.addon.pr-scale-out', `Protecting more than ${PROTECTION_RECOVERY.scaleOutAboveVms} VMs needs Protection and Recovery scale-out appliances.`, { source: SOURCES.protectionRecovery }));
    }
  }
  if (a.hcx) {
    const pairs = a.hcx.sitePairs ?? 1;
    const ne = a.hcx.networkExtensions ?? 1;
    let f = addFootprints(footprintOf(HCX_APPLIANCES.manager), footprintOf(HCX_APPLIANCES.ix));
    f = addFootprints(f, scaleFootprint(footprintOf(HCX_APPLIANCES.ne), ne));
    if (a.hcx.wanOptimization) f = addFootprints(f, footprintOf(HCX_APPLIANCES.wanopt));
    if (a.hcx.sentinelGateway) f = addFootprints(f, footprintOf(HCX_APPLIANCES.sgw));
    lines.push(line(`HCX (${pairs} site pair(s): manager, IX, ${ne} NE${a.hcx.wanOptimization ? ', WAN-OPT' : ''}${a.hcx.sentinelGateway ? ', SGW' : ''})`, scaleFootprint(f, pairs), HCX_APPLIANCES.manager, 'Storage doubles during upgrades'));
  }
  if (a.operationsScaleOut) {
    const o = a.operationsScaleOut;
    if ((o.dataNodes ?? 0) > 0) {
      const e = OPS_SIZES[o.dataNodeSize ?? 'medium'];
      lines.push(line(`VCF Operations data nodes (${o.dataNodes} × ${o.dataNodeSize ?? 'medium'})`, scaleFootprint(footprintOf(e), o.dataNodes ?? 0), e));
    }
    if ((o.cloudProxies ?? 0) > 0) {
      const e = OPS_COLLECTOR_SIZES[o.cloudProxySize ?? 'small'];
      lines.push(line(`VCF Operations cloud proxies (${o.cloudProxies} × ${o.cloudProxySize ?? 'small'})`, scaleFootprint(footprintOf(e), o.cloudProxies ?? 0), e));
    }
  }
  return { lines, findings };
}

// ---------------------------------------------------------------------------
// Per-appliance breakdown (P3)
// ---------------------------------------------------------------------------

/**
 * The management plane appliance by appliance, as the release's Planning and
 * Preparation Workbook builds it (published). When the fleet total differs
 * (two 9.1.1 additional-instance disk figures in S1), a last line says so.
 */
export function managementBreakdown(
  version: string | undefined,
  profile: DeploymentProfile,
  role: InstanceRole = 'first',
): ComponentLine[] {
  const release = vcfRelease(version);
  const r = profilesForRelease(release).includes(profile) ? release : '9.1.1';
  const wb = workbookSource(r, 'Management Domain Sizing');
  const lines: ComponentLine[] = workbookManagementPlane(r, profile, role).map((c) => ({
    name: c.nodes > 1 ? `${c.name} × ${c.nodes}` : c.name,
    footprint: c.footprint,
    verification: 'V-DOC',
    basis: 'published',
    ...wb,
  }));
  const total = fleetEntry(r, profile, role);
  if (total) {
    const listed = lines.reduce((s, l) => addFootprints(s, l.footprint), ZERO_FOOTPRINT);
    const rest = subtractFootprints(footprintOf(total), listed);
    if (rest.vcpu !== 0 || rest.ramGib !== 0 || rest.diskGib !== 0) {
      lines.push({ name: 'Difference from the fleet total', footprint: rest, verification: 'I', basis: 'derived', note: total.note ?? '' });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The management domain
// ---------------------------------------------------------------------------

function automationOf(input: SizingInput, role: InstanceRole, release: VcfRelease = '9.1.1'): AutomationResult {
  const profileDefault = profileAutomation(release, input.profile);
  if (role !== 'first') {
    return { applicable: false, included: false, profileDefault, size: profileDefault.size, nodes: 0, delta: ZERO_FOOTPRINT, basis: 'published' };
  }
  const included = input.includeAutomation !== false;
  const size = input.automationSize ?? profileDefault.size;
  const nodes = input.automationNodes ?? profileDefault.nodes;
  const base = automationFootprint(profileDefault.size, profileDefault.nodes);
  const chosen = included ? automationFootprint(size, nodes) : ZERO_FOOTPRINT;
  const delta = subtractFootprints(chosen, base);
  const changed = delta.vcpu !== 0 || delta.ramGib !== 0 || delta.diskGib !== 0;
  const basis = changed ? weakestBasis([AUTOMATION_NODE_SIZES[profileDefault.size].basis, included ? AUTOMATION_NODE_SIZES[size].basis : 'published']) : 'published';
  return { applicable: true, included, profileDefault, size, nodes: included ? nodes : 0, delta, basis };
}

function sizeManagementDomain(input: SizingInput): SizingResult {
  const findings: Finding[] = [];
  const tags: Verification[] = [];
  const version = fullVcfVersion(input.version);
  const release = vcfRelease(version);
  const role: InstanceRole = input.instanceRole ?? 'first';
  const failures = hostFailures(input);

  // --- the published management plane ---------------------------------------
  let entry = fleetEntry(release, input.profile, role);
  if (!entry) {
    findings.push(
      error('vcf.profile.not-in-release', `The ${input.profile} profile does not exist in VCF ${release}; it was added in 9.1.1.`, {
        path: 'profile',
        remediation: 'Target 9.1.1, or choose Simple, HA-Medium or HA-Large.',
        source: SOURCES.fleetSizing910,
      }),
    );
    entry = (role === 'first' ? FLEET_FIRST_INSTANCE_911 : FLEET_ADDITIONAL_INSTANCE_911)[input.profile];
  }
  tags.push(entry.verification);
  const planeLine: ComponentLine = {
    name: role === 'first' ? 'VCF management plane (first instance)' : 'VCF management plane (additional instance)',
    footprint: footprintOf(entry),
    verification: entry.verification,
    basis: entry.basis ?? 'published',
    ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
    note:
      role === 'first'
        ? `Broadcom published aggregate (${release}) — vCenter, NSX, Operations, the profile's VCF Automation, VCFMS, fleet services`
        : `Broadcom published aggregate (${release}) — vCenter, NSX, SDDC Manager, cloud proxy, VCFMS instance components`,
  };
  const components: ComponentLine[] = [planeLine];
  let plane = footprintOf(entry);

  // --- VCF Automation ---------------------------------------------------------
  const automation = automationOf(input, role, release);
  if (automation.applicable && (automation.delta.vcpu !== 0 || automation.delta.ramGib !== 0 || automation.delta.diskGib !== 0)) {
    const verif: Verification = automation.basis === 'published' ? 'V-DOC' : automation.basis === 'unconfirmed' ? 'C' : 'I';
    components.push({
      name: automation.included
        ? `VCF Automation ${automation.size} × ${automation.nodes} (profile default ${automation.profileDefault.size} × ${automation.profileDefault.nodes})`
        : 'VCF Automation excluded',
      footprint: automation.delta,
      verification: verif,
      basis: automation.basis,
      note: automation.included ? 'Difference from the Automation the published total contains' : 'The profile’s Automation taken off the published total (deferred)',
    });
    tags.push(verif);
    plane = addFootprints(plane, automation.delta);
  }
  if (!automation.applicable && input.includeAutomation === true && role === 'additional') {
    findings.push(info('vcf.automation.additional-instance', 'VCF Automation is a fleet service deployed with the first instance; an additional instance adds none.', { source: SOURCES.fqdnAdditionalInstance }));
  }

  let total = plane;
  let applianceRam = plane.ramGib;

  // --- NSX Edge cluster in the management domain -----------------------------
  if (input.includeEdgeCluster) {
    const size = input.edgeSize ?? 'large';
    const count = input.edgeNodeCount ?? 2;
    const edge = NSX_EDGE_SIZES[size];
    const edgeTotal = scaleFootprint(footprintOf(edge), count);
    components.push(line(`NSX Edge cluster (${count} x ${size})`, edgeTotal, edge, 'Edge nodes reserve full CPU and memory'));
    tags.push(edge.verification);
    total = addFootprints(total, edgeTotal);
    applianceRam += edgeTotal.ramGib;
    if (count < NSX_EDGE_CLUSTER_MIN_NODES) {
      findings.push(warning('vcf.edge.min-nodes', `An NSX Edge cluster needs at least ${NSX_EDGE_CLUSTER_MIN_NODES} nodes; ${count} configured.`, { path: 'edgeNodeCount', source: SOURCES.edgeVm }));
    }
    if (size === 'small') {
      findings.push(info('vcf.edge.small-lab-only', 'Small NSX Edge nodes are lab/PoC only: L7 rules are not realised on a Tier-1 gateway on a small edge.', { path: 'edgeSize', source: SOURCES.edgeVm }));
    }
  }

  // --- workload domains: vCenter and NSX Managers here -----------------------
  const workloadDomains: WorkloadDomainResult[] = [];
  let nsxProvider: string | undefined;
  (input.workloadDomains ?? []).forEach((d, index) => {
    const g = growthFactors(input.growth);
    const grown: WorkloadDomainInput = {
      ...d,
      ...(d.vms !== undefined ? { vms: Math.ceil(d.vms * g.ram) } : {}),
      ...(d.clusters ? { clusters: d.clusters.map((c) => ({ ...c, ...(input.growth && !c.growth ? { growth: input.growth } : {}) })) } : {}),
    };
    const r = sizeWorkloadDomain(grown, { version, index, ...(nsxProvider ? { nsxProvider } : {}) });
    if ((d.nsx ?? 'dedicated') === 'dedicated' && !nsxProvider) nsxProvider = r.name;
    workloadDomains.push(r);
    for (const l of r.managementOverhead) {
      components.push(l);
      tags.push(l.verification);
      total = addFootprints(total, l.footprint);
      applianceRam += l.footprint.ramGib;
    }
    findings.push(...r.findings);
  });
  const stretchedWld = (input.workloadDomains ?? []).some((d) => (d.clusters ?? []).some((c) => c.topology === 'stretched'));
  if (stretchedWld && input.topology !== 'stretched') {
    findings.push(error('vcf.wld.stretched-needs-stretched-management', 'A stretched workload-domain cluster requires a stretched management domain.', { path: 'topology', source: SOURCES.stretched }));
  }

  // --- add-ons ----------------------------------------------------------------
  const addOns = addOnLines(input.addOns, release, { profile: input.profile, role, version });
  findings.push(...addOns.findings);
  for (const l of addOns.lines) {
    components.push(l);
    tags.push(l.verification);
    total = addFootprints(total, l.footprint);
    applianceRam += l.footprint.ramGib;
  }

  // --- tenant workloads on this cluster ---------------------------------------
  const g = growthFactors(input.growth);
  const workload: Footprint = {
    vcpu: (input.workloadVcpu ?? 0) * g.cpu,
    ramGib: (input.workloadRamGib ?? 0) * g.ram,
    diskGib: (input.workloadCapacityGib ?? 0) * g.storage,
  };
  if (workload.vcpu > 0 || workload.ramGib > 0) {
    components.push({
      name: 'Tenant workloads',
      footprint: { vcpu: workload.vcpu, ramGib: workload.ramGib, diskGib: 0 },
      verification: 'I',
      basis: 'derived',
      ...(g.cpu > 1 || g.ram > 1 ? { note: `Grown over ${input.growth?.years ?? 0} year(s)` } : {}),
    });
    total = addFootprints(total, { vcpu: workload.vcpu, ramGib: workload.ramGib, diskGib: 0 });
  }

  // --- capacity ---------------------------------------------------------------
  const tier = tieringRatioOf(input.memoryTiering);
  const reserveAz = input.topology === 'stretched' && input.stretched?.reserveAzFailure !== false;
  const capacity = computeCapacity(input.hostCount, input.host, failures, { topology: input.topology, reserveAzFailure: reserveAz, tieringRatio: tier });
  const cpuRatio = capacity.usablePhysicalCores > 0 ? total.vcpu / capacity.usablePhysicalCores : Number.POSITIVE_INFINITY;
  const memoryUtilization = capacity.usableMemoryGib > 0 ? total.ramGib / capacity.usableMemoryGib : Number.POSITIVE_INFINITY;
  const active = input.memoryTiering?.activeMemoryFraction ?? 0.5;
  const dramDemand = applianceRam + workload.ramGib * active;
  const dramUtilization = tier > 0 ? (capacity.usableRamGib > 0 ? dramDemand / capacity.usableRamGib : Number.POSITIVE_INFINITY) : undefined;

  const storage = computeStorage(input.storage, input.topology === 'two-node' ? 'standard' : input.topology, input.hostCount, input.host, failures, total.diskGib + workload.diskGib, input.vsan?.model === 'workbook' && input.vsan.swapGib === undefined ? { ...input.vsan, swapGib: total.ramGib } : input.vsan);
  const licensing = computeLicensing(input.hostCount, input.host, input.vcfEdge === true, isVsan(input.storage));
  const ips = computeIpRequirements(input);
  const min = minimumHosts({ ...input, role: 'management' });

  // --- rules ------------------------------------------------------------------
  if (entry.basis && entry.basis !== 'published') {
    findings.push(
      (entry.basis === 'unconfirmed' ? warning : info)(
        'vcf.fleet.figure-not-published',
        `The ${release} ${input.profile} management footprint is ${entry.basis}: ${entry.source ?? ''}.${entry.note ? ` ${entry.note}.` : ''}`,
        { source: entry.sourceUrl ?? SOURCES.fleetSizing },
      ),
    );
  }

  if (input.topology === 'two-node') {
    findings.push(
      error('vcf.topology.two-node-management', 'A 2-node cluster is not a VCF 9.1 management-domain topology; the cluster models are single-rack, multi-rack and stretched.', {
        path: 'topology',
        remediation: 'Use a standard or stretched cluster.',
        source: SOURCES.singleRack,
      }),
    );
  }

  if (input.hostCount < min.hosts) {
    findings.push(
      error('vcf.hosts.below-minimum', `${input.hostCount} hosts is below the ${min.hosts}-host minimum for this ${isHaProfile(input.profile) ? 'HA' : 'Simple'} management domain.`, {
        path: 'hostCount',
        remediation: `Add ${min.hosts - input.hostCount} more host(s).`,
        source: min.sourceUrl ?? min.source,
      }),
    );
  }
  if (min.recommended && input.hostCount < min.recommended) {
    findings.push(info('vcf.hosts.below-recommended', `${min.hosts} hosts is the minimum; ${min.recommended} is recommended (${min.note ?? ''}).`, { path: 'hostCount', source: min.sourceUrl ?? min.source }));
  }
  if (input.path === 'brownfield-converge' && input.topology === 'stretched' && isVsan(input.storage)) {
    findings.push(
      info('vcf.hosts.converge-stretched-unconfirmed', `A ${CONVERGE_STRETCHED_UNCONFIRMED.hosts}-host converged stretched cluster (2 per AZ plus a witness) is sometimes quoted for 9.1.1, but it is unconfirmed; the Stretched Cluster Model's ${min.hosts} is used.`, {
        path: 'hostCount',
        source: SOURCES.stretched,
      }),
    );
  }
  if (isVsan(input.storage) && input.topology === 'standard' && input.hostCount < 3) {
    findings.push(
      error('vcf.vsan.under-three-hosts', `A vSAN cluster of ${input.hostCount} host(s) runs FTT=0 (no protection) and is not a valid VCF domain cluster.`, { path: 'hostCount', source: SOURCES.autoRaid }),
    );
  } else if (isVsan(input.storage) && !storage.valid) {
    findings.push(error('vcf.vsan.policy-needs-more-hosts', `${storage.raid} needs more hosts than ${input.hostCount}.`, { path: 'vsan.osaPolicy' }));
  }
  if (isVsan(input.storage) && input.topology === 'standard' && input.hostCount === 3 && failures > 0) {
    findings.push(info('vcf.vsan.three-host-no-rebuild', 'On 3 hosts vSAN tolerates one failure but has nowhere to rebuild.', { source: SOURCES.singleRack }));
  }

  if (input.path === 'greenfield' && isExternal(input.storage)) {
    findings.push(
      info('vcf.storage.greenfield-external', `A new management domain on ${input.storage === 'nfs' ? 'NFS v3' : 'VMFS on FC'} is supported in VCF 9. The datastore must exist and be presented to every host before the installer runs.`, {
        path: 'storage',
        remediation: 'iSCSI, NFS 4.1, FCoE and NVMe over Fabrics are not available to a new deployment; for those, converge an existing cluster instead.',
        source: 'Broadcom KB 416270',
      }),
    );
  }

  if (input.storage === 'vsan-esa' && input.host.ramGib < VSAN_ESA_MIN_HOST_RAM_GIB) {
    findings.push(error('vcf.vsan.esa-host-ram', `vSAN ESA requires at least ${VSAN_ESA_MIN_HOST_RAM_GIB} GiB per host; this design has ${input.host.ramGib} GiB.`, { path: 'host.ramGib', source: SOURCES.esxDesign }));
  }
  if (input.storage === 'vsan-esa' && input.nicSpeedGbps !== undefined && input.nicSpeedGbps <= VSAN_ESA_AF0_MAX_NIC_GBPS) {
    findings.push(warning('vcf.vsan.esa-10gbe', `On ${input.nicSpeedGbps} GbE only the vSAN ESA-AF-0 ReadyNode profile is allowed.`, { path: 'nicSpeedGbps', source: SOURCES.storageModels }));
  }

  const targetRatio = input.targetCpuRatio ?? DEFAULT_TARGET_CPU_RATIO;
  if (cpuRatio > targetRatio) {
    findings.push(
      warning('vcf.cpu.over-target-ratio', `vCPU per physical core is ${cpuRatio.toFixed(2)}:1 with ${capacity.hostFailuresReserved} host(s) down${reserveAz ? ' and one AZ lost' : ''}, above the ${targetRatio}:1 target.`, {
        path: 'host',
        remediation: 'Add hosts, add cores per host, or reduce the deployment profile.',
        source: SOURCES.esxDesign,
      }),
    );
  }

  const reserveText = [failures > 0 ? `${failures} host failure(s)` : '', reserveAz ? 'one AZ' : ''].filter(Boolean).join(' and ');
  if (memoryUtilization > 1) {
    findings.push(
      error('vcf.memory.insufficient', `Memory demand (${Math.round(total.ramGib)} GiB) exceeds usable capacity (${Math.round(capacity.usableMemoryGib)} GiB${reserveText ? `, after reserving ${reserveText}` : ''}).`, {
        path: 'host.ramGib',
        remediation: 'Add hosts or increase RAM per host.',
      }),
    );
  } else if (memoryUtilization > MEMORY_WARN_UTILIZATION) {
    findings.push(warning('vcf.memory.high-utilization', `Memory utilization is ${Math.round(memoryUtilization * 100)}% of usable capacity, leaving little headroom.`, { path: 'host.ramGib' }));
  }

  if (tier > 0) {
    findings.push(...tieringFindings(input.memoryTiering, version, 'memoryTiering'));
    if (dramUtilization !== undefined && dramUtilization > 1) {
      findings.push(
        error('vcf.tiering.dram-ha', `Management appliances plus active workload memory need ${Math.round(dramDemand)} GiB of DRAM, more than the ${Math.round(capacity.usableRamGib)} GiB that survives ${reserveText || 'no failure'}.`, {
          path: 'host.ramGib',
          remediation: 'Management appliances are sized on DRAM; add DRAM or hosts.',
          source: atLeastVcfVersion(version, MEMORY_TIERING_HA_VERSION) ? SOURCES.vcenter911Notes : SOURCES.memoryTiering,
        }),
      );
    }
    if (workload.ramGib * active > MEMORY_TIERING_MAX_ACTIVE_FRACTION * capacity.totalRamGib) {
      findings.push(warning('vcf.tiering.active-memory', 'Active memory exceeds half of DRAM, where memory tiering stops helping.', { source: SOURCES.memoryTiering }));
    }
  }

  if (!storage.sufficient) {
    findings.push(
      error('vcf.storage.insufficient', `vSAN needs ${Math.round(storage.rawRequiredGib)} GiB raw (${storage.raid}) but only ${Math.round(storage.availableRawGib)} GiB is available after the rebuild reserve.`, {
        path: 'host.rawStorageGib',
        remediation: 'Add capacity devices, add hosts, or reduce the workload capacity target.',
        source: SOURCES.autoRaid,
      }),
    );
  }

  if (input.topology === 'stretched') {
    const s = input.stretched ?? {};
    if (s.interAzBandwidthGbps !== undefined && s.interAzBandwidthGbps < STRETCHED_MIN_BANDWIDTH_GBPS) {
      findings.push(error('vcf.stretched.bandwidth', `Inter-AZ bandwidth of ${s.interAzBandwidthGbps} Gbps is below the ${STRETCHED_MIN_BANDWIDTH_GBPS} Gbps a stretched cluster needs.`, { path: 'stretched.interAzBandwidthGbps', source: SOURCES.stretched }));
    }
    if (s.interAzRttMs !== undefined && s.interAzRttMs >= STRETCHED_MAX_RTT_MS) {
      findings.push(error('vcf.stretched.rtt', `Inter-AZ round trip of ${s.interAzRttMs} ms is not under ${STRETCHED_MAX_RTT_MS} ms.`, { path: 'stretched.interAzRttMs', source: SOURCES.stretched }));
    }
  }
  let witness: ComponentLine | undefined;
  if (input.topology === 'stretched' && isVsan(input.storage)) {
    const size = input.stretched?.witnessSize ?? 'medium';
    const w = VSAN_WITNESS_SIZES[size];
    witness = line(`vSAN witness appliance (${size}), third site`, footprintOf(w), w, 'Runs outside both AZs; sizes unconfirmed for 9.1');
  }

  // Automation per-node vCPU cannot exceed a host's logical processors.
  if (automation.applicable && automation.included) {
    const perNode = AUTOMATION_NODE_SIZES[automation.size].perNodeVcpu;
    const logicalPerHost = coresPerHost(input.host) * (input.host.hyperthreading ? 2 : 1);
    if (logicalPerHost < perNode) {
      findings.push(
        error('vcf.automation.host-too-small', `A ${automation.size} VCF Automation node requires ${perNode} vCPU, but each host provides only ${logicalPerHost} logical processors.`, {
          path: 'host',
          remediation: 'Use hosts with more cores, or enable hyperthreading, or exclude VCF Automation.',
          source: 'Community — documented deployment failure',
        }),
      );
    }
    if (automation.basis === 'unconfirmed') {
      findings.push(info('vcf.automation.size-unconfirmed', `VCF Automation ${automation.size} node sizes for 9.1.1 are unconfirmed; the footprint change is indicative.`, { path: 'automationSize' }));
    }
  }

  if (input.vcfEdge) {
    if (coresPerHost(input.host) < VCF_EDGE_MIN_CORES_PER_HOST) {
      findings.push(error('vcf.licensing.edge-host-cores', `VCF Edge needs at least ${VCF_EDGE_MIN_CORES_PER_HOST} cores per host.`, { source: SOURCES.vcfEdge }));
    }
    if (capacity.physicalCores > VCF_EDGE_MAX_CORES_PER_SITE) {
      findings.push(error('vcf.licensing.edge-site-cores', `VCF Edge allows at most ${VCF_EDGE_MAX_CORES_PER_SITE} cores per site; this site has ${capacity.physicalCores}.`, { source: SOURCES.vcfEdge }));
    }
    if (input.edgeSites !== undefined && input.edgeSites < VCF_EDGE_MIN_SITES) {
      findings.push(warning('vcf.licensing.edge-sites', `VCF Edge requires at least ${VCF_EDGE_MIN_SITES} sites; ${input.edgeSites} given.`, { source: SOURCES.vcfEdge }));
    }
  }
  if (licensing.floorPenaltyCores > 0) {
    findings.push(
      info('vcf.licensing.core-floor', `Licensing bills ${licensing.billableCores} cores rather than ${licensing.physicalCores}: VCF has a ${licensing.minPerCpuApplied}-core-per-CPU minimum and these CPUs have ${input.host.coresPerCpu}.`, {
        remediation: `Using CPUs with at least ${licensing.minPerCpuApplied} cores avoids paying for ${licensing.floorPenaltyCores} unused cores.`,
        source: SOURCES.licensingModel,
      }),
    );
  }
  if (licensing.vsanAddOnTib > 0) {
    findings.push(
      info('vcf.licensing.vsan-addon', `Raw vSAN capacity (${licensing.vsanRawTib.toFixed(1)} TiB) exceeds the ${licensing.vsanEntitlementTib} TiB included with ${licensing.billableCores} cores; ${licensing.vsanAddOnTib} TiB of add-on capacity is needed.`, {
        remediation: 'Whether vSAN is metered on raw claimed capacity is unconfirmed (KB 95927).',
        source: SOURCES.licensingOverview,
      }),
    );
  }

  if (input.topology === 'stretched' && input.hostCount % 2 !== 0) {
    findings.push(warning('vcf.topology.uneven-stretch', `A stretched cluster should have an even host count split across two AZs; ${input.hostCount} is odd.`, { path: 'hostCount' }));
  }

  return {
    input,
    version,
    release,
    role,
    managementFootprint: plane,
    components,
    breakdown: managementBreakdown(version, input.profile, role),
    totalDemand: total,
    capacity,
    cpuRatio,
    memoryUtilization,
    ...(dramUtilization !== undefined ? { dramUtilization } : {}),
    storage,
    licensing,
    ips,
    hostMinimum: min,
    automation,
    workloadDomains,
    ...(witness ? { witness } : {}),
    findings,
    verification: weakestVerification(tags.length > 0 ? tags : ['I']),
  };
}

/**
 * Run the full sizing calculation for one management domain. When
 * instanceCount > 1, `fleet` sizes each additional instance as its own
 * management domain on its own hosts.
 */
export function sizeDeployment(input: SizingInput): SizingResult {
  const count = Math.max(1, Math.floor(input.instanceCount || 1));
  const first = sizeManagementDomain(input);
  if (count <= 1 || (input.instanceRole ?? 'first') !== 'first') return first;

  const additional: SizingInput[] = [];
  for (let i = 1; i < count; i += 1) additional.push(additionalInstanceInput(input));
  const fleet = summarizeFleet([first, ...additional.map(sizeManagementDomain)], input.subscriptionYears, input.vcfEdge === true);
  const findings = [
    ...first.findings,
    info('vcf.fleet.additional-instances', `The fleet has ${count} VCF instances: this first one and ${count - 1} additional, each its own management domain on its own ${additional[0]?.hostCount ?? 0} hosts. Fleet total: ${fleet.totals.hosts} hosts.`, {
      source: SOURCES.fleetSizing,
    }),
  ];
  return { ...first, fleet, findings };
}

/** The management domain of an additional instance, from the first one's input. */
export function additionalInstanceInput(first: SizingInput): SizingInput {
  const base: SizingInput = {
    path: first.path === 'brownfield-import' ? 'greenfield' : first.path,
    profile: first.profile,
    instanceCount: 1,
    instanceRole: 'additional',
    topology: first.topology === 'two-node' ? 'standard' : first.topology,
    storage: first.storage,
    host: first.host,
    hostCount: 0,
    ...(first.version ? { version: first.version } : {}),
    ...(first.targetCpuRatio !== undefined ? { targetCpuRatio: first.targetCpuRatio } : {}),
    ...(first.reserveHostFailure !== undefined ? { reserveHostFailure: first.reserveHostFailure } : {}),
    ...(first.hostFailuresToTolerate !== undefined ? { hostFailuresToTolerate: first.hostFailuresToTolerate } : {}),
    ...(first.pnicsPerHost !== undefined ? { pnicsPerHost: first.pnicsPerHost } : {}),
    ...(first.vsan ? { vsan: first.vsan } : {}),
    ...(first.stretched ? { stretched: first.stretched } : {}),
    ...(first.memoryTiering ? { memoryTiering: first.memoryTiering } : {}),
    ...(first.vcfEdge ? { vcfEdge: first.vcfEdge } : {}),
  };
  const hostCount =
    first.additionalInstanceHostCount ?? recommendHostCount({ ...base, hostCount: minimumHosts({ ...base, role: 'management' }).hosts }) ?? minimumHosts({ ...base, role: 'management' }).hosts;
  return { ...base, hostCount };
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export interface LicenseItem {
  readonly name: string;
  readonly hosts: number;
  readonly host: HostSpec;
  readonly vsan: boolean;
  /** VCF Edge site, for the per-site core cap. */
  readonly site?: string;
}

export interface FleetLicensing {
  readonly items: readonly (LicensingResult & { readonly name: string })[];
  readonly physicalCores: number;
  readonly billableCores: number;
  readonly floorPenaltyCores: number;
  readonly vsanEntitlementTib: number;
  readonly vsanRawTib: number;
  readonly vsanAddOnTib: number;
  readonly subscriptionYears?: number;
  /** Billable cores × years. */
  readonly coreYears?: number;
  readonly findings: readonly Finding[];
}

/** Licensing across every management domain and workload-domain cluster in a fleet. [S12, S12b, S24] */
export function computeFleetLicensing(
  items: readonly LicenseItem[],
  options: { readonly vcfEdge?: boolean; readonly subscriptionYears?: number; readonly sites?: number } = {},
): FleetLicensing {
  const findings: Finding[] = [];
  const rows = items.map((i) => ({ name: i.name, ...computeLicensing(i.hosts, i.host, options.vcfEdge === true, i.vsan) }));
  const sum = (k: 'physicalCores' | 'billableCores' | 'floorPenaltyCores' | 'vsanEntitlementTib' | 'vsanRawTib') => rows.reduce((s, r) => s + r[k], 0);
  const billableCores = sum('billableCores');
  const vsanEntitlementTib = sum('vsanEntitlementTib');
  const vsanRawTib = sum('vsanRawTib');
  if (options.vcfEdge) {
    const bySite = new Map<string, number>();
    for (const i of items) {
      if (coresPerHost(i.host) < VCF_EDGE_MIN_CORES_PER_HOST) {
        findings.push(error('vcf.licensing.edge-host-cores', `${i.name}: VCF Edge needs at least ${VCF_EDGE_MIN_CORES_PER_HOST} cores per host.`, { source: SOURCES.vcfEdge }));
      }
      const site = i.site ?? i.name;
      bySite.set(site, (bySite.get(site) ?? 0) + i.hosts * coresPerHost(i.host));
    }
    for (const [site, cores] of bySite) {
      if (cores > VCF_EDGE_MAX_CORES_PER_SITE) findings.push(error('vcf.licensing.edge-site-cores', `${site}: ${cores} cores exceeds the VCF Edge ${VCF_EDGE_MAX_CORES_PER_SITE}-core site maximum.`, { source: SOURCES.vcfEdge }));
    }
    const sites = options.sites ?? bySite.size;
    if (sites < VCF_EDGE_MIN_SITES) findings.push(warning('vcf.licensing.edge-sites', `VCF Edge requires at least ${VCF_EDGE_MIN_SITES} sites; ${sites} counted.`, { source: SOURCES.vcfEdge }));
  }
  const vsanAddOnTib = Math.max(0, Math.ceil(vsanRawTib - vsanEntitlementTib));
  if (vsanAddOnTib > 0) {
    findings.push(info('vcf.licensing.fleet-vsan-addon', `Fleet raw vSAN (${vsanRawTib.toFixed(1)} TiB) exceeds the ${vsanEntitlementTib} TiB included with ${billableCores} cores: ${vsanAddOnTib} TiB add-on.`, { remediation: 'Whether vSAN is metered on raw claimed capacity is unconfirmed (KB 95927).', source: SOURCES.licensingOverview }));
  }
  const years = options.subscriptionYears;
  return {
    items: rows,
    physicalCores: sum('physicalCores'),
    billableCores,
    floorPenaltyCores: sum('floorPenaltyCores'),
    vsanEntitlementTib,
    vsanRawTib,
    vsanAddOnTib,
    ...(years ? { subscriptionYears: years, coreYears: billableCores * years } : {}),
    findings,
  };
}

export interface FleetResult {
  readonly instances: readonly SizingResult[];
  readonly totals: {
    readonly instances: number;
    readonly managementHosts: number;
    readonly workloadHosts: number;
    readonly hosts: number;
    readonly managementDemand: Footprint;
    readonly ipsMinimum: number;
    readonly ipsRecommended: number;
  };
  readonly licensing: FleetLicensing;
  readonly findings: readonly Finding[];
}

function summarizeFleet(instances: readonly SizingResult[], subscriptionYears?: number, vcfEdge = false): FleetResult {
  const items: LicenseItem[] = [];
  let workloadHosts = 0;
  let wldIps = 0;
  instances.forEach((r, i) => {
    const label = `instance ${i + 1} management`;
    items.push({ name: label, hosts: r.input.hostCount, host: r.input.host, vsan: isVsan(r.input.storage) });
    for (const d of r.workloadDomains) {
      for (const c of d.clusters) {
        const src = (r.input.workloadDomains ?? []).flatMap((x) => x.clusters ?? []).find((x) => x.name === c.name);
        items.push({ name: `instance ${i + 1} ${c.name}`, hosts: c.hosts, host: src?.host ?? r.input.host, vsan: src ? isVsan(src.storage) : false });
        workloadHosts += c.hosts;
        wldIps += c.hostIps + c.tepIps;
      }
      wldIps += d.edgeTepIps;
    }
  });
  const licensing = computeFleetLicensing(items, { vcfEdge, ...(subscriptionYears ? { subscriptionYears } : {}) });
  const managementHosts = instances.reduce((s, r) => s + r.input.hostCount, 0);
  return {
    instances,
    totals: {
      instances: instances.length,
      managementHosts,
      workloadHosts,
      hosts: managementHosts + workloadHosts,
      managementDemand: instances.reduce((s, r) => addFootprints(s, r.totalDemand), ZERO_FOOTPRINT),
      ipsMinimum: instances.reduce((s, r) => s + r.ips.totalMinimum, 0) + wldIps,
      ipsRecommended: instances.reduce((s, r) => s + r.ips.totalRecommended, 0) + wldIps,
    },
    licensing,
    findings: [...instances.flatMap((r, i) => r.findings.map((f) => ({ ...f, message: `Instance ${i + 1}: ${f.message}` }))), ...licensing.findings],
  };
}

export interface FleetInput {
  /** The first instance, then each additional one (their instanceRole is forced to 'additional'). */
  readonly instances: readonly SizingInput[];
  readonly version?: string;
  readonly subscriptionYears?: number;
  readonly vcfEdge?: boolean;
}

/**
 * A fleet: each instance its own management domain with its own hosts, IPs,
 * minimums and licensing, plus its workload domains, and the fleet total.
 */
export function sizeFleet(input: FleetInput): FleetResult {
  const results = input.instances.map((inst, i) =>
    sizeManagementDomain({
      ...inst,
      instanceCount: 1,
      instanceRole: i === 0 ? 'first' : 'additional',
      ...(input.version && !inst.version ? { version: input.version } : {}),
      ...(input.vcfEdge !== undefined ? { vcfEdge: input.vcfEdge } : {}),
    }),
  );
  return summarizeFleet(results, input.subscriptionYears, input.vcfEdge === true);
}

// ---------------------------------------------------------------------------
// Searches and projections
// ---------------------------------------------------------------------------

/** Findings that adding hosts can clear. Anything else is per-host or a design choice. */
const CAPACITY_CODES = new Set([
  'vcf.hosts.below-minimum',
  'vcf.cpu.over-target-ratio',
  'vcf.memory.insufficient',
  'vcf.memory.high-utilization',
  'vcf.storage.insufficient',
  'vcf.tiering.dram-ha',
  'vcf.vsan.under-three-hosts',
  'vcf.vsan.policy-needs-more-hosts',
  'vcf.topology.uneven-stretch',
]);

/**
 * Smallest host count that satisfies the design without capacity errors or
 * capacity warnings (CPU target, memory headroom), searching upward from the
 * documented minimum. Returns null when even `ceiling` hosts cannot work.
 */
export function recommendHostCount(input: SizingInput, ceiling = 64): number | null {
  const single: SizingInput = { ...input, instanceCount: 1 };
  const start = minimumHosts({ ...input, role: 'management' }).hosts;
  for (let hosts = start; hosts <= ceiling; hosts += 1) {
    const result = sizeManagementDomain({ ...single, hostCount: hosts });
    if (!result.findings.some((f) => CAPACITY_CODES.has(f.code))) return hosts;
  }
  return null;
}

export interface GrowthYear {
  readonly year: number;
  readonly managementHosts: number | null;
  readonly workloadHosts: number;
  readonly demand: Footprint;
}

/** Hosts per year to the growth horizon, for the management domain and every workload-domain cluster. */
export function projectGrowth(input: SizingInput, ceiling = 64): GrowthYear[] {
  const years = Math.max(0, Math.floor(input.growth?.years ?? 0));
  const out: GrowthYear[] = [];
  for (let y = 0; y <= years; y += 1) {
    const at: SizingInput = { ...input, instanceCount: 1, ...(input.growth ? { growth: { ...input.growth, years: y } } : {}) };
    const hosts = recommendHostCount(at, ceiling);
    const r = sizeManagementDomain({ ...at, hostCount: hosts ?? input.hostCount });
    out.push({
      year: y,
      managementHosts: hosts,
      workloadHosts: r.workloadDomains.reduce((s, d) => s + d.clusters.reduce((t, c) => t + c.hosts, 0), 0),
      demand: r.totalDemand,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Disaster recovery site (P3)
// ---------------------------------------------------------------------------

export interface RecoverySiteInput {
  readonly protectedVcpu: number;
  readonly protectedRamGib: number;
  readonly protectedStorageGib: number;
  readonly protectedVms?: number;
  /** Share of protected demand to hold at the recovery site. Default 1 (all). */
  readonly reserveFraction?: number;
  readonly host: HostSpec;
  readonly storage: StorageType;
  readonly cpuRatio?: number;
  readonly memoryCeiling?: number;
  readonly hostFailures?: 0 | 1 | 2;
  readonly vsan?: VsanOptions;
  readonly version?: string;
}

/** Recovery-site capacity for the protected demand, plus Protection and Recovery appliances at both sites. */
export function sizeRecoverySite(input: RecoverySiteInput): {
  cluster: WorkloadClusterResult;
  appliances: ComponentLine[];
  findings: Finding[];
} {
  const f = input.reserveFraction ?? 1;
  const scaleOut = (input.protectedVms ?? 0) > PROTECTION_RECOVERY.scaleOutAboveVms ? Math.ceil((input.protectedVms ?? 0) / PROTECTION_RECOVERY.scaleOutAboveVms) - 1 : 0;
  const perSite = addFootprints(footprintOf(PROTECTION_RECOVERY.appliance), scaleFootprint(footprintOf(PROTECTION_RECOVERY.scaleOut), scaleOut));
  const appliances: ComponentLine[] = [
    line('Protection and Recovery, protected site', perSite, PROTECTION_RECOVERY.appliance, scaleOut > 0 ? `${scaleOut} scale-out appliance(s) (derived: one per 5000 VMs beyond the first)` : undefined),
    line('Protection and Recovery, recovery site', perSite, PROTECTION_RECOVERY.appliance),
  ];
  const cluster = sizeWorkloadCluster(
    {
      name: 'recovery',
      vcpu: input.protectedVcpu * f,
      ramGib: input.protectedRamGib * f,
      storageGib: input.protectedStorageGib,
      host: input.host,
      storage: input.storage,
      ...(input.cpuRatio !== undefined ? { cpuRatio: input.cpuRatio } : {}),
      ...(input.memoryCeiling !== undefined ? { memoryCeiling: input.memoryCeiling } : {}),
      ...(input.hostFailures !== undefined ? { hostFailures: input.hostFailures } : {}),
      ...(input.vsan ? { vsan: input.vsan } : {}),
      ...(input.version ? { version: input.version } : {}),
    },
    { lines: [appliances[1] as ComponentLine] },
  );
  return {
    cluster,
    appliances,
    findings: [
      ...cluster.findings,
      info('vcf.dr.storage-full', 'Replicated storage is held in full at the recovery site; the reserve fraction applies to CPU and memory only.', {}),
    ],
  };
}

export { ZERO_FOOTPRINT };
