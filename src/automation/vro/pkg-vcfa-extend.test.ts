/**
 * The VCF Automation extensibility automations (blueprints/vcf-automation-extend.ts)
 * as Orchestrator packages: built, parsed, and run.
 *
 * For every variant the page can produce (each select option, each toggle
 * flipped) the package reads back with readPackageSpec, every script is ES5,
 * every secret is a SecureString with no value, and IMPORT.md names the package
 * and every import/ path. Then each automation's workflow runs in the emulator
 * against a fake VCF Automation (or DNS, IPAM, Supervisor) in another process:
 * a dry run writes nothing, an armed run makes exactly the expected calls in
 * order with the right bodies, what exists is left alone, the cap and the first
 * failure stop it, and no secret reaches a log line or an output.
 *
 * Plugin objects the emulator does not provide (the Active Directory and vCenter
 * plugins) are put into the scripts' context by the test, as small fakes.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { readPackageSpec, type VroPackageSpec } from '../../kit/vro-package.ts';
import { automationFor } from '../blueprints/index.ts';
import { VCF_AUTOMATION_EXTEND } from '../blueprints/vcf-automation-extend.ts';
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

/** The automation's own package (not the core library). */
function ownPackage(files: Record<string, string>): { dir: string; spec: VroPackageSpec; configKey: string } {
  const packages = packagesIn(files);
  const dir = Object.keys(packages).find((d) => d !== 'vcf.automation.core.package');
  if (!dir) throw new Error('no automation package');
  const spec = readPackageSpec(packages[dir]!);
  return { dir, spec, configKey: `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}` };
}

