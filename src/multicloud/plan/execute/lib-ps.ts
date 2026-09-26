/**
 * `lib/Atk.psm1`: the PowerShell twin of `lib/atk.sh` (addendum A.6.2), for
 * the paths whose tools exist only in PowerShell (VCF PowerCLI and HCX,
 * Az.Migrate, Az.DataMigration, Az.Sql, dbatools, Hyper-V); and `psScript`,
 * the skeleton those path generators build on.
 *
 * API (the same contract as the bash library):
 *   Initialize-Atk -Path -Verb -Wave -Item -DryRun -GateOverride -Once -Timeout [-Tool]
 *   Invoke-AtkMain -Verbs @{ prepare = { param($Id) ... }; ... }   events, exit codes
 *   Get-AtkItems / Get-AtkItem -Id / Get-AtkName -Id
 *   Invoke-AtkStep 'description' { mutating call }    (-DryRun: logged, not run)
 *   Invoke-AtkRetry -Attempts -DelaySeconds 'description' { ... }
 *   Wait-AtkUntil -Minutes -IntervalSeconds { read-only check }
 *   Get-AtkSecret -Name                 $NAME, $NAME_FILE (owner-only), or $ATK_VAULT_CMD
 *   Write-AtkEvent -Item -Step -Outcome [-State] [-Detail] [-Data @{}]
 *   Set-AtkOutcome -Outcome skipped|succeeded|failed [-Detail] [-State] [-Data]   (inside a verb)
 *   Enter-AtkLock -Name / Assert-AtkGate -Gate / Assert-AtkTool -Command -Module
 *   Get-AtkId / Set-AtkId -Path -Key [-Value]   the id cache in status/ids/<path>.json
 *   New-AtkTempFile / Write-AtkLog / Hide-AtkSecret
 *
 * PowerShell 7.4 or later. Scripts are run by the bash orchestrators with
 * `pwsh -NoProfile -File` (`atk_pwsh` translates the options).
 */

import { ITEM_STATE_VALUES, OUTCOME_VALUES, STEP_ID_VALUES } from '../options.ts';
import { EXIT_CODES, GATE_ALIAS, VERB_STEP, VERBS, type ExecPath, type Verb } from './contract.ts';
import { code, libPathFrom, usageText } from './lib-sh.ts';

const psList = (xs: readonly string[]): string => `@(${xs.map((x) => `'${x}'`).join(', ')})`;

