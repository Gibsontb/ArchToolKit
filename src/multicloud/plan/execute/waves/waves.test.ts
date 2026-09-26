/**
 * WP-12: the wave kit (addendum A.7).
 *
 *   - statically: every generated file keeps the A.6.2 contract
 *     (`contractViolations`); cutover.sh has the fourteen steps in order
 *     after the lock and G2; dns.sh writes A and AAAA for all providers and
 *     reverts the recorded values; Infoblox, F5 and Avi credentials go to
 *     curl on stdin only; decommission.sh checks G4 and the target backup
 *     before any delete; rollback.sh after commit needs a reason and prints
 *     the data-loss statement; gate names match the tracker's; the
 *     landing-zone gate, the T-minus timeline and the runbook seeds;
 *   - `bash -n` on every script (skipped without bash 4.4);
 *   - at run time, in a scratch project with stubbed tools (skipped without
 *     bash 4.4 and jq): G2 enforced (exit 4) and its override recorded, the
 *     landing-zone gate, a dry run that changes nothing, a real cutover with
 *     the steps in order, DNS switched and reverted, rollback after commit,
 *     decommission gated, Infoblox credentials only on curl's stdin.
 */

import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from '../../../../testing/expect.ts';
import { defaultExecution, defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../../options.ts';
import type { ExecutionSettings, Plan, PlanDecision, Tracker, WavePlan, Workload } from '../../types.ts';
import { gateFile, gateRecord } from '../../track/gates.ts';
import { contractViolations, GATE_ALIAS, VERBS } from '../contract.ts';
import { executionKit } from '../kit.ts';
import { shScript } from '../lib-sh.ts';
import { createRegistry, type PathGenerator } from '../registry.ts';
import { DATA_LOSS, SOURCE_ADAPTERS, waveSpecs } from './common.ts';
import { CUTOVER_STEPS } from './cutover.ts';
import { dnsRecords, renderRecordsCsv } from './dns.ts';
import { evaluateLandingZoneGate, GATE_SLUG, gateFilePath, gateFileProblems, LANDING_ZONE_GATE_FILE } from './gates.ts';
import { waveKit, type WaveKit } from './index.ts';
import { lbMembers } from './lb.ts';
import { STAGE_CHECKS } from './precheck.ts';
import { addDays, CUTOVER, PRE_MIGRATION, ROLLBACK, waveTimeline } from './timeline.ts';

// ---------------------------------------------------------------------------
// A plan: two replicated servers on AWS (production), a retired one (dev)
// ---------------------------------------------------------------------------

const w = (name: string, over: Partial<Workload> = {}): Workload => ({
  id: itemId('workload', name), name, app: 'shop', env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64], criticality: 'tier1',
  rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
} as Workload);
const WS = [
  w('web01', { facts: { ipAddresses: ['10.0.0.11', '2001:db8:1::11'], services: ['nginx', 'sshd', 'shop-api'] } as Workload['facts'] }),
  w('web02', { facts: { ipAddresses: ['10.0.0.12'], services: ['nginx'] } as Workload['facts'] }),
  w('old01', { env: 'dev' }),
];
const EXECUTION: ExecutionSettings = {
  ...defaultExecution(),
  dnsZones: [{ zone: 'corp.example.com', provider: 'route53', zoneId: 'Z123', private: true }],
  lbs: [{ app: 'shop', kind: 'f5-bigip', pool: '/Common/shop_pool', port: 443 }],
};
const PLAN = {
  kind: 'archtoolkit.multicloud-plan', version: 1, id: 'plan-abc12345', name: 'x', savedAt: '', workloads: WS, databases: [], apps: [], edges: [],
  requirements: defaultRequirements(), designOverrides: {}, waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] }, execution: EXECUTION,
} as unknown as Plan;
const dec = (id: string, platform: string | undefined, method: string) => ({
  id, kind: 'workload', disposition: method === 'none' ? 'retire' : 'rehost', method, options: [],
  ...(platform ? { chosen: { platform, score: 1, hits: [] } } : {}), pinned: false, margin: 0, findings: [],
});
const DECISION = {
  engineVersion: 't', platforms: [], subsetScores: [], findings: [],
  items: Object.fromEntries([dec(WS[0]!.id, 'aws', 'replicate'), dec(WS[1]!.id, 'aws', 'replicate'), dec(WS[2]!.id, undefined, 'none')].map((x) => [x.id, x])),
} as unknown as PlanDecision;
const WAVES = {
  settings: PLAN.waveSettings, findings: [],
  groups: [{ id: 'g1', items: WS.map((x) => x.id), why: '', wave: 1, method: 'replicate' }],
  waves: [{ n: 1, groups: ['g1'], start: '2026-10-12', kind: 'app' }],
} as unknown as WavePlan;

