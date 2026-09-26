/**
 * The execution kit's own plays (addendum A.6.2 `ansible/`, A.7.2 steps 3
 * and 11, A.7.4 step 5, A.7.5), run by the wave scripts with
 * `--limit wave_<n>_sources` / `wave_<n>` / `wave_<n>_test` (or item names)
 * against the project inventory, and never part of site.yml:
 *
 *   freeze.yml     stops the app services the manifest lists (protected OS,
 *                  agent and database services are left running) and sets the
 *                  wave's databases read-only (PostgreSQL, MySQL, SQL Server);
 *   unfreeze.yml   the reverse, for a rollback;
 *   baseline.yml   three samples of CPU, memory and disk latency, the
 *                  listening ports, the running services and the smoke-check
 *                  timings, to `status/baseline/<item>.json`;
 *   validate.yml   the wrapper around WP-7's `validate` role: the role's
 *                  checks, plus the app smoke checks (HTTP and TCP, from the
 *                  controller) and the comparison with the baseline, written
 *                  as `reports/validation-<host>.json`
 *                  (`archtoolkit.validation`, A.7.5);
 *   identity.yml   server identity after cutover (A.7.2 step 11): the AD
 *                  computer object and its OU, DNS client servers, AD CS
 *                  certificates (the cloud certificate services are operator
 *                  steps), the licence-task check and the time source; at
 *                  decommission, the computer objects of renamed servers.
 *
 * Each play finds its host's item in `manifest/items.json` by name (or the
 * host variable `atk_item_id`). The wave scripts pass `atk_kit`, `atk_root`,
 * `atk_status` and `atk_wave`. Credentials are vault variables only.
 *
 * Pure: no DOM, no file system.
 */

import { renderYaml, type YamlValue } from '../../../../ansible/yaml.ts';
import { CLOUD_PLATFORM } from '../../../../ansible/migration/roles/types.ts';

const LINUX = "ansible_facts.os_family != 'Windows'";
const WINDOWS = "ansible_facts.os_family == 'Windows'";

/** The play variables every kit play shares: the manifest and this host's item. */
const ITEM_VARS: Readonly<Record<string, YamlValue>> = {
  atk_manifest: "{{ lookup('ansible.builtin.file', atk_kit ~ '/manifest/items.json') | from_json }}",
  atk_host_short: "{{ inventory_hostname.split('.') | first | regex_replace('(?i)-test$', '') }}",
  atk_item: "{{ (atk_manifest['items'] | selectattr('id', 'equalto', atk_item_id) | list | first) if atk_item_id is defined else (atk_manifest['items'] | selectattr('kind', 'equalto', 'workload') | selectattr('name', 'match', '(?i)^' ~ (atk_host_short | regex_escape) ~ '$') | list | first | default({})) }}",
  atk_item_file: "{{ (atk_item.id | default(inventory_hostname)) | regex_replace('[^A-Za-z0-9._-]', '_') }}",
  atk_databases: "{{ atk_manifest['items'] | selectattr('kind', 'equalto', 'database') | selectattr('hosts', 'defined') | selectattr('hosts', 'contains', atk_item.id | default('')) | list }}",
  cloud_platform: CLOUD_PLATFORM,
};

const requireKit: YamlValue = {
  name: 'Check that the wave script passed the kit folder',
  'ansible.builtin.assert': {
    that: ['atk_kit is defined', 'atk_status is defined'],
    fail_msg: 'Run this play through the wave scripts (migration/execute/waves/wave-<n>/), which pass atk_kit and atk_status.',
    quiet: true,
  },
  run_once: true,
};

const noteItem: YamlValue = {
  name: 'Note hosts that are not in the manifest',
  'ansible.builtin.debug': { msg: '{{ inventory_hostname }} is in no manifest item: set the host variable atk_item_id to its item id.' },
  when: 'atk_item | length == 0',
};

// ---------------------------------------------------------------------------
// freeze.yml / unfreeze.yml
// ---------------------------------------------------------------------------

/** Services the freeze never stops: the OS, remote access, time, cloud and security agents, and databases (made read-only instead). */
export const FREEZE_PROTECTED = '(?i)^(sshd?|systemd.*|dbus.*|network.*|NetworkManager.*|chronyd?|ntpd?|rsyslog.*|syslog.*|auditd|crond?|atd|sssd|winbind|polkit.*|udev.*|getty.*|firewalld|WinRM|W32Time|EventLog|Dhcp|Dnscache|LanmanServer|LanmanWorkstation|RpcSs|RpcEptMapper|Netlogon|MpsSvc|WinDefend|Sense|BFE|CryptSvc|Schedule|TermService|.*agent.*|amazon-ssm.*|waagent|walinuxagent|google.*|oracle-cloud-agent.*|vmtoolsd|VMTools|open-vm-tools|csagent|falcon.*|CSFalcon.*|mdatp|mssql.*|MSSQL.*|SQLAgent.*|SQLBrowser|postgres.*|mysqld?|mariadb|oracle.*|OracleService.*|OracleOraDB.*)$';

