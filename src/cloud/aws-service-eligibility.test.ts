import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Blueprint } from '../kit/blueprint.ts';
import { defaultValues } from '../kit/blueprint.ts';
import { withAwsServiceEligibility } from './aws-service-eligibility.ts';
import { AWS_SERVICE_AVAILABILITY } from './aws-service-availability.ts';
import { AWS_APPRUNNER_SERVICE } from './aws-apprunner-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
test('existing-customer checks block artifact generation and retain lazy schemas/arguments', async () => {
  let loaded = false, built = 0;
  const source: Blueprint = { id: 'lazy', label: 'Lazy', description: 'Fixture', emits: [], get inputs() { return loaded ? [{ id: 'resource_name', label: 'Name', control: 'text' as const }] : []; }, async load() { loaded = true; }, build(values, name) { built++; return { files: { 'fixture.txt': String(values.resource_name) + '/' + name }, findings: [] }; } };
  const wrapped = withAwsServiceEligibility(source, AWS_SERVICE_AVAILABILITY['aws-cloud9']);
  assert.equal(wrapped.id, source.id);
  assert.deepEqual(wrapped.inputs, []);
  assert.deepEqual(wrapped.build(defaultValues(wrapped), 'fixture').files, {});
  assert.equal(built, 0);
  await wrapped.load!();
  assert.deepEqual(wrapped.inputs.map(input => input.id), ['service_existing_customer', 'resource_name']);
  assert.equal(wrapped.build({ service_existing_customer: true, resource_name: 'accepted' }, 'fixture').files['fixture.txt'], 'accepted/fixture');
  assert.equal(built, 1);
  assert.equal(wrapped.build({ service_existing_customer: 'true', resource_name: 'dropdown' }, 'fixture').files['fixture.txt'], 'dropdown/fixture');
  assert.deepEqual(wrapped.build({ service_existing_customer: 'false' }, 'fixture').files, {});
  assert.equal(withAwsServiceEligibility(wrapped, AWS_SERVICE_AVAILABILITY['aws-cloud9']), wrapped);
});
test('UI lifecycle adapter emits no retired files and App Runner retains one eligibility control', () => {
  const retired = addServicesFor('aws').find(row => row.id === 'aws-app-mesh')!;
  assert.ok(retired.terraform.length > 0);
  const blocked = withAwsServiceEligibility(retired.terraform[0]!, retired.availability).build({}, 'fixture');
  assert.deepEqual(blocked.files, {});
  assert.equal(blocked.findings?.[0]?.severity, 'error');
  assert.equal(withAwsServiceEligibility(AWS_APPRUNNER_SERVICE, AWS_SERVICE_AVAILABILITY['aws-app-runner']), AWS_APPRUNNER_SERVICE);
  assert.equal(AWS_APPRUNNER_SERVICE.inputs.filter(input => input.id === 'eligible').length, 1);
});
test('closed services retain their catalog definitions with an existing-account fact field', () => {
  const rows = addServicesFor('aws');
  for (const id of ['aws-cloud9', 'amazon-cloudsearch', 'amazon-codecatalyst', 'aws-systems-manager-incident-manager-contacts']) {
    const row = rows.find(item => item.id === id)!;
    assert.equal(row.availability?.status, 'existing-customers-only');
    for (const form of [...row.terraform, ...row.ansible]) {
      const wrapped = withAwsServiceEligibility(form, row.availability);
      assert.equal(wrapped.inputs.filter(input => input.id === 'service_existing_customer').length, 1);
      assert.deepEqual(wrapped.build({}, 'fixture').files, {});
      assert.equal(form.inputs.some(input => input.id === 'service_existing_customer'), false);
    }
  }
  assert.equal(rows.find(row => row.id === 'aws-systems-manager')?.availability, undefined);
});
