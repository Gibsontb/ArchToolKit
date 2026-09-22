/**
 * VCF 9.1.x sizing reference data.
 *
 * Every figure here is tagged with how it was verified (see provenance.ts).
 * Official Broadcom numbers and community estimates are deliberately NOT
 * blended — a sizing result built on a community figure is reported as such.
 *
 * Research date: 2026-09-17, against VCF 9.1 / 9.1.1.
 */

import type { Verification } from './provenance.ts';

export interface Footprint {
  readonly vcpu: number;
  readonly ramGib: number;
  readonly diskGib: number;
}

export interface SizedEntry extends Footprint {
  readonly verification: Verification;
  readonly source?: string;
  readonly note?: string;
}

export const ZERO_FOOTPRINT: Footprint = { vcpu: 0, ramGib: 0, diskGib: 0 };

export function addFootprints(a: Footprint, b: Footprint): Footprint {
  return {
    vcpu: a.vcpu + b.vcpu,
    ramGib: a.ramGib + b.ramGib,
    diskGib: a.diskGib + b.diskGib,
  };
}

export function scaleFootprint(f: Footprint, factor: number): Footprint {
  return { vcpu: f.vcpu * factor, ramGib: f.ramGib * factor, diskGib: f.diskGib * factor };
}

// ---------------------------------------------------------------------------
// Fleet-level aggregate sizing — THE authoritative table
// ---------------------------------------------------------------------------

/**
 * Deployment profile. VCF 9.1 offers "Simple" (single-node management
 * components) or "High Availability" at Small / Medium / Large scale.
 */
export type DeploymentProfile = 'simple' | 'ha-small' | 'ha-medium' | 'ha-large';

export const DEPLOYMENT_PROFILE_LABELS: Record<DeploymentProfile, string> = {
  simple: 'Simple (non-HA)',
  'ha-small': 'High Availability — Small',
  'ha-medium': 'High Availability — Medium',
  'ha-large': 'High Availability — Large',
};

/**
 * Total management-plane footprint for the FIRST VCF instance in a fleet.
 * Includes fleet-wide services (Fleet LCM, Identity Broker, License Server,
 * Fleet Depot, Telemetry Acceptor, fleet VSP).
 *
 * Source: Broadcom TechDocs — "VCF Fleet Sizing Models" (9.1).
 */
export const FLEET_FIRST_INSTANCE: Record<DeploymentProfile, SizedEntry> = {
  simple: {
    vcpu: 76,
    ramGib: 251,
    diskGib: 7448,
    verification: 'V-DOC',
    source: 'TechDocs: VCF Fleet Sizing Models (9.1)',
  },
  'ha-small': {
    vcpu: 106,
    ramGib: 335,
    diskGib: 8422,
    verification: 'V-DOC',
    source: 'TechDocs: VCF Fleet Sizing Models (9.1)',
  },
  'ha-medium': {
    vcpu: 184,
    ramGib: 656,
    diskGib: 11445,
    verification: 'V-DOC',
    source: 'TechDocs: VCF Fleet Sizing Models (9.1)',
  },
  'ha-large': {
    vcpu: 298,
    ramGib: 949,
    diskGib: 15357,
    verification: 'V-DOC',
    source: 'TechDocs: VCF Fleet Sizing Models (9.1)',
  },
};

/**
 * Footprint for EACH ADDITIONAL VCF instance joining an existing fleet.
 * Lower than the first instance because fleet-wide services already exist.
 */
export const FLEET_ADDITIONAL_INSTANCE: Record<DeploymentProfile, SizedEntry> = {
  simple: {
    vcpu: 34,
    ramGib: 111,
    diskGib: 4562,
    verification: 'V-DOC',
    source: 'TechDocs: VCF Fleet Sizing Models (9.1)',
  },
  'ha-small': {
    vcpu: 62,
    ramGib: 187,
    diskGib: 5462,
    verification: 'V-DOC',
    source: 'TechDocs: VCF Fleet Sizing Models (9.1)',
  },
  'ha-medium': {
    vcpu: 74,
    ramGib: 244,
    diskGib: 5813,
    verification: 'V-DOC',
    source: 'TechDocs: VCF Fleet Sizing Models (9.1)',
  },
  'ha-large': {
    vcpu: 120,
    ramGib: 353,
    diskGib: 8321,
    verification: 'V-DOC',
    source: 'TechDocs: VCF Fleet Sizing Models (9.1)',
  },
};

// ---------------------------------------------------------------------------
// Per-appliance sizing
// ---------------------------------------------------------------------------

