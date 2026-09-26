/**
 * The `server` engine (addendum A.2.8.3, A.3.6): a VM or server's demand from
 * its allocation or its measured utilisation, then the smallest catalogue type
 * that carries it.
 *
 * Sizing modes, as the providers offer them (methodology report 6(e) item 6):
 * - **as-is** ("as on-premises", Azure Migrate's "As-is on-premises", OCI's
 *   AS_IS): the allocated vCPU and memory;
 * - **performance-based**: a percentile of measured utilisation — P50, P90, P95
 *   (default), P99 or peak (max); OCI's AVERAGE is taken as P50 — times a
 *   headroom: Azure's comfort factor (`headroomPct`, 30 % = 1.3), or Google's
 *   CPU / memory target utilisation (moderate 70 / 85 %, aggressive 90 / 100 %);
 *   optionally times OCI's CPU benchmark multiplier (source ÷ target score).
 *   CPU and memory can take different strategies (OCI sets them per resource).
 * The mode, percentile and data confidence go on every row.
 *
 * Data confidence follows Azure Migrate's performance-coverage rating
 * (0–20 % one star … 81–100 % five stars): below 80 % a warning; below 60 % or
 * under 3 days the row falls back to its allocation (A.3.6).
 * https://learn.microsoft.com/en-us/azure/migrate/concepts-assessment-calculation
 *
 * This file also holds the helpers every engine shares (the default policy,
 * `chooseInstance`, the component look-ups), so the engines import them from
 * here rather than from `index.ts`, which imports the engines.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import {
  allSpecs, instanceSpec, OCI_FLEX_SHAPES, type InstanceClass, type InstanceSpec, type SpecPlatform,
} from '../../../kit/instance-specs.ts';
import { rightsizeFor, type RehostCloud } from '../../../kit/rightsize.ts';
import { VM_SERVICE } from '../db-catalog.ts';
import { isIaasService, isPerCoreByol, vsphereSize } from '../design/compute.ts';
import { osKind } from '../os.ts';
import type {
  AppComponent, Database, DbServiceId, InstanceFamily, PatternComponent, Percentile, Plan, Platform, SizingPolicy, SizingReason,
  SizingRecommendation, SizingRow, Workload,
} from '../types.ts';
import type { SizingEngine } from './index.ts';

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/** A.2.8.2 defaults: p95, 30 % headroom, provisioned disks, 10 %/yr over 3 years, latest generation, x86. */
export const DEFAULT_SIZING_POLICY: SizingPolicy = Object.freeze({
  basis: 'auto',
  percentile: 'p95',
  headroomPct: 30,
  diskBasis: 'provisioned',
  growthPctYear: 10,
  horizonYears: 3,
  families: Object.freeze(['general', 'compute', 'memory', 'burstable'] as InstanceFamily[]),
  burstableInProd: false,
  allowArm: false,
  latestGeneration: true,
  licenceOptimised: true,
  assumptions: Object.freeze({}),
});

export type SizingMode = 'as-is' | 'performance';
/** Per resource: a percentile, the allocation, or OCI's AVERAGE (taken as P50). */
export type ResourceStrategy = Percentile | 'as-is' | 'average';
export type HeadroomStyle = 'comfort-factor' | 'target-utilisation';

/**
 * The methodology settings beyond A.11's `SizingPolicy`. Optional; read
 * structurally from `plan.sizing.policy` so they can be added to types.ts
 * without a change here (reported to WP-0).
 */
export interface SizingMethodology {
  /** 'as-is' = allocation; 'performance' = utilisation. Default: from `basis`. */
  readonly mode?: SizingMode;
  readonly cpuStrategy?: ResourceStrategy;
  readonly memoryStrategy?: ResourceStrategy;
  /** Default 'comfort-factor' (headroomPct). */
  readonly headroomStyle?: HeadroomStyle;
  /** Target utilisation for 'target-utilisation', percent. Google moderate 70 / 85. */
  readonly cpuTargetPct?: number;
  readonly memoryTargetPct?: number;
  /** Source CPU score ÷ target CPU score (OCI's adjustment multiplier). Default 1. */
  readonly benchmarkMultiplier?: number;
}
export type SizingPolicyExt = SizingPolicy & SizingMethodology;

