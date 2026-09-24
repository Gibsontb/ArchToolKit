/**
 * OCI blueprints that call registry modules.
 *
 * `oracle-terraform-modules/*` is Oracle's own set. The VCN module has been
 * pulled 8.5 million times and is how an OCI network gets built — gateways,
 * route tables and the lockdown of the default security list are inputs rather
 * than a dozen resources to keep in step.
 *
 * The OKE module is the one to notice: 271 inputs across a dozen
 * `variables-*.tf` files. Reading only `variables.tf` reports it as having
 * none, which is why the catalog reads the whole directory the way Terraform
 * does.
 */

import type { Blueprint, BlueprintGroup, BlueprintValues } from '../../kit/blueprint.ts';
import { error, type Finding } from '../../core/findings.ts';
import { parseCidrAny } from '../../core/ip.ts';
import { moduleBlueprint, type ModuleBlueprintSpec } from '../module-blueprint.ts';
import { ipv4Range, isOn, listOf } from './dual-stack.ts';

const SPECS: readonly ModuleBlueprintSpec[] = [
  {
    id: 'oci_module_vcn',
    label: 'VCN (oracle-terraform-modules/vcn)',
    description:
      'A virtual cloud network with its internet, NAT and service gateways, route tables and subnets — and the default security list locked down.',
    source: 'oracle-terraform-modules/vcn/oci',
    name: 'vcn',
    fields: [
      { input: 'compartment_id', label: 'Compartment OCID', default: '' },
      { input: 'tenancy_id', label: 'Tenancy OCID', default: '' },
      { input: 'region', default: 'us-ashburn-1' },
      { input: 'vcn_name', default: 'app-vcn' },
      { input: 'vcn_cidrs', label: 'VCN CIDRs', default: '10.50.0.0/16' },
      { input: 'vcn_dns_label', default: 'appvcn', hint: 'Letters and digits only' },
      { input: 'label_prefix', default: 'app' },
      { input: 'create_internet_gateway', default: 'true' },
      { input: 'create_nat_gateway', default: 'true' },
      { input: 'create_service_gateway', default: 'true' },
      { input: 'lockdown_default_seclist', default: 'true' },
      { input: 'enable_vcn_logging', default: 'true' },
      {
        input: 'enable_ipv6',
        label: 'Dual stack (IPv6)',
        default: 'false',
        hint: 'Oracle assigns the VCN a /56; subnets in the subnets map take /64s of it',
      },
      {
        input: 'vcn_ipv6private_cidr_blocks',
        label: 'Private IPv6 CIDRs (ULA)',
        default: '',
        hint: 'Optional, with dual stack: comma-separated ULA ranges, e.g. fd00:50::/48',
      },
    ],
    outputs: ['vcn_id', 'internet_gateway_id', 'nat_gateway_id', 'service_gateway_id'],
  },
  {
    id: 'oci_module_oke',
    label: 'OKE cluster (oracle-terraform-modules/oke)',
    description:
      'A managed Kubernetes cluster with its VCN, bastion, operator host and worker pools. The module covers the whole landing pad, not just the control plane.',
    source: 'oracle-terraform-modules/oke/oci',
    name: 'oke',
    fields: [
      { input: 'compartment_id', label: 'Compartment OCID', default: '' },
      { input: 'tenancy_id', label: 'Tenancy OCID', default: '' },
      { input: 'region', default: 'us-ashburn-1' },
      { input: 'cluster_name', default: 'app-oke' },
      { input: 'kubernetes_version', default: 'v1.31.1' },
      { input: 'cni_type', label: 'CNI', default: 'flannel' },
      { input: 'control_plane_is_public', default: 'false' },
      { input: 'create_vcn', default: 'true', hint: 'Off to attach to an existing VCN' },
      { input: 'vcn_id', label: 'Existing VCN OCID', default: '', hint: 'Only when not creating one' },
      { input: 'ssh_public_key_path', default: '~/.ssh/id_ed25519.pub' },
      { input: 'worker_pools', default: '', hint: 'A map of pools — write it in the file' },
      {
        input: 'enable_ipv6',
        label: 'Dual stack (IPv6)',
        default: 'false',
        hint: 'IPv6 on the VCN the module creates',
      },
    ],
    outputs: ['cluster_id', 'cluster_endpoints', 'vcn_id'],
  },
  {
    id: 'oci_module_compute',
    label: 'Compute instance (oracle-terraform-modules/compute-instance)',
    description:
      'One or more instances with their block volumes, VNIC configuration and cloud-init. Flex shapes take their OCPU and memory as inputs.',
    source: 'oracle-terraform-modules/compute-instance/oci',
    name: 'compute',
    fields: [
      { input: 'compartment_ocid', label: 'Compartment OCID', default: '' },
      { input: 'instance_display_name', default: 'app-01' },
      { input: 'instance_count', default: '1' },
      { input: 'shape', default: 'VM.Standard.E5.Flex' },
      { input: 'instance_flex_ocpus', label: 'OCPUs', default: '2' },
      { input: 'instance_flex_memory_in_gbs', label: 'Memory (GB)', default: '16' },
      { input: 'source_ocid', label: 'Image OCID', default: '' },
      { input: 'source_type', default: 'image' },
      { input: 'subnet_ocids', label: 'Subnet OCIDs', default: '' },
      { input: 'assign_public_ip', default: 'false' },
      { input: 'ssh_public_keys', default: '', hint: 'The key text, not a path' },
      { input: 'boot_volume_size_in_gbs', default: '100' },
    ],
    outputs: ['instance_id', 'private_ip', 'public_ip'],
  },
  {
    id: 'oci_module_bastion',
    label: 'Bastion host (oracle-terraform-modules/bastion)',
    description: 'The jump host for a private VCN, with its security rules and allowed CIDRs.',
    source: 'oracle-terraform-modules/bastion/oci',
    name: 'bastion',
    fields: [
      { input: 'compartment_id', label: 'Compartment OCID', default: '' },
      { input: 'vcn_id', label: 'VCN OCID', default: '', hint: 'Or module.vcn.vcn_id' },
      { input: 'label_prefix', default: 'app' },
      { input: 'bastion_allowed_cidrs', default: '', hint: 'Comma-separated. Never 0.0.0.0/0' },
      { input: 'bastion_image_os', default: 'Oracle Linux' },
      { input: 'bastion_image_os_version', default: '9' },
      { input: 'bastion_is_public', default: 'true' },
      { input: 'bastion_user', default: 'opc' },
      { input: 'ssh_public_key_path', default: '~/.ssh/id_ed25519.pub' },
      { input: 'ig_route_id', label: 'Internet gateway route table id', default: '' },
    ],
    outputs: ['bastion_public_ip'],
  },
  {
    id: 'oci_module_drg',
    label: 'Dynamic routing gateway (oracle-terraform-modules/drg)',
    description:
      'The DRG and its VCN attachments and remote peerings — how OCI networks reach each other and reach on-premises.',
    source: 'oracle-terraform-modules/drg/oci',
    name: 'drg',
    fields: [
      { input: 'compartment_id', label: 'Compartment OCID', default: '' },
      { input: 'drg_display_name', default: 'app-drg' },
      { input: 'label_prefix', default: 'app' },
      { input: 'drg_vcn_attachments', default: '', hint: 'key=value, comma-separated' },
      { input: 'remote_peering_connections', default: '', hint: 'key=value, comma-separated' },
    ],
    outputs: ['drg_id', 'drg_attachment_ids'],
  },
  {
    id: 'oci_module_operator',
    label: 'Operator host (oracle-terraform-modules/operator)',
    description:
      'The management host inside a private subnet, with instance principal auth so it needs no keys of its own.',
    source: 'oracle-terraform-modules/operator/oci',
    name: 'operator',
    fields: [
      { input: 'compartment_id', label: 'Compartment OCID', default: '' },
      { input: 'tenancy_id', label: 'Tenancy OCID', default: '' },
      { input: 'vcn_id', label: 'VCN OCID', default: '' },
      { input: 'nat_route_id', label: 'NAT route table id', default: '' },
      { input: 'label_prefix', default: 'app' },
      { input: 'operator_os_version', default: '9' },
      { input: 'enable_operator_instance_principal', default: 'true' },
      { input: 'ssh_public_key_path', default: '~/.ssh/id_ed25519.pub' },
    ],
    outputs: ['operator_private_ip'],
  },
];

