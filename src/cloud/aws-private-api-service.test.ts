import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_PRIVATE_API_SERVICE } from './aws-private-api-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_PRIVATE_API_SERVICE), aws_region: 'us-east-1', name: 'application-private-api', function: 'arn:aws:lambda:us-east-1:123456789012:function:application', endpoints: 'vpce-0123456789abcdef0', roles: 'arn:aws:iam::123456789012:role/Application' };
test('Private REST Lambda API applies IAM plus explicit endpoint and principal deny boundaries', () => {
  assert.ok(addServicesFor('aws').find(row => row.id === 'amazon-api-gateway')?.terraform.includes(AWS_PRIVATE_API_SERVICE));
  const result = AWS_PRIVATE_API_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  assert.match(main, /types\s+= \["PRIVATE"\]/);
  assert.match(main, /authorization\s+= "AWS_IAM"/);
  assert.match(main, /aws:SourceVpce/);
  assert.match(main, /aws:PrincipalArn/);
  assert.match(main, /ArnNotEquals/);
  assert.equal((main.match(/Effect = "Deny"/g) ?? []).length, 2);
  assert.match(main, /private_dns_enabled/);
  assert.match(main, /type\s+= "AWS_PROXY"/);
  assert.match(result.files['outputs.tf']!, /caller_policy_json/);
  assert.match(result.files['outputs.tf']!, /prod\/GET\/service/);
});
test('Private REST API pins Lambda qualifier and redeploys integration/policy changes', () => {
  const result = AWS_PRIVATE_API_SERVICE.build({ ...values, alias: 'release', method: 'POST', path: 'orders', access_log: 'arn:aws:logs:us-east-1:123456789012:log-group:/application/api-access' });
  assert.deepEqual(result.findings, []);
  const main = result.files['main.tf']!;
  assert.match(main, /qualified_invoke_arn/);
  assert.match(main, /qualifier\s+= "release"/);
  assert.match(main, /sha1\(jsonencode/);
  assert.match(main, /aws_api_gateway_rest_api_policy.configured.policy/);
  assert.match(main, /extendedRequestId/);
  assert.match(main, /data_trace_enabled\s+= false/);
});
test('Private REST API rejects unbounded identities, public endpoint IDs and malformed routing', () => {
  for (const [key, value] of Object.entries({ roles: '*', endpoints: 'public', function: 'arn:aws:lambda:us-west-2:123456789012:function:application', path: '{proxy+}', method: 'ANY', stage: 'bad/stage', rate: 0, burst: 0, alias: '$LATEST', access_log: 'invalid' })) assert.ok(AWS_PRIVATE_API_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
