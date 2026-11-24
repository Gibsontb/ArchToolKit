import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_BUDGETS_SERVICE } from './aws-budgets-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_BUDGETS_SERVICE), aws_region: 'us-east-1', name: 'application-costs', emails: 'owner@example.com' };

test('budget workflow retains original builders and configures recurring actual/forecast alerts', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-budgets')?.terraform[0], AWS_BUDGETS_SERVICE);
  const result = AWS_BUDGETS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /time_unit\s+= "MONTHLY"/);
  assert.match(result.files['main.tf']!, /notification_type\s+= "ACTUAL"/);
  assert.match(result.files['main.tf']!, /notification_type\s+= "FORECASTED"/);
  assert.doesNotMatch(result.files['main.tf']!, /aws_budgets_budget_action/);
});

test('budget cost basis and billing scope remain explicit and duplicate recipients collapse', () => {
  const result = AWS_BUDGETS_SERVICE.build({ ...values, basis: 'amortized', credits: 'exclude', forecast: 'no', accounts: '123456789012,123456789012', services: 'Amazon Elastic Compute Cloud - Compute', emails: 'owner@example.com,owner@example.com' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /use_amortized\s+= true/);
  assert.match(result.files['main.tf']!, /include_credit\s+= false/);
  assert.match(result.files['main.tf']!, /name\s+= "LinkedAccount"/);
  assert.doesNotMatch(result.files['main.tf']!, /FORECASTED/);
  assert.equal(result.files['main.tf']!.match(/owner@example.com/g)?.length, 1);
  for (const [key, value] of Object.entries({ amount: -1, actual: 0, accounts: '123', emails: '', basis: 'other', period: 'WEEKLY' })) {
    assert.ok(AWS_BUDGETS_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  }
});
