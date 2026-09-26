/**
 * Run `terraform validate` over what every VMware, Linux and Windows blueprint generates.
 *
 * The test suite checks that each resource type exists; this checks the rest —
 * that every argument name, block, nesting and type in the generated files is
 * one the provider accepts — with the providers themselves rather than with a
 * list of what they accept. It is the check the hand-written scenario
 * blueprints most need, and it costs nothing to run it over the ~600
 * per-resource ones too.
 *
 * Each blueprint's download (versions.tf, providers.tf, main.tf, variables.tf)
 * becomes a child module of one root, so `terraform init` downloads each
 * provider once. The root passes every required variable through from a root
 * variable, which `terraform validate` treats as unknown — so the providers'
 * own value checks do not reject the placeholders a real tfvars would replace.
 *
 *   npm run terraform:validate                   # every VMware, Linux and Windows blueprint
 *   npm run terraform:validate -- --only nsx_      # ids containing "nsx_"
 *   npm run terraform:validate -- --scenarios      # only the hand-written ones
 *   npm run terraform:validate -- --platform aws   # one platform (repeatable)
 *
 * A hand-written scenario is built once with its defaults and then once more
 * for every other choice of each dropdown and yes/no — Windows as well as
 * Linux, NFS as well as VMFS — so a branch nobody's defaults take is still
 * checked. (The per-resource blueprints are one template, so their defaults
 * are enough.)
 *
 * Needs the terraform CLI and, the first time, network access to download the
 * providers (cached under the system temp directory after that).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { PLUGIN_CACHE, terraformEnv, terraformInit } from './terraform-init.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERRAFORM_BLUEPRINTS } from '../src/terraform/blueprints/index.ts';
import { defaultValues } from '../src/kit/blueprint.ts';

const argv = process.argv.slice(2);
/** --only <text>, repeatable: ids containing any of them. */
const only = argv.flatMap((a, i) => (a === '--only' && argv[i + 1] ? [argv[i + 1]] : []));
const scenariosOnly = argv.includes('--scenarios');
/** --platform <target>, repeatable: only these platforms (aws, azure, google, oci, vsphere, vcf, linux, windows). */
const platforms = argv.flatMap((a, i) => (a === '--platform' && argv[i + 1] ? [argv[i + 1]] : []));
const perResourceOnly = argv.includes('--per-resource');
/** --ids <file>: exactly these blueprint ids, one per line. */
const idsAt = argv.indexOf('--ids');
const ids = idsAt === -1 ? null : new Set(readFileSync(argv[idsAt + 1], 'utf8').split(/\r?\n/).filter(Boolean));
const keep = argv.includes('--keep');
/** --report <file>: every error as JSON, by blueprint id, for tools/discover-resource-rules.mjs. */
const reportAt = argv.indexOf('--report');
const reportFile = reportAt === -1 ? null : argv[reportAt + 1];

/** The platforms whose blueprints are built from provider schemas and hand-written scenarios. */
const PLATFORMS = ['vsphere', 'vcf', 'linux', 'windows', 'aws', 'azure', 'google', 'oci'];
/**
 * The clouds' own hand-written and registry-module blueprints are older and
 * checked by the test suite; here only their per-resource ones are.
 */
const CLOUDS = ['aws', 'azure', 'google', 'oci'];
/** Per-resource blueprint ids: one template each, so their defaults are enough. */
const PER_RESOURCE = /^(vmw|lnx|win|res)_/;

const blueprints = TERRAFORM_BLUEPRINTS.filter((g) => PLATFORMS.includes(g.target) && (platforms.length === 0 || platforms.includes(g.target)))
  .flatMap((g) => g.blueprints.filter((b) => !CLOUDS.includes(g.target) || PER_RESOURCE.test(b.id)))
  .filter((b) => !b.id.includes('estate'))
  .filter((b) => (only.length > 0 ? only.some((o) => b.id.includes(o)) : true))
  .filter((b) => (ids ? ids.has(b.id) : true))
  .filter((b) => (scenariosOnly ? !PER_RESOURCE.test(b.id) : true))
  .filter((b) => (perResourceOnly ? PER_RESOURCE.test(b.id) : true));

if (blueprints.length === 0) {
  console.error('No blueprints matched.');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'archtoolkit-terraform-validate-'));
const cache = PLUGIN_CACHE;
mkdirSync(cache, { recursive: true });

