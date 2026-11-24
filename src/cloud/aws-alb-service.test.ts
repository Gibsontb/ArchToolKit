import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_ALB_SERVICE } from './aws-alb-service.ts';
import { addServicesFor } from './add-service-catalog.ts';

const values = { ...defaultValues(AWS_ALB_SERVICE), aws_region: 'us-east-1', name: 'application-edge',
  subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', groups: 'sg-0123456789abcdef0',
  instances: 'i-0123456789abcdef0', certificate: 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-abcd-abcd-abcd-123456789abc' };

test('ALB configures HTTPS, target health, network guards and optional HTTP redirect', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'elastic-load-balancing')?.terraform[0], AWS_ALB_SERVICE);
  const result = AWS_ALB_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /enable_deletion_protection\s+= true/);
  assert.match(code, /resource "aws_lb_listener" "https"/);
  assert.match(code, /resource "aws_lb_listener" "http"/);
  assert.match(code, /resource "aws_lb_target_group_attachment"/);
  assert.match(code, /available_ip_address_count >= 8/);
  assert.match(code, /one VPC/);
  assert.match(code, /Enable each target instance Availability Zone/);
  assert.match(result.files['SERVICE-SETUP.md']!, /Recovery/);
  assert.doesNotMatch(AWS_ALB_SERVICE.build({ ...values, redirect: false }).files['main.tf']!, /resource "aws_lb_listener" "http"/);
});

test('ALB rejects incomplete networks, invalid targets and cross-region certificates', () => {
  const result = AWS_ALB_SERVICE.build({ ...values, subnets: 'subnet-0123456789abcdef0', groups: '', instances: 'invalid',
    certificate: values.certificate.replace('us-east-1', 'eu-west-1'), port: 0, health_path: 'health' });
  for (const path of ['subnets', 'groups', 'instances', 'certificate', 'port', 'health_path']) {
    assert.ok(result.findings.some(finding => finding.path === path), path);
  }
});
