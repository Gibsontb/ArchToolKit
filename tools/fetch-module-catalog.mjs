#!/usr/bin/env node
/**
 * Regenerates src/terraform/module-catalog-data.ts — the registry modules.
 *
 * The kit's blueprints emit resources. Most real Terraform does not: it calls a
 * module, because `terraform-aws-modules/vpc/aws` has been pulled 214 million
 * times and nobody who writes a VPC by hand gets the route tables right the
 * first time. For the kit to generate a module block it has to know the
 * module's inputs, and to keep knowing them it has to check rather than
 * remember — a module renames an input between majors exactly like a provider
 * renames a resource.
 *
 * The inputs are read from each module's own `variables.tf`, at the tag of the
 * version the kit pins, cloned from the source repository. That is the same
 * file Terraform reads, so there is nothing to be out of date with. The
 * registry API would answer too, but it answers with prose around the data and
 * it cannot be reached from an air-gapped machine any more than this can — the
 * difference is that a git clone is the thing every CI box already does.
 *
 *     node tools/fetch-module-catalog.mjs            # all of them
 *     node tools/fetch-module-catalog.mjs --only vpc # one, for a quick check
 *
 * Names only, comma-joined, which is what the provider catalog does and for the
 * same reason: what the kit needs is to answer "does this module take an input
 * called this", and storing the descriptions as well would quadruple the file
 * to answer a question nobody asked.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/terraform/module-catalog-data.ts');

/**
 * The modules worth having, by downloads and by whether the kit would ever
 * generate one. Versions are the latest at the date in the header; refreshing
 * is bumping these and re-running.
 */
const MODULES = [
  // --- AWS: terraform-aws-modules -----------------------------------------
  ['aws', 'terraform-aws-modules', 'vpc', '6.7.3'],
  ['aws', 'terraform-aws-modules', 'ec2-instance', '6.4.1'],
  ['aws', 'terraform-aws-modules', 'security-group', '6.0.0'],
  ['aws', 'terraform-aws-modules', 's3-bucket', '5.16.1'],
  ['aws', 'terraform-aws-modules', 'rds', '7.2.2'],
  ['aws', 'terraform-aws-modules', 'rds-aurora', '10.4.1'],
  ['aws', 'terraform-aws-modules', 'eks', '21.25.1'],
  ['aws', 'terraform-aws-modules', 'alb', '10.5.1'],
  ['aws', 'terraform-aws-modules', 'lambda', '8.8.2'],
  ['aws', 'terraform-aws-modules', 'kms', '4.2.2'],
  ['aws', 'terraform-aws-modules', 'dynamodb-table', '5.5.2'],
  ['aws', 'terraform-aws-modules', 'autoscaling', '9.3.2'],
  ['aws', 'terraform-aws-modules', 'ecs', '7.6.1'],
  ['aws', 'terraform-aws-modules', 'acm', '6.3.1'],

  // --- Azure: the verified modules, plus the two everyone starts from ------
  ['azure', 'Azure', 'naming', '0.4.4'],
  ['azure', 'Azure', 'avm-res-resources-resourcegroup', '0.4.0'],
  ['azure', 'Azure', 'avm-res-network-virtualnetwork', '0.22.2'],
  ['azure', 'Azure', 'avm-res-network-networksecuritygroup', '0.5.1'],
  ['azure', 'Azure', 'avm-res-compute-virtualmachine', '0.21.0'],
  ['azure', 'Azure', 'avm-res-storage-storageaccount', '0.10.0'],
  ['azure', 'Azure', 'avm-res-keyvault-vault', '0.11.0'],
  ['azure', 'Azure', 'avm-res-containerservice-managedcluster', '0.8.3'],
  ['azure', 'Azure', 'avm-res-web-site', '0.23.0'],
  ['azure', 'Azure', 'aks', '11.7.0'],

  // --- GCP: terraform-google-modules --------------------------------------
  ['google', 'terraform-google-modules', 'network', '18.3.0'],
  ['google', 'terraform-google-modules', 'kubernetes-engine', '45.0.0'],
  ['google', 'terraform-google-modules', 'project-factory', '18.3.0'],
  ['google', 'terraform-google-modules', 'cloud-storage', '12.3.0'],
  ['google', 'terraform-google-modules', 'service-accounts', '5.0.0'],
  ['google', 'terraform-google-modules', 'sql-db', '28.3.0', 'modules/postgresql'],
  ['google', 'terraform-google-modules', 'sql-db', '28.3.0', 'modules/mysql'],
  ['google', 'terraform-google-modules', 'cloud-nat', '7.0.0'],
  ['google', 'terraform-google-modules', 'cloud-router', '9.1.0'],
  ['google', 'terraform-google-modules', 'cloud-dns', '7.2.0'],
  ['google', 'terraform-google-modules', 'kms', '4.1.2'],
  ['google', 'terraform-google-modules', 'log-export', '11.1.0'],
  ['google', 'terraform-google-modules', 'bigquery', '10.2.1'],

  // --- OCI: oracle-terraform-modules --------------------------------------
  ['oci', 'oracle-terraform-modules', 'vcn', '4.0.0'],
  ['oci', 'oracle-terraform-modules', 'oke', '5.5.1'],
  ['oci', 'oracle-terraform-modules', 'compute-instance', '2.4.1'],
  ['oci', 'oracle-terraform-modules', 'bastion', '3.2.0'],
  ['oci', 'oracle-terraform-modules', 'drg', '1.0.6'],
  ['oci', 'oracle-terraform-modules', 'operator', '3.1.5'],
];

