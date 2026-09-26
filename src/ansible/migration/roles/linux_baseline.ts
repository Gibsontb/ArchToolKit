/**
 * linux_baseline: the first thing every migrated or rebuilt Linux host gets.
 *
 * One role for the three families the plan knows: RHEL and its rebuilds
 * (RHEL, Oracle Linux, Rocky, AlmaLinux: os_family RedHat), Debian and
 * Ubuntu (Debian), and SLES (Suse). What differs per family is chosen from
 * the host's facts, so one play covers a mixed group.
 *
 * Hardening beyond the baseline is the ansible-lockdown CIS / STIG role for
 * the host's release, installed from requirements.yml (roles:) and included
 * when the plan asks for cis-l1, cis-l2 or stig. The lockdown roles select
 * level 1 or level 2 with their own tags (level1-server, level2-server), so a
 * cis-l1 run adds --skip-tags level2-server; the blueprint says so.
 */

import { CHRONY_CONF } from '../templates/chrony.ts';
import { CHECK_MODE_TOLERANT, CLOUD_PLATFORM, type Role, type Task } from './types.ts';

const RH = "ansible_facts.os_family == 'RedHat'";
const DEB = "ansible_facts.os_family == 'Debian'";
const SUSE = "ansible_facts.os_family == 'Suse'";

/** Lockdown role (as named in requirements.yml) per baseline and release key. */
export const LOCKDOWN_LINUX: Readonly<Record<'cis' | 'stig', Readonly<Record<string, { readonly name: string; readonly repo: string }>>>> = {
  cis: {
    rhel8: { name: 'rhel8_cis', repo: 'RHEL8-CIS' },
    rhel9: { name: 'rhel9_cis', repo: 'RHEL9-CIS' },
    rhel10: { name: 'rhel10_cis', repo: 'RHEL10-CIS' },
    ubuntu22: { name: 'ubuntu22_cis', repo: 'UBUNTU22-CIS' },
    ubuntu24: { name: 'ubuntu24_cis', repo: 'UBUNTU24-CIS' },
    debian11: { name: 'debian11_cis', repo: 'DEBIAN11-CIS' },
    debian12: { name: 'debian12_cis', repo: 'DEBIAN12-CIS' },
    debian13: { name: 'debian13_cis', repo: 'DEBIAN13-CIS' },
    sles15: { name: 'suse15_cis', repo: 'SUSE15-CIS' },
  },
  stig: {
    rhel8: { name: 'rhel8_stig', repo: 'RHEL8-STIG' },
    rhel9: { name: 'rhel9_stig', repo: 'RHEL9-STIG' },
    rhel10: { name: 'rhel10_stig', repo: 'RHEL10-STIG' },
    ubuntu22: { name: 'ubuntu22_stig', repo: 'UBUNTU22-STIG' },
    ubuntu24: { name: 'ubuntu24_stig', repo: 'UBUNTU24-STIG' },
  },
};

const lockdownMap = (kind: 'cis' | 'stig'): Record<string, string> =>
  Object.fromEntries(Object.entries(LOCKDOWN_LINUX[kind]).map(([key, r]) => [key, r.name]));

const SSHD_DROPIN = `# Managed by Ansible (linux_baseline). Read before the other drop-ins, so these win.
PermitRootLogin no
PasswordAuthentication {{ 'yes' if linux_baseline_ssh_password_auth | bool else 'no' }}
KbdInteractiveAuthentication no
X11Forwarding no
MaxAuthTries 4
LoginGraceTime 60
ClientAliveInterval 300
ClientAliveCountMax 3
`;

