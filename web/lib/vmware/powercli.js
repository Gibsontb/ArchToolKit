/**
 * Import the JSON produced by tools/collector/Export-AtkInventory.ps1.
 *
 * The collector already emits the canonical shape, so this is mostly
 * validation rather than translation — but it is deliberately defensive,
 * because the file may come from an older collector version or have been
 * hand-edited.
 */

import { error, warning, info,              } from '../core/findings.js';
import {
  emptyInventory,
                 
                     
                   
                        
                          
                        
                   
                     
                       
                      
                  
                     
                         
} from './inventory.js';

                                        
                                
                                        
 

                                    

const asArray = (value         )         =>
  Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v !== null)          ) : [];

const str = (value         )                     =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const num = (value         )                     =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const bool = (value         )                      =>
  typeof value === 'boolean' ? value : undefined;

function powerStateOf(value         )             {
  const text = String(value ?? '').toLowerCase();
  if (text === 'poweredon') return 'poweredOn';
  if (text === 'poweredoff') return 'poweredOff';
  if (text === 'suspended') return 'suspended';
  return 'unknown';
}

function datastoreTypeOf(value         )                {
  const text = String(value ?? '');
  if (['VMFS', 'NFS', 'vsan', 'vVol'].includes(text)) return text                 ;
  return 'other';
}

function deviceTypeOf(value         )                    {
  const text = String(value ?? '');
  if (['NVMe', 'SSD', 'HDD'].includes(text)) return text                     ;
  return 'unknown';
}

function readNics(value         )                {
  return asArray(value).map((nic) => ({
    name: str(nic.name) ?? '',
    speedMb: num(nic.speedMb),
    mac: str(nic.mac),
    driver: str(nic.driver),
    firmware: str(nic.firmware),
    linkUp: bool(nic.linkUp),
    switchName: str(nic.switchName),
  }));
}

function readVmks(value         )                    {
  return asArray(value).map((vmk) => ({
    name: str(vmk.name) ?? '',
    ip: str(vmk.ip),
    subnetMask: str(vmk.subnetMask),
    mac: str(vmk.mac),
    mtu: num(vmk.mtu),
    portGroup: str(vmk.portGroup),
    vlanId: typeof vmk.vlanId === 'number' || typeof vmk.vlanId === 'string' ? vmk.vlanId : undefined,
    services: Array.isArray(vmk.services) ? vmk.services.map(String) : undefined,
    stack: str(vmk.stack),
  }));
}

function readDevices(value         )                  {
  return asArray(value).map((device) => ({
    name: str(device.name) ?? '',
    type: deviceTypeOf(device.type),
    capacityGib: num(device.capacityGib),
    model: str(device.model),
    vendor: str(device.vendor),
    isSsd: bool(device.isSsd),
    isLocal: bool(device.isLocal),
  }));
}

function readHbas(value         )                   {
  return asArray(value).map((hba) => ({
    name: str(hba.name) ?? '',
    type: str(hba.type),
    model: str(hba.model),
    driver: str(hba.driver),
    status: str(hba.status),
    wwn: str(hba.wwn),
  }));
}

function readHost(raw      )                       {
  const name = str(raw.name);
  if (!name) return null;

  const sockets = num(raw.cpuSockets) ?? 0;
  const coresPerSocket = num(raw.coresPerSocket) ?? 0;

  return {
    name,
    cluster: str(raw.cluster),
    datacenter: str(raw.datacenter),
    vendor: str(raw.vendor),
    model: str(raw.model),
    cpuModel: str(raw.cpuModel),
    cpuSockets: sockets,
    coresPerSocket,
    totalCores: num(raw.totalCores) ?? sockets * coresPerSocket,
    threads: num(raw.threads),
    cpuSpeedMhz: num(raw.cpuSpeedMhz),
    memoryGib: num(raw.memoryGib) ?? 0,
    cpuUsage: num(raw.cpuUsage),
    memoryUsage: num(raw.memoryUsage),
    nicCount: num(raw.nicCount),
    esxVersion: str(raw.esxVersion),
    build: str(raw.build),
    connectionState: str(raw.connectionState),
    inMaintenanceMode: bool(raw.inMaintenanceMode),
    allocatedVcpu: num(raw.allocatedVcpu),
    allocatedMemoryGib: num(raw.allocatedMemoryGib),
    serialNumber: str(raw.serialNumber),
    biosVersion: str(raw.biosVersion),
    numaNodes: num(raw.numaNodes),
    hyperthreadingActive: bool(raw.hyperthreadingActive),
    tpmPresent: bool(raw.tpmPresent),
    secureBootEnabled: bool(raw.secureBootEnabled),
    uptimeDays: num(raw.uptimeDays),
    physicalNics: readNics(raw.physicalNics),
    vmkernelAdapters: readVmks(raw.vmkernelAdapters),
    storageDevices: readDevices(raw.storageDevices),
    hbas: readHbas(raw.hbas),
  };
}

