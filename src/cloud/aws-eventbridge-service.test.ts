import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_EVENTBRIDGE_SERVICE } from './aws-eventbridge-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_EVENTBRIDGE_SERVICE), aws_region: 'us-east-1', name: 'order-events', function_name: 'orders' };

test('EventBridge scopes Lambda and delivery DLQ permissions to its configured rule', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-eventbridge')?.terraform[0], AWS_EVENTBRIDGE_SERVICE);
  const result = AWS_EVENTBRIDGE_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /data "aws_cloudwatch_event_bus"/);
  assert.match(code, /source_arn\s+= aws_cloudwatch_event_rule.configured.arn/);
  assert.match(code, /aws:SourceArn/);
  assert.match(code, /Resource\s+= aws_sqs_queue.delivery_failures.arn/);
  assert.match(code, /sqs_managed_sse_enabled\s+= true/);
  assert.match(code, /maximum_retry_attempts\s+= 185/);
});

test('EventBridge supports a new bus and disabled rule without a DLQ', () => {
  const result = AWS_EVENTBRIDGE_SERVICE.build({ ...values, bus_mode: 'new', bus_name: 'application', dlq: false, enabled: false });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /resource "aws_cloudwatch_event_bus"/);
  assert.match(result.files['main.tf']!, /state\s+= "DISABLED"/);
  assert.doesNotMatch(result.files['main.tf']!, /aws_sqs_queue/);
});

test('EventBridge rejects malformed patterns, reserved new bus names and retry ranges', () => {
  const invalid = AWS_EVENTBRIDGE_SERVICE.build({ ...values, pattern: '[]', bus_mode: 'new', attempts: '', age: 0 });
  for (const path of ['pattern', 'bus_name', 'attempts', 'age']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
