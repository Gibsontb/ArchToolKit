/**
 * The VCF sizing page's input assembly, without a DOM.
 *
 * The page reads every control into a flat record of strings (checkboxes as
 * "true" / "false", grids as their " | " text) and hands it to `planFromForm`,
 * which builds the engine's inputs: the first instance's `SizingInput`, the
 * fleet (`sizeFleet`), the manual workload clusters and the recovery site.
 * `sizeFromForm` runs all of it through the engine. A record built from
 * `SIZING_FORM_DEFAULTS` is exactly what an untouched page builds, so the
 * tests can prove the page's inputs size without throwing.
 */

import { info,              } from '../core/findings.js';
import {
  sizeFleet,
  sizeWorkloadCluster,
  sizeRecoverySite,
  recommendHostCount,
  projectGrowth,
  minimumHosts,
  additionalInstanceInput,
  computeFleetLicensing,
                   
                    
                  
                   
                      
                   
                
                   
                   
                        
                          
                   
                           
                            
                             
                   
                         
                  
                     
} from '../vcf/sizing.js';
import {
  DEPLOYMENT_PROFILE_LABELS,
  VCENTER_SIZE_ORDER,
                         
                      
                       
                   
                      
                      
                 
                   
                   
                      
                       
                         
                      
               
                        
} from '../vcf/sizing-data.js';
                                                                           

/** Every control's value, by key. Checkboxes are "true" / "false"; grids are their " | " text. */
                                                

// ---------------------------------------------------------------------------
// Closed sets offered by the page
// ---------------------------------------------------------------------------

export const VERSION_OPTIONS = [
  { value: '9.1.0', label: 'VCF 9.1.0' },
  { value: '9.1.1', label: 'VCF 9.1.1' },
]         ;

export const PATH_OPTIONS                                                      = [
  { value: 'greenfield', label: 'Greenfield — net-new deployment' },
  { value: 'brownfield-converge', label: 'Brownfield — converge to management domain' },
  { value: 'brownfield-import', label: 'Brownfield — import as workload domain' },
];

export const PROFILES                               = ['simple', 'ha-small', 'ha-medium', 'ha-large'];

export const PROFILE_OPTIONS                                                         = PROFILES.map((value) => ({
  value,
  label: value === 'ha-small' ? `${DEPLOYMENT_PROFILE_LABELS[value]} (9.1.1 only)` : DEPLOYMENT_PROFILE_LABELS[value],
}));

/** Management-domain topologies. Two-node is not one in VCF 9.1. */
export const TOPOLOGY_OPTIONS                                                       = [
  { value: 'standard', label: 'Standard cluster' },
  { value: 'stretched', label: 'Stretched cluster (2 AZ)' },
];

export const STORAGE_OPTIONS                                                   = [
  { value: 'vsan-esa', label: 'vSAN ESA' },
  { value: 'vsan-osa', label: 'vSAN OSA' },
  { value: 'nfs', label: 'NFS v3' },
  { value: 'vmfs-fc', label: 'VMFS on FC' },
];

export const FAILURE_OPTIONS = [
  { value: '0', label: 'N+0 — no host reserved' },
  { value: '1', label: 'N+1 — one host reserved' },
  { value: '2', label: 'N+2 — two hosts reserved' },
]         ;

export const EDGE_SIZES                         = ['small', 'medium', 'large', 'xlarge'];
export const EDGE_OPTIONS                                                   = [
  { value: 'small', label: 'Small (lab only)' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'X-Large' },
];

export const AUTOMATION_SIZES                            = ['small', 'medium', 'large'];
export const OSA_POLICIES                                                 = [
  { value: 'raid1-ftt1', label: 'RAID-1, FTT=1 (2x)' },
  { value: 'raid5-ftt1', label: 'RAID-5, FTT=1' },
  { value: 'raid6-ftt2', label: 'RAID-6, FTT=2' },
  { value: 'raid1-ftt2', label: 'RAID-1, FTT=2 (3x)' },
];
export const WITNESS_SIZES                         = ['tiny', 'medium', 'large'];
export const NSX_MANAGER_SIZES_LIST                            = ['xsmall', 'small', 'medium', 'large', 'xlarge'];
export const LOG_REPLICA_SIZES                            = ['small', 'medium', 'large'];
export const OPS_NETWORKS_SIZES                             = ['medium', 'large', 'xlarge'];
export const AVI_SIZES                               = ['small', 'medium', 'large'];
export const SUPERVISOR_SIZES                            = ['tiny', 'small', 'medium', 'large'];
export const OPS_SIZES_LIST                     = ['xsmall', 'small', 'medium', 'large', 'xlarge'];
export const OPS_COLLECTOR_SIZES_LIST                              = ['small', 'standard'];
export const NIC_SPEEDS = ['10', '25', '40', '50', '100']         ;

// ---------------------------------------------------------------------------
// Grids (src/ui/multi-editors.ts)
// ---------------------------------------------------------------------------

/** A grid's column hint and the dropdowns for its closed-set columns. */
                           
                        
                                                                               
 

const column = (group        , values                   , blank         ) => [
  ...(blank !== undefined ? [{ value: '', label: blank, group }] : []),
  ...values.map((v) => ({ value: v, label: v, group })),
];

