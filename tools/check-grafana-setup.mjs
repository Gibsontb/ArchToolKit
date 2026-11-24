/** Local generated-script checks. AWS/Terraform/Grafana are replaced by functions/stubs. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_GRAFANA_SERVICE } from '../src/cloud/aws-grafana-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'grafana-setup-test-'));
const result = AWS_GRAFANA_SERVICE.build({ ...defaultValues(AWS_GRAFANA_SERVICE), aws_region: 'us-east-1', identity_region: 'us-east-1', name: 'mock-metrics', store: 'd-0123456789', admins: '12345678-abcd-4bcd-8bcd-123456789abc', role: 'arn:aws:iam::123456789012:role/GrafanaQuery', endpoints: 'vpce-0123456789abcdef0', prometheus: 'arn:aws:aps:us-east-1:123456789012:workspace/ws-12345678-abcd-4bcd-8bcd-123456789abc' });
if (result.findings.length) throw new Error('Invalid Grafana fixture.');
for (const name of ['PREFLIGHT.ps1', 'SETUP-DATASOURCES.py', 'DATA-SOURCES.json']) writeFileSync(join(work, name), result.files[name]);
writeFileSync(join(work, 'preflight-harness.ps1'), String.raw`$ErrorActionPreference = 'Stop'
function global:aws {
  if (($args -join ' ') -ne 'grafana list-versions --region us-east-1 --output json') { throw 'Unexpected metadata command.' }
  $global:LASTEXITCODE = 0
  if ($global:case -eq 'error') { $global:LASTEXITCODE = 1; return '{}' }
  @{ grafanaVersions = @($(if ($global:case -eq 'unsupported') { '0.0' } else { '10.4' })) } | ConvertTo-Json -Compress
}
foreach ($scenario in @('valid','unsupported','error')) {
  $global:case = $scenario; $failure = $null
  try { $null = & (Join-Path $PSScriptRoot 'PREFLIGHT.ps1') 6>$null } catch { $failure = $_.Exception.Message }
  if ($scenario -eq 'valid') { if ($failure) { throw $failure } } elseif (-not $failure) { throw 'Invalid metadata accepted.' }
}
Write-Output 'Passed three local Grafana version cases.'
`);
writeFileSync(join(work, 'python-harness.py'), String.raw`import contextlib, io, json, os, pathlib, runpy, subprocess, sys, urllib.error, urllib.request
root = pathlib.Path(__file__).resolve().parent
compile((root / "SETUP-DATASOURCES.py").read_text(encoding="utf-8"), "SETUP-DATASOURCES.py", "exec")
def state(arguments, **kwargs):
    assert arguments == ["terraform", "output", "-raw", "workspace_endpoint"]
    calls.append(("STATE", ""))
    return "https://wrong/" if scenario == "endpoint" else "g-1234567890.grafana-workspace.us-east-1.amazonaws.com"
subprocess.check_output = state
class Opener:
    def open(self, request, **kwargs):
        method, url = request.get_method(), request.full_url
        assert request.headers["Authorization"] == "Bearer mock-token"
        assert url.startswith("https://g-1234567890.grafana-workspace.us-east-1.amazonaws.com/api/datasources")
        assert kwargs["timeout"] == 30
        calls.append((method, url))
        if method == "GET":
            if scenario == "forbidden": raise urllib.error.HTTPError(url, 403, "forbidden", {}, None)
            existing = scenario in ["replace", "existing"] or (scenario == "existing-second" and url.endswith("archtoolkit-prometheus"))
            if not existing: raise urllib.error.HTTPError(url, 404, "not found", {}, None)
            return io.BytesIO(b'{"uid":"existing"}')
        assert method in ["POST", "PUT"]
        payload = json.loads(request.data)
        assert payload["uid"] in ["archtoolkit-cloudwatch", "archtoolkit-prometheus"]
        if scenario == "partial" and payload["uid"] == "archtoolkit-prometheus": raise RuntimeError("mock second write failure")
        return io.BytesIO(b'{"message":"created"}')
def build(*handlers):
    try: handlers[0].redirect_request(None, None, 302, "", {}, "https://other.example")
    except RuntimeError: pass
    else: raise AssertionError("Authenticated redirect allowed")
    return Opener()
urllib.request.build_opener = build
for scenario in ["preview", "new", "replace", "missing-token", "endpoint", "existing", "existing-second", "forbidden", "partial"]:
    calls, failure = [], None
    os.environ.pop("GRAFANA_TOKEN", None)
    if scenario != "missing-token": os.environ["GRAFANA_TOKEN"] = "mock-token"
    sys.argv = ["SETUP-DATASOURCES.py"] + ([] if scenario == "preview" else ["--apply"]) + (["--replace-existing"] if scenario == "replace" else [])
    with contextlib.redirect_stdout(io.StringIO()):
        try: runpy.run_path(str(root / "SETUP-DATASOURCES.py"), run_name="__main__")
        except SystemExit as error:
            if error.code != 0: failure = error
        except Exception as error: failure = error
    assert bool(failure) == (scenario not in ["preview", "new", "replace"]), (scenario, failure)
    writes = [method for method, _ in calls if method in ["POST", "PUT"]]
    assert len(writes) == (2 if scenario in ["new", "replace", "partial"] else 0), (scenario, calls)
    if scenario == "preview": assert calls == []
    if scenario == "replace": assert writes == ["PUT", "PUT"]
print("Passed nine Grafana setup cases including partial failure and authenticated redirect rejection; no network requests.")
`);
const powershell = process.env.POWERSHELL_PATH || join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
for (const [executable, args] of [[powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'preflight-harness.ps1')]], [process.env.PYTHON_PATH || 'python', [join(work, 'python-harness.py')]]]) {
  const check = spawnSync(executable, args, { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (check.stdout) process.stdout.write(check.stdout);
  if (check.stderr) process.stderr.write(check.stderr);
  if (check.error) throw check.error;
  if (check.status !== 0) throw new Error('Grafana mock checks failed: ' + work);
}
console.log('Mock artifacts: ' + work);
