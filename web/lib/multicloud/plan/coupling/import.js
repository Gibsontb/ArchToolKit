/**
 * Hidden coupling, imported (addendum A.2.9): the `archtoolkit.coupling` v1
 * files the guest collectors write, masked again on the way in, and each
 * reference resolved to a server, an app, a `site:` or external.
 *
 * ```json
 * { "kind": "archtoolkit.coupling", "v": 1, "collectedAt": "2026-09-20",
 *   "server": "app01", "os": "linux",
 *   "self": { "fqdn": "app01.corp.example", "ipv4": ["10.1.2.3"], "ipv6": [], "macs": ["00:50:56:aa:bb:cc"] },
 *   "refs": [{ "category": "connection-string", "where": "/opt/app/app.properties:14",
 *              "value": "db.url=jdbc:postgresql://10.1.2.9:5432/app", "points": ["10.1.2.9"] },
 *            { "category": "certificate", "where": "/etc/nginx/conf.d/app.conf", "value": "CN=app.corp.example",
 *              "subject": "CN=app.corp.example", "sans": ["app.corp.example"], "notAfter": "2027-01-31" }] }
 * ```
 *
 * Secrets are never kept: `maskSecrets` runs over every value even though the
 * collectors mask in the guest, and a value it had to change is reported
 * (the collector missed a secret) without keeping the secret.
 */

import { error, warning,              } from '../../../core/findings.js';
                                                  

export const COUPLING_KIND = 'archtoolkit.coupling';

                                                                                                                       
                                                                     
export const COUPLING_CATEGORIES                              = Object.freeze([
  'hosts', 'config', 'connection-string', 'scheduled-job', 'service-account', 'share', 'printer', 'smtp', 'snmp', 'certificate', 'licence', 'time',
]);

                              
                          
                                      
                                                                                   
                         
                
                         
                                                                                             
                                     
                             
                          
                              
                            
                           
                  
                             
                                    
                                        
                                       
                        
                             
 

                               
                         
                                   
                                   
                                   
 

                               
                                      
                
                                
                          
                                    
                              
                                        
 

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/** Key names whose values are secrets: password, passwd, pwd, secret, token, and anything ending in "key". */
const SECRET_KV = /((?:password|passwd|pwd|secret|token|[a-z0-9_.-]*key)\s*["']?\s*[=:]\s*["']?)[^;"'\s<>,&)]+/gi;
/** .NET appSettings and the like: key="DbPassword" value="…", where the secret is in the value attribute. */
const SECRET_SETTING = /(key\s*=\s*"[^"]*(?:password|pwd|secret|token|key)[^"]*"\s+value\s*=\s*")[^"]*/gi;
/** The password of a URL: scheme://user:password@host. */
const URL_PASSWORD = /(:\/\/[^:/@\s]*:)[^@/\s]+@/gi;

/**
 * Masks secrets in one value (the collectors apply the same rule in the
 * guest): any value of a key or connection-string part named like password,
 * pwd, secret, key or token becomes ***, and so do the value of a setting
 * whose key is so named and a URL's password.
 */
export function maskSecrets(text        )         {
  return text.replace(SECRET_SETTING, '$1***').replace(SECRET_KV, '$1***').replace(URL_PASSWORD, '$1***@');
}

// ---------------------------------------------------------------------------
// What a value points at
// ---------------------------------------------------------------------------

