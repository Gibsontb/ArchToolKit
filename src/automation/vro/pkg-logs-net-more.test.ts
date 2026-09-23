/**
 * The Logs and Networks groundwork automations, as Orchestrator packages:
 * built, parsed, ES5, and run in the emulator against fake endpoints.
 *
 *   vcflog_content_pack   9.1 log management through VCF Operations: the pack's
 *                         saved query via /suite-api/api/logs/queryconfigs
 *   vcflog_forwarding     standalone 8.18 / 9.0 appliance: /api/v2/log-forwarder
 *   vcflog_agent_group    standalone appliance: /api/v2/agent/groups (VERIFY route)
 *   vcflog_retention      standalone appliance: /api/v2/partitions, /api/v2/archiving
 *   vcfnet_data_sources   Networks: /api/ni/data-sources/<type>
 *   vcfnet_applications   Networks: /api/ni/groups/applications and tiers
 *   vcfnet_intent_check   Networks, read-only: POST /api/ni/search
 *
 * Every changing one: a dry run writes nothing, armed makes exactly the
 * expected calls in order with the right bodies, what exists is left alone,
 * the cap and the first failure stop it, and no secret reaches a log.
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

function build(id: string, overrides: BlueprintValues = {}): Record<string, string> {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`no blueprint ${id}`);
  return { ...blueprint.build({ ...defaultValues(blueprint), ...overrides }, id).files };
}

interface Built {
  readonly files: Record<string, string>;
  readonly dir: string;
  readonly spec: VroPackageSpec;
  readonly workflow: string;
  readonly configKey: string;
}

function built(id: string, overrides: BlueprintValues = {}): Built {
  const files = build(id, overrides);
  const packages = packagesIn(files);
  const dir = Object.keys(packages).find((d) => d !== 'com.archtoolkit.core.package')!;
  const spec = readPackageSpec(packages[dir]!);
  return { files, dir, spec, workflow: spec.workflows[0]!.name, configKey: `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}` };
}

/** The package builds and parses, every script is ES5, secrets are empty SecureStrings, IMPORT.md names it. */
function checkPackage(b: Built, prefix: string, secrets: readonly string[]): void {
  expect(b.spec.name.startsWith(prefix)).toBe(true);
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
  expect(attributes.filter((a) => a.type === 'SecureString').map((a) => a.name).sort()).toEqual([...secrets].sort());
  for (const a of attributes.filter((x) => x.type === 'SecureString')) expect(a.value === undefined || a.value === '').toBe(true);
  expect(b.files['IMPORT.md']!.includes(`import/${b.dir}`)).toBe(true);
  expect(b.files['IMPORT.md']!.startsWith('# Importing this into ')).toBe(true);
  // The emulator loads it (and rejects anything beyond ES5 again).
  new VroEmulator(b.files);
}

/** Every line any run logged, its outputs and its error: where a secret must never be. */
function logText(run: WorkflowRun): string {
  return run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');
}

const servers: FakeServer[] = [];
after(() => servers.forEach((s) => s.stop()));

interface Ran {
  readonly result: WorkflowRun;
  readonly requests: FakeRequest[];
  readonly host: string;
  /** Every request that is not a login, logout, list, search query or the webhook. */
  readonly writes: string[];
}

const NOT_A_WRITE = /\/auth\/token(\/(acquire|release))?$|^\/api\/v2\/sessions$|^\/api\/ni\/search$|^\/hook$/;

async function run(b: Built, routes: readonly FakeRoute[], settings: (host: string) => Record<string, unknown>, inputs: Record<string, unknown> = {}): Promise<Ran> {
  const server = await startFakeServer([...routes, { method: 'POST', path: '^/hook$', body: {} }]);
  servers.push(server);
  const host = `127.0.0.1:${server.port}`;
  const emulator = new VroEmulator(b.files, { config: { [b.configKey]: settings(host) } });
  const result = emulator.runWorkflow(b.workflow, inputs);
  const requests = server.requests();
  expect(/do-not-log/.test(logText(result))).toBe(false);
  return { result, requests, host, writes: requests.filter((r) => r.method !== 'GET' && !NOT_A_WRITE.test(r.path.split('?')[0]!)).map((r) => `${r.method} ${r.path.split('?')[0]}`) };
}

const seq = (requests: FakeRequest[]) => requests.map((r) => `${r.method} ${r.path.split('?')[0]}`);
const bodyOf = (requests: FakeRequest[], method: string, path: string): unknown => JSON.parse(requests.find((r) => r.method === method && r.path.split('?')[0] === path)!.body);
const resource = (b: Built, name: string): unknown => JSON.parse(b.spec.resources.find((r) => r.name === name)!.content);

