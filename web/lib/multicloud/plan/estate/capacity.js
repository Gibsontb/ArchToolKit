/**
 * Estate capacity (addendum A.5.4): what the plan needs on each platform,
 * checked against the platforms' quotas.
 *
 * Totals per platform → landing zone → region, from the design (the sized
 * compute targets and database targets, WP-4) and, where given, the sizing
 * recommendations (Kubernetes pools, WP-23):
 *   vCPU, RAM, instances by family; storage by type; database instances by
 *   service and class; Kubernetes clusters, nodes and pods; public IPs, NAT
 *   gateways, load balancers; VPN tunnels and circuits; VMware hosts; backup
 *   protected GiB; and the servers replicating at once per wave (the
 *   migration tools' own quotas).
 *
 * The quota check compares each need with the actual quota (from
 * `capacity/fetch-quotas.sh` → quotas.json) or, when none is known, the
 * default (quota-data.ts). A need above it is the error `capacity.quota`,
 * which becomes a RAID issue with the request lead time. A quota with neither
 * an actual nor a sourced default is `unknown`, never assumed.
 */

import { error, info,              } from '../../../core/findings.js';
import { licenceTotals } from '../decide/index.js';
import { designPlan } from '../design/index.js';
import { PLATFORM_LABELS, PLATFORM_VALUES } from '../options.js';
import { withPatternMappers } from '../patterns/index.js';
                                                                                                                   
import { withoutServiceSynthetics } from '../apps/components.js';
import { QUOTA_DEFAULTS,                                     } from './quota-data.js';

                                                                                                           
                                                                             
                                                                                                                                         
                                                                                        

                                   
                              
                                        
                               
                          
                        
                          
                             
                                            
                                            
                                         
                                                                                             
                            
                         
                             
                               
                                 
                              
                            
                               
                             
                                                          
 

                                 
                                                  
                                   
                                        
 

                                  
                                                                                     
                                 
                                                              
                                                    
 

/** The instance family of a size, as the quota families count it. */
export function familyOf(platform          , size        )         {
  switch (platform) {
    case 'aws': return size.split('.')[0] ?? size;
    case 'azure': {
      const m = /^Standard_([A-Z]+)\d+[-\d]*([a-z]*)_v(\d+)$/i.exec(size);
      return m ? `${m[1]}${m[2]}v${m[3]}` : size;
    }
    case 'google': return size.split('-')[0] ?? size;
    case 'oci': return size.replace(/^(VM|BM)\./, '').replace(/\.Flex$/, '').replace(/\.\d+$/, '');
    default: return 'vm';
  }
}

const SSD = /ssd|gp3|gp2|io1|io2|premium|balanced|higher-performance|ultra/i;

