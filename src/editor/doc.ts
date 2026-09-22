/**
 * Editing a structured document — JSON or YAML — in place.
 *
 * Everything the data editor does to a document, apart from the DOM:
 *
 *  - paths, and reading and writing through them without mutating the original;
 *  - what adding an entry to a list means (a copy of the last one, with its
 *    identity cleared, since a new host looks like the previous host);
 *  - find-and-replace across every value, for the change that touches forty
 *    fields at once — a domain, a subnet prefix, a site code;
 *  - the difference from the document as it was loaded;
 *  - secrets, which exports carry in clear text more often than they should;
 *  - a readable label for a key.
 *
 * What a field is allowed to hold, and what makes a document wrong, belongs to
 * the profile for that kind of file (./profiles).
 */

import { joinPath } from '../core/yaml-read.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Path = readonly (string | number)[];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * `["networkSpecs", 2, "subnet"]` → `networkSpecs[2].subnet`, as findings name
 * it. A key that is not a plain name goes in brackets as a JSON string:
 * `tasks[0]["ansible.builtin.copy"]`.
 */
export function pathString(path: Path): string {
  let out = '';
  for (const part of path) out = joinPath(out, part);
  return out;
}

/** `networkSpecs[2].subnet` → `networkSpecs[].subnet`: the key answer sets use. */
export function pathPattern(path: Path): string {
  let out = '';
  for (const part of path) out = typeof part === 'number' ? `${out}[]` : joinPath(out, part);
  return out;
}

export function parsePath(text: string): Path {
  const out: (string | number)[] = [];
  for (const m of text.matchAll(/\[("(?:[^"\\]|\\.)*")\]|\[(\d+)\]|([^.[\]]+)/g)) {
    if (m[1] !== undefined) out.push(JSON.parse(m[1]) as string);
    else if (m[2] !== undefined) out.push(Number(m[2]));
    else if (m[3] !== undefined) out.push(m[3]);
  }
  return out;
}

export function isRecord(value: Json | undefined): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getAt(doc: Json, path: Path): Json | undefined {
  let node: Json | undefined = doc;
  for (const part of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = Array.isArray(node) ? node[part as number] : (node as Record<string, Json>)[part as string];
  }
  return node;
}

/** A copy of `doc` with `value` at `path`. Missing parents are created. */
export function setAt(doc: Json, path: Path, value: Json): Json {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (typeof head === 'number') {
    const arr = Array.isArray(doc) ? [...doc] : [];
    arr[head] = setAt(arr[head] ?? (typeof rest[0] === 'number' ? [] : {}), rest, value);
    return arr;
  }
  const obj = isRecord(doc) ? { ...doc } : {};
  obj[head as string] = setAt(obj[head as string] ?? (typeof rest[0] === 'number' ? [] : {}), rest, value);
  return obj;
}

/** A copy of `doc` without whatever is at `path`. */
export function removeAt(doc: Json, path: Path): Json {
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1] as string | number;
  const parent = getAt(doc, parentPath);
  if (Array.isArray(parent)) return setAt(doc, parentPath, parent.filter((_, i) => i !== key));
  if (isRecord(parent)) {
    const copy = { ...parent };
    delete copy[key as string];
    return setAt(doc, parentPath, copy);
  }
  return doc;
}

/** Move a list entry up (-1) or down (+1). */
export function moveAt(doc: Json, path: Path, by: -1 | 1): Json {
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1] as number;
  const list = getAt(doc, parentPath);
  if (!Array.isArray(list)) return doc;
  const to = index + by;
  if (to < 0 || to >= list.length) return doc;
  const copy = [...list];
  [copy[index], copy[to]] = [copy[to] as Json, copy[index] as Json];
  return setAt(doc, parentPath, copy);
}

/** A copy of `doc` with the key at `path` renamed, keeping its place in the object. */
export function renameAt(doc: Json, path: Path, to: string): Json {
  const parentPath = path.slice(0, -1);
  const from = path[path.length - 1];
  const parent = getAt(doc, parentPath);
  if (!isRecord(parent) || typeof from !== 'string' || from === to || to in parent) return doc;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(parent)) out[k === from ? to : k] = v;
  return setAt(doc, parentPath, out);
}

