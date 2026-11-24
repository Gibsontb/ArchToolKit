import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_BATCH_SERVICE } from './aws-batch-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_BATCH_SERVICE), aws_region: 'us-east-1', name: 'application-batch', image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/application@sha256:' + 'a'.repeat(64), execution_role: 'arn:aws:iam::123456789012:role/EcsExecution', subnets: 'subnet-0123456789abcdef0', groups: 'sg-0123456789abcdef0', executable: '/app/run' };
test('Batch creates Fargate capacity, queue and a non-submitted digest-pinned job definition', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-batch')?.terraform[0], AWS_BATCH_SERVICE);
  const result = AWS_BATCH_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /aws_batch_job_queue/);
  assert.match(result.files['main.tf']!, /compute_environment_name_prefix/);
  assert.match(result.files['main.tf']!, /create_before_destroy\s+= true/);
  assert.match(result.files['outputs.tf']!, /submit_job_json/);
  assert.doesNotMatch(result.files['main.tf']!, /local-exec|aws batch submit-job/);
});
test('Batch maps CPU to vCPU once, preserves argument spaces and checks capacity/network/roles', () => {
  const result = AWS_BATCH_SERVICE.build({ ...values, size: '256:512', capacity: 'FARGATE_SPOT', arguments: '--message\nhello world', attempts: 3 });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /0.25/);
  assert.match(result.files['main.tf']!, /hello world/);
  assert.match(result.files['main.tf']!, /FARGATE_SPOT/);
  for (const [key, value] of Object.entries({ image: 'application:latest', subnets: '', groups: 'invalid', attempts: 0, executable: '/app/run --flag', execution_role: 'invalid', size: '256:999' })) assert.ok(AWS_BATCH_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  assert.ok(AWS_BATCH_SERVICE.build({ ...values, size: '8192:16384', max_cpu: 4 }).findings.some(finding => finding.path === 'max_cpu'));
});
