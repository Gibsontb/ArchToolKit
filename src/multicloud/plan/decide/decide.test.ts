import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { vmwareCloudService } from '../../vmware-on-cloud.ts';
import { defaultRequirements } from '../options.ts';
import { PLAN_KIND } from '../types.ts';
import type { App, Database, ItemDecision, Option, Plan, Requirements, Workload } from '../types.ts';
import {
  ENGINE_VERSION, RULES, decidePlan, rule, whatIfEstate, whatIfItem, withRules,
} from './index.ts';

const TODAY = '2026-09-26';
const opts = { today: TODAY };

function workload(name: string, over: Partial<Workload> = {}): Workload {
  return {
    id: `w:${name}`,
    name,
    app: '',
    env: 'prod',
    role: 'app',
    os: 'win-2022',
    vcpu: 4,
    ramGib: 16,
    disksGib: [100],
    criticality: 'tier2',
    rpo: '4h',
    rto: '4h',
    licence: 'li',
    dependsOn: [],
    source: 'manual',
    ...over,
  };
}

function database(name: string, over: Partial<Database> = {}): Database {
  return {
    id: `d:${name}`,
    name,
    engine: 'oracle',
    edition: 'oracle-ee',
    version: 'oracle-19c',
    hosts: [],
    vcpu: 16,
    ramGib: 128,
    sizeGib: 500,
    ha: 'none',
    dr: 'none',
    features: [],
    licence: 'oracle-processor',
    app: '',
    source: 'manual',
    ...over,
  };
}