const freezeVars: Readonly<Record<string, YamlValue>> = {
  ...ITEM_VARS,
  freeze_protected: FREEZE_PROTECTED,
  freeze_services: "{{ freeze_services_override if freeze_services_override is defined else (atk_item.services | default([]) | reject('match', freeze_protected) | list) }}",
  freeze_pg: "{{ atk_databases | selectattr('engine', 'equalto', 'postgres') | list }}",
  freeze_mysql: "{{ atk_databases | selectattr('engine', 'in', ['mysql', 'mariadb']) | list }}",
  freeze_mssql: "{{ atk_databases | selectattr('engine', 'equalto', 'sqlserver') | list }}",
};

function freezePlay(freeze: boolean): YamlValue {
  const state = freeze ? 'stopped' : 'started';
  const ro = freeze ? 'on' : 'off';
  return [{
    name: freeze ? 'Freeze the wave’s sources: stop the app services, databases read-only' : 'Unfreeze the sources after a rollback: services started, databases writable',
    hosts: 'all',
    gather_facts: true,
    vars: freezeVars,
    tasks: [
      requireKit,
      noteItem,
      {
        name: `${freeze ? 'Stop' : 'Start'} the app services (Linux)`,
        'ansible.builtin.service': { name: '{{ item }}', state },
        loop: '{{ freeze_services }}',
        become: true,
        when: [LINUX, 'freeze_services | length > 0'],
      },
      {
        name: `${freeze ? 'Stop' : 'Start'} the app services (Windows)`,
        'ansible.windows.win_service': freeze ? { name: '{{ item }}', state, force_dependent_services: true } : { name: '{{ item }}', state },
        loop: '{{ freeze_services }}',
        when: [WINDOWS, 'freeze_services | length > 0'],
      },
      {
        name: `Set PostgreSQL ${freeze ? 'read-only' : 'writable'} for new sessions`,
        'community.postgresql.postgresql_set': { name: 'default_transaction_read_only', value: ro },
        become: true,
        become_user: 'postgres',
        register: 'freeze_pg_set',
        when: [LINUX, 'freeze_pg | length > 0'],
      },
      {
        name: 'Reload PostgreSQL so the setting applies',
        'community.postgresql.postgresql_query': { query: 'SELECT pg_reload_conf()' },
        become: true,
        become_user: 'postgres',
        when: [LINUX, 'freeze_pg | length > 0', 'freeze_pg_set is changed'],
      },
      ...(freeze ? [{
        name: 'End the PostgreSQL sessions still writing (their transactions roll back)',
        'community.postgresql.postgresql_query': {
          query: "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND datname IS NOT NULL AND state <> 'idle'",
        },
        become: true,
        become_user: 'postgres',
        when: [LINUX, 'freeze_pg | length > 0', 'freeze_terminate_sessions | default(true) | bool'],
      } as YamlValue] : []),
      {
        name: `Set MySQL ${freeze ? 'read-only (super_read_only)' : 'writable'}`,
        'ansible.mysql.mysql_variables': { variable: freeze ? 'super_read_only' : 'read_only', value: freeze ? 'ON' : 'OFF', mode: 'global', login_user: 'root', login_password: '{{ vault_mysql_root_password }}' },
        when: [LINUX, 'freeze_mysql | length > 0'],
      },
      ...(freeze ? [] : [{
        name: 'Clear MySQL super_read_only',
        'ansible.mysql.mysql_variables': { variable: 'super_read_only', value: 'OFF', mode: 'global', login_user: 'root', login_password: '{{ vault_mysql_root_password }}' },
        when: [LINUX, 'freeze_mysql | length > 0'],
      } as YamlValue]),
      {
        name: `Set the SQL Server databases ${freeze ? 'read-only' : 'writable'}`,
        'lowlydba.sqlserver.nonquery': {
          sql_instance: '{{ freeze_mssql_instance | default(inventory_hostname) }}',
          database: 'master',
          nonquery: freeze
            ? "IF DATABASEPROPERTYEX(N'{{ item.name }}', 'Updateability') = 'READ_WRITE' ALTER DATABASE [{{ item.name }}] SET READ_ONLY WITH ROLLBACK IMMEDIATE"
            : "IF DATABASEPROPERTYEX(N'{{ item.name }}', 'Updateability') = 'READ_ONLY' ALTER DATABASE [{{ item.name }}] SET READ_WRITE WITH ROLLBACK IMMEDIATE",
        },
        loop: '{{ freeze_mssql }}',
        loop_control: { label: '{{ item.name }}' },
        when: [WINDOWS, 'freeze_mssql | length > 0'],
      },
    ],
  }];
}

