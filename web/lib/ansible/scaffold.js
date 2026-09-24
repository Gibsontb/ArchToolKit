/**
 * Starter Ansible for any target this kit knows.
 *
 * Every Ansible repository begins with the same four things — the collections
 * it needs, a configuration file, an inventory, and somewhere for secrets that
 * is not the playbook — and getting them wrong is tedious to discover later.
 * This generates that spine, which is the part of a repository that genuinely
 * is the same everywhere.
 *
 * It deliberately stops short of generating cloud tasks from a template. The
 * collections carry nearly four thousand modules whose arguments change between
 * major versions, and emitting plausible-looking tasks that nobody has checked
 * would produce playbooks that fail on the first run, or worse, succeed and
 * build the wrong thing. Where this kit does emit tasks, the module name is
 * checked against the catalog and the arguments are the caller's own.
 */

import { info, warning,              } from '../core/findings.js';
import { renderYaml,                } from './yaml.js';
import {
  COLLECTIONS,
  collectionsForTarget,
  installable,
                     
                      
} from './collections.js';
import { emitPlaybook,           } from './playbook.js';

                                         
                                             
                                
     
                                                                            
                                                                            
                                                                   
     
                                         
                                                                              
                              
 

                                        
                                                   
                                        
 

/**
 * Which collections a target pulls in.
 *
 * VMware is the awkward one: three collections cover the same platform, and
 * which of them belongs in a repository is a decision rather than a lookup.
 */
function collectionsFor(
  targets                          ,
  includeLegacyVmware         ,
)                            {
  const picked                   = [];
  for (const target of targets) {
    for (const collection of collectionsForTarget(target)) {
      if (collection.builtin) continue;
      if (collection.name === 'community.vmware' && !includeLegacyVmware) continue;
      picked.push(collection);
    }
  }
  return installable(picked.map((c) => c.name));
}

function requirementsYml(collections                           )         {
  return renderYaml(
    {
      collections: collections.map((c) => ({ name: c.name, version: c.version })),
    },
    {
      header: [
        'Collections this repository needs.',
        '',
        'Install with:  ansible-galaxy collection install -r requirements.yml',
        '',
        'Versions are pinned to the major line that was current when this was',
        'generated. A major bump renames and removes modules, so raise it',
        'deliberately rather than by widening the constraint.',
      ].join('\n'),
    },
  );
}

/**
 * ansible.cfg.
 *
 * Two settings are worth arguing about, so both are stated rather than left to
 * the default:
 *
 *  - host_key_checking stays on. Turning it off is the most copied line in
 *    Ansible and it removes the only protection against connecting to the wrong
 *    host. Populate known_hosts instead.
 *  - The yaml callback makes multi-line output readable, which matters most
 *    when something has failed.
 */
function ansibleCfg(projectName        )         {
  return [
    `; ${projectName}`,
    ';',
    '; Settings are stated rather than left to the default so that changing one is',
    '; a decision someone made, not a default someone inherited.',
    '',
    '[defaults]',
    'inventory = inventory/',
    'roles_path = roles',
    'collections_path = collections',
    'stdout_callback = yaml',
    'callbacks_enabled = profile_tasks',
    '',
    '; Left on deliberately. Disabling it is the usual shortcut around an',
    '; unknown host key, and it removes the only check that the host answering',
    '; is the host that was meant. Populate known_hosts instead.',
    'host_key_checking = True',
    '',
    '; A key written twice in the same YAML mapping is a silent overwrite by',
    '; default, and the one that wins is the last. Fail on it instead.',
    'duplicate_dict_key = error',
    '',
    '[inventory]',
    '; A typo in an inventory file is otherwise skipped in silence.',
    'unparsed_is_failed = True',
    '',
    '[ssh_connection]',
    'pipelining = True',
    '',
  ].join('\n');
}

/**
 * A starting inventory.
 *
 * Cloud and VMware work runs from the control node against an API, so it lives
 * in a `local` group with an explicit local connection; anything that manages
 * hosts directly gets a group of its own to fill in. Both are written, because
 * a repository nearly always ends up with both.
 */
function inventoryYml(targets                          )         {
  const apiOnly = targets.some((t) => t === 'aws' || t === 'azure' || t === 'google' || t === 'oci' || t === 'vmware');
  const managesHosts = targets.some((t) => t === 'posix' || t === 'windows');

  const groups                            = {};

  if (apiOnly) {
    groups.local = {
      hosts: {
        localhost: {
          ansible_connection: 'local',
          // Otherwise Ansible uses whatever python is on PATH for the remote,
          // which for localhost means it may not be the one the collections
          // were installed into.
          ansible_python_interpreter: '{{ ansible_playbook_python }}',
        },
      },
    };
  }

  if (managesHosts) {
    if (targets.includes('posix')) {
      groups.linux = { hosts: {}, vars: { ansible_user: 'CHANGE-ME' } };
    }
    if (targets.includes('windows')) {
      groups.windows = {
        hosts: {},
        vars: {
          ansible_connection: 'winrm',
          ansible_winrm_transport: 'kerberos',
          ansible_port: 5986,
          ansible_user: 'CHANGE-ME',
          // Named, not set: the value belongs in the vault file.
          ansible_password: '{{ vault_windows_password }}',
        },
      };
    }
  }

  return renderYaml(
    { all: { children: groups } },
    {
      header: [
        'Static inventory.',
        '',
        'Cloud and vSphere work runs from the control node against an API, so it',
        'targets localhost with a local connection. Hosts that Ansible manages',
        'directly go in their own group.',
        '',
        'For a large or changing estate, replace this with a dynamic inventory',
        'plugin from the relevant collection rather than generating host lists.',
      ].join('\n'),
    },
  );
}

