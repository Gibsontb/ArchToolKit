import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_API_SERVICE } from './aws-api-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_API_SERVICE), aws_region: 'us-east-1', name: 'orders-api', function_name: 'orders' };

test('HTTP API wires authenticated Lambda routes, scoped permission, logs and throttling', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-api-gateway')?.terraform[0], AWS_API_SERVICE);
  const result = AWS_API_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /authorization_type\s+= "AWS_IAM"/);
  assert.match(code, /statement_id_prefix\s+= "AllowHttpApi-"/);
  assert.match(code, /execution_arn}\/prod\/\*\/\*/);
  assert.match(code, /throttling_rate_limit\s+= 100/);
  assert.match(code, /resource "aws_cloudwatch_log_group"/);
  assert.match(code, /aws_lambda_permission.gateway/);
  assert.doesNotMatch(code, /aws_apigatewayv2_authorizer/);
});

test('HTTP API configures JWT and ignores inactive JWT settings for public routes', () => {
  const jwt = AWS_API_SERVICE.build({ ...values, authorization: 'JWT', issuer: 'https://identity.example.test', audiences: 'orders', scopes: 'read:orders,write:orders', path: '/orders/{proxy+}' });
  assert.deepEqual(jwt.findings, []);
  assert.match(jwt.files['main.tf']!, /resource "aws_apigatewayv2_authorizer"/);
  assert.match(jwt.files['main.tf']!, /read:orders/);
  const publicApi = AWS_API_SERVICE.build({ ...values, authorization: 'NONE', issuer: 'invalid' });
  assert.deepEqual(publicApi.findings, []);
  assert.match(publicApi.files['main.tf']!, /authorization_type\s+= "NONE"/);
});

test('HTTP API rejects malformed paths, missing JWT configuration and invalid throttles', () => {
  const result = AWS_API_SERVICE.build({ ...values, authorization: 'JWT', issuer: 'http://identity.example.test', audiences: '', path: '/{proxy+}/more', rate: '', burst: -1 });
  for (const path of ['issuer', 'audiences', 'path', 'rate', 'burst']) assert.ok(result.findings.some(finding => finding.path === path), path);
});
