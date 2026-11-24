/** Run generated patch scripts with local PowerShell functions only; never invokes SSM. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_SSM_PATCHING_SERVICE as blueprint } from '../src/cloud/aws-ssm-patching-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'ssm-patching-test-'));
const fixtures = [];
for (const os of ['WINDOWS', 'AMAZON_LINUX_2', 'AMAZON_LINUX_2023', 'REDHAT_ENTERPRISE_LINUX']) {
  const operation = os === 'WINDOWS' ? 'Install' : 'Scan';
  const result = blueprint.build({ ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'application-patching', group: 'application-pilot', role: 'arn:aws:iam::123456789012:role/PatchWindow', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', os, operation });
  if (result.findings.length) throw new Error('Invalid patch fixture');
  const file = join(work, os + '.ps1'), preflight = join(work, os + '-preflight.ps1');
  writeFileSync(file, result.files['OPERATE.ps1']); writeFileSync(preflight, result.files['PREFLIGHT.ps1']);
  fixtures.push({ os, operation, file, preflight, type: os === 'WINDOWS' ? 'Windows' : 'Linux', platform: os === 'WINDOWS' ? 'Microsoft Windows Server 2022' : os === 'REDHAT_ENTERPRISE_LINUX' ? 'Red Hat Enterprise Linux' : 'Amazon Linux', version: os === 'AMAZON_LINUX_2' ? '2' : os === 'AMAZON_LINUX_2023' ? '2023.6' : '9' });
}
writeFileSync(join(work, 'fixtures.json'), JSON.stringify(fixtures));
writeFileSync(join(work, 'harness.ps1'), [
  "$ErrorActionPreference = 'Stop'",
  'function global:terraform { $global:LASTEXITCODE = 0; @{ account = "123456789012"; region = $(if ($global:case -eq "placement") { "us-west-2" } else { "us-east-1" }); baseline = "pb-mock"; window = "mw-mock" } | ConvertTo-Json -Compress }',
  'function global:aws {',
  '  $request = @($args); $global:LASTEXITCODE = 0',
  '  if ($request[0] -eq "sts") { @{ Account = $(if ($global:case -eq "account") { "000000000000" } else { "123456789012" }) } | ConvertTo-Json -Compress; return }',
  '  if ($request[0] -notin @("ssm", "ec2") -or $request -notcontains "us-east-1") { throw "Unexpected service/region" }',
  '  switch ($request[1]) {',
  '    "describe-patch-groups" {',
  '      $mappings = if ($global:case -eq "existing-group") { @(@{ PatchGroup = "application-pilot"; BaselineIdentity = @{ OperatingSystem = $global:spec.os } }) } else { @() }',
  '      @{ Mappings = $mappings } | ConvertTo-Json -Depth 6 -Compress',
  '    }',
  '    "get-patch-baseline-for-patch-group" { @{ BaselineId = $(if ($global:case -eq "mapping") { "other" } else { "pb-mock" }) } | ConvertTo-Json -Compress }',
  '    "get-patch-baseline" {',
  '      $classification = if ($global:spec.os -eq "WINDOWS") { @("SecurityUpdates", "CriticalUpdates") } else { @("Security") }',
  '      $severityKey = if ($global:spec.os -eq "WINDOWS") { "MSRC_SEVERITY" } else { "SEVERITY" }',
  '      $approved = @(); if ($global:case -eq "exceptions") { $approved = @("unexpected") }',
  '      $severity = if ($global:case -eq "filters") { @("Low") } else { @("Critical", "Important") }',
  '      @{ BaselineId = "pb-mock"; Name = $(if ($global:case -eq "baseline") { "other" } else { "application-patching" }); OperatingSystem = $global:spec.os; ApprovedPatches = $approved; ApprovalRules = @{ PatchRules = @(@{ ApproveAfterDays = $(if ($global:case -eq "approval") { 0 } else { 7 }); ComplianceLevel = "HIGH"; EnableNonSecurity = $false; PatchFilterGroup = @{ PatchFilters = @(@{ Key = "CLASSIFICATION"; Values = $classification }, @{ Key = $severityKey; Values = $severity }) } }) } } | ConvertTo-Json -Depth 12 -Compress',
  '    }',
  '    "describe-instance-information" {',
  '      if ($request -notcontains "Key=tag:PatchGroup,Values=application-pilot") { throw "Unscoped node lookup" }',
  '      $nodes = @(@{ InstanceId = $(if ($global:case -eq "hybrid") { "mi-0123456789abcdef0" } else { "i-0123456789abcdef0" }); PingStatus = $(if ($global:case -eq "offline") { "ConnectionLost" } else { "Online" }); PlatformType = $(if ($global:case -eq "os") { "Other" } else { $global:spec.type }); PlatformName = $global:spec.platform; PlatformVersion = $global:spec.version })',
  '      if ($global:case -eq "membership") { $nodes = @() }',
  '      @{ InstanceInformationList = $nodes } | ConvertTo-Json -Depth 5 -Compress',
  '    }',
  '    "describe-instances" {',
  '      $tags = @(@{ Key = "PatchGroup"; Value = $(if ($global:case -eq "tag-drift") { "other" } else { "application-pilot" }) }); if ($global:case -eq "conflict-tag") { $tags += @{ Key = "Patch Group"; Value = "other" } }',
  '      @{ Reservations = @(@{ Instances = @(@{ InstanceId = "i-0123456789abcdef0"; State = @{ Name = $(if ($global:case -eq "instance-state") { "stopped" } else { "running" }) }; Tags = $tags }) }) } | ConvertTo-Json -Depth 8 -Compress',
  '    }',
  '    "list-tags-for-resource" { if ($request -notcontains "ManagedInstance" -or $request -notcontains "mi-0123456789abcdef0") { throw "Unexpected hybrid tag query" }; @{ TagList = @(@{ Key = "PatchGroup"; Value = "application-pilot" }) } | ConvertTo-Json -Depth 5 -Compress }',
  '    "send-command" {',
  '      if ($env:AWS_MAX_ATTEMPTS -ne "1") { throw "Mutation retries were not disabled" }',
  '      $global:sent++; $index = [Array]::IndexOf($request, "--cli-input-json")',
  '      $body = Get-Content -LiteralPath $request[$index + 1].Substring(7) -Raw | ConvertFrom-Json',
  '      if (@($body.InstanceIds).Count -ne 1 -or $body.InstanceIds[0] -ne $(if ($global:case -eq "hybrid") { "mi-0123456789abcdef0" } else { "i-0123456789abcdef0" }) -or $body.Targets -or $body.DocumentName -ne "AWS-RunPatchBaseline" -or $body.Parameters.Operation[0] -ne $global:spec.operation -or $body.Parameters.RebootOption[0] -ne "NoReboot" -or $body.MaxConcurrency -ne "1" -or $body.MaxErrors -ne "1" -or $body.CloudWatchOutputConfig.CloudWatchLogGroupName -ne "/aws/ssm/application-patching") { throw "Unsafe/unexpected command scope" }',
  '      $null = [guid]::Parse($body.Parameters."Snapshot-ID"[0])',
  '      if ($global:case -eq "send-error") { $global:LASTEXITCODE = 1; return "{}" }',
  '      if ($global:case -eq "missing-command") { return "{}" }',
  '      @{ Command = @{ CommandId = "mock-command" } } | ConvertTo-Json -Compress',
  '    }',
  '    default { throw "Unexpected node/resource operation" }',
  '  }',
  '}',
  '$fixtures = Get-Content -LiteralPath (Join-Path $PSScriptRoot "fixtures.json") -Raw | ConvertFrom-Json',
  '$count = 0',
  '$env:AWS_MAX_ATTEMPTS = "7"',
  'foreach ($fixture in $fixtures) {',
  '  $global:spec = $fixture',
  '  foreach ($item in @("preview", "execute", "hybrid", "tag-drift", "conflict-tag", "instance-state", "placement", "account", "mapping", "baseline", "approval", "filters", "exceptions", "offline", "os", "membership", "invalid-id", "send-error", "missing-command", "no-install-confirm")) {',
  '    if ($item -eq "no-install-confirm" -and $fixture.operation -ne "Install") { continue }',
  '    $global:case = $item; $global:sent = 0; $failure = $null',
  '    $ids = if ($item -eq "invalid-id") { @("*") } elseif ($item -eq "hybrid") { @("mi-0123456789abcdef0") } else { @("i-0123456789abcdef0") }',
  '    try { & $fixture.file -InstanceIds $ids -Execute:($item -ne "preview") -ConfirmInstall:($item -ne "no-install-confirm") 6>$null | Out-Null } catch { $failure = $_.Exception.Message }',
  '    $good = $item -in @("preview", "execute", "hybrid")',
  '    if ([bool]$failure -eq $good) { throw ("Unexpected patch guard result: " + $fixture.os + "/" + $item + ": " + $failure) }',
  '    $expected = if ($item -in @("execute", "hybrid", "send-error", "missing-command")) { 1 } else { 0 }',
  '    if ($global:sent -ne $expected) { throw ("Unexpected send/retry count: " + $item) }',
  '    if ($env:AWS_MAX_ATTEMPTS -ne "7") { throw "Caller retry setting was not restored" }',
  '    if ($item -eq "no-install-confirm" -and $failure -notlike "*ConfirmInstall*") { throw "Missing install readiness gate" }',
  '    $count++',
  '  }',
  '  foreach ($item in @("valid", "account", "existing-group")) {',
  '    $global:case = $item; $global:sent = 0; $failure = $null',
  '    try { & $fixture.preflight 6>$null | Out-Null } catch { $failure = $_.Exception.Message }',
  '    if ([bool]$failure -eq ($item -eq "valid") -or $global:sent -ne 0) { throw ("Unexpected initial preflight: " + $item) }',
  '    $count++',
  '  }',
  '}',
  'Write-Host ("Passed " + $count + " local patch operator/preflight cases; no SSM commands, patches, node connections or reboots executed.")',
].join('\n'));
const run = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'harness.ps1')], { cwd: work, encoding: 'utf8', windowsHide: true, timeout: 60000 });
process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status || 1);
console.log(work);
