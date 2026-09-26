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
 * The migration blueprints ("From a migration plan", ids with `_mig_`) are
 * validated differently: each build is its own root module, because the
 * compute blueprints adopt replicated VMs with `import` blocks, which Terraform
 * accepts only in a root module. One directory is initialised once with every
 * provider they use and each build is validated in it in turn. Their
 * `landing_zone_source = stack` variants read a local only a stack declares,
 * so instead of those, a sample stack per cloud (landing zone, identity,
 * connectivity, compute, databases, Oracle Database@, backup, monitoring,
 * relocate) is built with buildStack and validated as a root too.
 *
 *   npm run terraform:validate -- --only _mig_     # the migration blueprints and sample stacks
 *
 * Needs the terraform CLI and, the first time, network access to download the
 * providers (cached under the system temp directory after that).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { PLUGIN_CACHE, terraformEnv, terraformInit } from './terraform-init.mjs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERRAFORM_BLUEPRINTS, findTerraformBlueprint } from '../src/terraform/blueprints/index.ts';
import { defaultValues } from '../src/kit/blueprint.ts';
import { buildStack } from '../src/terraform/stack.ts';

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
/** Migration-plan blueprint ids: validated as root modules, and in sample stacks. */
const MIGRATION = /_mig_/;

const blueprints = TERRAFORM_BLUEPRINTS.filter((g) => PLATFORMS.includes(g.target) && (platforms.length === 0 || platforms.includes(g.target)))
  .flatMap((g) => g.blueprints.filter((b) => !CLOUDS.includes(g.target) || PER_RESOURCE.test(b.id) || MIGRATION.test(b.id)))
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
    // A migration blueprint's region list, retention days, subnet size and SIEM
    // change values, not structure; its stack variant is checked in the sample stacks.
    if (MIGRATION.test(blueprint.id) && /(^|_)(region|zone)$|^landing_zone_source$|retention_days$|^subnet_prefix$|^siem$|^node_count$/.test(input.id)) continue;
    const choices =
      input.control === 'toggle' ? [true, false] : input.control === 'select' ? (input.options ?? []).map((o) => o.value) : [];
    for (const value of choices) {
      if (String(value) === String(base[input.id])) continue;
      out.push({ label: `${blueprint.id} [${input.id}=${value}]`, values: { ...base, [input.id]: value } });
    }
  }
  return out;
}

const modular = blueprints.filter((b) => !MIGRATION.test(b.id));
const migration = blueprints.filter((b) => MIGRATION.test(b.id));
const env = terraformEnv();
const problems = new Map();
const raw = new Map();
let warnings = 0;
let builds = 0;

/** Record one diagnostic against the build it came from. */
function record(id, d, file) {
  const where = d.range ? `${file}:${d.range.start.line}` : '';
  const line = `${d.summary}${d.detail ? ` — ${d.detail.split('\n')[0]}` : ''}${where ? ` (${where})` : ''}`;
  if (!problems.has(id)) problems.set(id, []);
  problems.get(id).push(line);
  if (!raw.has(id)) raw.set(id, []);
  raw.get(id).push({ summary: d.summary ?? '', detail: d.detail ?? '' });
}

if (modular.length > 0) validateAsModules(modular);
if (migration.length > 0) validateAsRoots(migration);

