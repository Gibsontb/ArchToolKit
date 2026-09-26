/**
 * app_iis_site: one IIS web site on a Windows host, rebuilt for an
 * iis-dotnet application (addendum A.4.2, Microsoft).
 *
 *   - the IIS role services for the runtime (static, ASP.NET 4.x, or
 *     ASP.NET Core with the Hosting Bundle the user names);
 *   - the application pool (microsoft.iis.web_app_pool: No Managed Code for
 *     ASP.NET Core and static content, v4.0 for ASP.NET 4.x) and the site
 *     (microsoft.iis.website) with its bindings: HTTP and / or HTTPS on
 *     `*`, which IIS listens on for every IPv4 and IPv6 address, with SNI when
 *     a host name is given;
 *   - the certificate bound by thumbprint: one already in LocalMachine\My, or
 *     a PFX from the controller imported with its password from the vault
 *     (the task logs nothing);
 *   - the content from a zip (a URL, a file beside the playbook, or a path on
 *     the host), expanded only when the zip changed;
 *   - an inbound firewall rule per port (Windows firewall rules without an
 *     address cover IPv4 and IPv6).
 *
 * The site is created started; the Default Web Site is stopped when this
 * site takes its ports without a host name.
 */

                                                                
                                                                 
import { number, text, yes } from '../migration/common.js';
import { patternBlueprint, select, YES_NO } from './common.js';

const TEMP = 'C:\\Windows\\Temp';
const ANCM = 'C:\\Program Files\\IIS\\Asp.Net Core Module\\V2\\aspnetcorev2.dll';

const DEPLOY = `param([string]$Zip, [string]$Dest)
$hash = (Get-FileHash -Path $Zip -Algorithm SHA256).Hash
$stamp = "$($Dest.TrimEnd('\\')).sha256"
$Ansible.Changed = $false
if ((Test-Path $stamp) -and ((Get-Content -Path $stamp -Raw).Trim() -eq $hash)) { return }
Expand-Archive -Path $Zip -DestinationPath $Dest -Force
Set-Content -Path $stamp -Value $hash
$Ansible.Changed = $true`;

const IMPORT_PFX = `param([string]$Path, [securestring]$Password)
$data = Get-PfxData -FilePath $Path -Password $Password
$thumb = $data.EndEntityCertificates[0].Thumbprint
$Ansible.Changed = $false
if (-not (Test-Path "Cert:\\LocalMachine\\My\\$thumb")) {
  Import-PfxCertificate -FilePath $Path -CertStoreLocation Cert:\\LocalMachine\\My -Password $Password | Out-Null
  $Ansible.Changed = $true
}
$Ansible.Result = @{ thumbprint = $thumb }`;

const STOP_DEFAULT = `$Ansible.Changed = $false
Import-Module WebAdministration
$site = Get-Website -Name 'Default Web Site' -ErrorAction SilentlyContinue
if ($site -and ($site.State -ne 'Stopped' -or $site.serverAutoStart)) {
  Stop-Website -Name 'Default Web Site'
  Set-ItemProperty -Path 'IIS:\\Sites\\Default Web Site' -Name serverAutoStart -Value $false
  $Ansible.Changed = $true
}`;

