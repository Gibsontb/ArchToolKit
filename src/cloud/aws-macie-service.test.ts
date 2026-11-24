import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_MACIE_SERVICE } from './aws-macie-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_MACIE_SERVICE), aws_region: 'us-east-1', name: 'application-data-review', account: '123456789012', buckets: 'application-records' };
test('Macie job scopes bucket/prefix inspection and exports job-specific report retrieval', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-macie')?.terraform[0], AWS_MACIE_SERVICE);
  const result = AWS_MACIE_SERVICE.build({ ...values, prefixes: 'exports/,reports/', sample: 10 });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /job_type\s+= "ONE_TIME"/);
  assert.match(result.files['main.tf']!, /STARTS_WITH/);
  assert.match(result.files['main.tf']!, /sampling_percentage\s+= 10/);
  assert.doesNotMatch(result.files['main.tf']!, /schedule_frequency|aws_macie2_account/);
  assert.match(result.files['GET-REPORT.ps1']!, /classificationDetails.jobId/);
  assert.match(result.files['GET-REPORT.ps1']!, /\$offset \+= 50/);
});
test('Macie schedules use correct provider argument shapes and preserve initial-run choice', () => {
  for (const [frequency, expected] of [['DAILY', /daily_schedule\s+= true/], ['WEEKLY', /weekly_schedule\s+= "MON"/], ['MONTHLY', /monthly_schedule\s+= 1/]] as const) {
    const result = AWS_MACIE_SERVICE.build({ ...values, frequency });
    assert.deepEqual(result.findings, []);
    assert.match(result.files['main.tf']!, expected);
    assert.match(result.files['main.tf']!, /initial_run\s+= false/);
  }
  assert.match(AWS_MACIE_SERVICE.build({ ...values, frequency: 'DAILY', initial: 'yes' }).files['main.tf']!, /initial_run\s+= true/);
});
test('Macie rejects ambiguous object globs and invalid scope/sample/account controls', () => {
  for (const [key, value] of Object.entries({ buckets: '', prefixes: 'exports/*', sample: 0, account: '123', identifiers: 'not-an-id', frequency: 'HOURLY' })) assert.ok(AWS_MACIE_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  assert.ok(AWS_MACIE_SERVICE.build({ ...values, frequency: 'MONTHLY', month_day: 31 }).findings.some(finding => finding.path === 'month_day'));
});