/** A stand-in for WP-11c's MGN script: its cutover reports the target's id and addresses. */
const verbBody = (verb: string): string => {
  switch (verb) {
    case 'status': return 'atk_done "$id" "" "in sync" inSync=true lagSeconds=3';
    case 'cutover': return [
      'n=$(( $(printf \'%s\' "$id" | cksum | cut -d" " -f1) % 200 + 1 ))',
      'if [[ -f "$ATK_STATUS/cut-$(atk_name "$id")" ]]; then atk_skip "$id" "already cut over" "" targetId="i-$n" targetIpv4="10.9.0.$n" targetIpv6="2001:db8:9::$n"; fi',
      'atk_run touch "$ATK_STATUS/cut-$(atk_name "$id")"',
      'atk_done "$id" cut-over "launched" targetId="i-$n" targetIpv4="10.9.0.$n" targetIpv6="2001:db8:9::$n"',
    ].join('\n');
    case 'test-cleanup': return 'atk_done "$id" "" "cleaned" passed="${ATK_TEST_PASSED:-unset}"';
    default: return `atk_done "$id" "" "${verb} done"`;
  }
};
const MGN: PathGenerator = {
  id: 'mgn-stub', owner: 'WP-11c', paths: ['aws-mgn'], needs: [], entry: () => 'paths/aws-mgn/mgn.sh',
  files: () => ({ 'paths/aws-mgn/mgn.sh': shScript({ file: 'paths/aws-mgn/mgn.sh', paths: ['aws-mgn'], summary: 'stub', verbs: Object.fromEntries(VERBS.map((v) => [v, verbBody(v)])) as never }) }),
};
const KIT = executionKit(PLAN, DECISION, { platforms: [], findings: [] }, WAVES, undefined, { registry: createRegistry([MGN]) });
const CTX = { plan: PLAN, manifest: KIT.manifest, settings: EXECUTION, waves: WAVES };
const WK: WaveKit = waveKit(CTX);
const F = (p: string): string => {
  const t = WK.files[p];
  if (t === undefined) throw new Error(`no ${p}`);
  return t;
};

// ---------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------