export function renderFreezeYml(): string {
  return renderYaml(freezePlay(true), {
    header: 'freeze.yml: the cutover freeze on the wave\'s sources (cutover.sh step 3, --limit wave_<n>_sources).\nStops the services the manifest lists except the protected ones (freeze_protected; set freeze_services_override per host to choose),\nand sets the wave\'s PostgreSQL, MySQL and SQL Server databases read-only. Oracle is left to its switchover (Data Guard / ZDM).',
  });
}
export function renderUnfreezeYml(): string {
  return renderYaml(freezePlay(false), {
    header: 'unfreeze.yml: undoes freeze.yml on the sources after a rollback (rollback.sh step 5).',
  });
}

// ---------------------------------------------------------------------------
// Metrics and smoke checks (shared by baseline.yml and validate.yml)
// ---------------------------------------------------------------------------

/** The Windows metrics script (win_powershell) of baseline.yml and validate.yml. */
export const WIN_METRICS = [
  '$Ansible.Changed = $false',
  "$counters = '\\Processor(_Total)\\% Processor Time', '\\LogicalDisk(_Total)\\Avg. Disk sec/Transfer', '\\Memory\\Available MBytes'",
  '$samples = foreach ($i in 1..3) {',
  '  $v = (Get-Counter -Counter $counters -SampleInterval 5 -MaxSamples 1).CounterSamples',
  '  [ordered]@{ cpuPct = [math]::Round($v[0].CookedValue, 1); diskMs = [math]::Round($v[1].CookedValue * 1000, 2); memAvailMb = [int]$v[2].CookedValue }',
  '}',
  '$ports = @(Get-NetTCPConnection -State Listen | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique)',
  "$services = @(Get-Service | Where-Object Status -eq 'Running' | Select-Object -ExpandProperty Name | Sort-Object)",
  '$Ansible.Result = [ordered]@{ samples = @($samples); ports = $ports; services = $services }',
].join('\n');

/** Tasks that leave `atk_metrics` = {samples[], cpuPct, diskMs, memUsedMb, ports[], services[]}. */
const METRIC_TASKS: readonly YamlValue[] = [
  {
    name: 'Sample CPU use, three times five seconds apart (Linux)',
    'ansible.builtin.shell': "set -o pipefail\nvmstat 5 4 | tail -n 3 | awk '{ print 100 - $15 }'",
    args: { executable: '/bin/bash' },
    register: 'atk_vmstat',
    changed_when: false,
    check_mode: false,
    when: LINUX,
  },
  {
    name: 'Sample disk latency (Linux; needs sysstat)',
    'ansible.builtin.shell': "set -o pipefail\niostat -dx 5 2 | awk '/^Device/ { n++; for (i = 1; i <= NF; i++) h[i] = $i; next } n == 2 && NF > 3 { for (i = 1; i <= NF; i++) if (h[i] == \"await\" || h[i] == \"r_await\" || h[i] == \"w_await\") { s += $i; c++ } } END { if (c) printf \"%.2f\\n\", s / c }'",
    args: { executable: '/bin/bash' },
    register: 'atk_iostat',
    changed_when: false,
    failed_when: false,
    check_mode: false,
    when: LINUX,
  },
  {
    name: 'List the listening TCP ports (Linux)',
    'ansible.builtin.shell': "set -o pipefail\nss -Hltn | awk '{ n = split($4, a, \":\"); print a[n] }' | sort -un",
    args: { executable: '/bin/bash' },
    register: 'atk_ss',
    changed_when: false,
    check_mode: false,
    when: LINUX,
  },
  { name: 'Read the services (Linux)', 'ansible.builtin.service_facts': {}, when: LINUX },
  {
    name: 'Put the Linux metrics together',
    'ansible.builtin.set_fact': {
      atk_metrics: {
        samples: "{{ atk_vmstat.stdout_lines | map('float') | map('round', 1) | list }}",
        cpuPct: "{{ ((atk_vmstat.stdout_lines | map('float') | sum) / ([atk_vmstat.stdout_lines | length, 1] | max)) | round(1) }}",
        diskMs: "{{ (atk_iostat.stdout | default('') | trim | float) if (atk_iostat.stdout | default('') | trim | length > 0) else none }}",
        memUsedMb: '{{ ansible_facts.memory_mb.nocache.used | default(0) }}',
        ports: "{{ atk_ss.stdout_lines | map('int') | list }}",
        services: "{{ ansible_facts.services | dict2items | selectattr('value.state', 'equalto', 'running') | map(attribute='key') | list | sort }}",
      },
    },
    when: LINUX,
  },
  {
    name: 'Sample CPU, disk latency, memory, ports and services (Windows)',
    'ansible.windows.win_powershell': { script: WIN_METRICS },
    register: 'atk_winmetrics',
    check_mode: false,
    when: WINDOWS,
  },
  {
    name: 'Put the Windows metrics together',
    'ansible.builtin.set_fact': {
      atk_metrics: {
        samples: "{{ atk_winmetrics.result.samples | map(attribute='cpuPct') | list }}",
        cpuPct: "{{ ((atk_winmetrics.result.samples | map(attribute='cpuPct') | sum) / ([atk_winmetrics.result.samples | length, 1] | max)) | round(1) }}",
        diskMs: "{{ ((atk_winmetrics.result.samples | map(attribute='diskMs') | sum) / ([atk_winmetrics.result.samples | length, 1] | max)) | round(2) }}",
        memUsedMb: "{{ (ansible_facts.memtotal_mb | default(0) | int) - ((atk_winmetrics.result.samples | map(attribute='memAvailMb') | sum) / ([atk_winmetrics.result.samples | length, 1] | max)) | int }}",
        ports: '{{ atk_winmetrics.result.ports }}',
        services: '{{ atk_winmetrics.result.services }}',
      },
    },
    when: WINDOWS,
  },
];

