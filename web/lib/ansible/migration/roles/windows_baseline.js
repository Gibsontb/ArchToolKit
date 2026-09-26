/**
 * windows_baseline: the first thing every migrated or rebuilt Windows host gets.
 *
 * Time zone, power plan, page file, security and critical updates, the host
 * firewall for the host's ports, role features, the TLS 1.2+ baseline, KMS
 * activation for a replicated licence-included VM, and CIS / STIG through the
 * ansible-lockdown role for the host's Windows Server release.
 *
 * KMS: a licence-included VM that was replicated (not built from the cloud's
 * image) is still pointed at the source's activation. Azure and Google Cloud
 * publish a KMS host for their guests (azkms.core.windows.net:1688,
 * kms.windows.googlecloud.com:1688); on AWS, EC2Launch v2 sets activation up
 * itself (the cloud_agents role makes sure it is installed). OCI is left to
 * the image, and says so.
 */

import { CLOUD_PLATFORM,                      } from './types.js';

/** Lockdown role (as named in requirements.yml) per baseline and Windows Server release. */
export const LOCKDOWN_WINDOWS                                                                                                               = {
  cis: {
    '2016': { name: 'windows_2016_cis', repo: 'Windows-2016-CIS' },
    '2019': { name: 'windows_2019_cis', repo: 'Windows-2019-CIS' },
    '2022': { name: 'windows_2022_cis', repo: 'Windows-2022-CIS' },
    '2025': { name: 'windows_2025_cis', repo: 'Windows-2025-CIS' },
  },
  stig: {
    '2019': { name: 'windows_2019_stig', repo: 'Windows-2019-STIG' },
    '2022': { name: 'windows_2022_stig', repo: 'Windows-2022-STIG' },
    '2025': { name: 'windows_2025_stig', repo: 'Windows-2025-STIG' },
  },
};

const lockdownMap = (kind                )                         =>
  Object.fromEntries(Object.entries(LOCKDOWN_WINDOWS[kind]).map(([key, r]) => [key, r.name]));

const SCHANNEL = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols';

/** Protocol → enabled. TLS 1.3 is left to the OS: Server 2022 and later have it on. */
const PROTOCOLS                               = [
  ['SSL 2.0', false],
  ['SSL 3.0', false],
  ['TLS 1.0', false],
  ['TLS 1.1', false],
  ['TLS 1.2', true],
];

