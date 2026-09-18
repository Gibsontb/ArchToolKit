/**
 * RVTools import.
 *
 * RVTools is the de facto way estates get exported, so this maps its sheets
 * into the canonical inventory model. Column names have drifted across RVTools
 * versions ("# Memory" vs "Memory", "In Use MiB" vs "In Use"), so every field
 * lists the spellings seen in the wild and `pick` resolves whichever is
 * present, ignoring case and punctuation.
 *
 * Units: RVTools reports capacity in MiB and memory in MiB. Everything is
 * converted to GiB at this boundary so nothing downstream has to know that.
 *
 * A caveat worth repeating wherever these numbers are used: RVTools captures
 * point-in-time CPU and memory percentages only. There is no historical peak,
 * so sizing built purely on an RVTools snapshot understates bursty workloads.
 */

import { parseCsvRecords, pick, pickNumber, parseBoolean } from '../core/csv.ts';
import { mibToGib } from '../core/units.ts';
import { warning, info, type Finding } from '../core/findings.ts';
import {
  emptyInventory,
  type Inventory,
  type InventoryHost,
  type InventoryVm,
  type InventoryCluster,
  type InventoryDatastore,
  type InventoryNetwork,
  type PowerState,
  type DatastoreType,
} from './inventory.ts';

/** RVTools sheet names this importer understands. */
export type RvToolsSheet = 'vInfo' | 'vHost' | 'vCluster' | 'vDatastore' | 'vNetwork' | 'dvPort';

export interface RvToolsInput {
  /** Sheet name to raw CSV text. */
  readonly sheets: Partial<Record<RvToolsSheet, string>>;
  readonly label?: string;
  readonly collectedAt?: string;
}

export interface ImportResult {
  readonly inventory: Inventory;
  readonly findings: readonly Finding[];
}

function powerStateOf(raw: string | undefined): PowerState {
  const value = (raw ?? '').trim().toLowerCase();
  if (value.includes('on')) return 'poweredOn';
  if (value.includes('suspend')) return 'suspended';
  if (value.includes('off')) return 'poweredOff';
  return 'unknown';
}

function datastoreTypeOf(raw: string | undefined): DatastoreType {
  const value = (raw ?? '').trim().toLowerCase();
  if (value.includes('vsan')) return 'vsan';
  if (value.includes('nfs')) return 'NFS';
  if (value.includes('vmfs')) return 'VMFS';
  if (value.includes('vvol')) return 'vVol';
  return 'other';
}

/**
 * Detect which RVTools sheet a CSV came from, by its header signature.
 *
 * Users export sheets individually and the filenames are rarely reliable, so
 * identifying by content is more robust than trusting the name.
 */
export function detectSheet(csv: string): RvToolsSheet | null {
  const firstLine = (csv.split(/\r?\n/)[0] ?? '').toLowerCase();
  const has = (...needles: string[]): boolean => needles.every((n) => firstLine.includes(n));

  if (has('cpu model', 'cores per cpu')) return 'vHost';
  if (has('capacity mib', 'provisioned mib')) return 'vDatastore';
  // vInfo is the VM sheet; check it after vHost since both mention CPUs.
  if (has('powerstate') && (firstLine.includes('provisioned mib') || firstLine.includes('cpus'))) {
    return 'vInfo';
  }
  if (has('switch', 'vlan')) return 'dvPort';
  if (has('switch', 'connected')) return 'vNetwork';
  if (firstLine.includes('ha enabled') || firstLine.includes('drs enabled')) return 'vCluster';
  return null;
}

