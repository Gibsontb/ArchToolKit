import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_FSX_OPENZFS_SERVICE } from './aws-fsx-openzfs-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_FSX_OPENZFS_SERVICE), aws_region: 'us-east-1', name: 'application-files', subnet: 'subnet-0123456789abcdef0', groups: 'sg-0123456789abcdef0', clients: '10.0.0.0/16' };
test('OpenZFS creates protected single-AZ 2 storage with explicit exports and backups', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'taxonomy:fsxforopenzfs')?.terraform[0], AWS_FSX_OPENZFS_SERVICE);
  const result = AWS_FSX_OPENZFS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /deployment_type\s+= "SINGLE_AZ_2"/);
  assert.match(result.files['main.tf']!, /throughput_capacity\s+= 160/);
  assert.match(result.files['main.tf']!, /root_squash/);
  assert.match(result.files['main.tf']!, /skip_final_backup\s+= false/);
  assert.match(result.files['main.tf']!, /Name\s+= "application-files"/);
  assert.match(result.files['outputs.tf']!, /dns_name.*:\/fsx/);
});
test('OpenZFS selects deployment-specific throughput and rejects broad/noncanonical client scopes', () => {
  const result = AWS_FSX_OPENZFS_SERVICE.build({ ...values, deployment: 'SINGLE_AZ_1', throughput1: '128', throughput2: 'inactive-invalid', clients: '10.0.1.10/32', root: 'no_root_squash', access: 'ro' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /throughput_capacity\s+= 128/);
  assert.doesNotMatch(result.files['main.tf']!, /inactive-invalid/);
  for (const clients of ['*', '0.0.0.0/0', '10.0.0.1/24', '999.0.0.0/16', '10.0.0.0/016']) assert.ok(AWS_FSX_OPENZFS_SERVICE.build({ ...values, clients }).findings.some(finding => finding.path === 'clients'), clients);
  for (const [key, value] of Object.entries({ storage: 1, retention: 0, backup: '25:00', maintenance: '8:01:00', record: '15', throughput2: '64' })) assert.ok(AWS_FSX_OPENZFS_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});

test('OpenZFS multi-AZ configures preferred/standby placement, explicit endpoint range and client routes', () => {
  const multi = { ...values, deployment: 'MULTI_AZ_1', standby: 'subnet-0123456789abcdef1', routes: 'rtb-0123456789abcdef0', endpoint_range: '10.0.250.0/28' };
  const result = AWS_FSX_OPENZFS_SERVICE.build(multi);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /preferred_subnet_id/);
  assert.match(result.files['main.tf']!, /endpoint_ip_address_range\s+= "10.0.250.0\/28"/);
  assert.match(result.files['main.tf']!, /availability_zone !=/);
  for (const [key, value] of Object.entries({ standby: values.subnet, routes: '', endpoint_range: '10.0.250.1/28' })) assert.ok(AWS_FSX_OPENZFS_SERVICE.build({ ...multi, [key]: value }).findings.some(finding => finding.path === key), key);
  const single = AWS_FSX_OPENZFS_SERVICE.build({ ...values, standby: 'inactive', routes: 'inactive', endpoint_range: 'inactive' });
  assert.deepEqual(single.findings, []);
  assert.doesNotMatch(single.files['main.tf']!, /inactive|endpoint_ip_address_range|preferred_subnet_id/);
});
