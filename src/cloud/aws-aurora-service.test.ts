import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_AURORA_SERVICE } from './aws-aurora-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_AURORA_SERVICE), aws_region: 'us-east-1', name: 'application-db', version: '16.6', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', groups: 'sg-0123456789abcdef0' };

test('Aurora provisions private encrypted cluster instances with managed credentials and backups', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-aurora')?.terraform[0], AWS_AURORA_SERVICE);
  const result = AWS_AURORA_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /manage_master_user_password\s+= true/);
  assert.match(code, /publicly_accessible\s+= false/);
  assert.match(code, /count\s+= 2/);
  assert.match(code, /deletion_protection\s+= true/);
  assert.match(code, /skip_final_snapshot\s+= false/);
  assert.doesNotMatch(code, /master_password\s*=/);
});

test('Aurora Serverless v2 uses provisioned engine mode and capacity per db.serverless instance', () => {
  const result = AWS_AURORA_SERVICE.build({ ...values, capacity: 'serverless', min_acu: 1, max_acu: 8 });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /engine_mode\s+= "provisioned"/);
  assert.match(result.files['main.tf']!, /instance_class\s+= "db.serverless"/);
  assert.match(result.files['main.tf']!, /serverlessv2_scaling_configuration/);
});

test('Aurora rejects invalid capacity ranges, credentials, network IDs and backup retention', () => {
  const result = AWS_AURORA_SERVICE.build({ ...values, capacity: 'serverless', min_acu: 2.3, max_acu: 1, username: 'rdsadmin', subnets: '', retention: 0 });
  for (const path of ['min_acu', 'username', 'subnets', 'retention']) assert.ok(result.findings.some(finding => finding.path === path), path);
});
