/**
 * The Azure Migrate paths (addendum A.6.6, A.3.4): `azure-migrate` (agentless
 * VMware), `azure-migrate-hyperv` (agentless Hyper-V) and
 * `azure-migrate-agent` (agent-based: physical servers, other hypervisors,
 * other clouds).
 *
 * azurerm has no Azure Migrate resource, and `az migrate` covers Azure Local
 * only, so everything is PowerShell with Az.Migrate:
 *   paths/azure-migrate/azmigrate.ps1   the verbs, for all three paths
 *   paths/azure-migrate/servers.json    per item: target VM name, size, network, zone, licences, disk and security type
 *   paths/azure-migrate/README.md       the appliance, the portal step of the agent path, the environment
 *   ansible/azure-mobility.yml          the Mobility service for the agent path
 *
 * The Az.Migrate cmdlets drive agentless VMware and Hyper-V only; the agent
 * path installs the Mobility service, has replication enabled in the portal
 * (a runbook step, at most ten servers a batch), then tests and migrates
 * through the Site Recovery REST API on the migration item
 * (https://learn.microsoft.com/en-us/rest/api/site-recovery/replication-migration-items).
 * Cutover shuts the source down: `-TurnOffSourceServer` (agentless), and
 * `performShutdown` (agent).
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import type { ExecPath } from '../contract.ts';
import { psScript } from '../lib-ps.ts';
import { code } from '../lib-sh.ts';
import type { ManifestItem } from '../manifest.ts';
import type { PathContext, PathGenerator, ToolNeed } from '../registry.ts';
import { jsonText, placementOf, subnetKey, vmName, type Placement } from './cloud-shared.ts';

const DIR = 'paths/azure-migrate';
export const AZMIGRATE_SCRIPT = `${DIR}/azmigrate.ps1`;
const PATHS: readonly ExecPath[] = ['azure-migrate', 'azure-migrate-hyperv', 'azure-migrate-agent'];

/** The Site Recovery API version the agent path calls (to verify against the REST reference). */
export const SITE_RECOVERY_API_VERSION = '2024-10-01';

export const AZMIGRATE_NEEDS: readonly ToolNeed[] = Object.freeze([
  { kind: 'pwsh-module', name: 'Az.Accounts', why: 'signing in to Azure' },
  { kind: 'pwsh-module', name: 'Az.Migrate', why: 'Azure Migrate replication, test migration and migration' },
  { kind: 'pwsh-module', name: 'Az.Compute', why: 'the migrated VMs (rollback, addresses)' },
  { kind: 'pwsh-module', name: 'Az.Network', why: 'the migrated VMs\' addresses' },
  { kind: 'pwsh-module', name: 'Az.Resources', why: 'finding the Recovery Services vault' },
  { kind: 'command', name: 'terraform', min: '1.7', why: 'reading the Azure landing zone outputs' },
]);
const AGENT_NEEDS: readonly ToolNeed[] = Object.freeze([
  { kind: 'command', name: 'ansible-playbook', why: 'installing the Azure Migrate Mobility service' },
  { kind: 'ansible-collection', name: 'ansible.windows', why: 'the Mobility service on Windows sources' },
]);

type SourceType = 'VMware' | 'HyperV' | 'Physical';
const SOURCE_TYPE: Readonly<Record<string, SourceType>> = { 'azure-migrate': 'VMware', 'azure-migrate-hyperv': 'HyperV', 'azure-migrate-agent': 'Physical' };

interface ServerEntry {
  readonly name: string;
  readonly vmName: string;
  readonly sourceType: SourceType;
  readonly size: string;
  readonly network: string;
  readonly subnet: string;
  readonly testNetwork: string;
  readonly testSubnet: string;
  readonly zone?: string;
  readonly licenseType: 'WindowsServer' | 'NoLicenseType';
  readonly linuxLicenseType?: 'LinuxServer';
  readonly sqlServerLicenseType?: 'AHUB' | 'PAYG';
  readonly securityType: 'TrustedLaunch' | 'None';
  readonly diskType: string;
  readonly wave: number | null;
}

function serverEntry(item: ManifestItem, p: Placement, ctx: PathContext): ServerEntry {
  const s = ctx.settings.azureMigrate;
  const efi = p.workload?.facts?.firmware === 'efi';
  const sqlHost = ctx.plan.databases.some((d) => d.engine === 'sqlserver' && d.hosts.includes(item.name));
  const ahb = p.licence === 'ahb';
  return {
    name: item.name,
    vmName: vmName(item.name),
    sourceType: SOURCE_TYPE[item.path] ?? 'VMware',
    size: p.size,
    network: p.network,
    subnet: subnetKey(p.network, p.tier, p.zoneLetter),
    testNetwork: p.testNetwork,
    testSubnet: subnetKey(p.testNetwork, p.tier, p.zoneLetter),
    zone: String(p.zoneIndex + 1),
    licenseType: p.windows && ahb ? 'WindowsServer' : 'NoLicenseType',
    ...(!p.windows && (p.licence === 'rhel-byos' || p.licence === 'sles-byos') ? { linuxLicenseType: 'LinuxServer' as const } : {}),
    ...(sqlHost ? { sqlServerLicenseType: ahb ? 'AHUB' as const : 'PAYG' as const } : {}),
    securityType: s?.securityType === 'None' || !efi ? 'None' : 'TrustedLaunch',
    diskType: s?.diskType ?? 'Premium_LRS',
    wave: item.wave,
  };
}

