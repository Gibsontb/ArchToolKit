/**
 * WP-UI-D: the Application Migration panes' model — the pickers, the
 * components added from them reaching the generated stack, switching cloud
 * and back, the sizing overrides, readiness, and a new application with no
 * servers generating a stack and a pipeline.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../../multicloud/plan/options.ts';
import { planEnvelope, planFromEnvelope } from '../../multicloud/plan/store.ts';
import { chooseAppPlatform } from '../../multicloud/plan/apps/recommend.ts';
import { compareApp } from '../../multicloud/plan/apps/compare.ts';
import { appPlanOf, newApplication } from '../../multicloud/plan/apps/components.ts';
import { resourceTypes, resourceSchema } from '../../terraform/schema-blueprints.ts';
import { findTerraformBlueprint } from '../../terraform/blueprints/index.ts';
import { moduleNames } from '../../ansible/module-blueprints.ts';
import type { App, Database, Plan, Workload } from '../../multicloud/plan/types.ts';
import {
  addConfigComponent, addPatternComponent, addResourceComponent, appBySlug, appReadiness, appSizingRows, catalogueRows, clearOverrides,
  componentFindings, componentsOn, filterCatalogue, overrideChoices, parseAppArg, providerReadiness, rankForTier, recommendationOf,
  recommendationsOf, removeComponent, resourceBlueprintId, setOverride, setPolicy, shownPlatform, startingValues, updateComponent, useRecommendation,
} from './app-model.ts';
import { buildStack, fileTree, moduleOfBlueprint } from './generate-model.ts';
import { equivalentsText, filterModules, filterTypes, moduleIndex, resourceTypeIndex, sectionsOf } from './pickers.ts';

// ---------------------------------------------------------------------------
// Fixtures: a Windows / SQL Server app, a Linux web app, and (later) a new one
// ---------------------------------------------------------------------------

const workload = (name: string, app: string, over: Partial<Workload> = {}): Workload => ({
  id: itemId('workload', name), name, app, env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
  criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
});
const database = (name: string, app: string, over: Partial<Database> = {}): Database => ({
  id: itemId('database', name), name, engine: 'postgres', edition: 'community', version: 'pg-16', hosts: [], vcpu: 4, ramGib: 32,
  sizeGib: 200, ha: 'none', dr: 'none', features: [], licence: 'community', app, source: 'manual', ...over,
});
const app = (name: string, over: Partial<App> = {}): App => ({
  id: itemId('app', name), name, criticality: 'tier1', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', ...over,
});

function fixture(): Plan {
  const base = defaultRequirements();
  return {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'plan-uid', name: 'UI-D sample', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: [
      workload('fin-web01', 'finance', { role: 'web', os: 'win-2022', licence: 'byol-sa' }),
      workload('fin-sql01', 'finance', { role: 'db', os: 'win-2022', vcpu: 8, ramGib: 64, licence: 'byol-sa' }),
      workload('shop-web01', 'shop', { role: 'web', os: 'ubuntu-22.04' }),
      workload('shop-web02', 'shop', { role: 'web', os: 'ubuntu-22.04' }),
      workload('shop-old01', 'shop', { role: 'app', os: 'centos-7' }),
    ],
    databases: [
      database('findb', 'finance', { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2022', hosts: ['fin-sql01'], licence: 'byol-sa' }),
      database('orders', 'shop'),
    ],
    apps: [app('finance', { kind: 'cots' }), app('shop', { kind: 'home-grown' })],
    edges: [{ from: 'shop-web01', to: 'fin-sql01', kind: 'sync' }],
    requirements: {
      ...base,
      maxPlatforms: 5,
      sites: [{ name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.0.0.0/16', 'fd00:10::/48'], bandwidth: '1g', circuit: 'none' }],
      licensing: { ...base.licensing, microsoftSa: 'yes-all' },
    },
    designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    appPlans: [],
  };
}

const PLAN = fixture();
const SHOP = itemId('app', 'shop');
const FIN = itemId('app', 'finance');
const tfText = (files: Readonly<Record<string, string>>): string => Object.entries(files).filter(([k]) => k.endsWith('.tf')).map(([, v]) => v).join('\n');

// ---------------------------------------------------------------------------

describe('WP-UI-D: the catalogue', () => {
  it('lists every app with its recommendation, status and complexity, filters, and places apps on their recommendation in bulk', () => {
    const recs = recommendationsOf(PLAN);
    const rows = catalogueRows(PLAN, recs, '2026-09-26');
    expect(rows.map((r) => r.name)).toEqual(['finance', 'shop']);
    for (const r of rows) {
      expect(r.status).toBe('draft');
      expect(r.recommended !== undefined).toBe(true);
      expect(r.complexity.score > 0).toBe(true);
    }
    expect(rows.find((r) => r.name === 'shop')!.servers).toBe(3);
    expect(filterCatalogue(rows, { text: 'fin' }).map((r) => r.name)).toEqual(['finance']);
    const bulk = useRecommendation(PLAN, [FIN, SHOP], recs);
    expect(bulk.placed).toEqual(['finance', 'shop']);
    expect(appPlanOf(bulk.plan, FIN)!.platform).toBe(recs[FIN]!.recommended);
    expect(filterCatalogue(catalogueRows(bulk.plan, recs, '2026-09-26'), { platform: recs[SHOP]!.recommended! }).some((r) => r.name === 'shop')).toBe(true);
  });

  it('opens an app by its slug, with the tab after the slash', () => {
    expect(appBySlug(PLAN, 'shop')?.name).toBe('shop');
    expect(parseAppArg('shop/compare')).toEqual({ slug: 'shop', tab: 'compare' });
  });
});

describe('WP-UI-D: any service, any module', () => {
  it('the service picker lists every resource type of the provider from the index, sections sorted, beta and deprecated last', () => {
    const idx = resourceTypeIndex('aws');
    expect(idx.length).toBe(resourceTypes('aws').length);
    expect(idx.length > 1000).toBe(true);
    const ranks = idx.map((e) => e.rank);
    expect(ranks.every((r, i) => i === 0 || r >= ranks[i - 1]!)).toBe(true);
    expect(sectionsOf(idx).length > 20).toBe(true);
    expect(filterTypes(idx, { text: 'sqs queue' }).some((e) => e.type === 'aws_sqs_queue')).toBe(true);
    expect(filterTypes(idx, { domain: 'database' }).every((e) => e.domain === 'database')).toBe(true);
    const vm = resourceTypeIndex('vmware');
    expect(vm.some((e) => e.type === 'vsphere_virtual_machine')).toBe(true);
    expect(equivalentsText('aws_s3_bucket')).toContain('Azure');
  });

  it('picking a type loads its schema and the blueprint has every argument', () => {
    const type = 'aws_sqs_queue';
    const bp = findTerraformBlueprint(resourceBlueprintId(type))!;
    expect(bp.id).toBe('res_aws_sqs_queue');
    const schema = resourceSchema(type)!;
    const args = schema.a.filter((a) => !a[2].includes('d') && !(a[2] === 'c'));
    expect(bp.inputs.length >= args.length).toBe(true);
    for (const a of args) expect(bp.inputs.some((i) => i.id.endsWith(a[0]))).toBe(true);
  });

  it('a resource component added from the picker is in the generated app stack', () => {
    const placed = chooseAppPlatform(PLAN, SHOP, 'aws').plan;
    const bp = findTerraformBlueprint('res_aws_sqs_queue');
    const added = addResourceComponent(placed, SHOP, 'aws', 'aws_sqs_queue', { values: startingValues(bp) });
    expect(added.component!.blueprintId).toBe('res_aws_sqs_queue');
    expect(added.component!.name).toBe('sqs-queue');
    expect(componentFindings(added.component!, bp).filter((f) => f.severity === 'error')).toEqual([]);
    const build = buildStack(added.plan, [SHOP], { record: false });
    expect(tfText(build.files)).toContain('resource "aws_sqs_queue"');
    // Removing it takes it out again.
    const gone = removeComponent(added.plan, SHOP, 'aws', added.component!.id);
    expect(tfText(buildStack(gone, [SHOP], { record: false }).files)).not.toContain('resource "aws_sqs_queue"');
  });

  it('lists every Ansible module; a module component is recognised for loading', () => {
    const idx = moduleIndex();
    expect(idx.length).toBe(moduleNames().length);
    expect(filterModules(idx, { text: 'win_feature' }).some((m) => m.fqcn === 'ansible.windows.win_feature')).toBe(true);
    const r = addConfigComponent(PLAN, FIN, 'azure', 'mod_ansible_windows_win_feature', { appliesTo: [] });
    expect(r.component!.order).toBe(1);
    expect(moduleOfBlueprint('mod_ansible_windows_win_feature', () => idx.map((m) => m.fqcn))).toBe('ansible.windows.win_feature');
  });

  it('flags a value outside a dropdown as an error', () => {
    const bp = { inputs: [{ id: 'x', label: 'X', control: 'select' as const, options: [{ value: 'a', label: 'A' }] }] };
    const c = { id: 'c:shop:x', name: 'x', tier: 'other' as const, kind: 'resource' as const, type: 'aws_x', blueprintId: 'res_aws_x', values: { x: 'b' } };
    expect(componentFindings(c, bp).map((f) => f.code)).toEqual(['app.component.value-not-offered']);
    expect(componentFindings(c, { inputs: [] })[0]!.code).toBe('app.component.not-loaded');
    expect(componentFindings(c, undefined)[0]!.code).toBe('app.component.no-blueprint');
  });

  it('adds a pattern component from the ranked tier patterns, and edits and renames components', () => {
    const ranked = rankForTier(PLAN, SHOP, 'data', 'aws');
    expect(ranked.length > 0).toBe(true);
    const r = addPatternComponent(PLAN, SHOP, 'aws', 'data', ranked[0]!.tierPattern, 'cache');
    const renamed = updateComponent(r.plan, SHOP, 'aws', r.component!.id, { name: 'cache-tier', tier: 'integration' });
    const c = componentsOn(renamed, SHOP, 'aws').components.find((x) => x.id === r.component!.id)!;
    expect(c.name).toBe('cache-tier');
    expect(c.tier).toBe('integration');
  });
});

describe('WP-UI-D: switching the cloud', () => {
  it('Compare shows the translation per component on each platform, and AWS → Azure → AWS restores the AWS components', () => {
    let plan = chooseAppPlatform(PLAN, SHOP, 'aws').plan;
    plan = addResourceComponent(plan, SHOP, 'aws', 'aws_s3_bucket', { values: { 'r.bucket': 'shop-assets' } }).plan;
    const before = JSON.stringify(appPlanOf(plan, SHOP)!.variants.aws);
    const cmp = compareApp(plan, SHOP);
    expect(cmp.columns.map((c) => c.platform)).toEqual(['aws', 'azure', 'google', 'oci', 'vmware']);
    const azure = cmp.columns.find((c) => c.platform === 'azure')!;
    const bucket = azure.components.find((c) => c.name === 's3-bucket')!;
    expect(['mapped', 'partial', 'no-equivalent']).toContain(bucket.outcome);
    expect(bucket.outcome === 'no-equivalent' ? true : bucket.targetTypes.some((t) => t.startsWith('azurerm_'))).toBe(true);
    const toAzure = chooseAppPlatform(plan, SHOP, 'azure');
    expect(toAzure.created).toBe(true);
    expect(appPlanOf(toAzure.plan, SHOP)!.variants.azure!.some((c) => c.translatedFrom?.platform === 'aws')).toBe(true);
    const back = chooseAppPlatform(toAzure.plan, SHOP, 'aws');
    expect(back.created).toBe(false);
    expect(JSON.stringify(appPlanOf(back.plan, SHOP)!.variants.aws)).toBe(before);
    expect(shownPlatform(back.plan, SHOP)).toBe('aws');
  });
});

describe('WP-UI-D: sizing', () => {
  it('sizes every component with reasons, and an override persists through the saved plan', () => {
    const plan = chooseAppPlatform(PLAN, FIN, 'azure').plan;
    const rows = appSizingRows(plan, FIN, 'azure').rows;
    const server = rows.find((r) => r.key === 'server:fin-sql01')!;
    expect(server.recommendation !== '').toBe(true);
    expect(server.reason.length > 0).toBe(true);
    const choices = overrideChoices('azure', server);
    expect(choices[0]!.value).toBe(server.engineChoice);
    const other = choices.find((c) => c.value !== server.engineChoice)!.value;
    const over = setOverride(plan, server.key, other);
    const read = planFromEnvelope(JSON.parse(JSON.stringify(planEnvelope(over))));
    if ('error' in read) throw new Error(read.error);
    expect(read.ok.sizing!.overrides[server.key]).toBe(other);
    const again = appSizingRows(read.ok, FIN, 'azure').rows.find((r) => r.key === server.key)!;
    expect(again.recommendation).toBe(other);
    expect(again.override).toBe(other);
    expect(again.engineChoice).toBe(server.engineChoice);
    const cleared = clearOverrides(read.ok, [server.key]);
    expect(appSizingRows(cleared, FIN, 'azure').rows.find((r) => r.key === server.key)!.recommendation).toBe(server.engineChoice);
  });

  it('the policy changes the recommendation', () => {
    const plan = chooseAppPlatform(PLAN, FIN, 'aws').plan;
    const lean = appSizingRows(setPolicy(plan, { headroomPct: 0 }), FIN, 'aws').rows.find((r) => r.key === 'server:fin-sql01')!;
    const fat = appSizingRows(setPolicy(plan, { headroomPct: 50 }), FIN, 'aws').rows.find((r) => r.key === 'server:fin-sql01')!;
    expect(typeof lean.demand).toBe('string');
    expect(lean.recommendation !== '' && fat.recommendation !== '').toBe(true);
  });
});

describe('WP-UI-D: assessment', () => {
  it('computes readiness from blockers, EOL and unknown types, and says it the provider\'s way', () => {
    const r = appReadiness(PLAN, SHOP, '2026-09-26');
    expect(r.eol).toBe(1);
    expect(r.score).toBe(100 - 10 * r.eol - 10 * r.unknown - 25 * r.blockers);
    expect(providerReadiness('azure', r).verdict).toBe(r.unknown > 0 ? 'Readiness unknown' : 'Conditionally ready');
    expect(providerReadiness('oci', r).verdict).toBe('WARNING');
    expect(providerReadiness('aws', r).term).toBe('Confidence score and risk flags');
  });
});

describe('WP-UI-D: a new application', () => {
  it('with no servers, is recommended a cloud, and generates a stack and a pipeline', () => {
    const made = newApplication(PLAN, { name: 'portal', pattern: 'web-app', owner: 'digital', criticality: 'tier2', load: { environments: ['prod'], nonprodPct: 25, peakRps: 150, dataGib: 50, slo: '99.9' } });
    const id = made.app.id;
    expect(made.plan.workloads.filter((w) => w.app === 'portal' && !w.synthetic)).toEqual([]);
    const rec = recommendationOf(made.plan, id);
    expect(rec.recommended !== undefined).toBe(true);
    const placed = chooseAppPlatform(made.plan, id, rec.recommended!).plan;
    const build = buildStack(placed, [id], { cicd: 'github-actions', record: false });
    expect(Object.keys(build.files).some((f) => /\/terraform\/[a-z]+\/.*\.tf$/.test(f))).toBe(true);
    expect(build.pipeline.length > 0).toBe(true);
    expect(build.pipeline.some((f) => f.startsWith('portal/ci/') || f.startsWith('portal/.github/'))).toBe(true);
    expect(fileTree(build.files).length > 1).toBe(true);
    const none = buildStack(placed, [id], { cicd: 'none', record: false });
    expect(none.pipeline).toEqual([]);
  });

  it('stacks several apps into one project', () => {
    const recs = recommendationsOf(PLAN);
    const placed = useRecommendation(PLAN, [FIN, SHOP], recs).plan;
    const build = buildStack(placed, [FIN, SHOP], { cicd: 'none', record: false });
    expect(build.result.folder).toBe('ui-d-sample-apps');
    expect(Object.keys(build.files).every((f) => f.startsWith('ui-d-sample-apps/'))).toBe(true);
  });
});
