/**
 * Cross-vCenter vMotion (addendum A.6.3, WP-11b): `paths/xvc-vmotion/xvc.ps1`
 * and its placement file `paths/xvc-vmotion/xvc.json`.
 *
 * Used when both vCenters are ours (VCF on-premises) and no HCX is wanted.
 * The move is live (Advanced Cross vCenter vMotion, `Move-VM` across two
 * connected vCenters), so there is nothing to replicate or test:
 *
 *   prepare   both vCenters 7.0 U1c or later; the destination cluster,
 *             datastore, folder and mapped port groups exist; the datastore
 *             has 1.1 × the VM's used space; no snapshot, no connected CD-ROM;
 *             the destination EVC baseline is at least the source's
 *   cutover   Move-VM … -RunAsync, then Wait-Task; the source placement is
 *             kept in status/ids/xvc-vmotion.json for the rollback
 *   rollback  the reverse Move-VM to the recorded placement
 *   the rest  skipped, with the reason
 *
 * Also exports the PowerShell helpers every VMware path script shares
 * (`PS_VSPHERE_HELPERS`): vCenter connections by role (VC_SRC / VC_DST),
 * property access that survives PowerCLI type changes, and the kit folders.
 *
 * Move-VM reference: https://developer.broadcom.com/powercli/latest/vmware.vimautomation.core/commands/move-vm/
 */

                                               
import { code } from '../lib-sh.js';
import { psScript } from '../lib-ps.js';
                                                   
                                                                           
import { warning,              } from '../../../../core/findings.js';

export const MOVE_VM_SOURCE = 'https://developer.broadcom.com/powercli/latest/vmware.vimautomation.core/commands/move-vm/';
/** Advanced Cross vCenter vMotion needs the initiating vCenter at 7.0 U1c or later (vSphere 8 page; the vSphere 9 page is unverified). */
export const XVC_MIN_SOURCE = 'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vsphere/8-0/vcenter-and-host-management/migrating-virtual-machines-host-management/vmotion-across-vcenter-server-systems-host-management/requirements-for-migration-across-vcenter-servers-host-management.html';
/** vCenter 7.0 Update 1c: version 7.0.1, build 17327517 (the build number is unverified). */
export const XVC_MIN_VERSION = Object.freeze({ version: '7.0.1', build: 17327517 });

/** VCF PowerCLI, which carries VMware.VimAutomation.Core and VMware.VimAutomation.Hcx. */
export const POWERCLI_NEED           = Object.freeze({
  kind: 'pwsh-module', name: 'VCF.PowerCLI', min: '9.0', why: 'vCenter and HCX (VCF PowerCLI)', install: 'Install-PSResource VCF.PowerCLI',
});

/**
 * PowerShell shared by the VMware path scripts (placed in each script's
 * functions): the kit folders, JSON next to the script, vCenter connections
 * by role, and tolerant property access.
 *
 * Connections: `Connect-AtkVc SRC|DST` reads VC_<ROLE> (the vCenter) and
 * VC_<ROLE>_USER from the environment, and the password with
 * `Get-AtkSecret VC_<ROLE>_PASSWORD`; nothing is saved (no -SaveCredentials).
 */
