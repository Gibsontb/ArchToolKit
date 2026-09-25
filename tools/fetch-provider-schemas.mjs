/**
 * Regenerates the provider schema data the per-resource Terraform blueprints
 * are built from — every argument of every resource:
 *
 *   src/terraform/vmware-schema-data.ts   the six VMware providers
 *   src/terraform/os-schema-data.ts       the providers the Linux and Windows
 *                                         platforms build with: Active
 *                                         Directory, DNS, TLS, cloud-init,
 *                                         Ansible, local files, random, null
 *
 * Those blueprints offer one blueprint per resource, with every argument the
 * resource takes as a field. Transcribing that by hand would be ~650 resources
 * and ~16,000 arguments, wrong within a release. So it is extracted from the
 * two places that are authoritative:
 *
 *   1. `terraform providers schema -json` — the providers' own schema: every
 *      argument, its type, whether it is required, sensitive or deprecated, and
 *      every nested block with its nesting mode and item limits. This is what
 *      `terraform validate` checks against, so it cannot be out of date with it.
 *
 *   2. The Terraform Registry documentation for the same provider versions —
 *      only for what the schema does not carry: the allowed values ("one of
 *      `IN`, `OUT` or `IN_OUT`"), which become dropdowns, and a description
 *      where the schema has none (the Avi provider ships none at all).
 *
 *   npm run schemas:update            # both sets
 *   npm run schemas:update -- vmware  # one set: vmware or os
 *
 * Needs the terraform CLI on PATH and network access to registry.terraform.io.
 * Providers are downloaded into a temporary directory and removed afterwards.
 * The output is committed so the toolkit still works air-gapped.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Each generated file: its export prefix and local name → registry source, in page order. */
const SETS = {
  vmware: {
    file: 'vmware-schema-data.ts',
    constant: 'VMWARE_SCHEMA',
    title: 'VMware Terraform provider schemas',
    providers: {
      vsphere: 'vmware/vsphere',
      vcf: 'vmware/vcf',
      nsxt: 'vmware/nsxt',
      avi: 'vmware/avi',
      vra: 'vmware/vra',
      vcd: 'vmware/vcd',
    },
  },
  os: {
    file: 'os-schema-data.ts',
    constant: 'OS_SCHEMA',
    title: 'Linux and Windows Terraform provider schemas',
    providers: {
      ad: 'hashicorp/ad',
      dns: 'hashicorp/dns',
      tls: 'hashicorp/tls',
      cloudinit: 'hashicorp/cloudinit',
      ansible: 'ansible/ansible',
      local: 'hashicorp/local',
      random: 'hashicorp/random',
      null: 'hashicorp/null',
    },
  },
  /*
   * The four clouds are ~5,200 resources and ~170,000 arguments — far too much
   * to put in front of the Terraform page before it can open. So this set is
   * written differently: a small index the picker lists (every resource, its
   * section and the file it lives in), and the schemas themselves as JSON
   * files of ~40 resources each under web/data/terraform/<provider>/, fetched
   * only when a resource is picked. Still committed, so still air-gapped.
   */
  cloud: {
    file: 'cloud-schema-index.ts',
    constant: 'CLOUD_SCHEMA',
    title: 'AWS, Azure, Google Cloud and OCI Terraform provider schemas',
    chunked: true,
    /** Nested blocks deeper than this are one HCL box rather than a form. */
    maxDepth: 5,
    providers: {
      aws: 'hashicorp/aws',
      azurerm: 'hashicorp/azurerm',
      google: 'hashicorp/google',
      oci: 'oracle/oci',
    },
  },
};

/** Where the chunked sets' schema files go; served beside web/lib. */
const DATA_DIR = join(HERE, '..', 'web', 'data', 'terraform');
/** Resources per schema file: small enough to fetch in a blink, few enough files to commit. */
const CHUNK_SIZE = 40;

