/**
 * Hand-written VCF (SDDC Manager) scenario blueprints: several resources built
 * together, day-2 against a running SDDC Manager (vmware/vcf 0.18).
 *
 *   commission hosts     network pool + one vcf_host per ESXi FQDN
 *   workload domain      vCenter, NSX Manager cluster and the first cluster
 *   add a cluster        a vcf_cluster in an existing domain
 *   NSX edge cluster     two edge nodes, Tier-0/Tier-1, eBGP uplinks
 *   certificates         CA + CSR + replacement for a domain's components
 *   credential rotation  auto-rotate policies, optionally a rotation now
 *   users and CEIP       SSO users, groups, service accounts; CEIP
 *   cluster image        a vLCM personality taken from a reference cluster
 *
 * The provider's compatibility matrix stops at VCF 9.0.0, so none of this can
 * describe a component 9.1 added (see ../vcf.ts).
 */

import type { Blueprint, BlueprintInput, TemplateValues } from '../../kit/blueprint.ts';
import { warning, type Finding } from '../../core/findings.ts';
import { scenario, q, items, ident, on, n } from './scenario-common.ts';

const DAY2 = 'Fill in SDDC Manager (sddc_manager_host) in the Provider connection section.';
const LIMIT = 'The vcf provider is written against VCF up to 9.0.0; 9.1 components are not representable.';

const STORAGE_OPTIONS = [
  { value: 'VSAN', label: 'vSAN OSA' },
  { value: 'VSAN_ESA', label: 'vSAN ESA' },
  { value: 'NFS', label: 'NFS' },
];

const EVC_OPTIONS = [
  ...['INTEL_BROADWELL', 'INTEL_SKYLAKE', 'INTEL_CASCADELAKE', 'AMD_STREAMROLLER', 'AMD_ZEN'].map((v) => ({ value: v, label: v })),
];

function variable(name: string, description: string, sensitive = true): string {
  return `variable "${name}" {
  description = ${q(description)}
  type        = string${sensitive ? '\n  sensitive   = true' : ''}
}`;
}

function indent(text: string, by: string): string {
  return text
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : by + l))
    .join('\n');
}

/** Hosts from a textarea, each looked up in SDDC Manager's free pool. */
function hostLookups(value: unknown): { hosts: { fqdn: string; ref: string }[]; hcl: string } {
  const hosts = items(value).map((fqdn) => ({ fqdn, ref: ident(fqdn.split('.')[0], 'host') }));
  const hcl = hosts
    .map(
      (h) => `data "vcf_host" "${h.ref}" {
  fqdn = ${q(h.fqdn)}
}`,
    )
    .join('\n\n');
  return { hosts, hcl };
}

// --- the cluster spec vcf_domain and vcf_cluster share ------------------------

function clusterInputs(section: string): BlueprintInput[] {
  return [
    { id: 'hosts', label: 'ESXi hosts', control: 'textarea', default: 'esxi-wld01-01.example.com\nesxi-wld01-02.example.com\nesxi-wld01-03.example.com\nesxi-wld01-04.example.com', hint: 'One FQDN per line; already commissioned and unassigned', help: 'Each host is looked up by FQDN (data "vcf_host"). vSAN needs at least 3 hosts, 4 for maintenance headroom with FTT=1.' },
    { id: 'storage', label: 'Principal storage', control: 'select', options: STORAGE_OPTIONS, default: 'VSAN' },
    { id: 'datastore_name', label: 'Datastore name', control: 'text', default: 'wld01-cl01-ds-vsan01' },
    { id: 'failures_to_tolerate', label: 'vSAN failures to tolerate', control: 'select', options: [{ value: '1', label: '1' }, { value: '2', label: '2 (needs 5+ hosts for RAID-6 / 6+ OSA)' }], default: '1', showWhen: { input: 'storage', equals: ['VSAN', 'VSAN_ESA'] } },
    { id: 'dedup', label: 'Deduplication and compression', control: 'toggle', default: false, showWhen: { input: 'storage', equals: ['VSAN'] } },
    { id: 'nfs_server', label: 'NFS server', control: 'text', default: 'nfs01.example.com', showWhen: { input: 'storage', equals: ['NFS'] } },
    { id: 'nfs_path', label: 'NFS export path', control: 'text', default: '/exports/wld01-cl01', showWhen: { input: 'storage', equals: ['NFS'] } },
    { id: 'vds_name', label: 'VDS name', control: 'text', default: 'wld01-cl01-vds01', section },
    { id: 'vmnics', label: 'vmnics for the VDS', control: 'text', default: 'vmnic0, vmnic1', hint: 'Comma separated; mapped to uplink1, uplink2, …', section },
    { id: 'pg_prefix', label: 'Port group prefix', control: 'text', default: 'wld01-cl01-vds01-pg', hint: '-mgmt, -vmotion, -vsan / -nfs are appended', section },
    { id: 'geneve_vlan', label: 'Host TEP (Geneve) VLAN', control: 'number', default: 1614, min: 0, max: 4094, section },
    { id: 'tep_pool_name', label: 'Host TEP IP pool', control: 'text', default: 'wld01-cl01-tep-pool', section },
    { id: 'tep_cidr', label: 'Host TEP subnet', control: 'text', default: '172.16.14.0/24', section },
    { id: 'tep_gateway', label: 'Host TEP gateway', control: 'text', default: '172.16.14.1', section },
    { id: 'tep_range', label: 'Host TEP range', control: 'text', default: '172.16.14.101-172.16.14.199', hint: 'start-end', section },
    { id: 'evc_mode', label: 'EVC mode', control: 'select', options: EVC_OPTIONS, blankLabel: 'None', default: '', section },
    { id: 'ha', label: 'vSphere HA', control: 'toggle', default: true, section },
  ];
}

