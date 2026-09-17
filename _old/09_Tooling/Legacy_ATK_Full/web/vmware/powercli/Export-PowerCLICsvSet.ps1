# Export-PowerCLICsvSet.ps1
# Canonical PowerCLI CSV export pack for migration assessment.
# Usage example:
#   pwsh .\Export-PowerCLICsvSet.ps1 -vCenter "vcenter01.domain.local" -OutRoot ".\exports"

param(
  [Parameter(Mandatory=$true)]
  [string]$vCenter,

  [Parameter(Mandatory=$false)]
  [string]$OutRoot = ".\exports"
)

# Requires: VMware.PowerCLI
# Install (once): Install-Module VMware.PowerCLI -Scope CurrentUser

Set-PowerCLIConfiguration -InvalidCertificateAction Ignore -Confirm:$false | Out-Null
Set-PowerCLIConfiguration -ParticipateInCEIP $false -Confirm:$false | Out-Null

$ts = (Get-Date).ToString("yyyyMMdd-HHmmss")
$outDir = Join-Path $OutRoot ("powercli-csvset-" + $ts)
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Export-CsvSafe {
  param(
    [Parameter(Mandatory=$true)] $Data,
    [Parameter(Mandatory=$true)] [string]$Name
  )
  $path = Join-Path $outDir $Name
  $Data | Export-Csv -NoTypeInformation -UseCulture -Path $path
  Write-Host "Wrote $path"
}

Connect-VIServer -Server $vCenter | Out-Null

# --- vCenter info ---
$vis = Get-VIServer | Select-Object -First 1
$vcenterInfo = [PSCustomObject]@{
  vCenter      = $vCenter
  ConnectedAs  = $vis.User
  ApiVersion   = $vis.ApiVersion
  ProductLine  = $vis.ProductLine
  Build        = $vis.Build
  ImportedAt   = (Get-Date).ToString("o")
}
Export-CsvSafe -Data @($vcenterInfo) -Name "vcenters.csv"

# --- Core topology ---
$datacenters = Get-Datacenter | Select-Object `
  @{n="DatacenterId";e={$_.Id}}, Name, Location
Export-CsvSafe $datacenters "datacenters.csv"

$clusters = Get-Cluster | ForEach-Object {
  $c = $_
  [PSCustomObject]@{
    ClusterId          = $c.Id
    Name               = $c.Name
    Datacenter         = ($c | Get-Datacenter).Name
    HAEnabled          = $c.HAEnabled
    DrsEnabled         = $c.DrsEnabled
    DrsAutomationLevel = $c.DrsAutomationLevel
    EVCMode            = $c.EVCMode
    VsanEnabled        = $c.VsanEnabled
  }
}
Export-CsvSafe $clusters "clusters.csv"

$hosts = Get-VMHost | ForEach-Object {
  $h = $_
  [PSCustomObject]@{
    HostId          = $h.Id
    Name            = $h.Name
    ClusterId       = ($h | Get-Cluster -ErrorAction SilentlyContinue | Select-Object -First 1).Id
    ConnectionState = $h.ConnectionState
    PowerState      = $h.PowerState
    Vendor          = $h.Manufacturer
    Model           = $h.Model
    CpuModel        = $h.ProcessorType
    CpuSockets      = $h.NumCpu
    CpuCores        = $h.NumCpuCore
    MemoryGB        = [Math]::Round($h.MemoryTotalGB,2)
    Version         = $h.Version
    Build           = $h.Build
  }
}
Export-CsvSafe $hosts "hosts.csv"

$pools = Get-ResourcePool | Select-Object `
  @{n="ResourcePoolId";e={$_.Id}}, Name, ParentId, CpuSharesLevel, MemSharesLevel, CpuLimitMhz, MemLimitMB
Export-CsvSafe $pools "resource_pools.csv"

$folders = Get-Folder | Select-Object @{n="FolderId";e={$_.Id}}, Name, ParentId, Type
Export-CsvSafe $folders "folders.csv"

