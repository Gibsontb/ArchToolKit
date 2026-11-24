import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_NAT_SERVICE } from './aws-nat-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_NAT_SERVICE), aws_region: 'us-east-1', name: 'application-egress', subnet: 'subnet-0123456789abcdef0' };
test('Public zonal NAT creates its EIP without adding implicit client routes', () => {
  assert.ok(addServicesFor('aws').find(row => row.id === 'amazon-virtual-private-cloud')?.terraform.includes(AWS_NAT_SERVICE));
  const result = AWS_NAT_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /resource "aws_eip"/);
  assert.match(result.files['main.tf']!, /allocation_id\s+= aws_eip.gateway.id/);
  assert.doesNotMatch(result.files['main.tf']!, /resource "aws_route"/);
});
test('Private NAT excludes stale public allocation and guards client route VPC, gateway subnet and existing target', () => {
  const result = AWS_NAT_SERVICE.build({ ...values, connectivity: 'private', allocation: 'invalid', eip_mode: 'EXISTING', routes: 'CREATE', route_tables: 'rtb-0123456789abcdef0,rtb-0123456789abcdef0', destination: '10.100.0.0/16' });
  assert.deepEqual(result.findings, []);
  const main = result.files['main.tf']!;
  assert.doesNotMatch(main, /aws_eip|allocation_id/);
  assert.match(main, /gateway_explicit/);
  assert.match(main, /gateway_main/);
  assert.match(main, /route.nat_gateway_id == aws_nat_gateway.configured.id/);
  assert.match(main, /destination_cidr_block\s+= "10.100.0.0\/16"/);
});
test('NAT rejects malformed allocations and ambiguous/noncanonical route destinations', () => {
  const route = { ...values, routes: 'CREATE', route_tables: 'rtb-0123456789abcdef0' };
  for (const destination of ['10.1.2.3/16', '::/0', '10.0.0.1', 'bad']) assert.ok(AWS_NAT_SERVICE.build({ ...route, destination }).findings.some(finding => finding.path === 'destination'));
  assert.ok(AWS_NAT_SERVICE.build({ ...route, connectivity: 'private', destination: '0.0.0.0/0' }).findings.some(finding => finding.path === 'destination'));
  assert.ok(AWS_NAT_SERVICE.build({ ...values, eip_mode: 'EXISTING', allocation: 'bad' }).findings.some(finding => finding.path === 'allocation'));
  const existing = AWS_NAT_SERVICE.build({ ...values, eip_mode: 'EXISTING', allocation: 'eipalloc-0123456789abcdef0' });
  assert.deepEqual(existing.findings, []);
  assert.doesNotMatch(existing.files['main.tf']!, /resource "aws_eip"/);
});
