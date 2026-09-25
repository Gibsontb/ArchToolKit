/**
 * A stack: several blueprints assembled into one Terraform configuration.
 *
 * One blueprint writes one thing. A migration, a landing zone or a platform
 * build is a dozen of them, and pasting a dozen self-contained files into one
 * folder does not work: each carries its own `terraform` block and its own
 * `provider`, Terraform refuses the duplicates, and nothing references
 * anything else.
 *
 * So a stack takes the files each blueprint produces and makes them into the
 * root module they would have been written as by hand:
 *
 *   versions.tf   the terraform block, with every provider merged once
 *   providers.tf  one provider block per provider
 *   variables.tf  every variable declared once, plus a stub for any `var.x`
 *                 the items use without declaring
 *   NN-<name>.tf  one file per item, in the order they were added
 *   outputs.tf    each item's outputs, prefixed with the item's name
 *   README.md     what is in it and how to apply it
 *
 * What each item exposes for the next one — `aws_vpc.this.id`,
 * `module.vpc.private_subnets` — is read back out of the generated HCL and
 * the module catalog, so the page can offer those as answers instead of a
 * typed-in literal.
 *
 * The parsing here is deliberately small: it reads the HCL this toolkit
 * writes, not every HCL that exists. It counts braces outside strings,
 * comments and heredocs, which is all the generated files need.
 */

import { error, info, warning, type Finding } from '../core/findings.ts';
import { defaultValues, type Blueprint } from '../kit/blueprint.ts';
import { numbered, slug, type BlueprintLookup, type StackBuild, type StackItem, type StackReference } from '../kit/stack.ts';
import { moduleBySource } from './modules.ts';
import type { CloudTarget } from './providers.ts';
import { tfvarsExampleFor } from './layout.ts';

export { slug } from '../kit/stack.ts';
export type { StackBuild, StackItem, StackReference } from '../kit/stack.ts';




// ---------------------------------------------------------------------------
// A very small HCL reader
// ---------------------------------------------------------------------------

export interface HclTopBlock {
  /** `resource`, `module`, `provider`, `variable`, `output`, `terraform`, `data`, `locals`. */
  readonly kind: string;
  readonly labels: readonly string[];
  readonly text: string;
}

