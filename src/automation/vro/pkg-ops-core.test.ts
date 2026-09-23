/**
 * The VCF Operations automations (setup, operations, content) as Orchestrator
 * packages: built, parsed, ES5, secrets empty — and run in the emulator against
 * a fake VCF Operations 9.1 suite API in another process.
 *
 * Every changing workflow is shown to write nothing in a dry run, to make
 * exactly the expected calls in order with the right bodies when armed, to stop
 * at the cap and at the first failure (and still release the session), and to
 * leave what exists alone. Every read-only one is shown to read only (GET, and
 * the documented POST-for-query) and to produce the right output. No run logs a
 * secret.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { readPackageSpec, type VroPackageSpec } from '../../kit/vro-package.ts';
import { automationFor } from '../blueprints/index.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../../testing/fake-rest-server.ts';

const CURL = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
})();

const OPS_PASSWORD = 'Ops-Pa55word-do-not-log';
const OPS_TOKEN = 'ops-token-do-not-log';
const VC_PASSWORD = 'Vc-Pa55word-do-not-log';
const SN_PASSWORD = 'Sn-Pa55word-do-not-log';

function build(id: string, overrides: BlueprintValues = {}): Record<string, string> {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`no blueprint ${id}`);
  return { ...blueprint.build({ ...defaultValues(blueprint), ...overrides }, id).files };
}

/** The automation's own packages (not the core library). */
function own(files: Record<string, string>): { dir: string; spec: VroPackageSpec }[] {
  return Object.entries(packagesIn(files))
    .filter(([dir]) => dir !== 'com.archtoolkit.core.package')
    .map(([dir, text]) => ({ dir, spec: readPackageSpec(text) }));
}

function logText(run: WorkflowRun): string {
  return run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');
}

// ---------------------------------------------------------------------------
// Every automation: the package

const CHANGING = [
  'vcfops_adapter_instance',
  'vcfops_outbound_plugin',
  'vcfops_access',
  'vcfops_notify_webhook',
  'vcfops_scope_group',
  'vcfops_reclaim_schedule',
  'vcfops_maintenance_window',
  'vcfops_capacity_report',
  'vcfops_policy_toggle',
  'vcfops_alert_action',
  'vcfops_super_metric',
  'vcfops_workload_policy',
  'vcfops_webhook_payload',
];
const READING = ['vcfops_compliance', 'vcfops_content_backup', 'vcfops_self_health'];