export const PS_VSPHERE_HELPERS = code`
# Remove-, Set- and Stop- cmdlets never ask: the verbs are the confirmation (a dry run prints them instead).
$ConfirmPreference = 'None'
$KitHome = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$KitRoot = if ($env:ATK_ROOT) { $env:ATK_ROOT } else { Split-Path -Parent (Split-Path -Parent $KitHome) }
$script:Vc = @{}

# The first of the named properties that the object has (PowerCLI output types differ between releases).
function Get-AtkProp {
  param($Object, [string[]] $Name)
  foreach ($n in $Name) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$n]) { return $Object.$n }
  }
  return $null
}

# A JSON file next to this script.
function Read-AtkJson {
  param([string] $Name)
  $file = Join-Path $PSScriptRoot $Name
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "$Name is missing next to the script: regenerate the kit" }
  return (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json)
}

# A vCenter connection by role: SRC (the source vCenter) or DST (the destination vCenter).
function Connect-AtkVc {
  param([ValidateSet('SRC', 'DST')] [string] $Role)
  if ($script:Vc.ContainsKey($Role)) { return $script:Vc[$Role] }
  $server = [Environment]::GetEnvironmentVariable("VC_$Role")
  $user = [Environment]::GetEnvironmentVariable("VC_$($Role)_USER")
  if (-not $server -or -not $user) {
    throw "set VC_$Role and VC_$($Role)_USER; the password comes from VC_$($Role)_PASSWORD, VC_$($Role)_PASSWORD_FILE or ATK_VAULT_CMD"
  }
  $secure = ConvertTo-SecureString -String (Get-AtkSecret -Name "VC_$($Role)_PASSWORD") -AsPlainText -Force
  $cred = [System.Management.Automation.PSCredential]::new($user, $secure)
  $conn = Connect-VIServer -Server $server -Credential $cred -NotDefault -ErrorAction Stop
  $script:Vc[$Role] = $conn
  return $conn
}

# A VM by name on one vCenter (or $null).
function Find-AtkVm {
  param($Server, [string] $Name)
  return (Get-VM -Server $Server -Name $Name -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $Name } | Select-Object -First 1)
}

# A VM by its managed object id (vm-123) on one vCenter (or $null).
function Find-AtkVmById {
  param($Server, [string] $MoRef)
  if (-not $MoRef) { return $null }
  return (Get-VM -Server $Server -Id "VirtualMachine-$MoRef" -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Get-AtkMoRef {
  param($Vm)
  return [string] $Vm.ExtensionData.MoRef.Value
}

# A port group by name on one vCenter: distributed first, then standard.
function Get-AtkPortGroup {
  param($Server, [string] $Name)
  $pg = Get-VDPortgroup -Server $Server -Name $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $pg) { $pg = Get-VirtualPortGroup -Server $Server -Name $Name -Standard -ErrorAction SilentlyContinue | Select-Object -First 1 }
  return $pg
}

# The destination network for a source network, from the mapping grid (the same name when not mapped).
function Get-AtkMappedNetwork {
  param($Mappings, [string] $Source)
  foreach ($m in @($Mappings)) { if ($m.from -eq $Source) { return [string] $m.to } }
  return $Source
}

function ConvertTo-AtkDouble {
  param([string] $Text)
  return [double]::Parse($Text, [Globalization.CultureInfo]::InvariantCulture)
}
`;

export const XVC_FILE = 'paths/xvc-vmotion/xvc.ps1';
export const XVC_CONFIG = 'paths/xvc-vmotion/xvc.json';
const PATHS                      = ['xvc-vmotion'];

/** The placement every item moves to (from Execute › Settings › HCX: target container, datastore, folder, network mappings). */
                            
                                           
                
                                  
                                    
                                 
                                                                               
                                                                                                                                                  
 

export function xvcConfig(items                         , ctx             )            {
  const hcx = ctx.settings.hcx;
  return {
    kind: 'archtoolkit.xvc-vmotion',
    v: 1,
    cluster: hcx?.container ?? null,
    datastore: hcx?.datastore ?? null,
    folder: hcx?.folder ?? null,
    mappings: (hcx?.mappings ?? []).map((m) => ({ from: m.from, to: m.to })),
    items: items.map((i) => ({ id: i.id, name: i.name, sourceCluster: i.source.cluster ?? null, moref: i.source.id ?? null })),
  };
}