// ---------------------------------------------------------------------------
// Adding to a list
// ---------------------------------------------------------------------------

/** Keys that name one particular thing, and so are cleared on a copied entry. */
export const DEFAULT_IDENTITY =
  /^(hostname|sslThumbprint|sshThumbprint|password|startIpAddress|endIpAddress|start|end|datastoreName|name|id|Sid|uid|arn|ip|ipAddress|ansible_host|address)$/;

/**
 * What a new entry in this list should start as.
 *
 * A copy of the last entry, because a fourth host looks like the third and a
 * new network like the one before it — with its identity cleared, so two
 * entries never quietly share a hostname, a thumbprint or an address.
 */
export function newEntry(list: readonly Json[], identity: RegExp = DEFAULT_IDENTITY): Json {
  const last = list[list.length - 1];
  if (last === undefined) return '';
  if (typeof last !== 'object' || last === null) return typeof last === 'number' ? 0 : typeof last === 'boolean' ? false : '';
  return clearIdentity(structuredClone(last) as Json, identity);
}

function clearIdentity(value: Json, identity: RegExp): Json {
  if (Array.isArray(value)) return value.map((v) => clearIdentity(v, identity));
  if (!isRecord(value)) return value;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = identity.test(k) && typeof v === 'string' ? '' : clearIdentity(v, identity);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Find and replace
// ---------------------------------------------------------------------------

export interface Replacement {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

/**
 * Every string value containing `find`, and what it becomes.
 *
 * Values only — keys are the schema and are never renamed. A key-aware
 * replace would let "hostname" become something the consumer does not know.
 */
export function findReplace(doc: Json, find: string, replace: string): { doc: Json; changes: Replacement[] } {
  const changes: Replacement[] = [];
  if (!find) return { doc, changes };
  const walk = (node: Json, path: (string | number)[]): Json => {
    if (typeof node === 'string') {
      if (!node.includes(find)) return node;
      const after = node.split(find).join(replace);
      changes.push({ path: pathString(path), before: node, after });
      return after;
    }
    if (Array.isArray(node)) return node.map((v, i) => walk(v, [...path, i]));
    if (isRecord(node)) {
      const out: Record<string, Json> = {};
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

export interface Change {
  readonly path: string;
  readonly kind: 'changed' | 'added' | 'removed';
  readonly before?: Json;
  readonly after?: Json;
}

/** Leaf-level differences between two documents. */
export function diff(before: Json, after: Json, path: (string | number)[] = []): Change[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    // A list of plain values reads better as one change than as n.
    if (!before.some((v) => v !== null && typeof v === 'object') && !after.some((v) => v !== null && typeof v === 'object')) {
      return [{ path: pathString(path), kind: 'changed', before, after }];
    }
    const out: Change[] = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i += 1) {
      if (i >= before.length) out.push({ path: pathString([...path, i]), kind: 'added', after: after[i] as Json });
      else if (i >= after.length) out.push({ path: pathString([...path, i]), kind: 'removed', before: before[i] as Json });
      else out.push(...diff(before[i] as Json, after[i] as Json, [...path, i]));
    }
    return out;
  }
  if (isRecord(before) && isRecord(after)) {
    const out: Change[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(key in after)) out.push({ path: pathString([...path, key]), kind: 'removed', before: before[key] as Json });
      else if (!(key in before)) out.push({ path: pathString([...path, key]), kind: 'added', after: after[key] as Json });
      else out.push(...diff(before[key] as Json, after[key] as Json, [...path, key]));
    }
    return out;
  }
  return [{ path: pathString(path), kind: 'changed', before, after }];
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** Keys whose value is a secret, in the spellings the supported file kinds use. */
export const SECRET_KEY =
  /password|passphrase|secret|^token$|_token$|Token$|api_?key|private_?key|privateKey|client_?secret|access_?key_?secret|sas_?token|connection_?string|passwd|pass_?phrase|^ansible_become_pass$|^ansible_ssh_pass$/i;

/** Placeholder the VCF installer, and the toolkit's own files, use for a value to be filled in. */
export const PLACEHOLDER = '<REQUIRED>';

export function isSecretPath(path: Path): boolean {
  const last = path[path.length - 1];
  return typeof last === 'string' && SECRET_KEY.test(last);
}

/** A value that is only a reference to a secret held somewhere else, not the secret. */
function isReference(value: string): boolean {
  return (
    value === '' ||
    value === PLACEHOLDER ||
    /^\{\{.*\}\}$/s.test(value.trim()) || // Ansible / Jinja variable
    /^\$\{.*\}$/.test(value.trim()) || // Terraform / shell interpolation
    /^\$ANSIBLE_VAULT;/.test(value) ||
    /^(arn:aws:secretsmanager|arn:aws:ssm|ocid1\.vaultsecret|projects\/[^/]+\/secrets\/|https:\/\/[^/]+\.vault\.azure\.net\/)/.test(value) ||
    /^\[parameters\(/.test(value) // ARM template parameter reference
  );
}

/** Paths of every secret held in clear text in the document. */
export function secretPaths(doc: Json): string[] {
  const out: string[] = [];
  const walk = (node: Json, path: (string | number)[]): void => {
    if (typeof node === 'string') {
      if (isSecretPath(path) && !isReference(node)) out.push(pathString(path));
      return;
    }
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i]));
    else if (isRecord(node)) for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
  };
  walk(doc, []);
  return out;
}

/**
 * The document with every clear-text secret replaced by a placeholder.
 *
 * An installer export carries the ESX root password in clear text; so does
 * many a hand-written inventory. A file that is going to be emailed,
 * committed or attached to a ticket should not.
 */
export function redactSecrets(doc: Json, placeholder: string = PLACEHOLDER): Json {
  let out = doc;
  for (const p of secretPaths(doc)) out = setAt(out, parsePath(p), placeholder);
  return out;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const ACRONYMS: Record<string, string> = {
  ip: 'IP', ipv4: 'IPv4', ipv6: 'IPv6', fqdn: 'FQDN', nsxt: 'NSX', nsx: 'NSX', vcf: 'VCF', dvs: 'DVS',
  tep: 'TEP', lcm: 'LCM', mtu: 'MTU', evc: 'EVC', cidr: 'CIDR', vm: 'VM', vlan: 'VLAN', dns: 'DNS',
  ntp: 'NTP', sso: 'SSO', vsan: 'vSAN', vmfs: 'VMFS', nfs: 'NFS', fc: 'FC', lag: 'LAG', id: 'ID',
  ssl: 'SSL', ssh: 'SSH', vip: 'VIP', lacp: 'LACP', esx: 'ESX', vmnics: 'vmnics', dtgw: 'DTGW', vpc: 'VPC',
  arn: 'ARN', iam: 'IAM', api: 'API', url: 'URL', uri: 'URI', http: 'HTTP', https: 'HTTPS', tls: 'TLS',
  vnet: 'VNet', vcn: 'VCN', ocid: 'OCID', sku: 'SKU', kms: 'KMS', acl: 'ACL', nat: 'NAT', cpu: 'CPU',
  gb: 'GB', tcp: 'TCP', udp: 'UDP', ttl: 'TTL', json: 'JSON', yaml: 'YAML', sid: 'SID', vs: 'VS',
};

/**
 * A readable label for a key: `vcfOperationsCollectorSpec` → `VCF Operations
 * collector`, `ansible_become_user` → `Ansible become user`. `special` wins
 * where a profile knows better. Keys that are identifiers in their own right
 * (`AWS::S3::Bucket`, `ansible.builtin.copy`, `Microsoft.Network/...`) are
 * shown as written.
 */
export function labelFor(key: string, special: Readonly<Record<string, string>> = {}): string {
  if (special[key]) return special[key] as string;
  if (/[.:/@$]/.test(key) || /^\d/.test(key)) return key;
  const words = key
    .replace(/Spec(s?)$/, '$1')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w, i) => {
      const known = ACRONYMS[w.toLowerCase()];
      if (known) return known;
      if (/^[A-Z0-9]+$/.test(w) && w.length > 1) return w;
      return i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w.toLowerCase();
    });
  return words.join(' ');
}
