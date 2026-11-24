import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_DATASYNC_EFS_SERVICE as blueprint } from './aws-datasync-efs-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(blueprint), aws_region:'us-east-1', name:'application-files', agent:'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0', server:'nfs.example.com', path:'/exports/application', filesystem:'fs-0123456789abcdef0', accesspoint:'fsap-0123456789abcdef0', mount:'fsmt-0123456789abcdef0', subnet:'subnet-0123456789abcdef0', group:'sg-0123456789abcdef0', role:'arn:aws:iam::123456789012:role/DataSyncEfs' };
test('NFS-to-EFS preserves a separate destination workflow and numeric POSIX metadata', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-datasync')?.terraform[2], blueprint);
  const result = blueprint.build(values);
  assert.deepEqual(result.findings, []);
  const config = JSON.parse(result.files['TRANSFER-CONFIG.json']!);
  assert.equal(config.destination.kind, 'efs');
  assert.equal(config.destination.path, '/migration');
  assert.equal(config.options.Uid, 'INT_VALUE');
  assert.equal(config.options.Gid, 'INT_VALUE');
  assert.equal(config.options.PosixPermissions, 'PRESERVE');
  assert.match(result.files['main.tf']!, /in_transit_encryption\s+= "TLS1_2"/);
  assert.match(result.files['main.tf']!, /length\(data.aws_efs_access_point.destination.posix_user\) == 0/);
  assert.match(result.files['main.tf']!, /preserve_deleted_files\s+= "PRESERVE"/);
  assert.doesNotMatch(result.files['main.tf']!, /resource "aws_efs_|resource "aws_security_group|resource "aws_iam_role"|schedule_expression/);
  const policy = JSON.parse(result.files['EFS-ACCESS.json']!);
  assert.deepEqual(policy.Statement[0].Action, ['elasticfilesystem:ClientMount','elasticfilesystem:ClientWrite','elasticfilesystem:ClientRootAccess']);
  assert.equal(policy.Statement[0].Condition.StringEquals['elasticfilesystem:AccessPointArn'], 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0');
  assert.equal(policy.Statement[1].Effect, 'Deny');
});
test('EFS migration rejects wrong accounts, root/traversal paths and unsupported network inputs', () => {
  for (const [key, value] of Object.entries({ role:values.role.replace('123456789012','000000000000'), agent:values.agent.replace('us-east-1','us-west-2'), filesystem:'invalid', accesspoint:'invalid', mount:'invalid', subnet:'invalid', group:'invalid', target_path:'/', path:'/../application', server:'999.0.0.1', version:'SMB', bandwidth:-1, name:'a'.repeat(101) })) {
    assert.ok(blueprint.build({ ...values, [key]:value }).findings.some(finding => finding.path === key), key);
  }
  assert.ok(blueprint.build({ ...values, target_path:'/migration/../other' }).findings.some(finding => finding.path === 'target_path'));
  assert.deepEqual(blueprint.build({ ...values, overwrite:'ALWAYS', version:'NFS3', bandwidth:12.5 }).findings, []);
});