export const MIN_COVERAGE = 0.6;
export const MIN_DAYS = 3;
/** Azure Migrate: below 80 % performance coverage, recalculate or size as-is. */
export const CONFIDENCE_WARN = 0.8;
export const SOURCES = {
  azureCalc: 'https://learn.microsoft.com/en-us/azure/migrate/concepts-assessment-calculation',
  azureConfidence: 'https://learn.microsoft.com/en-us/azure/migrate/confidence-ratings',
  googlePrefs: 'https://docs.cloud.google.com/migration-center/docs/create-preference-set',
  ociStrategies: 'https://docs.oracle.com/en-us/iaas/Content/cloud-migration/cloud-migration-understanding-migration-strategies-cost-estimates.htm',
  vsphere: 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf.html',
} as const;

/** The plan's policy, with the defaults under it. */
export function policyOf(plan: Plan): SizingPolicyExt {
  return { ...DEFAULT_SIZING_POLICY, ...(plan.sizing?.policy ?? {}) };
}

/** Azure's five coverage bands: 0–20 % → 1 … 81–100 % → 5. */
export function confidenceStars(coverage: number): 1 | 2 | 3 | 4 | 5 {
  const pct = Math.round(Math.max(0, Math.min(1, coverage)) * 100);
  return pct <= 20 ? 1 : pct <= 40 ? 2 : pct <= 60 ? 3 : pct <= 80 ? 4 : 5;
}

// ---------------------------------------------------------------------------
// Component look-ups
// ---------------------------------------------------------------------------

export const isPattern = (c: AppComponent): c is PatternComponent => c.kind === 'pattern';
export function serversOf(c: AppComponent, plan: Plan): Workload[] {
  if (!isPattern(c)) return [];
  return c.servers.map((n) => plan.workloads.find((w) => w.name === n)).filter((w): w is Workload => !!w);
}
export function databasesOf(c: AppComponent, plan: Plan): Database[] {
  if (!isPattern(c)) return [];
  return c.databases.map((n) => plan.databases.find((d) => d.name === n)).filter((d): d is Database => !!d);
}
/** A pattern setting as a number, or the fallback. */
export function num(c: AppComponent, key: string, fallback: number): number {
  const v = isPattern(c) ? c.settings[key] : undefined;
  const n = v === undefined || v.trim() === '' ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
export function str(c: AppComponent, key: string, fallback = ''): string {
  return (isPattern(c) ? c.settings[key]?.trim() : undefined) || fallback;
}
/** The app plan that holds a component. */
export function appPlanOf(c: AppComponent, plan: Plan) {
  return (plan.appPlans ?? []).find((ap) => Object.values(ap.variants).some((list) => (list ?? []).some((x) => x.id === c.id)));
}
export const isProd = (env: string | undefined): boolean => env === undefined || env === 'prod' || env === 'dr';

export const reason = (text: string, extra: Omit<SizingReason, 'text'> = {}): SizingReason => ({ text, ...extra });
export const rec = (concern: SizingRecommendation['concern'], platform: Platform, rows: readonly SizingRow[], findings: readonly Finding[] = []): SizingRecommendation =>
  ({ concern, platform, rows, findings });
export const gib = (n: number): string => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));

// ---------------------------------------------------------------------------
// Demand
// ---------------------------------------------------------------------------

export interface ServerDemand {
  readonly vcpu: number;
  readonly ramGib: number;
  readonly basis: 'allocated' | 'utilisation' | 'observed' | 'load';
  readonly mode: SizingMode;
  /** e.g. 'p95'; empty for as-is. */
  readonly percentile: string;
  /** 0..1, when utilisation data exists. */
  readonly coverage?: number;
  readonly days?: number;
  readonly stars?: number;
  /** The grid's Basis chip: `utilisation p95 (14 d, 97%)`, `allocated`, `point-in-time`. */
  readonly chip: string;
  readonly reasons: readonly SizingReason[];
  readonly findings: readonly Finding[];
}

export interface DemandOptions {
  /** SAP / DB / large-memory: p99 or max instead of the policy percentile (A.3.6). */
  readonly peak?: boolean;
  /** Never below this memory (HANA / DB hosts keep their memory nameplate). */
  readonly floorRamGib?: number;
  /** requirements.sizeBy === 'active-memory' for the allocated basis. */
  readonly activeMemory?: boolean;
  /** Use `observedOnTarget` (post-move right-sizing, A.10.12). */
  readonly observed?: boolean;
}

