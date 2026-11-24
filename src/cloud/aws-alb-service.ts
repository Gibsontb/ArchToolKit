import { bool } from '../kit/blueprint.ts';
import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_ALB_SERVICE = {
  id: 'aws_service_alb', label: 'Set up an HTTPS Application Load Balancer',
  description: 'Forward HTTPS requests to existing EC2 instances through a Regional IPv4 Application Load Balancer.',
  emits: ['aws_lb', 'aws_lb_listener', 'aws_lb_target_group', 'aws_lb_target_group_attachment'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Load balancer name', control: 'text' },
    { id: 'scheme', label: 'Access', control: 'select', default: 'internal', options: [
      { value: 'internal', label: 'Internal' }, { value: 'internet', label: 'Internet-facing' },
    ] },
    { id: 'subnets', label: 'Existing subnet IDs', control: 'text', hint: 'Comma-separated IDs of two or more IPv4 subnets in distinct standard Availability Zones, within one VPC.' },
    { id: 'groups', label: 'Existing load-balancer security group IDs', control: 'text', hint: 'Comma-separated IDs of existing security groups in the load balancer VPC.' },
    { id: 'certificate', label: 'Existing ACM certificate ARN', control: 'text', hint: 'An issued certificate in this account and region for the application hostname.' },
    { id: 'instances', label: 'Existing EC2 target IDs', control: 'text', hint: 'Comma-separated EC2 instance IDs in the load balancer VPC.' },
    { id: 'protocol', label: 'Target protocol', control: 'select', default: 'HTTP', options: [
      { value: 'HTTP', label: 'HTTP' }, { value: 'HTTPS', label: 'HTTPS' },
    ] },
    { id: 'port', label: 'Target port', control: 'number', min: 1, max: 65535, default: 80 },
    { id: 'health_path', label: 'Health check path', control: 'text', default: '/health' },
    { id: 'redirect', label: 'Redirect HTTP to HTTPS', control: 'toggle', default: true },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.alb.' + path, message, { path }));
    const location = String(values.aws_region ?? '');
    const name = String(values.name ?? '').trim();
    const list = (id: string) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), groups = list('groups'), instances = list('instances');
    const certificate = String(values.certificate ?? '').trim();
    const protocol = String(values.protocol ?? '');
    const scheme = String(values.scheme ?? '');
    const port = Number(values.port);
    const health = String(values.health_path ?? '');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?$/.test(name) || name.startsWith('internal-')) reject('name', 'Use 1–32 letters, numbers or hyphens, with alphanumeric ends and no internal- prefix.');
    if (!['internal', 'internet'].includes(scheme)) reject('scheme', 'Select internal or internet-facing access.');
    if (subnets.length < 2 || subnets.some(value => !/^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(value))) reject('subnets', 'Select at least two valid subnet IDs.');
    if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(value))) reject('groups', 'Enter 1–5 existing security group IDs.');
    if (!instances.length || instances.some(value => !/^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(value))) reject('instances', 'Enter existing EC2 target IDs.');
    const parsed = /^arn:([^:]+):acm:([^:]+):(\d{12}):certificate\/[a-f0-9-]+$/.exec(certificate);
    if (parsed?.[1] !== awsServicePartition(location) || parsed?.[2] !== location) reject('certificate', 'Use an ACM certificate ARN in the selected partition and region.');
    if (!['HTTP', 'HTTPS'].includes(protocol)) reject('protocol', 'Select a target protocol.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) reject('port', 'Enter a port from 1 to 65535.');
    if (!health.startsWith('/') || health.length > 1024 || /[\r\n]/.test(health)) reject('health_path', 'Enter a health check path beginning with /.');
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      dat('aws_instance', 'target', { for_each: x('toset(' + JSON.stringify(instances) + ')'), instance_id: x('each.value') }),
      res('aws_lb', 'configured', {
        name, internal: scheme === 'internal', load_balancer_type: 'application', ip_address_type: 'ipv4',
        security_groups: groups, subnets, enable_deletion_protection: true,
      }, [blk('lifecycle', {}, [
        blk('precondition', {
          condition: x('length(toset(concat([for subnet in data.aws_subnet.selected : subnet.vpc_id], [for group in data.aws_security_group.selected : group.vpc_id], [for instance in data.aws_instance.target : instance.vpc_id]))) == 1'),
          error_message: 'All subnets, security groups and target instances must be in one VPC.',
        }),
        blk('precondition', {
          condition: x('length(toset([for subnet in data.aws_subnet.selected : subnet.availability_zone_id])) == length(data.aws_subnet.selected)'),
          error_message: 'Choose one subnet per Availability Zone.',
        }),
        blk('precondition', {
          condition: x('alltrue([for instance in data.aws_instance.target : contains([for subnet in data.aws_subnet.selected : subnet.availability_zone], instance.availability_zone)])'),
          error_message: 'Enable each target instance Availability Zone on the load balancer.',
        }),
        blk('precondition', {
          condition: x('alltrue([for subnet in data.aws_subnet.selected : !subnet.ipv6_native && subnet.available_ip_address_count >= 8 && tonumber(split("/", subnet.cidr_block)[1]) <= 27])'),
          error_message: 'Use IPv4 subnets of /27 or larger with at least eight available IPs.',
        }),
        blk('precondition', {
          condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(parsed?.[3] ?? '')),
          error_message: 'The certificate must be in the deployment account.',
        }),
      ])]),
      res('aws_lb_target_group', 'configured', {
        port, protocol, target_type: 'instance', vpc_id: x('values(data.aws_subnet.selected)[0].vpc_id'),
      }, [blk('health_check', { path: health, protocol, port: 'traffic-port', matcher: '200', interval: 30, timeout: 5, healthy_threshold: 2, unhealthy_threshold: 2 })]),
      res('aws_lb_target_group_attachment', 'configured', {
        for_each: x('data.aws_instance.target'), target_group_arn: x('aws_lb_target_group.configured.arn'),
        target_id: x('each.value.id'), port,
      }),
      res('aws_lb_listener', 'https', {
        load_balancer_arn: x('aws_lb.configured.arn'), port: 443, protocol: 'HTTPS',
        ssl_policy: 'ELBSecurityPolicy-TLS13-1-2-2021-06', certificate_arn: certificate,
      }, [blk('default_action', { type: 'forward', target_group_arn: x('aws_lb_target_group.configured.arn') })]),
      ...(bool(values, 'redirect') ? [res('aws_lb_listener', 'http', {
        load_balancer_arn: x('aws_lb.configured.arn'), port: 80, protocol: 'HTTP',
      }, [blk('default_action', { type: 'redirect' }, [blk('redirect', { port: '443', protocol: 'HTTPS', status_code: 'HTTP_301' })])])] : []),
      output('load_balancer_dns', 'aws_lb.configured.dns_name'),
      output('load_balancer_zone_id', 'aws_lb.configured.zone_id'),
    ], `# HTTPS Application Load Balancer

## Prepare
This form supports IPv4 standard Regional Availability Zones and instance targets. Confirm an issued ACM certificate in the selected account and region. Choose distinct /27 or larger subnets with eight available IPs each. For internet-facing access, prepare an attached internet gateway and appropriate subnet routing. Permit client HTTPS to the ALB security group, outbound target-port and health-check traffic, and matching inbound traffic on each target security group. Permit HTTP only if using the redirect listener. Verify application health returns HTTP 200 at the selected path.

## Implement
Run terraform init, terraform validate, and terraform plan -out=service.tfplan. Review account, network placement, internet exposure, targets, certificate and charges. Apply the saved plan. The default HTTPS listener forwards to one target group. Configure access logs, WAF and advanced routing through their corresponding builders when required.

## Verify
Inspect load balancer state and target health reasons. Ensure a healthy target is present in each enabled Availability Zone. Test HTTPS with the correct application hostname and certificate. Test redirects, health failures and target failover. Add a DNS alias after validation using the load_balancer_dns and load_balancer_zone_id outputs.

## Recovery
Keep the previous endpoint and DNS record available through cutover. If validation fails, restore the previous DNS destination and investigate target health, routing and security rules. Preserve the original target data. Deletion protection requires an explicit reviewed change before removing the ALB.

https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-application-load-balancer.html
`, findings);
  },
} satisfies Blueprint;
