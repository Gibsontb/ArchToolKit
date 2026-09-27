/**
 * The service equivalence map's data. See equivalence.ts for the model.
 *
 * Seeded from the 21 capabilities of multicloud/services.ts (every one of its
 * types is in a row here), then filled out domain by domain from the Terraform
 * Maps' sections and the types the migration blueprints emit. Aligned by hand
 * from each provider's resource documentation; the types are checked against
 * catalog-data.ts and the attribute paths against the provider schemas under
 * web/data/terraform by equivalence.test.ts. The labels are indicative.
 *
 * A platform with nothing to offer says why (`none`). Where the reason is a
 * judgement rather than a published fact it ends in "(verify)".
 */

import type { AttributeMap, AttributeTarget, EquivalenceRow, ModuleRow, PlatformCell, TransformId, UnmappedEntry } from './equivalence.ts';

// ---------------------------------------------------------------- helpers ---

const SOURCE =
  'Provider resource documentation on registry.terraform.io for the catalogued versions (hashicorp/aws 6.66, hashicorp/azurerm 5.7, hashicorp/google 8.4, oracle/oci 9.3, vmware/vsphere 2.17, vmware/nsxt 3.12, vmware/vcf 0.18, vmware/avi 32.1); aligned by hand, indicative. Types and argument paths are checked by equivalence.test.ts.';
const SEEDED = `${SOURCE} Seeded from multicloud/services.ts.`;

const cell = (primary: readonly string[], extra: Omit<PlatformCell, 'primary'> = {}): PlatformCell => ({ primary, ...extra });
const none = (reason: string): PlatformCell => ({ primary: [], none: reason });
const at = (type: string, path: string, transform?: TransformId, companions?: AttributeTarget['companions']): AttributeTarget => ({
  type,
  path,
  ...(transform ? { transform } : {}),
  ...(companions ? { companions } : {}),
});
const attr = (concept: string, per: AttributeMap['per']): AttributeMap => ({ concept, per });

/** Tags on the four clouds: `tags`, Google `labels` (lower-cased), OCI `freeform_tags`. */
const tags = (aws?: string, azure?: string, google?: string, oci?: string): AttributeMap =>
  attr('tags', {
    ...(aws ? { aws: at(aws, 'tags') } : {}),
    ...(azure ? { azure: at(azure, 'tags') } : {}),
    ...(google ? { google: at(google, 'labels', 'tags-to-labels') } : {}),
    ...(oci ? { oci: at(oci, 'freeform_tags') } : {}),
  });

const NO_VMWARE_MANAGED_DB = 'VCF has no managed database service in the catalogued VMware providers: the database runs on a VM (compute.vm).';
const NO_VMWARE_PAAS = 'VCF has no managed service for this in the catalogued VMware providers: it runs on VMs or on vSphere Supervisor (containers.k8s.cluster).';

// ------------------------------------------------------------------- rows ---

