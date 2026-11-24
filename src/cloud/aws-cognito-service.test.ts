import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_COGNITO_SERVICE } from './aws-cognito-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_COGNITO_SERVICE), aws_region: 'us-east-1', name: 'application-auth', domain: 'application-signin-123456789012', callbacks: 'https://app.example.com/callback' };
test('Cognito creates a protected TOTP pool and secretless code-grant client with real OIDC outputs', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-cognito')?.terraform[0], AWS_COGNITO_SERVICE);
  const result = AWS_COGNITO_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /generate_secret\s+= false/);
  assert.match(result.files['main.tf']!, /mfa_configuration\s+= "ON"/);
  assert.match(result.files['main.tf']!, /allow_admin_create_user_only\s+= true/);
  assert.match(result.files['main.tf']!, /deletion_protection\s+= "ACTIVE"/);
  assert.match(result.files['outputs.tf']!, /aws_cognito_user_pool.configured.endpoint/);
  assert.doesNotMatch(result.files['main.tf']!, /"implicit"|"client_credentials"/);
});
test('Cognito supports local development and explicit self-registration without weakening redirects', () => {
  const result = AWS_COGNITO_SERVICE.build({ ...values, mfa: 'OFF', registration: 'self', callbacks: 'http://localhost:3000/callback,http://[::1]:3000/callback', logout: 'https://app.example.com/logout' });
  assert.deepEqual(result.findings, []);
  assert.doesNotMatch(result.files['main.tf']!, /software_token_mfa_configuration/);
  assert.match(result.files['main.tf']!, /allow_admin_create_user_only\s+= false/);
  for (const callback of ['http://app.example.com/callback', 'https://app.example.com/callback#fragment', 'https://user:password@app.example.com/callback', 'https://*.example.com/callback']) assert.ok(AWS_COGNITO_SERVICE.build({ ...values, callbacks: callback }).findings.some(finding => finding.path === 'callbacks'), callback);
  for (const [key, value] of Object.entries({ domain: 'amazon-login', password: 5, refresh: 0, access: 1500, mfa: 'OPTIONAL' })) assert.ok(AWS_COGNITO_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
