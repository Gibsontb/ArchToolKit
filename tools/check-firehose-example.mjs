/** Generated sender regression with local mocks; no AWS executable is invoked. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_FIREHOSE_SERVICE } from '../src/cloud/aws-firehose-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'firehose-example-test-'));
for (const source of ['DIRECT', 'KINESIS']) {
  const result = AWS_FIREHOSE_SERVICE.build({ ...defaultValues(AWS_FIREHOSE_SERVICE), aws_region: 'us-east-1', name: 'mock-delivery', source, role: 'arn:aws:iam::123456789012:role/FirehoseDelivery', bucket: 'application-delivery', prefix: 'events/', stream: 'arn:aws:kinesis:us-east-1:123456789012:stream/events' });
  if (result.findings.length) throw new Error('Invalid fixture.');
  writeFileSync(join(work, source + '.ps1'), result.files['SEND-EXAMPLE.ps1']);
  writeFileSync(join(work, source + '.json'), result.files['EXAMPLE-RECORDS.json']);
  writeFileSync(join(work, source + '-PREFLIGHT.ps1'), result.files['PREFLIGHT.ps1']);
}
writeFileSync(join(work, 'harness.ps1'), String.raw`$ErrorActionPreference = 'Stop'
function global:terraform { $global:LASTEXITCODE = 0; $global:reads++; $global:job | ConvertTo-Json -Compress }
function global:aws {
  $global:reads++; $request = @($args); $global:LASTEXITCODE = 0
  if ($request[0] -eq 'sts') { @{ Account = $(if ($global:case -eq 'account') { '000000000000' } else { '123456789012' }) } | ConvertTo-Json -Compress; return }
  if ($request[1] -eq 'describe-delivery-stream') {
    @{ DeliveryStreamDescription = @{
      DeliveryStreamStatus = $(if ($global:case -eq 'inactive') { 'CREATING' } else { 'ACTIVE' })
      DeliveryStreamARN = $global:job.arn
      DeliveryStreamType = $(if ($global:mode -eq 'DIRECT') { 'DirectPut' } else { 'KinesisStreamAsSource' })
      Destinations = @(@{ ExtendedS3DestinationDescription = @{ BucketARN = $global:job.bucket_arn; Prefix = $(if ($global:case -eq 'destination') { 'wrong/' } else { 'events/' }) } })
      KinesisStreamSourceDescription = @{ KinesisStreamARN = $global:job.source_arn }
    } } | ConvertTo-Json -Depth 8 -Compress; return
  }
  $service = if ($global:mode -eq 'DIRECT') { 'firehose' } else { 'kinesis' }
  $operation = if ($global:mode -eq 'DIRECT') { 'put-record-batch' } else { 'put-records' }
  if ($request[0] -ne $service -or $request[1] -ne $operation) { throw 'Incorrect producer operation.' }
  $global:sends++
  if ($global:case -eq 'api') { $global:LASTEXITCODE = 1; return '{}' }
  $rows = @(@{ RecordId = 'one' }, @{ RecordId = 'two' })
  if ($global:case -in @('partial', 'mismatch')) { $rows[1] = @{ ErrorCode = 'ServiceUnavailableException' } }
  if ($global:case -eq 'incomplete') { $rows = @($rows[0]) }
  $failed = if ($global:case -eq 'partial') { 1 } else { 0 }
  $(if ($global:mode -eq 'DIRECT') { @{ FailedPutCount = $failed; RequestResponses = $rows } } else { @{ FailedRecordCount = $failed; Records = $rows } }) | ConvertTo-Json -Depth 5 -Compress
}
foreach ($source in @('DIRECT', 'KINESIS')) {
  $global:mode = $source
  foreach ($scenario in @('inspect', 'valid', 'account', 'inactive', 'destination', 'partial', 'mismatch', 'incomplete', 'api', 'invalid-data')) {
    $global:case = $scenario; $global:sends = 0; $global:reads = 0
    $global:job = @{ name = 'mock-delivery'; account = '123456789012'; region = 'us-east-1'; arn = 'mock-stream'; source = $source; source_arn = 'arn:aws:kinesis:us-east-1:123456789012:stream/events'; bucket_arn = 'arn:aws:s3:::application-delivery'; prefix = 'events/' }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot ($source + '.json')) -Destination (Join-Path $PSScriptRoot 'EXAMPLE-RECORDS.json') -Force
    if ($scenario -eq 'invalid-data') { '[{"Data":"not-base64!","PartitionKey":"test"}]' | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'EXAMPLE-RECORDS.json') }
    $failure = $null
    try { if ($scenario -eq 'inspect') { $null = & (Join-Path $PSScriptRoot ($source + '.ps1')) 6>$null } else { $null = & (Join-Path $PSScriptRoot ($source + '.ps1')) -Send 6>$null } } catch { $failure = $_.Exception.Message }
    if ($scenario -in @('inspect', 'valid')) { if ($failure) { throw ('Valid case failed: ' + $failure) } } elseif (-not $failure) { throw ('Unsafe case accepted: ' + $scenario) }
    $expected = if ($scenario -in @('valid', 'partial', 'mismatch', 'incomplete', 'api')) { 1 } else { 0 }
    if ($global:sends -ne $expected) { throw ('Unexpected send count: ' + $scenario) }
    if ($scenario -eq 'inspect' -and $global:reads -ne 0) { throw 'Inspect performed external reads.' }
    if ($scenario -eq 'partial') { $failed = @(Get-Content -LiteralPath failed-record-indices.json -Raw | ConvertFrom-Json); if ($failed.Count -ne 1 -or $failed[0] -ne 1) { throw 'Incorrect failure indices.' } }
  }
}
Write-Output 'Passed 20 mocked sender cases; no AWS executable or network requests.'
function global:aws {
  $request = @($args); $global:LASTEXITCODE = 0
  if ($request[0] -eq 'sts') { @{ Account = $(if ($global:case -eq 'account') { '000000000000' } else { '123456789012' }) } | ConvertTo-Json -Compress; return }
  if ($request[0] -ne 's3api' -or $request -notcontains '--expected-bucket-owner' -or $request -notcontains '123456789012') { throw 'Unscoped metadata request.' }
  if ($request[1] -eq 'head-bucket') { if ($global:case -eq 'owner') { $global:LASTEXITCODE = 1 }; return }
  if ($request[1] -eq 'get-public-access-block') {
    @{ PublicAccessBlockConfiguration = @{ BlockPublicAcls = $true; IgnorePublicAcls = $true; BlockPublicPolicy = $true; RestrictPublicBuckets = ($global:case -ne 'public') } } | ConvertTo-Json -Compress; return
  }
  if ($request[1] -eq 'get-bucket-encryption') {
    @{ ServerSideEncryptionConfiguration = @{ Rules = @(@{ ApplyServerSideEncryptionByDefault = @{ SSEAlgorithm = $(if ($global:case -eq 'kms') { 'aws:kms' } else { 'AES256' }) } }) } } | ConvertTo-Json -Depth 6 -Compress; return
  }
  throw 'Unexpected metadata operation.'
}
foreach ($scenario in @('valid', 'account', 'owner', 'public', 'kms')) {
  $global:case = $scenario; $failure = $null
  try { $null = & (Join-Path $PSScriptRoot 'DIRECT-PREFLIGHT.ps1') 6>$null } catch { $failure = $_.Exception.Message }
  if ($scenario -eq 'valid') { if ($failure) { throw ('Valid metadata failed: ' + $failure) } } elseif (-not $failure) { throw ('Unsafe metadata accepted: ' + $scenario) }
}
Write-Output 'Passed five bucket metadata cases; no cloud commands executed.'
`);
const executable = process.env.POWERSHELL_PATH || join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const check = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'harness.ps1')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);
if (check.error) throw check.error;
if (check.status !== 0) throw new Error('Firehose mock checks failed: ' + work);
console.log('Mock artifacts: ' + work);
