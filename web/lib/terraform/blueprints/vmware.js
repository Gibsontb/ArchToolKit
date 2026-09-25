/**
 * VMware vSphere / vCenter Terraform blueprints.
 *
 * Two kinds, as on every VMware platform here:
 *
 *  - Scenarios, written out by hand: the builds that take several resources
 *    together — a VM cloned and customised from a template, a cluster with HA,
 *    DRS and its hosts, a distributed switch with its port groups, a
 *    Supervisor with its namespaces. Existing infrastructure (the datacenter,
 *    a cluster, a template) is looked up with data sources, not created.
 *  - One blueprint per resource in the vmware/vsphere provider, with every
 *    argument it takes (schema-blueprints.ts), for everything a scenario does not
 *    cover and for the arguments a scenario leaves at the provider's default.
 *
 * Every scenario is run through `terraform validate` with the real provider by
 * tools/validate-terraform-blueprints.mjs.
 */

                                                                        
import { providerBlueprints } from '../schema-blueprints.js';
import { ident, items, n, on, pairs, q, qlist, scenario, YES_NO_OPTIONS } from './scenario-common.js';

const opts = (values                   ) => values.map((v) => ({ value: v, label: v }));

/** The lookups nearly every vSphere scenario starts from. */
const WHERE = [
  { id: 'datacenter', label: 'Datacenter', control: 'text', default: 'dc01', hint: 'existing, looked up by name' },
  { id: 'cluster', label: 'Cluster', control: 'text', default: 'cl01', hint: 'existing, looked up by name' },
]         ;

function datacenterData(v                         )         {
  return `data "vsphere_datacenter" "dc" {
  name = ${q(v.datacenter)}
}`;
}

function clusterData(v                         )         {
  return `data "vsphere_compute_cluster" "cluster" {
  name          = ${q(v.cluster)}
  datacenter_id = data.vsphere_datacenter.dc.id
}`;
}

function hostData(hosts                   )         {
  return hosts
    .map(
      (h) => `data "vsphere_host" "${ident(h, 'host')}" {
  name          = ${q(h)}
  datacenter_id = data.vsphere_datacenter.dc.id
}`,
    )
    .join('\n\n');
}

function hostIds(hosts                   )         {
  return `[${hosts.map((h) => `data.vsphere_host.${ident(h, 'host')}.id`).join(', ')}]`;
}

const GUEST_IDS = [
  'rhel9_64Guest', 'rhel8_64Guest', 'ubuntu64Guest', 'debian12_64Guest', 'sles15_64Guest', 'rockylinux_64Guest',
  'almalinux_64Guest', 'otherLinux64Guest', 'windows2022srvNext_64Guest', 'windows2019srvNext_64Guest',
  'windows2019srv_64Guest', 'windows11_64Guest', 'windows9_64Guest', 'other5xLinux64Guest',
];

// --- VMs ---------------------------------------------------------------------

const vmFromTemplate = scenario('vsphere', {
  id: 'vsphere_vm_from_template',
  label: 'VM cloned from a template, with guest customization',
  description:
    'Clones a VM from an existing template, resizes CPU, memory and the first disk, and customises the guest — hostname, domain, static IP or DHCP, DNS — for Linux or Windows. Datacenter, cluster, datastore, network and template are looked up by name.',
  inputs: [
    ...WHERE,
    { id: 'datastore', label: 'Datastore', control: 'text', default: 'vsanDatastore' },
    { id: 'network_label', label: 'Port group', control: 'text', default: 'VM Network' },
    { id: 'template', label: 'Template', control: 'text', default: 'rhel9-template', hint: 'existing VM template' },
    { id: 'vm_name', label: 'VM name', control: 'text', default: 'app-01' },
    { id: 'folder', label: 'VM folder', control: 'text', default: '', placeholder: 'Prod/App', hint: 'optional, must exist' },
    { id: 'num_cpus', label: 'vCPUs', control: 'number', default: 2, min: 1 },
    { id: 'memory', label: 'Memory (MB)', control: 'number', default: 4096, min: 256 },
    { id: 'disk_gb', label: 'First disk (GB)', control: 'number', default: 60, min: 1, hint: 'at least the template’s size' },
    { id: 'os_family', label: 'Guest OS family', control: 'select', options: opts(['linux', 'windows']), default: 'linux' },
    { id: 'host_name', label: 'Guest hostname', control: 'text', default: 'app-01' },
    { id: 'domain', label: 'Domain', control: 'text', default: 'example.com' },
    { id: 'ip_mode', label: 'IP addressing', control: 'select', options: opts(['static', 'dhcp']), default: 'static' },
    { id: 'ipv4_address', label: 'IPv4 address', control: 'text', default: '10.10.20.21', showWhen: { input: 'ip_mode', equals: ['static'] } },
    { id: 'ipv4_prefix', label: 'Prefix length', control: 'number', default: 24, min: 1, max: 32, showWhen: { input: 'ip_mode', equals: ['static'] } },
    { id: 'ipv4_gateway', label: 'Gateway', control: 'text', default: '10.10.20.1', showWhen: { input: 'ip_mode', equals: ['static'] } },
    { id: 'dns_servers', label: 'DNS servers', control: 'text', default: '10.10.0.10, 10.10.0.11', hint: 'comma-separated' },
    { id: 'time_zone', label: 'Windows time zone', control: 'number', default: 35, hint: 'Microsoft index; 35 = Eastern', showWhen: { input: 'os_family', equals: ['windows'] } },
    { id: 'join_domain', label: 'Join an AD domain', control: 'select', options: YES_NO_OPTIONS, default: 'false', showWhen: { input: 'os_family', equals: ['windows'] } },
    { id: 'domain_admin_user', label: 'Domain join account', control: 'text', default: 'svc-join@example.com', showWhen: { input: 'join_domain', equals: ['true'] } },
    { id: 'annotation', label: 'Notes', control: 'text', default: 'Managed by Terraform', section: 'More' },
    { id: 'wait_for_ip', label: 'Wait for an IP (minutes)', control: 'number', default: 5, min: 0, section: 'More', hint: '0 = do not wait' },
  ],
  emits: ['vsphere_virtual_machine'],
  body: (v) => {
    const windows = v.os_family === 'windows';
    const staticIp = v.ip_mode === 'static';
    const dns = qlist(v.dns_servers);
    const nic = staticIp
      ? `      network_interface {
        ipv4_address = ${q(v.ipv4_address)}
        ipv4_netmask = ${n(v.ipv4_prefix, 24)}
      }

      ipv4_gateway    = ${q(v.ipv4_gateway)}`
      : `      network_interface {}`;
    const options = windows
      ? `      windows_options {
        computer_name  = ${q(v.host_name)}
        admin_password = var.windows_admin_password
        time_zone      = ${n(v.time_zone, 35)}${on(v.join_domain) ? `
        join_domain           = ${q(v.domain)}
        domain_admin_user     = ${q(v.domain_admin_user)}
        domain_admin_password = var.domain_join_password` : ''}
      }`
      : `      linux_options {
        host_name = ${q(v.host_name)}
        domain    = ${q(v.domain)}
      }`;
    const secrets = windows
      ? `

variable "windows_admin_password" {
  type        = string
  description = "Local Administrator password set by customization"
  sensitive   = true
}${on(v.join_domain) ? `

variable "domain_join_password" {
  type        = string
  description = "Password for the domain join account"
  sensitive   = true
}` : ''}`
      : '';
    return `${datacenterData(v)}

${clusterData(v)}

data "vsphere_datastore" "datastore" {
  name          = ${q(v.datastore)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_network" "network" {
  name          = ${q(v.network_label)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_virtual_machine" "template" {
  name          = ${q(v.template)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

resource "vsphere_virtual_machine" "vm" {
  name             = ${q(v.vm_name)}
  resource_pool_id = data.vsphere_compute_cluster.cluster.resource_pool_id
  datastore_id     = data.vsphere_datastore.datastore.id${String(v.folder ?? '').trim() ? `
  folder           = ${q(v.folder)}` : ''}
  annotation       = ${q(v.annotation)}

  num_cpus  = ${n(v.num_cpus, 2)}
  memory    = ${n(v.memory, 4096)}
  guest_id  = data.vsphere_virtual_machine.template.guest_id
  firmware  = data.vsphere_virtual_machine.template.firmware
  scsi_type = data.vsphere_virtual_machine.template.scsi_type

  wait_for_guest_net_timeout = ${n(v.wait_for_ip, 5)}

  network_interface {
    network_id   = data.vsphere_network.network.id
    adapter_type = data.vsphere_virtual_machine.template.network_interface_types[0]
  }

  disk {
    label            = "disk0"
    size             = max(${n(v.disk_gb, 60)}, data.vsphere_virtual_machine.template.disks[0].size)
    thin_provisioned = data.vsphere_virtual_machine.template.disks[0].thin_provisioned
  }

  clone {
    template_uuid = data.vsphere_virtual_machine.template.id

    customize {
${options}

${nic}
      dns_server_list = ${dns}
      dns_suffix_list = [${q(v.domain)}]
    }
  }
}

output "vm_ip" {
  value = vsphere_virtual_machine.vm.default_ip_address
}${secrets}`;
  },
});