const FUNCTIONS = (project: string, lagSeconds: number): string => code`
$AtkKit = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$AtkRoot = if ($env:ATK_ROOT) { $env:ATK_ROOT } else { (Resolve-Path (Join-Path $AtkKit '../..')).Path }
$Servers = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'servers.json') -Raw | ConvertFrom-Json -AsHashtable
$Project = if ($env:AZ_MIGRATE_PROJECT) { $env:AZ_MIGRATE_PROJECT } else { '${project}' }
$ApiVersion = if ($env:AZ_SITE_RECOVERY_API_VERSION) { $env:AZ_SITE_RECOVERY_API_VERSION } else { @(${SITE_RECOVERY_API_VERSION.split('-').map((p) => `'${p}'`).join(', ')}) -join '-' }
$LagSeconds = ${lagSeconds}
$Inventory = if ($env:ATK_INVENTORY) { $env:ATK_INVENTORY } else { Join-Path $AtkRoot 'ansible/inventory' }
$AtkPlan8 = (Get-Content -LiteralPath (Join-Path $AtkKit 'manifest/items.json') -Raw | ConvertFrom-Json).planId8
$script:Lz = $null

# The Azure landing zone (the stack's landing_zone output, or <item>_landing_zone in a stack).
function Get-AtkLandingZone {
  if ($script:Lz) { return $script:Lz }
  $dir = if ($env:ATK_TF_AZURE_DIR) { $env:ATK_TF_AZURE_DIR } else { Join-Path $AtkRoot 'terraform/azure' }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Stop-Atk 5 "no Terraform stack at $($dir): apply the Azure stack first, or set ATK_TF_AZURE_DIR" }
  $json = & terraform "-chdir=$dir" output -json
  if ($LASTEXITCODE) { Stop-Atk 5 "terraform output failed in $dir" }
  $all = ($json -join [char]10) | ConvertFrom-Json -AsHashtable
  $key = @($all.Keys | Where-Object { $_ -eq 'landing_zone' -or $_.EndsWith('_landing_zone') } | Sort-Object)[0]
  if (-not $key) { Stop-Atk 5 "the stack in $dir has no landing_zone output" }
  $script:Lz = $all[$key].value
  return $script:Lz
}

# Sign in once: an existing context for the subscription, a federated service principal, or the managed identity.
function Connect-AtkAzure {
  $sub = (Get-AtkLandingZone).subscription_id
  $ctx = Get-AzContext -ErrorAction SilentlyContinue
  if ($ctx -and $ctx.Subscription -and $ctx.Subscription.Id -eq $sub) { return }
  if ($env:AZURE_FEDERATED_TOKEN_FILE -and $env:AZURE_CLIENT_ID -and $env:AZURE_TENANT_ID) {
    $federated = Get-Content -LiteralPath $env:AZURE_FEDERATED_TOKEN_FILE -Raw
    $null = Connect-AzAccount -ServicePrincipal -ApplicationId $env:AZURE_CLIENT_ID -Tenant $env:AZURE_TENANT_ID -FederatedToken $federated -Subscription $sub
  } else {
    $null = Connect-AzAccount -Identity -Subscription $sub
  }
}

function Get-AtkMigrateGroup {
  if ($env:AZ_MIGRATE_RESOURCE_GROUP) { return $env:AZ_MIGRATE_RESOURCE_GROUP }
  $rg = (Get-AtkLandingZone).resource_group
  if ($rg.ContainsKey('shared') -and $rg['shared']) { return $rg['shared'] }
  return @($rg.Values | Sort-Object)[0]
}

function Get-AtkServer {
  param([string] $Id)
  $s = $Servers[$Id]
  if (-not $s) { Stop-Atk 5 "no settings for $Id in servers.json: the design has no Azure compute target for it; regenerate the kit" }
  return $s
}

function Get-AtkSubnetName {
  param([string] $Key)
  $sid = (Get-AtkLandingZone).subnet_ids[$Key]
  if (-not $sid) { Stop-Atk 5 "no subnet $Key in the landing zone" }
  return ($sid -split '/')[-1]
}

# The server as Azure Migrate discovered it (the appliance must be discovering).
function Get-AtkDiscovered {
  param([string] $Id)
  $s = Get-AtkServer $Id
  $found = Get-AzMigrateDiscoveredServer -ProjectName $Project -ResourceGroupName (Get-AtkMigrateGroup) -DisplayName $s.name -SourceMachineType $s.sourceType
  return @($found | Where-Object { $_.DisplayName -ieq $s.name })[0]
}

function Get-AtkReplication {
  param([string] $Id)
  $d = Get-AtkDiscovered $Id
  if (-not $d) { return $null }
  return Get-AzMigrateServerReplication -DiscoveredMachineId $d.Id -ErrorAction SilentlyContinue
}

# A job, polled until it ends; stops the item when it does not succeed.
function Wait-AtkJob {
  param($Job, [string] $What)
  if (-not $Job) { return }
  $ok = Wait-AtkUntil -Minutes 180 -IntervalSeconds 30 { (Get-AzMigrateJob -JobID $Job.Id).State -in @('Succeeded', 'Failed', 'Cancelled', 'CompletedWithInformation') }
  $state = (Get-AzMigrateJob -JobID $Job.Id).State
  if (-not $ok -or $state -notin @('Succeeded', 'CompletedWithInformation')) { throw "the $What job ended $state" }
}

# The target VM's resource id and addresses, as event data.
function Get-AtkVmData {
  param([string] $Group, [string] $Name)
  $vm = Get-AzVM -ResourceGroupName $Group -Name $Name -ErrorAction SilentlyContinue
  if (-not $vm) { return @{} }
  $data = @{ vmId = $vm.Id }
  $nicId = @($vm.NetworkProfile.NetworkInterfaces)[0].Id
  if ($nicId) {
    $nic = Get-AzNetworkInterface -ResourceId $nicId
    $v4 = @($nic.IpConfigurations | Where-Object { $_.PrivateIpAddressVersion -ne 'IPv6' })[0]
    $v6 = @($nic.IpConfigurations | Where-Object { $_.PrivateIpAddressVersion -eq 'IPv6' })[0]
    if ($v4) { $data.targetIpv4 = $v4.PrivateIpAddress }
    if ($v6) { $data.targetIpv6 = $v6.PrivateIpAddress }
  }
  return $data
}

function Get-AtkTargetGroup {
  param([string] $Network)
  $rg = (Get-AtkLandingZone).resource_group[$Network]
  if (-not $rg) { Stop-Atk 5 "no resource group for network $Network in the landing zone" }
  return $rg
}

# ------------------------------------------------------------------ the agent path (Site Recovery REST)

function Get-AtkVaultId {
  $rg = Get-AtkMigrateGroup
  if ($env:AZ_MIGRATE_VAULT) { return "/subscriptions/$((Get-AtkLandingZone).subscription_id)/resourceGroups/$rg/providers/Microsoft.RecoveryServices/vaults/$($env:AZ_MIGRATE_VAULT)" }
  $vaults = @(Get-AzResource -ResourceGroupName $rg -ResourceType 'Microsoft.RecoveryServices/vaults')
  if ($vaults.Count -ne 1) { Stop-Atk 5 "found $($vaults.Count) Recovery Services vaults in $($rg): set AZ_MIGRATE_VAULT to the Azure Migrate project's vault" }
  return $vaults[0].ResourceId
}

function Invoke-AtkAzRest {
  param([string] $Method, [string] $Path, $Body = $null)
  $sep = if ($Path.Contains('?')) { '&' } else { '?' }
  $call = @{ Method = $Method; Path = "$Path$($sep)api-version=$ApiVersion" }
  if ($null -ne $Body) { $call.Payload = ($Body | ConvertTo-Json -Depth 10 -Compress) }
  $r = Invoke-AzRestMethod @call
  if ($r.StatusCode -ge 400) { throw "Azure REST $Method $Path failed ($($r.StatusCode)): $($r.Content)" }
  if ($r.Content) { return ($r.Content | ConvertFrom-Json -AsHashtable) }
  return $null
}

# The migration item of an agent-based server, by machine name (replication is enabled in the portal).
function Get-AtkMigrationItem {
  param([string] $Id)
  $name = (Get-AtkServer $Id).name
  $path = "$(Get-AtkVaultId)/replicationMigrationItems"
  while ($path) {
    $page = Invoke-AtkAzRest GET $path
    $hit = @($page.value | Where-Object { $_.properties.machineName -ieq $name })[0]
    if ($hit) { return $hit }
    $path = if ($page.nextLink) { ([uri] $page.nextLink).PathAndQuery -replace '[?&]api-version=[^&]*', '' } else { $null }
  }
  return $null
}

function Get-AtkItemProgress {
  param($Properties)
  $p = $Properties.providerSpecificDetails
  foreach ($k in 'initialSeedingProgressPercentage', 'initialReplicationProgressPercentage', 'resyncProgressPercentage') {
    if ($p -and $p.ContainsKey($k) -and $null -ne $p[$k]) { return [int] $p[$k] }
  }
  return 0
}

function Invoke-AtkValidate {
  param([string] $Id, [string] $Address)
  $play = Join-Path $AtkKit 'ansible/validate.yml'
  if (-not (Test-Path -LiteralPath $play -PathType Leaf)) { Write-AtkLog 'ansible/validate.yml is not in this kit: the test migration is not validated'; return 'failed' }
  $ok = Invoke-AtkStep "validate the test migration of $Id" {
    & ansible-playbook -i $Inventory $play --limit (Get-AtkItem -Id $Id).name -e validate_phase=test -e "validate_item=$Id" -e "validate_address=$Address" | Out-Host
    $LASTEXITCODE -eq 0
  }
  if ($ok -eq $true) { return 'passed' }
  return 'failed'
}
`;

