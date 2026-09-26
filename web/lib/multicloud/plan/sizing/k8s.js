/**
 * The `k8s` engine (addendum A.2.8.5): node pools from the workloads'
 * requests, pod density per CNI, the IP plan and the control-plane tier.
 *
 * Per pool:
 * - demand = Σ replicas × requests, plus every DaemonSet once per node;
 * - node type from the `server` engine at the pool's memory:CPU ratio;
 * - allocatable = capacity − the provider's kube-reserved − eviction (k8s-data);
 * - count = ceil(demand / (allocatable × target utilisation)), solved with the
 *   DaemonSets per node, raised for pod density (min(CNI ceiling, max-pods)),
 *   at least one per zone for production;
 * - autoscaler min = count, max = ceil(count × 1.5); Σ limits over 2× the
 *   allocatable is an over-commit warning.
 * IP plan: node subnets (sized for pods where the CNI takes pod IPs from them),
 * pod and service ranges that overlap neither the landing zone nor the sites.
 */

import { error, info, warning,              } from '../../../core/findings.js';
import { overlapsAny } from '../../../core/ip.js';
import { formatIPv4, parseCidr } from '../../../core/net.js';
                                                                           
                                               
import {
  CNI_RULES, CONTROL_PLANE_TIERS, DEFAULT_CNI, allocatable, gkeNodePodPrefix,                            
} from './k8s-data.js';
import { parseGrid,                  } from './k8s-import.js';
import { chooseInstance, isPattern, isProd, num, reason, rec, serversOf, str,                      } from './server.js';

                              
                                                     
                              
                                       
                        
                         
                            
                                               
                            
                         
                         
                                                                   
                            
                                                                                          
                                    
                                    
                                   
                         
 

                           
                        
                        
                            
                              
                         
                       
                       
                             
                               
                               
                                
                                  
                              
                                
                        
                              
                                
                                                        
 

                                                                                                        

                          
                                      
                                  
                        
                        
                                        
 

// ---------------------------------------------------------------------------
// IP arithmetic (IPv4)
// ---------------------------------------------------------------------------

const RESERVED_PER_SUBNET                                     = { aws: 5, azure: 5, google: 4, oci: 3, vmware: 3 };
/** The smallest prefix holding `n` addresses. */
export const prefixFor = (n        )         => Math.max(8, Math.min(29, 32 - Math.ceil(Math.log2(Math.max(8, n)))));

/** The first aligned `/prefix` block inside one of `pools` that overlaps nothing in `avoid`. */
export function allocateBlock(prefix        , pools                   , avoid                   )                {
  const size = 2 ** (32 - prefix);
  for (const p of pools) {
    const net = parseCidr(p);
    if (!net || net.prefix > prefix) continue;
    const end = net.network + 2 ** (32 - net.prefix);
    for (let a = net.network; a + size <= end; a += size) {
      const cidr = `${formatIPv4(a >>> 0)}/${prefix}`;
      if (!avoid.some((x) => overlapsAny(x, cidr))) return cidr;
    }
  }
  return null;
}

const OVERLAY_POOLS = ['100.64.0.0/10', '172.16.0.0/12', '10.0.0.0/8'];
const SERVICE_POOLS = ['172.16.0.0/12', '100.64.0.0/10', '10.0.0.0/8'];

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

function sumBy(list                        , f                            )         {
  return list.reduce((s, w) => s + f(w), 0);
}

