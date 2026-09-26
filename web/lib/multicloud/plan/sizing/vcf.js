/**
 * The `vcf` engine (addendum A.2.8.7): components whose target is VMware Cloud
 * Foundation are fitted into a workload-domain cluster by the VCF Sizing
 * page's own functions — `sizeWorkloadDomain` (which runs `sizeWorkloadCluster`
 * and `fitCluster`) and `computeLicensing` from `src/vcf/sizing.ts` — so the
 * host counts are the numbers VCF Sizing gives for the same input.
 *
 * The host spec, ratios and failures are dropdowns seeded from the VCF Sizing
 * page's defaults (`SIZING_FORM_DEFAULTS`: 2 × 32 cores, 1,024 GiB, 15,360 GiB
 * raw vSAN, vSAN ESA) and its workload-cluster defaults (4:1 vCPU per core,
 * 90 % memory ceiling, N+1).
 */

import { info,              } from '../../../core/findings.js';
import {
  computeLicensing, computeStorage, sizeWorkloadDomain, WORKLOAD_CLUSTER_DEFAULTS,
                                                                                                        
} from '../../../vcf/sizing.js';
                                                                                                                         
                                               
import {
  isPattern, num, policyOf, reason, rec, serverDemand, serversOf, str,                      
} from './server.js';

/** The VCF Sizing page's default host (SIZING_FORM_DEFAULTS in src/ui/vcf-sizing-form.ts). */
export const VCF_HOST_DEFAULT           = Object.freeze({ cpuSockets: 2, coresPerCpu: 32, hyperthreading: true, ramGib: 1024, rawStorageGib: 15360 });
export const VCF_STORAGE_DEFAULT              = 'vsan-esa';

                            
                        
                          
                              
                       
 

                             
                        
                          
                                
                            
                                 
                                   
                                                                                     
                                                                            
 

const STORAGE_TYPES                         = ['vsan-esa', 'vsan-osa', 'nfs', 'vmfs-fc'];

/** The options for a component: its `vcf.*` settings over the page defaults. */
export function vcfOptionsOf(c                          , policy                 , name = 'wld01')             {
  const g = (k        , d        )         => (c ? num(c, k, d) : d);
  const storage = (c ? str(c, 'vcf.storage', VCF_STORAGE_DEFAULT) : VCF_STORAGE_DEFAULT)               ;
  const failures = g('vcf.hostFailures', WORKLOAD_CLUSTER_DEFAULTS.hostFailures);
  return {
    name,
    host: {
      cpuSockets: g('vcf.cpuSockets', VCF_HOST_DEFAULT.cpuSockets),
      coresPerCpu: g('vcf.coresPerCpu', VCF_HOST_DEFAULT.coresPerCpu),
      hyperthreading: VCF_HOST_DEFAULT.hyperthreading,
      ramGib: g('vcf.ramGib', VCF_HOST_DEFAULT.ramGib),
      rawStorageGib: g('vcf.rawStorageGib', VCF_HOST_DEFAULT.rawStorageGib),
    },
    storage: STORAGE_TYPES.includes(storage) ? storage : VCF_STORAGE_DEFAULT,
    cpuRatio: g('vcf.cpuRatio', WORKLOAD_CLUSTER_DEFAULTS.cpuRatio),
    memoryCeiling: g('vcf.memoryCeiling', WORKLOAD_CLUSTER_DEFAULTS.memoryCeiling),
    hostFailures: (failures === 0 || failures === 2 ? failures : 1)             ,
    ...(policy.growthPctYear > 0 ? { growth: { storagePct: policy.growthPctYear, years: policy.horizonYears } } : {}),
  };
}

/** The workload-domain input VCF Sizing would take for this demand. Exported so the test can hand the same input to `sizeWorkloadDomain`. */
export function vcfDomainInput(d           , o            )                      {
  return {
    name: o.name,
    vms: d.vms,
    clusters: [{
      name: `${o.name}-cl01`,
      vcpu: d.vcpu,
      ramGib: d.ramGib,
      storageGib: d.storageGib,
      host: o.host,
      storage: o.storage,
      cpuRatio: o.cpuRatio,
      memoryCeiling: o.memoryCeiling,
      hostFailures: o.hostFailures,
      ...(o.growth ? { growth: { storagePct: o.growth.storagePct, years: o.growth.years } } : {}),
    }],
  };
}

                            
                                        
                         
                           
                                 
                         
 

/** Fit a demand exactly as VCF Sizing does. */
export function sizeVcfDemand(d           , o            )            {
  const domain = sizeWorkloadDomain(vcfDomainInput(d, o));
  const cluster = domain.clusters[0] ;
  const fit             = { hosts: cluster.hosts, byCpu: cluster.byCpu, byMemory: cluster.byMemory, byStorage: cluster.byStorage, minimum: cluster.minimum, binding: cluster.binding === 'fixed' ? 'cpu' : cluster.binding, ...(cluster.storage.raid ? { raid: cluster.storage.raid } : {}) };
  const licensing = computeLicensing(cluster.hosts, o.host, false, o.storage === 'vsan-esa' || o.storage === 'vsan-osa');
  return { domain, hosts: domain.hosts, fit, billableCores: licensing.billableCores, ...(cluster.storage.raid ? { raid: cluster.storage.raid } : {}) };
}