describe('pkg ops-core: every VCF Operations automation is an Orchestrator package', () => {
  const variants: [string, BlueprintValues][] = [
    ...[...CHANGING, ...READING].map((id): [string, BlueprintValues] => [id, {}]),
    ['vcfops_reclaim_schedule', { what: 'oversized' }],
    ['vcfops_reclaim_schedule', { what: 'powered-off' }],
    ['vcfops_webhook_payload', { destination: 'servicenow' }],
    ['vcfops_maintenance_window', { alert_on_overrun: false }],
    ['vcfops_policy_toggle', { direction: 'disable' }],
    ['vcfops_content_backup', { runner: 'powershell' }],
    ['vcfops_access', { scope_objects: '' }],
  ];

  for (const [id, values] of variants) {
    it(`${id} ${JSON.stringify(values)}: builds, parses, ES5, secrets empty, named in IMPORT.md`, () => {
      const files = build(id, values);
      const pkgs = own(files);
      expect(pkgs.length).toBeGreaterThanOrEqual(1);
      const problems: string[] = [];
      for (const { dir, spec } of pkgs) {
        expect(spec.name.startsWith('com.archtoolkit.vcfops.')).toBe(true);
        expect(files['IMPORT.md']!.includes(`import/${dir}`)).toBe(true);
        expect(spec.workflows.length).toBe(1);
        for (const a of spec.actions) problems.push(...es5Problems(a.script, `${dir}/${a.name}`));
        for (const w of spec.workflows) {
          const script = [...w.xml.matchAll(/<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/g)].map((m) => [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join(''));
          expect(script.length).toBe(1);
          problems.push(...es5Problems(script[0]!, `${dir}/${w.name}`));
        }
        for (const config of spec.configs) {
          const secrets = config.attributes.filter((a) => a.type === 'SecureString');
          expect(secrets.some((a) => a.name === 'opsPassword')).toBe(true);
          for (const secret of secrets) expect(secret.value).toBe(undefined);
        }
        for (const r of spec.resources) if (r.name.endsWith('.json')) JSON.parse(r.content);
      }
      expect(problems).toEqual([]);
      // The central component comes first; the fallback script is still there.
      expect(files['IMPORT.md']!.indexOf('Import the two Orchestrator packages')).toBeGreaterThan(0);
      expect(Object.keys(files).some((path) => path.startsWith('scripts/'))).toBe(true);
    });
  }

  it('a changing workflow has the dryRun input and is a dry run in its settings; a reading one has neither', () => {
    for (const id of CHANGING) {
      const { spec } = own(build(id))[0]!;
      expect(spec.workflows[0]!.xml.includes('<param name="dryRun" type="boolean"')).toBe(true);
      expect(spec.configs[0]!.attributes.find((a) => a.name === 'dryRun')?.value).toBe(true);
      expect(typeof spec.configs[0]!.attributes.find((a) => a.name === 'cap')?.value).toBe('number');
    }
    for (const id of [...READING, 'reclaim-oversized']) {
      const files = id === 'reclaim-oversized' ? build('vcfops_reclaim_schedule', { what: 'oversized' }) : build(id);
      const { spec } = own(files)[0]!;
      expect(spec.workflows[0]!.xml.includes('name="dryRun"')).toBe(false);
      expect(spec.configs[0]!.attributes.some((a) => a.name === 'dryRun')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The fake suite API and the runner

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const API = '/suite-api/api/';
/** A route on /suite-api/api/<path>, with any query string. */
const at = (method: string, path: string, body?: unknown, status?: number): FakeRoute => ({ method, path: `^${esc(API + path)}(\\?.*)?$`, ...(body !== undefined ? { body } : {}), ...(status ? { status } : {}) });
/** A paged list, one page. */
const list = (path: string, key: string, items: readonly unknown[]): FakeRoute => at('GET', path, { [key]: items, pageInfo: { totalCount: items.length, page: 0, pageSize: 1000 } });
const LOGIN: FakeRoute[] = [at('POST', 'auth/token/acquire', { token: OPS_TOKEN, validity: 0 }), at('POST', 'auth/token/release', '')];
const HOOK: FakeRoute = { method: 'POST', path: '^/hook$', body: {} };

interface Run {
  readonly result: WorkflowRun;
  readonly requests: FakeRequest[];
  /** Every call, METHOD path without the query. */
  readonly calls: string[];
  /** Every call that changes something: not a GET, a login, a documented POST-for-query or the audit webhook. */
  readonly writes: string[];
  readonly body: (method: string, path: string, index?: number) => unknown;
}

const servers: FakeServer[] = [];
after(() => servers.forEach((server) => server.stop()));

async function run(
  files: Record<string, string>,
  routes: readonly FakeRoute[],
  settings: Record<string, unknown> | ((host: string) => Record<string, unknown>) = {},
  inputs: Record<string, unknown> = {},
  workflow?: RegExp,
): Promise<Run> {
  const server = await startFakeServer([...LOGIN, ...routes]);
  servers.push(server);
  const host = `127.0.0.1:${server.port}`;
  const pkgs = own(files);
  const pick = workflow ? pkgs.find((p) => workflow.test(p.spec.workflows[0]!.name)) : pkgs[0];
  if (!pick) throw new Error('no such workflow');
  const config = pick.spec.configs[0]!;
  const extra = typeof settings === 'function' ? settings(host) : settings;
  const emulator = new VroEmulator(files, { config: { [`${config.categoryPath}/${config.name}`]: { opsHost: host, opsUsername: 'automation', opsPassword: OPS_PASSWORD, ...extra } } });
  const result = emulator.runWorkflow(pick.spec.workflows[0]!.name, inputs);
  const requests = server.requests();
  expect(/do-not-log/.test(logText(result))).toBe(false);
  const bare = (r: FakeRequest) => r.path.split('?')[0]!;
  return {
    result,
    requests,
    calls: requests.map((r) => `${r.method} ${bare(r)}`),
    writes: requests.filter((r) => r.method !== 'GET' && !/\/auth\/token\/(acquire|release)$|\/stats\/latest\/query$|\/alerts\/query$|^\/hook$|\/actions\/[^/]+\/query$/.test(bare(r))).map((r) => `${r.method} ${bare(r)}`),
    body: (method, path, index = 0) => {
      const hit = requests.filter((r) => r.method === method && bare(r) === path)[index];
      if (!hit) throw new Error(`no ${method} ${path}`);
      return JSON.parse(hit.body) as unknown;
    },
  };
}

const ARMED = { dryRun: false };
const dryLines = (r: Run) => r.result.logs.filter((line) => line.message.startsWith('DRY RUN: would ')).length;
const lastIsRelease = (r: Run) => expect(r.calls[r.calls.length - 1]).toBe('POST /suite-api/api/auth/token/release');
const every = (r: Run) => expect(r.requests.every((q) => q.path.includes('/auth/token/acquire') || q.path === '/hook' || !q.path.startsWith('/suite-api/') || q.headers.authorization === `OpsToken ${OPS_TOKEN}`)).toBe(true);

// ---------------------------------------------------------------------------
// Setup

describe('pkg ops-core: vcfops_adapter_instance', { skip: !CURL }, () => {
  const files = build('vcfops_adapter_instance');
  const VC = 'vcenter01.example.com';
  const routes = (o: { adapters?: unknown[]; second?: number } = {}): FakeRoute[] => [
    list('collectorgroups', 'collectorGroups', [{ id: 'cg-1', name: 'Site A collectors' }]),
    list('adapters', 'adapterInstancesInfoDto', o.adapters ?? []),
    list('credentials', 'credentialInstances', []),
    at('POST', 'credentials', { id: 'cred-1' }),
    {
      method: 'POST',
      path: `^${esc(API)}integrations/vcenters$`,
      responses: [
        { status: 400, body: { message: 'The certificate is not trusted', certificates: [{ thumbprint: 'AA:BB:CC:DD', certificateDetails: 'CN=vcenter01', issuedTo: VC }] } },
        { status: o.second ?? 201, body: o.second ? { message: 'no' } : { id: 'ad-1' } },
      ],
    },
    at('PUT', 'adapters/ad-1/monitoringstate/start', ''),
  ];
  const secrets = { vcenterPassword: VC_PASSWORD, vcenterThumbprint: 'aa bb cc dd' };

  it('dry run: reads, plans three changes, writes nothing', async () => {
    const r = await run(files, routes(), secrets);
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual([]);
    expect(dryLines(r)).toBe(3);
  });

  it('armed: credential, integration (the matching certificate accepted on the second POST), then start', async () => {
    const r = await run(files, routes(), { ...secrets, ...ARMED });
    expect(r.result.error).toBe(null);
    expect(r.calls).toEqual([
      'POST /suite-api/api/auth/token/acquire',
      'GET /suite-api/api/collectorgroups',
      'GET /suite-api/api/adapters',
      'GET /suite-api/api/credentials',
      'POST /suite-api/api/credentials',
      'POST /suite-api/api/integrations/vcenters',
      'POST /suite-api/api/integrations/vcenters',
      'PUT /suite-api/api/adapters/ad-1/monitoringstate/start',
      'POST /suite-api/api/auth/token/release',
    ]);
    const credential = r.body('POST', '/suite-api/api/credentials') as { fields: { name: string; value: string }[] };
    expect(credential.fields).toEqual([{ name: 'USER', value: 'svc-vcfops-collect@vsphere.local' }, { name: 'PASSWORD', value: VC_PASSWORD }]);
    const first = r.body('POST', '/suite-api/api/integrations/vcenters', 0) as Record<string, unknown>;
    const second = r.body('POST', '/suite-api/api/integrations/vcenters', 1) as Record<string, unknown>;
    expect(first.certificates).toBe(undefined);
    expect(second.certificates).toEqual([{ thumbprint: 'AA:BB:CC:DD', certificateDetails: 'CN=vcenter01', issuedTo: VC }]);
    expect(second.collectorGroupId).toBe('cg-1');
    expect(second.credentialInstanceId).toBe('cred-1');
    expect(r.result.outputs.adapterInstanceId).toBe('ad-1');
    every(r);
  });

  it('refuses a certificate nobody vouched for: no thumbprint set, it stops after the credential', async () => {
    const r = await run(files, routes(), { vcenterPassword: VC_PASSWORD, ...ARMED });
    expect(r.writes).toEqual(['POST /suite-api/api/credentials', 'POST /suite-api/api/integrations/vcenters']);
    expect(r.result.error ?? '').toContain('Stopped after 1 change(s): create the vCenter integration');
    expect(r.result.error ?? '').toContain('AA:BB:CC:DD');
    lastIsRelease(r);
  });

  it('refuses a certificate whose thumbprint is not the one set', async () => {
    const r = await run(files, routes(), { ...secrets, vcenterThumbprint: '11:22', ...ARMED });
    expect(r.result.error ?? '').toContain('do not match vcenterThumbprint');
    expect(r.writes.filter((w) => w.includes('integrations')).length).toBe(1);
  });

  it('stops at the cap, and at the first failure', async () => {
    const capped = await run(files, routes(), { ...secrets, ...ARMED, cap: 1 });
    expect(capped.writes).toEqual(['POST /suite-api/api/credentials']);
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: create the vCenter integration');
    const failed = await run(files, routes({ second: 500 }), { ...secrets, ...ARMED });
    expect(failed.result.error ?? '').toContain('Stopped after 1 change(s): create the vCenter integration for vcenter01.example.com failed');
    expect(failed.writes.includes('PUT /suite-api/api/adapters/ad-1/monitoringstate/start')).toBe(false);
    lastIsRelease(failed);
  });

  it('leaves a vCenter that is already collected alone', async () => {
    const r = await run(files, routes({ adapters: [{ id: 'old', resourceKey: { name: 'VC', resourceIdentifiers: [{ identifierType: { name: 'VCURL' }, value: VC }] } }] }), { ...secrets, ...ARMED });
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual([]);
    expect(r.result.outputs.adapterInstanceId).toBe('old');
  });
});

describe('pkg ops-core: vcfops_outbound_plugin', { skip: !CURL }, () => {
  const files = build('vcfops_outbound_plugin');
  const routes = (test = 200, existing: unknown[] = []): FakeRoute[] => [
    list('alertplugins', 'notificationPluginInstances', existing),
    at('POST', 'alertplugins', { pluginId: 'pl-1' }),
    at('POST', 'alertplugins/pl-1/test', test === 200 ? {} : { message: 'SMTP refused' }, test),
    at('PUT', 'alertplugins/pl-1/enable/true', ''),
  ];

  it('dry run writes nothing', async () => {
    const r = await run(files, routes());
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual([]);
    expect(dryLines(r)).toBe(3);
  });

  it('armed: creates, tests, then enables', async () => {
    const r = await run(files, routes(), ARMED);
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual(['POST /suite-api/api/alertplugins', 'POST /suite-api/api/alertplugins/pl-1/test', 'PUT /suite-api/api/alertplugins/pl-1/enable/true']);
    expect(r.requests[1]!.path).toBe('/suite-api/api/alertplugins?pluginTypeId=StandardEmailPlugin&page=0&pageSize=1000');
    expect(r.body('POST', '/suite-api/api/alertplugins')).toEqual({
      pluginTypeId: 'StandardEmailPlugin',
      name: 'Platform team mail relay',
      configValues: [
        { name: 'SMTP_HOST', value: 'smtp.example.com' },
        { name: 'SMTP_PORT', value: '587' },
        { name: 'IS_SECURE_CONNECTION', value: 'true' },
        { name: 'senderEmailAddress', value: 'vcf-operations@example.com' },
        { name: 'senderName', value: 'VCF Operations' },
      ],
    });
    expect(r.result.outputs.pluginId).toBe('pl-1');
  });

  it('a failed test stops the run before it is enabled; the cap stops before the test', async () => {
    const failed = await run(files, routes(500), ARMED);
    expect(failed.writes).toEqual(['POST /suite-api/api/alertplugins', 'POST /suite-api/api/alertplugins/pl-1/test']);
    expect(failed.result.error ?? '').toContain('Stopped after 1 change(s): test outbound instance');
    lastIsRelease(failed);
    const capped = await run(files, routes(), { ...ARMED, cap: 1 });
    expect(capped.writes).toEqual(['POST /suite-api/api/alertplugins']);
    expect(capped.result.error ?? '').toContain('Cap reached');
  });

  it('leaves an instance of the same name alone', async () => {
    const r = await run(files, routes(200, [{ pluginId: 'pl-0', name: 'Platform team mail relay' }]), ARMED);
    expect(r.writes).toEqual([]);
    expect(r.result.outputs.pluginId).toBe('pl-0');
  });

  it('tests and enables an instance of the same name that exists but is disabled, when testAndEnable is on (regression)', async () => {
    const disabled = [{ pluginId: 'pl-1', name: 'Platform team mail relay', enabled: false }];
    const dry = await run(files, routes(200, disabled));
    expect(dry.result.error).toBe(null);
    expect(dry.writes).toEqual([]);
    expect(dryLines(dry)).toBe(2);
    const r = await run(files, routes(200, disabled), ARMED);
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual(['POST /suite-api/api/alertplugins/pl-1/test', 'PUT /suite-api/api/alertplugins/pl-1/enable/true']);
    expect(r.result.outputs.pluginId).toBe('pl-1');
    // A failed test leaves it disabled.
    const failed = await run(files, routes(500, disabled), ARMED);
    expect(failed.writes).toEqual(['POST /suite-api/api/alertplugins/pl-1/test']);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): test outbound instance');
    // Enabled, or testAndEnable off: left as it is.
    const enabled = await run(files, routes(200, [{ ...disabled[0], enabled: true }]), ARMED);
    expect(enabled.writes).toEqual([]);
    const off = await run(files, routes(200, disabled), { ...ARMED, testAndEnable: false });
    expect(off.writes).toEqual([]);
  });
});

describe('pkg ops-core: vcfops_access', { skip: !CURL }, () => {
  const files = build('vcfops_access');
  const routes = (o: { groups?: unknown[]; status?: number } = {}): FakeRoute[] => [
    list('auth/sources', 'sources', [{ id: 'src-1', name: 'Corporate AD' }]),
    list('auth/usergroups', 'userGroups', []),
    at('GET', 'auth/traversalspecs', { specs: [{ name: 'Custom Groups' }] }),
    list('resources/groups', 'groups', o.groups ?? [{ id: 'g-pay', resourceKey: { name: 'Payments VMs' } }]),
    at('POST', 'auth/usergroups', o.status ? { message: 'no' } : { id: 'ug-1' }, o.status),
  ];

  it('dry run writes nothing', async () => {
    const r = await run(files, routes());
    expect(r.writes).toEqual([]);
    expect(dryLines(r)).toBe(1);
  });

  it('armed: resolves every name to an id, then imports the group once', async () => {
    const r = await run(files, routes(), ARMED);
    expect(r.result.error).toBe(null);
    expect(r.calls).toEqual([
      'POST /suite-api/api/auth/token/acquire',
      'GET /suite-api/api/auth/sources',
      'GET /suite-api/api/auth/usergroups',
      'GET /suite-api/api/auth/traversalspecs',
      'GET /suite-api/api/resources/groups',
      'POST /suite-api/api/auth/usergroups',
      'POST /suite-api/api/auth/token/release',
    ]);
    const grant = r.body('POST', '/suite-api/api/auth/usergroups') as { authSourceId: string; name: string; 'role-permissions': { roleName: string; allowAllObjects: boolean; 'traversal-spec-instances': { name: string; resourceSelection: { resourceId: string[] }[] }[] }[] };
    expect(grant.authSourceId).toBe('src-1');
    expect(grant.name).toBe('APP-Payments-Ops');
    expect(grant['role-permissions'][0]!.roleName).toBe('ReadOnly');
    expect(grant['role-permissions'][0]!['traversal-spec-instances'][0]!.name).toBe('Custom Groups');
    expect(grant['role-permissions'][0]!['traversal-spec-instances'][0]!.resourceSelection[0]!.resourceId).toEqual(['g-pay']);
    expect(r.result.outputs.userGroupId).toBe('ug-1');
  });

  it('grants nothing when a scope group is missing; stops at the cap and at a failure', async () => {
    const missing = await run(files, routes({ groups: [] }), ARMED);
    expect(missing.writes).toEqual([]);
    expect(missing.result.error ?? '').toContain('No custom group named "Payments VMs"');
    const capped = await run(files, routes(), { ...ARMED, cap: 0 });
    expect(capped.writes).toEqual([]);
    expect(capped.result.error ?? '').toContain('Cap reached: 0 change(s) made, the cap is 0');
    const failed = await run(files, routes({ status: 500 }), ARMED);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): import user group');
    lastIsRelease(failed);
  });
});

// ---------------------------------------------------------------------------
// Operations

describe('pkg ops-core: vcfops_notify_webhook', { skip: !CURL }, () => {
  const files = build('vcfops_notify_webhook');
  const ENDPOINT = 'https://runbooks.example.com/hooks/vcfops';
  const routes = (o: { rules?: unknown[]; status?: number } = {}): FakeRoute[] => [
    list('alertplugins', 'notificationPluginInstances', [
      { pluginId: 'wh-0', name: 'Other hook', configValues: [{ name: 'Url', value: 'https://elsewhere.example.com/' }] },
      { pluginId: 'wh-1', name: 'Runbook hook', configValues: [{ name: 'Url', value: ENDPOINT }] },
    ]),
    list('notifications/rules', 'rules', o.rules ?? []),
    at('POST', 'notifications/rules', o.status ? { message: 'no' } : { id: 'rule-1' }, o.status),
  ];

  // endpoint is a SecureString (typed after import), so each run sets it.
  const HOOK = { endpoint: ENDPOINT };

  it('dry run writes nothing', async () => {
    const r = await run(files, routes(), HOOK);
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual([]);
  });

  it('armed: finds the outbound instance by its URL and creates the rule, enabled, through it', async () => {
    const r = await run(files, routes(), { ...HOOK, ...ARMED });
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual(['POST /suite-api/api/notifications/rules']);
    expect(r.body('POST', '/suite-api/api/notifications/rules')).toEqual({
      name: 'Critical infrastructure to runbook',
      alertControlStates: ['OPEN'],
      alertStatuses: ['NEW', 'UPDATED', 'CANCELED'],
      criticalities: ['CRITICAL', 'IMMEDIATE'],
      resourceKindFilters: [
        { adapterKind: 'VMWARE', resourceKind: 'HostSystem' },
        { adapterKind: 'VMWARE', resourceKind: 'Datastore' },
        { adapterKind: 'VMWARE', resourceKind: 'ClusterComputeResource' },
      ],
      enabled: true,
      pluginId: 'wh-1',
    });
    expect(r.result.outputs.ruleId).toBe('rule-1');
    every(r);
  });

  it('leaves a rule of the same name alone; stops at the cap and at a failure', async () => {
    const existing = await run(files, routes({ rules: [{ id: 'rule-0', name: 'Critical infrastructure to runbook' }] }), { ...HOOK, ...ARMED });
    expect(existing.writes).toEqual([]);
    const capped = await run(files, routes(), { ...HOOK, ...ARMED, cap: 0 });
    expect(capped.result.error ?? '').toContain('Cap reached');
    expect(capped.writes).toEqual([]);
    const failed = await run(files, routes({ status: 422 }), { ...HOOK, ...ARMED });
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): create notification rule');
    lastIsRelease(failed);
  });

  it('refuses when no outbound instance posts to the endpoint, naming only its host', async () => {
    const r = await run(files, [list('alertplugins', 'notificationPluginInstances', [])], { ...HOOK, ...ARMED });
    expect(r.result.error ?? '').toContain('No webhook outbound instance posts to https://runbooks.example.com');
    // The endpoint is a SecureString: a webhook's path can be its secret.
    expect(r.result.error ?? '').not.toContain('/hooks/vcfops');
    expect(r.writes).toEqual([]);
  });

  it('keeps the endpoint a SecureString with no value (regression: it was a plain string carrying the URL)', () => {
    const attrs = readPackageSpec(packagesIn(files)[Object.keys(packagesIn(files)).find((d) => d !== 'com.archtoolkit.core.package')!]!).configs[0]!.attributes;
    const endpoint = attrs.find((a) => a.name === 'endpoint');
    expect(endpoint?.type).toBe('SecureString');
    expect(endpoint?.value).toBe(undefined);
  });
});

describe('pkg ops-core: vcfops_scope_group', { skip: !CURL }, () => {
  const files = build('vcfops_scope_group');
  const routes = (o: { failed?: string[]; groups?: unknown[] } = {}): FakeRoute[] => [
    list('policies', 'policySummaries', [{ id: 'p-prod', name: 'Production Policy' }]),
    list('resources/groups', 'groups', o.groups ?? []),
    at('POST', 'resources/groups', { id: 'grp-1' }),
    at('PUT', 'policies/p-prod/assign', { assignedGroupIds: o.failed ? [] : ['grp-1'], failedGroupIds: o.failed ?? [] }),
  ];

  it('dry run writes nothing', async () => {
    const r = await run(files, routes());
    expect(r.writes).toEqual([]);
    expect(dryLines(r)).toBe(2);
  });

  it('armed: creates the group, then assigns it with PUT policies/{id}/assign', async () => {
    const r = await run(files, routes(), ARMED);
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual(['POST /suite-api/api/resources/groups', 'PUT /suite-api/api/policies/p-prod/assign']);
    const group = r.body('POST', '/suite-api/api/resources/groups') as { resourceKey: { name: string }; policy?: string; membershipDefinition: { rules: { propertyConditionRules: unknown[] }[] } };
    expect(group.resourceKey.name).toBe('Automation — safe to act on');
    expect(group.policy).toBe(undefined);
    expect(group.membershipDefinition.rules[0]!.propertyConditionRules.length).toBe(2);
    expect(r.body('PUT', '/suite-api/api/policies/p-prod/assign')).toEqual({ groupIds: ['grp-1'] });
    expect(r.result.outputs.groupId).toBe('grp-1');
  });

  it('stops at the cap before the assignment, and fails when the assignment is refused', async () => {
    const capped = await run(files, routes(), { ...ARMED, cap: 1 });
    expect(capped.writes).toEqual(['POST /suite-api/api/resources/groups']);
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: assign');
    const failed = await run(files, routes({ failed: ['grp-1'] }), ARMED);
    expect(failed.result.error ?? '').toContain('Stopped after 1 change(s): assign');
    lastIsRelease(failed);
    const existing = await run(files, routes({ groups: [{ id: 'grp-0', resourceKey: { name: 'Automation — safe to act on' } }] }), ARMED);
    expect(existing.writes).toEqual([]);
  });
});

describe('pkg ops-core: vcfops_reclaim_schedule', { skip: !CURL }, () => {
  const stat = (id: string, key: string, value: number, on = 1) => ({ resourceId: id, 'stat-list': { stat: [{ statKey: { key }, data: [value - 1, value] }, { statKey: { key: 'sys|poweredOn' }, data: [on] }] } });
  const routes = (key: string, o: { populate?: unknown } = {}): FakeRoute[] => [
    list('resources/groups', 'groups', [{ id: 'grp-9', resourceKey: { name: 'Automation — safe to act on' } }]),
    list('resources/groups/grp-9/members', 'resourceList', [
      { identifier: 'vm-1', resourceKey: { name: 'app1', resourceKindKey: 'VirtualMachine' } },
      { identifier: 'vm-2', resourceKey: { name: 'app2', resourceKindKey: 'VirtualMachine' } },
      { identifier: 'vm-3', resourceKey: { name: 'app3', resourceKindKey: 'VirtualMachine' } },
      { identifier: 'vm-4', resourceKey: { name: 'app4', resourceKindKey: 'VirtualMachine' } },
      { identifier: 'h-1', resourceKey: { name: 'esx1', resourceKindKey: 'HostSystem' } },
    ]),
    at('POST', 'resources/stats/latest/query', { values: [stat('vm-1', key, 40), stat('vm-2', key, 90), stat('vm-3', key, 10), { resourceId: 'vm-4', 'stat-list': { stat: [] } }] }),
    at('POST', 'actions/act-1/query', o.populate ?? { actionExecution: { actionId: 'act-1', parameters: ['populated'] } }),
    at('POST', 'actions/act-1', { values: ['task-1'] }),
  ];
  const files = build('vcfops_reclaim_schedule');
  const KEY = 'diskspace|snapshot|age';

  it('dry run: lists the matches largest first and runs nothing', async () => {
    const r = await run(files, routes(KEY), { actionId: 'act-1' });
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual([]);
    expect(r.calls.includes('POST /suite-api/api/actions/act-1/query')).toBe(false);
    expect(JSON.parse(String(r.result.outputs.matchesJson))).toEqual([{ id: 'vm-2', name: 'app2', value: 90 }, { id: 'vm-1', name: 'app1', value: 40 }]);
    expect(r.body('POST', '/suite-api/api/resources/stats/latest/query')).toEqual({ resourceId: ['vm-1', 'vm-2', 'vm-3', 'vm-4'], statKey: [KEY, 'sys|poweredOn'], maxSamples: 1 });
  });

  it('armed: populates, then runs, the action on each match in order, sending the populated body back', async () => {
    const r = await run(files, routes(KEY), { actionId: 'act-1', ...ARMED });
    expect(r.result.error).toBe(null);
    expect(r.calls.filter((c) => c.includes('/actions/'))).toEqual(['POST /suite-api/api/actions/act-1/query', 'POST /suite-api/api/actions/act-1', 'POST /suite-api/api/actions/act-1/query', 'POST /suite-api/api/actions/act-1']);
    expect(r.body('POST', '/suite-api/api/actions/act-1/query', 0)).toEqual({ contextResourceId: ['vm-2'] });
    expect(r.body('POST', '/suite-api/api/actions/act-1/query', 1)).toEqual({ contextResourceId: ['vm-1'] });
    expect(r.body('POST', '/suite-api/api/actions/act-1', 0)).toEqual({ actionId: 'act-1', parameters: ['populated'] });
    expect((JSON.parse(String(r.result.outputs.summary)) as { changes: unknown[] }).changes.length).toBe(2);
  });

  it('acts on at most cap objects, largest first; stops at the first object it cannot populate', async () => {
    const capped = await run(files, routes(KEY), { actionId: 'act-1', ...ARMED, cap: 1 });
    expect(capped.result.error).toBe(null);
    expect(capped.writes).toEqual(['POST /suite-api/api/actions/act-1']);
    expect(capped.body('POST', '/suite-api/api/actions/act-1/query')).toEqual({ contextResourceId: ['vm-2'] });
    expect(capped.result.logs.some((l) => l.level === 'warn' && l.message.includes('only the first 1 are acted on'))).toBe(true);
    const failed = await run(files, routes(KEY, { populate: {} }), { actionId: 'act-1', ...ARMED });
    expect(failed.writes).toEqual([]);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): run Delete Unused Snapshots for VM on app2 (vm-2) failed: the action could not be populated for vm-2');
    lastIsRelease(failed);
  });

  it('refuses to act without an action id', async () => {
    const r = await run(files, routes(KEY), ARMED);
    expect(r.result.error ?? '').toContain('Set actionId');
    expect(r.writes).toEqual([]);
  });

  it('powered-off: only VMs that are off now, and only with a statKey set', async () => {
    const off = build('vcfops_reclaim_schedule', { what: 'powered-off', older_than: 1 });
    const none = await run(off, routes('sm|off'), { actionId: 'act-1' });
    expect(none.result.error ?? '').toContain('Set statKey');
    const offRoutes = routes('sm|off');
    offRoutes[2] = at('POST', 'resources/stats/latest/query', { values: [stat('vm-1', 'sm|off', 5000, 0), stat('vm-2', 'sm|off', 9000, 1)] });
    const r = await run(off, offRoutes, { actionId: 'act-1', statKey: 'sm|off' });
    expect(JSON.parse(String(r.result.outputs.matchesJson))).toEqual([{ id: 'vm-1', name: 'app1', value: 5000 }]);
  });

  it('oversized is a report: GETs and the stats query only', async () => {
    const report = build('vcfops_reclaim_schedule', { what: 'oversized' });
    const r = await run(report, routes('summary|oversized'), { threshold: 1 });
    expect(r.result.error).toBe(null);
    expect(r.requests.filter((q) => q.method !== 'GET' && !q.path.includes('/auth/token/')).map((q) => q.path)).toEqual(['/suite-api/api/resources/stats/latest/query']);
    expect(r.result.outputs.matchCount).toBe(3);
  });
});

describe('pkg ops-core: vcfops_maintenance_window', { skip: !CURL }, () => {
  const files = build('vcfops_maintenance_window');
  const routes = (o: { existing?: unknown[]; status?: number } = {}): FakeRoute[] => [
    list('maintenanceschedules', 'schedules', o.existing ?? []),
    at('POST', 'maintenanceschedules', o.status ? { message: 'no' } : { id: 'ms-1' }, o.status),
  ];
  const TZ = { timeZone: 'Europe/Amsterdam' };

  it('dry run writes nothing; without a time zone it refuses', async () => {
    const r = await run(files, routes(), TZ);
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual([]);
    expect(dryLines(r)).toBe(1);
    const noZone = await run(files, routes(), ARMED);
    expect(noZone.result.error ?? '').toContain('Set timeZone');
    expect(noZone.writes).toEqual([]);
  });

  it('armed: creates the schedule once, in the time zone set', async () => {
    const r = await run(files, routes(), { ...TZ, ...ARMED });
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual(['POST /suite-api/api/maintenanceschedules']);
    expect(r.requests[1]!.path).toBe('/suite-api/api/maintenanceschedules?name=Monthly%20patching&page=0&pageSize=1000');
    expect(r.body('POST', '/suite-api/api/maintenanceschedules')).toEqual({
      key: 'Monthly patching',
      schedule: { scheduleType: 'MONTHLY', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], weeksOfTheMonth: ['THIRD'], daysOfTheWeek: ['SATURDAY'], hour: 22, minuteOfTheHour: 0, duration: 360, timeZone: 'Europe/Amsterdam' },
    });
    expect(r.result.outputs.scheduleId).toBe('ms-1');
    const existing = await run(files, routes({ existing: [{ id: 'ms-0', key: 'Monthly patching' }] }), { ...TZ, ...ARMED });
    expect(existing.writes).toEqual([]);
  });

  it('stops at the cap and at a failure', async () => {
    const capped = await run(files, routes(), { ...TZ, ...ARMED, cap: 0 });
    expect(capped.writes).toEqual([]);
    expect(capped.result.error ?? '').toContain('Cap reached');
    const failed = await run(files, routes({ status: 500 }), { ...TZ, ...ARMED });
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): create maintenance schedule "Monthly patching" failed');
    lastIsRelease(failed);
  });

  it('the overrun check reads only, and fails the run (webhook first) when anything is still in maintenance', async () => {
    const clean = await run(files, [list('resources', 'resourceList', [])], {}, {}, /overrun/);
    expect(clean.result.error).toBe(null);
    expect(clean.result.outputs.inMaintenance).toBe(0);
    expect(clean.requests.every((q) => q.method === 'GET' || q.path.includes('/auth/token/'))).toBe(true);
    expect(clean.requests[1]!.path).toBe('/suite-api/api/resources?resourceState=MAINTAINED&resourceState=MAINTAINED_MANUAL&page=0&pageSize=1000');
    const stuck = await run(files, [list('resources', 'resourceList', [{ identifier: 'h-1', resourceKey: { name: 'esx1', resourceKindKey: 'HostSystem' } }]), HOOK], (host) => ({ webhook: `https://${host}/hook` }), {}, /overrun/);
    expect(stuck.result.error ?? '').toContain('1 object(s) still in maintenance');
    expect(stuck.calls.includes('POST /hook')).toBe(true);
    expect(stuck.result.logs.some((l) => l.message.includes('STILL IN MAINTENANCE: HostSystem esx1 h-1'))).toBe(true);
  });

  it('without the overrun check there is one package', () => {
    expect(own(build('vcfops_maintenance_window', { alert_on_overrun: false })).length).toBe(1);
    expect(own(files).length).toBe(2);
  });
});

describe('pkg ops-core: vcfops_capacity_report', { skip: !CURL }, () => {
  const files = build('vcfops_capacity_report');
  const routes = (o: { schedules?: unknown[]; status?: number; resources?: unknown[] } = {}): FakeRoute[] => [
    list('reportdefinitions', 'reportDefinitions', [{ id: 'rd-1', name: 'Cluster capacity' }]),
    list('resources', 'resourceList', o.resources ?? [{ identifier: 'res-1', resourceKey: { name: 'vSphere World' } }, { identifier: 'res-2', resourceKey: { name: 'vSphere World 2' } }]),
    list('reportdefinitions/rd-1/schedules', 'reportSchedules', o.schedules ?? []),
    at('POST', 'reportdefinitions/rd-1/schedules', o.status ? { message: 'no' } : { id: 'sch-1' }, o.status),
  ];
  const SET = { startDate: '10/01/2026', timeZone: 'Europe/Amsterdam' };

  it('dry run writes nothing; without a start date in MM/DD/YYYY it refuses', async () => {
    const r = await run(files, routes(), SET);
    expect(r.writes).toEqual([]);
    expect(dryLines(r)).toBe(1);
    const bad = await run(files, routes(), { startDate: '2026-10-01', ...ARMED });
    expect(bad.result.error ?? '').toContain('MM/DD/YYYY');
    expect(bad.writes).toEqual([]);
  });

  it('armed: schedules it for the one object, in the time zone (X-Ops-API-Timezone)', async () => {
    const r = await run(files, routes(), { ...SET, ...ARMED });
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual(['POST /suite-api/api/reportdefinitions/rd-1/schedules']);
    expect(r.body('POST', '/suite-api/api/reportdefinitions/rd-1/schedules')).toEqual({
      reportDefinitionId: 'rd-1',
      resourceId: ['res-1'],
      reportScheduleType: 'MONTHLY',
      recurrence: 1,
      dayOfTheMonth: 1,
      startDate: '10/01/2026',
      startHour: 7,
      startMinute: 0,
      emailAddresses: ['platform-team@example.com'],
      relativePath: [],
    });
    const post = r.requests.find((q) => q.method === 'POST' && q.path.endsWith('/schedules'))!;
    expect(post.headers['x-ops-api-timezone']).toBe('Europe/Amsterdam');
    expect(r.result.outputs.scheduleId).toBe('sch-1');
  });

  it('leaves the same schedule alone; stops at the cap and at a failure; refuses an ambiguous object', async () => {
    const same = await run(files, routes({ schedules: [{ id: 'sch-0', reportScheduleType: 'MONTHLY', recurrence: 1, resourceId: ['res-1'], emailAddresses: ['platform-team@example.com'] }] }), { ...SET, ...ARMED });
    expect(same.writes).toEqual([]);
    const capped = await run(files, routes(), { ...SET, ...ARMED, cap: 0 });
    expect(capped.result.error ?? '').toContain('Cap reached');
    const failed = await run(files, routes({ status: 500 }), { ...SET, ...ARMED });
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): schedule "Cluster capacity"');
    lastIsRelease(failed);
    const twice = await run(files, routes({ resources: [{ identifier: 'a', resourceKey: { name: 'vSphere World' } }, { identifier: 'b', resourceKey: { name: 'vSphere World' } }] }), { ...SET, ...ARMED });
    expect(twice.result.error ?? '').toContain('2 objects are named "vSphere World"');
    expect(twice.writes).toEqual([]);
  });
});