type Pick3 = { value?: number; label: string; note?: string };

function cpuPct(u: NonNullable<NonNullable<Workload['facts']>['utilisation']>, s: ResourceStrategy): Pick3 {
  switch (s) {
    case 'p50': return { value: u.cpuP50Pct, label: 'p50' };
    case 'average': return { value: u.cpuP50Pct, label: 'p50', note: 'average is not collected; p50 used' };
    case 'p90': return { value: u.cpuP95Pct, label: 'p95', note: 'p90 is not collected; p95 used' };
    case 'p95': return { value: u.cpuP95Pct, label: 'p95' };
    case 'p99': return u.cpuP99Pct !== undefined ? { value: u.cpuP99Pct, label: 'p99' } : { value: u.cpuMaxPct ?? u.cpuP95Pct, label: u.cpuMaxPct !== undefined ? 'max' : 'p95', note: 'p99 not collected' };
    case 'max': return u.cpuMaxPct !== undefined ? { value: u.cpuMaxPct, label: 'max' } : { value: u.cpuP99Pct ?? u.cpuP95Pct, label: u.cpuP99Pct !== undefined ? 'p99' : 'p95', note: 'max not collected' };
    default: return { label: 'as-is' };
  }
}
function memGib(u: NonNullable<NonNullable<Workload['facts']>['utilisation']>, s: ResourceStrategy): Pick3 {
  if (s === 'as-is') return { label: 'as-is' };
  if (s === 'p99' || s === 'max') {
    return u.memMaxGib !== undefined ? { value: u.memMaxGib, label: 'max' } : { value: u.memP95Gib, label: 'p95', note: `${s} memory not collected; p95 used` };
  }
  return { value: u.memP95Gib, label: 'p95', ...(s !== 'p95' ? { note: `${s} memory not collected; p95 used` } : {}) };
}