/** `variable "x" { type = T ... }` blocks with no default: name → type. */
function requiredVariables(hcl) {
  const found = new Map();
  for (const m of hcl.matchAll(/^variable\s+"([^"]+)"\s*\{([\s\S]*?)^\}/gm)) {
    const body = m[2];
    if (/^\s*default\s*=/m.test(body)) continue;
    const type = /^\s*type\s*=\s*(.+)$/m.exec(body)?.[1]?.trim() ?? 'any';
    found.set(m[1], type);
  }
  return found;
}

/** Defaults, then each other value of each closed choice, one at a time. */
function variants(blueprint) {
  const base = defaultValues(blueprint);
  const out = [{ label: blueprint.id, values: base }];
  if (PER_RESOURCE.test(blueprint.id)) return out;
  for (const input of blueprint.inputs) {
    if (input.id.startsWith('p.')) continue;
    const choices =
      input.control === 'toggle' ? [true, false] : input.control === 'select' ? (input.options ?? []).map((o) => o.value) : [];
    for (const value of choices) {
      if (String(value) === String(base[input.id])) continue;
      out.push({ label: `${blueprint.id} [${input.id}=${value}]`, values: { ...base, [input.id]: value } });
    }
  }
  return out;
}

const modules = [];
const root = [];
blueprints.flatMap((blueprint) => variants(blueprint).map((variant) => ({ blueprint, ...variant }))).forEach(({ blueprint, label, values }, i) => {
  const dir = `m${i}`;
  let files;
  try {
    files = blueprint.build(values, 'check').files;
  } catch (err) {
    modules.push({ dir, id: label, buildError: err.message });
    return;
  }
  mkdirSync(join(work, dir));
  let all = '';
  for (const [name, content] of Object.entries(files)) {
    if (!name.endsWith('.tf')) continue;
    writeFileSync(join(work, dir, name), content);
    all += `\n${content}`;
  }
  const required = requiredVariables(all);
  const args = [...required.keys()].map((v) => `  ${v} = var.${dir}__${v}`);
  root.push(`module "${dir}" {\n  source = "./${dir}"\n${args.join('\n')}\n}`);
  for (const [v, type] of required) root.push(`variable "${dir}__${v}" {\n  type = ${type}\n}`);
  modules.push({ dir, id: label });
});
writeFileSync(join(work, 'main.tf'), `${root.join('\n\n')}\n`);

const env = terraformEnv();
console.log(`Validating ${blueprints.length} blueprints (${modules.length} builds) in ${work}`);
if (!terraformInit(work, env)) {
  console.error('terraform init failed.');
  process.exit(1);
}
const run = spawnSync('terraform', ['validate', '-json', '-no-color'], { cwd: work, env, maxBuffer: 256 * 1024 * 1024 });
const result = JSON.parse(run.stdout.toString() || '{}');

const byDir = new Map(modules.map((m) => [m.dir, m]));
const problems = new Map();
const raw = new Map();
let warnings = 0;
for (const d of result.diagnostics ?? []) {
  if (d.severity !== 'error') {
    warnings++;
    continue;
  }
  const file = d.range?.filename ?? '';
  const dir = /^(m\d+)[\\/]/.exec(file)?.[1] ?? /module\.(m\d+)/.exec(d.address ?? '')?.[1] ?? 'root';
  const id = byDir.get(dir)?.id ?? dir;
  const where = d.range ? `${file.replace(/^m\d+[\\/]/, '')}:${d.range.start.line}` : '';
  const line = `${d.summary}${d.detail ? ` — ${d.detail.split('\n')[0]}` : ''}${where ? ` (${where})` : ''}`;
  if (!problems.has(id)) problems.set(id, []);
  problems.get(id).push(line);
  if (!raw.has(id)) raw.set(id, []);
  raw.get(id).push({ summary: d.summary ?? '', detail: d.detail ?? '' });
}
for (const m of modules) if (m.buildError) problems.set(m.id, [`build threw: ${m.buildError}`]);

if (reportFile) writeFileSync(reportFile, JSON.stringify(Object.fromEntries(raw), null, 1));
for (const [id, lines] of problems) {
  console.log(`\n✗ ${id}`);
  for (const l of lines.slice(0, 12)) console.log(`    ${l}`);
  if (lines.length > 12) console.log(`    … and ${lines.length - 12} more`);
}
console.log(
  `\n${modules.length - problems.size} of ${modules.length} builds (${blueprints.length} blueprints) validate` +
    (warnings ? ` (${warnings} provider warnings, not errors)` : '') + '.',
);
// Windows can still hold a provider binary open for a moment; a leftover
// temp directory is not worth failing the run over.
if (!keep) {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    console.log(`(Could not remove ${work}; delete it later.)`);
  }
}
process.exit(problems.size > 0 ? 1 : 0);