function importVInfo(csv: string, findings: Finding[]): InventoryVm[] {
  const records = parseCsvRecords(csv);
  return records
    .map((record): InventoryVm | null => {
      const name = pick(record, 'VM', 'Name', 'VM Name');
      if (!name) return null;

      const provisionedMib = pickNumber(record, 'Provisioned MiB', 'Provisioned MB', 'Provisioned');
      const usedMib = pickNumber(record, 'In Use MiB', 'In Use MB', 'In Use');
      const memoryMib = pickNumber(record, 'Memory', 'Memory MiB', 'Memory MB');

      return {
        name,
        uuid: pick(record, 'VM UUID', 'UUID', 'SMBIOS UUID'),
        powerState: powerStateOf(pick(record, 'Powerstate', 'Power State', 'PowerState')),
        host: pick(record, 'Host', 'ESX Host'),
        cluster: pick(record, 'Cluster'),
        datacenter: pick(record, 'Datacenter'),
        vcpu: pickNumber(record, 'CPUs', 'CPU', '# vCPUs', 'NumCpu') ?? 0,
        coresPerSocket: pickNumber(record, 'Cores p/s', 'Cores per Socket') ?? undefined,
        memoryGib: memoryMib === null ? 0 : mibToGib(memoryMib),
        provisionedGib: provisionedMib === null ? 0 : mibToGib(provisionedMib),
        usedGib: usedMib === null ? undefined : mibToGib(usedMib),
        guestOs:
          pick(
            record,
            'OS according to the configuration file',
            'OS according to the VMware Tools',
            'Guest OS',
            'OS',
          ) ?? undefined,
        hardwareVersion: pick(record, 'HW version', 'Hardware Version') ?? undefined,
        toolsVersion: pick(record, 'Tools version', 'VM Tools Version') ?? undefined,
        toolsStatus: pick(record, 'Tools', 'Tools Status') ?? undefined,
        ipAddress: pick(record, 'Primary IP Address', 'IP Address') ?? undefined,
      };
    })
    .filter((vm): vm is InventoryVm => vm !== null);
}

function importVHost(csv: string, findings: Finding[]): InventoryHost[] {
  const records = parseCsvRecords(csv);
  return records
    .map((record): InventoryHost | null => {
      const name = pick(record, 'Host', 'Name', 'ESX Host');
      if (!name) return null;

      const sockets = pickNumber(record, '# CPU', 'CPU', 'Sockets', 'NumCpuPackages') ?? 0;
      const coresPerSocket =
        pickNumber(record, 'Cores per CPU', 'Cores p/CPU', 'CoresPerSocket') ?? 0;
      const totalCores =
        pickNumber(record, '# Cores', 'Cores', 'NumCpuCores') ?? sockets * coresPerSocket;
      const memoryMib = pickNumber(record, '# Memory', 'Memory', 'Memory MiB', 'Memory MB');

      const cpuUsagePct = pickNumber(record, 'CPU usage %', 'CPU usage');
      const memUsagePct = pickNumber(record, 'Memory usage %', 'Memory usage');

      return {
        name,
        cluster: pick(record, 'Cluster') ?? undefined,
        datacenter: pick(record, 'Datacenter') ?? undefined,
        vendor: pick(record, 'Vendor') ?? undefined,
        model: pick(record, 'Model') ?? undefined,
        cpuModel: pick(record, 'CPU Model', 'ProcessorType') ?? undefined,
        cpuSockets: sockets,
        coresPerSocket,
        totalCores,
        cpuSpeedMhz: pickNumber(record, 'Speed', 'CPU Speed') ?? undefined,
        memoryGib: memoryMib === null ? 0 : mibToGib(memoryMib),
        cpuUsage: cpuUsagePct === null ? undefined : cpuUsagePct / 100,
        memoryUsage: memUsagePct === null ? undefined : memUsagePct / 100,
        nicCount: pickNumber(record, '#NICs', 'NICs', 'Num NICs') ?? undefined,
        esxVersion: pick(record, 'ESX Version', 'Version') ?? undefined,
        connectionState: pick(record, 'Config status', 'Connection State') ?? undefined,
        inMaintenanceMode: parseBoolean(pick(record, 'in Maintenance Mode')) ?? undefined,
        allocatedVcpu: pickNumber(record, '# vCPUs', 'vCPUs') ?? undefined,
        allocatedMemoryGib: (() => {
          const vram = pickNumber(record, 'vRAM', 'VM Memory');
          return vram === null ? undefined : mibToGib(vram);
        })(),
      };
    })
    .filter((host): host is InventoryHost => host !== null);
}

