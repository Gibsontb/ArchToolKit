/**
 * Every Terraform blueprint, as the zip unpacks: a root module that
 * `terraform init && terraform validate` accepts.
 *
 * Terraform is not run here (the toolkit has no dependencies), so what can be
 * checked statically is: the conventional file layout, exactly one `terraform`
 * block, every `var.` declared once, every `local.` defined, every provider a
 * resource needs listed in required_providers, every local module source
 * present, braces balanced, and a terraform.tfvars.example that names every
 * variable without a default and never writes a credential. Across every
 * select option and toggle, not only the defaults.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type Blueprint, type BlueprintValues } from '../kit/blueprint.ts';
import { TERRAFORM_BLUEPRINTS } from './blueprints/index.ts';
import { asRootModule } from './layout.ts';
import { buildStack, topLevelBlocks } from './stack.ts';

/** Defaults, then each select option and each toggle flipped, one at a time. */
function variants(blueprint: Blueprint): BlueprintValues[] {
  const base = defaultValues(blueprint);
  const out: BlueprintValues[] = [base];
  for (const input of blueprint.inputs) {
    if (input.control === 'toggle') out.push({ ...base, [input.id]: !(base[input.id] === true || base[input.id] === 'true') });
    if (input.control === 'select' && input.options && input.options.length <= 40) {
      for (const option of input.options) if (option.value !== base[input.id]) out.push({ ...base, [input.id]: option.value });
    }
  }
  return out;
}

/** The HCL with strings reduced to their interpolations and comments removed. */
function expressions(hcl: string): string {
  return hcl
    .replace(/<<-?(\w+)\n[\s\S]*?^\s*\1$/gm, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, (literal) => [...literal.matchAll(/\$\{([^}]*)\}/g)].map((m) => ` ${m[1]} `).join('') || '""')
    .replace(/#[^\n]*|\/\/[^\n]*/g, '');
}

/** Everything that would stop init or validate, as messages; empty when none. */
function problems(files: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  const hcl = Object.entries(files)
    .filter(([name]) => name.endsWith('.tf'))
    .map(([, text]) => text)
    .join('\n');
  const blocks = topLevelBlocks(hcl);
  const declared = new Set<string>();
  const locals = new Set<string>();
  const providers = new Set<string>();
  let terraformBlocks = 0;
  for (const block of blocks) {
    if (block.kind === 'variable') {
      const name = block.labels[0] ?? '';
      if (declared.has(name)) out.push(`variable ${name} declared twice`);
      declared.add(name);
    }
    if (block.kind === 'locals') for (const m of block.text.matchAll(/^ {2}([A-Za-z_]\w*)\s*=/gm)) locals.add(m[1] as string);
    if (block.kind === 'terraform') {
      terraformBlocks += 1;
      for (const m of block.text.matchAll(/^\s+([a-z0-9_-]+)\s*=\s*\{\s*\n\s*source/gm)) providers.add(m[1] as string);
    }
    if (block.kind === 'module') {
      const source = /source\s*=\s*"([^"]+)"/.exec(block.text)?.[1] ?? '';
      if (source.startsWith('./') || source.startsWith('../')) {
        const folder = source.replace(/^\.\//, '').replace(/\/$/, '');
        if (!Object.keys(files).some((name) => name.startsWith(`${folder}/`))) out.push(`module source ${source} is not in the files`);
      }
    }
  }
  if (terraformBlocks !== 1) out.push(`${terraformBlocks} terraform blocks`);
  const expr = expressions(hcl);
  for (const m of expr.matchAll(/(?<![\w.-])var\.([A-Za-z_][\w-]*)/g)) if (!declared.has(m[1] as string)) out.push(`var.${m[1]} is not declared`);
  for (const m of expr.matchAll(/(?<![\w.-])local\.([A-Za-z_][\w-]*)/g)) if (!locals.has(m[1] as string)) out.push(`local.${m[1]} is not defined`);
  for (const block of blocks) {
    if (block.kind !== 'resource' && block.kind !== 'data') continue;
    const provider = (block.labels[0] ?? '').split('_')[0] ?? '';
    if (provider !== 'terraform' && !providers.has(provider)) out.push(`${block.labels[0]} needs provider ${provider}, which required_providers does not list`);
  }
  let depth = 0;
  for (const c of expr) {
    if (c === '{') depth += 1;
    if (c === '}') depth -= 1;
  }
  if (depth !== 0) out.push('braces do not balance');
  return [...new Set(out)];
}

