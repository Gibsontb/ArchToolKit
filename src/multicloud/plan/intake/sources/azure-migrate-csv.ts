/**
 * Azure Migrate CSV: the discovery import template, and the assessment
 * export read by header (tier 1 of the provider methodology).
 *
 * The import template (https://learn.microsoft.com/en-us/azure/migrate/tutorial-discover-import):
 * mandatory `Server name`, `Cores`, `Memory (In MB)`, `OS name`; optional
 * `IP address`, `OS version`, `OS architecture`, `Server type`, `Hypervisor`,
 * `Number of disks`, `Storage in use (In GB)`, `Disk n size (In GB)` /
 * `read ops` / `write ops` / `read throughput` / `write throughput` for n = 1
 * to 20, `CPU utilization percentage`, `Memory utilization percentage`,
 * `Network In throughput`, `Network Out throughput`, `Boot Type`, `Network
 * adapters`. Up to 20,000 servers per file.
 *
 * The utilisation figures are one value per server with no stated window, so
 * they land with `days` = the `utilDays` option (default 0, which the sizing
 * basis treats as too thin to size from; the figures are still kept and
 * shown). Set `utilDays` to the window the file was exported over.
 *
 * The assessment export's columns are not published (UNVERIFIED): readiness,
 * recommended size, monthly cost and confidence are read when a header that
 * names them is present, and returned beside the rows.
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import { classifyOs } from '../../os.ts';
import { ENV_OPTIONS, optionValue } from '../../options.ts';
import type { Env, SourcePlatform, Utilisation } from '../../types.ts';
import { concatIntake, emptyIntake, type IntakeAdapter, type IntakeResult } from '../adapter.ts';
import { intakeFromSourceServers, type SourceIntakeOptions, type SourceServer } from './common.ts';
import { cell, list, mapHeader, mbToGib, num, numberedColumns, readTable, skipped, type HeaderSpec } from './table.ts';

export const AZURE_MIGRATE_IMPORT_SOURCE = 'https://learn.microsoft.com/en-us/azure/migrate/tutorial-discover-import';

type Field = 'name' | 'ip' | 'cores' | 'memMb' | 'osName' | 'osVersion' | 'osArch' | 'serverType' | 'hypervisor' | 'diskCount'
  | 'storageInUse' | 'cpuUtil' | 'memUtil' | 'netIn' | 'netOut' | 'boot' | 'nics' | 'mac' | 'env' | 'app'
  | 'readiness' | 'recommendedSize' | 'monthlyCompute' | 'monthlyStorage' | 'confidence';

export const AZURE_MIGRATE_HEADERS: HeaderSpec<Field> = {
  name: ['Server name', 'Machine name', 'Machine', 'Server', 'Name', 'Display name'],
  ip: ['IP address', 'IP addresses', 'IPv4 address'],
  cores: ['Cores', 'Number of cores', 'CPU cores', 'Processor cores'],
  memMb: ['Memory (In MB)', 'Memory (MB)', 'Memory in MB', 'Memory MB', 'RAM (MB)'],
  osName: ['OS name', 'Operating system', 'OS'],
  osVersion: ['OS version', 'Operating system version'],
  osArch: ['OS architecture', 'Architecture'],
  serverType: ['Server type (Virtual/Physical)', 'Server type', 'Type'],
  hypervisor: ['Hypervisor (VMware/Hyper-V)', 'Hypervisor'],
  diskCount: ['Number of disks', 'Disks'],
  storageInUse: ['Storage in use (In GB)', 'Storage in use (GB)', 'Storage in use'],
  cpuUtil: ['CPU utilization percentage', 'CPU utilization (%)', 'CPU utilization', 'CPU usage (%)'],
  memUtil: ['Memory utilization percentage', 'Memory utilization (%)', 'Memory utilization', 'Memory usage (%)'],
  netIn: ['Network In throughput', 'Network in throughput (MB per second)', 'Network in (MBps)'],
  netOut: ['Network Out throughput', 'Network out throughput (MB per second)', 'Network out (MBps)'],
  boot: ['Boot Type (BIOS/UEFI)', 'Boot type', 'Firmware'],
  nics: ['Network adapters', 'Number of network adapters'],
  mac: ['MAC address', 'MAC addresses'],
  env: ['Environment', 'Tag: Environment', 'Environment tag'],
  app: ['Application', 'App', 'Application name', 'Workload'],
  readiness: ['Azure readiness', 'Readiness', 'Azure VM readiness'],
  recommendedSize: ['Recommended size', 'Azure VM size', 'Recommended VM size'],
  monthlyCompute: ['Monthly compute cost estimate', 'Compute monthly cost estimate', 'Monthly compute cost'],
  monthlyStorage: ['Monthly storage cost estimate', 'Storage monthly cost estimate', 'Monthly storage cost'],
  confidence: ['Confidence rating', 'Confidence rating (%)', 'Performance coverage'],
};
const REQUIRED: readonly Field[] = ['name', 'cores', 'memMb', 'osName'];

export interface AzureMigrateOptions {
  /** The window (days) the utilisation figures cover; default 0 (unknown). */
  readonly utilDays?: number;
  /** Origin for rows that do not say (default from Server type / Hypervisor, else 'other'). */
  readonly origin?: SourcePlatform;
}