const tlsSettings = PROTOCOLS.flatMap(([protocol, enabled]) =>
  ['Server', 'Client'].flatMap((side) => [
    { path: `${SCHANNEL}\\${protocol}\\${side}`, name: 'Enabled', data: enabled ? 1 : 0 },
    { path: `${SCHANNEL}\\${protocol}\\${side}`, name: 'DisabledByDefault', data: enabled ? 0 : 1 },
  ]),
).concat([
  { path: 'HKLM:\\SOFTWARE\\Microsoft\\.NETFramework\\v4.0.30319', name: 'SchUseStrongCrypto', data: 1 },
  { path: 'HKLM:\\SOFTWARE\\Microsoft\\.NETFramework\\v4.0.30319', name: 'SystemDefaultTlsVersions', data: 1 },
  { path: 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\.NETFramework\\v4.0.30319', name: 'SchUseStrongCrypto', data: 1 },
  { path: 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\.NETFramework\\v4.0.30319', name: 'SystemDefaultTlsVersions', data: 1 },
]);

const tasks         = [
  { name: 'Set the time zone', 'ansible.windows.win_timezone': { timezone: '{{ windows_baseline_timezone }}' } },
  { name: 'Use the High performance power plan', 'community.windows.win_power_plan': { name: 'High performance' } },
  {
    name: 'Let Windows size the page file',
    'community.windows.win_pagefile': { drive: '{{ windows_baseline_pagefile_drive }}', system_managed: true, state: 'present' },
    register: 'windows_baseline_pagefile',
  },
  {
    name: 'Install security and critical updates',
    'ansible.windows.win_updates': { category_names: ['SecurityUpdates', 'CriticalUpdates'], state: 'installed', reboot: true, reboot_timeout: 3600 },
    when: 'windows_baseline_update | bool',
  },
  {
    name: "Open the host's ports (IPv4 and IPv6)",
    'community.windows.win_firewall_rule': {
      name: 'Migration baseline TCP {{ item }}',
      localport: '{{ item }}',
      protocol: 'tcp',
      direction: 'in',
      action: 'allow',
      remoteip: '{{ windows_baseline_allowed_sources | join(",") }}',
      profiles: ['domain', 'private', 'public'],
      enabled: true,
      state: 'present',
    },
    loop: '{{ windows_baseline_tcp_ports }}',
  },
  {
    name: 'Add the features the host needs',
    'ansible.windows.win_feature': { name: '{{ windows_baseline_all_features }}', state: 'present', include_management_tools: true },
    register: 'windows_baseline_features_result',
    when: 'windows_baseline_all_features | length > 0',
  },
  {
    name: 'TLS 1.2 and later only',
    'ansible.windows.win_regedit': { path: '{{ item.path }}', name: '{{ item.name }}', data: '{{ item.data }}', type: 'dword', state: 'present' },
    loop: '{{ windows_baseline_tls }}',
    loop_control: { label: '{{ item.path }}\\{{ item.name }}' },
    register: 'windows_baseline_tls_result',
  },
  {
    name: "Point a replicated licence-included VM at the platform's KMS",
    'ansible.windows.win_command': { argv: ['cscript.exe', '//NoLogo', 'C:\\Windows\\System32\\slmgr.vbs', '/skms', '{{ windows_baseline_kms[cloud_platform] }}'] },
    when: ['windows_baseline_kms_activation | bool', 'cloud_platform in windows_baseline_kms'],
  },
  {
    name: 'Activate Windows against it',
    'ansible.windows.win_command': { argv: ['cscript.exe', '//NoLogo', 'C:\\Windows\\System32\\slmgr.vbs', '/ato'] },
    when: ['windows_baseline_kms_activation | bool', 'cloud_platform in windows_baseline_kms'],
  },
  {
    name: 'Say how activation is handled where no KMS host is set here',
    'ansible.builtin.debug': {
      msg: "{{ 'EC2Launch v2 activates Windows on AWS (cloud_agents installs it).' if cloud_platform == 'aws' else 'Activation on ' ~ cloud_platform ~ ' comes from the image; check slmgr /dlv after the move.' }}",
    },
    when: ['windows_baseline_kms_activation | bool', 'cloud_platform not in windows_baseline_kms'],
  },
  {
    name: 'Reboot for the TLS, page file and feature changes',
    'ansible.windows.win_reboot': { reboot_timeout: 1800 },
    when: 'windows_baseline_tls_result is changed or windows_baseline_pagefile is changed or (windows_baseline_features_result.reboot_required | default(false))',
  },
  {
    name: 'Apply the CIS or STIG lockdown role for this release',
    'ansible.builtin.include_role': { name: '{{ windows_baseline_lockdown[windows_baseline_release] }}' },
    when: ["windows_baseline_hardening != 'none'", 'windows_baseline_release in windows_baseline_lockdown'],
  },
  {
    name: 'Say when no lockdown role covers this release',
    'ansible.builtin.debug': { msg: 'No ansible-lockdown {{ windows_baseline_hardening }} role covers Windows Server {{ windows_baseline_release }}; only the baseline above was applied.' },
    when: ["windows_baseline_hardening != 'none'", 'windows_baseline_release not in windows_baseline_lockdown'],
  },
];

export const WINDOWS_BASELINE       = {
  name: 'windows_baseline',
  description: 'time zone, power, page file, updates, firewall, features, TLS, activation and CIS/STIG.',
  tasks,
  defaults: {
    windows_baseline_timezone: 'UTC',
    windows_baseline_pagefile_drive: 'C',
    windows_baseline_update: true,
    windows_baseline_allowed_tcp_ports: [5986],
    windows_baseline_allowed_sources: ['any'],
    windows_baseline_features: [],
    windows_baseline_domain_join: true,
    windows_baseline_licence: 'li',
    windows_baseline_hardening: 'none',
  },
  derived: {
    cloud_platform: CLOUD_PLATFORM,
    windows_baseline_tcp_ports: "{{ ([5986] + windows_baseline_allowed_tcp_ports | map('int') | list) | unique }}",
    windows_baseline_all_features:
      "{{ (windows_baseline_features + (['Web-Server'] if 'role_web' in group_names else []) + (['RSAT-AD-PowerShell'] if windows_baseline_domain_join | bool else [])) | unique }}",
    windows_baseline_kms_activation: "{{ 'method_replicate' in group_names and windows_baseline_licence == 'li' }}",
    windows_baseline_kms: { azure: 'azkms.core.windows.net:1688', google: 'kms.windows.googlecloud.com:1688' },
    windows_baseline_release: "{{ ansible_facts.os_name | regex_search('20[0-9][0-9]') | default('', true) }}",
    windows_baseline_lockdown: '{{ windows_baseline_lockdown_roles[windows_baseline_hardening] | default({}) }}',
    windows_baseline_lockdown_roles: { 'cis-l1': lockdownMap('cis'), 'cis-l2': lockdownMap('cis'), stig: lockdownMap('stig') },
    windows_baseline_tls: tlsSettings,
  },
};
