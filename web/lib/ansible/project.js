/**
 * What a playbook needs beside it to run as unzipped.
 *
 * A blueprint writes the playbook and its requirements.yml. On their own those
 * pass `ansible-playbook --syntax-check`, but they do not run: the header says
 * `-i inventory` and there is no inventory, and a play against `hosts: all`
 * with no inventory matches nothing — Ansible's implicit localhost is not part
 * of `all` — so a cloud play would "succeed" having done nothing at all.
 *
 * So every playbook result is completed into the layout Ansible documents for a
 * project (docs.ansible.com, "Sample Ansible setup"):
 *
 *   ansible.cfg           points at the inventory, so `-i` is optional
 *   inventory/hosts.yml   localhost with a local connection for API work;
 *                         the group the play names, to fill in, for hosts
 *   requirements.yml      (the blueprint's) collections, `collections: - name/version`
 *   <playbook>.yml        (the blueprint's)
 *   README.md             the three commands, in order
 *
 * An inventory-only result (the estate inventory) is already an inventory and
 * is left alone.
 */

                                                                                  
import { derive } from '../kit/blueprint.js';

/** Collections whose modules call an API from the control node rather than managing a host. */
export const API_COLLECTIONS = /^(amazon\.aws|community\.aws|azure\.azcollection|google\.cloud|oracle\.oci|community\.vmware|vmware\.vmware|vmware\.vmware_rest)$/;
export const WINDOWS_COLLECTIONS = /^(ansible\.windows|community\.windows|microsoft\.ad|chocolatey\.chocolatey)$/;
const API_TARGETS = new Set(['aws', 'azure', 'google', 'oci', 'vsphere', 'vmware']);

