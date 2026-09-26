/**
 * What every "From a migration plan" blueprint shares.
 *
 * Each is a playbookScenario whose play applies one role (or runs a few
 * tasks), with the role tree beside it as extra files. Around that this adds
 * what a role-based playbook needs and playbookScenario cannot see:
 *
 *   - requirements.yml from the modules the *roles* use as well as the play,
 *     pinned the same way, plus a `roles:` section for the ansible-lockdown
 *     CIS / STIG roles a hardened baseline includes;
 *   - the vault variables the play and roles read, listed in
 *     group_vars/all.yml as names to set in the vault (never values).
 *
 * The play's `vars` carry the blueprint's answers as `mig_<name>`; each role's
 * defaults turn those into the names it reads, so inventory (group_vars,
 * host_vars) overrides the blueprint per host. See migration/roles/types.ts.
 */

                                                                                                        
import { renderYaml,                } from '../../yaml.js';
import { collectModules } from '../../from-plays.js';
import { collectionVersion } from '../../module-blueprints.js';
import { HOSTS_INPUT } from '../common.js';
import { playbookScenario } from '../scenario.js';
import { roleFiles,                      } from '../../migration/roles/index.js';
                                                         

export const MIGRATION_GROUP = 'From a migration plan';

/** A role from GitHub, as requirements.yml `roles:` lists it. */
                                  
                        
                       
                           
 

                                        
                      
                         
                               
                                                                           
                                             
                                              
                                                          
                                                                                       
                                                                            
                                                       
                                                          
                                                                                                
                            
                                 
                                         
                                                                             
                                                                        
                                                                                            
                                                                
 

/**
 * The expression inside a value that is one `{{ … }}` (a site hoists shared
 * answers into group_vars and passes them on like that), else undefined.
 */
function expression(value         )                     {
  return /^\s*\{\{\s*(.+?)\s*\}\}\s*$/s.exec(String(value ?? ''))?.[1];
}

/**
 * Comma- or space-separated text as a list. A `{{ variable }}` holding such
 * text becomes the Jinja that splits it at run time.
 */
