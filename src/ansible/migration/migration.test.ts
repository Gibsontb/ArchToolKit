/**
 * The "From a migration plan" Ansible blueprints and their roles (design
 * 2.7.5, package WP-7).
 *
 * What has to hold, for every blueprint and every choice of its dropdowns:
 * every module is a real one and every task's options are ones it documents;
 * every YAML file reads back; every task that passes a vault_ variable has
 * no_log; no password or CHANGEME is written anywhere; and the specific
 * promises of the design (Oracle refuses other OSes, the AG listener is
 * skipped on Azure, IPv6 is listened on and allowed).
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { readYaml, type YamlData } from '../../core/yaml-read.ts';
import { defaultValues, type Blueprint, type BlueprintValues } from '../../kit/blueprint.ts';
import { ANSIBLE_BLUEPRINTS, findAnsibleBlueprint } from '../blueprints/index.ts';
import { MIGRATION_BLUEPRINTS, MIGRATION_GROUP } from '../blueprints/migration/index.ts';
import { checkPlaybook } from '../args-check.ts';
import { collectModules } from '../from-plays.ts';
import { moduleNames } from '../module-blueprints.ts';
import { MIGRATION_ROLES, MSSQL_AG, ORACLE_DB, flatTasks, roleFiles } from './roles/index.ts';

const IDS = [
  'mig_reachable',
  'mig_linux_baseline',
  'mig_windows_baseline',
  'mig_vmware_tools_removal',
  'mig_cloud_agents',
  'mig_ad_dc_promote',
  'mig_windows_domain_join',
  'mig_linux_domain_join',
  'mig_oracle_db',
  'mig_mssql_windows',
  'mig_mssql_linux',
  'mig_mssql_ag',
  'mig_postgres_server',
  'mig_mysql_server',
  'mig_monitoring',
  'mig_validate',
];

const KNOWN_MODULES = new Set(moduleNames());

/** The defaults, then the defaults with each other choice of each dropdown, as the real checker builds them. */
function variants(blueprint: Blueprint): { label: string; values: BlueprintValues }[] {
  const base = defaultValues(blueprint);
  const out = [{ label: blueprint.id, values: base }];
  for (const input of blueprint.inputs) {
    if (input.control !== 'select') continue;
    for (const option of input.options ?? []) {
      if (option.value === String(base[input.id])) continue;
      out.push({ label: `${blueprint.id} [${input.id}=${option.value}]`, values: { ...base, [input.id]: option.value } });
    }
  }
  return out;
}

function builds(): { label: string; files: Record<string, string> }[] {
  const out: { label: string; files: Record<string, string> }[] = [];
  for (const id of IDS) {
    const blueprint = findAnsibleBlueprint(id) as Blueprint;
    for (const { label, values } of variants(blueprint)) out.push({ label, files: { ...blueprint.build(values, 'check').files } });
  }
  return out;
}

const BUILDS = builds();

/** Every task in a file: a playbook's plays, or a role's task list. */
function tasksOf(name: string, text: string): Record<string, YamlData>[] {
  const doc = readYaml(text).documents[0];
  if (!Array.isArray(doc)) return [];
  if (/(tasks|handlers)\/main\.yml$/.test(name)) return flatTasks(doc as never) as unknown as Record<string, YamlData>[];
  const out: Record<string, YamlData>[] = [];
  for (const play of doc) {
    if (play === null || typeof play !== 'object' || Array.isArray(play)) continue;
    for (const key of ['pre_tasks', 'tasks', 'post_tasks', 'handlers']) {
      const list = (play as Record<string, YamlData>)[key];
      if (Array.isArray(list)) out.push(...(flatTasks(list as never) as unknown as Record<string, YamlData>[]));
    }
  }
  return out;
}

const isTaskFile = (name: string) => name === 'check.yml' || /^roles\/[^/]+\/(tasks|handlers)\/main\.yml$/.test(name);

/** Keys that only decide whether a task runs; a vault name there passes no value. */
const CONDITIONS = new Set(['when', 'that', 'failed_when', 'changed_when', 'name']);

