import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_ROLESANYWHERE_SERVICE as blueprint } from './aws-rolesanywhere-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'artifact-reader', ca: 'arn:aws:acm-pca:us-east-1:123456789012:certificate-authority/12345678-abcd-4bcd-8bcd-123456789abc', subject: 'artifact-workload', issuer: 'Workload Issuing CA', bucket: 'application-artifacts' };
test('Roles Anywhere creates disabled scoped trust/profile without generating keys or credentials', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'iam-roles-anywhere')?.terraform[0], blueprint);
  const result = blueprint.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/AWS_ACM_PCA/, /aws_rolesanywhere_trust_anchor/, /aws_rolesanywhere_profile/, /enabled\s+= false/, /ignore_changes\s+= \[enabled\]/, /aws:SourceArn/, /aws:SourceAccount/, /x509Subject\/CN/, /x509Issuer\/CN/, /sts:TagSession/, /sts:SetSourceIdentity/, /session_policy/, /s3:GetObject/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /aws_iam_access_key|tls_private_key|s3:PutObject|s3:\*/);
  assert.match(result.files['outputs.tf']!, /credential-process/);
  assert.match(result.files['OPERATE.py']!, /not args.activate/);
  assert.match(result.files['OPERATE.py']!, /crlDpRevocationEnabled/);
  assert.doesNotMatch(result.files['OPERATE.py']!, /create_session\(|get_secret_value|read_text.*key\.pem/);
});
test('Roles Anywhere supports documented GovCloud partition and exact optional object key', () => {
  const result = blueprint.build({ ...values, aws_region: 'us-gov-west-1', ca: values.ca.replace('arn:aws:', 'arn:aws-us-gov:').replace('us-east-1', 'us-gov-west-1'), kms: 'arn:aws-us-gov:kms:us-gov-west-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', duration: '3600' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /arn:aws-us-gov:s3/);
  assert.match(result.files['main.tf']!, /kms:Decrypt/);
});
test('Roles Anywhere rejects wildcard identities, unknown sites, traversal and cross-account keys', () => {
  for (const [key, value] of Object.entries({ subject: '*', issuer: 'Issuer*', name: 'bad/name', ca: 'bad', prefix: '../', bucket: 'bad..bucket', duration: 43200, kms: 'arn:aws:kms:us-east-1:000000000000:key/12345678-abcd-4bcd-8bcd-123456789abc', aws_region: 'cn-north-1' })) assert.ok(blueprint.build({ ...values, [key]: value }).findings.some(f => f.path === key), key);
});