describe('pkg ops-core: vcfops_policy_toggle', { skip: !CURL }, () => {
  const A = 'AlertDefinition-VMWARE-DatastoreUsage';
  const B = 'AlertDefinition-VMWARE-HostMemContentionManyVMs';
  const routes = (o: { missing?: boolean; status?: number; verb?: string } = {}): FakeRoute[] => [
    list('policies', 'policySummaries', [{ id: 'p-7', name: 'Production Policy' }]),
    at('GET', `alertdefinitions/${A}`, { id: A }),
    o.missing ? at('GET', `alertdefinitions/${B}`, { message: 'not found' }, 404) : at('GET', `alertdefinitions/${B}`, { id: B }),
    at('PUT', `alertdefinitions/${A}/${o.verb ?? 'enable'}`, o.status ? { message: 'no' } : '', o.status),
    at('PUT', `alertdefinitions/${B}/${o.verb ?? 'enable'}`, ''),
  ];
  const files = build('vcfops_policy_toggle');

  it('dry run writes nothing', async () => {
    const r = await run(files, routes());
    expect(r.writes).toEqual([]);
    expect(dryLines(r)).toBe(2);
  });

  it('armed: checks everything exists, then enables each alert in the policy by id', async () => {
    const r = await run(files, routes(), ARMED);
    expect(r.result.error).toBe(null);
    expect(r.requests.filter((q) => q.method === 'PUT').map((q) => q.path)).toEqual([`/suite-api/api/alertdefinitions/${A}/enable?policyId=p-7`, `/suite-api/api/alertdefinitions/${B}/enable?policyId=p-7`]);
    expect(r.calls.indexOf(`GET /suite-api/api/alertdefinitions/${B}`)).toBeLessThan(r.calls.indexOf(`PUT /suite-api/api/alertdefinitions/${A}/enable`));
    expect(JSON.parse(String(r.result.outputs.changedIds))).toEqual([A, B]);
    const off = await run(build('vcfops_policy_toggle', { direction: 'disable' }), routes({ verb: 'disable' }), ARMED);
    expect(off.writes).toEqual([`PUT /suite-api/api/alertdefinitions/${A}/disable`, `PUT /suite-api/api/alertdefinitions/${B}/disable`]);
  });

  it('changes nothing when an alert definition does not exist; stops at the cap and at a failure', async () => {
    const missing = await run(files, routes({ missing: true }), ARMED);
    expect(missing.writes).toEqual([]);
    expect(missing.result.error ?? '').toContain(`No alert definition ${B}; nothing was changed`);
    const capped = await run(files, routes(), { ...ARMED, cap: 1 });
    expect(capped.writes).toEqual([`PUT /suite-api/api/alertdefinitions/${A}/enable`]);
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made');
    const failed = await run(files, routes({ status: 500 }), ARMED);
    expect(failed.writes).toEqual([`PUT /suite-api/api/alertdefinitions/${A}/enable`]);
    expect(failed.result.error ?? '').toContain(`Stopped after 0 change(s): enable ${A}`);
    lastIsRelease(failed);
  });
});

