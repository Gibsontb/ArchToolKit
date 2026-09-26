/**
 * mig_ad_dc_promote: domain controllers on the new platform.
 *
 * extend (the plan's extend-dcs): each host joins the existing domain, then is
 * promoted into it, in an AD site of its own (<platform>-<region>) with the
 * cloud networks as that site's subnets (IPv4 and IPv6) and the site added to
 * DEFAULTIPSITELINK, so clients there find these DCs first.
 *
 * new-forest: the first host creates the forest; the others (one at a time,
 * after it) join it and are promoted into it.
 *
 * A host is joined before it is promoted and the connection switches to the
 * domain admin account first: promotion removes local accounts, so a local
 * connection account would not get back in after the reboot. Every task that
 * passes a credential has no_log.
 */

import { info } from '../../../core/findings.js';
import { assertVault } from '../../migration/roles/ad_join.js';
                                                           
import { list, migrationBlueprint, text, TRUE_FALSE, yes } from './common.js';

const FIRST = 'inventory_hostname == dc_first';
const EXTEND = "dc_mode == 'extend'";
const NEW_FOREST = "dc_mode == 'new-forest'";
const DOMAIN_CREDS = { domain_username: '{{ vault_domain_admin_user }}', domain_password: '{{ vault_domain_admin_password }}' };

const SITE_LINK = `param([string]$Site, [pscredential]$Credential)
$link = Get-ADReplicationSiteLink -Identity DEFAULTIPSITELINK -Credential $Credential
if ($link.SitesIncluded | Where-Object { $_ -like "CN=$Site,*" }) { $Ansible.Changed = $false; return }
Set-ADReplicationSiteLink -Identity DEFAULTIPSITELINK -SitesIncluded @{ Add = $Site } -Credential $Credential
$Ansible.Changed = $true`;

const tasks         = [
  assertVault(['vault_dsrm_password', 'vault_domain_admin_user', 'vault_domain_admin_password'], 'before promoting domain controllers'),
  {
    name: 'Add Active Directory Domain Services',
    'ansible.windows.win_feature': { name: ['AD-Domain-Services', 'RSAT-AD-PowerShell'], state: 'present', include_management_tools: true },
  },
  {
    name: 'Use the existing domain controllers for DNS',
    'ansible.windows.win_dns_client': { adapter_names: '*', dns_servers: '{{ dc_dns_servers }}' },
    when: [EXTEND, 'dc_dns_servers | length > 0'],
  },
  {
    name: 'Use the first domain controller for DNS',
    'ansible.windows.win_dns_client': {
      adapter_names: '*',
      dns_servers: "{{ hostvars[dc_first].ansible_facts.ip_addresses | reject('match', '^fe80') | list }}",
    },
    when: [NEW_FOREST, `not (${FIRST})`],
  },
  {
    name: 'Create the forest',
    'microsoft.ad.domain': {
      dns_domain_name: '{{ dc_domain }}',
      domain_netbios_name: '{{ dc_netbios | default(omit, true) }}',
      safe_mode_password: '{{ vault_dsrm_password }}',
      install_dns: true,
      reboot: true,
    },
    no_log: true,
    when: [NEW_FOREST, FIRST],
  },
  {
    name: 'Join the domain before promotion',
    'microsoft.ad.membership': {
      dns_domain_name: '{{ dc_domain }}',
      domain_admin_user: '{{ vault_domain_admin_user }}',
      domain_admin_password: '{{ vault_domain_admin_password }}',
      state: 'domain',
      reboot: true,
    },
    no_log: true,
    when: `${EXTEND} or not (${FIRST})`,
  },
  {
    name: 'Connect with the domain admin account from here on',
    'ansible.builtin.set_fact': { ansible_user: '{{ vault_domain_admin_user }}', ansible_password: '{{ vault_domain_admin_password }}' },
    no_log: true,
  },
  {
    name: 'Create the AD site for this platform',
    'microsoft.ad.site': { name: '{{ dc_site_name }}', description: 'Created by the migration plan', state: 'present', ...DOMAIN_CREDS },
    no_log: true,
    when: FIRST,
  },
  {
    name: "Add the platform's networks to the site (IPv4 and IPv6)",
    'microsoft.ad.site_subnet': { name: '{{ item }}', site: '{{ dc_site_name }}', state: 'present', ...DOMAIN_CREDS },
    loop: '{{ dc_site_subnets }}',
    no_log: true,
    when: FIRST,
  },
  {
    name: 'Add the site to DEFAULTIPSITELINK',
    'ansible.windows.win_powershell': {
      script: SITE_LINK,
      parameters: { Site: '{{ dc_site_name }}' },
      sensitive_parameters: [{ name: 'Credential', username: '{{ vault_domain_admin_user }}', password: '{{ vault_domain_admin_password }}' }],
    },
    no_log: true,
    when: FIRST,
  },
  {
    name: 'Promote to a domain controller',
    'microsoft.ad.domain_controller': {
      dns_domain_name: '{{ dc_domain }}',
      domain_admin_user: '{{ vault_domain_admin_user }}',
      domain_admin_password: '{{ vault_domain_admin_password }}',
      safe_mode_password: '{{ vault_dsrm_password }}',
      site_name: '{{ dc_site_name }}',
      replication_source_dc: '{{ dc_replication_source | default(omit, true) }}',
      install_dns: true,
      state: 'domain_controller',
      reboot: true,
    },
    no_log: true,
    when: `${EXTEND} or not (${FIRST})`,
  },
  {
    name: 'Add a KDS root key for gMSAs (SQL Server service accounts)',
    'microsoft.ad.kds_root_key': { state: 'present' },
    when: ['dc_kds_root_key | bool', FIRST],
  },
];

