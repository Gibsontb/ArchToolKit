/**
 * AWS network foundation.
 *
 * Two provider conventions are followed deliberately.
 *
 * Security group rules are separate `aws_vpc_security_group_ingress_rule` and
 * `..._egress_rule` resources, one CIDR each, not inline `ingress`/`egress`
 * blocks. The provider documentation asks for exactly this: inline rules have no
 * stable identity, cannot be described or tagged individually, and conflict with
 * the rule resources if both are ever present.
 *
 * Routes stay inline on `aws_route_table`, which is correct only as long as no
 * `aws_route` resource is added for the same table. Mixing the two produces a
 * permanent diff, so the file says so rather than leaving it to be discovered.
 *
 * Dual stack (`ipv6`) asks Amazon for the VPC's /56 with
 * `assign_generated_ipv6_cidr_block` and gives subnet n the n-th /64 of it
 * with `cidrsubnet(…, 8, n)`. Public subnets route ::/0 to the internet gateway;
 * private ones get an egress-only internet gateway, the IPv6 counterpart of NAT.
 * A rule resource takes one CIDR of one family, `cidr_ipv4` or `cidr_ipv6`.
 */

import { hasErrors, info, warning, type Finding } from '../core/findings.ts';
import { familyOf } from '../core/ip.ts';
import { renderFile, str, num, bool, raw, type HclBlock, type HclAttribute } from './hcl.ts';
import {
  checkFoundationAddresses,
  identifier,
  resourceName,
  worldIngress,
  type FoundationPlan,
  type FoundationOutput,
} from './foundation.ts';

function tagsAttribute(plan: FoundationPlan, name: string): HclAttribute {
  const entries = { Name: name, ...(plan.tags ?? {}) };
  const body = Object.entries(entries)
    .map(([k, v]) => `    ${JSON.stringify(k)} = ${JSON.stringify(v)}`)
    .join('\n');
  return { name: 'tags', value: raw(`{\n${body}\n  }`) };
}

