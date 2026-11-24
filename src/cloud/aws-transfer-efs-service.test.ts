import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_TRANSFER_EFS_SERVICE as blueprint } from './aws-transfer-efs-service.ts';
import { publicTestKey } from '../../tools/service-test-ssh.mjs';
import { addServicesFor } from './add-service-catalog.ts';
const key = publicTestKey(), second = publicTestKey('nistp256');
const values = { ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'application-efs-sftp', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: 'sg-0123456789abcdef0', filesystem: 'fs-0123456789abcdef0', role: 'arn:aws:iam::123456789012:role/TransferEfs', logging_role: 'arn:aws:iam::123456789012:role/TransferLogs', users: 'alice | 1001 | 1001 | ' + key + '\nalice | 1001 | 1001 | ' + second + '\nbob | 1002 | 1002 | ' + key };
test('EFS SFTP preserves S3, configures real POSIX/logical users and blocks root/write by default', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-transfer-family')?.terraform[1], blueprint);
  const result = blueprint.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/domain\s+= "EFS"/, /posix_profile/, /home_directory_mappings/, /ClientRootAccess/, /ClientWrite/, /"Deny"/, /from_port\s+= 22/, /aws_transfer_ssh_key/, /prevent_destroy/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /s3:GetObject|address_allocation_ids|local-exec|remote-exec|ClientRootAccess.*Allow/);
  const profiles = JSON.parse(result.files['USER-PROFILES.json']!);
  assert.equal(profiles.alice.keys, 2);
  assert.equal(profiles.alice.uid, 1001);
  assert.equal(profiles.alice.path, '/fs-0123456789abcdef0/transfer/alice');
  assert.match(result.files['HOME-PREPARATION.txt']!, /install -d -m 0700 -o 1001 -g 1001/);
});
test('EFS users and keys retain identities through row reordering and distinguish punctuation', () => {
  const users = ['a.b | 1001 | 1001 | ' + key, 'a-b | 1002 | 1002 | ' + second, 'constructor | 1003 | 1003 | ' + key];
  for (const rows of [users, [...users].reverse()]) {
    const result = blueprint.build({ ...values, users: rows.join('\n'), access: 'WRITE' });
    assert.deepEqual(result.findings, []);
    const profiles = JSON.parse(result.files['USER-PROFILES.json']!);
    assert.equal(Object.keys(profiles).length, 3);
    for (const name of ['a.b', 'a-b', 'constructor']) assert.ok(result.files['main.tf']!.includes('"' + name + '"'));
    assert.match(result.files['main.tf']!, /for_each/);
  }
});
test('EFS SFTP rejects root/shared UIDs, identity drift, invalid keys and unrelated logging roles', () => {
  for (const users of [
    'root | 1001 | 1001 | ' + key,
    'alice | 0 | 1001 | ' + key,
    'alice | 1001 | 1001 | ' + key + '\nbob | 1001 | 1002 | ' + second,
    'alice | 1001 | 1001 | ' + key + '\nalice | 1002 | 1001 | ' + second,
    'alice | 1001 | 1001 | ' + key + '\nalice | 1001 | 1001 | ' + key,
    'alice | 1001 | 1001 | PRIVATE',
  ]) assert.ok(blueprint.build({ ...values, users }).findings.some(f => f.path === 'users'));
  for (const [field, value] of Object.entries({ prefix: '../', filesystem: 'invalid', role: 'bad', logging_role: values.role, access: 'DELETE', clients: 'bad' })) assert.ok(blueprint.build({ ...values, [field]: value }).findings.some(f => f.path === field), field);
  assert.ok(blueprint.build({ ...values, policy: 'TransferSecurityPolicy-FIPS-2025-03' }).findings.some(f => f.path === 'users'));
});
test('EFS enforces its 50-public-key user quota', () => {
  const rows = Array.from({ length: 51 }, () => 'alice | 1001 | 1001 | ' + publicTestKey());
  assert.deepEqual(blueprint.build({ ...values, users: rows.slice(0, 50).join('\n') }).findings, []);
  assert.ok(blueprint.build({ ...values, users: rows.join('\n') }).findings.some(f => f.path === 'users'));
});
