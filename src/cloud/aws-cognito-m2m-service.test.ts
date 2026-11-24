import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_COGNITO_M2M_SERVICE } from './aws-cognito-m2m-service.ts';
import { AWS_COGNITO_SERVICE } from './aws-cognito-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_COGNITO_M2M_SERVICE), aws_region: 'us-east-1', name: 'application-machine', domain: 'application-machine-123456789012', scopes: 'read,write' };
test('Cognito M2M protects generated secret and keeps public web setup unchanged', () => {
  const forms = addServicesFor('aws').find(row => row.id === 'amazon-cognito')!.terraform;
  assert.equal(forms[0], AWS_COGNITO_SERVICE);
  assert.ok(forms.includes(AWS_COGNITO_M2M_SERVICE));
  const result = AWS_COGNITO_M2M_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  assert.match(main, /client_credentials/);
  assert.match(main, /generate_secret\s+= true/);
  assert.match(main, /aws_secretsmanager_secret_version/);
  assert.match(main, /allow_admin_create_user_only = true/);
  assert.doesNotMatch(main, /ALLOW_USER_SRP_AUTH|ALLOW_USER_PASSWORD_AUTH|callback_urls|= "jsonencode/);
  assert.doesNotMatch(result.files['outputs.tf']!, /machine.client_secret/);
  assert.match(result.files['TOKEN-PROBE.py']!, /if not args.request_token/);
  assert.match(result.files['TOKEN-PROBE.py']!, /Refusing authenticated redirect/);
});
test('Cognito M2M rejects wildcard scopes, reserved domains and invalid lifetimes', () => {
  for (const [key, value] of Object.entries({ scopes: '*', domain: 'amazon-login', identifier: 'api/*', minutes: 0 })) assert.ok(AWS_COGNITO_M2M_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
