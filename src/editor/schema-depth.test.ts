/**
 * The Terraform and Ansible profiles, checked to the depth of the schemas the
 * toolkit carries: a resource's arguments and nested blocks, a task's module
 * options. Fixtures are synthetic; every name in them is invented.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { readYaml } from '../core/yaml-read.ts';
import type { Finding } from '../core/findings.ts';
import { parsePath, type Json } from './doc.ts';
import { choicesAt } from './profile.ts';
import { terraformJson } from './profiles/terraform.ts';
import { ansiblePlaybook } from './profiles/ansible.ts';
import { checkPlaybook } from '../ansible/args-check.ts';

const yaml = (text: string): Json => readYaml(text).documents[0] as Json;
const errors = (fs: Finding[]) => fs.filter((f) => f.severity === 'error');
const tf = (doc: Json) => terraformJson.validate?.(doc) ?? [];
const playbook = (doc: Json) => ansiblePlaybook.validate?.(doc) ?? [];
const find = (fs: Finding[], code: string, path: string) => fs.find((f) => f.code === code && f.path === path);
const brief = (fs: Finding[]) => fs.map((f) => `${f.code} ${f.path}: ${f.message}`);

// ---------------------------------------------------------------------------
// Terraform
// ---------------------------------------------------------------------------

describe('terraform-json: arguments and nested blocks', () => {
  it('aws: a correct record passes', () => {
    const doc = {
      resource: {
        aws_route53_record: {
          www: { zone_id: '${aws_route53_zone.main.zone_id}', name: 'www.example.test', type: 'A', ttl: 300, records: ['192.0.2.10'], count: 1 },
        },
      },
    } as Json;
    expect(brief(tf(doc))).toEqual([]);
  });

  it('aws: an unknown argument, a missing one, a value outside the documented set, a wrong type', () => {
    const f = tf({ resource: { aws_route53_record: { www: { name: 'www.example.test', type: 'AA', ttl: 'soon', recrods: ['192.0.2.10'] } } } });
    const unknown = find(f, 'tf.argument.unknown', 'resource.aws_route53_record.www.recrods');
    expect(unknown?.message.includes('Did you mean records?')).toBe(true);
    expect(find(f, 'tf.argument.required', 'resource.aws_route53_record.www')?.message.includes('zone_id')).toBe(true);
    expect(find(f, 'tf.argument.value', 'resource.aws_route53_record.www.type')?.message.includes('AAAA')).toBe(true);
    expect(find(f, 'tf.argument.type', 'resource.aws_route53_record.www.ttl') !== undefined).toBe(true);
  });

  it('azurerm: a correct storage account passes', () => {
    const doc = {
      resource: {
        azurerm_storage_account: {
          logs: {
            name: 'stlogs001',
            resource_group_name: '${azurerm_resource_group.main.name}',
            location: 'westeurope',
            account_tier: 'Standard',
            account_replication_type: 'ZRS',
            tags: { owner: 'platform' },
          },
        },
      },
    } as Json;
    expect(brief(errors(tf(doc)))).toEqual([]);
    expect(brief(tf(doc))).toEqual([]);
  });

  it('azurerm: an unknown argument, a missing one, a bad enum value', () => {
    const f = tf({
      resource: { azurerm_storage_account: { logs: { name: 'stlogs001', location: 'westeurope', acount_tier: 'Standard', account_replication_type: 'XRS' } } },
    });
    expect(find(f, 'tf.argument.unknown', 'resource.azurerm_storage_account.logs.acount_tier')?.message.includes('Did you mean account_tier?')).toBe(true);
    const missing = f.filter((x) => x.code === 'tf.argument.required').map((x) => x.message);
    expect(missing.some((m) => m.includes('resource_group_name'))).toBe(true);
    expect(missing.some((m) => m.includes('account_tier'))).toBe(true);
    expect(find(f, 'tf.argument.value', 'resource.azurerm_storage_account.logs.account_replication_type')?.severity).toBe('warning');
  });

  it('vsphere: a correct virtual machine passes, nested blocks and dynamic included', () => {
    const doc = {
      resource: {
        vsphere_virtual_machine: {
          app01: {
            name: 'app01',
            resource_pool_id: '${data.vsphere_compute_cluster.c.resource_pool_id}',
            num_cpus: 2,
            memory: '4096',
            firmware: 'efi',
            network_interface: [{ network_id: '${data.vsphere_network.n.id}' }],
            disk: { label: 'disk0', size: 40 },
            dynamic: { cdrom: { for_each: '${var.cdroms}', content: { client_device: true } } },
            lifecycle: { ignore_changes: ['annotation'] },
          },
        },
      },
    } as Json;
    expect(brief(errors(tf(doc)))).toEqual([]);
  });

  it('vsphere: an unknown argument, a missing one, a bad enum value, too many blocks, a bad nested argument', () => {
    const f = tf({
      resource: {
        vsphere_virtual_machine: {
          app01: {
            name: 'app01',
            num_cpu: 2,
            firmware: 'uefi',
            clone: [{ template_uuid: 'a' }, { template_uuid: 'b' }],
            disk: [{ label: 'disk0', sise: 40 }],
          },
        },
      },
    });
    expect(find(f, 'tf.argument.unknown', 'resource.vsphere_virtual_machine.app01.num_cpu')?.message.includes('Did you mean num_cpus?')).toBe(true);
    expect(find(f, 'tf.argument.required', 'resource.vsphere_virtual_machine.app01')?.message.includes('resource_pool_id')).toBe(true);
    expect(find(f, 'tf.argument.value', 'resource.vsphere_virtual_machine.app01.firmware')?.message.includes('efi')).toBe(true);
    expect(find(f, 'tf.block.count', 'resource.vsphere_virtual_machine.app01.clone') !== undefined).toBe(true);
    expect(find(f, 'tf.argument.unknown', 'resource.vsphere_virtual_machine.app01.disk[0].sise')?.message.includes('Did you mean size?')).toBe(true);
  });

  it('skips expressions, and keeps the checks it had', () => {
    const f = tf({
      variable: { admin_password: { type: 'string' } },
      resource: { aws_route53_record: { www: { zone_id: 'Z1', name: 'x', type: '${var.record_type}', ttl: '${var.ttl}' } } },
    });
    expect(f.some((x) => x.code.startsWith('tf.argument'))).toBe(false);
    expect(f.some((x) => x.code === 'tf.variable.not-sensitive')).toBe(true);
  });

  it('offers the documented values, through nested blocks', () => {
    const doc = {
      resource: {
        azurerm_storage_account: { logs: { account_tier: 'Standard' } },
        vsphere_virtual_machine: { app01: { firmware: 'efi', disk: [{ label: 'd' }] } },
      },
    } as Json;
    const c = (path: string) => choicesAt(terraformJson, doc, parsePath(path));
    expect(c('resource.azurerm_storage_account.logs.account_tier')).toEqual(['Standard', 'Premium']);
    expect(c('resource.vsphere_virtual_machine.app01.firmware')).toEqual(['bios', 'efi']);
    expect(c('resource.vsphere_virtual_machine.app01.name')).toBe(undefined);
    expect(c('variable.x.type')?.includes('string')).toBe(true);
  });

  it('prepare resolves for known, unknown and uncatalogued types', async () => {
    await terraformJson.prepare?.({ resource: { aws_route53_record: { a: {} }, aws_nonesuch: { b: {} }, kubernetes_pod: { c: {} } } });
  });
});

// ---------------------------------------------------------------------------
// Ansible
// ---------------------------------------------------------------------------

describe('ansible-playbook: module options', () => {
  it('a correct playbook passes', () => {
    const doc = yaml(`
- hosts: web
  tasks:
    - name: Config
      ansible.builtin.copy:
        src: app.conf
        dest: /etc/app.conf
        mode: '0644'
    - name: Directory
      ansible.builtin.file:
        path: /srv/app
        state: directory
    - name: Short name, options in args
      copy:
      args:
        content: hello
        dest: /tmp/hello
    - name: Templated
      ansible.builtin.file:
        path: /srv/x
        state: "{{ wanted_state }}"
`);
    expect(brief(errors(playbook(doc)))).toEqual([]);
  });

  it('a bad option, a missing required option, a value outside the choices, in plays and blocks', () => {
    const doc = yaml(`
- hosts: web
  tasks:
    - name: Typo
      ansible.builtin.copy:
        src: app.conf
        dset: /etc/app.conf
    - name: Wrong state
      ansible.builtin.file:
        path: /srv/app
        state: folder
    - block:
        - name: Missing path
          ansible.builtin.file:
            state: directory
      rescue:
        - name: Short name
          copy:
            src: a
      always:
        - name: In args
          ansible.builtin.file:
          args:
            path: /x
            stat: absent
`);
    const f = playbook(doc);
    const unknown = find(f, 'ansible.option.unknown', '[0].tasks[0]["ansible.builtin.copy"].dset');
    expect(unknown?.message.includes('Did you mean dest?')).toBe(true);
    expect(find(f, 'ansible.option.required', '[0].tasks[0]["ansible.builtin.copy"]')?.message.includes('dest')).toBe(true);
    expect(find(f, 'ansible.option.choice', '[0].tasks[1]["ansible.builtin.file"].state')?.message.includes('directory')).toBe(true);
    expect(find(f, 'ansible.option.required', '[0].tasks[2].block[0]["ansible.builtin.file"]')?.message.includes('path')).toBe(true);
    expect(find(f, 'ansible.option.required', '[0].tasks[2].rescue[0].copy')?.message.includes('dest')).toBe(true);
    expect(find(f, 'ansible.option.unknown', '[0].tasks[2].always[0].args.stat')?.message.includes('Did you mean state?')).toBe(true);
  });

  it('a task list (a role) is checked the same way', () => {
    const f = playbook(yaml(`
- name: Copy
  ansible.builtin.copy:
    src: a
`));
    expect(find(f, 'ansible.option.required', '[0]["ansible.builtin.copy"]') !== undefined).toBe(true);
  });

  it('offers the documented choices of a module option', () => {
    const doc = yaml(`
- hosts: web
  tasks:
    - ansible.builtin.file:
        path: /x
        state: absent
    - copy:
        dest: /x
        backup: true
    - ansible.builtin.service:
        name: nginx
        state: started
`);
    const c = (path: string) => ansiblePlaybook.choices?.(parsePath(path), doc);
    expect(c('[0].tasks[0]["ansible.builtin.file"].state')?.includes('directory')).toBe(true);
    expect(c('[0].tasks[0]["ansible.builtin.file"].path')).toBe(undefined);
    expect(c('[0].tasks[1].copy.dest')).toBe(undefined);
    expect(c('[0].tasks[2]["ansible.builtin.service"].state')?.includes('restarted')).toBe(true);
    expect(c('[0].become_method')?.includes('sudo')).toBe(true);
  });

  it('prepare resolves, whatever the modules', async () => {
    await ansiblePlaybook.prepare?.(yaml('- hosts: web\n  tasks:\n    - copy: { src: a, dest: b }\n    - example.nonesuch.thing: {}\n'));
  });

  it('checkPlaybook still reports the same problems as text', () => {
    const problems = checkPlaybook('- hosts: web\n  tasks:\n    - ansible.builtin.copy:\n        dset: /x\n');
    expect(problems).toEqual([
      { module: 'ansible.builtin.copy', path: 'dset', message: 'ansible.builtin.copy has no option "dset"' },
      { module: 'ansible.builtin.copy', path: 'dest', message: 'ansible.builtin.copy needs dest' },
    ]);
  });
});
