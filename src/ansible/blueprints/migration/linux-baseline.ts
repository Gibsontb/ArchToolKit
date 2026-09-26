/**
 * mig_linux_baseline: the linux_baseline role over every migrated Linux host.
 */

import { info } from '../../../core/findings.ts';
import { LINUX_BASELINE, LOCKDOWN_LINUX } from '../../migration/roles/index.ts';
import { FALSE_TRUE, HARDENING_INPUT, list, lockdownRequirement, migrationBlueprint, PLATFORM_INPUT, ports, text, TRUE_FALSE, yes } from './common.ts';

export const MIG_LINUX_BASELINE = migrationBlueprint({
  id: 'mig_linux_baseline',
  label: 'Migration – Linux baseline',
  description:
    "Time from the platform's own source, package updates with a reboot when needed, SELinux, the host firewall, sshd, auditd, a persistent journal, kernel hardening, RHEL/SLES registration, and CIS or STIG through ansible-lockdown. RHEL, Oracle Linux, Rocky, AlmaLinux, Ubuntu, Debian and SLES.",
  inputs: [
    PLATFORM_INPUT,
    { id: 'timezone', label: 'Time zone', control: 'text', default: 'UTC', hint: 'IANA name, e.g. Europe/London' },
    { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '', hint: 'Space or comma separated; the site NTP on vmware, extra servers elsewhere' },
    HARDENING_INPUT,
    { id: 'allowed_tcp_ports', label: 'Inbound TCP ports', control: 'text', default: '22', hint: 'Opened in firewalld / ufw for IPv4 and IPv6; 22 is always open' },
    {
      id: 'licence',
      label: 'RHEL / SLES licence',
      control: 'select',
      options: [
        { value: 'li', label: 'Pay-as-you-go (cloud update service)' },
        { value: 'byos', label: 'Bring your own subscription' },
      ],
      default: 'li',
    },
    { id: 'rhsm_org_id', label: 'Red Hat organisation ID', control: 'text', default: '', hint: 'BYOS registration; the activation key is vault_rhsm_activation_key', showWhen: { input: 'licence', equals: ['byos'] } },
    { id: 'update_packages', label: 'Install updates', control: 'select', options: TRUE_FALSE, default: 'true' },
    { id: 'reboot', label: 'Reboot when updates need it', control: 'select', options: TRUE_FALSE, default: 'true' },
    { id: 'selinux', label: 'SELinux enforcing (RHEL family)', control: 'select', options: TRUE_FALSE, default: 'true' },
    { id: 'ssh_password_auth', label: 'SSH password logins', control: 'select', options: FALSE_TRUE, default: 'false', hint: 'Keys only unless AD users log in with passwords' },
  ],
  become: true,
  roles: () => [LINUX_BASELINE],
  vars: (v) => ({
    mig_cloud_platform: text(v.platform, 'aws'),
    mig_linux_baseline_timezone: text(v.timezone, 'UTC'),
    mig_linux_baseline_ntp_servers: list(v.ntp_servers),
    mig_linux_baseline_hardening: text(v.hardening, 'none'),
    mig_linux_baseline_allowed_tcp_ports: ports(v.allowed_tcp_ports),
    mig_linux_baseline_licence: text(v.licence, 'li'),
    mig_linux_baseline_rhsm_org_id: text(v.rhsm_org_id),
    mig_linux_baseline_update_packages: yes(v.update_packages ?? 'true'),
    mig_linux_baseline_reboot: yes(v.reboot ?? 'true'),
    mig_linux_baseline_selinux: yes(v.selinux ?? 'true'),
    mig_linux_baseline_ssh_password_auth: yes(v.ssh_password_auth),
  }),
  lockdown: (v) => {
    const kind = text(v.hardening, 'none') === 'stig' ? 'stig' : text(v.hardening, 'none').startsWith('cis') ? 'cis' : null;
    return kind ? Object.values(LOCKDOWN_LINUX[kind]).map((r) => lockdownRequirement(r.repo, r.name)) : [];
  },
  findings: (v) => {
    const hardening = text(v.hardening, 'none');
    const out = [];
    if (hardening !== 'none') {
      out.push(
        info(
          'ansible.migration.lockdown',
          `${hardening} applies the ansible-lockdown role for each host's release, installed from GitHub by \`ansible-galaxy install -r requirements.yml\`. Read the role's README before running it on production: some controls change SSH, mounts and services.`,
          { source: 'https://github.com/ansible-lockdown' },
        ),
      );
    }
    if (hardening === 'cis-l1') {
      out.push(
        info('ansible.migration.cis-level', 'The lockdown roles choose the CIS level by tag: run this playbook with --skip-tags level2-server to apply level 1 only.', {
          source: 'https://github.com/ansible-lockdown/RHEL9-CIS',
        }),
      );
    }
    return out;
  },
});