export function list(value         )                    {
  const expr = expression(value);
  if (expr) return `{{ (${expr} | string).replace(',', ' ').split() }}`;
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A list of port numbers from text; anything that is not one is dropped. */
export function ports(value         )                    {
  const expr = expression(value);
  if (expr) return `{{ (${expr} | string).replace(',', ' ').split() | map('int') | list }}`;
  return (list(value)            )
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
}

export function yes(value         )          {
  return value === true || value === 'true' || value === 'yes';
}

export function number(value         , fallback        )         {
  const n = Number(value);
  return Number.isFinite(n) && String(value ?? '').trim() !== '' ? n : fallback;
}

export function text(value         , fallback = '')         {
  const s = String(value ?? '').trim();
  return s === '' ? fallback : s;
}

export const TRUE_FALSE = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

export const FALSE_TRUE = [
  { value: 'false', label: 'No' },
  { value: 'true', label: 'Yes' },
];

export const PLATFORM_INPUT                 = {
  id: 'platform',
  label: 'Platform',
  control: 'select',
  options: [
    { value: 'aws', label: 'AWS' },
    { value: 'azure', label: 'Azure' },
    { value: 'google', label: 'Google Cloud (GCP)' },
    { value: 'oci', label: 'OCI' },
    { value: 'vmware', label: 'VMware (vSphere / VCF)' },
  ],
  default: 'aws',
  hint: "Used for hosts in no platform_<p> inventory group; a host's group wins",
};

export const BACKUP_TIER_INPUT                 = {
  id: 'backup_tier',
  label: 'Backup tier',
  control: 'select',
  options: [
    { value: 'gold', label: 'Gold' },
    { value: 'silver', label: 'Silver' },
    { value: 'bronze', label: 'Bronze' },
  ],
  default: 'silver',
};

export const HARDENING_INPUT                 = {
  id: 'hardening',
  label: 'Hardening',
  control: 'select',
  options: [
    { value: 'none', label: 'Baseline only' },
    { value: 'cis-l1', label: 'CIS Level 1 (ansible-lockdown)' },
    { value: 'cis-l2', label: 'CIS Level 2 (ansible-lockdown)' },
    { value: 'stig', label: 'DISA STIG (ansible-lockdown)' },
  ],
  default: 'none',
};

/** The branch the ansible-lockdown roles release from. */
export const LOCKDOWN_BRANCH = 'main';

export function lockdownRequirement(repo        , name        )                  {
  return { name, src: `https://github.com/ansible-lockdown/${repo}.git`, version: LOCKDOWN_BRANCH };
}

function pinned(collection        )                                     {
  const version = collectionVersion(collection);
  const major = version ? Number(version.split('.')[0]) : NaN;
  return version && Number.isFinite(major) ? { name: collection, version: `>=${version},<${major + 1}.0.0` } : { name: collection };
}

/** requirements.yml for these modules and roles; undefined when there is nothing to install. */
export function requirementsFor(modules                   , roles                            )                     {
  const collections = [...new Set(modules.map((m) => m.split('.').slice(0, 2).join('.')))].filter((c) => c !== 'ansible.builtin').sort();
  if (collections.length === 0 && roles.length === 0) return undefined;
  const doc                            = {};
  if (collections.length > 0) doc.collections = collections.map(pinned);
  if (roles.length > 0) doc.roles = roles.map((r) => ({ name: r.name, src: r.src, scm: 'git', version: r.version }));
  return renderYaml(doc, {
    header: [
      'Collections (and roles) this playbook needs.',
      '',
      'Install with:  ansible-galaxy install -r requirements.yml',
      '(that installs both sections; `ansible-galaxy collection install -r` only the collections).',
    ].join('\n'),
  });
}

/** Every vault_* name in a text. */
export function vaultNames(text        )           {
  return [...new Set([...text.matchAll(/\bvault_[A-Za-z0-9_]+/g)].map((m) => m[0]))].sort();
}

const VAULT_DESCRIPTIONS                                   = {
  vault_domain_join_user: 'AD account that joins computers to the domain (and creates the SQL gMSA and cluster)',
  vault_domain_join_password: 'its password',
  vault_domain_admin_user: 'AD account allowed to promote domain controllers (Domain Admins)',
  vault_domain_admin_password: 'its password',
  vault_dsrm_password: 'Directory Services Restore Mode password for new domain controllers',
  vault_oracle_sys_password: 'Oracle SYS password',
  vault_oracle_system_password: 'Oracle SYSTEM password',
  vault_oracle_pdbadmin_password: 'Oracle PDB admin password',
  vault_mssql_sa_password: 'SQL Server sa password',
  vault_mssql_service_password: 'SQL Server service account password (domain accounts only; not used with gMSA)',
  vault_cluster_witness_storage_key: 'Azure storage account key for the cluster cloud witness',
  vault_postgres_password: 'PostgreSQL admin role password',
  vault_postgres_replication_password: 'PostgreSQL replication role password',
  vault_mysql_root_password: 'MySQL root password',
  vault_rhsm_activation_key: 'Red Hat activation key (BYOS registration)',
  vault_suse_regcode: 'SUSE Customer Center registration code (BYOS)',
  vault_splunk_uf_admin_password: 'Splunk Universal Forwarder admin password',
};

/** The one play every migration blueprint writes. */
function play(def                       , v                )            {
  const roles = def.roles?.(v) ?? [];
  const tasks = def.tasks?.(v) ?? [];
  const body                            = {
    name: def.label,
    hosts: text(v.hosts, 'all'),
    gather_facts: def.gatherFacts ?? true,
    ...(def.become ? { become: true } : {}),
    ...(def.play?.(v) ?? {}),
  };
  const vars = def.vars(v);
  if (Object.keys(vars).length > 0) body.vars = vars             ;
  if (roles.length > 0) body.roles = roles.map((r) => ({ role: r.name }));
  if (tasks.length > 0) body.tasks = tasks                        ;
  return [body];
}

export function migrationBlueprint(def                       )            {
  const scenario = playbookScenario({
    id: def.id,
    label: def.label,
    description: def.description,
    group: MIGRATION_GROUP,
    inputs: [HOSTS_INPUT, ...def.inputs],
    plays: (v) => play(def, v),
    extraFiles: (v) => {
      const out                                     = {};
      for (const role of def.roles?.(v) ?? []) Object.assign(out, roleFiles(role));
      Object.assign(out, def.extraFiles?.(v) ?? {});
      return out;
    },
    needs: (v) => {
      const roles = def.roles?.(v) ?? [];
      const texts = [JSON.stringify(play(def, v)), ...roles.map((r) => JSON.stringify(r))];
      const names = vaultNames(texts.join('\n'));
      return Object.fromEntries(names.map((n) => [n, VAULT_DESCRIPTIONS[n] ?? 'a secret this playbook reads']));
    },
    ...(def.findings ? { findings: def.findings } : {}),
  });
  return {
    ...scenario,
    build: (values, name)              => {
      const built = scenario.build(values, name);
      const v = values                  ;
      const roles = def.roles?.(v) ?? [];
      const modules = collectModules([play(def, v), ...roles.map((r) => [...r.tasks, ...(r.handlers ?? [])])]                        );
      const requirements = requirementsFor(modules, def.lockdown?.(v) ?? []);
      const files                         = { ...built.files };
      if (requirements) files['requirements.yml'] = requirements;
      else delete files['requirements.yml'];
      return { ...built, files };
    },
  };
}
