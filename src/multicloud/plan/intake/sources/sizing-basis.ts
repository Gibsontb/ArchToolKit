/**
 * Sizing from utilisation, not nameplate (addendum A.3.6).
 *
 * `Workload.vcpu` / `ramGib` hold the demand the sizing uses; the machine as
 * configured moves to `WorkloadFacts.nameplate`, and `Workload.basis` says
 * which figures the row holds:
 *
 * - `allocated`: the configured size. The default for VMs.
 * - `utilisation`: percentile × comfort factor. The default for physical
 *   servers, and for cloud sources that have metrics.
 *
 *   vCPU = max(2, ceil(nameplateCores × cpuP95Pct / 100 × 1.3))
 *   RAM  = max(2, ceil(memP95Gib × 1.3))
 *
 * Under 60% coverage or under 3 days of data the row falls back to its
 * nameplate, with `size.low-coverage` naming the coverage and its band.
 * Latency-sensitive and batch servers (SAP, database hosts, apps marked
 * large-memory) use p99 or the maximum instead of p95 (`size.peak-basis`),
 * and SAP HANA and database hosts are never shrunk below their memory
 * nameplate: HANA memory is a licence and certification quantity.
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import type { SizingBasis, SourcePlatform, Utilisation, Workload, WorkloadType } from '../../types.ts';

/** Azure Migrate's performance-based sizing: percentile × comfort factor (95th recommended). */
export const COMFORT_FACTOR = 1.3;
export const COMFORT_SOURCE = 'https://learn.microsoft.com/en-us/azure/migrate/concepts-assessment-calculation';
/** Below either, the utilisation basis falls back to nameplate. */
export const MIN_COVERAGE = 0.6;
export const MIN_DAYS = 3;
/** The floor for both vCPU and RAM (GiB). */
export const MIN_SIZE = 2;

/** Azure Migrate's confidence bands for performance coverage: 0–20% is 1 star … 81–100% is 5. */
export function confidenceBand(coverage: number): 1 | 2 | 3 | 4 | 5 {
  const pct = Math.round(Math.max(0, Math.min(1, coverage)) * 100);
  if (pct <= 20) return 1;
  if (pct <= 40) return 2;
  if (pct <= 60) return 3;
  if (pct <= 80) return 4;
  return 5;
}

const CLOUDS: readonly SourcePlatform[] = ['aws', 'azure', 'google', 'oci'];

/** The default basis of a row: utilisation for physical servers and cloud sources with metrics; else allocated. */
export function defaultBasis(origin: SourcePlatform | undefined, util: Utilisation | undefined): SizingBasis {
  const hasMetrics = !!util && (util.cpuP95Pct !== undefined || util.cpuMaxPct !== undefined);
  if (origin === 'physical' && hasMetrics) return 'utilisation';
  if (origin && CLOUDS.includes(origin) && hasMetrics) return 'utilisation';
  return 'allocated';
}

/** SAP and database types size from the peak and keep their memory nameplate. */
export function isPeakType(type: WorkloadType | undefined): boolean {
  return !!type && (type.startsWith('sap-') || type === 'db-host');
}
/** Never shrunk below the memory nameplate. */
export function holdsMemory(type: WorkloadType | undefined, role?: string): boolean {
  return type === 'sap-hana' || type === 'db-host' || role === 'db';
}

export interface BasisOptions {
  /** Override the default basis for the row. */
  readonly basis?: SizingBasis;
  /** Size from p99 / max (latency-sensitive or batch: SAP, DB, large-memory apps). Default from the type and role. */
  readonly peak?: boolean;
  /** Keep the memory nameplate as a floor. Default from the type and role. */
  readonly holdMemory?: boolean;
}

export interface BasisResult {
  readonly workload: Workload;
  readonly findings: Finding[];
}

/**
 * The row with `basis`, `facts.nameplate` and the demand in `vcpu` / `ramGib`.
 * `allocated` restores the nameplate; `utilisation` applies the formula, or
 * falls back to nameplate when the data are too thin. Rows whose `vcpu`,
 * `ramGib` or `basis` were edited are returned unchanged.
 */