/** Tasks that leave `atk_smoke` = [{id, kind, target, passed, observed, expected, ms}] for the item's HTTP and TCP checks. */
const SMOKE_TASKS: readonly YamlValue[] = [
  {
    name: 'Run the HTTP smoke checks from the controller',
    'ansible.builtin.command': { argv: ['curl', '-sS', '--max-time', '30', '-w', '\\n%{http_code} %{time_total}', '{{ item.target }}'] },
    loop: "{{ atk_item.checks | default([]) | selectattr('kind', 'equalto', 'http') | list }}",
    loop_control: { label: '{{ item.target }}' },
    register: 'atk_http',
    delegate_to: 'localhost',
    become: false,
    changed_when: false,
    failed_when: false,
    check_mode: false,
  },
  {
    name: 'Record the HTTP smoke checks',
    'ansible.builtin.set_fact': {
      atk_smoke: "{{ atk_smoke | default([]) + [{'id': 'http:' ~ item.item.target, 'kind': 'http', 'target': item.item.target, 'expected': (item.item.expect | default('2xx')), 'observed': atk_code, 'ms': atk_ms, 'passed': (item.rc == 0) and ((atk_code == (item.item.expect | string)) if (item.item.expect | default('') | string is match('^[0-9]{3}$')) else ((atk_code is match('^[23]')) and ((item.item.expect | default('')) in atk_body))) and ((item.item.maxMs is not defined) or (atk_ms <= (item.item.maxMs | int)))}] }}",
    },
    vars: {
      atk_last: "{{ (item.stdout_lines | default([''])) | last | default('') }}",
      atk_code: "{{ atk_last.split(' ') | first }}",
      atk_ms: "{{ ((atk_last.split(' ') | last | float) * 1000) | int }}",
      atk_body: "{{ (item.stdout | default(''))[: -(atk_last | length)] }}",
    },
    loop: '{{ atk_http.results | default([]) }}',
    loop_control: { label: "{{ item.item.target | default('') }}" },
  },
  {
    name: 'Run the TCP smoke checks from the controller',
    'ansible.builtin.wait_for': { host: "{{ item.target.rsplit(':', 1) | first }}", port: "{{ item.target.rsplit(':', 1) | last | int }}", timeout: 10, state: 'started' },
    loop: "{{ atk_item.checks | default([]) | selectattr('kind', 'equalto', 'tcp') | list }}",
    loop_control: { label: '{{ item.target }}' },
    register: 'atk_tcp',
    delegate_to: 'localhost',
    become: false,
    failed_when: false,
    check_mode: false,
  },
  {
    name: 'Record the TCP smoke checks',
    'ansible.builtin.set_fact': {
      atk_smoke: "{{ atk_smoke | default([]) + [{'id': 'tcp:' ~ item.item.target, 'kind': 'tcp', 'target': item.item.target, 'expected': 'open', 'observed': ('closed' if (item.failed | default(false)) else 'open'), 'ms': ((item.elapsed | default(0) | float) * 1000) | int, 'passed': not (item.failed | default(false))}] }}",
    },
    loop: '{{ atk_tcp.results | default([]) }}',
    loop_control: { label: "{{ item.item.target | default('') }}" },
  },
];