// ---------------------------------------------------------------------------
// Content

describe('pkg ops-core: vcfops_alert_action', { skip: !CURL }, () => {
  const ALERT = 'AlertDefinition-VMWARE-VMSnapshotsOld';
  const files = build('vcfops_alert_action');
  const routes = (o: { actions?: unknown[]; put?: number } = {}): FakeRoute[] => [
    at('GET', `alertdefinitions/${ALERT}`, { id: ALERT, name: 'VM has old snapshots', states: [{ severity: 'AUTO', recommendationPriorityMap: { 'Recommendation-X': 1 } }] }),
    list('actiondefinitions', 'actionDefinitions', o.actions ?? [{ id: 'a-off', displayName: 'Power Off VM', actionAdapterKindKey: 'VMWARE' }, { id: 'a-snap', displayName: 'Delete Unused Snapshots for VM', actionAdapterKindKey: 'VMWARE' }]),
    list('recommendations', 'recommendations', []),
    at('POST', 'recommendations', { id: 'rec-1' }),
    at('PUT', 'alertdefinitions', o.put ? { message: 'built-in' } : '', o.put),
  ];

  it('dry run writes nothing', async () => {
    const r = await run(files, routes());
    expect(r.writes).toEqual([]);
    expect(dryLines(r)).toBe(2);
  });

  it('armed: the recommendation in the 9.x shape (targetMethod, the action adapter kind looked up), then added to the alert', async () => {
    const r = await run(files, routes(), ARMED);
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual(['POST /suite-api/api/recommendations', 'PUT /suite-api/api/alertdefinitions']);
    expect(r.body('POST', '/suite-api/api/recommendations')).toEqual({
      description: 'Run DeleteUnusedSnapshotsForVM on the object that raised the alert. Automated in "Automation — non-production" only.',
      action: { targetAdapterKindId: 'VMWARE', targetResourceKindId: 'VirtualMachine', targetMethod: 'DeleteUnusedSnapshotsForVM', actionAdapterKindId: 'VMWARE' },
    });
    const alert = r.body('PUT', '/suite-api/api/alertdefinitions') as { id: string; states: { recommendationPriorityMap: Record<string, number> }[] };
    expect(alert.id).toBe(ALERT);
    expect(alert.states[0]!.recommendationPriorityMap).toEqual({ 'Recommendation-X': 1, 'rec-1': 2 });
    expect(r.result.outputs.recommendationId).toBe('rec-1');
  });

  it('refuses when the action is not listed (actions not enabled); stops at the cap and at a failure', async () => {
    const none = await run(files, routes({ actions: [] }), ARMED);
    expect(none.result.error ?? '').toContain('No action definition is named "Delete Unused Snapshots for VM"');
    expect(none.writes).toEqual([]);
    const capped = await run(files, routes(), { ...ARMED, cap: 1 });
    expect(capped.writes).toEqual(['POST /suite-api/api/recommendations']);
    expect(capped.result.error ?? '').toContain('Cap reached');
    const failed = await run(files, routes({ put: 403 }), ARMED);
    expect(failed.result.error ?? '').toContain('Stopped after 1 change(s): add the recommendation to alert definition');
    lastIsRelease(failed);
  });
});

