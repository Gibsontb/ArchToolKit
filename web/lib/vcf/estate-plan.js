/**
 * From an imported estate to a VCF design: which domains, which clusters, how
 * many hosts.
 *
 * The sizing engine answers "will this cluster run this", one cluster at a
 * time. An estate of sixty clusters behind thirteen vCenters needs the step
 * before that: what the VCF fleet should look like at all. This does that
 * step, and hands the management domain to the sizing engine as an ordinary
 * `SizingInput`, so the page the architect already knows does the rest.
 *
 * The rules, each of which someone will ask about:
 *
 *  - **Demand is what runs.** vCPU and memory come from powered-on workload VMs
 *    — not templates, not SRM placeholders, not powered-off VMs unless asked.
 *    Storage counts everything on disk, powered off or not, because it still
 *    has to land somewhere.
 *  - **Memory is allocated, not active.** RVTools' active memory is a moment,
 *    usually 2 AM. Allocation is what the target must be able to hold.
 *  - **Storage is consumed VMDK,** with raw device mappings set apart: an RDM
 *    is a LUN, not a file, it does not move onto vSAN by Storage vMotion, and
 *    RVTools counts it once for every VM that maps it.
 *  - **A source cluster becomes a target cluster.** Clusters are how the estate
 *    already separates Windows from Linux, SQL from web, prod from test —
 *    licensing and anti-affinity decisions someone made on purpose. The plan
 *    keeps that shape and re-sizes each cluster for the target host; merging
 *    clusters is a decision for a person, not a default.
 *  - **Domains follow vCenters** by default: each source vCenter becomes a
 *    workload domain, since that is the boundary operations already runs to.
 *  - **N+1 per cluster,** and no cluster over 64 hosts — a larger demand splits.
 */

import { error, warning, info,              } from '../core/findings.js';
import {
  rollupByCluster,
  isWorkload,
  vmdkUsedGib,
  vmdkProvisionedGib,
  rdmCapacityGib,
  scopedKey,
                 
                     
                   
                     
} from '../vmware/inventory.js';
import { LICENSE_MIN_CORES_PER_CPU, raidOverhead, VSAN_SLACK_WITH_FAULT_DOMAINS } from './sizing-data.js';
import { minimumHosts,                                                   } from './sizing.js';

                                               
                                                                 
                         
                                                        
                         
 

                                
                       
                        
                            
                               
                             
                           
                                    
                                 
                                            
                        
                          
                                
                                                                                 
                           
                             
                           
                                  
                          
                         
                             
                                          
                                
                                                                      
                                      
                                                             
                                  
                                    
                             
                                
                                                         
                                        
 

                                                                 

                                    
                                                           
                                        
                                                                             
                                             
                          
                                                         
                             
                                                     
                                  
                                                        
                           
                                                 
                                       
                                        
                                                                                   
                                                            
                                     
                                       
 

                                 
                        
                                      
                        
                          
                              
                          
                                
                         
                            
                             
                           
                         
                                                             
                                                     
                               
                         
                                                                                
                                                              
 

                                
                        
                                           
                            
                               
                                               
                         
 

                             
                                             
                                                      
                                   
                                 
                               
                                 
                                 
                                        
                                                                                          
                                         
                                      
    
 

const MANAGEMENT_NAME = /(^|[-_.])(mgmt|mgt|mng|management|m\d{1,2}c\d|m0?1)([-_.]|\d|$)/i;

// ---------------------------------------------------------------------------
// Reading the estate
// ---------------------------------------------------------------------------

function storageOf(inventory           , hosts                          , vms                        )              {
  const names = new Set(vms.flatMap((v) => v.datastores ?? []));
  const hostNames = new Set(hosts.map((h) => h.name));
  const tally                              = { 'vsan-esa': 0, 'vsan-osa': 0, nfs: 0, 'vmfs-fc': 0 };
  for (const ds of inventory.datastores) {
    const used = names.has(ds.name) || (ds.hosts ?? []).some((h) => hostNames.has(h));
    if (!used) continue;
    const kind              =
      ds.type === 'vsan' ? 'vsan-esa' : ds.type === 'NFS' ? 'nfs' : 'vmfs-fc';
    tally[kind] += ds.capacityGib;
  }
  const best = (Object.entries(tally)                           ).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : 'vmfs-fc';
}

