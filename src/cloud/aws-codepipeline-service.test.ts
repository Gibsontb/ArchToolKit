import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_CODEPIPELINE_SERVICE } from './aws-codepipeline-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_CODEPIPELINE_SERVICE), aws_region: 'us-east-1', name: 'application-release', pipeline_role: 'arn:aws:iam::123456789012:role/Pipeline', role: 'arn:aws:iam::123456789012:role/CodeBuild', source_bucket: 'application-source', source_key: 'releases/source.zip', artifact_bucket: 'application-artifacts', commands: 'mkdir -p dist\nprintf artifact > dist/result.txt', artifact_files: 'dist/**/*' };
test('CodePipeline reuses a pipeline-compatible build module and scopes artifact and source permissions', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-codepipeline')?.terraform[0], AWS_CODEPIPELINE_SERVICE);
  const result = AWS_CODEPIPELINE_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /module "build"/);
  assert.match(result.files['main.tf']!, /module.build.project_name/);
  assert.doesNotMatch(result.files['main.tf']!, /configuration\s*=\s*jsonencode/);
  assert.doesNotMatch(result.files['main.tf']!, /restart_execution_on_update/);
  assert.match(result.files['main.tf']!, /application-artifacts\/application-release\/\*/);
  assert.match(result.files['modules/build/main.tf']!, /type\s+= "CODEPIPELINE"/);
  assert.match(result.files['modules/build/buildspec.yml']!, /artifacts:/);
  assert.match(result.files['modules/build/buildspec.yml']!, /dist\/\*\*\/\*/);
  assert.match(result.files['SERVICE-SETUP.md']!, /initial execution/);
});
test('CodePipeline validates identity separation, source placement and inherited build output requirements', () => {
  for (const [key, value] of Object.entries({ pipeline_role: values.role, source_key: 'releases/*', source_bucket: 'INVALID', artifact_files: '', commands: '', trigger: 'UNKNOWN' })) assert.ok(AWS_CODEPIPELINE_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  assert.ok(AWS_CODEPIPELINE_SERVICE.build({ ...values, source_bucket: values.artifact_bucket, source_key: values.name + '/source.zip' }).findings.some(finding => finding.path === 'source_key'));
  const result = AWS_CODEPIPELINE_SERVICE.build({ ...values, trigger: 'POLL', artifact_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /kms:GenerateDataKey/);
  assert.match(result.files['modules/build/main.tf']!, /kms:GenerateDataKey/);
});

test('CodePipeline supports authenticated Git sources without stale S3 access or source data', () => {
  for (const service of ['codeconnections', 'codestar-connections']) {
    const result = AWS_CODEPIPELINE_SERVICE.build({ ...values, source: 'GIT', connection: 'arn:aws:' + service + ':us-east-1:123456789012:connection/12345678-abcd-abcd-abcd-123456789abc', repository: 'engineering/Payments', branch: 'release/current', trigger: 'POLL' });
    assert.deepEqual(result.findings, []);
    assert.match(result.files['main.tf']!, /CodeStarSourceConnection/);
    assert.match(result.files['main.tf']!, /engineering\/Payments/);
    assert.ok(result.files['main.tf']!.includes(service + ':UseConnection'));
    assert.doesNotMatch(result.files['main.tf']!, /application-source|releases\/source.zip/);
    assert.match(result.files['PREFLIGHT.ps1']!, /ConnectionStatus -ne 'AVAILABLE'/);
  }
  assert.ok(AWS_CODEPIPELINE_SERVICE.build({ ...values, source: 'GIT', connection: 'wrong', repository: 'owner/repo', branch: '../wrong' }).findings.some(finding => finding.path === 'branch'));
});

test('CodePipeline places manual review before exact-object S3 release and separates approver rights', () => {
  const result = AWS_CODEPIPELINE_SERVICE.build({ ...values, release: 'S3_ZIP', release_bucket: 'application-releases', release_key: 'approved/application.zip', approval: 'MANUAL', review_url: 'https://changes.example.org/123', review_note: 'Verify signed build and test report.', release_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' });
  assert.deepEqual(result.findings, []);
  const main = result.files['main.tf']!;
  assert.ok(main.indexOf('name = "Review"') < main.indexOf('name = "Release"'));
  assert.match(main, /provider\s+= "Manual"/);
  assert.match(main, /Extract = "false"/);
  assert.match(main, /ObjectKey = "approved\/application.zip"/);
  assert.match(main, /KMSEncryptionKeyARN/);
  assert.match(main, /aws:ResourceAccount/);
  assert.doesNotMatch(main, /application-releases\/\*|codepipeline:PutApprovalResult/);
  const policy = JSON.parse(result.files['APPROVER-POLICY.json']!);
  assert.equal(policy.Statement[0].Resource, 'arn:aws:codepipeline:us-east-1:123456789012:application-release/Review/ApproveArtifact');
  assert.match(result.files['PREFLIGHT.ps1']!, /expected-bucket-owner/);
});

test('CodePipeline excludes inactive release/review inputs and rejects ambiguous release targets', () => {
  const stale = AWS_CODEPIPELINE_SERVICE.build({ ...values, release_bucket: 'bad', release_key: '*', release_kms: 'bad', review_url: 'bad', review_note: '\u0000' });
  assert.deepEqual(stale.findings, []);
  assert.doesNotMatch(stale.files['main.tf']!, /PublishZip|ApproveArtifact/);
  assert.equal(stale.files['APPROVER-POLICY.json'], undefined);
  const release = { ...values, release: 'S3_ZIP', release_bucket: 'application-releases', release_key: 'application.zip', approval: 'MANUAL' };
  for (const [key, value] of Object.entries({ release_bucket: values.artifact_bucket, release_key: '*.zip', release_kms: 'bad', review_url: 'https://user:pass@example.org', review_note: 'x'.repeat(1001) })) assert.ok(AWS_CODEPIPELINE_SERVICE.build({ ...release, [key]: value }).findings.some(finding => finding.path === key), key);
});
