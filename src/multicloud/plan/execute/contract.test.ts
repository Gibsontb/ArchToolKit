/**
 * WP-11a: the script contract (A.6.2) over every generated script.
 *
 *   - statically: `contractViolations` on every file (dry-run parsed, no
 *     --yes and no prompt, mutating commands wrapped, verbs dispatched with a
 *     rollback, no credential literal, no footprint), and its traps;
 *   - `bash -n` on every .sh and the PowerShell parser on every .ps1 / .psm1
 *     (each skipped when the tool is not installed);
 *   - at run time, in a scratch directory: dry runs change nothing, runs
 *     change things once (idempotent), every verb writes a started and a
 *     terminal event per item, the exit codes, the gate, credentials only
 *     from the environment, redaction, and events that match the schema and
 *     carry no user, host or path.
 */

import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from '../../../testing/expect.ts';
import { defaultExecution, defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../options.ts';
import type { ItemDecision, Method, Plan, PlanDecision, Platform, WavePlan, Workload } from '../types.ts';
import { contractViolations, VERBS, VERB_STEP, type ExecPath, type Verb } from './contract.ts';
import { executionKit } from './kit.ts';
import { psScript } from './lib-ps.ts';
import { shScript } from './lib-sh.ts';
import { createRegistry, type PackageId, type PathGenerator } from './registry.ts';
import { statusEventProblems } from './schema.ts';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }
function run(cmd: string, args: readonly string[], extra: Record<string, string> = {}, input?: string): Run {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !k.startsWith('ATK_') && k !== 'DEMO_TOKEN' && k !== 'DEMO_TOKEN_FILE') merged[k] = v;
  Object.assign(merged, extra);
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', env: merged, stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}) });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const x = e as { status?: number | null; stdout?: string; stderr?: string };
    return { status: x.status ?? 1, stdout: String(x.stdout ?? ''), stderr: String(x.stderr ?? '') };
  }
}
const BASH = ((): boolean => {
  const r = run('bash', ['-c', 'if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then echo ok; fi']);
  return r.status === 0 && r.stdout.trim() === 'ok';
})();
const PWSH = Number(run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major']).stdout.trim()) >= 7;
const fwd = (p: string): string => p.replace(/\\/g, '/');

// ---------------------------------------------------------------------------
// A kit with every kind of script: core, pending, bash and PowerShell stubs
// ---------------------------------------------------------------------------

function workload(name: string, over: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app: 'shop', env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
  };
}
function dec(id: string, platform: Platform | undefined, method: Method): ItemDecision {
  const chosen = platform ? { platform, score: 10, hits: [] } : undefined;
  return { id, kind: 'workload', disposition: method === 'none' ? 'retire' : method === 'relocate-hcx' ? 'relocate' : 'rehost', method, options: [], ...(chosen ? { chosen } : {}), pinned: false, margin: 1, findings: [] };
}

const SH_BODY = [
  'local marker',
  'marker="$ATK_STATUS/made-$(atk_name "$id")-$ATK_VERB"',
  'if [[ -f "$marker" ]]; then atk_skip "$id" "already there"; fi',
  'if [[ "${ATK_NAME[$id]}" == fail* ]]; then atk_fail "$id" "this one fails"; fi',
  'if [[ -n "${NEED_TOKEN:-}" ]]; then',
  '  token="$(atk_secret DEMO_TOKEN)"',
  '  atk_log "signing in with $token"',
  'fi',
  'atk_run touch "$marker"',
].join('\n');
const PS_BODY = [
  '$marker = Join-Path $PSScriptRoot ("../../../../status/made-" + (Get-AtkName -Id $Id) + "-ps")',
  "if (Test-Path -LiteralPath $marker) { Set-AtkOutcome skipped 'already there'; return }",
  'if ($env:NEED_TOKEN) { $t = Get-AtkSecret -Name DEMO_TOKEN; Write-AtkLog "signing in with $t" }',
  "Invoke-AtkStep 'create the marker' { Set-Content -LiteralPath $marker -Value 'x' }",
].join('\n');
const every = (body: string): Record<Verb, string> => Object.fromEntries(VERBS.map((v) => [v, body])) as Record<Verb, string>;

