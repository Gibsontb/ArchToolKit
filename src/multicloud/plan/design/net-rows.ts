/**
 * The networks and subnets the user builds, row by row (Landing zones on
 * Migration & Utilities, and the wizard's step 6 Foundation).
 *
 * The toolkit does not decide the network. It never creates, carves, sizes or
 * suggests a network or a subnet: every row is the user's, every closed field
 * a dropdown that starts empty, and the IPv4 base address is typed (or "next
 * free in the network", which takes the next aligned block after the rows
 * above it). An empty list means no network, and nothing is generated.
 *
 * What it does:
 * - offers each cloud's own choices (network kind, roles, subnet purposes,
 *   zones, prefix lengths) — `CLOUD_NETWORK`;
 * - resolves the rows into the design's networks and subnets — `resolveCloudNetworks`;
 * - validates them, as findings keyed to the row (`path` = `net:<cloud>:<row id>`):
 *   overlap between rows or with the on-premises ranges, a subnet outside its
 *   network, a size below the cloud's minimum or above its maximum, an Azure
 *   platform subnet smaller than Azure requires, a zonal choice on a regional
 *   cloud, a field not answered;
 * - says how many addresses each subnet leaves after the cloud's reservation;
 * - gives a read-only hint of the hosts per tier (`hostsHint`), never applied.
 *
 * Sources (checked 2026-09-26):
 * - AWS: 5 reserved addresses, subnets /16 to /28, zonal
 *   https://docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html
 * - AWS Transit Gateway: a /28 attachment subnet per zone
 *   https://docs.aws.amazon.com/vpc/latest/tgw/tgw-best-design-practices.html
 * - Azure: 5 reserved, smallest /29, regional
 *   https://learn.microsoft.com/azure/virtual-network/virtual-networks-faq
 * - Azure GatewaySubnet /27 or larger: https://learn.microsoft.com/azure/vpn-gateway/vpn-gateway-about-vpn-gateway-settings#gwsub
 * - AzureFirewallSubnet /26: https://learn.microsoft.com/azure/firewall/firewall-faq
 * - AzureBastionSubnet /26 or larger: https://learn.microsoft.com/azure/bastion/configuration-settings#subnet
 * - Google Cloud: 4 reserved, regional: https://cloud.google.com/vpc/docs/subnets
 * - Google Cloud proxy-only subnets (/26 minimum, /23 recommended): https://cloud.google.com/load-balancing/docs/proxy-only-subnets
 * - OCI: 3 reserved, regional recommended: https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/overview.htm
 * - VCF 9 NSX VPCs: https://techdocs.broadcom.com/us/en/vmware-cis/nsx/vmware-nsx/9-0/administration-guide/nsx-virtual-private-clouds.html
 */