describe('pkg ops-core: vcfops_super_metric', { skip: !CURL }, () => {
  const files = build('vcfops_super_metric');
  const routes = (o: { existing?: unknown[]; status?: number } = {}): FakeRoute[] => [
    list('supermetrics', 'superMetrics', o.existing ?? []),
    at('POST', 'supermetrics', o.status ? { message: 'no' } : { id: 'sm-1' }, o.status),
  ];

  it('dry run writes nothing; armed creates it with name, formula and description only', async () => {
    const dry = await run(files, routes());
    expect(dry.writes).toEqual([]);
    const r = await run(files, routes(), ARMED);
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual(['POST /suite-api/api/supermetrics']);
    expect(r.requests[1]!.path.startsWith('/suite-api/api/supermetrics?name=Cluster%20%E2%80%94%20worst%20VM%20CPU%20ready%20%25&')).toBe(true);
    expect(r.body('POST', '/suite-api/api/supermetrics')).toEqual({
      name: 'Cluster — worst VM CPU ready %',
      formula: 'max(${adaptertype=VMWARE, objecttype=VirtualMachine, metric=cpu|readyPct, depth=2})',
      description: 'Generated by ArchToolKit. The worst VM, not the average one — the average hides the VM that is actually suffering.',
    });
    expect(r.result.outputs.superMetricId).toBe('sm-1');
  });

  it('leaves one of the same name alone (and says when its formula differs); stops at the cap and at a failure', async () => {
    const existing = await run(files, routes({ existing: [{ id: 'sm-0', name: 'Cluster — worst VM CPU ready %', formula: 'avg(1)' }] }), ARMED);
    expect(existing.writes).toEqual([]);
    expect(existing.result.logs.some((l) => l.level === 'warn' && l.message.includes('avg(1)'))).toBe(true);
    const capped = await run(files, routes(), { ...ARMED, cap: 0 });
    expect(capped.result.error ?? '').toContain('Cap reached');
    const failed = await run(files, routes({ status: 500 }), ARMED);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): create super metric');
    lastIsRelease(failed);
  });
});