const FUNCTIONS = code`
${PS_VSPHERE_HELPERS.trim()}

$Config = Read-AtkJson 'xvc.json'

# Advanced Cross vCenter vMotion needs 7.0 U1c or later at both ends.
function Test-XvcVersion {
  param($Conn)
  $v = [version] $Conn.Version
  $min = [version] '${XVC_MIN_VERSION.version}'
  if ($v -gt $min) { return $true }
  if ($v -lt $min) { return $false }
  return ([int] $Conn.Build -ge ${XVC_MIN_VERSION.build})
}

# The EVC baseline of a cluster as (vendor, tier), from the vCenter's supported EVC modes; $null when EVC is off.
function Get-XvcEvc {
  param($Server, $Cluster)
  $mode = [string] $Cluster.EVCMode
  if (-not $mode) { return $null }
  $si = Get-View ServiceInstance -Server $Server
  $m = @($si.Capability.SupportedEVCMode) | Where-Object { $_.Key -eq $mode } | Select-Object -First 1
  if (-not $m) { return [pscustomobject] @{ Mode = $mode; Vendor = ''; Tier = -1 } }
  return [pscustomobject] @{ Mode = $mode; Vendor = [string] $m.Vendor; Tier = [int] $m.VendorTier }
}

# What stops the move, one line each (empty: ready).
function Get-XvcProblems {
  param($Vm, $Src, $Dst)
  $problems = @()
  if (-not $Config.cluster) { return @('no destination cluster: set the target container under Execute > Settings > HCX') }
  $cluster = Get-Cluster -Server $Dst -Name $Config.cluster -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cluster) { $problems += "the destination cluster $($Config.cluster) does not exist"; return $problems }
  if ($Config.datastore) {
    $ds = Get-Datastore -Server $Dst -Name $Config.datastore -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $ds) { $problems += "the destination datastore $($Config.datastore) does not exist" }
    elseif ([double] $ds.FreeSpaceGB -lt 1.1 * [double] $Vm.UsedSpaceGB) { $problems += "datastore $($ds.Name) has $([math]::Round($ds.FreeSpaceGB)) GB free; the VM needs 1.1 x $([math]::Round($Vm.UsedSpaceGB)) GB" }
  } else {
    $problems += 'no destination datastore: set it under Execute > Settings > HCX'
  }
  if ($Config.folder -and -not (Get-Folder -Server $Dst -Name $Config.folder -Type VM -ErrorAction SilentlyContinue)) { $problems += "the destination VM folder $($Config.folder) does not exist" }
  foreach ($nic in @(Get-NetworkAdapter -VM $Vm)) {
    $to = Get-AtkMappedNetwork $Config.mappings $nic.NetworkName
    if (-not (Get-AtkPortGroup $Dst $to)) { $problems += "the destination port group $to (for $($nic.NetworkName)) does not exist" }
  }
  if (@(Get-Snapshot -VM $Vm -ErrorAction SilentlyContinue).Count -gt 0) { $problems += 'the VM has snapshots: consolidate them first' }
  if (@(Get-CDDrive -VM $Vm | Where-Object { $_.ConnectionState.Connected }).Count -gt 0) { $problems += 'the VM has a connected CD-ROM: disconnect it first' }
  $srcEvc = Get-XvcEvc $Src (Get-Cluster -VM $Vm -Server $Src)
  $dstEvc = Get-XvcEvc $Dst $cluster
  if ($srcEvc -and $dstEvc) {
    if ($srcEvc.Vendor -ne $dstEvc.Vendor -or $dstEvc.Tier -lt $srcEvc.Tier) { $problems += "the destination EVC baseline ($($dstEvc.Mode)) is below the source's ($($srcEvc.Mode))" }
  } elseif ($srcEvc -and -not $dstEvc) {
    Write-AtkLog "the destination cluster has no EVC baseline: vCenter checks CPU compatibility per host during the move"
  }
  return $problems
}

function Get-XvcPlacement {
  param($Vm, $Server)
  $cl = Get-Cluster -VM $Vm -Server $Server
  $ds = Get-Datastore -RelatedObject $Vm | Select-Object -First 1
  $nets = @(Get-NetworkAdapter -VM $Vm | ForEach-Object { $_.NetworkName }) -join '|'
  return (@([string] $cl.Name, [string] $ds.Name, [string] $Vm.Folder.Name, $nets) -join ';')
}

# Move a VM between the two vCenters: -NetworkAdapter and -PortGroup pair up by position.
function Move-XvcVm {
  param($Vm, $To, [string] $Cluster, [string] $Datastore, [string] $Folder, [string[]] $Networks)
  $move = @{
    VM = $Vm
    Destination = (Get-Cluster -Server $To -Name $Cluster | Get-ResourcePool -Name 'Resources')
    NetworkAdapter = @(Get-NetworkAdapter -VM $Vm)
    PortGroup = @($Networks | ForEach-Object { Get-AtkPortGroup $To $_ })
    DiskStorageFormat = 'Thin'
    RunAsync = $true
  }
  if ($Datastore) { $move.Datastore = Get-Datastore -Server $To -Name $Datastore }
  if ($Folder) { $move.InventoryLocation = Get-Folder -Server $To -Name $Folder -Type VM | Select-Object -First 1 }
  $task = Invoke-AtkStep "move $($Vm.Name) to $Cluster on $($To.Name)" { Move-VM @move }
  if ($task) { $null = Wait-Task -Task $task }
}
`;

