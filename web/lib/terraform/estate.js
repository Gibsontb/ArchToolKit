/**
 * Terraform from the imported estate.
 *
 * Two answers to "what would Terraform do to move this":
 *
 *  - **To VCF** the VMs move by vMotion or HCX, and Terraform builds what they
 *    land in — the port groups with their VLANs, the VM folders, the resource
 *    pools with their shares and reservations, the custom attributes — and,
 *    once the VMs have arrived, the DRS rules that kept them apart on the
 *    source. All of it read from the estate, so the target matches the source
 *    it replaces.
 *  - **To a cloud** a replication service (AWS Application Migration Service,
 *    Azure Migrate, Google Migrate to VMs, OCI Cloud Migrations) copies the
 *    disks, and Terraform declares the target each VM becomes: an instance
 *    type sized from its vCPU and memory, and a disk for each of its VMDKs.
 *    Written as one map in `locals`, one line per VM, so a wave plan can be
 *    reviewed — and trimmed — before anything is applied.
 *
 * Nothing here carries a credential: the vSphere provider reads VSPHERE_USER
 * and VSPHERE_PASSWORD, the clouds their usual credential chains.
 */

import { info, warning,              } from '../core/findings.js';
import {
  isWorkload,
  scopedKey,
                 
                   
              
} from '../vmware/inventory.js';
import { assessVm } from '../vmware/vm-readiness.js';
import { rightsize,                  } from '../kit/rightsize.js';
import { providerFor,                  } from './providers.js';

                              
                                                      
                           
                                                  
                           
                                       
                                                                             
                                 
 

                              
                                         
                               
 

/** The VMs a scope selects, and what was left out and why. */
export function vmsInScope(
  inventory                              ,
  scope             ,
)                                                                      {
  if (!inventory || !scope.cluster) return { vms: [], skipped: [] };
  const vms                = [];
  const skipped                                     = [];
  for (const vm of inventory.vms) {
    if (!isWorkload(vm)) continue;
    if (vm.cluster !== scope.cluster) continue;
    if (scope.folder && !(vm.folder ?? '').includes(scope.folder)) continue;
    if (!scope.includePoweredOff && vm.powerState !== 'poweredOn') {
      skipped.push({ vm, why: 'powered off' });
      continue;
    }
    if (scope.skipBlocked) {
      const blocker = assessVm(vm).find((f) => f.check.severity === 'blocker');
      if (blocker) {
        skipped.push({ vm, why: blocker.check.title });
        continue;
      }
    }
    vms.push(vm);
  }
  return { vms: vms.sort((a, b) => a.name.localeCompare(b.name)), skipped };
}

const q = (s        )         => JSON.stringify(s);

function header(lines                   )         {
  return lines.map((l) => (l ? `# ${l}` : '#')).join('\n');
}

function requiredProvider(target             )         {
  const p = providerFor(target);
  return `terraform {
  required_providers {
    ${p.localName} = {
      source  = ${q(p.source)}
      version = ${q(p.version)}
    }
  }
}`;
}

/** The disks that move with the VM: VMDKs, first disk first. RDMs do not. */
function movableDisks(vm             )                                   {
  // "Hard disk 1" is the boot disk whatever controller it sits on; device keys
  // sort SCSI before NVMe and SATA, which is not the same thing.
  const ordinal = (d        )         => Number(/(\d+)\s*$/.exec(d.label)?.[1] ?? Number(d.key ?? 0));
  const disks = [...(vm.disks ?? [])].sort((a, b) => ordinal(a) - ordinal(b));
  const files = disks.filter((d) => !d.raw);
  const sizes = files.map((d) => Math.max(1, Math.ceil(d.capacityGib)));
  if (sizes.length === 0) {
    const whole = Math.ceil(Math.max(vm.totalDiskGib ?? 0, vm.provisionedGib - (vm.rdmGib ?? 0)));
    if (whole > 0) sizes.push(whole);
  }
  return { sizes, rdm: disks.filter((d) => d.raw).length };
}

