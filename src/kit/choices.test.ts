/**
 * What the answer sets have to keep being true.
 *
 * The point of these is not that a particular instance type is in the list —
 * the list is generated, and it changes. It is that the fields which have a
 * knowable answer set are offering one, that the sets are the right ones for
 * the platform and the generator, and that nothing in them would be rejected
 * on arrival.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { TERRAFORM_BLUEPRINTS } from '../terraform/blueprints/index.ts';
import { ANSIBLE_BLUEPRINTS } from '../ansible/blueprints/index.ts';
import { applyChoices } from './choices.ts';
import { liftSecrets } from '../terraform/secrets.ts';
import { defaultValues, type BlueprintInput } from './blueprint.ts';

const ALL = [
  ...TERRAFORM_BLUEPRINTS.map((g) => ({ kind: 'terraform' as const, group: g })),
  ...ANSIBLE_BLUEPRINTS.map((g) => ({ kind: 'ansible' as const, group: g })),
];

function inputsWithId(id: string) {
  const found: { kind: string; target: string; input: BlueprintInput }[] = [];
  for (const { kind, group } of ALL) {
    for (const blueprint of group.blueprints) {
      for (const input of blueprint.inputs) {
        if (input.id === id) found.push({ kind, target: group.target, input });
      }
    }
  }
  return found;
}

describe('answer sets', () => {
  it('every option in every dropdown has a value and a label', () => {
    for (const { group } of ALL) {
      for (const blueprint of group.blueprints) {
        for (const input of blueprint.inputs) {
          for (const option of input.options ?? []) {
            expect(option.value.length > 0 || input.id === 'unit_number').toBe(true);
            expect(option.label.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('no dropdown offers the same value twice', () => {
    for (const { group } of ALL) {
      for (const blueprint of group.blueprints) {
        for (const input of blueprint.inputs) {
          const values = (input.options ?? []).map((o) => o.value);
          expect(new Set(values).size).toBe(values.length);
        }
      }
    }
  });

  it('a grouped set keeps its groups together, so one optgroup is opened per heading', () => {
    for (const { group } of ALL) {
      for (const blueprint of group.blueprints) {
        for (const input of blueprint.inputs) {
          const groups = (input.options ?? []).map((o) => o.group).filter((g) => g !== undefined);
          if (groups.length === 0) continue;
          const seen = new Set<string>();
          let previous: string | undefined;
          for (const name of groups) {
            if (name === previous) continue;
            expect(seen.has(name)).toBe(false);
            seen.add(name);
            previous = name;
          }
        }
      }
    }
  });

  it('the machine size fields offer the whole catalogue, not a handful', () => {
    const sizes: Record<string, number> = {
      instance_type: 1000,
      vm_size: 400,
      machine_type: 200,
      shape: 50,
      instance_class: 100,
    };
    for (const [id, atLeast] of Object.entries(sizes)) {
      const found = inputsWithId(id);
      expect(found.length).toBeGreaterThan(0);
      for (const { input } of found) {
        expect((input.options ?? []).length).toBeGreaterThan(atLeast);
      }
    }
  });

  it('a yes/no stays a yes/no rather than collecting a rule’s options', () => {
    const booleans = inputsWithId('allow_password_auth');
    expect(booleans.length).toBeGreaterThan(0);
    for (const { input } of booleans) {
      expect(input.control).toBe('select');
      expect((input.options ?? []).map((o) => o.value).sort()).toEqual(['false', 'true']);
    }
  });

  it('a rule adds to a blueprint’s own list rather than replacing it', () => {
    const declared: BlueprintInput = {
      id: 'instance_type',
      label: 'Instance type',
      control: 'select',
      options: [{ value: 'chosen.for.a.reason', label: 'chosen.for.a.reason' }],
    };
    const out = applyChoices(declared, 'aws', 'terraform');
    expect(out.control).toBe('combo');
    expect(out.options?.[0]?.value).toBe('chosen.for.a.reason');
    expect((out.options ?? []).length).toBeGreaterThan(1000);
  });

  it('a genuinely closed set is not added to', () => {
    const declared: BlueprintInput = {
      id: 'replication_type',
      label: 'Replication',
      control: 'select',
      options: [{ value: 'LRS', label: 'LRS' }],
    };
    expect(applyChoices(declared, 'azure', 'terraform')).toEqual(declared);
  });
});

describe('credentials', () => {
  const secretIds = /password$|secret_value$/;

  it('no password field still defaults to a literal', () => {
    for (const { group } of ALL) {
      for (const blueprint of group.blueprints) {
        for (const input of blueprint.inputs) {
          if (!secretIds.test(input.id)) continue;
          const value = String(input.default ?? '');
          expect(/change.?me/i.test(value)).toBe(false);
        }
      }
    }
  });

  it('Terraform is offered variables and Ansible is offered vault lookups', () => {
    for (const { kind, group } of ALL) {
      for (const blueprint of group.blueprints) {
        for (const input of blueprint.inputs) {
          if (!secretIds.test(input.id)) continue;
          const values = (input.options ?? []).map((o) => o.value);
          expect(values.length).toBeGreaterThan(0);
          const wanted = kind === 'terraform' ? /^var\./ : /\{\{/;
          for (const value of values) expect(wanted.test(value)).toBe(true);
        }
      }
    }
  });
});

describe('lifting references out of the quotes', () => {
  it('a whole quoted reference is unquoted and declared', () => {
    const out = liftSecrets('resource "x" "y" {\n  password = "var.db_password"\n}\n');
    expect(out).toContain('password = var.db_password');
    expect(out).toContain('variable "db_password"');
    expect(out).toContain('sensitive   = true');
  });

  it('a reference that is only part of a string is left alone', () => {
    const line = '  name = "prefix-var.db_password"\n';
    expect(liftSecrets(line)).toBe(line);
  });

  it('a variable the template already declares is not declared twice', () => {
    const src = 'variable "db_password" {\n  type = string\n}\n\nresource "x" "y" {\n  password = "var.db_password"\n}\n';
    const out = liftSecrets(src);
    expect(out.match(/variable "db_password"/g)?.length).toBe(1);
  });

  it('running it twice changes nothing the second time', () => {
    const once = liftSecrets('resource "x" "y" {\n  password = "var.db_password"\n}\n');
    expect(liftSecrets(once)).toBe(once);
  });

  it('a name that is not a credential is declared without sensitive', () => {
    const out = liftSecrets('resource "x" "y" {\n  bucket = "var.bucket_name"\n}\n');
    expect(out).toContain('variable "bucket_name"');
    expect(out).not.toContain('sensitive   = true');
  });

  it('every Terraform blueprint declares whatever it references', () => {
    for (const group of TERRAFORM_BLUEPRINTS) {
      for (const blueprint of group.blueprints) {
        const built = blueprint.build(defaultValues(blueprint), 'demo');
        for (const [file, text] of Object.entries(built.files)) {
          if (!file.endsWith('.tf')) continue;
          const declared = new Set([...text.matchAll(/^\s*variable\s+"([\w-]+)"/gm)].map((m) => m[1]));
          for (const use of text.matchAll(/(?<![\w.])var\.([\w-]+)/g)) {
            expect(declared.has(use[1])).toBe(true);
          }
        }
      }
    }
  });
});
