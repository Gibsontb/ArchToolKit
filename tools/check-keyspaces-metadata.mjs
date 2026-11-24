/** Generated Keyspaces metadata client tests with local SDK stubs, no AWS/CQL calls. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_KEYSPACES_SERVICE as blueprint } from '../src/cloud/aws-keyspaces-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'keyspaces-metadata-test-'));
const result = blueprint.build({ ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'records', keyspace: 'application', role: 'arn:aws:iam::123456789012:role/CassandraApplication', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', capacity: 'PROVISIONED', reads: 100, writes: 50, ttl: 3600, timestamps: 'YES', columns: 'tenant | text | PARTITION | \nregion | text | PARTITION | \nrecord_id | uuid | CLUSTERING | ASC\nsummary | text | STATIC | ' });
if (result.findings.length) throw new Error('Invalid Keyspaces fixture');
for (const name of ['CHECK.py', 'CLIENT-CONFIG.json']) writeFileSync(join(work, name), result.files[name]);
const existing = blueprint.build({ ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'records', keyspace: 'application', create: 'EXISTING', role: 'arn:aws:iam::123456789012:role/CassandraApplication', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' });
writeFileSync(join(work, 'PREFLIGHT.py'), existing.files['PREFLIGHT.py']);
writeFileSync(join(work, 'harness.py'), [
  'import contextlib, copy, io, json, pathlib, runpy, sys, types',
  'root = pathlib.Path(__file__).resolve().parent',
  'config = json.loads((root / "CLIENT-CONFIG.json").read_text())',
  'base = {"resourceArn":config["arn"], "status":"ACTIVE", "schemaDefinition":config["schema"], "capacitySpecification":{"throughputMode":"PROVISIONED", "readCapacityUnits":100, "writeCapacityUnits":50}, "encryptionSpecification":{"type":"CUSTOMER_MANAGED_KMS_KEY", "kmsKeyIdentifier":config["kms"]}, "pointInTimeRecovery":{"status":"ENABLED"}, "defaultTimeToLive":3600, "ttl":{"status":"ENABLED"}, "clientSideTimestamps":{"status":"ENABLED"}}',
  'class Session:',
  '    def __init__(self, region_name): assert region_name == "us-east-1"',
  '    def client(self, name):',
  '        assert name in ["sts", "keyspaces"]; return self',
  '    def get_caller_identity(self): return {"Account":"000000000000" if scenario == "account" else "123456789012"}',
  '    def get_keyspace(self, **kwargs):',
  '        assert kwargs == {"keyspaceName":"application"}',
  '        if scenario == "sdk": raise RuntimeError("mock keyspace metadata failure")',
  '        return {"resourceArn":"other" if scenario == "keyspace-arn" else config["arn"].split("/table/")[0] + "/", "replicationStrategy":"MULTI_REGION" if scenario == "multi-region" else "SINGLE_REGION"}',
  '    def get_table(self, **kwargs):',
  '        assert scenario != "account"',
  '        assert kwargs == {"keyspaceName":"application", "tableName":"records"}',
  '        if scenario == "sdk": raise RuntimeError("mock metadata failure")',
  '        table = copy.deepcopy(base)',
  '        if scenario == "arn": table["resourceArn"] = "other"',
  '        if scenario == "state": table["status"] = "CREATING"',
  '        if scenario == "region": table["replicaSpecifications"] = [{"region":"us-west-2"}]',
  '        if scenario == "columns": table["schemaDefinition"]["allColumns"][0]["type"] = "int"',
  '        if scenario == "key-order": table["schemaDefinition"]["partitionKeys"].reverse()',
  '        if scenario == "capacity": table["capacitySpecification"]["readCapacityUnits"] = 99',
  '        if scenario == "key": table["encryptionSpecification"]["kmsKeyIdentifier"] = "other"',
  '        if scenario == "pitr": table["pointInTimeRecovery"]["status"] = "DISABLED"',
  '        if scenario == "ttl": table["defaultTimeToLive"] = 1',
  '        if scenario == "ttl-feature": table["ttl"]["status"] = "DISABLED"',
  '        if scenario == "timestamps": table["clientSideTimestamps"]["status"] = "DISABLED"',
  '        return table',
  'sdk = types.ModuleType("boto3"); sdk.Session = Session; sys.modules["boto3"] = sdk',
  'scenarios = ["valid", "account", "sdk", "arn", "state", "region", "columns", "key-order", "capacity", "key", "pitr", "ttl", "ttl-feature", "timestamps"]',
  'for scenario in scenarios:',
  '    failure = None',
  '    with contextlib.redirect_stdout(io.StringIO()) as output:',
  '        try: runpy.run_path(str(root / "CHECK.py"), run_name="__main__")',
  '        except Exception as error: failure = error',
  '    assert bool(failure) == (scenario != "valid"), (scenario, failure)',
  '    if scenario == "valid": assert json.loads(output.getvalue())["cql_or_rows_tested"] is False',
  'for scenario in ["valid", "account", "sdk", "keyspace-arn", "multi-region"]:',
  '    failure = None',
  '    with contextlib.redirect_stdout(io.StringIO()):',
  '        try: runpy.run_path(str(root / "PREFLIGHT.py"), run_name="__main__")',
  '        except Exception as error: failure = error',
  '    assert bool(failure) == (scenario != "valid"), (scenario, failure)',
  'print("Passed 14 table metadata and five existing-keyspace preflight cases; no AWS/CQL calls or table-row reads.")',
].join('\n'));
const check = spawnSync(process.env.PYTHON_PATH || 'python', [join(work, 'harness.py')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
process.stdout.write(check.stdout || ''); process.stderr.write(check.stderr || '');
if (check.error) throw check.error;
if (check.status !== 0) process.exit(check.status || 1);
console.log(work);