/** The capacity the plan needs, per platform. */
export function estateCapacity(plan      , decision              , options                  = {})                 {
  const design = withoutServiceSynthetics(plan, options.design ?? designPlan(plan, decision, withPatternMappers()));
  const appOf = new Map(plan.apps.map((a) => [a.name, a]));
  const ingressOf = new Map((plan.appPlans ?? []).map((p) => [p.app, p.ingress]));
  const platforms                     = [];
  for (const pd of PLATFORM_VALUES.flatMap((p) => design.platforms.filter((d) => d.platform === p))) {
    const p = pd.platform;
    const families = new Map                                             ();
    const storage = new Map                ();
    let vcpu = 0;
    let ram = 0;
    let backup = 0;
    for (const c of pd.compute) {
      vcpu += c.vcpu;
      ram += c.ramGib;
      const f = familyOf(p, c.size);
      const cur = families.get(f) ?? { instances: 0, vcpu: 0 };
      families.set(f, { instances: cur.instances + 1, vcpu: cur.vcpu + c.vcpu });
      for (const d of c.disks) {
        storage.set(d.type, (storage.get(d.type) ?? 0) + d.gib);
        backup += d.gib;
      }
    }
    const dbs = new Map                 ();
    for (const d of pd.databases) {
      const k = `${d.service}\u0000${d.classOrShape}`;
      const cur = dbs.get(k) ?? { service: d.service, classOrShape: d.classOrShape, count: 0, storageGib: 0 };
      dbs.set(k, { ...cur, count: cur.count + 1, storageGib: cur.storageGib + d.storageGib });
      backup += d.storageGib;
    }
    // Kubernetes from the sizing rows of this platform.
    const pools = (options.sizing ?? []).filter((r) => r.platform === p).flatMap((r) => r.rows).filter((r) => r.key.startsWith('pool:'));
    const clusters = new Set(pools.map((r) => r.key.split(':')[1] ?? ''));
    const nodes = pools.reduce((s, r) => s + (typeof r.detail.count === 'number' ? r.detail.count : 0), 0);
    const pods = pools.reduce((s, r) => s + (r.demand.pods ?? 0), 0);
    // Network edges.
    const zones = Math.max(0, ...pd.networks.map((n) => new Set(n.subnets.map((s) => s.zone)).size));
    const networks = pd.networks.length;
    const natGateways = p === 'aws' ? pd.networks.reduce((s, n) => s + Math.max(1, new Set(n.subnets.map((x) => x.zone)).size), 0) : p === 'vmware' ? 0 : networks;
    const appsHere = new Set(pd.compute.map((c) => plan.workloads.find((w) => w.id === c.workload)?.app).filter((a)              => !!a));
    for (const d of pd.databases) {
      const a = plan.databases.find((x) => x.id === d.database)?.app;
      if (a) appsHere.add(a);
    }
    let loadBalancers = 0;
    let publicIngress = 0;
    for (const name of appsHere) {
      const ing = ingressOf.get(appOf.get(name)?.id ?? '');
      if (ing && ing.lb !== 'none') loadBalancers += 1;
      if (ing && ing.exposure === 'public') publicIngress += 1;
    }
    const bastion = pd.bastion === 'jump-vm' ? 1 : 0;
    const publicIps = p === 'vmware' ? 0 : natGateways + publicIngress + bastion;
    const vpnTunnels = pd.connectivity.filter((c) => c.method !== 'circuit').length * 2;
    const circuits = pd.connectivity.filter((c) => c.method !== 'vpn').length;
    // Replication at once, per wave (the tools' quotas).
    const perWave = new Map                ();
    for (const w of plan.workloads) {
      const d = decision.items[w.id];
      if (d?.chosen?.platform !== p || d.method !== 'replicate') continue;
      const wave = appOf.get(w.app)?.wave;
      const k = wave === undefined ? 'unwaved' : `wave ${wave}`;
      perWave.set(k, (perWave.get(k) ?? 0) + 1);
    }
    platforms.push({
      platform: p,
      landingZone: pd.prefix,
      region: pd.region,
      vcpu,
      ramGib: ram,
      instances: pd.compute.length,
      families: [...families.entries()].map(([family, v]) => ({ family, ...v })).sort((a, b) => b.vcpu - a.vcpu || a.family.localeCompare(b.family)),
      storage: [...storage.entries()].map(([type, gib]) => ({ type, gib })).sort((a, b) => a.type.localeCompare(b.type)),
      databases: [...dbs.values()].sort((a, b) => a.service.localeCompare(b.service) || a.classOrShape.localeCompare(b.classOrShape)),
      k8s: { clusters: clusters.size, nodes, pods },
      networks,
      zones,
      publicIps,
      natGateways,
      loadBalancers,
      vpnTunnels,
      circuits,
      vmwareHosts: pd.relocate?.nodes ?? 0,
      backupGib: backup,
      replicationPerWave: [...perWave.entries()].map(([wave, replicating]) => ({ wave, replicating })).sort((a, b) => a.wave.localeCompare(b.wave)),
    });
  }
  return { platforms, licences: licenceTotals(decision), findings: [...design.findings.filter((f) => f.severity === 'error')] };
}

// ---------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------

/** A real quota value, from quotas.json. */
                              
                              
                          
                           
                         
                          
 

                                                    

/** One row of the grid: Platform | Region | Quota | Needed | Default | Actual | Headroom | Status. */
                           
                              
                          
                           
                         
                          
                        
                            
                           
                                                
                             
                               
                                            
                         
                            
                          
                                                      
 

