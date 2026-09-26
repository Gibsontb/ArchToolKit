#!/usr/bin/env node
/**
 * Refresh the CloudFormation resource schemas the data editor checks
 * templates against.
 *
 *   npm run editor:cloudformation
 *
 * Source: the CloudFormation registry's published resource provider schemas,
 * one JSON Schema per resource type, in
 *   https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip
 * They carry each property's type, the required ones, enumerations and the
 * read-only and create-only lists. If the zip cannot be read, the older
 * resource specification is used instead (types and required, no enums):
 *   https://d1uauaxba7bl26.cloudfront.net/latest/gzip/CloudFormationResourceSpecification.json
 *
 * Unzipping: Node has no unzip, and `tar` on this machine may be GNU tar
 * (Git Bash), which cannot read a zip. So the zip is read here, with
 * `zlib.inflateRawSync` — a ~40-line reader of the central directory that
 * works the same on Windows, macOS and Linux. Nothing is extracted to disk.
 *
 * Writes (committed, so the toolkit works air-gapped):
 *   web/data/editor/cloudformation/<service>.json  — one file per service
 *     (AWS::EC2::* → ec2.json, Alexa::ASK::* → alexa-ask.json)
 *   src/editor/cloudformation-schema-index.ts     — type → file, fetch date, source
 *
 * Compact form, per type:
 *   { p: {Name: spec}, r: [required], d: {Def: {p, r, o?}}, ro: [...], co: [...], o?: 1 }
 * A spec is a type code, or [code, enum] when the value has a closed set:
 *   s string, n number, i integer, b boolean, j anything (JSON, a map, a
 *   union of types), o:Def an object shaped by definition Def, a:<spec> a list.
 * `o: 1` on a definition means it does not declare additionalProperties false,
 * so a property it does not list is a warning rather than an error.
 * Read-only and create-only are the top-level properties only.
 * Descriptions stay with AWS.
 */

import { gunzipSync, inflateRawSync } from 'node:zlib';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'web', 'data', 'editor', 'cloudformation');
const INDEX = join(ROOT, 'src', 'editor', 'cloudformation-schema-index.ts');

const ZIP_URL = 'https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip';
const SPEC_URL = 'https://d1uauaxba7bl26.cloudfront.net/latest/gzip/CloudFormationResourceSpecification.json';

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ------------------------------------------------------------------ zip ---

/** Every file in a zip, name → contents. Stored and deflated entries only. */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, inflateRawSync(raw));
    else throw new Error(`${name}: compression method ${method} not supported`);
  }
  return files;
}

// ------------------------------------------------- registry JSON Schemas ---

