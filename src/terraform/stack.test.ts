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
import { blueprintsFor } from '../kit/blueprint.ts';
import { buildStack, slug, topLevelBlocks, type StackItem } from './stack.ts';

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
