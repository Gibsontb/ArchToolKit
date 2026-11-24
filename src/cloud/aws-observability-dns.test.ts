import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues, type Blueprint, type BlueprintValues } from '../kit/blueprint.ts';
import { addServicesFor } from './add-service-catalog.ts';
import { AWS_CLOUDWATCH_SERVICE, AWS_CLOUDWATCH_LOGS_SERVICE } from './aws-observability-services.ts';
import { AWS_ROUTE53_SERVICE } from './aws-route53-service.ts';

const build = (form: Blueprint, values: BlueprintValues) =>
  form.build({ ...defaultValues(form), aws_region: 'us-east-1', ...values });

test('CloudWatch and Route 53 product entries open the dedicated configuration', () => {
  for (const [id, form] of [
    ['amazon-cloudwatch', AWS_CLOUDWATCH_SERVICE],
    ['amazon-cloudwatch-logs', AWS_CLOUDWATCH_LOGS_SERVICE],
    ['amazon-route-53', AWS_ROUTE53_SERVICE],
  ] as const) {
    assert.equal(addServicesFor('aws').find(service => service.id === id)?.terraform[0], form);
  }
});

test('CloudWatch alarm packages its metric identity and rejects invalid evaluation and SNS settings', () => {
  const values = { name: 'api-cpu', namespace: 'AWS/EC2', metric: 'CPUUtilization', dimensions: 'InstanceId=i-0123456789abcdef0', topic: 'arn:aws:sns:us-east-1:123456789012:alerts' };
  const config = build(AWS_CLOUDWATCH_SERVICE, values);
  assert.deepEqual(config.findings, []);
  assert.match(config.files['main.tf']!, /"InstanceId" = "i-0123456789abcdef0"/);
  assert.match(config.files['main.tf']!, /datapoints_to_alarm\s+= 3/);
  assert.match(config.files['versions.tf']!, /required_providers\s*\{/);
  assert.match(config.files['SERVICE-SETUP.md']!, /alarm history/);
  const invalid = build(AWS_CLOUDWATCH_SERVICE, { ...values, evaluation: 2, period: 75, topic: values.topic.replace('us-east-1', 'us-west-2') });
  for (const path of ['period', 'datapoints', 'topic']) assert.ok(invalid.findings.some(f => f.path === path));
});

test('CloudWatch Logs sets retention, preserves logs on destroy and checks KMS region', () => {
  const kms_key = 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012';
  const config = build(AWS_CLOUDWATCH_LOGS_SERVICE, { name: '/apps/api', retention: '90', kms_key });
  assert.deepEqual(config.findings, []);
  assert.match(config.files['main.tf']!, /retention_in_days\s+= 90/);
  assert.match(config.files['main.tf']!, /skip_destroy\s+= true/);
  assert.match(config.files['main.tf']!, /kms_key_id\s+= "arn:aws:kms:/);
  assert.equal(build(AWS_CLOUDWATCH_LOGS_SERVICE, { name: 'aws/invalid', retention: '', kms_key, aws_region: 'us-west-2' }).findings.length, 3);
});

test('Route 53 private zone attaches the region VPC while public zone exposes name servers', () => {
  const zone_name = 'example.com.';
  const publicZone = build(AWS_ROUTE53_SERVICE, { zone_name, vpc_id: 'ignored' });
  assert.deepEqual(publicZone.findings, []);
  assert.doesNotMatch(publicZone.files['main.tf']!, /vpc\s*\{/);
  assert.match(publicZone.files['outputs.tf']!, /authoritative_name_servers/);
  const privateZone = build(AWS_ROUTE53_SERVICE, { zone_name, mode: 'private', vpc_id: 'vpc-0123456789abcdef0' });
  assert.deepEqual(privateZone.findings, []);
  assert.match(privateZone.files['main.tf']!, /vpc_region\s+= "us-east-1"/);
  assert.doesNotMatch(privateZone.files['outputs.tf']!, /authoritative_name_servers/);
});

test('Route 53 record exports clean TXT and alias values and rejects apex CNAME', () => {
  const base = { zone_id: 'Z123456', mode: 'record' };
  const txt = build(AWS_ROUTE53_SERVICE, { ...base, record_type: 'TXT', records: 'v=spf1 -all' });
  assert.deepEqual(txt.findings, []);
  assert.match(txt.files['main.tf']!, /records\s+= \["v=spf1 -all"\]/);
  assert.match(txt.files['main.tf']!, /allow_overwrite\s+= false/);
  const alias = build(AWS_ROUTE53_SERVICE, { ...base, mode: 'alias', alias_type: 'AAAA', alias_name: 'd123.cloudfront.net.', alias_zone: 'Z123789' });
  assert.deepEqual(alias.findings, []);
  assert.match(alias.files['main.tf']!, /type\s+= "AAAA"/);
  assert.match(alias.files['main.tf']!, /alias\s*\{/);
  assert.doesNotMatch(alias.files['main.tf']!, /ttl\s*=/);
  const cname = build(AWS_ROUTE53_SERVICE, { ...base, record_type: 'CNAME', records: 'example.net.' });
  assert.ok(cname.findings.some(f => f.path === 'records'));
});
