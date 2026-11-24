/** Generated session helper contracts using local functions only, never SSM/plugin execution. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_SSM_SESSION_SERVICE as blueprint } from '../src/cloud/aws-ssm-session-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'ssm-session-test-'));
const fixtures = [];
for (const os of ['Linux', 'Windows']) {
  const result = blueprint.build({ ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'project-session', os, nodes: 'i-0123456789abcdef0,mi-0123456789abcdef1', operator: 'arn:aws:iam::123456789012:role/SessionOperator', node_roles: 'arn:aws:iam::123456789012:role/ManagedNodes', session_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', log_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abd' });
  if (result.findings.length) throw new Error('Invalid session fixture');
  const file = join(work, os + '.ps1'), document = join(work, os + '.json');
  writeFileSync(file, result.files['CONNECT.ps1']); writeFileSync(document, result.files['SESSION-DOCUMENT.json']);
  fixtures.push({ os, file, document });
}
writeFileSync(join(work, 'fixtures.json'), JSON.stringify(fixtures));
writeFileSync(join(work, 'harness.ps1'), [
  "$ErrorActionPreference = 'Stop'",
  'function global:terraform {',
  '  $global:LASTEXITCODE = 0',
  '  @{ account = "123456789012"; region = $(if ($global:case -eq "placement") { "us-west-2" } else { "us-east-1" }); document = $(if ($global:case -eq "document-name") { "other" } else { "project-session" }); operator_arn = $(if ($global:case -eq "operator-arn") { "other" } else { "arn:aws:iam::123456789012:role/SessionOperator" }); operator_id = "AROAMOCK" } | ConvertTo-Json -Compress',
  '}',
  'function global:aws {',
  '  $request = @($args); $global:LASTEXITCODE = 0',
  '  if ($request[0] -eq "sts") { @{ Account = $(if ($global:case -eq "account") { "000000000000" } else { "123456789012" }); UserId = $(if ($global:case -eq "operator-id") { "OTHER:operator-session" } else { "AROAMOCK:operator-session" }) } | ConvertTo-Json -Compress; return }',
  '  if ($request[0] -ne "ssm" -or $request -notcontains "us-east-1") { throw "Unexpected request" }',
  '  switch ($request[1]) {',
  '    "get-document" {',
  '      if ($request -notcontains "project-session" -or $request -notcontains "$DEFAULT") { throw "Unexpected document/version" }',
  '      if ($global:case -eq "api") { $global:LASTEXITCODE = 1; return "{}" }',
  '      $document = Get-Content -LiteralPath $global:spec.document -Raw | ConvertFrom-Json',
  '      switch ($global:case) {',
  '        "type" { $document.sessionType = "Port" }',
  '        "audit" { $document.inputs.cloudWatchStreamingEnabled = $false }',
  '        "log-group" { $document.inputs.cloudWatchLogGroupName = "other" }',
  '        "key" { $document.inputs.kmsKeyId = "other" }',
  '        "duration" { $document.inputs.maxSessionDuration = "1440" }',
  '        "identity" { $document.inputs.runAsDefaultUser = "root" }',
  '        "profile" { $document.inputs.shellProfile.linux = "unexpected command" }',
  '        "parameters" { $document | Add-Member -NotePropertyName parameters -NotePropertyValue @{ Override = @{ type = "String" } } }',
  '      }',
  '      @{ Name = "project-session"; Content = ($document | ConvertTo-Json -Depth 12 -Compress) } | ConvertTo-Json -Compress',
  '    }',
  '    "describe-instance-information" {',
  '      $target = if ($global:case -eq "hybrid") { "mi-0123456789abcdef1" } else { "i-0123456789abcdef0" }',
  '      if ($request -notcontains ("Key=InstanceIds,Values=" + $target)) { throw "Unexpected node lookup" }',
  '      @{ InstanceInformationList = @(@{ InstanceId = $(if ($global:case -eq "target") { "other" } else { $target }); PingStatus = $(if ($global:case -eq "offline") { "ConnectionLost" } else { "Online" }); PlatformType = $(if ($global:case -eq "os") { "Other" } else { $global:spec.os }) }) } | ConvertTo-Json -Depth 5 -Compress',
  '    }',
  '    "start-session" {',
  '      if ($env:AWS_MAX_ATTEMPTS -ne "1") { throw "Session retries were not disabled" }',
  '      $global:starts++',
  '      if ($request -notcontains "--document-name" -or $request -notcontains "project-session" -or $request -notcontains "--reason" -or $request -notcontains "CHG-12345") { throw "Missing explicit session document/reason" }',
  '      if ($global:case -eq "start-error") { $global:LASTEXITCODE = 1 }',
  '    }',
  '    default { throw "Unexpected session/resource operation" }',
  '  }',
  '}',
  '$fixtures = Get-Content -LiteralPath (Join-Path $PSScriptRoot "fixtures.json") -Raw | ConvertFrom-Json',
  '$count = 0',
  '$env:AWS_MAX_ATTEMPTS = "7"',
  'foreach ($fixture in $fixtures) {',
  '  $global:spec = $fixture',
  '  foreach ($item in @("preview", "connect", "hybrid", "outside", "placement", "account", "operator-arn", "operator-id", "document-name", "api", "type", "audit", "log-group", "key", "duration", "identity", "profile", "parameters", "target", "offline", "os", "start-error")) {',
  '    $global:case = $item; $global:starts = 0; $failure = $null',
  '    $target = if ($item -eq "outside") { "i-00000000000000000" } elseif ($item -eq "hybrid") { "mi-0123456789abcdef1" } else { "i-0123456789abcdef0" }',
  '    try { & $fixture.file -Target $target -Reason "CHG-12345" -Connect:($item -ne "preview") 6>$null | Out-Null } catch { $failure = $_.Exception.Message }',
  '    $good = $item -in @("preview", "connect", "hybrid")',
  '    if ([bool]$failure -eq $good) { throw ("Unexpected session guard: " + $fixture.os + "/" + $item + ": " + $failure) }',
  '    $expected = if ($item -in @("connect", "hybrid", "start-error")) { 1 } else { 0 }',
  '    if ($global:starts -ne $expected) { throw ("Unexpected session/retry count: " + $item) }',
  '    if ($env:AWS_MAX_ATTEMPTS -ne "7") { throw "Caller retry setting was not restored" }',
  '    $count++',
  '  }',
  '}',
  'Write-Host ("Passed " + $count + " local session helper cases; no SSM/plugin session, token or node connection.")',
].join('\n').replace('request -notcontains "$DEFAULT"', 'request -notcontains \'$DEFAULT\''));
const run = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'harness.ps1')], { cwd: work, encoding: 'utf8', windowsHide: true, timeout: 60000 });
process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status || 1);
console.log(work);
