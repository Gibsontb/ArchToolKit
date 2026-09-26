/**
 * The `storage` engine (addendum A.2.8.4): every volume sized by capacity and
 * by performance.
 *
 * - Capacity: provisioned, or used × (1 + headroom); then × (1 + growth)^years.
 * - IOPS / throughput: the disk's own p95 (per-disk data); otherwise the VM's
 *   p95 split by the disk's share of capacity, the boot disk taking at least
 *   10 %. As-is sizing (or no usable data) sizes by capacity alone.
 * - Tier: the first in the platform's order (storage-tiers.ts) that carries all
 *   three at that capacity. Provisioned tiers may grow to the size their
 *   IOPS-per-GiB ceiling needs; fixed tiers round up to the size sold; scaled
 *   tiers (Persistent Disk, OCI VPU) are not grown — the level is chosen
 *   first, then the size (A.2.8.4).
 * - Tier-0 / tier-1 database data volumes start at the latency floor WP-4's
 *   design gives them (io2, Premium SSD v2, pd-ssd, VPU 20).
 * - OS disks never go on a tier that cannot boot (Premium SSD v2, Ultra).
 * - VMware: the vSAN policy and raw capacity from VCF Sizing's storage model.
 */

import { warning,              } from '../../../core/findings.js';
import { instanceSpec,                   } from '../../../kit/instance-specs.js';
import { DEFAULT_VSPHERE_POLICY } from '../design/compute.js';
import { overrideKey } from '../options.js';
import { osKind } from '../os.js';
                                                                                                                                       
                                               
import {
  gib, isPattern, isProd, MIN_COVERAGE, MIN_DAYS, policyOf, reason, rec, serversOf,                      
} from './server.js';
import { DB_LATENCY_FLOOR, STORAGE_TIERS,               } from './storage-tiers.js';
import { sizeVcfDemand, vcfDemandOf, vcfOptionsOf, vsanPolicyFor } from './vcf.js';

/** Boot-disk floors, GiB (the platforms' image sizes; the same table as design/compute.ts). */
const BOOT_MIN                                                                                   = {
  aws: { windows: 30, linux: 8 }, azure: { windows: 128, linux: 30 }, google: { windows: 50, linux: 10 }, oci: { windows: 256, linux: 50 }, vmware: { windows: 1, linux: 1 },
};

                               
                          
                         
                       
                            
                                  
                           
                        
                        
                         
                                              
                                    
                                   
                                            
 

/** Growth factor over the horizon. */
export const growthFactor = (p              )         => (1 + p.growthPctYear / 100) ** p.horizonYears;

/** The volumes of a workload, with their demand. */
export function volumeDemands(w          , platform          , policy                 , o                                                      = {})                 {
  const kind = osKind(w.os) === 'windows' ? 'windows' : 'linux';
  const disks = w.disksGib.length > 0 ? w.disksGib : [kind === 'windows' ? 128 : 64];
  const used = w.facts?.disksUsedGib;
  const u = w.facts?.utilisation;
  const perf = !!u && u.days >= MIN_DAYS && u.coverage >= MIN_COVERAGE && policy.mode !== 'as-is' && policy.basis !== 'allocated';
  const total = disks.reduce((s, g) => s + Math.max(0, g), 0) || 1;
  const headroom = 1 + policy.headroomPct / 100;
  const grow = growthFactor(policy);
  const spec = o.machineType && platform !== 'vmware' ? instanceSpec(platform                , o.machineType) : undefined;

  // Split the VM's IOPS / MB/s: boot at least 10 %, the rest by capacity.
  const shares = disks.map((g) => Math.max(0, g) / total);
  if (shares.length > 1 && shares[0]  < 0.1) {
    const rest = 1 - shares[0] ;
    const scale = 0.9 / rest;
    for (let i = 1; i < shares.length; i += 1) shares[i] = shares[i]  * scale;
    shares[0] = 0.1;
  }

  return disks.map((g, i) => {
    const reasons                 = [];
    const os = i === 0;
    const u0 = used?.[i];
    let base = Math.max(0, g);
    if (policy.diskBasis === 'used-plus-headroom' && u0 !== undefined) {
      base = u0 * headroom;
      reasons.push(reason(`Used ${gib(u0)} GiB × ${headroom.toFixed(2).replace(/0$/, '')} headroom → ${gib(base)} GiB.`));
    } else {
      reasons.push(reason(`Provisioned ${gib(base)} GiB.`));
    }
    let size = Math.ceil(base * grow);
    if (grow > 1) reasons.push(reason(`Growth ${policy.growthPctYear}%/year over ${policy.horizonYears} years (× ${grow.toFixed(3)}) → ${size} GiB.`, { assumption: true }));
    if (os) size = Math.max(size, BOOT_MIN[platform][kind]);

    let iops = 0;
    let mbps = 0;
    if (perf) {
      const d = u .perDisk?.find((p) => p.disk === i);
      if (d && (d.iopsP95 !== undefined || d.mbpsP95 !== undefined)) {
        iops = d.iopsP95 ?? 0;
        mbps = d.mbpsP95 ?? 0;
        reasons.push(reason(`Disk p95: ${Math.round(iops)} IOPS, ${Math.round(mbps)} MB/s.`));
      } else if (u .iopsP95 !== undefined || u .mbpsP95 !== undefined) {
        iops = (u .iopsP95 ?? 0) * shares[i] ;
        mbps = (u .mbpsP95 ?? 0) * shares[i] ;
        reasons.push(reason(`${Math.round(shares[i]  * 100)}% of the VM's p95 (${Math.round(u .iopsP95 ?? 0)} IOPS, ${Math.round(u .mbpsP95 ?? 0)} MB/s) by capacity share${os ? ', boot at least 10%' : ''}.`));
      }
      iops = Math.ceil(iops * headroom);
      mbps = Math.ceil(mbps * headroom);
    } else {
      reasons.push(reason('No usable per-disk performance data (or as-is sizing): sized by capacity.'));
    }
    return {
      server: w.name, index: i, os, ...(u0 !== undefined ? { usedGib: u0 } : {}), provisionedGib: g, sizeGib: size, iops, mbps,
      prod: isProd(w.env), latencyCritical: !os && !!o.latencyCritical, ...(spec?.hyperdiskOnly ? { hyperdiskOnly: true } : {}), reasons,
    };
  });
}

                          
                          
                           
                                    
                                    
                                                                  
                         
 

