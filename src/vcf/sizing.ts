/**
 * VCF 9.1 sizing engine.
 *
 * Answers the question "will this hardware run this VCF design, and what will
 * it cost to license" for greenfield, brownfield-converge and brownfield-import
 * paths, at single-instance or fleet scale.
 *
 * Design notes:
 *  - The management-plane footprint comes from Broadcom's published fleet
 *    sizing table rather than being summed from per-component figures. The
 *    aggregate is official; the per-component breakdown is community-sourced
 *    and is reported separately for transparency only.
 *  - Where a live VCF Installer is reachable, `POST /v1/sddcs/resources-calculation`
 *    is authoritative and should override this engine. See installer-client.ts.
 *  - Every result carries the weakest provenance tag of its inputs.
 */

import { error, warning, info, type Finding } from '../core/findings.ts';
import { weakestVerification, type Verification } from './provenance.ts';
import {
  FLEET_FIRST_INSTANCE,
  FLEET_ADDITIONAL_INSTANCE,
  NSX_EDGE_SIZES,
  AUTOMATION_SIZES,
  AUTOMATION_MIN_NODE_VCPU,
  VSAN_ESA_MIN_HOST_RAM_GIB,
  MGMT_HOST_MINIMUMS,
  LICENSE_MIN_CORES_PER_CPU,
  LICENSE_MIN_CORES_PER_CPU_EDGE,
  VCFMS_MIN_IPS,
  VCFMS_RECOMMENDED_IPS,
  AUTOMATION_IP_COUNT,
  IPS_PER_HOST_BASE,
  VSAN_SLACK_WITH_FAULT_DOMAINS,
  raidOverhead,
  addFootprints,
  scaleFootprint,
  ZERO_FOOTPRINT,
  type Footprint,
  type DeploymentProfile,
  type DeploymentPath,
  type ClusterTopology,
  type NsxEdgeSize,
  type AutomationSize,
} from './sizing-data.ts';

export type StorageType = 'vsan-esa' | 'vsan-osa' | 'nfs' | 'vmfs-fc';

export interface HostSpec {
  /** Physical CPU sockets per host. */
  readonly cpuSockets: number;
  /** Physical cores per socket. */
  readonly coresPerCpu: number;
  /** Whether hyperthreading/SMT is enabled — doubles logical processors. */
  readonly hyperthreading: boolean;
  readonly ramGib: number;
  /**
   * Raw storage contributed to the vSAN datastore per host, in GiB.
   * Ignored for external storage.
   */
  readonly rawStorageGib: number;
}

export interface SizingInput {
  readonly path: DeploymentPath;
  readonly profile: DeploymentProfile;
  /** How many VCF instances in the fleet. 1 = a single new instance. */
  readonly instanceCount: number;
  readonly topology: ClusterTopology;
  readonly storage: StorageType;
  /** Hosts in the management cluster (total, across both AZs if stretched). */
  readonly hostCount: number;
  readonly host: HostSpec;

  /** Tenant/workload data to be stored, in GiB, before RAID overhead. */
  readonly workloadCapacityGib?: number;
  /** Workload vCPU to account for alongside the management plane. */
  readonly workloadVcpu?: number;
  /** Workload RAM in GiB. */
  readonly workloadRamGib?: number;

  readonly includeEdgeCluster?: boolean;
  readonly edgeSize?: NsxEdgeSize;
  readonly edgeNodeCount?: number;
  readonly includeAutomation?: boolean;
  readonly automationSize?: AutomationSize;

  /** Target vCPU:pCPU consolidation ratio. VCF guidance is <= 2:1 for mgmt. */
  readonly targetCpuRatio?: number;
  /** Reserve capacity for one host failure (N+1). Default true. */
  readonly reserveHostFailure?: boolean;
  /** Number of physical NICs per host, for TEP IP pool sizing. */
  readonly pnicsPerHost?: number;
}

export interface ComponentLine {
  readonly name: string;
  readonly footprint: Footprint;
  readonly verification: Verification;
  readonly note?: string;
}

export interface CapacityResult {
  /** Physical cores across all hosts. */
  readonly physicalCores: number;
  /** Logical processors (physical x2 when SMT is on). */
  readonly logicalProcessors: number;
  readonly totalRamGib: number;
  readonly totalRawStorageGib: number;
  /** Capacity remaining after reserving for one host failure. */
  readonly usableRamGib: number;
  readonly usableRawStorageGib: number;
}

