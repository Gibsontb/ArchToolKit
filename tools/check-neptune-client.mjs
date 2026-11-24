/** Generated Neptune checks with local SDK/state stubs only. No database connection. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_NEPTUNE_SERVICE } from '../src/cloud/aws-neptune-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'neptune-client-test-'));
const result = AWS_NEPTUNE_SERVICE.build({ ...defaultValues(AWS_NEPTUNE_SERVICE), aws_region: 'us-east-1', name: 'mock-graph', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: 'sg-0123456789abcdef0', reader: 'arn:aws:iam::123456789012:role/GraphReader' });
if (result.findings.length) throw new Error('Invalid Neptune fixture.');
writeFileSync(join(work, 'CHECK.py'), result.files['CHECK.py']);
writeFileSync(join(work, 'harness.py'), String.raw`import contextlib, io, pathlib, runpy, subprocess, sys, types
root = pathlib.Path(__file__).resolve().parent
compile((root / "CHECK.py").read_text(encoding="utf-8"), "CHECK.py", "exec")
def state(arguments, **kwargs):
    assert arguments == ["terraform", "output", "-raw", "cluster_endpoint"]
    if scenario == "state-error": raise RuntimeError("mock state failure")
    return "https://wrong/" if scenario == "endpoint" else "mock.cluster.neptune.amazonaws.com"
subprocess.check_output = state
class Client:
    def get_engine_status(self):
        calls.append("status")
        if scenario == "sdk-error": raise RuntimeError("mock status failure")
        return {"status": "unhealthy" if scenario == "unhealthy" else "healthy", "role": "writer", "dbEngineVersion": "1.3.4.0"}
    def execute_open_cypher_query(self, **kwargs):
        assert kwargs == {"openCypherQuery": "RETURN 1 AS readiness"}
        calls.append("query")
        if scenario == "query-error": raise RuntimeError("mock query failure")
        return {"results": [{"readiness": 1}]}
    def close(self): calls.append("close")
def client(service, **kwargs):
    assert service == "neptunedata"
    assert kwargs["region_name"] == "us-east-1" and kwargs["verify"] is True
    assert kwargs["endpoint_url"] == "https://mock.cluster.neptune.amazonaws.com:8182"
    return Client()
def config(**kwargs):
    assert kwargs == {"connect_timeout": 10, "read_timeout": 30, "retries": {"total_max_attempts": 1}}
    return object()
boto, botocore, config_module = [types.ModuleType(name) for name in ["boto3", "botocore", "botocore.config"]]
boto.client, config_module.Config = client, config
for module in [boto, botocore, config_module]: sys.modules[module.__name__] = module
for scenario in ["status", "query", "endpoint", "state-error", "unhealthy", "sdk-error", "query-error"]:
    calls, failure = [], None
    sys.argv = ["CHECK.py"] + (["--query"] if scenario in ["query", "query-error", "unhealthy"] else [])
    with contextlib.redirect_stdout(io.StringIO()):
        try: runpy.run_path(str(root / "CHECK.py"), run_name="__main__")
        except Exception as error: failure = error
    assert bool(failure) == (scenario not in ["status", "query"]), (scenario, failure)
    if scenario in ["endpoint", "state-error"]: assert calls == []
    else:
        assert calls[-1] == "close"
        assert calls.count("status") == 1
        assert calls.count("query") == (1 if scenario in ["query", "query-error"] else 0)
print("Passed seven local Neptune client cases; no database or cloud requests.")
`);
const check = spawnSync(process.env.PYTHON_PATH || 'python', [join(work, 'harness.py')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);
if (check.error) throw check.error;
if (check.status !== 0) throw new Error('Neptune mock checks failed: ' + work);
console.log('Mock artifacts: ' + work);
