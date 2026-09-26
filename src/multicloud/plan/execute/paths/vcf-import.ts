/**
 * VCF Import (convergence) (addendum A.6.3, WP-11b): an existing vCenter is
 * brought under VMware Cloud Foundation as a workload domain, in place. No
 * VM moves.
 *
 * In VCF 9 the import is UI-driven (VCF Operations › Inventory › VCF
 * Instances › Add Workload Domain › Import a vCenter), every cluster of the
 * vCenter is imported (no subset), and no public CLI or API for it is
 * documented. So the kit automates the checks and the verification, never
 * the import:
 *
 *   paths/vcf-import/vcf-import.ps1  prepare = the precheck (per cluster, an
 *                                    event per VM); cutover = the verify (the
 *                                    workload domain whose vCenter matches);
 *                                    every other verb is skipped with the reason
 *   paths/vcf-import/README.md       the click path and the prerequisite table
 *
 * Sources:
 *   https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/building-your-private-cloud-infrastructure/working-with-workload-domains/import-an-existing-vcenter-to-create-a-workload-domain.html
 *   https://blogs.vmware.com/cloud-foundation/2026/02/05/how-to-converge-a-vmware-vsphere-environment-to-vmware-cloud-foundation-9-0/
 */

import { info, type Finding } from '../../../../core/findings.ts';
import type { ExecPath } from '../contract.ts';
import { code } from '../lib-sh.ts';
import { psScript } from '../lib-ps.ts';
import type { ManifestItem } from '../manifest.ts';
import type { PathContext, PathGenerator } from '../registry.ts';
import { POWERCLI_NEED, PS_VSPHERE_HELPERS } from './xvc.ts';

export const VCF_IMPORT_SOURCE = 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/building-your-private-cloud-infrastructure/working-with-workload-domains/import-an-existing-vcenter-to-create-a-workload-domain.html';
export const VCF_IMPORT_FILE = 'paths/vcf-import/vcf-import.ps1';
export const VCF_IMPORT_README = 'paths/vcf-import/README.md';
const PATHS: readonly ExecPath[] = ['vcf-import'];

export interface ImportPrerequisite {
  readonly check: string;
  readonly requirement: string;
  /** 'script': vcf-import.ps1 prepare checks it; 'manual': the README asks for it. */
  readonly by: 'script' | 'manual';
  readonly verification: 'V-DOC' | 'I';
}

/** VCF 9.1's prerequisites for importing a vCenter as a workload domain. */
export const VCF_IMPORT_PREREQUISITES: readonly ImportPrerequisite[] = Object.freeze([
  { check: 'vCenter version', requirement: '8.0 Update 3a or later (appliance version 8.0.3.00100; the version string is unverified)', by: 'script', verification: 'V-DOC' },
  { check: 'ESX version', requirement: '8.0 Update 3 or later on every host', by: 'script', verification: 'V-DOC' },
  { check: 'NSX version', requirement: '4.2.1 or later, when NSX is present (one NSX Manager per vCenter)', by: 'script', verification: 'V-DOC' },
  { check: 'Distributed switches', requirement: 'VDS 8.0 or later', by: 'script', verification: 'V-DOC' },
  { check: 'Host names', requirement: 'hosts are registered by FQDN, not by IP address', by: 'script', verification: 'V-DOC' },
  { check: 'DNS', requirement: 'forward and reverse records for every host', by: 'script', verification: 'V-DOC' },
  { check: 'VMkernel addresses', requirement: 'static (no DHCP, IPv4 or IPv6)', by: 'script', verification: 'V-DOC' },
  { check: 'vMotion network', requirement: 'a dedicated vMotion VMkernel adapter on every host', by: 'script', verification: 'V-DOC' },
  { check: 'SSH on vCenter', requirement: 'enabled (GET /api/appliance/access/ssh)', by: 'script', verification: 'V-DOC' },
  { check: 'Cluster lifecycle', requirement: 'vSphere Lifecycle Manager images, not baselines', by: 'script', verification: 'V-DOC' },
  { check: 'DRS', requirement: 'fully automated', by: 'script', verification: 'V-DOC' },
  { check: 'Enhanced Linked Mode', requirement: 'not in Enhanced Linked Mode', by: 'manual', verification: 'V-DOC' },
  { check: 'Storage', requirement: 'vSAN, NFS, VMFS, iSCSI or vVols', by: 'manual', verification: 'V-DOC' },
  { check: 'Scope', requirement: 'every cluster of the vCenter is imported (no partial import)', by: 'manual', verification: 'V-DOC' },
]);

