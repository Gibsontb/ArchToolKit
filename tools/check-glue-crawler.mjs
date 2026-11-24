/** Local PowerShell operator contract checks. AWS/Terraform are functions, never executables. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_GLUE_CRAWLER_SERVICE as blueprint } from '../src/cloud/aws-glue-crawler-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'glue-crawler-test-'));
const result = blueprint.build({ ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'application-crawler', database: 'application', role: 'arn:aws:iam::123456789012:role/GlueExecution', bucket: 'application-source' });
if (result.findings.length) throw new Error('Invalid crawler fixture');
writeFileSync(join(work, 'OPERATE.ps1'), result.files['OPERATE.ps1']);
writeFileSync(join(work, 'harness.ps1'), [
  "$ErrorActionPreference = 'Stop'",
  'function global:terraform { $global:LASTEXITCODE = 0; if ($global:case -eq "state") { "other-crawler" } else { "application-crawler" } }',
  'function global:aws {',
  '  $request = @($args); $global:LASTEXITCODE = 0',
  '  if ($global:case -eq "api") { $global:LASTEXITCODE = 1; return "{}" }',
  '  if ($request[0] -eq "sts") { @{ Account = $(if ($global:case -eq "account") { "000000000000" } else { "123456789012" }) } | ConvertTo-Json -Compress; return }',
  '  if ($request -notcontains "us-east-1") { throw "Missing region" }',
  '  switch ($request[1]) {',
  '    "get-database" {',
  '      $database = @{ Name = $(if ($global:case -eq "database") { "other" } else { "application" }); CatalogId = "123456789012" }',
  '      if ($global:case -ne "missing-defaults") { $database.CreateTableDefaultPermissions = $(if ($global:case -eq "grants") { @(@{ Principal = @{ DataLakePrincipalIdentifier = "IAM_ALLOWED_PRINCIPALS" }; Permissions = @("ALL") }) } else { @() }) }',
  '      @{ Database = $database } | ConvertTo-Json -Depth 8 -Compress',
  '    }',
  '    "head-bucket" { if ($request -notcontains "--expected-bucket-owner") { throw "No ownership check" }; "{}" }',
  '    "get-public-access-block" { @{ PublicAccessBlockConfiguration = @{ BlockPublicAcls = $true; IgnorePublicAcls = $true; BlockPublicPolicy = $true; RestrictPublicBuckets = ($global:case -ne "public") } } | ConvertTo-Json -Compress }',
  '    "get-crawler" {',
  '      $targets = @{ S3Targets = @(@{ Path = $(if ($global:case -eq "source") { "s3://other/accepted/" } else { "s3://application-source/accepted/" }); SampleSize = $(if ($global:case -eq "sampling") { 20 } else { 0 }) }); JdbcTargets = @() }',
  '      if ($global:case -eq "extra-target") { $targets.JdbcTargets = @(@{ ConnectionName = "other" }) }',
  '      @{ Crawler = @{ Name = "application-crawler"; Role = $(if ($global:case -eq "role") { "other" } else { "arn:aws:iam::123456789012:role/GlueExecution" }); DatabaseName = "application"; Targets = $targets; State = $(if ($global:case -eq "busy") { "RUNNING" } else { "READY" }); TablePrefix = "application_"; RecrawlPolicy = @{ RecrawlBehavior = "CRAWL_EVERYTHING" }; SchemaChangePolicy = @{ UpdateBehavior = $(if ($global:case -eq "schema") { "UPDATE_IN_DATABASE" } else { "LOG" }); DeleteBehavior = "LOG" }; Configuration = (@{ Version = 1.0; CrawlerOutput = @{ Tables = @{ TableThreshold = 10 }; Partitions = @{ AddOrUpdateBehavior = "InheritFromTable" } } } | ConvertTo-Json -Depth 6 -Compress); Schedule = @{ ScheduleExpression = $(if ($global:case -eq "schedule") { "cron(0 * * * ? *)" } else { $null }) }; LakeFormationConfiguration = @{ UseLakeFormationCredentials = ($global:case -eq "credentials") } } } | ConvertTo-Json -Depth 8 -Compress',
  '    }',
  '    "start-crawler" { $global:starts++; "{}" }',
  '    default { throw "Unexpected operation" }',
  '  }',
  '}',
  '$cases = @("prerequisites", "missing-defaults", "inspect", "start", "api", "account", "database", "grants", "public", "state", "source", "extra-target", "role", "busy", "sampling", "schema", "schedule", "credentials")',
  'foreach ($item in $cases) {',
  '  $global:case = $item; $global:starts = 0; $failed = $false',
  '  $action = if ($item -in @("prerequisites", "missing-defaults")) { "InspectPrerequisites" } elseif ($item -eq "inspect") { "Inspect" } else { "Start" }',
  '  try { & (Join-Path $PSScriptRoot "OPERATE.ps1") -Action $action | Out-Null } catch { $failed = $true }',
  '  $expectedFailure = $item -notin @("prerequisites", "missing-defaults", "inspect", "start")',
  '  if ($failed -ne $expectedFailure) { throw ("Unexpected failure state: " + $item) }',
  '  $expectedStarts = if ($item -eq "start") { 1 } else { 0 }',
  '  if ($global:starts -ne $expectedStarts) { throw ("Unexpected crawl starts: " + $item) }',
  '}',
  'Write-Host "Passed 18 mocked crawler operator cases. No AWS requests executed."',
].join('\n'));
const run = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'harness.ps1')], { encoding: 'utf8' });
process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
if (run.status !== 0) process.exit(run.status || 1);
console.log(work);
