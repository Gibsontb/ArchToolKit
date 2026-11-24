import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_OPENSEARCH_SERVERLESS_SERVICE } from './aws-opensearch-serverless-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_OPENSEARCH_SERVERLESS_SERVICE), aws_region: 'us-east-1', name: 'application-search', roles: 'arn:aws:iam::123456789012:role/SearchClient', endpoints: 'vpce-0123456789abcdef0' };
test('Serverless search configures private encryption/network/data access and scoped client IAM', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'taxonomy:opensearchserverless')?.terraform[0], AWS_OPENSEARCH_SERVERLESS_SERVICE);
  const result = AWS_OPENSEARCH_SERVERLESS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /SourceVPCEs/);
  assert.match(result.files['main.tf']!, /APIAccessAll/);
  assert.match(result.files['main.tf']!, /prevent_destroy\s+= true/);
  assert.doesNotMatch(result.files['main.tf']!, /DashboardsAccessAll|aoss:DeleteIndex|aoss:WriteDocument/);
  assert.equal(JSON.parse(result.files['INDEX-MAPPING.json']!).mappings.properties.content.type, 'text');
});
test('Serverless vector setup handles explicit public/ingest/dashboard choices and ignores private leftovers', () => {
  const result = AWS_OPENSEARCH_SERVERLESS_SERVICE.build({ ...values, network: 'PUBLIC', endpoints: 'inactive-invalid-id', type: 'VECTORSEARCH', dimensions: 768, access: 'INGEST', dashboards: 'yes', encryption: 'KMS', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' });
  assert.deepEqual(result.findings, []);
  assert.doesNotMatch(result.files['main.tf']!, /SourceVPCEs|inactive-invalid-id/);
  assert.match(result.files['main.tf']!, /dashboards\/default/);
  assert.match(result.files['main.tf']!, /aoss:WriteDocument/);
  assert.equal(JSON.parse(result.files['INDEX-MAPPING.json']!).mappings.properties.embedding.dimension, 768);
  for (const [key, value] of Object.entries({ roles: '', endpoints: '', name: 'INVALID', access: 'ALL', network: 'NONE' })) assert.ok(AWS_OPENSEARCH_SERVERLESS_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  assert.ok(AWS_OPENSEARCH_SERVERLESS_SERVICE.build({ ...values, type: 'VECTORSEARCH', dimensions: 0 }).findings.some(finding => finding.path === 'dimensions'));
});