function importVDatastore(csv: string): InventoryDatastore[] {
  const records = parseCsvRecords(csv);
  return records
    .map((record): InventoryDatastore | null => {
      const name = pick(record, 'Name', 'Datastore');
      if (!name) return null;

      const capacityMib = pickNumber(record, 'Capacity MiB', 'Capacity MB', 'Capacity') ?? 0;
      const provisionedMib = pickNumber(record, 'Provisioned MiB', 'Provisioned MB');
      const inUseMib = pickNumber(record, 'In Use MiB', 'In Use MB');
      const freeMib = pickNumber(record, 'Free MiB', 'Free MB', 'Free Space MiB');

      const capacityGib = mibToGib(capacityMib);
      const freeGib =
        freeMib !== null
          ? mibToGib(freeMib)
          : inUseMib !== null
            ? Math.max(0, capacityGib - mibToGib(inUseMib))
            : 0;

      return {
        name,
        type: datastoreTypeOf(pick(record, 'Type')),
        capacityGib,
        freeGib,
        provisionedGib: provisionedMib === null ? undefined : mibToGib(provisionedMib),
        hostCount: pickNumber(record, 'Hosts', '# Hosts') ?? undefined,
      };
    })
    .filter((ds): ds is InventoryDatastore => ds !== null);
}

function importVCluster(csv: string): InventoryCluster[] {
  const records = parseCsvRecords(csv);
  return records
    .map((record): InventoryCluster | null => {
      const name = pick(record, 'Name', 'Cluster');
      if (!name) return null;
      return {
        name,
        datacenter: pick(record, 'Datacenter') ?? undefined,
        haEnabled: parseBoolean(pick(record, 'HA enabled', 'HAEnabled')) ?? undefined,
        drsEnabled: parseBoolean(pick(record, 'DRS enabled', 'DrsEnabled')) ?? undefined,
        drsAutomationLevel: pick(record, 'DRS default VM behavior', 'DRS Automation Level') ?? undefined,
        evcMode: pick(record, 'Current EVC Mode', 'EVC Mode') ?? undefined,
        vsanEnabled: parseBoolean(pick(record, 'VSAN enabled', 'vSAN enabled')) ?? undefined,
        hostCount: pickNumber(record, 'NumHosts', '# Hosts', 'Hosts') ?? undefined,
      };
    })
    .filter((cluster): cluster is InventoryCluster => cluster !== null);
}

function importPorts(csv: string): InventoryNetwork[] {
  const records = parseCsvRecords(csv);
  const seen = new Map<string, InventoryNetwork>();
  for (const record of records) {
    const name = pick(record, 'Port', 'Network', 'Portgroup', 'Object ID');
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.set(name, {
      name,
      switchName: pick(record, 'Switch') ?? undefined,
      vlanId: pick(record, 'VLAN') ?? undefined,
      type: pick(record, 'Type') ?? undefined,
    });
  }
  return [...seen.values()];
}

