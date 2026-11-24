import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_GLUE_CRAWLER_SERVICE as crawler } from './aws-glue-crawler-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(crawler), aws_region: 'us-east-1', name: 'application-crawler', database: 'application', role: 'arn:aws:iam::123456789012:role/GlueExecution', bucket: 'application-source' };
test('crawler keeps ETL preferred and emits explicit metadata-only setup', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-glue')?.terraform[1], crawler);
  const result = crawler.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/aws_glue_crawler/, /TableThreshold/, /InheritFromTable/, /prevent_destroy/, /delete_behavior\s+= "LOG"/, /update_behavior\s+= "LOG"/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /aws_glue_catalog_database|glue:DeleteTable|s3:PutObject|aws_glue_trigger|schedule\s+=/);
  assert.equal(JSON.parse(result.files['CREATE-DATABASE.json']!).DatabaseInput.CreateTableDefaultPermissions.length, 0);
  assert.match(result.files['OPERATE.ps1']!, /InspectPrerequisites/);
  assert.match(result.files['OPERATE.ps1']!, /start-crawler/);
  assert.doesNotMatch(result.files['OPERATE.ps1']!, /put-data-lake-settings|create-database/);
});
test('crawler bounds source, sampling and metadata expansion', () => {
  for (const [key, value] of Object.entries({ name: '', database: 'UpperCase', role: 'bad', bucket: 'bad..bucket', prefix: '../', table_prefix: '*', sample: 250, threshold: 0, recrawl: 'ALL', kms: 'bad' })) {
    assert.ok(crawler.build({ ...values, [key]: value }).findings.some(f => f.path === key), key);
  }
  const main = crawler.build({ ...values, recrawl: 'CRAWL_NEW_FOLDERS_ONLY', sample: 25 }).files['main.tf']!;
  assert.match(main, /sample_size\s+= 25/);
  assert.match(main, /CRAWL_NEW_FOLDERS_ONLY/);
});
