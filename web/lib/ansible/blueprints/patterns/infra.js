/**
 * Core infrastructure moved by rebuilding (addendum A.4.2, Core
 * infrastructure): infra_dhcp and infra_adcs. Each play runs on the new
 * server and reaches the old one with delegate_to (it must be in the
 * inventory); what moves between them goes through the controller.
 *
 * infra_dhcp (https://learn.microsoft.com/en-us/powershell/module/dhcpserver/export-dhcpserver):
 *   Export-DhcpServer -File dhcp.xml -Leases on the old server (every IPv4
 *   scope and every IPv6 prefix: no -ScopeId / -Prefix narrows it), then
 *   Import-DhcpServer -File dhcp.xml -BackupPath … -Leases on the new one;
 *   the scope counts of both families compared. `stage` imports once and
 *   leaves the new server unauthorized (so it hands out nothing); `cutover`
 *   re-exports so the leases are current, imports over the staged scopes,
 *   authorizes the new server in AD (Add-DhcpServerInDC), deauthorizes the old
 *   one and stops and disables its service. A new server already authorized
 *   is left alone.
 *
 * infra_adcs (https://learn.microsoft.com/en-us/troubleshoot/windows-server/certificates-and-public-key-infrastructure-pki/move-certification-authority-to-another-server):
 *   Backup-CARoleService (database and key; the key file is protected with the
 *   password in the vault) and the CertSvc\Configuration registry key exported
 *   on the old CA; the old CA stopped and disabled; AD CS installed on the new
 *   server with the same CA name and key (Install-AdcsCertificationAuthority
 *   -CertFile <the backup's .p12>), Restore-CARoleService -DatabaseOnly, the
 *   registry imported, certsvc restarted, the CRL republished (certutil -crl)
 *   and, for an enterprise CA, the CA certificate republished to AIA. Nothing
 *   that carries key material is logged, and the backup is deleted from both
 *   servers and the controller when the play ends, whatever happens.
 *   A new server whose CA already has the old CA's name is left alone.
 */

                                                                
                                                                 
import { text } from '../migration/common.js';
import { AS_DOMAIN_ADMIN, assertVault, patternBlueprint, select } from './common.js';

const TOLERANT = { ignore_errors: '{{ ansible_check_mode }}' }         ;

const DOMAIN_ADMIN_VAULTS = {
  vault_domain_admin_user: 'AD account allowed to authorize DHCP servers and install an enterprise CA (Enterprise Admins)',
  vault_domain_admin_password: 'its password',
};

// ---------------------------------------------------------------- DHCP ---

const DHCP_DIR = 'C:\\Windows\\Temp\\dhcp-migration';
const ON_SOURCE = { delegate_to: '{{ dhcp_migrate_source }}' }         ;

const DHCP_STATE = `$Ansible.Changed = $false
$v4 = @(Get-DhcpServerv4Scope -ErrorAction SilentlyContinue).Count
$v6 = @(Get-DhcpServerv6Scope -ErrorAction SilentlyContinue).Count
$fqdn = [System.Net.Dns]::GetHostEntry([string]$env:COMPUTERNAME).HostName
$authorized = $false
try { $authorized = [bool](Get-DhcpServerInDC -ErrorAction Stop | Where-Object { $_.DnsName -eq $fqdn }) } catch { }
$Ansible.Result = @{ v4 = $v4; v6 = $v6; fqdn = $fqdn; authorized = $authorized }`;

const DHCP_EXPORT = `param([string]$Dir)
New-Item -ItemType Directory -Path $Dir -Force | Out-Null
Export-DhcpServer -File (Join-Path $Dir 'dhcp.xml') -Leases -Force
$Ansible.Changed = $true`;

const DHCP_IMPORT = `param([string]$Dir, [bool]$Overwrite)
$backup = Join-Path $Dir 'backup'
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$import = @{ File = (Join-Path $Dir 'dhcp.xml'); BackupPath = $backup; Leases = $true; Force = $true }
if ($Overwrite) { $import.ScopeOverwrite = $true }
Import-DhcpServer @import
$Ansible.Changed = $true`;