const tasks         = [
  {
    name: 'Check the site is named',
    'ansible.builtin.assert': { that: ['iis_site_name | length > 0'], fail_msg: 'Set the site name (iis_site_name).', quiet: true },
  },
  {
    name: 'Check the certificate is named for HTTPS',
    'ansible.builtin.assert': {
      that: ["iis_site_tls != 'store' or iis_site_thumbprint | length > 0", "iis_site_tls != 'pfx' or iis_site_pfx | length > 0"],
      fail_msg: 'HTTPS needs a certificate: a thumbprint in LocalMachine\\My (iis_site_thumbprint) or a PFX beside the playbook (iis_site_pfx).',
      quiet: true,
    },
  },
  {
    name: 'Add the IIS role services',
    'ansible.windows.win_feature': { name: '{{ iis_site_features[iis_site_runtime] }}', state: 'present', include_management_tools: true },
    register: 'iis_site_feature',
  },
  { name: 'Reboot when the role services need it', 'ansible.windows.win_reboot': {}, when: 'iis_site_feature.reboot_required' },
  {
    name: 'Install the ASP.NET Core Hosting Bundle',
    'ansible.windows.win_package': { path: '{{ iis_site_hosting_bundle }}', arguments: ['/install', '/quiet', '/norestart'], creates_path: ANCM, state: 'present' },
    when: ["iis_site_runtime == 'net-6-plus'", 'iis_site_hosting_bundle | length > 0'],
    notify: 'Restart IIS',
  },
  {
    name: 'Say that ASP.NET Core needs the Hosting Bundle',
    'ansible.windows.win_stat': { path: ANCM },
    register: 'iis_site_ancm',
    when: ["iis_site_runtime == 'net-6-plus'", 'iis_site_hosting_bundle | length == 0'],
  },
  {
    name: 'Warn when the ASP.NET Core Module is missing',
    'ansible.builtin.debug': { msg: 'The ASP.NET Core Module is not installed; set iis_site_hosting_bundle to the dotnet-hosting-*-win.exe for the app runtime.' },
    when: ["iis_site_runtime == 'net-6-plus'", 'not (iis_site_ancm.stat.exists | default(true))'],
  },
  { name: 'Make the site folder', 'ansible.windows.win_file': { path: '{{ iis_site_path }}', state: 'directory' } },
  // --- content -----------------------------------------------------------------
  {
    name: 'Fetch the content zip',
    'ansible.windows.win_get_url': { url: '{{ iis_site_content }}', dest: '{{ iis_site_zip }}' },
    when: "iis_site_content_from == 'url'",
  },
  {
    name: 'Copy the content zip from the controller',
    'ansible.windows.win_copy': { src: '{{ iis_site_content }}', dest: '{{ iis_site_zip }}' },
    when: "iis_site_content_from == 'controller'",
  },
  {
    name: 'Expand the content when the zip changed',
    'ansible.windows.win_powershell': { script: DEPLOY, parameters: { Zip: '{{ iis_site_zip }}', Dest: '{{ iis_site_path }}' } },
    when: ["iis_site_content_from != 'none'", 'not ansible_check_mode'],
  },
  // --- certificate -----------------------------------------------------------
  {
    name: 'Copy the PFX to the host',
    'ansible.windows.win_copy': { src: '{{ iis_site_pfx }}', dest: `${TEMP}\\{{ iis_site_name }}.pfx` },
    when: "iis_site_tls == 'pfx'",
  },
  {
    name: 'Import the PFX into LocalMachine\\My',
    'ansible.windows.win_powershell': {
      script: IMPORT_PFX,
      parameters: { Path: `${TEMP}\\{{ iis_site_name }}.pfx` },
      sensitive_parameters: [{ name: 'Password', value: '{{ vault_iis_site_pfx_password }}' }],
    },
    register: 'iis_site_pfx_import',
    when: ["iis_site_tls == 'pfx'", 'not ansible_check_mode'],
    no_log: true,
  },
  { name: 'Delete the PFX copy', 'ansible.windows.win_file': { path: `${TEMP}\\{{ iis_site_name }}.pfx`, state: 'absent' }, when: "iis_site_tls == 'pfx'" },
  // --- pool, site, bindings ------------------------------------------------
  {
    name: 'Create the application pool',
    'microsoft.iis.web_app_pool': {
      name: '{{ iis_site_pool }}',
      state: 'started',
      attributes: {
        managedRuntimeVersion: "{{ 'v4.0' if iis_site_runtime == 'framework-4x' else '' }}",
        managedPipelineMode: 'Integrated',
      },
    },
  },
  {
    name: 'Stop the Default Web Site, which holds the same ports',
    'ansible.windows.win_powershell': { script: STOP_DEFAULT },
    when: ['iis_site_stop_default | bool', 'iis_site_hostname | length == 0', "iis_site_name != 'Default Web Site'"],
  },
  {
    name: 'Create the site with its bindings (IPv4 and IPv6)',
    'microsoft.iis.website': {
      name: '{{ iis_site_name }}',
      physical_path: '{{ iis_site_path }}',
      application_pool: '{{ iis_site_pool }}',
      state: 'started',
      bindings: { set: '{{ iis_site_bindings }}' },
    },
  },
  {
    name: 'Open the site ports (IPv4 and IPv6)',
    'community.windows.win_firewall_rule': {
      name: 'IIS {{ iis_site_name }} TCP {{ item }}',
      localport: '{{ item }}',
      protocol: 'tcp',
      direction: 'in',
      action: 'allow',
      profiles: ['domain', 'private', 'public'],
      enabled: true,
      state: 'present',
    },
    loop: '{{ iis_site_ports }}',
  },
];

