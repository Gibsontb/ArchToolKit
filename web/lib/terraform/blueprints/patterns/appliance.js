/**
 * `<p>_app_appliance` (tier pattern `appliance`, addendum A.4.2 Appliances):
 * a vendor network appliance (F5 BIG-IP, Palo Alto VM-Series, FortiGate, Check
 * Point CloudGuard, Cisco Catalyst 8000V) rebuilt from the platform's
 * marketplace image, with a NIC per tier and IP forwarding on, one or an HA
 * pair across zones. The `appliance-rebuild` path then moves the
 * configuration, not the VM (UCS / AS3, Panorama, FortiManager, Check Point
 * migrate_server, running-config); the device configuration itself is the
 * toolkit's Network page's.
 *
 *   AWS     the AMI of the vendor's Marketplace product code, an ENI per extra
 *           tier (source/destination check off), IMDSv2
 *   Azure   the Marketplace terms accepted (azurerm_marketplace_agreement), a
 *           VM with the image's plan, NICs with IP forwarding
 *   Google  the vendor's public image, can_ip_forward, one NIC (Google Cloud
 *           puts each NIC in a different VPC network)
 *   OCI     the Marketplace listing's terms and subscription, the image of the
 *           listing version, a VNIC per extra tier (skip source/dest check)
 *   VCF     the vendor OVA deployed from its URL (ovf_deploy) to the port groups
 *
 * The image references are the vendor's and change with every release and
 * licence: the defaults are left as variables (or marked to verify), never
 * guessed. The admin access is the SSH key; no password is written.
 */

import { info, warning,              } from '../../../core/findings.js';
                                                                                            
import { str as valueOf } from '../../../kit/blueprint.js';
                                             
import { LANDING_ZONE_SOURCE, attrs, blk, dat, ident, lzRef, output, q, res, rname, sshKeyVariable, variable, x } from '../migration/common.js';
import {
  NETWORK_INPUT,
  PATTERN_GROUP,
  VSPHERE_SERVER_INPUT,
  appInputs,
  appOf,
  ipv6Of,
  listOf,
  namePrefix,
  patternMainTf,
  preamble,
  securityGroupOf,
  subnetOf,
  tagsExpr,
  vsphereProvider,
                       
} from './common.js';

export const VENDORS = [
  { value: 'f5', label: 'F5 BIG-IP Virtual Edition' },
  { value: 'paloalto', label: 'Palo Alto Networks VM-Series' },
  { value: 'fortinet', label: 'Fortinet FortiGate-VM' },
  { value: 'checkpoint', label: 'Check Point CloudGuard Network Security' },
  { value: 'cisco', label: 'Cisco Catalyst 8000V' },
]         ;
                                                

/** Azure Marketplace starting points per vendor (publisher:offer:sku, BYOL). They change per release: verify in the Marketplace. */
const AZURE_IMAGES                                   = {
  f5: 'f5-networks:f5-big-ip-byol:f5-big-ltm-2slot-byol',
  paloalto: 'paloaltonetworks:vmseries-flex:byol',
  fortinet: 'fortinet:fortinet_fortigate-vm_v5:fortinet_fg-vm',
  checkpoint: 'checkpoint:check-point-cg-r8120:sg-byol',
  cisco: 'cisco:cisco-c8000v-byol:17_15_01a-byol',
};

const SIZES                                                       = {
  aws: ['m7i.xlarge', 'c7i.xlarge', 'c7i.2xlarge', 'm5.xlarge'],
  azure: ['Standard_D4s_v5', 'Standard_D8s_v5', 'Standard_F8s_v2', 'Standard_DS3_v2'],
  google: ['n2-standard-4', 'n2-standard-8', 'c3-standard-4'],
  oci: ['VM.Standard.E5.Flex:2', 'VM.Standard.E5.Flex:4', 'VM.Standard3.Flex:4'],
  vsphere: ['4:16', '8:32', '16:64'],
};

