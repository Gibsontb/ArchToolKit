/** Generated stateful startup checks with local AWS/Terraform functions only. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_FLINK_SERVICE } from '../src/cloud/aws-flink-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'flink-operator-test-'));
const result = AWS_FLINK_SERVICE.build({ ...defaultValues(AWS_FLINK_SERVICE), aws_region: 'us-east-1', name: 'mock-flink', role: 'arn:aws:iam::123456789012:role/FlinkExecution', bucket: 'application-artifacts', key: 'flink/application.jar', object_version: 'approved-version-123' });
if (result.findings.length) throw new Error('Invalid Flink fixture.');
for (const name of ['OPERATE.ps1', 'PREFLIGHT.ps1']) writeFileSync(join(work, name), result.files[name]);
writeFileSync(join(work, 'harness.ps1'), String.raw`$ErrorActionPreference = 'Stop'
function global:terraform {
  if (($args -join ' ') -ne 'output -json flink_job') { throw 'Unexpected state query.' }
  $global:LASTEXITCODE = 0
  @{ name = 'mock-flink'; region = 'us-east-1'; account = '123456789012'; arn = 'mock-application'; runtime = 'FLINK-1_20'; role = 'arn:aws:iam::123456789012:role/FlinkExecution'; bucket = 'arn:aws:s3:::application-artifacts'; key = 'flink/application.jar'; object_version = 'approved-version-123' } | ConvertTo-Json -Compress
}
function global:aws {
  $request = @($args); $global:LASTEXITCODE = 0
  if ($request[0] -eq 'sts') { @{ Account = $(if ($global:case -eq 'account') { '000000000000' } else { '123456789012' }) } | ConvertTo-Json -Compress; return }
  if ($request -notcontains 'us-east-1') { throw 'Missing configured region.' }
  if ($request[0] -eq 's3api') {
    if ($request -notcontains '--expected-bucket-owner' -or $request -notcontains '123456789012') { throw 'Unscoped artifact metadata.' }
    if ($global:case -eq 'api') { $global:LASTEXITCODE = 1; return '{}' }
    if ($request[1] -eq 'get-public-access-block') { @{ PublicAccessBlockConfiguration = @{ BlockPublicAcls = $true; IgnorePublicAcls = $true; BlockPublicPolicy = $true; RestrictPublicBuckets = ($global:case -ne 'public') } } | ConvertTo-Json -Compress; return }
    if ($request[1] -ne 'head-object' -or $request -notcontains '--version-id' -or $request -notcontains 'approved-version-123') { throw 'Unpinned object request.' }
    @{ VersionId = $(if ($global:case -eq 'version') { 'unreviewed' } else { 'approved-version-123' }); ContentLength = $(if ($global:case -eq 'size') { 600000000 } else { 10000 }); ServerSideEncryption = $(if ($global:case -eq 'kms') { 'aws:kms' } else { 'AES256' }); SSEKMSKeyId = $(if ($global:case -eq 'kms') { 'other-key' } else { $null }) } | ConvertTo-Json -Compress; return
  }
  if ($request[0] -ne 'kinesisanalyticsv2' -or $request -notcontains 'mock-flink') { throw 'Unexpected application operation.' }
  switch ($request[1]) {
    'describe-application' {
      @{ ApplicationDetail = @{
        ApplicationARN = $(if ($global:case -eq 'application') { 'other-app' } else { 'mock-application' }); ApplicationName = 'mock-flink'; RuntimeEnvironment = 'FLINK-1_20'; ServiceExecutionRole = $(if ($global:case -eq 'role') { 'other-role' } else { 'arn:aws:iam::123456789012:role/FlinkExecution' }); ApplicationStatus = $(if ($global:case -eq 'not-ready') { 'RUNNING' } else { 'READY' }); ApplicationVersionId = 1
        ApplicationConfigurationDescription = @{ ApplicationCodeConfigurationDescription = @{ CodeContentDescription = @{ S3ApplicationCodeLocationDescription = @{ BucketARN = 'arn:aws:s3:::application-artifacts'; FileKey = 'flink/application.jar'; ObjectVersion = $(if ($global:case -eq 'artifact') { 'changed-version' } else { 'approved-version-123' }) } } } }
      } } | ConvertTo-Json -Depth 10 -Compress
    }
    'list-application-snapshots' {
      $snapshots = if ($global:case -eq 'empty') { @() } else { @(@{ SnapshotName = 'pilot-1'; SnapshotStatus = 'READY' }) }
      @{ SnapshotSummaries = $snapshots } | ConvertTo-Json -Depth 5 -Compress
    }
    'describe-application-snapshot' {
      if ($request -notcontains 'pilot-1') { throw 'Unexpected snapshot name.' }
      @{ SnapshotDetails = @{ SnapshotName = 'pilot-1'; SnapshotStatus = $(if ($global:case -eq 'snapshot-not-ready') { 'CREATING' } else { 'READY' }) } } | ConvertTo-Json -Depth 5 -Compress
    }
    'start-application' {
      $global:starts++
      $index = [Array]::IndexOf($request, '--run-configuration')
      $configuration = Get-Content -LiteralPath $request[$index + 1].Substring(7) -Raw | ConvertFrom-Json
      if ($configuration.FlinkRunConfiguration.AllowNonRestoredState -ne $false) { throw 'Non-restored operator state was permitted.' }
      $expected = if ($global:action -eq 'StartFresh') { 'SKIP_RESTORE_FROM_SNAPSHOT' } elseif ($global:action -eq 'StartSnapshot') { 'RESTORE_FROM_CUSTOM_SNAPSHOT' } else { 'RESTORE_FROM_LATEST_SNAPSHOT' }
      if ($configuration.ApplicationRestoreConfiguration.ApplicationRestoreType -ne $expected) { throw 'Wrong restore policy.' }
      if ($global:action -eq 'StartSnapshot' -and $configuration.ApplicationRestoreConfiguration.SnapshotName -ne 'pilot-1') { throw 'Snapshot identity lost.' }
      if ($global:case -eq 'start-error') { $global:LASTEXITCODE = 1 }; '{}'
    }
    default { throw 'Unexpected operation.' }
  }
}
$cases = @(
  @('inspect','Inspect'), @('fresh','StartFresh'), @('no-confirm','StartFresh'), @('latest','StartLatest'), @('empty','StartLatest'), @('named','StartSnapshot'), @('snapshot-not-ready','StartSnapshot'), @('bad-name','StartSnapshot'), @('not-ready','StartFresh'), @('account','StartFresh'), @('application','StartFresh'), @('artifact','StartFresh'), @('role','StartFresh'), @('start-error','StartFresh')
)
foreach ($row in $cases) {
  $global:case = $row[0]; $global:action = $row[1]; $global:starts = 0; $failure = $null
  $arguments = @{ Action = $global:action }
  if ($global:action -eq 'StartFresh' -and $global:case -ne 'no-confirm') { $arguments.ConfirmFresh = $true }
  if ($global:action -eq 'StartSnapshot') { $arguments.SnapshotName = $(if ($global:case -eq 'bad-name') { '*' } else { 'pilot-1' }) }
  try { $null = & (Join-Path $PSScriptRoot 'OPERATE.ps1') @arguments 6>$null } catch { $failure = $_.Exception.Message }
  if ($global:case -in @('inspect','fresh','latest','named')) { if ($failure) { throw ('Valid operator case failed: ' + $failure) } } elseif (-not $failure) { throw ('Unsafe case accepted: ' + $global:case) }
  $expected = if ($global:case -in @('fresh','latest','named','start-error')) { 1 } else { 0 }
  if ($global:starts -ne $expected) { throw ('Unexpected start count: ' + $global:case) }
}
Write-Output 'Passed 14 local Flink operator cases.'
foreach ($scenario in @('valid','public','version','size','kms','api')) {
  $global:case = $scenario; $failure = $null
  try { $null = & (Join-Path $PSScriptRoot 'PREFLIGHT.ps1') 6>$null } catch { $failure = $_.Exception.Message }
  if ($scenario -eq 'valid') { if ($failure) { throw ('Valid artifact rejected: ' + $failure) } } elseif (-not $failure) { throw ('Unsafe artifact accepted: ' + $scenario) }
}
Write-Output 'Passed six local artifact metadata cases; no AWS executable, Flink start or data processing.'
`);
const executable = process.env.POWERSHELL_PATH || join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const check = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'harness.ps1')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);
if (check.error) throw check.error;
if (check.status !== 0) throw new Error('Flink mock checks failed: ' + work);
console.log('Mock artifacts: ' + work);
