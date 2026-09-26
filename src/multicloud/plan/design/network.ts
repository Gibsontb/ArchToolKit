/**
 * Networks: one prod and (when anything non-production lands) one nonprod
 * network per platform, carved into tier × zone subnets, dual-stack wherever
 * the platform supports it, and the `FoundationPlan` for each so that
 * `emitFoundation` can be called unchanged.
 *
 * - IPv4: prod `10.{n}.0.0/16`, nonprod `10.{n+1}.0.0/16` (`NETWORK_BASE`),
 *   `/22` per tier and zone by default, carved tier-major, zone-minor.
 * - IPv6: AWS, Google and OCI allocate the network's block and a /64 per
 *   subnet themselves, so no range is written. Azure (and vSphere / NSX) need
 *   one: a ULA /48 (RFC 4193) derived from the plan id, so it is stable for a
 *   plan and different between plans, with a /64 per subnet.
 * - Azure's `GatewaySubnet` (/27, when there are sites) and
 *   `AzureBastionSubnet` (/26, for a cloud-native bastion) are reserved in the
 *   prod network after the tier subnets. They are kept out of the
 *   `FoundationPlan` (the emitter would prefix their names, and Azure needs
 *   them exact); the landing zone adds them.
 * - A network that overlaps an on-premises site's CIDR is an error: the
 *   routes could never be told apart.
 */

import { error, info, warning, type Finding } from '../../../core/findings.ts';
import { byFamily, familyOf, overlapsAny, parseCidrAny } from '../../../core/ip.ts';
import { formatIPv4, parseCidr } from '../../../core/net.ts';
import { GCP_ZONES } from '../../../kit/regions.ts';
import { nthSlash64 } from '../../../terraform/blueprints/dual-stack.ts';
import { checkFoundationAddresses, resourceName, subnetIpv6Ranges, type FoundationPlan } from '../../../terraform/foundation.ts';
import type { CloudTarget } from '../../../terraform/providers.ts';
import {
  DEFAULT_LANDING_ZONE, LOG_RETENTION_VALUES, NETWORK_BASE, PLATFORM_PREFIX, overrideKey, slugName,
} from '../options.ts';
import type {
  Bastion, Env, NetworkDesign, NetworkTier, Plan, Platform, PlatformDesign, TargetDesign,
} from '../types.ts';
import type { DesignContext, DesignMapper } from './index.ts';

// ---------------------------------------------------------------------------
// carveSubnets
// ---------------------------------------------------------------------------

