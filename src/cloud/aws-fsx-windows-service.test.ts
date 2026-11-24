import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_FSX_WINDOWS_SERVICE } from './aws-fsx-windows-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_FSX_WINDOWS_SERVICE), aws_region: 'us-east-1', name: 'application-shares', subnet: 'subnet-0123456789abcdef0', standby: 'subnet-0123456789abcdef1', groups: 'sg-0123456789abcdef0', directory: 'd-0123456789' };
test('FSx Windows managed AD checks VPC, distinct AZs and region before protected SMB storage creation', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'taxonomy:fsxforwindowsfileserver')?.terraform[0], AWS_FSX_WINDOWS_SERVICE);
  const result = AWS_FSX_WINDOWS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const main = result.files['main.tf']!;
  assert.match(main, /MicrosoftAD/);
  assert.match(main, /length\(data.aws_availability_zones.available.names\) >= 3/);
  assert.match(main, /preferred_subnet_id/);
  assert.match(main, /skip_final_backup\s+= false/);
  assert.match(main, /prevent_destroy\s+= true/);
  assert.match(result.files['outputs.tf']!, /default_share_unc/);
  assert.match(result.files['SMB-CONFIG.ps1']!, /if \(\$EnforceEncryption\)/);
  assert.doesNotMatch(main, /self_managed_active_directory/);
});
test('Self-managed AD uses sensitive deployment variable and ignores stale managed/single-AZ inputs', () => {
  const result = AWS_FSX_WINDOWS_SERVICE.build({ ...values, ad: 'SELF', directory: 'invalid', deployment: 'SINGLE_AZ_2', standby: 'invalid', domain: 'corp.example.org', dns: '10.100.0.10,10.100.0.11', username: 'fsxjoin', ou: 'OU=FSx,DC=corp,DC=example,DC=org', admin_group: 'FSxAdmins', storage: 'HDD', capacity: 2000 });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /password\s+= var.fsx_ad_password/);
  assert.match(result.files['variables.tf']!, /sensitive\s+= true/);
  assert.doesNotMatch(result.files['variables.tf']!, /default\s*=/);
  assert.doesNotMatch(result.files['main.tf']!, /active_directory_id|aws_directory_service_directory|preferred_subnet_id|disk_iops_configuration/);
});
test('FSx Windows enforces audit sink/throughput and storage/topology limits', () => {
  const audit = { ...values, audit: 'LOGS', audit_arn: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/fsx/file-access' };
  assert.deepEqual(AWS_FSX_WINDOWS_SERVICE.build(audit).findings, []);
  for (const [key, value] of Object.entries({ throughput: '16', audit_arn: 'invalid', standby: values.subnet, capacity: 31, retention: 0, backup_time: '25:01' })) assert.ok(AWS_FSX_WINDOWS_SERVICE.build({ ...audit, [key]: value }).findings.some(finding => finding.path === key), key);
  assert.ok(AWS_FSX_WINDOWS_SERVICE.build({ ...values, storage: 'HDD' }).findings.some(finding => finding.path === 'capacity'));
});
