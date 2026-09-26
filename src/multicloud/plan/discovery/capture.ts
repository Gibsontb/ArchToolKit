/**
 * Flows from the guests themselves (addendum A.10.1, source 3).
 *
 * `discover-connections.yml` puts a small capture on each server and runs it
 * every 10 minutes for N days (default 7):
 *
 *  - Linux: `ss -Htnp state established` (or `netstat -tnp` where ss is
 *    missing), with the listening ports from `ss -Htln` to tell inbound from
 *    outbound; a cron entry in /etc/cron.d that removes itself at the end.
 *  - Windows: `Get-NetTCPConnection -State Established`, the listening ports
 *    from `-State Listen`, the owning process's name; a scheduled task that
 *    repeats every 10 minutes for N days.
 *
 * Each sample is one line per connection: time, client, server, server port,
 * process. `discovery_action=collect` aggregates the samples on each host per
 * (remote, port, process) into flows.csv, fetches them and assembles one
 * flows.csv on the controller; `discovery_action=stop` removes the schedule.
 * The capture applies by default (the house rule); it reads connection
 * tables only and changes nothing else on the host.
 *
 * `parseCaptureOutput` also reads raw `ss`, `netstat` or `Get-NetTCPConnection
 * | Export-Csv` output pasted by hand, and the samples file.
 */

import { renderYaml, type YamlValue } from '../../../ansible/yaml.ts';
import { parseCsv } from '../../../core/csv.ts';
import { aggregateFlows, canonicalIp, EPHEMERAL_FROM, FLOWS_CSV_HEADER, type FlowRecord } from './flows.ts';

export interface CaptureOptions {
  /** Days to capture. Default 7. */
  readonly days?: number;
  /** Minutes between samples. Default 10. */
  readonly intervalMinutes?: number;
  /** The inventory pattern. Default 'all'. */
  readonly hosts?: string;
}

const LINUX_DIR = '/var/lib/atk-discovery';
const LINUX_BIN = '/usr/local/lib/atk-discovery';

/** One sample on Linux: established TCP connections, client → server, loopback left out. */
export const CAPTURE_LINUX = [
  '#!/usr/bin/env bash',
  '# One sample of established TCP connections, appended to samples.tsv:',
  '# time, client address, server address, server port, local process.',
  '# Removes its own schedule once the end time has passed.',
  'set -euo pipefail',
  `DIR=${LINUX_DIR}`,
  'now=$(date -u +%s)',
  'if [[ -f "$DIR/end-epoch" ]] && (( now > $(cat "$DIR/end-epoch") )); then',
  '  rm -f /etc/cron.d/atk-discovery',
  '  exit 0',
  'fi',
  'ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
  '# addr:port, [v6]:port and ::ffff:v4:port all split on the last colon.',
  'split=\'function hp(s, out,  i) { i = match(s, /:[0-9]+$/); out[1] = substr(s, 1, i - 1); out[2] = substr(s, i + 1);',
  '  gsub(/^\\[|\\]$/, "", out[1]); sub(/^::ffff:/, "", out[1]); sub(/%.*$/, "", out[1]) }\'',
  'if command -v ss >/dev/null 2>&1; then',
  '  listen=" $(ss -Htln | awk \'{print $4}\' | sed -E \'s/.*:([0-9]+)$/\\1/\' | sort -u | tr \'\\n\' \' \') "',
  '  ss -Htnp state established | awk -v ts="$ts" -v listen="$listen" "$split"\'',
  '    { hp($3, l); hp($4, r); p = ""; if (match($0, /\\("[^"]+"/)) p = substr($0, RSTART + 2, RLENGTH - 3)',
  '      if (l[1] ~ /^(127\\.|::1$)/) next',
  '      if (index(listen, " " l[2] " ")) print ts "\\t" r[1] "\\t" l[1] "\\t" l[2] "\\t" p',
  '      else print ts "\\t" l[1] "\\t" r[1] "\\t" r[2] "\\t" p }\'',
  'else',
  '  listen=" $(netstat -tln 2>/dev/null | awk \'$6 == "LISTEN" {print $4}\' | sed -E \'s/.*:([0-9]+)$/\\1/\' | sort -u | tr \'\\n\' \' \') "',
  '  netstat -tnp 2>/dev/null | awk -v ts="$ts" -v listen="$listen" "$split"\'',
  '    $6 == "ESTABLISHED" { hp($4, l); hp($5, r); p = $7; sub(/^[0-9]+\\//, "", p); if (p == "-") p = ""',
  '      if (l[1] ~ /^(127\\.|::1$)/) next',
  '      if (index(listen, " " l[2] " ")) print ts "\\t" r[1] "\\t" l[1] "\\t" l[2] "\\t" p',
  '      else print ts "\\t" l[1] "\\t" r[1] "\\t" r[2] "\\t" p }\'',
  `fi >> "$DIR/samples.tsv"`,
  '',
].join('\n');