/** The vSAN policy and raw multiplier a volume gets on a cluster of `hosts` (the VCF Sizing storage model). */
export function vsanPolicyFor(o            , hosts        , gib        )                                                       {
  const s = computeStorage(o.storage, 'standard', Math.max(3, hosts), o.host, o.hostFailures, gib);
  return { raid: s.raid, multiplier: s.multiplier, rawGib: s.rawRequiredGib };
}

/** A component's demand on VCF: the server engine's VM sizes, summed, and the provisioned disks. */
export function vcfDemandOf(workloads                     , policy                 , activeMemory = false)            {
  let vcpu = 0;
  let ramGib = 0;
  let storageGib = 0;
  for (const w of workloads) {
    const d = serverDemand(w, policy, { activeMemory });
    vcpu += d.vcpu;
    ramGib += d.ramGib;
    storageGib += w.disksGib.reduce((s, g) => s + Math.max(0, g), 0);
  }
  return { vcpu, ramGib, storageGib, vms: workloads.length };
}

                           
                             
                                          
                               
                                 
 

export function vcfRow(key        , d           , o            )                                                             {
  const s = sizeVcfDemand(d, o);
  const cl = s.domain.clusters[0] ;
  const reasons                 = [
    reason(`${d.vms} VM(s): ${d.vcpu} vCPU, ${Math.round(d.ramGib)} GiB, ${Math.round(d.storageGib)} GiB of disk.`),
    reason(`${s.hosts} hosts of ${o.host.cpuSockets} × ${o.host.coresPerCpu} cores / ${o.host.ramGib} GiB at ${o.cpuRatio}:1 vCPU per core, ${Math.round(o.memoryCeiling * 100)}% memory ceiling, N+${o.hostFailures}; bound by ${cl.binding} (VCF Sizing's sizeWorkloadDomain).`, { source: 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/design.html' }),
    reason(`${s.billableCores} licensed cores (computeLicensing).`),
    reason('Host spec and ratios are VCF Sizing page defaults unless set on the component; Open in VCF Sizing for the fleet view.', { assumption: true }),
  ];
  return {
    row: {
      key, demand: { vcpu: d.vcpu, ramGib: Math.round(d.ramGib), storageGib: Math.round(d.storageGib), vms: d.vms },
      choice: `${s.hosts} hosts`,
      detail: {
        hosts: s.hosts, byCpu: s.fit.byCpu, byMemory: s.fit.byMemory, byStorage: s.fit.byStorage, minimum: s.fit.minimum, binding: cl.binding,
        billableCores: s.billableCores, vcenterSize: s.domain.vcenterSize, storage: o.storage, ...(s.raid ? { raid: s.raid } : {}),
        cpuRatio: Number(cl.cpuRatio.toFixed(2)), memoryUtilization: Number(cl.memoryUtilization.toFixed(2)),
      },
      fits: s.domain.findings.every((f) => f.severity !== 'error'),
      reasons,
      alternatives: [`${s.hosts + 1} hosts`],
    },
    findings: [...s.domain.findings],
    sizing: s,
  };
}

export const vcfEngine                         = {
  id: 'vcf',
  platforms: ['vmware'],
  applies: (c) => isPattern(c) && c.servers.length > 0 && c.tierPattern !== 'containers',
  inputs: (c, plan) => ({
    component: c.id,
    workloads: serversOf(c, plan),
    options: vcfOptionsOf(c, policyOf(plan), `wld-${c.id.split(':').pop() ?? 'app'}`),
    activeMemory: plan.requirements.sizeBy === 'active-memory',
  }),
  size(input, platform          , policy)                       {
    const d = vcfDemandOf(input.workloads, policy, input.activeMemory);
    const r = vcfRow(`vcf:${input.component}`, d, input.options);
    return rec('vcf', platform, [r.row], [...r.findings, info('size.vcf.open-in-sizing', 'For the whole fleet (management domain, every workload domain), open the plan in VCF Sizing.')]);
  },
};

/** The whole VMware target as one workload domain: every workload decided to vmware. */
export function sizeVcfTarget(plan      , workloads                      )                                                             {
  const policy = policyOf(plan);
  const list = workloads ?? plan.workloads.filter((w) => plan.decision?.items[w.id]?.chosen?.platform === 'vmware');
  return vcfRow('vcf:target', vcfDemandOf(list, policy, plan.requirements.sizeBy === 'active-memory'), vcfOptionsOf(undefined, policy, 'wld01'));
}