const BASE = ['Web-Server', 'Web-Default-Doc', 'Web-Static-Content', 'Web-Http-Errors', 'Web-Http-Logging', 'Web-Stat-Compression', 'Web-Filtering', 'Web-Mgmt-Console'];

export const IIS_SITE_ROLE       = {
  name: 'iis_site',
  description: 'IIS role services, application pool, site with IPv4/IPv6 bindings and certificate, content from a zip, firewall.',
  tasks,
  handlers: [{ name: 'Restart IIS', 'ansible.windows.win_service': { name: 'W3SVC', state: 'restarted' } }],
  defaults: {
    iis_site_name: '',
    iis_site_hostname: '',
    iis_site_runtime: 'framework-4x',
    iis_site_http: true,
    iis_site_http_port: 80,
    iis_site_tls: 'none',
    iis_site_https_port: 443,
    iis_site_thumbprint: '',
    iis_site_pfx: '',
    iis_site_content_from: 'none',
    iis_site_content: '',
    iis_site_hosting_bundle: '',
    iis_site_stop_default: true,
    iis_site_root: 'C:\\inetpub\\sites',
  },
  derived: {
    iis_site_pool: '{{ iis_site_name }}',
    iis_site_path: '{{ iis_site_root }}\\{{ iis_site_name }}',
    iis_site_zip:
      "{{ iis_site_content if iis_site_content_from == 'host' else 'C:\\\\Windows\\\\Temp\\\\' ~ (iis_site_content | urlsplit('path') | basename if iis_site_content_from == 'url' else iis_site_content | basename) }}",
    iis_site_features: {
      static: BASE,
      'framework-4x': [...BASE, 'Web-Asp-Net45', 'Web-Net-Ext45', 'Web-ISAPI-Ext', 'Web-ISAPI-Filter', 'NET-Framework-45-ASPNET'],
      'net-6-plus': BASE,
    },
    iis_site_thumbprint_bound: "{{ iis_site_pfx_import.result.thumbprint | default('') if iis_site_tls == 'pfx' else iis_site_thumbprint }}",
    iis_site_bindings:
      "{{ ([{'protocol': 'http', 'ip': '*', 'port': iis_site_http_port | int, 'hostname': iis_site_hostname}] if iis_site_http | bool else []) + ([{'protocol': 'https', 'ip': '*', 'port': iis_site_https_port | int, 'hostname': iis_site_hostname, 'certificate_hash': iis_site_thumbprint_bound, 'certificate_store_name': 'My', 'use_sni': iis_site_hostname | length > 0}] if iis_site_tls != 'none' and iis_site_thumbprint_bound | length > 0 else []) }}",
    iis_site_ports:
      "{{ ([iis_site_http_port | int] if iis_site_http | bool else []) + ([iis_site_https_port | int] if iis_site_tls != 'none' else []) }}",
  },
};

