/**
 * The `load` engine (addendum A.2.10): sizing a new application from its load
 * profile instead of source servers.
 *
 * Every constant here is a planning assumption: labelled as one in the reasons,
 * editable in `#sizing` → Assumptions (`SizingPolicy.assumptions`, by the keys
 * of `LOAD_ASSUMPTIONS`), and marked "replace with your load-test numbers".
 */

import { info,              } from '../../../core/findings.js';
                                                                                                                 
                                               
import { planCluster, k8sRows, k8sSettingsOf } from './k8s.js';
                                                   
import { appPlanOf, chooseInstance, isPattern, rec, reason,                      } from './server.js';

/** Planning assumptions (A.2.10), by key; `policy.assumptions` overrides any of them. */
export const LOAD_ASSUMPTIONS                                   = Object.freeze({
  'rpsPerVcpu.static': 500,
  'rpsPerVcpu.light': 100,
  'rpsPerVcpu.typical': 40,
  'rpsPerVcpu.heavy': 10,
  targetUtil: 0.6,
  vcpuPerInstance: 2,
  gibPerVcpu: 4,
  dbStorageHeadroom: 1.2,
  iopsPerTps: 10,
  tpsPerDbVcpu: 250,
  dbGibPerVcpu: 8,
  fnDurationMs: 200,
  fnMemoryMb: 512,
  replicaCpuMillis: 500,
  replicaMemMib: 1024,
});

const ASSUME = 'planning assumption; replace with your load-test numbers';
const a = (text        )               => reason(`${text} (${ASSUME}).`, { assumption: true });

                            
                                   
                      
                              
 

/** Zones for an availability SLO: 99.9 % or more → 2, 99.99 % → 3 (and a DR region). */
export function zonesForSlo(slo                    )         {
  return slo === '99.99' ? 3 : slo === '99.9' || slo === '99.95' ? 2 : 1;
}

