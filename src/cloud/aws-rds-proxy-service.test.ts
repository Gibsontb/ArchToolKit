import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_RDS_PROXY_SERVICE } from './aws-rds-proxy-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_RDS_PROXY_SERVICE), aws_region: 'us-east-1', name: 'application-proxy', target: 'application-db', secret: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:application/database-abcdef', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', groups: 'sg-0123456789abcdef0' };

test('RDS Proxy creates scoped secret role, TLS pool and cluster registration', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'taxonomy:rdsproxy')?.terraform[0], AWS_RDS_PROXY_SERVICE);
  const result = AWS_RDS_PROXY_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /secretsmanager:GetSecretValue/);
  assert.match(code, /require_tls\s+= true/);
  assert.match(code, /debug_logging\s+= false/);
  assert.match(code, /db_cluster_identifier\s+= "application-db"/);
  assert.match(code, /connection_pool_config/);
  assert.doesNotMatch(code, /GetSecretValue.*\*/);
});

test('RDS Proxy supports instance targets and client IAM while rejecting invalid credentials or pool bounds', () => {
  const result = AWS_RDS_PROXY_SERVICE.build({ ...values, target_type: 'instance', family: 'MYSQL', iam: 'REQUIRED', kms: 'arn:aws:kms:us-east-1:123456789012:key/abc' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /db_instance_identifier/);
  assert.match(result.files['main.tf']!, /iam_auth\s+= "REQUIRED"/);
  assert.match(result.files['main.tf']!, /kms:Decrypt/);
  const invalid = AWS_RDS_PROXY_SERVICE.build({ ...values, secret: values.secret.replace('us-east-1', 'us-west-2'), connections: 40, idle: 80, subnets: '' });
  for (const path of ['secret', 'idle', 'subnets']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