/** Aggregate the samples into flows.csv on the host. */
export const AGGREGATE_LINUX = [
  '#!/usr/bin/env bash',
  '# samples.tsv → flows.csv, one row per (client, server, port, process).',
  'set -euo pipefail',
  `DIR=${LINUX_DIR}`,
  `echo '${FLOWS_CSV_HEADER}' > "$DIR/flows.csv"`,
  '[[ -f "$DIR/samples.tsv" ]] || exit 0',
  'awk -F \'\\t\' \'{ k = $2 "," $3 "," $4 ",tcp," $5; n[k]++; if (!(k in f) || $1 < f[k]) f[k] = $1; if ($1 > l[k]) l[k] = $1 }',
  '  END { for (k in n) { split(k, a, ","); print a[1] "," a[2] "," a[3] ",tcp," n[k] "," f[k] "," l[k] ",," a[5] "," } }\' \\',
  '  "$DIR/samples.tsv" | sort >> "$DIR/flows.csv"',
  '',
].join('\n');

/** One sample on Windows. */
export const CAPTURE_WINDOWS = [
  '# One sample of established TCP connections, appended to samples.tsv:',
  '# time, client address, server address, server port, owning process.',
  '# Removes its own scheduled task once the end time has passed.',
  "$ErrorActionPreference = 'Stop'",
  "$dir = Join-Path $env:ProgramData 'atk-discovery'",
  "$endFile = Join-Path $dir 'end-epoch'",
  '$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()',
  'if ((Test-Path $endFile) -and ($now -gt [long](Get-Content $endFile))) {',
  "  Unregister-ScheduledTask -TaskName 'atk-discovery' -Confirm:$false -ErrorAction SilentlyContinue",
  '  exit 0',
  '}',
  "$ts = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')",
  '$listen = @{}',
  'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $listen[[int]$_.LocalPort] = $true }',
  '$names = @{}',
  'Get-Process | ForEach-Object { $names[[int]$_.Id] = $_.ProcessName }',
  "$clean = { param($a) ($a -replace '^::ffff:', '') -replace '%.*$', '' }",
  'Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $local = & $clean $_.LocalAddress',
  '  $remote = & $clean $_.RemoteAddress',
  "  if ($local -match '^(127\\.|::1$)') { return }",
  '  $proc = $names[[int]$_.OwningProcess]',
  '  if ($listen.ContainsKey([int]$_.LocalPort)) { "$ts`t$remote`t$local`t$($_.LocalPort)`t$proc" }',
  '  else { "$ts`t$local`t$remote`t$($_.RemotePort)`t$proc" }',
  "} | Add-Content -Path (Join-Path $dir 'samples.tsv') -Encoding utf8",
  '',
].join('\r\n');

export const AGGREGATE_WINDOWS = [
  '# samples.tsv → flows.csv, one row per (client, server, port, process).',
  "$ErrorActionPreference = 'Stop'",
  "$dir = Join-Path $env:ProgramData 'atk-discovery'",
  "$out = Join-Path $dir 'flows.csv'",
  `Set-Content -Path $out -Value '${FLOWS_CSV_HEADER}' -Encoding utf8`,
  "$samples = Join-Path $dir 'samples.tsv'",
  'if (-not (Test-Path $samples)) { exit 0 }',
  "Import-Csv -Path $samples -Delimiter \"`t\" -Header 'ts','src','dst','port','proc' |",
  "  Group-Object src, dst, port, proc | Sort-Object Name | ForEach-Object {",
  '    $g = $_.Group | Sort-Object ts',
  '    $f = $g[0]',
  '    "$($f.src),$($f.dst),$($f.port),tcp,$($_.Count),$($g[0].ts),$($g[-1].ts),,$($f.proc),"',
  '  } | Add-Content -Path $out -Encoding utf8',
  '',
].join('\r\n');

