/**
 * Hand-written VCF Automation (formerly Aria Automation / vRA) scenario
 * blueprints: several resources built together (vmware/vra 0.17).
 *
 *   vSphere onboarding       cloud account (+ NSX) → cloud zones → project
 *   flavors and images       flavor and image profiles for a region
 *   storage and networks     storage profile, network profile, IP ranges
 *   cloud template           a template, a released version, the catalog
 *   deployment               a catalog item or template requested with inputs
 *   governance               lease, approval and day-2 action policies
 *   public cloud account     AWS, Azure or Google Cloud with a zone per region
 *
 * These drive the IaaS (Assembler) APIs of VCF Automation 8.x and of the
 * provider-consumption "VM Apps" organizations of 9.x; 9.x all-apps
 * organizations (Supervisor namespaces) are not modelled by this provider.
 */

import type { Blueprint, TemplateValues } from '../../kit/blueprint.ts';
import { warning, type Finding } from '../../core/findings.ts';
import { scenario, q, items, pairs, ident, on, n } from './scenario-common.ts';

function variable(name: string, description: string): string {
  return `variable "${name}" {
  description = ${q(description)}
  type        = string
  sensitive   = true
}`;
}

/** `lines of "a b c"` as word lists, blank lines dropped. */
function rows(value: unknown): string[][] {
  return String(value ?? '')
    .split('\n')
    .map((l) => l.trim().split(/[\s,]+/).filter(Boolean))
    .filter((r) => r.length > 0);
}

/** One role block per principal; "group:" marks a group, anything else a user. */
function roleBlocks(block: string, value: unknown): string {
  return items(value)
    .map((p) => {
      const group = /^group:/i.test(p);
      const email = p.replace(/^(group|user):/i, '');
      return `  ${block} {
    email = ${q(email)}
    type  = "${group ? 'group' : 'user'}"
  }`;
    })
    .join('\n\n');
}

/** The existing vSphere cloud account and one of its regions (datacenters). */
function vsphereRegion(v: TemplateValues): string {
  return `data "vra_cloud_account_vsphere" "this" {
  name = ${q(v.account_name)}
}

data "vra_region" "this" {
  cloud_account_id = data.vra_cloud_account_vsphere.this.id
  region           = ${q(v.region_external_id)}
}`;
}

const REGION_INPUTS = [
  { id: 'account_name', label: 'vSphere cloud account', control: 'text' as const, default: 'vcenter-wld01', hint: 'Existing cloud account name' },
  { id: 'region_external_id', label: 'Region (datacenter) ID', control: 'text' as const, default: 'Datacenter:datacenter-3', hint: 'Datacenter:<moref>' },
];

