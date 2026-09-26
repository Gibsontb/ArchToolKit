/**
 * Relocate: the workloads moving by HCX / vMotion to a VMware service on the
 * platform (Amazon EVS, AVS, GCVE, OCVS) or to VCF on owned hardware, with a
 * naive node count:
 *
 *   nodes = max(minimum, ceil(max(ΣvCPU / (cores × 4), ΣRAM / usable)))
 *
 * with 4 vCPU per core and usable memory 80% of the host's (vSAN and N+1
 * headroom). This is a first figure for the card; the real sizing is the VCF
 * Sizing handoff (`inventory-to-sizing`).
 */

import { info,              } from '../../../core/findings.js';
import { vmwareCloudService } from '../../vmware-on-cloud.js';
                                                      
                                               

                               
                        
                         
                          
                           
 

/**
 * The host each service's estimate assumes (verify: the providers offer more
 * than one host type, and minimums change). VCF on owned hardware assumes a
 * common 2-socket host.
 */
export const RELOCATE_HOSTS                                           = {
  aws: { host: 'i4i.metal', cores: 64, ramGib: 1024, minimum: 4 },
  azure: { host: 'AV36P', cores: 36, ramGib: 768, minimum: 3 },
  google: { host: 've1-standard-72', cores: 36, ramGib: 768, minimum: 3 },
  oci: { host: 'BM.DenseIO.E4.128', cores: 128, ramGib: 2048, minimum: 3 },
  vmware: { host: '2-socket host (assumed)', cores: 32, ramGib: 1024, minimum: 4 },
};

export const VCPU_PER_CORE = 4;
export const USABLE_RAM = 0.8;

/** The naive node count for a set of workloads on a platform's VMware service. */
export function relocateNodes(platform          , workloads                                              )         {
  if (workloads.length === 0) return 0;
  const h = RELOCATE_HOSTS[platform];
  const cpu = workloads.reduce((s, w) => s + w.vcpu, 0);
  const ram = workloads.reduce((s, w) => s + w.ramGib, 0);
  return Math.max(h.minimum, Math.ceil(Math.max(cpu / (h.cores * VCPU_PER_CORE), ram / (h.ramGib * USABLE_RAM))));
}

/** The service name on a platform. */
export function relocateService(platform          )         {
  return vmwareCloudService(platform)?.name ?? 'VMware Cloud Foundation (owned hardware)';
}

export const relocateMapper               = {
  id: 'relocate',
  map(ctx, design) {
    const findings            = [];
    if (ctx.relocating.length === 0) {
      const { relocate: _drop, ...rest } = design;
      return { design: rest, findings };
    }
    const service = relocateService(ctx.platform);
    const nodes = relocateNodes(ctx.platform, ctx.relocating);
    const h = RELOCATE_HOSTS[ctx.platform];
    findings.push(info('design.relocate.estimate', `${ctx.relocating.length} workload${ctx.relocating.length === 1 ? '' : 's'} relocate to ${service}: about ${nodes} ${h.host} hosts (a naive estimate; size it in VCF Sizing).`));
    if (ctx.platform === 'aws') {
      findings.push(info('design.relocate.evs-runbook', 'Amazon EVS has no Terraform resource in the AWS provider used here: the environment is built from the runbook.'));
    }
    return { design: { ...design, relocate: { service, nodes } }, findings };
  },
};
