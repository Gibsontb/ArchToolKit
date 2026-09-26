/**
 * Nutanix Prism Central VM list "Export CSV" (addendum A.3.2), read by
 * header aliases. The export's columns follow the list view the user had
 * open and are not published as a schema (UNVERIFIED), so every field is
 * looked for under the names Prism has used, and anything missing is simply
 * blank. The collector (`collect-ahv.sh`, Prism Central v4 VMM API) is the
 * complete route; this is for users who only have the export.
 *
 * Sizes come as text with units ("16 GiB", "61.2 GiB / 127 GiB"); CPU and
 * memory usage are point-in-time percentages, kept as a one-sample
 * utilisation.
 */

import { warning, type Finding } from '../../../../core/findings.ts';
import { classifyOs } from '../../os.ts';
import type { Utilisation } from '../../types.ts';
import { concatIntake, emptyIntake, type IntakeAdapter, type IntakeResult } from '../adapter.ts';
import { powerStateOf } from './discovery.ts';
import { intakeFromSourceServers, type SourceIntakeOptions, type SourceServer } from './common.ts';
import { cell, list, mapHeader, num, readTable, sizeGib, skipped, type HeaderSpec } from './table.ts';

type Field = 'name' | 'host' | 'cluster' | 'ips' | 'vcpu' | 'sockets' | 'coresPer' | 'memory' | 'storage' | 'storageUsed' | 'storageCap'
  | 'cpuUsage' | 'memUsage' | 'readIops' | 'writeIops' | 'iops' | 'bandwidth' | 'power' | 'os' | 'categories' | 'uuid' | 'description' | 'project';

export const AHV_HEADERS: HeaderSpec<Field> = {
  name: ['VM Name', 'Name', 'VM'],
  host: ['Host', 'Host Name', 'Hypervisor Host'],
  cluster: ['Cluster', 'Cluster Name'],
  ips: ['IP Addresses', 'IP Address', 'IPs'],
  vcpu: ['vCPUs', 'Number of vCPUs', 'Cores', 'Total vCPUs', 'CPU'],
  sockets: ['Sockets', 'Number of Sockets', 'vCPU Sockets'],
  coresPer: ['Cores per vCPU', 'Cores Per Socket', 'Number of Cores per Socket'],
  memory: ['Memory Capacity', 'Memory', 'Memory Size'],
  storage: ['Storage', 'Storage Usage'],
  storageUsed: ['Used Storage', 'Storage Used', 'Logical Usage'],
  storageCap: ['Storage Capacity', 'Disk Capacity', 'Provisioned Storage'],
  cpuUsage: ['CPU Usage', 'CPU Usage (%)', 'Hypervisor CPU Usage (%)'],
  memUsage: ['Memory Usage', 'Memory Usage (%)'],
  readIops: ['Controller Read IOPS', 'Read IOPS'],
  writeIops: ['Controller Write IOPS', 'Write IOPS'],
  iops: ['Controller IOPS', 'IOPS', 'Total IOPS'],
  bandwidth: ['Controller IO Bandwidth', 'IO Bandwidth'],
  power: ['Power State', 'Power', 'State'],
  os: ['Guest OS', 'Operating System', 'OS'],
  categories: ['Categories', 'Category'],
  uuid: ['UUID', 'VM UUID', 'ExtId'],
  description: ['Description'],
  project: ['Project'],
};

/** "a / b" storage cells: used and capacity. */
function usedAndCap(text: string): { used?: number; cap?: number } {
  const parts = text.split('/').map((p) => sizeGib(p.trim()));
  if (parts.length === 2) return { ...(parts[0] !== undefined ? { used: parts[0] } : {}), ...(parts[1] !== undefined ? { cap: parts[1] } : {}) };
  const one = sizeGib(text);
  return one !== undefined ? { cap: one } : {};
}

