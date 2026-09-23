/**
 * The tag and SDDC Manager automations (vcf-tags.ts, vcf-fleet.ts) as
 * Orchestrator packages: built, ES5, secrets empty, named in IMPORT.md — and
 * run in the emulator against fake endpoints in another process:
 *
 *   - the ones that change things write nothing in a dry run, make exactly the
 *     expected calls in order with the right bodies when armed, stop at the cap
 *     and at the first failure, and never log a secret;
 *   - a tag replace never leaves an object without a value: in a several-value
 *     category the new value is attached before the old one is detached; in a
 *     one-value category (where vCenter refuses a second value) a failed attach
 *     is rolled back at once, and a failed roll-back says so;
 *   - the read-only ones only GET (or POST the documented query and precheck
 *     calls) and produce the right output.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { readPackageSpec, type VroPackageSpec } from '../../kit/vro-package.ts';
import { automationFor } from '../blueprints/index.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../../testing/fake-rest-server.ts';

const CORE_DIR = 'com.archtoolkit.core.package';

const TAG_IDS = ['tags_taxonomy', 'tags_bulk_assign', 'tags_rules', 'tags_sync_control', 'tags_backup', 'tags_consume', 'tags_cleanup'];
const FLEET_IDS = ['fleet_password_rotation', 'fleet_certificate_check', 'fleet_health', 'fleet_backup_config', 'fleet_upgrade_precheck', 'fleet_host_commission'];

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

interface Pkg {
  readonly files: Record<string, string>;
  readonly dir: string;
  readonly spec: VroPackageSpec;
  readonly workflow: string;
  readonly configKey: string;
}

function pkg(id: string, overrides: BlueprintValues = {}): Pkg {
  const files = build(id, overrides);
  const packages = packagesIn(files);
  const dir = Object.keys(packages).find((d) => d !== CORE_DIR)!;
  const spec = readPackageSpec(packages[dir]!);
  return { files, dir, spec, workflow: spec.workflows[0]!.name, configKey: `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}` };
}

const SECRET = 'Pa55-do-not-log';
const SAML = 'PHNhbWw6QXNzZXJ0aW9uPmZha2U8L3NhbWw6QXNzZXJ0aW9uPg';
const API_TOKEN = 'vcf-api-token-do-not-log';

function logText(run: WorkflowRun): string {
  return run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');
}

const servers: FakeServer[] = [];
after(() => servers.forEach((s) => s.stop()));

interface Ran {
  readonly result: WorkflowRun;
  readonly requests: FakeRequest[];
  readonly host: string;
  readonly emulator: VroEmulator;
}

/** Start the fake endpoints, run the package's workflow against them, check nothing secret was logged. */
async function runPkg(p: Pkg, routes: (host: string) => FakeRoute[], settings: (host: string) => Record<string, unknown>, inputs: (host: string) => Record<string, unknown> = () => ({})): Promise<Ran> {
  const server = await startFakeServer(routes('127.0.0.1'));
  servers.push(server);
  const host = `127.0.0.1:${server.port}`;
  const emulator = new VroEmulator(p.files, { config: { [p.configKey]: settings(host) } });
  const result = emulator.runWorkflow(p.workflow, inputs(host));
  expect(/do-not-log/.test(logText(result))).toBe(false);
  return { result, requests: server.requests(), host, emulator };
}

/** Requests that change something: anything but a GET and the reads that are POSTs. */
const READ_POSTS = /^\/api\/session$|^\/api\/vcenter\/authentication\/token$|action=list-|\/v1\/tokens$|\/acs\/t\/CUSTOMER\/token$|\/auth\/token\/(acquire|release)$|\/query(\?|$)|^\/hook$/;
function writes(requests: readonly FakeRequest[]): string[] {
  return requests.filter((r) => r.method !== 'GET' && !READ_POSTS.test(r.path)).map((r) => `${r.method} ${r.path}`);
}

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const at = (method: string, path: string, body: unknown, status?: number): FakeRoute => ({ method, path: `^${esc(path)}$`, body, ...(status ? { status } : {}) });

// ---------------------------------------------------------------------------
// A fake vCenter

interface Cat {
  readonly id: string;
  readonly name: string;
  readonly cardinality: 'SINGLE' | 'MULTIPLE';
  readonly associable_types?: readonly string[];
}
interface Tg {
  readonly id: string;
  readonly name: string;
  readonly category_id: string;
}

function catalogueRoutes(cats: readonly Cat[], tags: readonly Tg[]): FakeRoute[] {
  return [
    { method: 'POST', path: '^/api/session$', body: JSON.stringify('vc-session-do-not-log') },
    { method: 'DELETE', path: '^/api/session$', status: 204 },
    at('GET', '/api/cis/tagging/category', cats.map((c) => c.id)),
    ...cats.map((c) => at('GET', `/api/cis/tagging/category/${c.id}`, { associable_types: [], description: '', ...c })),
    at('GET', '/api/cis/tagging/tag', tags.map((t) => t.id)),
    ...tags.map((t) => at('GET', `/api/cis/tagging/tag/${t.id}`, { description: '', ...t })),
  ];
}

/** list-attached-tags-on-objects, answering in turn: one list of tag ids per call. */
const tagsOnObjects = (seq: readonly (readonly string[])[]): FakeRoute => ({
  method: 'POST',
  path: '^/api/cis/tagging/tag-association\\?action=list-attached-tags-on-objects$',
  responses: seq.map((ids) => ({ body: [{ object_id: {}, tag_ids: ids }] })),
});
const attachDetach = (fail: readonly string[] = []): FakeRoute[] => [
  ...fail.map((id) => ({ method: 'POST', path: `^/api/cis/tagging/tag-association/${esc(id)}\\?action=attach$`, status: 500, body: { error: 'Tagging cardinality violation' } })),
  { method: 'POST', path: '^/api/cis/tagging/tag-association/[^?]+\\?action=(attach|detach)$', body: '' },
];
const vcSettings = (host: string, extra: Record<string, unknown> = {}) => ({ vcenters: [host], vcUsername: 'svc@vsphere.local', vcPassword: SECRET, ...extra });

function csvRows(text: string): string[][] {
  return text
    .trim()
    .split('\n')
    .map((line) => line.split(','));
}

// ---------------------------------------------------------------------------