/** The text of `lib/Atk.psm1`. */
export function renderLibPs(): string {
  const verbStep = VERBS.map((v) => `'${v}' = '${VERB_STEP[v]}'`).join('; ');
  const gates = (Object.keys(GATE_ALIAS) as (keyof typeof GATE_ALIAS)[]).map((g) => `'${g}' = '${GATE_ALIAS[g]}'`).join('; ');
  const usage = usageText(true).split('\n').map((l) => `'${l.replace(/'/g, "''")}'`).join(',\n  ');
  return code`#Requires -Version 7.4
# lib/Atk.psm1: the execution kit's shared library for PowerShell. The same contract as lib/atk.sh:
#   - changes are made by default; -DryRun logs each change instead of making it (read-only calls still run);
#   - verbs are idempotent: read the state first, Set-AtkOutcome skipped when the item is already there;
#   - credentials from $env:NAME, $env:NAME_FILE (owner-only) or $env:ATK_VAULT_CMD, never from kit files;
#   - status events (archtoolkit.migration-status) appended to status/events.jsonl under a lock;
#   - one set of verbs, options and exit codes; a redacted log per run.
Set-StrictMode -Version 3.0

$script:VerbStep = @{ ${verbStep} }
$script:StepList = ${psList(STEP_ID_VALUES)}
$script:StateList = ${psList(ITEM_STATE_VALUES)}
$script:OutcomeList = ${psList(OUTCOME_VALUES)}
$script:GateAlias = @{ ${gates} }
$script:Usage = @(
  ${usage}
) -join [char]10

$script:AtkHome = Split-Path -Parent $PSScriptRoot
$script:AtkRoot = if ($env:ATK_ROOT) { $env:ATK_ROOT } else { Split-Path -Parent (Split-Path -Parent $script:AtkHome) }
$script:AtkStatus = if ($env:ATK_STATUS_DIR) { $env:ATK_STATUS_DIR } else { Join-Path $script:AtkRoot 'status' }
$script:Atk = @{
  Paths = @(); Verb = ''; Wave = $null; Filter = @(); DryRun = $false; GateOverride = ''; Once = $false; Timeout = 0
  RunId = ''; PlanId = ''; Plan8 = ''; Log = ''; Items = @(); Selected = @(); EventPath = ''
  Secrets = [System.Collections.Generic.List[string]]::new()
  TempFiles = [System.Collections.Generic.List[string]]::new()
  Locks = [System.Collections.Generic.List[object]]::new()
  Outcome = $null; ExitCode = 0; InMain = $false
}

# ---------------------------------------------------------------- logging

function Get-AtkNow { [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture) }

function Hide-AtkSecret {
  param([AllowEmptyString()] [string] $Text)
  foreach ($s in $script:Atk.Secrets) { if ($s) { $Text = $Text.Replace($s, '***') } }
  return $Text
}

function Write-AtkLog {
  param([Parameter(ValueFromRemainingArguments)] [string[]] $Message)
  $text = Hide-AtkSecret ($Message -join ' ')
  [Console]::Error.WriteLine("atk: $text")
  if ($script:Atk.Log) { [System.IO.File]::AppendAllText($script:Atk.Log, (Get-AtkNow) + ' ' + $text + [char]10) }
}

function Clear-AtkTemp {
  foreach ($f in $script:Atk.TempFiles) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
  $script:Atk.TempFiles.Clear()
}

function Stop-Atk {
  param([int] $Code, [string] $Message)
  Write-AtkLog "error: $Message"
  if ($script:Atk.InMain) {
    $script:Atk.ExitCode = $Code
    throw [System.InvalidOperationException]::new("atk: $Message")
  }
  Clear-AtkTemp
  exit $Code
}

function Stop-AtkUsage {
  param([string] $Message)
  Write-AtkLog "usage: $Message"
  [Console]::Error.WriteLine($script:Usage)
  if ($script:Atk.InMain) { $script:Atk.ExitCode = ${EXIT_CODES.usage}; throw [System.InvalidOperationException]::new("atk: $Message") }
  exit ${EXIT_CODES.usage}
}

# ---------------------------------------------------------------- start-up

function Initialize-Atk {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string[]] $Path,
    [AllowEmptyString()] [string] $Verb = '',
    [int] $Wave = -1,
    [AllowEmptyCollection()] [string[]] $Item = @(),
    [switch] $DryRun,
    [AllowEmptyString()] [string] $GateOverride = '',
    [switch] $Once,
    [int] $Timeout = 0,
    [switch] $Tool
  )
  $script:Atk.Paths = @($Path | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
  if ($Tool) {
    $script:Atk.EventPath = $script:Atk.Paths[0]
  } else {
    if (-not $Verb) { Stop-AtkUsage 'a verb is needed' }
    if (-not $script:VerbStep.ContainsKey($Verb)) { Stop-AtkUsage "unknown verb: $Verb" }
  }
  if ($Timeout -lt 0) { Stop-AtkUsage '-Timeout needs minutes' }
  $script:Atk.Verb = $Verb
  $script:Atk.Wave = if ($Wave -ge 0) { $Wave } else { $null }
  $script:Atk.Filter = @($Item | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $script:Atk.DryRun = [bool] $DryRun
  $script:Atk.GateOverride = $GateOverride
  $script:Atk.Once = [bool] $Once
  $script:Atk.Timeout = $Timeout
  $script:Atk.RunId = if ($env:ATK_RUN_ID) { $env:ATK_RUN_ID } else { [System.Security.Cryptography.RandomNumberGenerator]::GetHexString(16, $true) }
  $env:ATK_RUN_ID = $script:Atk.RunId
  foreach ($d in 'logs', 'ids', 'gates') { $null = New-Item -ItemType Directory -Force -Path (Join-Path $script:AtkStatus $d) }
  $script:Atk.Log = Join-Path $script:AtkStatus "logs/$($script:Atk.RunId).log"
  $manifest = Join-Path $script:AtkHome 'manifest/items.json'
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { Stop-Atk 1 'the manifest (manifest/items.json) is missing: regenerate the kit' }
  $m = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  $script:Atk.PlanId = [string] $m.planId
  $script:Atk.Plan8 = [string] $m.planId8
  $script:Atk.Items = @($m.items)
  if (-not $script:Atk.PlanId) { Stop-Atk 1 'the manifest has no plan id: regenerate the kit' }
}

function Get-AtkItems {
  $hit = @{}
  $selected = foreach ($it in $script:Atk.Items) {
    if ($script:Atk.Paths -notcontains $it.path) { continue }
    if ($null -ne $script:Atk.Wave -and $it.wave -ne $script:Atk.Wave) { continue }
    if ($script:Atk.Filter.Count -gt 0) {
      $matched = $false
      foreach ($f in $script:Atk.Filter) { if ($f -ceq $it.id -or $f -ieq $it.name) { $matched = $true; $hit[$f] = $true } }
      if (-not $matched) { continue }
    }
    $it.id
  }
  foreach ($f in $script:Atk.Filter) { if (-not $hit.ContainsKey($f)) { Stop-AtkUsage "no item '$f' on this path" } }
  $script:Atk.Selected = @($selected)
  return $script:Atk.Selected
}

function Get-AtkItem {
  param([Parameter(Mandatory)] [string] $Id)
  $it = $script:Atk.Items | Where-Object { $_.id -ceq $Id } | Select-Object -First 1
  if (-not $it) { Stop-Atk 1 "no item $Id in the manifest" }
  return $it
}

function Get-AtkName {
  param([Parameter(Mandatory)] [string] $Id)
  return [string] (Get-AtkItem -Id $Id).resource
}

function Assert-AtkTool {
  param([string[]] $Command = @(), [string[]] $Module = @())
  $missing = @()
  foreach ($c in $Command) { if (-not (Get-Command -Name $c -ErrorAction SilentlyContinue)) { $missing += $c } }
  foreach ($n in $Module) { if (-not (Get-Module -ListAvailable -Name $n)) { $missing += "module $n" } }
  if ($missing.Count) { Stop-Atk ${EXIT_CODES.missing} "missing on the controller: $($missing -join ', ') (run controller-check.sh)" }
}

# ---------------------------------------------------------------- secrets and runtime files

function Get-AtkSecret {
  param([Parameter(Mandatory)] [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]*$')] [string] $Name)
  $fileVar = "$($Name)_FILE"
  $value = [Environment]::GetEnvironmentVariable($Name)
  if (-not $value) {
    $file = [Environment]::GetEnvironmentVariable($fileVar)
    if ($file) {
      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Stop-Atk ${EXIT_CODES.missing} "$fileVar names a file that cannot be opened" }
      if (-not $IsWindows) {
        $mode = [int] [System.IO.File]::GetUnixFileMode($file)
        if ($mode -band 63) { Stop-Atk ${EXIT_CODES.missing} "$fileVar must be readable by its owner only (mode 600)" }
      }
      $value = ([System.IO.File]::ReadAllText($file)).TrimEnd([char]13, [char]10)
    } elseif ($env:ATK_VAULT_CMD) {
      $cmd = if ($env:ATK_VAULT_CMD.Contains('%s')) { $env:ATK_VAULT_CMD.Replace('%s', $Name) } else { "$($env:ATK_VAULT_CMD) $Name" }
      $out = if ($IsWindows) { & pwsh -NoProfile -NonInteractive -Command $cmd } else { & sh -c $cmd }
      if ($LASTEXITCODE -ne 0) { Stop-Atk ${EXIT_CODES.missing} "ATK_VAULT_CMD failed for $Name" }
      $value = (@($out) -join [char]10).TrimEnd([char]13, [char]10)
    }
  }
  if (-not $value) { Stop-Atk ${EXIT_CODES.missing} "credential $Name is not set: set $Name, or $fileVar (mode 600), or ATK_VAULT_CMD" }
  foreach ($line in ($value -split [char]10)) { if ($line.Length -ge 4) { $script:Atk.Secrets.Add($line) } }
  return $value
}

function New-AtkTempFile {
  $dir = @($env:XDG_RUNTIME_DIR, '/dev/shm', [System.IO.Path]::GetTempPath()) |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -First 1
  $file = Join-Path $dir ('atk.' + [System.IO.Path]::GetRandomFileName())
  [System.IO.File]::WriteAllText($file, '')
  if (-not $IsWindows) { [System.IO.File]::SetUnixFileMode($file, [System.IO.UnixFileMode] 'UserRead, UserWrite') }
  $script:Atk.TempFiles.Add($file)
  return $file
}

# ---------------------------------------------------------------- events

function Add-AtkLine {
  param([string] $File, [string] $Line)
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $lock = $null
  while (-not $lock) {
    try { $lock = [System.IO.File]::Open("$File.lock", 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [System.IO.IOException] {
      if ([DateTime]::UtcNow -gt $deadline) { Stop-Atk 1 'could not lock the events file' }
      Start-Sleep -Milliseconds 100
    }
  }
  try { [System.IO.File]::AppendAllText($File, $Line + [char]10) } finally { $lock.Dispose() }
}

function Get-AtkScrubbed {
  param([AllowEmptyString()] [string] $Text)
  $t = $Text -replace '[\r\n]+', ' '
  foreach ($pair in @(@($script:AtkRoot, '.'), @($HOME, '~'), @([Environment]::MachineName, 'host'), @([Environment]::UserName, 'user'))) {
    if ($pair[0] -and $pair[0].Length -gt 2) { $t = $t.Replace($pair[0], $pair[1]) }
  }
  $t = Hide-AtkSecret $t
  if ($t.Length -gt 500) { $t = $t.Substring(0, 500) }
  return $t
}

function Write-AtkEvent {
  param(
    [AllowEmptyString()] [string] $Item = '',
    [Parameter(Mandatory)] [string] $Step,
    [Parameter(Mandatory)] [string] $Outcome,
    [AllowEmptyString()] [string] $State = '',
    [AllowEmptyString()] [string] $Detail = '',
    [hashtable] $Data = @{}
  )
  if ($script:StepList -notcontains $Step) { Stop-Atk 1 "Write-AtkEvent: unknown step $Step" }
  if ($script:OutcomeList -notcontains $Outcome) { Stop-Atk 1 "Write-AtkEvent: unknown outcome $Outcome" }
  if ($State -and $script:StateList -notcontains $State) { Stop-Atk 1 "Write-AtkEvent: unknown state $State" }
  $it = if ($Item) { $script:Atk.Items | Where-Object { $_.id -ceq $Item } | Select-Object -First 1 } else { $null }
  $path = if ($script:Atk.EventPath) { $script:Atk.EventPath } elseif ($it) { [string] $it.path } else { $script:Atk.Paths[0] }
  $wave = if ($null -ne $script:Atk.Wave) { [int] $script:Atk.Wave } elseif ($it -and $null -ne $it.wave) { [int] $it.wave } else { $null }
  $e = [ordered]@{ kind = 'archtoolkit.migration-status'; v = 1; planId = $script:Atk.PlanId; runId = $script:Atk.RunId; at = (Get-AtkNow); wave = $wave }
  $e.item = if ($Item) { $Item } else { $null }
  if ($it -and $it.name) { $e.name = [string] $it.name }
  $e.path = $path
  $e.step = $Step
  $e.outcome = $Outcome
  $e.dryRun = [bool] $script:Atk.DryRun
  if ($State) { $e.state = $State }
  if ($Detail) { $e.detail = Get-AtkScrubbed $Detail }
  $d = [ordered]@{}
  foreach ($k in @($Data.Keys | Sort-Object)) {
    $v = $Data[$k]
    if ($v -is [bool] -or $v -is [int] -or $v -is [long] -or $v -is [double]) { $d[$k] = $v } else { $d[$k] = Get-AtkScrubbed ([string] $v) }
  }
  if ($script:Atk.Verb -eq 'status' -and $Step -eq 'replicate') { $d['poll'] = $true }
  if ($d.Count) { $e.data = $d }
  $e.source = 'script'
  Add-AtkLine -File (Join-Path $script:AtkStatus 'events.jsonl') -Line ($e | ConvertTo-Json -Compress -Depth 5)
  $who = if ($Item) { $Item } else { '-' }
  Write-AtkLog "$who $Step $Outcome$(if ($State) { " ($State)" })$(if ($Detail) { ": $Detail" })"
}

function Set-AtkOutcome {
  param(
    [Parameter(Mandatory, Position = 0)] [ValidateSet('succeeded', 'skipped', 'failed')] [string] $Outcome,
    [Parameter(Position = 1)] [AllowEmptyString()] [string] $Detail = '',
    [AllowEmptyString()] [string] $State = '',
    [hashtable] $Data = @{}
  )
  $script:Atk.Outcome = @{ Outcome = $Outcome; Detail = $Detail; State = $State; Data = $Data }
}

# ---------------------------------------------------------------- running things

function Invoke-AtkStep {
  param([Parameter(Mandatory, Position = 0)] [string] $Description, [Parameter(Mandatory, Position = 1)] [scriptblock] $ScriptBlock)
  $shown = Hide-AtkSecret $Description
  if ($script:Atk.DryRun) { Write-AtkLog "dry-run, not run: $shown"; return }
  Write-AtkLog "run: $shown"
  & $ScriptBlock
}

function Invoke-AtkRetry {
  param(
    [int] $Attempts = 3, [int] $DelaySeconds = 10,
    [Parameter(Mandatory, Position = 0)] [string] $Description, [Parameter(Mandatory, Position = 1)] [scriptblock] $ScriptBlock
  )
  for ($i = 1; $i -le $Attempts; $i++) {
    try { return (Invoke-AtkStep $Description $ScriptBlock) }
    catch {
      if ($i -ge $Attempts) { throw }
      Write-AtkLog "attempt $i of $Attempts failed: $(Hide-AtkSecret $_.Exception.Message); trying again"
      Start-Sleep -Seconds ($DelaySeconds * $i)
    }
  }
}

function Wait-AtkUntil {
  param([int] $Minutes = 60, [int] $IntervalSeconds = 30, [Parameter(Mandatory, Position = 0)] [scriptblock] $Condition)
  if ($script:Atk.Timeout -gt 0) { $Minutes = $script:Atk.Timeout }
  if (& $Condition) { return $true }
  if ($script:Atk.DryRun) { Write-AtkLog 'dry-run, not waiting'; return $true }
  if ($script:Atk.Once) { return $false }
  $deadline = [DateTime]::UtcNow.AddMinutes($Minutes)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Seconds $IntervalSeconds
    if (& $Condition) { return $true }
  }
  Write-AtkLog "gave up after $Minutes minutes"
  return $false
}

function Enter-AtkLock {
  param([Parameter(Mandatory)] [string] $Name)
  $file = Join-Path $script:AtkStatus ".lock-$Name"
  try { $fs = [System.IO.File]::Open($file, 'OpenOrCreate', 'ReadWrite', 'None') }
  catch { Stop-Atk 1 "another run holds the lock $Name" }
  $script:Atk.Locks.Add($fs)
}

function Assert-AtkGate {
  param([Parameter(Mandatory)] [ValidateSet('G1', 'G2', 'G3', 'G4', 'G5')] [string] $Gate)
  $wave = $script:Atk.Wave
  if ($null -eq $wave) { Stop-AtkUsage "gate $Gate needs -Wave" }
  $saved = $script:Atk.EventPath
  $script:Atk.EventPath = 'gate'
  try {
    foreach ($name in @($Gate, $script:GateAlias[$Gate])) {
      $file = Join-Path $script:AtkStatus "gates/wave-$wave-$name.json"
      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
      $g = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
      if ($g.decision -eq 'go' -and $g.planId -eq $script:Atk.PlanId) {
        Write-AtkEvent -Step gate -Outcome succeeded -Detail "$Gate is open" -Data @{ gate = $Gate }
        return
      }
    }
    if ($script:Atk.GateOverride) {
      Write-AtkEvent -Step gate -Outcome succeeded -Detail "$Gate overridden: $($script:Atk.GateOverride)" -Data @{ gate = $Gate; override = $true }
      return
    }
    Write-AtkEvent -Step gate -Outcome failed -Detail "$Gate is not open" -Data @{ gate = $Gate }
  } finally { $script:Atk.EventPath = $saved }
  Stop-Atk ${EXIT_CODES.gate} "gate $Gate is not open for wave $($wave): record the decision in the tracker and export the gate file, or pass -GateOverride '<reason>'"
}

function Get-AtkId {
  param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [string] $Key)
  $file = Join-Path $script:AtkStatus "ids/$Path.json"
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  $h = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json -AsHashtable
  return $h[$Key]
}

function Set-AtkId {
  param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [string] $Key, [Parameter(Mandatory)] [string] $Value)
  if ($script:Atk.DryRun) { return }
  $file = Join-Path $script:AtkStatus "ids/$Path.json"
  $h = if (Test-Path -LiteralPath $file -PathType Leaf) { Get-Content -LiteralPath $file -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
  $h[$Key] = $Value
  [System.IO.File]::WriteAllText($file, ($h | ConvertTo-Json -Depth 3) + [char]10)
}

# ---------------------------------------------------------------- the verb dispatcher

function Invoke-AtkMain {
  param([Parameter(Mandatory)] [hashtable] $Verbs)
  $verb = $script:Atk.Verb
  if (-not $Verbs.ContainsKey($verb)) { Stop-AtkUsage "this script has no $verb verb" }
  $block = $Verbs[$verb]
  $step = $script:VerbStep[$verb]
  $ids = @(Get-AtkItems)
  if ($ids.Count -eq 0) {
    Write-AtkEvent -Step $step -Outcome started
    Write-AtkEvent -Step $step -Outcome skipped -Detail 'no items on this path in the selection'
    Clear-AtkTemp
    exit 0
  }
  $ok = 0; $failed = 0; $stop = 0
  foreach ($id in $ids) {
    Write-AtkEvent -Item $id -Step $step -Outcome started
    $script:Atk.Outcome = $null
    $script:Atk.ExitCode = 0
    $script:Atk.InMain = $true
    try {
      $null = & $block $id
      $script:Atk.InMain = $false
      $o = $script:Atk.Outcome
      if ($o) {
        Write-AtkEvent -Item $id -Step $step -Outcome $o.Outcome -State $o.State -Detail $o.Detail -Data $o.Data
        if ($o.Outcome -eq 'failed') { $failed++ } else { $ok++ }
      } else {
        Write-AtkEvent -Item $id -Step $step -Outcome succeeded
        $ok++
      }
    } catch {
      $script:Atk.InMain = $false
      $code = $script:Atk.ExitCode
      $message = if ($code) { "stopped with exit $code (see the run log)" } else { $_.Exception.Message }
      Write-AtkEvent -Item $id -Step $step -Outcome failed -Detail $message
      if ($code -in ${EXIT_CODES.usage}, ${EXIT_CODES.missing}, ${EXIT_CODES.gate}, ${EXIT_CODES.precheck}) { $stop = $code; break }
      $failed++
    } finally {
      $script:Atk.InMain = $false
    }
  }
  Clear-AtkTemp
  if ($stop) { exit $stop }
  Write-AtkLog "$($verb): $ok done, $failed failed"
  if ($failed) { exit ${EXIT_CODES.partial} }
  exit 0
}

Export-ModuleMember -Function @(
  'Initialize-Atk', 'Invoke-AtkMain', 'Get-AtkItems', 'Get-AtkItem', 'Get-AtkName', 'Invoke-AtkStep', 'Invoke-AtkRetry',
  'Wait-AtkUntil', 'Get-AtkSecret', 'Write-AtkEvent', 'Set-AtkOutcome', 'Enter-AtkLock', 'Assert-AtkGate', 'Assert-AtkTool',
  'Get-AtkId', 'Set-AtkId', 'New-AtkTempFile', 'Write-AtkLog', 'Hide-AtkSecret', 'Get-AtkNow', 'Stop-Atk'
)
`;
}

