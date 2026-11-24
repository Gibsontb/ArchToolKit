import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_CLOUDTRAIL_SERVICE } from './aws-cloudtrail-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_CLOUDTRAIL_SERVICE), aws_region: 'us-east-1', name: 'application-audit', bucket: 'example-application-audit-123456789012' };

test('CloudTrail exports protected encrypted storage with scoped delivery and integrity validation', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-cloudtrail')?.terraform[0], AWS_CLOUDTRAIL_SERVICE);
  const result = AWS_CLOUDTRAIL_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  for (const expected of ['aws:SourceArn', 'bucket-owner-full-control', 'aws:SecureTransport', 'AWSLogs', 'aws_s3_bucket_versioning']) assert.ok(code.includes(expected), expected);
  assert.match(code, /enable_log_file_validation\s+= true/);
  assert.match(code, /is_multi_region_trail\s+= true/);
  assert.match(code, /sse_algorithm\s+= "AES256"/);
  assert.match(code, /include_management_events\s+= true/);
  assert.match(code, /prevent_destroy\s+= true/);
  assert.doesNotMatch(code, /aws_s3_bucket_lifecycle_configuration/);
});

test('CloudTrail handles regional KMS and rejects invalid trail, storage and event settings', () => {
  const kms = 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012';
  const result = AWS_CLOUDTRAIL_SERVICE.build({ ...values, kms, multi_region: false, events: 'WriteOnly', logging: false });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /sse_algorithm\s+= "aws:kms"/);
  assert.match(result.files['main.tf']!, /enable_logging\s+= false/);
  const invalid = AWS_CLOUDTRAIL_SERVICE.build({ ...values, name: 'a', bucket: 'Bad_Bucket', events: 'none', kms: kms.replace('us-east-1', 'us-west-2') });
  for (const path of ['name', 'bucket', 'events', 'kms']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
