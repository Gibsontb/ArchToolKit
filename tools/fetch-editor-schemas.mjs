#!/usr/bin/env node
/**
 * Refresh the F5 answer sets the data editor uses, from F5's own JSON schemas.
 *
 * An AS3 or Declarative Onboarding declaration is a tree of objects, each with
 * a `class`, and what each class may hold — which properties, which of them
 * are required, and the fixed set of answers for the ones that have one — is
 * in F5's published schema: over a hundred classes for AS3, some sixty for DO.
 * Transcribing that would be wrong within a release, so it is extracted.
 *
 *   npm run editor:update
 *
 * It writes src/editor/f5-schema-data.ts, which is committed so the toolkit
 * still works air-gapped, recording the schema version and the fetch date.
 *
 * Only what the editor uses is kept: per class, its property names, its
 * required properties, and every string enumeration reachable from it (through
 * `$ref`, `allOf`, `oneOf`, `anyOf` and DO's `if`/`then`), keyed by the path
 * pattern the editor uses (`members[].servicePort`). The descriptions and the
 * rest of the schema stay with F5.
 *
 * Needs git and network access to github.com. Nothing else.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'editor', 'f5-schema-data.ts');

const SOURCES = [
  {
    id: 'as3',
    repo: 'https://github.com/F5Networks/f5-appsvcs-extension.git',
    dir: 'schema/latest',
  },
  {
    id: 'do',
    repo: 'https://github.com/F5Networks/f5-declarative-onboarding.git',
    dir: 'src/schema/latest',
  },
];

function sparseClone(repo, dir) {
  const into = mkdtempSync(join(tmpdir(), 'atk-schema-'));
  const git = (...args) => execFileSync('git', args, { cwd: into, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
  execFileSync('git', ['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', repo, into], { stdio: 'inherit' });
  git('sparse-checkout', 'set', dir);
  const commit = git('rev-parse', '--short', 'HEAD').trim();
  return { root: join(into, dir), into, commit };
}

/** Every *.json schema in the directory, by file name. */
function loadSchemas(root) {
  const files = {};
  for (const name of readdirSync(root)) {
    if (name.endsWith('.json')) files[name] = JSON.parse(readFileSync(join(root, name), 'utf8'));
  }
  return files;
}

