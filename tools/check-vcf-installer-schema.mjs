#!/usr/bin/env node
/**
 * Compare the Spec Builder's installer schema with Broadcom's published one.
 *
 * The VCF Installer API reference publishes SddcSpec as a page whose "JSON
 * Example" expands the whole field tree, with every enumeration written as
 * "One among: A, B, C". This reads that example and walks it next to
 * SDDC_SCHEMA in src/vcf/spec-validate.ts (which also drives the editor's
 * dropdowns), and reports:
 *
 *   - fields Broadcom publishes that the schema does not have   (new — act)
 *   - enum values Broadcom lists that the schema does not        (new — act)
 *   - fields and values the schema has that the page does not    (FYI: retired,
 *     or accepted on purpose because real deployed specs carry them)
 *
 *   npm run vcf:schema                    # the "latest" API reference
 *   npm run vcf:schema -- --version 9.1   # a specific reference
 *
 * Exits 1 when Broadcom has something the schema lacks, so update-vcf.bat
 * stops and says what to add. Needs network access to developer.broadcom.com.
 */

import { SDDC_SCHEMA } from '../src/vcf/spec-validate.ts';

const argv = process.argv.slice(2);
const at = argv.indexOf('--version');
const VERSION = at >= 0 ? argv[at + 1] : 'latest';
const URL_ = `https://developer.broadcom.com/xapis/vcf-installer-api/${VERSION}/data-structures/SddcSpec/`;

/** Fields the schema accepts on purpose though the reference omits them (see SDDC_SCHEMA's comments). */
const KNOWN_EXTRAS = new Set(['vspClusterSpec.name', 'fleetLcmSpec.hostname', 'sddcLcmSpec.hostname']);

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (vcf-schema check)' } });
    if (r.ok) return r.text();
    if ((r.status === 429 || r.status >= 500) && attempt < 6) {
      await new Promise((done) => setTimeout(done, 2000 * attempt));
      continue;
    }
    throw new Error(`${url}: HTTP ${r.status}`);
  }
}

const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Broadcom's tree: path → Set of enum values (empty set when free). */
function walkExample(value, path, out) {
  if (Array.isArray(value)) {
    const inner = `${path}[]`;
    if (!out.has(path)) out.set(path, new Set());
    for (const item of value.length ? value : [null]) walkExample(item, inner, out);
    return;
  }
  if (value && typeof value === 'object') {
    if (path && !out.has(path)) out.set(path, new Set());
    for (const [key, child] of Object.entries(value)) walkExample(child, path ? `${path}.${key}` : key, out);
    return;
  }
  const values = out.get(path) ?? new Set();
  if (typeof value === 'string' && value.startsWith('One among:')) {
    for (const v of value.slice('One among:'.length).split(',')) if (v.trim()) values.add(v.trim());
  }
  out.set(path, values);
}

/** The Spec Builder's tree, in the same form. */
function walkSchema(schema, prefix, out) {
  for (const [key, field] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const values = new Set(field.enum ?? []);
    out.set(path, field.kind === 'strings' ? new Set() : values);
    if (field.kind === 'strings') out.set(`${path}[]`, values);
    if (field.kind === 'object' && field.of) walkSchema(field.of, path, out);
    if (field.kind === 'array' && field.of) {
      out.set(`${path}[]`, new Set());
      walkSchema(field.of, `${path}[]`, out);
    }
  }
}

const html = await get(URL_);
const m = /<pre class="language-json"><code class="language-json">([\s\S]*?)<\/code><\/pre>/.exec(html);
if (!m) throw new Error(`No JSON example on ${URL_} — the page layout changed.`);
const example = JSON.parse(decode(m[1]));

const theirs = new Map();
walkExample(example, '', theirs);
const ours = new Map();
walkSchema(SDDC_SCHEMA, '', ours);

const newFields = [...theirs.keys()].filter((p) => !ours.has(p));
const newValues = [];
for (const [path, values] of theirs) {
  const mine = ours.get(path);
  if (!mine || mine.size === 0) {
    if (mine && values.size) newValues.push(`${path}: ${[...values].join(', ')} (the schema has no list here)`);
    continue;
  }
  const missing = [...values].filter((v) => !mine.has(v));
  if (missing.length) newValues.push(`${path}: ${missing.join(', ')}`);
}
const extraFields = [...ours.keys()].filter((p) => !theirs.has(p) && !KNOWN_EXTRAS.has(p));
const extraValues = [];
for (const [path, mine] of ours) {
  const values = theirs.get(path);
  if (!values || !values.size || !mine.size) continue;
  const gone = [...mine].filter((v) => !values.has(v));
  if (gone.length) extraValues.push(`${path}: ${gone.join(', ')}`);
}

console.log(`VCF Installer API reference (${VERSION}): ${theirs.size} paths; Spec Builder schema: ${ours.size} paths.`);
const list = (title, items) => {
  if (!items.length) return;
  console.log(`\n${title} (${items.length}):`);
  for (const item of items) console.log(`  ${item}`);
};
list('NEW — Broadcom publishes these fields; add them to SDDC_SCHEMA (src/vcf/spec-validate.ts), the builder and the page', newFields);
list('NEW — Broadcom lists these values; add them to the enum lists in src/vcf/spec-validate.ts', newValues);
list('FYI — in the schema but not on the reference page (retired, or accepted on purpose)', extraFields);
list('FYI — values the schema accepts that the reference no longer lists', extraValues);

if (newFields.length || newValues.length) {
  console.log('\nThe Spec Builder is behind the published installer schema.');
  process.exit(1);
}
console.log('\nThe Spec Builder covers every field and value the reference publishes.');