export interface CarvedSubnet {
  readonly tier: string;
  readonly zone: string;
  readonly cidr: string;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Tier-major, zone-minor, carved in order from the start of `cidr`: web-a,
 * web-b, web-c, app-a, … Deterministic. `zones` is a count (zones named a, b,
 * c, …) or the zone names. Throws a RangeError when `cidr` is not an IPv4
 * network or cannot hold them.
 */
export function carveSubnets(cidr: string, tiers: readonly string[], zones: number | readonly string[], prefixLen: number): CarvedSubnet[] {
  const net = parseCidr(cidr);
  if (!net) throw new RangeError(`"${cidr}" is not an IPv4 CIDR.`);
  const names = typeof zones === 'number' ? Array.from({ length: zones }, (_, i) => LETTERS[i] ?? `z${i}`) : [...zones];
  if (!Number.isInteger(prefixLen) || prefixLen < net.prefix || prefixLen > 30) {
    throw new RangeError(`A /${prefixLen} subnet cannot be carved from ${cidr}.`);
  }
  const size = 2 ** (32 - prefixLen);
  const count = tiers.length * names.length;
  if (count * size > 2 ** (32 - net.prefix)) {
    throw new RangeError(`${cidr} cannot hold ${count} /${prefixLen} subnets (${tiers.length} tiers × ${names.length} zones).`);
  }
  const out: CarvedSubnet[] = [];
  let i = 0;
  for (const tier of tiers) {
    for (const zone of names) {
      out.push({ tier, zone, cidr: `${formatIPv4((net.network + i * size) >>> 0)}/${prefixLen}` });
      i += 1;
    }
  }
  return out;
}

/** The next `/prefix` block at or after `from` (uint32), aligned; null if it leaves `cidr`. */
function nextBlock(cidr: string, from: number, prefix: number): { cidr: string; end: number } | null {
  const net = parseCidr(cidr)!;
  const size = 2 ** (32 - prefix);
  const start = Math.ceil(from / size) * size;
  const netEnd = net.network + 2 ** (32 - net.prefix);
  if (start + size > netEnd) return null;
  return { cidr: `${formatIPv4(start >>> 0)}/${prefix}`, end: start + size };
}

// ---------------------------------------------------------------------------
// ULA
// ---------------------------------------------------------------------------

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
 * A ULA /48 (fdXX:XXXX:XXXX::/48) for one network of one plan: the 40-bit
 * global id is a hash of the plan id, platform and network name, so it is
 * stable across runs and reloads of the same plan and unrelated between plans.
 * RFC 4193 asks for a pseudo-random global id; a hash of a random plan id is one.
 */
export function ula48(planId: string, platform: Platform, network: string): string {
  const id = fnv64(`${planId}\u0000${platform}\u0000${network}`) & 0xffffffffffn;
  const hex = id.toString(16).padStart(10, '0');
  const c = parseCidrAny(`fd${hex.slice(0, 2)}:${hex.slice(2, 6)}:${hex.slice(6, 10)}::/48`)!;
  return `${c.network}/48`;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** OCI regions with three availability domains (verify); the rest have one, and HA spreads across fault domains. */
export const OCI_MULTI_AD_REGIONS: readonly string[] = Object.freeze(['us-ashburn-1', 'us-phoenix-1', 'eu-frankfurt-1', 'uk-london-1']);

/**
 * The zone names on a platform, as far as `count` (1–3):
 * - aws: `<region>a/b/c` (verify: AZ letters are per account and some regions skip one);
 * - azure: `1/2/3` (verify the region has availability zones);
 * - google: the region's zones from `GCP_ZONES`;
 * - oci: `AD-1/2/3` where the region has three availability domains, else `FAULT-DOMAIN-1/2/3`;
 * - vmware: one zone, `default` (vSphere HA and DRS rules spread VMs).
 */
export function zoneNames(platform: Platform, region: string, count: number): string[] {
  const n = Math.max(1, Math.min(3, Math.floor(count)));
  switch (platform) {
    case 'aws':
      return Array.from({ length: n }, (_, i) => `${region}${LETTERS[i]}`);
    case 'azure':
      return Array.from({ length: n }, (_, i) => String(i + 1));
    case 'google': {
      const known = GCP_ZONES.filter((z) => z.startsWith(`${region}-`) && z.length === region.length + 2);
      const names = known.length > 0 ? known : ['a', 'b', 'c'].map((l) => `${region}-${l}`);
      return names.slice(0, n);
    }
    case 'oci':
      return Array.from({ length: n }, (_, i) => (OCI_MULTI_AD_REGIONS.includes(region) ? `AD-${i + 1}` : `FAULT-DOMAIN-${i + 1}`));
    default:
      return ['default'];
  }
}

// ---------------------------------------------------------------------------
// Landing-zone settings (Screen 7), from the overrides
// ---------------------------------------------------------------------------

export interface LandingZoneSettings {
  readonly prefix: string;
  readonly scope?: string;
  readonly subnetPrefix: number;
  readonly zonesProd: number;
  readonly zonesNonprod: number;
  readonly bastion: Bastion;
  readonly logRetentionDays: number;
  readonly tiers: readonly NetworkTier[];
}

const BASTIONS: readonly Bastion[] = ['cloud-native', 'jump-vm', 'none'];

/** Screen 7's landing-zone card for one platform: `overrideKey(platform, 'lz', field)` over the defaults. */
export function landingZoneSettings(plan: Plan, platform: Platform): { settings: LandingZoneSettings; findings: Finding[] } {
  const findings: Finding[] = [];
  const o = (field: string): string | undefined => {
    const v = plan.designOverrides[overrideKey(platform, 'lz', field)];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const bad = (field: string, value: string, why: string): void => {
    findings.push(warning('design.lz.invalid-override', `${platform}: the landing-zone ${field} "${value}" ${why}; the default is used.`, { path: overrideKey(platform, 'lz', field) }));
  };
  const num = (field: string, fallback: number, ok: (n: number) => boolean, why: string): number => {
    const v = o(field);
    if (v === undefined) return fallback;
    const n = Number(v.replace(/^\//, ''));
    if (!ok(n)) {
      bad(field, v, why);
      return fallback;
    }
    return n;
  };
  const bastionRaw = o('bastion');
  let bastion: Bastion = DEFAULT_LANDING_ZONE.bastion;
  if (bastionRaw !== undefined) {
    if ((BASTIONS as readonly string[]).includes(bastionRaw)) bastion = bastionRaw as Bastion;
    else bad('bastion', bastionRaw, 'is not cloud-native, jump-vm or none');
  }
  const prefix = resourceName(o('prefix') ?? `${slugName(plan.name) || 'plan'}-${PLATFORM_PREFIX[platform]}`);
  const scope = o('scope');
  return {
    settings: {
      prefix,
      ...(scope !== undefined ? { scope } : {}),
      subnetPrefix: num('subnet-size', Number(DEFAULT_LANDING_ZONE.subnetPrefix.slice(1)), (n) => Number.isInteger(n) && n >= 20 && n <= 24, 'is not /20–/24'),
      zonesProd: num('zones-prod', DEFAULT_LANDING_ZONE.zonesProd, (n) => [1, 2, 3].includes(n), 'is not 1, 2 or 3'),
      zonesNonprod: num('zones-nonprod', DEFAULT_LANDING_ZONE.zonesNonprod, (n) => [1, 2, 3].includes(n), 'is not 1, 2 or 3'),
      bastion,
      logRetentionDays: num('log-retention', DEFAULT_LANDING_ZONE.logRetentionDays, (n) => (LOG_RETENTION_VALUES as readonly string[]).includes(String(n)), 'is not a listed retention'),
      tiers: [...DEFAULT_LANDING_ZONE.tiers],
    },
    findings,
  };
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

export type NetworkName = 'prod' | 'nonprod';
export const NETWORK_ENVS: Readonly<Record<NetworkName, readonly Env[]>> = { prod: ['prod', 'dr'], nonprod: ['preprod', 'test', 'dev'] };
/** Which network an environment lands in. */
export const networkForEnv = (env: Env): NetworkName => (NETWORK_ENVS.prod.includes(env) ? 'prod' : 'nonprod');

/** Platforms whose subnets carry a written IPv6 range (the others allocate it). */
export const WRITES_IPV6: readonly Platform[] = ['azure', 'vmware'];
/** Azure's fixed-name platform subnets. */
export const AZURE_GATEWAY_SUBNET = 'GatewaySubnet';
export const AZURE_BASTION_SUBNET = 'AzureBastionSubnet';

/** The zones of one network in a design (in subnet order). */
export function networkZones(network: NetworkDesign): string[] {
  const tiers = new Set<string>(network.tiers);
  return [...new Set(network.subnets.filter((s) => tiers.has(s.tier)).map((s) => s.zone))];
}

function buildNetwork(ctx: DesignContext, name: NetworkName, zones: readonly string[], findings: Finding[]): NetworkDesign | null {
  const { plan, platform, lz } = ctx;
  const key = (field: string): string => overrideKey(platform, `network-${name}`, field);
  const base = NETWORK_BASE[platform] + (name === 'nonprod' ? 1 : 0);
  const cidr = plan.designOverrides[key('cidr')]?.trim() || `10.${base}.0.0/16`;
  const ipv6 = (plan.designOverrides[key('ipv6')]?.trim() || 'yes') !== 'no';
  let subnets: CarvedSubnet[];
  try {
    subnets = carveSubnets(cidr, lz.tiers, zones, lz.subnetPrefix);
  } catch (e) {
    findings.push(error('design.network.cannot-carve', `${platform} ${name}: ${(e as Error).message}`, {
      path: key('cidr'),
      remediation: 'Give a larger network, a smaller subnet size (/23 or /24) or fewer zones.',
    }));
    return null;
  }
  const extra: { tier: string; zone: string; cidr: string }[] = [];
  if (platform === 'azure' && name === 'prod') {
    const last = parseCidr(subnets[subnets.length - 1]!.cidr)!;
    let cursor = last.network + 2 ** (32 - last.prefix);
    const reserve = (tier: string, prefix: number): void => {
      const b = nextBlock(cidr, cursor, prefix);
      if (!b) {
        findings.push(error('design.network.no-room', `${platform} ${name}: no room left in ${cidr} for ${tier} (/${prefix}).`, { path: key('cidr') }));
        return;
      }
      extra.push({ tier, zone: '', cidr: b.cidr });
      cursor = b.end;
    };
    if (lz.bastion === 'cloud-native') reserve(AZURE_BASTION_SUBNET, 26);
    if (plan.requirements.sites.length > 0) reserve(AZURE_GATEWAY_SUBNET, 27);
  }
  const ipv6Cidr = ipv6 && WRITES_IPV6.includes(platform)
    ? plan.designOverrides[key('ipv6-cidr')]?.trim() || ula48(plan.id, platform, name)
    : undefined;
  return {
    name,
    envs: [...NETWORK_ENVS[name]],
    cidr,
    ipv6,
    ...(ipv6Cidr ? { ipv6Cidr } : {}),
    tiers: [...lz.tiers],
    subnets: [
      // Azure / vSphere: the n-th /64 of the network's range per tier subnet.
      ...subnets.map((s, i) => ({ ...s, ...(ipv6Cidr ? { ipv6Cidr: nthSlash64(ipv6Cidr, i) } : {}) })),
      // Platform subnets: IPv4 only here (verify dual-stack support of the VPN gateway and Bastion).
      ...extra,
    ],
  };
}

/** Is any workload or database on this platform in a non-production environment. */
function needsNonprod(ctx: DesignContext): boolean {
  if (ctx.workloads.some((w) => networkForEnv(w.env) === 'nonprod')) return true;
  // A database's environment is its hosts'; with no hosts it lands in prod.
  return false;
}

export const networkMapper: DesignMapper = {
  id: 'network',
  map(ctx, design) {
    const findings: Finding[] = [];
    const { lz, platform } = ctx;
    const names: NetworkName[] = needsNonprod(ctx) ? ['prod', 'nonprod'] : ['prod'];
    const networks: NetworkDesign[] = [];
    for (const name of names) {
      const zones = zoneNames(platform, design.region, name === 'prod' ? lz.zonesProd : lz.zonesNonprod);
      const n = buildNetwork(ctx, name, zones, findings);
      if (n) networks.push(n);
    }
    if (platform === 'oci' && !OCI_MULTI_AD_REGIONS.includes(design.region)) {
      findings.push(info('design.network.oci-fault-domains', `${design.region} has one availability domain: the zones are fault domains, and OCI subnets are regional.`, {
        source: 'https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm',
      }));
    }

    // Site overlap, both families.
    const sites = ctx.plan.requirements.sites;
    for (const network of networks) {
      const ranges = [network.cidr, ...(network.ipv6Cidr ? [network.ipv6Cidr] : [])];
      for (const site of sites) {
        for (const siteCidr of site.cidrs) {
          const hit = ranges.find((r) => overlapsAny(r, siteCidr));
          if (hit) {
            findings.push(error('design.network.site-overlap', `${platform} network ${network.name} (${hit}) overlaps site ${site.name}'s ${siteCidr}: traffic between them cannot be routed.`, {
              path: overrideKey(platform, `network-${network.name}`, 'cidr'),
              remediation: `Give the ${network.name} network a range that does not overlap any on-premises CIDR.`,
            }));
          }
        }
      }
    }

    // The emitters' own address checks, on the FoundationPlans they will get.
    const draft: PlatformDesign = { ...design, networks };
    for (const fp of foundationPlansFor(draft, platform, ctx.plan)) {
      findings.push(...checkFoundationAddresses(fp, cloudTarget(platform), `${platform} ${fp.name}`));
      if (fp.ipv6 && WRITES_IPV6.includes(platform)) findings.push(...subnetIpv6Ranges(fp, cloudTarget(platform)).findings);
    }
    return { design: draft, findings };
  },
};

// ---------------------------------------------------------------------------
// FoundationPlan per network
// ---------------------------------------------------------------------------

export const cloudTarget = (platform: Platform): CloudTarget => (platform === 'vmware' ? 'vsphere' : platform);

/** The ports every network admits from the site CIDRs; engine ports go on the db tier's own rules. */
export const FOUNDATION_TCP_PORTS: readonly number[] = Object.freeze([22, 443, 3389, 5986]);

/** The on-premises CIDRs, both families, valid ones only, in order and de-duplicated. */
export function siteCidrs(plan: Pick<Plan, 'requirements'>): string[] {
  const all = plan.requirements.sites.flatMap((s) => s.cidrs);
  const { v4, v6 } = byFamily(all);
  return [...new Set([...v4, ...v6].map((c) => {
    const p = parseCidrAny(c);
    return p ? `${p.network}/${p.prefix}` : c;
  }))];
}

/**
 * One `FoundationPlan` per network of a platform, for `emitFoundation`
 * unchanged. The tier subnets only (Azure's platform subnets are the landing
 * zone's), named `<tier>-<a|b|c>`, with each subnet's real zone; Azure and
 * vSphere get the network's /48 and each subnet's /64. Ingress is the site
 * CIDRs, both families; pass the plan (or its requirements) to fill it.
 */
export function foundationPlansFor(design: TargetDesign | PlatformDesign, platform: Platform, plan?: Pick<Plan, 'requirements'>): FoundationPlan[] {
  const pd = 'platforms' in design ? design.platforms.find((p) => p.platform === platform) : design.platform === platform ? design : undefined;
  if (!pd) return [];
  const ingress = plan ? siteCidrs(plan) : [];
  return pd.networks.map((n) => {
    const tiers = new Set<string>(n.tiers);
    const tierSubnets = n.subnets.filter((s) => tiers.has(s.tier));
    const zones = networkZones(n);
    return {
      name: `${pd.prefix}-${n.name}`,
      cidr: n.cidr,
      region: pd.region,
      tags: { managed_by: 'archtoolkit', atk_network: n.name },
      subnets: tierSubnets.map((s) => ({
        name: `${s.tier}-${LETTERS[zones.indexOf(s.zone)] ?? s.zone}`,
        cidr: s.cidr,
        ...(s.ipv6Cidr ? { ipv6Cidr: s.ipv6Cidr } : {}),
        ...(s.zone && platform !== 'vmware' ? { zone: s.zone } : {}),
      })),
      ipv6: n.ipv6,
      ...(n.ipv6Cidr ? { ipv6Cidr: n.ipv6Cidr } : {}),
      allowedIngressCidrs: ingress.filter((c) => n.ipv6 || familyOf(c) === 4),
      allowedTcpPorts: [...FOUNDATION_TCP_PORTS],
      ...(platform === 'oci' && pd.scope ? { compartmentId: pd.scope } : {}),
    };
  });
}
