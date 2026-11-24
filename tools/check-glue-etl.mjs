/** Exercise generated ETL flow using local Spark/Glue stubs. No Spark engine, S3 or AWS calls. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_GLUE_ETL_SERVICE } from '../src/cloud/aws-glue-etl-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'glue-etl-test-'));
for (const source of ['csv', 'json', 'parquet']) for (const target of ['csv', 'json', 'parquet']) {
  const result = AWS_GLUE_ETL_SERVICE.build({ ...defaultValues(AWS_GLUE_ETL_SERVICE), aws_region: 'us-east-1', name: 'mock-convert', role: 'arn:aws:iam::123456789012:role/GlueExecution', source_bucket: 'application-source', target_bucket: 'application-destination', artifact_bucket: 'application-artifacts', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', source_format: source, target_format: target });
  if (result.findings.length) throw new Error('Invalid ETL fixture.');
  writeFileSync(join(work, source + '-' + target + '.py'), result.files['ETL.py']);
  writeFileSync(join(work, 'PREFLIGHT.ps1'), result.files['PREFLIGHT.ps1']);
}
writeFileSync(join(work, 'harness.py'), String.raw`import pathlib, runpy, sys, types
root = pathlib.Path(__file__).resolve().parent
class Reader:
    def format(self, value): calls.append(("read-format", value)); return self
    def option(self, key, value): calls.append(("read-option", key, value)); return self
    def load(self, path):
        assert path == "s3://application-source/source/"
        calls.append(("load", path))
        if scenario == "read-error": raise RuntimeError("mock read failure")
        return types.SimpleNamespace(write=Writer())
class Writer:
    def mode(self, value): assert value == "errorifexists"; calls.append(("mode", value)); return self
    def format(self, value): calls.append(("write-format", value)); return self
    def option(self, key, value): calls.append(("write-option", key, value)); return self
    def save(self, path):
        assert path.startswith("s3://application-destination/converted/run-") and path.endswith("/")
        assert path not in outputs
        outputs.add(path); calls.append(("save", path))
        if scenario == "write-error": raise RuntimeError("mock write failure")
class Context:
    def __init__(self, spark): self.spark_session = types.SimpleNamespace(read=Reader())
    def get_logger(self): return types.SimpleNamespace(info=lambda message: calls.append(("logged",)))
spark, sparkcontext, glue, gluecontext = [types.ModuleType(name) for name in ["pyspark", "pyspark.context", "awsglue", "awsglue.context"]]
sparkcontext.SparkContext = types.SimpleNamespace(getOrCreate=lambda: object())
gluecontext.GlueContext = Context
for module in [spark, sparkcontext, glue, gluecontext]: sys.modules[module.__name__] = module
outputs, count = set(), 0
for source in ["csv", "json", "parquet"]:
    for target in ["csv", "json", "parquet"]:
        scenario, calls = "valid", []
        runpy.run_path(str(root / (source + "-" + target + ".py")), run_name="__main__")
        assert ("read-format", source) in calls and ("write-format", target) in calls
        assert ("read-option", "mode", "FAILFAST") in calls
        assert (("read-option", "inferSchema", "false") in calls) == (source == "csv")
        assert (("read-option", "multiLine", "false") in calls) == (source == "json")
        assert (("write-option", "header", "true") in calls) == (target == "csv")
        assert ("write-option", "compression", "snappy" if target == "parquet" else "gzip") in calls
        assert calls[-1] == ("logged",)
        count += 1
for scenario in ["read-error", "write-error"]:
    calls, failure = [], None
    try: runpy.run_path(str(root / "parquet-parquet.py"), run_name="__main__")
    except RuntimeError as error: failure = error
    assert failure
    assert ("logged",) not in calls
    if scenario == "read-error": assert not any(call[0] == "save" for call in calls)
    count += 1
print("Passed", count, "local ETL cases; no Spark execution, S3 writes or AWS calls.")
`);
const check = spawnSync(process.env.PYTHON_PATH || 'python', [join(work, 'harness.py')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);
if (check.error) throw check.error;
if (check.status !== 0) throw new Error('Glue ETL mock checks failed: ' + work);
console.log('Mock artifacts: ' + work);
