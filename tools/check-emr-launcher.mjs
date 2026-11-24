/** Exercise generated job submission with local AWS/Terraform functions only. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_EMR_SERVERLESS_SERVICE } from '../src/cloud/aws-emr-serverless-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'emr-launcher-test-'));
const result = AWS_EMR_SERVERLESS_SERVICE.build({ ...defaultValues(AWS_EMR_SERVERLESS_SERVICE), aws_region: 'us-east-1', name: 'mock-spark', role: 'arn:aws:iam::123456789012:role/EmrExecution', script: 's3://application-artifacts/scripts/example.py' });
if (result.findings.length) throw new Error('Invalid EMR launcher fixture.');
writeFileSync(join(work, 'START.ps1'), result.files['START.ps1']);
writeFileSync(join(work, 'harness.ps1'), String.raw`$ErrorActionPreference = 'Stop'
function global:terraform {
  $global:LASTEXITCODE = 0
  if (($args -join ' ') -eq 'output -json start_job_request') {
    @{ applicationId = 'app-123'; executionRoleArn = $(if ($global:case -eq 'state-role') { 'wrong' } else { 'arn:aws:iam::123456789012:role/EmrExecution' }); name = 'mock-spark-job'; jobDriver = @{ sparkSubmit = @{ entryPoint = 's3://application-artifacts/scripts/example.py' } } } | ConvertTo-Json -Depth 8 -Compress
  } elseif (($args -join ' ') -eq 'output -json application_metadata') {
    @{ arn = 'mock-application'; account = '123456789012'; region = 'us-east-1'; name = 'mock-spark' } | ConvertTo-Json -Compress
  } else { throw 'Unexpected state query.' }
}
function global:aws {
  $global:reads++; $request = @($args); $global:LASTEXITCODE = 0
  if ($request[0] -eq 'sts') { @{ Account = $(if ($global:case -eq 'account') { '000000000000' } else { '123456789012' }) } | ConvertTo-Json -Compress; return }
  if ($request -notcontains 'us-east-1') { throw 'Unscoped regional request.' }
  if ($request[0] -eq 's3api') {
    if ($request -notcontains '--expected-bucket-owner' -or $request -notcontains '123456789012' -or $request -notcontains 'application-artifacts') { throw 'Unscoped object metadata request.' }
    if ($request[1] -eq 'get-public-access-block') { @{ PublicAccessBlockConfiguration = @{ BlockPublicAcls = $true; IgnorePublicAcls = $true; BlockPublicPolicy = $true; RestrictPublicBuckets = ($global:case -ne 'public') } } | ConvertTo-Json -Compress; return }
    if ($request[1] -ne 'head-object' -or $request -notcontains 'scripts/example.py') { throw 'Unexpected object request.' }
    if ($global:case -eq 'head-error') { $global:LASTEXITCODE = 1; return '{}' }
    if ($global:case -eq 'kms') { @{ ServerSideEncryption = 'aws:kms'; SSEKMSKeyId = 'unexpected-key' } | ConvertTo-Json -Compress } else { '{"ServerSideEncryption":"AES256"}' }
    return
  }
  if ($request[0] -ne 'emr-serverless') { throw 'Unexpected AWS service.' }
  if ($request[1] -eq 'get-application') {
    if ($request -notcontains 'app-123') { throw 'Unexpected application query.' }
    @{ application = @{ arn = $(if ($global:case -eq 'application') { 'wrong-app' } else { 'mock-application' }); name = 'mock-spark'; releaseLabel = $(if ($global:case -eq 'release') { 'emr-0.0.0' } else { 'emr-7.8.0' }); type = $(if ($global:case -eq 'type') { 'HIVE' } else { 'SPARK' }); state = $(if ($global:case -eq 'state') { 'CREATING' } else { 'CREATED' }) } } | ConvertTo-Json -Depth 5 -Compress; return
  }
  if ($request[1] -ne 'start-job-run') { throw 'Unexpected EMR operation.' }
  $global:starts++
  $index = [Array]::IndexOf($request, '--cli-input-json')
  if ($index -lt 0 -or -not $request[$index + 1].StartsWith('file://')) { throw 'Missing exact request file.' }
  $path = $request[$index + 1].Substring(7)
  $job = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if ($job.applicationId -ne 'app-123' -or $job.executionRoleArn -ne 'arn:aws:iam::123456789012:role/EmrExecution' -or -not $job.clientToken) { throw 'Incorrect serialized job request.' }
  if ($global:case -eq 'submit-error') { $global:LASTEXITCODE = 1; return '{}' }
  if ($global:case -eq 'missing-id') { return '{}' }
  '{"jobRunId":"job-123","applicationId":"app-123"}'
}
foreach ($scenario in @('preview','valid','state-role','account','application','release','type','state','public','kms','head-error','submit-error','missing-id')) {
  $global:case = $scenario; $global:starts = 0; $global:reads = 0; $failure = $null
  try { if ($scenario -eq 'preview') { $null = & (Join-Path $PSScriptRoot 'START.ps1') 6>$null } else { $null = & (Join-Path $PSScriptRoot 'START.ps1') -Start 6>$null } } catch { $failure = $_.Exception.Message }
  if ($scenario -in @('preview','valid')) { if ($failure) { throw ('Valid launcher case failed: ' + $failure) } } elseif (-not $failure) { throw ('Unsafe launcher case accepted: ' + $scenario) }
  $expected = if ($scenario -in @('valid','submit-error','missing-id')) { 1 } else { 0 }
  if ($global:starts -ne $expected) { throw ('Unexpected submission count: ' + $scenario) }
  if ($scenario -eq 'preview' -and $global:reads -ne 0) { throw 'Preview called AWS.' }
}
Write-Output 'Passed 13 local EMR launcher cases; no AWS executable or Spark job was run.'
`);
const executable = process.env.POWERSHELL_PATH || join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const check = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'harness.ps1')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);
if (check.error) throw check.error;
if (check.status !== 0) throw new Error('EMR launcher mock checks failed: ' + work);
console.log('Mock artifacts: ' + work);
