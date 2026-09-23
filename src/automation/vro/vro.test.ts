/**
 * The Orchestrator packages: built, signed, and run.
 *
 *   - every script in every package is ES5 (Orchestrator's JavaScript);
 *   - every .package built from the blueprints' text files verifies: each file
 *     under signatures/ and each element's content-signature is MD5withRSA
 *     over the right bytes, by the certificate in the package;
 *   - the two reference automations run in the emulator against fake
 *     endpoints in another process, and do exactly what they should: the tag
 *     compliance report reads only and produces the same CSV rows as the bash
 *     script it replaces; the alert workflow creates nothing in a dry run,
 *     creates exactly the four objects in order when armed, passes the ids on,
 *     leaves what exists alone, stops at the cap and at the first failure,
 *     and never logs a secret.
 *
 * vropkg itself (VMware Build Tools) cannot run here — it needs npm — so the
 * byte-for-byte comparison with it is recorded in src/kit/vro-package.ts
 * rather than repeated on every test run.
 */

import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createVerify } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { buildVroPackage, readPackageSpec } from '../../kit/vro-package.ts';
import { automationFor } from '../blueprints/index.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../../testing/fake-rest-server.ts';
import { CORE_ACTIONS, CORE_PACKAGE_DIR } from './core.ts';
import { toPackage } from './to-package.ts';

function build(id: string, overrides: BlueprintValues = {}): Record<string, string> {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`no blueprint ${id}`);
  return { ...blueprint.build({ ...defaultValues(blueprint), ...overrides }, id).files };
}

