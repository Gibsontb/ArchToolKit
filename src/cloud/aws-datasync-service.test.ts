import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_DATASYNC_SERVICE } from './aws-datasync-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_DATASYNC_SERVICE), aws_region: 'us-east-1', name: 'application-transfer', source_bucket: 'application-source', destination_bucket: 'application-destination', source_role: 'arn:aws:iam::123456789012:role/DataSyncSource', destination_role: 'arn:aws:iam::123456789012:role/DataSyncDestination' };
test('DataSync creates two locations and a manually started transfer preserving destination deletions', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-datasync')?.terraform[0], AWS_DATASYNC_SERVICE);
  const result = AWS_DATASYNC_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /preserve_deleted_files\s+= "PRESERVE"/);
  assert.match(result.files['main.tf']!, /overwrite_mode\s+= "NEVER"/);
  assert.match(result.files['main.tf']!, /bytes_per_second\s+= -1/);
  assert.match(result.files['main.tf']!, /aws:SourceAccount/);
  assert.doesNotMatch(result.files['main.tf']!, /schedule_expression|start-task-execution/);
});
test('DataSync policy examples keep list constraints separate from metadata and scope destination writes', () => {
  const result = AWS_DATASYNC_SERVICE.build({ ...values, source_prefix: '/exports/', destination_prefix: '/landing/', bandwidth: 12.5, overwrite: 'ALWAYS', tags: 'NONE' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /bytes_per_second\s+= 12500000/);
  const policy = JSON.parse(result.files['DESTINATION-ACCESS.json']!);
  assert.equal(policy.Statement[0].Condition, undefined);
  assert.equal(policy.Statement[1].Condition.StringLike['s3:prefix'][1], 'landing/*');
  assert.equal(policy.Statement[2].Resource, 'arn:aws:s3:::application-destination/landing/*');
  assert.ok(!policy.Statement[2].Action.includes('s3:DeleteObject'));
  assert.ok(!policy.Statement[2].Action.includes('s3:PutObjectTagging'));
  for (const [key, value] of Object.entries({ destination_bucket: values.source_bucket, source_prefix: '/a/../b/', destination_role: 'invalid', bandwidth: -1, overwrite: 'REMOVE' })) assert.ok(AWS_DATASYNC_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