const vmFromLibrary = scenario('vsphere', {
  id: 'vsphere_vm_from_content_library',
  label: 'VM deployed from a content library item',
  description:
    'Deploys a VM from an OVF template or VM template held in a content library — the way templates are shared across vCenters — with its CPU, memory and network set, and optional vApp properties for appliances that read them.',
  inputs: [
    ...WHERE,
    { id: 'datastore', label: 'Datastore', control: 'text', default: 'vsanDatastore' },
    { id: 'network_label', label: 'Port group', control: 'text', default: 'VM Network' },
    { id: 'library', label: 'Content library', control: 'text', default: 'templates' },
    { id: 'item', label: 'Library item', control: 'text', default: 'ubuntu-24.04-ovf' },
    { id: 'vm_name', label: 'VM name', control: 'text', default: 'web-01' },
    { id: 'num_cpus', label: 'vCPUs', control: 'number', default: 2, min: 1 },
    { id: 'memory', label: 'Memory (MB)', control: 'number', default: 4096, min: 256 },
    { id: 'disk_gb', label: 'Disk (GB)', control: 'number', default: 40, min: 1 },
    { id: 'guest_id', label: 'Guest OS', control: 'combo', options: opts(GUEST_IDS), default: 'ubuntu64Guest' },
    { id: 'vapp_properties', label: 'vApp properties', control: 'textarea', default: '', placeholder: 'hostname=web-01\nuser-data=...', hint: 'key=value per line; optional', section: 'More' },
  ],
  emits: ['vsphere_virtual_machine'],
  body: (v) => {
    const props = pairs(v.vapp_properties);
    return `${datacenterData(v)}

${clusterData(v)}

data "vsphere_datastore" "datastore" {
  name          = ${q(v.datastore)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_network" "network" {
  name          = ${q(v.network_label)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_content_library" "library" {
  name = ${q(v.library)}
}

data "vsphere_content_library_item" "item" {
  name       = ${q(v.item)}
  type       = "ovf"
  library_id = data.vsphere_content_library.library.id
}

resource "vsphere_virtual_machine" "vm" {
  name             = ${q(v.vm_name)}
  resource_pool_id = data.vsphere_compute_cluster.cluster.resource_pool_id
  datastore_id     = data.vsphere_datastore.datastore.id
  guest_id         = ${q(v.guest_id)}
  num_cpus         = ${n(v.num_cpus, 2)}
  memory           = ${n(v.memory, 4096)}

  network_interface {
    network_id = data.vsphere_network.network.id
  }

  disk {
    label = "disk0"
    size  = ${n(v.disk_gb, 40)}
  }

  clone {
    template_uuid = data.vsphere_content_library_item.item.id
  }${props.length > 0 ? `

  vapp {
    properties = {
${props.map(([k, val]) => `      ${JSON.stringify(k)} = ${q(val)}`).join('\n')}
    }
  }` : ''}
}`;
  },
});

const vmFromOvf = scenario('vsphere', {
  id: 'vsphere_vm_from_ovf',
  label: 'VM deployed from an OVF/OVA URL',
  description:
    'Deploys an appliance straight from an OVF or OVA on a web server or local path, mapping its OVF networks to a port group and setting the disk provisioning — the usual route for vendor appliances.',
  inputs: [
    ...WHERE,
    { id: 'host', label: 'ESXi host to deploy through', control: 'text', default: 'esx01.example.com' },
    { id: 'datastore', label: 'Datastore', control: 'text', default: 'vsanDatastore' },
    { id: 'network_label', label: 'Port group', control: 'text', default: 'VM Network' },
    { id: 'ovf_network', label: 'OVF network name', control: 'text', default: 'Network 1', hint: 'as named inside the OVF' },
    { id: 'source', label: 'Source', control: 'select', options: opts(['remote_ovf_url', 'local_ovf_path']), default: 'remote_ovf_url' },
    { id: 'ovf_location', label: 'OVF/OVA URL or path', control: 'text', default: 'https://repo.example.com/appliance.ova' },
    { id: 'vm_name', label: 'VM name', control: 'text', default: 'appliance-01' },
    { id: 'disk_provisioning', label: 'Disk provisioning', control: 'select', options: opts(['thin', 'flat', 'thick', 'eagerZeroedThick', 'sameAsSource']), default: 'thin' },
    { id: 'allow_unverified_ssl_cert', label: 'Accept the web server’s self-signed certificate', control: 'select', options: YES_NO_OPTIONS, default: 'false', section: 'More' },
  ],
  emits: ['vsphere_virtual_machine'],
  body: (v) => `${datacenterData(v)}

${clusterData(v)}

data "vsphere_host" "host" {
  name          = ${q(v.host)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_datastore" "datastore" {
  name          = ${q(v.datastore)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_network" "network" {
  name          = ${q(v.network_label)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

resource "vsphere_virtual_machine" "vm" {
  name             = ${q(v.vm_name)}
  datacenter_id    = data.vsphere_datacenter.dc.id
  resource_pool_id = data.vsphere_compute_cluster.cluster.resource_pool_id
  datastore_id     = data.vsphere_datastore.datastore.id
  host_system_id   = data.vsphere_host.host.id

  wait_for_guest_net_timeout = 0
  wait_for_guest_ip_timeout  = 0

  ovf_deploy {
    ${v.source === 'local_ovf_path' ? 'local_ovf_path' : 'remote_ovf_url'}            = ${q(v.ovf_location)}
    disk_provisioning         = ${q(v.disk_provisioning)}
    allow_unverified_ssl_cert = ${on(v.allow_unverified_ssl_cert)}
    ovf_network_map = {
      ${JSON.stringify(String(v.ovf_network ?? 'Network 1'))} = data.vsphere_network.network.id
    }
  }

  # The appliance's own settings come from the OVF; leave them to it.
  lifecycle {
    ignore_changes = [annotation, vapp[0].properties]
  }
}`,
});