// ---------------------------------------------------------------------------
// baseline.yml
// ---------------------------------------------------------------------------

export function renderBaselineYml(): string {
  const play: YamlValue = [{
    name: 'Performance baseline of the wave’s sources (T-7 and T-1)',
    hosts: 'all',
    gather_facts: true,
    vars: ITEM_VARS,
    tasks: [
      requireKit,
      noteItem,
      ...METRIC_TASKS,
      ...SMOKE_TASKS,
      {
        name: 'Create status/baseline on the controller',
        'ansible.builtin.file': { path: '{{ atk_status }}/baseline', state: 'directory', mode: '0755' },
        delegate_to: 'localhost',
        become: false,
        run_once: true,
        check_mode: false,
      },
      {
        name: 'Write the baseline',
        'ansible.builtin.copy': {
          content: "{{ {'kind': 'archtoolkit.baseline', 'v': 1, 'planId': atk_manifest.planId, 'item': atk_item.id | default(''), 'host': inventory_hostname, 'at': now(utc=true).strftime('%Y-%m-%dT%H:%M:%SZ'), 'samples': atk_metrics.samples, 'cpuPct': atk_metrics.cpuPct, 'diskMs': atk_metrics.diskMs, 'memUsedMb': atk_metrics.memUsedMb, 'ports': atk_metrics.ports, 'services': atk_metrics.services, 'smoke': atk_smoke | default([])} | to_nice_json }}\n",
          dest: '{{ atk_status }}/baseline/{{ atk_item_file }}.json',
          mode: '0644',
        },
        delegate_to: 'localhost',
        become: false,
        check_mode: false,
        when: 'atk_item | length > 0',
      },
    ],
  }];
  return renderYaml(play, { header: 'baseline.yml: three samples of CPU, memory and disk latency, the listening ports, the running services and the\nsmoke-check timings per host, to status/baseline/<item>.json (validate.sh --baseline, at T-7 and T-1).' });
}

// ---------------------------------------------------------------------------
// validate.yml (the wrapper around WP-7's validate role)
// ---------------------------------------------------------------------------

