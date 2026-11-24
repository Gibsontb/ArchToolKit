import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_ACM_SERVICE } from './aws-acm-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_ACM_SERVICE), aws_region: 'us-east-1', domain: '*.example.com', alternatives: 'example.com,api.example.com,example.com', zone: 'Z123456789' };

test('ACM wires DNS issuance, groups wildcard/apex records and waits for validation', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-certificate-manager')?.terraform[0], AWS_ACM_SERVICE);
  const result = AWS_ACM_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /validation_method\s+= "DNS"/);
  assert.match(code, /private_zone\s+= false/);
  assert.match(code, /records\[0\]/);
  assert.match(code, /trimprefix\(option.domain_name, "\*\."\)/);
  assert.match(code, /allow_overwrite\s+= false/);
  assert.match(code, /create_before_destroy\s+= true/);
  assert.match(code, /resource "aws_acm_certificate_validation"/);
  assert.match(result.files['outputs.tf']!, /validated_certificate_arn/);
});

test('ACM rejects invalid primary/SAN domains, hosted zones and algorithms', () => {
  const result = AWS_ACM_SERVICE.build({ ...values, domain: '*.*.example.com', alternatives: '127.0.0.1', zone: 'example.com', algorithm: 'invalid' });
  for (const path of ['domain', 'alternatives', 'zone', 'algorithm']) assert.ok(result.findings.some(finding => finding.path === path), path);
});
