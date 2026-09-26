#!/usr/bin/env node
/**
 * Refresh the Kubernetes schema the data editor checks manifests against.
 *
 *   npm run editor:kubernetes            (the latest stable release)
 *   node tools/fetch-editor-kubernetes.mjs --tag v1.37.1
 *
 * Every built-in kind — Deployment, Service, ConfigMap, the ~200 of them — is
 * described field by field in the release's OpenAPI document
 * (api/openapi-spec/swagger.json). The published document carries no `enum`s,
 * though: those are in the generated Go the document is made from
 * (pkg/generated/openapi/zz_generated.openapi.go, the `+enum` types), so they
 * are read from there and put back on the fields they belong to.
 *
 * What is kept, per definition: its fields and their types, which are
 * required, the closed sets, and references to other definitions. The
 * descriptions stay with Kubernetes. The definitions are written a group at a
 * time to web/data/editor/kubernetes/<group>.json, fetched by the editor only
 * for the kinds a file uses; a definition more than one group uses (ObjectMeta,
 * PodSpec, Container, LabelSelector…) goes in core.json, which is always
 * loaded. src/editor/kubernetes-schema-index.ts maps apiVersion and kind to
 * the file, and records the release and the fetch date. Both are committed,
 * so the toolkit still works air-gapped.
 *
 * Compact node forms (see src/editor/kubernetes-schema.ts):
 *   's' string, 'i' integer, 'n' number, 'b' boolean, 'B' base64 string,
 *   'q' resource.Quantity, 'io' int-or-string, 'o' free-form object, '*' anything,
 *   '#name' a definition, {t:'o',p,r} an object with fields p and required r,
 *   {t:'m',v} a map of v, {t:'a',i} a list of i, {t,e} a scalar with a closed set.
 *
 * Needs network access to api.github.com and raw.githubusercontent.com.
 * GITHUB_TOKEN, when set, is sent to the GitHub API to lift its rate limit.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, 'web', 'data', 'editor', 'kubernetes');
const INDEX = join(ROOT, 'src', 'editor', 'kubernetes-schema-index.ts');

const REPO = 'kubernetes/kubernetes';

async function get(url, as = 'json') {
  const headers = { 'User-Agent': 'archtoolkit-fetch-editor-kubernetes' };
  if (url.startsWith('https://api.github.com/')) {
    headers.Accept = 'application/vnd.github+json';
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return as === 'json' ? r.json() : r.text();
}

async function latestTag() {
  const flag = process.argv.indexOf('--tag');
  if (flag > 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  const release = await get(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error(`latest release is ${release.tag_name}, not a stable tag`);
  return release.tag_name;
}

// --------------------------------------------------------------- enums ---

/**
 * The `Enum:` lists in the generated Go, by function and field path. The file
 * is gofmt'd, so a line ending in `{` opens a level at its indentation and a
 * `}` or `},` at the same indentation closes it.
 */
function goEnums(go) {
  const out = []; // { fn, path: string[], values }
  let fn;
  let stack = [];
  for (const line of go.split('\n')) {
    const head = /^func (schema_\w+)\(/.exec(line);
    if (head) {
      fn = head[1].replace(/^schema_/, '');
      stack = [];
    }
    if (!fn) continue;
    const indent = /^\t*/.exec(line)[0].length;
    const text = line.trim();
    if (text === '}' || text === '},') {
      while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
      if (stack.length && stack[stack.length - 1].indent === indent) stack.pop();
      continue;
    }
    const enumAt = /^Enum:\s*\[\]interface\{\}\{(.*)\},$/.exec(text);
    if (enumAt) {
      const path = [];
      for (const s of stack) {
        if (s.label.startsWith('"')) path.push(JSON.parse(s.label));
        else if (s.label === 'Items') path.push('[]');
        else if (s.label === 'AdditionalProperties') path.push('{}');
      }
      // Properties: map[string]spec.Schema{ "field": { ... } } — keys only count inside Properties.
      out.push({ fn, path, values: JSON.parse(`[${enumAt[1]}]`) });
      continue;
    }
    if (text.endsWith('{')) {
      const key = /^("(?:[^"\\]|\\.)*"):\s*\{$/.exec(text);
      const field = /^(\w+):/.exec(text);
      stack.push({ indent, label: key ? key[1] : field ? field[1] : '' });
    }
  }
  return out;
}

// ------------------------------------------------------------- compact ---

const SPECIAL = {
  'io.k8s.apimachinery.pkg.util.intstr.IntOrString': 'io',
  'io.k8s.apimachinery.pkg.api.resource.Quantity': 'q',
  'io.k8s.apimachinery.pkg.apis.meta.v1.Time': 's',
  'io.k8s.apimachinery.pkg.apis.meta.v1.MicroTime': 's',
};

