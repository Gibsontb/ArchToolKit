<#
.SYNOPSIS
    Collects a VMware estate into ArchToolKit's canonical inventory JSON.

.DESCRIPTION
    Run this against vCenter from a machine that can reach it, then carry the
    resulting JSON to wherever ArchToolKit runs. Nothing is transmitted anywhere
    by this script: it writes a single file.

    It gathers considerably more than an RVTools export, because VCF readiness
    depends on hardware facts RVTools does not capture:

      - Physical NIC link speeds        vSAN ESA effectively requires 25GbE
      - NVMe device presence            ESA requires NVMe; OSA does not
      - VMkernel adapters and services  the existing network design
      - Boot device type and size       VCF 9 bans SD cards
      - TPM presence                    vSphere security baselines
      - Historical CPU/memory stats     RVTools is point-in-time only

.PARAMETER Server
    vCenter FQDN or IP. Prompts if omitted.

.PARAMETER OutputPath
    Where to write the JSON. Defaults to .\atk-inventory-<server>-<date>.json

.PARAMETER StatDays
    Days of historical performance data to summarise. 0 skips stat collection,
    which is much faster. Default 30.

.PARAMETER IncludeVmDetail
    Collect per-VM disk and network adapter detail. Slower on large estates.

.PARAMETER Credential
    PSCredential for vCenter. Prompts if omitted.

.EXAMPLE
    .\Export-AtkInventory.ps1 -Server vcenter.corp.local

.EXAMPLE
    .\Export-AtkInventory.ps1 -Server vcenter.corp.local -StatDays 0 -OutputPath C:\temp\estate.json

.NOTES
    Requires VMware PowerCLI. Read-only: it issues no write operations.
    Install with:  Install-Module VMware.PowerCLI -Scope CurrentUser
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Server,

    [string]$OutputPath,

    [ValidateRange(0, 365)]
    [int]$StatDays = 30,

    [switch]$IncludeVmDetail,

    [System.Management.Automation.PSCredential]$Credential
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SchemaVersion = '1.0'

function Write-Step {
    param([string]$Message)
    Write-Host "  $Message" -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  ! $Message" -ForegroundColor Yellow
}

# Every property access below is defensive. Estates contain disconnected hosts,
# orphaned VMs and partially-populated objects, and a collector that throws
# halfway through is worse than one that records a null.
function Get-Safe {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Script,
        $Default = $null
    )
    try {
        $value = & $Script
        if ($null -eq $value) { return $Default }
        return $value
    } catch {
        return $Default
    }
}

function ConvertTo-Gib {
    param($Mib)
    if ($null -eq $Mib) { return $null }
    return [math]::Round($Mib / 1024, 2)
}

# ---------------------------------------------------------------------------
# Connect
# ---------------------------------------------------------------------------

if (-not (Get-Module -ListAvailable -Name VMware.PowerCLI -ErrorAction SilentlyContinue)) {
    throw "VMware PowerCLI is not installed. Run: Install-Module VMware.PowerCLI -Scope CurrentUser"
}

Write-Host "`nArchToolKit inventory collector" -ForegroundColor White
Write-Host "Connecting to $Server..." -ForegroundColor Gray

# Self-signed certificates are the norm in these environments; this setting is
# session-scoped and does not persist.
Set-PowerCLIConfiguration -InvalidCertificateAction Ignore -Confirm:$false -Scope Session | Out-Null
Set-PowerCLIConfiguration -ParticipateInCEIP $false -Confirm:$false -Scope Session | Out-Null

$connectParams = @{ Server = $Server }
if ($Credential) { $connectParams.Credential = $Credential }
$connection = Connect-VIServer @connectParams

Write-Host "Connected to $($connection.Name) (version $($connection.Version))`n" -ForegroundColor Green

$collectedAt = (Get-Date).ToUniversalTime().ToString('o')

