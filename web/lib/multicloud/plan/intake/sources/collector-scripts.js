/**
 * The discovery collectors' text (addendum A.3.2), embedded verbatim and
 * rendered by `collectors.ts`. The bash collectors that talk to a platform
 * API share `COLLECTOR_COMMON_SH`, spliced in at their `# @@common@@` line.
 * collect-linux.sh needs no jq (it runs on arbitrary guests); the rest need
 * jq. Every script is checked with `bash -n` or the PowerShell parser in
 * sources.test.ts.
 */

export const COLLECTOR_COMMON_SH = `set -euo pipefail

OUT=""
TODAY="$(date -u +%Y-%m-%d)"
TMPD="$(mktemp -d "\${XDG_RUNTIME_DIR:-/tmp}/atk.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT

die() { echo "$*" >&2; exit "\${2:-1}"; }
need() { local t; for t in "$@"; do command -v "$t" >/dev/null 2>&1 || die "missing tool: $t" 3; done; }

# A credential: $NAME, else the file in $NAME_FILE (mode 600 or 400), else \`$ATK_VAULT_CMD NAME\`.
# Never echoed, never written.
secret() {
  local n="$1" f v perms
  v="\${!n:-}"
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  f="\${n}_FILE"; f="\${!f:-}"
  if [ -n "$f" ]; then
    [ -r "$f" ] || die "cannot read \\$\${n}_FILE" 3
    perms="$(stat -c %a "$f" 2>/dev/null || echo 600)"
    case "$perms" in 600|400) ;; *) die "\\$\${n}_FILE must be mode 600" 3 ;; esac
    tr -d '\\r\\n' < "$f"; return 0
  fi
  if [ -n "\${ATK_VAULT_CMD:-}" ]; then $ATK_VAULT_CMD "$n"; return 0; fi
  die "missing credential: set $n or \${n}_FILE" 3
}

# Writes stdin to --out (mode 600) or stdout.
emit() {
  if [ -n "$OUT" ]; then (umask 077; cat > "$OUT"); else cat; fi
}

# The discovery envelope around a JSON array of servers on stdin.
envelope() {
  local platform="$1" manager="\${2:-}"
  jq -c --arg p "$platform" --arg m "$manager" --arg d "$TODAY" \\
    '{kind: "archtoolkit.discovery", v: 1, source: ({platform: $p} + (if $m == "" then {} else {manager: $m} end)), collectedAt: $d, servers: .}'
}
`;