describe('pkg ops-core: vcfops_workload_policy', { skip: !CURL }, () => {
  const files = build('vcfops_workload_policy');
  const routes = (o: { groups?: unknown[]; failed?: string[] } = {}): FakeRoute[] => [
    list('policies', 'policySummaries', [{ id: 'p-def', name: 'Default Policy' }]),
    list('resources/groups', 'groups', o.groups ?? [{ id: 'g-1', resourceKey: { name: 'Tier 1 VMs' } }, { id: 'g-2', resourceKey: { name: 'Tier 1 hosts' } }]),
    at('POST', 'policies', { id: 'p-new' }),
    at('PUT', 'policies/p-new/assign', { assignedGroupIds: [], failedGroupIds: o.failed ?? [] }),
  ];

  it('dry run writes nothing', async () => {
    const r = await run(files, routes());
    expect(r.writes).toEqual([]);
    expect(dryLines(r)).toBe(2);
  });

  it('armed: creates it under its parent, then assigns both groups', async () => {
    const r = await run(files, routes(), ARMED);
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual(['POST /suite-api/api/policies', 'PUT /suite-api/api/policies/p-new/assign']);
    const created = r.body('POST', '/suite-api/api/policies') as { name: string; parentPolicy: string; description: string };
    expect(created.name).toBe('Tier 1 production');
    expect(created.parentPolicy).toBe('p-def');
    expect(created.description).toContain('Capacity model allocation, buffer 20%');
    expect(r.body('PUT', '/suite-api/api/policies/p-new/assign')).toEqual({ groupIds: ['g-1', 'g-2'] });
    expect(r.result.outputs.createdId).toBe('p-new');
  });

  it('creates nothing when a group is missing; stops at the cap and when an assignment fails', async () => {
    const missing = await run(files, routes({ groups: [{ id: 'g-1', resourceKey: { name: 'Tier 1 VMs' } }] }), ARMED);
    expect(missing.writes).toEqual([]);
    expect(missing.result.error ?? '').toContain('No custom group named Tier 1 hosts');
    const capped = await run(files, routes(), { ...ARMED, cap: 1 });
    expect(capped.writes).toEqual(['POST /suite-api/api/policies']);
    const failed = await run(files, routes({ failed: ['g-2'] }), ARMED);
    expect(failed.result.error ?? '').toContain('Stopped after 1 change(s): assign');
    lastIsRelease(failed);
  });
});

