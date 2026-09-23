/**
 * Every Ansible blueprint, as the zip unpacks: a project that
 * `ansible-playbook --syntax-check` accepts and that runs where it is unzipped.
 *
 * ansible-core is not available to the test suite, so the checks are the ones
 * syntax-check and the first run depend on: every YAML file parses; a playbook
 * is a list of plays, each with `hosts` and tasks whose only non-keyword key is
 * one fully qualified module; requirements.yml is `collections:` as a list of
 * `name` / `version` mappings and lists every collection the play uses; the
 * inventory ansible.cfg points at exists and parses; and an API play targets
 * localhost, which runs without any inventory entry. Across every select
 * option and toggle.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type Blueprint, type BlueprintValues } from '../kit/blueprint.ts';
import { readYaml, type YamlData } from '../core/yaml-read.ts';
import { ANSIBLE_BLUEPRINTS } from './blueprints/index.ts';
import { buildSite } from './site.ts';
import { inventoryYaml } from './project.ts';

const API_TARGETS = new Set(['aws', 'azure', 'google', 'oci', 'vsphere']);

/** Task keywords: anything else on a task is its module. */
const TASK_KEYWORDS = new Set([
  'name', 'register', 'loop', 'loop_control', 'when', 'become', 'become_user', 'become_method', 'delegate_to', 'delegate_facts',
  'run_once', 'ignore_errors', 'ignore_unreachable', 'no_log', 'notify', 'tags', 'changed_when', 'failed_when', 'until', 'retries',
  'delay', 'vars', 'environment', 'args', 'check_mode', 'diff', 'listen', 'async', 'poll', 'timeout', 'throttle', 'module_defaults',
  'any_errors_fatal', 'connection', 'debugger', 'with_items', 'with_dict', 'with_fileglob', 'with_sequence', 'with_subelements',
  'with_together', 'with_nested', 'with_first_found',
]);

function variants(blueprint: Blueprint): BlueprintValues[] {
  const base = defaultValues(blueprint);
  const out: BlueprintValues[] = [base];
  for (const input of blueprint.inputs) {
    if (input.control === 'toggle') out.push({ ...base, [input.id]: !(base[input.id] === true || base[input.id] === 'true') });
    if (input.control === 'select' && input.options && input.options.length <= 40) {
      for (const option of input.options) if (option.value !== base[input.id]) out.push({ ...base, [input.id]: option.value });
    }
  }
  return out;
}

const isMap = (v: YamlData | undefined): v is { [key: string]: YamlData } => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What syntax-check would reject in one playbook, as messages. */
function playbookProblems(text: string): { problems: string[]; modules: string[] } {
  const problems: string[] = [];
  const modules: string[] = [];
  const doc = readYaml(text).documents[0];
  if (!Array.isArray(doc) || doc.length === 0) return { problems: ['not a list of plays'], modules };
  const tasks = (list: YamlData | undefined) => {
    for (const task of Array.isArray(list) ? list : []) {
      if (!isMap(task)) {
        problems.push('a task is not a mapping');
        continue;
      }
      const blocks = ['block', 'rescue', 'always'].filter((k) => k in task);
      if (blocks.length > 0) {
        for (const k of blocks) tasks(task[k]);
        continue;
      }
      const keys = Object.keys(task).filter((k) => !TASK_KEYWORDS.has(k));
      if (keys.length !== 1) problems.push(`task "${String(task['name'])}" has ${keys.length} module keys: ${keys.join(', ')}`);
      for (const key of keys) {
        if (key.split('.').length < 3) problems.push(`task "${String(task['name'])}" uses a short module name: ${key}`);
        modules.push(key);
      }
    }
  };
  for (const play of doc) {
    if (!isMap(play)) {
      problems.push('a play is not a mapping');
      continue;
    }
    if ('import_playbook' in play) continue;
    if (typeof play['hosts'] !== 'string' || play['hosts'] === '') problems.push('a play has no hosts');
    for (const section of ['pre_tasks', 'tasks', 'post_tasks', 'handlers']) tasks(play[section]);
  }
  return { problems, modules };
}

/** The collections requirements.yml lists, or a message saying why it is not the documented format. */
function requirements(text: string): { names: string[]; problems: string[] } {
  const doc = readYaml(text).documents[0];
  if (!isMap(doc) || !Array.isArray(doc['collections'])) return { names: [], problems: ['requirements.yml has no collections list'] };
  const problems: string[] = [];
  const names: string[] = [];
  for (const entry of doc['collections']) {
    if (!isMap(entry) || typeof entry['name'] !== 'string') {
      problems.push('a collection entry is not a mapping with a name');
      continue;
    }
    names.push(entry['name']);
    if ('version' in entry && typeof entry['version'] !== 'string') problems.push(`${entry['name']}: version is not a string`);
  }
  return { names, problems };
}

