/**
 * Hand-written Cloud Director (vmware/vcd) scenario blueprints: several
 * resources built together.
 *
 * Covered: tenant onboarding (org, VDC, org admin), an NSX-T edge gateway with
 * a routed network, NAT and firewall, an isolated network with DHCP, a vApp of
 * VMs, a standalone VM, a catalog with uploads, a VDC group with distributed
 * firewall, an IPsec VPN tunnel, Avi load balancing on an edge gateway, tenant
 * roles and users, and provider IP Spaces. NSX-T backed resources throughout;
 * what already exists (provider VDC, external network, edge gateway, catalog,
 * template) is looked up, not recreated.
 */

import type { Blueprint, TemplateValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { scenario, q, qlist, items, ident, on, n, YES_NO_OPTIONS } from './scenario-common.ts';

// --- helpers -------------------------------------------------------------------

type Row = readonly [string, string | number | boolean | undefined | null];

/** Attribute lines with their `=` aligned, as `terraform fmt` writes them; empty values are left out. */
function a(rows: readonly Row[], indent = '  '): string {
  const kept = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  const width = Math.max(0, ...kept.map(([k]) => k.length));
  return kept.map(([k, v]) => `${indent}${k.padEnd(width)} = ${v}`).join('\n');
}

/** A block: its attributes, then its nested blocks, each separated by a blank line. */
function blk(header: string, parts: readonly (string | false | undefined)[], indent = ''): string {
  const body = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n\n');
  return `${indent}${header} {\n${body}\n${indent}}`;
}

/** Non-empty, non-comment lines of a textarea. */
function lines(value: unknown): string[] {
  return String(value ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith('#'));
}

/** The comma-separated fields of one line. */
function fields(line: string): string[] {
  return line.split(',').map((s) => s.trim());
}

/** `name = value` split on the last `=`, so names may contain spaces. */
function keyValue(line: string): [string, string] {
  const at = line.lastIndexOf('=');
  return at === -1 ? [line.trim(), ''] : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
}

/** The network CIDR a gateway address and prefix length sit in (IPv4). */
function cidrOf(gateway: unknown, prefix: number): string {
  const octets = String(gateway ?? '').trim().split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return `${String(gateway).trim()}/${prefix}`;
  const ip = octets.reduce((acc, o) => acc * 256 + o, 0);
  const size = 2 ** (32 - prefix);
  const base = Math.floor(ip / size) * size;
  return `${[24, 16, 8, 0].map((s) => Math.floor(base / 2 ** s) % 256).join('.')}/${prefix}`;
}

function sensitiveVariable(name: string, description: string): string {
  return `variable "${name}" {\n  description = ${q(description)}\n  type        = string\n  sensitive   = true\n}`;
}

const list = (refs: readonly string[]): string => `[${refs.join(', ')}]`;

/** Unique Terraform names for a list of free-text names. */
function uniqueIdents(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const base = ident(name, 'item');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

const ORG_INPUT = { id: 'org', label: 'Organization', control: 'text', default: 'tenant-a', hint: 'Tenant organization name' } as const;
const VDC_INPUT = { id: 'vdc', label: 'Organization VDC', control: 'text', default: 'tenant-a-vdc-01', hint: 'Existing VDC (looked up)' } as const;

function vdcLookup(v: TemplateValues): string {
  return `data "vcd_org_vdc" "this" {\n${a([['org', q(v.org)], ['name', q(v.vdc)]])}\n}`;
}

function edgeLookup(v: TemplateValues): string {
  return `data "vcd_nsxt_edgegateway" "this" {\n${a([['org', q(v.org)], ['owner_id', 'data.vcd_org_vdc.this.id'], ['name', q(v.edge_gateway)]])}\n}`;
}

const ALLOCATION_MODELS = [
  { value: 'Flex', label: 'Flex' },
  { value: 'AllocationVApp', label: 'Pay-as-you-go (AllocationVApp)' },
  { value: 'AllocationPool', label: 'Allocation pool (AllocationPool)' },
  { value: 'ReservationPool', label: 'Reservation pool (ReservationPool)' },
];

const IP_MODES = [
  { value: 'POOL', label: 'POOL — from the network static IP pool' },
  { value: 'DHCP', label: 'DHCP' },
  { value: 'MANUAL', label: 'MANUAL — fixed IP per VM' },
];

const NETWORK_KINDS = [
  { value: 'routed', label: 'Routed (vcd_network_routed_v2)' },
  { value: 'isolated', label: 'Isolated (vcd_network_isolated_v2)' },
];

const FIREWALL_ACTIONS = new Set(['ALLOW', 'DROP', 'REJECT']);

/** Data source for an existing org VDC network of either kind; returns [hcl, name reference]. */
function orgNetworkLookup(v: TemplateValues): [string, string] {
  if (v.network_kind === 'isolated') {
    return [
      `data "vcd_network_isolated_v2" "this" {\n${a([['org', q(v.org)], ['owner_id', 'data.vcd_org_vdc.this.id'], ['name', q(v.org_network)]])}\n}`,
      'data.vcd_network_isolated_v2.this.name',
    ];
  }
  return [`data "vcd_network_routed_v2" "this" {\n${a([['org', q(v.org)], ['name', q(v.org_network)]])}\n}`, 'data.vcd_network_routed_v2.this.name'];
}

function templateLookup(v: TemplateValues): string {
  return [
    `data "vcd_catalog" "this" {\n${a([['org', q(v.catalog_org || v.org)], ['name', q(v.catalog)]])}\n}`,
    `data "vcd_catalog_vapp_template" "this" {\n${a([['org', q(v.catalog_org || v.org)], ['catalog_id', 'data.vcd_catalog.this.id'], ['name', q(v.template)]])}\n}`,
  ].join('\n\n');
}

/** The inputs shared by the vApp and standalone VM scenarios. */
function vmInputs(): Blueprint['inputs'] {
  return [
    { id: 'network_kind', label: 'Network type', control: 'select', options: NETWORK_KINDS, default: 'routed' },
    { id: 'org_network', label: 'Org VDC network', control: 'text', default: 'tenant-a-web', hint: 'Existing network (looked up)' },
    { id: 'ip_mode', label: 'IP allocation', control: 'select', options: IP_MODES, default: 'POOL' },
    { id: 'catalog', label: 'Catalog', control: 'text', default: 'tenant-a-catalog', hint: 'Catalog holding the template' },
    { id: 'template', label: 'vApp template', control: 'text', default: 'ubuntu-22.04-server' },
    {
      id: 'sizing',
      label: 'Sizing',
      control: 'select',
      options: [
        { value: 'explicit', label: 'CPU and memory set here' },
        { value: 'policy', label: 'VM sizing policy' },
      ],
      default: 'explicit',
    },
    { id: 'cpus', label: 'vCPUs', control: 'number', default: 2, min: 1, showWhen: { input: 'sizing', equals: ['explicit'] } },
    { id: 'cpu_cores', label: 'Cores per socket', control: 'number', default: 1, min: 1, showWhen: { input: 'sizing', equals: ['explicit'] } },
    { id: 'memory', label: 'Memory', control: 'number', default: 4096, min: 256, hint: 'MB', showWhen: { input: 'sizing', equals: ['explicit'] } },
    { id: 'sizing_policy', label: 'Sizing policy', control: 'text', default: 'gold-medium', hint: 'Assigned to the VDC', showWhen: { input: 'sizing', equals: ['policy'] } },
    { id: 'customize', label: 'Guest customization', control: 'toggle', default: true, hint: 'Sets hostname, network and admin password' },
    { id: 'initscript', label: 'Init script', control: 'textarea', default: '', hint: 'Optional; runs on first boot', showWhen: { input: 'customize', equals: ['true'] } },
    { id: 'storage_profile', label: 'Storage policy', control: 'text', default: '', hint: 'Blank = VDC default', section: 'Placement' },
    { id: 'power_on', label: 'Power on', control: 'toggle', default: true, section: 'Placement' },
    { id: 'catalog_org', label: 'Catalog organization', control: 'text', default: '', hint: 'Blank = same org; set for a shared provider catalog', section: 'Placement' },
  ];
}

/** Sizing, storage, NIC and customization lines of a vcd_vapp_vm / vcd_vm. */
function vmBody(v: TemplateValues, network: string, ip: string | null): string[] {
  const explicit = v.sizing !== 'policy';
  const init = String(v.initscript ?? '').trim();
  const nic = blk('network', [
    a(
      [
        ['type', '"org"'],
        ['name', network],
        ['ip_allocation_mode', q(v.ip_mode)],
        ['ip', v.ip_mode === 'MANUAL' ? ip : undefined],
        ['is_primary', true],
      ],
      '    ',
    ),
  ], '  ');
  const customization = on(v.customize)
    ? blk('customization', [
        a(
          [
            ['enabled', true],
            ['allow_local_admin_password', true],
            ['auto_generate_password', false],
            ['admin_password', 'var.vm_admin_password'],
            ['initscript', init ? `<<-EOT\n${init.replace(/\$\{/g, '$${').split('\n').map((l) => `      ${l}`).join('\n')}\n    EOT` : undefined],
          ],
          '    ',
        ),
      ], '  ')
    : undefined;
  return [
    a([
      ['cpus', explicit ? n(v.cpus, 2) : undefined],
      ['cpu_cores', explicit ? n(v.cpu_cores, 1) : undefined],
      ['memory', explicit ? n(v.memory, 4096) : undefined],
      ['sizing_policy_id', explicit ? undefined : 'data.vcd_vm_sizing_policy.this.id'],
      ['storage_profile', String(v.storage_profile ?? '').trim() ? q(v.storage_profile) : undefined],
      ['power_on', on(v.power_on)],
    ]),
    nic,
    customization ?? '',
  ];
}

function vmDataSources(v: TemplateValues): string[] {
  return v.sizing === 'policy' ? [`data "vcd_vm_sizing_policy" "this" {\n${a([['name', q(v.sizing_policy)]])}\n}`] : [];
}

// --- scenarios -----------------------------------------------------------------

export const VCD_SCENARIOS: readonly Blueprint[] = [
  // Tenant onboarding ---------------------------------------------------------
  scenario('vcd', {
    id: 'vcd_tenant_org_vdc',
    label: 'Tenant onboarding: organization + VDC + org admin',
    description:
      'A new organization with an organization VDC carved from an existing provider VDC (allocation model, CPU/memory/storage limits, network pool, optional sizing policy) and its first Organization Administrator. Run as a system administrator.',
    inputs: [
      { id: 'org_name', label: 'Organization name', control: 'text', default: 'tenant-a', hint: 'Short name used in URLs' },
      { id: 'org_full_name', label: 'Full name', control: 'text', default: 'Tenant A Ltd' },
      { id: 'org_description', label: 'Description', control: 'text', default: 'Tenant A production workloads' },
      { id: 'vdc_name', label: 'VDC name', control: 'text', default: 'tenant-a-vdc-01' },
      { id: 'provider_vdc', label: 'Provider VDC', control: 'text', default: 'pvdc-gold-01', hint: 'Existing (looked up)' },
      { id: 'allocation_model', label: 'Allocation model', control: 'select', options: ALLOCATION_MODELS, default: 'Flex' },
      { id: 'cpu_allocated', label: 'CPU allocation', control: 'number', default: 20000, hint: 'MHz', min: 0 },
      { id: 'cpu_limit', label: 'CPU limit', control: 'number', default: 40000, hint: 'MHz, 0 = unlimited', min: 0 },
      { id: 'memory_allocated', label: 'Memory allocation', control: 'number', default: 65536, hint: 'MB', min: 0 },
      { id: 'memory_limit', label: 'Memory limit', control: 'number', default: 131072, hint: 'MB, 0 = unlimited', min: 0 },
      { id: 'cpu_guaranteed', label: 'CPU guaranteed', control: 'number', default: 20, hint: '%', min: 0, max: 100, showWhen: { input: 'allocation_model', notEquals: ['ReservationPool'] } },
      { id: 'memory_guaranteed', label: 'Memory guaranteed', control: 'number', default: 50, hint: '%', min: 0, max: 100, showWhen: { input: 'allocation_model', notEquals: ['ReservationPool'] } },
      { id: 'cpu_speed', label: 'vCPU speed', control: 'number', default: 2000, hint: 'MHz per vCPU', min: 0, showWhen: { input: 'allocation_model', notEquals: ['ReservationPool'] } },
      { id: 'elasticity', label: 'Elastic', control: 'toggle', default: true, hint: 'Flex: span all clusters of the provider VDC', showWhen: { input: 'allocation_model', equals: ['Flex'] } },
      { id: 'include_vm_memory_overhead', label: 'Count VM memory overhead', control: 'toggle', default: false, showWhen: { input: 'allocation_model', equals: ['Flex'] } },
      {
        id: 'storage_profiles',
        label: 'Storage policies',
        control: 'textarea',
        default: 'vSAN Default Storage Policy = 1048576\nGold = 524288',
        hint: 'One per line: provider VDC storage policy = limit in MB (0 = unlimited). The first is the default.',
      },
      { id: 'network_pool', label: 'Network pool', control: 'text', default: 'np-geneve-01', hint: 'Existing (looked up)' },
      { id: 'network_quota', label: 'Network quota', control: 'number', default: 20, min: 0, hint: 'Org VDC networks' },
      { id: 'sizing_policy', label: 'Default VM sizing policy', control: 'text', default: '', hint: 'Optional; published to the VDC and made default' },
      { id: 'admin_user', label: 'Org admin user', control: 'text', default: 'tenant-a-admin', hint: 'Lowercase' },
      { id: 'admin_email', label: 'Org admin email', control: 'text', default: 'cloud-admin@example.com' },
      {
        id: 'admin_role',
        label: 'Org admin role',
        control: 'combo',
        options: [
          { value: 'Organization Administrator', label: 'Organization Administrator' },
          { value: 'Catalog Author', label: 'Catalog Author' },
          { value: 'vApp Author', label: 'vApp Author' },
        ],
        default: 'Organization Administrator',
        hint: 'Global role (looked up)',
      },
      { id: 'vm_quota', label: 'VM quota', control: 'number', default: 0, min: 0, hint: '0 = unlimited', section: 'Quotas & provisioning' },
      { id: 'thin_provisioning', label: 'Thin provisioning', control: 'toggle', default: true, section: 'Quotas & provisioning' },
      { id: 'fast_provisioning', label: 'Fast provisioning', control: 'toggle', default: false, hint: 'Linked clones', section: 'Quotas & provisioning' },
      { id: 'deployed_vm_quota', label: 'Running VMs per user', control: 'number', default: 0, min: 0, hint: '0 = unlimited', section: 'Organization policies' },
      { id: 'stored_vm_quota', label: 'Stored VMs per user', control: 'number', default: 0, min: 0, hint: '0 = unlimited', section: 'Organization policies' },
      { id: 'can_publish_catalogs', label: 'May share catalogs', control: 'toggle', default: true, section: 'Organization policies' },
      { id: 'leases', label: 'Set vApp leases', control: 'toggle', default: false, section: 'Organization policies' },
      { id: 'runtime_lease_days', label: 'vApp runtime lease', control: 'number', default: 0, min: 0, hint: 'days, 0 = never', showWhen: { input: 'leases', equals: ['true'] }, section: 'Organization policies' },
      { id: 'storage_lease_days', label: 'vApp storage lease', control: 'number', default: 0, min: 0, hint: 'days, 0 = never', showWhen: { input: 'leases', equals: ['true'] }, section: 'Organization policies' },
    ],
    emits: ['vcd_org', 'vcd_org_vdc', 'vcd_org_user'],
    body: (v) => {
      const findings: Finding[] = [];
      const model = String(v.allocation_model);
      const reservation = model === 'ReservationPool';
      const profiles = lines(v.storage_profiles).map(keyValue);
      if (profiles.length === 0) {
        findings.push(error('terraform.vcd_tenant_org_vdc.no-storage', 'A VDC needs at least one storage policy.', { path: 'storage_profiles' }));
        profiles.push(['*', '0']);
      }
      const sizing = String(v.sizing_policy ?? '').trim();
      const day = 86400;
      const leases = on(v.leases)
        ? [
            blk('vapp_lease', [
              a(
                [
                  ['maximum_runtime_lease_in_sec', n(v.runtime_lease_days, 0) * day],
                  ['power_off_on_runtime_lease_expiration', true],
                  ['maximum_storage_lease_in_sec', n(v.storage_lease_days, 0) * day],
                  ['delete_on_storage_lease_expiration', false],
                ],
                '    ',
              ),
            ], '  '),
            blk('vapp_template_lease', [
              a([['maximum_storage_lease_in_sec', 0], ['delete_on_storage_lease_expiration', false]], '    '),
            ], '  '),
          ]
        : [];
      const hcl = [
        `data "vcd_provider_vdc" "this" {\n${a([['name', q(v.provider_vdc)]])}\n}`,
        `data "vcd_network_pool" "this" {\n${a([['name', q(v.network_pool)]])}\n}`,
        `data "vcd_global_role" "org_admin" {\n${a([['name', q(v.admin_role)]])}\n}`,
        ...(sizing ? [`data "vcd_vm_sizing_policy" "default" {\n${a([['name', q(sizing)]])}\n}`] : []),
        blk('resource "vcd_org" "this"', [
          a([
            ['name', q(v.org_name)],
            ['full_name', q(v.org_full_name)],
            ['description', q(v.org_description)],
            ['is_enabled', true],
            ['can_publish_catalogs', on(v.can_publish_catalogs)],
            ['deployed_vm_quota', n(v.deployed_vm_quota, 0)],
            ['stored_vm_quota', n(v.stored_vm_quota, 0)],
            // Destroy removes what the org still holds, but only what is in a removable state.
            ['delete_recursive', true],
            ['delete_force', false],
          ]),
          ...leases,
        ]),
        blk('resource "vcd_org_vdc" "this"', [
          a([
            ['org', 'vcd_org.this.name'],
            ['name', q(v.vdc_name)],
            ['description', q(`${v.org_full_name} virtual data center`)],
            ['allocation_model', q(model)],
            ['provider_vdc_name', 'data.vcd_provider_vdc.this.name'],
            ['network_pool_name', 'data.vcd_network_pool.this.name'],
            ['network_quota', n(v.network_quota, 20)],
            ['vm_quota', n(v.vm_quota, 0)],
            ['cpu_guaranteed', reservation ? undefined : n(v.cpu_guaranteed, 20) / 100],
            ['memory_guaranteed', reservation ? undefined : n(v.memory_guaranteed, 50) / 100],
            ['cpu_speed', reservation ? undefined : n(v.cpu_speed, 2000)],
            ['elasticity', model === 'Flex' ? on(v.elasticity) : undefined],
            ['include_vm_memory_overhead', model === 'Flex' ? on(v.include_vm_memory_overhead) : undefined],
            ['enable_thin_provisioning', on(v.thin_provisioning)],
            ['enable_fast_provisioning', on(v.fast_provisioning)],
            ['vm_sizing_policy_ids', sizing ? '[data.vcd_vm_sizing_policy.default.id]' : undefined],
            ['default_compute_policy_id', sizing ? 'data.vcd_vm_sizing_policy.default.id' : undefined],
            ['delete_recursive', true],
            ['delete_force', false],
          ]),
          blk('compute_capacity', [
            blk('cpu', [a([['allocated', n(v.cpu_allocated, 0)], ['limit', n(v.cpu_limit, 0)]], '      ')], '    '),
            blk('memory', [a([['allocated', n(v.memory_allocated, 0)], ['limit', n(v.memory_limit, 0)]], '      ')], '    '),
          ], '  '),
          ...profiles.map(([name, limit], i) =>
            blk('storage_profile', [a([['name', q(name)], ['limit', n(limit, 0)], ['enabled', true], ['default', i === 0]], '    ')], '  '),
          ),
        ]),
        sensitiveVariable('org_admin_password', 'Initial password for the organization administrator'),
        blk('resource "vcd_org_user" "admin"', [
          a([
            ['org', 'vcd_org.this.name'],
            ['name', q(v.admin_user)],
            ['role', 'data.vcd_global_role.org_admin.name'],
            ['password', 'var.org_admin_password'],
            ['email_address', q(v.admin_email)],
            ['enabled', true],
            ['take_ownership', true],
          ]),
        ]),
        `output "org_id" {\n  value = vcd_org.this.id\n}`,
        `output "vdc_id" {\n  value = vcd_org_vdc.this.id\n}`,
      ].join('\n\n');
      return { hcl, findings };
    },
  }),

  // Edge gateway + routed network ---------------------------------------------
  scenario('vcd', {
    id: 'vcd_nsxt_edge_routed_network',
    label: 'NSX-T edge gateway + routed network (SNAT, DNAT, firewall)',
    description:
      'An NSX-T edge gateway on an existing provider gateway (external network) with a sub-allocated uplink range, a routed org VDC network with a static IP pool, SNAT for the network, DNAT rules and the edge firewall. Creating the edge gateway needs a system administrator.',
    inputs: [
      ORG_INPUT,
      VDC_INPUT,
      { id: 'external_network', label: 'Provider gateway', control: 'text', default: 'provider-gw-01', hint: 'Existing NSX-T external network (looked up)' },
      { id: 'edge_name', label: 'Edge gateway name', control: 'text', default: 'tenant-a-edge-01' },
      { id: 'uplink_gateway', label: 'Uplink gateway', control: 'text', default: '203.0.113.1' },
      { id: 'uplink_prefix', label: 'Uplink prefix length', control: 'number', default: 24, min: 1, max: 32 },
      { id: 'uplink_start', label: 'Allocated IPs from', control: 'text', default: '203.0.113.10' },
      { id: 'uplink_end', label: 'Allocated IPs to', control: 'text', default: '203.0.113.19' },
      { id: 'primary_ip', label: 'Primary IP', control: 'text', default: '203.0.113.10', hint: 'Within the allocated range; used for SNAT' },
      { id: 'network_name', label: 'Routed network name', control: 'text', default: 'tenant-a-web' },
      { id: 'network_gateway', label: 'Network gateway', control: 'text', default: '10.10.10.1' },
      { id: 'network_prefix', label: 'Network prefix length', control: 'number', default: 24, min: 8, max: 30 },
      { id: 'pool_start', label: 'Static pool from', control: 'text', default: '10.10.10.100' },
      { id: 'pool_end', label: 'Static pool to', control: 'text', default: '10.10.10.199' },
      { id: 'dns1', label: 'DNS server 1', control: 'text', default: '10.0.0.53' },
      { id: 'dns2', label: 'DNS server 2', control: 'text', default: '10.0.0.54' },
      { id: 'dns_suffix', label: 'DNS suffix', control: 'text', default: 'example.com' },
      { id: 'snat', label: 'SNAT the network to the primary IP', control: 'toggle', default: true },
      {
        id: 'dnat_rules',
        label: 'DNAT rules',
        control: 'textarea',
        default: 'web-https, 203.0.113.11, 10.10.10.11, 443',
        hint: 'One per line: name, external IP, internal IP[, TCP port]. Without a port every port is translated.',
      },
      { id: 'firewall', label: 'Edge firewall rules', control: 'toggle', default: true, hint: 'Manages the whole edge rule set' },
      {
        id: 'firewall_rules',
        label: 'Firewall rules',
        control: 'textarea',
        default: 'outbound, ALLOW, internal, any, any\nhttps-in, ALLOW, any, 10.10.10.11, HTTPS\nssh-admin, ALLOW, 198.51.100.0/24, internal, SSH',
        hint: 'One per line, in order: name, ALLOW|DROP|REJECT, source, destination, service. Source/destination: any, internal (this network) or space-separated IPs/CIDRs. Service: any or a system app port profile (HTTPS, SSH, HTTP, RDP…).',
        showWhen: { input: 'firewall', equals: ['true'] },
      },
      { id: 'dedicate', label: 'Dedicate the provider gateway', control: 'toggle', default: false, hint: 'Enables route advertisement to it', section: 'Advanced' },
      { id: 'route_advertisement', label: 'Advertise the network', control: 'toggle', default: false, hint: 'Only with a dedicated provider gateway', section: 'Advanced' },
    ],
    emits: ['vcd_nsxt_edgegateway', 'vcd_network_routed_v2', 'vcd_nsxt_nat_rule', 'vcd_nsxt_app_port_profile', 'vcd_nsxt_ip_set', 'vcd_nsxt_firewall'],
    body: (v) => {
      const findings: Finding[] = [];
      const cidr = cidrOf(v.network_gateway, n(v.network_prefix, 24));
      const out: string[] = [
        vdcLookup(v),
        `data "vcd_external_network_v2" "uplink" {\n${a([['name', q(v.external_network)]])}\n}`,
        blk('resource "vcd_nsxt_edgegateway" "this"', [
          a([
            ['org', q(v.org)],
            ['owner_id', 'data.vcd_org_vdc.this.id'],
            ['name', q(v.edge_name)],
            ['external_network_id', 'data.vcd_external_network_v2.uplink.id'],
            ['dedicate_external_network', on(v.dedicate)],
          ]),
          blk('subnet', [
            a([['gateway', q(v.uplink_gateway)], ['prefix_length', n(v.uplink_prefix, 24)], ['primary_ip', q(v.primary_ip)]], '    '),
            blk('allocated_ips', [a([['start_address', q(v.uplink_start)], ['end_address', q(v.uplink_end)]], '      ')], '    '),
          ], '  '),
        ]),
        blk('resource "vcd_network_routed_v2" "this"', [
          a([
            ['org', q(v.org)],
            ['edge_gateway_id', 'vcd_nsxt_edgegateway.this.id'],
            ['name', q(v.network_name)],
            ['gateway', q(v.network_gateway)],
            ['prefix_length', n(v.network_prefix, 24)],
            ['dns1', String(v.dns1 ?? '').trim() ? q(v.dns1) : undefined],
            ['dns2', String(v.dns2 ?? '').trim() ? q(v.dns2) : undefined],
            ['dns_suffix', String(v.dns_suffix ?? '').trim() ? q(v.dns_suffix) : undefined],
            ['route_advertisement_enabled', on(v.route_advertisement) ? true : undefined],
          ]),
          blk('static_ip_pool', [a([['start_address', q(v.pool_start)], ['end_address', q(v.pool_end)]], '    ')], '  '),
        ]),
      ];
      if (on(v.snat)) {
        out.push(
          blk('resource "vcd_nsxt_nat_rule" "snat"', [
            a([
              ['org', q(v.org)],
              ['edge_gateway_id', 'vcd_nsxt_edgegateway.this.id'],
              ['name', q(`${v.network_name}-snat`)],
              ['rule_type', '"SNAT"'],
              ['description', q(`Outbound for ${cidr}`)],
              ['external_address', q(v.primary_ip)],
              ['internal_address', q(cidr)],
              ['logging', false],
            ]),
          ]),
        );
      }
      const dnat = lines(v.dnat_rules).map(fields);
      const dnatNames = uniqueIdents(dnat.map((f) => f[0] ?? 'dnat'));
      dnat.forEach(([name, external, internal, port], i) => {
        const id = `dnat_${dnatNames[i]}`;
        if (!external || !internal) {
          findings.push(error('terraform.vcd_nsxt_edge_routed_network.dnat', `DNAT rule "${name}" needs an external and an internal IP.`, { path: 'dnat_rules' }));
          return;
        }
        if (port) {
          out.push(
            blk(`resource "vcd_nsxt_app_port_profile" "${id}"`, [
              a([['org', q(v.org)], ['context_id', 'data.vcd_org_vdc.this.id'], ['scope', '"TENANT"'], ['name', q(`${name}-tcp-${port}`)]]),
              blk('app_port', [a([['protocol', '"TCP"'], ['port', qlist(port)]], '    ')], '  '),
            ]),
          );
        }
        out.push(
          blk(`resource "vcd_nsxt_nat_rule" "${id}"`, [
            a([
              ['org', q(v.org)],
              ['edge_gateway_id', 'vcd_nsxt_edgegateway.this.id'],
              ['name', q(name)],
              ['rule_type', '"DNAT"'],
              ['external_address', q(external)],
              ['internal_address', q(internal)],
              ['app_port_profile_id', port ? `vcd_nsxt_app_port_profile.${id}.id` : undefined],
              ['firewall_match', '"MATCH_INTERNAL_ADDRESS"'],
              ['logging', false],
            ]),
          ]),
        );
      });
      if (on(v.firewall)) {
        const rules = lines(v.firewall_rules).map(fields);
        const ids = uniqueIdents(rules.map((f) => f[0] ?? 'rule'));
        const ipSets: string[] = [];
        const profiles = new Map<string, string>();
        let internal = false;
        const side = (value: string | undefined, rule: string, which: string): string[] => {
          const text = (value ?? 'any').trim();
          if (text === '' || text.toLowerCase() === 'any') return [];
          if (text.toLowerCase() === 'internal') {
            internal = true;
            return ['vcd_nsxt_ip_set.internal.id'];
          }
          const setId = `${rule}_${which}`;
          ipSets.push(
            blk(`resource "vcd_nsxt_ip_set" "${setId}"`, [
              a([
                ['org', q(v.org)],
                ['edge_gateway_id', 'vcd_nsxt_edgegateway.this.id'],
                ['name', q(`${rule.replace(/_/g, '-')}-${which}`)],
                ['ip_addresses', list(text.split(/\s+/).map(q))],
              ]),
            ]),
          );
          return [`vcd_nsxt_ip_set.${setId}.id`];
        };
        const ruleBlocks = rules.flatMap(([name, action, source, destination, service], i) => {
          const act = String(action ?? '').toUpperCase();
          if (!FIREWALL_ACTIONS.has(act)) {
            findings.push(error('terraform.vcd_nsxt_edge_routed_network.action', `Firewall rule "${name}": action must be ALLOW, DROP or REJECT.`, { path: 'firewall_rules' }));
            return [];
          }
          const rid = ids[i] as string;
          const src = side(source, rid, 'src');
          const dst = side(destination, rid, 'dst');
          const svc = (service ?? 'any').trim();
          let profile: string | undefined;
          if (svc && svc.toLowerCase() !== 'any') {
            const pid = ident(svc);
            profiles.set(pid, svc);
            profile = `[data.vcd_nsxt_app_port_profile.${pid}.id]`;
          }
          return [
            blk('rule', [
              a(
                [
                  ['name', q(name)],
                  ['direction', '"IN_OUT"'],
                  ['ip_protocol', '"IPV4"'],
                  ['action', q(act)],
                  ['source_ids', src.length ? list(src) : undefined],
                  ['destination_ids', dst.length ? list(dst) : undefined],
                  ['app_port_profile_ids', profile],
                  ['logging', act !== 'ALLOW'],
                ],
                '    ',
              ),
            ], '  '),
          ];
        });
        if (ruleBlocks.length === 0) {
          findings.push(error('terraform.vcd_nsxt_edge_routed_network.no-rules', 'The edge firewall needs at least one rule.', { path: 'firewall_rules' }));
        } else {
          if (internal) {
            out.push(
              blk('resource "vcd_nsxt_ip_set" "internal"', [
                a([
                  ['org', q(v.org)],
                  ['edge_gateway_id', 'vcd_nsxt_edgegateway.this.id'],
                  ['name', q(`${v.network_name}-net`)],
                  ['ip_addresses', list([q(cidr)])],
                ]),
              ]),
            );
          }
          out.push(...ipSets);
          for (const [pid, name] of profiles) {
            out.push(`data "vcd_nsxt_app_port_profile" "${pid}" {\n${a([['scope', '"SYSTEM"'], ['name', q(name)]])}\n}`);
          }
          out.push(
            `# Replaces the whole rule set on the edge gateway, in this order.\n` +
              blk('resource "vcd_nsxt_firewall" "this"', [a([['org', q(v.org)], ['edge_gateway_id', 'vcd_nsxt_edgegateway.this.id']]), ...ruleBlocks]),
          );
        }
      }
      out.push(`output "edge_gateway_id" {\n  value = vcd_nsxt_edgegateway.this.id\n}`);
      out.push(`output "network_id" {\n  value = vcd_network_routed_v2.this.id\n}`);
      return { hcl: out.join('\n\n'), findings };
    },
  }),

  // Isolated network + DHCP ---------------------------------------------------
  scenario('vcd', {
    id: 'vcd_isolated_network_dhcp',
    label: 'Isolated network + DHCP',
    description:
      'An NSX-T isolated org VDC network (no edge gateway) with a static IP pool and a network-mode DHCP service: its own listener IP, a lease pool and DNS servers.',
    inputs: [
      ORG_INPUT,
      VDC_INPUT,
      { id: 'network_name', label: 'Network name', control: 'text', default: 'tenant-a-db' },
      { id: 'description', label: 'Description', control: 'text', default: 'Database tier, no external access' },
      { id: 'gateway', label: 'Gateway', control: 'text', default: '10.20.20.1' },
      { id: 'prefix', label: 'Prefix length', control: 'number', default: 24, min: 8, max: 30 },
      { id: 'pool_start', label: 'Static pool from', control: 'text', default: '10.20.20.10' },
      { id: 'pool_end', label: 'Static pool to', control: 'text', default: '10.20.20.99' },
      { id: 'dhcp_listener', label: 'DHCP server IP', control: 'text', default: '10.20.20.2', hint: 'In the subnet, outside both pools' },
      { id: 'dhcp_start', label: 'DHCP pool from', control: 'text', default: '10.20.20.100' },
      { id: 'dhcp_end', label: 'DHCP pool to', control: 'text', default: '10.20.20.199' },
      { id: 'dns_servers', label: 'DNS servers', control: 'text', default: '10.0.0.53, 10.0.0.54', hint: 'Up to two, comma separated' },
      { id: 'dns_suffix', label: 'DNS suffix', control: 'text', default: 'example.com' },
      { id: 'lease_time', label: 'Lease time', control: 'number', default: 86400, min: 60, hint: 'seconds' },
    ],
    emits: ['vcd_network_isolated_v2', 'vcd_nsxt_network_dhcp'],
    body: (v) => {
      const findings: Finding[] = [];
      const dns = items(v.dns_servers);
      if (dns.length > 2) findings.push(error('terraform.vcd_isolated_network_dhcp.dns', 'DHCP hands out at most two DNS servers.', { path: 'dns_servers' }));
      const hcl = [
        vdcLookup(v),
        blk('resource "vcd_network_isolated_v2" "this"', [
          a([
            ['org', q(v.org)],
            ['owner_id', 'data.vcd_org_vdc.this.id'],
            ['name', q(v.network_name)],
            ['description', q(v.description)],
            ['gateway', q(v.gateway)],
            ['prefix_length', n(v.prefix, 24)],
            ['dns1', dns[0] ? q(dns[0]) : undefined],
            ['dns2', dns[1] ? q(dns[1]) : undefined],
            ['dns_suffix', String(v.dns_suffix ?? '').trim() ? q(v.dns_suffix) : undefined],
          ]),
          blk('static_ip_pool', [a([['start_address', q(v.pool_start)], ['end_address', q(v.pool_end)]], '    ')], '  '),
        ]),
        // Isolated networks have no edge to serve DHCP, so it runs in NETWORK mode on its own IP.
        blk('resource "vcd_nsxt_network_dhcp" "this"', [
          a([
            ['org', q(v.org)],
            ['org_network_id', 'vcd_network_isolated_v2.this.id'],
            ['mode', '"NETWORK"'],
            ['listener_ip_address', q(v.dhcp_listener)],
            ['lease_time', n(v.lease_time, 86400)],
            ['dns_servers', dns.length ? list(dns.slice(0, 2).map(q)) : undefined],
          ]),
          blk('pool', [a([['start_address', q(v.dhcp_start)], ['end_address', q(v.dhcp_end)]], '    ')], '  '),
        ]),
        `output "network_id" {\n  value = vcd_network_isolated_v2.this.id\n}`,
      ].join('\n\n');
      return { hcl, findings };
    },
  }),

  // vApp + VMs ----------------------------------------------------------------
  scenario('vcd', {
    id: 'vcd_vapp_vms',
    label: 'vApp + VMs from a catalog template',
    description:
      'A vApp attached to an existing org VDC network, and one or more VMs in it from a catalog template: CPU/memory or a sizing policy, a NIC with POOL, DHCP or MANUAL addressing, and guest customization with the admin password as a sensitive variable.',
    inputs: [
      ORG_INPUT,
      VDC_INPUT,
      { id: 'vapp_name', label: 'vApp name', control: 'text', default: 'app-tier' },
      { id: 'vapp_description', label: 'vApp description', control: 'text', default: 'Application tier' },
      {
        id: 'vms',
        label: 'VMs',
        control: 'textarea',
        default: 'app-01 = 10.10.10.21\napp-02 = 10.10.10.22',
        hint: 'One per line: name, or name = IP. The IP is used only with MANUAL allocation.',
      },
      ...vmInputs(),
    ],
    emits: ['vcd_vapp', 'vcd_vapp_org_network', 'vcd_vapp_vm'],
    body: (v) => {
      const findings: Finding[] = [];
      const vms = lines(v.vms).map(keyValue);
      if (vms.length === 0) findings.push(error('terraform.vcd_vapp_vms.no-vms', 'List at least one VM.', { path: 'vms' }));
      if (v.ip_mode === 'MANUAL' && vms.some(([, ip]) => !ip)) {
        findings.push(error('terraform.vcd_vapp_vms.manual-ip', 'MANUAL allocation needs an IP for every VM (name = IP).', { path: 'vms' }));
      }
      const [netData] = orgNetworkLookup(v);
      const hcl = [
        vdcLookup(v),
        netData,
        templateLookup(v),
        ...vmDataSources(v),
        blk('resource "vcd_vapp" "this"', [
          a([['org', q(v.org)], ['vdc', 'data.vcd_org_vdc.this.name'], ['name', q(v.vapp_name)], ['description', q(v.vapp_description)], ['power_on', on(v.power_on)]]),
        ]),
        blk('resource "vcd_vapp_org_network" "this"', [
          a([
            ['org', q(v.org)],
            ['vdc', 'data.vcd_org_vdc.this.name'],
            ['vapp_name', 'vcd_vapp.this.name'],
            ['org_network_name', orgNetworkLookup(v)[1]],
            ['reboot_vapp_on_removal', true],
          ]),
        ]),
        blk('locals', [
          blk('vms =', [a(vms.map(([name, ip]) => [q(name), q(ip)] as const), '    ')], '  '),
        ]),
        ...(on(v.customize) ? [sensitiveVariable('vm_admin_password', 'Guest OS administrator password set by customization')] : []),
        blk('resource "vcd_vapp_vm" "this"', [
          a([['for_each', 'local.vms']]),
          a([
            ['org', q(v.org)],
            ['vdc', 'data.vcd_org_vdc.this.name'],
            ['vapp_name', 'vcd_vapp.this.name'],
            ['name', 'each.key'],
            ['computer_name', 'each.key'],
            ['vapp_template_id', 'data.vcd_catalog_vapp_template.this.id'],
          ]),
          ...vmBody(v, 'vcd_vapp_org_network.this.org_network_name', 'each.value'),
        ]),
        `output "vm_ips" {\n  value = { for name, vm in vcd_vapp_vm.this : name => vm.network[0].ip }\n}`,
      ].join('\n\n');
      return { hcl, findings };
    },
  }),

  // Standalone VM -------------------------------------------------------------
  scenario('vcd', {
    id: 'vcd_standalone_vm',
    label: 'Standalone VM from a catalog template',
    description:
      'A standalone VM (vcd_vm, no vApp to manage) from a catalog template on an existing org VDC network, with guest customization and an optional extra data disk.',
    inputs: [
      ORG_INPUT,
      VDC_INPUT,
      { id: 'vm_name', label: 'VM name', control: 'text', default: 'jump-01' },
      { id: 'description', label: 'Description', control: 'text', default: 'Administration jump host' },
      { id: 'ip', label: 'IP address', control: 'text', default: '10.10.10.30', hint: 'Used with MANUAL allocation', showWhen: { input: 'ip_mode', equals: ['MANUAL'] } },
      ...vmInputs(),
      { id: 'data_disk', label: 'Add a data disk', control: 'toggle', default: false },
      { id: 'data_disk_gb', label: 'Data disk size', control: 'number', default: 100, min: 1, hint: 'GB', showWhen: { input: 'data_disk', equals: ['true'] } },
      {
        id: 'data_disk_bus',
        label: 'Disk controller',
        control: 'select',
        options: [
          { value: 'paravirtual', label: 'Paravirtual SCSI' },
          { value: 'sas', label: 'LSI Logic SAS' },
          { value: 'nvme', label: 'NVMe' },
          { value: 'sata', label: 'SATA' },
        ],
        default: 'paravirtual',
        showWhen: { input: 'data_disk', equals: ['true'] },
      },
    ],
    emits: ['vcd_vm', 'vcd_vm_internal_disk'],
    body: (v) => {
      const [netData, netName] = orgNetworkLookup(v);
      const hcl = [
        vdcLookup(v),
        netData,
        templateLookup(v),
        ...vmDataSources(v),
        ...(on(v.customize) ? [sensitiveVariable('vm_admin_password', 'Guest OS administrator password set by customization')] : []),
        blk('resource "vcd_vm" "this"', [
          a([
            ['org', q(v.org)],
            ['vdc', 'data.vcd_org_vdc.this.name'],
            ['name', q(v.vm_name)],
            ['computer_name', q(v.vm_name)],
            ['description', q(v.description)],
            ['vapp_template_id', 'data.vcd_catalog_vapp_template.this.id'],
          ]),
          ...vmBody(v, netName, q(v.ip)),
        ]),
        ...(on(v.data_disk)
          ? [
              // Bus 1 keeps the data disk off the template's boot controller.
              blk('resource "vcd_vm_internal_disk" "data"', [
                a([
                  ['org', q(v.org)],
                  ['vdc', 'data.vcd_org_vdc.this.name'],
                  ['vapp_name', 'vcd_vm.this.vapp_name'],
                  ['vm_name', 'vcd_vm.this.name'],
                  ['bus_type', q(v.data_disk_bus)],
                  ['bus_number', 1],
                  ['unit_number', 0],
                  ['size_in_mb', n(v.data_disk_gb, 100) * 1024],
                  ['allow_vm_reboot', true],
                ]),
              ]),
            ]
          : []),
        `output "vm_ip" {\n  value = vcd_vm.this.network[0].ip\n}`,
      ].join('\n\n');
      return hcl;
    },
  }),

  // Catalog + uploads ---------------------------------------------------------
  scenario('vcd', {
    id: 'vcd_catalog_uploads',
    label: 'Catalog + vApp template + ISO upload',
    description:
      'A catalog on a chosen storage policy, optionally published externally and shared read-only with every organization, with a vApp template uploaded from an OVF URL or local OVA and an ISO media file; optionally also a subscription to another site’s published catalog.',
    inputs: [
      ORG_INPUT,
      { id: 'catalog_name', label: 'Catalog name', control: 'text', default: 'tenant-a-catalog' },
      { id: 'catalog_description', label: 'Description', control: 'text', default: 'Golden images and install media' },
      { id: 'storage_vdc', label: 'Storage policy VDC', control: 'text', default: '', hint: 'Blank = org default storage', section: 'Storage' },
      { id: 'storage_profile', label: 'Storage policy', control: 'text', default: 'Gold', hint: 'In that VDC (looked up)', section: 'Storage' },
      { id: 'publish', label: 'Publish externally', control: 'toggle', default: false, hint: 'Other sites can subscribe' },
      { id: 'cache_enabled', label: 'Pre-export items', control: 'toggle', default: true, showWhen: { input: 'publish', equals: ['true'] } },
      { id: 'publish_protected', label: 'Protect with a password', control: 'toggle', default: true, hint: 'var.catalog_publish_protected', showWhen: { input: 'publish', equals: ['true'] } },
      {
        id: 'share',
        label: 'Share',
        control: 'select',
        options: [
          { value: 'none', label: 'Not shared' },
          { value: 'all_orgs', label: 'Read-only with every organization' },
          { value: 'everyone', label: 'Read-only with everyone in this org' },
        ],
        default: 'none',
      },
      { id: 'template', label: 'Upload a vApp template', control: 'toggle', default: true },
      { id: 'template_name', label: 'Template name', control: 'text', default: 'ubuntu-22.04-server', showWhen: { input: 'template', equals: ['true'] } },
      {
        id: 'template_source',
        label: 'Template source',
        control: 'select',
        options: [
          { value: 'url', label: 'OVF URL (Cloud Director fetches it)' },
          { value: 'file', label: 'Local OVA file (uploaded by Terraform)' },
        ],
        default: 'url',
        showWhen: { input: 'template', equals: ['true'] },
      },
      { id: 'ovf_url', label: 'OVF URL', control: 'text', default: 'https://images.example.com/ubuntu-22.04/ubuntu-22.04-server.ovf', showWhen: { input: 'template_source', equals: ['url'] } },
      { id: 'ova_path', label: 'OVA path', control: 'text', default: './images/ubuntu-22.04-server.ova', showWhen: { input: 'template_source', equals: ['file'] } },
      { id: 'media', label: 'Upload an ISO', control: 'toggle', default: true },
      { id: 'media_name', label: 'Media name', control: 'text', default: 'ubuntu-22.04-live-server', showWhen: { input: 'media', equals: ['true'] } },
      { id: 'media_path', label: 'ISO path', control: 'text', default: './iso/ubuntu-22.04.4-live-server-amd64.iso', showWhen: { input: 'media', equals: ['true'] } },
      { id: 'subscribe', label: 'Also subscribe to a remote catalog', control: 'toggle', default: false, section: 'Subscription' },
      { id: 'sub_name', label: 'Subscribed catalog name', control: 'text', default: 'provider-images', showWhen: { input: 'subscribe', equals: ['true'] }, section: 'Subscription' },
      {
        id: 'sub_url',
        label: 'Subscription URL',
        control: 'text',
        default: 'https://vcd-site2.example.com/vcsp/lib/0f7d2e1c-1111-2222-3333-444455556666/',
        showWhen: { input: 'subscribe', equals: ['true'] },
        section: 'Subscription',
      },
      { id: 'sub_local_copy', label: 'Keep a local copy', control: 'toggle', default: false, showWhen: { input: 'subscribe', equals: ['true'] }, section: 'Subscription' },
    ],
    emits: ['vcd_catalog', 'vcd_catalog_access_control', 'vcd_catalog_vapp_template', 'vcd_catalog_media', 'vcd_subscribed_catalog'],
    body: (v) => {
      const storageVdc = String(v.storage_vdc ?? '').trim();
      const publish = on(v.publish);
      const out: string[] = [];
      if (storageVdc) {
        out.push(`data "vcd_storage_profile" "this" {\n${a([['org', q(v.org)], ['vdc', q(storageVdc)], ['name', q(v.storage_profile)]])}\n}`);
      }
      if (publish && on(v.publish_protected)) out.push(sensitiveVariable('catalog_publish_protected', 'Password subscribers need for the published catalog'));
      out.push(
        blk('resource "vcd_catalog" "this"', [
          a([
            ['org', q(v.org)],
            ['name', q(v.catalog_name)],
            ['description', q(v.catalog_description)],
            ['storage_profile_id', storageVdc ? 'data.vcd_storage_profile.this.id' : undefined],
            ['publish_enabled', publish],
            ['cache_enabled', publish ? on(v.cache_enabled) : undefined],
            ['preserve_identity_information', publish ? false : undefined],
            ['password', publish && on(v.publish_protected) ? 'var.catalog_publish_protected' : undefined],
            ['delete_recursive', true],
            ['delete_force', false],
          ]),
        ]),
      );
      if (v.share !== 'none') {
        const allOrgs = v.share === 'all_orgs';
        out.push(
          blk('resource "vcd_catalog_access_control" "this"', [
            a([
              ['org', q(v.org)],
              ['catalog_id', 'vcd_catalog.this.id'],
              ['shared_with_everyone', !allOrgs],
              ['everyone_access_level', allOrgs ? undefined : '"ReadOnly"'],
              ['read_only_shared_with_all_orgs', allOrgs],
            ]),
          ]),
        );
      }
      if (on(v.template)) {
        const url = v.template_source !== 'file';
        out.push(
          blk('resource "vcd_catalog_vapp_template" "this"', [
            a([
              ['org', q(v.org)],
              ['catalog_id', 'vcd_catalog.this.id'],
              ['name', q(v.template_name)],
              ['description', url ? undefined : q(`${v.template_name} golden image`)],
              ['ovf_url', url ? q(v.ovf_url) : undefined],
              ['ova_path', url ? undefined : q(v.ova_path)],
              ['upload_piece_size', url ? undefined : 10],
            ]),
          ]),
        );
      }
      if (on(v.media)) {
        out.push(
          blk('resource "vcd_catalog_media" "this"', [
            a([
              ['org', q(v.org)],
              ['catalog_id', 'vcd_catalog.this.id'],
              ['name', q(v.media_name)],
              ['description', q(`${v.media_name} install ISO`)],
              ['media_path', q(v.media_path)],
              ['upload_piece_size', 10],
              ['show_upload_progress', false],
            ]),
          ]),
        );
      }
      if (on(v.subscribe)) {
        out.push(sensitiveVariable('subscription_password', 'Password of the remote published catalog (empty if none)'));
        out.push(
          blk('resource "vcd_subscribed_catalog" "remote"', [
            a([
              ['org', q(v.org)],
              ['name', q(v.sub_name)],
              ['subscription_url', q(v.sub_url)],
              ['subscription_password', 'var.subscription_password'],
              ['storage_profile_id', storageVdc ? 'data.vcd_storage_profile.this.id' : undefined],
              ['make_local_copy', on(v.sub_local_copy)],
              ['sync_on_refresh', true],
              ['delete_recursive', true],
              ['delete_force', false],
            ]),
          ]),
        );
      }
      out.push(`output "catalog_id" {\n  value = vcd_catalog.this.id\n}`);
      return out.join('\n\n');
    },
  }),

  // VDC group + distributed firewall -------------------------------------------
  scenario('vcd', {
    id: 'vcd_vdc_group_dfw',
    label: 'VDC group + distributed firewall',
    description:
      'A VDC group spanning one or more VDCs with the distributed firewall on, dynamic security groups by VM name or tag, custom application port profiles, optional IP sets on the group’s edge gateway, and an ordered DFW rule set ending in a default deny.',
    inputs: [
      ORG_INPUT,
      { id: 'group_name', label: 'VDC group name', control: 'text', default: 'tenant-a-group' },
      { id: 'starting_vdc', label: 'Starting VDC', control: 'text', default: 'tenant-a-vdc-01', hint: 'Existing (looked up)' },
      { id: 'other_vdcs', label: 'Other participating VDCs', control: 'text', default: 'tenant-a-vdc-02', hint: 'Comma separated; may be empty' },
      {
        id: 'security_groups',
        label: 'Security groups',
        control: 'textarea',
        default: 'web, VM_NAME, STARTS_WITH, web-\napp, VM_NAME, STARTS_WITH, app-\ndb, VM_TAG, EQUALS, tier-db',
        hint: 'One per line: name, VM_NAME|VM_TAG, EQUALS|CONTAINS|STARTS_WITH|ENDS_WITH, value',
      },
      {
        id: 'port_profiles',
        label: 'Custom app port profiles',
        control: 'textarea',
        default: 'app-8080, TCP, 8080\npostgres, TCP, 5432',
        hint: 'One per line: name, TCP|UDP, ports (space separated, ranges like 8000-8100)',
      },
      { id: 'ip_sets_enabled', label: 'IP sets on the group edge gateway', control: 'toggle', default: false, hint: 'Needs an edge gateway owned by the group' },
      { id: 'edge_gateway', label: 'Edge gateway', control: 'text', default: 'tenant-a-edge-01', showWhen: { input: 'ip_sets_enabled', equals: ['true'] } },
      {
        id: 'ip_sets',
        label: 'IP sets',
        control: 'textarea',
        default: 'admin-net, 198.51.100.0/24\nmonitoring, 10.0.5.10 10.0.5.11',
        hint: 'One per line: name, IPs/CIDRs/ranges (space separated)',
        showWhen: { input: 'ip_sets_enabled', equals: ['true'] },
      },
      {
        id: 'rules',
        label: 'DFW rules',
        control: 'textarea',
        default: 'web-to-app, ALLOW, web, app, app-8080\napp-to-db, ALLOW, app, db, postgres\nssh-admin, ALLOW, any, web app db, SSH\ndefault-deny, DROP, any, any, any',
        hint: 'One per line, in order: name, ALLOW|DROP|REJECT, sources, destinations, services. Sources/destinations: any, or space-separated group or IP set names. Services: any, or custom/system profile names (SSH, HTTPS…).',
      },
      { id: 'remove_default_rule', label: 'Remove the default allow rule', control: 'toggle', default: true, section: 'Advanced' },
    ],
    emits: ['vcd_vdc_group', 'vcd_nsxt_dynamic_security_group', 'vcd_nsxt_app_port_profile', 'vcd_nsxt_ip_set', 'vcd_nsxt_distributed_firewall'],
    body: (v) => {
      const findings: Finding[] = [];
      const others = items(v.other_vdcs);
      const otherIds = uniqueIdents(others);
      const out: string[] = [
        `data "vcd_org_vdc" "starting" {\n${a([['org', q(v.org)], ['name', q(v.starting_vdc)]])}\n}`,
        ...others.map((name, i) => `data "vcd_org_vdc" "${otherIds[i]}" {\n${a([['org', q(v.org)], ['name', q(name)]])}\n}`),
        blk('resource "vcd_vdc_group" "this"', [
          a([
            ['org', q(v.org)],
            ['name', q(v.group_name)],
            ['starting_vdc_id', 'data.vcd_org_vdc.starting.id'],
            ['participating_vdc_ids', list(['data.vcd_org_vdc.starting.id', ...otherIds.map((id) => `data.vcd_org_vdc.${id}.id`)])],
            ['dfw_enabled', true],
            ['default_policy_status', true],
            ['remove_default_firewall_rule', on(v.remove_default_rule)],
          ]),
        ]),
      ];
      // Names the rules can refer to, mapped to the HCL reference of their ID.
      const groups = new Map<string, string>();
      const services = new Map<string, string>();
      const sgRows = lines(v.security_groups).map(fields);
      const sgIds = uniqueIdents(sgRows.map((f) => f[0] ?? 'group'));
      sgRows.forEach(([name, type, operator, value], i) => {
        const id = sgIds[i] as string;
        if (!name || !value) {
          findings.push(error('terraform.vcd_vdc_group_dfw.group', `Security group line "${name ?? ''}" needs name, type, operator and value.`, { path: 'security_groups' }));
          return;
        }
        groups.set(name, `vcd_nsxt_dynamic_security_group.${id}.id`);
        out.push(
          blk(`resource "vcd_nsxt_dynamic_security_group" "${id}"`, [
            a([['org', q(v.org)], ['vdc_group_id', 'vcd_vdc_group.this.id'], ['name', q(name)]]),
            blk('criteria', [
              blk('rule', [a([['type', q(String(type ?? 'VM_NAME').toUpperCase())], ['operator', q(String(operator ?? 'EQUALS').toUpperCase())], ['value', q(value)]], '      ')], '    '),
            ], '  '),
          ]),
        );
      });
      const ppRows = lines(v.port_profiles).map(fields);
      const ppIds = uniqueIdents(ppRows.map((f) => f[0] ?? 'profile'));
      ppRows.forEach(([name, protocol, ports], i) => {
        const id = ppIds[i] as string;
        if (!name) return;
        services.set(name, `vcd_nsxt_app_port_profile.${id}.id`);
        const proto = String(protocol ?? 'TCP').toUpperCase();
        const portList = String(ports ?? '').split(/\s+/).filter(Boolean);
        out.push(
          blk(`resource "vcd_nsxt_app_port_profile" "${id}"`, [
            a([['org', q(v.org)], ['context_id', 'vcd_vdc_group.this.id'], ['scope', '"TENANT"'], ['name', q(name)]]),
            blk('app_port', [a([['protocol', q(proto)], ['port', portList.length ? list(portList.map(q)) : undefined]], '    ')], '  '),
          ]),
        );
      });
      if (on(v.ip_sets_enabled)) {
        out.push(`data "vcd_nsxt_edgegateway" "group" {\n${a([['org', q(v.org)], ['owner_id', 'vcd_vdc_group.this.id'], ['name', q(v.edge_gateway)]])}\n}`);
        const ipRows = lines(v.ip_sets).map(fields);
        const ipIds = uniqueIdents(ipRows.map((f) => f[0] ?? 'ipset'));
        ipRows.forEach(([name, addresses], i) => {
          const id = `ipset_${ipIds[i]}`;
          if (!name) return;
          groups.set(name, `vcd_nsxt_ip_set.${id}.id`);
          out.push(
            blk(`resource "vcd_nsxt_ip_set" "${id}"`, [
              a([
                ['org', q(v.org)],
                ['edge_gateway_id', 'data.vcd_nsxt_edgegateway.group.id'],
                ['name', q(name)],
                ['ip_addresses', list(String(addresses ?? '').split(/\s+/).filter(Boolean).map(q))],
              ]),
            ]),
          );
        });
      }
      const systemProfiles = new Map<string, string>();
      const resolve = (value: string | undefined, known: Map<string, string>, what: string, system: boolean): string[] | null => {
        const names = String(value ?? 'any').split(/\s+/).filter(Boolean);
        if (names.length === 0 || names.some((x) => x.toLowerCase() === 'any')) return [];
        return names.map((x) => {
          const ref = known.get(x);
          if (ref) return ref;
          if (system) {
            const pid = `system_${ident(x)}`;
            systemProfiles.set(pid, x);
            return `data.vcd_nsxt_app_port_profile.${pid}.id`;
          }
          findings.push(warning('terraform.vcd_vdc_group_dfw.unknown', `DFW rule refers to ${what} "${x}", which is not defined here.`, { path: 'rules' }));
          return q(x);
        });
      };
      const rules = lines(v.rules).map(fields).flatMap(([name, action, sources, destinations, svc]) => {
        const act = String(action ?? '').toUpperCase();
        if (!FIREWALL_ACTIONS.has(act)) {
          findings.push(error('terraform.vcd_vdc_group_dfw.action', `DFW rule "${name}": action must be ALLOW, DROP or REJECT.`, { path: 'rules' }));
          return [];
        }
        const src = resolve(sources, groups, 'group', false) ?? [];
        const dst = resolve(destinations, groups, 'group', false) ?? [];
        const apps = resolve(svc, services, 'profile', true) ?? [];
        return [
          blk('rule', [
            a(
              [
                ['name', q(name)],
                ['action', q(act)],
                ['direction', '"IN_OUT"'],
                ['ip_protocol', '"IPV4_IPV6"'],
                ['source_ids', src.length ? list(src) : undefined],
                ['destination_ids', dst.length ? list(dst) : undefined],
                ['app_port_profile_ids', apps.length ? list(apps) : undefined],
                ['logging', act !== 'ALLOW'],
              ],
              '    ',
            ),
          ], '  '),
        ];
      });
      for (const [pid, name] of systemProfiles) {
        out.push(`data "vcd_nsxt_app_port_profile" "${pid}" {\n${a([['scope', '"SYSTEM"'], ['name', q(name)]])}\n}`);
      }
      if (rules.length === 0) {
        findings.push(error('terraform.vcd_vdc_group_dfw.no-rules', 'The distributed firewall needs at least one rule.', { path: 'rules' }));
      } else {
        out.push(
          `# Owns the whole DFW rule set of the VDC group, evaluated top to bottom.\n` +
            blk('resource "vcd_nsxt_distributed_firewall" "this"', [a([['org', q(v.org)], ['vdc_group_id', 'vcd_vdc_group.this.id']]), ...rules]),
        );
      }
      out.push(`output "vdc_group_id" {\n  value = vcd_vdc_group.this.id\n}`);
      return { hcl: out.join('\n\n'), findings };
    },
  }),

  // IPsec VPN -----------------------------------------------------------------
  scenario('vcd', {
    id: 'vcd_nsxt_ipsec_vpn',
    label: 'IPsec VPN tunnel on an NSX-T edge gateway',
    description:
      'A policy-based IPsec site-to-site tunnel on an existing NSX-T edge gateway, authenticated with a pre-shared key held in a sensitive variable, with the default or a custom IKE/tunnel security profile.',
    inputs: [
      ORG_INPUT,
      VDC_INPUT,
      { id: 'edge_gateway', label: 'Edge gateway', control: 'text', default: 'tenant-a-edge-01', hint: 'Existing (looked up)' },
      { id: 'tunnel_name', label: 'Tunnel name', control: 'text', default: 'to-dc-london' },
      { id: 'local_ip', label: 'Local endpoint IP', control: 'text', default: '203.0.113.12', hint: 'Sub-allocated to the edge gateway' },
      { id: 'local_networks', label: 'Local networks', control: 'text', default: '10.10.10.0/24, 10.20.20.0/24', hint: 'CIDRs, comma separated' },
      { id: 'remote_ip', label: 'Remote endpoint IP', control: 'text', default: '198.51.100.20' },
      { id: 'remote_id', label: 'Remote ID', control: 'text', default: '', hint: 'Blank = remote endpoint IP' },
      { id: 'remote_networks', label: 'Remote networks', control: 'text', default: '192.168.100.0/24', hint: 'CIDRs, comma separated' },
      { id: 'logging', label: 'Logging', control: 'toggle', default: false },
      {
        id: 'profile',
        label: 'Security profile',
        control: 'select',
        options: [
          { value: 'default', label: 'Default (NSX-T recommended)' },
          { value: 'custom', label: 'Custom — match the peer' },
        ],
        default: 'default',
      },
      {
        id: 'ike_version',
        label: 'IKE version',
        control: 'select',
        options: [
          { value: 'IKE_V2', label: 'IKEv2' },
          { value: 'IKE_V1', label: 'IKEv1' },
          { value: 'IKE_FLEX', label: 'Flex (v1 or v2)' },
        ],
        default: 'IKE_V2',
        showWhen: { input: 'profile', equals: ['custom'] },
      },
      {
        id: 'encryption',
        label: 'Encryption',
        control: 'select',
        options: [
          { value: 'AES_256', label: 'AES-256' },
          { value: 'AES_128', label: 'AES-128' },
          { value: 'AES_GCM_256', label: 'AES-GCM-256' },
          { value: 'AES_GCM_128', label: 'AES-GCM-128' },
        ],
        default: 'AES_256',
        showWhen: { input: 'profile', equals: ['custom'] },
      },
      {
        id: 'digest',
        label: 'Digest',
        control: 'select',
        options: [
          { value: 'SHA2_256', label: 'SHA2-256' },
          { value: 'SHA2_384', label: 'SHA2-384' },
          { value: 'SHA2_512', label: 'SHA2-512' },
          { value: 'SHA1', label: 'SHA1 (legacy)' },
        ],
        default: 'SHA2_256',
        showWhen: { input: 'profile', equals: ['custom'] },
      },
      {
        id: 'dh_group',
        label: 'Diffie-Hellman group',
        control: 'select',
        options: ['GROUP14', 'GROUP15', 'GROUP16', 'GROUP19', 'GROUP20', 'GROUP21', 'GROUP5', 'GROUP2'].map((g) => ({ value: g, label: g })),
        default: 'GROUP14',
        showWhen: { input: 'profile', equals: ['custom'] },
      },
      { id: 'ike_lifetime', label: 'IKE SA lifetime', control: 'number', default: 86400, hint: 'seconds', showWhen: { input: 'profile', equals: ['custom'] } },
      { id: 'tunnel_lifetime', label: 'Tunnel SA lifetime', control: 'number', default: 3600, hint: 'seconds', showWhen: { input: 'profile', equals: ['custom'] } },
      { id: 'pfs', label: 'Perfect forward secrecy', control: 'toggle', default: true, showWhen: { input: 'profile', equals: ['custom'] } },
      { id: 'dpd', label: 'DPD probe interval', control: 'number', default: 30, min: 3, max: 60, hint: 'seconds', showWhen: { input: 'profile', equals: ['custom'] } },
    ],
    emits: ['vcd_nsxt_ipsec_vpn_tunnel'],
    body: (v) => {
      const custom = v.profile === 'custom';
      // AES-GCM carries its own integrity check, so no separate tunnel digest.
      const gcm = String(v.encryption).startsWith('AES_GCM');
      const profile = custom
        ? blk('security_profile_customization', [
            a(
              [
                ['ike_version', q(v.ike_version)],
                ['ike_encryption_algorithms', list([q(v.encryption)])],
                ['ike_digest_algorithms', gcm ? undefined : list([q(v.digest)])],
                ['ike_dh_groups', list([q(v.dh_group)])],
                ['ike_sa_lifetime', n(v.ike_lifetime, 86400)],
                ['tunnel_pfs_enabled', on(v.pfs)],
                ['tunnel_df_policy', '"COPY"'],
                ['tunnel_encryption_algorithms', list([q(v.encryption)])],
                ['tunnel_digest_algorithms', gcm ? undefined : list([q(v.digest)])],
                ['tunnel_dh_groups', list([q(v.dh_group)])],
                ['tunnel_sa_lifetime', n(v.tunnel_lifetime, 3600)],
                ['dpd_probe_internal', n(v.dpd, 30)],
              ],
              '    ',
            ),
          ], '  ')
        : undefined;
      return [
        vdcLookup(v),
        edgeLookup(v),
        sensitiveVariable('ipsec_psk', 'Pre-shared key agreed with the remote peer'),
        blk('resource "vcd_nsxt_ipsec_vpn_tunnel" "this"', [
          a([
            ['org', q(v.org)],
            ['edge_gateway_id', 'data.vcd_nsxt_edgegateway.this.id'],
            ['name', q(v.tunnel_name)],
            ['description', q(`Site-to-site to ${v.remote_ip}`)],
            ['enabled', true],
            ['authentication_mode', '"PSK"'],
            ['pre_shared_key', 'var.ipsec_psk'],
            ['local_ip_address', q(v.local_ip)],
            ['local_networks', qlist(v.local_networks)],
            ['remote_ip_address', q(v.remote_ip)],
            ['remote_id', String(v.remote_id ?? '').trim() ? q(v.remote_id) : undefined],
            ['remote_networks', qlist(v.remote_networks)],
            ['logging', on(v.logging)],
          ]),
          profile,
        ]),
        `output "tunnel_id" {\n  value = vcd_nsxt_ipsec_vpn_tunnel.this.id\n}`,
      ].join('\n\n');
    },
  }),

  // Avi load balancing ----------------------------------------------------------
  scenario('vcd', {
    id: 'vcd_nsxt_alb_virtual_service',
    label: 'Load balancer (Avi): pool + virtual service on an edge gateway',
    description:
      'An Avi (NSX Advanced Load Balancer) pool of servers with health monitoring and persistence, and a virtual service on the edge gateway’s VIP. Optionally, as the provider, activates load balancing on the edge gateway and assigns it a Service Engine group first.',
    inputs: [
      ORG_INPUT,
      VDC_INPUT,
      { id: 'edge_gateway', label: 'Edge gateway', control: 'text', default: 'tenant-a-edge-01', hint: 'Existing (looked up)' },
      { id: 'se_group', label: 'Service Engine group', control: 'text', default: 'seg-shared-01', hint: 'As assigned to the edge gateway' },
      { id: 'activate', label: 'Activate ALB and assign the SE group', control: 'toggle', default: false, hint: 'Provider step; needs a system administrator' },
      {
        id: 'feature_set',
        label: 'Feature set',
        control: 'select',
        options: [
          { value: 'STANDARD', label: 'Standard' },
          { value: 'PREMIUM', label: 'Premium' },
        ],
        default: 'STANDARD',
        showWhen: { input: 'activate', equals: ['true'] },
      },
      { id: 'max_vs', label: 'Max virtual services', control: 'number', default: 20, min: 1, showWhen: { input: 'activate', equals: ['true'] } },
      { id: 'reserved_vs', label: 'Reserved virtual services', control: 'number', default: 10, min: 0, showWhen: { input: 'activate', equals: ['true'] } },
      { id: 'pool_name', label: 'Pool name', control: 'text', default: 'web-pool' },
      { id: 'members', label: 'Pool members', control: 'textarea', default: '10.10.10.11\n10.10.10.12\n10.10.10.13', hint: 'One IP per line, optionally ip:port' },
      { id: 'default_port', label: 'Member port', control: 'number', default: 80, min: 1, max: 65535 },
      {
        id: 'algorithm',
        label: 'Algorithm',
        control: 'select',
        options: ['LEAST_CONNECTIONS', 'ROUND_ROBIN', 'CONSISTENT_HASH', 'FASTEST_RESPONSE', 'LEAST_LOAD', 'FEWEST_SERVERS', 'RANDOM', 'FEWEST_TASKS', 'CORE_AFFINITY'].map((x) => ({ value: x, label: x })),
        default: 'LEAST_CONNECTIONS',
      },
      {
        id: 'health_monitor',
        label: 'Health monitor',
        control: 'select',
        options: ['HTTP', 'HTTPS', 'TCP', 'UDP', 'PING'].map((x) => ({ value: x, label: x })),
        default: 'HTTP',
      },
      {
        id: 'persistence',
        label: 'Persistence',
        control: 'select',
        options: [
          { value: 'none', label: 'None' },
          { value: 'CLIENT_IP', label: 'Client IP' },
          { value: 'HTTP_COOKIE', label: 'HTTP cookie' },
          { value: 'TLS', label: 'TLS' },
        ],
        default: 'none',
      },
      { id: 'vs_name', label: 'Virtual service name', control: 'text', default: 'web-vs' },
      { id: 'vip', label: 'Virtual IP', control: 'text', default: '203.0.113.15', hint: 'Sub-allocated to the edge gateway' },
      {
        id: 'app_profile',
        label: 'Application profile',
        control: 'select',
        options: [
          { value: 'HTTP', label: 'HTTP' },
          { value: 'HTTPS', label: 'HTTPS (TLS terminated on Avi)' },
          { value: 'L4', label: 'L4 (TCP)' },
          { value: 'L4_TLS', label: 'L4 TLS' },
        ],
        default: 'HTTP',
      },
      { id: 'service_port', label: 'Service port', control: 'number', default: 80, min: 1, max: 65535 },
      { id: 'certificate', label: 'Certificate alias', control: 'text', default: 'www-example-com', hint: 'In the org certificate library', showWhen: { input: 'app_profile', equals: ['HTTPS', 'L4_TLS'] } },
    ],
    emits: ['vcd_nsxt_alb_settings', 'vcd_nsxt_alb_edgegateway_service_engine_group', 'vcd_nsxt_alb_pool', 'vcd_nsxt_alb_virtual_service'],
    body: (v) => {
      const activate = on(v.activate);
      const tls = v.app_profile === 'HTTPS' || v.app_profile === 'L4_TLS';
      const members = lines(v.members).map((m) => {
        const [ip, port] = m.split(':').map((s) => s.trim());
        return blk('member', [a([['ip_address', q(ip)], ['port', port ? n(port, 80) : undefined], ['enabled', true]], '    ')], '  ');
      });
      const out: string[] = [vdcLookup(v), edgeLookup(v)];
      let seg: string;
      if (activate) {
        out.push(
          `data "vcd_nsxt_alb_service_engine_group" "this" {\n${a([['name', q(v.se_group)]])}\n}`,
          blk('resource "vcd_nsxt_alb_settings" "this"', [
            a([
              ['org', q(v.org)],
              ['edge_gateway_id', 'data.vcd_nsxt_edgegateway.this.id'],
              ['is_active', true],
              ['supported_feature_set', q(v.feature_set)],
            ]),
          ]),
          blk('resource "vcd_nsxt_alb_edgegateway_service_engine_group" "this"', [
            a([
              ['org', q(v.org)],
              ['edge_gateway_id', 'vcd_nsxt_alb_settings.this.edge_gateway_id'],
              ['service_engine_group_id', 'data.vcd_nsxt_alb_service_engine_group.this.id'],
              ['max_virtual_services', n(v.max_vs, 20)],
              ['reserved_virtual_services', n(v.reserved_vs, 10)],
            ]),
          ]),
        );
        seg = 'vcd_nsxt_alb_edgegateway_service_engine_group.this.service_engine_group_id';
      } else {
        out.push(
          `data "vcd_nsxt_alb_edgegateway_service_engine_group" "this" {\n${a([
            ['org', q(v.org)],
            ['edge_gateway_id', 'data.vcd_nsxt_edgegateway.this.id'],
            ['service_engine_group_name', q(v.se_group)],
          ])}\n}`,
        );
        seg = 'data.vcd_nsxt_alb_edgegateway_service_engine_group.this.service_engine_group_id';
      }
      if (tls) out.push(`data "vcd_library_certificate" "this" {\n${a([['org', q(v.org)], ['alias', q(v.certificate)]])}\n}`);
      out.push(
        blk('resource "vcd_nsxt_alb_pool" "this"', [
          a([
            ['org', q(v.org)],
            ['edge_gateway_id', activate ? 'vcd_nsxt_alb_settings.this.edge_gateway_id' : 'data.vcd_nsxt_edgegateway.this.id'],
            ['name', q(v.pool_name)],
            ['algorithm', q(v.algorithm)],
            ['default_port', n(v.default_port, 80)],
            ['graceful_timeout_period', 1],
            ['passive_monitoring_enabled', true],
          ]),
          ...members,
          blk('health_monitor', [a([['type', q(v.health_monitor)]], '    ')], '  '),
          v.persistence !== 'none' && blk('persistence_profile', [a([['type', q(v.persistence)]], '    ')], '  '),
        ]),
        blk('resource "vcd_nsxt_alb_virtual_service" "this"', [
          a([
            ['org', q(v.org)],
            ['edge_gateway_id', 'vcd_nsxt_alb_pool.this.edge_gateway_id'],
            ['name', q(v.vs_name)],
            ['pool_id', 'vcd_nsxt_alb_pool.this.id'],
            ['service_engine_group_id', seg],
            ['virtual_ip_address', q(v.vip)],
            ['application_profile_type', q(v.app_profile)],
            ['ca_certificate_id', tls ? 'data.vcd_library_certificate.this.id' : undefined],
            ['enabled', true],
          ]),
          blk('service_port', [
            a([['start_port', n(v.service_port, 80)], ['type', '"TCP_PROXY"'], ['ssl_enabled', tls ? true : undefined]], '    '),
          ], '  '),
        ]),
        `output "virtual_service_id" {\n  value = vcd_nsxt_alb_virtual_service.this.id\n}`,
      );
      return out.join('\n\n');
    },
  }),

  // Access control ------------------------------------------------------------
  scenario('vcd', {
    id: 'vcd_org_rbac',
    label: 'Access control: role, rights bundle, users and groups',
    description:
      'A custom tenant role, an optional rights bundle published to the organization, local users (passwords from one sensitive map variable) and groups mapped to roles, with an optional custom LDAP (Active Directory) connection for imported groups.',
    inputs: [
      ORG_INPUT,
      { id: 'role_name', label: 'Custom role', control: 'text', default: 'App Operator' },
      { id: 'role_description', label: 'Role description', control: 'text', default: 'Operates vApps and VMs; cannot change networking' },
      {
        id: 'rights',
        label: 'Role rights',
        control: 'textarea',
        default:
          'Catalog: View Private and Shared Catalogs\nOrganization vDC: View\nvApp: View VM metrics\nvApp: Power Operations\nvApp: Use Console\nvApp: Create / Reconfigure a vApp\nvApp Template / Media: View',
        hint: 'One right per line, exactly as Cloud Director names it; include any rights it implies',
      },
      { id: 'bundle', label: 'Also create a rights bundle', control: 'toggle', default: false, hint: 'Provider object; needs a system administrator' },
      { id: 'bundle_name', label: 'Rights bundle name', control: 'text', default: 'Tenant A Operations Bundle', showWhen: { input: 'bundle', equals: ['true'] } },
      {
        id: 'users',
        label: 'Local users',
        control: 'textarea',
        default: 'alice, App Operator, alice@example.com\nbob, vApp User, bob@example.com',
        hint: 'One per line: username, role, email. Passwords come from var.user_passwords["username"].',
      },
      {
        id: 'groups',
        label: 'Groups',
        control: 'textarea',
        default: 'CloudOps, Organization Administrator\nAppOwners, App Operator',
        hint: 'One per line: group name (as in the identity provider), role',
      },
      {
        id: 'group_provider',
        label: 'Group source',
        control: 'select',
        options: [
          { value: 'INTEGRATED', label: 'LDAP (INTEGRATED)' },
          { value: 'SAML', label: 'SAML' },
          { value: 'OAUTH', label: 'OIDC (OAUTH)' },
        ],
        default: 'INTEGRATED',
      },
      { id: 'ldap', label: 'Configure LDAP for this org', control: 'toggle', default: false, section: 'LDAP' },
      { id: 'ldap_server', label: 'LDAP server', control: 'text', default: 'dc01.corp.example.com', showWhen: { input: 'ldap', equals: ['true'] }, section: 'LDAP' },
      { id: 'ldap_port', label: 'Port', control: 'number', default: 636, showWhen: { input: 'ldap', equals: ['true'] }, section: 'LDAP' },
      { id: 'ldap_ssl', label: 'LDAPS', control: 'toggle', default: true, showWhen: { input: 'ldap', equals: ['true'] }, section: 'LDAP' },
      { id: 'ldap_base_dn', label: 'Search base', control: 'text', default: 'OU=Cloud,DC=corp,DC=example,DC=com', showWhen: { input: 'ldap', equals: ['true'] }, section: 'LDAP' },
      { id: 'ldap_user', label: 'Bind user', control: 'text', default: 'CN=svc-vcd,OU=Service Accounts,DC=corp,DC=example,DC=com', showWhen: { input: 'ldap', equals: ['true'] }, section: 'LDAP' },
      {
        id: 'ldap_connector',
        label: 'Directory type',
        control: 'select',
        options: [
          { value: 'ACTIVE_DIRECTORY', label: 'Active Directory' },
          { value: 'OPEN_LDAP', label: 'OpenLDAP' },
        ],
        default: 'ACTIVE_DIRECTORY',
        showWhen: { input: 'ldap', equals: ['true'] },
        section: 'LDAP',
      },
    ],
    emits: ['vcd_role', 'vcd_rights_bundle', 'vcd_org_ldap', 'vcd_org_user', 'vcd_org_group'],
    body: (v) => {
      const findings: Finding[] = [];
      const rights = lines(v.rights);
      const roleName = String(v.role_name ?? '').trim();
      // A user or group on the custom role references it, so it is created first.
      const roleRef = (role: string | undefined): string => (role && role === roleName ? 'vcd_role.this.name' : q(role));
      const out: string[] = [
        `data "vcd_org" "this" {\n${a([['name', q(v.org)]])}\n}`,
        blk('resource "vcd_role" "this"', [
          a([['org', 'data.vcd_org.this.name'], ['name', q(roleName)], ['description', q(v.role_description)], ['rights', list(rights.map(q))]]),
        ]),
      ];
      if (on(v.bundle)) {
        out.push(
          blk('resource "vcd_rights_bundle" "this"', [
            a([
              ['name', q(v.bundle_name)],
              ['description', q(`Rights published to ${v.org}`)],
              ['rights', list(rights.map(q))],
              ['publish_to_all_tenants', false],
              ['tenants', '[data.vcd_org.this.name]'],
            ]),
          ]),
        );
      }
      const ldap = on(v.ldap);
      if (ldap) {
        const ad = v.ldap_connector !== 'OPEN_LDAP';
        out.push(
          sensitiveVariable('ldap_bind_password', 'Password of the LDAP bind account'),
          blk('resource "vcd_org_ldap" "this"', [
            a([['org_id', 'data.vcd_org.this.id'], ['ldap_mode', '"CUSTOM"']]),
            blk('custom_settings', [
              a(
                [
                  ['server', q(v.ldap_server)],
                  ['port', n(v.ldap_port, 636)],
                  ['is_ssl', on(v.ldap_ssl)],
                  ['connector_type', q(v.ldap_connector)],
                  ['authentication_method', '"SIMPLE"'],
                  ['base_distinguished_name', q(v.ldap_base_dn)],
                  ['username', q(v.ldap_user)],
                  ['password', 'var.ldap_bind_password'],
                ],
                '    ',
              ),
              blk('user_attributes', [
                a(
                  [
                    ['object_class', ad ? '"user"' : '"inetOrgPerson"'],
                    ['unique_identifier', ad ? '"objectGuid"' : '"uid"'],
                    ['username', ad ? '"sAMAccountName"' : '"uid"'],
                    ['display_name', ad ? '"displayName"' : '"cn"'],
                    ['given_name', '"givenName"'],
                    ['surname', '"sn"'],
                    ['email', '"mail"'],
                    ['telephone', '"telephoneNumber"'],
                    ['group_membership_identifier', '"dn"'],
                    ['group_back_link_identifier', ad ? '"tokenGroups"' : undefined],
                  ],
                  '      ',
                ),
              ], '    '),
              blk('group_attributes', [
                a(
                  [
                    ['object_class', ad ? '"group"' : '"groupOfUniqueNames"'],
                    ['unique_identifier', ad ? '"objectGuid"' : '"cn"'],
                    ['name', '"cn"'],
                    ['membership', ad ? '"member"' : '"uniqueMember"'],
                    ['group_membership_identifier', '"dn"'],
                    ['group_back_link_identifier', ad ? '"objectSid"' : undefined],
                  ],
                  '      ',
                ),
              ], '    '),
            ], '  '),
          ]),
        );
      }
      const users = lines(v.users).map(fields);
      if (users.length > 0) {
        out.push(`variable "user_passwords" {\n  description = "Initial password per local username"\n  type        = map(string)\n  sensitive   = true\n}`);
        const ids = uniqueIdents(users.map((f) => f[0] ?? 'user'));
        users.forEach(([name, role, email], i) => {
          if (!role) findings.push(error('terraform.vcd_org_rbac.user-role', `User "${name}" needs a role.`, { path: 'users' }));
          out.push(
            blk(`resource "vcd_org_user" "${ids[i]}"`, [
              a([
                ['org', 'data.vcd_org.this.name'],
                ['name', q(String(name).toLowerCase())],
                ['role', roleRef(role)],
                ['password', `var.user_passwords[${q(String(name).toLowerCase())}]`],
                ['email_address', email ? q(email) : undefined],
                ['enabled', true],
                ['take_ownership', true],
              ]),
            ]),
          );
        });
      }
      const groups = lines(v.groups).map(fields);
      const gids = uniqueIdents(groups.map((f) => f[0] ?? 'group'));
      groups.forEach(([name, role], i) => {
        if (!role) findings.push(error('terraform.vcd_org_rbac.group-role', `Group "${name}" needs a role.`, { path: 'groups' }));
        out.push(
          blk(`resource "vcd_org_group" "group_${gids[i]}"`, [
            a([
              ['org', 'data.vcd_org.this.name'],
              ['name', q(name)],
              ['provider_type', q(v.group_provider)],
              ['role', roleRef(role)],
              ['depends_on', ldap && v.group_provider === 'INTEGRATED' ? '[vcd_org_ldap.this]' : undefined],
            ]),
          ]),
        );
      });
      if (v.group_provider === 'INTEGRATED' && groups.length > 0 && !ldap) {
        findings.push(warning('terraform.vcd_org_rbac.ldap', 'INTEGRATED groups are imported from LDAP; the org needs an LDAP connection (here or already configured).', { path: 'ldap' }));
      }
      return { hcl: out.join('\n\n'), findings };
    },
  }),

  // IP Spaces -----------------------------------------------------------------
  scenario('vcd', {
    id: 'vcd_ip_space',
    label: 'IP Space + provider gateway uplink + tenant quota',
    description:
      'A provider IP Space (public, shared services or private) with its scopes, floating IP ranges and prefixes to hand out, the uplink that attaches it to an existing IP Spaces-enabled provider gateway, and a custom quota for one organization. Run as a system administrator.',
    inputs: [
      { id: 'space_name', label: 'IP Space name', control: 'text', default: 'public-ips-01' },
      { id: 'description', label: 'Description', control: 'text', default: 'Internet-routable addresses for tenants' },
      {
        id: 'space_type',
        label: 'Type',
        control: 'select',
        options: [
          { value: 'PUBLIC', label: 'Public — every tenant' },
          { value: 'SHARED_SERVICES', label: 'Shared services' },
          { value: 'PRIVATE', label: 'Private — one tenant' },
        ],
        default: 'PUBLIC',
      },
      { id: 'owner_org', label: 'Owning organization', control: 'text', default: 'tenant-a', showWhen: { input: 'space_type', equals: ['PRIVATE'] } },
      { id: 'internal_scope', label: 'Internal scope', control: 'text', default: '203.0.113.0/24', hint: 'CIDRs this space owns, comma separated' },
      { id: 'external_scope', label: 'External scope', control: 'text', default: '0.0.0.0/0', hint: 'What it reaches through the uplink' },
      { id: 'ip_ranges', label: 'Floating IP ranges', control: 'textarea', default: '203.0.113.20-203.0.113.99', hint: 'One per line: start-end' },
      { id: 'prefixes', label: 'Prefixes to hand out', control: 'textarea', default: '203.0.113.128/28 4', hint: 'One per line: first-network/length count' },
      { id: 'range_quota', label: 'Floating IPs per org', control: 'number', default: 5, hint: '-1 = unlimited' },
      { id: 'prefix_quota', label: 'Prefixes per org', control: 'number', default: 1, hint: '-1 = unlimited' },
      { id: 'route_advertisement', label: 'Advertise routes', control: 'toggle', default: false },
      { id: 'default_snat', label: 'Default SNAT rule on edges', control: 'toggle', default: false, section: 'Default rules' },
      { id: 'default_no_snat', label: 'Default NO SNAT rule on edges', control: 'toggle', default: false, section: 'Default rules' },
      { id: 'default_firewall', label: 'Default firewall rule on edges', control: 'toggle', default: false, section: 'Default rules' },
      { id: 'uplink', label: 'Attach to a provider gateway', control: 'toggle', default: true, showWhen: { input: 'space_type', notEquals: ['PRIVATE'] } },
      { id: 'provider_gateway', label: 'Provider gateway', control: 'text', default: 'provider-gw-ipspaces-01', hint: 'Existing, IP Spaces enabled (looked up)', showWhen: { input: 'uplink', equals: ['true'] } },
      { id: 'quota', label: 'Custom quota for one org', control: 'toggle', default: false, showWhen: { input: 'space_type', equals: ['PUBLIC'] } },
      { id: 'quota_org', label: 'Organization', control: 'text', default: 'tenant-a', showWhen: { input: 'quota', equals: ['true'] } },
      { id: 'quota_ips', label: 'Its floating IPs', control: 'number', default: 20, showWhen: { input: 'quota', equals: ['true'] } },
      { id: 'quota_prefixes', label: 'Its prefixes', control: 'number', default: 2, hint: 'Of the first prefix length listed', showWhen: { input: 'quota', equals: ['true'] } },
    ],
    emits: ['vcd_ip_space', 'vcd_ip_space_uplink', 'vcd_ip_space_custom_quota'],
    body: (v) => {
      const findings: Finding[] = [];
      const type = String(v.space_type);
      const prefixRows = lines(v.prefixes).flatMap((line) => {
        const m = /^([\d.:a-fA-F]+)\/(\d+)\s+(\d+)$/.exec(line);
        if (!m) {
          findings.push(error('terraform.vcd_ip_space.prefix', `Prefix "${line}" should read first-network/length count.`, { path: 'prefixes' }));
          return [];
        }
        return [[m[1] as string, m[2] as string, m[3] as string] as const];
      });
      const out: string[] = [];
      if (type === 'PRIVATE') out.push(`data "vcd_org" "owner" {\n${a([['name', q(v.owner_org)]])}\n}`);
      const prefixLengths = [...new Set(prefixRows.map(([, len]) => len))];
      out.push(
        blk('resource "vcd_ip_space" "this"', [
          a([
            ['name', q(v.space_name)],
            ['description', q(v.description)],
            ['type', q(type)],
            ['org_id', type === 'PRIVATE' ? 'data.vcd_org.owner.id' : undefined],
            ['internal_scope', qlist(v.internal_scope)],
            ['external_scope', String(v.external_scope ?? '').trim() ? q(v.external_scope) : undefined],
            ['route_advertisement_enabled', on(v.route_advertisement)],
            ['ip_range_quota', q(String(n(v.range_quota, 0)))],
            ['default_firewall_rule_creation_enabled', on(v.default_firewall)],
            ['default_snat_rule_creation_enabled', on(v.default_snat)],
            ['default_no_snat_rule_creation_enabled', on(v.default_no_snat)],
          ]),
          ...lines(v.ip_ranges).map((range) => {
            const [start, end] = range.split('-').map((s) => s.trim());
            return blk('ip_range', [a([['start_address', q(start)], ['end_address', q(end || start)]], '    ')], '  ');
          }),
          ...prefixLengths.map((len) =>
            blk('ip_prefix', [
              a([['default_quota', q(String(n(v.prefix_quota, 0)))]], '    '),
              ...prefixRows
                .filter(([, l]) => l === len)
                .map(([first, l, count]) => blk('prefix', [a([['first_ip', q(first)], ['prefix_length', q(l)], ['prefix_count', q(count)]], '      ')], '    ')),
            ], '  '),
          ),
        ]),
      );
      if (type !== 'PRIVATE' && on(v.uplink)) {
        out.push(
          `data "vcd_external_network_v2" "provider_gateway" {\n${a([['name', q(v.provider_gateway)]])}\n}`,
          blk('resource "vcd_ip_space_uplink" "this"', [
            a([
              ['name', q(`${v.space_name}-uplink`)],
              ['description', q(`${v.space_name} on ${v.provider_gateway}`)],
              ['external_network_id', 'data.vcd_external_network_v2.provider_gateway.id'],
              ['ip_space_id', 'vcd_ip_space.this.id'],
            ]),
          ]),
        );
      }
      if (type === 'PUBLIC' && on(v.quota)) {
        const len = prefixLengths[0] ?? '28';
        out.push(
          `data "vcd_org" "quota" {\n${a([['name', q(v.quota_org)]])}\n}`,
          blk('resource "vcd_ip_space_custom_quota" "this"', [
            a([['org_id', 'data.vcd_org.quota.id'], ['ip_space_id', 'vcd_ip_space.this.id'], ['ip_range_quota', q(String(n(v.quota_ips, 0)))]]),
            blk('ip_prefix_quota', [a([['prefix_length', q(len)], ['quota', q(String(n(v.quota_prefixes, 0)))]], '    ')], '  '),
          ]),
        );
      }
      out.push(`output "ip_space_id" {\n  value = vcd_ip_space.this.id\n}`);
      return { hcl: out.join('\n\n'), findings };
    },
  }),
];
