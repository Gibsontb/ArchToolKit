import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addServicesFor } from './add-service-catalog.ts';
import { AWS_RUNTIME_APIS } from './aws-runtime-apis.ts';
test('Runtime APIs point to existing setup services without becoming infrastructure aliases', () => {
  const rows = addServicesFor('aws');
  for (const [id, metadata] of Object.entries(AWS_RUNTIME_APIS)) {
    const runtime = rows.find(row => row.id === id)!;
    assert.deepEqual(runtime.runtimeApi, metadata);
    assert.equal(runtime.setupAliasOf, undefined);
    assert.equal(runtime.terraform.length, 0);
    const related = rows.find(row => row.id === metadata.setupService)!;
    assert.ok(related, metadata.setupService + ' must exist');
    assert.ok(related.terraform.length || related.cloudformation.length, metadata.setupService + ' must expose setup');
    assert.match(metadata.reference, /^https:\/\/docs\.aws\.amazon\.com\//);
  }
});