const V = {
  prepare: code`
Connect-AtkAzure
$s = Get-AtkServer $Id
$rg = Get-AtkMigrateGroup
$lz = Get-AtkLandingZone
if (-not (Get-AzMigrateProject -Name $Project -ResourceGroupName $rg -ErrorAction SilentlyContinue)) {
  Invoke-AtkStep "create the Azure Migrate project $Project" { $null = New-AzMigrateProject -Name $Project -ResourceGroupName $rg -Location $lz.location }
}
if ($s.sourceType -eq 'Physical') {
  $ip = $env:AZ_MIGRATE_APPLIANCE_IP
  if (-not $ip) { Stop-Atk 3 'AZ_MIGRATE_APPLIANCE_IP is not set: the replication appliance the Mobility service registers with' }
  if (Get-AtkMigrationItem $Id) { Set-AtkOutcome skipped 'replication is already enabled for this server' -State prepared; return }
  Invoke-AtkStep "install the Mobility service on $($s.name)" {
    & ansible-playbook -i $Inventory (Join-Path $AtkKit 'ansible/azure-mobility.yml') --limit $s.name -e "azure_migrate_appliance_ip=$ip" | Out-Host
    if ($LASTEXITCODE) { throw "azure-mobility.yml failed (exit $LASTEXITCODE)" }
  }
  Set-AtkOutcome succeeded 'Mobility service installed; enable replication for it in the Azure Migrate portal (README, step 3; at most ten servers a batch), then run replicate' -State prepared
  return
}
$scenario = if ($s.sourceType -eq 'HyperV') { 'agentlessHyperV' } else { 'agentlessVMware' }
Invoke-AtkStep "prepare the replication infrastructure ($scenario, $($lz.location))" {
  $null = Initialize-AzMigrateReplicationInfrastructure -ResourceGroupName $rg -ProjectName $Project -Scenario $scenario -TargetRegion $lz.location
}
$d = Get-AtkDiscovered $Id
if (-not $d) { Set-AtkOutcome failed "not discovered by the Azure Migrate appliance: check the appliance is discovering (README, step 1)"; return }
Set-AtkOutcome succeeded '' -State prepared -Data @{ machineId = $d.Id }
`,
  replicate: code`
Connect-AtkAzure
$s = Get-AtkServer $Id
if ($s.sourceType -eq 'Physical') {
  $item = Get-AtkMigrationItem $Id
  if (-not $item) { Set-AtkOutcome failed 'replication is not enabled: enable it in the Azure Migrate portal (README, step 3)'; return }
  $state = $item.properties.migrationState
  if ($state -eq 'Replicating') { Set-AtkOutcome succeeded '' -State in-sync -Data @{ inSync = $true; progressPct = 100; migrationState = $state }; return }
  Set-AtkOutcome succeeded '' -State replicating -Data @{ progressPct = (Get-AtkItemProgress $item.properties); migrationState = $state }
  return
}
$r = Get-AtkReplication $Id
if (-not $r) {
  $d = Get-AtkDiscovered $Id
  if (-not $d) { Set-AtkOutcome failed 'not discovered by the Azure Migrate appliance: run prepare'; return }
  $lz = Get-AtkLandingZone
  $p = @{
    MachineId = $d.Id
    TargetVMName = $s.vmName
    TargetResourceGroupId = "/subscriptions/$($lz.subscription_id)/resourceGroups/$(Get-AtkTargetGroup $s.network)"
    TargetNetworkId = $lz.network_ids[$s.network]
    TargetSubnetName = Get-AtkSubnetName $s.subnet
    TestNetworkId = $lz.network_ids[$s.testNetwork]
    TestSubnetName = Get-AtkSubnetName $s.testSubnet
    TargetVMSize = $s.size
    LicenseType = $s.licenseType
    PerformAutoResync = 'true'
  }
  if ($s.zone) { $p.TargetAvailabilityZone = $s.zone }
  $cmd = Get-Command -Name 'New-AzMigrateServerReplication'
  $optional = @{ SqlServerLicenseType = $s.sqlServerLicenseType; LinuxLicenseType = $s.linuxLicenseType; TargetSecurityType = $s.securityType }
  foreach ($k in @($optional.Keys | Sort-Object)) {
    if (-not $optional[$k]) { continue }
    if ($cmd.Parameters.ContainsKey($k)) { $p[$k] = $optional[$k] } else { Write-AtkLog "this Az.Migrate has no -$k; it is left at the service default" }
  }
  $tags = @{ atk_plan = $AtkPlan8; atk_item = $Id; atk_wave = [string] $s.wave }
  if ($cmd.Parameters.ContainsKey('VMTag')) { $p.VMTag = $tags }
  $disks = @($d.Disk)
  Invoke-AtkStep "enable replication of $($s.name)" {
    if ($disks.Count -gt 1) {
      $p.DiskToInclude = @(for ($i = 0; $i -lt $disks.Count; $i++) { New-AzMigrateDiskMapping -DiskID $disks[$i].Uuid -IsOSDisk $(if ($i -eq 0) { 'true' } else { 'false' }) -DiskType $s.diskType })
    } else {
      $p.OSDiskID = $disks[0].Uuid
      $p.DiskType = $s.diskType
    }
    $null = New-AzMigrateServerReplication @p
  }
  Set-AtkOutcome succeeded 'replication enabled' -State replicating -Data @{ progressPct = 0 }
  return
}
$null = Wait-AtkUntil -Minutes 1440 -IntervalSeconds 60 { (Get-AtkReplication $Id).MigrationState -eq 'Replicating' }
$r = Get-AtkReplication $Id
$state = [string] $r.MigrationState
if ($state -eq 'Replicating') { Set-AtkOutcome succeeded '' -State in-sync -Data @{ inSync = $true; progressPct = 100; migrationState = $state }; return }
$pct = [int] $r.ProviderSpecificDetail.InitialSeedingProgressPercentage
Set-AtkOutcome succeeded '' -State replicating -Data @{ progressPct = $pct; migrationState = $state }
`,
  test: code`
Connect-AtkAzure
$s = Get-AtkServer $Id
$lz = Get-AtkLandingZone
$group = Get-AtkTargetGroup $s.network
if ($s.sourceType -eq 'Physical') {
  $item = Get-AtkMigrationItem $Id
  if (-not $item) { Set-AtkOutcome failed 'replication is not enabled: enable it in the Azure Migrate portal'; return }
  if ($item.properties.testMigrateState -eq 'TestMigrationSucceeded') { Set-AtkOutcome skipped 'a test migration is already up' -State testing; return }
  if ($item.properties.migrationState -ne 'Replicating') { Set-AtkOutcome failed "a test migration needs Replicating; it is $($item.properties.migrationState)"; return }
  $points = Invoke-AtkAzRest GET "$($item.id)/migrationRecoveryPoints"
  $point = @($points.value | Sort-Object { $_.properties.recoveryPointTime })[-1]
  $body = @{ properties = @{ providerSpecificDetails = @{ instanceType = 'InMageRcm'; recoveryPointId = $point.id; networkId = $lz.network_ids[$s.testNetwork] } } }
  $started = Invoke-AtkStep "test migration of $($s.name)" { $null = Invoke-AtkAzRest POST "$($item.id)/testMigrate" $body; $true }
  if (-not $started) { Set-AtkOutcome succeeded 'dry run: the test migration was printed' -State testing; return }
  $ok = Wait-AtkUntil -Minutes 180 -IntervalSeconds 30 { (Get-AtkMigrationItem $Id).properties.testMigrateState -in @('TestMigrationSucceeded', 'TestMigrationFailed') }
  if (-not $ok -or (Get-AtkMigrationItem $Id).properties.testMigrateState -ne 'TestMigrationSucceeded') { Set-AtkOutcome failed 'the test migration did not succeed'; return }
} else {
  $r = Get-AtkReplication $Id
  if (-not $r) { Set-AtkOutcome failed 'not replicating: run replicate'; return }
  if ($r.TestMigrateState -eq 'TestMigrationSucceeded') { Set-AtkOutcome skipped 'a test migration is already up' -State testing -Data (Get-AtkVmData $group "$($s.vmName)-test"); return }
  if ($r.MigrationState -ne 'Replicating') { Set-AtkOutcome failed "a test migration needs Replicating; it is $($r.MigrationState)"; return }
  $job = Invoke-AtkStep "test migration of $($s.name)" { Start-AzMigrateTestMigration -TargetObjectID $r.Id -TestNetworkID $lz.network_ids[$s.testNetwork] }
  if (-not $job) { Set-AtkOutcome succeeded 'dry run: the test migration was printed' -State testing; return }
  Wait-AtkJob $job 'test migration'
}
$data = Get-AtkVmData $group "$($s.vmName)-test"
$passed = Invoke-AtkValidate $Id ([string] $data.targetIpv4)
Set-AtkId -Path azure-migrate -Key "test:$Id" -Value $passed
$data.validated = $passed
Set-AtkOutcome succeeded '' -State testing -Data $data
`,
  'test-cleanup': code`
Connect-AtkAzure
$s = Get-AtkServer $Id
$passed = [string] (Get-AtkId -Path azure-migrate -Key "test:$Id")
if ($s.sourceType -eq 'Physical') {
  $item = Get-AtkMigrationItem $Id
  if (-not $item) { Set-AtkOutcome failed 'replication is not enabled'; return }
  if ($item.properties.testMigrateState -in @('None', 'TestMigrationCleanupSucceeded', $null)) { Set-AtkOutcome skipped 'no test migration to clean up' -Data @{ passed = ($passed -eq 'passed') }; return }
  $done = Invoke-AtkStep "clean up the test migration of $($s.name)" { $null = Invoke-AtkAzRest POST "$($item.id)/testMigrateCleanup" @{ properties = @{ comments = 'atk test cleanup' } }; $true }
  if ($done) { $null = Wait-AtkUntil -Minutes 60 -IntervalSeconds 30 { (Get-AtkMigrationItem $Id).properties.testMigrateState -notin @('TestMigrationSucceeded', 'TestMigrationCleanupInProgress') } }
} else {
  $r = Get-AtkReplication $Id
  if (-not $r) { Set-AtkOutcome failed 'not replicating'; return }
  if ($r.TestMigrateState -in @('None', 'TestMigrationCleanupSucceeded', $null, '')) { Set-AtkOutcome skipped 'no test migration to clean up' -Data @{ passed = ($passed -eq 'passed') }; return }
  $job = Invoke-AtkStep "clean up the test migration of $($s.name)" { Start-AzMigrateTestMigrationCleanup -TargetObjectID $r.Id }
  Wait-AtkJob $job 'test migration clean-up'
}
Set-AtkOutcome succeeded '' -Data @{ passed = ($passed -eq 'passed') }
`,
  cutover: code`
Connect-AtkAzure
$s = Get-AtkServer $Id
$group = Get-AtkTargetGroup $s.network
if ($s.sourceType -eq 'Physical') {
  $item = Get-AtkMigrationItem $Id
  if (-not $item) { Set-AtkOutcome failed 'replication is not enabled'; return }
  if ($item.properties.migrationState -eq 'MigrationSucceeded') { Set-AtkOutcome skipped 'already migrated' -State cut-over -Data (Get-AtkVmData $group $s.vmName); return }
  if ($item.properties.migrationState -ne 'Replicating') { Set-AtkOutcome failed "migration needs Replicating; it is $($item.properties.migrationState)"; return }
  $body = @{ properties = @{ providerSpecificDetails = @{ instanceType = 'InMageRcm'; performShutdown = 'true' } } }
  $started = Invoke-AtkStep "migrate $($s.name), shutting the source down" { $null = Invoke-AtkAzRest POST "$($item.id)/migrate" $body; $true }
  if (-not $started) { Set-AtkOutcome succeeded 'dry run: the migration was printed' -State cut-over; return }
  $ok = Wait-AtkUntil -Minutes 240 -IntervalSeconds 30 { (Get-AtkMigrationItem $Id).properties.migrationState -in @('MigrationSucceeded', 'MigrationFailed') }
  if (-not $ok -or (Get-AtkMigrationItem $Id).properties.migrationState -ne 'MigrationSucceeded') { Set-AtkOutcome failed 'the migration did not succeed'; return }
} else {
  $r = Get-AtkReplication $Id
  if (-not $r) { Set-AtkOutcome failed 'not replicating'; return }
  if ($r.MigrationState -eq 'MigrationSucceeded') { Set-AtkOutcome skipped 'already migrated' -State cut-over -Data (Get-AtkVmData $group $s.vmName); return }
  if ($r.MigrationState -ne 'Replicating') { Set-AtkOutcome failed "migration needs Replicating; it is $($r.MigrationState)"; return }
  $job = Invoke-AtkStep "migrate $($s.name): final sync, then the source is turned off" { Start-AzMigrateServerMigration -TargetObjectID $r.Id -TurnOffSourceServer }
  if (-not $job) { Set-AtkOutcome succeeded 'dry run: the migration was printed' -State cut-over; return }
  Wait-AtkJob $job 'migration'
}
Set-AtkOutcome succeeded '' -State cut-over -Data (Get-AtkVmData $group $s.vmName)
`,
  commit: code`
$null = Get-AtkServer $Id
Set-AtkOutcome skipped 'Azure Migrate stops replication at migration; complete it with finalize'
`,
  rollback: code`
Connect-AtkAzure
$s = Get-AtkServer $Id
$group = Get-AtkTargetGroup $s.network
$vm = Get-AzVM -ResourceGroupName $group -Name $s.vmName -Status -ErrorAction SilentlyContinue
if (-not $vm) { Set-AtkOutcome skipped 'no migrated VM: nothing to stop; restart the source through its adapter'; return }
if (@($vm.Statuses | Where-Object { $_.Code -eq 'PowerState/running' }).Count -gt 0) {
  Invoke-AtkStep "stop the Azure VM $($s.vmName) (kept for analysis)" { $null = Stop-AzVM -ResourceGroupName $group -Name $s.vmName -Force }
}
Set-AtkOutcome succeeded 'the Azure VM is stopped and kept; the wave restarts the source through its adapter and reverts DNS' -Data @{ vmId = $vm.Id; replicationKept = $false }
`,
  finalize: code`
Connect-AtkAzure
$s = Get-AtkServer $Id
if ($s.sourceType -eq 'Physical') {
  $item = Get-AtkMigrationItem $Id
  if (-not $item) { Set-AtkOutcome skipped 'already complete'; return }
  Invoke-AtkStep "complete the migration of $($s.name)" { $null = Invoke-AtkAzRest DELETE $item.id }
  Set-AtkOutcome succeeded 'migration completed: replication removed'
  return
}
$r = Get-AtkReplication $Id
if (-not $r) { Set-AtkOutcome skipped 'already complete'; return }
Invoke-AtkStep "complete the migration of $($s.name)" { $null = Remove-AzMigrateServerReplication -TargetObjectID $r.Id }
Set-AtkOutcome succeeded 'migration completed: replication removed'
`,
  status: code`
Connect-AtkAzure
$s = Get-AtkServer $Id
if ($s.sourceType -eq 'Physical') {
  $item = Get-AtkMigrationItem $Id
  if (-not $item) { Set-AtkOutcome skipped 'replication is not enabled yet'; return }
  $state = [string] $item.properties.migrationState
  $pct = Get-AtkItemProgress $item.properties
} else {
  $r = Get-AtkReplication $Id
  if (-not $r) { Set-AtkOutcome skipped 'not replicating yet'; return }
  $state = [string] $r.MigrationState
  $pct = [int] $r.ProviderSpecificDetail.InitialSeedingProgressPercentage
}
if ($state -eq 'Replicating') { Set-AtkOutcome succeeded '' -State in-sync -Data @{ inSync = $true; progressPct = 100; migrationState = $state }; return }
Set-AtkOutcome succeeded '' -Data @{ inSync = $false; progressPct = $pct; migrationState = $state }
`,
};

