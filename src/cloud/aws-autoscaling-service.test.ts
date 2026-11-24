import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_AUTOSCALING_SERVICE } from './aws-autoscaling-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_AUTOSCALING_SERVICE), aws_region: 'us-east-1', name: 'application', template: 'lt-0123456789abcdef0', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1' };

test('EC2 Auto Scaling exports pinned launch-template scaling with rolling recovery', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-ec2-auto-scaling')?.terraform[0], AWS_AUTOSCALING_SERVICE);
  const result = AWS_AUTOSCALING_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /version\s+= "1"/);
  assert.match(code, /ASGAverageCPUUtilization/);
  assert.match(code, /ignore_changes\s+= \[desired_capacity\]/);
  assert.match(code, /auto_rollback\s+= true/);
  assert.match(code, /max_healthy_percentage\s+= 200/);
  const manual = AWS_AUTOSCALING_SERVICE.build({ ...values, tracking: false, minimum: 0, desired: 0 });
  assert.deepEqual(manual.findings, []);
  assert.doesNotMatch(manual.files['main.tf']!, /aws_autoscaling_policy|ignore_changes/);
});

test('EC2 Auto Scaling checks capacity order, target groups and CPU scale-from-zero', () => {
  const invalid = AWS_AUTOSCALING_SERVICE.build({ ...values, health: 'ELB', minimum: 0, desired: 5, maximum: 4, version: '' });
  for (const path of ['targets', 'minimum', 'desired', 'version']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
  const target = AWS_AUTOSCALING_SERVICE.build({ ...values, health: 'ELB', targets: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/app/0123456789abcdef' });
  assert.deepEqual(target.findings, []);
  assert.match(target.files['main.tf']!, /target_type == "instance"/);
});
