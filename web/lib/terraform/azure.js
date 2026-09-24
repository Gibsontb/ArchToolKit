/**
 * Azure network foundation.
 *
 * Three provider details shape this, all of them version-sensitive:
 *
 * `address_prefixes` is a list — the singular `address_prefix` was removed in
 * provider 3.0 and generating it produces an unknown-argument error.
 *
 * Subnets are standalone `azurerm_subnet` resources rather than inline blocks on
 * the virtual network. The two are mutually exclusive, and the inline form makes
 * every subnet change a change to the network itself.
 *
 * The network security group is attached with
 * `azurerm_subnet_network_security_group_association`, which must not be combined
 * with an inline `security_group` on the subnet: they overwrite each other and
 * produce a perpetual diff.
 *
 * Azure does not allocate IPv6: dual stack (`ipv6`) adds the given `ipv6Cidr`
 * to `address_space` and a /64 to each subnet's `address_prefixes`, which is
 * the only IPv6 size a subnet takes. A security rule's single
 * `source_address_prefix` is one family, so each source is its own rule.
 */

import { hasErrors, info, warning,              } from '../core/findings.js';
import { renderFile, str, num, strings, raw,                                  } from './hcl.js';
import {
  checkFoundationAddresses,
  identifier,
  resourceName,
  subnetIpv6Ranges,
  worldIngress,
                      
                        
} from './foundation.js';

function tagsAttribute(plan                )                 {
  const tags = plan.tags ?? {};
  if (Object.keys(tags).length === 0) return [];
  const body = Object.entries(tags)
    .map(([k, v]) => `    ${JSON.stringify(k)} = ${JSON.stringify(v)}`)
    .join('\n');
  return [{ name: 'tags', value: raw(`{\n${body}\n  }`) }];
}