function needed(c                  , metric             )         {
  switch (metric) {
    case 'vcpu': return c.platform === 'oci' ? Math.ceil(c.vcpu / 2) : c.vcpu;
    case 'vcpu-family': return Math.max(0, ...c.families.map((f) => f.vcpu));
    case 'storage-ssd-tib': return round2(c.storage.filter((s) => SSD.test(s.type)).reduce((s, x) => s + x.gib, 0) / 1024);
    case 'block-storage-tib': return round2(c.storage.reduce((s, x) => s + x.gib, 0) / 1024);
    case 'public-ips': return c.publicIps;
    case 'networks': return c.networks;
    case 'nat-per-zone': return c.networks;
    default: return 0;
  }
}

/** The quota grid and the `capacity.quota` findings. */
export function checkQuotas(capacity                                   , actuals                         = [], quotas                          = QUOTA_DEFAULTS)                                            {
  const rows             = [];
  const findings            = [];
  for (const c of capacity.platforms) {
    for (const q of quotas.filter((x) => x.platform === c.platform)) {
      const actual = actuals.find((a) => a.platform === c.platform && a.quota === q.id && (a.region === c.region || a.region === ''))?.actual;
      const cases                                    = q.perWave
        ? c.replicationPerWave.map((w) => ({ need: w.replicating, wave: w.wave }))
        : [{ need: needed(c, q.metric) }];
      for (const { need, wave } of cases) {
        if (need <= 0) continue;
        const limit = actual ?? q.default;
        const status              = limit === undefined ? 'unknown' : need > limit ? 'over' : 'ok';
        const row           = {
          platform: c.platform, region: c.region, quotaId: q.id, quota: q.quota, needed: need, unit: q.unit,
          ...(q.default !== undefined ? { default: q.default } : {}),
          ...(actual !== undefined ? { actual } : {}),
          ...(limit !== undefined ? { headroom: round2(limit - need) } : {}),
          status, ...(wave ? { wave } : {}), leadDays: q.leadDays, source: q.source, verification: q.verification,
        };
        rows.push(row);
        const where = `${PLATFORM_LABELS[c.platform]} ${c.region}${wave ? ` (${wave})` : ''}`;
        if (status === 'over') {
          findings.push(error('capacity.quota', `${where}: ${q.quota} — ${need} ${q.unit} needed, the ${actual !== undefined ? 'actual quota' : 'default'} is ${limit}.`, {
            path: `capacity.${q.id}`,
            remediation: q.perWave
              ? `Split the wave, or ask for a raise (${q.leadDays} days' lead time to plan for).`
              : `Request a quota increase before the wave (${q.leadDays} days' lead time to plan for)${actual === undefined ? ', or fetch the real quota with capacity/fetch-quotas.sh: defaults differ by account' : ''}.`,
            source: q.source,
          }));
        } else if (status === 'unknown') {
          findings.push(info('capacity.quota-unknown', `${where}: ${q.quota} — ${need} ${q.unit} needed; no default is sourced, so fetch the real quota with capacity/fetch-quotas.sh.`, { path: `capacity.${q.id}`, source: q.source }));
        }
      }
    }
  }
  return { rows, findings };
}

/** Read quotas.json (what fetch-quotas.sh writes). Unknown rows are skipped. */
export function parseQuotasJson(text        )                                                  {
  const findings            = [];
  let data         ;
  try {
    data = JSON.parse(text);
  } catch {
    return { actuals: [], findings: [error('capacity.quotas-json', 'quotas.json is not valid JSON.')] };
  }
  const list = (data                        ).quotas;
  if (!Array.isArray(list)) return { actuals: [], findings: [error('capacity.quotas-json', 'quotas.json has no "quotas" list.')] };
  const ids = new Set(QUOTA_DEFAULTS.map((q) => q.id));
  const actuals                = [];
  for (const x of list                             ) {
    const platform = String(x.platform ?? '')            ;
    const quota = String(x.quota ?? '');
    const actual = Number(x.actual);
    if (!PLATFORM_VALUES.includes(platform) || !ids.has(quota) || !Number.isFinite(actual)) continue;
    // Google reports SSD in GB: the quota is kept in TiB.
    const value = quota === 'google.compute.ssd' ? round2(actual / 1024) : actual;
    actuals.push({ platform, region: String(x.region ?? ''), quota, actual: value });
  }
  return { actuals, findings };
}

const round2 = (n        )         => Math.round(n * 100) / 100;