const vmFromIso = scenario('vsphere', {
  id: 'vsphere_vm_blank_iso',
  label: 'New VM from scratch, booting an ISO',
  description:
    'A new, empty VM — firmware, secure boot, vTPM optional, disks and NICs as listed — with an installer ISO from a datastore in its CD drive. For the builds a template does not exist for yet.',
  inputs: [
    ...WHERE,
    { id: 'datastore', label: 'Datastore', control: 'text', default: 'vsanDatastore' },
    { id: 'vm_name', label: 'VM name', control: 'text', default: 'build-01' },
    { id: 'guest_id', label: 'Guest OS', control: 'combo', options: opts(GUEST_IDS), default: 'rhel9_64Guest' },
    { id: 'num_cpus', label: 'vCPUs', control: 'number', default: 2, min: 1 },
    { id: 'memory', label: 'Memory (MB)', control: 'number', default: 4096, min: 256 },
    { id: 'disks', label: 'Disks (GB)', control: 'text', default: '60, 100', hint: 'comma-separated, one per disk' },
    { id: 'networks', label: 'Port groups', control: 'text', default: 'VM Network', hint: 'comma-separated, one NIC each' },
    { id: 'iso_datastore', label: 'ISO datastore', control: 'text', default: 'iso-nfs' },
    { id: 'iso_path', label: 'ISO path', control: 'text', default: 'iso/rhel-9.4-x86_64-dvd.iso' },
    { id: 'firmware', label: 'Firmware', control: 'select', options: opts(['efi', 'bios']), default: 'efi' },
    { id: 'secure_boot', label: 'EFI secure boot', control: 'select', options: YES_NO_OPTIONS, default: 'true', showWhen: { input: 'firmware', equals: ['efi'] } },
    { id: 'vtpm', label: 'Add a vTPM', control: 'select', options: YES_NO_OPTIONS, default: 'false', hint: 'needs a key provider on the vCenter', section: 'More' },
    { id: 'scsi_type', label: 'SCSI controller', control: 'select', options: opts(['pvscsi', 'lsilogic-sas', 'lsilogic']), default: 'pvscsi', section: 'More' },
  ],
  emits: ['vsphere_virtual_machine'],
  body: (v) => {
    const nets = items(v.networks);
    const disks = items(v.disks).map((d) => n(d, 40));
    return `${datacenterData(v)}

${clusterData(v)}

data "vsphere_datastore" "datastore" {
  name          = ${q(v.datastore)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_datastore" "iso" {
  name          = ${q(v.iso_datastore)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

${nets
  .map(
    (net, i) => `data "vsphere_network" "net${i}" {
  name          = ${q(net)}
  datacenter_id = data.vsphere_datacenter.dc.id
}`,
  )
  .join('\n\n')}

resource "vsphere_virtual_machine" "vm" {
  name             = ${q(v.vm_name)}
  resource_pool_id = data.vsphere_compute_cluster.cluster.resource_pool_id
  datastore_id     = data.vsphere_datastore.datastore.id
  guest_id         = ${q(v.guest_id)}
  num_cpus         = ${n(v.num_cpus, 2)}
  memory           = ${n(v.memory, 4096)}
  firmware         = ${q(v.firmware)}${v.firmware === 'efi' ? `
  efi_secure_boot_enabled = ${on(v.secure_boot)}` : ''}
  scsi_type        = ${q(v.scsi_type)}

  wait_for_guest_net_timeout = 0

${nets
  .map(
    (_, i) => `  network_interface {
    network_id   = data.vsphere_network.net${i}.id
    adapter_type = "vmxnet3"
  }`,
  )
  .join('\n\n')}

${disks
  .map(
    (size, i) => `  disk {
    label            = "disk${i}"
    size             = ${size}
    unit_number      = ${i}
    thin_provisioned = true
  }`,
  )
  .join('\n\n')}

  cdrom {
    datastore_id = data.vsphere_datastore.iso.id
    path         = ${q(v.iso_path)}
  }${on(v.vtpm) ? `

  vtpm {
    version = "2.0"
  }` : ''}
}`;
  },
});

// --- clusters and hosts -----------------------------------------------------------

const cluster = scenario('vsphere', {
  id: 'vsphere_cluster_ha_drs',
  label: 'Compute cluster with HA, DRS and its hosts',
  description:
    'A new compute cluster in an existing datacenter with the hosts listed moved into it, vSphere HA with admission control and host monitoring, DRS at the chosen automation level, and optionally vSAN and an EVC mode.',
  inputs: [
    { id: 'datacenter', label: 'Datacenter', control: 'text', default: 'dc01', hint: 'existing, looked up' },
    { id: 'cluster_name', label: 'Cluster name', control: 'text', default: 'cl02' },
    { id: 'hosts', label: 'Hosts', control: 'textarea', default: 'esx05.example.com\nesx06.example.com\nesx07.example.com', hint: 'already in the datacenter; one per line' },
    { id: 'drs_enabled', label: 'DRS', control: 'select', options: YES_NO_OPTIONS, default: 'true' },
    { id: 'drs_automation_level', label: 'DRS automation', control: 'select', options: opts(['fullyAutomated', 'partiallyAutomated', 'manual']), default: 'fullyAutomated', showWhen: { input: 'drs_enabled', equals: ['true'] } },
    { id: 'drs_migration_threshold', label: 'DRS migration threshold', control: 'select', options: opts(['1', '2', '3', '4', '5']), default: '3', hint: '1 conservative … 5 aggressive', showWhen: { input: 'drs_enabled', equals: ['true'] } },
    { id: 'ha_enabled', label: 'vSphere HA', control: 'select', options: YES_NO_OPTIONS, default: 'true' },
    { id: 'ha_admission_control_policy', label: 'Admission control', control: 'select', options: opts(['resourcePercentage', 'slotPolicy', 'failoverHosts', 'disabled']), default: 'resourcePercentage', showWhen: { input: 'ha_enabled', equals: ['true'] } },
    { id: 'ha_host_failures', label: 'Host failures to tolerate', control: 'number', default: 1, min: 1, max: 31, showWhen: { input: 'ha_enabled', equals: ['true'] } },
    { id: 'ha_isolation_response', label: 'Host isolation response', control: 'select', options: opts(['none', 'powerOff', 'shutdown']), default: 'powerOff', showWhen: { input: 'ha_enabled', equals: ['true'] } },
    { id: 'vsan_enabled', label: 'vSAN', control: 'select', options: YES_NO_OPTIONS, default: 'false' },
    { id: 'vsan_esa', label: 'vSAN Express Storage Architecture', control: 'select', options: YES_NO_OPTIONS, default: 'true', showWhen: { input: 'vsan_enabled', equals: ['true'] } },
    { id: 'evc_mode', label: 'EVC mode', control: 'combo', blankLabel: 'Off', options: opts(['intel-sapphirerapids', 'intel-icelake', 'intel-cascadelake', 'intel-skylake', 'amd-zen4', 'amd-zen3', 'amd-zen2']), default: '', hint: 'blank = off', section: 'More' },
    { id: 'folder', label: 'Host folder', control: 'text', default: '', section: 'More' },
  ],
  emits: ['vsphere_compute_cluster'],
  body: (v) => {
    const hosts = items(v.hosts);
    const ha = on(v.ha_enabled);
    const drs = on(v.drs_enabled);
    return `${datacenterData(v)}

${hostData(hosts)}

resource "vsphere_compute_cluster" "cluster" {
  name            = ${q(v.cluster_name)}
  datacenter_id   = data.vsphere_datacenter.dc.id
  host_system_ids = ${hostIds(hosts)}${String(v.folder ?? '').trim() ? `
  folder          = ${q(v.folder)}` : ''}${String(v.evc_mode ?? '').trim() ? `
  evc_mode        = ${q(v.evc_mode)}` : ''}

  drs_enabled = ${drs}${drs ? `
  drs_automation_level    = ${q(v.drs_automation_level)}
  drs_migration_threshold = ${n(v.drs_migration_threshold, 3)}` : ''}

  ha_enabled = ${ha}${ha ? `
  ha_host_monitoring                        = "enabled"
  ha_vm_restart_priority                    = "medium"
  ha_host_isolation_response                = ${q(v.ha_isolation_response)}
  ha_admission_control_policy               = ${q(v.ha_admission_control_policy)}
  ha_admission_control_host_failure_tolerance = ${n(v.ha_host_failures, 1)}
  ha_datastore_apd_response                 = "restartConservative"
  ha_datastore_pdl_response                 = "restartAggressive"
  ha_vm_component_protection                = "enabled"` : ''}

  vsan_enabled = ${on(v.vsan_enabled)}${on(v.vsan_enabled) ? `
  vsan_esa_enabled = ${on(v.vsan_esa)}` : ''}
}`;
  },
});

