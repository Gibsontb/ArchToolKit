import { bool } from '../kit/blueprint.ts';
import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { quote } from '../terraform/hcl.ts';
import { awsIamPolicy } from '../editor/profiles/aws.ts';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

const interfaceServices = ['ssm', 'ssmmessages', 'ec2', 'ecr.api', 'ecr.dkr', 'logs', 'kms', 'secretsmanager', 'sts', 'lambda', 'execute-api'];
export const AWS_ENDPOINT_SERVICE = {
  id: 'aws_service_endpoint', label: 'Set up a private AWS service endpoint',
  description: 'Create an interface endpoint or S3/DynamoDB gateway endpoint with existing VPC networking and an optional endpoint policy.',
  emits: ['aws_vpc_endpoint'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Endpoint name tag', control: 'text' },
    { id: 'type', label: 'Endpoint type', control: 'select', default: 'Interface', options: [{ value: 'Interface', label: 'Interface — private service network interfaces' }, { value: 'Gateway', label: 'Gateway — S3 or DynamoDB routes' }] },
    { id: 'interface_service', label: 'Interface service', control: 'select', default: 'ssm', options: interfaceServices.map(value => ({ value, label: value })), showWhen: { input: 'type', equals: ['Interface'] } },
    { id: 'gateway_service', label: 'Gateway service', control: 'select', default: 's3', options: [{ value: 's3', label: 'S3' }, { value: 'dynamodb', label: 'DynamoDB' }], showWhen: { input: 'type', equals: ['Gateway'] } },
    { id: 'service_name', label: 'Qualified endpoint service name', control: 'text', hint: 'Optional exact service name from DescribeVpcEndpointServices. Required for partitions with a nonstandard service-name prefix.' },
    { id: 'vpc', label: 'Existing VPC ID', control: 'text' },
    { id: 'subnets', label: 'Existing endpoint subnet IDs', control: 'text', hint: 'Comma-separated IPv4-capable subnet IDs, one per Availability Zone in the selected VPC.', showWhen: { input: 'type', equals: ['Interface'] } },
    { id: 'groups', label: 'Existing endpoint security group IDs', control: 'text', hint: 'Comma-separated security group IDs in the selected VPC. Allow the service port from approved clients.', showWhen: { input: 'type', equals: ['Interface'] } },
    { id: 'private_dns', label: 'Enable private service DNS', control: 'toggle', default: true, showWhen: { input: 'type', equals: ['Interface'] } },
    { id: 'routes', label: 'Existing route table IDs', control: 'text', hint: 'Comma-separated route tables in the selected VPC to associate with the gateway endpoint.', showWhen: { input: 'type', equals: ['Gateway'] } },
    { id: 'policy', label: 'Endpoint policy (JSON)', control: 'textarea', hint: 'Optional. Blank uses the service default endpoint policy. IAM and resource policies still control access.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.endpoint.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), name = String(values.name ?? '').trim(), type = String(values.type ?? ''), vpc = String(values.vpc ?? ''), serviceName = String(values.service_name ?? '').trim();
    const isInterface = type === 'Interface', service = String(isInterface ? values.interface_service ?? '' : values.gateway_service ?? '');
    const list = (key: string) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), groups = list('groups'), routes = list('routes');
    if (!name || name.length > 128 || /[\r\n]/.test(name)) reject('name', 'Enter a name tag of 1–128 characters.');
    if (!['Interface', 'Gateway'].includes(type)) reject('type', 'Select an endpoint type.');
    if (!(isInterface ? interfaceServices : ['s3', 'dynamodb']).includes(service)) reject(isInterface ? 'interface_service' : 'gateway_service', 'Select a supported service.');
    if (!/^vpc-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(vpc)) reject('vpc', 'Enter an existing VPC ID.');
    if (serviceName && (!/^[a-z0-9.-]+$/.test(serviceName) || !serviceName.includes(location) || !serviceName.endsWith('.' + service))) reject('service_name', 'Use the qualified name for the selected service and region.');
    if (!serviceName && !['aws', 'aws-us-gov'].includes(awsServicePartition(location))) reject('service_name', 'Supply the regionally qualified endpoint service name for this partition.');
    if (isInterface) {
      if (!subnets.length || subnets.length > 16 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Enter 1–16 valid subnet IDs.');
      if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Enter 1–5 security group IDs.');
    } else if (!routes.length || routes.length > 50 || routes.some(value => !/^rtb-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('routes', 'Enter 1–50 route table IDs.');
    const policy = String(values.policy ?? '').trim();
    if (policy) {
      try {
        const document = JSON.parse(policy);
        if (!document || Array.isArray(document) || typeof document !== 'object' || !document.Statement) throw new Error();
        findings.push(...(awsIamPolicy.validate?.(document) ?? []).map(finding => ({ ...finding, path: 'policy' + (finding.path ? '.' + finding.path : '') })));
        if (new TextEncoder().encode(policy).length > 20480) reject('policy', 'Keep the endpoint policy within 20,480 bytes.');
      } catch { reject('policy', 'Enter a JSON policy object with Statement.'); }
    }
    return awsServiceModule(location, [
      dat('aws_vpc', 'selected', { id: vpc }),
      dat('aws_vpc_endpoint_service', 'selected', { ...(serviceName ? { service_name: serviceName } : { service }), service_type: type }),
      ...(isInterface ? [
        dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
        dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      ] : [dat('aws_route_table', 'selected', { for_each: x('toset(' + JSON.stringify(routes) + ')'), route_table_id: x('each.value') })]),
      res('aws_vpc_endpoint', 'configured', {
        vpc_id: x('data.aws_vpc.selected.id'), service_name: x('data.aws_vpc_endpoint_service.selected.service_name'), vpc_endpoint_type: type,
        ...(isInterface ? { subnet_ids: subnets, security_group_ids: groups, private_dns_enabled: bool(values, 'private_dns'), ip_address_type: 'ipv4' } : { route_table_ids: routes }),
        ...(policy ? { policy } : {}), tags: x('{ Name = ' + quote(name) + ' }'),
      }, [blk('lifecycle', {}, [
        ...(isInterface ? [
          blk('precondition', { condition: x('alltrue(concat([for subnet in data.aws_subnet.selected : subnet.vpc_id == data.aws_vpc.selected.id && !subnet.ipv6_native && contains(data.aws_vpc_endpoint_service.selected.availability_zones, subnet.availability_zone)], [for group in data.aws_security_group.selected : group.vpc_id == data.aws_vpc.selected.id])) && length(toset([for subnet in data.aws_subnet.selected : subnet.availability_zone_id])) == length(data.aws_subnet.selected)'), error_message: 'Use IPv4-capable subnets in supported, distinct AZs and security groups within the selected VPC.' }),
          ...(bool(values, 'private_dns') ? [blk('precondition', { condition: x('data.aws_vpc.selected.enable_dns_support && data.aws_vpc.selected.enable_dns_hostnames && data.aws_vpc_endpoint_service.selected.private_dns_name != ""'), error_message: 'Private DNS requires VPC DNS support, DNS hostnames and a private DNS name on the selected service.' })] : []),
        ] : [blk('precondition', { condition: x('alltrue([for table in data.aws_route_table.selected : table.vpc_id == data.aws_vpc.selected.id])'), error_message: 'Every route table must belong to the selected VPC.' })]),
        ...(policy ? [blk('precondition', { condition: x('data.aws_vpc_endpoint_service.selected.vpc_endpoint_policy_supported'), error_message: 'This service does not support a custom endpoint policy.' })] : []),
      ])]),
      output('endpoint_id', 'aws_vpc_endpoint.configured.id'),
    ], `# Private AWS service endpoint

## Prepare
Verify the selected endpoint service, type and Availability Zones in this region with DescribeVpcEndpointServices. Supply the qualified name where the partition uses a nonstandard prefix. Interface endpoints require subnet addresses, client routing, service-port security rules and appropriate DNS resolution. Gateway endpoints require selected VPC route tables. Review endpoint policy alongside identity/resource policies; the default endpoint policy does not restrict otherwise authorized access.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review subnet/AZ placement, DNS behavior, route-table changes, policies and per-AZ interface-endpoint charges. Apply the saved plan. This creates an endpoint for one selected AWS service. ECR image pulls and Systems Manager sessions require their full set of related endpoints and permissions, not just one endpoint.

## Verify
Wait for endpoint state AVAILABLE. From the intended client network, resolve the service name and invoke an authorized test API. Confirm the intended private path, security rules and denied-access cases. For gateway endpoints, inspect the selected route tables and test service access from their associated subnets. For execute-api private DNS, review its effect on access to public API Gateway endpoints in the VPC.

## Recovery
Keep the prior approved service path until verification passes. Revert endpoint DNS or route-table associations through reviewed configuration if connectivity breaks. Removing an endpoint can interrupt all clients relying on it. This form covers selected AWS interface services and S3/DynamoDB gateway endpoints; endpoint services, third-party/private service publishing, resource endpoints and service-network endpoints use their corresponding existing builders.

https://docs.aws.amazon.com/vpc/latest/privatelink/create-interface-endpoint.html
`, findings);
  },
} satisfies Blueprint;
