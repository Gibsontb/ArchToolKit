/**
 * Joining migrated hosts to Active Directory: windows_ad_join and linux_ad_join.
 *
 * The join account and its password are vault variables
 * (vault_domain_join_user, vault_domain_join_password). Both roles check they
 * are set before anything else and stop with a message that names them; there
 * is no fallback value. Every task that passes them has no_log.
 */

import { SSSD_CONF } from '../templates/sssd.js';
import { CHECK_MODE_TOLERANT,                      } from './types.js';

const RH = "ansible_facts.os_family == 'RedHat'";
const DEB = "ansible_facts.os_family == 'Debian'";
const SUSE = "ansible_facts.os_family == 'Suse'";

/** An assert that the join credentials are in the vault. It shows the condition, never a value. */
export function assertVault(names                   , why        )       {
  return {
    name: `Check ${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} set`,
    'ansible.builtin.assert': {
      that: names.map((n) => `(${n} | default('') | string | length) > 0`),
      fail_msg: `Set ${names.join(' and ')} in an ansible-vault file (group_vars/all/vault.yml) ${why}.`,
      quiet: true,
    },
  };
}

const windowsTasks         = [
  assertVault(['vault_domain_join_user', 'vault_domain_join_password'], 'before joining the domain'),
  {
    name: 'Use the domain controllers for DNS',
    'ansible.windows.win_dns_client': { adapter_names: '*', dns_servers: '{{ windows_ad_join_dns_servers }}' },
    when: 'windows_ad_join_dns_servers | length > 0',
  },
  {
    name: 'Join the domain',
    'microsoft.ad.membership': {
      dns_domain_name: '{{ windows_ad_join_domain }}',
      domain_ou_path: "{{ windows_ad_join_ou | default(omit, true) }}",
      domain_admin_user: '{{ vault_domain_join_user }}',
      domain_admin_password: '{{ vault_domain_join_password }}',
      state: 'domain',
      reboot: true,
    },
    no_log: true,
  },
  {
    name: 'Use Kerberos with the domain account from here on',
    'ansible.builtin.set_fact': {
      ansible_winrm_transport: 'kerberos',
      ansible_user: '{{ vault_domain_join_user }}',
      ansible_password: '{{ vault_domain_join_password }}',
    },
    no_log: true,
    when: 'windows_ad_join_switch_to_kerberos | bool',
  },
];

export const WINDOWS_AD_JOIN       = {
  name: 'windows_ad_join',
  description: 'point DNS at the domain controllers and join the domain.',
  tasks: windowsTasks,
  defaults: {
    windows_ad_join_domain: '',
    windows_ad_join_ou: '',
    windows_ad_join_dns_servers: [],
    windows_ad_join_switch_to_kerberos: false,
  },
};

const linuxTasks         = [
  assertVault(['vault_domain_join_user', 'vault_domain_join_password'], 'before joining the domain'),
  {
    name: 'Install realmd, SSSD and adcli',
    'ansible.builtin.package': { name: '{{ linux_ad_join_packages[ansible_facts.os_family] }}', state: 'present' },
  },
  {
    name: 'Join the domain with realmd',
    'ansible.builtin.command': {
      argv: "{{ ['realm', 'join', '--membership-software=adcli', '--client-software=sssd', '-U', vault_domain_join_user] + (['--computer-ou=' ~ linux_ad_join_ou] if linux_ad_join_ou | length > 0 else []) + [linux_ad_join_domain] }}",
      stdin: '{{ vault_domain_join_password }}',
      creates: '/etc/sssd/sssd.conf',
    },
    no_log: true,
  },
  {
    name: 'Write sssd.conf', ...CHECK_MODE_TOLERANT,
    'ansible.builtin.template': { src: 'sssd.conf.j2', dest: '/etc/sssd/sssd.conf', owner: 'root', group: 'root', mode: '0600' },
    notify: 'Restart sssd',
  },
  {
    name: 'Use SSSD with home directories on first login (RHEL family)',
    'ansible.builtin.command': { argv: ['authselect', 'select', 'sssd', 'with-mkhomedir', '--force'] },
    register: 'linux_ad_join_authselect',
    changed_when: false,
    when: RH,
  },
  { name: 'Keep oddjobd running (RHEL family)', ...CHECK_MODE_TOLERANT, 'ansible.builtin.service': { name: 'oddjobd', state: 'started', enabled: true }, when: RH },
  {
    name: 'Create home directories on first login (Debian family)',
    'ansible.builtin.command': { argv: ['pam-auth-update', '--enable', 'mkhomedir'] },
    changed_when: false,
    when: DEB,
  },
  {
    name: 'Use SSSD with home directories on first login (SUSE)',
    'ansible.builtin.command': { argv: ['pam-config', '--add', '--sss', '--mkhomedir'] },
    changed_when: false,
    when: SUSE,
  },
  { name: 'Keep sssd running', ...CHECK_MODE_TOLERANT, 'ansible.builtin.service': { name: 'sssd', state: 'started', enabled: true } },
  {
    name: 'Give the admin group sudo',
    'ansible.builtin.copy': {
      content: "# Managed by Ansible (linux_ad_join)\n%{{ linux_ad_join_sudo_group | replace(' ', '\\\\ ') }} ALL=(ALL) ALL\n",
      dest: '/etc/sudoers.d/ad-admins',
      owner: 'root',
      group: 'root',
      mode: '0440',
      validate: '/usr/sbin/visudo -cf %s',
    },
    when: 'linux_ad_join_sudo_group | length > 0',
  },
];

export const LINUX_AD_JOIN       = {
  name: 'linux_ad_join',
  description: 'join Active Directory with realmd and SSSD, and give the admin group sudo.',
  tasks: linuxTasks,
  templates: { 'sssd.conf.j2': SSSD_CONF },
  handlers: [{ name: 'Restart sssd', 'ansible.builtin.service': { name: 'sssd', state: 'restarted' } }],
  defaults: {
    linux_ad_join_domain: '',
    linux_ad_join_ou: '',
    linux_ad_join_fully_qualified_names: false,
    linux_ad_join_gpo_access_control: 'permissive',
    linux_ad_join_sudo_group: 'linux-admins',
  },
  derived: {
    linux_ad_join_packages: {
      RedHat: ['realmd', 'sssd', 'adcli', 'oddjob', 'oddjob-mkhomedir', 'samba-common-tools', 'krb5-workstation', 'authselect'],
      Debian: ['realmd', 'sssd', 'sssd-ad', 'sssd-tools', 'adcli', 'packagekit', 'libnss-sss', 'libpam-sss'],
      Suse: ['realmd', 'sssd', 'sssd-ad', 'sssd-tools', 'adcli', 'krb5-client'],
    },
  },
};