/** A workload's demand under the policy. Pure. */
export function serverDemand(w: Workload, policy: SizingPolicyExt, o: DemandOptions = {}): ServerDemand {
  const reasons: SizingReason[] = [];
  const findings: Finding[] = [];
  const u = o.observed ? w.facts?.observedOnTarget : w.facts?.utilisation;
  const cores = w.facts?.nameplate?.cores ?? w.vcpu;
  const allocatedRam = w.facts?.nameplate?.ramGib ?? w.ramGib;
  const asIs = policy.mode === 'as-is' || policy.basis === 'allocated';
  const usable = !!u && u.days >= MIN_DAYS && u.coverage >= MIN_COVERAGE;
  const path = `workloads.${w.name}.facts.utilisation`;

  if (u) {
    const pct = Math.round(u.coverage * 100);
    const stars = confidenceStars(u.coverage);
    if (u.days === 0) {
      findings.push(info('size.point-in-time', `${w.name}: only a point-in-time sample (RVTools); it is not used for sizing.`, { path }));
    } else if (u.coverage < CONFIDENCE_WARN && !asIs) {
      findings.push(warning('size.low-confidence', `${w.name}: performance data covers ${pct}% of the ${u.days}-day period (${stars} of 5 stars); below 80% the recommendation is less reliable.`, {
        path, source: SOURCES.azureConfidence,
        remediation: usable ? 'Collect a longer or more complete history and recalculate, or size as-is.' : 'The row is sized from its allocation until the coverage reaches 60% over 3 days.',
      }));
    }
    if (!usable && u.days > 0 && !asIs) {
      findings.push(warning('size.low-coverage', `${w.name}: ${pct}% coverage over ${u.days} day(s) is under ${Math.round(MIN_COVERAGE * 100)}% or ${MIN_DAYS} days, so it is sized from its allocation.`, { path, source: SOURCES.azureConfidence }));
    }
  }

  // ---- allocated (as-is) ----
  if (asIs || !usable) {
    if (!asIs && policy.basis === 'utilisation-only') {
      findings.push(warning('size.no-perf-data', `${w.name}: the policy sizes from utilisation only, and there is no usable performance data; the allocation is shown.`, { path }));
    }
    let vcpu = Math.max(1, Math.ceil(w.basis === 'utilisation' ? w.vcpu : cores));
    let ram = w.basis === 'utilisation' ? w.ramGib : allocatedRam;
    const active = w.facts?.activeMemoryGib ?? 0;
    if (o.activeMemory && active > 0 && w.basis !== 'utilisation') {
      ram = Math.max(2, active * 1.2);
      reasons.push(reason(`Active memory ${gib(active)} GiB × 1.2 → ${gib(Math.ceil(ram))} GiB (requirements: size by active memory).`));
    }
    ram = Math.max(1, Math.ceil(ram));
    if (o.floorRamGib && ram < o.floorRamGib) ram = Math.ceil(o.floorRamGib);
    if (w.basis === 'load') reasons.push(reason(`${vcpu} vCPU / ${ram} GiB from the load profile.`, { assumption: true }));
    else if (w.basis === 'utilisation') reasons.push(reason(`${vcpu} vCPU / ${ram} GiB: the demand intake recorded (utilisation × comfort factor).`));
    else reasons.push(reason(`As-is: ${vcpu} vCPU / ${ram} GiB as allocated.`, { source: SOURCES.azureCalc }));
    vcpu = Math.max(1, vcpu);
    return {
      vcpu, ramGib: ram, basis: w.basis === 'load' ? 'load' : 'allocated', mode: 'as-is', percentile: '',
      ...(u ? { coverage: u.coverage, days: u.days, stars: confidenceStars(u.coverage) } : {}),
      chip: u && u.days === 0 ? 'point-in-time' : 'allocated', reasons, findings,
    };
  }

  // ---- performance-based ----
  const util = u!;
  let cpuS: ResourceStrategy = policy.cpuStrategy ?? policy.percentile;
  let memS: ResourceStrategy = policy.memoryStrategy ?? policy.percentile;
  if (o.peak) {
    const peakOf = (s: ResourceStrategy): ResourceStrategy => (s === 'max' || s === 'as-is' ? s : 'p99');
    if (cpuS !== peakOf(cpuS) || memS !== peakOf(memS)) {
      findings.push(info('size.peak-basis', `${w.name}: a latency-sensitive or batch server (SAP, database or large-memory) is sized at its peak (p99 / max), not ${policy.percentile}.`, { path }));
    }
    cpuS = peakOf(cpuS);
    memS = peakOf(memS);
  }
  const style = policy.headroomStyle ?? 'comfort-factor';
  const factor = 1 + policy.headroomPct / 100;
  const cpuTarget = (policy.cpuTargetPct ?? 70) / 100;
  const memTarget = (policy.memoryTargetPct ?? 85) / 100;
  const bench = policy.benchmarkMultiplier ?? 1;

  const c = cpuPct(util, cpuS);
  const m = memGib(util, memS);
  let vcpu: number;
  let cpuText: string;
  if (c.value === undefined) {
    vcpu = Math.max(1, Math.ceil(cores));
    cpuText = cpuS === 'as-is' ? `CPU as-is: ${vcpu} vCPU` : `no CPU ${cpuS} in the data: ${vcpu} vCPU as allocated`;
  } else {
    const used = cores * c.value / 100;
    const sized = style === 'target-utilisation' ? used / cpuTarget : used * factor;
    vcpu = Math.max(2, Math.ceil(sized * bench - 1e-9));
    cpuText = `${c.label} CPU ${gib(c.value)}% of ${cores} cores`
      + (style === 'target-utilisation' ? ` ÷ ${Math.round(cpuTarget * 100)}% target` : ` × ${factor.toFixed(2).replace(/0$/, '')}`)
      + (bench !== 1 ? ` × benchmark ${bench}` : '') + ` → ${vcpu} vCPU`;
  }
  let ram: number;
  let memText: string;
  if (m.value === undefined) {
    ram = Math.max(1, Math.ceil(allocatedRam));
    memText = memS === 'as-is' ? `memory as-is: ${ram} GiB` : `no memory figure in the data: ${ram} GiB as allocated`;
  } else {
    const sized = style === 'target-utilisation' ? m.value / memTarget : m.value * factor;
    ram = Math.max(2, Math.ceil(sized - 1e-9));
    memText = `${m.label} memory ${gib(m.value)} GiB`
      + (style === 'target-utilisation' ? ` ÷ ${Math.round(memTarget * 100)}% target` : ` × ${factor.toFixed(2).replace(/0$/, '')}`) + ` → ${ram} GiB`;
  }
  const notes = [c.note, m.note].filter(Boolean);
  reasons.push(reason(`${cpuText}; ${memText}${notes.length ? ` (${notes.join('; ')})` : ''}.`, {
    source: style === 'target-utilisation' ? SOURCES.googlePrefs : SOURCES.azureCalc,
  }));
  if (bench !== 1) reasons.push(reason(`CPU benchmark multiplier ${bench} (source score ÷ target score).`, { source: SOURCES.ociStrategies, assumption: true }));
  if (o.floorRamGib && ram < o.floorRamGib) {
    ram = Math.ceil(o.floorRamGib);
    reasons.push(reason(`Memory kept at its nameplate ${ram} GiB: HANA and database memory is a licence and certification quantity, not a utilisation one.`));
  }
  const days = util.days;
  const pct = Math.round(util.coverage * 100);
  const label = c.label === m.label ? String(c.label) : `${c.label}/${m.label}`;
  return {
    vcpu, ramGib: ram, basis: o.observed ? 'observed' : 'utilisation', mode: 'performance', percentile: label,
    coverage: util.coverage, days, stars: confidenceStars(util.coverage),
    chip: `${o.observed ? 'observed' : 'utilisation'} ${label} (${days} d, ${pct}%)`, reasons, findings,
  };
}

