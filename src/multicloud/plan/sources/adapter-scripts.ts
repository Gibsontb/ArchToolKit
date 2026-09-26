/**
 * The source adapters' text (addendum A.3.3), embedded verbatim and rendered
 * by `adapters.ts` into `migration/execute/source/`. Each adapter splices in
 * the shared part (`ADAPTER_COMMON_SH` / `ADAPTER_COMMON_PS1`) at its
 * `# @@adapter-common@@` line: argument parsing, the manifest lookup, the
 * status events, dry-run and the exit codes of the execution-kit contract
 * (A.6.2). Checked with `bash -n` or the PowerShell parser in sources.test.ts.
 */

export const ADAPTER_COMMON_SH = `set -euo pipefail

HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$HERE/.." && pwd)"
# The execution kit's shared library (WP-11) supplies atk_event and atk_secret;
# the fallbacks below keep this adapter usable on its own.
# shellcheck disable=SC1091
[ -f "$KIT/lib/atk.sh" ] && . "$KIT/lib/atk.sh"

VERB="\${1:-}"
[ $# -gt 0 ] && shift
ITEMS=()
DRY_RUN=0
TIMEOUT=10
NEW_NAME=""
STEP=""
EVENT_PATH="orchestrator"
WAVE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --item) ITEMS+=("\${2:?--item needs an id or name}"); shift 2 ;;
    --wave) WAVE="\${2:?--wave needs a number}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --timeout) TIMEOUT="\${2:?--timeout needs minutes}"; shift 2 ;;
    --new-name) NEW_NAME="\${2:?--new-name needs a name}"; shift 2 ;;
    --step) STEP="\${2:?--step needs a step id}"; shift 2 ;;
    --path) EVENT_PATH="\${2:?--path needs a move path}"; shift 2 ;;
    -h|--help) VERB=help; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
export ATK_DRY_RUN="\${ATK_DRY_RUN:-$DRY_RUN}"
[ "$DRY_RUN" = 1 ] && ATK_DRY_RUN=1

usage() {
  cat >&2 <<EOF
usage: $(basename "$0") state|stop|start|snapshot|delete|rename|tools-remove --item <id|name> [--item ...]
       [--wave N] [--dry-run] [--timeout MINUTES] [--new-name NAME] [--step STEP] [--path PATH]
Applies by default; --dry-run prints each change instead of making it.
Exit codes: 0 ok, 2 usage, 3 missing tool or credential, 10 some items failed, 1 other.
EOF
}
case "$VERB" in state|stop|start|snapshot|delete|rename|tools-remove) ;; help) usage; exit 0 ;; *) usage; exit 2 ;; esac

command -v jq >/dev/null 2>&1 || { echo "missing tool: jq" >&2; exit 3; }
MANIFEST="$KIT/manifest/items.json"
[ -f "$MANIFEST" ] || { echo "missing $MANIFEST" >&2; exit 3; }
PLAN8="$(jq -r '(.planId // "plan") | tostring | .[0:8]' "$MANIFEST" 2>/dev/null || echo plan)"
if [ \${#ITEMS[@]} -eq 0 ] && [ -n "$WAVE" ]; then
  mapfile -t ITEMS < <(jq -r --arg p "$ADAPTER_PLATFORM" --argjson w "$WAVE" '(.items? // .)[] | select(.wave == $w and (.source.platform // "vsphere") == $p) | .id' "$MANIFEST")
fi
[ \${#ITEMS[@]} -gt 0 ] || { echo "no items: pass --item or --wave" >&2; exit 2; }

if ! type atk_event >/dev/null 2>&1; then
  # item step outcome [state] [detail]: one status event line (no user, host or path).
  atk_event() {
    local dir="$KIT/../status"
    mkdir -p "$dir"
    jq -nc --arg item "$1" --arg step "$2" --arg outcome "$3" --arg state "\${4:-}" --arg detail "\${5:-}" \\
      --arg path "$EVENT_PATH" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson dry "$([ "$ATK_DRY_RUN" = 1 ] && echo true || echo false)" \\
      --arg plan "\${ATK_PLAN_ID:-}" --arg run "\${ATK_RUN_ID:-source}" --arg wave "\${WAVE:-}" \\
      '{kind: "archtoolkit.migration-status", v: 1, planId: $plan, runId: $run, at: $at,
        wave: (if $wave == "" then null else ($wave | tonumber) end), item: $item, path: $path, step: $step,
        outcome: $outcome, dryRun: $dry, source: "script"}
       + (if $state == "" then {} else {state: $state} end) + (if $detail == "" then {} else {detail: $detail} end)' \\
      >> "$dir/events.jsonl"
  }
fi
if ! type atk_secret >/dev/null 2>&1; then
  # NAME: $NAME, else the mode-600 file in $NAME_FILE, else \`$ATK_VAULT_CMD NAME\`.
  atk_secret() {
    local n="$1" f v
    v="\${!n:-}"; if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
    f="\${n}_FILE"; f="\${!f:-}"
    if [ -n "$f" ]; then
      case "$(stat -c %a "$f" 2>/dev/null || echo 600)" in 600|400) ;; *) echo "\\$\${n}_FILE must be mode 600" >&2; exit 3 ;; esac
      tr -d '\\r\\n' < "$f"; return 0
    fi
    if [ -n "\${ATK_VAULT_CMD:-}" ]; then $ATK_VAULT_CMD "$n"; return 0; fi
    echo "missing credential: $n" >&2; exit 3
  }
fi

# Runs a changing command, or prints it under --dry-run.
mut() {
  if [ "$ATK_DRY_RUN" = 1 ]; then printf 'dry-run:' >&2; printf ' %q' "$@" >&2; printf '\\n' >&2; return 0; fi
  "$@"
}
need() { local t; for t in "$@"; do command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t" >&2; exit 3; }; done; }
# Polls "$@" (a state reader) until it prints $1-wanted, for up to TIMEOUT minutes.
wait_state() {
  local want="$1"; shift
  [ "$ATK_DRY_RUN" = 1 ] && return 0
  local end=$(( $(date +%s) + TIMEOUT * 60 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    [ "$("$@" 2>/dev/null || true)" = "$want" ] && return 0
    sleep 10
  done
  return 1
}
slug() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40; }
default_step() {
  case "$VERB" in stop) echo stop-source ;; start) echo rollback ;; snapshot) echo freeze ;; delete|rename) echo decommission ;; tools-remove) echo post-config ;; *) echo manual ;; esac
}
STEP="\${STEP:-$(default_step)}"

# Runs the verb for every item; per-item failures are events, and the exit code is 10.
main() {
  local failed=0 it rec
  for it in "\${ITEMS[@]}"; do
    rec="$(jq -c --arg i "$it" '[(.items? // .)[] | select(.id == $i or .name == $i)][0] // empty' "$MANIFEST")"
    if [ -z "$rec" ]; then echo "$it: not in the manifest" >&2; failed=1; continue; fi
    ITEM_ID="$(jq -r '.id' <<<"$rec")"
    NAME="$(jq -r '.name' <<<"$rec")"
    SRC_ID="$(jq -r '.source.id // empty' <<<"$rec")"
    SRC_HOST="$(jq -r '.source.host // empty' <<<"$rec")"
    SRC_MANAGER="$(jq -r '.source.manager // empty' <<<"$rec")"
    SRC_CLUSTER="$(jq -r '.source.cluster // empty' <<<"$rec")"
    SRC_REGION="$(jq -r '.source.region // empty' <<<"$rec")"
    SRC_BMC="$(jq -r '.source.bmc // empty' <<<"$rec")"
    ITEM_WAVE="$(jq -r '.wave // empty' <<<"$rec")"
    SNAP_NAME="atk-\${PLAN8}-\${ITEM_WAVE:-0}-$(slug "$NAME")"
    export ITEM_ID NAME SRC_ID SRC_HOST SRC_MANAGER SRC_CLUSTER SRC_REGION SRC_BMC ITEM_WAVE SNAP_NAME
    if [ "$VERB" = state ]; then
      printf '%s\\t%s\\n' "$NAME" "$(v_state || echo unknown)"
      continue
    fi
    atk_event "$ITEM_ID" "$STEP" started
    local out rc=0
    out="$("v_\${VERB//-/_}" 2>&1)" || rc=$?
    [ -n "$out" ] && printf '%s: %s\\n' "$NAME" "$out" >&2
    case "$rc" in
      0) atk_event "$ITEM_ID" "$STEP" succeeded "" "$VERB" ;;
      20) atk_event "$ITEM_ID" "$STEP" skipped "" "\${out:-already done}" ;;
      *) atk_event "$ITEM_ID" "$STEP" failed "" "$(printf '%s' "$out" | awk '{ a[NR % 3] = $0 } END { for (i = NR - 2; i <= NR; i++) if (i > 0) printf "%s ", a[i % 3] }' | cut -c1-300)"; failed=1 ;;
    esac
  done
  [ "$failed" = 0 ] || exit 10
}
# Verbs return 0 (done), 20 (skipped: already there, or an operator step) or anything else (failed).
SKIP=20

# The source platform's guest tools come out in the guest, after cutover, through
# the kit's Ansible play (addendum A.3.5); the platforms that need nothing say so.
v_tools_remove() {
  local play="$KIT/ansible/source-tools.yml"
  if [ ! -f "$play" ]; then echo "operator step: remove the $ADAPTER_PLATFORM guest tools (the kit has no ansible/source-tools.yml)"; return $SKIP; fi
  need ansible-playbook
  mut ansible-playbook -i "\${ATK_ANSIBLE_INVENTORY:-$KIT/ansible/inventory}" "$play" --limit "$NAME" -e "atk_source=$ADAPTER_PLATFORM"
}
`;

