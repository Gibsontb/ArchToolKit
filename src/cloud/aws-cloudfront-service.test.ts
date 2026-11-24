import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_CLOUDFRONT_SERVICE } from './aws-cloudfront-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_CLOUDFRONT_SERVICE), aws_region: 'us-east-1', name: 'Application static site', bucket: 'example-application-content-123456789012' };

test('CloudFront exports encrypted private origin with distribution-scoped access and HTTPS', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-cloudfront')?.terraform[0], AWS_CLOUDFRONT_SERVICE);
  const result = AWS_CLOUDFRONT_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /signing_behavior\s+= "always"/);
  assert.match(code, /viewer_protocol_policy\s+= "redirect-to-https"/);
  assert.match(code, /cloudfront_default_certificate\s+= true/);
  assert.match(code, /AWS:SourceArn/);
  assert.match(code, /aws_cloudfront_distribution.configured.arn/);
  assert.match(code, /block_public_policy\s+= true/);
  assert.match(code, /Managed-CachingOptimized/);
});

test('CloudFront custom hosts require regional certificate and qualified edge WAF', () => {
  const certificate = 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-abcd-abcd-abcd-123456789abc';
  const result = AWS_CLOUDFRONT_SERVICE.build({ ...values, aliases: 'site.example.com', certificate });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /minimum_protocol_version\s+= "TLSv1.2_2021"/);
  const invalid = AWS_CLOUDFRONT_SERVICE.build({ ...values, aws_region: 'us-gov-west-1', aliases: 'site.example.com', certificate: certificate.replace('us-east-1', 'us-west-2'), root: '/index.html', waf: 'regional-acl' });
  for (const path of ['aws_region', 'certificate', 'root', 'waf']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