/** Size one pool. */
function sizePool(platform          , pool        , work                        , daemons                        , s             , cni         , policy                 , findings           , fixedMin = 0)           {
  const reqCpu = sumBy(work, (w) => w.replicas * w.cpuRequestM);
  const reqMem = sumBy(work, (w) => w.replicas * w.memRequestMib);
  const limCpu = sumBy(work, (w) => w.replicas * w.cpuLimitM);
  const limMem = sumBy(work, (w) => w.replicas * w.memLimitMib);
  const pods = sumBy(work, (w) => w.replicas);
  const dsCpu = sumBy(daemons, (w) => w.cpuRequestM);
  const dsMem = sumBy(daemons, (w) => w.memRequestMib);
  const dsPods = daemons.length;
  const biggestCpu = Math.max(0, ...work.map((w) => w.cpuRequestM));
  const biggestMem = Math.max(0, ...work.map((w) => w.memRequestMib));

  // Node shape: the preferred vCPU, big enough for the largest pod, at the pool's memory:CPU ratio (2–8 GiB per vCPU).
  const ratio = reqCpu > 0 ? Math.min(8, Math.max(2, (reqMem / 1024) / (reqCpu / 1000))) : 4;
  let vcpu = Math.max(2, s.nodeVcpu, Math.ceil((biggestCpu + dsCpu) / 1000 / s.targetUtil) + 1);
  let ram = Math.max(vcpu * ratio, Math.ceil((biggestMem + dsMem) / 1024 / s.targetUtil) + 2);
  const arm = work.length > 0 && work.every((w) => w.arch === 'arm64');
  const choice = chooseInstance(platform, vcpu, ram, {
    families: ['general', 'compute', 'memory'], allowArm: arm || (policy.allowArm && work.every((w) => w.arch !== 'amd64')),
    latest: policy.latestGeneration, burstable: false,
    ...(arm ? { filter: (x) => x.arch === 'arm' } : {}),
  });
  const type = choice.fit?.type ?? '';
  if (choice.fit) { vcpu = choice.fit.vcpu; ram = choice.fit.ramGib; }
  else findings.push(warning('size.k8s.no-node-type', `Pool ${pool}: no ${platform} node type has ${vcpu} vCPU / ${Math.ceil(ram)} GiB.`));

  const ceilingByCni = cni.nodeCeiling ? cni.nodeCeiling(choice.fit?.spec) : Number.POSITIVE_INFINITY;
  const podsPerNode = Math.max(1, Math.min(s.maxPods ?? cni.defaultMaxPods, cni.maxPodsLimit, ceilingByCni));
  const a = allocatable(platform, vcpu, ram, podsPerNode);
  const cpuRoom = a.cpuMillis * s.targetUtil - dsCpu;
  const memRoom = a.memMib * s.targetUtil - dsMem;
  if (cpuRoom <= 0 || memRoom <= 0) {
    findings.push(error('size.k8s.daemonsets-exceed-node', `Pool ${pool}: the DaemonSets alone need more than ${Math.round(s.targetUtil * 100)}% of a ${type} node's allocatable.`));
  }
  const byCpu = reqCpu > 0 ? Math.ceil(reqCpu / Math.max(1, cpuRoom)) : 0;
  const byMem = reqMem > 0 ? Math.ceil(reqMem / Math.max(1, memRoom)) : 0;
  const byPods = pods > 0 ? Math.ceil(pods / Math.max(1, podsPerNode - dsPods)) : 0;
  const zonesMin = s.prod ? s.zones : 1;
  const count = Math.max(byCpu, byMem, byPods, zonesMin, fixedMin);
  const binding                      = count === byPods && byPods > Math.max(byCpu, byMem) ? 'pods'
    : count === byMem && byMem >= byCpu && byMem >= zonesMin ? 'memory'
      : count === byCpu && byCpu >= zonesMin ? 'cpu' : 'zones';
  const totalLimCpu = limCpu + dsCpu * count;
  const totalLimMem = limMem + dsMem * count;
  if (totalLimCpu > 2 * a.cpuMillis * count || totalLimMem > 2 * a.memMib * count) {
    findings.push(warning('size.k8s.overcommit', `Pool ${pool}: the limits add up to more than twice the allocatable (${(totalLimCpu / (a.cpuMillis * count)).toFixed(1)}× CPU, ${(totalLimMem / (a.memMib * count)).toFixed(1)}× memory); pods can be evicted or throttled under load.`));
  }
  return {
    pool, type, nodeVcpu: vcpu, nodeRamGib: ram, count, min: count, max: Math.ceil(count * 1.5),
    allocCpuM: Math.floor(a.cpuMillis), allocMemMib: Math.floor(a.memMib), podsPerNode,
    requestsCpuM: reqCpu + dsCpu * count, requestsMemMib: reqMem + dsMem * count, limitsCpuM: totalLimCpu, limitsMemMib: totalLimMem,
    pods: pods + dsPods * count, daemonCpuM: dsCpu, daemonMemMib: dsMem, binding,
  };
}