/** `ansible/azure-mobility.yml`: the Mobility service of agent-based Azure Migrate, registered with the replication appliance. */
export const AZURE_MOBILITY_PLAYBOOK = `---
# Installs the Azure Migrate Mobility service (agent-based migration) and registers it with the
# replication appliance. Run by paths/azure-migrate/azmigrate.ps1 prepare, per server.
# The installers come from the appliance (%ProgramData%\\ASR\\home\\svsystems\\pushinstallsvc\\repository):
# copy them to the controller and name them in ATK_AZ_MOBILITY_LINUX and ATK_AZ_MOBILITY_WINDOWS.
# The passphrase is vault_azure_migrate_passphrase (Ansible Vault) or AZ_MIGRATE_PASSPHRASE.
# Command lines: https://learn.microsoft.com/en-us/azure/migrate/tutorial-migrate-physical-virtual-machines
- name: Install the Azure Migrate Mobility service
  hosts: all
  gather_facts: true
  vars:
    azure_migrate_passphrase: "{{ vault_azure_migrate_passphrase | default(lookup('ansible.builtin.env', 'AZ_MIGRATE_PASSPHRASE'), true) }}"
    mobility_linux: "{{ lookup('ansible.builtin.env', 'ATK_AZ_MOBILITY_LINUX') }}"
    mobility_windows: "{{ lookup('ansible.builtin.env', 'ATK_AZ_MOBILITY_WINDOWS') }}"
  tasks:
    - name: Check the play's inputs
      ansible.builtin.assert:
        that:
          - azure_migrate_appliance_ip is defined
          - azure_migrate_passphrase | length > 0
        fail_msg: >-
          Set the appliance address (azmigrate.ps1 passes AZ_MIGRATE_APPLIANCE_IP)
          and the passphrase (vault_azure_migrate_passphrase or AZ_MIGRATE_PASSPHRASE).
        quiet: true

    - name: Linux sources
      when: ansible_facts['os_family'] != 'Windows'
      become: true
      block:
        - name: Read the services
          ansible.builtin.service_facts:

        - name: Install and register when the service is not there
          when: "'svagents.service' not in ansible_facts['services']"
          block:
            - name: Make a private working directory
              ansible.builtin.tempfile:
                state: directory
                suffix: asr
              register: asr_tmp

            - name: Unpack the installer
              ansible.builtin.unarchive:
                src: "{{ mobility_linux }}"
                dest: "{{ asr_tmp.path }}"

            - name: Install the Mobility service
              ansible.builtin.command:
                argv: ["./install", "-d", "/usr/local/ASR", "-r", "MS", "-v", "VmWare", "-q"]
                chdir: "{{ asr_tmp.path }}"
              changed_when: true

            - name: Write the passphrase for the registration (owner only)
              ansible.builtin.copy:
                content: "{{ azure_migrate_passphrase }}"
                dest: "{{ asr_tmp.path }}/passphrase.txt"
                mode: "0600"
              no_log: true

            - name: Register with the replication appliance
              ansible.builtin.command:
                argv: ["/usr/local/ASR/Vx/bin/UnifiedAgentConfigurator.sh", "-i", "{{ azure_migrate_appliance_ip }}", "-P", "{{ asr_tmp.path }}/passphrase.txt"]
              no_log: true
              changed_when: true

          always:
            - name: Remove the working directory
              ansible.builtin.file:
                path: "{{ asr_tmp.path }}"
                state: absent
              when: asr_tmp.path is defined

    - name: Windows sources
      when: ansible_facts['os_family'] == 'Windows'
      block:
        - name: Look for the Mobility service
          ansible.windows.win_service_info:
            name: svagents
          register: asr_service

        - name: Install and register when the service is not there
          when: not asr_service.exists
          block:
            - name: Make a private working directory
              ansible.windows.win_tempfile:
                state: directory
                suffix: asr
              register: asr_wtmp

            - name: Copy the installer
              ansible.windows.win_copy:
                src: "{{ mobility_windows }}"
                dest: "{{ asr_wtmp.path }}\\\\MobilityServiceInstaller.exe"

            - name: Install the Mobility service
              ansible.windows.win_command:
                argv: ["{{ asr_wtmp.path }}\\\\MobilityServiceInstaller.exe", "/q", "/x:{{ asr_wtmp.path }}\\\\setup"]
              changed_when: true

            - name: Run the unified agent installer
              ansible.windows.win_command:
                argv: ["{{ asr_wtmp.path }}\\\\setup\\\\UnifiedAgent.exe", "/Role", "MS", "/Platform", "VmWare", "/Silent"]
              changed_when: true

            - name: Write the passphrase for the registration
              ansible.windows.win_copy:
                content: "{{ azure_migrate_passphrase }}"
                dest: "{{ asr_wtmp.path }}\\\\passphrase.txt"
              no_log: true

            - name: Register with the replication appliance
              ansible.windows.win_command:
                argv:
                  - C:\\Program Files (x86)\\Microsoft Azure Site Recovery\\agent\\UnifiedAgentConfigurator.exe
                  - /CSEndPoint
                  - "{{ azure_migrate_appliance_ip }}"
                  - /PassphraseFilePath
                  - "{{ asr_wtmp.path }}\\\\passphrase.txt"
              no_log: true
              changed_when: true

          always:
            - name: Remove the working directory
              ansible.windows.win_file:
                path: "{{ asr_wtmp.path }}"
                state: absent
              when: asr_wtmp.path is defined
`;

