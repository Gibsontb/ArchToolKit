/**
 * A stack: several blueprints assembled into one root module.
 *
 * The cases that matter are the ones that stop `terraform init` or `validate`:
 * two terraform blocks, two provider blocks, two resources at the same
 * address, and a `var.x` nobody declared.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { TERRAFORM_BLUEPRINTS } from './blueprints/index.ts';
import { blueprintsFor, type Blueprint } from '../kit/blueprint.ts';
import { buildStack, localNames, slug, topLevelBlocks, type StackItem } from './stack.ts';

const AWS = blueprintsFor(TERRAFORM_BLUEPRINTS, 'aws');
const find = (id: string) => AWS.find((b) => b.id === id);
const byId = (id: string) => TERRAFORM_BLUEPRINTS.flatMap((g) => g.blueprints).find((b) => b.id === id);

const item = (blueprintId: string, label: string, values: Record<string, string> = {}): StackItem => ({
  id: label,
  blueprintId,
  label,
  values: { __name: label, ...values },
});

describe('reading the HCL the kit writes', () => {
  it('finds the top-level blocks, and is not fooled by braces in strings or heredocs', () => {
    const hcl = `# a comment
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

resource "aws_s3_bucket" "this" {
  bucket = "not-a-block-{-brace"
  policy = <<EOT
{
  "Version": "2012-10-17"
}
EOT
}

variable "environment" {
  default = "prod"
}
`;
    const blocks = topLevelBlocks(hcl);
    expect(blocks.map((b) => `${b.kind} ${b.labels.join('.')}`)).toEqual([
      'terraform ',
      'resource aws_s3_bucket.this',
      'variable environment',
    ]);
    expect(blocks[1]?.text.includes('EOT')).toBe(true);
  });

  it('makes a file name from an item name', () => {
    expect(slug('Prod VPC', 'x')).toBe('prod-vpc');
    expect(slug('  ', 'item-2')).toBe('item-2');
  });
});

describe('a stack of real blueprints', () => {
  const stack = buildStack(
    [item('aws_vpc_baseline', 'network'), item('aws_ec2_instance', 'web'), item('aws_s3_secure_bucket', 'logs')],
    byId,
    { target: 'aws', stackName: 'migration' },
  );

  it('writes one file per item, in order, plus the shared files', () => {
    expect(Object.keys(stack.files).sort()).toEqual([
      '01-network.tf',
      '02-web.tf',
      '03-logs.tf',
      'README.md',
      'providers.tf',
      'terraform.tfvars.example',
      'variables.tf',
      'versions.tf',
    ]);
  });

  it('merges the terraform block, so init does not see three of them', () => {
    const versions = stack.files['versions.tf'] as string;
    expect((versions.match(/^terraform \{/gm) ?? []).length).toBe(1);
    expect(versions.includes('source  = "hashicorp/aws"')).toBe(true);
    for (const file of Object.keys(stack.files).filter((f) => /^\d\d-/.test(f))) {
      expect([file, (stack.files[file] as string).includes('required_providers')]).toEqual([file, false]);
    }
  });

  it('keeps one provider block', () => {
    expect(((stack.files['providers.tf'] as string).match(/^provider "aws"/gm) ?? []).length).toBe(1);
  });

  it('declares every variable once, including the ones the blueprints only use', () => {
    const variables = stack.files['variables.tf'] as string;
    const declared = [...variables.matchAll(/variable "([^"]+)"/g)].map((m) => m[1] as string);
    expect(declared.length).toBe(new Set(declared).size);
    const used = new Set<string>();
    for (const [name, text] of Object.entries(stack.files)) {
      if (!/^\d\d-/.test(name)) continue;
      for (const m of (text as string).matchAll(/\bvar\.([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1] as string);
    }
    for (const name of used) expect([name, declared.includes(name)]).toEqual([name, true]);
  });

  it('offers what each item exposes to the next one', () => {
    const expressions = stack.references.map((r) => r.expression);
    expect(expressions.some((e) => /^aws_vpc\.[a-z_]+\.id$/.test(e))).toBe(true);
    expect(expressions.some((e) => /^aws_s3_bucket\.[a-z_]+\.id$/.test(e))).toBe(true);
    expect(stack.references.every((r) => ['network', 'web', 'logs'].includes(r.item))).toBe(true);
  });

  it('has no errors, and a README that says how to apply it', () => {
    expect(stack.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect((stack.files['README.md'] as string).includes('terraform apply tfplan')).toBe(true);
  });
});

describe('what a stack has to catch', () => {
  it('two of the same blueprint, by renaming the second rather than colliding', () => {
    const stack = buildStack([item('aws_ec2_instance', 'web'), item('aws_ec2_instance', 'app tier')], byId);
    expect(stack.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(stack.findings.some((f) => f.code === 'tf.stack.renamed')).toBe(true);
    const second = stack.files['02-app-tier.tf'] as string;
    // Declaration and every reference to it move together.
    expect(second.includes('resource "aws_instance" "app_tier"')).toBe(true);
    expect(second.includes('aws_security_group.app_tier.id')).toBe(true);
    expect(second.includes('.this')).toBe(false);
    expect(stack.references.map((r) => r.expression)).toEqual([
      'aws_security_group.this.id',
      'aws_instance.this.id',
      'aws_security_group.app_tier.id',
      'aws_instance.app_tier.id',
    ]);
  });

  it('two items with the same name', () => {
    const stack = buildStack([item('aws_s3_secure_bucket', 'logs'), item('aws_s3_secure_bucket', 'logs')], byId);
    expect(stack.findings.some((f) => f.code === 'tf.stack.duplicate-name')).toBe(true);
    expect(Object.keys(stack.files).filter((f) => /^\d\d-/.test(f))).toEqual(['01-logs.tf', '02-logs-2.tf']);
  });

  it('an item whose blueprint is no longer there', () => {
    const stack = buildStack([item('nope', 'gone')], byId);
    expect(stack.findings.some((f) => f.code === 'tf.stack.blueprint-gone' && f.severity === 'error')).toBe(true);
  });

  it('an empty list', () => {
    expect(buildStack([], byId).findings[0]?.code).toBe('tf.stack.empty');
  });
});

describe('a module item', () => {
  it('offers the module\'s real outputs', () => {
    const vpcModule = AWS.find((b) => b.id === 'aws_module_vpc');
    if (!vpcModule) return;
    const stack = buildStack([item(vpcModule.id, 'network')], byId);
    const fromModule = stack.references.filter((r) => r.address.startsWith('module.'));
    expect(fromModule.length > 3).toBe(true);
    expect(fromModule.some((r) => /subnet|vpc_id/.test(r.attribute))).toBe(true);
  });
});

describe('every AWS blueprint', () => {
  it('can be put in a stack on its own without an error', () => {
    for (const blueprint of AWS) {
      const stack = buildStack([item(blueprint.id, blueprint.id)], byId);
      const errors = stack.findings.filter((f) => f.severity === 'error');
      expect([blueprint.id, errors.map((e) => e.message)]).toEqual([blueprint.id, []]);
      expect([blueprint.id, Object.keys(stack.files).includes('versions.tf')]).toEqual([blueprint.id, true]);
    }
  });
});

describe('stack options the migration planner uses', () => {
  /** A blueprint that writes exactly these files, for the cases no real blueprint shows on its own. */
  const fake = (id: string, files: Record<string, string>): Blueprint => ({
    id,
    label: id,
    description: 'A blueprint for the test.',
    inputs: [],
    emits: [],
    build: () => ({ files }),
  });
  const lookup = (blueprints: readonly Blueprint[]) => (id: string) => blueprints.find((b) => b.id === id);
  const tf = (body: string) => `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 6.65"\n    }\n  }\n}\n\n${body}\n`;

  it('writes the required_version it is asked for, and >= 1.5.0 when not asked', () => {
    const one = [fake('a', { 'main.tf': tf('resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}') })];
    expect(buildStack([item('a', 'a')], lookup(one)).files['versions.tf']).toContain('required_version = ">= 1.5.0"');
    expect(buildStack([item('a', 'a')], lookup(one), { requiredVersion: '>= 1.7.0' }).files['versions.tf']).toContain('required_version = ">= 1.7.0"');
  });

  it('writes the backend block the scaffold writes, inside the terraform block', () => {
    const one = [fake('a', { 'main.tf': tf('resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}') })];
    const versions = buildStack([item('a', 'a')], lookup(one), { backend: 's3' }).files['versions.tf'] as string;
    expect(versions).toContain('backend "s3" {');
    expect(versions).toContain('use_lockfile = true');
    const blocks = topLevelBlocks(versions);
    expect(blocks.filter((b) => b.kind === 'terraform').length).toBe(1);
    expect(blocks[0]?.text.includes('backend "s3"')).toBe(true);
    // No backend unless asked: local state.
    expect(buildStack([item('a', 'a')], lookup(one)).files['versions.tf']).not.toContain('backend');
  });

  it('passes an item\'s other files through beside its own, and merges the README and tfvars example', () => {
    const one = [
      fake('a', {
        'main.tf': tf('resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}\n\nvariable "x" {\n  type = string\n}'),
        'rehost-plan.csv': 'vm,size\nweb01,m7i.large\n',
        'scripts/bootstrap.ps1': 'Write-Output "hello from the bootstrap"\n',
        'README.md': '# the item\'s own readme, replaced by the stack\'s\n',
        'terraform.tfvars.example': 'x = "CHANGE_ME"\n',
      }),
    ];
    const stack = buildStack([item('a', 'Web tier')], lookup(one));
    expect(stack.files['web-tier/rehost-plan.csv']).toBe('vm,size\nweb01,m7i.large\n');
    expect(stack.files['web-tier/scripts/bootstrap.ps1']).toContain('bootstrap');
    expect(Object.keys(stack.files).some((f) => f.startsWith('web-tier/') && /readme|tfvars/i.test(f))).toBe(false);
    expect(stack.files['README.md']).toContain('# stack');
    expect(stack.files['terraform.tfvars.example']).toContain('x = ');
  });

  it('keeps a single-file item\'s file as its HCL, not as a passthrough', () => {
    const one = [fake('a', { 'main.tf': tf('resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}') })];
    const stack = buildStack([item('a', 'net')], lookup(one));
    expect(Object.keys(stack.files).filter((f) => f.includes('/'))).toEqual([]);
  });

  it('reports two items declaring the same local, which Terraform refuses', () => {
    const two = [
      fake('a', { 'main.tf': tf('locals {\n  landing_zone = { prefix = "a" }\n  only_a       = 1\n}') }),
      fake('b', { 'main.tf': tf('locals {\n  landing_zone = {\n    prefix = "b"\n    nested = { deeper = 1 }\n  }\n}') }),
    ];
    const stack = buildStack([item('a', 'first'), item('b', 'second')], lookup(two));
    const dup = stack.findings.filter((f) => f.code === 'tf.stack.duplicate-local');
    expect(dup.length).toBe(1);
    expect(dup[0]?.message).toContain('local.landing_zone');
    expect(dup[0]?.severity).toBe('warning');
  });

  it('does not mistake a nested key or a string for a local', () => {
    expect(localNames('locals {\n  a = { b = 1, c = "d = e" }\n  f = <<-EOT\n    g = h\n  EOT\n  i = [\n    { j = 2 },\n  ]\n}')).toEqual(['a', 'f', 'i']);
  });
});
