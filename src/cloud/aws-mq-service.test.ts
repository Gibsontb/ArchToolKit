import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_MQ_SERVICE } from './aws-mq-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_MQ_SERVICE), aws_region: 'us-east-1', name: 'application-broker', version: '3.13', mode: 'SINGLE_INSTANCE', subnets: 'subnet-0123456789abcdef0', clients: 'sg-0123456789abcdef0', admins: 'sg-0123456789abcdef1' };
test('RabbitMQ broker separates application/admin access and keeps bootstrap password out of generated values', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-mq')?.terraform[0], AWS_MQ_SERVICE);
  const result = AWS_MQ_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /password\s+= var.mq_admin_password/);
  assert.match(result.files['variables.tf']!, /sensitive\s+= true/);
  assert.doesNotMatch(result.files['variables.tf']!, /default\s*=/);
  assert.match(result.files['main.tf']!, /publicly_accessible\s+= false/);
  assert.match(result.files['main.tf']!, /from_port\s+= 5671/);
  assert.match(result.files['main.tf']!, /from_port\s+= 15671/);
  assert.match(result.files['main.tf']!, /prevent_destroy\s+= true/);
  assert.doesNotMatch(result.files['main.tf']!, /console_access|\bgroups\s*=/);
});
test('RabbitMQ cluster requires three distinct subnet IDs and explicit supported regional offering checks', () => {
  const result = AWS_MQ_SERVICE.build({ ...values, mode: 'CLUSTER_MULTI_AZ', subnets: values.subnets + ',subnet-0123456789abcdef1,subnet-0123456789abcdef2', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /availability_zone\]\)\) == 3/);
  assert.match(result.files['main.tf']!, /use_aws_owned_key\s+= false/);
  assert.match(result.files['PREFLIGHT.ps1']!, /NextToken/);
  assert.match(result.files['PREFLIGHT.ps1']!, /\$_.SupportedDeploymentModes/);
  assert.doesNotMatch(result.files['PREFLIGHT.ps1']!, /AvailabilityZones.SupportedDeploymentModes/);
});
test('RabbitMQ rejects unsupported user characters and incomplete topology', () => {
  for (const [key, value] of Object.entries({ username: 'guest', subnets: '', admins: '', clients: '', version: 'latest', maintenance_time: '25:00', kms: 'bad' })) assert.ok(AWS_MQ_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  assert.ok(AWS_MQ_SERVICE.build({ ...values, username: 'bad~user' }).findings.some(finding => finding.path === 'username'));
  assert.ok(AWS_MQ_SERVICE.build({ ...values, mode: 'CLUSTER_MULTI_AZ' }).findings.some(finding => finding.path === 'subnets'));
});
