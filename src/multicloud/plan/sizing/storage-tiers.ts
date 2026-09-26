/**
 * Block-storage performance tiers per platform (addendum A.2.8.4), as data.
 *
 * Each tier gives, for a volume of a size, the IOPS and throughput it carries:
 * - fixed tiers (Azure Premium SSD / Standard SSD) by the provider's size table;
 * - scaled tiers (Google Persistent Disk, OCI VPU levels) per GiB, capped;
 * - provisioned tiers (gp3, io2, Premium SSD v2, Ultra Disk, Hyperdisk) with a
 *   free baseline, a per-GiB IOPS ceiling and a throughput-per-IOPS ceiling.
 *
 * Read from the providers' pages on 2026-09-26 (V-DOC) unless marked 'I'.
 * MB/s and MiB/s are treated as the same unit here (a 5 % difference that the
 * tiers' own rounding dwarfs); OCI sizes are GB, treated as GiB.
 */

import type { Verification } from '../../../vcf/provenance.ts';
import type { Platform } from '../types.ts';

export interface TierPerf {
  /** Included without provisioning. */
  readonly baseIops: number;
  readonly baseMbps: number;
  /** The most this size can carry (provisioned tiers: can be provisioned to). */
  readonly maxIops: number;
  readonly maxMbps: number;
}

export interface DiskTier {
  readonly platform: Platform;
  /** The value Terraform takes (volume type / storage account type / disk type), or 'vpu-<n>' for OCI. */
  readonly id: string;
  readonly label: string;
  readonly minGib: number;
  readonly maxGib: number;
  /** Can be the boot / OS disk. */
  readonly osDisk: boolean;
  /** Only offered for nonprod rows (the cheapest SSD / lower-cost tiers). */
  readonly nonprodOnly?: boolean;
  /** Needs a zonal VM (Azure Premium SSD v2 / Ultra). */
  readonly zonal?: boolean;
  /** Needs a machine series that takes Persistent Disk (Google: not on Hyperdisk-only series). */
  readonly persistentDisk?: boolean;
  /** IOPS and throughput are set independently of size. */
  readonly provisioned: boolean;
  /** Provisioned tiers: IOPS per GiB ceiling, and throughput per provisioned IOPS ceiling. */
  readonly iopsPerGib?: number;
  readonly mbpsPerIops?: number;
  /** Fixed tiers: the sizes sold, GiB, with their IOPS and MB/s. */
  readonly sizes?: readonly (readonly [gib: number, iops: number, mbps: number, name: string])[];
  /** OCI: volume performance units per GB. */
  readonly vpusPerGb?: number;
  readonly perf: (sizeGib: number, provisionedIops?: number) => TierPerf;
  readonly verification: Verification;
  readonly source: string;
  readonly note?: string;
}

const SRC = {
  gp3: 'https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html',
  io2: 'https://docs.aws.amazon.com/ebs/latest/userguide/provisioned-iops.html',
  hdd: 'https://docs.aws.amazon.com/ebs/latest/userguide/hdd-vols.html',
  azure: 'https://learn.microsoft.com/en-us/azure/virtual-machines/disks-types',
  pd: 'https://docs.cloud.google.com/compute/docs/disks/performance',
  hdb: 'https://docs.cloud.google.com/compute/docs/disks/hd-types/hyperdisk-balanced',
  hd: 'https://docs.cloud.google.com/compute/docs/disks/hyperdisks',
  oci: 'https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/blockvolumeperformance.htm',
} as const;

const fixed = (sizes: NonNullable<DiskTier['sizes']>) => (size: number): TierPerf => {
  const t = sizes.find(([g]) => g >= size) ?? sizes[sizes.length - 1]!;
  return { baseIops: t[1], baseMbps: t[2], maxIops: t[1], maxMbps: t[2] };
};

const PREMIUM: NonNullable<DiskTier['sizes']> = [
  [4, 120, 25, 'P1'], [8, 120, 25, 'P2'], [16, 120, 25, 'P3'], [32, 120, 25, 'P4'], [64, 240, 50, 'P6'], [128, 500, 100, 'P10'],
  [256, 1100, 125, 'P15'], [512, 2300, 150, 'P20'], [1024, 5000, 200, 'P30'], [2048, 7500, 250, 'P40'], [4096, 7500, 250, 'P50'],
  [8192, 16000, 500, 'P60'], [16384, 18000, 750, 'P70'], [32767, 20000, 900, 'P80'],
];
const STANDARD_SSD: NonNullable<DiskTier['sizes']> = [
  [4, 500, 100, 'E1'], [8, 500, 100, 'E2'], [16, 500, 100, 'E3'], [32, 500, 100, 'E4'], [64, 500, 100, 'E6'], [128, 500, 100, 'E10'],
  [256, 500, 100, 'E15'], [512, 500, 100, 'E20'], [1024, 500, 100, 'E30'], [2048, 500, 100, 'E40'], [4096, 500, 100, 'E50'],
  [8192, 2000, 400, 'E60'], [16384, 4000, 600, 'E70'], [32767, 6000, 750, 'E80'],
];

