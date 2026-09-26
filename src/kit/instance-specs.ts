/**
 * What each machine type in the catalogue is: vCPU, memory, class, generation,
 * processor, and the few facts the sizing engines need beyond that.
 *
 * `sizes-data.ts` is the list of names each provider sells (generated, 2,574 of
 * them). It says nothing about what a name is. This file does, and it does it
 * the way the providers name things: a family table as data plus the naming
 * convention, so `m7i.2xlarge` is the m7i family (general purpose, 4 GiB per
 * vCPU, Intel, generation 7) at the 2xlarge size (8 vCPU). Types whose figures
 * do not follow their family's ratio are listed as explicit exceptions.
 *
 * Families the table does not describe return `undefined` from `instanceSpec`:
 * the engines never recommend a type they cannot describe, and a test lists how
 * much of each catalogue is covered.
 *
 * Also here, because none of it is in the generated catalogue:
 * - the Azure constrained-vCPU sizes (Standard_E16-8ds_v5 …), from Microsoft's
 *   page, accepted wherever a catalogue name is (`inCatalog`);
 * - the SAP HANA certified lists per cloud;
 * - OCI Flex shape limits.
 *
 * Every family row and list carries a source and a verification tag:
 * 'V-DOC' read from the provider's page (2026-09-26); 'I' inferred from the
 * naming convention or recalled, not re-read — verify before relying on it.
 */

import type { Verification } from '../vcf/provenance.ts';
import {
  AWS_INSTANCE_TYPE_GROUPS, AZURE_VM_SIZE_GROUPS, GCP_MACHINE_TYPE_GROUPS, OCI_SHAPE_GROUPS, type GroupedValues,
} from './sizes-data.ts';

export type SpecPlatform = 'aws' | 'azure' | 'google' | 'oci';
export type InstanceClass = 'general' | 'compute' | 'memory' | 'burstable' | 'storage' | 'gpu' | 'hpc';
export type CpuArch = 'x86' | 'arm';
export type CpuVendor = 'intel' | 'amd' | 'arm';

export interface FlexLimits {
  readonly maxOcpus: number;
  readonly maxMemoryGb: number;
  /** Memory per OCPU, GB. */
  readonly minGbPerOcpu: number;
  readonly maxGbPerOcpu: number;
  /** vCPU per OCPU: 2 on x86 and A2/A4, 1 on A1. */
  readonly vcpuPerOcpu: number;
}

export interface InstanceSpec {
  readonly platform: SpecPlatform;
  readonly name: string;
  /** Family / series key, e.g. 'm7i', 'Ds_v5', 'n2-standard', 'VM.Standard.E5.Flex'. */
  readonly family: string;
  readonly vcpu: number;
  readonly ramGib: number;
  readonly class: InstanceClass;
  /** The family's generation number (AWS 7 in m7i, Azure 5 in _v5, Google 4 in n4). */
  readonly generation: number;
  /** Counted current for the policy's "latest generation" choice. */
  readonly current: boolean;
  readonly burstable: boolean;
  readonly arch: CpuArch;
  readonly vendor: CpuVendor;
  /** Local NVMe / temp SSD. */
  readonly localNvme: boolean;
  readonly metal: boolean;
  /** Letters beyond the processor in the family name (d, n, b, e, z, -flex …): 0 for the base variant. */
  readonly variant: number;
  /** Google: attaches Hyperdisk only (no Persistent Disk). */
  readonly hyperdiskOnly?: boolean;
  /** OCI Flex: any OCPU count and memory within these limits; vcpu / ramGib are the maxima. */
  readonly flex?: FlexLimits;
  /** Azure constrained-vCPU size: the parent it is cut from (billed as the parent). */
  readonly constrained?: { readonly parent: string; readonly parentVcpu: number };
  readonly verification: Verification;
  readonly source: string;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const SPEC_SOURCES = {
  aws: 'https://docs.aws.amazon.com/ec2/latest/instancetypes/instance-types.html',
  azure: 'https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/overview',
  azureConstrained: 'https://learn.microsoft.com/en-us/azure/virtual-machines/constrained-vcpu',
  google: 'https://docs.cloud.google.com/compute/docs/machine-resource',
  googleHyperdisk: 'https://docs.cloud.google.com/compute/docs/disks/hyperdisks',
  oci: 'https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm',
  sapAws: 'https://docs.aws.amazon.com/sap/latest/general/sap-hana-aws-ec2.html',
  sapAzure: 'https://learn.microsoft.com/en-us/azure/sap/workloads/hana-vm-premium-ssd-v1',
  sapGoogle: 'https://docs.cloud.google.com/sap/docs/sap-hana-planning-guide',
  sapDirectory: 'https://www.sap.com/dmc/exp/2014-09-02-hana-hardware/enEN/',
  sapOci: 'https://docs.oracle.com/en/solutions/deploy-sap-hana-oci/',
} as const;

// ---------------------------------------------------------------------------
// Catalogue membership
// ---------------------------------------------------------------------------

const names = (groups: GroupedValues): string[] => Object.values(groups).flatMap((v) => v.split(','));
const CATALOG_NAMES: Readonly<Record<SpecPlatform, readonly string[]>> = {
  aws: names(AWS_INSTANCE_TYPE_GROUPS),
  azure: names(AZURE_VM_SIZE_GROUPS),
  google: names(GCP_MACHINE_TYPE_GROUPS),
  oci: names(OCI_SHAPE_GROUPS),
};
const CATALOG: Readonly<Record<SpecPlatform, ReadonlySet<string>>> = {
  aws: new Set(CATALOG_NAMES.aws),
  azure: new Set(CATALOG_NAMES.azure),
  google: new Set(CATALOG_NAMES.google),
  oci: new Set(CATALOG_NAMES.oci),
};

/** The catalogue group a name sits in (e.g. 'Memory optimized'), or undefined. */
export function catalogGroup(platform: SpecPlatform, name: string): string | undefined {
  const groups = { aws: AWS_INSTANCE_TYPE_GROUPS, azure: AZURE_VM_SIZE_GROUPS, google: GCP_MACHINE_TYPE_GROUPS, oci: OCI_SHAPE_GROUPS }[platform];
  for (const [g, v] of Object.entries(groups)) if (v.split(',').includes(name)) return g;
  return undefined;
}

// ---------------------------------------------------------------------------
// Azure constrained-vCPU sizes (not in the generated catalogue)
// ---------------------------------------------------------------------------

/**
 * Every constrained-vCPU size on Microsoft's page (read 2026-09-26, page dated
 * 2025-10-16). The active vCPU count is the number after the hyphen. Only those
 * whose parent is in `sizes-data.ts` are sellable here (`AZURE_CONSTRAINED_SIZES`);
 * the rest wait for their parent series to reach the catalogue.
 * https://learn.microsoft.com/en-us/azure/virtual-machines/constrained-vcpu
 */
export const AZURE_CONSTRAINED_PAGE: readonly string[] = Object.freeze([
  // M family
  'Standard_M8-2ms', 'Standard_M8-4ms', 'Standard_M16-4ms', 'Standard_M16-8ms', 'Standard_M32-8ms', 'Standard_M32-16ms',
  'Standard_M64-32ms', 'Standard_M64-16ms', 'Standard_M128-64ms', 'Standard_M128-32ms',
  'Standard_M416-208s_v2', 'Standard_M416-208ms_v2',
  'Standard_M64-32bds_1_v3', 'Standard_M96-48bds_2_v3', 'Standard_M128-64bds_3_v3', 'Standard_M176-88bds_4_v3',
  'Standard_M128-64bds_v3', 'Standard_M176-88bds_v3', 'Standard_M128-64bs_v3', 'Standard_M176-88bs_v3',
  // E family
  ...(['s_v3', 's_v4', 'ds_v4'] as const).flatMap((s) => [[4, 2], [8, 4], [8, 2], [16, 8], [16, 4], [32, 16], [32, 8], [64, 32], [64, 16]].map(([p, a]) => `Standard_E${p}-${a}${s}`)),
  ...(['s_v5', 'ds_v5', 'as_v4', 'ads_v5', 'as_v5'] as const).flatMap((s) =>
    [[4, 2], [8, 4], [8, 2], [16, 8], [16, 4], [32, 16], [32, 8], [64, 32], [64, 16], [96, 48], [96, 24]].map(([p, a]) => `Standard_E${p}-${a}${s}`)),
  ...(['s_v6', 'ds_v6', 'ads_v7', 'as_v7'] as const).flatMap((s) =>
    [[4, 2], [8, 2], [8, 4], [16, 4], [16, 8], [32, 8], [32, 16], [64, 16], [64, 32], [96, 24], [96, 48], [128, 32], [128, 64]].map(([p, a]) => `Standard_E${p}-${a}${s}`)),
  // F family
  ...(['amds_v7', 'ams_v7'] as const).flatMap((s) =>
    [[2, 1], [4, 1], [4, 2], [8, 2], [8, 4], [16, 4], [16, 8], [32, 8], [32, 16], [64, 16], [64, 32]].map(([p, a]) => `Standard_F${p}-${a}${s}`)),
  // FX family
  ...(['mds_v2', 'ms_v2'] as const).flatMap((s) =>
    [[4, 2], [8, 4], [8, 2], [12, 6], [16, 8], [16, 4], [24, 12], [24, 6], [32, 16], [32, 8], [48, 24], [48, 12], [64, 32], [64, 16], [96, 48], [96, 24]].map(([p, a]) => `Standard_FX${p}-${a}${s}`)),
  // G and D families
  'Standard_GS4-8', 'Standard_GS4-4', 'Standard_GS5-16', 'Standard_GS5-8',
  'Standard_DS11-1_v2', 'Standard_DS12-2_v2', 'Standard_DS12-1_v2', 'Standard_DS13-4_v2', 'Standard_DS13-2_v2', 'Standard_DS14-8_v2', 'Standard_DS14-4_v2',
]);

/** The parent a constrained name is cut from: `Standard_E16-8ds_v5` → `Standard_E16ds_v5`. */
export function constrainedParent(name: string): { parent: string; active: number; parentVcpu: number } | undefined {
  const m = /^Standard_([A-Z]+)(\d+)-(\d+)(.*)$/.exec(name);
  if (!m) return undefined;
  return { parent: `Standard_${m[1]}${m[2]}${m[4]}`, active: Number(m[3]), parentVcpu: Number(m[2]) };
}

/** The constrained sizes whose parent is in the catalogue: these are sellable and sized. */
export const AZURE_CONSTRAINED_SIZES: readonly string[] = Object.freeze(
  AZURE_CONSTRAINED_PAGE.filter((n) => {
    const p = constrainedParent(n);
    return !!p && CATALOG.azure.has(p.parent);
  }),
);

/**
 * Is `name` a type the platform sells: in `sizes-data.ts`, or on Azure a
 * constrained-vCPU size (from Microsoft's page) of a catalogued parent.
 */
export function inCatalog(platform: SpecPlatform, name: string): boolean {
  if (CATALOG[platform].has(name)) return true;
  return platform === 'azure' && AZURE_CONSTRAINED_SIZES.includes(name);
}

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

interface FamilyRow {
  readonly class: InstanceClass;
  /** GiB per vCPU. */
  readonly ratio: number;
  readonly verification: Verification;
  /** Irregular sizes: size → [vcpu, GiB]. */
  readonly sizes?: Readonly<Record<string, readonly [number, number]>>;
  /** Only these sizes are described (explicit families). */
  readonly only?: boolean;
  readonly vendor?: CpuVendor;
  readonly current?: boolean;
}

const r = (klass: InstanceClass, ratio: number, verification: Verification = 'I', extra: Partial<FamilyRow> = {}): FamilyRow => ({ class: klass, ratio, verification, ...extra });

const T_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  nano: [2, 0.5], micro: [2, 1], small: [2, 2], medium: [2, 4], large: [2, 8], xlarge: [4, 16], '2xlarge': [8, 32],
};
const T2_SIZES: Readonly<Record<string, readonly [number, number]>> = { ...T_SIZES, nano: [1, 0.5], micro: [1, 1], small: [1, 2] };

