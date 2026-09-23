/**
 * The VCF Operations "build" and VCF Operations for Networks 9.1 automations,
 * as Orchestrator packages (src/automation/blueprints/vcf-ops-build.ts).
 *
 * For each of them: the package builds and reads back, every script is ES5,
 * every secret is an empty SecureString, IMPORT.md names the package — and the
 * workflow runs in the emulator against a fake VCF Operations, CASA, HCX,
 * Prometheus or Networks in another process:
 *
 *   - the content importers (dashboard, view, report) change nothing in a dry
 *     run; armed, they export first, read the instance marker, upload a zip
 *     that unzip -t and the toolkit's own reader of real exports accept, and
 *     follow the import by its id; a skip is left alone, the cap and the first
 *     failure stop them, and the report is scheduled once only;
 *   - the management pack workflow prechecks, installs an uploaded pak and
 *     creates the account once, and refuses on a failed precheck;
 *   - the orchestrator template refuses too many targets and, armed, refuses
 *     until its change is written;
 *   - the read-only reports (source test, HCX readiness, VPC facts, waves,
 *     assessment, problems) send only GETs and the documented POST-for-query,
 *     and produce the right output; the waves are the blueprint's own plan.
 *
 * No secret appears in any log, output or error.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { readPackageSpec, type VroPackageSpec } from '../../kit/vro-package.ts';
import { openZip } from '../../core/zip.ts';
import { readAriaFile } from '../../aria/parse.ts';
import { automationFor } from '../blueprints/index.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../../testing/fake-rest-server.ts';
import { DASHBOARD_OWNER_PLACEHOLDER } from '../vcfops-import.ts';

const IDS = [
  'vcfops_dashboard',
  'vcfops_view',
  'vcfops_report',
  'vcfops_management_pack',
  'vcfops_mp_builder',
  'vcfops_orchestrator',
  'vcfops_integrations_hcx',
  'vcfnet91_vpc_planning',
  'vcfnet91_migration_waves',
  'vcfnet91_assessment',
  'vcfnet91_health',
] as const;

/** The bytes of a string of byte values (what zipStored returns, and what the fake server logged). */
const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** CRC-32 of the UTF-8 bytes of a string, as zip computes it. */
function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
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
const UNZIP = has('unzip');

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

function pkgOf(files: Record<string, string>): Pkg {
  const packages = packagesIn(files);
  const dir = Object.keys(packages).find((d) => d !== 'com.archtoolkit.core.package')!;
  const spec = readPackageSpec(packages[dir]!);
  return { files, dir, spec, workflow: spec.workflows[0]!.name, configKey: `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}` };
}

/** Every log line, output and error of a run: where a secret must never be. */
const logText = (run: WorkflowRun): string => run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');

const servers: FakeServer[] = [];
after(() => servers.forEach((s) => s.stop()));

async function run(pkg: Pkg, routes: readonly FakeRoute[], settings: (host: string) => Record<string, unknown>, inputs: Record<string, unknown> = {}) {
  const server = await startFakeServer(routes);
  servers.push(server);
  const host = `127.0.0.1:${server.port}`;
  const emulator = new VroEmulator(pkg.files, { config: { [pkg.configKey]: settings(host) } });
  const result = emulator.runWorkflow(pkg.workflow, inputs);
  const requests = server.requests();
  expect(/do-not-log/.test(logText(result))).toBe(false);
  return { result, requests, host, calls: requests.map((r) => `${r.method} ${r.path.split('?')[0]}`) };
}

// ---------------------------------------------------------------------------

