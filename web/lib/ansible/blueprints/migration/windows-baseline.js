/**
 * mig_windows_baseline: the windows_baseline role over every migrated Windows
 * host, with the WinRM bootstrap script beside it.
 */

import { info } from '../../../core/findings.js';
import { LOCKDOWN_WINDOWS, WINDOWS_BASELINE } from '../../migration/roles/index.js';
import { WINRM_BOOTSTRAP_PS1 } from '../../migration/templates/winrm.js';
import { HARDENING_INPUT, list, lockdownRequirement, migrationBlueprint, PLATFORM_INPUT, ports, text, TRUE_FALSE, yes } from './common.js';

export const MIG_WINDOWS_BASELINE = migrationBlueprint({
  id: 'mig_windows_baseline',
  label: 'Migration – Windows baseline',
  description:
    'Time zone, High performance power plan, page file, security and critical updates, the host firewall, role features, TLS 1.2 and later only, KMS activation for replicated licence-included VMs, and CIS or STIG through ansible-lockdown. files/bootstrap-winrm.ps1 is the one-time WinRM set-up for user data.',
  inputs: [
    PLATFORM_INPUT,
    { id: 'timezone', label: 'Time zone', control: 'text', default: 'UTC', hint: 'Windows time zone id, e.g. GMT Standard Time' },
    HARDENING_INPUT,
    { id: 'allowed_tcp_ports', label: 'Inbound TCP ports', control: 'text', default: '5986', hint: 'Opened for IPv4 and IPv6; 5986 (WinRM) is always open' },
    { id: 'allowed_sources', label: 'Allowed sources', control: 'text', default: 'any', hint: 'CIDRs of both families, or any' },
    { id: 'features', label: 'Windows features', control: 'text', default: '', hint: 'Comma separated; Web-Server is added for role_web hosts' },
    { id: 'domain_join', label: 'Will join a domain', control: 'select', options: TRUE_FALSE, default: 'true', hint: 'Adds RSAT-AD-PowerShell' },
    {
      id: 'licence',
      label: 'Windows licence',
      control: 'select',
      options: [
        { value: 'li', label: 'Licence included (activate against the platform KMS)' },
        { value: 'byol', label: 'Bring your own (activation stays yours)' },
      ],
      default: 'li',
    },
    { id: 'update', label: 'Install updates', control: 'select', options: TRUE_FALSE, default: 'true' },
    { id: 'pagefile_drive', label: 'Page file drive', control: 'text', default: 'C', hint: 'Letter only' },
  ],
  roles: () => [WINDOWS_BASELINE],
  vars: (v) => ({
    mig_cloud_platform: text(v.platform, 'aws'),
    mig_windows_baseline_timezone: text(v.timezone, 'UTC'),
    mig_windows_baseline_hardening: text(v.hardening, 'none'),
    mig_windows_baseline_allowed_tcp_ports: ports(v.allowed_tcp_ports),
    mig_windows_baseline_allowed_sources: list(v.allowed_sources).length > 0 ? list(v.allowed_sources) : ['any'],
    mig_windows_baseline_features: list(v.features),
    mig_windows_baseline_domain_join: yes(v.domain_join ?? 'true'),
    mig_windows_baseline_licence: text(v.licence, 'li'),
    mig_windows_baseline_update: yes(v.update ?? 'true'),
    mig_windows_baseline_pagefile_drive: text(v.pagefile_drive, 'C').replace(/[:\\]+$/, ''),
  }),
  lockdown: (v) => {
    const kind = text(v.hardening, 'none') === 'stig' ? 'stig' : text(v.hardening, 'none').startsWith('cis') ? 'cis' : null;
    return kind ? Object.values(LOCKDOWN_WINDOWS[kind]).map((r) => lockdownRequirement(r.repo, r.name)) : [];
  },
  extraFiles: () => ({ 'files/bootstrap-winrm.ps1': WINRM_BOOTSTRAP_PS1 }),
  findings: (v) => [
    info(
      'ansible.migration.winrm-bootstrap',
      'Windows hosts need WinRM over HTTPS before Ansible can reach them: run files/bootstrap-winrm.ps1 from user data (or a console) with the management CIDRs. Its certificate is self-signed until AD CS issues one.',
      { path: 'files/bootstrap-winrm.ps1' },
    ),
    ...(text(v.hardening, 'none') === 'cis-l1'
      ? [info('ansible.migration.cis-level', 'The lockdown roles choose the CIS level by tag: run this playbook with --skip-tags level2-server to apply level 1 only.', { source: 'https://github.com/ansible-lockdown/Windows-2022-CIS' })]
      : []),
  ],
});