const addHosts = scenario('vsphere', {
  id: 'vsphere_add_hosts',
  label: 'Add ESXi hosts to a cluster',
  description:
    'Adds each ESXi host listed to an existing cluster, pinning its certificate thumbprint, with NTP servers set and the lockdown mode chosen. The root password is a sensitive variable.',
  inputs: [
    ...WHERE,
    { id: 'hosts', label: 'ESXi hosts', control: 'textarea', default: 'esx05.example.com\nesx06.example.com', hint: 'FQDN or IP, one per line' },
    { id: 'username', label: 'ESXi user', control: 'text', default: 'root' },
    { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: 'ntp1.example.com, ntp2.example.com' },
    { id: 'lockdown', label: 'Lockdown mode', control: 'select', options: opts(['disabled', 'normal', 'strict']), default: 'disabled' },
    { id: 'maintenance', label: 'Add in maintenance mode', control: 'select', options: YES_NO_OPTIONS, default: 'false' },
    { id: 'license', label: 'License key', control: 'text', default: '', hint: 'optional', section: 'More' },
  ],
  emits: ['vsphere_host'],
  body: (v) => {
    const hosts = items(v.hosts);
    return `${datacenterData(v)}

${clusterData(v)}

${hosts
  .map((h) => {
    const id = ident(h, 'host');
    return `data "vsphere_host_thumbprint" "${id}" {
  address  = ${q(h)}
  insecure = true
}

resource "vsphere_host" "${id}" {
  hostname    = ${q(h)}
  username    = ${q(v.username)}
  password    = var.esxi_password
  thumbprint  = data.vsphere_host_thumbprint.${id}.id
  cluster     = data.vsphere_compute_cluster.cluster.id
  lockdown    = ${q(v.lockdown)}
  maintenance = ${on(v.maintenance)}${String(v.license ?? '').trim() ? `
  license     = ${q(v.license)}` : ''}

  services {
    ntpd {
      enabled     = true
      policy      = "on"
      ntp_servers = ${qlist(v.ntp_servers)}
    }
  }
}`;
  })
  .join('\n\n')}

variable "esxi_password" {
  type        = string
  description = "Root password of the ESXi hosts"
  sensitive   = true
}`;
  },
});

const drsRules = scenario('vsphere', {
  id: 'vsphere_drs_rules',
  label: 'DRS groups and rules (VM-host, affinity, anti-affinity)',
  description:
    'A VM group and a host group, a VM-to-host rule between them (should or must), and an anti-affinity rule keeping the listed VMs on different hosts — the usual shape for licensing pinning and for keeping cluster members apart.',
  inputs: [
    ...WHERE,
    { id: 'vms', label: 'VMs', control: 'textarea', default: 'db-01\ndb-02', hint: 'existing, one per line' },
    { id: 'hosts', label: 'Hosts', control: 'textarea', default: 'esx01.example.com\nesx02.example.com', hint: 'one per line' },
    { id: 'group_prefix', label: 'Group/rule name prefix', control: 'text', default: 'db' },
    { id: 'vm_host_rule', label: 'VM-host rule', control: 'select', options: opts(['affinity', 'anti-affinity', 'none']), default: 'affinity' },
    { id: 'mandatory', label: 'Must (not should)', control: 'select', options: YES_NO_OPTIONS, default: 'false', hint: 'a must rule also blocks HA restarts that break it' },
    { id: 'vm_rule', label: 'Between the VMs', control: 'select', options: opts(['anti-affinity', 'affinity', 'none']), default: 'anti-affinity' },
  ],
  emits: [
    'vsphere_compute_cluster_vm_group',
    'vsphere_compute_cluster_host_group',
    'vsphere_compute_cluster_vm_host_rule',
    'vsphere_compute_cluster_vm_anti_affinity_rule',
    'vsphere_compute_cluster_vm_affinity_rule',
  ],
  body: (v) => {
    const vms = items(v.vms);
    const hosts = items(v.hosts);
    const p = String(v.group_prefix || 'app');
    const vmIds = `[${vms.map((m) => `data.vsphere_virtual_machine.${ident(m, 'vm')}.id`).join(', ')}]`;
    const hostRule =
      v.vm_host_rule === 'none'
        ? ''
        : `

resource "vsphere_compute_cluster_vm_host_rule" "rule" {
  compute_cluster_id       = data.vsphere_compute_cluster.cluster.id
  name                     = ${q(`${p}-vm-host`)}
  vm_group_name            = vsphere_compute_cluster_vm_group.vms.name
  ${v.vm_host_rule === 'anti-affinity' ? 'anti_affinity_host_group_name' : 'affinity_host_group_name     '} = vsphere_compute_cluster_host_group.hosts.name
  mandatory                = ${on(v.mandatory)}
}`;
    const vmRule =
      v.vm_rule === 'none'
        ? ''
        : `

resource "vsphere_compute_cluster_vm_${v.vm_rule === 'affinity' ? 'affinity' : 'anti_affinity'}_rule" "vms" {
  compute_cluster_id  = data.vsphere_compute_cluster.cluster.id
  name                = ${q(`${p}-${v.vm_rule}`)}
  virtual_machine_ids = ${vmIds}
  mandatory           = ${on(v.mandatory)}
}`;
    return `${datacenterData(v)}

${clusterData(v)}

${hostData(hosts)}

${vms
  .map(
    (m) => `data "vsphere_virtual_machine" "${ident(m, 'vm')}" {
  name          = ${q(m)}
  datacenter_id = data.vsphere_datacenter.dc.id
}`,
  )
  .join('\n\n')}

resource "vsphere_compute_cluster_vm_group" "vms" {
  compute_cluster_id  = data.vsphere_compute_cluster.cluster.id
  name                = ${q(`${p}-vms`)}
  virtual_machine_ids = ${vmIds}
}

resource "vsphere_compute_cluster_host_group" "hosts" {
  compute_cluster_id = data.vsphere_compute_cluster.cluster.id
  name               = ${q(`${p}-hosts`)}
  host_system_ids    = ${hostIds(hosts)}
}${hostRule}${vmRule}`;
  },
});

// --- networking ---------------------------------------------------------------

