import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
import { AWS_FARGATE_SIZES } from './aws-fargate-sizes.ts';

export const AWS_BATCH_SERVICE = {
  id: 'aws_service_batch_fargate', label: 'Set up a Fargate Batch job and queue',
  description: 'Create managed Fargate capacity, a job queue, digest-pinned Linux job definition, retained logs and deployment-time submission JSON.',
  emits: ['aws_batch_compute_environment', 'aws_batch_job_queue', 'aws_batch_job_definition', 'aws_cloudwatch_log_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Batch workload name', control: 'text' },
    { id: 'image', label: 'Container image URI and SHA256 digest', control: 'text', hint: 'Existing Linux x86-64 image pinned with @sha256: followed by 64 lowercase hexadecimal characters.' },
    { id: 'execution_role', label: 'Existing ECS execution role ARN', control: 'text', hint: 'Must trust ecs-tasks.amazonaws.com and allow image pulls and writing to the generated log group.' },
    { id: 'job_role', label: 'Existing application job role ARN', control: 'text', hint: 'Optional workload identity with only the application permissions. Must trust ecs-tasks.amazonaws.com.' },
    { id: 'subnets', label: 'Existing job subnet IDs', control: 'text', hint: 'Comma-separated subnet IDs in one VPC, up to 16. Private subnets need working NAT or service endpoints.' },
    { id: 'groups', label: 'Existing job security group IDs', control: 'text', hint: 'Comma-separated security group IDs in the same VPC, up to five.' },
    { id: 'public_ip', label: 'Public IP for jobs', control: 'select', default: 'DISABLED', options: [{ value: 'DISABLED', label: 'Disabled — private egress required' }, { value: 'ENABLED', label: 'Enabled — public subnet routing required' }] },
    { id: 'capacity', label: 'Fargate capacity', control: 'select', default: 'FARGATE', options: [{ value: 'FARGATE', label: 'On-demand' }, { value: 'FARGATE_SPOT', label: 'Spot — interruption-tolerant jobs' }] },
    { id: 'max_cpu', label: 'Environment maximum concurrent vCPUs', control: 'number', default: 16 },
    { id: 'size', label: 'Per-job CPU and memory', control: 'select', default: '1024:2048', options: AWS_FARGATE_SIZES },
    { id: 'executable', label: 'Container executable', control: 'text', hint: 'Required program path or name, for example /app/run. No shell expansion is added.' },
    { id: 'arguments', label: 'Program arguments', control: 'textarea', hint: 'Optional, one argument per line. Spaces within each argument are preserved. Never include secret values.' },
    { id: 'attempts', label: 'Maximum attempts', control: 'number', default: 1 },
    { id: 'timeout', label: 'Per-attempt timeout (minutes)', control: 'number', default: 60 },
    { id: 'retention', label: 'Job log retention (days)', control: 'select', default: '30', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.batch.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), image = String(values.image ?? '').trim();
    const size = String(values.size ?? ''), [units, memory = ''] = size.split(':'), cpu = Number(units) / 1024, capacity = String(values.capacity ?? ''), publicIP = String(values.public_ip ?? '');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(name)) reject('name', 'Use a letter followed by up to 59 letters, numbers, underscores or hyphens.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(image)) reject('image', 'Use an existing Linux x86-64 image URI pinned to its SHA256 digest.');
    if (!AWS_FARGATE_SIZES.some(option => option.value === size)) reject('size', 'Choose a valid Linux Fargate CPU/memory combination.');
    if (!['FARGATE', 'FARGATE_SPOT'].includes(capacity)) reject('capacity', 'Choose a Fargate capacity type.');
    if (!['ENABLED', 'DISABLED'].includes(publicIP)) reject('public_ip', 'Select public IP behavior.');
    const roleAccounts: string[] = [];
    for (const key of ['execution_role', 'job_role']) {
      const value = String(values[key] ?? '').trim();
      if (!value && key === 'job_role') continue;
      const parsed = /^arn:([^:]+):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/.exec(value);
      if (!parsed || parsed[1] !== partition) reject(key, 'Use an existing task IAM role in the selected partition.');
      roleAccounts.push(parsed?.[2] ?? '');
    }
    const list = (key: string) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), groups = list('groups');
    if (!subnets.length || subnets.length > 16 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Use 1–16 subnet IDs in one VPC.');
    if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Use 1–5 security group IDs in the subnet VPC.');
    const maxCPU = Number(values.max_cpu), attempts = Number(values.attempts), timeout = Number(values.timeout), retention = Number(values.retention);
    if (!Number.isInteger(maxCPU) || maxCPU < Math.ceil(cpu) || maxCPU > 100000) reject('max_cpu', 'Use a whole maximum vCPU count that fits at least one job, up to 100,000, and verify regional quotas.');
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) reject('attempts', 'Use 1–10 attempts; retries require idempotent job behavior.');
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 20160) reject('timeout', 'Use 1–20,160 whole minutes. Fargate jobs must complete within the platform duration limit.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(retention)) reject('retention', 'Choose job log retention.');
    const executable = String(values.executable ?? '').trim(), args = String(values.arguments ?? '').split(/\r?\n/).filter(value => value.length);
    if (!executable || /[\x00-\x20]/.test(executable)) reject('executable', 'Enter one executable path/name without whitespace or control characters. Put arguments below.');
    if (args.length > 100 || args.some(value => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))) reject('arguments', 'Use up to 100 arguments without control characters, one per line.');
    return awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      res('aws_cloudwatch_log_group', 'jobs', { name: '/aws/batch/' + name, retention_in_days: retention }),
      res('aws_batch_compute_environment', 'configured', { compute_environment_name_prefix: name + '-', type: 'MANAGED', state: 'ENABLED' }, [
        blk('compute_resources', { type: capacity, max_vcpus: maxCPU, subnets, security_group_ids: groups }),
        blk('lifecycle', { create_before_destroy: true }, [blk('precondition', { condition: x('length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && alltrue([for group in data.aws_security_group.selected : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])'), error_message: 'All job subnets and security groups must belong to one VPC.' }), blk('precondition', { condition: x('alltrue([for account in ' + JSON.stringify(roleAccounts) + ' : account == data.aws_caller_identity.current.account_id])'), error_message: 'Task roles must belong to the deployment account.' })]),
      ]),
      res('aws_batch_job_queue', 'configured', { name: name + '-queue', state: 'ENABLED', priority: 1 }, [blk('compute_environment_order', { order: 1, compute_environment: x('aws_batch_compute_environment.configured.arn') })]),
      res('aws_batch_job_definition', 'configured', { name: name + '-job', type: 'container', platform_capabilities: ['FARGATE'], container_properties: x(jsonencode({ image, command: [executable, ...args], executionRoleArn: String(values.execution_role ?? '').trim(), ...(values.job_role ? { jobRoleArn: String(values.job_role).trim() } : {}), resourceRequirements: [{ type: 'VCPU', value: String(cpu) }, { type: 'MEMORY', value: memory }], runtimePlatform: { operatingSystemFamily: 'LINUX', cpuArchitecture: 'X86_64' }, fargatePlatformConfiguration: { platformVersion: '1.4.0' }, networkConfiguration: { assignPublicIp: publicIP }, logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': e('aws_cloudwatch_log_group.jobs.name'), 'awslogs-region': region, 'awslogs-stream-prefix': 'job' } } })) }, [blk('retry_strategy', { attempts }), blk('timeout', { attempt_duration_seconds: timeout * 60 })]),
      output('job_queue_arn', 'aws_batch_job_queue.configured.arn'), output('job_definition_arn', 'aws_batch_job_definition.configured.arn'),
      output('submit_job_json', jsonencode({ jobName: name + '-run', jobQueue: e('aws_batch_job_queue.configured.arn'), jobDefinition: e('aws_batch_job_definition.configured.arn') })),
    ], `# Fargate Batch compute, queue and job definition

## Prepare
Prepare a digest-pinned Linux x86-64 container with the selected executable. Existing execution/job roles must trust ecs-tasks.amazonaws.com. The execution role needs image-pull and logs:CreateLogStream/logs:PutLogEvents access for /aws/batch/${name}; the optional job role needs only application data/service permissions. Confirm service-linked Batch role creation permissions, iam:PassRole, regional Fargate availability and capacity quotas. Private networking needs NAT or the required ECR/S3/logs/application endpoints. Public-IP mode also needs public subnet routes and appropriate security-group egress. Quotas, subnet addresses and application connectivity are not proven by Terraform validate.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan; review capacity, networking, identities, pinned image, command, retry/timeout and log settings. Apply the saved reviewed plan. This creates infrastructure and a job definition without submitting a job. Save terraform output -raw submit_job_json as UTF-8 submit-job.json and run aws batch submit-job --cli-input-json file://submit-job.json --region ${region} when ready. Record the job ID. CPU selections convert ECS units to Batch vCPU exactly once; memory uses the provider's required MiB values. Arguments are direct process arguments, with no added shell expansion.

## Verify
Check that the compute environment is VALID and queue ENABLED using aws batch describe-compute-environments and aws batch describe-job-queues. Run aws batch describe-jobs --jobs <job-id> --region ${region}; track pending/runnable/starting/running/succeeded/failed states, attempts, exit codes and log stream. Test success, intentional failure, timeout and retry idempotency in a test workload. Spot capacity can be interrupted and is not guaranteed. Confirm application outputs and monitoring. Batch job success alone does not establish data integrity.

## Recovery
Cancel queued jobs with aws batch cancel-job or terminate running jobs with aws batch terminate-job, supplying a reason and --region ${region}. Job cancellation does not undo application side effects. Use checkpoints and application-level recovery. Drain or disable the queue before replacing/removing capacity, and retain prior job revisions and logs needed for recovery. Fargate jobs have duration/capacity limits and are unsuitable for uninterrupted long-lived services. EC2/GPU/EKS/multinode jobs, shared storage, secrets, job dependencies, scheduling and pipeline integration require corresponding additional builders.

https://docs.aws.amazon.com/batch/latest/userguide/fargate-job-definitions.html
`, findings);
  },
} satisfies Blueprint;