/** OCI Block Volume performance levels (V-DOC table). */
export const OCI_VPU_LEVELS: readonly (readonly [vpu: number, iopsPerGb: number, maxIops: number, kbpsPerGb: number, maxMbps: number, label: string])[] = [
  [0, 2, 3000, 240, 480, 'Lower Cost'],
  [10, 60, 25000, 480, 480, 'Balanced'],
  [20, 75, 50000, 600, 680, 'Higher Performance'],
  [30, 90, 75000, 720, 880, 'Ultra High Performance'],
  [40, 105, 100000, 840, 1080, 'Ultra High Performance'],
  [50, 120, 125000, 960, 1280, 'Ultra High Performance'],
  [60, 135, 150000, 1080, 1480, 'Ultra High Performance'],
  [70, 150, 175000, 1200, 1680, 'Ultra High Performance'],
  [80, 165, 200000, 1320, 1880, 'Ultra High Performance'],
  [90, 180, 225000, 1440, 2080, 'Ultra High Performance'],
  [100, 195, 250000, 1560, 2280, 'Ultra High Performance'],
  [110, 210, 275000, 1680, 2480, 'Ultra High Performance'],
  [120, 225, 300000, 1800, 2680, 'Ultra High Performance'],
];

/** Tiers per platform, cheapest first (the order the engine tries them). */
export const STORAGE_TIERS: Readonly<Record<Exclude<Platform, 'vmware'>, readonly DiskTier[]>> = {
  aws: [
    {
      platform: 'aws', id: 'gp3', label: 'General Purpose SSD (gp3)', minGib: 1, maxGib: 65536, osDisk: true, provisioned: true, iopsPerGib: 500, mbpsPerIops: 0.25,
      perf: (s) => ({ baseIops: 3000, baseMbps: 125, maxIops: Math.min(80000, Math.max(3000, 500 * s)), maxMbps: 2000 }),
      verification: 'V-DOC', source: SRC.gp3, note: 'Raised in 2025 to 80,000 IOPS, 2,000 MiB/s and 64 TiB per volume.',
    },
    {
      platform: 'aws', id: 'io2', label: 'Provisioned IOPS SSD (io2 Block Express)', minGib: 4, maxGib: 65536, osDisk: true, provisioned: true, iopsPerGib: 1000, mbpsPerIops: 0.256,
      perf: (s) => ({ baseIops: 100, baseMbps: 0, maxIops: Math.min(256000, 1000 * s), maxMbps: 4000 }),
      verification: 'V-DOC', source: SRC.io2, note: '99.999 % durability and sub-millisecond latency; up to 256,000 IOPS on Nitro instances.',
    },
  ],
  azure: [
    {
      platform: 'azure', id: 'StandardSSD_LRS', label: 'Standard SSD', minGib: 4, maxGib: 32767, osDisk: true, nonprodOnly: true, provisioned: false, sizes: STANDARD_SSD,
      perf: fixed(STANDARD_SSD), verification: 'V-DOC', source: SRC.azure,
    },
    {
      platform: 'azure', id: 'Premium_LRS', label: 'Premium SSD', minGib: 4, maxGib: 32767, osDisk: true, provisioned: false, sizes: PREMIUM,
      perf: fixed(PREMIUM), verification: 'V-DOC', source: SRC.azure, note: 'Base (not burst, not Performance Plus) figures.',
    },
    {
      platform: 'azure', id: 'PremiumV2_LRS', label: 'Premium SSD v2', minGib: 1, maxGib: 65536, osDisk: false, zonal: true, provisioned: true, iopsPerGib: 500, mbpsPerIops: 0.25,
      perf: (s) => ({ baseIops: 3000, baseMbps: 125, maxIops: Math.min(80000, Math.max(3000, 500 * s)), maxMbps: 2000 }),
      verification: 'V-DOC', source: SRC.azure, note: 'Cannot be the OS disk; attaches to zonal VMs in most regions.',
    },
    {
      platform: 'azure', id: 'UltraSSD_LRS', label: 'Ultra Disk', minGib: 4, maxGib: 65536, osDisk: false, zonal: true, provisioned: true, iopsPerGib: 1000, mbpsPerIops: 0.25,
      perf: (s) => ({ baseIops: 100, baseMbps: 1, maxIops: Math.min(400000, 1000 * s), maxMbps: 10000 }),
      verification: 'V-DOC', source: SRC.azure, note: 'Data disks only; no availability sets, no caching.',
    },
  ],
  google: [
    {
      platform: 'google', id: 'pd-balanced', label: 'Balanced Persistent Disk', minGib: 10, maxGib: 65536, osDisk: true, persistentDisk: true, provisioned: false,
      perf: (s) => { const i = Math.min(80000, Math.max(3000, 6 * s)); const m = Math.min(1200, Math.max(140, 0.28 * s)); return { baseIops: i, baseMbps: m, maxIops: i, maxMbps: m }; },
      verification: 'V-DOC', source: SRC.pd, note: '6 IOPS and 0.28 MiB/s per GiB; the 3,000 IOPS / 140 MiB/s baseline is per instance.',
    },
    {
      platform: 'google', id: 'pd-ssd', label: 'SSD Persistent Disk', minGib: 10, maxGib: 65536, osDisk: true, persistentDisk: true, provisioned: false,
      perf: (s) => { const i = Math.min(100000, Math.max(6000, 30 * s)); const m = Math.min(1200, Math.max(240, 0.48 * s)); return { baseIops: i, baseMbps: m, maxIops: i, maxMbps: m }; },
      verification: 'V-DOC', source: SRC.pd, note: '30 IOPS and 0.48 MiB/s per GiB; the 6,000 IOPS / 240 MiB/s baseline is per instance.',
    },
    {
      platform: 'google', id: 'hyperdisk-balanced', label: 'Hyperdisk Balanced', minGib: 4, maxGib: 65536, osDisk: true, provisioned: true, iopsPerGib: 500, mbpsPerIops: 0.25,
      perf: (s) => ({ baseIops: 3000, baseMbps: 140, maxIops: Math.min(160000, Math.max(3000, 500 * s)), maxMbps: 2400 }),
      verification: 'V-DOC', source: SRC.hdb, note: 'First 3,000 IOPS and 140 MiB/s free; throughput at most IOPS ÷ 4.',
    },
    {
      platform: 'google', id: 'hyperdisk-extreme', label: 'Hyperdisk Extreme', minGib: 64, maxGib: 65536, osDisk: false, provisioned: true, iopsPerGib: 1000, mbpsPerIops: 0.25,
      perf: (s) => ({ baseIops: 2500, baseMbps: 0, maxIops: Math.min(350000, 1000 * s), maxMbps: 5000 }),
      verification: 'I', source: SRC.hd, note: 'Maxima (350,000 IOPS, 5,000 MiB/s) read; the per-GiB ceiling is assumed like Ultra Disk (verify).',
    },
  ],
  oci: OCI_VPU_LEVELS.map(([vpu, iopsPerGb, maxIops, kbpsPerGb, maxMbps, label]): DiskTier => ({
    platform: 'oci', id: `vpu-${vpu}`, label: `${label} (${vpu} VPU/GB)`, minGib: 50, maxGib: 32768, osDisk: vpu >= 10, nonprodOnly: vpu === 0, provisioned: false, vpusPerGb: vpu,
    perf: (s) => { const i = Math.min(maxIops, iopsPerGb * s); const m = Math.min(maxMbps, (kbpsPerGb * s) / 1000); return { baseIops: i, baseMbps: m, maxIops: i, maxMbps: m }; },
    verification: 'V-DOC', source: SRC.oci,
  })),
};

