/**
 * A VM's vCPU and memory, as the machine type each cloud would run it on.
 *
 * A rehost starts from what the VM has, not what it uses — RVTools' usage is a
 * moment — so this finds the smallest current-generation type with at least
 * the VM's vCPU and memory. The family follows the VM's memory per vCPU: two
 * GiB or less goes compute-optimised, four general-purpose, more than that
 * memory-optimised. Types are the ones in the generated machine catalog, and
 * the ladder below is checked against it by the tests, so a size the provider
 * does not sell cannot come out of here.
 *
 * vCPU and memory figures are the providers' published ones for these
 * families: AWS m7i/c7i/r7i, Azure Dsv5/Esv5/Fsv2, Google N2, OCI E5 Flex.
 */

                                                             

                              
                        
                        
                          
                                                             
 

const AWS_SIZES                              = [
  ['large', 2],
  ['xlarge', 4],
  ['2xlarge', 8],
  ['4xlarge', 16],
  ['8xlarge', 32],
  ['12xlarge', 48],
  ['16xlarge', 64],
  ['24xlarge', 96],
  ['48xlarge', 192],
];

const aws = (prefix        , perVcpu        , family                       )                =>
  AWS_SIZES.map(([size, vcpu]) => ({ name: `${prefix}.${size}`, vcpu, ramGib: vcpu * perVcpu, family }));

const E_V5                              = [
  [2, 16],
  [4, 32],
  [8, 64],
  [16, 128],
  [20, 160],
  [32, 256],
  [48, 384],
  [64, 512],
  [96, 672],
  [104, 672],
];

export const LADDERS                                                              = {
  aws: [...aws('c7i', 2, 'compute'), ...aws('m7i', 4, 'general'), ...aws('r7i', 8, 'memory')],
  azure: [
    ...[2, 4, 8, 16, 32, 48, 64, 72].map((n) => ({ name: `Standard_F${n}s_v2`, vcpu: n, ramGib: n * 2, family: 'compute'          })),
    ...[2, 4, 8, 16, 32, 48, 64, 96].map((n) => ({ name: `Standard_D${n}s_v5`, vcpu: n, ramGib: n * 4, family: 'general'          })),
    ...E_V5.map(([n, ram]) => ({ name: `Standard_E${n}s_v5`, vcpu: n, ramGib: ram, family: 'memory'          })),
  ],
  google: [
    ...[2, 4, 8, 16, 32, 48, 64, 80, 96].map((n) => ({ name: `n2-highcpu-${n}`, vcpu: n, ramGib: n, family: 'compute'          })),
    ...[2, 4, 8, 16, 32, 48, 64, 80, 96, 128].map((n) => ({ name: `n2-standard-${n}`, vcpu: n, ramGib: n * 4, family: 'general'          })),
    ...[2, 4, 8, 16, 32, 48, 64, 80, 96, 128].map((n) => ({
      name: `n2-highmem-${n}`,
      vcpu: n,
      ramGib: n === 128 ? 864 : n * 8,
      family: 'memory'         ,
    })),
  ],
};

/** OCI Flex: one OCPU is two vCPU; up to 94 OCPUs and 1,049 GB on E5. */
export const OCI_FLEX = { name: 'VM.Standard.E5.Flex', maxOcpus: 94, maxMemoryGb: 1049, maxGbPerOcpu: 64 }         ;

                      
                        
                        
                          
                       
                          
 

const ORDER                                                         = {
  compute: ['compute', 'general', 'memory'],
  general: ['general', 'memory'],
  memory: ['memory'],
  flex: ['flex'],
};

/** The smallest type with at least this vCPU and memory, or null if none. */
export function rightsize(cloud             , vcpu        , ramGib        )             {
  const needCpu = Math.max(1, Math.ceil(vcpu));
  const needRam = Math.max(1, Math.ceil(ramGib));
  if (cloud === 'oci') {
    const ocpus = Math.max(1, Math.ceil(needCpu / 2), Math.ceil(needRam / OCI_FLEX.maxGbPerOcpu));
    if (ocpus > OCI_FLEX.maxOcpus || needRam > OCI_FLEX.maxMemoryGb) return null;
    return { type: OCI_FLEX.name, vcpu: ocpus * 2, ramGib: needRam, ocpus };
  }
  const perCpu = needRam / needCpu;
  const family                        = perCpu <= 2.5 ? 'compute' : perCpu <= 5 ? 'general' : 'memory';
  for (const f of ORDER[family]) {
    const fit = LADDERS[cloud]
      .filter((t) => t.family === f && t.vcpu >= needCpu && t.ramGib >= needRam)
      .sort((a, b) => a.vcpu - b.vcpu || a.ramGib - b.ramGib)[0];
    if (fit) return { type: fit.name, vcpu: fit.vcpu, ramGib: fit.ramGib };
  }
  return null;
}

