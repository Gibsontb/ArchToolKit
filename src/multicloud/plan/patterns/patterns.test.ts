import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { CATALOG_DATA } from '../../../terraform/catalog-data.ts';
import { ANSIBLE_SCHEMA_INDEX } from '../../../ansible/module-schema-index.ts';
import { PLATFORMS, platformInfo } from '../../platforms.ts';
import { DB_SERVICES, servicesFor } from '../db-catalog.ts';
import { DB_SERVICES_EXTRA } from '../db-catalog-extra.ts';
import { decidePlan } from '../decide/index.ts';
import { designPlan } from '../design/index.ts';
import { APP_PATTERN_VALUES, DB_SERVICE_LABELS, TIER_PATTERN_VALUES, defaultRequirements } from '../options.ts';
import { PLAN_KIND } from '../types.ts';
import type { App, AppPlan, Database, ItemDecision, Option, Plan, Platform, Workload } from '../types.ts';
import {
  CONFIRM_THRESHOLD, DETECTED_THRESHOLD, HONEST_PATH_PATTERNS, PATTERN_CATALOG, PATTERN_LIST, PATTERN_RULES, PATTERN_RULES_BY_ID,
  SAP_CERTIFIED, TIER_PATTERNS, allFacts, applyDetection, defaultTierPattern, detectType, flaggedFacts, isNone,
  patternTerraformTypes, proposePattern, rankTierPatterns, sapFit, sessionHosts, verificationBadge, withPatternMappers,
} from './index.ts';
import { withUserNetworks } from '../../../testing/network-rows.ts';