const FUNCTIONS = code`
${PS_VSPHERE_HELPERS.trim()}

$SkipTls = $env:ATK_SKIP_TLS_VERIFY -eq '1'
$script:Checked = @{}
$script:VcSession = $null

function Invoke-AtkGet {
  param([string] $Uri, [hashtable] $Headers = @{}, $Credential = $null)
  $a = @{ Uri = $Uri; Method = 'Get'; Headers = $Headers; ErrorAction = 'Stop' }
  if ($Credential) { $a.Credential = $Credential; $a.Authentication = 'Basic' }
  if ($SkipTls) { $a.SkipCertificateCheck = $true }
  return (Invoke-RestMethod @a)
}

# A login: it opens an API session and changes nothing, so it runs in a dry run too.
function Invoke-AtkLogin {
  param([string] $Uri, $Credential = $null, [string] $JsonBody = '')
  $a = @{ Uri = $Uri; Method = 'Post'; ErrorAction = 'Stop'; ContentType = 'application/json' }
  if ($Credential) { $a.Credential = $Credential; $a.Authentication = 'Basic' }
  if ($JsonBody) { $a.Body = $JsonBody }
  if ($SkipTls) { $a.SkipCertificateCheck = $true }
  return (Invoke-RestMethod @a)
}

function Get-AtkCredential {
  param([string] $UserVar, [string] $SecretName)
  $user = [Environment]::GetEnvironmentVariable($UserVar)
  if (-not $user) { throw "set $UserVar" }
  $secure = ConvertTo-SecureString -String (Get-AtkSecret -Name $SecretName) -AsPlainText -Force
  return [System.Management.Automation.PSCredential]::new($user, $secure)
}

# vCenter's REST API, with a session opened from the VC_SRC credentials.
function Get-VcApi {
  param([string] $Path)
  $vc = $env:VC_SRC
  if (-not $script:VcSession) { $script:VcSession = Invoke-AtkLogin "https://$vc/api/session" (Get-AtkCredential 'VC_SRC_USER' 'VC_SRC_PASSWORD') }
  return (Invoke-AtkGet "https://$vc$Path" @{ 'vmware-api-session-id' = [string] $script:VcSession })
}

# The import prerequisites for one cluster (and its vCenter), one line per problem; checked once per run.
function Get-ImportProblems {
  param([string] $ClusterName)
  if ($script:Checked.ContainsKey($ClusterName)) { return $script:Checked[$ClusterName] }
  $vc = Connect-AtkVc SRC
  $problems = @()
  $ver = Get-VcApi '/api/appliance/system/version'
  if ([version] ([string] $ver.version) -lt [version] '8.0.3.00100') { $problems += "vCenter is $($ver.version): VCF Import needs 8.0 Update 3a or later" }
  if (-not (Get-VcApi '/api/appliance/access/ssh')) { $problems += 'SSH is off on vCenter: turn it on for the import' }
  $cluster = Get-Cluster -Server $vc -Name $ClusterName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cluster) { $problems += "cluster $ClusterName is not on $($vc.Name)"; $script:Checked[$ClusterName] = $problems; return $problems }
  if (-not ($cluster.DrsEnabled -and [string] $cluster.DrsAutomationLevel -eq 'FullyAutomated')) { $problems += "cluster $($ClusterName): DRS is not fully automated" }
  if (-not $cluster.ExtensionData.LifecycleManaged) { $problems += "cluster $($ClusterName) is managed with baselines: move it to vSphere Lifecycle Manager images" }
  foreach ($h in @(Get-VMHost -Location $cluster)) {
    if ([version] ([string] $h.Version) -lt [version] '8.0.3') { $problems += "$($h.Name) is ESX $($h.Version): 8.0 Update 3 or later is needed" }
    $parsed = $null
    $isIp = [System.Net.IPAddress]::TryParse([string] $h.Name, [ref] $parsed)
    if ($isIp -or -not ([string] $h.Name).Contains('.')) { $problems += "$($h.Name) is not registered by FQDN" }
    else {
      try {
        $addrs = @([System.Net.Dns]::GetHostAddresses([string] $h.Name))
        foreach ($a in $addrs) {
          try { $rev = [System.Net.Dns]::GetHostEntry($a).HostName } catch { $rev = '' }
          if ($rev -ne [string] $h.Name) { $problems += "$($h.Name): the reverse record of $a is '$rev'" }
        }
      } catch { $problems += "$($h.Name) has no DNS record" }
    }
    $vmk = @(Get-VMHostNetworkAdapter -VMHost $h -VMKernel)
    foreach ($n in $vmk) {
      if ($n.DhcpEnabled -or (Get-AtkProp $n 'IPv6ThroughDhcp') -or (Get-AtkProp $n 'AutomaticIPv6')) { $problems += "$($h.Name) $($n.Name) takes its address from DHCP or router advertisements: make it static" }
    }
    if (-not ($vmk | Where-Object { $_.VMotionEnabled })) { $problems += "$($h.Name) has no vMotion VMkernel adapter" }
  }
  foreach ($s in @(Get-VDSwitch -Server $vc -ErrorAction SilentlyContinue)) {
    if ([version] ([string] $s.Version) -lt [version] '8.0.0') { $problems += "distributed switch $($s.Name) is version $($s.Version): 8.0 or later is needed" }
  }
  if ($env:NSX_MANAGER) {
    $nsx = Invoke-AtkGet "https://$($env:NSX_MANAGER)/api/v1/node/version" @{} (Get-AtkCredential 'NSX_USER' 'NSX_PASSWORD')
    $nv = ([string] $nsx.node_version).Split('.')[0..2] -join '.'
    if ([version] $nv -lt [version] '4.2.1') { $problems += "NSX is $($nsx.node_version): 4.2.1 or later is needed" }
  } else {
    Write-AtkLog 'NSX_MANAGER is not set: the NSX version is not checked (needed only when NSX is present)'
  }
  Write-AtkLog 'check by hand: vCenter is not in Enhanced Linked Mode (paths/vcf-import/README.md)'
  $script:Checked[$ClusterName] = $problems
  return $problems
}

# The workload domain whose vCenter is VC_SRC, from the VCF instance's API (SDDC Manager /v1/domains: verify on 9.1).
function Find-ImportedDomain {
  if (-not $env:SDDC_MANAGER) { throw 'set SDDC_MANAGER (the VCF instance), SDDC_MANAGER_USER and SDDC_MANAGER_PASSWORD to verify the import' }
  $cred = Get-AtkCredential 'SDDC_MANAGER_USER' 'SDDC_MANAGER_PASSWORD'
  $body = @{ username = $cred.UserName; password = $cred.GetNetworkCredential().Password } | ConvertTo-Json -Compress
  $tok = Invoke-AtkLogin "https://$($env:SDDC_MANAGER)/v1/tokens" $null $body
  $headers = @{ Authorization = "Bearer $($tok.accessToken)" }
  $domains = Invoke-AtkGet "https://$($env:SDDC_MANAGER)/v1/domains" $headers
  foreach ($d in @(Get-AtkProp $domains 'elements')) {
    foreach ($v in @(Get-AtkProp $d 'vcenters')) {
      if ([string] (Get-AtkProp $v 'fqdn') -ieq [string] $env:VC_SRC) { return $d }
    }
  }
  return $null
}
`;

