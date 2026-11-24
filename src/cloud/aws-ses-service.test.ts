import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_SES_SERVICE } from './aws-ses-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_SES_SERVICE), aws_region: 'us-east-1', name: 'application-mail', sender: 'notifications@example.com', identity: 'example.com', role: 'arn:aws:iam::123456789012:role/ApplicationSender' };
test('SES configures TLS, suppression and configuration-set count metrics without sending mail', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-simple-email-service')?.terraform[0], AWS_SES_SERVICE);
  const result = AWS_SES_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /tls_policy\s+= "REQUIRE"/);
  assert.match(result.files['main.tf']!, /ses:configuration-set/);
  assert.match(result.files['main.tf']!, /ses:FromAddress/);
  assert.match(result.files['main.tf']!, /metric_name\s+= "Complaint"/);
  assert.doesNotMatch(result.files['main.tf']!, /local-exec|alarm_actions|send-email/);
  assert.match(result.files['SEND-EXAMPLE.ps1']!, /Parameter\(Mandatory=\$true\)/);
});
test('SES supports exact email identities and validates sender, threshold and regional alarm boundaries', () => {
  assert.deepEqual(AWS_SES_SERVICE.build({ ...values, identity: '', topic: 'arn:aws:sns:us-east-1:123456789012:MailAlerts' }).findings, []);
  for (const [key, value] of Object.entries({ identity: 'other.example.org', sender: 'Name <sender@example.com>', bounce: 0, complaint: 0.5, topic: 'arn:aws:sns:us-west-2:123456789012:MailAlerts', role: 'invalid', name: 'x'.repeat(57) })) assert.ok(AWS_SES_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