/**
 * AWS families. Ratios are the families' published GiB per vCPU; m7i / c7i /
 * r7i are checked against the rightsize ladders (V-DOC there). Families not
 * here (m1/m3/c1/c3/c4/c5n/r3/r4/i3/d2, most accelerated types, mac) return no
 * spec. 'I' = from the naming convention; verify.
 */
const AWS_FAMILIES: Readonly<Record<string, FamilyRow>> = {
  // general purpose, 4 GiB per vCPU
  ...Object.fromEntries(['m4', 'm5', 'm5a', 'm5ad', 'm5d', 'm5dn', 'm5n', 'm5zn', 'm6a', 'm6g', 'm6gd', 'm6i', 'm6id', 'm6idn', 'm6in',
    'm7a', 'm7g', 'm7gd', 'm7i-flex', 'm8a', 'm8g', 'm8gb', 'm8gd', 'm8gn', 'm8i', 'm8i-flex', 'm8ib', 'm8id', 'm8idb', 'm8idn', 'm8in', 'm8ine', 'm9g', 'm9gd',
  ].map((f) => [f, r('general', 4)])),
  m7i: r('general', 4, 'V-DOC'),
  a1: r('general', 2),
  // compute optimised, 2 GiB per vCPU
  ...Object.fromEntries(['c5', 'c5a', 'c5ad', 'c5d', 'c6a', 'c6g', 'c6gd', 'c6gn', 'c6i', 'c6id', 'c6in', 'c7a', 'c7g', 'c7gd', 'c7gn', 'c7i-flex',
    'c8a', 'c8g', 'c8gb', 'c8gd', 'c8gn', 'c8i', 'c8i-flex', 'c8ib', 'c8id', 'c8in', 'c8ine', 'c9g', 'c9gd',
  ].map((f) => [f, r('compute', 2)])),
  c7i: r('compute', 2, 'V-DOC'),
  // memory optimised, 8 GiB per vCPU
  ...Object.fromEntries(['r5', 'r5a', 'r5ad', 'r5b', 'r5d', 'r5dn', 'r5n', 'r6a', 'r6g', 'r6gd', 'r6id', 'r6idn', 'r6in', 'r7a', 'r7g', 'r7gd', 'r7iz',
    'r8a', 'r8g', 'r8gb', 'r8gd', 'r8gn', 'r8i-flex', 'r8ib', 'r8id', 'r8idb', 'r8idn', 'r8in', 'r9g', 'r9gd', 'z1d',
  ].map((f) => [f, r('memory', 8)])),
  r6i: r('memory', 8, 'V-DOC'), // SAP HANA table: r6i.8xlarge 32 / 256
  r7i: r('memory', 8, 'V-DOC'),
  r8i: r('memory', 8, 'V-DOC'), // SAP HANA table: r8i.12xlarge 48 / 384
  x2gd: r('memory', 16), x8g: r('memory', 16),
  x2idn: r('memory', 16, 'V-DOC'), x8i: r('memory', 16, 'V-DOC'),
  x2iedn: r('memory', 32, 'V-DOC'), x2iezn: r('memory', 32),
  x1: r('memory', 15.25, 'V-DOC', { sizes: { '16xlarge': [64, 976], '32xlarge': [128, 1952] }, only: true }),
  x1e: r('memory', 30.5, 'V-DOC', { sizes: { xlarge: [4, 122], '2xlarge': [8, 244], '4xlarge': [16, 488], '8xlarge': [32, 976], '16xlarge': [64, 1952], '32xlarge': [128, 3904] }, only: true }),
  // High memory (SAP HANA table, V-DOC)
  'u-3tb1': r('memory', 0, 'V-DOC', { sizes: { '56xlarge': [224, 3072] }, only: true, current: false }),
  'u-6tb1': r('memory', 0, 'V-DOC', { sizes: { '56xlarge': [224, 6144], '112xlarge': [448, 6144] }, only: true, current: false }),
  'u-9tb1': r('memory', 0, 'V-DOC', { sizes: { '112xlarge': [448, 9216] }, only: true, current: false }),
  'u-12tb1': r('memory', 0, 'V-DOC', { sizes: { '112xlarge': [448, 12288] }, only: true, current: false }),
  'u-18tb1': r('memory', 0, 'V-DOC', { sizes: { '112xlarge': [448, 18432] }, only: true, current: false }),
  'u-24tb1': r('memory', 0, 'V-DOC', { sizes: { '112xlarge': [448, 24576] }, only: true, current: false }),
  'u7i-6tb': r('memory', 0, 'V-DOC', { sizes: { '112xlarge': [448, 6144] }, only: true }),
  'u7i-8tb': r('memory', 0, 'V-DOC', { sizes: { '112xlarge': [448, 8192] }, only: true }),
  'u7i-12tb': r('memory', 0, 'V-DOC', { sizes: { '224xlarge': [896, 12288] }, only: true }),
  'u7ib-12tb': r('memory', 0, 'I', { sizes: { '224xlarge': [896, 12288] }, only: true }),
  'u7in-16tb': r('memory', 0, 'V-DOC', { sizes: { '224xlarge': [896, 16384] }, only: true }),
  'u7in-24tb': r('memory', 0, 'V-DOC', { sizes: { '224xlarge': [896, 24576] }, only: true }),
  'u7in-32tb': r('memory', 0, 'I', { sizes: { '224xlarge': [896, 32768] }, only: true }),
  'u7inh-32tb': r('memory', 0, 'V-DOC', { sizes: { '480xlarge': [1920, 32768] }, only: true }),
  // burstable
  t2: r('burstable', 4, 'I', { sizes: T2_SIZES, only: true }),
  t3: r('burstable', 4, 'I', { sizes: T_SIZES, only: true }),
  t3a: r('burstable', 4, 'I', { sizes: T_SIZES, only: true }),
  t4g: r('burstable', 4, 'I', { sizes: T_SIZES, only: true }),
  // storage optimised (local NVMe)
  i3en: r('storage', 8), i4i: r('storage', 8), i4g: r('storage', 8), i7i: r('storage', 8), i7ie: r('storage', 8),
  i8g: r('storage', 8), i8ge: r('storage', 8), im4gn: r('storage', 4), is4gen: r('storage', 6), d3: r('storage', 8), d3en: r('storage', 4), h1: r('storage', 4),
  // accelerated (a few, GPU class)
  g4dn: r('gpu', 4), g5: r('gpu', 4), g6: r('gpu', 4),
};