const tasks: Task[] = [
  {
    name: 'Check the family is one this role knows',
    'ansible.builtin.assert': {
      that: ["ansible_facts.os_family in ['RedHat', 'Debian', 'Suse']"],
      fail_msg: 'linux_baseline covers RHEL, Oracle Linux, Rocky, AlmaLinux, Ubuntu, Debian and SLES; this host is {{ ansible_facts.distribution }}.',
      quiet: true,
    },
  },
  {
    name: 'Set the hostname',
    'ansible.builtin.hostname': { name: "{{ linux_baseline_hostname if linux_baseline_hostname | length > 0 else inventory_hostname_short }}", use: 'systemd' },
    // An inventory keyed by address would otherwise name the host "10".
    when: "linux_baseline_hostname | length > 0 or (inventory_hostname is not match('^[0-9.]+$') and ':' not in inventory_hostname)",
  },
  { name: 'Set the time zone', 'community.general.timezone': { name: '{{ linux_baseline_timezone }}' } },
  { name: 'Install chrony', 'ansible.builtin.package': { name: 'chrony', state: 'present' } },
  {
    name: "Point chrony at the platform's time source",
    'ansible.builtin.template': { src: 'chrony.conf.j2', dest: '{{ linux_baseline_chrony_conf }}', owner: 'root', group: 'root', mode: '0644' },
    notify: 'Restart chrony',
  },
  { name: 'Keep chrony running', ...CHECK_MODE_TOLERANT, 'ansible.builtin.service': { name: '{{ linux_baseline_chrony_service }}', state: 'started', enabled: true } },
  {
    name: 'Update packages (RHEL family)',
    'ansible.builtin.dnf': { name: '*', state: 'latest', update_only: true },
    when: [RH, 'linux_baseline_update_packages | bool'],
  },
  {
    name: 'Update packages (Debian family)',
    'ansible.builtin.apt': { upgrade: 'safe', update_cache: true, cache_valid_time: 3600 },
    when: [DEB, 'linux_baseline_update_packages | bool'],
  },
  {
    name: 'Update packages (SUSE)',
    'community.general.zypper': { name: '*', state: 'latest' },
    when: [SUSE, 'linux_baseline_update_packages | bool'],
  },
  { name: 'Install needs-restarting (RHEL family)', 'ansible.builtin.dnf': { name: 'dnf-utils', state: 'present' }, when: RH },
  {
    name: 'Ask whether a reboot is needed (RHEL family)',
    'ansible.builtin.command': { argv: ['needs-restarting', '-r'] },
    register: 'linux_baseline_needs_restarting',
    changed_when: false,
    check_mode: false,
    failed_when: 'linux_baseline_needs_restarting.rc not in [0, 1]',
    when: RH,
  },
  {
    name: 'Ask whether a reboot is needed (Debian family)',
    'ansible.builtin.stat': { path: '/var/run/reboot-required' },
    register: 'linux_baseline_reboot_required',
    when: DEB,
  },
  {
    name: 'Ask whether a reboot is needed (SUSE)',
    'ansible.builtin.command': { argv: ['zypper', 'needs-rebooting'] },
    register: 'linux_baseline_zypper_reboot',
    changed_when: false,
    check_mode: false,
    failed_when: 'linux_baseline_zypper_reboot.rc not in [0, 102]',
    when: SUSE,
  },
  {
    name: 'Reboot when the updates need it',
    'ansible.builtin.reboot': { reboot_timeout: 1200 },
    when: [
      'linux_baseline_reboot | bool',
      `(${RH} and linux_baseline_needs_restarting.rc | default(0) == 1) or (${DEB} and linux_baseline_reboot_required.stat.exists | default(false)) or (${SUSE} and linux_baseline_zypper_reboot.rc | default(0) == 102)`,
    ],
  },
  {
    name: 'Enforce SELinux (RHEL family)',
    'ansible.posix.selinux': { policy: 'targeted', state: 'enforcing' },
    when: [RH, 'linux_baseline_selinux | bool'],
  },
  {
    name: 'Install firewalld (RHEL family and SUSE)',
    'ansible.builtin.package': { name: 'firewalld', state: 'present' },
    when: `${RH} or ${SUSE}`,
  },
  {
    name: 'Keep firewalld running', ...CHECK_MODE_TOLERANT,
    'ansible.builtin.service': { name: 'firewalld', state: 'started', enabled: true },
    when: `${RH} or ${SUSE}`,
  },
  {
    name: "Open the host's ports in firewalld (IPv4 and IPv6)", ...CHECK_MODE_TOLERANT,
    'ansible.posix.firewalld': { port: '{{ item }}/tcp', permanent: true, immediate: true, state: 'enabled' },
    loop: '{{ linux_baseline_tcp_ports }}',
    when: `${RH} or ${SUSE}`,
  },
  { name: 'Install ufw (Debian family)', 'ansible.builtin.apt': { name: 'ufw', state: 'present' }, when: DEB },
  {
    name: "Open the host's ports in ufw (IPv4 and IPv6)", ...CHECK_MODE_TOLERANT,
    'community.general.ufw': { rule: 'allow', port: '{{ item }}', proto: 'tcp' },
    loop: '{{ linux_baseline_tcp_ports }}',
    when: DEB,
  },
  {
    name: 'Deny other inbound traffic and turn ufw on', ...CHECK_MODE_TOLERANT,
    'community.general.ufw': { state: 'enabled', direction: 'incoming', default: 'deny' },
    when: DEB,
  },
  { name: 'Create the sshd drop-in directory', 'ansible.builtin.file': { path: '/etc/ssh/sshd_config.d', state: 'directory', owner: 'root', group: 'root', mode: '0755' } },
  {
    name: 'Read sshd drop-ins first',
    'ansible.builtin.lineinfile': {
      path: '/etc/ssh/sshd_config',
      regexp: '^Include /etc/ssh/sshd_config\\.d/\\*\\.conf',
      line: 'Include /etc/ssh/sshd_config.d/*.conf',
      insertbefore: 'BOF',
      validate: '/usr/sbin/sshd -t -f %s',
    },
    notify: 'Restart sshd',
  },
  {
    name: 'Harden sshd',
    'ansible.builtin.copy': { content: SSHD_DROPIN, dest: '/etc/ssh/sshd_config.d/00-baseline.conf', owner: 'root', group: 'root', mode: '0600' },
    notify: 'Restart sshd',
  },
  { name: 'Install auditd', 'ansible.builtin.package': { name: "{{ 'auditd' if ansible_facts.os_family == 'Debian' else 'audit' }}", state: 'present' } },
  { name: 'Keep auditd running', ...CHECK_MODE_TOLERANT, 'ansible.builtin.service': { name: 'auditd', state: 'started', enabled: true } },
  { name: 'Create the persistent journal directory', 'ansible.builtin.file': { path: '/var/log/journal', state: 'directory', owner: 'root', group: 'systemd-journal', mode: '2755' } },
  {
    name: 'Keep the journal across reboots',
    'ansible.builtin.lineinfile': { path: '/etc/systemd/journald.conf', regexp: '^#?Storage=', line: 'Storage=persistent' },
    notify: 'Restart journald',
  },
  {
    name: 'Kernel network hardening',
    'ansible.posix.sysctl': { name: '{{ item.key }}', value: '{{ item.value }}', sysctl_file: '/etc/sysctl.d/60-baseline.conf', reload: true, state: 'present' },
    loop: '{{ linux_baseline_sysctl | dict2items }}',
  },
  {
    name: 'Register RHEL with an activation key (BYOS)',
    'community.general.redhat_subscription': { activationkey: '{{ vault_rhsm_activation_key }}', org_id: '{{ linux_baseline_rhsm_org_id }}', state: 'present' },
    no_log: true,
    when: ["ansible_facts.distribution == 'RedHat'", "linux_baseline_licence == 'byos'"],
  },
  {
    name: 'List the enabled repositories (RHEL pay-as-you-go)',
    'ansible.builtin.command': { argv: ['dnf', '-q', 'repolist', '--enabled'] },
    register: 'linux_baseline_repos',
    changed_when: false,
    check_mode: false,
    when: ["ansible_facts.distribution == 'RedHat'", "linux_baseline_licence == 'li'", "cloud_platform != 'vmware'"],
  },
  {
    name: 'Say when RHEL has no cloud update repository',
    'ansible.builtin.debug': {
      msg: "No RHUI repository is enabled. A replicated pay-as-you-go RHEL VM needs the cloud's RHUI client package (or the licence conversion the replication tool offers) before it can update.",
    },
    when: ["linux_baseline_repos.stdout is defined", "'rhui' not in linux_baseline_repos.stdout | lower"],
  },
  {
    name: 'Register SLES with SUSE Customer Center (BYOS)',
    'ansible.builtin.command': { argv: ['SUSEConnect', '--regcode', '{{ vault_suse_regcode }}'], creates: '/etc/zypp/credentials.d/SCCcredentials' },
    no_log: true,
    when: [SUSE, "linux_baseline_licence == 'byos'"],
  },
  {
    name: 'Apply the CIS or STIG lockdown role for this release',
    'ansible.builtin.include_role': { name: '{{ linux_baseline_lockdown[linux_baseline_os_key] }}' },
    when: ["linux_baseline_hardening != 'none'", 'linux_baseline_os_key in linux_baseline_lockdown'],
  },
  {
    name: 'Say when no lockdown role covers this release',
    'ansible.builtin.debug': { msg: 'No ansible-lockdown {{ linux_baseline_hardening }} role covers {{ linux_baseline_os_key }}; only the baseline above was applied.' },
    when: ["linux_baseline_hardening != 'none'", 'linux_baseline_os_key not in linux_baseline_lockdown'],
  },
];