function short(name) {
  return name
    .replace(/^io\.k8s\.api\./, '')
    .replace(/^io\.k8s\.apimachinery\.pkg\.apis\./, '')
    .replace(/^io\.k8s\.apimachinery\.pkg\./, '')
    .replace(/^io\.k8s\.[\w-]+\.pkg\.apis\./, '')
    .replace(/^io\.k8s\./, '');
}

function compiler(defs) {
  /** A definition referred to: a scalar or free-form one is written in place. */
  function refNode(name) {
    if (SPECIAL[name]) return SPECIAL[name];
    const def = defs[name];
    if (!def) throw new Error(`unresolved $ref ${name}`);
    if (def.properties) return `#${short(name)}`;
    if (def.additionalProperties) return `#${short(name)}`;
    if (def.type === 'object') return 'o';
    if (!def.type) return '*';
    return compile(def);
  }
  function compile(s) {
    if (s.$ref) return refNode(s.$ref.replace('#/definitions/', ''));
    if (s.allOf?.length === 1) return compile(s.allOf[0]);
    let node;
    switch (s.type) {
      case 'string':
        node = s.format === 'int-or-string' ? 'io' : s.format === 'byte' ? 'B' : 's';
        break;
      case 'integer':
        node = 'i';
        break;
      case 'number':
        node = 'n';
        break;
      case 'boolean':
        node = 'b';
        break;
      case 'array':
        node = { t: 'a', i: s.items ? compile(s.items) : '*' };
        break;
      default:
        if (s['x-kubernetes-int-or-string']) node = 'io';
        else if (s.properties) {
          const p = {};
          for (const [k, v] of Object.entries(s.properties)) p[k] = compile(v);
          node = { t: 'o', p };
          if (s.required?.length) node.r = [...s.required];
        } else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
          node = { t: 'm', v: compile(s.additionalProperties) };
        } else node = s.type === 'object' ? 'o' : '*';
    }
    if (Array.isArray(s.enum) && typeof node === 'string') node = { t: node, e: s.enum };
    return node;
  }
  return compile;
}