/** The whole cluster: pools, IP plan and tier. Pure. */
export function planCluster(platform          , workloads                        , s             , policy                 )          {
  const findings            = [];
  const cni = CNI_RULES[s.cni] ?? CNI_RULES[DEFAULT_CNI[platform]];
  if (cni.platform !== platform) findings.push(warning('size.k8s.cni-platform', `${cni.label} is not a ${platform} CNI; ${CNI_RULES[DEFAULT_CNI[platform]].label} is used.`));
  const rule = cni.platform === platform ? cni : CNI_RULES[DEFAULT_CNI[platform]];
  const tiers = CONTROL_PLANE_TIERS[platform];
  const tier = s.tier && tiers.tiers.some((t) => t.id === s.tier) ? s.tier : s.prod ? tiers.prodDefault : tiers.nonprodDefault;
  if (s.prod && !tiers.tiers.find((t) => t.id === tier)?.sla) {
    findings.push(warning('size.k8s.tier-no-sla', `The ${platform} control-plane tier "${tier}" has no SLA; production clusters default to ${tiers.prodDefault}.`, { source: tiers.source }));
  }

  const daemons = workloads.filter((w) => w.kind === 'DaemonSet');
  const byPool = new Map                       ();
  for (const w of workloads) if (w.kind !== 'DaemonSet') byPool.set(w.pool, [...(byPool.get(w.pool) ?? []), w]);
  const pools             = [];
  const autopilot = platform === 'google' && tier === 'autopilot';
  // A system pool: AKS requires one; elsewhere production gets one for cluster add-ons.
  if (!autopilot && (platform === 'azure' || s.prod) && !byPool.has('system')) byPool.set('system', []);
  for (const [pool, work] of [...byPool.entries()].sort(([a], [b]) => (a === 'system' ? -1 : b === 'system' ? 1 : a.localeCompare(b)))) {
    if (autopilot) continue;
    const system = pool === 'system';
    pools.push(sizePool(platform, pool, work, daemons, system ? { ...s, nodeVcpu: Math.min(s.nodeVcpu, 4) } : s, rule, policy, findings, system && s.prod ? s.zones : 0));
  }
  if (autopilot) {
    findings.push(info('size.k8s.autopilot', 'GKE Autopilot sizes and places the nodes; only the pod requests are sized.', { source: tiers.source }));
  }

  // ---- IP plan ----
  const ip            = [];
  const surge = (p          )         => (s.surge === 'one-node' ? 1 : Math.ceil(p.max * 0.25));
  const nodesMax = pools.reduce((n, p) => n + p.max + surge(p), 0) || 3;
  const maxPods = pools.reduce((m, p) => Math.max(m, p.podsPerNode), rule.defaultMaxPods);
  const reserved = RESERVED_PER_SUBNET[platform];
  const zones = Math.max(1, s.zones);
  const perZoneNodes = Math.ceil(nodesMax / zones);
  const avoid = [...s.avoid, ...s.used];
  const taken           = [];
  const addRange = (purpose        , prefix        , pools                   )                => {
    const cidr = allocateBlock(prefix, pools, [...avoid, ...taken]);
    if (cidr) { taken.push(cidr); ip.push({ purpose, cidr, addresses: 2 ** (32 - prefix) }); }
    else findings.push(error('size.k8s.ip-exhausted', `No free /${prefix} for ${purpose} outside the landing zone and the sites.`));
    return cidr;
  };
  const nodeIpsPerZone = rule.addressing === 'node-subnet'
    ? perZoneNodes * (1 + (rule.id === 'eks-vpc-cni-prefix' ? Math.ceil(maxPods / 16) * 16 : maxPods)) + reserved
    : perZoneNodes + reserved;
  const vpc = s.vpcCidr ? [s.vpcCidr] : [];
  if (!s.vpcCidr) findings.push(warning('size.k8s.no-vpc-cidr', 'No landing-zone network was given for the node subnets (k8s.vpcCidr); they are placed in free private space. Give the VPC / VNet / VCN range.'));
  const nodePools = vpc.length > 0 ? vpc : OVERLAY_POOLS.slice().reverse();
  for (let z = 0; z < zones; z += 1) {
    const cidr = allocateBlock(prefixFor(nodeIpsPerZone), nodePools, [...s.used, ...taken, ...s.avoid.filter((x) => !vpc.includes(x))]);
    if (cidr) { taken.push(cidr); ip.push({ purpose: `nodes${rule.addressing === 'node-subnet' ? ' and pods' : ''} (zone ${z + 1})`, cidr, addresses: 2 ** (32 - prefixFor(nodeIpsPerZone)) }); }
    else findings.push(error('size.k8s.ip-exhausted', `The landing-zone network ${s.vpcCidr ?? ''} has no free /${prefixFor(nodeIpsPerZone)} for the zone ${z + 1} node subnet.`));
  }
  if (rule.addressing === 'pod-subnet') {
    for (let z = 0; z < zones; z += 1) {
      const n = perZoneNodes * maxPods + reserved;
      const cidr = allocateBlock(prefixFor(n), nodePools, [...s.used, ...taken, ...s.avoid.filter((x) => !vpc.includes(x))]);
      if (cidr) { taken.push(cidr); ip.push({ purpose: `pods (zone ${z + 1})`, cidr, addresses: 2 ** (32 - prefixFor(n)) }); }
      else findings.push(error('size.k8s.ip-exhausted', `No free /${prefixFor(n)} in ${s.vpcCidr ?? 'the landing zone'} for the zone ${z + 1} pod subnet.`));
    }
  } else if (rule.addressing === 'overlay') {
    const prefix = prefixFor(nodesMax * 256);
    const def = rule.defaultPodCidr && parseCidr(rule.defaultPodCidr) .prefix <= prefix ? [rule.defaultPodCidr] : [];
    addRange('pods (overlay)', prefix, [...def, ...OVERLAY_POOLS]);
  } else if (rule.addressing === 'secondary-range') {
    const per = 2 ** (32 - gkeNodePodPrefix(maxPods));
    addRange('pods (secondary range)', prefixFor(nodesMax * per), OVERLAY_POOLS);
  }
  const svcPrefix = parseCidr(rule.defaultServiceCidr) .prefix;
  addRange('services', svcPrefix, [rule.defaultServiceCidr, ...SERVICE_POOLS]);
  if (s.ipv6) {
    if (rule.dualStack === true) findings.push(info('size.k8s.dual-stack', `${rule.label} runs dual-stack: the IPv6 node, pod and service ranges are allocated by the platform from the network's IPv6 block.`, { source: rule.source }));
    else if (rule.dualStack === 'ipv6-only') findings.push(info('size.k8s.ipv6-cluster', `${rule.label}: EKS runs IPv4 or IPv6 clusters, not dual-stack; this plan is IPv4 (an IPv6 cluster takes pod IPs from the VPC's IPv6 block).`, { source: rule.source }));
    else findings.push(info('size.k8s.no-dual-stack', `${rule.label} is IPv4 here; dual-stack is not offered for it.`, { source: rule.source }));
  }
  // Belt and braces: nothing may overlap the landing zone's other networks or the sites.
  for (const r of ip) {
    const hit = s.avoid.filter((x) => !vpc.includes(x)).find((x) => overlapsAny(x, r.cidr)) ?? s.used.find((x) => overlapsAny(x, r.cidr));
    if (hit) findings.push(error('size.k8s.ip-overlap', `${r.purpose} ${r.cidr} overlaps ${hit}.`));
  }
  return { pools, ip, tier, cni: rule, findings };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

                           
                                   
                      
                                             
                                        
 

const list = (v        )           => v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

export function k8sSettingsOf(c              , plan      , platform          )              {
  const servers = serversOf(c, plan);
  const env = str(c, 'k8s.env', servers[0]?.env ?? 'prod');
  const prod = isProd(env);
  const sites = plan.requirements.sites.flatMap((x) => x.cidrs);
  const cni = str(c, 'k8s.cni', DEFAULT_CNI[platform])           ;
  const maxPods = num(c, 'k8s.maxPods', Number.NaN);
  const vpc = str(c, 'k8s.vpcCidr');
  return {
    targetUtil: Math.min(0.95, Math.max(0.3, num(c, 'k8s.targetUtilPct', 70) / 100)),
    surge: str(c, 'k8s.surge', 'one-node') === '25pct' ? '25pct' : 'one-node',
    cni: CNI_RULES[cni] ? cni : DEFAULT_CNI[platform],
    ...(str(c, 'k8s.tier') ? { tier: str(c, 'k8s.tier') } : {}),
    ...(Number.isFinite(maxPods) ? { maxPods } : {}),
    nodeVcpu: num(c, 'k8s.nodeVcpu', 8),
    zones: num(c, 'k8s.zones', prod ? 3 : 1),
    prod,
    ...(vpc ? { vpcCidr: vpc } : {}),
    avoid: [...list(str(c, 'k8s.lzCidrs')), ...sites],
    used: list(str(c, 'k8s.usedCidrs')),
    ipv6: str(c, 'k8s.ipv6', 'yes') !== 'no',
  };
}

export function k8sRows(component        , p         , platform          , targetUtil = 0.7)              {
  const rows              = p.pools.map((pool) => ({
    key: `pool:${component}:${pool.pool}`,
    demand: { cpuMillis: pool.requestsCpuM, memMib: Math.round(pool.requestsMemMib), pods: pool.pods },
    choice: pool.type,
    detail: {
      count: pool.count, min: pool.min, max: pool.max, nodeVcpu: pool.nodeVcpu, nodeRamGib: pool.nodeRamGib,
      allocCpuMillis: pool.allocCpuM, allocMemMib: pool.allocMemMib, podsPerNode: pool.podsPerNode, binding: pool.binding, cni: p.cni.id,
    },
    fits: pool.allocCpuM * pool.count * targetUtil >= pool.requestsCpuM - 1e-6 && pool.allocMemMib * pool.count * targetUtil >= pool.requestsMemMib - 1e-6,
    reasons: [
      reason(`${pool.count} × ${pool.type}: ${Math.round(pool.requestsCpuM)}m CPU and ${Math.round(pool.requestsMemMib)} MiB requested (DaemonSets ${pool.daemonCpuM}m / ${Math.round(pool.daemonMemMib)} MiB per node) against ${pool.allocCpuM}m / ${pool.allocMemMib} MiB allocatable per node; bound by ${pool.binding}.`),
      reason(`${pool.podsPerNode} pods per node: min(${p.cni.label}'s ceiling, max-pods).`, { source: p.cni.source }),
      reason(`Autoscaler min ${pool.min}, max ${pool.max} (× 1.5).`, { assumption: true }),
    ],
    alternatives: [],
  }));
  rows.push({
    key: `k8s-tier:${component}`, demand: {}, choice: p.tier, detail: { platform },
    fits: true, reasons: [reason(CONTROL_PLANE_TIERS[platform].tiers.find((t) => t.id === p.tier)?.note ?? '', { source: CONTROL_PLANE_TIERS[platform].source })],
    alternatives: CONTROL_PLANE_TIERS[platform].tiers.map((t) => t.id).filter((t) => t !== p.tier),
  });
  for (const r of p.ip) {
    rows.push({ key: `ip:${component}:${r.purpose}`, demand: {}, choice: r.cidr, detail: { purpose: r.purpose, addresses: r.addresses }, fits: true, reasons: [], alternatives: [] });
  }
  return rows;
}

export const k8sEngine                         = {
  id: 'k8s',
  applies: (c) => isPattern(c) && (c.tierPattern === 'containers' || (!!c.settings['k8s.workloads'] && c.tierPattern === undefined)),
  inputs(c, plan) {
    const g = parseGrid(isPattern(c) ? c.settings['k8s.workloads'] ?? '' : '');
    return { component: c, plan, workloads: g.workloads, findings: g.findings };
  },
  size(input, platform, policy) {
    const settings = k8sSettingsOf(input.component, input.plan, platform);
    const p = planCluster(platform, input.workloads, settings, policy);
    return rec('k8s', platform, k8sRows(input.component.id, p, platform, settings.targetUtil), [...input.findings, ...p.findings]);
  },
};
