import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_BEDROCK_SERVICE } from './aws-bedrock-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_BEDROCK_SERVICE), aws_region: 'us-east-1', name: 'application-inference', role: 'arn:aws:iam::123456789012:role/Application', model: 'amazon.nova-micro-v1:0' };
test('Bedrock integration scopes existing-role inference to metadata-resolved regional model', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-bedrock')?.terraform[0], AWS_BEDROCK_SERVICE);
  const result = AWS_BEDROCK_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  assert.match(main, /bedrock:InvokeModel/);
  assert.match(main, /Resource = data.aws_bedrock_foundation_model.selected.model_arn/);
  assert.match(main, /ON_DEMAND/);
  assert.doesNotMatch(main, /Resource = "\*"|bedrock:\*|InvokeModelWithResponseStream/);
  const config = JSON.parse(result.files['client-config.json']!);
  assert.equal(config.region, 'us-east-1');
  assert.equal(config.model, values.model);
  assert.match(result.files['CLIENT.py']!, /region_name=config\["region"\]/);
  assert.doesNotMatch(result.files['CLIENT.py']!, /aws_access_key|assume_role|verify=False/);
});
test('Bedrock streaming and existing guardrail selections configure exact permissions and client request', () => {
  const result = AWS_BEDROCK_SERVICE.build({ ...values, mode: 'STREAM', guardrail: 'arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123', guardrail_version: '2' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /response_streaming_supported/);
  assert.match(result.files['main.tf']!, /bedrock:InvokeModelWithResponseStream/);
  assert.match(result.files['main.tf']!, /bedrock:ApplyGuardrail/);
  assert.equal(JSON.parse(result.files['client-config.json']!).guardrail_version, '2');
  assert.match(result.files['CLIENT.py']!, /guardrailConfig/);
  assert.match(result.files['CLIENT.py']!, /converse_stream/);
});
test('Bedrock rejects unbounded/foreign inputs and ignores inactive guardrail version', () => {
  for (const [key, value] of Object.entries({ model: '*', role: '*', mode: 'BATCH', tokens: 0, guardrail: 'arn:aws:bedrock:us-west-2:123456789012:guardrail/abc123' })) assert.ok(AWS_BEDROCK_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  assert.deepEqual(AWS_BEDROCK_SERVICE.build({ ...values, guardrail_version: 'invalid' }).findings, []);
  assert.ok(AWS_BEDROCK_SERVICE.build({ ...values, guardrail: 'arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123', guardrail_version: '' }).findings.some(finding => finding.path === 'guardrail_version'));
});