/** Does a tier carry the demand, and at what size / provisioning. */
export function fitTier(t          , d                                                 )                 {
  let size = Math.max(d.sizeGib, t.minGib);
  if (size > t.maxGib) return null;
  if (t.sizes) {
    const pick = t.sizes.find(([g, iops, mbps]) => g >= size && iops >= d.iops && mbps >= d.mbps);
    // Round up to the size sold, allowing one step up for performance.
    const bySize = t.sizes.findIndex(([g]) => g >= size);
    if (!pick || t.sizes.indexOf(pick) > bySize + 1) return null;
    return { tier: t, sizeGib: pick[0], perf: { iops: pick[1], mbps: pick[2] }, label: pick[3] };
  }
  if (t.provisioned) {
    const ratio = t.mbpsPerIops ?? 0.25;
    // Throughput is capped at `ratio` MB/s per provisioned IOPS: raise IOPS to reach it.
    const forMbps = d.mbps > t.perf(size).baseMbps ? Math.ceil(d.mbps / ratio) : 0;
    const iops = Math.max(t.perf(size).baseIops, d.iops, forMbps);
    // Grow to the size the IOPS-per-GiB ceiling needs.
    if (t.iopsPerGib && iops > t.perf(size).maxIops) size = Math.max(size, Math.ceil(iops / t.iopsPerGib));
    if (size > t.maxGib) return null;
    const p = t.perf(size);
    const mbps = Math.max(p.baseMbps, d.mbps);
    if (iops > p.maxIops || mbps > p.maxMbps || mbps > Math.max(p.baseMbps, iops * ratio)) return null;
    return { tier: t, sizeGib: size, provisionedIops: iops, provisionedMbps: Math.ceil(mbps), perf: { iops, mbps }, label: t.label };
  }
  const p = t.perf(size);
  if (p.maxIops < d.iops || p.maxMbps < d.mbps) return null;
  return { tier: t, sizeGib: size, perf: { iops: Math.floor(p.maxIops), mbps: Math.floor(p.maxMbps) }, label: t.label };
}

/** The cheapest tier (by the platform's order) that carries a volume. */
export function chooseTier(platform                             , d              , o                      = {})                                                                      {
  const tiers = STORAGE_TIERS[platform];
  const floor = d.latencyCritical ? tiers.findIndex((t) => t.id === DB_LATENCY_FLOOR[platform]) : 0;
  const skipped           = [];
  const fits            = [];
  tiers.forEach((t, i) => {
    if (i < floor) { skipped.push(`${t.id}: below the latency floor for a tier-0/1 database volume`); return; }
    if (d.os && !t.osDisk) { skipped.push(`${t.id}: cannot be the OS disk`); return; }
    if (d.prod && t.nonprodOnly) { skipped.push(`${t.id}: nonprod only`); return; }
    if (t.zonal && o.zonal === false) { skipped.push(`${t.id}: needs a zonal VM`); return; }
    if (t.persistentDisk && d.hyperdiskOnly) { skipped.push(`${t.id}: the machine series attaches Hyperdisk only`); return; }
    const f = fitTier(t, d);
    if (f) fits.push(f);
    else skipped.push(`${t.id} does not carry ${d.iops} IOPS / ${d.mbps} MB/s at ${d.sizeGib} GiB`);
  });
  return { fit: fits[0] ?? null, alternatives: fits.slice(1, 4), skipped };
}