export const EQUIVALENCE_ROWS: readonly EquivalenceRow[] = [
  // ============================================================ network ===
  {
    id: 'network.vpc',
    domain: 'network',
    label: 'Virtual network (VPC / VNet / VCN)',
    per: {
      aws: cell(['aws_vpc']),
      azure: cell(['azurerm_virtual_network']),
      google: cell(['google_compute_network']),
      oci: cell(['oci_core_vcn']),
      vmware: cell(['nsxt_vpc'], { note: 'An NSX VPC, the VCF 9 tenant network model.' }),
    },
    attributes: [
      attr('cidr', {
        aws: at('aws_vpc', 'cidr_block', 'first'),
        azure: at('azurerm_virtual_network', 'address_space'),
        oci: at('oci_core_vcn', 'cidr_blocks'),
      }),
      attr('name', {
        azure: at('azurerm_virtual_network', 'name'),
        google: at('google_compute_network', 'name'),
        oci: at('oci_core_vcn', 'display_name'),
        vmware: at('nsxt_vpc', 'display_name'),
      }),
      attr('ipv6', {
        aws: at('aws_vpc', 'assign_generated_ipv6_cidr_block', 'bool'),
        google: at('google_compute_network', 'enable_ula_internal_ipv6', 'bool'),
        oci: at('oci_core_vcn', 'is_ipv6enabled', 'bool'),
      }),
      attr('region', { aws: at('aws_vpc', 'region', 'region'), azure: at('azurerm_virtual_network', 'location', 'region') }),
      tags('aws_vpc', 'azurerm_virtual_network', undefined, 'oci_core_vcn'),
    ],
    mapSection: { aws: 'aws-networking', azure: 'az-networking', google: 'gcp-networking', oci: 'oci-networking' },
    source: SOURCE,
  },
  {
    id: 'network.subnet',
    domain: 'network',
    label: 'Subnet',
    per: {
      aws: cell(['aws_subnet']),
      azure: cell(['azurerm_subnet']),
      google: cell(['google_compute_subnetwork']),
      oci: cell(['oci_core_subnet']),
      vmware: cell(['nsxt_vpc_subnet'], { alternatives: [{ type: 'nsxt_policy_segment' }] }),
    },
    attributes: [
      attr('cidr', {
        aws: at('aws_subnet', 'cidr_block', 'first'),
        azure: at('azurerm_subnet', 'address_prefixes'),
        google: at('google_compute_subnetwork', 'ip_cidr_range', 'first'),
        oci: at('oci_core_subnet', 'cidr_block', 'first'),
        vmware: at('nsxt_vpc_subnet', 'ip_addresses'),
      }),
      attr('name', {
        azure: at('azurerm_subnet', 'name'),
        google: at('google_compute_subnetwork', 'name'),
        oci: at('oci_core_subnet', 'display_name'),
        vmware: at('nsxt_vpc_subnet', 'display_name'),
      }),
      attr('zone', { aws: at('aws_subnet', 'availability_zone', 'zone'), oci: at('oci_core_subnet', 'availability_domain', 'zone') }),
      tags('aws_subnet', undefined, undefined, 'oci_core_subnet'),
    ],
    mapSection: { aws: 'aws-networking', azure: 'az-networking', google: 'gcp-networking', oci: 'oci-networking' },
    source: SOURCE,
  },
  {
    id: 'network.route-table',
    domain: 'network',
    label: 'Route table and routes',
    per: {
      aws: cell(['aws_route_table'], { supporting: ['aws_route', 'aws_route_table_association'] }),
      azure: cell(['azurerm_route_table'], { supporting: ['azurerm_route', 'azurerm_subnet_route_table_association'] }),
      google: cell(['google_compute_route'], { note: 'Google routes are per network, one resource per route; there is no table object.' }),
      oci: cell(['oci_core_route_table']),
      vmware: cell(['nsxt_vpc_static_routes']),
    },
    attributes: [
      attr('name', {
        azure: at('azurerm_route_table', 'name'),
        google: at('google_compute_route', 'name'),
        oci: at('oci_core_route_table', 'display_name'),
      }),
      tags('aws_route_table', 'azurerm_route_table', undefined, 'oci_core_route_table'),
    ],
    mapSection: { aws: 'aws-networking', oci: 'oci-networking' },
    source: SOURCE,
  },
  {
    id: 'network.internet-gateway',
    domain: 'network',
    label: 'Internet gateway',
    per: {
      aws: cell(['aws_internet_gateway'], { supporting: ['aws_egress_only_internet_gateway'] }),
      azure: none('A VNet reaches the internet through its default system route; outbound is a NAT gateway (network.nat) and inbound a public IP (network.public-ip). There is no gateway object.'),
      google: none('A VPC reaches the internet through its default route to default-internet-gateway; there is no gateway object to declare.'),
      oci: cell(['oci_core_internet_gateway']),
      vmware: none('North-south traffic leaves through the Tier-0 gateway, which the platform team owns in VCF; it is not an application resource.'),
    },
    attributes: [
      attr('name', { oci: at('oci_core_internet_gateway', 'display_name') }),
      tags('aws_internet_gateway', undefined, undefined, 'oci_core_internet_gateway'),
    ],
    mapSection: { aws: 'aws-networking', oci: 'oci-networking' },
    source: SOURCE,
  },
  {
    id: 'network.nat',
    domain: 'network',
    label: 'NAT gateway (outbound)',
    per: {
      aws: cell(['aws_nat_gateway']),
      azure: cell(['azurerm_nat_gateway'], { supporting: ['azurerm_nat_gateway_public_ip_association', 'azurerm_subnet_nat_gateway_association'] }),
      google: cell(['google_compute_router_nat'], { supporting: ['google_compute_router'] }),
      oci: cell(['oci_core_nat_gateway']),
      vmware: cell(['nsxt_vpc_nat_rule']),
    },
    attributes: [
      attr('name', {
        azure: at('azurerm_nat_gateway', 'name'),
        google: at('google_compute_router_nat', 'name'),
        oci: at('oci_core_nat_gateway', 'display_name'),
        vmware: at('nsxt_vpc_nat_rule', 'display_name'),
      }),
      attr('subnet', { aws: at('aws_nat_gateway', 'subnet_id', 'lz-subnet') }),
      tags('aws_nat_gateway', 'azurerm_nat_gateway', undefined, 'oci_core_nat_gateway'),
    ],
    mapSection: { aws: 'aws-networking', google: 'gcp-networking', oci: 'oci-networking' },
    source: SOURCE,
  },
  {
    id: 'network.public-ip',
    domain: 'network',
    label: 'Public IP address',
    per: {
      aws: cell(['aws_eip']),
      azure: cell(['azurerm_public_ip']),
      google: cell(['google_compute_address']),
      oci: cell(['oci_core_public_ip']),
      vmware: cell(['nsxt_vpc_external_address']),
    },
    attributes: [
      attr('name', { azure: at('azurerm_public_ip', 'name'), google: at('google_compute_address', 'name'), oci: at('oci_core_public_ip', 'display_name') }),
      tags('aws_eip', 'azurerm_public_ip', 'google_compute_address', 'oci_core_public_ip'),
    ],
    mapSection: { aws: 'aws-networking' },
    source: SOURCE,
  },
  {
    id: 'network.security-group',
    domain: 'network',
    label: 'Security group / NSG / firewall rules',
    per: {
      aws: cell(['aws_security_group'], { supporting: ['aws_vpc_security_group_ingress_rule', 'aws_vpc_security_group_egress_rule'] }),
      azure: cell(['azurerm_network_security_group'], { supporting: ['azurerm_network_security_rule', 'azurerm_subnet_network_security_group_association'] }),
      google: cell(['google_compute_firewall'], { note: 'Google has no group object: each firewall rule targets network tags or service accounts.' }),
      oci: cell(['oci_core_network_security_group'], { supporting: ['oci_core_network_security_group_security_rule'] }),
      vmware: cell(['nsxt_vpc_security_policy'], { supporting: ['nsxt_vpc_group'], note: 'NSX distributed firewall policy on the VPC.' }),
    },
    attributes: [
      attr('name', {
        aws: at('aws_security_group', 'name'),
        azure: at('azurerm_network_security_group', 'name'),
        google: at('google_compute_firewall', 'name'),
        oci: at('oci_core_network_security_group', 'display_name'),
        vmware: at('nsxt_vpc_security_policy', 'display_name'),
      }),
      tags('aws_security_group', 'azurerm_network_security_group', undefined, 'oci_core_network_security_group'),
    ],
    mapSection: { aws: 'aws-networking', azure: 'az-networking', oci: 'oci-networking' },
    source: SOURCE,
  },
  {
    id: 'network.subnet-acl',
    domain: 'network',
    label: 'Stateless subnet ACL',
    per: {
      aws: cell(['aws_network_acl']),
      azure: none('Azure has no stateless subnet ACL; the NSG (network.security-group) is associated with the subnet instead.'),
      google: none('Google has no stateless subnet ACL; firewall rules (network.security-group) apply per network.'),
      oci: cell(['oci_core_security_list']),
      vmware: none('NSX filtering is the stateful distributed firewall (network.security-group); there is no stateless subnet ACL object in the VPC model.'),
    },
    attributes: [attr('name', { oci: at('oci_core_security_list', 'display_name') }), tags('aws_network_acl', undefined, undefined, 'oci_core_security_list')],
    mapSection: { aws: 'aws-networking', oci: 'oci-networking' },
    source: SOURCE,
  },
  {
    id: 'network.firewall',
    domain: 'network',
    label: 'Managed network firewall',
    per: {
      aws: cell(['aws_networkfirewall_firewall']),
      azure: cell(['azurerm_firewall'], { supporting: ['azurerm_firewall_policy'] }),
      google: cell(['google_compute_network_firewall_policy']),
      oci: cell(['oci_network_firewall_network_firewall'], { supporting: ['oci_network_firewall_network_firewall_policy'] }),
      vmware: cell(['nsxt_vpc_gateway_policy'], { note: 'NSX gateway firewall policy on the VPC gateway.' }),
    },
    attributes: [
      attr('name', {
        aws: at('aws_networkfirewall_firewall', 'name'),
        azure: at('azurerm_firewall', 'name'),
        google: at('google_compute_network_firewall_policy', 'name'),
        oci: at('oci_network_firewall_network_firewall', 'display_name'),
        vmware: at('nsxt_vpc_gateway_policy', 'display_name'),
      }),
    ],
    mapSection: { azure: 'az-networking' },
    source: SOURCE,
  },
  {
    id: 'network.peering',
    domain: 'network',
    label: 'Network peering',
    per: {
      aws: cell(['aws_vpc_peering_connection']),
      azure: cell(['azurerm_virtual_network_peering']),
      google: cell(['google_compute_network_peering']),
      oci: cell(['oci_core_local_peering_gateway']),
      vmware: none('NSX VPCs in one project route to each other through the project\'s transit gateway; there is no peering object.'),
    },
    attributes: [
      attr('name', {
        azure: at('azurerm_virtual_network_peering', 'name'),
        google: at('google_compute_network_peering', 'name'),
        oci: at('oci_core_local_peering_gateway', 'display_name'),
      }),
    ],
    mapSection: { aws: 'aws-networking' },
    source: SOURCE,
  },
  {
    id: 'network.transit-hub',
    domain: 'network',
    label: 'Transit hub (hub-and-spoke routing)',
    per: {
      aws: cell(['aws_ec2_transit_gateway'], { supporting: ['aws_ec2_transit_gateway_vpc_attachment'] }),
      azure: cell(['azurerm_virtual_hub'], { supporting: ['azurerm_virtual_hub_connection'] }),
      google: cell(['google_network_connectivity_hub'], { supporting: ['google_network_connectivity_spoke'] }),
      oci: cell(['oci_core_drg'], { supporting: ['oci_core_drg_attachment'] }),
      vmware: cell(['nsxt_policy_tier0_gateway'], { note: 'The Tier-0 gateway is the platform\'s transit; usually owned by the platform team.' }),
    },
    attributes: [
      attr('name', {
        azure: at('azurerm_virtual_hub', 'name'),
        google: at('google_network_connectivity_hub', 'name'),
        oci: at('oci_core_drg', 'display_name'),
        vmware: at('nsxt_policy_tier0_gateway', 'display_name'),
      }),
      tags('aws_ec2_transit_gateway', 'azurerm_virtual_hub', 'google_network_connectivity_hub', 'oci_core_drg'),
    ],
    mapSection: { aws: 'aws-networking' },
    source: SOURCE,
  },
  {
    id: 'network.vpn',
    domain: 'network',
    label: 'Site-to-site VPN',
    per: {
      aws: cell(['aws_vpn_connection'], { supporting: ['aws_customer_gateway', 'aws_vpn_gateway', 'aws_vpn_gateway_route_propagation'] }),
      azure: cell(['azurerm_virtual_network_gateway_connection', 'azurerm_virtual_network_gateway'], { supporting: ['azurerm_local_network_gateway'] }),
      google: cell(['google_compute_ha_vpn_gateway', 'google_compute_vpn_tunnel'], {
        supporting: ['google_compute_external_vpn_gateway', 'google_compute_router_interface', 'google_compute_router_peer'],
      }),
      oci: cell(['oci_core_ipsec'], { supporting: ['oci_core_cpe', 'oci_core_ipsec_connection_tunnel_management'] }),
      vmware: cell(['nsxt_policy_ipsec_vpn_session'], { supporting: ['nsxt_policy_ipsec_vpn_service', 'nsxt_policy_ipsec_vpn_local_endpoint'] }),
    },
    attributes: [
      attr('name', {
        azure: at('azurerm_virtual_network_gateway_connection', 'name'),
        google: at('google_compute_vpn_tunnel', 'name'),
        oci: at('oci_core_ipsec', 'display_name'),
        vmware: at('nsxt_policy_ipsec_vpn_session', 'display_name'),
      }),
      tags('aws_vpn_connection', 'azurerm_virtual_network_gateway_connection', undefined, 'oci_core_ipsec'),
    ],
    mapSection: { aws: 'aws-networking', azure: 'az-networking' },
    source: SEEDED,
  },
  {
    id: 'network.private-circuit',
    domain: 'network',
    label: 'Private circuit to on-premises',
    per: {
      aws: cell(['aws_dx_gateway'], {
        supporting: ['aws_dx_connection', 'aws_dx_gateway_association', 'aws_dx_transit_virtual_interface', 'aws_dx_private_virtual_interface', 'aws_dx_bgp_peer'],
      }),
      azure: cell(['azurerm_express_route_circuit'], { supporting: ['azurerm_express_route_circuit_peering'] }),
      google: cell(['google_compute_interconnect_attachment'], { supporting: ['google_compute_interconnect'] }),
      oci: cell(['oci_core_virtual_circuit']),
      vmware: none('The circuit terminates on the data centre\'s physical edge, not on an NSX object; the Tier-0 uplinks carry it.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_dx_gateway', 'name'),
        azure: at('azurerm_express_route_circuit', 'name'),
        google: at('google_compute_interconnect_attachment', 'name'),
        oci: at('oci_core_virtual_circuit', 'display_name'),
      }),
    ],
    mapSection: { aws: 'aws-networking', azure: 'az-networking' },
    source: SEEDED,
  },
  {
    id: 'network.private-endpoint',
    domain: 'network',
    label: 'Private endpoint to a managed service',
    per: {
      aws: cell(['aws_vpc_endpoint']),
      azure: cell(['azurerm_private_endpoint']),
      google: cell(['google_service_networking_connection'], {
        supporting: ['google_compute_global_address'],
        note: 'Private services access (peered range) for Cloud SQL and similar; Private Service Connect endpoints are forwarding rules.',
      }),
      oci: cell(['oci_core_service_gateway'], { note: 'The service gateway reaches Oracle Services Network privately; per-service private endpoints are set on the service itself.' }),
      vmware: none('No managed services to reach privately: services run on VMs inside the NSX VPC.'),
    },
    attributes: [
      attr('subnet', { azure: at('azurerm_private_endpoint', 'subnet_id', 'lz-subnet') }),
      attr('name', { azure: at('azurerm_private_endpoint', 'name'), oci: at('oci_core_service_gateway', 'display_name') }),
      tags('aws_vpc_endpoint', 'azurerm_private_endpoint', undefined, 'oci_core_service_gateway'),
    ],
    mapSection: { aws: 'aws-networking', azure: 'az-networking', oci: 'oci-networking' },
    source: SOURCE,
  },
  {
    id: 'network.endpoint-service',
    domain: 'network',
    label: 'Publishing a service privately (private link service)',
    per: {
      aws: cell(['aws_vpc_endpoint_service']),
      azure: cell(['azurerm_private_link_service']),
      google: cell(['google_compute_service_attachment']),
      oci: none('OCI has no provider-side private link service for customer applications in the catalogued provider (verify).'),
      vmware: none('No private-link construct in NSX: consumers reach the service over routed VPC networking.'),
    },
    attributes: [attr('name', { azure: at('azurerm_private_link_service', 'name'), google: at('google_compute_service_attachment', 'name') })],
    mapSection: { aws: 'aws-networking' },
    source: SOURCE,
  },
  {
    id: 'network.flow-logs',
    domain: 'network',
    label: 'Network flow logs',
    per: {
      aws: cell(['aws_flow_log']),
      azure: cell(['azurerm_network_watcher_flow_log']),
      google: none('VPC Flow Logs are the log_config block on google_compute_subnetwork (network.subnet), not a resource of their own.'),
      oci: none('VCN flow logs are an oci_logging_log with the flowlogs service as source (observability.logs).'),
      vmware: none('NSX IPFIX export is configured by the platform team, not per application.'),
    },
    attributes: [tags('aws_flow_log', 'azurerm_network_watcher_flow_log')],
    source: SOURCE,
  },
  {
    id: 'network.bastion',
    domain: 'network',
    label: 'Managed bastion',
    per: {
      aws: none('AWS reaches instances through Systems Manager Session Manager, which needs no per-network resource.'),
      azure: cell(['azurerm_bastion_host']),
      google: none('Google reaches instances through IAP TCP forwarding, a firewall rule and IAM rather than a bastion resource.'),
      oci: cell(['oci_bastion_bastion']),
      vmware: none('Administrative access goes through the enterprise jump hosts; there is no managed bastion in VCF.'),
    },
    attributes: [attr('name', { azure: at('azurerm_bastion_host', 'name'), oci: at('oci_bastion_bastion', 'name') })],
    source: SOURCE,
  },

  // =========================================================== identity ===
  {
    id: 'identity.workload',
    domain: 'identity',
    label: 'Workload identity (a role the machine or service runs as)',
    per: {
      aws: cell(['aws_iam_role'], { supporting: ['aws_iam_role_policy_attachment', 'aws_iam_instance_profile', 'aws_iam_policy'] }),
      azure: cell(['azurerm_user_assigned_identity'], { supporting: ['azurerm_role_assignment'] }),
      google: cell(['google_service_account'], { supporting: ['google_project_iam_member', 'google_project_iam_binding', 'google_kms_crypto_key_iam_member', 'google_storage_bucket_iam_member'] }),
      oci: cell(['oci_identity_dynamic_group'], { supporting: ['oci_identity_policy'] }),
      vmware: none('Guests authenticate with directory accounts; vCenter roles are platform-level and not per application.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_iam_role', 'name'),
        azure: at('azurerm_user_assigned_identity', 'name'),
        google: at('google_service_account', 'account_id'),
        oci: at('oci_identity_dynamic_group', 'name'),
      }),
      tags('aws_iam_role', 'azurerm_user_assigned_identity', undefined, 'oci_identity_dynamic_group'),
    ],
    mapSection: { aws: 'aws-identity', azure: 'az-identity', google: 'gcp-iam', oci: 'oci-identity' },
    source: SOURCE,
  },
  {
    id: 'identity.container',
    domain: 'identity',
    label: 'Resource container (resource group / project / compartment)',
    per: {
      aws: none('AWS has no resource container below the account; the account is landing-zone scope and resources are grouped by tags.'),
      azure: cell(['azurerm_resource_group']),
      google: cell(['google_project']),
      oci: cell(['oci_identity_compartment']),
      vmware: cell(['vsphere_folder']),
    },
    attributes: [
      attr('name', {
        azure: at('azurerm_resource_group', 'name'),
        google: at('google_project', 'name'),
        oci: at('oci_identity_compartment', 'name'),
        vmware: at('vsphere_folder', 'path'),
      }),
      attr('region', { azure: at('azurerm_resource_group', 'location', 'region') }),
      tags(undefined, 'azurerm_resource_group', 'google_project', 'oci_identity_compartment'),
    ],
    mapSection: { oci: 'oci-identity' },
    source: SOURCE,
  },
  {
    id: 'identity.directory',
    domain: 'identity',
    label: 'Managed Microsoft Active Directory',
    per: {
      aws: cell(['aws_directory_service_directory']),
      azure: cell(['azurerm_active_directory_domain_service']),
      google: cell(['google_active_directory_domain']),
      oci: none('OCI has no managed Microsoft AD; domain controllers run on VMs (compute.vm).'),
      vmware: none('Domain controllers run on VMs (compute.vm); VCF has no managed directory.'),
    },
    attributes: [
      attr('domain', {
        aws: at('aws_directory_service_directory', 'name'),
        azure: at('azurerm_active_directory_domain_service', 'domain_name'),
        google: at('google_active_directory_domain', 'domain_name'),
      }),
      tags('aws_directory_service_directory', 'azurerm_active_directory_domain_service', 'google_active_directory_domain'),
    ],
    source: SOURCE,
  },

  // ============================================================ compute ===
  {
    id: 'compute.vm',
    domain: 'compute',
    label: 'Virtual machine',
    per: {
      aws: cell(['aws_instance'], { supporting: ['aws_network_interface'] }),
      azure: cell(['azurerm_linux_virtual_machine', 'azurerm_network_interface'], {
        alternatives: [{ type: 'azurerm_windows_virtual_machine', os: 'windows' }],
        note: 'An Azure VM needs its NIC declared; a Windows guest uses azurerm_windows_virtual_machine.',
      }),
      google: cell(['google_compute_instance']),
      oci: cell(['oci_core_instance']),
      vmware: cell(['vsphere_virtual_machine']),
    },
    attributes: [
      attr('size', {
        aws: at('aws_instance', 'instance_type', 'rightsize'),
        azure: at('azurerm_linux_virtual_machine', 'size', 'rightsize'),
        google: at('google_compute_instance', 'machine_type', 'rightsize'),
        oci: at('oci_core_instance', 'shape', 'rightsize', { ocpus: 'shape_config.ocpus', memoryGib: 'shape_config.memory_in_gbs' }),
        vmware: at('vsphere_virtual_machine', 'num_cpus', 'rightsize', { cpu: 'num_cpus', memoryMib: 'memory' }),
      }),
      attr('name', {
        azure: at('azurerm_linux_virtual_machine', 'name'),
        google: at('google_compute_instance', 'name'),
        oci: at('oci_core_instance', 'display_name'),
        vmware: at('vsphere_virtual_machine', 'name'),
      }),
      attr('zone', {
        aws: at('aws_instance', 'availability_zone', 'zone'),
        azure: at('azurerm_linux_virtual_machine', 'zone', 'zone'),
        google: at('google_compute_instance', 'zone', 'zone'),
        oci: at('oci_core_instance', 'availability_domain', 'zone'),
      }),
      attr('subnet', {
        aws: at('aws_instance', 'subnet_id', 'lz-subnet'),
        azure: at('azurerm_network_interface', 'ip_configuration.subnet_id', 'lz-subnet'),
        google: at('google_compute_instance', 'network_interface.subnetwork', 'lz-subnet'),
        oci: at('oci_core_instance', 'create_vnic_details.subnet_id', 'lz-subnet'),
        vmware: at('vsphere_virtual_machine', 'network_interface.network_id', 'lz-subnet'),
      }),
      attr('security-groups', {
        aws: at('aws_instance', 'vpc_security_group_ids', 'lz-sg'),
        oci: at('oci_core_instance', 'create_vnic_details.nsg_ids', 'lz-sg'),
      }),
      attr('boot-disk.gib', {
        aws: at('aws_instance', 'root_block_device.volume_size', 'gib'),
        azure: at('azurerm_linux_virtual_machine', 'os_disk.disk_size_gb', 'gib'),
        google: at('google_compute_instance', 'boot_disk.initialize_params.size', 'gib'),
        oci: at('oci_core_instance', 'source_details.boot_volume_size_in_gbs', 'gib'),
      }),
      attr('encryption.key', {
        aws: at('aws_instance', 'root_block_device.kms_key_id', 'lz-kms'),
        google: at('google_compute_instance', 'boot_disk.kms_key_self_link', 'lz-kms'),
        oci: at('oci_core_instance', 'source_details.kms_key_id', 'lz-kms'),
      }),
      attr('ipv6', {
        aws: at('aws_instance', 'enable_primary_ipv6', 'bool'),
        oci: at('oci_core_instance', 'create_vnic_details.assign_ipv6ip', 'bool'),
      }),
      tags('aws_instance', 'azurerm_linux_virtual_machine', 'google_compute_instance', 'oci_core_instance'),
    ],
    mapSection: { aws: 'aws-compute', azure: 'az-compute', google: 'gcp-compute', oci: 'oci-compute' },
    source: SEEDED,
  },
  {
    id: 'compute.scale-set',
    domain: 'compute',
    label: 'Scale set / instance group',
    per: {
      aws: cell(['aws_autoscaling_group', 'aws_launch_template'], { supporting: ['aws_autoscaling_policy'] }),
      azure: cell(['azurerm_linux_virtual_machine_scale_set'], { alternatives: [{ type: 'azurerm_windows_virtual_machine_scale_set', os: 'windows' }] }),
      google: cell(['google_compute_region_instance_group_manager', 'google_compute_instance_template']),
      oci: cell(['oci_core_instance_pool', 'oci_core_instance_configuration']),
      vmware: none('vSphere has no autoscaling group; scale-out runs on vSphere Supervisor (containers.k8s.cluster) or through VCF Automation.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_autoscaling_group', 'name'),
        azure: at('azurerm_linux_virtual_machine_scale_set', 'name'),
        google: at('google_compute_region_instance_group_manager', 'name'),
        oci: at('oci_core_instance_pool', 'display_name'),
      }),
      attr('size.count', {
        aws: at('aws_autoscaling_group', 'desired_capacity'),
        azure: at('azurerm_linux_virtual_machine_scale_set', 'instances'),
        google: at('google_compute_region_instance_group_manager', 'target_size'),
        oci: at('oci_core_instance_pool', 'size'),
      }),
      attr('size', {
        aws: at('aws_launch_template', 'instance_type', 'rightsize'),
        azure: at('azurerm_linux_virtual_machine_scale_set', 'sku', 'rightsize'),
        google: at('google_compute_instance_template', 'machine_type', 'rightsize'),
      }),
    ],
    mapSection: { aws: 'aws-compute', azure: 'az-compute', google: 'gcp-compute', oci: 'oci-compute' },
    source: SOURCE,
  },
  {
    id: 'compute.dedicated-host',
    domain: 'compute',
    label: 'Dedicated host (licence-bound workloads)',
    per: {
      aws: cell(['aws_ec2_host']),
      azure: cell(['azurerm_dedicated_host'], { supporting: ['azurerm_dedicated_host_group'] }),
      google: cell(['google_compute_node_group'], { supporting: ['google_compute_node_template'] }),
      oci: cell(['oci_core_dedicated_vm_host']),
      vmware: none('Every vSphere host is already dedicated to the organisation; licence placement is a DRS host rule, not a resource.'),
    },
    attributes: [
      attr('name', { azure: at('azurerm_dedicated_host', 'name'), google: at('google_compute_node_group', 'name'), oci: at('oci_core_dedicated_vm_host', 'display_name') }),
      attr('zone', { aws: at('aws_ec2_host', 'availability_zone', 'zone'), google: at('google_compute_node_group', 'zone', 'zone') }),
      tags('aws_ec2_host', 'azurerm_dedicated_host', undefined, 'oci_core_dedicated_vm_host'),
    ],
    source: SOURCE,
  },
  {
    id: 'compute.guest-config',
    domain: 'compute',
    label: 'Guest configuration and agents (run on the VM)',
    per: {
      aws: cell(['aws_ssm_association']),
      azure: cell(['azurerm_virtual_machine_extension']),
      google: cell(['google_os_config_os_policy_assignment']),
      oci: none('OCI agent plugins are switched on in the instance\'s agent_config (compute.vm), not by a separate resource.'),
      vmware: none('Guest configuration is Ansible\'s: add it on the Configuration tab.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_ssm_association', 'association_name'),
        azure: at('azurerm_virtual_machine_extension', 'name'),
        google: at('google_os_config_os_policy_assignment', 'name'),
      }),
    ],
    source: SOURCE,
  },
  {
    id: 'compute.licence-tracking',
    domain: 'compute',
    label: 'Licence tracking',
    per: {
      aws: cell(['aws_licensemanager_license_configuration'], { supporting: ['aws_licensemanager_association'] }),
      azure: none('No licence-tracking resource: Azure Hybrid Benefit is the license_type on the VM, and the plan records the licence position.'),
      google: none('No licence-tracking resource: sole-tenant node usage is reported, and the plan records the licence position.'),
      oci: none('No licence-tracking resource: BYOL is chosen on the service, and the plan records the licence position.'),
      vmware: none('No licence-tracking resource: the plan records the licence position.'),
    },
    attributes: [attr('name', { aws: at('aws_licensemanager_license_configuration', 'name') })],
    source: SOURCE,
  },

  // ========================================================= containers ===
  {
    id: 'containers.k8s.cluster',
    domain: 'containers',
    label: 'Managed Kubernetes cluster',
    per: {
      aws: cell(['aws_eks_cluster'], { supporting: ['aws_eks_addon', 'aws_eks_fargate_profile'] }),
      azure: cell(['azurerm_kubernetes_cluster']),
      google: cell(['google_container_cluster']),
      oci: cell(['oci_containerengine_cluster']),
      vmware: cell(['vsphere_supervisor'], { note: 'vSphere Supervisor; clusters on it are vSphere Kubernetes Service clusters declared through its API.' }),
    },
    attributes: [
      attr('name', {
        aws: at('aws_eks_cluster', 'name'),
        azure: at('azurerm_kubernetes_cluster', 'name'),
        google: at('google_container_cluster', 'name'),
        oci: at('oci_containerengine_cluster', 'name'),
      }),
      attr('k8s.version', {
        aws: at('aws_eks_cluster', 'version'),
        azure: at('azurerm_kubernetes_cluster', 'kubernetes_version'),
        google: at('google_container_cluster', 'min_master_version'),
        oci: at('oci_containerengine_cluster', 'kubernetes_version'),
      }),
      attr('encryption.key', { oci: at('oci_containerengine_cluster', 'kms_key_id', 'lz-kms') }),
      tags('aws_eks_cluster', 'azurerm_kubernetes_cluster', undefined, 'oci_containerengine_cluster'),
    ],
    mapSection: { aws: 'aws-compute', azure: 'az-compute', google: 'gcp-compute' },
    source: SEEDED,
  },
  {
    id: 'containers.k8s.node-pool',
    domain: 'containers',
    label: 'Kubernetes node pool',
    per: {
      aws: cell(['aws_eks_node_group']),
      azure: cell(['azurerm_kubernetes_cluster_node_pool']),
      google: cell(['google_container_node_pool']),
      oci: cell(['oci_containerengine_node_pool']),
      vmware: none('Node pools are part of the VKS cluster specification on vSphere Supervisor, not a Terraform resource in the catalogued providers.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_eks_node_group', 'node_group_name'),
        azure: at('azurerm_kubernetes_cluster_node_pool', 'name'),
        google: at('google_container_node_pool', 'name'),
        oci: at('oci_containerengine_node_pool', 'name'),
      }),
      attr('size', {
        aws: at('aws_eks_node_group', 'instance_types', 'rightsize'),
        azure: at('azurerm_kubernetes_cluster_node_pool', 'vm_size', 'rightsize'),
        google: at('google_container_node_pool', 'node_config.machine_type', 'rightsize'),
        oci: at('oci_containerengine_node_pool', 'node_shape', 'rightsize', { ocpus: 'node_shape_config.ocpus', memoryGib: 'node_shape_config.memory_in_gbs' }),
      }),
      attr('size.count', {
        aws: at('aws_eks_node_group', 'scaling_config.desired_size'),
        azure: at('azurerm_kubernetes_cluster_node_pool', 'node_count'),
        google: at('google_container_node_pool', 'node_count'),
      }),
      attr('subnet', {
        aws: at('aws_eks_node_group', 'subnet_ids', 'lz-subnet'),
        azure: at('azurerm_kubernetes_cluster_node_pool', 'vnet_subnet_id', 'lz-subnet'),
        oci: at('oci_containerengine_node_pool', 'subnet_ids', 'lz-subnet'),
      }),
    ],
    mapSection: { aws: 'aws-compute', google: 'gcp-compute' },
    source: SOURCE,
  },
  {
    id: 'containers.registry',
    domain: 'containers',
    label: 'Container registry',
    per: {
      aws: cell(['aws_ecr_repository']),
      azure: cell(['azurerm_container_registry']),
      google: cell(['google_artifact_registry_repository']),
      oci: cell(['oci_artifacts_container_repository']),
      vmware: none('Harbor on vSphere Supervisor is not a Terraform resource in the catalogued VMware providers.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_ecr_repository', 'name'),
        azure: at('azurerm_container_registry', 'name'),
        oci: at('oci_artifacts_container_repository', 'display_name'),
      }),
      tags('aws_ecr_repository', 'azurerm_container_registry', 'google_artifact_registry_repository', 'oci_artifacts_container_repository'),
    ],
    mapSection: { aws: 'aws-compute', azure: 'az-compute' },
    source: SEEDED,
  },
  {
    id: 'containers.service',
    domain: 'containers',
    label: 'Container service (orchestrated containers without Kubernetes)',
    per: {
      aws: cell(['aws_ecs_service'], { supporting: ['aws_ecs_cluster', 'aws_ecs_task_definition'] }),
      azure: cell(['azurerm_container_app'], { supporting: ['azurerm_container_app_environment'] }),
      google: none('Google has no ECS-style orchestrator: Cloud Run (serverless.web-app) or GKE (containers.k8s.cluster) take its place; choose one.'),
      oci: cell(['oci_container_instances_container_instance']),
      vmware: none(NO_VMWARE_PAAS),
    },
    attributes: [
      attr('name', {
        aws: at('aws_ecs_service', 'name'),
        azure: at('azurerm_container_app', 'name'),
        oci: at('oci_container_instances_container_instance', 'display_name'),
      }),
    ],
    mapSection: { aws: 'aws-compute' },
    source: SOURCE,
  },

  // ========================================================= serverless ===
  {
    id: 'serverless.function',
    domain: 'serverless',
    label: 'Serverless function',
    per: {
      aws: cell(['aws_lambda_function'], { supporting: ['aws_lambda_permission'] }),
      azure: cell(['azurerm_linux_function_app'], { supporting: ['azurerm_service_plan'] }),
      google: cell(['google_cloudfunctions2_function']),
      oci: cell(['oci_functions_function'], { supporting: ['oci_functions_application'] }),
      vmware: none(NO_VMWARE_PAAS),
    },
    attributes: [
      attr('name', {
        aws: at('aws_lambda_function', 'function_name'),
        azure: at('azurerm_linux_function_app', 'name'),
        google: at('google_cloudfunctions2_function', 'name'),
        oci: at('oci_functions_function', 'display_name'),
      }),
      attr('memory.mib', {
        aws: at('aws_lambda_function', 'memory_size'),
        oci: at('oci_functions_function', 'memory_in_mbs'),
      }),
      attr('timeout.seconds', {
        aws: at('aws_lambda_function', 'timeout'),
        google: at('google_cloudfunctions2_function', 'service_config.timeout_seconds'),
        oci: at('oci_functions_function', 'timeout_in_seconds'),
      }),
      tags('aws_lambda_function', 'azurerm_linux_function_app', 'google_cloudfunctions2_function', 'oci_functions_function'),
    ],
    mapSection: { aws: 'aws-compute', azure: 'az-compute' },
    source: SEEDED,
  },
  {
    id: 'serverless.web-app',
    domain: 'serverless',
    label: 'Managed web app / container app',
    per: {
      aws: cell(['aws_apprunner_service']),
      azure: cell(['azurerm_linux_web_app'], { supporting: ['azurerm_service_plan'], alternatives: [{ type: 'azurerm_windows_web_app', os: 'windows' }] }),
      google: cell(['google_cloud_run_v2_service']),
      oci: none('OCI has no managed web-app platform (the paas-web tier pattern has no OCI service); run it on OKE (containers.k8s.cluster) or container instances (containers.service).'),
      vmware: none(NO_VMWARE_PAAS),
    },
    attributes: [
      attr('name', {
        aws: at('aws_apprunner_service', 'service_name'),
        azure: at('azurerm_linux_web_app', 'name'),
        google: at('google_cloud_run_v2_service', 'name'),
      }),
      tags('aws_apprunner_service', 'azurerm_linux_web_app', 'google_cloud_run_v2_service'),
    ],
    mapSection: { azure: 'az-compute' },
    source: SOURCE,
  },
  {
    id: 'serverless.api-gateway',
    domain: 'serverless',
    label: 'API gateway',
    per: {
      aws: cell(['aws_apigatewayv2_api'], { supporting: ['aws_apigatewayv2_stage'] }),
      azure: cell(['azurerm_api_management']),
      google: cell(['google_api_gateway_gateway'], { supporting: ['google_api_gateway_api', 'google_api_gateway_api_config'] }),
      oci: cell(['oci_apigateway_gateway'], { supporting: ['oci_apigateway_deployment'] }),
      vmware: none('No API gateway in the catalogued VMware providers; Avi can front the API as a load balancer (lb.l7).'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_apigatewayv2_api', 'name'),
        azure: at('azurerm_api_management', 'name'),
        oci: at('oci_apigateway_gateway', 'display_name'),
      }),
    ],
    mapSection: { aws: 'aws-compute' },
    source: SOURCE,
  },

  // ============================================================ storage ===
  {
    id: 'storage.object',
    domain: 'storage',
    label: 'Object storage bucket',
    per: {
      aws: cell(['aws_s3_bucket'], {
        supporting: [
          'aws_s3_bucket_versioning',
          'aws_s3_bucket_server_side_encryption_configuration',
          'aws_s3_bucket_public_access_block',
          'aws_s3_bucket_lifecycle_configuration',
          'aws_s3_bucket_policy',
          'aws_s3_bucket_object_lock_configuration',
          'aws_s3_bucket_ownership_controls',
        ],
      }),
      azure: cell(['azurerm_storage_account', 'azurerm_storage_container']),
      google: cell(['google_storage_bucket']),
      oci: cell(['oci_objectstorage_bucket']),
      vmware: none('VCF has no object store in the catalogued VMware providers; keep the bucket on a cloud or run an S3-compatible store on VMs.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_s3_bucket', 'bucket'),
        azure: at('azurerm_storage_account', 'name'),
        google: at('google_storage_bucket', 'name'),
        oci: at('oci_objectstorage_bucket', 'name'),
      }),
      attr('versioning', {
        aws: at('aws_s3_bucket_versioning', 'versioning_configuration.status', 'enabled-string'),
        azure: at('azurerm_storage_account', 'blob_properties.versioning_enabled', 'bool'),
        google: at('google_storage_bucket', 'versioning.enabled', 'bool'),
        oci: at('oci_objectstorage_bucket', 'versioning', 'enabled-string'),
      }),
      attr('encryption.key', {
        aws: at('aws_s3_bucket_server_side_encryption_configuration', 'rule.apply_server_side_encryption_by_default.kms_master_key_id', 'lz-kms'),
        azure: at('azurerm_storage_account', 'customer_managed_key.key_vault_key_id', 'lz-kms'),
        google: at('google_storage_bucket', 'encryption.default_kms_key_name', 'lz-kms'),
        oci: at('oci_objectstorage_bucket', 'kms_key_id', 'lz-kms'),
      }),
      attr('object-lock', {
        aws: at('aws_s3_bucket', 'object_lock_enabled', 'bool'),
        google: at('google_storage_bucket', 'enable_object_retention', 'bool'),
      }),
      attr('region', {
        aws: at('aws_s3_bucket', 'region', 'region'),
        azure: at('azurerm_storage_account', 'location', 'region'),
        google: at('google_storage_bucket', 'location', 'region'),
      }),
      tags('aws_s3_bucket', 'azurerm_storage_account', 'google_storage_bucket', 'oci_objectstorage_bucket'),
    ],
    mapSection: { aws: 'aws-storage', azure: 'az-storage', google: 'gcp-storage', oci: 'oci-storage' },
    source: SEEDED,
  },
  {
    id: 'storage.block',
    domain: 'storage',
    label: 'Block volume (data disk)',
    per: {
      aws: cell(['aws_ebs_volume'], { supporting: ['aws_volume_attachment'] }),
      azure: cell(['azurerm_managed_disk'], { supporting: ['azurerm_virtual_machine_data_disk_attachment', 'azurerm_disk_encryption_set'] }),
      google: cell(['google_compute_disk'], { supporting: ['google_compute_attached_disk'] }),
      oci: cell(['oci_core_volume'], { supporting: ['oci_core_volume_attachment'] }),
      vmware: cell(['vsphere_virtual_disk'], { note: 'Usually a disk block on vsphere_virtual_machine; a standalone virtual disk otherwise.' }),
    },
    attributes: [
      attr('size.gib', {
        aws: at('aws_ebs_volume', 'size', 'gib'),
        azure: at('azurerm_managed_disk', 'disk_size_gb', 'gib'),
        google: at('google_compute_disk', 'size', 'gib'),
        oci: at('oci_core_volume', 'size_in_gbs', 'gib'),
        vmware: at('vsphere_virtual_disk', 'size', 'gib'),
      }),
      attr('iops', {
        aws: at('aws_ebs_volume', 'iops'),
        azure: at('azurerm_managed_disk', 'disk_iops_read_write'),
        google: at('google_compute_disk', 'provisioned_iops'),
      }),
      attr('throughput.mbps', {
        aws: at('aws_ebs_volume', 'throughput'),
        google: at('google_compute_disk', 'provisioned_throughput'),
      }),
      attr('zone', {
        aws: at('aws_ebs_volume', 'availability_zone', 'zone'),
        azure: at('azurerm_managed_disk', 'zone', 'zone'),
        google: at('google_compute_disk', 'zone', 'zone'),
        oci: at('oci_core_volume', 'availability_domain', 'zone'),
      }),
      attr('encryption.key', {
        aws: at('aws_ebs_volume', 'kms_key_id', 'lz-kms'),
        oci: at('oci_core_volume', 'kms_key_id', 'lz-kms'),
      }),
      attr('name', { azure: at('azurerm_managed_disk', 'name'), google: at('google_compute_disk', 'name'), oci: at('oci_core_volume', 'display_name') }),
      tags('aws_ebs_volume', 'azurerm_managed_disk', 'google_compute_disk', 'oci_core_volume'),
    ],
    mapSection: { aws: 'aws-storage', oci: 'oci-storage' },
    source: SEEDED,
  },
  {
    id: 'storage.snapshot',
    domain: 'storage',
    label: 'Volume snapshot',
    per: {
      aws: cell(['aws_ebs_snapshot']),
      azure: cell(['azurerm_snapshot']),
      google: cell(['google_compute_snapshot']),
      oci: cell(['oci_core_volume_backup']),
      vmware: none('A VM snapshot is an operation, not a declared resource; it does not belong in the application\'s configuration.'),
    },
    attributes: [
      attr('name', { azure: at('azurerm_snapshot', 'name'), google: at('google_compute_snapshot', 'name'), oci: at('oci_core_volume_backup', 'display_name') }),
      tags('aws_ebs_snapshot', 'azurerm_snapshot', 'google_compute_snapshot', 'oci_core_volume_backup'),
    ],
    mapSection: { aws: 'aws-storage' },
    source: SOURCE,
  },
  {
    id: 'storage.file.nfs',
    domain: 'storage',
    label: 'Shared file storage (NFS)',
    per: {
      aws: cell(['aws_efs_file_system'], { supporting: ['aws_efs_mount_target'] }),
      azure: cell(['azurerm_storage_share'], {
        match: { azurerm_storage_share: { key: 'r.enabled_protocol', pattern: '^NFS$' } },
        note: 'Azure Files over NFS (premium FileStorage account).',
      }),
      google: cell(['google_filestore_instance']),
      oci: cell(['oci_file_storage_file_system'], { supporting: ['oci_file_storage_mount_target', 'oci_file_storage_export'] }),
      vmware: none('vSAN File Services are enabled on the cluster by the platform team, not per application.'),
    },
    attributes: [
      attr('name', {
        azure: at('azurerm_storage_share', 'name'),
        google: at('google_filestore_instance', 'name'),
        oci: at('oci_file_storage_file_system', 'display_name'),
      }),
      attr('encryption.key', {
        aws: at('aws_efs_file_system', 'kms_key_id', 'lz-kms'),
        google: at('google_filestore_instance', 'kms_key_name', 'lz-kms'),
        oci: at('oci_file_storage_file_system', 'kms_key_id', 'lz-kms'),
      }),
      attr('zone', { oci: at('oci_file_storage_file_system', 'availability_domain', 'zone'), aws: at('aws_efs_file_system', 'availability_zone_name', 'zone') }),
      tags('aws_efs_file_system', undefined, 'google_filestore_instance', 'oci_file_storage_file_system'),
    ],
    mapSection: { aws: 'aws-storage', azure: 'az-storage', oci: 'oci-storage' },
    source: SEEDED,
  },
  {
    id: 'storage.file.smb',
    domain: 'storage',
    label: 'Windows file share (SMB)',
    per: {
      aws: cell(['aws_fsx_windows_file_system']),
      azure: cell(['azurerm_storage_share']),
      google: cell(['google_netapp_volume'], { note: 'Google Cloud NetApp Volumes, which serves SMB.' }),
      oci: none('OCI File Storage serves NFS only; an SMB share runs on a Windows file server VM (compute.vm).'),
      vmware: none('An SMB share runs on a Windows file server VM (compute.vm).'),
    },
    attributes: [
      attr('name', { azure: at('azurerm_storage_share', 'name'), google: at('google_netapp_volume', 'name') }),
      attr('size.gib', {
        aws: at('aws_fsx_windows_file_system', 'storage_capacity', 'gib'),
        azure: at('azurerm_storage_share', 'quota', 'gib'),
        google: at('google_netapp_volume', 'capacity_gib', 'gib'),
      }),
    ],
    mapSection: { aws: 'aws-storage', azure: 'az-storage' },
    source: SOURCE,
  },

  // ============================================================ backup ===
  {
    id: 'backup.policy',
    domain: 'backup',
    label: 'Managed backup (vault, plan, selection)',
    per: {
      aws: cell(['aws_backup_plan', 'aws_backup_vault'], { supporting: ['aws_backup_selection', 'aws_backup_vault_lock_configuration'] }),
      azure: cell(['azurerm_backup_policy_vm', 'azurerm_recovery_services_vault'], { supporting: ['azurerm_backup_protected_vm', 'azurerm_backup_policy_vm_workload'] }),
      google: cell(['google_backup_dr_backup_plan', 'google_backup_dr_backup_vault'], { supporting: ['google_backup_dr_backup_plan_association'] }),
      oci: cell(['oci_core_volume_backup_policy'], { supporting: ['oci_core_volume_backup_policy_assignment'] }),
      vmware: none('Backup of VCF workloads is a third-party or VCF-level service, not in the catalogued VMware providers.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_backup_plan', 'name'),
        azure: at('azurerm_backup_policy_vm', 'name'),
        google: at('google_backup_dr_backup_plan', 'backup_plan_id'),
        oci: at('oci_core_volume_backup_policy', 'display_name'),
      }),
      attr('encryption.key', { aws: at('aws_backup_vault', 'kms_key_arn', 'lz-kms') }),
      tags('aws_backup_plan', 'azurerm_recovery_services_vault', undefined, 'oci_core_volume_backup_policy'),
    ],
    mapSection: { aws: 'aws-storage' },
    source: SEEDED,
  },

  // ========================================================== database ===
  {
    id: 'db.postgres.managed',
    domain: 'database',
    label: 'Managed PostgreSQL',
    per: {
      aws: cell(['aws_db_instance'], {
        match: { aws_db_instance: { key: 'r.engine', pattern: '^postgres$' } },
        supporting: ['aws_db_subnet_group', 'aws_db_parameter_group'],
      }),
      azure: cell(['azurerm_postgresql_flexible_server'], { supporting: ['azurerm_postgresql_flexible_server_active_directory_administrator'] }),
      google: cell(['google_sql_database_instance'], {
        match: { google_sql_database_instance: { key: 'r.database_version', pattern: '^POSTGRES' } },
        supporting: ['google_sql_user'],
      }),
      oci: cell(['oci_psql_db_system']),
      vmware: none(NO_VMWARE_MANAGED_DB),
    },
    attributes: [
      attr('name', {
        aws: at('aws_db_instance', 'identifier'),
        azure: at('azurerm_postgresql_flexible_server', 'name'),
        google: at('google_sql_database_instance', 'name'),
        oci: at('oci_psql_db_system', 'display_name'),
      }),
      attr('engine.version', {
        aws: at('aws_db_instance', 'engine_version', 'db-version'),
        azure: at('azurerm_postgresql_flexible_server', 'version', 'db-version'),
        google: at('google_sql_database_instance', 'database_version', 'db-version'),
        oci: at('oci_psql_db_system', 'db_version', 'db-version'),
      }),
      attr('size', {
        aws: at('aws_db_instance', 'instance_class', 'db-class'),
        azure: at('azurerm_postgresql_flexible_server', 'sku_name', 'db-class'),
        google: at('google_sql_database_instance', 'settings.tier', 'db-class'),
        oci: at('oci_psql_db_system', 'shape', 'db-class', { ocpus: 'instance_ocpu_count', memoryGib: 'instance_memory_size_in_gbs' }),
      }),
      attr('storage.gib', {
        aws: at('aws_db_instance', 'allocated_storage', 'gib'),
        google: at('google_sql_database_instance', 'settings.disk_size', 'gib'),
      }),
      attr('backup.retention.days', {
        aws: at('aws_db_instance', 'backup_retention_period', 'retention'),
        azure: at('azurerm_postgresql_flexible_server', 'backup_retention_days', 'retention'),
      }),
      attr('ha', {
        aws: at('aws_db_instance', 'multi_az', 'ha-mode'),
        azure: at('azurerm_postgresql_flexible_server', 'high_availability.mode', 'ha-mode'),
        google: at('google_sql_database_instance', 'settings.availability_type', 'ha-mode'),
      }),
      attr('encryption.key', { aws: at('aws_db_instance', 'kms_key_id', 'lz-kms'), google: at('google_sql_database_instance', 'encryption_key_name', 'lz-kms') }),
      attr('subnet', { azure: at('azurerm_postgresql_flexible_server', 'delegated_subnet_id', 'lz-subnet') }),
      attr('public-access', {
        aws: at('aws_db_instance', 'publicly_accessible', 'bool'),
        azure: at('azurerm_postgresql_flexible_server', 'public_network_access_enabled', 'bool'),
      }),
      tags('aws_db_instance', 'azurerm_postgresql_flexible_server', undefined, 'oci_psql_db_system'),
    ],
    mapSection: { aws: 'aws-database', azure: 'az-database', google: 'gcp-storage' },
    source: SEEDED,
  },
  {
    id: 'db.mysql.managed',
    domain: 'database',
    label: 'Managed MySQL / MariaDB',
    per: {
      aws: cell(['aws_db_instance'], {
        match: { aws_db_instance: { key: 'r.engine', pattern: '^(mysql|mariadb)$' } },
        supporting: ['aws_db_subnet_group', 'aws_db_parameter_group', 'aws_db_option_group'],
      }),
      azure: cell(['azurerm_mysql_flexible_server']),
      google: cell(['google_sql_database_instance'], { match: { google_sql_database_instance: { key: 'r.database_version', pattern: '^MYSQL' } } }),
      oci: cell(['oci_mysql_mysql_db_system']),
      vmware: none(NO_VMWARE_MANAGED_DB),
    },
    attributes: [
      attr('name', {
        aws: at('aws_db_instance', 'identifier'),
        azure: at('azurerm_mysql_flexible_server', 'name'),
        google: at('google_sql_database_instance', 'name'),
        oci: at('oci_mysql_mysql_db_system', 'display_name'),
      }),
      attr('engine.version', {
        aws: at('aws_db_instance', 'engine_version', 'db-version'),
        azure: at('azurerm_mysql_flexible_server', 'version', 'db-version'),
        google: at('google_sql_database_instance', 'database_version', 'db-version'),
        oci: at('oci_mysql_mysql_db_system', 'mysql_version', 'db-version'),
      }),
      attr('size', {
        aws: at('aws_db_instance', 'instance_class', 'db-class'),
        azure: at('azurerm_mysql_flexible_server', 'sku_name', 'db-class'),
        google: at('google_sql_database_instance', 'settings.tier', 'db-class'),
      }),
      attr('storage.gib', {
        aws: at('aws_db_instance', 'allocated_storage', 'gib'),
        google: at('google_sql_database_instance', 'settings.disk_size', 'gib'),
        oci: at('oci_mysql_mysql_db_system', 'data_storage_size_in_gb', 'gib'),
      }),
      attr('backup.retention.days', {
        aws: at('aws_db_instance', 'backup_retention_period', 'retention'),
        azure: at('azurerm_mysql_flexible_server', 'backup_retention_days', 'retention'),
      }),
      attr('subnet', { azure: at('azurerm_mysql_flexible_server', 'delegated_subnet_id', 'lz-subnet'), oci: at('oci_mysql_mysql_db_system', 'subnet_id', 'lz-subnet') }),
      tags('aws_db_instance', 'azurerm_mysql_flexible_server', undefined, 'oci_mysql_mysql_db_system'),
    ],
    mapSection: { aws: 'aws-database', google: 'gcp-storage' },
    source: SOURCE,
  },
  {
    id: 'db.sqlserver.managed',
    domain: 'database',
    label: 'Managed SQL Server',
    per: {
      aws: cell(['aws_db_instance'], {
        match: { aws_db_instance: { key: 'r.engine', pattern: '^sqlserver' } },
        supporting: ['aws_db_subnet_group', 'aws_db_option_group', 'aws_db_parameter_group'],
      }),
      azure: cell(['azurerm_mssql_server', 'azurerm_mssql_database'], {
        supporting: ['azurerm_mssql_virtual_network_rule'],
        alternatives: [{ type: 'azurerm_mssql_managed_instance' }],
        note: 'Azure SQL Database; SQL Managed Instance (azurerm_mssql_managed_instance) is the instance-scoped alternative.',
      }),
      google: cell(['google_sql_database_instance'], { match: { google_sql_database_instance: { key: 'r.database_version', pattern: '^SQLSERVER' } } }),
      oci: none('OCI has no managed SQL Server; it runs on a VM (compute.vm).'),
      vmware: none(NO_VMWARE_MANAGED_DB),
    },
    attributes: [
      attr('name', {
        aws: at('aws_db_instance', 'identifier'),
        azure: at('azurerm_mssql_server', 'name'),
        google: at('google_sql_database_instance', 'name'),
      }),
      attr('size', {
        aws: at('aws_db_instance', 'instance_class', 'db-class'),
        azure: at('azurerm_mssql_database', 'sku_name', 'db-class'),
        google: at('google_sql_database_instance', 'settings.tier', 'db-class'),
      }),
      attr('storage.gib', {
        aws: at('aws_db_instance', 'allocated_storage', 'gib'),
        azure: at('azurerm_mssql_database', 'max_size_gb', 'gib'),
        google: at('google_sql_database_instance', 'settings.disk_size', 'gib'),
      }),
      attr('ha', {
        aws: at('aws_db_instance', 'multi_az', 'ha-mode'),
        azure: at('azurerm_mssql_database', 'zone_redundant', 'ha-mode'),
        google: at('google_sql_database_instance', 'settings.availability_type', 'ha-mode'),
      }),
      tags('aws_db_instance', 'azurerm_mssql_database'),
    ],
    mapSection: { aws: 'aws-database', azure: 'az-database' },
    source: SEEDED,
  },
  {
    id: 'db.cluster.aurora-class',
    domain: 'database',
    label: 'Cloud-native relational cluster (Aurora / AlloyDB class)',
    per: {
      aws: cell(['aws_rds_cluster'], { supporting: ['aws_rds_cluster_instance', 'aws_rds_cluster_parameter_group', 'aws_db_subnet_group'] }),
      azure: none('No Aurora-class engine on Azure: the nearest is PostgreSQL / MySQL flexible server with high availability (db.postgres.managed, db.mysql.managed).'),
      google: cell(['google_alloydb_cluster'], { supporting: ['google_alloydb_instance'] }),
      oci: none('No Aurora-class engine on OCI: the nearest is OCI Database with PostgreSQL or HeatWave MySQL (db.postgres.managed, db.mysql.managed).'),
      vmware: none(NO_VMWARE_MANAGED_DB),
    },
    attributes: [
      attr('name', { aws: at('aws_rds_cluster', 'cluster_identifier'), google: at('google_alloydb_cluster', 'cluster_id') }),
      attr('encryption.key', { aws: at('aws_rds_cluster', 'kms_key_id', 'lz-kms') }),
      attr('backup.retention.days', { aws: at('aws_rds_cluster', 'backup_retention_period', 'retention') }),
      tags('aws_rds_cluster', undefined, 'google_alloydb_cluster'),
    ],
    mapSection: { aws: 'aws-database' },
    source: SOURCE,
  },
  {
    id: 'db.oracle.managed',
    domain: 'database',
    label: 'Managed Oracle Database (single instance)',
    per: {
      aws: cell(['aws_db_instance'], {
        match: { aws_db_instance: { key: 'r.engine', pattern: '^oracle' } },
        supporting: ['aws_db_subnet_group', 'aws_db_option_group', 'aws_db_parameter_group'],
      }),
      azure: none('No managed single-instance Oracle on Azure apart from Oracle Database@Azure (db.oracle.exadata, db.oracle.autonomous).'),
      google: none('No managed single-instance Oracle on Google Cloud apart from Oracle Database@Google Cloud (db.oracle.exadata, db.oracle.autonomous).'),
      oci: cell(['oci_database_db_system'], { supporting: ['oci_database_data_guard_association'] }),
      vmware: none(NO_VMWARE_MANAGED_DB),
    },
    attributes: [
      attr('name', { aws: at('aws_db_instance', 'identifier'), oci: at('oci_database_db_system', 'display_name') }),
      attr('storage.gib', { aws: at('aws_db_instance', 'allocated_storage', 'gib'), oci: at('oci_database_db_system', 'data_storage_size_in_gb', 'gib') }),
      attr('subnet', { oci: at('oci_database_db_system', 'subnet_id', 'lz-subnet') }),
      tags('aws_db_instance', undefined, undefined, 'oci_database_db_system'),
    ],
    mapSection: { aws: 'aws-database', oci: 'oci-database' },
    source: SOURCE,
  },
  {
    id: 'db.oracle.exadata',
    domain: 'database',
    label: 'Oracle Exadata VM cluster',
    per: {
      aws: cell(['aws_odb_cloud_vm_cluster', 'aws_odb_cloud_exadata_infrastructure'], { supporting: ['aws_odb_network', 'aws_odb_network_peering_connection'] }),
      azure: cell(['azurerm_oracle_cloud_vm_cluster', 'azurerm_oracle_exadata_infrastructure']),
      google: cell(['google_oracle_database_cloud_vm_cluster', 'google_oracle_database_cloud_exadata_infrastructure'], {
        supporting: ['google_oracle_database_odb_network', 'google_oracle_database_odb_subnet'],
      }),
      oci: cell(['oci_database_cloud_vm_cluster', 'oci_database_cloud_exadata_infrastructure'], { supporting: ['oci_database_db_home', 'oci_database_database'] }),
      vmware: none('Exadata is not a VCF workload; the Oracle databases run on VMs (compute.vm) or move to an Oracle Database@ service.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_odb_cloud_vm_cluster', 'display_name'),
        azure: at('azurerm_oracle_cloud_vm_cluster', 'display_name'),
        google: at('google_oracle_database_cloud_vm_cluster', 'display_name'),
        oci: at('oci_database_cloud_vm_cluster', 'display_name'),
      }),
    ],
    mapSection: { oci: 'oci-database' },
    source: SOURCE,
  },
  {
    id: 'db.oracle.autonomous',
    domain: 'database',
    label: 'Oracle Autonomous Database',
    per: {
      aws: cell(['aws_odb_cloud_autonomous_vm_cluster']),
      azure: cell(['azurerm_oracle_autonomous_database']),
      google: cell(['google_oracle_database_autonomous_database']),
      oci: cell(['oci_database_autonomous_database']),
      vmware: none(NO_VMWARE_MANAGED_DB),
    },
    attributes: [
      attr('name', {
        aws: at('aws_odb_cloud_autonomous_vm_cluster', 'display_name'),
        azure: at('azurerm_oracle_autonomous_database', 'display_name'),
        oci: at('oci_database_autonomous_database', 'display_name'),
      }),
    ],
    mapSection: { oci: 'oci-database' },
    source: SOURCE,
  },
  {
    id: 'db.nosql',
    domain: 'database',
    label: 'Managed NoSQL (key-value / document)',
    per: {
      aws: cell(['aws_dynamodb_table']),
      azure: cell(['azurerm_cosmosdb_account'], { supporting: ['azurerm_cosmosdb_sql_database', 'azurerm_cosmosdb_sql_container'] }),
      google: cell(['google_firestore_database']),
      oci: cell(['oci_nosql_table']),
      vmware: none(NO_VMWARE_MANAGED_DB),
    },
    attributes: [
      attr('name', {
        aws: at('aws_dynamodb_table', 'name'),
        azure: at('azurerm_cosmosdb_account', 'name'),
        google: at('google_firestore_database', 'name'),
        oci: at('oci_nosql_table', 'name'),
      }),
      tags('aws_dynamodb_table', 'azurerm_cosmosdb_account', undefined, 'oci_nosql_table'),
    ],
    mapSection: { aws: 'aws-database', azure: 'az-database' },
    source: SEEDED,
  },
  {
    id: 'db.cache',
    domain: 'database',
    label: 'In-memory cache (Redis-compatible)',
    per: {
      aws: cell(['aws_elasticache_replication_group'], { supporting: ['aws_elasticache_subnet_group'], alternatives: [{ type: 'aws_elasticache_cluster' }] }),
      azure: cell(['azurerm_redis_cache'], { alternatives: [{ type: 'azurerm_managed_redis' }] }),
      google: cell(['google_redis_instance']),
      oci: cell(['oci_redis_redis_cluster']),
      vmware: none(NO_VMWARE_MANAGED_DB),
    },
    attributes: [
      attr('name', {
        aws: at('aws_elasticache_replication_group', 'replication_group_id'),
        azure: at('azurerm_redis_cache', 'name'),
        google: at('google_redis_instance', 'name'),
        oci: at('oci_redis_redis_cluster', 'display_name'),
      }),
      attr('engine.version', {
        aws: at('aws_elasticache_replication_group', 'engine_version'),
        azure: at('azurerm_redis_cache', 'redis_version'),
        google: at('google_redis_instance', 'redis_version'),
        oci: at('oci_redis_redis_cluster', 'software_version'),
      }),
      attr('memory.gib', { google: at('google_redis_instance', 'memory_size_gb', 'gib'), oci: at('oci_redis_redis_cluster', 'node_memory_in_gbs', 'gib') }),
      attr('subnet', { azure: at('azurerm_redis_cache', 'subnet_id', 'lz-subnet'), oci: at('oci_redis_redis_cluster', 'subnet_id', 'lz-subnet') }),
      tags('aws_elasticache_replication_group', 'azurerm_redis_cache', 'google_redis_instance', 'oci_redis_redis_cluster'),
    ],
    mapSection: { aws: 'aws-database' },
    source: SEEDED,
  },
  {
    id: 'db.warehouse',
    domain: 'database',
    label: 'Data warehouse',
    per: {
      aws: cell(['aws_redshift_cluster']),
      azure: cell(['azurerm_synapse_workspace'], { supporting: ['azurerm_synapse_sql_pool'] }),
      google: cell(['google_bigquery_dataset'], { supporting: ['google_bigquery_table'] }),
      oci: cell(['oci_bds_bds_instance'], { note: 'Big Data Service, as services.ts has it; Autonomous Data Warehouse is db.oracle.autonomous with a DW workload.' }),
      vmware: none(NO_VMWARE_MANAGED_DB),
    },
    attributes: [
      attr('name', {
        aws: at('aws_redshift_cluster', 'cluster_identifier'),
        azure: at('azurerm_synapse_workspace', 'name'),
        google: at('google_bigquery_dataset', 'dataset_id'),
        oci: at('oci_bds_bds_instance', 'display_name'),
      }),
      tags('aws_redshift_cluster', 'azurerm_synapse_workspace', 'google_bigquery_dataset', 'oci_bds_bds_instance'),
    ],
    mapSection: { aws: 'aws-database', azure: 'az-database', google: 'gcp-storage' },
    source: SEEDED,
  },

  // ======================================================= integration ===
  {
    id: 'integration.queue',
    domain: 'integration',
    label: 'Message queue',
    per: {
      aws: cell(['aws_sqs_queue']),
      azure: cell(['azurerm_servicebus_queue'], { supporting: ['azurerm_servicebus_namespace'], alternatives: [{ type: 'azurerm_storage_queue' }] }),
      google: cell(['google_pubsub_subscription'], { supporting: ['google_pubsub_topic'], note: 'A Pub/Sub pull subscription on its topic.' }),
      oci: cell(['oci_queue_queue']),
      vmware: none('No managed queue in VCF: run the broker (RabbitMQ, IBM MQ, Kafka) on VMs or on vSphere Supervisor.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_sqs_queue', 'name'),
        azure: at('azurerm_servicebus_queue', 'name'),
        google: at('google_pubsub_subscription', 'name'),
        oci: at('oci_queue_queue', 'display_name'),
      }),
      attr('retention.seconds', {
        aws: at('aws_sqs_queue', 'message_retention_seconds'),
        oci: at('oci_queue_queue', 'retention_in_seconds'),
      }),
      attr('visibility.seconds', {
        aws: at('aws_sqs_queue', 'visibility_timeout_seconds'),
        oci: at('oci_queue_queue', 'visibility_in_seconds'),
      }),
      attr('encryption.key', { aws: at('aws_sqs_queue', 'kms_master_key_id', 'lz-kms'), oci: at('oci_queue_queue', 'custom_encryption_key_id', 'lz-kms') }),
      tags('aws_sqs_queue', undefined, 'google_pubsub_subscription', 'oci_queue_queue'),
    ],
    mapSection: { aws: 'aws-database', azure: 'az-storage' },
    source: SEEDED,
  },
  {
    id: 'integration.topic',
    domain: 'integration',
    label: 'Publish / subscribe topic and notifications',
    per: {
      aws: cell(['aws_sns_topic']),
      azure: cell(['azurerm_servicebus_topic'], { supporting: ['azurerm_servicebus_namespace'] }),
      google: cell(['google_pubsub_topic']),
      oci: cell(['oci_ons_notification_topic']),
      vmware: none('No managed topic in VCF: run the broker on VMs or on vSphere Supervisor.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_sns_topic', 'name'),
        azure: at('azurerm_servicebus_topic', 'name'),
        google: at('google_pubsub_topic', 'name'),
        oci: at('oci_ons_notification_topic', 'name'),
      }),
      attr('encryption.key', { aws: at('aws_sns_topic', 'kms_master_key_id', 'lz-kms'), google: at('google_pubsub_topic', 'kms_key_name', 'lz-kms') }),
      tags('aws_sns_topic', undefined, 'google_pubsub_topic', 'oci_ons_notification_topic'),
    ],
    mapSection: { aws: 'aws-database' },
    source: SOURCE,
  },
  {
    id: 'integration.stream',
    domain: 'integration',
    label: 'Event stream (Kafka-class)',
    per: {
      aws: cell(['aws_kinesis_stream']),
      azure: cell(['azurerm_eventhub'], { supporting: ['azurerm_eventhub_namespace'] }),
      google: cell(['google_managed_kafka_cluster']),
      oci: cell(['oci_streaming_stream']),
      vmware: none('No managed stream in VCF: run Kafka on VMs or on vSphere Supervisor.'),
    },
    attributes: [
      attr('name', { aws: at('aws_kinesis_stream', 'name'), azure: at('azurerm_eventhub', 'name'), oci: at('oci_streaming_stream', 'name') }),
      attr('partitions', {
        aws: at('aws_kinesis_stream', 'shard_count'),
        azure: at('azurerm_eventhub', 'partition_count'),
        oci: at('oci_streaming_stream', 'partitions'),
      }),
    ],
    mapSection: { aws: 'aws-database' },
    source: SOURCE,
  },
  {
    id: 'integration.event-rule',
    domain: 'integration',
    label: 'Event routing rule',
    per: {
      aws: cell(['aws_cloudwatch_event_rule']),
      azure: cell(['azurerm_eventgrid_topic']),
      google: cell(['google_eventarc_trigger']),
      oci: cell(['oci_events_rule']),
      vmware: none('No event bus in the catalogued VMware providers.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_cloudwatch_event_rule', 'name'),
        azure: at('azurerm_eventgrid_topic', 'name'),
        google: at('google_eventarc_trigger', 'name'),
        oci: at('oci_events_rule', 'display_name'),
      }),
    ],
    mapSection: { aws: 'aws-governance', oci: 'oci-security' },
    source: SOURCE,
  },
  {
    id: 'integration.config-store',
    domain: 'integration',
    label: 'Parameter / configuration store',
    per: {
      aws: cell(['aws_ssm_parameter']),
      azure: cell(['azurerm_app_configuration_key'], { supporting: ['azurerm_app_configuration'] }),
      google: cell(['google_parameter_manager_parameter']),
      oci: none('OCI has no parameter store; keep settings as OCI Vault secrets (security.secret) or in the instance metadata.'),
      vmware: none('No parameter store in VCF: settings go in the Ansible variables (Configuration tab).'),
    },
    attributes: [
      attr('name', { aws: at('aws_ssm_parameter', 'name'), azure: at('azurerm_app_configuration_key', 'key'), google: at('google_parameter_manager_parameter', 'parameter_id') }),
      attr('encryption.key', { aws: at('aws_ssm_parameter', 'key_id', 'lz-kms') }),
    ],
    mapSection: { aws: 'aws-governance' },
    source: SOURCE,
  },

  // ========================================================== security ===
  {
    id: 'security.kms-key',
    domain: 'security',
    label: 'Encryption key (KMS)',
    per: {
      aws: cell(['aws_kms_key'], { supporting: ['aws_kms_alias'] }),
      azure: cell(['azurerm_key_vault', 'azurerm_key_vault_key'], { supporting: ['azurerm_disk_encryption_set'] }),
      google: cell(['google_kms_crypto_key', 'google_kms_key_ring']),
      oci: cell(['oci_kms_key', 'oci_kms_vault']),
      vmware: none('VM encryption uses a key provider configured on vCenter by the platform team; there is no per-application key.'),
    },
    attributes: [
      attr('name', {
        azure: at('azurerm_key_vault_key', 'name'),
        google: at('google_kms_crypto_key', 'name'),
        oci: at('oci_kms_key', 'display_name'),
      }),
      attr('rotation', {
        aws: at('aws_kms_key', 'enable_key_rotation', 'bool'),
        oci: at('oci_kms_key', 'is_auto_rotation_enabled', 'bool'),
      }),
      tags('aws_kms_key', 'azurerm_key_vault_key', 'google_kms_crypto_key', 'oci_kms_key'),
    ],
    mapSection: { aws: 'aws-governance', azure: 'az-governance', google: 'gcp-security', oci: 'oci-security' },
    source: SEEDED,
  },
  {
    id: 'security.secret',
    domain: 'security',
    label: 'Secret',
    per: {
      aws: cell(['aws_secretsmanager_secret'], { supporting: ['aws_secretsmanager_secret_version'] }),
      azure: cell(['azurerm_key_vault_secret'], { supporting: ['azurerm_key_vault'] }),
      google: cell(['google_secret_manager_secret']),
      oci: cell(['oci_vault_secret']),
      vmware: none('No secret store in VCF: secrets stay in the organisation\'s vault and Ansible vault variables.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_secretsmanager_secret', 'name'),
        azure: at('azurerm_key_vault_secret', 'name'),
        google: at('google_secret_manager_secret', 'secret_id'),
        oci: at('oci_vault_secret', 'secret_name'),
      }),
      attr('encryption.key', { aws: at('aws_secretsmanager_secret', 'kms_key_id', 'lz-kms'), oci: at('oci_vault_secret', 'key_id', 'lz-kms') }),
      tags('aws_secretsmanager_secret', 'azurerm_key_vault_secret', 'google_secret_manager_secret', 'oci_vault_secret'),
    ],
    mapSection: { aws: 'aws-governance', azure: 'az-governance' },
    source: SEEDED,
  },
  {
    id: 'security.certificate',
    domain: 'security',
    label: 'TLS certificate',
    per: {
      aws: cell(['aws_acm_certificate']),
      azure: cell(['azurerm_key_vault_certificate']),
      google: cell(['google_certificate_manager_certificate']),
      oci: cell(['oci_certificates_management_certificate']),
      vmware: none('Certificates for applications on VCF come from the enterprise CA; the vcf_certificate resources are for the platform\'s own components.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_acm_certificate', 'domain_name'),
        azure: at('azurerm_key_vault_certificate', 'name'),
        google: at('google_certificate_manager_certificate', 'name'),
        oci: at('oci_certificates_management_certificate', 'name'),
      }),
    ],
    source: SOURCE,
  },
  {
    id: 'security.waf',
    domain: 'security',
    label: 'Web application firewall',
    per: {
      aws: cell(['aws_wafv2_web_acl'], { supporting: ['aws_wafv2_web_acl_association'] }),
      azure: cell(['azurerm_web_application_firewall_policy']),
      google: cell(['google_compute_security_policy']),
      oci: cell(['oci_waf_web_app_firewall'], { supporting: ['oci_waf_web_app_firewall_policy'] }),
      vmware: cell(['avi_wafpolicy']),
    },
    attributes: [
      attr('name', {
        aws: at('aws_wafv2_web_acl', 'name'),
        azure: at('azurerm_web_application_firewall_policy', 'name'),
        google: at('google_compute_security_policy', 'name'),
        oci: at('oci_waf_web_app_firewall', 'display_name'),
        vmware: at('avi_wafpolicy', 'name'),
      }),
    ],
    mapSection: { aws: 'aws-governance' },
    source: SOURCE,
  },
  {
    id: 'security.ddos',
    domain: 'security',
    label: 'DDoS protection',
    per: {
      aws: cell(['aws_shield_protection']),
      azure: cell(['azurerm_network_ddos_protection_plan']),
      google: none('Google Cloud Armor adaptive protection is a setting of the security policy (security.waf), not a separate resource.'),
      oci: none('OCI DDoS protection is always on for public endpoints; there is nothing to declare.'),
      vmware: none('DDoS protection sits upstream of the data centre (the carrier or a scrubbing service), not in VCF.'),
    },
    attributes: [attr('name', { aws: at('aws_shield_protection', 'name'), azure: at('azurerm_network_ddos_protection_plan', 'name') })],
    mapSection: { aws: 'aws-governance' },
    source: SOURCE,
  },
  {
    id: 'security.audit-trail',
    domain: 'security',
    label: 'Audit trail export',
    per: {
      aws: cell(['aws_cloudtrail']),
      azure: cell(['azurerm_monitor_diagnostic_setting']),
      google: cell(['google_logging_project_sink']),
      oci: cell(['oci_audit_configuration'], { note: 'OCI Audit is always on; this sets the retention.' }),
      vmware: none('vCenter and NSX audit events go to the platform\'s syslog target, set by the platform team.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_cloudtrail', 'name'),
        azure: at('azurerm_monitor_diagnostic_setting', 'name'),
        google: at('google_logging_project_sink', 'name'),
      }),
    ],
    mapSection: { aws: 'aws-governance', azure: 'az-governance', google: 'gcp-security' },
    source: SOURCE,
  },

  // ===================================================== observability ===
  {
    id: 'observability.logs',
    domain: 'observability',
    label: 'Log store (log group / workspace / bucket)',
    per: {
      aws: cell(['aws_cloudwatch_log_group']),
      azure: cell(['azurerm_log_analytics_workspace']),
      google: cell(['google_logging_project_bucket_config']),
      oci: cell(['oci_logging_log_group', 'oci_logging_log']),
      vmware: none('Logs go to VCF Operations for logs, configured by the platform team; not in the catalogued VMware providers.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_cloudwatch_log_group', 'name'),
        azure: at('azurerm_log_analytics_workspace', 'name'),
        oci: at('oci_logging_log_group', 'display_name'),
      }),
      attr('retention.days', {
        aws: at('aws_cloudwatch_log_group', 'retention_in_days', 'retention'),
        azure: at('azurerm_log_analytics_workspace', 'retention_in_days', 'retention'),
        google: at('google_logging_project_bucket_config', 'retention_days', 'retention'),
      }),
      attr('encryption.key', { aws: at('aws_cloudwatch_log_group', 'kms_key_id', 'lz-kms') }),
      tags('aws_cloudwatch_log_group', 'azurerm_log_analytics_workspace', undefined, 'oci_logging_log_group'),
    ],
    mapSection: { aws: 'aws-governance', azure: 'az-governance', google: 'gcp-security', oci: 'oci-security' },
    source: SOURCE,
  },
  {
    id: 'observability.collection',
    domain: 'observability',
    label: 'Agent data collection rule',
    per: {
      aws: none('The CloudWatch agent is configured through Systems Manager (compute.guest-config) and a parameter (integration.config-store).'),
      azure: cell(['azurerm_monitor_data_collection_rule'], { supporting: ['azurerm_monitor_data_collection_rule_association'] }),
      google: none('The Ops Agent is installed and configured by an OS policy (compute.guest-config).'),
      oci: cell(['oci_logging_unified_agent_configuration']),
      vmware: none('Guest agents are installed by Ansible (Configuration tab).'),
    },
    attributes: [
      attr('name', { azure: at('azurerm_monitor_data_collection_rule', 'name'), oci: at('oci_logging_unified_agent_configuration', 'display_name') }),
    ],
    source: SOURCE,
  },
  {
    id: 'observability.alarm',
    domain: 'observability',
    label: 'Metric alarm',
    per: {
      aws: cell(['aws_cloudwatch_metric_alarm']),
      azure: cell(['azurerm_monitor_metric_alert']),
      google: cell(['google_monitoring_alert_policy']),
      oci: cell(['oci_monitoring_alarm']),
      vmware: none('Alerts are defined in VCF Operations; not in the catalogued VMware providers.'),
    },
    attributes: [
      attr('name', {
        aws: at('aws_cloudwatch_metric_alarm', 'alarm_name'),
        azure: at('azurerm_monitor_metric_alert', 'name'),
        google: at('google_monitoring_alert_policy', 'display_name'),
        oci: at('oci_monitoring_alarm', 'display_name'),
      }),
    ],
    mapSection: { aws: 'aws-governance', google: 'gcp-security' },
    source: SOURCE,
  },
  {
    id: 'observability.notification-channel',
    domain: 'observability',
    label: 'Alert notification channel',
    per: {
      aws: none('Alarms notify an SNS topic (integration.topic); there is no separate channel object.'),
      azure: cell(['azurerm_monitor_action_group']),
      google: cell(['google_monitoring_notification_channel']),
      oci: none('Alarms notify an ONS topic (integration.topic); there is no separate channel object.'),
      vmware: none('Notification targets are set in VCF Operations.'),
    },
    attributes: [attr('name', { azure: at('azurerm_monitor_action_group', 'name'), google: at('google_monitoring_notification_channel', 'display_name') })],
    mapSection: { azure: 'az-governance', google: 'gcp-security' },
    source: SOURCE,
  },
  {
    id: 'observability.dashboard',
    domain: 'observability',
    label: 'Monitoring dashboard',
    per: {
      aws: cell(['aws_cloudwatch_dashboard']),
      azure: cell(['azurerm_portal_dashboard']),
      google: cell(['google_monitoring_dashboard']),
      oci: none('OCI dashboards are imported as saved management dashboards, not declared per application (verify).'),
      vmware: none('Dashboards are built in VCF Operations.'),
    },
    attributes: [attr('name', { aws: at('aws_cloudwatch_dashboard', 'dashboard_name'), azure: at('azurerm_portal_dashboard', 'name') })],
    mapSection: { aws: 'aws-governance' },
    source: SOURCE,
  },

  // =============================================================== dns ===
  {
    id: 'dns.zone.public',
    domain: 'dns',
    label: 'Public DNS zone',
    per: {
      aws: cell(['aws_route53_zone']),
      azure: cell(['azurerm_dns_zone']),
      google: cell(['google_dns_managed_zone']),
      oci: cell(['oci_dns_zone']),
      vmware: none('VCF has no authoritative DNS service: the zone stays in the enterprise DNS (the DNS provider on the Windows and Linux platforms).'),
    },
    attributes: [
      attr('domain', {
        aws: at('aws_route53_zone', 'name'),
        azure: at('azurerm_dns_zone', 'name'),
        google: at('google_dns_managed_zone', 'dns_name'),
        oci: at('oci_dns_zone', 'name'),
      }),
      tags('aws_route53_zone', 'azurerm_dns_zone', 'google_dns_managed_zone', 'oci_dns_zone'),
    ],
    mapSection: { aws: 'aws-networking' },
    source: SEEDED,
  },
  {
    id: 'dns.zone.private',
    domain: 'dns',
    label: 'Private DNS zone',
    per: {
      aws: cell(['aws_route53_zone'], { match: { aws_route53_zone: { key: 'b.vpc', pattern: '^true$' } } }),
      azure: cell(['azurerm_private_dns_zone'], { supporting: ['azurerm_private_dns_zone_virtual_network_link'] }),
      google: cell(['google_dns_managed_zone'], { match: { google_dns_managed_zone: { key: 'r.visibility', pattern: '^private$' } } }),
      oci: cell(['oci_dns_zone'], { match: { oci_dns_zone: { key: 'r.scope', pattern: '^PRIVATE$' } } }),
      vmware: none('VCF has no authoritative DNS service: the zone stays in the enterprise DNS.'),
    },
    attributes: [
      attr('domain', {
        aws: at('aws_route53_zone', 'name'),
        azure: at('azurerm_private_dns_zone', 'name'),
        google: at('google_dns_managed_zone', 'dns_name'),
        oci: at('oci_dns_zone', 'name'),
      }),
    ],
    mapSection: { azure: 'az-networking' },
    source: SOURCE,
  },
  {
    id: 'dns.record',
    domain: 'dns',
    label: 'DNS record',
    per: {
      aws: cell(['aws_route53_record']),
      azure: cell(['azurerm_dns_a_record'], { note: 'One resource per record type: azurerm_dns_cname_record, azurerm_dns_txt_record … for the others.' }),
      google: cell(['google_dns_record_set']),
      oci: cell(['oci_dns_rrset']),
      vmware: none('Records live in the enterprise DNS (the DNS provider on the Windows and Linux platforms).'),
    },
    attributes: [
      attr('name', { aws: at('aws_route53_record', 'name'), azure: at('azurerm_dns_a_record', 'name'), google: at('google_dns_record_set', 'name') }),
      attr('ttl', { aws: at('aws_route53_record', 'ttl'), azure: at('azurerm_dns_a_record', 'ttl'), google: at('google_dns_record_set', 'ttl') }),
      attr('records', { aws: at('aws_route53_record', 'records'), azure: at('azurerm_dns_a_record', 'records'), google: at('google_dns_record_set', 'rrdatas') }),
    ],
    mapSection: { aws: 'aws-networking' },
    source: SOURCE,
  },
  {
    id: 'dns.resolver',
    domain: 'dns',
    label: 'Hybrid DNS resolver (forwarding to and from on-premises)',
    per: {
      aws: cell(['aws_route53_resolver_endpoint'], { supporting: ['aws_route53_resolver_rule', 'aws_route53_resolver_rule_association'] }),
      azure: cell(['azurerm_private_dns_resolver'], {
        supporting: [
          'azurerm_private_dns_resolver_outbound_endpoint',
          'azurerm_private_dns_resolver_dns_forwarding_ruleset',
          'azurerm_private_dns_resolver_forwarding_rule',
          'azurerm_private_dns_resolver_virtual_network_link',
        ],
      }),
      google: cell(['google_dns_managed_zone'], {
        match: { google_dns_managed_zone: { key: 'b.forwarding_config', pattern: '^true$' } },
        note: 'A forwarding zone; inbound forwarding is a DNS server policy.',
      }),
      oci: cell(['oci_dns_resolver'], { supporting: ['oci_dns_resolver_endpoint'] }),
      vmware: cell(['nsxt_policy_gateway_dns_forwarder'], { supporting: ['nsxt_policy_dns_forwarder_zone'] }),
    },
    attributes: [
      attr('name', {
        aws: at('aws_route53_resolver_endpoint', 'name'),
        azure: at('azurerm_private_dns_resolver', 'name'),
        google: at('google_dns_managed_zone', 'name'),
        oci: at('oci_dns_resolver', 'display_name'),
        vmware: at('nsxt_policy_gateway_dns_forwarder', 'display_name'),
      }),
    ],
    mapSection: { aws: 'aws-networking' },
    source: SOURCE,
  },

  // ================================================================ lb ===
  {
    id: 'lb.l7',
    domain: 'lb',
    label: 'Application (layer 7) load balancer',
    per: {
      aws: cell(['aws_lb'], { supporting: ['aws_lb_target_group', 'aws_lb_listener', 'aws_lb_listener_rule'] }),
      azure: cell(['azurerm_application_gateway']),
      google: cell(['google_compute_url_map', 'google_compute_target_https_proxy', 'google_compute_global_forwarding_rule'], { supporting: ['google_compute_backend_service'] }),
      oci: cell(['oci_load_balancer_load_balancer'], { supporting: ['oci_load_balancer_backend_set', 'oci_load_balancer_listener'] }),
      vmware: cell(['avi_virtualservice'], { supporting: ['avi_pool'], note: 'Avi Load Balancer, the load balancer for VCF.' }),
    },
    attributes: [
      attr('name', {
        aws: at('aws_lb', 'name'),
        azure: at('azurerm_application_gateway', 'name'),
        google: at('google_compute_url_map', 'name'),
        oci: at('oci_load_balancer_load_balancer', 'display_name'),
        vmware: at('avi_virtualservice', 'name'),
      }),
      attr('subnet', {
        aws: at('aws_lb', 'subnets', 'lz-subnet'),
        azure: at('azurerm_application_gateway', 'gateway_ip_configuration.subnet_id', 'lz-subnet'),
        oci: at('oci_load_balancer_load_balancer', 'subnet_ids', 'lz-subnet'),
      }),
      attr('security-groups', { aws: at('aws_lb', 'security_groups', 'lz-sg'), oci: at('oci_load_balancer_load_balancer', 'network_security_group_ids', 'lz-sg') }),
      tags('aws_lb', 'azurerm_application_gateway', undefined, 'oci_load_balancer_load_balancer'),
    ],
    mapSection: { aws: 'aws-compute' },
    source: SEEDED,
  },
  {
    id: 'lb.l4',
    domain: 'lb',
    label: 'Network (layer 4) load balancer',
    per: {
      aws: cell(['aws_lb'], {
        match: { aws_lb: { key: 'r.load_balancer_type', pattern: '^(network|gateway)$' } },
        supporting: ['aws_lb_target_group', 'aws_lb_listener'],
      }),
      azure: cell(['azurerm_lb'], { supporting: ['azurerm_lb_backend_address_pool', 'azurerm_lb_rule', 'azurerm_lb_probe'] }),
      google: cell(['google_compute_forwarding_rule'], { supporting: ['google_compute_region_backend_service'] }),
      oci: cell(['oci_network_load_balancer_network_load_balancer'], { supporting: ['oci_network_load_balancer_backend_set', 'oci_network_load_balancer_listener'] }),
      vmware: cell(['avi_virtualservice'], {
        match: { avi_virtualservice: { key: 'r.application_profile_ref', pattern: 'L4|TCP|UDP' } },
        supporting: ['avi_pool'],
      }),
    },
    attributes: [
      attr('name', {
        aws: at('aws_lb', 'name'),
        azure: at('azurerm_lb', 'name'),
        google: at('google_compute_forwarding_rule', 'name'),
        oci: at('oci_network_load_balancer_network_load_balancer', 'display_name'),
        vmware: at('avi_virtualservice', 'name'),
      }),
      attr('subnet', {
        aws: at('aws_lb', 'subnets', 'lz-subnet'),
        azure: at('azurerm_lb', 'frontend_ip_configuration.subnet_id', 'lz-subnet'),
        google: at('google_compute_forwarding_rule', 'subnetwork', 'lz-subnet'),
        oci: at('oci_network_load_balancer_network_load_balancer', 'subnet_id', 'lz-subnet'),
      }),
      tags('aws_lb', 'azurerm_lb', 'google_compute_forwarding_rule', 'oci_network_load_balancer_network_load_balancer'),
    ],
    mapSection: { aws: 'aws-compute' },
    source: SEEDED,
  },
  {
    id: 'lb.cdn',
    domain: 'lb',
    label: 'Content delivery (CDN)',
    per: {
      aws: cell(['aws_cloudfront_distribution']),
      azure: cell(['azurerm_cdn_frontdoor_profile'], { supporting: ['azurerm_cdn_frontdoor_endpoint'], alternatives: [{ type: 'azurerm_cdn_profile' }] }),
      google: none('Cloud CDN is enable_cdn on the backend service of an application load balancer (lb.l7), not a resource of its own.'),
      oci: none('OCI has no first-party CDN service (verify).'),
      vmware: none('No CDN in VCF: use a cloud or third-party CDN in front of the application.'),
    },
    attributes: [attr('name', { azure: at('azurerm_cdn_frontdoor_profile', 'name') }), tags('aws_cloudfront_distribution', 'azurerm_cdn_frontdoor_profile')],
    source: SEEDED,
  },

  // ============================================================ vmware ===
  {
    id: 'vmware.private-cloud',
    domain: 'vmware',
    label: 'VMware private cloud (hosted VCF)',
    per: {
      aws: none('Amazon Elastic VMware Service has no resource in the catalogued hashicorp/aws provider (6.66.0); it is created in the console or API.'),
      azure: cell(['azurerm_vmware_private_cloud'], { supporting: ['azurerm_vmware_express_route_authorization'] }),
      google: cell(['google_vmwareengine_private_cloud'], { supporting: ['google_vmwareengine_network', 'google_vmwareengine_network_peering'] }),
      oci: cell(['oci_ocvp_sddc'], { supporting: ['oci_core_vlan'] }),
      vmware: cell(['vcf_domain'], { note: 'A VCF workload domain on premises.' }),
    },
    attributes: [
      attr('name', {
        azure: at('azurerm_vmware_private_cloud', 'name'),
        google: at('google_vmwareengine_private_cloud', 'name'),
        oci: at('oci_ocvp_sddc', 'display_name'),
        vmware: at('vcf_domain', 'name'),
      }),
    ],
    source: SOURCE,
  },
  {
    id: 'vmware.cluster',
    domain: 'vmware',
    label: 'VMware cluster',
    per: {
      aws: none('Amazon Elastic VMware Service has no resource in the catalogued hashicorp/aws provider (6.66.0).'),
      azure: cell(['azurerm_vmware_cluster']),
      google: cell(['google_vmwareengine_cluster']),
      oci: cell(['oci_ocvp_cluster']),
      vmware: cell(['vcf_cluster'], { alternatives: [{ type: 'vsphere_compute_cluster' }] }),
    },
    attributes: [
      attr('name', {
        azure: at('azurerm_vmware_cluster', 'name'),
        google: at('google_vmwareengine_cluster', 'name'),
        oci: at('oci_ocvp_cluster', 'display_name'),
        vmware: at('vcf_cluster', 'name'),
      }),
    ],
    source: SOURCE,
  },
];