describe('wave kit: files and the contract', () => {
  it('writes every wave file, the DNS, load-balancer and Ansible files and right-sizing', () => {
    for (const f of ['precheck.sh', 'replicate.sh', 'test.sh', 'cutover.sh', 'validate.sh', 'commit.sh', 'rollback.sh', 'decommission.sh', 'gates.md', 'runbook.md', 'wave.json']) {
      expect(Object.keys(WK.files)).toContain(`waves/wave-1/${f}`);
    }
    for (const f of ['dns/dns.sh', 'dns/records.csv', 'lb/lb.sh', 'lb/members.csv', 'ansible/freeze.yml', 'ansible/unfreeze.yml', 'ansible/baseline.yml', 'ansible/validate.yml', 'ansible/identity.yml', 'ansible/windows-dns.yml', 'rightsize-after.sh']) {
      expect(Object.keys(WK.files)).toContain(f);
    }
  });
  it('executionKit carries the wave kit (kit.ts wiring): the same files, its needs and no contract errors', () => {
    for (const [p, text] of Object.entries(WK.files)) expect(KIT.files[p]).toBe(text);
    expect(KIT.needs.some((n) => n.kind === 'ansible-collection' && n.name === 'microsoft.ad')).toBe(true);
    expect(KIT.findings.filter((f) => f.code === 'exec.kit.contract' || f.code === 'exec.kit.file-clash')).toEqual([]);
  });
  it('every file passes contractViolations', () => {
    const all: string[] = [];
    for (const [p, t] of Object.entries(WK.files)) all.push(...contractViolations(p, t));
    expect(all).toEqual([]);
  });
  it('applies by default: no script turns dry-run on, asks, or takes --yes', () => {
    for (const [p, t] of Object.entries(WK.files)) {
      if (!p.endsWith('.sh')) continue;
      expect(/ATK_DRY_RUN=1\b/.test(t)).toBe(false);
      expect(/\s--yes\b/.test(t)).toBe(false);
      expect(t).toContain('atk_init_tool');
    }
  });
  it('is reproducible and carries no footprint', () => {
    const again = waveKit(CTX);
    expect(again.files).toEqual(WK.files);
    expect(Object.values(WK.files).some((t) => /Generated (by|on)|[A-Za-z]:\\Users|\/home\//.test(t))).toBe(false);
  });
  it('reads the wave facts: production, criticality, keep and hypercare days', () => {
    const [wave] = waveSpecs(CTX);
    expect(wave!.production).toBe(true);
    expect(wave!.items.find((i) => i.item.name === 'web01')!.keepDays).toBe(21);
    expect(wave!.items.find((i) => i.item.name === 'web01')!.hypercareDays).toBe(10);
    expect(wave!.platforms).toEqual(['aws']);
  });
});

describe('cutover.sh', () => {
  const text = F('waves/wave-1/cutover.sh');
  it('runs the 14 steps in order, each through wave_step (events), after the lock and G2', () => {
    const steps = [...text.matchAll(/^wave_step (\d+) ([a-z-]+) /gm)].map((m) => Number(m[1]));
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const ids = [...text.matchAll(/^wave_step \d+ ([a-z-]+) /gm)].map((m) => m[1]);
    expect(ids).toEqual(CUTOVER_STEPS.filter((s) => s.no >= 1 && s.no <= 13).map((s) => s.step));
    expect(text).toContain('step 14, report');
    expect(text.indexOf('wave_lock\n')).toBeLessThan(text.indexOf('atk_gate G2'));
    expect(text.indexOf('atk_gate G2')).toBeLessThan(text.indexOf('wave_step 1 precheck'));
    expect(text).toContain('atk_lock "wave-$WAVE_N"');
  });
  it('uses the manifest script column for the path verbs and atk_pwsh for PowerShell', () => {
    expect(text).toContain('script="${ATK_SCRIPT[$2]:-}"');
    expect(text).toContain('atk_pwsh "$script"');
  });
  it('prints the rollback line on a failed item and stops unless --continue-on-item-failure', () => {
    expect(text).toContain('--continue-on-item-failure');
    expect(text).toContain('waves/wave-$WAVE_N/rollback.sh');
    expect(text).toContain('exit 10');
  });
  it('the G2 file is the one the tracker exports (wave-<n>-go.json)', () => {
    expect(gateFilePath(1, 'G2')).toBe('gates/wave-1-go.json');
    for (const g of ['G1', 'G2', 'G3', 'G4', 'G5'] as const) expect(GATE_ALIAS[g]).toBe(GATE_SLUG[g]);
  });
});

describe('dns.sh and records.csv', () => {
  const dns = F('dns/dns.sh');
  it('has read and write functions for every provider (A, AAAA and CNAME)', () => {
    for (const p of ['route53', 'azure', 'google', 'oci', 'windows', 'bind', 'infoblox']) {
      expect(dns).toContain(`${p}_get()`);
      expect(dns).toContain(`${p}_put()`);
      expect(dns).toContain(`${p}_del()`);
    }
    expect(dns).toContain('A) key=targetIpv4 ;; AAAA) key=targetIpv6 ;; CNAME) key=targetFqdn');
  });
  it('writes an A and an AAAA row per server, with the old addresses and @target', () => {
    const { rows } = dnsRecords(CTX);
    const web01 = rows.filter((r) => r.fqdn === 'web01.corp.example.com');
    expect(web01.map((r) => r.type)).toEqual(['A', 'AAAA']);
    expect(web01[0]!.old).toEqual(['10.0.0.11']);
    expect(web01[1]!.old).toEqual(['2001:db8:1::11']);
    expect(web01[0]!.new).toEqual(['@target']);
    expect(rows.some((r) => r.fqdn.startsWith('old01'))).toBe(false);
    const csv = renderRecordsCsv(rows).split('\n');
    expect(csv[0]).toBe('fqdn,type,old,new,ttl,provider,zone,private,item,zone_id,view');
    expect(csv).toContain(`web01.corp.example.com,A,10.0.0.11,@target,300,route53,corp.example.com,true,${WS[0]!.id},Z123,`);
  });
  it('records the current values before a switch, once, and revert restores exactly those', () => {
    expect(dns).toContain('rec="$(dns_state_get "$ROW_KEY")"');
    expect(dns).toContain('DNS_STATE="$ATK_STATUS/dns/${ATK_WAVE:-all}.json"');
    expect(dns).toContain('row_revert()');
    expect(dns).toContain('removed (it did not exist before the switch)');
  });
  it('sends the Infoblox credentials to curl on stdin only (curl --config -)', () => {
    expect(dns).toContain('ib_config GET "$1" | curl --config -');
    expect(dns).toContain('ib_config "$@" | atk_run curl --config -');
    expect(dns).toContain('atk_secret_to IB_PASS INFOBLOX_PASSWORD');
    for (const t of [dns, F('lb/lb.sh')]) {
      const curls = [...t.matchAll(/\bcurl\b[^\n]*/g)].map((m) => m[0]).filter((l) => !l.startsWith('curl in a config'));
      for (const l of curls) expect(/\s(-u|--user|-H|--header)\s/.test(l)).toBe(false);
      expect(/curl\s+(-u|--user)\b/.test(t)).toBe(false);
    }
  });
});

describe('lb.sh and members.csv', () => {
  it('one member row per server of an app with a load balancer, not for retired servers', () => {
    const { rows } = lbMembers(CTX);
    expect(rows.map((r) => r.item).sort()).toEqual([WS[0]!.id, WS[1]!.id].sort());
    expect(rows[0]!.kind).toBe('f5-bigip');
  });
  it('drains, switches and reverts for every kind', () => {
    const lb = F('lb/lb.sh');
    for (const k of ['aws-elbv2', 'azure-lb', 'gcp-neg', 'oci-lb', 'f5-bigip', 'avi']) {
      for (const v of ['drain', 'enable', 'add', 'del']) expect(lb).toContain(`${k}_${v}()`);
    }
    expect(lb).toContain('{"session":"user-disabled"}');
  });
});

describe('decommission.sh, commit.sh and rollback.sh', () => {
  it('decommission checks G4, then the target backup, before any delete', () => {
    const t = F('waves/wave-1/decommission.sh');
    const body = t.slice(t.indexOf('# G4 before anything'));
    const gate = body.indexOf('atk_gate G4');
    const backups = body.indexOf('wave_step 1 precheck "target backups"');
    const finalize = body.indexOf('wave_step 2 finalize');
    const del = body.indexOf('wave_step 3 decommission');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(backups);
    expect(backups).toBeLessThan(finalize);
    expect(finalize).toBeLessThan(del);
    expect(t).toContain('aws backup list-recovery-points-by-resource');
    expect(t).toContain('oci bv boot-volume-backup list');
  });
  it('commit needs G3', () => {
    const t = F('waves/wave-1/commit.sh');
    expect(t.indexOf('atk_gate G3')).toBeLessThan(t.indexOf('wave_step 1 commit'));
  });
  it('rollback after commit needs a reason and prints the data-loss statement first', () => {
    const t = F('waves/wave-1/rollback.sh');
    expect(t).toContain('--after-commit needs a reason');
    expect(t).toContain('roll back with --after-commit');
    expect(t.indexOf("printf 'DATA LOSS")).toBeLessThan(t.indexOf('wave_step 1 dns-switch'));
    expect(t).toContain(DATA_LOSS['aws-mgn']!.slice(0, 40));
    expect(t).toContain('rehearsal=true');
  });
});

describe('gates, the landing-zone gate, timeline and runbooks', () => {
  const tracker: Tracker = {
    kind: 'archtoolkit.migration-tracker', version: 1, planId: PLAN.id, savedAt: '', items: {}, events: [], gates: [], signoffs: [],
    raid: { risks: [], assumptions: [], issues: [], decisions: [] }, notices: [], crs: [], decommissions: [], licences: [],
  };
  it('the tracker\'s gate file passes the gate schema check', () => {
    const f = gateFile(tracker, gateRecord(1, 'G2', 'go', 'migration-lead', '2026-10-11T08:00:00Z', []));
    expect(f.path).toBe('gates/wave-1-go.json');
    expect(gateFileProblems(JSON.parse(f.text))).toEqual([]);
    expect(gateFileProblems({ kind: 'x' }).length).toBeGreaterThan(0);
  });
  it('production waves wait for the landing zone: F01 needs the landing zones generated', () => {
    const waves = waveSpecs(CTX);
    const off = evaluateLandingZoneGate({ plan: PLAN, waves, tracker });
    expect(off.find((c) => c.id === 'lz.F01')!.met).toBe(false);
    const on = evaluateLandingZoneGate({ plan: { ...PLAN, execution: { ...EXECUTION, landingZones: { aws: 'generated' } } } as Plan, waves, tracker, attest: { F03: true } });
    expect(on.find((c) => c.id === 'lz.F01')!.met).toBe(true);
    expect(on.find((c) => c.id === 'lz.F03')!.met).toBe(true);
    expect(on).toHaveLength(14);
    expect(F('waves/wave-1/precheck.sh')).toContain(LANDING_ZONE_GATE_FILE);
    expect(STAGE_CHECKS.replicate).toContain('landing-zone-gate');
  });
  it('the T-minus timeline is dated from the wave start, with the hypercare in business days', () => {
    const [wave] = waveSpecs(CTX);
    const tl = waveTimeline(wave!);
    expect(tl.find((r) => r.id === 'aws-gate-2')!.date).toBe(addDays('2026-10-12', -28));
    expect(tl.find((r) => r.id === 'aws-gate-2')!.date).toBe('2026-09-14');
    expect(tl.find((r) => r.id === 'aws-gate-6')!.label).toBe('T-1');
    expect(tl.find((r) => r.id === 'aws-gate-9')!.label).toBe('T+10 (business)');
    expect(tl.find((r) => r.id === 'aws-gate-9')!.date).toBe('2026-10-26');
    expect(tl.some((r) => r.id === 'landing-zone')).toBe(true);
    expect(tl.map((r) => r.offset)).toEqual([...tl.map((r) => r.offset)].sort((a, b) => a - b));
  });
  it('the runbook is seeded from the AWS pre-migration, cutover and rollback templates', () => {
    expect(PRE_MIGRATION).toHaveLength(15);
    expect(CUTOVER).toHaveLength(13);
    expect(ROLLBACK).toHaveLength(10);
    const md = F('waves/wave-1/runbook.md');
    for (const id of ['P15', 'C13', 'R10', 'Milestone 4: testing complete', 'MGN: launch cutover instances']) expect(md).toContain(id);
    expect(F('waves/wave-1/gates.md')).toContain('status/gates/wave-1-go.json');
  });
  it('knows an adapter for every source platform', () => {
    expect(SOURCE_ADAPTERS.vsphere.file).toBe('source/vsphere.ps1');
    expect(SOURCE_ADAPTERS.mainframe.automated).toBe(false);
  });
});

describe('the Ansible plays', () => {
  it('wrap the validate role and write the archtoolkit.validation report', () => {
    const v = F('ansible/validate.yml');
    expect(v).toContain('ansible.builtin.include_role');
    expect(v).toContain('name: validate');
    expect(v).toContain("'kind': 'archtoolkit.validation'");
    expect(v).toContain('reports/validation-{{ inventory_hostname }}.json');
  });
  it('freeze, identity and Windows DNS use the committed modules and vault variables only', () => {
    expect(F('ansible/freeze.yml')).toContain('ansible.windows.win_service');
    expect(F('ansible/freeze.yml')).toContain('{{ vault_mysql_root_password }}');
    expect(F('ansible/identity.yml')).toContain('microsoft.ad.computer');
    expect(F('ansible/windows-dns.yml')).toContain('ansible.windows.win_dns_record');
  });
});

// ---------------------------------------------------------------------------
// bash -n and a run against stubbed tools
// ---------------------------------------------------------------------------

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
interface Run { readonly status: number; readonly out: string }
function run(cmd: string, args: readonly string[], extra: Record<string, string> = {}): Run {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !k.startsWith('ATK_') && !k.startsWith('INFOBLOX') && !k.startsWith('F5_')) merged[k] = v;
  Object.assign(merged, extra);
  try {
    return { status: 0, out: execFileSync(cmd, args, { encoding: 'utf8', env: merged, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    const x = e as { status?: number | null; stdout?: string; stderr?: string };
    return { status: x.status ?? 1, out: `${x.stdout ?? ''}${x.stderr ?? ''}` };
  }
}
const BASH = ((): boolean => {
  const r = run('bash', ['-c', 'if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then echo ok; fi']);
  return r.status === 0 && r.out.trim() === 'ok';
})();
const JQ = BASH && run('bash', ['-c', 'command -v jq']).status === 0;
const fwd = (p: string): string => p.replace(/\\/g, '/');

describe('bash -n', { skip: !BASH && 'bash 4.4 is not installed' }, () => {
  it('parses every wave-kit script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atk-wp12-n-'));
    try {
      const bad: string[] = [];
      for (const [p, t] of Object.entries(WK.files)) {
        if (!p.endsWith('.sh')) continue;
        const f = join(dir, p.replace(/\//g, '_'));
        writeFileSync(f, t);
        const r = run('bash', ['-n', fwd(f)]);
        if (r.status !== 0) bad.push(`${p}: ${r.out}`);
      }
      expect(bad).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const STUBS: Readonly<Record<string, string>> = {
  // jq.exe on Windows prints CRLF; the kit targets a Linux controller, so the test strips the CR (a no-op on Linux).
  jq: `#!/usr/bin/env bash
set -o pipefail
"$REAL_JQ" "$@" | tr -d '\\r'
`,
  aws: `#!/usr/bin/env bash
printf 'aws %s\\n' "$*" >> "$STUB_LOG"
st="$STUB_STATE/r53.json"; [ -f "$st" ] || echo '{}' > "$st"
arg() { local want="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
case "$1 $2" in
  "route53 list-resource-record-sets")
    n="$(arg --start-record-name "$@")"; t="$(arg --start-record-type "$@")"
    jq --arg k "$n|$t" --arg n "$n" --arg t "$t" '{ResourceRecordSets: (if .[$k] then [{Name: $n, Type: $t, TTL: .[$k].ttl, ResourceRecords: (.[$k].values | map({Value: .}))}] else [] end)}' "$st" ;;
  "route53 change-resource-record-sets")
    body="$(cat)"
    jq --argjson b "$body" 'reduce $b.Changes[] as $c (.; ($c.ResourceRecordSet.Name + "|" + $c.ResourceRecordSet.Type) as $k | if $c.Action == "DELETE" then del(.[$k]) else .[$k] = {ttl: $c.ResourceRecordSet.TTL, values: [$c.ResourceRecordSet.ResourceRecords[].Value]} end)' "$st" > "$st.new" && mv "$st.new" "$st"
    echo "/change/C1" ;;
  "route53 get-change") echo INSYNC ;;
  "ec2 describe-instances") echo running ;;
  "sts get-caller-identity") echo 123456789012 ;;
  "backup list-recovery-points-by-resource") echo 1 ;;
  *) echo '{}' ;;
esac
`,
  curl: `#!/usr/bin/env bash
printf 'curl argv: %s\\n' "$*" >> "$STUB_LOG"
cfg="$(cat)"
printf '%s\\n' "$cfg" | grep -q '^user = ' && printf 'curl had a user line on stdin\\n' >> "$STUB_LOG"
url="$(printf '%s\\n' "$cfg" | sed -n 's/^url = "\\(.*\\)"$/\\1/p')"
req="$(printf '%s\\n' "$cfg" | sed -n 's/^request = "\\(.*\\)"$/\\1/p')"
d="$STUB_STATE/f5"; mkdir -p "$d"
case "$url" in
  */mgmt/tm/ltm/pool/*/members/*)
    m="\${url##*/members/}"; f="$d/$(printf '%s' "$m" | tr '/:~' '___')"
    case "$req" in
      GET) [ -f "$f" ] && cat "$f" || exit 22 ;;
      PATCH) data="$(printf '%s\\n' "$cfg" | sed -n 's/^data = "\\(.*\\)"$/\\1/p' | sed 's/\\\\"/"/g')"; jq -c --argjson p "$data" '. + $p' "$f" > "$f.n" && mv "$f.n" "$f"; cat "$f" ;;
      DELETE) rm -f "$f"; echo '{}' ;;
    esac ;;
  */mgmt/tm/ltm/pool/*/members)
    data="$(printf '%s\\n' "$cfg" | sed -n 's/^data = "\\(.*\\)"$/\\1/p' | sed 's/\\\\"/"/g')"
    name="$(jq -r .name <<< "$data")"; jq -c '. + {session: "monitor-enabled"}' <<< "$data" > "$d/$(printf '~Common~%s' "$name" | tr '/:~' '___')"; echo '{}' ;;
  */wapi/*/record:a*) echo '[{"_ref":"record:a/ZG5z:web01.corp.example.com/default","ipv4addr":"10.0.0.11","ttl":300,"use_ttl":true}]' ;;
  *) echo '[]' ;;
esac
`,
  'ansible-playbook': `#!/usr/bin/env bash
printf 'ansible-playbook %s\\n' "$*" >> "$STUB_LOG"
play=""; limit=""; phase=cutover; root=""; status=""; kit=""
while [ $# -gt 0 ]; do
  case "$1" in
    --limit) limit="$2"; shift 2 ;;
    -e) case "$2" in validate_phase=*) phase="\${2#*=}" ;; atk_root=*) root="\${2#*=}" ;; atk_status=*) status="\${2#*=}" ;; atk_kit=*) kit="\${2#*=}" ;; esac; shift 2 ;;
    *.yml) play="$1"; shift ;;
    *) shift ;;
  esac
done
names() { if [[ "$limit" == wave_* ]]; then jq -r '.items[] | select(.kind == "workload" and .path != "retire") | .name' "$kit/manifest/items.json"; else tr ',' '\\n' <<< "$limit"; fi; }
item() { jq -r --arg n "$1" '.items[] | select(.name == $n) | .id' "$kit/manifest/items.json"; }
case "$play" in
  */baseline.yml) mkdir -p "$status/baseline"; for n in $(names); do id="$(item "$n")"; printf '{"item":"%s"}' "$id" > "$status/baseline/\${id//[^A-Za-z0-9._-]/_}.json"; done ;;
  */validate.yml) mkdir -p "$root/reports"; plan="$(jq -r .planId "$kit/manifest/items.json")"; for n in $(names); do jq -n --arg id "$(item "$n")" --arg n "$n" --arg p "$phase" --arg plan "$plan" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{kind: "archtoolkit.validation", v: 1, planId: $plan, item: $id, host: $n, phase: $p, at: $at, passed: true, checks: [], warnings: []}' > "$root/reports/validation-$n.json"; done ;;
esac
exit 0
`,
  terraform: `#!/usr/bin/env bash
printf 'terraform %s\\n' "$*" >> "$STUB_LOG"
case "$*" in *"output -json landing_zone"*) echo '{"network_ids":{"a":"vpc-1"},"subnet_ids":{"a":"subnet-1"}}' ;; esac
exit 0
`,
  // controller-check.sh asks for the wave kit's Ansible collections.
  'ansible-galaxy': `#!/usr/bin/env bash
if [ "$1 $2" = 'collection list' ]; then printf '%s 1.0.0\n' "$3"; fi
exit 0
`,
  ansible: `#!/usr/bin/env bash
printf 'ansible %s\\n' "$*" >> "$STUB_LOG"; exit 0
`,
  pwsh: `#!/usr/bin/env bash
printf 'pwsh %s\\n' "$*" >> "$STUB_LOG"
while [ "$1" != -File ]; do shift; done; script="$2"; verb="$3"; shift 3
item=""; step=manual; path=orchestrator; dry=false; wave=null
while [ $# -gt 0 ]; do case "$1" in -Item) item="$2"; shift 2 ;; -Step) step="$2"; shift 2 ;; -Path) path="$2"; shift 2 ;; -Wave) wave="$2"; shift 2 ;; -DryRun) dry=true; shift ;; *) shift ;; esac; done
kit="$(cd "$(dirname "$script")/.." && pwd)"
name="$(jq -r --arg i "$item" '.items[] | select(.id == $i) | .name' "$kit/manifest/items.json")"
if [ "$verb" = state ]; then printf '%s\\tpoweredOn\\n' "$name"; exit 0; fi
printf '%s %s %s\\n' "$verb" "$item" "$dry" >> "$STUB_STATE/adapter.log"
exit 0
`,
};

describe('a wave run against stubbed tools', { skip: (!BASH && 'bash 4.4 is not installed') || (!JQ && 'jq is not installed') }, () => {
  const root = mkdtempSync(join(tmpdir(), 'atk-wp12-run-'));
  const kit = join(root, 'proj', 'migration', 'execute');
  const status = join(root, 'proj', 'status');
  const state = join(root, 'state');
  const stub = join(root, 'stub');
  for (const [p, t] of Object.entries(KIT.files)) {
    const f = join(kit, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, t);
    if (p.endsWith('.sh')) chmodSync(f, 0o755);
  }
  for (const [n, t] of Object.entries(STUBS)) {
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, n), t);
    chmodSync(join(stub, n), 0o755);
  }
  for (const d of [join(state, 'f5'), join(status, 'gates'), join(root, 'proj', 'terraform', 'aws'), join(root, 'proj', 'ansible', 'inventory'), join(kit, 'source')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, 'proj', 'ansible', 'site.yml'), '');
  writeFileSync(join(kit, 'source', 'vsphere.ps1'), '');
  writeFileSync(join(state, 'r53.json'), JSON.stringify({
    'web01.corp.example.com.|A': { ttl: 3600, values: ['10.0.0.11'] }, 'web01.corp.example.com.|AAAA': { ttl: 3600, values: ['2001:db8:1::11'] },
    'web02.corp.example.com.|A': { ttl: 3600, values: ['10.0.0.12'] },
  }));
  for (const m of ['10.0.0.11', '10.0.0.12']) writeFileSync(join(state, 'f5', `_Common_${m}_443`), JSON.stringify({ name: `${m}:443`, address: m, session: 'monitor-enabled' }));
  const log = join(root, 'stub.log');
  writeFileSync(log, '');
  const realJq = run('bash', ['-c', 'command -v jq']).out.trim();
  const vars = { REAL_JQ: realJq, STUB_STATE: fwd(state), STUB_LOG: fwd(log), F5_HOST: 'f5.test', F5_USER: 'admin', F5_PASSWORD: 'S3cretF5pw!', INFOBLOX_HOST: 'ib.test', INFOBLOX_USER: 'ibadmin', INFOBLOX_PASSWORD: 'IbPa55word' };
  const sh = (script: string, ...args: string[]): Run =>
    run('bash', ['-c', 'p="$1"; if command -v cygpath > /dev/null 2>&1; then p="$(cygpath -u "$1")"; fi; export PATH="$p:$PATH"; shift; exec "$@" 2>&1', 'x', fwd(stub), fwd(join(kit, script)), ...args], vars);
  const gate = (g: string, slug: string): void => writeFileSync(join(status, 'gates', `wave-1-${slug}.json`), JSON.stringify({
    kind: 'archtoolkit.migration-gate', v: 1, planId: PLAN.id, wave: 1, gate: g, decision: 'go', at: '2026-10-12T08:00:00Z',
    criteria: [{ id: 'g4.target-backup', auto: true, met: true, detail: 'x' }], by: 'migration-lead', blockers: [],
  }));
  const events = (): Record<string, unknown>[] => (existsSync(join(status, 'events.jsonl')) ? readFileSync(join(status, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  const r53 = (): Record<string, { ttl: number; values: string[] }> => JSON.parse(readFileSync(join(state, 'r53.json'), 'utf8')) as Record<string, { ttl: number; values: string[] }>;
  const data = (e: Record<string, unknown>): Record<string, unknown> => (e.data ?? {}) as Record<string, unknown>;

  it('lowers the TTL at T-48 h and captures the baseline', () => {
    expect(sh('dns/dns.sh', 'check', '--wave', '1').status).toBe(5);
    expect(sh('dns/dns.sh', 'ttl', '--set', '300', '--wave', '1').status).toBe(0);
    expect(r53()['web01.corp.example.com.|A']!.ttl).toBe(300);
    expect(sh('dns/dns.sh', 'check', '--wave', '1').status).toBe(0);
    expect(sh('waves/wave-1/validate.sh', '--baseline').status).toBe(0);
  });
  it('enforces G2 (exit 4) and nothing moves', () => {
    expect(sh('waves/wave-1/cutover.sh').status).toBe(4);
    expect(events().some((e) => e.step === 'gate' && e.outcome === 'failed')).toBe(true);
    expect(events().some((e) => e.step === 'cutover' && e.item !== null)).toBe(false);
  });
  it('holds a production wave at the landing-zone gate (exit 5)', () => {
    gate('G2', 'go');
    expect(sh('waves/wave-1/cutover.sh').status).toBe(5);
    expect(events().some((e) => data(e).check === 'landing-zone-gate' && e.outcome === 'failed')).toBe(true);
    writeFileSync(join(status, 'gates', 'programme-landing-zone.json'), JSON.stringify({ kind: 'archtoolkit.landing-zone-gate', v: 1, planId: PLAN.id, wave: 'programme', gate: 'landing-zone', decision: 'go', at: '2026-10-01T08:00:00Z', criteria: [], by: 'migration-lead' }));
  });
  it('a dry run changes nothing', () => {
    const before = readFileSync(join(state, 'r53.json'), 'utf8');
    const r = sh('waves/wave-1/cutover.sh', '--dry-run');
    expect(r.status).toBe(0);
    expect(readFileSync(join(state, 'r53.json'), 'utf8')).toBe(before);
    expect(existsSync(join(status, 'dns', '1.json'))).toBe(false);
    expect(events().filter((e) => e.step === 'cutover' && e.item !== null).every((e) => e.dryRun === true)).toBe(true);
    expect(JSON.parse(readFileSync(join(state, 'f5', '_Common_10.0.0.11_443'), 'utf8')).session).toBe('monitor-enabled');
  });
  it('a real run through --gate-override: the reason recorded, the steps in order, A and AAAA switched, the old values recorded, the load balancer switched', () => {
    rmSync(join(status, 'gates', 'wave-1-go.json'));
    expect(sh('waves/wave-1/cutover.sh', '--gate-override', 'CAB approved by phone').status).toBe(0);
    expect(events().some((e) => e.step === 'gate' && data(e).override === true && String(e.detail).includes('CAB approved by phone'))).toBe(true);
    const summary = events().filter((e) => e.step === 'cutover' && data(e).summary === true && e.dryRun === false).pop()!;
    const mine = events().filter((e) => e.runId === summary.runId && e.item === null && data(e).stepNo !== undefined);
    expect(mine.filter((e) => e.outcome === 'started').map((e) => data(e).stepNo)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const now = r53();
    expect(now['web01.corp.example.com.|A']!.values[0]!.startsWith('10.9.0.')).toBe(true);
    expect(now['web01.corp.example.com.|AAAA']!.values[0]!.startsWith('2001:db8:9::')).toBe(true);
    const rec = JSON.parse(readFileSync(join(status, 'dns', '1.json'), 'utf8')) as Record<string, { existed: boolean; values: string[] }>;
    expect(rec['web01.corp.example.com|A|route53']!.values).toEqual(['10.0.0.11']);
    expect(rec['web02.corp.example.com|AAAA|route53']!.existed).toBe(false);
    expect(existsSync(join(state, 'f5', '_Common_10.0.0.11_443'))).toBe(false);
  });
  it('dns.sh revert restores exactly the recorded values', () => {
    expect(sh('dns/dns.sh', 'revert', '--wave', '1').status).toBe(0);
    const now = r53();
    expect(now['web01.corp.example.com.|A']!.values).toEqual(['10.0.0.11']);
    expect(now['web01.corp.example.com.|AAAA']!.values).toEqual(['2001:db8:1::11']);
    expect(now['web02.corp.example.com.|AAAA']).toBeUndefined();
  });
  it('after commit, rollback needs --after-commit "<reason>" and prints the data-loss statement', () => {
    gate('G3', 'commit');
    expect(sh('waves/wave-1/commit.sh').status).toBe(0);
    expect(sh('waves/wave-1/rollback.sh').status).toBe(2);
    const r = sh('waves/wave-1/rollback.sh', '--after-commit', 'payments failing');
    expect(r.status).toBe(0);
    expect(r.out).toContain('DATA LOSS (web01, aws-mgn)');
    expect(events().some((e) => data(e).afterCommit === true && data(e).reason === 'payments failing' && typeof data(e).dataLoss === 'string')).toBe(true);
  });
  it('decommission needs G4 and confirms the target backup before any delete', () => {
    writeFileSync(join(state, 'adapter.log'), '');
    expect(sh('waves/wave-1/decommission.sh').status).toBe(4);
    expect(readFileSync(join(state, 'adapter.log'), 'utf8')).not.toContain('delete');
    gate('G4', 'decommission');
    expect(sh('waves/wave-1/decommission.sh').status).toBe(0);
    const all = events();
    const run = all.filter((e) => e.step === 'gate' && e.detail === 'G4 is open').pop()!.runId;
    const mine = all.filter((e) => e.runId === run);
    const backup = mine.findIndex((e) => data(e).check === 'target-backup' && e.outcome === 'succeeded');
    const decom = mine.findIndex((e) => e.step === 'decommission' && e.item !== null);
    expect(backup).toBeGreaterThan(-1);
    expect(backup).toBeLessThan(decom);
    expect(readFileSync(join(state, 'adapter.log'), 'utf8')).toContain('delete');
  });
  it('sends the Infoblox credentials on curl\'s stdin only', () => {
    const csv = join(kit, 'dns', 'records.csv');
    writeFileSync(csv, readFileSync(csv, 'utf8').replace(/,route53,/g, ',infoblox,'));
    writeFileSync(log, '');
    expect(sh('dns/dns.sh', 'check', '--wave', '1', '--item', 'web01').status).toBe(0);
    const lines = readFileSync(log, 'utf8').split('\n');
    const argv = lines.filter((l) => l.startsWith('curl argv'));
    expect(argv.length).toBeGreaterThan(0);
    for (const l of argv) expect(l).toBe('curl argv: --config -');
    expect(lines).toContain('curl had a user line on stdin');
    const logs = join(status, 'logs');
    expect(execFileSync('bash', ['-c', `grep -rl IbPa55word "${fwd(logs)}" || true`], { encoding: 'utf8' }).trim()).toBe('');
    rmSync(root, { recursive: true, force: true });
  });
});
