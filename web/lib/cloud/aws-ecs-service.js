import { bool } from '../kit/blueprint.js';
import { error,              } from '../core/findings.js';
import {                } from '../kit/blueprint.js';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.js';
import { quote } from '../terraform/hcl.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

const idSuffix = '(?:[0-9a-f]{8}|[0-9a-f]{17})';
const subnetId = new RegExp('^subnet-' + idSuffix + '$');
const groupId = new RegExp('^sg-' + idSuffix + '$');
const ecsName = /^[A-Za-z0-9_-]{1,255}$/;
const clusterArn = /^arn:([^:]+):ecs:([^:]+):(\d{12}):cluster\/([A-Za-z0-9_-]{1,255})$/;
const taskArn = /^arn:([^:]+):ecs:([^:]+):(\d{12}):task-definition\/([A-Za-z0-9_-]{1,255}):[1-9][0-9]*$/;

export const AWS_ECS_SERVICE = {
  id: 'aws_service_ecs',
  label: 'Deploy an ECS Fargate service',
  description: 'Run a pinned task definition revision as a replicated Fargate service in an existing ECS cluster and VPC.',
  emits: ['aws_ecs_service'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'ECS service name', control: 'text' },
    { id: 'cluster', label: 'Existing ECS cluster ARN', control: 'text' },
    { id: 'task', label: 'Existing Fargate task definition revision ARN', control: 'text', hint: 'Use an ACTIVE definition compatible with Fargate and awsvpc, including its revision suffix.' },
    { id: 'subnets', label: 'Existing subnet IDs', control: 'text', hint: 'Enter 1–16 comma-separated subnets in one VPC. Choose multiple Availability Zones for redundancy.' },
    { id: 'groups', label: 'Existing security group IDs', control: 'text', hint: 'Enter 1–5 comma-separated security groups in the same VPC as the subnets.' },
    { id: 'public_ip', label: 'Assign a public IP to each task', control: 'toggle', default: false, hint: 'For subnets with an internet gateway route. For private tasks, provide NAT or the necessary VPC endpoints.' },
    { id: 'replicas', label: 'Desired task count', control: 'number', default: 2, min: 1 },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.ecs.' + path, message, { path }));
    const location = String(values.aws_region ?? '');
    const partition = awsServicePartition(location);
    const name = String(values.name ?? '').trim();
    const cluster = String(values.cluster ?? '').trim();
    const task = String(values.task ?? '').trim();
    const parsedCluster = clusterArn.exec(cluster);
    const parsedTask = taskArn.exec(task);
    const subnets = [...new Set(String(values.subnets ?? '').split(',').map(item => item.trim()).filter(Boolean))];
    const groups = [...new Set(String(values.groups ?? '').split(',').map(item => item.trim()).filter(Boolean))];
    const replicas = Number(values.replicas);

    if (!ecsName.test(name)) reject('name', 'Use 1–255 letters, numbers, underscores or hyphens.');
    if (parsedCluster?.[1] !== partition || parsedCluster?.[2] !== location) reject('cluster', 'Enter an ECS cluster ARN in the selected region and partition.');
    if (parsedTask?.[1] !== partition || parsedTask?.[2] !== location) reject('task', 'Enter a revision-qualified ECS task definition ARN in the selected region and partition.');
    if (parsedTask && parsedCluster && parsedTask[3] !== parsedCluster[3]) reject('task', 'The task definition and cluster must be in the same account.');
    if (subnets.length < 1 || subnets.length > 16 || subnets.some(id => !subnetId.test(id))) reject('subnets', 'Enter 1–16 valid subnet IDs.');
    if (groups.length < 1 || groups.length > 5 || groups.some(id => !groupId.test(id))) reject('groups', 'Enter 1–5 valid security group IDs.');
    if (!Number.isSafeInteger(replicas) || replicas < 1 || replicas > 2147483647) reject('replicas', 'Enter a positive whole task count within the API range.');

    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      res('aws_ecs_service', 'configured', {
        name, cluster, task_definition: task, desired_count: replicas, launch_type: 'FARGATE',
        deployment_minimum_healthy_percent: 100, deployment_maximum_percent: 200,
        wait_for_steady_state: true,
      }, [
        blk('network_configuration', { subnets, security_groups: groups, assign_public_ip: bool(values, 'public_ip') }),
        blk('deployment_circuit_breaker', { enable: true, rollback: true }),
        blk('lifecycle', {}, [
          blk('precondition', {
            condition: x('data.aws_caller_identity.current.account_id == ' + quote(parsedCluster?.[3] ?? '')),
            error_message: 'The deployment identity must be in the ECS cluster account.',
          }),
          blk('precondition', {
            condition: x('length(toset(concat([for subnet in data.aws_subnet.selected : subnet.vpc_id], [for group in data.aws_security_group.selected : group.vpc_id]))) == 1'),
            error_message: 'All selected subnets and security groups must belong to the same VPC.',
          }),
        ]),
      ]),
      output('ecs_service_arn', 'aws_ecs_service.configured.id'),
    ], `# ECS Fargate service

Confirm the cluster is ACTIVE and the exact task definition revision supports Fargate and uses awsvpc. Prepare the task execution role, application role, images, secrets and logging destinations referenced by that definition. Verify selected subnets have available IPs and routes to those dependencies, and that security groups and endpoints allow the required traffic. Configure application-level health checks in the task definition. This service runs the requested replicas without a load balancer.

Run terraform init, terraform validate, and terraform plan -out=service.tfplan. Check the account, cluster, task revision, VPC and expected desired count before applying the saved plan. Leave space and quota for replacement tasks during rolling deployments.

Confirm ECS reports the expected running count and a completed deployment. Inspect service events, stopped task reasons and application logs. Verify workload behavior from an authorized client. If the rollout fails, check image and secret access, subnet connectivity, execution-role permissions and health checks. ECS can roll back to a previously completed deployment. On initial deployment, correct the configuration and apply a reviewed plan. To roll back a later deployment, restore the last known-good revision ARN and review the resulting plan.

https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_services.html
`, findings);
  },
}                    ;