// ---------------------------------------------------------------------------
// Choosing a type
// ---------------------------------------------------------------------------

export interface InstanceFit {
  readonly type: string;
  readonly vcpu: number;
  readonly ramGib: number;
  readonly ocpus?: number;
  readonly coreCount?: number;
  /** Azure constrained size: its parent. */
  readonly constrained?: string;
  readonly spec?: InstanceSpec;
}

export interface ChooseOptions {
  readonly families: readonly InstanceFamily[];
  readonly allowArm: boolean;
  readonly latest: boolean;
  /** Burstable types allowed (nonprod, or burstableInProd). */
  readonly burstable: boolean;
  readonly licenceOptimised?: boolean;
  /** Extra filter, e.g. the SAP list or RDS classes. */
  readonly filter?: (s: InstanceSpec) => boolean;
}

export interface Choice {
  readonly fit: InstanceFit | null;
  readonly alternatives: readonly string[];
  /** "r7i.large (2 / 16) fails CPU": the nearest cheaper candidate and why it fails. */
  readonly rejected?: string;
  readonly reasons: readonly SizingReason[];
}

/** Rough price proxy: one vCPU costs about 8.5 GiB of memory (AWS m7i vs r7i on-demand). Used only to rank. */
export const costOf = (vcpu: number, ramGib: number): number => vcpu + ramGib / 8.5;
const VENDOR_RANK = { intel: 0, amd: 1, arm: 2 } as const;
const CLASS_RANK: Readonly<Record<InstanceClass, number>> = { general: 0, compute: 1, memory: 2, storage: 3, burstable: 4, gpu: 5, hpc: 6 };
/**
 * The ranking cost: the price proxy, with Google's compute-optimised series
 * (C2/C3/C4…) carrying a premium over N-series at the same shape (an
 * approximation of list prices, used only to rank).
 */
const rankCost = (s: InstanceSpec): number => costOf(s.vcpu, s.ramGib) * (s.platform === 'google' && /^c\d/.test(s.family) ? 1.15 : 1);

function eligible(s: InstanceSpec, o: ChooseOptions): boolean {
  if (s.constrained || s.metal || s.flex) return false;
  const fam = s.class as InstanceClass;
  if (fam === 'hpc') return false;
  if (fam === 'burstable') { if (!o.burstable || !o.families.includes('burstable')) return false; }
  else if (!o.families.includes(fam as InstanceFamily)) return false;
  if (s.arch === 'arm' && !o.allowArm) return false;
  if (o.latest && !s.current) return false;
  return o.filter ? o.filter(s) : true;
}

