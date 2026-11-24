import { error,              } from '../core/findings.js';
import { isIpv4Address, parseCidrAny } from '../core/ip.js';
                                                     
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.js';

export const AWS_RESOLVER_SERVICE = {
  id: 'aws_service_resolver', label: 'Set up hybrid DNS Resolver endpoints',
  description: 'IPv4 Do53 inbound or outbound endpoints across existing subnets, scoped DNS security rules and optional domain forwarding into the endpoint VPC.',
  emits: ['aws_route53_resolver_endpoint', 'aws_route53_resolver_rule', 'aws_route53_resolver_rule_association', 'aws_security_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Resolver endpoint name', control: 'text' },
    { id: 'direction', label: 'DNS query direction', control: 'select', default: 'INBOUND', options: [{ value: 'INBOUND', label: 'Inbound — on-premises resolvers query AWS private DNS' }, { value: 'OUTBOUND', label: 'Outbound — VPC workloads query corporate DNS domains' }] },
    { id: 'subnets', label: 'Existing endpoint subnet IDs', control: 'text', hint: '2–6 subnet IDs in one VPC across at least two AZs; one automatically allocated private IPv4 address in each.' },
    { id: 'clients', label: 'Approved inbound DNS client IPv4 CIDRs', control: 'text', showWhen: { input: 'direction', equals: ['INBOUND'] }, hint: 'Comma-separated networks of the actual corporate DNS resolvers, not all end users. No 0.0.0.0/0.' },
    { id: 'domains', label: 'Corporate domains to forward', control: 'text', showWhen: { input: 'direction', equals: ['OUTBOUND'] }, hint: 'Comma-separated DNS suffixes, e.g. corp.example.org, services.internal. Each creates a rule associated only with this endpoint VPC.' },
    { id: 'targets', label: 'Corporate DNS resolver IPv4 addresses', control: 'text', showWhen: { input: 'direction', equals: ['OUTBOUND'] }, hint: '1–6 reachable resolver addresses; every domain uses these targets on UDP/TCP 53. Use redundant resolvers where available.' },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.resolver.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), name = String(values.name ?? '').trim(), direction = String(values.direction ?? '');
    const list = (id        ) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = direction === 'INBOUND' ? list('clients') : [], targets = direction === 'OUTBOUND' ? list('targets') : [], domains = direction === 'OUTBOUND' ? [...new Set(list('domains').map(domain => domain.toLowerCase().replace(/\.$/, '')))] : [];
    if (!/^[A-Za-z](?:[A-Za-z0-9_-]{0,58}[A-Za-z0-9])?$/.test(name)) reject('name', 'Use 1–60 letters, digits, underscores or hyphens, beginning with a letter and ending with a letter/digit.');
    if (!['INBOUND', 'OUTBOUND'].includes(direction)) reject('direction', 'Select inbound or outbound DNS.');
    if (subnets.length < 2 || subnets.length > 6 || subnets.some(subnet => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(subnet))) reject('subnets', 'Use 2–6 subnet IDs in one VPC across two or more AZs.');
    if (direction === 'INBOUND' && (!clients.length || clients.length > 20 || clients.some(value => { const cidr = parseCidrAny(value); return !value.includes('/') || !cidr || cidr.family !== 4 || cidr.address !== cidr.network || cidr.prefix === 0; }))) reject('clients', 'Use 1–20 canonical IPv4 client network CIDRs without an unrestricted /0.');
    if (direction === 'OUTBOUND') {
      if (!targets.length || targets.length > 6 || targets.some(value => !isIpv4Address(value) || [0, 127].includes(Number(value.split('.')[0])) || Number(value.split('.')[0]) >= 224)) reject('targets', 'Use 1–6 reachable unicast IPv4 corporate DNS addresses.');
      if (!domains.length || domains.length > 20 || domains.some(domain => domain.length > 253 || !domain.includes('.') || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) reject('domains', 'Use 1–20 domain suffixes without wildcards, empty labels or the DNS root.');
    }
    return awsServiceModule(region, [
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_vpc', 'selected', { id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id') }),
      res('aws_security_group', 'dns', { name: name + '-dns', description: 'Scoped hybrid DNS endpoint traffic', vpc_id: x('data.aws_vpc.selected.id'), tags: x(hcl({ Name: name + '-dns' })) }, ['udp', 'tcp'].map(protocol => blk(direction === 'INBOUND' ? 'ingress' : 'egress', { description: 'Approved DNS ' + protocol, protocol, from_port: 53, to_port: 53, cidr_blocks: direction === 'INBOUND' ? clients : targets.map(ip => ip + '/32') }))),
      res('aws_route53_resolver_endpoint', 'configured', { name, direction, resolver_endpoint_type: 'IPV4', protocols: ['Do53'], security_group_ids: x('[aws_security_group.dns.id]'), tags: x(hcl({ Name: name })) }, [
        ...subnets.map(subnet => blk('ip_address', { subnet_id: subnet })),
        blk('lifecycle', {}, [blk('precondition', { condition: x('length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) >= 2 && data.aws_vpc.selected.enable_dns_support && data.aws_vpc.selected.enable_dns_hostnames'), error_message: 'Endpoint subnets must span at least two AZs in one VPC with DNS support and hostnames enabled.' })]),
      ]),
      ...domains.flatMap((domain, index) => [
        res('aws_route53_resolver_rule', 'domain_' + index, { name: name + '-domain-' + index, domain_name: domain, rule_type: 'FORWARD', resolver_endpoint_id: x('aws_route53_resolver_endpoint.configured.id'), tags: x(hcl({ Name: name + '-' + domain })) }, targets.map(ip => blk('target_ip', { ip, port: 53, protocol: 'Do53' }))),
        res('aws_route53_resolver_rule_association', 'domain_' + index, { name: name + '-domain-' + index, resolver_rule_id: x('aws_route53_resolver_rule.domain_' + index + '.id'), vpc_id: x('data.aws_vpc.selected.id') }),
      ]),
      output('resolver_endpoint_id', 'aws_route53_resolver_endpoint.configured.id'), output('endpoint_addresses', '[for address in aws_route53_resolver_endpoint.configured.ip_address : { subnet_id = address.subnet_id, ip = address.ip }]'), output('security_group_id', 'aws_security_group.dns.id'),
    ], `# Hybrid DNS Resolver — ${direction}

## Prepare
Confirm the private network path between endpoint subnets and corporate resolvers, including routes, NACLs, TCP/UDP 53 and return traffic. Existing VPC DNS support and hostnames must be enabled. This recipe creates one IPv4 address per selected subnet and requires at least two AZs. Check free subnet addresses and endpoint/query charges. It uses standard Do53, not encrypted DoH, IPv6, inbound delegation or Global Resolver. DNS traffic still needs an approved network/data-handling boundary; no authorization is implied by endpoint creation.

${direction === 'INBOUND' ? `Prepare the intended private hosted zones and their association with this VPC. Use the corporate resolvers' actual source networks in the allowlist, accounting for any source NAT. The new endpoint permits TCP and UDP 53 from only those CIDRs. After provisioning, configure conditional forwarders on the corporate resolvers for the specific AWS private domain suffixes, using all endpoint address outputs. This package does not change corporate DNS or create hosted zones.\n` : `Every selected domain forwards to all configured corporate resolver targets; no target priority is guaranteed. The new security group permits only TCP/UDP 53 to those target IPv4 addresses. Forward rules are associated only with this endpoint VPC; other VPCs require their own reviewed associations/sharing. Review current rules, private hosted zones and domain precedence before applying. Do not configure corporate servers to forward the same suffix back to this endpoint/VPC, which creates a DNS loop. Root-domain forwarding is intentionally outside this scoped recipe.\n`}

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review direction, both AZs, security group, addresses and ${direction === 'INBOUND' ? 'corporate source networks' : 'every domain, target and VPC association'}; apply the saved reviewed plan. Wait for the endpoint to be OPERATIONAL. Check aws route53resolver list-resolver-endpoint-ip-addresses --resolver-endpoint-id <output-id> --region ${region}. Record allocated addresses before configuring external systems. Address replacement requires coordinated forwarder/firewall changes.

