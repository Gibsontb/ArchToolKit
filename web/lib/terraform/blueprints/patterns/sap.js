/**
 * `<p>_app_sap_certified` (tier pattern `sap-certified`, addendum A.4.2 SAP,
 * A.4.4) and `azure_app_sap_acss`: the SAP landscape's VMs on certified
 * types with the SAP volume layout, ready for the `app_sap_preconfigure` play
 * and the `sap-hsr` / `sap-backup-restore` paths.
 *
 * Every row is a VM: a HANA database host gets /hana/data, /hana/log,
 * /hana/shared and /usr/sap volumes sized from its HANA memory; an ASCS host
 * /usr/sap and /sapmnt; an application server /usr/sap. The ratios are the
 * clouds' SAP storage guides' common starting point (data 1.2 × memory, log
 * 0.5 × memory up to 512 GiB, shared 1 × memory up to 1 TiB), kept as data
 * here and marked to verify against the guide of the cloud and the HANA size
 * (`SAP_VOLUME_RATIOS`). The certified sizes come from the SAP certified
 * table (kit/instance-specs.ts), offered as the Size dropdown.
 *
 * `azure_app_sap_acss` builds the same landscape as an Azure Center for SAP
 * solutions three-tier Virtual Instance instead (ACSS creates the VMs).
 */

import { error, info, warning,              } from '../../../core/findings.js';
                                                                                            
import { str as valueOf } from '../../../kit/blueprint.js';
import { sapHanaTypes } from '../../../kit/instance-specs.js';
                                             
import {
  LANDING_ZONE_SOURCE,
  attrs,
  blk,
  cellNumber,
  cloudInit,
  gridInput,
  hobj,
  ident,
  lzRef,
  output,
  parseGrid,
  q,
  res,
  rname,
  secretVariable,
  sshKeyVariable,
  uniqueNames,
  variable,
  withHost,
  x,
                  
                
} from '../migration/common.js';
import { NETWORK_INPUT, PATTERN_GROUP, appInputs, appOf, ipv6Of, namePrefix, patternMainTf, preamble, securityGroupOf, subnetOf, tagsExpr,              } from './common.js';

/** The SAP volume layout per role, GiB: `f(memory)`. Data from the clouds' SAP storage guides (verify per HANA size). */
export const SAP_VOLUME_RATIOS                                                                                                                                = {
  hana: [
    { mount: '/hana/data', gib: (m) => Math.ceil(m * 1.2) },
    { mount: '/hana/log', gib: (m) => Math.min(512, Math.ceil(m * 0.5)) },
    { mount: '/hana/shared', gib: (m) => Math.min(1024, m) },
    { mount: '/usr/sap', gib: () => 64 },
  ],
  ascs: [
    { mount: '/usr/sap', gib: () => 64 },
    { mount: '/sapmnt', gib: () => 128 },
  ],
  app: [{ mount: '/usr/sap', gib: () => 64 }],
};
export const SAP_STORAGE_SOURCES = {
  aws: 'https://docs.aws.amazon.com/sap/latest/sap-hana/hana-ops-storage-config.html',
  azure: 'https://learn.microsoft.com/en-us/azure/sap/workloads/hana-vm-premium-ssd-v2',
  google: 'https://cloud.google.com/solutions/sap/docs/sap-hana-planning-guide',
  oci: 'https://docs.oracle.com/en/solutions/deploy-sap-hana-oci/',
}         ;

const COLUMNS = (platform          )               => [
  { name: 'SID' },
  { name: 'Host' },
  { name: 'Role', options: ['hana', 'ascs', 'app'] },
  { name: 'Size', options: sapHanaTypes(platform).map((t) => ({ value: t.type, label: `${t.type} (${t.memoryGib} GiB)` })) },
  { name: 'HANA memory GiB' },
  { name: 'Zone', options: ['a', 'b', 'c'] },
];

