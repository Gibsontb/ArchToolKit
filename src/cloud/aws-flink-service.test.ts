import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_FLINK_SERVICE } from './aws-flink-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_FLINK_SERVICE), aws_region: 'us-east-1', name: 'application-flink', role: 'arn:aws:iam::123456789012:role/FlinkExecution', bucket: 'application-artifacts', key: 'flink/application.jar', object_version: 'approved-version-123' };
test('Managed Flink pins a reviewed artifact, enables recovery and leaves execution stopped', () => {
  const rows = addServicesFor('aws');
  for (const id of ['taxonomy:kinesisdataanalytics', 'amazon-managed-service-for-apache-flink']) assert.equal(rows.find(row => row.id === id)?.terraform[0], AWS_FLINK_SERVICE);
  const result = AWS_FLINK_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/object_version\s+= "approved-version-123"/, /s3:GetObjectVersion/, /s3:VersionId/, /checkpointing_enabled\s+= true/, /snapshots_enabled\s+= true/, /allow_non_restored_state\s+= false/, /start_application\s+= false/, /ignore_changes\s+= \[start_application\]/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /s3:PutObject|kinesis:\*|= "jsonencode/);
  assert.match(result.files['OPERATE.ps1']!, /ConfirmFresh/);
  assert.match(result.files['OPERATE.ps1']!, /No READY snapshot/);
  assert.match(result.files['PREFLIGHT.ps1']!, /--version-id/);
});
test('Flink private properties/network are configured without stale hidden inputs', () => {
  assert.deepEqual(AWS_FLINK_SERVICE.build({ ...values, subnets: 'stale', groups: 'stale' }).findings, []);
  const result = AWS_FLINK_SERVICE.build({ ...values, private: 'YES', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', groups: 'sg-0123456789abcdef0', properties: '{"environment":"pilot"}' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /vpc_configuration/);
  assert.match(result.files['main.tf']!, /property_group_id\s+= "application"/);
});
test('Flink rejects unpinned code, invalid property maps and unsupported capacity', () => {
  for (const [key, value] of Object.entries({ object_version: 'null', key: '../application.jar', properties: '{"bad":1}', parallelism: 0, per_kpu: 3, runtime: 'SQL-1_0', role: 'invalid' })) assert.ok(AWS_FLINK_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
