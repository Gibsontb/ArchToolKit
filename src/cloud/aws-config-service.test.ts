import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_CONFIG_SERVICE } from './aws-config-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_CONFIG_SERVICE), aws_region: 'us-east-1', name: 'application-config', bucket: 'example-application-config-123456789012' };

test('AWS Config creates enabled recording only after its protected delivery channel exists', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-config')?.terraform[0], AWS_CONFIG_SERVICE);
  const result = AWS_CONFIG_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /AWS_ConfigRole/);
  assert.match(code, /AWS:SourceAccount/);
  assert.match(code, /bucket-owner-full-control/);
  assert.match(code, /is_enabled\s+= true/);
  assert.match(code, /depends_on\s+= \[aws_config_delivery_channel.configured\]/);
  assert.match(code, /all_supported\s+= true/);
  assert.match(code, /prevent_destroy\s+= true/);
});

test('AWS Config selects explicit resource types and rejects empty coverage', () => {
  const selected = AWS_CONFIG_SERVICE.build({ ...values, all: false, types: 'AWS::EC2::Instance,AWS::S3::Bucket' });
  assert.deepEqual(selected.findings, []);
  assert.match(selected.files['main.tf']!, /resource_types\s+= \["AWS::EC2::Instance", "AWS::S3::Bucket"\]/);
  const invalid = AWS_CONFIG_SERVICE.build({ ...values, all: false, types: '', frequency: 'daily' });
  for (const path of ['types', 'frequency']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