const has = (tool: string): boolean => {
  try {
    execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
};
const CURL = has('curl');

/** Every line any run logged, for the secret check. */
function logText(run: WorkflowRun): string {
  return run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');
}

// ---------------------------------------------------------------------------

describe('vro: packages are Orchestrator JavaScript', () => {
  it('flags what Rhino-era Orchestrator does not run, and not text inside strings or regexes', () => {
    expect(es5Problems('let a = 1;').length).toBe(1);
    expect(es5Problems('const a = 1;').length).toBe(1);
    expect(es5Problems('var f = (x) => x;').length).toBe(1);
    expect(es5Problems('var s = `x`;').length).toBe(1);
    expect(es5Problems('class A {}').length).toBeGreaterThan(0);
    expect(es5Problems('var a = [...b];').length).toBe(1);
    expect(es5Problems('for (var x of y) {}').length).toBe(1);
    expect(es5Problems('var s = "let x = () => `y`"; var r = /"let "/; // const z')).toEqual([]);
    expect(es5Problems('var x = ;').length).toBe(1);
  });

  it('every action and workflow script in the reference packages is ES5', () => {
    const problems: string[] = [];
    for (const files of [build('tags_compliance'), build('vcfops_alert_definition'), build('vcfops_alert_definition', { recommendation: '' })]) {
      for (const [dir, pkg] of Object.entries(packagesIn(files))) {
        const spec = readPackageSpec(pkg);
        for (const a of spec.actions) problems.push(...es5Problems(a.script, `${dir}/${a.name}`));
        for (const w of spec.workflows) {
          const script = [...w.xml.matchAll(/<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/g)].map((m) => [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join(''));
          expect(script.length).toBe(1);
          problems.push(...es5Problems(script[0]!, `${dir}/${w.name}`));
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every core action is in the core package, with a stable id', () => {
    const files = build('tags_compliance');
    for (const action of CORE_ACTIONS) {
      expect(typeof files[`${CORE_PACKAGE_DIR}/actions/com.archtoolkit.core/${action.name}.js`]).toBe('string');
      const side = JSON.parse(files[`${CORE_PACKAGE_DIR}/actions/com.archtoolkit.core/${action.name}.json`]!) as { id: string };
      expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(side.id)).toBe(true);
    }
    // The same core library in every automation, byte for byte.
    const other = build('vcfops_alert_definition');
    for (const [path, body] of Object.entries(files)) if (path.startsWith(`${CORE_PACKAGE_DIR}/`)) expect(other[path]).toBe(body);
  });

  it('refuses a package or element name Orchestrator would not take', () => {
    const spec = { packageName: 'com.archtoolkit.x', description: '', categoryPath: 'A/B', workflow: { name: 'W', description: '', inputs: [], outputs: [], script: '' }, config: { name: 'C', description: '', attributes: [] } };
    expect(() => toPackage({ ...spec, packageName: 'Com.Bad-Name' })).toThrow(/package name/);
    expect(() => toPackage({ ...spec, workflow: { ...spec.workflow, name: 'a/b' } })).toThrow(/has a "\/"/);
  });
});

// ---------------------------------------------------------------------------

/** The entries of a stored zip (the kind archive.ts writes). */
function unzipStored(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (method !== 0) throw new Error(`${name} is compressed`);
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    out.set(name, bytes.subarray(dataAt, dataAt + size));
    at += 46 + nameLength + extra;
  }
  return out;
}

describe('vro: the .package files verify', () => {
  it('signs every file and every element with MD5withRSA by the certificate inside', async () => {
    const files = { ...build('tags_compliance'), ...build('vcfops_alert_definition') };
    const packages = packagesIn(files);
    expect(Object.keys(packages).length).toBe(3);
    for (const [dir, text] of Object.entries(packages)) {
      const spec = readPackageSpec(text);
      const entries = unzipStored(await buildVroPackage(spec));
      const cer = [...entries.keys()].find((name) => name.startsWith('certificates/'));
      expect(Boolean(cer)).toBe(true);
      const key = new X509Certificate(entries.get(cer!)!).publicKey;
      const signed = [...entries.keys()].filter((name) => !name.startsWith('signatures/'));
      let verified = 0;
      for (const name of signed) {
        const signature = entries.get(`signatures/${name}`);
        if (!signature) throw new Error(`${dir}: ${name} has no signature`);
        if (!createVerify('MD5').update(entries.get(name)!).verify(key, signature)) throw new Error(`${dir}: the signature of ${name} does not verify`);
        verified++;
        if (name.endsWith('/data')) {
          const content = entries.get(name.replace(/data$/, 'content-signature'))!;
          if (!createVerify('MD5').update(entries.get(name)!).verify(key, content)) throw new Error(`${dir}: the content-signature of ${name} does not verify`);
        }
      }
      // Every element: info, categories, data, content-signature.
      const elements = spec.workflows.length + spec.actions.length + spec.configs.length + spec.resources.length;
      expect(signed.filter((name) => name.startsWith('elements/')).length).toBe(elements * 4);
      expect(verified).toBe(signed.length);
      const meta = new TextDecoder().decode(entries.get('dunes-meta-inf'));
      expect(meta.includes(`<entry key="pkg-name">${spec.name}-${spec.version}</entry>`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tag compliance

const STANDARD = [
  'Environment | single | VirtualMachine,Folder | prod,test | VirtualMachine | Stage',
  'Application | multiple | VirtualMachine | pay,web | | App',
  'Owner | single | VirtualMachine | team-a,team-b | | Owner',
].join('\n');

interface FakeVcenter {
  readonly categories: readonly { id: string; name: string; cardinality: string; associable_types: string[] }[];
  readonly tags: readonly { id: string; name: string; category_id: string }[];
  readonly attached: readonly { tag_id: string; object_ids: { type: string; id: string }[] }[];
  readonly hosts: readonly { host: string; name: string }[];
  readonly vms: Readonly<Record<string, { vm: string; name: string }[]>>;
  readonly folders: readonly { folder: string; name: string }[];
}

const VC_A: FakeVcenter = {
  categories: [
    { id: 'c-env', name: 'Environment', cardinality: 'SINGLE', associable_types: ['VirtualMachine'] },
    { id: 'c-app', name: 'Application', cardinality: 'SINGLE', associable_types: ['VirtualMachine'] },
    { id: 'c-leg', name: 'Legacy', cardinality: 'MULTIPLE', associable_types: [] },
  ],
  tags: [
    { id: 't-prod', name: 'prod', category_id: 'c-env' },
    { id: 't-test', name: 'test', category_id: 'c-env' },
    { id: 't-dev', name: 'dev', category_id: 'c-env' },
    { id: 't-pay', name: 'pay', category_id: 'c-app' },
    { id: 't-old', name: 'old', category_id: 'c-leg' },
  ],
  attached: [
    { tag_id: 't-prod', object_ids: [{ type: 'VirtualMachine', id: 'vm-1' }] },
    { tag_id: 't-test', object_ids: [{ type: 'VirtualMachine', id: 'vm-1' }] },
    { tag_id: 't-dev', object_ids: [{ type: 'VirtualMachine', id: 'vm-4' }] },
    { tag_id: 't-pay', object_ids: [{ type: 'VirtualMachine', id: 'vm-2' }] },
    { tag_id: 't-old', object_ids: [] },
  ],
  hosts: [{ host: 'host-1', name: 'esx1' }],
  vms: { 'host-1': [{ vm: 'vm-1', name: 'app1' }, { vm: 'vm-2', name: 'app2' }, { vm: 'vm-3', name: 'vCLS-1' }, { vm: 'vm-4', name: 'app4' }] },
  folders: [{ folder: 'group-v1', name: 'vm' }],
};

const VC_B: FakeVcenter = {
  categories: [
    { id: 'b-env', name: 'Environment', cardinality: 'SINGLE', associable_types: ['Folder', 'VirtualMachine'] },
    { id: 'b-app', name: 'Application', cardinality: 'MULTIPLE', associable_types: ['VirtualMachine'] },
    { id: 'b-own', name: 'Owner', cardinality: 'SINGLE', associable_types: ['VirtualMachine'] },
  ],
  tags: [
    { id: 'b-prod', name: 'prod', category_id: 'b-env' },
    { id: 'b-web', name: 'web', category_id: 'b-app' },
  ],
  attached: [],
  hosts: [{ host: 'host-9', name: 'esx9' }],
  vms: { 'host-9': [{ vm: 'vm-10', name: 'db1' }] },
  folders: [],
};

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function vcenterRoutes(host: string, vc: FakeVcenter): FakeRoute[] {
  const at = (method: string, path: string, body: unknown): FakeRoute => ({ method, host, path: `^${esc(path)}$`, body });
  return [
    // vCenter answers POST /api/session with the session id as a JSON string.
    { method: 'POST', host, path: '^/api/session$', body: JSON.stringify(`session-${vc.hosts[0]!.host}`) },
    { method: 'DELETE', host, path: '^/api/session$', status: 204 },
    at('GET', '/api/cis/tagging/category', vc.categories.map((c) => c.id)),
    ...vc.categories.map((c) => at('GET', `/api/cis/tagging/category/${c.id}`, { ...c, description: '' })),
    at('GET', '/api/cis/tagging/tag', vc.tags.map((t) => t.id)),
    ...vc.tags.map((t) => at('GET', `/api/cis/tagging/tag/${t.id}`, { ...t, description: '' })),
    at('POST', '/api/cis/tagging/tag-association?action=list-attached-objects-on-tags', vc.attached),
    at('GET', '/api/vcenter/host', vc.hosts),
    ...Object.entries(vc.vms).map(([h, vms]) => at('GET', `/api/vcenter/vm?hosts=${h}`, vms)),
    at('GET', '/api/vcenter/cluster', []),
    at('GET', '/api/vcenter/datastore', []),
    at('GET', '/api/vcenter/folder', vc.folders),
    at('GET', '/api/vcenter/resource-pool', []),
    at('GET', '/api/vcenter/datacenter', []),
    at('GET', '/api/vcenter/network', []),
  ];
}

const VC_PASSWORD = 'Vc-Pa55word-do-not-log';
const API_TOKEN = 'vcf-api-token-do-not-log';
const SAML = 'PHNhbWw6QXNzZXJ0aW9uPmZha2U8L3NhbWw6QXNzZXJ0aW9uPg';

describe('vro: tag compliance, as an Orchestrator package', { skip: !CURL }, () => {
  let server: FakeServer;
  let files: Record<string, string>;
  let A: string;
  let B: string;
  before(async () => {
    server = await startFakeServer([
      ...vcenterRoutes('^127\\.0\\.0\\.1:', VC_A),
      ...vcenterRoutes('^localhost:', VC_B),
      { method: 'POST', path: '^/acs/t/CUSTOMER/token$', body: { access_token: 'idb-access-do-not-log', token_type: 'Bearer' } },
      { method: 'POST', path: '^/api/vcenter/authentication/token$', body: { access_token: SAML } },
      { method: 'POST', path: '^/hook$', body: {} },
    ]);
    A = `127.0.0.1:${server.port}`;
    B = `localhost:${server.port}`;
    files = build('tags_compliance', { standard: STANDARD, exclude_names: '^vCLS', max_problems: 1000 });
  });
  after(() => server?.stop());

  const run = (settings: Record<string, unknown>): { run: WorkflowRun; requests: FakeRequest[] } => {
    const before = server.requests().length;
    const emulator = new VroEmulator(files, { config: { 'ArchToolKit/Tags/Tag compliance': { vcenters: [A, B], vcUsername: 'reader@vsphere.local', vcPassword: VC_PASSWORD, ...settings } } });
    const result = emulator.runWorkflow('Tag compliance report');
    return { run: result, requests: server.requests().slice(before) };
  };

  it('reads every vCenter, reports every check, and changes nothing', () => {
    const { run: result, requests } = run({ webhook: `https://${A}/hook` });
    expect(result.error).toBe(null);
    const checks = String(result.outputs.reportCsv).trim().split('\n').slice(1).map((line) => JSON.parse(`[${line}]`) as string[]);
    const got = checks.map((row) => `${row[0]}|${row[1] === A ? 'A' : row[1] === B ? 'B' : row[1]}|${row[4]}|${row[5]}|${row[6]}`);
    expect(got).toEqual([
      'category-not-in-standard|A||Legacy|',
      'category-missing|A||Owner|',
      'cardinality-mismatch|A||Application|',
      'object-types-mismatch|A||Environment|',
      'value-not-in-standard|A||Environment|dev',
      'tag-unused|A||Legacy|old',
      'cardinality-violation|A|app1|Environment|prod test',
      'missing-required|A|app2|Environment|',
      'missing-required|B|db1|Environment|',
      'missing-in-vcenter|B||Application|pay',
      'missing-in-vcenter|A||Application|web',
      'missing-in-vcenter|B||Environment|dev',
      'missing-in-vcenter|B||Environment|test',
    ]);
    expect(result.outputs.problemCount).toBe(13);
    // Reads only: GETs, the list-attached POST, logins and logouts, and the webhook.
    const writes = requests.filter((r) => r.method !== 'GET' && !/^\/api\/session$|list-attached-objects-on-tags|^\/hook$/.test(r.path));
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(requests.filter((r) => r.method === 'DELETE').length).toBe(2);
    const hook = requests.find((r) => r.path === '/hook');
    expect((JSON.parse(hook!.body) as { summary: { total: number } }).summary.total).toBe(13);
    expect(logText(result).includes(VC_PASSWORD)).toBe(false);
  });

  it('fails the run above the threshold, after logging every problem', () => {
    const { run: result } = run({ maxProblems: 5 });
    expect(result.error ?? '').toContain('13 problem(s), above the threshold of 5');
    expect(result.logs.filter((line) => line.message.startsWith('PROBLEM: ')).length).toBe(13);
  });

  it('logs in to vCenter with a VCF 9.1 API token: SIGN carries the gzipped SAML token', () => {
    const { run: result, requests } = run({ vcPassword: '', vcfIdbHost: A, vcfApiToken: API_TOKEN });
    expect(result.error).toBe(null);
    const exchange = requests.find((r) => r.path === '/acs/t/CUSTOMER/token')!;
    expect(exchange.body).toBe(`grant_type=${encodeURIComponent('urn:custom:vcf:params:oauth:grant-type:api-token')}&api_token=${API_TOKEN}`);
    const sign = requests.find((r) => r.path === '/api/session' && r.method === 'POST')!.headers.authorization!;
    const m = /^SIGN token="([A-Za-z0-9+/=]+)"$/.exec(sign);
    expect(Boolean(m)).toBe(true);
    const bin = atob(m![1]!);
    const unzipped = new TextDecoder().decode(gunzipSync(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    expect(unzipped).toBe(atob(SAML.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (SAML.length % 4)) % 4)));
    expect(/do-not-log/.test(logText(result))).toBe(false);
  });

  it('produces the same rows as the bash script it replaces', { skip: !has('jq') || !has('bash') }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'atk-tags-'));
    try {
      writeFileSync(join(dir, 'tag-compliance.sh'), files['scripts/tag-compliance.sh']!.replace(/https:\/\//g, 'http://'));
      writeFileSync(join(dir, 'tag-standard.json'), files['scripts/tag-standard.json']!);
      writeFileSync(join(dir, 'pw'), VC_PASSWORD);
      chmodSync(join(dir, 'pw'), 0o600);
      mkdirSync(join(dir, 'reports'));
      execFileSync('bash', [join(dir, 'tag-compliance.sh')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, VCENTERS: `${A} ${B}`, VC_USER: 'reader@vsphere.local', VC_PASSWORD_FILE: join(dir, 'pw'), OUT_DIR: join(dir, 'reports'), MAX_PROBLEMS: '1000', EXCLUDE_NAMES: '^vCLS' },
      });
      const report = readdirSync(join(dir, 'reports')).find((name) => name.endsWith('.csv'))!;
      const bash = readFileSync(join(dir, 'reports', report), 'utf8');
      const { run: result } = run({});
      expect(String(result.outputs.reportCsv)).toBe(bash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The alert definition

const OPS_PASSWORD = 'Ops-Pa55word-do-not-log';
const OPS_TOKEN = 'ops-token-do-not-log';

function opsRoutes(overrides: { symptoms?: unknown[]; recommendationStatus?: number; symptomTotal?: number } = {}): FakeRoute[] {
  return [
    { method: 'POST', path: '^/suite-api/api/auth/token/acquire$', body: { token: OPS_TOKEN, validity: 0 } },
    { method: 'POST', path: '^/suite-api/api/auth/token/release$', body: '' },
    {
      method: 'GET',
      path: '^/suite-api/api/symptomdefinitions\\?',
      // A first page, then an empty one: with a total above what was served, that is a truncated list.
      responses: [
        { body: { symptomDefinitions: overrides.symptoms ?? [], pageInfo: { totalCount: overrides.symptomTotal ?? (overrides.symptoms ?? []).length, page: 0, pageSize: 1000 } } },
        { body: { symptomDefinitions: [], pageInfo: { totalCount: overrides.symptomTotal ?? 0, page: 1, pageSize: 1000 } } },
      ],
    },
    { method: 'GET', path: '^/suite-api/api/recommendations\\?', body: { recommendations: [], pageInfo: { totalCount: 0 } } },
    { method: 'GET', path: '^/suite-api/api/alertdefinitions\\?', body: { alertDefinitions: [], pageInfo: { totalCount: 0 } } },
    { method: 'POST', path: '^/suite-api/api/symptomdefinitions$', responses: [{ body: { id: 'SymptomDefinition-W1' } }, { body: { id: 'SymptomDefinition-C1' } }] },
    { method: 'POST', path: '^/suite-api/api/recommendations$', status: overrides.recommendationStatus ?? 200, body: overrides.recommendationStatus ? { message: `refused for ${OPS_PASSWORD}` } : { id: 'Recommendation-R1' } },
    { method: 'POST', path: '^/suite-api/api/alertdefinitions$', body: { id: 'AlertDefinition-A1' } },
  ];
}

describe('vro: the alert definition, as an Orchestrator package', { skip: !CURL }, () => {
  const files = build('vcfops_alert_definition');
  const pkgDir = Object.keys(packagesIn(files)).find((dir) => dir !== 'com.archtoolkit.core.package')!;
  const spec = readPackageSpec(packagesIn(files)[pkgDir]!);
  const workflow = spec.workflows[0]!.name;
  const configKey = `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}`;
  const warningName = (JSON.parse(spec.resources.find((r) => r.name === 'symptom-warning.json')!.content) as { name: string }).name;

  const servers: FakeServer[] = [];
  after(() => servers.forEach((s) => s.stop()));

  const runOps = async (settings: Record<string, unknown>, inputs: Record<string, unknown>, routes = opsRoutes()) => {
    const server = await startFakeServer(routes);
    servers.push(server);
    const emulator = new VroEmulator(files, { config: { [configKey]: { opsHost: `127.0.0.1:${server.port}`, opsUsername: 'automation', opsPassword: OPS_PASSWORD, ...settings } } });
    const result = emulator.runWorkflow(workflow, inputs);
    const requests = server.requests();
    expect(/do-not-log/.test(logText(result))).toBe(false);
    return { result, requests, writes: requests.filter((r) => r.method !== 'GET' && !/\/auth\/token\/(acquire|release)$/.test(r.path)).map((r) => `${r.method} ${r.path}`) };
  };

  it('is one package: workflow, settings with the password empty, and the payloads', () => {
    expect(spec.name.startsWith('com.archtoolkit.vcfops.alert.')).toBe(true);
    expect(spec.configs[0]!.attributes.find((a) => a.name === 'opsPassword')).toEqual({ name: 'opsPassword', type: 'SecureString', description: 'Its password' });
    expect(spec.configs[0]!.attributes.find((a) => a.name === 'dryRun')?.value).toBe(true);
    expect(spec.resources.map((r) => r.name).sort()).toEqual(['alert.json', 'recommendation.json', 'symptom-critical.json', 'symptom-warning.json']);
    expect(files['IMPORT.md']!.includes(`import/${pkgDir}`)).toBe(true);
    expect(typeof files['scripts/apply.sh']).toBe('string');
  });

  it('dry run by default: reads, plans four creates, writes nothing', async () => {
    const { result, writes } = await runOps({}, {});
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would create')).length).toBe(4);
    expect(result.outputs.alertDefinitionId).toBe('');
  });

  it('the dryRun input can only make a run safer', async () => {
    const { writes } = await runOps({ dryRun: false }, { dryRun: true });
    expect(writes).toEqual([]);
  });

  it('armed: creates the symptoms, the recommendation, then the alert with their ids', async () => {
    const { result, requests, writes } = await runOps({ dryRun: false }, { dryRun: false });
    expect(result.error).toBe(null);
    expect(requests.map((r) => `${r.method} ${r.path.split('?')[0]}`)).toEqual([
      'POST /suite-api/api/auth/token/acquire',
      'GET /suite-api/api/symptomdefinitions',
      'POST /suite-api/api/symptomdefinitions',
      'POST /suite-api/api/symptomdefinitions',
      'GET /suite-api/api/recommendations',
      'POST /suite-api/api/recommendations',
      'GET /suite-api/api/alertdefinitions',
      'POST /suite-api/api/alertdefinitions',
      'POST /suite-api/api/auth/token/release',
    ]);
    expect(writes.length).toBe(4);
    const alert = JSON.parse(requests.find((r) => r.method === 'POST' && r.path === '/suite-api/api/alertdefinitions')!.body) as { states: { 'base-symptom-set': { symptomDefinitionIds: string[] }; recommendationPriorityMap: Record<string, number> }[] };
    expect(alert.states[0]!['base-symptom-set'].symptomDefinitionIds).toEqual(['SymptomDefinition-W1', 'SymptomDefinition-C1']);
    expect(alert.states[0]!.recommendationPriorityMap).toEqual({ 'Recommendation-R1': 1 });
    expect(requests.every((r) => r.path.includes('/auth/token/acquire') || r.headers.authorization === `OpsToken ${OPS_TOKEN}`)).toBe(true);
    expect(result.outputs.alertDefinitionId).toBe('AlertDefinition-A1');
    expect((JSON.parse(String(result.outputs.summary)) as { changes: unknown[] }).changes.length).toBe(4);
  });

  it('leaves what exists alone and uses its id', async () => {
    const { result, writes, requests } = await runOps({ dryRun: false }, {}, opsRoutes({ symptoms: [{ id: 'SymptomDefinition-OLD', name: warningName }] }));
    expect(result.error).toBe(null);
    expect(writes).toEqual(['POST /suite-api/api/symptomdefinitions', 'POST /suite-api/api/recommendations', 'POST /suite-api/api/alertdefinitions']);
    const alert = JSON.parse(requests.find((r) => r.path === '/suite-api/api/alertdefinitions' && r.method === 'POST')!.body) as { states: { 'base-symptom-set': { symptomDefinitionIds: string[] } }[] };
    expect(alert.states[0]!['base-symptom-set'].symptomDefinitionIds).toEqual(['SymptomDefinition-OLD', 'SymptomDefinition-W1']);
  });

  it('stops at the cap, before the change that would exceed it', async () => {
    const { result, writes } = await runOps({ dryRun: false, cap: 2 }, {});
    expect(writes.length).toBe(2);
    expect(result.error ?? '').toContain('Cap reached: 2 change(s) made, the cap is 2; stopping before: create recommendation');
  });

  it('stops at the first failure, says what failed, and still logs out', async () => {
    const { result, writes, requests } = await runOps({ dryRun: false }, {}, opsRoutes({ recommendationStatus: 500 }));
    expect(writes).toEqual(['POST /suite-api/api/symptomdefinitions', 'POST /suite-api/api/symptomdefinitions', 'POST /suite-api/api/recommendations']);
    expect(result.error ?? '').toContain('Stopped after 2 change(s): create recommendation failed: POST https://127.0.0.1:');
    expect(result.error ?? '').toContain('/suite-api/api/recommendations returned HTTP 500');
    expect(requests[requests.length - 1]!.path).toBe('/suite-api/api/auth/token/release');
  });

  it('refuses to act on a partial list', async () => {
    const { result, writes } = await runOps({ dryRun: false }, {}, opsRoutes({ symptoms: [{ id: 'x', name: 'other' }], symptomTotal: 5 }));
    expect(writes).toEqual([]);
    expect(result.error ?? '').toContain('Paging stopped at 1 of 5 items');
  });

  it('refuses a list answer with neither its key nor pageInfo, rather than reading it as empty (regression)', async () => {
    const routes = opsRoutes().map((r) => (r.path === '^/suite-api/api/symptomdefinitions\\?' ? { method: 'GET', path: r.path, body: { unexpected: [] } } : r));
    const { result, writes } = await runOps({ dryRun: false }, {}, routes);
    expect(writes).toEqual([]);
    expect(result.error ?? '').toContain('returned no symptomDefinitions');
  });

  it('without a recommendation, creates three objects and no recommendation reference', async () => {
    const noRec = build('vcfops_alert_definition', { recommendation: '' });
    const dir = Object.keys(packagesIn(noRec)).find((d) => d !== 'com.archtoolkit.core.package')!;
    const s = readPackageSpec(packagesIn(noRec)[dir]!);
    const server = await startFakeServer(opsRoutes());
    servers.push(server);
    const emulator = new VroEmulator(noRec, { config: { [`${s.configs[0]!.categoryPath}/${s.configs[0]!.name}`]: { opsHost: `127.0.0.1:${server.port}`, opsUsername: 'a', opsPassword: OPS_PASSWORD, dryRun: false } } });
    const result = emulator.runWorkflow(s.workflows[0]!.name, {});
    expect(result.error).toBe(null);
    const posts = server.requests().filter((r) => r.method === 'POST' && !r.path.includes('/auth/'));
    expect(posts.map((r) => r.path)).toEqual(['/suite-api/api/symptomdefinitions', '/suite-api/api/symptomdefinitions', '/suite-api/api/alertdefinitions']);
    expect(posts[2]!.body.includes('recommendation')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('vro: the core library guards', { skip: !CURL }, () => {
  const files = build('tags_compliance');
  const servers: FakeServer[] = [];
  after(() => servers.forEach((s) => s.stop()));
  const core = (emulator: VroEmulator) => emulator.module('com.archtoolkit.core') as Record<string, (...args: unknown[]) => unknown>;

  it('notify: a failed post names only the webhook host, never its path or query (regression)', async () => {
    const server = await startFakeServer([
      { method: 'POST', path: '^/services/T0001/', status: 500, body: { error: 'boom' } },
      { method: 'POST', path: '^/services/T0002/', body: {} },
    ]);
    servers.push(server);
    const host = `127.0.0.1:${server.port}`;
    const emulator = new VroEmulator(files);
    const failed = core(emulator).notify!(`https://${host}/services/T0001/B0002/path-token-do-not-log?key=query-do-not-log`, { a: 1 });
    expect(failed).toBe(false);
    const ok = core(emulator).notify!(`https://${host}/services/T0002/B0003/path-token-do-not-log`, '{"a":1}');
    expect(ok).toBe(true);
    // Nothing listens here: the connection error names the URL too.
    const refused = core(emulator).notify!('https://127.0.0.1:1/services/T0004/refused-token-do-not-log', { a: 1 });
    expect(refused).toBe(false);
    const text = emulator.logs.map((l) => l.message).join('\n');
    expect(text).toContain(`Webhook post to https://${host} failed`);
    expect(text).toContain('Webhook post to https://127.0.0.1:1 failed');
    expect(/do-not-log|T0001|T0004|\/services\//.test(text)).toBe(false);
    expect(server.requests().map((r) => r.path.split('?')[0])).toEqual(['/services/T0001/B0002/path-token-do-not-log', '/services/T0002/B0003/path-token-do-not-log']);
  });

  it('http: options.redact scrubs the URL in the error as well as the response', async () => {
    const server = await startFakeServer([{ method: 'GET', path: '^/x/', status: 403, body: { echo: '/x/secret-segment' } }]);
    servers.push(server);
    const emulator = new VroEmulator(files);
    expect(() => core(emulator).http!('GET', `https://127.0.0.1:${server.port}/x/secret-segment`, null, null, { redact: ['/x/secret-segment'] })).toThrow(/GET https:\/\/127\.0\.0\.1:\d+\*\*\*\* returned HTTP 403/);
    try {
      core(emulator).http!('GET', `https://127.0.0.1:${server.port}/x/secret-segment`, null, null, { redact: ['/x/secret-segment'] });
    } catch (e) {
      expect(String(e)).not.toContain('secret-segment');
    }
  });

  it('pageAll: refuses a page that starts with the same item as the page before, rather than loop (regression)', () => {
    const emulator = new VroEmulator(files);
    const pageAll = core(emulator).pageAll!;
    // An endpoint that ignores the page parameter: the same page for ever, no total.
    let calls = 0;
    expect(() =>
      pageAll(() => {
        calls++;
        return { items: [{ id: 'a' }, { id: 'b' }], total: null, more: null };
      }, 0),
    ).toThrow(/Page 1 starts with the same item as page 0 \(after 2 items\)/);
    expect(calls).toBe(2);
    // Items without ids compare by their JSON.
    expect(() => pageAll(() => ({ items: ['x', 'y'], total: null, more: null }), 0)).toThrow(/same item/);
    // Real pages still read whole, and a single page with more === false stops.
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }], []];
    // (JSON: the list is made in the scripts' own context.)
    expect(JSON.stringify(pageAll((page: number) => ({ items: pages[page], total: null, more: null }), 0))).toBe('[{"id":1},{"id":2},{"id":3}]');
    expect(JSON.stringify(pageAll(() => ({ items: [{ id: 1 }], total: null, more: false }), 0))).toBe('[{"id":1}]');
  });
});

describe('vro: webhook URLs are secrets in every automation', () => {
  it('every webhook-like attribute is a SecureString with no value, and IMPORT.md says to fill it (regression)', async () => {
    const { AUTOMATIONS } = await import('../blueprints/index.ts');
    const WEBHOOKISH = /webhook|auditurl|^endpoint$/i;
    const problems: string[] = [];
    let seen = 0;
    for (const blueprint of AUTOMATIONS) {
      const files = blueprint.build(defaultValues(blueprint), blueprint.id).files;
      for (const [dir, pkg] of Object.entries(packagesIn(files))) {
        if (dir === 'com.archtoolkit.core.package') continue;
        for (const config of readPackageSpec(pkg).configs) {
          for (const a of config.attributes) {
            if (!WEBHOOKISH.test(a.name)) continue;
            seen++;
            if (a.type !== 'SecureString') problems.push(`${blueprint.id}: ${a.name} is ${a.type}`);
            if (a.value !== undefined) problems.push(`${blueprint.id}: ${a.name} carries a value`);
            if (!(files['IMPORT.md'] ?? '').includes(`**${a.name}**`)) problems.push(`${blueprint.id}: IMPORT.md does not name ${a.name}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(seen).toBeGreaterThan(50);
  });
});
