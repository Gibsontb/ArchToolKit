import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_EBS_SERVICE } from './aws-ebs-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_EBS_SERVICE), aws_region: 'us-east-1', name: 'database-data', subnet: 'subnet-0123456789abcdef0' };

test('EBS exports protected encrypted storage and optional attachment with AZ verification', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-elastic-block-store')?.terraform[0], AWS_EBS_SERVICE);
  const standalone = AWS_EBS_SERVICE.build(values);
  assert.deepEqual(standalone.findings, []);
  assert.match(standalone.files['main.tf']!, /encrypted\s+= true/);
  assert.match(standalone.files['main.tf']!, /tags\s+= \{ Name = "database-data" \}/);
  assert.match(standalone.files['main.tf']!, /prevent_destroy\s+= true/);
  assert.doesNotMatch(standalone.files['main.tf']!, /resource "aws_volume_attachment"/);
  const attached = AWS_EBS_SERVICE.build({ ...values, instance: 'i-0123456789abcdef0' });
  assert.deepEqual(attached.findings, []);
  assert.match(attached.files['main.tf']!, /same Availability Zone/);
  assert.match(attached.files['main.tf']!, /force_detach\s+= false/);
});

test('EBS catches invalid performance ratios, empty capacity and mismatched encryption location', () => {
  const invalid = AWS_EBS_SERVICE.build({ ...values, size: 1, iops: 16000, throughput: 5000,
    kms: 'arn:aws:kms:eu-west-1:123456789012:key/key1' });
  for (const path of ['iops', 'throughput', 'kms']) assert.ok(invalid.findings.some(finding => finding.path === path));
  assert.ok(AWS_EBS_SERVICE.build({ ...values, size: '' }).findings.some(finding => finding.path === 'size'));
});