function readme(project: string, hasAgent: boolean): string {
  return `# Azure Migrate (\`azure-migrate\`, \`azure-migrate-hyperv\`, \`azure-migrate-agent\`)

\`azmigrate.ps1\` uses Az.Migrate (https://learn.microsoft.com/en-us/powershell/module/az.migrate/): azurerm has no Azure Migrate resource and \`az migrate\` covers Azure Local only. The Azure Migrate project is \`${project}\` (set AZ_MIGRATE_PROJECT to use another).

## Order of operations

1. **The appliance** (runbook step): deploy the Azure Migrate appliance (OVA or VHD, then its configuration manager) and let it discover the sources. \`prepare\` checks each server is discovered and creates the project when it is missing.
2. \`azmigrate.ps1 prepare\` prepares the replication infrastructure (agentless VMware or Hyper-V) in the landing zone's region.
${hasAgent ? `3. **Agent-based servers** (\`azure-migrate-agent\`): \`prepare\` installs the Mobility service (\`ansible/azure-mobility.yml\`) and registers it with the replication appliance (AZ_MIGRATE_APPLIANCE_IP; the passphrase from the vault). Then enable replication for them in the Azure Migrate portal, at most ten servers a batch: the Az.Migrate cmdlets drive agentless VMware and Hyper-V only. From there the script reads, tests and migrates them through the Site Recovery REST API.\n` : ''}4. \`replicate\` enables replication (agentless) and reports the initial seeding until the server is Replicating.
5. \`test\` runs a test migration into the test network, and validates it; \`test-cleanup\` removes it.
6. \`cutover\` migrates with **-TurnOffSourceServer** (agent: \`performShutdown\`): the final sync, then the source is shut down.
7. \`finalize\` completes the migration (the replication is removed).

\`rollback\` stops the Azure VM (kept for analysis); the wave restarts the source through its adapter. Azure Migrate has no reverse replication.

## Environment

AZURE_FEDERATED_TOKEN_FILE with AZURE_CLIENT_ID and AZURE_TENANT_ID (a federated service principal), else the managed identity (Connect-AzAccount -Identity). ATK_TF_AZURE_DIR (default terraform/azure), AZ_MIGRATE_RESOURCE_GROUP (default the landing zone's shared group), AZ_MIGRATE_PROJECT, AZ_MIGRATE_VAULT and AZ_SITE_RECOVERY_API_VERSION (agent path), AZ_MIGRATE_APPLIANCE_IP, ATK_AZ_MOBILITY_LINUX and ATK_AZ_MOBILITY_WINDOWS (the installers), ATK_INVENTORY.

Unverified, marked in the script: the Hyper-V scenario name (\`agentlessHyperV\`), the licence-type spellings, and the optional -TargetSecurityType / -LinuxLicenseType / -VMTag parameters (set only when the installed Az.Migrate has them).
`;
}