function stub(id: string, owner: PackageId, paths: readonly ExecPath[], kind: 'sh' | 'ps'): PathGenerator {
  const file = `paths/${id}/${id}.${kind === 'sh' ? 'sh' : 'ps1'}`;
  return {
    id, owner, paths, needs: [], entry: () => file,
    files: () => ({
      [file]: kind === 'sh'
        ? shScript({ file, paths, summary: `Test stub for ${paths.join(', ')}.`, verbs: every(SH_BODY) })
        : psScript({ file, paths, summary: `Test stub for ${paths.join(', ')}.`, verbs: every(PS_BODY) }),
    }),
  };
}

function kit(): Record<string, string> {
  const ws = [workload('web01'), workload('web02'), workload('fail01'), workload('old01'), workload('hv01', { origin: 'hyperv' }), workload('ora01', { origin: 'aws' })];
  const plan: Plan = {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'plan-c0ffee42', name: 'Contract', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: ws, databases: [], apps: [], edges: [], requirements: defaultRequirements(), designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] }, execution: defaultExecution(),
  };
  const decision: PlanDecision = {
    engineVersion: 't', platforms: [], subsetScores: [], findings: [],
    items: Object.fromEntries([
      dec(ws[0]!.id, 'aws', 'replicate'), dec(ws[1]!.id, 'aws', 'replicate'), dec(ws[2]!.id, 'aws', 'replicate'),
      dec(ws[3]!.id, undefined, 'none'), dec(ws[4]!.id, 'vmware', 'relocate-hcx'), dec(ws[5]!.id, 'google', 'replicate'),
    ].map((d) => [d.id, d])),
  };
  const waves: WavePlan = {
    settings: plan.waveSettings, findings: [],
    groups: [{ id: 'g1', items: ws.map((w) => w.id), why: 'test', wave: 1, method: 'replicate' }],
    waves: [{ n: 1, groups: ['g1'] }],
  };
  // gcp-m2vm (ora01) has no generator: it lands on the pending script.
  const registry = createRegistry([stub('mgn', 'WP-11c', ['aws-mgn'], 'sh'), stub('hcx', 'WP-11b', ['hcx-osam'], 'ps')]);
  return { ...executionKit(plan, decision, { platforms: [], findings: [] }, waves, undefined, { registry }).files };
}
const FILES = kit();
const scripts = (ext: RegExp): [string, string][] => Object.entries(FILES).filter(([p]) => ext.test(p));

// ---------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------

describe('the contract over every generated file', () => {
  it('has scripts of every kind to check', () => {
    for (const f of ['lib/atk.sh', 'lib/Atk.psm1', 'controller-check.sh', 'paths/core/core.sh', 'paths/pending/pending.sh', 'paths/mgn/mgn.sh', 'paths/hcx/hcx.ps1']) {
      expect(typeof FILES[f]).toBe('string');
    }
  });
  it('every file keeps the contract', () => {
    const v = Object.entries(FILES).flatMap(([p, t]) => contractViolations(p, t));
    expect(v).toEqual([]);
  });
  it('--dry-run / -DryRun is parsed, opt-in, and never the default', () => {
    expect(FILES['lib/atk.sh']).toContain('--dry-run) ATK_DRY_RUN=1');
    expect(FILES['lib/atk.sh']).toContain('ATK_DRY_RUN=0');
    expect(FILES['lib/Atk.psm1']).toContain('$script:Atk.DryRun = [bool] $DryRun');
    for (const [p, t] of scripts(/\.sh$/)) if (p !== 'lib/atk.sh') expect(/\batk_init(_tool)? /.test(t)).toBe(true);
    for (const [, t] of scripts(/\.ps1$/)) expect(t).toContain('-DryRun:$DryRun');
    for (const [, t] of scripts(/\.(sh|ps1|psm1)$/)) {
      expect(/DRY_RUN=1\s*$|DryRun\s*=\s*\$true/m.test(t)).toBe(false);
    }
  });
  it('every path script dispatches all nine verbs, rollback included', () => {
    for (const [, t] of scripts(/^paths\/.*\.sh$/)) {
      for (const v of VERBS) expect(t).toContain(`verb_${v.replace('-', '_')}() {`);
      expect(t.trimEnd().endsWith('atk_main')).toBe(true);
    }
    for (const [, t] of scripts(/^paths\/.*\.ps1$/)) {
      for (const v of VERBS) expect(t).toContain(`'${v}' = {`);
      expect(t).toContain('Invoke-AtkMain -Verbs $Verbs');
    }
  });
});