function passesVault(task: Record<string, YamlData>): boolean {
  const walk = (value: YamlData, key?: string): boolean => {
    if (key && CONDITIONS.has(key)) return false;
    if (typeof value === 'string') return /\{\{[^}]*\bvault_\w+/.test(value);
    if (Array.isArray(value)) return value.some((v) => walk(v));
    if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => walk(v, k));
    return false;
  };
  // A block's own keys are checked on its inner tasks.
  return Object.entries(task).some(([k, v]) => !['block', 'rescue', 'always'].includes(k) && walk(v, k));
}

describe('ansible/migration: the blueprints', () => {
  it('registers every blueprint of design 2.7.5, under "From a migration plan", with hosts first', () => {
    expect(MIGRATION_BLUEPRINTS.map((b) => b.id)).toEqual(IDS);
    for (const id of IDS) {
      const b = findAnsibleBlueprint(id);
      expect([id, b?.group]).toEqual([id, MIGRATION_GROUP]);
      expect([id, b?.inputs[0]?.id, b?.inputs[0]?.default]).toEqual([id, 'hosts', 'all']);
    }
    expect(findAnsibleBlueprint('no_such_blueprint')).toBeUndefined();
  });

  it('puts Linux roles on linux, Windows roles on windows, and the mixed ones on both', () => {
    const on = (target: string) => new Set(ANSIBLE_BLUEPRINTS.find((g) => g.target === target)?.blueprints.map((b) => b.id));
    const linux = on('linux');
    const windows = on('windows');
    for (const id of ['mig_linux_baseline', 'mig_linux_domain_join', 'mig_oracle_db', 'mig_mssql_linux', 'mig_postgres_server', 'mig_mysql_server']) {
      expect([id, linux.has(id), windows.has(id)]).toEqual([id, true, false]);
    }
    for (const id of ['mig_windows_baseline', 'mig_ad_dc_promote', 'mig_windows_domain_join', 'mig_mssql_windows', 'mig_mssql_ag']) {
      expect([id, linux.has(id), windows.has(id)]).toEqual([id, false, true]);
    }
    for (const id of ['mig_reachable', 'mig_vmware_tools_removal', 'mig_cloud_agents', 'mig_monitoring', 'mig_validate']) {
      expect([id, linux.has(id), windows.has(id)]).toEqual([id, true, true]);
    }
  });

  it('writes the play and the role tree for each blueprint', () => {
    const files = findAnsibleBlueprint('mig_oracle_db')?.build(defaultValues(findAnsibleBlueprint('mig_oracle_db') as Blueprint), 'check').files ?? {};
    for (const f of ['check.yml', 'requirements.yml', 'roles/oracle_db/tasks/main.yml', 'roles/oracle_db/defaults/main.yml', 'roles/oracle_db/templates/db_install.rsp.j2', 'roles/oracle_db/templates/dbca.rsp.j2']) {
      expect([f, files[f] !== undefined]).toEqual([f, true]);
    }
    const play = (readYaml(files['check.yml'] as string).documents[0] as Record<string, YamlData>[])[0] as Record<string, YamlData>;
    expect(play.roles).toEqual([{ role: 'oracle_db' }]);
    expect((play.vars as Record<string, YamlData>).mig_oracle_sid).toBe('ORCL');
  });
});