/** Throughput / cold HDD volumes on AWS: offered only for volumes marked as such (not boot, not transactional). */
export const AWS_HDD_TIERS: readonly DiskTier[] = [
  {
    platform: 'aws', id: 'st1', label: 'Throughput Optimized HDD (st1)', minGib: 125, maxGib: 16384, osDisk: false, provisioned: false,
    perf: (s) => ({ baseIops: 500, baseMbps: Math.min(500, 40 * s / 1024), maxIops: 500, maxMbps: Math.min(500, 250 * s / 1024) }),
    verification: 'I', source: SRC.hdd, note: 'Recalled: 40 MiB/s per TiB baseline, 500 MiB/s maximum; verify.',
  },
  {
    platform: 'aws', id: 'sc1', label: 'Cold HDD (sc1)', minGib: 125, maxGib: 16384, osDisk: false, provisioned: false,
    perf: (s) => ({ baseIops: 250, baseMbps: Math.min(250, 12 * s / 1024), maxIops: 250, maxMbps: Math.min(250, 80 * s / 1024) }),
    verification: 'I', source: SRC.hdd, note: 'Recalled: 12 MiB/s per TiB baseline, 250 MiB/s maximum; verify.',
  },
];

/**
 * The latency floor for tier-0 / tier-1 database data volumes: the tier WP-4's
 * `diskTypes` gives them (io2, Premium SSD v2, pd-ssd, Higher Performance).
 * AWS recommends io2 Block Express for latency-sensitive workloads (gp3 page).
 */
export const DB_LATENCY_FLOOR: Readonly<Record<Exclude<Platform, 'vmware'>, string>> = {
  aws: 'io2', azure: 'PremiumV2_LRS', google: 'pd-ssd', oci: 'vpu-20',
};

export function tierById(platform: Exclude<Platform, 'vmware'>, id: string): DiskTier | undefined {
  return [...STORAGE_TIERS[platform], ...(platform === 'aws' ? AWS_HDD_TIERS : [])].find((t) => t.id === id);
}