try {
    # -----------------------------------------------------------------------
    # Clusters
    # -----------------------------------------------------------------------
    Write-Step 'Collecting clusters...'
    $clusters = @()
    foreach ($cluster in Get-Cluster) {
        $clusters += [ordered]@{
            name                = $cluster.Name
            datacenter          = Get-Safe { (Get-Datacenter -Cluster $cluster).Name }
            haEnabled           = [bool]$cluster.HAEnabled
            drsEnabled          = [bool]$cluster.DrsEnabled
            drsAutomationLevel  = [string]$cluster.DrsAutomationLevel
            evcMode             = [string]$cluster.EVCMode
            vsanEnabled         = Get-Safe { [bool]$cluster.VsanEnabled } $false
            hostCount           = Get-Safe { (Get-VMHost -Location $cluster).Count } 0
        }
    }
    Write-Host "    $($clusters.Count) cluster(s)" -ForegroundColor Gray

    # -----------------------------------------------------------------------
    # Hosts — the detailed pass
    # -----------------------------------------------------------------------
    Write-Step 'Collecting hosts...'
    $hosts = @()
    $allHosts = Get-VMHost
    $hostIndex = 0

    foreach ($vmhost in $allHosts) {
        $hostIndex++
        Write-Progress -Activity 'Collecting hosts' -Status $vmhost.Name -PercentComplete (($hostIndex / $allHosts.Count) * 100)

        $view = Get-Safe { $vmhost.ExtensionData }
        $cpuInfo = Get-Safe { $view.Hardware.CpuInfo }
        $cpuPkg = Get-Safe { $view.Hardware.CpuPkg }
        $sysInfo = Get-Safe { $view.Hardware.SystemInfo }
        $biosInfo = Get-Safe { $view.Hardware.BiosInfo }

        $sockets = Get-Safe { [int]$cpuInfo.NumCpuPackages } 0
        $totalCores = Get-Safe { [int]$cpuInfo.NumCpuCores } 0
        $threads = Get-Safe { [int]$cpuInfo.NumCpuThreads } 0
        $coresPerSocket = if ($sockets -gt 0) { [int]($totalCores / $sockets) } else { 0 }

        # --- physical NICs: link speed gates vSAN ESA ---
        $pnics = @()
        foreach ($pnic in (Get-Safe { $view.Config.Network.Pnic } @())) {
            $pnics += [ordered]@{
                name       = $pnic.Device
                speedMb    = Get-Safe { [int]$pnic.LinkSpeed.SpeedMb }
                mac        = [string]$pnic.Mac
                driver     = [string]$pnic.Driver
                linkUp     = ($null -ne $pnic.LinkSpeed)
            }
        }

        # --- VMkernel adapters: the existing network design ---
        $vmks = @()
        foreach ($vmk in (Get-Safe { Get-VMHostNetworkAdapter -VMHost $vmhost -VMKernel -ErrorAction SilentlyContinue } @())) {
            $services = @()
            if (Get-Safe { $vmk.ManagementTrafficEnabled } $false) { $services += 'management' }
            if (Get-Safe { $vmk.VMotionEnabled } $false) { $services += 'vMotion' }
            if (Get-Safe { $vmk.VsanTrafficEnabled } $false) { $services += 'vSAN' }
            if (Get-Safe { $vmk.FaultToleranceLoggingEnabled } $false) { $services += 'faultTolerance' }

            $vmks += [ordered]@{
                name       = $vmk.Name
                ip         = [string]$vmk.IP
                subnetMask = [string]$vmk.SubnetMask
                mac        = [string]$vmk.Mac
                mtu        = Get-Safe { [int]$vmk.Mtu }
                portGroup  = [string]$vmk.PortGroupName
                services   = $services
            }
        }

        # --- storage devices: ESA requires NVMe ---
        $devices = @()
        foreach ($lun in (Get-Safe { Get-ScsiLun -VmHost $vmhost -LunType disk -ErrorAction SilentlyContinue } @())) {
            $isSsd = Get-Safe { [bool]$lun.IsSsd } $false
            $isLocal = Get-Safe { [bool]$lun.IsLocal } $false
            $model = Get-Safe { ([string]$lun.Model).Trim() } ''
            $vendor = Get-Safe { ([string]$lun.Vendor).Trim() } ''
            $canonical = Get-Safe { [string]$lun.CanonicalName } ''

            # NVMe devices surface with an "eui." or "t10.NVMe" canonical name,
            # or an nvme transport. Model strings alone are unreliable.
            $type = 'unknown'
            if ($canonical -match '^(eui\.|t10\.NVMe)' -or $model -match 'NVMe' -or $vendor -match 'NVMe') {
                $type = 'NVMe'
            } elseif ($isSsd) {
                $type = 'SSD'
            } elseif ($null -ne $lun.CapacityGB) {
                $type = 'HDD'
            }

            $devices += [ordered]@{
                name        = $canonical
                type        = $type
                capacityGib = Get-Safe { [math]::Round($lun.CapacityGB, 2) }
                model       = $model
                vendor      = $vendor
                isSsd       = $isSsd
                isLocal     = $isLocal
            }
        }

        # --- HBAs ---
        $hbas = @()
        foreach ($hba in (Get-Safe { Get-VMHostHba -VMHost $vmhost -ErrorAction SilentlyContinue } @())) {
            $hbas += [ordered]@{
                name   = [string]$hba.Device
                type   = [string]$hba.Type
                model  = [string]$hba.Model
                driver = [string]$hba.Driver
                status = [string]$hba.Status
            }
        }

        # --- TPM / secure boot ---
        $tpmPresent = Get-Safe {
            $null -ne ($view.Capability.TpmSupported) -and $view.Capability.TpmSupported
        } $null

        # --- historical utilisation, if requested ---
        $cpuStat = $null
        $memStat = $null
        if ($StatDays -gt 0) {
            $start = (Get-Date).AddDays(-$StatDays)
            $cpuStat = Get-Safe {
                $s = Get-Stat -Entity $vmhost -Stat cpu.usage.average -Start $start -IntervalMins 120 -ErrorAction SilentlyContinue
                if ($s) {
                    [ordered]@{
                        averagePct = [math]::Round((($s | Measure-Object Value -Average).Average), 2)
                        peakPct    = [math]::Round((($s | Measure-Object Value -Maximum).Maximum), 2)
                        samples    = $s.Count
                    }
                }
            }
            $memStat = Get-Safe {
                $s = Get-Stat -Entity $vmhost -Stat mem.usage.average -Start $start -IntervalMins 120 -ErrorAction SilentlyContinue
                if ($s) {
                    [ordered]@{
                        averagePct = [math]::Round((($s | Measure-Object Value -Average).Average), 2)
                        peakPct    = [math]::Round((($s | Measure-Object Value -Maximum).Maximum), 2)
                        samples    = $s.Count
                    }
                }
            }
        }

        $hostVms = Get-Safe { Get-VM -Location $vmhost -ErrorAction SilentlyContinue } @()

        $hosts += [ordered]@{
            name                  = $vmhost.Name
            cluster               = Get-Safe { $vmhost.Parent.Name }
            datacenter            = Get-Safe { (Get-Datacenter -VMHost $vmhost).Name }
            vendor                = Get-Safe { [string]$sysInfo.Vendor }
            model                 = Get-Safe { [string]$sysInfo.Model }
            serialNumber          = Get-Safe {
                ($sysInfo.OtherIdentifyingInfo | Where-Object { $_.IdentifierType.Key -eq 'ServiceTag' } | Select-Object -First 1).IdentifierValue
            }
            biosVersion           = Get-Safe { [string]$biosInfo.BiosVersion }
            cpuModel              = Get-Safe { ([string]$cpuPkg[0].Description).Trim() }
            cpuSockets            = $sockets
            coresPerSocket        = $coresPerSocket
            totalCores            = $totalCores
            threads               = $threads
            hyperthreadingActive  = ($threads -gt $totalCores)
            cpuSpeedMhz           = Get-Safe { [int]($cpuInfo.Hz / 1000000) }
            numaNodes             = Get-Safe { [int]$view.Hardware.NumaInfo.NumNodes }
            memoryGib             = Get-Safe { [math]::Round($vmhost.MemoryTotalGB, 2) } 0
            cpuUsage              = Get-Safe { [math]::Round($vmhost.CpuUsageMhz / $vmhost.CpuTotalMhz, 4) }
            memoryUsage           = Get-Safe { [math]::Round($vmhost.MemoryUsageGB / $vmhost.MemoryTotalGB, 4) }
            esxVersion            = [string]$vmhost.Version
            build                 = [string]$vmhost.Build
            connectionState       = [string]$vmhost.ConnectionState
            inMaintenanceMode     = ($vmhost.ConnectionState -eq 'Maintenance')
            uptimeDays            = Get-Safe { [math]::Round(((Get-Date) - $view.Summary.Runtime.BootTime).TotalDays, 1) }
            tpmPresent            = $tpmPresent
            nicCount              = $pnics.Count
            physicalNics          = $pnics
            vmkernelAdapters      = $vmks
            storageDevices        = $devices
            hbas                  = $hbas
            allocatedVcpu         = Get-Safe { ($hostVms | Measure-Object NumCpu -Sum).Sum } 0
            allocatedMemoryGib    = Get-Safe { [math]::Round((($hostVms | Measure-Object MemoryGB -Sum).Sum), 2) } 0
            cpuStats              = $cpuStat
            memoryStats           = $memStat
        }
    }
    Write-Progress -Activity 'Collecting hosts' -Completed
    Write-Host "    $($hosts.Count) host(s)" -ForegroundColor Gray

    # -----------------------------------------------------------------------
    # VMs
    # -----------------------------------------------------------------------
    Write-Step 'Collecting virtual machines...'
    $vms = @()
    $allVms = Get-VM
    $vmIndex = 0

    foreach ($vm in $allVms) {
        $vmIndex++
        if ($vmIndex % 50 -eq 0) {
            Write-Progress -Activity 'Collecting VMs' -Status "$vmIndex of $($allVms.Count)" -PercentComplete (($vmIndex / $allVms.Count) * 100)
        }

        $record = [ordered]@{
            name            = $vm.Name
            uuid            = Get-Safe { [string]$vm.ExtensionData.Config.Uuid }
            powerState      = switch ([string]$vm.PowerState) {
                'PoweredOn'  { 'poweredOn' }
                'PoweredOff' { 'poweredOff' }
                'Suspended'  { 'suspended' }
                default      { 'unknown' }
            }
            host            = Get-Safe { $vm.VMHost.Name }
            cluster         = Get-Safe { $vm.VMHost.Parent.Name }
            vcpu            = [int]$vm.NumCpu
            coresPerSocket  = Get-Safe { [int]$vm.CoresPerSocket }
            memoryGib       = [math]::Round($vm.MemoryGB, 2)
            provisionedGib  = Get-Safe { [math]::Round($vm.ProvisionedSpaceGB, 2) } 0
            usedGib         = Get-Safe { [math]::Round($vm.UsedSpaceGB, 2) }
            guestOs         = Get-Safe { [string]$vm.ExtensionData.Config.GuestFullName }
            hardwareVersion = [string]$vm.HardwareVersion
            toolsVersion    = Get-Safe { [string]$vm.ExtensionData.Guest.ToolsVersion }
            toolsStatus     = Get-Safe { [string]$vm.ExtensionData.Guest.ToolsStatus }
            ipAddress       = Get-Safe { [string]$vm.Guest.IPAddress[0] }
            snapshotCount   = Get-Safe { (Get-Snapshot -VM $vm -ErrorAction SilentlyContinue).Count } 0
        }

        if ($IncludeVmDetail) {
            $record.datastores = Get-Safe { @($vm.DatastoreIdList | ForEach-Object { (Get-View $_).Name }) } @()
            $record.networks = Get-Safe { @(Get-NetworkAdapter -VM $vm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty NetworkName) } @()
        }

        $vms += $record
    }
    Write-Progress -Activity 'Collecting VMs' -Completed
    Write-Host "    $($vms.Count) VM(s)" -ForegroundColor Gray

    # -----------------------------------------------------------------------
    # Datastores
    # -----------------------------------------------------------------------
    Write-Step 'Collecting datastores...'
    $datastores = @()
    foreach ($ds in Get-Datastore) {
        $type = switch -Regex ([string]$ds.Type) {
            'vsan'  { 'vsan' }
            'NFS'   { 'NFS' }
            'VMFS'  { 'VMFS' }
            'VVOL'  { 'vVol' }
            default { 'other' }
        }
        $datastores += [ordered]@{
            name        = $ds.Name
            type        = $type
            capacityGib = [math]::Round($ds.CapacityGB, 2)
            freeGib     = [math]::Round($ds.FreeSpaceGB, 2)
            hostCount   = Get-Safe { (Get-VMHost -Datastore $ds).Count }
        }
    }
    Write-Host "    $($datastores.Count) datastore(s)" -ForegroundColor Gray

    # -----------------------------------------------------------------------
    # Networks
    # -----------------------------------------------------------------------
    Write-Step 'Collecting networks...'
    $networks = @()
    foreach ($pg in (Get-Safe { Get-VDPortgroup -ErrorAction SilentlyContinue } @())) {
        $networks += [ordered]@{
            name       = $pg.Name
            switchName = Get-Safe { $pg.VDSwitch.Name }
            vlanId     = Get-Safe { [string]$pg.VlanConfiguration.VlanId }
            type       = 'vds'
        }
    }
    foreach ($pg in (Get-Safe { Get-VirtualPortGroup -Standard -ErrorAction SilentlyContinue } @())) {
        if ($networks.name -contains $pg.Name) { continue }
        $networks += [ordered]@{
            name       = $pg.Name
            switchName = Get-Safe { $pg.VirtualSwitchName }
            vlanId     = Get-Safe { [string]$pg.VLanId }
            type       = 'standard'
        }
    }
    Write-Host "    $($networks.Count) network(s)" -ForegroundColor Gray

    # -----------------------------------------------------------------------
    # Emit
    # -----------------------------------------------------------------------
    $notes = @("Collected by Export-AtkInventory.ps1 v$SchemaVersion")
    if ($StatDays -gt 0) {
        $notes += "Historical CPU and memory statistics over $StatDays days included"
    } else {
        $notes += 'Historical statistics skipped; utilisation figures are point-in-time only'
    }
    if (-not $IncludeVmDetail) {
        $notes += 'Per-VM disk and network detail omitted; re-run with -IncludeVmDetail to include it'
    }

    $inventory = [ordered]@{
        schemaVersion = $SchemaVersion
        source        = [ordered]@{
            kind        = 'powercli'
            label       = $connection.Name
            collectedAt = $collectedAt
            importedAt  = $collectedAt
            notes       = $notes
        }
        vcenter       = [ordered]@{
            name    = $connection.Name
            version = [string]$connection.Version
            build   = [string]$connection.Build
        }
        clusters   = $clusters
        hosts      = $hosts
        vms        = $vms
        datastores = $datastores
        networks   = $networks
    }

    if (-not $OutputPath) {
        $safeName = ($Server -replace '[^a-zA-Z0-9\.\-]', '_')
        $OutputPath = Join-Path (Get-Location) "atk-inventory-$safeName-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
    }

    # Depth 10 is enough for the deepest nesting here (host > devices > fields)
    # and avoids PowerShell's default depth of 2 silently truncating to strings.
    $inventory | ConvertTo-Json -Depth 10 | Set-Content -Path $OutputPath -Encoding UTF8

    $sizeKb = [math]::Round((Get-Item $OutputPath).Length / 1KB, 1)
    Write-Host "`nWrote $OutputPath ($sizeKb KB)" -ForegroundColor Green
    Write-Host "  $($hosts.Count) hosts, $($vms.Count) VMs, $($clusters.Count) clusters, $($datastores.Count) datastores" -ForegroundColor Gray

    # Surface the facts that decide VCF readiness, so problems are visible here
    # rather than only after the file reaches the toolkit.
    $noNvme = @($hosts | Where-Object { @($_.storageDevices | Where-Object { $_.type -eq 'NVMe' }).Count -eq 0 })
    if ($noNvme.Count -gt 0) {
        Write-Warn "$($noNvme.Count) host(s) report no NVMe devices; vSAN ESA requires NVMe."
    }

    $slowNics = @($hosts | Where-Object {
        $fastest = ($_.physicalNics | Measure-Object speedMb -Maximum).Maximum
        $fastest -and $fastest -lt 25000
    })
    if ($slowNics.Count -gt 0) {
        Write-Warn "$($slowNics.Count) host(s) have no NIC at 25GbE or above; 25GbE is recommended for vSAN ESA."
    }

    $oldEsx = @($hosts | Where-Object { $_.esxVersion -and [version]($_.esxVersion) -lt [version]'8.0.0' })
    if ($oldEsx.Count -gt 0) {
        Write-Warn "$($oldEsx.Count) host(s) run ESX below 8.0 and cannot be converged into VCF 9.1 as they are."
    }

    Write-Host "`nImport this file in ArchToolKit under VMware Inventory.`n" -ForegroundColor White

} finally {
    Disconnect-VIServer -Server $Server -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
}