const vds = scenario('vsphere', {
  id: 'vsphere_vds_portgroups',
  label: 'Distributed switch + port groups',
  description:
    'A vSphere Distributed Switch across the hosts listed, with named uplinks bound to their physical NICs, MTU and link discovery set, and one port group per VLAN with the teaming and security policy chosen.',
  inputs: [
    { id: 'datacenter', label: 'Datacenter', control: 'text', default: 'dc01', hint: 'existing, looked up' },
    { id: 'vds_name', label: 'Switch name', control: 'text', default: 'vds-workload' },
    { id: 'version', label: 'Switch version', control: 'select', options: opts(['9.0.0', '8.0.3', '8.0.0', '7.0.3']), default: '8.0.3' },
    { id: 'hosts', label: 'Hosts', control: 'textarea', default: 'esx01.example.com\nesx02.example.com\nesx03.example.com', hint: 'one per line' },
    { id: 'nics', label: 'Physical NICs per host', control: 'text', default: 'vmnic2, vmnic3', hint: 'same on every host; one uplink each' },
    { id: 'mtu', label: 'MTU', control: 'select', options: opts(['1500', '9000']), default: '9000' },
    { id: 'link_discovery_protocol', label: 'Link discovery', control: 'select', options: opts(['lldp', 'cdp']), default: 'lldp' },
    { id: 'portgroups', label: 'Port groups', control: 'textarea', default: 'pg-web=110\npg-app=120\npg-db=130', hint: 'name=VLAN, one per line' },
    { id: 'teaming_policy', label: 'Teaming', control: 'select', options: opts(['loadbalance_loadbased', 'loadbalance_srcid', 'failover_explicit', 'loadbalance_ip', 'loadbalance_srcmac']), default: 'loadbalance_loadbased' },
    { id: 'binding', label: 'Port binding', control: 'select', options: opts(['earlyBinding', 'ephemeral']), default: 'earlyBinding', section: 'More' },
    { id: 'number_of_ports', label: 'Ports per port group', control: 'number', default: 128, min: 8, section: 'More' },
  ],
  emits: ['vsphere_distributed_virtual_switch', 'vsphere_distributed_port_group'],
  body: (v) => {
    const hosts = items(v.hosts);
    const nics = items(v.nics);
    const uplinks = nics.map((_, i) => `"uplink${i + 1}"`).join(', ');
    return `${datacenterData(v)}

${hostData(hosts)}

resource "vsphere_distributed_virtual_switch" "vds" {
  name          = ${q(v.vds_name)}
  datacenter_id = data.vsphere_datacenter.dc.id
  version       = ${q(v.version)}
  max_mtu       = ${n(v.mtu, 9000)}

  # Named explicitly: the provider's default uplink names are not guaranteed stable.
  uplinks         = [${uplinks}]
  active_uplinks  = [${uplinks}]
  standby_uplinks = []

  link_discovery_protocol  = ${q(v.link_discovery_protocol)}
  link_discovery_operation = "both"
${hosts
  .map(
    (h) => `
  host {
    host_system_id = data.vsphere_host.${ident(h, 'host')}.id
    devices        = ${qlist(nics.join(','))}
  }`,
  )
  .join('\n')}
}

${pairs(v.portgroups)
  .map(
    ([name, vlan]) => `resource "vsphere_distributed_port_group" "${ident(name, 'pg')}" {
  name                            = ${q(name)}
  distributed_virtual_switch_uuid = vsphere_distributed_virtual_switch.vds.id
  vlan_id                         = ${n(vlan, 0)}
  type                            = ${q(v.binding)}
  number_of_ports                 = ${n(v.number_of_ports, 128)}
  auto_expand                     = true
  teaming_policy                  = ${q(v.teaming_policy)}

  allow_promiscuous      = false
  allow_forged_transmits = false
  allow_mac_changes      = false
}`,
  )
  .join('\n\n')}`;
  },
});

const vss = scenario('vsphere', {
  id: 'vsphere_standard_switch',
  label: 'Standard switch, port groups and VMkernel adapter on a host',
  description:
    'On one ESXi host: a standard vSwitch on the NICs given, port groups by VLAN, and an optional VMkernel adapter for vMotion, vSAN, NFS or management with a static address.',
  inputs: [
    { id: 'datacenter', label: 'Datacenter', control: 'text', default: 'dc01' },
    { id: 'host', label: 'ESXi host', control: 'text', default: 'esx01.example.com' },
    { id: 'vswitch_name', label: 'vSwitch name', control: 'text', default: 'vSwitch1' },
    { id: 'nics', label: 'Physical NICs', control: 'text', default: 'vmnic2, vmnic3' },
    { id: 'standby_nics', label: 'Standby NICs', control: 'text', default: '', hint: 'optional, from the list above' },
    { id: 'mtu', label: 'MTU', control: 'select', options: opts(['1500', '9000']), default: '1500' },
    { id: 'portgroups', label: 'Port groups', control: 'textarea', default: 'Backup=140\nDMZ=150', hint: 'name=VLAN, one per line' },
    { id: 'vmk', label: 'Add a VMkernel adapter', control: 'select', options: YES_NO_OPTIONS, default: 'true' },
    { id: 'vmk_portgroup', label: 'VMkernel port group', control: 'text', default: 'vMotion', showWhen: { input: 'vmk', equals: ['true'] } },
    { id: 'vmk_vlan', label: 'VMkernel VLAN', control: 'number', default: 160, showWhen: { input: 'vmk', equals: ['true'] } },
    { id: 'vmk_ip', label: 'VMkernel IP', control: 'text', default: '10.10.160.11', showWhen: { input: 'vmk', equals: ['true'] } },
    { id: 'vmk_netmask', label: 'Netmask', control: 'text', default: '255.255.255.0', showWhen: { input: 'vmk', equals: ['true'] } },
    { id: 'vmk_netstack', label: 'TCP/IP stack', control: 'select', options: opts(['defaultTcpipStack', 'vmotion', 'provisioning']), default: 'vmotion', showWhen: { input: 'vmk', equals: ['true'] } },
    { id: 'vmk_services', label: 'Services', control: 'text', default: 'vmotion', hint: 'vmotion, management, vsan, …', showWhen: { input: 'vmk', equals: ['true'] } },
  ],
  emits: ['vsphere_host_virtual_switch', 'vsphere_host_port_group', 'vsphere_vnic'],
  body: (v) => {
    const nics = items(v.nics);
    const standby = items(v.standby_nics);
    const active = nics.filter((x) => !standby.includes(x));
    const vmk = on(v.vmk);
    return `${datacenterData(v)}

data "vsphere_host" "host" {
  name          = ${q(v.host)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

resource "vsphere_host_virtual_switch" "vswitch" {
  name             = ${q(v.vswitch_name)}
  host_system_id   = data.vsphere_host.host.id
  network_adapters = ${qlist(nics.join(','))}
  active_nics      = ${qlist(active.join(','))}
  standby_nics     = ${qlist(standby.join(','))}
  mtu              = ${n(v.mtu, 1500)}
}

${[...pairs(v.portgroups), ...(vmk ? [[String(v.vmk_portgroup), String(v.vmk_vlan)]                    ] : [])]
  .map(
    ([name, vlan]) => `resource "vsphere_host_port_group" "${ident(name, 'pg')}" {
  name                = ${q(name)}
  host_system_id      = data.vsphere_host.host.id
  virtual_switch_name = vsphere_host_virtual_switch.vswitch.name
  vlan_id             = ${n(vlan, 0)}
}`,
  )
  .join('\n\n')}${vmk ? `

resource "vsphere_vnic" "vmk" {
  host      = data.vsphere_host.host.id
  portgroup = vsphere_host_port_group.${ident(v.vmk_portgroup, 'pg')}.name
  netstack  = ${q(v.vmk_netstack)}
  mtu       = ${n(v.mtu, 1500)}${v.vmk_netstack === 'defaultTcpipStack' ? `
  services  = ${qlist(v.vmk_services)}` : ''}

  ipv4 {
    ip      = ${q(v.vmk_ip)}
    netmask = ${q(v.vmk_netmask)}
  }
}` : ''}`;
  },
});

// --- storage ---------------------------------------------------------------------