const IPV4 = /(?<![0-9.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9.])/g;
const IPV6 = /(?<![0-9a-f:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![0-9a-f:])/gi;
const UNC = /\\\\([a-z0-9._-]+)/gi;
const URL_HOST = /[a-z][a-z0-9+.-]*:\/\/(?:[^/:@\s]+(?::[^/@\s]*)?@)?(\[[0-9a-f:]+\]|[^/:@\s"'<>,;]+)/gi;
const KV_HOST = /(?:host|server|data source|address|addr|hostname)\s*=\s*(?:tcp:)?([a-z0-9._-]+)/gi;
const AT_HOST = /@(?:\/\/)?([a-z0-9._-]+):\d+/gi;
/** fstab-style CIFS (//server/share) and NFS (server:/export) sources. */
const MOUNT_HOST = /(?:^|\s)(?:\/\/([a-z0-9._-]{2,})\/|([a-z0-9._-]{2,}):\/(?!\/))/gi;
const LICENCE_SERVER = /^\s*(?:SERVER|HOST)\s+(\S+)/i;

export function isIpv4(s        )          {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}
export function isIpv6(s        )          {
  return /^[0-9a-f:]+$/i.test(s) && /[0-9a-f]/i.test(s) && s.includes(':') && v6ToBig(s.toLowerCase()) !== undefined;
}
const boring = (p        )          => /^(127\.|0\.0\.0\.0$|255\.|169\.254\.)/.test(p) || /^(::1|fe80:)/i.test(p) || /^(localhost|localhost\.localdomain)$/i.test(p);

/** The addresses and names a value points at; `domains` adds FQDN literals in those DNS suffixes. */
export function extractPoints(value        , domains                    = [])           {
  const out = new Set        ();
  for (const m of value.matchAll(IPV4)) if (isIpv4(m[0])) out.add(m[0]);
  for (const m of value.matchAll(IPV6)) if (isIpv6(m[0])) out.add(m[0].toLowerCase());
  for (const m of value.matchAll(UNC)) out.add(m[1] );
  for (const m of value.matchAll(URL_HOST)) out.add(m[1] .replace(/^\[|\]$/g, ''));
  for (const m of value.matchAll(KV_HOST)) out.add(m[1] );
  for (const m of value.matchAll(AT_HOST)) out.add(m[1] );
  for (const m of value.matchAll(MOUNT_HOST)) out.add((m[1] ?? m[2]) );
  const lic = LICENCE_SERVER.exec(value);
  if (lic) out.add(lic[1] );
  for (const d of domains) {
    const re = new RegExp(`[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.${d.replace(/\./g, '\\.')}`, 'gi');
    for (const m of value.matchAll(re)) out.add(m[0].toLowerCase());
  }
  return [...out].filter((p) => p !== '' && !boring(p) && !/^\d+$/.test(p)).slice(0, 20);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const isObj = (v         )                               => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v         )                     => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const strs = (v         )           => (Array.isArray(v) ? v.filter((x)              => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);

                                
                               
                               
                               
 

/** Reads one coupling file (text or parsed JSON). Never throws; never keeps a secret. */
export function parseCouplingFile(input                  , domains                    = [])                {
  let doc          = input;
  if (typeof input === 'string') {
    try { doc = JSON.parse(input.replace(/^﻿/, '')); } catch (e) {
      return { refs: [], findings: [error('coupling.json', `The coupling file is not JSON: ${(e         ).message}.`)] };
    }
  }
  if (!isObj(doc) || doc.kind !== COUPLING_KIND) {
    return { refs: [], findings: [error('coupling.kind', `This is not an ${COUPLING_KIND} file.`)] };
  }
  const findings            = [];
  if (doc.v !== 1) findings.push(warning('coupling.version', `Coupling file version ${JSON.stringify(doc.v)}; this page reads version 1.`));
  const server = str(doc.server);
  if (!server) return { refs: [], findings: [...findings, error('coupling.server', 'The coupling file names no server.')] };
  const selfObj = isObj(doc.self) ? doc.self : {};
  const self               = {
    ...(str(selfObj.fqdn) ? { fqdn: str(selfObj.fqdn) .replace(/\.$/, '') } : {}),
    ipv4: strs(selfObj.ipv4), ipv6: strs(selfObj.ipv6).map((s) => s.toLowerCase()), macs: strs(selfObj.macs).map((s) => s.toLowerCase()),
  };
  const selfNames = new Set([server.toLowerCase(), ...(self.fqdn ? [self.fqdn.toLowerCase(), self.fqdn.toLowerCase().split('.')[0] ] : []), ...self.ipv4, ...self.ipv6]);
  const refs                = [];
  let unmasked = 0;
  let unknownCategory = 0;
  for (const raw of Array.isArray(doc.refs) ? doc.refs.filter(isObj) : []) {
    const category = str(raw.category)                                ;
    if (!category || !COUPLING_CATEGORIES.includes(category)) { unknownCategory += 1; continue; }
    const rawValue = typeof raw.value === 'string' ? raw.value : '';
    const value = maskSecrets(rawValue);
    if (value !== rawValue) unmasked += 1;
    const points = [...new Set([...strs(raw.points), ...extractPoints(value, domains)].map((p) => (isIpv6(p) ? p.toLowerCase() : p)))]
      .filter((p) => !selfNames.has(p.toLowerCase()) && !boring(p));
    const optional                          = {};
    for (const k of ['schedule', 'runAs', 'scheduler', 'subject', 'issuer', 'notAfter', 'mac', 'timezone']         ) {
      const v = str(raw[k]);
      if (v !== undefined) optional[k] = k === 'subject' || k === 'issuer' ? maskSecrets(v) : v;
    }
    if (strs(raw.sans).length > 0) optional.sans = strs(raw.sans);
    if (strs(raw.bindings).length > 0) optional.bindings = strs(raw.bindings);
    if (raw.binding === 'mac' || raw.binding === 'host-id') optional.binding = raw.binding;
    refs.push({ server, category, where: str(raw.where) ?? '', value, points, ...optional }               );
  }
  if (unmasked > 0) {
    findings.push(warning('coupling.unmasked', `${server}: ${unmasked} value${unmasked === 1 ? '' : 's'} still held a secret and ${unmasked === 1 ? 'was' : 'were'} masked on import; the secret was not kept.`, {
      remediation: 'Update the coupling collector to the current version, and rotate the credential if the file was shared.',
    }));
  }
  if (unknownCategory > 0) findings.push(warning('coupling.category', `${server}: ${unknownCategory} reference${unknownCategory === 1 ? '' : 's'} with an unknown category were ignored.`));
  const file               = {
    kind: COUPLING_KIND, v: 1, server, self, refs,
    ...(str(doc.collectedAt) ? { collectedAt: str(doc.collectedAt) .slice(0, 10) } : {}),
    ...(doc.os === 'windows' || doc.os === 'linux' ? { os: doc.os } : {}),
  };
  return { file, refs, findings };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

                                                          

                             
                         
                              
                                                            
                         
                          
                        
                                                      
                       
 

                              
                            
                                              
 

                                 
                                          
                                   
 

function v4ToInt(ip        )         {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
function v6ToBig(ip        )                     {
  const [head, tail] = ip.includes('::') ? ip.split('::')                     : [ip, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  if (tail === undefined && h.length !== 8) return undefined;
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  return groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g, 16)), 0n);
}

/** True when the address is inside the CIDR (either family). */
export function inCidr(ip        , cidr        )          {
  const [net, lenText] = cidr.split('/');
  const len = Number(lenText);
  if (!net || !Number.isInteger(len)) return false;
  if (isIpv4(ip) && isIpv4(net)) {
    if (len === 0) return true;
    const mask = len >= 32 ? 0xffffffff : (~((1 << (32 - len)) - 1)) >>> 0;
    return (v4ToInt(ip) & mask) === (v4ToInt(net) & mask);
  }
  const a = v6ToBig(ip.toLowerCase());
  const b = v6ToBig(net.toLowerCase());
  if (a === undefined || b === undefined) return false;
  const shift = BigInt(128 - Math.min(128, len));
  return a >> shift === b >> shift;
}

/** One point to a server (by address or name), a site (by CIDR), or external. */
export function resolvePoint(point        , ctx                )             {
  const p = point.toLowerCase();
  const ip = isIpv4(p) || isIpv6(p);
  for (const w of ctx.workloads) {
    if (ip) {
      if ((w.facts?.ipAddresses ?? []).some((a) => a.toLowerCase() === p)) return { point, kind: 'server', name: w.name, app: w.app, by: 'ip' };
    } else {
      const n = w.name.toLowerCase();
      if (n === p) return { point, kind: 'server', name: w.name, app: w.app, by: 'name' };
      if (p.split('.')[0] === n || n.split('.')[0] === p) return { point, kind: 'server', name: w.name, app: w.app, by: 'fqdn' };
    }
  }
  if (ip) {
    for (const s of ctx.sites ?? []) if (s.cidrs.some((c) => inCidr(p, c))) return { point, kind: 'site', name: `site:${s.name}`, by: 'cidr' };
  }
  return { point, kind: 'external' };
}

export function resolveCoupling(refs                        , ctx                )                {
  return refs.map((ref) => ({ ref, resolutions: ref.points.map((p) => resolvePoint(p, ctx)) }));
}

/** Several files at once: refs, findings, and each server's own addresses (for licence MAC checks). */
export function importCoupling(inputs                               , domains                    = [])                                                                                     {
  const refs                = [];
  const selves                               = {};
  const findings            = [];
  for (const input of inputs) {
    const p = parseCouplingFile(input, domains);
    refs.push(...p.refs);
    findings.push(...p.findings);
    if (p.file) selves[p.file.server] = p.file.self;
  }
  return { refs, selves, findings };
}
