import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_ELASTICACHE_SERVICE } from './aws-elasticache-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_ELASTICACHE_SERVICE), aws_region: 'us-east-1', name: 'application', version: '7.2', user_group: 'application-users', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', groups: 'sg-0123456789abcdef0' };

test('ElastiCache exports encrypted Multi-AZ replication with external RBAC and snapshots', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-elasticache')?.terraform[0], AWS_ELASTICACHE_SERVICE);
  const result = AWS_ELASTICACHE_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /num_cache_clusters\s+= 2/);
  assert.match(code, /transit_encryption_mode\s+= "required"/);
  assert.match(code, /at_rest_encryption_enabled\s+= true/);
  assert.match(code, /multi_az_enabled\s+= true/);
  assert.match(code, /snapshot_retention_limit\s+= 7/);
  assert.match(code, /user_group_ids\s+= \["application-users"\]/);
  assert.match(code, /prevent_destroy\s+= true/);
  assert.doesNotMatch(code, /auth_token\s*=/);
});

test('ElastiCache rejects incompatible versions and invalid networks, replica counts or keys', () => {
  const invalid = AWS_ELASTICACHE_SERVICE.build({ ...values, engine: 'redis', version: '6.2', user_group: '', replicas: 0, subnets: 'subnet-0123456789abcdef0', kms: 'arn:aws:kms:us-west-2:123456789012:key/abc' });
  for (const path of ['version', 'user_group', 'replicas', 'subnets', 'kms']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
  assert.deepEqual(AWS_ELASTICACHE_SERVICE.build({ ...values, engine: 'redis', version: '7.1' }).findings, []);
});