function applianceInputs(platform                 )                   {
  return [
    ...appInputs(),
    ...(platform === 'vsphere' ? [VSPHERE_SERVER_INPUT] : [NETWORK_INPUT]),
    { id: 'vendor', label: 'Vendor', control: 'select', default: 'f5', options: [...VENDORS] },
    { id: 'size', label: platform === 'vsphere' ? 'vCPU:GiB' : 'Size', control: 'combo', default: SIZES[platform][0] , options: SIZES[platform].map((v) => ({ value: v, label: v })) },
    { id: 'licence', label: 'Licence', control: 'select', default: 'byol', options: [{ value: 'byol', label: 'Bring your own licence' }, { value: 'payg', label: 'Pay as you go (marketplace)' }] },
    { id: 'ha', label: 'HA pair', control: 'select', default: 'yes', options: [{ value: 'yes', label: 'Two instances across zones' }, { value: 'no', label: 'One instance' }] },
    {
      id: 'interfaces',
      label: platform === 'vsphere' ? 'Port groups' : 'Interfaces (tiers)',
      control: 'text',
      default: platform === 'vsphere' ? 'wld01-mgmt wld01-web wld01-app' : 'mgmt web app',
      hint: platform === 'vsphere' ? 'Space-separated; the first is management.' : 'Space-separated landing-zone tiers, one NIC each; the first is management.',
    },
    ...(platform === 'aws'
      ? [{ id: 'product_code', label: 'Marketplace product code', control: 'text'         , default: '', hint: 'The AWS Marketplace product code of the vendor\'s AMI (per licence and version); blank: a variable.' }]
      : platform === 'azure'
        ? [{ id: 'image', label: 'Marketplace image', control: 'text'         , default: '', hint: 'publisher:offer:sku (blank: the vendor\'s BYOL starting point, to verify).' }]
        : platform === 'google'
          ? [{ id: 'image', label: 'Image', control: 'text'         , default: '', hint: 'projects/<vendor project>/global/images/<image> from the vendor\'s listing; blank: a variable.' }]
          : platform === 'oci'
            ? [
                { id: 'listing_id', label: 'Marketplace listing OCID', control: 'text'         , default: '', hint: 'Blank: a variable.' },
                { id: 'listing_version', label: 'Listing version', control: 'text'         , default: '', hint: 'The listing resource version; blank: a variable.' },
              ]
            : [
                { id: 'ova_url', label: 'OVA URL', control: 'text'         , default: '', hint: 'Where the vendor OVA is served from (a content library item URL or an internal web server); blank: a variable.' },
                { id: 'datacenter', label: 'Datacenter', control: 'text'         , default: 'wld01-dc' },
                { id: 'cluster', label: 'Cluster', control: 'text'         , default: 'wld01-cl01' },
                { id: 'datastore', label: 'Datastore', control: 'text'         , default: 'wld01-cl01-ds-vsan01' },
              ]),
    ...(platform === 'vsphere' ? [] : [{ id: 'ssh_public_key_var', label: 'SSH key variable', control: 'text'         , default: 'ssh_public_key' }, LANDING_ZONE_SOURCE]),
  ];
}

                
                          
                         
                                    
                        
 
function specOf(values                 , fallback        )       {
  const vendor = (VENDORS.map((v) => v.value)                     ).includes(valueOf(values, 'vendor', 'f5')) ? (valueOf(values, 'vendor', 'f5')          ) : 'f5';
  const tiers = listOf(values, 'interfaces', fallback);
  return { vendor, count: valueOf(values, 'ha', 'yes') === 'yes' ? 2 : 1, tiers: tiers.length > 0 ? tiers : fallback.split(' '), size: valueOf(values, 'size', '') };
}
const vendorLabel = (v        )         => VENDORS.find((x0) => x0.value === v)?.label ?? v;

function common(values                 , findings           , s      )       {
  findings.push(info('tf.app.appliance-config', `${vendorLabel(s.vendor)}: the configuration moves by the vendor's own export and import (the appliance-rebuild path) and the device configuration is the Network page's; licences are re-issued for the new instances (${valueOf(values, 'licence', 'byol') === 'byol' ? 'BYOL' : 'PAYG through the marketplace'}).`, { source: 'https://docs.aws.amazon.com/marketplace/latest/buyerguide/buyer-finding-and-subscribing-to-ami-products.html' }));
}

