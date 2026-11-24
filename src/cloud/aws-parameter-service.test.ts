import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_PARAMETER_SERVICE } from './aws-parameter-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_PARAMETER_SERVICE), aws_region: 'us-east-1', name: '/production/orders/api-url', value: 'https://orders.example.com' };

test('Parameter Store exports configuration values and supplies SecureString only at deployment', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'taxonomy:systemsmanagerparameterstore')?.terraform[0], AWS_PARAMETER_SERVICE);
  const plain = AWS_PARAMETER_SERVICE.build(values);
  assert.deepEqual(plain.findings, []);
  assert.match(plain.files['main.tf']!, /https:\/\/orders.example.com/);
  const secure = AWS_PARAMETER_SERVICE.build({ ...values, type: 'SecureString', value: 'must-not-be-exported' });
  assert.deepEqual(secure.findings, []);
  assert.match(secure.files['main.tf']!, /value\s+= var.secure_parameter_value/);
  assert.match(secure.files['variables.tf']!, /sensitive\s+= true/);
  assert.doesNotMatch(Object.values(secure.files).join('\n'), /must-not-be-exported/);
});

test('Parameter Store validates hierarchy, list values, UTF-8 size and regional encryption', () => {
  for (const name of ['awsReserved', '/ssm/reserved', 'relative/path', '/double//slash', '/' + Array.from({ length: 16 }, () => 'level').join('/')]) assert.ok(AWS_PARAMETER_SERVICE.build({ ...values, name }).findings.some(finding => finding.path === 'name'), name);
  assert.ok(AWS_PARAMETER_SERVICE.build({ ...values, type: 'StringList', value: 'one,,two' }).findings.some(finding => finding.path === 'value'));
  assert.ok(AWS_PARAMETER_SERVICE.build({ ...values, value: 'é'.repeat(3000) }).findings.some(finding => finding.path === 'value'));
  assert.deepEqual(AWS_PARAMETER_SERVICE.build({ ...values, tier: 'Advanced', value: 'é'.repeat(3000) }).findings, []);
});
