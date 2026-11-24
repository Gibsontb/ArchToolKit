import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { addServicesFor } from './add-service-catalog.ts';

test('dedicated AWS forms preserve toggle meaning for boolean defaults and edited dropdown strings', () => {
  const forms = [...new Map(addServicesFor('aws').flatMap(service => service.terraform).filter(form => form.id.startsWith('aws_service_')).map(form => [form.id, form])).values()];
  for (const form of forms) {
    const defaults = defaultValues(form);
    const toggles = form.inputs.filter(input => input.control === 'toggle');
    for (const value of [true, false]) {
      const booleans = { ...defaults, ...Object.fromEntries(toggles.map(input => [input.id, value])) };
      const strings = { ...defaults, ...Object.fromEntries(toggles.map(input => [input.id, String(value)])) };
      assert.deepEqual(form.build(strings, 'toggle-check'), form.build(booleans, 'toggle-check'), form.id + ' with ' + value);
    }
  }
});
