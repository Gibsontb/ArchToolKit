import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_TRANSFER_SERVICE } from './aws-transfer-service.ts';
import { transferPublicKey } from './aws-transfer-key.ts';
import { publicTestKey } from '../../tools/service-test-ssh.mjs';
import { addServicesFor } from './add-service-catalog.ts';
const ed = publicTestKey(), rsa = publicTestKey('rsa');
const values = { ...defaultValues(AWS_TRANSFER_SERVICE), aws_region: 'us-east-1', name: 'application-transfer', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', groups: 'sg-0123456789abcdef0', bucket: 'application-files', role: 'arn:aws:iam::123456789012:role/TransferAccess', users: 'alice | ' + ed + '\nbob | ' + ed };
test('Transfer public-key validation checks wire types, sizes, curve fields and FIPS exclusions', () => {
  for (const key of [ed, rsa, ...['nistp256', 'nistp384', 'nistp521'].map(type => publicTestKey(type))]) assert.equal(transferPublicKey(key + ' example-comment', false), key);
  assert.equal(transferPublicKey(ed, true), undefined);
  assert.equal(transferPublicKey(rsa, true), rsa);
  assert.equal(transferPublicKey(publicTestKey('rsa', 1024), false), undefined);
  assert.equal(transferPublicKey(ed.replace('ssh-ed25519 ', 'ssh-rsa '), false), undefined);
  assert.equal(transferPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----', false), undefined);
  assert.equal(transferPublicKey('ssh-ed25519 AAAA', false), undefined);
  assert.equal(transferPublicKey(ed.replace(/=+$/, ''), false), ed);
});
test('Private SFTP scopes distinct logical homes and static per-user session policies', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-transfer-family')?.terraform[0], AWS_TRANSFER_SERVICE);
  const result = AWS_TRANSFER_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  assert.match(main, /endpoint_type\s+= "VPC"/);
  assert.doesNotMatch(main, /address_allocation_ids|transfer:HomeFolder|s3:PutObject|s3:DeleteObject/);
  assert.match(main, /\/application-files\/incoming\/alice/);
  assert.match(main, /\/application-files\/incoming\/bob/);
  assert.match(result.files['outputs.tf']!, /aws:SourceAccount/);
  assert.match(result.files['outputs.tf']!, /user\/%s\/\*/);
  const suggested = JSON.parse(result.files['SUGGESTED-ROLE-PERMISSIONS.json']!);
  assert.deepEqual(suggested.Statement[2].Resource, ['arn:aws:s3:::application-files/incoming/alice/*', 'arn:aws:s3:::application-files/incoming/bob/*']);
});
test('SFTP write/delete and FIPS key choices do not silently broaden permissions', () => {
  for (const access of ['WRITE', 'DELETE']) {
    const result = AWS_TRANSFER_SERVICE.build({ ...values, access, policy: 'TransferSecurityPolicy-FIPS-2025-03', users: 'alice | ' + rsa });
    assert.deepEqual(result.findings, []);
    const actions = JSON.parse(result.files['SUGGESTED-ROLE-PERMISSIONS.json']!).Statement[2].Action;
    assert.ok(actions.includes('s3:PutObject'));
    assert.equal(actions.includes('s3:DeleteObject'), access === 'DELETE');
    assert.equal(actions.includes('s3:DeleteObjectVersion'), false);
  }
  assert.ok(AWS_TRANSFER_SERVICE.build({ ...values, policy: 'TransferSecurityPolicy-FIPS-2025-03' }).findings.some(finding => finding.path === 'users'));
});
test('SFTP rejects invalid usernames, traversal/wildcards and duplicate users', () => {
  for (const users of ['root | ' + ed, 'ab | ' + ed, 'alice | ' + ed + '\nalice | ' + ed]) assert.ok(AWS_TRANSFER_SERVICE.build({ ...values, users }).findings.some(finding => finding.path === 'users'));
  for (const prefix of ['../other', 'incoming/*', 'incoming/', 'incoming//other']) assert.ok(AWS_TRANSFER_SERVICE.build({ ...values, prefix }).findings.some(finding => finding.path === 'prefix'));
});
test('additional SFTP keys support stable per-user rotation while retaining primary addresses', () => {
  const additional = 'alice | laptop | ' + rsa + '\nalice | recovery | ' + publicTestKey('nistp256') + '\nbob | laptop | ' + rsa;
  const result = AWS_TRANSFER_SERVICE.build({ ...values, additional_keys: additional }), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  assert.match(main, /resource "aws_transfer_ssh_key" "user_0"/);
  assert.match(main, /resource "aws_transfer_ssh_key" "additional"/);
  assert.match(main, /"alice\/laptop"/);
  assert.match(main, /"bob\/laptop"/);
  assert.match(main, /create_before_destroy\s+= true/);
  const reordered = AWS_TRANSFER_SERVICE.build({ ...values, additional_keys: additional.split('\n').reverse().join('\n') });
  for (const address of ['alice/laptop', 'alice/recovery', 'bob/laptop']) assert.ok(reordered.files['main.tf']!.includes('"' + address + '"'));
});
test('additional SFTP keys reject unknown users, duplicate material/labels, private keys and FIPS-incompatible keys', () => {
  for (const additional_keys of [
    'unknown | laptop | ' + rsa,
    'alice | laptop | ' + ed + ' comment',
    'alice | laptop | ' + rsa + '\nalice | laptop | ' + publicTestKey('nistp256'),
    'alice | laptop | ' + rsa + '\nalice | second | ' + rsa + ' other-comment',
    'alice | ../ | ' + rsa,
    'alice | laptop | -----BEGIN OPENSSH PRIVATE KEY-----',
  ]) assert.ok(AWS_TRANSFER_SERVICE.build({ ...values, additional_keys }).findings.some(f => f.path === 'additional_keys'));
  assert.ok(AWS_TRANSFER_SERVICE.build({ ...values, users: 'alice | ' + rsa, policy: 'TransferSecurityPolicy-FIPS-2025-03', additional_keys: 'alice | laptop | ' + ed }).findings.some(f => f.path === 'additional_keys'));
});
test('SFTP allows 50 total keys per user and rejects the 51st', () => {
  const extras = Array.from({ length: 50 }, (_, index) => 'alice | key-' + index + ' | ' + publicTestKey());
  assert.deepEqual(AWS_TRANSFER_SERVICE.build({ ...values, users: 'alice | ' + ed, additional_keys: extras.slice(0, 49).join('\n') }).findings, []);
  assert.ok(AWS_TRANSFER_SERVICE.build({ ...values, users: 'alice | ' + ed, additional_keys: extras.join('\n') }).findings.some(f => f.path === 'additional_keys'));
});