/** The generation from which a family counts as current, per class (AWS). */
const AWS_CURRENT_FROM: Readonly<Record<InstanceClass, number>> = { general: 7, compute: 7, memory: 7, burstable: 3, storage: 7, gpu: 5, hpc: 7 };

function awsSizeVcpu(size: string): number | undefined {
  if (size === 'medium') return 1;
  if (size === 'large') return 2;
  if (size === 'xlarge') return 4;
  const m = /^(\d+)xlarge$/.exec(size);
  if (m) return 4 * Number(m[1]);
  const mm = /^metal-(\d+)xl$/.exec(size);
  if (mm) return 4 * Number(mm[1]);
  return undefined;
}

function awsParseFamily(family: string): { gen: number; vendor: CpuVendor; variant: number } {
  const m = /^[a-z]+?(\d+)([a-z]*)(-flex)?$/.exec(family);
  const gen = m ? Number(m[1]) : 0;
  const suffix = m?.[2] ?? '';
  const vendor: CpuVendor = suffix.startsWith('g') ? 'arm' : suffix.startsWith('a') ? 'amd' : 'intel';
  const extra = suffix.replace(/^[gai]/, '');
  return { gen, vendor, variant: extra.length + (m?.[3] ? 1 : 0) };
}

function awsSpec(name: string): InstanceSpec | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  const family = name.slice(0, dot);
  const size = name.slice(dot + 1);
  const row = AWS_FAMILIES[family];
  if (!row) return undefined;
  const explicit = row.sizes?.[size];
  let vcpu: number | undefined;
  let ram: number | undefined;
  if (explicit) [vcpu, ram] = explicit;
  else if (!row.only) {
    vcpu = awsSizeVcpu(size);
    // Graviton / a1 'medium' is one vCPU at the family ratio.
    if (vcpu !== undefined) ram = vcpu * row.ratio;
  }
  if (vcpu === undefined || ram === undefined) return undefined;
  const p = awsParseFamily(family);
  const vendor = row.vendor ?? (family.startsWith('a1') ? 'arm' : p.vendor);
  const gen = family.startsWith('u7') ? 7 : family.startsWith('u-') ? 5 : p.gen;
  return {
    platform: 'aws', name, family, vcpu, ramGib: ram, class: row.class, generation: gen,
    current: row.current ?? gen >= AWS_CURRENT_FROM[row.class],
    burstable: row.class === 'burstable', arch: vendor === 'arm' ? 'arm' : 'x86', vendor,
    localNvme: row.class === 'storage' || /\d[a-z]*d/.test(family.replace(/-flex$/, '')), metal: size.startsWith('metal'),
    variant: p.variant, verification: row.verification, source: SPEC_SOURCES.aws,
  };
}

// ---------------------------------------------------------------------------
// Azure
// ---------------------------------------------------------------------------

