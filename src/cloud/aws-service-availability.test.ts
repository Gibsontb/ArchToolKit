import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addServicesFor } from './add-service-catalog.ts';
import { AWS_SERVICE_AVAILABILITY } from './aws-service-availability.ts';
test('Retired Honeycode is distinguished from eligible existing-customer App Runner', () => {
  const rows = addServicesFor('aws');
  const retired = rows.find(row => row.id === 'amazon-honeycode')!;
  assert.equal(retired.availability?.status, 'retired');
  assert.equal(retired.availability?.effective, '2024-02-29');
  assert.match(retired.availability!.reference, /^https:\/\/aws\.amazon\.com\//);
  assert.equal(rows.find(row => row.id === 'aws-app-runner')?.availability?.status, 'existing-customers-only');
});
test('retirement evidence maps real historical entries without disabling active successor products', () => {
  const rows = addServicesFor('aws');
  for (const [id, evidence] of Object.entries(AWS_SERVICE_AVAILABILITY)) {
    assert.ok(rows.some(row => row.id === id), id);
    if(evidence.effective){
      assert.match(evidence.effective,/^\d{4}-\d{2}-\d{2}$/,id);
      assert.ok(evidence.effective <= evidence.checked, id);
    }else{
      assert.equal(evidence.status,'retired',id);
      assert.match(evidence.message,/exact retirement date has not been established/,id);
    }
    assert.equal(rows.find(row => row.id === id)?.availability?.status, evidence.status, id);
  }
  for (const id of ['amazon-inspector', 'inspector2', 'aws-wafv2', 'aws-codestar-connections', 'aws-codestar-notifications', 'aws-iot-greengrass-v2', 'amazon-chime-sdk', 'amazon-pinpoint-sms-voice-v2', 'aws-database-migration-service', 'taxonomy:kinesisdataanalytics']) {
    const row = rows.find(item => item.id === id);
    assert.ok(row, id);
    assert.notEqual(row.availability?.status, 'retired', id);
  }
});