const DHCP_AUTHORIZE = `param([string]$Fqdn)
$Ansible.Changed = $false
if (-not (Get-DhcpServerInDC | Where-Object { $_.DnsName -eq $Fqdn })) { Add-DhcpServerInDC -DnsName $Fqdn; $Ansible.Changed = $true }
if (-not (Get-LocalGroup -Name 'DHCP Administrators' -ErrorAction SilentlyContinue)) { Add-DhcpServerSecurityGroup; $Ansible.Changed = $true }`;

const DHCP_DEAUTHORIZE = `param([string]$Fqdn)
$Ansible.Changed = $false
$entry = Get-DhcpServerInDC | Where-Object { $_.DnsName -eq $Fqdn }
if ($entry) { Remove-DhcpServerInDC -DnsName $Fqdn -IPAddress $entry.IPAddress -Confirm:$false; $Ansible.Changed = $true }`;

const dhcpTasks         = [
  {
    name: 'Check the old DHCP server is named and in the inventory',
    'ansible.builtin.assert': {
      that: ['dhcp_migrate_source | length > 0', 'dhcp_migrate_source in hostvars', 'dhcp_migrate_source != inventory_hostname'],
      fail_msg: 'Set dhcp_migrate_source to the inventory name of the old DHCP server (it is reached with delegate_to).',
      quiet: true,
    },
  },
  assertVault(['vault_domain_admin_user', 'vault_domain_admin_password'], 'to authorize the new DHCP server in AD', "dhcp_migrate_mode == 'cutover'"),
  {
    name: 'Add the DHCP Server role',
    'ansible.windows.win_feature': { name: 'DHCP', state: 'present', include_management_tools: true },
    register: 'dhcp_migrate_feature',
  },
  { name: 'Reboot when the role needs it', 'ansible.windows.win_reboot': {}, when: 'dhcp_migrate_feature.reboot_required' },
  {
    name: 'Read the new server (scopes, authorization)',
    'ansible.windows.win_powershell': { script: DHCP_STATE },
    register: 'dhcp_migrate_target',
    changed_when: false,
    check_mode: false,
    ...TOLERANT,
  },
  {
    name: 'Read the old server',
    'ansible.windows.win_powershell': { script: DHCP_STATE },
    register: 'dhcp_migrate_old',
    changed_when: false,
    check_mode: false,
    ...ON_SOURCE,
  },
  {
    name: 'Move the scopes and leases',
    when: 'dhcp_migrate_import',
    block: [
      { name: 'Export the old server (IPv4 and IPv6, with leases)', 'ansible.windows.win_powershell': { script: DHCP_EXPORT, parameters: { Dir: DHCP_DIR } }, ...ON_SOURCE },
      {
        name: 'Bring the export to the controller',
        'ansible.builtin.fetch': { src: `${DHCP_DIR}\\dhcp.xml`, dest: '{{ dhcp_migrate_transfer }}', flat: true },
        ...ON_SOURCE,
      },
      { name: 'Make the import folder', 'ansible.windows.win_file': { path: DHCP_DIR, state: 'directory' } },
      { name: 'Copy the export to the new server', 'ansible.windows.win_copy': { src: '{{ dhcp_migrate_transfer }}', dest: `${DHCP_DIR}\\dhcp.xml` } },
      {
        name: 'Import it (over the staged scopes at cutover)',
        'ansible.windows.win_powershell': { script: DHCP_IMPORT, parameters: { Dir: DHCP_DIR, Overwrite: '{{ dhcp_migrate_staged }}' } },
      },
      {
        name: 'Read the new server again',
        'ansible.windows.win_powershell': { script: DHCP_STATE },
        register: 'dhcp_migrate_imported',
        changed_when: false,
        check_mode: false,
      },
      {
        name: 'Check every IPv4 scope and IPv6 prefix arrived',
        'ansible.builtin.assert': {
          that: [
            'dhcp_migrate_imported.result.v4 >= dhcp_migrate_old.result.v4',
            'dhcp_migrate_imported.result.v6 >= dhcp_migrate_old.result.v6',
          ],
          fail_msg: 'The new server has {{ dhcp_migrate_imported.result.v4 }} IPv4 / {{ dhcp_migrate_imported.result.v6 }} IPv6 scopes; the old one {{ dhcp_migrate_old.result.v4 }} / {{ dhcp_migrate_old.result.v6 }}.',
        },
        when: 'not ansible_check_mode',
      },
    ],
    always: [
      { name: 'Remove the export from the controller', 'ansible.builtin.file': { path: '{{ dhcp_migrate_transfer }}', state: 'absent' }, delegate_to: 'localhost', become: false },
    ],
  },
  {
    name: 'Cut over',
    when: "dhcp_migrate_mode == 'cutover'",
    block: [
      {
        name: 'Authorize the new server in AD',
        'ansible.windows.win_powershell': { script: DHCP_AUTHORIZE, parameters: { Fqdn: '{{ dhcp_migrate_target.result.fqdn }}' } },
        register: 'dhcp_migrate_authorized',
        ...AS_DOMAIN_ADMIN,
      },
      {
        name: 'Tell Server Manager the DHCP role is configured',
        'ansible.windows.win_regedit': { path: 'HKLM:\\SOFTWARE\\Microsoft\\ServerManager\\Roles\\12', name: 'ConfigurationState', data: 2, type: 'dword' },
      },
      { name: 'Keep the DHCP service running', 'ansible.windows.win_service': { name: 'DHCPServer', state: 'restarted', start_mode: 'auto' }, when: 'dhcp_migrate_import or dhcp_migrate_authorized is changed' },
      {
        name: 'Deauthorize the old server',
        'ansible.windows.win_powershell': { script: DHCP_DEAUTHORIZE, parameters: { Fqdn: '{{ dhcp_migrate_old.result.fqdn }}' } },
        ...AS_DOMAIN_ADMIN,
      },
      { name: 'Stop and disable DHCP on the old server', 'ansible.windows.win_service': { name: 'DHCPServer', state: 'stopped', start_mode: 'disabled' }, ...ON_SOURCE },
    ],
  },
];