/** One volume row. */
export function volumeRow(platform          , d              , o                                                                                   = {})                                          {
  const key = `volume:${d.server}:${d.index}`;
  const demand = { sizeGib: d.sizeGib, iops: d.iops, mbps: d.mbps, ...(d.usedGib !== undefined ? { usedGib: d.usedGib } : {}), provisionedGib: d.provisionedGib };
  if (platform === 'vmware') {
    const v = o.vsan ?? { policy: DEFAULT_VSPHERE_POLICY, raid: 'RAID-5 (2+1)', multiplier: 1.5 };
    return {
      row: {
        key, demand, choice: v.policy,
        detail: { server: d.server, disk: d.index, os: d.os ? 'yes' : 'no', sizeGib: d.sizeGib, raid: v.raid, rawGib: Math.ceil(d.sizeGib * v.multiplier) },
        fits: true,
        reasons: [...d.reasons, reason(`vSAN ${v.raid}: ${d.sizeGib} GiB takes ${Math.ceil(d.sizeGib * v.multiplier)} GiB raw (× ${v.multiplier.toFixed(2)}).`, { source: 'https://techdocs.broadcom.com/us/en/vmware-cis/vsan/vsan/8-0/vsan-administration/using-vsan-policies.html' })],
        alternatives: [],
      },
      findings: [],
    };
  }
  const c = chooseTier(platform, d, o);
  const findings            = [];
  const f = c.fit;
  if (!f) {
    findings.push(warning('size.volume.no-tier', `${d.server} disk ${d.index}: no ${platform} tier carries ${d.sizeGib} GiB at ${d.iops} IOPS / ${d.mbps} MB/s; split it across volumes (striped) or pick a tier by hand.`, { path: overrideKey('compute', d.server, 'disks') }));
  }
  const reasons = [...d.reasons];
  if (d.latencyCritical) reasons.push(reason(`A tier-0/1 database volume starts at ${DB_LATENCY_FLOOR[platform]} (sub-millisecond / higher-durability tier).`, { source: 'https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html' }));
  if (f) {
    const skipped = c.skipped.slice(0, 2);
    reasons.push(reason(`${f.label}${f.provisionedIops ? ` with ${f.provisionedIops} IOPS / ${f.provisionedMbps} MB/s provisioned` : ` (${f.perf.iops} IOPS, ${f.perf.mbps} MB/s)`} at ${f.sizeGib} GiB${skipped.length ? `; ${skipped.join('; ')}` : ''}.`, { source: f.tier.source }));
  }
  return {
    row: {
      key, demand, choice: f?.tier.id ?? '',
      detail: {
        server: d.server, disk: d.index, os: d.os ? 'yes' : 'no', sizeGib: f?.sizeGib ?? d.sizeGib,
        ...(f ? { tier: f.label } : {}),
        ...(f?.provisionedIops !== undefined ? { provisionedIops: f.provisionedIops, provisionedMbps: f.provisionedMbps ?? 0 } : {}),
        ...(f?.tier.vpusPerGb !== undefined ? { vpusPerGb: f.tier.vpusPerGb } : {}),
      },
      fits: !!f,
      reasons,
      alternatives: c.alternatives.map((a) => a.tier.id),
    },
    findings,
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

                               
                                   
                                          
                                                             
                                                
                      
 

export const storageEngine                             = {
  id: 'storage',
  applies: (c) => isPattern(c) && c.servers.length > 0 && !['containers', 'managed-db', 'file-service', 'vdi-service', 'saas', 'retire', 'retain'].includes(c.tierPattern ?? 'vm'),
  inputs(c, plan) {
    const workloads = serversOf(c, plan);
    const critical = new Set        ();
    for (const db of plan.databases) {
      if (!db.hosts.some((h) => workloads.some((w) => w.name === h))) continue;
      for (const h of db.hosts) {
        const w = workloads.find((x) => x.name === h);
        if (w && (w.criticality === 'tier0' || w.criticality === 'tier1')) critical.add(h);
      }
    }
    return { component: c, workloads, latencyCritical: critical, plan };
  },
  size(input, platform, policy) {
    const rows              = [];
    const findings            = [];
    let vsan                                                                  ;
    if (platform === 'vmware') {
      const o = vcfOptionsOf(input.component, policy);
      const hosts = sizeVcfDemand(vcfDemandOf(input.workloads, policy), o).hosts;
      const v = vsanPolicyFor(o, hosts, 1);
      vsan = { policy: input.plan.designOverrides[overrideKey('vmware', 'lz', 'storage-policy')]?.trim() || DEFAULT_VSPHERE_POLICY, raid: v.raid, multiplier: v.multiplier };
    }
    for (const w of input.workloads) {
      for (const d of volumeDemands(w, platform, policy, { latencyCritical: input.latencyCritical.has(w.name) })) {
        const r = volumeRow(platform, d, { zonal: true, ...(vsan ? { vsan } : {}) });
        rows.push(r.row);
        findings.push(...r.findings);
      }
    }
    return rec('storage', platform, rows, findings);
  },
};

/** Size a plan's workload volumes directly (for the #sizing grid across apps). */
export function sizeVolumes(plan      , workloads                     , platform          )                       {
  const policy = policyOf(plan);
  const rows              = [];
  const findings            = [];
  for (const w of workloads) for (const d of volumeDemands(w, platform, policy)) {
    const r = volumeRow(platform, d, { zonal: true });
    rows.push(r.row);
    findings.push(...r.findings);
  }
  return rec('storage', platform, rows, findings)                        ;
}
