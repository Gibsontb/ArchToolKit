import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_SSM_SESSION_SERVICE as blueprint } from './aws-ssm-session-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'project-session', nodes: 'i-0123456789abcdef0,mi-0123456789abcdef1', operator: 'arn:aws:iam::123456789012:role/SessionOperator', node_roles: 'arn:aws:iam::123456789012:role/ManagedNodes', session_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', log_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abd' };
test('session setup uses a custom audited document and scoped own-session policies', () => {
  const rows = addServicesFor('aws');
  assert.equal(rows.find(row => row.id === 'aws-systems-manager')?.terraform[1], blueprint);
  assert.equal(rows.find(row => row.id === 'taxonomy:systemsmanagersessionmanager')?.terraform[0], blueprint);
  const result = blueprint.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/document_type\s+= "Session"/, /Standard_Stream/, /NotResource/, /managed-instance\/mi-/, /instance\/i-/, /SessionDocumentAccessCheck/, /ssm:resourceTag\/aws:ssmmessages:session-id/, /\$\$\{aws:userid\}/, /GenerateDataKey/, /prevent_destroy/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /AWS-StartSSHSession|StartPortForwarding|AdministratorAccess|SSM-SessionManagerRunShell/);
  const document = JSON.parse(result.files['SESSION-DOCUMENT.json']!);
  assert.equal(document.inputs.runAsEnabled, true);
  assert.equal(document.inputs.runAsDefaultUser, 'session-ops');
  assert.equal(document.inputs.cloudWatchStreamingEnabled, true);
  assert.equal(document.inputs.cloudWatchEncryptionEnabled, true);
  assert.match(result.files['CONNECT.ps1']!, /if \(-not \$Connect\)/);
  assert.match(result.files['CONNECT.ps1']!, /identity.UserId/);
});
test('Windows sessions ignore stale Linux identity and keep timeouts bounded', () => {
  const result = blueprint.build({ ...values, os: 'Windows', user: 'root' });
  assert.deepEqual(result.findings, []);
  const document = JSON.parse(result.files['SESSION-DOCUMENT.json']!);
  assert.equal(document.inputs.runAsEnabled, false);
  assert.equal(document.inputs.runAsDefaultUser, '');
  assert.equal(document.inputs.idleSessionTimeout, '15');
  assert.equal(document.inputs.maxSessionDuration, '60');
});
test('session setup rejects default document replacement, wrong identities, broad node access and invalid keys', () => {
  for (const [key, value] of Object.entries({ name: 'SSM-SessionManagerRunShell', user: 'root', nodes: '*', operator: 'bad', node_roles: values.operator, session_kms: '', log_kms: values.log_kms.replace('us-east-1', 'us-west-2'), idle: 61, maximum: 1, os: 'MacOS' })) assert.ok(blueprint.build({ ...values, [key]: value }).findings.some(f => f.path === key), key);
});