/** Series key → row. Key: letters, '#', lowercase suffix, then '_' + the tail (`D#s_v5`, `NC#as_T4_v3`). */
const AZURE_SERIES: Readonly<Record<string, FamilyRow>> = {
  ...Object.fromEntries(['D#_v5', 'D#s_v5', 'D#d_v5', 'D#as_v5', 'D#ads_v5', 'D#ps_v5', 'D#pds_v5', 'D#s_v6', 'D#ds_v6', 'D#as_v6', 'D#ads_v6', 'D#_v3', 'D#s_v3', 'D#a_v4', 'D#as_v4']
    .map((k) => [k, r('general', 4)])),
  'D#ds_v5': r('general', 4, 'V-DOC'),
  ...Object.fromEntries(['D#ls_v5', 'D#lds_v5', 'D#pls_v5', 'D#plds_v5', 'D#ls_v6', 'D#lds_v6', 'D#als_v6', 'D#alds_v6'].map((k) => [k, r('general', 2)])),
  'D#_v2': r('general', 3.5, 'I', { sizes: { 1: [1, 3.5], 2: [2, 7], 3: [4, 14], 4: [8, 28], 5: [16, 56] }, only: true }),
  'DS#_v2': r('general', 3.5, 'I', { sizes: { 1: [1, 3.5], 2: [2, 7], 3: [4, 14], 4: [8, 28], 5: [16, 56] }, only: true }),
  'A#_v2': r('general', 2, 'I', { sizes: { 1: [1, 2], 2: [2, 4], 4: [4, 8], 8: [8, 16] }, only: true }),
  'A#m_v2': r('general', 8, 'I', { sizes: { 2: [2, 16], 4: [4, 32], 8: [8, 64] }, only: true }),
  // burstable
  'B#ls': r('burstable', 0.5, 'I', { sizes: { 1: [1, 0.5] }, only: true }),
  'B#s': r('burstable', 1, 'I', { sizes: { 1: [1, 1], 2: [2, 4] }, only: true }),
  'B#ms': r('burstable', 4, 'I', { sizes: { 1: [1, 2], 2: [2, 8], 4: [4, 16], 8: [8, 32], 12: [12, 48], 16: [16, 64], 20: [20, 80] }, only: true }),
  'B#ls_v2': r('burstable', 2), 'B#s_v2': r('burstable', 4), 'B#als_v2': r('burstable', 2), 'B#as_v2': r('burstable', 4),
  'B#ts_v2': r('burstable', 0.5, 'I', { sizes: { 2: [2, 1] }, only: true }),
  // compute optimised
  'F#s_v2': r('compute', 2, 'V-DOC'), 'F#': r('compute', 2), 'F#s': r('compute', 2),
  'F#as_v6': r('compute', 4), 'F#ads_v6': r('compute', 4), 'F#als_v6': r('compute', 2), 'F#alds_v6': r('compute', 2),
  'F#ams_v6': r('compute', 8), 'F#amds_v6': r('compute', 8),
  'FX#mds': r('compute', 21),
  // memory optimised (E96 / E104 v5 are 672 GiB, not 8 × vCPU)
  ...Object.fromEntries(['E#_v5', 'E#s_v5', 'E#d_v5', 'E#as_v5', 'E#ads_v5'].map((k) => [k, r('memory', 8, 'I', { sizes: { 96: [96, 672], 104: [104, 672] } })])),
  'E#ds_v5': r('memory', 8, 'V-DOC', { sizes: { 96: [96, 672], 104: [104, 672] } }),
  ...Object.fromEntries(['E#ps_v5', 'E#pds_v5', 'E#s_v6', 'E#ds_v6', 'E#as_v6', 'E#ads_v6', 'E#bs_v5', 'E#bds_v5'].map((k) => [k, r('memory', 8)])),
  'E#_v3': r('memory', 8, 'I', { sizes: { 64: [64, 432] } }),
  'E#s_v3': r('memory', 8, 'I', { sizes: { 64: [64, 432] } }),
  // M series: explicit (memory from Microsoft's SAP HANA storage tables, V-DOC)
  'M#ms': r('memory', 0, 'V-DOC', { sizes: { 8: [8, 218.75], 16: [16, 437.5], 32: [32, 875], 64: [64, 1792], 128: [128, 3892] }, only: true }),
  'M#ts': r('memory', 0, 'V-DOC', { sizes: { 32: [32, 192] }, only: true }),
  'M#ls': r('memory', 0, 'V-DOC', { sizes: { 32: [32, 256], 64: [64, 512] }, only: true }),
  'M#': r('memory', 0, 'I', { sizes: { 64: [64, 1000], 128: [128, 2000] }, only: true }),
  'M#s': r('memory', 0, 'V-DOC', { sizes: { 64: [64, 1024], 128: [128, 2048] }, only: true }),
  'M#ms_v2': r('memory', 0, 'V-DOC', { sizes: { 32: [32, 875], 64: [64, 1792], 128: [128, 3892], 208: [208, 5700], 416: [416, 11400] }, only: true }),
  'M#s_v2': r('memory', 0, 'V-DOC', { sizes: { 64: [64, 1024], 128: [128, 2048], 208: [208, 2850], 416: [416, 5700] }, only: true }),
  'M#is_v2': r('memory', 0, 'V-DOC', { sizes: { 192: [192, 2048] }, only: true }),
  'M#ims_v2': r('memory', 0, 'V-DOC', { sizes: { 192: [192, 4096] }, only: true }),
  // storage optimised
  'L#s_v3': r('storage', 8), 'L#as_v3': r('storage', 8), 'L#s_v4': r('storage', 8), 'L#as_v4': r('storage', 8), 'L#s_v2': r('storage', 8), 'L#s': r('storage', 8),
  // GPU (explicit)
  'NC#as_T4_v3': r('gpu', 0, 'I', { sizes: { 4: [4, 28], 8: [8, 56], 16: [16, 110], 64: [64, 440] }, only: true }),
  'NV#ads_A10_v5': r('gpu', 0, 'I', { sizes: { 6: [6, 55], 12: [12, 110], 18: [18, 220], 36: [36, 440], 72: [72, 880] }, only: true }),
};

interface AzureName { series: string; size: number; active?: number; suffix: string; tail: string; letters: string }

function parseAzure(name: string): AzureName | undefined {
  const m = /^Standard_([A-Z]+)(\d+)(?:-(\d+))?([a-z]*)(?:_(.+))?$/.exec(name);
  if (!m) return undefined;
  const [, letters, size, active, suffix, tail] = m;
  return { letters: letters!, size: Number(size), ...(active ? { active: Number(active) } : {}), suffix: suffix!, tail: tail ?? '', series: `${letters}#${suffix}${tail ? `_${tail}` : ''}` };
}

function azureSpecOf(name: string): InstanceSpec | undefined {
  const p = parseAzure(name);
  if (!p) return undefined;
  const row = AZURE_SERIES[p.series];
  if (!row) return undefined;
  const explicit = row.sizes?.[String(p.size)];
  let vcpu: number;
  let ram: number;
  if (explicit) [vcpu, ram] = explicit;
  else if (row.only) return undefined;
  else [vcpu, ram] = [p.size, p.size * row.ratio];
  const gen = Number(/v(\d+)$/.exec(p.tail)?.[1] ?? 1);
  const arm = p.suffix.includes('p');
  const amd = !arm && p.suffix.includes('a') && p.letters !== 'A';
  const vendor: CpuVendor = arm ? 'arm' : amd ? 'amd' : 'intel';
  // Letters beyond processor / premium-storage / low-memory; a series without
  // 's' cannot take Premium SSD, so it ranks well below its 's' sibling.
  const extra = p.suffix.replace(/[apsl]/g, '').length + (p.suffix.includes('s') ? 0 : 2);
  return {
    platform: 'azure', name, family: p.series.replace('#', ''), vcpu, ramGib: ram, class: row.class, generation: gen,
    current: row.current ?? (row.class === 'burstable' ? gen >= 2 : row.class === 'memory' && p.letters === 'M' ? true : gen >= 5),
    burstable: row.class === 'burstable', arch: arm ? 'arm' : 'x86', vendor,
    localNvme: p.suffix.includes('d') || row.class === 'storage', metal: false,
    variant: extra, verification: row.verification, source: SPEC_SOURCES.azure,
  };
}