describe('pkg fleet-tags: every package builds and imports as it should', () => {
  for (const id of [...TAG_IDS, ...FLEET_IDS]) {
    it(`${id}: one package on the core library, ES5, secrets empty, named in IMPORT.md`, () => {
      const p = pkg(id);
      expect(Object.keys(packagesIn(p.files)).sort()).toEqual([CORE_DIR, p.dir].sort());
      expect(p.spec.name.startsWith(id.startsWith('tags_') ? 'com.archtoolkit.tags.' : 'com.archtoolkit.fleet.')).toBe(true);
      expect(p.spec.workflows.length).toBe(1);
      expect(p.spec.configs.length).toBe(1);
      const problems: string[] = [];
      for (const a of p.spec.actions) problems.push(...es5Problems(a.script, `${a.module}/${a.name}`));
      for (const w of p.spec.workflows) {
        const scripts = [...w.xml.matchAll(/<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/g)].map((m) => [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join(''));
        expect(scripts.length).toBe(1);
        problems.push(...es5Problems(scripts[0]!, w.name));
      }
      expect(problems).toEqual([]);
      // Every action a script calls on its own module is in the package.
      const names = new Set(p.spec.actions.map((a) => a.name));
      const called = [...p.spec.workflows.map((w) => w.xml), ...p.spec.actions.map((a) => a.script)].flatMap((text) => [...text.matchAll(/\bmod\.(\w+)\(/g)].map((m) => m[1]!));
      expect(called.filter((name) => !names.has(name))).toEqual([]);
      const secrets = p.spec.configs[0]!.attributes.filter((a) => a.type === 'SecureString');
      expect(secrets.length > 0).toBe(true);
      for (const s of secrets) expect(s.value === undefined || s.value === '').toBe(true);
      const armable = p.spec.configs[0]!.attributes.find((a) => a.name === 'dryRun');
      if (armable) expect(armable.value).toBe(true);
      expect(p.files['IMPORT.md']!.includes(`import/${p.dir}`)).toBe(true);
      expect(p.files['IMPORT.md']!.includes('import/com.archtoolkit.core.package')).toBe(true);
      for (const [path, text] of Object.entries(p.files)) if (path.endsWith('.json')) JSON.parse(text);
      // The existing script stays, as the fallback, under scripts/.
      expect(Object.keys(p.files).some((path) => path.startsWith('scripts/') && /\.(sh|ps1)$/.test(path))).toBe(true);
      for (const [path, text] of Object.entries(p.files)) if (/^scripts\/.*\.sh$/.test(path)) expect(/cd "\$\(dirname "\$0"\)/.test(text) || !/\b(jq -f|--data @|-f [a-z]+\.jq)/.test(text)).toBe(true);
    });
  }

  it('every package that changes something has the dryRun input and a cap', () => {
    for (const id of ['tags_taxonomy', 'tags_bulk_assign', 'tags_rules', 'tags_sync_control', 'tags_backup', 'tags_consume', 'tags_cleanup', 'fleet_password_rotation', 'fleet_backup_config', 'fleet_host_commission']) {
      const p = pkg(id);
      expect(p.spec.workflows[0]!.xml.includes('<param name="dryRun" type="boolean"')).toBe(true);
      expect(p.spec.configs[0]!.attributes.some((a) => a.name === 'cap')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// tags_taxonomy

const STANDARD = ['Environment | single | VirtualMachine | prod,test | VirtualMachine | Stage', 'Owner | single | VirtualMachine | team-a | | Owner'].join('\n');

describe('pkg fleet-tags: tags_taxonomy creates only what is missing', { skip: !CURL }, () => {
  const envCat: Cat = { id: 'c-env', name: 'Environment', cardinality: 'SINGLE', associable_types: ['VirtualMachine'] };
  const vcRoutes = (extra: FakeRoute[] = []) => () => [
    ...extra,
    ...catalogueRoutes([envCat], [{ id: 't-prod', name: 'prod', category_id: 'c-env' }]),
    { method: 'POST', path: '^/api/cis/tagging/category$', body: JSON.stringify('c-own') },
    { method: 'POST', path: '^/api/cis/tagging/tag$', responses: [{ body: JSON.stringify('t-test') }, { body: JSON.stringify('t-a') }] },
  ];
  const p = pkg('tags_taxonomy', { standard: STANDARD, route: 'vcenter' });

  it('dry run: reads, plans three creates, writes nothing', async () => {
    const { result, requests } = await runPkg(p, vcRoutes(), (h) => vcSettings(h));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would create')).map((l) => l.message.replace(/ on .*$/, ''))).toEqual(['DRY RUN: would create tag Environment=test', 'DRY RUN: would create category Owner (SINGLE)', 'DRY RUN: would create tag Owner=team-a']);
  });

  it('armed: creates the missing tag, the category, then its tag with the id it got', async () => {
    const { result, requests } = await runPkg(p, vcRoutes(), (h) => vcSettings(h, { dryRun: false }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual(['POST /api/cis/tagging/tag', 'POST /api/cis/tagging/category', 'POST /api/cis/tagging/tag']);
    const bodies = requests.filter((r) => r.method === 'POST' && /^\/api\/cis\/tagging\/(tag|category)$/.test(r.path)).map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(bodies[0]).toEqual({ name: 'test', description: 'Environment test (ArchToolKit tag standard)', category_id: 'c-env' });
    expect(bodies[1]).toEqual({ name: 'Owner', description: 'Owner', cardinality: 'SINGLE', associable_types: ['VirtualMachine'] });
    expect(bodies[2]!.category_id).toBe('c-own');
    expect(requests[requests.length - 1]!.method).toBe('DELETE');
    expect(JSON.parse(String(result.outputs.summary)).changes.length).toBe(3);
  });

  it('stops at the cap, and at the first failure — and still logs out', async () => {
    const capped = await runPkg(p, vcRoutes(), (h) => vcSettings(h, { dryRun: false, cap: 1 }));
    expect(writes(capped.requests)).toEqual(['POST /api/cis/tagging/tag']);
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: create category Owner');
    const failing = await runPkg(p, vcRoutes([{ method: 'POST', path: '^/api/cis/tagging/category$', status: 500, body: { message: `refused ${SECRET}` } }]), (h) => vcSettings(h, { dryRun: false }));
    expect(writes(failing.requests)).toEqual(['POST /api/cis/tagging/tag', 'POST /api/cis/tagging/category']);
    expect(failing.result.error ?? '').toContain('Stopped after 1 change(s): create category Owner (SINGLE)');
    expect(failing.requests[failing.requests.length - 1]!.method).toBe('DELETE');
  });

  it('reports a name that exists in another case, and drift, and creates neither', async () => {
    const r = await runPkg(p, () => [...catalogueRoutes([{ ...envCat, cardinality: 'MULTIPLE' }, { id: 'c-o', name: 'owner', cardinality: 'SINGLE' }], [{ id: 't-prod', name: 'prod', category_id: 'c-env' }]), { method: 'POST', path: '^/api/cis/tagging/tag$', body: JSON.stringify('t-test') }], (h) => vcSettings(h, { dryRun: false }));
    expect(writes(r.requests)).toEqual(['POST /api/cis/tagging/tag']);
    expect(r.result.error ?? '').toContain('2 problem(s) need a person');
    expect(r.result.outputs.problemCount).toBe(2);
  });

  const fleetRoutes = (extra: FakeRoute[] = []) => () => [
    ...extra,
    { method: 'POST', path: '^/acs/t/CUSTOMER/token$', body: { access_token: 'idb-access-do-not-log', token_type: 'Bearer' } },
    at('GET', '/suite-api/api/fleet-management/tag-management/categories/associable-types', { associableTypes: [{ adapterKind: 'VMWARE', resourceKinds: ['VirtualMachine', 'Folder'] }] }),
    {
      method: 'POST',
      path: '^/suite-api/api/fleet-management/tag-management/categories/query\\?',
      responses: [{ body: { categories: [{ id: 'f-env', name: 'Environment', cardinality: 'SINGLE' }], pageInfo: { totalCount: 1 } } }, { body: { categories: [{ id: 'f-x', name: 'OwnerHistory', cardinality: 'SINGLE' }], pageInfo: { totalCount: 1 } } }],
    },
    { method: 'POST', path: '^/suite-api/api/fleet-management/tag-management/categories/f-env/tags/query\\?', body: { tags: [{ id: 'ft-prod', name: 'prod' }], pageInfo: { totalCount: 1 } } },
    { method: 'POST', path: '^/suite-api/api/fleet-management/tag-management/categories$', body: { id: 'f-own' } },
    { method: 'POST', path: '^/suite-api/api/fleet-management/tag-management/categories/[^/]+/tags$', body: { id: 'ft-new' } },
    { method: 'POST', path: '^/suite-api/api/fleet-management/tag-management/adapters/ad-1/categories/(push|pull)$', status: 202, body: { taskId: 'task-1' } },
    { method: 'GET', path: '^/suite-api/api/fleet-management/tag-management/tasks/task-1$', responses: [{ body: { id: 'task-1', status: 'RUNNING' } }, { body: { id: 'task-1', status: 'SUCCESS' } }] },
  ];
  const fleetSettings = (h: string, extra: Record<string, unknown> = {}) => ({ opsHost: h, vcfIdbHost: h, vcfApiToken: API_TOKEN, ...extra });

  it('route fleet: creates centrally with the fleet API and pushes, with the identity-broker Bearer token', async () => {
    // Owner names no object types (*): it is created for every type fleet management lists.
    const f = pkg('tags_taxonomy', { standard: STANDARD.replace('Owner | single | VirtualMachine', 'Owner | single | *'), route: 'fleet' });
    const { result, requests } = await runPkg(f, fleetRoutes(), (h) => fleetSettings(h, { dryRun: false, fleetPushAdapters: ['ad-1'] }));
    expect(result.error).toBe(null);
    const tm = '/suite-api/api/fleet-management/tag-management';
    expect(writes(requests)).toEqual([`POST ${tm}/categories/f-env/tags`, `POST ${tm}/categories`, `POST ${tm}/categories/f-own/tags`, `POST ${tm}/adapters/ad-1/categories/push`]);
    const created = JSON.parse(requests.find((r) => r.path === `${tm}/categories`)!.body) as Record<string, unknown>;
    expect(created).toEqual({ name: 'Owner', description: 'Owner', cardinality: 'SINGLE', associableTypes: [{ adapterKind: 'VMWARE', resourceKinds: ['VirtualMachine', 'Folder'] }] });
    expect(JSON.parse(requests.find((r) => r.path.endsWith('/push'))!.body)).toEqual({ categoryIds: ['f-env', 'f-own'], overwrite: false });
    expect(requests.filter((r) => r.path.startsWith(tm)).every((r) => r.headers.authorization === 'Bearer idb-access-do-not-log')).toBe(true);
    expect(requests.filter((r) => r.path.endsWith('/tasks/task-1')).length).toBe(2);
  });

  it('route fleet: refuses object types fleet management does not list, before creating anything', async () => {
    const f = pkg('tags_taxonomy', { standard: 'Environment | single | VirtualMachine,Datastore | prod | VirtualMachine | x', route: 'fleet' });
    const { result, requests } = await runPkg(f, fleetRoutes(), (h) => fleetSettings(h, { dryRun: false }));
    expect(writes(requests)).toEqual([]);
    expect(result.error ?? '').toContain('does not list these object types: Datastore');
  });

  it('route both: vCenter first, then one import (pull) per adapter, then every category checked by exact name — all with the 9.1 API token', async () => {
    const f = pkg('tags_taxonomy', { standard: 'Environment | single | VirtualMachine | prod | VirtualMachine | x', route: 'both' });
    const routes = () => [...fleetRoutes()(), { method: 'POST', path: '^/api/vcenter/authentication/token$', body: { access_token: SAML } }, ...catalogueRoutes([envCat], [{ id: 't-prod', name: 'prod', category_id: 'c-env' }])];
    const dry = await runPkg(f, routes, (h) => ({ ...vcSettings(h), ...fleetSettings(h), fleetAdapters: ['ad-1'] }));
    expect(writes(dry.requests)).toEqual([]);
    expect(dry.result.logs.some((l) => l.message.startsWith('DRY RUN: would import (pull) the categories and tags of vCenter adapter ad-1'))).toBe(true);
    const armed = await runPkg(f, routes, (h) => ({ ...vcSettings(h), ...fleetSettings(h), fleetAdapters: ['ad-1'], dryRun: false }));
    expect(armed.result.error).toBe(null);
    expect(writes(armed.requests)).toEqual(['POST /suite-api/api/fleet-management/tag-management/adapters/ad-1/categories/pull']);
    const pull = armed.requests.findIndex((r) => r.path.endsWith('/pull'));
    const query = armed.requests.findIndex((r) => r.path.includes('/categories/query'));
    expect(pull < query).toBe(true);
    expect(armed.requests[pull]!.body).toBe('');
    // vCenter too was reached with the API token: no password anywhere.
    const sign = armed.requests.find((r) => r.path === '/api/session' && r.method === 'POST')!.headers.authorization!;
    expect(/^SIGN token="[A-Za-z0-9+/=]+"$/.test(sign)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tags_bulk_assign — and the replace rule

const BULK_CATS: Cat[] = [
  { id: 'c-env', name: 'Environment', cardinality: 'SINGLE', associable_types: ['VirtualMachine'] },
  { id: 'c-app', name: 'Application', cardinality: 'MULTIPLE', associable_types: ['VirtualMachine'] },
  { id: 'c-own', name: 'Owner', cardinality: 'SINGLE' },
];
const BULK_TAGS: Tg[] = [
  { id: 't-prod', name: 'prod', category_id: 'c-env' },
  { id: 't-test', name: 'test', category_id: 'c-env' },
  { id: 't-pay', name: 'pay', category_id: 'c-app' },
  { id: 't-web', name: 'web', category_id: 'c-app' },
  { id: 't-own-a', name: 'team-a', category_id: 'c-own' },
];
const vmByName = ['app1', 'app2', 'app3'].map((name, i) => at('GET', `/api/vcenter/vm?names=${name}`, [{ vm: `vm-${i + 1}`, name }]));

describe('pkg fleet-tags: tags_bulk_assign', { skip: !CURL }, () => {
  const p = pkg('tags_bulk_assign');
  const csv = (host: string, rows: string[]) => ['vcenter,object_type,object,category,tag', ...rows.map((r) => `${host},${r}`)].join('\n');
  const THREE = ['VirtualMachine,app1,Environment,prod', 'VirtualMachine,app2,Application,pay', 'VirtualMachine,app3,Owner,team-a'];
  const routes = (seq: string[][], fail: string[] = []) => () => [tagsOnObjects(seq), ...attachDetach(fail), ...vmByName, ...catalogueRoutes(BULK_CATS, BULK_TAGS)];
  // Planning reads app1 (test), app2 (none), app3 (team-a); the apply reads each object back.
  const PLAN_SEQ = [['t-test'], [], ['t-own-a']];

  it('dry run: plans replace, attach and unchanged, writes nothing', async () => {
    const { result, requests } = await runPkg(p, routes(PLAN_SEQ), (h) => vcSettings(h), (h) => ({ assignmentsCsv: csv(h, THREE), replace: true }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    const plan = csvRows(String(result.outputs.planCsv));
    expect(plan.slice(1).map((r) => `${r[2]} ${r[4]} ${r[6] || '-'}->${r[8]} ${r[9]}`)).toEqual(['vm-1 Environment test->prod replace', 'vm-2 Application -->pay attach', 'vm-3 Owner -->team-a unchanged']);
    expect(csvRows(String(result.outputs.changeLogCsv)).slice(1).map((r) => r[10])).toEqual(['planned', 'planned']);
  });

  it('armed: replace in a one-value category, attach, each read back; the change log is the undo', async () => {
    const { result, requests } = await runPkg(p, routes([...PLAN_SEQ, ['t-prod'], ['t-pay']]), (h) => vcSettings(h, { dryRun: false }), (h) => ({ assignmentsCsv: csv(h, THREE), replace: true }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual(['POST /api/cis/tagging/tag-association/t-test?action=detach', 'POST /api/cis/tagging/tag-association/t-prod?action=attach', 'POST /api/cis/tagging/tag-association/t-pay?action=attach']);
    expect(JSON.parse(requests.find((r) => r.path.endsWith('t-prod?action=attach'))!.body)).toEqual({ object_id: { type: 'VirtualMachine', id: 'vm-1' } });
    const log = csvRows(String(result.outputs.changeLogCsv));
    expect(log[0]!.join(',')).toBe('vcenter,object_type,object_id,object_name,category,before_id,before,after_id,after,action,result');
    expect(log.slice(1).map((r) => `${r[2]} ${r[5]}->${r[7]} ${r[9]} ${r[10]}`)).toEqual(['vm-1 t-test->t-prod replace ok', 'vm-2 ->t-pay attach ok']);
  });

  it('never replaces a one-value category without replace = true', async () => {
    const { requests, result } = await runPkg(p, routes([...PLAN_SEQ, ['t-pay']]), (h) => vcSettings(h, { dryRun: false }), (h) => ({ assignmentsCsv: csv(h, THREE) }));
    expect(writes(requests)).toEqual(['POST /api/cis/tagging/tag-association/t-pay?action=attach']);
    expect(String(result.outputs.planCsv)).toContain('already Environment=test; run with the replace input true to change it');
  });

  it('a one-value replace whose new value does not take is rolled back at once, read back, and the run stops', async () => {
    const { result, requests } = await runPkg(p, routes([['t-test'], [], ['t-test']], ['t-prod']), (h) => vcSettings(h, { dryRun: false }), (h) => ({ assignmentsCsv: csv(h, [THREE[0]!, THREE[1]!]), replace: true }));
    expect(writes(requests)).toEqual(['POST /api/cis/tagging/tag-association/t-test?action=detach', 'POST /api/cis/tagging/tag-association/t-prod?action=attach', 'POST /api/cis/tagging/tag-association/t-test?action=attach']);
    expect(result.error ?? '').toContain('ROLLED BACK: the old value was re-attached and read back');
    expect(result.error ?? '').toContain('Stopped after 0 change(s)');
    expect(csvRows(String(result.outputs.changeLogCsv)).slice(1).map((r) => r[10])).toEqual(['rolled-back']);
  });

  it('a failed roll-back is said out loud, with the tag to put back', async () => {
    const { result } = await runPkg(p, routes([['t-test'], [], []], ['t-prod', 't-test']), (h) => vcSettings(h, { dryRun: false }), (h) => ({ assignmentsCsv: csv(h, [THREE[0]!]), replace: true }));
    expect(result.error ?? '').toContain('ROLLBACK-FAILED');
    expect(result.error ?? '').toContain('attach tag t-test to VirtualMachine vm-1 by hand');
    expect(csvRows(String(result.outputs.changeLogCsv)).slice(1).map((r) => r[10])).toEqual(['ROLLBACK-FAILED']);
  });

  it('in a several-value category the new value is attached and read back before the old one is detached', async () => {
    const server = await startFakeServer([tagsOnObjects([['t-web', 't-pay'], ['t-pay']]), ...attachDetach()]);
    servers.push(server);
    const host = `127.0.0.1:${server.port}`;
    const mod = new VroEmulator(p.files).module('com.archtoolkit.tags.bulk_assign') as Record<string, (...args: unknown[]) => unknown>;
    expect(mod.changeTag!(host, { 'vmware-api-session-id': 's' }, 'VirtualMachine', 'vm-2', 't-web', 't-pay', 'MULTIPLE', 'app2')).toBe('ok');
    expect(writes(server.requests())).toEqual(['POST /api/cis/tagging/tag-association/t-pay?action=attach', 'POST /api/cis/tagging/tag-association/t-web?action=detach']);
    // And when the new value does not take, the old one is never touched.
    const failing = await startFakeServer([tagsOnObjects([['t-web']]), ...attachDetach(['t-pay'])]);
    servers.push(failing);
    expect(() => mod.changeTag!(`127.0.0.1:${failing.port}`, { 'vmware-api-session-id': 's' }, 'VirtualMachine', 'vm-2', 't-web', 't-pay', 'MULTIPLE', 'app2')).toThrow(/the old value was not touched/);
    expect(writes(failing.requests())).toEqual(['POST /api/cis/tagging/tag-association/t-pay?action=attach']);
  });

  it('refuses a CSV that gives one object two values of a one-value category, and a plan above the cap', async () => {
    const dup = await runPkg(p, routes([['t-test']]), (h) => vcSettings(h, { dryRun: false }), (h) => ({ assignmentsCsv: csv(h, ['VirtualMachine,app1,Environment,prod', 'VirtualMachine,app1,Environment,test']), replace: true }));
    expect(writes(dup.requests)).toEqual([]);
    expect(dup.result.error ?? '').toContain('rows 2 and 3: app1 (vm-1)');
    const capped = await runPkg(p, routes(PLAN_SEQ), (h) => vcSettings(h, { dryRun: false, cap: 1 }), (h) => ({ assignmentsCsv: csv(h, THREE), replace: true }));
    expect(writes(capped.requests)).toEqual([]);
    expect(capped.result.error ?? '').toContain('Refusing: 2 changes is more than the cap of 1');
  });

  it('undo: works from what is on each object now, newest row first', async () => {
    const log = (host: string) =>
      [
        'vcenter,object_type,object_id,object_name,category,before_id,before,after_id,after,action,result',
        `${host},VirtualMachine,vm-1,app1,Environment,t-test,test,t-prod,prod,replace,ok`,
        `${host},VirtualMachine,vm-2,app2,Application,,,t-pay,pay,attach,ok`,
        `${host},VirtualMachine,vm-3,app3,Owner,,,t-own-a,team-a,attach,pending`,
      ].join('\n');
    // vm-3: the attach never happened, so it is as before already.
    const seq = [[], ['t-pay'], [], ['t-prod'], ['t-test']];
    const dry = await runPkg(p, routes(seq), (h) => vcSettings(h), (h) => ({ undoLogCsv: log(h) }));
    expect(writes(dry.requests)).toEqual([]);
    const armed = await runPkg(p, routes(seq), (h) => vcSettings(h, { dryRun: false }), (h) => ({ undoLogCsv: log(h) }));
    expect(armed.result.error).toBe(null);
    expect(writes(armed.requests)).toEqual(['POST /api/cis/tagging/tag-association/t-pay?action=detach', 'POST /api/cis/tagging/tag-association/t-prod?action=detach', 'POST /api/cis/tagging/tag-association/t-test?action=attach']);
    expect(armed.result.logs.some((l) => l.message.startsWith('As before already: app3'))).toBe(true);
  });

  it('refuses a vCenter that is not in the settings', async () => {
    const { result, requests } = await runPkg(p, routes([]), (h) => vcSettings(h), () => ({ assignmentsCsv: 'vcenter,object_type,object,category,tag\nvc-elsewhere.example.com,VirtualMachine,app1,Environment,prod' }));
    expect(requests.length).toBe(0);
    expect(String(result.outputs.planCsv)).toContain('vc-elsewhere.example.com is not in vcenters');
  });
});

// ---------------------------------------------------------------------------
// tags_rules

describe('pkg fleet-tags: tags_rules', { skip: !CURL }, () => {
  const rules = ['name | ^prd- | Environment=prod | fill', 'name | ^dev- | Environment=dev | fill', 'cluster | gold | Tier=1 | authoritative', 'folder | Payments | Application=pay | fill', 'guestos | Windows | OS=windows | fill'].join('\n');
  const p = pkg('tags_rules', { rules });
  const cats: Cat[] = [
    { id: 'c-env', name: 'Environment', cardinality: 'SINGLE' },
    { id: 'c-tier', name: 'Tier', cardinality: 'SINGLE' },
    { id: 'c-app', name: 'Application', cardinality: 'MULTIPLE' },
    { id: 'c-os', name: 'OS', cardinality: 'SINGLE' },
    { id: 'c-auto', name: 'Automation', cardinality: 'SINGLE' },
  ];
  const tags: Tg[] = [
    { id: 't-prod', name: 'prod', category_id: 'c-env' },
    { id: 't-dev', name: 'dev', category_id: 'c-env' },
    { id: 't-1', name: '1', category_id: 'c-tier' },
    { id: 't-2', name: '2', category_id: 'c-tier' },
    { id: 't-pay', name: 'pay', category_id: 'c-app' },
    { id: 't-win', name: 'windows', category_id: 'c-os' },
    { id: 't-never', name: 'never', category_id: 'c-auto' },
  ];
  const routes = (seq: string[][] = []) => () => [
    tagsOnObjects(seq),
    ...attachDetach(),
    { method: 'POST', path: '^/api/cis/tagging/tag-association\\?action=list-attached-objects-on-tags$', body: [
      { tag_id: 't-prod', object_ids: [{ type: 'VirtualMachine', id: 'vm-2' }] },
      { tag_id: 't-2', object_ids: [{ type: 'VirtualMachine', id: 'vm-1' }] },
      { tag_id: 't-never', object_ids: [{ type: 'VirtualMachine', id: 'vm-4' }] },
    ] },
    at('GET', '/api/vcenter/host', [{ host: 'host-1', name: 'esx1' }]),
    at('GET', '/api/vcenter/vm?hosts=host-1', [{ vm: 'vm-1', name: 'prd-app1' }, { vm: 'vm-2', name: 'dev-x' }, { vm: 'vm-3', name: 'win1' }, { vm: 'vm-4', name: 'prd-skip' }]),
    at('GET', '/api/vcenter/cluster?names=gold', [{ cluster: 'domain-c1', name: 'gold' }]),
    at('GET', '/api/vcenter/vm?clusters=domain-c1', [{ vm: 'vm-1', name: 'prd-app1' }]),
    at('GET', '/api/vcenter/folder?type=VIRTUAL_MACHINE&names=Payments', [{ folder: 'group-v5', name: 'Payments' }]),
    at('GET', '/api/vcenter/vm?folders=group-v5', []),
    at('GET', '/api/vcenter/folder?type=VIRTUAL_MACHINE&parent_folders=group-v5', [{ folder: 'group-v6', name: 'Web' }]),
    at('GET', '/api/vcenter/vm?folders=group-v6', [{ vm: 'vm-3', name: 'win1' }]),
    at('GET', '/api/vcenter/folder?type=VIRTUAL_MACHINE&parent_folders=group-v6', []),
    at('GET', '/api/vcenter/vm/vm-3/guest/identity', { full_name: { default_message: 'Microsoft Windows Server 2022 (64-bit)' } }),
    { method: 'GET', path: '^/api/vcenter/vm/vm-[12]/guest/identity$', status: 503, body: { error_type: 'SERVICE_UNAVAILABLE' } },
    at('GET', '/api/vcenter/vm/vm-1', { guest_OS: 'RHEL_9_64' }),
    at('GET', '/api/vcenter/vm/vm-2', { guest_OS: 'OTHER_LINUX_64' }),
    ...catalogueRoutes(cats, tags),
  ];

  it('dry run: fill-only, authoritative, recursive folders, guest OS, the exclusion tag — and writes nothing', async () => {
    const { result, requests } = await runPkg(p, routes(), (h) => vcSettings(h));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    const plan = csvRows(String(result.outputs.planCsv)).slice(1).map((r) => `${r[3]} ${r[4]} ${r[5] || '-'}->${r[6]} ${r[7]}`);
    expect(plan).toEqual(['prd-app1 Environment -->prod attach', 'prd-app1 Tier 2->1 replace', 'win1 Application -->pay attach', 'win1 OS -->windows attach']);
    expect(String(result.outputs.conflictsCsv)).toContain('dev-x,Environment,prod,dev,fill-only rule');
    expect(String(result.outputs.planCsv).includes('prd-skip')).toBe(false);
    expect(requests.some((r) => r.path.startsWith('/api/vcenter/vm/vm-4'))).toBe(false);
  });

  it('armed: attaches, and replaces the authoritative one-value category with an immediate read-back', async () => {
    const { result, requests } = await runPkg(p, routes([['t-prod', 't-2'], ['t-prod', 't-1'], ['t-pay'], ['t-pay', 't-win']]), (h) => vcSettings(h, { dryRun: false }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([
      'POST /api/cis/tagging/tag-association/t-prod?action=attach',
      'POST /api/cis/tagging/tag-association/t-2?action=detach',
      'POST /api/cis/tagging/tag-association/t-1?action=attach',
      'POST /api/cis/tagging/tag-association/t-pay?action=attach',
      'POST /api/cis/tagging/tag-association/t-win?action=attach',
    ]);
    expect(csvRows(String(result.outputs.changeLogCsv)).slice(1).every((r) => r[10] === 'ok')).toBe(true);
  });

  it('refuses a run that would change more VMs than maxVms, and stops at the cap', async () => {
    const over = await runPkg(p, routes(), (h) => vcSettings(h, { dryRun: false, maxVms: 1 }));
    expect(writes(over.requests)).toEqual([]);
    expect(over.result.error ?? '').toContain('Refusing: 2 VMs would change, more than maxVms (1)');
    const capped = await runPkg(p, routes([['t-prod', 't-2']]), (h) => vcSettings(h, { dryRun: false, cap: 1 }));
    expect(writes(capped.requests)).toEqual(['POST /api/cis/tagging/tag-association/t-prod?action=attach']);
    expect(capped.result.error ?? '').toContain('Cap reached');
    expect(csvRows(String(capped.result.outputs.changeLogCsv)).slice(1).map((r) => r[10])).toEqual(['ok', 'not-attempted']);
  });
});

// ---------------------------------------------------------------------------
// tags_sync_control

const TM = '/suite-api/api/fleet-management/tag-management';
function fleetExportRoutes(categoryQueries: unknown[] = []): FakeRoute[] {
  const env = { id: 'f-env', name: 'Environment', cardinality: 'SINGLE', associableTypes: [{ adapterKind: 'VMWARE', resourceKinds: ['VirtualMachine', 'Folder'] }] };
  return [
    { method: 'POST', path: '^/acs/t/CUSTOMER/token$', body: { access_token: 'idb-access-do-not-log' } },
    { method: 'POST', path: `^${esc(TM)}/categories/query\\?`, responses: [...categoryQueries.map((body) => ({ body })), { body: { categories: [env], pageInfo: { totalCount: 1 } } }] },
    { method: 'POST', path: `^${esc(TM)}/categories/f-env/tags/query\\?`, body: { tags: [{ id: 'ft-prod', name: 'prod', categoryName: 'Environment' }], pageInfo: { totalCount: 1 } } },
    { method: 'POST', path: `^${esc(TM)}/resources/query\\?`, responses: [{ body: { resources: [{ resourceId: 'r-1', tags: [{ categoryName: 'Environment', name: 'prod' }] }], pageInfo: { totalCount: 1 } } }, { body: { resources: [{ resourceId: 'r-1', tags: [{ categoryName: 'Environment', name: 'prod' }] }, { resourceId: 'r-2', tags: [{ categoryName: 'Environment', name: 'prod' }] }], pageInfo: { totalCount: 2 } } }] },
  ];
}

describe('pkg fleet-tags: tags_sync_control', { skip: !CURL }, () => {
  const settings = (h: string, extra: Record<string, unknown> = {}) => ({ opsHost: h, vcfIdbHost: h, vcfApiToken: API_TOKEN, adapters: ['ad-1', 'ad-2'], ...extra });
  const tasks = (status = 'SUCCESS'): FakeRoute[] => [
    { method: 'POST', path: `^${esc(TM)}/adapters/ad-[12]/categories/(push|pull)$`, status: 202, body: { taskId: 't-9' } },
    { method: 'GET', path: `^${esc(TM)}/tasks/t-9$`, body: { id: 't-9', status, errorMessages: status === 'FAILED' ? ['category Environment: same name, different id'] : [] } },
  ];

  it('export: reads only (the documented query POSTs) and returns the sorted document', async () => {
    const p = pkg('tags_sync_control', { action: 'export' });
    const { result, requests } = await runPkg(p, () => fleetExportRoutes(), (h) => settings(h));
    expect(result.error).toBe(null);
    expect(requests.every((r) => r.method === 'GET' || READ_POSTS.test(r.path))).toBe(true);
    const doc = JSON.parse(String(result.outputs.afterJson)) as { categories: unknown[]; tags: unknown[]; assignments: { resourceId: string; tags: string[] }[] };
    expect(doc.assignments).toEqual([{ resourceId: 'r-1', tags: ['Environment/prod'] }]);
    expect(requests.filter((r) => r.path.startsWith(TM)).every((r) => r.headers.authorization === 'Bearer idb-access-do-not-log')).toBe(true);
  });

  it('push: dry run changes nothing; armed exports, pushes to each adapter, waits, exports again and diffs', async () => {
    const p = pkg('tags_sync_control', { action: 'push', categories: 'Environment' });
    const first = { categories: [{ id: 'f-env', name: 'Environment' }, { id: 'f-e2', name: 'Environment2' }], pageInfo: { totalCount: 2 } };
    const dry = await runPkg(p, () => [...tasks(), ...fleetExportRoutes([first])], (h) => settings(h));
    expect(writes(dry.requests)).toEqual([]);
    expect(dry.result.logs.filter((l) => l.message.startsWith('DRY RUN: would push 1 categories (Environment)')).length).toBe(2);
    const armed = await runPkg(p, () => [...tasks(), ...fleetExportRoutes([first])], (h) => settings(h, { dryRun: false }));
    expect(armed.result.error).toBe(null);
    expect(writes(armed.requests)).toEqual([`POST ${TM}/adapters/ad-1/categories/push`, `POST ${TM}/adapters/ad-2/categories/push`]);
    expect(JSON.parse(armed.requests.find((r) => r.path.endsWith('ad-1/categories/push'))!.body)).toEqual({ categoryIds: ['f-env'], overwrite: false });
    expect(String(armed.result.outputs.diff)).toContain('objects whose tags changed: 1');
    expect(JSON.parse(String(armed.result.outputs.beforeJson)).assignments.length).toBe(1);
  });

  it('push refuses when a category name does not resolve, and pushes nothing', async () => {
    const p = pkg('tags_sync_control', { action: 'push', categories: 'Environment, Nope' });
    const { result, requests } = await runPkg(p, () => [...tasks(), ...fleetExportRoutes([{ categories: [{ id: 'f-env', name: 'Environment' }], pageInfo: { totalCount: 1 } }, { categories: [], pageInfo: { totalCount: 0 } }])], (h) => settings(h, { dryRun: false }));
    expect(writes(requests)).toEqual([]);
    expect(result.error ?? '').toContain('Refusing to push: Nope is not a category');
  });

  it('pull: a FAILED task stops the run at the first adapter, and the after export is still taken', async () => {
    const p = pkg('tags_sync_control', { action: 'pull' });
    const { result, requests } = await runPkg(p, () => [...tasks('FAILED'), ...fleetExportRoutes()], (h) => settings(h, { dryRun: false }));
    expect(writes(requests)).toEqual([`POST ${TM}/adapters/ad-1/categories/pull`]);
    expect(result.error ?? '').toContain('Task t-9: FAILED: category Environment: same name, different id');
    expect(String(result.outputs.afterJson).length > 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tags_backup

describe('pkg fleet-tags: tags_backup', { skip: !CURL }, () => {
  const p = pkg('tags_backup');
  const inventory: FakeRoute[] = [
    at('GET', '/api/vcenter/host', [{ host: 'host-1', name: 'esx1' }]),
    at('GET', '/api/vcenter/vm?hosts=host-1', [{ vm: 'vm-1', name: 'app1' }]),
    ...['cluster', 'datastore', 'folder', 'resource-pool', 'datacenter', 'network'].map((kind) => at('GET', `/api/vcenter/${kind}`, [])),
  ];
  const envCat: Cat = { id: 'c-env', name: 'Environment', cardinality: 'SINGLE', associable_types: ['VirtualMachine'] };
  const ownCat: Cat = { id: 'c-own', name: 'Owner', cardinality: 'SINGLE', associable_types: [] };

  it('backup: reads every category, tag and assignment into the archtoolkit-tag-backup/1 format, and changes nothing', async () => {
    const { result, requests } = await runPkg(
      p,
      () => [{ method: 'POST', path: '^/api/cis/tagging/tag-association\\?action=list-attached-objects-on-tags$', body: [{ tag_id: 't-prod', object_ids: [{ type: 'VirtualMachine', id: 'vm-1' }] }] }, ...inventory, ...catalogueRoutes([envCat], [{ id: 't-prod', name: 'prod', category_id: 'c-env' }])],
      (h) => vcSettings(h),
    );
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    const [doc] = JSON.parse(String(result.outputs.backupJson)) as { format: string; categories: { name: string }[]; assignments: unknown[] }[];
    expect(doc!.format).toBe('archtoolkit-tag-backup/1');
    expect(doc!.assignments).toEqual([{ category: 'Environment', tag: 'prod', object_type: 'VirtualMachine', object_id: 'vm-1', object_name: 'app1' }]);
  });

  it('backup: an empty catalogue is a failed read, not a backup', async () => {
    const { result } = await runPkg(p, () => [...inventory, ...catalogueRoutes([], [])], (h) => vcSettings(h));
    expect(result.error ?? '').toContain('no categories read; not taken as a backup');
    expect(JSON.parse(String(result.outputs.backupJson))).toEqual([]);
  });

  const backupDoc = (vc: string) =>
    JSON.stringify({
      vcenter: vc,
      format: 'archtoolkit-tag-backup/1',
      categories: [{ name: 'Environment', cardinality: 'SINGLE', associable_types: ['VirtualMachine'] }, { name: 'Owner', description: 'Owner', cardinality: 'SINGLE', associable_types: [] }],
      tags: [{ name: 'prod', category: 'Environment' }, { name: 'team-a', description: 'Owner team-a', category: 'Owner' }],
      assignments: [
        { category: 'Owner', tag: 'team-a', object_type: 'VirtualMachine', object_id: 'vm-old', object_name: 'app1' },
        { category: 'Environment', tag: 'prod', object_type: 'VirtualMachine', object_id: 'vm-1', object_name: 'app1' },
      ],
    });
  const restoreRoutes = (): FakeRoute[] => [
    // The catalogue is read three times: at the start, after the categories, after the tags.
    { method: 'GET', path: '^/api/cis/tagging/category$', responses: [{ body: ['c-env'] }, { body: ['c-env', 'c-own'] }] },
    { method: 'GET', path: '^/api/cis/tagging/tag$', responses: [{ body: ['t-prod'] }, { body: ['t-prod'] }, { body: ['t-prod', 't-a'] }] },
    at('GET', '/api/cis/tagging/category/c-own', { ...ownCat, description: '' }),
    at('GET', '/api/cis/tagging/tag/t-a', { id: 't-a', name: 'team-a', category_id: 'c-own', description: '' }),
    { method: 'POST', path: '^/api/cis/tagging/category$', body: JSON.stringify('c-own') },
    { method: 'POST', path: '^/api/cis/tagging/tag$', body: JSON.stringify('t-a') },
    { method: 'POST', path: '^/api/cis/tagging/tag-association\\?action=list-attached-objects-on-tags$', body: [{ tag_id: 't-prod', object_ids: [{ type: 'VirtualMachine', id: 'vm-1' }] }] },
    { method: 'POST', path: '^/api/cis/tagging/tag-association/t-a\\?action=attach-tag-to-multiple-objects$', body: { success: true, error_messages: [] } },
    ...inventory,
    ...catalogueRoutes([envCat], [{ id: 't-prod', name: 'prod', category_id: 'c-env' }]),
  ];

  it('restore dry run: says what it would create and attach, writes nothing', async () => {
    const { result, requests } = await runPkg(p, restoreRoutes, (h) => vcSettings(h), (h) => ({ mode: 'restore', backup: backupDoc(h) }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would create')).length).toBe(2);
  });

  it('restore armed: creates the category, then the tag, then re-attaches by name — never detaching', async () => {
    const { result, requests } = await runPkg(p, restoreRoutes, (h) => vcSettings(h, { dryRun: false }), (h) => ({ mode: 'restore', backup: backupDoc(h) }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual(['POST /api/cis/tagging/category', 'POST /api/cis/tagging/tag', 'POST /api/cis/tagging/tag-association/t-a?action=attach-tag-to-multiple-objects']);
    expect(JSON.parse(requests.find((r) => r.path.endsWith('attach-tag-to-multiple-objects'))!.body)).toEqual({ object_ids: [{ type: 'VirtualMachine', id: 'vm-1' }] });
    expect(JSON.parse(requests.find((r) => r.path === '/api/cis/tagging/tag' && r.method === 'POST')!.body)).toEqual({ name: 'team-a', description: 'Owner team-a', category_id: 'c-own' });
    expect(String(result.outputs.restoreLog).split('\n').filter(Boolean).map((l) => l.split('\t')[0]).sort()).toEqual(['attach', 'present']);
    expect(requests.some((r) => r.path.includes('action=detach'))).toBe(false);
  });

  it('restore refuses above maxAttach; undo-restore detaches what the restore attached', async () => {
    const over = await runPkg(p, restoreRoutes, (h) => vcSettings(h, { dryRun: false, maxAttach: 0 }), (h) => ({ mode: 'restore', backup: backupDoc(h) }));
    expect(over.result.error ?? '').toContain('Refusing: 1 attachments is more than maxAttach (0)');
    expect(writes(over.requests).some((w) => w.includes('attach-tag-to-multiple-objects'))).toBe(false);
    const undo = await runPkg(p, () => [tagsOnObjects([[]]), ...attachDetach(), ...catalogueRoutes([envCat], [])], (h) => vcSettings(h, { dryRun: false }), (h) => ({ mode: 'undo-restore', targetVcenter: h, restoreLogToUndo: 'attach\tOwner\tteam-a\tt-a\tVirtualMachine\tvm-1\tapp1\t\npresent\tEnvironment\tprod\tt-prod\tVirtualMachine\tvm-1\tapp1\tprod\n' }));
    expect(undo.result.error).toBe(null);
    expect(writes(undo.requests)).toEqual(['POST /api/cis/tagging/tag-association/t-a?action=detach']);
  });
});

// ---------------------------------------------------------------------------
// tags_consume

describe('pkg fleet-tags: tags_consume', { skip: !CURL }, () => {
  const standard = ['Environment | single | VirtualMachine | prod,test | VirtualMachine | x', 'Application | multiple | VirtualMachine | pay,web,crm | VirtualMachine | x', 'CostCenter | single | VirtualMachine | CC1 | VirtualMachine | x'].join('\n');
  const p = pkg('tags_consume', { standard });
  const NSX = '/policy/api/v1/infra/domains/default/groups/';
  const VMS = '/policy/api/v1/infra/realized-state/enforcement-points/default/virtual-machines';
  const payGroup = JSON.parse(p.files['nsx-group-application-pay.json']!) as Record<string, unknown>;
  const routes = (): FakeRoute[] => [
    { method: 'POST', path: '^/suite-api/api/auth/token/acquire$', body: { token: 'ops-token-do-not-log' } },
    { method: 'POST', path: '^/suite-api/api/auth/token/release$', body: '' },
    { method: 'GET', path: '^/suite-api/api/resources/groups\\?', body: { groups: [{ id: 'g-1', resourceKey: { name: 'Environment prod VMs' } }], pageInfo: { totalCount: 1 } } },
    { method: 'POST', path: '^/suite-api/api/resources/groups$', body: { id: 'g-2' } },
    at('GET', `${NSX}application-pay`, payGroup),
    at('GET', `${NSX}application-web`, { display_name: 'Application web', tags: [{ scope: 'owner', tag: 'secops' }] }),
    { method: 'GET', path: `^${esc(NSX)}`, status: 404, body: { error_code: 600 } },
    { method: 'PATCH', path: `^${esc(NSX)}`, body: '' },
    at('GET', VMS, { results: [{ external_id: 'u-1', display_name: 'app1', tags: [{ scope: 'Application', tag: 'pay' }, { scope: 'owner', tag: 'x' }] }, { external_id: 'u-2', display_name: 'app2', tags: [{ scope: 'owner', tag: 'y' }] }], result_count: 2 }),
    { method: 'POST', path: `^${esc(VMS)}\\?action=update_tags$`, body: '' },
    { method: 'POST', path: '^/api/cis/tagging/tag-association\\?action=list-attached-objects-on-tags$', body: [{ tag_id: 't-pay', object_ids: [{ type: 'VirtualMachine', id: 'vm-1' }, { type: 'VirtualMachine', id: 'vm-2' }] }] },
    at('GET', '/api/vcenter/vm/vm-1', { identity: { instance_uuid: 'u-1' } }),
    at('GET', '/api/vcenter/vm/vm-2', { identity: { instance_uuid: 'u-2' } }),
    ...catalogueRoutes([{ id: 'c-app', name: 'Application', cardinality: 'MULTIPLE' }], [{ id: 't-pay', name: 'pay', category_id: 'c-app' }]),
  ];
  const settings = (h: string, extra: Record<string, unknown> = {}) => ({ ...vcSettings(h), opsHost: h, opsUsername: 'ops', opsPassword: SECRET, nsxHost: h, nsxUsername: 'nsx', nsxPassword: SECRET, ...extra });

  it('dry run: plans the groups and the sync, writes nothing', async () => {
    const { result, requests } = await runPkg(p, routes, (h) => settings(h));
    expect(writes(requests)).toEqual([]);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would')).map((l) => l.message)).toEqual(['DRY RUN: would create VCF Operations custom group Environment test VMs', 'DRY RUN: would create NSX group application-crm', 'DRY RUN: would set NSX tags Application on app2: (none) -> pay']);
    expect(result.error ?? '').toContain('NSX group application-web exists and was not created by this kit; refused.');
  });

  it('armed: creates what is missing, refuses the hand-built group, leaves ours alone, and syncs only the scope', async () => {
    const { result, requests } = await runPkg(p, routes, (h) => settings(h, { dryRun: false }));
    expect(writes(requests)).toEqual(['POST /suite-api/api/resources/groups', `PATCH ${NSX}application-crm`, `POST ${VMS}?action=update_tags`]);
    expect(JSON.parse(requests.find((r) => r.path.endsWith('update_tags'))!.body)).toEqual({ virtual_machine_id: 'u-2', tags: [{ scope: 'owner', tag: 'y' }, { scope: 'Application', tag: 'pay' }] });
    expect(requests.filter((r) => r.path.startsWith(NSX) || r.path.startsWith(VMS)).every((r) => r.headers.authorization === `Basic ${btoa(`nsx:${SECRET}`)}`)).toBe(true);
    expect(result.error ?? '').toContain('application-web');
    expect(JSON.parse(String(result.outputs.syncPlanJson)).length).toBe(1);
  });

  it('the sync refuses more VMs than maxVmChanges', async () => {
    const { result, requests } = await runPkg(p, routes, (h) => settings(h, { dryRun: false, applyVcfOpsGroups: false, applyNsxGroups: false, maxVmChanges: 0 }));
    expect(writes(requests)).toEqual([]);
    expect(result.error ?? '').toContain('Refusing: 1 VMs would have their NSX tags changed');
  });
});

// ---------------------------------------------------------------------------
// tags_cleanup

describe('pkg fleet-tags: tags_cleanup', { skip: !CURL }, () => {
  const p = pkg('tags_cleanup', { standard: 'Environment | single | VirtualMachine | prod,dr | VirtualMachine | x', protect: 'Vendor' });
  const cats: Cat[] = [
    { id: 'c-env', name: 'Environment', cardinality: 'SINGLE' },
    { id: 'c-leg', name: 'Legacy', cardinality: 'MULTIPLE' },
    { id: 'c-empty', name: 'EmptyCat', cardinality: 'SINGLE' },
    { id: 'c-vendor', name: 'Vendor', cardinality: 'MULTIPLE' },
  ];
  const tags: Tg[] = [
    { id: 't-prod', name: 'prod', category_id: 'c-env' },
    { id: 't-Prod', name: 'Prod', category_id: 'c-env' },
    { id: 't-dr', name: 'dr', category_id: 'c-env' },
    { id: 't-old', name: 'old', category_id: 'c-leg' },
    { id: 't-used', name: 'used', category_id: 'c-leg' },
    { id: 't-v', name: 'x', category_id: 'c-vendor' },
  ];
  const assoc = [{ tag_id: 't-prod', object_ids: [{ type: 'VirtualMachine', id: 'vm-1' }] }, { tag_id: 't-used', object_ids: [{ type: 'VirtualMachine', id: 'vm-2' }] }];
  const routes = (now: unknown[][] = [[], []]) => (): FakeRoute[] => [
    { method: 'POST', path: '^/api/cis/tagging/tag-association\\?action=list-attached-objects-on-tags$', responses: [{ body: assoc }, ...now.map((body) => ({ body }))] },
    { method: 'POST', path: '^/api/cis/tagging/tag\\?action=list-tags-for-category$', body: [] },
    { method: 'DELETE', path: '^/api/cis/tagging/(tag|category)/', status: 204 },
    ...catalogueRoutes(cats, tags),
  ];

  it('dry run: exports first, plans, deletes nothing', async () => {
    const { result, requests } = await runPkg(p, routes(), (h) => vcSettings(h));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    const plan = csvRows(String(result.outputs.planCsv)).slice(1).map((r) => `${r[1]} ${r[2]}/${r[3]} ${r[5]}`);
    expect(plan).toEqual(['tag Environment/Prod delete', 'tag Environment/dr keep', 'tag Legacy/old delete', 'tag Vendor/x keep', 'category EmptyCat/ delete']);
    const exported = JSON.parse(String(result.outputs.exportsJson)) as { format: string; tags: unknown[] }[];
    expect(exported[0]!.format).toBe('archtoolkit-tag-backup/1');
    expect(exported[0]!.tags.length).toBe(6);
  });

  it('armed without a change ticket: refuses before reading anything', async () => {
    const { result, requests } = await runPkg(p, routes(), (h) => vcSettings(h, { dryRun: false }));
    expect(requests.length).toBe(0);
    expect(result.error ?? '').toContain('changeTicket');
  });

  it('armed: deletes tags first, then the empty category, each re-checked, the ticket on every row', async () => {
    const { result, requests } = await runPkg(p, routes(), (h) => vcSettings(h, { dryRun: false }), () => ({ changeTicket: 'CHG0012345' }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual(['DELETE /api/cis/tagging/tag/t-Prod', 'DELETE /api/cis/tagging/tag/t-old', 'DELETE /api/cis/tagging/category/c-empty']);
    expect(csvRows(String(result.outputs.cleanupLogCsv)).slice(1).map((r) => `${r[4]} ${r[5]} ${r[6]}`)).toEqual(['t-Prod deleted CHG0012345', 't-old deleted CHG0012345', 'c-empty deleted CHG0012345']);
  });

  it('a tag attached since the plan is refused, not deleted; above the cap nothing is deleted', async () => {
    const attached = await runPkg(p, routes([[{ tag_id: 't-Prod', object_ids: [{ type: 'VirtualMachine', id: 'vm-9' }] }], []]), (h) => vcSettings(h, { dryRun: false }), () => ({ changeTicket: 'CHG1' }));
    expect(writes(attached.requests)).toEqual(['DELETE /api/cis/tagging/tag/t-old', 'DELETE /api/cis/tagging/category/c-empty']);
    expect(String(attached.result.outputs.cleanupLogCsv)).toContain('refused: attached to 1 object(s) now');
    const capped = await runPkg(p, routes(), (h) => vcSettings(h, { dryRun: false, cap: 2 }), () => ({ changeTicket: 'CHG1' }));
    expect(writes(capped.requests)).toEqual([]);
    expect(capped.result.error ?? '').toContain('Refusing: 3 deletions is more than the cap of 2');
  });
});

// ---------------------------------------------------------------------------
// SDDC Manager

const SDDC_TOKEN = 'sddc-token-do-not-log';
const sddcBase = (extra: FakeRoute[] = [], tasks: unknown[] = [{ id: 'x', status: 'SUCCESSFUL', creationTimestamp: new Date().toISOString() }]): FakeRoute[] => [
  ...extra,
  { method: 'POST', path: '^/v1/tokens$', body: { accessToken: SDDC_TOKEN, refreshToken: { id: 'r' } } },
  at('GET', '/v1/tasks', { elements: tasks }),
];
const sddcSettings = (h: string, extra: Record<string, unknown> = {}) => ({ sddcHost: h, sddcUsername: 'admin@local', sddcPassword: SECRET, ...extra });
const authed = (requests: readonly FakeRequest[]) => requests.filter((r) => r.path !== '/v1/tokens').every((r) => r.headers.authorization === `Bearer ${SDDC_TOKEN}`);

describe('pkg fleet-tags: fleet_password_rotation', { skip: !CURL }, () => {
  const p = pkg('fleet_password_rotation', { domains: 'wld-01', usernames: 'root', max_resources: 2 });
  const cred = (resourceName: string, domainName: string, username = 'root') => ({ credentialType: 'SSH', username, resource: { resourceName, resourceType: 'ESXI', domainName } });
  const routes = (extra: FakeRoute[] = [], tasks?: unknown[]) => () =>
    sddcBase(
      [
        ...extra,
        at('GET', '/v1/credentials/tasks', { elements: [] }),
        at('GET', '/v1/credentials?resourceType=ESXI&accountType=USER', { elements: [cred('esx1', 'wld-01'), cred('esx2', 'wld-01'), cred('esx9', 'wld-02'), cred('esx1', 'wld-01', 'admin')] }),
        { method: 'PATCH', path: '^/v1/credentials$', body: { id: 'ct-1' } },
        { method: 'GET', path: '^/v1/credentials/tasks/ct-1$', responses: [{ body: { status: 'IN_PROGRESS' } }, { body: { status: 'SUCCESSFUL' } }] },
      ],
      tasks,
    );
  const body = { operationType: 'ROTATE', elements: [{ resourceName: 'esx1', resourceType: 'ESXI', credentials: [{ credentialType: 'SSH', username: 'root' }] }, { resourceName: 'esx2', resourceType: 'ESXI', credentials: [{ credentialType: 'SSH', username: 'root' }] }] };

  it('dry run: selects by domain and username, shows the body, sends nothing', async () => {
    const { result, requests } = await runPkg(p, routes(), (h) => sddcSettings(h));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    expect(JSON.parse(String(result.outputs.requestBody))).toEqual(body);
  });

  it('armed: one PATCH /v1/credentials, and follows the task to the end', async () => {
    const { result, requests } = await runPkg(p, routes(), (h) => sddcSettings(h, { dryRun: false }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual(['PATCH /v1/credentials']);
    expect(JSON.parse(requests.find((r) => r.method === 'PATCH')!.body)).toEqual(body);
    expect(requests.filter((r) => r.path === '/v1/credentials/tasks/ct-1').length).toBe(2);
    expect(result.outputs.credentialTaskId).toBe('ct-1');
    expect(authed(requests)).toBe(true);
  });

  it('mode UPDATE_AUTO_ROTATE_POLICY sends the policy', async () => {
    const { requests } = await runPkg(p, routes(), (h) => sddcSettings(h, { dryRun: false }), () => ({ mode: 'UPDATE_AUTO_ROTATE_POLICY' }));
    expect(JSON.parse(requests.find((r) => r.method === 'PATCH')!.body)).toEqual({ ...body, operationType: 'UPDATE_AUTO_ROTATE_POLICY', autoRotatePolicy: { frequencyInDays: 90, enableAutoRotatePolicy: true } });
  });

  it('refuses after a failed credential task, while a task runs, above maxResources, and at the cap; a FAILED task fails the run', async () => {
    const failedBefore = await runPkg(p, routes([at('GET', '/v1/credentials/tasks', { elements: [{ status: 'FAILED' }] })]), (h) => sddcSettings(h, { dryRun: false }));
    expect(writes(failedBefore.requests)).toEqual([]);
    expect(failedBefore.result.error ?? '').toContain('1 failed credential task(s)');
    const busy = await runPkg(p, routes([], [{ status: 'IN_PROGRESS' }]), (h) => sddcSettings(h, { dryRun: false }));
    expect(writes(busy.requests)).toEqual([]);
    expect(busy.result.error ?? '').toContain('1 SDDC Manager task(s) in progress');
    const many = await runPkg(p, routes(), (h) => sddcSettings(h, { dryRun: false, maxResources: 1 }));
    expect(writes(many.requests)).toEqual([]);
    expect(many.result.error ?? '').toContain('2 accounts is more than maxResources (1)');
    const capped = await runPkg(p, routes(), (h) => sddcSettings(h, { dryRun: false, cap: 0 }));
    expect(writes(capped.requests)).toEqual([]);
    expect(capped.result.error ?? '').toContain('Cap reached');
    const failing = await runPkg(p, routes([{ method: 'GET', path: '^/v1/credentials/tasks/ct-1$', body: { status: 'FAILED' } }]), (h) => sddcSettings(h, { dryRun: false }));
    expect(failing.result.error ?? '').toContain('Credential task ct-1 failed');
  });
});

describe('pkg fleet-tags: fleet_certificate_check and fleet_health read only', { skip: !CURL }, () => {
  const soon = new Date(Date.now() + 400 * 86400000).toISOString();

  it('certificates: reports what expires inside the window and what cannot be read, and posts them', async () => {
    const p = pkg('fleet_certificate_check', { within_days: 45 });
    const routes = () =>
      sddcBase([
        at('GET', '/v1/domains', { elements: [{ id: 'd1', name: 'mgmt' }] }),
        at('GET', '/v1/domains/d1/resource-certificates', { elements: [{ issuedTo: 'vc1', numberOfDaysToExpire: 10 }, { issuedTo: 'nsx1', expirationDate: soon }, { issuedTo: 'sddc', notAfter: 'not a date' }] }),
        { method: 'POST', path: '^/hook$', body: {} },
      ]);
    const { result, requests, host } = await runPkg(p, routes, (h) => sddcSettings(h, { webhook: `https://${h}/hook` }));
    expect(result.outputs.problemCount).toBe(2);
    expect(result.error ?? '').toContain('mgmt: vc1 expires in 10 days');
    expect(result.error ?? '').toContain('mgmt: sddc — expiry date could not be read');
    expect(requests.filter((r) => r.method !== 'GET').map((r) => r.path)).toEqual(['/v1/tokens', '/hook']);
    expect(String(result.outputs.certificatesCsv)).toContain('mgmt,nsx1,');
    expect(host.length > 0).toBe(true);
  });

  it('health: failed and stuck tasks, an unusable host, and the backup — only GETs', async () => {
    const p = pkg('fleet_health');
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
    const routes = () =>
      sddcBase(
        [at('GET', '/v1/sddc-managers', { elements: [{ fqdn: 'sddc.example.com', version: '9.1.0.0' }] }), at('GET', '/v1/hosts', { elements: [{ fqdn: 'esx1', status: 'ASSIGNED' }, { fqdn: 'esx7', status: 'UNASSIGNED_UNUSEABLE' }] }), at('GET', '/v1/system/backup-configuration', { backupLocations: [{ server: 'sftp' }] })],
        [
          { name: 'Rotate', status: 'FAILED', creationTimestamp: hoursAgo(2) },
          { name: 'Old failure', status: 'FAILED', creationTimestamp: hoursAgo(100) },
          { name: 'Upgrade', status: 'IN_PROGRESS', creationTimestamp: hoursAgo(10) },
          { name: 'SDDC Manager backup', status: 'SUCCESSFUL', creationTimestamp: hoursAgo(3) },
        ],
      );
    const { result, requests } = await runPkg(p, routes, (h) => sddcSettings(h));
    expect(result.outputs.problemCount).toBe(3);
    expect(result.error ?? '').toContain('failed task: Rotate; stuck task (over 6h): Upgrade; host not usable: esx7 (UNASSIGNED_UNUSEABLE)');
    expect(requests.filter((r) => r.method !== 'GET').map((r) => r.path)).toEqual(['/v1/tokens']);
  });
});

describe('pkg fleet-tags: fleet_backup_config', { skip: !CURL }, () => {
  const p = pkg('fleet_backup_config', { fingerprint: 'SHA256:abcdef' });
  const wanted = JSON.parse(p.spec.resources.find((r) => r.name === 'backup-configuration.json')!.content) as { backupLocations: Record<string, unknown>[]; backupSchedules: unknown[] };
  const current = { backupLocations: [{ server: 'old-sftp.example.com', port: 22, directoryPath: '/old', username: 'u', password: 'stored-do-not-log', sshFingerprint: 'SHA256:old' }], backupSchedules: [] };
  const routes = (config: unknown = current, tasks?: unknown[]) => () => sddcBase([at('GET', '/v1/system/backup-configuration', config), { method: 'PUT', path: '^/v1/system/backup-configuration$', body: { id: 'task-b' } }], tasks);
  const settings = (h: string, extra: Record<string, unknown> = {}) => sddcSettings(h, { sshFingerprint: 'SHA256:abcdef', sftpPassword: 'Sftp-do-not-log', backupPassphrase: 'Phrase-do-not-log', ...extra });

  it('dry run: compares, keeps the previous configuration without its secrets, sends nothing', async () => {
    const { result, requests } = await runPkg(p, routes(), (h) => settings(h));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    const previous = JSON.parse(String(result.outputs.previousConfiguration)) as { backupLocations: Record<string, unknown>[] };
    expect('password' in previous.backupLocations[0]!).toBe(false);
  });

  it('armed: one PUT with the secrets merged in memory and the fingerprint pinned', async () => {
    const { result, requests } = await runPkg(p, routes(), (h) => settings(h, { dryRun: false }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual(['PUT /v1/system/backup-configuration']);
    const sent = JSON.parse(requests.find((r) => r.method === 'PUT')!.body) as { backupLocations: Record<string, unknown>[]; encryption: { passphrase: string } };
    expect(sent.backupLocations[0]!.password).toBe('Sftp-do-not-log');
    expect(sent.backupLocations[0]!.sshFingerprint).toBe('SHA256:abcdef');
    expect(sent.encryption.passphrase).toBe('Phrase-do-not-log');
  });

  it('leaves a matching configuration alone; refuses without a fingerprint and while a task runs', async () => {
    const same = { backupLocations: [{ ...wanted.backupLocations[0], sshFingerprint: 'SHA256:abcdef' }], backupSchedules: wanted.backupSchedules };
    const alone = await runPkg(p, routes(same), (h) => settings(h, { dryRun: false }));
    expect(writes(alone.requests)).toEqual([]);
    expect(alone.result.logs.some((l) => l.message.startsWith('Already configured as generated'))).toBe(true);
    const noPrint = await runPkg(p, routes(), (h) => settings(h, { dryRun: false, sshFingerprint: '' }));
    expect(writes(noPrint.requests)).toEqual([]);
    expect(noPrint.result.error ?? '').toContain('set sshFingerprint');
    const busy = await runPkg(p, routes(current, [{ status: 'IN_PROGRESS' }]), (h) => settings(h, { dryRun: false }));
    expect(writes(busy.requests)).toEqual([]);
    expect(busy.result.error ?? '').toContain('in progress');
  });
});

describe('pkg fleet-tags: fleet_upgrade_precheck', { skip: !CURL }, () => {
  const p = pkg('fleet_upgrade_precheck');
  const base = [at('GET', '/v1/domains', { elements: [{ id: 'd1', name: 'mgmt-domain' }] }), at('GET', '/v1/bundles', { elements: [{ id: 'b1', version: '9.1.0.0', downloadStatus: 'SUCCESSFUL' }] })];

  it('check-sets: queries, runs the selection, follows the run, and lists each failed check', async () => {
    const routes = () =>
      sddcBase([
        ...base,
        { method: 'POST', path: '^/v1/system/check-sets/queries$', body: { queryId: 'q1', resources: [{ resourceName: 'vc1', resourceId: 'r1', resourceType: 'VCENTER', domain: { domainId: 'd1' }, checkSets: [{ checkSetId: 'cs1', checkSetName: 'Upgrade' }] }] } },
        { method: 'POST', path: '^/v1/system/check-sets$', body: { id: 'run-1' } },
        { method: 'GET', path: '^/v1/system/check-sets/run-1$', responses: [{ body: { status: 'IN_PROGRESS' } }, { body: { status: 'COMPLETED_WITH_FAILURE', presentedArtifactsMap: { checks: [{ name: 'NTP in sync', status: 'FAILED', errorMessage: 'drift of 9s' }, { name: 'DNS', status: 'SUCCEEDED' }] } } }] },
      ]);
    const { result, requests } = await runPkg(p, routes, (h) => sddcSettings(h));
    expect(result.error ?? '').toContain('NTP in sync: drift of 9s');
    expect(requests.filter((r) => r.method !== 'GET').map((r) => r.path)).toEqual(['/v1/tokens', '/v1/system/check-sets/queries', '/v1/system/check-sets']);
    expect(JSON.parse(requests.find((r) => r.path === '/v1/system/check-sets/queries')!.body)).toEqual({ checkSetType: 'UPGRADE', domains: [{ domainId: 'd1' }] });
    expect(JSON.parse(requests.find((r) => r.path === '/v1/system/check-sets')!.body)).toEqual({ queryId: 'q1', resources: [{ resourceName: 'vc1', resourceId: 'r1', resourceType: 'VCENTER', domain: { domainId: 'd1' }, checkSets: [{ checkSetId: 'cs1' }] }], metadata: { targetVersion: '9.1.0.0' } });
  });

  it('falls back to /v1/system/prechecks only where check-sets are not there, and passes clean', async () => {
    const routes = () =>
      sddcBase([
        ...base,
        { method: 'POST', path: '^/v1/system/check-sets/queries$', status: 404, body: {} },
        { method: 'POST', path: '^/v1/system/prechecks$', body: { id: 'pc-1' } },
        at('GET', '/v1/system/prechecks/tasks/pc-1', { status: 'SUCCESSFUL', subTasks: [{ name: 'NTP', status: 'SUCCESSFUL' }] }),
      ]);
    const { result, requests } = await runPkg(p, routes, (h) => sddcSettings(h));
    expect(result.error).toBe(null);
    expect(result.outputs.problemCount).toBe(0);
    expect(requests.filter((r) => r.method !== 'GET').map((r) => r.path)).toEqual(['/v1/tokens', '/v1/system/check-sets/queries', '/v1/system/prechecks']);
  });
});

describe('pkg fleet-tags: fleet_host_commission', { skip: !CURL }, () => {
  const p = pkg('fleet_host_commission');
  const passwords = { ESXI_PW_ESX05_EXAMPLE_COM: 'Esx5-do-not-log', ESXI_PW_ESX06_EXAMPLE_COM: 'Esx6-do-not-log', ESXI_PW_ESX07_EXAMPLE_COM: 'Esx7-do-not-log', ESXI_PW_ESX08_EXAMPLE_COM: 'Esx8-do-not-log' };
  const routes = (result = 'SUCCEEDED') => () =>
    sddcBase([
      at('GET', '/v1/network-pools', { elements: [{ id: 'np-1', name: 'wld-01-np01' }] }),
      at('GET', '/v1/hosts', { elements: [{ fqdn: 'esx05.example.com', status: 'ASSIGNED' }] }),
      { method: 'POST', path: '^/v1/hosts/validations$', body: { id: 'v1' } },
      at('GET', '/v1/hosts/validations/v1', { executionStatus: 'COMPLETED', resultStatus: result, validationChecks: [{ resultStatus: result, description: 'Host reachable' }] }),
      { method: 'POST', path: '^/v1/hosts$', body: { id: 'task-h' } },
      at('GET', '/v1/tasks/task-h', { status: 'SUCCESSFUL' }),
    ]);
  const settings = (h: string, extra: Record<string, unknown> = {}) => sddcSettings(h, { ...passwords, ...extra });

  it('dry run: validates the hosts it does not have yet, and commissions nothing', async () => {
    const { result, requests } = await runPkg(p, routes(), (h) => settings(h));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual(['POST /v1/hosts/validations']);
    const spec = JSON.parse(requests.find((r) => r.path === '/v1/hosts/validations')!.body) as { fqdn: string; networkPoolId: string; password: string }[];
    expect(spec.map((h) => h.fqdn)).toEqual(['esx06.example.com', 'esx07.example.com', 'esx08.example.com']);
    expect(spec.every((h) => h.networkPoolId === 'np-1')).toBe(true);
    expect(spec[0]!.password).toBe('Esx6-do-not-log');
    expect(result.logs.some((l) => l.message.startsWith('Already in SDDC Manager (ASSIGNED), left alone: esx05.example.com'))).toBe(true);
  });

  it('armed: commissions the same spec once validation passed, and follows the task', async () => {
    const { result, requests } = await runPkg(p, routes(), (h) => settings(h, { dryRun: false }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual(['POST /v1/hosts/validations', 'POST /v1/hosts']);
    expect(requests.find((r) => r.method === 'POST' && r.path === '/v1/hosts')!.body).toBe(requests.find((r) => r.path === '/v1/hosts/validations')!.body);
    expect(result.outputs.commissionTaskId).toBe('task-h');
  });

  it('a failed validation commissions nothing; a missing password sends nothing at all', async () => {
    const failed = await runPkg(p, routes('FAILED'), (h) => settings(h, { dryRun: false }));
    expect(writes(failed.requests)).toEqual(['POST /v1/hosts/validations']);
    expect(failed.result.error ?? '').toContain('did not succeed');
    const missing = await runPkg(p, routes(), (h) => sddcSettings(h, { ...passwords, ESXI_PW_ESX07_EXAMPLE_COM: '', dryRun: false }));
    expect(missing.requests.filter((r) => r.path !== '/v1/tokens').length).toBe(0);
    expect(missing.result.error ?? '').toContain('ESXI_PW_ESX07_EXAMPLE_COM');
  });
});
