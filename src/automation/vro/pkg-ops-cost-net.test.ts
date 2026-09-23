/**
 * The VCF Operations cost and capacity, Networks and Logs automations as
 * Orchestrator packages: built, held to the repo's import rules, and run.
 *
 *   - every variant of every blueprint in vcf-ops-cost.ts and
 *     vcf-networks-logs.ts builds its package: it reads back through
 *     readPackageSpec, every script is ES5, every secret is a SecureString with
 *     no value, IMPORT.md names the package and every import/ file, every JSON
 *     parses, nothing holds a credential literal or puts a token on argv, and the
 *     fallback scripts are under scripts/;
 *   - each workflow runs in the emulator against a fake server in another
 *     process and makes exactly the calls it should: the read-only ones only read
 *     (GET, and the documented POST-for-query), the changing ones write nothing
 *     in a dry run, make exactly the expected calls in order with the right
 *     bodies when armed, leave what exists alone, stop at the cap and at the
 *     first failure, and no run logs a secret.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { readPackageSpec, type VroPackageSpec } from '../../kit/vro-package.ts';
import type { AutomationBlueprint } from '../from-automation.ts';
import { VCF_OPS_COST } from '../blueprints/vcf-ops-cost.ts';
import { LOGS_AUTOMATIONS, NETWORKS_AUTOMATIONS } from '../blueprints/vcf-networks-logs.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../../testing/fake-rest-server.ts';

const OPS = VCF_OPS_COST;
const NET_LOGS = [...NETWORKS_AUTOMATIONS, ...LOGS_AUTOMATIONS];
const ALL: readonly AutomationBlueprint[] = [...OPS, ...NET_LOGS];

const CURL = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
})();

function blueprint(id: string): AutomationBlueprint {
  const found = ALL.find((b) => b.id === id);
  if (!found) throw new Error(`no blueprint ${id}`);
  return found;
}

function build(id: string, overrides: BlueprintValues = {}): Record<string, string> {
  const b = blueprint(id);
  return { ...b.build({ ...defaultValues(b), ...overrides }, id).files };
}

/** Every variant the import tests build: defaults, each select option, each toggle flipped. */
function variants(b: AutomationBlueprint): { label: string; values: BlueprintValues }[] {
  const base = defaultValues(b);
  const out: { label: string; values: BlueprintValues }[] = [{ label: 'defaults', values: { ...base } }];
  for (const input of b.inputs) {
    if (input.control === 'select') for (const option of input.options ?? []) out.push({ label: `${input.id}=${option.value}`, values: { ...base, [input.id]: option.value } });
    if (input.control === 'toggle') out.push({ label: `${input.id}=${String(!base[input.id])}`, values: { ...base, [input.id]: !base[input.id] } });
  }
  return out;
}

interface Pkg {
  readonly dir: string;
  readonly spec: VroPackageSpec;
  readonly workflow: string;
  readonly configKey: string;
}

function pkgOf(files: Record<string, string>): Pkg {
  const packages = packagesIn(files);
  const dirs = Object.keys(packages).filter((d) => d !== 'com.archtoolkit.core.package');
  if (dirs.length !== 1) throw new Error(`expected one automation package, found ${dirs.join(', ')}`);
  const spec = readPackageSpec(packages[dirs[0]!]!);
  return { dir: dirs[0]!, spec, workflow: spec.workflows[0]!.name, configKey: `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}` };
}

