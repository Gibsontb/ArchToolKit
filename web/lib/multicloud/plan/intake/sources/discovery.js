/**
 * The discovery file (`archtoolkit.discovery` v1), addendum A.3.2.
 *
 * Every generated collector (Hyper-V, SCVMM, Nutanix AHV, KVM / libvirt,
 * Proxmox VE, oVirt / RHV / OLVM, Xen / XCP-ng, the Windows and Linux guest
 * collectors, and the AWS / Azure / Google Cloud (GCP) / OCI collectors)
 * writes this one JSON shape, so the page has one parser:
 *
 * ```json
 * { "kind": "archtoolkit.discovery", "v": 1,
 *   "source": { "platform": "hyperv", "manager": "hv-cluster-01" },
 *   "collectedAt": "2026-09-20",
 *   "servers": [{ "name": "app01", "id": "…", "host": "hv03", "cluster": "hv-cluster-01",
 *     "powerState": "poweredOn", "vcpu": 4, "ramGib": 16, "firmware": "efi",
 *     "disks": [{ "gib": 127, "usedGib": 61 }], "nics": [{ "ipv4": ["10.1.2.3"], "ipv6": ["2001:db8::3"] }],
 *     "os": { "raw": "Windows Server 2019 Datacenter", "version": "10.0.17763" },
 *     "software": ["…"], "services": ["MSSQLSERVER"],
 *     "listening": [{ "port": 1433, "proto": "tcp", "process": "sqlservr" }],
 *     "connections": [{ "remote": "10.1.2.9", "port": 1433, "proto": "tcp", "count": 118 }],
 *     "utilisation": { "days": 14, "samples": 20160, "coverage": 0.97, "cpuP95Pct": 31, … } }] }
 * ```
 *
 * Optional server fields beyond the design's example, all written by the
 * collectors where the platform has them: `region`, `bmc`, `size` (a cloud
 * instance type; vCPU and RAM come from the catalogue when the collector could
 * not read them), `kind` (`vm`, `lxc`, `physical`, `instance`), `tags`,
 * `annotation`, `product`, `shares`, `printers`, `sessions`, `app`, `env`.
 *
 * The files carry no user name, collector host name or path, and
 * `collectedAt` is a date only.
 */

import { error, info, warning,              } from '../../../../core/findings.js';
import { instanceSpec,                   } from '../../../../kit/instance-specs.js';
import { classifyOs } from '../../os.js';
import { ENV_OPTIONS, SOURCE_PLATFORM_VALUES, optionValue } from '../../options.js';
                                                                                                                                  
import { concatIntake, emptyIntake, isoDay,                                       } from '../adapter.js';
import { intakeFromSourceServers,                                             } from './common.js';

export const DISCOVERY_KIND = 'archtoolkit.discovery';

                                                                                                          
                                                                                                                                                        
                                                                                                                                                                    

                                  
                        
                       
                         
                            
                           
                        
                                                         
                               
                         
                           
                         
                             
                                            
                                          
                                                                                             
                                        
                                        
                                                                                                                
                                                        
                                              
                                                   
                               
                            
                           
                             
                             
                        
                        
 

                                
                                       
                
                                                                                    
                                
                                               
 

                                 
                                
                                   
                                                                                     
                                                                                                                                 
                               
 

const isObj = (v         )                               => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonNeg = (v         )                     => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
const strs = (v         )           => (Array.isArray(v) ? v.filter((x)              => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : typeof v === 'string' && v.trim() !== '' ? [v.trim()] : []);
const str = (v         )                     => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : undefined);