/** Additional VCF instances; the first instance is the form itself. */
export const INSTANCE_GRID           = {
  hint: 'Name | Hosts | Profile | Storage | Topology',
  options: [
    ...column('Profile', PROFILES, 'Same as first'),
    ...column('Storage', STORAGE_OPTIONS.map((o) => o.value), 'Same as first'),
    ...column('Topology', TOPOLOGY_OPTIONS.map((o) => o.value), 'Same as first'),
  ],
};

export const WORKLOAD_DOMAIN_GRID           = {
  hint:
    'Name | Instance | Hosts | VMs | vCenter | NSX | NSX size | NSX nodes | Edge size | Edge nodes | ' +
    'Supervisors | Supervisor size | Supervisor VMs',
  options: [
    ...column('vCenter', VCENTER_SIZE_ORDER, 'Auto'),
    ...column('NSX', ['dedicated', 'shared']),
    ...column('NSX size', NSX_MANAGER_SIZES_LIST, 'Default (medium)'),
    ...column('NSX nodes', ['1', '3'], 'Default (3)'),
    ...column('Edge size', EDGE_SIZES, 'No edge cluster'),
    ...column('Supervisor size', SUPERVISOR_SIZES, 'Default (small)'),
    ...column('Supervisor VMs', ['1', '3'], 'Default (3)'),
  ],
};

export const WORKLOAD_CLUSTER_GRID           = {
  hint:
    'Name | Domain | vCPU | RAM GiB | Storage GiB | Hosts | Storage | Topology | vCPU per core | Failures | ' +
    'Sockets | Cores per CPU | Host RAM GiB | Host raw GiB',
  options: [
    ...column('Storage', STORAGE_OPTIONS.map((o) => o.value), 'Same as management'),
    ...column('Topology', ['standard', 'stretched', 'two-node'], 'Standard'),
    ...column('Failures', ['0', '1', '2'], 'Default (N+1)'),
  ],
};

/** Rows of a " | " grid, blank rows and comments dropped. */
export function gridRows(text        , columns        )             {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const cells = ` ${line} `.split(/(?<=\s)\|(?=\s)/).map((c) => c.trim());
      return Array.from({ length: columns }, (_, i) => cells[i] ?? '');
    })
    .filter((cells) => cells.some((c) => c !== ''));
}

const columnsOf = (spec          )         => spec.hint.split(' | ').length;

