import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { CATALOG_DATA } from '../../../terraform/catalog-data.ts';
import { findTerraformBlueprint } from '../../../terraform/blueprints/index.ts';
import { answersFromApp } from '../../estate-answers.ts';
import { recommendationSections, stateFromAnswers } from '../../wizard/engine.js';
import { WIZARD_CLOUDS, allFields, stepsFor } from '../../wizard/steps.ts';
import { optionLabel, stepWording } from '../../wizard/wording.ts';
import { defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../options.ts';
import { planEnvelope, planFromEnvelope } from '../store.ts';
import type { Json } from '../../../editor/doc.ts';
import type { AppComponent, Plan, Platform, Workload } from '../types.ts';
import { designResult } from './built.ts';
import { appPlanOf, newApplication } from './components.ts';
import { INTERCONNECTS, ON_PREM_LINKS, VPN_SIDE, appConnectors, appPeers, interconnectBetween, vpnBetween } from './connectors.ts';
import { deployPaths, resourceManagerSchema, terraformNeeded } from './deploy-paths.ts';
import { assignLandingZones, designAnswers, designCloud, landingZoneBuilder, setDesignAnswer, setDesignCloud } from './design.ts';
import { generateAppStack } from './generate.ts';
import { WIZARD_MAP, applyWizard, mapRow } from './wizard-map.ts';


const w = (name: string, app: string, o: Partial<Workload> = {}): Workload => ({
  id: itemId('workload', name), name, app, env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64], criticality: 'tier1', rpo: '1h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...o,
});

