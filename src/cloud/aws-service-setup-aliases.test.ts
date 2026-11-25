import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addServicesFor } from './add-service-catalog.ts';
import { AWS_SERVICE_SETUP_ALIASES } from './aws-service-setup-aliases.ts';
test('Verified control-plane catalog aliases reuse the actual canonical builders', () => {
  const rows = addServicesFor('aws');
  for (const [id, metadata] of Object.entries(AWS_SERVICE_SETUP_ALIASES)) {
    const alias = rows.find(row => row.id === id)!, canonical = rows.find(row => row.id === metadata.canonical)!;
    assert.equal(alias.setupAliasOf, canonical.id);
    assert.ok(canonical.terraform.length > 0);
    assert.equal(alias.terraform[0], canonical.terraform[0]);
    for (const form of canonical.terraform) assert.ok(alias.terraform.includes(form));
  }
  assert.ok(rows.find(row => row.id === 'amazon-managed-service-for-apache-flink')!.terraform.every(form => form.emits.some(type => type.startsWith('aws_kinesisanalyticsv2_')) && form.emits.every(type => !type.startsWith('aws_kinesisanalytics_'))));
});
test('Runtime APIs and third-party fees do not receive misleading infrastructure aliases', () => {
  for (const id of ['amazon-cognito-identity','aws-transform','amazon-bedrock-runtime', 'amazon-ec2-optimize-cpu-license-included-third-party-fees', 'amazon-neptunedata']) assert.equal(addServicesFor('aws').find(row => row.id === id)?.setupAliasOf, undefined);
});
