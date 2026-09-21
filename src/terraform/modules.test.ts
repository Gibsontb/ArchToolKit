/**
 * What the module catalog and the calls built from it have to keep being true.
 *
 * The one that matters is the last suite: every input every module blueprint
 * names has to exist in that module at the pinned version. That is the whole
 * bargain — the kit can generate a module call because it checked, not because
 * it remembered.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  hclValue,
  moduleBySource,
  moduleCall,
  modulesFor,
  registryModules,
  versionConstraint,
} from './modules.ts';
import { TERRAFORM_BLUEPRINTS } from './blueprints/index.ts';
import { defaultValues } from '../kit/blueprint.ts';

describe('the module catalog', () => {
  it('holds modules for each of the four clouds', () => {
    for (const target of ['aws', 'azure', 'google', 'oci']) {
      expect(modulesFor(target).length).toBeGreaterThan(0);
    }
  });

  it('records inputs and outputs for every one of them', () => {
    for (const module of registryModules()) {
      expect(module.inputs.length).toBeGreaterThan(0);
      expect(module.outputs.length).toBeGreaterThan(0);
      expect(module.version.length).toBeGreaterThan(0);
    }
  });

  it('gives every input a shape, so a value can be written for it', () => {
    const kinds = new Set(['string', 'number', 'bool', 'list', 'set', 'map', 'object', 'tuple', 'any']);
    for (const module of registryModules()) {
      for (const input of module.inputs) expect(kinds.has(input.kind)).toBe(true);
    }
  });

  it('never lists the same input twice', () => {
    for (const module of registryModules()) {
      const names = module.inputs.map((i) => i.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('version constraints', () => {
  it('pins the minor, so a patch arrives and a major does not', () => {
    expect(versionConstraint('6.7.3')).toBe('~> 6.7');
    expect(versionConstraint('21.25.1')).toBe('~> 21.25');
    expect(versionConstraint('0.4.4')).toBe('~> 0.4');
  });
});

describe('writing a value into HCL', () => {
  it('quotes a string and does not quote a number or a bool', () => {
    expect(hclValue('app-vpc', 'string')).toBe('"app-vpc"');
    expect(hclValue('100', 'number')).toBe('100');
    expect(hclValue('true', 'bool')).toBe('true');
  });

  it('turns a comma-separated box into a list', () => {
    expect(hclValue('us-east-1a, us-east-1b', 'list')).toBe('["us-east-1a", "us-east-1b"]');
  });

  it('turns key=value into an object', () => {
    expect(hclValue('status=Enabled', 'map')).toBe('{ status = "Enabled" }');
  });

  it('leaves a reference alone, whatever the declared type says', () => {
    expect(hclValue('module.vpc.vpc_id', 'string')).toBe('module.vpc.vpc_id');
    expect(hclValue('var.subnets', 'list')).toBe('var.subnets');
    expect(hclValue('["a", "b"]', 'list')).toBe('["a", "b"]');
  });

  it('does not invent a value for an empty box', () => {
    expect(hclValue('', 'string')).toBe('""');
  });
});

describe('a generated module call', () => {
  it('names the module, pins it, and writes the inputs given', () => {
    const out = moduleCall({
      name: 'vpc',
      source: 'terraform-aws-modules/vpc/aws',
      values: new Map([
        ['name', 'app-vpc'],
        ['cidr', '10.0.0.0/16'],
      ]),
    });
    expect(out).toContain('module "vpc" {');
    expect(out).toContain('source  = "terraform-aws-modules/vpc/aws"');
    expect(out).toContain('version = "~> 6.7"');
    expect(out).toContain('name = "app-vpc"');
  });

  it('leaves out an input that was left blank rather than writing an empty one', () => {
    const out = moduleCall({
      name: 'vpc',
      source: 'terraform-aws-modules/vpc/aws',
      values: new Map([
        ['name', 'app-vpc'],
        ['database_subnets', ''],
      ]),
    });
    expect(out).not.toContain('database_subnets');
  });

  it('refuses an input the module does not have', () => {
    let threw = false;
    try {
      moduleCall({
        name: 'vpc',
        source: 'terraform-aws-modules/vpc/aws',
        values: new Map([['not_a_real_input', 'x']]),
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('refuses a module that is not in the catalog', () => {
    let threw = false;
    try {
      moduleCall({ name: 'x', source: 'nobody/nothing/aws', values: new Map() });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('the module blueprints', () => {
  const moduleBlueprints = TERRAFORM_BLUEPRINTS.flatMap((group) =>
    group.blueprints.filter((b) => b.group === 'Terraform Registry modules').map((b) => ({ group, b })),
  );

  it('exist on every cloud that has modules', () => {
    expect(moduleBlueprints.length).toBeGreaterThan(30);
  });

  it('name only inputs their module really has', () => {
    // This is the whole point. A module renames an input in a major version
    // and this fails here rather than on someone's plan.
    for (const { b } of moduleBlueprints) {
      const source = b.emits[0];
      expect(source).toBeDefined();
      const module = moduleBySource(source ?? '');
      expect(module).toBeDefined();
      for (const input of b.inputs) {
        const known = module?.inputs.some((i) => i.name === input.id);
        expect(known).toBe(true);
      }
    }
  });

  it('generate a file that calls the module and pins it', () => {
    for (const { b } of moduleBlueprints) {
      const built = b.build(defaultValues(b), 'demo');
      const text = built.files['main.tf'];
      expect(text).toBeDefined();
      expect(text).toContain('module "');
      expect(text).toContain('source  = "');
      expect(text).toContain('version = "~>');
      expect(text).toContain('required_providers');
    }
  });

  it('write no literal credential into the file', () => {
    for (const { b } of moduleBlueprints) {
      const text = b.build(defaultValues(b), 'demo').files['main.tf'] ?? '';
      expect(/CHANGEME|ChangeMe123/.test(text)).toBe(false);
    }
  });
});