export type VcenterSize = 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';

/** `SddcVcenterSpec.vmSize`. Enum verified [V-API]; footprints community [C]. */
export const VCENTER_SIZES: Record<VcenterSize, SizedEntry> = {
  tiny: { vcpu: 2, ramGib: 14, diskGib: 579, verification: 'C', source: 'vCenter 9 sizing guide' },
  small: { vcpu: 4, ramGib: 21, diskGib: 694, verification: 'C', source: 'vCenter 9 sizing guide' },
  medium: { vcpu: 8, ramGib: 30, diskGib: 908, verification: 'C', source: 'vCenter 9 sizing guide' },
  large: { vcpu: 16, ramGib: 39, diskGib: 1358, verification: 'C', source: 'vCenter 9 sizing guide' },
  xlarge: {
    vcpu: 24,
    ramGib: 58,
    diskGib: 2283,
    verification: 'C',
    source: 'vCenter 9 sizing guide',
  },
};

/** vCenter host-count / VM-count ceilings per size. */
export const VCENTER_CAPACITY: Record<VcenterSize, { hosts: number; vms: number }> = {
  tiny: { hosts: 10, vms: 100 },
  small: { hosts: 100, vms: 1000 },
  medium: { hosts: 400, vms: 4000 },
  large: { hosts: 1000, vms: 10000 },
  xlarge: { hosts: 2500, vms: 40000 },
};

export type NsxManagerSize = 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';

/**
 * NSX Manager form factors.
 *
 * IMPORTANT: `SddcNsxtSpec.nsxtManagerSize` accepts only medium | large |
 * xlarge. xsmall and small exist as NSX form factors but are NOT selectable
 * for VCF bring-up. [V-API]
 */
export const NSX_MANAGER_SIZES: Record<NsxManagerSize, SizedEntry> = {
  xsmall: { vcpu: 2, ramGib: 8, diskGib: 300, verification: 'C', source: 'NSX 4.x sizing' },
  small: { vcpu: 4, ramGib: 16, diskGib: 300, verification: 'C', source: 'NSX 4.x sizing' },
  medium: { vcpu: 6, ramGib: 24, diskGib: 300, verification: 'C', source: 'NSX 4.x sizing' },
  large: { vcpu: 12, ramGib: 48, diskGib: 300, verification: 'C', source: 'NSX 4.x sizing' },
  xlarge: { vcpu: 24, ramGib: 96, diskGib: 400, verification: 'C', source: 'NSX 4.x sizing' },
};

/** Sizes the VCF Installer will actually accept for bring-up. [V-API] */
export const NSX_MANAGER_BRINGUP_SIZES = ['medium', 'large', 'xlarge'] as const;

export type NsxEdgeSize = 'small' | 'medium' | 'large' | 'xlarge';

/** NSX Edge VM form factors — official for VCF 9.1. [V-DOC] */
export const NSX_EDGE_SIZES: Record<NsxEdgeSize, SizedEntry> = {
  small: {
    vcpu: 2,
    ramGib: 4,
    diskGib: 200,
    verification: 'V-DOC',
    source: 'VCF 9.1 NSX Edge sizing',
    note: 'Lab / PoC only — not supported for production load balancing',
  },
  medium: {
    vcpu: 4,
    ramGib: 8,
    diskGib: 200,
    verification: 'V-DOC',
    source: 'VCF 9.1 NSX Edge sizing',
  },
  large: {
    vcpu: 8,
    ramGib: 32,
    diskGib: 200,
    verification: 'V-DOC',
    source: 'VCF 9.1 NSX Edge sizing',
  },
  xlarge: {
    vcpu: 16,
    ramGib: 64,
    diskGib: 200,
    verification: 'V-DOC',
    source: 'VCF 9.1 NSX Edge sizing',
  },
};

/** Minimum Edge nodes per centralized Edge cluster. [V-DOC] */
export const NSX_EDGE_CLUSTER_MIN_NODES = 2;
/** Maximum Edge nodes per cluster. [V-DOC] */
export const NSX_EDGE_CLUSTER_MAX_NODES = 10;

/** SDDC Manager has a single size. [C] */
export const SDDC_MANAGER: SizedEntry = {
  vcpu: 4,
  ramGib: 16,
  diskGib: 980,
  verification: 'C',
  source: 'Community — VCF 9 component sizing',
};

export type OpsSize = 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';

/**
 * VCF Operations node sizing. `VcfOperationsSpec.applianceSize`.
 * Capacity figures official (KB 397782, written for 9.0 — the 9.1 API enum
 * matches, so presumed unchanged). Disk figures are community.
 */