export function renderValidateYml(): string {
  const play: YamlValue = [{
    name: 'Validate the wave’s hosts (the validate role, smoke checks and the baseline)',
    hosts: 'all',
    gather_facts: true,
    vars: {
      ...ITEM_VARS,
      validate_phase: 'cutover',
      validate_tolerance_pct: 20,
      validate_report_dir: '{{ atk_status }}/validate-role',
      validate_extra_ports: "{{ atk_item.checks | default([]) | selectattr('kind', 'equalto', 'tcp') | map(attribute='target') | select('match', '.*:[0-9]+$') | map('regex_replace', '^.*:', '') | map('int') | list }}",
      validate_baseline_file: '{{ atk_status }}/baseline/{{ atk_item_file }}.json',
    },
    tasks: [
      requireKit,
      noteItem,
      {
        name: 'Run the validate role',
        block: [{ name: 'Include the validate role', 'ansible.builtin.include_role': { name: 'validate' } }],
        rescue: [{ name: 'Note that the role reported a failure', 'ansible.builtin.set_fact': { atk_role_failed: true } }],
      },
      {
        name: "Read the role's report",
        'ansible.builtin.set_fact': {
          atk_role_report: "{{ lookup('ansible.builtin.file', validate_report_dir ~ '/validation-' ~ inventory_hostname ~ '.json', errors='ignore') | default('{}', true) | from_json }}",
        },
      },
      ...METRIC_TASKS,
      ...SMOKE_TASKS,
      {
        name: 'Read the baseline',
        'ansible.builtin.set_fact': {
          atk_baseline: "{{ lookup('ansible.builtin.file', validate_baseline_file, errors='ignore') | default('{}', true) | from_json }}",
        },
      },
      {
        name: "Turn the role's results into checks",
        'ansible.builtin.set_fact': {
          atk_checks: "{{ atk_checks | default([]) + [{'id': item.0 ~ ':' ~ item.1.key, 'kind': item.0, 'target': item.1.key, 'passed': item.1.value | bool}] }}",
        },
        loop: "{{ (['port'] | product(atk_role_report.ports | default({}) | dict2items) | list) + (['service'] | product(atk_role_report.services | default({}) | dict2items) | list) + (['database'] | product(atk_role_report.databases | default({}) | dict2items) | list) }}",
        loop_control: { label: '{{ item.0 }} {{ item.1.key }}' },
      },
      {
        name: 'Add the DNS and clock checks',
        'ansible.builtin.set_fact': {
          atk_checks: "{{ (atk_checks | default([])) + ([] if atk_role_report.dns is not defined or atk_role_report.dns is none else [{'id': 'dns', 'kind': 'dns', 'target': 'domain', 'passed': atk_role_report.dns | bool}]) + ([] if atk_role_report.time_skew_seconds is not defined else [{'id': 'time', 'kind': 'time', 'target': 'clock', 'observed': atk_role_report.time_skew_seconds, 'expected': '< 5 s', 'passed': (atk_role_report.time_skew_seconds | int) < 5}]) }}",
        },
      },
      {
        name: 'Compare CPU, disk latency and ports with the baseline (a regression is a warning, not a failure)',
        'ansible.builtin.set_fact': {
          atk_warnings: "{{ ([] if (atk_baseline.cpuPct is not defined or (atk_metrics.cpuPct | float) <= (atk_baseline.cpuPct | float) * (1 + (validate_tolerance_pct | float) / 100) + 5) else ['CPU ' ~ atk_metrics.cpuPct ~ '% against ' ~ atk_baseline.cpuPct ~ '% at the baseline']) + ([] if (atk_baseline.diskMs | default(none) is none or atk_metrics.diskMs is none or (atk_metrics.diskMs | float) <= (atk_baseline.diskMs | float) * (1 + (validate_tolerance_pct | float) / 100) + 1) else ['disk latency ' ~ atk_metrics.diskMs ~ ' ms against ' ~ atk_baseline.diskMs ~ ' ms at the baseline']) + ((atk_baseline.ports | default([])) | difference(atk_metrics.ports) | map('string') | map('regex_replace', '^', 'no longer listening on port ') | list) }}",
        },
      },
      {
        name: 'Compare the smoke-check timings with the baseline',
        'ansible.builtin.set_fact': {
          atk_warnings: "{{ atk_warnings + ['smoke check ' ~ item.target ~ ' took ' ~ item.ms ~ ' ms against ' ~ atk_base_ms ~ ' ms at the baseline'] }}",
        },
        vars: {
          atk_base_ms: "{{ (atk_baseline.smoke | default([]) | selectattr('target', 'equalto', item.target) | map(attribute='ms') | first | default(0)) | int }}",
        },
        loop: '{{ atk_smoke | default([]) }}',
        loop_control: { label: '{{ item.target }}' },
        when: ['atk_base_ms | int > 0', '(item.ms | int) > (atk_base_ms | int) * (1 + (validate_tolerance_pct | float) / 100) + 50'],
      },
      {
        name: 'Decide whether the host passed',
        'ansible.builtin.set_fact': {
          atk_passed: "{{ not (atk_role_failed | default(false)) and (atk_role_report.passed | default(false) | bool) and (atk_smoke | default([]) | rejectattr('passed') | list | length == 0) }}",
        },
      },
      {
        name: 'Create reports/ on the controller',
        'ansible.builtin.file': { path: '{{ atk_root }}/reports', state: 'directory', mode: '0755' },
        delegate_to: 'localhost',
        become: false,
        run_once: true,
        check_mode: false,
      },
      {
        name: 'Write the validation report',
        'ansible.builtin.copy': {
          content: "{{ {'kind': 'archtoolkit.validation', 'v': 1, 'planId': atk_manifest.planId, 'item': atk_item.id | default(''), 'host': inventory_hostname, 'phase': validate_phase, 'at': now(utc=true).strftime('%Y-%m-%dT%H:%M:%SZ'), 'passed': atk_passed | bool, 'checks': (atk_checks | default([])) + (atk_smoke | default([])), 'warnings': atk_warnings, 'metrics': {'cpuPct': atk_metrics.cpuPct, 'diskMs': atk_metrics.diskMs, 'memUsedMb': atk_metrics.memUsedMb}} | to_nice_json }}\n",
          dest: '{{ atk_root }}/reports/validation-{{ inventory_hostname }}.json',
          mode: '0644',
        },
        delegate_to: 'localhost',
        become: false,
        check_mode: false,
      },
    ],
  }];
  return renderYaml(play, {
    header: 'validate.yml: validation per host (validate.sh; validate_phase test, cutover or rollback). It runs WP-7\'s validate role\n(ports, services, database, DNS, clock), the app smoke checks from the controller (HTTP status / content / time, TCP),\nand compares CPU, disk latency and ports with status/baseline/<item>.json (a regression beyond validate_tolerance_pct\nis a warning). It writes reports/validation-<host>.json (kind archtoolkit.validation), which validate.sh turns into events.',
  });
}

