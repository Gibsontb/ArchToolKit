/**
 * The AWS Migration Hub / Application Discovery Service import template
 * (tier 1 of the provider methodology; the service is closed to new
 * customers, AWS Transform replaces it, but the CSV is still the most widely
 * known AWS inventory sheet). Source:
 * https://docs.aws.amazon.com/application-discovery/latest/userguide/discovery-import.html
 *
 * Matching keys (one per row): ExternalId, IPAddress, MACAddress, HostName,
 * or VMware.MoRefId with VMware.VCenterId. Also SMBiosId,
 * CPU.NumberOfProcessors / NumberOfCores / NumberOfLogicalCores, OS.Name,
 * OS.Version, VMware.VMName, RAM.TotalSizeInMB, RAM.UsedSizeInMB.Avg / .Max,
 * CPU.UsagePct.Avg / .Max, Disk*PerSecond*.Avg / .Max, Network*.Avg / .Max,
 * Applications (quoted, comma-separated), ApplicationWave, Tags
 * ("k:v, k:v"), ServerId. Custom columns are ignored.
 *
 * The template has no disk sizes, so rows arrive with no disks (a finding),
 * and its utilisation is average and maximum only: the maximum is kept
 * (`cpuMaxPct`, `memMaxGib`, `iopsMax`); the average is not a percentile and
 * is not stored as one.
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import { classifyOs } from '../../os.ts';
import type { SourcePlatform, Utilisation } from '../../types.ts';
import { concatIntake, emptyIntake, type IntakeAdapter, type IntakeResult } from '../adapter.ts';
import { intakeFromSourceServers, type SourceIntakeOptions, type SourceServer } from './common.ts';
import { cell, list, mapHeader, mbToGib, num, readTable, skipped, type HeaderSpec } from './table.ts';

export const AWS_IMPORT_SOURCE = 'https://docs.aws.amazon.com/application-discovery/latest/userguide/discovery-import.html';

type Field = 'externalId' | 'smbios' | 'ip' | 'mac' | 'hostName' | 'moref' | 'vcenter' | 'vmName' | 'processors' | 'cores' | 'logical'
  | 'osName' | 'osVersion' | 'ramMb' | 'ramUsedAvg' | 'ramUsedMax' | 'cpuAvg' | 'cpuMax'
  | 'readOpsMax' | 'writeOpsMax' | 'readKbMax' | 'writeKbMax' | 'netReadKbMax' | 'netWriteKbMax'
  | 'apps' | 'wave' | 'tags' | 'serverId';

export const AWS_IMPORT_HEADERS: HeaderSpec<Field> = {
  externalId: ['ExternalId'], smbios: ['SMBiosId'], ip: ['IPAddress'], mac: ['MACAddress'], hostName: ['HostName'],
  moref: ['VMware.MoRefId'], vcenter: ['VMware.VCenterId'], vmName: ['VMware.VMName'],
  processors: ['CPU.NumberOfProcessors'], cores: ['CPU.NumberOfCores'], logical: ['CPU.NumberOfLogicalCores'],
  osName: ['OS.Name'], osVersion: ['OS.Version'],
  ramMb: ['RAM.TotalSizeInMB'], ramUsedAvg: ['RAM.UsedSizeInMB.Avg'], ramUsedMax: ['RAM.UsedSizeInMB.Max'],
  cpuAvg: ['CPU.UsagePct.Avg'], cpuMax: ['CPU.UsagePct.Max'],
  readOpsMax: ['DiskReadsOpsPerSecond.Max'], writeOpsMax: ['DiskWritesOpsPerSecond.Max'],
  readKbMax: ['DiskReadsPerSecondInKB.Max'], writeKbMax: ['DiskWritesPerSecondInKB.Max'],
  netReadKbMax: ['NetworkReadsPerSecondInKB.Max'], netWriteKbMax: ['NetworkWritesPerSecondInKB.Max'],
  apps: ['Applications'], wave: ['ApplicationWave'], tags: ['Tags'], serverId: ['ServerId'],
};

export interface AwsImportOptions {
  /** Origin for rows with no VMware keys (default 'other'). */
  readonly origin?: SourcePlatform;
  /** The window the utilisation columns cover, days (default 0: unknown). */
  readonly utilDays?: number;
}

