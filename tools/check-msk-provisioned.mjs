/** Run regional-version preflight against local PowerShell functions only. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_MSK_PROVISIONED_SERVICE as blueprint } from '../src/cloud/aws-msk-provisioned-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'msk-provisioned-test-'));
const result = blueprint.build({ ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'application-kafka', role: 'arn:aws:iam::123456789012:role/KafkaApplication', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: 'sg-0123456789abcdef0', topics: 'orders', groups: 'workers', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', log_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abd' });
if (result.findings.length) throw new Error('Invalid provisioned MSK fixture');
writeFileSync(join(work, 'PREFLIGHT.ps1'), result.files['PREFLIGHT.ps1']);
writeFileSync(join(work, 'harness.ps1'), [
  "$ErrorActionPreference = 'Stop'",
  'function global:aws {',
  '  $request = @($args); $global:LASTEXITCODE = 0',
  '  if ($global:case -eq "api") { $global:LASTEXITCODE = 1; return "{}" }',
  '  if ($request[0] -eq "sts") { @{ Account = $(if ($global:case -eq "account") { "000000000000" } else { "123456789012" }) } | ConvertTo-Json -Compress; return }',
  '  if ($request[0] -ne "kafka" -or $request[1] -ne "list-kafka-versions" -or $request -notcontains "us-east-1") { throw "Unexpected operation" }',
  '  $versions = @(@{ Version = "3.9.x.kraft"; Status = $(if ($global:case -eq "inactive") { "DEPRECATED" } else { "ACTIVE" }) })',
  '  if ($global:case -eq "missing") { $versions = @() }',
  '  if ($global:case -eq "wrong-mode") { $versions[0].Version = "3.9.x" }',
  '  @{ KafkaVersions = $versions } | ConvertTo-Json -Depth 5 -Compress',
  '}',
  'foreach ($item in @("valid", "api", "account", "inactive", "missing", "wrong-mode")) {',
  '  $global:case = $item; $failed = $false',
  '  try { & (Join-Path $PSScriptRoot "PREFLIGHT.ps1") | Out-Null } catch { $failed = $true }',
  '  if ($failed -ne ($item -ne "valid")) { throw ("Unexpected preflight result: " + $item) }',
  '}',
  'Write-Host "Passed six mocked provisioned MSK preflight cases; no cloud calls."',
].join('\n'));
const run = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'harness.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status || 1);
console.log(work);