// ---------------------------------------------------------------------------
// rightsizeFor: the planner's sizing, with memory basis and licence-optimised
// hosts. `rightsize()` above stays as it is for terraform/estate.ts.
// ---------------------------------------------------------------------------

/**
 * Azure Edsv5 (memory-optimised, local disk): the parents the constrained
 * sizes are cut from, and the ladder licence-optimised Azure hosts use.
 * vCPU and memory are Microsoft's published figures for the series.
 */
export const AZURE_EDSV5                         = E_V5.map(([n, ram]) => ({
  name: `Standard_E${n}ds_v5`,
  vcpu: n,
  ramGib: ram,
  family: 'memory'         ,
}));

                                  
                                    
                        
                                                                                                   
                          
                                                   
                        
                              
                          
 

/**
 * Azure constrained-vCPU sizes on Edsv5: the parent's memory, storage and I/O
 * with fewer active vCPUs, so a per-core database licence counts fewer cores.
 * Billing is the parent's (the saving is the licence, not the VM).
 * https://learn.microsoft.com/en-us/azure/virtual-machines/constrained-vcpu
 *
 * These ids are not in `AZURE_VM_SIZE_GROUPS` (sizes-data.ts is generated from
 * Microsoft's series ladders, which list only the parents), so the tests check
 * each parent there and the constrained names here.
 */
export const AZURE_CONSTRAINED_LADDER                             = (
  [
    [4, 2],
    [8, 2],
    [8, 4],
    [16, 4],
    [16, 8],
    [32, 8],
    [32, 16],
    [64, 16],
    [64, 32],
  ]         
).map(([parentVcpu, vcpu]) => {
  const parent = AZURE_EDSV5.find((t) => t.vcpu === parentVcpu) ;
  return { name: `Standard_E${parentVcpu}-${vcpu}ds_v5`, parent: parent.name, vcpu, parentVcpu, ramGib: parent.ramGib };
});

                                   
     
                                                                           
                                                               
     
                                                
     
                                                                                
                                                                              
                                                                          
                                                                               
                 
     
                                      
                            
 

                                  
                                                                                                                      
                              
                                                                 
                                
  

const memoryFamily = (cloud                  )                         =>
  cloud === 'aws'
    ? LADDERS.aws.filter((t) => t.name.startsWith('r7i.'))
    : LADDERS.google.filter((t) => t.name.startsWith('n2-highmem-'));

/** The planner's sizing: `rightsize` plus memory basis, a vCPU floor and licence-optimised hosts. */
export function rightsizeFor(cloud             , vcpu        , ramGib        , o                   = {})                      {
  const cpu = Math.max(1, Math.ceil(vcpu), Math.ceil(o.minVcpu ?? 0));
  const ram = o.memoryBasis === 'active' ? Math.max(2, ramGib * 1.2) : ramGib;
  if (!o.licenceOptimised) return rightsize(cloud, cpu, ram);

  const needRam = Math.max(1, Math.ceil(ram));
  const cores = Math.ceil(cpu / 2);
  if (cloud === 'oci') {
    const ocpus = Math.max(1, cores, Math.ceil(needRam / OCI_FLEX.maxGbPerOcpu));
    if (ocpus > OCI_FLEX.maxOcpus || needRam > OCI_FLEX.maxMemoryGb) return null;
    return { type: OCI_FLEX.name, vcpu: ocpus * 2, ramGib: needRam, ocpus };
  }
  if (cloud === 'azure') {
    const parent = AZURE_EDSV5.filter((t) => t.ramGib >= needRam && t.vcpu >= cores).sort((a, b) => a.vcpu - b.vcpu)[0];
    if (!parent) return null;
    const variant = AZURE_CONSTRAINED_LADDER.filter((c) => c.parent === parent.name && c.vcpu >= cores).sort((a, b) => a.vcpu - b.vcpu)[0];
    if (!variant) return { type: parent.name, vcpu: parent.vcpu, ramGib: parent.ramGib };
    return { type: variant.name, vcpu: variant.vcpu, ramGib: variant.ramGib, coreCount: variant.vcpu, constrained: parent.name };
  }
  // Two threads per core: the type must have at least `cores` physical cores.
  const fit = memoryFamily(cloud)
    .filter((t) => t.ramGib >= needRam && t.vcpu >= cores * 2)
    .sort((a, b) => a.vcpu - b.vcpu)[0];
  if (!fit) return null;
  return { type: fit.name, vcpu: cores * 2, ramGib: fit.ramGib, coreCount: cores };
}