export const DHCP_MIGRATE_ROLE       = {
  name: 'dhcp_migrate',
  description: 'DHCP scopes, options and leases (IPv4 and IPv6) moved from the old server; authorized at cutover.',
  tasks: dhcpTasks,
  defaults: { dhcp_migrate_source: '', dhcp_migrate_mode: 'cutover' },
  derived: {
    dhcp_migrate_transfer: '{{ playbook_dir }}/.transfer/dhcp-{{ inventory_hostname }}.xml',
    dhcp_migrate_staged: '{{ ((dhcp_migrate_target.result.v4 | default(0)) + (dhcp_migrate_target.result.v6 | default(0))) > 0 }}',
    dhcp_migrate_import:
      "{{ (not (dhcp_migrate_staged | bool)) if dhcp_migrate_mode == 'stage' else (not (dhcp_migrate_target.result.authorized | default(false))) }}",
  },
};

const MODE_DHCP = select('mode', 'What to do', [['cutover', 'Cut over: import, authorize the new server, retire the old one'], ['stage', 'Stage: import only, new server left unauthorized']], 'cutover');

export const INFRA_DHCP = patternBlueprint({
  id: 'infra_dhcp',
  label: 'Core infrastructure – Move DHCP (Windows Server)',
  description:
    'Move a Windows DHCP server to a new one: Export-DhcpServer -Leases on the old server (every IPv4 scope and IPv6 prefix), Import-DhcpServer -BackupPath -Leases on the new one, scope counts compared, then at cutover the new server authorized in AD (Add-DhcpServerInDC) and the old one deauthorized, stopped and disabled. A cloud network with its own DHCP may not need this at all.',
  hosts: { default: 'role_dhcp', hint: 'The NEW DHCP server (one host)' },
  inputs: [
    { id: 'source_server', label: 'Old DHCP server', control: 'text', default: '', placeholder: 'dhcp01', hint: 'Its inventory name; reached with delegate_to' },
    MODE_DHCP,
  ],
  roles: () => [DHCP_MIGRATE_ROLE],
  vars: (v                ) => ({ mig_dhcp_migrate_source: text(v.source_server), mig_dhcp_migrate_mode: text(v.mode, 'cutover') }),
  vaults: DOMAIN_ADMIN_VAULTS,
});