/** The playbook and the scripts it copies, path → text. */
export function discoverConnectionsFiles(options: CaptureOptions = {}): Record<string, string> {
  const days = Math.max(1, Math.min(90, Math.round(options.days ?? 7)));
  const interval = Math.max(1, Math.min(60, Math.round(options.intervalMinutes ?? 10)));
  const notWindows = "ansible_facts['os_family'] != 'Windows'";
  const isWindows = "ansible_facts['os_family'] == 'Windows'";
  const endEpoch = "{{ (ansible_facts['date_time']['epoch'] | int) + (discovery_days | int) * 86400 }}";
  const plays: YamlValue = [
    {
      name: 'Start the connection capture',
      hosts: `{{ discovery_hosts | default('${options.hosts ?? 'all'}') }}`,
      become: true,
      gather_facts: true,
      vars: { discovery_action: 'start', discovery_days: days, discovery_interval_minutes: interval },
      tasks: [
        {
          name: 'Linux: install the capture and schedule it',
          when: [`discovery_action == 'start'`, notWindows],
          block: [
            { name: 'Capture directories', 'ansible.builtin.file': { path: '{{ item }}', state: 'directory', mode: '0750' }, loop: [LINUX_DIR, LINUX_BIN] },
            { name: 'Capture script', 'ansible.builtin.copy': { src: 'files/capture-linux.sh', dest: `${LINUX_BIN}/capture.sh`, mode: '0750' } },
            { name: 'Aggregate script', 'ansible.builtin.copy': { src: 'files/aggregate-linux.sh', dest: `${LINUX_BIN}/aggregate.sh`, mode: '0750' } },
            { name: 'End of the capture window', 'ansible.builtin.copy': { content: `${endEpoch}\n`, dest: `${LINUX_DIR}/end-epoch`, mode: '0640' } },
            {
              name: 'Sample on a schedule, minutes between samples: {{ discovery_interval_minutes }}',
              'ansible.builtin.cron': {
                name: 'atk-discovery', cron_file: 'atk-discovery', user: 'root',
                minute: '*/{{ discovery_interval_minutes }}', job: `${LINUX_BIN}/capture.sh`, state: 'present',
              },
            },
            { name: 'First sample now', 'ansible.builtin.command': `${LINUX_BIN}/capture.sh`, changed_when: false },
          ],
        },
        {
          name: 'Windows: install the capture and schedule it',
          when: [`discovery_action == 'start'`, isWindows],
          block: [
            { name: 'Capture directory', 'ansible.windows.win_file': { path: 'C:\\ProgramData\\atk-discovery', state: 'directory' } },
            { name: 'Capture script', 'ansible.windows.win_copy': { src: 'files/capture-windows.ps1', dest: 'C:\\ProgramData\\atk-discovery\\capture.ps1' } },
            { name: 'Aggregate script', 'ansible.windows.win_copy': { src: 'files/aggregate-windows.ps1', dest: 'C:\\ProgramData\\atk-discovery\\aggregate.ps1' } },
            { name: 'End of the capture window', 'ansible.windows.win_copy': { content: endEpoch, dest: 'C:\\ProgramData\\atk-discovery\\end-epoch' } },
            {
              name: 'Sample on a schedule for the capture window, days: {{ discovery_days }}',
              'community.windows.win_scheduled_task': {
                name: 'atk-discovery', state: 'present', enabled: true, username: 'SYSTEM', run_level: 'highest',
                actions: [{ path: 'powershell.exe', arguments: '-NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\atk-discovery\\capture.ps1' }],
                triggers: [{ type: 'registration', repetition: { interval: 'PT{{ discovery_interval_minutes }}M', duration: 'P{{ discovery_days }}D' } }],
              },
            },
          ],
        },
        {
          name: 'Collect: aggregate on each host and fetch flows.csv',
          when: `discovery_action == 'collect'`,
          block: [
            { name: 'Aggregate (Linux)', 'ansible.builtin.command': `${LINUX_BIN}/aggregate.sh`, changed_when: false, when: notWindows },
            { name: 'Fetch (Linux)', 'ansible.builtin.fetch': { src: `${LINUX_DIR}/flows.csv`, dest: '{{ discovery_out_dir | default(playbook_dir ~ \'/flows\') }}/{{ inventory_hostname }}.csv', flat: true }, when: notWindows },
            { name: 'Aggregate (Windows)', 'ansible.windows.win_shell': 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\atk-discovery\\aggregate.ps1', changed_when: false, when: isWindows },
            { name: 'Fetch (Windows)', 'ansible.builtin.fetch': { src: 'C:\\ProgramData\\atk-discovery\\flows.csv', dest: '{{ discovery_out_dir | default(playbook_dir ~ \'/flows\') }}/{{ inventory_hostname }}.csv', flat: true }, when: isWindows },
          ],
        },
        {
          name: 'Stop: remove the schedule (the samples stay for a later collect)',
          when: `discovery_action == 'stop'`,
          block: [
            { name: 'Remove the cron entry (Linux)', 'ansible.builtin.cron': { name: 'atk-discovery', cron_file: 'atk-discovery', state: 'absent' }, when: notWindows },
            { name: 'Remove the task (Windows)', 'community.windows.win_scheduled_task': { name: 'atk-discovery', state: 'absent' }, when: isWindows },
          ],
        },
      ],
    },
    {
      name: 'Assemble one flows.csv on the controller',
      hosts: 'localhost',
      gather_facts: false,
      vars: { discovery_action: 'start' },
      tasks: [
        {
          name: 'Concatenate the per-host files (the importer drops the repeated headers)',
          'ansible.builtin.assemble': { src: "{{ discovery_out_dir | default(playbook_dir ~ '/flows') }}", dest: "{{ playbook_dir }}/flows.csv", regexp: '\\.csv$', mode: '0640' },
          when: "discovery_action == 'collect'",
        },
      ],
    },
  ];
  const header = [
    'Dependency discovery: sample established TCP connections on every server.',
    `Start (default): ansible-playbook discover-connections.yml   # every ${interval} min for ${days} days`,
    'Collect:        ansible-playbook discover-connections.yml -e discovery_action=collect',
    'Stop early:     ansible-playbook discover-connections.yml -e discovery_action=stop',
    'Then import flows.csv on the Application Migration page (Dependencies, Import flows).',
  ].join('\n');
  return {
    'discovery/discover-connections.yml': renderYaml(plays, { header }),
    'discovery/files/capture-linux.sh': CAPTURE_LINUX,
    'discovery/files/aggregate-linux.sh': AGGREGATE_LINUX,
    'discovery/files/capture-windows.ps1': CAPTURE_WINDOWS,
    'discovery/files/aggregate-windows.ps1': AGGREGATE_WINDOWS,
  };
}

// ---------------------------------------------------------------------------
// Parsing raw capture output
// ---------------------------------------------------------------------------

/** "10.0.0.5:22", "[2001:db8::5]:443", "::ffff:10.0.0.5:22", "*:22" → address and port. */
export function splitEndpoint(text: string): { ip: string; port: number } | null {
  const t = text.trim();
  const m = /^(.*):(\d+)$/.exec(t);
  if (!m) return null;
  const ip = canonicalIp(m[1]);
  return ip ? { ip, port: Number(m[2]) } : null;
}

const loopback = (ip: string): boolean => ip.startsWith('127.') || ip === '::1';

/**
 * Which side serves: the listening port when known; otherwise the lower port
 * when only it is below the ephemeral range; otherwise the lower port.
 */
function orient(local: { ip: string; port: number }, remote: { ip: string; port: number }, listening?: ReadonlySet<number>) {
  let inbound: boolean;
  if (listening && listening.size > 0) inbound = listening.has(local.port);
  else if (local.port < EPHEMERAL_FROM && remote.port >= EPHEMERAL_FROM) inbound = true;
  else if (remote.port < EPHEMERAL_FROM && local.port >= EPHEMERAL_FROM) inbound = false;
  else inbound = local.port < remote.port;
  return inbound
    ? { sourceIp: remote.ip, destIp: local.ip, destPort: local.port }
    : { sourceIp: local.ip, destIp: remote.ip, destPort: remote.port };
}

export type CaptureFormat = 'samples' | 'ss' | 'netstat' | 'get-nettcpconnection' | 'unknown';

export function detectCaptureFormat(text: string): CaptureFormat {
  const first = text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#TYPE')) ?? '';
  if (/LocalAddress/i.test(first) && /RemoteAddress/i.test(first)) return 'get-nettcpconnection';
  if (/^\d{4}-\d{2}-\d{2}T[^\t]*\t/.test(first)) return 'samples';
  if (/^(tcp6?|Proto)\s/i.test(first) || /^Active Internet/i.test(first)) return 'netstat';
  if (/^(ESTAB|State|Recv-Q|\d+\s+\d+\s+\S+:\d+)/.test(first.trim())) return 'ss';
  return 'unknown';
}

/**
 * Raw capture output as flow records. `listening` (the host's listening ports)
 * makes the client/server call exact; without it the ephemeral-port rule is
 * used. Loopback connections are left out.
 */
export function parseCaptureOutput(text: string, options: { readonly listening?: readonly number[] } = {}): FlowRecord[] {
  text = text.replace(/^﻿/, '');
  const listening = options.listening ? new Set(options.listening) : undefined;
  const format = detectCaptureFormat(text);
  const out: FlowRecord[] = [];
  const push = (local: { ip: string; port: number } | null, remote: { ip: string; port: number } | null, process: string, at?: string) => {
    if (!local || !remote || loopback(local.ip)) return;
    out.push({ ...orient(local, remote, listening), protocol: 'tcp', observations: 1, ...(process ? { process } : {}), ...(at ? { firstSeen: at, lastSeen: at } : {}) });
  };
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (format === 'samples') {
    for (const line of lines) {
      const [ts = '', src = '', dst = '', port = '', proc = ''] = line.split('\t');
      const s = canonicalIp(src);
      const d = canonicalIp(dst);
      if (!s || !d || !/^\d+$/.test(port) || loopback(s)) continue;
      out.push({ sourceIp: s, destIp: d, destPort: Number(port), protocol: 'tcp', observations: 1, firstSeen: ts, lastSeen: ts, ...(proc ? { process: proc } : {}) });
    }
  } else if (format === 'ss') {
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      // With a state filter ss drops the State column: Recv-Q Send-Q Local Peer [Process].
      const offset = /^\d+$/.test(cols[0] ?? '') ? 0 : 1;
      if (offset === 1 && !/^ESTAB/i.test(cols[0] ?? '')) continue;
      const proc = /users:\(\("([^"]+)"/.exec(line)?.[1] ?? '';
      push(splitEndpoint(cols[2 + offset] ?? ''), splitEndpoint(cols[3 + offset] ?? ''), proc);
    }
  } else if (format === 'netstat') {
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (!/^tcp/i.test(cols[0] ?? '') || !/ESTABLISHED/i.test(cols[5] ?? '')) continue;
      const proc = (cols[6] ?? '').replace(/^\d+\//, '').replace(/^-$/, '');
      push(splitEndpoint(cols[3] ?? ''), splitEndpoint(cols[4] ?? ''), proc);
    }
  } else if (format === 'get-nettcpconnection') {
    const table = parseCsv(text.replace(/^#TYPE.*\r?\n/, ''));
    const h = (name: string) => table.headers.findIndex((x) => x.trim().toLowerCase() === name.toLowerCase());
    const [la, lp, ra, rp, st, op] = ['LocalAddress', 'LocalPort', 'RemoteAddress', 'RemotePort', 'State', 'OwningProcess'].map(h) as [number, number, number, number, number, number];
    const pn = h('ProcessName');
    for (const row of table.rows) {
      const state = st >= 0 ? (row[st] ?? '') : 'Established';
      if (!/^(established|5)$/i.test(state.trim())) continue;
      const l = canonicalIp(row[la]);
      const r = canonicalIp(row[ra]);
      if (!l || !r) continue;
      push({ ip: l, port: Number(row[lp]) }, { ip: r, port: Number(row[rp]) }, pn >= 0 ? (row[pn] ?? '') : op >= 0 ? `pid ${row[op] ?? ''}` : '');
    }
  }
  return aggregateFlows(out);
}