# --- Storage ---
$datastores = Get-Datastore | ForEach-Object {
  $ds = $_
  [PSCustomObject]@{
    DatastoreId        = $ds.Id
    Name               = $ds.Name
    Type               = $ds.Type
    CapacityGB         = [Math]::Round($ds.CapacityGB,2)
    FreeGB             = [Math]::Round($ds.FreeSpaceGB,2)
    Accessible         = $ds.Accessible
    MaintenanceMode    = $ds.MaintenanceMode
    MultipleHostAccess = $ds.MultipleHostAccess
    Url                = $ds.ExtensionData.Info.Url
  }
}
Export-CsvSafe $datastores "datastores.csv"

$dsClusters = Get-DatastoreCluster -ErrorAction SilentlyContinue | Select-Object `
  @{n="DatastoreClusterId";e={$_.Id}}, Name, SdrsEnabled
Export-CsvSafe $dsClusters "datastore_clusters.csv"

# --- Networking ---
$dvs = Get-VDSwitch -ErrorAction SilentlyContinue | Select-Object `
  @{n="DVSwitchId";e={$_.Id}}, Name, Version, NumPorts, Mtu
Export-CsvSafe $dvs "dvswitches.csv"

$dvpg = Get-VDPortgroup -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $_
  [PSCustomObject]@{
    DVPortgroupId     = $p.Id
    Name              = $p.Name
    DVSwitchId        = ($p.VDSwitch).Id
    VlanConfiguration = ($p.ExtensionData.Config.DefaultPortConfig.Vlan | Out-String).Trim()
    NumPorts          = $p.NumPorts
    PortBinding       = $p.PortBinding
  }
}
Export-CsvSafe $dvpg "dvportgroups.csv"

$netPgs = Get-VirtualPortGroup -ErrorAction SilentlyContinue | ForEach-Object {
  $pg = $_
  [PSCustomObject]@{
    PortgroupId    = $pg.Id
    Name           = $pg.Name
    VLanId         = $pg.VLanId
    VirtualSwitch  = $pg.VirtualSwitchName
    Host           = $pg.VMHost.Name
    HostId         = $pg.VMHost.Id
  }
}
Export-CsvSafe $netPgs "net_portgroups.csv"

$vmkernels = Get-VMHostNetworkAdapter -VMKernel -ErrorAction SilentlyContinue | ForEach-Object {
  $a = $_
  [PSCustomObject]@{
    HostId                  = $a.VMHostId
    Host                    = $a.VMHost
    Name                    = $a.Name
    PortGroupName           = $a.PortGroupName
    IP                      = $a.IP
    SubnetMask              = $a.SubnetMask
    Mtu                     = $a.Mtu
    VmotionEnabled          = $a.VmotionEnabled
    VsanTrafficEnabled      = $a.VsanTrafficEnabled
    ManagementTrafficEnabled= $a.ManagementTrafficEnabled
  }
}
Export-CsvSafe $vmkernels "host_vmkernels.csv"

$pnics = Get-VMHostNetworkAdapter -Physical -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $_
  [PSCustomObject]@{
    HostId   = $p.VMHostId
    Host     = $p.VMHost
    Name     = $p.Name
    Mac      = $p.Mac
    SpeedMb  = $p.BitRatePerSec / 1MB
    Duplex   = $p.Duplex
  }
}
Export-CsvSafe $pnics "host_pnics.csv"

$vswitches = Get-VirtualSwitch -ErrorAction SilentlyContinue | ForEach-Object {
  $v = $_
  [PSCustomObject]@{
    Host     = $v.VMHost.Name
    HostId   = $v.VMHost.Id
    Name     = $v.Name
    Mtu      = $v.Mtu
    NumPorts = $v.NumPorts
    Nic      = ($v.Nic -join ";")
  }
}
Export-CsvSafe $vswitches "host_vswitches.csv"

