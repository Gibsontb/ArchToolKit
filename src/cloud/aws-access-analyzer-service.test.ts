import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_ACCESS_ANALYZER_SERVICE } from './aws-access-analyzer-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_ACCESS_ANALYZER_SERVICE), aws_region: 'us-east-1', name: 'application-access', account:'123456789012' };

test('IAM Access Analyzer scopes external analysis and exports findings retrieval without remediation', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'taxonomy:iamaccessanalyzer')?.terraform[0], AWS_ACCESS_ANALYZER_SERVICE);
  const result = AWS_ACCESS_ANALYZER_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /type\s+= "ACCOUNT"/);
  assert.match(result.files['main.tf']!, /prevent_destroy\s+= true/);
  assert.match(result.files['GET-FINDINGS.ps1']!, /INSPECT.py.*--check --findings/);
  assert.doesNotMatch(result.files['main.tf']!, /unused_access/);
});

test('IAM Access Analyzer supports organization/unused scopes and validates lookback', () => {
  for (const type of ['ORGANIZATION', 'ACCOUNT_UNUSED_ACCESS', 'ORGANIZATION_UNUSED_ACCESS']) {
    const result = AWS_ACCESS_ANALYZER_SERVICE.build({ ...values, type, age: 180, organization:'o-1234567890' });
    assert.deepEqual(result.findings, []);
    if (type.endsWith('_UNUSED_ACCESS')) { assert.match(result.files['main.tf']!, /unused_access_age\s+= 180/); assert.match(result.files['INSPECT.py']!, /list_findings_v2/); }
  }
  assert.ok(AWS_ACCESS_ANALYZER_SERVICE.build({ ...values, type: 'ACCOUNT_UNUSED_ACCESS', age: 0 }).findings.some(finding => finding.path === 'age'));
});