/** "Env: Prod, App: CRM" or "Env:Prod; App:CRM" to a record. */
export function nutanixCategories(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of list(text, /[;,]\s*/)) {
    const at = pair.indexOf(':');
    if (at > 0) out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

/** KB/s, MB/s or a bare number (MB/s) to MB/s. */
function mbpsOf(text: string): number | undefined {
  const m = /^\s*([0-9.,]+)\s*([kmg]?)b?ps\s*$/i.exec(text) ?? /^\s*([0-9.,]+)\s*([kmg]?)b\/s\s*$/i.exec(text);
  if (m) { const n = num(m[1]); if (n === undefined) return undefined; const u = (m[2] ?? '').toLowerCase(); return u === 'k' ? n / 1024 : u === 'g' ? n * 1024 : n; }
  return num(text);
}

export function parseAhvCsv(text: string): { servers: SourceServer[]; findings: Finding[] } {
  const t = readTable(text);
  const map = mapHeader(t.header, AHV_HEADERS, ['name'], 'plan.sources.ahv-csv', 'The Prism Central export');
  const findings: Finding[] = [...map.findings];
  if (!map.ok) return { servers: [], findings };
  if (map.index.vcpu === undefined && map.index.sockets === undefined) findings.push(warning('plan.sources.ahv-csv.no-cpu', 'The Prism Central export has no vCPU or sockets column, so vCPU is 0 on every row.', { remediation: 'Add the vCPUs column to the list view before exporting, or use collect-ahv.sh.' }));
  const servers: SourceServer[] = [];
  const bad: number[] = [];
  t.rows.forEach((row, i) => {
    const name = cell(row, map, 'name');
    if (!name) { bad.push(t.lines[i]!); return; }
    const sockets = num(cell(row, map, 'sockets'));
    const coresPer = num(cell(row, map, 'coresPer'));
    const vcpu = num(cell(row, map, 'vcpu')) ?? (sockets !== undefined ? sockets * (coresPer ?? 1) : 0);
    const memGib = sizeGib(cell(row, map, 'memory')) ?? 0;
    const st = usedAndCap(cell(row, map, 'storage'));
    const cap = sizeGib(cell(row, map, 'storageCap')) ?? st.cap;
    const used = sizeGib(cell(row, map, 'storageUsed')) ?? st.used;
    const disks = cap !== undefined && cap > 0 ? [Math.ceil(cap)] : [];
    const cpu = num(cell(row, map, 'cpuUsage'));
    const memPct = num(cell(row, map, 'memUsage'));
    const iops = num(cell(row, map, 'iops')) ?? ((num(cell(row, map, 'readIops')) ?? 0) + (num(cell(row, map, 'writeIops')) ?? 0) || undefined);
    const mbps = mbpsOf(cell(row, map, 'bandwidth'));
    const util: Utilisation | undefined = cpu !== undefined || memPct !== undefined ? {
      days: 0, samples: 1, coverage: 0,
      ...(cpu !== undefined ? { cpuP95Pct: cpu } : {}),
      ...(memPct !== undefined ? { memP95Gib: Math.round(memGib * (memPct / 100) * 10) / 10 } : {}),
      ...(iops !== undefined ? { iopsP95: Math.round(iops) } : {}),
      ...(mbps !== undefined ? { mbpsP95: Math.round(mbps * 10) / 10 } : {}),
    } : undefined;
    const osText = cell(row, map, 'os');
    const ips = list(cell(row, map, 'ips'));
    const tags = nutanixCategories(cell(row, map, 'categories'));
    const project = cell(row, map, 'project');
    if (project && !tags.Project) tags.Project = project;
    const cluster = cell(row, map, 'cluster');
    const uuid = cell(row, map, 'uuid');
    servers.push({
      name,
      os: classifyOs(osText),
      ...(osText ? { guestOs: osText } : {}),
      vcpu,
      memoryGib: memGib,
      disksGib: disks,
      provisionedGib: disks.reduce((a, b) => a + b, 0),
      ...(cell(row, map, 'description') ? { annotation: cell(row, map, 'description') } : {}),
      sourceKey: `ahv/${cluster || 'prism'}/${uuid || name}`,
      facts: {
        powerState: powerStateOf(cell(row, map, 'power')),
        ...(osText ? { guestOsRaw: osText } : {}),
        ...(ips.length > 0 ? { ipAddresses: ips } : {}),
        ...(used !== undefined && disks.length === 1 ? { disksUsedGib: [used] } : {}),
        ...(util ? { utilisation: util } : {}),
      },
      origin: 'ahv',
      sourceRef: { platform: 'ahv', ...(uuid ? { id: uuid } : {}), ...(cell(row, map, 'host') ? { host: cell(row, map, 'host') } : {}), ...(cluster ? { cluster } : {}) },
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
    });
  });
  findings.push(...skipped('plan.sources.ahv-csv.row', 'Prism Central', bad, 'no VM name'));
  return { servers, findings };
}

export function intakeFromAhvCsv(texts: readonly string[], opts: SourceIntakeOptions = {}): IntakeResult {
  const parsed = texts.map(parseAhvCsv);
  return concatIntake([{ ...emptyIntake(), findings: parsed.flatMap((p) => p.findings) }, intakeFromSourceServers(parsed.flatMap((p) => p.servers), { noun: 'VM', ...opts })]);
}

export const AHV_CSV_ADAPTER: IntakeAdapter<{ readonly files: readonly string[] }, SourceIntakeOptions> = {
  id: 'ahv-csv',
  label: 'Nutanix Prism Central VM export (CSV)',
  itemSource: 'estate',
  parse: (input, options) => intakeFromAhvCsv(input.files, options ?? {}),
};
