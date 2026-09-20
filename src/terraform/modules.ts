/**
 * Registry modules, and generating a call to one.
 *
 * The blueprints the kit started with emit resources — a VPC as eleven
 * resources, written out. That is not how the configuration gets written in
 * practice, and pretending otherwise produces something nobody would commit:
 * `terraform-aws-modules/vpc/aws` has been downloaded 214 million times
 * because getting the route tables, the NAT placement and the per-AZ tagging
 * right by hand is a day's work and an ongoing liability. So the kit can call
 * modules too.
 *
 * What makes that safe rather than a paste of remembered input names is the
 * catalog beside this file: the inputs and outputs of each module at the
 * version pinned, read out of that version's own `variables.tf`. An input the
 * module does not take fails the test suite here rather than `terraform plan`
 * on someone's machine, which is the same bargain the provider catalog makes
 * for resource types.
 *
 * Emitting is deliberately literal. The kit writes the inputs it was asked for,
 * quoted according to the variable's declared shape, and nothing else — a
 * module block with its own thirty-line opinion baked in would be worse than
 * the eleven resources it replaced.
 */

import { info, warning, type Finding } from '../core/findings.ts';
import { MODULE_CATALOG_DATA, MODULES_FETCHED_AT } from './module-catalog-data.ts';
import type { CloudTarget } from './providers.ts';

/** What a variable's declared type means for writing a value into HCL. */
export type InputKind =
  | 'string'
  | 'number'
  | 'bool'
  | 'list'
  | 'set'
  | 'map'
  | 'object'
  | 'tuple'
  | 'any';

export interface ModuleInput {
  readonly name: string;
  readonly kind: InputKind;
  /** No default in the module, so a call has to supply it. */
  readonly required: boolean;
}

export interface RegistryModule {
  readonly target: CloudTarget;
  /** What goes in `source`, e.g. "terraform-aws-modules/vpc/aws". */
  readonly source: string;
  readonly version: string;
  readonly inputs: readonly ModuleInput[];
  readonly outputs: readonly string[];
}

const split = (value: string): string[] => (value ? value.split(',').filter(Boolean) : []);

let cache: readonly RegistryModule[] | undefined;

export function registryModules(): readonly RegistryModule[] {
  if (cache) return cache;
  cache = MODULE_CATALOG_DATA.map((entry) => {
    const names = split(entry.inputs);
    const kinds = split(entry.kinds);
    const required = new Set(split(entry.required));
    return {
      target: entry.provider as CloudTarget,
      source: entry.source,
      version: entry.version,
      inputs: names.map((name, i) => ({
        name,
        kind: (kinds[i] ?? 'any') as InputKind,
        required: required.has(name),
      })),
      outputs: split(entry.outputs),
    };
  });
  return cache;
}

export function moduleBySource(source: string): RegistryModule | undefined {
  return registryModules().find((m) => m.source === source);
}

export function modulesFor(target: string): readonly RegistryModule[] {
  return registryModules().filter((m) => m.target === target);
}

export function moduleInput(source: string, name: string): ModuleInput | undefined {
  return moduleBySource(source)?.inputs.find((i) => i.name === name);
}

/**
 * The version constraint written into a generated call.
 *
 * `~> 6.7` rather than `= 6.7.3`: the pessimistic constraint on the minor is
 * what these modules' own documentation uses and what lets a patch release
 * reach the configuration without a commit, while a major — where the inputs
 * this catalog records would change — still does not.
 */
export function versionConstraint(version: string): string {
  const parts = version.split('.');
  if (parts.length < 2) return `~> ${version}`;
  return `~> ${parts[0]}.${parts[1]}`;
}

/** How old the module catalog is, in days. */
export function modulesAgeDays(today = new Date()): number {
  const fetched = Date.parse(MODULES_FETCHED_AT);
  if (Number.isNaN(fetched)) return Number.POSITIVE_INFINITY;
  return Math.floor((today.getTime() - fetched) / 86_400_000);
}

const STALE_AFTER_DAYS = 90;

export function moduleFindings(today = new Date()): readonly Finding[] {
  const modules = registryModules();
  const inputs = modules.reduce((n, m) => n + m.inputs.length, 0);
  const age = modulesAgeDays(today);

  const findings: Finding[] = [
    info(
      'terraform.modules.catalog',
      `Module catalog holds ${modules.length} registry modules and ${inputs} inputs, read from each module's own variables at the pinned version on ${MODULES_FETCHED_AT}.`,
    ),
  ];

  if (age > STALE_AFTER_DAYS) {
    findings.push(
      warning(
        'terraform.modules.stale',
        `The module catalog is ${age} days old, so a module may have released a major version since — which is where inputs get renamed.`,
        { remediation: 'Run npm run modules:update.' },
      ),
    );
  }
  return findings;
}