function rank(a: InstanceSpec, b: InstanceSpec, ratio: number): number {
  const d = rankCost(a) - rankCost(b);
  if (Math.abs(d) > 1e-9) return d;
  const ra = Math.abs(Math.log(a.ramGib / a.vcpu / ratio));
  const rb = Math.abs(Math.log(b.ramGib / b.vcpu / ratio));
  if (Math.abs(ra - rb) > 1e-9) return ra - rb;
  // x86 stays the recommendation; the Arm fit is offered as an alternative (A.2.8.3 step 4).
  if (a.arch !== b.arch) return a.arch === 'x86' ? -1 : 1;
  if (a.generation !== b.generation) return b.generation - a.generation;
  if (a.burstable !== b.burstable) return a.burstable ? 1 : -1;
  if (a.vendor !== b.vendor) return VENDOR_RANK[a.vendor] - VENDOR_RANK[b.vendor];
  if (a.class !== b.class) return CLASS_RANK[a.class] - CLASS_RANK[b.class];
  if (a.variant !== b.variant) return a.variant - b.variant;
  return a.name.localeCompare(b.name);
}

const shape = (s: { name?: string; type?: string; vcpu: number; ramGib: number }): string => `${s.name ?? s.type} (${s.vcpu} / ${gib(s.ramGib)})`;

function flexFit(platform: 'oci', vcpu: number, ram: number, o: ChooseOptions): Choice {
  const shapes = Object.entries(OCI_FLEX_SHAPES)
    .filter(([, f]) => o.families.includes(f.class as InstanceFamily) && (f.vendor !== 'arm' || o.allowArm) && (!o.latest || f.current))
    .sort(([, a], [, b]) => (a.verification === 'V-DOC' ? 0 : 1) - (b.verification === 'V-DOC' ? 0 : 1) || (a.vendor === 'arm' ? 1 : 0) - (b.vendor === 'arm' ? 1 : 0) || b.gen - a.gen);
  const fits: InstanceFit[] = [];
  const rejected: string[] = [];
  for (const [name, f] of shapes) {
    const ocpus = Math.max(1, Math.ceil(vcpu / f.vcpuPerOcpu), Math.ceil(ram / f.maxGbPerOcpu));
    const mem = Math.max(Math.ceil(ram), ocpus * f.minGbPerOcpu);
    if (ocpus > f.maxOcpus || mem > f.maxMemoryGb || mem > ocpus * f.maxGbPerOcpu) {
      rejected.push(`${name} (max ${f.maxOcpus} OCPU / ${f.maxMemoryGb} GB) is too small`);
      continue;
    }
    fits.push({ type: name, vcpu: ocpus * f.vcpuPerOcpu, ramGib: mem, ocpus, spec: instanceSpec(platform, name) });
  }
  const fit = fits[0] ?? null;
  return {
    fit,
    alternatives: fits.slice(1, 4).map((f) => `${f.type}:${f.ocpus}`),
    ...(rejected[0] ? { rejected: rejected[0] } : {}),
    reasons: fit ? [reason(`${fit.type}: ${fit.ocpus} OCPU (${fit.vcpu} vCPU) and ${fit.ramGib} GB, the exact demand (Flex shapes take any OCPU count and memory within the shape's limits).`, { source: 'https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm#flexible' })] : [],
  };
}

/**
 * The type for a demand on a platform: VMware keeps the demand as the VM size,
 * OCI takes a Flex shape at the exact OCPUs and memory, the others the
 * smallest catalogue type (by a price proxy) with the vCPU and memory, ties to
 * the closest vCPU:memory ratio, the latest generation, non-burstable, Intel
 * then AMD, and the base variant. Licence-optimised hosts go through WP-4's
 * `rightsizeFor(..., { licenceOptimised: true })`.
 */