function awsAppliance(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const s = specOf(values, 'mgmt web app');
  common(values, findings, s);
  const key = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
  const code = valueOf(values, 'product_code');
  const blocks             = [...preamble('aws', values), sshKeyVariable(key)];
  if (!code) blocks.push(variable(`${app.id}_appliance_product_code`, 'string', `The AWS Marketplace product code of the ${vendorLabel(s.vendor)} AMI.`));
  blocks.push(
    dat('aws_ami', 'appliance', { most_recent: true, owners: ['aws-marketplace'] }, [blk('filter', { name: 'product-code', values: x(`[${code ? q(code) : `var.${app.id}_appliance_product_code`}]`) })]),
    res('aws_key_pair', 'appliance', { key_name: x(`"${pfx}-appliance"`), public_key: x(`var.${key}`) }),
  );
  const [first = 'mgmt', ...rest] = s.tiers;
  for (let i = 0; i < s.count; i++) {
    const tags = x(tagsExpr(app, 'aws', { Name: `${app.slug}-${s.vendor}-${i + 1}`, atk_role: `appliance-${s.vendor}` }));
    const id = `appliance_${i + 1}`;
    blocks.push(
      res('aws_instance', id, {
        ami: x('data.aws_ami.appliance.id'),
        instance_type: s.size || 'm7i.xlarge',
        subnet_id: x(`${lz}.subnet_ids[${q(`${net}/${first}/${'abc'[i]}`)}]`),
        vpc_security_group_ids: x(`[${securityGroupOf(lz, net, first)}]`),
        key_name: x('aws_key_pair.appliance.key_name'),
        source_dest_check: false,
        ipv6_address_count: x(`${ipv6Of(lz, net)} ? 1 : 0`),
        disable_api_termination: true,
        tags,
      }, [blk('metadata_options', { http_tokens: 'required', http_endpoint: 'enabled' }), blk('root_block_device', { encrypted: true, kms_key_id: x(`${lz}.kms_key_id`) })]),
    );
    rest.forEach((tier, j) => {
      const nic = `${id}_${ident(tier)}`;
      blocks.push(
        res('aws_network_interface', nic, {
          subnet_id: x(`${lz}.subnet_ids[${q(`${net}/${tier}/${'abc'[i]}`)}]`),
          security_groups: x(`[${securityGroupOf(lz, net, tier)}]`),
          source_dest_check: false,
          ipv6_address_count: x(`${ipv6Of(lz, net)} ? 1 : 0`),
          tags,
        }),
        res('aws_network_interface_attachment', nic, { instance_id: x(`aws_instance.${id}.id`), network_interface_id: x(`aws_network_interface.${nic}.id`), device_index: j + 1 }),
      );
    });
  }
  blocks.push(output('management_addresses', `[${Array.from({ length: s.count }, (_, i) => `aws_instance.appliance_${i + 1}.private_ip`).join(', ')}]`));
  return blocks;
}

function azureAppliance(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const rg = `${lz}.resource_group[${q(net)}]`;
  const s = specOf(values, 'mgmt web app');
  common(values, findings, s);
  const key = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
  const imageText = valueOf(values, 'image') || AZURE_IMAGES[s.vendor];
  if (!valueOf(values, 'image')) findings.push(warning('tf.app.appliance-azure-image', `${imageText} is the vendor's BYOL starting point: check the offer and SKU (and the version the licence covers) in the Azure Marketplace before applying.`, { path: 'image' }));
  const [publisher = '', offer = '', sku = ''] = imageText.split(':');
  const blocks             = [
    ...preamble('azure', values),
    sshKeyVariable(key),
    res('azurerm_marketplace_agreement', 'appliance', { publisher, offer, plan: sku }, [], 'Accepts the Marketplace terms of the image for the subscription (once).'),
  ];
  for (let i = 0; i < s.count; i++) {
    const tags = x(tagsExpr(app, 'azure', { atk_role: `appliance-${s.vendor}` }));
    const id = `appliance_${i + 1}`;
    const nics = s.tiers.map((tier) => `${id}_${ident(tier)}`);
    s.tiers.forEach((tier, j) => {
      blocks.push(
        res('azurerm_network_interface', nics[j] , {
          name: x(`"${pfx}-${s.vendor}-${i + 1}-${rname(tier)}"`),
          resource_group_name: x(rg),
          location: x(`${lz}.location`),
          ip_forwarding_enabled: true,
          accelerated_networking_enabled: true,
          tags,
        }, [
          blk('ip_configuration', { name: 'ipv4', subnet_id: x(subnetOf(lz, net, tier)), private_ip_address_allocation: 'Dynamic', private_ip_address_version: 'IPv4', primary: true }),
          { type: 'dynamic', labels: ['ip_configuration'], attributes: attrs({ for_each: x(`${ipv6Of(lz, net)} ? ["ipv6"] : []`) }), blocks: [blk('content', { name: 'ipv6', subnet_id: x(subnetOf(lz, net, tier)), private_ip_address_allocation: 'Dynamic', private_ip_address_version: 'IPv6' })] },
        ]),
        res('azurerm_network_interface_security_group_association', nics[j] , { network_interface_id: x(`azurerm_network_interface.${nics[j]}.id`), network_security_group_id: x(securityGroupOf(lz, net, tier)) }),
      );
    });
    blocks.push(
      res('azurerm_linux_virtual_machine', id, {
        name: x(`"${pfx}-${s.vendor}-${i + 1}"`),
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        size: s.size || 'Standard_D4s_v5',
        zone: x(`${lz}.zones[${i}]`),
        admin_username: 'azureuser',
        disable_password_authentication: true,
        network_interface_ids: x(`[${nics.map((n) => `azurerm_network_interface.${n}.id`).join(', ')}]`),
        tags,
        depends_on: x('[azurerm_marketplace_agreement.appliance]'),
      }, [
        blk('admin_ssh_key', { username: 'azureuser', public_key: x(`var.${key}`) }),
        blk('os_disk', { caching: 'ReadWrite', storage_account_type: 'Premium_LRS', disk_encryption_set_id: x(`${lz}.kms_key_id`) }),
        blk('source_image_reference', { publisher, offer, sku, version: 'latest' }),
        blk('plan', { publisher, product: offer, name: sku }),
        blk('boot_diagnostics', {}),
      ]),
    );
  }
  blocks.push(output('management_addresses', `[${Array.from({ length: s.count }, (_, i) => `azurerm_linux_virtual_machine.appliance_${i + 1}.private_ip_address`).join(', ')}]`));
  return blocks;
}