function profileLabel(h               )         {
  const cpu = (h.cpuModel ?? '').replace(/\(R\)|\(TM\)|Intel|AMD|CPU|Processor|@.*$/gi, '').replace(/\s+/g, ' ').trim();
  return `${h.model ?? 'host'} · ${h.cpuSockets} × ${h.coresPerSocket}-core ${cpu} · ${Math.round(h.memoryGib)} GiB`;
}

/** The host profile most of these hosts share — the natural target default. */
export function commonHostProfile(hosts                          )                          {
  const groups = new Map                                                ();
  for (const h of hosts) {
    if (h.totalCores <= 0 || h.memoryGib <= 0) continue;
    // Memory is rounded to the nearest 64 GiB: 2047 and 2048 are the same host.
    const key = `${h.model}|${h.cpuModel}|${h.cpuSockets}|${h.coresPerSocket}|${Math.round(h.memoryGib / 64)}`;
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { host: h, count: 1 });
  }
  const top = [...groups.values()].sort(
    (a, b) => b.count - a.count || b.host.totalCores - a.host.totalCores,
  )[0];
  if (!top) return undefined;
  const h = top.host;
  return {
    cpuSockets: h.cpuSockets,
    coresPerCpu: h.coresPerSocket,
    hyperthreading: h.hyperthreadingActive ?? (h.threads ?? h.totalCores) > h.totalCores,
    ramGib: Math.round(h.memoryGib / 64) * 64,
    rawStorageGib: 0,
    label: profileLabel(h),
    count: top.count,
  };
}

/** Every host profile present, most common first — the target host dropdown. */
export function hostProfiles(hosts                          )                {
  const out                = [];
  let remaining = hosts.filter((h) => h.totalCores > 0);
  while (remaining.length > 0) {
    const top = commonHostProfile(remaining);
    if (!top) break;
    out.push(top);
    remaining = remaining.filter((h) => profileLabel(h) !== top.label);
  }
  return out;
}

