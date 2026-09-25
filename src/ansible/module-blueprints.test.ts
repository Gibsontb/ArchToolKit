import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { ANSIBLE_BLUEPRINTS } from './blueprints/index.ts';
import { collectionOf, moduleBlueprint, moduleNames, NEW_PLATFORMS, placementOf } from './module-blueprints.ts';
import { readYaml } from '../core/yaml-read.ts';
import { checkPlaybook } from './args-check.ts';

const build = (fqcn: string, values: BlueprintValues = {}): Record<string, string> => {
  const blueprint = moduleBlueprint(fqcn);
  return blueprint.build({ ...defaultValues(blueprint), ...values }, 'demo').files as Record<string, string>;
};

describe('ansible/module-blueprints: one blueprint per module', () => {
  it('offers every module of the Ansible package and oracle.oci', () => {
    const all = ANSIBLE_BLUEPRINTS.flatMap((g) => g.blueprints).filter((b) => b.id.startsWith('mod_'));
    expect(all.length).toBe(moduleNames().length);
    expect(moduleNames().length > 10_000).toBe(true);
    for (const fqcn of ['ansible.builtin.user', 'ansible.windows.win_feature', 'cisco.ios.ios_vlans', 'kubernetes.core.k8s', 'oracle.oci.oci_network_vcn']) {
      expect([fqcn, moduleNames().includes(fqcn)]).toEqual([fqcn, true]);
    }
  });

  it('puts each collection on its platform, and adds the platforms that had none', () => {
    expect(placementOf('ansible.builtin').target).toBe('linux');
    expect(placementOf('ansible.windows').target).toBe('windows');
    expect(placementOf('cisco.ios').target).toBe('network');
    expect(placementOf('kubernetes.core').target).toBe('containers');
    expect(placementOf('community.postgresql').target).toBe('databases');
    expect(placementOf('some.unknown').target).toBe('operations');
    for (const target of Object.keys(NEW_PLATFORMS)) {
      expect([target, ANSIBLE_BLUEPRINTS.some((g) => g.target === target)]).toEqual([target, true]);
    }
  });

  it('asks for every documented option, with documented choices as a closed dropdown', () => {
    const user = moduleBlueprint('ansible.builtin.user');
    const state = user.inputs.find((i) => i.id === 'r.state');
    expect(state?.control).toBe('select');
    expect(state?.options?.map((o) => o.value)).toEqual(['absent', 'present']);
    expect(user.inputs.find((i) => i.id === 'r.name')?.section).toBeUndefined();
    expect(user.inputs.find((i) => i.id === 'r.shell')?.section).toBe('Optional options');
  });

  it('is lazy until picked: listed from the index, loaded on demand', () => {
    const b = moduleBlueprint('community.docker.docker_container');
    expect(typeof b.load).toBe('function');
    expect(b.inputs.length > 100).toBe(true); // Node reads the schema from disk on first use.
  });
});

describe('ansible/module-blueprints: the project it writes', () => {
  it('writes a playbook of one task with only the options given', () => {
    const files = build('ansible.builtin.user', { 'r.name': 'deploy', 'r.shell': '/bin/bash', 'r.groups': 'wheel, docker' });
    const play = (readYaml(files['demo.yml'] ?? '').documents[0] as unknown as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(play.hosts).toBe('all');
    const task = (play.tasks as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(task['ansible.builtin.user']).toEqual({ groups: ['wheel', 'docker'], name: 'deploy', shell: '/bin/bash' });
    // ansible.builtin ships with ansible-core: nothing to install.
    expect(files['requirements.yml']).toBeUndefined();
  });

  it('runs a network module over its connection, and pins its collection', () => {
    const files = build('cisco.ios.ios_vlans');
    expect(files['demo.yml']).toContain('ansible_connection: ansible.netcommon.network_cli');
    expect(files['demo.yml']).toContain('ansible_network_os: cisco.ios.ios');
    expect(files['requirements.yml']).toContain('- name: cisco.ios');
    expect(files['requirements.yml']).toContain("version: '>=");
  });

  it('runs an API module from localhost', () => {
    expect(build('amazon.aws.s3_bucket', { 'r.name': 'logs' })['demo.yml']).toContain('hosts: localhost');
  });

  it('makes a secret a vault variable and a missing required option a variable to fill in', () => {
    const files = build('ansible.mysql.mysql_user');
    const vars = files['group_vars/all.yml'] ?? '';
    expect(files['demo.yml']).toContain('{{ name }}');
    expect(vars).toContain("name: ''");
    const withSecret = build('ansible.windows.win_user', { 'r.name': 'svc', 'r.password': '{{ vault_password }}' });
    expect(withSecret['demo.yml']).toContain('{{ vault_password }}');
    expect(withSecret['group_vars/all.yml'] ?? '').toContain('# vault_password: set in vault.yml, not here');
  });

  it('applies a discovered rule: "one of the following is required"', () => {
    // ansible.builtin.pip needs name or requirements; with neither, name stands in.
    const files = build('ansible.builtin.pip');
    expect(files['demo.yml']).toContain('name:');
    expect(files['group_vars/all.yml'] ?? '').toContain('name:');
  });

  it('writes the file an import refers to, so the playbook runs as downloaded', () => {
    const files = build('ansible.builtin.import_tasks');
    expect(files['tasks/main.yml']).toContain('ansible.builtin.debug');
  });

  it('knows a module from its collection', () => {
    expect(collectionOf('cisco.ios.ios_vlans')).toBe('cisco.ios');
  });
});

describe('ansible: every task against its module’s documentation', () => {
  // ansible-lint's own option check skips modules it cannot import (a missing
  // SDK) and network CLI modules; this one covers them all (args-check.ts).
  it('writes only documented options, with documented values, for every module blueprint', () => {
    const problems: string[] = [];
    for (const group of ANSIBLE_BLUEPRINTS) {
      for (const blueprint of group.blueprints) {
        if (!blueprint.id.startsWith('mod_')) continue;
        for (const [name, text] of Object.entries(blueprint.build(defaultValues(blueprint), 'check').files)) {
          if (name === 'check.yml') for (const p of checkPlaybook(text)) problems.push(`${blueprint.id}: ${p.message}`);
        }
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('catches an option a module does not have, and a value outside its choices', () => {
    const playbook = `---
- hosts: ios
  tasks:
    - cisco.ios.ios_vlans:
        config:
          - vlan_id: 10
        state: sideways
        not_an_option: true
`;
    const messages = checkPlaybook(playbook).map((p) => p.message);
    expect(messages.some((m) => m.includes('no option "not_an_option"'))).toBe(true);
    expect(messages.some((m) => m.includes('state is "sideways"'))).toBe(true);
  });
});
