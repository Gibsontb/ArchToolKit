import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { hasErrors } from '../core/findings.ts';
import { defaultValues, isVisible, blueprintsFor, findBlueprint, slug, str, num, bool } from './blueprint.ts';
import { TERRAFORM_BLUEPRINTS } from '../terraform/blueprints/index.ts';
import { ANSIBLE_BLUEPRINTS } from '../ansible/blueprints/index.ts';
import { NETWORK_BLUEPRINTS } from '../network/blueprints/index.ts';
import { CATALOG_DATA } from '../terraform/catalog-data.ts';
import { collectModules } from '../ansible/from-plays.ts';

const ALL = [...TERRAFORM_BLUEPRINTS, ...ANSIBLE_BLUEPRINTS];

describe('kit/blueprint: the model', () => {
  it('reads a value, falling back to the default rather than emitting a blank', () => {
    expect(str({ a: 'x' }, 'a', 'fallback')).toBe('x');
    expect(str({ a: '   ' }, 'a', 'fallback')).toBe('fallback');
    expect(str({}, 'a', 'fallback')).toBe('fallback');
  });

  it('reads numbers and booleans the way a form supplies them', () => {
    expect(num({ n: '8' }, 'n', 1)).toBe(8);
    expect(num({ n: 'not a number' }, 'n', 1)).toBe(1);
    // A select renders a boolean as the string "true".
    expect(bool({ b: 'true' }, 'b')).toBe(true);
    expect(bool({ b: 'false' }, 'b')).toBe(false);
    expect(bool({}, 'b', true)).toBe(true);
  });

  it('makes a safe identifier out of whatever someone types', () => {
    expect(slug('My App 01', 'x')).toBe('my_app_01');
    expect(slug('  ', 'fallback')).toBe('fallback');
    expect(slug('a.b-c', 'x')).toBe('a_b_c');
  });

  it('defaults a select to its first option when none is declared', () => {
    const values = defaultValues({
      id: 't',
      label: 't',
      description: '',
      emits: [],
      inputs: [{ id: 'pick', label: 'Pick', control: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
      build: () => ({ files: {} }),
    });
    expect(values.pick).toBe('a');
  });

  it('hides a follow-up question until its trigger is answered', () => {
    const input = { id: 'x', label: 'X', control: 'text' as const, showWhen: { input: 'mode', equals: ['advanced'] } };
    expect(isVisible(input, { mode: 'simple' })).toBe(false);
    expect(isVisible(input, { mode: 'advanced' })).toBe(true);
  });

  it('shows a follow-up to anything but the off answer', () => {
    // An OSPF process of 0 means "not in OSPF", so the area question only makes
    // sense for every other value — which `equals` cannot list.
    const area = { id: 'area', label: 'Area', control: 'text' as const, showWhen: { input: 'process', notEquals: ['0', ''] } };
    expect(isVisible(area, { process: 0 })).toBe(false);
    expect(isVisible(area, {})).toBe(false);
    expect(isVisible(area, { process: 10 })).toBe(true);
  });

  it('finds blueprints by platform', () => {
    expect(blueprintsFor(TERRAFORM_BLUEPRINTS, 'aws').length).toBeGreaterThan(0);
    expect(blueprintsFor(TERRAFORM_BLUEPRINTS, 'nonexistent')).toEqual([]);
    expect(findBlueprint(TERRAFORM_BLUEPRINTS, 'aws', 'aws_ec2_instance')).toBeDefined();
  });
});

describe('kit/blueprint: every blueprint is well formed', () => {
  it('carries a label, a description and at least one input', () => {
    for (const group of ALL) {
      for (const blueprint of group.blueprints) {
        const where = `${group.target}/${blueprint.id}`;
        if (blueprint.label.length < 3) throw new Error(`${where} has no label`);
        if (blueprint.description.length < 10) throw new Error(`${where} has no description`);
        if (blueprint.inputs.length === 0) throw new Error(`${where} has no inputs`);
      }
    }
  });

  it('gives every select its options, since a select with none is an empty box', () => {
    for (const group of ALL) {
      for (const blueprint of group.blueprints) {
        for (const input of blueprint.inputs) {
          if (input.control !== 'select') continue;
          if ((input.options?.length ?? 0) === 0) {
            throw new Error(`${group.target}/${blueprint.id}: select "${input.id}" has no options`);
          }
        }
      }
    }
  });

  it('uses unique input ids within a blueprint', () => {
    for (const group of ALL) {
      for (const blueprint of group.blueprints) {
        const ids = blueprint.inputs.map((i) => i.id);
        if (new Set(ids).size !== ids.length) {
          throw new Error(`${group.target}/${blueprint.id} has a duplicate input id`);
        }
      }
    }
  });

  it('asks every follow-up question of an input that exists, on a condition that can come true', () => {
    // A `showWhen` naming an input the blueprint does not have, or one with an
    // empty `equals`, hides the field for ever. The blueprint still compiles,
    // still builds, and quietly never asks the question — so the only place
    // this can be caught is here. Every kit is swept, not just this file's two.
    for (const group of [...ALL, ...NETWORK_BLUEPRINTS]) {
      for (const blueprint of group.blueprints) {
        const ids = new Set(blueprint.inputs.map((i) => i.id));
        for (const input of blueprint.inputs) {
          const when = input.showWhen;
          if (!when) continue;
          const where = `${group.target}/${blueprint.id}: "${input.id}"`;
          if (!ids.has(when.input)) {
            throw new Error(`${where} depends on "${when.input}", which is not an input of this blueprint`);
          }
          if (when.input === input.id) throw new Error(`${where} depends on itself`);
          if ((when.equals?.length ?? 0) === 0 && (when.notEquals?.length ?? 0) === 0) {
            throw new Error(`${where} has a condition that can never be true, so it is never shown`);
          }
        }
      }
    }
  });

  it('uses unique blueprint ids within a platform', () => {
    for (const group of ALL) {
      const ids = group.blueprints.map((b) => b.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('names its platform in the shared vocabulary, so a handoff lands', () => {
    // The matrix hands over 'google' and 'vsphere'; groups labelled 'gcp' or
    // 'vmware' would silently never be selected.
    const shared = ['aws', 'azure', 'google', 'oci', 'vsphere', 'vcf', 'linux', 'windows'];
    for (const group of ALL) expect(shared).toContain(group.target);
  });

  it('builds from its own defaults without throwing', () => {
    for (const group of ALL) {
      for (const blueprint of group.blueprints) {
        const out = blueprint.build(defaultValues(blueprint), 'check');
        if (Object.keys(out.files).length === 0) {
          throw new Error(`${group.target}/${blueprint.id} generated no files`);
        }
        for (const [filename, body] of Object.entries(out.files)) {
          if (body.trim().length < 20) {
            throw new Error(`${group.target}/${blueprint.id} wrote an empty ${filename}`);
          }
        }
      }
    }
  });

  it('writes no literal credential into anything it generates', () => {
    // The one rule that must hold across every blueprint, whoever wrote it.
    const literal = /(password|secret|private_key)\s*[:=]\s*["'](?!\{\{|\$\{|var\.|CHANGE|xxxx)[^"'\n]{6,}["']/i;
    for (const group of ALL) {
      for (const blueprint of group.blueprints) {
        const out = blueprint.build(defaultValues(blueprint), 'check');
        for (const [filename, body] of Object.entries(out.files)) {
          const match = literal.exec(body);
          if (match) {
            throw new Error(`${group.target}/${blueprint.id} wrote a credential into ${filename}: ${match[0]}`);
          }
        }
      }
    }
  });
});

describe('kit/blueprint: the catalogs check the blueprints', () => {
  /**
   * The point of carrying the catalogs. A provider or collection release that
   * renames something fails here rather than at plan time or on the first task.
   */
  it('emits only Terraform resource types the provider catalog holds', () => {
    const have: Record<string, Set<string>> = {};
    for (const [target, entry] of Object.entries(CATALOG_DATA)) {
      const prefix = target === 'azure' ? 'azurerm_' : `${target}_`;
      have[target] = new Set(entry.resources.split(',').map((n) => prefix + n));
    }
    const unknown: string[] = [];
    for (const group of TERRAFORM_BLUEPRINTS) {
      // null_resource comes from the built-in null provider, which has no
      // catalog entry and needs none.
      if (group.target === 'linux' || group.target === 'windows') continue;
      for (const blueprint of group.blueprints) {
        const hcl = Object.values(blueprint.build(defaultValues(blueprint), 'check').files).join('\n');
        for (const match of hcl.matchAll(/^resource\s+"([a-z0-9_]+)"/gm)) {
          const type = match[1] as string;
          if (!have[group.target]?.has(type)) unknown.push(`${blueprint.id}: ${type}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('names only Ansible modules the Galaxy catalog holds', () => {
    const broken: string[] = [];
    for (const group of ANSIBLE_BLUEPRINTS) {
      for (const blueprint of group.blueprints) {
        const out = blueprint.build(defaultValues(blueprint), 'check');
        if (hasErrors(out.findings ?? [])) {
          broken.push(
            `${group.target}/${blueprint.id}: ${(out.findings ?? [])
              .filter((f) => f.severity === 'error')
              .map((f) => f.message)
              .join('; ')}`,
          );
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('ships a requirements.yml with every playbook that needs one', () => {
    for (const group of ANSIBLE_BLUEPRINTS) {
      for (const blueprint of group.blueprints) {
        const out = blueprint.build(defaultValues(blueprint), 'check');
        const playbook = Object.entries(out.files).find(([n]) => n.endsWith('.yml') && n !== 'requirements.yml');
        const modules = collectModules(JSON.parse(JSON.stringify(playbook?.[1] ?? '')) as unknown);
        // Derived from the play structure, so a playbook using only built-ins
        // correctly has no requirements file.
        const needsCollections = /(?:^|\n)\s*(amazon|community|azure|google|oracle|vmware|microsoft)\./.test(
          playbook?.[1] ?? '',
        );
        const hasRequirements = out.files['requirements.yml'] !== undefined;
        if (needsCollections && !hasRequirements) {
          throw new Error(`${group.target}/${blueprint.id} uses a collection but ships no requirements.yml`);
        }
        expect(modules).toBeDefined();
      }
    }
  });
});