function files(items: readonly ManifestItem[], ctx: PathContext): Record<string, string> {
  const project = ctx.settings.azureMigrate?.project || `atk-${ctx.manifest.planId8}-migrate`;
  const servers: Record<string, ServerEntry> = {};
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const p = placementOf(item, ctx);
    if (p) servers[item.id] = serverEntry(item, p, ctx);
  }
  const hasAgent = items.some((i) => i.path === 'azure-migrate-agent');
  const script = psScript({
    file: AZMIGRATE_SCRIPT,
    paths: PATHS,
    summary: 'Azure Migrate: agentless VMware and Hyper-V through Az.Migrate, agent-based through the Mobility service and the Site Recovery API.',
    commands: ['terraform', ...(hasAgent ? ['ansible-playbook'] : [])],
    modules: ['Az.Accounts', 'Az.Migrate', 'Az.Compute', 'Az.Network', 'Az.Resources'],
    functions: FUNCTIONS(project, ctx.settings.lagSeconds.server),
    verbs: V,
  }).replace('Invoke-AtkMain -Verbs $Verbs', '$AtkPlan8 = (Get-Content -LiteralPath (Join-Path $AtkKit \'manifest/items.json\') -Raw | ConvertFrom-Json).planId8\nInvoke-AtkMain -Verbs $Verbs');
  const out: Record<string, string> = {
    [AZMIGRATE_SCRIPT]: script,
    [`${DIR}/servers.json`]: jsonText(servers),
    [`${DIR}/README.md`]: readme(project, hasAgent),
  };
  if (hasAgent) out['ansible/azure-mobility.yml'] = AZURE_MOBILITY_PLAYBOOK;
  return out;
}

