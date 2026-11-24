import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_CLOUDMAP_SERVICE } from './aws-cloudmap-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_CLOUDMAP_SERVICE), aws_region: 'us-east-1', namespace: 'internal.example.com', name: 'orders', vpc: 'vpc-0123456789abcdef0', instances: 'orders-a | 10.0.1.10 |\norders-b | 10.0.2.10 |' };
test('Cloud Map registers repeatable IPv4 endpoints and protects private namespace/service ownership', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-cloud-map')?.terraform[0], AWS_CLOUDMAP_SERVICE);
  const result = AWS_CLOUDMAP_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /AWS_INSTANCE_IPV4/);
  assert.match(result.files['main.tf']!, /orders-b/);
  assert.match(result.files['main.tf']!, /UNHEALTHY/);
  assert.match(result.files['main.tf']!, /enable_dns_support/);
  assert.doesNotMatch(result.files['main.tf']!, /AWS_INSTANCE_PORT/);
  assert.match(result.files['SERVICE-SETUP.md']!, /fail-open/);
});
test('Cloud Map SRV preserves explicit ports and rejects duplicates, missing ports and invalid addresses', () => {
  const result = AWS_CLOUDMAP_SERVICE.build({ ...values, record: 'SRV', name: '_orders._tcp', instances: 'orders-a | 10.0.1.10 | 8443', routing: 'WEIGHTED' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /AWS_INSTANCE_PORT\s+= "8443"/);
  for (const instances of ['a | 10.0.1.1 |\na | 10.0.2.1 |', 'a | 999.0.0.1 |', 'a | 127.0.0.1 |']) assert.ok(AWS_CLOUDMAP_SERVICE.build({ ...values, instances }).findings.some(finding => finding.path === 'instances'));
  assert.ok(AWS_CLOUDMAP_SERVICE.build({ ...values, record: 'SRV' }).findings.some(finding => finding.path === 'instances'));
});
