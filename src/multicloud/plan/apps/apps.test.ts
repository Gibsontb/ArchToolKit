import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import type { AnyRule } from '../decide/index.ts';
import { rule } from '../decide/index.ts';
import { defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../options.ts';
import type { App, Database, LoadProfile, Plan, Platform, RateRow, ResourceComponent, Workload } from '../types.ts';
import { RATECARD_KIND } from '../types.ts';
import { compareApp } from './compare.ts';
import { appComplexity } from './complexity.ts';
import { appPlanOf, deriveComponents, newApplication, setLoadProfile, withAppPlan } from './components.ts';
import { generateAppStack, placedSlice, plannedApps } from './generate.ts';
import {
  chooseAppPlatform, clearAppPlatform, decideApps, rankComponentPatterns, recommendApp, recommendationChanged, recommendationDecision, saveAppPlans,
  setTierPattern,
} from './recommend.ts';
import { appSlice, sliceFolder } from './slice.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TODAY = '2026-09-26';
const ENGINE = { today: TODAY };

export function workload(name: string, app: string, over: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app, env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
  };
}
export function database(name: string, app: string, over: Partial<Database> = {}): Database {
  return {
    id: itemId('database', name), name, engine: 'postgres', edition: 'community', version: 'pg-16', hosts: [], vcpu: 4, ramGib: 32,
    sizeGib: 200, ha: 'none', dr: 'none', features: [], licence: 'community', app, source: 'manual', ...over,
  };
}
export const app = (name: string, over: Partial<App> = {}): App => ({
  id: itemId('app', name), name, criticality: 'tier1', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', ...over,
});