// --------------------------------------------------------------- AD CS ---

/** The domain account only for an enterprise CA; a standalone (often offline, workgroup) CA installs as the connection user. */
const AS_ENTERPRISE_ADMIN = {
  become: "{{ adcs_migrate_ca_type is match('Enterprise') }}",
  become_method: 'ansible.builtin.runas',
  become_user: "{{ vault_domain_admin_user | default('') }}",
  vars: { ansible_become_password: "{{ vault_domain_admin_password | default('') }}" },
  no_log: true,
}         ;

const CA_DIR = 'C:\\Windows\\Temp\\adcs-migration';
const ON_OLD_CA = { delegate_to: '{{ adcs_migrate_source }}' }         ;
const CERTSVC_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration';

const CA_STATE = `$Ansible.Changed = $false
$name = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration' -Name Active -ErrorAction SilentlyContinue).Active
$svc = Get-Service -Name CertSvc -ErrorAction SilentlyContinue
$Ansible.Result = @{ name = [string]$name; running = [bool]($svc -and $svc.Status -eq 'Running') }`;

const CA_BACKUP = `param([string]$Dir, [securestring]$Password)
if (Test-Path $Dir) { Remove-Item -Path $Dir -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $Dir 'backup') -Force | Out-Null
Backup-CARoleService -Path (Join-Path $Dir 'backup') -Password $Password
& reg.exe export '${CERTSVC_KEY}' (Join-Path $Dir 'certsvc.reg') /y | Out-Null
if ($LASTEXITCODE -ne 0) { throw "reg export failed: $LASTEXITCODE" }
Compress-Archive -Path (Join-Path $Dir '*') -DestinationPath (Join-Path $Dir 'ca-backup.zip') -Force
$Ansible.Changed = $true`;

const CA_INSTALL = `param([string]$Dir, [string]$CAType, [securestring]$Password)
Expand-Archive -Path (Join-Path $Dir 'ca-backup.zip') -DestinationPath (Join-Path $Dir 'restore') -Force
$p12 = Get-ChildItem -Path (Join-Path $Dir 'restore\\backup') -Filter '*.p12' | Select-Object -First 1
if (-not $p12) { throw 'The CA backup holds no .p12 key file.' }
$install = @{ CAType = $CAType; CertFile = $p12.FullName; CertFilePassword = $Password; Force = $true }
if ($CAType -like 'Enterprise*') { $install.OverwriteExistingCAinDS = $true }
Install-AdcsCertificationAuthority @install | Out-Null
Stop-Service -Name CertSvc -Force
Restore-CARoleService -Path (Join-Path $Dir 'restore\\backup') -DatabaseOnly -Force
& reg.exe import (Join-Path $Dir 'restore\\certsvc.reg') | Out-Null
if ($LASTEXITCODE -ne 0) { throw "reg import failed: $LASTEXITCODE" }
Start-Service -Name CertSvc
$Ansible.Changed = $true`;

const CA_PUBLISH = `param([bool]$Enterprise)
& certutil.exe -crl | Out-Null
if ($LASTEXITCODE -ne 0) { throw "certutil -crl failed: $LASTEXITCODE" }
if ($Enterprise) {
  $crt = Get-ChildItem -Path "$env:SystemRoot\\System32\\CertSrv\\CertEnroll" -Filter '*.crt' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($crt) {
    & certutil.exe -dspublish -f $crt.FullName AIA | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "certutil -dspublish AIA failed: $LASTEXITCODE" }
  }
}
$Ansible.Changed = $true`;