describe('every Ansible blueprint, as a project', () => {
  const all = ANSIBLE_BLUEPRINTS.flatMap((group) => group.blueprints.map((blueprint) => ({ group, blueprint })));

  it('parses, and every playbook is plays of fully qualified modules, for every option', () => {
    for (const { blueprint } of all) {
      for (const values of variants(blueprint)) {
        const files = blueprint.build(values, '').files;
        for (const [name, text] of Object.entries(files)) {
          if (!/\.ya?ml$/.test(name)) continue;
          let parsed = true;
          try {
            readYaml(text);
          } catch {
            parsed = false;
          }
          expect([blueprint.id, name, parsed]).toEqual([blueprint.id, name, true]);
          if (name === 'requirements.yml' || name.includes('/') || name === 'hosts.yml') continue;
          const { problems, modules } = playbookProblems(text);
          expect([blueprint.id, name, problems]).toEqual([blueprint.id, name, []]);
          // Every collection a task uses is in requirements.yml (ansible.builtin ships with ansible-core).
          const needed = [...new Set(modules.map((m) => m.split('.').slice(0, 2).join('.')).filter((c) => c !== 'ansible.builtin'))];
          const listed = requirements(files['requirements.yml'] ?? 'collections: []').names;
          for (const collection of needed) expect([blueprint.id, collection, listed.includes(collection)]).toEqual([blueprint.id, collection, true]);
        }
        if (files['requirements.yml']) expect([blueprint.id, requirements(files['requirements.yml']).problems]).toEqual([blueprint.id, []]);
      }
    }
  });

  it('ships ansible.cfg and the inventory it points at, beside every playbook', () => {
    for (const { blueprint } of all) {
      const files = blueprint.build(defaultValues(blueprint), '').files;
      if (Object.keys(files).length === 1 && files['hosts.yml']) continue; // the estate inventory is an inventory
      expect([blueprint.id, files['ansible.cfg']?.includes('inventory = inventory/hosts.yml')]).toEqual([blueprint.id, true]);
      const inventory = readYaml(files['inventory/hosts.yml'] ?? '').documents[0];
      expect([blueprint.id, isMap(inventory) && isMap(inventory['all'])]).toEqual([blueprint.id, true]);
      expect([blueprint.id, (files['README.md'] ?? '').includes('ansible-playbook')]).toEqual([blueprint.id, true]);
    }
  });

  it('runs an API play against localhost, which needs no inventory entry', () => {
    for (const { group, blueprint } of all) {
      if (!API_TARGETS.has(group.target)) continue;
      const files = blueprint.build(defaultValues(blueprint), '').files;
      for (const [name, text] of Object.entries(files)) {
        if (!/\.yml$/.test(name) || name === 'requirements.yml' || name.includes('/') || name === 'hosts.yml') continue;
        for (const m of text.matchAll(/^\s*-?\s*hosts:\s*(.+)$/gm)) expect([blueprint.id, m[1]?.trim()]).toEqual([blueprint.id, 'localhost']);
      }
    }
  });
});

describe('the inventory', () => {
  it('lists localhost only when an API play targets something other than localhost', () => {
    const local = readYaml(inventoryYaml({ api: false, windows: false, hosts: ['localhost'] })).documents[0] as { all: Record<string, YamlData> };
    expect(JSON.stringify(local.all)).not.toContain('localhost');
    const grouped = inventoryYaml({ api: true, windows: false, hosts: ['aws_api'] });
    expect(grouped).toContain('ansible_connection: local');
    expect(grouped).toContain('aws_api:');
  });

  it('gives a Windows group its WinRM settings', () => {
    const windows = inventoryYaml({ api: false, windows: true, hosts: ['all'] });
    expect(windows).toContain('windows:');
    expect(windows).toContain('ansible_connection: winrm');
  });

  it('keeps localhost out of a site that also manages hosts', () => {
    const lookup = (id: string) => ANSIBLE_BLUEPRINTS.flatMap((g) => g.blueprints).find((b) => b.id === id);
    const site = buildSite(
      [
        { id: 'a', blueprintId: 'vsphere_vm_add_disk', label: 'disk', values: {} },
        { id: 'b', blueprintId: 'linux_harden_ssh', label: 'ssh', values: {} },
      ],
      lookup,
    );
    expect(site.files['inventory/hosts.yml']).not.toContain('ansible_connection: local');
    expect(site.files['ansible.cfg']).toContain('inventory = inventory/hosts.yml');
  });
});