export const VRA_SCENARIOS: readonly Blueprint[] = [
  scenario('vra', {
    id: 'vra_vsphere_onboarding',
    label: 'vSphere cloud account → cloud zones → project',
    description: 'Onboards a vCenter: a vSphere cloud account with its datacenters enabled as regions (optionally associated with an NSX cloud account), one cloud zone per region, and a project that can deploy into those zones with its administrators and members. The vCenter and NSX passwords are sensitive variables.',
    inputs: [
      { id: 'account_name', label: 'Cloud account name', control: 'text', default: 'vcenter-wld01' },
      { id: 'vcenter_host', label: 'vCenter', control: 'text', default: 'vcenter-wld01.example.com' },
      { id: 'vcenter_user', label: 'vCenter user', control: 'text', default: 'svc-vcfa@vsphere.local' },
      { id: 'regions', label: 'Datacenters', control: 'textarea', default: 'Datacenter:datacenter-3 wld01-dc01', hint: 'One per line: external-ID name (Datacenter:<moref> as vCenter shows it)' },
      { id: 'accept_self_signed', label: 'Accept self-signed certificate', control: 'toggle', default: false },
      { id: 'with_nsx', label: 'Associate an NSX cloud account', control: 'toggle', default: true },
      { id: 'nsx_account_name', label: 'NSX cloud account name', control: 'text', default: 'nsx-wld01', showWhen: { input: 'with_nsx', equals: ['true'] } },
      { id: 'nsx_host', label: 'NSX Manager', control: 'text', default: 'nsx-wld01.example.com', showWhen: { input: 'with_nsx', equals: ['true'] } },
      { id: 'nsx_user', label: 'NSX user', control: 'text', default: 'admin', showWhen: { input: 'with_nsx', equals: ['true'] } },
      { id: 'zone_placement', label: 'Zone placement policy', control: 'select', options: [
        { value: 'DEFAULT', label: 'Default' },
        { value: 'BINPACK', label: 'Binpack (fill hosts)' },
        { value: 'SPREAD', label: 'Spread (by VM count)' },
        { value: 'SPREAD_MEMORY', label: 'Spread (by memory)' },
      ], default: 'DEFAULT', section: 'Cloud zones' },
      { id: 'zone_folder', label: 'VM folder', control: 'text', default: 'vcfa-workloads', hint: 'Relative to the datacenter; blank for none', section: 'Cloud zones' },
      { id: 'project_name', label: 'Project', control: 'text', default: 'app-team-a' },
      { id: 'administrators', label: 'Project administrators', control: 'textarea', default: 'jane.doe@example.com\ngroup:vcfa-admins@example.com', hint: 'One per line; prefix a group with group:' },
      { id: 'members', label: 'Project members', control: 'textarea', default: 'group:app-team-a@example.com', hint: 'One per line; prefix a group with group:' },
      { id: 'naming_template', label: 'Machine naming template', control: 'text', default: '${project.name}-${###}', section: 'Project' },
      { id: 'project_placement', label: 'Project placement policy', control: 'select', options: [{ value: 'DEFAULT', label: 'Default (priority)' }, { value: 'SPREAD', label: 'Spread across zones' }], default: 'DEFAULT', section: 'Project' },
      { id: 'max_instances', label: 'Max machines per zone', control: 'number', default: 50, min: 0, hint: '0 = unlimited', section: 'Project' },
      { id: 'cpu_limit', label: 'vCPU limit per zone', control: 'number', default: 200, min: 0, hint: '0 = unlimited', section: 'Project' },
      { id: 'memory_limit_mb', label: 'Memory limit per zone (MB)', control: 'number', default: 819200, min: 0, hint: '0 = unlimited', section: 'Project' },
    ],
    emits: ['vra_cloud_account_nsxt', 'vra_cloud_account_vsphere', 'vra_zone', 'vra_project'],
    body: (v) => {
      const nsx = on(v.with_nsx);
      const regions = rows(v.regions).map(([id, name]) => ({ id: id as string, name: name ?? id as string, ref: ident(name ?? id) }));
      const findings: Finding[] = [];
      if (regions.length === 0) findings.push(warning('vra.onboarding.regions', 'Enable at least one datacenter, or the cloud account has no regions to build a zone in.', { path: 'regions' }));
      const folder = String(v.zone_folder ?? '').trim();
      const nsxHcl = nsx
        ? `${variable('nsx_password', 'Password of the NSX Manager user')}

resource "vra_cloud_account_nsxt" "this" {
  name                    = ${q(v.nsx_account_name)}
  hostname                = ${q(v.nsx_host)}
  username                = ${q(v.nsx_user)}
  password                = var.nsx_password
  accept_self_signed_cert = ${on(v.accept_self_signed)}
}

`
        : '';
      const zones = regions
        .map(
          (r) => `data "vra_region" "${r.ref}" {
  cloud_account_id = vra_cloud_account_vsphere.this.id
  region           = ${q(r.id)}
}

resource "vra_zone" "${r.ref}" {
  name             = ${q(`${v.account_name}-${r.name}`)}
  region_id        = data.vra_region.${r.ref}.id
  placement_policy = ${q(v.zone_placement)}${folder ? `\n  folder           = ${q(folder)}` : ''}

  tags {
    key   = "zone"
    value = ${q(r.name)}
  }
}`,
        )
        .join('\n\n');
      const assignments = regions
        .map(
          (r, i) => `  zone_assignments {
    zone_id         = vra_zone.${r.ref}.id
    priority        = ${i}
    max_instances   = ${n(v.max_instances, 0)}
    cpu_limit       = ${n(v.cpu_limit, 0)}
    memory_limit_mb = ${n(v.memory_limit_mb, 0)}
  }`,
        )
        .join('\n\n');
      return {
        findings,
        hcl: `${variable('vcenter_password', 'Password of the vCenter service account')}

${nsxHcl}resource "vra_cloud_account_vsphere" "this" {
  name                         = ${q(v.account_name)}
  hostname                     = ${q(v.vcenter_host)}
  username                     = ${q(v.vcenter_user)}
  password                     = var.vcenter_password
  accept_self_signed_cert      = ${on(v.accept_self_signed)}${nsx ? '\n  associated_cloud_account_ids = [vra_cloud_account_nsxt.this.id]' : ''}
${regions.map((r) => `
  enabled_regions {
    external_region_id = ${q(r.id)}
    name               = ${q(r.name)}
  }`).join('\n')}
}

${zones}

resource "vra_project" "this" {
  name                    = ${q(v.project_name)}
  machine_naming_template = ${q(v.naming_template)}
  placement_policy        = ${q(v.project_placement)}

${assignments}

${roleBlocks('administrator_roles', v.administrators)}

${roleBlocks('member_roles', v.members)}
}

output "project_id" {
  value = vra_project.this.id
}`,
      };
    },
  }),

  scenario('vra', {
    id: 'vra_flavor_image_profiles',
    label: 'Flavor and image profiles for a region',
    description: 'T-shirt sizes (flavor mappings) and image mappings for one vSphere region, so cloud templates can ask for "small" and "ubuntu-22.04" instead of CPU counts and template names. Templates are looked up by name in that region.',
    inputs: [
      ...REGION_INPUTS,
      { id: 'profile_name', label: 'Profile name', control: 'text', default: 'wld01-dc01' },
      { id: 'flavors', label: 'Flavors', control: 'textarea', default: 'small=2:4096\nmedium=4:8192\nlarge=8:16384', hint: 'One per line: name=vCPU:memoryMB' },
      { id: 'images', label: 'Images', control: 'textarea', default: 'ubuntu-22.04=tpl-ubuntu-2204\nrhel-9=tpl-rhel-9\nwindows-2022=tpl-win2022', hint: 'One per line: name=vSphere template or content-library item' },
    ],
    emits: ['vra_flavor_profile', 'vra_image_profile'],
    body: (v) => {
      const flavors = pairs(v.flavors)
        .map(([name, spec]) => {
          const [cpu, mem] = spec.split(/[:x/]/).map((s) => s.trim());
          return `  flavor_mapping {
    name      = ${q(name)}
    cpu_count = ${n(cpu, 2)}
    memory    = ${n(mem, 4096)}
  }`;
        })
        .join('\n\n');
      const images = pairs(v.images).map(([name, template]) => ({ name, template, ref: ident(name) }));
      const lookups = images
        .map(
          (i) => `data "vra_image" "${i.ref}" {
  filter = ${q(`name eq '${i.template}' and externalRegionId eq '${v.region_external_id}'`)}
}`,
        )
        .join('\n\n');
      const mappings = images
        .map(
          (i) => `  image_mapping {
    name     = ${q(i.name)}
    image_id = data.vra_image.${i.ref}.id
  }`,
        )
        .join('\n\n');
      return `${vsphereRegion(v)}

${lookups}

resource "vra_flavor_profile" "this" {
  name        = ${q(v.profile_name)}
  description = ${q(`Flavors for ${v.profile_name}`)}
  region_id   = data.vra_region.this.id

${flavors}
}

resource "vra_image_profile" "this" {
  name        = ${q(v.profile_name)}
  description = ${q(`Images for ${v.profile_name}`)}
  region_id   = data.vra_region.this.id

${mappings}
}`;
    },
  }),

  scenario('vra', {
    id: 'vra_storage_network_profiles',
    label: 'Storage and network profiles with IP ranges',
    description: 'A vSphere storage profile on a datastore (with an optional storage policy) and a network profile over existing port groups, each with a static IP range VCF Automation assigns from. The fabric networks must already have their CIDR and gateway set (in the UI, or with an imported vra_fabric_network_vsphere).',
    inputs: [
      ...REGION_INPUTS,
      { id: 'storage_profile_name', label: 'Storage profile name', control: 'text', default: 'wld01-vsan-gold' },
      { id: 'datastore', label: 'Datastore', control: 'text', default: 'wld01-cl01-ds-vsan01' },
      { id: 'storage_policy', label: 'vSphere storage policy', control: 'text', default: 'vSAN Default Storage Policy', hint: 'Blank for the datastore default' },
      { id: 'provisioning_type', label: 'Disk provisioning', control: 'select', options: [
        { value: 'thin', label: 'Thin' },
        { value: 'thick', label: 'Thick (lazy zeroed)' },
        { value: 'eagerZeroedThick', label: 'Thick (eager zeroed)' },
      ], default: 'thin' },
      { id: 'storage_tier', label: 'Storage tag (tier)', control: 'text', default: 'gold', hint: 'Tag tier:<value> for template constraints' },
      { id: 'default_storage', label: 'Default storage profile', control: 'toggle', default: true },
      { id: 'network_profile_name', label: 'Network profile name', control: 'text', default: 'wld01-app-networks' },
      { id: 'networks', label: 'Networks and IP ranges', control: 'textarea', default: 'wld01-app-pg 10.20.30.100 10.20.30.199\nwld01-db-pg 10.20.40.100 10.20.40.199', hint: 'One per line: port-group start-IP end-IP (IPv4 or IPv6)' },
      { id: 'network_tag', label: 'Network tag', control: 'text', default: 'net:app', hint: 'key:value, for template constraints' },
    ],
    emits: ['vra_storage_profile_vsphere', 'vra_network_profile', 'vra_network_ip_range'],
    body: (v) => {
      const policy = String(v.storage_policy ?? '').trim();
      const nets = rows(v.networks).map(([pg, start, end]) => ({ pg: pg as string, start: start ?? '', end: end ?? start ?? '', ref: ident(pg) }));
      const [tagKey, tagValue] = String(v.network_tag ?? 'net:app').split(':');
      const lookups = nets
        .map(
          (x) => `data "vra_fabric_network" "${x.ref}" {
  filter = ${q(`name eq '${x.pg}' and externalRegionId eq '${v.region_external_id}'`)}
}`,
        )
        .join('\n\n');
      const ranges = nets
        .filter((x) => x.start)
        .map(
          (x) => `resource "vra_network_ip_range" "${x.ref}" {
  name               = ${q(`${x.pg}-range`)}
  fabric_network_ids = [data.vra_fabric_network.${x.ref}.id]
  ip_version         = "${x.start.includes(':') ? 'IPv6' : 'IPv4'}"
  start_ip_address   = ${q(x.start)}
  end_ip_address     = ${q(x.end)}
}`,
        )
        .join('\n\n');
      return `${vsphereRegion(v)}

data "vra_fabric_datastore_vsphere" "this" {
  filter = ${q(`name eq '${v.datastore}' and externalRegionId eq '${v.region_external_id}'`)}
}
${policy ? `
data "vra_fabric_storage_policy_vsphere" "this" {
  filter = ${q(`name eq '${policy}' and externalRegionId eq '${v.region_external_id}'`)}
}
` : ''}
${lookups}

resource "vra_storage_profile_vsphere" "this" {
  name              = ${q(v.storage_profile_name)}
  region_id         = data.vra_region.this.id
  datastore_id      = data.vra_fabric_datastore_vsphere.this.id${policy ? '\n  storage_policy_id = data.vra_fabric_storage_policy_vsphere.this.id' : ''}
  provisioning_type = ${q(v.provisioning_type)}
  default_item      = ${on(v.default_storage)}

  tags {
    key   = "tier"
    value = ${q(v.storage_tier)}
  }
}

resource "vra_network_profile" "this" {
  name               = ${q(v.network_profile_name)}
  region_id          = data.vra_region.this.id
  isolation_type     = "NONE"
  fabric_network_ids = [${nets.map((x) => `data.vra_fabric_network.${x.ref}.id`).join(', ')}]

  tags {
    key   = ${q(tagKey)}
    value = ${q(tagValue ?? '')}
  }
}

${ranges}`;
    },
  }),

  scenario('vra', {
    id: 'vra_cloud_template_catalog',
    label: 'Cloud template → version → catalog',
    description: 'A vSphere cloud template (one machine on a tagged existing network, with size, image and disk inputs), a released version of it, and the project’s templates published to the Service Broker catalog and shared with the project’s members.',
    inputs: [
      { id: 'project_name', label: 'Project', control: 'text', default: 'app-team-a', hint: 'Existing project' },
      { id: 'template_name', label: 'Template name', control: 'text', default: 'linux-vm' },
      { id: 'template_description', label: 'Description', control: 'text', default: 'Single Linux VM on the application network' },
      { id: 'images', label: 'Images offered', control: 'text', default: 'ubuntu-22.04, rhel-9', hint: 'Image mapping names, comma separated' },
      { id: 'flavors', label: 'Sizes offered', control: 'text', default: 'small, medium, large', hint: 'Flavor mapping names, comma separated' },
      { id: 'network_tag', label: 'Network constraint', control: 'text', default: 'net:app', hint: 'Tag on the network profile' },
      { id: 'storage_tag', label: 'Storage constraint', control: 'text', default: 'tier:gold', hint: 'Tag on the storage profile' },
      { id: 'version', label: 'Version', control: 'text', default: '1.0.0' },
      { id: 'release', label: 'Release the version', control: 'toggle', default: true, hint: 'Only released versions reach the catalog' },
      { id: 'org_scope', label: 'Requestable from any project', control: 'toggle', default: false },
      { id: 'publish', label: 'Publish to the catalog', control: 'toggle', default: true },
    ],
    emits: ['vra_blueprint', 'vra_blueprint_version', 'vra_catalog_source_blueprint', 'vra_content_sharing_policy'],
    body: (v) => {
      const images = items(v.images);
      const flavors = items(v.flavors);
      const yamlList = (xs: string[]): string => xs.map((x) => `\n      - ${x}`).join('');
      // A heredoc, so ${...} for VCF Automation is written $${...}.
      const content = `formatVersion: 1
inputs:
  hostname:
    type: string
    title: Host name
    maxLength: 15
  image:
    type: string
    title: Image
    default: ${images[0] ?? 'ubuntu-22.04'}
    enum:${yamlList(images)}
  size:
    type: string
    title: Size
    default: ${flavors[0] ?? 'small'}
    enum:${yamlList(flavors)}
  dataDiskGb:
    type: integer
    title: Data disk (GB)
    default: 50
    minimum: 10
    maximum: 2048
resources:
  vm:
    type: Cloud.vSphere.Machine
    properties:
      name: $\${input.hostname}
      image: $\${input.image}
      flavor: $\${input.size}
      constraints:
        - tag: ${v.storage_tag}
      attachedDisks:
        - source: $\${resource.data.id}
      networks:
        - network: $\${resource.net.id}
          assignment: static
  data:
    type: Cloud.vSphere.Disk
    properties:
      capacityGb: $\${input.dataDiskGb}
      constraints:
        - tag: ${v.storage_tag}
  net:
    type: Cloud.vSphere.Network
    properties:
      networkType: existing
      constraints:
        - tag: ${v.network_tag}`;
      const publish = on(v.publish)
        ? `

resource "vra_catalog_source_blueprint" "this" {
  name       = ${q(`${v.project_name} templates`)}
  project_id = data.vra_project.this.id

  depends_on = [vra_blueprint_version.this]
}

resource "vra_content_sharing_policy" "this" {
  name               = ${q(`${v.project_name} templates`)}
  project_id         = data.vra_project.this.id
  catalog_source_ids = [vra_catalog_source_blueprint.this.id]
  entitlement_type   = "USER"

  principals {
    type         = "PROJECT"
    reference_id = ""
  }
}`
        : '';
      const findings: Finding[] = [];
      if (on(v.publish) && !on(v.release)) findings.push(warning('vra.template.unreleased', 'An unreleased version does not appear in the catalog.', { path: 'release' }));
      return {
        findings,
        hcl: `data "vra_project" "this" {
  name = ${q(v.project_name)}
}

resource "vra_blueprint" "this" {
  name              = ${q(v.template_name)}
  description       = ${q(v.template_description)}
  project_id        = data.vra_project.this.id
  request_scope_org = ${on(v.org_scope)}

  content = <<-EOT
${content.split('\n').map((l) => (l ? `    ${l}` : '')).join('\n')}
  EOT
}

resource "vra_blueprint_version" "this" {
  blueprint_id = vra_blueprint.this.id
  version      = ${q(v.version)}
  description  = ${q(`${v.template_name} ${v.version}`)}
  change_log   = "Managed by Terraform"
  release      = ${on(v.release)}
}${publish}`,
      };
    },
  }),

  scenario('vra', {
    id: 'vra_deployment',
    label: 'Deployment from a catalog item or template',
    description: 'Requests a deployment in a project, from a catalog item or straight from a cloud template version, with its inputs given as name=value pairs.',
    inputs: [
      { id: 'project_name', label: 'Project', control: 'text', default: 'app-team-a', hint: 'Existing project' },
      { id: 'deployment_name', label: 'Deployment name', control: 'text', default: 'app01' },
      { id: 'source', label: 'Request from', control: 'select', options: [{ value: 'catalog', label: 'Catalog item' }, { value: 'template', label: 'Cloud template' }], default: 'catalog' },
      { id: 'catalog_item', label: 'Catalog item', control: 'text', default: 'linux-vm', showWhen: { input: 'source', equals: ['catalog'] } },
      { id: 'template', label: 'Cloud template', control: 'text', default: 'linux-vm', showWhen: { input: 'source', equals: ['template'] } },
      { id: 'version', label: 'Version', control: 'text', default: '1.0.0', hint: 'Blank for the latest' },
      { id: 'inputs', label: 'Inputs', control: 'textarea', default: 'hostname=app01\nimage=ubuntu-22.04\nsize=medium\ndataDiskGb=100', hint: 'One per line: name=value' },
      { id: 'reason', label: 'Reason', control: 'text', default: 'Requested by Terraform', section: 'Request' },
    ],
    emits: ['vra_deployment'],
    body: (v) => {
      const catalog = String(v.source) === 'catalog';
      const version = String(v.version ?? '').trim();
      const inputs = pairs(v.inputs);
      const width = Math.max(0, ...inputs.map(([k]) => k.length));
      const lookup = catalog
        ? `data "vra_catalog_item" "this" {
  name       = ${q(v.catalog_item)}
  project_id = data.vra_project.this.id
}`
        : `data "vra_blueprint" "this" {
  name = ${q(v.template)}
}`;
      const source = catalog
        ? `  catalog_item_id      = data.vra_catalog_item.this.id${version ? `\n  catalog_item_version = ${q(version)}` : ''}`
        : `  blueprint_id      = data.vra_blueprint.this.id${version ? `\n  blueprint_version = ${q(version)}` : ''}`;
      return `data "vra_project" "this" {
  name = ${q(v.project_name)}
}

${lookup}

resource "vra_deployment" "this" {
  name       = ${q(v.deployment_name)}
  project_id = data.vra_project.this.id
  reason     = ${q(v.reason)}

${source}

  inputs = {${inputs.map(([k, val]) => `\n    ${/^[A-Za-z_][\w-]*$/.test(k) ? k.padEnd(width) : q(k)} = ${q(val)}`).join('')}
  }
}

output "deployment_id" {
  value = vra_deployment.this.id
}`;
    },
  }),

  scenario('vra', {
    id: 'vra_project_governance',
    label: 'Governance: lease, approval and day-2 policies',
    description: 'The policies that usually come with a new project: a lease that expires deployments, an approval gate on requests, and the day-2 actions its members may run.',
    inputs: [
      { id: 'project_name', label: 'Project', control: 'text', default: 'app-team-a', hint: 'Existing project' },
      { id: 'enforcement', label: 'Enforcement', control: 'select', options: [{ value: 'HARD', label: 'Hard (cannot be overridden)' }, { value: 'SOFT', label: 'Soft' }], default: 'HARD' },
      { id: 'lease', label: 'Lease policy', control: 'toggle', default: true },
      { id: 'lease_days', label: 'Lease (days)', control: 'number', default: 30, min: 1, showWhen: { input: 'lease', equals: ['true'] } },
      { id: 'lease_total_days', label: 'Maximum total lease (days)', control: 'number', default: 180, min: 1, showWhen: { input: 'lease', equals: ['true'] } },
      { id: 'lease_grace_days', label: 'Grace period (days)', control: 'number', default: 7, min: 0, showWhen: { input: 'lease', equals: ['true'] } },
      { id: 'approval', label: 'Approval policy', control: 'toggle', default: true },
      { id: 'approval_type', label: 'Approvers are', control: 'select', options: [{ value: 'USER', label: 'Users / groups' }, { value: 'ROLE', label: 'Roles' }], default: 'USER', showWhen: { input: 'approval', equals: ['true'] } },
      { id: 'approvers', label: 'Approvers', control: 'textarea', default: 'USER:team-lead@example.com\nGROUP:app-team-a-approvers@example.com', hint: 'One per line: USER:name, GROUP:name (or ROLE:project_administrator)', showWhen: { input: 'approval', equals: ['true'] } },
      { id: 'approval_mode', label: 'Who must approve', control: 'select', options: [{ value: 'ANY_OF', label: 'Any one approver' }, { value: 'ALL_OF', label: 'All approvers' }], default: 'ANY_OF', showWhen: { input: 'approval', equals: ['true'] } },
      { id: 'approval_actions', label: 'Actions needing approval', control: 'checklist', options: [
        { value: 'Deployment.Create', label: 'New deployment' },
        { value: 'Deployment.Delete', label: 'Delete deployment' },
        { value: 'Deployment.ChangeLease', label: 'Change lease' },
        { value: 'Cloud.vSphere.Machine.Resize', label: 'Resize machine' },
      ], default: 'Deployment.Create, Cloud.vSphere.Machine.Resize', showWhen: { input: 'approval', equals: ['true'] } },
      { id: 'auto_decision', label: 'If nobody responds', control: 'select', options: [{ value: 'REJECT', label: 'Reject' }, { value: 'APPROVE', label: 'Approve' }, { value: 'NO_EXPIRY', label: 'Wait indefinitely' }], default: 'REJECT', showWhen: { input: 'approval', equals: ['true'] } },
      { id: 'auto_expiry_days', label: 'Respond within (days)', control: 'number', default: 3, min: 1, max: 30, showWhen: { input: 'approval', equals: ['true'] } },
      { id: 'day2', label: 'Day-2 action policy', control: 'toggle', default: true },
      { id: 'day2_authorities', label: 'Who may run them', control: 'textarea', default: 'GROUP:app-team-a@example.com', hint: 'One per line: USER:name, GROUP:name or ROLE:name', showWhen: { input: 'day2', equals: ['true'] } },
      { id: 'day2_actions', label: 'Allowed day-2 actions', control: 'checklist', options: [
        { value: 'Cloud.vSphere.Machine.PowerOn', label: 'Power on' },
        { value: 'Cloud.vSphere.Machine.PowerOff', label: 'Power off' },
        { value: 'Cloud.vSphere.Machine.Reboot', label: 'Reboot' },
        { value: 'Cloud.vSphere.Machine.Resize', label: 'Resize' },
        { value: 'Cloud.vSphere.Machine.Snapshot.Create', label: 'Create snapshot' },
        { value: 'Cloud.vSphere.Machine.Snapshot.Revert', label: 'Revert snapshot' },
        { value: 'Cloud.vSphere.Machine.Remote.Console', label: 'Remote console' },
        { value: 'Deployment.ChangeLease', label: 'Change lease' },
        { value: 'Deployment.Delete', label: 'Delete deployment' },
      ], default: 'Cloud.vSphere.Machine.PowerOn, Cloud.vSphere.Machine.PowerOff, Cloud.vSphere.Machine.Reboot, Cloud.vSphere.Machine.Snapshot.Create, Cloud.vSphere.Machine.Snapshot.Revert, Cloud.vSphere.Machine.Remote.Console', showWhen: { input: 'day2', equals: ['true'] } },
    ],
    emits: ['vra_policy_lease', 'vra_policy_approval', 'vra_policy_day2_action'],
    body: (v) => {
      const project = String(v.project_name);
      const parts = [
        `data "vra_project" "this" {
  name = ${q(project)}
}`,
      ];
      if (on(v.lease))
        parts.push(`resource "vra_policy_lease" "this" {
  name                 = ${q(`${project} lease`)}
  project_id           = data.vra_project.this.id
  enforcement_type     = ${q(v.enforcement)}
  lease_term_max       = ${n(v.lease_days, 30)}
  lease_total_term_max = ${n(v.lease_total_days, 180)}
  lease_grace          = ${n(v.lease_grace_days, 7)}
}`);
      if (on(v.approval))
        parts.push(`resource "vra_policy_approval" "this" {
  name                   = ${q(`${project} approval`)}
  project_id             = data.vra_project.this.id
  enforcement_type       = ${q(v.enforcement)}
  approval_level         = 1
  approval_type          = ${q(v.approval_type)}
  approval_mode          = ${q(v.approval_mode)}
  approvers              = [${items(v.approvers).map(q).join(', ')}]
  actions                = [${items(v.approval_actions).map(q).join(', ')}]
  auto_approval_decision = ${q(v.auto_decision)}
  auto_approval_expiry   = ${n(v.auto_expiry_days, 3)}
}`);
      if (on(v.day2))
        parts.push(`resource "vra_policy_day2_action" "this" {
  name             = ${q(`${project} day-2 actions`)}
  project_id       = data.vra_project.this.id
  enforcement_type = ${q(v.enforcement)}
  authorities      = [${items(v.day2_authorities).map(q).join(', ')}]
  actions          = [${items(v.day2_actions).map(q).join(', ')}]
}`);
      return parts.join('\n\n');
    },
  }),

  scenario('vra', {
    id: 'vra_public_cloud_account',
    label: 'Public cloud account (AWS, Azure, Google) + zones',
    description: 'An AWS, Azure or Google Cloud account in VCF Automation with a cloud zone for each enabled region. The secret (AWS access and secret keys, Azure application key, Google private key) is a sensitive variable.',
    inputs: [
      { id: 'cloud', label: 'Cloud', control: 'select', options: [{ value: 'aws', label: 'AWS' }, { value: 'azure', label: 'Microsoft Azure' }, { value: 'gcp', label: 'Google Cloud (GCP)' }], default: 'aws' },
      { id: 'account_name', label: 'Cloud account name', control: 'text', default: 'aws-prod' },
      { id: 'aws_regions', label: 'Regions', control: 'text', default: 'us-east-1, us-west-2', hint: 'Comma separated', showWhen: { input: 'cloud', equals: ['aws'] } },
      { id: 'azure_regions', label: 'Regions', control: 'text', default: 'eastus, westeurope', hint: 'Comma separated', showWhen: { input: 'cloud', equals: ['azure'] } },
      { id: 'subscription_id', label: 'Subscription ID', control: 'text', default: '00000000-0000-0000-0000-000000000000', showWhen: { input: 'cloud', equals: ['azure'] } },
      { id: 'tenant_id', label: 'Tenant ID', control: 'text', default: '00000000-0000-0000-0000-000000000000', showWhen: { input: 'cloud', equals: ['azure'] } },
      { id: 'application_id', label: 'Application (client) ID', control: 'text', default: '00000000-0000-0000-0000-000000000000', showWhen: { input: 'cloud', equals: ['azure'] } },
      { id: 'gcp_regions', label: 'Regions', control: 'text', default: 'us-central1, europe-west1', hint: 'Comma separated', showWhen: { input: 'cloud', equals: ['gcp'] } },
      { id: 'gcp_project', label: 'Project ID', control: 'text', default: 'example-prod', showWhen: { input: 'cloud', equals: ['gcp'] } },
      { id: 'client_email', label: 'Service account email', control: 'text', default: 'vcfa@example-prod.iam.gserviceaccount.com', showWhen: { input: 'cloud', equals: ['gcp'] } },
      { id: 'private_key_id', label: 'Private key ID', control: 'text', default: '0123456789abcdef0123456789abcdef01234567', showWhen: { input: 'cloud', equals: ['gcp'] } },
      { id: 'zone_placement', label: 'Zone placement policy', control: 'select', options: [{ value: 'DEFAULT', label: 'Default' }, { value: 'BINPACK', label: 'Binpack' }, { value: 'SPREAD', label: 'Spread' }], default: 'DEFAULT', section: 'Cloud zones' },
    ],
    emits: ['vra_cloud_account_aws', 'vra_cloud_account_azure', 'vra_cloud_account_gcp', 'vra_zone'],
    body: (v) => {
      const cloud = String(v.cloud);
      const regions = items(cloud === 'aws' ? v.aws_regions : cloud === 'azure' ? v.azure_regions : v.gcp_regions);
      const type = `vra_cloud_account_${cloud}`;
      const regionList = `[${regions.map(q).join(', ')}]`;
      const account =
        cloud === 'aws'
          ? `${variable('aws_access_key', 'AWS access key ID')}

${variable('aws_secret_key', 'AWS secret access key')}

resource "vra_cloud_account_aws" "this" {
  name       = ${q(v.account_name)}
  access_key = var.aws_access_key
  secret_key = var.aws_secret_key
  regions    = ${regionList}
}`
          : cloud === 'azure'
            ? `${variable('azure_application_key', 'Client secret of the Azure application')}

resource "vra_cloud_account_azure" "this" {
  name            = ${q(v.account_name)}
  subscription_id = ${q(v.subscription_id)}
  tenant_id       = ${q(v.tenant_id)}
  application_id  = ${q(v.application_id)}
  application_key = var.azure_application_key
  regions         = ${regionList}
}`
            : `${variable('gcp_private_key', 'Private key (PEM) of the Google service account')}

resource "vra_cloud_account_gcp" "this" {
  name           = ${q(v.account_name)}
  project_id     = ${q(v.gcp_project)}
  client_email   = ${q(v.client_email)}
  private_key_id = ${q(v.private_key_id)}
  private_key    = var.gcp_private_key
  regions        = ${regionList}
}`;
      const zones = regions
        .map((r) => {
          const ref = ident(r);
          return `data "vra_region" "${ref}" {
  cloud_account_id = ${type}.this.id
  region           = ${q(r)}
}

resource "vra_zone" "${ref}" {
  name             = ${q(`${v.account_name}-${r}`)}
  region_id        = data.vra_region.${ref}.id
  placement_policy = ${q(v.zone_placement)}

  tags {
    key   = "cloud"
    value = "${cloud}"
  }
}`;
        })
        .join('\n\n');
      return `${account}

${zones}`;
    },
  }),
];