export const OPS_SIZES: Record<
  OpsSize,
  SizedEntry & { readonly maxRamGib: number; readonly maxObjects: number; readonly maxMetrics: number }
> = {
  xsmall: {
    vcpu: 2,
    ramGib: 8,
    maxRamGib: 16,
    diskGib: 274,
    maxObjects: 700,
    maxMetrics: 140_000,
    verification: 'V-DOC',
    source: 'Broadcom KB 397782',
    note: 'KB written for 9.0; 9.1 API enum matches',
  },
  small: {
    vcpu: 4,
    ramGib: 16,
    maxRamGib: 32,
    diskGib: 274,
    maxObjects: 10_000,
    maxMetrics: 1_600_000,
    verification: 'V-DOC',
    source: 'Broadcom KB 397782',
  },
  medium: {
    vcpu: 8,
    ramGib: 32,
    maxRamGib: 64,
    diskGib: 548,
    maxObjects: 30_000,
    maxMetrics: 5_000_000,
    verification: 'V-DOC',
    source: 'Broadcom KB 397782',
  },
  large: {
    vcpu: 16,
    ramGib: 48,
    maxRamGib: 96,
    diskGib: 822,
    maxObjects: 44_000,
    maxMetrics: 8_000_000,
    verification: 'V-DOC',
    source: 'Broadcom KB 397782',
  },
  xlarge: {
    vcpu: 24,
    ramGib: 128,
    maxRamGib: 256,
    diskGib: 1096,
    maxObjects: 100_000,
    maxMetrics: 20_000_000,
    verification: 'V-DOC',
    source: 'Broadcom KB 397782',
  },
};

/** VCF Operations cluster ceilings. [V-DOC] KB 397782 */
export const OPS_CLUSTER_LIMITS: Record<
  'small' | 'medium' | 'large' | 'xlarge',
  { maxNodes: number; maxObjects: number; maxMetrics: number }
> = {
  small: { maxNodes: 2, maxObjects: 12_000, maxMetrics: 2_800_000 },
  medium: { maxNodes: 8, maxObjects: 136_000, maxMetrics: 32_000_000 },
  large: { maxNodes: 16, maxObjects: 576_000, maxMetrics: 81_600_000 },
  xlarge: { maxNodes: 12, maxObjects: 1_056_000, maxMetrics: 126_000_000 },
};

export type OpsCollectorSize = 'small' | 'standard';

/** VCF Operations Collector (Cloud Proxy). `applianceSize` enum [V-API]. */
export const OPS_COLLECTOR_SIZES: Record<
  OpsCollectorSize,
  SizedEntry & { readonly maxObjects: number; readonly maxMetrics: number }
> = {
  small: {
    vcpu: 2,
    ramGib: 8,
    diskGib: 144,
    maxObjects: 16_000,
    maxMetrics: 2_400_000,
    verification: 'V-DOC',
    source: 'Broadcom Cloud Proxy sizing',
  },
  standard: {
    vcpu: 4,
    ramGib: 32,
    diskGib: 144,
    maxObjects: 80_000,
    maxMetrics: 12_000_000,
    verification: 'V-DOC',
    source: 'Broadcom Cloud Proxy sizing',
  },
};

export type AutomationSize = 'small' | 'medium' | 'large';

/**
 * VCF Automation. Note the hard planning constraint: a node needs 24 vCPU, so
 * a host with only 16 logical CPUs cannot run one.
 */
export const AUTOMATION_SIZES: Record<
  AutomationSize,
  SizedEntry & { readonly nodes: number; readonly perNodeVcpu: number }
> = {
  small: {
    nodes: 1,
    perNodeVcpu: 24,
    vcpu: 24,
    ramGib: 96,
    diskGib: 455,
    verification: 'C',
    source: 'Community — VCF Automation sizing',
  },
  medium: {
    nodes: 3,
    perNodeVcpu: 24,
    vcpu: 72,
    ramGib: 288,
    diskGib: 1002,
    verification: 'C',
    source: 'Community — VCF Automation sizing',
  },
  large: {
    nodes: 3,
    perNodeVcpu: 32,
    vcpu: 96,
    ramGib: 384,
    diskGib: 1290,
    verification: 'C',
    source: 'Community — VCF Automation sizing',
  },
};

/** A single VCF Automation node's vCPU requirement — a common deployment blocker. */
export const AUTOMATION_MIN_NODE_VCPU = 24;

