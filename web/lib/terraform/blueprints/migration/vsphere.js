/**
 * vSphere / VCF 9.1 blueprint for a migration plan: the VMs rebuilt in a VCF
 * workload domain, cloned from templates with guest customization.
 *
 * Rows moving by relocation (HCX or vMotion) are not in the grid: HCX moves
 * them, and `vsphere_estate_landing` has already built their port groups and
 * folders. The Windows domain join is not done here either — Ansible does it
 * with a vaulted credential — so customization carries no domain password.
 */

import { info, warning,              } from '../../../core/findings.js';
import { familyOf, parseCidrAny } from '../../../core/ip.js';
                                                                            
import { str as valueOf } from '../../../kit/blueprint.js';
                                             
import {
  MIGRATION_GROUP,
  OS_IDS,
  attrs,
  blk,
  cellNumber,
  dat,
  e,
  gridInput,
  hcl,
  mainTf,
  osFamily,
  osKind,
  output,
  parseGrid,
  res,
  secretVariable,
  terraformBlock,
  variable,
  uniqueNames,
  words,
  x,
                  
} from './common.js';

const COLUMNS                        = [
  { name: 'Name' },
  { name: 'OS', options: OS_IDS },
  { name: 'Template' },
  { name: 'vCPU', options: ['1', '2', '4', '8', '16'] },
  { name: 'RAM GiB', options: ['3', '6', '12', '24', '32', '48', '64', '96', '128'] },
  { name: 'Disks' },
  { name: 'Port group' },
  { name: 'IPv4/prefix' },
  { name: 'IPv6/prefix' },
  { name: 'Gateway' },
  { name: 'Wave' },
];

const DEFAULT_ROWS                                 = [
  ['web01', 'win-2022', 'tpl-win2022', '2', '8', '100', 'wld01-web', '10.50.10.21/24', 'fd00:50:10::21/64', '10.50.10.1 fd00:50:10::1', '1'],
  ['app01', 'rhel-9', 'tpl-rhel9', '4', '16', '60 200', 'wld01-app', '10.50.20.21/24', 'fd00:50:20::21/64', '10.50.20.1 fd00:50:20::1', '1'],
];

                     
                        
                      
                                     
                            
                        
                          
                                    
                             
                                                    
                                                    
                        
                        
                        
 

function parseRows(text        , findings           )              {
  const rows = uniqueNames(parseGrid(text, COLUMNS.map((c) => c.name)), 'Name', 'vms', findings);
  return rows.map((r) => {
    const addr = (cell        , family       ) => {
      const c = cell ? parseCidrAny(cell) : null;
      if (!cell) return undefined;
      if (!c || c.family !== family || !cell.includes('/')) {
        findings.push(warning('tf.mig.vsphere-address', `${r['Name']}: "${cell}" is not an IPv${family} address with a prefix; that family is left to DHCP.`, { path: 'vms' }));
        return undefined;
      }
      return { address: c.address, prefix: c.prefix };
    };
    const gateways = words(r['Gateway'] ?? '');
    const os = r['OS'] || 'unknown';
    const disks = words(r['Disks'] ?? '').map((d) => cellNumber(d.replace(/^.*:/, ''), 60));
    const v4 = addr(r['IPv4/prefix'] ?? '', 4);
    const v6 = addr(r['IPv6/prefix'] ?? '', 6);
    return {
      name: r['Name']          ,
      os,
      kind: osKind(os),
      template: r['Template'] ?? '',
      vcpu: cellNumber(r['vCPU'], 2),
      ramMiB: cellNumber(r['RAM GiB'], 4) * 1024,
      disks: disks.length > 0 ? disks : [60],
      portGroup: r['Port group'] ?? '',
      ...(v4 ? { v4 } : {}),
      ...(v6 ? { v6 } : {}),
      ...(gateways.find((g) => familyOf(g) === 4) ? { gw4: gateways.find((g) => familyOf(g) === 4) } : {}),
      ...(gateways.find((g) => familyOf(g) === 6) ? { gw6: gateways.find((g) => familyOf(g) === 6) } : {}),
      wave: r['Wave'] ?? '',
    };
  });
}

