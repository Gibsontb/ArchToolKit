/**
 * RVTools import.
 *
 * RVTools is how estates get exported, so this reads all of it: the workbook as
 * RVTools writes it (one .xlsx, twenty-seven tabs), or any of its tabs saved as
 * CSV. Every tab maps into the canonical inventory — VMs with their disks,
 * partitions, NICs, snapshots, CPU and memory detail and tools state; hosts with
 * their HBAs, uplinks, VMkernel adapters, switches, port groups and storage
 * paths; clusters with their HA and DRS settings; datastores, resource pools,
 * distributed switches, vCenters, licences and health messages. A field that
 * RVTools records and the import dropped would be a field someone has to go
 * back to the spreadsheet for, which is the thing this exists to stop.
 *
 * Some things this has to get right that a naive import gets wrong:
 *
 *  - **Several vCenters in one export.** RVTools' "VI SDK Server" column names
 *    the vCenter, and cluster names, folder ids and VM ids repeat between them.
 *    Every join here is scoped by vCenter.
 *  - **Templates and SRM placeholders** sit in vInfo beside the VMs. They are
 *    kept, and marked, so they are counted for disk and nothing else.
 *  - **Raw device mappings.** "In Use MiB" includes a physical-mode RDM's full
 *    size, so seven nodes sharing one 1.2 PB LUN report 8.4 PB. The disks tab
 *    says which disks are RDMs and which LUN they map, so the VM's RDM share is
 *    recorded separately and the LUN counted once downstream.
 *  - **Custom attributes.** Whatever the vCenter admins defined appear as extra
 *    columns between Annotation and Datacenter, named whatever they were named.
 *    They are kept under those names.
 *  - **Dates** arrive as Excel serials in CSV and as dates in the workbook; both
 *    come out as ISO.
 *
 * Column names have drifted across RVTools versions ("# Memory" vs "Memory",
 * "In Use MiB" vs "In Use"), so each field lists the spellings seen in the wild
 * and matching ignores case and punctuation.
 *
 * Units: RVTools reports MiB. Everything is GiB past this file.
 *
 * And the caveat worth repeating wherever these numbers are used: RVTools
 * captures point-in-time CPU and memory figures only. There is no historical
 * peak, so sizing built purely on a snapshot understates bursty workloads — and
 * a snapshot taken at 2 AM understates everything.
 */

import { parseCsv, parseNumber, parseBoolean } from '../core/csv.js';
import { mibToGib } from '../core/units.js';
import { warning, info,              } from '../core/findings.js';
import { openXlsx, excelSerialToIso, looksLikeXlsx } from '../core/xlsx.js';
import {
  emptyInventory,
  scopedKey,
                 
                     
                   
                        
                          
                        
                        
                             
                                  
                        
                              
                     
                   
                       
                      
                      
                          
                   
                      
              
                   
             
                
                  
                     
                  
                     
} from './inventory.js';

/** Every tab RVTools 4.x writes, in its own order. */
export const RVTOOLS_TABS = [
  'vInfo',
  'vCPU',
  'vMemory',
  'vDisk',
  'vPartition',
  'vNetwork',
  'vCD',
  'vUSB',
  'vSnapshot',
  'vTools',
  'vSource',
  'vRP',
  'vCluster',
  'vHost',
  'vHBA',
  'vNIC',
  'vSwitch',
  'vPort',
  'dvSwitch',
  'dvPort',
  'vSC_VMK',
  'vDatastore',
  'vMultiPath',
  'vLicense',
  'vFileInfo',
  'vHealth',
  'vMetaData',
]         ;

                                                         

                               
                                  
                                                         
                          
                                
 

                               
                                
                                        
 

                                 
                       
                                             
                        
                         
 

// ---------------------------------------------------------------------------
// Reading a row by header name
// ---------------------------------------------------------------------------

const normalize = (s        )         => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A reader over one tab's rows.
 *
 * Header positions are resolved once per spelling list and cached, so reading
 * a field on the 135,000th partition row is an array index rather than a
 * search through the header.
 */
class Row {
          cells           = [];
                   exact = new Map                ();
                   loose = new Map                ();
                   cache = new Map                ();
           headers                   ;

  constructor(headers                   ) {
    this.headers = headers;
    headers.forEach((raw, i) => {
      const h = raw.trim();
      if (!this.exact.has(h)) this.exact.set(h, i);
      const n = normalize(h);
      if (!this.loose.has(n)) this.loose.set(n, i);
    });
  }

  set(cells          )       {
    this.cells = cells;
    return this;
  }

  index(names                   )         {
    const key = names.join('\u0000');
    let i = this.cache.get(key);
    if (i !== undefined) return i;
    i = -1;
    for (const n of names) {
      const e = this.exact.get(n);
      if (e !== undefined) {
        i = e;
        break;
      }
    }
    if (i < 0) {
      for (const n of names) {
        const l = this.loose.get(normalize(n));
        if (l !== undefined) {
          i = l;
          break;
        }
      }
    }
    this.cache.set(key, i);
    return i;
  }

  /** The cell at a column position, trimmed. */
  at(index        )         {
    return (this.cells[index] ?? '').trim();
  }

  has(...names          )          {
    return this.index(names) >= 0;
  }

  /** Text, trimmed; undefined when blank or absent. */
  s(...names          )                     {
    const i = this.index(names);
    if (i < 0) return undefined;
    const v = (this.cells[i] ?? '').trim();
    return v === '' ? undefined : v;
  }

  n(...names          )                     {
    return parseNumber(this.s(...names)) ?? undefined;
  }

  /** A MiB column as GiB. */
  gib(...names          )                     {
    const v = this.n(...names);
    return v === undefined ? undefined : mibToGib(v);
  }

  /** vSphere writes -1 for "unlimited"; that is no limit, not a negative one. */
  limit(...names          )                     {
    const v = this.n(...names);
    return v === undefined || v < 0 ? undefined : v;
  }

  b(...names          )                      {
    const raw = this.s(...names);
    if (raw === undefined) return undefined;
    return parseBoolean(raw) ?? undefined;
  }

  /** A date: ISO already (from the workbook) or an Excel serial (from CSV). */
  date(...names          )                     {
    const raw = this.s(...names);
    if (raw === undefined) return undefined;
    if (/^\d+(\.\d+)?(E[+-]?\d+)?$/i.test(raw)) {
      const serial = Number(raw);
      // Plausible serials only: 1990 to 2100. Anything else is not a date.
      if (serial > 32874 && serial < 73051) return excelSerialToIso(serial);
    }
    return raw;
  }

