/**
 * Hand-written multi-task playbooks for the platforms the per-module
 * blueprints added (network devices, containers, databases, storage, private
 * clouds, operations) — the Ansible counterpart of the Terraform scenarios.
 *
 * A playbook blueprint returns its plays as plain objects; this renders them,
 * writes requirements.yml for every collection they use, pinned to the version
 * the module index was read from, and group_vars/all.yml for any variables
 * named in `vars` that the play needs supplied. withAnsibleProject adds
 * ansible.cfg, the inventory and the README around it, as for every playbook.
 */

                                                                                                         
                                                      
import { renderYaml,                } from '../yaml.js';
import { collectModules } from '../from-plays.js';
import { collectionVersion } from '../module-blueprints.js';

                                   
                      
                         
                               
                                                          
                         
                                             
                                                                                            
                                                        
     
                                                                              
                                                                
     
                                                                                            
                                                                        
                                                                                                 
                                                                     
 

function requirements(collections                   )                {
  const needed = collections.filter((c) => c !== 'ansible.builtin');
  if (needed.length === 0) return null;
  const entries = needed.map((name) => {
    const version = collectionVersion(name);
    const major = version ? Number(version.split('.')[0]) : NaN;
    return version && Number.isFinite(major) ? { name, version: `>=${version},<${major + 1}.0.0` } : { name };
  });
  return renderYaml({ collections: entries }             , {
    header: 'Collections this playbook needs.\n\nInstall with:  ansible-galaxy collection install -r requirements.yml',
  });
}

function groupVars(needs                                              )         {
  const lines = [
    '# Values the playbook needs and has no answer for yet. Ansible reads this file',
    '# for every host (and localhost) on its own; fill these in before a real run.',
    '# A vault_ value is a secret: put it in an ansible-vault encrypted file',
    '# (ansible-vault create group_vars/all/vault.yml), never here.',
    '---',
  ];
  for (const [name, description] of Object.entries(needs)) {
    if (description === undefined) continue;
    lines.push(`# ${description}`);
    lines.push(name.startsWith('vault_') ? `# ${name}: set in vault.yml, not here` : `${name}: ''`);
  }
  return `${lines.join('\n')}\n`;
}

export function playbookScenario(definition                  )            {
  return {
    id: definition.id,
    label: definition.label,
    group: definition.group,
    description: definition.description,
    inputs: definition.inputs,
    emits: [],
    build: (values                 , name        ) => {
      const v = values                  ;
      const plays = definition.plays(v);
      const file = `${(name || definition.id).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || definition.id}.yml`;
      const files                         = {
        [file]: renderYaml(plays, {
          header: `${definition.label}\n\nRun with:  ansible-playbook ${file} --check --diff\n\nCredentials belong in the environment or an ansible-vault file, never in\nthis playbook. Nothing here writes one.`,
        }),
      };
      const collections = [...new Set(collectModules(plays).map((m) => m.split('.').slice(0, 2).join('.')))].sort();
      const req = requirements(collections);
      if (req) files['requirements.yml'] = req;
      const needs = definition.needs?.(v) ?? {};
      if (Object.values(needs).some((d) => d !== undefined)) files['group_vars/all.yml'] = groupVars(needs);
      for (const [path, text] of Object.entries(definition.extraFiles?.(v) ?? {})) if (text !== undefined) files[path] = text;
      return { files, findings: definition.findings?.(v) ?? [] };
    },
  };
}

/** Comma- or newline-separated field as a list. */
export function items(value         )           {
  return String(value ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Lines of `name=value` as pairs. */
export function pairs(value         )                     {
  return String(value ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^([^=]+?)\s*=\s*(.*)$/.exec(l);
      return m ? [m[1]          , (m[2] ?? '').trim()] : [l, ''];
    });
}

export function on(value         )          {
  return value === true || value === 'true' || value === 'yes';
}

export const YES_NO_OPTIONS = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];
