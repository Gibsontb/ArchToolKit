import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_SECURITYHUB_SERVICE } from './aws-securityhub-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_SECURITYHUB_SERVICE), aws_region: 'us-east-1', account: '123456789012' };
test('Security Hub uses explicit standards and consolidated findings with account protection', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-security-hub')?.terraform[0], AWS_SECURITYHUB_SERVICE);
  const result = AWS_SECURITYHUB_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /enable_default_standards\s+= false/);
  assert.match(result.files['main.tf']!, /control_finding_generator\s+= "SECURITY_CONTROL"/);
  assert.match(result.files['main.tf']!, /auto_enable_controls\s+= false/);
  assert.match(result.files['main.tf']!, /prevent_destroy\s+= true/);
  assert.equal(JSON.parse(result.files['EXPECTED-STANDARDS.json']!).length, 1);
});
test('Security Hub supports multiple standards, exact custom versions and regional ARN validation', () => {
  const result = AWS_SECURITYHUB_SERVICE.build({ ...values, baseline: 'fsbp,cis,nist', controls: 'yes' });
  assert.deepEqual(result.findings, []);
  assert.equal(JSON.parse(result.files['EXPECTED-STANDARDS.json']!).length, 3);
  assert.match(result.files['main.tf']!, /cis-aws-foundations-benchmark\/v\/5.0.0/);
  assert.match(result.files['CHECK-STANDARDS.ps1']!, /describe-standards/);
  assert.ok(AWS_SECURITYHUB_SERVICE.build({ ...values, baseline: 'custom' }).findings.some(finding => finding.path === 'additional'));
  assert.ok(AWS_SECURITYHUB_SERVICE.build({ ...values, additional: 'arn:aws:securityhub:us-west-2::standards/cis-aws-foundations-benchmark/v/5.0.0' }).findings.some(finding => finding.path === 'additional'));
  assert.deepEqual(AWS_SECURITYHUB_SERVICE.build({ ...values, baseline: 'custom', additional: 'arn:aws:securityhub:us-east-1::standards/cis-aws-foundations-benchmark/v/3.0.0' }).findings, []);
});