function vaultTemplate(collections                           )         {
  const lines = [
    '# Secrets for this repository — ENCRYPT THIS FILE BEFORE COMMITTING IT.',
    '#',
    '#   ansible-vault encrypt group_vars/all/vault.yml',
    '#',
    '# Reference these from playbooks as {{ vault_... }}. Nothing here should',
    '# ever appear in a task, an inventory file, or a commit in plain text.',
    '---',
  ];
  for (const collection of collections) {
    lines.push(`# ${collection.label}: ${collection.credentials}`);
  }
  lines.push(
    '',
    '# vault_vcenter_password: ""',
    '# vault_windows_password: ""',
    '',
  );
  return lines.join('\n');
}

function gitignore()         {
  return [
    '# Ansible',
    '*.retry',
    'collections/',
    'roles/*/',
    '!roles/*/tasks/',
    '',
    '# Anything that carries credentials',
    '*.key',
    '*.pem',
    '*.p12',
    '.vault_pass',
    'oci_api_key*',
    'gcp-service-account*.json',
    '',
    '# An unencrypted vault file is the failure this whole layout exists to',
    '# prevent. Encrypt it, then remove this line to commit it.',
    'group_vars/all/vault.yml',
    '',
  ].join('\n');
}

export function scaffoldAnsible(options                        )                        {
  const findings            = [];
  const targets = [...new Set(options.targets)];
  const projectName = options.projectName ?? 'Ansible configuration';

  if (targets.length === 0) {
    return {
      files: {},
      findings: [
        warning('ansible.scaffold.no-targets', 'No platform was selected, so nothing was generated.', {
          remediation: `Choose one or more of: ${[...new Set(COLLECTIONS.map((c) => c.target))].join(', ')}.`,
        }),
      ],
    };
  }

  const collections = collectionsFor(targets, options.includeLegacyVmware === true);

  const files                         = {
    'requirements.yml': requirementsYml(collections),
    'ansible.cfg': ansibleCfg(projectName),
    'inventory/hosts.yml': inventoryYml(targets),
    'group_vars/all/vault.yml': vaultTemplate(collections),
    '.gitignore': gitignore(),
  };

  if (options.starterPlay) {
    const out = emitPlaybook([options.starterPlay], {
      header: `${projectName}\n\nRun with:  ansible-playbook -i inventory site.yml --check --diff`,
    });
    files['site.yml'] = out.yaml;
    findings.push(...out.findings);
  }

  for (const collection of collections) {
    findings.push(
      info(
        'ansible.scaffold.collection',
        `${collection.label}: ${collection.name} ${collection.version} (Galaxy showed ${collection.observedVersion}).`,
        { source: 'Ansible Galaxy' },
      ),
    );
    if (collection.requires) {
      findings.push(
        info(
          'ansible.scaffold.control-node-requirement',
          `${collection.name} needs ${collection.requires}`,
          {
            remediation: 'Install it on the control node; Ansible will not do it for you.',
            source: 'Collection documentation',
          },
        ),
      );
    }
    if (collection.note) {
      findings.push(
        info('ansible.scaffold.collection-note', `${collection.name}: ${collection.note}`, {
          source: 'ArchToolKit',
        }),
      );
    }
  }

  const vmwareCollections = collections.filter((c) => c.target === 'vmware');
  if (vmwareCollections.length > 1) {
    findings.push(
      warning(
        'ansible.scaffold.overlapping-vmware-collections',
        `${vmwareCollections.map((c) => c.name).join(' and ')} both cover vSphere, so two module names exist for the same job.`,
        {
          remediation:
            'Prefer vmware.vmware, and reach for the others only where it has no equivalent.',
          source: 'ArchToolKit',
        },
      ),
    );
  }

  findings.push(
    warning(
      'ansible.scaffold.vault-not-encrypted',
      'group_vars/all/vault.yml is written in plain text and is gitignored until it is encrypted.',
      {
        remediation: 'Run ansible-vault encrypt group_vars/all/vault.yml, then commit it.',
        source: 'ArchToolKit',
      },
    ),
  );

  findings.push(
    info(
      'ansible.scaffold.tasks-not-generated',
      'This is the repository spine: collections, configuration, inventory and a vault. Task bodies are emitted only where the module name has been checked against the catalog.',
      { source: 'ArchToolKit' },
    ),
  );

  return { files, findings };
}
