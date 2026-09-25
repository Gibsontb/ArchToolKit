/**
 * Generic Linux hosts Ansible blueprints.
 *
 * Ported from the previous toolkit's SCENARIO_DEFS — the inputs and the play
 * structures are the originals, unchanged. What is new around them: the plays
 * are rendered by this toolkit's own YAML writer, a requirements.yml is derived
 * from the modules each play actually uses, and every module name is checked
 * against the committed Galaxy catalog.
 */

import type { Blueprint, BlueprintGroup, BlueprintValues, TemplateValues } from '../../kit/blueprint.ts';
import { str } from '../../kit/blueprint.ts';
import { playbookFiles } from '../from-plays.ts';
import { AWS_REGIONS, AZURE_LOCATIONS, GCP_REGIONS, GCP_ZONES, BOOL_OPTIONS } from './regions.ts';
import { HOSTS_INPUT } from './common.ts';

/**
 * The cron module's timing options for a schedule string. A five-field cron
 * string is split into minute/hour/day/month/weekday; a nickname such as
 * @daily or @reboot maps to special_time, which the module accepts instead.
 */
const CRON_SPECIAL_TIMES = ['annually', 'daily', 'hourly', 'monthly', 'reboot', 'weekly', 'yearly'];
function cronTiming(schedule: string): Record<string, string> {
  const nickname = schedule.trim().replace(/^@/, '');
  if (schedule.trim().startsWith('@') && CRON_SPECIAL_TIMES.includes(nickname)) {
    return { special_time: nickname };
  }
  return {
    minute: "{{ schedule.split()[0] }}",
    hour: "{{ schedule.split()[1] }}",
    day: "{{ schedule.split()[2] }}",
    month: "{{ schedule.split()[3] }}",
    weekday: "{{ schedule.split()[4] }}"
  };
}

