/**
 * vSphere foundation.
 *
 * vSphere is not a cloud with an address space to carve up, so "foundation"
 * means something different here: a distributed switch, port groups on the VLANs
 * the design uses, a folder to hold the workload, and a resource pool under an
 * existing cluster. Existing infrastructure is referenced through data sources
 * rather than created, because a datacenter and cluster almost always exist
 * before Terraform is pointed at them.
 *
 * Two provider details are easy to get wrong:
 *
 * `vsphere_resource_pool` takes `parent_resource_pool_id`, not a cluster id. The
 * parent is the cluster's *root* resource pool, which the compute cluster data
 * source exposes as `resource_pool_id`.
 *
 * `vsphere_distributed_port_group` takes `distributed_virtual_switch_uuid`. The
 * switch resource's `id` happens to be that UUID, which is why referencing `.id`
 * works and reads like a mistake.
 *
 * Uplink names are generated explicitly: the provider's defaults are documented
 * as not guaranteed to be stable.
 */

import { info, warning,              } from '../core/findings.js';
import { renderFile, str, num, strings, raw,               } from './hcl.js';
import {
  identifier,
  resourceName,
                      
                        
} from './foundation.js';

export function emitVsphereFoundation(plan                )                   {
  const findings            = [];
  const blocks             = [];
  const base = resourceName(plan.name);
  const vmnics = plan.vmnics ?? ['vmnic0', 'vmnic1'];
  const uplinks = vmnics.map((_, i) => `uplink${i + 1}`);

  blocks.push({
    type: 'data',
    labels: ['vsphere_datacenter', 'this'],
    comment: 'Existing infrastructure is looked up, not created.',
    attributes: [{ name: 'name', value: str(plan.datacenter ?? 'Datacenter') }],
  });

  if (plan.cluster) {
    blocks.push({
      type: 'data',
      labels: ['vsphere_compute_cluster', 'this'],
      attributes: [
        { name: 'name', value: str(plan.cluster) },
        { name: 'datacenter_id', value: raw('data.vsphere_datacenter.this.id') },
      ],
    });
  }

  blocks.push({
    type: 'resource',
    labels: ['vsphere_distributed_virtual_switch', 'this'],
    comment:
      'Uplink names are set explicitly; the provider documents its defaults as not\nguaranteed to be stable.',
    attributes: [
      { name: 'name', value: str(`${base}-vds`) },
      { name: 'datacenter_id', value: raw('data.vsphere_datacenter.this.id') },
      { name: 'uplinks', value: strings(uplinks) },
      { name: 'active_uplinks', value: strings(uplinks) },
      { name: 'standby_uplinks', value: strings([]) },
      { name: 'max_mtu', value: num(9000) },
      { name: 'link_discovery_protocol', value: str('lldp') },
      { name: 'link_discovery_operation', value: str('both') },
    ],
  });

  for (const subnet of plan.subnets) {
    const vlan = Number.parseInt(subnet.zone ?? '', 10);
    blocks.push({
      type: 'resource',
      labels: ['vsphere_distributed_port_group', identifier(subnet.name)],
      attributes: [
        { name: 'name', value: str(resourceName(base, subnet.name)) },
        // The switch's id is its UUID, which is what this argument wants.
        {
          name: 'distributed_virtual_switch_uuid',
          value: raw('vsphere_distributed_virtual_switch.this.id'),
        },
        ...(Number.isFinite(vlan) ? [{ name: 'vlan_id', value: num(vlan) }] : []),
        { name: 'description', value: str(`${subnet.cidr} (${subnet.name})`) },
      ],
    });
  }

  blocks.push({
    type: 'resource',
    labels: ['vsphere_folder', 'this'],
    attributes: [
      { name: 'path', value: str(base) },
      { name: 'type', value: str('vm') },
      { name: 'datacenter_id', value: raw('data.vsphere_datacenter.this.id') },
    ],
  });

  if (plan.cluster) {
    blocks.push({
      type: 'resource',
      labels: ['vsphere_resource_pool', 'this'],
      comment:
        'The parent is the cluster’s root resource pool, not the cluster itself.',
      attributes: [
        { name: 'name', value: str(`${base}-rp`) },
        {
          name: 'parent_resource_pool_id',
          value: raw('data.vsphere_compute_cluster.this.resource_pool_id'),
        },
      ],
    });
  }

  const outputs             = [
    {
      type: 'output',
      labels: ['dvs_id'],
      attributes: [{ name: 'value', value: raw('vsphere_distributed_virtual_switch.this.id') }],
    },
    {
      type: 'output',
      labels: ['port_group_ids'],
      attributes: [
        {
          name: 'value',
          value: raw(
            `{\n${plan.subnets
              .map(
                (s) =>
                  `    ${JSON.stringify(s.name)} = vsphere_distributed_port_group.${identifier(s.name)}.id`,
              )
              .join('\n')}\n  }`,
          ),
        },
      ],
    },
  ];

  if (!plan.cluster) {
    findings.push(
      warning(
        'terraform.vsphere.no-cluster',
        'No cluster was named, so no resource pool was generated: its parent has to be an existing cluster’s root pool.',
        { path: 'cluster', remediation: 'Name the compute cluster to place a resource pool under.' },
      ),
    );
  }
  if (!plan.subnets.some((s) => Number.isFinite(Number.parseInt(s.zone ?? '', 10)))) {
    findings.push(
      info(
        'terraform.vsphere.no-vlans',
        'No VLAN id was given for any network, so port groups were generated without one. Put the VLAN in each subnet’s zone field.',
        { path: 'subnets[].zone' },
      ),
    );
  }
  findings.push(
    info(
      'terraform.vsphere.hosts-not-attached',
      'The switch is created without host blocks, so no ESXi host is attached to it yet. Adding hosts needs their managed object ids, which come from the environment rather than from a design.',
      { source: 'vsphere_distributed_virtual_switch' },
    ),
  );

  return {
    files: {
      'main.tf': renderFile(
        blocks,
        `vSphere foundation for ${base},`,
      ),
      'outputs.tf': renderFile(outputs),
    },
    findings,
  };
}
