/**
 * VCF Operations for Logs 9.1, Workload Automation and Security Posture:
 * the build-out checks.
 *
 * Every log management blueprint applies what it writes (KB 450054 ops-li
 * exchange, --dry-run opt-in), every generated shell script parses, every
 * select and toggle builds, and the traps each one exists to catch fire.
 */

import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from '../testing/expect.ts';
import { defaultValues } from '../kit/blueprint.ts';
import { hasErrors } from '../core/findings.ts';
import { VCF_OPS_LOGS_91, VCF_OPS_OPERATE } from './blueprints/vcf-ops-operate.ts';
import { conditionRows, rowsOf } from './blueprints/vcf-logs91-api.ts';

// Straight from the file rather than the index, so this runs while other kits are mid-edit.
const AREA = [...VCF_OPS_LOGS_91, ...VCF_OPS_OPERATE];
const automationFor = (id: string) => AREA.find((candidate) => candidate.id === id);
// Every blueprint in the file: the log management set, and the operate set (health, findings,
// real-time, vSAN, audit, Workload Automation, Security Posture).
const MINE = AREA.map((candidate) => candidate.id);

const LOG_APPLY = ['vcflog91_masking', 'vcflog91_filtering', 'vcflog91_forwarding', 'vcflog91_partitions', 'vcflog91_agents', 'vcflog91_alert_query', 'vcflog91_sources', 'vcflog91_access', 'vcflog91_archive_import', 'vcflog91_extracted_fields'];
const EXPECTED = [...LOG_APPLY, 'vcflog91_upgrade', 'vcfops_workload_automation', 'vcfops_security_posture', 'vcfops_audit'];

type Values = Record<string, string | number | boolean | undefined>;

