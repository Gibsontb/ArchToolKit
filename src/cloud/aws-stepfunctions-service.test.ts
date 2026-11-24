import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_STEPFUNCTIONS_SERVICE } from './aws-stepfunctions-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_STEPFUNCTIONS_SERVICE), aws_region: 'us-east-1', name: 'order-workflow', function_name: 'orders', role: 'arn:aws:iam::123456789012:role/WorkflowExecution' };

test('Step Functions generates a bounded Lambda workflow with runtime ARN references and logs', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-step-functions')?.terraform[0], AWS_STEPFUNCTIONS_SERVICE);
  const result = AWS_STEPFUNCTIONS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /definition\s+= jsonencode/);
  assert.match(code, /FunctionName\s+= data.aws_lambda_function.task.arn/);
  assert.match(code, /Payload\.\$/);
  assert.match(code, /Lambda.TooManyRequestsException/);
  assert.match(code, /include_execution_data\s+= false/);
  assert.match(code, /prevent_destroy\s+= true/);
  assert.match(code, /TimeoutSeconds\s+= 300/);
});

test('Step Functions enforces Express timeout and partition-specific execution roles', () => {
  assert.ok(AWS_STEPFUNCTIONS_SERVICE.build({ ...values, type: 'EXPRESS', timeout: 301 }).findings.some(finding => finding.path === 'timeout'));
  const gov = AWS_STEPFUNCTIONS_SERVICE.build({ ...values, aws_region: 'us-gov-west-1', role: values.role.replace('arn:aws:', 'arn:aws-us-gov:'), tracing: false, attempts: 0 });
  assert.deepEqual(gov.findings, []);
  assert.match(gov.files['main.tf']!, /arn:aws-us-gov:states:::lambda:invoke/);
  assert.match(gov.files['main.tf']!, /MaxAttempts\s+= 0/);
  const invalid = AWS_STEPFUNCTIONS_SERVICE.build({ ...values, role: '', attempts: '', interval: 0 });
  for (const path of ['role', 'attempts', 'interval']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