/** A number, or undefined when the text is blank or not a number. */
function optNum(text                    )                     {
  if (text === undefined || text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function num(text                    , fallback        , min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY)         {
  const n = optNum(text);
  return Math.min(max, Math.max(min, n ?? fallback));
}

function oneOf                  (text                    , allowed              )                {
  return allowed.includes(text     ) ? (text     ) : undefined;
}

const on = (text                    )          => text === 'true';

function failuresOf(text                    )                        {
  const n = optNum(text);
  return n === 0 || n === 1 || n === 2 ? n : undefined;
}

                              
                        
                          
                                       
                                 
                                      
 

export function parseInstances(text        )                {
  return gridRows(text, columnsOf(INSTANCE_GRID)).map((r, i) => {
    const hosts = optNum(r[1]);
    const profile = oneOf(r[2], PROFILES);
    const storage = oneOf(r[3], STORAGE_OPTIONS.map((o) => o.value));
    const topology = oneOf(r[4], TOPOLOGY_OPTIONS.map((o) => o.value));
    return {
      name: r[0] || `instance ${i + 2}`,
      ...(hosts !== undefined ? { hosts: Math.max(1, Math.round(hosts)) } : {}),
      ...(profile ? { profile } : {}),
      ...(storage ? { storage } : {}),
      ...(topology ? { topology } : {}),
    };
  });
}

                                    
                                                                   
                                                                                             
                            
 

export function parseWorkloadDomains(text        )                      {
  return gridRows(text, columnsOf(WORKLOAD_DOMAIN_GRID)).map((r, i) => {
    const [name, instance, hosts, vms, vcenter, nsx, nsxSize, nsxNodes, edgeSize, edgeNodes, supervisors, supervisorSize, supervisorVms] = r;
    const edge = oneOf(edgeSize, EDGE_SIZES);
    const svCount = optNum(supervisors) ?? 0;
    const vc = oneOf(vcenter, VCENTER_SIZE_ORDER);
    const size = oneOf(nsxSize, NSX_MANAGER_SIZES_LIST);
    const nodes = optNum(nsxNodes);
    const hostCount = optNum(hosts);
    const vmCount = optNum(vms);
    const cp = optNum(supervisorVms);
    const domain                                         = {
      name: name || `wld${String(i + 1).padStart(2, '0')}`,
      ...(hostCount !== undefined ? { hosts: Math.max(0, Math.round(hostCount)) } : {}),
      ...(vmCount !== undefined ? { vms: Math.max(0, Math.round(vmCount)) } : {}),
      ...(vc ? { vcenterSize: vc                } : {}),
      nsx: nsx === 'shared' ? 'shared' : 'dedicated',
      ...(size ? { nsxSize: size } : {}),
      ...(nodes === 1 || nodes === 3 ? { nsxNodes: nodes } : {}),
      ...(edge ? { edgeCluster: { size: edge, nodes: Math.max(1, Math.round(optNum(edgeNodes) ?? 2)) } } : {}),
      ...(svCount > 0
        ? {
            supervisor: {
              count: Math.round(svCount),
              size: oneOf(supervisorSize, SUPERVISOR_SIZES) ?? 'small',
              controlPlaneVms: cp === 1 ? 1 : 3,
            },
          }
        : {}),
    };
    return { domain, instance: (instance ?? '').trim() };
  });
}

                                     
                                                                     
                                                                                 
                          
 

export function parseWorkloadClusters(
  text        ,
  defaults                                                                                       ,
)                       {
  return gridRows(text, columnsOf(WORKLOAD_CLUSTER_GRID)).map((r, i) => {
    const [name, domain, vcpu, ram, storageGib, hosts, storage, topology, ratio, failures, sockets, cores, hostRam, hostRaw] = r;
    const host           = {
      cpuSockets: Math.max(1, Math.round(optNum(sockets) ?? defaults.host.cpuSockets)),
      coresPerCpu: Math.max(1, Math.round(optNum(cores) ?? defaults.host.coresPerCpu)),
      hyperthreading: defaults.host.hyperthreading,
      ramGib: Math.max(1, optNum(hostRam) ?? defaults.host.ramGib),
      rawStorageGib: Math.max(0, optNum(hostRaw) ?? defaults.host.rawStorageGib),
    };
    const fixedHosts = optNum(hosts);
    const cpuRatio = optNum(ratio);
    const f = failuresOf(failures);
    const topo = oneOf(topology, ['standard', 'stretched', 'two-node']         );
    const cluster                                          = {
      name: name || `cluster${String(i + 1).padStart(2, '0')}`,
      vcpu: Math.max(0, optNum(vcpu) ?? 0),
      ramGib: Math.max(0, optNum(ram) ?? 0),
      storageGib: Math.max(0, optNum(storageGib) ?? 0),
      host,
      storage: oneOf(storage, STORAGE_OPTIONS.map((o) => o.value)) ?? defaults.storage,
      ...(topo ? { topology: topo } : {}),
      ...(cpuRatio !== undefined && cpuRatio > 0 ? { cpuRatio } : {}),
      ...(f !== undefined ? { hostFailures: f } : {}),
      ...(fixedHosts !== undefined && fixedHosts > 0 ? { hosts: Math.round(fixedHosts) } : {}),
      ...(defaults.version ? { version: defaults.version } : {}),
    };
    return { cluster, domain: (domain ?? '').trim() };
  });
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** What an untouched page holds. */
export const SIZING_FORM_DEFAULTS             = Object.freeze({
  version: '9.1.1',
  path: 'greenfield',
  profile: 'simple',
  topology: 'standard',
  storage: 'vsan-esa',
  hostCount: '4',
  cpuSockets: '2',
  coresPerCpu: '32',
  hyperthreading: 'true',
  ramGib: '1024',
  rawStorageGib: '15360',
  pnicsPerHost: '2',
  nicSpeedGbps: '',
  hostFailures: '1',
  targetCpuRatio: '2',
  loadBalancer: 'false',

  workloadVcpu: '0',
  workloadRamGib: '0',
  workloadCapacityGib: '0',

  includeEdge: 'false',
  edgeSize: 'large',
  edgeNodeCount: '2',

  includeAutomation: 'true',
  automationSize: '',
  automationNodes: '',

  osaPolicy: '',
  dedupRatio: '1',
  operationsReservePct: '0',

  reserveAzFailure: 'true',
  interAzBandwidthGbps: '',
  interAzRttMs: '',
  witnessSize: 'medium',

  tiering: 'false',
  tieringRatio: '1',
  tieringActivePct: '50',
  tieringNvmeShared: 'false',

  growthCpuPct: '0',
  growthRamPct: '0',
  growthStoragePct: '0',
  growthYears: '0',

  instances: '',
  workloadDomains: '',
  workloadClusters: '',

  addLog: 'false',
  logReplicaSize: 'small',
  logReplicas: '',
  logEps: '',
  logDailyGib: '',
  logRetentionDays: '',
  logNPlusOne: 'false',
  addRtm: 'false',
  addOpsNet: 'false',
  opsNetSize: 'xlarge',
  opsNetNodes: '',
  opsNetVms: '',
  opsNetFlows: '',
  opsNetCollectors: '',
  opsNetCollectorSize: '',
  addDepot: 'false',
  addIdentityBroker: 'false',
  addAvi: 'false',
  aviSize: 'small',
  aviNodes: '3',
  addPr: 'false',
  prProtectedVms: '',
  prScaleOut: '0',
  addHcx: 'false',
  hcxSitePairs: '1',
  hcxNetworkExtensions: '1',
  hcxWanOpt: 'false',
  hcxSgw: 'false',
  addOpsScale: 'false',
  opsDataNodes: '0',
  opsDataNodeSize: 'medium',
  opsCloudProxies: '0',
  opsCloudProxySize: 'small',

  vcfEdge: 'false',
  edgeSites: '',
  subscriptionYears: '',

  dr: 'false',
  drVcpu: '0',
  drRamGib: '0',
  drStorageGib: '0',
  drVms: '0',
  drReservePct: '100',
  drStorage: 'vsan-esa',
  drHostFailures: '1',
})              ;

// ---------------------------------------------------------------------------
// Form → engine inputs
// ---------------------------------------------------------------------------

                             
                                                                      
                                
                                                                
                             
                                                                         
                                            
                                                                         
                                                             
                                        
                                                       
                                     
 

function hostOf(v            )           {
  return {
    cpuSockets: Math.round(num(v.cpuSockets, 2, 1)),
    coresPerCpu: Math.round(num(v.coresPerCpu, 32, 1)),
    hyperthreading: on(v.hyperthreading),
    ramGib: num(v.ramGib, 1024, 1),
    rawStorageGib: num(v.rawStorageGib, 15360, 0),
  };
}

function vsanOf(v            )                          {
  const osaPolicy = v.storage === 'vsan-osa' ? oneOf(v.osaPolicy, OSA_POLICIES.map((o) => o.value)) : undefined;
  const dedup = optNum(v.dedupRatio);
  const reserve = optNum(v.operationsReservePct);
  const out              = {
    ...(osaPolicy ? { osaPolicy } : {}),
    ...(dedup !== undefined && dedup !== 1 ? { dedupRatio: Math.max(1, dedup) } : {}),
    ...(reserve !== undefined && reserve > 0 ? { operationsReserve: Math.min(90, reserve) / 100 } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function stretchedOf(v            )                               {
  if (v.topology !== 'stretched') return undefined;
  const bw = optNum(v.interAzBandwidthGbps);
  const rtt = optNum(v.interAzRttMs);
  return {
    reserveAzFailure: v.reserveAzFailure !== 'false',
    ...(bw !== undefined ? { interAzBandwidthGbps: bw } : {}),
    ...(rtt !== undefined ? { interAzRttMs: rtt } : {}),
    witnessSize: oneOf(v.witnessSize, WITNESS_SIZES) ?? 'medium',
  };
}

function tieringOf(v            )                                 {
  if (!on(v.tiering)) return undefined;
  return {
    enabled: true,
    ratio: num(v.tieringRatio, 1, 0),
    activeMemoryFraction: num(v.tieringActivePct, 50, 0, 100) / 100,
    nvmeSharedWithVsan: on(v.tieringNvmeShared),
  };
}

function growthOf(v            )                          {
  const years = Math.round(num(v.growthYears, 0, 0, 20));
  if (years <= 0) return undefined;
  return {
    cpuPct: num(v.growthCpuPct, 0, 0),
    ramPct: num(v.growthRamPct, 0, 0),
    storagePct: num(v.growthStoragePct, 0, 0),
    years,
  };
}

function addOnsOf(v            )                          {
  const a   
                                                       
    = {};
  if (on(v.addLog)) {
    const replicas = optNum(v.logReplicas);
    const eps = optNum(v.logEps);
    const daily = optNum(v.logDailyGib);
    const retention = optNum(v.logRetentionDays);
    a.logManagement = {
      replicaSize: oneOf(v.logReplicaSize, LOG_REPLICA_SIZES) ?? 'small',
      ...(replicas !== undefined && replicas > 0 ? { replicas: Math.round(replicas) } : {}),
      ...(eps !== undefined ? { eps } : {}),
      ...(daily !== undefined ? { dailyGib: daily } : {}),
      ...(retention !== undefined ? { retentionDays: retention } : {}),
      nPlusOne: on(v.logNPlusOne),
    };
  }
  if (on(v.addRtm)) a.realTimeMetrics = true;
  if (on(v.addOpsNet)) {
    const nodes = optNum(v.opsNetNodes);
    const vms = optNum(v.opsNetVms);
    const flows = optNum(v.opsNetFlows);
    const collectors = optNum(v.opsNetCollectors);
    const collectorSize = oneOf(v.opsNetCollectorSize, OPS_NETWORKS_SIZES);
    a.operationsForNetworks = {
      size: oneOf(v.opsNetSize, OPS_NETWORKS_SIZES) ?? 'xlarge',
      ...(nodes !== undefined && nodes > 0 ? { nodes: Math.round(nodes) } : {}),
      ...(vms !== undefined ? { vms } : {}),
      ...(flows !== undefined ? { flows } : {}),
      ...(collectors !== undefined ? { collectors: Math.round(collectors) } : {}),
      ...(collectorSize ? { collectorSize } : {}),
    };
  }
  if (on(v.addAvi)) {
    a.avi = { size: oneOf(v.aviSize, AVI_SIZES) ?? 'small', nodes: v.aviNodes === '1' ? 1 : 3 };
  }
  if (on(v.addPr)) {
    const vms = optNum(v.prProtectedVms);
    a.protectionRecovery = {
      ...(vms !== undefined ? { protectedVms: vms } : {}),
      scaleOutAppliances: Math.round(num(v.prScaleOut, 0, 0)),
    };
  }
  if (on(v.addHcx)) {
    a.hcx = {
      sitePairs: Math.round(num(v.hcxSitePairs, 1, 1)),
      networkExtensions: Math.round(num(v.hcxNetworkExtensions, 1, 0)),
      wanOptimization: on(v.hcxWanOpt),
      sentinelGateway: on(v.hcxSgw),
    };
  }
  if (on(v.addOpsScale)) {
    a.operationsScaleOut = {
      dataNodes: Math.round(num(v.opsDataNodes, 0, 0)),
      dataNodeSize: oneOf(v.opsDataNodeSize, OPS_SIZES_LIST) ?? 'medium',
      cloudProxies: Math.round(num(v.opsCloudProxies, 0, 0)),
      cloudProxySize: oneOf(v.opsCloudProxySize, OPS_COLLECTOR_SIZES_LIST) ?? 'small',
    };
  }
  return Object.keys(a).length > 0 ? a : undefined;
}

/** Which instance (0 = first) a workload-domain row's Instance cell names. */
function instanceIndex(cell        , names                   )                     {
  if (cell === '' || cell === '1' || /^first$/i.test(cell)) return 0;
  const byName = names.findIndex((n) => n.toLowerCase() === cell.toLowerCase());
  if (byName >= 0) return byName + 1;
  const n = Number(cell);
  if (Number.isInteger(n) && n >= 2 && n <= names.length + 1) return n - 1;
  return undefined;
}

export function planFromForm(values            )             {
  const v             = { ...SIZING_FORM_DEFAULTS, ...values };
  const notes            = [];
  const version = oneOf(v.version, VERSION_OPTIONS.map((o) => o.value)) ?? '9.1.1';
  const storage = oneOf(v.storage, STORAGE_OPTIONS.map((o) => o.value)) ?? 'vsan-esa';
  const topology = oneOf(v.topology, TOPOLOGY_OPTIONS.map((o) => o.value)) ?? 'standard';
  const host = hostOf(v);
  const failures = failuresOf(v.hostFailures) ?? 1;
  const vsan = vsanOf(v);
  const stretched = stretchedOf(v);
  const memoryTiering = tieringOf(v);
  const growth = growthOf(v);
  const addOns = addOnsOf(v);
  const nic = optNum(v.nicSpeedGbps);
  const automationSize = oneOf(v.automationSize, AUTOMATION_SIZES);
  const automationNodes = v.automationNodes === '1' ? 1 : v.automationNodes === '3' ? 3 : undefined;
  const edgeSites = optNum(v.edgeSites);
  const years = optNum(v.subscriptionYears);
  const vcfEdge = on(v.vcfEdge);

  const instances = parseInstances(v.instances ?? '');
  const instanceNames = instances.map((i) => i.name);

  // --- workload domains and their clusters --------------------------------
  const domains = parseWorkloadDomains(v.workloadDomains ?? '');
  const clusters = parseWorkloadClusters(v.workloadClusters ?? '', { host, storage, version });
  const domainNames = new Set(domains.map((d) => d.domain.name.toLowerCase()));
  const standalone                         = [];
  const clustersFor = new Map                                ();
  for (const c of clusters) {
    const cluster                       = {
      ...c.cluster,
      ...(memoryTiering ? { memoryTiering } : {}),
      ...(vsan ? { vsan } : {}),
      ...(nic !== undefined ? { nicSpeedGbps: nic } : {}),
      ...(c.cluster.topology === 'stretched' && stretched ? { stretched } : {}),
      pnicsPerHost: Math.round(num(v.pnicsPerHost, 2, 1)),
    };
    const key = c.domain.toLowerCase();
    if (key && domainNames.has(key)) {
      (clustersFor.get(key) ?? clustersFor.set(key, []).get(key) ).push(cluster);
    } else {
      if (key) {
        notes.push(info('sizing.page.cluster-domain-unknown', `Cluster ${c.cluster.name} names workload domain "${c.domain}", which is not in the workload-domain grid; it is sized on its own.`, { path: 'workloadClusters' }));
      }
      // Growth applies here as it would inside a domain.
      standalone.push({ ...cluster, ...(growth ? { growth } : {}) });
    }
  }
  const byInstance                          = Array.from({ length: instances.length + 1 }, () => []);
  for (const d of domains) {
    const at = instanceIndex(d.instance, instanceNames);
    if (at === undefined) {
      notes.push(info('sizing.page.domain-instance-unknown', `Workload domain ${d.domain.name} names instance "${d.instance}", which is not in the fleet; it is placed in the first instance.`, { path: 'workloadDomains' }));
    }
    const own = clustersFor.get(d.domain.name.toLowerCase());
    byInstance[at ?? 0] .push({ ...d.domain, ...(own ? { clusters: own } : {}) });
  }

  // --- the first instance ------------------------------------------------------
  const primary              = {
    version,
    path: oneOf(v.path, PATH_OPTIONS.map((o) => o.value)) ?? 'greenfield',
    profile: oneOf(v.profile, PROFILES) ?? 'simple',
    instanceCount: instances.length + 1,
    instanceRole: 'first',
    topology,
    storage,
    hostCount: Math.round(num(v.hostCount, 4, 1, 64)),
    host,
    pnicsPerHost: Math.round(num(v.pnicsPerHost, 2, 1)),
    ...(nic !== undefined ? { nicSpeedGbps: nic } : {}),
    loadBalancer: on(v.loadBalancer),
    hostFailuresToTolerate: failures,
    reserveHostFailure: failures > 0,
    targetCpuRatio: num(v.targetCpuRatio, 2, 0.1),
    workloadVcpu: num(v.workloadVcpu, 0, 0),
    workloadRamGib: num(v.workloadRamGib, 0, 0),
    workloadCapacityGib: num(v.workloadCapacityGib, 0, 0),
    includeEdgeCluster: on(v.includeEdge),
    edgeSize: oneOf(v.edgeSize, EDGE_SIZES) ?? 'large',
    edgeNodeCount: Math.round(num(v.edgeNodeCount, 2, 1)),
    includeAutomation: v.includeAutomation !== 'false',
    ...(automationSize ? { automationSize } : {}),
    ...(automationNodes ? { automationNodes } : {}),
    ...(vsan ? { vsan } : {}),
    ...(stretched ? { stretched } : {}),
    ...(memoryTiering ? { memoryTiering } : {}),
    ...(growth ? { growth } : {}),
    ...(byInstance[0] .length > 0 ? { workloadDomains: byInstance[0] } : {}),
    ...(addOns ? { addOns } : {}),
    vcfEdge,
    ...(edgeSites !== undefined ? { edgeSites: Math.round(edgeSites) } : {}),
    ...(years !== undefined && years > 0 ? { subscriptionYears: Math.round(years) } : {}),
  };

  // --- additional instances: each its own management domain -----------------
  const instanceAddOns                          =
    on(v.addDepot) || on(v.addIdentityBroker)
      ? { ...(on(v.addDepot) ? { softwareDepot: true } : {}), ...(on(v.addIdentityBroker) ? { identityBroker: true } : {}) }
      : undefined;
  const additional                = instances.map((row, i) => {
    // The first instance's shape, less what belongs to the first alone; a
    // placeholder host count skips the engine's own search, done below.
    const base0 = additionalInstanceInput({ ...primary, workloadDomains: [], additionalInstanceHostCount: 1 });
    const base              = {
      ...base0,
      ...(row.profile ? { profile: row.profile } : {}),
      ...(row.storage ? { storage: row.storage } : {}),
      ...(row.topology ? { topology: row.topology } : {}),
      ...(nic !== undefined ? { nicSpeedGbps: nic } : {}),
      ...(growth ? { growth } : {}),
      ...((byInstance[i + 1]?.length ?? 0) > 0 ? { workloadDomains: byInstance[i + 1] } : {}),
      // 9.1.1: an additional instance can run its own Software Depot and Identity Broker.
      ...(instanceAddOns ? { addOns: instanceAddOns } : {}),
    };
    const min = minimumHosts({ ...base, role: 'management' }).hosts;
    const hostCount = row.hosts ?? recommendHostCount({ ...base, hostCount: min }) ?? min;
    return { ...base, hostCount };
  });

  // --- the recovery site ---------------------------------------------------------
  let recovery                               ;
  if (on(v.dr)) {
    const drFailures = failuresOf(v.drHostFailures);
    recovery = {
      protectedVcpu: num(v.drVcpu, 0, 0),
      protectedRamGib: num(v.drRamGib, 0, 0),
      protectedStorageGib: num(v.drStorageGib, 0, 0),
      protectedVms: Math.round(num(v.drVms, 0, 0)),
      reserveFraction: num(v.drReservePct, 100, 0, 100) / 100,
      host,
      storage: oneOf(v.drStorage, STORAGE_OPTIONS.map((o) => o.value)) ?? storage,
      ...(drFailures !== undefined ? { hostFailures: drFailures } : {}),
      ...(vsan ? { vsan } : {}),
      version,
    };
  }

  return {
    primary,
    fleet: {
      instances: [primary, ...additional],
      version,
      vcfEdge,
      ...(primary.subscriptionYears ? { subscriptionYears: primary.subscriptionYears } : {}),
    },
    instanceNames,
    workloadClusters: standalone,
    ...(recovery ? { recovery } : {}),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Engine run
// ---------------------------------------------------------------------------

                                
                            
                                                          
                              
                                                
                                
                                                                               
                                           
                                                   
                                         
                                                      
                                                          
                                                                                                         
                                     
                                                
                                        
 

const isVsanStorage = (s             )          => s === 'vsan-esa' || s === 'vsan-osa';

/** License items for the fleet, the way the engine's fleet summary counts them, plus the page's own clusters. */
export function licenseItems(
  fleet             ,
  names                   ,
  clusters                                                                           ,
  recovery                                                              ,
)                {
  const items                = [];
  fleet.instances.forEach((r, i) => {
    const label = i === 0 ? 'instance 1' : (names[i - 1] ?? `instance ${i + 1}`);
    items.push({ name: `${label}: management domain`, hosts: r.input.hostCount, host: r.input.host, vsan: isVsanStorage(r.input.storage) });
    for (const d of r.workloadDomains) {
      for (const c of d.clusters) {
        const src = (r.input.workloadDomains ?? []).flatMap((x) => x.clusters ?? []).find((x) => x.name === c.name);
        items.push({ name: `${label}: ${d.name} / ${c.name}`, hosts: c.hosts, host: src?.host ?? r.input.host, vsan: src ? isVsanStorage(src.storage) : false });
      }
    }
  });
  for (const c of clusters) {
    items.push({ name: `workload cluster ${c.result.name}`, hosts: c.result.hosts, host: c.input.host, vsan: isVsanStorage(c.input.storage) });
  }
  if (recovery) {
    items.push({ name: 'recovery site', hosts: recovery.result.hosts, host: recovery.input.host, vsan: isVsanStorage(recovery.input.storage) });
  }
  return items;
}

export function sizeFromForm(values            )                {
  return sizePlan(planFromForm(values));
}

export function sizePlan(plan            )                {
  const fleet = sizeFleet(plan.fleet);
  const result = fleet.instances[0]                ;
  const recommendedHosts = recommendHostCount(plan.primary);
  const growth = plan.primary.growth ? projectGrowth(plan.primary) : [];
  const clusterRuns = plan.workloadClusters.map((input) => ({ input, result: sizeWorkloadCluster(input) }));
  const recovery = plan.recovery ? sizeRecoverySite(plan.recovery) : undefined;
  const items = licenseItems(
    fleet,
    plan.instanceNames,
    clusterRuns,
    plan.recovery && recovery ? { input: plan.recovery, result: recovery.cluster } : undefined,
  );
  const licensing = computeFleetLicensing(items, {
    vcfEdge: plan.primary.vcfEdge === true,
    ...(plan.primary.subscriptionYears ? { subscriptionYears: plan.primary.subscriptionYears } : {}),
    ...(plan.primary.edgeSites !== undefined ? { sites: plan.primary.edgeSites } : {}),
  });
  const many = fleet.instances.length > 1;
  const label = (i        )         => (i === 0 ? 'Instance 1' : (plan.instanceNames[i - 1] ?? `Instance ${i + 1}`));
  const instanceFindings = fleet.instances.flatMap((r, i) =>
    many ? r.findings.map((f) => ({ ...f, message: `${label(i)}: ${f.message}` })) : [...r.findings],
  );
  const seen = new Set(instanceFindings.map((f) => f.code));
  const beyondOneDomain = many || clusterRuns.length > 0 || recovery !== undefined || fleet.totals.workloadHosts > 0;
  const findings            = [
    ...instanceFindings,
    ...clusterRuns.flatMap((c) => c.result.findings),
    ...(recovery ? recovery.findings.map((f) => ({ ...f, message: `Recovery site: ${f.message}` })) : []),
    // Fleet-wide licensing checks the instances have not already reported.
    ...licensing.findings.filter((f) => (f.code === 'vcf.licensing.fleet-vsan-addon' ? beyondOneDomain : !seen.has(f.code))),
    ...plan.notes,
  ];
  return {
    plan,
    fleet,
    result,
    recommendedHosts,
    growth,
    clusters: clusterRuns.map((c) => c.result),
    ...(recovery ? { recovery } : {}),
    licensing,
    licenseItems: items,
    findings,
  };
}

/** The management-domain lines that are not tenant workloads. */
export function managementLines(result              )                  {
  return result.components.filter((c) => c.name !== 'Tenant workloads');
}

// ---------------------------------------------------------------------------
// Engine input → form (the estate plan and the inventory handoff)
// ---------------------------------------------------------------------------

const cell = (v                             )         => (v === undefined ? '' : String(v));

/** Workload domains as grid text. */
export function workloadDomainsToGrid(domains                                , instance = '')         {
  return domains
    .map((d, i) =>
      [
        d.name ?? `wld${String(i + 1).padStart(2, '0')}`,
        instance,
        cell(d.hosts),
        cell(d.vms),
        cell(d.vcenterSize),
        d.nsx ?? 'dedicated',
        cell(d.nsxSize),
        cell(d.nsxNodes),
        cell(d.edgeCluster?.size),
        cell(d.edgeCluster?.nodes),
        cell(d.supervisor?.count),
        cell(d.supervisor?.size),
        cell(d.supervisor?.controlPlaneVms),
      ].join(' | '),
    )
    .join('\n');
}

/** Workload-domain clusters as grid text, each against its domain. */
export function workloadClustersToGrid(domains                                )         {
  const rows           = [];
  domains.forEach((d, i) => {
    const domain = d.name ?? `wld${String(i + 1).padStart(2, '0')}`;
    (d.clusters ?? []).forEach((c, j) => {
      rows.push(
        [
          c.name ?? `${domain}-cl${String(j + 1).padStart(2, '0')}`,
          domain,
          cell(Math.round(c.vcpu)),
          cell(Math.round(c.ramGib)),
          cell(Math.round(c.storageGib)),
          cell(c.hosts),
          c.storage,
          cell(c.topology),
          cell(c.cpuRatio),
          cell(c.hostFailures),
          cell(c.host.cpuSockets),
          cell(c.host.coresPerCpu),
          cell(Math.round(c.host.ramGib)),
          cell(Math.round(c.host.rawStorageGib)),
        ].join(' | '),
      );
    });
  });
  return rows.join('\n');
}

/**
 * The form values a derived sizing input determines. Only the fields the input
 * carries are written; anything it cannot know keeps the form's own value.
 */
export function formFromSizingInput(input             )                      {
  const out                         = {
    path: input.path,
    profile: input.profile,
    topology: input.topology === 'two-node' ? 'standard' : input.topology,
    storage: input.storage,
    hostCount: String(input.hostCount),
    cpuSockets: String(input.host.cpuSockets),
    coresPerCpu: String(input.host.coresPerCpu),
    hyperthreading: String(input.host.hyperthreading),
    ramGib: String(Math.round(input.host.ramGib)),
    rawStorageGib: String(Math.round(input.host.rawStorageGib)),
  };
  if (input.version) out.version = input.version.startsWith('9.1.0') ? '9.1.0' : '9.1.1';
  if (input.workloadVcpu !== undefined) out.workloadVcpu = String(Math.round(input.workloadVcpu));
  if (input.workloadRamGib !== undefined) out.workloadRamGib = String(Math.round(input.workloadRamGib));
  if (input.workloadCapacityGib !== undefined) out.workloadCapacityGib = String(Math.round(input.workloadCapacityGib));
  if (input.pnicsPerHost !== undefined) out.pnicsPerHost = String(input.pnicsPerHost);
  if (input.nicSpeedGbps !== undefined) out.nicSpeedGbps = String(input.nicSpeedGbps);
  if (input.hostFailuresToTolerate !== undefined) out.hostFailures = String(input.hostFailuresToTolerate);
  else if (input.reserveHostFailure !== undefined) out.hostFailures = input.reserveHostFailure ? '1' : '0';
  if (input.targetCpuRatio !== undefined) out.targetCpuRatio = String(input.targetCpuRatio);
  if (input.includeAutomation !== undefined) out.includeAutomation = String(input.includeAutomation);
  if (input.automationSize) out.automationSize = input.automationSize;
  if (input.automationNodes) out.automationNodes = String(input.automationNodes);
  if (input.includeEdgeCluster !== undefined) out.includeEdge = String(input.includeEdgeCluster);
  if (input.edgeSize) out.edgeSize = input.edgeSize;
  if (input.edgeNodeCount !== undefined) out.edgeNodeCount = String(input.edgeNodeCount);
  if (input.vsan?.osaPolicy) out.osaPolicy = input.vsan.osaPolicy;
  if (input.vsan?.dedupRatio !== undefined) out.dedupRatio = String(input.vsan.dedupRatio);
  if (input.vsan?.operationsReserve !== undefined) out.operationsReservePct = String(Math.round(input.vsan.operationsReserve * 100));
  if (input.loadBalancer !== undefined) out.loadBalancer = String(input.loadBalancer);
  if (input.vcfEdge !== undefined) out.vcfEdge = String(input.vcfEdge);
  if (input.workloadDomains !== undefined) {
    out.workloadDomains = workloadDomainsToGrid(input.workloadDomains);
    // Clusters only when the input has some: manual clusters typed in stay otherwise.
    const clusters = workloadClustersToGrid(input.workloadDomains);
    if (clusters) out.workloadClusters = clusters;
  }
  if (input.instanceCount > 1 && (input.instanceRole ?? 'first') === 'first') {
    out.instances = Array.from({ length: input.instanceCount - 1 }, (_, i) =>
      [`instance ${i + 2}`, cell(input.additionalInstanceHostCount), '', '', ''].join(' | '),
    ).join('\n');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Estate plan options the page adds to the estate panel
// ---------------------------------------------------------------------------

                               
                                                                                           
                                                
                                                
                                          
                                                                              
                                                                 
 

export const ESTATE_EXTRAS_DEFAULTS               = {
  vsanArchitecture: '',
  nsxPerDomain: 'dedicated',
  nsxManagerSize: 'medium',
  clusterStorage: {},
};

/**
 * The estate planner's options with the page's additions: vSAN architecture,
 * per-cluster storage, NSX per domain and size, and the profile, version and
 * host failures the sizing form holds.
 */
export function estateOptions(base                       , extras              , values            )                    {
  const v             = { ...SIZING_FORM_DEFAULTS, ...values };
  const failures = failuresOf(v.hostFailures);
  const { selected, clusterStorage: _cs, hostFailures: _hf, vsanArchitecture: _va, ...rest } = base;
  return {
    ...rest,
    // An empty scope in a plan means nothing was selected, not everything.
    selected: selected.length > 0 ? selected : ['(none)'],
    ...(extras.vsanArchitecture ? { vsanArchitecture: extras.vsanArchitecture } : {}),
    clusterStorage: extras.clusterStorage,
    nsxPerDomain: extras.nsxPerDomain,
    nsxManagerSize: extras.nsxManagerSize,
    profile: oneOf(v.profile, PROFILES) ?? 'simple',
    version: oneOf(v.version, VERSION_OPTIONS.map((o) => o.value)) ?? '9.1.1',
    ...(failures !== undefined ? { hostFailures: failures, reserveHostFailure: failures > 0 } : {}),
  };
}