import { error, info, warning, type Finding } from '../../../core/findings.ts';
import { overlapsAny } from '../../../core/ip.ts';
import { formatIPv4, parseCidr, parseIPv4 } from '../../../core/net.ts';
import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, GCP_ZONES, OCI_REGIONS } from '../../../kit/regions.ts';
import { nthSlash64 } from '../../../terraform/blueprints/dual-stack.ts';
import type {
  CloudNetworkPlan, Env, NetworkDesign, NetworkEnv, NetworkRole, NetworkRow, NetworkTier, Plan, PlanDecision, Platform, SubnetDesign, SubnetRow, Workload,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Each cloud's choices
// ---------------------------------------------------------------------------

export interface Choice {
  readonly value: string;
  readonly label: string;
}

export interface Purpose extends Choice {
  /** A workload tier (VMs land in it) rather than a platform subnet. */
  readonly tier?: boolean;
  /** The name the cloud requires (Azure's platform subnets). */
  readonly fixedName?: string;
  /** The largest prefix length the cloud accepts for it (the smallest size), and why. */
  readonly maxPrefix?: number;
  readonly sizeWhy?: string;
  readonly source?: string;
}

export interface CloudNetworkFacts {
  /** What the cloud calls a network. */
  readonly kind: string;
  readonly roles: readonly Choice[];
  readonly purposes: readonly Purpose[];
  /** Subnet prefix lengths the cloud accepts. */
  readonly subnetMin: number;
  readonly subnetMax: number;
  /** Network prefix lengths the cloud accepts. */
  readonly networkMin: number;
  readonly networkMax: number;
  /** Addresses the cloud reserves in every subnet. */
  readonly reserved: number;
  /** Subnets span the region (true) or sit in one zone (false). */
  readonly regional: boolean;
  readonly source: string;
}

const TIER_PURPOSES: readonly Purpose[] = [
  { value: 'web', label: 'Web tier', tier: true },
  { value: 'app', label: 'Application tier', tier: true },
  { value: 'db', label: 'Data tier', tier: true },
  { value: 'mgmt', label: 'Management (hub / shared services)', tier: true },
  { value: 'container', label: 'Containers' },
];

export const CLOUD_NETWORK: Readonly<Record<Platform, CloudNetworkFacts>> = {
  aws: {
    kind: 'VPC',
    roles: [
      { value: 'hub', label: 'Hub (network account, Transit Gateway)' },
      { value: 'spoke', label: 'Spoke (application or environment VPC)' },
      { value: 'shared-services', label: 'Shared services (endpoints, directory)' },
      { value: 'inspection', label: 'Inspection (AWS Network Firewall)' },
      { value: 'egress', label: 'Egress (NAT gateways)' },
    ],
    purposes: [
      ...TIER_PURPOSES,
      { value: 'tgw-attachment', label: 'Transit Gateway attachment', source: 'https://docs.aws.amazon.com/vpc/latest/tgw/tgw-best-design-practices.html' },
      { value: 'public', label: 'Public (NAT gateway / internet-facing load balancer)' },
      { value: 'firewall', label: 'Network Firewall endpoint' },
      { value: 'endpoints', label: 'Interface endpoints' },
    ],
    subnetMin: 16, subnetMax: 28, networkMin: 16, networkMax: 28, reserved: 5, regional: false,
    source: 'https://docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html',
  },
  azure: {
    kind: 'Virtual network (VNet)',
    roles: [
      { value: 'hub', label: 'Hub (connectivity subscription)' },
      { value: 'spoke', label: 'Spoke (landing-zone subscription)' },
      { value: 'shared-services', label: 'Shared services (identity, management)' },
    ],
    purposes: [
      ...TIER_PURPOSES,
      { value: 'GatewaySubnet', label: 'GatewaySubnet (ExpressRoute / VPN gateway)', fixedName: 'GatewaySubnet', maxPrefix: 27, sizeWhy: 'a gateway subnet must be /27 or larger', source: 'https://learn.microsoft.com/azure/vpn-gateway/vpn-gateway-about-vpn-gateway-settings#gwsub' },
      { value: 'AzureFirewallSubnet', label: 'AzureFirewallSubnet (Azure Firewall)', fixedName: 'AzureFirewallSubnet', maxPrefix: 26, sizeWhy: 'Azure Firewall needs a /26', source: 'https://learn.microsoft.com/azure/firewall/firewall-faq' },
      { value: 'AzureFirewallManagementSubnet', label: 'AzureFirewallManagementSubnet (forced tunnelling)', fixedName: 'AzureFirewallManagementSubnet', maxPrefix: 26, sizeWhy: 'the firewall management subnet must be a /26', source: 'https://learn.microsoft.com/azure/firewall/forced-tunneling' },
      { value: 'AzureBastionSubnet', label: 'AzureBastionSubnet (Azure Bastion)', fixedName: 'AzureBastionSubnet', maxPrefix: 26, sizeWhy: 'Azure Bastion needs a /26 or larger', source: 'https://learn.microsoft.com/azure/bastion/configuration-settings#subnet' },
      { value: 'private-endpoints', label: 'Private endpoints' },
      { value: 'sqlmi', label: 'Delegated: SQL Managed Instance' },
      { value: 'postgres', label: 'Delegated: PostgreSQL flexible server' },
      { value: 'mysql', label: 'Delegated: MySQL flexible server' },
      { value: 'dns-resolver', label: 'Delegated: DNS Private Resolver' },
      { value: 'aadds', label: 'Microsoft Entra Domain Services' },
      { value: 'oracle', label: 'Delegated: Oracle Database@Azure' },
      { value: 'functions', label: 'Delegated: Functions / Container Apps integration' },
      { value: 'webapp', label: 'Delegated: App Service integration' },
    ],
    subnetMin: 8, subnetMax: 29, networkMin: 8, networkMax: 29, reserved: 5, regional: true,
    source: 'https://learn.microsoft.com/azure/virtual-network/virtual-networks-faq',
  },
  google: {
    kind: 'VPC network',
    roles: [
      { value: 'hub', label: 'Hub (Shared VPC host / Network Connectivity Center)' },
      { value: 'spoke', label: 'Spoke (per environment or application)' },
      { value: 'shared-services', label: 'Shared services' },
    ],
    purposes: [
      ...TIER_PURPOSES,
      { value: 'proxy-only', label: 'Proxy-only (Envoy-based regional load balancers)', maxPrefix: 26, sizeWhy: 'a proxy-only subnet must be /26 or larger (/23 recommended)', source: 'https://cloud.google.com/load-balancing/docs/proxy-only-subnets' },
      { value: 'psc', label: 'Private Service Connect' },
    ],
    subnetMin: 8, subnetMax: 29, networkMin: 8, networkMax: 29, reserved: 4, regional: true,
    source: 'https://cloud.google.com/vpc/docs/subnets',
  },
  oci: {
    kind: 'Virtual cloud network (VCN)',
    roles: [
      { value: 'hub', label: 'Hub VCN (DRG, Network Firewall)' },
      { value: 'spoke', label: 'Spoke VCN' },
      { value: 'shared-services', label: 'Shared services' },
    ],
    purposes: [
      ...TIER_PURPOSES,
      { value: 'public', label: 'Public (load balancer / internet-facing)' },
      { value: 'firewall', label: 'Network Firewall (hub)' },
      { value: 'lb', label: 'Load balancer (private)' },
    ],
    subnetMin: 16, subnetMax: 30, networkMin: 16, networkMax: 30, reserved: 3, regional: true,
    source: 'https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/overview.htm',
  },
  vmware: {
    kind: 'NSX VPC',
    roles: [
      { value: 'spoke', label: 'Project VPC' },
      { value: 'shared-services', label: 'Shared services VPC' },
    ],
    purposes: [
      ...TIER_PURPOSES,
      { value: 'vpc-public', label: 'VPC subnet: public' },
      { value: 'vpc-private', label: 'VPC subnet: private' },
      { value: 'vpc-private-tgw', label: 'VPC subnet: private, through the transit gateway' },
    ],
    subnetMin: 16, subnetMax: 30, networkMin: 8, networkMax: 30, reserved: 3, regional: true,
    source: 'https://techdocs.broadcom.com/us/en/vmware-cis/nsx/vmware-nsx/9-0/administration-guide/nsx-virtual-private-clouds.html',
  },
};

/** The environments a network can serve. */
export const NETWORK_ENV_CHOICES: readonly Choice[] = [
  { value: 'prod', label: 'Production' },
  { value: 'nonprod', label: 'Non-production' },
  { value: 'dr', label: 'DR' },
  { value: 'shared', label: 'Shared (hub / shared services)' },
];

/** The plan environments a network of each class carries. */
export const ENVS_OF: Readonly<Record<NetworkEnv, readonly Env[]>> = {
  prod: ['prod'],
  nonprod: ['preprod', 'test', 'dev'],
  dr: ['dr'],
  shared: [],
};

/** The network class a workload environment lands in. */
export const envClassOf = (env: Env): NetworkEnv => (env === 'prod' ? 'prod' : env === 'dr' ? 'dr' : 'nonprod');

/** The regions a cloud offers (VCF: the vCenter, typed). */
export function regionChoices(platform: Platform): readonly string[] {
  switch (platform) {
    case 'aws': return AWS_REGIONS;
    case 'azure': return AZURE_REGIONS;
    case 'google': return GCP_REGIONS;
    case 'oci': return OCI_REGIONS;
    default: return [];
  }
}

/** OCI regions with three availability domains (verify); the rest have one, and HA spreads across fault domains. */
export const OCI_MULTI_AD_REGIONS: readonly string[] = Object.freeze(['us-ashburn-1', 'us-phoenix-1', 'eu-frankfurt-1', 'uk-london-1']);

/**
 * The zones a subnet can be placed in: AWS Availability Zones (verify: AZ
 * letters differ per account and some regions skip one); OCI availability
 * domains (an AD-specific subnet; regional is what Oracle recommends);
 * `regional` everywhere a subnet spans the region.
 */
export function subnetZoneChoices(platform: Platform, region: string): Choice[] {
  switch (platform) {
    case 'aws':
      return region ? ['a', 'b', 'c', 'd'].map((l) => ({ value: `${region}${l}`, label: `${region}${l}` })) : [];
    case 'oci':
      return [
        { value: 'regional', label: 'Regional (every availability domain)' },
        ...(OCI_MULTI_AD_REGIONS.includes(region) ? [1, 2, 3].map((i) => ({ value: `AD-${i}`, label: `AD-${i} (availability-domain-specific)` })) : []),
      ];
    case 'vmware':
      return [{ value: 'regional', label: 'Not zonal (NSX VPC)' }];
    default:
      return [{ value: 'regional', label: 'Regional (spans every zone)' }];
  }
}

/** Prefix lengths offered for a subnet on a cloud. */
export function subnetPrefixChoices(platform: Platform): number[] {
  const f = CLOUD_NETWORK[platform];
  const lo = Math.max(16, f.subnetMin);
  return Array.from({ length: f.subnetMax - lo + 1 }, (_, i) => lo + i);
}

/** Prefix lengths offered for a network on a cloud. */
export function networkPrefixChoices(platform: Platform): number[] {
  const f = CLOUD_NETWORK[platform];
  const lo = Math.max(8, f.networkMin);
  const hi = Math.min(28, f.networkMax);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

export const purposeOf = (platform: Platform, value: string): Purpose | undefined => CLOUD_NETWORK[platform].purposes.find((p) => p.value === value);

/** Addresses a /prefix leaves on a cloud after its reservation. */
export const usableOf = (platform: Platform, prefix: number): number => Math.max(0, 2 ** (32 - prefix) - CLOUD_NETWORK[platform].reserved);

const TIER_ORDER: readonly NetworkTier[] = ['web', 'app', 'db', 'mgmt'];
export const isTierPurpose = (p: string): p is NetworkTier => (TIER_ORDER as readonly string[]).includes(p);

// ---------------------------------------------------------------------------
// Row ids and edits (the UI's)
// ---------------------------------------------------------------------------

let counter = 0;
/** A new row id: unique within a session, stable once saved. */
export function newRowId(prefix: 'n' | 's'): string {
  counter += 1;
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.floor(Math.random() * 1e8).toString(16);
  return `${prefix}${rand}${counter.toString(36)}`;
}

export const EMPTY_CLOUD_NETWORKS: CloudNetworkPlan = Object.freeze({ networks: Object.freeze([]), subnets: Object.freeze([]) });

export const cloudNetworksOf = (plan: Pick<Plan, 'networks'>, platform: Platform): CloudNetworkPlan => plan.networks?.[platform] ?? EMPTY_CLOUD_NETWORKS;

/** A plan with one cloud's rows replaced. An empty list removes the cloud's entry. */
export function withCloudNetworks(plan: Plan, platform: Platform, next: CloudNetworkPlan): Plan {
  const all: Partial<Record<Platform, CloudNetworkPlan>> = { ...(plan.networks ?? {}) };
  if (next.networks.length === 0 && next.subnets.length === 0) delete all[platform];
  else all[platform] = next;
  const { networks: _n, ...rest } = plan;
  return Object.keys(all).length === 0 ? rest : { ...rest, networks: all };
}

/** An empty network row: nothing chosen. */
export const blankNetworkRow = (): NetworkRow => ({ id: newRowId('n'), name: '', role: '', region: '', env: '', state: '', base: '', prefix: 0, ipv6: '' });
/** An empty subnet row: nothing chosen. */
export const blankSubnetRow = (network = ''): SubnetRow => ({ id: newRowId('s'), network, name: '', purpose: '', zone: '', prefix: 0, base: '', ipv6: '' });

/** Move an item of a list by `delta` places (clamped). */
export function moveRow<T extends { readonly id: string }>(list: readonly T[], id: string, delta: number): T[] {
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return [...list];
  const j = Math.max(0, Math.min(list.length - 1, i + delta));
  const out = [...list];
  const [row] = out.splice(i, 1);
  out.splice(j, 0, row!);
  return out;
}

// ---------------------------------------------------------------------------
// Resolution and validation
// ---------------------------------------------------------------------------

/** The path a row's findings carry, so the editor can show them next to it. */
export const rowPath = (platform: Platform, rowId: string): string => `net:${platform}:${rowId}`;

export interface ResolveOptions {
  /** The regions a network may be in: the plan's primary and DR region for the cloud. */
  readonly regions: readonly string[];
  /** On-premises (and partner) ranges no row may overlap. */
  readonly avoid: readonly { readonly name: string; readonly cidr: string }[];
  /** Seeds Azure's IPv6 ULA ranges. */
  readonly planId: string;
}

export interface ResolvedNetworks {
  /** One per complete, valid network row, in row order (existing networks included, with no subnets). */
  readonly networks: NetworkDesign[];
  readonly findings: Finding[];
}

/** FNV-1a, 64-bit. */
function fnv64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

/**
 * A ULA /48 (fdXX:XXXX:XXXX::/48) for a network whose cloud needs its IPv6
 * range written (Azure, NSX): RFC 4193 asks for a pseudo-random global id, and
 * a hash of the plan id and the network is one, stable for the plan.
 */
export function ula48(planId: string, platform: Platform, network: string): string {
  const id = fnv64(`${planId}\u0000${platform}\u0000${network}`) & 0xffffffffffn;
  const hex = id.toString(16).padStart(10, '0');
  return `fd${hex.slice(0, 2)}:${hex.slice(2, 6)}:${hex.slice(6, 10)}::/48`;
}

/** Platforms whose subnets carry a written IPv6 range (the others allocate it). */
export const WRITES_IPV6: readonly Platform[] = ['azure', 'vmware'];

/**
 * The zones a VM can use in a network: the zones of its subnets on a zonal
 * cloud (AWS), the region's zones on a regional one. These are the places VMs
 * go, not a network choice.
 */
export function vmZones(platform: Platform, region: string): string[] {
  switch (platform) {
    case 'azure':
      return ['1', '2', '3'];
    case 'google': {
      const known = GCP_ZONES.filter((z) => z.startsWith(`${region}-`) && z.length === region.length + 2);
      return (known.length > 0 ? known : ['a', 'b', 'c'].map((l) => `${region}-${l}`)).slice(0, 3);
    }
    case 'oci':
      return [1, 2, 3].map((i) => (OCI_MULTI_AD_REGIONS.includes(region) ? `AD-${i}` : `FAULT-DOMAIN-${i}`));
    default:
      return [];
  }
}

const slug = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The name a subnet is built with: the user's, the cloud's fixed name, else its purpose (and zone letter). */
export function subnetName(platform: Platform, row: Pick<SubnetRow, 'name' | 'purpose' | 'zone'>): string {
  const fixed = purposeOf(platform, row.purpose)?.fixedName;
  if (fixed) return fixed;
  if (row.name.trim()) return row.name.trim();
  const zone = row.zone && row.zone !== 'regional' ? `-${row.zone.slice(-1).toLowerCase()}` : '';
  return `${slug(row.purpose) || 'subnet'}${zone}`;
}

/**
 * The design's networks from one cloud's rows, with every validation finding.
 * A row with a field unanswered or wrong is left out (its finding says why);
 * nothing is ever filled in for it.
 */
export function resolveCloudNetworks(rows: CloudNetworkPlan, platform: Platform, o: ResolveOptions): ResolvedNetworks {
  const f = CLOUD_NETWORK[platform];
  const findings: Finding[] = [];
  const err = (rowId: string, code: string, message: string, extra: { remediation?: string; source?: string } = {}): void => {
    findings.push(error(`design.net.${code}`, message, { path: rowPath(platform, rowId), ...extra }));
  };
  const warn = (rowId: string, code: string, message: string, extra: { remediation?: string; source?: string } = {}): void => {
    findings.push(warning(`design.net.${code}`, message, { path: rowPath(platform, rowId), ...extra }));
  };

  // Networks.
  const nets: { row: NetworkRow; cidr: string; label: string }[] = [];
  const names = new Set<string>();
  rows.networks.forEach((r, i) => {
    const label = r.name.trim() ? `${f.kind} ${r.name.trim()}` : `${f.kind} row ${i + 1}`;
    const missing: string[] = [];
    if (!r.name.trim()) missing.push('a name');
    if (!r.role) missing.push('its role');
    if (!r.region.trim()) missing.push('its region');
    if (!r.env) missing.push('its environment');
    if (!r.state) missing.push('new or existing');
    if (!r.base.trim()) missing.push('its IPv4 base address');
    if (!r.prefix) missing.push('its prefix');
    if (!r.ipv6) missing.push('IPv6 yes or no');
    if (missing.length > 0) {
      err(r.id, 'network-incomplete', `${platform}: ${label}: choose ${missing.join(', ')}. It is not built until then.`);
      return;
    }
    const name = slug(r.name);
    if (names.has(name)) {
      err(r.id, 'network-duplicate', `${platform}: two networks are called ${name}.`);
      return;
    }
    if (!f.roles.some((x) => x.value === r.role)) {
      err(r.id, 'network-role', `${platform}: ${label}: "${r.role}" is not a ${f.kind} role.`);
      return;
    }
    if (r.state === 'existing' && !r.existingId?.trim()) {
      err(r.id, 'network-existing-id', `${platform}: ${label} exists already: give its id, so it is attached to rather than built.`);
      return;
    }
    if (o.regions.length > 0 && !o.regions.includes(r.region.trim())) {
      err(r.id, 'network-region', `${platform}: ${label} is in ${r.region}, which is neither the cloud's primary region nor its DR region (${o.regions.join(', ')}).`, {
        remediation: 'Choose one of those regions for it, or change the cloud\'s regions.',
      });
      return;
    }
    const addr = parseIPv4(r.base);
    if (addr === null) {
      err(r.id, 'network-base', `${platform}: ${label}: "${r.base}" is not an IPv4 address.`);
      return;
    }
    if (r.prefix < f.networkMin || r.prefix > f.networkMax) {
      err(r.id, 'network-size', `${platform}: ${label}: a /${r.prefix} is outside the ${f.kind} sizes /${f.networkMin} to /${f.networkMax}.`, { source: f.source });
      return;
    }
    const net = parseCidr(`${r.base.trim()}/${r.prefix}`)!;
    if (net.network !== addr) {
      err(r.id, 'network-aligned', `${platform}: ${label}: ${r.base}/${r.prefix} is not the start of a /${r.prefix}; it would be ${formatIPv4(net.network)}/${r.prefix}.`);
      return;
    }
    const cidr = `${formatIPv4(net.network)}/${r.prefix}`;
    for (const other of nets) {
      if (overlapsAny(cidr, other.cidr)) {
        err(r.id, 'network-overlap', `${platform}: ${label} (${cidr}) overlaps ${other.label} (${other.cidr}): traffic between them cannot be routed.`);
        return;
      }
    }
    for (const a of o.avoid) {
      if (overlapsAny(cidr, a.cidr)) {
        err(r.id, 'network-avoid-overlap', `${platform}: ${label} (${cidr}) overlaps ${a.name}'s ${a.cidr}: traffic between them cannot be routed.`, {
          remediation: 'Use a range your network team assigned to this cloud that no on-premises or partner range uses.',
        });
        return;
      }
    }
    names.add(name);
    nets.push({ row: r, cidr, label });
  });

  // Subnets, in row order: "next free" follows the rows above it in the same network.
  const byNet = new Map<string, SubnetDesign[]>();
  const cursor = new Map<string, number>();
  rows.subnets.forEach((s, i) => {
    const parent = nets.find((n) => n.row.id === s.network);
    const label = `${platform}: subnet row ${i + 1}${s.name.trim() ? ` (${s.name.trim()})` : ''}`;
    if (!s.network) {
      err(s.id, 'subnet-no-network', `${label}: choose its network.`);
      return;
    }
    if (!parent) {
      const known = rows.networks.some((n) => n.id === s.network);
      err(s.id, 'subnet-network-invalid', `${label}: its network ${known ? 'is not complete or not valid yet (see its finding)' : 'no longer exists'}.`);
      return;
    }
    if (parent.row.state === 'existing') {
      err(s.id, 'subnet-in-existing', `${label}: ${parent.label} exists already and is attached to, not built; its subnets are not built here.`, {
        remediation: 'Add the subnet in the landing zone that owns that network, or make the network a new one.',
      });
      return;
    }
    const missing: string[] = [];
    if (!s.purpose) missing.push('its purpose');
    if (!s.zone) missing.push(f.regional ? 'regional' : 'its zone');
    if (!s.prefix) missing.push('its prefix');
    if (!s.base.trim()) missing.push('its IPv4 address (or next free)');
    if (!s.ipv6) missing.push('IPv6 yes or no');
    if (missing.length > 0) {
      err(s.id, 'subnet-incomplete', `${label}: choose ${missing.join(', ')}. It is not built until then.`);
      return;
    }
    const purpose = purposeOf(platform, s.purpose);
    if (!purpose) {
      err(s.id, 'subnet-purpose', `${label}: "${s.purpose}" is not a ${platform} subnet purpose.`);
      return;
    }
    // Zones.
    let zone = s.zone === 'regional' ? '' : s.zone.trim();
    if (platform === 'aws' && zone === '') {
      err(s.id, 'subnet-zonal', `${label}: AWS subnets are zonal: each lives in one Availability Zone, so choose its zone.`, { source: f.source });
      return;
    }
    if (platform === 'aws' && !zone.startsWith(parent.row.region.trim())) {
      err(s.id, 'subnet-zone-region', `${label}: ${zone} is not a zone of ${parent.row.region}.`);
      return;
    }
    if ((platform === 'azure' || platform === 'google' || platform === 'vmware') && zone !== '') {
      err(s.id, 'subnet-regional', `${label}: ${platform === 'azure' ? 'Azure' : platform === 'google' ? 'Google Cloud' : 'NSX VPC'} subnets are regional: a subnet spans every zone, so it cannot be placed in zone ${zone}.`, { source: f.source });
      return;
    }
    if (platform === 'oci' && zone !== '') {
      if (!/^AD-[123]$/.test(zone) || !OCI_MULTI_AD_REGIONS.includes(parent.row.region.trim())) {
        err(s.id, 'subnet-zone-region', `${label}: ${zone} is not an availability domain of ${parent.row.region}.`);
        return;
      }
      warn(s.id, 'subnet-ad-specific', `${label}: an availability-domain-specific subnet; Oracle recommends regional subnets, which span every availability domain.`, { source: f.source });
    }
    // Size.
    if (s.prefix < f.subnetMin || s.prefix > f.subnetMax) {
      err(s.id, 'subnet-size', `${label}: a /${s.prefix} is outside ${platform}'s subnet sizes /${f.subnetMin} to /${f.subnetMax}.`, { source: f.source });
      return;
    }
    if (purpose.maxPrefix !== undefined && s.prefix > purpose.maxPrefix) {
      err(s.id, 'subnet-too-small', `${label}: ${purpose.label} is a /${s.prefix}, but ${purpose.sizeWhy ?? `it needs a /${purpose.maxPrefix} or larger`}.`, { ...(purpose.source ? { source: purpose.source } : {}) });
      return;
    }
    if (platform === 'google' && s.purpose === 'proxy-only' && s.prefix > 23) {
      findings.push(info('design.net.proxy-only-size', `${label}: Google recommends a /23 proxy-only subnet; a /${s.prefix} limits how many proxies the load balancers can scale to.`, { path: rowPath(platform, s.id), source: purpose.source ?? f.source }));
    }
    const pnet = parseCidr(parent.cidr)!;
    if (s.prefix < pnet.prefix) {
      err(s.id, 'subnet-larger-than-network', `${label}: a /${s.prefix} is larger than its network ${parent.cidr}.`);
      return;
    }
    // Address.
    const size = 2 ** (32 - s.prefix);
    const taken = byNet.get(parent.row.id) ?? [];
    let start: number;
    if (s.base.trim().toLowerCase() === 'next') {
      const from = cursor.get(parent.row.id) ?? pnet.network;
      let at = Math.ceil(from / size) * size;
      const end = pnet.network + 2 ** (32 - pnet.prefix);
      while (at + size <= end && taken.some((t) => overlapsAny(t.cidr, `${formatIPv4(at >>> 0)}/${s.prefix}`))) at += size;
      if (at + size > end) {
        err(s.id, 'subnet-no-room', `${label}: there is no free /${s.prefix} left in ${parent.cidr} after the rows above it.`);
        return;
      }
      start = at;
    } else {
      const addr = parseIPv4(s.base);
      if (addr === null) {
        err(s.id, 'subnet-base', `${label}: "${s.base}" is not an IPv4 address (or "next").`);
        return;
      }
      const c = parseCidr(`${s.base.trim()}/${s.prefix}`)!;
      if (c.network !== addr) {
        err(s.id, 'subnet-aligned', `${label}: ${s.base}/${s.prefix} is not the start of a /${s.prefix}; it would be ${formatIPv4(c.network)}/${s.prefix}.`);
        return;
      }
      start = addr;
    }
    const cidr = `${formatIPv4(start >>> 0)}/${s.prefix}`;
    if (start < pnet.network || start + size > pnet.network + 2 ** (32 - pnet.prefix)) {
      err(s.id, 'subnet-outside', `${label}: ${cidr} is outside its network ${parent.label} (${parent.cidr}).`);
      return;
    }
    const clash = taken.find((t) => overlapsAny(t.cidr, cidr));
    if (clash) {
      err(s.id, 'subnet-overlap', `${label}: ${cidr} overlaps subnet ${clash.name} (${clash.cidr}).`);
      return;
    }
    const name = subnetName(platform, s);
    if (taken.some((t) => t.name === name)) {
      err(s.id, 'subnet-duplicate', `${label}: ${parent.label} already has a subnet called ${name}${purpose.fixedName ? ' (Azure allows one per virtual network)' : ''}.`);
      return;
    }
    if (s.ipv6 === 'yes' && parent.row.ipv6 !== 'yes') {
      err(s.id, 'subnet-ipv6', `${label}: IPv6 is on, but its network ${parent.label} is IPv4 only.`);
      return;
    }
    cursor.set(parent.row.id, Math.max(cursor.get(parent.row.id) ?? pnet.network, start + size));
    byNet.set(parent.row.id, [...taken, { id: s.id, name, tier: s.purpose, zone, cidr, ...(s.ipv6 === 'yes' ? { ipv6: true } : {}), usable: usableOf(platform, s.prefix) }]);
  });

  const networks: NetworkDesign[] = nets.map(({ row, cidr }) => {
    const name = slug(row.name);
    const ipv6 = row.ipv6 === 'yes';
    const v6range = ipv6 && WRITES_IPV6.includes(platform) ? ula48(o.planId, platform, name) : undefined;
    let v6i = 0;
    const subnets = (byNet.get(row.id) ?? []).map((s) => (v6range && s.ipv6 ? { ...s, ipv6Cidr: nthSlash64(v6range, v6i++) } : s));
    const tiers = TIER_ORDER.filter((t) => subnets.some((s) => s.tier === t));
    const zones = f.regional ? vmZones(platform, row.region.trim()) : [...new Set(subnets.map((s) => s.zone).filter(Boolean))].sort();
    return {
      id: row.id,
      name,
      role: row.role as NetworkRole,
      region: row.region.trim(),
      env: row.env as NetworkEnv,
      ...(row.state === 'existing' ? { existingId: row.existingId!.trim() } : {}),
      envs: [...ENVS_OF[row.env as NetworkEnv]],
      cidr,
      ipv6,
      ...(v6range ? { ipv6Cidr: v6range } : {}),
      tiers,
      zones,
      subnets,
    };
  });
  return { networks, findings };
}

// ---------------------------------------------------------------------------
// Picking among the user's networks
// ---------------------------------------------------------------------------

/** New networks (built here) in a region. */
export const builtIn = (networks: readonly NetworkDesign[], region: string): NetworkDesign[] =>
  networks.filter((n) => !n.existingId && (!region || !n.region || n.region === region));

/**
 * The network and subnets a workload of `env` and `tier` lands in: a built
 * network of that environment with a subnet of that purpose, else a shared
 * one (hub, shared services). Undefined when the user has none.
 */
export function placementNetwork(networks: readonly NetworkDesign[], region: string, env: Env, tier: string): NetworkDesign | undefined {
  const mine = builtIn(networks, region).filter((n) => n.subnets.some((s) => s.tier === tier));
  const want = envClassOf(env);
  return mine.find((n) => n.env === want)
    ?? (want === 'dr' ? mine.find((n) => n.env === 'prod') : undefined)
    ?? mine.find((n) => n.env === 'shared' || n.env === undefined);
}

/** The zones a VM of `tier` can use in a network: where that tier has a subnet (zonal cloud), else the network's zones. */
export function tierZones(network: NetworkDesign, tier: string): string[] {
  const own = [...new Set(network.subnets.filter((s) => s.tier === tier && s.zone).map((s) => s.zone))].sort();
  return own.length > 0 ? own : [...(network.zones ?? [])];
}

/** The hub the landing zone's shared services use: a hub, else shared services, else the first production network, else the first. */
export function hubOf(networks: readonly NetworkDesign[], region?: string): NetworkDesign | undefined {
  const list = region ? builtIn(networks, region) : networks.filter((n) => !n.existingId);
  return list.find((n) => n.role === 'hub') ?? list.find((n) => n.role === 'shared-services') ?? list.find((n) => n.env === 'prod') ?? list[0];
}

// ---------------------------------------------------------------------------
// The hint: hosts per tier, from the inventory (read-only, never applied)
// ---------------------------------------------------------------------------

export interface HostsHint {
  readonly byTier: Readonly<Record<string, number>>;
  readonly total: number;
}

/**
 * How many hosts the plan puts on this cloud, per tier: a hint for sizing the
 * subnets. It is never applied to a row.
 */
export function hostsHint(plan: Pick<Plan, 'workloads'>, decision: Pick<PlanDecision, 'items'> | undefined, platform: Platform, tierOf: (role: Workload['role']) => string, apps?: ReadonlySet<string>): HostsHint {
  const byTier: Record<string, number> = {};
  let total = 0;
  for (const w of plan.workloads) {
    if (apps && !apps.has(w.app)) continue;
    const d = decision?.items[w.id];
    if (!d || d.chosen?.platform !== platform || d.method === 'none') continue;
    const t = tierOf(w.role);
    byTier[t] = (byTier[t] ?? 0) + 1;
    total += 1;
  }
  return { byTier, total };
}