// ---------------------------------------------------------------------------
// Secrets and the fake logins

const OPS_PASSWORD = 'Ops-Pa55-do-not-log';
const OPS_TOKEN = 'ops-token-do-not-log';
const LOGS_PASSWORD = 'Logs-Pa55-do-not-log';
const LOGS_SESSION = 'logs-session-do-not-log';
const NET_PASSWORD = 'Net-Pa55-do-not-log';
const NET_TOKEN = 'net-token-do-not-log';
const SOURCE_PASSWORD = 'Vc-Source-Pa55-do-not-log';

const OPS_LOGIN: FakeRoute[] = [
  { method: 'POST', path: '^/suite-api/api/auth/token/acquire$', body: { token: OPS_TOKEN, validity: 0 } },
  { method: 'POST', path: '^/suite-api/api/auth/token/release$', body: '' },
];
const LOGS_LOGIN: FakeRoute[] = [{ method: 'POST', path: '^/api/v2/sessions$', body: { userId: 'u1', sessionId: LOGS_SESSION, ttl: 1800 } }];
const NET_LOGIN: FakeRoute[] = [
  { method: 'POST', path: '^/api/ni/auth/token$', body: { token: NET_TOKEN, expiry: 0 } },
  { method: 'DELETE', path: '^/api/ni/auth/token$', status: 200, body: '' },
];

const opsSettings = (extra: Record<string, unknown> = {}) => (host: string) => ({ opsHost: host, opsUsername: 'automation', opsPassword: OPS_PASSWORD, ...extra });
const logsSettings = (extra: Record<string, unknown> = {}) => (host: string) => ({ logsHost: host, logsUsername: 'admin', logsPassword: LOGS_PASSWORD, ...extra });
const netSettings = (extra: Record<string, unknown> = {}) => (host: string) => ({ netHost: host, netUsername: 'admin@local', netPassword: NET_PASSWORD, ...extra });

// ---------------------------------------------------------------------------
// vcflog_content_pack — 9.1 log management through VCF Operations