const NO_DATA = 'VCF Import moves no data: the VMs stay where they run';

const VERBS = {
  prepare: code`
$it = Get-AtkItem -Id $Id
$cluster = [string] (Get-AtkProp $it.source 'cluster')
if (-not $cluster) { Set-AtkOutcome failed 'the item has no source cluster'; return }
$problems = @(Get-ImportProblems $cluster)
if ($problems.Count) { Set-AtkOutcome failed "cluster $($cluster): $($problems -join '; ')" -Data @{ problems = $problems.Count }; return }
Set-AtkOutcome succeeded "cluster $cluster meets the VCF Import prerequisites the script checks (see README.md for the manual ones)" -State prepared`,
  replicate: `Set-AtkOutcome skipped '${NO_DATA}'`,
  test: `Set-AtkOutcome skipped '${NO_DATA}, so there is no test copy'`,
  'test-cleanup': `Set-AtkOutcome skipped '${NO_DATA}'`,
  cutover: code`
$d = Find-ImportedDomain
if (-not $d) { Set-AtkOutcome failed "no workload domain has vCenter $($env:VC_SRC) yet: import it in VCF Operations (paths/vcf-import/README.md), then run cutover again to verify"; return }
$name = [string] (Get-AtkProp $d 'name')
Write-AtkEvent -Item $Id -Step validate -Outcome succeeded -Detail "the vCenter is imported as workload domain $name"
Set-AtkOutcome succeeded "imported as workload domain $name" -State 'cut-over' -Data @{ domain = $name }`,
  commit: `Set-AtkOutcome skipped 'nothing to commit: the import is in place'`,
  rollback: `Set-AtkOutcome skipped 'the kit does not undo a VCF Import: the VMs never moved; removing the workload domain is a VCF Operations task (README.md)'`,
  finalize: `Set-AtkOutcome skipped 'nothing to tear down: no replica or source copy exists'`,
  status: code`
$d = Find-ImportedDomain
if ($d) { Set-AtkOutcome succeeded "imported as workload domain $([string] (Get-AtkProp $d 'name'))" -State 'cut-over'; return }
Set-AtkOutcome skipped 'not imported yet'`,
};

