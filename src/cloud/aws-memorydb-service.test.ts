import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_MEMORYDB_SERVICE } from './aws-memorydb-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_MEMORYDB_SERVICE), aws_region: 'us-east-1', name: 'application-memory', role: 'arn:aws:iam::123456789012:role/MemoryApplication', clients: 'sg-0123456789abcdef0', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1' };
test('MemoryDB creates restricted IAM user, exact cluster/user Connect policy and TLS cluster', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-memorydb')?.terraform[0], AWS_MEMORYDB_SERVICE);
  const result = AWS_MEMORYDB_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/type = "iam"/, /tls_enabled\s+= true/, /~application:\* -@all/, /memorydb:Connect/, /aws_memorydb_user.application.arn/, /final_snapshot_name/, /prevent_destroy\s+= true/, /user_name\s+= "application-memory"/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /\+@all|\+scan|\+keys|open-access|passwords\s*=/);
  assert.match(result.files['CHECK.py']!, /ssl_min_version=ssl.TLSVersion.TLSv1_2/);
  assert.match(result.files['CHECK.py']!, /nx=True, ex=60/);
});
test('MemoryDB Redis skips unsupported CLIENT SETINFO ACL and Valkey ignores hidden Redis version', () => {
  assert.deepEqual(AWS_MEMORYDB_SERVICE.build({ ...values, redis_version: 'stale' }).findings, []);
  const redis = AWS_MEMORYDB_SERVICE.build({ ...values, engine: 'redis', redis_version: '7.0', access: 'READWRITE' });
  assert.deepEqual(redis.findings, []);
  assert.doesNotMatch(redis.files['main.tf']!, /client\|setinfo/);
  assert.match(redis.files['main.tf']!, /\+set/);
});
test('MemoryDB rejects default users, global keys and insufficient replica AZs', () => {
  for (const [key, value] of Object.entries({ username: 'default', key_prefix: '*', shards: 0, replicas: '2', role: 'invalid', instance: 'db.r6gd.large', retention: 0 })) assert.ok(AWS_MEMORYDB_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === (key === 'replicas' ? 'subnets' : key)), key);
});