const datastores = scenario('vsphere', {
  id: 'vsphere_datastores',
  label: 'Datastores: VMFS or NFS, optionally in a Storage DRS cluster',
  description:
    'A VMFS datastore on a host’s LUNs or an NFS datastore mounted on every host listed, optionally inside a new datastore cluster with Storage DRS set to the automation level chosen.',
  inputs: [
    { id: 'datacenter', label: 'Datacenter', control: 'text', default: 'dc01' },
    { id: 'kind', label: 'Datastore type', control: 'select', options: opts(['nfs', 'vmfs']), default: 'nfs' },
    { id: 'name_prefix', label: 'Datastore name', control: 'text', default: 'nfs-gold-01' },
    { id: 'hosts', label: 'Hosts', control: 'textarea', default: 'esx01.example.com\nesx02.example.com', hint: 'NFS: every host that mounts it; VMFS: the first host formats it' },
    { id: 'nfs_server', label: 'NFS server', control: 'text', default: 'nas01.example.com', showWhen: { input: 'kind', equals: ['nfs'] } },
    { id: 'nfs_path', label: 'Export path', control: 'text', default: '/vol/vmware_gold', showWhen: { input: 'kind', equals: ['nfs'] } },
    { id: 'nfs_version', label: 'NFS version', control: 'select', options: [{ value: 'NFS', label: 'NFS 3' }, { value: 'NFS41', label: 'NFS 4.1' }], default: 'NFS41', showWhen: { input: 'kind', equals: ['nfs'] } },
    { id: 'disks', label: 'LUN device names', control: 'textarea', default: 'naa.600508b1001c3a4b5c6d7e8f90a1b2c3', hint: 'canonical names, one per line', showWhen: { input: 'kind', equals: ['vmfs'] } },
    { id: 'sdrs', label: 'Put it in a new Storage DRS cluster', control: 'select', options: YES_NO_OPTIONS, default: 'false' },
    { id: 'sdrs_name', label: 'Datastore cluster', control: 'text', default: 'dsc-gold', showWhen: { input: 'sdrs', equals: ['true'] } },
    { id: 'sdrs_automation', label: 'Storage DRS automation', control: 'select', options: opts(['manual', 'automated']), default: 'automated', showWhen: { input: 'sdrs', equals: ['true'] } },
    { id: 'sdrs_space_threshold', label: 'Space threshold (%)', control: 'number', default: 80, min: 50, max: 100, showWhen: { input: 'sdrs', equals: ['true'] } },
  ],
  emits: ['vsphere_nas_datastore', 'vsphere_vmfs_datastore', 'vsphere_datastore_cluster'],
  body: (v) => {
    const hosts = items(v.hosts);
    const sdrs = on(v.sdrs);
    const inCluster = sdrs ? `
  datastore_cluster_id = vsphere_datastore_cluster.cluster.id` : '';
    const cluster = sdrs
      ? `

resource "vsphere_datastore_cluster" "cluster" {
  name                         = ${q(v.sdrs_name)}
  datacenter_id                = data.vsphere_datacenter.dc.id
  sdrs_enabled                 = true
  sdrs_automation_level        = ${q(v.sdrs_automation)}
  sdrs_io_load_balance_enabled = true
  sdrs_space_utilization_threshold = ${n(v.sdrs_space_threshold, 80)}
}`
      : '';
    const store =
      v.kind === 'vmfs'
        ? `resource "vsphere_vmfs_datastore" "datastore" {
  name           = ${q(v.name_prefix)}
  host_system_id = data.vsphere_host.${ident(hosts[0] ?? 'host', 'host')}.id
  disks          = ${qlist(items(v.disks).join(','))}${inCluster}
}`
        : `resource "vsphere_nas_datastore" "datastore" {
  name            = ${q(v.name_prefix)}
  host_system_ids = ${hostIds(hosts)}
  type            = ${q(v.nfs_version)}
  remote_hosts    = [${q(v.nfs_server)}]
  remote_path     = ${q(v.nfs_path)}
  access_mode     = "readWrite"${inCluster}
}`;
    return `${datacenterData(v)}

${hostData(v.kind === 'vmfs' ? hosts.slice(0, 1) : hosts)}${cluster}

${store}`;
  },
});

const storagePolicy = scenario('vsphere', {
  id: 'vsphere_storage_policy',
  label: 'Tag-based VM storage policy',
  description:
    'A tag category and tags for datastore tiers, and a VM storage policy that places VMs on datastores carrying the tier’s tag — the vendor-neutral way to express gold/silver/bronze without vSAN rules.',
  inputs: [
    { id: 'category', label: 'Tag category', control: 'text', default: 'StorageTier' },
    { id: 'tiers', label: 'Tiers', control: 'text', default: 'Gold, Silver, Bronze', hint: 'one tag and one policy each' },
  ],
  emits: ['vsphere_tag_category', 'vsphere_tag', 'vsphere_vm_storage_policy'],
  body: (v) => {
    const tiers = items(v.tiers);
    return `resource "vsphere_tag_category" "tier" {
  name             = ${q(v.category)}
  description      = "Datastore tier, for tag-based storage policies"
  cardinality      = "SINGLE"
  associable_types = ["Datastore", "StoragePod"]
}

${tiers
  .map(
    (t) => `resource "vsphere_tag" "${ident(t, 'tier')}" {
  name        = ${q(t)}
  category_id = vsphere_tag_category.tier.id
}

resource "vsphere_vm_storage_policy" "${ident(t, 'tier')}" {
  name        = ${q(`${t} tier`)}
  description = ${q(`Places VMs on datastores tagged ${v.category}=${t}`)}

  tag_rules {
    tag_category                 = vsphere_tag_category.tier.name
    tags                         = [vsphere_tag.${ident(t, 'tier')}.name]
    include_datastores_with_tags = true
  }
}`,
  )
  .join('\n\n')}`;
  },
});

const contentLibrary = scenario('vsphere', {
  id: 'vsphere_content_library',
  label: 'Content library with items (local, published or subscribed)',
  description:
    'A content library on a datastore — local with items imported from URLs and optionally published, or subscribed to another vCenter’s published library.',
  inputs: [
    { id: 'datacenter', label: 'Datacenter', control: 'text', default: 'dc01' },
    { id: 'datastore', label: 'Backing datastore', control: 'text', default: 'vsanDatastore' },
    { id: 'library_name', label: 'Library name', control: 'text', default: 'templates' },
    { id: 'mode', label: 'Kind', control: 'select', options: opts(['local', 'subscribed']), default: 'local' },
    { id: 'items', label: 'Items', control: 'textarea', default: 'ubuntu-24.04=https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.ova', hint: 'name=URL of an OVF/OVA/ISO, one per line', showWhen: { input: 'mode', equals: ['local'] } },
    { id: 'publish', label: 'Publish it', control: 'select', options: YES_NO_OPTIONS, default: 'false', showWhen: { input: 'mode', equals: ['local'] } },
    { id: 'subscription_url', label: 'Published library URL', control: 'text', default: 'https://vcenter-a.example.com:443/cls/vcsp/lib/0000/lib.json', showWhen: { input: 'mode', equals: ['subscribed'] } },
    { id: 'on_demand', label: 'Download on demand', control: 'select', options: YES_NO_OPTIONS, default: 'true', showWhen: { input: 'mode', equals: ['subscribed'] } },
  ],
  emits: ['vsphere_content_library', 'vsphere_content_library_item'],
  body: (v) => {
    const local = v.mode !== 'subscribed';
    return `${datacenterData(v)}

data "vsphere_datastore" "datastore" {
  name          = ${q(v.datastore)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

resource "vsphere_content_library" "library" {
  name            = ${q(v.library_name)}
  storage_backing = [data.vsphere_datastore.datastore.id]${local && on(v.publish) ? `

  publication {
    published             = true
    authentication_method = "NONE"
  }` : ''}${!local ? `

  subscription {
    subscription_url      = ${q(v.subscription_url)}
    automatic_sync        = true
    on_demand             = ${on(v.on_demand)}
    authentication_method = "NONE"
  }` : ''}
}${local ? pairs(v.items)
      .map(
        ([name, url]) => `

resource "vsphere_content_library_item" "${ident(name, 'item')}" {
  name       = ${q(name)}
  library_id = vsphere_content_library.library.id
  file_url   = ${q(url)}
  type       = ${/\.iso$/i.test(url) ? '"iso"' : '"ovf"'}
}`,
      )
      .join('') : ''}`;
  },
});