## Verify
${direction === 'INBOUND' ? 'From each approved corporate resolver, query a known associated private-zone name against each endpoint IP using UDP and TCP; validate exact expected records, negative responses and access restrictions. Then query through the ordinary corporate DNS path to confirm the conditional forwarders.' : 'From a workload using the VPC-provided resolver, query known names under every forwarded suffix. Verify expected answers and both TCP/UDP reachability to corporate targets. Test target failure and check that unrelated DNS domains retain their intended resolution path.'} Inspect endpoint status, CloudWatch metrics, VPC Flow Logs and configured Resolver query logging. Query logging itself is not enabled by this package; establish its approved destination, access and retention separately. Test both AZ paths and the application protocols that depend on these records.

## Recovery
Record existing conditional forwarders/rule associations before change. Restore the prior DNS path, allow for TTL/cache behavior and validate application resolution before removing the endpoint or its rules. Removing an outbound association changes the domain's resolution behavior immediately; an absent forward rule does not guarantee the prior answer remains available. Endpoint recreation can change addresses. Preserve investigation logs under applicable retention requirements. Generation/local validation does not issue DNS queries, change corporate resolvers or deploy AWS resources.

https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-forwarding-inbound-queries.html
https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-forwarding-outbound-queries.html
`, findings);
  },
}                    ;
