/**
 * Canonical VMware inventory model.
 *
 * Every import path — RVTools export, PowerCLI collection, live vCenter —
 * normalises into this one shape, so analysis, VCF brownfield sizing and
 * migration planning all read the same structure rather than each learning a
 * different vendor's column names.
 *
 * Unit discipline: capacity is GiB throughout, memory is GiB, frequency is MHz.
 * Importers convert at the boundary (RVTools is MiB, the vSphere API is MiB or
 * KiB) so nothing downstream has to guess.
 */

                                                                              
                                                                       

/** Physical NIC. Link speed decides vSAN ESA viability, so it is first-class. */
                              
                        
                                                                              
                            
                        
                           
                             
                            
                                               
                               
 

/** VMkernel adapter — the basis for planning the VCF network spec. */
                                  
                        
                       
                               
                        
                        
                              
                                    
                                                                              
                               
                          
                            
                          
                         
 

                                                                   

/**
 * Physical storage device.
 *
 * vSAN ESA requires NVMe TLC devices and forbids RAID controllers, so device
 * type and the controller in front of it decide whether ESA is possible at all.
 */
                                
                        
                                   
                                
                          
                           
                                                                                
                                                                     
                           
                             
 

                                 
                        
                         
                          
                           
                           
                        
 

/** Boot configuration. VCF 9 forbids SD cards and sets minimum sizes. */
                             
                               
                                
 

                                
                        
                            
                               
                           
                          
                             
                          
                              
                                  
                                           
                              
                                                               
                            
                                
                             
                                                                             
                             
                                
                             
                               
                          
                                    
                                       
                                                                       
                                  
                                       

                                                                             
                                 
                                
                              
                                          
                                                                             
                                
                                       
                               
                               

                                                     
                                        
                                                                                  
                                                
                                                  
                                            
                                   
                             

                                                                             
                                                                
                            
                             
                         
                                 
                                    
                                      
                                    
                                             
                                      
                             
                                                                         
                            
                                 
                               
                                 
                                    
                                 
                                   
                                      
                                             
                                   
                               
                                  
                                
                                   
                                    
                             
                                 
                          
                           
                                       
                                 
                                
                             
                               
                              
                               
                             
                                         
                                                                    
                                               
                                                                               
                                           
                                                               
                                             
 

                                  
                           
                            
                              
                            
                           
 

                                 
                        
                          
                              
                        
                                 
                                
                                     
                                  
                              
 

                                     
                                      
                           
                                                                       
                                     
                                                 
                             
                                                                        
                                            
                             
 

                              
                        
                         
                                  
                         
                            
                               
                        
                                   
                             
                                      
                                  
                                                                         
                            
                            
                                    
                                 
                                
                              
                                 
                               
                                  
                                

                                                                             
                            
                                                                       
                         
                               
                                                                                 
                              
                                                                              
                                    
                                 
                                    
                               
                              
                                         
                            
                              
                                
                                                            
                                
                                                                             
                                    
                             
                              
                                 
                                                                             
                                
                                                                                    
                           
                                        
                               
                                       
                                
                                          
                             
                                
                                 
                           
                             
                         
                                 
                                      
                                        
                                   
                            
                           
                                                      
                                   
                                       
                                
                             
                                   
                                    
                                    
                            
                               
     
                                                                              
                                                                               
     
                                                     
                                                                           
                                 
                                                                          
                                                
                                      
                                                          
                                  
                             
                                   
                            
                                      
                          
                               
                                   
                                    
                                 
 

                              
                            
                                   
                                                        
                           
                               
                                
                           
                                   
                                                               
                             
                                   
                            
                               
                                       
 

                                 
                            
                                 
                                
                                
                               
                              
                               
                                 
                              
                                   
                                
                                   
                             
                            
 

                         
                         
                        
                         
                               
                        
                                                 
                                         
                             
                         
                                                                               
                            
                          
                                  
                           
                                  
                                
                              
                               
                         
                              
                              
                         
 

                              
                         
                            
                               
                               
                           
 

                        
                         
                            
                            
                               
                               
                                     
                        
                            
                           
                           
                                  
 

                           
                        
                         
                               
                                     
 

                             
                        
                                
                              
                            
                              
                          
 

                                
                           
                            
                                    
                                 
                                  
                              
                              
                                    
                                     
                                    
                                           
 

                                   
                        
                               
                               
                                
                                       
                            
                                 
                              

                            
                             
                                 
                                  
                                       
                                
                          
                            
                                    
                                   
                                       
                             
                                       
                                    
                                        
                                     
                                               
                                        
                                      
                                   
                               
                                   
                                
                                
 

                                     
                        
                               
                               
                           
                                   
                              
                            

                            
                             
                                                                             
                               
                                 
                                       
                            
                                
                            
                                 
                             
                                 
                                  
                            
                                                   
                                                
                                            
                                
                            
                                 
                            
                                     
                        
 

                                   
                        
                               
                                    
                         

                            
                                                                  
                                             
                         
                               
                          
                                    
                                     
                                  
                                 
                                
                                     
                             
                             
 

                                   
                        
                         
                             
                            
                          
                               
                           
                                
 

                                        
                        
                         
                            
                           
                            
                                 
                          
                                      
                                
                                   
                                   
                                
                                        
                                         
                                   
                                      
                                      
                                   
                             
 

                                             
                        
                            
                               
                           
                            
                                  
                             
                          
                            
                           
                                      
                         
                             
 

                                   
                        
                                                                      
                            
                            
                             
                          
                         
                            
                             
 

                                         
                           
                           
                         
                            
 

                                
                        
                        
                         
                              
                            
 

                                  
                                                                        
                                                                               
                                                     
                          
                                                               
                                
                              
                                                                  
                            
                                                             
                                
                                                                           
                                                        
                                          
                                         
 

                            
                                   
                                  
                              
                                        
                                            
                                        
                                         
                                                   
                                                              
                                         
                                             
                                   
 