/** Every build a child module of one root: one init, one validate. */
function validateAsModules(list) {
  const modules = [];
  const root = [];
  list.flatMap((blueprint) => variants(blueprint).map((variant) => ({ blueprint, ...variant }))).forEach(({ blueprint, label, values }, i) => {
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

  console.log(`Validating ${list.length} blueprints (${modules.length} builds) in ${work}`);
  if (!terraformInit(work, env)) {
    console.error('terraform init failed.');
    process.exit(1);
  }
  const run = spawnSync('terraform', ['validate', '-json', '-no-color'], { cwd: work, env, maxBuffer: 256 * 1024 * 1024 });
  const result = JSON.parse(run.stdout.toString() || '{}');

  const byDir = new Map(modules.map((m) => [m.dir, m]));
  builds += modules.length;
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
}

/** The sample stack for a platform: every migration blueprint of it, reading local.landing_zone. */
function sampleStack(target, list) {
  const order = ['landing_zone', 'identity', 'connectivity', 'compute', 'vms', 'databases', 'oracle_database', 'backup', 'monitoring', 'avs', 'gcve', 'ocvs'];
  const ids = list.filter((b) => b.id.startsWith(`${target === 'google' ? 'google' : target}_mig_`)).map((b) => b.id);
  const rank = (id) => order.findIndex((o) => id.endsWith(`_mig_${o}`));
  const items = ids
    .sort((a, b) => rank(a) - rank(b))
    .map((id) => ({ id, blueprintId: id, label: id.replace(/^[a-z]+_mig_/, '').replace(/_/g, '-'), values: { landing_zone_source: 'stack' } }));
  return items.length > 0 ? buildStack(items, findTerraformBlueprint, { target, stackName: `${target}-sample`, requiredVersion: '>= 1.7.0' }) : null;
}

/**
 * Each build its own root module, validated in turn in one directory that is
 * initialised once with every provider they use.
 */
function validateAsRoots(list) {
  const dir = join(work, 'roots');
  mkdirSync(dir, { recursive: true });
  const roots = [];
  for (const blueprint of list) {
    for (const { label, values } of variants(blueprint)) {
      try {
        roots.push({ id: label, files: blueprint.build(values, 'check').files });
      } catch (err) {
        problems.set(label, [`build threw: ${err.message}`]);
      }
    }
  }
  const targets = [...new Set(TERRAFORM_BLUEPRINTS.filter((g) => g.blueprints.some((b) => list.includes(b))).map((g) => g.target))];
  for (const target of targets) {
    const stack = sampleStack(target, list);
    if (!stack) continue;
    const warned = stack.findings.filter((f) => f.code.startsWith('tf.stack.') && f.severity !== 'info');
    if (warned.length > 0) problems.set(`${target} sample stack`, warned.map((f) => `${f.code}: ${f.message}`));
    roots.push({ id: `${target} sample stack`, files: stack.files });
  }
  // One init for all of them: every provider any of them names.
  const providers = new Map();
  for (const r of roots) {
    for (const text of Object.values(r.files)) {
      for (const m of String(text).matchAll(/^\s{4}([a-z0-9_-]+)\s*=\s*\{\s*\n\s*source\s*=\s*"([^"]+)"\s*\n\s*version\s*=\s*"([^"]+)"/gm)) providers.set(m[1], { source: m[2], version: m[3] });
    }
  }
  writeFileSync(join(dir, 'init.tf'), `terraform {\n  required_providers {\n${[...providers].map(([n, p]) => `    ${n} = {\n      source  = "${p.source}"\n      version = "${p.version}"\n    }`).join('\n')}\n  }\n}\n`);
  console.log(`Validating ${list.length} migration blueprints (${roots.length} root modules, sample stacks included) in ${dir}`);
  if (!terraformInit(dir, env)) {
    console.error('terraform init failed.');
    process.exit(1);
  }
  rmSync(join(dir, 'init.tf'));
  builds += roots.length;
  for (const r of roots) {
    for (const f of readdirSync(dir)) if (f.endsWith('.tf')) rmSync(join(dir, f));
    for (const [name, content] of Object.entries(r.files)) if (name.endsWith('.tf')) writeFileSync(join(dir, name), content);
    const run = spawnSync('terraform', ['validate', '-json', '-no-color'], { cwd: dir, env, maxBuffer: 256 * 1024 * 1024 });
    let result = {};
    try {
      result = JSON.parse(run.stdout.toString() || '{}');
    } catch {
      problems.set(r.id, [`terraform validate gave no JSON: ${run.stderr.toString().split('\n')[0]}`]);
      continue;
    }
    for (const d of result.diagnostics ?? []) {
      if (d.severity !== 'error') {
        warnings++;
        continue;
      }
      record(r.id, d, d.range?.filename ?? '');
    }
    process.stdout.write(problems.has(r.id) ? 'x' : '.');
  }
  process.stdout.write('\n');
}

if (reportFile) writeFileSync(reportFile, JSON.stringify(Object.fromEntries(raw), null, 1));
for (const [id, lines] of problems) {
  console.log(`\n✗ ${id}`);
  for (const l of lines.slice(0, 12)) console.log(`    ${l}`);
  if (lines.length > 12) console.log(`    … and ${lines.length - 12} more`);
}
console.log(
  `\n${builds - problems.size} of ${builds} builds (${blueprints.length} blueprints) validate` +
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
