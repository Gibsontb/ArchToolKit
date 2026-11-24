/** Metadata preflight contracts with local AWS function mocks only. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_TRANSFER_EFS_SERVICE as blueprint } from '../src/cloud/aws-transfer-efs-service.ts';
import { publicTestKey } from './service-test-ssh.mjs';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'transfer-efs-test-'));
const result = blueprint.build({ ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'application-sftp', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: 'sg-0123456789abcdef0', filesystem: 'fs-0123456789abcdef0', role: 'arn:aws:iam::123456789012:role/TransferEfs', logging_role: 'arn:aws:iam::123456789012:role/TransferLogs', users: 'alice | 1001 | 1001 | ' + publicTestKey() });
if (result.findings.length) throw new Error('Invalid EFS Transfer fixture');
writeFileSync(join(work, 'PREFLIGHT.ps1'), result.files['PREFLIGHT.ps1']);
writeFileSync(join(work, 'harness.ps1'), [
  "$ErrorActionPreference = 'Stop'",
  'function global:aws {',
  '  $request = @($args); $global:LASTEXITCODE = 0',
  '  if ($global:case -eq "api") { $global:LASTEXITCODE = 1; return "{}" }',
  '  if ($request[0] -eq "sts") { @{ Account = $(if ($global:case -eq "account") { "000000000000" } else { "123456789012" }) } | ConvertTo-Json -Compress; return }',
  '  if ($request -notcontains "us-east-1") { throw "Missing region" }',
  '  switch ($request[1]) {',
  '    "describe-file-systems" { @{ FileSystems = @(@{ FileSystemArn = $(if ($global:case -eq "filesystem") { "other" } else { "arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0123456789abcdef0" }); LifeCycleState = $(if ($global:case -eq "state") { "creating" } else { "available" }); Encrypted = ($global:case -ne "encryption") }) } | ConvertTo-Json -Depth 5 -Compress }',
  '    "describe-mount-targets" {',
  '      $targets = @(@{ FileSystemId = "fs-0123456789abcdef0"; OwnerId = $(if ($global:case -eq "owner") { "000000000000" } else { "123456789012" }); LifeCycleState = "available" })',
  '      if ($global:case -eq "targets") { $targets = @() }',
  '      @{ MountTargets = $targets } | ConvertTo-Json -Depth 5 -Compress',
  '    }',
  '    "describe-security-policy" { if ($request[0] -ne "transfer" -or $request -notcontains "TransferSecurityPolicy-2025-03") { throw "Wrong policy query" }; if ($global:case -eq "policy") { $global:LASTEXITCODE = 1 }; "{}" }',
  '    default { throw "Unexpected metadata operation" }',
  '  }',
  '}',
  'foreach ($item in @("valid", "api", "account", "filesystem", "state", "encryption", "owner", "targets", "policy")) {',
  '  $global:case = $item; $failed = $false',
  '  try { & (Join-Path $PSScriptRoot "PREFLIGHT.ps1") | Out-Null } catch { $failed = $true }',
  '  if ($failed -ne ($item -ne "valid")) { throw ("Unexpected metadata result: " + $item) }',
  '}',
  'Write-Host "Passed nine EFS Transfer metadata cases; no cloud calls, mounts or file transfers."',
].join('\n'));
const run = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'harness.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status || 1);
console.log(work);