function fixture(): Plan {
  const base: Plan = {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'plan-design', name: 'Design test', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: [
      w('crm-web01', 'crm', { role: 'web', os: 'win-2022', licence: 'byol-sa', env: 'prod' }),
      w('crm-sql01', 'crm', { role: 'db', os: 'win-2022', vcpu: 8, ramGib: 64, licence: 'byol-sa', env: 'prod', rpo: '15m', rto: '1h' }),
      w('crm-web02', 'crm', { role: 'web', os: 'win-2022', env: 'dev' }),
      w('shop-web01', 'shop', { role: 'web', os: 'ubuntu-22.04' }),
      w('shop-app01', 'shop'),
    ],
    databases: [
      { id: itemId('database', 'crmdb'), name: 'crmdb', engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2022', hosts: ['crm-sql01'], vcpu: 8, ramGib: 64, sizeGib: 800, ha: 'none', dr: 'none', features: [], licence: 'byol-sa', app: 'crm', source: 'manual' },
      { id: itemId('database', 'orders'), name: 'orders', engine: 'postgres', edition: 'community', version: 'pg-16', hosts: ['shop-app01'], vcpu: 4, ramGib: 32, sizeGib: 200, ha: 'none', dr: 'none', features: [], licence: 'community', app: 'shop', source: 'manual' },
    ],
    apps: [
      { id: itemId('app', 'crm'), name: 'crm', criticality: 'tier0', residency: 'any', latencyToOnPrem: 'sensitive', special: 'none', pattern: 'iis-dotnet', frameworks: ['pci-dss-4'] },
      { id: itemId('app', 'shop'), name: 'shop', criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', pattern: 'web-app' },
    ],
    edges: [{ from: 'shop-app01', to: 'crmdb', kind: 'sync' }],
    requirements: { ...defaultRequirements(), sites: [{ name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.0.0.0/16'], bandwidth: '10g', circuit: 'none' }] },
    designOverrides: { 'vmware:lz:datacenter': 'dc01', 'vmware:lz:cluster': 'cl01', 'vmware:lz:datastore': 'vsan01' },
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    appPlans: [],
  };
  return base;
}

const HAVE: Record<string, Set<string>> = (() => {
  const out: Record<string, Set<string>> = {};
  for (const [target, entry] of Object.entries(CATALOG_DATA)) {
    const prefix = target === 'azure' ? 'azurerm_' : `${target}_`;
    out[target] = new Set(entry.resources.split(',').map((n) => prefix + n));
  }
  return out;
})();
const inCatalog = (type: string): boolean => Object.values(HAVE).some((s) => s.has(type));

// ---------------------------------------------------------------------------

describe('design: the answers prefilled from the plan', () => {
  it('reads a migrating app\'s servers, databases, criticality, RPO / RTO, source, data, environments and route', () => {
    const a = answersFromApp(fixture(), 'crm').answers;
    expect(a.initiativeType).toBe('migration');
    expect(a.workloadName).toBe('crm');
    expect(a.appPattern).toBe('iis-dotnet');
    expect(a.architectureType).toBe('legacy-vm');
    expect(a.sourceEnv).toBe('onprem-vmware');
    expect(a.criticality).toBe('tier0');
    expect(a.rpo).toBe('15min');
    expect(a.rto).toBe('hour');
    expect(a.dataType).toBe('relational');
    expect(a.dataSensitivity).toBe('regulated');
    expect(a.dataVolumeBand).toBe('s');
    expect([...(a.envScope as string[])].sort()).toEqual(['dev', 'prod']);
    expect(a.latencySensitivity).toBe('moderate');
    expect(a.onPremLink).toBe('vpn');
    expect(a.linkBandwidth).toBe('10g');
    expect(String(a.description)).toContain('3 server(s)');
  });

  it('reads a new service from its load profile, with no source', () => {
    const plan = newApplication(fixture(), { name: 'portal', pattern: 'microservices', load: { environments: ['dev', 'prod'], nonprodPct: 50, peakRps: 3000, dataGib: 50, slo: '99.95' } }).plan;
    const a = answersFromApp(plan, 'portal').answers;
    expect(a.initiativeType).toBe('new-service');
    expect(a.architectureType).toBe('microservices');
    expect(a.teamSkills).toBe('containers');
    expect(a.trafficPattern).toBe('high');
    expect(a.uptimeTarget).toBe('99.95');
    expect(a.nonProdScale).toBe('half');
    expect(a.sourceEnv).toBeUndefined();
  });

  it('never overwrites an answer the user changed, and follows the plan for the others', () => {
    let plan = setDesignAnswer(fixture(), 'crm', 'criticality', 'tier2', 'azure').plan;
    plan = { ...plan, apps: plan.apps.map((x) => (x.name === 'crm' ? { ...x, rpo: '4h' as const } : x)) };
    const d = designAnswers(plan, 'crm');
    expect(d.answers.criticality).toBe('tier2');
    expect(d.prefilled.has('criticality')).toBe(false);
    expect(d.answers.rpo).toBe('day');
    expect(d.prefilled.has('rpo')).toBe(true);
    expect(Object.keys(appPlanOf(plan, 'crm')?.design?.answers ?? {})).toEqual(['criticality']);
  });
});

describe('design: persistence and the cloud', () => {
  it('stores the cloud and the answers on the app plan, and they survive a save and load', () => {
    let plan = setDesignCloud(fixture(), 'crm', 'azure').plan;
    plan = setDesignAnswer(plan, 'crm', 'dbStrategy', 'managed', 'azure').plan;
    const back = planFromEnvelope(planEnvelope(plan) as unknown as Json);
    if (!('ok' in back)) throw new Error(back.error);
    const ap = appPlanOf(back.ok, 'crm');
    expect(ap?.design?.cloud).toBe('azure');
    expect(ap?.design?.answers.dbStrategy).toBe('managed');
    expect(ap?.platform).toBe('azure');
    expect(designCloud(back.ok, 'crm', 'aws')).toBe('azure');
  });

  it('switching the cloud makes it the chosen platform, keeps the other variants, and allows the cloud', () => {
    const plan0: Plan = { ...fixture(), requirements: { ...fixture().requirements, allowed: ['aws', 'azure'], maxPlatforms: 1 } };
    let plan = setDesignCloud(plan0, 'crm', 'azure').plan;
    plan = setDesignCloud(plan, 'crm', 'oci').plan;
    const ap = appPlanOf(plan, 'crm');
    expect(ap?.platform).toBe('oci');
    expect(Object.keys(ap?.variants ?? {}).sort()).toEqual(['azure', 'oci']);
    expect(plan.requirements.allowed).toContain('oci');
    expect(plan.requirements.maxPlatforms).toBeGreaterThanOrEqual(2);
  });

  it('the strategy answer is the app\'s route, which the decision places by', () => {
    const plan = setDesignAnswer(setDesignCloud(fixture(), 'shop', 'aws').plan, 'shop', 'migrationApproach', 'replatform', 'aws').plan;
    expect(plan.apps.find((a) => a.name === 'shop')?.route).toBe('replatform');
    expect(appPlanOf(plan, 'shop')?.route).toBe('replatform');
  });

  it('the first app on a cloud builds its landing zone; the next reuses it', () => {
    let plan = setDesignCloud(fixture(), 'crm', 'aws').plan;
    plan = setDesignCloud(plan, 'shop', 'aws').plan;
    plan = assignLandingZones(plan);
    const b = landingZoneBuilder(plan, 'aws');
    expect(b?.kind === 'app' ? b.app.name : '').toBe('crm');
    expect(appPlanOf(plan, 'crm')?.landingZone).toBe('included');
    expect(appPlanOf(plan, 'shop')?.landingZone).toBe('shared');
    expect(generateAppStack(plan, ['shop'], { record: false, engine: { today: '2026-09-26' } }).landingZones.aws).toBe('shared');
    expect(generateAppStack(plan, ['crm'], { record: false, engine: { today: '2026-09-26' } }).landingZones.aws).toBe('included');
  });
});

describe('design: the mapping table (answers → components)', () => {
  it('the compute rows follow the R for a migration and the architecture otherwise', () => {
    expect(mapRow('compute', { initiativeType: 'migration', migrationApproach: 'rehost' }, 'aws')?.tierPattern).toBe('vm');
    expect(mapRow('compute', { initiativeType: 'migration', migrationApproach: 'relocate' }, 'azure')?.tierPattern).toBe('vmware-service');
    expect(mapRow('compute', { initiativeType: 'migration', migrationApproach: 'retire' }, 'google')?.tierPattern).toBe('retire');
    expect(mapRow('compute', { initiativeType: 'new-service', architectureType: 'web-api', trafficPattern: 'low', teamSkills: ['paas'] }, 'azure')?.tierPattern).toBe('paas-web');
    expect(mapRow('compute', { initiativeType: 'new-service', architectureType: 'web-api', trafficPattern: 'medium', teamSkills: ['serverless'] }, 'aws')?.tierPattern).toBe('serverless');
    expect(mapRow('compute', { initiativeType: 'new-service', architectureType: 'web-api', teamSkills: ['paas'] }, 'google')?.tierPattern).toBe('paas-web');
    expect(mapRow('compute', { initiativeType: 'new-service', architectureType: 'microservices' }, 'vmware')?.tierPattern).toBe('containers');
    expect(mapRow('compute', { initiativeType: 'migration', migrationApproach: 'refactor', architectureType: 'web-api', teamSkills: ['containers'] }, 'oci')?.tierPattern).toBe('containers');
  });

  it('the data and integration rows', () => {
    expect(mapRow('data', { dbStrategy: 'managed' }, 'aws')?.tierPattern).toBe('managed-db');
    expect(mapRow('data', { dbStrategy: 'vm' }, 'aws')?.tierPattern).toBe('vm');
    expect(mapRow('data', { dbStrategy: 'managed' }, 'vmware')).toBeUndefined();
    expect(mapRow('integration', { initiativeType: 'new-service', integrations: 'enterprise-messaging' }, 'azure')?.tierPattern).toBe('managed-messaging');
    expect(mapRow('integration', { initiativeType: 'migration', migrationApproach: 'rehost', integrations: 'enterprise-messaging' }, 'azure')).toBeUndefined();
  });

  it('every row names a tier pattern that exists', () => {
    for (const r of WIZARD_MAP) expect(r.tiers.length).toBeGreaterThan(0);
  });

  it('applies the answers to the variant, adds the F5 and integration components, and keeps a choice the user made', () => {
    let plan = setDesignCloud(fixture(), 'shop', 'aws').plan;
    plan = setDesignAnswer(plan, 'shop', 'migrationApproach', 'replatform', 'aws').plan;
    plan = setDesignAnswer(plan, 'shop', 'architectureType', 'web-api', 'aws').plan;
    plan = setDesignAnswer(plan, 'shop', 'teamSkills', 'containers', 'aws').plan;
    plan = setDesignAnswer(plan, 'shop', 'perimeterPattern', 'cloud-plus-f5', 'aws').plan;
    plan = setDesignAnswer(plan, 'shop', 'integrations', 'enterprise-messaging', 'aws').plan;
    const list = appPlanOf(plan, 'shop')?.variants.aws ?? [];
    const byName = new Map(list.map((c) => [c.name, c]));
    const tp = (c: AppComponent | undefined): string => (c && c.kind === 'pattern' ? c.tierPattern ?? '' : '');
    expect(tp(byName.get('web'))).toBe('containers');
    expect(byName.has('f5-bigip')).toBe(true);
    expect(tp(byName.get('integration'))).toBe('managed-messaging');
    // The user sets the web tier to VMs on Components: the wizard keeps it.
    const ap = appPlanOf(plan, 'shop')!;
    const edited = { ...ap, variants: { ...ap.variants, aws: list.map((c) => (c.name === 'web' && c.kind === 'pattern' ? { ...c, tierPattern: 'vm' as const } : c)) } };
    const plan2 = { ...plan, appPlans: (plan.appPlans ?? []).map((x) => (x.app === ap.app ? edited : x)) };
    const r = applyWizard(plan2, 'shop', 'aws', designAnswers(plan2, 'shop').answers);
    const web = appPlanOf(r.plan, 'shop')?.variants.aws?.find((c) => c.name === 'web');
    expect(web?.kind === 'pattern' ? web.tierPattern : '').toBe('vm');
    expect(r.notes.some((n) => n.code === 'wizard.kept')).toBe(true);
  });

  it('what the wizard maps is what generateAppStack builds', () => {
    let plan = setDesignCloud(fixture(), 'shop', 'azure').plan;
    plan = setDesignAnswer(plan, 'shop', 'migrationApproach', 'replatform', 'azure').plan;
    plan = setDesignAnswer(plan, 'shop', 'architectureType', 'web-api', 'azure').plan;
    plan = setDesignAnswer(plan, 'shop', 'teamSkills', 'containers', 'azure').plan;
    const g = generateAppStack(plan, ['shop'], { record: false, engine: { today: '2026-09-26' } });
    const tf = Object.entries(g.files).filter(([f]) => f.endsWith('.tf')).map(([, t]) => t).join('\n');
    expect(tf).toContain('azurerm_kubernetes_cluster');
    const r = designResult(plan, 'shop', 'azure', { today: '2026-09-26' });
    expect(r.built.some((b) => b.generated && b.builds.includes('azurerm_kubernetes_cluster'))).toBe(true);
  });
});

describe('design: connectors', () => {
  it('names both ends of every pair, with Terraform types that are in the catalogue', () => {
    const options = [...Object.values(INTERCONNECTS), ...Object.values(ON_PREM_LINKS).flatMap((x) => [x.circuit, x.vpn])];
    const all: Platform[] = ['aws', 'azure', 'google', 'oci', 'vmware'];
    for (const a of all) for (const b of all) if (a !== b) options.push(vpnBetween(a, b));
    for (const o of options) {
      expect(o.sides.length).toBe(2);
      expect(o.sources.length).toBeGreaterThan(0);
      for (const s of o.sides) for (const t of s.terraform) expect(inCatalog(t) ? t : `missing ${t}`).toBe(t);
    }
    for (const s of Object.values(VPN_SIDE)) expect(s.terraform.length).toBeGreaterThan(0);
  });

  it('picks the clouds\' own interconnect for a pair that has one, and the VPN otherwise', () => {
    expect(interconnectBetween('azure', 'oci')?.name).toBe('Oracle Interconnect for Microsoft Azure');
    expect(interconnectBetween('oci', 'google')?.name).toContain('Oracle Interconnect for Google Cloud');
    expect(interconnectBetween('aws', 'google')?.name).toContain('AWS Interconnect');
    expect(interconnectBetween('google', 'azure')?.name).toContain('Cross-Cloud Interconnect');
    expect(interconnectBetween('aws', 'azure')?.status).toBe('preview');
    expect(interconnectBetween('aws', 'vmware')).toBeUndefined();
  });

  it('lists the data-centre link and a connector per peer on another cloud; each end builds its own side', () => {
    let plan = setDesignCloud(fixture(), 'crm', 'azure').plan;
    plan = setDesignCloud(plan, 'shop', 'oci').plan;
    expect(appPeers(plan, 'shop').map((p) => p.app)).toEqual(['crm']);
    const shop = appConnectors(plan, 'shop', 'oci', designAnswers(plan, 'shop').answers);
    expect(shop.map((c) => c.id)).toEqual(['dc', 'x:crm']);
    expect(shop[1]?.option.id).toBe('oracle-interconnect-azure');
    expect(shop[1]?.component?.settings.blueprint).toBe('oci_app_connector');
    const crm = appConnectors(plan, 'crm', 'azure', designAnswers(plan, 'crm').answers);
    expect(crm.find((c) => c.id === 'x:shop')?.component?.settings.blueprint).toBe('azure_app_connector');
    // The peer's components were refreshed when shop moved.
    expect((appPlanOf(plan, 'crm')?.variants.azure ?? []).some((c) => c.name === 'connector-shop')).toBe(true);
    // The AWS–Azure interconnect is a preview with no Terraform: the VPN is built.
    const vpn = appConnectors(setDesignCloud(plan, 'shop', 'aws').plan, 'shop', 'aws', {});
    expect(vpn.find((c) => c.id === 'x:crm')?.option.kind).toBe('vpn');
  });

  it('every connector blueprint builds, and emits only catalogued types', () => {
    for (const p of ['aws', 'azure', 'google', 'oci', 'vsphere']) {
      const bp = findTerraformBlueprint(`${p}_app_connector`);
      expect(bp?.id).toBe(`${p}_app_connector`);
      for (const t of bp?.emits ?? []) expect(inCatalog(t) ? t : `missing ${t}`).toBe(t);
      for (const peer of ['aws', 'azure', 'google', 'oci']) {
        for (const method of ['vpn', 'interconnect']) {
          const out = bp!.build({ app: 'shop', peer: 'crm', peer_cloud: peer, method, landing_zone_source: 'variables' }, 'x');
          expect(Object.values(out.files).join('\n')).toContain('resource "');
        }
      }
    }
  });
});

describe('design: how each cloud takes the output', () => {
  it('packages OCI as a Resource Manager stack and Google Cloud for Infrastructure Manager, when the stack runs on Terraform 1.5', () => {
    const plan = newApplication(fixture(), { name: 'portal', pattern: 'web-app', load: { environments: ['prod'], nonprodPct: 25, peakRps: 100 } }).plan;
    for (const [p, marker] of [['oci', 'deploy/oci-resource-manager-stack.zip/schema.yaml'], ['google', 'deploy/google-infra-manager/versions.tf']] as const) {
      const placed = setDesignCloud(plan, 'portal', p).plan;
      const g = generateAppStack(placed, ['portal'], { record: false, engine: { today: '2026-09-26' } });
      expect(Object.keys(g.files).some((f) => f.endsWith(marker))).toBe(true);
      const versions = Object.entries(g.files).find(([f]) => f.includes('/deploy/') && f.endsWith('versions.tf'))?.[1] ?? '';
      expect(/backend\s+"/.test(versions)).toBe(false);
      expect(g.files['portal/README.md']).toContain(p === 'oci' ? 'oci resource-manager stack create' : 'gcloud infra-manager deployments apply');
    }
  });

  it('does not offer a managed-service package for a stack that needs a newer Terraform', () => {
    expect(terraformNeeded({ 'a.tf': 'import {\n  for_each = x\n  to = y\n  id = z\n}' }).version).toBe('1.7');
    expect(terraformNeeded({ 'a.tf': 'password_wo = var.x' }).version).toBe('1.11');
    const r = deployPaths(fixture(), { platforms: [], findings: [] }, 'f', {}, 't');
    expect(r.paths).toHaveLength(0);
    expect(resourceManagerSchema('x', { 'v.tf': 'variable "a" {\n  type = string\n  sensitive = true\n}' })).toContain('type: password');
  });
});

describe('the wizard: steps, words and the engine', () => {
  it('the initiative type chooses the flow', () => {
    expect(stepsFor('migration').map((s) => s.number)).toEqual([1, 2, 10, 3, 4, 5, 6, 7, 11, 12, 13]);
    expect(stepsFor('new-service').map((s) => s.number)).toEqual([1, 9, 3, 4, 5, 6, 7, 14, 15]);
    expect(stepsFor('existing-service').map((s) => s.number)).toEqual([1, 8, 16, 17]);
    expect(new Set(allFields().map((f) => f.id)).size).toBe(allFields().length);
  });

  it('the steps use the provider\'s words', () => {
    const cutover = stepsFor('migration').find((s) => s.number === 12)!;
    expect(stepWording(cutover, 'azure', 'migration').title).toContain('Migrate, then complete migration');
    expect(stepWording(cutover, 'gcp', 'migration').title).toContain('Cut-over');
    expect(stepWording(stepsFor('migration').find((s) => s.number === 11)!, 'gcp', 'migration').title).toContain('test-clone');
    expect(stepWording(stepsFor('migration').find((s) => s.number === 13)!, 'aws', 'migration').title).toContain('Hypercare');
    expect(optionLabel('migrationApproach', 'repurchase', 'Repurchase (SaaS)', 'azure')).toBe('Replace (SaaS)');
    expect(optionLabel('migrationApproach', 'repurchase', 'Repurchase (SaaS)', 'aws')).toBe('Repurchase (SaaS)');
  });

  it('the engine writes every card for all five clouds, with 2026 names, and VCF in Broadcom names only', () => {
    const state = stateFromAnswers({ initiativeType: 'migration', architectureType: 'legacy-vm', dataType: 'relational', criticality: 'tier1', envScope: ['prod'], iaCTools: 'terraform', teamSkills: 'vms' });
    for (const c of WIZARD_CLOUDS) {
      const s = recommendationSections(c.value, state);
      expect(s.computeMain.length).toBeGreaterThan(20);
      expect(s.howToMain).toContain('Phase 8');
      const all = Object.values(s).join(' ');
      expect(/Aria|vRealize|ESXi|Application Migration Service \(MGN\)|VMware Cloud on AWS/.test(all.replace(/formerly AWS Application Migration Service/g, ''))).toBe(false);
    }
    const vcf = recommendationSections('vcf', state);
    expect(vcf.computeMain).toContain('HCX');
    expect(vcf.opsNotes).toContain('VCF Operations');
    expect(recommendationSections('aws', state).computeMain).toContain('AWS Transform MGN');
  });

  it('free text is escaped before it reaches the HTML', () => {
    const s = stateFromAnswers({ workloadName: '<img src=x onerror=alert(1)>' });
    expect(s.workloadName).toContain('&lt;img');
  });
});