/** The collection names a requirements.yml lists. */
export function requiredCollections(requirements                    )           {
  return [...(requirements ?? '').matchAll(/^\s*-\s*name:\s*['"]?([A-Za-z0-9_]+\.[A-Za-z0-9_]+)/gm)].map((m) => m[1]          );
}

/** The `hosts:` patterns the plays in a playbook name, without templated ones. */
export function playHosts(playbook        )           {
  return [...playbook.matchAll(/^\s*-?\s*hosts:\s*(.+)$/gm)]
    .map((m) => (m[1]          ).trim().replace(/^["']|["']$/g, ''))
    .filter((h) => h !== '' && !h.includes('{{'));
}

                                 
     
                                                                                
                                                                                
                                                                           
                                                                               
                                                                           
                                               
     
                        
                                                                                    
                            
                                      
                                    
 

/** Group names a host pattern like `web:&prod:!old` refers to. */
function groupsIn(pattern        )           {
  return pattern
    .split(/[:,]/)
    .map((p) => p.trim().replace(/^[!&]/, ''))
    .filter((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p) && p !== 'all' && p !== 'localhost' && p !== 'ungrouped');
}

/**
 * A starting inventory for these plays, as YAML.
 *
 * API work: localhost, local connection, the playbook's own Python so the
 * collections' SDKs are found — and every group a play names contains it too,
 * so `hosts: aws_api` works as well as `hosts: all`.
 * Host work: each named group (or `linux` / `windows` for `hosts: all`), empty,
 * with the connection settings the group needs.
 */
export function inventoryYaml(needs                )         {
  const groups = [...new Set(needs.hosts.flatMap(groupsIn))];
  const lines = [
    '---',
    '# Starting inventory, ansible.cfg points at it, so',
    '# `ansible-playbook <playbook>.yml` uses it without -i.',
  ];
  if (needs.api) {
    lines.push(
      '#',
      '# API work runs on the control node. The play targets a group rather than',
      '# localhost, so localhost is listed here, with a local connection and',
      '# the Python ansible-playbook itself runs on, which is where the collection',
      "# SDKs (boto3, azure-*, google-auth, oci, pyvmomi…) have to be installed.",
      '',
      'all:',
      '  hosts:',
      '    localhost:',
      '      ansible_connection: local',
      "      ansible_python_interpreter: '{{ ansible_playbook_python }}'",
    );
    if (groups.length > 0) {
      lines.push('  children:');
      for (const g of groups) lines.push(`    ${g}:`, '      hosts:', '        localhost: {}');
    }
    return `${lines.join('\n')}\n`;
  }

  if (groups.length === 0 && needs.hosts.length > 0 && needs.hosts.every((h) => h === 'localhost')) {
    lines.push(
      '#',
      '# The play targets localhost, which Ansible provides without an inventory',
      '# entry (local connection, the Python ansible-playbook runs on). Hosts that',
      '# a later play manages directly go under a group here.',
      '',
      'all:',
      '  children: {}',
    );
    return `${lines.join('\n')}\n`;
  }

  const hostGroups = groups.length > 0 ? groups : [needs.windows ? 'windows' : 'linux'];
  lines.push(
    '#',
    '# Put the hosts to manage under the group, one per line:',
    '#   web01.example.com:',
    '#     ansible_host: 10.0.0.21',
    '',
    'all:',
    '  children:',
  );
  for (const g of hostGroups) {
    lines.push(`    ${g}:`, '      hosts: {}');
    if (needs.windows) {
      lines.push(
        '      vars:',
        '        ansible_connection: winrm',
        '        ansible_port: 5986',
        '        ansible_winrm_transport: kerberos',
        '        ansible_winrm_server_cert_validation: validate',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export const ANSIBLE_CFG = [
  '# Ansible reads this when it is run from this',
  '# directory (and the directory is not world-writable).',
  '',
  '[defaults]',
  'inventory = inventory/hosts.yml',
  '# Left on: it is the only check that the host answering is the one meant.',
  'host_key_checking = True',
  '',
  '[inventory]',
  '# A mistake in the inventory fails the run instead of being skipped.',
  'unparsed_is_failed = True',
  '',
].join('\n');

function readme(playbooks                   , apiPlay         , hasRequirements         )         {
  const first = playbooks[0] ?? 'playbook.yml';
  return [
    '# Ansible project',
    '',
    'Unzip, then run from inside the directory (ansible.cfg sets the inventory).',
    '',
    '```sh',
    ...(hasRequirements ? ['ansible-galaxy collection install -r requirements.yml'] : []),
    ...playbooks.map((p) => `ansible-playbook ${p} --syntax-check`),
    `ansible-playbook ${first} --check --diff   # dry run`,
    `ansible-playbook ${first}                  # for real`,
    '```',
    '',
    apiPlay
      ? 'The play calls an API from this machine (localhost). Install the Python SDK the collection needs into the Python ansible-playbook uses, and supply credentials through the environment or ansible-vault.'
      : 'Add the hosts to manage to `inventory/hosts.yml` first; until then the play matches no hosts and does nothing.',
    '',
    '| File | What it is |',
    '| --- | --- |',
    '| ansible.cfg | points Ansible at the inventory |',
    '| inventory/hosts.yml | the inventory |',
    ...(hasRequirements ? ['| requirements.yml | the collections to install |'] : []),
    ...playbooks.map((p) => `| ${p} | playbook |`),
    '',
  ].join('\n');
}

/** Complete a single playbook result into a runnable project. */
export function asAnsibleProject(result             , target        )              {
  const names = Object.keys(result.files);
  const playbooks = names.filter((n) => /\.ya?ml$/i.test(n) && !n.includes('/') && n !== 'requirements.yml' && n !== 'hosts.yml');
  if (playbooks.length === 0) return result;
  if (names.some((n) => n.startsWith('inventory/') || n === 'hosts.yml' || n === 'ansible.cfg')) return result;

  const collections = requiredCollections(result.files['requirements.yml']);
  const text = playbooks.map((p) => result.files[p] ?? '').join('\n');
  const hosts = playHosts(text);
  const apiPlay = API_TARGETS.has(target) || collections.some((c) => API_COLLECTIONS.test(c));
  const needs                 = {
    api: apiPlay && hosts.some((h) => h !== 'localhost'),
    windows: target === 'windows' || collections.some((c) => WINDOWS_COLLECTIONS.test(c)),
    hosts,
  };

  return {
    ...result,
    files: {
      ...result.files,
      'ansible.cfg': ANSIBLE_CFG,
      'inventory/hosts.yml': inventoryYaml(needs),
      ...(result.files['README.md'] === undefined ? { 'README.md': readme(playbooks, apiPlay, collections.length > 0) } : {}),
    },
  };
}

/**
 * API plays default to `hosts: localhost`.
 *
 * The shared input defaulted to `all`, which for a play that only calls an API
 * means either no hosts (no inventory) or every managed host running the API
 * calls (an inventory with hosts in it). `localhost` is what the Ansible cloud
 * guides use, and it runs with no inventory at all.
 */
export function withAnsibleProject(blueprint           , target        )            {
  // derive(), not a spread: a per-module blueprint's inputs arrive when it loads.
  return derive(blueprint, {
    ...(API_TARGETS.has(target)
      ? { mapInputs: (inputs) => inputs.map((input) => (input.id === 'hosts' && input.default === 'all' ? { ...input, default: 'localhost' } : input)) }
      : {}),
    build: (values, name) => asAnsibleProject(blueprint.build(values, name), target),
  });
}

export function withAnsibleProjectAll(groups                           )                            {
  return groups.map((group) => ({ ...group, blueprints: group.blueprints.map((b) => withAnsibleProject(b, group.target)) }));
}