/** `EC2 (Elastic Compute Cloud)` → `ec2-elastic-compute-cloud`. */
function slug(text) {
  return String(text || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
for (const name of wanted) {
  if (!SETS[name]) {
    console.error(`Unknown set "${name}"; use one of: ${Object.keys(SETS).join(', ')}`);
    process.exit(1);
  }
}

const DESCRIPTION_MAX = 220;

// --------------------------------------------------------------- registry ---

async function json(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url);
      // The registry rate-limits a few thousand documentation reads; wait as
      // long as it asks (or back off), for up to about four minutes in all.
      if (response.status === 429 && attempt < 10) {
        const asked = Number(response.headers.get('retry-after'));
        await new Promise((r) => setTimeout(r, Number.isFinite(asked) && asked > 0 ? asked * 1000 : 3000 * attempt));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      if (attempt >= 4) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function latestVersion(source) {
  const body = await json(`https://registry.terraform.io/v1/providers/${source}`);
  return body.version;
}

async function versionId(source, version) {
  const body = await json(`https://registry.terraform.io/v2/providers/${source}?include=provider-versions`);
  const match = (body.included ?? []).find((v) => v.attributes?.version === version);
  if (!match) throw new Error(`${source} ${version}: no such version in the registry`);
  return match.id;
}

/** Every resource doc of one provider version: slug to { id, subcategory }. */
async function resourceDocs(id) {
  const docs = new Map();
  for (let page = 1; ; page++) {
    const body = await json(
      `https://registry.terraform.io/v2/provider-docs?filter[provider-version]=${id}&filter[category]=resources&filter[language]=hcl&page[size]=100&page[number]=${page}`,
    );
    for (const doc of body.data ?? []) docs.set(doc.attributes.slug, { id: doc.id, subcategory: doc.attributes.subcategory || null });
    if ((body.data ?? []).length < 100) break;
  }
  return docs;
}

/**
 * A doc id names one page of one provider version, so its content never
 * changes: kept under the temp directory, a re-run reads it from disk instead
 * of spending thousands of requests of the registry's rate limit on it.
 */
const DOC_CACHE = join(tmpdir(), 'archtoolkit-registry-docs');

async function docContent(id) {
  const cached = join(DOC_CACHE, `${id}.md`);
  try {
    return readFileSync(cached, 'utf8');
  } catch {
    // Not fetched before.
  }
  const body = await json(`https://registry.terraform.io/v2/provider-docs/${id}`);
  const content = body.data?.attributes?.content ?? '';
  try {
    mkdirSync(DOC_CACHE, { recursive: true });
    writeFileSync(cached, content);
  } catch {
    // A cache that cannot be written is only slower.
  }
  return content;
}

/** Run `fn` over `items`, `width` at a time. */
async function pool(items, width, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

// ------------------------------------------------------------ doc parsing ---

/**
 * Argument name to { text, values } from a resource's markdown.
 *
 * The docs list arguments as bullets — `* \`name\` - (Optional) Text.` — with
 * long ones wrapped onto indented lines, so continuation lines are folded back
 * into their bullet first. A nested block's arguments share names with other
 * blocks' (every NSX block has a `display_name`), so the first occurrence wins:
 * the top-level argument is listed before any nested one.
 */
export function parseDoc(content) {
  const bullets = [];
  for (const line of content.split('\n')) {
    if (/^\s*[*-]\s+`[A-Za-z0-9_]+`/.test(line)) bullets.push(line.trim());
    else if (bullets.length > 0 && /^\s{2,}\S/.test(line) && !/^\s*[*-]\s/.test(line) && !/^\s*```/.test(line)) {
      bullets[bullets.length - 1] += ' ' + line.trim();
    } else if (line.trim() === '' || /^#/.test(line)) {
      // A blank line or heading ends any continuation.
      bullets.push('');
    }
  }
  const args = new Map();
  for (const bullet of bullets) {
    const m = /^[*-]\s+`([A-Za-z0-9_]+)`\s*[-:–]?\s*(.*)$/.exec(bullet);
    if (!m) continue;
    const [, name, rest] = m;
    if (args.has(name)) continue;
    const text = rest
      .replace(/^\((Required|Optional|Computed)[^)]*\)\s*/i, '')
      .replace(/^\((String|Number|Boolean|Bool|List of \w+|Set of \w+|Map of \w+|Block[^)]*)\)\s*/i, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    args.set(name, { text, values: allowedValues(rest) });
  }
  return args;
}

/**
 * The closed set a description names, or [] when it names none.
 *
 * Only phrasings that introduce a set are trusted — "one of", "valid values
 * are", "possible values", Avi's "Enum options -" — and only the tokens of that
 * sentence are taken, so a later "Default is `IN_OUT`" is not mistaken for an
 * option list. The blueprints show these as a dropdown you can still type
 * into, so a set the docs under-state never blocks a value the provider takes.
 */
export function allowedValues(text) {
  const values = new Set();
  const intro =
    /\b(?:one of|valid values(?: are| is| include)?|valid options(?: are| is)?|possible values(?: are| is)?|allowed values(?: are| is)?|supported values(?: are| is)?|accepted values(?: are| is)?|must be either|can be either|either)\b[:\s]*/gi;
  for (const m of text.matchAll(intro)) {
    const tail = text.slice(m.index + m[0].length);
    // To the end of the sentence: a full stop followed by a space and capital, or the end.
    const sentence = tail.split(/\.\s+(?=[A-Z])|\.$|\n/)[0] ?? '';
    const quoted = [...sentence.matchAll(/`([^`\s]{1,80})`|'([^'\s]{1,80})'|"([^"\s]{1,80})"/g)].map((t) => t[1] ?? t[2] ?? t[3]);
    if (quoted.length > 0) {
      for (const v of quoted) values.add(v);
      continue;
    }
    // Schema descriptions often list the set unquoted: "Can be one of bios or
    // efi." Taken only when every item is a bare token, so prose never is.
    const items = sentence
      .replace(/\.$/, '')
      .split(/\s*,\s*(?:or\s+|and\s+)?|\s+or\s+|\s+and\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (items.length >= 2 && items.every((t) => /^[A-Za-z0-9_.:/-]{1,60}$/.test(t))) {
      for (const v of items) values.add(v);
    }
  }
  const avi = /Enum options\s*-\s*([^.]*(?:\.\.\.)?)/i.exec(text);
  if (avi) {
    for (const t of avi[1].split(/,\s*/)) {
      const v = t.trim().replace(/\.+$/, '');
      if (/^[A-Z0-9_]{2,}$/.test(v)) values.add(v);
    }
  }
  // Doc prose sometimes quotes the argument's own name or a type in the same
  // sentence; neither is a value.
  for (const v of [...values]) if (/^(true|false)$/i.test(v)) values.delete(v);
  return [...values];
}

// --------------------------------------------------------- schema compact ---

/** The attribute type as the blueprints handle it. */
function typeCode(type) {
  if (type === 'string') return 's';
  if (type === 'number') return 'n';
  if (type === 'bool') return 'b';
  if (Array.isArray(type) && (type[0] === 'list' || type[0] === 'set')) {
    if (type[1] === 'string') return type[0] === 'list' ? 'ls' : 'ss';
    if (type[1] === 'number') return type[0] === 'list' ? 'ln' : 'sn';
  }
  if (Array.isArray(type) && type[0] === 'map' && (type[1] === 'string' || type[1] === 'number' || type[1] === 'bool')) return 'm';
  return 'x';
}

function shortText(text) {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= DESCRIPTION_MAX) return clean;
  const cut = clean.slice(0, DESCRIPTION_MAX);
  const stop = cut.lastIndexOf('. ');
  return (stop > 80 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '') + '…');
}

/**
 * One block, compacted:
 *   a: [[name, type, flags, description, values?], ...]
 *   b: [[name, mode, min, max, block], ...]
 * flags: r required, o optional, c optional-and-computed, s sensitive.
 * Computed-only attributes and `id` are dropped — nothing to set — and so are
 * deprecated ones, which the provider accepts only while it warns about them.
 */
function compact(block, docs, depth = 0, maxDepth = Infinity) {
  const a = [];
  for (const [name, attr] of Object.entries(block.attributes ?? {})) {
    if (name === 'id' && !attr.required) continue;
    if (!attr.required && !attr.optional) continue;
    // Deprecated arguments are left out, unless the provider still requires them.
    if (attr.deprecated && !attr.required) continue;
    const doc = docs.get(name);
    const type = attr.nested_type ? 'x' : typeCode(attr.type);
    const flags =
      (attr.required ? 'r' : attr.computed ? 'c' : 'o') + (attr.sensitive ? 's' : '');
    const text = shortText(attr.description || doc?.text || '');
    const fromSchema = attr.description ? allowedValues(attr.description) : [];
    const values = type === 's' || type === 'ls' || type === 'ss' ? (fromSchema.length ? fromSchema : doc?.values ?? []) : [];
    a.push(values.length >= 2 ? [name, type, flags, text, values] : [name, type, flags, text]);
  }
  a.sort((x, y) => (x[2][0] === 'r' ? 0 : 1) - (y[2][0] === 'r' ? 0 : 1) || x[0].localeCompare(y[0]));
  const b = [];
  for (const [name, bt] of Object.entries(block.block_types ?? {})) {
    if (bt.block?.deprecated) continue;
    const mode = bt.nesting_mode === 'single' || bt.nesting_mode === 'group' ? 1 : bt.nesting_mode === 'set' ? 's' : 'l';
    if (depth + 1 > maxDepth) {
      // Past the depth a form can usefully show — AWS WAF's rule statements
      // nest fourteen deep — the block is one box of HCL: still settable,
      // without a form of ten thousand fields. Type h: nested block(s) as HCL.
      const what = bt.block?.description ? shortText(bt.block.description) : '';
      a.push([name, 'h', (bt.min_items ?? 0) > 0 ? 'r' : 'o', `The ${name} block${bt.max_items === 1 ? '' : '(s)'}, written as HCL.${what ? ` ${what}` : ''}`]);
      continue;
    }
    b.push([name, mode, bt.min_items ?? 0, bt.max_items ?? 0, compact(bt.block, docs, depth + 1, maxDepth)]);
  }
  b.sort((x, y) => (y[2] > 0 ? 1 : 0) - (x[2] > 0 ? 1 : 0) || x[0].localeCompare(y[0]));
  const out = { a };
  if (b.length) out.b = b;
  return out;
}

// ------------------------------------------------------------------- main ---

async function generate(set) {
  const work = mkdtempSync(join(tmpdir(), 'archtoolkit-provider-schemas-'));
  try {
    console.log(`\n${set.title}`);
    const versions = {};
    for (const [local, source] of Object.entries(set.providers)) {
      versions[local] = await latestVersion(source);
      console.log(`  ${source} ${versions[local]}`);
    }

    writeFileSync(
      join(work, 'main.tf'),
      `terraform {\n  required_providers {\n${Object.entries(set.providers)
        .map(([local, source]) => `    ${local} = { source = "${source}", version = "${versions[local]}" }`)
        .join('\n')}\n  }\n}\n`,
    );
    console.log('Downloading the providers (terraform init)…');
    execFileSync('terraform', ['init', '-input=false', '-no-color', '-backend=false'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });
    console.log('Reading their schemas…');
    const schema = JSON.parse(
      execFileSync('terraform', ['providers', 'schema', '-json'], { cwd: work, maxBuffer: 512 * 1024 * 1024 }).toString(),
    ).provider_schemas;

    const out = {};
    for (const [local, source] of Object.entries(set.providers)) {
      const ps = schema[`registry.terraform.io/${source}`];
      if (!ps) throw new Error(`${source}: missing from terraform's schema output`);
      process.stdout.write(`${source}: documentation… `);
      const id = await versionId(source, versions[local]);
      const docIds = await resourceDocs(id);
      const names = Object.keys(ps.resource_schemas ?? {}).sort();
      let documented = 0;
      const resources = {};
      await pool(names, 8, async (type) => {
        const bare = type.slice(local.length + 1);
        const doc = docIds.get(bare) ?? docIds.get(type);
        let docs = new Map();
        if (doc) {
          try {
            docs = parseDoc(await docContent(doc.id));
            documented++;
          } catch (err) {
            console.warn(`\n  ${type}: documentation not read (${err.message})`);
          }
        }
        resources[type] = compact(ps.resource_schemas[type].block, docs, 0, set.maxDepth ?? Infinity);
        // The registry's own section for it, where the provider files one.
        if (doc?.subcategory) resources[type].g = doc.subcategory;
      });
      const provider = compact(ps.provider?.block ?? {}, new Map());
      out[local] = {
        source,
        version: versions[local],
        provider,
        resources: Object.fromEntries(names.map((n) => [n, resources[n]])),
      };
      console.log(`${names.length} resources, ${documented} documented`);
    }

    const today = new Date().toISOString().slice(0, 10);
    if (set.chunked) {
      // The schemas go to JSON files of CHUNK_SIZE resources, grouped by the
      // registry's section so one service's resources travel together; the
      // index keeps only what the picker needs to list them.
      for (const [local, entry] of Object.entries(out)) {
        const dir = join(DATA_DIR, local);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const bySection = new Map();
        for (const [type, schema] of Object.entries(entry.resources)) {
          const section = schema.g ?? 'Other';
          if (!bySection.has(section)) bySection.set(section, []);
          bySection.get(section).push(type);
        }
        const index = {};
        let files = 0;
        for (const [section, types] of bySection) {
          for (let i = 0; i < types.length; i += CHUNK_SIZE) {
            const part = types.slice(i, i + CHUNK_SIZE);
            const chunk = types.length > CHUNK_SIZE ? `${slug(section)}-${i / CHUNK_SIZE + 1}` : slug(section);
            const body = {};
            for (const type of part) {
              const { g, ...schema } = entry.resources[type];
              body[type] = schema;
              index[type] = [chunk, section];
            }
            writeFileSync(join(dir, `${chunk}.json`), JSON.stringify(body));
            files++;
          }
        }
        entry.resources = Object.fromEntries(Object.keys(index).sort().map((t) => [t, index[t]]));
        console.log(`  ${local}: ${files} schema files in web/data/terraform/${local}/`);
      }
    }
    const body = set.chunked
      ? `/**
 * ${set.title}: the index — GENERATED, do not edit by hand.
 *
 * Written by tools/fetch-provider-schemas.mjs from \`terraform providers schema
 * -json\` and the Terraform Registry documentation for the same versions.
 * Refresh with: npm run schemas:update -- cloud
 *
 * Per provider: its source, version and configuration block (compact form, as
 * in vmware-schema-data.ts), and for each resource [schema file, section]. The
 * resource schemas themselves are web/data/terraform/<provider>/<file>.json,
 * read by src/terraform/schema-blueprints.ts when a resource is picked.
 */

/** When this file was generated, ISO date. */
export const ${set.constant}_FETCHED_AT = ${JSON.stringify(today)};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ${set.constant}_INDEX: any = JSON.parse(${JSON.stringify(JSON.stringify(out))});
`
      : `/**
 * ${set.title} — GENERATED, do not edit by hand.
 *
 * Written by tools/fetch-provider-schemas.mjs from \`terraform providers schema
 * -json\` and the Terraform Registry documentation for the same versions.
 * Refresh with: npm run schemas:update
 *
 * Compact form, read by src/terraform/schema-blueprints.ts:
 *   a: [name, type, flags, description, allowedValues?]
 *        type  s string, n number, b bool, ls/ss list/set of string,
 *              ln/sn list/set of number, m map, x anything else (raw HCL),
 *              h a nested block past the form's depth, written as HCL
 *        flags r required, o optional, c optional (provider computes a
 *              default), then s when sensitive
 *   b: [name, mode, minItems, maxItems, block]
 *        mode  1 single, l list, s set; maxItems 0 means unlimited
 *   g: the registry documentation's section for the resource, when it has one
 */

/** When this file was generated, ISO date. */
export const ${set.constant}_FETCHED_AT = ${JSON.stringify(today)};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ${set.constant}_DATA: any = JSON.parse(${JSON.stringify(JSON.stringify(out))});
`;
    const file = join(HERE, '..', 'src', 'terraform', set.file);
    writeFileSync(file, body);
    console.log(`Wrote ${file} (${Math.round(body.length / 1024)} KB)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

for (const [name, set] of Object.entries(SETS)) {
  if (wanted.length === 0 || wanted.includes(name)) await generate(set);
}
