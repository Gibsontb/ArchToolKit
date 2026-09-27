/**
 * The user-built network rows: the toolkit builds exactly the rows, nothing
 * when there are none, and only validates (it never creates, carves, sizes or
 * suggests a network or a subnet).
 */

import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { itemId } from '../options.ts';
import { defaultRequirements, DEFAULT_WAVE_SETTINGS } from '../options.ts';
import type {
  CloudNetworkPlan, ItemDecision, NetworkRow, Plan, PlanDecision, Platform, Site, SubnetRow, Workload,
} from '../types.ts';
import { designPlan, designWorkloads } from './index.ts';
import {
  CLOUD_NETWORK, blankNetworkRow, blankSubnetRow, hostsHint, moveRow, resolveCloudNetworks, rowPath, subnetZoneChoices, usableOf, withCloudNetworks,
} from './net-rows.ts';
import { tierForRole } from './compute.ts';
import { planToStacks, terraformFiles } from '../generate/terraform.ts';
import { cloudFormationFiles } from '../generate/native/cloudformation.ts';
import { bicepFiles } from '../generate/native/bicep.ts';

// ---------------------------------------------------------------------------
// Fixture: a tier-1 order system (the design page's worked example)
// ---------------------------------------------------------------------------

function workload(name: string, role: Workload['role'], over: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app: 'orders', env: 'prod', role, os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
    criticality: 'tier1', rpo: '15m', rto: '1h', licence: 'li', dependsOn: [], source: 'manual', ...over,
  };
}
const WORKLOADS: readonly Workload[] = [
  ...[1, 2, 3, 4, 5, 6].map((i) => workload(`web0${i}`, 'web')),
  ...[1, 2, 3, 4].map((i) => workload(`app0${i}`, 'app')),
  workload('sql01', 'db', { os: 'win-2022' }), workload('sql02', 'db', { os: 'win-2022' }),
];

function planOf(networks: Partial<Record<Platform, CloudNetworkPlan>> = {}, over: Partial<Plan> = {}, sites: readonly Site[] = []): Plan {
  return {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'plan-net', name: 'Orders', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: WORKLOADS, databases: [], apps: [], edges: [],
    requirements: {
      ...defaultRequirements(),
      regions: { aws: { primary: 'us-east-1' }, azure: { primary: 'eastus' }, google: { primary: 'us-central1' }, oci: { primary: 'us-ashburn-1' } },
      sites, connection: 'vpn',
    },
    designOverrides: {}, waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    ...(Object.keys(networks).length > 0 ? { networks } : {}),
    ...over,
  };
}

function decisionOn(plan: Plan, platform: Platform): PlanDecision {
  const items: Record<string, ItemDecision> = {};
  for (const w of plan.workloads) {
    const chosen = { platform, score: 10, hits: [] };
    items[w.id] = { id: w.id, kind: 'workload', disposition: 'rehost', method: 'rebuild', options: [chosen], chosen, pinned: false, margin: 5, findings: [] };
  }
  return { engineVersion: 'test', platforms: [platform], subsetScores: [], items, findings: [] };
}

const net = (id: string, over: Partial<NetworkRow> = {}): NetworkRow => ({
  id, name: id, role: 'spoke', region: 'us-east-1', env: 'prod', state: 'new', base: '10.40.0.0', prefix: 24, ipv6: 'no', ...over,
});
const sub = (id: string, network: string, purpose: string, zone: string, prefix: number, base: string, over: Partial<SubnetRow> = {}): SubnetRow => ({
  id, network, name: '', purpose, zone, prefix, base, ipv6: 'no', ...over,
});