function compileRegistry(schema) {
  const defsIn = schema.definitions ?? {};
  const defsOut = {};
  const queue = [];

  const resolve = (node) => {
    if (node && typeof node.$ref === 'string') {
      const m = /^#\/definitions\/(.+)$/.exec(node.$ref);
      if (m) return { name: m[1], node: defsIn[m[1]] };
    }
    return undefined;
  };

  /** The properties a node declares, through allOf/oneOf/anyOf and $ref. */
  const collect = (node, props, required, seen, top) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const ref = resolve(node);
    if (ref) return collect(ref.node, props, required, seen, top);
    for (const [k, v] of Object.entries(node.properties ?? {})) if (!(k in props)) props[k] = v;
    if (top && Array.isArray(node.required)) required.push(...node.required);
    for (const v of node.allOf ?? []) collect(v, props, required, seen, top);
    for (const v of [...(node.oneOf ?? []), ...(node.anyOf ?? [])]) collect(v, props, required, seen, false);
  };

  const objectLike = (node, seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    const ref = resolve(node);
    if (ref) return objectLike(ref.node, seen);
    if (node.properties && Object.keys(node.properties).length > 0) return true;
    return [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? [])].some((v) => objectLike(v, seen));
  };

  const isOpen = (node) => node.additionalProperties !== false || node.patternProperties !== undefined;

  const compileDef = (name, node) => {
    if (name in defsOut) return;
    defsOut[name] = null; // placeholder against cycles
    const props = {};
    const required = [];
    collect(node, props, required, new Set(), true);
    const p = {};
    for (const [k, v] of Object.entries(props)) p[k] = spec(v, `${name}.${k}`);
    const out = { p };
    const req = [...new Set(required)].filter((r) => r in p);
    if (req.length) out.r = req;
    if (isOpen(node)) out.o = 1;
    defsOut[name] = out;
  };

  /** A property's spec: its type code, with its enum when it has one. */
  function spec(node, hint, seen = new Set()) {
    if (!node || typeof node !== 'object') return 'j';
    const ref = resolve(node);
    if (ref) {
      if (!ref.node) return 'j';
      if (objectLike(ref.node)) {
        queue.push([ref.name, ref.node]);
        return `o:${ref.name}`;
      }
      if (seen.has(ref.name)) return 'j';
      seen.add(ref.name);
      return spec(ref.node, ref.name, seen);
    }
    let type = node.type;
    if (Array.isArray(type)) type = type.length === 1 ? type[0] : undefined;
    const withEnum = (code) => (Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((e) => typeof e === 'string' || typeof e === 'number') ? [code, node.enum.map(String)] : code);
    if (type === 'string') return withEnum('s');
    if (type === 'number') return withEnum('n');
    if (type === 'integer') return withEnum('i');
    if (type === 'boolean') return 'b';
    if (type === 'array') {
      const item = spec(node.items, hint, seen);
      return Array.isArray(item) ? [`a:${item[0]}`, item[1]] : `a:${item}`;
    }
    if ((type === 'object' || type === undefined) && objectLike(node)) {
      const name = hint.replace(/[^A-Za-z0-9_.]/g, '');
      queue.push([name, node]);
      return `o:${name}`;
    }
    if (type === undefined && Array.isArray(node.enum)) return withEnum('s');
    if (type === undefined) {
      // A union of alternatives with the same primitive type is that type.
      const alts = [...(node.oneOf ?? []), ...(node.anyOf ?? [])].map((a) => spec(a, hint, seen));
      if (alts.length && alts.every((a) => typeof a === 'string' && a === alts[0]) && /^[snib]$/.test(alts[0])) return alts[0];
    }
    return 'j';
  }

  const props = {};
  const required = [];
  collect(schema, props, required, new Set(), true);
  const p = {};
  for (const [k, v] of Object.entries(props)) p[k] = spec(v, `.${k}`);
  while (queue.length) {
    const [name, node] = queue.shift();
    compileDef(name, node);
  }
  const top = (list) => [...new Set((list ?? []).map((x) => /^\/properties\/([^/]+)$/.exec(x)?.[1]).filter((x) => x && x in p))];
  const ro = top(schema.readOnlyProperties);
  const out = { p };
  const req = [...new Set(required)].filter((r) => r in p && !ro.includes(r));
  if (req.length) out.r = req;
  const d = Object.fromEntries(Object.entries(defsOut).filter(([, v]) => v));
  if (Object.keys(d).length) out.d = d;
  if (ro.length) out.ro = ro;
  const co = top(schema.createOnlyProperties);
  if (co.length) out.co = co;
  if (isOpen(schema)) out.o = 1;
  return out;
}

// ------------------------------------------- the old resource specification ---