/** Put a closed set on the field at `path` of a compacted definition. */
function withEnum(node, path, values) {
  if (!path.length) {
    const t = typeof node === 'string' ? node : node.t;
    if (typeof node === 'string' && !node.startsWith('#')) return { t, e: values };
    if (typeof node === 'object' && !node.p && !node.v && !node.i) return { ...node, e: values };
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  const [step, ...rest] = path;
  if (step === '[]' && node.t === 'a') {
    const i = withEnum(node.i, rest, values);
    return i === undefined ? undefined : { ...node, i };
  }
  if (step === '{}' && node.t === 'm') {
    const v = withEnum(node.v, rest, values);
    return v === undefined ? undefined : { ...node, v };
  }
  if (node.t === 'o' && node.p && step in node.p) {
    const child = withEnum(node.p[step], rest, values);
    return child === undefined ? undefined : { ...node, p: { ...node.p, [step]: child } };
  }
  return undefined;
}

function refsOf(node, into = new Set()) {
  if (typeof node === 'string') {
    if (node.startsWith('#')) into.add(node.slice(1));
  } else if (node && typeof node === 'object') {
    if (node.p) for (const v of Object.values(node.p)) refsOf(v, into);
    if (node.i) refsOf(node.i, into);
    if (node.v) refsOf(node.v, into);
  }
  return into;
}

// ---------------------------------------------------------------- main ---

const tag = await latestTag();
const version = tag.replace(/^v/, '');
const raw = (path) => `https://raw.githubusercontent.com/${REPO}/${tag}/${path}`;
console.log(`Kubernetes ${tag}: fetching the OpenAPI document and the generated enum types…`);
const [swagger, go] = await Promise.all([get(raw('api/openapi-spec/swagger.json')), get(raw('pkg/generated/openapi/zz_generated.openapi.go'), 'text')]);
const defs = swagger.definitions;

// Short names must stay unique.
const byShort = new Map();
for (const name of Object.keys(defs)) {
  const s = short(name);
  if (byShort.has(s)) throw new Error(`short name ${s} is both ${byShort.get(s)} and ${name}`);
  byShort.set(s, name);
}

const compile = compiler(defs);
const compact = {};
for (const [name, def] of Object.entries(defs)) {
  if (SPECIAL[name]) continue;
  if (!def.properties && !def.additionalProperties) continue; // written in place where used
  compact[short(name)] = compile(def);
}

// Enums from the Go, matched to definitions by name.
const normal = (s) => s.replace(/[.\-/]/g, '_');
const byNormal = [...byShort.keys()].map((s) => [normal(byShort.get(s)), s]);
let enumsPlaced = 0;
const enumsMissed = [];
for (const { fn, path, values } of goEnums(go)) {
  const want = fn.replace(/^k8sio_/, 'io_k8s_');
  const hits = byNormal.filter(([n]) => n === want || n.endsWith(`_${want}`));
  if (hits.length !== 1) {
    enumsMissed.push(`${fn}.${path.join('.')}${hits.length ? ' (ambiguous)' : ''}`);
    continue;
  }
  const s = hits[0][1];
  if (!compact[s]) {
    enumsMissed.push(`${fn}.${path.join('.')} (not a kept definition)`);
    continue;
  }
  const next = withEnum(compact[s], path, values);
  if (!next) {
    enumsMissed.push(`${s}.${path.join('.')}`);
    continue;
  }
  compact[s] = next;
  enumsPlaced += 1;
}

// Every kind a manifest can name. DeleteOptions and WatchEvent claim every group; they are not manifests.
const kinds = {}; // apiVersion → kind → [chunk, definition]
const roots = []; // [chunk, definition]
for (const [name, def] of Object.entries(defs)) {
  const gvks = def['x-kubernetes-group-version-kind'];
  if (!gvks || gvks.length !== 1 || !compact[short(name)]) continue;
  const { group, version: v, kind } = gvks[0];
  const apiVersion = group ? `${group}/${v}` : v;
  const chunk = group || 'core';
  (kinds[apiVersion] ??= {})[kind] = [chunk, short(name)];
  roots.push([chunk, short(name)]);
}

// Which groups reach each definition; one group → that group's file, more → core.
const reach = new Map();
for (const [chunk, root] of roots) {
  const seen = new Set();
  const todo = [root];
  while (todo.length) {
    const d = todo.pop();
    if (seen.has(d)) continue;
    seen.add(d);
    if (!compact[d]) throw new Error(`${d} is referred to but not kept`);
    for (const r of refsOf(compact[d])) todo.push(r);
  }
  for (const d of seen) (reach.get(d) ?? reach.set(d, new Set()).get(d)).add(chunk);
}
const chunks = {};
for (const [d, groups] of reach) {
  const chunk = groups.size === 1 ? [...groups][0] : 'core';
  (chunks[chunk] ??= {})[d] = compact[d];
}
// A kind's own definition may be in core when another group uses it too; the
// editor loads core with every group, so it is found either way.

mkdirSync(DATA, { recursive: true });
for (const f of readdirSync(DATA)) if (f.endsWith('.json')) rmSync(join(DATA, f));
let bytes = 0;
const sizes = {};
for (const [chunk, body] of Object.entries(chunks).sort(([a], [b]) => a.localeCompare(b))) {
  const sorted = Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
  const text = JSON.stringify(sorted);
  writeFileSync(join(DATA, `${chunk}.json`), text);
  sizes[chunk] = text.length;
  bytes += text.length;
}

const fetched = new Date().toISOString().slice(0, 10);
const sortedKinds = Object.fromEntries(
  Object.entries(kinds)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([av, ks]) => [av, Object.fromEntries(Object.entries(ks).sort(([a], [b]) => a.localeCompare(b)))]),
);
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const kindCount =Object.values(kinds).reduce((n, k) => n + Object.keys(k).length, 0);
const index = `/**
 * Where each built-in Kubernetes kind's schema is: apiVersion → kind →
 * [file in web/data/editor/kubernetes/, definition]. core.json holds the
 * definitions more than one group uses and is always loaded with the others.
 *
 * Generated by tools/fetch-editor-kubernetes.mjs (npm run editor:kubernetes)
 * from the Kubernetes ${tag} OpenAPI document. Do not edit by hand.
 */

export interface KubernetesSchemaIndex {
  /** The release the schema is from. */
  readonly version: string;
  /** When it was fetched, YYYY-MM-DD. */
  readonly fetched: string;
  readonly source: string;
  readonly kinds: Readonly<Record<string, Readonly<Record<string, readonly [string, string]>>>>;
}

export const KUBERNETES_SCHEMA_INDEX: KubernetesSchemaIndex = {
  version: ${q(version)},
  fetched: ${q(fetched)},
  source: ${q(`https://github.com/${REPO}/blob/${tag}/api/openapi-spec/swagger.json`)},
  kinds: {
${Object.entries(sortedKinds)
  .map(([av, ks]) => `    ${q(av)}: {\n${Object.entries(ks).map(([k, [c, d]]) => `      ${k}: [${q(c)}, ${q(d)}],`).join('\n')}\n    },`)
  .join('\n')}
  },
};
`;
writeFileSync(INDEX, index);

console.log(`  ${Object.keys(kinds).length} apiVersions, ${kindCount} kinds, ${reach.size} definitions in ${Object.keys(chunks).length} files, ${(bytes / 1024).toFixed(0)} KiB`);
console.log(`  ${enumsPlaced} closed sets placed${enumsMissed.length ? `, ${enumsMissed.length} not placed:` : ''}`);
for (const m of enumsMissed) console.log(`    ${m}`);
for (const [c, n] of Object.entries(sizes).sort(([, a], [, b]) => b - a)) console.log(`    ${c}.json ${(n / 1024).toFixed(1)} KiB`);
console.log(`Wrote ${DATA} and ${INDEX}`);