describe('pkg logs-net-more: vcflog_content_pack (9.1, queryconfigs)', { skip: !CURL }, () => {
  const b = built('vcflog_content_pack');
  const wanted = resource(b, 'queryconfig.json') as { name: string };
  const routes = (o: { existing?: unknown[]; postStatus?: number } = {}): FakeRoute[] => [
    ...OPS_LOGIN,
    { method: 'GET', path: '^/suite-api/api/logs/queryconfigs\\?', body: { pageInfo: { totalCount: (o.existing ?? []).length, page: 0, pageSize: 1000 }, logsQueryConfigs: o.existing ?? [] } },
    { method: 'POST', path: '^/suite-api/api/logs/queryconfigs$', status: o.postStatus ?? 201, body: o.postStatus ? { message: `refused for ${OPS_PASSWORD}` } : { id: 'qc-1', name: wanted.name } },
  ];

  it('is one package: workflow, settings with the password empty, the saved query, and the .vlcp kept', () => {
    checkPackage(b, 'com.archtoolkit.logs.contentpack.', ['opsPassword']);
    expect(b.spec.configs[0]!.attributes.find((a) => a.name === 'dryRun')?.value).toBe(true);
    expect(Object.keys(resource(b, 'queryconfig.json') as object).join(',')).toBe('name,description,queryText,dateRange,queryFilters');
    expect(Object.keys(b.files).some((p) => /^import\/[^/]+\.vlcp$/.test(p))).toBe(true);
    expect(b.files['scripts/apply.sh']!.includes('cd "$(dirname "$0")/.."')).toBe(true);
    expect(b.files['IMPORT.md']!.includes('VCF 9.1 log management')).toBe(true);
  });

  it('dry run by default: reads the saved queries, creates nothing', async () => {
    const { result, writes } = await run(b, routes(), opsSettings());
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(result.logs.some((l) => l.message === `DRY RUN: would create saved query "${wanted.name}"`)).toBe(true);
    expect(result.outputs.queryConfigId).toBe('');
  });

  it('armed: login, list, create the saved query with the resource as body, logout', async () => {
    const { result, requests } = await run(b, routes(), opsSettings({ dryRun: false }), { dryRun: false });
    expect(result.error).toBe(null);
    expect(seq(requests)).toEqual(['POST /suite-api/api/auth/token/acquire', 'GET /suite-api/api/logs/queryconfigs', 'POST /suite-api/api/logs/queryconfigs', 'POST /suite-api/api/auth/token/release']);
    expect(bodyOf(requests, 'POST', '/suite-api/api/logs/queryconfigs')).toEqual(wanted);
    expect(requests.slice(1).every((r) => r.headers.authorization === `OpsToken ${OPS_TOKEN}`)).toBe(true);
    expect(result.outputs.queryConfigId).toBe('qc-1');
  });

  it('leaves a saved query of the same name alone and returns its id', async () => {
    const { result, writes } = await run(b, routes({ existing: [{ id: 'qc-old', name: wanted.name }] }), opsSettings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(result.outputs.queryConfigId).toBe('qc-old');
  });

  it('stops at the cap', async () => {
    const { result, writes } = await run(b, routes(), opsSettings({ dryRun: false, cap: 0 }));
    expect(writes).toEqual([]);
    expect(result.error ?? '').toContain('Cap reached: 0 change(s) made, the cap is 0');
  });

  it('stops at the failure, says what failed, still logs out, and never logs the password', async () => {
    const { result, requests } = await run(b, routes({ postStatus: 500 }), opsSettings({ dryRun: false }));
    expect(result.error ?? '').toContain('Stopped after 0 change(s): create saved query');
    expect(result.error ?? '').toContain('/suite-api/api/logs/queryconfigs returned HTTP 500');
    expect(requests[requests.length - 1]!.path).toBe('/suite-api/api/auth/token/release');
  });
});

// ---------------------------------------------------------------------------
// vcflog_forwarding — standalone 8.18 / 9.0 appliance

describe('pkg logs-net-more: vcflog_forwarding (standalone appliance)', { skip: !CURL }, () => {
  const b = built('vcflog_forwarding');
  const wanted = resource(b, 'forwarder.json') as { name: string; host: string; port: number };
  const routes = (o: { existing?: unknown; postStatus?: number } = {}): FakeRoute[] => [
    ...LOGS_LOGIN,
    { method: 'GET', path: '^/api/v2/log-forwarder$', body: o.existing ?? [] },
    { method: 'POST', path: '^/api/v2/log-forwarder$', status: o.postStatus ?? 201, body: o.postStatus ? { errorMessage: `bad ${LOGS_PASSWORD}` } : { id: 'fwd-1' } },
  ];

  it('is one package with its own appliance login, the body kept as import/ JSON', () => {
    checkPackage(b, 'com.archtoolkit.logs.forwarding.', ['logsPassword']);
    expect(b.spec.actions.map((a) => a.name).sort()).toEqual(['itemsOf', 'loginLogs', 'logsApi']);
    const importJson = Object.keys(b.files).find((p) => p.startsWith('import/') && p.endsWith('.json'))!;
    expect(JSON.parse(b.files[importJson]!)).toEqual(wanted);
    // The API root: port 9543 unless the host names one.
    const module = new VroEmulator(b.files).module(b.spec.name) as { logsApi: (h: string) => string };
    expect(module.logsApi('logs.example.com')).toBe('https://logs.example.com:9543/api/v2');
    expect(module.logsApi('logs.example.com:443')).toBe('https://logs.example.com:443/api/v2');
  });

  it('dry run: logs in and lists, creates nothing', async () => {
    const { result, writes, requests } = await run(b, routes(), logsSettings());
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(seq(requests)).toEqual(['POST /api/v2/sessions', 'GET /api/v2/log-forwarder']);
    expect(result.logs.some((l) => l.message.startsWith(`DRY RUN: would create log forwarder "${wanted.name}"`))).toBe(true);
  });

  it('armed: session, list, one POST with the forwarder body, the session as bearer', async () => {
    const { result, requests } = await run(b, routes(), logsSettings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(seq(requests)).toEqual(['POST /api/v2/sessions', 'GET /api/v2/log-forwarder', 'POST /api/v2/log-forwarder']);
    expect(bodyOf(requests, 'POST', '/api/v2/sessions')).toEqual({ username: 'admin', password: LOGS_PASSWORD, provider: 'Local' });
    expect(bodyOf(requests, 'POST', '/api/v2/log-forwarder')).toEqual(wanted);
    expect(requests.slice(1).every((r) => r.headers.authorization === `Bearer ${LOGS_SESSION}`)).toBe(true);
    expect(result.outputs.forwarderId).toBe('fwd-1');
  });

  it('leaves a forwarder of the same name alone, and says how it differs', async () => {
    const { result, writes } = await run(b, routes({ existing: { forwarders: [{ id: 'fwd-old', name: wanted.name, host: wanted.host, port: 514 }] } }), logsSettings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(result.logs.some((l) => l.level === 'warn' && l.message.includes('differs in port'))).toBe(true);
    expect(result.outputs.forwarderId).toBe('fwd-old');
  });

  it('refuses to act on a list it cannot read', async () => {
    const { result, writes } = await run(b, routes({ existing: { total: 3 } }), logsSettings({ dryRun: false }));
    expect(writes).toEqual([]);
    expect(result.error ?? '').toContain('refusing to act on it');
  });

  it('stops at the cap and at the first failure, without the password in the error', async () => {
    const capped = await run(b, routes(), logsSettings({ dryRun: false, cap: 0 }));
    expect(capped.writes).toEqual([]);
    expect(capped.result.error ?? '').toContain('Cap reached');
    const failed = await run(b, routes({ postStatus: 500 }), logsSettings({ dryRun: false }));
    expect(failed.writes).toEqual(['POST /api/v2/log-forwarder']);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): create log forwarder');
  });
});

// ---------------------------------------------------------------------------
// vcflog_agent_group — standalone appliance, unpublished route

describe('pkg logs-net-more: vcflog_agent_group (standalone appliance)', { skip: !CURL }, () => {
  const b = built('vcflog_agent_group');
  const wanted = resource(b, 'agent-group.json') as { name: string };
  const routes = (o: { list?: unknown; listStatus?: number; postStatus?: number } = {}): FakeRoute[] => [
    ...LOGS_LOGIN,
    { method: 'GET', path: '^/api/v2/agent/groups$', status: o.listStatus ?? 200, body: o.list ?? [] },
    { method: 'POST', path: '^/api/v2/agent/groups$', status: o.postStatus ?? 200, body: { name: wanted.name } },
  ];

  it('is one package: the group body and liagent.ini as resources, the INI kept under import/', () => {
    checkPackage(b, 'com.archtoolkit.logs.agentgroup.', ['logsPassword']);
    expect(b.spec.resources.map((r) => r.name).sort()).toEqual(['agent-group.json', 'liagent.ini']);
    expect(b.spec.resources.find((r) => r.name === 'liagent.ini')!.content).toBe(b.files['import/liagent.ini']!);
  });

  it('dry run creates nothing', async () => {
    const { result, writes } = await run(b, routes(), logsSettings());
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(result.logs.some((l) => l.message.startsWith(`DRY RUN: would create agent group "${wanted.name}"`))).toBe(true);
  });

  it('armed: one POST with the group body', async () => {
    const { result, requests } = await run(b, routes(), logsSettings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(seq(requests)).toEqual(['POST /api/v2/sessions', 'GET /api/v2/agent/groups', 'POST /api/v2/agent/groups']);
    expect(bodyOf(requests, 'POST', '/api/v2/agent/groups')).toEqual(wanted);
  });

  it('leaves a group of the same name alone', async () => {
    const { result, writes } = await run(b, routes({ list: { groups: [{ name: wanted.name }] } }), logsSettings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
  });

  it('stops before changing anything when the appliance has no such route', async () => {
    const { result, writes } = await run(b, routes({ listStatus: 404 }), logsSettings({ dryRun: false }));
    expect(writes).toEqual([]);
    expect(result.error ?? '').toContain('no agent group API at /api/v2/agent/groups');
  });

  it('stops at the first failure', async () => {
    const { result, writes } = await run(b, routes({ postStatus: 500 }), logsSettings({ dryRun: false }));
    expect(writes).toEqual(['POST /api/v2/agent/groups']);
    expect(result.error ?? '').toContain('Stopped after 0 change(s)');
  });
});

// ---------------------------------------------------------------------------
// vcflog_retention — standalone appliance; irreversible, so never edits

describe('pkg logs-net-more: vcflog_retention (standalone appliance)', { skip: !CURL }, () => {
  const b = built('vcflog_retention');
  const partition = resource(b, 'partition.json') as { name: string; retentionPeriod: number };
  const archive = resource(b, 'archive.json') as { archiveUri: string };
  const routes = (o: { partitions?: unknown; partitionsStatus?: number; archiving?: unknown; postStatus?: number } = {}): FakeRoute[] => [
    ...LOGS_LOGIN,
    { method: 'GET', path: '^/api/v2/partitions$', status: o.partitionsStatus ?? 200, body: o.partitions ?? [] },
    { method: 'GET', path: '^/api/v2/archiving$', body: o.archiving ?? { enabled: false } },
    { method: 'POST', path: '^/api/v2/partitions$', status: o.postStatus ?? 200, body: {} },
    { method: 'PUT', path: '^/api/v2/archiving$', body: {} },
  ];

  it('is one package with the partition and archive bodies; without an archive, only the partition', () => {
    checkPackage(b, 'com.archtoolkit.logs.retention.', ['logsPassword']);
    expect(b.spec.configs[0]!.attributes.find((a) => a.name === 'cap')?.value).toBe(2);
    const plain = built('vcflog_retention', { archive: '', retention_days: 400 });
    expect(plain.spec.resources.map((r) => r.name)).toEqual(['partition.json']);
  });

  it('dry run changes nothing', async () => {
    const { result, writes } = await run(b, routes(), logsSettings());
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would')).length).toBe(2);
  });

  it('armed: creates the partition, then turns on archiving, in that order', async () => {
    const { result, requests } = await run(b, routes(), logsSettings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(seq(requests)).toEqual(['POST /api/v2/sessions', 'GET /api/v2/partitions', 'GET /api/v2/archiving', 'POST /api/v2/partitions', 'PUT /api/v2/archiving']);
    expect(bodyOf(requests, 'POST', '/api/v2/partitions')).toEqual(partition);
    expect(bodyOf(requests, 'PUT', '/api/v2/archiving')).toEqual(archive);
  });

  it('never edits an existing partition or redirects an archive', async () => {
    const { result, writes } = await run(
      b,
      routes({ partitions: [{ name: partition.name, retentionPeriod: 30 }], archiving: { enabled: true, archiveUri: 'nfs://other/export' } }),
      logsSettings({ dryRun: false }),
    );
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    const warns = result.logs.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(warns.some((m) => m.includes('retention of 30 days'))).toBe(true);
    expect(warns.some((m) => m.includes('already on, to nfs://other/export'))).toBe(true);
  });

  it('stops at the cap, and at the first failure before archiving', async () => {
    const capped = await run(b, routes(), logsSettings({ dryRun: false, cap: 1 }));
    expect(capped.writes).toEqual(['POST /api/v2/partitions']);
    expect(capped.result.error ?? '').toContain('stopping before: turn on archiving');
    const failed = await run(b, routes({ postStatus: 500 }), logsSettings({ dryRun: false }));
    expect(failed.writes).toEqual(['POST /api/v2/partitions']);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): create partition');
  });

  it('stops before changing anything when the appliance has no partitions route', async () => {
    const { result, writes } = await run(b, routes({ partitionsStatus: 404 }), logsSettings({ dryRun: false }));
    expect(writes).toEqual([]);
    expect(result.error ?? '').toContain('no API at /api/v2/partitions');
  });
});

// ---------------------------------------------------------------------------
// vcfnet_data_sources

describe('pkg logs-net-more: vcfnet_data_sources', { skip: !CURL }, () => {
  const b = built('vcfnet_data_sources');
  const PW_WLD = 'pw_vcenter_wld01_example_com';
  const routes = (o: { existing?: string[]; postStatus?: number } = {}): FakeRoute[] => {
    const existing = o.existing ?? ['vcenter-mgmt.example.com'];
    return [
      ...NET_LOGIN,
      { method: 'GET', path: '^/api/ni/infra/nodes$', body: { results: [{ entity_id: 'n1', entity_type: 'NodeInfo' }, { entity_id: 'n2', entity_type: 'NodeInfo' }] } },
      { method: 'GET', path: '^/api/ni/infra/nodes/n1$', body: { entity_id: 'n1', name: 'vcfnet-platform01', node_type: 'PLATFORM_VM' } },
      { method: 'GET', path: '^/api/ni/infra/nodes/n2$', body: { entity_id: 'n2', name: 'vcfnet-collector01', node_type: 'PROXY_VM', proxy_id: 'proxy-2' } },
      { method: 'GET', path: '^/api/ni/data-sources/vcenters$', body: { results: existing.map((_, i) => ({ entity_id: `ds-${i}`, entity_type: 'VCenterDataSource' })) } },
      ...existing.map((fqdn, i) => ({ method: 'GET', path: `^/api/ni/data-sources/vcenters/ds-${i}$`, body: { entity_id: `ds-${i}`, fqdn } })),
      { method: 'POST', path: '^/api/ni/data-sources/vcenters$', status: o.postStatus ?? 201, responses: o.postStatus ? [{ status: o.postStatus, body: { message: `bad credential ${SOURCE_PASSWORD}` } }] : [{ body: { entity_id: 'ds-new-1' } }, { body: { entity_id: 'ds-new-2' } }] },
    ];
  };

  it('is one package: one SecureString per source, IPFIX in the body, the script under scripts/', () => {
    checkPackage(b, 'com.archtoolkit.networks.datasources.', ['netPassword', 'pw_vcenter_mgmt_example_com', PW_WLD]);
    expect((resource(b, 'data-source.json') as { body: unknown }).body).toEqual({ enabled: true, notes: 'Added by ArchToolKit', ipfix_request: { enable_all: true } });
    expect((resource(b, 'sources.json') as { passwordAttribute: string }[]).map((s) => s.passwordAttribute)).toEqual(['pw_vcenter_mgmt_example_com', PW_WLD]);
    expect(b.files['scripts/spec.jq']!.includes('"ipfix_request":{"enable_all":true}')).toBe(true);
    const nsx = built('vcfnet_data_sources', { source_type: 'nsxt' });
    expect((resource(nsx, 'data-source.json') as { body: unknown; path: string }).body).toEqual({ enabled: true, notes: 'Added by ArchToolKit', ipfix_enabled: true });
    const cisco = built('vcfnet_data_sources', { source_type: 'cisco' });
    expect(cisco.spec.configs[0]!.attributes.some((a) => a.name === 'switchType')).toBe(true);
    expect(typeof cisco.files['import/bulk-add-devices.csv']).toBe('string');
  });

  it('dry run: resolves the collector, reads what is there, adds nothing', async () => {
    const { result, writes } = await run(b, routes(), netSettings());
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(result.logs.some((l) => l.message === 'Exists, left as it is: vCenter vcenter-mgmt.example.com (ds-0).')).toBe(true);
    expect(result.logs.some((l) => l.message === 'DRY RUN: would add vCenter data source vcenter-wld01.example.com, with IPFIX')).toBe(true);
  });

  it('armed: adds only the missing source, through the named collector, with its own password and IPFIX on', async () => {
    const { result, requests } = await run(b, routes(), netSettings({ dryRun: false, [PW_WLD]: SOURCE_PASSWORD }));
    expect(result.error).toBe(null);
    expect(seq(requests)).toEqual([
      'POST /api/ni/auth/token',
      'GET /api/ni/infra/nodes',
      'GET /api/ni/infra/nodes/n1',
      'GET /api/ni/infra/nodes/n2',
      'GET /api/ni/data-sources/vcenters',
      'GET /api/ni/data-sources/vcenters/ds-0',
      'POST /api/ni/data-sources/vcenters',
      'DELETE /api/ni/auth/token',
    ]);
    expect(bodyOf(requests, 'POST', '/api/ni/data-sources/vcenters')).toEqual({
      enabled: true,
      notes: 'Added by ArchToolKit',
      ipfix_request: { enable_all: true },
      fqdn: 'vcenter-wld01.example.com',
      nickname: 'vcenter-wld01',
      proxy_id: 'proxy-2',
      credentials: { username: 'svc-vcfnet@vsphere.local', password: SOURCE_PASSWORD },
    });
    expect(bodyOf(requests, 'POST', '/api/ni/auth/token')).toEqual({ username: 'admin@local', password: NET_PASSWORD, domain: { domain_type: 'LOCAL', value: 'local' } });
    expect(requests.slice(1).every((r) => r.headers.authorization === `NetworkInsight ${NET_TOKEN}`)).toBe(true);
    expect(result.outputs.addedIds).toBe('ds-new-1');
  });

  it('refuses to add anything while a password it needs is missing', async () => {
    const { result, writes } = await run(b, routes(), netSettings({ dryRun: false }));
    expect(writes).toEqual([]);
    expect(result.error ?? '').toContain(`Set ${PW_WLD} in the configuration element`);
  });

  it('stops at the cap', async () => {
    const { result, writes } = await run(b, routes({ existing: [] }), netSettings({ dryRun: false, cap: 1, pw_vcenter_mgmt_example_com: SOURCE_PASSWORD, [PW_WLD]: SOURCE_PASSWORD }));
    expect(writes).toEqual(['POST /api/ni/data-sources/vcenters']);
    expect(result.error ?? '').toContain('stopping before: add vCenter data source vcenter-wld01.example.com');
  });

  it('stops at the first failure, logs out, and never shows the source password', async () => {
    const { result, writes, requests } = await run(b, routes({ existing: [], postStatus: 400 }), netSettings({ dryRun: false, pw_vcenter_mgmt_example_com: SOURCE_PASSWORD, [PW_WLD]: SOURCE_PASSWORD }));
    expect(writes).toEqual(['POST /api/ni/data-sources/vcenters']);
    expect(result.error ?? '').toContain('Stopped after 0 change(s): add vCenter data source vcenter-mgmt.example.com');
    expect(result.error ?? '').toContain('returned HTTP 400');
    expect(seq(requests)[requests.length - 1]).toBe('DELETE /api/ni/auth/token');
  });

  it('a switch needs its switch_type before anything is sent', async () => {
    const cisco = built('vcfnet_data_sources', { source_type: 'cisco' });
    const { result, requests } = await run(cisco, routes(), netSettings({ dryRun: false }));
    expect(requests).toEqual([]);
    expect(result.error ?? '').toContain('Set switchType');
  });
});

// ---------------------------------------------------------------------------
// vcfnet_applications

describe('pkg logs-net-more: vcfnet_applications', { skip: !CURL }, () => {
  const b = built('vcfnet_applications');
  const tiers = resource(b, 'tiers.json') as { name: string; group_membership_criteria: { search_membership_criteria: { filter: string } }[] }[];
  const routes = (o: { orders?: boolean; appStatus?: number } = {}): FakeRoute[] => [
    ...NET_LOGIN,
    { method: 'POST', path: '^/api/ni/search$', responses: [{ body: { results: [], total_count: 2 } }, { body: { results: [], total_count: 3 } }, { body: { results: [], total_count: 0 } }] },
    { method: 'GET', path: '^/api/ni/groups/applications$', body: { results: [{ entity_id: 'a1', entity_type: 'Application' }], cursor: 'c2' } },
    { method: 'GET', path: '^/api/ni/groups/applications\\?cursor=c2$', body: { results: [{ entity_id: 'a2', entity_type: 'Application' }] } },
    { method: 'GET', path: '^/api/ni/groups/applications/a1$', body: { entity_id: 'a1', name: 'Payments' } },
    { method: 'GET', path: '^/api/ni/groups/applications/a2$', body: { entity_id: 'a2', name: o.orders ? 'Orders' : 'Billing' } },
    { method: 'GET', path: '^/api/ni/groups/applications/a2/tiers$', body: { results: [{ entity_id: 't-web', name: 'web' }] } },
    { method: 'POST', path: '^/api/ni/groups/applications$', status: o.appStatus ?? 201, body: o.appStatus ? { message: 'no' } : { entity_id: 'app-9', name: 'Orders' } },
    { method: 'POST', path: '^/api/ni/groups/applications/(app-9|a2)/tiers$', responses: [{ body: { entity_id: 't1' } }, { body: { entity_id: 't2' } }, { body: { entity_id: 't3' } }] },
  ];

  it('is one package: the application and tier bodies as resources, kept under import/', () => {
    checkPackage(b, 'com.archtoolkit.networks.application.', ['netPassword']);
    expect(resource(b, 'tiers.json')).toEqual(JSON.parse(b.files['import/tiers.json']!));
    expect(resource(b, 'application.json')).toEqual(JSON.parse(b.files['import/application.json']!));
    expect(b.spec.configs[0]!.attributes.find((a) => a.name === 'cap')?.value).toBe(4);
  });

  it('dry run: counts each tier, follows the cursor, creates nothing', async () => {
    const { result, writes, requests } = await run(b, routes(), netSettings());
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(requests.filter((r) => r.path === '/api/ni/search').map((r) => (JSON.parse(r.body) as { filter: string }).filter)).toEqual(tiers.map((t) => t.group_membership_criteria[0]!.search_membership_criteria.filter));
    expect(result.logs.some((l) => l.level === 'warn' && l.message.startsWith('Tier db matches no VM'))).toBe(true);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would create')).length).toBe(4);
    expect(requests.some((r) => r.path === '/api/ni/groups/applications?cursor=c2')).toBe(true);
    expect(result.outputs.tierCounts).toBe('{"web":2,"app":3,"db":0}');
  });

  it('armed: creates the application, then each tier with its body, in order', async () => {
    const { result, requests, writes } = await run(b, routes(), netSettings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(writes).toEqual(['POST /api/ni/groups/applications', 'POST /api/ni/groups/applications/app-9/tiers', 'POST /api/ni/groups/applications/app-9/tiers', 'POST /api/ni/groups/applications/app-9/tiers']);
    expect(bodyOf(requests, 'POST', '/api/ni/groups/applications')).toEqual({ name: 'Orders' });
    expect(requests.filter((r) => r.path === '/api/ni/groups/applications/app-9/tiers').map((r) => JSON.parse(r.body))).toEqual(tiers);
    expect(result.outputs.applicationId).toBe('app-9');
    expect(seq(requests)[requests.length - 1]).toBe('DELETE /api/ni/auth/token');
  });

  it('an application that exists gets only its missing tiers', async () => {
    const { result, writes, requests } = await run(b, routes({ orders: true }), netSettings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(writes).toEqual(['POST /api/ni/groups/applications/a2/tiers', 'POST /api/ni/groups/applications/a2/tiers']);
    expect(requests.filter((r) => r.path === '/api/ni/groups/applications/a2/tiers' && r.method === 'POST').map((r) => (JSON.parse(r.body) as { name: string }).name)).toEqual(['app', 'db']);
    expect(result.outputs.applicationId).toBe('a2');
  });

  it('stops at the cap, and creates no tier when the application fails', async () => {
    const capped = await run(b, routes(), netSettings({ dryRun: false, cap: 2 }));
    expect(capped.writes).toEqual(['POST /api/ni/groups/applications', 'POST /api/ni/groups/applications/app-9/tiers']);
    expect(capped.result.error ?? '').toContain('Cap reached: 2 change(s) made');
    const failed = await run(b, routes({ appStatus: 500 }), netSettings({ dryRun: false }));
    expect(failed.writes).toEqual(['POST /api/ni/groups/applications']);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): create application "Orders"');
    expect(seq(failed.requests)[failed.requests.length - 1]).toBe('DELETE /api/ni/auth/token');
  });
});

// ---------------------------------------------------------------------------
// vcfnet_intent_check — reads only

describe('pkg logs-net-more: vcfnet_intent_check (read-only)', { skip: !CURL }, () => {
  const b = built('vcfnet_intent_check');
  const counts = (...n: number[]): FakeRoute[] => [...NET_LOGIN, { method: 'POST', path: '^/api/ni/search$', responses: n.map((total_count) => ({ body: { results: [], total_count } })) }];
  const onlyReads = (requests: FakeRequest[]) => requests.every((r) => (r.method === 'POST' && /^\/api\/ni\/(auth\/token|search)$|^\/hook$/.test(r.path)) || (r.method === 'DELETE' && r.path === '/api/ni/auth/token'));

  it('is one package with no dryRun (it reads), the intents as a resource', () => {
    checkPackage(b, 'com.archtoolkit.networks.intentcheck.', ['netPassword']);
    expect(b.spec.workflows[0]!.xml.includes('name="dryRun"')).toBe(false);
    expect(resource(b, 'intents.json')).toEqual(JSON.parse(b.files['scripts/intents.json']!));
  });

  it('matching intent: only the search query, the right filters and window, no violation', async () => {
    // deny: 5 seen, 0 allowed; allow: 10 seen, 0 dropped; allow: 0 seen (no evidence, not strict).
    const { result, requests } = await run(b, counts(5, 0, 10, 0, 0, 0), netSettings({ webhook: '' }));
    expect(result.error).toBe(null);
    expect(onlyReads(requests)).toBe(true);
    expect(result.outputs.problemCount).toBe(0);
    const searches = requests.filter((r) => r.path === '/api/ni/search').map((r) => JSON.parse(r.body) as { entity_type: string; filter: string; time_range: { start_time: number; end_time: number } });
    expect(searches.length).toBe(6);
    expect(searches[0]!.filter).toBe("source_vm.name = 'orders-web01' and destination_vm.name = 'orders-db01'");
    expect(searches[1]!.filter).toBe("source_vm.name = 'orders-web01' and destination_vm.name = 'orders-db01' and firewall_action = 'ALLOW'");
    expect(searches.every((s) => s.entity_type === 'Flow' && s.time_range.end_time - s.time_range.start_time === 24 * 3600)).toBe(true);
    const report = JSON.parse(String(result.outputs.report)) as { verdict: string }[];
    expect(report.map((r) => r.verdict)).toEqual(['enforced', 'ok', 'no evidence']);
  });

  it('violations: posts them to the webhook and fails the run', async () => {
    const { result, requests, host } = await run(b, counts(5, 2, 10, 1, 0, 0), (h) => netSettings({ webhook: `https://${h}/hook` })(h));
    expect(host.length > 0).toBe(true);
    expect(onlyReads(requests)).toBe(true);
    expect(result.outputs.problemCount).toBe(2);
    expect(result.error ?? '').toContain('2 intent violation(s)');
    const hook = JSON.parse(requests.find((r) => r.path === '/hook')!.body) as { problems: string[] };
    expect(hook.problems).toEqual(['orders-web01 -> orders-db01: intended deny, 2 flow(s) allowed by the firewall', 'orders-app01 -> orders-db01: intended allow, 1 flow(s) blocked by the firewall']);
  });

  it('strict: an allow with no flows is a violation; failOnViolation false reports without failing', async () => {
    const strict = built('vcfnet_intent_check', { strict: true });
    const s = await run(strict, counts(5, 0, 10, 0, 0, 0), netSettings({ webhook: '' }));
    expect(s.result.outputs.problemCount).toBe(1);
    expect(s.result.error ?? '').toContain('intended allow, no flows observed');
    const quiet = await run(b, counts(5, 2, 10, 0, 0, 0), netSettings({ webhook: '', failOnViolation: false }));
    expect(quiet.result.error).toBe(null);
    expect(quiet.result.outputs.problemCount).toBe(1);
  });
});