export const ADAPTER_COMMON_PS1 = `$ErrorActionPreference = 'Stop'
$Kit = Split-Path -Parent $PSScriptRoot
$lib = Join-Path $Kit 'lib/Atk.psm1'
if (Test-Path $lib) { Import-Module $lib -Force }
if ($DryRun) { $env:ATK_DRY_RUN = '1' }
$IsDry = $env:ATK_DRY_RUN -eq '1'

if (-not (Get-Command Write-AtkEvent -ErrorAction SilentlyContinue)) {
  # One status event line (no user, host or path), when lib/Atk.psm1 (WP-11) is not beside the kit.
  function Write-AtkEvent([string]$Item, [string]$StepId, [string]$Outcome, [string]$State = '', [string]$Detail = '') {
    $dir = Join-Path (Split-Path -Parent $Kit) 'status'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $e = [ordered]@{
      kind = 'archtoolkit.migration-status'; v = 1; planId = [string]$env:ATK_PLAN_ID; runId = $(if ($env:ATK_RUN_ID) { $env:ATK_RUN_ID } else { 'source' })
      at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); wave = $(if ($Wave -ge 0) { $Wave } else { $null })
      item = $Item; path = $Path; step = $StepId; outcome = $Outcome; dryRun = $IsDry; source = 'script'
    }
    if ($State) { $e.state = $State }
    if ($Detail) { $e.detail = $Detail }
    Add-Content -Path (Join-Path $dir 'events.jsonl') -Value ($e | ConvertTo-Json -Compress) -Encoding utf8
  }
}
if (-not (Get-Command Get-AtkSecret -ErrorAction SilentlyContinue)) {
  # NAME: $env:NAME, else the file in $env:NAME_FILE, else \`$env:ATK_VAULT_CMD NAME\`.
  function Get-AtkSecret([string]$Name) {
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ($v) { return $v }
    $f = [Environment]::GetEnvironmentVariable("\${Name}_FILE")
    if ($f) { return (Get-Content -Raw -Path $f).Trim() }
    if ($env:ATK_VAULT_CMD) { return (& $env:ATK_VAULT_CMD $Name | Out-String).Trim() }
    Write-Error "missing credential: $Name"; exit 3
  }
}
function Get-AtkCredential([string]$UserVar, [string]$PasswordVar) {
  $pw = ConvertTo-SecureString (Get-AtkSecret $PasswordVar) -AsPlainText -Force
  return New-Object System.Management.Automation.PSCredential((Get-AtkSecret $UserVar), $pw)
}
# Runs a changing script block, or prints its text under -DryRun.
function Invoke-Mut([scriptblock]$Block) {
  if ($IsDry) { Write-Host "dry-run: $($Block.ToString().Trim())"; return }
  & $Block
}
function Wait-State([string]$Want, [scriptblock]$Reader) {
  if ($IsDry) { return $true }
  $end = (Get-Date).AddMinutes($TimeoutMinutes)
  while ((Get-Date) -lt $end) { if ((& $Reader) -eq $Want) { return $true }; Start-Sleep -Seconds 10 }
  return $false
}
function Get-Slug([string]$s) { (($s.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')) | ForEach-Object { if ($_.Length -gt 40) { $_.Substring(0, 40) } else { $_ } } }
$Skip = 'skipped'

$manifest = Join-Path $Kit 'manifest/items.json'
if (-not (Test-Path $manifest)) { Write-Error "missing $manifest"; exit 3 }
$doc = Get-Content -Raw $manifest | ConvertFrom-Json
$all = if ($doc.PSObject.Properties['items']) { @($doc.items) } else { @($doc) }
$plan8 = if ($doc.PSObject.Properties['planId'] -and $doc.planId) { ([string]$doc.planId).Substring(0, [math]::Min(8, ([string]$doc.planId).Length)) } else { 'plan' }
if (-not $Item -and $Wave -ge 0) { $Item = @($all | Where-Object { $_.wave -eq $Wave -and $_.source.platform -eq $AdapterPlatform } | ForEach-Object { $_.id }) }
if (-not $Item) { Write-Error 'no items: pass -Item or -Wave'; exit 2 }
if (-not $Step) {
  $Step = switch ($Verb) { 'stop' { 'stop-source' } 'start' { 'rollback' } 'snapshot' { 'freeze' } 'delete' { 'decommission' } 'rename' { 'decommission' } 'tools-remove' { 'post-config' } default { 'manual' } }
}

# The source platform's guest tools come out in the guest after cutover, through the kit's Ansible play (A.3.5).
function Invoke-ToolsRemove($it) {
  $play = Join-Path $Kit 'ansible/source-tools.yml'
  if (-not (Test-Path $play)) { return "operator step: remove the $AdapterPlatform guest tools (the kit has no ansible/source-tools.yml)", $Skip }
  $inv = if ($env:ATK_ANSIBLE_INVENTORY) { $env:ATK_ANSIBLE_INVENTORY } else { Join-Path $Kit 'ansible/inventory' }
  Invoke-Mut { ansible-playbook -i $inv $play --limit $it.name -e "atk_source=$AdapterPlatform" }
}

function Invoke-Main([hashtable]$Verbs) {
  $failed = $false
  foreach ($key in $Item) {
    $it = $all | Where-Object { $_.id -eq $key -or $_.name -eq $key } | Select-Object -First 1
    if (-not $it) { Write-Warning "\${key}: not in the manifest"; $failed = $true; continue }
    $script:SnapName = 'atk-{0}-{1}-{2}' -f $plan8, $(if ($null -ne $it.wave) { $it.wave } else { 0 }), (Get-Slug $it.name)
    if ($Verb -eq 'state') { "{0}\`t{1}" -f $it.name, (& $Verbs['state'] $it); continue }
    Write-AtkEvent $it.id $Step 'started'
    try {
      $result = @(& $Verbs[$Verb] $it)
      if ($result.Count -gt 0 -and $result[-1] -eq $Skip) {
        $why = ($result | Select-Object -SkipLast 1) -join ' '
        Write-AtkEvent $it.id $Step 'skipped' '' $why
      } else {
        Write-AtkEvent $it.id $Step 'succeeded' '' $Verb
      }
    } catch {
      Write-AtkEvent $it.id $Step 'failed' '' ([string]$_.Exception.Message)
      Write-Warning "$($it.name): $($_.Exception.Message)"
      $failed = $true
    }
  }
  if ($failed) { exit 10 }
}
`;

