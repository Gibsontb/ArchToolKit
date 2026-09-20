/**
 * Generic Windows hosts Ansible blueprints.
 *
 * Ported from the previous toolkit's SCENARIO_DEFS — the inputs and the play
 * structures are the originals, unchanged. What is new around them: the plays
 * are rendered by this toolkit's own YAML writer, a requirements.yml is derived
 * from the modules each play actually uses, and every module name is checked
 * against the committed Galaxy catalog.
 */

                                                                                                         
import { str } from '../../kit/blueprint.js';
import { playbookFiles } from '../from-plays.js';
import { AWS_REGIONS, AZURE_LOCATIONS, GCP_REGIONS, GCP_ZONES, BOOL_OPTIONS } from './regions.js';
import { HOSTS_INPUT } from './common.js';

const BLUEPRINTS                       = [
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
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
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
                    name: "Join domain",
                    "microsoft.ad.membership": {
                      dns_domain_name: "{{ domain_name }}",
                      domain_admin_user: "{{ domain_user }}",
                      domain_admin_password: "{{ domain_join_password | default('CHANGEME') }}",
                      domain_ou_path: "{{ ou_path }}",
                      state: "domain"
                    },
                    register: "domain_state"
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
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
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
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
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
            { id: "password", label: "Password", control: 'text', default: "CHANGE_ME!", hint: "Use vault/secret in real life" },
            {
              id: "group",
              label: "Primary group",
              control: 'text',
              default: "Users",
              hint: "e.g. Administrators, Users"
            }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Manage local Windows user",
                hosts,
                gather_facts: false,
                vars: {
                  username: vals.username,
                  password: vals.password,
                  group: vals.group
                },
                tasks: [
                  {
                    name: "Ensure user exists",
                    "ansible.windows.win_user": {
                      name: "{{ username }}",
                      password: "{{ password }}",
                      groups: "{{ group }}",
                      state: "present"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Identity – Local user',
      ),
  },
];

export const WINDOWS_ANSIBLE                 = {
  target: 'windows',
  label: 'Generic Windows hosts',
  blueprints: BLUEPRINTS,
};