/** The inside of a cluster block (or a vcf_cluster resource): hosts, VDS, TEP pool, storage. */
function clusterSpec(v: TemplateValues, hosts: { ref: string }[]): string {
  const vds = String(v.vds_name);
  const nics = items(v.vmnics);
  const storage = String(v.storage);
  const [tepStart, tepEnd] = String(v.tep_range).split('-').map((s) => s.trim());
  const hostBlocks = hosts
    .map(
      (h) => `host {
  id = data.vcf_host.${h.ref}.id
${nics.map((nic, i) => `
  vmnic {
    id       = ${q(nic)}
    vds_name = ${q(vds)}
    uplink   = "uplink${i + 1}"
  }`).join('\n')}
}`,
    )
    .join('\n\n');
  const storagePg = storage === 'NFS' ? ['nfs', 'NFS'] : ['vsan', 'VSAN'];
  const storageBlock =
    storage === 'NFS'
      ? `nfs_datastores {
  datastore_name = ${q(v.datastore_name)}
  server_name    = ${q(v.nfs_server)}
  path           = ${q(v.nfs_path)}
  read_only      = false
}`
      : `vsan_datastore {
  datastore_name                = ${q(v.datastore_name)}
  failures_to_tolerate          = ${n(v.failures_to_tolerate, 1)}
  esa_enabled                   = ${storage === 'VSAN_ESA'}${storage === 'VSAN' ? `\n  dedup_and_compression_enabled = ${on(v.dedup)}` : ''}
}`;
  const evc = String(v.evc_mode ?? '').trim();
  return `geneve_vlan_id            = ${n(v.geneve_vlan, 0)}
high_availability_enabled = ${on(v.ha)}${evc ? `\nevc_mode                  = ${q(evc)}` : ''}

${hostBlocks}

vds {
  name           = ${q(vds)}
  is_used_by_nsx = true

  portgroup {
    name           = ${q(`${v.pg_prefix}-mgmt`)}
    transport_type = "MANAGEMENT"
  }

  portgroup {
    name           = ${q(`${v.pg_prefix}-vmotion`)}
    transport_type = "VMOTION"
  }

  portgroup {
    name           = ${q(`${v.pg_prefix}-${storagePg[0]}`)}
    transport_type = "${storagePg[1]}"
  }
}

# NSX host TEP addresses
ip_address_pool {
  name = ${q(v.tep_pool_name)}

  subnet {
    cidr    = ${q(v.tep_cidr)}
    gateway = ${q(v.tep_gateway)}

    ip_address_pool_range {
      start = ${q(tepStart)}
      end   = ${q(tepEnd ?? tepStart)}
    }
  }
}

${storageBlock}`;
}

function clusterFindings(v: TemplateValues, count: number, where: string): Finding[] {
  const findings: Finding[] = [];
  if (count < 2) findings.push(warning(`${where}.hosts`, 'A VCF cluster needs at least two hosts; the provider rejects fewer.', { path: 'hosts' }));
  else if (String(v.storage).startsWith('VSAN') && count < 3) findings.push(warning(`${where}.vsan-hosts`, 'vSAN needs at least three hosts.', { path: 'hosts' }));
  return findings;
}

// --- the scenarios -------------------------------------------------------------