const adcsTasks         = [
  {
    name: 'Check the old CA is named and in the inventory',
    'ansible.builtin.assert': {
      that: ['adcs_migrate_source | length > 0', 'adcs_migrate_source in hostvars', 'adcs_migrate_source != inventory_hostname'],
      fail_msg: 'Set adcs_migrate_source to the inventory name of the old CA server (it is reached with delegate_to).',
      quiet: true,
    },
  },
  assertVault(['vault_adcs_backup_password'], 'to protect the CA key in the backup'),
  assertVault(['vault_domain_admin_user', 'vault_domain_admin_password'], 'to install an enterprise CA', "adcs_migrate_ca_type is match('Enterprise')"),
  {
    name: 'Read the old CA',
    'ansible.windows.win_powershell': { script: CA_STATE },
    register: 'adcs_migrate_old',
    changed_when: false,
    check_mode: false,
    ...ON_OLD_CA,
  },
  {
    name: 'Read the new server',
    'ansible.windows.win_powershell': { script: CA_STATE },
    register: 'adcs_migrate_new',
    changed_when: false,
    check_mode: false,
  },
  {
    name: 'Check there is a CA to move, or one already moved',
    'ansible.builtin.assert': {
      that: ['(adcs_migrate_old.result.name | length > 0) or (adcs_migrate_new.result.name | length > 0)'],
      fail_msg: '{{ adcs_migrate_source }} has no CA configuration (CertSvc\\Configuration\\Active) to move.',
      quiet: true,
    },
  },
  {
    name: 'Add the Certification Authority role service',
    'ansible.windows.win_feature': { name: 'ADCS-Cert-Authority', state: 'present', include_management_tools: true },
    register: 'adcs_migrate_feature',
    when: "adcs_migrate_mode == 'move'",
  },
  { name: 'Reboot when the role needs it', 'ansible.windows.win_reboot': {}, when: 'adcs_migrate_feature.reboot_required | default(false)' },
  {
    name: 'Move the CA',
    when: 'adcs_migrate_needed',
    block: [
      {
        name: 'Back up the CA database, key and registry on the old CA',
        'ansible.windows.win_powershell': {
          script: CA_BACKUP,
          parameters: { Dir: CA_DIR },
          sensitive_parameters: [{ name: 'Password', value: '{{ vault_adcs_backup_password }}' }],
        },
        no_log: true,
        ...ON_OLD_CA,
      },
      {
        name: 'Bring the backup to the controller',
        'ansible.builtin.fetch': { src: `${CA_DIR}\\ca-backup.zip`, dest: '{{ adcs_migrate_transfer }}', flat: true },
        no_log: true,
        ...ON_OLD_CA,
      },
      {
        name: 'Stop and disable the old CA',
        'ansible.windows.win_service': { name: 'CertSvc', state: 'stopped', start_mode: 'disabled' },
        when: "adcs_migrate_mode == 'move'",
        ...ON_OLD_CA,
      },
      { name: 'Make the restore folder', 'ansible.windows.win_file': { path: CA_DIR, state: 'directory' }, when: "adcs_migrate_mode == 'move'" },
      {
        name: 'Copy the backup to the new server',
        'ansible.windows.win_copy': { src: '{{ adcs_migrate_transfer }}', dest: `${CA_DIR}\\ca-backup.zip` },
        no_log: true,
        when: "adcs_migrate_mode == 'move'",
      },
      {
        name: 'Install AD CS with the same CA name and key, restore the database and registry',
        'ansible.windows.win_powershell': {
          script: CA_INSTALL,
          parameters: { Dir: CA_DIR, CAType: '{{ adcs_migrate_ca_type }}' },
          sensitive_parameters: [{ name: 'Password', value: '{{ vault_adcs_backup_password }}' }],
        },
        when: "adcs_migrate_mode == 'move'",
        ...AS_ENTERPRISE_ADMIN,
      },
      {
        name: 'Republish the CRL and the AIA certificate',
        'ansible.windows.win_powershell': { script: CA_PUBLISH, parameters: { Enterprise: "{{ adcs_migrate_ca_type is match('Enterprise') }}" } },
        when: "adcs_migrate_mode == 'move'",
        ...AS_ENTERPRISE_ADMIN,
      },
      {
        name: 'Check the new CA answers with the old name',
        'ansible.windows.win_powershell': { script: CA_STATE },
        register: 'adcs_migrate_moved',
        changed_when: false,
        failed_when: 'adcs_migrate_moved.result.name != adcs_migrate_old.result.name or not adcs_migrate_moved.result.running',
        when: ["adcs_migrate_mode == 'move'", 'not ansible_check_mode'],
      },
    ],
    always: [
      { name: 'Delete the key backup from the old CA', 'ansible.windows.win_file': { path: CA_DIR, state: 'absent' }, ...ON_OLD_CA },
      { name: 'Delete the key backup from the new server', 'ansible.windows.win_file': { path: CA_DIR, state: 'absent' } },
      {
        name: 'Delete the key backup from the controller',
        'ansible.builtin.file': { path: '{{ adcs_migrate_transfer }}', state: 'absent' },
        delegate_to: 'localhost',
        become: false,
        when: "adcs_migrate_mode == 'move'",
      },
    ],
  },
];