describe('pkg ops-core: vcfops_webhook_payload', { skip: !CURL }, () => {
  const routes = (o: { status?: number; incidents?: unknown[] } = {}): FakeRoute[] => [
    list('notifications/templates', 'notificationTemplates', []),
    at('POST', 'notifications/templates', o.status ? { message: 'no' } : { templateId: 't-1' }, o.status),
    { method: 'GET', path: '^/api/now/table/incident\\?', body: { result: o.incidents ?? [] } },
    { method: 'POST', path: '^/api/now/table/incident$', body: { result: { number: 'INC0001', sys_id: 'x' } } },
  ];

  it('runbook: dry run writes nothing; armed creates the WebhookPlugin template with the body as its payload', async () => {
    const files = build('vcfops_webhook_payload');
    const dry = await run(files, routes());
    expect(dry.writes).toEqual([]);
    const r = await run(files, routes(), ARMED);
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual(['POST /suite-api/api/notifications/templates']);
    const template = r.body('POST', '/suite-api/api/notifications/templates') as { pluginTypeId: string; templateType: string; formattingTemplate: { type: string; newAlertTemplate: { method: string; payload: string } } };
    expect(template.pluginTypeId).toBe('WebhookPlugin');
    expect(template.templateType).toBe('ALERT');
    expect(template.formattingTemplate.type).toBe('WEBHOOK_TEMPLATE');
    expect(template.formattingTemplate.newAlertTemplate.method).toBe('POST');
    expect((JSON.parse(template.formattingTemplate.newAlertTemplate.payload) as { symptoms: string }).symptoms).toBe('${SYMPTOMS}');
    expect(r.result.outputs.templateId).toBe('t-1');
    const capped = await run(files, routes(), { ...ARMED, cap: 0 });
    expect(capped.result.error ?? '').toContain('Cap reached');
    const failed = await run(files, routes({ status: 500 }), ARMED);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): create payload template');
    lastIsRelease(failed);
  });

  it('ServiceNow sample: checks for an open incident with its correlation_id, then posts once with Basic authentication', async () => {
    const files = build('vcfops_webhook_payload', { destination: 'servicenow' });
    const sn = (host: string) => ({ endpoint: `http://${host}/api/now/table/incident`, sendSample: true, receiverUsername: 'sn-integration', receiverPassword: SN_PASSWORD });
    const dry = await run(files, routes(), sn);
    expect(dry.writes).toEqual([]);
    const r = await run(files, routes(), (host) => ({ ...sn(host), ...ARMED }));
    expect(r.result.error).toBe(null);
    expect(r.writes).toEqual(['POST /suite-api/api/notifications/templates', 'POST /api/now/table/incident']);
    const check = r.requests.find((q) => q.method === 'GET' && q.path.startsWith('/api/now/'))!;
    expect(decodeURIComponent(check.path)).toContain('sysparm_query=correlation_id=sample-0000^active=true');
    const post = r.requests.find((q) => q.method === 'POST' && q.path === '/api/now/table/incident')!;
    expect(post.headers.authorization).toBe(`Basic ${btoa(`sn-integration:${SN_PASSWORD}`)}`);
    expect((JSON.parse(post.body) as { correlation_id: string; assignment_group: string }).assignment_group).toBe('Platform Operations');
    const open = await run(files, routes({ incidents: [{ number: 'INC0000' }] }), (host) => ({ ...sn(host), ...ARMED }));
    expect(open.result.error ?? '').toContain('Open incident INC0000 already has correlation_id sample-0000');
    expect(open.writes).toEqual(['POST /suite-api/api/notifications/templates']);
  });
});