describe('pkg ops-build: every package', () => {
  for (const id of IDS) {
    it(`${id}: builds, reads back, is ES5, keeps its secrets empty, and is named in IMPORT.md`, () => {
      const blueprint = automationFor(id)!;
      const base = defaultValues(blueprint);
      const variants: BlueprintValues[] = [base];
      for (const input of blueprint.inputs) {
        if (input.control === 'select') for (const option of input.options ?? []) variants.push({ ...base, [input.id]: option.value });
        if (input.control === 'toggle') variants.push({ ...base, [input.id]: !base[input.id] });
      }
      for (const values of variants) {
        const files = { ...blueprint.build(values, id).files };
        const packages = packagesIn(files);
        expect(Object.keys(packages).length).toBe(2);
        for (const [dir, text] of Object.entries(packages)) {
          const spec = readPackageSpec(text);
          const problems: string[] = [];
          for (const a of spec.actions) problems.push(...es5Problems(a.script, `${dir}/${a.name}`));
          for (const w of spec.workflows) {
            const script = [...w.xml.matchAll(/<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/g)].map((m) => [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join(''));
            expect(script.length).toBe(1);
            problems.push(...es5Problems(script[0]!, `${dir}/${w.name}`));
          }
          expect(problems).toEqual([]);
          for (const c of spec.configs) for (const a of c.attributes) if (a.type === 'SecureString') expect(a.value).toBe(undefined);
          for (const r of spec.resources) if (r.name.endsWith('.json')) JSON.parse(r.content);
          expect(files['IMPORT.md']!.includes(`import/${dir}`)).toBe(true);
        }
        // The loader refuses anything that is not Orchestrator JavaScript.
        new VroEmulator(files);
        const pkg = pkgOf(files);
        expect(pkg.spec.workflows.length).toBe(1);
        expect(pkg.spec.name.startsWith('com.archtoolkit.')).toBe(true);
        // The fallback scripts live under scripts/ (the content importers keep theirs at the root).
        for (const path of Object.keys(files)) if (path.endsWith('.sh') && !/^(import-[a-z]+|export-reference)\.sh$/.test(path)) expect(path.startsWith('scripts/')).toBe(true);
      }
    });
  }

  it('the changing ones are a dry run with a cap by default', () => {
    for (const id of ['vcfops_dashboard', 'vcfops_view', 'vcfops_report', 'vcfops_management_pack', 'vcfops_orchestrator']) {
      const pkg = pkgOf(build(id));
      const attrs = pkg.spec.configs[0]!.attributes;
      expect(attrs.find((a) => a.name === 'dryRun')?.value).toBe(true);
      expect(typeof attrs.find((a) => a.name === 'cap')?.value).toBe('number');
      expect(pkg.spec.workflows[0]!.xml.includes('<param name="dryRun" type="boolean"')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The ASCII-safe zip

/** An owner id whose own CRC-32 has no byte above 0x7F, so the whole upload is ASCII (the emulator sends UTF-8). */
const OWNER = (() => {
  for (let i = 0; i < 10000; i++) {
    const id = `5f1c0de0-0000-4000-a000-${String(i).padStart(12, '0')}`;
    if ((crc32(id) & 0x80808080) === 0) return id;
  }
  throw new Error('no owner id');
})();
const MARKER = '6844548499441080431L.v1';

function unzipTest(bytes: Uint8Array): void {
  const dir = mkdtempSync(join(tmpdir(), 'atk-zip-'));
  try {
    writeFileSync(join(dir, 'x.zip'), bytes);
    execFileSync('unzip', ['-tq', join(dir, 'x.zip')], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The zip inside a multipart body the fake server logged. */
function uploadedZip(request: FakeRequest): Uint8Array {
  const boundary = /boundary=([^;\s]+)/.exec(request.headers['content-type'] ?? '')?.[1];
  if (!boundary) throw new Error('no boundary');
  expect(request.headers['content-type']!.startsWith('multipart/form-data')).toBe(true);
  expect(request.body.includes('Content-Disposition: form-data; name="contentFile"; filename="content.zip"')).toBe(true);
  const start = request.body.indexOf('\r\n\r\n') + 4;
  const end = request.body.lastIndexOf(`\r\n--${boundary}--`);
  return latin1(request.body.slice(start, end));
}

describe('pkg ops-build: the content zip', { skip: !UNZIP }, () => {
  const files = build('vcfops_view');
  const pkg = pkgOf(files);
  const emulator = new VroEmulator(files);
  const mod = emulator.module(pkg.spec.name) as { zipStored: (entries: unknown) => string; ascii: (text: string, kind: string) => string };

  it('is a valid zip with every number free of bytes above 0x7F, except a fixed entry\'s CRC', () => {
    // A marker whose CRC has high bytes, a long text that pushes offsets past 32 KB, a nested zip.
    let marker = 'x';
    for (let i = 0; (crc32(marker) & 0x80808080) === 0; i++) marker = `owner-${i}`;
    const inner = mod.zipStored([{ name: 'content.xml', data: '<Content/>\n', pad: 'text' }]);
    const zip = mod.zipStored([
      { name: MARKER, data: marker, pad: 'none' },
      { name: 'big.json', data: `{"a": "${'a'.repeat(33000)}"}`, pad: 'text' },
      { name: 'views.zip', data: inner, pad: 'zip' },
      { name: 'empty.properties', data: '', pad: 'text' },
    ]);
    const bytes = latin1(zip);
    unzipTest(bytes);
    const high = [...bytes].filter((b) => b > 0x7f).length;
    expect(high > 0 && high <= 8).toBe(true);
    // Without the fixed entry every byte is ASCII.
    const ascii = latin1(mod.zipStored([{ name: 'a.json', data: '{"x": 1}\n', pad: 'text' }, { name: 'views.zip', data: inner, pad: 'zip' }]));
    expect([...ascii].every((b) => b < 0x80)).toBe(true);
    unzipTest(ascii);
  });

  it('keeps the content: padding is trailing whitespace, and non-ASCII becomes an escape of the same character', async () => {
    const json = mod.ascii('{"name": "Café — ☃ 𝄞"}', 'json');
    expect(JSON.parse(json).name).toBe('Café — ☃ 𝄞');
    expect(/^[\x00-\x7f]*$/.test(json)).toBe(true);
    expect(mod.ascii('<a t="é">𝄞</a>', 'xml')).toBe('<a t="&#233;">&#119070;</a>');
    const zip = openZip(latin1(mod.zipStored([{ name: 'j.json', data: json, pad: 'text' }])));
    const back = await zip.text('j.json');
    expect(back.trimEnd()).toBe(json);
    expect(() => mod.zipStored([{ name: 'j.json', data: '☃', pad: 'text' }])).toThrow(/above 0xFF/);
  });
});

// ---------------------------------------------------------------------------
// VCF Operations routes

const OPS_PASSWORD = 'Ops-Pa55word-do-not-log';
const OPS_TOKEN = 'ops-token-do-not-log';

const opsAuthRoutes: FakeRoute[] = [
  { method: 'POST', path: '^/suite-api/api/auth/token/acquire$', body: { token: OPS_TOKEN, validity: 0 } },
  { method: 'POST', path: '^/suite-api/api/auth/token/release$', body: '' },
];

interface ContentOptions {
  readonly busy?: boolean;
  readonly imported?: number;
  readonly skipped?: number;
  readonly failed?: number;
  readonly importStatus?: number;
}

function contentRoutes(o: ContentOptions = {}): FakeRoute[] {
  return [
    ...opsAuthRoutes,
    { method: 'GET', path: '^/suite-api/api/auth/currentuser$', body: { id: OWNER, username: 'automation' } },
    {
      method: 'GET',
      path: '^/suite-api/api/content/operations/import$',
      responses: [
        { body: { id: 'imp-0', state: o.busy ? 'RUNNING' : 'FINISHED' } },
        { body: { id: 'imp-1', state: 'RUNNING' } },
        { body: { id: 'imp-1', state: 'FINISHED', operationSummaries: [{ contentType: 'X', imported: o.imported ?? 1, skipped: o.skipped ?? 0, failed: o.failed ?? 0 }] } },
      ],
    },
    {
      method: 'GET',
      path: '^/suite-api/api/content/operations/export$',
      responses: [{ status: 404, body: {} }, { body: { id: 'exp-1', state: 'RUNNING', startTime: 2 } }, { body: { id: 'exp-1', state: 'FINISHED', startTime: 2 } }],
    },
    { method: 'POST', path: '^/suite-api/api/content/operations/export$', status: 202, body: {} },
    // The export download is binary; the workflow only needs the marker's name from it.
    { method: 'GET', path: '^/suite-api/api/content/operations/export/zip$', body: `PK\u0003\u0004 deflated bytes ${MARKER} more bytes` },
    { method: 'POST', path: '^/suite-api/api/content/operations/import\\?force=(true|false)$', status: o.importStatus ?? 202, body: o.importStatus ? { message: `refused ${OPS_PASSWORD}` } : { id: 'imp-1' } },
  ];
}

const opsSettings = (extra: Record<string, unknown> = {}) => (host: string) => ({ opsHost: host, opsUsername: 'automation', opsPassword: OPS_PASSWORD, ...extra });
const writesOf = (requests: FakeRequest[]) => requests.filter((r) => r.method !== 'GET' && !/\/auth\/token\/(acquire|release)$/.test(r.path)).map((r) => `${r.method} ${r.path}`);

const IMPORT_SEQUENCE = [
  'POST /suite-api/api/auth/token/acquire',
  'GET /suite-api/api/auth/currentuser',
  'GET /suite-api/api/content/operations/import',
  'GET /suite-api/api/content/operations/export',
  'POST /suite-api/api/content/operations/export',
  'GET /suite-api/api/content/operations/export',
  'GET /suite-api/api/content/operations/export',
  'GET /suite-api/api/content/operations/export/zip',
  'POST /suite-api/api/content/operations/import',
  'GET /suite-api/api/content/operations/import',
  'GET /suite-api/api/content/operations/import',
];

describe('pkg ops-build: the dashboard, imported through Content Management', { skip: !CURL || !UNZIP }, () => {
  const pkg = pkgOf(build('vcfops_dashboard'));

  it('dry run by default: reads who it would import as, plans one import, writes nothing', async () => {
    const { result, requests, calls } = await run(pkg, contentRoutes(), opsSettings());
    expect(result.error).toBe(null);
    expect(writesOf(requests)).toEqual([]);
    expect(calls).toEqual(['POST /suite-api/api/auth/token/acquire', 'GET /suite-api/api/auth/currentuser', 'GET /suite-api/api/content/operations/import', 'POST /suite-api/api/auth/token/release']);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would import the dashboard "Cluster capacity overview"')).length).toBe(1);
    expect(result.outputs.importId).toBe('');
  });

  it('the dryRun input can only make a run safer', async () => {
    const { requests } = await run(pkg, contentRoutes(), opsSettings({ dryRun: false }), { dryRun: true });
    expect(writesOf(requests)).toEqual([]);
  });

  it('armed: exports first, reads the marker, uploads a package VCF Operations reads as a dashboard export, follows the import by id', async () => {
    const { result, requests, calls } = await run(pkg, contentRoutes(), opsSettings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(calls).toEqual([...IMPORT_SEQUENCE, 'POST /suite-api/api/auth/token/release']);
    expect(JSON.parse(requests.find((r) => r.method === 'POST' && r.path.endsWith('/export'))!.body)).toEqual({ scope: 'CUSTOM', contentTypes: ['DASHBOARDS'] });
    const upload = requests.find((r) => r.method === 'POST' && r.path.startsWith('/suite-api/api/content/operations/import'))!;
    expect(upload.path).toBe('/suite-api/api/content/operations/import?force=false');
    expect(requests.every((r) => r.path.endsWith('/acquire') || r.headers.authorization === `OpsToken ${OPS_TOKEN}`)).toBe(true);
    const bytes = uploadedZip(upload);
    unzipTest(bytes);
    const zip = openZip(bytes);
    expect([...zip.names]).toEqual([MARKER, `dashboards/${OWNER}`, `dashboardsharings/${OWNER}`, 'usermappings.json', 'configuration.json']);
    expect(await zip.text(MARKER)).toBe(OWNER);
    const inner = await zip.bytes(`dashboards/${OWNER}`);
    unzipTest(inner);
    const dashboard = JSON.parse(await openZip(inner).text('dashboard/dashboard.json')) as { dashboards: { id: string; userId: string }[] };
    expect(dashboard.dashboards[0]!.userId).toBe(OWNER);
    expect(JSON.stringify(dashboard).includes(DASHBOARD_OWNER_PLACEHOLDER)).toBe(false);
    expect(JSON.parse(await zip.text(`dashboardsharings/${OWNER}`))).toEqual([{ groupName: 'Everyone', sourceType: 'LOCAL', dashboards: [{ dashboardId: dashboard.dashboards[0]!.id }] }]);
    expect(JSON.parse(await zip.text('configuration.json'))).toEqual({ dashboards: 1, dashboardsByOwner: [{ owner: OWNER, count: 1 }], type: 'CUSTOM' });
    // The toolkit's own reader of real exports reads it as one.
    const content = await readAriaFile('vcfops-content.zip', bytes);
    expect(content.dashboards.map((d) => d.name)).toEqual(['Cluster capacity overview']);
    expect(result.outputs.importId).toBe('imp-1');
    expect((JSON.parse(String(result.outputs.summary)) as { changes: unknown[] }).changes.length).toBe(1);
  });

  it('with overwrite, imports with force=true', async () => {
    const { requests } = await run(pkg, contentRoutes(), opsSettings({ dryRun: false, overwrite: true }));
    expect(writesOf(requests)).toEqual(['POST /suite-api/api/content/operations/export', 'POST /suite-api/api/content/operations/import?force=true']);
  });

  it('leaves a dashboard already there alone: a skip is not a failure', async () => {
    const { result } = await run(pkg, contentRoutes({ imported: 0, skipped: 1 }), opsSettings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(result.logs.some((l) => l.message.startsWith('Already in VCF Operations'))).toBe(true);
  });

  it('refuses while another import runs, before any change', async () => {
    const { result, requests } = await run(pkg, contentRoutes({ busy: true }), opsSettings({ dryRun: false }));
    expect(result.error ?? '').toContain('Another content import is RUNNING');
    expect(writesOf(requests)).toEqual([]);
  });

  it('stops at the cap, before the change that would exceed it', async () => {
    const { result, requests } = await run(pkg, contentRoutes(), opsSettings({ dryRun: false, cap: 0 }));
    expect(result.error ?? '').toContain('Cap reached: 0 change(s) made, the cap is 0; stopping before: import the dashboard');
    expect(writesOf(requests)).toEqual([]);
  });

  it('stops at the first failure, says what failed, never echoes the password, and still logs out', async () => {
    const { result, requests } = await run(pkg, contentRoutes({ importStatus: 500 }), opsSettings({ dryRun: false }));
    expect(result.error ?? '').toContain('Stopped after 0 change(s): import the dashboard "Cluster capacity overview" through Content Management (force=false) failed: POST https://127.0.0.1:');
    expect(result.error ?? '').toContain('/suite-api/api/content/operations/import returned HTTP 500');
    expect(requests[requests.length - 1]!.path).toBe('/suite-api/api/auth/token/release');
  });

  it('fails when the import finishes with failed items', async () => {
    const { result } = await run(pkg, contentRoutes({ failed: 1, imported: 0 }), opsSettings({ dryRun: false }));
    expect(result.error ?? '').toContain('Import imp-1 FINISHED with 1 failed item(s)');
  });
});

describe('pkg ops-build: the view, imported through Content Management', { skip: !CURL || !UNZIP }, () => {
  it('dry run writes nothing; armed uploads views.zip with the view the dashboard refers to', async () => {
    const pkg = pkgOf(build('vcfops_view'));
    const dry = await run(pkg, contentRoutes(), opsSettings());
    expect(writesOf(dry.requests)).toEqual([]);
    const { result, requests, calls } = await run(pkg, contentRoutes(), opsSettings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(calls).toEqual([...IMPORT_SEQUENCE, 'POST /suite-api/api/auth/token/release']);
    expect(JSON.parse(requests.find((r) => r.method === 'POST' && r.path.endsWith('/export'))!.body).contentTypes).toEqual(['VIEW_DEFINITIONS']);
    const bytes = uploadedZip(requests.find((r) => r.path.startsWith('/suite-api/api/content/operations/import?'))!);
    unzipTest(bytes);
    expect([...openZip(bytes).names]).toEqual([MARKER, 'views.zip', 'configuration.json']);
    const content = await readAriaFile('vcfops-content.zip', bytes);
    expect(content.views.map((v) => v.name)).toEqual(['Cluster capacity overview']);
    expect(result.outputs.importId).toBe('imp-1');
  });

  it('refuses a view whose column key is still <REQUIRED>, before any change', async () => {
    const pkg = pkgOf(build('vcfops_view', { template: 'certs' }));
    const { result, requests } = await run(pkg, contentRoutes(), opsSettings({ dryRun: false }));
    expect(result.error ?? '').toContain('views.zip still holds a <REQUIRED> value');
    expect(writesOf(requests)).toEqual([]);
  });
});

describe('pkg ops-build: the report, imported and scheduled', { skip: !CURL || !UNZIP }, () => {
  const pkg = pkgOf(build('vcfops_report'));
  const reportRoutes = (existing: unknown[] = []): FakeRoute[] => [
    ...contentRoutes(),
    { method: 'GET', path: '^/suite-api/api/resources\\?', body: { resourceList: [{ identifier: 'res-1', resourceKey: { name: 'cluster-01' } }, { identifier: 'res-2', resourceKey: { name: 'cluster-01-old' } }], pageInfo: { totalCount: 2 } } },
    { method: 'GET', path: '^/suite-api/api/reportdefinitions\\?', body: { reportDefinitions: [{ id: 'rd-1', name: 'Monthly capacity and reclamation' }], pageInfo: { totalCount: 1 } } },
    { method: 'GET', path: '^/suite-api/api/reportdefinitions/rd-1/schedules$', body: { reportSchedules: existing } },
    { method: 'POST', path: '^/suite-api/api/reportdefinitions/rd-1/schedules$', body: { id: 'sch-1' } },
  ];
  const settings = (extra: Record<string, unknown> = {}) => opsSettings({ resourceName: 'cluster-01', startDate: '2026-10-01', timezone: 'Europe/London', ...extra });

  it('dry run: resolves the object, plans the import and the schedule, writes nothing', async () => {
    const { result, requests } = await run(pkg, reportRoutes(), settings());
    expect(result.error).toBe(null);
    expect(writesOf(requests)).toEqual([]);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would')).map((l) => l.message.split(' (')[0])).toEqual(['DRY RUN: would import the report "Monthly capacity and reclamation" through Content Management', 'DRY RUN: would schedule the report "Monthly capacity and reclamation"']);
  });

  it('armed: imports the definition, finds it by name, and schedules it for the one object', async () => {
    const { result, requests, calls } = await run(pkg, reportRoutes(), settings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(calls).toEqual([
      'POST /suite-api/api/auth/token/acquire',
      'GET /suite-api/api/resources',
      ...IMPORT_SEQUENCE.slice(1),
      'GET /suite-api/api/reportdefinitions',
      'GET /suite-api/api/reportdefinitions/rd-1/schedules',
      'POST /suite-api/api/reportdefinitions/rd-1/schedules',
      'POST /suite-api/api/auth/token/release',
    ]);
    const bytes = uploadedZip(requests.find((r) => r.path.startsWith('/suite-api/api/content/operations/import?'))!);
    unzipTest(bytes);
    expect((await readAriaFile('vcfops-content.zip', bytes)).reports.map((r) => r.name)).toEqual(['Monthly capacity and reclamation']);
    const post = requests.find((r) => r.method === 'POST' && r.path.endsWith('/schedules'))!;
    const body = JSON.parse(post.body) as Record<string, unknown>;
    expect(body.reportDefinitionId).toBe('rd-1');
    expect(body.resourceId).toEqual(['res-1']);
    expect(body.startDate).toBe('2026-10-01');
    expect(body.reportScheduleType).toBe('MONTHLY');
    expect(body.emailAddresses).toEqual(['platform-team@example.com']);
    expect(post.headers['x-ops-api-timezone']).toBe('Europe/London');
    expect(result.outputs.scheduleId).toBe('sch-1');
    expect((JSON.parse(String(result.outputs.summary)) as { changes: unknown[] }).changes.length).toBe(2);
  });

  it('leaves an existing schedule for the same object alone', async () => {
    const { result, requests } = await run(pkg, reportRoutes([{ id: 'sch-old', resourceId: ['res-1'] }]), settings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(writesOf(requests).filter((w) => w.includes('/schedules'))).toEqual([]);
    expect(result.outputs.scheduleId).toBe('sch-old');
  });

  it('stops at the cap after the import, before the schedule', async () => {
    const { result, requests } = await run(pkg, reportRoutes(), settings({ dryRun: false, cap: 1 }));
    expect(result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: schedule the report');
    expect(writesOf(requests).filter((w) => w.includes('/schedules'))).toEqual([]);
  });

  it('refuses without a start date or with an ambiguous object, before any change', async () => {
    const noDate = await run(pkg, reportRoutes(), settings({ dryRun: false, startDate: '' }));
    expect(noDate.result.error ?? '').toContain('Set startDate');
    expect(writesOf(noDate.requests)).toEqual([]);
    const ambiguous = await run(pkg, [{ method: 'GET', path: '^/suite-api/api/resources\\?', body: { resourceList: [{ identifier: 'a', resourceKey: { name: 'cluster-01' } }, { identifier: 'b', resourceKey: { name: 'cluster-01' } }], pageInfo: { totalCount: 2 } } }, ...reportRoutes()], settings({ dryRun: false }));
    expect(ambiguous.result.error ?? '').toContain("Expected exactly one ClusterComputeResource named 'cluster-01', found 2");
    expect(writesOf(ambiguous.requests)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The management pack

const CASA_PASSWORD = 'Casa-Pa55word-do-not-log';

describe('pkg ops-build: the management pack', { skip: !CURL }, () => {
  const files = build('vcfops_management_pack', { adapter_kind: 'HCX' });
  const base = pkgOf(files);
  // The account as a person fills the resource element in.
  const accountPath = Object.keys(files).find((p) => p.startsWith(`import/${base.dir}/resources/`) && p.endsWith('/account.json'))!;
  const filled = { ...files, [accountPath]: `${JSON.stringify({ ...JSON.parse(files[accountPath]!), collectorId: '1', resourceIdentifiers: [{ name: 'HCXHOST', value: 'hcx-mgr01.example.com' }], credential: { id: 'cred-1' } }, null, 2)}\n` };
  const pkg = pkgOf(filled);
  const routes = (o: { solutions?: unknown[]; status?: string; adapters?: unknown[] } = {}): FakeRoute[] => [
    ...opsAuthRoutes,
    { method: 'GET', path: '^/suite-api/api/versions/current$', body: { releaseName: 'VCF Operations 9.1.0.0', major: 9, minor: 1 } },
    { method: 'GET', path: '^/suite-api/api/solutions$', body: { solution: o.solutions ?? [{ id: 'VMWARE', name: 'vSphere', version: '9.1.0', adapterKindKeys: ['VMWARE'] }] } },
    { method: 'POST', path: '^/casa/upgrade/cluster/pak/pak-9/operation/install$', body: {} },
    { method: 'GET', path: '^/casa/upgrade/cluster/pak/pak-9/status$', responses: [{ body: { cluster_pak_install_status: 'CANDIDATE' } }, { body: { cluster_pak_install_status: o.status ?? 'COMPLETED' } }] },
    { method: 'GET', path: '^/suite-api/api/adapters\\?adapterKindKey=HCX$', body: { adapterInstancesInfoDto: o.adapters ?? [] } },
    { method: 'POST', path: '^/suite-api/api/adapters$', body: { id: 'ad-1' } },
  ];
  const settings = (extra: Record<string, unknown> = {}) => opsSettings({ casaPassword: CASA_PASSWORD, pakVersion: '9.1.0', pakAdapterKinds: ['hcx'], pakId: 'pak-9', changeTicket: 'CHG-1', ...extra });

  it('dry run: prechecks, plans the install and the account, writes nothing', async () => {
    const { result, requests } = await run(pkg, routes(), settings());
    expect(result.error).toBe(null);
    expect(writesOf(requests)).toEqual([]);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would')).map((l) => l.message)).toEqual(['DRY RUN: would install management pack pak-9 [CHG-1]', 'DRY RUN: would create the account "hcx-mgr01.example.com (ArchToolKit)"']);
  });

  it('armed: installs the uploaded pak through CASA as the cluster admin, then creates the account', async () => {
    const { result, requests, calls } = await run(pkg, routes(), settings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(calls).toEqual([
      'POST /suite-api/api/auth/token/acquire',
      'GET /suite-api/api/versions/current',
      'GET /suite-api/api/solutions',
      'POST /casa/upgrade/cluster/pak/pak-9/operation/install',
      'GET /casa/upgrade/cluster/pak/pak-9/status',
      'GET /casa/upgrade/cluster/pak/pak-9/status',
      'GET /suite-api/api/adapters',
      'POST /suite-api/api/adapters',
      'POST /suite-api/api/auth/token/release',
    ]);
    const casa = requests.filter((r) => r.path.startsWith('/casa/'));
    expect(casa.every((r) => r.headers.authorization === `Basic ${btoa(`admin:${CASA_PASSWORD}`)}`)).toBe(true);
    const account = JSON.parse(requests.find((r) => r.method === 'POST' && r.path === '/suite-api/api/adapters')!.body) as { adapterKindKey: string; credential: { id: string } };
    expect(account.adapterKindKey).toBe('HCX');
    expect(account.credential).toEqual({ id: 'cred-1' });
  });

  it('second run: the same version installed and the account there — changes nothing', async () => {
    const { result, requests } = await run(pkg, routes({ solutions: [{ id: 'hcx', name: 'VMware HCX', version: '9.1.0', adapterKindKeys: ['HCX'] }], adapters: [{ id: 'ad-1', resourceKey: { name: 'hcx-mgr01.example.com (ArchToolKit)' } }] }), settings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(writesOf(requests)).toEqual([]);
  });

  it('a failed precheck changes nothing: a downgrade, or an install over a pack without upgrade', async () => {
    const downgrade = await run(pkg, routes({ solutions: [{ id: 'hcx', name: 'HCX', version: '9.2.0', adapterKindKeys: ['HCX'] }] }), settings({ dryRun: false, upgrade: true }));
    expect(downgrade.result.error ?? '').toContain('9.1.0 is older than the installed 9.2.0');
    expect(writesOf(downgrade.requests)).toEqual([]);
    const over = await run(pkg, routes({ solutions: [{ id: 'hcx', name: 'HCX', version: '9.0.0', adapterKindKeys: ['hcx'] }] }), settings({ dryRun: false }));
    expect(over.result.error ?? '').toContain('Installing would replace it; set upgrade to true');
    expect(writesOf(over.requests)).toEqual([]);
  });

  it('stops at the cap, and at a failed install before the account', async () => {
    const capped = await run(pkg, routes(), settings({ dryRun: false, cap: 1 }));
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: create the account');
    expect(writesOf(capped.requests)).toEqual(['POST /casa/upgrade/cluster/pak/pak-9/operation/install']);
    const failed = await run(pkg, routes({ status: 'FAILED' }), settings({ dryRun: false }));
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): install management pack pak-9 [CHG-1] failed: the install is FAILED');
    expect(writesOf(failed.requests)).toEqual(['POST /casa/upgrade/cluster/pak/pak-9/operation/install']);
    expect(failed.requests[failed.requests.length - 1]!.path).toBe('/suite-api/api/auth/token/release');
  });

  it('armed, refuses an account still <REQUIRED> and an install without a change ticket, before any change', async () => {
    const unfilled = await run(pkgOf(files), routes(), settings({ dryRun: false }));
    expect(unfilled.result.error ?? '').toContain('account.json still holds <REQUIRED> values');
    expect(writesOf(unfilled.requests)).toEqual([]);
    const noTicket = await run(pkg, routes(), settings({ dryRun: false, changeTicket: '' }));
    expect(noTicket.result.error ?? '').toContain('Set changeTicket');
    expect(writesOf(noTicket.requests)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The Management Pack Builder source test

const SOURCE_TOKEN = 'prom-token-do-not-log';

describe('pkg ops-build: the Management Pack Builder source test', { skip: !CURL }, () => {
  it('Prometheus: one GET per query with the bearer token; a query with no series fails the run', async () => {
    const pkg = pkgOf(build('vcfops_mp_builder'));
    const routes: FakeRoute[] = [
      {
        method: 'GET',
        path: '^/api/v1/query\\?query=',
        responses: [{ body: { status: 'success', data: { resultType: 'vector', result: [{ metric: { instance: 'broker-1' }, value: [1, '42'] }, { metric: {}, value: [1, '7'] }] } } }, { body: { status: 'success', data: { resultType: 'vector', result: [] } } }],
      },
    ];
    const { result, requests } = await run(pkg, routes, (host) => ({ sourceUrl: `https://${host}`, sourceSecret: SOURCE_TOKEN }));
    expect(requests.map((r) => r.method)).toEqual(['GET', 'GET']);
    expect(decodeURIComponent(requests[0]!.path.split('query=')[1]!)).toBe('sum by (instance) (rate(kafka_server_brokertopicmetrics_bytesin_total[5m]))');
    expect(requests.every((r) => r.headers.authorization === `Bearer ${SOURCE_TOKEN}`)).toBe(true);
    expect(String(result.outputs.report).split('\n')).toEqual(['Bytes in per sec: 2 series', '  broker-1  42', '  (no instance label)  7', 'Under-replicated partitions: 0 series']);
    expect(result.outputs.problemCount).toBe(1);
    expect(result.error ?? '').toContain('1 quer(ies) or field(s) returned nothing to map');
  });

  it('REST with basic auth: the list request and the field of each metric', async () => {
    const pkg = pkgOf(build('vcfops_mp_builder', { source: 'rest', auth: 'basic', metrics: 'Bytes in = stats.bytesIn\nPartitions = partitions[0]\nMissing = nope' }));
    const routes: FakeRoute[] = [{ method: 'GET', path: '^/api/v1/brokers$', body: { items: [{ instance: 'b1', stats: { bytesIn: 12 }, partitions: [3, 4] }] } }];
    const { result, requests } = await run(pkg, routes, (host) => ({ sourceUrl: `https://${host}`, sourceUser: 'reader', sourceSecret: SOURCE_TOKEN }));
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v1/brokers']);
    expect(requests[0]!.headers.authorization).toBe(`Basic ${btoa(`reader:${SOURCE_TOKEN}`)}`);
    expect(String(result.outputs.report).split('\n')).toEqual(['Kafka Broker: 1 item(s) at .items', 'Bytes in: 12', 'Partitions: 3', 'Missing: MISSING']);
    expect(result.outputs.problemCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The orchestrator template

describe('pkg ops-build: the orchestrator workflow template', () => {
  const pkg = pkgOf(build('vcfops_orchestrator'));
  const emulator = () => new VroEmulator(pkg.files, { config: { [pkg.configKey]: { dryRun: false } } });

  it('dry run by default: one "would act on" per target, no calls', () => {
    const result = new VroEmulator(pkg.files).runWorkflow(pkg.workflow, { targets: ['vm-1', 'vm-2'] });
    expect(result.error).toBe(null);
    expect(result.calls).toEqual([]);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would')).map((l) => l.message)).toEqual(['DRY RUN: would act on vm-1', 'DRY RUN: would act on vm-2']);
    expect(JSON.parse(String(result.outputs.result))).toEqual({ dryRun: true, changed: [], count: 0 });
  });

  it('refuses more targets than maxTargets, or than its cap, before the first change', () => {
    expect(emulator().runWorkflow(pkg.workflow, { targets: ['a', 'b', 'c'], maxTargets: 2 }).error ?? '').toContain('3 targets exceeds maxTargets=2; refusing to run');
    const many = Array.from({ length: 30 }, (_, i) => `vm-${i}`);
    expect(emulator().runWorkflow(pkg.workflow, { targets: many, maxTargets: 100 }).error ?? '').toContain('30 targets exceeds maxTargets=25');
  });

  it('armed, refuses until the change in actOn is written, having changed nothing', () => {
    const result = emulator().runWorkflow(pkg.workflow, { targets: ['vm-1', 'vm-2'] });
    expect(result.error ?? '').toContain('Stopped after 0 change(s): act on vm-1 failed: actOn is a template');
    expect(result.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HCX readiness

const HCX_PASSWORD = 'Hcx-Pa55word-do-not-log';

describe('pkg ops-build: HCX readiness', { skip: !CURL }, () => {
  const routes = (solutions: unknown[]): FakeRoute[] => [
    ...opsAuthRoutes,
    { method: 'GET', path: '^/suite-api/api/solutions$', body: { solution: solutions } },
    // HCX answers the login with the token in a response header, which the emulator does not pass on.
    { method: 'POST', path: '^/hybridity/api/sessions$', body: {} },
  ];
  const settings = (host: string) => ({ opsHost: host, opsUsername: 'reader', opsPassword: OPS_PASSWORD, hcxHost: host, hcxUsername: 'svc-hcx-readonly@vsphere.local', hcxPassword: HCX_PASSWORD });

  it('reads the solutions and logs in to HCX, only reads, and fails the run on what should stop a wave', async () => {
    const pkg = pkgOf(build('vcfops_integrations_hcx'));
    const { result, requests, calls } = await run(pkg, routes([{ id: 'hcx', name: 'VMware HCX', version: '9.1.0', adapterKindKeys: ['HCX'] }]), settings);
    expect(calls).toEqual(['POST /suite-api/api/auth/token/acquire', 'GET /suite-api/api/solutions', 'POST /suite-api/api/auth/token/release', 'POST /hybridity/api/sessions']);
    expect(JSON.parse(requests[3]!.body)).toEqual({ username: 'svc-hcx-readonly@vsphere.local', password: HCX_PASSWORD });
    expect(String(result.outputs.report)).toContain('management pack: VMware HCX 9.1.0');
    expect(String(result.outputs.report)).toContain('PROBLEM: HCX Manager did not accept the login, or returned no x-hm-authorization header');
    expect(result.outputs.problemCount).toBe(1);
    expect(result.error ?? '').toContain('Not ready');
  });

  it('reports a missing management pack as a problem', async () => {
    const pkg = pkgOf(build('vcfops_integrations_hcx'));
    const { result } = await run(pkg, routes([{ id: 'VMWARE', name: 'vSphere', version: '9.1.0', adapterKindKeys: ['VMWARE'] }]), settings);
    expect(result.outputs.problemCount).toBe(2);
    expect(String(result.outputs.report)).toContain('PROBLEM: no HCX management pack is installed in VCF Operations');
  });

  it('without the management pack check it never logs in to VCF Operations', async () => {
    const pkg = pkgOf(build('vcfops_integrations_hcx', { check_mp: false }));
    expect(pkg.spec.configs[0]!.attributes.some((a) => a.name === 'opsPassword')).toBe(false);
    const { calls } = await run(pkg, routes([]), settings);
    expect(calls).toEqual(['POST /hybridity/api/sessions']);
  });
});

// ---------------------------------------------------------------------------
// VCF Operations for Networks

const NET_PASSWORD = 'Net-Pa55word-do-not-log';
const NET_TOKEN = 'ni-token-do-not-log';

const netAuthRoutes: FakeRoute[] = [
  { method: 'POST', path: '^/api/ni/auth/token$', body: { token: NET_TOKEN, expiry: 0 } },
  { method: 'DELETE', path: '^/api/ni/auth/token$', status: 204, body: '' },
];
const netSettings = (extra: Record<string, unknown> = {}) => (host: string) => ({ netHost: host, netUsername: 'reader@local', netPassword: NET_PASSWORD, ...extra });
const total = (n: number) => ({ body: { entity_list_response: { total_count: n, results: [] } } });

/** Only the login, the logout, and the documented POST-for-query calls. */
function readsOnly(requests: FakeRequest[]): void {
  const other = requests.filter((r) => r.method !== 'GET' && !(r.method === 'POST' && /^\/api\/ni\/(auth\/token|search\/ql|entities\/fetch|entities\/problems\/fetch)$/.test(r.path)) && !(r.method === 'DELETE' && r.path === '/api/ni/auth/token'));
  expect(other.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  expect(requests.filter((r) => r.path !== '/api/ni/auth/token' || r.method === 'DELETE').every((r) => r.headers.authorization === `NetworkInsight ${NET_TOKEN}`)).toBe(true);
  expect(JSON.parse(requests[0]!.body)).toEqual({ username: 'reader@local', password: NET_PASSWORD, domain: { domain_type: 'LOCAL', value: 'local' } });
  expect(requests[requests.length - 1]!.method).toBe('DELETE');
}

describe('pkg ops-build: Networks VPC planning facts', { skip: !CURL }, () => {
  it('counts the VMs and flows of each port group, and only reads', async () => {
    const pkg = pkgOf(build('vcfnet91_vpc_planning'));
    const routes: FakeRoute[] = [...netAuthRoutes, { method: 'POST', path: '^/api/ni/search/ql$', responses: [total(4), total(120), { body: { search_response_total_hits: 3 } }, total(80), total(2), total(15)] }];
    const { result, requests } = await run(pkg, routes, netSettings());
    expect(result.error).toBe(null);
    readsOnly(requests);
    const queries = requests.filter((r) => r.path === '/api/ni/search/ql').map((r) => JSON.parse(r.body) as { query: string; size: number });
    expect(queries[0]).toEqual({ query: "vms where network = 'pg-orders-web'", size: 1 });
    expect(queries[1]!.query).toBe("flows where source l2 network = 'pg-orders-web' in last 7 days");
    expect(String(result.outputs.observedCsv).trim().split('\n')).toEqual([
      'port_group,vm_count,flows_out,flow_query',
      'pg-orders-web,4,120,"flows where source l2 network = \'pg-orders-web\' in last 7 days"',
      'pg-orders-app,3,80,"flows where source l2 network = \'pg-orders-app\' in last 7 days"',
      'pg-orders-db,2,15,"flows where source l2 network = \'pg-orders-db\' in last 7 days"',
    ]);
  });

  it('a search response without a total is an error, never a zero', async () => {
    const pkg = pkgOf(build('vcfnet91_vpc_planning'));
    const { result, requests } = await run(pkg, [...netAuthRoutes, { method: 'POST', path: '^/api/ni/search/ql$', body: { unexpected: true } }], netSettings());
    expect(result.error ?? '').toContain('No total in the search response');
    expect(requests[requests.length - 1]!.method).toBe('DELETE');
  });
});

describe('pkg ops-build: Networks migration waves', { skip: !CURL }, () => {
  it('pulls every pair\'s flows and plans the same waves as the blueprint', async () => {
    const blueprintFiles = build('vcfnet91_migration_waves');
    const pkg = pkgOf(blueprintFiles);
    // The blueprint's default flows, served by the fake Networks.
    const flows: Record<string, number> = { 'orders-web>orders-app': 12000, 'orders-app>orders-db': 9000, 'orders-app>payments': 300, 'hr-portal>hr-db': 4000, 'reporting>orders-db': 40, 'wiki>wiki-db': 800 };
    const apps = ['hr-db', 'hr-portal', 'orders-app', 'orders-db', 'orders-web', 'payments', 'reporting', 'wiki', 'wiki-db'];
    const answers = apps.flatMap((src) => apps.filter((dst) => dst !== src).map((dst) => total(flows[`${src}>${dst}`] ?? 0)));
    const routes: FakeRoute[] = [
      ...netAuthRoutes,
      { method: 'GET', path: '^/api/ni/groups/applications\\?', responses: [{ body: { results: apps.slice(0, 5).map((_, i) => ({ entity_id: `app-${i}`, entity_type: 'Application' })), cursor: 'c1', total_count: 9 } }, { body: { results: apps.slice(5).map((_, i) => ({ entity_id: `app-${i + 5}`, entity_type: 'Application' })), cursor: 'c2', total_count: 9 } }] },
      { method: 'POST', path: '^/api/ni/entities/fetch$', body: { results: apps.map((name, i) => ({ entity_id: `app-${i}`, entity_type: 'Application', entity: { name } })) } },
      { method: 'POST', path: '^/api/ni/search/ql$', responses: answers },
    ];
    const { result, requests } = await run(pkg, routes, netSettings());
    expect(result.error).toBe(null);
    readsOnly(requests);
    expect(requests.filter((r) => r.path.startsWith('/api/ni/groups/applications')).map((r) => r.path)).toEqual(['/api/ni/groups/applications?size=1000', '/api/ni/groups/applications?size=1000&cursor=c1']);
    expect(JSON.parse(requests.find((r) => r.path === '/api/ni/entities/fetch')!.body).entity_ids.length).toBe(9);
    expect(requests.filter((r) => r.path === '/api/ni/search/ql').length).toBe(72);
    expect(JSON.parse(requests.find((r) => r.path === '/api/ni/search/ql')!.body).query).toBe("flows where source application = 'hr-db' and destination application = 'hr-portal' in last 30 days");
    expect(String(result.outputs.wavesCsv)).toBe(blueprintFiles['waves.csv']!);
    expect(String(result.outputs.appFlows).trim().split('\n').sort()).toEqual(['hr-portal -> hr-db : 4000', 'orders-app -> orders-db : 9000', 'orders-app -> payments : 300', 'orders-web -> orders-app : 12000', 'reporting -> orders-db : 40', 'wiki -> wiki-db : 800']);
    expect(String(result.outputs.crossWave)).toContain('orders-app -> payments (300)');
  });
});

describe('pkg ops-build: Networks assessment', { skip: !CURL }, () => {
  it('runs every measure as a count; a failed search is "?" and fails the run', async () => {
    const pkg = pkgOf(build('vcfnet91_assessment'));
    const routes: FakeRoute[] = [...netAuthRoutes, { method: 'POST', path: '^/api/ni/search/ql$', responses: [total(1000), total(700), total(200), { status: 500, body: { message: 'bad property' } }, total(50), total(30), total(400), total(90)] }];
    const { result, requests } = await run(pkg, routes, netSettings());
    readsOnly(requests);
    expect(requests.filter((r) => r.path === '/api/ni/search/ql').length).toBe(8);
    const rows = String(result.outputs.assessmentCsv).trim().split('\n');
    expect(rows[0]).toBe('measure,count,query');
    expect(rows[1]).toBe('All flows,1000,"flows in last 7 days"');
    expect(rows[4]).toBe('Routed through a physical router,?,"flows where Flow Type = \'Routed\' and Flow Type = \'Physical\' in last 7 days"');
    expect(rows[8]).toBe('VMs on VLAN-backed port groups,90,"vms where network type = \'VLAN\'"');
    expect(result.outputs.failedSearches).toBe(1);
    expect(result.error ?? '').toContain('1 search(es) failed');
  });
});

describe('pkg ops-build: Networks infrastructure problems', { skip: !CURL }, () => {
  it('pages the open problems in the window, fetches them, and reports those at the floor or above', async () => {
    const pkg = pkgOf(build('vcfnet91_health'));
    const routes: FakeRoute[] = [
      ...netAuthRoutes,
      {
        method: 'GET',
        path: '^/api/ni/entities/problems\\?',
        responses: [
          { body: { results: [{ entity_id: 'p1', entity_type: 'ProblemEvent', time: 10 }, { entity_id: 'p2', entity_type: 'ProblemEvent', time: 11 }], cursor: 'MTA=', total_count: 3 } },
          { body: { results: [{ entity_id: 'p3', entity_type: 'ProblemEvent', time: 12 }], cursor: 'MjA=', total_count: 3 } },
        ],
      },
      {
        method: 'POST',
        path: '^/api/ni/entities/problems/fetch$',
        body: {
          results: [
            { entity_id: 'p1', entity_type: 'ProblemEvent', entity: { severity: 'WARNING', name: 'Edge CPU high' } },
            { entity_id: 'p2', entity_type: 'ProblemEvent', entity: { severity: 'CRITICAL', name: 'NSX Manager down', anchor_entities: [{ entity_id: 'nsx-1' }] } },
            { entity_id: 'p3', entity_type: 'ProblemEvent', entity: { severity: 'Moderate', name: 'Host MTU mismatch', anchor_entities: [{ entity_id: 'h-1' }, { entity_id: 'h-2' }] } },
          ],
        },
      },
    ];
    const { result, requests } = await run(pkg, routes, netSettings());
    readsOnly(requests);
    const gets = requests.filter((r) => r.path.startsWith('/api/ni/entities/problems?')).map((r) => r.path);
    expect(gets.length).toBe(2);
    expect(/^\/api\/ni\/entities\/problems\?size=1000&event_status=open&start_time=\d+&end_time=\d+$/.test(gets[0]!)).toBe(true);
    expect(gets[1]!.endsWith('&cursor=MTA%3D')).toBe(true);
    const [start, end] = [...gets[0]!.matchAll(/_time=(\d+)/g)].map((m) => Number(m[1]));
    expect(end! - start!).toBe(24 * 3600);
    expect(JSON.parse(requests.find((r) => r.path === '/api/ni/entities/problems/fetch')!.body)).toEqual({ entity_ids: [{ entity_type: 'ProblemEvent', entity_id: 'p1', time: 10 }, { entity_type: 'ProblemEvent', entity_id: 'p2', time: 11 }, { entity_type: 'ProblemEvent', entity_id: 'p3', time: 12 }] });
    expect(String(result.outputs.problemsTsv)).toBe('CRITICAL\tNSX Manager down\tnsx-1\nMODERATE\tHost MTU mismatch\th-1 h-2\n');
    expect(result.outputs.problemCount).toBe(2);
    expect(result.error ?? '').toContain('2 open problem(s) at MODERATE or above');
  });

  it('a list without results is an error, not "no problems"', async () => {
    const pkg = pkgOf(build('vcfnet91_health'));
    const { result } = await run(pkg, [...netAuthRoutes, { method: 'GET', path: '^/api/ni/entities/problems\\?', body: { data: [] } }], netSettings());
    expect(result.error ?? '').toContain('returned no results list');
  });
});
