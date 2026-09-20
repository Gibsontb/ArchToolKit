/**
 * Google Cloud network foundation.
 *
 * `auto_create_subnetworks` defaults to true, which silently creates a subnet in
 * every region. A custom-mode VPC is almost always what an architect means, so it
 * is set false explicitly rather than left to the default.
 *
 * A firewall rule must carry exactly one of `allow` or `deny`, and `source_ranges`
 * applies only to ingress. Egress uses `destination_ranges`; generating the wrong
 * one is rejected at plan time.
 *
 * Cloud NAT is emitted whenever a private subnet exists, because on Google a
 * subnet without a public address has no outbound path at all without it — the
 * default is no egress, which surprises people coming from AWS.
 */

import { info, warning, type Finding } from '../core/findings.ts';
import { renderFile, str, num, bool, strings, raw, type HclBlock } from './hcl.ts';
import {
  identifier,
  resourceName,
  type FoundationPlan,
  type FoundationOutput,
} from './foundation.ts';

export function emitGoogleFoundation(plan: FoundationPlan): FoundationOutput {
  const findings: Finding[] = [];
  const blocks: HclBlock[] = [];
  const base = resourceName(plan.name);
  const region = plan.region ?? 'us-central1';

  blocks.push({
    type: 'resource',
    labels: ['google_compute_network', 'this'],
    comment:
      'Custom mode. Left at the default, Google would create a subnet in every\nregion, which is rarely what anyone wants.',
    attributes: [
      { name: 'name', value: str(`${base}-vpc`) },
      { name: 'auto_create_subnetworks', value: bool(false) },
      { name: 'routing_mode', value: str('REGIONAL') },
    ],
  });

  for (const subnet of plan.subnets) {
    blocks.push({
      type: 'resource',
      labels: ['google_compute_subnetwork', identifier(subnet.name)],
      attributes: [
        { name: 'name', value: str(resourceName(base, subnet.name)) },
        { name: 'network', value: raw('google_compute_network.this.id') },
        { name: 'ip_cidr_range', value: str(subnet.cidr) },
        { name: 'region', value: str(region) },
        // Lets instances without external addresses reach Google APIs.
        { name: 'private_ip_google_access', value: bool(true) },
      ],
    });
  }

  const cidrs = plan.allowedIngressCidrs ?? [];
  const ports = plan.allowedTcpPorts ?? [];
  if (cidrs.length > 0 && ports.length > 0) {
    blocks.push({
      type: 'resource',
      labels: ['google_compute_firewall', 'allow_ingress'],
      attributes: [
        { name: 'name', value: str(`${base}-allow-ingress`) },
        { name: 'network', value: raw('google_compute_network.this.name') },
        { name: 'direction', value: str('INGRESS') },
        { name: 'priority', value: num(1000) },
        // source_ranges is ingress-only; egress rules use destination_ranges.
        { name: 'source_ranges', value: strings([...cidrs]) },
      ],
      blocks: [
        {
          type: 'allow',
          attributes: [
            { name: 'protocol', value: str('tcp') },
            { name: 'ports', value: strings(ports.map(String)) },
          ],
        },
      ],
    });
  }

  const hasPrivate = plan.subnets.some((s) => !s.public);
  if (hasPrivate) {
    blocks.push({
      type: 'resource',
      labels: ['google_compute_router', 'this'],
      comment:
        'A subnet with no external addresses has no outbound path on Google until\nCloud NAT exists. The router below carries no BGP block because it is only\nhere to host the NAT.',
      attributes: [
        { name: 'name', value: str(`${base}-router`) },
        { name: 'network', value: raw('google_compute_network.this.id') },
        { name: 'region', value: str(region) },
      ],
    });

    blocks.push({
      type: 'resource',
      labels: ['google_compute_router_nat', 'this'],
      attributes: [
        { name: 'name', value: str(`${base}-nat`) },
        { name: 'router', value: raw('google_compute_router.this.name') },
        { name: 'region', value: str(region) },
        { name: 'nat_ip_allocate_option', value: str('AUTO_ONLY') },
        {
          name: 'source_subnetwork_ip_ranges_to_nat',
          value: str('ALL_SUBNETWORKS_ALL_IP_RANGES'),
        },
      ],
      blocks: [
        {
          type: 'log_config',
          // Both arguments are required once the block is present.
          attributes: [
            { name: 'enable', value: bool(true) },
            { name: 'filter', value: str('ERRORS_ONLY') },
          ],
        },
      ],
    });
  }

  const outputs: HclBlock[] = [
    {
      type: 'output',
      labels: ['network_id'],
      attributes: [{ name: 'value', value: raw('google_compute_network.this.id') }],
    },
    {
      type: 'output',
      labels: ['subnet_ids'],
      attributes: [
        {
          name: 'value',
          value: raw(
            `{\n${plan.subnets
              .map(
                (s) =>
                  `    ${JSON.stringify(s.name)} = google_compute_subnetwork.${identifier(s.name)}.id`,
              )
              .join('\n')}\n  }`,
          ),
        },
      ],
    },
  ];

  if (cidrs.includes('0.0.0.0/0')) {
    findings.push(
      warning(
        'terraform.google.ingress-from-anywhere',
        'A firewall rule allows 0.0.0.0/0.',
        { path: 'allowedIngressCidrs', remediation: 'Narrow it to the networks that need access.' },
      ),
    );
  }
  if (hasPrivate) {
    findings.push(
      info(
        'terraform.google.nat-emitted',
        'Cloud NAT was generated because a private subnet exists; without it those instances have no outbound connectivity.',
        { source: 'google_compute_router_nat' },
      ),
    );
  }
  if (plan.subnets.some((s) => s.public)) {
    findings.push(
      info(
        'terraform.google.no-public-subnet-concept',
        'Google has no public subnet: a instance is reachable because it holds an external address, not because of the subnet it sits in. The public flag only influenced NAT here.',
        { path: 'subnets[].public' },
      ),
    );
  }

  return {
    files: {
      'main.tf': renderFile(
        blocks,
        `Google Cloud network foundation for ${base}, generated by ArchToolKit.`,
      ),
      'outputs.tf': renderFile(outputs),
    },
    findings,
  };
}