export function renderVcfImportScript(): string {
  return psScript({
    file: VCF_IMPORT_FILE,
    paths: PATHS,
    summary: 'VCF Import: prepare checks the prerequisites; cutover verifies the workload domain after the import, which is done in VCF Operations (no import automation).',
    modules: ['VMware.VimAutomation.Core'],
    functions: FUNCTIONS,
    verbs: VERBS,
  });
}

export function renderVcfImportReadme(items: readonly ManifestItem[], ctx: PathContext): string {
  const clusters = [...new Set(items.map((i) => i.source.cluster).filter((c): c is string => !!c))].sort();
  const configured = ctx.settings.vcfImportClusters;
  return [
    '# VCF Import (bring a vCenter under VCF in place)',
    '',
    `${items.length} VM(s) on ${clusters.length} cluster(s) (${clusters.join(', ') || 'none named'}) stay where they run; their vCenter becomes a VCF workload domain. Clusters marked for VCF Import in the plan: ${configured.join(', ') || 'none'}. **Every cluster of the vCenter is imported; there is no partial import.**`,
    '',
    'The import itself is done in VCF Operations: the kit has no import automation, because VCF 9 documents no CLI or API for it (the VCF 5.2 `vcf_brownfield.py` tool is not a supported interface in 9.x; unverified). `vcf-import.ps1` checks the prerequisites before and verifies the result after.',
    '',
    '## Steps',
    '',
    '1. `pwsh -NoProfile -File vcf-import.ps1 prepare -Wave <n>`: the prerequisite checks, one event per VM. Fix every failure it names.',
    '2. Check the manual prerequisites in the table below.',
    '3. In VCF Operations: **Inventory › VCF Instances › (the instance) › Add Workload Domain › Import a vCenter**. Give the vCenter FQDN and its SSO credentials, the NSX details when NSX is present, and follow the wizard to the end.',
    '4. `pwsh -NoProfile -File vcf-import.ps1 cutover -Wave <n>`: finds the workload domain whose vCenter matches `VC_SRC` and records cutover and validate events for every VM.',
    '',
    '## Prerequisites (VCF 9.1)',
    '',
    '| Check | Requirement | Checked by |',
    '|---|---|---|',
    ...VCF_IMPORT_PREREQUISITES.map((p) => `| ${p.check} | ${p.requirement} | ${p.by === 'script' ? '`prepare`' : 'you'} |`),
    '',
    `Source: ${VCF_IMPORT_SOURCE}`,
    '',
    'After the import, hosts are added through the vSphere Client, and VCF password management is not available for the imported domain.',
    '',
    '## Environment',
    '',
    '| Variable | What |',
    '|---|---|',
    '| `VC_SRC`, `VC_SRC_USER`, `VC_SRC_PASSWORD` | the vCenter to import (PowerCLI and its REST API) |',
    '| `NSX_MANAGER`, `NSX_USER`, `NSX_PASSWORD` | NSX, when present |',
    '| `SDDC_MANAGER`, `SDDC_MANAGER_USER`, `SDDC_MANAGER_PASSWORD` | the VCF instance, to verify the import (`GET /v1/domains`; verify on 9.1) |',
    '| `ATK_SKIP_TLS_VERIFY=1` | only where the controller does not trust the certificates yet |',
    '',
  ].join('\n');
}

export const VCF_IMPORT_GENERATOR: PathGenerator = Object.freeze({
  id: 'vcf-import',
  owner: 'WP-11b' as const,
  paths: PATHS,
  needs: [POWERCLI_NEED],
  entry: () => VCF_IMPORT_FILE,
  files(items: readonly ManifestItem[], ctx: PathContext): Readonly<Record<string, string>> {
    return {
      [VCF_IMPORT_FILE]: renderVcfImportScript(),
      [VCF_IMPORT_README]: renderVcfImportReadme(items, ctx),
    };
  },
  findings(items: readonly ManifestItem[]): readonly Finding[] {
    const clusters = [...new Set(items.map((i) => i.source.cluster).filter((c): c is string => !!c))].sort();
    return [info('exec.vcf-import.manual', `VCF Import of ${clusters.join(', ') || 'the marked clusters'} is done in VCF Operations (every cluster of the vCenter is imported); the kit checks the prerequisites before and verifies the workload domain after, and imports nothing itself.`, { source: VCF_IMPORT_SOURCE })];
  },
});

export const GENERATORS: readonly PathGenerator[] = Object.freeze([VCF_IMPORT_GENERATOR]);
