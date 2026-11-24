import { bool } from '../kit/blueprint.ts';
import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_AUTOSCALING_SERVICE = {
  id: 'aws_service_autoscaling', label: 'Set up an EC2 Auto Scaling group',
  description: 'Scale a pinned existing launch-template version across VPC subnets, optionally with load-balancer health checks and CPU target tracking.',
  emits: ['aws_autoscaling_group', 'aws_autoscaling_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Auto Scaling group name', control: 'text' },
    { id: 'template', label: 'Existing launch template ID', control: 'text' },
    { id: 'version', label: 'Launch template version', control: 'number', default: 1, min: 1, hint: 'Pin an existing numeric version. Confirm its AMI, architecture, instance type, security groups and instance profile.' },
    { id: 'subnets', label: 'Existing subnet IDs', control: 'text', hint: 'Comma-separated IPv4-capable subnets in one VPC. Multiple Availability Zones are recommended.' },
    { id: 'minimum', label: 'Minimum instances', control: 'number', default: 2, min: 0 },
    { id: 'desired', label: 'Initial desired instances', control: 'number', default: 2, min: 0 },
    { id: 'maximum', label: 'Maximum instances', control: 'number', default: 4, min: 1 },
    { id: 'health', label: 'Health check source', control: 'select', default: 'EC2', options: [{ value: 'EC2', label: 'EC2 instance health' }, { value: 'ELB', label: 'EC2 and load balancer health' }] },
    { id: 'targets', label: 'Existing instance target group ARNs', control: 'text', hint: 'Optional comma-separated ALB/NLB target-group ARNs with instance targets. Required for ELB health checks.' },
    { id: 'warmup', label: 'Instance warm-up and health grace period (seconds)', control: 'number', default: 300, min: 0, max: 86400 },
    { id: 'tracking', label: 'Enable CPU target tracking', control: 'toggle', default: true },
    { id: 'cpu', label: 'Target average CPU (%)', control: 'number', default: 60, min: 1, max: 90, showWhen: { input: 'tracking', equals: ['true'] } },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.autoscaling.' + path, message, { path }));
    const name = String(values.name ?? ''), template = String(values.template ?? ''), location = String(values.aws_region ?? ''), partition = awsServicePartition(location), health = String(values.health ?? '');
    const list = (key: string) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), targets = list('targets'), accounts: string[] = [];
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) reject('name', 'Use 1–100 letters, numbers, dots, hyphens or underscores.');
    if (!/^lt-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(template)) reject('template', 'Enter an existing EC2 launch template ID.');
    if (!subnets.length || subnets.length > 32 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Enter 1–32 valid subnet IDs.');
    if (!['EC2', 'ELB'].includes(health)) reject('health', 'Select a health check source.');
    if (health === 'ELB' && !targets.length) reject('targets', 'Select at least one instance target group for ELB health checks.');
    for (const target of targets) {
      const parsed = /^arn:([^:]+):elasticloadbalancing:([^:]+):(\d{12}):targetgroup\/[A-Za-z0-9-]+\/[a-f0-9]+$/.exec(target);
      if (!parsed || parsed[1] !== partition || parsed[2] !== location) reject('targets', 'Use target groups in the selected partition and region.');
      accounts.push(parsed?.[3] ?? '');
    }
    const integer = (key: string, min: number, max: number) => { const value = Number(values[key]); if (values[key] === '' || !Number.isSafeInteger(value) || value < min || value > max) reject(key, 'Enter a whole number from ' + min + ' to ' + max + '.'); return value; };
    const version = integer('version', 1, 2147483647), minimum = integer('minimum', 0, 10000), desired = integer('desired', 0, 10000), maximum = integer('maximum', 1, 10000), warmup = integer('warmup', 0, 86400);
    if (minimum > desired || desired > maximum) reject('desired', 'Keep minimum ≤ desired ≤ maximum and confirm EC2 quotas.');
    const tracking = bool(values, 'tracking');
    const cpu = tracking ? integer('cpu', 1, 90) : 60;
    if (tracking && minimum < 1) reject('minimum', 'CPU target tracking requires at least one running instance for metric samples.');
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}), dat('aws_launch_template', 'selected', { id: template }),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      ...(targets.length ? [dat('aws_lb_target_group', 'selected', { for_each: x('toset(' + JSON.stringify(targets) + ')'), arn: x('each.value') })] : []),
      res('aws_autoscaling_group', 'configured', {
        name, min_size: minimum, desired_capacity: desired, max_size: maximum, vpc_zone_identifier: subnets,
        health_check_type: health, health_check_grace_period: warmup, default_instance_warmup: warmup, target_group_arns: targets, wait_for_capacity_timeout: '15m',
      }, [blk('launch_template', { id: x('data.aws_launch_template.selected.id'), version: String(version) }),
        blk('instance_refresh', { strategy: 'Rolling' }, [blk('preferences', { min_healthy_percentage: 90, max_healthy_percentage: 200, instance_warmup: warmup, skip_matching: true, auto_rollback: true })]),
        blk('tag', { key: 'Name', value: name, propagate_at_launch: true }),
        blk('lifecycle', tracking ? { ignore_changes: x('[desired_capacity]') } : {}, [
          blk('precondition', { condition: x('length(toset([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && alltrue([for subnet in data.aws_subnet.selected : !subnet.ipv6_native])'), error_message: 'Choose IPv4-capable subnets in one VPC.' }),
          ...(targets.length ? [
            blk('precondition', { condition: x('alltrue([for target in data.aws_lb_target_group.selected : target.target_type == "instance" && target.vpc_id == values(data.aws_subnet.selected)[0].vpc_id])'), error_message: 'Use instance target groups in the selected subnet VPC.' }),
            blk('precondition', { condition: x('alltrue([for account in ' + JSON.stringify(accounts) + ' : account == data.aws_caller_identity.current.account_id])'), error_message: 'Use target groups in the deployment account.' }),
          ] : []),
        ]),
      ]),
      ...(tracking ? [res('aws_autoscaling_policy', 'cpu', { name: name + '-cpu', autoscaling_group_name: x('aws_autoscaling_group.configured.name'), policy_type: 'TargetTrackingScaling' }, [blk('target_tracking_configuration', { target_value: cpu }, [blk('predefined_metric_specification', { predefined_metric_type: 'ASGAverageCPUUtilization' })])])] : []),
      output('autoscaling_group_name', 'aws_autoscaling_group.configured.name'),
    ], `# EC2 Auto Scaling group

## Prepare
Prepare and test the selected numeric launch-template version, including its AMI, instance type, role, root encryption and bootstrap. Confirm it does not pin a conflicting subnet or unsupported network-interface configuration. Its security groups must match the selected VPC. Confirm regional instance quotas and capacity. If using a load balancer, attach the target group to its listener, enable the selected zones, and verify application port and health-check security rules.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review capacity bounds, warm-up, health checks and the pinned template version. Apply the saved plan. CPU tracking manages desired capacity after creation; subsequent desired-field changes are intentionally ignored while tracking is enabled. Change scaling policy and bounds to control capacity. Updating the pinned template triggers a rolling instance refresh.

## Verify
Check scaling activities, instance health, successful bootstrap and application health. Test load and scale-out/scale-in within approved bounds. Check ALB/NLB target health when attached. CPU metrics must be present for target tracking. Confirm instance refresh can maintain healthy capacity; a small group may need additional headroom. Back up state outside disposable instances.

## Recovery
Restore the previous numeric template version and initiate or monitor the resulting refresh. Stop an unhealthy refresh and correct bootstrap, image, permissions or health checks before retrying. Do not assume reverting the template restores application data. Preserve external data and the previous service during cutover. This form uses one launch-template instance type and CPU tracking; mixed instances, scheduled scaling, warm pools and lifecycle hooks use their corresponding existing builders.

https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html
`, findings);
  },
} satisfies Blueprint;