/** The worked example on AWS: 10.40.0.0/24 for the spoke, /28s for web ×3, app ×3, data ×2 and the Transit Gateway ×3. */
const AWS_EXAMPLE: CloudNetworkPlan = {
  networks: [net('orders')],
  subnets: [
    ...['a', 'b', 'c'].map((z) => sub(`web-${z}`, 'orders', 'web', `us-east-1${z}`, 28, 'next')),
    ...['a', 'b', 'c'].map((z) => sub(`app-${z}`, 'orders', 'app', `us-east-1${z}`, 28, 'next')),
    ...['a', 'b'].map((z) => sub(`db-${z}`, 'orders', 'db', `us-east-1${z}`, 28, 'next')),
    ...['a', 'b', 'c'].map((z) => sub(`tgw-${z}`, 'orders', 'tgw-attachment', `us-east-1${z}`, 28, 'next')),
  ],
};

/** The same application on a regional cloud: one subnet per tier. */
const regional = (region: string, extra: readonly SubnetRow[] = []): CloudNetworkPlan => ({
  networks: [net('orders', { region })],
  subnets: [sub('web', 'orders', 'web', 'regional', 28, 'next'), sub('app', 'orders', 'app', 'regional', 28, 'next'), sub('db', 'orders', 'db', 'regional', 28, 'next'), ...extra],
});

const codes = (plan: Plan, platform: Platform): string[] => designPlan(plan, decisionOn(plan, platform)).findings.map((f) => f.code);
const pdOf = (plan: Plan, platform: Platform) => designPlan(plan, decisionOn(plan, platform)).platforms[0]!;

// ---------------------------------------------------------------------------

describe('network rows: nothing when there are none', () => {
  it('an empty plan has no network, a blocking finding, and nothing is generated', () => {
    for (const p of ['aws', 'azure', 'google', 'oci'] as Platform[]) {
      const plan = planOf();
      const design = designPlan(plan, decisionOn(plan, p));
      expect(design.platforms[0]!.networks).toEqual([]);
      const none = design.findings.filter((f) => f.code === 'design.network.none');
      expect(none).toHaveLength(1);
      expect(none[0]!.severity).toBe('error');
      expect(none[0]!.message).toContain('No network defined for');
      // No VM is placed, no mgmt tier, no domain controller.
      expect(design.platforms[0]!.compute).toEqual([]);
      expect(designWorkloads(plan, design).some((w) => w.role === 'ad-dc')).toBe(false);
      // Generate: nothing for the cloud, and the blocking finding says why.
      const tf = terraformFiles(plan, decisionOn(plan, p), design);
      expect(Object.keys(tf.files).filter((f) => f.startsWith(`terraform/${p}/`))).toEqual([]);
      expect(tf.findings.some((f) => f.code === 'design.network.none')).toBe(true);
    }
    const plan = planOf();
    expect(cloudFormationFiles(plan, decisionOn(plan, 'aws'), designPlan(plan, decisionOn(plan, 'aws'))).files).toEqual({});
    expect(bicepFiles(plan, decisionOn(plan, 'azure'), designPlan(plan, decisionOn(plan, 'azure'))).files).toEqual({});
  });

  it('new rows open empty: nothing chosen, no range, no zone, no size', () => {
    const n = blankNetworkRow();
    expect([n.name, n.role, n.region, n.env, n.state, n.base, n.prefix, n.ipv6]).toEqual(['', '', '', '', '', '', 0, '']);
    const s = blankSubnetRow();
    expect([s.network, s.purpose, s.zone, s.prefix, s.base, s.ipv6]).toEqual(['', '', '', 0, '', '']);
    const r = resolveCloudNetworks({ networks: [n], subnets: [s] }, 'aws', { regions: ['us-east-1'], avoid: [], planId: 'x' });
    expect(r.networks).toEqual([]);
    expect(r.findings.map((f) => f.code)).toEqual(['design.net.network-incomplete', 'design.net.subnet-no-network']);
  });
});

