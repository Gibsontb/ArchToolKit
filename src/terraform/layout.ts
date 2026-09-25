/**
 * The layout a Terraform root module is written in.
 *
 * A blueprint's template writes one `main.tf` with everything in it: the
 * `terraform` block, the provider, the resources, the variables and the
 * outputs. Terraform accepts that — it reads every `.tf` in the directory as
 * one — but it is not how a root module is laid out, and it leaves out the one
 * file somebody needs before a plan: which variables have no default, and what
 * shape their values take.
 *
 * So the single file is split into the conventional layout
 * (developer.hashicorp.com/terraform/language/modules/develop/structure):
 *
 *   versions.tf               the `terraform` block — required_version and providers
 *   providers.tf              the `provider` blocks
 *   main.tf                   resources, data sources, module calls, locals
 *   variables.tf              the `variable` blocks
 *   outputs.tf                the `output` blocks
 *   terraform.tfvars.example  every variable, with the ones that need a value first
 *   README.md                 the commands, in order
 *
 * The blocks are moved whole, comments and all, so nothing a blueprint emits is
 * rewritten. The split is on top-level blocks only, read with the same small
 * reader the stack builder uses.
 *
 * `terraform.tfvars.example` is deliberately not `terraform.tfvars`: Terraform
 * loads `terraform.tfvars` automatically, and a file of placeholders loaded
 * automatically is a plan against placeholders. Copy it and fill it in.
 */

import type { Blueprint, BlueprintGroup, BuildResult } from '../kit/blueprint.ts';
import { derive } from '../kit/blueprint.ts';
import { topLevelBlocks, type HclTopBlock } from './stack.ts';

/** Which file each top-level block kind belongs in. */
const HOME: Readonly<Record<string, string>> = {
  terraform: 'versions.tf',
  provider: 'providers.tf',
  variable: 'variables.tf',
  output: 'outputs.tf',
};

/** Names that hold a credential whether or not the block says `sensitive`. */
const SECRET_NAME = /password|passwd|secret|token|api_?key|private_key|credential|passphrase/i;

const ORDER = ['versions.tf', 'providers.tf', 'main.tf', 'variables.tf', 'outputs.tf'];

/** A variable as the example file needs it. */
interface VariableInfo {
  readonly name: string;
  readonly type: string;
  readonly hasDefault: boolean;
  /** The default as written, when it fits on one line. */
  readonly defaultText?: string;
  readonly sensitive: boolean;
  readonly description: string;
}

/** The body of a block without the comments that were carried in front of it. */
function body(block: HclTopBlock): string {
  const at = block.text.search(new RegExp(`^${block.kind}\\b`, 'm'));
  return at >= 0 ? block.text.slice(at) : block.text;
}

