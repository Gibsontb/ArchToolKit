/**
 * A performance time series from any monitoring tool, as CSV: one row per
 * server per sample, columns found by header aliases. It adds utilisation to
 * rows already in the plan (matched by name, case-insensitive, or by IP),
 * then re-applies the sizing basis.
 *
 * Recognised columns (any order, any of the names):
 * - server: `server`, `host`, `hostname`, `vm`, `machine`, `name`, `MachineName`, `MachineId`
 * - time: `timestamp`, `time`, `datetime`, `date`, `TimeStamp`
 * - CPU %: `cpu`, `cpu_pct`, `cpu %`, `cpu utilization`, `CpuUtilizationPercentage`, `% processor time`
 * - memory used: `mem_gib`, `memory used (GiB)`, `mem_used_bytes`, `UtilizedMemoryBytes`, or `mem_pct` (× the row's RAM)
 * - disk: `iops`, `disk iops`, `read iops` + `write iops`; `mbps`, `disk mb/s`
 * - network: `net_mbps`, `network mbit/s`
 *
 * Sysstat `sadf -d` output and Windows `Get-Counter | Export-Counter -FileFormat csv`
 * need a pass through the guest collectors instead: they already reduce to
 * percentiles in the guest.
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import type { Utilisation, Workload } from '../../types.ts';
import { parseTimestamp, utilisationFromSeries } from './common.ts';
import { applySizingBasis } from './sizing-basis.ts';
import { bytesToGib, cell, mapHeader, num, readTable, skipped, type HeaderSpec } from './table.ts';

type Field = 'server' | 'ts' | 'cpu' | 'memGib' | 'memBytes' | 'memPct' | 'iops' | 'readIops' | 'writeIops' | 'mbps' | 'netMbps';

export const PERF_HEADERS: HeaderSpec<Field> = {
  server: ['server', 'host', 'hostname', 'vm', 'machine', 'name', 'MachineName', 'MachineId', 'server name', 'computer'],
  ts: ['timestamp', 'time', 'datetime', 'date', 'TimeStamp', 'sample time'],
  cpu: ['cpu_pct', 'cpu', 'cpu %', 'cpu (%)', 'cpu utilization', 'CpuUtilizationPercentage', '% processor time', 'cpu usage'],
  memGib: ['mem_gib', 'memory used (GiB)', 'mem used gib', 'memory gib'],
  memBytes: ['mem_used_bytes', 'UtilizedMemoryBytes', 'memory used bytes'],
  memPct: ['mem_pct', 'memory %', 'mem %', 'memory (%)', 'MemoryUtilizationPercentage', 'memory utilization'],
  iops: ['iops', 'disk iops', 'total iops'],
  readIops: ['read iops', 'DiskReadOperationsPerSec', 'disk reads/sec'],
  writeIops: ['write iops', 'DiskWriteOperationsPerSec', 'disk writes/sec'],
  mbps: ['mbps', 'disk mb/s', 'disk mbps', 'disk throughput (MB/s)'],
  netMbps: ['net_mbps', 'network mbit/s', 'network mbps', 'net mbps'],
};

interface Series { at: number[]; cpu: number[]; memGib: number[]; memPct: number[]; iops: number[]; mbps: number[]; net: number[] }

export interface PerfParse {
  /** Server (as written in the file, lower case) to its reduced series. */
  readonly series: ReadonlyMap<string, Series>;
  readonly findings: Finding[];
}

export function parsePerfCsv(text: string): PerfParse {
  const t = readTable(text);
  const map = mapHeader(t.header, PERF_HEADERS, ['server', 'ts'], 'plan.sources.perf-csv', 'The performance CSV');
  const findings: Finding[] = [...map.findings];
  const series = new Map<string, Series>();
  if (!map.ok) return { series, findings };
  const bad: number[] = [];
  t.rows.forEach((row, i) => {
    const server = cell(row, map, 'server').toLowerCase();
    const at = parseTimestamp(cell(row, map, 'ts'));
    if (!server || at === undefined) { bad.push(t.lines[i]!); return; }
    const s = series.get(server) ?? { at: [], cpu: [], memGib: [], memPct: [], iops: [], mbps: [], net: [] };
    s.at.push(at);
    const cpu = num(cell(row, map, 'cpu')); if (cpu !== undefined) s.cpu.push(cpu);
    const mg = num(cell(row, map, 'memGib')); const mb = num(cell(row, map, 'memBytes'));
    if (mg !== undefined) s.memGib.push(mg); else if (mb !== undefined) s.memGib.push(bytesToGib(mb));
    const mp = num(cell(row, map, 'memPct')); if (mp !== undefined) s.memPct.push(mp);
    const io = num(cell(row, map, 'iops'));
    const r = num(cell(row, map, 'readIops')), w = num(cell(row, map, 'writeIops'));
    if (io !== undefined) s.iops.push(io); else if (r !== undefined || w !== undefined) s.iops.push((r ?? 0) + (w ?? 0));
    const mbps = num(cell(row, map, 'mbps')); if (mbps !== undefined) s.mbps.push(mbps);
    const net = num(cell(row, map, 'netMbps')); if (net !== undefined) s.net.push(net);
    series.set(server, s);
  });
  findings.push(...skipped('plan.sources.perf-csv.row', 'performance', bad, 'no server or unreadable time'));
  return { series, findings };
}

/** One server's reduced utilisation; memory percentages are scaled by `ramGib`. */
export function reduceSeries(s: Series, ramGib: number): Utilisation | undefined {
  return utilisationFromSeries({
    at: s.at, cpuPct: s.cpu,
    memGib: s.memGib.length > 0 ? s.memGib : s.memPct.map((p) => (ramGib * p) / 100),
    iops: s.iops, mbps: s.mbps, netMbps: s.net,
  });
}

/**
 * Adds the parsed utilisation to matching rows (by name, then by IP) and
 * re-applies the sizing basis. Rows with no match are unchanged; series with
 * no row are reported.
 */
export function applyPerf(workloads: readonly Workload[], perf: PerfParse): { workloads: Workload[]; findings: Finding[] } {
  const findings: Finding[] = [...perf.findings];
  const used = new Set<string>();
  const out = workloads.map((w) => {
    const keys = [w.name.toLowerCase(), ...(w.facts?.ipAddresses ?? []).map((ip) => ip.toLowerCase())];
    const key = keys.find((k) => perf.series.has(k));
    if (!key) return w;
    used.add(key);
    const nameplateRam = w.facts?.nameplate?.ramGib ?? w.ramGib;
    const util = reduceSeries(perf.series.get(key)!, nameplateRam);
    if (!util) return w;
    const withUtil: Workload = { ...w, facts: { ...(w.facts ?? {}), utilisation: util } };
    const r = applySizingBasis(withUtil);
    findings.push(...r.findings);
    return r.workload;
  });
  const orphans = [...perf.series.keys()].filter((k) => !used.has(k));
  if (orphans.length > 0) {
    findings.push(warning('plan.sources.perf-csv.unmatched', `${orphans.length} server${orphans.length === 1 ? '' : 's'} in the performance CSV match no row by name or IP: ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ' …' : ''}.`));
  }
  if (used.size > 0) findings.push(info('plan.sources.perf-csv.applied', `Utilisation added to ${used.size} server${used.size === 1 ? '' : 's'}.`));
  return { workloads: out, findings };
}
