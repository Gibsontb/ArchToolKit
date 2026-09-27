/**
 * Test data: the network rows a user would build on Landing zones, for the
 * tests that need a cloud with networks. The toolkit never builds these
 * itself; a test that needs a network says so by adding them.
 *
 * `userNetworks(platform, region)` gives a production network (10.<n>.0.0/16)
 * and a non-production one (10.<n+1>.0.0/16) with web, app, db and mgmt
 * subnets: one per Availability Zone (a, b, c) on AWS, one regional subnet
 * each elsewhere, every one a /24. Options add platform subnets, a DR-region
 * network, or change the tiers.
 */

import { DEFAULT_REGIONS } from '../multicloud/plan/options.ts';
import type { CloudNetworkPlan, NetworkRow, Plan, Platform, SubnetRow } from '../multicloud/plan/types.ts';

const BASE: Readonly<Record<Platform, number>> = { aws: 10, azure: 20, google: 30, oci: 40, vmware: 50 };

export interface UserNetworkOptions {
  readonly tiers?: readonly string[];
  readonly zones?: number;
  readonly nonprod?: boolean;
  readonly ipv6?: boolean;
  /** Extra subnets for the prod network: [purpose, prefix] (one per zone on AWS), placed at the next free block. */
  readonly extra?: readonly (readonly [string, number])[];
  /** A DR network in this region, with the same tiers. */
  readonly drRegion?: string;
  readonly base?: number;
}

/** The platform subnets every service in the tests' fixtures needs, per cloud. */
export const ALL_PLATFORM_SUBNETS: Readonly<Partial<Record<Platform, readonly (readonly [string, number])[]>>> = {
  aws: [['tgw-attachment', 28]],
  azure: [['GatewaySubnet', 27], ['AzureBastionSubnet', 26], ['sqlmi', 24], ['postgres', 24], ['mysql', 24], ['dns-resolver', 28], ['aadds', 24], ['oracle', 24], ['functions', 26], ['webapp', 26]],
  google: [['proxy-only', 23]],
};

/** The rows for one cloud: prod (and nonprod) networks with a subnet per tier (per zone on AWS). */
export function userNetworks(platform: Platform, region: string, o: UserNetworkOptions = {}): CloudNetworkPlan {
  const tiers = o.tiers ?? ['web', 'app', 'db', 'mgmt'];
  const zonal = platform === 'aws';
  const zonesIn = (r: string): string[] => (zonal ? ['a', 'b', 'c'].slice(0, o.zones ?? 3).map((l) => `${r}${l}`) : ['regional']);
  const base = o.base ?? BASE[platform];
  const networks: NetworkRow[] = [];
  const subnets: SubnetRow[] = [];
  const v6 = o.ipv6 === false ? 'no' : 'yes';
  const envs: { env: 'prod' | 'nonprod' | 'dr'; region: string }[] = [
    { env: 'prod', region },
    ...(o.nonprod === false ? [] : [{ env: 'nonprod' as const, region }]),
    ...(o.drRegion ? [{ env: 'dr' as const, region: o.drRegion }] : []),
  ];
  envs.forEach(({ env, region: r }, ni) => {
    const id = `n-${platform}-${env}`;
    networks.push({ id, name: env, role: env === 'prod' && platform !== 'vmware' ? 'hub' : 'spoke', region: r, env, state: 'new', base: `10.${base + ni}.0.0`, prefix: 16, ipv6: v6 });
    let third = 0;
    for (const tier of tiers) {
      for (const zone of zonesIn(r)) {
        subnets.push({ id: `s-${platform}-${env}-${tier}-${zone}`, network: id, name: '', purpose: tier, zone, prefix: 24, base: `10.${base + ni}.${third}.0`, ipv6: v6 });
        third += 1;
      }
    }
    if (env === 'prod') {
      for (const [purpose, prefix] of o.extra ?? []) {
        for (const zone of zonal ? zonesIn(r) : ['regional']) {
          subnets.push({ id: `s-${platform}-${env}-${purpose}-${zone}`, network: id, name: '', purpose, zone, prefix, base: 'next', ipv6: 'no' });
        }
      }
    }
  });
  return { networks, subnets };
}

/** A plan with the user's rows for the given clouds (in their plan or default regions, and DR regions). */
export function withUserNetworks(plan: Plan, platforms: readonly Platform[], o: UserNetworkOptions & { readonly allPlatformSubnets?: boolean } = {}): Plan {
  const all: Partial<Record<Platform, CloudNetworkPlan>> = { ...(plan.networks ?? {}) };
  for (const p of platforms) {
    const region = plan.requirements.regions[p]?.primary?.trim() || DEFAULT_REGIONS[p]?.primary || 'vcenter.example.com';
    const dr = plan.requirements.regions[p]?.dr?.trim();
    all[p] = userNetworks(p, region, { ...o, ...(dr ? { drRegion: dr } : {}), ...(o.allPlatformSubnets ? { extra: [...(o.extra ?? []), ...(ALL_PLATFORM_SUBNETS[p] ?? [])] } : {}) });
  }
  return { ...plan, networks: all };
}