export interface StorageResult {
  readonly required: number;
  readonly multiplier: number;
  readonly raid: string;
  readonly ftt: number;
  readonly slackFraction: number;
  /** Raw capacity needed once RAID overhead and slack are applied. */
  readonly rawRequiredGib: number;
  readonly availableRawGib: number;
  readonly sufficient: boolean;
}

export interface LicensingResult {
  /** Cores actually present. */
  readonly physicalCores: number;
  /** Cores billed, after applying the per-CPU floor. */
  readonly billableCores: number;
  readonly minPerCpuApplied: number;
  /** Extra cores paid for but not present, due to the floor. */
  readonly floorPenaltyCores: number;
}

export interface IpRequirements {
  readonly hostIps: number;
  readonly tepIps: number;
  readonly vcfmsIps: number;
  readonly vcfmsRecommended: number;
  readonly automationIps: number;
  readonly componentFqdns: number;
  readonly totalMinimum: number;
  readonly totalRecommended: number;
}

export interface SizingResult {
  readonly input: SizingInput;
  readonly managementFootprint: Footprint;
  readonly components: readonly ComponentLine[];
  readonly totalDemand: Footprint;
  readonly capacity: CapacityResult;
  readonly cpuRatio: number;
  readonly memoryUtilization: number;
  readonly storage: StorageResult;
  readonly licensing: LicensingResult;
  readonly ips: IpRequirements;
  readonly findings: readonly Finding[];
  readonly verification: Verification;
}

const DEFAULT_TARGET_CPU_RATIO = 2;

/** Minimum hosts for the chosen path, storage and topology. */
export function minimumHosts(input: Pick<SizingInput, 'path' | 'storage' | 'topology'>): {
  hosts: number;
  source: string;
  note?: string;
} {
  const external = input.storage === 'nfs' || input.storage === 'vmfs-fc';

  if (input.path === 'greenfield') {
    const key =
      input.topology === 'stretched'
        ? 'greenfield-vsan-stretched'
        : external
          ? 'greenfield-external-storage'
          : 'greenfield-vsan-single-az';
    const entry = MGMT_HOST_MINIMUMS[key];
    return { hosts: entry.hosts, source: entry.source, ...('note' in entry ? { note: entry.note } : {}) };
  }

  if (input.topology === 'stretched') {
    const entry = MGMT_HOST_MINIMUMS['converge-vsan-stretched'];
    return { hosts: entry.hosts, source: entry.source, note: entry.note };
  }

  const entry = external
    ? MGMT_HOST_MINIMUMS['converge-external-storage']
    : MGMT_HOST_MINIMUMS['converge-vsan'];
  return { hosts: entry.hosts, source: entry.source, note: entry.note };
}

/** Aggregate management-plane footprint across the whole fleet. */
export function fleetFootprint(
  profile: DeploymentProfile,
  instanceCount: number,
): { footprint: Footprint; verification: Verification } {
  const count = Math.max(1, Math.floor(instanceCount));
  const first = FLEET_FIRST_INSTANCE[profile];
  const additional = FLEET_ADDITIONAL_INSTANCE[profile];

  const footprint = addFootprints(
    { vcpu: first.vcpu, ramGib: first.ramGib, diskGib: first.diskGib },
    scaleFootprint(
      { vcpu: additional.vcpu, ramGib: additional.ramGib, diskGib: additional.diskGib },
      count - 1,
    ),
  );

  return {
    footprint,
    verification: weakestVerification([first.verification, additional.verification]),
  };
}

export function computeCapacity(hostCount: number, host: HostSpec, reserveFailure: boolean): CapacityResult {
  const physicalCores = hostCount * host.cpuSockets * host.coresPerCpu;
  const logicalProcessors = physicalCores * (host.hyperthreading ? 2 : 1);
  const totalRamGib = hostCount * host.ramGib;
  const totalRawStorageGib = hostCount * host.rawStorageGib;

  // N+1: one host's worth of capacity is unavailable for placement so that a
  // single host failure does not take workloads down.
  const survivingHosts = reserveFailure ? Math.max(0, hostCount - 1) : hostCount;
  return {
    physicalCores,
    logicalProcessors,
    totalRamGib,
    totalRawStorageGib,
    usableRamGib: survivingHosts * host.ramGib,
    usableRawStorageGib: survivingHosts * host.rawStorageGib,
  };
}

