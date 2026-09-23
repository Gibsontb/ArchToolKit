/**
 * VCF Automation 9.1 (src/automation/blueprints/vcf-automation-91.ts), as
 * Orchestrator packages: built, parsed, ES5, and run.
 *
 * Every automation in the file is one package on the shared core library.
 * For each: the package parses, every script is ES5, secrets are SecureString
 * with no value, IMPORT.md names the package — for every select option and
 * toggle — and the workflow runs in the emulator against a fake VCF
 * Automation:
 *
 *   - the read-only ones (region inventory, content library check, health
 *     check, token audit) only GET, besides the token exchange, and report
 *     what is wrong;
 *   - the ones that change something write nothing in a dry run (at most a
 *     Kubernetes server-side dry run, dryRun=All, or a blueprint validation,
 *     which persist nothing), make exactly the expected calls in order with
 *     the right bodies when armed, leave what exists alone, stop at the cap
 *     and at the first failure;
 *   - no secret — API token, access token, database password — is ever in a
 *     log line, an output or an error.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { readPackageSpec, type VroPackageSpec } from '../../kit/vro-package.ts';
import { automationFor } from '../blueprints/index.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../../testing/fake-rest-server.ts';

const IDS = [
  'vcfa91_api_tokens',
  'vcfa91_organization',
  'vcfa91_region_zone',
  'vcfa91_vpc',
  'vcfa91_content_library',
  'vcfa91_vm_service',
  'vcfa91_data_services',
  'vcfa91_tags_placement',
  'vcfa91_blueprint_versions',
  'vcfa91_namespace_day2',
  'vcfa91_argocd',
  'vcfa91_security_policy',
  'vcfa91_estate_check',
] as const;

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

/** The automation's own package (not the core library). */
function own(files: Record<string, string>): { dir: string; spec: VroPackageSpec } {
  const packages = packagesIn(files);
  const dirs = Object.keys(packages).filter((d) => d !== 'com.archtoolkit.core.package');
  if (dirs.length !== 1) throw new Error(`expected one automation package, got ${dirs.join(', ')}`);
  return { dir: dirs[0]!, spec: readPackageSpec(packages[dirs[0]!]!) };
}

/** Every variant the page can produce from one choice: each select option, each toggle flipped. */
function variants(id: string): { label: string; files: Record<string, string> }[] {
  const blueprint = automationFor(id)!;
  const base = defaultValues(blueprint);
  const out = [{ label: 'defaults', files: build(id) }];
  for (const input of blueprint.inputs) {
    if (input.control === 'select') for (const option of input.options ?? []) out.push({ label: `${input.id}=${option.value}`, files: build(id, { [input.id]: option.value }) });
    if (input.control === 'toggle') out.push({ label: `${input.id}=${String(!base[input.id])}`, files: build(id, { [input.id]: !base[input.id] }) });
  }
  return out;
}

