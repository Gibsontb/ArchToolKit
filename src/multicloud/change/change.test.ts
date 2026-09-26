import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { ANSIBLE_SCHEMA_INDEX } from '../../ansible/module-schema-index.ts';
import { CATALOG_DATA } from '../../terraform/catalog-data.ts';
import { chooseAppPlatform } from '../plan/apps/recommend.ts';
import { appPlanOf, newApplication, withAppPlan } from '../plan/apps/components.ts';
import { DEFAULT_WAVE_SETTINGS, defaultRequirements, itemId, overrideKey } from '../plan/options.ts';
import { PLAN_KIND, STATUS_EVENT_KIND } from '../plan/types.ts';
import type { App, ChangeRecord, Plan, Platform, StatusEvent, Workload } from '../plan/types.ts';
import {
  CHANGE_LOG_COLUMNS, UTILITIES, applyChangeEvents, applyPlanOps, bundleViolations, changeLogGrid, changeState, defaultUtilityValues, findUtility,
  generateChange, parseStatusEvents, revertPlanOps, setChangeCr, upsertChangeRecord, utilitiesByCategory, utilityInputs, type ChangeBundle,
} from './index.ts';
import { modulesOf } from './utilities/common.ts';
import { diffFileSets, unifiedDiff } from './utilities/diff.ts';

const DATE = '2026-09-26';
const PLATFORMS: readonly Platform[] = ['vmware', 'aws', 'azure', 'google', 'oci'];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workload(name: string, app: string, over: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app, env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
  };
}
function app(name: string): App {
  return { id: itemId('app', name), name, criticality: 'tier1', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none' };
}
const BASE: Plan = {
  kind: PLAN_KIND, version: 1, id: 'plan-wp20', name: 'Utilities', savedAt: `${DATE}T00:00:00.000Z`,
  workloads: [workload('shop-app01', 'shop'), workload('shop-web01', 'shop', { role: 'web', os: 'win-2022' }), workload('legacy01', 'legacy')],
  databases: [], apps: [app('shop'), app('legacy')], edges: [],
  requirements: {
    ...defaultRequirements(), maxPlatforms: 5,
    regions: { ...defaultRequirements().regions, vmware: { primary: 'wld01-vc01.corp.example.com' } },
    sites: [{ name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.0.0.0/16', 'fd00:10::/48'], bandwidth: '1g', circuit: 'none' }],
  },
  designOverrides: { 'vmware:lz:datacenter': 'dc01', 'vmware:lz:cluster': 'cl01', 'vmware:lz:datastore': 'vsan01' },
  waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] }, appPlans: [],
};

const plans = new Map<Platform, Plan>();
/** `shop` planned on the platform (its stack manages shop-app01), and a new app `portal`, planned, with smoke checks. */
function planOn(p: Platform): Plan {
  const had = plans.get(p);
  if (had) return had;
  let plan = chooseAppPlatform(BASE, 'shop', p).plan;
  plan = withAppPlan(plan, { ...appPlanOf(plan, 'shop')!, status: 'planned' });
  const n = newApplication(plan, { name: 'portal', pattern: 'web-app', load: { environments: ['dev', 'prod'], nonprodPct: 25, peakRps: 200, dataGib: 100, tps: 50, slo: '99.9' } });
  plan = chooseAppPlatform(n.plan, 'portal', p).plan;
  plan = withAppPlan(plan, {
    ...appPlanOf(plan, 'portal')!, status: 'planned',
    smoke: [{ kind: 'http', target: 'https://portal.corp.example.com/health' }, { kind: 'tcp', target: 'portal.corp.example.com:443' }],
  });
  plans.set(p, plan);
  return plan;
}

/** Every utility on every platform it declares, with its defaults, in a plan (managed targets) and without one. */
function allBundles(): { u: string; p: Platform; mode: 'plan' | 'bare'; b: ChangeBundle }[] {
  const out: { u: string; p: Platform; mode: 'plan' | 'bare'; b: ChangeBundle }[] = [];
  for (const u of UTILITIES) {
    for (const p of u.platforms) {
      const values = { ...defaultUtilityValues(u, p), ...(u.id === 'deploy-service' ? { app: 'portal' } : { app: 'shop' }) };
      out.push({ u: u.id, p, mode: 'plan', b: generateChange(u.id, { ...values, server: 'shop-app01' }, { plan: planOn(p), date: DATE }) });
      if (u.id !== 'deploy-service') out.push({ u: u.id, p, mode: 'bare', b: generateChange(u.id, values, { date: DATE }) });
    }
  }
  return out;
}
let cached: ReturnType<typeof allBundles> | undefined;
const bundles = (): ReturnType<typeof allBundles> => (cached ??= allBundles());
const rel = (b: ChangeBundle, f: string): string => f.slice(b.folder.length + 1);

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const TABLE_ROWS = [
  'add-server', 'resize-server', 'add-disk', 'extend-disk', 'add-database', 'open-port', 'dns-record', 'lb-member', 'snapshot-backup', 'patch-run',
  'tags', 'scale-node-pool', 'file-share', 'monitoring-alert', 'power', 'budget', 'add-any', 'deploy-service',
];

describe('change/catalogue', () => {
  it('covers every row of the A.9.2 table, and the added day-2 changes', () => {
    const ids = UTILITIES.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of TABLE_ROWS) expect(ids).toContain(id);
    for (const id of ['remove-server', 'rotate-certificate', 'restart-service', 'install-package', 'user-group', 'grant-access']) expect(ids).toContain(id);
    expect(UTILITIES.filter((u) => u.source === 'added').length).toBe(6);
    expect(findUtility('deploy-service')?.source).toBe('A.9.3');
  });

  it('declares platforms, a platform dropdown first, a risk, reversibility and a rollback sentence', () => {
    for (const u of UTILITIES) {
      expect(u.platforms.length).toBeGreaterThan(0);
      const first = u.inputs[0]!;
      expect(first.id).toBe('platform');
      expect(first.control).toBe('select');
      expect(first.options?.map((o) => o.value)).toEqual([...u.platforms]);
      expect(['low', 'medium', 'high']).toContain(u.risk);
      expect(typeof u.reversible).toBe('boolean');
      expect(u.rollback.length).toBeGreaterThan(10);
      for (const i of u.inputs) if (i.control === 'select') expect((i.options ?? []).length).toBeGreaterThan(0);
    }
  });

  it('groups by category and fills plan-fed dropdowns', () => {
    expect(utilitiesByCategory().reduce((n, g) => n + g.utilities.length, 0)).toBe(UTILITIES.length);
    const u = findUtility('resize-server')!;
    const inputs = utilityInputs(u, { platform: 'aws', server: 'shop-app01' }, { plan: planOn('aws') });
    const server = inputs.find((i) => i.id === 'server')!;
    expect(server.options?.map((o) => o.value)).toContain('shop-app01');
    const size = inputs.find((i) => i.id === 'size')!;
    expect((size.options ?? []).some((o) => o.group === 'Sizing engine')).toBe(true);
    const deploy = utilityInputs(findUtility('deploy-service')!, {}, { plan: planOn('aws') }).find((i) => i.id === 'app')!;
    expect(deploy.options?.map((o) => o.value)).toEqual(['portal']);
  });
});

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

