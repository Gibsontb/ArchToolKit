import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { parseCidrAny, overlapsAny, containsAny } from '../../../core/ip.ts';
import { AWS_DB_INSTANCE_CLASS_GROUPS, AWS_INSTANCE_TYPE_GROUPS, AZURE_VM_SIZE_GROUPS, GCP_MACHINE_TYPE_GROUPS, OCI_SHAPE_GROUPS } from '../../../kit/sizes-data.ts';
import { AZURE_CONSTRAINED_LADDER } from '../../../kit/rightsize.ts';
import { emitFoundation } from '../../../terraform/index.ts';
import { BACKUP_TIER_BY_CRITICALITY, defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId, VM_SERVICE } from '../index.ts';
import type {
  Database, DbServiceId, ItemDecision, Method, Plan, PlanDecision, Platform, PlatformDesign, Requirements, TargetDesign, Workload,
} from '../types.ts';
import {
  carveSubnets, classFor, classInCatalog, cloudSqlTier, designPlan, designWorkloads, DESIGN_MAPPERS, foundationPlansFor, insertMapper,
  rdsClass, sizeInCatalog, ula48, type DesignMapper,
} from './index.ts';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const HYPERSCALERS: readonly Platform[] = ['aws', 'azure', 'google', 'oci'];

function workload(name: string, over: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app: 'shop', env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
  };
}
function database(name: string, over: Partial<Database> = {}): Database {
  return {
    id: itemId('database', name), name, engine: 'postgres', edition: 'community', version: 'pg-16', hosts: [], vcpu: 4, ramGib: 32,
    sizeGib: 200, ha: 'none', dr: 'none', features: [], licence: 'community', app: 'shop', source: 'manual', ...over,
  };
}