const TODAY = '2026-09-26';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workload(name: string, over: Partial<Workload> = {}): Workload {
  return {
    id: `w:${name}`, name, app: '', env: 'prod', role: 'app', os: 'rhel-9', vcpu: 4, ramGib: 16, disksGib: [100],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
  };
}
function database(name: string, over: Partial<Database> = {}): Database {
  return {
    id: `d:${name}`, name, engine: 'postgres', edition: 'community', version: 'pg-16', hosts: [], vcpu: 4, ramGib: 32, sizeGib: 200,
    ha: 'none', dr: 'none', features: [], licence: 'community', app: '', source: 'manual', ...over,
  };
}
function app(name: string, over: Partial<App> = {}): App {
  return { id: `a:${name}`, name, criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', ...over };
}
function appPlan(appName: string, over: Partial<AppPlan> = {}): AppPlan {
  return { app: `a:${appName}`, origin: 'migrate', status: 'draft', variants: {}, answers: {}, landingZone: 'included', ...over };
}
function plan(parts: { workloads?: Workload[]; databases?: Database[]; apps?: App[]; appPlans?: AppPlan[] }): Plan {
  return withUserNetworks({
    kind: PLAN_KIND, version: 1, id: 'wp16', name: 'wp16', savedAt: TODAY,
    workloads: parts.workloads ?? [], databases: parts.databases ?? [], apps: parts.apps ?? [], edges: [],
    requirements: defaultRequirements(), designOverrides: {},
    waveSettings: { mode: 'default', maxPerWave: 50, parallel: 1, weeks: 2, freezes: [] },
    appPlans: parts.appPlans ?? [],
  }, ['aws', 'azure', 'google', 'oci', 'vmware'], { allPlatformSubnets: true });
}
const decide = (p: Plan) => decidePlan(p, { today: TODAY, extraRules: PATTERN_RULES });
const optionOn = (d: ItemDecision, p: Platform): Option | undefined => d.options.find((o) => o.platform === p);

function catalogTypes(): Record<string, Set<string>> {
  const have: Record<string, Set<string>> = {};
  for (const [target, entry] of Object.entries(CATALOG_DATA)) {
    const prefix = target === 'azure' ? 'azurerm_' : `${target}_`;
    have[target] = new Set(entry.resources.split(',').map((n) => prefix + n));
  }
  return have;
}
const MODULES = new Set(Object.keys((ANSIBLE_SCHEMA_INDEX as { modules: Record<string, unknown> }).modules));

// ---------------------------------------------------------------------------
// Catalogue: types, modules, coverage
// ---------------------------------------------------------------------------

describe('patterns/tier-patterns: every tier pattern × platform names catalogued types, or none with a reason', () => {
  it('covers every TierPattern value', () => {
    expect(Object.keys(TIER_PATTERNS).sort()).toEqual([...TIER_PATTERN_VALUES].sort());
  });
  it('names only Terraform types in catalog-data.ts for the platform\'s own provider', () => {
    const have = catalogTypes();
    const missing: string[] = [];
    const empty: string[] = [];
    for (const info of Object.values(TIER_PATTERNS)) {
      for (const p of PLATFORMS) {
        const o = info.perPlatform[p];
        if (isNone(o)) {
          if (o.none.trim().length < 10) empty.push(`${info.id}/${p}: none without a reason`);
          continue;
        }
        if (o.terraform.length === 0 && !o.noTerraform) empty.push(`${info.id}/${p}: no types and no noTerraform reason`);
        const target = platformInfo(p).terraform;
        for (const t of o.terraform) if (!have[target]?.has(t)) missing.push(`${info.id}/${p}: ${t}`);
      }
    }
    expect(missing).toEqual([]);
    expect(empty).toEqual([]);
  });
});

describe('patterns/catalog', () => {
  it('has an entry for every AppPattern, with its family, questions, components and status', () => {
    expect(Object.keys(PATTERN_CATALOG).sort()).toEqual([...APP_PATTERN_VALUES].sort());
    for (const e of PATTERN_LIST) {
      expect(['automated', 'partial', 'honest-path']).toContain(e.status);
      if (e.id !== 'blank') expect(e.components.length).toBeGreaterThan(0);
    }
  });

  it('every pattern × platform names only catalogued Terraform types (components and extra artefacts)', () => {
    const have = catalogTypes();
    const missing: string[] = [];
    for (const e of PATTERN_LIST) {
      for (const p of PLATFORMS) {
        for (const t of patternTerraformTypes(e.id, p)) if (!have[platformInfo(p).terraform]?.has(t)) missing.push(`${e.id}/${p}: ${t}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every Ansible module a pattern names is in the module schema index (community.windows included)', () => {
    const missing: string[] = [];
    for (const e of PATTERN_LIST) for (const m of e.artefacts.ansibleModules ?? []) if (!MODULES.has(m)) missing.push(`${e.id}: ${m}`);
    expect(missing).toEqual([]);
    expect(MODULES.has('community.windows.win_robocopy')).toBe(true);
  });

  it('every rule id a pattern names is a pattern rule (or a preference\'s report id)', () => {
    const missing: string[] = [];
    for (const e of PATTERN_LIST) for (const r of e.rules) if (!PATTERN_RULES_BY_ID.has(r)) missing.push(`${e.id}: ${r}`);
    expect(missing).toEqual([]);
    expect(PATTERN_RULES_BY_ID.has('app.chosen-platform')).toBe(true);
    expect(PATTERN_RULES_BY_ID.has('app.tier-pattern')).toBe(true);
    expect(PATTERN_RULES_BY_ID.has('app.pin-conflict')).toBe(true);
    expect(new Set(PATTERN_RULES.map((r) => r.id)).size).toBe(PATTERN_RULES.length);
  });

  it('marks Unix, legacy and mainframe (not Solaris x86) as honest-path only', () => {
    expect([...HONEST_PATH_PATTERNS].sort()).toEqual(['aix', 'hp-ux', 'ibm-i', 'mainframe', 'solaris-sparc']);
    for (const id of HONEST_PATH_PATTERNS) {
      expect(PATTERN_CATALOG[id].methods).toEqual(['specialist']);
      expect((PATTERN_CATALOG[id].artefacts.runbook ?? []).length).toBeGreaterThan(0);
    }
  });

  it('greenfield components fall back on VCF to what it offers (vm / containers)', () => {
    const web = PATTERN_CATALOG['web-app'].components[0]!;
    expect(defaultTierPattern(web, 'azure')).toBe('paas-web');
    expect(defaultTierPattern(web, 'vmware')).toBe('containers');
    expect(defaultTierPattern(PATTERN_CATALOG['web-app'].components[1]!, 'vmware')).toBe('vm');
    expect(defaultTierPattern(PATTERN_CATALOG.microservices.components[0]!, 'vmware')).toBe('containers');
  });

  it('ranks tier patterns with the pattern preferences (Exchange: saas +5; .NET Framework: no Cloud Run)', () => {
    const ex = rankTierPatterns('exchange', PATTERN_CATALOG.exchange.components[0]!, 'azure', { version: '2019' });
    expect(ex[0]!.tierPattern).toBe('saas');
    expect(ex[0]!.score).toBe(6);
    const net = rankTierPatterns('iis-dotnet', PATTERN_CATALOG['iis-dotnet'].components[0]!, 'google', { dotnetRuntime: 'framework-4x' });
    expect(net.find((r) => r.tierPattern === 'paas-web')!.eliminated).toBeDefined();
    const net6 = rankTierPatterns('iis-dotnet', PATTERN_CATALOG['iis-dotnet'].components[0]!, 'google', { dotnetRuntime: 'net-6-plus' });
    expect(net6.find((r) => r.tierPattern === 'paas-web')!.eliminated).toBeUndefined();
  });
});

describe('patterns: facts carry a source and a verification tag; [U] ones are flagged', () => {
  it('every fact has a URL source and a tag', () => {
    const facts = allFacts();
    expect(facts.length).toBeGreaterThan(40);
    for (const { where, fact } of facts) {
      expect(`${where}:${/^https:\/\//.test(fact.source)}`).toBe(`${where}:true`);
      expect(['V-DOC', 'V-API', 'V-SPEC', 'C', 'I']).toContain(fact.verification);
    }
  });
  it('flags the unverified ones for the UI', () => {
    const flagged = flaggedFacts();
    expect(flagged.length).toBeGreaterThan(0);
    for (const f of flagged) expect(verificationBadge(f.fact.verification)).toBeTruthy();
    expect(verificationBadge('I')).toBe('[U]');
    expect(verificationBadge('C')).toBe('[C]');
    expect(verificationBadge('V-DOC')).toBe('');
    expect(flagged.some((f) => f.where === 'pattern:solaris-sparc' && f.fact.verification === 'I')).toBe(true);
  });
  it('every pattern rule carries a verification tag, and the scoring ones a source', () => {
    for (const r of PATTERN_RULES) {
      expect(['V-DOC', 'C', 'I']).toContain(r.verification);
      if (r.id.startsWith('pattern.')) expect((r.source ?? '').startsWith('https://')).toBe(true);
    }
  });
  it('the SAP certified rows carry a source and a tag (OCI unverified)', () => {
    for (const s of SAP_CERTIFIED) {
      expect(s.source.startsWith('https://')).toBe(true);
      expect(s.platform === 'oci' ? s.verification : 'V-DOC').toBe(s.verification);
    }
    expect(SAP_CERTIFIED.filter((s) => s.platform === 'oci').every((s) => s.verification === 'I')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Databases beyond the core
// ---------------------------------------------------------------------------

describe('db-catalog-extra: the A.4.9 services', () => {
  it('catalogues the services with a row, and every type is in the provider catalog', () => {
    const have = catalogTypes();
    for (const [id, row] of Object.entries(DB_SERVICES_EXTRA)) {
      expect(id in DB_SERVICES).toBe(true);
      const s = DB_SERVICES[id as keyof typeof DB_SERVICES];
      for (const t of row!.terraformTypes) expect(`${id}:${have[platformInfo(s.platform).terraform]!.has(t)}`).toBe(`${id}:true`);
      expect(row!.source.startsWith('https://')).toBe(true);
    }
    expect('aws-rds-db2' in DB_SERVICES).toBe(false);
  });
  it('offers managed services for the new engines on the right platforms', () => {
    expect(servicesFor('mongodb', 'aws').map((s) => s.id)).toContain('aws-docdb');
    expect(servicesFor('mongodb', 'azure').map((s) => s.id)).toContain('azure-documentdb');
    expect(servicesFor('mongodb', 'oci').map((s) => s.id)).toContain('oci-adb-mongo');
    expect(servicesFor('redis', 'google').map((s) => s.id)).toEqual(['google-gce', 'google-memorystore']);
    expect(servicesFor('cassandra', 'azure').map((s) => s.id)).toContain('azure-cassandra-mi');
    expect(servicesFor('elasticsearch', 'oci').map((s) => s.id)).toContain('oci-opensearch');
    expect(servicesFor('informix', 'aws').map((s) => s.id)).toEqual(['aws-ec2']);
  });
  it('keeps the labels confirmed from the vendors', () => {
    expect(DB_SERVICE_LABELS['azure-documentdb']).toBe('Azure DocumentDB (with MongoDB compatibility)');
    expect(DB_SERVICE_LABELS['oci-cache']).toBe('OCI Cache');
  });
  it('designs a DocumentDB target with a class through the pattern mapper', () => {
    const p = plan({ databases: [database('orders', { engine: 'mongodb', edition: 'community', version: 'other', ramGib: 30, app: 'shop' })], apps: [app('shop')], appPlans: [appPlan('shop', { platform: 'aws' })] });
    const d = decide(p);
    expect(d.items['d:orders']!.chosen!.service).toBe('aws-docdb');
    const design = designPlan(p, d, withPatternMappers());
    const t = design.platforms.find((x) => x.platform === 'aws')!.databases.find((x) => x.database === 'd:orders')!;
    expect(t.classOrShape).toBe('db.r6g.xlarge');
    expect(design.findings.some((f) => f.code === 'design.db.no-class')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('patterns/detect: the fixture servers', () => {
  const fixtures: [string, Workload, Parameters<typeof detectType>[1], string][] = [
    ['SAP HANA', workload('s4p-hana01', { os: 'sles-15', facts: { software: ['SAP HANA Database 2.00.079'], services: ['hdbindexserver'], listening: [{ port: 30013, proto: 'tcp' }, { port: 30015, proto: 'tcp' }] } }), {}, 'sap-hana'],
    ['Exchange', workload('exch-mbx01', { os: 'win-2019', facts: { software: ['Microsoft Exchange Server 2019 Cumulative Update 14'], services: ['MSExchangeTransport'], listening: [{ port: 25, proto: 'tcp' }] } }), {}, 'exchange'],
    ['Citrix VDA', workload('ctx-vda07', { os: 'win-2022' }), { software: ['Citrix Virtual Delivery Agent 2402'], listening: [{ port: 1494, proto: 'tcp' }, { port: 2598, proto: 'tcp' }] }, 'citrix-vda'],
    ['domain controller', workload('dc01', { os: 'win-2022', facts: { services: ['NTDS', 'Netlogon', 'DNS'], listening: [{ port: 88, proto: 'tcp' }, { port: 389, proto: 'tcp' }, { port: 53, proto: 'udp' }] } }), {}, 'ad-ds'],
    ['Kubernetes node', workload('k8s-worker03', { os: 'ubuntu-22.04', facts: { services: ['kubelet', 'containerd'], listening: [{ port: 10250, proto: 'tcp' }] } }), {}, 'k8s-node'],
    ['FortiGate appliance', workload('fgt-edge01', { os: 'other', role: 'appliance', facts: { guestOsRaw: 'Other 3.x Linux (64-bit)', listening: [{ port: 541, proto: 'tcp' }] } }), { annotation: 'FortiGate-VM64 v7.4.4' }, 'appliance-fortinet'],
  ];
  for (const [label, w, facts, type] of fixtures) {
    it(`detects ${label} at ≥ ${DETECTED_THRESHOLD}`, () => {
      const d = detectType(w, facts);
      expect(d.type).toBe(type);
      expect(d.outcome).toBe('detected');
      expect(d.confidence).toBeGreaterThanOrEqual(0.7);
      expect(d.evidence.length).toBeGreaterThan(0);
    });
  }

  it('gives "unknown — confirm" on an ambiguous server, with the candidates', () => {
    const w = workload('mq01', { os: 'rhel-9', facts: { listening: [{ port: 1414, proto: 'tcp' }] } });
    const d = detectType(w);
    expect(d.outcome).toBe('confirm');
    expect(d.type).toBe('unknown');
    expect(d.confidence).toBeGreaterThanOrEqual(CONFIRM_THRESHOLD);
    expect(d.confidence).toBeLessThan(DETECTED_THRESHOLD);
    expect(d.candidates[0]!.type).toBe('ibm-mq');
    const r = applyDetection(w, d);
    expect(r.workload.workloadType).toBe('unknown');
    expect(r.findings.map((f) => f.code)).toEqual(['type.confirm']);
  });

  it('falls back to the generic type by OS under 0.4, with no finding', () => {
    const d = detectType(workload('srv-042', { os: 'win-2022' }));
    expect(d.outcome).toBe('generic');
    expect(d.type).toBe('generic-windows');
    expect(applyDetection(workload('srv-042', { os: 'win-2022' }), d).findings).toEqual([]);
  });

  it('is decisive for non-x86 origins', () => {
    expect(detectType(workload('lpar1', { origin: 'power', os: 'other' })).type).toBe('aix');
    expect(detectType(workload('as400', { origin: 'power', os: 'other', facts: { guestOsRaw: 'IBM i 7.5' } })).type).toBe('ibm-i');
    expect(detectType(workload('sun1', { origin: 'sparc', os: 'other' })).type).toBe('solaris-sparc');
  });

  it('never changes a user-set type, and proposes (not sets) the app pattern', () => {
    const w = workload('s4p-hana01', { workloadType: 'generic-linux', edited: ['workloadType'], facts: { software: ['SAP HANA Database'], services: ['hdbindexserver'] } });
    const r = applyDetection(w, detectType(w));
    expect(r.workload.workloadType).toBe('generic-linux');
    expect(r.workload.facts!.detection!.type).toBe('sap-hana');
    const hana = applyDetection(workload('hana01', { facts: { software: ['SAP HANA Database'], services: ['hdbindexserver'] } }), detectType(workload('hana01', { facts: { software: ['SAP HANA Database'], services: ['hdbindexserver'] } }))).workload;
    expect(proposePattern([hana, workload('pas01', { workloadType: 'sap-netweaver' })])).toBe('sap-s4hana');
    expect(proposePattern([workload('x', { workloadType: 'citrix-vda' })])).toBe('citrix-vad');
    expect(proposePattern([workload('y')])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe('patterns/rules: SAP HANA certified sizing', () => {
  it('the sizer picks the smallest certified type with the memory × 1.0', () => {
    expect(sapFit('aws', 1024).type).toBe('x2idn.16xlarge');
    expect(sapFit('azure', 20480).type).toBeUndefined();
    expect(sapFit('azure', 20480).largest!.type).toBe('Standard_M416ms_v2');
    expect(sapFit('vmware', 20000).type).toBeUndefined();
  });

  it('eliminates a platform with no certified type ≥ the HANA memory, naming the largest', () => {
    const p = plan({
      workloads: [workload('s4p-hana01', { app: 'S4', role: 'db', workloadType: 'sap-hana', vcpu: 32, ramGib: 256, os: 'sles-15' })],
      apps: [app('S4', { pattern: 'sap-s4hana' })],
      appPlans: [appPlan('S4', { answers: { hanaMemoryGib: '20480' } })],
    });
    const d = decide(p).items['w:s4p-hana01']!;
    // The HANA memory comes from the assessment answer, not the VM's nameplate.
    const azure = optionOn(d, 'azure')!;
    expect(azure.eliminated).toBe('pattern.sap.hana-certified');
    expect(azure.hits.find((h) => h.rule === 'pattern.sap.hana-certified')!.reason).toContain('Standard_M416ms_v2');
    expect(optionOn(d, 'vmware')!.eliminated).toBe('pattern.sap.hana-certified');
    expect(optionOn(d, 'oci')!.eliminated).toBe('pattern.sap.hana-certified-oci');
    expect(optionOn(d, 'oci')!.hits.find((h) => h.rule === 'pattern.sap.hana-certified-oci')!.reason).toContain('BM.Standard.E5.192');
    expect(optionOn(d, 'aws')!.eliminated).toBeUndefined();
    expect(optionOn(d, 'google')!.eliminated).toBeUndefined();
    expect(d.findings.some((f) => f.code === 'pattern.sap.check-directory')).toBe(true);
  });

  it('designs the HANA server on the certified type with the SAP disk layout', () => {
    const p = plan({
      workloads: [workload('s4p-hana01', { app: 'S4', role: 'db', workloadType: 'sap-hana', vcpu: 64, ramGib: 1024, os: 'sles-15' })],
      apps: [app('S4', { pattern: 'sap-s4hana' })],
      appPlans: [appPlan('S4', { platform: 'aws', answers: { hanaMemoryGib: '1024' } })],
    });
    const d = decide(p);
    expect(d.items['w:s4p-hana01']!.chosen!.platform).toBe('aws');
    const design = designPlan(p, d, withPatternMappers());
    const t = design.platforms.find((x) => x.platform === 'aws')!.compute.find((c) => c.workload === 'w:s4p-hana01')!;
    expect(t.size).toBe('x2idn.16xlarge');
    expect(t.ramGib).toBe(1024);
    expect(t.disks.length).toBe(5);
    expect(design.platforms.find((x) => x.platform === 'aws')!.compute.filter((c) => c.workload === 'w:s4p-hana01').length).toBe(1);
  });

  it('SAP on Oracle (anyDB) is eliminated on Google Cloud and preferred on OCI', () => {
    const p = plan({ databases: [database('ecc-ora', { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', licence: 'oracle-processor', app: 'ECC' })], apps: [app('ECC', { pattern: 'sap-ecc-anydb' })] });
    const d = decide(p).items['d:ecc-ora']!;
    expect(d.options.filter((o) => o.platform === 'google').every((o) => o.eliminated !== undefined)).toBe(true);
    expect(d.options.find((o) => o.service === 'google-gce')!.eliminated).toBe('pattern.sap.anydb-support');
  });
});

describe('patterns/rules: structural', () => {
  const apps = [app('Shop')];
  const workloads = [workload('shop-web1', { app: 'Shop', role: 'web' }), workload('shop-app1', { app: 'Shop' })];
  const databases = [database('shopdb', { app: 'Shop', hosts: [] })];

  it('app.chosen-platform eliminates the other platforms for every item of the app', () => {
    const p = plan({ workloads, databases, apps, appPlans: [appPlan('Shop', { platform: 'oci' })] });
    const d = decide(p);
    for (const id of ['w:shop-web1', 'w:shop-app1', 'd:shopdb']) {
      const item = d.items[id]!;
      for (const o of item.options) {
        if (o.platform === 'oci') continue;
        expect(`${id}/${o.platform}/${o.service ?? ''}:${o.eliminated}`).toBe(`${id}/${o.platform}/${o.service ?? ''}:app.chosen-platform`);
      }
      expect(item.chosen?.platform).toBe('oci');
      expect(item.options.find((o) => o.platform !== 'oci')!.hits.find((h) => h.rule === 'app.chosen-platform')!.reason).toContain('by choice');
    }
  });

  it('a pin that differs wins for that item, and app.pin-conflict reports it', () => {
    const p = plan({ workloads: [...workloads.slice(0, 1), workload('shop-app1', { app: 'Shop', pin: 'azure' })], apps, appPlans: [appPlan('Shop', { platform: 'oci' })] });
    const d = decide(p);
    expect(d.items['w:shop-app1']!.options.some((o) => o.eliminated === 'app.chosen-platform')).toBe(false);
    expect(d.items['w:shop-app1']!.findings.map((f) => f.code)).toContain('app.pin-conflict');
    expect(optionOn(d.items['w:shop-web1']!, 'azure')!.eliminated).toBe('app.chosen-platform');
  });

  it('app.tier-pattern restricts a component to its tier pattern\'s services', () => {
    const comp = { id: 'c:shop:web', name: 'web', tier: 'web' as const, kind: 'pattern' as const, tierPattern: 'paas-web' as const, servers: ['shop-web1'], databases: [], settings: {} };
    const dbComp = { id: 'c:shop:data', name: 'data', tier: 'data' as const, kind: 'pattern' as const, tierPattern: 'managed-db' as const, servers: [], databases: ['shopdb'], settings: {} };
    const p = plan({ workloads, databases, apps, appPlans: [appPlan('Shop', { variants: { aws: [comp, dbComp] } })] });
    const d = decide(p);
    expect(optionOn(d.items['w:shop-web1']!, 'oci')!.eliminated).toBe('app.tier-pattern');
    expect(optionOn(d.items['w:shop-web1']!, 'vmware')!.eliminated).toBe('app.tier-pattern');
    expect(optionOn(d.items['w:shop-web1']!, 'azure')!.eliminated).toBeUndefined();
    expect(d.items['d:shopdb']!.options.find((o) => o.service === 'aws-ec2')!.eliminated).toBe('app.tier-pattern');
    expect(d.items['d:shopdb']!.options.find((o) => o.service === 'aws-rds')!.eliminated).toBeUndefined();
  });
});

describe('patterns/rules: families', () => {
  it('Unix and mainframe are honest paths: every platform eliminated, with the target options', () => {
    const p = plan({ workloads: [workload('lpar1', { origin: 'power', os: 'other', workloadType: 'aix' }), workload('sol86', { workloadType: 'solaris-x86', os: 'other' })] });
    const d = decide(p);
    expect(d.items['w:lpar1']!.options.every((o) => o.eliminated === 'pattern.legacy.specialist')).toBe(true);
    expect(d.items['w:lpar1']!.findings.map((f) => f.code)).toContain('pattern.legacy.honest-path');
    expect(optionOn(d.items['w:sol86']!, 'oci')!.eliminated).toBeUndefined();
    expect(optionOn(d.items['w:sol86']!, 'aws')!.eliminated).toBe('pattern.legacy.specialist');
  });
  it('HP-UX on Itanium: re-platform only, with the end-of-support error', () => {
    const d = decide(plan({ workloads: [workload('hpux1', { origin: 'itanium', os: 'other' })] })).items['w:hpux1']!;
    expect(d.options.every((o) => o.eliminated === 'pattern.legacy.specialist')).toBe(true);
    expect(d.findings.find((f) => f.code === 'pattern.hpux.eos')!.severity).toBe('error');
  });
  it('re-platformed legacy workloads are not eliminated', () => {
    const d = decide(plan({ workloads: [workload('lpar2', { origin: 'power', os: 'rhel-9', disposition: 'replatform' })] })).items['w:lpar2']!;
    expect(d.options.some((o) => o.eliminated === 'pattern.legacy.specialist')).toBe(false);
  });
  it('Exchange 2019 warns past support; EBS prefers OCI; JBoss prefers Azure; Horizon prefers VCF', () => {
    const p = plan({
      workloads: [
        workload('mbx1', { app: 'Mail', os: 'win-2019' }), workload('ebs1', { app: 'EBS' }), workload('jb1', { app: 'Jb' }), workload('hz1', { app: 'Hz', os: 'win-2022' }),
      ],
      apps: [app('Mail', { pattern: 'exchange' }), app('EBS', { pattern: 'oracle-ebs' }), app('Jb', { pattern: 'jboss' }), app('Hz', { pattern: 'horizon' })],
      appPlans: [appPlan('Mail', { answers: { version: '2019' } })],
    });
    const d = decide(p);
    expect(d.items['w:mbx1']!.findings.find((f) => f.code === 'pattern.exchange.eos')!.severity).toBe('warning');
    expect(optionOn(d.items['w:ebs1']!, 'oci')!.hits.some((h) => h.rule === 'pattern.oracle-apps.oci-tooling' && h.delta === 3)).toBe(true);
    expect(optionOn(d.items['w:jb1']!, 'azure')!.hits.some((h) => h.rule === 'pattern.jboss.app-service')).toBe(true);
    expect(optionOn(d.items['w:hz1']!, 'vmware')!.hits.some((h) => h.rule === 'pattern.vdi.horizon')).toBe(true);
  });
  it('file services: +2 where the protocol fits, +5 on ONTAP targets from an ONTAP source', () => {
    const p = plan({ workloads: [workload('fs1', { app: 'Files', os: 'win-2022' })], apps: [app('Files', { pattern: 'file-server' })], appPlans: [appPlan('Files', { answers: { protocol: 'smb', ontap: 'yes' } })] });
    const d = decide(p).items['w:fs1']!;
    expect(optionOn(d, 'aws')!.hits.find((h) => h.rule === 'pattern.file.service')!.delta).toBe(5);
    expect(optionOn(d, 'oci')!.hits.some((h) => h.rule === 'pattern.file.service')).toBe(false);
  });
  it('.NET Framework on a Google paas-web component is eliminated there', () => {
    const comp = { id: 'c:web:web', name: 'Web tier', tier: 'web' as const, kind: 'pattern' as const, tierPattern: 'paas-web' as const, servers: ['iis1'], databases: [], settings: {} };
    const p = plan({ workloads: [workload('iis1', { app: 'Web', os: 'win-2022' })], apps: [app('Web', { pattern: 'iis-dotnet' })], appPlans: [appPlan('Web', { variants: { google: [comp] }, answers: { dotnetRuntime: 'framework-4x' } })] });
    const g = optionOn(decide(p).items['w:iis1']!, 'google')!;
    expect(['pattern.dotnet.runtime', 'app.tier-pattern']).toContain(g.eliminated);
    expect(g.hits.some((h) => h.rule === 'pattern.dotnet.runtime')).toBe(true);
  });
  it('VDI density: session hosts from concurrent users and persona', () => {
    expect(sessionHosts(300, 'medium')).toBe(5);
    expect(sessionHosts(300, 'heavy', 8)).toBe(19);
  });
  it('rules that do not apply leave a plain plan untouched', () => {
    const p = plan({ workloads: [workload('plain1')] });
    const a = decidePlan(p, { today: TODAY });
    const b = decide(p);
    expect(b.items['w:plain1']!.options.map((o) => [o.platform, o.score, o.eliminated ?? ''])).toEqual(a.items['w:plain1']!.options.map((o) => [o.platform, o.score, o.eliminated ?? '']));
  });
});
