import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_DATASYNC_NFS_SERVICE } from './aws-datasync-nfs-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_DATASYNC_NFS_SERVICE), aws_region: 'us-east-1', name: 'application-files', agent: 'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0', server: 'nfs.example.com', path: '/exports/application', bucket: 'application-landing', role: 'arn:aws:iam::123456789012:role/DataSyncDestination' };
test('NFS migration adds a distinct service path and shares logged, verified Basic transfer behavior', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-datasync')?.terraform[1], AWS_DATASYNC_NFS_SERVICE);
  const result = AWS_DATASYNC_NFS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /aws_datasync_location_nfs/);
  assert.match(result.files['main.tf']!, /NFS4_1/);
  assert.match(result.files['main.tf']!, /preserve_deleted_files\s+= "PRESERVE"/);
  assert.match(result.files['main.tf']!, /ONLY_FILES_TRANSFERRED/);
  assert.match(result.files['PREFLIGHT.ps1']!, /describe-agent/);
  assert.doesNotMatch(result.files['main.tf']!, /start-task-execution/);
});
test('NFS migration validates source/agent boundaries and scopes destination policy to its prefix', () => {
  const result = AWS_DATASYNC_NFS_SERVICE.build({ ...values, version: 'NFS3', bandwidth: 12.5, overwrite: 'ALWAYS' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /bytes_per_second\s+= 12500000/);
  assert.equal(JSON.parse(result.files['DESTINATION-ACCESS.json']!).Statement[2].Resource, 'arn:aws:s3:::application-landing/landing/*');
  for (const [key, value] of Object.entries({ agent: values.agent.replace('us-east-1', 'us-west-2'), path: '/../exports', server: '999.0.0.1', prefix: '/bad/*/', version: 'SMB', bandwidth: -1, role: 'invalid' })) assert.ok(AWS_DATASYNC_NFS_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