/**
 * A key that is unique across vCenters.
 *
 * An estate collected from thirteen vCenters has thirteen clusters that could be
 * called "Cluster01" and managed-object ids that restart in each one, so a name
 * alone is not an identity. Anything that joins or de-duplicates goes through
 * this.
 */
export function scopedKey(vcenter                    , name        )         {
  return `${(vcenter ?? '').toLowerCase()}|${name}`;
}

/** VMs that are workloads: not templates and not SRM placeholders. */
export function isWorkload(vm             )          {
  return !vm.template && !vm.srmPlaceholder;
}

export function emptyInventory(source                           = {})            {
  return {
    source: {
      kind: 'unknown',
      importedAt: new Date().toISOString(),
      ...source,
    },
    hosts: [],
    vms: [],
    clusters: [],
    datastores: [],
    networks: [],
  };
}

/** Merge inventories, e.g. several RVTools exports covering different vCenters. */
export function mergeInventories(inventories                      )            {
  if (inventories.length === 0) return emptyInventory();
  if (inventories.length === 1) return inventories[0]             ;

  const notes = inventories.flatMap((inv) => inv.source.notes ?? []);
  return {
    source: {
      kind: inventories[0]?.source.kind ?? 'unknown',
      label: `${inventories.length} merged sources`,
      importedAt: new Date().toISOString(),
      notes,
    },
    hosts: dedupeBy(inventories.flatMap((i) => i.hosts), (h) => scopedKey(h.vcenter, h.name)),
    vms: dedupeBy(inventories.flatMap((i) => i.vms), (v) => scopedKey(v.vcenter, v.uuid ?? v.name)),
    clusters: dedupeBy(inventories.flatMap((i) => i.clusters), (c) => scopedKey(c.vcenter, c.name)),
    datastores: dedupeBy(inventories.flatMap((i) => i.datastores), (d) => scopedKey(d.vcenter, d.name)),
    networks: dedupeBy(
      inventories.flatMap((i) => i.networks),
      (n) => scopedKey(n.vcenter, `${n.host ?? ''}/${n.switchName ?? ''}/${n.name}`),
    ),
    vcenters: dedupeBy(inventories.flatMap((i) => i.vcenters ?? []), (v) => v.name.toLowerCase()),
    resourcePools: dedupeBy(
      inventories.flatMap((i) => i.resourcePools ?? []),
      (p) => scopedKey(p.vcenter, p.path ?? p.name),
    ),
    distributedSwitches: dedupeBy(
      inventories.flatMap((i) => i.distributedSwitches ?? []),
      (d) => scopedKey(d.vcenter, d.name),
    ),
    licenses: dedupeBy(
      inventories.flatMap((i) => i.licenses ?? []),
      (l) => scopedKey(l.vcenter, `${l.name}/${l.keyTail ?? ''}`),
    ),
    health: inventories.flatMap((i) => i.health ?? []),
    files: inventories.flatMap((i) => i.files ?? []),
  };
}

function dedupeBy   (items     , key                     )      {
  const seen = new Map           ();
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) seen.set(k, item);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

                                  
                             
                                                                              
                           
                                    
                                 
                                
                                
                                 
                                   
                                     
                                 
                                      
                                                               
                                   
                                         
                                                                             
                                  
                                                                      
                          
                                        
                                    
                                          
                                 
                                                        
                                    
                                                            
                                       
 

/**
 * The VMDK storage a VM consumes.
 *
 * RVTools' "In Use" includes the full size of a physical-mode RDM, so a VM
 * with a 1.2 PB GPFS LUN mapped reports 1.2 PB in use — and seven such VMs
 * report 8.4 PB for one LUN. The RDM is taken out here and counted once, by
 * LUN, in `rdmCapacityGib`.
 */
