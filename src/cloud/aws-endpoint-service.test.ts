import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_ENDPOINT_SERVICE } from './aws-endpoint-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_ENDPOINT_SERVICE), aws_region: 'us-east-1', name: 'private-ssm', vpc: 'vpc-0123456789abcdef0', subnets: 'subnet-0123456789abcdef0', groups: 'sg-0123456789abcdef0' };

test('AWS service endpoint configures interface networking and DNS preconditions', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'taxonomy:privatelink')?.terraform[0], AWS_ENDPOINT_SERVICE);
  const result = AWS_ENDPOINT_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /vpc_endpoint_type\s+= "Interface"/);
  assert.match(code, /private_dns_enabled\s+= true/);
  assert.match(code, /enable_dns_hostnames/);
  assert.match(code, /availability_zones/);
  assert.doesNotMatch(code, /route_table_ids/);
});

test('AWS gateway endpoints select route tables and ignore interface-only values', () => {
  const result = AWS_ENDPOINT_SERVICE.build({ ...values, type: 'Gateway', routes: 'rtb-0123456789abcdef0', subnets: '', groups: '' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /route_table_ids\s+= \["rtb-0123456789abcdef0"\]/);
  assert.doesNotMatch(result.files['main.tf']!, /private_dns_enabled|security_group_ids|subnet_ids/);
  const invalid = AWS_ENDPOINT_SERVICE.build({ ...values, aws_region: 'cn-north-1', policy: '[]', groups: '' });
  for (const path of ['service_name', 'policy', 'groups']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