// --- inventory, tagging and access ---------------------------------------------------

const folderTags = scenario('vsphere', {
  id: 'vsphere_tagged_foldered_vm',
  label: 'Folders, tag categories and tags',
  description:
    'The inventory structure a vCenter is organised by: folders (VM, host, datastore or network), a tag category with the object types it may tag, and its tags. Tag an existing VM by importing it (see the comment at the end) rather than recreating it.',
  inputs: [
    { id: 'datacenter', label: 'Datacenter', control: 'text', default: 'dc01' },
    { id: 'folder_type', label: 'Folder type', control: 'select', options: opts(['vm', 'host', 'datastore', 'network']), default: 'vm' },
    { id: 'folders', label: 'Folders', control: 'textarea', default: 'Prod\nProd/Restricted\nNonProd', hint: 'paths, parents before children, one per line' },
    { id: 'tag_category_name', label: 'Tag category', control: 'text', default: 'DataClassification' },
    { id: 'cardinality', label: 'Tags per object', control: 'select', options: [{ value: 'SINGLE', label: 'One (SINGLE)' }, { value: 'MULTIPLE', label: 'Several (MULTIPLE)' }], default: 'SINGLE' },
    {
      id: 'associable_types',
      label: 'May tag',
      control: 'checklist',
      options: opts(['VirtualMachine', 'Folder', 'ClusterComputeResource', 'HostSystem', 'Datastore', 'StoragePod', 'DistributedVirtualPortgroup', 'Network', 'ResourcePool', 'VirtualApp', 'Datacenter', 'Library']),
      default: 'VirtualMachine,Folder',
    },
    { id: 'tags', label: 'Tags', control: 'text', default: 'Public, Internal, Restricted', hint: 'comma-separated' },
  ],
  emits: ['vsphere_folder', 'vsphere_tag_category', 'vsphere_tag'],
  body: (v) => {
    const folders = items(v.folders);
    const byPath = new Map(folders.map((f) => [f, `folder_${ident(f.replace(/\//g, '_'), 'f')}`]));
    return `${datacenterData(v)}

${folders
  .map((f) => {
    const parent = f.includes('/') ? byPath.get(f.slice(0, f.lastIndexOf('/'))) : undefined;
    return `resource "vsphere_folder" "${byPath.get(f)}" {
  path          = ${parent ? `"\${vsphere_folder.${parent}.path}/${f.slice(f.lastIndexOf('/') + 1)}"` : q(f)}
  type          = ${q(v.folder_type)}
  datacenter_id = data.vsphere_datacenter.dc.id
}`;
  })
  .join('\n\n')}

resource "vsphere_tag_category" "category" {
  name             = ${q(v.tag_category_name)}
  description      = "Managed by Terraform"
  cardinality      = ${q(v.cardinality)}
  associable_types = ${qlist(v.associable_types)}
}

${items(v.tags)
  .map(
    (t) => `resource "vsphere_tag" "${ident(t, 'tag')}" {
  name        = ${q(t)}
  category_id = vsphere_tag_category.category.id
}`,
  )
  .join('\n\n')}

# To tag a VM that already exists, bring it under Terraform rather than
# recreating it: declare it with an import block, run \`terraform plan
# -generate-config-out=vm.tf\`, then add the tag IDs to its \`tags\`.
#
# import {
#   to = vsphere_virtual_machine.existing
#   id = "/${String(v.datacenter)}/vm/<folder>/<vm-name>"
# }`;
  },
});

const roles = scenario('vsphere', {
  id: 'vsphere_roles_permissions',
  label: 'Custom role and permissions',
  description:
    'A vCenter role with exactly the privileges listed, granted to a user or group on a datacenter, cluster or folder, propagating down or not.',
  inputs: [
    { id: 'role_name', label: 'Role name', control: 'text', default: 'Terraform-VM-Provisioner' },
    {
      id: 'privileges',
      label: 'Privileges',
      control: 'textarea',
      default:
        'VirtualMachine.Inventory.Create\nVirtualMachine.Inventory.Delete\nVirtualMachine.Provisioning.Clone\nVirtualMachine.Provisioning.Customize\nVirtualMachine.Provisioning.DeployTemplate\nVirtualMachine.Config.AddNewDisk\nVirtualMachine.Config.CPUCount\nVirtualMachine.Config.Memory\nVirtualMachine.Config.EditDevice\nVirtualMachine.Interact.PowerOn\nVirtualMachine.Interact.PowerOff\nResource.AssignVMToPool\nDatastore.AllocateSpace\nNetwork.Assign\nInventoryService.Tagging.AttachTag',
      hint: 'vCenter privilege IDs, one per line',
    },
    { id: 'datacenter', label: 'Datacenter', control: 'text', default: 'dc01' },
    { id: 'entity_kind', label: 'Grant on', control: 'select', options: opts(['Datacenter', 'ClusterComputeResource', 'Folder']), default: 'Folder' },
    { id: 'entity_name', label: 'Cluster or folder', control: 'text', default: 'Prod', hint: 'cluster name, or VM folder path', showWhen: { input: 'entity_kind', notEquals: ['Datacenter'] } },
    { id: 'principal', label: 'User or group', control: 'text', default: 'EXAMPLE.COM\\vmware-provisioners' },
    { id: 'is_group', label: 'It is a group', control: 'select', options: YES_NO_OPTIONS, default: 'true' },
    { id: 'propagate', label: 'Propagate to children', control: 'select', options: YES_NO_OPTIONS, default: 'true' },
  ],
  emits: ['vsphere_role', 'vsphere_entity_permissions'],
  body: (v) => {
    const kind = String(v.entity_kind);
    const lookup =
      kind === 'ClusterComputeResource'
        ? `data "vsphere_compute_cluster" "target" {
  name          = ${q(v.entity_name)}
  datacenter_id = data.vsphere_datacenter.dc.id
}`
        : kind === 'Folder'
          ? `data "vsphere_folder" "target" {
  path = "/${String(v.datacenter)}/vm/${String(v.entity_name)}"
}`
          : '';
    const entity = kind === 'ClusterComputeResource' ? 'data.vsphere_compute_cluster.target.id' : kind === 'Folder' ? 'data.vsphere_folder.target.id' : 'data.vsphere_datacenter.dc.id';
    return `${datacenterData(v)}${lookup ? `\n\n${lookup}` : ''}

resource "vsphere_role" "role" {
  name            = ${q(v.role_name)}
  role_privileges = ${qlist(items(v.privileges).join(','))}
}

resource "vsphere_entity_permissions" "grant" {
  entity_id   = ${entity}
  entity_type = ${q(kind)}

  permissions {
    user_or_group = ${JSON.stringify(String(v.principal))}
    propagate     = ${on(v.propagate)}
    is_group      = ${on(v.is_group)}
    role_id       = vsphere_role.role.id
  }
}`;
  },
});