/** The assessment columns, when the file is an assessment export (UNVERIFIED layout). */
export interface AzureAssessmentRow {
  readonly name: string;
  readonly readiness?: string;
  readonly recommendedSize?: string;
  readonly monthlyCompute?: number;
  readonly monthlyStorage?: number;
  readonly confidence?: string;
}

export interface AzureMigrateParse {
  readonly servers: SourceServer[];
  readonly assessment: AzureAssessmentRow[];
  readonly findings: Finding[];
}

function originOf(serverType: string, hypervisor: string, fallback: SourcePlatform | undefined): SourcePlatform {
  if (/physical/i.test(serverType)) return 'physical';
  if (/vmware|vsphere|esx/i.test(hypervisor)) return 'vsphere';
  if (/hyper-?v/i.test(hypervisor)) return 'hyperv';
  if (/kvm/i.test(hypervisor)) return 'kvm';
  if (/xen/i.test(hypervisor)) return 'xen';
  return fallback ?? 'other';
}

export function parseAzureMigrateCsv(text: string, opts: AzureMigrateOptions = {}): AzureMigrateParse {
  const t = readTable(text);
  const map = mapHeader(t.header, AZURE_MIGRATE_HEADERS, REQUIRED, 'plan.sources.azure-migrate', 'The Azure Migrate CSV');
  if (!map.ok) return { servers: [], assessment: [], findings: [...map.findings] };
  const findings: Finding[] = [...map.findings];
  const size = numberedColumns(t.header, /^disk(\d+)sizeingb$/);
  const rOps = numberedColumns(t.header, /^disk(\d+)readops/);
  const wOps = numberedColumns(t.header, /^disk(\d+)writeops/);
  const rMb = numberedColumns(t.header, /^disk(\d+)readthroughput/);
  const wMb = numberedColumns(t.header, /^disk(\d+)writethroughput/);
  const sumOf = (row: readonly string[], cols: { index: number }[]): number | undefined => {
    const vals = cols.map((c) => num(row[c.index])).filter((v): v is number => v !== undefined);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : undefined;
  };
  const days = Math.max(0, opts.utilDays ?? 0);
  const servers: SourceServer[] = [];
  const assessment: AzureAssessmentRow[] = [];
  const bad: number[] = [];

  t.rows.forEach((row, i) => {
    const name = cell(row, map, 'name');
    const cores = num(cell(row, map, 'cores'));
    const memMb = num(cell(row, map, 'memMb'));
    if (!name || cores === undefined || memMb === undefined) { bad.push(t.lines[i]!); return; }
    const memGib = mbToGib(memMb);
    let disks = size.map((c) => num(row[c.index])).filter((v): v is number => v !== undefined && v > 0).map((v) => Math.ceil(v));
    const inUse = num(cell(row, map, 'storageInUse'));
    if (disks.length === 0 && inUse !== undefined && inUse > 0) disks = [Math.ceil(inUse)];
    const cpu = num(cell(row, map, 'cpuUtil'));
    const memPct = num(cell(row, map, 'memUtil'));
    const iops = [sumOf(row, rOps), sumOf(row, wOps)].filter((v): v is number => v !== undefined);
    const mbps = [sumOf(row, rMb), sumOf(row, wMb)].filter((v): v is number => v !== undefined);
    const net = [num(cell(row, map, 'netIn')), num(cell(row, map, 'netOut'))].filter((v): v is number => v !== undefined);
    let utilisation: Utilisation | undefined;
    if (cpu !== undefined || memPct !== undefined) {
      utilisation = {
        days, samples: 1, coverage: days > 0 ? 1 : 0,
        ...(cpu !== undefined ? { cpuP95Pct: cpu } : {}),
        ...(memPct !== undefined ? { memP95Gib: Math.round(memGib * (memPct / 100) * 10) / 10 } : {}),
        ...(iops.length > 0 ? { iopsP95: Math.round(iops.reduce((a, b) => a + b, 0)) } : {}),
        ...(mbps.length > 0 ? { mbpsP95: Math.round(mbps.reduce((a, b) => a + b, 0) * 10) / 10 } : {}),
        ...(net.length > 0 ? { netMbpsP95: Math.round(net.reduce((a, b) => a + b, 0) * 8 * 10) / 10 } : {}),
      };
    }
    const osText = [cell(row, map, 'osName'), cell(row, map, 'osVersion')].filter((s) => s !== '').join(' ');
    const boot = cell(row, map, 'boot');
    const ips = list(cell(row, map, 'ip'));
    const envCell = cell(row, map, 'env');
    const env = envCell ? optionValue(ENV_OPTIONS, envCell) : undefined;
    const origin = originOf(cell(row, map, 'serverType'), cell(row, map, 'hypervisor'), opts.origin);
    servers.push({
      name,
      ...(env ? { env: env as Env } : {}),
      os: classifyOs(osText),
      guestOs: osText,
      vcpu: cores,
      memoryGib: memGib,
      disksGib: disks,
      provisionedGib: disks.reduce((a, b) => a + b, 0),
      sourceKey: `azure-migrate/${name}`,
      facts: {
        powerState: 'unknown',
        guestOsRaw: osText,
        ...(/uefi|efi/i.test(boot) ? { firmware: 'efi' as const } : /bios/i.test(boot) ? { firmware: 'bios' as const } : {}),
        ...(ips.length > 0 ? { ipAddresses: ips } : {}),
        ...(utilisation ? { utilisation } : {}),
      },
      origin,
      sourceRef: { platform: origin },
      ...(cell(row, map, 'app') ? { csvApp: cell(row, map, 'app') } : {}),
    });
    const readiness = cell(row, map, 'readiness');
    const recommendedSize = cell(row, map, 'recommendedSize');
    if (readiness || recommendedSize) {
      const mc = num(cell(row, map, 'monthlyCompute'));
      const ms = num(cell(row, map, 'monthlyStorage'));
      const conf = cell(row, map, 'confidence');
      assessment.push({ name, ...(readiness ? { readiness } : {}), ...(recommendedSize ? { recommendedSize } : {}), ...(mc !== undefined ? { monthlyCompute: mc } : {}), ...(ms !== undefined ? { monthlyStorage: ms } : {}), ...(conf ? { confidence: conf } : {}) });
    }
  });
  findings.push(...skipped('plan.sources.azure-migrate.row', 'Azure Migrate', bad, 'no server name, cores or memory'));
  if (servers.length > 20000) findings.push(warning('plan.sources.azure-migrate.limit', `${servers.length} servers: Azure Migrate takes up to 20,000 per import file.`, { source: AZURE_MIGRATE_IMPORT_SOURCE }));
  if (assessment.length > 0) {
    findings.push(info('plan.sources.azure-migrate.assessment', `${assessment.length} assessment rows (readiness, recommended size, cost) were read by header; Microsoft does not publish this export's columns, so check them against the portal.`));
  }
  if (servers.some((s) => s.facts?.utilisation) && days === 0) {
    findings.push(info('plan.sources.azure-migrate.window', 'The utilisation figures have no stated window, so they are kept but not used to size (the basis stays at nameplate).', {
      remediation: 'Set the window the export covers (days) on the Sources screen to size from utilisation.',
    }));
  }
  return { servers, assessment, findings };
}

export interface AzureMigrateInput { readonly files: readonly string[] }
export type AzureMigrateIntakeOptions = AzureMigrateOptions & SourceIntakeOptions;

export function intakeFromAzureMigrate(texts: readonly string[], opts: AzureMigrateIntakeOptions = {}): IntakeResult {
  const parsed = texts.map((t) => parseAzureMigrateCsv(t, opts));
  const rows = intakeFromSourceServers(parsed.flatMap((p) => p.servers), opts);
  return concatIntake([{ ...emptyIntake(), findings: parsed.flatMap((p) => p.findings) }, rows]);
}

export const AZURE_MIGRATE_CSV_ADAPTER: IntakeAdapter<AzureMigrateInput, AzureMigrateIntakeOptions> = {
  id: 'azure-migrate-csv',
  label: 'Azure Migrate CSV (import template or assessment export)',
  itemSource: 'estate',
  parse: (input, options) => intakeFromAzureMigrate(input.files, options ?? {}),
};
