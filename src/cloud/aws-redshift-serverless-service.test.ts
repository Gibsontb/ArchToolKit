import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_REDSHIFT_SERVERLESS_SERVICE } from './aws-redshift-serverless-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_REDSHIFT_SERVERLESS_SERVICE), aws_region: 'us-east-1', name: 'application-warehouse', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1,subnet-0123456789abcdef2', groups: 'sg-0123456789abcdef0' };
test('Redshift Serverless creates a private TLS warehouse with managed credentials and audit exports', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'redshift-serverless')?.terraform[0], AWS_REDSHIFT_SERVERLESS_SERVICE);
  const result = AWS_REDSHIFT_SERVERLESS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /manage_admin_password\s+= true/);
  assert.match(result.files['main.tf']!, /publicly_accessible\s+= false/);
  assert.match(result.files['main.tf']!, /require_ssl/);
  assert.match(result.files['main.tf']!, /useractivitylog/);
  assert.doesNotMatch(result.files['main.tf']!, /admin_user_password\s*=/);
  assert.match(result.files['outputs.tf']!, /admin_password_secret_arn/);
});
test('Redshift Serverless handles two-AZ non-EVR commercial setup and validates capacities/keys', () => {
  const pair = 'subnet-0123456789abcdef0,subnet-0123456789abcdef1';
  assert.deepEqual(AWS_REDSHIFT_SERVERLESS_SERVICE.build({ ...values, routing: 'off', subnets: pair }).findings, []);
  assert.ok(AWS_REDSHIFT_SERVERLESS_SERVICE.build({ ...values, subnets: pair }).findings.some(finding => finding.path === 'subnets'));
  assert.ok(AWS_REDSHIFT_SERVERLESS_SERVICE.build({ ...values, aws_region: 'us-gov-west-1', routing: 'off', subnets: pair }).findings.some(finding => finding.path === 'subnets'));
  for (const [key, value] of Object.entries({ maximum: 8, kms: 'wrong', name: 'INVALID', groups: '', base: 4 })) assert.ok(AWS_REDSHIFT_SERVERLESS_SERVICE.build({ ...values, base: 16, [key]: value }).findings.some(finding => finding.path === key), key);
  assert.deepEqual(AWS_REDSHIFT_SERVERLESS_SERVICE.build({ ...values, data_role: 'arn:aws:iam::123456789012:role/WarehouseData', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' }).findings, []);
});
