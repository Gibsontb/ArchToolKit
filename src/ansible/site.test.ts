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
import { blueprintsFor, type Blueprint, type BuildResult } from '../kit/blueprint.ts';
import { buildSite, quoteJinjaScalars } from './site.ts';
import { inventoryYaml } from './project.ts';
import { findAnsibleBlueprint } from './blueprints/index.ts';
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
    // Two made-up playbooks that both answer `state` (a task keyword) the same way.
    const withState = (id: string): Blueprint => ({
      id,
      label: id,
      description: id,
      inputs: [{ id: 'state', label: 'State', control: 'text', default: 'present' }],
      emits: [],
      build: (v) => ({ files: { [`${id}.yml`]: `---\n- hosts: web\n  tasks:\n    - ansible.builtin.debug:\n        msg: ${String(v.state)}\n` } }),
    });
    const lookup = (id: string) => (id === 'one' || id === 'two' ? withState(id) : undefined);
    const site = buildSite([item('one', 'one', { state: 'started' }), item('two', 'two', { state: 'started' })], lookup);
    const shared = site.files['group_vars/all.yml'] as string;
    expect(shared.includes('site_state: started')).toBe(true);
    expect((site.files['01-one.yml'] as string).includes('{{ site_state }}')).toBe(true);
  });

  it('a shared hosts pattern stays in the plays: hosts is resolved before any inventory variable exists', () => {
    const site = buildSite([item('linux_harden_ssh', 'one', { hosts: 'web' }), item('linux_users', 'two', { hosts: 'web' })], byId);
    expect(site.files['group_vars/all.yml'] ?? '').not.toContain('hosts');
    expect(site.files['01-one.yml'] as string).toContain('hosts: web');
    expect(site.files['02-two.yml'] as string).toContain('hosts: web');
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

/** A made-up playbook blueprint that writes exactly these files. */
function fake(id: string, files: Record<string, string>): Blueprint {
  return {
    id,
    label: id,
    description: id,
    inputs: [{ id: 'hosts', label: 'Run against', control: 'text', default: 'all' }],
    emits: [],
    build: (v): BuildResult => ({ files: { [`${id}.yml`]: `---\n- hosts: ${String(v.hosts ?? 'linux')}\n  roles:\n    - role: shared\n`, ...files } }),
  };
}

describe('a site keeps what its items write beside their playbooks', () => {
  const role = { 'roles/shared/tasks/main.yml': '---\n- name: One\n  ansible.builtin.debug:\n    msg: one\n' };
  const blueprints: Record<string, Blueprint> = {
    a: fake('a', { ...role, 'group_vars/linux.yml': '---\nntp: pool.example.com\nshared_key: 1\n', 'host_vars/db1.yml': '---\nsid: ORCL\n', 'templates/x.j2': 'x\n' }),
    b: fake('b', { ...role, 'group_vars/linux.yml': '---\nshared_key: 1\nzone: a\n', 'files/y.txt': 'y\n' }),
    c: fake('c', { 'roles/shared/tasks/main.yml': '---\n- name: Two\n  ansible.builtin.debug:\n    msg: two\n', 'group_vars/linux.yml': '---\nntp: other.example.com\n' }),
  };
  const lookup = (id: string) => blueprints[id];

  it('writes a role two items share once, and keeps templates, files and host_vars', () => {
    const site = buildSite([item('a', 'a'), item('b', 'b')], lookup);
    expect(site.files['roles/shared/tasks/main.yml']).toContain('msg: one');
    expect(site.files['templates/x.j2']).toBe('x\n');
    expect(site.files['files/y.txt']).toBe('y\n');
    expect(site.files['host_vars/db1.yml']).toContain('sid: ORCL');
    expect(site.findings.some((f) => f.code === 'ansible.site.file-conflict')).toBe(false);
    expect(site.files['ansible.cfg']).toContain('roles_path = ./roles');
  });

  it('merges group_vars by key, and says when two items disagree', () => {
    const site = buildSite([item('a', 'a'), item('b', 'b'), item('c', 'c')], lookup);
    const merged = readYaml(site.files['group_vars/linux.yml'] as string).documents[0] as Record<string, unknown>;
    expect(merged).toEqual({ ntp: 'pool.example.com', shared_key: 1, zone: 'a' });
    expect(site.findings.some((f) => f.code === 'ansible.site.group-vars-conflict' && f.message.includes('ntp'))).toBe(true);
  });

  it('keeps the first of two different files at one path, with a warning', () => {
    const site = buildSite([item('a', 'a'), item('c', 'c')], lookup);
    expect(site.files['roles/shared/tasks/main.yml']).toContain('msg: one');
    expect(site.findings.some((f) => f.code === 'ansible.site.file-conflict')).toBe(true);
  });

  it('with playbookDir: playbooks in the folder, vars under inventory/, templates and files beside the playbooks', () => {
    const site = buildSite([item('a', 'first'), item('b', 'second')], lookup, { playbookDir: 'playbooks', playbookNumber: (_i, n) => (n + 1) * 10 });
    const imports = [...(site.files['site.yml'] as string).matchAll(/import_playbook:\s*(\S+)/g)].map((m) => m[1]);
    expect(imports).toEqual(['playbooks/10-first.yml', 'playbooks/20-second.yml']);
    expect(site.files['inventory/group_vars/linux.yml']).toBeDefined();
    expect(site.files['inventory/host_vars/db1.yml']).toBeDefined();
    expect(site.files['group_vars/linux.yml']).toBeUndefined();
    expect(site.files['playbooks/templates/x.j2']).toBe('x\n');
    expect(site.files['playbooks/files/y.txt']).toBe('y\n');
    expect(site.files['roles/shared/tasks/main.yml']).toBeDefined();
    const cfg = site.files['ansible.cfg'] as string;
    expect(cfg).toContain('roles_path = ./roles');
    expect(cfg).toContain('inventory = inventory\n');
  });

  it('writes a group skeleton when the caller brings the inventories', () => {
    const site = buildSite([item('a', 'a', { hosts: 'db_oracle:&platform_aws' })], lookup, { inventory: 'skeleton' });
    const inventory = site.files['inventory/hosts.yml'] as string;
    const doc = readYaml(inventory).documents[0] as { all: { children: Record<string, unknown>; hosts?: unknown } };
    expect(Object.keys(doc.all.children).sort()).toEqual(['db_oracle', 'platform_aws']);
    expect(doc.all.hosts).toBeUndefined();
    expect(inventory).not.toContain('ansible_connection');
  });
});

describe('inventoryYaml: the group skeleton', () => {
  it('lists every group the patterns and the caller name, with no hosts', () => {
    const text = inventoryYaml({ api: false, windows: true, hosts: ['os_kind_windows:!role_ad_dc', 'all'], skeleton: true, groups: ['platform_aws'] });
    const doc = readYaml(text).documents[0] as { all: { children: Record<string, unknown> } };
    expect(Object.keys(doc.all.children)).toEqual(['os_kind_windows', 'platform_aws', 'role_ad_dc']);
    expect(text).not.toContain('winrm');
  });

  it('is still valid with no groups at all', () => {
    const doc = readYaml(inventoryYaml({ api: false, windows: false, hosts: ['all'], skeleton: true })).documents[0] as { all: { children: unknown } };
    expect(doc.all.children).toEqual({});
  });
});

describe('a site of migration playbooks (design 2.7.4)', () => {
  const rows: [number, string, string, Record<string, string>][] = [
    [0, 'mig_reachable', 'all', {}],
    [10, 'mig_linux_baseline', 'os_kind_linux', { hardening: 'cis-l1' }],
    [11, 'mig_windows_baseline', 'os_kind_windows', {}],
    [30, 'mig_oracle_db', 'db_oracle', {}],
    [33, 'mig_mssql_ag', 'db_sqlserver_ag', {}],
    [50, 'mig_monitoring', 'all', { siem: 'splunk' }],
    [60, 'mig_validate', 'all', {}],
  ];
  const items: StackItem[] = rows.map(([, id, hosts, values]) => item(id, id.replace(/^mig_/, '').replace(/_/g, '-'), { hosts, ...values }));
  const numbers = new Map(rows.map(([n, id]) => [id, n]));
  const site = buildSite(items, findAnsibleBlueprint, { stackName: 'plan', playbookDir: 'playbooks', inventory: 'skeleton', playbookNumber: (i) => numbers.get(i.blueprintId) ?? 99 });

  it('imports playbooks/NN-*.yml in order', () => {
    const imports = [...(site.files['site.yml'] as string).matchAll(/import_playbook:\s*(\S+)/g)].map((m) => m[1]);
    expect(imports).toEqual([
      'playbooks/00-reachable.yml',
      'playbooks/10-linux-baseline.yml',
      'playbooks/11-windows-baseline.yml',
      'playbooks/30-oracle-db.yml',
      'playbooks/33-mssql-ag.yml',
      'playbooks/50-monitoring.yml',
      'playbooks/60-validate.yml',
    ]);
  });

  it('writes roles/<role>/tasks/main.yml for each role, and roles_path', () => {
    for (const role of ['linux_baseline', 'windows_baseline', 'oracle_db', 'mssql_ag', 'validate']) {
      expect([role, site.files[`roles/${role}/tasks/main.yml`] !== undefined]).toEqual([role, true]);
    }
    expect(site.files['ansible.cfg']).toContain('roles_path = ./roles');
  });

  it('merges the lockdown roles into requirements.yml beside the collections', () => {
    const doc = readYaml(site.files['requirements.yml'] as string).documents[0] as { collections: { name: string }[]; roles: { name: string; src: string }[] };
    expect(doc.collections.some((c) => c.name === 'lowlydba.sqlserver')).toBe(true);
    expect(doc.roles.some((r) => r.name === 'rhel9_cis' && r.src.includes('ansible-lockdown/RHEL9-CIS'))).toBe(true);
  });

  it('puts the monitoring templates and the WinRM bootstrap beside the playbooks', () => {
    expect(site.files['playbooks/templates/splunk-outputs.conf.j2']).toBeDefined();
    expect(site.files['playbooks/files/bootstrap-winrm.ps1']).toBeDefined();
  });

  it('raises no warning of its own, and every YAML file reads back', () => {
    expect(site.findings.filter((f) => f.severity !== 'info' && f.code.startsWith('ansible.site.')).map((f) => f.message)).toEqual([]);
    for (const [name, text] of Object.entries(site.files)) {
      if (!/\.ya?ml$/.test(name)) continue;
      expect([name, readYaml(text).documents.length > 0]).toEqual([name, true]);
    }
  });
});
