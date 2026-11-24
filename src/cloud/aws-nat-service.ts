import { error, type Finding } from '../core/findings.ts';
import { isIpv4Address, parseCidrAny } from '../core/ip.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.ts';

export const AWS_NAT_SERVICE = {
  id: 'aws_service_nat', label: 'Set up a zonal NAT gateway',
  description: 'Public or private zonal NAT in an existing subnet, optional dedicated EIP and explicit IPv4 client routes. Existing gateway-subnet upstream connectivity is required.',
  emits: ['aws_nat_gateway', 'aws_eip', 'aws_route'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'NAT gateway name', control: 'text' },
    { id: 'connectivity', label: 'Connectivity', control: 'select', default: 'public', options: [{ value: 'public', label: 'Public — internet egress through an existing IGW' }, { value: 'private', label: 'Private — translated private connectivity through TGW/VGW' }] },
    { id: 'subnet', label: 'Existing NAT gateway subnet ID', control: 'text', hint: 'Public NAT needs a public subnet with an existing internet-gateway route; private NAT needs approved upstream private routing.' },
    { id: 'eip_mode', label: 'Public IPv4 address', control: 'select', default: 'NEW', showWhen: { input: 'connectivity', equals: ['public'] }, options: [{ value: 'NEW', label: 'Allocate a new dedicated Elastic IP' }, { value: 'EXISTING', label: 'Use an existing unassociated Elastic IP allocation' }] },
    { id: 'allocation', label: 'Existing EIP allocation ID', control: 'text', showWhen: { input: 'eip_mode', equals: ['EXISTING'] }, hint: 'Ignored for private NAT. Must match the subnet network border group and have no current association.' },
    { id: 'private_ip', label: 'NAT private IPv4 address', control: 'text', hint: 'Optional unused valid host address in the chosen subnet; blank lets AWS allocate it.' },
    { id: 'routes', label: 'Client IPv4 routes', control: 'select', default: 'NONE', options: [{ value: 'NONE', label: 'Gateway only — manage client routes separately' }, { value: 'CREATE', label: 'Add a route to selected client route tables' }] },
    { id: 'route_tables', label: 'Existing client route table IDs', control: 'text', showWhen: { input: 'routes', equals: ['CREATE'] }, hint: 'Comma-separated route tables in the NAT VPC. Do not select the NAT subnet route table.' },
    { id: 'destination', label: 'Client route destination IPv4 CIDR', control: 'text', default: '0.0.0.0/0', showWhen: { input: 'routes', equals: ['CREATE'] }, hint: 'Public internet egress normally uses 0.0.0.0/0. Private NAT must use the approved private destination range.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.nat.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), name = String(values.name ?? '').trim(), connectivity = String(values.connectivity ?? ''), subnet = String(values.subnet ?? '').trim(), privateIp = String(values.private_ip ?? '').trim(), routeMode = String(values.routes ?? 'NONE');
    const eipMode = connectivity === 'public' ? String(values.eip_mode ?? '') : '', allocation = eipMode === 'EXISTING' ? String(values.allocation ?? '').trim() : '';
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name)) reject('name', 'Use a letter followed by up to 99 letters, digits, underscores or hyphens.');
    if (!['public', 'private'].includes(connectivity)) reject('connectivity', 'Select public or private connectivity.');
    if (!/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(subnet)) reject('subnet', 'Enter the existing gateway subnet ID.');
    if (connectivity === 'public' && !['NEW', 'EXISTING'].includes(eipMode)) reject('eip_mode', 'Choose a new or existing EIP.');
    if (eipMode === 'EXISTING' && !/^eipalloc-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(allocation)) reject('allocation', 'Enter an existing unused Elastic IP allocation ID.');
    if (privateIp && !isIpv4Address(privateIp)) reject('private_ip', 'Enter an unused IPv4 host address in the gateway subnet, or leave blank.');
    if (!['NONE', 'CREATE'].includes(routeMode)) reject('routes', 'Choose whether to add client routes.');
    const tables = routeMode === 'CREATE' ? [...new Set(String(values.route_tables ?? '').split(',').map(value => value.trim()).filter(Boolean))] : [];
    const destination = routeMode === 'CREATE' ? String(values.destination ?? '').trim() : '', cidr = parseCidrAny(destination);
    if (routeMode === 'CREATE') {
      if (!tables.length || tables.length > 50 || tables.some(value => !/^rtb-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('route_tables', 'Use 1–50 existing client route table IDs.');
      if (!destination.includes('/') || !cidr || cidr.family !== 4 || cidr.address !== cidr.network) reject('destination', 'Use a canonical IPv4 network CIDR.');
      if (connectivity === 'private' && cidr?.prefix === 0) reject('destination', 'Use the approved specific private destination range; private NAT cannot provide internet egress.');
    }
    return awsServiceModule(region, [
      dat('aws_subnet', 'gateway', { id: subnet }),
      ...(eipMode === 'NEW' ? [res('aws_eip', 'gateway', { domain: 'vpc', tags: x(hcl({ Name: name })) })] : []),
      res('aws_nat_gateway', 'configured', { subnet_id: subnet, connectivity_type: connectivity, ...(connectivity === 'public' ? { allocation_id: eipMode === 'NEW' ? x('aws_eip.gateway.id') : allocation } : {}), ...(privateIp ? { private_ip: privateIp } : {}), tags: x(hcl({ Name: name })) }),
      ...(routeMode === 'CREATE' ? [
        dat('aws_route_table', 'clients', { for_each: x('toset(' + JSON.stringify(tables) + ')'), route_table_id: x('each.value') }),
        dat('aws_route_tables', 'gateway_explicit', { vpc_id: x('data.aws_subnet.gateway.vpc_id') }, [blk('filter', { name: 'association.subnet-id', values: [subnet] })]),
        dat('aws_route_table', 'gateway_main', { vpc_id: x('data.aws_subnet.gateway.vpc_id') }, [blk('filter', { name: 'association.main', values: ['true'] })]),
        res('aws_route', 'clients', { for_each: x('toset(' + JSON.stringify(tables) + ')'), route_table_id: x('each.value'), destination_cidr_block: destination, nat_gateway_id: x('aws_nat_gateway.configured.id') }, [blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_route_table.clients[each.value].vpc_id == data.aws_subnet.gateway.vpc_id && each.value != (length(data.aws_route_tables.gateway_explicit.ids) > 0 ? one(data.aws_route_tables.gateway_explicit.ids) : data.aws_route_table.gateway_main.id)'), error_message: 'Client route tables must be in the gateway VPC and must not be the NAT subnet effective route table (explicit or inherited main).' }), blk('precondition', { condition: x('alltrue([for route in data.aws_route_table.clients[each.value].routes : route.cidr_block != ' + JSON.stringify(destination) + ' || route.nat_gateway_id == aws_nat_gateway.configured.id])'), error_message: 'An existing destination route has another target. Review/import or remove it through an approved routing change before applying this package.' })])]),
      ] : []),
      output('nat_gateway_id', 'aws_nat_gateway.configured.id'), output('private_ip', 'aws_nat_gateway.configured.private_ip'), ...(connectivity === 'public' ? [output('public_ip', 'aws_nat_gateway.configured.public_ip')] : []), output('availability_zone', 'data.aws_subnet.gateway.availability_zone'),
    ], `# Zonal NAT gateway

## Prepare
This recipe uses a zonal gateway in an existing IPv4 subnet. It does not create or change the gateway subnet's upstream routes. Public mode needs a public subnet with an attached VPC internet gateway and its correct default route. Private mode needs an approved routed private path (for example TGW/VGW) and return routing to the translated address; a private NAT cannot provide internet access through an IGW. Review hourly, data-processing, IPv4 and cross-AZ charges. Regional automatic multi-AZ NAT, NAT64/DNS64 and extra addresses are separate configurations.

For public mode, check EIP quota and matching network border group. An existing allocation must be unassociated and owned/usable by the deployment identity. For an explicit private address, verify subnet membership, AWS-reserved address exclusions and availability. Check workload security-group egress, NACL return/ephemeral ports, DNS and approved destinations. NAT is not a firewall or a data-transfer authorization.

## Implement
Record current route-table associations and every existing destination/target before making changes. Select only client route tables in the same VPC, never the NAT subnet table. Existing routes owned by another stack/inline route block must be reconciled by that owner before import or change; do not manage the same route twice. The generated guard rejects an existing destination with another target instead of intentionally replacing it. Review more-specific routes that may bypass the selected destination. The gateway can be created before a later route precondition fails; account for that resource and its cost in recovery.

Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review allocation, subnet/AZ, gateway type and exact route changes; apply the saved reviewed plan during the network change window. Use one appropriate zonal gateway per client AZ for an AZ-resilient design, with separate reviewed packages/state keys. Cross-AZ routing can create additional cost and a failure dependency.

## Verify
Use aws ec2 describe-nat-gateways --nat-gateway-ids <output-id> --region ${region}, verify AVAILABLE and inspect client/gateway route tables. From an approved private workload, test only the intended destination and verify observed source translation and return traffic. Confirm unsolicited inbound connections fail. Monitor CloudWatch NAT metrics including ErrorPortAllocation and PacketsDropCount, plus VPC Flow Logs. Test AZ failure/recovery through the approved network procedure; this single gateway does not implement automatic failover.

## Recovery
Restore recorded client route targets through the owning configuration and verify connectivity before removing the gateway. Destroying routes/gateway interrupts active connections. A new EIP created here is released on destroy; an existing allocation is not managed as an EIP resource by this package. Preserve an allowlisted public IP when required and coordinate downstream allowlists before replacing it. Local generation/validation does not create resources or alter network routes.

https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html
`, findings);
  },
} satisfies Blueprint;