/** Import one or more RVTools sheets into a canonical inventory. */
export function importRvTools(input: RvToolsInput): ImportResult {
  const findings: Finding[] = [];
  const notes: string[] = [];

  const hosts = input.sheets.vHost ? importVHost(input.sheets.vHost, findings) : [];
  const vms = input.sheets.vInfo ? importVInfo(input.sheets.vInfo, findings) : [];
  const clusters = input.sheets.vCluster ? importVCluster(input.sheets.vCluster) : [];
  const datastores = input.sheets.vDatastore ? importVDatastore(input.sheets.vDatastore) : [];
  const networks = input.sheets.dvPort
    ? importPorts(input.sheets.dvPort)
    : input.sheets.vNetwork
      ? importPorts(input.sheets.vNetwork)
      : [];

  if (hosts.length === 0 && vms.length === 0) {
    findings.push(
      warning(
        'inventory.rvtools.no-data',
        'No hosts or VMs were imported. Check that the vHost and vInfo sheets were exported as CSV.',
        { source: 'RVTools import' },
      ),
    );
  }

  if (hosts.length === 0 && vms.length > 0) {
    findings.push(
      warning(
        'inventory.rvtools.no-hosts',
        'VMs were imported but no hosts. Capacity and consolidation analysis needs the vHost sheet.',
        { remediation: 'Export the vHost sheet from RVTools and import it alongside vInfo.' },
      ),
    );
  }

  // A host row with no core count makes every downstream calculation wrong, so
  // it is called out rather than silently contributing zero.
  const hostsWithoutCores = hosts.filter((h) => h.totalCores === 0);
  if (hostsWithoutCores.length > 0) {
    findings.push(
      warning(
        'inventory.rvtools.hosts-missing-cores',
        `${hostsWithoutCores.length} host(s) have no core count and will contribute nothing to capacity totals.`,
        {
          path: 'vHost',
          remediation: 'Check the "# Cores" and "Cores per CPU" columns in the export.',
        },
      ),
    );
  }

  const vmsWithoutUsage = vms.filter((v) => v.usedGib === undefined).length;
  if (vms.length > 0 && vmsWithoutUsage === vms.length) {
    findings.push(
      info(
        'inventory.rvtools.no-used-capacity',
        'No consumed-capacity data was found, so thin provisioning cannot be measured. Provisioned capacity is being used for both figures.',
        { path: 'vInfo', remediation: 'Include the "In Use MiB" column in the vInfo export.' },
      ),
    );
  }

  if (vms.length > 0 || hosts.length > 0) {
    findings.push(
      info(
        'inventory.rvtools.point-in-time',
        'RVTools captures point-in-time CPU and memory percentages only, with no historical peak. Supplement with Get-Stat or VCF Operations time series before sizing bursty workloads.',
        { source: 'RVTools data model' },
      ),
    );
  }

  const imported = Object.keys(input.sheets).filter(
    (key) => input.sheets[key as RvToolsSheet],
  );
  notes.push(`Imported sheets: ${imported.join(', ') || 'none'}`);

  const inventory: Inventory = {
    ...emptyInventory({
      kind: 'rvtools',
      ...(input.label ? { label: input.label } : {}),
      ...(input.collectedAt ? { collectedAt: input.collectedAt } : {}),
      notes,
    }),
    hosts,
    vms,
    clusters,
    datastores,
    networks,
  };

  return { inventory, findings };
}

/**
 * Import a set of CSV files whose sheet identity is unknown, detecting each by
 * its header signature.
 */
export function importRvToolsFiles(
  files: readonly { name: string; content: string }[],
  label?: string,
): ImportResult {
  const sheets: Partial<Record<RvToolsSheet, string>> = {};
  const unrecognised: string[] = [];

  for (const file of files) {
    const sheet = detectSheet(file.content) ?? guessFromFilename(file.name);
    if (sheet) sheets[sheet] = file.content;
    else unrecognised.push(file.name);
  }

  const result = importRvTools({
    sheets,
    label: label ?? files.map((f) => f.name).join(', '),
  });

  if (unrecognised.length === 0) return result;

  return {
    inventory: result.inventory,
    findings: [
      ...result.findings,
      warning(
        'inventory.rvtools.unrecognised-file',
        `Could not identify ${unrecognised.length} file(s): ${unrecognised.join(', ')}.`,
        {
          remediation:
            'Export the vInfo, vHost, vCluster and vDatastore sheets as CSV with their header rows intact.',
        },
      ),
    ],
  };
}

function guessFromFilename(name: string): RvToolsSheet | null {
  const lower = name.toLowerCase();
  for (const sheet of ['vInfo', 'vHost', 'vCluster', 'vDatastore', 'dvPort', 'vNetwork'] as const) {
    if (lower.includes(sheet.toLowerCase())) return sheet;
  }
  return null;
}
