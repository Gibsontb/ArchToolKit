import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_FIREHOSE_SERVICE } from './aws-firehose-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_FIREHOSE_SERVICE), aws_region: 'us-east-1', name: 'application-events', role: 'arn:aws:iam::123456789012:role/FirehoseDelivery', bucket: 'application-delivery', prefix: 'events/' };
test('Firehose direct setup scopes delivery and enables encrypted buffering', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-data-firehose')?.terraform[0], AWS_FIREHOSE_SERVICE);
  const result = AWS_FIREHOSE_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /server_side_encryption/);
  assert.match(result.files['main.tf']!, /AWS_OWNED_CMK/);
  assert.match(result.files['main.tf']!, /application-delivery\/events\/\*/);
  assert.doesNotMatch(result.files['main.tf']!, /kinesis_source_configuration/);
  const records = JSON.parse(result.files['EXAMPLE-RECORDS.json']!);
  assert.equal(records.length, 2);
  assert.ok(atob(records[0].Data).endsWith('\n'));
  assert.match(result.files['SEND-EXAMPLE.ps1']!, /if \(-not \$Send\)/);
  assert.match(result.files['SEND-EXAMPLE.ps1']!, /failed-record-indices/);
});
test('Kinesis source excludes direct buffer settings and resolves source encryption', () => {
  const result = AWS_FIREHOSE_SERVICE.build({ ...values, source: 'KINESIS', stream: 'arn:aws:kinesis:us-east-1:123456789012:stream/events', buffer_kms: 'stale' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /kinesis_source_configuration/);
  assert.match(result.files['main.tf']!, /encryption_type == "KMS"/);
  assert.doesNotMatch(result.files['main.tf']!, /server_side_encryption|stale/);
  assert.ok(JSON.parse(result.files['EXAMPLE-RECORDS.json']!).every((record: { PartitionKey?: string }) => record.PartitionKey));
});
test('Firehose rejects invalid boundaries and unsupported delivery settings', () => {
  for (const [key, value] of Object.entries({ name: '', role: 'invalid', bucket: 'invalid bucket', prefix: '../events/', size: 0, interval: 1, compression: 'invalid', destination_kms: 'invalid' })) {
    assert.ok(AWS_FIREHOSE_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  }
  assert.ok(AWS_FIREHOSE_SERVICE.build({ ...values, source: 'KINESIS', stream: 'arn:aws:kinesis:eu-west-1:123456789012:stream/events' }).findings.some(finding => finding.path === 'stream'));
});