const VERBS = {
  prepare: code`
$it = Get-AtkItem -Id $Id
$src = Connect-AtkVc SRC
$dst = Connect-AtkVc DST
foreach ($c in @($src, $dst)) {
  if (-not (Test-XvcVersion $c)) { Set-AtkOutcome failed "$($c.Name) is vCenter $($c.Version) build $($c.Build): Cross vCenter vMotion needs 7.0 U1c or later at both ends"; return }
}
if (Find-AtkVm $dst $it.name) { Set-AtkOutcome skipped 'already on the destination vCenter' -State 'cut-over'; return }
$vm = Find-AtkVm $src $it.name
if (-not $vm) { Set-AtkOutcome failed "$($it.name) is on neither vCenter"; return }
$problems = @(Get-XvcProblems $vm $src $dst)
if ($problems.Count) { Set-AtkOutcome failed ($problems -join '; ') -Data @{ problems = $problems.Count }; return }
Set-AtkOutcome succeeded 'ready for Cross vCenter vMotion' -State prepared`,
  replicate: `Set-AtkOutcome skipped 'Cross vCenter vMotion copies the VM live at cutover: nothing replicates before it'`,
  test: `Set-AtkOutcome skipped 'the move is live, so there is no test copy; rehearse on a non-production VM (gate G2)'`,
  'test-cleanup': `Set-AtkOutcome skipped 'no test copy to remove'`,
  cutover: code`
$it = Get-AtkItem -Id $Id
$src = Connect-AtkVc SRC
$dst = Connect-AtkVc DST
$done = Find-AtkVm $dst $it.name
if ($done) { Set-AtkOutcome skipped 'already on the destination vCenter' -State 'cut-over' -Data @{ targetMoref = (Get-AtkMoRef $done) }; return }
$vm = Find-AtkVm $src $it.name
if (-not $vm) { Set-AtkOutcome failed "$($it.name) is on neither vCenter"; return }
$problems = @(Get-XvcProblems $vm $src $dst)
if ($problems.Count) { Set-AtkOutcome failed ($problems -join '; '); return }
Set-AtkId -Path 'xvc-vmotion' -Key $Id -Value (Get-XvcPlacement $vm $src)
$nets = @(Get-NetworkAdapter -VM $vm | ForEach-Object { Get-AtkMappedNetwork $Config.mappings $_.NetworkName })
Move-XvcVm -Vm $vm -To $dst -Cluster $Config.cluster -Datastore $Config.datastore -Folder $Config.folder -Networks $nets
$moved = Find-AtkVm $dst $it.name
$data = @{}
if ($moved) { $data.targetMoref = Get-AtkMoRef $moved }
Set-AtkOutcome succeeded 'moved live to the destination vCenter' -State 'cut-over' -Data $data`,
  commit: `Set-AtkOutcome skipped 'nothing to commit: the VM moved whole and the source vCenter keeps no copy'`,
  rollback: code`
$it = Get-AtkItem -Id $Id
$src = Connect-AtkVc SRC
$dst = Connect-AtkVc DST
if (Find-AtkVm $src $it.name) { Set-AtkOutcome skipped 'already on the source vCenter'; return }
$vm = Find-AtkVm $dst $it.name
if (-not $vm) { Set-AtkOutcome failed "$($it.name) is on neither vCenter"; return }
$placement = Get-AtkId -Path 'xvc-vmotion' -Key $Id
if (-not $placement) { Set-AtkOutcome failed 'no record of the source placement (status/ids/xvc-vmotion.json): move it back by hand'; return }
$cluster, $datastore, $folder, $nets = ([string] $placement) -split ';', 4
Move-XvcVm -Vm $vm -To $src -Cluster $cluster -Datastore $datastore -Folder $folder -Networks @($nets -split '\|')
Set-AtkOutcome succeeded 'moved back to the source vCenter'`,
  finalize: `Set-AtkOutcome skipped 'nothing to tear down: Cross vCenter vMotion leaves no replica'`,
  status: code`
$it = Get-AtkItem -Id $Id
$dst = Connect-AtkVc DST
$vm = Find-AtkVm $dst $it.name
if ($vm) { Set-AtkOutcome succeeded 'on the destination vCenter' -State 'cut-over' -Data @{ targetMoref = (Get-AtkMoRef $vm) }; return }
Set-AtkOutcome skipped 'on the source vCenter: the move is live at cutover, nothing replicates'`,
};

export function renderXvcScript()         {
  return psScript({
    file: XVC_FILE,
    paths: PATHS,
    summary: 'Cross vCenter vMotion between two vCenters you run (VCF on-premises): a live move at cutover, with the reverse move as the rollback.',
    modules: ['VMware.VimAutomation.Core'],
    functions: FUNCTIONS,
    verbs: VERBS,
  });
}

export const XVC_GENERATOR                = Object.freeze({
  id: 'xvc-vmotion',
  owner: 'WP-11b'         ,
  paths: PATHS,
  needs: [POWERCLI_NEED],
  entry: () => XVC_FILE,
  files(items                         , ctx             )                                   {
    return {
      [XVC_FILE]: renderXvcScript(),
      [XVC_CONFIG]: `${JSON.stringify(xvcConfig(items, ctx), null, 2)}\n`,
    };
  },
  findings(items                         , ctx             )                     {
    const out            = [];
    const hcx = ctx.settings.hcx;
    if (!hcx?.container || !hcx.datastore) {
      out.push(warning('exec.xvc.no-placement', `Cross vCenter vMotion has ${items.length} item(s) but no destination cluster or datastore: prepare fails until they are set.`, {
        remediation: 'Set the target container and datastore under Execute › Settings › HCX (Cross vCenter vMotion uses the same placement).',
      }));
    }
    return out;
  },
});

export const GENERATORS                           = Object.freeze([XVC_GENERATOR]);