describe('contractViolations catches', () => {
  const sh = (body: string): string => shScript({ file: 'paths/x/x.sh', paths: ['aws-mgn'], summary: 'x', verbs: every(body) });
  const ps = (body: string): string => psScript({ file: 'paths/x/x.ps1', paths: ['hcx-bulk'], summary: 'x', verbs: every(body) });
  const has = (v: string[], re: RegExp): boolean => v.some((x) => re.test(x));
  it('a prompt, --yes, and a missing library', () => {
    expect(has(contractViolations('paths/x/x.sh', sh('read -r answer')), /read/)).toBe(true);
    expect(has(contractViolations('paths/x/x.sh', sh('atk_run aws mgn start-cutover --yes')), /--yes/)).toBe(true);
    expect(has(contractViolations('paths/x/x.ps1', ps('$a = Read-Host "go?"')), /Read-Host/)).toBe(true);
    expect(has(contractViolations('paths/x/x.sh', '#!/usr/bin/env bash\necho hi\n'), /atk_init/)).toBe(true);
  });
  it('mutating commands outside atk_run / Invoke-AtkStep', () => {
    expect(has(contractViolations('paths/x/x.sh', sh('aws ec2 stop-instances --instance-ids "$iid"')), /outside atk_run/)).toBe(true);
    expect(has(contractViolations('paths/x/x.sh', sh('gcloud compute instances delete "$n" \\\n  --zone "$z"')), /outside atk_run/)).toBe(true);
    expect(contractViolations('paths/x/x.sh', sh('atk_run aws ec2 stop-instances --instance-ids "$iid"'))).toEqual([]);
    expect(contractViolations('paths/x/x.sh', sh('aws ec2 describe-instances --instance-ids "$iid"'))).toEqual([]);
    expect(has(contractViolations('paths/x/x.ps1', ps('Stop-AzVM -Name $n -Force')), /outside Invoke-AtkStep/)).toBe(true);
    expect(contractViolations('paths/x/x.ps1', ps("Invoke-AtkStep 'stop' {\n  Stop-AzVM -Name $n -Force\n}\nGet-AzVM -Name $n"))).toEqual([]);
  });
  it('a script without a rollback verb', () => {
    const text = sh(':').replace(/verb_rollback\(\) \{\n  local id="\$1"\n  :\n\}\n/, '');
    expect(has(contractViolations('paths/x/x.sh', text), /no rollback verb/)).toBe(true);
  });
  it('literal credentials', () => {
    for (const leak of ['AKIAIOSFODNN7EXAMPLE', '-----BEGIN RSA PRIVATE KEY-----', 'curl -d "password=hunter22"', '{"SecretString":"hunter22"}', "api_key = 'abc123'"]) {
      expect(has(contractViolations('README.md', leak), /credential/)).toBe(true);
    }
    expect(contractViolations('README.md', 'export PASSWORD="$(atk_secret PASSWORD)"; SecretString="$v"')).toEqual([]);
  });
  it('footprints: a home or drive path, a temp literal, "Generated by", a date in a script', () => {
    expect(has(contractViolations('README.md', 'see /home/bob/kit'), /footprint/)).toBe(true);
    expect(has(contractViolations('README.md', 'at C:\\Users\\bob\\kit'), /footprint/)).toBe(true);
    expect(has(contractViolations('README.md', 'cp x /tmp/x1'), /footprint/)).toBe(true);
    expect(has(contractViolations('README.md', 'Generated by the toolkit'), /footprint/)).toBe(true);
    expect(has(contractViolations('paths/x/x.sh', sh('# built 2026-09-26\n:')), /date literal/)).toBe(true);
  });
});