// --------------------------------------------------------------- unmapped ---

const LZ = 'Landing-zone or organisation scope: built once by the landing zone, not per application, so it is not translated with an app.';
const POSTURE = 'Account- or subscription-level security posture service: landing-zone scope, not translated per application.';
const STALE = 'Not in the committed provider catalog: renamed or removed since the map was written (the map\'s findings name the replacement).';
const DIRECTORY = 'A directory object in the azuread provider, which is tenant scope and has no per-application counterpart.';
const ANALYTICS = 'Analytics service with no aligned equivalent across the five platforms yet: unaligned, never guessed.';

/**
 * Types a Terraform Map or a migration blueprint names that are deliberately
 * not in a row, with the reason. Translating one gives `no-equivalent` with
 * this reason.
 */
export const UNMAPPED: readonly UnmappedEntry[] = [
  // AWS
  { type: 'aws_organizations_organization', reason: LZ },
  { type: 'aws_organizations_organizational_unit', reason: LZ },
  { type: 'aws_organizations_account', reason: LZ },
  { type: 'aws_organizations_policy', reason: LZ },
  { type: 'aws_organizations_policy_attachment', reason: LZ },
  { type: 'aws_ssoadmin_permission_set', reason: LZ },
  { type: 'aws_ssoadmin_account_assignment', reason: LZ },
  { type: 'aws_ssoadmin_managed_policy_attachment', reason: LZ },
  { type: 'aws_iam_openid_connect_provider', reason: LZ },
  { type: 'aws_iam_saml_provider', reason: LZ },
  { type: 'aws_accessanalyzer_analyzer', reason: POSTURE },
  { type: 'aws_config_configuration_recorder', reason: POSTURE },
  { type: 'aws_config_config_rule', reason: POSTURE },
  { type: 'aws_config_delivery_channel', reason: POSTURE },
  { type: 'aws_guardduty_detector', reason: POSTURE },
  { type: 'aws_securityhub_account', reason: POSTURE },
  { type: 'aws_inspector2_enabler', reason: POSTURE },
  { type: 'aws_macie2_account', reason: POSTURE },
  { type: 'aws_key_pair', reason: 'An SSH key pair registered with EC2. Other platforms take the public key on the VM itself (compute.vm), so it has no resource to become.' },
  { type: 'aws_glue_catalog_database', reason: ANALYTICS },
  { type: 'aws_athena_workgroup', reason: ANALYTICS },
  { type: 'aws_kinesis_firehose_delivery_stream', reason: ANALYTICS },
  // Azure
  { type: 'azuread_user', reason: DIRECTORY },
  { type: 'azuread_group', reason: DIRECTORY },
  { type: 'azuread_group_member', reason: DIRECTORY },
  { type: 'azurerm_role_definition', reason: LZ },
  { type: 'azurerm_policy_definition', reason: LZ },
  { type: 'azurerm_policy_set_definition', reason: LZ },
  { type: 'azurerm_policy_assignment', reason: 'A data source in the current azurerm provider, not a resource; policy assignment is landing-zone scope.' },
  { type: 'azurerm_security_center_contact', reason: POSTURE },
  { type: 'azurerm_security_center_subscription_pricing', reason: POSTURE },
  { type: 'azurerm_mssql_virtual_machine', reason: 'Registers a VM with the Azure SQL IaaS agent extension; an Azure-only management feature with no counterpart. The VM itself is compute.vm.' },
  { type: 'azurerm_app_service_plan', reason: STALE },
  { type: 'azurerm_function_app', reason: STALE },
  { type: 'azurerm_postgresql_flexible_database', reason: STALE },
  // Google
  { type: 'google_folder_iam_member', reason: LZ },
  { type: 'google_organization_iam_member', reason: LZ },
  { type: 'google_logging_organization_sink', reason: LZ },
  // OCI
  {
    type: 'oci_core_default_route_table',
    reason: "Adopts the VCN's default route table. It is in the provider schema but not in catalog-data.ts (the registry documents it on another page), so it is not aligned; the table it manages is network.route-table.",
  },
  { type: 'oci_identity_group', reason: 'A tenancy group: identity-domain scope, not per application.' },
  { type: 'oci_identity_user', reason: 'A tenancy user: identity-domain scope, not per application.' },
  { type: 'oci_logging_log_saved_search', reason: 'A saved log query: operator content with no aligned counterpart.' },
  { type: 'oci_events_filter', reason: STALE },
];

