import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_INSPECTOR_SERVICE } from './aws-inspector-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_INSPECTOR_SERVICE), aws_region: 'us-east-1', account: '123456789012' };
test('Inspector scopes activation to the expected current account and exports read-only coverage tools', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-inspector')?.terraform[0], AWS_INSPECTOR_SERVICE);
  const result = AWS_INSPECTOR_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /aws_inspector2_enabler/);
  assert.match(result.files['main.tf']!, /data.aws_caller_identity.current.account_id == "123456789012"/);
  assert.match(result.files['main.tf']!, /prevent_destroy\s+= true/);
  assert.match(result.files['GET-COVERAGE.ps1']!, /list-coverage/);
  assert.match(result.files['GET-COVERAGE.ps1']!, /list-findings/);
});
test('Inspector requires Lambda standard scanning for code analysis and rejects empty scan selections', () => {
  assert.deepEqual(AWS_INSPECTOR_SERVICE.build({ ...values, lambda_code: 'on' }).findings, []);
  assert.ok(AWS_INSPECTOR_SERVICE.build({ ...values, lambda: 'off', lambda_code: 'on' }).findings.some(finding => finding.path === 'lambda_code'));
  assert.ok(AWS_INSPECTOR_SERVICE.build({ ...values, ec2: 'off', ecr: 'off', lambda: 'off' }).findings.some(finding => finding.path === 'ec2'));
  assert.ok(AWS_INSPECTOR_SERVICE.build({ ...values, account: '123' }).findings.some(finding => finding.path === 'account'));
});
