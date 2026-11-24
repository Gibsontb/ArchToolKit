/** Generated IAM/TLS client tests with local credential/Redis/state stubs only. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_MEMORYDB_SERVICE } from '../src/cloud/aws-memorydb-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'memorydb-client-test-'));
const result = AWS_MEMORYDB_SERVICE.build({ ...defaultValues(AWS_MEMORYDB_SERVICE), aws_region: 'us-east-1', name: 'mock-memory', role: 'arn:aws:iam::123456789012:role/MemoryApplication', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: 'sg-0123456789abcdef0' });
if (result.findings.length) throw new Error('Invalid MemoryDB fixture.');
for (const name of ['CHECK.py', 'PREFLIGHT.ps1']) writeFileSync(join(work, name), result.files[name]);
writeFileSync(join(work, 'harness.py'), String.raw`import contextlib, io, json, pathlib, runpy, ssl, subprocess, sys, types
root = pathlib.Path(__file__).resolve().parent
compile((root / "CHECK.py").read_text(encoding="utf-8"), "CHECK.py", "exec")
def state(arguments, **kwargs):
    assert arguments == ["terraform", "output", "-json", "client_configuration"]
    return json.dumps({"cluster":"mock-memory","endpoint":"bad/endpoint" if scenario == "endpoint" else "mock.memorydb.amazonaws.com","port":6379,"region":"us-east-1","username":"mock-memory","key_prefix":"application:","access":"READ" if scenario == "read-denied" else "READWRITE"})
subprocess.check_output = state
class Credentials:
    def get_frozen_credentials(self): return object()
class Session:
    def get_credentials(self): return None if scenario == "credentials" else Credentials()
class Request:
    def __init__(self, **kwargs):
        assert kwargs["method"] == "GET" and kwargs["url"] == "http://mock-memory/"
        assert kwargs["params"] == {"Action":"connect","User":"mock-memory"}
        self.url = kwargs["url"]
class Signer:
    def __init__(self, credentials, service, region, expires):
        assert service == "memorydb" and region == "us-east-1" and expires == 900
    def add_auth(self, request):
        if scenario == "signer": raise RuntimeError("mock signer failure")
        request.url += "?mock-signed-token"
class Redis:
    def __init__(self, **kwargs):
        assert kwargs["host"] == "mock.memorydb.amazonaws.com" and kwargs["port"] == 6379
        assert kwargs["ssl"] is True and kwargs["ssl_cert_reqs"] == "required" and kwargs["ssl_check_hostname"] is True
        assert kwargs["ssl_min_version"] == ssl.TLSVersion.TLSv1_2
        provider = kwargs["credential_provider"]
        for _ in range(2): assert provider.get_credentials() == ("mock-memory","mock-memory/?mock-signed-token")
        calls.append("open")
    def ping(self):
        calls.append("ping")
        if scenario == "ping-error": raise RuntimeError("mock connection failure")
        return {"one": True, "two": scenario != "ping-bad"} if scenario in ["multi-node","ping-bad"] else True
    def set(self, key, value, **kwargs):
        assert key.startswith("application:archtoolkit:pilot:") and value == b"archtoolkit-synthetic-pilot"
        assert kwargs == {"nx": True, "ex":60}
        calls.append("set")
        if scenario == "set-error": raise RuntimeError("ambiguous SET")
        self.key = key
        return scenario != "collision"
    def get(self, key):
        assert key == self.key
        calls.append("get")
        if scenario == "get-error": raise RuntimeError("mock GET failure")
        return b"wrong" if scenario == "mismatch" else b"archtoolkit-synthetic-pilot"
    def delete(self, key):
        assert key == self.key
        calls.append("delete")
        if scenario == "delete-error": raise RuntimeError("mock cleanup failure")
        return 1
    def close(self): calls.append("close")
names = ["boto3","botocore","botocore.auth","botocore.awsrequest","redis","redis.cluster","redis.credentials"]
modules = {name: types.ModuleType(name) for name in names}
modules["boto3"].Session = Session
modules["botocore.auth"].SigV4QueryAuth = Signer
modules["botocore.awsrequest"].AWSRequest = Request
modules["redis.cluster"].RedisCluster = Redis
modules["redis.credentials"].CredentialProvider = object
sys.modules.update(modules)
for scenario in ["ping","multi-node","write","collision","set-error","mismatch","get-error","delete-error","ping-bad","ping-error","read-denied","credentials","signer","endpoint"]:
    calls, failure = [], None
    write = scenario in ["write","collision","set-error","mismatch","get-error","delete-error","read-denied"]
    sys.argv = ["CHECK.py"] + (["--write-test"] if write else [])
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        try: runpy.run_path(str(root / "CHECK.py"), run_name="__main__")
        except Exception as error: failure = error
    assert bool(failure) == (scenario not in ["ping","multi-node","write"]), (scenario, failure)
    assert "mock-signed-token" not in output.getvalue()
    if "open" in calls: assert calls[-1] == "close"
    if scenario in ["read-denied","credentials","signer","endpoint"]: assert calls == []
    if not write: assert "set" not in calls and "get" not in calls and "delete" not in calls
    assert calls.count("delete") == (1 if scenario in ["write","mismatch","get-error","delete-error"] else 0), (scenario,calls)
print("Passed 14 local MemoryDB IAM/TLS/client cases; no tokens printed, database connection or cloud calls.")
`);
writeFileSync(join(work, 'preflight-harness.ps1'), String.raw`$ErrorActionPreference = 'Stop'
function global:aws {
  if (($args -join ' ') -ne 'memorydb describe-engine-versions --engine valkey --engine-version 7.2 --region us-east-1 --output json') { throw 'Unexpected metadata query.' }
  $global:LASTEXITCODE = 0
  if ($global:case -eq 'api') { $global:LASTEXITCODE = 1; return '{}' }
  @{ EngineVersions = @(@{ Engine = $(if ($global:case -eq 'engine') { 'redis' } else { 'valkey' }); EngineVersion = $(if ($global:case -eq 'version') { '0.0' } else { '7.2' }) }) } | ConvertTo-Json -Depth 5 -Compress
}
foreach ($scenario in @('valid','engine','version','api')) {
  $global:case = $scenario; $failure = $null
  try { $null = & (Join-Path $PSScriptRoot 'PREFLIGHT.ps1') 6>$null } catch { $failure = $_.Exception.Message }
  if ($scenario -eq 'valid') { if ($failure) { throw $failure } } elseif (-not $failure) { throw 'Unsupported metadata accepted.' }
}
Write-Output 'Passed four local engine metadata cases.'
`);
const powershell = process.env.POWERSHELL_PATH || join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
for (const [executable, args] of [[process.env.PYTHON_PATH || 'python', [join(work, 'harness.py')]], [powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'preflight-harness.ps1')]]]) {
  const check = spawnSync(executable, args, { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (check.stdout) process.stdout.write(check.stdout);
  if (check.stderr) process.stderr.write(check.stderr);
  if (check.error) throw check.error;
  if (check.status !== 0) throw new Error('MemoryDB mock checks failed: ' + work);
}
console.log('Mock artifacts: ' + work);
