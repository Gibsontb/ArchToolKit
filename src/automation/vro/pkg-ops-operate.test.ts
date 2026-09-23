/**
 * The VCF Operations "operate" and 9.1 log management automations, as
 * Orchestrator packages (src/automation/blueprints/vcf-ops-operate.ts).
 *
 * For every one of the thirteen, over every select option and toggle:
 *   - the package builds, reads back, and every script in it is ES5;
 *   - secrets are SecureString attributes with no value;
 *   - IMPORT.md names the package and the core library, and every import/ path;
 *   - no credential literal and no token on a command line anywhere; every
 *     JSON file parses; the Automation contract is filled.
 *
 * Then each runs in the emulator against a fake server in another process:
 *   - the log management rule checks (masking, filter, forwarding, partition,
 *     agents) test the rule on its own terms, call nothing without opsHost,
 *     and with it make exactly the ops-li token exchange (KB 450054);
 *   - the saved log query changes nothing in a dry run, creates / updates /
 *     leaves alone exactly as it should when armed, stops at the cap and at
 *     the first failure, refuses a duplicate name, and tests its extracted
 *     field before calling anything;
 *   - the 8.18 / 9.0 inventory logs in to the standalone appliance's /api/v2,
 *     falls back to /api/v1, only GETs, and fails on what it could not read;
 *   - the read-only reports (health, findings, real-time, vSAN, audit,
 *     posture) only GET (or POST the documented queries) and produce the
 *     right output, and no secret reaches a log line.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { readPackageSpec, type VroPackageSpec } from '../../kit/vro-package.ts';
import { automationFor } from '../blueprints/index.ts';
import { VCF_OPS_LOGS_91, VCF_OPS_OPERATE } from '../blueprints/vcf-ops-operate.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../../testing/fake-rest-server.ts';

const IDS = [...VCF_OPS_LOGS_91, ...VCF_OPS_OPERATE].map((b) => b.id);

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

/** Every select option and every toggle flipped, once each, as the repo-wide tests do. */
function variants(id: string): { label: string; values: BlueprintValues }[] {
  const blueprint = automationFor(id)!;
  const base = defaultValues(blueprint);
  const out: { label: string; values: BlueprintValues }[] = [{ label: 'defaults', values: { ...base } }];
  for (const input of blueprint.inputs) {
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
  const all = packagesIn(files);
  const dir = Object.keys(all).find((d) => d !== 'com.archtoolkit.core.package')!;
  const spec = readPackageSpec(all[dir]!);
  return { dir, spec, workflow: spec.workflows[0]!.name, configKey: `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}` };
}

function workflowScript(xml: string): string {
  const m = /<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/.exec(xml);
  return m ? [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join('') : '';
}

function logText(run: WorkflowRun): string {
  return run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');
}

const PASSWORD = 'Ops-Pa55word-do-not-log';
const OPS_TOKEN = 'ops-token-do-not-log';
const JWT = 'eyJ.ops-li-jwt-do-not-log';
const LOGS_PASSWORD = 'Logs-Pa55word-do-not-log';
const SESSION = 'logs-session-do-not-log';

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AUTH_ROUTES: FakeRoute[] = [
  { method: 'POST', path: '^/suite-api/api/auth/token/acquire$', body: { token: OPS_TOKEN, validity: 0 } },
  { method: 'POST', path: '^/suite-api/api/auth/token/release$', body: '' },
  { method: 'POST', path: '^/suite-api/api/auth/token/exchange$', body: { token: JWT } },
];
const page = <T>(key: string, items: readonly T[]) => ({ [key]: items, pageInfo: { totalCount: items.length, page: 0, pageSize: 1000 } });
const call = (r: FakeRequest) => `${r.method} ${r.path.split('?')[0]}`;
const isAuth = (r: FakeRequest) => /\/auth\/token\/(acquire|release)$/.test(r.path);

const servers: FakeServer[] = [];
after(() => servers.forEach((s) => s.stop()));

/** Run the automation's workflow against a fresh fake server; opsHost points at it unless settings say otherwise. */
async function run(files: Record<string, string>, routes: readonly FakeRoute[], settings: Record<string, unknown> = {}, inputs: Record<string, unknown> = {}) {
  const server = await startFakeServer([...AUTH_ROUTES, ...routes]);
  servers.push(server);
  const host = `127.0.0.1:${server.port}`;
  const p = pkgOf(files);
  const emulator = new VroEmulator(files, { config: { [p.configKey]: { opsHost: host, opsUsername: 'reader', opsPassword: PASSWORD, ...settings } } });
  const result = emulator.runWorkflow(p.workflow, inputs);
  const requests = server.requests();
  // No secret, token or session id in any log line, output or error.
  expect(/do-not-log/.test(logText(result))).toBe(false);
  return { result, requests, host };
}

// ---------------------------------------------------------------------------

describe('ops-operate packages: built, importable, and within the repo rules', () => {
  it('covers all thirteen automations', () => {
    expect(IDS.length).toBe(13);
  });

  it('every variant builds one package plus the core library, and reads back', () => {
    for (const id of IDS) {
      for (const v of variants(id)) {
        const files = build(id, v.values);
        const all = packagesIn(files);
        expect(Object.keys(all).length).toBe(2);
        const p = pkgOf(files);
        expect(p.spec.name.startsWith('com.archtoolkit.')).toBe(true);
        expect(p.spec.workflows.length).toBe(1);
        expect(p.spec.configs.length).toBe(1);
      }
    }
  });

  it('every workflow and action is ES5', () => {
    const problems: string[] = [];
    for (const id of IDS) {
      for (const v of variants(id)) {
        const { spec } = pkgOf(build(id, v.values));
        for (const w of spec.workflows) problems.push(...es5Problems(workflowScript(w.xml), `${id} ${v.label} ${w.name}`));
        for (const a of spec.actions) problems.push(...es5Problems(a.script, `${id} ${v.label} ${a.name}`));
      }
    }
    expect(problems).toEqual([]);
  });

  it('secrets are SecureString attributes with no value, and changing workflows are dry runs by default', () => {
    for (const id of IDS) {
      const { spec } = pkgOf(build(id));
      const attrs = spec.configs[0]!.attributes;
      const secrets = attrs.filter((a) => a.type === 'SecureString');
      // The password, and any webhook or audit URL (its path can be its secret).
      expect(secrets.filter((a) => !/^(webhook|auditUrl)$/.test(a.name)).length).toBe(1);
      for (const s of secrets) expect(s.value === undefined || s.value === '').toBe(true);
      expect(attrs.some((a) => /password/i.test(a.name) && a.type !== 'SecureString')).toBe(false);
      const dry = attrs.find((a) => a.name === 'dryRun');
      if (dry) expect(dry.value).toBe(true);
    }
    expect(pkgOf(build('vcflog91_alert_query')).spec.configs[0]!.attributes.find((a) => a.name === 'dryRun')?.value).toBe(true);
  });

  it('IMPORT.md names the package, the core library and every import/ path, and the scripts are kept as a fallback', () => {
    const problems: string[] = [];
    for (const id of IDS) {
      for (const v of variants(id)) {
        const files = build(id, v.values);
        const md = files['IMPORT.md'] ?? '';
        if (!md.startsWith('# Importing: ')) problems.push(`${id} ${v.label}: IMPORT.md`);
        const { dir } = pkgOf(files);
        for (const need of [`import/${dir}`, 'import/com.archtoolkit.core.package']) if (!md.includes(need)) problems.push(`${id} ${v.label}: ${need} not in IMPORT.md`);
        const top = new Set(Object.keys(files).filter((path) => path.startsWith('import/')).map((path) => /^(import\/[^/]+)/.exec(path)![1]!));
        for (const path of top) if (!md.includes(path)) problems.push(`${id} ${v.label}: ${path}`);
        if (!Object.keys(files).some((path) => path.startsWith('scripts/'))) problems.push(`${id} ${v.label}: no scripts/ fallback`);
        // A script that reads files beside it runs from its own folder.
        for (const [path, body] of Object.entries(files)) {
          if (!path.startsWith('scripts/') || !path.endsWith('.sh')) continue;
          if (/--data @"\$\{file\}"|python3 - [a-z-]+\.json/.test(body) && !body.includes('cd "$(dirname "$0")"')) problems.push(`${id} ${v.label}: ${path} reads beside itself without cd`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('writes no credential literal, no token on a command line, and JSON that parses', () => {
    const literal = /\b(password|passwd|secret|api[_-]?key|token|credential)\w*\s*[:=]+\s*["'][^"'$%{<@]/i;
    const onArgv = /-H "?(Authorization|x-hm-authorization|vmware-api-session-id): *[A-Za-z]* *\$/;
    const problems: string[] = [];
    for (const id of IDS) {
      for (const v of variants(id)) {
        for (const [path, body] of Object.entries(build(id, v.values))) {
          for (const line of body.split('\n')) {
            if (literal.test(line)) problems.push(`${id} ${v.label} ${path}: ${line.trim().slice(0, 80)}`);
            if ((path.endsWith('.sh') || body.startsWith('#!/usr/bin/env bash')) && onArgv.test(line)) problems.push(`${id} ${v.label} ${path}: token on argv`);
          }
          if (path.endsWith('.json')) {
            try {
              JSON.parse(body);
            } catch (error) {
              problems.push(`${id} ${v.label} ${path}: ${String(error)}`);
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the Automation contract for every variant', () => {
    const problems: string[] = [];
    for (const id of IDS) {
      const blueprint = automationFor(id)!;
      for (const v of variants(id)) {
        const a = blueprint.automation(v.values, id);
        if (!a.trigger.detail.trim() || !a.scope.what.trim() || a.scope.decidedBy.length === 0 || !a.scope.ifWrong.trim()) problems.push(`${id} ${v.label}: scope/trigger`);
        if (a.undo.length === 0 || a.told.length === 0) problems.push(`${id} ${v.label}: undo/told`);
        if (a.effect !== 'read' && (a.guardrails.length === 0 || a.dryRun.length === 0)) problems.push(`${id} ${v.label}: guardrails/dry run`);
      }
      const out = blueprint.build(defaultValues(blueprint), id);
      if ((out.findings ?? []).some((f) => f.severity === 'error')) problems.push(`${id}: defaults have an error finding`);
      if (!out.files['README.md']) problems.push(`${id}: no README`);
    }
    expect(problems).toEqual([]);
  });

  it('keeps every native artifact: the 9.1 rule specs, liagent.ini / fluent-bit.conf, PromQL and the checklists', () => {
    expect(typeof build('vcflog91_masking')['scripts/masking-rule.json']).toBe('string');
    expect(typeof build('vcflog91_agents')['liagent.ini']).toBe('string');
    expect(typeof build('vcflog91_agents', { os: 'kubernetes' })['fluent-bit.conf']).toBe('string');
    expect(typeof build('vcfops_realtime')['queries.promql']).toBe('string');
    expect(Object.keys(build('vcflog91_upgrade')).some((p) => p.endsWith('-CHECKLIST.md'))).toBe(true);
    expect(typeof build('vcfops_audit', { stream_events: true })['audit-forwarding.json']).toBe('string');
    // The 9.1 packages never use the standalone appliance API; only the 8.18 / 9.0 inventory does.
    for (const id of IDS.filter((i) => i !== 'vcflog91_upgrade')) {
      const { spec } = pkgOf(build(id));
      expect(/\/api\/v[12]\//.test(workflowScript(spec.workflows[0]!.xml))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Log management 9.1: rules entered by hand, tested by the workflow

const EXCHANGE_ONLY = ['POST /suite-api/api/auth/token/acquire', 'POST /suite-api/api/auth/token/exchange', 'POST /suite-api/api/auth/token/release'];

describe('ops-operate: 9.1 log masking, tested in Orchestrator', { skip: !CURL }, () => {
  it('passes every preset on its own samples, and calls nothing without opsHost', async () => {
    const blueprint = automationFor('vcflog91_masking')!;
    const presets = blueprint.inputs.find((i) => i.id === 'preset')!.options!.map((o) => o.value);
    expect(presets.length).toBe(6);
    for (const preset of presets) {
      const { result, requests } = await run(build('vcflog91_masking', { preset }), [], { opsHost: '' });
      expect(result.error).toBe(null);
      expect(requests).toEqual([]);
      expect((JSON.parse(String(result.outputs.report)) as { problems: string[] }).problems).toEqual([]);
    }
  });

  it('fails a selector with no capture group, and a clean line the rule would change', async () => {
    const noGroup = await run(build('vcflog91_masking', { preset: 'custom', custom_selector: '(?i)x-api-key:\\s*\\S+' }), [], { opsHost: '' });
    expect(noGroup.result.error ?? '').toContain('1 problem(s)');
    expect(noGroup.result.logs.some((l) => l.message === 'PROBLEM: the selector has no capture group, so 9.1 would mask nothing')).toBe(true);
    const changed = await run(build('vcflog91_masking', { samples_clean: 'db connect password=hunter22 ok' }), [], { opsHost: '' });
    expect(changed.result.logs.some((l) => l.message.startsWith('PROBLEM: changed: db connect password=hunter22 ok  ->  db connect password=**** ok'))).toBe(true);
    const leaked = await run(build('vcflog91_masking', { samples_mask: 'login token-only line without a secret' }), [], { opsHost: '' });
    expect(leaked.result.logs.some((l) => l.message === 'PROBLEM: not masked: login token-only line without a secret')).toBe(true);
  });

  it('with opsHost, proves log management 9.1 is there with the ops-li exchange, and nothing else', async () => {
    const { result, requests } = await run(build('vcflog91_masking'), []);
    expect(result.error).toBe(null);
    expect(requests.map(call)).toEqual(EXCHANGE_ONLY);
    expect(JSON.parse(requests[1]!.body)).toEqual({ serviceKeys: ['ops-li'] });
    expect(requests[1]!.headers.authorization).toBe(`OpsToken ${OPS_TOKEN}`);
    expect(String(result.outputs.report)).toContain('answered the ops-li token exchange');
  });

  it('fails, and still logs out, when the exchange is refused', async () => {
    // The refusing route goes before AUTH_ROUTES' own exchange route: the first match answers.
    const server = await startFakeServer([
      { method: 'POST', path: '^/suite-api/api/auth/token/exchange$', status: 404, body: { message: 'unknown service' } },
      ...AUTH_ROUTES,
    ]);
    servers.push(server);
    const files = build('vcflog91_masking');
    const p = pkgOf(files);
    const r = new VroEmulator(files, { config: { [p.configKey]: { opsHost: `127.0.0.1:${server.port}`, opsUsername: 'reader', opsPassword: PASSWORD } } }).runWorkflow(p.workflow);
    expect(r.error ?? '').toContain('/suite-api/api/auth/token/exchange returned HTTP 404');
    expect(server.requests().map(call)).toEqual(EXCHANGE_ONLY);
    expect(/do-not-log/.test(logText(r))).toBe(false);
  });
});

describe('ops-operate: 9.1 filter, forwarding, partition and agent checks', { skip: !CURL }, () => {
  it('filter: the defaults pass; a kept line the regex matches, and Exists with no scope, fail', async () => {
    expect((await run(build('vcflog91_filtering'), [], { opsHost: '' })).result.error).toBe(null);
    const drops = await run(build('vcflog91_filtering', { samples_keep: '2026-05-01T10:00:02Z dev-app01 orders-api: DEBUG but important' }), [], { opsHost: '' });
    expect(drops.result.logs.some((l) => l.message === 'PROBLEM: would DROP: 2026-05-01T10:00:02Z dev-app01 orders-api: DEBUG but important')).toBe(true);
    const everything = await run(build('vcflog91_filtering', { scope_value: '', match_op: 'Exists' }), [], { opsHost: '' });
    expect(everything.result.error ?? '').toContain('problem(s)');
    expect(everything.result.logs.some((l) => /with no scope condition drops every such event/.test(l.message))).toBe(true);
  });

  it('forwarding: passes with notes, fails without a host, and calls only the exchange', async () => {
    const ok = await run(build('vcflog91_forwarding'), []);
    expect(ok.result.error).toBe(null);
    expect(ok.requests.map(call)).toEqual(EXCHANGE_ONLY);
    const bad = await run(build('vcflog91_forwarding', { host: '' }), [], { opsHost: '' });
    expect(bad.result.logs.some((l) => l.message === 'PROBLEM: no destination host')).toBe(true);
    expect(bad.requests).toEqual([]);
  });

  it('partition: an archive covers a short retention; no archive, or no change number, fails', async () => {
    expect((await run(build('vcflog91_partitions'), [], { opsHost: '' })).result.error).toBe(null);
    const short = await run(build('vcflog91_partitions', { archive: 'none' }), [], { opsHost: '' });
    expect(short.result.logs.some((l) => /searchable for 90 days, required for 365, and nothing archived/.test(l.message))).toBe(true);
    const noChange = await run(build('vcflog91_partitions', { change_ticket: '' }), [], { opsHost: '' });
    expect(noChange.result.logs.some((l) => /^PROBLEM: no change number/.test(l.message))).toBe(true);
  });

  it('agents: passes for every platform; no target fails', async () => {
    for (const os of ['linux', 'windows', 'kubernetes']) expect((await run(build('vcflog91_agents', { os }), [], { opsHost: '' })).result.error).toBe(null);
    const none = await run(build('vcflog91_agents', { target: '' }), [], { opsHost: '' });
    expect(none.result.logs.some((l) => l.message === 'PROBLEM: no target to send to')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The saved log query: the one that changes something

function queryRoutes(opts: { existing?: unknown[]; postStatus?: number } = {}): FakeRoute[] {
  return [
    { method: 'GET', path: '^/suite-api/api/logs/queryconfigs\\?', body: page('logsQueryConfigs', opts.existing ?? []) },
    { method: 'POST', path: '^/suite-api/api/logs/queryconfigs$', status: opts.postStatus ?? 201, body: opts.postStatus ? { message: `refused for ${PASSWORD}` } : { id: 'qc-new-1' } },
    { method: 'PUT', path: '^/suite-api/api/logs/queryconfigs$', body: { id: 'qc-old-1' } },
  ];
}

describe('ops-operate: the 9.1 saved log query, as an Orchestrator package', { skip: !CURL }, () => {
  const files = build('vcflog91_alert_query');
  const p = pkgOf(files);
  const qc = JSON.parse(p.spec.resources.find((r) => r.name === 'queryconfig.json')!.content) as Record<string, unknown>;
  const writes = (requests: FakeRequest[]) => requests.filter((r) => r.method !== 'GET' && !isAuth(r)).map(call);

  it('dry run by default: reads, plans one create, writes nothing', async () => {
    const { result, requests } = await run(files, queryRoutes());
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    expect(result.logs.some((l) => l.message === `DRY RUN: would create saved log query "${String(qc.name)}"`)).toBe(true);
    expect(result.outputs.queryConfigId).toBe('');
  });

  it('the dryRun input can only make a run safer', async () => {
    const { requests } = await run(files, queryRoutes(), { dryRun: false }, { dryRun: true });
    expect(writes(requests)).toEqual([]);
  });

  it('armed: looks first, then creates the saved query as written, with the OpsToken', async () => {
    const { result, requests } = await run(files, queryRoutes(), { dryRun: false });
    expect(result.error).toBe(null);
    expect(requests.map(call)).toEqual(['POST /suite-api/api/auth/token/acquire', 'GET /suite-api/api/logs/queryconfigs', 'POST /suite-api/api/logs/queryconfigs', 'POST /suite-api/api/auth/token/release']);
    expect(JSON.parse(requests[2]!.body)).toEqual(qc);
    expect(requests.slice(1).every((r) => r.headers.authorization === `OpsToken ${OPS_TOKEN}`)).toBe(true);
    expect(result.outputs.queryConfigId).toBe('qc-new-1');
    expect((JSON.parse(String(result.outputs.summary)) as { changes: unknown[] }).changes.length).toBe(1);
  });

  it('leaves a matching saved query alone, and updates one that differs by PUT with its id', async () => {
    const same = await run(files, queryRoutes({ existing: [{ ...qc, id: 'qc-old-1', lastModifiedTime: 1, modifiedBy: 'admin' }] }), { dryRun: false });
    expect(same.result.error).toBe(null);
    expect(writes(same.requests)).toEqual([]);
    expect(same.result.outputs.queryConfigId).toBe('qc-old-1');
    const differs = await run(files, queryRoutes({ existing: [{ ...qc, id: 'qc-old-1', queryText: ['something else'] }] }), { dryRun: false });
    expect(differs.result.error).toBe(null);
    expect(writes(differs.requests)).toEqual(['PUT /suite-api/api/logs/queryconfigs']);
    expect(JSON.parse(differs.requests.find((r) => r.method === 'PUT')!.body)).toEqual({ ...qc, id: 'qc-old-1' });
  });

  it('stops at the cap before the change', async () => {
    const { result, requests } = await run(files, queryRoutes(), { dryRun: false, cap: 0 });
    expect(writes(requests)).toEqual([]);
    expect(result.error ?? '').toContain('Cap reached: 0 change(s) made, the cap is 0; stopping before: create saved log query');
    expect(call(requests[requests.length - 1]!)).toBe('POST /suite-api/api/auth/token/release');
  });

  it('stops at the first failure, says what failed, and still logs out', async () => {
    const { result, requests } = await run(files, queryRoutes({ postStatus: 500 }), { dryRun: false });
    expect(result.error ?? '').toContain('Stopped after 0 change(s): create saved log query');
    expect(result.error ?? '').toContain('/suite-api/api/logs/queryconfigs returned HTTP 500');
    expect(call(requests[requests.length - 1]!)).toBe('POST /suite-api/api/auth/token/release');
  });

  it('refuses two saved queries of the same name rather than guess', async () => {
    const twin = { ...qc, id: 'a' };
    const { result, requests } = await run(files, queryRoutes({ existing: [twin, { ...qc, id: 'b' }] }), { dryRun: false });
    expect(result.error ?? '').toContain(`2 saved queries are named "${String(qc.name)}"`);
    expect(writes(requests)).toEqual([]);
  });

  it('tests the extracted field first: a sample it cannot read stops the run before any call', async () => {
    const { result, requests } = await run(build('vcflog91_alert_query', { sample_line: 'ERROR payment gateway timeout, no latency here' }), queryRoutes(), { dryRun: false });
    expect(result.error ?? '').toContain('pulls nothing out of the sample line');
    expect(requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The 8.18 / 9.0 inventory: the standalone appliance API, on purpose

function applianceRoutes(missingAgents: boolean): FakeRoute[] {
  return [
    { method: 'POST', path: '^/api/v2/sessions$', body: { userId: 'u1', sessionId: SESSION, ttl: 1800 } },
    { method: 'GET', path: '^/api/v2/version$', body: { version: '8.18.3', releaseName: 'GA' } },
    // content packs moved: v2 is not there, v1 answers.
    { method: 'GET', path: '^/api/v1/content/contentpack/list$', body: { contentPackMetadataList: [{ name: 'vSphere' }, { name: 'NSX' }] } },
    { method: 'GET', path: '^/api/v2/alerts$', body: [{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }] },
    { method: 'GET', path: '^/api/v2/forwarding$', body: { forwarders: [{ name: 'siem' }] } },
    { method: 'GET', path: '^/api/v2/partitions$', body: { partitions: [] } },
    { method: 'GET', path: '^/api/v2/archiving$', body: { enabled: false } },
    { method: 'GET', path: '^/api/v2/agent/groups$', body: { groups: [{ name: 'web' }] } },
    ...(missingAgents ? [] : [{ method: 'GET', path: '^/api/v2/agent/agents$', body: { agents: [{ hostname: 'web01' }] } }]),
  ];
}

describe('ops-operate: the Logs 8.18 / 9.0 inventory, as an Orchestrator package', { skip: !CURL }, () => {
  const files = build('vcflog91_upgrade');
  const p = pkgOf(files);
  const go = async (missingAgents: boolean) => {
    const server = await startFakeServer(applianceRoutes(missingAgents));
    servers.push(server);
    const result = new VroEmulator(files, { config: { [p.configKey]: { logsHost: `127.0.0.1:${server.port}`, logsUsername: 'admin', logsPassword: LOGS_PASSWORD } } }).runWorkflow(p.workflow);
    expect(/do-not-log/.test(logText(result))).toBe(false);
    return { result, requests: server.requests() };
  };

  it('logs in with /api/v2/sessions, falls back to /api/v1, and only GETs', async () => {
    const { result, requests } = await go(false);
    expect(result.error).toBe(null);
    expect(requests[0]!.method + ' ' + requests[0]!.path).toBe('POST /api/v2/sessions');
    expect(JSON.parse(requests[0]!.body)).toEqual({ username: 'admin', password: LOGS_PASSWORD, provider: 'Local' });
    expect(requests.slice(1).every((r) => r.method === 'GET' && r.headers.authorization === `Bearer ${SESSION}`)).toBe(true);
    const items = (JSON.parse(String(result.outputs.inventoryJson)) as { items: Record<string, { path: string }> }).items;
    expect(Object.keys(items).sort()).toEqual(['agent-groups', 'agents', 'alerts', 'archiving', 'content-packs', 'forwarding', 'partitions', 'version']);
    expect(items['content-packs']!.path).toBe('/api/v1/content/contentpack/list');
    expect((JSON.parse(String(result.outputs.summary)) as { summary: { counts: Record<string, number> } }).summary.counts.alerts).toBe(3);
  });

  it('fails, naming what it could not read, after trying both paths', async () => {
    const { result, requests } = await go(true);
    expect(result.error ?? '').toContain('1 item(s) not exported: agents (tried: /api/v2/agent/agents /api/v1/agent/agents)');
    expect(requests.filter((r) => /agent\/agents/.test(r.path)).map((r) => r.path)).toEqual(['/api/v2/agent/agents', '/api/v1/agent/agents']);
  });
});

// ---------------------------------------------------------------------------
// The read-only reports

const onlyReads = (requests: FakeRequest[], allowedPosts: RegExp) =>
  requests.filter((r) => !(r.method === 'GET' || isAuth(r) || (r.method === 'POST' && allowedPosts.test(r.path)))).map(call);

const res = (id: string, name: string, health: string, score: number) => ({ identifier: id, resourceKey: { name }, resourceHealth: health, resourceHealthValue: score });

describe('ops-operate: VCF Health report', { skip: !CURL }, () => {
  const files = build('vcfops_health_fleet', { webhook: 'https://hooks.example.com/x' });
  const routes = (nsx: unknown[]): FakeRoute[] => [
    { method: 'POST', path: '^/suite-api/api/alerts/query\\?', body: page('alerts', [{ resourceId: 'h1', alertLevel: 'CRITICAL', alertDefinitionName: 'Host lost redundancy' }, { resourceId: 'h2', alertLevel: 'WARNING', alertDefinitionName: 'NTP drift' }]) },
    { method: 'GET', path: '^/suite-api/api/resources\\?adapterKind=VMWARE&resourceKind=HostSystem&', body: page('resourceList', [res('h1', 'esx01', 'GREEN', 100), res('h2', 'esx02', 'GREEN', 100)]) },
    { method: 'GET', path: `^/suite-api/api/resources\\?adapterKind=VMWARE&resourceKind=${esc(encodeURIComponent('VMwareAdapter Instance'))}&`, body: page('resourceList', [res('v1', 'vc01', 'GREEN', 100)]) },
    { method: 'GET', path: '^/suite-api/api/resources\\?adapterKind=NSXTAdapter&', body: page('resourceList', nsx) },
    { method: 'GET', path: '^/suite-api/api/resources\\?adapterKind=VirtualAndPhysicalSANAdapter&', body: page('resourceList', [res('s1', 'vsan-a', 'ORANGE', 60)]) },
    { method: 'POST', path: '^/hook$', body: {} },
  ];

  it('reports every kind, fails on critical alerts, orange health and an empty kind, and only reads', async () => {
    const { result, requests } = await run(files, routes([]), {});
    expect(result.error ?? '').toContain('VCF Health: 3 problem(s)');
    // In the order the kinds are read: ESX, vCenter, NSX, vSAN.
    expect(result.logs.filter((l) => l.message.startsWith('PROBLEM: ')).map((l) => l.message)).toEqual([
      'PROBLEM: ESX host esx01: health GREEN, 1 critical alert(s): Host lost redundancy',
      'PROBLEM: no NSX objects returned for NSXTAdapter / ManagementCluster: a blind spot; check the kind key and the adapter',
      'PROBLEM: vSAN cluster vsan-a: health ORANGE',
    ]);
    expect(result.outputs.problemCount).toBe(3);
    expect(String(result.outputs.reportCsv).split('\n')[0]).toBe('kind,name,health,score,critical,immediate,warning,alerts');
    expect(String(result.outputs.reportCsv)).toContain('ESX host,esx02,GREEN,100,0,0,1,NTP drift');
    expect(onlyReads(requests, /^\/suite-api\/api\/alerts\/query\?/)).toEqual([]);
    expect(call(requests[requests.length - 1]!)).toBe('POST /suite-api/api/auth/token/release');
  });

  it('posts the problems to the webhook and passes when all is well', async () => {
    const server = await startFakeServer([...AUTH_ROUTES, ...routes([res('n1', 'nsx-mgr', 'GREEN', 100)])]);
    servers.push(server);
    const host = `127.0.0.1:${server.port}`;
    const p = pkgOf(files);
    const failing = new VroEmulator(files, { config: { [p.configKey]: { opsHost: host, opsUsername: 'r', opsPassword: PASSWORD, webhook: `https://${host}/hook` } } }).runWorkflow(p.workflow);
    expect(failing.error ?? '').toContain('2 problem(s)');
    const hook = server.requests().find((r) => r.path === '/hook')!;
    expect((JSON.parse(hook.body) as { problems: string[] }).problems.length).toBe(2);
    const passing = new VroEmulator(files, { config: { [p.configKey]: { opsHost: host, opsUsername: 'r', opsPassword: PASSWORD, failLevels: ['RED'], failOnCritical: false } } }).runWorkflow(p.workflow);
    expect(passing.error).toBe(null);
    expect(passing.outputs.problemCount).toBe(0);
  });
});

describe('ops-operate: open findings report', { skip: !CURL }, () => {
  const findings = [
    { ruleUuid: 'r1', ruleName: 'Host NTP not configured', severity: 'critical', category: 'Configuration', affectedObjectsCount: 2, lastObservedTimeInMillis: 1767225600000 },
    { ruleUuid: 'r2', ruleName: 'Datastore nearly full', severity: 'warning', category: 'Capacity', affectedObjectsCount: 1 },
  ];
  const routes = (path: string): FakeRoute[] => [
    { method: 'POST', path: `^/suite-api/api/${esc(path)}\\?`, body: page('findings', findings) },
    { method: 'POST', path: '^/suite-api/api/(diagnostics/)?findings/r1/affectedobjects/query\\?', body: page('affectedObjects', [{ name: 'esx01', resourceId: 'h1', resourceKind: 'HostSystem' }, { name: 'esx02', resourceId: 'h2', resourceKind: 'HostSystem' }]) },
    { method: 'POST', path: '^/suite-api/api/(diagnostics/)?findings/r2/affectedobjects/query\\?', body: page('affectedObjects', [{ name: 'ds01', resourceId: 'd1', resourceKind: 'Datastore' }]) },
    { method: 'POST', path: '^/hook$', body: {} },
  ];

  it('reads through the documented diagnostics path, lists affected objects, and fails on a critical finding', async () => {
    const { result, requests } = await run(build('vcfops_findings'), routes('diagnostics/findings/query'), {});
    expect(result.error ?? '').toContain('1 finding(s) at a failing severity (CRITICAL)');
    expect(result.outputs.findingCount).toBe(2);
    expect(String(result.outputs.reportCsv)).toContain('critical,Host NTP not configured,Configuration,2,2026-01-01T00:00:00.000Z,esx01; esx02');
    expect(requests.filter((r) => !isAuth(r)).every((r) => r.method === 'POST' && /\/query\?/.test(r.path))).toBe(true);
    expect(requests.filter((r) => /affectedobjects/.test(r.path)).length).toBe(2);
    const bySeverity = JSON.parse(String(result.outputs.reportJson)) as { severity: string; count: number }[];
    expect(bySeverity.map((g) => `${g.severity}:${g.count}`)).toEqual(['critical:1', 'warning:1']);
  });

  it('falls back to /api/findings when the diagnostics path is not there, and respects maxRules and the webhook', async () => {
    const server = await startFakeServer([...AUTH_ROUTES, ...routes('findings/query')]);
    servers.push(server);
    const host = `127.0.0.1:${server.port}`;
    const files = build('vcfops_findings');
    const p = pkgOf(files);
    const result = new VroEmulator(files, { config: { [p.configKey]: { opsHost: host, opsUsername: 'r', opsPassword: PASSWORD, maxRules: 1, failRegex: '', webhook: `https://${host}/hook` } } }).runWorkflow(p.workflow);
    expect(result.error).toBe(null);
    const paths = server.requests().map((r) => r.path.split('?')[0]);
    expect(paths.includes('/suite-api/api/diagnostics/findings/query')).toBe(true);
    expect(paths.filter((x) => /affectedobjects/.test(x!))).toEqual(['/suite-api/api/findings/r1/affectedobjects/query']);
    const hook = server.requests().find((r) => r.path === '/hook')!;
    expect((JSON.parse(hook.body) as { bySeverity: unknown[] }).bySeverity.length).toBe(2);
  });
});

describe('ops-operate: real-time investigation', { skip: !CURL }, () => {
  const stat = (id: string, v: number) => ({ resourceId: id, 'stat-list': { stat: [{ timestamps: [1, 2], statKey: { key: 'cpu|readyPct' }, data: [0.5, v] }] } });
  const routes: FakeRoute[] = [
    { method: 'GET', path: '^/suite-api/api/resources\\?adapterKind=VMWARE&resourceKind=VirtualMachine&', body: page('resourceList', [res('vm-1', 'app1', 'GREEN', 100), res('vm-2', 'app2', 'GREEN', 100), res('vm-3', 'db1', 'GREEN', 100)]) },
    { method: 'POST', path: '^/suite-api/api/resources/stats/latest/query$', body: { values: [stat('vm-1', 2.5), stat('vm-2', 9.25), stat('vm-3', 6)] } },
    { method: 'GET', path: '^/suite-api/api/resources\\?name=db1&resourceKind=VirtualMachine$', body: { resourceList: [{ identifier: 'vm-3' }] } },
    { method: 'GET', path: '^/suite-api/api/resources/vm-3/stats\\?', body: { values: [{ resourceId: 'vm-3', 'stat-list': { stat: [{ statKey: { key: 'cpu|readyPct' }, timestamps: [1767225600000, 1767225900000], data: [4, 6] }] } }] } },
  ];

  it('ranks by the latest value, charts the named object, and only reads', async () => {
    const { result, requests } = await run(build('vcfops_realtime', { top_n: 2, warn_at: 5 }), routes, {}, { objectName: 'db1' });
    expect(result.error).toBe(null);
    expect((JSON.parse(String(result.outputs.topJson)) as { name: string; value: number }[]).map((t) => `${t.name}=${t.value}`)).toEqual(['app2=9.25', 'db1=6']);
    expect(result.outputs.overCount).toBe(2);
    expect(JSON.parse(String(result.outputs.seriesJson))).toEqual([{ at: '2026-01-01T00:00:00.000Z', value: 4 }, { at: '2026-01-01T00:05:00.000Z', value: 6 }]);
    const latest = requests.find((r) => r.path === '/suite-api/api/resources/stats/latest/query')!;
    expect(JSON.parse(latest.body)).toEqual({ resourceId: ['vm-1', 'vm-2', 'vm-3'], statKey: ['cpu|readyPct'] });
    expect(onlyReads(requests, /^\/suite-api\/api\/resources\/stats\/latest\/query$/)).toEqual([]);
  });
});

describe('ops-operate: vSAN operations report', { skip: !CURL }, () => {
  const latest = (extra: number) => ({ values: [{ 'stat-list': { stat: [{ statKey: { key: 'vsan|capacity|usedSpace' }, data: [1, 10 + extra] }, { statKey: { key: 'vsan|dedup|ratio' }, data: [1.5] }, { statKey: { key: 'cpu|usage' }, data: [3] }] } }] });
  const routes: FakeRoute[] = [
    { method: 'GET', path: '^/suite-api/api/resources\\?adapterKind=VirtualAndPhysicalSANAdapter&resourceKind=VirtualSANDCCluster&', body: page('resourceList', [res('c1', 'vsan-a', 'GREEN', 100), res('c2', 'vsan-b', 'YELLOW', 60)]) },
    { method: 'POST', path: '^/suite-api/api/alerts/query\\?', body: page('alerts', [{ resourceId: 'c1', alertLevel: 'WARNING', alertDefinitionName: 'Disk latency' }]) },
    { method: 'POST', path: '^/suite-api/api/diagnostics/findings/query\\?', body: page('findings', [{ ruleName: 'vSAN object health', severity: 'critical', category: 'vSAN' }]) },
    { method: 'GET', path: '^/suite-api/api/resources/c1/stats/latest$', body: latest(0) },
    { method: 'GET', path: '^/suite-api/api/resources/c2/stats/latest$', body: latest(5) },
  ];

  it('reports health, alerts, findings and only the capacity metrics, fails below the score and on a critical finding, and only reads', async () => {
    const { result, requests } = await run(build('vcfops_vsan_ops'), routes);
    expect(result.error ?? '').toContain('vSAN: 2 problem(s)');
    expect(result.logs.filter((l) => l.message.startsWith('PROBLEM: ')).map((l) => l.message)).toEqual(['PROBLEM: vsan-b: health YELLOW score 60, 0 critical alert(s)', 'PROBLEM: 1 critical vSAN finding(s)']);
    const report = JSON.parse(String(result.outputs.reportJson)) as { clusters: { name: string; capacity: { key: string; value: number }[]; alerts: unknown[] }[]; findings: unknown[] };
    expect(report.clusters[1]!.capacity).toEqual([{ key: 'vsan|capacity|usedSpace', value: 15 }, { key: 'vsan|dedup|ratio', value: 1.5 }]);
    expect(report.clusters[0]!.alerts.length).toBe(1);
    expect(report.findings.length).toBe(1);
    const fbody = requests.find((r) => r.path.startsWith('/suite-api/api/diagnostics/findings/query?page=0&pageSize=1000'))!;
    expect(JSON.parse(fbody.body)).toEqual({ filter: { adapterKinds: ['VirtualAndPhysicalSANAdapter'] } });
    expect(onlyReads(requests, /^\/suite-api\/api\/(alerts|diagnostics\/findings)\/query\?/)).toEqual([]);
  });
});

describe('ops-operate: audit report export', { skip: !CURL }, () => {
  const report = { auditReports: [{ name: 'Users', audits: [{ name: 'Local users', count: 12 }] }] };
  it('reads the system audit report and posts it to auditUrl; a failed post fails the run', async () => {
    const server = await startFakeServer([
      ...AUTH_ROUTES,
      { method: 'GET', path: '^/suite-api/api/audit/system$', body: report },
      { method: 'POST', path: '^/sink/ok$', body: {} },
      { method: 'POST', path: '^/sink/down$', status: 503, body: { message: 'down' } },
    ]);
    servers.push(server);
    const host = `127.0.0.1:${server.port}`;
    const files = build('vcfops_audit');
    const p = pkgOf(files);
    const ok = new VroEmulator(files, { config: { [p.configKey]: { opsHost: host, opsUsername: 'r', opsPassword: PASSWORD, auditUrl: `https://${host}/sink/ok` } } }).runWorkflow(p.workflow);
    expect(ok.error).toBe(null);
    const posted = JSON.parse(server.requests().find((r) => r.path === '/sink/ok')!.body) as { exportedFor: string; host: string; report: unknown };
    expect(posted.report).toEqual(report);
    expect(posted.host).toBe(host);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(posted.exportedFor)).toBe(true);
    expect(server.requests().filter((r) => r.path.startsWith('/suite-api/') && !isAuth(r)).map(call)).toEqual(['GET /suite-api/api/audit/system']);
    const down = new VroEmulator(files, { config: { [p.configKey]: { opsHost: host, opsUsername: 'r', opsPassword: PASSWORD, auditUrl: `https://${host}/sink/down` } } }).runWorkflow(p.workflow);
    expect(down.error ?? '').toContain(`Posting the audit report to https://${host} failed`);
    expect(down.error ?? '').toContain('returned HTTP 503');
    expect(/do-not-log/.test(logText(ok) + logText(down))).toBe(false);
  });

  it('never logs, outputs or throws the path of auditUrl, which can carry its secret (regression)', async () => {
    const server = await startFakeServer([
      ...AUTH_ROUTES,
      { method: 'GET', path: '^/suite-api/api/audit/system$', body: report },
      { method: 'POST', path: '^/services/T0001/B0002/', status: 500, body: { message: 'boom' } },
      { method: 'POST', path: '^/services/T0003/B0004/', body: {} },
    ]);
    servers.push(server);
    const host = `127.0.0.1:${server.port}`;
    const files = build('vcfops_audit');
    const p = pkgOf(files);
    const attr = p.spec.configs[0]!.attributes.find((a) => a.name === 'auditUrl');
    expect(attr?.type).toBe('SecureString');
    expect(attr?.value).toBe(undefined);
    const runWith = (auditUrl: string) => new VroEmulator(files, { config: { [p.configKey]: { opsHost: host, opsUsername: 'r', opsPassword: PASSWORD, auditUrl } } }).runWorkflow(p.workflow);
    const ok = runWith(`https://${host}/services/T0003/B0004/ok-path-token-do-not-log?sig=query-do-not-log`);
    expect(ok.error).toBe(null);
    expect(JSON.parse(String(ok.outputs.summary)).summary.sentTo).toBe(`https://${host}`);
    expect(ok.logs.some((l) => l.message === `Audit report for ${JSON.parse(String(ok.outputs.summary)).summary.exportedFor} posted to https://${host}`)).toBe(true);
    const failed = runWith(`https://${host}/services/T0001/B0002/failing-path-token-do-not-log`);
    expect(failed.error ?? '').toContain(`Posting the audit report to https://${host} failed`);
    expect(/do-not-log|T0001|T0003/.test(logText(ok) + logText(failed))).toBe(false);
  });
});

describe('ops-operate: Security Posture Management drift', { skip: !CURL }, () => {
  const now = Date.now();
  const day = 86400000;
  const routes: FakeRoute[] = [
    { method: 'GET', path: '^/suite-api/api/alertdefinitions\\?', body: page('alertDefinitions', [{ id: 'AD-scg-1', name: 'VCF 9.x Security Configuration Guide - SSH disabled', subType: 21 }, { id: 'AD-perf', name: 'Host CPU', subType: 19 }, { id: 'AD-pci', name: 'PCI DSS - NTP', subType: 21 }]) },
    {
      method: 'POST',
      path: '^/suite-api/api/alerts/query\\?',
      responses: [
        { body: page('alerts', [{ resourceId: 'h1', alertDefinitionId: 'AD-scg-1', startTimeUTC: now - 2 * day }, { resourceId: 'h2', alertDefinitionId: 'AD-scg-1', startTimeUTC: now - 30 * day }]) },
        { body: page('alerts', [{ resourceId: 'h1', alertDefinitionId: 'AD-scg-1', startTimeUTC: now - 2 * day }, { resourceId: 'h2', alertDefinitionId: 'AD-scg-1', startTimeUTC: now - 30 * day }, { resourceId: 'h3', alertDefinitionId: 'AD-scg-1', startTimeUTC: now - 40 * day, cancelTimeUTC: now - day }, { resourceId: 'h4', alertDefinitionId: 'AD-scg-1', startTimeUTC: now - 90 * day, cancelTimeUTC: now - 60 * day }]) },
      ],
    },
    { method: 'GET', path: '^/suite-api/api/resources\\?adapterKind=VMWARE&resourceKind=HostSystem&', body: page('resourceList', [res('h1', 'esx01', 'GREEN', 100), res('h2', 'esx02', 'GREEN', 100)]) },
    { method: 'GET', path: '^/suite-api/api/resources/h1/properties$', body: { property: [{ name: 'hardware|cpuInfo|sevSnpSupported', value: 'true' }, { name: 'summary|version', value: '9.1' }] } },
    { method: 'GET', path: '^/suite-api/api/resources/h2/properties$', body: { property: [{ name: 'summary|version', value: '9.1' }] } },
  ];

  it('alerts mode: new since the window, fixed in it, confidential hosts, and only the documented queries', async () => {
    const { result, requests } = await run(build('vcfops_security_posture', { rule_filter: 'Security Configuration Guide' }), routes);
    expect(result.error ?? '').toContain('1 new failure(s), 2 failing in total');
    const drift = JSON.parse(String(result.outputs.driftJson)) as { failing: number; new: string[]; fixed: string[] };
    expect(drift.new).toEqual(['h1\tVCF 9.x Security Configuration Guide - SSH disabled']);
    expect(drift.fixed).toEqual(['h3\tVCF 9.x Security Configuration Guide - SSH disabled']);
    expect(drift.failing).toBe(2);
    const queries = requests.filter((r) => r.path.startsWith('/suite-api/api/alerts/query')).map((r) => JSON.parse(r.body) as unknown);
    expect(queries).toEqual([{ activeOnly: true, alertDefinitionId: ['AD-scg-1'] }, { activeOnly: false, alertDefinitionId: ['AD-scg-1'] }]);
    const hosts = JSON.parse(String(result.outputs.confidentialJson)) as { name: string; properties: Record<string, string>; reported: boolean }[];
    expect(hosts.map((h) => `${h.name}:${JSON.stringify(h.properties)}`)).toEqual(['esx01:{"hardware|cpuInfo|sevSnpSupported":"true"}', 'esx02:{}']);
    expect(onlyReads(requests, /^\/suite-api\/api\/alerts\/query\?/)).toEqual([]);
  });

  it('refuses when no compliance alert definition matches: nothing to compare is not compliant', async () => {
    const { result } = await run(build('vcfops_security_posture', { rule_filter: 'No such benchmark' }), routes);
    expect(result.error ?? '').toContain('No compliance alert definition matches /No such benchmark/');
  });

  it('CSV mode: drift between two exports passed as inputs, no alert calls', async () => {
    const results = 'rule,object,status\nSSH disabled,esx01,Non-compliant\nNTP,esx02,Compliant\nLockdown,esx02,Non-compliant\n';
    const previous = 'rule,object,status\nSSH disabled,esx01,Non-compliant\nSyslog,esx03,Non-compliant\n';
    const { result, requests } = await run(build('vcfops_security_posture', { source: 'csv', confidential: false }), [], {}, { resultsCsv: results, previousCsv: previous });
    expect(result.error ?? '').toContain('1 new failure(s), 2 failing in total');
    const drift = JSON.parse(String(result.outputs.driftJson)) as { new: string[]; fixed: string[] };
    expect(drift.new).toEqual(['Lockdown,esx02,Non-compliant']);
    expect(drift.fixed).toEqual(['Syslog,esx03,Non-compliant']);
    expect(requests.filter((r) => !isAuth(r))).toEqual([]);
    const empty = await run(build('vcfops_security_posture', { source: 'csv', confidential: false }), [], {}, { resultsCsv: '' });
    expect(empty.result.error ?? '').toContain('an empty export is not a clean result');
  });
});