const pools = scenario('vsphere', {
  id: 'vsphere_resource_pools',
  label: 'Resource pools with shares, reservations and limits',
  description:
    'Resource pools under a cluster’s root pool, one per line with its share level and optional CPU and memory reservations — the usual prod/non-prod split, sized so contention favours the pool that should win.',
  inputs: [
    ...WHERE,
    { id: 'pools', label: 'Pools', control: 'textarea', default: 'Prod=high:8000:32768\nNonProd=normal:0:0\nSandbox=low:0:0', hint: 'name=shareLevel:cpuReservationMHz:memReservationMB' },
    { id: 'expandable', label: 'Expandable reservations', control: 'select', options: YES_NO_OPTIONS, default: 'true' },
  ],
  emits: ['vsphere_resource_pool'],
  body: (v) => `${datacenterData(v)}

${clusterData(v)}

${pairs(v.pools)
  .map(([name, spec]) => {
    const [level = 'normal', cpu = '0', mem = '0'] = spec.split(':');
    return `resource "vsphere_resource_pool" "${ident(name, 'pool')}" {
  name                    = ${q(name)}
  parent_resource_pool_id = data.vsphere_compute_cluster.cluster.resource_pool_id
  cpu_share_level         = ${q(level)}
  cpu_reservation         = ${n(cpu, 0)}
  cpu_expandable          = ${on(v.expandable)}
  memory_share_level      = ${q(level)}
  memory_reservation      = ${n(mem, 0)}
  memory_expandable       = ${on(v.expandable)}
}`;
  })
  .join('\n\n')}`,
});

// --- workload management ------------------------------------------------------------

const supervisor = scenario('vsphere', {
  id: 'vsphere_supervisor',
  label: 'Supervisor (vSphere with Tanzu on NSX) + namespace + VM classes',
  description:
    'Enables a Supervisor on a cluster using NSX networking — management network range, pod/service/ingress/egress CIDRs, DNS and NTP — with VM classes and a first vSphere Namespace given the storage policy, classes and content library.',
  inputs: [
    ...WHERE,
    { id: 'dvs', label: 'Distributed switch', control: 'text', default: 'vds-workload' },
    { id: 'mgmt_network', label: 'Management port group', control: 'text', default: 'pg-mgmt' },
    { id: 'mgmt_start', label: 'Management range start', control: 'text', default: '10.10.10.50' },
    { id: 'mgmt_count', label: 'Addresses (5 needed)', control: 'number', default: 5, min: 5 },
    { id: 'mgmt_gateway', label: 'Management gateway', control: 'text', default: '10.10.10.1' },
    { id: 'mgmt_mask', label: 'Management netmask', control: 'text', default: '255.255.255.0' },
    { id: 'edge_cluster', label: 'NSX edge cluster ID', control: 'text', default: '00000000-0000-0000-0000-000000000000', hint: 'the edge cluster’s NSX UUID' },
    { id: 'storage_policy', label: 'Storage policy', control: 'text', default: 'vSAN Default Storage Policy' },
    { id: 'content_library', label: 'Subscribed content library', control: 'text', default: 'tkg-content' },
    { id: 'sizing_hint', label: 'Control plane size', control: 'select', options: opts(['TINY', 'SMALL', 'MEDIUM', 'LARGE']), default: 'SMALL' },
    { id: 'dns', label: 'DNS servers', control: 'text', default: '10.10.0.10' },
    { id: 'ntp', label: 'NTP servers', control: 'text', default: 'ntp1.example.com' },
    { id: 'search_domains', label: 'Search domains', control: 'text', default: 'example.com' },
    { id: 'pod_cidr', label: 'Pod CIDR', control: 'text', default: '10.244.0.0/20', section: 'CIDRs' },
    { id: 'service_cidr', label: 'Service CIDR', control: 'text', default: '10.96.0.0/23', section: 'CIDRs' },
    { id: 'ingress_cidr', label: 'Ingress CIDR', control: 'text', default: '192.168.100.0/24', section: 'CIDRs' },
    { id: 'egress_cidr', label: 'Egress CIDR', control: 'text', default: '192.168.101.0/24', section: 'CIDRs' },
    { id: 'namespace', label: 'First namespace', control: 'text', default: 'team-a' },
    { id: 'vm_classes', label: 'VM classes', control: 'textarea', default: 'best-effort-small=2:4096\nbest-effort-medium=2:8192\nguaranteed-large=4:16384', hint: 'name=cpus:memoryMB' },
  ],
  emits: ['vsphere_supervisor', 'vsphere_virtual_machine_class'],
  body: (v) => {
    const cidr = (value         )         => {
      const [address = '0.0.0.0', prefix = '24'] = String(value ?? '').split('/');
      return `    address = ${q(address)}\n    prefix  = ${n(prefix, 24)}`;
    };
    const classes = pairs(v.vm_classes);
    return `${datacenterData(v)}

${clusterData(v)}

data "vsphere_distributed_virtual_switch" "dvs" {
  name          = ${q(v.dvs)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_network" "mgmt" {
  name          = ${q(v.mgmt_network)}
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_content_library" "tkg" {
  name = ${q(v.content_library)}
}

data "vsphere_storage_policy" "policy" {
  name = ${q(v.storage_policy)}
}

${classes
  .map(([name, spec]) => {
    const [cpus = '2', mem = '4096'] = spec.split(':');
    return `resource "vsphere_virtual_machine_class" "${ident(name, 'class')}" {
  name   = ${q(name)}
  cpus   = ${n(cpus, 2)}
  memory = ${n(mem, 4096)}${/guaranteed/.test(name) ? `
  cpu_reservation    = 100
  memory_reservation = 100` : ''}
}`;
  })
  .join('\n\n')}

resource "vsphere_supervisor" "supervisor" {
  cluster         = data.vsphere_compute_cluster.cluster.id
  storage_policy  = data.vsphere_storage_policy.policy.id
  content_library = data.vsphere_content_library.tkg.id
  dvs_uuid        = data.vsphere_distributed_virtual_switch.dvs.id
  edge_cluster    = ${q(v.edge_cluster)}
  sizing_hint     = ${q(v.sizing_hint)}
  main_dns        = ${qlist(v.dns)}
  worker_dns      = ${qlist(v.dns)}
  main_ntp        = ${qlist(v.ntp)}
  worker_ntp      = ${qlist(v.ntp)}
  search_domains  = ${qlist(v.search_domains)}

  management_network {
    network          = data.vsphere_network.mgmt.id
    starting_address = ${q(v.mgmt_start)}
    address_count    = ${n(v.mgmt_count, 5)}
    gateway          = ${q(v.mgmt_gateway)}
    subnet_mask      = ${q(v.mgmt_mask)}
  }

  pod_cidr {
${cidr(v.pod_cidr)}
  }

  service_cidr {
${cidr(v.service_cidr)}
  }

  ingress_cidr {
${cidr(v.ingress_cidr)}
  }

  egress_cidr {
${cidr(v.egress_cidr)}
  }

  namespace {
    name              = ${q(v.namespace)}
    content_libraries = [data.vsphere_content_library.tkg.id]
    vm_classes        = [${classes.map(([name]) => `vsphere_virtual_machine_class.${ident(name, 'class')}.id`).join(', ')}]
  }
}`;
  },
});

const SCENARIOS                       = [
  vmFromTemplate,
  vmFromLibrary,
  vmFromOvf,
  vmFromIso,
  cluster,
  addHosts,
  drsRules,
  pools,
  vds,
  vss,
  datastores,
  storagePolicy,
  contentLibrary,
  folderTags,
  roles,
  supervisor,
];

export const VMWARE_TERRAFORM                 = {
  target: 'vsphere',
  label: 'VMware vSphere / vCenter',
  blueprints: [...SCENARIOS, ...providerBlueprints('vsphere')],
};