function scriptsOf(spec: VroPackageSpec): { where: string; script: string }[] {
  return [
    ...spec.actions.map((a) => ({ where: `${a.module}/${a.name}`, script: a.script })),
    ...spec.workflows.map((w) => ({
      where: w.name,
      script: [...w.xml.matchAll(/<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/g)].map((m) => [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join('')).join('\n'),
    })),
  ];
}

const logText = (run: WorkflowRun): string => run.logs.map((l) => l.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');

/** Everything that is not a read, a login or a documented validation. */
const writesOf = (requests: readonly FakeRequest[]): string[] =>
  requests
    .filter((r) => r.method !== 'GET' && !/^\/oauth\/|^\/wcp\/login$|\/blueprint-validation$|[?&]dryRun=All$|^\/hook$/.test(r.path))
    .map((r) => `${r.method} ${r.path.split('?')[0]}`);

const calls = (requests: readonly FakeRequest[]): string[] => requests.map((r) => `${r.method} ${r.path.split('?')[0]}`);

/** A plugin object the emulator does not provide, put into the scripts' global scope. */
function inject(emulator: VroEmulator, globals: Record<string, unknown>, modules: Record<string, Record<string, unknown>> = {}): void {
  Object.assign((emulator as unknown as { context: Record<string, unknown> }).context, globals);
  for (const [name, actions] of Object.entries(modules)) (emulator as unknown as { modules: Map<string, Record<string, unknown>> }).modules.set(name, actions);
}

const servers: FakeServer[] = [];
after(() => servers.forEach((s) => s.stop()));

async function run(files: Record<string, string>, routes: readonly FakeRoute[], settings: (host: string) => Record<string, unknown>, workflow: string, inputs: Record<string, unknown> = {}, prepare?: (emulator: VroEmulator) => void) {
  const server = await startFakeServer([...routes, { method: 'POST', path: '^/hook$', body: {} }]);
  servers.push(server);
  const host = `127.0.0.1:${server.port}`;
  const { configKey } = ownPackage(files);
  const emulator = new VroEmulator(files, { config: { [configKey]: settings(host) } });
  prepare?.(emulator);
  const result = emulator.runWorkflow(workflow, inputs);
  const requests = server.requests();
  return { result, requests, writes: writesOf(requests), host };
}

// ---------------------------------------------------------------------------
// Every variant: the package builds, parses, is ES5, keeps secrets empty and
// is named in IMPORT.md.

const IDS = VCF_AUTOMATION_EXTEND.map((b) => b.id);

function everyVariant(): { id: string; label: string; files: Record<string, string> }[] {
  const out: { id: string; label: string; files: Record<string, string> }[] = [];
  for (const blueprint of VCF_AUTOMATION_EXTEND) {
    const base = defaultValues(blueprint);
    const variants: { label: string; values: BlueprintValues }[] = [{ label: 'defaults', values: { ...base } }];
    for (const input of blueprint.inputs) {
      if (input.control === 'select') for (const option of input.options ?? []) variants.push({ label: `${input.id}=${option.value}`, values: { ...base, [input.id]: option.value } });
      if (input.control === 'toggle') variants.push({ label: `${input.id}=${String(!base[input.id])}`, values: { ...base, [input.id]: !base[input.id] } });
    }
    for (const v of variants) out.push({ id: blueprint.id, label: v.label, files: { ...blueprint.build(v.values, blueprint.id).files } });
  }
  return out;
}

describe('pkg vcfa-extend: every automation is an Orchestrator package', () => {
  const variants = everyVariant();

  it('covers every automation in the file', () => {
    expect(IDS.sort()).toEqual(['vcfa_custom_form', 'vcfa_custom_resource', 'vcfa_day2_policy', 'vcfa_orchestrator_action', 'vcfa_orchestrator_assets', 'vcfa_orchestrator_endpoint', 'vcfa_orchestrator_workflow', 'vcfa_resource_action', 'vcfa_secrets', 'vcfa_supervisor_namespace', 'vcfa_terraform_in_template', 'vcfa_vks_cluster']);
  });

  it('builds a package that parses, with the core library beside it, for every variant', () => {
    const problems: string[] = [];
    for (const v of variants) {
      const packages = packagesIn(v.files);
      if (!packages['vcf.automation.core.package']) problems.push(`${v.id} (${v.label}): no core library`);
      try {
        const { spec } = ownPackage(v.files);
        if (spec.workflows.length === 0 || spec.configs.length !== 1) problems.push(`${v.id} (${v.label}): ${spec.workflows.length} workflows, ${spec.configs.length} configs`);
        if (/[^a-z0-9_.]/.test(spec.name)) problems.push(`${v.id} (${v.label}): package name ${spec.name}`);
      } catch (e) {
        problems.push(`${v.id} (${v.label}): ${String(e)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('writes every script in every package as ES5', () => {
    const problems: string[] = [];
    for (const v of variants) {
      for (const [dir, pkg] of Object.entries(packagesIn(v.files))) {
        for (const s of scriptsOf(readPackageSpec(pkg))) problems.push(...es5Problems(s.script, `${v.id} (${v.label}) ${dir} ${s.where}`));
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps every secret a SecureString with no value', () => {
    const problems: string[] = [];
    for (const v of variants) {
      const { spec } = ownPackage(v.files);
      for (const a of spec.configs[0]!.attributes) {
        if (/password|token|secret/i.test(a.name) && a.type !== 'SecureString') problems.push(`${v.id} (${v.label}): ${a.name} is ${a.type}`);
        if (a.type === 'SecureString' && a.value !== undefined) problems.push(`${v.id} (${v.label}): ${a.name} has a value`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('acts by default: every changing package has a dryRun setting, off', () => {
    const problems: string[] = [];
    for (const v of variants) {
      const { spec } = ownPackage(v.files);
      const dry = spec.configs[0]!.attributes.find((a) => a.name === 'dryRun');
      if (v.id === 'vcfa_orchestrator_action') {
        if (dry) problems.push(`${v.id}: a read-only package has a dryRun`);
      } else if (dry?.value !== false) problems.push(`${v.id} (${v.label}): dryRun is ${String(dry?.value)}`);
    }
    expect(problems).toEqual([]);
  });

  it('names the package, the core library and every import/ path in IMPORT.md', () => {
    const problems: string[] = [];
    for (const v of variants) {
      const md = v.files['IMPORT.md'] ?? '';
      const top = new Set(Object.keys(v.files).filter((p) => p.startsWith('import/')).map((p) => /^(import\/[^/]+)/.exec(p)![1]!));
      for (const path of top) if (!md.includes(path)) problems.push(`${v.id} (${v.label}): ${path}`);
      const { dir } = ownPackage(v.files);
      if (md.indexOf(`import/${dir}`) < 0 || md.indexOf(`import/${dir}`) > md.indexOf('## 2.')) problems.push(`${v.id} (${v.label}): the package is not the first step`);
    }
    expect(problems).toEqual([]);
  });

  it('keeps the fallback scripts under scripts/, reading the payloads beside the README', () => {
    const problems: string[] = [];
    for (const v of variants) {
      for (const [path, body] of Object.entries(v.files)) {
        if (/^(apply|apply-kubectl)\.sh$/.test(path)) problems.push(`${v.id}: ${path} is still at the top`);
        if (path.startsWith('scripts/') && path.endsWith('.sh') && !body.includes('cd "$(dirname "$0")/.."')) problems.push(`${v.id}: ${path} reads relative to the caller's folder`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('parses every JSON file it writes', () => {
    const problems: string[] = [];
    for (const v of variants) {
      for (const [path, body] of Object.entries(v.files)) {
        if (!path.endsWith('.json')) continue;
        try {
          JSON.parse(body);
        } catch (e) {
          problems.push(`${v.id} (${v.label}) ${path}: ${String(e)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the native artifacts for importing by hand', () => {
    expect(Object.keys(build('vcfa_orchestrator_workflow')).some((p) => p.endsWith('/workflow-content.xml'))).toBe(true);
    expect(Object.keys(build('vcfa_orchestrator_action')).some((p) => p.startsWith('import/orchestrator/actions/'))).toBe(true);
    expect(Object.keys(build('vcfa_resource_action', { backed_by: 'abx' })).some((p) => /^import\/abx\/.+\/action\.json$/.test(p))).toBe(true);
    for (const id of ['vcfa_custom_resource', 'vcfa_supervisor_namespace', 'vcfa_vks_cluster', 'vcfa_terraform_in_template']) {
      expect(Object.keys(build(id)).some((p) => p.endsWith('/blueprint.yaml'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// VCF Automation, faked

const VCFA_TOKEN = 'vcfa-api-token-do-not-log';
const ACCESS = 'vcfa-access-do-not-log';
const vcfaLogin: FakeRoute = { method: 'POST', path: '^/oauth/tenant/team-a/token$', body: { access_token: ACCESS, token_type: 'Bearer' } };
const list = (content: unknown[]) => ({ content, totalElements: content.length });
const vcfaSettings = (host: string, extra: Record<string, unknown> = {}) => ({ vcfaHost: host, vcfaOrg: 'team-a', vcfaApiToken: VCFA_TOKEN, ...extra });
const PROJECTS: FakeRoute = { method: 'GET', path: '^/iaas/api/projects\\?', body: list([{ id: 'p-other', name: 'Other' }, { id: 'p-1', name: 'Team A' }]) };
const INTEGRATIONS: FakeRoute = {
  method: 'GET',
  path: '^/iaas/api/integrations\\?',
  body: list([
    { id: 'i-vro', name: 'embedded-vro', integrationType: 'vro' },
    { id: 'git-1', name: 'infrastructure-terraform', integrationType: 'github' },
  ]),
};

function bodyOf(requests: readonly FakeRequest[], method: string, path: string, index = 0): Record<string, unknown> {
  const found = requests.filter((r) => r.method === method && r.path.split('?')[0] === path)[index];
  if (!found) throw new Error(`no ${method} ${path}`);
  return JSON.parse(found.body) as Record<string, unknown>;
}

function assertNoSecret(result: WorkflowRun, ...secrets: string[]): void {
  const text = logText(result);
  for (const s of secrets) expect(text.includes(s)).toBe(false);
  expect(/do-not-log/.test(text)).toBe(false);
}

// ---------------------------------------------------------------------------
// vcfa_orchestrator_workflow

describe('pkg vcfa-extend: vcfa_orchestrator_workflow', { skip: !CURL }, () => {
  const DNS_PASSWORD = 'Dns-Pa55word-do-not-log';
  const files = build('vcfa_orchestrator_workflow', { task: 'dns-record', workflow_name: 'Register DNS record' });
  const { spec, dir } = ownPackage(files);
  const inputs = { hostname: 'app01', zone: 'example.com', ipAddress: '10.0.10.21' };
  const dnsRoutes = (records: unknown[] = [], postStatus = 201): FakeRoute[] => [
    { method: 'GET', path: '^/wapi/v2\\.12/record:a\\?name=app01\\.example\\.com$', body: records },
    { method: 'POST', path: '^/wapi/v2\\.12/record:a$', status: postStatus, body: postStatus < 300 ? 'record:a/ZG5z:app01.example.com/default' : { Error: `rejected ${DNS_PASSWORD}` } },
  ];
  const dns = (host: string, extra: Record<string, unknown> = {}) => ({ dnsBaseUrl: `https://${host}`, dnsUsername: 'svc-dns', dnsPassword: DNS_PASSWORD, allowedZones: 'lab.example.com, example.com', webhook: `https://${host}/hook`, ...extra });

  it('is a package: the workflow with the task inputs and dryRun, and settings with the password empty', () => {
    expect(dir).toBe('vcf.automation.vcfa.workflow.vcfa_orchestrator_workflow.package');
    expect(spec.workflows.map((w) => w.name)).toEqual(['Register DNS record']);
    expect(spec.workflows[0]!.xml.includes('<param name="dryRun" type="boolean"')).toBe(true);
    expect(spec.configs[0]!.attributes.find((a) => a.name === 'dnsPassword')?.type).toBe('SecureString');
    expect(files['IMPORT.md']!.includes(`import/${dir}`)).toBe(true);
  });

  it('dry run: looks the record up, plans the one create, writes nothing', async () => {
    const { result, requests, writes } = await run(files, dnsRoutes(), dns, 'Register DNS record', { ...inputs, dryRun: true });
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(calls(requests)).toEqual(['GET /wapi/v2.12/record:a', 'POST /hook']);
    expect(result.logs.some((l) => l.message === 'DRY RUN: would register A app01.example.com -> 10.0.10.21')).toBe(true);
    expect(result.outputs.fqdn).toBe('app01.example.com');
    assertNoSecret(result, DNS_PASSWORD);
  });

  it('armed: creates the A record with Basic authorization, once', async () => {
    const { result, requests, writes } = await run(files, dnsRoutes(), (h) => dns(h, { dryRun: false }), 'Register DNS record', { ...inputs, dryRun: false });
    expect(result.error).toBe(null);
    expect(writes).toEqual(['POST /wapi/v2.12/record:a']);
    expect(bodyOf(requests, 'POST', '/wapi/v2.12/record:a')).toEqual({ name: 'app01.example.com', ipv4addr: '10.0.10.21' });
    expect(requests[0]!.headers.authorization).toBe(`Basic ${btoa(`svc-dns:${DNS_PASSWORD}`)}`);
    expect((JSON.parse(String(result.outputs.summary)) as { changes: unknown[] }).changes.length).toBe(1);
    assertNoSecret(result, DNS_PASSWORD);
  });

  it('leaves a record with the same address alone, and refuses a second address', async () => {
    const same = await run(files, dnsRoutes([{ name: 'app01.example.com', ipv4addr: '10.0.10.21' }]), (h) => dns(h, { dryRun: false }), 'Register DNS record', { ...inputs, dryRun: false });
    expect(same.result.error).toBe(null);
    expect(same.writes).toEqual([]);
    const other = await run(files, dnsRoutes([{ name: 'app01.example.com', ipv4addr: '10.0.10.99' }]), (h) => dns(h, { dryRun: false }), 'Register DNS record', { ...inputs, dryRun: false });
    expect(other.result.error ?? '').toContain('already resolves to another address');
    expect(other.writes).toEqual([]);
  });

  it('refuses a zone outside the allow-list before any call', async () => {
    const { result, requests } = await run(files, dnsRoutes(), (h) => dns(h, { dryRun: false, allowedZones: 'lab.example.com' }), 'Register DNS record', { ...inputs, dryRun: false });
    expect(result.error ?? '').toContain('is not in allowedZones');
    expect(requests.length).toBe(0);
  });

  it('stops at the cap, and at the first failure with the password scrubbed', async () => {
    const capped = await run(files, dnsRoutes(), (h) => dns(h, { dryRun: false, cap: 0 }), 'Register DNS record', { ...inputs, dryRun: false });
    expect(capped.result.error ?? '').toContain('Cap reached: 0 change(s) made, the cap is 0; stopping before: register A app01.example.com');
    expect(capped.writes).toEqual([]);
    const failed = await run(files, dnsRoutes([], 500), (h) => dns(h, { dryRun: false }), 'Register DNS record', { ...inputs, dryRun: false });
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): register A app01.example.com -> 10.0.10.21 failed');
    expect(failed.result.error ?? '').toContain('returned HTTP 500');
    assertNoSecret(failed.result, DNS_PASSWORD);
  });

  it('backup job task: adds the VM once, leaves it when included, refuses a job outside the allow-list', async () => {
    const bFiles = build('vcfa_orchestrator_workflow', { task: 'backup-job', workflow_name: 'Add VM to backup job' });
    const JOBS = '/api/v1/jobs/Tier2-Nightly/includes';
    const routes = (members: unknown[]): FakeRoute[] => [
      { method: 'GET', path: `^${JOBS}$`, body: { data: members } },
      { method: 'POST', path: `^${JOBS}$`, status: 201, body: {} },
    ];
    const settings = (extra: Record<string, unknown>) => (host: string) => ({ backupBaseUrl: `https://${host}`, backupUsername: 'svc-backup', backupPassword: 'Bk-Pa55word-do-not-log', allowedJobs: 'Tier2-Nightly, Tier3-Weekly', ...extra });
    const job = { vmName: 'app01', jobName: 'Tier2-Nightly', dryRun: false };
    const added = await run(bFiles, routes([{ name: 'db01' }]), settings({ dryRun: false }), 'Add VM to backup job', job);
    expect(added.result.error).toBe(null);
    expect(added.writes).toEqual([`POST ${JOBS}`]);
    expect(bodyOf(added.requests, 'POST', JOBS)).toEqual({ name: 'app01', type: 'VirtualMachine' });
    expect(added.result.outputs.jobId).toBe('Tier2-Nightly');
    const included = await run(bFiles, routes([{ name: 'app01' }]), settings({ dryRun: false }), 'Add VM to backup job', job);
    expect(included.writes).toEqual([]);
    const outside = await run(bFiles, routes([]), settings({ dryRun: false }), 'Add VM to backup job', { ...job, jobName: 'Tier1-Hourly' });
    expect(outside.result.error ?? '').toContain('is not in allowedJobs');
    expect(outside.requests.length).toBe(0);
    assertNoSecret(added.result);
  });

  describe('with the Active Directory task', () => {
    const adFiles = build('vcfa_orchestrator_workflow', { task: 'ad-computer' });
    const adName = ownPackage(adFiles).spec.workflows[0]!.name;
    const fakeAd = (existing: string[]) => {
      const created: string[] = [];
      const ou = { distinguishedName: 'OU=Web,OU=Servers,DC=example,DC=com', createComputerAD: (name: string) => created.push(name) };
      return { created, ActiveDirectory: { searchExactMatch: (type: string, name: string) => (type === 'ComputerAD' ? existing.filter((e) => e === name).map((e) => ({ distinguishedName: `CN=${e},${ou.distinguishedName}` })) : name === 'Web' ? [ou] : []) } };
    };
    const adInputs = { computerName: 'APP01', ouDn: 'OU=Web,OU=Servers,DC=example,DC=com' };
    const adSettings = (extra: Record<string, unknown>) => () => ({ allowedOuSuffix: 'OU=Servers,DC=example,DC=com', ...extra });

    it('dry run searches and creates nothing; armed creates the computer once; an existing one is left alone', async () => {
      const dry = fakeAd([]);
      const d = await run(adFiles, [], adSettings({}), adName, { ...adInputs, dryRun: true }, (e) => inject(e, { ActiveDirectory: dry.ActiveDirectory }));
      expect(d.result.error).toBe(null);
      expect(dry.created).toEqual([]);
      expect(d.result.outputs.computerDn).toBe('');
      const live = fakeAd([]);
      const a = await run(adFiles, [], adSettings({ dryRun: false }), adName, { ...adInputs, dryRun: false }, (e) => inject(e, { ActiveDirectory: live.ActiveDirectory }));
      expect(a.result.error).toBe(null);
      expect(live.created).toEqual(['APP01']);
      expect(a.result.outputs.computerDn).toBe('CN=APP01,OU=Web,OU=Servers,DC=example,DC=com');
      const there = fakeAd(['APP01']);
      const x = await run(adFiles, [], adSettings({ dryRun: false }), adName, { ...adInputs, dryRun: false }, (e) => inject(e, { ActiveDirectory: there.ActiveDirectory }));
      expect(x.result.error).toBe(null);
      expect(there.created).toEqual([]);
    });

    it('refuses an OU outside the suffix', async () => {
      const ad = fakeAd([]);
      const { result } = await run(adFiles, [], adSettings({ dryRun: false }), adName, { computerName: 'APP01', ouDn: 'OU=Domain Controllers,DC=example,DC=com', dryRun: false }, (e) => inject(e, { ActiveDirectory: ad.ActiveDirectory }));
      expect(result.error ?? '').toContain('is outside OU=Servers,DC=example,DC=com; refusing');
      expect(ad.created).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// vcfa_orchestrator_action

describe('pkg vcfa-extend: vcfa_orchestrator_action', { skip: !CURL }, () => {
  const IPAM_PASSWORD = 'Ipam-Pa55word-do-not-log';
  const files = build('vcfa_orchestrator_action', { source: 'ipam-vlans', action_name: 'listIpamVlans', limit: 2 });
  const { spec, dir } = ownPackage(files);
  const vlans: FakeRoute = { method: 'GET', path: '^/api/vlans\\?site=dc1$', body: [{ id: 10, name: 'web' }, { id: 20, name: 'db' }, { id: 30, name: 'mgmt' }] };
  const ipam = (host: string) => ({ ipamBaseUrl: `https://${host}`, ipamUsername: 'reader', ipamPassword: IPAM_PASSWORD });

  it('is the package of the module the form calls: the action, and a workflow to try it', () => {
    expect(dir).toBe('com.company.infra.package');
    expect(spec.actions.map((a) => `${a.module}/${a.name}`)).toEqual(['com.company.infra/listIpamVlans']);
    expect(spec.workflows.map((w) => w.name)).toEqual(['Try listIpamVlans']);
    expect(files['vcfa-orchestrator-action-form-field.json']!.includes('"id": "com.company.infra/listIpamVlans"')).toBe(true);
  });

  it('reads only, with Basic authorization, and returns at most the limit', async () => {
    const { result, requests } = await run(files, [vlans], ipam, 'Try listIpamVlans', { site: 'dc1' });
    expect(result.error).toBe(null);
    expect(calls(requests)).toEqual(['GET /api/vlans']);
    expect(requests[0]!.headers.authorization).toBe(`Basic ${btoa(`reader:${IPAM_PASSWORD}`)}`);
    expect(result.outputs.result).toEqual(['10 - web', '20 - db']);
    assertNoSecret(result, IPAM_PASSWORD);
  });

  it('never throws: a failing source is an empty list and an error line, with the password scrubbed', async () => {
    const broken: FakeRoute = { method: 'GET', path: '^/api/vlans', status: 500, body: { message: `bad login ${IPAM_PASSWORD}` } };
    const { result } = await run(files, [broken], ipam, 'Try listIpamVlans', { site: 'dc1' });
    expect(result.error).toBe(null);
    expect(result.outputs.result).toEqual([]);
    expect(result.logs.some((l) => l.level === 'error' && l.message.includes('com.company.infra/listIpamVlans failed') && l.message.includes('HTTP 500'))).toBe(true);
    assertNoSecret(result, IPAM_PASSWORD);
  });

  it('puts an action whose module is not a package name in vcf.automation.vcfa.action.*, and the form follows it', async () => {
    const odd = build('vcfa_orchestrator_action', { module: 'Company-Infra', source: 'custom' });
    const own = ownPackage(odd);
    expect(own.spec.name).toBe('vcf.automation.vcfa.action.company_infra');
    expect(odd['vcfa-orchestrator-action-form-field.json']!.includes('"id": "vcf.automation.vcfa.action.company_infra/listOptions"')).toBe(true);
    const { result, requests } = await run(odd, [], () => ({}), 'Try listOptions', { filter: '' });
    expect(result.outputs.result).toEqual(['option-a', 'option-b']);
    expect(requests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// vcfa_resource_action

describe('pkg vcfa-extend: vcfa_resource_action', { skip: !CURL }, () => {
  const files = build('vcfa_resource_action');
  const { spec, dir } = ownPackage(files);
  const backingId = spec.workflows.find((w) => w.name === 'Extend disk')!.id;
  const routes = (o: { actions?: unknown[]; policies?: unknown[]; actionStatus?: number } = {}): FakeRoute[] => [
    vcfaLogin,
    PROJECTS,
    INTEGRATIONS,
    { method: 'GET', path: '^/form-service/api/custom/resource-actions\\?', body: list(o.actions ?? []) },
    { method: 'POST', path: '^/form-service/api/custom/resource-actions$', status: o.actionStatus ?? 200, body: o.actionStatus ? { message: 'no' } : { id: 'ra-1' } },
    { method: 'GET', path: '^/policy/api/policies\\?', body: list(o.policies ?? []) },
    { method: 'POST', path: '^/policy/api/policies$', body: { id: 'pol-1' } },
    { method: 'GET', path: '^/abx/api/resources/actions\\?', body: list([]) },
    { method: 'POST', path: '^/abx/api/resources/actions$', body: { id: 'abx-1' } },
  ];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => vcfaSettings(host, { projectName: 'Team A', approvers: ['GROUP:platform-leads@example.com'], ...extra });

  it('holds the register workflow and the backing workflow, whose id the resource action names', () => {
    expect(dir).toBe('vcf.automation.vcfa.day2.vcfa_resource_action.package');
    expect(spec.workflows.map((w) => w.name).sort()).toEqual(['Extend disk', 'Register Extend disk']);
    expect(JSON.parse(files['import/orchestrator/workflows/extend-disk/workflow.json']!).id).toBe(backingId);
    expect(files['IMPORT.md']!.includes(backingId)).toBe(true);
  });

  it('dry run: reads the project, the integration and what exists, creates nothing', async () => {
    const { result, writes } = await run(files, routes(), settings(), 'Register Extend disk', { dryRun: true });
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would create')).length).toBe(2);
    assertNoSecret(result, VCFA_TOKEN, ACCESS);
  });

  it('armed: logs in with the org token, then creates the resource action and the approval policy, in order', async () => {
    const { result, requests, writes } = await run(files, routes(), settings({ dryRun: false }), 'Register Extend disk', { dryRun: false });
    expect(result.error).toBe(null);
    expect(calls(requests)).toEqual([
      'POST /oauth/tenant/team-a/token',
      'GET /iaas/api/projects',
      'GET /iaas/api/integrations',
      'GET /form-service/api/custom/resource-actions',
      'POST /form-service/api/custom/resource-actions',
      'GET /policy/api/policies',
      'POST /policy/api/policies',
    ]);
    expect(requests[0]!.body).toBe(`grant_type=refresh_token&refresh_token=${VCFA_TOKEN}`);
    expect(requests.slice(1).every((r) => r.headers.authorization === `Bearer ${ACCESS}`)).toBe(true);
    const action = bodyOf(requests, 'POST', '/form-service/api/custom/resource-actions') as { runnableItem: { id: string; endpointLink: string }; status: string; resourceType: string };
    expect(action.runnableItem.id).toBe(backingId);
    expect(action.runnableItem.endpointLink).toBe('/resources/endpoints/i-vro');
    expect(action.status).toBe('RELEASED');
    expect('_binding' in action).toBe(false);
    const policy = bodyOf(requests, 'POST', '/policy/api/policies') as { projectId: string; definition: { approvers: string[]; actions: string[] } };
    expect(policy.projectId).toBe('p-1');
    expect(policy.definition.approvers).toEqual(['GROUP:platform-leads@example.com']);
    expect(policy.definition.actions).toEqual(['Cloud.vSphere.Machine.custom.Extenddisk']);
    expect(writes.length).toBe(2);
    expect(result.outputs.resourceActionId).toBe('ra-1');
    assertNoSecret(result, VCFA_TOKEN, ACCESS);
  });

  it('leaves an existing resource action and policy alone', async () => {
    const { result, writes } = await run(
      files,
      routes({ actions: [{ id: 'ra-old', name: 'Extenddisk', resourceType: 'Cloud.vSphere.Machine' }], policies: [{ id: 'pol-old', name: 'Extend disk — approval', typeId: 'com.vmware.policy.approval' }] }),
      settings({ dryRun: false }),
      'Register Extend disk',
      { dryRun: false },
    );
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(result.outputs.resourceActionId).toBe('ra-old');
  });

  it('refuses without approvers, before any write; stops at the cap and at the first failure', async () => {
    const none = await run(files, routes(), settings({ dryRun: false, approvers: [] }), 'Register Extend disk', { dryRun: false });
    expect(none.result.error ?? '').toContain('Set approvers');
    expect(none.writes).toEqual([]);
    const capped = await run(files, routes(), settings({ dryRun: false, cap: 1 }), 'Register Extend disk', { dryRun: false });
    expect(capped.writes).toEqual(['POST /form-service/api/custom/resource-actions']);
    expect(capped.result.error ?? '').toContain('stopping before: create approval policy');
    const failed = await run(files, routes({ actionStatus: 400 }), settings({ dryRun: false }), 'Register Extend disk', { dryRun: false });
    expect(failed.writes).toEqual(['POST /form-service/api/custom/resource-actions']);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): create resource action Extenddisk');
    assertNoSecret(failed.result, VCFA_TOKEN, ACCESS);
  });

  it('ABX-backed: creates the ABX action in the project first, and points the resource action at it', async () => {
    const abxFiles = build('vcfa_resource_action', { backed_by: 'abx' });
    const { result, requests, writes } = await run(abxFiles, routes(), settings({ dryRun: false }), 'Register Extend disk', { dryRun: false });
    expect(result.error).toBe(null);
    expect(writes).toEqual(['POST /abx/api/resources/actions', 'POST /form-service/api/custom/resource-actions', 'POST /policy/api/policies']);
    const abx = bodyOf(requests, 'POST', '/abx/api/resources/actions') as { name: string; projectId: string; source: string; runtime: string; entrypoint: string };
    expect([abx.name, abx.projectId, abx.runtime, abx.entrypoint]).toEqual(['Extend disk', 'p-1', 'python', 'handler']);
    expect(abx.source.includes('def handler(context, inputs):')).toBe(true);
    const action = bodyOf(requests, 'POST', '/form-service/api/custom/resource-actions') as { runnableItem: { id: string; projectId: string } };
    expect(action.runnableItem).toEqual({ id: 'abx-1', name: 'Extend disk', type: 'abx.action', projectId: 'p-1' });
  });

  describe('the backing workflow', () => {
    class VcVirtualDisk {
      capacityInKB: number;
      constructor(gb: number) {
        this.capacityInKB = gb * 1024 * 1024;
      }
    }
    const fakes = () => {
      const reconfigured: unknown[] = [];
      const disk = new VcVirtualDisk(40);
      const vm = { name: 'app01', config: { hardware: { device: [{ label: 'nic' }, disk] } }, reconfigVM_Task: (spec: unknown) => (reconfigured.push(spec), 'task-1') };
      const globals = { VcVirtualDisk, VcVirtualDeviceConfigSpec: function () {}, VcVirtualMachineConfigSpec: function () {}, VcVirtualDeviceConfigSpecOperation: { edit: 'edit' } };
      return { reconfigured, disk, vm, globals, waited: [] as unknown[] };
    };
    // vm is a plugin object: the emulator's inputs are JSON, so the fake VM is a
    // property of the scripts' scope that the input binding cannot overwrite.
    const prepare = (f: ReturnType<typeof fakes>) => (e: VroEmulator) => {
      inject(e, f.globals, { 'com.vmware.library.vc.basic': { vim3WaitTaskEnd: (task: unknown) => f.waited.push(task) } });
      Object.defineProperty((e as unknown as { context: object }).context, 'vm', { get: () => f.vm, set: () => undefined, configurable: true });
    };
    const runIt = (f: ReturnType<typeof fakes>, size: number, settings: Record<string, unknown>) => run(files, [], () => settings, 'Extend disk', { diskIndex: 0, newSizeGb: size, dryRun: false }, prepare(f));

    it('a dry run set in the configuration changes nothing, even when VCF Automation passes dryRun = false', async () => {
      const f = fakes();
      const { result } = await runIt(f, 60, { dryRun: true });
      expect(result.error).toBe(null);
      expect(f.reconfigured.length).toBe(0);
      expect(result.logs.some((l) => l.message === 'DRY RUN: would extend disk 0 of app01 to 60 GB')).toBe(true);
    });

    it('armed: reconfigures to the new size once; refuses above the cap and a shrink; leaves the same size alone', async () => {
      const f = fakes();
      const armed = await runIt(f, 60, { dryRun: false });
      expect(armed.result.error).toBe(null);
      expect(f.reconfigured.length).toBe(1);
      expect(f.disk.capacityInKB).toBe(60 * 1024 * 1024);
      expect(f.waited).toEqual(['task-1']);
      expect((await runIt(f, 600, { dryRun: false })).result.error ?? '').toContain('over the cap of 500 GB');
      expect((await runIt(f, 20, { dryRun: false })).result.error ?? '').toContain('a disk cannot be shrunk');
      const same = await runIt(f, 60, { dryRun: false });
      expect(same.result.error).toBe(null);
      expect(f.reconfigured.length).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// vcfa_day2_policy

describe('pkg vcfa-extend: vcfa_day2_policy', { skip: !CURL }, () => {
  const files = build('vcfa_day2_policy', { project: 'Team A' });
  const { dir, spec } = ownPackage(files);
  const workflow = spec.workflows[0]!.name;
  const routes = (existing: unknown[] = []): FakeRoute[] => [vcfaLogin, PROJECTS, { method: 'GET', path: '^/policy/api/policies\\?', body: list(existing) }, { method: 'POST', path: '^/policy/api/policies$', responses: [{ body: { id: 'pol-1' } }, { body: { id: 'pol-2' } }] }];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => vcfaSettings(host, { approvers: ['GROUP:platform-leads@example.com'], ...extra });

  it('is a package whose settings carry the project from the page', () => {
    expect(dir).toBe('vcf.automation.vcfa.policy.vcfa_day2_policy.package');
    expect(spec.configs[0]!.attributes.find((a) => a.name === 'projectName')?.value).toBe('Team A');
    expect(JSON.parse(files['vcfa-day2-policy.json']!).projectId).toContain('<REQUIRED');
  });

  it('dry run writes nothing; armed creates the day-2 policy then the approval policy, both scoped by projectId', async () => {
    const dry = await run(files, routes(), settings(), workflow, { dryRun: true });
    expect(dry.result.error).toBe(null);
    expect(dry.writes).toEqual([]);
    const { result, requests, writes } = await run(files, routes(), settings({ dryRun: false }), workflow, { dryRun: false });
    expect(result.error).toBe(null);
    expect(calls(requests)).toEqual(['POST /oauth/tenant/team-a/token', 'GET /iaas/api/projects', 'GET /policy/api/policies', 'POST /policy/api/policies', 'POST /policy/api/policies']);
    expect(writes.length).toBe(2);
    const day2 = bodyOf(requests, 'POST', '/policy/api/policies', 0) as { typeId: string; projectId: string; definition: { allowedActions: { authorities: string[]; actions: string[] }[] } };
    expect(day2.typeId).toBe('com.vmware.policy.deployment.action');
    expect(day2.projectId).toBe('p-1');
    expect(day2.definition.allowedActions[0]!.authorities).toEqual(['ROLE:member']);
    expect(day2.definition.allowedActions[0]!.actions.includes('Deployment.Delete')).toBe(true);
    const approval = bodyOf(requests, 'POST', '/policy/api/policies', 1) as { typeId: string; projectId: string; definition: { approvers: string[]; actions: string[] } };
    expect([approval.typeId, approval.projectId]).toEqual(['com.vmware.policy.approval', 'p-1']);
    expect(approval.definition.approvers).toEqual(['GROUP:platform-leads@example.com']);
    expect(approval.definition.actions).toEqual(['Deployment.Delete', 'Cloud.vSphere.Machine.Resize']);
    expect((JSON.parse(String(result.outputs.summary)) as { summary: { policyIds: string[] } }).summary.policyIds).toEqual(['pol-1', 'pol-2']);
    assertNoSecret(result, VCFA_TOKEN, ACCESS);
  });

  it('leaves a policy of the same name and type alone, and stops at the cap', async () => {
    const policyName = JSON.parse(files['vcfa-day2-policy.json']!).name as string;
    const some = await run(files, routes([{ id: 'pol-old', name: policyName, typeId: 'com.vmware.policy.deployment.action' }]), settings({ dryRun: false }), workflow, { dryRun: false });
    expect(some.result.error).toBe(null);
    expect(some.writes).toEqual(['POST /policy/api/policies']);
    expect((bodyOf(some.requests, 'POST', '/policy/api/policies') as { typeId: string }).typeId).toBe('com.vmware.policy.approval');
    const capped = await run(files, routes(), settings({ dryRun: false, cap: 1 }), workflow, { dryRun: false });
    expect(capped.writes.length).toBe(1);
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made');
  });

  it('refuses an unknown project before any write', async () => {
    const { result, writes } = await run(files, routes(), settings({ dryRun: false, projectName: 'Nobody' }), workflow, { dryRun: false });
    expect(result.error ?? '').toContain("No project named 'Nobody'");
    expect(writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// vcfa_custom_resource

describe('pkg vcfa-extend: vcfa_custom_resource', { skip: !CURL }, () => {
  const files = build('vcfa_custom_resource');
  const { dir, spec } = ownPackage(files);
  const nativeCreate = JSON.parse(files['import/orchestrator/workflows/create-ad-user/workflow.json']!).id as string;
  const routes = (o: { types?: unknown[]; valid?: boolean; blueprints?: unknown[]; content?: string } = {}): FakeRoute[] => [
    vcfaLogin,
    PROJECTS,
    INTEGRATIONS,
    { method: 'GET', path: '^/form-service/api/custom/resource-types\\?', body: list(o.types ?? []) },
    { method: 'POST', path: '^/form-service/api/custom/resource-types$', body: { id: 'rt-1' } },
    { method: 'POST', path: '^/blueprint/api/blueprint-validation$', body: { valid: o.valid ?? true, validationMessages: o.valid === false ? [{ type: 'ERROR', message: 'unknown type' }] : [] } },
    { method: 'GET', path: '^/blueprint/api/blueprints/bp-1/versions\\?', body: list([]) },
    { method: 'GET', path: '^/blueprint/api/blueprints/bp-1$', body: { id: 'bp-1', content: o.content ?? '' } },
    { method: 'GET', path: '^/blueprint/api/blueprints\\?', body: list(o.blueprints ?? []) },
    { method: 'POST', path: '^/blueprint/api/blueprints$', body: { id: 'bp-1' } },
    { method: 'PUT', path: '^/blueprint/api/blueprints/bp-1$', body: { id: 'bp-1' } },
    { method: 'POST', path: '^/blueprint/api/blueprints/bp-1/versions$', body: { id: 'bp-1', version: '1.0.0' } },
  ];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => vcfaSettings(host, { projectName: 'Team A', ...extra });

  it('holds the register workflow and the lifecycle workflows, with the ids mainActions names', () => {
    expect(dir).toBe('vcf.automation.vcfa.custom.aduser.package');
    expect(spec.workflows.map((w) => w.name).sort()).toEqual(['Create AD user', 'Delete AD user', 'Register Custom.ADUser', 'Update AD user']);
    expect(spec.workflows.find((w) => w.name === 'Create AD user')!.id).toBe(nativeCreate);
  });

  it('dry run writes nothing, and does not validate a template against a type that does not exist yet', async () => {
    const { result, writes, requests } = await run(files, routes(), settings(), 'Register Custom.ADUser', { dryRun: true });
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(requests.some((r) => r.path.endsWith('/blueprint-validation'))).toBe(false);
    expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would create')).length).toBe(3);
  });

  it('armed: the type, then the template validated, created and versioned', async () => {
    const { result, requests, writes } = await run(files, routes(), settings({ dryRun: false }), 'Register Custom.ADUser', { dryRun: false });
    expect(result.error).toBe(null);
    expect(calls(requests)).toEqual([
      'POST /oauth/tenant/team-a/token',
      'GET /iaas/api/projects',
      'GET /iaas/api/integrations',
      'GET /form-service/api/custom/resource-types',
      'POST /form-service/api/custom/resource-types',
      'POST /blueprint/api/blueprint-validation',
      'GET /blueprint/api/blueprints',
      'POST /blueprint/api/blueprints',
      'GET /blueprint/api/blueprints/bp-1/versions',
      'POST /blueprint/api/blueprints/bp-1/versions',
    ]);
    expect(writes.length).toBe(3);
    const type = bodyOf(requests, 'POST', '/form-service/api/custom/resource-types') as { resourceType: string; mainActions: Record<string, { id: string; endpointLink: string }> };
    expect(type.resourceType).toBe('Custom.ADUser');
    expect(type.mainActions.create!.id).toBe(nativeCreate);
    expect(Object.values(type.mainActions).every((a) => a.endpointLink === '/resources/endpoints/i-vro')).toBe(true);
    const template = bodyOf(requests, 'POST', '/blueprint/api/blueprints') as { name: string; projectId: string; content: string; requestScopeOrg: boolean };
    expect([template.name, template.projectId, template.requestScopeOrg]).toEqual(['AD user request', 'p-1', false]);
    expect(template.content.includes('type: Custom.ADUser')).toBe(true);
    expect(bodyOf(requests, 'POST', '/blueprint/api/blueprints/bp-1/versions')).toEqual({ version: '1.0.0', description: 'Requests one Custom.ADUser.', changeLog: 'Imported by the vcf.automation package', release: false });
    assertNoSecret(result, VCFA_TOKEN, ACCESS);
  });

  it('stops on an invalid template, after the type and before any template write', async () => {
    const { result, writes } = await run(files, routes({ valid: false }), settings({ dryRun: false }), 'Register Custom.ADUser', { dryRun: false });
    expect(result.error ?? '').toContain('is not valid');
    expect(writes).toEqual(['POST /form-service/api/custom/resource-types']);
    expect(result.logs.some((l) => l.message.includes('ERROR: unknown type'))).toBe(true);
  });

  it('leaves the type and a template with the same content alone; updates the draft of one that differs', async () => {
    const yaml = files['vcfa-custom-resource-template.yaml']!;
    const existing = { types: [{ id: 'rt-old', resourceType: 'Custom.ADUser' }], blueprints: [{ id: 'bp-1', name: 'AD user request', projectId: 'p-1' }] };
    const same = await run(files, routes({ ...existing, content: yaml }), settings({ dryRun: false }), 'Register Custom.ADUser', { dryRun: false });
    expect(same.result.error).toBe(null);
    expect(same.writes).toEqual(['POST /blueprint/api/blueprints/bp-1/versions']);
    expect(same.result.outputs.resourceTypeId).toBe('rt-old');
    const differs = await run(files, routes({ ...existing, content: 'formatVersion: 1\nresources: {}\n' }), settings({ dryRun: false }), 'Register Custom.ADUser', { dryRun: false });
    expect(differs.writes).toEqual(['PUT /blueprint/api/blueprints/bp-1', 'POST /blueprint/api/blueprints/bp-1/versions']);
  });

  it('the delete workflow succeeds when the object is already gone, and refuses to pretend otherwise', async () => {
    const gone = await run(files, [], () => ({ dryRun: false }), 'Delete AD user', { existing: null, dryRun: false });
    expect(gone.result.error).toBe(null);
    expect(gone.result.logs.some((l) => l.message === 'Already gone: nothing to delete.')).toBe(true);
    const there = await run(files, [], () => ({ dryRun: false }), 'Delete AD user', { existing: { name: 'svc-app01' }, dryRun: false });
    expect(there.result.error ?? '').toContain('Delete AD user is not written yet');
  });

  it('ABX-backed: creates each lifecycle ABX action and names their ids in the type', async () => {
    const abxFiles = build('vcfa_custom_resource', { backed_by: 'abx' });
    const abxRoutes: FakeRoute[] = [...routes(), { method: 'GET', path: '^/abx/api/resources/actions\\?', body: list([{ id: 'abx-old', name: 'Update AD user', projectId: 'p-1' }]) }, { method: 'POST', path: '^/abx/api/resources/actions$', responses: [{ body: { id: 'abx-c' } }, { body: { id: 'abx-d' } }] }];
    const { result, requests, writes } = await run(abxFiles, abxRoutes, settings({ dryRun: false }), 'Register Custom.ADUser', { dryRun: false });
    expect(result.error).toBe(null);
    expect(writes.slice(0, 3)).toEqual(['POST /abx/api/resources/actions', 'POST /abx/api/resources/actions', 'POST /form-service/api/custom/resource-types']);
    const type = bodyOf(requests, 'POST', '/form-service/api/custom/resource-types') as { mainActions: Record<string, { id: string; projectId: string }> };
    expect([type.mainActions.create!.id, type.mainActions.update!.id, type.mainActions.delete!.id]).toEqual(['abx-c', 'abx-old', 'abx-d']);
    expect(type.mainActions.create!.projectId).toBe('p-1');
  });
});

// ---------------------------------------------------------------------------
// vcfa_supervisor_namespace

describe('pkg vcfa-extend: vcfa_supervisor_namespace', { skip: !CURL }, () => {
  const files = build('vcfa_supervisor_namespace');
  const { spec } = ownPackage(files);
  const workflow = spec.workflows[0]!.name;
  const CCI = '/cci/kubernetes/apis/infrastructure.cci.vmware.com/v1alpha3/namespaces/team-a-project/supervisornamespaces';
  const routes = (items: unknown[] = []): FakeRoute[] => [
    vcfaLogin,
    { method: 'GET', path: `^${CCI}$`, body: { apiVersion: 'v1', kind: 'List', items } },
    { method: 'POST', path: `^${CCI}$`, status: 201, body: { metadata: { name: 'team-a-dev-x7k2p' } } },
  ];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => vcfaSettings(host, { projectName: 'team-a-project', ...extra });

  it('says v1alpha3 everywhere it names the CCI API', () => {
    expect(files['vcfa-supervisor-namespace-namespace.k8s.yaml']!.includes('apiVersion: infrastructure.cci.vmware.com/v1alpha3')).toBe(true);
    expect(JSON.parse(spec.resources.find((r) => r.name === 'namespace.json')!.content).apiVersion).toBe('infrastructure.cci.vmware.com/v1alpha3');
  });

  it('dry run lists and requests nothing; armed requests the namespace once, labelled, in the project', async () => {
    const dry = await run(files, routes(), settings(), workflow, { dryRun: true });
    expect(dry.result.error).toBe(null);
    expect(dry.writes).toEqual([]);
    const { result, requests, writes } = await run(files, routes(), settings({ dryRun: false }), workflow, { dryRun: false });
    expect(result.error).toBe(null);
    expect(calls(requests)).toEqual(['POST /oauth/tenant/team-a/token', `GET ${CCI}`, `POST ${CCI}`]);
    expect(writes.length).toBe(1);
    expect(bodyOf(requests, 'POST', CCI)).toEqual({
      apiVersion: 'infrastructure.cci.vmware.com/v1alpha3',
      kind: 'SupervisorNamespace',
      metadata: { generateName: 'team-a-dev-', namespace: 'team-a-project', labels: { 'vcf.automation/request': 'team-a-dev' } },
      spec: { className: 'small', regionName: 'region1' },
    });
    expect(requests[2]!.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(result.outputs.namespaceName).toBe('team-a-dev-x7k2p');
    assertNoSecret(result, VCFA_TOKEN, ACCESS);
  });

  it('leaves the namespace it requested before alone, and refuses to guess between two', async () => {
    const mine = { metadata: { name: 'team-a-dev-abcde', labels: { 'vcf.automation/request': 'team-a-dev' } } };
    const once = await run(files, routes([{ metadata: { name: 'other' } }, mine]), settings({ dryRun: false }), workflow, { dryRun: false });
    expect(once.result.error).toBe(null);
    expect(once.writes).toEqual([]);
    expect(once.result.outputs.namespaceName).toBe('team-a-dev-abcde');
    const twice = await run(files, routes([mine, { metadata: { name: 'team-a-dev-fghij', labels: { 'vcf.automation/request': 'team-a-dev' } } }]), settings({ dryRun: false }), workflow, { dryRun: false });
    expect(twice.result.error ?? '').toContain('refusing to guess');
    expect(twice.writes).toEqual([]);
  });

  it('stops at a cap of 0', async () => {
    const { result, writes } = await run(files, routes(), settings({ dryRun: false, cap: 0 }), workflow, { dryRun: false });
    expect(result.error ?? '').toContain('Cap reached');
    expect(writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// vcfa_vks_cluster

describe('pkg vcfa-extend: vcfa_vks_cluster', { skip: !CURL }, () => {
  const SUP_PASSWORD = 'Sup-Pa55word-do-not-log';
  const SESSION = 'wcp-session-do-not-log';
  const files = build('vcfa_vks_cluster');
  const { spec } = ownPackage(files);
  const workflow = spec.workflows[0]!.name;
  const API = '/apis/cluster.x-k8s.io/v1beta1/namespaces/team-a-prod/clusters';
  const routes = (o: { exists?: boolean; dryRunStatus?: number } = {}): FakeRoute[] => [
    { method: 'POST', path: '^/wcp/login$', body: { session_id: SESSION } },
    { method: 'GET', path: `^${API}/team-a-prod-01$`, status: o.exists ? 200 : 404, body: o.exists ? { metadata: { name: 'team-a-prod-01' }, spec: { topology: { version: 'v1.31.1' } } } : { kind: 'Status', code: 404 } },
    { method: 'POST', path: `^${API}\\?dryRun=All$`, status: o.dryRunStatus ?? 201, body: o.dryRunStatus ? { kind: 'Status', message: `admission webhook denied: vmClass not bound` } : { metadata: { name: 'team-a-prod-01' } } },
    { method: 'POST', path: `^${API}$`, status: 201, body: { metadata: { name: 'team-a-prod-01' } } },
  ];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => ({ supervisorHost: host, supervisorUsername: 'devops@vsphere.local', supervisorPassword: SUP_PASSWORD, ...extra });

  it('binds the template to a namespace resource instead of an expression that binds nothing', () => {
    const template = files['vcfa-vks-cluster-cci-template.yaml']!;
    expect(template.includes('context: ${resource.namespace.id}')).toBe(true);
    expect(template.includes('cci.namespace.id')).toBe(false);
    expect(template.includes('type: CCI.Supervisor.Namespace')).toBe(true);
  });

  it('dry run: logs in, finds no cluster, has the Supervisor validate it, creates nothing', async () => {
    const { result, requests, writes } = await run(files, routes(), settings(), workflow, { dryRun: true });
    expect(result.error).toBe(null);
    expect(calls(requests)).toEqual(['POST /wcp/login', `GET ${API}/team-a-prod-01`, `POST ${API}`]);
    expect(requests[2]!.path).toBe(`${API}?dryRun=All`);
    expect(writes).toEqual([]);
    expect(requests[0]!.headers.authorization).toBe(`Basic ${btoa(`devops@vsphere.local:${SUP_PASSWORD}`)}`);
    assertNoSecret(result, SUP_PASSWORD, SESSION);
  });

  it('armed: validates, then creates the Cluster with the manifest, once', async () => {
    const { result, requests, writes } = await run(files, routes(), settings({ dryRun: false }), workflow, { dryRun: false });
    expect(result.error).toBe(null);
    expect(writes).toEqual([`POST ${API}`]);
    const cluster = JSON.parse(requests.find((r) => r.path === API)!.body) as { kind: string; metadata: { name: string; namespace: string }; spec: { topology: { class: string; controlPlane: { replicas: number }; workers: { machineDeployments: { replicas: number }[] } } } };
    expect([cluster.kind, cluster.metadata.name, cluster.metadata.namespace]).toEqual(['Cluster', 'team-a-prod-01', 'team-a-prod']);
    expect(cluster.spec.topology.class).toBe('builtin-generic-v3.1.0');
    expect(cluster.spec.topology.controlPlane.replicas).toBe(3);
    expect(cluster.spec.topology.workers.machineDeployments[0]!.replicas).toBe(3);
    expect(requests.slice(1).every((r) => r.headers.authorization === `Bearer ${SESSION}`)).toBe(true);
    expect(result.outputs.clusterName).toBe('team-a-prod-01');
    assertNoSecret(result, SUP_PASSWORD, SESSION);
  });

  it('leaves an existing cluster alone, and stops when the server-side dry run refuses', async () => {
    const there = await run(files, routes({ exists: true }), settings({ dryRun: false }), workflow, { dryRun: false });
    expect(there.result.error).toBe(null);
    expect(calls(there.requests)).toEqual(['POST /wcp/login', `GET ${API}/team-a-prod-01`]);
    const refused = await run(files, routes({ dryRunStatus: 422 }), settings({ dryRun: false }), workflow, { dryRun: false });
    expect(refused.result.error ?? '').toContain('returned HTTP 422');
    expect(refused.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// vcfa_terraform_in_template

describe('pkg vcfa-extend: vcfa_terraform_in_template', { skip: !CURL }, () => {
  const files = build('vcfa_terraform_in_template', { commit: '3f9c2e1a7b' });
  const { spec } = ownPackage(files);
  const workflow = spec.workflows[0]!.name;
  const routes: FakeRoute[] = [
    vcfaLogin,
    PROJECTS,
    INTEGRATIONS,
    { method: 'POST', path: '^/blueprint/api/blueprint-validation$', body: { valid: true, validationMessages: [] } },
    { method: 'GET', path: '^/blueprint/api/blueprints/bp-9/versions\\?', body: list([]) },
    { method: 'GET', path: '^/blueprint/api/blueprints\\?', body: list([]) },
    { method: 'POST', path: '^/blueprint/api/blueprints$', body: { id: 'bp-9' } },
    { method: 'POST', path: '^/blueprint/api/blueprints/bp-9/versions$', body: { version: '1.0.0' } },
  ];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => vcfaSettings(host, { projectName: 'Team A', ...extra });

  it('dry run validates on the server and writes nothing', async () => {
    const { result, requests, writes } = await run(files, routes, settings(), workflow, { dryRun: true });
    expect(result.error).toBe(null);
    expect(writes).toEqual([]);
    expect(requests.some((r) => r.path === '/blueprint/api/blueprint-validation')).toBe(true);
    expect(result.outputs.templateId).toBe('');
  });

  it('armed: fills in the repository integration id, creates the template and its version, released when set', async () => {
    const { result, requests, writes } = await run(files, routes, settings({ dryRun: false, release: true }), workflow, { dryRun: false });
    expect(result.error).toBe(null);
    expect(writes).toEqual(['POST /blueprint/api/blueprints', 'POST /blueprint/api/blueprints/bp-9/versions']);
    const template = bodyOf(requests, 'POST', '/blueprint/api/blueprints') as { content: string; projectId: string };
    expect(template.projectId).toBe('p-1');
    expect(template.content.includes('repositoryId: "git-1"')).toBe(true);
    expect(template.content.includes('commitId: 3f9c2e1a7b')).toBe(true);
    expect((bodyOf(requests, 'POST', '/blueprint/api/blueprints/bp-9/versions') as { release: boolean }).release).toBe(true);
    expect(result.outputs.templateId).toBe('bp-9');
    assertNoSecret(result, VCFA_TOKEN, ACCESS);
  });

  it('refuses a template with no commit, and an unknown integration, before any write', async () => {
    const unpinned = build('vcfa_terraform_in_template', { commit: '' });
    const a = await run(unpinned, routes, settings({ dryRun: false }), ownPackage(unpinned).spec.workflows[0]!.name, { dryRun: false });
    expect(a.result.error ?? '').toContain('<REQUIRED');
    expect(a.writes).toEqual([]);
    const b = await run(files, routes, settings({ dryRun: false, repositoryIntegration: 'nope' }), workflow, { dryRun: false });
    expect(b.result.error ?? '').toContain("No integration named 'nope'");
    expect(b.writes).toEqual([]);
  });
});