describe('ansible/migration: every build, every dropdown choice', () => {
  it('uses only modules in the committed catalog', () => {
    const unknown: string[] = [];
    for (const { label, files } of BUILDS) {
      for (const [name, text] of Object.entries(files)) {
        if (!isTaskFile(name)) continue;
        for (const m of collectModules(readYaml(text).documents[0])) if (!KNOWN_MODULES.has(m)) unknown.push(`${label} ${name}: ${m}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("passes only options each module documents, with documented values, in plays and roles", () => {
    const problems: string[] = [];
    for (const { label, files } of BUILDS) {
      for (const [name, text] of Object.entries(files)) {
        if (!isTaskFile(name)) continue;
        const asPlaybook = name === 'check.yml' ? text : JSON.stringify([{ hosts: 'all', tasks: readYaml(text).documents[0] }]);
        for (const p of checkPlaybook(asPlaybook)) problems.push(`${label} ${name}: ${p.message}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('writes YAML that reads back, as a --- document with no tabs', () => {
    for (const { label, files } of BUILDS) {
      for (const [name, text] of Object.entries(files)) {
        if (!/\.ya?ml$/.test(name)) continue;
        expect([label, name, text.split('\n').some((l) => l === '---'), /\t/.test(text)]).toEqual([label, name, true, false]);
        // A vars file that only names vault variables is comments after the marker.
        const content = text.split('\n').some((l) => l.trim() !== '' && !l.trim().startsWith('#') && l !== '---');
        expect([label, name, readYaml(text).documents.length]).toEqual([label, name, content ? 1 : 0]);
      }
    }
  });

  it('sets no_log on every task that passes a vault_ variable', () => {
    const exposed: string[] = [];
    let checked = 0;
    for (const { label, files } of BUILDS) {
      for (const [name, text] of Object.entries(files)) {
        if (!isTaskFile(name)) continue;
        for (const task of tasksOf(name, text)) {
          if (!passesVault(task)) continue;
          checked += 1;
          if (task.no_log !== true) exposed.push(`${label} ${name}: ${String(task.name)}`);
        }
      }
    }
    expect(exposed).toEqual([]);
    expect(checked > 20).toBe(true);
  });

  it('writes no password, key or CHANGEME, anywhere', () => {
    // A key that names a secret, given a value that is not a {{ variable }}, a
    // $variable, a boolean or empty.
    const literal = /^(?![ \t]*#).*?\b\w*(password|passwd|pwd|secret|access_?key)['"]?[ \t]*[:=][ \t]*(?!['"]?\{\{)(?!['"]?\$)(?!['"]?(true|false)\b)(?!['"]?[ \t]*$)['"]?[^\s'"{$]/im;
    const found: string[] = [];
    for (const { label, files } of BUILDS) {
      for (const [name, text] of Object.entries(files)) {
        if (/CHANGE_?ME/i.test(text)) found.push(`${label} ${name}: CHANGEME`);
        const m = literal.exec(text);
        if (m) found.push(`${label} ${name}: ${m[0].trim()}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('lists every vault variable the play and roles read in group_vars/all.yml, by name only', () => {
    for (const { label, files } of BUILDS) {
      const used = new Set(Object.entries(files).filter(([n]) => isTaskFile(n) || n.endsWith('defaults/main.yml')).flatMap(([, t]) => [...t.matchAll(/\bvault_\w+/g)].map((m) => m[0])));
      const listed = files['group_vars/all.yml'] ?? '';
      for (const v of used) expect([label, v, listed.includes(`# ${v}: set in vault.yml, not here`)]).toEqual([label, v, true]);
    }
  });
});

describe('ansible/migration: what the design promises', () => {
  it('Oracle refuses anything but Oracle Linux and RHEL 8/9, first', () => {
    const first = ORACLE_DB.tasks[0] as unknown as Record<string, YamlData>;
    const check = first['ansible.builtin.assert'] as { that: string[] };
    expect(check.that).toEqual(["ansible_facts.distribution in ['OracleLinux', 'RedHat']", "ansible_facts.distribution_major_version in ['8', '9']"]);
  });

  it('Oracle media comes from the user, never from Oracle', () => {
    const text = Object.values(roleFiles(ORACLE_DB)).join('\n');
    expect(text).not.toContain('oracle.com');
    expect(text).toContain('{{ oracle_media_url }}');
  });

  it('the AG listener is skipped on Azure', () => {
    const tasks = flatTasks(MSSQL_AG.tasks) as unknown as Record<string, YamlData>[];
    const listener = tasks.find((t) => 'lowlydba.sqlserver.ag_listener' in t) as Record<string, YamlData>;
    expect(listener.when as string[]).toContain("cloud_platform != 'azure'");
    const cluster = tasks.find((t) => String(t.name).startsWith('Create the Windows failover cluster')) as Record<string, YamlData>;
    expect(JSON.stringify(cluster)).toContain('ManagementPointNetworkType Distributed');
  });

  it('listens on and admits IPv6 as well as IPv4', () => {
    const text = (role: string) => Object.values(roleFiles(MIGRATION_ROLES[role] as never)).join('\n');
    expect(text('postgres_server')).toContain('default(["0.0.0.0","::"])');
    expect(text('mysql_server')).toContain("mysql_bind_address | default(''::'')");
    expect(text('linux_baseline')).toContain('server fd00:ec2::123');
    expect(text('validate')).toContain('ansible_facts.default_ipv6.address');
  });

  it('writes the same role files whatever the answers, so a site writes each role once', () => {
    const a = findAnsibleBlueprint('mig_linux_baseline') as Blueprint;
    const one = a.build(defaultValues(a), 'x').files;
    const two = a.build({ ...defaultValues(a), hardening: 'stig', timezone: 'Europe/London', platform: 'azure' }, 'x').files;
    for (const [name, text] of Object.entries(one)) if (name.startsWith('roles/')) expect([name, two[name] === text]).toEqual([name, true]);
  });

  it('asks for the lockdown roles only when a hardening level is chosen', () => {
    const b = findAnsibleBlueprint('mig_windows_baseline') as Blueprint;
    expect(b.build(defaultValues(b), 'x').files['requirements.yml']).not.toContain('roles:');
    const hardened = b.build({ ...defaultValues(b), hardening: 'cis-l2' }, 'x').files['requirements.yml'] as string;
    expect(hardened).toContain('https://github.com/ansible-lockdown/Windows-2022-CIS.git');
    expect(hardened).toContain('- name: ansible.windows');
  });

  it('writes the WinRM bootstrap without credentials, and opens 5986 to the management CIDRs only', () => {
    const b = findAnsibleBlueprint('mig_windows_baseline') as Blueprint;
    const ps1 = b.build(defaultValues(b), 'x').files['files/bootstrap-winrm.ps1'] as string;
    expect(ps1).toContain('-RemoteAddress $ManagementCidrs');
    expect(ps1).toContain('Auth\\Basic -Value $false');
    expect(/password/i.test(ps1)).toBe(false);
  });

  it('turns a shared {{ answer }} into a list at run time rather than splitting the braces', () => {
    const b = findAnsibleBlueprint('mig_postgres_server') as Blueprint;
    const play = readYaml(b.build({ ...defaultValues(b), client_cidrs: '{{ app_cidrs }}' }, 'x').files['x.yml'] as string).documents[0] as Record<string, YamlData>[];
    expect((play[0]?.vars as Record<string, YamlData>).mig_postgres_client_cidrs).toBe("{{ (app_cidrs | string).replace(',', ' ').split() }}");
  });
});

describe('ansible/blueprints/windows: the credential fixes', () => {
  const build = (id: string, values: BlueprintValues = {}) => {
    const b = ANSIBLE_BLUEPRINTS.find((g) => g.target === 'windows')?.blueprints.find((x) => x.id === id) as Blueprint;
    return { b, files: b.build({ ...defaultValues(b), ...values }, 'check').files };
  };

  it('join_domain has no CHANGEME fallback: it asserts the vaulted password and hides the join', () => {
    const { files } = build('join_domain');
    const text = files['check.yml'] as string;
    expect(/CHANGE_?ME/i.test(text)).toBe(false);
    const tasks = tasksOf('check.yml', text);
    expect(tasks[0]?.['ansible.builtin.assert']).toBeDefined();
    const join = tasks.find((t) => 'microsoft.ad.membership' in t) as Record<string, YamlData>;
    expect((join['microsoft.ad.membership'] as Record<string, YamlData>).domain_admin_password).toBe('{{ vault_domain_join_password }}');
    expect(join.no_log).toBe(true);
  });

  it('windows_local_user takes the name of a vault variable, not a password', () => {
    const { b, files } = build('windows_local_user');
    expect(b.inputs.some((i) => i.id === 'password')).toBe(false);
    expect(b.inputs.find((i) => i.id === 'password_var')?.default).toBe('vault_windows_local_user_password');
    const text = files['check.yml'] as string;
    const play = (readYaml(text).documents[0] as Record<string, YamlData>[])[0] as Record<string, YamlData>;
    expect(Object.keys(play.vars as Record<string, YamlData>)).toEqual(['username', 'group']);
    const user = tasksOf('check.yml', text).find((t) => 'ansible.windows.win_user' in t) as Record<string, YamlData>;
    expect((user['ansible.windows.win_user'] as Record<string, YamlData>).password).toBe('{{ vault_windows_local_user_password }}');
    expect(user.no_log).toBe(true);
    expect(files['group_vars/all.yml']).toContain('# vault_windows_local_user_password: set in vault.yml, not here');
  });

  it('windows_local_user will not write a password typed where the variable name goes', () => {
    const { files } = build('windows_local_user', { password_var: 'Pa55 word!' });
    expect(files['check.yml']).not.toContain('Pa55');
    expect(files['check.yml']).toContain('{{ vault_windows_local_user_password }}');
  });
});