export function computeLicensing(hostCount: number, host: HostSpec, isEdge = false): LicensingResult {
  const floor = isEdge ? LICENSE_MIN_CORES_PER_CPU_EDGE : LICENSE_MIN_CORES_PER_CPU;
  const physicalCores = hostCount * host.cpuSockets * host.coresPerCpu;
  const billedPerCpu = Math.max(host.coresPerCpu, floor);
  const billableCores = hostCount * host.cpuSockets * billedPerCpu;
  return {
    physicalCores,
    billableCores,
    minPerCpuApplied: floor,
    floorPenaltyCores: billableCores - physicalCores,
  };
}

/**
 * Address counts, per family.
 *
 * These are IPv4 counts. On a dual-stack build the host, VCFMS and component
 * counts apply again inside each network's IPv6 prefix, which a /64 always
 * holds; host TEPs stay IPv4 only, because the 9.1 installer's host TEP pool
 * takes no IPv6, and VCF Automation's pool has no documented IPv6 form.
 */
export function computeIpRequirements(input: SizingInput): IpRequirements {
  const pnics = input.pnicsPerHost ?? 2;
  // Management, vMotion and vSAN VMkernel addresses per host.
  const hostIps = input.hostCount * IPS_PER_HOST_BASE;
  // One host TEP per pNIC participating in the overlay, plus growth headroom.
  const tepIps = input.hostCount * pnics;
  const automationIps = input.includeAutomation === false ? 0 : AUTOMATION_IP_COUNT;

  // vCenter, NSX VIP, NSX manager(s), SDDC Manager, Ops, Cloud Proxy, License
  // Server, Identity Broker, fleet + instance components, VCF services runtime.
  const nsxManagers = input.profile === 'simple' ? 1 : 3;
  const opsNodes = input.profile === 'simple' ? 1 : 3;
  const componentFqdns = 1 + 1 + nsxManagers + 1 + opsNodes + 1 + 1 + 1 + 1 + 1 + 1;

  const totalMinimum = hostIps + tepIps + VCFMS_MIN_IPS + automationIps + componentFqdns;
  const totalRecommended = hostIps + tepIps + VCFMS_RECOMMENDED_IPS + automationIps + componentFqdns;

  return {
    hostIps,
    tepIps,
    vcfmsIps: VCFMS_MIN_IPS,
    vcfmsRecommended: VCFMS_RECOMMENDED_IPS,
    automationIps,
    componentFqdns,
    totalMinimum,
    totalRecommended,
  };
}

function computeStorage(
  input: SizingInput,
  managementDiskGib: number,
  capacity: CapacityResult,
): StorageResult {
  const hostsPerSite =
    input.topology === 'stretched' ? Math.floor(input.hostCount / 2) : input.hostCount;
  const overhead = raidOverhead(input.topology, hostsPerSite);
  const required = managementDiskGib + (input.workloadCapacityGib ?? 0);

  // With fault domains or a stretched cluster, keep free capacity in reserve.
  const slack = input.topology === 'standard' ? VSAN_SLACK_WITH_FAULT_DOMAINS : VSAN_SLACK_WITH_FAULT_DOMAINS;
  const rawRequiredGib = (required * overhead.multiplier) / (1 - slack);

  const external = input.storage === 'nfs' || input.storage === 'vmfs-fc';
  const availableRawGib = external ? Number.POSITIVE_INFINITY : capacity.usableRawStorageGib;

  return {
    required,
    multiplier: overhead.multiplier,
    raid: overhead.raid,
    ftt: overhead.ftt,
    slackFraction: slack,
    rawRequiredGib,
    availableRawGib,
    sufficient: availableRawGib >= rawRequiredGib,
  };
}

