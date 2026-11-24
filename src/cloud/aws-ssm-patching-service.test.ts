import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_SSM_PATCHING_SERVICE as blueprint } from './aws-ssm-patching-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'application-patching', group: 'application-pilot', role: 'arn:aws:iam::123456789012:role/PatchWindow', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' };
test('patch setup preserves existing SSM forms and defaults to disabled, scan-only, non-rebooting execution', () => {
  const rows = addServicesFor('aws');
  for (const id of ['aws-systems-manager', 'amazon-simple-systems-manager-ssm']) assert.equal(rows.find(row => row.id === id)?.terraform[0], blueprint);
  const result = blueprint.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/enabled\s+= false/, /AWS-RunPatchBaseline/, /"Scan"/, /"NoReboot"/, /tag:PatchGroup/, /MSRC_SEVERITY|SEVERITY/, /CONTINUE_TASK/, /prevent_destroy/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /aws_ssm_default_patch_baseline|aws_ssm_association|AdministratorAccess|0\.0\.0\.0/);
  assert.match(result.files['OPERATE.ps1']!, /if \(-not \$Execute\)/);
  assert.match(result.files['PREFLIGHT.ps1']!, /already has a baseline/);
});
test('Windows install and Linux scan variants choose actual OS filters without hidden enabling', () => {
  const windows = blueprint.build({ ...values, os: 'WINDOWS', operation: 'Install', reboot: 'RebootIfNeeded' });
  assert.deepEqual(windows.findings, []);
  assert.match(windows.files['main.tf']!, /MSRC_SEVERITY/);
  assert.match(windows.files['main.tf']!, /SecurityUpdates/);
  assert.match(windows.files['OPERATE.ps1']!, /-not \$ConfirmInstall/);
  for (const os of ['AMAZON_LINUX_2', 'AMAZON_LINUX_2023', 'REDHAT_ENTERPRISE_LINUX']) {
    const result = blueprint.build({ ...values, os, enabled: 'YES' });
    assert.deepEqual(result.findings, []);
    assert.match(result.files['main.tf']!, /enabled\s+= true/);
    assert.doesNotMatch(result.files['main.tf']!, /MSRC_SEVERITY/);
  }
});
test('patch setup rejects unbounded schedules, invalid roles, unknown OS and bad timing/error inputs', () => {
  for (const [key, value] of Object.entries({ os: 'UBUNTU', group: '*', approval_days: 101, operation: 'DELETE', reboot: 'true', schedule: 'rate(1 minute)', timezone: 'invalid zone', duration: 0, cutoff: 3, concurrency: 51, errors: 0, enabled: 'true', role: 'bad', kms: '' })) assert.ok(blueprint.build({ ...values, [key]: value }).findings.some(f => f.path === key), key);
});