describe('every Terraform blueprint, as a root module', () => {
  const all = TERRAFORM_BLUEPRINTS.flatMap((group) => group.blueprints.map((blueprint) => ({ group, blueprint })));

  it('has the conventional layout: versions.tf, main.tf and a README', () => {
    for (const { blueprint } of all) {
      const names = Object.keys(blueprint.build(defaultValues(blueprint), '').files);
      expect([blueprint.id, names.includes('versions.tf'), names.includes('main.tf'), names.includes('README.md')]).toEqual([blueprint.id, true, true, true]);
      // Every block has a home; none is left in a file of its own kind by mistake.
      for (const name of names.filter((n) => n.endsWith('.tf'))) {
        const kinds = new Set(topLevelBlocks(blueprint.build(defaultValues(blueprint), '').files[name] ?? '').map((b) => b.kind));
        if (name === 'versions.tf') expect([blueprint.id, [...kinds].every((k) => k === 'terraform' || k === 'comment')]).toEqual([blueprint.id, true]);
        if (name === 'variables.tf') expect([blueprint.id, [...kinds].every((k) => k === 'variable' || k === 'comment')]).toEqual([blueprint.id, true]);
        if (name === 'outputs.tf') expect([blueprint.id, [...kinds].every((k) => k === 'output' || k === 'comment')]).toEqual([blueprint.id, true]);
        if (name === 'providers.tf') expect([blueprint.id, [...kinds].every((k) => k === 'provider' || k === 'comment')]).toEqual([blueprint.id, true]);
      }
    }
  });

  it('passes the static checks init and validate would fail on, for every option', () => {
    for (const { blueprint } of all) {
      for (const values of variants(blueprint)) {
        expect([blueprint.id, problems(blueprint.build(values, '').files)]).toEqual([blueprint.id, []]);
      }
    }
  });

  it('lists every variable without a default in terraform.tfvars.example, and no credential', () => {
    for (const { blueprint } of all) {
      const files = blueprint.build(defaultValues(blueprint), '').files;
      const variables = topLevelBlocks(files['variables.tf'] ?? '').filter((b) => b.kind === 'variable');
      const required = variables.filter((b) => !/^ {2}default\s*=/m.test(b.text)).map((b) => b.labels[0] ?? '');
      if (variables.length === 0) {
        expect([blueprint.id, files['terraform.tfvars.example']]).toEqual([blueprint.id, undefined]);
        continue;
      }
      const example = files['terraform.tfvars.example'] ?? '';
      for (const name of required) expect([blueprint.id, name, example.includes(name)]).toEqual([blueprint.id, name, true]);
      expect([blueprint.id, /\b(password|passwd|secret|api[_-]?key|token|credential)\w*\s*=\s*"[^"$]/i.test(example)]).toEqual([blueprint.id, false]);
    }
  });

  it('leaves the provider version to a module call, so a root pin cannot contradict the module', () => {
    for (const { blueprint } of all) {
      if (blueprint.group !== 'Terraform Registry modules') continue;
      const versions = blueprint.build(defaultValues(blueprint), '').files['versions.tf'] ?? '';
      const providerBlock = /required_providers\s*\{([\s\S]*?)\n {2}\}/.exec(versions)?.[1] ?? '';
      expect([blueprint.id, /version\s*=/.test(providerBlock)]).toEqual([blueprint.id, false]);
    }
  });

  it('configures azurerm with a features block, without which it will not plan', () => {
    for (const { blueprint } of all) {
      const files = blueprint.build(defaultValues(blueprint), '').files;
      if (!(files['versions.tf'] ?? '').includes('hashicorp/azurerm')) continue;
      expect([blueprint.id, /provider "azurerm" \{[\s\S]*features \{\}/.test(files['providers.tf'] ?? '')]).toEqual([blueprint.id, true]);
    }
  });
});

describe('the root-module split', () => {
  it('moves blocks whole and leaves a result already split alone', () => {
    const main = [
      '# header',
      'terraform {',
      '  required_providers {',
      '    aws = {',
      '      source = "hashicorp/aws"',
      '    }',
      '  }',
      '}',
      '',
      'provider "aws" {',
      '  region = "eu-west-1"',
      '}',
      '',
      'resource "aws_s3_bucket" "b" {',
      '  bucket = var.name',
      '}',
      '',
      'variable "name" {',
      '  type = string',
      '}',
      '',
      'variable "db_password" {',
      '  type      = string',
      '  sensitive = true',
      '}',
      '',
      'output "id" {',
      '  value = aws_s3_bucket.b.id',
      '}',
      '',
    ].join('\n');
    const split = asRootModule({ files: { 'main.tf': main } }).files;
    expect(Object.keys(split).sort()).toEqual(['README.md', 'main.tf', 'outputs.tf', 'providers.tf', 'terraform.tfvars.example', 'variables.tf', 'versions.tf']);
    expect(split['main.tf']?.startsWith('# header')).toBe(true);
    expect(split['main.tf']).toContain('resource "aws_s3_bucket" "b"');
    expect(split['terraform.tfvars.example']).toContain('name = "CHANGE_ME"');
    expect(/^db_password\s*=/m.test(split['terraform.tfvars.example'] ?? '')).toBe(false);
    const already = { 'main.tf': 'resource "x" "y" {}\n', 'variables.tf': 'variable "a" {}\n' };
    expect(asRootModule({ files: already }).files).toEqual(already);
  });

  it('a stack also gets terraform.tfvars.example', () => {
    const lookup = (id: string) => TERRAFORM_BLUEPRINTS.flatMap((g) => g.blueprints).find((b) => b.id === id);
    const stack = buildStack([{ id: 'a', blueprintId: 'aws_ec2_instance', label: 'web', values: {} }], lookup, { target: 'aws' });
    expect(stack.files['terraform.tfvars.example']).toContain('vpc_id');
    expect(problems(stack.files)).toEqual([]);
  });
});
