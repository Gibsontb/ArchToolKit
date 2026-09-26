/**
 * The WinRM bootstrap: what a new or replicated Windows VM runs once so that
 * Ansible can reach it over HTTPS on 5986.
 *
 * Ansible cannot run this itself (it is what lets Ansible in), so it is
 * written for user data (EC2 <powershell>, Azure custom data / run command,
 * GCE windows-startup-script-ps1, OCI cloudbase-init) or a console session.
 *
 * It creates a self-signed certificate for the host's FQDN and an HTTPS
 * listener, and opens 5986 only from the management CIDRs passed to it (IPv4
 * and IPv6 both accepted). It holds no credentials and does not enable Basic
 * authentication or the unencrypted HTTP listener. The certificate is
 * self-signed until AD CS issues one, which is why the bootstrap_windows
 * group validates nothing; replace it and set validation back to 'validate'.
 */

export const WINRM_BOOTSTRAP_PS1 = `<#
  bootstrap-winrm.ps1: enable WinRM over HTTPS (5986) for Ansible.

  Usage:  powershell -ExecutionPolicy Bypass -File bootstrap-winrm.ps1 -ManagementCidrs 10.0.8.0/22,fd00:10:0:8::/64

  Creates a self-signed certificate and an HTTPS listener, and opens 5986 from
  the given CIDRs only. No credentials are set or stored.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]] $ManagementCidrs,
  [int] $Port = 5986
)
$ErrorActionPreference = 'Stop'

$fqdn = [System.Net.Dns]::GetHostEntry([string]$env:COMPUTERNAME).HostName
$existing = Get-ChildItem -Path WSMan:\\localhost\\Listener | Where-Object { $_.Keys -contains 'Transport=HTTPS' }
if (-not $existing) {
  $cert = New-SelfSignedCertificate -DnsName $fqdn, $env:COMPUTERNAME -CertStoreLocation Cert:\\LocalMachine\\My -KeyLength 2048 -NotAfter (Get-Date).AddYears(2)
  New-Item -Path WSMan:\\localhost\\Listener -Transport HTTPS -Address * -CertificateThumbPrint $cert.Thumbprint -Port $Port -Force | Out-Null
}

Set-Item -Path WSMan:\\localhost\\Service\\Auth\\Basic -Value $false
Set-Item -Path WSMan:\\localhost\\Service\\AllowUnencrypted -Value $false
Set-Service -Name WinRM -StartupType Automatic
Restart-Service -Name WinRM

$rule = 'Ansible WinRM over HTTPS'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $ManagementCidrs -Action Allow -Profile Any | Out-Null
`;