function variableInfo(block: HclTopBlock): VariableInfo {
  const text = body(block);
  // Only the variable's own attributes, one level in; a `validation` block's
  // lines are nested deeper.
  const attr = (name: string) => new RegExp(`^ {2}${name}\\s*=\\s*(.+)$`, 'm').exec(text)?.[1]?.trim();
  return {
    name: block.labels[0] ?? '',
    type: attr('type') ?? 'string',
    hasDefault: attr('default') !== undefined,
    defaultText: ((d) => (d !== undefined && !/[[{(]$/.test(d) ? d : undefined))(attr('default')),
    sensitive: attr('sensitive') === 'true' || SECRET_NAME.test(block.labels[0] ?? ''),
    description: (attr('description') ?? '').replace(/^"|"$/g, ''),
  };
}

/** A value of the right shape to fill in, so the example parses as tfvars. */
function placeholder(type: string): string {
  const t = type.replace(/\s+/g, '');
  if (t === 'number') return '0';
  if (t === 'bool') return 'false';
  if (/^(list|set|tuple)\b/.test(t)) return '[]';
  if (/^(map|object)\b/.test(t)) return '{}';
  if (t === 'any') return 'null';
  return '"CHANGE_ME"';
}

/** `terraform.tfvars.example`: what has to be supplied first, then what can be. */
export function tfvarsExample(variables: readonly VariableInfo[]): string {
  const required = variables.filter((v) => !v.hasDefault);
  const optional = variables.filter((v) => v.hasDefault);
  const lines = [
    '# Copy to terraform.tfvars (loaded automatically) and fill in, or pass each',
    '# value with -var or a TF_VAR_<name> environment variable.',
    '# Never commit the filled-in copy.',
  ];
  const describe = (v: VariableInfo) => (v.description ? [`# ${v.description}`] : []);
  if (required.length > 0) {
    lines.push('', '# --- Required: these have no default -------------------------------------');
    for (const v of required) {
      lines.push('', ...describe(v));
      // A credential is never written as a line to uncomment: it belongs in the
      // environment, where it does not end up in a file next to the code.
      if (v.sensitive) lines.push(`# ${v.name}: sensitive. Set it in the environment (TF_VAR_${v.name}), not in this file.`);
      else lines.push(`${v.name} = ${placeholder(v.type)}`);
    }
  }
  if (optional.length > 0) {
    lines.push('', '# --- Optional: these have a default in variables.tf -------------------------');
    for (const v of optional) {
      lines.push('', ...describe(v), v.sensitive ? `# ${v.name}: sensitive. Set it in the environment (TF_VAR_${v.name}), not in this file.` : `# ${v.name} = ${v.defaultText ?? placeholder(v.type)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The example file for whatever `variable` blocks this HCL declares; '' when none. */
export function tfvarsExampleFor(hcl: string): string {
  const variables = topLevelBlocks(hcl).filter((b) => b.kind === 'variable').map(variableInfo);
  return variables.length > 0 ? tfvarsExample(variables) : '';
}

function readme(files: Readonly<Record<string, string>>, required: readonly VariableInfo[]): string {
  const listed = Object.keys(files).sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return [
    '# Terraform root module',
    '',
    'Unzip into an empty directory and run Terraform from inside it.',
    '',
    '```sh',
    'terraform init        # downloads the providers and modules in versions.tf / main.tf',
    'terraform validate',
    ...(required.length > 0 ? ['cp terraform.tfvars.example terraform.tfvars   # then fill in the required values'] : []),
    'terraform plan -out tfplan',
    'terraform apply tfplan',
    '```',
    '',
    required.length > 0
      ? `Required before plan: ${required.map((v) => `\`${v.name}\``).join(', ')}.`
      : 'Every variable has a default; terraform.tfvars is only needed to change one.',
    '',
    '| File | Holds |',
    '| --- | --- |',
    ...listed.map((name) => `| ${name} | ${describeFile(name)} |`),
    '',
  ].join('\n');
}

function describeFile(name: string): string {
  switch (name) {
    case 'versions.tf': return 'required_version and required_providers';
    case 'providers.tf': return 'provider configuration';
    case 'main.tf': return 'resources, data sources, module calls';
    case 'variables.tf': return 'input variables';
    case 'outputs.tf': return 'outputs';
    case 'terraform.tfvars.example': return 'values to copy into terraform.tfvars';
    case 'README.md': return 'this file';
    default: return name.endsWith('.csv') ? 'reference data; not read by Terraform' : '';
  }
}

/**
 * Split a blueprint's `main.tf` into the root-module layout.
 *
 * Only a result whose HCL is all in `main.tf` is split; one that already
 * arrives in several `.tf` files is left as its author laid it out.
 */
export function asRootModule(result: BuildResult): BuildResult {
  const tfFiles = Object.keys(result.files).filter((name) => name.endsWith('.tf'));
  const main = result.files['main.tf'];
  if (main === undefined || tfFiles.length !== 1) return result;

  const variables: VariableInfo[] = [];
  const buckets = new Map<string, string[]>();
  const blocks = topLevelBlocks(main);
  // The comment at the top of the file describes the whole configuration, not
  // the block it happens to sit in front of, so it opens main.tf.
  let header = '';
  const first = blocks[0];
  if (first && HOME[first.kind] !== undefined) {
    const at = first.text.search(new RegExp(`^${first.kind}\\b`, 'm'));
    if (at > 0) {
      header = first.text.slice(0, at).trim();
      blocks[0] = { ...first, text: first.text.slice(at) };
    }
  }
  if (header) buckets.set('main.tf', [header]);
  for (const block of blocks) {
    const file = HOME[block.kind] ?? 'main.tf';
    if (block.kind === 'variable') variables.push(variableInfo(block));
    const list = buckets.get(file) ?? [];
    list.push(block.text.trim());
    buckets.set(file, list);
  }

  const files: Record<string, string> = {};
  for (const name of ORDER) {
    const blocks = buckets.get(name);
    if (blocks && blocks.length > 0) files[name] = `${blocks.join('\n\n')}\n`;
  }
  // A blueprint with nothing but a module call and a provider still gets a
  // main.tf, so nobody goes looking for it.
  if (files['main.tf'] === undefined) files['main.tf'] = '# Everything this configuration builds is in the files beside this one.\n';
  if (variables.length > 0) files['terraform.tfvars.example'] = tfvarsExample(variables);
  for (const [name, text] of Object.entries(result.files)) if (name !== 'main.tf') files[name] = text;
  files['README.md'] = readme({ ...files, 'README.md': '' }, variables.filter((v) => !v.hasDefault));
  return { ...result, files };
}

export function withRootModuleLayout(blueprint: Blueprint): Blueprint {
  return derive(blueprint, { build: (values, name) => asRootModule(blueprint.build(values, name)) });
}

export function withRootModuleLayoutAll(groups: readonly BlueprintGroup[]): readonly BlueprintGroup[] {
  return groups.map((group) => ({ ...group, blueprints: group.blueprints.map(withRootModuleLayout) }));
}
