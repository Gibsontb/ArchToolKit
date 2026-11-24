import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_BACKUP_SERVICE } from './aws-backup-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_BACKUP_SERVICE), aws_region: 'us-east-1', name: 'application-backup', resources: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0', role: 'arn:aws:iam::123456789012:role/BackupExecution' };

test('AWS Backup exports scheduled exact selection with a protected vault', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-backup')?.terraform[0], AWS_BACKUP_SERVICE);
  const result = AWS_BACKUP_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /cron\(0 2 \* \* \? \*\)/);
  assert.match(code, /force_destroy\s+= false/);
  assert.match(code, /prevent_destroy\s+= true/);
  assert.match(code, /delete_after\s+= 35/);
  assert.match(code, /resource "aws_backup_selection"/);
  assert.match(result.files['SERVICE-SETUP.md']!, /Restore into an isolated/);
});

test('AWS Backup respects storage types, schedules and regional encryption', () => {
  const s3 = AWS_BACKUP_SERVICE.build({ ...values, resource_type: 'S3', resources: 'arn:aws:s3:::application-data', frequency: 'weekly' });
  assert.deepEqual(s3.findings, []);
  assert.match(s3.files['main.tf']!, /cron\(0 2 \? \* SUN \*\)/);
  const invalid = AWS_BACKUP_SERVICE.build({ ...values, resource_type: 'EBS', resources: values.resources.replace('us-east-1', 'us-west-2'), kms: 'arn:aws:kms:us-west-2:123456789012:key/abc', hour: '', retention: 0 });
  for (const path of ['resources', 'kms', 'hour', 'retention']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
  assert.ok(AWS_BACKUP_SERVICE.build({ ...values, resources: 'arn:aws:ec2:us-east-1:123456789012:instance/*' }).findings.some(finding => finding.path === 'resources'));
});