const DEFAULT_SIZE                                                            = {
  aws: { hana: 'r7i.16xlarge', app: 'm7i.2xlarge' },
  azure: { hana: 'Standard_M64s', app: 'Standard_E8ds_v5' },
  google: { hana: 'm3-ultramem-32', app: 'n2-standard-8' },
  oci: { hana: 'VM.Standard.E4.Flex', app: 'VM.Standard.E5.Flex' },
};

function defaultRows(platform          )             {
  const hana = sapHanaTypes(platform).find((t) => t.memoryGib >= 512) ?? sapHanaTypes(platform)[0];
  const size = hana?.type ?? DEFAULT_SIZE[platform].hana;
  return [
    ['S4P', 's4phdb01', 'hana', size, String(hana?.memoryGib ?? 512), 'a'],
    ['S4P', 's4pascs01', 'ascs', DEFAULT_SIZE[platform].app, '', 'a'],
    ['S4P', 's4papp01', 'app', DEFAULT_SIZE[platform].app, '', 'a'],
  ];
}

                 
                       
                        
                       
                                         
                        
                          
                        
                                                                                                       
 

function parseSapRows(text        , platform          , findings           )          {
  const rows = uniqueNames(parseGrid(text, COLUMNS(platform).map((c) => c.name)), 'Host', 'landscape', findings);
  const certified = new Map(sapHanaTypes(platform).map((t) => [t.type, t]));
  return rows.map((r) => {
    const role = (r['Role'] ?? 'app').toLowerCase();
    const kind = role === 'hana' || role === 'ascs' ? role : 'app';
    const size = r['Size'] || (kind === 'hana' ? DEFAULT_SIZE[platform].hana : DEFAULT_SIZE[platform].app);
    const cert = certified.get(size);
    const memory = cellNumber(r['HANA memory GiB'], cert?.memoryGib ?? 256);
    if (kind === 'hana' && !cert) {
      findings.push(warning('tf.app.sap-not-certified', `${r['Host']}: ${size} is not in the SAP-certified list for this cloud; check SAP's certified hardware directory before ordering.`, { path: 'landscape', source: 'https://www.sap.com/dmc/exp/2014-09-02-hana-hardware/enEN/' }));
    } else if (kind === 'hana' && cert && cert.memoryGib < memory) {
      findings.push(error('tf.app.sap-too-small', `${r['Host']}: ${size} has ${cert.memoryGib} GiB, less than the ${memory} GiB of HANA memory.`, { path: 'landscape' }));
    }
    const host = rname(r['Host'] ?? '');
    return {
      sid: (r['SID'] || 'SID').toUpperCase().slice(0, 3),
      host,
      key: ident(host),
      role: kind,
      size,
      memory,
      zone: Math.max(0, ['a', 'b', 'c'].indexOf((r['Zone'] || 'a').toLowerCase())),
      volumes: SAP_VOLUME_RATIOS[kind].map((v) => ({ mount: v.mount, name: v.mount.replace(/^\//, '').replace(/\//g, '-'), gib: v.gib(memory) })),
    };
  });
}

function sapInputs(platform          )                   {
  const imageHint                           = {
    aws: 'An AMI id (SLES for SAP or RHEL for SAP, BYOS or marketplace); blank: a variable.',
    azure: 'publisher:offer:sku (SUSE:sles-sap-15-sp6:gen2 or RedHat:RHEL-SAP-HA:9_4).',
    google: 'project/family (suse-sap-cloud/sles-15-sp6-sap or rhel-sap-cloud/rhel-9-4-sap-ha).',
    oci: 'An image OCID (SLES / RHEL / Oracle Linux for SAP); blank: a variable.',
  };
  const imageDefault                           = { aws: '', azure: 'SUSE:sles-sap-15-sp6:gen2', google: 'suse-sap-cloud/sles-15-sp6-sap', oci: '' };
  return [
    ...appInputs(),
    NETWORK_INPUT,
    gridInput('landscape', 'Landscape', COLUMNS(platform), defaultRows(platform), 'One row per VM. Role hana gets the HANA volumes sized from its memory; ascs /usr/sap and /sapmnt; app /usr/sap.'),
    { id: 'image', label: 'OS image', control: 'text', default: imageDefault[platform], hint: imageHint[platform] },
    { id: 'ssh_public_key_var', label: 'SSH key variable', control: 'text', default: 'ssh_public_key', hint: 'The variable holding the ansible user\'s public key (the compute item\'s).' },
    LANDING_ZONE_SOURCE,
  ];
}

const tierOf = (vm       )         => (vm.role === 'hana' ? 'db' : 'app');

/** The user data every SAP VM boots with: the ansible user and python3, as the compute blueprints write it. */
function bootstrap(app         , keyVar        )                                     {
  const local = `sap_bootstrap_${app.id}`;
  return { local, block: { type: 'locals', attributes: [{ name: local, value: x(cloudInit(`var.${keyVar}`)) }] } };
}

function awsSap(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const vms = parseSapRows(valueOf(values, 'landscape'), 'aws', findings);
  const keyVar = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
  const boot = bootstrap(app, keyVar);
  const image = valueOf(values, 'image');
  const blocks             = [...preamble('aws', values), sshKeyVariable(keyVar), boot.block];
  if (!image) blocks.push(variable(`${app.id}_sap_image_id`, 'string', 'The AMI the SAP VMs boot from (SLES for SAP or RHEL for SAP).'));
  for (const vm of vms) {
    const tags = x(tagsExpr(app, 'aws', { Name: vm.host, atk_role: vm.role === 'hana' ? 'sap-hana' : `sap-${vm.role}`, atk_db: vm.role === 'hana' ? 'sap-hana' : '', atk_sap_sid: vm.sid }));
    blocks.push(
      res('aws_instance', vm.key, {
        ami: x(image ? q(image) : `var.${app.id}_sap_image_id`),
        instance_type: vm.size,
        subnet_id: x(`${lz}.zone_subnet_ids[${q(net)}][${vm.zone}]`),
        vpc_security_group_ids: x(`[${securityGroupOf(lz, net, tierOf(vm))}]`),
        iam_instance_profile: x(`${lz}.instance_profile`),
        ipv6_address_count: x(`${ipv6Of(lz, net)} ? 1 : 0`),
        ebs_optimized: true,
        disable_api_termination: app.criticality === 'tier0' || app.criticality === 'tier1',
        user_data: x(withHost(`local.${boot.local}`, q(vm.host))),
        tags,
      }, [
        blk('metadata_options', { http_tokens: 'required', http_endpoint: 'enabled' }),
        blk('root_block_device', { volume_type: 'gp3', volume_size: 64, encrypted: true, kms_key_id: x(`${lz}.kms_key_id`) }),
      ]),
    );
    vm.volumes.forEach((v, i) => {
      const id = ident(vm.key, v.name);
      const log = v.mount === '/hana/log';
      blocks.push(
        res('aws_ebs_volume', id, {
          availability_zone: x(`aws_instance.${vm.key}.availability_zone`),
          size: v.gib,
          type: 'gp3',
          iops: log || v.mount === '/hana/data' ? 3000 + Math.min(13000, v.gib * 4) : 3000,
          throughput: log ? 500 : v.mount === '/hana/data' ? Math.min(1000, 250 + v.gib) : 125,
          encrypted: true,
          kms_key_id: x(`${lz}.kms_key_id`),
          tags: x(tagsExpr(app, 'aws', { Name: `${vm.host}${v.mount}`, atk_mount: v.mount })),
        }),
        res('aws_volume_attachment', id, { device_name: `/dev/sd${'fghijklm'[i]}`, volume_id: x(`aws_ebs_volume.${id}.id`), instance_id: x(`aws_instance.${vm.key}.id`) }),
      );
    });
  }
  blocks.push(output('hosts', hobj(Object.fromEntries(vms.map((v) => [v.host, `aws_instance.${v.key}.private_ip`])))));
  return blocks;
}

function azureSap(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const rg = `${lz}.resource_group[${q(net)}]`;
  const vms = parseSapRows(valueOf(values, 'landscape'), 'azure', findings);
  const keyVar = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
  const boot = bootstrap(app, keyVar);
  const [publisher = 'SUSE', offer = 'sles-sap-15-sp6', sku = 'gen2'] = valueOf(values, 'image', 'SUSE:sles-sap-15-sp6:gen2').split(':');
  const blocks             = [...preamble('azure', values), sshKeyVariable(keyVar), boot.block];
  for (const vm of vms) {
    const tags = x(tagsExpr(app, 'azure', { atk_role: vm.role === 'hana' ? 'sap-hana' : `sap-${vm.role}`, atk_db: vm.role === 'hana' ? 'sap-hana' : '', atk_sap_sid: vm.sid }));
    const subnet = subnetOf(lz, net, tierOf(vm));
    blocks.push(
      res('azurerm_network_interface', vm.key, {
        name: x(`"${pfx}-${vm.host}-nic"`),
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        accelerated_networking_enabled: true,
        tags,
      }, [
        blk('ip_configuration', { name: 'ipv4', subnet_id: x(subnet), private_ip_address_allocation: 'Dynamic', private_ip_address_version: 'IPv4', primary: true }),
        { type: 'dynamic', labels: ['ip_configuration'], attributes: attrs({ for_each: x(`${ipv6Of(lz, net)} ? ["ipv6"] : []`) }), blocks: [blk('content', { name: 'ipv6', subnet_id: x(subnet), private_ip_address_allocation: 'Dynamic', private_ip_address_version: 'IPv6' })] },
      ]),
      res('azurerm_network_interface_security_group_association', vm.key, { network_interface_id: x(`azurerm_network_interface.${vm.key}.id`), network_security_group_id: x(securityGroupOf(lz, net, tierOf(vm))) }),
      res('azurerm_linux_virtual_machine', vm.key, {
        name: vm.host,
        computer_name: vm.host,
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        size: vm.size,
        zone: x(`${lz}.zones[${vm.zone}]`),
        admin_username: 'azureadmin',
        disable_password_authentication: true,
        network_interface_ids: x(`[azurerm_network_interface.${vm.key}.id]`),
        custom_data: x(`base64encode(${withHost(`local.${boot.local}`, q(vm.host))})`),
        tags,
      }, [
        blk('admin_ssh_key', { username: 'azureadmin', public_key: x(`var.${keyVar}`) }),
        blk('os_disk', { caching: 'ReadWrite', storage_account_type: 'Premium_LRS', disk_size_gb: 64, disk_encryption_set_id: x(`${lz}.kms_key_id`) }),
        blk('source_image_reference', { publisher, offer, sku, version: 'latest' }),
        blk('identity', { type: 'UserAssigned', identity_ids: x(`[${lz}.identity_id]`) }),
        blk('boot_diagnostics', {}),
      ]),
    );
    vm.volumes.forEach((v, i) => {
      const id = ident(vm.key, v.name);
      const hot = v.mount === '/hana/data' || v.mount === '/hana/log';
      blocks.push(
        res('azurerm_managed_disk', id, {
          name: x(`"${pfx}-${vm.host}-${v.name}"`),
          resource_group_name: x(rg),
          location: x(`${lz}.location`),
          zone: x(`${lz}.zones[${vm.zone}]`),
          storage_account_type: hot ? 'PremiumV2_LRS' : 'Premium_LRS',
          create_option: 'Empty',
          disk_size_gb: v.gib,
          disk_iops_read_write: hot ? (v.mount === '/hana/log' ? 3000 : Math.max(3000, Math.min(80000, v.gib * 3))) : undefined,
          disk_mbps_read_write: hot ? (v.mount === '/hana/log' ? 275 : Math.max(425, Math.min(1200, v.gib))) : undefined,
          disk_encryption_set_id: x(`${lz}.kms_key_id`),
          tags,
        }),
        res('azurerm_virtual_machine_data_disk_attachment', id, { managed_disk_id: x(`azurerm_managed_disk.${id}.id`), virtual_machine_id: x(`azurerm_linux_virtual_machine.${vm.key}.id`), lun: i, caching: 'None' }),
      );
    });
  }
  findings.push(info('tf.app.sap-azure-pv2', 'HANA data and log are Premium SSD v2 (IOPS and throughput set per disk): the VM size and region must support it; Azure NetApp Files volume groups are the alternative for large systems.', { source: SAP_STORAGE_SOURCES.azure }));
  blocks.push(output('hosts', hobj(Object.fromEntries(vms.map((v) => [v.host, `azurerm_linux_virtual_machine.${v.key}.private_ip_address`])))));
  return blocks;
}

function googleSap(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const project = `${lz}.project`;
  const vms = parseSapRows(valueOf(values, 'landscape'), 'google', findings);
  const keyVar = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
  const boot = bootstrap(app, keyVar);
  const [imgProject = 'suse-sap-cloud', family = 'sles-15-sp6-sap'] = valueOf(values, 'image', 'suse-sap-cloud/sles-15-sp6-sap').split('/');
  const blocks             = [...preamble('google', values), sshKeyVariable(keyVar), boot.block];
  for (const vm of vms) {
    const labels = x(tagsExpr(app, 'google', { atk_role: vm.role === 'hana' ? 'sap-hana' : `sap-${vm.role}`, atk_db: vm.role === 'hana' ? 'sap-hana' : '', atk_sap_sid: vm.sid.toLowerCase() }));
    for (const v of vm.volumes) {
      blocks.push(
        res('google_compute_disk', ident(vm.key, v.name), {
          name: x(`"${pfx}-${vm.host}-${v.name}"`),
          project: x(project),
          zone: x(`${lz}.zones[${vm.zone}]`),
          type: 'hyperdisk-balanced',
          size: v.gib,
          provisioned_iops: v.mount === '/hana/data' || v.mount === '/hana/log' ? Math.max(3000, Math.min(160000, v.gib * 10)) : undefined,
          provisioned_throughput: v.mount === '/hana/data' || v.mount === '/hana/log' ? Math.max(400, Math.min(2400, v.gib)) : undefined,
          labels,
        }),
      );
    }
    blocks.push(
      res('google_compute_instance', vm.key, {
        name: vm.host,
        project: x(project),
        zone: x(`${lz}.zones[${vm.zone}]`),
        machine_type: vm.size,
        can_ip_forward: false,
        deletion_protection: app.criticality === 'tier0' || app.criticality === 'tier1',
        tags: x(`[${securityGroupOf(lz, net, tierOf(vm))}]`),
        labels,
        metadata: x(`{\n    "user-data" = ${withHost(`local.${boot.local}`, q(vm.host))}\n    "ssh-keys"  = "ansible:\${var.${keyVar}}"\n  }`),
      }, [
        blk('boot_disk', {}, [blk('initialize_params', { image: `${imgProject}/${family}`, size: 64, type: 'hyperdisk-balanced' })]),
        ...vm.volumes.map((v) => blk('attached_disk', { source: x(`google_compute_disk.${ident(vm.key, v.name)}.id`), device_name: v.name })),
        blk('network_interface', { subnetwork: x(subnetOf(lz, net, tierOf(vm))), stack_type: x(`${ipv6Of(lz, net)} ? "IPV4_IPV6" : "IPV4_ONLY"`), nic_type: 'GVNIC' }),
        blk('service_account', { email: x(`${lz}.service_account`), scopes: ['cloud-platform'] }),
        blk('scheduling', { on_host_maintenance: 'MIGRATE', automatic_restart: true }),
        blk('shielded_instance_config', { enable_secure_boot: true }),
      ]),
    );
  }
  findings.push(info('tf.app.sap-gcp-hyperdisk', 'HANA volumes are Hyperdisk Balanced with provisioned IOPS and throughput: the machine types (M3, X4) and the zone must support it; the SAP guide lists the minimums per memory size.', { source: SAP_STORAGE_SOURCES.google }));
  blocks.push(output('hosts', hobj(Object.fromEntries(vms.map((v) => [v.host, `google_compute_instance.${v.key}.network_interface[0].network_ip`])))));
  return blocks;
}

function ociSap(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const comp = `${lz}.compartment_id`;
  const vms = parseSapRows(valueOf(values, 'landscape'), 'oci', findings);
  const keyVar = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
  const boot = bootstrap(app, keyVar);
  const image = valueOf(values, 'image');
  const blocks             = [...preamble('oci', values), sshKeyVariable(keyVar), boot.block];
  if (!image) blocks.push(variable(`${app.id}_sap_image_id`, 'string', 'The OCID of the image the SAP VMs boot from.'));
  const certified = new Map(sapHanaTypes('oci').map((t) => [t.type, t]));
  for (const vm of vms) {
    const tags = x(tagsExpr(app, 'oci', { atk_role: vm.role === 'hana' ? 'sap-hana' : `sap-${vm.role}`, atk_db: vm.role === 'hana' ? 'sap-hana' : '', atk_sap_sid: vm.sid }));
    const flex = /\.Flex$/.test(vm.size);
    const cert = certified.get(vm.size);
    const ocpus = cert ? Math.max(1, Math.round(cert.vcpu / 2)) : vm.role === 'hana' ? 32 : 4;
    const memory = cert ? cert.memoryGib : vm.role === 'hana' ? Math.max(256, vm.memory) : 64;
    blocks.push(
      res('oci_core_instance', vm.key, {
        compartment_id: x(comp),
        availability_domain: x(`${lz}.zones[min(${vm.zone}, length(${lz}.zones) - 1)]`),
        display_name: vm.host,
        shape: vm.size,
        freeform_tags: tags,
        metadata: x(`{\n    ssh_authorized_keys = var.${keyVar}\n    user_data           = base64encode(${withHost(`local.${boot.local}`, q(vm.host))})\n  }`),
      }, [
        ...(flex ? [blk('shape_config', { ocpus, memory_in_gbs: memory })] : []),
        blk('source_details', { source_type: 'image', source_id: x(image ? q(image) : `var.${app.id}_sap_image_id`), boot_volume_size_in_gbs: 64, kms_key_id: x(`${lz}.kms_key_id`) }),
        blk('create_vnic_details', { subnet_id: x(subnetOf(lz, net, tierOf(vm))), nsg_ids: x(`[${securityGroupOf(lz, net, tierOf(vm))}]`), assign_public_ip: false, assign_ipv6ip: x(ipv6Of(lz, net)), hostname_label: vm.host.replace(/-/g, '').slice(0, 63) }),
      ]),
    );
    for (const v of vm.volumes) {
      const id = ident(vm.key, v.name);
      blocks.push(
        res('oci_core_volume', id, {
          compartment_id: x(comp),
          availability_domain: x(`oci_core_instance.${vm.key}.availability_domain`),
          display_name: x(`"${pfx}-${vm.host}-${v.name}"`),
          size_in_gbs: Math.max(50, v.gib),
          vpus_per_gb: v.mount === '/hana/data' || v.mount === '/hana/log' ? 20 : 10,
          kms_key_id: x(`${lz}.kms_key_id`),
          freeform_tags: tags,
        }),
        res('oci_core_volume_attachment', id, { attachment_type: 'paravirtualized', instance_id: x(`oci_core_instance.${vm.key}.id`), volume_id: x(`oci_core_volume.${id}.id`), is_pv_encryption_in_transit_enabled: true }),
      );
    }
  }
  findings.push(info('tf.app.sap-oci-shapes', 'OCI\'s SAP-certified shapes are not confirmed from an Oracle page here [U]: check the SAP certified directory for the shape before ordering.', { source: 'https://www.sap.com/dmc/exp/2014-09-02-hana-hardware/enEN/' }));
  blocks.push(output('hosts', hobj(Object.fromEntries(vms.map((v) => [v.host, `oci_core_instance.${v.key}.private_ip`])))));
  return blocks;
}

// ---------------------------------------------------------------------------
// Azure Center for SAP solutions (ACSS)
// ---------------------------------------------------------------------------

function acssInputs()                   {
  const sizes = sapHanaTypes('azure').map((t) => ({ value: t.type, label: `${t.type} (${t.memoryGib} GiB)` }));
  return [
    ...appInputs(),
    NETWORK_INPUT,
    { id: 'sid', label: 'SID', control: 'text', default: 'S4P' },
    { id: 'product', label: 'SAP product', control: 'select', default: 'S4HANA', options: [{ value: 'S4HANA', label: 'S/4HANA' }, { value: 'ECC', label: 'ECC' }, { value: 'Other', label: 'Other' }] },
    { id: 'environment', label: 'Environment', control: 'select', default: 'Prod', options: [{ value: 'Prod', label: 'Production' }, { value: 'NonProd', label: 'Non-production' }] },
    { id: 'db_size', label: 'HANA VM size', control: 'combo', default: sizes.find((s) => /M64s$/.test(s.value))?.value ?? sizes[0]?.value ?? 'Standard_M64s', options: sizes },
    { id: 'app_size', label: 'Application server size', control: 'combo', default: 'Standard_E8ds_v5', options: ['Standard_E4ds_v5', 'Standard_E8ds_v5', 'Standard_E16ds_v5'].map((v) => ({ value: v, label: v })) },
    { id: 'app_servers', label: 'Application servers', control: 'number', default: 2, min: 1, max: 10 },
    { id: 'image', label: 'OS image', control: 'text', default: 'SUSE:sles-sap-15-sp6:gen2', hint: 'publisher:offer:sku (SUSE or RedHat).' },
    { id: 'sap_fqdn', label: 'SAP domain', control: 'text', default: 'sap.corp.example.com' },
    { id: 'ssh_public_key_var', label: 'SSH key variable', control: 'text', default: 'ssh_public_key' },
    LANDING_ZONE_SOURCE,
  ];
}

function azureAcss(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const net = rname(valueOf(values, 'network', 'prod'));
  const keyVar = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
  const [publisher = 'SUSE', offer = 'sles-sap-15-sp6', sku = 'gen2'] = valueOf(values, 'image', 'SUSE:sles-sap-15-sp6:gen2').split(':');
  if (publisher !== 'SUSE' && publisher !== 'RedHat') findings.push(error('tf.app.acss-image', `ACSS takes SUSE or RedHat images, not ${publisher}.`, { path: 'image' }));
  const privateVar = `${app.id}_acss_ssh_private_key`;
  const vmConfig = (size        ) =>
    blk('virtual_machine_configuration', { virtual_machine_size: size }, [
      blk('image', { publisher, offer, sku, version: 'latest' }),
      blk('os_profile', { admin_username: 'azureadmin', ssh_public_key: x(`var.${keyVar}`), ssh_private_key: x(`var.${privateVar}`) }),
    ]);
  const sid = valueOf(values, 'sid', 'S4P').toUpperCase().slice(0, 3);
  findings.push(info('tf.app.acss', 'ACSS deploys the infrastructure (and can install SAP): its identity needs Contributor on the app resource group and the subnets; the SAP software itself is installed by ACSS or by SWPM, not Terraform.', { source: 'https://learn.microsoft.com/en-us/azure/sap/center-sap-solutions/deploy-s4hana' }));
  return [
    ...preamble('azure', values),
    sshKeyVariable(keyVar),
    secretVariable(privateVar, 'The private key of the SSH key pair ACSS uses to reach the VMs it creates (the provider requires it; it is kept in state, marked sensitive).'),
    res('azurerm_workloads_sap_three_tier_virtual_instance', 'app', {
      name: sid,
      resource_group_name: x(`${lz}.resource_group[${q(net)}]`),
      location: x(`${lz}.location`),
      environment: valueOf(values, 'environment', 'Prod'),
      sap_product: valueOf(values, 'product', 'S4HANA'),
      app_location: x(`${lz}.location`),
      sap_fqdn: valueOf(values, 'sap_fqdn', 'sap.corp.example.com'),
      tags: x(tagsExpr(app, 'azure', { atk_sap_sid: sid })),
    }, [
      blk('three_tier_configuration', { app_resource_group_name: x(`"\${${lz}.prefix}-${app.slug}-sap-${sid.toLowerCase()}"`) }, [
        blk('application_server_configuration', { instance_count: Number(valueOf(values, 'app_servers', '2')) || 2, subnet_id: x(subnetOf(lz, net, 'app')) }, [vmConfig(valueOf(values, 'app_size', 'Standard_E8ds_v5'))]),
        blk('central_server_configuration', { instance_count: 1, subnet_id: x(subnetOf(lz, net, 'app')) }, [vmConfig(valueOf(values, 'app_size', 'Standard_E8ds_v5'))]),
        blk('database_server_configuration', { instance_count: 1, subnet_id: x(subnetOf(lz, net, 'db')), database_type: 'HANA' }, [vmConfig(valueOf(values, 'db_size', 'Standard_M64s'))]),
      ]),
      blk('identity', { type: 'UserAssigned', identity_ids: x(`[${lz}.identity_id]`) }),
    ]),
    output('sap_virtual_instance_id', 'azurerm_workloads_sap_three_tier_virtual_instance.app.id'),
  ];
}

// ---------------------------------------------------------------------------

const EMITS                                                = {
  aws: ['aws_instance', 'aws_ebs_volume', 'aws_volume_attachment'],
  azure: ['azurerm_network_interface', 'azurerm_network_interface_security_group_association', 'azurerm_linux_virtual_machine', 'azurerm_managed_disk', 'azurerm_virtual_machine_data_disk_attachment'],
  google: ['google_compute_disk', 'google_compute_instance'],
  oci: ['oci_core_instance', 'oci_core_volume', 'oci_core_volume_attachment'],
};
const CLOUD                                     = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud (GCP)', oci: 'OCI' };

function sap(platform          )            {
  return {
    id: `${platform}_app_sap_certified`,
    label: 'App SAP landscape (certified VMs and volume layout)',
    group: PATTERN_GROUP,
    description: `The SAP landscape's VMs on ${CLOUD[platform]}: HANA hosts on SAP-certified types with /hana/data, /hana/log, /hana/shared and /usr/sap volumes sized from the HANA memory, ASCS and application servers with /usr/sap (and /sapmnt), dual-stack where the network is, tagged for the SAP plays and paths.`,
    inputs: sapInputs(platform),
    emits: EMITS[platform],
    build: (values                 ) => {
      const findings            = [];
      const blocks = platform === 'aws' ? awsSap(values, findings) : platform === 'azure' ? azureSap(values, findings) : platform === 'google' ? googleSap(values, findings) : ociSap(values, findings);
      findings.push(info('tf.app.sap-ratios', 'The HANA volume sizes use the common starting ratios (data 1.2 × memory, log 0.5 × memory up to 512 GiB, shared 1 × memory up to 1 TiB): check them against the cloud\'s SAP storage guide for the size (verify).', { source: SAP_STORAGE_SOURCES[platform] }));
      return { files: { 'main.tf': patternMainTf(blocks, `${CLOUD[platform]} SAP landscape: ${appOf(values).name}`) }, findings };
    },
  };
}

const ACSS            = {
  id: 'azure_app_sap_acss',
  label: 'App SAP on Azure Center for SAP solutions',
  group: PATTERN_GROUP,
  description: 'An ACSS three-tier SAP Virtual Instance (application servers, ASCS, HANA database) in the landing zone\'s subnets, with the landing zone\'s identity; ACSS creates the VMs and their SAP layout.',
  inputs: acssInputs(),
  emits: ['azurerm_workloads_sap_three_tier_virtual_instance'],
  build: (values                 ) => {
    const findings            = [];
    const blocks = azureAcss(values, findings);
    return { files: { 'main.tf': patternMainTf(blocks, `Azure Center for SAP solutions: ${appOf(values).name}`) }, findings };
  },
};

export const SAP_BLUEPRINTS                       = [...(['aws', 'azure', 'google', 'oci']         ).map(sap), ACSS];