export function sourceClusters(inventory           )                  {
  const rollups = rollupByCluster(inventory);
  const hostsBy = new Map                         ();
  for (const h of inventory.hosts) {
    const key = scopedKey(h.vcenter, h.cluster ?? '(standalone)');
    (hostsBy.get(key) ?? hostsBy.set(key, []).get(key) ).push(h);
  }
  const hostIndex = new Map(inventory.hosts.map((h) => [scopedKey(h.vcenter, h.name), h]));
  const vmsBy = new Map                       ();
  for (const vm of inventory.vms) {
    if (vm.srmPlaceholder) continue;
    const host = vm.host ? hostIndex.get(scopedKey(vm.vcenter, vm.host)) : undefined;
    const key = scopedKey(vm.vcenter, vm.cluster ?? host?.cluster ?? '(standalone)');
    (vmsBy.get(key) ?? vmsBy.set(key, []).get(key) ).push(vm);
  }

  return rollups
    .filter((r) => r.hostCount > 0 || r.vmCount > 0)
    .map((r               )                => {
      const hosts = hostsBy.get(r.key) ?? [];
      const vms = vmsBy.get(r.key) ?? [];
      const off = vms.filter((v) => isWorkload(v) && v.powerState !== 'poweredOn');
      const weakest =
        hosts.length > 0
          ? {
              cpuSockets: Math.min(...hosts.map((h) => h.cpuSockets)),
              coresPerCpu: Math.min(...hosts.map((h) => h.coresPerSocket)),
              hyperthreading: hosts.every((h) => h.hyperthreadingActive ?? (h.threads ?? h.totalCores) > h.totalCores),
              ramGib: Math.min(...hosts.map((h) => h.memoryGib)),
              rawStorageGib: 0,
            }
          : undefined;
      const common = commonHostProfile(hosts);
      const hostNames = new Set(hosts.map((h) => h.name));
      const vsanRaw = inventory.datastores
        .filter((d) => d.type === 'vsan' && (d.hosts ?? []).some((h) => hostNames.has(h)))
        .reduce((s, d) => s + d.capacityGib, 0);
      return {
        key: r.key,
        name: r.name,
        ...(r.vcenter ? { vcenter: r.vcenter } : {}),
        ...(r.datacenter ? { datacenter: r.datacenter } : {}),
        hostCount: r.hostCount,
        vmCount: r.vmCount,
        poweredOnVmCount: r.poweredOnVmCount,
        templateCount: vms.filter((v) => v.template).length,
        vcpu: r.allocatedVcpu,
        ramGib: r.allocatedMemoryGib,
        activeRamGib: r.activeMemoryGib,
        offVcpu: off.reduce((s, v) => s + v.vcpu, 0),
        offRamGib: off.reduce((s, v) => s + v.memoryGib, 0),
        usedGib: vms.reduce((s, v) => s + vmdkUsedGib(v), 0),
        provisionedGib: vms.reduce((s, v) => s + vmdkProvisionedGib(v), 0),
        rdmGib: rdmCapacityGib(vms),
        cores: r.physicalCores,
        memoryGib: r.memoryGib,
        storage: storageOf(inventory, hosts, vms),
        ...(vsanRaw > 0 && hosts.length > 0 ? { vsanRawPerHostGib: vsanRaw / hosts.length } : {}),
        ...(weakest ? { weakestHost: { ...weakest, rawStorageGib: vsanRaw > 0 && hosts.length > 0 ? vsanRaw / hosts.length : 0 } } : {}),
        ...(common ? { commonHost: common } : {}),
        ...(r.cpuUsage !== undefined ? { cpuUsage: r.cpuUsage } : {}),
        ...(r.memoryUsage !== undefined ? { memoryUsage: r.memoryUsage } : {}),
        looksLikeManagement: MANAGEMENT_NAME.test(r.name),
      };
    });
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

                    
                   
                        
                 
                                       
                             
                              
                                                  
                           
                             
 

const DEFAULTS           = {
  cpuRatio: 4,
  memoryCeiling: 0.9,
  growth: 0.2,
  storageBasis: 'used',
  includePoweredOff: false,
  reserveHostFailure: true,
  workloadStorage: 'same-as-source',
  grouping: 'vcenter',
  maxHostsPerCluster: 64,
};

function isVsan(storage             )          {
  return storage === 'vsan-esa' || storage === 'vsan-osa';
}

/** Hosts one cluster needs for a demand. */
function sizeCluster(
  demand                                                      ,
  host          ,
  storage             ,
  o          ,
)                                                                      {
  const coresPerHost = host.cpuSockets * host.coresPerCpu;
  const vcpu = demand.vcpu * (1 + o.growth);
  const ramGib = demand.ramGib * (1 + o.growth);
  const storageGib = demand.storageGib * (1 + o.growth);
  const spare = o.reserveHostFailure ? 1 : 0;

  const byCpu = coresPerHost > 0 ? Math.ceil(vcpu / (o.cpuRatio * coresPerHost)) + spare : 0;
  const byMemory = host.ramGib > 0 ? Math.ceil(ramGib / (host.ramGib * o.memoryCeiling)) + spare : 0;

  let byStorage = 0;
  let raid                    ;
  if (isVsan(storage) && storageGib > 0) {
    if (host.rawStorageGib > 0) {
      // RAID overhead depends on the host count, so search upward.
      for (let n = 3; n <= 4096; n += 1) {
        const overhead = raidOverhead('standard', n);
        const needed = (storageGib * overhead.multiplier) / (1 - VSAN_SLACK_WITH_FAULT_DOMAINS);
        if ((n - spare) * host.rawStorageGib >= needed) {
          byStorage = n;
          raid = overhead.raid;
          break;
        }
      }
    } else {
      raid = raidOverhead('standard', Math.max(byCpu, byMemory)).raid;
    }
  }

  const minimum = minimumHosts({ path: 'brownfield-import', storage, topology: 'standard' }).hosts;
  const hosts = Math.max(byCpu, byMemory, byStorage, minimum);
  const binding =
    hosts === minimum && minimum > Math.max(byCpu, byMemory, byStorage)
      ? 'minimum'
      : hosts === byStorage && byStorage >= Math.max(byCpu, byMemory)
        ? 'storage'
        : hosts === byMemory && byMemory >= byCpu
          ? 'memory'
          : 'cpu';

  return {
    vcpu,
    ramGib,
    storageGib,
    storage,
    byCpu,
    byMemory,
    byStorage,
    minimum,
    hosts,
    binding,
    ...(raid ? { raid } : {}),
  };
}

function demandOf(c               , o          )                                                       {
  return {
    vcpu: c.vcpu + (o.includePoweredOff ? c.offVcpu : 0),
    ramGib: c.ramGib + (o.includePoweredOff ? c.offRamGib : 0),
    storageGib: o.storageBasis === 'provisioned' ? c.provisionedGib : c.usedGib,
  };
}

function planCluster(c               , host          , o          )                   {
  const storage = o.workloadStorage === 'same-as-source' ? c.storage : o.workloadStorage;
  const demand = demandOf(c, o);
  const whole = sizeCluster(demand, host, storage, o);
  // Past the cluster maximum, the demand splits evenly across as many
  // clusters as it takes, each sized (and given its spare) on its own.
  const parts = Math.max(1, Math.ceil(whole.hosts / o.maxHostsPerCluster));
  if (parts === 1) {
    return [{ name: c.name, sources: [c.key], rdmGib: c.rdmGib, sourceHosts: c.hostCount, ...whole }];
  }
  let split = parts;
  let each = sizeCluster(
    { vcpu: demand.vcpu / split, ramGib: demand.ramGib / split, storageGib: demand.storageGib / split },
    host,
    storage,
    o,
  );
  while (each.hosts > o.maxHostsPerCluster && split < 64) {
    split += 1;
    each = sizeCluster(
      { vcpu: demand.vcpu / split, ramGib: demand.ramGib / split, storageGib: demand.storageGib / split },
      host,
      storage,
      o,
    );
  }
  return Array.from({ length: split }, (_, i) => ({
    name: `${c.name}-${String.fromCharCode(97 + i)}`,
    sources: [c.key],
    rdmGib: c.rdmGib / split,
    sourceHosts: i === 0 ? c.hostCount : 0,
    part: { n: i + 1, of: split },
    ...each,
  }));
}

function groupKey(c               , grouping                )         {
  if (grouping === 'single') return 'all';
  if (grouping === 'datacenter') return `${c.vcenter ?? ''}|${c.datacenter ?? ''}`;
  return c.vcenter ?? '(no vCenter)';
}

/** A short domain name from a vCenter FQDN or datacenter name. */
function domainName(c               , grouping                , index        )         {
  if (grouping === 'single') return 'wld01';
  const base = grouping === 'datacenter' ? (c.datacenter ?? c.vcenter ?? '') : (c.vcenter ?? '').split('.')[0] ?? '';
  const clean = base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return clean ? `wld-${clean}` : `wld${String(index + 1).padStart(2, '0')}`;
}

export function planEstate(inventory           , options                   )             {
  const o = { ...DEFAULTS, ...stripUndefined(options) }                                ;
  const findings            = [];
  const all = sourceClusters(inventory);
  const selectedKeys = options.selected && options.selected.length > 0 ? new Set(options.selected) : null;
  const inScope = all.filter((c) => (selectedKeys ? selectedKeys.has(c.key) : c.name !== '(standalone)'));
  const managementSource = options.managementSource ?? 'new';
  const mgmtCluster = managementSource === 'new' ? undefined : all.find((c) => c.key === managementSource);

  // --- the management domain -----------------------------------------------
  let management             ;
  if (mgmtCluster) {
    const host = mgmtCluster.weakestHost ?? options.host;
    const external = !isVsan(mgmtCluster.storage);
    management = {
      path: 'brownfield-converge',
      profile: 'simple',
      instanceCount: 1,
      topology: 'standard',
      storage: mgmtCluster.storage,
      hostCount: mgmtCluster.hostCount,
      host: { ...host, rawStorageGib: external ? 0 : (mgmtCluster.vsanRawPerHostGib ?? host.rawStorageGib) },
      // Whatever already runs on the converged cluster stays there.
      workloadVcpu: mgmtCluster.vcpu,
      workloadRamGib: mgmtCluster.ramGib,
      workloadCapacityGib: mgmtCluster.usedGib,
      reserveHostFailure: o.reserveHostFailure,
    };
  } else {
    // New management hosts store on what the estate already runs: VCF 9 takes
    // NFS v3 or VMFS on FC for a new management domain as well as vSAN.
    const byStorage = new Map                     ();
    for (const c of inScope) byStorage.set(c.storage, (byStorage.get(c.storage) ?? 0) + c.hostCount);
    const storage = [...byStorage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'vsan-esa';
    management = {
      path: 'greenfield',
      profile: 'simple',
      instanceCount: 1,
      topology: 'standard',
      storage,
      hostCount: minimumHosts({ path: 'greenfield', storage, topology: 'standard' }).hosts,
      host: isVsan(storage) ? o.host : { ...o.host, rawStorageGib: 0 },
      reserveHostFailure: o.reserveHostFailure,
    };
  }

  // --- workload domains ------------------------------------------------------
  const workloadSources = inScope.filter((c) => c.key !== mgmtCluster?.key && (c.vmCount > 0 || c.hostCount > 0));
  const groups = new Map                         ();
  for (const c of workloadSources) {
    const key = groupKey(c, o.grouping);
    (groups.get(key) ?? groups.set(key, []).get(key) ).push(c);
  }

  const domains                  = [];
  const mgmtClusters                   = [
    {
      name: mgmtCluster ? mgmtCluster.name : 'mgmt-c01',
      sources: mgmtCluster ? [mgmtCluster.key] : [],
      vcpu: management.workloadVcpu ?? 0,
      ramGib: management.workloadRamGib ?? 0,
      storageGib: management.workloadCapacityGib ?? 0,
      rdmGib: mgmtCluster?.rdmGib ?? 0,
      storage: management.storage,
      byCpu: 0,
      byMemory: 0,
      byStorage: 0,
      minimum: management.hostCount,
      hosts: management.hostCount,
      binding: 'minimum',
      sourceHosts: mgmtCluster?.hostCount ?? 0,
    },
  ];
  domains.push({
    name: 'mgmt',
    kind: 'management',
    ...(mgmtCluster?.vcenter ? { vcenter: mgmtCluster.vcenter } : {}),
    ...(mgmtCluster?.datacenter ? { datacenter: mgmtCluster.datacenter } : {}),
    clusters: mgmtClusters,
    hosts: management.hostCount,
  });

  let index = 0;
  const usedNames = new Set        ();
  for (const [, members] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const clusters = members
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((c) => planCluster(c, o.host, o));
    let name = domainName(members[0]                 , o.grouping, index);
    while (usedNames.has(name)) name = `${name}-${index}`;
    usedNames.add(name);
    domains.push({
      name,
      kind: 'workload',
      ...(members[0]?.vcenter ? { vcenter: members[0].vcenter } : {}),
      ...(o.grouping !== 'vcenter' && members[0]?.datacenter ? { datacenter: members[0].datacenter } : {}),
      clusters,
      hosts: clusters.reduce((s, c) => s + c.hosts, 0),
    });
    index += 1;
  }

  // --- totals ---------------------------------------------------------------
  const workloadHosts = domains.filter((d) => d.kind === 'workload').reduce((s, d) => s + d.hosts, 0);
  const newHosts = workloadHosts + (mgmtCluster ? 0 : management.hostCount);
  const cores = o.host.cpuSockets * o.host.coresPerCpu;
  const billedPerHost = o.host.cpuSockets * Math.max(o.host.coresPerCpu, LICENSE_MIN_CORES_PER_CPU);
  const mgmtCores = mgmtCluster
    ? mgmtCluster.hostCount * (mgmtCluster.weakestHost ? mgmtCluster.weakestHost.cpuSockets * mgmtCluster.weakestHost.coresPerCpu : cores)
    : 0;
  const mgmtBilled = mgmtCluster?.weakestHost
    ? mgmtCluster.hostCount * mgmtCluster.weakestHost.cpuSockets * Math.max(mgmtCluster.weakestHost.coresPerCpu, LICENSE_MIN_CORES_PER_CPU)
    : 0;
  const physicalCores = newHosts * cores + mgmtCores;
  const billableCores = newHosts * billedPerHost + mgmtBilled;
  const sourceHosts = inScope.reduce((s, c) => s + c.hostCount, 0);

  // --- findings -------------------------------------------------------------
  if (inScope.length === 0) {
    findings.push(warning('estate.plan.nothing-selected', 'No source clusters are in scope, so there is nothing to plan.'));
  }
  const rdm = workloadSources.filter((c) => c.rdmGib > 0);
  if (rdm.length > 0) {
    const total = rdm.reduce((s, c) => s + c.rdmGib, 0);
    findings.push(
      warning(
        'estate.plan.rdm',
        `${rdm.length} cluster(s) map raw LUNs (${Math.round(total / 1024)} TiB, each LUN counted once): ${rdm.map((c) => c.name).slice(0, 5).join(', ')}${rdm.length > 5 ? '…' : ''}. They are not in the vSAN figures.`,
        {
          remediation:
            'Keep those clusters on external storage in their workload domain (VMFS on FC is supported as principal storage for a VI workload domain), or plan the LUNs as a storage migration of their own.',
        },
      ),
    );
  }
  const vsanWithoutRaw = domains
    .filter((d) => d.kind === 'workload')
    .flatMap((d) => d.clusters)
    .filter((c) => isVsan(c.storage) && c.byStorage === 0 && c.storageGib > 0);
  if (vsanWithoutRaw.length > 0 && o.host.rawStorageGib <= 0) {
    findings.push(
      info(
        'estate.plan.vsan-capacity-unknown',
        'The target host has no raw vSAN capacity set, so storage has not constrained the host counts.',
        { remediation: 'Set raw storage per host to let vSAN capacity decide the cluster size where it binds.' },
      ),
    );
  }
  const split = domains.flatMap((d) => d.clusters).filter((c) => c.part);
  if (split.length > 0) {
    findings.push(
      info(
        'estate.plan.split',
        `Demand in some source clusters needs more than ${o.maxHostsPerCluster} target hosts, so they are split into several clusters.`,
      ),
    );
  }
  if (mgmtCluster && !mgmtCluster.looksLikeManagement) {
    findings.push(
      info(
        'estate.plan.converge-workload-cluster',
        `"${mgmtCluster.name}" is to become the management domain and it is not named as a management cluster. Its ${mgmtCluster.vmCount} VMs stay on it, beside the VCF management components.`,
      ),
    );
  }
  if (mgmtCluster && mgmtCluster.rdmGib > 0) {
    findings.push(
      error(
        'estate.plan.converge-rdm',
        `"${mgmtCluster.name}" has raw device mappings; a cluster being converged into the management domain should carry only VMFS, NFS or vSAN storage.`,
        { remediation: 'Pick a different cluster to converge, or start the management domain on new hosts.' },
      ),
    );
  }
  const otherManagement = workloadSources.filter((c) => c.looksLikeManagement);
  if (otherManagement.length > 0) {
    findings.push(
      info(
        'estate.plan.other-management',
        `${otherManagement.length} cluster(s) planned into workload domains are named like management clusters: ${otherManagement.map((c) => c.name).slice(0, 5).join(', ')}${otherManagement.length > 5 ? '…' : ''}.`,
        {
          remediation:
            'Each site that should survive the loss of another needs a VCF instance, and each instance its own management domain. Raise the instance count on the sizing page for every such site, or take these clusters out of scope.',
        },
      ),
    );
  }
  // vCenters named like an existing VCF (m01, w01 …) are a fleet already.
  const vcfShaped = [...new Set(inScope.map((c) => c.vcenter).filter((v)              => !!v && /(^|[-.])[mw]\d{1,2}(-|\.|$)/i.test(v)))];
  if (vcfShaped.length > 0) {
    findings.push(
      info(
        'estate.plan.existing-vcf',
        `${vcfShaped.length} vCenter(s) are named like VCF domains already (${vcfShaped.slice(0, 4).join(', ')}${vcfShaped.length > 4 ? '…' : ''}). They may be an existing VCF instance to upgrade or import rather than to rebuild.`,
        { remediation: 'Take them out of scope if they are being upgraded in place.' },
      ),
    );
  }
  findings.push(
    info(
      'estate.plan.basis',
      `Sized on ${o.includePoweredOff ? 'all' : 'running'} workloads' allocated vCPU and memory at ${o.cpuRatio}:1 vCPU per core and ${Math.round(o.memoryCeiling * 100)}% of memory, ${o.storageBasis} VMDK storage, ${Math.round(o.growth * 100)}% growth${o.reserveHostFailure ? ', N+1 per cluster' : ''}.`,
      { source: 'ArchToolKit estate plan' },
    ),
  );

  return {
    domains,
    management,
    workloadHosts,
    sourceHosts,
    physicalCores,
    billableCores,
    findings,
    options: {
      ...DEFAULTS,
      ...stripUndefined(options),
      host: o.host,
      selected: inScope.map((c) => c.key),
      managementSource,
    }                         ,
  };
}

function stripUndefined                  (value   )             {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))              ;
}

/** The cluster most likely meant to become the management domain, if any. */
export function suggestManagementSource(clusters                          )         {
  const candidates = clusters
    .filter((c) => c.looksLikeManagement && c.hostCount >= 3 && c.rdmGib === 0)
    .sort((a, b) => b.hostCount - a.hostCount || a.vmCount - b.vmCount);
  return candidates[0]?.key ?? 'new';
}