function workflowScript(xml: string): string {
  return [...xml.matchAll(/<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/g)].map((m) => [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join('')).join('\n');
}

// ---------------------------------------------------------------------------

describe('pkg ops-cost-net: every variant builds a package that imports', () => {
  const credential = /\b(password|passwd|secret|api[_-]?key|token|credential)\w*\s*[:=]+\s*["'][^"'$%{<@]/i;
  const onArgv = /-H "?(Authorization|x-hm-authorization|vmware-api-session-id): *[A-Za-z]* *\$/;

  it('covers the ten blueprints', () => {
    expect(ALL.map((b) => b.id).sort()).toEqual(
      ['vcflog_alert_webhook', 'vcflog_audit_trail', 'vcfnet_change_watch', 'vcfnet_flow_check', 'vcfops_capacity_policy', 'vcfops_cost_drivers', 'vcfops_reclaim_91', 'vcfops_showback', 'vcfops_vks_cost', 'vcfops_whatif'].sort(),
    );
  });

  for (const b of ALL) {
    it(`${b.id}: package, ES5, SecureStrings, IMPORT.md, formats, no credential`, () => {
      const problems: string[] = [];
      for (const variant of variants(b)) {
        const where = `${b.id} (${variant.label})`;
        const out = b.build(variant.values, b.id);
        const files = out.files;
        const pkg = pkgOf(files);
        if (!pkg.spec.name.startsWith('com.archtoolkit.')) problems.push(`${where}: package ${pkg.spec.name}`);
        if (pkg.spec.workflows.length !== 1 || pkg.spec.configs.length !== 1) problems.push(`${where}: one workflow and one configuration element expected`);
        for (const a of pkg.spec.actions) problems.push(...es5Problems(a.script, `${where} ${a.name}`));
        for (const w of pkg.spec.workflows) problems.push(...es5Problems(workflowScript(w.xml), `${where} ${w.name}`));
        for (const attr of pkg.spec.configs[0]!.attributes) {
          if (attr.type === 'SecureString' && attr.value !== undefined) problems.push(`${where}: ${attr.name} carries a value`);
          if (/password|token|secret/i.test(attr.name) && attr.type !== 'SecureString') problems.push(`${where}: ${attr.name} is not a SecureString`);
        }
        const changes = pkg.spec.workflows[0]!.xml.includes('<param name="dryRun"');
        const attrs = pkg.spec.configs[0]!.attributes;
        if (changes && attrs.find((a) => a.name === 'dryRun')?.value !== true) problems.push(`${where}: dryRun is not on by default`);
        if (changes && typeof attrs.find((a) => a.name === 'cap')?.value !== 'number') problems.push(`${where}: no cap`);
        const md = files['IMPORT.md'] ?? '';
        const header = OPS.includes(b) ? '# Importing: ' : '# Importing this into ';
        if (!md.startsWith(header)) problems.push(`${where}: IMPORT.md does not start with "${header}"`);
        if (!md.includes(`import/${pkg.dir}`)) problems.push(`${where}: IMPORT.md does not name import/${pkg.dir}`);
        if (!md.includes('import/com.archtoolkit.core.package')) problems.push(`${where}: IMPORT.md does not name the core package`);
        if (md.indexOf('Import the two Orchestrator packages') < 0) problems.push(`${where}: IMPORT.md lacks the package steps`);
        for (const path of Object.keys(files).filter((p) => p.startsWith('import/'))) {
          if (!md.includes(path)) problems.push(`${where}: IMPORT.md does not name ${path}`);
          if (OPS.includes(b) && /polic/i.test(path)) problems.push(`${where}: ${path} would be read as a policy export`);
        }
        for (const [path, body] of Object.entries(files)) {
          if (/\.(json|vlcp)$/.test(path)) {
            try {
              JSON.parse(body);
            } catch (e) {
              problems.push(`${where}: ${path}: ${(e as Error).message}`);
            }
          }
          if (credential.test(body)) problems.push(`${where}: ${path} looks like it holds a credential`);
          if (/\.sh$/.test(path)) {
            if (!body.startsWith('#!/usr/bin/env bash')) problems.push(`${where}: ${path} has no bash shebang`);
            if (!path.startsWith('scripts/')) problems.push(`${where}: ${path} is not under scripts/`);
            body.split('\n').forEach((line, i) => {
              if (onArgv.test(line)) problems.push(`${where}: ${path}:${i + 1} puts a secret on argv`);
            });
          }
        }
        if ((out.findings ?? []).some((f) => f.severity === 'error') && variant.label === 'defaults') problems.push(`${where}: errors on its defaults`);
      }
      expect(problems).toEqual([]);
    });
  }

  it('keeps the native import artifacts and the fallback scripts', () => {
    const logAlert = build('vcflog_alert_webhook');
    expect(Object.keys(logAlert).filter((p) => /^import\/[^/]+\.(json|vlcp)$/.test(p)).sort()).toEqual(['import/vcflog-alert-webhook-alert.vlcp', 'import/vcflog-alert-webhook-queryconfig.json', 'import/vcflog-alert-webhook.json']);
    expect(logAlert['scripts/apply.sh']!.includes('cd "$(dirname "$0")/.."')).toBe(true);
    expect(/"enabled": false/.test(logAlert['import/vcflog-alert-webhook.json']!)).toBe(true);
    expect(typeof build('vcflog_audit_trail')['import/vcflog-audit-trail.vlcp']).toBe('string');
    expect(typeof build('vcfnet_flow_check')['scripts/run-check.sh']).toBe('string');
    expect(typeof build('vcfops_showback')['scripts/rate-card.json']).toBe('string');
    expect(build('vcfops_showback')['scripts/build-policy.sh']!.includes('cd "$(dirname "$0")"')).toBe(true);
    expect(build('vcfops_capacity_policy')['scripts/apply-report-schedule.sh']!.includes('cd "$(dirname "$0")"')).toBe(true);
    expect(typeof build('vcfops_reclaim_91', { mode: 'orphan-quarantine' })['scripts/orphan-disks.sh']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Running them

const OPS_PASSWORD = 'Ops-Pa55word-do-not-log';
const OPS_TOKEN = 'ops-token-do-not-log';
const SECRET = /do-not-log/;

function logText(run: WorkflowRun): string {
  return run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');
}

const servers: FakeServer[] = [];
after(() => servers.forEach((s) => s.stop()));

interface Ran {
  readonly result: WorkflowRun;
  readonly requests: FakeRequest[];
  /** Method and path without the query, every request. */
  readonly calls: string[];
  /** Every request that is not a GET, a login/logout or a documented POST-for-query. */
  readonly writes: string[];
  readonly host: string;
}

const QUERY_POST = /\/auth\/token\/(acquire|release)$|\/resources\/stats\/latest\/query$|^\/api\/ni\/auth\/token$|^\/api\/ni\/search\/ql$|^\/api\/ni\/entities\/fetch$|^\/api\/v2\/sessions$|^\/api\/session$|^\/hook$/;

async function run(files: Record<string, string>, routes: readonly FakeRoute[], settings: (host: string) => Record<string, unknown>, inputs: Record<string, unknown> = {}): Promise<Ran> {
  const server = await startFakeServer(routes);
  servers.push(server);
  const host = `127.0.0.1:${server.port}`;
  const pkg = pkgOf(files);
  const emulator = new VroEmulator(files, { config: { [pkg.configKey]: settings(host) } });
  const result = emulator.runWorkflow(pkg.workflow, inputs);
  const requests = server.requests();
  expect(SECRET.test(logText(result))).toBe(false);
  const calls = requests.map((r) => `${r.method} ${r.path.split('?')[0]}`);
  const writes = requests.filter((r) => r.method !== 'GET' && !QUERY_POST.test(r.path.split('?')[0]!)).map((r) => `${r.method} ${r.path.split('?')[0]}`);
  return { result, requests, calls, writes, host };
}

const ops = (host: string, extra: Record<string, unknown> = {}) => ({ opsHost: host, opsUsername: 'automation', opsPassword: OPS_PASSWORD, webhook: `https://${host}/hook`, ...extra });
const OPS_AUTH: FakeRoute[] = [
  { method: 'POST', path: '^/suite-api/api/auth/token/acquire$', body: { token: OPS_TOKEN, validity: 0 } },
  { method: 'POST', path: '^/suite-api/api/auth/token/release$', body: '' },
  { method: 'POST', path: '^/hook$', body: {} },
];
const list = (key: string, items: unknown[]) => ({ [key]: items, pageInfo: { totalCount: items.length, page: 0, pageSize: 1000 } });
const latest = (values: Record<string, Record<string, number>>) => ({
  values: Object.entries(values).map(([resourceId, stats]) => ({ resourceId, 'stat-list': { stat: Object.entries(stats).map(([key, v]) => ({ statKey: { key }, timestamps: [1], data: [v] })) } })),
});
const authorized = (ran: Ran, header: string, loginPath: RegExp) => ran.requests.every((r) => loginPath.test(r.path) || r.path === '/hook' || r.headers.authorization === header);

// ---------------------------------------------------------------------------

describe('pkg ops-cost-net: cost drivers', { skip: !CURL }, () => {
  const files = build('vcfops_cost_drivers');
  const routes = (currency: unknown = null, status = 200): FakeRoute[] => [
    ...OPS_AUTH,
    { method: 'GET', path: '^/suite-api/api/costconfig/currency$', status: currency ? status : 404, body: currency ?? { message: 'not set' } },
    { method: 'POST', path: '^/suite-api/api/costconfig/currency$', body: { code: 'USD', name: 'US Dollar', numericCode: '840' } },
    { method: 'GET', path: '^/suite-api/api/resources\\?adapterKind=VMWARE&resourceKind=ClusterComputeResource', body: list('resourceList', [{ identifier: 'c1', resourceKey: { name: 'cl-a' } }, { identifier: 'c2', resourceKey: { name: 'cl-b' } }]) },
    { method: 'GET', path: '^/suite-api/api/resources/c1/statkeys$', body: { 'stat-key': [{ key: 'cost|totalMonthlyCost' }, { key: 'cost|cpuCost' }, { key: 'cpu|usage_average' }] } },
    { method: 'POST', path: '^/suite-api/api/resources/stats/latest/query$', body: latest({ c1: { 'cost|totalMonthlyCost': 100, 'cost|cpuCost': 40 }, c2: { 'cost|totalMonthlyCost': 200, 'cost|cpuCost': 80 } }) },
  ];

  it('dry run: plans the currency, takes the snapshot, writes nothing', async () => {
    const ran = await run(files, routes(), (h) => ops(h));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(ran.result.logs.some((l) => l.message === 'DRY RUN: would set the cost currency to USD')).toBe(true);
    const snap = JSON.parse(String(ran.result.outputs.snapshot)) as { costKey: string; clusters: { name: string; stats: Record<string, number> }[] };
    expect(snap.costKey).toBe('cost|totalMonthlyCost');
    expect(snap.clusters.map((c) => `${c.name}=${c.stats['cost|totalMonthlyCost']}`)).toEqual(['cl-a=100', 'cl-b=200']);
    const query = JSON.parse(ran.requests.find((r) => r.path.endsWith('/latest/query'))!.body) as { resourceId: string[]; statKey: string[]; maxSamples: number };
    expect(query).toEqual({ resourceId: ['c1', 'c2'], statKey: ['cost|cpuCost', 'cost|totalMonthlyCost'], maxSamples: 1 });
  });

  it('armed: sets the currency once, in order, with the ISO code', async () => {
    const ran = await run(files, routes(), (h) => ops(h, { dryRun: false }), { dryRun: false });
    expect(ran.result.error).toBe(null);
    expect(ran.calls.filter((c) => c !== 'POST /hook')).toEqual([
      'POST /suite-api/api/auth/token/acquire',
      'GET /suite-api/api/costconfig/currency',
      'POST /suite-api/api/costconfig/currency',
      'GET /suite-api/api/resources',
      'GET /suite-api/api/resources/c1/statkeys',
      'POST /suite-api/api/resources/stats/latest/query',
      'POST /suite-api/api/auth/token/release',
    ]);
    expect(JSON.parse(ran.requests.find((r) => r.method === 'POST' && r.path === '/suite-api/api/costconfig/currency')!.body)).toEqual({ code: 'USD' });
    expect(authorized(ran, `OpsToken ${OPS_TOKEN}`, /acquire$/)).toBe(true);
    expect((JSON.parse(String(ran.result.outputs.summary)) as { changes: unknown[] }).changes.length).toBe(1);
  });

  it('leaves the same currency alone and refuses another, still logging out', async () => {
    const same = await run(files, routes({ code: 'USD' }), (h) => ops(h, { dryRun: false }));
    expect(same.result.error).toBe(null);
    expect(same.writes).toEqual([]);
    const other = await run(files, routes({ code: 'EUR' }), (h) => ops(h, { dryRun: false }));
    expect(other.result.error ?? '').toContain('Changing the currency is not a conversion');
    expect(other.writes).toEqual([]);
    expect(other.calls[other.calls.length - 1]).toBe('POST /suite-api/api/auth/token/release');
  });

  it('stops at the cap', async () => {
    const ran = await run(files, routes(), (h) => ops(h, { dryRun: false, cap: 0 }));
    expect(ran.writes).toEqual([]);
    expect(ran.result.error ?? '').toContain('Cap reached: 0 change(s) made, the cap is 0; stopping before: set the cost currency to USD');
  });

  it('compares with the baseline and fails on a cluster that moved too far', async () => {
    const baseline = JSON.stringify({ costKey: 'cost|totalMonthlyCost', clusters: [{ id: 'c1', name: 'cl-a', stats: { 'cost|totalMonthlyCost': 50 } }, { id: 'c2', name: 'cl-b', stats: { 'cost|totalMonthlyCost': 190 } }] });
    const ran = await run(files, routes({ code: 'USD' }), (h) => ops(h), { baseline });
    expect(ran.result.error ?? '').toContain('1 cluster(s) moved more than 30%: cl-a');
    expect(String(ran.result.outputs.report).trim().split('\n')).toEqual(['cluster,before,after,pct,over', '"cl-a",50,100,100,"OVER"', '"cl-b",190,200,5.3,""']);
    expect(ran.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('pkg ops-cost-net: showback rate card', { skip: !CURL }, () => {
  const files = build('vcfops_showback');
  const template = (withStorage = true) => ({
    id: 'tpl-1',
    name: 'Template',
    links: [{ href: 'x' }],
    lastUpdateTimestamp: 1,
    createdBy: 'admin',
    meterings: [
      { itemName: 'CPU', metering: { baseRate: 1, chargeBasedOn: 'ALLOCATION', chargePeriod: 'MONTHLY' } },
      { itemName: 'Memory', metering: { baseRate: 1, chargePeriod: 'MONTHLY' } },
      ...(withStorage ? [{ itemName: 'Storage', metering: { baseRate: 1, chargePeriod: 'MONTHLY' } }] : []),
    ],
    unconditionalMeterings: [{ itemName: 'VM fixed', unconditionalMetering: { rate: 1, chargePeriod: 'MONTHLY' } }],
  });
  const routes = (opts: { existing?: string; listStatus?: number; withStorage?: boolean; postStatus?: number } = {}): FakeRoute[] => [
    ...OPS_AUTH,
    { method: 'GET', path: '^/suite-api/api/pricing$', status: opts.listStatus ?? 200, body: { policies: opts.existing ? [{ id: 'pp-old', name: opts.existing }] : [{ id: 'tpl-1', name: 'Template' }] } },
    { method: 'GET', path: '^/suite-api/api/pricing/tpl-1$', body: template(opts.withStorage ?? true) },
    { method: 'POST', path: '^/suite-api/api/pricing$', status: opts.postStatus ?? 200, body: opts.postStatus ? { message: `refused ${OPS_PASSWORD}` } : { id: 'pp-1' } },
  ];
  const settings = (extra: Record<string, unknown> = {}) => (h: string) => ops(h, { templatePricingId: 'tpl-1', ...extra });

  it('dry run: reads the template and creates nothing', async () => {
    const ran = await run(files, routes(), settings());
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(ran.result.logs.some((l) => l.message.startsWith('DRY RUN: would create pricing "Standard rate card 2027"'))).toBe(true);
    expect(ran.result.outputs.pricingId).toBe('');
  });

  it('armed: one POST, the template’s items with the card’s rates', async () => {
    const ran = await run(files, routes(), settings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.calls.filter((c) => c !== 'POST /hook')).toEqual(['POST /suite-api/api/auth/token/acquire', 'GET /suite-api/api/pricing', 'GET /suite-api/api/pricing/tpl-1', 'POST /suite-api/api/pricing', 'POST /suite-api/api/auth/token/release']);
    const body = JSON.parse(ran.requests.find((r) => r.method === 'POST' && r.path === '/suite-api/api/pricing')!.body) as Record<string, unknown> & { meterings: { itemName: string; metering: { baseRate: number } }[]; unconditionalMeterings: { unconditionalMetering: { rate: number } }[] };
    expect(['id', 'links', 'lastUpdateTimestamp'].filter((k) => k in body)).toEqual([]);
    expect(body.name).toBe('Standard rate card 2027');
    expect(body.createdBy).toBe('VROPS');
    expect(body.meterings.map((m) => `${m.itemName}=${m.metering.baseRate}`)).toEqual(['CPU=18', 'Memory=4', 'Storage=0.1']);
    expect(body.unconditionalMeterings[0]!.unconditionalMetering.rate).toBe(5);
    expect(ran.result.outputs.pricingId).toBe('pp-1');
  });

  it('leaves one of the same name alone', async () => {
    const ran = await run(files, routes({ existing: 'Standard rate card 2027' }), settings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(ran.result.outputs.pricingId).toBe('pp-old');
  });

  it('refuses a rate that matches no item, before creating anything', async () => {
    const ran = await run(files, routes({ withStorage: false }), settings({ dryRun: false }));
    expect(ran.result.error ?? '').toContain('These rates match no item in the template');
    expect(ran.result.error ?? '').toContain('Storage GB');
    expect(ran.writes).toEqual([]);
  });

  it('says so when the build has no pricing API', async () => {
    const ran = await run(files, routes({ listStatus: 404 }), settings({ dryRun: false }));
    expect(ran.result.error ?? '').toContain('this build has no pricing API');
    expect(ran.writes).toEqual([]);
  });

  it('refuses a pricing list it does not recognise, rather than read it as empty and create a duplicate (regression)', async () => {
    const odd = routes().map((r) => (r.method === 'GET' && r.path === '^/suite-api/api/pricing$' ? { ...r, body: { pricingCards: [{ id: 'pp-old', name: 'Standard rate card 2027' }] } } : r));
    const ran = await run(files, odd, settings({ dryRun: false }));
    expect(ran.result.error ?? '').toContain('GET /suite-api/api/pricing returned no list this workflow recognises');
    expect(ran.writes).toEqual([]);
  });

  it('stops at the first failure and says what failed', async () => {
    const ran = await run(files, routes({ postStatus: 500 }), settings({ dryRun: false }));
    expect(ran.writes).toEqual(['POST /suite-api/api/pricing']);
    expect(ran.result.error ?? '').toContain('Stopped after 0 change(s): create pricing "Standard rate card 2027"');
    expect(ran.calls[ran.calls.length - 1]).toBe('POST /suite-api/api/auth/token/release');
  });
});

// ---------------------------------------------------------------------------

describe('pkg ops-cost-net: what-if baseline (reads only)', { skip: !CURL }, () => {
  const files = build('vcfops_whatif');
  const routes = (days: number): FakeRoute[] => [
    ...OPS_AUTH,
    { method: 'GET', path: '^/suite-api/api/resources\\?adapterKind=VMWARE&resourceKind=ClusterComputeResource&name=wld01-cl01&', body: list('resourceList', [{ identifier: 'c9', resourceKey: { name: 'wld01-cl01' } }]) },
    { method: 'GET', path: '^/suite-api/api/resources/c9/statkeys$', body: { 'stat-key': [{ key: 'OnlineCapacityAnalytics|cpu|timeRemaining' }, { key: 'OnlineCapacityAnalytics|mem|timeRemaining' }, { key: 'OnlineCapacityAnalytics|capacityRemainingPercentage' }, { key: 'cpu|usage_average' }] } },
    { method: 'POST', path: '^/suite-api/api/resources/stats/latest/query$', body: latest({ c9: { 'OnlineCapacityAnalytics|cpu|timeRemaining': 400, 'OnlineCapacityAnalytics|mem|timeRemaining': days, 'OnlineCapacityAnalytics|capacityRemainingPercentage': 30 } }) },
    { method: 'GET', path: '^/suite-api/api/whatif/scenarios$', body: { whatIfScenarios: [{ id: 's-1', name: 'Q1 ERP expansion', whatIfScenarioStatus: 'SAVED', state: 'ACTIVE' }], pageInfo: { totalCount: 1 } } },
  ];

  it('reads the capacity figures and the saved scenario, and changes nothing', async () => {
    const ran = await run(files, routes(200), (h) => ops(h));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(ran.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/suite-api/api/auth/token/acquire', '/suite-api/api/resources/stats/latest/query', '/suite-api/api/auth/token/release', '/hook']);
    const baseline = JSON.parse(String(ran.result.outputs.baseline)) as { cluster: string; stats: Record<string, number>; scenarioSaved: { status: string } };
    expect(baseline.cluster).toBe('wld01-cl01');
    expect(Object.keys(baseline.stats).sort()).toEqual(['OnlineCapacityAnalytics|capacityRemainingPercentage', 'OnlineCapacityAnalytics|cpu|timeRemaining', 'OnlineCapacityAnalytics|mem|timeRemaining']);
    expect(baseline.scenarioSaved.status).toBe('SAVED');
  });

  it('fails when the cluster is already short', async () => {
    const ran = await run(files, routes(30), (h) => ops(h));
    expect(ran.result.error ?? '').toContain('Least time remaining on wld01-cl01 is 30 days, under 90');
  });
});

// ---------------------------------------------------------------------------

describe('pkg ops-cost-net: reclaim exclusions and pre-run check', { skip: !CURL }, () => {
  const files = build('vcfops_reclaim_91');
  const tag = { category: 'Automation', name: 'never' };
  const routes = (failDc1 = false): FakeRoute[] => [
    ...OPS_AUTH,
    {
      method: 'GET',
      path: '^/suite-api/api/resources/groups/g-1/members\\?',
      body: list('resourceList', [
        { identifier: 'vm-1', resourceKey: { name: 'app1', resourceKindKey: 'VirtualMachine' } },
        { identifier: 'vm-2', resourceKey: { name: 'app2', resourceKindKey: 'VirtualMachine' } },
        { identifier: 'h-1', resourceKey: { name: 'esx1', resourceKindKey: 'HostSystem' } },
        { identifier: 'vm-3', resourceKey: { name: 'app3', resourceKindKey: 'VirtualMachine' } },
      ]),
    },
    { method: 'POST', path: '^/suite-api/api/resources/stats/latest/query$', body: latest({ 'vm-1': { 'summary|idle': 1, 'sys|poweredOn': 1 }, 'vm-2': { 'summary|oversized': 1 } }) },
    { method: 'GET', path: '^/suite-api/api/resources\\?adapterKind=VMWARE&resourceKind=Datacenter', body: list('resourceList', [{ identifier: 'dc-1', resourceKey: { name: 'DC-North' } }, { identifier: 'dc-2', resourceKey: { name: 'DC-South' } }, { identifier: 'dc-3', resourceKey: { name: 'DC-West' } }]) },
    { method: 'GET', path: '^/suite-api/api/optimization/datacenters/dc-1/exclusion/tags/$', body: { reclaim: [tag], rightsizing: [{ category: 'Owner', name: 'dba' }] } },
    { method: 'GET', path: '^/suite-api/api/optimization/datacenters/dc-2/exclusion/tags/$', body: { reclaim: [tag], rightsizing: [tag] } },
    { method: 'GET', path: '^/suite-api/api/optimization/datacenters/dc-3/exclusion/tags/$', body: {} },
    { method: 'PATCH', path: '^/suite-api/api/optimization/datacenters/dc-1/exclusion/tags/$', status: failDc1 ? 500 : 200, body: failDc1 ? { message: 'boom' } : {} },
    { method: 'PATCH', path: '^/suite-api/api/optimization/datacenters/dc-3/exclusion/tags/$', body: {} },
  ];
  const settings = (extra: Record<string, unknown> = {}) => (h: string) => ops(h, { groupId: 'g-1', ...extra });

  it('dry run: exports the scope and plans two datacenters, writes nothing', async () => {
    const ran = await run(files, routes(), settings());
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(ran.result.logs.filter((l) => l.message.startsWith('DRY RUN: would exclude Automation=never')).map((l) => l.message.split(' ').pop())).toEqual(['DC-North', 'DC-West']);
    expect(ran.result.outputs.vmCount).toBe(3);
    const csv = String(ran.result.outputs.scopeCsv).trim().split('\n');
    expect(csv[0]).toBe('"name","id","sys|poweredOn","summary|oversized","summary|undersized","summary|idle","diskspace|snapshot|age"');
    expect(csv.slice(1)).toEqual(['"app1","vm-1",1,,,1,', '"app2","vm-2",,1,,,', '"app3","vm-3",,,,,']);
  });

  it('armed: adds the tag to what each datacenter has, and leaves the one that has it', async () => {
    const ran = await run(files, routes(), settings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual(['PATCH /suite-api/api/optimization/datacenters/dc-1/exclusion/tags/', 'PATCH /suite-api/api/optimization/datacenters/dc-3/exclusion/tags/']);
    const bodies = ran.requests.filter((r) => r.method === 'PATCH').map((r) => JSON.parse(r.body) as unknown);
    expect(bodies[0]).toEqual({ reclaim: [tag], rightsizing: [{ category: 'Owner', name: 'dba' }, tag] });
    expect(bodies[1]).toEqual({ reclaim: [tag], rightsizing: [tag] });
    expect(authorized(ran, `OpsToken ${OPS_TOKEN}`, /acquire$/)).toBe(true);
  });

  it('fails the check over maxObjects, after the audit', async () => {
    const ran = await run(files, routes(), settings({ maxObjects: 2 }));
    expect(ran.result.error ?? '').toContain('The group has 3 VMs, over the cap of 2');
    expect(ran.requests.some((r) => r.path === '/hook')).toBe(true);
  });

  it('stops at the cap, and at the first failure', async () => {
    const capped = await run(files, routes(), settings({ dryRun: false, cap: 1 }));
    expect(capped.writes).toEqual(['PATCH /suite-api/api/optimization/datacenters/dc-1/exclusion/tags/']);
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: exclude Automation=never from reclaim and rightsizing in datacenter DC-West');
    const failed = await run(files, routes(true), settings({ dryRun: false }));
    expect(failed.writes).toEqual(['PATCH /suite-api/api/optimization/datacenters/dc-1/exclusion/tags/']);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): exclude Automation=never from reclaim and rightsizing in datacenter DC-North failed');
    expect(failed.calls[failed.calls.length - 1]).toBe('POST /suite-api/api/auth/token/release');
  });
});

// ---------------------------------------------------------------------------

describe('pkg ops-cost-net: orphaned disk check (reads only)', { skip: !CURL }, () => {
  const VC_PASSWORD = 'Vc-Pa55word-do-not-log';
  const vcRoutes = (vms: { vm: string; name: string; disks: string[] }[], hostState = 'CONNECTED'): FakeRoute[] => [
    { method: 'POST', path: '^/api/session$', body: JSON.stringify('vc-session-do-not-log') },
    { method: 'DELETE', path: '^/api/session$', status: 204 },
    { method: 'GET', path: '^/api/vcenter/host$', body: [{ host: 'host-1', name: 'esx1', connection_state: hostState }] },
    { method: 'GET', path: '^/api/vcenter/vm\\?hosts=host-1$', body: vms.map(({ vm, name }) => ({ vm, name })) },
    ...vms.map((v) => ({ method: 'GET', path: `^/api/vcenter/vm/${v.vm}$`, body: { name: v.name, disks: Object.fromEntries(v.disks.map((d, i) => [String(2000 + i), { label: `Hard disk ${i + 1}`, backing: { type: 'VMDK_FILE', vmdk_file: d } }])) } })),
    { method: 'POST', path: '^/hook$', body: {} },
  ];
  const VMS = [{ vm: 'vm-1', name: 'app1', disks: ['[ds1] app1/app1.vmdk'] }, { vm: 'vm-2', name: 'db1', disks: ['[ds2] db1/db1.vmdk', '[ds2] db1/db1_1.vmdk'] }];
  const settings = (extra: Record<string, unknown> = {}) => (h: string) => ({ vcenters: [h], vcUsername: 'reader@vsphere.local', vcPassword: VC_PASSWORD, webhook: `https://${h}/hook`, ...extra });
  const verdicts = (ran: Ran) => String(ran.result.outputs.manifestCsv).trim().split('\n').slice(1).map((line) => (JSON.parse(`[${line}]`) as string[]).join(' | '));

  it('quarantine: judges every line against every VM, reads only, and caps', async () => {
    const files = build('vcfops_reclaim_91', { mode: 'orphan-quarantine' });
    const diskList = [
      '# exported from the Reclaim page',
      '[ds1] app1/app1.vmdk',
      '[ds1] app1/app1_old.vmdk',
      '[ds1] old-vm/old-vm.vmdk',
      '[ds1] old-vm/old-vm-flat.vmdk',
      '[ds1] _orphan_quarantine/20260101-000000/x.vmdk',
      '[ds1] a/../app1/app1.vmdk',
      '[ds1] .snapshot/x.vmdk',
      '[ds1] fcd/abc.vmdk',
      '[other-name] db1/db1_1.vmdk',
      'not a line',
      '[ds3] gone/gone.vmdk',
    ].join('\n');
    const ran = await run(files, vcRoutes(VMS), settings({ maxObjects: 1 }), { diskList });
    expect(ran.result.error).toBe(null);
    expect(verdicts(ran)).toEqual([
      'ds1 | app1/app1.vmdk | skip: VM app1 refers to it',
      'ds1 | app1/app1_old.vmdk | skip: VM app1 keeps its disks in this folder; a parent disk of a snapshot is not in the REST disk list',
      'ds1 | old-vm/old-vm.vmdk | quarantine',
      'ds1 | old-vm/old-vm-flat.vmdk | skip: an extent, change-tracking, RDM or digest file — list the descriptor, never this',
      'ds1 | _orphan_quarantine/20260101-000000/x.vmdk | skip: already in quarantine',
      'ds1 | a/../app1/app1.vmdk | skip: not a canonical path (//, ./, .. or a leading /)',
      'ds1 | .snapshot/x.vmdk | skip: hidden system folder',
      'ds1 | fcd/abc.vmdk | skip: First Class Disk or content library folder',
      'other-name | db1/db1_1.vmdk | skip: VM db1 refers to it',
      '? | not a line | skip: not a [datastore] path.vmdk line',
      'ds3 | gone/gone.vmdk | skip: over the cap of 1; next run',
    ]);
    expect(ran.result.outputs.eligibleCount).toBe(1);
    expect(ran.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/session', 'DELETE /api/session', 'POST /hook']);
  });

  it('delete: only quarantined paths, only after the hold', async () => {
    const files = build('vcfops_reclaim_91', { mode: 'orphan-delete' });
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const diskList = ['[ds1] _orphan_quarantine/20200101-020000/old-vm_old-vm.vmdk', `[ds1] _orphan_quarantine/${today}-020000/new.vmdk`, '[ds1] old-vm/old-vm.vmdk', '[ds1] _orphan_quarantine/20200101-020000/../../app1/app1.vmdk'].join('\n');
    const ran = await run(files, vcRoutes(VMS), settings(), { diskList });
    expect(ran.result.error).toBe(null);
    expect(verdicts(ran)).toEqual([
      'ds1 | _orphan_quarantine/20200101-020000/old-vm_old-vm.vmdk | delete',
      `ds1 | _orphan_quarantine/${today}-020000/new.vmdk | skip: in quarantine for less than 14 days`,
      'ds1 | old-vm/old-vm.vmdk | skip: not exactly _orphan_quarantine/<YYYYmmdd-HHMMSS>/<name>.vmdk — only quarantined disks may be deleted',
      'ds1 | _orphan_quarantine/20200101-020000/../../app1/app1.vmdk | skip: not a canonical path (//, ./, .. or a leading /)',
    ]);
  });

  it('refuses to judge when a host is disconnected or a vCenter shows no VMs', async () => {
    const files = build('vcfops_reclaim_91', { mode: 'orphan-quarantine' });
    const down = await run(files, vcRoutes(VMS, 'DISCONNECTED'), settings(), { diskList: '[ds1] old-vm/old-vm.vmdk' });
    expect(down.result.error ?? '').toContain('is DISCONNECTED: its VMs cannot be seen');
    expect(down.calls[down.calls.length - 1]).toBe('DELETE /api/session');
    const empty = await run(files, vcRoutes([]), settings(), { diskList: '[ds1] old-vm/old-vm.vmdk' });
    expect(empty.result.error ?? '').toContain('returned no VMs');
  });
});

// ---------------------------------------------------------------------------

describe('pkg ops-cost-net: capacity report schedule', { skip: !CURL }, () => {
  const files = build('vcfops_capacity_policy');
  const routes = (existing: unknown[] = []): FakeRoute[] => [
    ...OPS_AUTH,
    { method: 'GET', path: '^/suite-api/api/policies/pol-1/settings$', body: { capacity: { buffer: 10 } } },
    { method: 'GET', path: '^/suite-api/api/reportdefinitions\\?', body: list('reportDefinitions', [{ id: 'rd-0', name: 'Other' }, { id: 'rd-1', name: 'Cluster capacity' }]) },
    { method: 'GET', path: '^/suite-api/api/resources\\?name=vSphere%20World&', body: list('resourceList', [{ identifier: 'res-1', resourceKey: { name: 'vSphere World' } }]) },
    { method: 'GET', path: '^/suite-api/api/reportdefinitions/rd-1/schedules$', body: { reportSchedules: existing } },
    { method: 'POST', path: '^/suite-api/api/reportdefinitions/rd-1/schedules$', body: { id: 'sch-1' } },
  ];
  const settings = (extra: Record<string, unknown> = {}) => (h: string) => ops(h, { policyId: 'pol-1', startDate: '2027-01-01', ...extra });

  it('refuses without a start date, before calling anything', async () => {
    const ran = await run(files, routes(), settings({ startDate: '' }));
    expect(ran.result.error ?? '').toContain('Set startDate');
    expect(ran.requests.length).toBe(0);
  });

  it('dry run: records the settings, finds the report and object, schedules nothing', async () => {
    const ran = await run(files, routes(), settings());
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(JSON.parse(String(ran.result.outputs.settingsBefore))).toEqual({ capacity: { buffer: 10 } });
    expect(ran.result.logs.some((l) => l.message.startsWith('DRY RUN: would schedule the report "Cluster capacity" monthly on day 1'))).toBe(true);
  });

  it('armed: one POST with the ReportSchedule body', async () => {
    const ran = await run(files, routes(), settings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual(['POST /suite-api/api/reportdefinitions/rd-1/schedules']);
    expect(JSON.parse(ran.requests.find((r) => r.method === 'POST' && r.path.endsWith('/schedules'))!.body)).toEqual({
      reportScheduleType: 'MONTHLY',
      recurrence: 1,
      dayOfTheMonth: 1,
      startHour: 7,
      startMinute: 0,
      relativePath: [],
      reportDefinitionId: 'rd-1',
      resourceId: ['res-1'],
      startDate: '2027-01-01',
      emailAddresses: ['capacity-team@example.com'],
    });
    expect(ran.result.outputs.reportScheduleId).toBe('sch-1');
  });

  it('leaves an existing monthly schedule alone', async () => {
    const ran = await run(files, routes([{ id: 'sch-0', reportScheduleType: 'MONTHLY', dayOfTheMonth: 1, resourceId: ['res-1'] }]), settings({ dryRun: false }));
    expect(ran.writes).toEqual([]);
    expect(ran.result.outputs.reportScheduleId).toBe('sch-0');
  });

  it('matches a schedule whose resourceId is a single id, and not one whose id only contains it (regression)', async () => {
    const single = await run(files, routes([{ id: 'sch-0', reportScheduleType: 'MONTHLY', dayOfTheMonth: 1, resourceId: 'res-1' }]), settings({ dryRun: false }));
    expect(single.writes).toEqual([]);
    expect(single.result.outputs.reportScheduleId).toBe('sch-0');
    const longer = await run(files, routes([{ id: 'sch-0', reportScheduleType: 'MONTHLY', dayOfTheMonth: 1, resourceId: 'res-10' }]), settings({ dryRun: false }));
    expect(longer.writes).toEqual(['POST /suite-api/api/reportdefinitions/rd-1/schedules']);
  });

  it('refuses a schedule list or a report list it does not recognise, rather than read it as empty (regression)', async () => {
    const oddSchedules = routes().map((r) => (r.path === '^/suite-api/api/reportdefinitions/rd-1/schedules$' && r.method === 'GET' ? { ...r, body: { schedules: [{ id: 'sch-0', reportScheduleType: 'MONTHLY', dayOfTheMonth: 1, resourceId: ['res-1'] }] } } : r));
    const a = await run(files, oddSchedules, settings({ dryRun: false }));
    expect(a.result.error ?? '').toContain('returned no reportSchedules list');
    expect(a.writes).toEqual([]);
    const oddDefinitions = routes().map((r) => (r.path === '^/suite-api/api/reportdefinitions\\?' ? { ...r, body: { definitions: [] } } : r));
    const b = await run(files, oddDefinitions, settings({ dryRun: false }));
    expect(b.result.error ?? '').toContain('GET reportdefinitions returned no reportDefinitions');
    expect(b.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('pkg ops-cost-net: VKS cost (reads only)', { skip: !CURL }, () => {
  const routes = (namespaces = true): FakeRoute[] => [
    ...OPS_AUTH,
    { method: 'GET', path: '^/suite-api/api/resources\\?adapterKind=VMWARE&resourceKind=Namespace', body: list('resourceList', namespaces ? [{ identifier: 'ns-1', resourceKey: { name: 'ns-a' } }, { identifier: 'ns-2', resourceKey: { name: 'ns-b' } }] : []) },
    { method: 'GET', path: '^/suite-api/api/adapterkinds/VMWARE/resourcekinds$', body: { 'resource-kind': [{ key: 'VirtualMachine' }, { key: 'SupervisorNamespace' }] } },
    { method: 'GET', path: '^/suite-api/api/resources/ns-1/statkeys$', body: { 'stat-key': [{ key: 'cost|totalCost' }, { key: 'price|total' }, { key: 'mem|usage' }] } },
    { method: 'POST', path: '^/suite-api/api/resources/stats/latest/query$', body: latest({ 'ns-1': { 'cost|totalCost': 120, 'price|total': 150 }, 'ns-2': { 'cost|totalCost': 0 } }) },
    { method: 'GET', path: '^/suite-api/api/resources/ns-1/properties$', body: { property: [{ name: 'summary|organization', value: 'Finance' }] } },
    { method: 'GET', path: '^/suite-api/api/resources/ns-2/properties$', body: { property: [] } },
  ];

  it('writes the CSV, reads only, and fails on an uncosted namespace', async () => {
    const ran = await run(build('vcfops_vks_cost'), routes(), (h) => ops(h));
    expect(ran.writes).toEqual([]);
    expect(ran.result.error ?? '').toContain('1 namespace(s) have no cost at all: ns-b');
    expect(String(ran.result.outputs.reportCsv).trim().split('\n')).toEqual(['"namespace","owner","cost|totalCost","price|total"', '"ns-a","",120,150', '"ns-b","",0,']);
  });

  it('rolls up by a property, and only warns when told not to fail', async () => {
    const ran = await run(build('vcfops_vks_cost', { group_by: 'property', fail_on_uncosted: false }), routes(), (h) => ops(h));
    expect(ran.result.error).toBe(null);
    expect(ran.result.outputs.uncostedCount).toBe(1);
    expect(String(ran.result.outputs.reportCsv).includes('"ns-a","Finance",120,150')).toBe(true);
    expect(ran.result.logs.some((l) => l.message === '  Finance\t120 (cost|totalCost)')).toBe(true);
  });

  it('lists candidate kinds when the namespace kind finds nothing', async () => {
    const ran = await run(build('vcfops_vks_cost'), routes(false), (h) => ops(h));
    expect(ran.result.error ?? '').toContain('Resource kinds that look like namespaces or VKS: SupervisorNamespace');
  });
});

// ---------------------------------------------------------------------------
// Networks

const NET_PASSWORD = 'Net-Pa55word-do-not-log';
const NET_TOKEN = 'net-token-do-not-log';
const NET_AUTH: FakeRoute[] = [
  { method: 'POST', path: '^/api/ni/auth/token$', body: { token: NET_TOKEN, expiry: 0 } },
  { method: 'DELETE', path: '^/api/ni/auth/token$', body: '' },
  { method: 'POST', path: '^/hook$', body: {} },
];
const net = (host: string, extra: Record<string, unknown> = {}) => ({ netHost: host, netUsername: 'reader', netPassword: NET_PASSWORD, webhook: `https://${host}/hook`, ...extra });

describe('pkg ops-cost-net: Networks flow check (reads only)', { skip: !CURL }, () => {
  const files = build('vcfnet_flow_check');
  const search = (body: unknown): FakeRoute[] => [...NET_AUTH, { method: 'POST', path: '^/api/ni/search/ql$', body }];

  it('reports the flows: logged, posted, and a failed run', async () => {
    const ran = await run(files, search({ entity_list_response: { results: [{ entity_id: 'f-1', entity_type: 'Flow' }, { entity_id: 'f-2', entity_type: 'Flow' }], total_count: 2 } }), (h) => net(h));
    expect(ran.result.error ?? '').toContain('2 flow(s) crossed the boundary');
    expect(ran.calls).toEqual(['POST /api/ni/auth/token', 'POST /api/ni/search/ql', 'DELETE /api/ni/auth/token', 'POST /hook']);
    expect(ran.writes).toEqual([]);
    expect(JSON.parse(ran.requests[0]!.body)).toEqual({ username: 'reader', password: NET_PASSWORD, domain: { domain_type: 'LOCAL', value: 'local' } });
    const query = JSON.parse(ran.requests[1]!.body) as { query: string; size: number };
    expect(query.size).toBe(100);
    expect(query.query).toBe("flows where source security group = 'PCI' and destination security group != 'PCI' and port != 443 and port != 53 in last 24 hours");
    expect(ran.requests[1]!.headers.authorization).toBe(`NetworkInsight ${NET_TOKEN}`);
    expect((JSON.parse(ran.requests[3]!.body) as { total: number; flows: string[] }).flows).toEqual(['f-1', 'f-2']);
    expect(ran.result.outputs.flowIds).toEqual(['f-1', 'f-2']);
  });

  it('a clean run posts nothing; a broken search is a failure, not a zero', async () => {
    const clean = await run(files, search({ entity_list_response: { results: [], total_count: 0 } }), (h) => net(h));
    expect(clean.result.error).toBe(null);
    expect(clean.calls.includes('POST /hook')).toBe(false);
    const broken = await run(files, search({ error: 'bad query' }), (h) => net(h));
    expect(broken.result.error ?? '').toContain('The search returned no entity list');
    expect(broken.calls.includes('POST /hook')).toBe(false);
    expect(broken.calls[broken.calls.length - 1]).toBe('DELETE /api/ni/auth/token');
  });
});

describe('pkg ops-cost-net: Networks change watch (reads only)', { skip: !CURL }, () => {
  const files = build('vcfnet_change_watch');
  const routes: FakeRoute[] = [
    ...NET_AUTH,
    {
      method: 'POST',
      path: '^/api/ni/search/ql$',
      responses: [
        { body: { entity_list_response: { results: [{ entity_id: 'r-1', entity_type: 'NSXFirewallRule' }], total_count: 2, cursor: 'next-page' } } },
        { body: { entity_list_response: { results: [{ entity_id: 'r-2', entity_type: 'NSXFirewallRule' }], total_count: 2 } } },
      ],
    },
    {
      method: 'POST',
      path: '^/api/ni/entities/fetch$',
      body: { results: [{ entity_id: 'r-1', entity_type: 'NSXFirewallRule', entity: { name: 'allow-web', action: 'ALLOW' } }, { entity_id: 'r-2', entity_type: 'NSXFirewallRule', entity: { name: 'deny-all', action: 'DROP' } }] },
    },
  ];

  it('first run: pages the search, fetches details, records the baseline, reports nothing', async () => {
    const ran = await run(files, routes, (h) => net(h));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(ran.calls).toEqual(['POST /api/ni/auth/token', 'POST /api/ni/search/ql', 'POST /api/ni/search/ql', 'POST /api/ni/entities/fetch', 'DELETE /api/ni/auth/token']);
    expect(JSON.parse(ran.requests[1]!.body)).toEqual({ query: 'firewall rules', size: 100 });
    expect(JSON.parse(ran.requests[2]!.body)).toEqual({ query: 'firewall rules', size: 100, cursor: 'next-page' });
    expect(JSON.parse(ran.requests[3]!.body)).toEqual({ entity_ids: [{ entity_id: 'r-1' }, { entity_id: 'r-2' }] });
    expect(Object.keys(JSON.parse(String(ran.result.outputs.snapshot)) as object).sort()).toEqual(['r-1', 'r-2']);
    expect(ran.result.outputs.changeCount).toBe(0);
    // The emulator's configuration elements cannot be written, as some Orchestrators': the run warns and goes on.
    expect(ran.result.logs.some((l) => l.level === 'warn' && l.message.startsWith('Could not keep the baseline'))).toBe(true);
  });

  it('later run: posts what was added, changed and removed', async () => {
    const baseline = JSON.stringify({
      'r-1': { type: 'NSXFirewallRule', name: 'allow-web', fp: JSON.stringify({ name: 'allow-web', action: 'DROP' }) },
      'r-2': { type: 'NSXFirewallRule', name: 'deny-all', fp: JSON.stringify({ name: 'deny-all', action: 'DROP' }) },
      'r-9': { type: 'NSXFirewallRule', name: 'old', fp: '{}' },
    });
    const ran = await run(files, routes, (h) => net(h, { baseline, keepBaseline: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.result.outputs.changeCount).toBe(2);
    const hook = JSON.parse(ran.requests.find((r) => r.path === '/hook')!.body) as { added: string[]; changed: string[]; removed: string[]; ignoreAccounts: string[] };
    expect(hook.changed).toEqual(['NSXFirewallRule allow-web']);
    expect(hook.removed).toEqual(['NSXFirewallRule old']);
    expect(hook.added).toEqual([]);
    expect(hook.ignoreAccounts).toEqual(['svc-terraform', 'svc-automation']);
  });
});

// ---------------------------------------------------------------------------
// Logs

const LOGS_PASSWORD = 'Logs-Pa55word-do-not-log';
const LOGS_SESSION = 'logs-session-do-not-log';

describe('pkg ops-cost-net: log alert, 9.1 log management and the 8.18/9.0 appliance', { skip: !CURL }, () => {
  const files = build('vcflog_alert_webhook');
  const routes91 = (existing: unknown = []): FakeRoute[] => [
    ...OPS_AUTH,
    { method: 'GET', path: '^/suite-api/api/logs/queryconfigs$', body: existing },
    { method: 'POST', path: '^/suite-api/api/logs/queryconfigs$', body: { id: 'qc-1', name: 'ESXi storage path failure' } },
  ];
  const routesAppliance = (postStatus = 200): FakeRoute[] => [
    { method: 'POST', path: '^/api/v2/sessions$', body: { userId: 'u', sessionId: LOGS_SESSION, ttl: 1800 } },
    { method: 'GET', path: '^/api/v1/alerts$', body: [{ id: 'al-0', name: 'Something else' }] },
    { method: 'POST', path: '^/api/v1/alerts$', status: postStatus, body: postStatus === 200 ? { id: 'al-1' } : { errorMessage: `no ${LOGS_PASSWORD}` } },
    { method: 'POST', path: '^/hook$', body: {} },
  ];
  const appliance = (extra: Record<string, unknown> = {}) => (h: string) => ({ logsTarget: 'standalone', logsHost: h, logsUsername: 'admin', logsPassword: LOGS_PASSWORD, webhook: `https://${h}/hook`, ...extra });

  it('9.1, dry run: reads the saved queries with the OpsToken, creates nothing', async () => {
    const ran = await run(files, routes91(), (h) => ops(h));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(ran.calls.filter((c) => c !== 'POST /hook')).toEqual(['POST /suite-api/api/auth/token/acquire', 'GET /suite-api/api/logs/queryconfigs', 'POST /suite-api/api/auth/token/release']);
    expect(ran.requests[1]!.headers.authorization).toBe(`OpsToken ${OPS_TOKEN}`);
  });

  it('9.1, armed: creates the saved query as LogsQueryConfig', async () => {
    const ran = await run(files, routes91(), (h) => ops(h, { dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual(['POST /suite-api/api/logs/queryconfigs']);
    const body = JSON.parse(ran.requests.find((r) => r.method === 'POST' && r.path === '/suite-api/api/logs/queryconfigs')!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['dateRange', 'description', 'name', 'queryFilters', 'queryText']);
    expect(body.queryText).toEqual(['Lost path redundancy']);
    expect(body.queryFilters).toEqual({ logQueryFiltersOperator: 'AND', partitions: [], logQueryFilterConditions: [{ conditionField: 'hostname', conditionValues: ['esx'], queryFilterConditionOperatorType: 'STARTS_WITH' }] });
    expect(ran.result.outputs.objectId).toBe('qc-1');
  });

  it('9.1: leaves a saved query of the same name alone, whatever the list is wrapped in', async () => {
    const ran = await run(files, routes91({ queryConfigs: [{ id: 'qc-9', name: 'ESXi storage path failure' }] }), (h) => ops(h, { dryRun: false }));
    expect(ran.writes).toEqual([]);
    expect(ran.result.outputs.objectId).toBe('qc-9');
  });

  it('appliance, armed: logs in with /api/v2/sessions and creates the alert disabled', async () => {
    const ran = await run(files, routesAppliance(), appliance({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.calls).toEqual(['POST /api/v2/sessions', 'GET /api/v1/alerts', 'POST /api/v1/alerts', 'POST /hook']);
    expect(JSON.parse(ran.requests[0]!.body)).toEqual({ username: 'admin', password: LOGS_PASSWORD, provider: 'Local' });
    expect(ran.requests[2]!.headers.authorization).toBe(`Bearer ${LOGS_SESSION}`);
    const alert = JSON.parse(ran.requests[2]!.body) as { name: string; enabled: boolean; alertType: string; hitCount: number; searchPeriod: number };
    expect([alert.name, alert.enabled, alert.alertType, alert.hitCount, alert.searchPeriod]).toEqual(['ESXi storage path failure', false, 'RATE_BASED', 5, 900000]);
    expect(ran.result.outputs.objectId).toBe('al-1');
  });

  it('refuses a saved-query or alert list it does not recognise, rather than read it as empty and create a duplicate (regression)', async () => {
    const ran = await run(files, routes91({ items: [{ id: 'qc-9', name: 'ESXi storage path failure' }] }), (h) => ops(h, { dryRun: false }));
    expect(ran.result.error ?? '').toContain('GET /suite-api/api/logs/queryconfigs returned no list this workflow recognises');
    expect(ran.writes).toEqual([]);
    const oddAlerts = routesAppliance().map((r) => (r.method === 'GET' && r.path === '^/api/v1/alerts$' ? { ...r, body: { data: [{ id: 'al-0', name: 'ESXi storage path failure' }] } } : r));
    const appl = await run(files, oddAlerts, appliance({ dryRun: false }));
    expect(appl.result.error ?? '').toContain('GET /api/v1/alerts returned no list this workflow recognises');
    expect(appl.writes).toEqual([]);
    // The documented wrapper is still read.
    const wrapped = routesAppliance().map((r) => (r.method === 'GET' && r.path === '^/api/v1/alerts$' ? { ...r, body: { alerts: [{ id: 'al-0', name: 'ESXi storage path failure' }] } } : r));
    const left = await run(files, wrapped, appliance({ dryRun: false }));
    expect(left.writes).toEqual([]);
    expect(left.result.outputs.objectId).toBe('al-0');
  });

  it('appliance: stops at the cap and at the first failure', async () => {
    const capped = await run(files, routesAppliance(), appliance({ dryRun: false, cap: 0 }));
    expect(capped.writes).toEqual([]);
    expect(capped.result.error ?? '').toContain('Cap reached: 0 change(s) made');
    const failed = await run(files, routesAppliance(500), appliance({ dryRun: false }));
    expect(failed.writes).toEqual(['POST /api/v1/alerts']);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): create alert "ESXi storage path failure" (disabled) failed');
  });
});

describe('pkg ops-cost-net: audit trail', { skip: !CURL }, () => {
  const files = build('vcflog_audit_trail');

  it('9.1, armed: one saved query, an OR of the accounts', async () => {
    const routes: FakeRoute[] = [...OPS_AUTH, { method: 'GET', path: '^/suite-api/api/logs/queryconfigs$', body: [] }, { method: 'POST', path: '^/suite-api/api/logs/queryconfigs$', body: { id: 'qc-2' } }];
    const dry = await run(files, routes, (h) => ops(h));
    expect(dry.writes).toEqual([]);
    const ran = await run(files, routes, (h) => ops(h, { dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual(['POST /suite-api/api/logs/queryconfigs']);
    const body = JSON.parse(ran.requests.find((r) => r.method === 'POST' && r.path.endsWith('/queryconfigs'))!.body) as { queryText: string[]; queryFilters: { logQueryFiltersOperator: string; logQueryFilterConditions: { conditionValues: string[] }[] } };
    expect(body.queryText).toEqual(['*']);
    expect(body.queryFilters.logQueryFiltersOperator).toBe('OR');
    expect(body.queryFilters.logQueryFilterConditions.map((c) => c.conditionValues[0])).toEqual(['svc-automation', 'svc-vcfops', 'svc-terraform']);
  });

  it('9.1: refuses a saved-query list it does not recognise (regression)', async () => {
    const routes: FakeRoute[] = [...OPS_AUTH, { method: 'GET', path: '^/suite-api/api/logs/queryconfigs$', body: { results: [] } }, { method: 'POST', path: '^/suite-api/api/logs/queryconfigs$', body: { id: 'qc-2' } }];
    const ran = await run(files, routes, (h) => ops(h, { dryRun: false }));
    expect(ran.result.error ?? '').toContain('returned no list this workflow recognises');
    expect(ran.writes).toEqual([]);
  });

  it('appliance: reads the last day per account and fails on a silent one', async () => {
    const routes: FakeRoute[] = [
      { method: 'POST', path: '^/api/v2/sessions$', body: { sessionId: LOGS_SESSION } },
      { method: 'GET', path: '^/api/v1/events/text/CONTAINS%20svc-automation/timestamp/%3E\\d+\\?limit=1$', body: { complete: true, events: [{ text: 'svc-automation did x' }] } },
      { method: 'GET', path: '^/api/v1/events/text/CONTAINS%20svc-vcfops/', body: { complete: true, events: [{ text: 'svc-vcfops did y' }] } },
      { method: 'GET', path: '^/api/v1/events/', body: { complete: true, events: [] } },
      { method: 'POST', path: '^/hook$', body: {} },
    ];
    const ran = await run(files, routes, (h) => ({ logsTarget: 'standalone', logsHost: h, logsUsername: 'admin', logsPassword: LOGS_PASSWORD, webhook: `https://${h}/hook` }));
    expect(ran.result.error ?? '').toContain('1 account(s) wrote nothing in the last 24 hours: svc-terraform');
    expect(ran.writes).toEqual([]);
    expect(ran.requests.filter((r) => r.method === 'GET').length).toBe(3);
    expect(ran.result.outputs.silentAccounts).toEqual(['svc-terraform']);
  });
});