const BLUEPRINTS: readonly Blueprint[] = [
  {
    id: 'nginx_server',
    label: 'Web – NGINX server',
    description: 'Install NGINX, enable service, and deploy a simple index page.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "http_port",
              label: "HTTP port",
              control: 'number',
              default: "80",
              hint: "e.g. 80, 8080"
            },
            {
              id: "index_message",
              label: "Index page message",
              control: 'text',
              default: "Hello from Ansible",
              hint: "Simple banner text"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Configure NGINX web server",
                hosts,
                become: true,
                vars: {
                  index_message: vals.index_message
                },
                tasks: [
                  {
                    name: "Install NGINX",
                    "ansible.builtin.package": {
                      name: "nginx",
                      state: "present"
                    }
                  },
                  {
                    name: "Ensure NGINX running and enabled",
                    "ansible.builtin.service": {
                      name: "nginx",
                      state: "started",
                      enabled: true
                    }
                  },
                  {
                    name: "Deploy index page",
                    "ansible.builtin.copy": {
                      dest: "/usr/share/nginx/html/index.html",
                      mode: "0644",
                      content: "<html><body><h1>{{ index_message }}</h1></body></html>"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Web – NGINX server',
      ),
  },
  {
    id: 'linux_patch',
    label: 'Ops – Security updates',
    description: 'Run package updates and reboot if required.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "reboot_if_needed",
              label: "Reboot if kernel updated",
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
                name: "Apply Linux security updates",
                hosts,
                become: true,
                vars: {
                  reboot_if_needed: vals.reboot_if_needed === "true"
                },
                tasks: [
                  {
                    name: "Update packages to latest",
                    "ansible.builtin.package": {
                      name: "*",
                      state: "latest"
                    }
                  },
                  {
                    name: "Check if reboot is required (Debian/Ubuntu)",
                    "ansible.builtin.stat": {
                      path: "/var/run/reboot-required"
                    },
                    register: "reboot_required_file",
                    when: "ansible_os_family == 'Debian'"
                  },
                  {
                    name: "Reboot if needed",
                    "ansible.builtin.reboot": {},
                    when: "reboot_if_needed and reboot_required_file.stat.exists | default(false)"
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Ops – Security updates',
      ),
  },
  {
    id: 'linux_users',
    label: 'Identity – Users & groups',
    description: 'Manage local users, groups and SSH keys.',
    inputs: [
    HOSTS_INPUT,

            { id: "group_name", label: "Group name", control: 'text', default: "appusers", hint: "Primary group" },
            { id: "username", label: "User name", control: 'text', default: "deploy", hint: "Login user" },
            {
              id: "shell",
              label: "Shell",
              control: 'select',
              options: [
                { value: "/bin/bash", label: "/bin/bash" },
                { value: "/bin/zsh", label: "/bin/zsh" },
                { value: "/bin/sh", label: "/bin/sh" }
              ],
              default: "/bin/bash",
              hint: "Default shell"
            },
            { id: "ssh_pubkey", label: "SSH public key", control: 'text', default: "ssh-ed25519 AAAA...", hint: "User key" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create Linux users & groups",
                hosts,
                become: true,
                vars: {
                  group_name: vals.group_name,
                  username: vals.username,
                  user_shell: vals.shell,
                  ssh_pubkey: vals.ssh_pubkey
                },
                tasks: [
                  {
                    name: "Ensure group exists",
                    "ansible.builtin.group": {
                      name: "{{ group_name }}",
                      state: "present"
                    }
                  },
                  {
                    name: "Ensure user exists",
                    "ansible.builtin.user": {
                      name: "{{ username }}",
                      group: "{{ group_name }}",
                      shell: "{{ user_shell }}",
                      create_home: true
                    }
                  },
                  {
                    name: "Install authorized key",
                    "ansible.posix.authorized_key": {
                      user: "{{ username }}",
                      state: "present",
                      key: "{{ ssh_pubkey }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Identity – Users & groups',
      ),
  },
  {
    id: 'linux_cron_backup',
    label: 'Ops – Cron job (backup script)',
    description: 'Install a cron job to run a backup script on a schedule.',
    inputs: [
    HOSTS_INPUT,

            { id: "user", label: "Run as user", control: 'text', default: "root", hint: "User for cron" },
            { id: "job_name", label: "Job name", control: 'text', default: "nightly-backup", hint: "Identifier" },
            { id: "schedule", label: "Cron schedule", control: 'text', default: "0 2 * * *", hint: "Standard cron string" },
            { id: "command", label: "Command", control: 'text', default: "/usr/local/bin/backup.sh", hint: "Script or command" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Configure backup cron job",
                hosts,
                become: true,
                vars: {
                  cron_user: vals.user,
                  job_name: vals.job_name,
                  schedule: vals.schedule,
                  command: vals.command
                },
                tasks: [
                  {
                    name: "Install cron job",
                    "ansible.builtin.cron": {
                      user: "{{ cron_user }}",
                      name: "{{ job_name }}",
                      job: "{{ command }}",
                      state: "present",
                      ...cronTiming(str(values, 'schedule', '0 2 * * *'))
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Ops – Cron job (backup script)',
      ),
  },
  {
    id: 'linux_harden_ssh',
    label: 'Security – Harden SSH',
    description: 'Apply basic SSH hardening to sshd_config.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "allow_password_auth",
              label: "Allow password auth",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "false",
              hint: "Prefer false for security"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Harden SSH configuration",
                hosts,
                become: true,
                vars: {
                  allow_password_auth: vals.allow_password_auth === "true"
                },
                tasks: [
                  {
                    name: "Ensure SSHD config present",
                    "ansible.builtin.lineinfile": {
                      path: "/etc/ssh/sshd_config",
                      regexp: "^PasswordAuthentication",
                      line: "PasswordAuthentication {{ 'yes' if allow_password_auth else 'no' }}",
                      backup: true
                    }
                  },
                  {
                    name: "Disable root login via SSH",
                    "ansible.builtin.lineinfile": {
                      path: "/etc/ssh/sshd_config",
                      regexp: "^PermitRootLogin",
                      line: "PermitRootLogin prohibit-password",
                      backup: true
                    }
                  },
                  {
                    name: "Restart SSH service",
                    "ansible.builtin.service": {
                      name: "ssh",
                      state: "restarted"
                    },
                    when: "ansible_service_mgr != 'systemd' or ansible_os_family != 'RedHat'"
                  },
                  {
                    name: "Restart sshd service",
                    "ansible.builtin.service": {
                      name: "sshd",
                      state: "restarted"
                    },
                    when: "ansible_service_mgr == 'systemd' and ansible_os_family == 'RedHat'"
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Security – Harden SSH',
      ),
  },
];

export const LINUX_ANSIBLE: BlueprintGroup = {
  target: 'linux',
  label: 'Generic Linux hosts',
  blueprints: BLUEPRINTS,
};
