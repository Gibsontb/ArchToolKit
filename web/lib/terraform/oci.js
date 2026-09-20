/**
 * Oracle Cloud Infrastructure network foundation.
 *
 * OCI differs from the others in ways that break a naive translation:
 *
 * `compartment_id` is required on every resource. Without one there is nothing
 * to emit, so this refuses rather than generating a file that cannot apply.
 *
 * `cidr_blocks` is a list and supersedes the deprecated singular `cidr_block`.
 *
 * Security list protocols are IP protocol numbers given as strings — "6" for
 * TCP, "17" for UDP, "1" for ICMP — not names. A rule saying "tcp" is rejected.
 *
 * Ports are `min`/`max` blocks, with no bare port argument, so a single port is
 * expressed as min equal to max.
 *
 * Subnets are emitted as regional, with no availability domain, which is the
 * current recommendation; an AD-specific subnet cannot span failure domains.
 */

import { error, info, warning,              } from '../core/findings.js';
import { renderFile, str, num, bool, strings, raw,               } from './hcl.js';
import {
  identifier,
  resourceName,
                      
                        
} from './foundation.js';

/** IP protocol numbers, which is what OCI security rules take. */
const PROTOCOL_TCP = '6';

export function emitOciFoundation(plan                )                   {
  const findings            = [];
  const base = resourceName(plan.name);

  if (!plan.compartmentId) {
    return {
      files: {},
      findings: [
        error(
          'terraform.oci.no-compartment',
          'Every OCI resource requires a compartment OCID, and none was supplied, so nothing was generated.',
          {
            path: 'compartmentId',
            remediation: 'Supply the compartment OCID the network should be created in.',
          },
        ),
      ],
    };
  }

  const compartment = raw('var.oci_compartment_ocid');
  const blocks             = [];

  blocks.push({
    type: 'resource',
    labels: ['oci_core_vcn', 'this'],
    attributes: [
      { name: 'compartment_id', value: compartment },
      // Plural; the singular cidr_block is deprecated.
      { name: 'cidr_blocks', value: strings([plan.cidr]) },
      { name: 'display_name', value: str(`${base}-vcn`) },
      { name: 'dns_label', value: str(identifier(base).replace(/_/g, '').slice(0, 15)) },
    ],
  });

  const hasPublic = plan.subnets.some((s) => s.public);
  if (hasPublic) {
    blocks.push({
      type: 'resource',
      labels: ['oci_core_internet_gateway', 'this'],
      attributes: [
        { name: 'compartment_id', value: compartment },
        { name: 'vcn_id', value: raw('oci_core_vcn.this.id') },
        { name: 'display_name', value: str(`${base}-igw`) },
        { name: 'enabled', value: bool(true) },
      ],
    });

    blocks.push({
      type: 'resource',
      labels: ['oci_core_route_table', 'public'],
      attributes: [
        { name: 'compartment_id', value: compartment },
        { name: 'vcn_id', value: raw('oci_core_vcn.this.id') },
        { name: 'display_name', value: str(`${base}-rt-public`) },
      ],
      blocks: [
        {
          type: 'route_rules',
          attributes: [
            { name: 'network_entity_id', value: raw('oci_core_internet_gateway.this.id') },
            { name: 'destination', value: str('0.0.0.0/0') },
            // Required whenever destination is set.
            { name: 'destination_type', value: str('CIDR_BLOCK') },
            { name: 'description', value: str('Default route to the internet gateway') },
          ],
        },
      ],
    });
  }

  const cidrs = plan.allowedIngressCidrs ?? [];
  const ports = plan.allowedTcpPorts ?? [];
  const ingressRules             = [];
  for (const cidr of cidrs) {
    for (const port of ports) {
      ingressRules.push({
        type: 'ingress_security_rules',
        attributes: [
          // An IP protocol number as a string, not a name.
          { name: 'protocol', value: str(PROTOCOL_TCP) },
          { name: 'source', value: str(cidr) },
          { name: 'source_type', value: str('CIDR_BLOCK') },
          { name: 'description', value: str(`TCP ${port} from ${cidr}`) },
        ],
        blocks: [
          {
            type: 'tcp_options',
            blocks: [
              {
                type: 'destination_port_range',
                // No bare port argument exists; a single port is min = max.
                attributes: [
                  { name: 'min', value: num(port) },
                  { name: 'max', value: num(port) },
                ],
              },
            ],
          },
        ],
      });
    }
  }

  blocks.push({
    type: 'resource',
    labels: ['oci_core_security_list', 'this'],
    attributes: [
      { name: 'compartment_id', value: compartment },
      { name: 'vcn_id', value: raw('oci_core_vcn.this.id') },
      { name: 'display_name', value: str(`${base}-sl`) },
    ],
    blocks: [
      ...ingressRules,
      {
        type: 'egress_security_rules',
        attributes: [
          { name: 'protocol', value: str('all') },
          { name: 'destination', value: str('0.0.0.0/0') },
          { name: 'destination_type', value: str('CIDR_BLOCK') },
          { name: 'description', value: str('All outbound') },
        ],
      },
    ],
  });

  for (const subnet of plan.subnets) {
    blocks.push({
      type: 'resource',
      labels: ['oci_core_subnet', identifier(subnet.name)],
      // No availability_domain: a regional subnet spans the domains in the region.
      attributes: [
        { name: 'compartment_id', value: compartment },
        { name: 'vcn_id', value: raw('oci_core_vcn.this.id') },
        { name: 'cidr_block', value: str(subnet.cidr) },
        { name: 'display_name', value: str(resourceName(base, subnet.name)) },
        ...(subnet.public
          ? [{ name: 'route_table_id', value: raw('oci_core_route_table.public.id') }]
          : [{ name: 'prohibit_public_ip_on_vnic', value: bool(true) }]),
        { name: 'security_list_ids', value: raw('[oci_core_security_list.this.id]') },
      ],
    });
  }

  const variables             = [
    {
      type: 'variable',
      labels: ['oci_compartment_ocid'],
      attributes: [
        { name: 'type', value: raw('string') },
        { name: 'description', value: str('Compartment OCID the network is created in.') },
        { name: 'default', value: str(plan.compartmentId) },
      ],
    },
  ];

  const outputs             = [
    {
      type: 'output',
      labels: ['vcn_id'],
      attributes: [{ name: 'value', value: raw('oci_core_vcn.this.id') }],
    },
    {
      type: 'output',
      labels: ['subnet_ids'],
      attributes: [
        {
          name: 'value',
          value: raw(
            `{\n${plan.subnets
              .map((s) => `    ${JSON.stringify(s.name)} = oci_core_subnet.${identifier(s.name)}.id`)
              .join('\n')}\n  }`,
          ),
        },
      ],
    },
  ];

  if (cidrs.includes('0.0.0.0/0')) {
    findings.push(
      warning('terraform.oci.ingress-from-anywhere', 'An ingress rule allows 0.0.0.0/0.', {
        path: 'allowedIngressCidrs',
      }),
    );
  }
  findings.push(
    info(
      'terraform.oci.regional-subnets',
      'Subnets are regional, with no availability domain, which is the current recommendation.',
      { source: 'oci_core_subnet' },
    ),
  );
  if (plan.subnets.some((s) => !s.public)) {
    findings.push(
      info(
        'terraform.oci.private-subnets-have-no-egress',
        'Private subnets prohibit public IPs and have no route out. Add a NAT gateway and a route table for them if they need outbound access.',
        { path: 'subnets' },
      ),
    );
  }

  return {
    files: {
      'main.tf': renderFile(blocks, `OCI network foundation for ${base}, generated by ArchToolKit.`),
      'variables.tf': renderFile(variables),
      'outputs.tf': renderFile(outputs),
    },
    findings,
  };
}
