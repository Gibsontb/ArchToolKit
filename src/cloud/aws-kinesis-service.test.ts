import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_KINESIS_SERVICE } from './aws-kinesis-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_KINESIS_SERVICE), aws_region: 'us-east-1', account: '123456789012', name: 'application-events' };

test('Kinesis exports encrypted protected on-demand stream without provisioned shards', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'taxonomy:kinesisdatastreams')?.terraform[0], AWS_KINESIS_SERVICE);
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-kinesis')?.terraform[0],AWS_KINESIS_SERVICE);
  const result = AWS_KINESIS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /stream_mode\s+= "ON_DEMAND"/);
  assert.match(code, /encryption_type\s+= "KMS"/);
  assert.match(code, /prevent_destroy\s+= true/);
  assert.match(code, /enforce_consumer_deletion\s+= false/);
  assert.doesNotMatch(code, /shard_count|aws_kinesis_stream_consumer/);
  assert.match(code,/data.aws_caller_identity.current.account_id == "123456789012"/);
  assert.doesNotMatch(result.files['INSPECT.py']!,/put_records\(|get_records\(|get_shard_iterator\(|subscribe_to_shard\(/);
});

test('Kinesis supports provisioned capacity and enhanced fan-out while validating retention and encryption', () => {
  const result = AWS_KINESIS_SERVICE.build({ ...values, mode: 'PROVISIONED', shards: 4, consumer: 'application', retention: 168 });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /shard_count\s+= 4/);
  assert.match(result.files['main.tf']!, /resource "aws_kinesis_stream_consumer"/);
  const invalid = AWS_KINESIS_SERVICE.build({ ...values, mode: 'PROVISIONED', shards: 0, retention: 1, kms: 'arn:aws:kms:us-west-2:123456789012:key/abc' });
  for (const path of ['shards', 'retention', 'kms']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
