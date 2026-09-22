/**
 * Editing a VCF deployment specification that already exists.
 *
 * The builder writes a spec from a plan. This is for the other case: a spec
 * that already deployed — exported from the VCF Installer, or built here —
 * and now needs changing because some of the systems have. New hostnames, a
 * re-addressed subnet, a different datastore, another host. Rebuilding it from
 * scratch would lose everything that was not changing; editing the JSON by
 * hand loses the checks.
 *
 * So the document is edited as it is, field by field, and everything the page
 * needs to do that well lives here, apart from the DOM:
 *
 *  - paths, and reading and writing through them without mutating the original;
 *  - the answer set for every field that has one, keyed by the path pattern
 *    (`networkSpecs[].teamingPolicy`), so a size or a teaming policy is a
 *    dropdown and not a text box;
 *  - what adding an entry to a list means (a copy of the last one, since a new
 *    host looks like the previous host);
 *  - find-and-replace across every value, for the change that touches forty
 *    fields at once — a domain, a subnet prefix, a site code;
 *  - the difference from the document as it was loaded;
 *  - the passwords, which an installer export carries in clear text.
 */

import { EVC_MODES } from './spec-types.js';

                                                                                       
                                                

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `["networkSpecs", 2, "subnet"]` → `networkSpecs[2].subnet`, as findings name it. */
export function pathString(path      )         {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${part}` : part;
  }
  return out;
}

/** `networkSpecs[2].subnet` → `networkSpecs[].subnet`: the key answer sets use. */
export function pathPattern(path      )         {
  return pathString(path).replace(/\[\d+\]/g, '[]');
}

export function parsePath(text        )       {
  const out                      = [];
  for (const m of text.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (m[2] !== undefined) out.push(Number(m[2]));
    else if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

export function getAt(doc      , path      )                   {
  let node                   = doc;
  for (const part of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = Array.isArray(node) ? node[part          ] : (node                        )[part          ];
  }
  return node;
}

/** A copy of `doc` with `value` at `path`. Missing parents are created. */
export function setAt(doc      , path      , value      )       {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (typeof head === 'number') {
    const arr = Array.isArray(doc) ? [...doc] : [];
    arr[head] = setAt(arr[head] ?? (typeof rest[0] === 'number' ? [] : {}), rest, value);
    return arr;
  }
  const obj = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? { ...doc } : {};
  obj[head          ] = setAt(obj[head          ] ?? (typeof rest[0] === 'number' ? [] : {}), rest, value);
  return obj;
}

/** A copy of `doc` without whatever is at `path`. */
export function removeAt(doc      , path      )       {
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1]                   ;
  const parent = getAt(doc, parentPath);
  if (Array.isArray(parent)) return setAt(doc, parentPath, parent.filter((_, i) => i !== key));
  if (parent && typeof parent === 'object') {
    const copy = { ...(parent                        ) };
    delete copy[key          ];
    return setAt(doc, parentPath, copy);
  }
  return doc;
}

/** Move a list entry up (-1) or down (+1). */
export function moveAt(doc      , path      , by        )       {
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1]          ;
  const list = getAt(doc, parentPath);
  if (!Array.isArray(list)) return doc;
  const to = index + by;
  if (to < 0 || to >= list.length) return doc;
  const copy = [...list];
  [copy[index], copy[to]] = [copy[to]        , copy[index]        ];
  return setAt(doc, parentPath, copy);
}

// ---------------------------------------------------------------------------
// Adding to a list
// ---------------------------------------------------------------------------

/**
 * What a new entry in this list should start as.
 *
 * A copy of the last entry, because a fourth host looks like the third and a
 * new network like the one before it — with its identity cleared, so two
 * entries never quietly share a hostname, a thumbprint or an address.
 */
export function newEntry(list                 )       {
  const last = list[list.length - 1];
  if (last === undefined) return '';
  if (typeof last !== 'object' || last === null) return typeof last === 'number' ? 0 : typeof last === 'boolean' ? false : '';
  return clearIdentity(structuredClone(last)        );
}

const IDENTITY = /^(hostname|sslThumbprint|sshThumbprint|password|startIpAddress|endIpAddress|start|end|datastoreName|name)$/;

function clearIdentity(value      )       {
  if (Array.isArray(value)) return value.map(clearIdentity);
  if (value === null || typeof value !== 'object') return value;
  const out                       = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = IDENTITY.test(k) && typeof v === 'string' ? '' : clearIdentity(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Answer sets
// ---------------------------------------------------------------------------

const SIZES_OPS = ['xsmall', 'small', 'medium', 'large', 'xlarge'];

/**
 * Fields with a fixed set of answers, by path pattern. Every value here is the
 * VCF 9.1 Installer API's own enumeration (see spec-types.ts), so a dropdown
 * cannot offer something the installer would refuse.
 */
export const CHOICES                                              = {
  workflowType: ['VCF', 'VCF_COMPLETE', 'VCF_EXTEND', 'VVF', 'VCF_BOOTSTRAP'],
  version: ['9.1.0.0', '9.1.0.400', '9.1.1.0'],
  'networkSpecs[].networkType': ['MANAGEMENT', 'VM_MANAGEMENT', 'VMOTION', 'VSAN', 'NFS', 'FLEET_MANAGEMENT'],
  'networkSpecs[].ipAddressVersion': ['IPv4', 'IPv6'],
  'networkSpecs[].assignmentMode': ['STATIC', 'DHCP', 'SLAAC'],
  'networkSpecs[].teamingPolicy': [
    'loadbalance_loadbased',
    'loadbalance_srcid',
    'loadbalance_srcmac',
    'loadbalance_ip',
    'failover_explicit',
  ],
  'networkSpecs[].activeUplinks[]': ['uplink1', 'uplink2', 'uplink3', 'uplink4'],
  'networkSpecs[].standbyUplinks[]': ['uplink1', 'uplink2', 'uplink3', 'uplink4'],
  'vcenterSpec.vmSize': ['tiny', 'small', 'medium', 'large', 'xlarge'],
  'vcenterSpec.storageSize': ['lstorage', 'xlstorage'],
  'nsxtSpec.nsxtManagerSize': ['medium', 'large', 'xlarge'],
  'vcfOperationsSpec.applianceSize': SIZES_OPS,
  'vcfOperationsSpec.nodes[].type': ['master', 'replica', 'data'],
  'vcfOperationsCollectorSpec.applianceSize': ['small', 'standard'],
  'vspClusterSpec.size': ['small', 'small_ha', 'medium', 'large'],
  'vcfAutomationSpec.size': ['small', 'medium', 'large'],
  'clusterSpec.clusterEvcMode': [...EVC_MODES],
  'dvsSpecs[].nsxtSwitchConfig.transportZones[].transportType': ['OVERLAY', 'VLAN'],
  'dvsSpecs[].nsxTeamings[].policy': ['LOADBALANCE_SRCID', 'LOADBALANCE_SRC_MAC', 'FAILOVER_ORDER'],
  'dvsSpecs[].nsxTeamings[].activeUplinks[]': ['uplink1', 'uplink2', 'uplink3', 'uplink4'],
  'dvsSpecs[].nsxTeamings[].standByUplinks[]': ['uplink1', 'uplink2', 'uplink3', 'uplink4'],
  'dvsSpecs[].vmnicsToUplinks[].uplink': ['uplink1', 'uplink2', 'uplink3', 'uplink4'],
  'dvsSpecs[].networks[]': ['MANAGEMENT', 'VM_MANAGEMENT', 'VMOTION', 'VSAN', 'NFS', 'FLEET_MANAGEMENT'],
  'hostSpecs[].credentials.username': ['root'],
  'vcenterSpec.ssoDomain': ['vsphere.local'],
};

export function choicesFor(path      )                                {
  return CHOICES[pathPattern(path)];
}

// ---------------------------------------------------------------------------
// Find and replace
// ---------------------------------------------------------------------------

                              
                        
                          
                         
 

/**
 * Every string value containing `find`, and what it becomes.
 *
 * Values only — keys are the schema and are never renamed. A key-aware
 * replace would let "hostname" become something the installer does not know.
 */
export function findReplace(doc      , find        , replace        )                                        {
  const changes                = [];
  if (!find) return { doc, changes };
  const walk = (node      , path                     )       => {
    if (typeof node === 'string') {
      if (!node.includes(find)) return node;
      const after = node.split(find).join(replace);
      changes.push({ path: pathString(path), before: node, after });
      return after;
    }
    if (Array.isArray(node)) return node.map((v, i) => walk(v, [...path, i]));
    if (node && typeof node === 'object') {
      const out                       = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, [...path, k]);
      return out;
    }
    return node;
  };
  return { doc: walk(doc, []), changes };
}

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------

                         
                        
                                                 
                         
                        
 

/** Leaf-level differences between two documents. */
export function diff(before      , after      , path                      = [])           {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const isObj = (v      ) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(before) && Array.isArray(after)) {
    // A list of plain values reads better as one change than as n.
    if (!before.some((v) => v !== null && typeof v === 'object') && !after.some((v) => v !== null && typeof v === 'object')) {
      return [{ path: pathString(path), kind: 'changed', before, after }];
    }
    const out           = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i += 1) {
      if (i >= before.length) out.push({ path: pathString([...path, i]), kind: 'added', after: after[i]         });
      else if (i >= after.length) out.push({ path: pathString([...path, i]), kind: 'removed', before: before[i]         });
      else out.push(...diff(before[i]        , after[i]        , [...path, i]));
    }
    return out;
  }
  if (isObj(before) && isObj(after)) {
    const b = before                        ;
    const a = after                        ;
    const out           = [];
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (!(key in a)) out.push({ path: pathString([...path, key]), kind: 'removed', before: b[key]         });
      else if (!(key in b)) out.push({ path: pathString([...path, key]), kind: 'added', after: a[key]         });
      else out.push(...diff(b[key]        , a[key]        , [...path, key]));
    }
    return out;
  }
  return [{ path: pathString(path), kind: 'changed', before, after }];
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRET_KEY = /password|passphrase|secret/i;

export function isSecretPath(path      )          {
  const last = path[path.length - 1];
  return typeof last === 'string' && SECRET_KEY.test(last);
}

/** Paths of every non-empty secret in the document. */
export function secretPaths(doc      )           {
  const out           = [];
  const walk = (node      , path                     )       => {
    if (typeof node === 'string') {
      if (isSecretPath(path) && node !== '' && node !== '<REQUIRED>') out.push(pathString(path));
      return;
    }
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i]));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
  };
  walk(doc, []);
  return out;
}

/**
 * The document with every password replaced by the installer's placeholder.
 *
 * An installer export carries the ESX root password in clear text. A spec
 * that is going to be emailed, committed or attached to a ticket should not.
 */
export function redactSecrets(doc      )       {
  let out = doc;
  for (const p of secretPaths(doc)) out = setAt(out, parsePath(p), '<REQUIRED>');
  return out;
}

/** A human label for a key: `vcfOperationsCollectorSpec` → `VCF Operations collector`. */
export function labelFor(key        )         {
  const special                         = {
    sddcId: 'SDDC ID',
    vcfInstanceName: 'VCF instance name',
    ceipEnabled: 'CEIP enabled',
    dnsSpec: 'DNS',
    ntpServers: 'NTP servers',
    hostSpecs: 'Hosts',
    networkSpecs: 'Networks',
    vspClusterSpec: 'VCF Management Services',
    vcfAutomationSpec: 'VCF Automation',
    nsxtSpec: 'NSX',
    vcfOperationsSpec: 'VCF Operations',
    vcfOperationsCollectorSpec: 'VCF Operations collector',
    licenseServerSpec: 'License server',
    vidbSpec: 'Identity broker',
    fleetLcmSpec: 'Fleet lifecycle',
    sddcLcmSpec: 'Instance lifecycle',
    vcenterSpec: 'vCenter',
    clusterSpec: 'Cluster',
    datastoreSpec: 'Datastore',
    dvsSpecs: 'Distributed switches',
    sddcManagerSpec: 'SDDC Manager',
    vlanId: 'VLAN',
    mtu: 'MTU',
    fqdn: 'FQDN',
    vipFqdn: 'VIP FQDN',
    ipPool: 'IP pool',
    ipv4Pool: 'IPv4 pool',
    sslThumbprint: 'SSL thumbprint',
    sshThumbprint: 'SSH thumbprint',
  };
  if (special[key]) return special[key]          ;
  const ACRONYMS                         = {
    ip: 'IP', ipv4: 'IPv4', ipv6: 'IPv6', fqdn: 'FQDN', nsxt: 'NSX', nsx: 'NSX', vcf: 'VCF', dvs: 'DVS',
    tep: 'TEP', lcm: 'LCM', mtu: 'MTU', evc: 'EVC', cidr: 'CIDR', vm: 'VM', vlan: 'VLAN', dns: 'DNS',
    ntp: 'NTP', sso: 'SSO', vsan: 'vSAN', vmfs: 'VMFS', nfs: 'NFS', fc: 'FC', lag: 'LAG', id: 'ID',
    ssl: 'SSL', ssh: 'SSH', vip: 'VIP', lacp: 'LACP', esx: 'ESX', vmnics: 'vmnics', dtgw: 'DTGW', vpc: 'VPC',
  };
  const words = key
    .replace(/Spec(s?)$/, '$1')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => ACRONYMS[w.toLowerCase()] ?? (i === 0 ? w[0] .toUpperCase() + w.slice(1) : w.toLowerCase()));
  return words.join(' ');
}