function resolver(files) {
  return (file, ref) => {
    const [target, pointer = ''] = ref.split('#');
    const inFile = target ? target.replace(/^.*\//, '') : file;
    let node = files[inFile];
    for (const part of pointer.split('/').filter(Boolean)) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    return node ? { file: inFile, node } : undefined;
  };
}

function isObjectNode(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function classOf(node) {
  const c = node?.properties?.class;
  if (!c) return undefined;
  if (typeof c.const === 'string') return c.const;
  if (Array.isArray(c.enum) && c.enum.length === 1) return c.enum[0];
  return undefined;
}

/**
 * The properties, required names and enumerations a schema node describes,
 * following references and combinators. `seen` stops reference cycles.
 */
function describe(file, node, resolve, prefix, out, seen, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (node.$ref) {
    const key = `${file}|${node.$ref}|${prefix}`;
    if (seen.has(key)) return;
    seen.add(key);
    const r = resolve(file, node.$ref);
    if (r) describe(r.file, r.node, resolve, prefix, out, seen, depth + 1);
  }
  // A string that may be anything matching a pattern (AS3's schemaVersion
  // takes any 3.x) has no fixed answer set, whatever enum sits beside it.
  const combinator = node.$ref || node.anyOf || node.oneOf || node.allOf;
  if (prefix && (node.pattern || node.format || (node.type === 'string' && !node.enum && node.const === undefined && !combinator))) {
    out.open.add(prefix);
  }
  const strings = [];
  if (Array.isArray(node.enum)) strings.push(...node.enum.filter((v) => typeof v === 'string'));
  if (typeof node.const === 'string' && prefix) strings.push(node.const);
  if (strings.length && prefix) out.enums[prefix] = [...new Set([...(out.enums[prefix] ?? []), ...strings])];
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    for (const branch of node[key] ?? []) {
      // A branch that names a different class is a different object, not a
      // variant of this one.
      if (classOf(branch) && prefix) continue;
      describe(file, branch, resolve, prefix, out, seen, depth + 1);
    }
  }
  // DO and AS3 choose a variant with if/then on a property's value; the
  // values tested are that property's answer set (AS3's Application
  // template, for one).
  if (isObjectNode(node.if) && isObjectNode(node.if.properties)) {
    for (const [name, cond] of Object.entries(node.if.properties)) {
      if (name === 'class' || !isObjectNode(cond)) continue;
      const values = [...(typeof cond.const === 'string' ? [cond.const] : []), ...(Array.isArray(cond.enum) ? cond.enum.filter((v) => typeof v === 'string') : [])];
      const path = prefix ? `${prefix}.${name}` : name;
      if (values.length) out.enums[path] = [...new Set([...(out.enums[path] ?? []), ...values])];
    }
  }
  if (node.then) describe(file, node.then, resolve, prefix, out, seen, depth + 1);
  if (node.items) describe(file, node.items, resolve, `${prefix}[]`, out, seen, depth + 1);
  if (node.properties) {
    for (const [name, child] of Object.entries(node.properties)) {
      if (name === 'class' && !prefix) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      if (!prefix) out.props.add(name);
      // A nested object with its own class is described under that class.
      if (classOf(child)) continue;
      describe(file, child, resolve, path, out, seen, depth + 1);
    }
  }
  if (!prefix && Array.isArray(node.required)) for (const r of node.required) if (r !== 'class') out.required.add(r);
}

function extract(files) {
  const resolve = resolver(files);
  const classes = {};
  const visit = (file, node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(file, n));
      return;
    }
    const name = classOf(node);
    if (name) {
      const entry = (classes[name] ??= { props: new Set(), required: new Set(), enums: {}, open: new Set() });
      describe(file, node, resolve, '', entry, new Set(), 0);
    }
    for (const v of Object.values(node)) visit(file, v);
  };
  for (const [file, schema] of Object.entries(files)) visit(file, schema);
  const out = {};
  for (const name of Object.keys(classes).sort()) {
    const c = classes[name];
    const enums = Object.fromEntries(
      Object.entries(c.enums)
        .filter(([k, v]) => v.length > 0 && !c.open.has(k))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    out[name] = { p: [...c.props].sort(), r: [...c.required].sort(), e: enums };
  }
  return out;
}

/** The newest schemaVersion the root class accepts (they are listed newest first). */
function schemaVersion(classes) {
  for (const c of Object.values(classes)) if (c.e.schemaVersion?.length) return c.e.schemaVersion[0];
  return 'unknown';
}

const result = {};
for (const source of SOURCES) {
  process.stdout.write(`${source.id}: cloning ${source.repo} … `);
  const { root, into, commit } = sparseClone(source.repo, source.dir);
  try {
    const files = loadSchemas(root);
    const classes = extract(files);
    result[source.id] = {
      source: `${source.repo.replace(/\.git$/, '')}/tree/${commit}/${source.dir}`,
      version: schemaVersion(classes),
      classes,
    };
    console.log(`${Object.keys(classes).length} classes, schema ${result[source.id].version}`);
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
}

const body = `/**
 * Generated by tools/fetch-editor-schemas.mjs — do not edit by hand.
 * Run \`npm run editor:update\` to refresh.
 *
 * Per class: p = property names, r = required properties, e = answer sets by
 * path pattern (\`members[].servicePort\`), taken from F5's published schemas.
 */

export interface F5Class {
  readonly p: readonly string[];
  readonly r: readonly string[];
  readonly e: Readonly<Record<string, readonly string[]>>;
}

export interface F5Schema {
  readonly source: string;
  readonly version: string;
  readonly classes: Readonly<Record<string, F5Class>>;
}

export const F5_SCHEMAS_FETCHED_AT = '${new Date().toISOString().slice(0, 10)}';

export const F5_SCHEMAS: Readonly<Record<'as3' | 'do', F5Schema>> = ${JSON.stringify(result)};
`;
writeFileSync(OUT, body);
console.log(`Wrote ${OUT} (${Math.round(body.length / 1024)} KB)`);