describe('network rows: exactly the rows', () => {
  it('the worked example on AWS: exactly 11 /28 subnets in the /24, zonal, and a VM in each tier', () => {
    const plan = planOf({ aws: AWS_EXAMPLE });
    const pd = pdOf(plan, 'aws');
    expect(pd.networks).toHaveLength(1);
    const n = pd.networks[0]!;
    expect(n.cidr).toBe('10.40.0.0/24');
    expect(n.subnets).toHaveLength(11);
    expect(n.subnets.map((s) => s.cidr)).toEqual(Array.from({ length: 11 }, (_, i) => `10.40.0.${i * 16}/28`));
    expect(n.subnets.map((s) => s.zone)).toEqual(['us-east-1a', 'us-east-1b', 'us-east-1c', 'us-east-1a', 'us-east-1b', 'us-east-1c', 'us-east-1a', 'us-east-1b', 'us-east-1a', 'us-east-1b', 'us-east-1c']);
    for (const s of n.subnets) expect(s.usable).toBe(11);
    expect(n.tiers).toEqual(['web', 'app', 'db']);
    // The VMs land in the subnets of their tier, in those subnets' zones.
    for (const c of pd.compute) {
      expect(n.subnets.some((s) => s.tier === c.tier && s.zone === c.zone)).toBe(true);
    }
    // The database pair spans the two zones its tier has.
    const sql = pd.compute.filter((c) => c.tier === 'db').map((c) => c.zone).sort();
    expect(sql).toEqual(['us-east-1a', 'us-east-1b']);
  });

  it('the generators build exactly those subnets: Terraform, CloudFormation', () => {
    const plan = planOf({ aws: AWS_EXAMPLE });
    const decision = decisionOn(plan, 'aws');
    const design = designPlan(plan, decision);
    const stacks = planToStacks(plan, decision, design, { scope: 'landing-zone' });
    const lz = stacks.perPlatform.aws!.items.find((i) => i.blueprintId === 'aws_mig_landing_zone')!;
    const grid = String(lz.values.subnets).split('\n');
    expect(grid).toHaveLength(11);
    expect(grid[0]).toBe('orders | web-a | web | us-east-1a | 10.40.0.0/28 | no');
    const tf = terraformFiles(plan, decision, design, { scope: 'landing-zone' });
    const main = Object.entries(tf.files).filter(([f]) => f.startsWith('terraform/aws/') && f.endsWith('.tf')).map(([, t]) => t).join('\n');
    expect((main.match(/^resource "aws_subnet"/gm) ?? []).length).toBe(11);
    expect((main.match(/^resource "aws_vpc"/gm) ?? []).length).toBe(1);
    expect(tf.findings.filter((f) => f.severity === 'error')).toEqual([]);
    const cfn = Object.values(cloudFormationFiles(plan, decision, design).files).join('\n');
    expect((cfn.match(/Type: AWS::EC2::Subnet$/gm) ?? []).length).toBe(11);
  });

  it('the same app on Azure: 3 regional subnets; the hub\'s platform subnets only when the user adds them', () => {
    const plan = planOf({ azure: regional('eastus') });
    const pd = pdOf(plan, 'azure');
    expect(pd.networks[0]!.subnets.map((s) => [s.tier, s.zone])).toEqual([['web', ''], ['app', ''], ['db', '']]);
    expect(pd.networks[0]!.subnets.some((s) => /Subnet$/.test(s.tier))).toBe(false);
    const withHub = planOf({ azure: {
      networks: [net('hub', { region: 'eastus', role: 'hub', base: '10.50.0.0', prefix: 24 }), net('orders', { region: 'eastus', base: '10.40.0.0' })],
      subnets: [
        sub('gw', 'hub', 'GatewaySubnet', 'regional', 27, 'next'), sub('fw', 'hub', 'AzureFirewallSubnet', 'regional', 26, 'next'), sub('bas', 'hub', 'AzureBastionSubnet', 'regional', 26, 'next'),
        ...regional('eastus').subnets,
      ],
    } });
    const hub = pdOf(withHub, 'azure').networks.find((n) => n.name === 'hub')!;
    expect(hub.subnets.map((s) => [s.name, s.cidr])).toEqual([['GatewaySubnet', '10.50.0.0/27'], ['AzureFirewallSubnet', '10.50.0.64/26'], ['AzureBastionSubnet', '10.50.0.128/26']]);
    // Bicep builds exactly those subnets.
    const decision = decisionOn(withHub, 'azure');
    const files = bicepFiles(withHub, decision, designPlan(withHub, decision)).files;
    const text = Object.values(files).join('\n');
    for (const name of ['GatewaySubnet', 'AzureFirewallSubnet', 'AzureBastionSubnet']) expect(text).toContain(`'${name}'`);
  });

  it('Google Cloud and OCI subnets are regional too', () => {
    for (const [p, region] of [['google', 'us-central1'], ['oci', 'us-ashburn-1']] as const) {
      const pd = pdOf(planOf({ [p]: regional(region) }), p);
      expect(pd.networks[0]!.subnets.every((s) => s.zone === '')).toBe(true);
      expect(pd.networks[0]!.subnets).toHaveLength(3);
      expect(CLOUD_NETWORK[p].regional).toBe(true);
    }
    expect(CLOUD_NETWORK.aws.regional).toBe(false);
  });

  it('no mgmt tier and no domain controller that the user did not add', () => {
    for (const p of ['aws', 'azure'] as Platform[]) {
      const plan = planOf(p === 'aws' ? { aws: AWS_EXAMPLE } : { azure: regional('eastus') });
      const design = designPlan(plan, decisionOn(plan, p));
      const pd = design.platforms[0]!;
      expect(pd.networks.flatMap((n) => n.subnets).some((s) => s.tier === 'mgmt')).toBe(false);
      expect(pd.identity.dcNames).toEqual([]);
      expect(pd.compute.some((c) => /dc0\d$/.test(c.workload))).toBe(false);
    }
  });

  it('usable addresses follow each cloud\'s reservation', () => {
    expect([usableOf('aws', 28), usableOf('azure', 29), usableOf('google', 29), usableOf('oci', 30)]).toEqual([11, 3, 4, 1]);
  });

  it('the hint counts the hosts per tier from the inventory, and is never applied', () => {
    const plan = planOf({ aws: AWS_EXAMPLE });
    expect(hostsHint(plan, decisionOn(plan, 'aws'), 'aws', tierForRole)).toEqual({ byTier: { web: 6, app: 4, db: 2 }, total: 12 });
    expect(hostsHint(plan, decisionOn(plan, 'aws'), 'azure', tierForRole).total).toBe(0);
  });

  it('rows are stored per cloud, reordered and removed', () => {
    const plan = withCloudNetworks(planOf(), 'aws', AWS_EXAMPLE);
    expect(plan.networks?.aws?.subnets).toHaveLength(11);
    expect(moveRow(AWS_EXAMPLE.subnets, 'app-a', -3).map((s) => s.id).slice(0, 2)).toEqual(['app-a', 'web-a']);
    expect(withCloudNetworks(plan, 'aws', { networks: [], subnets: [] }).networks).toBeUndefined();
  });
});

