/**
 * Google Migration Center manual-import tables (tier 1 of the provider
 * methodology): `vmInfo.csv`, `diskInfo.csv`, `perfInfo.csv` and
 * `tagInfo.csv` (https://docs.cloud.google.com/migration-center/docs/import-data-tables).
 *
 * - vmInfo: MachineId*, MachineName*, PrimaryIPAddress, PrimaryMACAddress,
 *   PublicIPAddress, IpAddressListSemiColonDelimited, TotalDiskAllocatedGiB,
 *   TotalDiskUsedGiB, MachineTypeLabel, AllocatedProcessorCoreCount,
 *   MemoryGiB, OsType, OsName, OsVersion, HostingLocation, MachineStatus,
 *   ProvisioningState, CreateDate, IsPhysical, Source.
 * - diskInfo: MachineId*, DiskLabel, SizeInGib, UsedInGib, StorageTypeLabel.
 * - perfInfo: MachineId*, TimeStamp*, CpuUtilizationPercentage,
 *   MemoryUtilizationPercentage, UtilizedMemoryBytes,
 *   DiskReadOperationsPerSec, DiskWriteOperationsPerSec,
 *   NetworkBytesPerSecSent, NetworkBytesPerSecReceived.
 * - tagInfo: MachineId, Key*, Value*.
 *
 * The performance time series becomes percentiles on import (p50 / p95 /
 * p99 / max), with the window and coverage from the timestamps.
 */

import { warning,              } from '../../../../core/findings.js';
import { classifyOs } from '../../os.js';
                                                     
import { concatIntake, emptyIntake,                                       } from '../adapter.js';
import { intakeFromSourceServers, parseTimestamp, utilisationFromSeries,                                             } from './common.js';
import { bool, bytesToGib, cell, list, mapHeader, num, readTable, skipped,                 } from './table.js';

export const MIGRATION_CENTER_SOURCE = 'https://docs.cloud.google.com/migration-center/docs/import-data-tables';

                                                                                                                                   
                                                                                                        
export const VM_INFO_HEADERS                      = {
  id: ['MachineId', 'Machine ID'],
  name: ['MachineName', 'Machine name'],
  ip: ['PrimaryIPAddress'],
  mac: ['PrimaryMACAddress'],
  publicIp: ['PublicIPAddress'],
  ipList: ['IpAddressListSemiColonDelimited', 'IpAddressList'],
  diskAlloc: ['TotalDiskAllocatedGiB'],
  diskUsed: ['TotalDiskUsedGiB'],
  machineType: ['MachineTypeLabel'],
  cores: ['AllocatedProcessorCoreCount', 'ProcessorCoreCount'],
  memGib: ['MemoryGiB'],
  osType: ['OsType'],
  osName: ['OsName'],
  osVersion: ['OsVersion'],
  hosting: ['HostingLocation'],
  status: ['MachineStatus'],
  provisioning: ['ProvisioningState'],
  isPhysical: ['IsPhysical'],
  source: ['Source'],
};
                                                           
export const DISK_INFO_HEADERS                        = {
  id: ['MachineId'], label: ['DiskLabel'], size: ['SizeInGib'], used: ['UsedInGib'], type: ['StorageTypeLabel'],
};
                                                                                                              
export const PERF_INFO_HEADERS                        = {
  id: ['MachineId'], ts: ['TimeStamp', 'Timestamp'], cpu: ['CpuUtilizationPercentage'], memPct: ['MemoryUtilizationPercentage'],
  memBytes: ['UtilizedMemoryBytes'], readOps: ['DiskReadOperationsPerSec'], writeOps: ['DiskWriteOperationsPerSec'],
  netSent: ['NetworkBytesPerSecSent'], netRecv: ['NetworkBytesPerSecReceived'],
};
                                       
export const TAG_INFO_HEADERS                       = { id: ['MachineId'], key: ['Key'], value: ['Value'] };

                                       
                          
                             
                             
                            
 

                                         
                                                                                                   
                                   
 

