/** Generated metadata preflight with local AWS function mocks only. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_OPENSEARCH_DOMAIN_SERVICE } from '../src/cloud/aws-opensearch-domain-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'opensearch-preflight-test-'));
const result = AWS_OPENSEARCH_DOMAIN_SERVICE.build({ ...defaultValues(AWS_OPENSEARCH_DOMAIN_SERVICE), aws_region: 'us-east-1', name: 'mock-search', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1,subnet-0123456789abcdef2', clients: 'sg-0123456789abcdef0', admin: 'arn:aws:iam::123456789012:role/SearchMaster', applications: 'arn:aws:iam::123456789012:role/SearchApplication' });
if (result.findings.length) throw new Error('Invalid fixture.');
writeFileSync(join(work, 'PREFLIGHT.ps1'), result.files['PREFLIGHT.ps1']);
writeFileSync(join(work, 'CHECK.py'), result.files['CHECK.py']);
for (const [name, contents] of Object.entries(result.files)) if (name.endsWith('.py') || name.endsWith('.json')) writeFileSync(join(work, name), contents);
writeFileSync(join(work, 'harness.ps1'), String.raw`$ErrorActionPreference = 'Stop'
function global:aws {
  $request = @($args); $global:LASTEXITCODE = 0
  if ($global:case -eq 'api') { $global:LASTEXITCODE = 1; return '{}' }
  if ($request[0] -eq 'sts') { @{ Account = $(if ($global:case -eq 'account') { '000000000000' } else { '123456789012' }) } | ConvertTo-Json -Compress; return }
  if ($request -notcontains 'us-east-1') { throw 'Missing configured region.' }
  if ($request[0] -eq 'ec2' -and $request[1] -eq 'describe-subnets') {
    @{ Subnets = @(@{ AvailabilityZone = 'us-east-1a' }, @{ AvailabilityZone = 'us-east-1b' }, @{ AvailabilityZone = $(if ($global:case -eq 'az') { 'us-east-1a' } else { 'us-east-1c' }) }) } | ConvertTo-Json -Depth 5 -Compress; return
  }
  if ($request[0] -ne 'opensearch') { throw 'Unexpected service.' }
  switch ($request[1]) {
    'list-versions' { @{ Versions = @($(if ($global:case -eq 'version') { 'OpenSearch_0.0' } else { 'OpenSearch_2.19' })) } | ConvertTo-Json -Compress }
    'list-instance-type-details' {
      @{ InstanceTypeDetails = @(@{ InstanceType = $(if ($global:case -eq 'type') { 'other.large.search' } else { 'm6g.large.search' }); EncryptionEnabled = ($global:case -ne 'encryption'); AdvancedSecurityEnabled = ($global:case -ne 'security'); AvailabilityZones = @('us-east-1a','us-east-1b',$(if ($global:case -eq 'offering-az') { 'us-east-1d' } else { 'us-east-1c' })) }) } | ConvertTo-Json -Depth 6 -Compress
    }
    'describe-instance-type-limits' {
      $minimum = @{ LimitName = 'MinimumVolumeSize'; LimitValues = @('10') }
      $maximum = @{ LimitName = 'MaximumVolumeSize'; LimitValues = @($(if ($global:case -eq 'volume') { '50' } else { '1024' })) }
      $performance = @{ LimitName = 'MinimumIops'; LimitValues = @($(if ($global:case -eq 'iops') { '6000' } else { '3000' })) }
      $bounds = @($minimum,$maximum,$performance); if ($global:case -eq 'missing') { $bounds = @($minimum) }
      @{ LimitsByRole = @{ data = @{ InstanceLimits = @{ InstanceCountLimits = @{ MinimumInstanceCount = 1; MaximumInstanceCount = $(if ($global:case -eq 'count') { 2 } else { 30 }) } }; StorageTypes = @(@{ StorageTypeName = 'ebs'; StorageSubTypeName = $(if ($global:case -eq 'gp3') { 'gp2' } else { 'gp3' }); StorageTypeLimits = $bounds }) } } } | ConvertTo-Json -Depth 10 -Compress
    }
    default { throw 'Unexpected operation.' }
  }
}
foreach ($scenario in @('valid','api','account','az','version','type','encryption','security','offering-az','volume','missing','count','gp3','iops')) {
  $global:case = $scenario; $failure = $null
  try { $null = & (Join-Path $PSScriptRoot 'PREFLIGHT.ps1') 6>$null } catch { $failure = $_.Exception.Message }
  if ($scenario -eq 'valid') { if ($failure) { throw ('Valid metadata rejected: ' + $failure) } } elseif (-not $failure) { throw ('Unsupported metadata accepted: ' + $scenario) }
}
Write-Output 'Passed 14 local OpenSearch metadata cases; no cloud executable invoked.'
`);
const executable = process.env.POWERSHELL_PATH || join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const check = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'harness.ps1')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);
if (check.error) throw check.error;
if (check.status !== 0) throw new Error('OpenSearch preflight mock checks failed: ' + work);
console.log('Mock artifacts: ' + work);
writeFileSync(join(work, 'python-harness.py'), String.raw`import contextlib, io, pathlib, runpy, sys, types, urllib.error
root = pathlib.Path(__file__).resolve().parent
for file in root.glob("*.py"):
    compile(file.read_text(encoding="utf-8"), str(file), "exec")
module = types.ModuleType("opensearch_client")
master = "arn:aws:iam::123456789012:role/SearchMaster"
def connect():
    calls.append(("CONNECT", ""))
    return object()
def request(connection, method, path, payload=None):
    calls.append((method, path))
    if path.endswith("authinfo"):
        return {"backend_roles": [master] if scenario != "wrong-role" else []}
    if method == "GET" and "/api/" in path:
        if scenario == "forbidden": raise urllib.error.HTTPError(path, 403, "forbidden", {}, None)
        exists = scenario in ["replace", "existing-role"] or (scenario == "existing-mapping" and "/rolesmapping/" in path)
        if exists: return {"existing": {}}
        raise urllib.error.HTTPError(path, 404, "not found", {}, None)
    if method == "PUT":
        assert isinstance(payload, dict)
        if scenario == "partial" and "/rolesmapping/" in path: raise RuntimeError("mock mapping failure")
        return {"status": "CREATED"}
    return {"status": "green"}
module.connect, module.request = connect, request
sys.modules["opensearch_client"] = module
for scenario in ["preview", "new", "wrong-role", "existing-role", "existing-mapping", "replace", "forbidden", "partial"]:
    calls = []
    sys.argv = ["SETUP-ACCESS.py"] + ([] if scenario == "preview" else ["--apply"]) + (["--replace-existing"] if scenario == "replace" else [])
    failure = None
    with contextlib.redirect_stdout(io.StringIO()):
        try: runpy.run_path(str(root / "SETUP-ACCESS.py"), run_name="__main__")
        except SystemExit as error:
            if error.code != 0: failure = error
        except Exception as error: failure = error
    should_fail = scenario in ["wrong-role", "existing-role", "existing-mapping", "forbidden", "partial"]
    assert bool(failure) == should_fail, (scenario, failure)
    writes = [call for call in calls if call[0] == "PUT"]
    assert len(writes) == (2 if scenario in ["new", "replace", "partial"] else 0), (scenario, calls)
    if scenario == "preview": assert calls == []
calls, scenario = [], "check"
with contextlib.redirect_stdout(io.StringIO()):
    runpy.run_path(str(root / "CHECK.py"), run_name="__main__")
assert [call[0] for call in calls] == ["CONNECT", "GET", "GET"]
print("Passed nine local Python security/setup/check cases; no model, database or cloud requests.")
`);
const python = spawnSync(process.env.PYTHON_PATH || 'python', [join(work, 'python-harness.py')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
if (python.stdout) process.stdout.write(python.stdout);
if (python.stderr) process.stderr.write(python.stderr);
if (python.error) throw python.error;
if (python.status !== 0) throw new Error('OpenSearch Python mock checks failed: ' + work);