function osOf(vm             )                      {
  const text = `${vm.guestOsTools ?? ''} ${vm.guestOs ?? ''} ${vm.guestDetail?.familyName ?? ''}`.toLowerCase();
  return text.includes('windows') ? 'windows' : 'linux';
}

/** A name each cloud accepts, unique within the map. */
function keyFor(cloud             , name        , used             )         {
  let key = name;
  if (cloud === 'azure') key = name.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|[-.]+$/g, '').slice(0, 64) || 'vm';
  if (cloud === 'google') {
    key = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 60) || 'vm';
  }
  let unique = key;
  for (let i = 2; used.has(unique); i += 1) unique = `${key.slice(0, 58)}-${i}`;
  used.add(unique);
  return unique;
}

// ---------------------------------------------------------------------------
// Rehost to a cloud
// ---------------------------------------------------------------------------

                                                    
                              
                                                          
                          
 

               
                       
                           
                        
                          
                          
                                   
                           
                           
 

export function rehostFiles(inventory                              , options               )              {
  const findings            = [];
  const { vms, skipped } = vmsInScope(inventory, options);
  if (!inventory) {
    findings.push(
      warning('estate.terraform.no-estate', 'No estate is loaded, so there are no VMs to write.', {
        remediation: 'Import an RVTools export with the strip at the top of the page.',
      }),
    );
  } else if (!options.cluster) {
    findings.push(warning('estate.terraform.no-cluster', 'Choose a source cluster to rehost.'));
  }

  const used = new Set        ();
  const rows        = [];
  const unfit           = [];
  for (const vm of vms) {
    const fit = rightsize(options.cloud, vm.vcpu, vm.memoryGib);
    if (!fit) {
      unfit.push(vm.name);
      continue;
    }
    const { sizes, rdm } = movableDisks(vm);
    const notes = assessVm(vm)
      .filter((f) => f.check.severity !== 'note' || f.check.cloudOnly)
      .map((f) => f.check.title);
    if (rdm > 0) notes.push(`${rdm} RDM disk(s) not included`);
    rows.push({
      key: keyFor(options.cloud, vm.name, used),
      vm,
      type: fit.type,
      ...(fit.ocpus ? { ocpus: fit.ocpus } : {}),
      memory: Math.ceil(vm.memoryGib),
      os: osOf(vm),
      disks: sizes.length > 0 ? sizes : [64],
      notes,
    });
  }

  if (unfit.length > 0) {
    findings.push(
      warning(
        'estate.terraform.no-fit',
        `${unfit.length} VM(s) are larger than any single ${options.cloud} type in the catalog and were left out: ${unfit.slice(0, 5).join(', ')}${unfit.length > 5 ? '…' : ''}.`,
        { remediation: 'Plan these on dedicated or bare-metal capacity, or as a VMware-on-cloud target.' },
      ),
    );
  }
  if (skipped.length > 0) {
    const why = new Map                ();
    for (const s of skipped) why.set(s.why, (why.get(s.why) ?? 0) + 1);
    findings.push(
      info(
        'estate.terraform.skipped',
        `Left out ${skipped.length} VM(s): ${[...why.entries()].map(([w, n]) => `${n} ${w}`).join(', ')}.`,
      ),
    );
  }
  const tooManyDisks = rows.filter((r) => r.disks.length > 12);
  if (options.cloud === 'aws' && tooManyDisks.length > 0) {
    findings.push(
      warning('estate.terraform.many-disks', `${tooManyDisks.length} VM(s) have more than 12 disks; attach the rest by hand.`),
    );
  }

  const source = (r     )         => `${(r.vm.vcenter ?? '').split('.')[0]}/${r.vm.cluster ?? ''}`;
  const keyWidth = Math.max(0, ...rows.map((r) => q(r.key).length));
  const vmLines = rows.map((r) => {
    const parts = [
      `type = ${q(r.type)}`,
      ...(r.ocpus ? [`ocpus = ${r.ocpus}`, `memory = ${r.memory}`] : []),
      `os = ${q(r.os)}`,
      `disks = [${r.disks.join(', ')}]`,
      `source = ${q(r.vm.name)}`,
    ];
    return `    ${q(r.key).padEnd(keyWidth)} = { ${parts.join(', ')} }`;
  });

  const csv = [
    'name,target_key,source,power,vcpu,memory_gib,disks_gib,os,target_type,notes',
    ...rows.map((r) =>
      [
        r.vm.name,
        r.key,
        source(r),
        r.vm.powerState,
        r.vm.vcpu,
        Math.round(r.vm.memoryGib),
        r.disks.join(' '),
        r.os,
        r.type,
        r.notes.join('; '),
      ]
        .map((v) => {
          const s = String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    ),
  ].join('\n');

  const locals = `locals {
  # One entry per VM: the target type sized from its vCPU and memory, and one
  # disk per VMDK in GiB, the first being the boot disk. Delete a line to leave
  # that VM out of this wave.
  vms = {
${vmLines.join('\n')}
  }

  data_disks = merge([
    for name, vm in local.vms : {
      for i, size in slice(vm.disks, 1, length(vm.disks)) :
      "\${name}-d\${i + 1}" => { vm = name, size = size, lun = i + 1 }
    }
  ]...)
}`;

  const top = header([
    `Rehost ${rows.length} VM(s) from ${options.cluster || 'no cluster'} to ${providerFor(options.cloud === 'google' ? 'google' : options.cloud).label} — generated by ArchToolKit from the imported estate.`,
    '',
    'The replication service copies the disks; this declares what each VM becomes:',
    'the instance type sized from its vCPU and memory, and a disk per VMDK.',
    'Raw device mappings are not included — they move as storage, not as disks.',
    'rehost-plan.csv beside this file lists every VM, its target and what to check first.',
  ]);

  const main = [top, '', requiredProvider(options.cloud), '', PROVIDER_AND_VARS[options.cloud](options.region), '', locals, '', RESOURCES[options.cloud]].join('\n');
  return { files: { 'main.tf': `${main.trimEnd()}\n`, 'rehost-plan.csv': `${csv}\n` }, findings };
}

const IMAGE_VAR = `variable "image_ids" {
  description = "Image for each OS family, keys windows and linux. With a replication service, its launch settings supply the image instead."
  type        = map(string)
}`;

const PROVIDER_AND_VARS                                                  = {
  aws: (region) => `provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = ${q(region || 'us-east-1')}
}

variable "subnet_id" {
  description = "Subnet the rehosted VMs land in."
  type        = string
}

${IMAGE_VAR}`,
  azure: (region) => `provider "azurerm" {
  features {}
}

variable "location" {
  type    = string
  default = ${q(region || 'eastus')}
}

variable "resource_group_name" {
  type = string
}

variable "subnet_id" {
  description = "Subnet the rehosted VMs land in."
  type        = string
}

variable "admin_username" {
  type    = string
  default = "azureadmin"
}

variable "admin_password" {
  description = "Windows local administrator password. Supply it from a vault, never a file."
  type        = string
  sensitive   = true
}

variable "ssh_public_key" {
  description = "Public key for the Linux admin user."
  type        = string
}

${IMAGE_VAR}`,
  google: (region) => `provider "google" {
  project = var.project
}

variable "project" {
  type = string
}

variable "zone" {
  type    = string
  default = ${q(region || 'us-central1-a')}
}

variable "subnetwork" {
  description = "Subnetwork self link the rehosted VMs land in."
  type        = string
}

${IMAGE_VAR}`,
  oci: (region) => `provider "oci" {
  region = var.region
}

variable "region" {
  type    = string
  default = ${q(region || 'us-ashburn-1')}
}

variable "compartment_id" {
  type = string
}

variable "availability_domain" {
  type = string
}

variable "subnet_id" {
  description = "Subnet the rehosted VMs land in."
  type        = string
}

${IMAGE_VAR}`,
};

const RESOURCES                              = {
  aws: `locals {
  device_names = ["/dev/sdf", "/dev/sdg", "/dev/sdh", "/dev/sdi", "/dev/sdj", "/dev/sdk", "/dev/sdl", "/dev/sdm", "/dev/sdn", "/dev/sdo", "/dev/sdp"]
}

resource "aws_instance" "vm" {
  for_each = local.vms

  ami           = var.image_ids[each.value.os]
  instance_type = each.value.type
  subnet_id     = var.subnet_id

  root_block_device {
    volume_size = each.value.disks[0]
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name     = each.key
    SourceVm = each.value.source
  }
}

resource "aws_ebs_volume" "data" {
  for_each = { for k, d in local.data_disks : k => d if d.lun <= length(local.device_names) }

  availability_zone = aws_instance.vm[each.value.vm].availability_zone
  size              = each.value.size
  type              = "gp3"
  encrypted         = true

  tags = {
    Name = each.key
  }
}

resource "aws_volume_attachment" "data" {
  for_each = aws_ebs_volume.data

  device_name = local.device_names[local.data_disks[each.key].lun - 1]
  volume_id   = each.value.id
  instance_id = aws_instance.vm[local.data_disks[each.key].vm].id
}`,
  azure: `resource "azurerm_network_interface" "vm" {
  for_each = local.vms

  name                = "\${each.key}-nic"
  location            = var.location
  resource_group_name = var.resource_group_name

  ip_configuration {
    name                          = "primary"
    subnet_id                     = var.subnet_id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "vm" {
  for_each = { for k, v in local.vms : k => v if v.os == "linux" }

  name                  = each.key
  location              = var.location
  resource_group_name   = var.resource_group_name
  size                  = each.value.type
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.vm[each.key].id]
  source_image_id       = var.image_ids["linux"]

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = each.value.disks[0]
  }

  tags = {
    source_vm = each.value.source
  }
}

resource "azurerm_windows_virtual_machine" "vm" {
  for_each = { for k, v in local.vms : k => v if v.os == "windows" }

  name                  = each.key
  computer_name         = substr(each.key, 0, 15)
  location              = var.location
  resource_group_name   = var.resource_group_name
  size                  = each.value.type
  admin_username        = var.admin_username
  admin_password        = var.admin_password
  network_interface_ids = [azurerm_network_interface.vm[each.key].id]
  source_image_id       = var.image_ids["windows"]

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = each.value.disks[0]
  }

  tags = {
    source_vm = each.value.source
  }
}

resource "azurerm_managed_disk" "data" {
  for_each = local.data_disks

  name                 = each.key
  location             = var.location
  resource_group_name  = var.resource_group_name
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = each.value.size
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  for_each = local.data_disks

  managed_disk_id    = azurerm_managed_disk.data[each.key].id
  virtual_machine_id = local.vms[each.value.vm].os == "windows" ? azurerm_windows_virtual_machine.vm[each.value.vm].id : azurerm_linux_virtual_machine.vm[each.value.vm].id
  lun                = each.value.lun
  caching            = "ReadOnly"
}`,
  google: `resource "google_compute_disk" "data" {
  for_each = local.data_disks

  name = each.key
  zone = var.zone
  size = each.value.size
  type = "pd-balanced"
}

resource "google_compute_instance" "vm" {
  for_each = local.vms

  name         = each.key
  zone         = var.zone
  machine_type = each.value.type

  boot_disk {
    initialize_params {
      image = var.image_ids[each.value.os]
      size  = each.value.disks[0]
    }
  }

  dynamic "attached_disk" {
    for_each = [for k, d in local.data_disks : k if d.vm == each.key]
    content {
      source = google_compute_disk.data[attached_disk.value].id
    }
  }

  network_interface {
    subnetwork = var.subnetwork
  }

  labels = {
    rehosted_by = "archtoolkit"
  }
}`,
  oci: `resource "oci_core_instance" "vm" {
  for_each = local.vms

  availability_domain = var.availability_domain
  compartment_id      = var.compartment_id
  display_name        = each.key
  shape               = each.value.type

  shape_config {
    ocpus         = each.value.ocpus
    memory_in_gbs = each.value.memory
  }

  source_details {
    source_type             = "image"
    source_id               = var.image_ids[each.value.os]
    boot_volume_size_in_gbs = max(50, each.value.disks[0])
  }

  create_vnic_details {
    subnet_id = var.subnet_id
  }

  freeform_tags = {
    SourceVm = each.value.source
  }
}

resource "oci_core_volume" "data" {
  for_each = local.data_disks

  availability_domain = var.availability_domain
  compartment_id      = var.compartment_id
  display_name        = each.key
  size_in_gbs         = max(50, each.value.size)
}

resource "oci_core_volume_attachment" "data" {
  for_each = local.data_disks

  attachment_type = "paravirtualized"
  instance_id     = oci_core_instance.vm[each.value.vm].id
  volume_id       = oci_core_volume.data[each.key].id
}`,
};

/** Resource types each rehost file declares, for the catalog check. */
export const REHOST_EMITS                                         = {
  aws: ['aws_instance', 'aws_ebs_volume', 'aws_volume_attachment'],
  azure: [
    'azurerm_network_interface',
    'azurerm_linux_virtual_machine',
    'azurerm_windows_virtual_machine',
    'azurerm_managed_disk',
    'azurerm_virtual_machine_data_disk_attachment',
  ],
  google: ['google_compute_disk', 'google_compute_instance'],
  oci: ['oci_core_instance', 'oci_core_volume', 'oci_core_volume_attachment'],
};

// ---------------------------------------------------------------------------
// Landing on VCF
// ---------------------------------------------------------------------------

                                                     
                                                                                       
                              
                                 
                                     
                                 
 

const ident = (s        )         => {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return /^[a-z_]/.test(cleaned) ? cleaned : `x_${cleaned}`;
};

function uniqueIdent(base        , used             )         {
  let id = ident(base) || 'x';
  for (let i = 2; used.has(id); i += 1) id = `${ident(base)}_${i}`;
  used.add(id);
  return id;
}

/** Attribute lines aligned on "=", as terraform fmt writes a group. */
function aligned(pairs                             )         {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `  ${k.padEnd(width)} = ${v}`).join('\n');
}

export function vsphereLandingFiles(inventory                              , options                )              {
  const findings            = [];
  const { vms } = vmsInScope(inventory, { ...options, includePoweredOff: true, skipBlocked: false });
  if (!inventory) {
    findings.push(
      warning('estate.terraform.no-estate', 'No estate is loaded, so there is nothing to recreate.', {
        remediation: 'Import an RVTools export with the strip at the top of the page.',
      }),
    );
  } else if (!options.cluster) {
    findings.push(warning('estate.terraform.no-cluster', 'Choose the source cluster whose landing zone to build.'));
  }

  // --- port groups the VMs use, with their VLANs -----------------------------
  const vcenter = vms[0]?.vcenter;
  const networkNames = new Set(vms.flatMap((v) => [...(v.networks ?? []), ...(v.nics ?? []).map((n) => n.network ?? '')]).filter(Boolean));
  const portGroups                                    = [];
  for (const name of [...networkNames].sort()) {
    const pg =
      inventory?.networks.find((n) => n.name === name && n.kind === 'distributed' && scopedKey(n.vcenter, '') === scopedKey(vcenter, '')) ??
      inventory?.networks.find((n) => n.name === name);
    const vlan = Number(pg?.vlanId);
    portGroups.push({ name, ...(Number.isFinite(vlan) ? { vlan } : {}) });
  }
  const noVlan = portGroups.filter((p) => p.vlan === undefined);
  if (noVlan.length > 0) {
    findings.push(
      info('estate.terraform.vlan-unknown', `${noVlan.length} port group(s) have no VLAN in the estate and are written with VLAN 0.`, {
        remediation: 'Check them against the switch configuration before applying.',
      }),
    );
  }

  // --- VM folders, parents before children ------------------------------------
  const folders = new Set        ();
  for (const vm of vms) {
    // "/Datacenter/a/b" → "a/b": folder paths are relative to the datacenter.
    const parts = (vm.folder ?? '').split('/').filter(Boolean).slice(1);
    for (let i = 1; i <= parts.length; i += 1) folders.add(parts.slice(0, i).join('/'));
  }
  const folderList = [...folders].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  // --- resource pools ------------------------------------------------------------
  const poolPaths = new Set        ();
  for (const vm of vms) {
    const m = /\/Resources\/(.+)$/.exec(vm.resourcePool ?? '');
    if (m?.[1]) {
      const parts = m[1].split('/');
      for (let i = 1; i <= parts.length; i += 1) poolPaths.add(parts.slice(0, i).join('/'));
    }
  }
  const pools = [...poolPaths].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  // --- DRS rules, recreated after the VMs arrive -----------------------------------
  const rules = new Map                                             ();
  for (const vm of vms) {
    const names = vm.clusterRuleNames ?? [];
    const kinds = vm.clusterRules ?? [];
    names.forEach((rule, i) => {
      const entry = rules.get(rule) ?? { kind: kinds[i] ?? kinds[0] ?? '', members: [] };
      entry.members.push(vm.name);
      rules.set(rule, entry);
    });
  }

  // --- custom attributes the VMs carry ------------------------------------------
  const attributes = [...new Set(vms.flatMap((v) => Object.keys(v.customAttributes ?? {})))].sort();

  const used = new Set        ();
  const blocks           = [];
  blocks.push(`provider "vsphere" {
  vsphere_server = var.vsphere_server
}

variable "vsphere_server" {
  type    = string
  default = ${q(options.vsphereServer || 'vcenter.example.com')}
}

variable "create_drs_rules" {
  description = "Stage 2: set true once the VMs have migrated, to recreate the DRS rules between them."
  type        = bool
  default     = false
}

data "vsphere_datacenter" "target" {
  name = ${q(options.datacenter || 'DC1')}
}

data "vsphere_compute_cluster" "target" {
  name          = ${q(options.targetCluster || 'wld01-cluster01')}
  datacenter_id = data.vsphere_datacenter.target.id
}

data "vsphere_distributed_virtual_switch" "target" {
  name          = ${q(options.distributedSwitch || 'wld01-vds01')}
  datacenter_id = data.vsphere_datacenter.target.id
}`);

  for (const pg of portGroups) {
    blocks.push(`resource "vsphere_distributed_port_group" "${uniqueIdent(`pg_${pg.name}`, used)}" {
  name                            = ${q(pg.name)}
  distributed_virtual_switch_uuid = data.vsphere_distributed_virtual_switch.target.id
  vlan_id                         = ${pg.vlan ?? 0}
}`);
  }

  const folderIds = new Map                ();
  for (const path of folderList) {
    const id = uniqueIdent(`folder_${path}`, used);
    folderIds.set(path, id);
    const parent = path.includes('/') ? folderIds.get(path.slice(0, path.lastIndexOf('/'))) : undefined;
    const leaf = path.slice(path.lastIndexOf('/') + 1);
    blocks.push(`resource "vsphere_folder" "${id}" {
  path          = ${parent ? `"\${vsphere_folder.${parent}.path}/${leaf.replace(/"/g, '\\"')}"` : q(leaf)}
  type          = "vm"
  datacenter_id = data.vsphere_datacenter.target.id
}`);
  }

  const poolIds = new Map                ();
  for (const path of pools) {
    const id = uniqueIdent(`pool_${path}`, used);
    poolIds.set(path, id);
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined;
    const parent = parentPath ? `vsphere_resource_pool.${poolIds.get(parentPath)}.id` : 'data.vsphere_compute_cluster.target.resource_pool_id';
    const leaf = path.slice(path.lastIndexOf('/') + 1);
    const source = inventory?.resourcePools?.find(
      (p) => (p.path ?? '').endsWith(`/Resources/${path}`) && scopedKey(p.vcenter, '') === scopedKey(vcenter, ''),
    );
    const settings                     = [];
    const level = (l                    ) => (l && ['low', 'normal', 'high'].includes(l) ? l : undefined);
    const cpuLevel = level(source?.cpuSharesLevel);
    const memLevel = level(source?.memorySharesLevel);
    if (cpuLevel) settings.push(['cpu_share_level', q(cpuLevel)]);
    if (source?.cpuReservationMhz) settings.push(['cpu_reservation', String(Math.round(source.cpuReservationMhz))]);
    if (source?.cpuExpandable !== undefined) settings.push(['cpu_expandable', String(source.cpuExpandable)]);
    if (memLevel) settings.push(['memory_share_level', q(memLevel)]);
    if (source?.memoryReservationGib) settings.push(['memory_reservation', String(Math.round(source.memoryReservationGib * 1024))]);
    if (source?.memoryExpandable !== undefined) settings.push(['memory_expandable', String(source.memoryExpandable)]);
    const head                     = [
      ['name', q(leaf)],
      ['parent_resource_pool_id', parent],
    ];
    blocks.push(`resource "vsphere_resource_pool" "${id}" {
${aligned(head)}${settings.length > 0 ? `\n\n${aligned(settings)}` : ''}
}`);
  }

  for (const attr of attributes) {
    blocks.push(`resource "vsphere_custom_attribute" "${uniqueIdent(`attr_${attr}`, used)}" {
  name                = ${q(attr)}
  managed_object_type = "VirtualMachine"
}`);
  }

  const ruleMembers = [...new Set([...rules.values()].flatMap((r) => r.members))].sort();
  if (rules.size > 0) {
    blocks.push(`data "vsphere_virtual_machine" "rule_member" {
  for_each = var.create_drs_rules ? toset(${JSON.stringify(ruleMembers)}) : toset([])

  name          = each.key
  datacenter_id = data.vsphere_datacenter.target.id
}`);
    for (const [name, rule] of [...rules.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (rule.members.length < 2) continue;
      const anti = /anti/i.test(rule.kind);
      const type = anti ? 'vsphere_compute_cluster_vm_anti_affinity_rule' : 'vsphere_compute_cluster_vm_affinity_rule';
      blocks.push(`resource "${type}" "${uniqueIdent(`rule_${name}`, used)}" {
  count = var.create_drs_rules ? 1 : 0

  name                = ${q(name)}
  compute_cluster_id  = data.vsphere_compute_cluster.target.id
  virtual_machine_ids = [for n in ${JSON.stringify(rule.members.sort())} : data.vsphere_virtual_machine.rule_member[n].id]
}`);
    }
  }

  const top = header([
    `Landing zone for ${options.cluster || 'no cluster'} on VCF — generated by ArchToolKit from the imported estate.`,
    '',
    `${portGroups.length} port group(s), ${folderList.length} folder(s), ${pools.length} resource pool(s), ${attributes.length} custom attribute(s)`,
    `and ${[...rules.values()].filter((r) => r.members.length > 1).length} DRS rule(s), for ${vms.length} VM(s).`,
    '',
    'Stage 1: terraform apply — builds what the VMs land in, before HCX or vMotion moves them.',
    'Stage 2: terraform apply -var create_drs_rules=true — once the VMs are on the target.',
    'Credentials come from VSPHERE_USER and VSPHERE_PASSWORD.',
  ]);

  const main = [top, '', requiredProvider('vsphere'), '', ...blocks.flatMap((b) => [b, ''])].join('\n');
  return { files: { 'main.tf': `${main.trimEnd()}\n` }, findings };
}

export const LANDING_EMITS                    = [
  'vsphere_distributed_port_group',
  'vsphere_folder',
  'vsphere_resource_pool',
  'vsphere_custom_attribute',
  'vsphere_compute_cluster_vm_anti_affinity_rule',
  'vsphere_compute_cluster_vm_affinity_rule',
];
