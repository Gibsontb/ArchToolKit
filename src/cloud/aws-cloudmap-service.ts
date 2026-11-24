import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.ts';

export const AWS_CLOUDMAP_SERVICE = {
  id: 'aws_service_cloudmap', label: 'Set up private DNS service discovery',
  description: 'Create a VPC-scoped namespace, A/SRV service and repeatable IPv4 endpoint registrations with custom health status.',
  emits: ['aws_service_discovery_private_dns_namespace', 'aws_service_discovery_service', 'aws_service_discovery_instance'],
  inputs: [
    awsServiceRegion,
    { id: 'namespace', label: 'Private DNS namespace', control: 'text', hint: 'A new internal namespace you control, for example internal.example.com. Review overlaps with existing private zones.' },
    { id: 'name', label: 'Service DNS name', control: 'text', hint: 'One DNS label; SRV can also use _service._tcp or _service._udp.' },
    { id: 'vpc', label: 'Existing VPC ID', control: 'text' },
    { id: 'record', label: 'DNS record type', control: 'select', default: 'A', options: [{ value: 'A', label: 'A — IPv4 addresses' }, { value: 'SRV', label: 'SRV — address and port discovery' }] },
    { id: 'routing', label: 'DNS routing policy', control: 'select', default: 'MULTIVALUE', options: [{ value: 'MULTIVALUE', label: 'Multivalue — up to eight records' }, { value: 'WEIGHTED', label: 'Weighted — one selected record' }] },
    { id: 'ttl', label: 'DNS TTL (seconds)', control: 'select', default: '30', options: [10, 30, 60, 300].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'health', label: 'Initial custom health status', control: 'select', default: 'UNHEALTHY', options: [{ value: 'UNHEALTHY', label: 'Unhealthy — validate and update status after registration' }, { value: 'HEALTHY', label: 'Healthy — endpoints already validated' }], hint: 'Custom health requires your own updater. DNS can fail open when all endpoints are unhealthy; this is not a traffic-security gate.' },
    { id: 'instances', label: 'Registered endpoints', control: 'textarea', default: 'endpoint-1 |  | ', hint: 'Instance ID | IPv4 | Port', help: 'One endpoint per row, up to 100. Port is required only for SRV records.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.cloudmap.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), namespace = String(values.namespace ?? '').trim().toLowerCase(), name = String(values.name ?? '').trim().toLowerCase(), vpc = String(values.vpc ?? '').trim();
    const record = String(values.record ?? ''), routing = String(values.routing ?? ''), ttl = Number(values.ttl), health = String(values.health ?? '');
    const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (namespace.length > 253 || namespace.split('.').length < 2 || !namespace.split('.').every(value => label.test(value))) reject('namespace', 'Enter a valid private DNS namespace with at least two labels, within 253 characters.');
    if (!label.test(name) && !(record === 'SRV' && /^_[a-z0-9][a-z0-9-]{0,60}\._(?:tcp|udp)$/.test(name))) reject('name', 'Use a DNS label, or an SRV name such as _orders._tcp.');
    if (name.length + namespace.length + 1 > 253) reject('name', 'Keep the complete service DNS name within 253 characters.');
    if (!/^vpc-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(vpc)) reject('vpc', 'Enter the existing regional VPC ID.');
    if (!['A', 'SRV'].includes(record)) reject('record', 'Choose A or SRV records.');
    if (!['MULTIVALUE', 'WEIGHTED'].includes(routing)) reject('routing', 'Select a routing policy.');
    if (![10, 30, 60, 300].includes(ttl)) reject('ttl', 'Choose DNS TTL.');
    if (!['HEALTHY', 'UNHEALTHY'].includes(health)) reject('health', 'Choose initial custom health status.');
    const rows = String(values.instances ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!rows.length || rows.length > 100) reject('instances', 'Enter 1–100 endpoint rows.');
    const instances: Record<string, Record<string, string>> = {};
    for (const [index, row] of rows.entries()) {
      const cells = row.split('|').map(value => value.trim()), [id = '', ip = '', port = ''] = cells;
      if (cells.length !== 3 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) || Object.hasOwn(instances, id)) { reject('instances', 'Row ' + (index + 1) + ' needs three columns and a unique instance ID within 64 characters.'); continue; }
      const parts = ip.split('.');
      if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) || Number(parts[0]) === 0 || Number(parts[0]) === 127 || Number(parts[0]) >= 224 || ip.startsWith('169.254.')) reject('instances', 'Row ' + (index + 1) + ' needs a usable unicast IPv4 endpoint.');
      if (record === 'SRV' && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) reject('instances', 'Row ' + (index + 1) + ' needs an SRV port from 1–65535.');
      instances[id] = { AWS_INSTANCE_IPV4: ip, AWS_INIT_HEALTH_STATUS: health, ...(record === 'SRV' ? { AWS_INSTANCE_PORT: String(Number(port)) } : {}) };
    }
    return awsServiceModule(region, [
      dat('aws_vpc', 'selected', { id: vpc }),
      res('aws_service_discovery_private_dns_namespace', 'configured', { name: namespace, vpc }, [blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_vpc.selected.enable_dns_support && data.aws_vpc.selected.enable_dns_hostnames'), error_message: 'Private discovery requires VPC DNS support and DNS hostnames enabled.' })])]),
      res('aws_service_discovery_service', 'configured', { name, force_destroy: false }, [blk('dns_config', { namespace_id: x('aws_service_discovery_private_dns_namespace.configured.id'), routing_policy: routing }, [blk('dns_records', { ttl, type: record })]), blk('health_check_custom_config', { failure_threshold: 1 }), blk('lifecycle', { prevent_destroy: true })]),
      res('aws_service_discovery_instance', 'registered', { for_each: x(hcl(instances)), instance_id: x('each.key'), service_id: x('aws_service_discovery_service.configured.id'), attributes: x('each.value') }),
      output('service_id', 'aws_service_discovery_service.configured.id'), output('namespace_id', 'aws_service_discovery_private_dns_namespace.configured.id'), output('service_dns_name', JSON.stringify(name + '.' + namespace)),
    ], `# Private DNS service discovery with registered endpoints

## Prepare
Confirm the namespace is approved and does not conflict with existing private hosted zones or resolver rules. Prepare the existing VPC with DNS support/hostnames and working endpoint routes/security groups. Endpoint rows register existing IPv4 services; no server, listener, load balancer, firewall rule or application is created. SRV clients must support service-and-port discovery. Avoid .local where multicast DNS conflicts apply. Review Cloud Map/Route 53 quotas, DNS costs and custom health ownership.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review DNS scope, endpoint direction, ports and initial health. Apply the reviewed saved plan. Read terraform output -raw service_id. Validate each application endpoint, then set its custom status with aws servicediscovery update-instance-custom-health-status --service-id <service-id> --instance-id <row-id> --status HEALTHY --region ${region}. Configure your application/orchestrator to publish subsequent health changes; Cloud Map custom health does not probe the application. This workflow manages static registrations; an external registration owner must not also manage these instance IDs.

## Verify
From a client using the associated VPC resolver, query ${name}.${namespace} with the selected ${record} record type. Check TTL, addresses and SRV ports. Use aws servicediscovery discover-instances --namespace-name ${namespace} --service-name ${name} --health-status HEALTHY --region ${region}, and aws servicediscovery get-instances-health-status --service-id <service-id> --region ${region}. Test endpoint reachability and custom-health updates. DNS routing can return unhealthy records when no healthy records remain (fail-open); initial UNHEALTHY status is not a guarantee that traffic cannot reach an endpoint. Clients must handle application readiness, DNS caching and retries. A records do not advertise ports.

## Recovery
Publish UNHEALTHY for a failed endpoint, account for DNS caches/fail-open behavior, and use application/load-balancer controls where isolation is required. Restore the preceding validated registration through a reviewed plan. Deregistration removes discovery records but does not stop the underlying service. Namespace and service destruction are protected; review external registrations, client dependencies and TTLs before removing protection. Cross-VPC/on-premises resolution, public/HTTP namespaces, IPv6, CNAME and automatic ECS registration require additional configuration.

https://docs.aws.amazon.com/cloud-map/latest/dg/registering-instances.html
`, findings);
  },
} satisfies Blueprint;