export const ADCS_MIGRATE_ROLE       = {
  name: 'adcs_migrate',
  description: 'the CA moved to a new server with the same name and key: backup, install, restore, registry, CRL and AIA.',
  tasks: adcsTasks,
  defaults: { adcs_migrate_source: '', adcs_migrate_ca_type: 'EnterpriseRootCA', adcs_migrate_mode: 'move' },
  derived: {
    adcs_migrate_transfer: '{{ playbook_dir }}/.transfer/ca-backup-{{ inventory_hostname }}.zip',
    // Move unless this server already runs a CA of the old CA's name.
    adcs_migrate_needed: "{{ (adcs_migrate_old.result.name | default('')) | length > 0 and (adcs_migrate_new.result.name | default('')) != (adcs_migrate_old.result.name | default('')) }}",
  },
};

export const INFRA_ADCS = patternBlueprint({
  id: 'infra_adcs',
  label: 'Core infrastructure – Move an AD CS certification authority',
  description:
    "Move a Windows certification authority to a new server with the same CA name and key: Backup-CARoleService (key protected with the vault password) and the CertSvc\\Configuration registry on the old CA, the old CA stopped and disabled, AD CS installed on the new server from the backup's key (Install-AdcsCertificationAuthority -CertFile), Restore-CARoleService, the registry imported, certsvc restarted, the CRL and AIA republished. Key material is never logged and the backup is deleted everywhere afterwards. `Back up only` keeps the old CA running and the backup on the controller.",
  hosts: { default: 'role_adcs', hint: 'The NEW CA server (one host)' },
  inputs: [
    { id: 'source_server', label: 'Old CA server', control: 'text', default: '', placeholder: 'ca01', hint: 'Its inventory name; reached with delegate_to' },
    select(
      'ca_type',
      'CA type (as the old CA)',
      [
        ['EnterpriseRootCA', 'Enterprise root CA'],
        ['EnterpriseSubordinateCA', 'Enterprise subordinate (issuing) CA'],
        ['StandaloneRootCA', 'Standalone root CA'],
        ['StandaloneSubordinateCA', 'Standalone subordinate CA'],
      ],
      'EnterpriseRootCA',
    ),
    select('mode', 'What to do', [['move', 'Move the CA'], ['backup', 'Back up only (old CA keeps running; the backup stays on the controller)']], 'move'),
  ],
  roles: () => [ADCS_MIGRATE_ROLE],
  vars: (v                ) => ({
    mig_adcs_migrate_source: text(v.source_server),
    mig_adcs_migrate_ca_type: text(v.ca_type, 'EnterpriseRootCA'),
    mig_adcs_migrate_mode: text(v.mode, 'move'),
  }),
  vaults: { vault_adcs_backup_password: 'Password protecting the CA key in the backup (.p12)', ...DOMAIN_ADMIN_VAULTS },
});
