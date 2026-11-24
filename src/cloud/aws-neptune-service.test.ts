import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_NEPTUNE_SERVICE } from './aws-neptune-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_NEPTUNE_SERVICE), aws_region: 'us-east-1', name: 'application-graph', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: 'sg-0123456789abcdef0', reader: 'arn:aws:iam::123456789012:role/GraphReader' };
test('Neptune creates encrypted private IAM database with exact offering/AZ guards and audit collection', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-neptune')?.terraform[0], AWS_NEPTUNE_SERVICE);
  const result = AWS_NEPTUNE_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/iam_database_authentication_enabled\s+= true/, /publicly_accessible\s+= false/, /storage_encrypted\s+= true/, /cluster_resource_id/, /:neptune-db:/, /neptune_enable_audit_log/, /pending-reboot/, /deletion_protection\s+= true/, /skip_final_snapshot\s+= false/, /availability_zone\s+= element/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /neptune-db:\*|WriteDataViaQuery|DeleteDataViaQuery|= "jsonencode/);
  assert.match(result.files['CHECK.py']!, /RETURN 1 AS readiness/);
  assert.match(result.files['CHECK.py']!, /verify=True/);
});
test('Neptune Serverless ignores provisioned class and adds separate scoped writer', () => {
  const result = AWS_NEPTUNE_SERVICE.build({ ...values, mode: 'SERVERLESS', instance: 'stale', writer: 'arn:aws:iam::123456789012:role/GraphWriter' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /db.serverless/);
  assert.match(result.files['main.tf']!, /serverless_v2_scaling_configuration/);
  assert.match(result.files['main.tf']!, /DeleteDataViaQuery/);
  assert.doesNotMatch(result.files['main.tf']!, /stale/);
  assert.deepEqual(AWS_NEPTUNE_SERVICE.build({ ...values, minimum: 'stale', maximum: 'stale' }).findings, []);
});
test('Neptune rejects invalid instance capacity, roles and network selections', () => {
  for (const [key, value] of Object.entries({ reader: 'invalid', writer: values.reader, subnets: 'subnet-0123456789abcdef0', clients: '*', version: 'latest', retention: 0, snapshot: 'bad--snapshot' })) assert.ok(AWS_NEPTUNE_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  assert.ok(AWS_NEPTUNE_SERVICE.build({ ...values, mode: 'SERVERLESS', minimum: 2.6 }).findings.some(finding => finding.path === 'minimum'));
});
