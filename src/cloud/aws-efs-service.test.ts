import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_EFS_SERVICE } from './aws-efs-service.ts';
import { addServicesFor } from './add-service-catalog.ts';

const values = {
  ...defaultValues(AWS_EFS_SERVICE), aws_region: 'us-east-1', name: 'application-files',
  subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1',
  groups: 'sg-0123456789abcdef0',
};

test('EFS creates an encrypted file system, protected lifecycle and mount-target checks', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-elastic-file-system')?.terraform[0], AWS_EFS_SERVICE);
  const result = AWS_EFS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const main = result.files['main.tf']!;
  assert.match(main, /encrypted\s+= true/);
  assert.match(main, /tags\s+= \{ Name = "application-files" \}/);
  assert.match(main, /prevent_destroy\s+= true/);
  assert.match(main, /availability_zone_id/);
  assert.match(main, /ipv6_native/);
  assert.match(main, /one VPC/);
  assert.match(main, /status\s+= "ENABLED"/);
  assert.doesNotMatch(main, /provisioned_throughput_in_mibps/);
  assert.match(result.files['SERVICE-SETUP.md']!, /isolated restore test/);
});

test('EFS catches invalid network and encryption settings and exports provisioned throughput', () => {
  const invalid = AWS_EFS_SERVICE.build({ ...values, groups: '', subnets: 'invalid',
    throughput: 'provisioned', mibps: 0, kms: 'arn:aws:kms:eu-west-1:123456789012:key/1234abcd' });
  for (const path of ['groups', 'subnets', 'mibps', 'kms']) assert.ok(invalid.findings.some(finding => finding.path === path));
  const valid = AWS_EFS_SERVICE.build({ ...values, throughput: 'provisioned', mibps: 128 });
  assert.deepEqual(valid.findings, []);
  assert.match(valid.files['main.tf']!, /provisioned_throughput_in_mibps\s+= 128/);
});
