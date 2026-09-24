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
 *
 * Dual stack (`ipv6`) sets `stack_type = "IPV4_IPV6"` on each subnet, and
 * Google allocates the IPv6 range: a public subnet takes an EXTERNAL (global)
 * /64, a private one an INTERNAL (ULA) /64, which needs
 * `enable_ula_internal_ipv6` on the network. A firewall rule holds ranges of one
 * family only, so IPv6 sources get their own rule. Cloud NAT is IPv4.
 */

import { hasErrors, info, warning, type Finding } from '../core/findings.ts';
import { byFamily } from '../core/ip.ts';
import { renderFile, str, num, bool, strings, raw, type HclBlock } from './hcl.ts';
import {
  checkFoundationAddresses,
  identifier,
  resourceName,
  worldIngress,
  type FoundationPlan,
  type FoundationOutput,
} from './foundation.ts';

export function emitGoogleFoundation(plan: FoundationPlan): FoundationOutput {
  const findings: Finding[] = checkFoundationAddresses(plan, 'google', 'A Google VPC subnet');
  if (hasErrors(findings)) return { files: {}, findings };
  const blocks: HclBlock[] = [];
  const base = resourceName(plan.name);
  const region = plan.region ?? 'us-central1';
  const v6 = plan.ipv6 === true;
  // An INTERNAL IPv6 subnet draws on the network's ULA range, which is off by default.
  const internalV6 = v6 && plan.subnets.some((s) => !s.public);

  blocks.push({
    type: 'resource',
    labels: ['google_compute_network', 'this'],
    comment:
      'Custom mode. Left at the default, Google would create a subnet in every\nregion, which is rarely what anyone wants.',
    attributes: [
      { name: 'name', value: str(`${base}-vpc`) },
      { name: 'auto_create_subnetworks', value: bool(false) },
      { name: 'routing_mode', value: str('REGIONAL') },
      ...(internalV6 ? [{ name: 'enable_ula_internal_ipv6', value: bool(true) }] : []),
    ],
  });
  if (v6 && (plan.ipv6Cidr || plan.subnets.some((s) => s.ipv6Cidr))) {
    findings.push(
      info(
        'terraform.google.ipv6-allocated-by-google',
        'Google allocates each dual-stack subnet\'s IPv6 /64, so the IPv6 ranges given were not used.',
        { path: 'ipv6Cidr' },
      ),
    );
  }

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
        ...(v6
          ? [
              { name: 'stack_type', value: str('IPV4_IPV6') },
              // Google allocates the /64: global for a public subnet, ULA for a private one.
              { name: 'ipv6_access_type', value: str(subnet.public ? 'EXTERNAL' : 'INTERNAL') },
            ]
          : []),
      ],
    });
  }

  const cidrs = plan.allowedIngressCidrs ?? [];
  const ports = plan.allowedTcpPorts ?? [];
  // One family per rule: Google rejects a rule that mixes IPv4 and IPv6 ranges.
  const split = byFamily(cidrs);
  const families: [string, string, string[]][] = [
    ['allow_ingress', `${base}-allow-ingress`, split.v4],
    ['allow_ingress_ipv6', `${base}-allow-ingress-ipv6`, split.v6],
  ];
  for (const [label, ruleName, ranges] of families) {
    if (ranges.length === 0 || ports.length === 0) continue;
    blocks.push({
      type: 'resource',
      labels: ['google_compute_firewall', label],
      attributes: [
        { name: 'name', value: str(ruleName) },
        { name: 'network', value: raw('google_compute_network.this.name') },
        { name: 'direction', value: str('INGRESS') },
        { name: 'priority', value: num(1000) },
        // source_ranges is ingress-only; egress rules use destination_ranges.
        { name: 'source_ranges', value: strings(ranges) },
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

  const world = worldIngress(plan);
  if (world.length > 0) {
    findings.push(
      warning(
        'terraform.google.ingress-from-anywhere',
        `A firewall rule allows ${world.join(' and ')}.`,
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
  if (internalV6) {
    findings.push(
      info(
        'terraform.google.internal-ipv6-no-egress',
        'Private subnets get INTERNAL (ULA) IPv6, which reaches only the VPC and its peers; Cloud NAT here translates IPv4 only.',
        { path: 'subnets[].public' },
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
        `Google Cloud network foundation for ${base},`,
      ),
      'outputs.tf': renderFile(outputs),
    },
    findings,
  };
}
