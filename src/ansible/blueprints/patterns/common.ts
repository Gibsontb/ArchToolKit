/**
 * What every "From an application plan" Ansible blueprint shares (addendum
 * A.4.10), and mig_source_tools, the post-cutover migration play (A.3.5).
 *
 * The same shape as the migration blueprints (../migration/common.ts): one
 * play that applies one role, the role written as data under roles/<name>/,
 * the play's vars carrying the answers as `mig_<name>` which the role's
 * defaults turn into the names it reads (so group_vars and host_vars override
 * the blueprint per host), requirements.yml pinned from the modules used, and
 * the vault variables listed in group_vars/all.yml by name only.
 *
 * What it adds:
 *   - the picker group (application plan, or the migration group);
 *   - a hosts input with its own default (a sensible group, not always `all`);
 *   - collections whose *roles* the play includes (community.sap_install):
 *     requirements.yml lists them, unpinned when the module catalog has no
 *     version for them, since an invented pin is worse than none;
 *   - the vault variables described for the person who fills them in, and
 *     only those the answers need (a role written for three providers lists
 *     the one provider's secrets).
 */

import type { Blueprint, BlueprintInput, BuildResult, TemplateValues } from '../../../kit/blueprint.ts';
import type { Finding } from '../../../core/findings.ts';
import type { YamlValue } from '../../yaml.ts';
import { collectModules } from '../../from-plays.ts';
import { HOSTS_INPUT } from '../common.ts';
import { playbookScenario } from '../scenario.ts';
import { requirementsFor, text, vaultNames } from '../migration/common.ts';
import { roleFiles, type Role, type Task } from '../../migration/roles/types.ts';

export const APP_GROUP = 'From an application plan';

export interface PatternBlueprintDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The picker heading; APP_GROUP when omitted. */
  readonly group?: string;
  /** The hosts input's default pattern, and a hint for it. */
  readonly hosts: { readonly default: string; readonly hint: string };
  /** Inputs after `hosts`. */
  readonly inputs: readonly BlueprintInput[];
  /** The roles the play applies, in order. Each is the same data whatever the answers. */
  readonly roles: (v: TemplateValues) => readonly Role[];
  /** Play vars: the answers, as `mig_<name>`. */
  readonly vars: (v: TemplateValues) => Readonly<Record<string, YamlValue>>;
  /** Linux-only plays become root; Windows plays leave it to the connection. */
  readonly become?: boolean;
  /** Collections the play uses through their roles, not their modules. */
  readonly collections?: (v: TemplateValues) => readonly string[];
  /** vault_* name → what it is. Names the roles read that are not here get a generic line. */
  readonly vaults?: Readonly<Record<string, string>>;
  /**
   * The vault names these answers need, out of all the roles mention; all of
   * them when omitted. Only names read by a template alone can be left out:
   * a name a task reads is always listed.
   */
  readonly vaultsFor?: (v: TemplateValues, all: readonly string[]) => readonly string[];
  readonly findings?: (v: TemplateValues) => readonly Finding[];
}

function play(def: PatternBlueprintDef, v: TemplateValues): YamlValue {
  const body: Record<string, YamlValue> = {
    name: def.label,
    hosts: text(v.hosts, def.hosts.default),
    gather_facts: true,
    ...(def.become ? { become: true } : {}),
  };
  const vars = def.vars(v);
  if (Object.keys(vars).length > 0) body.vars = vars as YamlValue;
  body.roles = def.roles(v).map((r) => ({ role: r.name }));
  return [body];
}

export function patternBlueprint(def: PatternBlueprintDef): Blueprint {
  const hostsInput: BlueprintInput = { ...HOSTS_INPUT, default: def.hosts.default, hint: def.hosts.hint };
  const vaultsOf = (v: TemplateValues): string[] => {
    const roles = def.roles(v);
    const all = vaultNames([JSON.stringify(play(def, v)), ...roles.map((r) => JSON.stringify(r))].join('\n'));
    // A name a task, handler or default reads is always listed; only a name that a template alone reads can be left out.
    const inTasks = new Set(vaultNames([JSON.stringify(play(def, v)), ...roles.map((r) => JSON.stringify([r.tasks, r.handlers ?? [], r.defaults ?? {}, r.derived ?? {}]))].join('\n')));
    const wanted = def.vaultsFor ? new Set(def.vaultsFor(v, all)) : new Set(all);
    return all.filter((n) => inTasks.has(n) || wanted.has(n));
  };
  const scenario = playbookScenario({
    id: def.id,
    label: def.label,
    description: def.description,
    group: def.group ?? APP_GROUP,
    inputs: [hostsInput, ...def.inputs],
    plays: (v) => play(def, v),
    extraFiles: (v) => {
      const out: Record<string, string> = {};
      for (const role of def.roles(v)) Object.assign(out, roleFiles(role));
      return out;
    },
    needs: (v) => Object.fromEntries(vaultsOf(v).map((n) => [n, def.vaults?.[n] ?? 'a secret this playbook reads'])),
    ...(def.findings ? { findings: def.findings } : {}),
  });
  return {
    ...scenario,
    build: (values, name): BuildResult => {
      const built = scenario.build(values, name);
      const v = values as TemplateValues;
      const roles = def.roles(v);
      const modules = collectModules([play(def, v), ...roles.map((r) => [...r.tasks, ...(r.handlers ?? [])])] as unknown as YamlValue);
      // A collection role counts as a "module" of its collection here: requirementsFor only reads the collection part.
      const requirements = requirementsFor([...modules, ...(def.collections?.(v) ?? []).map((c) => `${c}.role`)], []);
      const files: Record<string, string> = { ...built.files };
      if (requirements) files['requirements.yml'] = requirements;
      else delete files['requirements.yml'];
      return { ...built, files };
    },
  };
}

/** Fails early, naming the vault variables that are not set. Their names sit in `that`, which passes no value. */
export function assertVault(names: readonly string[], why: string, when?: string | readonly string[]): Task {
  return {
    name: `Check ${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} set`,
    'ansible.builtin.assert': {
      that: names.map((n) => `(${n} | default('') | string | length) > 0`),
      fail_msg: `Set ${names.join(' and ')} in an ansible-vault file (group_vars/all/vault.yml) ${why}.`,
      quiet: true,
    },
    ...(when ? { when: when as YamlValue } : {}),
  };
}

/** Run a Windows task as the domain account in the vault (become runas); the task logs nothing. */
export const AS_DOMAIN_ADMIN = {
  become: true,
  become_method: 'ansible.builtin.runas',
  become_user: '{{ vault_domain_admin_user }}',
  vars: { ansible_become_password: '{{ vault_domain_admin_password }}' },
  no_log: true,
} as const;

export const LINUX = "ansible_facts.os_family != 'Windows'";
export const WINDOWS = "ansible_facts.os_family == 'Windows'";

/** A select input. */
export function select(id: string, label: string, options: readonly (readonly [string, string])[], def: string, extra: Partial<BlueprintInput> = {}): BlueprintInput {
  return { id, label, control: 'select', options: options.map(([value, l]) => ({ value, label: l })), default: def, ...extra };
}

export const YES_NO: readonly (readonly [string, string])[] = [
  ['true', 'Yes'],
  ['false', 'No'],
];