// ---------------------------------------------------------------------------
// The script skeleton path generators use
// ---------------------------------------------------------------------------

export interface PsScriptSpec {
  /** Where the script goes, relative to `migration/execute/` (e.g. 'paths/hcx/hcx.ps1'). */
  readonly file: string;
  readonly paths: readonly ExecPath[];
  readonly summary: string;
  /** Commands and modules checked when it starts (exit 3 naming the missing ones). */
  readonly commands?: readonly string[];
  readonly modules?: readonly string[];
  /** Shared helper functions (PowerShell), placed before the verbs. */
  readonly functions?: string;
  /** Each verb's body; `$Id` is the item id. Every verb is required, `rollback` included. */
  readonly verbs: Readonly<Record<Verb, string>>;
}

const indent = (text: string, by: string): string => text.split('\n').map((l) => (l.trim() ? by + l : '')).join('\n');

/** A contract-keeping PowerShell path script: parameters, the library, one script block per verb, `Invoke-AtkMain`. */
export function psScript(spec: PsScriptSpec): string {
  const lib = libPathFrom(spec.file, 'Atk.psm1');
  const verbs = VERBS.map((v) => `  '${v}' = {\n    param($Id)\n${indent(spec.verbs[v].trim() || '$null = $Id', '    ')}\n  }`).join('\n');
  const tools = [
    spec.commands?.length ? `-Command ${psList(spec.commands)}` : '',
    spec.modules?.length ? `-Module ${psList(spec.modules)}` : '',
  ].filter(Boolean).join(' ');
  return code`#Requires -Version 7.4
<#
.SYNOPSIS
  ${spec.summary}
.DESCRIPTION
  Paths: ${spec.paths.join(', ')}. Verbs: ${VERBS.join(' ')}.
  Changes are made by default; -DryRun logs each change instead. See ../../README.md.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string] $Verb = '',
  [int] $Wave = -1,
  [string[]] $Item = @(),
  [switch] $DryRun,
  [string] $GateOverride = '',
  [switch] $Once,
  [int] $Timeout = 0
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '${lib}') -Force
Initialize-Atk -Path ${psList(spec.paths)} -Verb $Verb -Wave $Wave -Item $Item -DryRun:$DryRun -GateOverride $GateOverride -Once:$Once -Timeout $Timeout
${tools ? `Assert-AtkTool ${tools}\n` : ''}${spec.functions ? `\n${spec.functions.trim()}\n` : ''}
$Verbs = @{
${verbs}
}

Invoke-AtkMain -Verbs $Verbs
`;
}