function originOf(isPhysical                     , hints        , fallback                            )                 {
  if (isPhysical) return 'physical';
  const h = hints.toLowerCase();
  if (/vmware|vsphere|vcenter|esx/.test(h)) return 'vsphere';
  if (/hyper-?v/.test(h)) return 'hyperv';
  if (/\baws\b|amazon|ec2/.test(h)) return 'aws';
  if (/azure/.test(h)) return 'azure';
  if (/gcp|google|compute engine/.test(h)) return 'google';
  if (/\boci\b|oracle cloud/.test(h)) return 'oci';
  if (/nutanix|ahv/.test(h)) return 'ahv';
  return fallback ?? 'other';
}

export function parseMigrationCenter(files                      , opts                         = {})                                                   {
  const findings            = [];
  const vm = readTable(files.vmInfo);
  const vmMap = mapHeader(vm.header, VM_INFO_HEADERS, ['id', 'name'], 'plan.sources.migration-center.vminfo', 'vmInfo.csv');
  findings.push(...vmMap.findings);
  if (!vmMap.ok) return { servers: [], findings };

  // diskInfo
  const disks = new Map                                           ();
  if (files.diskInfo) {
    const t = readTable(files.diskInfo);
    const m = mapHeader(t.header, DISK_INFO_HEADERS, ['id'], 'plan.sources.migration-center.diskinfo', 'diskInfo.csv');
    findings.push(...m.findings);
    if (m.ok) for (const row of t.rows) {
      const id = cell(row, m, 'id');
      const size = num(cell(row, m, 'size'));
      if (!id || size === undefined) continue;
      const used = num(cell(row, m, 'used'));
      disks.set(id, [...(disks.get(id) ?? []), { size, ...(used !== undefined ? { used } : {}) }]);
    }
  }
  // tagInfo
  const tags = new Map                                ();
  if (files.tagInfo) {
    const t = readTable(files.tagInfo);
    const m = mapHeader(t.header, TAG_INFO_HEADERS, ['key', 'value'], 'plan.sources.migration-center.taginfo', 'tagInfo.csv');
    findings.push(...m.findings);
    if (m.ok && m.index.id === undefined) {
      findings.push(warning('plan.sources.migration-center.tag-machine', 'tagInfo.csv has no MachineId column, so its tags cannot be tied to machines and were ignored.'));
    } else if (m.ok) for (const row of t.rows) {
      const id = cell(row, m, 'id');
      const key = cell(row, m, 'key');
      if (!id || !key) continue;
      tags.set(id, { ...(tags.get(id) ?? {}), [key]: cell(row, m, 'value') });
    }
  }
  // perfInfo, collected per machine then reduced to percentiles once memory sizes are known
  const perf = new Map                                                                                                              ();
  if (files.perfInfo) {
    const t = readTable(files.perfInfo);
    const m = mapHeader(t.header, PERF_INFO_HEADERS, ['id', 'ts'], 'plan.sources.migration-center.perfinfo', 'perfInfo.csv');
    findings.push(...m.findings);
    const badTs           = [];
    if (m.ok) t.rows.forEach((row, i) => {
      const id = cell(row, m, 'id');
      const at = parseTimestamp(cell(row, m, 'ts'));
      if (!id) return;
      if (at === undefined) { badTs.push(t.lines[i] ); return; }
      const p = perf.get(id) ?? { at: [], cpu: [], memPct: [], memBytes: [], iops: [], net: [] };
      p.at.push(at);
      const cpu = num(cell(row, m, 'cpu')); if (cpu !== undefined) p.cpu.push(cpu);
      const mp = num(cell(row, m, 'memPct')); if (mp !== undefined) p.memPct.push(mp);
      const mb = num(cell(row, m, 'memBytes')); if (mb !== undefined) p.memBytes.push(mb);
      const r = num(cell(row, m, 'readOps')), w = num(cell(row, m, 'writeOps'));
      if (r !== undefined || w !== undefined) p.iops.push((r ?? 0) + (w ?? 0));
      const s = num(cell(row, m, 'netSent')), rv = num(cell(row, m, 'netRecv'));
      if (s !== undefined || rv !== undefined) p.net.push((((s ?? 0) + (rv ?? 0)) * 8) / 1e6);
      perf.set(id, p);
    });
    findings.push(...skipped('plan.sources.migration-center.perf-time', 'perfInfo', badTs, 'unreadable TimeStamp'));
  }

  const servers                 = [];
  const bad           = [];
  vm.rows.forEach((row, i) => {
    const id = cell(row, vmMap, 'id');
    const name = cell(row, vmMap, 'name');
    if (!id || !name) { bad.push(vm.lines[i] ); return; }
    const memGib = num(cell(row, vmMap, 'memGib')) ?? 0;
    const cores = num(cell(row, vmMap, 'cores')) ?? 0;
    const machineDisks = disks.get(id) ?? [];
    const alloc = num(cell(row, vmMap, 'diskAlloc'));
    const usedTotal = num(cell(row, vmMap, 'diskUsed'));
    const disksGib = machineDisks.length > 0 ? machineDisks.map((d) => Math.ceil(d.size)) : alloc ? [Math.ceil(alloc)] : [];
    const usedGib = machineDisks.length > 0 && machineDisks.some((d) => d.used !== undefined)
      ? machineDisks.map((d) => d.used ?? 0) : usedTotal !== undefined && disksGib.length === 1 ? [usedTotal] : undefined;
    const ips = [...new Set([cell(row, vmMap, 'ip'), ...list(cell(row, vmMap, 'ipList'), /[;\s]+/)].filter((s) => s !== ''))];
    const osText = [cell(row, vmMap, 'osName'), cell(row, vmMap, 'osVersion')].filter((s) => s !== '').join(' ') || cell(row, vmMap, 'osType');
    const p = perf.get(id);
    const util = p ? utilisationFromSeries({
      at: p.at, cpuPct: p.cpu,
      memGib: p.memBytes.length > 0 ? p.memBytes.map(bytesToGib) : p.memPct.map((pct) => (memGib * pct) / 100),
      iops: p.iops, netMbps: p.net,
    }) : undefined;
    const isPhysical = bool(cell(row, vmMap, 'isPhysical'));
    const origin = originOf(isPhysical, `${cell(row, vmMap, 'source')} ${cell(row, vmMap, 'hosting')}`, opts.origin);
    const status = cell(row, vmMap, 'status').toLowerCase();
    const machineTags = tags.get(id);
    servers.push({
      name,
      os: classifyOs(osText),
      guestOs: osText,
      vcpu: cores,
      memoryGib: memGib,
      disksGib,
      provisionedGib: disksGib.reduce((a, b) => a + b, 0),
      sourceKey: `migration-center/${id}`,
      facts: {
        powerState: /\b(running|active|on|poweredon)\b/.test(status) ? 'poweredOn' : /stop|\boff\b|poweredoff|terminat/.test(status) ? 'poweredOff' : 'unknown',
        guestOsRaw: osText,
        ...(ips.length > 0 ? { ipAddresses: ips } : {}),
        ...(usedGib ? { disksUsedGib: usedGib.map((u) => Math.round(u * 10) / 10) } : {}),
        ...(util ? { utilisation: util } : {}),
      },
      origin,
      sourceRef: { platform: origin, id },
      ...(machineTags ? { tags: machineTags } : {}),
    });
  });
  findings.push(...skipped('plan.sources.migration-center.row', 'vmInfo', bad, 'no MachineId or MachineName'));
  const known = new Set(servers.map((s) => s.sourceRef?.id));
  const orphans = [...perf.keys(), ...disks.keys()].filter((id) => !known.has(id));
  if (orphans.length > 0) findings.push(warning('plan.sources.migration-center.orphan', `${new Set(orphans).size} MachineId value(s) in diskInfo / perfInfo are not in vmInfo and were ignored: ${[...new Set(orphans)].slice(0, 5).join(', ')}.`));
  return { servers, findings };
}

                                                                                        

export function intakeFromMigrationCenter(files                      , opts                               = {})               {
  const p = parseMigrationCenter(files, opts);
  return concatIntake([{ ...emptyIntake(), findings: p.findings }, intakeFromSourceServers(p.servers, opts)]);
}

export const MIGRATION_CENTER_CSV_ADAPTER                                                                    = {
  id: 'migration-center-csv',
  label: 'Google Migration Center tables (vmInfo, diskInfo, perfInfo, tagInfo)',
  itemSource: 'estate',
  parse: (input, options) => intakeFromMigrationCenter(input, options ?? {}),
};