/** crm: Windows / SQL Server with Software Assurance; shop: Linux + PostgreSQL; big: 25 servers and 5 databases (30 items). */
export function appsFixture(over: Partial<Plan> = {}): Plan {
  const big = Array.from({ length: 25 }, (_, i) => workload(`big${String(i).padStart(2, '0')}`, 'big', { role: i % 3 === 0 ? 'web' : 'app' }));
  const base = defaultRequirements();
  return {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'plan-wp19', name: 'Apps Move', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: [
      workload('crm-web01', 'crm', { role: 'web', os: 'win-2022', licence: 'byol-sa' }),
      workload('crm-web02', 'crm', { role: 'web', os: 'win-2022', licence: 'byol-sa' }),
      workload('crm-sql01', 'crm', { role: 'db', os: 'win-2022', vcpu: 8, ramGib: 64, licence: 'byol-sa' }),
      workload('shop-app01', 'shop'),
      workload('shop-app02', 'shop', { env: 'dev' }),
      ...big,
    ],
    databases: [
      database('crmdb', 'crm', { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2022', hosts: ['crm-sql01'], licence: 'byol-sa' }),
      database('orders', 'shop'),
      ...Array.from({ length: 5 }, (_, i) => database(`bigdb${i}`, 'big')),
    ],
    apps: [app('crm'), app('shop'), app('big')],
    edges: [],
    requirements: {
      ...base,
      maxPlatforms: 5,
      sites: [{ name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.0.0.0/16', 'fd00:10::/48'], bandwidth: '1g', circuit: 'none' }],
      licensing: { ...base.licensing, microsoftSa: 'yes-all' },
    },
    designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    appPlans: [],
    ...over,
  };
}

const LOAD: LoadProfile = { environments: ['prod'], nonprodPct: 25, peakRps: 200, dataGib: 100, tps: 50, slo: '99.9' };
const PLAN = appsFixture();
const ALL: readonly Platform[] = ['aws', 'azure', 'google', 'oci', 'vmware'];
const rows = (text: unknown): string[][] => String(text ?? '').split('\n').filter(Boolean).map((l) => l.split(' | ').map((c) => c.trim()));

/** Both apps placed on `p`, and a resource component added to shop there. */
export function placedOn(p: Platform, plan: Plan = PLAN): Plan {
  let out = chooseAppPlatform(plan, 'shop', p).plan;
  out = chooseAppPlatform(out, 'crm', p).plan;
  const bucket: Partial<Record<Platform, ResourceComponent>> = {
    aws: { id: 'c:shop:assets', name: 'assets', tier: 'data', kind: 'resource', type: 'aws_s3_bucket', blueprintId: 'res_aws_s3_bucket', values: { 'r.bucket': 'shop-assets-wp19' } },
    google: { id: 'c:shop:assets', name: 'assets', tier: 'data', kind: 'resource', type: 'google_storage_bucket', blueprintId: 'res_google_storage_bucket', values: { 'r.name': 'shop-assets-wp19', 'r.location': 'US' } },
  };
  const extra = bucket[p];
  if (!extra) return out;
  const ap = appPlanOf(out, 'shop')!;
  return withAppPlan(out, { ...ap, variants: { ...ap.variants, [p]: [...(ap.variants[p] ?? []), extra] } });
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

describe('apps/components: derived from the servers', () => {
  it('keys a component by tier (and type), and puts a database in its hosts\' data component', () => {
    const cs = deriveComponents(PLAN, 'crm');
    expect(cs.map((c) => c.id)).toEqual(['c:crm:web', 'c:crm:data']);
    expect(cs[0]!.servers).toEqual(['crm-web01', 'crm-web02']);
    expect(cs[1]!.servers).toEqual(['crm-sql01']);
    expect(cs[1]!.databases).toEqual(['crmdb']);
  });

  it('gives a database with no host its own data component', () => {
    const cs = deriveComponents(PLAN, 'shop');
    expect(cs.find((c) => c.tier === 'data')!.databases).toEqual(['orders']);
    expect(cs.find((c) => c.tier === 'app')!.servers).toEqual(['shop-app01', 'shop-app02']);
  });
});

// ---------------------------------------------------------------------------
// Recommendation and switching
// ---------------------------------------------------------------------------

describe('apps/recommend', () => {
  const free = recommendationDecision(PLAN, ENGINE);

  it('recommends Azure for a Windows / SQL Server app with Software Assurance, with lic.ms.ahb in the reasons', () => {
    const r = recommendApp(PLAN, free, 'crm');
    expect(r.recommended).toBe('azure');
    const azure = r.perPlatform.find((p) => p.platform === 'azure')!;
    expect(azure.topHits.map((h) => h.rule)).toContain('lic.ms.ahb');
    expect(azure.topHits.length).toBeLessThanOrEqual(5);
    expect(r.margin).toBeGreaterThan(0);
    expect(r.perPlatform.map((p) => p.platform)).toEqual(ALL);
  });

  it('scores every allowed platform and reads "too close" at 2 points per item', () => {
    const r = recommendApp(PLAN, free, 'shop');
    expect(r.perPlatform.every((p) => p.eligible)).toBe(true);
    expect(r.recommended).toBeDefined();
    expect(r.tooClose).toBe(true);
  });

  it('names the eliminating rules of an ineligible platform', () => {
    const noOci: AnyRule = rule<Workload>({ id: 'test.no-oci', kind: 'workload', verification: 'I', evaluate: (_w, o) => (o.platform === 'oci' ? { eliminate: true, reason: 'Not on OCI (test).' } : undefined) });
    const d = recommendationDecision(PLAN, { ...ENGINE, extraRules: [noOci] });
    const oci = recommendApp(PLAN, d, 'shop').perPlatform.find((p) => p.platform === 'oci')!;
    expect(oci.eligible).toBe(false);
    expect(oci.eliminatedBy).toEqual(['test.no-oci']);
  });

  it('switching writes the platform, and the next decision eliminates the others for every item of the app', () => {
    const r = chooseAppPlatform(PLAN, 'shop', 'google');
    expect(appPlanOf(r.plan, 'shop')!.platform).toBe('google');
    expect(r.appPlan.variants.google!.length).toBeGreaterThan(0);
    expect(r.logEntry).toContain('Google Cloud (GCP)');
    const d = decideApps(r.plan, ENGINE);
    for (const name of ['shop-app01', 'shop-app02']) {
      const item = d.items[itemId('workload', name)]!;
      expect(item.chosen?.platform).toBe('google');
      for (const o of item.options.filter((x) => x.platform !== 'google')) expect(o.eliminated).toBe('app.chosen-platform');
    }
    const db = d.items[itemId('database', 'orders')]!;
    expect(db.chosen?.platform).toBe('google');
    // Other apps are untouched.
    expect(d.items[itemId('workload', 'crm-web01')]!.options.some((o) => o.platform !== 'google' && !o.eliminated)).toBe(true);
    // Cleared, it follows the recommendation again, with its variant kept.
    const cleared = clearAppPlatform(r.plan, 'shop');
    expect(appPlanOf(cleared, 'shop')!.platform).toBeUndefined();
    expect(appPlanOf(cleared, 'shop')!.variants.google).toBeDefined();
  });

  it('keeps every variant: AWS → Azure → AWS gives the AWS components back exactly', () => {
    const a = chooseAppPlatform(placedOn('aws'), 'shop', 'azure').plan;
    const b = chooseAppPlatform(a, 'shop', 'aws').plan;
    expect(appPlanOf(b, 'shop')!.variants.aws).toEqual(appPlanOf(placedOn('aws'), 'shop')!.variants.aws);
    expect(appPlanOf(b, 'shop')!.variants.azure).toBeDefined();
  });

  it('a tier pattern restricts the component\'s items on the next decision', () => {
    const chosen = chooseAppPlatform(PLAN, 'shop', 'aws').plan;
    const vmOnly = setTierPattern(chosen, 'shop', 'c:shop:data', 'vm', 'aws');
    const d = decideApps(vmOnly, ENGINE);
    const orders = d.items[itemId('database', 'orders')]!;
    expect(orders.chosen?.service).toBe('aws-ec2');
    expect(rankComponentPatterns(vmOnly, 'shop', 'c:shop:data', 'aws').length).toBeGreaterThan(0);
  });

  it('saving marks the plan planned and caches the recommendation with the engine version', () => {
    const recs = { [itemId('app', 'crm')]: recommendApp(PLAN, free, 'crm') };
    const saved = saveAppPlans(PLAN, ['crm'], recs, '2026-09-26T12:00:00.000Z');
    const ap = appPlanOf(saved, 'crm')!;
    expect(ap.status).toBe('planned');
    expect(ap.savedAt).toBe('2026-09-26T12:00:00.000Z');
    expect(ap.recommendation?.platform).toBe('azure');
    expect(recommendationChanged(ap, recs[itemId('app', 'crm')]!)).toBe(false);
    expect(plannedApps(saved)).toEqual([itemId('app', 'crm')]);
  });

  it('re-exports the complexity score', () => {
    const c = appComplexity(PLAN, 'crm', { on: TODAY, decision: free });
    expect(c.score).toBeGreaterThan(0);
    expect(c.factors.some((f) => f.id === 'databases')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

describe('apps/compare', () => {
  it('gives five columns for a 30-item app in under 50 ms, each with components, sizes, translation, licences and findings', () => {
    compareApp(PLAN, 'big', { engine: ENGINE }); // warm
    let best = Infinity;
    let cmp = compareApp(PLAN, 'big', { engine: ENGINE });
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      cmp = compareApp(PLAN, 'big', { engine: ENGINE });
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(50);
    expect(cmp.columns.map((c) => c.label)).toEqual(['AWS', 'Azure', 'Google Cloud (GCP)', 'OCI', 'VMware / VCF (private cloud)']);
    for (const col of cmp.columns) {
      expect(col.components.length).toBeGreaterThan(0);
      expect(col.components.every((c) => c.outcome === 'mapped')).toBe(true);
      expect(col.components.find((c) => c.name === 'app')!.sizes.length).toBeGreaterThan(0);
      expect(col.footprint.vcpu).toBeGreaterThan(0);
      expect(Array.isArray(col.licences)).toBe(true);
      expect(col.findings.error + col.findings.warning + col.findings.info).toBe(col.findings.list.length);
      expect(col.estimate).toBeUndefined();
    }
    expect(cmp.columns.filter((c) => c.verdict.recommended).length).toBe(1);
  });

  it('shows the estimate only with a rate card, always labelled', () => {
    const card: { rows: RateRow[] } = {
      rows: [
        { platform: 'aws', region: '', category: 'compute', key: 'm7i.large', unit: 'hour', rate: 0.1, currency: 'USD', source: 'my 2026 quote' },
        { platform: 'azure', region: '', category: 'compute', key: 'Standard_D2s_v5', unit: 'hour', rate: 0.1, currency: 'USD', source: 'my 2026 quote' },
      ],
    };
    const cmp = compareApp(PLAN, 'shop', { engine: ENGINE, rateCard: card });
    const aws = cmp.columns.find((c) => c.platform === 'aws')!;
    expect(aws.estimate).toBeDefined();
    expect(aws.estimate!.label.startsWith('estimate from your rates (source: ')).toBe(true);
    expect(aws.estimate!.monthly[0]!.label.startsWith('estimate from your rates')).toBe(true);
    expect(aws.estimate!.noRate).toBeGreaterThan(0);
    // An empty card is no card.
    expect(compareApp(PLAN, 'shop', { engine: ENGINE, rateCard: { rows: [] } }).columns.every((c) => c.estimate === undefined)).toBe(true);
    void RATECARD_KIND;
  });

  it('shows the translation per component, and an ineligible platform\'s eliminating rules per item', () => {
    const noOci: AnyRule = rule<Workload>({ id: 'test.no-oci', kind: 'workload', verification: 'I', evaluate: (_w, o) => (o.platform === 'oci' ? { eliminate: true, reason: 'Not on OCI (test).' } : undefined) });
    const cmp = compareApp(placedOn('aws'), 'shop', { engine: { ...ENGINE, extraRules: [noOci] } });
    const oci = cmp.columns.find((c) => c.platform === 'oci')!;
    expect(oci.verdict.eligible).toBe(false);
    expect(oci.eliminatedBecause.map((e) => e.item)).toEqual(['shop-app01', 'shop-app02']);
    expect(oci.eliminatedBecause[0]!.rules[0]).toEqual({ rule: 'test.no-oci', reason: 'Not on OCI (test).' });
    const azureAssets = cmp.columns.find((c) => c.platform === 'azure')!.components.find((c) => c.componentId === 'c:shop:assets')!;
    expect(azureAssets.targetTypes.length).toBeGreaterThan(0);
    expect(['mapped', 'partial']).toContain(azureAssets.outcome);
    expect(cmp.columns.find((c) => c.platform === 'aws')!.verdict.chosen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** The files of a stack that belong to one app's own items, by the item label after the number. */
function ownFiles(files: Readonly<Record<string, string>>, dir: string, appName: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [f, t] of Object.entries(files)) {
    const m = new RegExp(`^${dir}/\\d\\d-(${appName}-.*\\.tf)$`).exec(f);
    if (m) out[m[1]!] = t;
  }
  return out;
}

/** A VM's entry in the compute contract (local.mig_vms), as text. */
function vmEntry(text: string, name: string): string {
  const at = text.indexOf(`    ${name} = {`);
  if (at < 0) return '';
  const end = text.indexOf('\n    }\n', at);
  return text.slice(at, end);
}

describe('apps/generate', () => {
  it('slices only the selected apps, under the plan\'s own id and name', () => {
    const s = appSlice(PLAN, ['shop']);
    expect(s.apps.map((a) => a.name)).toEqual(['shop']);
    expect(s.workloads.map((w) => w.name)).toEqual(['shop-app01', 'shop-app02']);
    expect(s.databases.map((d) => d.name)).toEqual(['orders']);
    expect(s.id).toBe(PLAN.id);
    expect(sliceFolder(PLAN, ['shop'])).toBe('shop');
    expect(sliceFolder(PLAN, ['shop', 'crm'])).toBe('apps-move-apps');
  });

  it('places an app with no choice on its recommendation, so it never straddles clouds', () => {
    const s = placedSlice(PLAN, ['crm'], ENGINE);
    expect(appPlanOf(s, 'crm')!.platform).toBe('azure');
  });

  it('gives byte-identical .tf for an app generated alone and stacked with another', () => {
    const plan = placedOn('aws');
    const one = generateAppStack(plan, ['shop'], { landingZone: 'shared', record: false, engine: ENGINE });
    const two = generateAppStack(plan, ['shop', 'crm'], { landingZone: 'shared', record: false, engine: ENGINE });
    const a = ownFiles(one.files, 'shop/terraform/aws', 'shop');
    const b = ownFiles(two.files, 'apps-move-apps/terraform/aws', 'shop');
    expect(Object.keys(a).sort()).toEqual(['shop-assets.tf', 'shop-context.tf', 'shop-monitoring.tf']);
    expect(b).toEqual(a);
    const c1 = Object.entries(one.files).find(([f]) => /terraform\/aws\/\d\d-compute\.tf$/.test(f))![1];
    const c2 = Object.entries(two.files).find(([f]) => /terraform\/aws\/\d\d-compute\.tf$/.test(f))![1];
    for (const vm of ['shop-app01', 'shop-app02']) {
      expect(vmEntry(c1, vm).length).toBeGreaterThan(0);
      expect(vmEntry(c2, vm)).toBe(vmEntry(c1, vm));
    }
    expect(vmEntry(c2, 'crm-web01').length).toBeGreaterThan(0);
    // Every file the one-app stack has with the same name and no other app's rows is the same.
    for (const f of ['variables.tf', 'providers.tf', 'versions.tf']) expect(two.files[`apps-move-apps/terraform/aws/${f}`]).toBe(one.files[`shop/terraform/aws/${f}`]);
  });

  it('shared: declares var.landing_zone and emits no landing-zone resources; included: builds its own', () => {
    const plan = placedOn('aws');
    const shared = generateAppStack(plan, ['shop'], { landingZone: 'shared', record: false, engine: ENGINE });
    const tf = Object.entries(shared.files).filter(([f]) => f.startsWith('shop/terraform/aws/') && f.endsWith('.tf'));
    expect(tf.some(([f]) => /landing-zone|identity|connectivity/.test(f))).toBe(false);
    const all = tf.map(([, t]) => t).join('\n');
    expect(all).toContain('variable "landing_zone"');
    expect(/resource "aws_(vpc|subnet|internet_gateway|nat_gateway|kms_key)"/.test(all)).toBe(false);
    expect(/local\.landing_zone\b/.test(all)).toBe(false);
    expect(shared.files['shop/README.md']).toContain("output -json landing_zone | jq '{landing_zone: .}'");
    expect(shared.landingZones.aws).toBe('shared');
    const included = generateAppStack(plan, ['shop'], { landingZone: 'included', record: false, engine: ENGINE });
    expect(Object.keys(included.files).some((f) => /shop\/terraform\/aws\/01-landing-zone\.tf$/.test(f))).toBe(true);
  });

  it("adds the cloud's own template format: CloudFormation on AWS, Bicep and ARM on Azure", () => {
    const aws = generateAppStack(placedOn('aws'), ['shop'], { record: false, engine: ENGINE });
    expect(Object.keys(aws.files).some((f) => /^shop\/aws-cloudformation\/.+\.yaml$/.test(f))).toBe(true);
    expect(Object.keys(aws.files).some((f) => f.startsWith('shop/azure-bicep/'))).toBe(false);
    const azure = generateAppStack(placedOn('azure'), ['shop'], { record: false, engine: ENGINE });
    expect(azure.files['shop/azure-bicep/main.bicep']).toBeDefined();
    expect(azure.files['shop/azure-bicep/azuredeploy.json']).toBeDefined();
  });

  it('defaults to shared where the landing zone is designed on Migration & Utilities, else included', () => {
    const plan = placedOn('aws');
    const designed = { ...plan, execution: { landingZones: { aws: 'designed' } } } as unknown as Plan;
    expect(generateAppStack(designed, ['shop'], { record: false, engine: ENGINE }).landingZones.aws).toBe('shared');
    expect(generateAppStack(plan, ['shop'], { record: false, engine: ENGINE }).landingZones.aws).toBe('included');
  });

  it('writes the README, the app plan, the decision record and Ansible, with no footprint and no credential', () => {
    const g = generateAppStack(placedOn('aws'), ['shop'], { landingZone: 'shared', engine: ENGINE });
    expect(Object.keys(g.files)).toContain('shop/app-plan.json');
    expect(Object.keys(g.files)).toContain('shop/decision/app-record.md');
    expect(Object.keys(g.files).some((f) => f.startsWith('shop/ansible/'))).toBe(true);
    expect(JSON.parse(g.files['shop/app-plan.json']!).kind).toBe('archtoolkit.multicloud-plan');
    expect(g.files['shop/decision/app-record.md']).toContain('Google Cloud (GCP)');
    const all = Object.values(g.files).join('\n');
    expect(/Generated by|gibso|\\Users\\/.test(all)).toBe(false);
    expect(/password\s*=\s*"[^"$]/i.test(all)).toBe(false);
    expect(g.handoffs.terraform.aws).toBeDefined();
    // Reproducible.
    expect(generateAppStack(placedOn('aws'), ['shop'], { landingZone: 'shared', engine: ENGINE }).files).toEqual(g.files);
  });
});

// ---------------------------------------------------------------------------
// New applications
// ---------------------------------------------------------------------------

describe('apps: a new application (greenfield)', () => {
  const made = newApplication(PLAN, { name: 'portal', pattern: 'web-app', load: LOAD });

  it('creates the app, one variant per allowed platform with its default tier patterns, and synthetic items', () => {
    const ap = appPlanOf(made.plan, 'portal')!;
    expect(ap.origin).toBe('new');
    expect(Object.keys(ap.variants)).toEqual(['aws', 'azure', 'google', 'oci', 'vmware']);
    expect(ap.variants.aws!.map((c) => c.name)).toEqual(['web', 'data', 'cache']);
    const web = ap.variants.aws!.find((c) => c.name === 'web')!;
    expect(web.kind === 'pattern' && web.tierPattern).toBe('paas-web');
    // OCI has no managed web runtime: its variant takes the next alternative.
    const ociWeb = ap.variants.oci!.find((c) => c.name === 'web')!;
    expect(ociWeb.kind === 'pattern' && ociWeb.tierPattern).toBe('containers');
    const synth = made.plan.workloads.filter((w) => w.synthetic);
    expect(synth.map((w) => w.name)).toEqual(['portal-web']);
    expect(synth[0]!.disposition).toBe('new');
    expect(made.plan.databases.filter((d) => d.app === 'portal').map((d) => `${d.name}:${d.engine}`)).toEqual(['portal-data:postgres', 'portal-cache:redis']);
    expect(ap.ingress?.exposure).toBe('public');
  });

  it('is recommended a platform from its requirements, and regenerates its items when the load changes', () => {
    const r = recommendApp(made.plan, recommendationDecision(made.plan, ENGINE), 'portal');
    expect(r.recommended).toBeDefined();
    const bigger = setLoadProfile(made.plan, 'portal', { ...LOAD, dataGib: 1000 });
    const before = made.plan.databases.find((d) => d.name === 'portal-data')!.sizeGib;
    const after = bigger.plan.databases.find((d) => d.name === 'portal-data')!.sizeGib;
    expect(after).toBeGreaterThan(before);
    expect(bigger.plan.databases.filter((d) => d.name === 'portal-data').length).toBe(1);
  });

  it('produces a stack: the database built, the non-VM component left to its pattern item', () => {
    const chosen = chooseAppPlatform(made.plan, 'portal', 'aws').plan;
    const g = generateAppStack(chosen, ['portal'], { landingZone: 'shared', record: false, engine: ENGINE });
    const tf = Object.keys(g.files).filter((f) => f.startsWith('portal/terraform/aws/'));
    expect(tf.some((f) => /\d\d-databases\.tf$/.test(f))).toBe(true);
    expect(tf.some((f) => /\d\d-compute\.tf$/.test(f))).toBe(false);
    const env = JSON.parse(g.files['portal/terraform/aws/archtoolkit-terraform-settings.json']!) as { stack: { blueprintId: string; values: Record<string, string> }[] };
    const dbs = env.stack.find((i) => i.blueprintId === 'aws_mig_databases')!;
    expect(rows(dbs.values.databases).map((r) => r[0])).toEqual(['portal-data']);
    expect(g.findings.some((f) => f.code === 'plan.tf.pattern-not-generated' || f.code === 'plan.tf.extra-db-service')).toBe(true);
    expect(Object.values(g.files).join('\n')).toContain('variable "landing_zone"');
  });
});
