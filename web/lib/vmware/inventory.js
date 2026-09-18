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
    hosts: dedupeBy(inventories.flatMap((i) => i.hosts), (h) => h.name),
    vms: dedupeBy(inventories.flatMap((i) => i.vms), (v) => v.uuid ?? v.name),
    clusters: dedupeBy(inventories.flatMap((i) => i.clusters), (c) => c.name),
    datastores: dedupeBy(inventories.flatMap((i) => i.datastores), (d) => d.name),
    networks: dedupeBy(inventories.flatMap((i) => i.networks), (n) => n.name),
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
 * Totals across the estate.
 *
 * Powered-off VMs are counted in provisioned capacity (they still occupy disk)
 * but excluded from vCPU and memory allocation, which only matters for running
 * workloads.
 */
export function computeTotals(inventory           )                  {
  const { hosts, vms, clusters, datastores } = inventory;

  const physicalCores = hosts.reduce((sum, h) => sum + h.totalCores, 0);
  const physicalSockets = hosts.reduce((sum, h) => sum + h.cpuSockets, 0);
  const physicalMemoryGib = hosts.reduce((sum, h) => sum + h.memoryGib, 0);

  const running = vms.filter((v) => v.powerState === 'poweredOn');
  const allocatedVcpu = running.reduce((sum, v) => sum + v.vcpu, 0);
  const allocatedMemoryGib = running.reduce((sum, v) => sum + v.memoryGib, 0);

  const provisionedStorageGib = vms.reduce((sum, v) => sum + v.provisionedGib, 0);
  const usedStorageGib = vms.reduce((sum, v) => sum + (v.usedGib ?? v.provisionedGib), 0);

  const datastoreCapacityGib = datastores.reduce((sum, d) => sum + d.capacityGib, 0);
  const datastoreFreeGib = datastores.reduce((sum, d) => sum + d.freeGib, 0);

  return {
    hostCount: hosts.length,
    vmCount: vms.length,
    poweredOnVmCount: running.length,
    clusterCount: clusters.length,
    physicalCores,
    physicalSockets,
    physicalMemoryGib,
    allocatedVcpu,
    allocatedMemoryGib,
    provisionedStorageGib,
    usedStorageGib,
    datastoreCapacityGib,
    datastoreFreeGib,
    cpuOvercommit: physicalCores > 0 ? allocatedVcpu / physicalCores : 0,
    memoryOvercommit: physicalMemoryGib > 0 ? allocatedMemoryGib / physicalMemoryGib : 0,
    thinProvisioningGib: Math.max(0, provisionedStorageGib - usedStorageGib),
  };
}

                                
                        
                             
                           
                                 
                             
                                 
                                      
                                 
                                    
                                                                              
                               
 

export function rollupByCluster(inventory           )                  {
  const groups = new Map                                                        ();

  const ensure = (name        ) => {
    let group = groups.get(name);
    if (!group) {
      group = { hosts: [], vms: [] };
      groups.set(name, group);
    }
    return group;
  };

  for (const host of inventory.hosts) ensure(host.cluster ?? '(standalone)').hosts.push(host);
  for (const vm of inventory.vms) {
    const cluster = vm.cluster ?? inventory.hosts.find((h) => h.name === vm.host)?.cluster;
    ensure(cluster ?? '(standalone)').vms.push(vm);
  }

  return [...groups.entries()]
    .map(([name, group]) => {
      const physicalCores = group.hosts.reduce((s, h) => s + h.totalCores, 0);
      const memoryGib = group.hosts.reduce((s, h) => s + h.memoryGib, 0);
      const running = group.vms.filter((v) => v.powerState === 'poweredOn');
      const allocatedVcpu = running.reduce((s, v) => s + v.vcpu, 0);
      const allocatedMemoryGib = running.reduce((s, v) => s + v.memoryGib, 0);
      const cpuModels = [...new Set(group.hosts.map((h) => h.cpuModel).filter(Boolean))]            ;

      return {
        name,
        hostCount: group.hosts.length,
        vmCount: group.vms.length,
        physicalCores,
        memoryGib,
        allocatedVcpu,
        allocatedMemoryGib,
        cpuOvercommit: physicalCores > 0 ? allocatedVcpu / physicalCores : 0,
        memoryOvercommit: memoryGib > 0 ? allocatedMemoryGib / memoryGib : 0,
        cpuModels,
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
