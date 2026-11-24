import { bool } from '../kit/blueprint.ts';
import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { AWS_FARGATE_SIZES as sizes } from './aws-fargate-sizes.ts';
import { blk, dat, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_ECS_APP_SERVICE = {
  id: 'aws_service_ecs_application', label: 'Create an ECS cluster and deploy a container',
  description: 'Create a cluster, Linux Fargate task definition, application logs and replicated service from a digest-pinned container image.',
  emits: ['aws_ecs_cluster', 'aws_ecs_task_definition', 'aws_cloudwatch_log_group', 'aws_ecs_service'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Application and cluster name', control: 'text' },
    { id: 'image', label: 'Container image digest URI', control: 'text', hint: 'Registry/repository@sha256: followed by the 64-character digest. Package the image for the selected processor architecture.' },
    { id: 'architecture', label: 'Processor architecture', control: 'select', default: 'X86_64', options: [{ value: 'X86_64', label: 'x86-64' }, { value: 'ARM64', label: 'ARM64' }] },
    { id: 'size', label: 'Task CPU and memory', control: 'select', default: '512:1024', options: sizes },
    { id: 'execution_role', label: 'Existing task execution IAM role ARN', control: 'text', hint: 'Trust ecs-tasks.amazonaws.com. Grant image-pull and CloudWatch Logs permissions, plus any required registry credentials.' },
    { id: 'task_role', label: 'Existing application IAM role ARN', control: 'text', hint: 'Optional task role trusted by ecs-tasks.amazonaws.com. Grant only application API and runtime secret-retrieval permissions.' },
    { id: 'subnets', label: 'Existing task subnet IDs', control: 'text', hint: 'Comma-separated subnet IDs within one VPC. Select multiple Availability Zones for redundancy.' },
    { id: 'groups', label: 'Existing task security group IDs', control: 'text', hint: 'Comma-separated security group IDs in the task VPC. Allow only the required application traffic.' },
    { id: 'public_ip', label: 'Assign task public IPs', control: 'toggle', default: false, hint: 'Use an internet gateway route when enabled; otherwise provide NAT or image/logging VPC endpoints.' },
    { id: 'port', label: 'Container application port', control: 'number', default: 8080, min: 1, max: 65535 },
    { id: 'target_group', label: 'Existing ALB target group ARN', control: 'text', hint: 'Optional HTTP/HTTPS target group with IP targets in the task VPC, already connected to an ALB listener.' },
    { id: 'replicas', label: 'Desired task count', control: 'number', default: 2, min: 1 },
    { id: 'readonly', label: 'Read-only container root filesystem', control: 'toggle', default: true, hint: 'Disable if the application requires writable root paths. This form does not create persistent volumes.' },
    { id: 'environment', label: 'Non-secret environment variables (JSON)', control: 'textarea', hint: 'Optional string-to-string object. Retrieve secrets at runtime using the application role.' },
    { id: 'retention', label: 'Application log retention', control: 'select', default: '30', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: value + ' days' })) },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.ecs-app.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), image = String(values.image ?? '').trim();
    const size = String(values.size ?? ''), [cpu, memory] = size.split(':'), architecture = String(values.architecture ?? ''), target = String(values.target_group ?? '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name)) reject('name', 'Use a letter followed by up to 99 letters, numbers, hyphens or underscores.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(image)) reject('image', 'Enter an image URI pinned to its SHA256 digest.');
    if (!sizes.some(option => option.value === size)) reject('size', 'Select a valid Fargate CPU and memory combination.');
    if (!['X86_64', 'ARM64'].includes(architecture)) reject('architecture', 'Select the container processor architecture.');
    const accounts: string[] = [];
    for (const key of ['execution_role', 'task_role']) {
      if (key === 'task_role' && !values[key]) continue;
      const parsed = /^arn:([^:]+):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/.exec(String(values[key] ?? ''));
      if (!parsed || parsed[1] !== partition) reject(key, 'Use an existing task role in the selected partition.');
      accounts.push(parsed?.[2] ?? '');
    }
    const list = (key: string) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), groups = list('groups');
    if (!subnets.length || subnets.length > 16 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Enter 1–16 valid subnet IDs.');
    if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Enter 1–5 valid security group IDs.');
    if (target) {
      const parsed = /^arn:([^:]+):elasticloadbalancing:([^:]+):(\d{12}):targetgroup\/[A-Za-z0-9-]+\/[a-f0-9]+$/.exec(target);
      if (!parsed || parsed[1] !== partition || parsed[2] !== location) reject('target_group', 'Use an ALB target group ARN in the selected region and partition.');
      accounts.push(parsed?.[3] ?? '');
    }
    const port = Number(values.port), replicas = Number(values.replicas), retention = Number(values.retention);
    if (!Number.isInteger(port) || port < 1 || port > 65535) reject('port', 'Enter a container port from 1–65535.');
    if (!Number.isInteger(replicas) || replicas < 1 || replicas > 10000) reject('replicas', 'Enter 1–10,000 tasks and confirm regional Fargate quotas.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(retention)) reject('retention', 'Select application log retention.');
    let environment: Record<string, string> = {};
    try { environment = JSON.parse(String(values.environment || '{}')); if (!environment || Array.isArray(environment) || typeof environment !== 'object' || Object.entries(environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string')) throw new Error(); }
    catch { reject('environment', 'Enter a JSON object of environment variable names and string values.'); environment = {}; }
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      ...(target ? [dat('aws_lb_target_group', 'selected', { arn: target })] : []),
      res('aws_cloudwatch_log_group', 'application', { name: '/ecs/' + name, retention_in_days: retention }),
      res('aws_ecs_cluster', 'configured', { name }, [blk('setting', { name: 'containerInsights', value: 'enabled' })]),
      res('aws_ecs_task_definition', 'configured', {
        family: name, network_mode: 'awsvpc', requires_compatibilities: ['FARGATE'], cpu, memory,
        execution_role_arn: String(values.execution_role ?? ''), ...(values.task_role ? { task_role_arn: String(values.task_role) } : {}),
        container_definitions: x(jsonencode([{ name: 'application', image, essential: true, readonlyRootFilesystem: bool(values, 'readonly'),
          portMappings: [{ containerPort: port, protocol: 'tcp' }], environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
          logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': e('aws_cloudwatch_log_group.application.name'), 'awslogs-region': location, 'awslogs-stream-prefix': 'application' } },
        }])),
      }, [blk('runtime_platform', { operating_system_family: 'LINUX', cpu_architecture: architecture })]),
      res('aws_ecs_service', 'configured', {
        name, cluster: x('aws_ecs_cluster.configured.id'), task_definition: x('aws_ecs_task_definition.configured.arn'), desired_count: replicas, launch_type: 'FARGATE', platform_version: '1.4.0', wait_for_steady_state: true,
      }, [blk('network_configuration', { subnets, security_groups: groups, assign_public_ip: bool(values, 'public_ip') }),
        blk('deployment_circuit_breaker', { enable: true, rollback: true }),
        ...(target ? [blk('load_balancer', { target_group_arn: target, container_name: 'application', container_port: port })] : []),
        blk('lifecycle', {}, [
          blk('precondition', { condition: x('length(toset(concat([for subnet in data.aws_subnet.selected : subnet.vpc_id], [for group in data.aws_security_group.selected : group.vpc_id]))) == 1'), error_message: 'Task subnets and security groups must belong to one VPC.' }),
          blk('precondition', { condition: x('alltrue([for subnet in data.aws_subnet.selected : !subnet.ipv6_native])'), error_message: 'This task setup requires IPv4-capable subnets.' }),
          blk('precondition', { condition: x('alltrue([for account in ' + JSON.stringify(accounts) + ' : account == data.aws_caller_identity.current.account_id])'), error_message: 'Use task roles and a target group in the deployment account.' }),
          ...(target ? [blk('precondition', { condition: x('data.aws_lb_target_group.selected.target_type == "ip" && contains(["HTTP", "HTTPS"], data.aws_lb_target_group.selected.protocol) && data.aws_lb_target_group.selected.vpc_id == values(data.aws_subnet.selected)[0].vpc_id'), error_message: 'Use an HTTP/HTTPS ALB target group with IP targets in the task VPC.' })] : []),
        ]),
      ]),
      output('cluster_arn', 'aws_ecs_cluster.configured.arn'), output('service_name', 'aws_ecs_service.configured.name'), output('task_definition_arn', 'aws_ecs_task_definition.configured.arn'),
    ], `# ECS application on Linux Fargate

## Prepare
Build and scan the image for the selected CPU architecture and obtain its immutable digest. The registry must be reachable and allow the execution role to pull. Private registries requiring credentials need the existing task-definition builder's repository credential configuration. Prepare task subnets, egress or VPC endpoints, and security groups. Verify Fargate 1.4.0 availability and quotas. Prepare separate execution/application permissions and iam:PassRole for deployment. An optional ALB target group must already be attached to a listener, use IP targets, and allow the container port and health checks.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the new cluster, digest-pinned task, CPU/memory, networking, public-IP setting and log costs. Apply the saved plan. This creates one essential container per task and a replicated service. Adjust the read-only root option to match the application's writable-path requirements. No persistent data volume or application secret value is exported.

## Verify
Wait for service stability, inspect deployment events and stopped-task reasons, and confirm the desired number of running tasks. Check logs and verify application behavior through the configured ALB or an authorized network client. Verify image architecture, egress, IAM and health checks when tasks fail. A running process alone is insufficient application validation. Test replica replacement and deployment rollback with a deliberately failing test revision.

## Recovery
Restore the last known-good task definition revision and validate service health. The deployment circuit breaker rolls back only when a prior completed deployment exists; initial failures require correction and redeployment. Preserve external application data and the previous production service during cutover. This form covers a new Linux Fargate application; existing clusters/tasks remain available through the existing-resource service form. Autoscaling, volumes, multiple containers, Windows, service discovery and private-registry credentials use their corresponding existing builders.

https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html
`, findings);
  },
} satisfies Blueprint;