# --- VMs ---
$vms = Get-VM | ForEach-Object {
  $vm = $_
  $ext = $vm.ExtensionData
  [PSCustomObject]@{
    VmId             = $vm.Id
    Name             = $vm.Name
    PowerState       = $vm.PowerState
    ClusterId        = ($vm | Get-Cluster -ErrorAction SilentlyContinue | Select-Object -First 1).Id
    HostId           = ($vm.VMHost | Select-Object -First 1).Id
    ResourcePoolId   = ($vm.ResourcePool | Select-Object -First 1).Id
    FolderId         = ($vm.Folder | Select-Object -First 1).Id
    NumCpu           = $vm.NumCpu
    MemoryGB         = $vm.MemoryGB
    CpuReservationMhz= $vm.CpuReservationMhz
    MemReservationGB = $vm.MemoryReservationGB
    CpuLimitMhz      = $vm.CpuLimitMhz
    MemLimitGB       = $vm.MemoryLimitGB
    ToolsStatus      = $ext.Guest.ToolsStatus
    ToolsVersionStatus2 = $ext.Guest.ToolsVersionStatus2
    GuestId          = $ext.Config.GuestId
    Firmware         = $ext.Config.Firmware
    SecureBootEnabled= $ext.Config.BootOptions.EfiSecureBootEnabled
    Uuid             = $ext.Config.Uuid
    InstanceUuid     = $ext.Config.InstanceUuid
    VmPathName       = $ext.Config.Files.VmPathName
  }
}
Export-CsvSafe $vms "vms.csv"

$vmGuest = Get-VM | ForEach-Object {
  $vm = $_
  $g = $vm.Guest
  [PSCustomObject]@{
    VmId      = $vm.Id
    Name      = $vm.Name
    HostName  = $g.HostName
    OSFullName= $g.OSFullName
    State     = $g.State
    IPAddress = (($g.IPAddress | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' }) -join ";")
  }
}
Export-CsvSafe $vmGuest "vm_guest.csv"

$vmDisks = Get-VM | Get-HardDisk | ForEach-Object {
  $d = $_
  [PSCustomObject]@{
    VmId        = $d.ParentId
    Vm          = $d.Parent
    DiskName    = $d.Name
    CapacityGB  = [Math]::Round($d.CapacityGB,2)
    StorageFormat= $d.StorageFormat
    Persistence = $d.Persistence
    Filename    = $d.Filename
    Datastore   = $d.FileName.Split("]")[0].TrimStart("[")
  }
}
Export-CsvSafe $vmDisks "vm_disks.csv"

$vmNics = Get-VM | Get-NetworkAdapter | ForEach-Object {
  $n = $_
  [PSCustomObject]@{
    VmId          = $n.ParentId
    Vm            = $n.Parent
    Name          = $n.Name
    Type          = $n.Type
    MacAddress    = $n.MacAddress
    NetworkName   = $n.NetworkName
    Connected     = $n.Connected
    StartConnected= $n.StartConnected
    WakeOnLanEnabled = $n.WakeOnLanEnabled
  }
}
Export-CsvSafe $vmNics "vm_nics.csv"

$cds = Get-VM | Get-CDDrive -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    VmId          = $_.ParentId
    Vm            = $_.Parent
    Name          = $_.Name
    IsoPath       = $_.IsoPath
    HostDevice    = $_.HostDevice
    Connected     = $_.Connected
    StartConnected= $_.StartConnected
  }
}
Export-CsvSafe $cds "vm_cdroms.csv"

$flops = Get-VM | Get-FloppyDrive -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    VmId          = $_.ParentId
    Vm            = $_.Parent
    Name          = $_.Name
    ImagePath     = $_.ImagePath
    HostDevice    = $_.HostDevice
    Connected     = $_.Connected
    StartConnected= $_.StartConnected
  }
}
Export-CsvSafe $flops "vm_floppies.csv"

