import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { addServicesFor } from './add-service-catalog.ts';
import { AWS_ECS_SERVICE } from './aws-ecs-service.ts';

const values = {
  ...defaultValues(AWS_ECS_SERVICE), aws_region: 'us-east-1', name: 'api',
  cluster: 'arn:aws:ecs:us-east-1:123456789012:cluster/production',
  task: 'arn:aws:ecs:us-east-1:123456789012:task-definition/api:12',
  subnets: 'subnet-0123456789abcdef0, subnet-0123456789abcdef1',
  groups: 'sg-0123456789abcdef0',
};

test('ECS Fargate form exports a pinned service, network precondition and rollback', () => {
  assert.equal(addServicesFor('aws').find(service => service.id === 'amazon-elastic-container-service')?.terraform[0], AWS_ECS_SERVICE);
  const result = AWS_ECS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /task_definition\s+= "arn:aws:ecs:us-east-1:123456789012:task-definition\/api:12"/);
  assert.match(result.files['main.tf']!, /launch_type\s+= "FARGATE"/);
  assert.match(result.files['main.tf']!, /assign_public_ip\s+= false/);
  assert.match(result.files['main.tf']!, /rollback\s+= true/);
  assert.match(result.files['main.tf']!, /must belong to the same VPC/);
  assert.match(result.files['SERVICE-SETUP.md']!, /stopped task reasons/);
});

test('ECS rejects unpinned revisions, mismatched accounts and invalid network IDs', () => {
  const invalid = AWS_ECS_SERVICE.build({ ...values, task: values.task.replace(':12', ''), subnets: 'vpc-invalid', groups: '', replicas: 0 });
  for (const path of ['task', 'subnets', 'groups', 'replicas']) assert.ok(invalid.findings.some(f => f.path === path));
  const wrongAccount = AWS_ECS_SERVICE.build({ ...values, task: values.task.replace('123456789012', '111111111111') });
  assert.ok(wrongAccount.findings.some(f => f.path === 'task' && /same account/.test(f.message)));
});
