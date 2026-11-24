import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_DIRECTORY_SERVICE } from './aws-directory-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_DIRECTORY_SERVICE), aws_region: 'us-east-1', name: 'application-directory', domain: 'ad.example.org', short_name: 'CORP', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1' };
test('Managed Microsoft AD creates two-AZ directory and keeps bootstrap credentials deployment-only', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-directory-service')?.terraform[0], AWS_DIRECTORY_SERVICE);
  const result = AWS_DIRECTORY_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /type\s+= "MicrosoftAD"/);
  assert.match(result.files['main.tf']!, /password\s+= var.directory_admin_password/);
  assert.match(result.files['main.tf']!, /availability_zone\]\)\) == 2/);
  assert.match(result.files['main.tf']!, /prevent_destroy\s+= true/);
  assert.match(result.files['variables.tf']!, /sensitive\s+= true/);
  assert.doesNotMatch(result.files['variables.tf']!, /default\s*=/);
});
test('Directory security forwarding scopes the resource policy and depends on it before subscription', () => {
  const result = AWS_DIRECTORY_SERVICE.build(values), main = result.files['main.tf']!;
  assert.match(main, /ds.amazonaws.com/);
  assert.match(main, /aws_cloudwatch_log_group.directory.arn/);
  assert.match(main, /depends_on\s+= \[aws_cloudwatch_log_resource_policy.directory\]/);
  assert.match(main, /retention_in_days\s+= 90/);
  const disabled = AWS_DIRECTORY_SERVICE.build({ ...values, edition: 'Enterprise', logging: 'NO', log_days: 'invalid' });
  assert.deepEqual(disabled.findings, []);
  assert.doesNotMatch(disabled.files['main.tf']!, /aws_cloudwatch_log_|aws_directory_service_log_subscription/);
  assert.match(result.files['JOIN-WINDOWS.ps1']!, /if \(\$ConfigureDns\)/);
  assert.match(result.files['JOIN-WINDOWS.ps1']!, /if \(\$JoinDomain\)/);
  assert.doesNotMatch(result.files['JOIN-WINDOWS.ps1']!, /-Restart|directory_admin_password/);
});
test('Directory validates forest names, editions and duplicate/incomplete subnets', () => {
  for (const [key, value] of Object.entries({ domain: 'ad..example.org', short_name: '12345', edition: 'SimpleAD', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef0', log_days: '3' })) assert.ok(AWS_DIRECTORY_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