export function sizeFromLoad(input           , platform          , policy                 )                                             {
  const rows              = [];
  const findings            = [];
  const k = (key        )         => policy.assumptions[key] ?? LOAD_ASSUMPTIONS[key] ;
  const l = input.load;
  const c = input.component;
  if (!l) return { rows, findings: [info('size.load.no-profile', `${c.name}: the app has no load profile; enter one to size it.`)] };
  const tp = isPattern(c) ? c.tierPattern : undefined;
  const cost            = l.costClass ?? 'typical';
  const rpsPerVcpu = k(`rpsPerVcpu.${cost}`);
  const util = k('targetUtil');
  const zones = zonesForSlo(l.slo);
  const nonprod = (n        )         => Math.max(1, Math.ceil(n * l.nonprodPct / 100));
  if (l.slo === '99.99') findings.push(info('size.load.dr-region', `${c.name}: a 99.99% SLO takes three zones and a DR region.`));

  if (tp === 'managed-db' || c.tier === 'data') {
    const growth = (1 + (l.growthPctYear ?? 0) / 100) ** (l.horizonYears ?? 3);
    const storage = Math.ceil((l.dataGib ?? 0) * growth * k('dbStorageHeadroom'));
    const iops = Math.ceil((l.tps ?? 0) * k('iopsPerTps'));
    const vcpu = Math.max(2, Math.ceil((l.tps ?? 0) / k('tpsPerDbVcpu')));
    rows.push({
      key: `load:${c.id}:db`, demand: { tps: l.tps ?? 0, dataGib: l.dataGib ?? 0 }, choice: `${vcpu} vCPU / ${vcpu * k('dbGibPerVcpu')} GiB, ${storage} GiB, ${iops} IOPS`,
      detail: { vcpu, ramGib: vcpu * k('dbGibPerVcpu'), storageGib: storage, iops, zones },
      fits: true,
      reasons: [
        a(`Storage ${l.dataGib ?? 0} GiB × (1 + ${l.growthPctYear ?? 0}%)^${l.horizonYears ?? 3} × ${k('dbStorageHeadroom')} → ${storage} GiB`),
        a(`IOPS ${l.tps ?? 0} TPS × ${k('iopsPerTps')} → ${iops}`),
        a(`vCPU ${l.tps ?? 0} TPS ÷ ${k('tpsPerDbVcpu')} per vCPU → ${vcpu}; ${k('dbGibPerVcpu')} GiB per vCPU`),
      ],
      alternatives: [],
    });
    return { rows, findings };
  }

  const rps = l.peakRps ?? Math.ceil((l.concurrentUsers ?? l.users ?? 0) / 10);
  if (l.peakRps === undefined) findings.push(info('size.load.rps-from-users', `${c.name}: no peak requests/s; ${rps} assumed from users (one request per user every 10 s).`));

  if (tp === 'serverless') {
    const concurrency = Math.max(1, Math.ceil(rps * k('fnDurationMs') / 1000));
    rows.push({
      key: `load:${c.id}:functions`, demand: { rps }, choice: `${k('fnMemoryMb')} MB × ${concurrency} concurrent`,
      detail: { memoryMb: k('fnMemoryMb'), concurrency }, fits: true,
      reasons: [a(`Concurrency ${rps} rps × ${k('fnDurationMs')} ms → ${concurrency}`), a(`${k('fnMemoryMb')} MB per function`)],
      alternatives: [],
    });
    return { rows, findings };
  }

  if (tp === 'containers') {
    const perReplica = rpsPerVcpu * (k('replicaCpuMillis') / 1000) * util;
    const replicas = Math.max(zones, Math.ceil(rps / perReplica));
    const synthetic                = [{ name: `${c.id}/app`, kind: 'Deployment', replicas, cpuRequestM: k('replicaCpuMillis'), cpuLimitM: k('replicaCpuMillis') * 2, memRequestMib: k('replicaMemMib'), memLimitMib: k('replicaMemMib'), arch: 'any', pool: 'user' }];
    const settings = { ...k8sSettingsOf(c, input.plan, platform), zones: Math.max(zones, 1) };
    const p = planCluster(platform, synthetic, settings, policy);
    rows.push({
      key: `load:${c.id}:replicas`, demand: { rps }, choice: `${replicas} replicas`, detail: { replicas, rpsPerReplica: Math.round(perReplica) }, fits: true,
      reasons: [a(`${rps} rps ÷ (${rpsPerVcpu} rps per vCPU (${cost}) × ${k('replicaCpuMillis')}m × ${util}) → ${replicas} replicas, at least one per zone`)],
      alternatives: [],
    });
    rows.push(...k8sRows(c.id, p, platform, settings.targetUtil));
    findings.push(...p.findings);
    return { rows, findings };
  }

  // VMs / PaaS web: instances of vcpuPerInstance.
  const vcpu = k('vcpuPerInstance');
  const instances = Math.max(zones, Math.ceil(rps / (rpsPerVcpu * vcpu * util)));
  const ch = tp === 'paas-web' ? null : chooseInstance(platform, vcpu, vcpu * k('gibPerVcpu'), { families: policy.families, allowArm: policy.allowArm, latest: policy.latestGeneration, burstable: false });
  rows.push({
    key: `load:${c.id}:instances`, demand: { rps },
    choice: ch?.fit ? `${instances} × ${ch.fit.type}` : `${instances} × ${vcpu} vCPU / ${vcpu * k('gibPerVcpu')} GiB`,
    detail: { instances, vcpu, ramGib: vcpu * k('gibPerVcpu'), zones, nonprodInstances: nonprod(instances), ...(ch?.fit ? { type: ch.fit.type } : {}) },
    fits: tp === 'paas-web' || !!ch?.fit,
    reasons: [
      a(`${rps} rps ÷ (${rpsPerVcpu} rps per vCPU (${cost}) × ${vcpu} vCPU × ${util} target utilisation) → ${Math.ceil(rps / (rpsPerVcpu * vcpu * util))}`),
      a(`At least ${zones} for the ${l.slo ?? '99.0'}% SLO (one per zone: 99.9% or more → 2 zones, 99.99% → 3)`),
      a(`Nonprod at ${l.nonprodPct}% → ${nonprod(instances)}`),
      ...(ch?.reasons ?? []),
    ],
    alternatives: ch?.alternatives ?? [],
  });
  return { rows, findings };
}

export const loadEngine                          = {
  id: 'load',
  applies: (c, plan) => appPlanOf(c, plan)?.origin === 'new',
  inputs(c, plan) {
    const ap = appPlanOf(c, plan);
    return { component: c, plan, ...(ap?.load ? { load: ap.load } : {}) };
  },
  size(input, platform, policy) {
    const r = sizeFromLoad(input, platform, policy);
    return rec('load', platform, r.rows, r.findings);
  },
};
