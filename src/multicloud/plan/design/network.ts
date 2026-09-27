/**
 * Networks: exactly the networks and subnets the user built for the platform
 * (Landing zones / wizard step 6, `plan.networks[<platform>]`), resolved and
 * validated by ./net-rows.ts. Nothing is invented: with no rows the design
 * has no network, and a blocking finding says so.
 *
 * Also here: the landing-zone card's other settings (name prefix, scope,
 * bastion, log retention), the checks that need the rest of the design (a
 * platform subnet a chosen service requires, a workload tier with no subnet),
 * and the `FoundationPlan` of each network for `emitFoundation`.
 */

import { error, warning, type Finding } from '../../../core/findings.ts';
import { byFamily, familyOf, overlapsAny, parseCidrAny } from '../../../core/ip.ts';
import { resourceName, type FoundationPlan } from '../../../terraform/foundation.ts';
import type { CloudTarget } from '../../../terraform/providers.ts';
import {
  DEFAULT_LANDING_ZONE, LOG_RETENTION_VALUES, PLATFORM_LABELS, PLATFORM_PREFIX, overrideKey, slugName,
} from '../options.ts';
import type { Bastion, Env, NetworkDesign, Plan, Platform, PlatformDesign, TargetDesign } from '../types.ts';
import type { DesignMapper } from './index.ts';
import {
  OCI_MULTI_AD_REGIONS, WRITES_IPV6, cloudNetworksOf, envClassOf, hubOf, placementNetwork, resolveCloudNetworks, rowPath, tierZones, ula48, vmZones,
} from './net-rows.ts';

export { OCI_MULTI_AD_REGIONS, WRITES_IPV6, ula48 };

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/**
 * The zone names on a platform, as far as `count` (1–3): the places VMs go.
 * - aws: `<region>a/b/c` (verify: AZ letters are per account and some regions skip one);
 * - azure: `1/2/3`; google: the region's zones; oci: `AD-1/2/3` or fault domains;
 * - vmware: one zone, `default`.
 */
export function zoneNames(platform: Platform, region: string, count: number): string[] {
  const n = Math.max(1, Math.min(3, Math.floor(count)));
  if (platform === 'aws') return Array.from({ length: n }, (_, i) => `${region}${'abc'[i]}`);
  if (platform === 'vmware') return ['default'];
  return vmZones(platform, region).slice(0, n);
}

// ---------------------------------------------------------------------------
// Landing-zone settings (the card's), from the overrides
// ---------------------------------------------------------------------------

export interface LandingZoneSettings {
  readonly prefix: string;
  readonly scope?: string;
  readonly bastion: Bastion;
  readonly logRetentionDays: number;
}

const BASTIONS: readonly Bastion[] = ['cloud-native', 'jump-vm', 'none'];