/** Centralized License Server — mandatory in 9.1 for both VCF and VVF. */
export const LICENSE_SERVER: SizedEntry = {
  vcpu: 2,
  ramGib: 4,
  diskGib: 100,
  verification: 'C',
  source: 'Community',
  note: 'Mandatory component in 9.1; official sizing not published',
};

/**
 * VCF Management Services (vSphere Supervisor runtime).
 *
 * Per-tier sizing (small / small_ha / medium / large) is NOT published. Only
 * these aggregate community figures exist.
 */
export const VCF_MANAGEMENT_SERVICES: Record<'simple' | 'ha', SizedEntry> = {
  simple: {
    vcpu: 40,
    ramGib: 82,
    diskGib: 3000,
    verification: 'C',
    source: 'Community — corroborated by two independent sources',
    note: 'Per-tier (small/small_ha/medium/large) breakdown not published by Broadcom',
  },
  ha: {
    vcpu: 84,
    ramGib: 174,
    diskGib: 3600,
    verification: 'C',
    source: 'Community — corroborated by two independent sources',
    note: 'Per-tier breakdown not published by Broadcom',
  },
};

// ---------------------------------------------------------------------------
// Management domain host minimums
// ---------------------------------------------------------------------------

export type DeploymentPath = 'greenfield' | 'brownfield-converge' | 'brownfield-import';

export interface HostMinimum {
  readonly hosts: number;
  readonly verification: Verification;
  readonly source: string;
  readonly note?: string;
}

/** Minimum management-domain hosts by path and storage. */
export const MGMT_HOST_MINIMUMS = {
  'greenfield-vsan-single-az': {
    hosts: 4,
    verification: 'V-DOC',
    source: 'Broadcom KB 392993',
  },
  'greenfield-vsan-stretched': {
    hosts: 8,
    verification: 'V-DOC',
    source: 'Broadcom KB 392993',
    note: '4 per availability zone',
  },
  'greenfield-external-storage': {
    hosts: 3,
    verification: 'V-SPEC',
    source: 'VCF Installer 9.1.1.0 deployment spec from a lab: three hosts on VMFS on FC',
    note: 'Broadcom supports NFS v3 and VMFS on FC for a new management domain (KB 416270) but publishes no separate minimum; three is what a real deployment used',
  },
  'converge-vsan': {
    hosts: 3,
    verification: 'V-DOC',
    source: 'VCF deployment pathways',
    note: 'vSAN-ready nodes',
  },
  'converge-external-storage': {
    hosts: 2,
    verification: 'V-DOC',
    source: 'VCF deployment pathways',
    note: 'NFS v3 or VMFS-on-FC',
  },
  'converge-vsan-stretched': {
    hosts: 4,
    verification: 'V-DOC',
    source: 'VCF 9.1.1 release notes',
    note: '2 ESX per AZ plus a witness (9.1.1+)',
  },
} as const satisfies Record<string, HostMinimum>;

/** vSAN ESA requires at least this much RAM per host. [V-DOC] */
export const VSAN_ESA_MIN_HOST_RAM_GIB = 128;

/**
 * Principal storage a NEW management domain can use besides vSAN. VCF 9 added
 * NFS v3 and VMFS on FC to the greenfield workflow; iSCSI, NFS 4.1, FCoE and
 * NVMe over Fabrics still need the converge path. [V-DOC — Broadcom KB 416270]
 * The rule this replaces ("greenfield must be vSAN", KB 392993) described the
 * Cloud Builder bring-up of VCF 5 and was wrong for 9.
 */
export const GREENFIELD_EXTERNAL_STORAGE = ['nfs', 'vmfs-fc'] as const;

// ---------------------------------------------------------------------------
// vSAN capacity overhead
// ---------------------------------------------------------------------------

export type ClusterTopology = 'standard' | 'stretched' | 'two-node';

export interface RaidOverhead {
  readonly multiplier: number;
  readonly raid: string;
  readonly minHosts: number;
  readonly ftt: number;
}

/**
 * Usable-to-raw capacity multipliers.
 *
 * VCF 9.1 introduces Auto-RAID, under which "RAID 5 and RAID 6 have the same
 * capacity overhead consideration" — hence 1.5x for both standard cases.
 * [V-DOC] vSAN Design Guide
 */
