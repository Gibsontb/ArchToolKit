import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_APPRUNNER_SERVICE } from './aws-apprunner-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_APPRUNNER_SERVICE), aws_region: 'us-east-1', name: 'application', eligible: true, image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/application@sha256:' + 'a'.repeat(64) };

test('App Runner retains lifecycle evidence and requires an existing-customer account', () => {
  const row = addServicesFor('aws').find(row => row.id === 'aws-app-runner');
  assert.equal(row?.terraform[0], AWS_APPRUNNER_SERVICE);
  assert.equal(row?.availability?.status, 'existing-customers-only');
  assert.equal(row?.availability?.effective, '2026-04-30');
  assert.ok(AWS_APPRUNNER_SERVICE.build({ ...values, eligible: false }).findings.some(finding => finding.path === 'eligible'));
});

test('App Runner private images receive scoped pull access, scaling and HTTP health checks', () => {
  const result = AWS_APPRUNNER_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /build.apprunner.amazonaws.com/);
  assert.match(code, /repository\/application/);
  assert.match(code, /is_publicly_accessible\s+= true/);
  assert.match(code, /auto_deployments_enabled\s+= false/);
  assert.match(code, /health_check_configuration/);
});

test('App Runner public ECR omits pull roles and rejects invalid image deployment settings', () => {
  const result = AWS_APPRUNNER_SERVICE.build({ ...values, repository: 'ECR_PUBLIC', image: 'public.ecr.aws/example/application:release' });
  assert.deepEqual(result.findings, []);
  assert.doesNotMatch(result.files['main.tf']!, /resource "aws_iam_role"/);
  const invalid = AWS_APPRUNNER_SERVICE.build({ ...values, automatic: true, size: '256:2048', minimum: 5, maximum: 3 });
  for (const path of ['automatic', 'size', 'minimum']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