function findings(items: readonly ManifestItem[], ctx: PathContext): Finding[] {
  const out: Finding[] = [];
  const missing = items.filter((i) => !placementOf(i, ctx));
  if (missing.length) {
    out.push(warning('exec.azmigrate.no-design', `${missing.length} Azure Migrate item(s) have no Azure compute target in the design: ${missing.map((i) => i.name).join(', ')}.`, { remediation: 'Design the Azure platform, then regenerate the kit.' }));
  }
  const agent = items.filter((i) => i.path === 'azure-migrate-agent');
  if (agent.length) {
    out.push(info('exec.azmigrate.portal-step', `${agent.length} agent-based server(s) need replication enabled in the Azure Migrate portal after the Mobility service is installed (at most ten a batch); the Az.Migrate cmdlets cover agentless VMware and Hyper-V only.`, { source: 'https://learn.microsoft.com/en-us/azure/migrate/tutorial-migrate-physical-virtual-machines' }));
  }
  if (items.some((i) => i.path === 'azure-migrate-hyperv')) {
    out.push(info('exec.azmigrate.hyperv-unverified', 'Agentless Hyper-V through Az.Migrate uses the scenario agentlessHyperV and -SourceMachineType HyperV, which are not confirmed on the module reference; a failure at prepare means enabling replication in the portal instead.', { source: 'https://learn.microsoft.com/en-us/powershell/module/az.migrate/initialize-azmigratereplicationinfrastructure' }));
  }
  return out;
}

export const AZURE_MIGRATE_GENERATOR: PathGenerator = Object.freeze({
  id: 'azure-migrate',
  owner: 'WP-11c' as const,
  paths: PATHS,
  needs: [...AZMIGRATE_NEEDS, ...AGENT_NEEDS],
  entry: () => AZMIGRATE_SCRIPT,
  files,
  findings,
});

export const GENERATORS: readonly PathGenerator[] = Object.freeze([AZURE_MIGRATE_GENERATOR]);
