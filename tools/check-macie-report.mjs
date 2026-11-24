/** Exercise the generated report script with local AWS/Terraform mocks. No network or cloud credentials. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_MACIE_SERVICE } from '../src/cloud/aws-macie-service.ts';
import { WORK_TMP } from './work.mjs';

const work = mkdtempSync(join(WORK_TMP, 'macie-report-test-'));
const result = AWS_MACIE_SERVICE.build({ ...defaultValues(AWS_MACIE_SERVICE), aws_region: 'us-east-1', name: 'report-test', account: '123456789012', buckets: 'example-records' });
if (result.findings.length) throw new Error('Report test fixture did not validate.');
writeFileSync(join(work, 'GET-REPORT.ps1'), result.files['GET-REPORT.ps1']);
writeFileSync(join(work, 'harness.ps1'), String.raw`$ErrorActionPreference = 'Stop'
# These functions deliberately intercept every external command used by the generated script.
# Unexpected commands fail instead of falling through to a real AWS/terraform executable.
function global:terraform {
  if (($args -join ' ') -ne 'output -raw job_id') { throw 'Unexpected Terraform mock request.' }
  $global:LASTEXITCODE = 0
  'mock-job'
}
function global:aws {
  $mockArguments = @($args | ForEach-Object { $_ })
  $global:LASTEXITCODE = 0
  if ($mockArguments[0] -eq 'sts' -and $mockArguments[1] -eq 'get-caller-identity') {
    @{ Account = $global:mockAccount } | ConvertTo-Json -Compress
    return
  }
  if ($mockArguments[0] -ne 'macie2') { throw 'Unexpected AWS mock service.' }
  switch ($mockArguments[1]) {
    'describe-classification-job' { @{ jobId = 'mock-job'; jobStatus = 'COMPLETE' } | ConvertTo-Json -Compress }
    'list-findings' {
      $criteriaIndex = [Array]::IndexOf($mockArguments, '--finding-criteria') + 1
      $criteriaPath = $mockArguments[$criteriaIndex].Substring(7)
      $criteria = Get-Content -LiteralPath $criteriaPath -Raw | ConvertFrom-Json
      if ($criteria.criterion.'classificationDetails.jobId'.eq[0] -ne 'mock-job') { throw 'Report query lost its job filter.' }
      if ($global:omitFindingIds) { '{}' } else { ConvertTo-Json -InputObject @{ findingIds = $global:mockFindingIds } -Depth 5 -Compress }
    }
    'get-findings' {
      $startIndex = [Array]::IndexOf($mockArguments, '--finding-ids') + 1
      $endIndex = [Array]::IndexOf($mockArguments, '--region') - 1
      $batchIds = @($mockArguments[$startIndex..$endIndex])
      if ($batchIds.Count -lt 1 -or $batchIds.Count -gt 50) { throw 'Invalid findings batch size.' }
      $global:batchSizes.Add($batchIds.Count)
      ConvertTo-Json -InputObject @{ findings = @($batchIds | ForEach-Object { @{ id = $_ } }) } -Depth 5 -Compress
    }
    default { throw 'Unexpected AWS mock operation.' }
  }
}
$cases = @(
  @{ count = 0; omit = $false }, @{ count = 0; omit = $true },
  @{ count = 1; omit = $false }, @{ count = 50; omit = $false },
  @{ count = 51; omit = $false }, @{ count = 137; omit = $false }
)
foreach ($caseIndex in 0..($cases.Count - 1)) {
  $case = $cases[$caseIndex]
  $caseDirectory = Join-Path $PSScriptRoot ('case-' + $caseIndex)
  $null = New-Item -ItemType Directory -Path $caseDirectory
  $global:mockAccount = '123456789012'
  $global:mockFindingIds = @()
  for ($findingIndex = 0; $findingIndex -lt $case.count; $findingIndex++) { $global:mockFindingIds += ('finding-' + $findingIndex) }
  $global:omitFindingIds = $case.omit
  $global:batchSizes = [System.Collections.Generic.List[int]]::new()
  Push-Location $caseDirectory
  try {
    $null = & (Join-Path $PSScriptRoot 'GET-REPORT.ps1') 6>$null
    $parsedReport = Get-Content -LiteralPath macie-findings.json -Raw | ConvertFrom-Json
    $actual = @($parsedReport)
    if ($actual.Count -ne $case.count) { throw 'Report lost or duplicated findings.' }
    if ($global:batchSizes.Count -ne [Math]::Ceiling($case.count / 50.0)) { throw 'Unexpected number of findings batches.' }
    if (@($actual.id | Select-Object -Unique).Count -ne $case.count -and $case.count -gt 0) { throw 'Duplicate report finding IDs.' }
    foreach ($finding in $actual) { if ($global:mockFindingIds -notcontains $finding.id) { throw 'Unexpected finding in scoped report.' } }
    if ((Get-Content -LiteralPath macie-job.json -Raw | ConvertFrom-Json).jobId -ne 'mock-job') { throw 'Missing job status report.' }
  } finally { Pop-Location }
}
$global:mockAccount = '000000000000'
$blocked = $false
try { $null = & (Join-Path $PSScriptRoot 'GET-REPORT.ps1') 6>$null }
catch { if ($_.Exception.Message -like '*Unexpected report-export account*') { $blocked = $true } else { throw } }
if (-not $blocked) { throw 'Report export accepted an unexpected account.' }
Write-Output 'Passed six local findings/batching cases and the wrong-account guard; no cloud command executed.'
`);
const powershell = process.env.POWERSHELL_PATH || join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const check = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'harness.ps1')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
if (check.error) throw check.error;
if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);
if (check.status !== 0) throw new Error('Macie report mock checks failed; scratch retained at ' + work);
console.log('Mock report artifacts: ' + work);