// ---------------------------------------------------------------- modules ---

const MODULE_SOURCE =
  'Collection documentation on docs.ansible.com (amazon.aws, azure.azcollection, google.cloud, oracle.oci, community.vmware / vmware.vmware); aligned by hand, indicative. Module names are checked against src/ansible/catalog-data.ts.';

/**
 * Cloud-specific Ansible modules and their counterparts. OS-level modules
 * (ansible.builtin, ansible.windows, ansible.posix, community.general …) are
 * platform-neutral and carry over unchanged; see NEUTRAL_COLLECTIONS.
 */
export const MODULE_EQUIVALENCE: readonly ModuleRow[] = [
  {
    id: 'object',
    label: 'Upload or download an object',
    per: {
      aws: { module: 'amazon.aws.s3_object' },
      azure: { module: 'azure.azcollection.azure_rm_storageblob' },
      google: { module: 'google.cloud.gcp_storage_object' },
      oci: { module: 'oracle.oci.oci_object_storage_object' },
      vmware: { none: 'VCF has no object store; copy the file to the guest with ansible.builtin.copy instead.' },
    },
    options: {
      bucket: { aws: 'bucket', azure: 'container', google: 'bucket', oci: 'bucket_name' },
      object: { aws: 'object', azure: 'blob', google: 'dest', oci: 'object_name' },
      src: { aws: 'src', azure: 'src', google: 'src', oci: 'src' },
    },
    source: MODULE_SOURCE,
  },
  {
    id: 'bucket',
    label: 'Create an object storage bucket',
    per: {
      aws: { module: 'amazon.aws.s3_bucket' },
      azure: { module: 'azure.azcollection.azure_rm_storageaccount' },
      google: { module: 'google.cloud.gcp_storage_bucket' },
      oci: { module: 'oracle.oci.oci_object_storage_bucket' },
      vmware: { none: 'VCF has no object store.' },
    },
    options: { name: { aws: 'name', azure: 'name', google: 'name', oci: 'name' } },
    source: MODULE_SOURCE,
  },
  {
    id: 'vm-info',
    label: 'Read virtual machine facts',
    per: {
      aws: { module: 'amazon.aws.ec2_instance_info' },
      azure: { module: 'azure.azcollection.azure_rm_virtualmachine_info' },
      google: { module: 'google.cloud.gcp_compute_instance_info' },
      oci: { module: 'oracle.oci.oci_compute_instance_facts' },
      vmware: { module: 'community.vmware.vmware_guest_info' },
    },
    options: {},
    source: MODULE_SOURCE,
  },
  {
    id: 'vm-power',
    label: 'Start, stop or restart a virtual machine',
    per: {
      aws: { module: 'amazon.aws.ec2_instance' },
      azure: { module: 'azure.azcollection.azure_rm_virtualmachine' },
      google: { module: 'google.cloud.gcp_compute_instance' },
      oci: { module: 'oracle.oci.oci_compute_instance_actions' },
      vmware: { module: 'vmware.vmware.vm_powerstate' },
    },
    options: { name: { aws: 'name', azure: 'name', google: 'name', vmware: 'name' } },
    source: MODULE_SOURCE,
  },
  {
    id: 'vm-snapshot',
    label: 'Snapshot a virtual machine or volume',
    per: {
      aws: { module: 'amazon.aws.ec2_snapshot' },
      azure: { module: 'azure.azcollection.azure_rm_snapshot' },
      google: { module: 'google.cloud.gcp_compute_snapshot' },
      oci: { module: 'oracle.oci.oci_blockstorage_volume_backup' },
      vmware: { module: 'community.vmware.vmware_guest_snapshot' },
    },
    options: {},
    source: MODULE_SOURCE,
  },
  {
    id: 'dns-record',
    label: 'Manage a DNS record',
    per: {
      aws: { module: 'amazon.aws.route53' },
      azure: { module: 'azure.azcollection.azure_rm_dnsrecordset' },
      google: { module: 'google.cloud.gcp_dns_resource_record_set' },
      oci: { module: 'oracle.oci.oci_dns_zone_records' },
      vmware: { none: 'Records live in the enterprise DNS: use community.general.nsupdate or microsoft.ad modules, which are platform-neutral.' },
    },
    options: {},
    source: MODULE_SOURCE,
  },
  {
    id: 'secret',
    label: 'Read or write a secret',
    per: {
      aws: { module: 'community.aws.secretsmanager_secret' },
      azure: { module: 'azure.azcollection.azure_rm_keyvaultsecret' },
      google: { module: 'google.cloud.gcp_secret_manager' },
      oci: { module: 'oracle.oci.oci_vault_secret' },
      vmware: { none: 'No secret store in VCF: keep the secret in Ansible vault variables.' },
    },
    options: { name: { aws: 'name', azure: 'secret_name', google: 'name', oci: 'secret_name' } },
    source: MODULE_SOURCE,
  },
];