// ---------------------------------------------------------------------------
// identity.yml
// ---------------------------------------------------------------------------

/** The time source per target platform (Linux chrony / Windows w32tm); vmware reads identity_ntp_servers. */
export const TIME_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  aws: '169.254.169.123',
  google: 'metadata.google.internal',
  oci: '169.254.169.254',
});
export const TIME_SOURCE_NOTES = 'AWS Time Sync (169.254.169.123, fd00:ec2::123 on Nitro); Google Cloud metadata server; OCI 169.254.169.254; Azure: the host time through the Hyper-V integration services (nothing to set); VCF: identity_ntp_servers.';

/** The certificate source per target platform, when the app does not choose one. */
export const CERT_SOURCE_DEFAULT: Readonly<Record<string, string>> = Object.freeze({
  aws: 'acm', azure: 'key-vault', google: 'certificate-manager', oci: 'oci-certificates', vmware: 'adcs',
});

/** The AD CS request-and-rebind script (win_powershell) of identity.yml. */
export const GET_CERT = [
  'param([string]$Template, [string[]]$DnsName, [string]$Site, [int]$Port)',
  '$Ansible.Changed = $false',
  "$have = Get-ChildItem Cert:\\LocalMachine\\My | Where-Object { $_.NotAfter -gt (Get-Date).AddDays(30) -and ($_.DnsNameList.Unicode -contains $DnsName[0]) } | Select-Object -First 1",
  'if (-not $have) {',
  "  $req = Get-Certificate -Template $Template -DnsName $DnsName -SubjectName ('CN=' + $DnsName[0]) -CertStoreLocation Cert:\\LocalMachine\\My",
  '  $have = $req.Certificate',
  '  $Ansible.Changed = $true',
  '}',
  'if ($Site -and $have) {',
  '  Import-Module WebAdministration',
  "  $binding = Get-WebBinding -Name $Site -Protocol https -Port $Port",
  "  if (-not $binding) { New-WebBinding -Name $Site -Protocol https -Port $Port; $binding = Get-WebBinding -Name $Site -Protocol https -Port $Port }",
  '  if ($binding.certificateHash -ne $have.Thumbprint) { $binding.AddSslCertificate($have.Thumbprint, \'My\'); $Ansible.Changed = $true }',
  '}',
  '$Ansible.Result = @{ thumbprint = $have.Thumbprint }',
].join('\n');