/** registry provider id -> the word in the repository name. */
const REPO_PROVIDER = { aws: 'aws', azure: 'azurerm', google: 'google', oci: 'oci' };
/** registry provider id -> the provider the source string names. */
const SOURCE_PROVIDER = { aws: 'aws', azure: 'azurerm', google: 'google', oci: 'oci' };

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The repository at exactly the tag of the pinned version.
 *
 * Tags are `v1.2.3` almost everywhere and bare `1.2.3` in a few repositories,
 * so both are tried before giving up — guessing wrong and silently taking the
 * default branch would put next release's inputs in this release's catalog.
 */
function cloneAtVersion(namespace, name, provider, version) {
  const repo = `https://github.com/${namespace}/terraform-${REPO_PROVIDER[provider]}-${name}.git`;
  const dir = mkdtempSync(join(tmpdir(), 'tfmod-'));
  for (const tag of [`v${version}`, version]) {
    try {
      git(['clone', '--depth', '1', '--branch', tag, '--single-branch', repo, dir]);
      return { dir, tag };
    } catch {
      /* try the other spelling */
    }
  }
  rmSync(dir, { recursive: true, force: true });
  throw new Error(`No tag v${version} or ${version} in ${repo}`);
}

/**
 * The `variable` blocks in a file.
 *
 * Brace counting rather than a parser: these files are machine-formatted HCL
 * and the only thing needed out of them is which names exist and which have no
 * default. Strings are tracked so a `}` inside a description or a default does
 * not close the block early.
 */
function parseVariables(hcl) {
  const found = [];
  const re = /^variable\s+"([^"]+)"\s*\{/gm;
  let match;
  while ((match = re.exec(hcl)) !== null) {
    const name = match[1];
    let depth = 1;
    let i = re.lastIndex;
    let inString = false;
    let inHeredoc = false;
    let heredocTag = '';

    while (i < hcl.length && depth > 0) {
      const ch = hcl[i];

      if (inHeredoc) {
        if (hcl.startsWith(heredocTag, i) && (hcl[i - 1] === '\n' || /\s/.test(hcl[i - 1] ?? ''))) {
          inHeredoc = false;
          i += heredocTag.length;
          continue;
        }
        i += 1;
        continue;
      }

      if (inString) {
        if (ch === '\\') i += 2;
        else {
          if (ch === '"') inString = false;
          i += 1;
        }
        continue;
      }

      if (ch === '#' || (ch === '/' && hcl[i + 1] === '/')) {
        const nl = hcl.indexOf('\n', i);
        i = nl === -1 ? hcl.length : nl;
        continue;
      }
      const heredoc = /^<<-?([A-Za-z_][A-Za-z0-9_]*)/.exec(hcl.slice(i, i + 40));
      if (heredoc) {
        inHeredoc = true;
        heredocTag = heredoc[1];
        i += heredoc[0].length;
        continue;
      }
      if (ch === '"') {
        inString = true;
        i += 1;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      i += 1;
    }

    const body = hcl.slice(re.lastIndex, i - 1);
    // A variable with no `default` must be supplied, which is the one thing
    // about an input the kit has to get right when it generates a call.
    found.push({ name, required: !/^\s*default\s*=/m.test(body), kind: kindOf(body) });
    re.lastIndex = i;
  }
  return found;
}

/**
 * The shape of a variable, to one word.
 *
 * Enough to emit valid HCL for it and no more: a string is quoted, a number and
 * a bool are not, a list or a map is written as a literal. The full type can be
 * `list(object({ name = string, ... }))` and reproducing that would be building
 * a type system to answer the question "do I put quotes round it".
 *
 * An input with no `type` is `any` by Terraform's rules, and one the kit cannot
 * read is treated the same way — the generator then leaves it to be written by
 * hand rather than guessing at quoting.
 */
