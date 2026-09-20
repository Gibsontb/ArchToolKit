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
 */

import { info, warning, type Finding } from '../core/findings.ts';
import { renderFile, str, num, bool, raw, type HclBlock, type HclAttribute } from './hcl.ts';
import {
  identifier,
  resourceName,
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
  const findings: Finding[] = [];
  const blocks: HclBlock[] = [];
  const base = resourceName(plan.name);
  const vpcRef = 'aws_vpc.this.id';

  blocks.push({
    type: 'resource',
    labels: ['aws_vpc', 'this'],
    attributes: [
      { name: 'cidr_block', value: str(plan.cidr) },
      { name: 'enable_dns_support', value: bool(true) },
      // Off by default in the API, and almost always wanted.
      { name: 'enable_dns_hostnames', value: bool(true) },
      tagsAttribute(plan, base),
    ],
  });

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

  for (const subnet of plan.subnets) {
    blocks.push({
      type: 'resource',
      labels: ['aws_subnet', identifier(subnet.name)],
      attributes: [
        { name: 'vpc_id', value: raw(vpcRef) },
        { name: 'cidr_block', value: str(subnet.cidr) },
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
          { name: 'cidr_ipv4', value: str(cidr) },
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
  if (cidrs.includes('0.0.0.0/0')) {
    findings.push(
      warning(
        'terraform.aws.ingress-from-anywhere',
        'An inbound rule allows 0.0.0.0/0, which is the whole internet.',
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
      'main.tf': renderFile(blocks, `AWS network foundation for ${base}, generated by ArchToolKit.`),
      'outputs.tf': renderFile(outputs),
    },
    findings,
  };
}
