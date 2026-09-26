/**
 * The Kubernetes input grid (addendum A.2.8.5), and its import from
 * `kubectl get deploy,sts,ds -A -o json` (and `kubectl get nodes -o json`,
 * for the source cluster's shape).
 *
 * Grid, one line per workload, " | " between cells:
 * `Workload | Kind | Replicas | CPU request (m) | CPU limit (m) | Memory request (MiB) | Memory limit (MiB) | Arch | Pool`
 */

import { warning,              } from '../../../core/findings.js';

                                                                 
export const K8S_KINDS                     = ['Deployment', 'StatefulSet', 'DaemonSet'];

                              
                        
                         
                                            
                            
                               
                             
                                 
                               
                                           
                        
 

export const K8S_GRID_COLUMNS = ['Workload', 'Kind', 'Replicas', 'CPU request (m)', 'CPU limit (m)', 'Memory request (MiB)', 'Memory limit (MiB)', 'Arch', 'Pool']         ;

/** A CPU quantity in millicores: '500m', '1', '0.25', '2000000n'. */
export function cpuMillis(q         )         {
  if (q === undefined || q === null || q === '') return 0;
  const s = String(q).trim();
  const m = /^([0-9.]+)\s*([a-zA-Z]*)$/.exec(s);
  if (!m) return 0;
  const v = Number(m[1]);
  switch (m[2]) {
    case 'm': return Math.round(v);
    case 'u': return Math.round(v / 1000);
    case 'n': return Math.round(v / 1_000_000);
    case '': return Math.round(v * 1000);
    default: return 0;
  }
}

const BIN                                   = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50 };
const DEC                                   = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, m: 1e-3 };

/** A memory quantity in MiB: '512Mi', '1Gi', '1G', '134217728', '1e9'. */
export function memMib(q         )         {
  if (q === undefined || q === null || q === '') return 0;
  const s = String(q).trim();
  const m = /^([0-9.eE+-]+?)\s*(Ki|Mi|Gi|Ti|Pi|k|K|M|G|T|P|m)?$/.exec(s);
  if (!m) return 0;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return 0;
  const bytes = m[2] ? v * (BIN[m[2]] ?? DEC[m[2]] ?? 1) : v;
  return Math.round((bytes / 2 ** 20) * 100) / 100;
}

                                                                                                            
                    
                
                                                                                    
          
                      
                                                                                                                                                
    
 

function sumContainers(list                                  , pick                          )         {
  return (list ?? []).reduce((s, c) => s + pick(c), 0);
}
function maxContainers(list                                  , pick                          )         {
  return (list ?? []).reduce((s, c) => Math.max(s, pick(c)), 0);
}

/**
 * Parse `kubectl get deploy,sts,ds -A -o json` (a v1 List). A pod's request is
 * the sum of its containers', or the largest init container's if that is
 * higher (Kubernetes' effective request). Workloads with no requests are kept
 * and flagged: they would be sized as zero.
 */