function googleAppliance(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const s = specOf(values, 'mgmt web app');
  common(values, findings, s);
  if (s.tiers.length > 1) findings.push(info('tf.app.appliance-gcp-nics', 'Google Cloud puts each NIC of a VM in a different VPC network: the appliance has one NIC in the first tier here; a multi-NIC design needs a VPC per interface (a landing-zone change).', { source: 'https://cloud.google.com/vpc/docs/multiple-interfaces-concepts' }));
  const key = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
  const image = valueOf(values, 'image');
  const blocks             = [...preamble('google', values), sshKeyVariable(key)];
  if (!image) blocks.push(variable(`${app.id}_appliance_image`, 'string', `The ${vendorLabel(s.vendor)} image (projects/<project>/global/images/<image>) from the vendor's listing.`));
  const tier = s.tiers[0] ?? 'mgmt';
  for (let i = 0; i < s.count; i++) {
    blocks.push(
      res('google_compute_instance', `appliance_${i + 1}`, {
        name: x(`"${pfx}-${s.vendor}-${i + 1}"`),
        project: x(`${lz}.project`),
        zone: x(`${lz}.zones[${i}]`),
        machine_type: s.size || 'n2-standard-4',
        can_ip_forward: true,
        deletion_protection: true,
        tags: x(`[${securityGroupOf(lz, net, tier)}]`),
        labels: x(tagsExpr(app, 'google', { atk_role: `appliance-${s.vendor}` })),
        metadata: x(`{ "ssh-keys" = "admin:\${var.${key}}" }`),
      }, [
        blk('boot_disk', {}, [blk('initialize_params', { image: x(image ? q(image) : `var.${app.id}_appliance_image`), size: 80 })]),
        blk('network_interface', { subnetwork: x(subnetOf(lz, net, tier)), stack_type: x(`${ipv6Of(lz, net)} ? "IPV4_IPV6" : "IPV4_ONLY"`) }),
        blk('service_account', { email: x(`${lz}.service_account`), scopes: ['cloud-platform'] }),
        blk('shielded_instance_config', { enable_secure_boot: false }),
      ]),
    );
  }
  blocks.push(output('management_addresses', `[${Array.from({ length: s.count }, (_, i) => `google_compute_instance.appliance_${i + 1}.network_interface[0].network_ip`).join(', ')}]`));
  return blocks;
}