function readVm(raw      )                     {
  const name = str(raw.name);
  if (!name) return null;
  return {
    name,
    uuid: str(raw.uuid),
    powerState: powerStateOf(raw.powerState),
    host: str(raw.host),
    cluster: str(raw.cluster),
    datacenter: str(raw.datacenter),
    vcpu: num(raw.vcpu) ?? 0,
    coresPerSocket: num(raw.coresPerSocket),
    memoryGib: num(raw.memoryGib) ?? 0,
    provisionedGib: num(raw.provisionedGib) ?? 0,
    usedGib: num(raw.usedGib),
    guestOs: str(raw.guestOs),
    hardwareVersion: str(raw.hardwareVersion),
    toolsVersion: str(raw.toolsVersion),
    toolsStatus: str(raw.toolsStatus),
    ipAddress: str(raw.ipAddress),
    datastores: Array.isArray(raw.datastores) ? raw.datastores.map(String) : undefined,
    networks: Array.isArray(raw.networks) ? raw.networks.map(String) : undefined,
    snapshotCount: num(raw.snapshotCount),
  };
}

/** Import a collector JSON document. */
export function importCollectorJson(json        )                        {
  const findings            = [];

  let parsed         ;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      inventory: emptyInventory({ kind: 'powercli' }),
      findings: [
        error(
          'inventory.collector.invalid-json',
          `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        ),
      ],
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      inventory: emptyInventory({ kind: 'powercli' }),
      findings: [error('inventory.collector.not-an-object', 'Expected a JSON object at the top level.')],
    };
  }

  const doc = parsed        ;
  const sourceRaw = (doc.source ?? {})        ;

  const hosts = asArray(doc.hosts)
    .map(readHost)
    .filter((h)                     => h !== null);
  const vms = asArray(doc.vms)
    .map(readVm)
    .filter((v)                   => v !== null);

  const clusters                     = asArray(doc.clusters)
    // The explicit type argument stops the declared array type flowing into the
    // callback: the intermediate is nullable, the result is not.
    .map                         ((raw) => {
      const name = str(raw.name);
      if (!name) return null;
      return {
        name,
        datacenter: str(raw.datacenter),
        haEnabled: bool(raw.haEnabled),
        drsEnabled: bool(raw.drsEnabled),
        drsAutomationLevel: str(raw.drsAutomationLevel),
        evcMode: str(raw.evcMode),
        vsanEnabled: bool(raw.vsanEnabled),
        hostCount: num(raw.hostCount),
      };
    })
    .filter((c)                        => c !== null);

  const datastores                       = asArray(doc.datastores)
    .map                           ((raw) => {
      const name = str(raw.name);
      if (!name) return null;
      return {
        name,
        type: datastoreTypeOf(raw.type),
        capacityGib: num(raw.capacityGib) ?? 0,
        freeGib: num(raw.freeGib) ?? 0,
        provisionedGib: num(raw.provisionedGib),
        hostCount: num(raw.hostCount),
        cluster: str(raw.cluster),
      };
    })
    .filter((d)                          => d !== null);

  const networks                     = asArray(doc.networks)
    .map                         ((raw) => {
      const name = str(raw.name);
      if (!name) return null;
      return {
        name,
        switchName: str(raw.switchName),
        vlanId:
          typeof raw.vlanId === 'number' || typeof raw.vlanId === 'string' ? raw.vlanId : undefined,
        type: str(raw.type),
      };
    })
    .filter((n)                        => n !== null);

  if (hosts.length === 0 && vms.length === 0) {
    findings.push(
      warning(
        'inventory.collector.empty',
        'The file parsed but contains no hosts or VMs. Check the collector completed successfully.',
      ),
    );
  }

  const schemaVersion = str(doc.schemaVersion);
  if (schemaVersion && schemaVersion !== '1.0') {
    findings.push(
      info(
        'inventory.collector.schema-version',
        `This file declares collector schema ${schemaVersion}; this build expects 1.0. Unknown fields are ignored.`,
      ),
    );
  }

  // The collector's whole point is capturing what RVTools cannot, so say so
  // when it was run in a mode that skipped the expensive parts.
  const withStats = asArray(doc.hosts).filter((h) => h.cpuStats).length;
  if (hosts.length > 0 && withStats === 0) {
    findings.push(
      info(
        'inventory.collector.no-historical-stats',
        'No historical performance data is present, so utilisation is point-in-time only. Re-run the collector with -StatDays 30 for peak-aware sizing.',
      ),
    );
  } else if (withStats > 0) {
    findings.push(
      info(
        'inventory.collector.historical-stats',
        `Historical CPU and memory statistics are present for ${withStats} host(s), so sizing can account for peaks rather than a single sample.`,
      ),
    );
  }

  const inventory            = {
    ...emptyInventory({
      kind: 'powercli',
      label: str(sourceRaw.label) ?? str((doc.vcenter                    )?.name),
      collectedAt: str(sourceRaw.collectedAt),
      notes: Array.isArray(sourceRaw.notes) ? sourceRaw.notes.map(String) : undefined,
    }),
    hosts,
    vms,
    clusters,
    datastores,
    networks,
  };

  return { inventory, findings };
}
