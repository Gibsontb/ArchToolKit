import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_WAF_SERVICE } from './aws-waf-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_WAF_SERVICE), aws_region: 'us-east-1', name: 'application' };

test('WAFv2 exports a count-first managed baseline and optional regional ALB association', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'aws-wafv2')?.terraform[0], AWS_WAF_SERVICE);
  const result = AWS_WAF_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /managed_rule_group_statement/);
  assert.match(code, /count\s*\{/);
  assert.match(code, /sampled_requests_enabled\s+= false/);
  const associated = AWS_WAF_SERVICE.build({ ...values, count: false, alb: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/application/0123456789abcdef' });
  assert.deepEqual(associated.findings, []);
  assert.match(associated.files['main.tf']!, /web_acl_arn\s+= aws_wafv2_web_acl.configured.arn/);
});

test('WAFv2 supports default-block client networks after managed-rule evaluation', () => {
  const result = AWS_WAF_SERVICE.build({ ...values, default_action: 'block', allowed: '192.0.2.8/24' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /addresses\s+= \["192.0.2.0\/24"\]/);
  assert.match(result.files['main.tf']!, /AllowedClients/);
  const ipv6 = AWS_WAF_SERVICE.build({ ...values, default_action: 'block', ip_version: 'IPV6', allowed: '2001:db8::/32' });
  assert.deepEqual(ipv6.findings, []);
  for (const allowed of ['', '0.0.0.0/0', '2001:db8::/32']) assert.ok(AWS_WAF_SERVICE.build({ ...values, default_action: 'block', allowed }).findings.some(finding => finding.path === 'allowed'));
});

test('WAFv2 rejects CloudFront placement outside us-east-1 and unknown managed groups', () => {
  const invalid = AWS_WAF_SERVICE.build({ ...values, scope: 'CLOUDFRONT', aws_region: 'us-west-2', rules: 'unknown' });
  for (const path of ['aws_region', 'rules']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