export function parseKubectlWorkloads(json                 )                                                    {
  const findings            = [];
  let doc                                       ;
  try {
    doc = typeof json === 'string' ? JSON.parse(json) : (json                          );
  } catch (e) {
    return { workloads: [], findings: [warning('size.k8s.import-json', `The kubectl export is not JSON: ${(e         ).message}.`)] };
  }
  const items = Array.isArray(doc.items) ? doc.items : doc.kind && K8S_KINDS.includes(doc.kind           ) ? [doc            ] : [];
  const workloads                = [];
  for (const it of items) {
    if (!it.kind || !K8S_KINDS.includes(it.kind           )) continue;
    const kind = it.kind           ;
    const ns = it.metadata?.namespace ?? 'default';
    const name = `${ns}/${it.metadata?.name ?? 'unnamed'}`;
    const pod = it.spec?.template?.spec;
    const req = (c           , k        ) => c.resources?.requests?.[k];
    const lim = (c           , k        ) => c.resources?.limits?.[k] ?? c.resources?.requests?.[k];
    const cpuReq = Math.max(sumContainers(pod?.containers, (c) => cpuMillis(req(c, 'cpu'))), maxContainers(pod?.initContainers, (c) => cpuMillis(req(c, 'cpu'))));
    const cpuLim = Math.max(sumContainers(pod?.containers, (c) => cpuMillis(lim(c, 'cpu'))), maxContainers(pod?.initContainers, (c) => cpuMillis(lim(c, 'cpu'))));
    const memReq = Math.max(sumContainers(pod?.containers, (c) => memMib(req(c, 'memory'))), maxContainers(pod?.initContainers, (c) => memMib(req(c, 'memory'))));
    const memLim = Math.max(sumContainers(pod?.containers, (c) => memMib(lim(c, 'memory'))), maxContainers(pod?.initContainers, (c) => memMib(lim(c, 'memory'))));
    if (cpuReq === 0 && memReq === 0) {
      findings.push(warning('size.k8s.no-requests', `${kind} ${name} sets no CPU or memory requests; it is sized as zero. Set requests before sizing.`));
    }
    const archSel = pod?.nodeSelector?.['kubernetes.io/arch'];
    const pool = pod?.nodeSelector?.['atk/pool'] ?? pod?.nodeSelector?.['agentpool'] ?? pod?.nodeSelector?.['cloud.google.com/gke-nodepool'] ?? 'user';
    workloads.push({
      name, kind,
      replicas: kind === 'DaemonSet' ? 1 : Math.max(0, Number(it.spec?.replicas ?? 1)),
      cpuRequestM: cpuReq, cpuLimitM: cpuLim, memRequestMib: memReq, memLimitMib: memLim,
      arch: archSel === 'arm64' ? 'arm64' : archSel === 'amd64' ? 'amd64' : 'any',
      pool: ns === 'kube-system' ? 'system' : pool,
    });
  }
  if (workloads.length === 0) findings.push(warning('size.k8s.import-empty', 'The kubectl export has no Deployments, StatefulSets or DaemonSets.'));
  return { workloads, findings };
}

/** The source cluster's nodes from `kubectl get nodes -o json`: count and allocatable per node. */
export function parseKubectlNodes(json                 )                                                                       {
  const doc = typeof json === 'string' ? JSON.parse(json)                                                                                                               : json                                                                                                              ;
  const items = doc.items ?? [];
  return {
    nodes: items.length,
    cpuMillis: items.reduce((s, n) => s + cpuMillis(n.status?.allocatable?.['cpu']), 0),
    memMib: items.reduce((s, n) => s + memMib(n.status?.allocatable?.['memory']), 0),
    arch: [...new Set(items.map((n) => n.status?.nodeInfo?.architecture ?? 'amd64'))].sort(),
  };
}

/** The grid text for a list of workloads. */
export function toGrid(list                        )         {
  return list.map((w) => [w.name, w.kind, w.replicas, w.cpuRequestM, w.cpuLimitM, w.memRequestMib, w.memLimitMib, w.arch, w.pool].join(' | ')).join('\n');
}

/** Parse the grid text (blank lines and '#' comments skipped; a header row is skipped). */
export function parseGrid(text        )                                                    {
  const findings            = [];
  const workloads                = [];
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  lines.forEach((line, i) => {
    const cells = ` ${line} `.split(/(?<=\s)\|(?=\s)/).map((c) => c.trim());
    if (cells[0] === 'Workload') return;
    const kind = (K8S_KINDS.find((k) => k.toLowerCase() === (cells[1] ?? '').toLowerCase()) ?? 'Deployment');
    const n = (j        , d = 0)         => { const v = Number(cells[j]); return Number.isFinite(v) && cells[j] !== '' ? v : d; };
    if (!cells[0]) {
      findings.push(warning('size.k8s.grid-row', `Row ${i + 1} has no workload name.`, { path: `k8s.workloads[${i}]` }));
      return;
    }
    const cpuReq = n(3);
    const memReq = n(5);
    workloads.push({
      name: cells[0], kind, replicas: kind === 'DaemonSet' ? 1 : n(2, 1), cpuRequestM: cpuReq, cpuLimitM: n(4, cpuReq),
      memRequestMib: memReq, memLimitMib: n(6, memReq),
      arch: cells[7] === 'arm64' ? 'arm64' : cells[7] === 'amd64' ? 'amd64' : 'any', pool: cells[8] || 'user',
    });
  });
  return { workloads, findings };
}