export function raidOverhead(topology: ClusterTopology, hostsPerSite: number): RaidOverhead {
  if (topology === 'two-node') {
    return { multiplier: 2.0, raid: 'Host mirroring', minHosts: 2, ftt: 1 };
  }
  if (topology === 'stretched') {
    return hostsPerSite >= 6
      ? { multiplier: 3.0, raid: 'Mirror + RAID-6', minHosts: 6, ftt: 2 }
      : { multiplier: 3.0, raid: 'Mirror + RAID-5', minHosts: 3, ftt: 1 };
  }
  return hostsPerSite >= 6
    ? { multiplier: 1.5, raid: 'RAID-6', minHosts: 6, ftt: 2 }
    : { multiplier: 1.5, raid: 'RAID-5 (2+1)', minHosts: 3, ftt: 1 };
}

/**
 * Free capacity to keep in reserve.
 *
 * The legacy blanket 25-30% slack rule no longer applies. With fault domains
 * configured the operational reserve toggles are unavailable and ~25% free
 * should be maintained manually. [V-DOC]
 */
export const VSAN_SLACK_WITH_FAULT_DOMAINS = 0.25;
/** With Auto-RAID and no fault domains, vSAN reports true usable capacity. */
export const VSAN_SLACK_AUTO_RAID = 0.0;

// ---------------------------------------------------------------------------
// IP and FQDN requirements
// ---------------------------------------------------------------------------

/**
 * VCF Management Services needs a contiguous or (9.1.0.400+) non-contiguous
 * pool. 12 is a hard minimum; 30 is recommended for headroom. [V-DOC]
 */
export const VCFMS_MIN_IPS = 12;
export const VCFMS_RECOMMENDED_IPS = 30;

/**
 * VCF Automation node pool: 3 active + 2 buffer, for 9.1.0.0 - 9.1.0.300. [V-DOC]
 *
 * Prefer `automationIpCount(version)` in ./version.ts, which picks between this
 * and the 9.1.0.400+ count. These constants remain for the sizing tables, which
 * report both.
 */
export const AUTOMATION_IP_COUNT = 5;

/**
 * From 9.1.0.400, the pool is 6 addresses and may be non-contiguous; the sixth
 * is requested but not consumed. [V-DOC]
 *
 * This was previously recorded here as an unresolved discrepancy, because a real
 * 9.1.0.0 spec was observed carrying 6 where the documentation then said 5. It
 * is a version boundary rather than a contradiction.
 */
export const AUTOMATION_IP_COUNT_OBSERVED = 6;

/** Per-host IP needs: management + vMotion + vSAN, plus TEPs per pNIC. */
export const IPS_PER_HOST_BASE = 3;

// ---------------------------------------------------------------------------
// Licensing
// ---------------------------------------------------------------------------

/**
 * VCF 9.1 is per-core subscription. Minimum consumption is 16 cores per
 * physical CPU — an 8-core CPU still consumes 16. [V-DOC]
 */
export const LICENSE_MIN_CORES_PER_CPU = 16;
/** VCF Edge has a lower floor. [V-DOC] */
export const LICENSE_MIN_CORES_PER_CPU_EDGE = 8;
/** Evaluation period before workloads are blocked. [V-DOC] */
export const LICENSE_EVAL_DAYS = 90;

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** `SddcNetworkSpec.networkType` enum. [V-API] */
export const NETWORK_TYPES = [
  'MANAGEMENT',
  'VM_MANAGEMENT',
  'VMOTION',
  'VSAN',
  'NFS',
  'FLEET_MANAGEMENT',
] as const;

export type NetworkType = (typeof NETWORK_TYPES)[number];

/** Default vDS MTU. [V-API] */
export const DEFAULT_MTU = 9000;
/** MTU bounds accepted by the installer. [C] */
export const MTU_MIN = 1280;
export const MTU_MAX = 9190;
/** NSX overlay cannot function below this. [C] */
export const NSX_OVERLAY_MIN_MTU = 1600;

/**
 * `internalClusterCidrIpv4` is restricted to exactly these three blocks and
 * must not collide with anything routable in the environment. [V-API]
 */
export const INTERNAL_CLUSTER_CIDRS_V4 = ['198.18.0.0/15', '240.0.0.0/15', '250.0.0.0/15'] as const;

/**
 * Supported internal cluster CIDRs for IPv6, with the spelling variants the API
 * reference lists. `fd00::/111` is the default. [V-API]
 */
export const INTERNAL_CLUSTER_CIDRS_V6 = [
  'fd00::/111',
  'fd00::0/111',
  'fc00::/111',
  'fc00::0/111',
  'fc00::4:0/111',
  'fc00::0004:0/111',
] as const;

/** `DnsSpec.nameservers` accepts at most two entries. [V-API] */
export const MAX_NAMESERVERS = 2;

/** VLAN id bounds. */
export const VLAN_MIN = 0;
export const VLAN_MAX = 4094;