function blueprint(id: string) {
  const found = automationFor(id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function build(id: string, overrides: Values = {}) {
  const bp = blueprint(id);
  return bp.build({ ...defaultValues(bp), ...overrides }, id);
}

function codes(id: string, overrides: Values = {}): string[] {
  return (build(id, overrides).findings ?? []).map((finding) => finding.code);
}

function variants(id: string): Values[] {
  const bp = blueprint(id);
  const base = defaultValues(bp) as Values;
  const out: Values[] = [{ ...base }];
  for (const input of bp.inputs) {
    if (input.control === 'select') for (const option of input.options ?? []) out.push({ ...base, [input.id]: option.value });
    if (input.control === 'toggle') out.push({ ...base, [input.id]: !base[input.id] });
    if (input.control === 'checklist') out.push({ ...base, [input.id]: (input.options ?? []).map((option) => option.value).join(',') });
  }
  return out;
}

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

describe('logs 9.1 build-out: every blueprint is there and builds', () => {
  it('has every blueprint of the area', () => {
    for (const id of EXPECTED) expect(`${id}: ${automationFor(id) !== undefined}`).toBe(`${id}: true`);
    expect(automationFor('vcfops_workload_automation')?.platform).toBe('vcf-operations');
    expect(automationFor('vcflog91_sources')?.platform).toBe('vcf-operations-logs');
  });

  it('builds clean from its defaults, with a README', () => {
    for (const id of MINE) {
      const out = build(id);
      const errors = (out.findings ?? []).filter((finding) => finding.severity === 'error').map((finding) => finding.code);
      expect(`${id}: ${errors.join(', ')}`).toBe(`${id}: `);
      expect(Boolean(out.files['README.md'])).toBe(true);
    }
  });

  it('builds with every select option, toggle and checklist', () => {
    const problems: string[] = [];
    for (const id of MINE) {
      for (const values of variants(id)) {
        try {
          const made = blueprint(id).automation(values, id);
          if (made.undo.length === 0 || made.told.length === 0 || !made.scope.what.trim()) problems.push(`${id}: contract gap for ${JSON.stringify(values)}`);
        } catch (failure) {
          problems.push(`${id}: threw ${String(failure)} for ${JSON.stringify(values)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('writes shell scripts that parse, for every option', { skip: !hasBash }, () => {
    const broken: string[] = [];
    for (const id of MINE) {
      for (const values of variants(id)) {
        for (const [file, body] of Object.entries(blueprint(id).automation(values, id).files)) {
          if (!file.endsWith('.sh')) continue;
          const result = spawnSync('bash', ['-n'], { input: body, encoding: 'utf8' });
          if (result.status !== 0) broken.push(`${id} → ${file}: ${result.stderr.trim().split('\n')[0]}`);
        }
      }
    }
    expect([...new Set(broken)]).toEqual([]);
  });
});

describe('logs 9.1 build-out: it applies, and says so', () => {
  it('gives every log management blueprint an apply script that applies by default', () => {
    for (const id of LOG_APPLY) {
      const files = build(id).files;
      const apply = files['apply.sh'];
      expect(`${id}: ${apply ? 'apply.sh' : 'none'}`).toBe(`${id}: apply.sh`);
      expect(apply!.includes('--dry-run')).toBe(true);
      expect(/DRY_RUN=0|EXECUTE=1/.test(apply!)).toBe(true);
    }
  });

  it('reaches log management with the KB 450054 ops-li exchange, from a private header file', () => {
    for (const id of LOG_APPLY.filter((candidate) => candidate !== 'vcflog91_agents')) {
      const apply = build(id).files['apply.sh']!;
      expect(apply.includes('/suite-api/api/auth/token/exchange')).toBe(true);
      expect(apply.includes('"serviceKeys":["ops-li"]')).toBe(true);
      expect(apply.includes('-H "@${LI_HDR}"')).toBe(true);
      expect(/Bearer \$\{?JWT/.test(apply.split('\n').filter((line) => line.includes('curl')).join('\n'))).toBe(false);
    }
    expect(build('vcflog91_agents').files['apply.sh']!.includes('"serviceKeys":["ops-li"]')).toBe(true);
    expect(build('vcflog91_agents', { os: 'kubernetes' }).files['apply.sh']!.includes('kubectl apply')).toBe(true);
  });

  it('no longer writes specs to type in: no "_note" and no "not an API payload"', () => {
    for (const id of LOG_APPLY) {
      const text = Object.values(build(id).files).join('\n');
      expect(/_note|Not an API payload/.test(text)).toBe(false);
    }
  });

  it('runs apply.sh --dry-run offline: local tests pass, nothing signs in', { skip: !hasBash || spawnSync('python3', ['-c', 'pass']).status !== 0 || spawnSync('jq', ['--version']).status !== 0 }, () => {
    const failures: string[] = [];
    for (const id of LOG_APPLY) {
      const dir = mkdtempSync(join(tmpdir(), 'logs91-')).replace(/\\/g, '/');
      for (const [file, body] of Object.entries(build(id).files)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), body);
      }
      const env: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
      const result = spawnSync('bash', [`${dir}/apply.sh`, '--dry-run'], { encoding: 'utf8', env });
      if (result.status !== 0 || !/Dry run: nothing was changed/.test(result.stdout)) failures.push(`${id}: exit ${result.status} ${result.stdout.slice(-300)} ${result.stderr.slice(-300)}`);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(failures).toEqual([]);
  });

  it('runs the local test before it applies anything', () => {
    expect(build('vcflog91_masking').files['apply.sh']!.includes('test-masking.sh')).toBe(true);
    expect(build('vcflog91_filtering').files['apply.sh']!.includes('test-filter.sh')).toBe(true);
    expect(build('vcflog91_extracted_fields').files['apply.sh']!.includes('test-fields.sh')).toBe(true);
    expect(build('vcflog91_alert_query').files['apply.sh']!.includes('test-extraction.sh')).toBe(true);
    expect(build('vcflog91_forwarding').files['apply.sh']!.includes('check-destination.sh')).toBe(true);
  });

  it('keeps names and footprints out of the output', () => {
    const bad = /\bAria\b|vRealize|vROps|Service Broker|\bESXi\b|ArchToolKit|Generated by/;
    const offenders: string[] = [];
    for (const id of MINE) {
      for (const values of variants(id)) {
        for (const [file, body] of Object.entries(blueprint(id).automation(values, id).files)) {
          const hit = body.match(bad);
          if (hit) offenders.push(`${id} → ${file}: ${hit[0]}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('writes no credential and puts no token on a command line, for every option', () => {
    // The same two rules automation.test.ts holds every blueprint to.
    const assignsLiteral = /\b(password|passwd|secret|api[_-]?key|token|credential)\w*\s*[:=]+\s*["'][^"'$%{<@]/i;
    const onArgv = /-H "?(Authorization|x-hm-authorization|vmware-api-session-id): *[A-Za-z]* *\$/;
    const problems: string[] = [];
    for (const id of MINE) {
      for (const values of variants(id)) {
        for (const [file, body] of Object.entries(blueprint(id).automation(values, id).files)) {
          body.split('\n').forEach((line, index) => {
            if (assignsLiteral.test(line)) problems.push(`${id} → ${file}:${index + 1} literal credential`);
            if (file.endsWith('.sh') && onArgv.test(line)) problems.push(`${id} → ${file}:${index + 1} token on argv`);
          });
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('offers no content pack blueprint (End of General Support in 9.1)', () => {
    for (const id of MINE) expect(/content.?pack/i.test(blueprint(id).label)).toBe(false);
  });
});

describe('logs 9.1 build-out: the options each one takes', () => {
  it('agents: a parser per file, custom regex parsers, tags, whitelist and blacklist, TLS and protocol', () => {
    const ini = build('vcflog91_agents').files['liagent.ini']!;
    expect(ini.includes('parser=clf')).toBe(true);
    expect(ini.includes('[parser|orders-regex]')).toBe(true);
    expect(ini.includes('base_parser=regex')).toBe(true);
    expect(ini.includes('whitelist=level == "ERROR"')).toBe(true);
    expect(ini.includes('ssl=yes')).toBe(true);
    expect(ini.includes('proto=cfapi')).toBe(true);
    expect(ini.includes('reconnect=30')).toBe(true);
    expect(build('vcflog91_agents', { protocol: 'syslog', port: 6514 }).files['liagent.ini']!.includes('proto=syslog')).toBe(true);
    expect(codes('vcflog91_agents', { files: 'x | /var/log | *.log | nosuch | ' }).includes('vcflog91.agent.parser')).toBe(true);
    expect(codes('vcflog91_agents', { parsers: 'p | regex | (\\S+) (.*)' }).includes('vcflog91.agent.regex-groups')).toBe(true);
    expect(codes('vcflog91_agents', { ssl: false }).includes('vcflog91.agent.no-tls')).toBe(true);
    const win = build('vcflog91_agents', { os: 'windows' }).files;
    expect(win['liagent.ini']!.includes('[winlog|security]')).toBe(true);
    expect(Boolean(win['Check-Agent.ps1'])).toBe(true);
  });

  it('agents on Kubernetes: Fluent Bit with namespaces, labels and output', () => {
    const files = build('vcflog91_agents', { os: 'kubernetes' }).files;
    const conf = files['fluent-bit.conf']!;
    expect(conf.includes("$kubernetes['namespace_name'] ^(orders|payments)$")).toBe(true);
    expect(conf.includes("$kubernetes['labels']['tier'] ^frontend$")).toBe(true);
    expect(conf.includes('tls.verify          On')).toBe(true);
    expect(files['fluent-bit-configmap.yaml']!.includes('kind: ConfigMap')).toBe(true);
    expect(build('vcflog91_agents', { os: 'kubernetes', k8s_output: 'syslog_tcp' }).files['fluent-bit.conf']!.includes('Mode                tcp')).toBe(true);
  });

  it('alert query: filters (AND), aggregation, group-by, policy and notification, end to end', () => {
    const files = build('vcflog91_alert_query', { aggregation: 'UNIQUE_COUNT' }).files;
    const query = JSON.parse(files['queryconfig.json']!);
    expect(query.queryFilters.logQueryFiltersOperator).toBe('AND');
    expect(query.queryFilters.logQueryFilterConditions.length).toBe(2);
    expect(query.aggregation.function).toBe('UNIQUE_COUNT');
    expect(query.aggregation.field).toBe('order_id');
    expect(query.aggregation.groupBy).toEqual(['hostname']);
    const apply = files['apply.sh']!;
    for (const path of ['/suite-api/api/logs/queryconfigs', '/suite-api/api/symptomdefinitions', '/suite-api/api/alertdefinitions', '/suite-api/api/notifications/rules', 'merge-policy.sh']) {
      expect(`${path}: ${apply.includes(path)}`).toBe(`${path}: true`);
    }
    expect(Boolean(files['merge-policy.sh'])).toBe(true);
    expect(files['merge-policy.sh']!.includes('/suite-api/api/policies/import?forceImport=true')).toBe(true);
    expect(codes('vcflog91_alert_query', { aggregation: 'UNIQUE_COUNT', agg_field: '' }).includes('vcflog91.query.no-agg-field')).toBe(true);
    expect(codes('vcflog91_alert_query', { policy_name: '' }).includes('vcflog91.query.no-policy')).toBe(true);
    expect(codes('vcflog91_alert_query', { filters: 'appname | Equals | x' }).includes('vcflog91.query.bad-filter')).toBe(true);
    expect(Boolean(build('vcflog91_alert_query', { notify_plugin: '' }).files['notification-rule.json'])).toBe(false);
  });

  it('forwarding: TLS chain, workers, disk buffer, retry, tags and filter rows', () => {
    const files = build('vcflog91_forwarding').files;
    const rule = JSON.parse(files['forwarding-rule.json']!);
    expect(rule.workerCount).toBe(8);
    expect(rule.diskCacheSize).toBe(2000);
    expect(rule.retryIntervalSeconds).toBe(30);
    expect(rule.filters.length).toBe(3);
    expect(rule.filterOperator).toBe('OR');
    expect(rule.tags.site).toBe('dc1');
    expect(rule.enabled).toBe(true);
    expect(files['apply.sh']!.includes('--rawfile ca')).toBe(true);
    expect(files['apply.sh']!.includes('10 is the documented maximum')).toBe(true);
    expect(codes('vcflog91_forwarding', { disk_buffer_mb: 0 }).includes('vcflog91.fwd.no-buffer')).toBe(true);
    expect(codes('vcflog91_forwarding', { filters: '' }).includes('vcflog91.fwd.unfiltered')).toBe(true);
    expect(JSON.parse(build('vcflog91_forwarding', { dest_kind: 'logs_instance' }).files['forwarding-rule.json']!).protocol).toBe('cfapi');
    expect(JSON.parse(build('vcflog91_forwarding', { host: '2001:db8::10' }).files['forwarding-rule.json']!).host).toBe('2001:db8::10');
  });

  it('partitions: the 9-partition limit, filter rows, roles, and archive keys only from the environment', () => {
    expect(codes('vcflog91_partitions', { extra_partitions: 10 }).includes('vcflog91.part.too-many')).toBe(true);
    expect(codes('vcflog91_partitions', { extra_partitions: 9 }).includes('vcflog91.part.too-many')).toBe(false);
    expect(codes('vcflog91_partitions', { partition_name: 'Audit & Logs' }).includes('vcflog91.part.reserved')).toBe(true);
    expect(codes('vcflog91_partitions', { archive: 'none' }).includes('vcflog91.part.short')).toBe(true);
    const files = build('vcflog91_partitions').files;
    expect(files['apply.sh']!.includes('9.1 allows 9 besides it')).toBe(true);
    expect(files['apply.sh']!.includes('S3_SECRET_KEY_FILE')).toBe(true);
    expect(files['apply.sh']!.includes('"$PRIVATE/external-storage.json"')).toBe(true);
    const partition = JSON.parse(files['partition.json']!);
    expect(partition.filters.length).toBe(4);
    expect(partition.roles).toEqual(['Security Auditor', 'Administrator']);
    expect(JSON.parse(files['external-storage.json']!).secretKey.startsWith('<')).toBe(true);
  });

  it('log sources: components, levels, and ESX pointed at log management with govc', () => {
    const files = build('vcflog91_sources').files;
    const config = JSON.parse(files['log-sources.json']!);
    expect(config.sources.find((s: { component: string }) => s.component === 'nsx').level).toBe('Warning');
    expect(config.sources.find((s: { component: string }) => s.component === 'vks').enabled).toBe(false);
    expect(files['esx-syslog.sh']!.includes('Syslog.global.logHost')).toBe(true);
    expect(files['esx-syslog.sh']!.includes("'ssl://logmgmt.example.com:6514'")).toBe(true);
    expect(build('vcflog91_sources', { ingest_host: '2001:db8::20' }).files['esx-syslog.sh']!.includes('ssl://[2001:db8::20]:6514')).toBe(true);
    expect(codes('vcflog91_sources', { components: '' }).includes('vcflog91.src.nothing')).toBe(true);
    expect(codes('vcflog91_sources', { components: 'esx,vcenter' }).includes('vcflog91.src.audit-off')).toBe(true);
    expect(codes('vcflog91_sources', { overrides: 'esx | Loud | ' }).includes('vcflog91.src.level')).toBe(true);
    expect(Boolean(build('vcflog91_sources', { components: 'vcenter' }).files['esx-syslog.sh'])).toBe(false);
  });

  it('access control, archive import and extracted fields', () => {
    expect(codes('vcflog91_access', { filters: '' }).includes('vcflog91.access.everything')).toBe(true);
    expect(JSON.parse(build('vcflog91_access').files['data-set.json']!).filters.length).toBe(2);
    expect(codes('vcflog91_archive_import', { start: '2025-12-31', end: '2025-10-01' }).includes('vcflog91.import.range')).toBe(true);
    expect(codes('vcflog91_archive_import', { start: '2025-01-01', end: '2025-12-31' }).includes('vcflog91.import.large')).toBe(true);
    expect(codes('vcflog91_archive_import', { target_partition: 'Audit & Logs' }).includes('vcflog91.import.default-partition')).toBe(true);
    const fields = build('vcflog91_extracted_fields').files;
    expect(Object.keys(fields).filter((file) => file.startsWith('fields/')).length).toBe(3);
    expect(codes('vcflog91_extracted_fields', { fields: 'x |  | \\d+ |  | ' }).includes('vcflog91.fields.no-context')).toBe(true);
    expect(codes('vcflog91_extracted_fields', { fields: 'a | k= | \\d+ | ms | \na | k= | \\d+ | ms | ' }).includes('vcflog91.fields.duplicate')).toBe(true);
  });

  it('extracted fields: the local test passes on the default samples', { skip: !hasBash || spawnSync('python3', ['-c', 'pass']).status !== 0 }, () => {
    // Run the generated test exactly as a user would, from a scratch folder.
    const files = build('vcflog91_extracted_fields').files;
    const script = [
      'set -e',
      'D=$(mktemp -d)',
      'mkdir -p "$D/fields"',
      ...Object.entries(files)
        .filter(([file]) => file.startsWith('fields/') || file === 'samples.txt' || file === 'test-fields.sh')
        .map(([file, body]) => `cat > "$D/${file}" <<'EOF_${file.replace(/\W/g, '_')}'\n${body}\nEOF_${file.replace(/\W/g, '_')}`),
      'bash "$D/test-fields.sh"',
    ].join('\n');
    // On stdin, not -c: Windows argument quoting rewrites backslashes before quotes.
    const result = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8' });
    expect(`${result.status} ${result.stdout}${result.stderr}`.startsWith('0 ')).toBe(true);
  });

  it('parses condition rows and rejects operators 9.1 does not offer', () => {
    expect(rowsOf('a | b\n# note\nc | d | e', 3)).toEqual([['a', 'b', ''], ['c', 'd', 'e']]);
    const parsed = conditionRows('appname | Contains | x\nhost | Is | y\ntext | Exists | ');
    expect(parsed.conditions.length).toBe(2);
    expect(parsed.bad.length).toBe(1);
  });
});

describe('Workload Automation and Security Posture', () => {
  it('workload automation: every setting goes into the policy, applied by export, merge, import', () => {
    const files = build('vcfops_workload_automation').files;
    const settings = JSON.parse(files['workload-automation.json']!).workloadAutomation;
    expect(settings.balanceLevel).toBe('MODERATE');
    expect(settings.clusterHeadroomPercent).toBe(20);
    expect(settings.storageBasedEviction).toBe(true);
    expect(settings.businessIntent).toEqual({ placement: 'HOST', tagCategories: ['License', 'Environment'] });
    expect(settings.schedule).toEqual({ recurrence: 'WEEKLY', dayOfWeek: 'SUNDAY', time: '02:00' });
    expect(settings.automate).toBe(true);
    const script = files['apply-workload-automation.sh']!;
    expect(script.includes('/suite-api/api/policies/export')).toBe(true);
    expect(script.includes('/suite-api/api/policies/import?forceImport=true')).toBe(true);
    expect(script.includes('--dry-run')).toBe(true);
    expect(JSON.parse(build('vcfops_workload_automation', { consolidate: true, consolidation_level: 'AGGRESSIVE' }).files['workload-automation.json']!).workloadAutomation.consolidationLevel).toBe('AGGRESSIVE');
    expect(JSON.parse(build('vcfops_workload_automation').files['workload-automation.json']!).workloadAutomation.consolidationLevel).toBe('OFF');
  });

  it('workload automation: the traps', () => {
    expect(codes('vcfops_workload_automation', { intent_categories: '' }).includes('vcfops.wla.no-categories')).toBe(true);
    expect(codes('vcfops_workload_automation', { policy_name: 'Default Policy' }).includes('vcfops.wla.default-policy')).toBe(true);
    expect(codes('vcfops_workload_automation', { balance: 'AGGRESSIVE', headroom_pct: 5 }).includes('vcfops.wla.churn')).toBe(true);
    expect(codes('vcfops_workload_automation', { schedule_time: '25:00' }).includes('vcfops.wla.time')).toBe(true);
    expect(hasErrors(build('vcfops_workload_automation', { scope_name: '' }).findings ?? [])).toBe(true);
  });

  it('security posture: the three 9.1 benchmarks, one or all, each with its own drift', () => {
    const options = blueprint('vcfops_security_posture').inputs.find((input) => input.id === 'benchmark')?.options?.map((option) => option.value) ?? [];
    expect(options).toEqual(['VCF 9.x Security Configuration Guide v1.0', 'PCI DSS v4.0.1 for VCF 9 v1.0', 'VCF 9 General Controls v1.0', 'ALL']);
    const all = build('vcfops_security_posture', { benchmark: 'ALL', source: 'csv' }).files;
    expect(all['crontab.txt']!.split('\n').filter((line) => line.includes('posture-drift.sh')).length).toBe(3);
    expect(all['posture-drift.sh']!.includes('POSTURE_BENCHMARK')).toBe(true);
    // Only the three 9.1 benchmarks are offered; the retired Compliance packs are named only in the README note that says so.
    const text = Object.entries(all).filter(([file]) => file !== 'README.md').map(([, body]) => body).join('\n');
    expect(/\bCIS\b|DISA STIG|HIPAA|ISO 27001/.test(text)).toBe(false);
  });
});
