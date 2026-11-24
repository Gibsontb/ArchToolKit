/** Check generated MQ metadata preflight using local mocks only; no AWS process or credentials. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_MQ_SERVICE } from '../src/cloud/aws-mq-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'mq-preflight-test-'));
const result = AWS_MQ_SERVICE.build({ ...defaultValues(AWS_MQ_SERVICE), aws_region: 'us-east-1', name: 'mock-broker', version: '3.13', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1,subnet-0123456789abcdef2', clients: 'sg-0123456789abcdef0', admins: 'sg-0123456789abcdef1' });
if (result.findings.length) throw new Error('Invalid MQ preflight fixture.');
writeFileSync(join(work, 'PREFLIGHT.ps1'), result.files['PREFLIGHT.ps1']);
writeFileSync(join(work, 'harness.ps1'), String.raw`$ErrorActionPreference = 'Stop'
function global:aws {
  $request = @($args | ForEach-Object { $_ })
  if ($request[0] -ne 'mq') { throw 'Unexpected mock AWS service.' }
  $global:requestCount++
  $global:LASTEXITCODE = 0
  if ($global:case -eq 'api-error') { $global:LASTEXITCODE = 1; return '{}' }
  $nextIndex = [Array]::IndexOf($request, '--next-token')
  $secondPage = $nextIndex -ge 0
  if ($secondPage -and $request[$nextIndex + 1] -ne 'page-2') { throw 'Unexpected pagination token.' }
  if ($request[1] -eq 'describe-broker-engine-types') {
    $version = if ($global:case -eq 'bad-version' -or ($global:case -eq 'pagination' -and -not $secondPage)) { '0.0' } else { '3.13' }
    $response = @{ BrokerEngineTypes = @(@{ EngineType = 'RABBITMQ'; EngineVersions = @(@{ Name = $version }) }) }
  } elseif ($request[1] -eq 'describe-broker-instance-options') {
    $mode = if ($global:case -eq 'bad-mode' -or ($global:case -eq 'pagination' -and -not $secondPage)) { 'SINGLE_INSTANCE' } else { 'CLUSTER_MULTI_AZ' }
    $type = if ($global:case -eq 'bad-type') { 'mq.other.large' } else { 'mq.m7g.large' }
    $response = @{ BrokerInstanceOptions = @(@{ EngineType = 'RABBITMQ'; HostInstanceType = $type; SupportedEngineVersions = @('3.13'); SupportedDeploymentModes = @($mode); AvailabilityZones = @(@{ Name = 'us-east-1a' }) }) }
  } else { throw 'Unexpected mock AWS operation.' }
  if ($global:case -eq 'pagination' -and -not $secondPage) { $response.NextToken = 'page-2' }
  ConvertTo-Json -InputObject $response -Depth 8 -Compress
}
foreach ($testCase in @('valid', 'pagination', 'bad-version', 'bad-mode', 'bad-type', 'api-error')) {
  $global:case = $testCase
  $global:requestCount = 0
  $failure = $null
  try { $null = & (Join-Path $PSScriptRoot 'PREFLIGHT.ps1') 6>$null } catch { $failure = $_.Exception.Message }
  if ($testCase -in @('valid', 'pagination')) {
    if ($failure) { throw ('Valid metadata rejected: ' + $failure) }
    $expected = if ($testCase -eq 'pagination') { 4 } else { 2 }
    if ($global:requestCount -ne $expected) { throw 'Preflight skipped or duplicated metadata pages.' }
  } else {
    $pattern = if ($testCase -eq 'api-error') { '*Could not read regional*' } elseif ($testCase -eq 'bad-version') { '*version is not listed*' } else { '*not listed as compatible*' }
    if (-not $failure -or $failure -notlike $pattern) { throw ('Incorrect rejection for ' + $testCase + ': ' + $failure) }
  }
}
Write-Output 'Passed six mocked MQ metadata cases, including pagination and unsupported offerings; no cloud commands executed.'
`);
const executable = process.env.POWERSHELL_PATH || join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const check = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'harness.ps1')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
if (check.error) throw check.error;
if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);
if (check.status !== 0) throw new Error('MQ preflight mock checks failed: ' + work);
console.log('Mock artifacts: ' + work);