describe('network rows: every check fires', () => {
  const avoid = (plan: Plan) => plan;

  it('overlap: between rows, with the on-premises ranges, and across clouds', () => {
    const two = planOf({ aws: { networks: [net('a'), net('b', { base: '10.40.0.0', prefix: 16 })], subnets: [] } });
    expect(codes(two, 'aws')).toContain('design.net.network-overlap');
    const site: Site = { name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.40.0.0/16'], bandwidth: '1g', circuit: 'none' };
    expect(codes(avoid(planOf({ aws: AWS_EXAMPLE }, {}, [site])), 'aws')).toContain('design.net.network-avoid-overlap');
    // Across clouds: AWS and Azure both on 10.40.0.0/24.
    const both = planOf({ aws: AWS_EXAMPLE, azure: regional('eastus') });
    const d: PlanDecision = { ...decisionOn(both, 'aws'), platforms: ['aws', 'azure'] };
    const cross = designPlan(both, d).findings.filter((f) => f.code === 'design.network.cross-platform-overlap');
    expect(cross).toHaveLength(1);
    expect(cross[0]!.severity).toBe('error');
    // Two subnets on the same block.
    const clash = planOf({ aws: { networks: [net('a')], subnets: [sub('x', 'a', 'web', 'us-east-1a', 28, '10.40.0.0'), sub('y', 'a', 'app', 'us-east-1a', 28, '10.40.0.0')] } });
    expect(codes(clash, 'aws')).toContain('design.net.subnet-overlap');
  });

  it('a subnet outside its network, or larger than it', () => {
    const out = planOf({ aws: { networks: [net('a')], subnets: [sub('x', 'a', 'web', 'us-east-1a', 28, '10.41.0.0')] } });
    expect(codes(out, 'aws')).toContain('design.net.subnet-outside');
    const big = planOf({ aws: { networks: [net('a')], subnets: [sub('x', 'a', 'web', 'us-east-1a', 23, '10.40.0.0')] } });
    expect(codes(big, 'aws')).toContain('design.net.subnet-larger-than-network');
    const full = planOf({ aws: { networks: [net('a', { prefix: 27 })], subnets: [sub('x', 'a', 'web', 'us-east-1a', 28, 'next'), sub('y', 'a', 'web', 'us-east-1b', 28, 'next'), sub('z', 'a', 'app', 'us-east-1a', 28, 'next')] } });
    expect(codes(full, 'aws')).toContain('design.net.subnet-no-room');
  });

  it('a size below the cloud\'s minimum or above its maximum', () => {
    const small = planOf({ aws: { networks: [net('a')], subnets: [sub('x', 'a', 'web', 'us-east-1a', 29, '10.40.0.0')] } });
    expect(codes(small, 'aws')).toContain('design.net.subnet-size');
    const vpc = planOf({ aws: { networks: [net('a', { base: '10.0.0.0', prefix: 15 })], subnets: [] } });
    expect(codes(vpc, 'aws')).toContain('design.net.network-size');
    const oci = planOf({ oci: { networks: [net('a', { region: 'us-ashburn-1' })], subnets: [sub('x', 'a', 'web', 'regional', 30, '10.40.0.0')] } });
    expect(codes(oci, 'oci')).not.toContain('design.net.subnet-size');
  });

  it('an Azure platform subnet smaller than Azure requires', () => {
    for (const [purpose, prefix] of [['GatewaySubnet', 28], ['AzureFirewallSubnet', 27], ['AzureBastionSubnet', 27], ['AzureFirewallManagementSubnet', 27]] as const) {
      const plan = planOf({ azure: { networks: [net('hub', { region: 'eastus', role: 'hub' })], subnets: [sub('x', 'hub', purpose, 'regional', prefix, 'next')] } });
      expect([purpose, codes(plan, 'azure').includes('design.net.subnet-too-small')]).toEqual([purpose, true]);
    }
    const ok = planOf({ azure: { networks: [net('hub', { region: 'eastus', role: 'hub' })], subnets: [sub('x', 'hub', 'GatewaySubnet', 'regional', 27, 'next')] } });
    expect(codes(ok, 'azure')).not.toContain('design.net.subnet-too-small');
  });

  it('a platform subnet a chosen service needs is missing', () => {
    const site: Site = { name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['192.168.0.0/16'], bandwidth: '1g', circuit: 'none' };
    const plan = planOf({ azure: regional('eastus') }, {}, [site]);
    expect(codes(plan, 'azure')).toContain('design.net.azure-gateway-subnet');
    const fixed = planOf({ azure: regional('eastus', [sub('gw', 'orders', 'GatewaySubnet', 'regional', 27, 'next')]) }, {}, [site]);
    expect(codes(fixed, 'azure')).not.toContain('design.net.azure-gateway-subnet');
    // Azure Bastion chosen with no AzureBastionSubnet: a warning, and no Bastion host.
    expect(codes(plan, 'azure')).toContain('design.net.azure-bastion-subnet');
  });

  it('a zone on a regional cloud, and no zone on AWS', () => {
    const az = planOf({ azure: { networks: [net('a', { region: 'eastus' })], subnets: [sub('x', 'a', 'web', '1', 28, 'next')] } });
    expect(codes(az, 'azure')).toContain('design.net.subnet-regional');
    const gcp = planOf({ google: { networks: [net('a', { region: 'us-central1' })], subnets: [sub('x', 'a', 'web', 'us-central1-a', 28, 'next')] } });
    expect(codes(gcp, 'google')).toContain('design.net.subnet-regional');
    const aws = planOf({ aws: { networks: [net('a')], subnets: [sub('x', 'a', 'web', 'regional', 28, 'next')] } });
    expect(codes(aws, 'aws')).toContain('design.net.subnet-zonal');
    // The zone dropdowns offer only what the cloud has.
    expect(subnetZoneChoices('azure', 'eastus').map((z) => z.value)).toEqual(['regional']);
    expect(subnetZoneChoices('google', 'us-central1').map((z) => z.value)).toEqual(['regional']);
    expect(subnetZoneChoices('aws', 'us-east-1').every((z) => z.value.startsWith('us-east-1'))).toBe(true);
  });

  it('unaligned bases, IPv6 in an IPv4 network, an existing network without its id or with subnets', () => {
    const un = planOf({ aws: { networks: [net('a', { base: '10.40.0.5' })], subnets: [] } });
    expect(codes(un, 'aws')).toContain('design.net.network-aligned');
    const v6 = planOf({ aws: { networks: [net('a')], subnets: [sub('x', 'a', 'web', 'us-east-1a', 28, 'next', { ipv6: 'yes' })] } });
    expect(codes(v6, 'aws')).toContain('design.net.subnet-ipv6');
    const noId = planOf({ aws: { networks: [net('a', { state: 'existing' })], subnets: [] } });
    expect(codes(noId, 'aws')).toContain('design.net.network-existing-id');
    const inExisting = planOf({ aws: { networks: [net('hub', { state: 'existing', existingId: 'tgw-0123', role: 'hub', base: '10.50.0.0' }), ...AWS_EXAMPLE.networks], subnets: [sub('x', 'hub', 'web', 'us-east-1a', 28, 'next'), ...AWS_EXAMPLE.subnets] } });
    expect(codes(inExisting, 'aws')).toContain('design.net.subnet-in-existing');
    // The existing hub is attached to, not built.
    const pd = pdOf(inExisting, 'aws');
    expect(pd.networks.find((n) => n.name === 'hub')!.existingId).toBe('tgw-0123');
    const tf = terraformFiles(inExisting, decisionOn(inExisting, 'aws'), designPlan(inExisting, decisionOn(inExisting, 'aws')), { scope: 'landing-zone' });
    const main = Object.entries(tf.files).filter(([f]) => f.startsWith('terraform/aws/') && f.endsWith('.tf')).map(([, t]) => t).join('\n');
    expect((main.match(/^resource "aws_vpc"/gm) ?? []).length).toBe(1);
    expect(main).toContain('transit_gateway_id = "tgw-0123"');
  });

  it('a region that is neither the primary nor the DR region', () => {
    const plan = planOf({ aws: { networks: [net('a', { region: 'eu-west-1' })], subnets: [] } });
    expect(codes(plan, 'aws')).toContain('design.net.network-region');
  });

  it('every check is keyed to its row, for the editor', () => {
    const plan = planOf({ aws: { networks: [net('a')], subnets: [sub('x', 'a', 'web', 'us-east-1a', 29, '10.40.0.0')] } });
    const f = designPlan(plan, decisionOn(plan, 'aws')).findings.find((x) => x.code === 'design.net.subnet-size')!;
    expect(f.path).toBe(rowPath('aws', 'x'));
  });
});