function azureSpec(name: string): InstanceSpec | undefined {
  if (AZURE_CONSTRAINED_SIZES.includes(name)) {
    const c = constrainedParent(name)!;
    const parent = azureSpecOf(c.parent);
    if (!parent) return undefined;
    return {
      ...parent, name, vcpu: c.active, constrained: { parent: c.parent, parentVcpu: parent.vcpu },
      verification: 'V-DOC', source: SPEC_SOURCES.azureConstrained,
    };
  }
  return azureSpecOf(name);
}

// ---------------------------------------------------------------------------
// Google Cloud (GCP)
// ---------------------------------------------------------------------------

interface GoogleSeries {
  readonly gen: number;
  readonly vendor: CpuVendor;
  readonly types: Readonly<Partial<Record<'standard' | 'highmem' | 'highcpu', number>>>;
  readonly verification: Verification;
  readonly hyperdiskOnly?: boolean;
  readonly class?: InstanceClass;
  readonly sizes?: Readonly<Record<string, readonly [number, number]>>;
}

/**
 * Google series: GiB per vCPU by type. n2 is checked against the rightsize
 * ladder (V-DOC there). The Hyperdisk-only series (N4, C4, C4A, C4D, M4, X4)
 * are recalled, not re-read: Google's table could not be read cleanly on
 * 2026-09-26, so they carry 'I'.
 */
const GOOGLE_SERIES: Readonly<Record<string, GoogleSeries>> = {
  n1: { gen: 1, vendor: 'intel', types: { standard: 3.75, highmem: 6.5, highcpu: 0.9 }, verification: 'I', sizes: { 'n1-highmem-32': [32, 208], 'n1-highmem-64': [64, 416], 'n1-highmem-96': [96, 624] } },
  n2: { gen: 2, vendor: 'intel', types: { standard: 4, highmem: 8, highcpu: 1 }, verification: 'V-DOC', sizes: { 'n2-highmem-128': [128, 864] } },
  n2d: { gen: 2, vendor: 'amd', types: { standard: 4, highmem: 8, highcpu: 1 }, verification: 'I' },
  e2: { gen: 2, vendor: 'intel', types: { standard: 4, highmem: 8, highcpu: 1 }, verification: 'I' },
  n4: { gen: 4, vendor: 'intel', types: { standard: 4, highmem: 8, highcpu: 2 }, verification: 'I', hyperdiskOnly: true },
  t2d: { gen: 2, vendor: 'amd', types: { standard: 4 }, verification: 'I' },
  t2a: { gen: 2, vendor: 'arm', types: { standard: 4 }, verification: 'I' },
  c2: { gen: 2, vendor: 'intel', types: { standard: 4 }, verification: 'I', class: 'compute' },
  c2d: { gen: 2, vendor: 'amd', types: { standard: 4, highmem: 8, highcpu: 2 }, verification: 'I', class: 'compute' },
  c3: { gen: 3, vendor: 'intel', types: { standard: 4, highmem: 8, highcpu: 2 }, verification: 'V-DOC', class: 'compute' },
  c3d: { gen: 3, vendor: 'amd', types: { standard: 4, highmem: 8, highcpu: 2 }, verification: 'I', class: 'compute' },
  c4: { gen: 4, vendor: 'intel', types: { standard: 3.75, highmem: 7.75, highcpu: 2 }, verification: 'I', class: 'compute', hyperdiskOnly: true },
  c4a: { gen: 4, vendor: 'arm', types: { standard: 4, highmem: 8, highcpu: 2 }, verification: 'I', class: 'compute', hyperdiskOnly: true },
  c4d: { gen: 4, vendor: 'amd', types: { standard: 3.875, highmem: 7.75, highcpu: 1.875 }, verification: 'I', class: 'compute', hyperdiskOnly: true },
  // memory optimised: explicit, from Google's SAP HANA planning guide (V-DOC; Google writes GB)
  m1: { gen: 1, vendor: 'intel', types: {}, verification: 'V-DOC', class: 'memory', sizes: { 'm1-ultramem-40': [40, 961], 'm1-ultramem-80': [80, 1922], 'm1-ultramem-160': [160, 3844], 'm1-megamem-96': [96, 1433] } },
  m2: { gen: 2, vendor: 'intel', types: {}, verification: 'V-DOC', class: 'memory', sizes: { 'm2-ultramem-208': [208, 5888], 'm2-ultramem-416': [416, 11776], 'm2-megamem-416': [416, 5888], 'm2-hypermem-416': [416, 8832] } },
  m3: { gen: 3, vendor: 'intel', types: {}, verification: 'V-DOC', class: 'memory', sizes: { 'm3-ultramem-32': [32, 976], 'm3-ultramem-64': [64, 1952], 'm3-ultramem-128': [128, 3904], 'm3-megamem-64': [64, 976], 'm3-megamem-128': [128, 1952] } },
  m4: { gen: 4, vendor: 'intel', types: {}, verification: 'V-DOC', class: 'memory', hyperdiskOnly: true, sizes: { 'm4-ultramem-224': [224, 5952], 'm4-megamem-28': [28, 372], 'm4-megamem-56': [56, 744], 'm4-megamem-112': [112, 1488], 'm4-megamem-224': [224, 2976] } },
  // X4 was renamed on 2025-12-12 (x4-960-16t-metal …); the catalogue still has the old names.
  x4: { gen: 4, vendor: 'intel', types: {}, verification: 'V-DOC', class: 'memory', hyperdiskOnly: true, sizes: { 'x4-megamem-960': [960, 16384], 'x4-megamem-1440': [1440, 24576], 'x4-megamem-1920': [1920, 32768] } },
  z3: { gen: 3, vendor: 'intel', types: {}, verification: 'I', class: 'storage', sizes: { 'z3-highmem-88': [88, 704], 'z3-highmem-176': [176, 1408] } },
  h3: { gen: 3, vendor: 'intel', types: {}, verification: 'I', class: 'hpc', sizes: { 'h3-standard-88': [88, 352] } },
  g2: { gen: 2, vendor: 'intel', types: { standard: 4 }, verification: 'I', class: 'gpu' },
};

const GOOGLE_SHARED_CORE: Readonly<Record<string, readonly [number, number]>> = {
  'e2-micro': [2, 1], 'e2-small': [2, 2], 'e2-medium': [2, 4], 'f1-micro': [1, 0.6], 'g1-small': [1, 1.7],
};