/** Run the full sizing calculation. */
export function sizeDeployment(input: SizingInput): SizingResult {
  const findings: Finding[] = [];
  const tags: Verification[] = [];

  // --- management plane -----------------------------------------------------
  const fleet = fleetFootprint(input.profile, input.instanceCount);
  tags.push(fleet.verification);

  const components: ComponentLine[] = [
    {
      name:
        input.instanceCount > 1
          ? `VCF management plane (${input.instanceCount} instances)`
          : 'VCF management plane',
      footprint: fleet.footprint,
      verification: fleet.verification,
      note: 'Broadcom published aggregate — includes vCenter, NSX, Ops, Automation, VCFMS, fleet services',
    },
  ];

  let total = fleet.footprint;

  // --- optional NSX Edge cluster (day-N, not in the fleet aggregate) --------
  if (input.includeEdgeCluster) {
    const size = input.edgeSize ?? 'large';
    const count = input.edgeNodeCount ?? 2;
    const edge = NSX_EDGE_SIZES[size];
    const edgeTotal = scaleFootprint(
      { vcpu: edge.vcpu, ramGib: edge.ramGib, diskGib: edge.diskGib },
      count,
    );
    components.push({
      name: `NSX Edge cluster (${count} x ${size})`,
      footprint: edgeTotal,
      verification: edge.verification,
      note: 'Edge nodes reserve full CPU and memory',
    });
    tags.push(edge.verification);
    total = addFootprints(total, edgeTotal);

    if (count < 2) {
      findings.push(
        warning('vcf.edge.min-nodes', `An NSX Edge cluster needs at least 2 nodes; ${count} configured.`, {
          path: 'edgeNodeCount',
          source: 'Broadcom TechDocs — NSX Edge cluster requirements',
        }),
      );
    }
    if (size === 'small') {
      findings.push(
        info('vcf.edge.small-lab-only', 'Small NSX Edge nodes are lab/PoC only and do not support production load balancing.', {
          path: 'edgeSize',
          source: 'VCF 9.1 NSX Edge sizing',
        }),
      );
    }
  }

  // --- workload -------------------------------------------------------------
  const workload: Footprint = {
    vcpu: input.workloadVcpu ?? 0,
    ramGib: input.workloadRamGib ?? 0,
    diskGib: 0,
  };
  if (workload.vcpu > 0 || workload.ramGib > 0) {
    components.push({ name: 'Tenant workloads', footprint: workload, verification: 'I' });
    total = addFootprints(total, workload);
  }

  // --- capacity -------------------------------------------------------------
  const reserveFailure = input.reserveHostFailure ?? true;
  const capacity = computeCapacity(input.hostCount, input.host, reserveFailure);

  const cpuDenominator = input.host.hyperthreading
    ? capacity.logicalProcessors
    : capacity.physicalCores;
  const cpuRatio = cpuDenominator > 0 ? total.vcpu / cpuDenominator : Number.POSITIVE_INFINITY;
  const memoryUtilization = capacity.usableRamGib > 0 ? total.ramGib / capacity.usableRamGib : Number.POSITIVE_INFINITY;

  const storage = computeStorage(input, total.diskGib, capacity);
  const licensing = computeLicensing(input.hostCount, input.host);
  const ips = computeIpRequirements(input);

  // --- rules ----------------------------------------------------------------
  const min = minimumHosts(input);
  if (input.hostCount < min.hosts) {
    findings.push(
      error(
        'vcf.hosts.below-minimum',
        `${input.hostCount} hosts is below the ${min.hosts}-host minimum for this deployment path.`,
        {
          path: 'hostCount',
          remediation: `Add ${min.hosts - input.hostCount} more host(s).`,
          source: min.source,
        },
      ),
    );
  }

  if (input.path === 'greenfield' && (input.storage === 'nfs' || input.storage === 'vmfs-fc')) {
    findings.push(
      info(
        'vcf.storage.greenfield-external',
        `A new management domain on ${input.storage === 'nfs' ? 'NFS v3' : 'VMFS on FC'} is supported in VCF 9. The datastore must exist and be presented to every host before the installer runs.`,
        {
          path: 'storage',
          remediation: 'iSCSI, NFS 4.1, FCoE and NVMe over Fabrics are not available to a new deployment; for those, converge an existing cluster instead.',
          source: 'Broadcom KB 416270',
        },
      ),
    );
  }

  if (input.storage === 'vsan-esa' && input.host.ramGib < VSAN_ESA_MIN_HOST_RAM_GIB) {
    findings.push(
      error(
        'vcf.vsan.esa-host-ram',
        `vSAN ESA requires at least ${VSAN_ESA_MIN_HOST_RAM_GIB} GiB per host; this design has ${input.host.ramGib} GiB.`,
        { path: 'host.ramGib', source: 'vSAN 9.1 hardware requirements' },
      ),
    );
  }

  const targetRatio = input.targetCpuRatio ?? DEFAULT_TARGET_CPU_RATIO;
  if (cpuRatio > targetRatio) {
    findings.push(
      warning(
        'vcf.cpu.over-target-ratio',
        `vCPU:pCPU ratio is ${cpuRatio.toFixed(2)}:1, above the ${targetRatio}:1 target.`,
        {
          path: 'host',
          remediation: 'Add hosts, add cores per host, or reduce the deployment profile.',
          source: 'VCF consolidation guidance',
        },
      ),
    );
  }

  if (memoryUtilization > 1) {
    findings.push(
      error(
        'vcf.memory.insufficient',
        `Memory demand (${Math.round(total.ramGib)} GiB) exceeds usable capacity (${Math.round(capacity.usableRamGib)} GiB${reserveFailure ? ', after reserving one host for failure' : ''}).`,
        {
          path: 'host.ramGib',
          remediation: 'Add hosts or increase RAM per host.',
        },
      ),
    );
  } else if (memoryUtilization > 0.8) {
    findings.push(
      warning(
        'vcf.memory.high-utilization',
        `Memory utilization is ${Math.round(memoryUtilization * 100)}% of usable capacity, leaving little headroom.`,
        { path: 'host.ramGib' },
      ),
    );
  }

  if (!storage.sufficient) {
    findings.push(
      error(
        'vcf.storage.insufficient',
        `vSAN needs ${Math.round(storage.rawRequiredGib)} GiB raw (${storage.raid}, ${Math.round(storage.slackFraction * 100)}% slack) but only ${Math.round(storage.availableRawGib)} GiB is available.`,
        {
          path: 'host.rawStorageGib',
          remediation: 'Add capacity devices, add hosts, or reduce the workload capacity target.',
          source: 'vSAN 9.1 Design Guide — Auto-RAID overhead',
        },
      ),
    );
  }

  // The 24 vCPU Automation node requirement is a real-world deployment blocker.
  if (input.includeAutomation !== false) {
    const logicalPerHost = input.host.cpuSockets * input.host.coresPerCpu * (input.host.hyperthreading ? 2 : 1);
    if (logicalPerHost < AUTOMATION_MIN_NODE_VCPU) {
      findings.push(
        error(
          'vcf.automation.host-too-small',
          `A VCF Automation node requires ${AUTOMATION_MIN_NODE_VCPU} vCPU, but each host provides only ${logicalPerHost} logical processors.`,
          {
            path: 'host',
            remediation: 'Use hosts with more cores, or enable hyperthreading, or exclude VCF Automation.',
            source: 'Community — documented deployment failure',
          },
        ),
      );
    }
    if (input.automationSize) {
      const auto = AUTOMATION_SIZES[input.automationSize];
      tags.push(auto.verification);
    }
  }

  if (licensing.floorPenaltyCores > 0) {
    findings.push(
      info(
        'vcf.licensing.core-floor',
        `Licensing bills ${licensing.billableCores} cores rather than ${licensing.physicalCores}: VCF has a ${LICENSE_MIN_CORES_PER_CPU}-core-per-CPU minimum and these CPUs have ${input.host.coresPerCpu}.`,
        {
          remediation: `Using CPUs with at least ${LICENSE_MIN_CORES_PER_CPU} cores avoids paying for ${licensing.floorPenaltyCores} unused cores.`,
          source: 'VCF 9.1 licensing — per-core subscription',
        },
      ),
    );
  }

  if (input.instanceCount > 1) {
    findings.push(
      info(
        'vcf.fleet.additional-instances',
        `Sizing covers ${input.instanceCount} VCF instances: one first instance plus ${input.instanceCount - 1} additional.`,
        { source: 'TechDocs: VCF Fleet Sizing Models (9.1)' },
      ),
    );
  }

  if (input.topology === 'stretched' && input.hostCount % 2 !== 0) {
    findings.push(
      warning(
        'vcf.topology.uneven-stretch',
        `A stretched cluster should have an even host count split across two AZs; ${input.hostCount} is odd.`,
        { path: 'hostCount' },
      ),
    );
  }

  return {
    input,
    managementFootprint: fleet.footprint,
    components,
    totalDemand: total,
    capacity,
    cpuRatio,
    memoryUtilization,
    storage,
    licensing,
    ips,
    findings,
    verification: weakestVerification(tags.length > 0 ? tags : ['I']),
  };
}

/**
 * Smallest host count that satisfies the design, searching upward from the
 * documented minimum. Returns null when even a large cluster cannot work
 * (usually a per-host constraint such as RAM or core count).
 */
export function recommendHostCount(input: SizingInput, ceiling = 64): number | null {
  const start = minimumHosts(input).hosts;
  for (let hosts = start; hosts <= ceiling; hosts += 1) {
    const result = sizeDeployment({ ...input, hostCount: hosts });
    const blocking = result.findings.filter(
      (f) =>
        f.severity === 'error' &&
        // Per-host constraints do not improve by adding hosts.
        f.code !== 'vcf.vsan.esa-host-ram' &&
        f.code !== 'vcf.automation.host-too-small',
    );
    if (blocking.length === 0) return hosts;
  }
  return null;
}

export { ZERO_FOOTPRINT };
