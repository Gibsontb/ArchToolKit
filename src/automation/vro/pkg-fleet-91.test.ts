/**
 * The VCF 9.1 fleet blueprints (vcf-fleet-91.ts) as Orchestrator packages.
 *
 * For every automation: the package builds and parses, every script is ES5,
 * every secret is a SecureString with no value, IMPORT.md names the package;
 * and the workflow runs in the emulator against fake VCF Operations, identity
 * broker, fleet lifecycle, SDDC Manager and vCenter endpoints — the read-only
 * ones only read and report the right thing; the changing ones write nothing
 * in a dry run, make exactly the expected calls in order with the right
 * bodies when armed, leave alone what already matches, stop at the cap and at
 * the first failure, and never log a secret.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { buildVroPackage, readPackageSpec, type VroPackageSpec } from '../../kit/vro-package.ts';
import { automationFor } from '../blueprints/index.ts';
import { VCF_FLEET_91 } from '../blueprints/vcf-fleet-91.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../../testing/fake-rest-server.ts';

const has = (tool: string): boolean => {
  try {
    execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
};
const CURL = has('curl');

// Every secret the fakes are given ends in do-not-log: none may reach a log line, an output or an error.
const API_TOKEN = 'fleet-api-token-do-not-log';
const ACCESS = 'idb-access-do-not-log';
const OPS_PASSWORD = 'Ops-Pa55-do-not-log';
const OPS_TOKEN = 'ops-token-do-not-log';

interface Built {
  readonly files: Record<string, string>;
  readonly spec: VroPackageSpec;
  readonly dir: string;
  readonly workflow: string;
  readonly configKey: string;
}

function build(id: string, overrides: BlueprintValues = {}): Built {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`no blueprint ${id}`);
  const files = { ...blueprint.build({ ...defaultValues(blueprint), ...overrides }, id).files };
  const packages = packagesIn(files);
  const dir = Object.keys(packages).find((d) => d !== 'com.archtoolkit.core.package')!;
  const spec = readPackageSpec(packages[dir]!);
  return { files, spec, dir, workflow: spec.workflows[0]!.name, configKey: `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}` };
}

function logText(run: WorkflowRun): string {
  return run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');
}

// Webhook URLs are SecureStrings too (a webhook's path can be its secret); vro.test.ts checks them for every automation.
const URL_SECRET = /^(webhook|backupWebhook|auditUrl|endpoint)$/;
/** The package is well formed: parses, ES5, secrets empty SecureStrings, named in IMPORT.md, fallback kept. */
function wellFormed(b: Built, secrets: readonly string[], scripts: readonly string[]): void {
  expect(b.spec.name.startsWith('com.archtoolkit.fleet91.')).toBe(true);
  expect(b.spec.workflows.length).toBe(1);
  const problems: string[] = [];
  for (const [dir, pkg] of Object.entries(packagesIn(b.files))) {
    const spec = readPackageSpec(pkg);
    for (const a of spec.actions) problems.push(...es5Problems(a.script, `${dir}/${a.name}`));
    for (const w of spec.workflows) {
      const script = [...w.xml.matchAll(/<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/g)].map((m) => [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join(''));
      expect(script.length).toBe(1);
      problems.push(...es5Problems(script[0]!, `${dir}/${w.name}`));
    }
  }
  expect(problems).toEqual([]);
  const attributes = b.spec.configs[0]!.attributes;
  for (const name of secrets) {
    const a = attributes.find((x) => x.name === name);
    expect(a?.type).toBe('SecureString');
    expect(a?.value).toBe(undefined);
  }
  expect(attributes.filter((a) => a.type === 'SecureString' && !URL_SECRET.test(a.name)).map((a) => a.name).sort()).toEqual([...secrets].sort());
  for (const r of b.spec.resources) if (r.name.endsWith('.json')) JSON.parse(r.content);
  const guide = b.files['IMPORT.md']!;
  expect(guide.includes(`import/${b.dir}`)).toBe(true);
  expect(guide.includes('import/com.archtoolkit.core.package')).toBe(true);
  for (const script of scripts) expect(typeof b.files[`scripts/${script}`]).toBe('string');
}

const servers: FakeServer[] = [];
after(() => servers.forEach((s) => s.stop()));

interface Ran {
  readonly result: WorkflowRun;
  readonly requests: FakeRequest[];
  /** Every call that is not a read, a query, a login or a webhook: "METHOD /path" without the query. */
  readonly writes: string[];
  /** Every call, "METHOD /path" without the query. */
  readonly calls: string[];
}

const READ_LIKE = /\/query$|^\/acs\/t\/CUSTOMER\/token$|^\/suite-api\/api\/auth\/token\/(acquire|release|exchange)$|^\/v1\/tokens$|^\/api\/session$|^\/hook$/;

async function runIn(b: Built, routes: readonly FakeRoute[], settings: (host: string) => Record<string, unknown>, inputs: Record<string, unknown> = {}): Promise<Ran> {
  const server = await startFakeServer([...routes, { method: 'POST', path: '^/hook$', body: {} }]);
  servers.push(server);
  const host = `127.0.0.1:${server.port}`;
  const emulator = new VroEmulator(b.files, { config: { [b.configKey]: settings(host) } });
  const result = emulator.runWorkflow(b.workflow, inputs);
  const requests = server.requests();
  expect(/do-not-log/.test(logText(result))).toBe(false);
  const calls = requests.map((r) => `${r.method} ${r.path.split('?')[0]}`);
  return { result, requests, calls, writes: requests.filter((r) => r.method !== 'GET' && !READ_LIKE.test(r.path.split('?')[0]!)).map((r) => `${r.method} ${r.path.split('?')[0]}`) };
}

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const at = (method: string, path: string, body: unknown, status?: number): FakeRoute => ({ method, path: `^${esc(path)}(\\?.*)?$`, body, ...(status ? { status } : {}) });
const seq = (method: string, path: string, responses: readonly { status?: number; body?: unknown }[]): FakeRoute => ({ method, path: `^${esc(path)}(\\?.*)?$`, responses });
const page = (key: string, items: readonly unknown[]) => ({ [key]: items, pageInfo: { totalCount: items.length, page: 0, pageSize: 1000 } });
const bodyOf = (ran: Ran, method: string, path: string, index = 0): Record<string, unknown> => JSON.parse(ran.requests.filter((r) => r.method === method && r.path.split('?')[0] === path)[index]!.body) as Record<string, unknown>;

/** The identity broker login every fleet-management workflow opens with. */
const IDB: FakeRoute = { method: 'POST', path: '^/acs/t/CUSTOMER/token$', body: { access_token: ACCESS, token_type: 'Bearer', expires_in: 1800 } };
const fleetSettings = (extra: Record<string, unknown> = {}) => (host: string) => ({ opsHost: host, idbHost: host, apiToken: API_TOKEN, webhook: `https://${host}/hook`, ...extra });
const FM = '/suite-api/api/fleet-management';

/** Every fleet call after the login carries the Bearer token, and the API token went only to the identity broker. */
function bearerOnly(ran: Ran): void {
  for (const r of ran.requests) {
    if (r.path === '/acs/t/CUSTOMER/token') expect(r.body).toBe(`grant_type=${encodeURIComponent('urn:custom:vcf:params:oauth:grant-type:api-token')}&api_token=${API_TOKEN}`);
    else if (r.path.startsWith(FM) || r.path.startsWith('/suite-api/api/workflows/')) expect(r.headers.authorization).toBe(`Bearer ${ACCESS}`);
    if (r.path !== '/acs/t/CUSTOMER/token') expect(r.body.includes(API_TOKEN)).toBe(false);
  }
}

// ---------------------------------------------------------------------------

describe('fleet-91: every option of every blueprint builds a package Orchestrator takes', () => {
  it('ES5 scripts, parseable resources, empty SecureStrings, IMPORT.md naming it, and a signed .package', async () => {
    let built = 0;
    for (const blueprint of VCF_FLEET_91) {
      const base = defaultValues(blueprint);
      const variants: BlueprintValues[] = [{ ...base }];
      for (const input of blueprint.inputs) {
        if (input.control === 'select') for (const option of input.options ?? []) variants.push({ ...base, [input.id]: option.value });
        if (input.control === 'toggle') variants.push({ ...base, [input.id]: !base[input.id] });
      }
      for (const values of variants) {
        const files = { ...blueprint.build(values, blueprint.id).files };
        const packages = packagesIn(files);
        const dirs = Object.keys(packages).filter((d) => d !== 'com.archtoolkit.core.package');
        expect(dirs.length).toBe(1);
        const spec = readPackageSpec(packages[dirs[0]!]!);
        const where = `${blueprint.id} ${JSON.stringify(values).slice(0, 60)}`;
        expect([where, spec.workflows.length]).toEqual([where, 1]);
        const problems = [...spec.actions.flatMap((a) => es5Problems(a.script, `${where} ${a.name}`))];
        const script = [...spec.workflows[0]!.xml.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]).join('');
        expect(script.includes('var core = System.getModule("com.archtoolkit.core");')).toBe(true);
        expect(problems).toEqual([]);
        for (const r of spec.resources) if (r.name.endsWith('.json')) JSON.parse(r.content);
        for (const a of spec.configs[0]!.attributes) if (a.type === 'SecureString') expect([where, a.name, a.value]).toEqual([where, a.name, undefined]);
        expect(files['IMPORT.md']!.includes(`import/${dirs[0]}`)).toBe(true);
        // Every shell script is under scripts/, beside the payloads it reads.
        expect(Object.keys(files).filter((f) => f.endsWith('.sh') && !f.startsWith('scripts/'))).toEqual([]);
        const bytes = await buildVroPackage(spec);
        expect(bytes.length).toBeGreaterThan(1000);
        built++;
      }
    }
    expect(built).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// fleet91_password_policy

describe('fleet91_password_policy as an Orchestrator package', { skip: !CURL }, () => {
  const apply = build('fleet91_password_policy');
  const GROUPS = [
    { componentGroup: 'INSTANCE', componentGroupResourceFqdn: 'sddc-manager-01.example.com', componentGroupResourceId: 'cg-1', policyName: 'Old', componentGroupComplianceStatus: 'COMPLIANT' },
    { componentGroup: 'INSTANCE', componentGroupResourceFqdn: 'sddc-manager-02.example.com', componentGroupResourceId: 'cg-2', policyName: 'Old', componentGroupComplianceStatus: 'NON_COMPLIANT' },
    { componentGroup: 'MANAGEMENT', componentGroupResourceName: 'management', componentGroupResourceId: 'cg-m', policyName: 'Old' },
  ];
  const policyRoutes = (o: { policies?: unknown[]; running?: boolean; taskStatus?: string } = {}): FakeRoute[] => [
    IDB,
    at('POST', `${FM}/password-policies/component-groups/tasks/query`, page('results', o.running ? [{ taskId: 't0', taskStatus: 'IN_PROGRESS' }] : [])),
    at('POST', `${FM}/password-policies/query`, page('policies', o.policies ?? [])),
    at('POST', `${FM}/password-policies/component-groups/query`, page('results', GROUPS)),
    at('POST', `${FM}/password-management/accounts/query`, page('vcfPasswordAccounts', [{ passwordAccountKey: 'k1', appliance: 'ESX', applianceFqdn: 'esx01', userName: 'root', status: 'ACTIVE', lastPasswordUpdateTimestamp: 1767225600000 }])),
    at('POST', `${FM}/password-policies/export`, { policies: [{ id: 'p-old', name: 'Old' }] }),
    at('POST', `${FM}/password-policies`, { id: 'p-new' }),
    at('PUT', `${FM}/password-policies`, { id: 'p-1' }),
    at('POST', `${FM}/password-policies/component-groups/tasks`, { taskId: 'task-1' }),
    seq('GET', `${FM}/password-policies/component-groups/tasks/task-1`, [{ body: { taskStatus: 'IN_PROGRESS' } }, { body: { taskStatus: o.taskStatus ?? 'COMPLETED' } }]),
  ];
  const policy = JSON.parse(apply.spec.resources.find((r) => r.name === 'policy.json')!.content) as Record<string, unknown>;

  it('is one package with the fleet login, the policy body and the fallback scripts', () => {
    wellFormed(apply, ['apiToken'], ['password-policy.sh', 'password-policy-report.sh', 'policy.json']);
    expect(apply.spec.configs[0]!.attributes.find((a) => a.name === 'dryRun')?.value).toBe(true);
    expect(apply.files['scripts/policy.json']).toBe(apply.spec.resources.find((r) => r.name === 'policy.json')!.content);
  });

  it('dry run: reads, plans the create and the apply, writes nothing', async () => {
    const ran = await runIn(apply, policyRoutes(), fleetSettings());
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(ran.result.logs.filter((l) => l.message.startsWith('DRY RUN: would')).map((l) => l.message)).toEqual(['DRY RUN: would create password policy "Fleet standard"', 'DRY RUN: would apply password policy "Fleet standard" to the fleet']);
    bearerOnly(ran);
  });

  it('armed: exports, creates, applies to the fleet and follows the task', async () => {
    const ran = await runIn(apply, policyRoutes(), fleetSettings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.calls).toEqual([
      'POST /acs/t/CUSTOMER/token',
      `POST ${FM}/password-policies/component-groups/tasks/query`,
      `POST ${FM}/password-policies/query`,
      `POST ${FM}/password-policies/component-groups/query`,
      `POST ${FM}/password-policies/export`,
      `POST ${FM}/password-policies`,
      `POST ${FM}/password-policies/component-groups/tasks`,
      `GET ${FM}/password-policies/component-groups/tasks/task-1`,
      `GET ${FM}/password-policies/component-groups/tasks/task-1`,
      'POST /hook',
    ].filter((c) => c !== 'POST /hook'));
    expect(bodyOf(ran, 'POST', `${FM}/password-policies`)).toEqual(policy);
    expect(bodyOf(ran, 'POST', `${FM}/password-policies/query`)).toEqual({ policyNames: ['Fleet standard'] });
    expect(bodyOf(ran, 'POST', `${FM}/password-policies/component-groups/tasks`)).toEqual({ taskType: 'POLICY_APPLY', policyId: 'p-new', targetComponentGroups: { componentGroups: ['FLEET'], componentGroupResourceIds: [] } });
    expect(ran.result.outputs.policyId).toBe('p-new');
    expect(ran.result.outputs.taskId).toBe('task-1');
    expect(String(ran.result.outputs.policiesBefore)).toContain('p-old');
    bearerOnly(ran);
  });

  it('leaves a matching policy that is already the fleet policy alone', async () => {
    const ran = await runIn(apply, policyRoutes({ policies: [{ ...policy, id: 'p-1', fleet: true }] }), fleetSettings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(ran.result.outputs.policyId).toBe('p-1');
  });

  it('updates a policy whose settings differ, with its id, then applies it', async () => {
    const old = { ...policy, id: 'p-1', fleet: true, complexityConstraints: { ...(policy.complexityConstraints as object), minLength: 8 } };
    const ran = await runIn(apply, policyRoutes({ policies: [old, { id: 'p-x', name: 'Fleet standard (copy)' }] }), fleetSettings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([`POST ${FM}/password-policies/export`, `PUT ${FM}/password-policies`, `POST ${FM}/password-policies/component-groups/tasks`]);
    expect(bodyOf(ran, 'PUT', `${FM}/password-policies`)).toEqual({ ...policy, id: 'p-1' });
  });

  it('refuses while a policy task is running, before any change', async () => {
    const ran = await runIn(apply, policyRoutes({ running: true }), fleetSettings({ dryRun: false }));
    expect(ran.result.error ?? '').toContain('Refusing: 1 password policy task(s) still in progress');
    expect(ran.writes).toEqual([]);
    expect(ran.calls[ran.calls.length - 1]).toBe('POST /hook');
  });

  it('stops at the cap, and at a task that does not complete', async () => {
    const capped = await runIn(apply, policyRoutes(), fleetSettings({ dryRun: false, cap: 1 }));
    expect(capped.writes).toEqual([`POST ${FM}/password-policies/export`, `POST ${FM}/password-policies`]);
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: apply password policy');
    const failed = await runIn(apply, policyRoutes({ taskStatus: 'FAILED' }), fleetSettings({ dryRun: false }));
    expect(failed.result.error ?? '').toContain('Stopped after 1 change(s): apply password policy "Fleet standard" to the fleet failed: Policy task task-1 ended FAILED');
  });

  it('instances: applies only to the named component groups, and refuses a name that does not match', async () => {
    const b = build('fleet91_password_policy', { target: 'INSTANCE', instances: 'sddc-manager-01.example.com, SDDC-MANAGER-02.example.com' });
    const ran = await runIn(b, policyRoutes(), fleetSettings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(bodyOf(ran, 'POST', `${FM}/password-policies/component-groups/query`)).toEqual({ componentGroupResourceFqdns: ['sddc-manager-01.example.com', 'SDDC-MANAGER-02.example.com'] });
    expect((bodyOf(ran, 'POST', `${FM}/password-policies/component-groups/tasks`).targetComponentGroups as object)).toEqual({ componentGroups: ['INSTANCE'], componentGroupResourceIds: ['cg-1', 'cg-2'] });
    const typo = build('fleet91_password_policy', { target: 'INSTANCE', instances: 'sddc-manager-01.example.com, sddc-manager-09.example.com' });
    const refused = await runIn(typo, policyRoutes(), fleetSettings({ dryRun: false }));
    expect(refused.result.error ?? '').toContain('2 instance FQDN(s) given, 1 component group(s) matched');
    expect(refused.writes).toEqual([]);
  });

  it('detach: removes the policy only from the instances that carry it', async () => {
    const b = build('fleet91_password_policy', { mode: 'detach', policy_name: 'Old', instances: 'sddc-manager-01.example.com' });
    wellFormed(b, ['apiToken'], ['password-policy.sh']);
    const ran = await runIn(b, policyRoutes({ policies: [{ id: 'p-old', name: 'Old' }] }), fleetSettings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([`POST ${FM}/password-policies/export`, `POST ${FM}/password-policies/component-groups/tasks`]);
    expect(bodyOf(ran, 'POST', `${FM}/password-policies/component-groups/tasks`)).toEqual({ taskType: 'POLICY_DETACH', policyId: 'p-old', targetComponentGroups: { componentGroups: ['INSTANCE'], componentGroupResourceIds: ['cg-1'] } });
  });

  it('report: only queries, and reports every group that is not COMPLIANT', async () => {
    const b = build('fleet91_password_policy', { mode: 'report' });
    wellFormed(b, ['apiToken'], ['password-policy-report.sh']);
    expect(b.spec.configs[0]!.attributes.some((a) => a.name === 'dryRun')).toBe(false);
    const ran = await runIn(b, policyRoutes({ policies: [{ id: 'p-1', name: 'Fleet standard', fleet: true, complexityConstraints: { minLength: 15 } }] }), fleetSettings());
    expect(ran.result.error).toBe(null);
    expect(ran.requests.every((r) => r.path.split('?')[0]!.endsWith('/query') || r.path === '/acs/t/CUSTOMER/token' || r.path === '/hook')).toBe(true);
    expect(ran.result.outputs.problemCount).toBe(2);
    expect(ran.result.logs.filter((l) => l.message.startsWith('PROBLEM: ')).map((l) => l.message)).toEqual(['PROBLEM: sddc-manager-02.example.com: NON_COMPLIANT', 'PROBLEM: management: no compliance status']);
    expect(String(ran.result.outputs.reportText)).toContain('account\tESX\tesx01\troot\tACTIVE\tchanged 2026-01-01');
    expect(ran.calls[ran.calls.length - 1]).toBe('POST /hook');
  });
});

// ---------------------------------------------------------------------------
// fleet91_password_rotate

describe('fleet91_password_rotate as an Orchestrator package', { skip: !CURL }, () => {
  const b = build('fleet91_password_rotate');
  const ESX = [
    { passwordAccountKey: 'key-1', appliance: 'ESX', applianceFqdn: 'esx01.example.com', userName: 'root', status: 'ACTIVE', credentialType: 'SSH' },
    { passwordAccountKey: 'key-2', appliance: 'ESX', applianceFqdn: 'ESX02.example.com', userName: 'root', status: 'ACTIVE', credentialType: 'SSH' },
    { passwordAccountKey: 'key-3', appliance: 'ESX', applianceFqdn: 'esx03.example.com', userName: 'root', status: 'ACTIVE', credentialType: 'SSH' },
    { passwordAccountKey: 'key-4', appliance: 'ESX', applianceFqdn: 'esx01.example.com', userName: 'svc', status: 'ACTIVE', credentialType: 'SSH' },
  ];
  const SECRETS = JSON.stringify([
    { fqdn: 'esx01.example.com', user: 'root', current: 'Old-1-do-not-log', next: 'New-1-do-not-log' },
    { fqdn: 'esx02.example.com', user: 'root', current: 'Old-2-do-not-log', next: 'New-2-do-not-log' },
  ]);
  const routes = (o: { second?: { status?: number; body?: unknown }; state?: string } = {}): FakeRoute[] => [
    IDB,
    at('POST', `${FM}/password-management/accounts/query`, page('vcfPasswordAccounts', ESX)),
    at('PUT', `${FM}/password-management/accounts/key-1/password`, { requestId: 'req-1', state: 'INPROGRESS' }),
    { method: 'PUT', path: `^${esc(`${FM}/password-management/accounts/key-2/password`)}$`, status: o.second?.status ?? 200, body: o.second?.body ?? { requestId: 'req-2', state: 'INPROGRESS' } },
    seq('GET', '/suite-api/api/workflows/requests/req-1', [{ body: { requestId: 'req-1', state: 'INPROGRESS' } }, { body: { requestId: 'req-1', state: 'COMPLETED' } }]),
    at('GET', '/suite-api/api/workflows/requests/req-2', { requestId: 'req-2', state: o.state ?? 'COMPLETED', errorCause: [{ message: 'SSH refused' }] }),
  ];
  const settings = (extra: Record<string, unknown> = {}) => fleetSettings({ rotationSecrets: SECRETS, ...extra });

  it('is one package; both the API token and the passwords are SecureStrings', () => {
    wellFormed(b, ['apiToken', 'rotationSecrets'], ['rotate-passwords.sh']);
    expect(b.files['IMPORT.md']!).toContain('does not generate passwords');
  });

  it('dry run: selects by type, FQDN and user, plans the changes, writes nothing', async () => {
    const ran = await runIn(b, routes(), settings());
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(bodyOf(ran, 'POST', `${FM}/password-management/accounts/query`)).toEqual({ appliance: 'ESX', credentialType: 'SSH' });
    expect(ran.result.logs.filter((l) => l.message.startsWith('DRY RUN: would')).map((l) => l.message)).toEqual(['DRY RUN: would change the password of root@esx01.example.com', 'DRY RUN: would change the password of root@ESX02.example.com']);
  });

  it('armed: one account at a time, each request followed to COMPLETED, passwords only in the bodies', async () => {
    const ran = await runIn(b, routes(), settings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.calls).toEqual([
      'POST /acs/t/CUSTOMER/token',
      `POST ${FM}/password-management/accounts/query`,
      `PUT ${FM}/password-management/accounts/key-1/password`,
      'GET /suite-api/api/workflows/requests/req-1',
      'GET /suite-api/api/workflows/requests/req-1',
      `PUT ${FM}/password-management/accounts/key-2/password`,
      'GET /suite-api/api/workflows/requests/req-2',
    ]);
    expect(bodyOf(ran, 'PUT', `${FM}/password-management/accounts/key-1/password`)).toEqual({ currentPassword: 'Old-1-do-not-log', newPassword: 'New-1-do-not-log' });
    expect(ran.result.outputs.changedAccounts).toBe('root@esx01.example.com\nroot@ESX02.example.com');
    bearerOnly(ran);
  });

  it('refuses above maxAccounts, and when nothing matches', async () => {
    const wide = build('fleet91_password_rotate', { fqdns: '', usernames: '', max_accounts: 3 });
    const ran = await runIn(wide, routes(), settings({ dryRun: false }));
    expect(ran.result.error ?? '').toContain('Refusing: 4 accounts is above maxAccounts (3)');
    expect(ran.writes).toEqual([]);
    const none = build('fleet91_password_rotate', { fqdns: 'esx99.example.com' });
    expect((await runIn(none, routes(), settings({ dryRun: false }))).result.error ?? '').toContain('Nothing matched the filter');
  });

  it('skips an account without passwords and reports it', async () => {
    const three = build('fleet91_password_rotate', { fqdns: 'esx01.example.com, esx03.example.com' });
    const ran = await runIn(three, routes(), settings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([`PUT ${FM}/password-management/accounts/key-1/password`]);
    expect(ran.result.logs.some((l) => l.message === 'PROBLEM: root@esx03.example.com: no current and next password in rotationSecrets, not changed')).toBe(true);
    expect(ran.calls[ran.calls.length - 1]).toBe('POST /hook');
  });

  it('stops at the cap and at the first request that fails, and says what may be in effect', async () => {
    const capped = await runIn(b, routes(), settings({ dryRun: false, cap: 1 }));
    expect(capped.writes).toEqual([`PUT ${FM}/password-management/accounts/key-1/password`]);
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made');
    const failed = await runIn(b, routes({ state: 'FAILED' }), settings({ dryRun: false }));
    expect(failed.result.error ?? '').toContain('Stopped after 1 change(s): change the password of root@ESX02.example.com failed: Request req-2 FAILED: [{"message":"SSH refused"}]');
    expect(failed.result.error ?? '').toContain('try it first, then the old one');
    const gateway = await runIn(b, routes({ second: { status: 504, body: { message: 'gateway timeout for New-2-do-not-log' } } }), settings({ dryRun: false }));
    expect(gateway.result.error ?? '').toContain('returned HTTP 504');
    expect(gateway.result.error ?? '').toContain('OUTCOME UNKNOWN');
    const refused = await runIn(b, routes({ second: { status: 400, body: { message: 'history' } } }), settings({ dryRun: false }));
    expect(refused.result.error ?? '').toContain('refused; the password was not changed');
  });

  it('refuses rotationSecrets that are not JSON without echoing them', async () => {
    const ran = await runIn(b, routes(), settings({ rotationSecrets: 'esx01 root Old-do-not-log' }));
    expect(ran.result.error ?? '').toContain('rotationSecrets in Settings is not a JSON array');
  });
});

// ---------------------------------------------------------------------------
// fleet91_certificates

describe('fleet91_certificates as an Orchestrator package', { skip: !CURL }, () => {
  const CERTS = [
    { certificateResourceKey: 'ck-vc', appliance: 'VCENTER', applianceFqdn: 'VCENTER-MGMT.example.com', issuedTo: 'vcenter-mgmt', issuedBy: 'CA', status: 'EXPIRING_30', daysToExpire: 20, subjectAlternativeNames: { dns: ['vcenter-mgmt.example.com'], ip: [] } },
    { certificateResourceKey: 'ck-nsx', appliance: 'NSXT_MANAGER', applianceFqdn: 'nsx.example.com', issuedBy: 'CA', status: 'NORMAL', daysToExpire: 300 },
    { certificateResourceKey: 'ck-old', appliance: 'ESX', applianceFqdn: 'esx01.example.com', issuedBy: 'VMCA', status: 'EXPIRED', daysToExpire: 0 },
    { certificateResourceKey: 'ck-vc2', appliance: 'VCENTER', applianceFqdn: 'vcenter-wld.example.com', issuedBy: 'CA', status: 'NORMAL', daysToExpire: 90 },
  ];
  const CHAIN = '-----BEGIN CERTIFICATE-----\nMIIleaf\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIroot\n-----END CERTIFICATE-----\n';
  const routes = (o: { state?: string; certs?: unknown[]; ca?: unknown } = {}): FakeRoute[] => [
    IDB,
    at('POST', `${FM}/certificate-management/certificates/query`, page('vcfCertificateModels', o.certs ?? CERTS)),
    at('POST', `${FM}/certificate-management/csrs`, { requestId: 'req-csr', state: 'INPROGRESS' }),
    at('GET', `${FM}/certificate-management/csrs`, { certificateSignatureInfo: [{ id: 'c1', commonName: 'vcenter-mgmt.example.com', csr: '-----BEGIN CERTIFICATE REQUEST-----\nMIIcsr\n-----END CERTIFICATE REQUEST-----' }], pageInfo: { totalCount: 1 } }),
    at('PUT', `${FM}/certificate-management/certificates/ck-vc`, { requestId: 'req-put', state: 'INPROGRESS' }),
    at('GET', `${FM}/certificate-management/certificate-authorities`, o.ca ?? {}),
    at('PUT', `${FM}/certificate-management/certificate-authorities`, {}),
    at('GET', '/suite-api/api/workflows/requests/req-csr', { state: 'COMPLETED' }),
    at('GET', '/suite-api/api/workflows/requests/req-put', { state: o.state ?? 'COMPLETED', errorCause: [{ message: 'service restart failed' }] }),
  ];

  it('report: one query of every TLS certificate, and every one inside the window, expired or unreadable', async () => {
    const b = build('fleet91_certificates');
    wellFormed(b, ['apiToken'], ['certificate-report.sh']);
    const ran = await runIn(b, [...routes({ certs: [...CERTS, { certificateResourceKey: 'ck-x', appliance: 'SDDC_MANAGER', applianceFqdn: 'sddc', status: 'NORMAL' }] })], fleetSettings());
    expect(ran.result.error).toBe(null);
    expect(ran.calls).toEqual(['POST /acs/t/CUSTOMER/token', `POST ${FM}/certificate-management/certificates/query`, 'POST /hook']);
    expect(bodyOf(ran, 'POST', `${FM}/certificate-management/certificates/query`)).toEqual({ category: 'TLS_CERT' });
    expect(ran.result.outputs.expiringCount).toBe(3);
    expect(String(ran.result.outputs.reportCsv).split('\n').slice(1, 4).map((l) => l.split(',')[5])).toEqual(['"ck-x"', '"ck-old"', '"ck-vc"']);
    const quiet = await runIn(b, routes({ certs: [CERTS[1]] }), fleetSettings());
    expect(quiet.result.outputs.expiringCount).toBe(0);
    expect(quiet.calls.includes('POST /hook')).toBe(false);
  });

  it('external CA, csr step: dry run writes nothing; armed generates the CSR with the certificate\'s names and returns the PEM', async () => {
    const b = build('fleet91_certificates', { action: 'external', fqdn: 'vcenter-mgmt.example.com' });
    wellFormed(b, ['apiToken'], ['certificate-report.sh', 'replace-certificate.sh', 'csr-spec.json']);
    const dry = await runIn(b, routes(), fleetSettings(), { step: 'csr' });
    expect(dry.result.error).toBe(null);
    expect(dry.writes).toEqual([]);
    const ran = await runIn(b, routes(), fleetSettings({ dryRun: false }), { step: 'csr' });
    expect(ran.result.error).toBe(null);
    expect(ran.calls).toEqual([
      'POST /acs/t/CUSTOMER/token',
      `POST ${FM}/certificate-management/certificates/query`,
      `POST ${FM}/certificate-management/csrs`,
      'GET /suite-api/api/workflows/requests/req-csr',
      `GET ${FM}/certificate-management/csrs`,
    ]);
    const body = bodyOf(ran, 'POST', `${FM}/certificate-management/csrs`) as { certificateId: string; generateCsrSpec: Record<string, unknown> };
    expect(body.certificateId).toBe('ck-vc');
    expect(body.generateCsrSpec.subjectAltNames).toEqual({ dns: ['vcenter-mgmt.example.com'], ip: [] });
    expect(body.generateCsrSpec.keySize).toBe('KEY_2048');
    expect(body.generateCsrSpec.commonName).toBe('vcenter-mgmt.example.com');
    expect(String(ran.result.outputs.csrPem)).toContain('BEGIN CERTIFICATE REQUEST');
    expect(ran.requests.find((r) => r.method === 'GET' && r.path.startsWith(`${FM}/certificate-management/csrs`))!.path).toBe(`${FM}/certificate-management/csrs?commonName=vcenter-mgmt.example.com`);
  });

  it('external CA, install step: sends the chain, refuses a key, follows the request, stops on failure', async () => {
    const b = build('fleet91_certificates', { action: 'external', fqdn: 'vcenter-mgmt.example.com' });
    const ran = await runIn(b, routes(), fleetSettings({ dryRun: false }), { step: 'install', certificateChain: CHAIN });
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([`PUT ${FM}/certificate-management/certificates/ck-vc`]);
    expect(bodyOf(ran, 'PUT', `${FM}/certificate-management/certificates/ck-vc`)).toEqual({ caType: 'EXTERNAL_CA', certificateChain: CHAIN });
    expect(ran.calls.slice(-2)).toEqual(['GET /suite-api/api/workflows/requests/req-put', `POST ${FM}/certificate-management/certificates/query`]);
    const key = await runIn(b, routes(), fleetSettings({ dryRun: false }), { step: 'install', certificateChain: `${CHAIN}-----BEGIN PRIVATE KEY-----\nx\n` });
    expect(key.result.error ?? '').toContain('Refusing: certificateChain holds a private key');
    expect(key.writes).toEqual([]);
    const failed = await runIn(b, routes({ state: 'FAILED' }), fleetSettings({ dryRun: false }), { step: 'install', certificateChain: CHAIN });
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): replace the certificate of VCENTER vcenter-mgmt.example.com (EXTERNAL_CA) failed: Request req-put FAILED');
    expect(failed.calls[failed.calls.length - 1]).toBe('POST /hook');
  });

  it('refuses unless exactly one certificate matches the appliance and FQDN', async () => {
    const b = build('fleet91_certificates', { action: 'vmca', fqdn: 'vcenter-mgmt.example.com' });
    const two = await runIn(b, routes({ certs: [CERTS[0], { ...CERTS[0], certificateResourceKey: 'ck-dup' }] }), fleetSettings({ dryRun: false }));
    expect(two.result.error ?? '').toContain('expected exactly one TLS certificate for VCENTER vcenter-mgmt.example.com, found 2');
    expect(two.writes).toEqual([]);
    const ran = await runIn(b, routes(), fleetSettings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(bodyOf(ran, 'PUT', `${FM}/certificate-management/certificates/ck-vc`)).toEqual({ caType: 'VMCA' });
    const capped = await runIn(b, routes(), fleetSettings({ dryRun: false, cap: 0 }));
    expect(capped.result.error ?? '').toContain('Cap reached: 0 change(s) made, the cap is 0');
    expect(capped.writes).toEqual([]);
  });

  it('Microsoft CA: configures the CA with the secret from the SecureString, and leaves a matching one alone', async () => {
    const b = build('fleet91_certificates', { action: 'msca', fqdn: 'vcenter-mgmt.example.com' });
    wellFormed(b, ['apiToken', 'mscaPassword'], ['configure-msca.sh', 'replace-certificate.sh']);
    const settings = fleetSettings({ dryRun: false, mscaPassword: 'Ca-Pa55-do-not-log' });
    const ran = await runIn(b, routes(), settings, { step: 'configure-ca' });
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([`PUT ${FM}/certificate-management/certificate-authorities`]);
    expect(bodyOf(ran, 'PUT', `${FM}/certificate-management/certificate-authorities`)).toEqual({ certificateAuthorityType: 'MICROSOFT', certificateAuthoritiesSpec: { microsoftCertificateAuthoritySpec: { serverUrl: 'https://ca.example.com/certsrv', templateName: 'VMware', username: 'EXAMPLE\\svc-vcf-certs', secret: 'Ca-Pa55-do-not-log' } } });
    const same = await runIn(b, routes({ ca: { certificateAuthoritiesSpec: { microsoftCertificateAuthoritySpec: { serverUrl: 'https://ca.example.com/certsrv', templateName: 'VMware', username: 'EXAMPLE\\svc-vcf-certs' } } } }), settings, { step: 'configure-ca' });
    expect(same.writes).toEqual([]);
    const install = await runIn(b, routes(), settings, { step: 'install' });
    expect(bodyOf(install, 'PUT', `${FM}/certificate-management/certificates/ck-vc`)).toEqual({ caType: 'MSCA' });
  });
});

// ---------------------------------------------------------------------------
// fleet91_settings

describe('fleet91_settings as an Orchestrator package (SDDC Manager DNS and NTP)', { skip: !CURL }, () => {
  const SDDC_PASSWORD = 'Sddc-Pa55-do-not-log';
  const b = build('fleet91_settings', { dns_servers: '10.0.0.10, 10.0.0.11', ntp_servers: 'ntp1.example.com, ntp2.example.com' });
  const routes = (o: { dns?: unknown; ntp?: unknown; result?: string; task?: string } = {}): FakeRoute[] => [
    { method: 'POST', path: '^/v1/tokens$', body: { accessToken: 'sddc-access-do-not-log', refreshToken: { id: 'r' } } },
    at('GET', '/v1/system/dns-configuration', o.dns ?? { dnsServers: [{ ipAddress: '10.9.9.9', isPrimary: true }] }),
    at('GET', '/v1/system/ntp-configuration', o.ntp ?? { ntpServers: [{ ipAddress: 'ntp2.example.com' }, { ipAddress: 'ntp1.example.com' }] }),
    at('POST', '/v1/system/dns-configuration/validations', { id: 'val-1', executionStatus: 'IN_PROGRESS' }),
    seq('GET', '/v1/system/dns-configuration/validations/val-1', [{ body: { id: 'val-1', executionStatus: 'IN_PROGRESS' } }, { body: { id: 'val-1', executionStatus: 'COMPLETED', resultStatus: o.result ?? 'SUCCEEDED', validationChecks: [{ description: 'DNS reachable', resultStatus: o.result ?? 'SUCCEEDED' }] } }]),
    at('PUT', '/v1/system/dns-configuration', { id: 'task-dns', status: 'IN_PROGRESS' }),
    seq('GET', '/v1/tasks/task-dns', [{ body: { id: 'task-dns', status: 'IN_PROGRESS' } }, { body: { id: 'task-dns', status: o.task ?? 'SUCCESSFUL' } }]),
  ];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => ({ sddcManagers: [host], sddcUsername: 'administrator@vsphere.local', sddcPassword: SDDC_PASSWORD, webhook: `https://${host}/hook`, ...extra });

  it('is one package whose resources are the SDDC Manager bodies', () => {
    wellFormed(b, ['sddcPassword'], ['precheck.sh', 'apply-settings.sh', 'dns-setting.json', 'ntp-setting.json']);
    expect(JSON.parse(b.spec.resources.find((r) => r.name === 'dns-configuration.json')!.content)).toEqual({ dnsServers: [{ ipAddress: '10.0.0.10', isPrimary: true }, { ipAddress: '10.0.0.11', isPrimary: false }] });
    expect(JSON.parse(b.spec.resources.find((r) => r.name === 'ntp-configuration.json')!.content)).toEqual({ ntpServers: [{ ipAddress: 'ntp1.example.com' }, { ipAddress: 'ntp2.example.com' }] });
    expect(b.files['IMPORT.md']!).toContain('deprecated');
  });

  it('dry run: reads, runs SDDC Manager\'s validation, changes nothing, leaves the matching NTP alone', async () => {
    const ran = await runIn(b, routes(), settings());
    expect(ran.result.error).toBe(null);
    expect(ran.requests.filter((r) => r.method !== 'GET').map((r) => r.path)).toEqual(['/v1/tokens', '/v1/system/dns-configuration/validations']);
    expect(bodyOf(ran, 'POST', '/v1/system/dns-configuration/validations')).toEqual({ dnsServers: [{ ipAddress: '10.0.0.10', isPrimary: true }, { ipAddress: '10.0.0.11', isPrimary: false }] });
    expect(ran.result.logs.some((l) => l.message.startsWith('NTP servers of 127.0.0.1:') && l.message.endsWith('left as they are.'))).toBe(true);
    expect(ran.result.logs.filter((l) => l.message.startsWith('DRY RUN: would')).length).toBe(1);
  });

  it('armed: validates, applies, follows the task; the token is the SDDC Manager one', async () => {
    const ran = await runIn(b, routes(), settings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.calls).toEqual([
      'POST /v1/tokens',
      'GET /v1/system/dns-configuration',
      'POST /v1/system/dns-configuration/validations',
      'GET /v1/system/dns-configuration/validations/val-1',
      'GET /v1/system/dns-configuration/validations/val-1',
      'PUT /v1/system/dns-configuration',
      'GET /v1/tasks/task-dns',
      'GET /v1/tasks/task-dns',
      'GET /v1/system/ntp-configuration',
    ]);
    expect(JSON.parse(ran.requests[0]!.body)).toEqual({ username: 'administrator@vsphere.local', password: SDDC_PASSWORD });
    expect(ran.requests.slice(1).every((r) => r.headers.authorization === 'Bearer sddc-access-do-not-log')).toBe(true);
    expect(JSON.parse(String(ran.result.outputs.settingsBefore))).toEqual({ [`127.0.0.1:${ran.requests[0]!.host.split(':')[1]}`]: { dns: { dnsServers: [{ ipAddress: '10.9.9.9', isPrimary: true }] }, ntp: { ntpServers: [{ ipAddress: 'ntp2.example.com' }, { ipAddress: 'ntp1.example.com' }] } } });
  });

  it('refuses when SDDC Manager\'s validation does not succeed, and stops at a failed task', async () => {
    const warned = await runIn(b, routes({ result: 'WARNING' }), settings({ dryRun: false }));
    expect(warned.result.error ?? '').toContain("Refusing: SDDC Manager's validation of the new DNS servers");
    expect(warned.writes).toEqual(['POST /v1/system/dns-configuration/validations']);
    const allowed = await runIn(b, routes({ result: 'WARNING' }), settings({ dryRun: false, allowWarnings: true }));
    expect(allowed.result.error).toBe(null);
    const failed = await runIn(b, routes({ task: 'FAILED' }), settings({ dryRun: false }));
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): set the DNS servers of');
    expect(failed.result.error ?? '').toContain('SDDC Manager task task-dns ended FAILED');
    expect(failed.calls[failed.calls.length - 1]).toBe('POST /hook');
    const capped = await runIn(b, routes(), settings({ dryRun: false, cap: 0 }));
    expect(capped.result.error ?? '').toContain('Cap reached: 0 change(s) made');
  });

  it('says so when more than two DNS servers, or a name, is given', () => {
    const blueprint = automationFor('fleet91_settings')!;
    const out = blueprint.automation({ ...defaultValues(blueprint), dns_servers: '10.0.0.1, 10.0.0.2, dns3.example.com' }, 'x');
    const codes = (out.findings ?? []).map((f) => f.code);
    expect(codes.includes('fleet91.settings.dns-max')).toBe(true);
    expect(codes.includes('fleet91.settings.dns-ip')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fleet91_identity

describe('fleet91_identity as Orchestrator packages', { skip: !CURL }, () => {
  const REALM_ROUTE = at('GET', `${FM}/iam/ssorealms`, { ssoRealms: [{ id: 'realm-1', name: 'default' }] });
  const R = `${FM}/iam/ssorealms/realm-1`;

  it('group: adds the role to the group\'s current roles, saves them, and leaves a held role alone', async () => {
    const b = build('fleet91_identity');
    wellFormed(b, ['apiToken'], ['identity.sh', 'role-assignment.json', 'groups-query.json']);
    const CURRENT = [{ roleName: 'sddc_admin', roleScope: { scopeType: 'VCF_INSTANCE', resources: [{ id: 'i-1' }] }, expiresAt: null }];
    const routes = (held: unknown[] = CURRENT): FakeRoute[] => [
      IDB,
      REALM_ROUTE,
      at('POST', `${R}/groups/query`, page('groups', [{ id: 'g-1', name: 'vcf-operators@example.com' }, { id: 'g-2', name: 'vcf-operators-old@example.com' }])),
      at('GET', `${R}/principals/g-1/roles`, { vcfRoleAssignments: held }),
      at('PUT', `${R}/principals/g-1/roles`, {}),
    ];
    const dry = await runIn(b, routes(), fleetSettings());
    expect(dry.result.error).toBe(null);
    expect(dry.writes).toEqual([]);
    const ran = await runIn(b, routes(), fleetSettings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.calls).toEqual(['POST /acs/t/CUSTOMER/token', `GET ${FM}/iam/ssorealms`, `POST ${R}/groups/query`, `GET ${R}/principals/g-1/roles`, `PUT ${R}/principals/g-1/roles`]);
    expect(bodyOf(ran, 'POST', `${R}/groups/query`)).toEqual({ searchTerms: { allOf: [{ field: 'NAME', terms: ['vcf-operators'], operator: 'LIKE' }], anyOf: [] } });
    expect(bodyOf(ran, 'PUT', `${R}/principals/g-1/roles`)).toEqual({ vcfRoleAssignments: [...CURRENT, { roleName: 'vcf_viewer', roleScope: { scopeType: 'SSO_REALM' }, expiresAt: null }] });
    expect(JSON.parse(String(ran.result.outputs.rolesBefore))).toEqual({ vcfRoleAssignments: CURRENT });
    const held = await runIn(b, routes([...CURRENT, { roleName: 'vcf_viewer', roleScope: { scopeType: 'SSO_REALM' }, expiresAt: null }]), fleetSettings({ dryRun: false }));
    expect(held.writes).toEqual([]);
    const unreadable = await runIn(b, [...routes().slice(0, 3), at('GET', `${R}/principals/g-1/roles`, { roles: [] })], fleetSettings({ dryRun: false }));
    expect(unreadable.result.error ?? '').toContain('refusing to replace roles that could not be read');
    expect(unreadable.writes).toEqual([]);
  });

  it('group: refuses with several SSO realms and none named', async () => {
    const b = build('fleet91_identity');
    const ran = await runIn(b, [IDB, at('GET', `${FM}/iam/ssorealms`, { ssoRealms: [{ id: 'a' }, { id: 'b' }] })], fleetSettings({ dryRun: false }));
    expect(ran.result.error ?? '').toContain('Refusing: 2 SSO realms');
  });

  it('role: creates the role once; an existing role is left alone', async () => {
    const b = build('fleet91_identity', { task: 'role' });
    wellFormed(b, ['apiToken'], ['identity.sh', 'vcf-role.json']);
    const ran = await runIn(b, [IDB, REALM_ROUTE, at('GET', `${FM}/iam/roles/fleet-operator`, { message: 'not found' }, 404), at('POST', `${FM}/iam/roles`, { roleName: 'fleet-operator' })], fleetSettings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([`POST ${FM}/iam/roles`]);
    expect(bodyOf(ran, 'POST', `${FM}/iam/roles`)).toEqual({ roleName: 'fleet-operator', roleDisplayName: 'fleet-operator', roleDescription: 'Written by ArchToolKit.', componentRoles: [{ componentType: 'VCENTER', roles: ['ReadOnly'] }, { componentType: 'NSX', roles: ['auditor'] }] });
    const exists = await runIn(b, [IDB, REALM_ROUTE, at('GET', `${FM}/iam/roles/fleet-operator`, { roleName: 'fleet-operator' })], fleetSettings({ dryRun: false }));
    expect(exists.writes).toEqual([]);
    const broken = await runIn(b, [IDB, REALM_ROUTE, at('GET', `${FM}/iam/roles/fleet-operator`, {}, 500)], fleetSettings({ dryRun: false }));
    expect(broken.result.error ?? '').toContain('returned HTTP 500');
    expect(broken.writes).toEqual([]);
  });

  it('oidc: refuses without an emergency client; creates with the secret; updates the one in idpConfigId', async () => {
    const b = build('fleet91_identity', { task: 'oidc', client_id: 'app-123', discovery: 'https://login.example.com/.well-known/openid-configuration' });
    wellFormed(b, ['apiToken', 'oidcClientSecret'], ['identity.sh', 'identity-provider.json']);
    const routes = (emergency: unknown[]): FakeRoute[] => [IDB, REALM_ROUTE, at('GET', `${R}/emergency-clients`, emergency), at('POST', `${FM}/iam/identity-providers`, { id: 'idp-1' }), at('GET', `${FM}/iam/identity-providers/idp-1`, { id: 'idp-1' }), at('PUT', `${FM}/iam/identity-providers`, { id: 'idp-1' })];
    const settings = (extra: Record<string, unknown> = {}) => fleetSettings({ dryRun: false, oidcClientSecret: 'Oidc-Secret-do-not-log', ...extra });
    const locked = await runIn(b, routes([]), settings());
    expect(locked.result.error ?? '').toContain('Refusing: no emergency client in this realm');
    expect(locked.writes).toEqual([]);
    const made = await runIn(b, routes([{ clientId: 'break-glass' }]), settings());
    expect(made.result.error).toBe(null);
    expect(made.writes).toEqual([`POST ${FM}/iam/identity-providers`]);
    const body = bodyOf(made, 'POST', `${FM}/iam/identity-providers`) as { ssoRealmId: string; idpType: string; idpConfig: { oidcConfiguration: Record<string, string> } };
    expect(body.ssoRealmId).toBe('realm-1');
    expect(body.idpType).toBe('ENTRA_ID');
    expect(body.idpConfig.oidcConfiguration).toEqual({ clientId: 'app-123', discoveryEndpoint: 'https://login.example.com/.well-known/openid-configuration', openIdUserIdentifierAttribute: 'email', internalUserIdentifierAttribute: 'email', clientSecret: 'Oidc-Secret-do-not-log' });
    expect(made.result.outputs.resultId).toBe('idp-1');
    const updated = await runIn(b, routes([{ clientId: 'break-glass' }]), settings({ idpConfigId: 'idp-1' }));
    expect(updated.writes).toEqual([`PUT ${FM}/iam/identity-providers`]);
    expect(bodyOf(updated, 'PUT', `${FM}/iam/identity-providers`).id).toBe('idp-1');
  });

  it('sync: starts a drift check of every role, retries only the failed ones, and only when armed', async () => {
    const b = build('fleet91_identity', { task: 'sync' });
    wellFormed(b, ['apiToken'], ['identity.sh']);
    const routes: FakeRoute[] = [IDB, at('GET', `${FM}/iam/components/roles`, [{ id: 'r-1', name: 'ops-ro', status: 'PROVISIONED' }, { id: 'r-2', name: 'net-admin', status: 'PROVISIONING_FAILED' }]), { method: 'POST', path: '/drift-check$', body: { taskId: 't' } }, at('POST', `${FM}/iam/components/roles/r-2/retry`, {})];
    const dry = await runIn(b, routes, fleetSettings());
    expect(dry.result.error).toBe(null);
    expect(dry.requests.filter((r) => r.method === 'POST' && r.path !== '/acs/t/CUSTOMER/token' && r.path !== '/hook').map((r) => r.path)).toEqual([`${FM}/iam/components/roles/r-1/drift-check`, `${FM}/iam/components/roles/r-2/drift-check`]);
    expect(dry.calls.includes(`GET ${FM}/iam/ssorealms`)).toBe(false);
    const ran = await runIn(b, routes, fleetSettings({ dryRun: false }));
    expect(ran.requests.filter((r) => r.path.endsWith('/retry')).map((r) => r.path)).toEqual([`${FM}/iam/components/roles/r-2/retry`]);
    expect(ran.calls[ran.calls.length - 1]).toBe('POST /hook');
  });
});

// ---------------------------------------------------------------------------
// fleet91_api_clients

describe('fleet91_api_clients as an Orchestrator package', { skip: !CURL }, () => {
  const b = build('fleet91_api_clients');
  const R = `${FM}/iam/ssorealms/realm-1`;
  const NEW_TOKEN = 'vidb_NEWTOKEN0001';
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);
  const token = (id: string, daysLeft: number, lastChars: string, status = 'ACTIVE') => ({ id, apiClientId: 'archtoolkit-automation', tokenName: id, tokenLastChars: lastChars, tokenStatus: status, expirationDate: (now + daysLeft * day) * 1000 });
  const routes = (o: { tokens?: unknown[]; clients?: unknown[]; roles?: unknown[]; proveStatus?: number } = {}): FakeRoute[] => [
    { method: 'POST', path: '^/acs/t/CUSTOMER/token$', body: { access_token: ACCESS } },
    { method: 'GET', path: `^${esc(`${FM}/iam/ssorealms`)}$`, responses: [{ body: { ssoRealms: [{ id: 'realm-1' }] } }, { status: o.proveStatus ?? 200, body: { ssoRealms: [{ id: 'realm-1' }] } }] },
    at('POST', `${R}/api-tokens/query`, page('apiTokens', o.tokens ?? [token('t-old', 10, '-log'), { ...token('t-other', 80, 'zzzz'), apiClientId: 'someone-else' }])),
    at('POST', `${R}/api-clients/query`, page('apiClients', o.clients ?? [])),
    at('POST', `${R}/api-clients`, { clientUuid: 'uuid-1', clientId: 'archtoolkit-automation' }),
    at('GET', `${R}/principals/uuid-1/roles`, { vcfRoleAssignments: o.roles ?? [] }),
    at('PUT', `${R}/principals/uuid-1/roles`, {}),
    at('POST', `${R}/api-tokens`, { id: 't-new', token: NEW_TOKEN, tokenLastChars: '0001', expirationDate: (now + 90 * day) * 1000 }),
    at('DELETE', `${R}/api-tokens/t-9`, {}),
  ];

  it('is one package with the role body', () => {
    wellFormed(b, ['apiToken'], ['api-token.sh', 'role-assignment.json']);
    expect(b.spec.workflows[0]!.xml.includes('name="newApiToken" type="SecureString"')).toBe(true);
  });

  it('status: reads only, and fails inside the rotation window', async () => {
    const ran = await runIn(b, routes(), fleetSettings(), { command: 'status' });
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([]);
    expect(ran.result.outputs.daysLeft).toBe(9);
    expect(ran.result.logs.some((l) => l.message === 'PROBLEM: archtoolkit-automation: API token has 9 day(s) left — rotation is due')).toBe(true);
    expect(bodyOf(ran, 'POST', `${R}/api-tokens/query`)).toEqual({ searchTerms: { allOf: [{ field: 'CLIENT_ID', terms: ['archtoolkit-automation'], operator: 'LIKE' }], anyOf: [] }, filters: { tokenType: ['API_CLIENT'] } });
    expect(ran.calls[ran.calls.length - 1]).toBe('POST /hook');
  });

  it('rotate: issues a new token, proves it at the broker and with a read, returns it, keeps the old one', async () => {
    const dry = await runIn(b, routes(), fleetSettings(), { command: 'rotate' });
    expect(dry.writes).toEqual([]);
    const ran = await runIn(b, routes(), fleetSettings({ dryRun: false }), { command: 'rotate' });
    expect(ran.result.error).toBe(null);
    expect(ran.calls).toEqual(['POST /acs/t/CUSTOMER/token', `GET ${FM}/iam/ssorealms`, `POST ${R}/api-tokens/query`, `POST ${R}/api-tokens`, 'POST /acs/t/CUSTOMER/token', `GET ${FM}/iam/ssorealms`]);
    const issued = bodyOf(ran, 'POST', `${R}/api-tokens`);
    expect(issued).toEqual({ apiClientId: 'archtoolkit-automation', tokenName: issued.tokenName, tokenDescription: 'Issued by ArchToolKit', tokenType: 'API_CLIENT', apiTokenTtl: String(90 * 24 * 60), accessTokenTtl: '30' });
    expect(ran.requests[4]!.body).toBe(`grant_type=${encodeURIComponent('urn:custom:vcf:params:oauth:grant-type:api-token')}&api_token=${NEW_TOKEN}`);
    expect(ran.result.outputs.newApiToken).toBe(NEW_TOKEN);
    expect(ran.result.outputs.newTokenId).toBe('t-new');
    expect(ran.result.logs.map((l) => l.message).join('\n').includes(NEW_TOKEN)).toBe(false);
    expect(ran.writes.includes(`DELETE ${R}/api-tokens/t-old`)).toBe(false);
    const notDue = await runIn(b, routes({ tokens: [token('t-old', 60, '-log')] }), fleetSettings({ dryRun: false }), { command: 'rotate' });
    expect(notDue.writes).toEqual([]);
    const forced = await runIn(b, routes({ tokens: [token('t-old', 60, '-log')] }), fleetSettings({ dryRun: false }), { command: 'rotate', force: true });
    expect(forced.writes).toEqual([`POST ${R}/api-tokens`]);
  });

  it('rotate: a new token that does not work fails the run and is still returned', async () => {
    const ran = await runIn(b, routes({ proveStatus: 401 }), fleetSettings({ dryRun: false }), { command: 'rotate' });
    expect(ran.result.error ?? '').toContain('The new token t-new did not work');
    expect(ran.result.outputs.newApiToken).toBe(NEW_TOKEN);
  });

  it('bootstrap: creates the client, gives it its role, issues the first token; reuses what exists', async () => {
    const ran = await runIn(b, routes({ tokens: [] }), fleetSettings({ dryRun: false }), { command: 'bootstrap' });
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([`POST ${R}/api-clients`, `PUT ${R}/principals/uuid-1/roles`, `POST ${R}/api-tokens`]);
    expect(bodyOf(ran, 'POST', `${R}/api-clients`)).toEqual({ clientId: 'archtoolkit-automation', clientName: 'ArchToolKit automation', clientDescription: 'Fleet automation (ArchToolKit)' });
    expect(bodyOf(ran, 'PUT', `${R}/principals/uuid-1/roles`)).toEqual({ vcfRoleAssignments: [{ roleName: 'fleetmgmt-admin', roleScope: { scopeType: 'SSO_REALM' }, expiresAt: null }] });
    const again = await runIn(b, routes({ clients: [{ clientId: 'archtoolkit-automation', clientUuid: 'uuid-1' }], roles: [{ roleName: 'fleetmgmt-admin', roleScope: { scopeType: 'SSO_REALM' }, expiresAt: null }] }), fleetSettings({ dryRun: false }), { command: 'bootstrap' });
    expect(again.writes).toEqual([]);
    const capped = await runIn(b, routes({ tokens: [] }), fleetSettings({ dryRun: false, cap: 2 }), { command: 'bootstrap' });
    expect(capped.result.error ?? '').toContain('Cap reached: 2 change(s) made, the cap is 2; stopping before: issue the first API token');
  });

  it('revoke: deletes the named token, never the one in apiToken', async () => {
    const tokens = [token('t-live', 80, '-log'), token('t-9', 5, 'wxyz')];
    const ran = await runIn(b, routes({ tokens }), fleetSettings({ dryRun: false }), { command: 'revoke', tokenId: 't-9' });
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([`DELETE ${R}/api-tokens/t-9`]);
    const live = await runIn(b, routes({ tokens }), fleetSettings({ dryRun: false }), { command: 'revoke', tokenId: 't-live' });
    expect(live.result.error ?? '').toContain('Refusing: t-live looks like the token in apiToken');
    expect(live.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OpsToken packages: licensing, cloud proxies

const OPS_LOGIN_ROUTES: FakeRoute[] = [
  { method: 'POST', path: '^/suite-api/api/auth/token/acquire$', body: { token: OPS_TOKEN, validity: 0 } },
  { method: 'POST', path: '^/suite-api/api/auth/token/release$', body: '' },
];
const opsSettings = (extra: Record<string, unknown> = {}) => (host: string) => ({ opsHost: host, opsUsername: 'svc-fleet', opsPassword: OPS_PASSWORD, webhook: `https://${host}/hook`, ...extra });
function opsTokenOnly(ran: Ran): void {
  expect(JSON.parse(ran.requests[0]!.body)).toEqual({ username: 'svc-fleet', password: OPS_PASSWORD });
  for (const r of ran.requests.slice(1)) if (r.path.startsWith('/suite-api/')) expect(r.headers.authorization).toBe(`OpsToken ${OPS_TOKEN}`);
  expect(ran.calls.filter((c) => c.startsWith('POST /suite-api/api/auth/token/')).length).toBe(2);
}

describe('fleet91_licensing as an Orchestrator package', { skip: !CURL }, () => {
  const b = build('fleet91_licensing');
  const routes = (usage?: unknown): FakeRoute[] => [
    ...OPS_LOGIN_ROUTES,
    at('GET', '/suite-api/api/product/licensing/info', { licenses: [{ name: 'VCF', status: 'VALID', used: 64, capacity: 128 }, { name: 'vSAN add-on', status: 'EXPIRED', used: 10, capacity: 8 }] }),
    at('GET', '/suite-api/api/product/licensing/edition', { edition: 'VCF' }),
    ...(usage ? [at('GET', '/suite-api/api/license-server/usage', usage)] : []),
  ];

  it('reads the licensing info, writes it as CSV, and flags what is expired', async () => {
    wellFormed(b, ['opsPassword'], ['license-report.sh']);
    const ran = await runIn(b, routes(), opsSettings());
    expect(ran.result.error).toBe(null);
    expect(ran.calls).toEqual(['POST /suite-api/api/auth/token/acquire', 'GET /suite-api/api/product/licensing/info', 'GET /suite-api/api/product/licensing/edition', 'POST /suite-api/api/auth/token/release', 'POST /hook']);
    expect(ran.result.outputs.usageCsv).toBe('capacity,name,status,used\n128,VCF,VALID,64\n8,vSAN add-on,EXPIRED,10\n');
    expect(ran.result.outputs.problemCount).toBe(1);
    opsTokenOnly(ran);
  });

  it('reads licenseUsagePath when it is set, and still only GETs', async () => {
    const ran = await runIn(b, routes({ assets: [{ asset: 'esx01', used: 16 }, { asset: 'esx02', used: 16 }, { asset: 'esx03', used: 32 }] }), opsSettings({ licenseUsagePath: '/suite-api/api/license-server/usage' }));
    expect(ran.result.error).toBe(null);
    expect(ran.result.outputs.usageCsv).toBe('asset,used\nesx01,16\nesx02,16\nesx03,32\n');
    expect(ran.result.outputs.problemCount).toBe(0);
    expect(ran.requests.filter((r) => r.method !== 'GET' && !r.path.includes('/auth/token/')).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fleet91_config_drift

describe('fleet91_config_drift as Orchestrator packages', { skip: !CURL }, () => {
  const VC_PASSWORD = 'Vc-Pa55-do-not-log';
  const CL = '/api/esx/settings/clusters';
  const vcRoutes = (o: { status?: Record<string, string>; precheck?: string; after?: string } = {}): FakeRoute[] => [
    { method: 'POST', path: '^/api/session$', body: JSON.stringify('vc-session-do-not-log') },
    { method: 'DELETE', path: '^/api/session$', status: 204 },
    { method: 'GET', path: '^/api/vcenter/cluster\\?names=wld01-cl01$', body: [{ cluster: 'domain-c1', name: 'wld01-cl01' }] },
    { method: 'GET', path: '^/api/vcenter/cluster\\?names=wld01-cl02$', body: [{ cluster: 'domain-c2', name: 'wld01-cl02' }, { cluster: 'domain-c9', name: 'wld01-cl02-old' }] },
    { method: 'POST', path: `^${esc(`${CL}/domain-c1/configuration?action=checkCompliance&vmw-task=true`)}$`, body: JSON.stringify('task-cc1') },
    { method: 'POST', path: `^${esc(`${CL}/domain-c2/configuration?action=checkCompliance&vmw-task=true`)}$`, body: JSON.stringify('task-cc2') },
    { method: 'POST', path: `^${esc(`${CL}/domain-c1/configuration?action=exportConfig`)}$`, body: { config: '{"profile":{"esx":{}}}' } },
    { method: 'POST', path: `^${esc(`${CL}/domain-c1/configuration?action=precheck&vmw-task=true`)}$`, body: JSON.stringify('task-pre') },
    { method: 'POST', path: `^${esc(`${CL}/domain-c1/configuration?action=apply&vmw-task=true`)}$`, body: JSON.stringify('task-apply') },
    seq('GET', '/api/cis/tasks/task-cc1', [{ body: { status: 'RUNNING' } }, { body: { status: 'SUCCEEDED', result: { status: o.status?.c1 ?? 'NON_COMPLIANT', hosts: { 'host-1': { status: 'NON_COMPLIANT' } } } } }, { body: { status: 'SUCCEEDED', result: { status: o.after ?? 'COMPLIANT' } } }]),
    at('GET', '/api/cis/tasks/task-cc2', { status: 'SUCCEEDED', result: { status: o.status?.c2 ?? 'COMPLIANT' } }),
    at('GET', '/api/cis/tasks/task-pre', { status: 'SUCCEEDED', result: { status: o.precheck ?? 'OK' } }),
    at('GET', '/api/cis/tasks/task-apply', { status: 'SUCCEEDED', result: {} }),
  ];
  const vcSettings = (extra: Record<string, unknown> = {}) => (host: string) => ({ vcenter: host, vcUsername: 'svc-drift@vsphere.local', vcPassword: VC_PASSWORD, webhook: `https://${host}/hook`, ...extra });

  it('detect: checks compliance of each cluster, changes nothing, and reports drift', async () => {
    const b = build('fleet91_config_drift');
    wellFormed(b, ['vcfApiToken', 'vcPassword', 'opsPassword'], ['detect-drift.sh', 'salt-status.sh']);
    const ran = await runIn(b, vcRoutes(), vcSettings());
    expect(ran.result.error).toBe(null);
    expect(ran.requests.filter((r) => r.method === 'POST' && r.path !== '/api/session' && r.path !== '/hook').map((r) => r.path.split('?')[1])).toEqual(['action=checkCompliance&vmw-task=true', 'action=checkCompliance&vmw-task=true']);
    expect(ran.requests.filter((r) => /action=(apply|precheck|importConfig)/.test(r.path)).length).toBe(0);
    expect(ran.result.outputs.problemCount).toBe(1);
    expect(String(ran.result.outputs.reportText)).toBe('wld01-cl01\tNON_COMPLIANT\n  host-1\tNON_COMPLIANT\nwld01-cl02\tCOMPLIANT');
    expect(ran.requests.filter((r) => r.path.startsWith('/api/') && r.path !== '/api/session').every((r) => r.headers['vmware-api-session-id'] === 'vc-session-do-not-log')).toBe(true);
    expect(ran.calls.slice(-2)).toEqual(['DELETE /api/session', 'POST /hook']);
  });

  it('detect: also reads the Salt status when opsHost is set', async () => {
    const b = build('fleet91_config_drift');
    const ran = await runIn(b, [...vcRoutes({ status: { c1: 'COMPLIANT' } }), ...OPS_LOGIN_ROUTES, at('GET', '/suite-api/api/salt/resources/statuses', [{ resourceId: 'r1', resourceName: 'vcenter-mgmt', status: 'ENABLED' }, { resourceId: 'r2', resourceName: 'nsx', status: 'FAILED' }])], (host) => ({ ...vcSettings()(host), opsHost: host, opsUsername: 'svc-fleet', opsPassword: OPS_PASSWORD }));
    expect(ran.result.error).toBe(null);
    expect(ran.result.logs.filter((l) => l.message.startsWith('PROBLEM: ')).map((l) => l.message)).toEqual(['PROBLEM: Salt: nsx: FAILED']);
  });

  it('remediate: exports, checks, prechecks, applies only when armed, and checks again', async () => {
    const b = build('fleet91_config_drift', { mode: 'remediate' });
    wellFormed(b, ['vcfApiToken', 'vcPassword'], ['remediate-drift.sh', 'salt-status.sh']);
    const dry = await runIn(b, vcRoutes(), vcSettings());
    expect(dry.result.error).toBe(null);
    expect(dry.requests.some((r) => r.path.includes('action=apply'))).toBe(false);
    expect(dry.result.outputs.configBefore).toBe('{"profile":{"esx":{}}}');
    const ran = await runIn(b, vcRoutes(), vcSettings({ dryRun: false }));
    expect(ran.result.error).toBe(null);
    expect(ran.requests.filter((r) => r.method === 'POST' && r.path.includes('action=')).map((r) => /action=(\w+)/.exec(r.path)![1])).toEqual(['exportConfig', 'checkCompliance', 'precheck', 'apply', 'checkCompliance']);
    expect(ran.requests.find((r) => r.path.includes('action=apply'))!.body).toBe('{}');
  });

  it('remediate: refuses a precheck that is not a pass, and fails if still drifted after apply', async () => {
    const b = build('fleet91_config_drift', { mode: 'remediate' });
    const refused = await runIn(b, vcRoutes({ precheck: 'ERROR' }), vcSettings({ dryRun: false }));
    expect(refused.result.error ?? '').toContain('Refusing: the precheck status is ERROR, not a pass');
    expect(refused.requests.some((r) => r.path.includes('action=apply'))).toBe(false);
    expect(refused.calls.slice(-2)).toEqual(['DELETE /api/session', 'POST /hook']);
    const still = await runIn(b, vcRoutes({ after: 'NON_COMPLIANT' }), vcSettings({ dryRun: false }));
    expect(still.result.error ?? '').toContain('Stopped after 0 change(s): apply the desired configuration to cluster wld01-cl01');
    expect(still.result.error ?? '').toContain('still NON_COMPLIANT after remediation');
    const capped = await runIn(b, vcRoutes(), vcSettings({ dryRun: false, cap: 0 }));
    expect(capped.result.error ?? '').toContain('Cap reached');
    expect(capped.requests.some((r) => r.path.includes('action=apply'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fleet91_lifecycle

describe('fleet91_lifecycle as an Orchestrator package', { skip: !CURL }, () => {
  const b = build('fleet91_lifecycle', { sftp_fingerprint: 'SHA256:abc' });
  const JWT = 'fleet-lcm-jwt-do-not-log';
  const L = '/fleet-lcm/v1';
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
  const routes = (o: { backups?: unknown[]; precheck?: string; plans?: unknown[]; task?: string } = {}): FakeRoute[] => [
    ...OPS_LOGIN_ROUTES,
    { method: 'POST', path: '^/suite-api/api/auth/token/exchange$', body: { jwtToken: JWT } },
    at('GET', `${L}/components`, { elements: [{ type: 'VCF_OPERATIONS', fqdn: 'vcfops.example.com', version: '9.1.0.0', status: 'ACTIVE' }] }),
    at('GET', `${L}/sddc-lcms`, { elements: [{ id: 'lcm-1' }] }),
    at('GET', `${L}/sddc-lcms/lcm-1/backups`, { backups: o.backups ?? [{ componentType: 'VCF_OPERATIONS', name: 'vcfops', points: [hoursAgo(30), hoursAgo(3)] }, { componentType: 'IDENTITY_BROKER', name: 'idb', points: [hoursAgo(2)] }] }),
    at('PATCH', `${L}/sddc-lcms/lcm-1`, { taskId: 'task-bk' }),
    at('GET', `${L}/upgrade-plans`, { elements: o.plans ?? [] }),
    at('POST', `${L}/upgrade-plans`, { id: 'plan-1', components: { elements: [{ type: 'VCF_OPERATIONS', fqdn: 'vcfops.example.com', version: '9.1.0.0', targetVersion: '9.1.1.0', status: 'PENDING' }] } }),
    { method: 'POST', path: `^${esc(`${L}/upgrade-plans/plan-1?action=precheck`)}$`, body: { taskId: 'task-pre' } },
    { method: 'POST', path: `^${esc(`${L}/upgrade-plans/plan-1?action=apply`)}$`, body: { taskId: 'task-up' } },
    at('GET', `${L}/upgrade-plans/plan-1`, { id: 'plan-1', components: { elements: [{ type: 'VCF_OPERATIONS', fqdn: 'vcfops.example.com', precheck: { status: o.precheck ?? 'SUCCEEDED' } }, { type: 'IDENTITY_BROKER', fqdn: 'idb.example.com', precheck: { status: o.precheck ?? 'SUCCEEDED' } }] } }),
    at('GET', `${L}/tasks/task-bk`, { status: 'SUCCEEDED' }),
    at('GET', `${L}/tasks/task-pre`, { status: 'SUCCEEDED' }),
    seq('GET', `${L}/tasks/task-up`, [{ body: { status: 'RUNNING' } }, { body: { status: o.task ?? 'SUCCEEDED', errors: [{ message: 'upgrade failed' }] } }]),
  ];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => ({ ...opsSettings()(host), lcmHost: host, sftpPassword: 'Sftp-Pa55-do-not-log', backupPassphrase: 'Passphrase-do-not-log', ...extra });
  const lcmCalls = (ran: Ran) => ran.requests.filter((r) => r.path.startsWith(L));

  it('is one package with its own Fleet LCM token action and the backup body', () => {
    wellFormed(b, ['opsPassword', 'sftpPassword', 'backupPassphrase'], ['fleet-lifecycle.sh', 'backup-config.json']);
    expect(b.spec.actions.map((a) => a.name)).toEqual(['fleetLcmToken']);
    expect(JSON.parse(b.spec.resources[0]!.content).backupConfigSpec.storage.sftp.thumbprint).toBe('SHA256:abc');
  });

  it('backup-status: reads only, exchanges the OpsToken for the Fleet LCM token, and passes fresh backups', async () => {
    const ran = await runIn(b, routes(), settings(), { command: 'backup-status' });
    expect(ran.result.error).toBe(null);
    expect(ran.calls).toEqual(['POST /suite-api/api/auth/token/acquire', 'POST /suite-api/api/auth/token/exchange', `GET ${L}/sddc-lcms`, `GET ${L}/sddc-lcms/lcm-1/backups`, 'POST /suite-api/api/auth/token/release']);
    expect(bodyOf(ran, 'POST', '/suite-api/api/auth/token/exchange')).toEqual({ serviceKeys: ['fleet-lcm'] });
    expect(lcmCalls(ran).every((r) => r.headers.authorization === `Bearer ${JWT}`)).toBe(true);
    expect(String(ran.result.outputs.reportText)).toBe('lcm-1\tVCF_OPERATIONS\tvcfops\t3\nlcm-1\tIDENTITY_BROKER\tidb\t2');
    const stale = await runIn(b, routes({ backups: [{ componentType: 'VCF_OPERATIONS', name: 'vcfops', points: [hoursAgo(40)] }, { componentType: 'IDENTITY_BROKER', name: 'idb', points: [] }] }), settings(), { command: 'backup-status' });
    expect(stale.result.logs.filter((l) => l.message.startsWith('PROBLEM: ')).map((l) => l.message)).toEqual(['PROBLEM: VCF_OPERATIONS vcfops: last backup 40h ago (limit 24h)', 'PROBLEM: IDENTITY_BROKER idb: no readable backup point']);
    expect(stale.calls[stale.calls.length - 1]).toBe('POST /hook');
  });

  it('backup-config: adds the two secrets in memory and PATCHes each instance only when armed', async () => {
    const dry = await runIn(b, routes(), settings(), { command: 'backup-config' });
    expect(dry.result.error).toBe(null);
    expect(dry.writes).toEqual([]);
    const ran = await runIn(b, routes(), settings({ dryRun: false }), { command: 'backup-config' });
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([`PATCH ${L}/sddc-lcms/lcm-1`]);
    const body = bodyOf(ran, 'PATCH', `${L}/sddc-lcms/lcm-1`) as { backupConfigSpec: { storage: { sftp: Record<string, string> }; encryptionPassphrase: string } };
    expect(body.backupConfigSpec.storage.sftp.password).toBe('Sftp-Pa55-do-not-log');
    expect(body.backupConfigSpec.encryptionPassphrase).toBe('Passphrase-do-not-log');
    expect(ran.calls.includes(`GET ${L}/tasks/task-bk`)).toBe(true);
    const unfilled = build('fleet91_lifecycle');
    expect((await runIn(unfilled, routes(), settings({ dryRun: false }), { command: 'backup-config' })).result.error ?? '').toContain('<REQUIRED> values');
  });

  it('plan: creates one plan to the target, and reuses one that exists', async () => {
    const ran = await runIn(b, routes(), settings({ dryRun: false }), { command: 'plan' });
    expect(ran.result.error).toBe(null);
    expect(bodyOf(ran, 'POST', `${L}/upgrade-plans`)).toEqual({ spec: { desiredSoftware: { version: '9.1.1.0', components: [] }, componentsFilter: [] } });
    expect(ran.result.outputs.upgradePlanId).toBe('plan-1');
    const again = await runIn(b, routes({ plans: [{ id: 'plan-0', spec: { desiredSoftware: { version: '9.1.1.0' } } }] }), settings({ dryRun: false }), { command: 'plan' });
    expect(again.writes).toEqual([]);
    expect(again.result.outputs.upgradePlanId).toBe('plan-0');
  });

  it('apply: refuses without a change reference, a passed precheck or a backup of every component; then applies and follows it', async () => {
    const noChange = await runIn(b, routes(), settings({ dryRun: false }), { command: 'apply', planId: 'plan-1' });
    expect(noChange.result.error ?? '').toContain('Refusing: give the change reference');
    const notPassed = await runIn(b, routes({ precheck: 'FAILED' }), settings({ dryRun: false }), { command: 'apply', planId: 'plan-1', changeRef: 'CHG-1' });
    expect(notPassed.result.error ?? '').toContain('Refusing: the plan has not passed its precheck');
    const noBackup = await runIn(b, routes({ backups: [{ componentType: 'VCF_OPERATIONS', name: 'vcfops', points: [hoursAgo(1)] }] }), settings({ dryRun: false }), { command: 'apply', planId: 'plan-1', changeRef: 'CHG-1' });
    expect(noBackup.result.error ?? '').toContain('IDENTITY_BROKER: in the plan, but no backup of that component type is listed');
    for (const refused of [noChange, notPassed, noBackup]) expect(refused.writes).toEqual([]);
    const dry = await runIn(b, routes(), settings(), { command: 'apply', planId: 'plan-1' });
    expect(dry.result.error).toBe(null);
    expect(dry.result.logs.some((l) => l.message === 'DRY RUN: would apply upgrade plan plan-1 to 9.1.1.0')).toBe(true);
    const ran = await runIn(b, routes(), settings({ dryRun: false }), { command: 'apply', planId: 'plan-1', changeRef: 'CHG-1' });
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual([`POST ${L}/upgrade-plans/plan-1`]);
    expect(ran.requests.find((r) => r.method === 'POST' && r.path.startsWith(`${L}/upgrade-plans/plan-1`))!.path).toBe(`${L}/upgrade-plans/plan-1?action=apply`);
    const failed = await runIn(b, routes({ task: 'FAILED' }), settings({ dryRun: false }), { command: 'apply', planId: 'plan-1', changeRef: 'CHG-1' });
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): apply upgrade plan plan-1 to 9.1.1.0 under change CHG-1 failed: Fleet LCM task task-up FAILED');
    expect(failed.calls.slice(-2)).toEqual(['POST /suite-api/api/auth/token/release', 'POST /hook']);
  });

  it('precheck: runs the plan precheck, which changes no component, and reports what is not ready', async () => {
    const ran = await runIn(b, routes({ precheck: 'WARNING' }), settings(), { command: 'precheck', planId: 'plan-1' });
    expect(ran.result.error).toBe(null);
    expect(ran.result.logs.filter((l) => l.message.startsWith('PROBLEM: not ready')).length).toBe(2);
  });
});

describe('fleet91_cloud_proxy as an Orchestrator package', { skip: !CURL }, () => {
  const b = build('fleet91_cloud_proxy');
  const now = Date.now();
  const COLLECTORS = [
    { id: 1, name: 'Default collector group', state: 'UP', local: true, lastHeartbeat: now - 3600000 },
    { id: 11, name: 'cp-site-a-01', state: 'UP', lastHeartbeat: now - 60000 },
    { id: 12, name: 'cp-site-a-02', state: 'UP', lastHeartbeat: now - 30 * 60000 },
    { id: 13, name: 'cp-site-b-01', state: 'DOWN', lastHeartbeat: now - 3600000 },
  ];
  const routes = (o: { collectors?: unknown[]; groups?: unknown[] } = {}): FakeRoute[] => [
    ...OPS_LOGIN_ROUTES,
    at('GET', '/suite-api/api/collectors', { collector: o.collectors ?? COLLECTORS }),
    at('GET', '/suite-api/api/collectorgroups', { collectorGroups: o.groups ?? [{ id: 'g-b', name: 'site-b-ha', haEnabled: true, lbEnabled: false, collectorId: [13, 11] }] }),
    at('POST', '/suite-api/api/collectorgroups', { id: 'g-new' }),
    at('PUT', '/suite-api/api/collectorgroups', { id: 'g-a' }),
  ];

  it('health: reads only, and reports proxies down or late and HA groups without a spare', async () => {
    wellFormed(b, ['opsPassword'], ['collector-group.sh', 'collector-group.json', 'proxy-health.sh']);
    const ran = await runIn(b, routes(), opsSettings());
    expect(ran.result.error).toBe(null);
    expect(ran.calls).toEqual(['POST /suite-api/api/auth/token/acquire', 'GET /suite-api/api/collectors', 'GET /suite-api/api/collectorgroups', 'POST /suite-api/api/auth/token/release', 'POST /hook']);
    expect(ran.result.logs.filter((l) => l.message.startsWith('PROBLEM: ')).map((l) => l.message)).toEqual(['PROBLEM: cp-site-a-02: no heartbeat for 30 minutes', 'PROBLEM: cp-site-b-01: state DOWN', 'PROBLEM: collector group site-b-ha: only 1 member(s) UP — no failover left']);
    opsTokenOnly(ran);
    const empty = await runIn(b, routes({ collectors: [] }), opsSettings());
    expect(empty.result.error ?? '').toContain('listed no collectors at all');
  });

  it('group: creates the group with the proxies\' ids, only when armed', async () => {
    const dry = await runIn(b, routes(), opsSettings(), { task: 'group' });
    expect(dry.result.error).toBe(null);
    expect(dry.writes).toEqual([]);
    const ran = await runIn(b, routes(), opsSettings({ dryRun: false }), { task: 'group' });
    expect(ran.result.error).toBe(null);
    expect(ran.writes).toEqual(['POST /suite-api/api/collectorgroups']);
    expect(bodyOf(ran, 'POST', '/suite-api/api/collectorgroups')).toEqual({ name: 'site-a-ha', description: 'Written by ArchToolKit.', collectorId: [11, 12], haEnabled: true, lbEnabled: true });
  });

  it('group: updates a group whose members differ, leaves a matching one alone, refuses a proxy that is down', async () => {
    const differs = await runIn(b, routes({ groups: [{ id: 'g-a', name: 'site-a-ha', haEnabled: true, lbEnabled: false, collectorId: [11] }] }), opsSettings({ dryRun: false }), { task: 'group' });
    expect(differs.writes).toEqual(['PUT /suite-api/api/collectorgroups']);
    expect(bodyOf(differs, 'PUT', '/suite-api/api/collectorgroups')).toEqual({ name: 'site-a-ha', description: 'Written by ArchToolKit.', collectorId: [11, 12], haEnabled: true, lbEnabled: true, id: 'g-a' });
    expect(JSON.parse(String(differs.result.outputs.groupBefore)).collectorId).toEqual([11]);
    const same = await runIn(b, routes({ groups: [{ id: 'g-a', name: 'site-a-ha', haEnabled: true, lbEnabled: true, collectorId: [12, 11] }] }), opsSettings({ dryRun: false }), { task: 'group' });
    expect(same.writes).toEqual([]);
    const down = build('fleet91_cloud_proxy', { proxies: 'cp-site-a-01, cp-site-b-01' });
    const refused = await runIn(down, routes(), opsSettings({ dryRun: false }), { task: 'group' });
    expect(refused.result.error ?? '').toContain('Refusing: not UP: cp-site-b-01=DOWN');
    expect(refused.writes).toEqual([]);
    const capped = await runIn(b, routes(), opsSettings({ dryRun: false, cap: 0 }), { task: 'group' });
    expect(capped.result.error ?? '').toContain('Cap reached');
    expect(capped.writes).toEqual([]);
  });
});