export function vmdkUsedGib(vm             )         {
  const used = vm.usedGib ?? vm.provisionedGib;
  return Math.max(0, used - (vm.rdmGib ?? 0));
}

export function vmdkProvisionedGib(vm             )         {
  return Math.max(0, vm.provisionedGib - (vm.rdmGib ?? 0));
}

/** RDM capacity across a set of VMs, each LUN counted once. */
export function rdmCapacityGib(vms                        )         {
  const luns = new Map                ();
  let unidentified = 0;
  for (const vm of vms) {
    for (const disk of vm.disks ?? []) {
      if (!disk.raw) continue;
      if (disk.rawLunId) luns.set(scopedKey(vm.vcenter, disk.rawLunId), disk.capacityGib);
      else unidentified += disk.capacityGib;
    }
    // A VM imported without its disks still knows its RDM total.
    if (!vm.disks && vm.rdmGib) unidentified += vm.rdmGib;
  }
  return [...luns.values()].reduce((a, b) => a + b, 0) + unidentified;
}

/**
 * Totals across the estate.
 *
 * Powered-off VMs and templates are counted in storage (they still occupy
 * disk) but excluded from vCPU and memory allocation, which only matters for
 * running workloads.
 */
export function computeTotals(inventory           )                  {
  const { hosts, vms, clusters, datastores } = inventory;

  const physicalCores = hosts.reduce((sum, h) => sum + h.totalCores, 0);
  const physicalSockets = hosts.reduce((sum, h) => sum + h.cpuSockets, 0);
  const physicalMemoryGib = hosts.reduce((sum, h) => sum + h.memoryGib, 0);

  const workloads = vms.filter(isWorkload);
  const running = workloads.filter((v) => v.powerState === 'poweredOn');
  const allocatedVcpu = running.reduce((sum, v) => sum + v.vcpu, 0);
  const allocatedMemoryGib = running.reduce((sum, v) => sum + v.memoryGib, 0);
  const activeMemoryGib = running.reduce((sum, v) => sum + (v.activeMemoryGib ?? v.memoryGib), 0);

  const onDisk = vms.filter((v) => !v.srmPlaceholder);
  const provisionedStorageGib = onDisk.reduce((sum, v) => sum + vmdkProvisionedGib(v), 0);
  const usedStorageGib = onDisk.reduce((sum, v) => sum + vmdkUsedGib(v), 0);
  const rdmGib = rdmCapacityGib(onDisk);

  const datastoreCapacityGib = datastores.reduce((sum, d) => sum + d.capacityGib, 0);
  const datastoreFreeGib = datastores.reduce((sum, d) => sum + d.freeGib, 0);

  const vcenters = new Set(
    [...hosts.map((h) => h.vcenter), ...vms.map((v) => v.vcenter), ...(inventory.vcenters ?? []).map((v) => v.name)]
      .filter(Boolean)
      .map((v) => (v          ).toLowerCase()),
  );

  return {
    hostCount: hosts.length,
    vmCount: workloads.length,
    poweredOnVmCount: running.length,
    templateCount: vms.filter((v) => v.template).length,
    clusterCount: clusters.length,
    vcenterCount: vcenters.size,
    physicalCores,
    physicalSockets,
    physicalMemoryGib,
    allocatedVcpu,
    allocatedMemoryGib,
    activeMemoryGib,
    provisionedStorageGib,
    usedStorageGib,
    rdmGib,
    datastoreCapacityGib,
    datastoreFreeGib,
    cpuOvercommit: physicalCores > 0 ? allocatedVcpu / physicalCores : 0,
    memoryOvercommit: physicalMemoryGib > 0 ? allocatedMemoryGib / physicalMemoryGib : 0,
    thinProvisioningGib: Math.max(0, provisionedStorageGib - usedStorageGib),
  };
}

                                
                                                                
                       
                        
                            
                               
                             
                           
                                    
                                 
                             
                                 
                                      
                                   
                                  
                                         
                          
                                 
                                    
                                                                              
                               
                                                            
                             
                                
 

/** Which cluster a VM belongs to, as a scoped key. */
export function clusterKeyOf(inventory           , vm             , hostIndex                             )         {
  if (vm.cluster) return scopedKey(vm.vcenter, vm.cluster);
  const index = hostIndex ?? new Map(inventory.hosts.map((h) => [scopedKey(h.vcenter, h.name), h]));
  const host = vm.host ? index.get(scopedKey(vm.vcenter, vm.host)) : undefined;
  return scopedKey(vm.vcenter, host?.cluster ?? '(standalone)');
}