describe('pkg ops-core: vcfops_compliance (reads only)', { skip: !CURL }, () => {
  const files = build('vcfops_compliance');
  const routes = (defs?: unknown[]): FakeRoute[] => [
    list('alertdefinitions', 'alertDefinitions', defs ?? [
      { id: 'ad-1', name: 'ESXi host is violating VCF 9.x Security Configuration Guide', subType: 21 },
      { id: 'ad-2', name: 'ESXi host is violating PCI DSS', subType: 21 },
      { id: 'ad-3', name: 'VCF 9 Security Configuration Guide trend', subType: 19 },
    ]),
    list('resources/groups', 'groups', [{ id: 'g-prod', resourceKey: { name: 'Production hosts' } }]),
    list('resources/groups/g-prod/members', 'resourceList', [{ identifier: 'h-1', resourceKey: { name: 'esx1' } }, { identifier: 'h-2', resourceKey: { name: 'esx2' } }]),
    at('POST', 'alerts/query', { alerts: [{ alertId: 'al-1', resourceId: 'h-1', alertDefinitionName: 'ESXi host is violating VCF 9.x Security Configuration Guide' }, { alertId: 'al-9', resourceId: 'elsewhere', alertDefinitionName: 'x' }], pageInfo: { totalCount: 2 } }),
    at('GET', 'alerts/contributingsymptoms', { contributingSymptoms: [{ alertId: 'al-1', symptomSets: [{ symptoms: [{ symptomDefinitionId: 'sd-2' }, { symptomDefinitionId: 'sd-1' }] }] }] }),
    at('GET', 'symptomdefinitions', { symptomDefinitions: [{ id: 'sd-1', name: 'SSH is enabled' }, { id: 'sd-2', name: 'Lockdown mode is off' }] }),
    HOOK,
  ];

  it('reports the group members that fail, with their failing rules; GETs and the alert query only; fails above the threshold', async () => {
    const r = await run(files, routes(), (host) => ({ webhook: `https://${host}/hook` }));
    expect(r.result.error ?? '').toContain('1 object(s) fail VCF 9.x Security Configuration Guide v1.0, above the threshold of 0');
    expect(r.requests.filter((q) => q.method !== 'GET' && !q.path.includes('/auth/token/')).map((q) => q.path.split('?')[0])).toEqual(['/suite-api/api/alerts/query', '/hook']);
    expect(r.body('POST', '/suite-api/api/alerts/query')).toEqual({ activeOnly: true, alertDefinitionId: ['ad-1'] });
    const report = JSON.parse(String(r.result.outputs.reportJson)) as unknown;
    expect(report).toEqual({ benchmark: 'VCF 9.x Security Configuration Guide v1.0', objects: [{ resourceId: 'h-1', resource: 'esx1', alerts: ['ESXi host is violating VCF 9.x Security Configuration Guide'], failingRules: ['Lockdown mode is off', 'SSH is enabled'] }] });
    expect(JSON.parse(r.requests.find((q) => q.path === '/hook')!.body)).toEqual(report);
    expect(r.result.outputs.failingCount).toBe(1);
  });

  it('under the threshold it completes; no matching definition is an error, not "compliant"', async () => {
    const ok = await run(files, routes(), { maxFailing: 5 });
    expect(ok.result.error).toBe(null);
    const none = await run(files, routes([{ id: 'x', name: 'Something else', subType: 21 }]), { maxFailing: 5 });
    expect(none.result.error ?? '').toContain('Nothing to report on is not the same as compliant');
  });
});

describe('pkg ops-core: vcfops_content_backup (reads only)', { skip: !CURL }, () => {
  const files = build('vcfops_content_backup');
  const routes = (hook = true): FakeRoute[] => [
    list('alertdefinitions', 'alertDefinitions', [{ id: 'ad-1' }, { id: 'ad-2' }]),
    list('symptomdefinitions', 'symptomDefinitions', [{ id: 'sd-1' }]),
    list('recommendations', 'recommendations', []),
    list('supermetrics', 'superMetrics', [{ id: 'sm-1', formula: 'x' }]),
    list('resources/groups', 'groups', [{ id: 'g-1' }]),
    list('policies', 'policySummaries', [{ id: 'p-1', name: 'Default Policy' }]),
    ...(hook ? [HOOK] : []),
  ];

  it('reads every type whole, returns it, and posts it', async () => {
    const r = await run(files, routes(), (host) => ({ webhook: `https://${host}/hook` }));
    expect(r.result.error).toBe(null);
    expect(r.requests.filter((q) => q.method !== 'GET' && !q.path.includes('/auth/token/')).map((q) => q.path)).toEqual(['/hook']);
    const backup = JSON.parse(String(r.result.outputs.backupJson)) as { environment: string; counts: Record<string, number>; content: { superMetrics: unknown[] } };
    expect(backup.environment).toBe('production');
    expect(backup.counts).toEqual({ alertDefinitions: 2, symptomDefinitions: 1, recommendations: 0, superMetrics: 1, groups: 1, policySummaries: 1 });
    expect(backup.content.superMetrics).toEqual([{ id: 'sm-1', formula: 'x' }]);
    expect((JSON.parse(r.requests.find((q) => q.path === '/hook')!.body) as { counts: unknown }).counts).toEqual(backup.counts);
  });

  it('fails when the backup is not delivered, or a list cannot be read whole', async () => {
    const undelivered = await run(files, routes(false), (host) => ({ webhook: `https://${host}/hook` }));
    expect(undelivered.result.error ?? '').toContain('NOT delivered');
    const truncated = routes();
    // A first page, then an empty one, with a total above what was served: a truncated list.
    truncated[0] = { method: 'GET', path: `^${esc(API)}alertdefinitions\\?`, responses: [{ body: { alertDefinitions: [{ id: 'ad-1' }], pageInfo: { totalCount: 5 } } }, { body: { alertDefinitions: [], pageInfo: { totalCount: 5 } } }] };
    const partial = await run(files, truncated);
    expect(partial.result.error ?? '').toContain('refusing to act on a partial list');
  });
});

describe('pkg ops-core: vcfops_self_health (reads only)', { skip: !CURL }, () => {
  const files = build('vcfops_self_health', { ignore_adapters: 'Known off' });
  const now = Date.now();
  const routes = (o: { collector?: string; stale?: boolean } = {}): FakeRoute[] => [
    at('GET', 'deployment/node/status', { status: 'ONLINE' }),
    at('GET', 'collectors', { collector: [{ name: 'cp-1', state: o.collector ?? 'UP' }] }),
    at('GET', 'adapters', {
      adapterInstancesInfoDto: [
        { id: 'a-1', resourceKey: { name: 'vc01' }, lastCollected: o.stale ? now - 3 * 3600_000 : now - 60_000 },
        { id: 'a-2', resourceKey: { name: 'Known off' }, lastCollected: now - 99 * 3600_000 },
        { id: 'a-3', resourceKey: { name: 'vc02' }, lastCollected: now - 60_000, numberOfResourcesCollected: 42 },
      ],
    }),
    HOOK,
  ];

  it('healthy: reads only, completes', async () => {
    const r = await run(files, routes());
    expect(r.result.error).toBe(null);
    expect(r.result.outputs.healthy).toBe(true);
    expect(r.requests.every((q) => q.method === 'GET' || q.path.includes('/auth/token/'))).toBe(true);
  });

  it('a collector down and a silent adapter fail the run, after posting the problems', async () => {
    const r = await run(files, routes({ collector: 'DOWN', stale: true }), (host) => ({ webhook: `https://${host}/hook` }));
    expect(r.result.error ?? '').toContain('VCF Operations: 2 problem(s)');
    const posted = JSON.parse(r.requests.find((q) => q.path === '/hook')!.body) as { problems: string[] };
    expect(posted.problems).toEqual(['collector cp-1 is DOWN', 'adapter vc01 has not collected for more than 30 minutes']);
    expect(r.result.outputs.healthy).toBe(false);
  });
});