export const ADAPTER_SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  "ahv.sh": `#!/usr/bin/env bash
# source/ahv.sh: power and inventory operations on a Nutanix AHV source VM
# through the Prism Central v4 VMM API (A.3.3). The action paths are marked
# (verify): .../vms/{extId}/$actions/guest-shutdown, .../power-off,
# .../power-on, DELETE .../vms/{extId}; v4 changes carry the VM's ETag in
# If-Match and a fresh NTNX-Request-Id. The snapshot is a recovery point
# (POST /api/dataprotection/v4.0/config/recovery-points, verify).
# PRISM_CENTRAL (default: the item's source.manager), PRISM_USER,
# PRISM_PASSWORD (or PRISM_PASSWORD_FILE / ATK_VAULT_CMD); PRISM_CA_FILE.
ADAPTER_PLATFORM=ahv
# @@adapter-common@@

need curl
VMS=/api/vmm/v4.1/ahv/config/vms
HDRS="$(mktemp)"
trap 'rm -f "$HDRS"' EXIT
cfg_escape() { printf '%s' "$1" | sed 's/[\\\\"]/\\\\&/g'; }
reqid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen; }
api() { # method path [json-body] [etag]; response headers go to $HDRS
  local pc="\${PRISM_CENTRAL:-$SRC_MANAGER}" extra=() tls=()
  [ -n "\${3:-}" ] && extra+=(-H 'Content-Type: application/json' --data "$3")
  [ -n "\${4:-}" ] && extra+=(-H "If-Match: $4")
  [ "$1" = GET ] || extra+=(-H "NTNX-Request-Id: $(reqid)")
  [ -n "\${PRISM_CA_FILE:-}" ] && tls=(--cacert "$PRISM_CA_FILE")
  printf 'user = "%s:%s"\\n' "$(cfg_escape "$(atk_secret PRISM_USER)")" "$(cfg_escape "$(atk_secret PRISM_PASSWORD)")" \\
    | curl -sS --fail -K - \${tls[@]+"\${tls[@]}"} -D "$HDRS" -X "$1" -H 'Accept: application/json' \\
      \${extra[@]+"\${extra[@]}"} "https://$pc:9440$2"
}
etag() { api GET "$VMS/$SRC_ID" >/dev/null; awk 'tolower($1) == "etag:" { sub(/\\r$/, "", $2); print $2 }' "$HDRS"; }
action() { # name
  if [ "$ATK_DRY_RUN" = 1 ]; then echo "dry-run: POST $VMS/$SRC_ID/\\$actions/$1" >&2; return 0; fi
  api POST "$VMS/$SRC_ID/\\$actions/$1" '{}' "$(etag)" >/dev/null
}

v_state() { api GET "$VMS/$SRC_ID" | jq -r '.data.powerState // "UNKNOWN"'; }
v_stop() {
  [ "$(v_state)" = OFF ] && { echo "already off"; return $SKIP; }
  action guest-shutdown || true
  wait_state OFF v_state && return 0
  echo "no guest shutdown in $TIMEOUT minutes; powering off"
  action power-off
}
v_start() {
  [ "$(v_state)" = ON ] && { echo "already on"; return $SKIP; }
  action power-on
}
v_snapshot() {
  local body
  body="$(jq -nc --arg n "$SNAP_NAME" --arg vm "$SRC_ID" '{name: $n, recoveryPointType: "CRASH_CONSISTENT", vmRecoveryPoints: [{vmExtId: $vm}]}')"
  if [ "$ATK_DRY_RUN" = 1 ]; then echo "dry-run: POST /api/dataprotection/v4.0/config/recovery-points $body" >&2; return 0; fi
  if api GET "/api/dataprotection/v4.0/config/recovery-points?\\$filter=name%20eq%20'$SNAP_NAME'" | jq -e '(.data // []) | length > 0' >/dev/null; then echo "recovery point $SNAP_NAME exists"; return $SKIP; fi
  api POST /api/dataprotection/v4.0/config/recovery-points "$body" >/dev/null
}
v_delete() {
  api GET "$VMS/$SRC_ID" >/dev/null 2>&1 || { echo "already gone"; return $SKIP; }
  if [ "$ATK_DRY_RUN" = 1 ]; then echo "dry-run: DELETE $VMS/$SRC_ID" >&2; return 0; fi
  api DELETE "$VMS/$SRC_ID" '' "$(etag)" >/dev/null
}
v_rename() {
  echo "operator step: rename $NAME in Prism Central (a v4 VM update replaces the whole spec; not automated)"
  return $SKIP
}

main
`,
  "aws.sh": `#!/usr/bin/env bash
# source/aws.sh: power and inventory operations on an Amazon EC2 source
# instance (cloud-to-cloud; A.3.3). The item's source.id is the instance id and
# source.region its region.
#   stop: aws ec2 stop-instances (then wait instance-stopped)   start: start-instances
#   delete: terminate-instances, after checking DeleteOnTermination (volumes that
#           would survive are listed in the event)
#   snapshot: create-snapshots (all volumes, crash-consistent, tagged with the kit's name)
#   rename: the Name tag
# Credentials: the AWS CLI's own chain.
ADAPTER_PLATFORM=aws
# @@adapter-common@@

need aws
a() { aws --region "$SRC_REGION" --output json "$@"; }
inst() { a ec2 describe-instances --instance-ids "$SRC_ID" | jq -c '.Reservations[0].Instances[0]'; }

v_state() { inst | jq -r '.State.Name'; }
v_stop() {
  [ "$(v_state)" = stopped ] && { echo "already stopped"; return $SKIP; }
  mut a ec2 stop-instances --instance-ids "$SRC_ID" >/dev/null
  wait_state stopped v_state
}
v_start() {
  [ "$(v_state)" = running ] && { echo "already running"; return $SKIP; }
  mut a ec2 start-instances --instance-ids "$SRC_ID" >/dev/null
}
v_snapshot() {
  if [ "$(a ec2 describe-snapshots --owner-ids self --filters "Name=tag:Name,Values=$SNAP_NAME" | jq '.Snapshots | length')" -gt 0 ]; then
    echo "snapshots $SNAP_NAME exist"; return $SKIP
  fi
  mut a ec2 create-snapshots --instance-specification "InstanceId=$SRC_ID" --copy-tags-from-source volume \\
    --tag-specifications "ResourceType=snapshot,Tags=[{Key=Name,Value=$SNAP_NAME},{Key=atk-item,Value=$ITEM_ID}]" >/dev/null
}
v_delete() {
  local state keep
  state="$(v_state 2>/dev/null || echo gone)"
  case "$state" in terminated|gone|null) echo "already terminated"; return $SKIP ;; esac
  keep="$(inst | jq -r '[.BlockDeviceMappings[]? | select(.Ebs.DeleteOnTermination == false) | .Ebs.VolumeId] | join(" ")')"
  [ -n "$keep" ] && echo "volumes kept after termination (DeleteOnTermination false): $keep"
  mut a ec2 terminate-instances --instance-ids "$SRC_ID" >/dev/null
}
v_rename() {
  [ -n "$NEW_NAME" ] || { echo "--new-name is required"; return 2; }
  mut a ec2 create-tags --resources "$SRC_ID" --tags "Key=Name,Value=$NEW_NAME"
}

main
`,
  "azure.ps1": `<#
.SYNOPSIS
  source/azure.ps1: power and inventory operations on an Azure source VM
  (cloud-to-cloud; addendum A.3.3) with the Az modules.

.DESCRIPTION
  stop:     Stop-AzVM -Force (deallocates)          start: Start-AzVM
  snapshot: New-AzSnapshot of the OS and data disks (the kit's deterministic name)
  delete:   Remove-AzVM -Force, then the VM's own disks and NICs
  rename:   an Azure VM cannot be renamed; the tag atk-renamed-to records the new name
  source.id is the VM's resource id. Sign-in: Connect-AzAccount -Identity, or
  a federated service principal (AZURE_CLIENT_ID, AZURE_TENANT_ID,
  AZURE_FEDERATED_TOKEN_FILE), or an existing Az context. Applies by default;
  -DryRun prints each change.
  Exit codes: 0 ok, 2 usage, 3 missing module or sign-in, 10 some items failed.
#>
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('state', 'stop', 'start', 'snapshot', 'delete', 'rename', 'tools-remove')][string]$Verb,
  [string[]]$Item,
  [int]$Wave = -1,
  [switch]$DryRun,
  [int]$TimeoutMinutes = 10,
  [string]$NewName,
  [string]$Step,
  [string]$Path = 'orchestrator'
)
$AdapterPlatform = 'azure'
# @@adapter-common@@

if (-not (Get-Module -ListAvailable Az.Compute)) { Write-Error 'missing module: Az.Compute'; exit 3 }
if (-not (Get-AzContext -ErrorAction SilentlyContinue)) {
  if ($env:AZURE_FEDERATED_TOKEN_FILE) {
    Connect-AzAccount -ServicePrincipal -ApplicationId $env:AZURE_CLIENT_ID -Tenant $env:AZURE_TENANT_ID -FederatedToken (Get-Content -Raw $env:AZURE_FEDERATED_TOKEN_FILE) | Out-Null
  } else {
    Connect-AzAccount -Identity | Out-Null
  }
}
function Get-Rg([string]$id) { ($id -split '/')[4] }
function Get-SourceVM($it) {
  if ($it.source.id) { return Get-AzVM -ResourceGroupName (Get-Rg $it.source.id) -Name (($it.source.id -split '/')[-1]) -Status -ErrorAction SilentlyContinue }
  return Get-AzVM -Name $it.name -Status -ErrorAction SilentlyContinue | Select-Object -First 1
}
function Get-Power($vm) { if (-not $vm) { return 'absent' }; ($vm.Statuses | Where-Object { $_.Code -like 'PowerState/*' } | Select-Object -First 1).Code -replace '^PowerState/', '' }

Invoke-Main @{
  'state'        = { param($it) Get-Power (Get-SourceVM $it) }
  'stop'         = { param($it)
    $vm = Get-SourceVM $it
    if ((Get-Power $vm) -in 'deallocated', 'stopped') { 'already stopped'; $Skip; return }
    Invoke-Mut { Stop-AzVM -ResourceGroupName $vm.ResourceGroupName -Name $vm.Name -Force | Out-Null } }
  'start'        = { param($it)
    $vm = Get-SourceVM $it
    if ((Get-Power $vm) -eq 'running') { 'already running'; $Skip; return }
    Invoke-Mut { Start-AzVM -ResourceGroupName $vm.ResourceGroupName -Name $vm.Name | Out-Null } }
  'snapshot'     = { param($it)
    $vm = Get-AzVM -ResourceGroupName (Get-Rg $it.source.id) -Name (($it.source.id -split '/')[-1])
    $disks = @($vm.StorageProfile.OsDisk.ManagedDisk.Id) + @($vm.StorageProfile.DataDisks | ForEach-Object { $_.ManagedDisk.Id })
    $n = 0
    foreach ($d in $disks | Where-Object { $_ }) {
      $n++
      $name = '{0}-{1}' -f $SnapName, $n
      if (Get-AzSnapshot -ResourceGroupName $vm.ResourceGroupName -SnapshotName $name -ErrorAction SilentlyContinue) { continue }
      Invoke-Mut {
        $cfg = New-AzSnapshotConfig -SourceUri $d -Location $vm.Location -CreateOption Copy -Incremental
        New-AzSnapshot -ResourceGroupName $vm.ResourceGroupName -SnapshotName $name -Snapshot $cfg | Out-Null
      }
    } }
  'delete'       = { param($it)
    $vm = Get-AzVM -ResourceGroupName (Get-Rg $it.source.id) -Name (($it.source.id -split '/')[-1]) -ErrorAction SilentlyContinue
    if (-not $vm) { 'already gone'; $Skip; return }
    $disks = @($vm.StorageProfile.OsDisk.ManagedDisk.Id) + @($vm.StorageProfile.DataDisks | ForEach-Object { $_.ManagedDisk.Id }) | Where-Object { $_ }
    $nics = @($vm.NetworkProfile.NetworkInterfaces | ForEach-Object { $_.Id })
    Invoke-Mut {
      Remove-AzVM -ResourceGroupName $vm.ResourceGroupName -Name $vm.Name -Force | Out-Null
      foreach ($d in $disks) { Remove-AzDisk -ResourceGroupName (Get-Rg $d) -DiskName (($d -split '/')[-1]) -Force | Out-Null }
      foreach ($n in $nics) { Remove-AzNetworkInterface -ResourceGroupName (Get-Rg $n) -Name (($n -split '/')[-1]) -Force }
    } }
  'rename'       = { param($it)
    if (-not $NewName) { throw '-NewName is required' }
    $vm = Get-AzVM -ResourceGroupName (Get-Rg $it.source.id) -Name (($it.source.id -split '/')[-1])
    Invoke-Mut { Update-AzTag -ResourceId $vm.Id -Tag @{ 'atk-renamed-to' = $NewName } -Operation Merge | Out-Null }
    'an Azure VM cannot be renamed; tagged atk-renamed-to' }
  'tools-remove' = { param($it) Invoke-ToolsRemove $it }
}
`,
  "gcp.sh": `#!/usr/bin/env bash
# source/gcp.sh: power and inventory operations on a Google Cloud (GCP)
# Compute Engine source instance (cloud-to-cloud; A.3.3). source.manager is the
# project, source.cluster the zone and source.id or the item name the instance.
#   stop: gcloud compute instances stop    start: gcloud compute instances start
#   delete: gcloud compute instances delete --delete-disks=all
#   snapshot: gcloud compute snapshots create, one per attached disk
#   rename: gcloud compute instances set-name (the instance must be stopped)
# Credentials: gcloud's own.
ADAPTER_PLATFORM=google
# @@adapter-common@@

need gcloud
g() { gcloud --project "$SRC_MANAGER" "$@" --zone "$SRC_CLUSTER" --quiet; }
inst() { printf '%s' "\${GCP_INSTANCE:-$NAME}"; }

v_state() { g compute instances describe "$(inst)" --format='value(status)'; }
v_stop() {
  [ "$(v_state)" = TERMINATED ] && { echo "already stopped"; return $SKIP; }
  mut g compute instances stop "$(inst)"
}
v_start() {
  [ "$(v_state)" = RUNNING ] && { echo "already running"; return $SKIP; }
  mut g compute instances start "$(inst)"
}
v_snapshot() {
  local disk n=0
  for disk in $(g compute instances describe "$(inst)" --format='value(disks[].source.basename())' | tr ';' ' '); do
    n=$((n + 1))
    local snap; snap="$(printf '%s-%s' "$SNAP_NAME" "$n" | cut -c1-62)"
    if gcloud --project "$SRC_MANAGER" compute snapshots describe "$snap" >/dev/null 2>&1; then echo "snapshot $snap exists"; continue; fi
    mut gcloud --project "$SRC_MANAGER" compute snapshots create "$snap" --source-disk "$disk" --source-disk-zone "$SRC_CLUSTER" --quiet
  done
}
v_delete() {
  g compute instances describe "$(inst)" >/dev/null 2>&1 || { echo "already gone"; return $SKIP; }
  mut g compute instances delete "$(inst)" --delete-disks=all
}
v_rename() {
  [ -n "$NEW_NAME" ] || { echo "--new-name is required"; return 2; }
  [ "$(v_state)" = TERMINATED ] || { echo "set-name needs the instance stopped"; return 1; }
  mut g compute instances set-name "$(inst)" --new-name "$NEW_NAME"
}

main
`,
  "hyperv.ps1": `<#
.SYNOPSIS
  source/hyperv.ps1: power and inventory operations on a Hyper-V source VM,
  run with Invoke-Command on the owning host in the item's source.host
  (addendum A.3.3).

.DESCRIPTION
  stop:     Stop-VM (graceful shutdown through the integration services),
            then Stop-VM -TurnOff after -TimeoutMinutes
  start:    Start-VM
  snapshot: Checkpoint-VM -SnapshotName (the kit's deterministic name)
  delete:   Remove-VM -Force, then the VHD / VHDX files Get-VMHardDiskDrive listed
  rename:   Rename-VM
  WinRM runs as the current identity (Kerberos); HYPERV_USER and
  HYPERV_PASSWORD (or HYPERV_PASSWORD_FILE / ATK_VAULT_CMD) give another. From
  a Linux controller, run it through Ansible's win_powershell on a management
  host. Applies by default; -DryRun prints each change.
  Exit codes: 0 ok, 2 usage, 3 missing credential, 10 some items failed.
#>
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('state', 'stop', 'start', 'snapshot', 'delete', 'rename', 'tools-remove')][string]$Verb,
  [string[]]$Item,
  [int]$Wave = -1,
  [switch]$DryRun,
  [int]$TimeoutMinutes = 10,
  [string]$NewName,
  [string]$Step,
  [string]$Path = 'orchestrator'
)
$AdapterPlatform = 'hyperv'
# @@adapter-common@@

function Invoke-OnHost($it, [scriptblock]$Block, [object[]]$ArgumentList = @()) {
  $params = @{ ComputerName = [string]$it.source.host; ScriptBlock = $Block; ArgumentList = $ArgumentList; ErrorAction = 'Stop' }
  if ($env:HYPERV_USER) { $params.Credential = Get-AtkCredential 'HYPERV_USER' 'HYPERV_PASSWORD' }
  Invoke-Command @params
}
function Get-VmState($it) {
  Invoke-OnHost $it { param($n, $id) $vm = if ($id) { Get-VM -Id $id -ErrorAction SilentlyContinue } else { Get-VM -Name $n -ErrorAction SilentlyContinue }; if ($vm) { [string]$vm.State } else { 'absent' } } @($it.name, [string]$it.source.id)
}

Invoke-Main @{
  'state'        = { param($it) Get-VmState $it }
  'stop'         = { param($it)
    if ((Get-VmState $it) -eq 'Off') { 'already off'; $Skip; return }
    Invoke-Mut { Invoke-OnHost $it { param($n) Stop-VM -Name $n -Force -AsJob | Out-Null } @($it.name) }
    if (-not (Wait-State 'Off' { Get-VmState $it })) {
      Write-Warning "$($it.name): no shutdown in $TimeoutMinutes minutes; turning off"
      Invoke-Mut { Invoke-OnHost $it { param($n) Stop-VM -Name $n -TurnOff -Force } @($it.name) }
    } }
  'start'        = { param($it)
    if ((Get-VmState $it) -eq 'Running') { 'already running'; $Skip; return }
    Invoke-Mut { Invoke-OnHost $it { param($n) Start-VM -Name $n } @($it.name) } }
  'snapshot'     = { param($it)
    $exists = Invoke-OnHost $it { param($n, $s) [bool](Get-VMSnapshot -VMName $n -Name $s -ErrorAction SilentlyContinue) } @($it.name, $SnapName)
    if ($exists) { "checkpoint $SnapName exists"; $Skip; return }
    Invoke-Mut { Invoke-OnHost $it { param($n, $s) Checkpoint-VM -Name $n -SnapshotName $s } @($it.name, $SnapName) } }
  'delete'       = { param($it)
    if ((Get-VmState $it) -eq 'absent') { 'already gone'; $Skip; return }
    Invoke-Mut {
      Invoke-OnHost $it { param($n)
        $paths = @(Get-VMHardDiskDrive -VMName $n | ForEach-Object { $_.Path } | Where-Object { $_ })
        Stop-VM -Name $n -TurnOff -Force -ErrorAction SilentlyContinue
        Remove-VM -Name $n -Force
        foreach ($p in $paths) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
      } @($it.name)
    } }
  'rename'       = { param($it)
    if (-not $NewName) { throw '-NewName is required' }
    Invoke-Mut { Invoke-OnHost $it { param($n, $new) Rename-VM -Name $n -NewName $new } @($it.name, $NewName) } }
  'tools-remove' = { param($it) Invoke-ToolsRemove $it }
}
`,
  "kvm.sh": `#!/usr/bin/env bash
# source/kvm.sh: power and inventory operations on a KVM / libvirt source VM,
# over ssh to the host in the item's source.host (addendum A.3.3).
#   stop: virsh shutdown, then virsh destroy after --timeout
#   start: virsh start    delete: virsh undefine --remove-all-storage --nvram
#   snapshot: virsh snapshot-create-as (the kit's deterministic name)
#   rename: virsh domrename (the VM must be shut off)
# ssh uses the controller's keys (KVM_SSH_USER, default root). libvirt URI:
# KVM_URI (default qemu:///system).
ADAPTER_PLATFORM=kvm
# @@adapter-common@@

need ssh
# The remote shell parses the command again, so every argument is quoted for it.
v() { ssh -o BatchMode=yes "\${KVM_SSH_USER:-root}@$SRC_HOST" "virsh -c $(printf '%q' "\${KVM_URI:-qemu:///system}") $(printf '%q ' "$@")"; }
dom() { printf '%s' "\${SRC_ID:-$NAME}"; }

v_state() { v domstate "$(dom)" | awk 'NF && !d { print; d = 1 }'; }
v_stop() {
  case "$(v_state)" in 'shut off') echo "already shut off"; return $SKIP ;; esac
  mut v shutdown "$(dom)"
  wait_state 'shut off' v_state && return 0
  echo "no clean shutdown in $TIMEOUT minutes; forcing off"
  mut v destroy "$(dom)"
}
v_start() {
  case "$(v_state)" in running) echo "already running"; return $SKIP ;; esac
  mut v start "$(dom)"
}
v_snapshot() {
  if v snapshot-list "$(dom)" --name | grep -x "$SNAP_NAME" >/dev/null; then echo "snapshot $SNAP_NAME exists"; return $SKIP; fi
  mut v snapshot-create-as --domain "$(dom)" --name "$SNAP_NAME" --description "pre-cutover restore point" --atomic
}
v_delete() {
  v dominfo "$(dom)" >/dev/null 2>&1 || { echo "already gone"; return $SKIP; }
  [ "$(v_state)" = 'shut off' ] || mut v destroy "$(dom)"
  mut v undefine "$(dom)" --remove-all-storage --nvram --snapshots-metadata
}
v_rename() {
  [ -n "$NEW_NAME" ] || { echo "--new-name is required"; return 2; }
  [ "$(v_state)" = 'shut off' ] || { echo "domrename needs the VM shut off"; return 1; }
  mut v domrename "$(dom)" "$NEW_NAME"
}

main
`,
  "oci.sh": `#!/usr/bin/env bash
# source/oci.sh: power and inventory operations on an OCI Compute source
# instance (cloud-to-cloud; A.3.3). source.id is the instance OCID.
#   stop: oci compute instance action --action SOFTSTOP (STOP after --timeout)
#   start: --action START
#   delete: oci compute instance terminate --preserve-boot-volume false
#   snapshot: a boot-volume backup plus a backup of each attached block volume
#   rename: oci compute instance update --display-name
# Credentials: the OCI CLI's own (config profile or OCI_CLI_AUTH=instance_principal).
ADAPTER_PLATFORM=oci
# @@adapter-common@@

need oci
o() { oci \${SRC_REGION:+--region "$SRC_REGION"} "$@" --output json; }
inst() { o compute instance get --instance-id "$SRC_ID" | jq -c '.data'; }

v_state() { inst | jq -r '.["lifecycle-state"]'; }
v_stop() {
  [ "$(v_state)" = STOPPED ] && { echo "already stopped"; return $SKIP; }
  mut o compute instance action --instance-id "$SRC_ID" --action SOFTSTOP >/dev/null
  wait_state STOPPED v_state && return 0
  echo "no soft stop in $TIMEOUT minutes; stopping"
  mut o compute instance action --instance-id "$SRC_ID" --action STOP >/dev/null
}
v_start() {
  [ "$(v_state)" = RUNNING ] && { echo "already running"; return $SKIP; }
  mut o compute instance action --instance-id "$SRC_ID" --action START >/dev/null
}
v_snapshot() {
  local i comp ad bv vol
  i="$(inst)"; comp="$(jq -r '.["compartment-id"]' <<<"$i")"; ad="$(jq -r '.["availability-domain"]' <<<"$i")"
  if [ "$(o bv boot-volume-backup list --compartment-id "$comp" --display-name "$SNAP_NAME" | jq '[.data[]? | select(.["lifecycle-state"] != "TERMINATED")] | length')" -gt 0 ]; then
    echo "backup $SNAP_NAME exists"; return $SKIP
  fi
  for bv in $(o compute boot-volume-attachment list --compartment-id "$comp" --availability-domain "$ad" --instance-id "$SRC_ID" | jq -r '.data[]?["boot-volume-id"]'); do
    mut o bv boot-volume-backup create --boot-volume-id "$bv" --display-name "$SNAP_NAME" --type INCREMENTAL >/dev/null
  done
  for vol in $(o compute volume-attachment list --compartment-id "$comp" --instance-id "$SRC_ID" --all | jq -r '.data[]? | select(.["lifecycle-state"] == "ATTACHED") | .["volume-id"]'); do
    mut o bv backup create --volume-id "$vol" --display-name "$SNAP_NAME" --type INCREMENTAL >/dev/null
  done
}
v_delete() {
  case "$(v_state 2>/dev/null || echo gone)" in TERMINATED|TERMINATING|gone) echo "already terminated"; return $SKIP ;; esac
  mut o compute instance terminate --instance-id "$SRC_ID" --preserve-boot-volume false --force >/dev/null
}
v_rename() {
  [ -n "$NEW_NAME" ] || { echo "--new-name is required"; return 2; }
  mut o compute instance update --instance-id "$SRC_ID" --display-name "$NEW_NAME" --force >/dev/null
}

main
`,
  "operator.sh": `#!/usr/bin/env bash
# source/operator.sh: the source adapter for platforms with no automation:
# IBM Power, SPARC, Itanium, PA-RISC, mainframe and other (addendum A.3.3).
# Every verb writes a "skipped" event naming the operator step; the runbook
# carries the manual procedure (A.4.8).
ADAPTER_PLATFORM="\${ATK_SOURCE_PLATFORM:-other}"
# @@adapter-common@@

v_state() { echo "unknown (operator step)"; }
v_stop() { echo "operator step: shut $NAME down by the platform's own procedure"; return $SKIP; }
v_start() { echo "operator step: start $NAME by the platform's own procedure"; return $SKIP; }
v_snapshot() { echo "operator step: take the platform's backup of $NAME before cutover"; return $SKIP; }
v_delete() { echo "operator step: retire $NAME and mark it in the CMDB"; return $SKIP; }
v_rename() { echo "operator step: rename $NAME on the platform"; return $SKIP; }
v_tools_remove() { echo "operator step: nothing to remove by script on this platform"; return $SKIP; }

main
`,
  "ovirt.sh": `#!/usr/bin/env bash
# source/ovirt.sh: power and inventory operations on an oVirt / RHV / OLVM
# source VM through the engine's REST API v4 (A.3.3).
#   stop: POST /vms/{id}/shutdown (then /stop after --timeout)   start: POST /vms/{id}/start
#   delete: DELETE /vms/{id} (disks removed with the VM: detach_only=false)
#   snapshot: POST /vms/{id}/snapshots (no memory state)          rename: PUT /vms/{id} {name}
# OVIRT_URL (default https://<source.manager>), OVIRT_USER, OVIRT_PASSWORD (or
# OVIRT_PASSWORD_FILE / ATK_VAULT_CMD); OVIRT_CA_FILE for the engine CA.
ADAPTER_PLATFORM=ovirt
# @@adapter-common@@

need curl
cfg_escape() { printf '%s' "$1" | sed 's/[\\\\"]/\\\\&/g'; }
api() { # method path [json-body]
  local base="\${OVIRT_URL:-https://$SRC_MANAGER}" extra=() tls=()
  [ -n "\${3:-}" ] && extra=(-H 'Content-Type: application/json' --data "$3")
  [ -n "\${OVIRT_CA_FILE:-}" ] && tls=(--cacert "$OVIRT_CA_FILE")
  printf 'user = "%s:%s"\\n' "$(cfg_escape "$(atk_secret OVIRT_USER)")" "$(cfg_escape "$(atk_secret OVIRT_PASSWORD)")" \\
    | curl -sS --fail -K - \${tls[@]+"\${tls[@]}"} -X "$1" -H 'Version: 4' -H 'Accept: application/json' \\
      \${extra[@]+"\${extra[@]}"} "\${base%/}/ovirt-engine/api$2"
}
change() { if [ "$ATK_DRY_RUN" = 1 ]; then echo "dry-run: $1 $2 \${3:-}" >&2; else api "$@" >/dev/null; fi; }

v_state() { api GET "/vms/$SRC_ID" | jq -r '.status'; }
v_stop() {
  [ "$(v_state)" = down ] && { echo "already down"; return $SKIP; }
  change POST "/vms/$SRC_ID/shutdown" '{}'
  wait_state down v_state && return 0
  echo "no clean shutdown in $TIMEOUT minutes; stopping"
  change POST "/vms/$SRC_ID/stop" '{}'
}
v_start() {
  [ "$(v_state)" = up ] && { echo "already up"; return $SKIP; }
  change POST "/vms/$SRC_ID/start" '{}'
}
v_snapshot() {
  if api GET "/vms/$SRC_ID/snapshots" | jq -e --arg n "$SNAP_NAME" 'any(.snapshot[]?; .description == $n)' >/dev/null; then echo "snapshot $SNAP_NAME exists"; return $SKIP; fi
  change POST "/vms/$SRC_ID/snapshots" "$(jq -nc --arg n "$SNAP_NAME" '{description: $n, persist_memorystate: false}')"
}
v_delete() {
  api GET "/vms/$SRC_ID" >/dev/null 2>&1 || { echo "already gone"; return $SKIP; }
  [ "$(v_state)" = down ] || { change POST "/vms/$SRC_ID/stop" '{}'; wait_state down v_state || true; }
  change DELETE "/vms/$SRC_ID?detach_only=false"
}
v_rename() {
  [ -n "$NEW_NAME" ] || { echo "--new-name is required"; return 2; }
  change PUT "/vms/$SRC_ID" "$(jq -nc --arg n "$NEW_NAME" '{name: $n}')"
}

main
`,
  "physical.sh": `#!/usr/bin/env bash
# source/physical.sh: power operations on a physical source server (A.3.3).
#   stop: Ansible "shutdown -h +1" (Linux) or "shutdown /s /t 60" (Windows) in the guest
#   start: through the BMC with Redfish (community.general.redfish_command,
#          category Systems, command PowerOn); state reads the BMC's Redfish PowerState
#   snapshot, rename: not available on hardware (skipped, with the reason)
#   delete: not automated; the hardware is marked for disposal in the CMDB (skipped)
# BMC credentials: BMC_USER and BMC_PASSWORD (or BMC_PASSWORD_FILE / ATK_VAULT_CMD),
# handed to Ansible in the environment, never as arguments. BMC_CA_FILE for the BMC CA;
# BMC_INSECURE=1 skips certificate checks (not recommended).
ADAPTER_PLATFORM=physical
# @@adapter-common@@

INVENTORY="\${ATK_ANSIBLE_INVENTORY:-$KIT/ansible/inventory}"
cfg_escape() { printf '%s' "$1" | sed 's/[\\\\"]/\\\\&/g'; }
redfish() { # path
  [ -n "$SRC_BMC" ] || { echo "no BMC address (source.bmc) for $NAME" >&2; return 3; }
  local tls=()
  [ -n "\${BMC_CA_FILE:-}" ] && tls=(--cacert "$BMC_CA_FILE")
  [ "\${BMC_INSECURE:-0}" = 1 ] && tls=(-k)
  printf 'user = "%s:%s"\\n' "$(cfg_escape "$(atk_secret BMC_USER)")" "$(cfg_escape "$(atk_secret BMC_PASSWORD)")" \\
    | curl -sS --fail -K - \${tls[@]+"\${tls[@]}"} -H 'Accept: application/json' "https://$SRC_BMC$1"
}

v_state() {
  local sys
  sys="$(redfish /redfish/v1/Systems | jq -r '.Members[0]["@odata.id"]')"
  redfish "$sys" | jq -r '.PowerState'
}
v_stop() {
  need ansible
  [ "$(v_state 2>/dev/null || true)" = Off ] && { echo "already off"; return $SKIP; }
  local os
  os="$(ansible -i "$INVENTORY" "$NAME" -m ansible.builtin.setup -a 'gather_subset=min filter=ansible_os_family' -o 2>/dev/null | grep -o '"ansible_os_family": "[A-Za-z]*"' | awk -F'"' '{ print $4 }')"
  if [ "$os" = Windows ]; then
    mut ansible -i "$INVENTORY" "$NAME" -m ansible.windows.win_command -a 'shutdown /s /t 60'
  else
    mut ansible -i "$INVENTORY" "$NAME" -b -m ansible.builtin.command -a 'shutdown -h +1'
  fi
  [ -n "$SRC_BMC" ] && { wait_state Off v_state || { echo "still on after $TIMEOUT minutes"; return 1; }; }
  return 0
}
v_start() {
  need ansible
  [ "$(v_state 2>/dev/null || true)" = On ] && { echo "already on"; return $SKIP; }
  [ -n "$SRC_BMC" ] || { echo "no BMC address (source.bmc) for $NAME"; return 3; }
  BMC_USER="$(atk_secret BMC_USER)" BMC_PASSWORD="$(atk_secret BMC_PASSWORD)" ATK_BMC="$SRC_BMC" \\
    mut ansible localhost -m community.general.redfish_command \\
      -a "category=Systems command=PowerOn baseuri={{ lookup('ansible.builtin.env', 'ATK_BMC') }} username={{ lookup('ansible.builtin.env', 'BMC_USER') }} password={{ lookup('ansible.builtin.env', 'BMC_PASSWORD') }}"
}
v_snapshot() { echo "no snapshot on hardware: take a backup before cutover (runbook step)"; return $SKIP; }
v_delete() { echo "operator step: mark $NAME for disposal in the CMDB (hardware is not deleted by script)"; return $SKIP; }
v_rename() { echo "operator step: the source hardware keeps its name until disposal"; return $SKIP; }

main
`,
  "proxmox.sh": `#!/usr/bin/env bash
# source/proxmox.sh: power and inventory operations on a Proxmox VE source VM
# or container, with pvesh over ssh to the node in source.host (A.3.3).
#   stop: pvesh create /nodes/<n>/<qemu|lxc>/<id>/status/shutdown (then stop after --timeout)
#   start: .../status/start    delete: pvesh delete /nodes/<n>/<type>/<id> --purge 1
#   snapshot: pvesh create .../snapshot --snapname <name>
#   rename: pvesh set .../config --name (qemu) or --hostname (lxc)
# ssh uses the controller's keys (PVE_SSH_USER, default root; PVE_SSH_HOST
# overrides the node name as the ssh target).
ADAPTER_PLATFORM=proxmox
# @@adapter-common@@

need ssh
# The remote shell parses the command again, so every argument is quoted for it.
p() { ssh -o BatchMode=yes "\${PVE_SSH_USER:-root}@\${PVE_SSH_HOST:-$SRC_HOST}" "pvesh $(printf '%q ' "$@") --output-format json"; }
vmtype() { p get /cluster/resources --type vm | jq -r --arg id "$SRC_ID" '[.[] | select((.vmid | tostring) == $id)][0].type // "qemu"'; }
base() { printf '/nodes/%s/%s/%s' "$SRC_HOST" "$(vmtype)" "$SRC_ID"; }

v_state() { p get "$(base)/status/current" | jq -r '.status'; }
v_stop() {
  [ "$(v_state)" = stopped ] && { echo "already stopped"; return $SKIP; }
  mut p create "$(base)/status/shutdown" --timeout $((TIMEOUT * 60)) --forceStop 1
  wait_state stopped v_state
}
v_start() {
  [ "$(v_state)" = running ] && { echo "already running"; return $SKIP; }
  mut p create "$(base)/status/start"
}
v_snapshot() {
  # Proxmox snapshot names: a letter, then letters, digits and underscores.
  local snap; snap="$(printf '%s' "$SNAP_NAME" | tr -c 'A-Za-z0-9_' '_' | cut -c1-40)"
  if p get "$(base)/snapshot" | jq -e --arg n "$snap" 'any(.[]; .name == $n)' >/dev/null; then echo "snapshot $snap exists"; return $SKIP; fi
  mut p create "$(base)/snapshot" --snapname "$snap" --description "pre-cutover restore point"
}
v_delete() {
  p get "$(base)/status/current" >/dev/null 2>&1 || { echo "already gone"; return $SKIP; }
  [ "$(v_state)" = stopped ] || mut p create "$(base)/status/stop"
  wait_state stopped v_state || true
  mut p delete "$(base)" --purge 1
}
v_rename() {
  [ -n "$NEW_NAME" ] || { echo "--new-name is required"; return 2; }
  if [ "$(vmtype)" = lxc ]; then mut p set "$(base)/config" --hostname "$NEW_NAME"; else mut p set "$(base)/config" --name "$NEW_NAME"; fi
}

main
`,
  "vsphere.ps1": `<#
.SYNOPSIS
  source/vsphere.ps1: power and inventory operations on a vSphere source VM
  with VCF PowerCLI (addendum A.3.3).

.DESCRIPTION
  stop:     Stop-VMGuest, then Stop-VM -Confirm:$false after -TimeoutMinutes
  start:    Start-VM
  snapshot: New-Snapshot -Memory:$false -Quiesce:$true (the kit's deterministic name)
  delete:   Remove-VM -DeletePermanently -Confirm:$false
  rename:   Set-VM -Name
  The vCenter is the item's source.manager; source.id is the VM's MoRef.
  Credentials: VCENTER_USER and VCENTER_PASSWORD (or VCENTER_PASSWORD_FILE,
  or ATK_VAULT_CMD). Applies by default; -DryRun prints each change.
  Exit codes: 0 ok, 2 usage, 3 missing module or credential, 10 some items failed.
#>
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('state', 'stop', 'start', 'snapshot', 'delete', 'rename', 'tools-remove')][string]$Verb,
  [string[]]$Item,
  [int]$Wave = -1,
  [switch]$DryRun,
  [int]$TimeoutMinutes = 10,
  [string]$NewName,
  [string]$Step,
  [string]$Path = 'orchestrator'
)
$AdapterPlatform = 'vsphere'
# @@adapter-common@@

if (-not (Get-Module -ListAvailable VCF.PowerCLI) -and -not (Get-Module -ListAvailable VMware.VimAutomation.Core)) { Write-Error 'missing module: VCF.PowerCLI'; exit 3 }
$connected = @{}
function Get-SourceVM($it) {
  $server = [string]$it.source.manager
  if (-not $connected.ContainsKey($server)) {
    $connected[$server] = Connect-VIServer -Server $server -Credential (Get-AtkCredential 'VCENTER_USER' 'VCENTER_PASSWORD') -ErrorAction Stop
  }
  if ($it.source.id) { return Get-VM -Server $connected[$server] -Id ('VirtualMachine-{0}' -f ($it.source.id -replace '^VirtualMachine-', '')) -ErrorAction SilentlyContinue }
  return Get-VM -Server $connected[$server] -Name $it.name -ErrorAction SilentlyContinue
}

Invoke-Main @{
  'state'        = { param($it) $vm = Get-SourceVM $it; if ($vm) { [string]$vm.PowerState } else { 'absent' } }
  'stop'         = { param($it)
    $vm = Get-SourceVM $it
    if ($vm.PowerState -eq 'PoweredOff') { 'already off'; $Skip; return }
    Invoke-Mut { Stop-VMGuest -VM $vm -Confirm:$false | Out-Null }
    if (-not (Wait-State 'PoweredOff' { [string](Get-SourceVM $it).PowerState })) {
      Write-Warning "$($it.name): no guest shutdown in $TimeoutMinutes minutes; powering off"
      Invoke-Mut { Stop-VM -VM $vm -Confirm:$false | Out-Null }
    } }
  'start'        = { param($it)
    $vm = Get-SourceVM $it
    if ($vm.PowerState -eq 'PoweredOn') { 'already on'; $Skip; return }
    Invoke-Mut { Start-VM -VM $vm -Confirm:$false | Out-Null } }
  'snapshot'     = { param($it)
    $vm = Get-SourceVM $it
    if (Get-Snapshot -VM $vm -Name $SnapName -ErrorAction SilentlyContinue) { "snapshot $SnapName exists"; $Skip; return }
    Invoke-Mut { New-Snapshot -VM $vm -Name $SnapName -Description 'pre-cutover restore point' -Memory:$false -Quiesce:$true -Confirm:$false | Out-Null } }
  'delete'       = { param($it)
    $vm = Get-SourceVM $it
    if (-not $vm) { 'already gone'; $Skip; return }
    if ($vm.PowerState -ne 'PoweredOff') { Invoke-Mut { Stop-VM -VM $vm -Confirm:$false | Out-Null } }
    Invoke-Mut { Remove-VM -VM $vm -DeletePermanently -Confirm:$false } }
  'rename'       = { param($it)
    if (-not $NewName) { throw '-NewName is required' }
    $vm = Get-SourceVM $it
    Invoke-Mut { Set-VM -VM $vm -Name $NewName -Confirm:$false | Out-Null } }
  'tools-remove' = { param($it) Invoke-ToolsRemove $it }
}
`,
  "xen.sh": `#!/usr/bin/env bash
# source/xen.sh: power and inventory operations on a Citrix Hypervisor /
# XenServer / XCP-ng source VM with the xe CLI (A.3.3).
#   stop: xe vm-shutdown (clean), forced after --timeout    start: xe vm-start
#   delete: xe vm-uninstall force=true                      snapshot: xe vm-snapshot
#   rename: xe vm-param-set name-label=
# Remote pools: XE_HOST (default: the item's source.manager), XE_USER and
# XE_PASSWORD_FILE (mode 600; xe reads it with -pwf).
ADAPTER_PLATFORM=xen
# @@adapter-common@@

need xe
xe_cmd() { # sets XE to the xe command line for this item's pool
  local host="\${XE_HOST:-$SRC_MANAGER}"
  XE=(xe)
  if [ -n "$host" ] && [ -n "\${XE_PASSWORD_FILE:-}" ]; then XE=(xe -s "$host" -u "\${XE_USER:-root}" -pwf "$XE_PASSWORD_FILE"); fi
}
x() { xe_cmd; "\${XE[@]}" "$@"; }
uuid() {
  if [ -n "$SRC_ID" ]; then printf '%s' "$SRC_ID"; else x vm-list name-label="$NAME" is-control-domain=false --minimal; fi
}

v_state() { x vm-param-get uuid="$(uuid)" param-name=power-state; }
v_stop() {
  [ "$(v_state)" = halted ] && { echo "already halted"; return $SKIP; }
  local id; id="$(uuid)"
  if [ "$ATK_DRY_RUN" = 1 ]; then mut x vm-shutdown uuid="$id"; return 0; fi
  xe_cmd
  timeout $((TIMEOUT * 60)) "\${XE[@]}" vm-shutdown uuid="$id" \\
    || { echo "no clean shutdown in $TIMEOUT minutes; forcing"; x vm-shutdown uuid="$id" force=true; }
}
v_start() {
  [ "$(v_state)" = running ] && { echo "already running"; return $SKIP; }
  mut x vm-start uuid="$(uuid)"
}
v_snapshot() {
  if [ -n "$(x snapshot-list name-label="$SNAP_NAME" snapshot-of="$(uuid)" --minimal 2>/dev/null)" ]; then echo "snapshot $SNAP_NAME exists"; return $SKIP; fi
  mut x vm-snapshot uuid="$(uuid)" new-name-label="$SNAP_NAME"
}
v_delete() {
  [ -n "$(uuid)" ] && x vm-param-get uuid="$(uuid)" param-name=uuid >/dev/null 2>&1 || { echo "already gone"; return $SKIP; }
  mut x vm-uninstall uuid="$(uuid)" force=true
}
v_rename() {
  [ -n "$NEW_NAME" ] || { echo "--new-name is required"; return 2; }
  mut x vm-param-set uuid="$(uuid)" name-label="$NEW_NAME"
}

main
`,
});