export function applySizingBasis(w: Workload, opts: BasisOptions = {}): BasisResult {
  const edited = new Set<string>(w.edited ?? []);
  if (edited.has('vcpu') || edited.has('ramGib')) return { workload: w, findings: [] };
  const facts = w.facts ?? {};
  const nameplate = facts.nameplate ?? { cores: w.vcpu, ramGib: w.ramGib, disksGib: [...w.disksGib] };
  const u = facts.utilisation;
  const wanted: SizingBasis = edited.has('basis') && w.basis ? w.basis : opts.basis ?? w.basis ?? defaultBasis(w.origin, u);
  const path = `workloads[${w.id}]`;
  const findings: Finding[] = [];
  const allocated = (basis: SizingBasis): BasisResult => ({
    workload: { ...w, vcpu: nameplate.cores, ramGib: Math.ceil(nameplate.ramGib), basis, facts: { ...facts, nameplate } },
    findings,
  });
  if (wanted !== 'utilisation') return allocated(wanted);

  if (!u || u.days < MIN_DAYS || u.coverage < MIN_COVERAGE) {
    const pct = Math.round((u?.coverage ?? 0) * 100);
    findings.push(warning('size.low-coverage', u
      ? `${w.name}: ${pct}% coverage over ${u.days} day(s) (confidence ${confidenceBand(u.coverage)} of 5) is under ${Math.round(MIN_COVERAGE * 100)}% or ${MIN_DAYS} days, so it is sized from its nameplate.`
      : `${w.name}: no utilisation data, so it is sized from its nameplate.`, {
      path,
      remediation: 'Run the guest collector for longer (14 days is the default) and import again.',
      source: COMFORT_SOURCE,
    }));
    return allocated('allocated');
  }

  const peak = opts.peak ?? (isPeakType(w.workloadType) || w.role === 'db');
  const hold = opts.holdMemory ?? holdsMemory(w.workloadType, w.role);
  let cpuPct = peak ? (u.cpuP99Pct ?? u.cpuMaxPct) : u.cpuP95Pct;
  let cpuWhich = peak ? (u.cpuP99Pct !== undefined ? 'p99' : 'max') : 'p95';
  if (cpuPct === undefined && u.cpuMaxPct !== undefined) { cpuPct = u.cpuMaxPct; cpuWhich = 'max'; }
  let memGib = peak ? (u.memMaxGib ?? u.memP95Gib) : u.memP95Gib;
  if (memGib === undefined && u.memMaxGib !== undefined) memGib = u.memMaxGib;
  if (peak) {
    findings.push(info('size.peak-basis', `${w.name} is latency-sensitive or batch, so it is sized from ${cpuWhich} CPU and peak memory rather than p95.`, { path, source: COMFORT_SOURCE }));
  }

  const vcpu = cpuPct === undefined ? nameplate.cores : Math.max(MIN_SIZE, Math.ceil(nameplate.cores * (cpuPct / 100) * COMFORT_FACTOR));
  let ramGib = memGib === undefined ? Math.ceil(nameplate.ramGib) : Math.max(MIN_SIZE, Math.ceil(memGib * COMFORT_FACTOR));
  if (hold && ramGib < nameplate.ramGib) ramGib = Math.ceil(nameplate.ramGib);
  if (cpuPct === undefined || memGib === undefined) {
    findings.push(info('size.partial-utilisation', `${w.name}: no ${cpuPct === undefined ? 'CPU' : 'memory'} figure in the utilisation data, so that dimension keeps its nameplate.`, { path }));
  }
  if (u.coverage < 0.8) {
    findings.push(info('size.low-confidence', `${w.name}: ${Math.round(u.coverage * 100)}% performance coverage (confidence ${confidenceBand(u.coverage)} of 5).`, { path, source: COMFORT_SOURCE }));
  }
  return {
    workload: { ...w, vcpu, ramGib, basis: 'utilisation', facts: { ...facts, nameplate } },
    findings,
  };
}