function googleSpec(name: string): InstanceSpec | undefined {
  const base = { platform: 'google' as const, name, metal: false, source: SPEC_SOURCES.google };
  const shared = GOOGLE_SHARED_CORE[name];
  if (shared) {
    const gen = name.startsWith('e2') ? 2 : 1;
    return { ...base, family: name.split('-')[0]!, vcpu: shared[0], ramGib: shared[1], class: 'burstable', generation: gen, current: gen >= 2, burstable: true, arch: 'x86', vendor: 'intel', localNvme: false, variant: 0, verification: 'I' };
  }
  const m = /^([a-z0-9]+)-([a-z]+)-(\d+)$/.exec(name);
  if (!m) return undefined;
  const [, series, type, n] = m;
  const s = GOOGLE_SERIES[series!];
  if (!s) return undefined;
  let vcpu: number;
  let ram: number;
  const explicit = s.sizes?.[name];
  if (explicit) [vcpu, ram] = explicit;
  else {
    const ratio = s.types[type as 'standard' | 'highmem' | 'highcpu'];
    if (ratio === undefined) return undefined;
    vcpu = Number(n);
    ram = vcpu * ratio;
  }
  const klass: InstanceClass = s.class && s.class !== 'compute'
    ? s.class
    : type === 'highmem' ? 'memory' : type === 'highcpu' ? 'compute' : s.class ?? 'general';
  return {
    ...base, family: `${series}-${type}`, vcpu, ramGib: ram, class: klass, generation: s.gen,
    current: s.gen >= 3 || series === 'n2' || series === 'n2d' || series === 't2a' || series === 't2d',
    burstable: false, arch: s.vendor === 'arm' ? 'arm' : 'x86', vendor: s.vendor, localNvme: klass === 'storage',
    variant: series === 'e2' ? 1 : 0, ...(s.hyperdiskOnly ? { hyperdiskOnly: true } : {}), verification: s.verification,
  };
}

// ---------------------------------------------------------------------------
// OCI
// ---------------------------------------------------------------------------

/**
 * OCI Flex shapes. E5.Flex's limits are the ones WP-4's rightsize.ts uses
 * (V-DOC there). The others were read on 2026-09-26 through a summariser whose
 * E5 figures disagreed with that, so they carry 'I': verify before relying on
 * the maxima.
 */
export const OCI_FLEX_SHAPES: Readonly<Record<string, FlexLimits & { readonly class: InstanceClass; readonly vendor: CpuVendor; readonly gen: number; readonly current: boolean; readonly verification: Verification }>> = {
  'VM.Standard.E5.Flex': { maxOcpus: 94, maxMemoryGb: 1049, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 2, class: 'general', vendor: 'amd', gen: 5, current: true, verification: 'V-DOC' },
  'VM.Standard.E6.Flex': { maxOcpus: 126, maxMemoryGb: 1454, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 2, class: 'general', vendor: 'amd', gen: 6, current: true, verification: 'I' },
  'VM.Standard.E4.Flex': { maxOcpus: 64, maxMemoryGb: 1024, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 2, class: 'general', vendor: 'amd', gen: 4, current: false, verification: 'I' },
  'VM.Standard3.Flex': { maxOcpus: 32, maxMemoryGb: 512, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 2, class: 'general', vendor: 'intel', gen: 3, current: false, verification: 'I' },
  'VM.Optimized3.Flex': { maxOcpus: 18, maxMemoryGb: 256, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 2, class: 'compute', vendor: 'intel', gen: 3, current: true, verification: 'I' },
  'VM.Standard.A1.Flex': { maxOcpus: 76, maxMemoryGb: 472, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 1, class: 'general', vendor: 'arm', gen: 1, current: false, verification: 'I' },
  'VM.Standard.A2.Flex': { maxOcpus: 78, maxMemoryGb: 946, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 2, class: 'general', vendor: 'arm', gen: 2, current: true, verification: 'I' },
  'VM.Standard.A4.Flex': { maxOcpus: 45, maxMemoryGb: 700, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 2, class: 'general', vendor: 'arm', gen: 4, current: true, verification: 'I' },
  'VM.Standard.E3.Flex': { maxOcpus: 64, maxMemoryGb: 1024, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 2, class: 'general', vendor: 'amd', gen: 3, current: false, verification: 'I' },
  'VM.Standard.E6.Ax.Flex': { maxOcpus: 94, maxMemoryGb: 712, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 2, class: 'general', vendor: 'amd', gen: 6, current: false, verification: 'I' },
  'VM.Standard4.Ax.Flex': { maxOcpus: 39, maxMemoryGb: 360, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 2, class: 'general', vendor: 'intel', gen: 4, current: false, verification: 'I' },
  'VM.Standard.A4.Ax.Flex': { maxOcpus: 45, maxMemoryGb: 720, minGbPerOcpu: 1, maxGbPerOcpu: 64, vcpuPerOcpu: 2, class: 'general', vendor: 'arm', gen: 4, current: false, verification: 'I' },
  'VM.DenseIO.E6.Ax.Flex': { maxOcpus: 48, maxMemoryGb: 576, minGbPerOcpu: 12, maxGbPerOcpu: 12, vcpuPerOcpu: 2, class: 'storage', vendor: 'amd', gen: 6, current: false, verification: 'I' },
  'VM.DenseIO.E5.Flex': { maxOcpus: 48, maxMemoryGb: 576, minGbPerOcpu: 12, maxGbPerOcpu: 12, vcpuPerOcpu: 2, class: 'storage', vendor: 'amd', gen: 5, current: true, verification: 'I' },
  'VM.DenseIO.E4.Flex': { maxOcpus: 32, maxMemoryGb: 512, minGbPerOcpu: 16, maxGbPerOcpu: 16, vcpuPerOcpu: 2, class: 'storage', vendor: 'amd', gen: 4, current: false, verification: 'I' },
};

/** Fixed OCI shapes: OCPUs and GB (legacy, not current). */
const OCI_FIXED: Readonly<Record<string, readonly [number, number, InstanceClass]>> = {
  'VM.Standard.E2.1.Micro': [1, 1, 'burstable'],
  ...Object.fromEntries([1, 2, 4, 8].map((n) => [`VM.Standard.E2.${n}`, [n, 8 * n, 'general'] as const])),
  ...Object.fromEntries([1, 2, 4, 8, 16].map((n) => [`VM.Standard2.${n}`, [n, 15 * n, 'general'] as const])),
  'VM.Standard2.24': [24, 320, 'general'],
  ...Object.fromEntries([1, 2, 4, 8, 16].map((n) => [`VM.Standard1.${n}`, [n, 7 * n, 'general'] as const])),
  ...Object.fromEntries([1, 2, 4, 8, 16].map((n) => [`VM.Standard.B1.${n}`, [n, 12 * n, 'general'] as const])),
  'VM.DenseIO2.8': [8, 120, 'storage'], 'VM.DenseIO2.16': [16, 240, 'storage'], 'VM.DenseIO2.24': [24, 320, 'storage'],
  'BM.Standard.E6.256': [256, 3072, 'general'], 'BM.Standard.E5.192': [192, 2304, 'general'], 'BM.Standard.E4.128': [128, 2048, 'general'],
  'BM.Standard3.64': [64, 1024, 'general'], 'BM.Standard2.52': [52, 768, 'general'],
};