export function rollupByCluster(inventory           )                  {
  const groups = new Map                                                                                                             ();

  const ensure = (vcenter                    , name        ) => {
    const key = scopedKey(vcenter, name);
    let group = groups.get(key);
    if (!group) {
      group = { name, ...(vcenter ? { vcenter } : {}), hosts: [], vms: [] };
      groups.set(key, group);
    }
    return group;
  };

  const hostIndex = new Map(inventory.hosts.map((h) => [scopedKey(h.vcenter, h.name), h]));
  for (const host of inventory.hosts) {
    const group = ensure(host.vcenter, host.cluster ?? '(standalone)');
    group.hosts.push(host);
    group.datacenter ??= host.datacenter;
  }
  for (const vm of inventory.vms) {
    if (vm.srmPlaceholder) continue;
    const host = vm.host ? hostIndex.get(scopedKey(vm.vcenter, vm.host)) : undefined;
    ensure(vm.vcenter, vm.cluster ?? host?.cluster ?? '(standalone)').vms.push(vm);
  }

  return [...groups.entries()]
    .map(([key, group])                => {
      const physicalCores = group.hosts.reduce((s, h) => s + h.totalCores, 0);
      const memoryGib = group.hosts.reduce((s, h) => s + h.memoryGib, 0);
      const workloads = group.vms.filter(isWorkload);
      const running = workloads.filter((v) => v.powerState === 'poweredOn');
      const allocatedVcpu = running.reduce((s, v) => s + v.vcpu, 0);
      const allocatedMemoryGib = running.reduce((s, v) => s + v.memoryGib, 0);
      const activeMemoryGib = running.reduce((s, v) => s + (v.activeMemoryGib ?? v.memoryGib), 0);
      const cpuModels = [...new Set(group.hosts.map((h) => h.cpuModel).filter(Boolean))]            ;
      const withCpu = group.hosts.filter((h) => h.cpuUsage !== undefined && h.totalCores > 0);
      const withMem = group.hosts.filter((h) => h.memoryUsage !== undefined && h.memoryGib > 0);
      const coreSum = withCpu.reduce((s, h) => s + h.totalCores, 0);
      const memSum = withMem.reduce((s, h) => s + h.memoryGib, 0);

      return {
        key,
        name: group.name,
        ...(group.vcenter ? { vcenter: group.vcenter } : {}),
        ...(group.datacenter ? { datacenter: group.datacenter } : {}),
        hostCount: group.hosts.length,
        vmCount: workloads.length,
        poweredOnVmCount: running.length,
        physicalCores,
        memoryGib,
        allocatedVcpu,
        allocatedMemoryGib,
        activeMemoryGib,
        usedStorageGib: group.vms.reduce((s, v) => s + vmdkUsedGib(v), 0),
        provisionedStorageGib: group.vms.reduce((s, v) => s + vmdkProvisionedGib(v), 0),
        rdmGib: rdmCapacityGib(group.vms),
        cpuOvercommit: physicalCores > 0 ? allocatedVcpu / physicalCores : 0,
        memoryOvercommit: memoryGib > 0 ? allocatedMemoryGib / memoryGib : 0,
        cpuModels,
        ...(coreSum > 0 ? { cpuUsage: withCpu.reduce((s, h) => s + (h.cpuUsage ?? 0) * h.totalCores, 0) / coreSum } : {}),
        ...(memSum > 0 ? { memoryUsage: withMem.reduce((s, h) => s + (h.memoryUsage ?? 0) * h.memoryGib, 0) / memSum } : {}),
      };
    })
    .sort((a, b) => b.hostCount - a.hostCount || a.name.localeCompare(b.name));
}

/**
 * Aggregate the estate's hosts into the averaged per-host profile the VCF
 * sizing engine expects.
 *
 * Real estates are heterogeneous, so this rounds down to the smallest common
 * denominator rather than averaging: sizing against an average host would
 * over-promise when the weakest host is the one that has to run a workload.
 */
export function toSizingHostProfile(inventory           )   
                     
                      
                          
                 
                        
         {
  const hosts = inventory.hosts;
  if (hosts.length === 0) return null;

  const minSockets = Math.min(...hosts.map((h) => h.cpuSockets));
  const minCores = Math.min(...hosts.map((h) => h.coresPerSocket));
  const minMemory = Math.min(...hosts.map((h) => h.memoryGib));
  // SMT is assumed only when every host reports more threads than cores.
  const hyperthreading = hosts.every((h) => (h.threads ?? h.totalCores) > h.totalCores);

  const vsanCapacity = inventory.datastores
    .filter((d) => d.type === 'vsan')
    .reduce((sum, d) => sum + d.capacityGib, 0);

  return {
    cpuSockets: minSockets,
    coresPerCpu: minCores,
    hyperthreading,
    ramGib: minMemory,
    rawStorageGib: hosts.length > 0 ? vsanCapacity / hosts.length : 0,
  };
}