export function emitAzureFoundation(plan                )                   {
  const findings            = checkFoundationAddresses(plan, 'azure', 'An Azure virtual network');
  const v6 = plan.ipv6 === true;
  const v6Ranges = v6 ? subnetIpv6Ranges(plan, 'azure') : { ranges: [], findings: [] };
  findings.push(...v6Ranges.findings);
  if (hasErrors(findings)) return { files: {}, findings };
  const blocks             = [];
  const base = resourceName(plan.name);
  const location = plan.region ?? 'eastus';
  const rg = 'azurerm_resource_group.this';

  blocks.push({
    type: 'resource',
    labels: ['azurerm_resource_group', 'this'],
    attributes: [
      { name: 'name', value: str(`${base}-rg`) },
      { name: 'location', value: str(location) },
      ...tagsAttribute(plan),
    ],
  });

  blocks.push({
    type: 'resource',
    labels: ['azurerm_virtual_network', 'this'],
    attributes: [
      { name: 'name', value: str(`${base}-vnet`) },
      { name: 'resource_group_name', value: raw(`${rg}.name`) },
      { name: 'location', value: raw(`${rg}.location`) },
      { name: 'address_space', value: strings(v6 ? [plan.cidr, plan.ipv6Cidr ] : [plan.cidr]) },
      ...tagsAttribute(plan),
    ],
  });

  for (const [index, subnet] of plan.subnets.entries()) {
    blocks.push({
      type: 'resource',
      labels: ['azurerm_subnet', identifier(subnet.name)],
      // A subnet carries no location and no tags; both live on the network.
      attributes: [
        { name: 'name', value: str(resourceName(base, subnet.name)) },
        { name: 'resource_group_name', value: raw(`${rg}.name`) },
        { name: 'virtual_network_name', value: raw('azurerm_virtual_network.this.name') },
        // Plural, and a list: the singular form was removed in provider 3.0.
        // Dual stack: the IPv4 range and the subnet's IPv6 /64.
        {
          name: 'address_prefixes',
          value: strings(v6 ? [subnet.cidr, v6Ranges.ranges[index] ] : [subnet.cidr]),
        },
      ],
    });
  }

  const cidrs = plan.allowedIngressCidrs ?? [];
  const ports = plan.allowedTcpPorts ?? [];
  const rules             = [];
  let priority = 100;
  for (const cidr of cidrs) {
    for (const port of ports) {
      rules.push({
        type: 'security_rule',
        attributes: [
          { name: 'name', value: str(resourceName(`allow-tcp-${port}-${priority}`)) },
          { name: 'priority', value: num(priority) },
          { name: 'direction', value: str('Inbound') },
          { name: 'access', value: str('Allow') },
          { name: 'protocol', value: str('Tcp') },
          { name: 'source_port_range', value: str('*') },
          { name: 'destination_port_range', value: str(String(port)) },
          { name: 'source_address_prefix', value: str(cidr) },
          { name: 'destination_address_prefix', value: str('*') },
        ],
      });
      // Priorities must be unique within the group and sit between 100 and 4096.
      priority += 10;
    }
  }

  blocks.push({
    type: 'resource',
    labels: ['azurerm_network_security_group', 'this'],
    attributes: [
      { name: 'name', value: str(`${base}-nsg`) },
      { name: 'location', value: raw(`${rg}.location`) },
      { name: 'resource_group_name', value: raw(`${rg}.name`) },
      ...tagsAttribute(plan),
    ],
    blocks: rules,
  });

  for (const subnet of plan.subnets) {
    blocks.push({
      type: 'resource',
      labels: ['azurerm_subnet_network_security_group_association', identifier(subnet.name)],
      comment:
        identifier(subnet.name) === identifier(plan.subnets[0]?.name ?? '')
          ? 'Do not also set a security group inline on the subnet: the two overwrite\neach other and produce a perpetual diff.'
          : undefined,
      attributes: [
        { name: 'subnet_id', value: raw(`azurerm_subnet.${identifier(subnet.name)}.id`) },
        {
          name: 'network_security_group_id',
          value: raw('azurerm_network_security_group.this.id'),
        },
      ],
    });
  }

  const outputs             = [
    {
      type: 'output',
      labels: ['resource_group_name'],
      attributes: [{ name: 'value', value: raw(`${rg}.name`) }],
    },
    {
      type: 'output',
      labels: ['virtual_network_id'],
      attributes: [{ name: 'value', value: raw('azurerm_virtual_network.this.id') }],
    },
    {
      type: 'output',
      labels: ['subnet_ids'],
      attributes: [
        {
          name: 'value',
          value: raw(
            `{\n${plan.subnets
              .map((s) => `    ${JSON.stringify(s.name)} = azurerm_subnet.${identifier(s.name)}.id`)
              .join('\n')}\n  }`,
          ),
        },
      ],
    },
  ];

  if (priority > 4096) {
    findings.push(
      warning(
        'terraform.azure.priority-overflow',
        'More inbound rules were generated than the 100-4096 priority range allows.',
        { path: 'allowedTcpPorts', remediation: 'Reduce the number of rules, or group ports.' },
      ),
    );
  }
  const world = worldIngress(plan);
  if (world.length > 0) {
    findings.push(
      warning(
        'terraform.azure.ingress-from-anywhere',
        `An inbound rule allows ${world.join(' and ')}. Azure also accepts the Internet service tag, which is clearer about intent.`,
        { path: 'allowedIngressCidrs' },
      ),
    );
  }
  findings.push(
    info(
      'terraform.azure.resource-group-deletion',
      'The provider refuses to destroy a resource group that still contains resources unless features.resource_group.prevent_deletion_if_contains_resources is turned off.',
      { source: 'terraform-provider-azurerm features block' },
    ),
  );

  return {
    files: {
      'main.tf': renderFile(
        blocks,
        `Azure network foundation for ${base},`,
      ),
      'outputs.tf': renderFile(outputs),
    },
    findings,
  };
}