function vsphereVms()            {
  return {
    id: 'vsphere_mig_vms',
    label: 'VMs rebuilt in VCF (migration)',
    group: MIGRATION_GROUP,
    description: 'A VM per row in the VCF 9.1 workload domain, cloned from a template with guest customization: static dual-stack addressing, DNS and host name. The domain join is left to Ansible, so no domain credential is written.',
    inputs: [
      { id: 'vsphere_server', label: 'vCenter', control: 'text', default: 'wld01-vc01.example.com', hint: 'The workload domain\'s vCenter instance.' },
      { id: 'datacenter', label: 'Datacenter', control: 'text', default: 'wld01-dc' },
      { id: 'cluster', label: 'Cluster', control: 'text', default: 'wld01-cl01' },
      { id: 'datastore_or_policy', label: 'Datastore (and storage policy)', control: 'text', default: 'wld01-cl01-ds-vsan01 policy:vSAN Default Storage Policy', hint: 'A datastore name, optionally followed by policy:<VM storage policy>.' },
      { id: 'folder', label: 'VM folder', control: 'text', default: 'migrated', hint: 'Relative to the datacenter\'s VM folder; blank for the root.' },
      gridInput('vms', 'VMs', COLUMNS, DEFAULT_ROWS, 'One row per VM. Disks: GiB, space-separated, the first is the OS disk. Gateway: an IPv4 and an IPv6 gateway, space-separated.'),
      { id: 'domain', label: 'DNS domain', control: 'text', default: 'corp.example.com' },
      { id: 'dns_servers', label: 'DNS servers', control: 'text', default: '10.50.0.10 10.50.0.11 fd00:50::10', hint: 'Space-separated, either family.' },
    ],
    emits: ['vsphere_virtual_machine'],
    build: (values                 ) => {
      const findings            = [];
      const vms = parseRows(valueOf(values, 'vms'), findings);
      const [datastore = 'datastore1', ...rest] = valueOf(values, 'datastore_or_policy', 'datastore1').split(/\s+policy:/);
      const policy = rest.join(' ').trim();
      const folder = valueOf(values, 'folder');
      const dns = words(valueOf(values, 'dns_servers'));
      const domain = valueOf(values, 'domain', 'corp.example.com');
      const anyWindows = vms.some((v) => v.kind === 'windows');
      const blocks             = [
        terraformBlock(['vsphere']),
        {
          type: 'provider',
          labels: ['vsphere'],
          attributes: attrs({ vsphere_server: valueOf(values, 'vsphere_server', 'vcenter.example.com'), user: x('var.vsphere_user'), password: x('var.vsphere_password'), allow_unverified_ssl: false }),
        },
        variable('vsphere_user', 'string', 'The vCenter account Terraform signs in with (TF_VAR_vsphere_user).'),
        secretVariable('vsphere_password', 'The password of the vCenter account Terraform signs in with.'),
        ...(anyWindows ? [secretVariable('windows_admin_password', 'The local Administrator password guest customization sets on Windows VMs (Ansible replaces it with the domain\'s).')] : []),
        dat('vsphere_datacenter', 'dc', { name: valueOf(values, 'datacenter', 'dc') }),
        dat('vsphere_compute_cluster', 'cluster', { name: valueOf(values, 'cluster', 'cluster'), datacenter_id: x('data.vsphere_datacenter.dc.id') }),
        dat('vsphere_datastore', 'datastore', { name: datastore.trim(), datacenter_id: x('data.vsphere_datacenter.dc.id') }),
        ...(policy ? [dat('vsphere_storage_policy', 'policy', { name: policy })] : []),
      ];
      const templates = [...new Set(vms.map((v) => v.template).filter(Boolean))];
      const networks = [...new Set(vms.map((v) => v.portGroup).filter(Boolean))];
      templates.forEach((t, i) => blocks.push(dat('vsphere_virtual_machine', `template_${i + 1}`, { name: t, datacenter_id: x('data.vsphere_datacenter.dc.id') }, [], t)));
      networks.forEach((n, i) => blocks.push(dat('vsphere_network', `port_group_${i + 1}`, { name: n, datacenter_id: x('data.vsphere_datacenter.dc.id') }, [], n)));
      const entries                          = {};
      for (const v of vms) {
        if (!v.template) findings.push(warning('tf.mig.vsphere-no-template', `${v.name} names no template; it cannot be cloned.`, { path: 'vms' }));
        if (!v.portGroup) findings.push(warning('tf.mig.vsphere-no-port-group', `${v.name} names no port group.`, { path: 'vms' }));
        const t = `data.vsphere_virtual_machine.template_${templates.indexOf(v.template) + 1}`;
        entries[v.name] = {
          kind: v.kind,
          os: v.os,
          os_family: osFamily(v.os),
          template: e(t),
          network_id: e(`data.vsphere_network.port_group_${networks.indexOf(v.portGroup) + 1}.id`),
          num_cpus: v.vcpu,
          memory: v.ramMiB,
          disks: v.disks,
          ipv4_address: v.v4?.address ?? null,
          ipv4_netmask: v.v4?.prefix ?? null,
          ipv6_address: v.v6?.address ?? null,
          ipv6_netmask: v.v6?.prefix ?? null,
          ipv4_gateway: v.gw4 ?? null,
          ipv6_gateway: v.gw6 ?? null,
          wave: v.wave,
        };
      }
      const valid = vms.filter((v) => v.template && v.portGroup);
      if (valid.length < vms.length) findings.push(info('tf.mig.vsphere-rows-skipped', 'Rows without a template or port group were left out.', { path: 'vms' }));
      const kept = Object.fromEntries(Object.entries(entries).filter(([k]) => valid.some((v) => v.name === k)));
      blocks.push(
        {
          type: 'locals',
          comment: 'Every VM in the grid, by name: the compute contract (local.mig_vms) for this platform.',
          attributes: [{ name: 'mig_vms', value: x(hcl(kept, 1)) }],
        },
        res('vsphere_virtual_machine', 'vm', {
          for_each: x('local.mig_vms'),
          name: x('each.key'),
          resource_pool_id: x('data.vsphere_compute_cluster.cluster.resource_pool_id'),
          datastore_id: x('data.vsphere_datastore.datastore.id'),
          storage_policy_id: policy ? x('data.vsphere_storage_policy.policy.id') : undefined,
          folder: folder || undefined,
          annotation: x('"Migrated, wave ${each.value.wave}. OS ${each.value.os}."'),
          num_cpus: x('each.value.num_cpus'),
          memory: x('each.value.memory'),
          guest_id: x('each.value.template.guest_id'),
          firmware: x('each.value.template.firmware'),
          scsi_type: x('each.value.template.scsi_type'),
          wait_for_guest_net_timeout: 5,
        }, [
          blk('network_interface', { network_id: x('each.value.network_id'), adapter_type: x('each.value.template.network_interface_types[0]') }),
          blk('disk', { label: 'disk0', size: x('max(each.value.disks[0], each.value.template.disks[0].size)'), thin_provisioned: x('each.value.template.disks[0].thin_provisioned') }),
          {
            type: 'dynamic',
            labels: ['disk'],
            attributes: attrs({ for_each: x('slice(each.value.disks, 1, length(each.value.disks))') }),
            blocks: [blk('content', { label: x('"disk${disk.key + 1}"'), size: x('disk.value'), unit_number: x('disk.key + 1'), thin_provisioned: true })],
          },
          blk('clone', { template_uuid: x('each.value.template.id') }, [
            blk('customize', {
              ipv4_gateway: x('each.value.ipv4_gateway'),
              ipv6_gateway: x('each.value.ipv6_gateway'),
              dns_server_list: dns,
              dns_suffix_list: [domain],
            }, [
              { type: 'dynamic', labels: ['linux_options'], attributes: attrs({ for_each: x('each.value.kind == "linux" ? [each.key] : []') }), blocks: [blk('content', { host_name: x('linux_options.value'), domain })] },
              {
                type: 'dynamic',
                labels: ['windows_options'],
                attributes: attrs({ for_each: x('each.value.kind == "windows" ? [substr(each.key, 0, 15)] : []') }),
                blocks: [blk('content', { computer_name: x('windows_options.value'), admin_password: anyWindows ? x('var.windows_admin_password') : undefined })],
              },
              blk('network_interface', { ipv4_address: x('each.value.ipv4_address'), ipv4_netmask: x('each.value.ipv4_netmask'), ipv6_address: x('each.value.ipv6_address'), ipv6_netmask: x('each.value.ipv6_netmask') }),
            ]),
          ]),
          blk('lifecycle', { ignore_changes: x('[clone[0].template_uuid, clone[0].customize]') }),
        ]),
        output('vms', '{ for k, v in vsphere_virtual_machine.vm : k => { id = v.id, moid = v.moid, ip = v.default_ip_address, addresses = v.guest_ip_addresses, os = local.mig_vms[k].os } }', 'Each VM: ids and addresses, for the Ansible inventory.'),
      );
      if (vms.some((v) => !v.v6)) findings.push(info('tf.mig.vsphere-ipv6', 'VMs without an IPv6 address in the grid get IPv6 from router advertisements, if the segment sends them.', { path: 'vms' }));
      return { files: { 'main.tf': mainTf(blocks, `VCF workload domain: ${valid.length} VM(s) cloned from templates`) }, findings };
    },
  };
}

export const MIGRATION_TERRAFORM_VSPHERE                       = [vsphereVms()];