function kindOf(body) {
  const match = /^\s*type\s*=\s*([A-Za-z_]+)/m.exec(body);
  if (!match) return 'any';
  const head = match[1];
  return ['string', 'number', 'bool', 'list', 'set', 'map', 'object', 'tuple', 'any'].includes(head)
    ? head
    : 'any';
}

function parseOutputs(hcl) {
  return [...hcl.matchAll(/^output\s+"([^"]+)"/gm)].map((m) => m[1]);
}

/**
 * Every `.tf` at the module root, which is what Terraform itself reads.
 *
 * Looking only at `variables.tf` misses the modules that split their inputs up
 * — Oracle's OKE module has variables-cluster.tf, variables-workers.tf and
 * half a dozen more, and reading one file reported it as having no inputs at
 * all. Reading the directory is both simpler and right.
 */
function readModule(dir) {
  const inputs = [];
  const outputs = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.tf')).sort()) {
    const text = readFileSync(join(dir, file), 'utf8');
    inputs.push(...parseVariables(text));
    outputs.push(...parseOutputs(text));
  }
  return { inputs, outputs };
}

function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx === -1 ? null : argv[onlyIdx + 1];

  const wanted = only ? MODULES.filter((m) => m[2] === only) : MODULES;
  // A repository is cloned once even when several of its submodules are wanted.
  const entries = [];
  const failures = [];

  for (const [provider, namespace, name, version, submodule] of wanted) {
    const source =
      `${namespace}/${name}/${SOURCE_PROVIDER[provider]}` + (submodule ? `//${submodule}` : '');
    let dir;
    try {
      const cloned = cloneAtVersion(namespace, name, provider, version);
      dir = cloned.dir;
      const { inputs, outputs } = readModule(submodule ? join(dir, submodule) : dir);
      if (inputs.length === 0) {
        failures.push(`${source}: no variables at the module root`);
        continue;
      }
      entries.push({
        provider,
        source,
        version,
        inputs: [...inputs].sort((a, b) => a.name.localeCompare(b.name)),
        required: inputs.filter((i) => i.required).map((i) => i.name).sort(),
        outputs: outputs.sort(),
      });
      console.log(
        `  ${source.padEnd(52)} ${version.padStart(8)}  ` +
          `${String(inputs.length).padStart(3)} inputs (${inputs.filter((i) => i.required).length} required), ` +
          `${outputs.length} outputs`,
      );
    } catch (err) {
      failures.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    console.log('\nNot fetched:');
    for (const f of failures) console.log(`  ${f}`);
  }
  if (entries.length === 0) {
    console.error('\nNothing fetched; the existing file is left alone.');
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    '/**',
    ' * Registry module catalog — GENERATED, do not edit by hand.',
    ' *',
    " * The modules the kit can generate a call to, with the inputs and outputs each",
    ' * one actually has at the version pinned here. Read from every module’s own',
    ' * `variables.tf` at that version’s tag, so a blueprint naming an input that a',
    ' * module does not take fails the test suite rather than a plan.',
    ' *',
    ' * Refresh with: npm run modules:update',
    ' */',
    '',
    'export interface ModuleCatalogEntry {',
    '  /** Platform id, matching the shared target vocabulary. */',
    '  readonly provider: string;',
    '  /** What goes in `source`, e.g. "terraform-aws-modules/vpc/aws". */',
    '  readonly source: string;',
    '  readonly version: string;',
    '  /** Comma-joined input names. */',
    '  readonly inputs: string;',
    '  /** Comma-joined shapes, one per input in the same order. */',
    '  readonly kinds: string;',
    '  /** Comma-joined inputs with no default, which a call has to supply. */',
    '  readonly required: string;',
    '  /** Comma-joined output names. */',
    '  readonly outputs: string;',
    '}',
    '',
    '/** When this file was generated, ISO date. */',
    `export const MODULES_FETCHED_AT = '${today}';`,
    '',
    'export const MODULE_CATALOG_DATA: readonly ModuleCatalogEntry[] = [',
  ];
  for (const e of entries) {
    lines.push(
      '  {',
      `    provider: ${JSON.stringify(e.provider)},`,
      `    source: ${JSON.stringify(e.source)},`,
      `    version: ${JSON.stringify(e.version)},`,
      `    inputs: ${JSON.stringify(e.inputs.map((i) => i.name).join(','))},`,
      `    kinds: ${JSON.stringify(e.inputs.map((i) => i.kind).join(','))},`,
      `    required: ${JSON.stringify(e.required.join(','))},`,
      `    outputs: ${JSON.stringify(e.outputs.join(','))},`,
      '  },',
    );
  }
  lines.push('];', '');

  writeFileSync(OUT, lines.join('\n'));
  const totalInputs = entries.reduce((n, e) => n + e.inputs.length, 0);
  console.log(`\n${entries.length} modules, ${totalInputs} inputs. Wrote ${OUT}`);
}

main();