  /** A comma-separated list. */
  list(...names          )                       {
    const raw = this.s(...names);
    if (raw === undefined) return undefined;
    const items = raw
      .split(/\s*[,;]\s*/)
      .map((x) => x.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  /** The vCenter this row came from. */
  vcenter()                     {
    return this.s('VI SDK Server');
  }
}

/** Drop undefined fields, so a stored inventory carries only what was there. */
function compact                  (value   )    {
  for (const key of Object.keys(value)               ) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function powerStateOf(raw                    )             {
  const value = (raw ?? '').trim().toLowerCase();
  if (value.includes('suspend')) return 'suspended';
  if (value.includes('off')) return 'poweredOff';
  if (value.includes('on')) return 'poweredOn';
  return 'unknown';
}

function datastoreTypeOf(raw                    )                {
  const value = (raw ?? '').trim().toLowerCase();
  if (value.includes('vsan')) return 'vsan';
  if (value.includes('nfs')) return 'NFS';
  if (value.includes('vmfs')) return 'VMFS';
  if (value.includes('vvol')) return 'vVol';
  return 'other';
}

/** "[datastore] folder/file.vmdk" → its two halves. */
function splitDatastorePath(path                    )                                        {
  if (!path) return {};
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(path);
  return m ? { datastore: m[1], file: m[2] } : { file: path };
}

/** "architecture='X86' bitness='64' prettyName='…'" → a record. */
function parseGuestDetail(raw                    )                                     {
  if (!raw) return undefined;
  const out                         = {};
  for (const m of raw.matchAll(/(\w+)='([^']*)'/g)) out[m[1]          ] = m[2]          ;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Tab signatures, for CSVs whose file name is no help
// ---------------------------------------------------------------------------

/**
 * Headers that identify each tab. A CSV is recognised when it carries all of
 * a tab's signature, which is more robust than trusting a file name — people
 * rename exports, and "Export (3).csv" names nothing.
 */
const SIGNATURES                                          = {
  vInfo: ['powerstate', 'provisioned mib'],
  vCPU: ['cores p/s', 'hot remove'],
  vMemory: ['ballooned', 'swapped', 'consumed overhead'],
  vDisk: ['disk key', 'raw lun id'],
  vPartition: ['consumed mib', 'free %'],
  vNetwork: ['nic label', 'mac address'],
  vCD: ['device node', 'device type', 'starts connected'],
  vUSB: ['ehci enabled'],
  vSnapshot: ['size mib (vmsn)'],
  vTools: ['required version', 'upgradeable'],
  vSource: ['api type', 'product line'],
  vRP: ['resource pool path'],
  vCluster: ['numeffectivehosts'],
  vHost: ['cpu model', 'cores per cpu'],
  vHBA: ['wwn', 'driver', 'pci'],
  vNIC: ['network device', 'uplink port'],
  vSwitch: ['free ports', 'zero copy xmit'],
  vPort: ['port group', 'zero copy xmit'],
  dvSwitch: ['host members', 'lacp mode'],
  dvPort: ['active uplink', 'standby uplink'],
  vSC_VMK: ['subnet mask', 'ip 6 gateway'],
  vDatastore: ['capacity mib', 'provisioned mib', 'siocenabled'],
  vMultiPath: ['path 1 state'],
  vLicense: ['cost unit', 'expiration date'],
  vFileInfo: ['friendly path name'],
  vHealth: ['message type'],
  vMetaData: ['rvtools version'],
};

/** Legacy looser signatures kept for exports older than 4.x. */
function legacySignature(firstLine        )                      {
  const has = (...needles          )          => needles.every((n) => firstLine.includes(n));
  if (has('cpu model', 'cores per cpu')) return 'vHost';
  if (has('capacity mib', 'provisioned mib')) return 'vDatastore';
  if (has('powerstate') && (firstLine.includes('provisioned mib') || firstLine.includes('cpus'))) return 'vInfo';
  if (has('switch', 'vlan')) return 'dvPort';
  if (has('switch', 'connected')) return 'vNetwork';
  if (firstLine.includes('ha enabled') || firstLine.includes('drs enabled')) return 'vCluster';
  return null;
}

/** Which RVTools tab a CSV came from, by its header row. */
export function detectSheet(csv        )                      {
  const firstLine = (csv.split(/\r?\n/)[0] ?? '').toLowerCase();
  const headers = new Set(
    firstLine.split(/[,;\t]/).map((h) => h.replace(/^"|"$/g, '').trim().replace(/\s+/g, ' ')),
  );
  const squashed = new Set([...headers].map((h) => h.replace(/\s/g, '')));
  // vDatastore's "SIOC enabled" is matched without its space.
  for (const tab of RVTOOLS_TABS) {
    const signature = SIGNATURES[tab];
    if (signature.every((h) => headers.has(h) || squashed.has(h.replace(/\s/g, '')))) return tab;
  }
  return legacySignature(firstLine);
}

function guessFromFilename(name        )                      {
  const lower = name.toLowerCase().replace(/\.csv$/, '');
  // Longest names first, so "vPartition" is not taken for "vPort" and
  // "dvSwitch" not for "vSwitch".
  const byLength = [...RVTOOLS_TABS].sort((a, b) => b.length - a.length);
  for (const tab of byLength) {
    const t = tab.toLowerCase();
    if (lower === t || lower.endsWith(`_${t}`) || lower.endsWith(`-${t}`) || lower.endsWith(` ${t}`)) return tab;
  }
  for (const tab of byLength) if (lower.includes(tab.toLowerCase())) return tab;
  return null;
}

// ---------------------------------------------------------------------------
// The importer
// ---------------------------------------------------------------------------

                                                     
                                    
                                        

/**
 * Collects rows from any number of tabs, in any order, into one inventory.
 *
 * vInfo creates the VMs and vHost the hosts; the detail tabs attach to them by
 * (vCenter, VM UUID) and (vCenter, host name). A detail row whose VM was not in
 * vInfo — an export filtered differently per tab — still lands, on a VM record
 * built from what the detail row itself carries.
 */
class Collector {
           vms = new Map                 ();
           hosts = new Map                   ();
           clusters                     = [];
           datastores                       = [];
           networks                     = [];
           vcenters                     = [];
           resourcePools                          = [];
           switches                               = [];
           licenses                     = [];
           health                           = [];
           files                  = [];
           tabs                         = {};
           collected                         = {};
  toolVersion                    ;
           findings            = [];

                   multipath = new Map                                                                                                                ();
                   byName = new Map                 ();

  /** The row handler for a tab, given its header row. */
  consumer(tab              , headers                   )                            {
    const row = new Row(headers);
    const handle = this.handlerFor(tab, row);
    let count = 0;
    this.tabs[tab] = 0;
    return (cells) => {
      row.set(cells);
      handle(row);
      count += 1;
      this.tabs[tab] = count;
    };
  }

          vmKey(r     )                     {
    const id = r.s('VM UUID', 'UUID', 'SMBIOS UUID') ?? r.s('VM ID');
    const name = r.s('VM', 'Name', 'VM Name');
    if (!id && !name) return undefined;
    return scopedKey(r.vcenter(), id ?? `name:${name}`);
  }

  /** The VM a detail row belongs to, creating a bare one if vInfo lacked it. */
          vmFor(r     )                      {
    const key = this.vmKey(r);
    if (!key) return undefined;
    let vm = this.vms.get(key);
    if (!vm) {
      // An older export may carry a UUID on one tab and not another.
      const name = r.s('VM', 'Name', 'VM Name');
      vm = name ? this.byName.get(scopedKey(r.vcenter(), name)) : undefined;
    }
    if (!vm) {
      const name = r.s('VM', 'Name', 'VM Name') ?? key;
      vm = compact({
        name,
        uuid: r.s('VM UUID', 'UUID'),
        vcenter: r.vcenter(),
        powerState: powerStateOf(r.s('Powerstate', 'Power State')),
        template: r.b('Template'),
        srmPlaceholder: r.b('SRM Placeholder'),
        host: r.s('Host'),
        cluster: r.s('Cluster'),
        datacenter: r.s('Datacenter'),
        folder: r.s('Folder'),
        vcpu: 0,
        memoryGib: 0,
        provisionedGib: 0,
      })           ;
      this.vms.set(key, vm);
      this.byName.set(scopedKey(vm.vcenter, name), vm);
    }
    return vm;
  }

          hostFor(r     )                        {
    const name = r.s('Host', 'Name', 'ESX Host');
    if (!name) return undefined;
    const key = scopedKey(r.vcenter(), name);
    let host = this.hosts.get(key);
    if (!host) {
      host = compact({
        name,
        vcenter: r.vcenter(),
        cluster: r.s('Cluster'),
        datacenter: r.s('Datacenter'),
        cpuSockets: 0,
        coresPerSocket: 0,
        totalCores: 0,
        memoryGib: 0,
      })             ;
      this.hosts.set(key, host);
    }
    return host;
  }

          handlerFor(tab              , r     )                   {
    switch (tab) {
      case 'vInfo':
        return this.vInfo(r);
      case 'vCPU':
        return (row) => {
          const vm = this.vmFor(row);
          if (!vm) return;
          vm.cpu = compact             ({
            sockets: row.n('Sockets'),
            coresPerSocket: row.n('Cores p/s'),
            maxMhz: row.n('Max'),
            overallMhz: row.n('Overall'),
            sharesLevel: row.s('Level'),
            shares: row.n('Shares'),
            reservationMhz: row.n('Reservation'),
            limitMhz: row.limit('Limit'),
            entitlementMhz: row.n('Entitlement'),
            hotAdd: row.b('Hot Add'),
            hotRemove: row.b('Hot Remove'),
            numaHotAddExposed: row.b('Numa Hotadd Exposed'),
          });
          if (vm.coresPerSocket === undefined && vm.cpu.coresPerSocket !== undefined) {
            vm.coresPerSocket = vm.cpu.coresPerSocket;
          }
          if (!vm.vcpu) vm.vcpu = row.n('CPUs') ?? 0;
        };
      case 'vMemory':
        return (row) => {
          const vm = this.vmFor(row);
          if (!vm) return;
          vm.memory = compact                ({
            sizeGib: row.gib('Size MiB'),
            lockedToMax: row.b('Memory Reservation Locked To Max'),
            overheadMib: row.n('Overhead'),
            consumedGib: row.gib('Consumed'),
            privateGib: row.gib('Private'),
            sharedGib: row.gib('Shared'),
            swappedGib: row.gib('Swapped'),
            balloonedGib: row.gib('Ballooned'),
            activeGib: row.gib('Active'),
            entitlementGib: row.gib('Entitlement'),
            sharesLevel: row.s('Level'),
            reservationGib: row.gib('Reservation'),
            limitGib: (() => {
              const l = row.limit('Limit');
              return l === undefined ? undefined : mibToGib(l);
            })(),
            hotAdd: row.b('Hot Add'),
          });
          if (!vm.memoryGib && vm.memory.sizeGib) vm.memoryGib = vm.memory.sizeGib;
        };
      case 'vDisk':
        return (row) => {
          const vm = this.vmFor(row);
          if (!vm) return;
          const raw = row.b('Raw') ?? false;
          const where = splitDatastorePath(row.s('Path', 'Disk Path'));
          const disk = compact        ({
            label: row.s('Disk') ?? `disk ${(vm.disks?.length ?? 0) + 1}`,
            key: row.s('Disk Key'),
            uuid: row.s('Disk UUID'),
            capacityGib: row.gib('Capacity MiB') ?? 0,
            raw,
            rawCompatibilityMode: raw ? row.s('Raw Comp. Mode') : undefined,
            rawLunId: raw ? row.s('Raw LUN ID') : undefined,
            mode: row.s('Disk Mode'),
            sharing: row.s('Sharing mode'),
            thin: row.b('Thin'),
            eagerlyScrub: row.b('Eagerly Scrub'),
            split: row.b('Split'),
            writeThrough: row.b('Write Through'),
            sharesLevel: row.s('Level'),
            iopsLimit: row.limit('Limit'),
            controller: row.s('Controller'),
            unit: row.s('Unit #'),
            sharedBus: row.s('Shared Bus'),
            datastore: where.datastore,
            file: where.file,
          });
          (vm.disks ??= []).push(disk);
          if (raw) vm.rdmGib = (vm.rdmGib ?? 0) + disk.capacityGib;
        };
      case 'vPartition':
        return (row) => {
          const vm = this.vmFor(row);
          if (!vm) return;
          (vm.partitions ??= []).push(
            compact             ({
              mount: row.s('Disk') ?? '?',
              diskKey: row.s('Disk Key'),
              capacityGib: row.gib('Capacity MiB') ?? 0,
              consumedGib: row.gib('Consumed MiB') ?? 0,
              freeGib: row.gib('Free MiB') ?? 0,
            }),
          );
        };
      case 'vNetwork':
        return (row) => {
          const vm = this.vmFor(row);
          if (!vm) return;
          const nic = compact       ({
            label: row.s('NIC label') ?? `NIC ${(vm.nics?.length ?? 0) + 1}`,
            adapter: row.s('Adapter'),
            network: row.s('Network'),
            switchName: row.s('Switch'),
            connected: row.b('Connected'),
            startsConnected: row.b('Starts Connected'),
            mac: row.s('Mac Address'),
            macType: row.s('Type'),
            ipv4: row.list('IPv4 Address'),
            ipv6: row.list('IPv6 Address'),
            directPathIo: row.b('Direct Path IO'),
          });
          (vm.nics ??= []).push(nic);
          // IPv4 first, so the first address stays the one most tools expect; IPv6 kept too.
          if (nic.ipv4 || nic.ipv6) vm.ipAddresses = [...new Set([...(vm.ipAddresses ?? []), ...(nic.ipv4 ?? []), ...(nic.ipv6 ?? [])])];
        };
      case 'vCD':
      case 'vUSB':
        return (row) => {
          const vm = this.vmFor(row);
          if (!vm) return;
          const device = compact          ({
            node: row.s('Device Node') ?? '?',
            type: row.s('Device Type', 'Family'),
            connected: row.b('Connected'),
            startsConnected: row.b('Starts Connected', 'Auto connect'),
          });
          if (tab === 'vCD') (vm.cdroms ??= []).push(device);
          else (vm.usbDevices ??= []).push(device);
        };
      case 'vSnapshot':
        return (row) => {
          const vm = this.vmFor(row);
          if (!vm) return;
          const snap = compact            ({
            name: row.s('Name') ?? 'snapshot',
            description: row.s('Description'),
            createdAt: row.date('Date / time'),
            sizeGib: row.gib('Size MiB (total)', 'Size MiB (vmsn)'),
            quiesced: row.b('Quiesced'),
            state: row.s('State'),
          });
          (vm.snapshots ??= []).push(snap);
          vm.snapshotCount = vm.snapshots.length;
          vm.snapshotGib = (vm.snapshotGib ?? 0) + (snap.sizeGib ?? 0);
        };
      case 'vTools':
        return (row) => {
          const vm = this.vmFor(row);
          if (!vm) return;
          const upgradeable = row.s('Upgradeable');
          vm.tools = compact               ({
            status: row.s('Tools'),
            version: row.s('Tools Version'),
            requiredVersion: row.s('Required Version'),
            upgradeable: upgradeable === undefined ? undefined : /^y/i.test(upgradeable),
            upgradePolicy: row.s('Upgrade Policy'),
            syncTime: row.b('Sync time'),
            appStatus: row.s('App status'),
            heartbeatStatus: row.s('Heartbeat status'),
            kernelCrashState: row.s('Kernel Crash state'),
            operationReady: row.b('Operation Ready'),
            interactiveGuestReady: row.b('Interactive Guest'),
          });
          vm.toolsStatus ??= vm.tools.status;
          vm.toolsVersion ??= vm.tools.version;
          vm.hardwareVersion ??= row.s('VM Version');
        };
      case 'vHost':
        return this.vHost();
      case 'vHBA':
        return (row) => {
          const host = this.hostFor(row);
          if (!host) return;
          (host.hbas ??= []).push(
            compact                ({
              name: row.s('Device') ?? '?',
              type: row.s('Type'),
              model: row.s('Model'),
              driver: row.s('Driver'),
              status: row.s('Status'),
              wwn: row.s('WWN'),
            }),
          );
        };
      case 'vNIC':
        return (row) => {
          const host = this.hostFor(row);
          if (!host) return;
          const duplex = row.s('Duplex');
          (host.physicalNics ??= []).push(
            compact             ({
              name: row.s('Network Device') ?? '?',
              speedMb: row.n('Speed'),
              mac: row.s('MAC'),
              driver: row.s('Driver'),
              // RVTools writes "Link is down!" in the duplex column for a dead link.
              linkUp: duplex === undefined ? undefined : !/down/i.test(duplex),
              switchName: row.s('Switch'),
            }),
          );
        };
      case 'vSC_VMK':
        return (row) => {
          const host = this.hostFor(row);
          if (!host) return;
          (host.vmkernelAdapters ??= []).push(
            compact                 ({
              name: row.s('Device') ?? '?',
              ip: row.s('IP Address'),
              subnetMask: row.s('Subnet mask'),
              mac: row.s('Mac Address'),
              mtu: row.n('MTU'),
              portGroup: row.s('Port Group'),
              gateway: row.s('Gateway'),
              dhcp: row.b('DHCP'),
              ipv6: row.s('IP 6 Address'),
            }),
          );
        };
      case 'vSwitch':
        return (row) => {
          const host = this.hostFor(row);
          if (!host) return;
          (host.standardSwitches ??= []).push(
            compact                ({
              name: row.s('Switch') ?? '?',
              ports: row.n('# Ports'),
              freePorts: row.n('Free Ports'),
              mtu: row.n('MTU'),
              promiscuous: row.b('Promiscuous Mode'),
              macChanges: row.b('Mac Changes'),
              forgedTransmits: row.b('Forged Transmits'),
              teamingPolicy: row.s('Policy'),
            }),
          );
        };
      case 'vPort':
        return (row) => {
          const host = this.hostFor(row);
          const name = row.s('Port Group');
          if (!host || !name) return;
          const pg = compact                  ({
            name,
            kind: 'standard',
            host: host.name,
            vcenter: row.vcenter(),
            datacenter: row.s('Datacenter'),
            switchName: row.s('Switch'),
            vlanId: row.n('VLAN') ?? row.s('VLAN'),
            teamingPolicy: row.s('Policy'),
            promiscuous: row.b('Promiscuous Mode'),
            macChanges: row.b('Mac Changes'),
            forgedTransmits: row.b('Forged Transmits'),
          });
          (host.portGroups ??= []).push(pg);
          this.networks.push(pg);
        };
      case 'dvSwitch':
        return (row) => {
          const name = row.s('Switch');
          if (!name) return;
          const lacp = row.s('LACP Name');
          this.switches.push(
            compact                            ({
              name,
              vcenter: row.vcenter(),
              datacenter: row.s('Datacenter'),
              vendor: row.s('Vendor'),
              version: row.s('Version'),
              hostMembers: row.list('Host members'),
              maxPorts: row.n('Max Ports'),
              ports: row.n('# Ports'),
              vmCount: row.n('# VMs'),
              maxMtu: row.n('Max MTU'),
              discoveryProtocol: [row.s('CDP Type'), row.s('CDP Operation')].filter(Boolean).join(' ') || undefined,
              lacp: lacp ? [lacp, row.s('LACP Mode'), row.s('LACP Load Balance Alg.')].filter(Boolean).join(', ') : undefined,
              objectId: row.s('Object ID'),
            }),
          );
        };
      case 'dvPort':
        return (row) => {
          const name = row.s('Port', 'Network', 'Portgroup');
          if (!name) return;
          this.networks.push(
            compact                  ({
              name,
              kind: 'distributed',
              vcenter: row.vcenter(),
              switchName: row.s('Switch'),
              vlanId: row.n('VLAN') ?? row.s('VLAN'),
              type: row.s('Type'),
              ports: row.n('# Ports'),
              activeUplinks: row.list('Active Uplink'),
              standbyUplinks: row.list('Standby Uplink'),
              teamingPolicy: row.s('Policy'),
              promiscuous: row.b('Allow Promiscuous'),
              macChanges: row.b('Mac Changes'),
              forgedTransmits: row.b('Forged Transmits'),
              blocked: row.b('Blocked'),
              objectId: row.s('Object ID'),
            }),
          );
        };
      case 'vDatastore':
        return (row) => {
          const name = row.s('Name', 'Datastore');
          if (!name) return;
          const capacityGib = row.gib('Capacity MiB', 'Capacity MB', 'Capacity') ?? 0;
          const free = row.gib('Free MiB', 'Free MB', 'Free Space MiB');
          const inUse = row.gib('In Use MiB', 'In Use MB');
          const typeDetail = row.s('Type');
          this.datastores.push(
            compact                    ({
              name,
              vcenter: row.vcenter(),
              type: datastoreTypeOf(typeDetail),
              typeDetail,
              capacityGib,
              freeGib: free ?? (inUse !== undefined ? Math.max(0, capacityGib - inUse) : 0),
              provisionedGib: row.gib('Provisioned MiB', 'Provisioned MB'),
              inUseGib: inUse,
              hostCount: row.n('# Hosts', 'Hosts'),
              hosts: row.has('Hosts') && row.has('# Hosts') ? row.list('Hosts') : undefined,
              cluster: row.s('Cluster name'),
              datastoreClusterCapacityGib: row.gib('Cluster capacity MiB'),
              datastoreClusterFreeGib: row.gib('Cluster free space MiB'),
              configStatus: row.s('Config status'),
              address: row.s('Address'),
              accessible: row.b('Accessible'),
              vmCount: row.n('# VMs'),
              vmCountTotal: row.n('# VMs total'),
              siocEnabled: row.b('SIOC enabled'),
              siocThreshold: row.s('SIOC Threshold'),
              blockSizeMb: row.n('Block size'),
              extents: row.n('# Extents'),
              majorVersion: row.n('Major Version'),
              version: row.s('Version'),
              vmfsUpgradeable: row.b('VMFS Upgradeable'),
              url: row.s('URL'),
              objectId: row.s('Object ID'),
            }),
          );
        };
      case 'vCluster':
        return (row) => {
          const name = row.s('Name', 'Cluster');
          if (!name) return;
          this.clusters.push(
            compact                  ({
              name,
              vcenter: row.vcenter(),
              datacenter: row.s('Datacenter'),
              haEnabled: row.b('HA enabled', 'HAEnabled'),
              drsEnabled: row.b('DRS enabled', 'DrsEnabled'),
              drsAutomationLevel: row.s('DRS default VM behavior', 'DRS Automation Level'),
              evcMode: row.s('Current EVC Mode', 'EVC Mode'),
              vsanEnabled: row.b('VSAN enabled', 'vSAN enabled'),
              hostCount: row.n('NumHosts', '# Hosts', 'Hosts'),
              objectId: row.s('Object ID'),
              configStatus: row.s('Config status'),
              overallStatus: row.s('OverallStatus'),
              effectiveHostCount: row.n('numEffectiveHosts'),
              totalCpuMhz: row.n('TotalCpu'),
              cores: row.n('NumCpuCores'),
              threads: row.n('NumCpuThreads'),
              effectiveCpuMhz: row.n('Effective Cpu'),
              totalMemoryGib: row.gib('TotalMemory'),
              effectiveMemoryGib: row.gib('Effective Memory'),
              vmotions: row.n('Num VMotions'),
              haFailoverLevel: row.n('Failover Level'),
              haAdmissionControl: row.b('AdmissionControlEnabled'),
              haHostMonitoring: row.s('Host monitoring'),
              haHeartbeatDatastorePolicy: row.s('HB Datastore Candidate Policy'),
              haIsolationResponse: row.s('Isolation Response'),
              haRestartPriority: row.s('Restart Priority'),
              haVmMonitoring: row.s('VM Monitoring'),
              haSettings: row.s('Cluster Settings'),
              drsVmotionRate: row.n('DRS vmotion rate'),
              dpmEnabled: row.b('DPM enabled'),
              dpmBehavior: row.s('DPM default behavior'),
            }),
          );
        };
      case 'vRP':
        return (row) => {
          const name = row.s('Resource Pool name');
          if (!name) return;
          const memLimit = row.limit('Mem limit');
          this.resourcePools.push(
            compact                       ({
              name,
              path: row.s('Resource Pool path'),
              vcenter: row.vcenter(),
              status: row.s('Status'),
              vmCount: row.n('# VMs'),
              vmCountTotal: row.n('# VMs total'),
              vcpus: row.n('# vCPUs'),
              cpuReservationMhz: row.n('CPU reservation'),
              cpuLimitMhz: row.limit('CPU limit'),
              cpuSharesLevel: row.s('CPU level'),
              cpuExpandable: row.b('CPU expandableReservation'),
              cpuUsageMhz: row.n('CPU overallUsage'),
              memoryConfiguredGib: row.gib('Mem Configured'),
              memoryReservationGib: row.gib('Mem reservation'),
              memoryLimitGib: memLimit === undefined ? undefined : mibToGib(memLimit),
              memorySharesLevel: row.s('Mem level'),
              memoryExpandable: row.b('Mem expandableReservation'),
              memoryUsageGib: row.gib('QS hostMemoryUsage'),
              objectId: row.s('Object ID'),
            }),
          );
        };
      case 'vSource':
        return (row) => {
          const name = row.vcenter();
          if (!name) return;
          this.vcenters.push(
            compact                  ({
              name,
              uuid: row.s('VI SDK UUID'),
              fullName: row.s('Fullname'),
              version: row.s('Version'),
              build: row.s('Build'),
              apiVersion: row.s('API version'),
              osType: row.s('OS type'),
              productLine: row.s('Product line'),
            }),
          );
        };
      case 'vMultiPath':
        return (row) => {
          const host = this.hostFor(row);
          if (!host) return;
          const key = scopedKey(host.vcenter, host.name);
          let summary = this.multipath.get(key);
          if (!summary) {
            summary = { devices: new Map(), dead: 0, policies: {}, vendors: new Set() };
            this.multipath.set(key, summary);
          }
          let paths = 0;
          for (let i = 1; i <= 8; i += 1) {
            if (!row.s(`Path ${i}`)) continue;
            paths += 1;
            const state = row.s(`Path ${i} state`) ?? '';
            if (state && !/active|standby|on/i.test(state)) summary.dead += 1;
          }
          const device = row.s('Disk') ?? row.s('Display name') ?? `#${summary.devices.size}`;
          summary.devices.set(device, Math.max(summary.devices.get(device) ?? 0, paths));
          const policy = row.s('Policy');
          if (policy) summary.policies[policy] = (summary.policies[policy] ?? 0) + 1;
          const vendor = row.s('Vendor');
          if (vendor) summary.vendors.add(vendor.trim());
        };
      case 'vLicense':
        return (row) => {
          const name = row.s('Name');
          if (!name) return;
          const key = row.s('Key');
          this.licenses.push(
            compact                  ({
              name,
              keyTail: key ? key.replace(/[^A-Za-z0-9]/g, '').slice(-5) : undefined,
              vcenter: row.vcenter(),
              costUnit: row.s('Cost Unit'),
              total: row.n('Total'),
              used: row.n('Used'),
              expires: row.date('Expiration Date'),
              features: row.s('Features')?.replace(/(,\s*)+$/, ''),
            }),
          );
        };
      case 'vHealth':
        return (row) => {
          const message = row.s('Message');
          if (!message) return;
          this.health.push(
            compact                        ({
              subject: row.s('Name') ?? '',
              message,
              type: row.s('Message type'),
              vcenter: row.vcenter(),
            }),
          );
        };
      case 'vFileInfo':
        return (row) => {
          const name = row.s('File Name');
          // With file collection switched off, the tab holds one row of advice.
          if (!name) return;
          this.files.push(
            compact               ({
              path: row.s('Path', 'Friendly Path Name') ?? name,
              name,
              type: row.s('File Type'),
              sizeBytes: row.n('File Size in bytes'),
              vcenter: row.vcenter(),
            }),
          );
        };
      case 'vMetaData':
        return (row) => {
          this.toolVersion ??= row.s('RVTools version');
          const server = row.s('Server');
          const when = row.date('xlsx creation datetime');
          if (server && when) this.collected[server] = when;
        };
      default:
        return () => undefined;
    }
  }

          vInfo(header     )                   {
    // Custom attributes sit between Annotation and Datacenter, named by the
    // vCenter's admins. Everything in that span is one.
    const headers = header.headers;
    const from = headers.findIndex((h) => normalize(h) === 'annotation');
    const to = headers.findIndex((h, i) => i > from && normalize(h) === 'datacenter');
    const attributeColumns =
      from >= 0 && to > from ? headers.slice(from + 1, to).map((h, i) => ({ name: h.trim(), index: from + 1 + i })) : [];
    const networkColumns = headers
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => /^network\s*#\d+$/i.test(h.trim()))
      .map(({ i }) => i);

    return (row) => {
      const name = row.s('VM', 'Name', 'VM Name');
      if (!name) return;
      const vm = this.vmFor(row);
      if (!vm) return;

      const customAttributes                         = {};
      for (const { name: attr, index } of attributeColumns) {
        const v = row.at(index);
        if (v) customAttributes[attr] = v;
      }
      const networks = networkColumns.map((i) => row.at(i)).filter(Boolean);
      const memoryMib = row.n('Memory', 'Memory MiB', 'Memory MB');
      const provisioned = row.gib('Provisioned MiB', 'Provisioned MB', 'Provisioned');
      const used = row.gib('In Use MiB', 'In Use MB', 'In Use');
      const vmx = splitDatastorePath(row.s('Path'));

      Object.assign(
        vm,
        compact({
          name,
          uuid: row.s('VM UUID', 'UUID'),
          smbiosUuid: row.s('SMBIOS UUID'),
          vmId: row.s('VM ID'),
          vcenter: row.vcenter(),
          powerState: powerStateOf(row.s('Powerstate', 'Power State', 'PowerState')),
          template: row.b('Template'),
          srmPlaceholder: row.b('SRM Placeholder'),
          configStatus: row.s('Config status'),
          dnsName: row.s('DNS Name'),
          connectionState: row.s('Connection state'),
          guestState: row.s('Guest state'),
          heartbeat: row.s('Heartbeat'),
          consolidationNeeded: row.b('Consolidation Needed'),
          poweredOnAt: row.date('PowerOn'),
          createdAt: row.date('Creation date'),
          host: row.s('Host', 'ESX Host'),
          cluster: row.s('Cluster'),
          datacenter: row.s('Datacenter'),
          vcpu: row.n('CPUs', 'CPU', '# vCPUs', 'NumCpu') ?? 0,
          coresPerSocket: row.n('Cores p/s', 'Cores per Socket'),
          cpuReadyPct: row.n('Overall Cpu Readiness'),
          memoryGib: memoryMib === undefined ? 0 : mibToGib(memoryMib),
          activeMemoryGib: row.gib('Active Memory'),
          nicCount: row.n('NICs'),
          diskCount: row.n('Disks'),
          totalDiskGib: row.gib('Total disk capacity MiB'),
          passthroughHotplug: row.b('Fixed Passthru HotPlug'),
          minEvcMode: row.s('min Required EVC Mode Key'),
          latencySensitivity: row.s('Latency Sensitivity'),
          enableUuid: row.b('EnableUUID'),
          changedBlockTracking: row.b('CBT'),
          ipAddress: row.s('Primary IP Address', 'IP Address'),
          networks: networks.length > 0 ? networks : undefined,
          monitors: row.n('Num Monitors'),
          videoRamKib: row.n('Video Ram KiB'),
          resourcePool: row.s('Resource pool'),
          folderId: row.s('Folder ID'),
          folder: row.s('Folder'),
          vApp: row.s('vApp'),
          haProtected: row.b('DAS protection'),
          ftState: row.s('FT State'),
          ftRole: row.s('FT Role'),
          provisionedGib: provisioned ?? 0,
          usedGib: used,
          unsharedGib: row.gib('Unshared MiB'),
          haRestartPriority: row.s('HA Restart Priority'),
          haIsolationResponse: row.s('HA Isolation Response'),
          haVmMonitoring: row.s('HA VM Monitoring'),
          clusterRules: row.list('Cluster rule(s)'),
          clusterRuleNames: row.list('Cluster rule name(s)'),
          bootDelayMs: row.n('Boot delay'),
          efiSecureBoot: row.b('EFI Secure boot'),
          firmware: row.s('Firmware'),
          hardwareVersion: row.s('HW version', 'Hardware Version'),
          hwUpgradeStatus: row.s('HW upgrade status'),
          hwUpgradePolicy: row.s('HW upgrade policy'),
          vmxPath: row.s('Path'),
          datastores: vmx.datastore ? [vmx.datastore] : undefined,
          annotation: row.s('Annotation'),
          customAttributes: Object.keys(customAttributes).length > 0 ? customAttributes : undefined,
          guestOs: row.s('OS according to the configuration file', 'Guest OS', 'OS') ?? row.s('OS according to the VMware Tools'),
          guestOsTools: row.s('OS according to the VMware Tools'),
          customizationInfo: row.s('Customization Info'),
          guestDetail: parseGuestDetail(row.s('Guest Detailed Data')),
          toolsVersion: row.s('Tools version', 'VM Tools Version'),
          toolsStatus: row.s('Tools', 'Tools Status'),
        }),
      );
      this.byName.set(scopedKey(vm.vcenter, name), vm);
    };
  }

          vHost()                   {
    return (row) => {
      const host = this.hostFor(row);
      if (!host) return;
      const sockets = row.n('# CPU', 'CPU', 'Sockets', 'NumCpuPackages') ?? 0;
      const coresPerSocket = row.n('Cores per CPU', 'Cores p/CPU', 'CoresPerSocket') ?? 0;
      const totalCores = row.n('# Cores', 'Cores', 'NumCpuCores') ?? sockets * coresPerSocket;
      const cpuPct = row.n('CPU usage %', 'CPU usage');
      const memPct = row.n('Memory usage %', 'Memory usage');
      const htActive = row.b('HT Active');
      const licence = row.s('Assigned License(s)');
      const issuer = row.s('Certificate Issuer');

      Object.assign(
        host,
        compact({
          cluster: row.s('Cluster'),
          datacenter: row.s('Datacenter'),
          vendor: row.s('Vendor'),
          model: row.s('Model'),
          cpuModel: row.s('CPU Model', 'ProcessorType'),
          cpuSockets: sockets,
          coresPerSocket,
          totalCores,
          // RVTools gives no thread count; with HT active it is two per core.
          threads: htActive === undefined ? undefined : htActive ? totalCores * 2 : totalCores,
          hyperthreadingActive: htActive,
          hyperthreadingAvailable: row.b('HT Available'),
          cpuSpeedMhz: row.n('Speed', 'CPU Speed'),
          memoryGib: row.gib('# Memory', 'Memory', 'Memory MiB', 'Memory MB') ?? 0,
          cpuUsage: cpuPct === undefined ? undefined : cpuPct / 100,
          memoryUsage: memPct === undefined ? undefined : memPct / 100,
          nicCount: row.n('# NICs', '#NICs', 'NICs', 'Num NICs'),
          hbaCount: row.n('# HBAs'),
          esxVersion: row.s('ESX Version', 'Version'),
          configStatus: row.s('Config status'),
          connectionState: row.s('Connection State') ?? row.s('Config status'),
          complianceState: row.s('Compliance Check State'),
          inMaintenanceMode: row.b('in Maintenance Mode'),
          inQuarantineMode: row.b('in Quarantine Mode'),
          vsanFaultDomain: row.s('vSAN Fault Domain Name'),
          memoryTieringType: row.s('Memory Tiering Type'),
          vmCountTotal: row.n('# VMs total'),
          vmCount: row.n('# VMs'),
          vmsPerCore: row.n('VMs per Core'),
          allocatedVcpu: row.n('# vCPUs', 'vCPUs'),
          vcpusPerCore: row.n('vCPUs per Core'),
          allocatedMemoryGib: row.gib('vRAM', 'VM Memory'),
          vmUsedMemoryGib: row.gib('VM Used memory'),
          vmSwappedGib: row.gib('VM Memory Swapped'),
          vmBalloonedGib: row.gib('VM Memory Ballooned'),
          vmotionSupported: row.b('VMotion support'),
          storageVmotionSupported: row.b('Storage VMotion support'),
          currentEvcMode: row.s('Current EVC'),
          maxEvcMode: row.s('Max EVC'),
          // A licence key is a credential; only enough of it to tell keys apart.
          licenseKey: licence
            ? licence
                .split(/\s*,\s*/)
                .map((k) => `…${k.replace(/[^A-Za-z0-9]/g, '').slice(-5)}`)
                .join(', ')
            : undefined,
          atsHeartbeat: row.b('ATS Heartbeat'),
          atsLocking: row.b('ATS Locking'),
          cpuPowerPolicy: row.s('Current CPU power man. policy'),
          hostPowerPolicy: row.s('Host Power Policy'),
          bootTime: row.date('Boot time'),
          dnsServers: row.list('DNS Servers'),
          dhcp: row.b('DHCP'),
          domain: row.s('Domain'),
          dnsSearchDomains: row.list('DNS Search Order', 'Domain List'),
          ntpServers: row.list('NTP Server(s)'),
          ntpRunning: row.b('NTPD running'),
          timeZone: row.s('Time Zone Name', 'Time Zone'),
          serialNumber: row.s('Serial number'),
          serviceTag: row.s('Service tag'),
          oemString: row.s('OEM specific string'),
          biosVendor: row.s('BIOS Vendor'),
          biosVersion: row.s('BIOS Version'),
          biosDate: row.date('BIOS Date'),
          certificate: issuer
            ? compact({
                issuer,
                subject: row.s('Certificate Subject'),
                validFrom: row.date('Certificate Start Date'),
                expires: row.date('Certificate Expiry Date'),
                status: row.s('Certificate Status'),
              })
            : undefined,
          objectId: row.s('Object ID'),
          uuid: row.s('UUID'),
        }),
      );
    };
  }

  /** Assemble the inventory once every tab has been read. */
  finish(label                    , collectedAt                    )               {
    for (const [key, summary] of this.multipath) {
      const host = this.hosts.get(key);
      if (!host) continue;
      const devices = [...summary.devices.values()];
      host.storagePaths = {
        devices: devices.length,
        singlePathDevices: devices.filter((p) => p > 0 && p < 2).length,
        deadPaths: summary.dead,
        policies: summary.policies,
        vendors: [...summary.vendors].sort(),
      }                             ;
    }

    // Cluster datacenters come from their hosts; vCluster has no such column.
    const dcByCluster = new Map                ();
    for (const h of this.hosts.values()) {
      if (h.cluster && h.datacenter) dcByCluster.set(scopedKey(h.vcenter, h.cluster), h.datacenter);
    }
    const clusters = this.clusters.map((c) =>
      c.datacenter ? c : compact({ ...c, datacenter: dcByCluster.get(scopedKey(c.vcenter, c.name)) }),
    );

    const hosts = [...this.hosts.values()]                   ;
    const vms = [...this.vms.values()]                 ;
    this.checks(hosts, vms);

    const firstCollected = Object.values(this.collected).sort()[0];
    const inventory            = {
      ...emptyInventory(
        compact({
          kind: 'rvtools'         ,
          label,
          collectedAt: collectedAt ?? firstCollected,
          toolVersion: this.toolVersion ? `RVTools ${this.toolVersion}` : undefined,
          collectedPerVcenter: Object.keys(this.collected).length > 0 ? this.collected : undefined,
          tabs: this.tabs,
          notes: [`Imported tabs: ${Object.keys(this.tabs).join(', ') || 'none'}`],
        }),
      ),
      hosts,
      vms,
      clusters,
      datastores: this.datastores,
      networks: this.networks,
      vcenters: this.vcenters,
      resourcePools: this.resourcePools,
      distributedSwitches: this.switches,
      licenses: this.licenses,
      health: this.health,
      files: this.files,
    };
    return { inventory, findings: this.findings };
  }

          checks(hosts                 , vms               )       {
    const findings = this.findings;
    if (hosts.length === 0 && vms.length === 0) {
      findings.push(
        warning(
          'inventory.rvtools.no-data',
          'No hosts or VMs were imported. Check that the export includes the vHost and vInfo tabs.',
          { source: 'RVTools import' },
        ),
      );
    }
    if (hosts.length === 0 && vms.length > 0) {
      findings.push(
        warning(
          'inventory.rvtools.no-hosts',
          'VMs were imported but no hosts. Capacity and consolidation analysis needs the vHost tab.',
          { remediation: 'Import the whole RVTools workbook, or the vHost tab alongside vInfo.' },
        ),
      );
    }
    // A host row with no core count makes every downstream calculation wrong,
    // so it is called out rather than silently contributing zero.
    const noCores = hosts.filter((h) => h.totalCores === 0 && this.tabs.vHost !== undefined);
    if (noCores.length > 0) {
      findings.push(
        warning(
          'inventory.rvtools.hosts-missing-cores',
          `${noCores.length} host(s) have no core count and will contribute nothing to capacity totals.`,
          { path: 'vHost', remediation: 'Check the "# Cores" and "Cores per CPU" columns in the export.' },
        ),
      );
    }
    const inVinfo = vms.filter((v) => v.provisionedGib > 0 || v.usedGib !== undefined);
    if (inVinfo.length > 0 && inVinfo.every((v) => v.usedGib === undefined)) {
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
          'RVTools captures point-in-time CPU and memory figures only, with no historical peak. Supplement with VCF Operations or Get-Stat time series before sizing bursty workloads.',
          { source: 'RVTools data model' },
        ),
      );
    }
    // A capture in the small hours sees the estate at its quietest.
    const hours = Object.values(this.collected)
      .map((iso) => Number(/T(\d\d):/.exec(iso)?.[1]))
      .filter((h) => Number.isFinite(h));
    if (hours.length > 0 && hours.every((h) => h >= 0 && h < 6)) {
      findings.push(
        warning(
          'inventory.rvtools.off-hours-capture',
          `The export was collected between ${String(Math.min(...hours)).padStart(2, '0')}:00 and ${String(Math.max(...hours) + 1).padStart(2, '0')}:00, when most estates are idle. CPU, active memory and CPU-ready figures will read low.`,
          { remediation: 'Size on allocation, or on a 30-day peak from VCF Operations, not on the utilisation in this export.' },
        ),
      );
    }
    const rdmVms = vms.filter((v) => (v.rdmGib ?? 0) > 0);
    if (rdmVms.length > 0) {
      findings.push(
        info(
          'inventory.rvtools.rdm',
          `${rdmVms.length} VM(s) map raw LUNs. RVTools counts an RDM in every VM that maps it; here each LUN is counted once, separately from VMDK storage.`,
          { remediation: 'RDMs do not move with Storage vMotion to vSAN or to a cloud. Plan them as storage migrations of their own.' },
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function feedCsv(collector           , tab              , csv        )       {
  const table = parseCsv(csv);
  const consume = collector.consumer(tab, table.headers);
  for (const row of table.rows) consume(row);
}

/** Import one or more RVTools tabs, each as CSV text. */
export function importRvTools(input              )               {
  const collector = new Collector();
  // vInfo and vHost first, so detail tabs attach to fully described records.
  const order = [...RVTOOLS_TABS].sort((a, b) => rank(a) - rank(b));
  for (const tab of order) {
    const csv = input.sheets[tab];
    if (csv) feedCsv(collector, tab, csv);
  }
  return collector.finish(input.label, input.collectedAt);
}

function rank(tab              )         {
  return tab === 'vInfo' ? 0 : tab === 'vHost' ? 1 : 2;
}

/**
 * Import the RVTools workbook as RVTools writes it.
 *
 * Tabs are read one at a time, each streamed, so a workbook whose vDisk tab is
 * 150 MB of XML never has to fit in memory as text.
 */
export async function importRvToolsWorkbook(
  data                          ,
  options                                                               = {},
)                        {
  const workbook = await openXlsx(data);
  const collector = new Collector();
  const known = new Set        (RVTOOLS_TABS);
  const tabs = workbook.sheets.filter((s) => known.has(s))                  ;
  tabs.sort((a, b) => rank(a) - rank(b));

  if (tabs.length === 0) {
    collector.findings.push(
      warning(
        'inventory.rvtools.not-rvtools',
        `This workbook has no RVTools tabs (it has ${workbook.sheets.slice(0, 6).join(', ')}${workbook.sheets.length > 6 ? '…' : ''}).`,
        { remediation: 'Export from RVTools with File → Export all to xlsx, and import that file as it is.' },
      ),
    );
  }

  let done = 0;
  for (const tab of tabs) {
    options.onProgress?.({ tab, done, total: tabs.length });
    let consume                                     = null;
    await workbook.rows(tab, (cells, index) => {
      if (index === 0) {
        consume = collector.consumer(tab, cells);
        return;
      }
      consume?.(cells);
    });
    done += 1;
  }
  options.onProgress?.({ tab: '', done, total: tabs.length });

  const unknown = workbook.sheets.filter((s) => !known.has(s));
  const result = collector.finish(options.label, undefined);
  if (unknown.length > 0 && tabs.length > 0) {
    return {
      inventory: result.inventory,
      findings: [
        ...result.findings,
        info('inventory.rvtools.extra-tabs', `Tabs not from RVTools were left alone: ${unknown.join(', ')}.`),
      ],
    };
  }
  return result;
}

/**
 * Import files whose tab identity is unknown: the workbook itself, or CSVs
 * recognised by their headers.
 */
export function importRvToolsFiles(
  files                                              ,
  label         ,
)               {
  const sheets                                        = {};
  const unrecognised           = [];

  for (const file of files) {
    const sheet = detectSheet(file.content) ?? guessFromFilename(file.name);
    if (sheet) sheets[sheet] = file.content;
    else unrecognised.push(file.name);
  }

  const result = importRvTools({ sheets, label: label ?? files.map((f) => f.name).join(', ') });
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
            'Import the RVTools .xlsx as it is, or export its tabs as CSV with their header rows intact.',
        },
      ),
    ],
  };
}

export { looksLikeXlsx };