export const COLLECTOR_SCRIPTS                                   = Object.freeze({
  "collect-ahv.sh": `#!/usr/bin/env bash
# collect-ahv.sh: Nutanix AHV inventory from Prism Central as an
# archtoolkit.discovery v1 file.
#
# Prism Central v4 VMM API: GET https://<pc>:9440/api/vmm/v4.1/ahv/config/vms?$page=N&$limit=100
# (https://developers.nutanix.com/api-reference?namespace=vmm&version=v4.1).
# When v4 is not available (older Prism Central), it falls back to the v3
# POST /api/nutanix/v3/vms/list. The v4 field names are marked (verify):
# numSockets, numCoresPerSocket, numThreadsPerCore, memorySizeBytes,
# disks[].backingInfo.diskSizeBytes, nics[].networkInfo.ipv4Config,
# bootConfig.$objectType, categories.
#
# Usage: PRISM_CENTRAL=pc.example.com collect-ahv.sh [--out FILE] [--v3]
# Credentials: PRISM_USER and PRISM_PASSWORD (or PRISM_PASSWORD_FILE, mode 600,
# or ATK_VAULT_CMD). PRISM_CA_FILE for a private CA; PRISM_INSECURE=1 skips
# certificate checks (not recommended).
# Needs: bash 4+, curl, jq. The output has no user name and no path.

# @@common@@

API=v4
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="\${2:?--out needs a file}"; shift 2 ;;
    --v3) API=v3; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
need curl jq
PC="\${PRISM_CENTRAL:?set PRISM_CENTRAL to the Prism Central address}"
USER_NAME="$(secret PRISM_USER)"
PASS="$(secret PRISM_PASSWORD)"
TLS=()
[ -n "\${PRISM_CA_FILE:-}" ] && TLS+=(--cacert "$PRISM_CA_FILE")
[ "\${PRISM_INSECURE:-0}" = 1 ] && TLS+=(-k)

# The credentials go to curl on stdin (-K -), never on the command line.
cfg_escape() { printf '%s' "$1" | sed 's/[\\\\"]/\\\\&/g'; }
api() { # method path [json-body]
  local extra=()
  [ -n "\${3:-}" ] && extra=(--data "$3")
  printf 'user = "%s:%s"\\n' "$(cfg_escape "$USER_NAME")" "$(cfg_escape "$PASS")" \\
    | curl -sS --fail -K - \${TLS[@]+"\${TLS[@]}"} -X "$1" -H 'Accept: application/json' -H 'Content-Type: application/json' \\
      \${extra[@]+"\${extra[@]}"} "https://$PC:9440$2"
}

V4_JQ='
  def gib(b): ((b // 0) / 1073741824);
  [.data[]? | {
    name: .name, id: .extId,
    host: (.host.extId // null), cluster: (.cluster.extId // null),
    kind: "vm",
    powerState: (.powerState // "unknown"),
    vcpu: ((.numSockets // 1) * (.numCoresPerSocket // 1) * (.numThreadsPerCore // 1)),
    ramGib: ((gib(.memorySizeBytes) * 10 | round) / 10),
    firmware: (if ((.bootConfig["$objectType"] // "") | test("Uefi"; "i")) then "efi" else "bios" end),
    disks: [(.disks // [])[] | (.backingInfo.diskSizeBytes // .backingInfo.vmDisk.diskSizeBytes // empty) | {gib: (gib(.) | ceil)}],
    nics: [(.nics // [])[] | {
      mac: (.backingInfo.macAddress // null),
      ipv4: ([(.networkInfo.ipv4Config.ipAddress.value // empty), ((.networkInfo.ipv4Info.learnedIpAddresses // [])[] | .value)] | unique)
    }],
    annotation: (.description // null),
    tags: ([(.categories // [])[] | ($cats[0][.extId // ""] // empty)] | from_entries)
  }]'

V3_JQ='
  [.entities[]? | {
    name: .spec.name, id: .metadata.uuid,
    host: (.status.resources.host_reference.name // null), cluster: (.status.cluster_reference.name // null),
    kind: "vm",
    powerState: (.status.resources.power_state // "unknown"),
    vcpu: ((.status.resources.num_sockets // 1) * (.status.resources.num_vcpus_per_socket // 1)),
    ramGib: ((((.status.resources.memory_size_mib // 0) / 1024) * 10 | round) / 10),
    firmware: (if ((.status.resources.boot_config.boot_type // "") | test("UEFI"; "i")) then "efi" else "bios" end),
    disks: [(.status.resources.disk_list // [])[] | select((.device_properties.device_type // "DISK") == "DISK") | {gib: (((.disk_size_mib // 0) / 1024) | ceil)}],
    nics: [(.status.resources.nic_list // [])[] | {mac: (.mac_address // null), ipv4: [(.ip_endpoint_list // [])[] | .ip]}],
    annotation: (.spec.description // null),
    tags: (.metadata.categories // {})
  }]'

if [ "$API" = v4 ]; then
  # Category ids to key / value (Prism v4 config API, verify), for the tags.
  echo '{}' > "$TMPD/cats"
  cpage=0
  while resp="$(api GET "/api/prism/v4.0/config/categories?\\$page=$cpage&\\$limit=100" 2>/dev/null)"; do
    jq -c --slurpfile have "$TMPD/cats" '$have[0] + ([.data[]? | {key: .extId, value: {key: .key, value: .value}}] | from_entries)' <<<"$resp" > "$TMPD/cats.new"
    mv "$TMPD/cats.new" "$TMPD/cats"
    [ "$(jq '.data | length' <<<"$resp")" -lt 100 ] && break
    cpage=$((cpage + 1))
  done
  page=0
  : > "$TMPD/servers"
  while :; do
    if ! resp="$(api GET "/api/vmm/v4.1/ahv/config/vms?\\$page=$page&\\$limit=100")"; then
      [ "$page" = 0 ] || die "Prism Central v4 failed on page $page" 1
      echo "v4 VMM API not available; using v3" >&2
      API=v3
      break
    fi
    jq -c --slurpfile cats "$TMPD/cats" "$V4_JQ | .[]" <<<"$resp" >> "$TMPD/servers"
    n="$(jq '.data | length' <<<"$resp")"
    [ "$n" -lt 100 ] && break
    page=$((page + 1))
  done
fi
if [ "$API" = v3 ]; then
  offset=0
  : > "$TMPD/servers"
  while :; do
    resp="$(api POST /api/nutanix/v3/vms/list "{\\"kind\\":\\"vm\\",\\"length\\":100,\\"offset\\":$offset}")"
    jq -c "$V3_JQ | .[]" <<<"$resp" >> "$TMPD/servers"
    total="$(jq '.metadata.total_matches // 0' <<<"$resp")"
    offset=$((offset + 100))
    [ "$offset" -ge "$total" ] && break
  done
fi

jq -sc 'map(with_entries(select(.value != null)))' "$TMPD/servers" | envelope ahv "$PC" | emit
`,
  "collect-aws.sh": `#!/usr/bin/env bash
# collect-aws.sh: Amazon EC2 inventory (cloud-to-cloud source) as an
# archtoolkit.discovery v1 file.
#
#   aws ec2 describe-instances  and  aws ec2 describe-volumes, per region
# (all enabled regions, or the ones given). vCPU is CoreCount x ThreadsPerCore;
# memory comes from the instance type on import. Tags become attributes, so
# an "app" or "application" tag groups servers into apps.
#
# Usage: collect-aws.sh [--regions eu-west-1,eu-central-1] [--out FILE]
# Credentials: the AWS CLI's own chain (profile, SSO, instance role). Nothing
# is read from or written to a file by this script.
# Needs: bash 4+, jq, aws (v2). The output has no user name and no path.

# @@common@@

REGIONS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --regions) REGIONS="\${2:?--regions needs a list}"; shift 2 ;;
    --out) OUT="\${2:?--out needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
need aws jq
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [ -z "$REGIONS" ]; then
  REGIONS="$(aws ec2 describe-regions --query 'Regions[].RegionName' --output text | tr '\\t' ',')"
fi

for region in \${REGIONS//,/ }; do
  aws ec2 describe-volumes --region "$region" --output json > "$TMPD/vol.json"
  aws ec2 describe-instances --region "$region" --output json > "$TMPD/inst.json"
  # The images' names say the OS better than PlatformDetails ("Linux/UNIX").
  echo '{"Images":[]}' > "$TMPD/img.json"
  ids="$(jq -r '[.Reservations[]?.Instances[]?.ImageId] | unique | join(" ")' "$TMPD/inst.json")"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    aws ec2 describe-images --region "$region" --image-ids $ids --output json > "$TMPD/img.json" 2>/dev/null \\
      || echo '{"Images":[]}' > "$TMPD/img.json"
  fi
  jq -c --arg region "$region" --slurpfile vols "$TMPD/vol.json" --slurpfile imgs "$TMPD/img.json" '
      ([$vols[0].Volumes[]? | {key: .VolumeId, value: .Size}] | from_entries) as $size
      | ([$imgs[0].Images[]? | {key: .ImageId, value: (.Description // .Name // "")}] | from_entries) as $img
      | .Reservations[]?.Instances[]? | select(.State.Name != "terminated")
      | ([.Tags[]? | {key: .Key, value: .Value}] | from_entries) as $tags
      | . as $i
      | {
        name: ($tags.Name // .InstanceId),
        id: .InstanceId,
        region: $region,
        cluster: (.Placement.AvailabilityZone // $region),
        kind: "instance",
        powerState: .State.Name,
        size: .InstanceType,
        vcpu: (if .CpuOptions then (.CpuOptions.CoreCount * (.CpuOptions.ThreadsPerCore // 1)) else 0 end),
        firmware: (if (.BootMode // "") | test("uefi") then "efi" elif (.BootMode // "") == "legacy-bios" then "bios" else null end),
        disks: ([.BlockDeviceMappings[]? | {name: .DeviceName, gib: ($size[.Ebs.VolumeId // ""] // 0), boot: (.DeviceName == $i.RootDeviceName)}]
                | sort_by(if .boot then 0 else 1 end) | map(del(.boot))),
        nics: [.NetworkInterfaces[]? | {mac: .MacAddress, ipv4: ([.PrivateIpAddresses[]?.PrivateIpAddress] + [(.Association.PublicIp // empty)]), ipv6: [.Ipv6Addresses[]?.Ipv6Address]}],
        os: {raw: (($img[.ImageId // ""] // "") | if . == "" then ($i.PlatformDetails // $i.Platform // "") else . end)},
        tags: $tags
      } | with_entries(select(.value != null))' "$TMPD/inst.json"
done | jq -sc . | envelope aws "$ACCOUNT" | emit
`,
  "collect-azure.sh": `#!/usr/bin/env bash
# collect-azure.sh: Azure virtual machine inventory (cloud-to-cloud source)
# as an archtoolkit.discovery v1 file.
#
#   az vm list -d   (power state, private and public addresses, sizes)
#   az disk list    (disk sizes and the Hyper-V generation: V2 = UEFI)
# per subscription (the current one, or those given). vCPU and memory come
# from the VM size on import. Tags become attributes.
#
# Usage: collect-azure.sh [--subscriptions id1,id2] [--out FILE]
# Credentials: the Azure CLI's own sign-in (az login, a managed identity or
# a federated service principal). Nothing is written but the output.
# Needs: bash 4+, jq, az. The output has no user name and no path.

# @@common@@

SUBS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --subscriptions) SUBS="\${2:?--subscriptions needs a list}"; shift 2 ;;
    --out) OUT="\${2:?--out needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
need az jq
[ -n "$SUBS" ] || SUBS="$(az account show --query id --output tsv)"

for sub in \${SUBS//,/ }; do
  az disk list --subscription "$sub" --output json > "$TMPD/disks.json"
  az vm list -d --subscription "$sub" --output json \\
    | jq -c --slurpfile disks "$TMPD/disks.json" '
      ([$disks[0][]? | {key: (.id | ascii_downcase), value: {gib: .diskSizeGB, gen: (.hyperVGeneration // "")}}] | from_entries) as $d
      | .[]
      | ($d[(.storageProfile.osDisk.managedDisk.id // "") | ascii_downcase] // {}) as $os
      | {
        name: .name,
        id: .id,
        region: .location,
        cluster: .resourceGroup,
        kind: "instance",
        powerState: (.powerState // "unknown"),
        size: .hardwareProfile.vmSize,
        firmware: (if ($os.gen // "") == "V2" or (.securityProfile.uefiSettings != null) then "efi" else "bios" end),
        disks: ([{gib: (.storageProfile.osDisk.diskSizeGb // $os.gib // 0)}]
                + [.storageProfile.dataDisks[]? | {gib: (.diskSizeGb // ($d[(.managedDisk.id // "") | ascii_downcase].gib) // 0)}]),
        nics: [{
          mac: ((.macAddresses // "") | split(",")[0] // null),
          ipv4: (((.privateIps // "") | split(",") | map(select(. != "" and (test(":") | not)))) + ((.publicIps // "") | split(",") | map(select(. != "" and (test(":") | not))))),
          ipv6: (((.privateIps // "") + "," + (.publicIps // "")) | split(",") | map(select(test(":"))))
        }],
        os: {raw: ([.storageProfile.imageReference.offer, .storageProfile.imageReference.sku, .storageProfile.osDisk.osType] | map(select(. != null and . != "")) | join(" "))},
        tags: (.tags // {})
      } | with_entries(select(.value != null))'
done | jq -sc . | envelope azure "\${SUBS%%,*}" | emit
`,
  "collect-gcp.sh": `#!/usr/bin/env bash
# collect-gcp.sh: Google Cloud (GCP) Compute Engine inventory
# (cloud-to-cloud source) as an archtoolkit.discovery v1 file.
#
#   gcloud compute instances list --format=json
#   gcloud compute disks list --format=json
# per project (the configured one, or those given). vCPU and memory come from
# the machine type on import (custom types are read from their name). Labels
# become attributes. The OS is read from the boot disk's licence names.
#
# Usage: collect-gcp.sh [--projects p1,p2] [--out FILE]
# Credentials: gcloud's own (user sign-in, service account impersonation or
# application default credentials). Nothing is written but the output.
# Needs: bash 4+, jq, gcloud. The output has no user name and no path.

# @@common@@

PROJECTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --projects) PROJECTS="\${2:?--projects needs a list}"; shift 2 ;;
    --out) OUT="\${2:?--out needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
need gcloud jq
[ -n "$PROJECTS" ] || PROJECTS="$(gcloud config get-value project 2>/dev/null)"
[ -n "$PROJECTS" ] || die "no project: pass --projects or run gcloud config set project" 2

for project in \${PROJECTS//,/ }; do
  gcloud compute disks list --project "$project" --format=json > "$TMPD/disks.json"
  gcloud compute instances list --project "$project" --format=json \\
    | jq -c --slurpfile disks "$TMPD/disks.json" '
      def leaf: split("/") | .[-1];
      ([$disks[0][]? | {key: .selfLink, value: .}] | from_entries) as $d
      | .[]
      | {
        name: .name,
        id: (.id | tostring),
        region: ((.zone // "") | leaf | sub("-[a-z]$"; "")),
        cluster: ((.zone // "") | leaf),
        kind: "instance",
        powerState: .status,
        size: ((.machineType // "") | leaf),
        firmware: (if (.shieldedInstanceConfig.enableSecureBoot // false) or ([.disks[]? | select(.boot) | .guestOsFeatures[]?.type] | index("UEFI_COMPATIBLE")) then "efi" else "bios" end),
        disks: ([.disks[]? | {gib: ((.diskSizeGb // ($d[.source // ""].sizeGb) // "0") | tonumber), boot: (.boot // false)}]
                | sort_by(if .boot then 0 else 1 end) | map(del(.boot))),
        nics: [.networkInterfaces[]? | {ipv4: ([.networkIP // empty] + [.accessConfigs[]?.natIP // empty]), ipv6: ([.ipv6Address // empty] + [.ipv6AccessConfigs[]?.externalIpv6 // empty])}],
        os: {raw: ([.disks[]? | select(.boot) | .licenses[]? | leaf] | join(" "))},
        tags: (.labels // {})
      }
      + (if (.description // "") == "" then {} else {annotation: .description} end)'
done | jq -sc . | envelope google "\${PROJECTS%%,*}" | emit
`,
  "collect-hyperv.ps1": `<#
.SYNOPSIS
  Hyper-V inventory (standalone host or failover cluster) as an
  archtoolkit.discovery v1 file.

.DESCRIPTION
  Run on a Hyper-V host or cluster node (the Hyper-V PowerShell module).
  With -Cluster, every node of the local cluster is read (Get-ClusterNode).
  Per VM: Get-VM (Name, VMId, State, ProcessorCount, MemoryStartup,
  MemoryAssigned, DynamicMemoryEnabled, MemoryMaximum, Generation, Version,
  Notes), Get-VMHardDiskDrive | Get-VHD (Size, FileSize),
  Get-VMNetworkAdapter (IPAddresses need the integration services,
  MacAddress, SwitchName), and the guest OS from the KVP exchange
  (Msvm_KvpExchangeComponent) where the guest publishes it.
  Generation 2 is UEFI; generation 1 is BIOS.

  The file holds no user name and no path; collectedAt is a date.

.EXAMPLE
  .\\collect-hyperv.ps1 -Cluster -OutFile hv-cluster-01.json
  .\\collect-hyperv.ps1 -ComputerName hv01, hv02
#>
[CmdletBinding()]
param(
  [string[]]$ComputerName,
  [switch]$Cluster,
  [string]$OutFile
)
$ErrorActionPreference = 'Stop'

function Get-KvpOs([string]$HostName, [string]$VmId) {
  try {
    $vm = Get-CimInstance -ComputerName $HostName -Namespace 'root\\virtualization\\v2' -ClassName Msvm_ComputerSystem -Filter "Name='$VmId'"
    $kvp = Get-CimAssociatedInstance -InputObject $vm -ResultClassName Msvm_KvpExchangeComponent
    $items = @{}
    foreach ($x in @($kvp.GuestIntrinsicExchangeItems)) {
      $xml = [xml]$x
      $n = ($xml.INSTANCE.PROPERTY | Where-Object { $_.NAME -eq 'Name' }).VALUE
      $v = ($xml.INSTANCE.PROPERTY | Where-Object { $_.NAME -eq 'Data' }).VALUE
      if ($n) { $items[$n] = $v }
    }
    return [ordered]@{ raw = [string]$items['OSName']; version = [string]$items['OSVersion'] }
  } catch { return [ordered]@{ raw = ''; version = '' } }
}

$manager = ''
$hosts = @()
if ($Cluster) {
  $manager = (Get-Cluster).Name
  $hosts = @(Get-ClusterNode | Where-Object { $_.State -eq 'Up' } | ForEach-Object { $_.Name })
} elseif ($ComputerName) {
  $hosts = $ComputerName
} else {
  $hosts = @($env:COMPUTERNAME)
}
if (-not $manager) { $manager = $hosts[0] }

$servers = foreach ($h in $hosts) {
  foreach ($vm in @(Get-VM -ComputerName $h)) {
    $disks = @(Get-VMHardDiskDrive -VM $vm | ForEach-Object {
        try {
          $vhd = Get-VHD -ComputerName $h -Path $_.Path
          [ordered]@{ gib = [int][math]::Ceiling($vhd.Size / 1GB); usedGib = [math]::Round($vhd.FileSize / 1GB, 1) }
        } catch {
          # Pass-through disks have no VHD.
          [ordered]@{ gib = 0; name = 'pass-through' }
        }
      })
    $nics = @(Get-VMNetworkAdapter -VM $vm | ForEach-Object {
        [ordered]@{
          mac     = [string]$_.MacAddress
          network = [string]$_.SwitchName
          ipv4    = @($_.IPAddresses | Where-Object { $_ -notmatch ':' })
          ipv6    = @($_.IPAddresses | Where-Object { $_ -match ':' -and $_ -notmatch '^fe80' })
        }
      })
    $ram = [math]::Max([double]$vm.MemoryStartup, [double]$vm.MemoryAssigned)
    $server = [ordered]@{
      name       = $vm.Name
      id         = [string]$vm.VMId
      host       = $h
      kind       = 'vm'
      powerState = [string]$vm.State
      vcpu       = [int]$vm.ProcessorCount
      ramGib     = [math]::Round($ram / 1GB, 1)
      firmware   = if ($vm.Generation -eq 2) { 'efi' } else { 'bios' }
      disks      = $disks
      nics       = $nics
      os         = Get-KvpOs $h ([string]$vm.VMId)
    }
    if ($manager -ne $h) { $server.cluster = $manager }
    if ($vm.Notes) { $server.annotation = [string]$vm.Notes }
    $server.tags = [ordered]@{ generation = [string]$vm.Generation; version = [string]$vm.Version; dynamicMemory = [string]$vm.DynamicMemoryEnabled }
    $server
  }
}

$doc = [ordered]@{
  kind        = 'archtoolkit.discovery'
  v           = 1
  source      = [ordered]@{ platform = 'hyperv'; manager = $manager }
  collectedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
  servers     = @($servers)
}
$json = $doc | ConvertTo-Json -Depth 8 -Compress
if ($OutFile) { [IO.File]::WriteAllText($OutFile, $json, (New-Object Text.UTF8Encoding $false)) } else { Write-Output $json }
`,
  "collect-k8s.sh": `#!/usr/bin/env bash
# collect-k8s.sh: a Kubernetes cluster's workloads and nodes, for the
# Kubernetes sizing import (addendum A.2.8.5), and its nodes as an
# archtoolkit.discovery v1 file (so the nodes appear as servers of type
# k8s-node when they are VMs or physical servers to move).
#
#   kubectl get deploy,sts,ds -A -o json   -> k8s-workloads.json
#   kubectl get nodes -o json              -> k8s-nodes.json
#   the nodes as discovery servers         -> k8s-discovery.json
#
# Usage: collect-k8s.sh [--context NAME] [--out-dir DIR] [--platform vsphere|physical|...]
# Credentials: kubectl's own kubeconfig. The context name is not written.
# Needs: bash 4+, jq, kubectl. The output has no user name and no path.

# @@common@@

OUTDIR=.
PLATFORM=other
CTX=()
while [ $# -gt 0 ]; do
  case "$1" in
    --context) CTX=(--context "\${2:?--context needs a name}"); shift 2 ;;
    --out-dir) OUTDIR="\${2:?--out-dir needs a directory}"; shift 2 ;;
    --platform) PLATFORM="\${2:?--platform needs a source platform}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
need kubectl jq
mkdir -p "$OUTDIR"
k() { kubectl \${CTX[@]+"\${CTX[@]}"} "$@"; }

# Only the fields the sizing reads: no annotations, env, secrets or images' pull credentials.
k get deploy,sts,ds -A -o json | jq -c '{kind: "List", items: [.items[] | {
    kind, metadata: {name: .metadata.name, namespace: .metadata.namespace},
    spec: {replicas: .spec.replicas, template: {spec: {nodeSelector: .spec.template.spec.nodeSelector,
      containers: [.spec.template.spec.containers[] | {name, resources}],
      initContainers: [(.spec.template.spec.initContainers // [])[] | {name, resources}]}}}}]}' > "$OUTDIR/k8s-workloads.json"
k get nodes -o json > "$TMPD/nodes.json"
jq -c '{kind: "List", items: [.items[] | {metadata: {name: .metadata.name, labels: .metadata.labels}, status: {capacity: .status.capacity, allocatable: .status.allocatable, nodeInfo: .status.nodeInfo}}]}' \\
  "$TMPD/nodes.json" > "$OUTDIR/k8s-nodes.json"
jq -c '[.items[] | {
    name: .metadata.name,
    kind: "vm",
    powerState: (if ([.status.conditions[]? | select(.type == "Ready") | .status][0] // "") == "True" then "poweredOn" else "unknown" end),
    vcpu: ((.status.capacity.cpu // "0") | tonumber? // 0),
    ramGib: (((.status.capacity.memory // "0Ki") | capture("(?<n>[0-9]+)") | .n | tonumber) / 1048576 * 10 | round / 10),
    nics: [{ipv4: [.status.addresses[]? | select(.type == "InternalIP" and (.address | test(":") | not)) | .address],
            ipv6: [.status.addresses[]? | select(.type == "InternalIP" and (.address | test(":"))) | .address]}],
    os: {raw: (.status.nodeInfo.osImage // "")},
    software: ["kubelet " + (.status.nodeInfo.kubeletVersion // ""), (.status.nodeInfo.containerRuntimeVersion // "")],
    services: ["kubelet"],
    listening: [{port: 10250, proto: "tcp", process: "kubelet"}],
    tags: (.metadata.labels // {} | with_entries(select(.key | test("^(topology|node-role)\\\\.kubernetes\\\\.io/"))))
  }]' "$TMPD/nodes.json" | envelope "$PLATFORM" > "$OUTDIR/k8s-discovery.json"
echo "wrote k8s-workloads.json, k8s-nodes.json and k8s-discovery.json" >&2
`,
  "collect-libvirt.sh": `#!/usr/bin/env bash
# collect-libvirt.sh: KVM / libvirt inventory as an archtoolkit.discovery v1 file.
#
# Run on a KVM host (or anywhere with LIBVIRT_DEFAULT_URI pointing at one).
# Reads: virsh list --all --name, then per domain virsh dominfo, dumpxml,
# domblklist --details, domblkinfo, domiflist, domifaddr and (with the guest
# agent) guestinfo --os. https://libvirt.org/manpages/virsh.html
#
# Usage: collect-libvirt.sh [--out FILE]
# Needs: bash 4+, jq, virsh. xmllint is used when present.
# The output has no user name and no path; collectedAt is a date.

# @@common@@

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="\${2:?--out needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
need virsh jq

HOST="$(virsh hostname 2>/dev/null || uname -n)"

xpath() { # xml-file expression -> text ('' when absent)
  if command -v xmllint >/dev/null 2>&1; then xmllint --xpath "$2" "$1" 2>/dev/null || true
  else echo ''; fi
}

while IFS= read -r dom <&3; do
  [ -n "$dom" ] || continue
  info="$(virsh dominfo "$dom")"
  field() { printf '%s\\n' "$info" | awk -F': *' -v k="$1" '$1 == k { print $2; exit }'; }
  uuid="$(field UUID)"
  state="$(field State)"
  vcpu="$(field 'CPU(s)')"
  memkib="$(field 'Max memory' | awk '{print $1}')"
  xml="$TMPD/dom.xml"
  virsh dumpxml "$dom" > "$xml"
  firmware=bios
  if grep -qE "firmware=['\\"]efi['\\"]|<loader[^>]*type=['\\"]pflash['\\"]" "$xml"; then firmware=efi; fi
  desc="$(xpath "$xml" 'string(/domain/description)')"
  # Disks: target and capacity / allocation in bytes.
  disks='[]'
  while read -r dtype device target source; do
    [ "$device" = disk ] || continue
    [ -n "\${target:-}" ] || continue
    cap="$(virsh domblkinfo "$dom" "$target" 2>/dev/null | awk '/^Capacity:/ {print $2}')"
    alloc="$(virsh domblkinfo "$dom" "$target" 2>/dev/null | awk '/^Allocation:/ {print $2}')"
    [ -n "$cap" ] || continue
    disks="$(jq -c --argjson c "\${cap:-0}" --argjson a "\${alloc:-0}" '. + [{gib: (($c / 1073741824) | ceil), usedGib: ((($a / 1073741824) * 10 | round) / 10)}]' <<<"$disks")"
    : "$dtype" "$source"
  done < <(virsh domblklist "$dom" --details | tail -n +3)
  # NICs: MACs from domiflist, addresses from the guest agent, else DHCP leases.
  nics='[]'
  addrs="$( { virsh domifaddr "$dom" --source agent 2>/dev/null || virsh domifaddr "$dom" 2>/dev/null || true; } \\
    | awk 'NR > 2 && NF >= 4 { if ($2 != "-") mac = tolower($2); a = $4; sub(/\\/.*/, "", a); print mac, $3, a }')"
  while read -r _if _type _source _model mac; do
    [ -n "\${mac:-}" ] || continue
    v4="$(printf '%s\\n' "$addrs" | awk -v m="\${mac,,}" '$1 == m && $2 == "ipv4" && $3 !~ /^127\\./ { print $3 }' | jq -R . | jq -sc .)"
    v6="$(printf '%s\\n' "$addrs" | awk -v m="\${mac,,}" '$1 == m && $2 == "ipv6" && $3 !~ /^(fe80|::1$)/ { print $3 }' | jq -R . | jq -sc .)"
    nics="$(jq -c --arg mac "$mac" --argjson v4 "$v4" --argjson v6 "$v6" '. + [{mac: $mac, ipv4: $v4, ipv6: $v6}]' <<<"$nics")"
  done < <(virsh domiflist "$dom" | tail -n +3)
  # guestinfo pads the key before the colon ("os.pretty-name      : Rocky Linux 9.4").
  ginfo="$(virsh guestinfo "$dom" --os 2>/dev/null || true)"
  osname="$(printf '%s\\n' "$ginfo" | awk -F'[[:space:]]*:[[:space:]]*' '$1 == "os.pretty-name" { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }')"
  osver="$(printf '%s\\n' "$ginfo" | awk -F'[[:space:]]*:[[:space:]]*' '$1 == "os.version-id" { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }')"
  jq -nc --arg name "$dom" --arg id "$uuid" --arg host "$HOST" --arg state "$state" \\
    --argjson vcpu "\${vcpu:-0}" --argjson memkib "\${memkib:-0}" --arg fw "$firmware" \\
    --argjson disks "$disks" --argjson nics "$nics" --arg os "$osname" --arg osv "$osver" --arg desc "$desc" \\
    '{name: $name, id: $id, host: $host, kind: "vm", powerState: $state, vcpu: $vcpu,
      ramGib: ((($memkib / 1048576) * 10 | round) / 10), firmware: $fw, disks: $disks, nics: $nics,
      os: {raw: $os, version: $osv}} + (if $desc == "" then {} else {annotation: $desc} end)'
done 3< <(virsh list --all --name) | jq -sc . | envelope kvm "$HOST" | emit
`,
  "collect-linux.sh": `#!/usr/bin/env bash
# collect-linux.sh: the Linux guest collector (physical servers and any VM).
#
# Writes one archtoolkit.discovery v1 file for this server: hardware and OS,
# installed packages, running services, listening ports, outbound
# connections and utilisation percentiles.
#
# Modes:
#   inventory (default)  write the discovery file now. Utilisation comes from a
#                        finished sampling run, else sysstat (sadf) over the
#                        last --days, else one point-in-time reading.
#   start --days N       start sampling every minute for N days (default 14):
#                        a cron.d entry (or a systemd timer) runs "sample".
#   sample               one sample; on the last day it writes the percentiles
#                        and removes its own schedule.
#   stop                 remove the schedule and the samples.
#
# Usage: collect-linux.sh [inventory|start|sample|stop] [--days N] [--out FILE] [--name NAME]
# Needs: bash 4+, coreutils, awk, iproute2 (ip, ss), util-linux (lsblk). No jq.
# Run as root for process names and the sampling schedule. The file holds no
# user name and no path; collectedAt is a date.

set -euo pipefail

MODE=inventory
DAYS=14
OUT=""
NAME=""
STATE=/var/lib/archtoolkit
while [ $# -gt 0 ]; do
  case "$1" in
    inventory|start|sample|stop) MODE="$1"; shift ;;
    --days) DAYS="\${2:?--days needs a number}"; shift 2 ;;
    --out) OUT="\${2:?--out needs a file}"; shift 2 ;;
    --name) NAME="\${2:?--name needs a name}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$DAYS" in ''|*[!0-9]*) echo "--days must be a whole number" >&2; exit 2 ;; esac

# ---- JSON without jq -------------------------------------------------------
js() { # a JSON string
  local s="\${1-}"
  s="\${s//\\\\/\\\\\\\\}"; s="\${s//\\"/\\\\\\"}"; s="\${s//$'\\t'/ }"; s="\${s//$'\\r'/}"; s="\${s//$'\\n'/ }"
  printf '"%s"' "$(printf '%s' "$s" | tr -d '\\000-\\037')"
}
jarr() { # lines on stdin -> a JSON array of strings (blank lines dropped)
  local first=1 line
  printf '['
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    [ "$first" = 1 ] || printf ','
    first=0
    js "$line"
  done
  printf ']'
}
jnum() { case "\${1-}" in ''|*[!0-9.eE+-]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }

# Percentile (nearest rank) of numbers on stdin; "null" when there are none.
pct() { sort -g | awk -v p="$1" '{ a[NR] = $1 } END { if (NR == 0) { print "null"; exit } r = int(p / 100 * NR); if (r < p / 100 * NR) r++; if (r < 1) r = 1; printf "%.1f\\n", a[r] }'; }

# ---- the platform this guest runs on -----------------------------------------
platform() {
  local virt vendor product asset
  virt="$(systemd-detect-virt 2>/dev/null || true)"
  vendor="$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null || true)"
  product="$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)"
  asset="$(cat /sys/class/dmi/id/chassis_asset_tag 2>/dev/null || true)"
  case "$vendor $product $asset" in
    *7783-7084-3265-9085-8269-3286-77*) echo azure; return ;;
    *Amazon*) echo aws; return ;;
    *Google*) echo google; return ;;
    *OracleCloud*) echo oci; return ;;
    *Nutanix*) echo ahv; return ;;
  esac
  case "$virt" in
    vmware) echo vsphere ;;
    microsoft) echo hyperv ;;
    kvm|qemu) echo kvm ;;
    xen) echo xen ;;
    none) echo physical ;;
    '') if [ -n "$vendor" ]; then echo physical; else echo other; fi ;;
    *) echo other ;;
  esac
}

# ---- sections ---------------------------------------------------------------
disks_json() {
  local cols=NAME,PKNAME,TYPE,SIZE,FSUSED
  lsblk -b -P -o "$cols" >/dev/null 2>&1 || cols=NAME,PKNAME,TYPE,SIZE
  lsblk -b -P -o "$cols" 2>/dev/null | awk '
    { line = $0; n = ""
      while (match(line, /[A-Z]+="[^"]*"/)) {
        kv = substr(line, RSTART, RLENGTH); k = substr(kv, 1, index(kv, "=") - 1)
        v = substr(kv, index(kv, "=") + 2); v = substr(v, 1, length(v) - 1); f[k] = v
        line = substr(line, RSTART + RLENGTH)
      }
      n = f["NAME"]; parent[n] = f["PKNAME"]; type[n] = f["TYPE"]; size[n] = f["SIZE"]; used[n] = f["FSUSED"]; order[++cnt] = n
      f["FSUSED"] = ""; f["PKNAME"] = "" }
    END {
      for (i = 1; i <= cnt; i++) { n = order[i]; if (type[n] == "disk" && n !~ /^(zram|loop|ram)/ && !(n in disk)) { disk[n] = size[n]; dorder[++dc] = n } }
      for (i = 1; i <= cnt; i++) { n = order[i]; if (used[n] == "") continue; p = n; g = 0
        while (p != "" && type[p] != "disk" && g < 12) { p = parent[p]; g++ }
        if (p in disk) u[p] += used[n] }
      printf "["
      for (i = 1; i <= dc; i++) { d = dorder[i]; if (i > 1) printf ","
        printf "{\\"name\\":\\"%s\\",\\"gib\\":%d", d, int((disk[d] + 1073741823) / 1073741824)
        if (d in u) printf ",\\"usedGib\\":%.1f", u[d] / 1073741824
        printf "}" }
      printf "]" }'
}

nics_json() {
  local first=1 ifc mac v4 v6
  printf '['
  for ifc in $(ip -o link show | awk -F': ' '{ sub(/@.*/, "", $2); print $2 }'); do
    case "$ifc" in lo|docker*|veth*|virbr*|cni*|flannel*|br-*|kube*|cali*|tun*|vxlan*) continue ;; esac
    mac="$(cat "/sys/class/net/$ifc/address" 2>/dev/null || true)"
    v4="$(ip -o -4 addr show dev "$ifc" scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | jarr)"
    v6="$(ip -o -6 addr show dev "$ifc" scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | jarr)"
    [ "$v4" = '[]' ] && [ "$v6" = '[]' ] && continue
    [ "$first" = 1 ] || printf ','
    first=0
    printf '{"name":%s,"mac":%s,"ipv4":%s,"ipv6":%s}' "$(js "$ifc")" "$(js "$mac")" "$v4" "$v6"
  done
  printf ']'
}

software_lines() {
  if command -v rpm >/dev/null 2>&1; then rpm -qa --qf '%{NAME} %{VERSION}\\n' 2>/dev/null
  elif command -v dpkg-query >/dev/null 2>&1; then dpkg-query -W -f='\${Package} \${Version}\\n' 2>/dev/null
  fi | sort -u | awk 'NR <= 5000'
}

services_lines() {
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{ sub(/\\.service$/, "", $1); print $1 }' | sort -u
}

# "port proto process" per listening socket.
listening_lines() {
  { ss -tlnp 2>/dev/null | awk 'NR > 1 { print "tcp", $4, $0 }'
    ss -ulnp 2>/dev/null | awk 'NR > 1 { print "udp", $4, $0 }'; } \\
  | awk '{ addr = $2; port = addr; sub(/.*:/, "", port); proc = ""
           if (match($0, /\\(\\("[^"]+"/)) proc = substr($0, RSTART + 3, RLENGTH - 4)
           if (port ~ /^[0-9]+$/) print port, $1, proc }' | sort -u
}

listening_json() {
  listening_lines | awk 'BEGIN { printf "[" } { if (NR > 1) printf ","; printf "{\\"port\\":%d,\\"proto\\":\\"%s\\"", $1, $2; if ($3 != "") printf ",\\"process\\":\\"%s\\"", $3; printf "}" } END { printf "]" }'
}

# "remote port process" per outbound established connection (inbound ones end on a listening port).
connection_lines() {
  local listen
  listen="$(listening_lines | awk '$2 == "tcp" { printf "%s ", $1 }')"
  ss -tnp state established 2>/dev/null | awk -v listen=" $listen" 'NR > 1 {
      lp = $3; sub(/.*:/, "", lp); if (index(listen, " " lp " ")) next
      peer = $4; rport = peer; sub(/.*:/, "", rport); raddr = substr(peer, 1, length(peer) - length(rport) - 1)
      gsub(/[\\[\\]]/, "", raddr); sub(/^::ffff:/, "", raddr)
      if (raddr ~ /^127\\./ || raddr == "::1") next
      proc = ""; if (match($0, /\\(\\("[^"]+"/)) proc = substr($0, RSTART + 3, RLENGTH - 4)
      print raddr, rport, proc }'
}

connections_json() { # aggregated "remote port process" lines on stdin
  sort | uniq -c | sort -rn | awk 'NR <= 500' | awk 'BEGIN { printf "[" } { if (NR > 1) printf ","; printf "{\\"remote\\":\\"%s\\",\\"port\\":%d,\\"proto\\":\\"tcp\\",\\"count\\":%d", $2, $3, $1; if ($4 != "") printf ",\\"process\\":\\"%s\\"", $4; printf "}" } END { printf "]" }'
}

mem_used_gib() { awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } END { printf "%.2f\\n", (t - a) / 1048576 }' /proc/meminfo; }
cpu_counters() { awk '/^cpu / { t = 0; for (i = 2; i <= 9; i++) t += $i; print t, $5 + $6; exit }' /proc/stat; }
disk_counters() { awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme[0-9]+n[0-9]+)$/ { io += $4 + $8; sec += $6 + $10 } END { printf "%d %d\\n", io, sec }' /proc/diskstats; }

# Utilisation JSON from "epoch cpu mem iops mbps" lines in a file.
util_from_samples() {
  local f="$1" n first last
  n="$(wc -l < "$f" | tr -d ' ')"
  [ "$n" -gt 0 ] || { echo null; return; }
  first="$(sort -n "$f" | awk 'NR <= 1' | awk '{ print $1 }')"
  last="$(sort -n "$f" | tail -n 1 | awk '{ print $1 }')"
  local gap expected days coverage
  gap="$(sort -n "$f" | awk 'NR > 1 { d = $1 - p; if (d > 0) print d } { p = $1 }' | sort -n | awk '{ a[NR] = $1 } END { if (NR == 0) print 0; else print a[int((NR + 1) / 2)] }')"
  if [ "$gap" -gt 0 ]; then expected=$(( (last - first) / gap + 1 )); else expected="$n"; fi
  days="$(awk -v s=$((last - first)) 'BEGIN { printf "%.1f", s / 86400 }')"
  coverage="$(awk -v n="$n" -v e="$expected" 'BEGIN { c = n / (e > 0 ? e : 1); if (c > 1) c = 1; printf "%.2f", c }')"
  printf '{"days":%s,"samples":%s,"coverage":%s,"cpuP50Pct":%s,"cpuP95Pct":%s,"cpuP99Pct":%s,"cpuMaxPct":%s,"memP95Gib":%s,"memMaxGib":%s,"iopsP95":%s,"iopsMax":%s,"mbpsP95":%s}' \\
    "$days" "$n" "$coverage" \\
    "$(awk '$2 != "" { print $2 }' "$f" | pct 50)" "$(awk '$2 != "" { print $2 }' "$f" | pct 95)" \\
    "$(awk '$2 != "" { print $2 }' "$f" | pct 99)" "$(awk '$2 != "" { print $2 }' "$f" | pct 100)" \\
    "$(awk '$3 != "" { print $3 }' "$f" | pct 95)" "$(awk '$3 != "" { print $3 }' "$f" | pct 100)" \\
    "$(awk '$4 != "" { print $4 }' "$f" | pct 95)" "$(awk '$4 != "" { print $4 }' "$f" | pct 100)" \\
    "$(awk '$5 != "" { print $5 }' "$f" | pct 95)"
}

# sysstat history over the last DAYS: "epoch cpu mem iops mbps" lines.
sysstat_samples() {
  local dir="" d f
  command -v sadf >/dev/null 2>&1 || return 1
  for d in /var/log/sa /var/log/sysstat; do [ -d "$d" ] && dir="$d" && break; done
  [ -n "$dir" ] || return 1
  local files
  files="$(find "$dir" -maxdepth 1 -name 'sa[0-9]*' -mtime -"$DAYS" 2>/dev/null | sort)"
  [ -n "$files" ] || return 1
  local tmp; tmp="$(mktemp -d)"
  for f in $files; do
    sadf -d -U "$f" -- -u 2>/dev/null | awk -F';' '/^#/ { for (i = 1; i <= NF; i++) { h = $i; sub(/^# */, "", h); c[h] = i }; next }
      NF > 3 && ($c["CPU"] == "-1" || $c["CPU"] == "all") { print $c["timestamp"], 100 - $c["%idle"] }' >> "$tmp/cpu"
    sadf -d -U "$f" -- -r 2>/dev/null | awk -F';' '/^#/ { for (i = 1; i <= NF; i++) { h = $i; sub(/^# */, "", h); c[h] = i }; next }
      NF > 3 && ("kbmemused" in c) { printf "%s %.2f\\n", $c["timestamp"], $c["kbmemused"] / 1048576 }' >> "$tmp/mem"
    sadf -d -U "$f" -- -b 2>/dev/null | awk -F';' '/^#/ { for (i = 1; i <= NF; i++) { h = $i; sub(/^# */, "", h); c[h] = i }; next }
      NF > 3 && ("tps" in c) { printf "%s %.1f %.2f\\n", $c["timestamp"], $c["tps"], ($c["bread/s"] + $c["bwrtn/s"]) * 512 / 1000000 }' >> "$tmp/io"
  done
  [ -s "$tmp/cpu" ] || { rm -rf "$tmp"; return 1; }
  # Join on the timestamp (sysstat writes all three at the same instants).
  awk 'FILENAME ~ /mem$/ { m[$1] = $2; next } FILENAME ~ /io$/ { io[$1] = $2; mb[$1] = $3; next } { print $1, $2, m[$1], io[$1], mb[$1] }' "$tmp/mem" "$tmp/io" "$tmp/cpu"
  rm -rf "$tmp"
}

point_util() {
  local a b
  a="$(cpu_counters)"; sleep 2; b="$(cpu_counters)"
  printf '{"days":0,"samples":1,"coverage":0,"cpuP95Pct":%s,"memP95Gib":%s}' \\
    "$(printf '%s %s\\n' "$a" "$b" | awk '{ dt = $3 - $1; di = $4 - $2; if (dt > 0) printf "%.1f", 100 * (1 - di / dt); else print "null" }')" \\
    "$(mem_used_gib)"
}

utilisation_json() {
  if [ -s "$STATE/util.json" ]; then cat "$STATE/util.json"; return; fi
  local tmp; tmp="$(mktemp)"
  if sysstat_samples > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then util_from_samples "$tmp"; rm -f "$tmp"; return; fi
  rm -f "$tmp"
  point_util
}

inventory() {
  local name platform kind osname osver vcpu memkb fw shares printers sessions conns
  name="\${NAME:-$(hostname -s 2>/dev/null || uname -n)}"
  platform="$(platform)"
  kind=vm; [ "$platform" = physical ] && kind=physical
  osname=""; osver=""
  if [ -r /etc/os-release ]; then
    osname="$(. /etc/os-release && printf '%s' "\${PRETTY_NAME:-\${NAME:-}}")"
    osver="$(. /etc/os-release && printf '%s' "\${VERSION_ID:-}")"
  fi
  vcpu="$(nproc --all 2>/dev/null || getconf _NPROCESSORS_ONLN)"
  memkb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
  fw=bios; [ -d /sys/firmware/efi ] && fw=efi
  shares=$(( $(testparm -s 2>/dev/null | grep -cE '^\\[' || true) + $(exportfs -s 2>/dev/null | grep -c . || true) ))
  printers="$(lpstat -v 2>/dev/null | grep -c . || true)"
  sessions="$(who 2>/dev/null | grep -c . || true)"
  if [ -s "$STATE/conn.txt" ]; then conns="$(connections_json < "$STATE/conn.txt")"; else conns="$(connection_lines | connections_json)"; fi
  printf '{"kind":"archtoolkit.discovery","v":1,"source":{"platform":%s},"collectedAt":"%s","servers":[{' "$(js "$platform")" "$(date -u +%Y-%m-%d)"
  printf '"name":%s,"kind":"%s","powerState":"poweredOn","vcpu":%s,"ramGib":%s,"firmware":"%s",' \\
    "$(js "$name")" "$kind" "$(jnum "$vcpu")" "$(awk -v k="$memkb" 'BEGIN { printf "%.1f", k / 1048576 }')" "$fw"
  printf '"disks":%s,"nics":%s,"os":{"raw":%s,"version":%s},' "$(disks_json)" "$(nics_json)" "$(js "$osname")" "$(js "$osver")"
  printf '"software":%s,"services":%s,"listening":%s,"connections":%s,' "$(software_lines | jarr)" "$(services_lines | jarr)" "$(listening_json)" "$conns"
  printf '"shares":%s,"printers":%s,"sessions":%s,"utilisation":%s}]}\\n' "$(jnum "$shares")" "$(jnum "$printers")" "$(jnum "$sessions")" "$(utilisation_json)"
}

start() {
  [ "$(id -u)" = 0 ] || { echo "start needs root" >&2; exit 3; }
  mkdir -p "$STATE"; chmod 700 "$STATE"
  cp "$0" "$STATE/collect-linux.sh"; chmod 700 "$STATE/collect-linux.sh"
  rm -f "$STATE/samples.txt" "$STATE/conn.txt" "$STATE/util.json" "$STATE/last"
  echo "$(date +%s) $DAYS" > "$STATE/start"
  if [ -d /etc/cron.d ]; then
    printf '* * * * * root /bin/bash %s sample >/dev/null 2>&1\\n' "$STATE/collect-linux.sh" > /etc/cron.d/archtoolkit-util
    chmod 644 /etc/cron.d/archtoolkit-util
  elif command -v systemctl >/dev/null 2>&1; then
    printf '[Unit]\\nDescription=ArchToolKit utilisation sample\\n[Service]\\nType=oneshot\\nExecStart=/bin/bash %s sample\\n' "$STATE/collect-linux.sh" > /etc/systemd/system/archtoolkit-util.service
    printf '[Unit]\\nDescription=ArchToolKit utilisation sampling\\n[Timer]\\nOnCalendar=minutely\\n[Install]\\nWantedBy=timers.target\\n' > /etc/systemd/system/archtoolkit-util.timer
    systemctl daemon-reload
    systemctl enable --now archtoolkit-util.timer
  else
    echo "no cron.d and no systemd: cannot schedule sampling" >&2; exit 3
  fi
  echo "sampling every minute for $DAYS day(s)"
}

unschedule() {
  rm -f /etc/cron.d/archtoolkit-util
  if [ -f /etc/systemd/system/archtoolkit-util.timer ]; then
    systemctl disable --now archtoolkit-util.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/archtoolkit-util.timer /etc/systemd/system/archtoolkit-util.service
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
}

sample() {
  [ -f "$STATE/start" ] || exit 0
  local start days now cpu total idle io sec
  read -r start days < "$STATE/start"
  now="$(date +%s)"
  read -r total idle < <(cpu_counters)
  read -r io sec < <(disk_counters)
  if [ -f "$STATE/last" ]; then
    local lt ltotal lidle lio lsec
    read -r lt ltotal lidle lio lsec < "$STATE/last"
    if [ "$now" -gt "$lt" ] && [ "$total" -gt "$ltotal" ]; then
      awk -v now="$now" -v dt=$((now - lt)) -v t=$((total - ltotal)) -v i=$((idle - lidle)) -v io=$((io - lio)) -v sec=$((sec - lsec)) -v mem="$(mem_used_gib)" \\
        'BEGIN { printf "%d %.1f %.2f %.1f %.2f\\n", now, 100 * (1 - i / t), mem, io / dt, sec * 512 / 1000000 / dt }' >> "$STATE/samples.txt"
    fi
  fi
  echo "$now $total $idle $io $sec" > "$STATE/last"
  if [ $(( (now / 60) % 10 )) -eq 0 ]; then connection_lines >> "$STATE/conn.txt" || true; fi
  if [ $((now - start)) -ge $((days * 86400)) ] && [ -s "$STATE/samples.txt" ]; then
    util_from_samples "$STATE/samples.txt" > "$STATE/util.json.tmp" && mv "$STATE/util.json.tmp" "$STATE/util.json"
    rm -f "$STATE/start" "$STATE/last"
    unschedule
  fi
}

stop() {
  unschedule
  rm -rf "$STATE"
}

case "$MODE" in
  inventory) if [ -n "$OUT" ]; then (umask 077; inventory > "$OUT"); else inventory; fi ;;
  start) start ;;
  sample) sample ;;
  stop) stop ;;
esac
`,
  "collect-oci.sh": `#!/usr/bin/env bash
# collect-oci.sh: OCI Compute inventory (cloud-to-cloud source) as an
# archtoolkit.discovery v1 file.
#
#   oci compute instance list --all, compute boot-volume-attachment list,
#   compute volume-attachment list, bv boot-volume list, bv volume list,
#   compute instance list-vnics, compute image get (OS name)
# for one compartment (or its whole subtree with --subtree). vCPU and memory
# come from the instance's shape configuration. Freeform and defined tags
# become attributes.
#
# Usage: OCI_COMPARTMENT_ID=ocid1.compartment... collect-oci.sh [--subtree] [--region R] [--out FILE]
# Credentials: the OCI CLI's own (~/.oci/config profile, or
# OCI_CLI_AUTH=instance_principal). Nothing is written but the output.
# Needs: bash 4+, jq, oci. The output has no user name and no path.

# @@common@@

SUBTREE=0
REGION_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --subtree) SUBTREE=1; shift ;;
    --region) REGION_ARGS=(--region "\${2:?--region needs a region}"); shift 2 ;;
    --out) OUT="\${2:?--out needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
need oci jq
ROOT="\${OCI_COMPARTMENT_ID:?set OCI_COMPARTMENT_ID to the compartment OCID}"
o() { oci \${REGION_ARGS[@]+"\${REGION_ARGS[@]}"} "$@" --output json 2>/dev/null </dev/null; }

COMPARTMENTS="$ROOT"
if [ "$SUBTREE" = 1 ]; then
  COMPARTMENTS="$ROOT $(o iam compartment list --compartment-id "$ROOT" --compartment-id-in-subtree true --all \\
    | jq -r '[.data[]? | select(.["lifecycle-state"] == "ACTIVE") | .id] | join(" ")')"
fi

echo '{}' > "$TMPD/images"
for comp in $COMPARTMENTS; do
  o compute instance list --compartment-id "$comp" --all > "$TMPD/inst.json" || echo '{"data":[]}' > "$TMPD/inst.json"
  o bv volume list --compartment-id "$comp" --all > "$TMPD/vol.json" || echo '{"data":[]}' > "$TMPD/vol.json"
  : > "$TMPD/boot.json"
  for ad in $(jq -r '[.data[]?["availability-domain"]] | unique | join(" ")' "$TMPD/inst.json"); do
    o bv boot-volume list --compartment-id "$comp" --availability-domain "$ad" --all | jq -c '.data[]?' >> "$TMPD/boot.json" || true
  done
  jq -c '.data[]? | select(.["lifecycle-state"] != "TERMINATED")' "$TMPD/inst.json" | while IFS= read -r inst; do
    id="$(jq -r .id <<<"$inst")"
    ad="$(jq -r '.["availability-domain"]' <<<"$inst")"
    img="$(jq -r '.["source-details"]["image-id"] // .["image-id"] // ""' <<<"$inst")"
    if [ -n "$img" ] && [ "$(jq -r --arg i "$img" 'has($i)' "$TMPD/images")" = false ]; then
      name="$(o compute image get --image-id "$img" | jq -r '[.data["operating-system"], .data["operating-system-version"]] | map(select(. != null)) | join(" ")' || true)"
      jq -c --arg i "$img" --arg n "$name" '. + {($i): $n}' "$TMPD/images" > "$TMPD/images.new" && mv "$TMPD/images.new" "$TMPD/images"
    fi
    bootatt="$(o compute boot-volume-attachment list --compartment-id "$comp" --availability-domain "$ad" --instance-id "$id" | jq -c '[.data[]?["boot-volume-id"]]' || echo '[]')"
    volatt="$(o compute volume-attachment list --compartment-id "$comp" --instance-id "$id" --all | jq -c '[.data[]? | select(.["lifecycle-state"] == "ATTACHED") | .["volume-id"]]' || echo '[]')"
    vnics="$(o compute instance list-vnics --instance-id "$id" --all | jq -c '[.data[]? | {mac: .["mac-address"], ipv4: ([.["private-ip"] // empty] + [.["public-ip"] // empty]), ipv6: (.["ipv6-addresses"] // [])}]' || echo '[]')"
    jq -nc --argjson i "$inst" --argjson bootatt "$bootatt" --argjson volatt "$volatt" --argjson nics "$vnics" \\
      --slurpfile boots "$TMPD/boot.json" --slurpfile vols "$TMPD/vol.json" --slurpfile imgs "$TMPD/images" '
      ([$boots[] | {key: .id, value: .["size-in-gbs"]}] | from_entries) as $bs
      | ([$vols[0].data[]? | {key: .id, value: .["size-in-gbs"]}] | from_entries) as $vs
      | {
        name: $i["display-name"],
        id: $i.id,
        region: $i.region,
        cluster: $i["availability-domain"],
        kind: "instance",
        powerState: $i["lifecycle-state"],
        size: $i.shape,
        vcpu: ($i["shape-config"].vcpus // (($i["shape-config"].ocpus // 0) * 2) | floor),
        ramGib: ($i["shape-config"]["memory-in-gbs"] // 0),
        firmware: (if (($i["launch-options"].firmware // "") | test("UEFI")) then "efi" else "bios" end),
        disks: ([$bootatt[] | {gib: ($bs[.] // 0)}] + [$volatt[] | {gib: ($vs[.] // 0)}]),
        nics: $nics,
        os: {raw: ($imgs[0][$i["source-details"]["image-id"] // ""] // "")},
        tags: (($i["freeform-tags"] // {}) + ([($i["defined-tags"] // {}) | to_entries[] | .key as $ns | .value | to_entries[] | {key: ($ns + "." + .key), value: (.value | tostring)}] | from_entries))
      }'
  done
done | jq -sc . | envelope oci "$ROOT" | emit
`,
  "collect-ovirt.sh": `#!/usr/bin/env bash
# collect-ovirt.sh: Red Hat Virtualization / oVirt / Oracle Linux
# Virtualization Manager inventory as an archtoolkit.discovery v1 file.
#
# REST API v4 (https://ovirt.github.io/ovirt-engine-api-model/master/):
#   GET https://<engine>/ovirt-engine/api/vms?follow=disk_attachments.disk,nics.reported_devices
#   GET .../api/hosts and .../api/clusters (ids to names)
# with "Version: 4" and "Accept: application/json". The follow= expansion of
# nics.reported_devices is marked (verify) for older engines; without it the
# addresses are blank and the MACs remain.
#
# Usage: OVIRT_URL=https://engine.example.com collect-ovirt.sh [--out FILE]
# Credentials: OVIRT_USER (e.g. admin@internal) and OVIRT_PASSWORD (or
# OVIRT_PASSWORD_FILE, mode 600, or ATK_VAULT_CMD). OVIRT_CA_FILE for the
# engine CA; OVIRT_INSECURE=1 skips certificate checks (not recommended).
# Needs: bash 4+, curl, jq. The output has no user name and no path.

# @@common@@

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="\${2:?--out needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
need curl jq
BASE="\${OVIRT_URL:?set OVIRT_URL to the engine address, e.g. https://engine.example.com}"
BASE="\${BASE%/}"
USER_NAME="$(secret OVIRT_USER)"
PASS="$(secret OVIRT_PASSWORD)"
TLS=()
[ -n "\${OVIRT_CA_FILE:-}" ] && TLS+=(--cacert "$OVIRT_CA_FILE")
[ "\${OVIRT_INSECURE:-0}" = 1 ] && TLS+=(-k)

cfg_escape() { printf '%s' "$1" | sed 's/[\\\\"]/\\\\&/g'; }
get() { # path under /ovirt-engine/api
  printf 'user = "%s:%s"\\n' "$(cfg_escape "$USER_NAME")" "$(cfg_escape "$PASS")" \\
    | curl -sS --fail -K - \${TLS[@]+"\${TLS[@]}"} -H 'Version: 4' -H 'Accept: application/json' "$BASE/ovirt-engine/api$1"
}

get /hosts > "$TMPD/hosts.json"
get /clusters > "$TMPD/clusters.json"
get '/vms?follow=disk_attachments.disk,nics.reported_devices' > "$TMPD/vms.json"
MANAGER="$(printf '%s' "$BASE" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"

jq -c --slurpfile hosts "$TMPD/hosts.json" --slurpfile clusters "$TMPD/clusters.json" '
  ([$hosts[0].host[]? | {key: .id, value: .name}] | from_entries) as $h
  | ([$clusters[0].cluster[]? | {key: .id, value: .name}] | from_entries) as $c
  | def gib(b): (((b // 0) | tonumber) / 1073741824);
  [.vm[]? | . as $vm | {
    name, id,
    host: ($h[.host.id // ""] // null),
    cluster: ($c[.cluster.id // ""] // null),
    kind: "vm",
    powerState: (.status // "unknown"),
    vcpu: (((.cpu.topology.sockets // "1") | tonumber) * ((.cpu.topology.cores // "1") | tonumber) * ((.cpu.topology.threads // "1") | tonumber)),
    ramGib: ((gib(.memory) * 10 | round) / 10),
    firmware: (if ((.bios.type // "") | test("ovmf"; "i")) then "efi" else "bios" end),
    disks: [(.disk_attachments.disk_attachment // [])[] | {gib: (gib(.disk.provisioned_size) | ceil), usedGib: ((gib(.disk.actual_size) * 10 | round) / 10), boot: ((.bootable // "false") == "true")}]
           | sort_by(if .boot then 0 else 1 end) | map(del(.boot)),
    nics: [(.nics.nic // [])[] | {
      mac: (.mac.address // null),
      ipv4: [(.reported_devices.reported_device // [])[] | (.ips.ip // [])[] | select(.version == "v4") | .address],
      ipv6: [(.reported_devices.reported_device // [])[] | (.ips.ip // [])[] | select(.version == "v6") | .address | select(test("^fe80") | not)]
    }],
    os: {raw: ([.guest_operating_system.distribution, .guest_operating_system.version.full_version] | map(select(. != null)) | join(" ")
               | if . == "" then ($vm.os.type // "") else . end)},
    annotation: (.description // null)
  } | with_entries(select(.value != null))]' "$TMPD/vms.json" | envelope ovirt "$MANAGER" | emit
`,
  "collect-proxmox.sh": `#!/usr/bin/env bash
# collect-proxmox.sh: Proxmox VE inventory as an archtoolkit.discovery v1 file.
#
# Run on any node of the cluster as root (pvesh talks to the local API):
#   pvesh get /cluster/resources --type vm --output-format json
#   pvesh get /nodes/<node>/<qemu|lxc>/<vmid>/config --output-format json
#   pvesh get /nodes/<node>/qemu/<vmid>/agent/network-get-interfaces (guest agent)
#   pvesh get /nodes/<node>/lxc/<vmid>/interfaces
# (https://pve.proxmox.com/pve-docs/api-viewer/). LXC containers are written
# with kind "lxc": the page offers them as containers-pattern candidates.
# Templates are skipped.
#
# Usage: collect-proxmox.sh [--out FILE]
# Needs: bash 4+, jq, pvesh. The output has no user name and no path.

# @@common@@

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="\${2:?--out needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
need pvesh jq

CLUSTER="$(pvesh get /cluster/status --output-format json 2>/dev/null | jq -r '[.[] | select(.type == "cluster") | .name][0] // empty')"
[ -n "$CLUSTER" ] || CLUSTER="$(uname -n)"

# A Proxmox size ("32G", "512M", "1T", "100") in GiB.
SIZE_JQ='def gib: (capture("size=(?<n>[0-9.]+)(?<u>[KMGT]?)") // {n: "0", u: "G"}) | (.n | tonumber) * ({"K": (1 / 1048576), "M": (1 / 1024), "G": 1, "T": 1024, "": (1 / 1073741824)}[.u]);'

pvesh get /cluster/resources --type vm --output-format json | jq -c '.[] | select((.template // 0) == 0)' | while IFS= read -r res; do
  node="$(jq -r .node <<<"$res")"
  vmid="$(jq -r .vmid <<<"$res")"
  type="$(jq -r .type <<<"$res")"
  cfg="$(pvesh get "/nodes/$node/$type/$vmid/config" --output-format json 2>/dev/null </dev/null || echo '{}')"
  ips='[]'
  osinfo='{}'
  if [ "$type" = qemu ]; then
    osinfo="$(pvesh get "/nodes/$node/qemu/$vmid/agent/get-osinfo" --output-format json 2>/dev/null </dev/null | jq -c '.result // {}' || echo '{}')"
    ips="$(pvesh get "/nodes/$node/qemu/$vmid/agent/network-get-interfaces" --output-format json 2>/dev/null </dev/null \\
      | jq -c '[(.result // [])[] | select(.name != "lo") | {mac: (.["hardware-address"] // null),
          ipv4: [(.["ip-addresses"] // [])[] | select(.["ip-address-type"] == "ipv4") | .["ip-address"]],
          ipv6: [(.["ip-addresses"] // [])[] | select(.["ip-address-type"] == "ipv6") | .["ip-address"] | select(test("^fe80") | not)]}]' || echo '[]')"
  else
    ips="$(pvesh get "/nodes/$node/lxc/$vmid/interfaces" --output-format json 2>/dev/null </dev/null \\
      | jq -c '[.[]? | select(.name != "lo") | {mac: (.hwaddr // null),
          ipv4: [(.inet // empty) | sub("/.*"; "")], ipv6: [(.inet6 // empty) | sub("/.*"; "") | select(test("^fe80") | not)]}]' || echo '[]')"
  fi
  jq -nc --argjson r "$res" --argjson c "$cfg" --argjson nics "$ips" --argjson osi "$osinfo" --arg cluster "$CLUSTER" "$SIZE_JQ"'
    ($r.type == "lxc") as $lxc
    | {
      name: ($r.name // ("vm-" + ($r.vmid | tostring))),
      id: ($r.vmid | tostring),
      host: $r.node, cluster: $cluster,
      kind: (if $lxc then "lxc" else "vm" end),
      powerState: ($r.status // "unknown"),
      vcpu: (if $lxc then ($c.cores // $r.maxcpu // 1) else (($c.sockets // 1) * ($c.cores // 1)) end),
      ramGib: (((($c.memory // (($r.maxmem // 0) / 1048576)) | tonumber) / 1024 * 10 | round) / 10),
      firmware: (if ($c.bios // "seabios") == "ovmf" then "efi" else "bios" end),
      disks: [$c | to_entries[] | select(.key | test("^(scsi|virtio|sata|ide|efidisk|rootfs|mp)[0-9]*$"))
              | select((.value | tostring) | test("media=cdrom|none,") | not) | select(.key | startswith("efidisk") | not)
              | {name: .key, gib: ((.value | tostring | gib) | ceil)} | select(.gib > 0)],
      nics: (if ($nics | length) > 0 then $nics
             else [$c | to_entries[] | select(.key | test("^net[0-9]+$")) | {mac: ((.value | capture("(?<m>([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})") // {m: null}).m), ipv4: [], ipv6: []}] end),
      os: {raw: ($osi["pretty-name"] // $c.ostype // ""), version: ($osi["version-id"] // "")},
      tags: ((($r.tags // "") | split(";") | map(select(. != "")) | map({key: ., value: "tag"}) | from_entries))
    } + (if ($c.description // "") == "" then {} else {annotation: $c.description} end)'
done | jq -sc . | envelope proxmox "$CLUSTER" | emit
`,
  "collect-scvmm.ps1": `<#
.SYNOPSIS
  System Center Virtual Machine Manager inventory as an
  archtoolkit.discovery v1 file (platform hyperv, manager = the VMM server).

.DESCRIPTION
  Get-SCVirtualMachine -VMMServer <server> | Select Name, ID, CPUCount,
  Memory, VirtualHardDisks, VMHost, OperatingSystem, Status, Generation,
  VirtualNetworkAdapters, Description, Tag, CustomProperty
  (https://learn.microsoft.com/en-us/powershell/module/virtualmachinemanager/get-scvirtualmachine).
  Runs where the VMM console (the VirtualMachineManager module) is
  installed, as an account with read access in VMM. The file holds no user
  name and no path; collectedAt is a date.

.EXAMPLE
  .\\collect-scvmm.ps1 -VMMServer vmm01.corp.example -OutFile scvmm.json
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$VMMServer,
  [string]$OutFile
)
$ErrorActionPreference = 'Stop'
Import-Module VirtualMachineManager
$vmm = Get-SCVMMServer -ComputerName $VMMServer

$servers = foreach ($vm in @(Get-SCVirtualMachine -VMMServer $vmm)) {
  $disks = @($vm.VirtualHardDisks | ForEach-Object {
      [ordered]@{ gib = [int][math]::Ceiling($_.MaximumSize / 1GB); usedGib = [math]::Round($_.Size / 1GB, 1) }
    })
  $nics = @($vm.VirtualNetworkAdapters | ForEach-Object {
      [ordered]@{
        mac     = [string]$_.MACAddress
        network = [string]$_.VMNetwork
        ipv4    = @($_.IPv4Addresses)
        ipv6    = @($_.IPv6Addresses | Where-Object { $_ -notmatch '^fe80' })
      }
    })
  $tags = [ordered]@{}
  if ($vm.Tag) { $tags.tag = [string]$vm.Tag }
  try {
    foreach ($cp in @(Get-SCCustomPropertyValue -InputObject $vm)) { if ($cp.Value) { $tags[[string]$cp.CustomProperty.Name] = [string]$cp.Value } }
  } catch { }
  $server = [ordered]@{
    name       = $vm.Name
    id         = [string]$vm.ID
    host       = [string]$vm.VMHost.Name
    kind       = 'vm'
    powerState = [string]$vm.Status
    vcpu       = [int]$vm.CPUCount
    ramGib     = [math]::Round([double]$vm.Memory / 1024, 1)
    firmware   = if ($vm.Generation -eq 2) { 'efi' } else { 'bios' }
    disks      = $disks
    nics       = $nics
    os         = [ordered]@{ raw = [string]$vm.OperatingSystem.Name; version = [string]$vm.OperatingSystem.Version }
    tags       = $tags
  }
  if ($vm.VMHost -and $vm.VMHost.HostCluster) { $server.cluster = [string]$vm.VMHost.HostCluster.Name }
  if ($vm.Description) { $server.annotation = [string]$vm.Description }
  $server
}

$doc = [ordered]@{
  kind        = 'archtoolkit.discovery'
  v           = 1
  source      = [ordered]@{ platform = 'hyperv'; manager = $VMMServer }
  collectedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
  servers     = @($servers)
}
$json = $doc | ConvertTo-Json -Depth 8 -Compress
if ($OutFile) { [IO.File]::WriteAllText($OutFile, $json, (New-Object Text.UTF8Encoding $false)) } else { Write-Output $json }
`,
  "collect-windows.ps1": `<#
.SYNOPSIS
  The Windows guest collector (physical servers and any VM): one
  archtoolkit.discovery v1 file for this server.

.DESCRIPTION
  Hardware and OS (CIM: Win32_ComputerSystem, Win32_OperatingSystem,
  Win32_Processor, Win32_LogicalDisk), addresses (Get-NetIPAddress), installed
  software (the Uninstall registry keys) and roles, running services,
  listening ports (Get-NetTCPConnection -State Listen, Get-NetUDPEndpoint),
  outbound connections (-State Established) and utilisation percentiles.

  Modes:
    Inventory (default)  write the discovery file now. Utilisation comes from a
                         finished sampling run, else one point-in-time reading.
    Start -Days N        register a scheduled task (SYSTEM) that samples
                         Get-Counter every 60 seconds for N days (default 14).
    Sample               what the task runs: a day of samples; on the last day
                         it writes the percentiles and removes the task.
    Stop                 remove the task and the samples.

  Runs on Windows PowerShell 5.1 and PowerShell 7. The file holds no user name
  and no path; collectedAt is a date. The performance counter paths are the
  English names (verify on localised Windows).

.EXAMPLE
  .\\collect-windows.ps1 -OutFile app01.json
  .\\collect-windows.ps1 -Mode Start -Days 14
#>
[CmdletBinding()]
param(
  [ValidateSet('Inventory', 'Start', 'Sample', 'Stop')][string]$Mode = 'Inventory',
  [ValidateRange(0, 90)][int]$Days = 14,
  [string]$OutFile,
  [string]$Name
)
$ErrorActionPreference = 'Stop'

$State = Join-Path $env:ProgramData 'ArchToolKit'
$TaskName = 'ArchToolKit utilisation'
$Counters = @(
  '\\Processor(_Total)\\% Processor Time',
  '\\Memory\\Committed Bytes',
  '\\PhysicalDisk(_Total)\\Disk Transfers/sec',
  '\\PhysicalDisk(_Total)\\Disk Bytes/sec'
)

function Get-Pct([double[]]$Values, [double]$P) {
  if (-not $Values -or $Values.Count -eq 0) { return $null }
  $s = $Values | Sort-Object
  $r = [math]::Ceiling($P / 100 * $s.Count)
  if ($r -lt 1) { $r = 1 }
  return [math]::Round([double]$s[$r - 1], 1)
}

function Get-Platform {
  $cs = Get-CimInstance Win32_ComputerSystem
  $bios = Get-CimInstance Win32_BIOS
  $enc = Get-CimInstance Win32_SystemEnclosure -ErrorAction SilentlyContinue
  $asset = if ($enc) { [string]$enc.SMBIOSAssetTag } else { '' }
  $text = "$($cs.Manufacturer) $($cs.Model) $($bios.Manufacturer) $asset"
  if ($asset -eq '7783-7084-3265-9085-8269-3286-77') { return 'azure' }
  if ($text -match 'Amazon') { return 'aws' }
  if ($text -match 'Google') { return 'google' }
  if ($text -match 'OracleCloud') { return 'oci' }
  if ($text -match 'Nutanix') { return 'ahv' }
  if ($text -match 'VMware') { return 'vsphere' }
  if ($cs.Model -match 'Virtual Machine' -and $cs.Manufacturer -match 'Microsoft') { return 'hyperv' }
  if ($text -match 'QEMU|KVM|Red Hat|oVirt|Proxmox') { return 'kvm' }
  if ($text -match 'Xen') { return 'xen' }
  if ($cs.PSObject.Properties['HypervisorPresent'] -and $cs.HypervisorPresent -and $cs.Model -match 'Virtual') { return 'other' }
  return 'physical'
}

function Get-Listening {
  $out = @()
  try {
    $procs = @{}
    Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_.ProcessName }
    $out += Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object {
      [pscustomobject]@{ port = [int]$_.LocalPort; proto = 'tcp'; process = $procs[[int]$_.OwningProcess] }
    }
    $out += Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 53, 67, 69, 123, 137, 161, 162, 389, 514, 1812, 3389 } | ForEach-Object {
      [pscustomobject]@{ port = [int]$_.LocalPort; proto = 'udp'; process = $procs[[int]$_.OwningProcess] }
    }
  } catch {
    # Windows Server 2008 R2: no NetTCPIP module; read netstat.
    $out = netstat -ano -p tcp | Select-String 'LISTENING' | ForEach-Object {
      $f = ($_.Line -split '\\s+') | Where-Object { $_ }
      $port = ($f[1] -split ':')[-1]
      $name = try { (Get-Process -Id ([int]$f[4])).ProcessName } catch { $null }
      [pscustomobject]@{ port = [int]$port; proto = 'tcp'; process = $name }
    }
  }
  $seen = @{}
  $unique = @()
  foreach ($l in $out) {
    $k = "$($l.port)/$($l.proto)/$($l.process)"
    if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; $unique += $l }
  }
  return @($unique | Sort-Object port)
}

function Get-OutboundLines {
  # "remote port process" per outbound established connection (inbound ones end on a listening port).
  $listen = @((Get-Listening) | Where-Object { $_.proto -eq 'tcp' } | ForEach-Object { $_.port })
  $procs = @{}
  Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_.ProcessName }
  try {
    Get-NetTCPConnection -State Established -ErrorAction Stop |
      Where-Object { $listen -notcontains [int]$_.LocalPort -and $_.RemoteAddress -notmatch '^(127\\.|::1$)' } |
      ForEach-Object { '{0} {1} {2}' -f ($_.RemoteAddress -replace '^::ffff:', ''), $_.RemotePort, $procs[[int]$_.OwningProcess] }
  } catch { @() }
}

function Get-Connections([string[]]$Lines) {
  $groups = $Lines | Where-Object { $_ } | Group-Object | Sort-Object Count -Descending | Select-Object -First 500
  return , @($groups | ForEach-Object {
      $f = $_.Name -split ' '
      $c = [ordered]@{ remote = $f[0]; port = [int]$f[1]; proto = 'tcp'; count = [int]$_.Count }
      if ($f.Count -gt 2 -and $f[2]) { $c.process = $f[2] }
      [pscustomobject]$c
    })
}

function Get-UtilFromSamples([string]$Path) {
  $rows = @(Import-Csv -Path $Path -Header at, cpu, mem, iops, mbps)
  if ($rows.Count -eq 0) { return $null }
  $at = @($rows | ForEach-Object { [double]$_.at } | Sort-Object)
  $gaps = @(for ($i = 1; $i -lt $at.Count; $i++) { $d = $at[$i] - $at[$i - 1]; if ($d -gt 0) { $d } }) | Sort-Object
  $gap = if ($gaps.Count -gt 0) { $gaps[[int][math]::Floor(($gaps.Count - 1) / 2)] } else { 0 }
  $span = $at[-1] - $at[0]
  $expected = if ($gap -gt 0) { [math]::Floor($span / $gap) + 1 } else { $rows.Count }
  $cpu = @($rows | ForEach-Object { [double]$_.cpu })
  $mem = @($rows | ForEach-Object { [double]$_.mem })
  $iops = @($rows | ForEach-Object { [double]$_.iops })
  $mbps = @($rows | ForEach-Object { [double]$_.mbps })
  return [ordered]@{
    days = [math]::Round($span / 86400, 1); samples = $rows.Count; coverage = [math]::Round([math]::Min(1, $rows.Count / [math]::Max(1, $expected)), 2)
    cpuP50Pct = Get-Pct $cpu 50; cpuP95Pct = Get-Pct $cpu 95; cpuP99Pct = Get-Pct $cpu 99; cpuMaxPct = Get-Pct $cpu 100
    memP95Gib = Get-Pct $mem 95; memMaxGib = Get-Pct $mem 100; iopsP95 = Get-Pct $iops 95; iopsMax = Get-Pct $iops 100; mbpsP95 = Get-Pct $mbps 95
  }
}

function Get-PointUtil {
  try {
    $s = (Get-Counter -Counter $Counters -SampleInterval 1 -MaxSamples 3).CounterSamples
    $cpu = ($s | Where-Object { $_.Path -like '*processor time' } | Measure-Object CookedValue -Average).Average
    $mem = ($s | Where-Object { $_.Path -like '*committed bytes' } | Measure-Object CookedValue -Average).Average
    return [ordered]@{ days = 0; samples = 1; coverage = 0; cpuP95Pct = [math]::Round($cpu, 1); memP95Gib = [math]::Round($mem / 1GB, 2) }
  } catch { return $null }
}

function Get-Inventory {
  $cs = Get-CimInstance Win32_ComputerSystem
  $os = Get-CimInstance Win32_OperatingSystem
  $platform = Get-Platform
  $serverName = if ($Name) { $Name } else { $env:COMPUTERNAME }

  $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Sort-Object { if ($_.DeviceID -eq $env:SystemDrive) { 0 } else { 1 } }, DeviceID | ForEach-Object {
      [ordered]@{ name = $_.DeviceID; gib = [int][math]::Ceiling($_.Size / 1GB); usedGib = [math]::Round(($_.Size - $_.FreeSpace) / 1GB, 1) }
    })
  $nics = @()
  try {
    $adapters = @{}
    Get-NetAdapter -ErrorAction Stop | ForEach-Object { $adapters[[int]$_.ifIndex] = $_.MacAddress }
    $nics = @(Get-NetIPAddress -ErrorAction Stop | Where-Object { $_.IPAddress -notmatch '^(127\\.|::1$|fe80:|169\\.254\\.)' } | Group-Object InterfaceIndex | ForEach-Object {
        [ordered]@{
          mac  = [string]$adapters[[int]$_.Name]
          ipv4 = @($_.Group | Where-Object { $_.AddressFamily -eq 'IPv4' } | ForEach-Object { $_.IPAddress })
          ipv6 = @($_.Group | Where-Object { $_.AddressFamily -eq 'IPv6' } | ForEach-Object { $_.IPAddress })
        }
      })
  } catch {
    $nics = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' | ForEach-Object {
        [ordered]@{ mac = $_.MACAddress; ipv4 = @($_.IPAddress | Where-Object { $_ -notmatch ':' }); ipv6 = @($_.IPAddress | Where-Object { $_ -match ':' -and $_ -notmatch '^fe80' }) }
      })
  }
  $keys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
  $software = @(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
      Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -and -not ($_.PSObject.Properties['SystemComponent'] -and $_.SystemComponent -eq 1) } |
      ForEach-Object { $_.DisplayName.Trim() } | Sort-Object -Unique | Select-Object -First 5000)
  try {
    $software += @(Get-WindowsFeature -ErrorAction Stop | Where-Object { $_.Installed -and $_.FeatureType -in 'Role', 'Role Service' } | ForEach-Object { $_.DisplayName })
  } catch { }
  $services = @(Get-Service | Where-Object { $_.Status -eq 'Running' } | ForEach-Object { $_.Name } | Sort-Object -Unique)
  $shares = @(try { Get-SmbShare -ErrorAction Stop | Where-Object { -not $_.Special } } catch { @() }).Count
  $printers = @(try { Get-Printer -ErrorAction Stop | Where-Object { $_.Shared } } catch { @() }).Count
  $sessions = @(Get-CimInstance Win32_LogonSession -Filter 'LogonType=10' -ErrorAction SilentlyContinue).Count

  $connFile = Join-Path $State 'conn.txt'
  $lines = if (Test-Path $connFile) { Get-Content $connFile } else { Get-OutboundLines }
  $utilFile = Join-Path $State 'util.json'
  $util = if (Test-Path $utilFile) { Get-Content $utilFile -Raw | ConvertFrom-Json } else { Get-PointUtil }

  $server = [ordered]@{
    name        = $serverName
    kind        = if ($platform -eq 'physical') { 'physical' } else { 'vm' }
    powerState  = 'poweredOn'
    vcpu        = [int]$cs.NumberOfLogicalProcessors
    ramGib      = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    firmware    = if ($env:firmware_type -eq 'UEFI') { 'efi' } else { 'bios' }
    disks       = $disks
    nics        = $nics
    os          = [ordered]@{ raw = [string]$os.Caption; version = [string]$os.Version }
    software    = @($software | Where-Object { $_ } | Sort-Object -Unique)
    services    = $services
    listening   = @(@(Get-Listening) | ForEach-Object { $o = [ordered]@{ port = $_.port; proto = $_.proto }; if ($_.process) { $o.process = $_.process }; $o })
    connections = Get-Connections $lines
    shares      = $shares
    printers    = $printers
    sessions    = $sessions
  }
  if ($util) { $server.utilisation = $util }
  return [ordered]@{
    kind        = 'archtoolkit.discovery'
    v           = 1
    source      = [ordered]@{ platform = $platform }
    collectedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
    servers     = @($server)
  }
}

function Write-Out([string]$Json) {
  if ($OutFile) { [IO.File]::WriteAllText($OutFile, $Json, (New-Object Text.UTF8Encoding $false)) } else { Write-Output $Json }
}

switch ($Mode) {
  'Inventory' {
    Write-Out (Get-Inventory | ConvertTo-Json -Depth 8 -Compress)
  }
  'Start' {
    New-Item -ItemType Directory -Force -Path $State | Out-Null
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $State 'samples.csv'), (Join-Path $State 'conn.txt'), (Join-Path $State 'util.json')
    $self = Join-Path $State 'collect-windows.ps1'
    if (-not $PSCommandPath) { throw 'Start needs the script as a file (run it with -File, or copy it first).' }
    if ($PSCommandPath -ne $self) { Copy-Item -Force -Path $PSCommandPath -Destination $self }
    [ordered]@{ start = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); days = $Days } | ConvertTo-Json | Set-Content -Path (Join-Path $State 'start.json')
    $exe = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
    $action = New-ScheduledTaskAction -Execute $exe -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode Sample' -f (Join-Path $State 'collect-windows.ps1'))
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Days 1) -RepetitionDuration (New-TimeSpan -Days ($Days + 1))
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 25) -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Output "sampling every 60 seconds for $Days day(s)"
  }
  'Sample' {
    $startFile = Join-Path $State 'start.json'
    if (-not (Test-Path $startFile)) { return }
    $start = Get-Content $startFile -Raw | ConvertFrom-Json
    $samples = Join-Path $State 'samples.csv'
    $end = [double]$start.start + [double]$start.days * 86400
    $now = [double][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $runStart = $now
    # Up to a day of 60-second samples, written every 10 minutes (with a snapshot of the
    # established connections) so a reboot loses little; the task restarts daily.
    while ($now -lt $end -and ($now - $runStart) -lt 86100) {
      $batch = Get-Counter -Counter $Counters -SampleInterval 60 -MaxSamples 10 -ErrorAction SilentlyContinue
      $lines = foreach ($set in $batch) {
        $v = @{}
        foreach ($c in $set.CounterSamples) { $v[($c.Path -split '\\\\')[-1]] = $c.CookedValue }
        $t = ([DateTimeOffset]$set.Timestamp).ToUnixTimeSeconds()
        '{0},{1:0.0},{2:0.00},{3:0.0},{4:0.00}' -f $t, $v['% processor time'], ($v['committed bytes'] / 1GB), $v['disk transfers/sec'], ($v['disk bytes/sec'] / 1MB)
      }
      Add-Content -Path $samples -Value $lines
      $conns = @(Get-OutboundLines)
      if ($conns.Count -gt 0) { Add-Content -Path (Join-Path $State 'conn.txt') -Value $conns }
      $now = [double][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    }
    if ($now -ge $end -and (Test-Path $samples)) {
      Get-UtilFromSamples $samples | ConvertTo-Json -Compress | Set-Content -Path (Join-Path $State 'util.json')
      Remove-Item -Force $startFile
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
  }
  'Stop' {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $State
  }
}
`,
  "collect-xen.sh": `#!/usr/bin/env bash
# collect-xen.sh: Citrix Hypervisor / XenServer / XCP-ng inventory as an
# archtoolkit.discovery v1 file.
#
# Run on the pool master, or anywhere with the xe CLI and XE_HOST set:
#   xe vm-list is-control-domain=false is-a-template=false is-a-snapshot=false
#   xe vm-param-get (name-label, power-state, VCPUs-max, memory-static-max,
#     os-version, name-description, resident-on, HVM-boot-params, networks)
#   xe vbd-list / vdi-param-get (virtual-size, physical-utilisation), xe vif-list
# (https://docs.xenserver.com/en-us/xenserver/8/command-line-interface.html)
#
# Usage: collect-xen.sh [--out FILE]
# Remote pools: XE_HOST, XE_USER and XE_PASSWORD_FILE (a mode-600 file; xe
# reads it with -pwf, so the password is never on the command line).
# Needs: bash 4+, jq, xe. The output has no user name and no path.

# @@common@@

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="\${2:?--out needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
need xe jq
XE=(xe)
if [ -n "\${XE_HOST:-}" ]; then
  [ -n "\${XE_PASSWORD_FILE:-}" ] || die "set XE_PASSWORD_FILE for a remote pool" 3
  XE=(xe -s "$XE_HOST" -u "\${XE_USER:-root}" -pwf "$XE_PASSWORD_FILE")
fi
x() { "\${XE[@]}" "$@" </dev/null; }
p() { x vm-param-get uuid="$1" param-name="$2" \${3:+param-key="$3"} 2>/dev/null || true; }

POOL="$(x pool-list params=name-label --minimal 2>/dev/null || true)"
[ -n "$POOL" ] || POOL="$(uname -n)"

for uuid in $(x vm-list is-control-domain=false is-a-template=false is-a-snapshot=false --minimal | tr ',' ' '); do
  name="$(p "$uuid" name-label)"
  state="$(p "$uuid" power-state)"
  vcpu="$(p "$uuid" VCPUs-max)"
  mem="$(p "$uuid" memory-static-max)"
  os="$(p "$uuid" os-version name)"
  desc="$(p "$uuid" name-description)"
  fw="$(p "$uuid" HVM-boot-params firmware)"
  resident="$(p "$uuid" resident-on)"
  host=""
  case "$resident" in ''|'<not in database>') ;; *) host="$(x host-param-get uuid="$resident" param-name=name-label 2>/dev/null || true)" ;; esac
  disks='[]'
  for vdi in $(x vbd-list vm-uuid="$uuid" type=Disk params=vdi-uuid --minimal | tr ',' ' '); do
    [ "$vdi" = '<not in database>' ] && continue
    size="$(x vdi-param-get uuid="$vdi" param-name=virtual-size 2>/dev/null || echo 0)"
    used="$(x vdi-param-get uuid="$vdi" param-name=physical-utilisation 2>/dev/null || echo 0)"
    disks="$(jq -c --argjson s "\${size:-0}" --argjson u "\${used:-0}" '. + [{gib: (($s / 1073741824) | ceil), usedGib: ((($u / 1073741824) * 10 | round) / 10)}]' <<<"$disks")"
  done
  macs="$(x vif-list vm-uuid="$uuid" params=MAC --minimal | tr ',' '\\n' | jq -R . | jq -sc 'map(select(. != ""))')"
  # networks: "0/ip: 10.0.0.5; 0/ipv4/0: 10.0.0.5; 0/ipv6/0: 2001:db8::5"
  nets="$(p "$uuid" networks)"
  v4="$(printf '%s' "$nets" | tr ';' '\\n' | awk -F': ' '$1 ~ /ipv4|\\/ip$/ { gsub(/ /, "", $2); print $2 }' | sort -u | jq -R . | jq -sc 'map(select(. != ""))')"
  v6="$(printf '%s' "$nets" | tr ';' '\\n' | awk -F': ' '$1 ~ /ipv6/ { gsub(/ /, "", $2); if ($2 !~ /^fe80/) print $2 }' | sort -u | jq -R . | jq -sc 'map(select(. != ""))')"
  jq -nc --arg name "$name" --arg id "$uuid" --arg host "$host" --arg cluster "$POOL" --arg state "$state" \\
    --argjson vcpu "\${vcpu:-0}" --argjson mem "\${mem:-0}" --arg fw "$fw" --argjson disks "$disks" \\
    --argjson macs "$macs" --argjson v4 "$v4" --argjson v6 "$v6" --arg os "$os" --arg desc "$desc" '
    {name: $name, id: $id, cluster: $cluster, kind: "vm", powerState: $state, vcpu: $vcpu,
     ramGib: ((($mem / 1073741824) * 10 | round) / 10),
     firmware: (if $fw == "uefi" then "efi" else "bios" end),
     disks: $disks,
     nics: (if ($macs | length) == 0 then [{ipv4: $v4, ipv6: $v6}] else [$macs | to_entries[] | {mac: .value} + (if .key == 0 then {ipv4: $v4, ipv6: $v6} else {} end)] end),
     os: {raw: $os}}
    + (if $host == "" then {} else {host: $host} end)
    + (if $desc == "" then {} else {annotation: $desc} end)'
done | jq -sc . | envelope xen "$POOL" | emit
`,
  "discover.yml": `---
# discover.yml: runs the guest collectors on every host of the inventory and
# brings one archtoolkit.discovery file per host back to reports/discovery/
# on the controller, for the Sources screen.
#
#   ansible-playbook -i inventory discover.yml                                # inventory now
#   ansible-playbook -i inventory discover.yml -e atk_mode=start -e atk_days=14  # start sampling
#   ansible-playbook -i inventory discover.yml                                # after the window: with percentiles
#   ansible-playbook -i inventory discover.yml -e atk_mode=stop               # remove the schedules
#
# Linux hosts run collect-linux.sh (become: true); Windows hosts run
# collect-windows.ps1 over WinRM or PSRP. Credentials come from the inventory
# (vault variables), never from this file.
- name: Discover servers with the guest collectors
  hosts: "{{ atk_hosts | default('all') }}"
  gather_facts: true
  gather_subset:
    - min
  vars:
    atk_mode: inventory
    atk_days: 14
    atk_out: "{{ playbook_dir }}/reports/discovery"
    atk_windows_dir: 'C:\\ProgramData\\ArchToolKit'
  tasks:
    - name: Check the mode  # noqa: run-once[task]
      ansible.builtin.assert:
        that:
          - atk_mode in ['inventory', 'start', 'stop']
          - atk_days | int >= 0
        fail_msg: "atk_mode must be inventory, start or stop"
      run_once: true

    - name: Create the report folder on the controller  # noqa: run-once[task]
      ansible.builtin.file:
        path: "{{ atk_out }}"
        state: directory
        mode: "0700"
      delegate_to: localhost
      run_once: true
      become: false

    - name: Run the Linux collector
      ansible.builtin.script:
        cmd: "collect-linux.sh {{ atk_mode }} --days {{ atk_days | int }}"
      become: true
      register: atk_linux
      changed_when: atk_mode in ['start', 'stop']
      when: ansible_facts['os_family'] != 'Windows'

    - name: Copy the Windows collector
      ansible.windows.win_copy:
        src: collect-windows.ps1
        dest: "{{ atk_windows_dir }}\\\\collect-windows.ps1"
      when: ansible_facts['os_family'] == 'Windows'

    - name: Run the Windows collector
      ansible.windows.win_powershell:
        script: |
          param([string]$Mode, [int]$Days, [string]$Dir)
          & (Join-Path $Dir 'collect-windows.ps1') -Mode $Mode -Days $Days
        parameters:
          Mode: "{{ atk_mode | capitalize }}"
          Days: "{{ atk_days | int }}"
          Dir: "{{ atk_windows_dir }}"
      register: atk_windows
      changed_when: atk_mode in ['start', 'stop']
      when: ansible_facts['os_family'] == 'Windows'

    - name: Save the Linux discovery file
      ansible.builtin.copy:
        content: "{{ atk_linux.stdout }}"
        dest: "{{ atk_out }}/{{ inventory_hostname }}.json"
        mode: "0600"
      delegate_to: localhost
      become: false
      when:
        - atk_mode == 'inventory'
        - ansible_facts['os_family'] != 'Windows'

    - name: Save the Windows discovery file
      ansible.builtin.copy:
        content: "{{ atk_windows.output | join('') }}"
        dest: "{{ atk_out }}/{{ inventory_hostname }}.json"
        mode: "0600"
      delegate_to: localhost
      become: false
      when:
        - atk_mode == 'inventory'
        - ansible_facts['os_family'] == 'Windows'
`,
});