/** "k:v, k:v" to a record. */
export function awsTags(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of list(text, /,\s*/)) {
    const at = pair.indexOf(':');
    if (at > 0) out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

export function parseAwsImportCsv(text: string, opts: AwsImportOptions = {}): { servers: SourceServer[]; waves: Record<string, string>; findings: Finding[] } {
  const t = readTable(text);
  const map = mapHeader(t.header, AWS_IMPORT_HEADERS, [], 'plan.sources.aws-import', 'The Migration Hub import CSV');
  const findings: Finding[] = [...map.findings];
  const keys: Field[] = ['externalId', 'ip', 'mac', 'hostName', 'moref'];
  if (!keys.some((k) => map.index[k] !== undefined)) {
    return { servers: [], waves: {}, findings: [...findings, warning('plan.sources.aws-import.missing-column', 'The Migration Hub import CSV has none of its matching keys (ExternalId, IPAddress, MACAddress, HostName, VMware.MoRefId).', { source: AWS_IMPORT_SOURCE })] };
  }
  const days = Math.max(0, opts.utilDays ?? 0);
  const servers: SourceServer[] = [];
  const waves: Record<string, string> = {};
  const bad: number[] = [];
  let multiApp = 0;
  t.rows.forEach((row, i) => {
    const name = cell(row, map, 'hostName') || cell(row, map, 'vmName') || cell(row, map, 'externalId') || cell(row, map, 'ip');
    if (!name) { bad.push(t.lines[i]!); return; }
    const vcpu = num(cell(row, map, 'logical')) ?? num(cell(row, map, 'cores')) ?? num(cell(row, map, 'processors')) ?? 0;
    const ramMb = num(cell(row, map, 'ramMb')) ?? 0;
    const osText = [cell(row, map, 'osName'), cell(row, map, 'osVersion')].filter((s) => s !== '').join(' ');
    const moref = cell(row, map, 'moref');
    const origin: SourcePlatform = moref ? 'vsphere' : opts.origin ?? 'other';
    const apps = list(cell(row, map, 'apps'), /,\s*/);
    if (apps.length > 1) multiApp += 1;
    const wave = cell(row, map, 'wave');
    if (wave) waves[name] = wave;
    const cpuMax = num(cell(row, map, 'cpuMax'));
    const memMax = num(cell(row, map, 'ramUsedMax'));
    const ops = [num(cell(row, map, 'readOpsMax')), num(cell(row, map, 'writeOpsMax'))].filter((v): v is number => v !== undefined);
    const util: Utilisation | undefined = cpuMax !== undefined || memMax !== undefined ? {
      days, samples: 1, coverage: days > 0 ? 1 : 0,
      ...(cpuMax !== undefined ? { cpuMaxPct: cpuMax } : {}),
      ...(memMax !== undefined ? { memMaxGib: mbToGib(memMax) } : {}),
      ...(ops.length > 0 ? { iopsMax: Math.round(ops.reduce((a, b) => a + b, 0)) } : {}),
    } : undefined;
    // Disk KB/s maxima are not stored: Utilisation has no throughput maximum, and a maximum is not a p95.
    const ips = list(cell(row, map, 'ip'));
    const tags = awsTags(cell(row, map, 'tags'));
    servers.push({
      name,
      ...(apps[0] ? { app: apps[0] } : {}),
      os: classifyOs(osText),
      guestOs: osText,
      vcpu,
      memoryGib: mbToGib(ramMb),
      disksGib: [],
      provisionedGib: 0,
      sourceKey: `aws-import/${cell(row, map, 'externalId') || name}`,
      facts: {
        powerState: 'unknown',
        guestOsRaw: osText,
        ...(ips.length > 0 ? { ipAddresses: ips } : {}),
        ...(util ? { utilisation: util } : {}),
      },
      origin,
      sourceRef: { platform: origin, ...(moref ? { id: moref } : cell(row, map, 'externalId') ? { id: cell(row, map, 'externalId') } : {}), ...(cell(row, map, 'vcenter') ? { manager: cell(row, map, 'vcenter') } : {}) },
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
    });
  });
  findings.push(...skipped('plan.sources.aws-import.row', 'Migration Hub', bad, 'no HostName, VMware.VMName, ExternalId or IPAddress'));
  if (servers.length > 0) {
    findings.push(warning('plan.sources.aws-import.no-disks', `The Migration Hub import template has no disk sizes, so ${servers.length} server${servers.length === 1 ? '' : 's'} arrived with none.`, {
      remediation: 'Add the disks on the Servers grid, or import a guest collector or RVTools file for the same servers and merge.',
      source: AWS_IMPORT_SOURCE,
    }));
  }
  if (multiApp > 0) findings.push(info('plan.sources.aws-import.multi-app', `${multiApp} server${multiApp === 1 ? '' : 's'} list more than one application; each went to the first.`));
  if (Object.keys(waves).length > 0) findings.push(info('plan.sources.aws-import.waves', `${Object.keys(waves).length} server${Object.keys(waves).length === 1 ? '' : 's'} carry an ApplicationWave; it is returned for the wave planner to seed move groups, not applied.`));
  return { servers, waves, findings };
}

export type AwsImportIntakeOptions = AwsImportOptions & SourceIntakeOptions;

export function intakeFromAwsImport(texts: readonly string[], opts: AwsImportIntakeOptions = {}): IntakeResult {
  const parsed = texts.map((t) => parseAwsImportCsv(t, opts));
  return concatIntake([{ ...emptyIntake(), findings: parsed.flatMap((p) => p.findings) }, intakeFromSourceServers(parsed.flatMap((p) => p.servers), opts)]);
}

export const AWS_IMPORT_CSV_ADAPTER: IntakeAdapter<{ readonly files: readonly string[] }, AwsImportIntakeOptions> = {
  id: 'aws-import-csv',
  label: 'AWS Migration Hub import template (CSV)',
  itemSource: 'estate',
  parse: (input, options) => intakeFromAwsImport(input.files, options ?? {}),
};