/** The landing-zone card for one platform: `overrideKey(platform, 'lz', field)` over the defaults. */
export function landingZoneSettings(plan: Plan, platform: Platform): { settings: LandingZoneSettings; findings: Finding[] } {
  const findings: Finding[] = [];
  const o = (field: string): string | undefined => {
    const v = plan.designOverrides[overrideKey(platform, 'lz', field)];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const bad = (field: string, value: string, why: string): void => {
    findings.push(warning('design.lz.invalid-override', `${platform}: the landing-zone ${field} "${value}" ${why}; the default is used.`, { path: overrideKey(platform, 'lz', field) }));
  };
  const bastionRaw = o('bastion');
  let bastion: Bastion = DEFAULT_LANDING_ZONE.bastion;
  if (bastionRaw !== undefined) {
    if ((BASTIONS as readonly string[]).includes(bastionRaw)) bastion = bastionRaw as Bastion;
    else bad('bastion', bastionRaw, 'is not cloud-native, jump-vm or none');
  }
  let logRetentionDays: number = DEFAULT_LANDING_ZONE.logRetentionDays;
  const retention = o('log-retention');
  if (retention !== undefined) {
    if ((LOG_RETENTION_VALUES as readonly string[]).includes(retention)) logRetentionDays = Number(retention);
    else bad('log-retention', retention, 'is not a listed retention');
  }
  const prefix = resourceName(o('prefix') ?? `${slugName(plan.name) || 'plan'}-${PLATFORM_PREFIX[platform]}`);
  const scope = o('scope');
  return { settings: { prefix, ...(scope !== undefined ? { scope } : {}), bastion, logRetentionDays }, findings };
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

/** Azure's fixed-name platform subnets. */
export const AZURE_GATEWAY_SUBNET = 'GatewaySubnet';
export const AZURE_BASTION_SUBNET = 'AzureBastionSubnet';

/** The zones a VM can use in a network (see `NetworkDesign.zones`). */
export function networkZones(network: NetworkDesign): string[] {
  if (network.zones) return [...network.zones];
  return [...new Set(network.subnets.map((s) => s.zone).filter(Boolean))];
}

/** The zones a VM of `tier` can use in a network. */
export { tierZones, placementNetwork, hubOf };

/** The network class a workload environment lands in. */
export const networkForEnv = (env: Env): string => envClassOf(env);

/** The on-premises CIDRs, both families, valid ones only, in order and de-duplicated. */
export function siteCidrs(plan: Pick<Plan, 'requirements'>): string[] {
  const all = plan.requirements.sites.flatMap((s) => s.cidrs);
  const { v4, v6 } = byFamily(all);
  return [...new Set([...v4, ...v6].map((c) => {
    const p = parseCidrAny(c);
    return p ? `${p.network}/${p.prefix}` : c;
  }))];
}

/** The regions a platform's networks may be in: its primary and DR regions. */
export function platformRegions(design: Pick<PlatformDesign, 'region' | 'drRegion'>): string[] {
  return [design.region, ...(design.drRegion ? [design.drRegion] : [])].filter(Boolean);
}

/** The blocking finding a platform with no network gets. */
export function noNetworkFinding(platform: Platform): Finding {
  return error('design.network.none', `No network defined for ${PLATFORM_LABELS[platform]}: add its networks and subnets on Landing zones (or the wizard's Foundation step). Nothing is generated for it until then.`, {
    path: rowPath(platform, ''),
    remediation: 'Add a network row (its kind, role, region, environment, the IPv4 range your network team assigned, IPv6), then the subnets it needs.',
  });
}

export const networkMapper: DesignMapper = {
  id: 'network',
  map(ctx, design) {
    const { plan, platform } = ctx;
    const rows = cloudNetworksOf(plan, platform);
    const avoid = plan.requirements.sites.flatMap((s) => s.cidrs.filter((c) => familyOf(c.split('/')[0] ?? '') === 4 && c.includes('/')).map((cidr) => ({ name: `site ${s.name}`, cidr })));
    const r = resolveCloudNetworks(rows, platform, { regions: platformRegions(design), avoid, planId: plan.id });
    const findings = [...r.findings];
    // A written IPv6 range (Azure's, NSX's ULA) must not overlap an on-premises IPv6 range either.
    for (const n of r.networks) {
      if (!n.ipv6Cidr) continue;
      for (const s of plan.requirements.sites) {
        for (const c of s.cidrs.filter((x) => familyOf(x.split('/')[0] ?? '') === 6)) {
          if (overlapsAny(n.ipv6Cidr, c)) {
            findings.push(error('design.net.network-avoid-overlap', `${platform}: network ${n.name}'s IPv6 range ${n.ipv6Cidr} overlaps site ${s.name}'s ${c}: traffic between them cannot be routed.`, { path: rowPath(platform, n.id ?? '') }));
          }
        }
      }
    }
    if (r.networks.filter((n) => !n.existingId).length === 0 && rows.networks.length === 0) findings.push(noNetworkFinding(platform));
    else if (r.networks.filter((n) => !n.existingId).length === 0) {
      findings.push(error('design.network.none-valid', `${PLATFORM_LABELS[platform]}: none of its network rows is complete and valid yet, so there is no network to build (see the rows' findings).`, { path: rowPath(platform, '') }));
    }
    return { design: { ...design, networks: r.networks }, findings };
  },
};

// ---------------------------------------------------------------------------
// The checks that need the rest of the design (after connectivity, databases, identity)
// ---------------------------------------------------------------------------

const has = (n: NetworkDesign | undefined, purpose: string): boolean => !!n?.subnets.some((s) => s.tier === purpose);

/**
 * A platform subnet a chosen service needs, missing: Azure's GatewaySubnet for
 * ExpressRoute or VPN, AzureBastionSubnet for Azure Bastion, the delegated
 * subnets of the managed databases and Entra Domain Services; the AWS Transit
 * Gateway attachment subnets; the second Availability Zone RDS needs.
 */
export const networkChecksMapper: DesignMapper = {
  id: 'network-checks',
  map(ctx, design) {
    const findings: Finding[] = [];
    const { platform } = ctx;
    const built = design.networks.filter((n) => !n.existingId && (!n.region || n.region === design.region));
    if (built.length === 0) return { design, findings };
    const hub = hubOf(design.networks, design.region);
    const need = (code: string, message: string, source?: string, sev: 'error' | 'warning' = 'error'): void => {
      findings.push((sev === 'error' ? error : warning)(`design.net.${code}`, message, { path: rowPath(platform, ''), ...(source ? { source } : {}) }));
    };
    const dbNetworkOf = (dbId: string): NetworkDesign | undefined => {
      const t = design.databases.find((d) => d.database === dbId);
      const host = t?.hosts?.map((h) => design.compute.find((c) => c.workload === h)).find(Boolean);
      return (host ? built.find((n) => n.name === host.network) : undefined) ?? built.find((n) => n.env === 'prod') ?? built[0];
    };
    if (platform === 'azure') {
      const existingHub = design.networks.some((n) => n.existingId && n.role === 'hub');
      if (design.connectivity.length > 0 && !existingHub && !has(hub, 'GatewaySubnet')) {
        need('azure-gateway-subnet', `Azure: ${design.connectivity.map((c) => c.site).join(', ')} connect${design.connectivity.length === 1 ? 's' : ''} by ExpressRoute or VPN, which needs a GatewaySubnet (/27 or larger) in ${hub?.name ?? 'the hub'}: add one.`, 'https://learn.microsoft.com/azure/vpn-gateway/vpn-gateway-about-vpn-gateway-settings#gwsub');
      }
      if (design.bastion === 'cloud-native' && !has(hub, 'AzureBastionSubnet')) {
        need('azure-bastion-subnet', `Azure: Bastion is Azure Bastion (cloud-native), which needs an AzureBastionSubnet (/26 or larger) in ${hub?.name ?? 'the hub'}: add one, or choose another bastion; no Bastion host is built until then.`, 'https://learn.microsoft.com/azure/bastion/configuration-settings#subnet', 'warning');
      }
      const kinds: Record<string, string> = { 'azure-sqlmi': 'sqlmi', 'azure-pg-flex': 'postgres', 'azure-mysql-flex': 'mysql' };
      for (const t of design.databases) {
        const kind = kinds[t.service];
        if (!kind) continue;
        const net = dbNetworkOf(t.database);
        if (!has(net, kind)) {
          const db = ctx.plan.databases.find((d) => d.id === t.database)?.name ?? t.database;
          need(`azure-${kind}-subnet`, `Azure: ${db} is on ${t.service}, which needs a delegated subnet (purpose "Delegated: ${kind}") in ${net?.name ?? 'its network'}: add one.`);
        }
      }
      if (design.identity.strategy === 'managed-ad' && !has(hub, 'aadds')) {
        need('azure-aadds-subnet', `Azure: Microsoft Entra Domain Services needs its own subnet (purpose "Microsoft Entra Domain Services") in ${hub?.name ?? 'the hub'}: add one.`);
      }
    }
    if (platform === 'aws') {
      const tgw = (built.length >= 2 && design.connectivity.length > 0) || design.networks.some((n) => n.existingId && n.role === 'hub');
      if (tgw) {
        for (const n of built) {
          if (!has(n, 'tgw-attachment')) {
            need('aws-tgw-subnets', `AWS: ${n.name} joins the Transit Gateway; AWS recommends a /28 attachment subnet per Availability Zone (purpose "Transit Gateway attachment"). Without them the attachment uses the network's first subnet in each zone.`, 'https://docs.aws.amazon.com/vpc/latest/tgw/tgw-best-design-practices.html', 'warning');
          }
        }
      }
      for (const t of design.databases) {
        if (t.service !== 'aws-rds' && t.service !== 'aws-aurora') continue;
        const net = dbNetworkOf(t.database);
        const zones = new Set(net?.subnets.filter((s) => s.tier === 'db').map((s) => s.zone));
        if (zones.size < 2) {
          const db = ctx.plan.databases.find((d) => d.id === t.database)?.name ?? t.database;
          need('aws-rds-zones', `AWS: ${db} is on ${t.service}, whose DB subnet group needs data-tier subnets in at least two Availability Zones of ${net?.name ?? 'its network'} (it has ${zones.size}).`, 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.WorkingWithRDSInstanceinaVPC.html');
        }
      }
    }
    return { design, findings };
  },
};

// ---------------------------------------------------------------------------
// FoundationPlan per network
// ---------------------------------------------------------------------------

export const cloudTarget = (platform: Platform): CloudTarget => (platform === 'vmware' ? 'vsphere' : platform);

/** The ports every network admits from the site CIDRs; engine ports go on the db tier's own rules. */
export const FOUNDATION_TCP_PORTS: readonly number[] = Object.freeze([22, 443, 3389, 5986]);

/**
 * One `FoundationPlan` per built network of a platform, for `emitFoundation`:
 * every subnet the user added, with its own name and zone. Ingress is the
 * site CIDRs, both families; pass the plan (or its requirements) to fill it.
 */
export function foundationPlansFor(design: TargetDesign | PlatformDesign, platform: Platform, plan?: Pick<Plan, 'requirements'>): FoundationPlan[] {
  const pd = 'platforms' in design ? design.platforms.find((p) => p.platform === platform) : design.platform === platform ? design : undefined;
  if (!pd) return [];
  const ingress = plan ? siteCidrs(plan) : [];
  return pd.networks.filter((n) => !n.existingId && n.subnets.length > 0).map((n) => ({
    name: `${pd.prefix}-${n.name}`,
    cidr: n.cidr,
    region: n.region || pd.region,
    tags: { managed_by: 'archtoolkit', atk_network: n.name },
    subnets: n.subnets.map((s) => ({
      name: s.name,
      cidr: s.cidr,
      ...(s.ipv6Cidr ? { ipv6Cidr: s.ipv6Cidr } : {}),
      ...(s.zone && platform !== 'vmware' ? { zone: s.zone } : {}),
      ...(s.tier === 'public' ? { public: true } : {}),
    })),
    ipv6: n.ipv6,
    ...(n.ipv6Cidr ? { ipv6Cidr: n.ipv6Cidr } : {}),
    allowedIngressCidrs: ingress.filter((c) => n.ipv6 || familyOf(c) === 4),
    allowedTcpPorts: [...FOUNDATION_TCP_PORTS],
    ...(platform === 'oci' && pd.scope ? { compartmentId: pd.scope } : {}),
  }));
}

/** The network and zone a workload goes to, or why it cannot be placed. */
export function placeWorkload(design: PlatformDesign, env: Env, tier: string): { network: NetworkDesign; zones: string[] } | undefined {
  const network = placementNetwork(design.networks, design.region, env, tier);
  return network ? { network, zones: tierZones(network, tier) } : undefined;
}