// --- writing a call --------------------------------------------------------

/**
 * A value written the way its variable's type requires.
 *
 * Only the top-level shape is known, which is all the decision needs: a string
 * gets quotes, a number and a bool do not, and a list or a map is passed
 * through as the literal the form was given so `["a", "b"]` stays a list rather
 * than becoming the string "[\"a\", \"b\"]".
 *
 * A value that is already an HCL expression — a `var.` or `module.` reference,
 * or something in brackets or braces — is never quoted whatever the declared
 * type says, because quoting it would turn a reference into a name.
 */
export function hclValue(value: unknown, kind: InputKind): string {
  const text = String(value ?? '').trim();
  if (text === '') return '""';

  if (/^(var|local|module|data|each)\./.test(text)) return text;
  if (/^[[{]/.test(text)) return text;

  switch (kind) {
    case 'number':
      return Number.isNaN(Number(text)) ? JSON.stringify(text) : text;
    case 'bool':
      return text === 'true' || text === 'false' ? text : JSON.stringify(text);
    case 'list':
    case 'set':
    case 'tuple':
      // A comma-separated box becomes a list of strings, which is what someone
      // typing "us-east-1a, us-east-1b" into a field called `azs` means.
      return `[${text
        .split(',')
        .map((part) => JSON.stringify(part.trim()))
        .join(', ')}]`;
    case 'map':
    case 'object':
      // "a=1, b=2" becomes a one-line object; anything else is left as typed.
      if (!text.includes('=')) return JSON.stringify(text);
      return `{ ${text
        .split(',')
        .map((pair) => {
          const at = pair.indexOf('=');
          return `${pair.slice(0, at).trim()} = ${JSON.stringify(pair.slice(at + 1).trim())}`;
        })
        .join(', ')} }`;
    default:
      return JSON.stringify(text);
  }
}

export interface ModuleCallOptions {
  /** The label after `module`, e.g. `module "vpc"`. */
  readonly name: string;
  readonly source: string;
  /** Input name to value, in the order they should appear. */
  readonly values: ReadonlyMap<string, unknown>;
  /** Left out when empty rather than written as `{}`. */
  readonly tags?: ReadonlyMap<string, string>;
  /** The input this module spells tags with — `tags` almost everywhere. */
  readonly tagsInput?: string;
}

/**
 * One `module` block.
 *
 * Inputs are aligned on the `=` the way `terraform fmt` would leave them, since
 * the output is meant to be pasted into a repository and arriving pre-formatted
 * is the difference between a diff of one block and a diff of the whole file.
 */
export function moduleCall(options: ModuleCallOptions): string {
  const module = moduleBySource(options.source);
  if (!module) {
    throw new Error(`No catalog entry for module ${options.source}`);
  }

  const lines: string[] = [];
  const pairs: [string, string][] = [
    ['source', JSON.stringify(options.source)],
    ['version', JSON.stringify(versionConstraint(module.version))],
  ];

  for (const [name, value] of options.values) {
    const input = module.inputs.find((i) => i.name === name);
    if (!input) {
      throw new Error(`Module ${options.source} has no input "${name}"`);
    }
    if (value === undefined || value === null || String(value).trim() === '') continue;
    pairs.push([name, hclValue(value, input.kind)]);
  }

  const tagsInput = options.tagsInput ?? 'tags';
  if (options.tags && options.tags.size > 0 && module.inputs.some((i) => i.name === tagsInput)) {
    const keyWidth = Math.max(...[...options.tags.keys()].map((k) => k.length));
    const body = [...options.tags]
      .map(([k, v]) => `    ${k.padEnd(keyWidth)} = ${JSON.stringify(v)}`)
      .join('\n');
    pairs.push([tagsInput, `{\n${body}\n  }`]);
  }

  /*
   * Aligned the way `terraform fmt` aligns, which is per run of adjacent lines
   * rather than across the whole block. The source and version pair sit above a
   * blank line and the inputs below it, so padding them to one width — which is
   * what a single pass over every key does — produces a block that fmt would
   * immediately reformat, and a diff on first commit.
   */
  const groups: [string, string][][] = [pairs.slice(0, 2), pairs.slice(2)];
  lines.push(`module "${options.name}" {`);
  groups.forEach((group, index) => {
    if (group.length === 0) return;
    if (index > 0) lines.push('');
    const width = Math.max(...group.map(([k]) => k.length));
    for (const [key, value] of group) lines.push(`  ${key.padEnd(width)} = ${value}`);
  });
  lines.push('}');
  return lines.join('\n');
}