const handlers: Task[] = [
  { name: 'Restart chrony', 'ansible.builtin.service': { name: '{{ linux_baseline_chrony_service }}', state: 'restarted' } },
  { name: 'Restart sshd', 'ansible.builtin.service': { name: "{{ 'ssh' if ansible_facts.os_family == 'Debian' else 'sshd' }}", state: 'restarted' } },
  { name: 'Restart journald', 'ansible.builtin.service': { name: 'systemd-journald', state: 'restarted' } },
];

export const LINUX_BASELINE: Role = {
  name: 'linux_baseline',
  description: 'time, updates, SELinux, host firewall, sshd, auditd, journald, sysctl, registration and CIS/STIG.',
  tasks,
  handlers,
  defaults: {
    linux_baseline_hostname: '',
    linux_baseline_timezone: 'UTC',
    linux_baseline_ntp_servers: [],
    linux_baseline_update_packages: true,
    linux_baseline_reboot: true,
    linux_baseline_selinux: true,
    linux_baseline_allowed_tcp_ports: [22],
    linux_baseline_ssh_password_auth: false,
    linux_baseline_licence: 'li',
    linux_baseline_rhsm_org_id: '',
    linux_baseline_hardening: 'none',
  },
  derived: {
    cloud_platform: CLOUD_PLATFORM,
    linux_baseline_tcp_ports: '{{ ([22] + linux_baseline_allowed_tcp_ports | map(\'int\') | list) | unique }}',
    linux_baseline_chrony_conf: "{{ '/etc/chrony/chrony.conf' if ansible_facts.os_family == 'Debian' else '/etc/chrony.conf' }}",
    linux_baseline_chrony_service: "{{ 'chrony' if ansible_facts.os_family == 'Debian' else 'chronyd' }}",
    linux_baseline_os_key:
      "{{ ('rhel' if ansible_facts.os_family == 'RedHat' else 'sles' if ansible_facts.os_family == 'Suse' else ansible_facts.distribution | lower) ~ ansible_facts.distribution_major_version }}",
    linux_baseline_lockdown: "{{ linux_baseline_lockdown_roles[linux_baseline_hardening] | default({}) }}",
    linux_baseline_lockdown_roles: { 'cis-l1': lockdownMap('cis'), 'cis-l2': lockdownMap('cis'), stig: lockdownMap('stig') },
    linux_baseline_sysctl: {
      'net.ipv4.conf.all.accept_redirects': '0',
      'net.ipv4.conf.default.accept_redirects': '0',
      'net.ipv6.conf.all.accept_redirects': '0',
      'net.ipv6.conf.default.accept_redirects': '0',
      'net.ipv4.conf.all.send_redirects': '0',
      'net.ipv4.conf.default.send_redirects': '0',
      'net.ipv4.conf.all.accept_source_route': '0',
      'net.ipv6.conf.all.accept_source_route': '0',
      'net.ipv4.conf.all.log_martians': '1',
      'net.ipv4.icmp_echo_ignore_broadcasts': '1',
      'net.ipv4.tcp_syncookies': '1',
      'kernel.randomize_va_space': '2',
    },
  },
  templates: { 'chrony.conf.j2': CHRONY_CONF },
};
