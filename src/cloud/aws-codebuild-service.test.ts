import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_CODEBUILD_SERVICE } from './aws-codebuild-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_CODEBUILD_SERVICE), aws_region: 'us-east-1', name: 'application-build', role: 'arn:aws:iam::123456789012:role/build/CodeBuild', commands: 'node --version\nnpm test' };
test('CodeBuild exports inline build commands with private nonprivileged execution and scoped logs', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-codebuild')?.terraform[0], AWS_CODEBUILD_SERVICE);
  const result = AWS_CODEBUILD_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /privileged_mode\s+= false/);
  assert.match(result.files['main.tf']!, /type\s+= "NO_SOURCE"/);
  assert.match(result.files['main.tf']!, /project_visibility\s+= "PRIVATE"/);
  assert.match(result.files['buildspec.yml']!, /- "npm test"/);
  assert.doesNotMatch(result.files['main.tf']!, /s3:GetObject/);
});
test('CodeBuild pins S3 source and grants only selected object/key access', () => {
  const result = AWS_CODEBUILD_SERVICE.build({ ...values, source: 'S3', bucket: 'application-source', key: 'releases/source.zip', version: 'pinned-version', install: 'npm ci', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /source_version\s+= "pinned-version"/);
  assert.match(result.files['main.tf']!, /arn:aws:s3:::application-source\/releases\/source.zip/);
  assert.match(result.files['main.tf']!, /kms:Decrypt/);
  assert.match(result.files['buildspec.yml']!, /install:/);
  for (const [key, value] of Object.entries({ commands: '', timeout: 1, image: 'custom:latest', role: 'invalid', source: 'GITHUB' })) assert.ok(AWS_CODEBUILD_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  const switched = AWS_CODEBUILD_SERVICE.build({ ...values, bucket: 'leftover', key: '*', kms: 'old-key', version: 'old-version' });
  assert.deepEqual(switched.findings, []);
  assert.doesNotMatch(switched.files['main.tf']!, /leftover|old-key|old-version|s3:GetObject/);
});

test('CodeBuild pipeline mode emits artifacts and ignores inactive source values', () => {
  const result = AWS_CODEBUILD_SERVICE.build({ ...values, source: 'CODEPIPELINE', artifact_bucket: 'application-artifacts', artifact_prefix: 'application-release/', artifact_files: 'dist/**/*', bucket: 'inactive-source', key: '*' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /type\s+= "CODEPIPELINE"/);
  assert.match(result.files['main.tf']!, /application-artifacts\/application-release\/\*/);
  assert.doesNotMatch(result.files['main.tf']!, /inactive-source|NO_ARTIFACTS/);
  assert.match(result.files['buildspec.yml']!, /artifacts:/);
  assert.ok(AWS_CODEBUILD_SERVICE.build({ ...values, source: 'CODEPIPELINE', artifact_bucket: 'application-artifacts', artifact_prefix: 'application-release/', artifact_files: '../secrets' }).findings.some(finding => finding.path === 'artifact_files'));
});
