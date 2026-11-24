import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_LAMBDA_SQS_SERVICE } from './aws-lambda-sqs-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_LAMBDA_SQS_SERVICE), aws_region: 'us-east-1', name: 'application-queue', function_name: 'application', queue: 'arn:aws:sqs:us-east-1:123456789012:application' };

test('Lambda SQS integration scopes polling permissions and checks live queue metadata through preflight', () => {
  assert.ok(addServicesFor('aws').find(row => row.id === 'aws-lambda')?.terraform.includes(AWS_LAMBDA_SQS_SERVICE));
  const result = AWS_LAMBDA_SQS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /sqs:ReceiveMessage/);
  assert.match(result.files['main.tf']!, /resource "aws_lambda_event_source_mapping"/);
  assert.doesNotMatch(result.files['main.tf']!, /data.aws_sqs_queue.selected.visibility_timeout/);
  assert.match(result.files['PREFLIGHT.ps1']!, /get-queue-attributes/);
  assert.match(result.files['PREFLIGHT.ps1']!, /describe-key/);
});

test('Lambda SQS integration respects FIFO batch/window limits and partial-failure opt-in', () => {
  const fifo = AWS_LAMBDA_SQS_SERVICE.build({ ...values, queue: values.queue + '.fifo', partial: true, concurrency: 5, enabled: false });
  assert.deepEqual(fifo.findings, []);
  assert.match(fifo.files['main.tf']!, /ReportBatchItemFailures/);
  assert.match(fifo.files['main.tf']!, /maximum_concurrency\s+= 5/);
  assert.doesNotMatch(fifo.files['main.tf']!, /maximum_batching_window_in_seconds/);
  const invalid = AWS_LAMBDA_SQS_SERVICE.build({ ...values, queue: values.queue + '.fifo', batch: 11, window: 1, concurrency: 1 });
  for (const path of ['batch', 'window', 'concurrency']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
  assert.ok(AWS_LAMBDA_SQS_SERVICE.build({ ...values, batch: 20, window: 0 }).findings.some(finding => finding.path === 'window'));
});