export function renderIdentityYml(): string {
  const cutover: YamlValue = {
    name: 'Server identity after cutover: AD object, DNS client, certificates, licences, time',
    hosts: 'all',
    gather_facts: true,
    vars: {
      ...ITEM_VARS,
      identity_stage: 'cutover',
      identity_dc: "{{ (groups['role_ad_dc'] | default([])) | first | default('') }}",
      identity_domain_member: "{{ ansible_facts.windows_domain_member | default(false) | bool }}",
      identity_cert_source: `{{ identity_cert_source_override | default(${JSON.stringify(CERT_SOURCE_DEFAULT)}[cloud_platform] | default('adcs')) }}`,
      identity_certificates: [],
      identity_open_licence_tasks: [],
      identity_time_source: `{{ identity_ntp_servers | default([]) | first | default(${JSON.stringify(TIME_SOURCES)}[cloud_platform] | default('')) }}`,
    },
    tasks: [
      requireKit,
      noteItem,
      {
        name: 'Confirm the computer object and move it to the target OU (Windows domain members)',
        'microsoft.ad.computer': {
          identity: "{{ ansible_facts.hostname | upper }}$",
          name: '{{ ansible_facts.hostname | upper }}',
          path: '{{ identity_target_ou | default(omit) }}',
          state: 'present',
          domain_username: '{{ vault_domain_join_user }}',
          domain_password: '{{ vault_domain_join_password }}',
        },
        delegate_to: '{{ identity_dc }}',
        no_log: true,
        when: ['identity_stage == \'cutover\'', WINDOWS, 'identity_domain_member', 'identity_dc | length > 0'],
      },
      {
        name: 'Point the DNS client at the target domain controllers (Windows)',
        'ansible.windows.win_dns_client': { adapter_names: '*', dns_servers: '{{ identity_dns_servers }}' },
        when: ['identity_stage == \'cutover\'', WINDOWS, 'identity_dns_servers is defined', 'identity_dns_servers | length > 0'],
      },
      {
        name: 'Request or rebind the certificates from AD CS (Windows)',
        'ansible.windows.win_powershell': {
          script: GET_CERT,
          parameters: {
            Template: "{{ item.template | default(identity_adcs_template | default('WebServer')) }}",
            DnsName: '{{ item.san | default([item.subject]) }}',
            Site: "{{ item.site | default('') }}",
            Port: '{{ item.port | default(443) }}',
          },
        },
        loop: '{{ identity_certificates }}',
        loop_control: { label: '{{ item.subject }}' },
        when: ['identity_stage == \'cutover\'', WINDOWS, "identity_cert_source == 'adcs'"],
      },
      {
        name: 'Certificates from a cloud certificate service or on Linux: operator steps',
        'ansible.builtin.debug': {
          msg: "Reissue {{ item.subject }} ({{ item.path | default(item.store | default('')) }}) from {{ identity_cert_source }}, with SANs {{ item.san | default([item.subject]) | join(', ') }}.",
        },
        loop: '{{ identity_certificates }}',
        loop_control: { label: '{{ item.subject }}' },
        when: ['identity_stage == \'cutover\'', `(${LINUX}) or identity_cert_source != 'adcs'`],
      },
      {
        name: 'Check that the app licence tasks are closed',
        'ansible.builtin.assert': {
          that: ['identity_open_licence_tasks | length == 0'],
          fail_msg: 'Licence re-hosting not done: {{ identity_open_licence_tasks | join(\', \') }}. Close the coupling tasks, then re-run.',
          quiet: true,
        },
        when: "identity_stage == 'cutover'",
      },
      {
        name: 'Read the Windows time configuration',
        'ansible.windows.win_command': { argv: ['w32tm', '/query', '/configuration'] },
        register: 'identity_w32tm',
        changed_when: false,
        check_mode: false,
        when: ['identity_stage == \'cutover\'', WINDOWS, "cloud_platform != 'azure'", 'identity_time_source | length > 0'],
      },
      {
        name: 'Set the Windows time source to the target platform',
        'ansible.windows.win_command': { argv: ['w32tm', '/config', '/manualpeerlist:{{ identity_time_source }}', '/syncfromflags:manual', '/update'] },
        changed_when: true,
        when: ['identity_stage == \'cutover\'', WINDOWS, "cloud_platform != 'azure'", 'identity_time_source | length > 0', 'identity_time_source not in identity_w32tm.stdout | default(\'\')'],
      },
      {
        name: 'Read the chrony sources (Linux)',
        'ansible.builtin.command': { argv: ['chronyc', '-n', 'sources'] },
        register: 'identity_chrony',
        changed_when: false,
        failed_when: false,
        check_mode: false,
        when: ['identity_stage == \'cutover\'', LINUX],
      },
      {
        name: 'Warn when chrony does not use the target platform\'s time source',
        'ansible.builtin.debug': { msg: 'chrony does not list {{ identity_time_source }}: the linux_baseline role sets the time source; re-run site.yml for this host.' },
        when: ['identity_stage == \'cutover\'', LINUX, 'identity_time_source | length > 0', "identity_time_source not in identity_chrony.stdout | default('')"],
      },
    ],
  };
  const decommission: YamlValue = {
    name: 'Decommission: remove the computer objects of renamed servers',
    hosts: 'role_ad_dc',
    gather_facts: false,
    vars: { identity_stage: 'cutover', identity_remove_computers: [] },
    tasks: [
      {
        name: 'Remove the old computer objects (renamed rebuilt servers only; same-name servers are kept)',
        'microsoft.ad.computer': {
          identity: '{{ item | upper }}$',
          state: 'absent',
          domain_username: '{{ vault_domain_join_user }}',
          domain_password: '{{ vault_domain_join_password }}',
        },
        loop: '{{ identity_remove_computers }}',
        run_once: true,
        no_log: true,
        when: "identity_stage == 'decommission'",
      },
    ],
  };
  return renderYaml([cutover, decommission], {
    header: `identity.yml: server identity (cutover.sh step 11, --limit wave_<n>; decommission.sh with -e identity_stage=decommission).\nPer host: identity_target_ou, identity_dns_servers, identity_certificates ([{subject, san, template, site, port}] from the\ncoupling scan), identity_cert_source_override (adcs, acm, key-vault, certificate-manager or oci-certificates),\nidentity_open_licence_tasks and identity_ntp_servers. Time sources: ${TIME_SOURCE_NOTES}`,
  });
}

/** Every play of the kit, keyed by its path under migration/execute/. */
export function ansibleKitFiles(): Record<string, string> {
  return {
    'ansible/freeze.yml': renderFreezeYml(),
    'ansible/unfreeze.yml': renderUnfreezeYml(),
    'ansible/baseline.yml': renderBaselineYml(),
    'ansible/validate.yml': renderValidateYml(),
    'ansible/identity.yml': renderIdentityYml(),
  };
}