$serial = Get-VM | Get-SerialPort -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    VmId          = $_.ParentId
    Vm            = $_.Parent
    Name          = $_.Name
    Connected     = $_.Connected
    StartConnected= $_.StartConnected
    Filename      = $_.Filename
    UsePhysicalSerialPort = $_.UsePhysicalSerialPort
  }
}
Export-CsvSafe $serial "vm_serial_ports.csv"

$usb = Get-VM | ForEach-Object {
  $vm = $_
  $devs = $vm.ExtensionData.Config.Hardware.Device
  $usbDevs = $devs | Where-Object { $_.GetType().Name -like "*Usb*" -or $_.DeviceInfo.Label -like "*USB*" }
  foreach ($u in $usbDevs) {
    [PSCustomObject]@{
      VmId   = $vm.Id
      Vm     = $vm.Name
      Label  = $u.DeviceInfo.Label
      Summary= $u.DeviceInfo.Summary
    }
  }
}
Export-CsvSafe $usb "vm_usb_devices.csv"

$snap = Get-VM | Get-Snapshot -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    VmId     = $_.VM.Id
    Vm       = $_.VM.Name
    Name     = $_.Name
    Description = $_.Description
    Created  = $_.Created
    SizeGB   = $_.SizeGB
    IsCurrent= $_.IsCurrent
  }
}
Export-CsvSafe $snap "vm_snapshots.csv"

$rdm = Get-VM | ForEach-Object {
  $vm = $_
  $devs = $vm.ExtensionData.Config.Hardware.Device
  $scsi = $devs | Where-Object { $_ -is [VMware.Vim.VirtualDisk] }
  foreach ($d in $scsi) {
    if ($d.Backing -and ($d.Backing.GetType().Name -like "*RawDiskMapping*")) {
      [PSCustomObject]@{
        VmId      = $vm.Id
        Vm        = $vm.Name
        DiskLabel = $d.DeviceInfo.Label
        Mode      = $d.Backing.CompatibilityMode
        LunUuid   = $d.Backing.LunUuid
        DeviceName= $d.Backing.DeviceName
      }
    }
  }
}
Export-CsvSafe $rdm "vm_rdms.csv"

$extra = Get-VM | ForEach-Object {
  $vm = $_
  $opt = $vm.ExtensionData.Config.ExtraConfig
  foreach ($kv in $opt) {
    [PSCustomObject]@{
      VmId  = $vm.Id
      Vm    = $vm.Name
      Key   = $kv.Key
      Value = $kv.Value
    }
  }
}
Export-CsvSafe $extra "vm_extra_config.csv"

# --- Tags / Custom Attributes / Permissions ---
$tags = Get-Tag -ErrorAction SilentlyContinue | Select-Object Name, Category
Export-CsvSafe $tags "tags.csv"

$tagAssignments = Get-TagAssignment -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    Tag        = $_.Tag.Name
    Category   = $_.Tag.Category.Name
    EntityId   = $_.Entity.Id
    EntityName = $_.Entity.Name
    EntityType = $_.Entity.GetType().Name
  }
}
Export-CsvSafe $tagAssignments "tag_assignments.csv"

$customAttrs = Get-CustomAttribute -ErrorAction SilentlyContinue | Select-Object Name, TargetType
Export-CsvSafe $customAttrs "custom_attributes.csv"

$customAttrValues = Get-VM | ForEach-Object {
  $vm = $_
  foreach ($ca in $vm.CustomFields) {
    [PSCustomObject]@{
      VmId  = $vm.Id
      Vm    = $vm.Name
      Key   = $ca.Key
      Value = $ca.Value
    }
  }
}
Export-CsvSafe $customAttrValues "custom_attribute_values.csv"

$perms = Get-VIPermission -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    EntityId  = $_.EntityId
    Entity    = $_.Entity
    Principal = $_.Principal
    Role      = $_.Role
    Propagate = $_.Propagate
    IsGroup   = $_.IsGroup
  }
}
Export-CsvSafe $perms "permissions.csv"

Disconnect-VIServer -Server $vCenter -Confirm:$false | Out-Null
Write-Host "DONE. Output folder: $outDir"