describe('change/acceptance', () => {
  it('every utility builds with its defaults for every platform it declares, with no error', () => {
    const bad: string[] = [];
    for (const { u, p, mode, b } of bundles()) {
      const errors = b.findings.filter((f) => f.severity === 'error');
      if (errors.length) bad.push(`${u}/${p}/${mode}: ${errors.map((f) => f.message).join('; ')}`);
      for (const f of ['apply.sh', 'rollback.sh', 'README.md', 'change.json', 'lib/atk.sh', 'manifest/items.tsv']) {
        if (!b.files[`${b.folder}/${f}`]) bad.push(`${u}/${p}/${mode}: no ${f}`);
      }
      if (!b.folder.startsWith(`change-20260926-${u}-`)) bad.push(`${u}: folder ${b.folder}`);
    }
    expect(bad).toEqual([]);
  });

  it('every script keeps the execution contract (contractViolations), and no file holds a credential or a footprint', () => {
    const bad = bundles().flatMap(({ b }) => bundleViolations(b));
    expect(bad).toEqual([]);
  });

  it('apply.sh applies by default; --dry-run runs terraform plan and ansible-playbook --check --diff', () => {
    for (const { u, b } of bundles()) {
      const apply = b.files[`${b.folder}/apply.sh`]!;
      expect(apply).toContain('atk_init_tool');
      expect(apply).not.toContain('--yes');
      if (/tf_apply /.test(apply.split('trap change_on_error ERR')[1] ?? '')) {
        expect(apply).toContain('atk_run terraform -chdir="$dir" apply -input=false -auto-approve');
        expect(apply).toContain('terraform -chdir="$dir" plan -input=false');
      }
      if (/an_play /.test(apply.split('trap change_on_error ERR')[1] ?? '')) expect(apply).toContain('ATK_DRY_RUN=0 atk_run ansible-playbook "$1" --check --diff');
      expect(u.length).toBeGreaterThan(0);
    }
  });

  it('every utility has a rollback with at least one step', () => {
    for (const { u, p, b } of bundles()) {
      const rb = b.files[`${b.folder}/rollback.sh`]!;
      const body = rb.split('trap change_on_error ERR')[1] ?? '';
      if (!/^step '/m.test(body)) throw new Error(`${u}/${p}: rollback.sh has no step`);
      expect(rb).toContain('rollback started');
    }
  });

  it('a hyperscaler module keeps the landing-zone variables contract, and finds targets by name (no pasted ids)', () => {
    for (const { u, p, b } of bundles()) {
      if (p === 'vmware') continue;
      for (const [f, t] of Object.entries(b.files)) {
        const r = rel(b, f);
        if (!/^terraform\/[^/]+\.tf$/.test(r)) continue;
        if (/\b(sg|subnet|vpc|i|vol)-[0-9a-f]{8,}\b|ocid1\.[a-z]+\.oc1\.\.[a-z0-9]{20,}|\/subscriptions\/[0-9a-f]{8}-/.test(t)) throw new Error(`${u}/${p}: a pasted id in ${r}`);
      }
      const vars = b.files[`${b.folder}/terraform/variables.tf`];
      if (vars?.includes('variable "landing_zone"')) {
        expect(b.files[`${b.folder}/terraform/landing_zone.auto.tfvars.json.example`]).toBeDefined();
        const readme = b.files[`${b.folder}/README.md`]!;
        expect(readme).toContain(`output -json landing_zone | jq '{landing_zone: .}' > terraform/landing_zone.auto.tfvars.json`);
      }
    }
  });

  it('every Terraform resource and data source type is in catalog-data.ts', () => {
    const have = new Set<string>();
    for (const [target, e] of Object.entries(CATALOG_DATA)) {
      const prefix = target === 'azure' ? 'azurerm_' : `${target}_`;
      for (const n of e.resources.split(',')) have.add(`resource:${prefix}${n}`);
      for (const n of e.dataSources.split(',')) have.add(`data:${prefix}${n}`);
    }
    const missing = new Set<string>();
    let seen = 0;
    for (const { b } of bundles()) {
      for (const [f, t] of Object.entries(b.files)) {
        if (!f.endsWith('.tf')) continue;
        for (const m of t.matchAll(/^(resource|data) "([a-z0-9_]+)"/gm)) {
          seen += 1;
          // Google's IAM triplets are catalogued once, as <resource>_iam.
          const iam = m[2]!.replace(/_iam_(member|binding|policy)$/, '_iam');
          if (!have.has(`${m[1]}:${m[2]}`) && !have.has(`${m[1]}:${iam}`)) missing.add(`${m[1]} ${m[2]} (${rel(b, f)})`);
        }
      }
    }
    expect(seen).toBeGreaterThan(100);
    expect([...missing]).toEqual([]);
  });

  it('every Ansible module the playbooks call is in the module schema index', () => {
    const modules = new Set(Object.keys((ANSIBLE_SCHEMA_INDEX as { modules: Record<string, unknown> }).modules));
    const missing = new Set<string>();
    for (const { b } of bundles()) {
      for (const [f, t] of Object.entries(b.files)) {
        if (!/\/(ansible|validate)\/.*\.yml$/.test(f) || /group_vars|inventory|requirements/.test(f)) continue;
        for (const m of modulesOf(t)) if (!modules.has(m)) missing.add(`${m} (${rel(b, f)})`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('keeps the house rules: VCF names, "Google Cloud (GCP)", no footprints, the same bundle twice', () => {
    for (const { u, p, b } of bundles()) {
      for (const [f, t] of Object.entries(b.files)) {
        if (/\bESXi\b|\bvRealize\b|\bAria\b|Service Broker/.test(t)) throw new Error(`${u}/${p}: ${rel(b, f)} uses a retired name`);
      }
    }
    const u = findUtility('open-port')!;
    const one = generateChange('open-port', defaultUtilityValues(u, 'google'), { date: DATE });
    const two = generateChange('open-port', defaultUtilityValues(u, 'google'), { date: DATE });
    expect(two.files).toEqual(one.files);
    expect(one.files[`${one.folder}/README.md`]).toContain('Google Cloud (GCP)');
  });
});

// ---------------------------------------------------------------------------
// Plan-managed targets
// ---------------------------------------------------------------------------

describe('change/plan-managed', () => {
  it('resizes a server the app stack manages through the plan: an override and the stack\'s diff, no CLI', () => {
    const plan = planOn('aws');
    const b = generateChange('resize-server', { platform: 'aws', server: 'shop-app01', size: 'm7i.2xlarge' }, { plan, date: DATE });
    expect(b.route).toBe('plan');
    expect(b.planOps).toEqual([{ op: 'override', key: overrideKey('compute', itemId('workload', 'shop-app01'), 'size'), to: 'm7i.2xlarge' }]);
    const diff = b.files[`${b.folder}/stack/stack.diff`]!;
    expect(diff).toContain('+');
    expect(diff).toContain('m7i.2xlarge');
    const apply = b.files[`${b.folder}/apply.sh`]!;
    expect(apply).toContain('stack_apply after');
    expect(apply).not.toContain('modify-instance-attribute');
    expect(b.files[`${b.folder}/rollback.sh`]).toContain('stack_apply before');
    expect(b.plan?.designOverrides[b.planOps[0]!.op === 'override' ? b.planOps[0]!.key : '']).toBe('m7i.2xlarge');
    expect(revertPlanOps(b.plan!, b.planOps)).toEqual(plan);
  });

  it('adds a disk, a database and a server to managed apps through the plan, and reverts each update', () => {
    for (const p of ['azure', 'google', 'oci'] as const) {
      const plan = planOn(p);
      for (const [id, values] of [
        ['add-disk', { platform: p, server: 'shop-app01', size_gib: 200 }],
        ['add-database', { platform: p, app: 'shop', name: 'orders2' }],
        ['add-server', { platform: p, app: 'shop', name: 'shop-app03' }],
      ] as const) {
        const b = generateChange(id, values, { plan, date: DATE });
        expect(b.route).toBe('plan');
        expect(b.planOps.length).toBeGreaterThan(0);
        expect(b.files[`${b.folder}/stack/files.json`]).toBeDefined();
        expect(revertPlanOps(applyPlanOps(plan, b.planOps), b.planOps)).toEqual(plan);
      }
    }
  });

  it('changes a server outside the stacks directly, keeping the old value for the rollback', () => {
    const b = generateChange('resize-server', { platform: 'aws', server: 'legacy01', size: 'm7i.large' }, { plan: planOn('aws'), date: DATE });
    expect(b.route).toBe('cli');
    const apply = b.files[`${b.folder}/apply.sh`]!;
    expect(apply).toContain('change_remember size "$cur"');
    expect(apply).toContain('atk_run aws ec2 modify-instance-attribute');
    expect(b.files[`${b.folder}/rollback.sh`]).toContain('prev="$(change_recall size)"');
  });

  it('warns when the direct route is forced on a managed server', () => {
    const b = generateChange('resize-server', { platform: 'aws', server: 'shop-app01', size: 'm7i.large', route: 'direct' }, { plan: planOn('aws'), date: DATE });
    expect(b.route).toBe('cli');
    expect(b.findings.map((f) => f.code)).toContain('change.route.drift');
  });
});

// ---------------------------------------------------------------------------
// Specific utilities
// ---------------------------------------------------------------------------

describe('change/utilities', () => {
  it('opens a port for both address families, and an expiry writes expire.sh', () => {
    const b = generateChange('open-port', { platform: 'aws', from: '10.20.0.0/16 fd00:20::/48', ports: '443 8000-8100', expires: '2026-12-31' }, { date: DATE });
    const main = b.files[`${b.folder}/terraform/main.tf`]!;
    expect(main).toContain('cidr_ipv4');
    expect(main).toContain('cidr_ipv6');
    expect(main).toContain('from_port         = 8000');
    expect(b.files[`${b.folder}/expire.sh`]).toContain('rollback.sh');
    expect(JSON.parse(b.files[`${b.folder}/change.json`]!).expires).toBe('2026-12-31');
    const bad = generateChange('open-port', { platform: 'aws', expires: 'next week' }, { date: DATE });
    expect(bad.findings.map((f) => f.code)).toContain('change.port.expiry');
    const g = generateChange('open-port', { platform: 'google', from: 'site:dc1' }, { plan: planOn('google'), date: DATE });
    const gm = g.files[`${g.folder}/terraform/main.tf`]!;
    expect(gm).toContain('resource "google_compute_firewall" "ipv4"');
    expect(gm).toContain('resource "google_compute_firewall" "ipv6"');
  });

  it('writes DNS records in the zone\'s own DNS', () => {
    const r53 = generateChange('dns-record', { platform: 'aws', type: 'AAAA', value: 'fd00:40::21' }, { date: DATE });
    expect(r53.files[`${r53.folder}/terraform/main.tf`]).toContain('resource "aws_route53_record" "record"');
    const win = generateChange('dns-record', { platform: 'vmware', provider: 'windows-dns' }, { date: DATE });
    expect(win.files[`${win.folder}/ansible/record.yml`]).toContain('ansible.windows.win_dns_record');
    const ib = generateChange('dns-record', { platform: 'vmware', provider: 'infoblox' }, { date: DATE });
    expect(ib.files[`${ib.folder}/apply.sh`]).toContain('http_creds INFOBLOX_USER INFOBLOX_PASSWORD');
    const wrong = generateChange('dns-record', { platform: 'aws', type: 'A', value: 'fd00::1' }, { date: DATE });
    expect(wrong.findings.map((f) => f.code)).toContain('change.dns.family');
  });

  it('snapshots with a remove-after script, and patches in batches', () => {
    const s = generateChange('snapshot-backup', { platform: 'azure', server: 'app01', retention_days: 14 }, { date: DATE });
    expect(s.files[`${s.folder}/remove-after-14-days.sh`]).toContain('age < 14');
    const pr = generateChange('patch-run', { platform: 'aws', server: 'app01 app02', batch_pct: 50 }, { date: DATE });
    expect(pr.files[`${pr.folder}/ansible/patch.yml`]).toContain('serial: "50%"');
    const native = generateChange('patch-run', { platform: 'aws', server: 'app01', method: 'native' }, { date: DATE });
    expect(native.files[`${native.folder}/apply.sh`]).toContain('atk_run aws ssm send-command --document-name AWS-RunPatchBaseline');
  });

  it('merges OCI freeform tags and lower-cases Google Cloud labels', () => {
    const oci = generateChange('tags', { platform: 'oci', server: 'app01', add: 'CostCentre | CC-1' }, { date: DATE });
    expect(oci.files[`${oci.folder}/apply.sh`]).toContain(". + $add");
    const g = generateChange('tags', { platform: 'google', server: 'app01', add: 'CostCentre | CC-1' }, { date: DATE });
    expect(g.files[`${g.folder}/apply.sh`]).toContain('costcentre');
  });

  it('keeps credentials out: vault variables and environment files only', () => {
    const u = generateChange('user-group', { platform: 'vmware', directory: 'ad', kind: 'user' }, { date: DATE });
    expect(u.files[`${u.folder}/ansible/add.yml`]).toContain('password: "{{ vault_user_password }}"');
    expect(u.files[`${u.folder}/ansible/add.yml`]).toContain('no_log: true');
    const c = generateChange('rotate-certificate', { platform: 'aws', where: 'service' }, { date: DATE });
    expect(c.files[`${c.folder}/apply.sh`]).toContain('fileb://$CHANGE_KEY_FILE');
  });
});

// ---------------------------------------------------------------------------
// Deploy a new service
// ---------------------------------------------------------------------------

describe('change/deploy', () => {
  it('deploys a planned new app into the shared landing zone, reporting on the deploy path', () => {
    const b = generateChange('deploy-service', { platform: 'aws', app: 'portal', env: 'dev' }, { plan: planOn('aws'), date: DATE });
    expect(b.blocked).toBe(false);
    expect(Object.keys(b.files).some((f) => /\/app\/terraform\/aws\/.*\.tf$/.test(f))).toBe(true);
    const apply = b.files[`${b.folder}/apply.sh`]!;
    expect(apply).toContain('atk_init_tool deploy');
    expect(apply).toContain("CHANGE_ITEM='a:portal'");
    expect(apply).toContain('atk_event "$CHANGE_ITEM" validate succeeded');
    expect(b.files[`${b.folder}/validate/smoke.yml`]).toContain('ansible.builtin.uri');
    expect(b.files[`${b.folder}/validate/smoke.yml`]).toContain('validate_phase: deploy');
  });

  it('refuses a draft app plan', () => {
    const plan = planOn('aws');
    const draft = withAppPlan(plan, { ...appPlanOf(plan, 'portal')!, status: 'draft' });
    const b = generateChange('deploy-service', { platform: 'aws', app: 'portal' }, { plan: draft, date: DATE });
    expect(b.findings.map((f) => f.code)).toContain('change.deploy.draft');
  });
});

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

const ev = (item: string, step: StatusEvent['step'], outcome: StatusEvent['outcome'], at: string, extra: Partial<StatusEvent> = {}): StatusEvent => ({
  kind: STATUS_EVENT_KIND, v: 1, planId: 'plan-wp20', runId: 'r1', at, wave: null, item, path: 'change', step, outcome, dryRun: false, ...extra,
});

describe('change/log', () => {
  it('records a bundle, imports its events idempotently, and shows the grid', () => {
    const b = generateChange('dns-record', { platform: 'aws' }, { date: DATE, now: `${DATE}T08:00:00.000Z` });
    let records: ChangeRecord[] = upsertChangeRecord([], b.record);
    records = upsertChangeRecord(records, b.record);
    expect(records.length).toBe(1);
    expect(changeState(records[0]!)).toBe('generated');
    const text = [
      ev(b.id, 'deploy', 'started', `${DATE}T09:00:00Z`),
      ev(b.id, 'deploy', 'succeeded', `${DATE}T09:01:00Z`, { dryRun: true }),
      ev(b.id, 'deploy', 'succeeded', `${DATE}T09:02:00Z`),
      ev('chg-unknown', 'deploy', 'succeeded', `${DATE}T09:03:00Z`),
    ].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n';
    const { events, rejected } = parseStatusEvents(text);
    expect(rejected).toBe(1);
    const once = applyChangeEvents(records, events);
    expect(once.applied).toBe(1);
    expect(once.unknown).toBe(1);
    expect(once.records[0]!.appliedAt).toBe(`${DATE}T09:02:00Z`);
    expect(changeState(once.records[0]!)).toBe('applied');
    const twice = applyChangeEvents(once.records, events);
    expect(twice.applied).toBe(0);
    expect(twice.records).toEqual(once.records);
    const rolled = applyChangeEvents(twice.records, [ev(b.id, 'rollback', 'succeeded', `${DATE}T10:00:00Z`)]);
    expect(changeState(rolled.records[0]!)).toBe('rolled-back');
    const withCr = setChangeCr(rolled.records, b.id, 'CHG0012345');
    expect(withCr[0]!.cr).toBe('CHG0012345');
    expect(upsertChangeRecord(withCr, b.record)[0]!.cr).toBe('CHG0012345');
    expect(CHANGE_LOG_COLUMNS).toEqual(['Id', 'Utility', 'Target', 'Summary', 'Generated', 'Applied', 'Rolled back', 'CR']);
    const grid = changeLogGrid(withCr).split(' | ');
    expect(grid.length).toBe(8);
    expect(grid[7]).toBe('CHG0012345');
  });

  it('matches a deploy bundle\'s events by the app', () => {
    const b = generateChange('deploy-service', { platform: 'aws', app: 'portal' }, { plan: planOn('aws'), date: DATE });
    const r = applyChangeEvents([b.record], [ev('a:portal', 'deploy', 'succeeded', `${DATE}T11:00:00Z`, { path: 'deploy' })]);
    expect(r.records[0]!.appliedAt).toBe(`${DATE}T11:00:00Z`);
  });
});

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

describe('change/diff', () => {
  it('writes a unified diff with context and reports added, removed and changed files', () => {
    const a = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const b = 'a\nb\nc\nD\ne\nf\ng\nh\ni\n';
    const d = unifiedDiff('x.tf', a, b);
    expect(d).toContain('--- a/x.tf');
    expect(d).toContain('-d');
    expect(d).toContain('+D');
    expect(d).toContain('+i');
    expect(unifiedDiff('x.tf', a, a)).toBe('');
    const s = diffFileSets({ 'a.tf': a, 'gone.tf': 'x\n' }, { 'a.tf': b, 'new.tf': 'y\n' });
    expect(s.changed).toEqual(['a.tf']);
    expect(s.added).toEqual(['new.tf']);
    expect(s.removed).toEqual(['gone.tf']);
    expect(s.text).toContain('+++ /dev/null');
  });
});
