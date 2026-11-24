import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_IDENTITY_CENTER_SERVICE } from './aws-identity-center-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_IDENTITY_CENTER_SERVICE), aws_region: 'us-east-1', name: 'ApplicationReadOnly', instance: 'arn:aws:sso:::instance/ssoins-0123456789abcdef' };

test('Identity Center creates a permission set without granting an account assignment by default', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-iam-identity-center')?.terraform[0], AWS_IDENTITY_CENTER_SERVICE);
  const result = AWS_IDENTITY_CENTER_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /policy\/ReadOnlyAccess/);
  assert.match(result.files['main.tf']!, /aws_ssoadmin_instances.available.arns/);
  assert.doesNotMatch(result.files['main.tf']!, /resource "aws_ssoadmin_account_assignment"/);
});

test('Identity Center assignment uses explicit account and principal and validates partition/session', () => {
  const result = AWS_IDENTITY_CENTER_SERVICE.build({ ...values, assign: true, account: '123456789012', principal: '12345678-abcd-abcd-abcd-123456789abc' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /principal_type\s+= "GROUP"/);
  assert.match(result.files['main.tf']!, /depends_on\s+= \[aws_ssoadmin_managed_policy_attachment.configured\]/);
  const invalid = AWS_IDENTITY_CENTER_SERVICE.build({ ...values, assign: true, account: 'invalid', principal: 'display-name', duration: 'PT13H', aws_region: 'us-gov-west-1' });
  for (const path of ['account', 'principal', 'duration', 'instance']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
