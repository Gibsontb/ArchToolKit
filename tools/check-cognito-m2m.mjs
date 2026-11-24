/** Generated token probe with local SDK/HTTP/state stubs only. No secret read or token minting. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_COGNITO_M2M_SERVICE } from '../src/cloud/aws-cognito-m2m-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'cognito-m2m-test-'));
const result = AWS_COGNITO_M2M_SERVICE.build({ ...defaultValues(AWS_COGNITO_M2M_SERVICE), aws_region: 'us-east-1', name: 'mock-machine', domain: 'mock-machine-123456789012', scopes: 'read,write' });
if (result.findings.length) throw new Error('Invalid Cognito fixture.');
writeFileSync(join(work, 'TOKEN-PROBE.py'), result.files['TOKEN-PROBE.py']);
writeFileSync(join(work, 'harness.py'), String.raw`import base64, contextlib, io, json, pathlib, runpy, subprocess, sys, types, urllib.error, urllib.parse, urllib.request
root = pathlib.Path(__file__).resolve().parent
compile((root / "TOKEN-PROBE.py").read_text(encoding="utf-8"), "TOKEN-PROBE.py", "exec")
endpoint = "https://mock-machine-123456789012.auth.us-east-1.amazoncognito.com/oauth2/token"
def state(arguments, **kwargs):
    assert arguments == ["terraform","output","-json","machine_configuration"]
    return json.dumps({"account":"123456789012","region":"us-east-1","client_id":"mock-client","secret_arn":"mock-secret","token_endpoint":"https://other.example/token" if scenario == "endpoint" else endpoint,"scopes":["application-api/read","application-api/write"]})
subprocess.check_output = state
class Session:
    def __init__(self, **kwargs): assert kwargs == {"region_name":"us-east-1"}
    def client(self, service):
        assert service in ["sts","secretsmanager"]
        calls.append(service)
        return self
    def get_caller_identity(self): return {"Account":"wrong" if scenario == "account" else "123456789012"}
    def get_secret_value(self, **kwargs):
        assert kwargs == {"SecretId":"mock-secret"}
        return {"SecretString":json.dumps({"client_id":"wrong-client" if scenario == "secret" else "mock-client","client_secret":"do-not-print-secret"})}
boto = types.ModuleType("boto3"); boto.Session = Session; sys.modules["boto3"] = boto
class Opener:
    def open(self, request, timeout):
        calls.append("http")
        assert timeout == 30 and request.full_url == endpoint and request.get_method() == "POST"
        assert request.get_header("Authorization") == "Basic " + base64.b64encode(b"mock-client:do-not-print-secret").decode()
        assert urllib.parse.parse_qs(request.data.decode()) == {"grant_type":["client_credentials"],"scope":["application-api/read application-api/write"]}
        if scenario == "http-error": raise urllib.error.HTTPError(endpoint,401,"Unauthorized",{},io.BytesIO(b"do-not-print-secret"))
        response = {"access_token":"do-not-print-token","token_type":"Bearer","expires_in":900}
        if scenario == "incomplete": response.pop("access_token")
        if scenario == "scope": response["scope"] = "application-api/other"
        return io.BytesIO(json.dumps(response).encode())
def opener(*handlers):
    assert len(handlers) == 1
    if scenario == "redirect": handlers[0].redirect_request(None,None,302,"",{},"https://other.example")
    try: handlers[0].redirect_request(None,None,302,"",{},"https://other.example")
    except RuntimeError: pass
    else: raise AssertionError("Authenticated redirect allowed")
    return Opener()
urllib.request.build_opener = opener
for scenario in ["preview","valid","endpoint","account","secret","redirect","http-error","incomplete","scope"]:
    calls, failure, output = [], None, io.StringIO()
    sys.argv = ["TOKEN-PROBE.py"] + ([] if scenario == "preview" else ["--request-token"])
    with contextlib.redirect_stdout(output):
        try: runpy.run_path(str(root / "TOKEN-PROBE.py"), run_name="__main__")
        except SystemExit as error:
            if error.code != 0: failure = error
        except Exception as error: failure = error
    assert bool(failure) == (scenario not in ["preview","valid"]), (scenario,failure)
    assert "do-not-print-secret" not in output.getvalue() and "do-not-print-token" not in output.getvalue()
    if scenario in ["preview","endpoint"]: assert calls == []
    if scenario == "account": assert calls == ["sts"]
    if scenario in ["secret","redirect"]: assert "http" not in calls
print("Passed nine local Cognito M2M probe cases; no AWS calls, real secrets, token minting or credential output.")
`);
const check = spawnSync(process.env.PYTHON_PATH || 'python',[join(work,'harness.py')],{ cwd:work,encoding:'utf8',timeout:60000,windowsHide:true });
if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);
if (check.error) throw check.error;
if (check.status !== 0) throw new Error('Cognito probe checks failed: ' + work);
console.log('Mock artifacts: ' + work);