function workflowScript(xml: string): string {
  const m = /<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/.exec(xml);
  return m ? [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join('') : '';
}

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const at = (method: string, path: string, body?: unknown, status?: number): FakeRoute => ({ method, path: `^${esc(path)}$`, body, ...(status ? { status } : {}) });

// ---------------------------------------------------------------------------
// Secrets, and the fake VCF Automation's login

const API_TOKEN = 'vcfa-api-token-do-not-log';
const TARGET_TOKEN = 'vcfa-target-token-do-not-log';
const ACCESS = 'access-jwt-do-not-log';
const TARGET_ACCESS = 'target-access-jwt-do-not-log';
const DB_PASSWORD = 'Db-Pa55word-do-not-log';

const LOGIN: FakeRoute[] = [
  { method: 'POST', path: '^/oauth/provider/token$', body: { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600 } },
  { method: 'POST', path: '^/oauth/tenant/team-b/token$', body: { access_token: TARGET_ACCESS, token_type: 'Bearer' } },
  { method: 'POST', path: '^/oauth/tenant/[^/]+/token$', body: { access_token: ACCESS, token_type: 'Bearer' } },
  { method: 'GET', path: '^/api/versions$', body: { versionInfo: [{ version: '39.0', deprecated: false }, { version: '40.0', deprecated: false }] } },
  { method: 'POST', path: '^/hook$', body: {} },
];

function logText(run: WorkflowRun): string {
  return run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');
}

const isLogin = (r: FakeRequest) => /^\/oauth\/|^\/api\/versions$|^\/hook$/.test(r.path);

interface Run {
  readonly result: WorkflowRun;
  readonly requests: FakeRequest[];
  /** Calls other than the login, the version list and the webhook, as "METHOD path". */
  readonly calls: string[];
  /** What changed something: not a GET, not a login, not a server-side dry run or a validation. */
  readonly writes: string[];
  readonly host: string;
}

/** A harness for one automation: its package, and a run against a fresh fake server. */
function harness(id: string, overrides: BlueprintValues = {}) {
  const files = build(id, overrides);
  const { dir, spec } = own(files);
  const workflow = spec.workflows[0]!.name;
  const configKey = `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}`;
  const servers: FakeServer[] = [];
  const run = async (routes: FakeRoute[], settings: (host: string) => Record<string, unknown>, inputs: Record<string, unknown> = {}): Promise<Run> => {
    const server = await startFakeServer([...LOGIN, ...routes]);
    servers.push(server);
    const host = `127.0.0.1:${server.port}`;
    const emulator = new VroEmulator(files, { config: { [configKey]: { vcfaHost: host, vcfaApiToken: API_TOKEN, ...settings(host) } } });
    const result = emulator.runWorkflow(workflow, inputs);
    const requests = server.requests();
    // Never a secret in a log line, an output or an error, whatever happened.
    expect(/do-not-log/.test(logText(result))).toBe(false);
    const calls = requests.filter((r) => !isLogin(r)).map((r) => `${r.method} ${r.path}`);
    const writes = requests.filter((r) => r.method !== 'GET' && !isLogin(r) && !/[?&]dryRun=All\b/.test(r.path) && !/blueprint-validation/.test(r.path)).map((r) => `${r.method} ${r.path}`);
    return { result, requests, calls, writes, host };
  };
  return { files, dir, spec, workflow, run, stop: () => servers.forEach((s) => s.stop()) };
}

const bodyOf = (run: Run, method: string, path: string | RegExp): Record<string, unknown> => {
  const r = run.requests.find((q) => q.method === method && (typeof path === 'string' ? q.path === path : path.test(q.path)));
  if (!r) throw new Error(`no ${method} ${String(path)} in ${run.requests.map((q) => `${q.method} ${q.path}`).join(', ')}`);
  return JSON.parse(r.body) as Record<string, unknown>;
};

// ---------------------------------------------------------------------------

describe('vcfa 9.1 packages: built, ES5, secrets empty, named in IMPORT.md', () => {
  for (const id of IDS) {
    it(`${id}: every variant builds one package that parses and runs as Orchestrator JavaScript`, () => {
      for (const { label, files } of variants(id)) {
        const { dir, spec } = own(files);
        expect(spec.name.startsWith('com.archtoolkit.vcfa91.')).toBe(true);
        expect(spec.workflows.length).toBe(1);
        expect(spec.configs.length).toBe(1);
        const problems: string[] = [];
        for (const a of spec.actions) problems.push(...es5Problems(a.script, `${id} ${label} ${a.name}`));
        problems.push(...es5Problems(workflowScript(spec.workflows[0]!.xml), `${id} ${label} workflow`));
        expect(problems).toEqual([]);
        // Every secret a SecureString with no value; nothing that looks like one in plain text.
        for (const a of spec.configs[0]!.attributes) {
          if (a.type === 'SecureString') expect(a.value === undefined).toBe(true);
          if (/token|password|secret/i.test(a.name)) expect(a.type).toBe('SecureString');
        }
        expect(spec.configs[0]!.attributes.some((a) => a.name === 'vcfaApiToken' && a.type === 'SecureString')).toBe(true);
        for (const r of spec.resources) if (r.name.endsWith('.json')) JSON.parse(r.content);
        const importMd = files['IMPORT.md'] ?? '';
        expect(importMd.includes(`import/${dir}`)).toBe(true);
        expect(importMd.includes('import/com.archtoolkit.core.package')).toBe(true);
        // The emulator loads it (it refuses anything beyond ES5).
        new VroEmulator(files);
        // The fallback scripts moved under scripts/; none is left at the top.
        expect(Object.keys(files).filter((path) => /\.sh$/.test(path) && !path.startsWith('scripts/') && !path.startsWith('import/'))).toEqual([]);
      }
    });
  }

  it('changing workflows have a dryRun input and arm only from the configuration element', () => {
    for (const id of IDS) {
      const { spec } = own(build(id, id === 'vcfa91_api_tokens' ? { include_revoke: true } : {}));
      const attrs = spec.configs[0]!.attributes;
      const dry = attrs.find((a) => a.name === 'dryRun');
      const hasInput = /<input>[\s\S]*?name="dryRun"/.test(spec.workflows[0]!.xml);
      if (['vcfa91_region_zone', 'vcfa91_content_library', 'vcfa91_estate_check'].includes(id)) {
        expect(dry).toBe(undefined);
        expect(hasInput).toBe(false);
      } else {
        expect(dry?.value).toBe(true);
        expect(hasInput).toBe(true);
      }
    }
  });

  it('keeps the native files beside the package: YAML, Terraform, JSON payloads, blueprint.yaml', () => {
    expect(typeof build('vcfa91_vpc')['subnets.k8s.yaml']).toBe('string');
    expect(typeof build('vcfa91_vm_service')['web01.k8s.yaml']).toBe('string');
    expect(typeof build('vcfa91_organization')['main.tf']).toBe('string');
    expect(typeof build('vcfa91_organization')['org.json']).toBe('string');
    expect(typeof build('vcfa91_content_library')['content-library.tf']).toBe('string');
    const tags = build('vcfa91_tags_placement');
    const templatePath = Object.keys(tags).find((p) => p.endsWith('/blueprint.yaml') && p.startsWith('import/templates/'))!;
    // The resource the workflow imports is the same file the git and upload routes take.
    expect(tags[templatePath]).toBe(Object.entries(tags).find(([p]) => p.endsWith('/Tag placement/example-template.yaml'))![1]);
    expect(typeof tags['import/import-templates.sh']).toBe('string');
  });

  it('writes the same Kubernetes objects to the YAML and to the workflow resource', () => {
    const files = build('vcfa91_vm_service', { data_disk_gib: 20, load_balancer: true });
    const { spec } = own(files);
    const items = JSON.parse(spec.resources.find((r) => r.name === 'objects.json')!.content) as { plural: string; object: { kind: string; metadata: { name: string } } }[];
    expect(items.map((i) => `${i.plural}/${i.object.kind}/${i.object.metadata.name}`)).toEqual([
      'secrets/Secret/web01-cloud-init',
      'persistentvolumeclaims/PersistentVolumeClaim/web01-data',
      'virtualmachines/VirtualMachine/web01',
      'virtualmachineservices/VirtualMachineService/web01-lb',
    ]);
    const yaml = files['web01.k8s.yaml']!;
    expect(yaml.split('\n').filter((l) => l.startsWith('kind: '))).toEqual(['kind: Secret', 'kind: PersistentVolumeClaim', 'kind: VirtualMachine', 'kind: VirtualMachineService']);
    expect(yaml.includes('  user-data: |\n    #cloud-config\n')).toBe(true);
    expect(yaml.includes('        claimName: web01-data')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// API tokens

const soonDate = new Date(Date.now() + 5 * 86400000).toISOString();
const laterDate = new Date(Date.now() + 300 * 86400000).toISOString();

const tokenRoutes = (extra: FakeRoute[] = []): FakeRoute[] => [
  { method: 'GET', path: '^/cloudapi/1\\.0\\.0/tokens\\?filter=type%3D%3DREFRESH&page=1&pageSize=128$', body: { resultTotal: 3, pageCount: 2, page: 1, values: [{ id: 'urn:t:1', name: 'nightly', owner: { name: 'svc' }, expirationDate: soonDate }, { id: 'urn:t:2', name: 'backup', owner: { name: 'svc' }, expirationDate: laterDate }] } },
  { method: 'GET', path: '^/cloudapi/1\\.0\\.0/tokens\\?filter=type%3D%3DREFRESH&page=2&pageSize=128$', body: { resultTotal: 3, pageCount: 2, page: 2, values: [{ id: 'urn:t:3', name: 'old', owner: { name: 'ann' } }] } },
  ...extra,
];

describe('vcfa 9.1: API tokens, as an Orchestrator package', { skip: !CURL }, () => {
  const audit = harness('vcfa91_api_tokens');
  const revoke = harness('vcfa91_api_tokens', { include_revoke: true });
  after(() => {
    audit.stop();
    revoke.stop();
  });
  const settings = () => ({ vcfaOrg: 'team-a', webhook: '' });

  it('audits: exchanges the token, reads every page, flags the one expiring, fails the run, only reads', async () => {
    const run = await audit.run(tokenRoutes(), settings);
    expect(run.requests[0]!.path).toBe('/api/versions');
    expect(run.requests[1]!.path).toBe('/oauth/tenant/team-a/token');
    expect(run.requests[1]!.body).toBe(`grant_type=refresh_token&refresh_token=${API_TOKEN}`);
    expect(run.calls).toEqual(['GET /cloudapi/1.0.0/tokens?filter=type%3D%3DREFRESH&page=1&pageSize=128', 'GET /cloudapi/1.0.0/tokens?filter=type%3D%3DREFRESH&page=2&pageSize=128']);
    const list = run.requests.find((r) => r.path.startsWith('/cloudapi/'))!;
    expect(list.headers.accept).toBe('application/json;version=40.0');
    expect(list.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(String(run.result.outputs.tokenReport).split('\n').slice(0, 4)).toEqual(['name,owner,expires,id', `nightly,svc,${soonDate},urn:t:1`, `backup,svc,${laterDate},urn:t:2`, 'old,ann,never,urn:t:3']);
    expect(run.result.outputs.expiringCount).toBe(1);
    expect(run.result.error ?? '').toContain('1 API token(s) expire within 30 days: nightly');
    expect(run.writes).toEqual([]);
  });

  it('uses the configured API version, and refuses one the server does not offer before logging in', async () => {
    const ok = await audit.run(tokenRoutes(), () => ({ ...settings(), apiVersion: '39.0' }));
    expect(ok.requests.find((r) => r.path.startsWith('/cloudapi/'))!.headers.accept).toBe('application/json;version=39.0');
    const bad = await audit.run(tokenRoutes(), () => ({ ...settings(), apiVersion: '9.1.0' }));
    expect(bad.result.error ?? '').toContain('API version 9.1.0 is not offered');
    expect(bad.requests.some((r) => r.path.startsWith('/oauth/'))).toBe(false);
  });

  it('says so when the token list is not where it should be, rather than reporting no tokens', async () => {
    const run = await audit.run([], settings);
    expect(run.result.error ?? '').toContain('not at /cloudapi/1.0.0/tokens');
    expect(run.result.logs.some((l) => l.message.startsWith('VERIFY: /cloudapi/1.0.0/tokens answered HTTP 404'))).toBe(true);
  });

  const revokeRoutes = (status = 204) => tokenRoutes([at('GET', '/cloudapi/1.0.0/tokens/urn%3At%3A3', { id: 'urn:t:3', name: 'old', owner: { name: 'ann' } }), at('DELETE', '/cloudapi/1.0.0/tokens/urn%3At%3A3', '', status)]);

  it('revoke: a dry run by default, and the dryRun input cannot arm it', async () => {
    for (const s of [{}, { dryRun: false }]) {
      const run = await revoke.run(revokeRoutes(), () => ({ ...settings(), ...s }), { dryRun: 'dryRun' in s ? true : null, revokeId: 'urn:t:3', revokeName: 'old' });
      expect(run.result.error).toBe(null);
      expect(run.writes).toEqual([]);
      expect(run.result.logs.some((l) => l.message.startsWith('DRY RUN: would revoke API token "old" (urn:t:3, owner ann)'))).toBe(true);
    }
  });

  it('revoke: armed, deletes exactly the token whose id and name match', async () => {
    const run = await revoke.run(revokeRoutes(), () => ({ ...settings(), dryRun: false }), { revokeId: 'urn:t:3', revokeName: 'old' });
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual(['DELETE /cloudapi/1.0.0/tokens/urn%3At%3A3']);
    expect((JSON.parse(String(run.result.outputs.summary)) as { summary: { revoked: string } }).summary.revoked).toBe('urn:t:3');
  });

  it('revoke: refuses when the name does not match, and stops at a cap of 0', async () => {
    const wrong = await revoke.run(revokeRoutes(), () => ({ ...settings(), dryRun: false }), { revokeId: 'urn:t:3', revokeName: 'nightly' });
    expect(wrong.result.error ?? '').toContain('is named "old", not "nightly". Nothing was revoked.');
    expect(wrong.writes).toEqual([]);
    const capped = await revoke.run(revokeRoutes(), () => ({ ...settings(), dryRun: false, cap: 0 }), { revokeId: 'urn:t:3', revokeName: 'old' });
    expect(capped.result.error ?? '').toContain('Cap reached: 0 change(s) made');
    expect(capped.writes).toEqual([]);
  });

  it('revoke: a failed DELETE stops the run and says what failed', async () => {
    const run = await revoke.run(revokeRoutes(500), () => ({ ...settings(), dryRun: false }), { revokeId: 'urn:t:3', revokeName: 'old' });
    expect(run.result.error ?? '').toContain('Stopped after 0 change(s): revoke API token "old"');
    expect(run.result.error ?? '').toContain('returned HTTP 500');
  });
});

// ---------------------------------------------------------------------------
// Organization

const ORG_LIST = '/cloudapi/1.0.0/orgs?filter=name%3D%3Dteam-a&page=1&pageSize=128';
const QUOTAS = '/cloudapi/vcf/virtualDatacenters?filter=org.id%3D%3Durn%3Avcloud%3Aorg%3Aa1&page=1&pageSize=128';

describe('vcfa 9.1: organization, as an Orchestrator package', { skip: !CURL }, () => {
  const allApps = harness('vcfa91_organization');
  const vmApps = harness('vcfa91_organization', { org_type: 'vm-apps' });
  after(() => {
    allApps.stop();
    vmApps.stop();
  });
  const none = [at('GET', ORG_LIST, { resultTotal: 0, values: [] }), at('POST', '/cloudapi/1.0.0/orgs', { id: 'urn:vcloud:org:a1', name: 'team-a' }), at('GET', QUOTAS, { resultTotal: 0, values: [] })];

  it('dry run by default: looks the organization up, plans its creation, writes nothing', async () => {
    const run = await allApps.run(none, () => ({}));
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([]);
    expect(run.result.logs.some((l) => l.message === 'DRY RUN: would create All Apps organization team-a')).toBe(true);
    expect(run.result.outputs.organizationId).toBe('');
  });

  it('armed: creates it with the KB 419781 body, then reports that its region quota is missing', async () => {
    const run = await allApps.run(none, () => ({ dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.calls).toEqual([`GET ${ORG_LIST}`, 'POST /cloudapi/1.0.0/orgs', `GET ${QUOTAS}`]);
    const post = run.requests.find((r) => r.method === 'POST' && r.path === '/cloudapi/1.0.0/orgs')!;
    expect(post.headers['content-type']).toBe('application/json;version=40.0');
    expect(JSON.parse(post.body)).toEqual({ name: 'team-a', displayName: 'Team A', description: 'Managed by ArchToolKit', isEnabled: true, canManageOrgs: false, isClassicTenant: false });
    expect(run.result.outputs.organizationId).toBe('urn:vcloud:org:a1');
    expect(run.result.outputs.problemCount).toBe(1);
    expect(run.result.logs.some((l) => l.message.startsWith('PROBLEM: no region quota yet'))).toBe(true);
  });

  it('leaves an existing organization alone, checks its quota, and refuses one of the other type', async () => {
    const existing = [at('GET', ORG_LIST, { resultTotal: 1, values: [{ id: 'urn:vcloud:org:a1', name: 'team-a', isEnabled: true, isClassicTenant: false }] }), at('GET', QUOTAS, { resultTotal: 1, values: [{ name: 'team-a-region1', status: 'READY' }] })];
    const run = await allApps.run(existing, () => ({ dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([]);
    expect(run.result.outputs.problemCount).toBe(0);
    const other = await vmApps.run(existing, () => ({ dryRun: false }));
    expect(other.result.error ?? '').toContain('exists as All Apps, and the type cannot be changed');
    expect(other.writes).toEqual([]);
  });

  it('VM Apps: isClassicTenant true, and no quota to check', async () => {
    const run = await vmApps.run(none, () => ({ dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.calls).toEqual([`GET ${ORG_LIST}`, 'POST /cloudapi/1.0.0/orgs']);
    expect(bodyOf(run, 'POST', '/cloudapi/1.0.0/orgs').isClassicTenant).toBe(true);
  });

  it('stops at the cap and at a failed create', async () => {
    const capped = await allApps.run(none, () => ({ dryRun: false, cap: 0 }));
    expect(capped.result.error ?? '').toContain('Cap reached: 0 change(s) made, the cap is 0; stopping before: create All Apps organization team-a');
    expect(capped.writes).toEqual([]);
    const failed = await allApps.run([at('GET', ORG_LIST, { resultTotal: 0, values: [] }), at('POST', '/cloudapi/1.0.0/orgs', { message: `no, ${API_TOKEN}` }, 400)], () => ({ dryRun: false }));
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): create All Apps organization team-a failed');
    expect(failed.calls).toEqual([`GET ${ORG_LIST}`, 'POST /cloudapi/1.0.0/orgs']);
  });
});

// ---------------------------------------------------------------------------
// Region inventory, content library check, health check: read only

const byRegion = (what: string, values: unknown[]) => at('GET', `/cloudapi/vcf/${what}?filter=region.id%3D%3Durn%3Ar1&page=1&pageSize=128`, { resultTotal: values.length, values });

describe('vcfa 9.1: the read-only provider workflows', { skip: !CURL }, () => {
  const region = harness('vcfa91_region_zone');
  const library = harness('vcfa91_content_library');
  const health = harness('vcfa91_estate_check');
  after(() => [region, library, health].forEach((h) => h.stop()));

  const regionRoutes = (classes: string[]) => [
    at('GET', '/cloudapi/vcf/regions?filter=name%3D%3Dregion1&page=1&pageSize=128', { resultTotal: 1, values: [{ id: 'urn:r1', name: 'region1', status: 'READY', cpuCapacityMHz: 500000, memoryCapacityMiB: 2097152 }] }),
    byRegion('zones', [{ name: 'zone-a' }]),
    byRegion('supervisors', [{ name: 'supervisor-wld01' }]),
    byRegion('virtualMachineClasses', classes.map((name) => ({ name }))),
    byRegion('regionStoragePolicies', [{ name: 'vSAN Default Storage Policy' }]),
    byRegion('storageClasses', [{ name: 'vsan-default-storage-policy' }]),
  ];

  it('region: reads the region and everything in it, and passes when all is there', async () => {
    const run = await region.run(regionRoutes(['best-effort-small', 'best-effort-medium', 'best-effort-large', 'guaranteed-medium']), () => ({}));
    expect(run.result.error).toBe(null);
    expect(run.requests.filter((r) => !isLogin(r)).every((r) => r.method === 'GET')).toBe(true);
    expect(run.calls.map((c) => c.split('?')[0])).toEqual(['GET /cloudapi/vcf/regions', 'GET /cloudapi/vcf/zones', 'GET /cloudapi/vcf/supervisors', 'GET /cloudapi/vcf/virtualMachineClasses', 'GET /cloudapi/vcf/regionStoragePolicies', 'GET /cloudapi/vcf/storageClasses']);
    expect(run.requests.find((r) => r.path.startsWith('/oauth/'))!.path).toBe('/oauth/provider/token');
    const inv = JSON.parse(String(run.result.outputs.inventory)) as { zones: string[]; vmClasses: string[]; status: string };
    expect(inv.zones).toEqual(['zone-a']);
    expect(inv.status).toBe('READY');
  });

  it('region: fails on a missing VM class and on a path that moved', async () => {
    const routes = regionRoutes(['best-effort-small']).filter((r) => !r.path.includes('storageClasses'));
    const run = await region.run(routes, () => ({}));
    expect(run.result.outputs.problemCount).toBe(4);
    expect(run.result.error ?? '').toContain('VM class best-effort-medium is missing');
    expect(run.result.error ?? '').toContain('storage classes could not be read (VERIFY /cloudapi/vcf/storageClasses)');
    expect(run.writes).toEqual([]);
  });

  const libRoutes = (itemStatus: string) => [
    at('GET', '/cloudapi/vcf/contentLibraries?filter=name%3D%3Dteam-a-images&page=1&pageSize=128', { resultTotal: 1, values: [{ id: 'urn:cl:1', name: 'team-a-images', status: 'READY', libraryType: 'LOCAL' }] }),
    at('GET', '/cloudapi/vcf/contentLibraryItems?filter=contentLibrary.id%3D%3Durn%3Acl%3A1&page=1&pageSize=128', { resultTotal: 1, values: [{ name: 'ubuntu-24.04-server', itemType: 'TEMPLATE', imageIdentifier: 'vmi-abc', status: itemStatus }] }),
  ];

  it('content library: lists the items with their image identifiers, as the organization, reading only', async () => {
    const run = await library.run(libRoutes('READY'), () => ({ vcfaOrg: 'team-a' }));
    expect(run.result.error).toBe(null);
    expect(run.requests.find((r) => r.path.startsWith('/oauth/'))!.path).toBe('/oauth/tenant/team-a/token');
    expect(String(run.result.outputs.itemReport)).toBe('name,type,imageIdentifier,status\nubuntu-24.04-server,TEMPLATE,vmi-abc,READY\n');
    expect(run.writes).toEqual([]);
    const bad = await library.run(libRoutes('PARTIALLY_READY'), () => ({ vcfaOrg: 'team-a' }));
    expect(bad.result.error ?? '').toContain('item ubuntu-24.04-server is PARTIALLY_READY');
  });

  it('health: reads the five lists, and reports what is disabled, not READY, expiring or missing', async () => {
    const list = (path: string, values: unknown[]) => at('GET', `/cloudapi/${path}${path.includes('?') ? '&' : '?'}page=1&pageSize=128`, { resultTotal: values.length, values });
    const run = await health.run(
      [
        list('1.0.0/orgs', [{ name: 'team-a', isEnabled: true }, { name: 'team-z', isEnabled: false }]),
        list('vcf/regions', [{ name: 'region1', status: 'READY' }]),
        list('vcf/virtualDatacenters', [{ name: 'team-a-region1', status: 'READY' }]),
        list('1.0.0/tokens?filter=type%3D%3DREFRESH', [{ name: 'provider-nightly', expirationDate: soonDate }]),
      ],
      () => ({}),
    );
    expect(run.calls.map((c) => c.split('?')[0])).toEqual(['GET /cloudapi/1.0.0/orgs', 'GET /cloudapi/vcf/regions', 'GET /cloudapi/vcf/virtualDatacenters', 'GET /cloudapi/vcf/contentLibraries', 'GET /cloudapi/1.0.0/tokens']);
    expect(run.writes).toEqual([]);
    expect(run.result.outputs.problemCount).toBe(3);
    expect(run.result.error ?? '').toContain('organizations team-z is disabled');
    expect(run.result.error ?? '').toContain('content libraries: could not be read (VERIFY /cloudapi/vcf/contentLibraries)');
    expect(run.result.error ?? '').toContain('API tokens provider-nightly expires within 14 days');
  });
});

// ---------------------------------------------------------------------------
// Kubernetes objects in a namespace: VPC subnets, VM, database, Argo CD, security policy

const K = '/k8s';
const NS_DEV = 'team-a-dev-x7k2p';
const NS_PROD = 'team-a-prod-q4m8z';
const kubeSettings = (host: string) => ({ vcfaOrg: 'team-a', kubeServer: `https://${host}${K}/` });
const served = (gv: string) => at('GET', `${K}/apis/${gv}`, { kind: 'APIResourceList', groupVersion: gv });
const absent = (path: string) => at('GET', `${K}${path}`, { kind: 'Status', code: 404 }, 404);
const present = (path: string) => at('GET', `${K}${path}`, { metadata: { name: path.split('/').pop() } });
const created = (path: string, status?: number) => ({ method: 'POST', path: `^${esc(`${K}${path}`)}(\\?dryRun=All)?$`, body: status ? { message: 'refused' } : {}, ...(status ? { status } : {}) });

describe('vcfa 9.1: VPC subnets, as an Orchestrator package', { skip: !CURL }, () => {
  const h = harness('vcfa91_vpc');
  after(() => h.stop());
  const SUBNETS = `/apis/crd.nsx.vmware.com/v1alpha1/namespaces/${NS_DEV}/subnets`;
  const routes = (postStatus?: number) => [served('crd.nsx.vmware.com/v1alpha1'), absent(`${SUBNETS}/web`), present(`${SUBNETS}/app`), absent(`${SUBNETS}/db`), created(SUBNETS, postStatus)];

  it('dry run: the server validates each new subnet (dryRun=All), nothing is created, what exists is left', async () => {
    const run = await h.run(routes(), kubeSettings);
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([]);
    expect(run.calls).toEqual([`GET ${K}/apis/crd.nsx.vmware.com/v1alpha1`, `GET ${K}${SUBNETS}/web`, `POST ${K}${SUBNETS}?dryRun=All`, `GET ${K}${SUBNETS}/app`, `GET ${K}${SUBNETS}/db`, `POST ${K}${SUBNETS}?dryRun=All`]);
    expect(run.result.logs.some((l) => l.message === `Exists, left as it is: subnet app (Private, 64 addresses) in ${NS_DEV}`)).toBe(true);
    expect(run.requests.every((r) => isLogin(r) || r.headers.authorization === `Bearer ${ACCESS}`)).toBe(true);
  });

  it('armed: creates the two missing subnets, in order, with their access mode and size', async () => {
    const run = await h.run(routes(), (host) => ({ ...kubeSettings(host), dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([`POST ${K}${SUBNETS}`, `POST ${K}${SUBNETS}`]);
    const posts = run.requests.filter((r) => r.method === 'POST' && r.path === `${K}${SUBNETS}`).map((r) => JSON.parse(r.body) as { metadata: { name: string }; spec: { accessMode: string; ipv4SubnetSize: number } });
    expect(posts.map((p) => `${p.metadata.name}:${p.spec.accessMode}:${p.spec.ipv4SubnetSize}`)).toEqual(['web:Public:16', 'db:PrivateTGW:32']);
    expect(run.result.outputs.createdObjects).toBe('Subnet/web, Subnet/db');
  });

  it('stops at the cap, at the first failure, and before anything when the group is not served', async () => {
    const capped = await h.run(routes(), (host) => ({ ...kubeSettings(host), dryRun: false, cap: 1 }));
    expect(capped.writes.length).toBe(1);
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: create subnet db');
    const failed = await h.run(routes(500), (host) => ({ ...kubeSettings(host), dryRun: false }));
    expect(failed.writes).toEqual([`POST ${K}${SUBNETS}`]);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): create subnet web');
    const unserved = await h.run([absent('/apis/crd.nsx.vmware.com/v1alpha1')], (host) => ({ ...kubeSettings(host), dryRun: false }));
    expect(unserved.result.error ?? '').toContain('crd.nsx.vmware.com/v1alpha1 is not served');
    expect(unserved.calls).toEqual([`GET ${K}/apis/crd.nsx.vmware.com/v1alpha1`]);
  });

  it('refuses a kubeServer that is not an https URL, before logging in', async () => {
    const run = await h.run(routes(), () => ({ vcfaOrg: 'team-a', kubeServer: 'kubernetes.local' }));
    expect(run.result.error ?? '').toContain('Set kubeServer');
    expect(run.requests.some((r) => r.path.startsWith('/oauth/'))).toBe(false);
  });
});

describe('vcfa 9.1: VM Service VM, as an Orchestrator package', { skip: !CURL }, () => {
  const h = harness('vcfa91_vm_service');
  const full = harness('vcfa91_vm_service', { data_disk_gib: 20, load_balancer: true });
  after(() => {
    h.stop();
    full.stop();
  });
  const VMOP = `/apis/vmoperator.vmware.com/v1alpha5/namespaces/${NS_DEV}`;
  const SECRETS = `/api/v1/namespaces/${NS_DEV}/secrets`;
  const base = (imageVisible = true) => [
    served('vmoperator.vmware.com/v1alpha5'),
    imageVisible ? present(`${VMOP}/virtualmachineimages/vmi-0123456789abcdef0`) : absent(`${VMOP}/virtualmachineimages/vmi-0123456789abcdef0`),
    absent('/apis/vmoperator.vmware.com/v1alpha5/clustervirtualmachineimages/vmi-0123456789abcdef0'),
    present(`${VMOP}/virtualmachineclasses/best-effort-small`),
    absent(`${SECRETS}/web01-cloud-init`),
    created(SECRETS),
    absent(`${VMOP}/virtualmachines/web01`),
    created(`${VMOP}/virtualmachines`),
    absent(`/api/v1/namespaces/${NS_DEV}/persistentvolumeclaims/web01-data`),
    created(`/api/v1/namespaces/${NS_DEV}/persistentvolumeclaims`),
    absent(`${VMOP}/virtualmachineservices/web01-lb`),
    created(`${VMOP}/virtualmachineservices`),
  ];

  it('dry run: checks image and class, validates the Secret and the VM on the server, creates nothing', async () => {
    const run = await h.run(base(), kubeSettings);
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([]);
    expect(run.calls.filter((c) => c.startsWith('POST'))).toEqual([`POST ${K}${SECRETS}?dryRun=All`, `POST ${K}${VMOP}/virtualmachines?dryRun=All`]);
  });

  it('armed: the cloud-init Secret, then the VM that names it, on the subnet', async () => {
    const run = await h.run(base(), (host) => ({ ...kubeSettings(host), dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([`POST ${K}${SECRETS}`, `POST ${K}${VMOP}/virtualmachines`]);
    const vm = bodyOf(run, 'POST', `${K}${VMOP}/virtualmachines`) as { spec: { imageName: string; className: string; bootstrap: { cloudInit: { rawCloudConfig: { name: string } } }; network: { interfaces: { network: { name: string; kind: string } }[] } } };
    expect(vm.spec.imageName).toBe('vmi-0123456789abcdef0');
    expect(vm.spec.bootstrap.cloudInit.rawCloudConfig.name).toBe('web01-cloud-init');
    expect(vm.spec.network.interfaces[0]!.network).toEqual({ name: 'web', kind: 'Subnet', apiVersion: 'crd.nsx.vmware.com/v1alpha1' });
    const secret = bodyOf(run, 'POST', `${K}${SECRETS}`) as { stringData: Record<string, string> };
    expect(secret.stringData['user-data']!.startsWith('#cloud-config\n')).toBe(true);
  });

  it('with a data disk and a load balancer: four objects, in order', async () => {
    const run = await full.run(base(), (host) => ({ ...kubeSettings(host), dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([`POST ${K}${SECRETS}`, `POST ${K}/api/v1/namespaces/${NS_DEV}/persistentvolumeclaims`, `POST ${K}${VMOP}/virtualmachines`, `POST ${K}${VMOP}/virtualmachineservices`]);
    expect((bodyOf(run, 'POST', `${K}${VMOP}/virtualmachineservices`) as { spec: { ports: { port: number }[] } }).spec.ports[0]!.port).toBe(443);
  });

  it('stops before sending anything when the image is not visible', async () => {
    const run = await h.run(base(false), (host) => ({ ...kubeSettings(host), dryRun: false }));
    expect(run.result.error ?? '').toContain('Image vmi-0123456789abcdef0 is not visible');
    expect(run.calls.some((c) => c.startsWith('POST'))).toBe(false);
  });
});

describe('vcfa 9.1: Data Services database, as an Orchestrator package', { skip: !CURL }, () => {
  const h = harness('vcfa91_data_services');
  after(() => h.stop());
  const SECRETS = `/api/v1/namespaces/${NS_PROD}/secrets`;
  const DBS = `/apis/databases.dataservices.vmware.com/v1alpha1/namespaces/${NS_PROD}/postgresclusters`;
  const routes = (dbExists = false) => [served('databases.dataservices.vmware.com/v1alpha1'), absent(`${SECRETS}/orders-db-admin`), created(SECRETS), dbExists ? present(`${DBS}/orders-db`) : absent(`${DBS}/orders-db`), created(DBS)];
  const withPassword = (host: string) => ({ ...kubeSettings(host), dbAdminPassword: DB_PASSWORD });

  it('refuses to run without the admin password, before logging in', async () => {
    const run = await h.run(routes(), kubeSettings);
    expect(run.result.error ?? '').toContain('Set dbAdminPassword');
    expect(run.calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('dry run: both validated on the server, nothing created, the password in no log', async () => {
    const run = await h.run(routes(), withPassword);
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([]);
    expect(run.calls.filter((c) => c.startsWith('POST'))).toEqual([`POST ${K}${SECRETS}?dryRun=All`, `POST ${K}${DBS}?dryRun=All`]);
  });

  it('armed: the admin Secret from the SecureString, then the PostgresCluster that refers to it', async () => {
    const run = await h.run(routes(), (host) => ({ ...withPassword(host), dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([`POST ${K}${SECRETS}`, `POST ${K}${DBS}`]);
    expect(bodyOf(run, 'POST', `${K}${SECRETS}`)).toEqual({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'orders-db-admin', namespace: NS_PROD }, type: 'Opaque', stringData: { username: 'dbadmin', password: DB_PASSWORD } });
    const db = bodyOf(run, 'POST', `${K}${DBS}`) as { spec: { adminPasswordRef: { name: string }; replicas: number; backupConfig: { backupRetentionDays: number } } };
    expect(db.spec.adminPasswordRef.name).toBe('orders-db-admin');
    expect(db.spec.replicas).toBe(1);
    expect(db.spec.backupConfig.backupRetentionDays).toBe(30);
  });

  it('leaves an existing database alone', async () => {
    const run = await h.run(routes(true), (host) => ({ ...withPassword(host), dryRun: false }));
    expect(run.writes).toEqual([`POST ${K}${SECRETS}`]);
    expect(run.result.logs.some((l) => l.message === `Exists, left as it is: PostgresCluster orders-db in ${NS_PROD}`)).toBe(true);
  });
});

describe('vcfa 9.1: Argo CD and the security policy, as Orchestrator packages', { skip: !CURL }, () => {
  const argo = harness('vcfa91_argocd');
  const policy = harness('vcfa91_security_policy');
  after(() => {
    argo.stop();
    policy.stop();
  });
  const NS = 'team-a-gitops-k3v9s';
  const ARGO = `/apis/argocd-service.vsphere.vmware.com/v1alpha1/namespaces/${NS}/argocds`;
  const APPS = `/apis/argoproj.io/v1alpha1/namespaces/${NS}/applications`;
  const argoRoutes = [served('argocd-service.vsphere.vmware.com/v1alpha1'), served('argoproj.io/v1alpha1'), absent(`${ARGO}/argocd`), created(ARGO), absent(`${APPS}/orders`), created(APPS)];

  it('Argo CD: the instance only, unless createApplication is set; then the Application, manual sync', async () => {
    const one = await argo.run(argoRoutes, (host) => ({ ...kubeSettings(host), dryRun: false }));
    expect(one.result.error).toBe(null);
    expect(one.writes).toEqual([`POST ${K}${ARGO}`]);
    expect(bodyOf(one, 'POST', `${K}${ARGO}`)).toEqual({ apiVersion: 'argocd-service.vsphere.vmware.com/v1alpha1', kind: 'ArgoCD', metadata: { name: 'argocd', namespace: NS }, spec: { version: '3.0.19+vmware.1-vks.1' } });
    const both = await argo.run(argoRoutes, (host) => ({ ...kubeSettings(host), dryRun: false, createApplication: true }));
    expect(both.writes).toEqual([`POST ${K}${ARGO}`, `POST ${K}${APPS}`]);
    const app = bodyOf(both, 'POST', `${K}${APPS}`) as { spec: { syncPolicy: Record<string, unknown>; destination: { name: string } } };
    expect('automated' in app.spec.syncPolicy).toBe(false);
    expect(app.spec.destination.name).toBe('team-a-prod-01');
    const dry = await argo.run(argoRoutes, kubeSettings);
    expect(dry.writes).toEqual([]);
  });

  const POL = `/apis/crd.nsx.vmware.com/v1alpha1/namespaces/${NS_PROD}/securitypolicies`;
  const policyRoutes = (exists = false) => [
    served('crd.nsx.vmware.com/v1alpha1'),
    at('GET', `${K}/apis/vmoperator.vmware.com/v1alpha5/namespaces/${NS_PROD}/virtualmachines?labelSelector=app%3Dweb01`, { items: [{ metadata: { name: 'web01' } }] }),
    exists ? present(`${POL}/web-tier`) : absent(`${POL}/web-tier`),
    created(POL),
  ];

  it('security policy: logs the VMs it will cover, then creates it with the rules and the drop', async () => {
    const run = await policy.run(policyRoutes(), (host) => ({ ...kubeSettings(host), dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.result.logs.some((l) => l.message === 'VMs the policy will cover (app=web01): web01')).toBe(true);
    expect(run.writes).toEqual([`POST ${K}${POL}`]);
    const body = bodyOf(run, 'POST', `${K}${POL}`) as { spec: { appliedTo: unknown[]; rules: { name: string; action: string; sources?: unknown[] }[] } };
    expect(body.spec.appliedTo).toEqual([{ vmSelector: { matchLabels: { app: 'web01' } } }]);
    expect(body.spec.rules.map((r) => `${r.name}:${r.action}`)).toEqual(['allow-tcp-443-1:Allow', 'allow-tcp-22-2:Allow', 'drop-other-inbound:Drop']);
    expect(body.spec.rules[0]!.sources).toEqual([{ ipBlocks: [{ cidr: '10.0.0.0/8' }] }]);
    expect(body.spec.rules[1]!.sources).toEqual([{ vmSelector: { matchLabels: { app: 'bastion' } } }]);
  });

  it('security policy: a dry run creates nothing, and an existing policy is left alone', async () => {
    const dry = await policy.run(policyRoutes(), kubeSettings);
    expect(dry.writes).toEqual([]);
    expect(dry.calls.includes(`POST ${K}${POL}?dryRun=All`)).toBe(true);
    const existing = await policy.run(policyRoutes(true), (host) => ({ ...kubeSettings(host), dryRun: false }));
    expect(existing.writes).toEqual([]);
    expect(existing.calls.some((c) => c.startsWith('POST'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Namespace day 2

describe('vcfa 9.1: namespace day 2, as an Orchestrator package', { skip: !CURL }, () => {
  const h = harness('vcfa91_namespace_day2');
  after(() => h.stop());
  const NSPATH = `/cci/kubernetes/apis/infrastructure.cci.vmware.com/v1alpha3/namespaces/proj-a/supervisornamespaces/${NS_DEV}`;
  const current = (cpu: string) => ({ apiVersion: 'infrastructure.cci.vmware.com/v1alpha3', kind: 'SupervisorNamespace', metadata: { name: NS_DEV }, spec: { className: 'small', initialClassConfigOverrides: { zones: [{ name: 'zone-a', cpuLimit: cpu, memoryLimit: '98304Mi' }] } } });
  const routes = (cpu = '10000M', patchStatus?: number) => [at('GET', NSPATH, current(cpu)), { method: 'PATCH', path: `^${esc(NSPATH)}(\\?dryRun=All)?$`, body: patchStatus ? { message: 'exceeds quota' } : current('30000M'), ...(patchStatus ? { status: patchStatus } : {}) }];
  const settings = () => ({ vcfaOrg: 'team-a', project: 'proj-a' });

  it('dry run: reads it (the undo), validates the merge patch on the server, changes nothing', async () => {
    const run = await h.run(routes(), settings);
    expect(run.result.error).toBe(null);
    expect(run.calls).toEqual([`GET ${NSPATH}`, `PATCH ${NSPATH}?dryRun=All`]);
    expect(run.writes).toEqual([]);
    expect((JSON.parse(String(run.result.outputs.before)) as { spec: { initialClassConfigOverrides: { zones: { cpuLimit: string }[] } } }).spec.initialClassConfigOverrides.zones[0]!.cpuLimit).toBe('10000M');
  });

  it('armed: the server-side dry run, then the merge patch with patch.json', async () => {
    const run = await h.run(routes(), () => ({ ...settings(), dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.calls).toEqual([`GET ${NSPATH}`, `PATCH ${NSPATH}?dryRun=All`, `PATCH ${NSPATH}`]);
    const patch = run.requests.find((r) => r.method === 'PATCH' && r.path === NSPATH)!;
    expect(patch.headers['content-type']).toBe('application/merge-patch+json');
    expect(JSON.parse(patch.body)).toEqual({ spec: { initialClassConfigOverrides: { zones: [{ name: 'zone-a', cpuLimit: '30000M', memoryLimit: '98304Mi' }] } } });
    expect(run.requests.find((r) => r.path.startsWith('/oauth/'))!.path).toBe('/oauth/tenant/team-a/token');
  });

  it('leaves a namespace that already has the values alone, and stops when the server refuses the patch', async () => {
    const same = await h.run(routes('30000M'), () => ({ ...settings(), dryRun: false }));
    expect(same.calls).toEqual([`GET ${NSPATH}`]);
    const refused = await h.run(routes('10000M', 422), () => ({ ...settings(), dryRun: false }));
    expect(refused.result.error ?? '').toContain('returned HTTP 422');
    expect(refused.writes).toEqual([]);
    const missing = await h.run([], () => ({ ...settings(), dryRun: false }));
    expect(missing.result.error ?? '').toContain('not changing what could not be read and saved');
  });
});

// ---------------------------------------------------------------------------
// Tag placement: zones and the template, through /iaas/api and /blueprint/api

describe('vcfa 9.1: tag placement, as an Orchestrator package', { skip: !CURL }, () => {
  const h = harness('vcfa91_tags_placement');
  after(() => h.stop());
  const zone = (id: string, name: string, tags: { key: string; value: string }[]) => ({ id, name, regionId: `region-${id}`, placementPolicy: 'DEFAULT', tags });
  const ZONES = [zone('z1', 'Production zone A', [{ key: 'Environment', value: 'Production' }, { key: 'Owner', value: 'ops' }]), zone('z2', 'Production zone B', [{ key: 'Environment', value: 'Production' }, { key: 'Tier', value: 'Silver' }, { key: 'DataClass', value: 'Internal' }]), zone('z3', 'Non-production zone', [])];
  const routes = (zones = ZONES, extra: FakeRoute[] = []) => [
    at('GET', '/iaas/api/zones?$top=200&$skip=0', { content: zones, totalElements: zones.length, numberOfElements: zones.length }),
    ...zones.map((z) => at('GET', `/iaas/api/zones/${z.id}`, z)),
    { method: 'PATCH', path: '^/iaas/api/zones/z[0-9]$', body: {} },
    at('POST', '/blueprint/api/blueprint-validation', { valid: true, validationMessages: [] }),
    at('GET', '/blueprint/api/blueprints?name=Tag%20placement%20example&size=200', { content: [] }),
    at('POST', '/blueprint/api/blueprints', { id: 'bp-9' }),
    at('GET', '/blueprint/api/blueprints/bp-9/versions?size=200', { content: [] }),
    at('POST', '/blueprint/api/blueprints/bp-9/versions', { id: 'v1' }),
    ...extra,
  ];
  const settings = () => ({ vcfaOrg: 'team-a', projectId: 'proj-1' });

  it('dry run: reads the zones and validates the template; writes nothing', async () => {
    const run = await h.run(routes(), settings);
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([]);
    expect(run.result.logs.filter((l) => l.message.startsWith('DRY RUN: would add capability tags')).length).toBe(2);
    expect(run.result.logs.some((l) => l.message === 'DRY RUN: would create template Tag placement example in project proj-1')).toBe(true);
    expect(run.result.logs.some((l) => l.message === 'DRY RUN: would create version 1.0.0 of template Tag placement example')).toBe(true);
  });

  it('armed: adds only the missing tags to each zone, sending the whole zone, then imports and versions the template', async () => {
    const run = await h.run(routes(), () => ({ ...settings(), dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual(['PATCH /iaas/api/zones/z1', 'PATCH /iaas/api/zones/z3', 'POST /blueprint/api/blueprints', 'POST /blueprint/api/blueprints/bp-9/versions']);
    const z1 = bodyOf(run, 'PATCH', '/iaas/api/zones/z1') as { name: string; regionId: string; placementPolicy: string; tags: { key: string; value: string }[] };
    expect(z1.name).toBe('Production zone A');
    expect(z1.regionId).toBe('region-z1');
    expect(z1.placementPolicy).toBe('DEFAULT');
    // What the zone had stays; the standard's tags are added once.
    expect(z1.tags.map((t) => `${t.key}:${t.value}`)).toEqual(['Environment:Production', 'Owner:ops', 'Tier:Gold', 'DataClass:Confidential', 'DataClass:Internal']);
    const template = bodyOf(run, 'POST', '/blueprint/api/blueprints') as { name: string; projectId: string; requestScopeOrg: boolean; content: string };
    expect(template.projectId).toBe('proj-1');
    expect(template.requestScopeOrg).toBe(false);
    expect(template.content).toBe(h.files[Object.keys(h.files).find((p) => p.startsWith('import/templates/') && p.endsWith('/blueprint.yaml'))!]!);
    expect(bodyOf(run, 'POST', '/blueprint/api/blueprints/bp-9/versions')).toEqual({ version: '1.0.0', description: 'Generated by ArchToolKit. Placement constraints and resource tags from the tag standard.', changeLog: 'Imported by ArchToolKit', release: false });
  });

  it('skips a zone whose name is not unique, and fails when a hard constraint then cannot be met', async () => {
    const twice = [...ZONES.slice(0, 2), zone('z3', 'Non-production zone', []), zone('z4', 'Non-production zone', [])];
    const run = await h.run(routes(twice), () => ({ ...settings(), dryRun: false }));
    expect(run.writes.filter((w) => w.startsWith('PATCH'))).toEqual(['PATCH /iaas/api/zones/z1']);
    expect(run.result.logs.some((l) => l.message === 'Zone "Non-production zone": 2 zones have that name — skipped.')).toBe(true);
    expect(run.result.error ?? '').toContain('2 tag(s) a hard constraint can ask for are on no cloud zone: Environment:Staging, Environment:Development');
  });

  it('stops at the cap, and leaves the template alone when its draft and version are already there', async () => {
    const capped = await h.run(routes(), () => ({ ...settings(), dryRun: false, cap: 1 }));
    expect(capped.writes).toEqual(['PATCH /iaas/api/zones/z1']);
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made');
    const content = h.files[Object.keys(h.files).find((p) => p.startsWith('import/templates/') && p.endsWith('/blueprint.yaml'))!];
    const done = ZONES.map((z) => ({ ...z, tags: [{ key: 'Environment', value: 'Production' }, { key: 'Environment', value: 'Staging' }, { key: 'Environment', value: 'Development' }, { key: 'Tier', value: 'Gold' }, { key: 'Tier', value: 'Silver' }, { key: 'Tier', value: 'Bronze' }, { key: 'DataClass', value: 'Confidential' }, { key: 'DataClass', value: 'Internal' }, { key: 'DataClass', value: 'Public' }] }));
    const existing = await h.run(
      [
        at('GET', '/blueprint/api/blueprints?name=Tag%20placement%20example&size=200', { content: [{ id: 'bp-1', name: 'Tag placement example', projectId: 'proj-1' }] }),
        at('GET', '/blueprint/api/blueprints/bp-1', { id: 'bp-1', content }),
        at('GET', '/blueprint/api/blueprints/bp-1/versions?size=200', { content: [{ version: '1.0.0' }] }),
        ...routes(done),
      ],
      () => ({ ...settings(), dryRun: false }),
    );
    expect(existing.result.error).toBe(null);
    expect(existing.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Template versions

describe('vcfa 9.1: template versions, as an Orchestrator package', { skip: !CURL }, () => {
  const h = harness('vcfa91_blueprint_versions');
  const moved = harness('vcfa91_blueprint_versions', { import_to: 'team-b' });
  after(() => {
    h.stop();
    moved.stop();
  });
  const LIST = '/blueprint/api/blueprints?name=Standard%20Linux%20server&size=200';
  const YAML = 'formatVersion: 1\nresources: {}\n';
  const source = (versions: string[] = ['1.3.0'], templates = [{ id: 'bp-1', name: 'Standard Linux server' }]) => [
    { method: 'GET', path: `^${esc(LIST)}$`, responses: [{ body: { content: templates } }, { body: { content: [] } }] },
    at('GET', '/blueprint/api/blueprints/bp-1', { id: 'bp-1', content: YAML }),
    at('GET', '/blueprint/api/blueprints/bp-1/versions?size=200', { content: versions.map((version) => ({ version })) }),
    at('POST', '/blueprint/api/blueprints/bp-1/versions', { id: 'v' }),
    at('POST', '/blueprint/api/blueprints', { id: 'bp-77' }),
  ];
  const settings = () => ({ vcfaOrg: 'team-a' });

  it('dry run: finds the one template, exports its YAML, plans the version, writes nothing', async () => {
    const run = await h.run(source(), settings);
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([]);
    expect(run.result.outputs.templateYaml).toBe(YAML);
    expect(run.result.logs.some((l) => l.message === 'DRY RUN: would create version 1.4.0 of template Standard Linux server and release it to the catalog')).toBe(true);
  });

  it('armed: creates the version with its change log and release', async () => {
    const run = await h.run(source(), () => ({ ...settings(), dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.calls).toEqual([`GET ${LIST}`, 'GET /blueprint/api/blueprints/bp-1', 'GET /blueprint/api/blueprints/bp-1/versions?size=200', 'POST /blueprint/api/blueprints/bp-1/versions']);
    expect(bodyOf(run, 'POST', '/blueprint/api/blueprints/bp-1/versions')).toEqual({ version: '1.4.0', description: 'Generated by ArchToolKit. Pin image to rhel9-2026-09; lease 60 days', changeLog: 'Pin image to rhel9-2026-09; lease 60 days', release: true });
  });

  it('leaves an existing version alone, and refuses a name two templates share', async () => {
    const exists = await h.run(source(['1.3.0', '1.4.0']), () => ({ ...settings(), dryRun: false }));
    expect(exists.result.error).toBe(null);
    expect(exists.writes).toEqual([]);
    const two = await h.run(source(['1.3.0'], [{ id: 'bp-1', name: 'Standard Linux server' }, { id: 'bp-2', name: 'Standard Linux server' }]), () => ({ ...settings(), dryRun: false }));
    expect(two.result.error ?? '').toContain('2 templates are named "Standard Linux server"');
    expect(two.writes).toEqual([]);
  });

  it('into another organization: logs in with its own token and creates the draft in its project', async () => {
    const run = await moved.run(source(), () => ({ ...settings(), dryRun: false, targetApiToken: TARGET_TOKEN, targetProjectId: 'proj-b' }));
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual(['POST /blueprint/api/blueprints/bp-1/versions', 'POST /blueprint/api/blueprints']);
    const login = run.requests.find((r) => r.path === '/oauth/tenant/team-b/token')!;
    expect(login.body).toBe(`grant_type=refresh_token&refresh_token=${TARGET_TOKEN}`);
    const create = run.requests.find((r) => r.method === 'POST' && r.path === '/blueprint/api/blueprints')!;
    expect(create.headers.authorization).toBe(`Bearer ${TARGET_ACCESS}`);
    expect(JSON.parse(create.body)).toEqual({ name: 'Standard Linux server', description: 'Imported by ArchToolKit', projectId: 'proj-b', requestScopeOrg: false, content: YAML });
    expect(run.result.outputs.importedId).toBe('bp-77');
    const unset = await moved.run(source(), () => ({ ...settings(), dryRun: false }));
    expect(unset.result.error ?? '').toContain('Set targetApiToken and targetProjectId');
    expect(unset.writes).toEqual([]);
  });

  it('stops at the cap before the import', async () => {
    const run = await moved.run(source(), () => ({ ...settings(), dryRun: false, cap: 1, targetApiToken: TARGET_TOKEN, targetProjectId: 'proj-b' }));
    expect(run.writes).toEqual(['POST /blueprint/api/blueprints/bp-1/versions']);
    expect(run.result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: import template Standard Linux server');
  });
});
