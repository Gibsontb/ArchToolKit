import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_GUARDDUTY_SERVICE } from './aws-guardduty-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_GUARDDUTY_SERVICE), aws_region: 'us-east-1' };
test('GuardDuty creates one protected enabled detector with explicit optional plans', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-guardduty')?.terraform[0], AWS_GUARDDUTY_SERVICE);
  const result = AWS_GUARDDUTY_SERVICE.build({ ...values, s3: 'ENABLED', malware: 'DISABLED' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /prevent_destroy\s+= true/);
  assert.match(result.files['main.tf']!, /name\s+= "S3_DATA_EVENTS"/);
  assert.match(result.files['main.tf']!, /status\s+= "DISABLED"/);
  assert.match(result.files['PREFLIGHT.ps1']!, /regionalDetectorIds.Count -ne 0/);
});
test('GuardDuty existing mode changes only selected features and checks detector presence/status', () => {
  const result = AWS_GUARDDUTY_SERVICE.build({ ...values, mode: 'existing', detector: 'a'.repeat(32), eks: 'ENABLED' });
  assert.deepEqual(result.findings, []);
  assert.doesNotMatch(result.files['main.tf']!, /resource "aws_guardduty_detector"/);
  assert.match(result.files['main.tf']!, /EKS_AUDIT_LOGS/);
  assert.match(result.files['PREFLIGHT.ps1']!, /get-detector/);
  assert.ok(AWS_GUARDDUTY_SERVICE.build({ ...values, mode: 'existing', detector: 'a'.repeat(32) }).findings.some(finding => finding.path === 'mode'));
  assert.ok(AWS_GUARDDUTY_SERVICE.build({ ...values, mode: 'existing', detector: 'bad', eks: 'ENABLED' }).findings.some(finding => finding.path === 'detector'));
  assert.ok(AWS_GUARDDUTY_SERVICE.build({ ...values, s3: 'other' }).findings.some(finding => finding.path === 's3'));
});