/** Collector power words to `PowerState`. */
export function powerStateOf(text                    )             {
  const t = (text ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (['poweredon', 'running', 'on', 'up', 'active', 'started', 'vmrunning'].includes(t)) return 'poweredOn';
  if (['poweredoff', 'off', 'stopped', 'down', 'halted', 'deallocated', 'terminated', 'shutoff', 'shutdown', 'vmdeallocated', 'vmstopped', 'terminating', 'stopping'].includes(t)) return 'poweredOff';
  if (['suspended', 'paused', 'saved', 'pmsuspended'].includes(t)) return 'suspended';
  return 'unknown';
}

const SPEC_PLATFORM                                                = { aws: 'aws', azure: 'azure', google: 'google', oci: 'oci' };

/** Google custom machine types: `custom-4-16384`, `n2-custom-8-32768[-ext]`. */
function googleCustom(size        )                                               {
  const m = /(?:^|-)custom-(\d+)-(\d+)(?:-ext)?$/.exec(size);
  return m ? { vcpu: Number(m[1]), ramGib: Math.round((Number(m[2]) / 1024) * 10) / 10 } : undefined;
}

/**
 * The OS of a collector's text. Cloud image and licence names use dashes
 * ("rhel-9-server", "windows-server-2019-dc"): when the text as written is
 * vague, the same text with dashes and underscores as spaces is tried.
 */
export function osOf(raw        )       {
  const first = classifyOs(raw);
  if (first !== 'unknown' && first !== 'linux-other' && first !== 'other') return first;
  const second = classifyOs(raw.replace(/[-_]+/g, ' '));
  return second !== 'unknown' && second !== 'linux-other' && second !== 'other' ? second : first;
}

function utilisationOf(v         )                          {
  if (!isObj(v)) return undefined;
  const days = nonNeg(v.days) ?? 0;
  const samples = nonNeg(v.samples) ?? 0;
  const coverage = Math.min(1, nonNeg(v.coverage) ?? 0);
  const out                          = { days, samples, coverage };
  for (const k of ['cpuP50Pct', 'cpuP95Pct', 'cpuP99Pct', 'cpuMaxPct', 'memP95Gib', 'memMaxGib', 'iopsP95', 'iopsMax', 'mbpsP95', 'netMbpsP95']         ) {
    const n = nonNeg(v[k]);
    if (n !== undefined) out[k] = n;
  }
  return Object.keys(out).length > 3 ? (out                          ) : undefined;
}

function serverOf(raw                         , platform                , manager                    , idx        , findings           )                           {
  const name = str(raw.name);
  if (!name) {
    findings.push(warning('plan.sources.discovery.no-name', `Server ${idx + 1} in the discovery file has no name and was skipped.`));
    return undefined;
  }
  let vcpu = nonNeg(raw.vcpu) ?? 0;
  let ramGib = nonNeg(raw.ramGib) ?? 0;
  const size = str(raw.size);
  if ((vcpu === 0 || ramGib === 0) && size) {
    const sp = SPEC_PLATFORM[platform];
    const spec = sp ? instanceSpec(sp, size) : undefined;
    const custom = platform === 'google' ? googleCustom(size) : undefined;
    const got = spec ? { vcpu: spec.vcpu, ramGib: spec.ramGib } : custom;
    if (got) {
      if (vcpu === 0) vcpu = got.vcpu;
      if (ramGib === 0) ramGib = got.ramGib;
    } else findings.push(warning('plan.sources.discovery.unknown-size', `${name}: size "${size}" is not in the ${platform} catalogue, so its vCPU and memory are unknown.`, { remediation: 'Type the vCPU and memory on the Servers grid.' }));
  }
  const disks = Array.isArray(raw.disks) ? raw.disks.filter(isObj) : [];
  const disksGib = disks.map((d) => Math.ceil(nonNeg(d.gib) ?? 0)).filter((g) => g > 0);
  const used = disks.map((d) => nonNeg(d.usedGib));
  const nics = Array.isArray(raw.nics) ? raw.nics.filter(isObj) : [];
  const ips = [...new Set(nics.flatMap((n) => [...strs(n.ipv4), ...strs(n.ipv6)]))];
  const osObj = isObj(raw.os) ? raw.os : {};
  const osRaw = [str(osObj.raw), str(osObj.name)].find((s) => !!s) ?? '';
  const osVersion = str(osObj.version);
  const listening                  = (Array.isArray(raw.listening) ? raw.listening.filter(isObj) : [])
    .map((l) => ({ port: nonNeg(l.port) ?? -1, proto: (String(l.proto ?? 'tcp').toLowerCase() === 'udp' ? 'udp' : 'tcp')                          , ...(str(l.process) ? { process: str(l.process)  } : {}) }))
    .filter((l) => l.port > 0 && l.port < 65536);
  const seen = new Set        ();
  const listeningUnique = listening.filter((l) => { const k = `${l.port}/${l.proto}/${l.process ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const util = utilisationOf(raw.utilisation);
  const firmware = /efi|uefi/i.test(str(raw.firmware) ?? '') ? 'efi' : /bios|legacy|seabios/i.test(str(raw.firmware) ?? '') ? 'bios' : undefined;
  const kind = str(raw.kind);
  const facts                = {
    powerState: powerStateOf(str(raw.powerState)),
    ...(firmware ? { firmware } : {}),
    ...(ips.length > 0 ? { ipAddresses: ips } : {}),
    ...(osRaw || osVersion ? { guestOsRaw: [osRaw, osVersion].filter((s) => !!s).join(' | ') } : {}),
    ...(used.some((u) => u !== undefined) ? { disksUsedGib: used.map((u) => Math.round((u ?? 0) * 10) / 10) } : {}),
    ...(util ? { utilisation: util } : {}),
    ...(strs(raw.software).length > 0 ? { software: strs(raw.software) } : {}),
    ...(strs(raw.services).length > 0 ? { services: strs(raw.services) } : {}),
    ...(listeningUnique.length > 0 ? { listening: listeningUnique } : {}),
  };
  const tags                         = {};
  if (isObj(raw.tags)) for (const [k, v] of Object.entries(raw.tags)) if (str(v) !== undefined) tags[k] = str(v) ;
  const origin                 = kind === 'physical' && platform !== 'physical' ? 'physical' : platform;
  const sourceRef            = {
    platform: origin,
    ...(manager ? { manager } : {}),
    ...(str(raw.id) ? { id: str(raw.id)  } : {}),
    ...(str(raw.host) ? { host: str(raw.host)  } : {}),
    ...(str(raw.cluster) ? { cluster: str(raw.cluster)  } : {}),
    ...(str(raw.region) ? { region: str(raw.region)  } : {}),
    ...(str(raw.bmc) ? { bmc: str(raw.bmc)  } : {}),
  };
  const env = str(raw.env) ? optionValue(ENV_OPTIONS, str(raw.env) ) : undefined;
  const annotation = [str(raw.annotation), kind === 'lxc' ? 'LXC container' : undefined].filter((s) => !!s).join('; ');
  const detect = {
    ...(nonNeg(raw.shares) !== undefined ? { shares: nonNeg(raw.shares)  } : {}),
    ...(nonNeg(raw.printers) !== undefined ? { printers: nonNeg(raw.printers)  } : {}),
    ...(nonNeg(raw.sessions) !== undefined ? { sessions: nonNeg(raw.sessions)  } : {}),
    ...(str(raw.product) ? { product: str(raw.product)  } : {}),
  };
  return {
    name,
    ...(str(raw.app) ? { app: str(raw.app)  } : {}),
    ...(env ? { env: env        } : {}),
    os: osOf(osRaw),
    vcpu,
    memoryGib: ramGib,
    disksGib,
    provisionedGib: disksGib.reduce((a, b) => a + b, 0),
    ...(annotation ? { annotation } : {}),
    ...(osRaw ? { guestOs: osRaw } : {}),
    sourceKey: `${manager ?? platform}/${str(raw.id) ?? name}`,
    facts,
    origin,
    sourceRef,
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    ...(Object.keys(detect).length > 0 ? { detect } : {}),
  };
}

/** Reads one discovery file (text or parsed JSON). Never throws. */
export function parseDiscovery(input                  )                 {
  const findings            = [];
  let doc          = input;
  if (typeof input === 'string') {
    try { doc = JSON.parse(input.replace(/^﻿/, '')); } catch (e) {
      return { servers: [], connections: [], findings: [error('plan.sources.discovery.json', `The discovery file is not JSON: ${(e         ).message}.`)] };
    }
  }
  if (!isObj(doc) || doc.kind !== DISCOVERY_KIND) {
    return { servers: [], connections: [], findings: [error('plan.sources.discovery.kind', `This is not an ${DISCOVERY_KIND} file (its "kind" is ${isObj(doc) ? JSON.stringify(doc.kind ?? null) : 'missing'}).`)] };
  }
  if (doc.v !== 1) findings.push(warning('plan.sources.discovery.version', `Discovery file version ${JSON.stringify(doc.v)}; this page reads version 1, so newer fields are ignored.`));
  const src = isObj(doc.source) ? doc.source : {};
  const platform = str(src.platform)                              ;
  if (!platform || !(SOURCE_PLATFORM_VALUES                     ).includes(platform)) {
    return { servers: [], connections: [], findings: [...findings, error('plan.sources.discovery.platform', `Unknown source platform ${JSON.stringify(src.platform ?? null)}; expected one of ${SOURCE_PLATFORM_VALUES.join(', ')}.`)] };
  }
  const manager = str(src.manager);
  const rawServers = Array.isArray(doc.servers) ? doc.servers.filter(isObj) : [];
  const servers                 = [];
  const connections                                          = [];
  rawServers.forEach((raw, i) => {
    const s = serverOf(raw, platform, manager, i, findings);
    if (!s) return;
    servers.push(s);
    for (const c of Array.isArray(raw.connections) ? raw.connections.filter(isObj) : []) {
      const remote = str(c.remote);
      const port = nonNeg(c.port);
      if (!remote || port === undefined) continue;
      connections.push({ server: s.name, ips: s.facts?.ipAddresses ?? [], connection: { remote, port, ...(str(c.proto) ? { proto: str(c.proto)  } : {}), ...(nonNeg(c.count) !== undefined ? { count: nonNeg(c.count)  } : {}), ...(str(c.process) ? { process: str(c.process)  } : {}) } });
    }
  });
  if (servers.length === 0) findings.push(warning('plan.sources.discovery.empty', 'The discovery file lists no servers.'));
  const lxc = rawServers.filter((r) => r.kind === 'lxc').map((r) => str(r.name)).filter((n)              => !!n);
  if (lxc.length > 0) {
    findings.push(info('plan.sources.lxc', `${lxc.length} LXC container${lxc.length === 1 ? '' : 's'} (${lxc.slice(0, 5).join(', ')}) are candidates for the containers pattern rather than a VM move.`, {
      remediation: 'Set the app pattern to containers, or keep them as servers to rebuild as VMs.',
    }));
  }
  const file                = {
    kind: DISCOVERY_KIND, v: 1,
    source: { platform, ...(manager ? { manager } : {}) },
    ...(str(doc.collectedAt) ? { collectedAt: isoDay(str(doc.collectedAt)) } : {}),
    servers: rawServers                                ,
  };
  return { file, servers, connections, findings };
}

/** One or more discovery files to planner rows (the collection date of the first dates the support checks). */
export function intakeFromDiscovery(inputs                               , opts                      = {})               {
  if (inputs.length === 0) return emptyIntake();
  const parsed = inputs.map((i) => parseDiscovery(i));
  const servers = parsed.flatMap((p) => p.servers);
  const on = opts.on ?? parsed.find((p) => p.file?.collectedAt)?.file?.collectedAt;
  const rows = intakeFromSourceServers(servers, { ...opts, ...(on ? { on } : {}) });
  return concatIntake([{ ...emptyIntake(), findings: parsed.flatMap((p) => p.findings) }, rows]);
}

/**
 * Established connections as `flows.csv` lines (addendum A.10.1:
 * `source_ip,dest_ip,dest_port,protocol,observations,first_seen,last_seen,bytes`),
 * for the WP-21 flow import. The source IP is the server's first address.
 */
export function discoveryFlowsCsv(parses                           )         {
  const lines = ['source_ip,dest_ip,dest_port,protocol,observations,first_seen,last_seen,bytes'];
  for (const p of parses) {
    const day = p.file?.collectedAt ?? '';
    for (const c of p.connections) {
      const src = c.ips[0] ?? c.server;
      lines.push([src, c.connection.remote, c.connection.port, (c.connection.proto ?? 'tcp').toLowerCase(), c.connection.count ?? 1, day, day, ''].join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

                                                                                 

export const DISCOVERY_ADAPTER                                                     = {
  id: 'discovery',
  label: 'Collector files (Hyper-V, SCVMM, Nutanix AHV, KVM, Proxmox, oVirt / OLVM, Xen, physical, AWS, Azure, Google Cloud (GCP), OCI)',
  itemSource: 'estate',
  parse: (input, options) => intakeFromDiscovery(input.files, options ?? {}),
};
