import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_ECS_APP_SERVICE } from './aws-ecs-app-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_ECS_APP_SERVICE), aws_region: 'us-east-1', name: 'application', image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/application@sha256:' + 'a'.repeat(64), execution_role: 'arn:aws:iam::123456789012:role/EcsExecution', subnets: 'subnet-0123456789abcdef0', groups: 'sg-0123456789abcdef0' };

test('ECS application builds cluster, digest-pinned task, logs and a stable replicated service', () => {
  assert.ok(addServicesFor('aws').find(row => row.id === 'amazon-elastic-container-service')?.terraform.includes(AWS_ECS_APP_SERVICE));
  const result = AWS_ECS_APP_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  for (const type of ['aws_ecs_cluster', 'aws_ecs_task_definition', 'aws_ecs_service', 'aws_cloudwatch_log_group']) assert.ok(code.includes('resource "' + type + '"'), type);
  assert.match(code, /cpu\s+= "512"/);
  assert.match(code, /memory\s+= "1024"/);
  assert.match(code, /readonlyRootFilesystem\s+= true/);
  assert.match(code, /wait_for_steady_state\s+= true/);
  assert.match(code, /deployment_circuit_breaker/);
  assert.match(code, /assign_public_ip\s+= false/);
});

test('ECS application supports ALB IP targets and validates sizes, image pins and environment', () => {
  const target = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/application/0123456789abcdef';
  const result = AWS_ECS_APP_SERVICE.build({ ...values, target_group: target, architecture: 'ARM64', size: '1024:2048', environment: '{"APP_MODE":"production"}' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /target_type == "ip"/);
  assert.match(result.files['main.tf']!, /cpu_architecture\s+= "ARM64"/);
  assert.match(result.files['main.tf']!, /APP_MODE/);
  const invalid = AWS_ECS_APP_SERVICE.build({ ...values, image: 'application:latest', size: '256:4096', environment: '{"SECRET":42}', target_group: target.replace('us-east-1', 'us-west-2') });
  for (const path of ['image', 'size', 'environment', 'target_group']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});