export function emitAwsFoundation(plan: FoundationPlan): FoundationOutput {
  const findings: Finding[] = checkFoundationAddresses(plan, 'aws', 'An AWS VPC');
  if (hasErrors(findings)) return { files: {}, findings };
  const blocks: HclBlock[] = [];
  const base = resourceName(plan.name);
  const vpcRef = 'aws_vpc.this.id';
  const v6 = plan.ipv6 === true;

  blocks.push({
    type: 'resource',
    labels: ['aws_vpc', 'this'],
    attributes: [
      { name: 'cidr_block', value: str(plan.cidr) },
      // Amazon allocates a /56 from its own pool; subnets take /64s of it.
      ...(v6 ? [{ name: 'assign_generated_ipv6_cidr_block', value: bool(true) }] : []),
      { name: 'enable_dns_support', value: bool(true) },
      // Off by default in the API, and almost always wanted.
      { name: 'enable_dns_hostnames', value: bool(true) },
      tagsAttribute(plan, base),
    ],
  });
  if (v6 && (plan.ipv6Cidr || plan.subnets.some((s) => s.ipv6Cidr))) {
    findings.push(
      info(
        'terraform.aws.ipv6-allocated-by-amazon',
        'AWS allocates the VPC\'s IPv6 /56 itself, so the IPv6 ranges given were not used; each subnet takes the next /64 of it.',
        { path: 'ipv6Cidr' },
      ),
    );
  }

  const hasPublic = plan.subnets.some((s) => s.public);
  if (hasPublic) {
    blocks.push({
      type: 'resource',
      labels: ['aws_internet_gateway', 'this'],
      attributes: [
        { name: 'vpc_id', value: raw(vpcRef) },
        tagsAttribute(plan, `${base}-igw`),
      ],
    });
  }

  const hasPrivate = plan.subnets.some((s) => !s.public);
  if (v6 && hasPrivate) {
    blocks.push({
      type: 'resource',
      labels: ['aws_egress_only_internet_gateway', 'this'],
      comment: 'Outbound-only IPv6 for the private subnets: the IPv6 counterpart of NAT.',
      attributes: [
        { name: 'vpc_id', value: raw(vpcRef) },
        tagsAttribute(plan, `${base}-eigw`),
      ],
    });
  }

  for (const [index, subnet] of plan.subnets.entries()) {
    blocks.push({
      type: 'resource',
      labels: ['aws_subnet', identifier(subnet.name)],
      attributes: [
        { name: 'vpc_id', value: raw(vpcRef) },
        { name: 'cidr_block', value: str(subnet.cidr) },
        // The n-th /64 of the VPC's /56: 8 more bits, numbered by position.
        ...(v6
          ? [
              { name: 'ipv6_cidr_block', value: raw(`cidrsubnet(aws_vpc.this.ipv6_cidr_block, 8, ${index})`) },
              { name: 'assign_ipv6_address_on_creation', value: bool(true) },
            ]
          : []),
        ...(subnet.zone ? [{ name: 'availability_zone', value: str(subnet.zone) }] : []),
        ...(subnet.public ? [{ name: 'map_public_ip_on_launch', value: bool(true) }] : []),
        tagsAttribute(plan, resourceName(base, subnet.name)),
      ],
    });
  }

  if (hasPublic) {
    blocks.push({
      type: 'resource',
      labels: ['aws_route_table', 'public'],
      comment:
        'Routes are inline. Do not also manage this table with aws_route resources —\nthe two conflict and produce a permanent diff.',
      attributes: [{ name: 'vpc_id', value: raw(vpcRef) }],
      blocks: [
        {
          type: 'route',
          attributes: [
            { name: 'cidr_block', value: str('0.0.0.0/0') },
            { name: 'gateway_id', value: raw('aws_internet_gateway.this.id') },
          ],
        },
        ...(v6
          ? [
              {
                type: 'route',
                attributes: [
                  { name: 'ipv6_cidr_block', value: str('::/0') },
                  { name: 'gateway_id', value: raw('aws_internet_gateway.this.id') },
                ],
              },
            ]
          : []),
      ],
    });

    for (const subnet of plan.subnets.filter((s) => s.public)) {
      blocks.push({
        type: 'resource',
        labels: ['aws_route_table_association', identifier(subnet.name)],
        attributes: [
          { name: 'subnet_id', value: raw(`aws_subnet.${identifier(subnet.name)}.id`) },
          { name: 'route_table_id', value: raw('aws_route_table.public.id') },
        ],
      });
    }
  }

  if (v6 && hasPrivate) {
    blocks.push({
      type: 'resource',
      labels: ['aws_route_table', 'private'],
      comment: 'IPv6 out through the egress-only gateway. IPv4 has no route out until a NAT\ngateway is added here.',
      attributes: [{ name: 'vpc_id', value: raw(vpcRef) }],
      blocks: [
        {
          type: 'route',
          attributes: [
            { name: 'ipv6_cidr_block', value: str('::/0') },
            { name: 'egress_only_gateway_id', value: raw('aws_egress_only_internet_gateway.this.id') },
          ],
        },
      ],
    });
    for (const subnet of plan.subnets.filter((s) => !s.public)) {
      blocks.push({
        type: 'resource',
        labels: ['aws_route_table_association', identifier(subnet.name)],
        attributes: [
          { name: 'subnet_id', value: raw(`aws_subnet.${identifier(subnet.name)}.id`) },
          { name: 'route_table_id', value: raw('aws_route_table.private.id') },
        ],
      });
    }
  }

  blocks.push({
    type: 'resource',
    labels: ['aws_security_group', 'this'],
    comment:
      'Rules are separate resources below, which is what the provider asks for:\ninline ingress and egress blocks have no stable identity.',
    attributes: [
      { name: 'name', value: str(`${base}-sg`) },
      { name: 'description', value: str(`Baseline security group for ${base}`) },
      { name: 'vpc_id', value: raw(vpcRef) },
      tagsAttribute(plan, `${base}-sg`),
    ],
  });

  const cidrs = plan.allowedIngressCidrs ?? [];
  const ports = plan.allowedTcpPorts ?? [];
  for (const [ci, cidr] of cidrs.entries()) {
    for (const port of ports) {
      blocks.push({
        type: 'resource',
        labels: ['aws_vpc_security_group_ingress_rule', identifier(`allow_${port}_${ci}`)],
        attributes: [
          { name: 'security_group_id', value: raw('aws_security_group.this.id') },
          // One CIDR of one family per rule resource.
          { name: familyOf(cidr) === 6 ? 'cidr_ipv6' : 'cidr_ipv4', value: str(cidr) },
          { name: 'from_port', value: num(port) },
          { name: 'to_port', value: num(port) },
          { name: 'ip_protocol', value: str('tcp') },
          { name: 'description', value: str(`TCP ${port} from ${cidr}`) },
        ],
      });
    }
  }

  blocks.push({
    type: 'resource',
    labels: ['aws_vpc_security_group_egress_rule', 'all'],
    // -1 is every protocol, and then no port may be set at all.
    attributes: [
      { name: 'security_group_id', value: raw('aws_security_group.this.id') },
      { name: 'cidr_ipv4', value: str('0.0.0.0/0') },
      { name: 'ip_protocol', value: str('-1') },
      { name: 'description', value: str('All outbound') },
    ],
  });
  if (v6) {
    blocks.push({
      type: 'resource',
      labels: ['aws_vpc_security_group_egress_rule', 'all_ipv6'],
      attributes: [
        { name: 'security_group_id', value: raw('aws_security_group.this.id') },
        { name: 'cidr_ipv6', value: str('::/0') },
        { name: 'ip_protocol', value: str('-1') },
        { name: 'description', value: str('All outbound, IPv6') },
      ],
    });
  }

  const outputs: HclBlock[] = [
    { type: 'output', labels: ['vpc_id'], attributes: [{ name: 'value', value: raw(vpcRef) }] },
    {
      type: 'output',
      labels: ['subnet_ids'],
      attributes: [
        {
          name: 'value',
          value: raw(
            `{\n${plan.subnets
              .map((s) => `    ${JSON.stringify(s.name)} = aws_subnet.${identifier(s.name)}.id`)
              .join('\n')}\n  }`,
          ),
        },
      ],
    },
  ];

  if (cidrs.length === 0 || ports.length === 0) {
    findings.push(
      info(
        'terraform.aws.no-ingress',
        'No inbound rules were generated, so the security group admits nothing until rules are added.',
        { source: 'ArchToolKit' },
      ),
    );
  }
  const world = worldIngress(plan);
  if (world.length > 0) {
    findings.push(
      warning(
        'terraform.aws.ingress-from-anywhere',
        `An inbound rule allows ${world.join(' and ')}, which is the whole internet.`,
        { path: 'allowedIngressCidrs', remediation: 'Narrow it to the networks that need access.' },
      ),
    );
  }
  if (!plan.subnets.some((s) => s.zone)) {
    findings.push(
      info(
        'terraform.aws.no-availability-zones',
        'No availability zone is set on any subnet, so AWS chooses. Set zones to place them deliberately.',
        { path: 'subnets[].zone' },
      ),
    );
  }

  return {
    files: {
      'main.tf': renderFile(blocks, `AWS network foundation for ${base},`),
      'outputs.tf': renderFile(outputs),
    },
    findings,
  };
}
