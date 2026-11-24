import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_ATHENA_SERVICE } from './aws-athena-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_ATHENA_SERVICE), aws_region: 'us-east-1', name: 'application-query', bucket: 'application-query-results', owner: '123456789012' };
test('Athena enforces encrypted result scope and converts decimal GB once to bytes', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-athena')?.terraform[0], AWS_ATHENA_SERVICE);
  const result = AWS_ATHENA_SERVICE.build({ ...values, limit: 0.02 });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /bytes_scanned_cutoff_per_query\s+= 20000000/);
  assert.match(result.files['main.tf']!, /enforce_workgroup_configuration\s+= true/);
  assert.match(result.files['main.tf']!, /expected_bucket_owner\s+= "123456789012"/);
  assert.match(result.files['main.tf']!, /prevent_destroy\s+= true/);
  assert.equal(JSON.parse(result.files['QUERY-EXAMPLE.json']!).WorkGroup, 'application-query');
  assert.ok(AWS_ATHENA_SERVICE.build({ ...values, limit: 0.01 }).findings.some(finding => finding.path === 'limit'));
});
test('Athena supports KMS results and rejects ambiguous or unsafe placements', () => {
  assert.deepEqual(AWS_ATHENA_SERVICE.build({ ...values, encryption: 'SSE_KMS', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' }).findings, []);
  for (const [key, value] of Object.entries({ name: 'primary', owner: '123', prefix: '../results/', limit: 0.001, encryption: 'NONE', engine: 'Spark' })) assert.ok(AWS_ATHENA_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  const switched = AWS_ATHENA_SERVICE.build({ ...values, kms: 'old-key' });
  assert.deepEqual(switched.findings, []);
  assert.doesNotMatch(switched.files['main.tf']!, /old-key/);
  assert.ok(AWS_ATHENA_SERVICE.build({ ...values, encryption: 'SSE_KMS', kms: 'arn:aws:kms:us-west-2:123456789012:key/test' }).findings.some(finding => finding.path === 'kms'));
});