function ociAppliance(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const comp = `${lz}.compartment_id`;
  const s = specOf(values, 'mgmt web app');
  common(values, findings, s);
  const key = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
  const listing = valueOf(values, 'listing_id');
  const version = valueOf(values, 'listing_version');
  const blocks             = [...preamble('oci', values), sshKeyVariable(key)];
  if (!listing) blocks.push(variable(`${app.id}_appliance_listing_id`, 'string', `The OCI Marketplace listing OCID of ${vendorLabel(s.vendor)}.`));
  if (!version) blocks.push(variable(`${app.id}_appliance_listing_version`, 'string', 'The listing resource version (the image version) to deploy.'));
  const lid = listing ? q(listing) : `var.${app.id}_appliance_listing_id`;
  const lver = version ? q(version) : `var.${app.id}_appliance_listing_version`;
  const [shape = 'VM.Standard.E5.Flex', ocpus = '2'] = (s.size || 'VM.Standard.E5.Flex:2').split(':');
  blocks.push(
    dat('oci_core_app_catalog_listing_resource_version', 'appliance', { listing_id: x(lid), resource_version: x(lver) }),
    res('oci_core_app_catalog_listing_resource_version_agreement', 'appliance', { listing_id: x(lid), listing_resource_version: x(lver) }),
    res('oci_core_app_catalog_subscription', 'appliance', {
      compartment_id: x(comp),
      listing_id: x('oci_core_app_catalog_listing_resource_version_agreement.appliance.listing_id'),
      listing_resource_version: x('oci_core_app_catalog_listing_resource_version_agreement.appliance.listing_resource_version'),
      oracle_terms_of_use_link: x('oci_core_app_catalog_listing_resource_version_agreement.appliance.oracle_terms_of_use_link'),
      eula_link: x('oci_core_app_catalog_listing_resource_version_agreement.appliance.eula_link'),
      signature: x('oci_core_app_catalog_listing_resource_version_agreement.appliance.signature'),
      time_retrieved: x('oci_core_app_catalog_listing_resource_version_agreement.appliance.time_retrieved'),
    }),
  );
  const [first = 'mgmt', ...rest] = s.tiers;
  for (let i = 0; i < s.count; i++) {
    const id = `appliance_${i + 1}`;
    const tags = x(tagsExpr(app, 'oci', { atk_role: `appliance-${s.vendor}` }));
    blocks.push(
      res('oci_core_instance', id, {
        compartment_id: x(comp),
        availability_domain: x(`${lz}.zones[min(${i}, length(${lz}.zones) - 1)]`),
        display_name: x(`"${pfx}-${s.vendor}-${i + 1}"`),
        shape,
        freeform_tags: tags,
        metadata: x(`{ ssh_authorized_keys = var.${key} }`),
        depends_on: x('[oci_core_app_catalog_subscription.appliance]'),
      }, [
        ...(/Flex$/.test(shape) ? [blk('shape_config', { ocpus: Number(ocpus) || 2, memory_in_gbs: (Number(ocpus) || 2) * 8 })] : []),
        blk('source_details', { source_type: 'image', source_id: x('data.oci_core_app_catalog_listing_resource_version.appliance.listing_resource_id') }),
        blk('create_vnic_details', { subnet_id: x(subnetOf(lz, net, first)), nsg_ids: x(`[${securityGroupOf(lz, net, first)}]`), assign_public_ip: false, skip_source_dest_check: true, assign_ipv6ip: x(ipv6Of(lz, net)) }),
      ]),
    );
    for (const tier of rest) {
      blocks.push(
        res('oci_core_vnic_attachment', `${id}_${ident(tier)}`, { instance_id: x(`oci_core_instance.${id}.id`), display_name: rname(tier) }, [
          blk('create_vnic_details', { subnet_id: x(subnetOf(lz, net, tier)), nsg_ids: x(`[${securityGroupOf(lz, net, tier)}]`), assign_public_ip: 'false', skip_source_dest_check: true, assign_ipv6ip: x(ipv6Of(lz, net)) }),
        ]),
      );
    }
  }
  blocks.push(output('management_addresses', `[${Array.from({ length: s.count }, (_, i) => `oci_core_instance.appliance_${i + 1}.private_ip`).join(', ')}]`));
  return blocks;
}