describe('syntax', () => {
  it('bash -n passes on every .sh', { skip: !BASH && 'bash 4.4+ is not installed' }, () => {
    const bad: string[] = [];
    for (const [p, t] of scripts(/\.sh$/)) {
      const r = run('bash', ['-n'], {}, t);
      if (r.status !== 0) bad.push(`${p}: ${r.stderr}`);
    }
    expect(bad).toEqual([]);
  });
  it('the PowerShell parser accepts every .ps1 and .psm1', { skip: !PWSH && 'pwsh is not installed' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'atk-ps-'));
    try {
      const files = scripts(/\.(ps1|psm1)$/);
      files.forEach(([, t], i) => writeFileSync(join(dir, `f${i}${files[i]![0].endsWith('.psm1') ? '.psm1' : '.ps1'}`), t));
      const r = run('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
        `$bad = @(); foreach ($f in Get-ChildItem -LiteralPath '${dir}' -File) { $t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e); foreach ($x in $e) { $bad += "$($f.Name):$($x.Extent.StartLineNumber): $($x.Message)" } }; $bad -join [char]10`]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(files.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Run time
// ---------------------------------------------------------------------------

interface Ev { readonly item: string | null; readonly step: string; readonly outcome: string; readonly dryRun: boolean; readonly path: string; readonly detail?: string; readonly data?: Record<string, unknown> }

function project(): { root: string; exec: string; events: () => Ev[]; raw: () => string; logs: () => string; done: () => void } {
  const root = fwd(mkdtempSync(join(tmpdir(), 'atk-kit-')));
  for (const [p, t] of Object.entries(FILES)) {
    const f = join(root, 'migration/execute', p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, t);
  }
  const eventsFile = join(root, 'status/events.jsonl');
  const raw = (): string => (existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8') : '');
  return {
    root,
    exec: `${root}/migration/execute`,
    raw,
    events: () => raw().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev),
    logs: () => (existsSync(join(root, 'status/logs')) ? readdirSync(join(root, 'status/logs')).map((f) => readFileSync(join(root, 'status/logs', f), 'utf8')).join('\n') : ''),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Every item gets exactly one started and one terminal event per verb run. */
function startedAndTerminal(events: readonly Ev[], step: string): Map<string, string[]> {
  const per = new Map<string, string[]>();
  for (const e of events.filter((x) => x.step === step)) per.set(String(e.item), [...(per.get(String(e.item)) ?? []), e.outcome]);
  return per;
}

describe('bash at run time', { skip: !BASH && 'bash 4.4+ is not installed' }, () => {
  it('dry run changes nothing and says so; a run changes things once', () => {
    const k = project();
    try {
      const mgn = `${k.exec}/paths/mgn/mgn.sh`;
      expect(run('bash', [mgn, 'prepare', '--wave', '1', '--item', 'web01', '--dry-run']).status).toBe(0);
      expect(existsSync(`${k.root}/status/made-atk-planc0ff-1-web01-prepare`)).toBe(false);
      expect(k.events().every((e) => e.dryRun)).toBe(true);
      expect(k.logs()).toContain('dry-run, not run: touch');
      expect(run('bash', [mgn, 'prepare', '--wave', '1', '--item', 'web01']).status).toBe(0);
      expect(existsSync(`${k.root}/status/made-atk-planc0ff-1-web01-prepare`)).toBe(true);
      expect(run('bash', [mgn, 'prepare', '--wave', '1', '--item', 'WEB01']).status).toBe(0);
      const last = k.events().slice(-2);
      expect(last.map((e) => e.outcome)).toEqual(['started', 'skipped']);
      for (const e of k.events()) expect(statusEventProblems(e)).toEqual([]);
    } finally {
      k.done();
    }
  });
  it('every verb writes a started and a terminal event per item, and rollback exists', () => {
    const k = project();
    try {
      for (const verb of VERBS) {
        const r = run('bash', [`${k.exec}/paths/core/core.sh`, verb, '--wave', '1', '--dry-run']);
        expect(r.status).toBe(0);
        const per = startedAndTerminal(k.events(), VERB_STEP[verb]);
        expect(per.get('w:old01')?.slice(-2)).toEqual(['started', 'skipped']);
      }
      expect(k.events().filter((e) => e.step === 'rollback').length).toBe(2);
      expect(k.events().filter((e) => e.data?.['poll'] === true).length).toBe(2);
    } finally {
      k.done();
    }
  });
  it('exit codes: 2 usage, 3 missing credential, 10 some items failed, and pending paths fail honestly', () => {
    const k = project();
    try {
      const mgn = `${k.exec}/paths/mgn/mgn.sh`;
      expect(run('bash', [mgn, 'jump']).status).toBe(2);
      expect(run('bash', [mgn, 'prepare', '--wave', 'x']).status).toBe(2);
      expect(run('bash', [mgn, 'prepare', '--item', 'nobody']).status).toBe(2);
      expect(run('bash', [mgn, 'prepare', '--yes']).status).toBe(2);
      expect(run('bash', [mgn, 'test', '--wave', '1'], { NEED_TOKEN: '1' }).status).toBe(3);
      const r = run('bash', [mgn, 'cutover', '--wave', '1']);
      expect(r.status).toBe(10);
      const per = startedAndTerminal(k.events(), 'cutover');
      expect(per.get('w:fail01')).toEqual(['started', 'failed']);
      expect(per.get('w:web01')).toEqual(['started', 'succeeded']);
      const pending = run('bash', [`${k.exec}/paths/pending/pending.sh`, 'prepare', '--wave', '1']);
      expect(pending.status).toBe(10);
      expect(k.events().find((e) => e.path === 'gcp-m2vm' && e.outcome === 'failed')?.detail).toContain('WP-11c');
    } finally {
      k.done();
    }
  });
  it('credentials: from the environment or the vault hook, redacted; a group-readable file is refused', () => {
    const k = project();
    try {
      const mgn = `${k.exec}/paths/mgn/mgn.sh`;
      expect(run('bash', [mgn, 'test', '--wave', '1', '--item', 'web01'], { NEED_TOKEN: '1', DEMO_TOKEN: 'hunter22-from-env' }).status).toBe(0);
      expect(run('bash', [mgn, 'commit', '--wave', '1', '--item', 'web01'], { NEED_TOKEN: '1', ATK_VAULT_CMD: 'printf vault-%s-value' }).status).toBe(0);
      const secretFile = `${k.root}/token`;
      writeFileSync(secretFile, 'from-a-file-123');
      run('chmod', ['644', secretFile]);
      expect(run('bash', [mgn, 'finalize', '--wave', '1', '--item', 'web01'], { NEED_TOKEN: '1', DEMO_TOKEN_FILE: secretFile }).status).toBe(3);
      const logs = k.logs();
      expect(logs).toContain('signing in with ***');
      expect(logs.includes('hunter22-from-env')).toBe(false);
      expect(logs.includes('vault-DEMO_TOKEN-value')).toBe(false);
      expect(k.raw().includes('hunter22')).toBe(false);
    } finally {
      k.done();
    }
  });
  it('gates: closed exits 4, a go file for this plan opens it, an override records its reason', () => {
    const k = project();
    try {
      const g = `${k.root}/gate.sh`;
      writeFileSync(g, 'set -Eeuo pipefail\nsource "$(dirname "$0")/migration/execute/lib/atk.sh"\natk_init_tool orchestrator "$@"\natk_gate G2\necho through\n');
      expect(run('bash', [g, '--wave', '1']).status).toBe(4);
      const o = run('bash', [g, '--wave', '1', '--gate-override', 'CAB approved']);
      expect(o.stdout.trim()).toBe('through');
      expect(k.events().some((e) => e.step === 'gate' && e.data?.['override'] === true && (e.detail ?? '').includes('CAB approved'))).toBe(true);
      mkdirSync(`${k.root}/status/gates`, { recursive: true });
      writeFileSync(`${k.root}/status/gates/wave-1-G2.json`, JSON.stringify({ kind: 'archtoolkit.migration-gate', v: 1, planId: 'another-plan', wave: 1, gate: 'G2', decision: 'go' }));
      expect(run('bash', [g, '--wave', '1']).status).toBe(4);
      writeFileSync(`${k.root}/status/gates/wave-1-go.json`, JSON.stringify({ kind: 'archtoolkit.migration-gate', v: 1, planId: 'plan-c0ffee42', wave: 1, gate: 'G2', decision: 'go' }));
      expect(run('bash', [g, '--wave', '1']).stdout.trim()).toBe('through');
    } finally {
      k.done();
    }
  });
  it('events carry no user, host or path', () => {
    const k = project();
    try {
      run('bash', [`${k.exec}/paths/mgn/mgn.sh`, 'cutover', '--wave', '1']);
      const text = k.raw();
      expect(text.length).toBeGreaterThan(0);
      expect(text.includes(k.root)).toBe(false);
      for (const v of [env['USERNAME'], env['USER'], env['COMPUTERNAME'], env['HOSTNAME']]) {
        if (v && v.length > 3) expect(text.toLowerCase().includes(v.toLowerCase())).toBe(false);
      }
    } finally {
      k.done();
    }
  });
  it('controller-check.sh names what is missing and exits 3', () => {
    const k = project();
    try {
      const r = run('bash', [`${k.exec}/controller-check.sh`]);
      expect([0, 3]).toContain(r.status);
      const last = k.events().slice(-1)[0]!;
      expect(last.step).toBe('precheck');
      expect(last.outcome).toBe(r.status === 0 ? 'succeeded' : 'failed');
    } finally {
      k.done();
    }
  });
});

describe('PowerShell at run time', { skip: !PWSH && 'pwsh is not installed' }, () => {
  const ps = (k: { exec: string }, args: readonly string[], extra: Record<string, string> = {}): Run =>
    run('pwsh', ['-NoProfile', '-NonInteractive', '-File', `${k.exec}/paths/hcx/hcx.ps1`, ...args], extra);
  it('dry run changes nothing; a run changes once; events match the schema', () => {
    const k = project();
    try {
      expect(ps(k, ['prepare', '-Wave', '1', '-DryRun']).status).toBe(0);
      expect(existsSync(`${k.root}/status/made-atk-planc0ff-1-hv01-ps`)).toBe(false);
      expect(ps(k, ['prepare', '-Wave', '1']).status).toBe(0);
      expect(existsSync(`${k.root}/status/made-atk-planc0ff-1-hv01-ps`)).toBe(true);
      expect(ps(k, ['prepare', '-Wave', '1']).status).toBe(0);
      const ev = k.events();
      expect(ev.map((e) => `${e.outcome}${e.dryRun ? '*' : ''}`)).toEqual(['started*', 'succeeded*', 'started', 'succeeded', 'started', 'skipped']);
      for (const e of ev) expect(statusEventProblems(e)).toEqual([]);
    } finally {
      k.done();
    }
  });
  it('exit codes and credentials', () => {
    const k = project();
    try {
      expect(ps(k, ['jump']).status).toBe(2);
      expect(ps(k, ['rollback', '-Wave', '1'], { NEED_TOKEN: '1' }).status).toBe(3);
      expect(ps(k, ['rollback', '-Wave', '1'], { NEED_TOKEN: '1', DEMO_TOKEN: 'ps-hunter22' }).status).toBe(0);
      expect(k.logs()).toContain('signing in with ***');
      expect(k.logs().includes('ps-hunter22')).toBe(false);
      expect(startedAndTerminal(k.events(), 'rollback').get('w:hv01')).toEqual(['started', 'failed', 'started', 'succeeded']);
    } finally {
      k.done();
    }
  });
  it('bash runs it through atk_pwsh with the same run and options', { skip: !BASH && 'bash 4.4+ is not installed' }, () => {
    const k = project();
    try {
      const o = `${k.root}/orch.sh`;
      writeFileSync(o, 'set -Eeuo pipefail\nsource "$(dirname "$0")/migration/execute/lib/atk.sh"\natk_init_tool orchestrator "$@"\natk_event - precheck started\natk_pwsh paths/hcx/hcx.ps1 status --wave 1 --item hv01 --dry-run\n');
      expect(run('bash', [o, '--wave', '1']).status).toBe(0);
      const ev = k.events();
      expect(new Set(ev.map((e) => (e as unknown as { runId: string }).runId)).size).toBe(1);
      expect(ev.slice(-1)[0]!.dryRun).toBe(true);
      expect(ev.slice(-1)[0]!.data?.['poll']).toBe(true);
    } finally {
      k.done();
    }
  });
});