export const VCF_SCENARIOS: readonly Blueprint[] = [
  scenario('vcf', {
    id: 'vcf_commission_hosts',
    label: 'Commission hosts: network pool + ESXi hosts',
    description: `A network pool with vMotion and storage networks (IP ranges SDDC Manager hands out), and one vcf_host per ESXi FQDN commissioned into it. ${DAY2} The hosts share one root password, var.esxi_root_password.`,
    inputs: [
      { id: 'pool_name', label: 'Network pool name', control: 'text', default: 'wld01-np01' },
      { id: 'hosts', label: 'ESXi hosts', control: 'textarea', default: 'esxi-wld01-01.example.com\nesxi-wld01-02.example.com\nesxi-wld01-03.example.com\nesxi-wld01-04.example.com', hint: 'One FQDN per line; each gets a vcf_host' },
      { id: 'storage_type', label: 'Storage type', control: 'select', options: [
        { value: 'VSAN', label: 'vSAN OSA' },
        { value: 'VSAN_ESA', label: 'vSAN ESA' },
        { value: 'VSAN_REMOTE', label: 'vSAN remote (HCI Mesh)' },
        { value: 'NFS', label: 'NFS' },
        { value: 'VMFS_FC', label: 'VMFS on FC' },
        { value: 'VVOL', label: 'vVols' },
      ], default: 'VSAN', hint: 'Decides the pool’s storage network' },
      { id: 'username', label: 'ESXi user', control: 'text', default: 'root' },
      { id: 'vmotion_vlan', label: 'vMotion VLAN', control: 'number', default: 1612, min: 0, max: 4094, section: 'vMotion network' },
      { id: 'vmotion_subnet', label: 'vMotion subnet', control: 'text', default: '172.16.12.0', section: 'vMotion network' },
      { id: 'vmotion_mask', label: 'vMotion mask', control: 'text', default: '255.255.255.0', section: 'vMotion network' },
      { id: 'vmotion_gateway', label: 'vMotion gateway', control: 'text', default: '172.16.12.1', section: 'vMotion network' },
      { id: 'vmotion_range', label: 'vMotion range', control: 'text', default: '172.16.12.101-172.16.12.199', hint: 'start-end', section: 'vMotion network' },
      { id: 'storage_vlan', label: 'Storage VLAN', control: 'number', default: 1613, min: 0, max: 4094, section: 'Storage network', hint: 'vSAN or NFS' },
      { id: 'storage_subnet', label: 'Storage subnet', control: 'text', default: '172.16.13.0', section: 'Storage network' },
      { id: 'storage_mask', label: 'Storage mask', control: 'text', default: '255.255.255.0', section: 'Storage network' },
      { id: 'storage_gateway', label: 'Storage gateway', control: 'text', default: '172.16.13.1', section: 'Storage network' },
      { id: 'storage_range', label: 'Storage range', control: 'text', default: '172.16.13.101-172.16.13.199', hint: 'start-end', section: 'Storage network' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 9000, min: 1500, max: 9000, section: 'Storage network' },
    ],
    emits: ['vcf_network_pool', 'vcf_host'],
    body: (v) => {
      const type = String(v.storage_type);
      const storageNet = type === 'NFS' ? 'NFS' : type.startsWith('VSAN') ? 'VSAN' : '';
      const net = (kind: string, p: string): string => {
        const [start, end] = String(v[`${p}_range`]).split('-').map((s) => s.trim());
        return `  network {
    type    = "${kind}"
    vlan_id = ${n(v[`${p}_vlan`], 0)}
    mtu     = ${n(v.mtu, 9000)}
    subnet  = ${q(v[`${p}_subnet`])}
    mask    = ${q(v[`${p}_mask`])}
    gateway = ${q(v[`${p}_gateway`])}

    ip_pools {
      start = ${q(start)}
      end   = ${q(end ?? start)}
    }
  }`;
      };
      const hosts = items(v.hosts);
      const findings: Finding[] = [];
      if (!storageNet) findings.push(warning('vcf.commission.fc', `${type} needs no storage network in the pool; only vMotion is created.`, { path: 'storage_type' }));
      const hostHcl = hosts
        .map(
          (fqdn) => `resource "vcf_host" "${ident(fqdn.split('.')[0], 'host')}" {
  fqdn            = ${q(fqdn)}
  username        = ${q(v.username)}
  password        = var.esxi_root_password
  storage_type    = "${type}"
  network_pool_id = vcf_network_pool.this.id
}`,
        )
        .join('\n\n');
      return {
        findings,
        hcl: `${variable('esxi_root_password', 'root password of the ESXi hosts being commissioned')}

resource "vcf_network_pool" "this" {
  name = ${q(v.pool_name)}

${[net('VMOTION', 'vmotion'), ...(storageNet ? [net(storageNet, 'storage')] : [])].join('\n\n')}
}

${hostHcl}

output "host_ids" {
  value = {${hosts.map((fqdn) => `\n    ${q(fqdn)} = vcf_host.${ident(fqdn.split('.')[0], 'host')}.id`).join('')}
  }
}`,
      };
    },
  }),

  scenario('vcf', {
    id: 'vcf_workload_domain',
    label: 'Workload domain: vCenter + NSX + first cluster',
    description: `A VI workload domain: its vCenter, a three-node NSX Manager cluster and the first cluster built from commissioned hosts (looked up by FQDN), with a VDS, host TEP pool and vSAN or NFS principal storage. ${DAY2} ${LIMIT}`,
    inputs: [
      { id: 'domain_name', label: 'Domain name', control: 'text', default: 'wld01', hint: '3–20 characters' },
      { id: 'org_name', label: 'Organization', control: 'text', default: 'Example', section: 'Domain' },
      { id: 'sso_domain', label: 'SSO domain', control: 'text', default: 'vsphere.local', hint: 'The management SSO domain, or a new isolated one', section: 'Domain' },
      { id: 'vc_name', label: 'vCenter VM name', control: 'text', default: 'vcenter-wld01' },
      { id: 'vc_fqdn', label: 'vCenter FQDN', control: 'text', default: 'vcenter-wld01.example.com' },
      { id: 'vc_ip', label: 'vCenter IP', control: 'text', default: '10.0.10.20' },
      { id: 'mgmt_gateway', label: 'Management gateway', control: 'text', default: '10.0.10.1', hint: 'vCenter and NSX Managers' },
      { id: 'mgmt_mask', label: 'Management netmask', control: 'text', default: '255.255.255.0' },
      { id: 'datacenter', label: 'Datacenter name', control: 'text', default: 'wld01-dc01' },
      { id: 'vc_size', label: 'vCenter size', control: 'select', options: ['tiny', 'small', 'medium', 'large', 'xlarge'].map((s) => ({ value: s, label: s })), default: 'small', section: 'vCenter' },
      { id: 'vc_storage', label: 'vCenter storage size', control: 'select', options: [{ value: 'lstorage', label: 'lstorage' }, { value: 'xlstorage', label: 'xlstorage' }], blankLabel: 'Default', default: '', section: 'vCenter' },
      { id: 'nsx_vip', label: 'NSX Manager VIP', control: 'text', default: '10.0.10.30' },
      { id: 'nsx_vip_fqdn', label: 'NSX Manager VIP FQDN', control: 'text', default: 'nsx-wld01.example.com' },
      { id: 'nsx_nodes', label: 'NSX Manager nodes', control: 'textarea', default: 'nsx-wld01a nsx-wld01a.example.com 10.0.10.31\nnsx-wld01b nsx-wld01b.example.com 10.0.10.32\nnsx-wld01c nsx-wld01c.example.com 10.0.10.33', hint: 'One per line: name FQDN IP' },
      { id: 'nsx_form_factor', label: 'NSX Manager size', control: 'select', options: ['small', 'medium', 'large'].map((s) => ({ value: s, label: s })), default: 'medium' },
      { id: 'cluster_name', label: 'Cluster name', control: 'text', default: 'wld01-cl01' },
      ...clusterInputs('Cluster networking'),
    ],
    emits: ['vcf_domain'],
    body: (v) => {
      const { hosts, hcl: lookups } = hostLookups(v.hosts);
      const nodes = String(v.nsx_nodes ?? '')
        .split('\n')
        .map((l) => l.trim().split(/[\s,]+/))
        .filter((p) => p[0]);
      const findings = clusterFindings(v, hosts.length, 'vcf.domain');
      if (nodes.length !== 3) findings.push(warning('vcf.domain.nsx-nodes', 'VCF deploys NSX Manager as a three-node cluster.', { path: 'nsx_nodes' }));
      const nodeHcl = nodes
        .map(
          ([name, fqdn, ip]) => `    nsx_manager_node {
      name        = ${q(name)}
      fqdn        = ${q(fqdn ?? '')}
      ip_address  = ${q(ip ?? '')}
      gateway     = ${q(v.mgmt_gateway)}
      subnet_mask = ${q(v.mgmt_mask)}
    }`,
        )
        .join('\n\n');
      const storageSize = String(v.vc_storage ?? '').trim();
      return {
        findings,
        hcl: `${variable('vcenter_root_password', 'root password for the new vCenter (8-20 characters)')}

${variable('nsx_admin_password', 'NSX Manager admin password')}

${variable('nsx_audit_password', 'NSX Manager audit password')}

${variable('sso_domain_password', 'Password of the SSO domain administrator')}

${lookups}

resource "vcf_domain" "this" {
  name     = ${q(v.domain_name)}
  org_name = ${q(v.org_name)}

  sso {
    domain_name     = ${q(v.sso_domain)}
    domain_password = var.sso_domain_password
  }

  vcenter_configuration {
    name            = ${q(v.vc_name)}
    fqdn            = ${q(v.vc_fqdn)}
    ip_address      = ${q(v.vc_ip)}
    gateway         = ${q(v.mgmt_gateway)}
    subnet_mask     = ${q(v.mgmt_mask)}
    datacenter_name = ${q(v.datacenter)}
    root_password   = var.vcenter_root_password
    vm_size         = ${q(v.vc_size)}${storageSize ? `\n    storage_size    = ${q(storageSize)}` : ''}
  }

  nsx_configuration {
    vip                        = ${q(v.nsx_vip)}
    vip_fqdn                   = ${q(v.nsx_vip_fqdn)}
    form_factor                = ${q(v.nsx_form_factor)}
    nsx_manager_admin_password = var.nsx_admin_password
    nsx_manager_audit_password = var.nsx_audit_password

${nodeHcl}
  }

  cluster {
    name = ${q(v.cluster_name)}

${indent(clusterSpec(v, hosts), '    ')}
  }
}

output "domain_id" {
  value = vcf_domain.this.id
}`,
      };
    },
  }),

  scenario('vcf', {
    id: 'vcf_add_cluster',
    label: 'Add a cluster to an existing domain',
    description: `A vcf_cluster in an existing workload domain (looked up by name), built from commissioned hosts with a VDS, host TEP pool and vSAN or NFS principal storage, optionally from a cluster image. ${DAY2}`,
    inputs: [
      { id: 'domain_name', label: 'Workload domain', control: 'text', default: 'wld01', hint: 'Existing domain name' },
      { id: 'cluster_name', label: 'Cluster name', control: 'text', default: 'wld01-cl02' },
      ...clusterInputs('Cluster networking').map((i) =>
        i.id === 'hosts' ? { ...i, default: 'esxi-wld01-05.example.com\nesxi-wld01-06.example.com\nesxi-wld01-07.example.com\nesxi-wld01-08.example.com' }
        : i.id === 'datastore_name' ? { ...i, default: 'wld01-cl02-ds-vsan01' }
        : i.id === 'vds_name' ? { ...i, default: 'wld01-cl02-vds01' }
        : i.id === 'pg_prefix' ? { ...i, default: 'wld01-cl02-vds01-pg' }
        : i.id === 'tep_pool_name' ? { ...i, default: 'wld01-cl02-tep-pool' }
        : i),
      { id: 'cluster_image_id', label: 'Cluster image ID', control: 'text', default: '', hint: 'Optional; vcf_cluster_personality id', section: 'Cluster networking' },
    ],
    emits: ['vcf_cluster'],
    body: (v) => {
      const { hosts, hcl: lookups } = hostLookups(v.hosts);
      const image = String(v.cluster_image_id ?? '').trim();
      return {
        findings: clusterFindings(v, hosts.length, 'vcf.cluster'),
        hcl: `data "vcf_domain" "this" {
  name = ${q(v.domain_name)}
}

${lookups}

resource "vcf_cluster" "this" {
  name      = ${q(v.cluster_name)}
  domain_id = data.vcf_domain.this.id${image ? `\n  cluster_image_id = ${q(image)}` : ''}

${indent(clusterSpec(v, hosts), '  ')}
}

output "cluster_id" {
  value = vcf_cluster.this.id
}`,
      };
    },
  }),

  scenario('vcf', {
    id: 'vcf_edge_cluster',
    label: 'NSX edge cluster: edge nodes, Tier-0/Tier-1, eBGP',
    description: `An NSX edge cluster deployed by SDDC Manager: edge nodes on a workload cluster, a Tier-0 with eBGP to two top-of-rack peers and a Tier-1. The edge root, admin and audit passwords and the BGP password are variables. ${DAY2} Static routing is not offered here because the provider requires a BGP peer on every uplink.`,
    inputs: [
      { id: 'name', label: 'Edge cluster name', control: 'text', default: 'wld01-ec01' },
      { id: 'compute_cluster', label: 'Workload cluster', control: 'text', default: 'wld01-cl01', hint: 'vSphere cluster the edges run on' },
      { id: 'form_factor', label: 'Edge size', control: 'select', options: ['SMALL', 'MEDIUM', 'LARGE', 'XLARGE'].map((s) => ({ value: s, label: s.toLowerCase() })), default: 'MEDIUM' },
      { id: 'high_availability', label: 'Tier-0 HA mode', control: 'select', options: [{ value: 'ACTIVE_ACTIVE', label: 'Active-active' }, { value: 'ACTIVE_STANDBY', label: 'Active-standby' }], default: 'ACTIVE_ACTIVE' },
      { id: 'tier0_name', label: 'Tier-0 name', control: 'text', default: 'wld01-ec01-t0' },
      { id: 'tier1_name', label: 'Tier-1 name', control: 'text', default: 'wld01-ec01-t1' },
      { id: 'asn', label: 'Local ASN', control: 'text', default: '65003' },
      { id: 'edge_nodes', label: 'Edge nodes', control: 'textarea', default: 'wld01-en01 10.0.10.41/24 172.16.18.11/24 172.16.18.12/24 172.27.11.2/24 172.27.12.2/24\nwld01-en02 10.0.10.42/24 172.16.18.13/24 172.16.18.14/24 172.27.11.3/24 172.27.12.3/24', hint: 'One per line: name mgmt-IP/prefix TEP1/prefix TEP2/prefix uplink1-IP/prefix uplink2-IP/prefix' },
      { id: 'mgmt_gateway', label: 'Management gateway', control: 'text', default: '10.0.10.1' },
      { id: 'tep_gateway', label: 'Edge TEP gateway', control: 'text', default: '172.16.18.1', section: 'Edge TEP' },
      { id: 'tep_vlan', label: 'Edge TEP VLAN', control: 'number', default: 1618, min: 0, max: 4094, section: 'Edge TEP' },
      { id: 'inter_rack', label: 'Inter-rack (L3) cluster', control: 'toggle', default: false, section: 'Edge TEP' },
      { id: 'uplink1_vlan', label: 'Uplink 1 VLAN', control: 'number', default: 2711, min: 0, max: 4094, section: 'Uplinks & BGP' },
      { id: 'uplink1_peer', label: 'Uplink 1 BGP peer', control: 'text', default: '172.27.11.1/24', hint: 'IP/prefix, as SDDC Manager expects', section: 'Uplinks & BGP' },
      { id: 'uplink2_vlan', label: 'Uplink 2 VLAN', control: 'number', default: 2712, min: 0, max: 4094, section: 'Uplinks & BGP' },
      { id: 'uplink2_peer', label: 'Uplink 2 BGP peer', control: 'text', default: '172.27.12.1/24', hint: 'IP/prefix', section: 'Uplinks & BGP' },
      { id: 'peer_asn', label: 'Peer ASN', control: 'text', default: '65001', section: 'Uplinks & BGP' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 9000, min: 1600, max: 9000, section: 'Uplinks & BGP' },
    ],
    emits: ['vcf_edge_cluster'],
    body: (v) => {
      const nodes = String(v.edge_nodes ?? '')
        .split('\n')
        .map((l) => l.trim().split(/[\s,]+/))
        .filter((p) => p[0]);
      const findings: Finding[] = [];
      if (nodes.length < 2) findings.push(warning('vcf.edge.nodes', 'An edge cluster needs at least two edge nodes.', { path: 'edge_nodes' }));
      const uplink = (ip: string | undefined, vlan: unknown, peer: unknown): string => `    uplink {
      interface_ip = ${q(ip ?? '')}
      vlan         = ${n(vlan, 0)}

      bgp_peer {
        ip       = ${q(peer)}
        asn      = ${q(v.peer_asn)}
        password = var.bgp_peer_password
      }
    }`;
      const nodeHcl = nodes
        .map(
          ([name, mgmt, tep1, tep2, up1, up2]) => `  edge_node {
    name                  = ${q(name)}
    compute_cluster_name  = ${q(v.compute_cluster)}
    management_ip         = ${q(mgmt ?? '')}
    management_gateway    = ${q(v.mgmt_gateway)}
    tep1_ip               = ${q(tep1 ?? '')}
    tep2_ip               = ${q(tep2 ?? '')}
    tep_gateway           = ${q(v.tep_gateway)}
    tep_vlan              = ${n(v.tep_vlan, 0)}
    inter_rack_cluster    = ${on(v.inter_rack)}
    first_nsx_vds_uplink  = "uplink1"
    second_nsx_vds_uplink = "uplink2"
    root_password         = var.edge_root_password
    admin_password        = var.edge_admin_password
    audit_password        = var.edge_audit_password

${uplink(up1, v.uplink1_vlan, v.uplink1_peer)}

${uplink(up2, v.uplink2_vlan, v.uplink2_peer)}
  }`,
        )
        .join('\n\n');
      return {
        findings,
        hcl: `${variable('edge_root_password', 'root password for the edge nodes')}

${variable('edge_admin_password', 'admin password for the edge nodes')}

${variable('edge_audit_password', 'audit password for the edge nodes')}

${variable('bgp_peer_password', 'BGP neighbour password')}

resource "vcf_edge_cluster" "this" {
  name              = ${q(v.name)}
  form_factor       = ${q(v.form_factor)}
  profile_type      = "DEFAULT"
  mtu               = ${n(v.mtu, 9000)}
  routing_type      = "EBGP"
  asn               = ${q(v.asn)}
  high_availability = ${q(v.high_availability)}
  tier0_name        = ${q(v.tier0_name)}
  tier1_name        = ${q(v.tier1_name)}
  root_password     = var.edge_root_password
  admin_password    = var.edge_admin_password
  audit_password    = var.edge_audit_password

${nodeHcl}
}

output "edge_cluster_id" {
  value = vcf_edge_cluster.this.id
}`,
      };
    },
  }),

  scenario('vcf', {
    id: 'vcf_certificates',
    label: 'Certificates: CA + CSRs + replacement',
    description: `Configures SDDC Manager's certificate authority (Microsoft AD CS or its built-in OpenSSL CA), generates a CSR for each component of a domain and replaces its certificate — or, with an external CA, installs certificates you signed elsewhere. ${DAY2}`,
    inputs: [
      { id: 'domain_name', label: 'Domain', control: 'text', default: 'wld01', hint: 'Existing domain name' },
      { id: 'resources', label: 'Components', control: 'textarea', default: 'VCENTER vcenter-wld01.example.com\nNSXT_MANAGER nsx-wld01.example.com', hint: 'One per line: TYPE FQDN (SDDC_MANAGER, VCENTER, NSXT_MANAGER, VRSLCM, VXRAIL_MANAGER)' },
      { id: 'ca_type', label: 'Certificate authority', control: 'select', options: [
        { value: 'microsoft', label: 'Microsoft AD CS' },
        { value: 'openssl', label: 'OpenSSL (SDDC Manager built-in)' },
        { value: 'external', label: 'External (install signed certificates)' },
      ], default: 'microsoft' },
      { id: 'ms_url', label: 'AD CS URL', control: 'text', default: 'https://ca01.example.com/certsrv', showWhen: { input: 'ca_type', equals: ['microsoft'] } },
      { id: 'ms_template', label: 'Certificate template', control: 'text', default: 'VMware', showWhen: { input: 'ca_type', equals: ['microsoft'] } },
      { id: 'ms_user', label: 'AD CS user', control: 'text', default: 'svc-vcf-ca@example.com', showWhen: { input: 'ca_type', equals: ['microsoft'] } },
      { id: 'ca_common_name', label: 'OpenSSL CA common name', control: 'text', default: 'sddc-manager.example.com', showWhen: { input: 'ca_type', equals: ['openssl'] } },
      { id: 'key_size', label: 'Key size', control: 'select', options: ['2048', '3072', '4096'].map((s) => ({ value: s, label: s })), default: '3072' },
      { id: 'email', label: 'Contact email', control: 'text', default: 'pki@example.com', section: 'Subject' },
      { id: 'organization', label: 'Organization', control: 'text', default: 'Example Inc', section: 'Subject' },
      { id: 'organization_unit', label: 'Organizational unit', control: 'text', default: 'IT', section: 'Subject' },
      { id: 'locality', label: 'Locality', control: 'text', default: 'Palo Alto', section: 'Subject' },
      { id: 'state', label: 'State', control: 'text', default: 'California', section: 'Subject', hint: 'Full name, not abbreviated' },
      { id: 'country', label: 'Country', control: 'text', default: 'US', section: 'Subject', hint: 'ISO 3166 code' },
    ],
    emits: ['vcf_certificate_authority', 'vcf_csr', 'vcf_certificate', 'vcf_external_certificate'],
    body: (v) => {
      const ca = String(v.ca_type);
      const components = String(v.resources ?? '')
        .split('\n')
        .map((l) => l.trim().split(/[\s,]+/))
        .filter((p) => p[0] && p[1])
        .map(([type, fqdn]) => ({ type: String(type).toUpperCase(), fqdn: String(fqdn), ref: ident(String(fqdn).split('.')[0]) }));
      const csrs = components
        .map(
          (c) => `resource "vcf_csr" "${c.ref}" {
  domain_id         = data.vcf_domain.this.id
  resource          = "${c.type}"
  fqdn              = ${q(c.fqdn)}
  key_size          = ${n(v.key_size, 3072)}
  email             = ${q(v.email)}
  organization      = ${q(v.organization)}
  organization_unit = ${q(v.organization_unit)}
  locality          = ${q(v.locality)}
  state             = ${q(v.state)}
  country           = ${q(v.country)}
}`,
        )
        .join('\n\n');
      let caHcl: string;
      let replace: string;
      if (ca === 'external') {
        caHcl = `${variable('ca_certificate_pem', 'PEM of the issuing CA certificate', false)}

${variable('certificate_chain_pem', 'PEM chain from the issuing CA to the root', false)}

variable "resource_certificates" {
  description = "Signed PEM certificate for each component, keyed by FQDN"
  type        = map(string)
}`;
        replace = components
          .map(
            (c) => `resource "vcf_external_certificate" "${c.ref}" {
  csr_id               = vcf_csr.${c.ref}.id
  resource_certificate = var.resource_certificates[${q(c.fqdn)}]
  ca_certificate       = var.ca_certificate_pem
  certificate_chain    = var.certificate_chain_pem
}`,
          )
          .join('\n\n');
      } else {
        caHcl =
          ca === 'microsoft'
            ? `${variable('ca_password', 'Password of the AD CS service account')}

resource "vcf_certificate_authority" "this" {
  microsoft {
    server_url    = ${q(v.ms_url)}
    template_name = ${q(v.ms_template)}
    username      = ${q(v.ms_user)}
    secret        = var.ca_password
  }
}`
            : `resource "vcf_certificate_authority" "this" {
  open_ssl {
    common_name       = ${q(v.ca_common_name)}
    organization      = ${q(v.organization)}
    organization_unit = ${q(v.organization_unit)}
    locality          = ${q(v.locality)}
    state             = ${q(v.state)}
    country           = ${q(v.country)}
  }
}`;
        replace = components
          .map(
            (c) => `resource "vcf_certificate" "${c.ref}" {
  ca_id  = vcf_certificate_authority.this.id
  csr_id = vcf_csr.${c.ref}.id
}`,
          )
          .join('\n\n');
      }
      return `data "vcf_domain" "this" {
  name = ${q(v.domain_name)}
}

${caHcl}

${csrs}

${replace}`;
    },
  }),

  scenario('vcf', {
    id: 'vcf_credential_rotation',
    label: 'Credential rotation: auto-rotate policies',
    description: `Turns on SDDC Manager's automatic password rotation for a set of accounts, and can rotate them once now as well. ${DAY2}`,
    inputs: [
      { id: 'accounts', label: 'Accounts', control: 'textarea', default: 'VCENTER vcenter-wld01.example.com root\nNSXT_MANAGER nsx-wld01.example.com admin\nNSXT_MANAGER nsx-wld01.example.com audit', hint: 'One per line: RESOURCE_TYPE resource-name user (VCENTER, PSC, NSXT_MANAGER, NSXT_EDGE, BACKUP, VRSLCM)', help: 'SDDC Manager cannot schedule rotation for ESXi accounts; rotate those on demand.' },
      { id: 'enabled', label: 'Auto-rotate', control: 'toggle', default: true },
      { id: 'days', label: 'Rotate every (days)', control: 'number', default: 30, min: 1, max: 90, showWhen: { input: 'enabled', equals: ['true'] } },
      { id: 'rotate_now', label: 'Also rotate now', control: 'toggle', default: false },
      { id: 'credential_type', label: 'Credential type to rotate', control: 'select', options: ['SSH', 'API', 'SSO', 'AUDIT', 'FTP'].map((s) => ({ value: s, label: s })), default: 'SSH', showWhen: { input: 'rotate_now', equals: ['true'] }, hint: 'root → SSH; admin/audit on NSX → API/AUDIT' },
    ],
    emits: ['vcf_credentials_auto_rotate_policy', 'vcf_credentials_rotate'],
    body: (v) => {
      const rows = String(v.accounts ?? '')
        .split('\n')
        .map((l) => l.trim().split(/[\s,]+/))
        .filter((p) => p[0] && p[1] && p[2])
        .map(([type, resource, user]) => ({ type: String(type).toUpperCase(), resource: String(resource), user: String(user), ref: ident(`${String(resource).split('.')[0]}_${user}`) }));
      const policies = rows
        .map(
          (r) => `resource "vcf_credentials_auto_rotate_policy" "${r.ref}" {
  resource_type        = "${r.type}"
  resource_name        = ${q(r.resource)}
  user_name            = ${q(r.user)}
  enable_auto_rotation = ${on(v.enabled)}${on(v.enabled) ? `\n  auto_rotate_days     = ${n(v.days, 30)}` : ''}
}`,
        )
        .join('\n\n');
      const rotate = on(v.rotate_now)
        ? `\n\n${rows
            .map(
              (r) => `resource "vcf_credentials_rotate" "${r.ref}" {
  resource_type = "${r.type}"
  resource_name = ${q(r.resource)}

  credentials {
    credential_type = ${q(v.credential_type)}
    user_name       = ${q(r.user)}
  }
}`,
            )
            .join('\n\n')}`
        : '';
      return `${policies}${rotate}`;
    },
  }),

  scenario('vcf', {
    id: 'vcf_users_ceip',
    label: 'SDDC Manager users, groups and CEIP',
    description: `Grants SDDC Manager roles to SSO users, groups and service accounts, and sets the Customer Experience Improvement Program. ${DAY2}`,
    inputs: [
      { id: 'users', label: 'Users and groups', control: 'textarea', default: 'USER jane.doe@example.com ADMIN\nGROUP vcf-operators@example.com OPERATOR\nGROUP vcf-auditors@example.com VIEWER\nSERVICE svc-terraform@vsphere.local ADMIN', hint: 'One per line: USER|GROUP|SERVICE name@domain ADMIN|OPERATOR|VIEWER' },
      { id: 'ceip', label: 'CEIP', control: 'select', options: [{ value: 'DISABLED', label: 'Disabled' }, { value: 'ENABLED', label: 'Enabled' }], blankLabel: 'Leave as it is', default: 'DISABLED' },
    ],
    emits: ['vcf_user', 'vcf_ceip'],
    body: (v) => {
      const users = String(v.users ?? '')
        .split('\n')
        .map((l) => l.trim().split(/[\s,]+/))
        .filter((p) => p[0] && p[1])
        .map(([type, principal, role]) => {
          const [name, domain] = String(principal).split('@');
          return `resource "vcf_user" "${ident(`${String(type).toLowerCase()}_${name}`)}" {
  name      = ${q(name)}
  domain    = ${q(domain ?? 'vsphere.local')}
  type      = "${String(type).toUpperCase()}"
  role_name = "${String(role ?? 'VIEWER').toUpperCase()}"
}`;
        })
        .join('\n\n');
      const ceip = String(v.ceip ?? '').trim();
      return `${users}${ceip ? `\n\nresource "vcf_ceip" "this" {\n  status = "${ceip}"\n}` : ''}`;
    },
  }),

  scenario('vcf', {
    id: 'vcf_cluster_image',
    label: 'Cluster image from a reference cluster',
    description: `Extracts a vLCM cluster image (personality) from a cluster already configured the way new clusters should be, for use as cluster_image_id when adding clusters or domains. ${DAY2}`,
    inputs: [
      { id: 'domain_name', label: 'Domain', control: 'text', default: 'wld01', hint: 'Domain of the reference cluster' },
      { id: 'cluster_moref', label: 'Reference cluster ID', control: 'text', default: 'domain-c8', hint: 'vCenter managed object ID (domain-c…)' },
      { id: 'name', label: 'Image name', control: 'text', default: 'esxi-9.0-dell-r760' },
    ],
    emits: ['vcf_cluster_personality'],
    body: (v) => `data "vcf_domain" "this" {
  name = ${q(v.domain_name)}
}

resource "vcf_cluster_personality" "this" {
  name       = ${q(v.name)}
  domain_id  = data.vcf_domain.this.id
  cluster_id = ${q(v.cluster_moref)}
}

output "cluster_image_id" {
  value = vcf_cluster_personality.this.id
}`,
  }),
];

