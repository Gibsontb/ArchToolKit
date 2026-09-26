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

import { info, warning,              } from '../../../../core/findings.js';
import { classifyOs } from '../../os.js';
import { ENV_OPTIONS, optionValue } from '../../options.js';
                                                                       
import { concatIntake, emptyIntake,                                       } from '../adapter.js';
import { intakeFromSourceServers,                                             } from './common.js';
import { cell, list, mapHeader, mbToGib, num, numberedColumns, readTable, skipped,                 } from './table.js';

export const AZURE_MIGRATE_IMPORT_SOURCE = 'https://learn.microsoft.com/en-us/azure/migrate/tutorial-discover-import';

                                                                                                                              
                                                                                                         
                                                                                         

export const AZURE_MIGRATE_HEADERS                    = {
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
const REQUIRED                   = ['name', 'cores', 'memMb', 'osName'];

                                      
                                                                              
                             
                                                                                               
                                   
 

/** The assessment columns, when the file is an assessment export (UNVERIFIED layout). */
                                     
                        
                              
                                    
                                   
                                   
                               
 

                                    
                                   
                                            
                               
 

function originOf(serverType        , hypervisor        , fallback                            )                 {
  if (/physical/i.test(serverType)) return 'physical';
  if (/vmware|vsphere|esx/i.test(hypervisor)) return 'vsphere';
  if (/hyper-?v/i.test(hypervisor)) return 'hyperv';
  if (/kvm/i.test(hypervisor)) return 'kvm';
  if (/xen/i.test(hypervisor)) return 'xen';
  return fallback ?? 'other';
}

export function parseAzureMigrateCsv(text        , opts                      = {})                    {
  const t = readTable(text);
  const map = mapHeader(t.header, AZURE_MIGRATE_HEADERS, REQUIRED, 'plan.sources.azure-migrate', 'The Azure Migrate CSV');
  if (!map.ok) return { servers: [], assessment: [], findings: [...map.findings] };
  const findings            = [...map.findings];
  const size = numberedColumns(t.header, /^disk(\d+)sizeingb$/);
  const rOps = numberedColumns(t.header, /^disk(\d+)readops/);
  const wOps = numberedColumns(t.header, /^disk(\d+)writeops/);
  const rMb = numberedColumns(t.header, /^disk(\d+)readthroughput/);
  const wMb = numberedColumns(t.header, /^disk(\d+)writethroughput/);
  const sumOf = (row                   , cols                     )                     => {
    const vals = cols.map((c) => num(row[c.index])).filter((v)              => v !== undefined);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : undefined;
  };
  const days = Math.max(0, opts.utilDays ?? 0);
  const servers                 = [];
  const assessment                       = [];
  const bad           = [];

  t.rows.forEach((row, i) => {
    const name = cell(row, map, 'name');
    const cores = num(cell(row, map, 'cores'));
    const memMb = num(cell(row, map, 'memMb'));
    if (!name || cores === undefined || memMb === undefined) { bad.push(t.lines[i] ); return; }
    const memGib = mbToGib(memMb);
    let disks = size.map((c) => num(row[c.index])).filter((v)              => v !== undefined && v > 0).map((v) => Math.ceil(v));
    const inUse = num(cell(row, map, 'storageInUse'));
    if (disks.length === 0 && inUse !== undefined && inUse > 0) disks = [Math.ceil(inUse)];
    const cpu = num(cell(row, map, 'cpuUtil'));
    const memPct = num(cell(row, map, 'memUtil'));
    const iops = [sumOf(row, rOps), sumOf(row, wOps)].filter((v)              => v !== undefined);
    const mbps = [sumOf(row, rMb), sumOf(row, wMb)].filter((v)              => v !== undefined);
    const net = [num(cell(row, map, 'netIn')), num(cell(row, map, 'netOut'))].filter((v)              => v !== undefined);
    let utilisation                         ;
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
      ...(env ? { env: env        } : {}),
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
        ...(/uefi|efi/i.test(boot) ? { firmware: 'efi'          } : /bios/i.test(boot) ? { firmware: 'bios'          } : {}),
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

                                                                        
                                                                                  

export function intakeFromAzureMigrate(texts                   , opts                            = {})               {
  const parsed = texts.map((t) => parseAzureMigrateCsv(t, opts));
  const rows = intakeFromSourceServers(parsed.flatMap((p) => p.servers), opts);
  return concatIntake([{ ...emptyIntake(), findings: parsed.flatMap((p) => p.findings) }, rows]);
}

export const AZURE_MIGRATE_CSV_ADAPTER                                                              = {
  id: 'azure-migrate-csv',
  label: 'Azure Migrate CSV (import template or assessment export)',
  itemSource: 'estate',
  parse: (input, options) => intakeFromAzureMigrate(input.files, options ?? {}),
};