function app(name: string, over: Partial<App> = {}): App {
  return { id: `a:${name}`, name, criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', ...over };
}

function plan(parts: { workloads?: Workload[]; databases?: Database[]; apps?: App[]; edges?: Plan['edges']; requirements?: Partial<Requirements> }): Plan {
  const req = defaultRequirements();
  return {
    kind: PLAN_KIND,
    version: 1,
    id: 'test-plan',
    name: 'test',
    savedAt: TODAY,
    workloads: parts.workloads ?? [],
    databases: parts.databases ?? [],
    apps: parts.apps ?? [],
    edges: parts.edges ?? [],
    requirements: { ...req, ...parts.requirements, licensing: { ...req.licensing, ...parts.requirements?.licensing } },
    designOverrides: {},
    waveSettings: { mode: 'default', maxPerWave: 50, parallel: 1, weeks: 2, freezes: [] },
  };
}

const rulesOf = (o: Option | undefined): string[] => (o?.hits ?? []).map((h) => h.rule);
const opt = (d: ItemDecision, service: string): Option => d.options.find((o) => o.service === service)!;
const codes = (fs: readonly { code: string }[]): string[] => fs.map((f) => f.code);

// ---------------------------------------------------------------------------

const scenarioA = (): Plan =>
  plan({
    workloads: Array.from({ length: 100 }, (_, i) => workload(`win-${i}`, { role: i % 2 ? 'web' : 'app', os: 'win-2019', app: `app-${i % 10}` })),
    requirements: { maxPlatforms: 1, licensing: { ...defaultRequirements().licensing, microsoftSa: 'yes-all' } },
  });

describe('decide: scenario a, a Windows estate with Software Assurance', () => {
  it('goes to Azure on Azure Hybrid Benefit', () => {
    const d = decidePlan(scenarioA(), opts);
    expect(d.engineVersion).toBe(ENGINE_VERSION);
    expect(d.platforms).toEqual(['azure']);
    for (const item of Object.values(d.items)) {
      expect(item.chosen?.platform).toBe('azure');
      expect(item.disposition).toBe('rehost');
      expect(item.method).toBe('replicate');
      const ahb = item.chosen!.hits.find((h) => h.rule === 'lic.ms.ahb');
      expect(ahb?.delta).toBe(3);
      // The decide.ts id is kept as an alias.
      expect(ahb?.aliases).toEqual(['microsoft-licensing']);
    }
  });

  it('what-if "no SA" moves every item off Azure, and says why', () => {
    const p = scenarioA();
    const w = whatIfEstate(p, { licensing: { ...p.requirements.licensing, microsoftSa: 'no' } }, opts);
    expect(w.before.platforms).toEqual(['azure']);
    expect(w.moves).toHaveLength(100);
    for (const m of w.moves) {
      expect(m.from?.platform).toBe('azure');
      expect(m.to?.platform).not.toBe('azure');
      const lost = m.why.find((h) => h.rule === 'lic.ms.ahb');
      expect(lost?.delta).toBe(-3);
    }
    // With nothing to separate them, the tie goes to the platform that is already there.
    expect(w.after.platforms).toEqual(['vmware']);
    expect(w.licenceDelta.vmware?.['windows-core']).toBe(800);
    expect(codes(w.after.findings)).toContain('plan.too-close-to-call');
  });
});

describe('decide: scenario b, Oracle RAC', () => {
  it('lands on OCI Exadata or Base Database, never on RDS or an IaaS VM', () => {
    const p = plan({ databases: [database('erp', { ha: 'rac' })], requirements: { licensing: { ...defaultRequirements().licensing, oracle: 'processor' } } });
    const d = decidePlan(p, opts).items['d:erp']!;
    expect(['oci-exacs', 'oci-basedb']).toContain(d.chosen?.service);
    for (const s of ['aws-rds', 'aws-ec2', 'azure-vm', 'google-gce', 'oci-compute']) {
      expect(opt(d, s).eliminated).toBe('db.rac-needs-exadata');
    }
    expect(rulesOf(d.chosen)).toContain('db.oracle-rac');
    expect(rulesOf(d.chosen)).toContain('lic.oracle.oci-core-factor');
    expect(d.method).toBe('managed-db');
  });
});

describe('decide: scenario c, Oracle EE without RAC, managed first, an AWS commitment', () => {
  it('allows RDS on BYOL and shows 8 processors on AWS against 4 on OCI', () => {
    const p = plan({
      databases: [database('erp')],
      requirements: {
        exit: 'managed-first',
        commitments: [{ platform: 'aws', agreement: 'edp' }],
        licensing: { ...defaultRequirements().licensing, oracle: 'processor' },
      },
    });
    const d = decidePlan(p, opts).items['d:erp']!;
    expect(d.chosen?.platform).toBe('aws');
    expect(rulesOf(d.chosen)).toContain('commercial.existing-commitment');
    const rds = opt(d, 'aws-rds');
    expect(rds.eliminated).toBeUndefined();
    expect(rulesOf(rds)).toContain('exit.managed-first');
    expect(rds.licence?.kind).toBe('oracle-processor');
    expect(rds.licence?.model).toBe('byol');
    expect(rds.licence?.count).toBe(8);
    for (const s of ['oci-basedb', 'oci-exacs', 'oci-adb', 'oci-compute']) expect(opt(d, s).licence?.count).toBe(4);
  });
});

describe('decide: scenario d, Oracle SE2 over the ACE cap', () => {
  it('eliminates the Authorized Cloud Environment VMs, and keeps licence-included RDS', () => {
    const p = plan({ databases: [database('crm', { edition: 'oracle-se2', vcpu: 10, ramGib: 64 })] });
    const d = decidePlan(p, opts).items['d:crm']!;
    for (const s of ['aws-ec2', 'azure-vm', 'google-gce']) expect(opt(d, s).eliminated).toBe('lic.oracle.se2-cap');
    const rds = opt(d, 'aws-rds');
    expect(rds.eliminated).toBeUndefined();
    expect(rulesOf(rds)).toContain('lic.oracle.se2-cap');
    expect(rds.licence?.model).toBe('li');
    expect(['aws-ec2', 'azure-vm', 'google-gce']).not.toContain(d.chosen?.service);
  });
});

describe('decide: scenario e, SQL Server AG with instance features', () => {
  it('eliminates Azure SQL Database and prefers SQL Managed Instance under SA', () => {
    const p = plan({
      databases: [database('orders', { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2019', ha: 'sql-ag', features: ['agent-jobs', 'cross-db-queries'], licence: 'byol-sa', vcpu: 8 })],
      requirements: { licensing: { ...defaultRequirements().licensing, microsoftSa: 'yes-all' } },
    });
    const d = decidePlan(p, opts).items['d:orders']!;
    const sqldb = opt(d, 'azure-sqldb');
    expect(sqldb.eliminated).toBeDefined();
    expect(rulesOf(sqldb)).toContain('db.sql-instance-features');
    expect(d.chosen?.service).toBe('azure-sqlmi');
    expect(rulesOf(d.chosen)).toContain('db.sql-instance-features');
    expect(rulesOf(d.chosen)).toContain('lic.ms.ahb');
    expect(d.chosen?.licence?.model).toBe('ahb');
  });
});

describe('decide: scenario f, a physical RDM', () => {
  it('relocates by HCX, onto VCF or a VMware service only', () => {
    const p = plan({
      workloads: [workload('cluster-node', { os: 'rhel-8', licence: 'li', facts: { rdmGib: 500, readiness: [{ id: 'rdm-physical', severity: 'blocker' }] } })],
    });
    const d = decidePlan(p, opts).items['w:cluster-node']!;
    expect(d.disposition).toBe('relocate');
    expect(d.method).toBe('relocate-hcx');
    for (const o of d.options.filter((x) => !x.eliminated)) {
      expect(o.platform === 'vmware' || vmwareCloudService(o.platform) !== undefined).toBe(true);
      if (o.platform !== 'vmware') expect(rulesOf(o)).toContain('shape.relocate-needs-vmware');
    }
    expect(d.chosen?.platform).toBe('vmware');
    const suits = d.chosen!.hits.find((h) => h.rule === 'shape.relocate-suits-vmware-services');
    expect(suits?.aliases).toEqual(['rehost-suits-vmware-services']);
  });
});

describe('decide: scenario g, two sync-dependent apps a point apart', () => {
  it('puts both on one platform in the affinity pass', () => {
    const prefers = rule<Workload>({
      id: 'test.prefers',
      kind: 'workload',
      verification: 'I',
      evaluate: (w, o) =>
        (w.app === 'A' && o.platform === 'aws') || (w.app === 'B' && o.platform === 'azure') ? { delta: 1, reason: 'test preference' } : undefined,
    });
    const p = plan({
      workloads: [
        ...[1, 2, 3].map((i) => workload(`a${i}`, { app: 'A', os: 'ubuntu-24.04', licence: 'free' })),
        ...[1, 2, 3].map((i) => workload(`b${i}`, { app: 'B', os: 'ubuntu-24.04', licence: 'free' })),
      ],
      apps: [app('A'), app('B')],
      edges: [{ from: 'A', to: 'B', kind: 'sync' }],
      requirements: {
        allowed: ['aws', 'azure'],
        maxPlatforms: 2,
        commitments: [{ platform: 'aws', agreement: 'edp' }, { platform: 'azure', agreement: 'macc' }],
        skills: { aws: 'strong', azure: 'strong' },
      },
    });
    const d = decidePlan(p, { ...opts, rules: withRules(prefers) });
    expect(d.platforms).toEqual(['aws', 'azure']);
    const landed = new Set(Object.values(d.items).map((i) => i.chosen?.platform));
    expect(landed.size).toBe(1);
    const moved = Object.values(d.items).filter((i) => i.snapped);
    expect(moved).toHaveLength(3);
    for (const m of moved) {
      expect(m.snapped?.rule).toBe('estate.affinity');
      expect(codes(m.findings)).toContain('plan.affinity');
    }
  });
});

describe('decide: scenario h, more pins than platforms', () => {
  it('honours the pins and says the maximum was exceeded', () => {
    const p = plan({
      workloads: [workload('x', { pin: 'aws' }), workload('y', { pin: 'azure' }), workload('z', { pin: 'google' })],
      requirements: { maxPlatforms: 2 },
    });
    const d = decidePlan(p, opts);
    expect(codes(d.findings)).toContain('plan.pins-exceed-max');
    expect(d.platforms).toEqual(['aws', 'azure', 'google']);
    expect(d.items['w:x']?.chosen?.platform).toBe('aws');
    expect(d.items['w:y']?.chosen?.platform).toBe('azure');
    expect(d.items['w:z']?.chosen?.platform).toBe('google');
    expect(d.items['w:x']?.pinned).toBe(true);
  });
});

describe('decide: scenario i, every platform excluded', () => {
  it('raises multicloud.no-platform and places nothing', () => {
    const p = plan({ workloads: [workload('w1')], databases: [database('d1')], requirements: { allowed: [] } });
    const d = decidePlan(p, opts);
    expect(codes(d.findings)).toContain('multicloud.no-platform');
    expect(d.platforms).toEqual([]);
    for (const item of Object.values(d.items)) {
      expect(item.chosen).toBeUndefined();
      for (const o of item.options) expect(o.eliminated).toBe('policy.excluded');
    }
  });
});

describe('decide: scenario j, a domain controller', () => {
  it('is rebuilt, never replicated', () => {
    const p = plan({ workloads: [workload('dc01', { role: 'ad-dc' })] });
    const d = decidePlan(p, opts).items['w:dc01']!;
    expect(d.method).toBe('rebuild');
    expect(d.disposition).toBe('replatform');
    expect(rulesOf(d.chosen)).toContain('shape.dc-rebuild');
  });

  it('even when its app is routed rehost', () => {
    const p = plan({ workloads: [workload('dc02', { role: 'ad-dc', app: 'identity' })], apps: [app('identity', { route: 'rehost' })] });
    const d = decidePlan(p, opts).items['w:dc02']!;
    expect(d.method).toBe('rebuild');
    expect(codes(d.findings)).toContain('plan.dc.rebuild-forced');
  });
});

describe('decide: databases and their hosts', () => {
  it('a managed database leaves its host VM unbuilt (managed-db)', () => {
    const p = plan({
      workloads: [workload('pg01', { role: 'db', os: 'ubuntu-22.04', licence: 'free' })],
      databases: [database('pg', { engine: 'postgres', edition: 'community', version: 'pg-16', licence: 'community', hosts: ['pg01'], vcpu: 4, ramGib: 16 })],
    });
    const d = decidePlan(p, opts);
    const db = d.items['d:pg']!;
    expect(db.method).toBe('managed-db');
    expect(rulesOf(db.chosen)).toContain('db.managed-default');
    const host = d.items['w:pg01']!;
    expect(host.method).toBe('managed-db');
    expect(host.disposition).toBe('replatform');
    expect(host.chosen?.platform).toBe(db.chosen?.platform);
  });

  it('an IaaS database pulls its hosts to its platform (db.hosts-follow)', () => {
    const p = plan({
      workloads: [workload('ora01', { role: 'db', os: 'ol-8', licence: 'free' })],
      databases: [database('ora', { hosts: ['ora01'], pinService: 'aws-ec2' })],
    });
    const d = decidePlan(p, opts);
    expect(d.items['d:ora']?.chosen?.service).toBe('aws-ec2');
    const host = d.items['w:ora01']!;
    expect(host.chosen?.platform).toBe('aws');
    for (const o of host.options.filter((x) => x.platform !== 'aws')) expect(o.eliminated).toBeDefined();
    expect(host.options.some((o) => o.eliminated === 'db.hosts-follow')).toBe(true);
    expect(rulesOf(host.chosen)).toContain('db.hosts-follow');
  });
});

describe('decide: engine behaviour', () => {
  it('is deterministic', () => {
    const p = scenarioA();
    expect(JSON.stringify(decidePlan(p, opts))).toBe(JSON.stringify(decidePlan(p, opts)));
  });

  it('whatIfItem lists every option in full, best first', () => {
    const p = plan({ databases: [database('erp')] });
    const options = whatIfItem(p, 'd:erp', opts);
    expect(options.length).toBeGreaterThanOrEqual(8);
    for (const o of options) expect(o.licence).toBeDefined();
    const surviving = options.filter((o) => !o.eliminated).map((o) => o.score);
    expect(surviving).toEqual([...surviving].sort((a, b) => b - a));
    expect(whatIfItem(p, 'd:missing', opts)).toEqual([]);
  });

  it('retires a long-powered-off VM and keeps a retained one on VMware', () => {
    const p = plan({
      workloads: [
        workload('old', { facts: { powerState: 'poweredOff', readiness: [{ id: 'retire', severity: 'note' }] } }),
        workload('keep', { disposition: 'retain' }),
      ],
    });
    const d = decidePlan(p, opts);
    expect(d.items['w:old']?.disposition).toBe('retire');
    expect(d.items['w:old']?.chosen).toBeUndefined();
    expect(d.items['w:keep']?.chosen?.platform).toBe('vmware');
    expect(rulesOf(d.items['w:keep']?.chosen)).toContain('shape.retain');
  });

  it('reports rather than scores residency, sovereignty and support dates', () => {
    const p = plan({
      workloads: [workload('legacy', { os: 'centos-7', licence: 'free', residency: 'de' })],
      requirements: { sovereignty: 'sovereign-region' },
    });
    const d = decidePlan(p, opts);
    const c = codes(d.findings);
    expect(c).toContain('multicloud.residency.check-regions');
    expect(c).toContain('multicloud.sovereignty.differs-in-shape');
    expect(c).toContain('plan.os.eol');
  });

  it('keeps the registry well-formed: unique ids, every rule verified', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RULES) expect(['V-API', 'V-DOC', 'V-SPEC', 'C', 'I']).toContain(r.verification);
    for (const id of ['policy.excluded', 'lic.ms.ahb', 'lic.oracle.se2-cap', 'db.rac-needs-exadata', 'db.hosts-follow', 'shape.dc-rebuild', 'os.no-image-rebuild']) {
      expect(ids).toContain(id);
    }
  });
});
