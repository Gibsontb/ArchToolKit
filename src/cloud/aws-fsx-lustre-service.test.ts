import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_FSX_LUSTRE_SERVICE } from './aws-fsx-lustre-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_FSX_LUSTRE_SERVICE), aws_region: 'us-east-1', name: 'application-parallel', subnet: 'subnet-0123456789abcdef0', groups: 'sg-0123456789abcdef0' };
test('Lustre creates protected persistent storage with backups and a real postapply mount name', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'taxonomy:fsxforlustre')?.terraform[0], AWS_FSX_LUSTRE_SERVICE);
  const result = AWS_FSX_LUSTRE_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /PERSISTENT_2/);
  assert.match(result.files['main.tf']!, /per_unit_storage_throughput\s+= 250/);
  assert.match(result.files['main.tf']!, /automatic_backup_retention_days\s+= 7/);
  assert.match(result.files['outputs.tf']!, /configured.mount_name/);
  assert.match(result.files['main.tf']!, /Name\s+= "application-parallel"/);
});
test('Lustre scratch ignores persistent-only settings and validates common capacity/network prerequisites', () => {
  const scratch = AWS_FSX_LUSTRE_SERVICE.build({ ...values, deployment: 'SCRATCH_2', kms: 'inactive', retention: 0, backup: 'inactive', throughput: 'inactive' });
  assert.deepEqual(scratch.findings, []);
  assert.match(scratch.files['main.tf']!, /skip_final_backup\s+= true/);
  assert.doesNotMatch(scratch.files['main.tf']!, /inactive|kms_key_id|automatic_backup_retention_days|per_unit_storage_throughput/);
  for (const [key, value] of Object.entries({ storage: 3600, groups: '', throughput: '64', version: '2.10', maintenance: '9:03:00' })) assert.ok(AWS_FSX_LUSTRE_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