/**
 * The VCN's ranges: vcn_cidrs is IPv4 (OCI builds no IPv6-only VCN), and the
 * private IPv6 ranges are IPv6 and need dual stack on to mean anything.
 */
function vcnFindings(values: BlueprintValues): Finding[] {
  const code = 'terraform.oci_module_vcn';
  const findings: Finding[] = [];
  for (const cidr of listOf(values.vcn_cidrs)) findings.push(...ipv4Range(cidr, 'vcn_cidrs', 'vcn_cidrs', code));
  const ula = listOf(values.vcn_ipv6private_cidr_blocks);
  for (const cidr of ula) {
    const c = parseCidrAny(cidr);
    if (!c || c.family !== 6 || !cidr.includes('/')) {
      findings.push(error(`${code}.invalid-ipv6-cidr`, `"${cidr}" in vcn_ipv6private_cidr_blocks is not an IPv6 CIDR.`, { path: 'vcn_ipv6private_cidr_blocks' }));
    }
  }
  if (ula.length > 0 && !isOn(values.enable_ipv6)) {
    findings.push(error(`${code}.ipv6-cidrs-without-ipv6`, 'Private IPv6 CIDRs are set but dual stack is off, so the VCN has no IPv6.', { path: 'enable_ipv6' }));
  }
  return findings;
}

function checked(blueprint: Blueprint): Blueprint {
  if (blueprint.id !== 'oci_module_vcn') return blueprint;
  return {
    ...blueprint,
    build: (values, name) => {
      const out = blueprint.build(values, name);
      return { ...out, findings: [...(out.findings ?? []), ...vcnFindings(values)] };
    },
  };
}

export const OCI_TERRAFORM_MODULES: BlueprintGroup = {
  target: 'oci',
  label: 'Oracle Cloud Infrastructure (OCI)',
  blueprints: SPECS.map((spec) => checked(moduleBlueprint('oci', spec))),
};
