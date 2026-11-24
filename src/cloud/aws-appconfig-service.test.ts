import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_APPCONFIG_SERVICE } from './aws-appconfig-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_APPCONFIG_SERVICE), aws_region: 'us-east-1', name: 'application' };

test('AppConfig exports hosted JSON, canary deployment and a real retrieval example', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-appconfig')?.terraform[0], AWS_APPCONFIG_SERVICE);
  const result = AWS_APPCONFIG_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /resource "aws_appconfig_deployment"/);
  assert.match(result.files['main.tf']!, /AppConfig.Canary10Percent20Minutes/);
  assert.match(result.files['CLIENT-EXAMPLE.ps1']!, /start-configuration-session/);
  assert.match(result.files['CLIENT-EXAMPLE.ps1']!, /get-latest-configuration/);
});

test('AppConfig supports staged-only configuration with schema and rollback alarm', () => {
  const result = AWS_APPCONFIG_SERVICE.build({ ...values, deploy: false, schema: '{"type":"object"}', alarm: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:application-health' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /JSON_SCHEMA/);
  assert.match(result.files['main.tf']!, /cloudwatch:DescribeAlarms/);
  assert.match(result.files['main.tf']!, /alarm_role_arn/);
  assert.doesNotMatch(result.files['main.tf']!, /resource "aws_appconfig_deployment"/);
  const invalid = AWS_APPCONFIG_SERVICE.build({ ...values, content: '{', schema: '[]', strategy: 'unknown' });
  for (const path of ['content', 'schema', 'strategy']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