function ociSpec(name: string): InstanceSpec | undefined {
  const flex = OCI_FLEX_SHAPES[name];
  const base = { platform: 'oci' as const, name, family: name, source: SPEC_SOURCES.oci, variant: 0 };
  if (flex) {
    return {
      ...base, vcpu: flex.maxOcpus * flex.vcpuPerOcpu, ramGib: flex.maxMemoryGb, class: flex.class, generation: flex.gen, current: flex.current,
      burstable: false, arch: flex.vendor === 'arm' ? 'arm' : 'x86', vendor: flex.vendor, localNvme: flex.class === 'storage', metal: false,
      flex: { maxOcpus: flex.maxOcpus, maxMemoryGb: flex.maxMemoryGb, minGbPerOcpu: flex.minGbPerOcpu, maxGbPerOcpu: flex.maxGbPerOcpu, vcpuPerOcpu: flex.vcpuPerOcpu },
      verification: flex.verification,
    };
  }
  const fixed = OCI_FIXED[name];
  if (!fixed) return undefined;
  const [ocpus, gb, klass] = fixed;
  const vendor: CpuVendor = /\.E\d/.test(name) ? 'amd' : 'intel';
  return {
    ...base, vcpu: ocpus * 2, ramGib: gb, class: klass, generation: Number(/(?:E|Standard|DenseIO)(\d)/.exec(name)?.[1] ?? 1), current: false,
    burstable: klass === 'burstable', arch: 'x86', vendor, localNvme: klass === 'storage', metal: name.startsWith('BM.'), verification: 'I',
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const CACHE = new Map<string, InstanceSpec | null>();

/** The spec of a catalogued type, or undefined when the name is not sold or not described. */
export function instanceSpec(platform: SpecPlatform, name: string): InstanceSpec | undefined {
  const key = `${platform}\u0000${name}`;
  if (CACHE.has(key)) return CACHE.get(key) ?? undefined;
  let spec: InstanceSpec | undefined;
  if (inCatalog(platform, name)) {
    spec = platform === 'aws' ? awsSpec(name) : platform === 'azure' ? azureSpec(name) : platform === 'google' ? googleSpec(name) : ociSpec(name);
  }
  CACHE.set(key, spec ?? null);
  return spec;
}

const ALL = new Map<SpecPlatform, readonly InstanceSpec[]>();

/** Every described type of a platform (catalogue names plus, on Azure, the constrained sizes). */
export function allSpecs(platform: SpecPlatform): readonly InstanceSpec[] {
  let list = ALL.get(platform);
  if (!list) {
    const pool = platform === 'azure' ? [...CATALOG_NAMES.azure, ...AZURE_CONSTRAINED_SIZES] : CATALOG_NAMES[platform];
    list = Object.freeze(pool.map((n) => instanceSpec(platform, n)).filter((s): s is InstanceSpec => !!s));
    ALL.set(platform, list);
  }
  return list;
}

/** The catalogue names a platform has with no spec here (for the coverage test and the report). */
export function unspecified(platform: SpecPlatform): string[] {
  return CATALOG_NAMES[platform].filter((n) => !instanceSpec(platform, n));
}

// ---------------------------------------------------------------------------
// SAP HANA certified types
// ---------------------------------------------------------------------------

export interface SapHanaType {
  readonly platform: SpecPlatform;
  readonly type: string;
  readonly vcpu: number;
  readonly memoryGib: number;
  readonly use: 'oltp' | 'olap' | 'both';
  /** SAPS where the provider publishes one. */
  readonly saps?: number;
  /** Certified for scale-out (OLAP nodes). */
  readonly scaleOut?: boolean;
  readonly verification: Verification;
  readonly source: string;
  readonly note?: string;
}

/** When the SAP lists below were read. Certification changes monthly: check SAP's directory before ordering. */
export const SAP_HANA_FETCHED_AT = '2026-09-26';

const sapAws = (type: string, vcpu: number, mem: number, saps: number | undefined, use: SapHanaType['use'] = 'both', scaleOut = false): SapHanaType =>
  ({ platform: 'aws', type, vcpu, memoryGib: mem, use, ...(saps ? { saps } : {}), ...(scaleOut ? { scaleOut } : {}), verification: 'V-DOC', source: SPEC_SOURCES.sapAws });
const sapAz = (type: string, vcpu: number, mem: number, note?: string): SapHanaType =>
  ({ platform: 'azure', type: `Standard_${type}`, vcpu, memoryGib: mem, use: 'both', verification: 'V-DOC', source: SPEC_SOURCES.sapAzure, ...(note ? { note } : {}) });
const sapGcp = (type: string, vcpu: number, mem: number, use: SapHanaType['use'] = 'both', scaleOut = false, note?: string): SapHanaType =>
  ({ platform: 'google', type, vcpu, memoryGib: mem, use, ...(scaleOut ? { scaleOut } : {}), verification: 'V-DOC', source: SPEC_SOURCES.sapGoogle, ...(note ? { note } : {}) });

const E_NOTE = 'E-series and Dv6: production needs Ultra Disk (or Premium SSD v2) for /hana/log to meet the HANA storage KPIs.';

/**
 * SAP HANA production-certified types, per cloud, restricted to names in the
 * machine catalogue.
 * - AWS: the current-generation scale-up table on AWS's page (SAPS as published).
 * - Azure: the VM types in Microsoft's production HANA storage configurations
 *   (M-series with Write Accelerator; E / D v5–v6 with Ultra Disk for the log).
 *   Microsoft says to confirm each in SAP's directory.
 * - Google Cloud (GCP): the planning guide's certified list (X4 under its
 *   pre-2025-12-12 names, which is what the catalogue has).
 * - OCI: not confirmed from an Oracle page; the bare-metal shapes below are
 *   recalled and marked 'I' — check SAP's directory.
 */
export const SAP_HANA_CERTIFIED: readonly SapHanaType[] = Object.freeze([
  sapAws('r5.8xlarge', 32, 256, 46257), sapAws('r5.12xlarge', 48, 384, 69385), sapAws('r5.16xlarge', 64, 512, 92513), sapAws('r5.24xlarge', 96, 768, 138770, 'both', true),
  sapAws('r5b.8xlarge', 32, 256, 46257), sapAws('r5b.12xlarge', 48, 384, 69385), sapAws('r5b.16xlarge', 64, 512, 92513), sapAws('r5b.24xlarge', 96, 768, 138770),
  sapAws('r6i.8xlarge', 32, 256, 49013, 'oltp'), sapAws('r6i.12xlarge', 48, 384, 73519), sapAws('r6i.16xlarge', 64, 512, 98025), sapAws('r6i.24xlarge', 96, 768, 147038, 'both', true), sapAws('r6i.32xlarge', 128, 1024, 196050, 'both', true),
  sapAws('r7i.8xlarge', 32, 256, 66480), sapAws('r7i.12xlarge', 48, 384, 99720), sapAws('r7i.16xlarge', 64, 512, 105500), sapAws('r7i.24xlarge', 96, 768, 158250), sapAws('r7i.48xlarge', 192, 1536, 296200),
  sapAws('r8i.12xlarge', 48, 384, 115270), sapAws('r8i.16xlarge', 64, 512, 138840), sapAws('r8i.24xlarge', 96, 768, 208260), sapAws('r8i.32xlarge', 128, 1024, 277680), sapAws('r8i.48xlarge', 192, 1536, 416520), sapAws('r8i.96xlarge', 384, 3072, 740050),
  sapAws('u-3tb1.56xlarge', 224, 3072, 237750), sapAws('u-6tb1.56xlarge', 224, 6144, 380770, 'both', true), sapAws('u-6tb1.112xlarge', 448, 6144, 475500, 'both', true),
  sapAws('u-9tb1.112xlarge', 448, 9216, 475500, 'both', true), sapAws('u-12tb1.112xlarge', 448, 12288, 475500, 'both', true),
  sapAws('u-18tb1.112xlarge', 448, 18432, 520330), sapAws('u-24tb1.112xlarge', 448, 24576, 508720, 'oltp'),
  sapAws('u7i-6tb.112xlarge', 448, 6144, 670265, 'both', true), sapAws('u7i-8tb.112xlarge', 448, 8192, 674950, 'both', true), sapAws('u7i-12tb.224xlarge', 896, 12288, 1254030),
  sapAws('u7in-16tb.224xlarge', 896, 16384, 1281620, 'both', true), sapAws('u7in-24tb.224xlarge', 896, 24576, 1225150, 'both', true), sapAws('u7inh-32tb.480xlarge', 1920, 32768, undefined, 'both', true),
  sapAws('x1.16xlarge', 64, 976, 65750, 'both', true), sapAws('x1.32xlarge', 128, 1952, 131500, 'both', true), sapAws('x1e.32xlarge', 128, 3904, 131500, 'both', true),
  sapAws('x2idn.16xlarge', 64, 1024, 98025, 'both', true), sapAws('x2idn.24xlarge', 96, 1536, 147038, 'both', true), sapAws('x2idn.32xlarge', 128, 2048, 196050, 'both', true),
  sapAws('x2iedn.24xlarge', 96, 3072, 141750, 'both', true), sapAws('x2iedn.32xlarge', 128, 4096, 189000, 'both', true),
  sapAws('x8i.12xlarge', 48, 768, 116280), sapAws('x8i.16xlarge', 64, 1024, 147370, 'both', true), sapAws('x8i.24xlarge', 96, 1536, 217824, 'both', true), sapAws('x8i.32xlarge', 128, 2048, 290420, 'both', true),
  { ...sapAws('x8i.48xlarge', 192, 3072, 413376, 'both', true), note: 'AWS\'s table prints 3,172 GiB; 192 vCPU × 16 GiB is 3,072.' },
  sapAws('x8i.64xlarge', 256, 4096, 551220, 'both', true), sapAws('x8i.96xlarge', 384, 6144, 733800, 'both', true),

  sapAz('M32ts', 32, 192), sapAz('M32ls', 32, 256), sapAz('M64ls', 64, 512), sapAz('M32ms_v2', 32, 875),
  sapAz('M64s', 64, 1024), sapAz('M64s_v2', 64, 1024), sapAz('M64ms', 64, 1792), sapAz('M64ms_v2', 64, 1792),
  sapAz('M128s', 128, 2048), sapAz('M128s_v2', 128, 2048), sapAz('M192is_v2', 192, 2048), sapAz('M128ms', 128, 3892), sapAz('M128ms_v2', 128, 3892),
  sapAz('M192ims_v2', 192, 4096), sapAz('M208s_v2', 208, 2850), sapAz('M208ms_v2', 208, 5700), sapAz('M416s_v2', 416, 5700), sapAz('M416ms_v2', 416, 11400),
  ...(['s_v5', 'ds_v5'] as const).flatMap((s) => [sapAz(`E20${s}`, 20, 160, E_NOTE), sapAz(`E32${s}`, 32, 256, E_NOTE), sapAz(`E48${s}`, 48, 384, E_NOTE), sapAz(`E64${s}`, 64, 512, E_NOTE), sapAz(`E96${s}`, 96, 672, E_NOTE)]),
  ...(['s_v6', 'ds_v6'] as const).flatMap((s) => [sapAz(`E32${s}`, 32, 256, E_NOTE), sapAz(`E48${s}`, 48, 384, E_NOTE), sapAz(`E64${s}`, 64, 512, E_NOTE), sapAz(`E96${s}`, 96, 768, E_NOTE), sapAz(`E128${s}`, 128, 1024, E_NOTE)]),
  ...(['s_v6', 'ds_v6'] as const).flatMap((s) => [sapAz(`D64${s}`, 64, 256, E_NOTE), sapAz(`D96${s}`, 96, 384, E_NOTE), sapAz(`D128${s}`, 128, 512, E_NOTE)]),
  sapAz('E64s_v3', 64, 432, E_NOTE),

  sapGcp('n1-highmem-32', 32, 208), sapGcp('n1-highmem-64', 64, 416), sapGcp('n1-highmem-96', 96, 624),
  sapGcp('n2-highmem-32', 32, 256), sapGcp('n2-highmem-48', 48, 384), sapGcp('n2-highmem-64', 64, 512), sapGcp('n2-highmem-80', 80, 640), sapGcp('n2-highmem-96', 96, 768), sapGcp('n2-highmem-128', 128, 864),
  sapGcp('c3-standard-44', 44, 176), sapGcp('c3-highmem-44', 44, 352), sapGcp('c3-highmem-88', 88, 704), sapGcp('c3-highmem-176', 176, 1408),
  sapGcp('m1-megamem-96', 96, 1433, 'both', true), sapGcp('m1-ultramem-40', 40, 961, 'oltp'), sapGcp('m1-ultramem-80', 80, 1922, 'oltp'), sapGcp('m1-ultramem-160', 160, 3844, 'both', true),
  sapGcp('m2-megamem-416', 416, 5888, 'both', true), sapGcp('m2-ultramem-208', 208, 5888, 'oltp'), sapGcp('m2-ultramem-416', 416, 11776, 'both', true), sapGcp('m2-hypermem-416', 416, 8832, 'both', true),
  sapGcp('m3-ultramem-32', 32, 976, 'oltp'), sapGcp('m3-ultramem-64', 64, 1952, 'oltp'), sapGcp('m3-ultramem-128', 128, 3904, 'both', true), sapGcp('m3-megamem-64', 64, 976), sapGcp('m3-megamem-128', 128, 1952, 'both', true),
  sapGcp('m4-megamem-28', 28, 372), sapGcp('m4-megamem-56', 56, 744), sapGcp('m4-megamem-112', 112, 1488), sapGcp('m4-megamem-224', 224, 2976, 'both', true), sapGcp('m4-ultramem-224', 224, 5952),
  sapGcp('x4-megamem-960', 960, 16384, 'both', true, 'Renamed x4-960-16t-metal on 2025-12-12.'),
  sapGcp('x4-megamem-1440', 1440, 24576, 'both', true, 'Renamed x4-1440-24t-metal on 2025-12-12.'),
  sapGcp('x4-megamem-1920', 1920, 32768, 'both', true, 'Renamed x4-1920-32t-metal on 2025-12-12.'),

  ...([['BM.Standard.E5.192', 384, 2304], ['BM.Standard.E4.128', 256, 2048], ['BM.Standard3.64', 128, 1024], ['BM.Standard2.52', 104, 768]] as const).map(([type, vcpu, mem]): SapHanaType => ({
    platform: 'oci', type, vcpu, memoryGib: mem, use: 'both', verification: 'I', source: SPEC_SOURCES.sapDirectory,
    note: 'Not confirmed from an Oracle page (the design marks OCI shapes [U]): check SAP\'s directory before ordering.',
  })),
]);

/** The certified types of one platform, smallest memory first. */
export function sapHanaTypes(platform: SpecPlatform, use?: 'oltp' | 'olap'): SapHanaType[] {
  return SAP_HANA_CERTIFIED
    .filter((t) => t.platform === platform && (!use || t.use === 'both' || t.use === use))
    .sort((a, b) => a.memoryGib - b.memoryGib || a.vcpu - b.vcpu || a.type.localeCompare(b.type));
}
