import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_GLUE_ETL_SERVICE } from './aws-glue-etl-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_GLUE_ETL_SERVICE), aws_region: 'us-east-1', name: 'application-convert', role: 'arn:aws:iam::123456789012:role/GlueExecution', source_bucket: 'application-source', target_bucket: 'application-destination', artifact_bucket: 'application-artifacts', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' };
test('Glue emits the actual Spark job/script with scoped encryption and no automatic execution', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-glue')?.terraform[0], AWS_GLUE_ETL_SERVICE);
  const result = AWS_GLUE_ETL_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/aws_s3_object/, /aws_glue_security_configuration/, /SSE-KMS/, /CSE-KMS/, /max_retries\s+= 0/, /max_concurrent_runs\s+= 1/, /job-bookmark-disable/, /AssociateKmsKey/, /file\(format/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /aws_glue_trigger|glue:StartJobRun|= "jsonencode/);
  assert.match(result.files['ETL.py']!, /mode\("errorifexists"\)/);
  assert.match(result.files['ETL.py']!, /uuid.uuid4/);
  assert.doesNotMatch(result.files['ETL.py']!, /overwrite|\.collect\(|\.show\(/);
});
test('Glue CSV inputs preserve header/string behavior and JSON has explicit line mode', () => {
  assert.match(AWS_GLUE_ETL_SERVICE.build({ ...values, source_format: 'csv' }).files['ETL.py']!, /inferSchema", "false"/);
  assert.match(AWS_GLUE_ETL_SERVICE.build({ ...values, source_format: 'json' }).files['ETL.py']!, /multiLine", "false"/);
  assert.match(AWS_GLUE_ETL_SERVICE.build({ ...values, target_format: 'csv' }).files['ETL.py']!, /option\("header", "true"\)/);
});
test('Glue rejects source recursion, artifact re-ingestion and unbounded resources', () => {
  assert.ok(AWS_GLUE_ETL_SERVICE.build({ ...values, target_bucket: values.source_bucket, target_prefix: 'source/converted/' }).findings.some(finding => finding.path === 'target_prefix'));
  for (const [key, value] of Object.entries({ artifact_bucket: values.source_bucket, kms: '', workers: 1, timeout: 10000, source_prefix: '../', source_format: 'xml', role: 'invalid' })) assert.ok(AWS_GLUE_ETL_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});
