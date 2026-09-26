/**
 * Generic Windows hosts Ansible blueprints.
 *
 * Ported from the previous toolkit's SCENARIO_DEFS — the inputs and the play
 * structures are the originals, except that no credential is written: join_domain
 * and windows_local_user read vault variables, with no_log. What is new around them: the plays
 * are rendered by this toolkit's own YAML writer, a requirements.yml is derived
 * from the modules each play actually uses, and every module name is checked
 * against the committed Galaxy catalog.
 */

import type { Blueprint, BlueprintGroup, BlueprintValues, TemplateValues } from '../../kit/blueprint.ts';
import { str } from '../../kit/blueprint.ts';
import { playbookFiles } from '../from-plays.ts';
import { AWS_REGIONS, AZURE_LOCATIONS, GCP_REGIONS, GCP_ZONES, BOOL_OPTIONS } from './regions.ts';
import { HOSTS_INPUT } from './common.ts';

const BLUEPRINTS: readonly Blueprint[] = [
  {
    id: 'join_domain',
    label: 'Identity – Join to AD domain',
    description: 'Join a Windows host to an Active Directory domain using win_domain_membership.',
    inputs: [
    HOSTS_INPUT,

            { id: "domain_name", label: "Domain name", control: 'text', default: "corp.example.com", hint: "FQDN" },
            { id: "ou_path", label: "OU path (optional)", control: 'text', default: "OU=Servers,DC=corp,DC=example,DC=com", hint: "Can be blank" },
            { id: "domain_user", label: "Domain join user (UPN)", control: 'text', default: "ansible-join@corp.example.com", hint: "UPN format" },
            {
              id: "reboot_after",
              label: "Reboot after join",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "true",
              hint: "true / false"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Join Windows servers to domain",
                hosts,
                gather_facts: false,
                vars: {
                  domain_name: vals.domain_name,
                  ou_path: vals.ou_path,
                  domain_user: vals.domain_user,
                  reboot_after: vals.reboot_after === "true"
                },
                tasks: [
                  {
                    // No fallback: without the vaulted password the join stops here, saying why.
                    name: "Check the join password is in the vault",
                    "ansible.builtin.assert": {
                      that: ["(vault_domain_join_password | default('') | string | length) > 0"],
                      fail_msg: "Set vault_domain_join_password in an ansible-vault file (group_vars/all/vault.yml) before joining the domain.",
                      quiet: true
                    }
                  },
                  {
                    name: "Join domain",
                    "microsoft.ad.membership": {
                      dns_domain_name: "{{ domain_name }}",
                      domain_admin_user: "{{ domain_user }}",
                      domain_admin_password: "{{ vault_domain_join_password }}",
                      domain_ou_path: "{{ ou_path | default(omit, true) }}",
                      state: "domain"
                    },
                    register: "domain_state",
                    no_log: true
                  },
                  {
                    name: "Reboot if domain join changed and reboot_after is true",
                    "ansible.windows.win_reboot": {},
                    when: "reboot_after and domain_state.reboot_required"
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Identity – Join to AD domain',
      ),
  },
  {
    id: 'install_iis',
    label: 'Web – IIS server',
    description: 'Enable IIS role and deploy a simple default page.',
    inputs: [
    HOSTS_INPUT,

            { id: "site_name", label: "Site name", control: 'text', default: "Default Web Site", hint: "IIS site" },
            { id: "index_message", label: "Index page message", control: 'text', default: "Hello from Ansible on IIS", hint: "HTML content heading" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Install IIS",
                hosts,
                gather_facts: false,
                vars: {
                  index_message: vals.index_message
                },
                tasks: [
                  {
                    name: "Install IIS role",
                    "ansible.windows.win_feature": {
                      name: "Web-Server",
                      state: "present",
                      include_management_tools: true
                    }
                  },
                  {
                    name: "Ensure IIS service running",
                    "ansible.windows.win_service": {
                      name: "W3SVC",
                      state: "started",
                      start_mode: "auto"
                    }
                  },
                  {
                    name: "Deploy default page",
                    "ansible.windows.win_copy": {
                      dest: "C:\\inetpub\\wwwroot\\index.html",
                      content: "<html><body><h1>{{ index_message }}</h1></body></html>"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Web – IIS server',
      ),
  },
  {
    id: 'windows_updates',
    label: 'Ops – Windows Updates',
    description: 'Apply Windows Updates with optional reboot.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "category_names",
              label: "Update categories (comma-separated)",
              control: 'text',
              default: "SecurityUpdates,CriticalUpdates",
              hint: "Use ALL for everything"
            },
            {
              id: "reboot_if_needed",
              label: "Reboot if required",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "true",
              hint: "true / false"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Apply Windows Updates",
                hosts,
                gather_facts: false,
                vars: {
                  categories_raw: vals.category_names,
                  reboot_if_needed: vals.reboot_if_needed === "true"
                },
                tasks: [
                  {
                    name: "Install updates",
                    "ansible.windows.win_updates": {
                      category_names: "{{ categories_raw.split(',') if categories_raw != 'ALL' else [] }}",
                      state: "installed"
                    },
                    register: "update_result"
                  },
                  {
                    name: "Reboot if required and allowed",
                    "ansible.windows.win_reboot": {},
                    when: "reboot_if_needed and update_result.reboot_required"
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Ops – Windows Updates',
      ),
  },
  {
    id: 'windows_local_user',
    label: 'Identity – Local user',
    description: 'Create or update a local Windows user.',
    inputs: [
    HOSTS_INPUT,

            { id: "username", label: "Username", control: 'text', default: "svc_ansible", hint: "Local account" },
            {
              id: "password_var",
              label: "Password (vault variable)",
              control: 'text',
              default: "vault_windows_local_user_password",
              hint: "The name of the ansible-vault variable that holds it, not the password"
            },
            {
              id: "group",
              label: "Primary group",
              control: 'text',
              default: "Users",
              hint: "e.g. Administrators, Users"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => {
      // Only a variable name is accepted; the password itself lives in the vault.
      const raw = str(values, 'password_var', 'vault_windows_local_user_password').replace(/^\{\{\s*|\s*\}\}$/g, '');
      const passwordVar = /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) ? raw : 'vault_windows_local_user_password';
      const built = playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Manage local Windows user",
                hosts,
                gather_facts: false,
                vars: {
                  username: vals.username,
                  group: vals.group
                },
                tasks: [
                  {
                    name: `Check ${passwordVar} is set`,
                    "ansible.builtin.assert": {
                      that: [`(${passwordVar} | default('') | string | length) > 0`],
                      fail_msg: `Set ${passwordVar} in an ansible-vault file (group_vars/all/vault.yml).`,
                      quiet: true
                    }
                  },
                  {
                    name: "Ensure user exists",
                    "ansible.windows.win_user": {
                      name: "{{ username }}",
                      password: `{{ ${passwordVar} }}`,
                      groups: "{{ group }}",
                      state: "present"
                    },
                    no_log: true
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Identity – Local user',
      );
      return {
        ...built,
        files: {
          ...built.files,
          // What the playbook needs and this file must not hold: the vault variable, by name.
          'group_vars/all.yml': [
            '# Values the playbook needs and has no answer for yet.',
            '# A vault_ value is a secret: put it in an ansible-vault encrypted file',
            '# (ansible-vault create group_vars/all/vault.yml), never here.',
            '---',
            "# The local user's password",
            `# ${passwordVar}: set in vault.yml, not here`,
            '',
          ].join('\n'),
        },
      };
    },
  },
];

export const WINDOWS_ANSIBLE: BlueprintGroup = {
  target: 'windows',
  label: 'Generic Windows hosts',
  blueprints: BLUEPRINTS,
};