function compileSpec(spec) {
  const out = {};
  const primitive = { String: 's', Long: 'i', Integer: 'i', Double: 'n', Boolean: 'b', Json: 'j', Timestamp: 's' };
  const code = (p) => {
    if (p.PrimitiveType) return primitive[p.PrimitiveType] ?? 'j';
    if (p.Type === 'List') return `a:${p.PrimitiveItemType ? primitive[p.PrimitiveItemType] ?? 'j' : p.ItemType && p.ItemType !== 'Json' ? `o:${p.ItemType}` : 'j'}`;
    if (p.Type === 'Map') return 'j';
    if (p.Type) return `o:${p.Type}`;
    return 'j';
  };
  const block = (props) => {
    const p = {};
    const r = [];
    for (const [k, v] of Object.entries(props ?? {})) {
      p[k] = code(v);
      if (v.Required) r.push(k);
    }
    return r.length ? { p, r } : { p };
  };
  for (const [type, res] of Object.entries(spec.ResourceTypes ?? {})) {
    const entry = block(res.Properties);
    const d = {};
    for (const [full, pt] of Object.entries(spec.PropertyTypes ?? {})) {
      const dot = full.indexOf('.');
      if (full.slice(0, dot) === type) d[full.slice(dot + 1)] = block(pt.Properties);
    }
    if (Object.keys(d).length) entry.d = d;
    const co = Object.entries(res.Properties ?? {}).filter(([, v]) => v.UpdateType === 'Immutable').map(([k]) => k);
    if (co.length) entry.co = co;
    out[type] = entry;
  }
  return out;
}

// -------------------------------------------------------------------- run ---

function fileOf(type) {
  const [vendor, service] = type.split('::');
  return (vendor === 'AWS' ? service : `${vendor}-${service}`).toLowerCase();
}

async function main() {
  let types = {};
  let source;
  try {
    const files = unzip(await download(ZIP_URL));
    for (const [name, data] of files) {
      if (!name.endsWith('.json')) continue;
      const schema = JSON.parse(data.toString('utf8'));
      if (typeof schema.typeName !== 'string') continue;
      types[schema.typeName] = compileRegistry(schema);
    }
    if (Object.keys(types).length < 100) throw new Error(`only ${Object.keys(types).length} schemas in the zip`);
    source = `CloudFormation registry resource schemas (${ZIP_URL})`;
  } catch (err) {
    console.warn(`Registry schemas not usable (${err.message}); falling back to the resource specification.`);
    let buf = await download(SPEC_URL);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
    types = compileSpec(JSON.parse(buf.toString('utf8')));
    source = `CloudFormation resource specification (${SPEC_URL})`;
  }

  const byFile = new Map();
  for (const type of Object.keys(types).sort()) {
    const f = fileOf(type);
    if (!byFile.has(f)) byFile.set(f, {});
    byFile.get(f)[type] = types[type];
  }
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  let bytes = 0;
  for (const [f, content] of byFile) {
    const text = JSON.stringify(content);
    bytes += text.length;
    writeFileSync(join(OUT_DIR, `${f}.json`), text);
  }

  const fetched = new Date().toISOString().slice(0, 10);
  const index = Object.fromEntries(Object.keys(types).sort().map((t) => [t, fileOf(t)]));
  const lines = [
    '/**',
    ' * Generated by tools/fetch-editor-cloudformation.mjs — do not edit by hand.',
    ' * Every CloudFormation resource type, and the file in',
    ' * web/data/editor/cloudformation/ its schema is in.',
    ' */',
    '',
    'export interface CfnSchemaIndex {',
    '  readonly source: string;',
    '  readonly fetched: string;',
    '  /** Resource type → schema file (without .json). */',
    '  readonly types: Readonly<Record<string, string>>;',
    '}',
    '',
    'export const CFN_SCHEMA_INDEX: CfnSchemaIndex = {',
    `  source: ${JSON.stringify(source)},`,
    `  fetched: ${JSON.stringify(fetched)},`,
    '  types: {',
    ...Object.entries(index).map(([t, f]) => `    ${JSON.stringify(t)}: ${JSON.stringify(f)},`),
    '  },',
    '};',
    '',
  ];
  writeFileSync(INDEX, lines.join('\n'));
  const largest = [...byFile.entries()].map(([f, c]) => [f, JSON.stringify(c).length]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`${Object.keys(types).length} types in ${byFile.size} files, ${(bytes / 1024 / 1024).toFixed(1)} MB; largest ${largest.map(([f, n]) => `${f} ${(n / 1024).toFixed(0)} KB`).join(', ')}`);
  console.log(`Wrote ${OUT_DIR} and ${INDEX}; ${readdirSync(OUT_DIR).length} files.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
