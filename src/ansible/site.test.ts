/**
 * A site playbook: several generated playbooks run as one.
 *
 * What has to hold: every playbook is imported in order, the collections are
 * merged and pinned once, an answer two playbooks share becomes one variable,
 * and every file is YAML that reads back.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { readYaml } from '../core/yaml-read.ts';
import { ANSIBLE_BLUEPRINTS } from './blueprints/index.ts';
import { blueprintsFor } from '../kit/blueprint.ts';
import { buildSite, quoteJinjaScalars } from './site.ts';
import type { StackItem } from '../kit/stack.ts';

const byId = (id: string) => ANSIBLE_BLUEPRINTS.flatMap((g) => g.blueprints).find((b) => b.id === id);

const item = (blueprintId: string, label: string, values: Record<string, string> = {}): StackItem => ({
  id: label,
  blueprintId,
  label,
  values: { __name: label, ...values },
});

describe('a site playbook', () => {
  const site = buildSite(
    [
      item('vsphere_vm_from_template', 'build the VMs', { vcenter_hostname: 'vc01.example.com', datacenter: 'DC1' }),
      item('vsphere_vm_add_disk', 'add the data disk', { vcenter_hostname: 'vc01.example.com' }),
      item('linux_harden_ssh', 'harden ssh'),
    ],
    byId,
    { stackName: 'migration-wave-1' },
  );

  it('writes one playbook per item, and a site.yml that imports them in order', () => {
    expect(Object.keys(site.files).sort()).toEqual([
      '01-build-the-vms.yml',
      '02-add-the-data-disk.yml',
      '03-harden-ssh.yml',
      'README.md',
      'ansible.cfg',
      'group_vars/all.yml',
      'inventory/hosts.yml',
      'requirements.yml',
      'site.yml',
    ]);
    const imports = [...(site.files['site.yml'] as string).matchAll(/import_playbook:\s*(\S+)/g)].map((m) => m[1]);
    expect(imports).toEqual(['01-build-the-vms.yml', '02-add-the-data-disk.yml', '03-harden-ssh.yml']);
  });

  it('merges the collections into one requirements.yml, pinned', () => {
    const requirements = site.files['requirements.yml'] as string;
    const names = [...requirements.matchAll(/- name:\s*(\S+)/g)].map((m) => m[1] as string);
    expect(names.length).toBe(new Set(names).size);
    expect(names.includes('ansible.builtin')).toBe(false);
    expect(/version: '>=/.test(requirements)).toBe(true);
  });

  it('hoists an answer two playbooks give the same way, and references it', () => {
    const shared = site.files['group_vars/all.yml'] as string;
    expect(shared.includes('vcenter_hostname: vc01.example.com')).toBe(true);
    expect((site.files['01-build-the-vms.yml'] as string).includes('{{ vcenter_hostname }}')).toBe(true);
    expect((site.files['02-add-the-data-disk.yml'] as string).includes('vc01.example.com')).toBe(false);
    expect(site.findings.some((f) => f.code === 'ansible.site.hoisted')).toBe(true);
    // An answer only one playbook gives stays where it is.
    expect(shared.includes('DC1')).toBe(false);
  });

  it('offers the shared variables to the page', () => {
    expect(site.references.map((r) => r.expression)).toEqual(['vcenter_hostname']);
    expect(site.references[0]?.address).toBe('group_vars/all.yml');
  });

  it('writes YAML that reads back, in every file', () => {
    for (const [name, text] of Object.entries(site.files)) {
      if (!/\.ya?ml$/.test(name)) continue;
      expect([name, readYaml(text as string).documents.length > 0]).toEqual([name, true]);
    }
  });

  it('says how to run it', () => {
    const readme = site.files['README.md'] as string;
    expect(readme.includes('ansible-galaxy collection install -r requirements.yml')).toBe(true);
    expect(readme.includes('--check --diff')).toBe(true);
  });
});

describe('what a site has to catch', () => {
  it('a variable nothing sets', () => {
    const site = buildSite([item('linux_users', 'users', { hosts: '{{ patch_group }}' })], byId);
    expect(site.findings.some((f) => f.code === 'ansible.site.undefined-variable')).toBe(true);
    expect((site.files['group_vars/all.yml'] as string).includes('patch_group: ""')).toBe(true);
  });

  it('two items with the same name', () => {
    const site = buildSite([item('linux_harden_ssh', 'ssh'), item('linux_harden_ssh', 'ssh')], byId);
    expect(site.findings.some((f) => f.code === 'ansible.site.duplicate-name')).toBe(true);
    expect(Object.keys(site.files).filter((f) => /^\d\d-/.test(f))).toEqual(['01-ssh.yml', '02-ssh-2.yml']);
  });

  it('an item whose playbook is gone, and an empty list', () => {
    expect(buildSite([item('nope', 'gone')], byId).findings.some((f) => f.code === 'ansible.site.blueprint-gone')).toBe(true);
    expect(buildSite([], byId).findings[0]?.code).toBe('ansible.site.empty');
  });

  it('a secret, by leaving it out of group_vars and saying where it belongs', () => {
    const site = buildSite(
      [item('vsphere_vm_from_template', 'a', { vcenter_password: '{{ vault_vcenter_password }}' }), item('vsphere_vm_add_disk', 'b', { vcenter_password: '{{ vault_vcenter_password }}' })],
      byId,
    );
    expect(site.findings.some((f) => f.code === 'ansible.site.secret-variable')).toBe(true);
    expect((site.files['group_vars/all.yml'] as string | undefined)?.includes('vault_vcenter_password') ?? false).toBe(false);
  });

  it('a shared answer whose name is one of Ansible\'s own words', () => {
    const site = buildSite([item('linux_harden_ssh', 'one', { hosts: 'web' }), item('linux_users', 'two', { hosts: 'web' })], byId);
    const shared = site.files['group_vars/all.yml'] as string;
    expect(shared.includes('site_hosts: web')).toBe(true);
    expect((site.files['01-one.yml'] as string).includes('{{ site_hosts }}')).toBe(true);
  });

  it('YAML that would break on a bare {{ variable }}', () => {
    expect(quoteJinjaScalars('  name: {{ thing }}\n  other: plain\n')).toBe('  name: "{{ thing }}"\n  other: plain\n');
    expect(quoteJinjaScalars('  name: "{{ thing }}"\n')).toBe('  name: "{{ thing }}"\n');
    expect(readYaml(quoteJinjaScalars('- hosts: all\n  vars:\n    a: {{ b }}\n')).documents.length).toBe(1);
  });
});

describe('every playbook', () => {
  it('can be put in a site on its own, and still reads as YAML', () => {
    for (const group of ANSIBLE_BLUEPRINTS) {
      for (const blueprint of blueprintsFor(ANSIBLE_BLUEPRINTS, group.target)) {
        const site = buildSite([item(blueprint.id, blueprint.id)], byId);
        const bad = site.findings.filter((f) => f.severity === 'error' || f.code.endsWith('build-failed') || f.code.endsWith('no-playbook'));
        expect([blueprint.id, bad.map((f) => f.message)]).toEqual([blueprint.id, []]);
        for (const [name, text] of Object.entries(site.files)) {
          if (!/\.ya?ml$/.test(name)) continue;
          let ok = true;
          try {
            readYaml(text as string);
          } catch {
            ok = false;
          }
          expect([blueprint.id, name, ok]).toEqual([blueprint.id, name, true]);
        }
      }
    }
  });
});
