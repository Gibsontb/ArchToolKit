import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_OPENSEARCH_DOMAIN_SERVICE } from './aws-opensearch-domain-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_OPENSEARCH_DOMAIN_SERVICE), aws_region: 'us-east-1', name: 'application-search', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1,subnet-0123456789abcdef2', clients: 'sg-0123456789abcdef0', admin: 'arn:aws:iam::123456789012:role/SearchMaster', applications: 'arn:aws:iam::123456789012:role/SearchApplication' };
test('Provisioned OpenSearch uses private encrypted IAM security and retained audit logs', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-opensearch-service')?.terraform[0], AWS_OPENSEARCH_DOMAIN_SERVICE);
  const result = AWS_OPENSEARCH_DOMAIN_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const main = result.files['main.tf']!;
  for (const pattern of [/vpc_options/, /enforce_https\s+= true/, /node_to_node_encryption/, /internal_user_database_enabled\s+= false/, /dedicated_master_count\s+= 3/, /AUDIT_LOGS/, /aws:SourceArn/, /prevent_destroy\s+= true/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /master_user_password|0\.0\.0\.0/);
  assert.doesNotMatch(main, /= "jsonencode/);
  const role = JSON.parse(result.files['SECURITY-ROLE.json']!);
  assert.deepEqual(role.index_permissions[0].index_patterns, ['application-*']);
  assert.deepEqual(role.index_permissions[0].allowed_actions, ['read', 'write', 'create_index']);
  assert.deepEqual(JSON.parse(result.files['SECURITY-MAPPING.json']!).backend_roles, [values.applications]);
  assert.match(result.files['opensearch_client.py']!, /SigV4Auth/);
  assert.doesNotMatch(result.files['opensearch_client.py']!, /verify=False|CERT_NONE/);
  assert.match(result.files['SETUP-ACCESS.py']!, /if not args.apply/);
  assert.match(result.files['SETUP-ACCESS.py']!, /if error.code != 404: raise/);
});
test('Single-AZ search ignores hidden master values and has no zone-awareness block', () => {
  const result = AWS_OPENSEARCH_DOMAIN_SERVICE.build({ ...values, topology: '1', nodes: 1, subnets: 'subnet-0123456789abcdef0', master_type: 'stale' });
  assert.deepEqual(result.findings, []);
  assert.doesNotMatch(result.files['main.tf']!, /zone_awareness_config|dedicated_master_type|stale/);
  assert.match(result.files['main.tf']!, /dedicated_master_enabled\s+= false/);
});
test('Search rejects invalid sizes, network cardinality and cross-account application roles', () => {
  for (const [key, value] of Object.entries({ name: 'X', version: 'latest', nodes: 2, storage: 0, subnets: 'subnet-0123456789abcdef0', clients: 'invalid', admin: 'invalid', index: '*', applications: 'arn:aws:iam::000000000000:role/Application' })) assert.ok(AWS_OPENSEARCH_DOMAIN_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