export function chooseInstance(platform: Platform, vcpu: number, ramGib: number, o: ChooseOptions): Choice {
  const needCpu = Math.max(1, Math.ceil(vcpu));
  const needRam = Math.max(1, Math.ceil(ramGib));
  if (platform === 'vmware') {
    return { fit: { type: vsphereSize(needCpu, needRam), vcpu: needCpu, ramGib: needRam }, alternatives: [], reasons: [reason(`VMware keeps the VM size (${needCpu} vCPU / ${needRam} GiB); the cluster fit is the vcf engine's.`)] };
  }
  if (o.licenceOptimised) {
    const f = rightsizeFor(platform as RehostCloud, needCpu, needRam, { licenceOptimised: true });
    if (f) {
      return {
        fit: { type: f.type, vcpu: f.vcpu, ramGib: f.ramGib, ...(f.ocpus ? { ocpus: f.ocpus } : {}), ...(f.coreCount ? { coreCount: f.coreCount } : {}), ...(f.constrained ? { constrained: f.constrained } : {}), ...(instanceSpec(platform as SpecPlatform, f.type) ? { spec: instanceSpec(platform as SpecPlatform, f.type)! } : {}) },
        alternatives: [],
        reasons: [reason(`Licence-optimised (per-core BYOL database host): ${f.type}${f.coreCount ? ` with ${f.coreCount} active cores` : ''}${f.constrained ? `, cut from ${f.constrained} (billed as it)` : ''}.`, { source: 'https://learn.microsoft.com/en-us/azure/virtual-machines/constrained-vcpu' })],
      };
    }
  }
  if (platform === 'oci') return flexFit('oci', needCpu, needRam, o);

  const ratio = needRam / needCpu;
  const pool = allSpecs(platform as SpecPlatform).filter((s) => eligible(s, o));
  const fits = pool.filter((s) => s.vcpu >= needCpu && s.ramGib >= needRam).sort((a, b) => rank(a, b, ratio));
  const best = fits[0];
  if (!best) {
    const largest = [...pool].sort((a, b) => b.ramGib - a.ramGib)[0];
    return { fit: null, alternatives: [], reasons: [reason(`No ${platform} type in the allowed families has ${needCpu} vCPU and ${needRam} GiB${largest ? `; the largest is ${shape(largest)}` : ''}.`)] };
  }
  const bestCost = rankCost(best);
  const cheaper = pool.filter((s) => rankCost(s) < bestCost && !(s.vcpu >= needCpu && s.ramGib >= needRam))
    .sort((a, b) => rankCost(b) - rankCost(a))[0];
  const rejected = cheaper
    ? `${shape(cheaper)} fails ${cheaper.vcpu < needCpu && cheaper.ramGib < needRam ? 'CPU and memory' : cheaper.vcpu < needCpu ? 'CPU' : 'memory'}`
    : undefined;

  const alts: string[] = [];
  const add = (s: InstanceSpec | undefined): void => { if (s && s.name !== best.name && !alts.includes(s.name) && alts.length < 3) alts.push(s.name); };
  add(pool.filter((s) => s.family === best.family && s.vcpu > best.vcpu).sort((a, b) => a.vcpu - b.vcpu)[0]);
  if (best.class !== 'memory') add(fits.find((s) => s.class === 'memory'));
  if (o.allowArm && best.arch !== 'arm') add(fits.find((s) => s.arch === 'arm'));
  for (const s of fits) add(s);

  return {
    fit: { type: best.name, vcpu: best.vcpu, ramGib: best.ramGib, spec: best },
    alternatives: alts,
    ...(rejected ? { rejected } : {}),
    reasons: [reason(`${shape(best)} is the smallest ${best.class} fit${o.latest ? ' of the current generations' : ''}${rejected ? `; ${rejected}` : ''}.`, { source: best.source })],
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** Software that needs x86 (rows with it never go to Arm). Inferred list; A.3.7 detection supplies the software. */
const X86_ONLY = /\b(sap|oracle|sql ?server|mssql|db2|sybase|informix|windows|\.net framework|vmware tools)\b/i;

export function armEligible(w: Workload): boolean {
  return osKind(w.os) === 'linux' && !(w.facts?.software ?? []).some((s) => X86_ONLY.test(s));
}

export interface ServerSizeOptions {
  readonly licenceOptimised?: boolean;
  readonly peak?: boolean;
  readonly floorRamGib?: number;
  readonly activeMemory?: boolean;
  readonly observed?: boolean;
  /** Extra filter on candidates (e.g. SAP-certified only). */
  readonly filter?: (s: InstanceSpec) => boolean;
}

/** One server row: demand, then the type. */
export function sizeServer(w: Workload, platform: Platform, policy: SizingPolicyExt, o: ServerSizeOptions = {}): { row: SizingRow; findings: Finding[]; demand: ServerDemand } {
  const d = serverDemand(w, policy, o);
  const prod = isProd(w.env);
  const c = chooseInstance(platform, d.vcpu, d.ramGib, {
    families: policy.families, allowArm: policy.allowArm && armEligible(w), latest: policy.latestGeneration,
    burstable: !prod || policy.burstableInProd, licenceOptimised: !!o.licenceOptimised && policy.licenceOptimised,
    ...(o.filter ? { filter: o.filter } : {}),
  });
  const findings = [...d.findings];
  if (!c.fit) {
    findings.push(warning('size.no-type', `${w.name}: no ${platform} type fits ${d.vcpu} vCPU / ${d.ramGib} GiB in the allowed families; pick one by hand.`, { path: `sizing.overrides.server:${w.name}` }));
  }
  const f = c.fit;
  const row: SizingRow = {
    key: `server:${w.name}`,
    demand: { vcpu: d.vcpu, ramGib: d.ramGib },
    choice: f?.type ?? '',
    detail: {
      basis: d.chip, mode: d.mode, ...(d.percentile ? { percentile: d.percentile } : {}),
      ...(d.coverage !== undefined ? { coveragePct: Math.round(d.coverage * 100), confidence: d.stars ?? 0 } : {}),
      ...(f ? { vcpu: f.vcpu, ramGib: f.ramGib } : {}),
      ...(f?.spec ? { class: f.spec.class, family: f.spec.family } : {}),
      ...(f?.ocpus !== undefined ? { ocpus: f.ocpus } : {}),
      ...(f?.coreCount !== undefined ? { coreCount: f.coreCount } : {}),
      ...(f?.constrained ? { constrainedFrom: f.constrained } : {}),
    },
    fits: !!f,
    reasons: [...d.reasons, ...c.reasons],
    alternatives: c.alternatives,
  };
  return { row, findings, demand: d };
}

/** The service a database lands on for a platform: the decision's choice there, its best option there, the pin, or the IaaS service. */
export function serviceFor(db: Database, platform: Platform, plan: Plan): DbServiceId {
  const d = plan.decision?.items[db.id];
  if (d?.chosen?.platform === platform && d.chosen.service) return d.chosen.service;
  const opt = d?.options.find((o) => o.platform === platform && !o.eliminated && o.service);
  if (opt?.service) return opt.service;
  return db.pinService && db.pinService.startsWith(platform === 'google' ? 'google' : platform) ? db.pinService : VM_SERVICE[platform];
}

/** Tier patterns whose servers another engine sizes (or that have no servers to size). */
const SERVER_SKIP: ReadonlySet<string> = new Set(['containers', 'managed-db', 'file-service', 'vdi-service', 'saas', 'retire', 'retain', 'serverless',
  'static-site', 'sap-certified', 'paas-web', 'api-gateway', 'object-storage', 'workflow', 'batch', 'managed-messaging', 'managed-kafka', 'managed-cache', 'managed-search']);
const PEAK_TYPES: ReadonlySet<string> = new Set(['sap-hana', 'sap-netweaver', 'sap-java', 'db-host']);

export interface ServerInput {
  readonly plan: Plan;
  readonly workloads: readonly Workload[];
}

export const serverEngine: SizingEngine<ServerInput> = {
  id: 'server',
  applies: (c) => isPattern(c) && c.servers.length > 0 && !SERVER_SKIP.has(c.tierPattern ?? 'vm'),
  inputs: (c, plan) => ({ plan, workloads: serversOf(c, plan) }),
  size(input, platform, policy) {
    const { plan } = input;
    const licenceHosts = new Set<string>();
    const dbHosts = new Map<string, number>();
    for (const db of plan.databases) {
      if (isIaasService(serviceFor(db, platform, plan)) && isPerCoreByol(db)) for (const h of db.hosts) licenceHosts.add(h);
      for (const h of db.hosts) dbHosts.set(h, Math.max(dbHosts.get(h) ?? 0, db.ramGib));
    }
    const rows: SizingRow[] = [];
    const findings: Finding[] = [];
    for (const w of input.workloads) {
      const app = plan.apps.find((a) => a.name === w.app);
      const peak = w.role === 'db' || PEAK_TYPES.has(w.workloadType ?? '') || app?.special === 'large-memory' || dbHosts.has(w.name);
      const floor = peak && (w.workloadType === 'sap-hana' || w.workloadType === 'db-host' || w.role === 'db' || dbHosts.has(w.name))
        ? (w.facts?.nameplate?.ramGib ?? w.ramGib) : undefined;
      const r = sizeServer(w, platform, policy, {
        licenceOptimised: licenceHosts.has(w.name), peak, ...(floor ? { floorRamGib: floor } : {}),
        activeMemory: plan.requirements.sizeBy === 'active-memory',
      });
      rows.push(r.row);
      findings.push(...r.findings);
    }
    return rec('server', platform, rows, findings);
  },
};