export const APP_IIS_SITE = patternBlueprint({
  id: 'app_iis_site',
  label: 'IIS – Web site',
  description:
    'One IIS site: the role services for the runtime (static, ASP.NET 4.x, or ASP.NET Core with its Hosting Bundle), an application pool, the site with HTTP / HTTPS bindings on * (every IPv4 and IPv6 address, SNI with a host name), the certificate by thumbprint or imported from a PFX (password from the vault), content from a zip expanded when it changes, and a firewall rule per port.',
  hosts: { default: 'role_web:&os_kind_windows', hint: 'The Windows web servers' },
  inputs: [
    { id: 'site_name', label: 'Site name', control: 'text', default: 'app', hint: 'Also the application pool and the folder under C:\\inetpub\\sites' },
    { id: 'hostname', label: 'Host name', control: 'text', default: '', placeholder: 'shop.example.com', hint: 'Empty = every name (then the Default Web Site is stopped)' },
    select('runtime', 'Runtime', [['framework-4x', 'ASP.NET 4.x (.NET Framework)'], ['net-6-plus', 'ASP.NET Core (.NET 6 and later)'], ['static', 'Static content']], 'framework-4x'),
    { id: 'hosting_bundle', label: 'ASP.NET Core Hosting Bundle', control: 'text', default: '', placeholder: 'https://…/dotnet-hosting-<version>-win.exe', showWhen: { input: 'runtime', equals: ['net-6-plus'] } },
    select('http', 'Listen on HTTP', YES_NO, 'true'),
    { id: 'http_port', label: 'HTTP port', control: 'number', default: 80, min: 1, max: 65535, showWhen: { input: 'http', equals: ['true'] } },
    select('tls', 'HTTPS certificate', [['none', 'No HTTPS'], ['store', 'Already in LocalMachine\\My (thumbprint)'], ['pfx', 'PFX beside the playbook (password in the vault)']], 'none'),
    { id: 'https_port', label: 'HTTPS port', control: 'number', default: 443, min: 1, max: 65535, showWhen: { input: 'tls', notEquals: ['none'] } },
    { id: 'thumbprint', label: 'Certificate thumbprint', control: 'text', default: '', showWhen: { input: 'tls', equals: ['store'] } },
    { id: 'pfx', label: 'PFX file', control: 'text', default: 'files/site.pfx', showWhen: { input: 'tls', equals: ['pfx'] } },
    select('content_from', 'Content', [['none', 'None yet'], ['url', 'Zip from a URL'], ['controller', 'Zip beside the playbook'], ['host', 'Zip already on the host (path or UNC)']], 'none'),
    { id: 'content', label: 'Content zip', control: 'text', default: '', placeholder: 'files/site.zip', showWhen: { input: 'content_from', notEquals: ['none'] } },
  ],
  roles: () => [IIS_SITE_ROLE],
  vars: (v                ) => ({
    mig_iis_site_name: text(v.site_name, 'app'),
    mig_iis_site_hostname: text(v.hostname),
    mig_iis_site_runtime: text(v.runtime, 'framework-4x'),
    mig_iis_site_hosting_bundle: text(v.hosting_bundle),
    mig_iis_site_http: yes(v.http ?? 'true'),
    mig_iis_site_http_port: number(v.http_port, 80),
    mig_iis_site_tls: text(v.tls, 'none'),
    mig_iis_site_https_port: number(v.https_port, 443),
    mig_iis_site_thumbprint: text(v.thumbprint),
    mig_iis_site_pfx: text(v.pfx, 'files/site.pfx'),
    mig_iis_site_content_from: text(v.content_from, 'none'),
    mig_iis_site_content: text(v.content),
  }),
  vaults: { vault_iis_site_pfx_password: 'Password of the site certificate PFX (only when HTTPS uses a PFX)' },
});