/** The top-level blocks of a file, with anything between them kept as `comment`. */
export function topLevelBlocks(hcl: string): HclTopBlock[] {
  const out: HclTopBlock[] = [];
  let i = 0;
  let pending = '';

  const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n';

  while (i < hcl.length) {
    const char = hcl[i] as string;

    // Comments and blank space between blocks belong to whatever comes next.
    if (isSpace(char) || char === '#' || (char === '/' && hcl[i + 1] === '/')) {
      const end = char === '#' || char === '/' ? hcl.indexOf('\n', i) : i;
      if (char === '#' || char === '/') {
        const stop = end === -1 ? hcl.length : end + 1;
        pending += hcl.slice(i, stop);
        i = stop;
      } else {
        pending += char;
        i += 1;
      }
      continue;
    }

    // A block header: name, then labels, then `{`.
    const header = /^([A-Za-z_][A-Za-z0-9_-]*)((?:\s+(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+))*)\s*\{/.exec(hcl.slice(i));
    if (!header) {
      // Not something this reader understands; keep it verbatim.
      const next = hcl.indexOf('\n', i);
      const stop = next === -1 ? hcl.length : next + 1;
      pending += hcl.slice(i, stop);
      i = stop;
      continue;
    }

    const start = i;
    const bodyStart = i + header[0].length;
    const end = matchBrace(hcl, bodyStart - 1);
    const text = `${pending}${hcl.slice(start, end)}`.replace(/^\n+/, '');
    pending = '';
    out.push({
      kind: header[1] as string,
      labels: [...(header[2] as string).matchAll(/"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_.-]+)/g)].map((m) => (m[1] ?? m[2]) as string),
      text,
    });
    i = end;
  }

  if (pending.trim() !== '') out.push({ kind: 'comment', labels: [], text: pending });
  return out;
}

/** The index just past the `}` that closes the `{` at `open`. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i] as string;
    // HCL strings are double-quoted only: an apostrophe is just a character,
    // and treating it as a quote swallowed everything up to the next one.
    if (c === '"') {
      i = skipString(text, i);
      continue;
    }
    if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (c === '<' && text[i + 1] === '<') {
      i = skipHeredoc(text, i);
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return text.length;
}

function skipString(text: string, start: number): number {
  const quote = text[start] as string;
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return text.length;
}

function skipHeredoc(text: string, start: number): number {
  const m = /^<<[-~]?([A-Za-z_][A-Za-z0-9_]*)\n/.exec(text.slice(start));
  if (!m) return start + 2;
  const marker = m[1] as string;
  // `<<-EOT` lets the closing marker be indented, so it is found with its
  // leading whitespace, alone on its line.
  const close = new RegExp(`\\n[ \\t]*${marker}[ \\t]*(?=\\r?\\n|$)`, 'g');
  close.lastIndex = start + m[0].length - 1;
  const found = close.exec(text);
  if (!found) return text.length;
  return found.index + found[0].length;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------


interface RequiredProvider {
  readonly source: string;
  readonly version: string;
  readonly from: string;
}

/**
 * Read `required_providers` out of a terraform block.
 *
 * Brace-matched rather than pattern-matched: the entries are themselves
 * blocks, and a regular expression that stops at the first closing brace
 * stops inside the first provider.
 */
function readRequiredProviders(terraformBlock: string, item: string, into: Map<string, RequiredProvider>, findings: Finding[]): void {
  const at = terraformBlock.indexOf('required_providers');
  if (at === -1) return;
  const open = terraformBlock.indexOf('{', at);
  if (open === -1) return;
  const inner = terraformBlock.slice(open + 1, matchBrace(terraformBlock, open) - 1);

  let i = 0;
  while (i < inner.length) {
    const entry = /([A-Za-z0-9_-]+)\s*=\s*\{/.exec(inner.slice(i));
    if (!entry) break;
    const name = entry[1] as string;
    const bodyOpen = i + (entry.index ?? 0) + entry[0].length - 1;
    const bodyEnd = matchBrace(inner, bodyOpen);
    const body = inner.slice(bodyOpen + 1, bodyEnd - 1);
    i = bodyEnd;

    const source = (/source\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? name).trim();
    const version = (/version\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? '').trim();
    const seen = into.get(name);
    if (!seen) {
      into.set(name, { source, version, from: item });
      continue;
    }
    if (version !== '' && seen.version !== version) {
      findings.push(
        warning('tf.stack.provider-version', `${item} asks for ${name} ${version}, and ${seen.from} for ${seen.version || 'any version'}. The stack uses ${seen.version || version}.`, {
          path: 'versions.tf',
          remediation: 'Edit versions.tf if the newer constraint is the one you want.',
        }),
      );
    }
  }
}

const fileNameFor = (index: number, name: string): string => numbered(index, name, '.tf');


/**
 * Rename an item's own resources, data sources and modules, declaration and
 * references together, so a second copy of a blueprint sits beside the first.
 */
function applyRenames(hcl: string, renames: ReadonlyMap<string, string>): string {
  let out = hcl;
  for (const [key, to] of renames) {
    const [kind, type, from] = key.split(':') as [string, string, string];
    const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (kind === 'module') {
      out = out.replace(new RegExp(`module\\s+"${escape(from)}"`, 'g'), `module "${to}"`);
      out = out.replace(new RegExp(`\\bmodule\\.${escape(from)}\\b`, 'g'), `module.${to}`);
      continue;
    }
    const head = kind === 'data' ? 'data' : 'resource';
    out = out.replace(new RegExp(`${head}\\s+"${escape(type)}"\\s+"${escape(from)}"`, 'g'), `${head} "${type}" "${to}"`);
    const prefix = kind === 'data' ? `data\\.${escape(type)}` : escape(type);
    out = out.replace(new RegExp(`\\b${prefix}\\.${escape(from)}\\b`, 'g'), `${kind === 'data' ? `data.${type}` : type}.${to}`);
  }
  return out;
}

/**
 * Assemble the items into one configuration.
 *
 * `blueprintFor` looks an item's blueprint up; an item whose blueprint is gone
 * (a platform changed under it) is reported rather than dropped silently.
 */
export function buildStack(
  items: readonly StackItem[],
  blueprintFor: BlueprintLookup,
  options: { readonly target?: CloudTarget; readonly stackName?: string } = {},
): StackBuild {
  const findings: Finding[] = [];
  const files: Record<string, string> = {};
  const references: StackReference[] = [];

  const providers = new Map<string, RequiredProvider>();
  const providerBlocks = new Map<string, { text: string; from: string }>();
  const variables = new Map<string, { text: string; from: string }>();
  const outputs: string[] = [];
  const addresses = new Map<string, string>();
  const usedVars = new Set<string>();
  const names = new Set<string>();

  if (items.length === 0) {
    return { files: {}, findings: [info('tf.stack.empty', 'Nothing in the build list yet.', {})], references: [] };
  }

  items.forEach((item, index) => {
    const blueprint = blueprintFor(item.blueprintId);
    if (!blueprint) {
      findings.push(error('tf.stack.blueprint-gone', `${item.label}: there is no blueprint called ${item.blueprintId} on this platform any more.`, { remediation: 'Remove it from the list, or switch back to the platform it was added on.' }));
      return;
    }

    let name = slug(item.label, `item-${index + 1}`);
    if (names.has(name)) {
      const unique = `${name}-${index + 1}`;
      findings.push(warning('tf.stack.duplicate-name', `Two items are called ${item.label}; the second is written as ${unique}.`, { remediation: 'Give each item its own name so its file and outputs read clearly.' }));
      name = unique;
    }
    names.add(name);

    let built;
    try {
      built = blueprint.build({ ...defaultValues(blueprint), ...item.values }, item.label);
    } catch (err) {
      findings.push(error('tf.stack.build-failed', `${item.label} could not be generated: ${err instanceof Error ? err.message : String(err)}`, {}));
      return;
    }
    for (const f of built.findings ?? []) findings.push({ ...f, message: `${item.label}: ${f.message}` });

    const body: string[] = [];
    const renames = new Map<string, string>();
    const hcl = Object.entries(built.files)
      .filter(([file]) => /\.tf$/i.test(file) || Object.keys(built.files).length === 1)
      .map(([, text]) => text)
      .join('\n\n');

    for (const block of topLevelBlocks(hcl)) {
      if (block.kind === 'terraform') {
        readRequiredProviders(block.text, item.label, providers, findings);
        continue;
      }
      if (block.kind === 'provider') {
        const key = block.labels[0] ?? 'provider';
        const seen = providerBlocks.get(key);
        if (!seen) providerBlocks.set(key, { text: block.text.trim(), from: item.label });
        else if (seen.text !== block.text.trim()) {
          findings.push(
            warning('tf.stack.provider-differs', `${item.label} configures the ${key} provider differently from ${seen.from}; the stack keeps ${seen.from}'s.`, {
              path: 'providers.tf',
              remediation: 'If they need different regions or accounts, give one an alias in providers.tf and point its resources at it.',
            }),
          );
        }
        continue;
      }
      if (block.kind === 'variable') {
        const key = block.labels[0] ?? '';
        const seen = variables.get(key);
        if (!seen) variables.set(key, { text: block.text.trim(), from: item.label });
        else if (seen.text !== block.text.trim()) {
          findings.push(info('tf.stack.variable-differs', `${item.label} and ${seen.from} both declare var.${key}; the stack keeps ${seen.from}'s declaration.`, { path: 'variables.tf' }));
        }
        continue;
      }
      if (block.kind === 'output') {
        const key = block.labels[0] ?? 'output';
        outputs.push(block.text.trim().replace(/^output\s+"[^"]*"/, `output "${name}_${key}"`));
        continue;
      }
      if (block.kind === 'comment') {
        body.push(block.text.trimEnd());
        continue;
      }

      // Resources, data sources and modules stay with the item, under a name
      // nothing else in the stack has taken.
      if (block.kind === 'resource' || block.kind === 'module' || block.kind === 'data') {
        const type = block.labels[0] ?? '';
        const local = (block.kind === 'module' ? block.labels[0] : block.labels[1]) ?? 'this';
        const addressOf = (localName: string) =>
          block.kind === 'resource' ? `${type}.${localName}` : block.kind === 'data' ? `data.${type}.${localName}` : `module.${localName}`;

        let localName = local;
        if (addresses.has(addressOf(localName))) {
          // Blueprints name their resources the same way every time, so two of
          // the same blueprint always collide. Rename the later one after the
          // item rather than making the person edit the file.
          const base = slug(item.label, `item_${index + 1}`).replace(/-/g, '_');
          let candidate = local === 'this' ? base : `${base}_${local}`;
          let n = 2;
          while (addresses.has(addressOf(candidate))) candidate = `${base}_${local}_${n++}`;
          renames.set(`${block.kind}:${type}:${local}`, candidate);
          findings.push(
            info('tf.stack.renamed', `${addressOf(local)} is already taken by ${addresses.get(addressOf(local))}, so ${item.label}'s is written as ${addressOf(candidate)}.`, {
              path: fileNameFor(index, name),
            }),
          );
          localName = candidate;
        }

        addresses.set(addressOf(localName), item.label);
        const address = addressOf(localName);
        if (block.kind === 'resource') {
          // Only `id`, which every managed resource has. Offering `arn` or
          // `name` for a type that has neither would write a reference that
          // fails at plan time, which is worse than typing it by hand.
          references.push({ expression: `${address}.id`, item: item.label, address, attribute: 'id' });
        } else if (block.kind === 'module') {
          const source = /source\s*=\s*"([^"]+)"/.exec(block.text)?.[1];
          const known = source ? moduleBySource(source) : undefined;
          const attributes = known && known.outputs.length > 0 ? known.outputs : [];
          for (const attribute of attributes) {
            references.push({ expression: `${address}.${attribute}`, item: item.label, address, attribute });
          }
          if (attributes.length === 0) {
            references.push({ expression: `${address}.`, item: item.label, address, attribute: '(name the output)' });
          }
        }
      }
      body.push(block.text.trimEnd());
    }

    for (const m of hcl.matchAll(/\bvar\.([A-Za-z_][A-Za-z0-9_]*)/g)) usedVars.add(m[1] as string);

    files[fileNameFor(index, name)] = `# ${item.label} — ${blueprint.label}\n# ${blueprint.description}\n\n${applyRenames(body.join('\n\n').trim(), renames)}\n`;
  });

  // A `var.x` nothing declares stops `terraform validate`; declare it here.
  for (const name of [...usedVars].sort()) {
    if (variables.has(name)) continue;
    variables.set(name, {
      text: `variable "${name}" {\n  type        = string\n  description = "Declared by the stack builder: an item used var.${name} without declaring it."\n}`,
      from: 'the stack builder',
    });
    findings.push(
      warning('tf.stack.undeclared-variable', `var.${name} is used but was not declared; variables.tf now declares it as a string with no default.`, {
        path: 'variables.tf',
        remediation: `Give it a default, or pass it with -var="${name}=…" or a .tfvars file.`,
      }),
    );
  }

  const stackName = options.stackName?.trim() || 'stack';

  files['versions.tf'] = `${[
    '# Providers for every item in this stack, merged.',
    'terraform {',
    '  required_version = ">= 1.5.0"',
    '',
    '  required_providers {',
    ...[...providers.entries()].map(([name, p]) => `    ${name} = {\n      source  = "${p.source}"${p.version ? `\n      version = "${p.version}"` : ''}\n    }`),
    '  }',
    '}',
  ].join('\n')}\n`;

  if (providerBlocks.size > 0) {
    files['providers.tf'] = `# One provider block per provider. Add an alias here if an item needs a\n# different region or subscription.\n\n${[...providerBlocks.values()].map((p) => p.text).join('\n\n')}\n`;
  }

  if (variables.size > 0) {
    files['variables.tf'] = `# Every variable the items declare, plus anything they used without declaring.\n\n${[...variables.values()].map((v) => v.text).join('\n\n')}\n`;
  }

  if (outputs.length > 0) {
    files['outputs.tf'] = `# Each item's outputs, prefixed with the item's name.\n\n${outputs.join('\n\n')}\n`;
  }

  // What to copy to terraform.tfvars and fill in, required values first.
  const example = tfvarsExampleFor(files['variables.tf'] ?? '');
  if (example) files['terraform.tfvars.example'] = example;

  files['README.md'] = readme(items, stackName, options.target, files);

  return { files, findings, references };
}

function readme(items: readonly StackItem[], stackName: string, target: string | undefined, files: Readonly<Record<string, string>>): string {
  const lines = [
    `# ${stackName}`,
    '',
    `A Terraform root module${target ? ` for ${target}` : ''}, from ${items.length} blueprint${items.length === 1 ? '' : 's'}.`,
    '',
    '## What is in it',
    '',
    ...Object.keys(files)
      .filter((f) => /^\d\d-/.test(f))
      .map((f, i) => `${i + 1}. \`${f}\` — ${items[i]?.label ?? ''}`),
    '',
    '## Shared files',
    '',
    '- `versions.tf` — the Terraform and provider versions, merged from every item.',
    ...(files['providers.tf'] ? ['- `providers.tf` — one block per provider. Give a provider an alias here if two items need different regions or accounts.'] : []),
    ...(files['variables.tf'] ? ['- `variables.tf` — every variable the items need. Anything without a default has to be supplied.'] : []),
    ...(files['outputs.tf'] ? ['- `outputs.tf` — each item\'s outputs, prefixed with the item name.'] : []),
    ...(files['terraform.tfvars.example'] ? ['- `terraform.tfvars.example` — copy to `terraform.tfvars` and fill in the required values before plan.'] : []),
    '',
    '## Applying it',
    '',
    '```',
    'terraform init',
    'terraform validate',
    'terraform plan -out tfplan',
    'terraform apply tfplan',
    '```',
    '',
    'Terraform works out the order from the references between items, so the',
    'file numbers are for reading, not for running.',
    '',
    'Credentials are not written into these files. Supply them the way each',
    'provider expects: environment variables, a shared credentials file, or a',
    'workload identity.',
    '',
  ];
  return `${lines.join('\n')}`;
}