function vsphereAppliance(values                 , findings           )             {
  const app = appOf(values);
  const s = specOf(values, 'wld01-mgmt wld01-web wld01-app');
  common(values, findings, s);
  const url = valueOf(values, 'ova_url');
  const [cpus = '4', ram = '16'] = (s.size || '4:16').split(':');
  const blocks             = [...vsphereProvider(values)];
  if (!url) blocks.push(variable(`${app.id}_appliance_ova_url`, 'string', `Where the ${vendorLabel(s.vendor)} OVA is served from.`));
  blocks.push(
    dat('vsphere_datacenter', 'appliance', { name: valueOf(values, 'datacenter', 'wld01-dc') }),
    dat('vsphere_compute_cluster', 'appliance', { name: valueOf(values, 'cluster', 'wld01-cl01'), datacenter_id: x('data.vsphere_datacenter.appliance.id') }),
    dat('vsphere_datastore', 'appliance', { name: valueOf(values, 'datastore', 'wld01-cl01-ds-vsan01'), datacenter_id: x('data.vsphere_datacenter.appliance.id') }),
    ...s.tiers.map((pg, i) => dat('vsphere_network', `appliance_${i + 1}`, { name: pg, datacenter_id: x('data.vsphere_datacenter.appliance.id') })),
  );
  for (let i = 0; i < s.count; i++) {
    blocks.push(
      res('vsphere_virtual_machine', `appliance_${i + 1}`, {
        name: `${app.slug}-${s.vendor}-${i + 1}`,
        resource_pool_id: x('data.vsphere_compute_cluster.appliance.resource_pool_id'),
        datastore_id: x('data.vsphere_datastore.appliance.id'),
        datacenter_id: x('data.vsphere_datacenter.appliance.id'),
        num_cpus: Number(cpus) || 4,
        memory: (Number(ram) || 16) * 1024,
        wait_for_guest_net_timeout: 0,
        wait_for_guest_ip_timeout: 0,
      }, [
        ...s.tiers.map((_, j) => blk('network_interface', { network_id: x(`data.vsphere_network.appliance_${j + 1}.id`) })),
        blk('ovf_deploy', {
          remote_ovf_url: x(url ? q(url) : `var.${app.id}_appliance_ova_url`),
          disk_provisioning: 'thin',
          ovf_network_map: x(`{ for i, n in [${s.tiers.map((_, j) => `data.vsphere_network.appliance_${j + 1}.id`).join(', ')}] : "nic\${i}" => n }`),
        }),
      ]),
    );
  }
  findings.push(info('tf.app.appliance-ovf-network', 'The OVF network map names the OVA\'s own networks (nic0, nic1 … here): check the names in the vendor\'s OVF descriptor, and set the vApp properties (management address, admin key) the vendor documents.', { path: 'interfaces' }));
  return blocks;
}

const EMITS                                                       = {
  aws: ['aws_key_pair', 'aws_instance', 'aws_network_interface', 'aws_network_interface_attachment'],
  azure: ['azurerm_marketplace_agreement', 'azurerm_network_interface', 'azurerm_network_interface_security_group_association', 'azurerm_linux_virtual_machine'],
  google: ['google_compute_instance'],
  oci: ['oci_core_app_catalog_listing_resource_version_agreement', 'oci_core_app_catalog_subscription', 'oci_core_instance', 'oci_core_vnic_attachment'],
  vsphere: ['vsphere_virtual_machine'],
};
const CLOUD                                            = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud (GCP)', oci: 'OCI', vsphere: 'VCF' };

function appliance(platform                 )            {
  return {
    id: `${platform}_app_appliance`,
    label: 'App network appliance (marketplace image)',
    group: PATTERN_GROUP,
    description: `A vendor appliance (F5, Palo Alto, Fortinet, Check Point, Cisco) on ${CLOUD[platform]} from its ${platform === 'vsphere' ? 'OVA' : 'marketplace image'}, one or an HA pair across zones, with ${platform === 'google' ? 'IP forwarding on one NIC' : 'a NIC per tier and IP forwarding on'}; the configuration then moves by the vendor's export and import.`,
    inputs: applianceInputs(platform),
    emits: EMITS[platform],
    build: (values                 ) => {
      const findings            = [];
      const blocks =
        platform === 'aws' ? awsAppliance(values, findings)
        : platform === 'azure' ? azureAppliance(values, findings)
        : platform === 'google' ? googleAppliance(values, findings)
        : platform === 'oci' ? ociAppliance(values, findings)
        : vsphereAppliance(values, findings);
      return { files: { 'main.tf': patternMainTf(blocks, `${CLOUD[platform]} appliance: ${appOf(values).name}`) }, findings };
    },
  };
}

export const APPLIANCE_BLUEPRINTS                       = (['aws', 'azure', 'google', 'oci', 'vsphere']         ).map(appliance);
