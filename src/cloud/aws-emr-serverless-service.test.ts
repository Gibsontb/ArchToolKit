import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_EMR_SERVERLESS_SERVICE } from './aws-emr-serverless-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_EMR_SERVERLESS_SERVICE), aws_region: 'us-east-1', name: 'application-spark', role: 'arn:aws:iam::123456789012:role/EmrExecution', script: 's3://application-artifacts/scripts/example.py' };
test('EMR Serverless creates bounded idle-stopping Spark application and an explicit launcher', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-emr')?.terraform[0], AWS_EMR_SERVERLESS_SERVICE);
  const result = AWS_EMR_SERVERLESS_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/aws_emrserverless_application/, /maximum_capacity/, /auto_stop_configuration/, /16 vCPU/, /64 GB/, /s3:GetObject/, /logs:PutLogEvents/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /initial_capacity|s3:PutObject|= "jsonencode/);
  assert.match(result.files['START.ps1']!, /if \(-not \$Start\)/);
  assert.match(result.files['START.ps1']!, /clientToken/);
  assert.match(result.files['START.ps1']!, /--expected-bucket-owner/);
  assert.match(result.files['START.ps1']!, /completion is not yet verified/);
  assert.match(result.files['outputs.tf']!, /managedPersistenceMonitoringConfiguration/);
});
test('EMR private networking validates subnet/group inputs while service mode ignores hidden values', () => {
  assert.deepEqual(AWS_EMR_SERVERLESS_SERVICE.build({ ...values, subnets: 'stale', groups: 'stale' }).findings, []);
  const result = AWS_EMR_SERVERLESS_SERVICE.build({ ...values, private: 'YES', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', groups: 'sg-0123456789abcdef0', architecture: 'ARM64' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /network_configuration/);
  assert.match(result.files['main.tf']!, /ARM64/);
});
test('EMR rejects invalid scripts, resources and runtime identifiers', () => {
  for (const [key, value] of Object.entries({ script: 's3://application-artifacts/../example.py', cpu: 1, timeout: 0, role: 'invalid', release: 'latest', architecture: 'OTHER' })) assert.ok(AWS_EMR_SERVERLESS_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
