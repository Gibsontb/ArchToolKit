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

                                                                                                        
                                                         
                                               
import { collectModules } from '../../from-plays.js';
import { HOSTS_INPUT } from '../common.js';
import { playbookScenario } from '../scenario.js';
import { requirementsFor, text, vaultNames } from '../migration/common.js';
import { roleFiles,                      } from '../../migration/roles/types.js';

export const APP_GROUP = 'From an application plan';

                                      
                      
                         
                               
                                                    
                          
                                                              
                                                                      
                              
                                             
                                                                                          
                                                         
                                                 
                                                                            
                                                                                
                            
                                                                          
                                                                  
                                                                                              
                                                     
     
                                                                             
                                                                            
                                          
     
                                                                                        
                                                                
 

function play(def                     , v                )            {
  const body                            = {
    name: def.label,
    hosts: text(v.hosts, def.hosts.default),
    gather_facts: true,
    ...(def.become ? { become: true } : {}),
  };
  const vars = def.vars(v);
  if (Object.keys(vars).length > 0) body.vars = vars             ;
  body.roles = def.roles(v).map((r) => ({ role: r.name }));
  return [body];
}

export function patternBlueprint(def                     )            {
  const hostsInput                 = { ...HOSTS_INPUT, default: def.hosts.default, hint: def.hosts.hint };
  const vaultsOf = (v                )           => {
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
      const out                         = {};
      for (const role of def.roles(v)) Object.assign(out, roleFiles(role));
      return out;
    },
    needs: (v) => Object.fromEntries(vaultsOf(v).map((n) => [n, def.vaults?.[n] ?? 'a secret this playbook reads'])),
    ...(def.findings ? { findings: def.findings } : {}),
  });
  return {
    ...scenario,
    build: (values, name)              => {
      const built = scenario.build(values, name);
      const v = values                  ;
      const roles = def.roles(v);
      const modules = collectModules([play(def, v), ...roles.map((r) => [...r.tasks, ...(r.handlers ?? [])])]                        );
      // A collection role counts as a "module" of its collection here: requirementsFor only reads the collection part.
      const requirements = requirementsFor([...modules, ...(def.collections?.(v) ?? []).map((c) => `${c}.role`)], []);
      const files                         = { ...built.files };
      if (requirements) files['requirements.yml'] = requirements;
      else delete files['requirements.yml'];
      return { ...built, files };
    },
  };
}

/** Fails early, naming the vault variables that are not set. Their names sit in `that`, which passes no value. */
export function assertVault(names                   , why        , when                             )       {
  return {
    name: `Check ${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} set`,
    'ansible.builtin.assert': {
      that: names.map((n) => `(${n} | default('') | string | length) > 0`),
      fail_msg: `Set ${names.join(' and ')} in an ansible-vault file (group_vars/all/vault.yml) ${why}.`,
      quiet: true,
    },
    ...(when ? { when: when              } : {}),
  };
}

/** Run a Windows task as the domain account in the vault (become runas); the task logs nothing. */
export const AS_DOMAIN_ADMIN = {
  become: true,
  become_method: 'ansible.builtin.runas',
  become_user: '{{ vault_domain_admin_user }}',
  vars: { ansible_become_password: '{{ vault_domain_admin_password }}' },
  no_log: true,
}         ;

export const LINUX = "ansible_facts.os_family != 'Windows'";
export const WINDOWS = "ansible_facts.os_family == 'Windows'";

/** A select input. */
export function select(id        , label        , options                                        , def        , extra                          = {})                 {
  return { id, label, control: 'select', options: options.map(([value, l]) => ({ value, label: l })), default: def, ...extra };
}

export const YES_NO                                         = [
  ['true', 'Yes'],
  ['false', 'No'],
];