export const MIG_AD_DC_PROMOTE = migrationBlueprint({
  id: 'mig_ad_dc_promote',
  label: 'Migration – Promote domain controllers',
  description:
    'Promote Windows hosts to domain controllers of the existing domain (extend) or a new forest, in an AD site for their platform whose subnets are the cloud networks (IPv4 and IPv6). Credentials come from the vault.',
  inputs: [
    {
      id: 'mode',
      label: 'Domain',
      control: 'select',
      options: [
        { value: 'extend', label: 'Extend the existing domain' },
        { value: 'new-forest', label: 'Create a new forest' },
      ],
      default: 'extend',
    },
    { id: 'domain', label: 'Domain (DNS name)', control: 'text', default: 'corp.example.com' },
    { id: 'netbios', label: 'NetBIOS name', control: 'text', default: '', hint: 'New forest only; blank uses the first label', showWhen: { input: 'mode', equals: ['new-forest'] } },
    { id: 'site_name', label: 'AD site', control: 'text', default: 'aws-us-east-1', hint: '<platform>-<region>' },
    { id: 'site_subnets', label: 'Site subnets', control: 'text', default: '', hint: "The platform's network CIDRs, IPv4 and IPv6, comma separated" },
    { id: 'dns_servers', label: 'Existing DCs (DNS)', control: 'text', default: '', hint: 'Addresses of both families, comma separated', showWhen: { input: 'mode', equals: ['extend'] } },
    { id: 'replication_source', label: 'Replicate from', control: 'text', default: '', hint: 'A DC to copy the directory from; blank lets AD choose', showWhen: { input: 'mode', equals: ['extend'] } },
    { id: 'kds_root_key', label: 'Add a KDS root key (gMSA)', control: 'select', options: TRUE_FALSE, default: 'true' },
  ],
  play: (v) => (text(v.mode, 'extend') === 'new-forest' ? { serial: 1 } : {}),
  vars: (v) => ({
    dc_mode: text(v.mode, 'extend'),
    dc_domain: text(v.domain, 'corp.example.com'),
    dc_netbios: text(v.netbios),
    dc_site_name: text(v.site_name, 'Default-First-Site-Name'),
    dc_site_subnets: list(v.site_subnets),
    dc_dns_servers: list(v.dns_servers),
    dc_replication_source: text(v.replication_source),
    dc_kds_root_key: yes(v.kds_root_key ?? 'true'),
    dc_first: '{{ ansible_play_hosts_all | first }}',
  }),
  tasks: () => tasks,
  findings: (v) => [
    info(
      'ansible.migration.dc-credentials',
      `Set vault_domain_admin_user and vault_domain_admin_password (a Domain Admin${
        text(v.mode, 'extend') === 'new-forest' ? "; for a new forest, the first host's Administrator as DOMAIN\\Administrator" : ''
      }) and vault_dsrm_password in the vault. The play connects with that account after the join, because promotion removes local accounts.`,
    ),
  ],
});