const WORKLOADS: readonly Workload[] = [
  workload('web01', { role: 'web', os: 'win-2022', criticality: 'tier1', disksGib: [128] }),
  workload('web02', { role: 'web', os: 'win-2022', criticality: 'tier1', disksGib: [128] }),
  workload('app01', { vcpu: 4, ramGib: 16, disksGib: [64, 100], licence: 'rhel-byos' }),
  workload('ora01', { role: 'db', os: 'ol-8', vcpu: 16, ramGib: 128, disksGib: [100, 500], criticality: 'tier0', licence: 'free' }),
  workload('ora02', { role: 'db', os: 'ol-8', vcpu: 16, ramGib: 128, disksGib: [100, 500], criticality: 'tier0', licence: 'free' }),
  workload('dev01', { env: 'dev', os: 'ubuntu-22.04', criticality: 'tier3' }),
  workload('batch01', { role: 'batch', os: 'debian-12', criticality: 'tier3' }),
];
const DATABASES: readonly Database[] = [
  database('ORA', { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', hosts: ['ora01', 'ora02'], vcpu: 16, ramGib: 128, sizeGib: 500, ha: 'data-guard-local', licence: 'oracle-processor' }),
  database('SALES', { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2022', vcpu: 8, ramGib: 64, ha: 'sql-ag', licence: 'byol-sa' }),
  database('PG', { ha: 'pg-streaming' }),
];

const SQL_SERVICE: Readonly<Record<Platform, DbServiceId>> = { aws: 'aws-rds', azure: 'azure-sqlmi', google: 'google-cloudsql', oci: 'oci-compute', vmware: 'vmware-vm' };
const PG_SERVICE: Readonly<Record<Platform, DbServiceId>> = { aws: 'aws-rds', azure: 'azure-pg-flex', google: 'google-cloudsql', oci: 'oci-pg', vmware: 'vmware-vm' };

function item(id: string, kind: 'workload' | 'database', platform: Platform, method: Method, service?: DbServiceId): ItemDecision {
  const chosen = { platform, score: 10, hits: [], ...(service ? { service } : {}) };
  return { id, kind, disposition: method === 'relocate-hcx' ? 'relocate' : 'rehost', method, options: [chosen], chosen, pinned: false, margin: 5, findings: [] };
}

/** Everything on one platform: web replicated, the rest rebuilt; the DBs on each platform's service. */
function decisionFor(plan: Plan, platform: Platform): PlanDecision {
  const items: Record<string, ItemDecision> = {};
  for (const w of plan.workloads) items[w.id] = item(w.id, 'workload', platform, w.role === 'web' ? 'replicate' : 'rebuild');
  for (const db of plan.databases) {
    const service = db.engine === 'oracle' ? VM_SERVICE[platform] : db.engine === 'sqlserver' ? SQL_SERVICE[platform] : PG_SERVICE[platform];
    items[db.id] = item(db.id, 'database', platform, service === VM_SERVICE[platform] ? 'rebuild' : 'managed-db', service);
  }
  return { engineVersion: 'test', platforms: [platform], subsetScores: [], items, findings: [] };
}

function planWith(over: Partial<Plan> = {}, req: Partial<Requirements> = {}): Plan {
  return {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'plan-1234', name: 'Shop Move', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: WORKLOADS, databases: DATABASES, apps: [], edges: [],
    requirements: { ...defaultRequirements(), ...req },
    designOverrides: {}, waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    ...over,
  };
}

const designOn = (platform: Platform, plan: Plan = planWith()): { design: TargetDesign; pd: PlatformDesign } => {
  const design = designPlan(plan, decisionFor(plan, platform));
  return { design, pd: design.platforms.find((p) => p.platform === platform)! };
};
const targetOf = (pd: PlatformDesign, name: string) => pd.compute.find((c) => c.workload === itemId('workload', name));

const set = (groups: Readonly<Record<string, string>>): Set<string> => new Set(Object.values(groups).flatMap((v) => v.split(',')));
const CATALOG: Readonly<Record<Exclude<Platform, 'vmware'>, Set<string>>> = {
  aws: set(AWS_INSTANCE_TYPE_GROUPS), azure: set(AZURE_VM_SIZE_GROUPS), google: set(GCP_MACHINE_TYPE_GROUPS), oci: set(OCI_SHAPE_GROUPS),
};

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

describe('design/network: carveSubnets', () => {
  it("carves 12 non-overlapping /22s from 10.10.0.0/16, tier-major", () => {
    const s = carveSubnets('10.10.0.0/16', ['web', 'app', 'db', 'mgmt'], 3, 22);
    expect(s).toHaveLength(12);
    expect(s.map((x) => `${x.tier}-${x.zone}`)).toEqual([
      'web-a', 'web-b', 'web-c', 'app-a', 'app-b', 'app-c', 'db-a', 'db-b', 'db-c', 'mgmt-a', 'mgmt-b', 'mgmt-c',
    ]);
    expect(s[0]!.cidr).toBe('10.10.0.0/22');
    expect(s[1]!.cidr).toBe('10.10.4.0/22');
    expect(s[3]!.cidr).toBe('10.10.12.0/22');
    expect(s[11]!.cidr).toBe('10.10.44.0/22');
    for (let i = 0; i < s.length; i += 1) {
      expect(parseCidrAny(s[i]!.cidr)!.prefix).toBe(22);
      expect(containsAny('10.10.0.0/16', s[i]!.cidr.split('/')[0]!)).toBe(true);
      for (let j = i + 1; j < s.length; j += 1) expect(overlapsAny(s[i]!.cidr, s[j]!.cidr)).toBe(false);
    }
  });

  it('takes zone names, and refuses what does not fit', () => {
    expect(carveSubnets('10.0.0.0/24', ['web'], ['1', '2'], 26).map((x) => `${x.zone}=${x.cidr}`)).toEqual(['1=10.0.0.0/26', '2=10.0.0.64/26']);
    expect(() => carveSubnets('10.0.0.0/24', ['web', 'app', 'db', 'mgmt'], 3, 26)).toThrow(RangeError);
    expect(() => carveSubnets('2001:db8::/48', ['web'], 1, 64)).toThrow(RangeError);
  });
});

describe('design/network: networks, dual stack and the site check', () => {
  it('gives every hyperscaler a prod network (and nonprod for the dev workload), IPv6 on', () => {
    for (const p of HYPERSCALERS) {
      const { pd } = designOn(p);
      expect(pd.networks.map((n) => n.name)).toEqual(['prod', 'nonprod']);
      for (const n of pd.networks) expect(n.ipv6).toBe(true);
      const base = { aws: 10, azure: 20, google: 30, oci: 40 }[p as 'aws'];
      expect(pd.networks[0]!.cidr).toBe(`10.${base}.0.0/16`);
      expect(pd.networks[1]!.cidr).toBe(`10.${base + 1}.0.0/16`);
      // prod: 4 tiers × 3 zones; nonprod: 4 tiers × 1 zone.
      expect(pd.networks[0]!.subnets.filter((s) => pd.networks[0]!.tiers.includes(s.tier as 'web'))).toHaveLength(12);
      expect(pd.networks[1]!.subnets).toHaveLength(4);
    }
  });

  it('AWS, Google and OCI allocate IPv6: no range is written', () => {
    for (const p of ['aws', 'google', 'oci'] as Platform[]) {
      const { pd } = designOn(p);
      for (const n of pd.networks) {
        expect(n.ipv6Cidr).toBeUndefined();
        for (const s of n.subnets) expect(s.ipv6Cidr).toBeUndefined();
      }
    }
  });

  it('Azure gets a ULA /48 per network, stable for the plan id, with a /64 per subnet inside it', () => {
    const a = designOn('azure').pd;
    const again = designOn('azure').pd;
    const other = designOn('azure', planWith({ id: 'another-plan' })).pd;
    for (const n of a.networks) {
      const c = parseCidrAny(n.ipv6Cidr!)!;
      expect(c.family).toBe(6);
      expect(c.prefix).toBe(48);
      expect(/^fd[0-9a-f]{2}:/.test(n.ipv6Cidr!)).toBe(true);
      for (const s of n.subnets.filter((x) => n.tiers.includes(x.tier as 'web'))) {
        expect(parseCidrAny(s.ipv6Cidr!)!.prefix).toBe(64);
        expect(overlapsAny(n.ipv6Cidr!, s.ipv6Cidr!)).toBe(true);
      }
    }
    expect(a.networks.map((n) => n.ipv6Cidr)).toEqual(again.networks.map((n) => n.ipv6Cidr));
    expect(a.networks[0]!.ipv6Cidr === other.networks[0]!.ipv6Cidr).toBe(false);
    expect(a.networks[0]!.ipv6Cidr === a.networks[1]!.ipv6Cidr).toBe(false);
    expect(ula48('plan-1234', 'azure', 'prod')).toBe(a.networks[0]!.ipv6Cidr!);
  });

  it('Azure reserves AzureBastionSubnet (/26) and, with sites, GatewaySubnet (/27) after the tier subnets', () => {
    const site = { name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['192.168.0.0/16'], bandwidth: '1g' as const, circuit: 'none' as const };
    const pd = designOn('azure', planWith({}, { sites: [site] })).pd;
    const prod = pd.networks[0]!;
    const bastion = prod.subnets.find((s) => s.tier === 'AzureBastionSubnet')!;
    const gateway = prod.subnets.find((s) => s.tier === 'GatewaySubnet')!;
    expect(bastion.cidr).toBe('10.20.48.0/26');
    expect(gateway.cidr).toBe('10.20.48.64/27');
    // Kept out of the FoundationPlan (the landing zone adds them by their exact names).
    for (const fp of foundationPlansFor(pd, 'azure')) expect(fp.subnets.some((s) => s.name.includes('Subnet'))).toBe(false);
  });

  it('an overlap with a site CIDR is an error finding; no overlap, none', () => {
    const clash = { name: 'hq', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.10.8.0/24', 'fd00::/8'], bandwidth: '1g' as const, circuit: 'none' as const };
    const bad = designOn('aws', planWith({}, { sites: [clash] })).design;
    const hit = bad.findings.filter((f) => f.code === 'design.network.site-overlap');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.severity).toBe('error');
    // Azure's ULA is inside fd00::/8, so the IPv6 side overlaps too.
    const az = designOn('azure', planWith({}, { sites: [clash] })).design;
    expect(az.findings.filter((f) => f.code === 'design.network.site-overlap').length).toBeGreaterThanOrEqual(2);
    const fine = designOn('aws', planWith({}, { sites: [{ ...clash, cidrs: ['192.168.0.0/16'] }] })).design;
    expect(fine.findings.some((f) => f.code === 'design.network.site-overlap')).toBe(false);
  });

  it('foundationPlansFor gives plans emitFoundation takes without error', () => {
    const site = { name: 'hq', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['192.168.0.0/16', '2001:db8:1::/48'], bandwidth: '1g' as const, circuit: 'none' as const };
    const plan = planWith({}, { sites: [site] });
    for (const p of ['aws', 'azure', 'google'] as Platform[]) {
      const { design } = designOn(p, plan);
      const fps = foundationPlansFor(design, p, plan);
      expect(fps).toHaveLength(2);
      expect(fps[0]!.allowedIngressCidrs).toEqual(['192.168.0.0/16', '2001:db8:1::/48']);
      expect(fps[0]!.allowedTcpPorts).toEqual([22, 443, 3389, 5986]);
      for (const fp of fps) {
        const out = emitFoundation(p as 'aws' | 'azure' | 'google', fp);
        expect(out.findings.filter((f) => f.severity === 'error')).toEqual([]);
        expect(Object.keys(out.files).length).toBeGreaterThan(0);
      }
    }
    expect(designOn('aws', plan).design.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

describe('design/compute', () => {
  it('maps the licence-optimised Oracle host (16 vCPU / 128 GiB) on all four clouds', () => {
    const aws = targetOf(designOn('aws').pd, 'ora01')!;
    expect(aws.size).toBe('r7i.4xlarge');
    expect(aws.coreCount).toBe(8);
    const az = targetOf(designOn('azure').pd, 'ora01')!;
    expect(az.size).toBe('Standard_E16-8ds_v5');
    expect(AZURE_CONSTRAINED_LADDER.find((c) => c.name === az.size)!.parent).toBe('Standard_E16ds_v5');
    expect(CATALOG.azure.has('Standard_E16ds_v5')).toBe(true);
    const gcp = targetOf(designOn('google').pd, 'ora01')!;
    expect(gcp.size).toBe('n2-highmem-16');
    expect(gcp.coreCount).toBe(8);
    const oci = targetOf(designOn('oci').pd, 'ora01')!;
    expect(oci.size).toBe('VM.Standard.E5.Flex');
    expect(oci.ocpus).toBe(8);
  });

  it('a host that is not a per-core BYOL database host is sized normally', () => {
    expect(targetOf(designOn('aws').pd, 'app01')!.coreCount).toBeUndefined();
    expect(targetOf(designOn('aws').pd, 'app01')!.size).toBe('m7i.xlarge');
  });

  it('every chosen size exists in the platform catalog (sizes-data.ts)', () => {
    for (const p of HYPERSCALERS) {
      const { pd } = designOn(p);
      expect(pd.compute.length).toBeGreaterThan(0);
      for (const c of pd.compute) {
        const constrained = AZURE_CONSTRAINED_LADDER.find((x) => x.name === c.size);
        expect(CATALOG[p as 'aws'].has(constrained ? constrained.parent : c.size)).toBe(true);
        expect(sizeInCatalog(p, c.size)).toBe(true);
      }
    }
  });

  it('assigns tiers by role, networks by environment, and spreads an HA pair across zones', () => {
    const { pd } = designOn('aws');
    expect(targetOf(pd, 'web01')!.tier).toBe('web');
    expect(targetOf(pd, 'batch01')!.tier).toBe('app');
    expect(targetOf(pd, 'ora01')!.tier).toBe('db');
    expect(targetOf(pd, 'dev01')!.network).toBe('nonprod');
    expect(targetOf(pd, 'ora01')!.zone === targetOf(pd, 'ora02')!.zone).toBe(false);
    // The app's members are spread: web01 and web02 in different zones.
    expect(targetOf(pd, 'web01')!.zone === targetOf(pd, 'web02')!.zone).toBe(false);
  });

  it('disks follow the platform table, boot first', () => {
    expect(targetOf(designOn('aws').pd, 'ora01')!.disks).toEqual([{ gib: 100, type: 'gp3' }, { gib: 500, type: 'io2' }]);
    expect(targetOf(designOn('azure').pd, 'ora01')!.disks).toEqual([{ gib: 100, type: 'Premium_LRS' }, { gib: 500, type: 'PremiumV2_LRS' }]);
    expect(targetOf(designOn('google').pd, 'ora01')!.disks[1]!.type).toBe('pd-ssd');
    expect(targetOf(designOn('oci').pd, 'app01')!.disks).toEqual([{ gib: 64, type: 'balanced' }, { gib: 100, type: 'balanced' }]);
    expect(targetOf(designOn('azure').pd, 'web01')!.disks[0]).toEqual({ gib: 128, type: 'Premium_LRS' });
  });

  it('images: replicated for replicate, the catalog image for rebuild, BYOS images for BYOS Linux', () => {
    const { pd } = designOn('aws');
    expect(targetOf(pd, 'web01')!.image.kind).toBe('replicated');
    expect(targetOf(pd, 'dev01')!.image).toEqual({ kind: 'aws-ssm', parameter: '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id' });
    expect(targetOf(pd, 'app01')!.image.kind).toBe('custom');
    expect(targetOf(pd, 'app01')!.licenceHandling).toBe('RHEL BYOS (Red Hat Cloud Access image)');
    expect(targetOf(designOn('azure').pd, 'app01')!.licenceHandling).toBe('RHEL_BYOS (license_type)');
  });

  it('licence handling: AHB on Azure with SA, dedicated host for pre-2019 BYOL on AWS', () => {
    const sa = planWith({ workloads: [workload('win01', { os: 'win-2022', licence: 'byol-sa' })], databases: [] });
    expect(targetOf(designOn('azure', sa).pd, 'win01')!.licenceHandling).toBe('AHB (license_type = Windows_Server)');
    const old = planWith(
      { workloads: [workload('win02', { os: 'win-2019', licence: 'byol-perpetual' })], databases: [] },
      { licensing: { ...defaultRequirements().licensing, windowsPre2019Licences: true } },
    );
    const t = targetOf(designOn('aws', old).pd, 'win02')!;
    expect(t.licenceHandling).toBe('Dedicated host (BYOL pre-2019)');
    expect(t.dedicatedHost).toBe(true);
    expect(t.image.kind).toBe('custom');
    // Without pre-2019 licences the licence is stranded: licence included, LI image.
    const li = targetOf(designOn('aws', planWith({ workloads: [workload('win03', { os: 'win-2019', licence: 'byol-perpetual' })], databases: [] })).pd, 'win03')!;
    expect(li.licenceHandling).toBe('LI');
    expect(li.image.kind).toBe('aws-ssm');
  });

  it('every compute target has the backup tier its criticality gives', () => {
    for (const p of HYPERSCALERS) {
      const plan = planWith();
      const design = designPlan(plan, decisionFor(plan, p));
      const all = designWorkloads(plan, design);
      const pd = design.platforms[0]!;
      for (const c of pd.compute) {
        const w = all.find((x) => x.id === c.workload)!;
        expect(c.backupTier).toBe(BACKUP_TIER_BY_CRITICALITY[w.criticality]);
        expect(pd.backup.tiers.some((t) => t.tier === c.backupTier)).toBe(true);
      }
      for (const d of pd.databases) expect(pd.backup.tiers.some((t) => t.tier === d.backupTier)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const RDS = set(AWS_DB_INSTANCE_CLASS_GROUPS);

describe('design/database', () => {
  it('maps each database to its service with a catalogued class', () => {
    const aws = designOn('aws').pd;
    const sales = aws.databases.find((d) => d.database === itemId('database', 'SALES'))!;
    expect(sales.service).toBe('aws-rds');
    expect(sales.classOrShape).toBe('db.r7i.2xlarge');
    expect(RDS.has(sales.classOrShape)).toBe(true);
    expect(sales.ha).toBe('multi-az');
    // RDS for SQL Server is licence-included only: the SA licence is not used there.
    expect(sales.licenceModel).toBe('license-included');
    expect(sales.engineVersion).toBe('16.00.4185.3.v1');
    const pg = aws.databases.find((d) => d.database === itemId('database', 'PG'))!;
    expect(pg.licenceModel).toBe('postgresql-license');
    expect(pg.engineVersion).toBe('16');

    const gcp = designOn('google').pd;
    const gsales = gcp.databases.find((d) => d.database === itemId('database', 'SALES'))!;
    // 64 GiB is over 6.5 GiB per vCPU at 8, so 10 vCPU.
    expect(gsales.classOrShape).toBe('db-custom-10-65536');
    expect(gsales.engineVersion).toBe('SQLSERVER_2022_ENTERPRISE');
    expect(gsales.ha).toBe('regional');
    expect(classInCatalog('google-cloudsql', gsales.classOrShape)).toBe(true);

    const az = designOn('azure').pd;
    const mi = az.databases.find((d) => d.database === itemId('database', 'SALES'))!;
    expect(mi.classOrShape).toBe('BC_Gen5_8');
    expect(mi.ha).toBe('business-critical');
    expect(mi.licenceModel).toBe('BasePrice');
    expect(az.databases.find((d) => d.database === itemId('database', 'PG'))!.classOrShape).toBe('MO_Standard_E4ds_v5');

    const oci = designOn('oci').pd;
    expect(oci.databases.find((d) => d.database === itemId('database', 'PG'))!.classOrShape).toBe('PostgreSQL.VM.Standard.E5.Flex:2');
  });

  it('an IaaS database is carried by its hosts', () => {
    for (const p of HYPERSCALERS) {
      const { pd } = designOn(p);
      const ora = pd.databases.find((d) => d.database === itemId('database', 'ORA'))!;
      expect(ora.service).toBe(VM_SERVICE[p]);
      expect(ora.hosts).toEqual([itemId('workload', 'ora01'), itemId('workload', 'ora02')]);
      expect(ora.classOrShape).toBe(targetOf(pd, 'ora01')!.size);
      expect(ora.ha).toBe('data-guard-local');
    }
    // Counted on the host as designed: Azure's constrained size licenses 8 vCPU, so 4 processors.
    expect(designOn('aws').pd.databases.find((d) => d.database === itemId('database', 'ORA'))!.licenceModel).toBe('BYOL: 8 oracle-processor');
    expect(designOn('azure').pd.databases.find((d) => d.database === itemId('database', 'ORA'))!.licenceModel).toBe('BYOL: 4 oracle-processor');
    expect(designOn('oci').pd.databases.find((d) => d.database === itemId('database', 'ORA'))!.licenceModel).toBe('BRING_YOUR_OWN_LICENSE');
  });

  it('every RDS class and Cloud SQL tier the mapper can produce exists', () => {
    for (const cpu of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96]) {
      for (const perCpu of [1, 2, 4, 6, 8]) {
        for (const service of ['aws-rds', 'aws-aurora', 'aws-rds-custom'] as DbServiceId[]) {
          const c = rdsClass(service, cpu, cpu * perCpu);
          if (c) expect(RDS.has(c)).toBe(true);
        }
        const t = cloudSqlTier(cpu, cpu * perCpu);
        if (t) expect(classInCatalog('google-cloudsql', t)).toBe(true);
        for (const s of ['azure-pg-flex', 'azure-mysql-flex'] as DbServiceId[]) {
          const f = classFor(s, { vcpu: cpu, ramGib: cpu * perCpu, ha: 'none' });
          if (f) expect(classInCatalog(s, f)).toBe(true);
        }
      }
    }
    expect(rdsClass('aws-rds', 4, 16)).toBe('db.m7i.xlarge');
    expect(rdsClass('aws-rds-custom', 8, 64)).toBe('db.r6i.2xlarge');
    expect(cloudSqlTier(3, 2)).toBe('db-custom-4-3840');
    expect(cloudSqlTier(2, 16)).toBe('db-custom-4-16384');
    expect(cloudSqlTier(1, 1)).toBe('db-custom-1-3840');
  });
});

// ---------------------------------------------------------------------------
// Identity, connectivity, relocate, backup
// ---------------------------------------------------------------------------

describe('design/identity', () => {
  it('extend-dcs adds two DCs per platform, in different zones, mgmt tier, Windows Server 2025', () => {
    for (const p of HYPERSCALERS) {
      const plan = planWith();
      const design = designPlan(plan, decisionFor(plan, p));
      const pd = design.platforms[0]!;
      expect(pd.identity.strategy).toBe('extend-dcs');
      expect(pd.identity.dcNames).toEqual([`shop-move-${{ aws: 'aws', azure: 'az', google: 'gcp', oci: 'oci' }[p as 'aws']}-dc01`, `${pd.prefix}-dc02`]);
      const dcs = pd.identity.dcNames.map((n) => pd.compute.find((c) => c.workload === itemId('workload', n))!);
      expect(dcs).toHaveLength(2);
      expect(dcs[0]!.zone === dcs[1]!.zone).toBe(false);
      for (const dc of dcs) {
        expect(dc.tier).toBe('mgmt');
        expect(dc.backupTier).toBe('gold');
        expect(dc.image.kind === 'replicated').toBe(false);
        expect(sizeInCatalog(p, dc.size)).toBe(true);
      }
      const added = designWorkloads(plan, design).filter((w) => w.role === 'ad-dc');
      expect(added.map((w) => w.os)).toEqual(['win-2025', 'win-2025']);
    }
  });

  it('uses the plan\'s own DCs when it sends some to the platform', () => {
    const plan = planWith({
      workloads: [...WORKLOADS, workload('corp-dc1', { role: 'ad-dc', os: 'win-2022' }), workload('corp-dc2', { role: 'ad-dc', os: 'win-2022' })],
    });
    const pd = designPlan(plan, decisionFor(plan, 'aws')).platforms[0]!;
    expect(pd.identity.dcNames).toEqual(['corp-dc1', 'corp-dc2']);
    expect(pd.compute.filter((c) => c.tier === 'mgmt')).toHaveLength(2);
    expect(targetOf(pd, 'corp-dc1')!.zone === targetOf(pd, 'corp-dc2')!.zone).toBe(false);
  });

  it('managed-ad: no DCs added; OCI falls back to extend-dcs with a finding', () => {
    const plan = planWith({}, { identity: { ...defaultRequirements().identity, adStrategy: 'managed-ad' } });
    const aws = designPlan(plan, decisionFor(plan, 'aws'));
    expect(aws.platforms[0]!.identity).toEqual({ strategy: 'managed-ad', dcNames: [] });
    const oci = designPlan(plan, decisionFor(plan, 'oci'));
    expect(oci.platforms[0]!.identity.strategy).toBe('extend-dcs');
    expect(oci.platforms[0]!.identity.dcNames).toHaveLength(2);
    expect(oci.findings.some((f) => f.code === 'design.identity.oci-no-managed-ad')).toBe(true);
  });
});

describe('design/connectivity', () => {
  it('keeps a circuit where it reaches the cloud, and falls back to a VPN elsewhere', () => {
    const site = { name: 'hq', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['192.168.0.0/16'], bandwidth: '1g' as const, circuit: 'expressroute' as const };
    const plan = planWith({}, { sites: [site], connection: 'circuit-with-vpn-backup' });
    const az = designOn('azure', plan);
    expect(az.pd.connectivity).toEqual([{ site: 'hq', method: 'circuit-with-vpn-backup', cloudAsn: 65515 }]);
    const aws = designOn('aws', plan);
    expect(aws.pd.connectivity).toEqual([{ site: 'hq', method: 'vpn', cloudAsn: 64512 }]);
    expect(aws.design.findings.some((f) => f.code === 'design.connectivity.vpn-instead')).toBe(true);
  });

  it('flags a site ASN Azure reserves', () => {
    const site = { name: 'hq', vpnPeer: '203.0.113.10', bgpAsn: 65515, cidrs: ['192.168.0.0/16'], bandwidth: '1g' as const, circuit: 'none' as const };
    expect(designOn('azure', planWith({}, { sites: [site] })).design.findings.some((f) => f.code === 'design.connectivity.asn-clash')).toBe(true);
  });
});

describe('design/relocate', () => {
  it('sizes the relocate subset on the platform\'s VMware service', () => {
    const plan = planWith({ workloads: Array.from({ length: 40 }, (_, i) => workload(`vm${i}`, { vcpu: 8, ramGib: 64 })), databases: [] });
    const decision = decisionFor(plan, 'azure');
    const items = Object.fromEntries(Object.entries(decision.items).map(([k, v]) => [k, item(k, 'workload', 'azure', 'relocate-hcx')]));
    const pd = designPlan(plan, { ...decision, items }).platforms[0]!;
    expect(pd.compute.filter((c) => c.tier !== 'mgmt')).toHaveLength(0);
    // 320 vCPU / (36 × 4) = 3; 2,560 GiB / (768 × 0.8) = 5.
    expect(pd.relocate).toEqual({ service: 'Azure VMware Solution', nodes: 5 });
  });
});

// ---------------------------------------------------------------------------
// Pipeline, overrides and extension
// ---------------------------------------------------------------------------

describe('design/index: the mapper pipeline', () => {
  it('applies overrides last', () => {
    const plan = planWith({ designOverrides: { [`compute:${itemId('workload', 'app01')}:size`]: 'm7i.2xlarge', 'aws:lz:subnet-size': '/24' } });
    const { pd, design } = designOn('aws', plan);
    expect(targetOf(pd, 'app01')!.size).toBe('m7i.2xlarge');
    expect(pd.networks[0]!.subnets[1]!.cidr).toBe('10.10.1.0/24');
    expect(pd.overrides[`compute:${itemId('workload', 'app01')}:size`]).toBe('m7i.2xlarge');
    expect(design.findings.some((f) => f.code.startsWith('design.override'))).toBe(false);
    const bad = designOn('aws', planWith({ designOverrides: { [`compute:${itemId('workload', 'app01')}:size`]: 'm99.huge' } }));
    expect(bad.design.findings.some((f) => f.code === 'design.override.unknown-size')).toBe(true);
  });

  it('takes a new mapper that claims items, and the generic mappers leave them alone', () => {
    const hana: DesignMapper = {
      id: 'sap-hana',
      claims: (plan) => plan.workloads.filter((w) => w.name === 'app01').map((w) => w.id),
      map(ctx, design) {
        const added = ctx.claimedWorkloads.map((w) => ({
          workload: w.id, size: 'x2iedn.8xlarge', vcpu: 32, ramGib: 1024,
          image: { kind: 'custom' as const, variable: 'image_hana', note: 'SAP-certified image' },
          disks: [], network: 'prod', tier: 'db' as const, zone: 'us-east-1a', licenceHandling: 'LI', backupTier: 'gold' as const,
        }));
        return { design: { ...design, compute: [...design.compute, ...added] } };
      },
    };
    const mappers = insertMapper(hana, { after: 'compute' });
    expect(mappers.map((m) => m.id)).toEqual(['network', 'compute', 'sap-hana', 'database', 'identity', 'connectivity', 'backup', 'relocate', 'overrides']);
    expect(insertMapper(hana).map((m) => m.id).slice(-2)).toEqual(['sap-hana', 'overrides']);
    const plan = planWith();
    const pd = designPlan(plan, decisionFor(plan, 'aws'), mappers).platforms[0]!;
    const app = pd.compute.filter((c) => c.workload === itemId('workload', 'app01'));
    expect(app).toHaveLength(1);
    expect(app[0]!.size).toBe('x2iedn.8xlarge');
    expect(DESIGN_MAPPERS).toHaveLength(8);
  });

  it('designs only the decision\'s platforms, and is deterministic', () => {
    const plan = planWith();
    const d = decisionFor(plan, 'google');
    expect(designPlan(plan, d).platforms.map((p) => p.platform)).toEqual(['google']);
    expect(JSON.stringify(designPlan(plan, d))).toBe(JSON.stringify(designPlan(plan, d)));
    expect(designPlan(plan, { ...d, platforms: [], items: {} }).platforms).toEqual([]);
  });

  it('designs VCF on owned hardware too: vSphere templates, one zone, no connectivity or added DCs', () => {
    const plan = planWith();
    const pd = designPlan(plan, decisionFor(plan, 'vmware')).platforms[0]!;
    expect(pd.connectivity).toEqual([]);
    expect(pd.identity.dcNames).toEqual([]);
    expect(targetOf(pd, 'app01')!.image).toEqual({ kind: 'vsphere-template', template: 'rhel-9-template' });
    expect(targetOf(pd, 'app01')!.size).toBe('4x16GiB');
    expect(pd.networks[0]!.ipv6Cidr!.startsWith('fd')).toBe(true);
  });
});
