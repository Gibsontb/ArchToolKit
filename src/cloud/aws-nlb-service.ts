import { bool } from '../kit/blueprint.ts';
import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_NLB_SERVICE = {
  id: 'aws_service_nlb', label: 'Set up a TCP or TLS Network Load Balancer',
  description: 'Create an IPv4 NLB with security groups, existing EC2 instance targets and optional TLS termination.',
  emits: ['aws_lb', 'aws_lb_target_group', 'aws_lb_target_group_attachment', 'aws_lb_listener'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Load balancer name', control: 'text' },
    { id: 'scheme', label: 'Access', control: 'select', default: 'internal', options: [{ value: 'internal', label: 'Internal' }, { value: 'internet', label: 'Internet-facing' }] },
    { id: 'subnets', label: 'Existing NLB subnet IDs', control: 'text', hint: 'Comma-separated IPv4-capable subnets in one VPC, one per Availability Zone.' },
    { id: 'groups', label: 'Existing NLB security group IDs', control: 'text', hint: 'Comma-separated security groups in the subnet VPC. They are attached when the NLB is created.' },
    { id: 'instances', label: 'Existing EC2 target IDs', control: 'text', hint: 'Comma-separated existing instances in the selected VPC and enabled Availability Zones.' },
    { id: 'listener', label: 'Listener protocol', control: 'select', default: 'TLS', options: [{ value: 'TLS', label: 'TLS — terminate client encryption at NLB' }, { value: 'TCP', label: 'TCP — forward connection unchanged' }] },
    { id: 'listener_port', label: 'Listener port', control: 'number', default: 443, min: 1, max: 65535 },
    { id: 'certificate', label: 'Existing regional ACM certificate ARN', control: 'text', showWhen: { input: 'listener', equals: ['TLS'] } },
    { id: 'target_protocol', label: 'Target protocol', control: 'select', default: 'TCP', options: [{ value: 'TCP', label: 'TCP' }, { value: 'TLS', label: 'TLS — re-encrypt from NLB' }] },
    { id: 'target_port', label: 'Target application port', control: 'number', default: 443, min: 1, max: 65535 },
    { id: 'cross_zone', label: 'Enable cross-zone load balancing', control: 'toggle', default: true },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.nlb.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), scheme = String(values.scheme ?? ''), listener = String(values.listener ?? ''), protocol = String(values.target_protocol ?? ''), certificate = String(values.certificate ?? '').trim();
    const list = (key: string) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), groups = list('groups'), instances = list('instances');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?$/.test(name) || name.startsWith('internal-')) reject('name', 'Use 1–32 letters, numbers or hyphens, with alphanumeric ends and no internal- prefix.');
    if (!['internal', 'internet'].includes(scheme)) reject('scheme', 'Select internal or internet-facing access.');
    if (!subnets.length || subnets.length > 16 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Enter 1–16 valid subnet IDs.');
    if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Enter 1–5 security group IDs.');
    if (!instances.length || instances.some(value => !/^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('instances', 'Enter existing EC2 instance IDs.');
    if (!['TCP', 'TLS'].includes(listener)) reject('listener', 'Select TCP or TLS.');
    if (!['TCP', 'TLS'].includes(protocol) || (listener === 'TCP' && protocol !== 'TCP')) reject('target_protocol', 'TCP listeners require TCP targets. TLS listeners can forward to TCP or TLS targets.');
    const parsed = /^arn:([^:]+):acm:([^:]+):(\d{12}):certificate\/[a-f0-9-]+$/.exec(certificate);
    if (listener === 'TLS' && (!parsed || parsed[1] !== partition || parsed[2] !== location)) reject('certificate', 'Use an issued ACM certificate ARN in the selected region and partition.');
    const port = (key: string) => { const value = Number(values[key]); if (!Number.isInteger(value) || value < 1 || value > 65535) reject(key, 'Enter a port from 1–65535.'); return value; };
    const listenerPort = port('listener_port'), targetPort = port('target_port');
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      dat('aws_instance', 'target', { for_each: x('toset(' + JSON.stringify(instances) + ')'), instance_id: x('each.value') }),
      res('aws_lb', 'configured', { name, internal: scheme === 'internal', load_balancer_type: 'network', ip_address_type: 'ipv4', security_groups: groups, subnets, enable_deletion_protection: true, enable_cross_zone_load_balancing: bool(values, 'cross_zone') }, [blk('lifecycle', {}, [
        blk('precondition', { condition: x('length(toset(concat([for subnet in data.aws_subnet.selected : subnet.vpc_id], [for group in data.aws_security_group.selected : group.vpc_id], [for instance in data.aws_instance.target : instance.vpc_id]))) == 1'), error_message: 'Use subnets, security groups and target instances in one VPC.' }),
        blk('precondition', { condition: x('length(toset([for subnet in data.aws_subnet.selected : subnet.availability_zone_id])) == length(data.aws_subnet.selected) && alltrue([for subnet in data.aws_subnet.selected : !subnet.ipv6_native && subnet.available_ip_address_count >= 8])'), error_message: 'Choose IPv4-capable subnets in distinct AZs with at least eight available addresses.' }),
        blk('precondition', { condition: x('alltrue([for instance in data.aws_instance.target : contains([for subnet in data.aws_subnet.selected : subnet.availability_zone], instance.availability_zone)])'), error_message: 'Enable the Availability Zone of every target instance.' }),
        ...(listener === 'TLS' ? [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(parsed?.[3] ?? '')), error_message: 'Use a certificate in the deployment account.' })] : []),
      ])]),
      res('aws_lb_target_group', 'configured', { target_type: 'instance', port: targetPort, protocol, vpc_id: x('values(data.aws_subnet.selected)[0].vpc_id') }, [blk('health_check', { protocol: 'TCP', port: 'traffic-port' })]),
      res('aws_lb_target_group_attachment', 'configured', { for_each: x('data.aws_instance.target'), target_group_arn: x('aws_lb_target_group.configured.arn'), target_id: x('each.value.id'), port: targetPort }),
      res('aws_lb_listener', 'configured', { load_balancer_arn: x('aws_lb.configured.arn'), port: listenerPort, protocol: listener, ...(listener === 'TLS' ? { certificate_arn: certificate, ssl_policy: 'ELBSecurityPolicy-TLS13-1-2-2021-06' } : {}) }, [blk('default_action', { type: 'forward', target_group_arn: x('aws_lb_target_group.configured.arn') })]),
      output('load_balancer_dns', 'aws_lb.configured.dns_name'), output('load_balancer_zone_id', 'aws_lb.configured.zone_id'),
    ], `# TCP or TLS Network Load Balancer

## Prepare
Confirm NLB support, supported AZs, IPv4 address capacity and quotas. Prepare VPC subnet routing and security rules for client, target and health-check traffic. Internet-facing placement needs the appropriate public routes. TLS termination requires an issued certificate in the deployment account and region. TCP forwards the application connection unchanged, so any application TLS termination remains on the targets. Review cross-zone behavior and charges.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review network exposure, attached security groups, listener/target protocols and ports, targets and certificate. Apply the saved plan. Security groups are attached at creation. The selected TLS target protocol encrypts the backend connection; NLB does not validate backend certificates. This form uses instance targets and TCP health checks.

## Verify
Wait for the NLB to become active and every required AZ to have healthy targets. Test the actual application protocol and hostname; a TCP health check alone does not validate application readiness. For TLS, verify the presented certificate, permitted protocol versions and end-to-end application behavior. Exercise target failure and cross-zone routing. Add the DNS alias only after validation.

## Recovery
Keep the preceding endpoint and DNS record available during cutover. Restore previous routing if validation fails and investigate security rules, target health and certificate configuration. Preserve backend data. Deletion protection requires an explicit reviewed change before NLB removal. UDP, IP targets, static EIPs, custom health checks and other advanced settings use their corresponding existing builders.

https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html
`, findings);
  },
} satisfies Blueprint;
