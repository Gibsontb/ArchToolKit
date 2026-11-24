/** Exercise the generated Kafka metadata client without dependencies or network access. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_MSK_SERVERLESS_SERVICE } from '../src/cloud/aws-msk-serverless-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'msk-client-test-'));
const result = AWS_MSK_SERVERLESS_SERVICE.build({ ...defaultValues(AWS_MSK_SERVERLESS_SERVICE), aws_region: 'us-east-1', name: 'mock-kafka', role: 'arn:aws:iam::123456789012:role/KafkaApplication', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: 'sg-0123456789abcdef0', topics: 'orders,events', groups: 'workers' });
if (result.findings.length) throw new Error('Invalid MSK fixture.');
for (const name of ['CHECK.py', 'CLIENT-CONFIG.json']) writeFileSync(join(work, name), result.files[name]);
writeFileSync(join(work, 'harness.py'), String.raw`import contextlib, io, pathlib, runpy, subprocess, sys, types
root = pathlib.Path(__file__).resolve().parent
compile((root / "CHECK.py").read_text(encoding="utf-8"), "CHECK.py", "exec")
def bootstrap(arguments, **kwargs):
    assert arguments == ["terraform", "output", "-raw", "bootstrap_brokers"]
    if scenario == "state-error": raise RuntimeError("mock state error")
    return "broker:9092" if scenario == "wrong-port" else (" " if scenario == "empty" else "broker-one:9098,broker-two:9098")
subprocess.check_output = bootstrap
def token(region):
    assert region == "us-east-1"
    if scenario == "token-error": raise RuntimeError("mock token error")
    return "mock-token", 123456789
class Consumer:
    def __init__(self, **kwargs):
        global opened
        assert kwargs["security_protocol"] == "SASL_SSL" and kwargs["sasl_mechanism"] == "OAUTHBEARER"
        assert kwargs["ssl_check_hostname"] is True
        import ssl
        assert kwargs["ssl_context"].check_hostname is True
        assert kwargs["ssl_context"].verify_mode == ssl.CERT_REQUIRED
        assert kwargs["ssl_context"].minimum_version == ssl.TLSVersion.TLSv1_2
        assert kwargs["allow_auto_create_topics"] is False
        assert kwargs["enable_auto_commit"] is False and kwargs["group_id"] is None
        assert kwargs["sasl_oauth_token_provider"].token() == "mock-token"
        opened += 1
    def partitions_for_topic(self, topic):
        calls.append(topic)
        assert topic in ["orders", "events"]
        if scenario == "metadata-error": raise RuntimeError("mock broker error")
        return None if scenario == "missing-topic" else {0,1,2}
    def close(self):
        global closed
        closed += 1
kafka, sasl, oauth, signer = [types.ModuleType(name) for name in ["kafka", "kafka.sasl", "kafka.sasl.oauth", "aws_msk_iam_sasl_signer"]]
kafka.KafkaConsumer, oauth.AbstractTokenProvider = Consumer, object
signer.MSKAuthTokenProvider = types.SimpleNamespace(generate_auth_token=token)
for module in [kafka, sasl, oauth, signer]: sys.modules[module.__name__] = module
for scenario in ["valid", "wrong-port", "empty", "state-error", "token-error", "missing-topic", "metadata-error"]:
    opened, closed, calls, failure = 0, 0, [], None
    with contextlib.redirect_stdout(io.StringIO()):
        try: runpy.run_path(str(root / "CHECK.py"), run_name="__main__")
        except Exception as error: failure = error
    assert bool(failure) == (scenario != "valid"), (scenario, failure)
    assert opened == closed, (scenario, opened, closed)
    if scenario == "valid": assert calls == ["orders", "events"]
    if scenario in ["wrong-port", "empty", "state-error", "token-error"]: assert opened == 0 and calls == []
print("Passed seven local MSK client cases; no Kafka connection, cloud calls or record writes.")
`);
const check = spawnSync(process.env.PYTHON_PATH || 'python', [join(work, 'harness.py')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);
if (check.error) throw check.error;
if (check.status !== 0) throw new Error('MSK client mock checks failed: ' + work);
console.log('Mock artifacts: ' + work);
