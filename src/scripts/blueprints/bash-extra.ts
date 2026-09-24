/**
 * Bash: the rest of it.
 *
 * A machine report, log cleanup that cannot delete the wrong thing, container
 * maintenance, certificate renewal with the reload that people forget, database
 * maintenance, firewall rules that are idempotent, and running a command across
 * a list of hosts.
 *
 * Same opening as the others — strict mode, a trap, a dry run — and the same
 * rule everywhere: anything destructive names its target explicitly and refuses
 * to work on an empty variable, because `rm -rf "$DIR/"` with `$DIR` unset is
 * the oldest disaster in the language.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { isAnyNetwork, parseCidrAny, type Family } from '../../core/ip.ts';
import { scriptBlueprint, type ScriptBlueprint } from '../from-script.ts';
import { identifier, listOf, snake, type Script } from '../script.ts';

const PLATFORM = 'bash' as const;

/**
 * Where a firewall rule lets traffic in from. "any" (or nothing) is everyone
 * over IPv4 and IPv6; a network is exactly that network, in its own family —
 * 0.0.0.0/0 is every IPv4 address and ::/0 every IPv6 one.
 */
type RuleSource = { readonly kind: 'any' } | { readonly kind: 'net'; readonly family: Family; readonly text: string };

function ruleSource(raw: string): RuleSource | null {
  const t = raw.trim();
  if (t === '' || /^(any|all|\*)$/i.test(t)) return { kind: 'any' };
  const c = parseCidrAny(t);
  if (!c) return null;
  // Written the way every backend accepts: the network for a prefix, the
  // address alone for a host. nft and firewalld refuse 10.0.1.5/24.
  return { kind: 'net', family: c.family, text: t.includes('/') ? `${c.network}/${c.prefix}` : c.address };
}

/**
 * The ICMPv6 that IPv6 cannot work without (RFC 4890): neighbour discovery
 * is how it finds the next hop at all, router advertisements carry the
 * default route, MLD queries keep snooping switches forwarding the ND
 * multicast, and packet-too-big is path MTU discovery — IPv6 routers never
 * fragment. Kept when ping is turned off.
 */
const ICMPV6_ESSENTIAL_NFT = 'destination-unreachable, packet-too-big, time-exceeded, parameter-problem, mld-listener-query, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert';
const ICMPV6_ESSENTIAL_IPT = ['destination-unreachable', 'packet-too-big', 'time-exceeded', 'parameter-problem', '130', 'router-solicitation', 'router-advertisement', 'neighbour-solicitation', 'neighbour-advertisement'];

function preamble(): string[] {
  return [
    'set -euo pipefail',
    'IFS=$\'\\n\\t\'',
    '',
    'readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"',
    'readonly STARTED_AT="$(date +%Y%m%d-%H%M%S)"',
    '',
  ];
}

function scaffolding(): string[] {
  return [
    'log()  { printf \'%s [%s] %s\\n\' "$(date +\'%Y-%m-%d %H:%M:%S\')" "INFO" "$*" >&2; }',
    'warn() { printf \'%s [%s] %s\\n\' "$(date +\'%Y-%m-%d %H:%M:%S\')" "WARN" "$*" >&2; }',
    'die()  { printf \'%s [%s] %s\\n\' "$(date +\'%Y-%m-%d %H:%M:%S\')" "ERROR" "$*" >&2; exit 1; }',
    '',
    'CLEANUP=()',
    'cleanup() {',
    '  local status=$?',
    '  for item in "${CLEANUP[@]:-}"; do [[ -e "$item" ]] && rm -rf -- "$item"; done',
    '  (( status != 0 )) && warn "$SCRIPT_NAME exited with status $status"',
    '  exit "$status"',
    '}',
    'trap cleanup EXIT INT TERM',
    '',
    'DRY_RUN=0',
    'run() {',
    '  if (( DRY_RUN )); then log "DRY RUN: $*"; return 0; fi',
    '  log "+ $*"',
    '  "$@"',
    '}',
    '',
  ];
}

export const BASH_EXTRA: readonly ScriptBlueprint[] = [
  scriptBlueprint({
    id: 'sh_system_report',
    platform: PLATFORM,
    label: 'System report',
    group: 'Operations',
    description: 'Everything worth knowing about a machine in one file: hardware, storage, network, packages, services, users and what is listening — the thing you wish you had taken before the machine broke.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'system-report' },
      { id: 'sections', label: 'Include', control: 'select', default: 'all', options: [
        { value: 'all', label: 'Everything' },
        { value: 'hardware', label: 'Hardware and storage only' },
        { value: 'security', label: 'Users, sudo, SSH, listening ports and firewall' },
      ] },
      { id: 'format', label: 'Output', control: 'select', default: 'text', options: [
        { value: 'text', label: 'A readable text file' },
        { value: 'json', label: 'JSON, for something else to read' },
        { value: 'both', label: 'Both' },
      ] },
      { id: 'output_dir', label: 'Write to', control: 'text', default: '/var/log/system-reports' },
      { id: 'redact', label: 'Leave out', control: 'text', default: 'key, password, secret, token', hint: 'Environment variables and config lines matching these are masked' },
      { id: 'compare', label: 'Compare against the last report', control: 'toggle', default: true },
    ],
    script: (values: BlueprintValues): Script => {
      const name = snake(str(values, 'script_name', 'system-report'), 'system_report');
      const sections = str(values, 'sections', 'all');
      const format = str(values, 'format', 'text');
      const findings: Finding[] = [];

      findings.push(
        warning('scripts.sh.report-is-sensitive', 'A full system report lists users, sudo rules, listening ports, installed packages and their versions. That is a map of the machine and an inventory of what is out of date — useful to you and equally useful to anyone else who reads it.', {
          remediation: 'Write it somewhere root-only, and think before attaching it to a ticket.',
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: 'Collect a full system report',
        effect: 'read',
        requires: [
          { what: 'Root, for the parts that need it — the script degrades gracefully without it' },
          { what: 'Common utilities: lsblk, ip, ss, systemctl. Missing ones are reported and skipped' },
        ],
        parameters: [
          { name: '-o, --output', description: 'Where to write the report.', required: false },
          { name: '--json', description: 'Also write JSON.', required: false },
        ],
        notes: [
          'Every command is guarded. A machine without lsblk, or without systemd, produces a report with that section marked unavailable rather than a script that dies on line 40.',
          'This is the file to take before a change and compare against afterwards. Most "what changed" questions are answerable from two of these and a diff.',
          `Masked before writing: anything matching ${listOf(str(values, 'redact', '')).join(', ')}. That covers the obvious cases and it is not a guarantee — read the report before sending it anywhere.`,
          ...(bool(values, 'compare', true) ? ['The previous report is diffed automatically, so a scheduled run tells you what changed rather than just that it ran.'] : []),
        ],
        usage: [`sudo ./${name}.sh`, `sudo ./${name}.sh -o /tmp/before-change.txt`, `diff /var/log/system-reports/*.txt | less`],
        undo: ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble(),
          ...scaffolding(),
          `readonly OUTPUT_DIR="\${OUTPUT_DIR:-${str(values, 'output_dir', '/var/log/system-reports')}}"`,
          'REPORT=""',
          'JSON=0',
          '',
          'while (( $# > 0 )); do',
          '  case "$1" in',
          '    -o|--output) REPORT="$2"; shift 2 ;;',
          '    --json)      JSON=1; shift ;;',
          '    -h|--help)   printf \'Usage: %s [-o FILE] [--json]\\n\' "$SCRIPT_NAME"; exit 0 ;;',
          '    *)           die "Unknown option: $1" ;;',
          '  esac',
          'done',
          '',
          'mkdir -p "$OUTPUT_DIR"',
          '[[ -n "$REPORT" ]] || REPORT="${OUTPUT_DIR}/$(hostname -s)-${STARTED_AT}.txt"',
          '',
          '# Every command is guarded. A machine without lsblk produces a report',
          '# with that section marked unavailable, not a script that dies.',
          'have() { command -v "$1" >/dev/null 2>&1; }',
          '',
          'section() {',
          '  printf \'\\n===== %s =====\\n\' "$1"',
          '}',
          '',
          'try_run() {',
          '  local label="$1"; shift',
          '  section "$label"',
          '  if have "$1"; then',
          '    "$@" 2>&1 || printf \'(command failed: %s)\\n\' "$*"',
          '  else',
          '    printf \'(%s is not installed)\\n\' "$1"',
          '  fi',
          '}',
          '',
          `redact() { sed -E 's/((${listOf(str(values, 'redact', '')).join('|')})[^=:]*[=:])[^[:space:]]+/\\1***REDACTED***/Ig'; }`,
          '',
          'collect() {',
          '  printf \'System report for %s\\n\' "$(hostname -f 2>/dev/null || hostname)"',
          '  printf \'Generated %s by %s\\n\' "$(date -Is)" "${SUDO_USER:-$USER}"',
          '  [[ $EUID -eq 0 ]] || printf \'\\nNOT RUNNING AS ROOT — some sections will be incomplete.\\n\'',
          '',
          ...(sections === 'all' || sections === 'hardware'
            ? [
                '  section "Identity"',
                '  { have hostnamectl && hostnamectl; } || uname -a',
                '  printf \'Uptime: %s\\n\' "$(uptime -p 2>/dev/null || uptime)"',
                '  [[ -r /etc/os-release ]] && cat /etc/os-release',
                '',
                '  section "CPU and memory"',
                '  have lscpu && lscpu | grep -Ei \'model name|socket|core|thread|mhz\'',
                '  free -h',
                '  printf \'Load: %s\\n\' "$(cat /proc/loadavg)"',
                '',
                '  try_run "Block devices" lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,UUID',
                '  section "Filesystems"',
                '  df -hT -x tmpfs -x devtmpfs',
                '  printf \'\\nInodes:\\n\'',
                '  df -i -x tmpfs -x devtmpfs',
                '  section "Mounts"',
                '  findmnt -t nosquashfs --real 2>/dev/null || mount | grep -v squashfs',
                '  [[ -r /etc/fstab ]] && { section "fstab"; grep -v \'^#\' /etc/fstab | grep -v \'^$\'; }',
                '  try_run "LVM" vgs',
                '  have lvs && lvs',
                '  try_run "RAID" cat /proc/mdstat',
                '',
                '  section "Network interfaces"',
                '  ip -br addr 2>/dev/null || ifconfig -a',
                '  section "Routes"',
                '  ip route 2>/dev/null || netstat -rn',
                '  section "DNS"',
                '  cat /etc/resolv.conf 2>/dev/null',
                '  have resolvectl && resolvectl status 2>/dev/null | head -30',
                '',
              ]
            : []),
          ...(sections === 'all' || sections === 'security'
            ? [
                '  section "Users with a login shell"',
                '  awk -F: \'$7 !~ /(nologin|false)$/ { printf "%-20s uid=%-6s shell=%s\\n", $1, $3, $7 }\' /etc/passwd',
                '',
                '  section "Sudo"',
                '  if [[ -r /etc/sudoers ]]; then',
                '    grep -Ev \'^\\s*(#|$)\' /etc/sudoers 2>/dev/null',
                '    for file in /etc/sudoers.d/*; do',
                '      [[ -r "$file" ]] || continue',
                '      printf \'--- %s ---\\n\' "$file"',
                '      grep -Ev \'^\\s*(#|$)\' "$file"',
                '    done',
                '  else',
                '    printf \'(cannot read /etc/sudoers — not root)\\n\'',
                '  fi',
                '',
                '  section "SSH configuration"',
                '  if [[ -r /etc/ssh/sshd_config ]]; then',
                '    grep -Ev \'^\\s*(#|$)\' /etc/ssh/sshd_config',
                '  fi',
                '',
                '  section "Authorized keys"',
                '  while IFS=: read -r user _ uid _ _ home _; do',
                '    (( uid >= 1000 || uid == 0 )) || continue',
                '    [[ -r "${home}/.ssh/authorized_keys" ]] || continue',
                '    printf \'%s:\\n\' "$user"',
                "    ssh-keygen -l -f \"${home}/.ssh/authorized_keys\" 2>/dev/null | sed 's/^/  /'",
                '  done < /etc/passwd',
                '',
                '  section "Listening"',
                '  ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null',
                '',
                '  section "Firewall"',
                '  if have nft && nft list ruleset 2>/dev/null | head -60; then :',
                '  elif have iptables && iptables -L -n -v 2>/dev/null | head -60; then :',
                '  elif have firewall-cmd; then firewall-cmd --list-all 2>/dev/null',
                '  else printf \'(no firewall tool found)\\n\'; fi',
                '',
                '  section "SELinux / AppArmor"',
                '  have getenforce && getenforce',
                '  have aa-status && aa-status --summary 2>/dev/null',
                '',
              ]
            : []),
          ...(sections === 'all'
            ? [
                '  section "Failed services"',
                '  have systemctl && systemctl --failed --no-pager',
                '  section "Enabled services"',
                '  have systemctl && systemctl list-unit-files --state=enabled --no-pager --type=service',
                '',
                '  section "Scheduled work"',
                '  have systemctl && systemctl list-timers --all --no-pager',
                '  for file in /etc/crontab /etc/cron.d/*; do',
                '    [[ -r "$file" ]] || continue',
                '    printf \'--- %s ---\\n\' "$file"',
                '    grep -Ev \'^\\s*(#|$)\' "$file"',
                '  done',
                '  have crontab && { printf \'--- root crontab ---\\n\'; crontab -l 2>/dev/null || printf \'(none)\\n\'; }',
                '',
                '  section "Packages"',
                '  if have dpkg-query; then',
                '    dpkg-query -W -f=\'${Package} ${Version}\\n\' | sort',
                '  elif have rpm; then',
                '    rpm -qa --qf \'%{NAME} %{VERSION}-%{RELEASE}\\n\' | sort',
                '  fi',
                '',
                '  section "Updates available"',
                '  if have apt-get; then apt-get -s upgrade 2>/dev/null | grep -E \'^Inst\' | head -40 || true',
                '  elif have dnf; then dnf check-update -q 2>/dev/null | head -40 || true',
                '  elif have yum; then yum check-update -q 2>/dev/null | head -40 || true; fi',
                '',
                '  section "Reboot required"',
                '  [[ -f /var/run/reboot-required ]] && cat /var/run/reboot-required',
                '  have needs-restarting && needs-restarting -r 2>/dev/null',
                '',
                '  section "Kernel messages worth reading"',
                '  dmesg -T --level=err,crit,alert,emerg 2>/dev/null | tail -40 || true',
                '',
              ]
            : []),
          '  printf \'\\n===== end =====\\n\'',
          '}',
          '',
          'log "Collecting into $REPORT"',
          'collect | redact > "$REPORT"',
          'chmod 600 "$REPORT"   # it lists users, ports and package versions',
          'log "Wrote $REPORT ($(wc -l < "$REPORT") lines)"',
          '',
          ...(format === 'json' || format === 'both'
            ? [
                '# A small structured summary beside the text, for anything that reads',
                '# machine output rather than a human.',
                'json_report="${REPORT%.txt}.json"',
                'cat > "$json_report" <<EOF',
                '{',
                '  "hostname": "$(hostname -f 2>/dev/null || hostname)",',
                '  "collected": "$(date -Is)",',
                '  "kernel": "$(uname -r)",',
                '  "os": "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")",',
                '  "uptime_seconds": $(cut -d. -f1 /proc/uptime),',
                '  "cpus": $(nproc),',
                '  "memory_kb": $(awk \'/MemTotal/ {print $2}\' /proc/meminfo),',
                '  "load_1m": $(awk \'{print $1}\' /proc/loadavg),',
                '  "filesystems": [',
                '$(df -P -x tmpfs -x devtmpfs | awk \'NR>1 {printf "    {\\"mount\\": \\"%s\\", \\"size_kb\\": %s, \\"used_percent\\": %s},\\n", $6, $2, substr($5, 1, length($5)-1)}\' | sed \'$ s/,$//\')',
                '  ],',
                '  "failed_units": $(systemctl --failed --no-legend 2>/dev/null | wc -l),',
                '  "reboot_required": $([[ -f /var/run/reboot-required ]] && echo true || echo false)',
                '}',
                'EOF',
                'chmod 600 "$json_report"',
                'log "Wrote $json_report"',
                '',
              ]
            : []),
          ...(bool(values, 'compare', true)
            ? [
                '# The value of a scheduled report is the diff, not the report.',
                'previous="$(find "$OUTPUT_DIR" -maxdepth 1 -name "$(hostname -s)-*.txt" ! -name "$(basename "$REPORT")" -printf \'%T@ %p\\n\' 2>/dev/null |',
                '  sort -rn | head -1 | cut -d\' \' -f2-)"',
                'if [[ -n "$previous" && -r "$previous" ]]; then',
                '  log "Comparing against $(basename "$previous")"',
                '  if diff -q "$previous" "$REPORT" >/dev/null; then',
                '    log "Nothing changed"',
                '  else',
                '    warn "The machine changed since $(basename "$previous"):"',
                '    diff -u "$previous" "$REPORT" | grep -E \'^[+-]\' | grep -Ev \'^[+-]{3}\' | grep -v \'Generated\' | head -60 >&2 || true',
                '  fi',
                'else',
                '  log "No earlier report to compare against"',
                'fi',
                '',
              ]
            : []),
          'printf \'%s\\n\' "$REPORT"',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'sh_log_cleanup',
    platform: PLATFORM,
    label: 'Log and temporary file cleanup',
    group: 'Operations',
    description: 'Reclaim space without deleting the wrong thing: named paths only, an age threshold, open files left alone, and a dry run that reports exactly what would go.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'cleanup-logs' },
      { id: 'targets', label: 'Clean', control: 'textarea', default: '/var/log | *.gz,*.1,*.old | 30\n/var/tmp | * | 14\n/srv/app/logs | *.log | 7', hint: 'path | patterns | days' },
      { id: 'journal_days', label: 'Trim the systemd journal to (days)', control: 'number', default: 14, min: 0, max: 3650, hint: '0 to leave it alone' },
      { id: 'truncate_open', label: 'Open files', control: 'select', default: 'skip', options: [
        { value: 'skip', label: 'Leave them alone' },
        { value: 'truncate', label: 'Truncate rather than delete' },
      ] },
      { id: 'min_free_percent', label: 'Only run when free space is below (%)', control: 'number', default: 0, min: 0, max: 100, hint: '0 to always run' },
      { id: 'package_cache', label: 'Also clear the package cache', control: 'toggle', default: true },
      { id: 'container_prune', label: 'Also prune unused container images', control: 'toggle', default: false },
    ],
    script: (values: BlueprintValues): Script => {
      const name = snake(str(values, 'script_name', 'cleanup-logs'), 'cleanup_logs');
      const targets = str(values, 'targets', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [path, patterns, days] = line.split('|').map((p) => p.trim());
          return { path: path ?? '', patterns: listOf(patterns ?? '*'), days: Number(days) || 30 };
        })
        .filter((t) => t.path);
      const truncateOpen = str(values, 'truncate_open', 'skip') === 'truncate';
      const findings: Finding[] = [];

      if (targets.length === 0) findings.push(error('scripts.sh.no-targets', 'No path was given, so this cleans nothing.', { source: 'ArchToolKit' }));
      for (const target of targets) {
        if (target.path === '/' || target.path === '/var' || target.path === '/usr' || target.path === '/etc') {
          findings.push(error('scripts.sh.dangerous-cleanup-path', `"${target.path}" is a system directory. Cleaning it by pattern will delete something that matters.`, { remediation: 'Name the specific log directory.', source: 'ArchToolKit' }));
        }
        if (target.patterns.includes('*') && target.days < 7) {
          findings.push(
            warning('scripts.sh.broad-and-recent', `"${target.path}" matches everything and keeps only ${target.days} days. That is a wide net over recent data — confirm nothing there is needed.`, { source: 'ArchToolKit' }),
          );
        }
      }
      findings.push(
        warning('scripts.sh.deleting-open-log', 'Deleting a log a process still has open frees no space at all — the inode survives until the process closes it, and `df` will not move while `du` says the file is gone. Truncating it does free the space immediately.', {
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: `Clean ${targets.length} path${targets.length === 1 ? '' : 's'} of old logs and temporary files`,
        effect: 'destructive',
        requires: [
          { what: 'Root, for anything under /var' },
          ...(num(values, 'journal_days', 14) > 0 ? [{ what: 'systemd, for the journal trim' }] : []),
          { what: 'A backup, or certainty that none of it is needed' },
        ],
        parameters: [
          { name: '--dry-run', description: 'List every file that would be deleted, and delete none.', required: false },
          { name: '--force', description: 'Run even when free space is above the threshold.', required: false },
        ],
        notes: [
          'Paths are hard-coded in the script, never taken from an argument. A cleanup script that takes a path is a delete script waiting for a typo.',
          'Deleting a log that a process still has open frees nothing: the inode survives until the process closes it, so `df` does not move while `du` says the file is gone. ' +
            (truncateOpen ? 'Open files are truncated instead, which does free the space immediately.' : 'Open files are left alone and reported — truncate them deliberately, or restart the service.'),
          'Every path is checked for existence and for being a directory before anything is deleted. An unmounted filesystem leaves an empty mount point, and cleaning that would do nothing — but cleaning the wrong path would do a great deal.',
          ...(num(values, 'min_free_percent', 0) > 0 ? [`The whole thing only runs when a filesystem is below ${num(values, 'min_free_percent', 0)}% free, so a scheduled run is a no-op on a healthy machine.`] : []),
        ],
        usage: [`sudo ./${name}.sh --dry-run`, `sudo ./${name}.sh`, `0 3 * * * /usr/local/bin/${name}.sh >> /var/log/${name}.log 2>&1`],
        undo: [
          'Deleted files are gone. There is no undo, which is why --dry-run exists and why it prints every path.',
          'The journal trim is likewise permanent. Journal data older than the threshold is removed.',
        ],
        body: [
          ...preamble(),
          ...scaffolding(),
          '# Paths are in the script, never in an argument. A cleanup script that',
          '# takes a path is a delete script waiting for a typo.',
          'TARGETS=(',
          ...targets.map((t) => `  ${JSON.stringify(`${t.path}|${t.patterns.join(',')}|${t.days}`)}`),
          ')',
          '',
          'FORCE=0',
          'while (( $# > 0 )); do',
          '  case "$1" in',
          '    --dry-run) DRY_RUN=1; shift ;;',
          '    --force)   FORCE=1; shift ;;',
          '    -h|--help) printf \'Usage: %s [--dry-run] [--force]\\n\' "$SCRIPT_NAME"; exit 0 ;;',
          '    *)         die "Unknown option: $1" ;;',
          '  esac',
          'done',
          '',
          '[[ $EUID -eq 0 ]] || warn "Not running as root — some paths will be skipped"',
          '',
          'freed_kb=0',
          'removed=0',
          'skipped_open=0',
          '',
          ...(num(values, 'min_free_percent', 0) > 0
            ? [
                '# A scheduled run should be a no-op on a healthy machine.',
                'if (( ! FORCE )); then',
                '  lowest=100',
                '  while read -r _ _ _ _ percent _; do',
                '    [[ "$percent" == "Use%" ]] && continue',
                '    free=$(( 100 - ${percent%\\%} ))',
                '    (( free < lowest )) && lowest=$free',
                '  done < <(df -P -x tmpfs -x devtmpfs)',
                `  if (( lowest > ${num(values, 'min_free_percent', 0)} )); then`,
                '    log "Lowest free space is ${lowest}% — above the threshold, nothing to do"',
                '    exit 0',
                '  fi',
                '  log "Lowest free space is ${lowest}% — cleaning"',
                'fi',
                '',
              ]
            : []),
          'for entry in "${TARGETS[@]}"; do',
          '  IFS=\'|\' read -r path patterns days <<< "$entry"',
          '',
          '  # An unmounted filesystem leaves an empty mount point. Cleaning that',
          '  # does nothing; cleaning the wrong path does a great deal.',
          '  if [[ ! -d "$path" ]]; then',
          '    warn "Not a directory, skipping: $path"',
          '    continue',
          '  fi',
          '',
          '  log "$path: files matching ${patterns} older than ${days} days"',
          '',
          '  # Build the find expression from the patterns, quoted properly.',
          '  find_args=()',
          '  IFS=\',\' read -ra pattern_list <<< "$patterns"',
          '  for pattern in "${pattern_list[@]}"; do',
          '    find_args+=(-name "$pattern" -o)',
          '  done',
          '  unset "find_args[${#find_args[@]}-1]"   # drop the trailing -o',
          '',
          '  while IFS= read -r -d \'\' file; do',
          '    size_kb=$(du -k "$file" 2>/dev/null | cut -f1) || continue',
          '',
          '    # A deleted-but-open file frees nothing until the process lets go.',
          '    if command -v lsof >/dev/null 2>&1 && lsof -- "$file" >/dev/null 2>&1; then',
          ...(truncateOpen
            ? [
                '      log "  open, truncating: $file (${size_kb}KB)"',
                '      if (( DRY_RUN )); then',
                '        log "  DRY RUN: would truncate $file"',
                '      else',
                '        : > "$file"',
                '      fi',
                '      freed_kb=$(( freed_kb + size_kb ))',
                '      continue',
              ]
            : [
                '      warn "  open, skipping: $file (${size_kb}KB) — truncate it or restart the service"',
                '      skipped_open=$(( skipped_open + 1 ))',
                '      continue',
              ]),
          '    fi',
          '',
          '    if (( DRY_RUN )); then',
          '      log "  DRY RUN: would remove $file (${size_kb}KB)"',
          '    else',
          '      rm -f -- "$file" && log "  removed $file (${size_kb}KB)"',
          '    fi',
          '    freed_kb=$(( freed_kb + size_kb ))',
          '    removed=$(( removed + 1 ))',
          '  done < <(find "$path" -maxdepth 3 -type f \\( "${find_args[@]}" \\) -mtime "+${days}" -print0 2>/dev/null)',
          'done',
          '',
          ...(num(values, 'journal_days', 14) > 0
            ? [
                'if command -v journalctl >/dev/null 2>&1; then',
                `  log "Trimming the journal to ${num(values, 'journal_days', 14)} days"`,
                '  journalctl --disk-usage',
                `  run journalctl --vacuum-time=${num(values, 'journal_days', 14)}d`,
                '  journalctl --disk-usage',
                'fi',
                '',
              ]
            : []),
          ...(bool(values, 'package_cache', true)
            ? [
                'log "Clearing the package cache"',
                'if command -v apt-get >/dev/null 2>&1; then',
                '  run apt-get clean',
                '  run apt-get autoremove -y --purge',
                'elif command -v dnf >/dev/null 2>&1; then',
                '  run dnf clean all',
                'elif command -v yum >/dev/null 2>&1; then',
                '  run yum clean all',
                'fi',
                '',
              ]
            : []),
          ...(bool(values, 'container_prune', false)
            ? [
                '# Unused images only. Never --volumes: that deletes data.',
                'if command -v podman >/dev/null 2>&1; then',
                '  run podman image prune -a -f --filter "until=168h"',
                'elif command -v docker >/dev/null 2>&1; then',
                '  run docker image prune -a -f --filter "until=168h"',
                'fi',
                '',
              ]
            : []),
          'log "Done: $removed files, about $(( freed_kb / 1024 )) MB"',
          ...(truncateOpen ? [] : ['(( skipped_open )) && warn "$skipped_open open files were skipped — restart their service to free that space"']),
          'df -h -x tmpfs -x devtmpfs',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'sh_bulk_ssh',
    platform: PLATFORM,
    label: 'Run a command across many hosts',
    group: 'Operations',
    description: 'The shell equivalent of the estate-wide command: in parallel, with a timeout, collecting failures rather than stopping, and a summary at the end.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'run-everywhere' },
      { id: 'command', label: 'Command', control: 'textarea', default: 'uptime; df -h / | tail -1', hint: 'Run on each host' },
      { id: 'hosts_from', label: 'Hosts from', control: 'select', default: 'file', options: [
        { value: 'file', label: 'A text file' },
        { value: 'argument', label: 'Arguments' },
      ] },
      { id: 'user', label: 'SSH user', control: 'text', default: '', hint: 'Empty to use the SSH config' },
      { id: 'parallel', label: 'Hosts at a time', control: 'number', default: 10, min: 1, max: 200 },
      { id: 'timeout', label: 'Timeout per host (seconds)', control: 'number', default: 30, min: 5, max: 3600 },
      { id: 'sudo', label: 'Run through sudo', control: 'toggle', default: false },
      { id: 'changes', label: 'This command changes things', control: 'toggle', default: false, hint: 'Adds a confirmation and a dry run' },
      { id: 'output', label: 'Output', control: 'select', default: 'grouped', options: [
        { value: 'grouped', label: 'Grouped by host, after everything finishes' },
        { value: 'prefixed', label: 'Streamed, each line prefixed with the host' },
      ] },
    ],
    script: (values: BlueprintValues): Script => {
      const name = snake(str(values, 'script_name', 'run-everywhere'), 'run_everywhere');
      const command = str(values, 'command', 'uptime');
      const changes = bool(values, 'changes', false);
      const fromFile = str(values, 'hosts_from', 'file') === 'file';
      const findings: Finding[] = [];

      if (/rm -rf|mkfs|dd if=|shutdown|reboot|> \/dev\/sd/.test(command) && !changes) {
        findings.push(
          error('scripts.sh.destructive-not-declared', 'The command contains something destructive but "this command changes things" is off — so it will run everywhere with no confirmation and no dry run.', {
            remediation: 'Turn on "This command changes things".',
            source: 'ArchToolKit',
          }),
        );
      }
      if (num(values, 'parallel', 10) > 50) {
        findings.push(
          warning('scripts.sh.parallel-high', 'More than fifty simultaneous SSH connections puts real load on whatever they all authenticate against — a directory, a jump host, a licence server. Start lower.', {
            source: 'ArchToolKit',
          }),
        );
      }
      findings.push(
        warning('scripts.sh.ssh-host-keys', 'StrictHostKeyChecking is left at the SSH default deliberately. Turning it off to make a script "just work" removes the only protection against connecting to the wrong machine — which for a command that changes things is the whole risk.', {
          remediation: 'Distribute known_hosts properly, or use a certificate authority.',
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: 'Run one command across many hosts, and collect what came back',
        effect: changes ? 'repeat-unsafe' : 'read',
        requires: [
          { what: 'ssh, and key-based authentication to the hosts' },
          { what: 'xargs with -P — GNU findutils or busybox' },
          ...(bool(values, 'sudo', false) ? [{ what: 'Passwordless sudo on the targets for this command, or it will hang waiting for a password' }] : []),
        ],
        parameters: [
          ...(fromFile ? [{ name: 'hostfile', description: 'A file with one host per line.', required: true }] : [{ name: 'hosts', description: 'The hosts.', required: true }]),
          { name: '-p, --parallel', description: 'How many at once.', required: false },
          ...(changes ? [{ name: '--dry-run', description: 'List the hosts and run nothing.', required: false }] : []),
        ],
        notes: [
          'A host that fails does not stop the run. Failures are collected and listed at the end with the reason, which is the only way to work across an estate where something is always down.',
          'ConnectTimeout and a per-host timeout are both set. Without them one unreachable host hangs the whole run — SSH will wait a very long time by default.',
          ...(bool(values, 'sudo', false) ? ['sudo is run with -n, so it fails immediately rather than hanging on a password prompt. If that fails, sudo is not passwordless for this command.'] : []),
          ...(changes ? ['This has been marked as changing things, so it asks before starting and supports --dry-run.'] : []),
          'BatchMode=yes means SSH never prompts. A host needing a password fails fast and is reported, rather than stopping everything.',
        ],
        usage: [
          ...(changes ? [`./${name}.sh ${fromFile ? 'hosts.txt' : 'host1 host2'} --dry-run`] : []),
          `./${name}.sh ${fromFile ? 'hosts.txt' : 'host1 host2 host3'}`,
          `./${name}.sh ${fromFile ? 'hosts.txt' : 'host1'} -p 25`,
        ],
        undo: changes
          ? ['This depends on what the command does — write the undo here before running it.', 'The summary lists every host the command succeeded on, which is the list an undo has to cover.']
          : ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble(),
          ...scaffolding(),
          `readonly PARALLEL_DEFAULT=${num(values, 'parallel', 10)}`,
          `readonly TIMEOUT=${num(values, 'timeout', 30)}`,
          `readonly SSH_USER=${JSON.stringify(str(values, 'user', ''))}`,
          'PARALLEL=$PARALLEL_DEFAULT',
          'HOSTS=()',
          '',
          'usage() { printf \'Usage: %s %s [-p N]%s\\n\' "$SCRIPT_NAME" "' + (fromFile ? 'HOSTFILE' : 'HOST...') + '" "' + (changes ? ' [--dry-run]' : '') + '"; }',
          '',
          'while (( $# > 0 )); do',
          '  case "$1" in',
          '    -p|--parallel) PARALLEL="$2"; shift 2 ;;',
          ...(changes ? ['    --dry-run)     DRY_RUN=1; shift ;;'] : []),
          '    -h|--help)     usage; exit 0 ;;',
          '    -*)            usage >&2; die "Unknown option: $1" ;;',
          '    *)             HOSTS+=("$1"); shift ;;',
          '  esac',
          'done',
          '',
          ...(fromFile
            ? [
                '(( ${#HOSTS[@]} == 1 )) || { usage >&2; die "Give exactly one host file"; }',
                '[[ -r "${HOSTS[0]}" ]] || die "Cannot read ${HOSTS[0]}"',
                'mapfile -t HOSTS < <(grep -Ev \'^\\s*(#|$)\' "${HOSTS[0]}")',
              ]
            : ['(( ${#HOSTS[@]} > 0 )) || { usage >&2; die "Give at least one host"; }']),
          '',
          '(( ${#HOSTS[@]} > 0 )) || die "No hosts"',
          'log "${#HOSTS[@]} hosts, $PARALLEL at a time"',
          '',
          ...(changes
            ? [
                'if (( DRY_RUN )); then',
                '  log "DRY RUN: would run on:"',
                '  printf \'  %s\\n\' "${HOSTS[@]}" >&2',
                '  exit 0',
                'fi',
                '',
                '# A command that changes things asks first.',
                'printf \'About to run on %d hosts:\\n\' "${#HOSTS[@]}" >&2',
                'printf \'  %s\\n\' "${HOSTS[@]:0:10}" >&2',
                '(( ${#HOSTS[@]} > 10 )) && printf \'  ... and %d more\\n\' $(( ${#HOSTS[@]} - 10 )) >&2',
                'read -r -p "Continue? [y/N] " answer',
                '[[ "$answer" =~ ^[Yy]$ ]] || die "Cancelled"',
                '',
              ]
            : []),
          'readonly RESULTS="$(mktemp -d)"',
          'CLEANUP+=("$RESULTS")',
          '',
          '# The command, written once to a file the workers read. Embedding it in',
          '# the xargs line would mean quoting it twice.',
          'readonly COMMAND_FILE="${RESULTS}/command.sh"',
          'cat > "$COMMAND_FILE" <<\'REMOTE_COMMAND\'',
          ...command.split('\n').map((l) => l.replace(/\s+$/, '')),
          'REMOTE_COMMAND',
          '',
          'run_one() {',
          '  local host="$1"',
          '  local target="${SSH_USER:+${SSH_USER}@}${host}"',
          '  local out="${RESULTS}/${host//\\//_}.out"',
          '  local status_file="${RESULTS}/${host//\\//_}.status"',
          '',
          '  # BatchMode: never prompt. ConnectTimeout and timeout: never hang.',
          '  if timeout "$TIMEOUT" ssh \\',
          '      -o BatchMode=yes \\',
          '      -o ConnectTimeout=10 \\',
          '      -o LogLevel=ERROR \\',
          `      "$target" ${bool(values, 'sudo', false) ? "'sudo -n bash -s'" : "'bash -s'"} < "$COMMAND_FILE" > "$out" 2>&1; then`,
          '    echo 0 > "$status_file"',
          '  else',
          '    echo "$?" > "$status_file"',
          '  fi',
          '}',
          'export -f run_one',
          'export RESULTS TIMEOUT SSH_USER COMMAND_FILE',
          '',
          'printf \'%s\\n\' "${HOSTS[@]}" |',
          '  xargs -P "$PARALLEL" -I {} bash -c \'run_one "$@"\' _ {}',
          '',
          '# --- results -------------------------------------------------------------',
          'ok=0',
          'failed=()',
          'for host in "${HOSTS[@]}"; do',
          '  safe="${host//\\//_}"',
          '  status="$(cat "${RESULTS}/${safe}.status" 2>/dev/null || echo 255)"',
          '  if [[ "$status" == "0" ]]; then',
          '    ok=$(( ok + 1 ))',
          ...(str(values, 'output', 'grouped') === 'grouped'
            ? [
                '    printf \'\\n===== %s =====\\n\' "$host"',
                '    cat "${RESULTS}/${safe}.out"',
              ]
            : ['    sed "s/^/${host}: /" "${RESULTS}/${safe}.out"']),
          '  else',
          '    # 124 is what timeout returns when it had to kill the command.',
          '    reason="exit $status"',
          '    [[ "$status" == "124" ]] && reason="timed out after ${TIMEOUT}s"',
          '    [[ "$status" == "255" ]] && reason="could not connect"',
          '    failed+=("${host} (${reason})")',
          '    [[ -s "${RESULTS}/${safe}.out" ]] && failed+=("    $(head -2 "${RESULTS}/${safe}.out" | tr \'\\n\' \' \')")',
          '  fi',
          'done',
          '',
          'printf \'\\n\' >&2',
          'log "$ok of ${#HOSTS[@]} succeeded"',
          'if (( ${#failed[@]} > 0 )); then',
          '  warn "Failures:"',
          '  printf \'  %s\\n\' "${failed[@]}" >&2',
          '  exit 1',
          'fi',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'sh_firewall_rules',
    platform: PLATFORM,
    label: 'Firewall rules',
    group: 'Configuration',
    description: 'Apply a rule set idempotently, with the two things that stop a firewall change locking you out: the existing session preserved, and a timer that reverts it if nobody confirms.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'apply-firewall' },
      { id: 'backend', label: 'Backend', control: 'select', default: 'auto', options: [
        { value: 'auto', label: 'Detect — nftables, firewalld or iptables' },
        { value: 'nftables', label: 'nftables' },
        { value: 'firewalld', label: 'firewalld' },
        { value: 'iptables', label: 'iptables' },
      ] },
      { id: 'rules', label: 'Allow', control: 'textarea', default: '22/tcp | 10.0.1.0/24 | SSH from management\n22/tcp | 2001:db8:0:1::/64 | SSH from management over IPv6\n443/tcp | any | HTTPS\n5432/tcp | 10.0.2.0/24 | PostgreSQL from the app tier', hint: 'port/protocol | source | comment. Source is an IPv4 or IPv6 address or network; "any" is everyone over both IPv4 and IPv6, 0.0.0.0/0 is IPv4 only, ::/0 IPv6 only' },
      { id: 'default_policy', label: 'Everything else inbound', control: 'select', default: 'drop', options: [
        { value: 'drop', label: 'Drop — silent' },
        { value: 'reject', label: 'Reject — sends an unreachable, fails faster' },
      ] },
      { id: 'allow_icmp', label: 'Allow ping', control: 'toggle', default: true },
      { id: 'rollback_timer', label: 'Revert after (seconds) unless confirmed', control: 'number', default: 300, min: 0, max: 3600, hint: '0 to disable — not recommended over SSH' },
      { id: 'log_dropped', label: 'Log dropped packets', control: 'toggle', default: false, hint: 'Useful for a day, then it fills the journal' },
    ],
    script: (values: BlueprintValues): Script => {
      const name = snake(str(values, 'script_name', 'apply-firewall'), 'apply_firewall');
      const findings: Finding[] = [];
      const rules = str(values, 'rules', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [port, source, comment] = line.split('|').map((p) => p.trim());
          const [number, protocol] = (port ?? '').split('/');
          const src = ruleSource(source ?? '');
          if (!src) {
            findings.push(error('scripts.sh.bad-source', `"${source}" in "${line}" is not an IPv4 or IPv6 address or network, or "any".`, { source: 'ArchToolKit' }));
          } else if (src.kind === 'net' && (source ?? '').includes('/') && parseCidrAny(source ?? '')?.address !== parseCidrAny(source ?? '')?.network) {
            findings.push(warning('scripts.sh.source-host-bits', `"${source}" has host bits set; it is written as ${src.text}, which is the network it means.`, { source: 'ArchToolKit' }));
          }
          return { port: number ?? '', protocol: (protocol ?? 'tcp').toLowerCase(), src, comment: comment ?? '' };
        })
        .filter((r): r is typeof r & { src: RuleSource } => Boolean(r.port) && r.src !== null);
      const timer = num(values, 'rollback_timer', 300);
      const policy = str(values, 'default_policy', 'drop');
      const icmp = bool(values, 'allow_icmp', true);
      // Which rules each family's table gets. "any" goes in both.
      const forFamily = (family: Family) => rules.filter((r) => r.src.kind === 'any' || r.src.family === family);
      const nftSource = (s: RuleSource) => (s.kind === 'any' ? '' : `${s.family === 6 ? 'ip6' : 'ip'} saddr ${s.text} `);
      // iptables and ip6tables are one family each; "everything" in that family needs no -s.
      const iptSource = (s: RuleSource) => (s.kind === 'any' || isAnyNetwork(s.text) ? '' : ` -s ${s.text}`);
      // One family's INPUT chain. iptables cannot take REJECT as a chain
      // policy, so reject is DROP plus a final REJECT rule.
      const iptablesFamily = (bin: 'iptables' | 'ip6tables', family: Family): string[] => [
        `  ${bin} -F INPUT`,
        `  ${bin} -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
        `  ${bin} -A INPUT -m conntrack --ctstate INVALID -j DROP`,
        `  ${bin} -A INPUT -i lo -j ACCEPT`,
        ...(family === 4
          ? icmp ? ['  iptables -A INPUT -p icmp -j ACCEPT'] : []
          : icmp
            ? ['  ip6tables -A INPUT -p ipv6-icmp -j ACCEPT']
            : ICMPV6_ESSENTIAL_IPT.map((type) => `  ip6tables -A INPUT -p ipv6-icmp --icmpv6-type ${type} -j ACCEPT`)),
        ...forFamily(family).map((r) => `  ${bin} -A INPUT -p ${r.protocol} --dport ${r.port}${iptSource(r.src)} -m comment --comment "${r.comment}" -j ACCEPT`),
        ...(bool(values, 'log_dropped', false) ? [`  ${bin} -A INPUT -m limit --limit 5/min -j LOG --log-prefix "fw-drop: "`] : []),
        ...(policy === 'reject'
          ? [`  ${bin} -A INPUT -p tcp -j REJECT --reject-with tcp-reset`, `  ${bin} -A INPUT -j REJECT --reject-with ${family === 6 ? 'icmp6-port-unreachable' : 'icmp-port-unreachable'}`]
          : []),
        `  ${bin} -P INPUT DROP`,
        `  ${bin} -P FORWARD DROP`,
        `  ${bin} -P OUTPUT ACCEPT`,
      ];

      if (rules.length === 0) findings.push(error('scripts.sh.no-rules', 'No rule was given, so this would apply a default-deny policy and nothing else — which locks out everything including SSH.', { source: 'ArchToolKit' }));
      if (!rules.some((r) => r.port === '22')) {
        findings.push(
          error('scripts.sh.no-ssh-rule', 'No rule allows port 22. Applying this over SSH disconnects you and there is no way back except the console.', {
            remediation: 'Add an SSH rule from the management network.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (timer === 0) {
        findings.push(
          warning('scripts.sh.no-rollback-timer', 'Without the revert timer, a mistake in these rules means a machine you cannot reach. The timer costs nothing and has saved everyone who has ever used it.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (rules.some((r) => (r.src.kind === 'any' || isAnyNetwork(r.src.text)) && r.port === '22')) {
        findings.push(warning('scripts.sh.ssh-from-anywhere', 'SSH is open to the internet. That is a permanent brute-force target — restrict it to the management network or put it behind a bastion.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Apply ${rules.length} firewall rule${rules.length === 1 ? '' : 's'}, default ${str(values, 'default_policy', 'drop')}`,
        effect: 'idempotent',
        requires: [
          { what: 'Root' },
          { what: 'nftables, firewalld or iptables — the script detects which' },
          { what: 'Console or out-of-band access, in case something goes wrong' },
        ],
        parameters: [
          { name: '--dry-run', description: 'Print the rule set that would be applied, and apply nothing.', required: false },
          { name: '--confirm', description: 'Cancel the revert timer, after checking you are still connected.', required: false },
        ],
        notes: [
          'Established and related connections are allowed before anything else. Without that rule the session applying the change is dropped by its own rule set, immediately.',
          ...(timer > 0
            ? [
                `A revert job is scheduled ${timer} seconds ahead before the rules go on. If you lose your session, the old rules come back by themselves. When you have confirmed you are still connected — open a second session and check — run the script again with --confirm to cancel it.`,
                'Do not skip this. It is the difference between a mistake and a drive to the data centre.',
              ]
            : []),
          'Loopback is always allowed. Half of what a machine does talks to itself, and blocking it breaks things in confusing ways.',
          'IPv6 gets the same default policy as IPv4. A firewall that filters only IPv4 leaves every service open over IPv6 on any network with router advertisements, which is most of them — so the iptables backend writes ip6tables rules too, and nftables uses one inet table for both.',
          `A source of "any" allows both IPv4 and IPv6; 0.0.0.0/0 is IPv4 only and ::/0 IPv6 only. Rules from an IPv4 network go only in the IPv4 rules and IPv6 networks only in the IPv6 rules, since no packet can match both.`,
          ...(icmp ? [] : ['Ping is refused, but the ICMPv6 that IPv6 needs to work at all — neighbour discovery, router advertisements, MLD queries and packet-too-big — is still allowed. Blocking those breaks IPv6 outright, a few minutes later, when the neighbour cache expires.']),
          'If this machine takes its IPv6 address from DHCPv6, replies arrive on UDP 546 from a link-local address and conntrack does not always match them to the multicast request; add "546/udp | fe80::/10 | DHCPv6 client" if the address disappears at renewal.',
          ...(bool(values, 'log_dropped', false) ? ['Dropped packets are logged and rate limited. It is useful for a day; leave it on for a week and the journal is mostly firewall logs.'] : []),
        ],
        usage: [`sudo ./${name}.sh --dry-run`, `sudo ./${name}.sh`, `# then, from a NEW session, having confirmed you are still connected:`, `sudo ./${name}.sh --confirm`],
        undo: [
          ...(timer > 0 ? [`Automatic: the rules revert after ${timer} seconds unless --confirm is run.`] : []),
          'Manual: the previous rule set is saved before anything changes, and the path is printed. Restore it with the backend\u2019s own restore command.',
        ],
        body: [
          ...preamble(),
          ...scaffolding(),
          'CONFIRM=0',
          `readonly ROLLBACK_SECONDS=${timer}`,
          'readonly BACKUP_DIR=/var/backups/firewall',
          'readonly ROLLBACK_MARKER=/run/firewall-rollback.job',
          '',
          'while (( $# > 0 )); do',
          '  case "$1" in',
          '    --dry-run) DRY_RUN=1; shift ;;',
          '    --confirm) CONFIRM=1; shift ;;',
          '    -h|--help) printf \'Usage: %s [--dry-run] [--confirm]\\n\' "$SCRIPT_NAME"; exit 0 ;;',
          '    *)         die "Unknown option: $1" ;;',
          '  esac',
          'done',
          '',
          '[[ $EUID -eq 0 ]] || die "This needs root."',
          '',
          'detect_backend() {',
          ...(str(values, 'backend', 'auto') === 'auto'
            ? [
                '  if command -v nft >/dev/null 2>&1 && nft list ruleset >/dev/null 2>&1; then',
                '    echo nftables',
                '  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then',
                '    echo firewalld',
                '  elif command -v iptables >/dev/null 2>&1; then',
                '    echo iptables',
                '  else',
                '    die "No firewall backend found"',
                '  fi',
              ]
            : [`  echo ${str(values, 'backend', 'nftables')}`]),
          '}',
          'readonly BACKEND="$(detect_backend)"',
          'log "Backend: $BACKEND"',
          '',
          '# --- confirm mode --------------------------------------------------------',
          'if (( CONFIRM )); then',
          '  if [[ -r "$ROLLBACK_MARKER" ]]; then',
          '    job="$(cat "$ROLLBACK_MARKER")"',
          '    atrm "$job" 2>/dev/null || systemd-run --unit="$job" --stop 2>/dev/null || true',
          '    rm -f "$ROLLBACK_MARKER"',
          '    log "Revert cancelled. The rules are now permanent."',
          '  else',
          '    log "No revert was pending."',
          '  fi',
          '  exit 0',
          'fi',
          '',
          '# --- back up what is there now -------------------------------------------',
          'mkdir -p "$BACKUP_DIR"',
          'readonly BACKUP="${BACKUP_DIR}/${BACKEND}-${STARTED_AT}.rules"',
          'readonly BACKUP6="${BACKUP_DIR}/ip6tables-${STARTED_AT}.rules"',
          'case "$BACKEND" in',
          '  nftables) nft list ruleset > "$BACKUP" ;;',
          '  iptables)',
          '    iptables-save > "$BACKUP"',
          '    if command -v ip6tables-save >/dev/null 2>&1; then ip6tables-save > "$BACKUP6"; fi',
          '    ;;',
          '  firewalld) firewall-cmd --list-all --permanent > "$BACKUP" 2>/dev/null || true ;;',
          'esac',
          'log "Current rules saved to $BACKUP"',
          '',
          '# --- schedule the revert BEFORE applying ---------------------------------',
          ...(timer > 0
            ? [
                'if (( ! DRY_RUN )); then',
                '  # Scheduled first, deliberately. If the apply locks us out, the',
                '  # revert is already in place.',
                '  revert_script="$(mktemp)"',
                '  cat > "$revert_script" <<REVERT',
                '#!/usr/bin/env bash',
                'case "$BACKEND" in',
                '  nftables)  nft flush ruleset && nft -f "$BACKUP" ;;',
                '  iptables)  iptables-restore < "$BACKUP"; [[ -s "$BACKUP6" ]] && ip6tables-restore < "$BACKUP6" ;;',
                '  firewalld) firewall-cmd --reload ;;',
                'esac',
                'logger -t firewall "Reverted to $BACKUP — nobody confirmed within ${ROLLBACK_SECONDS}s"',
                'REVERT',
                '  chmod 755 "$revert_script"',
                '',
                '  if command -v systemd-run >/dev/null 2>&1; then',
                '    unit="firewall-revert-${STARTED_AT}"',
                '    systemd-run --unit="$unit" --on-active="${ROLLBACK_SECONDS}s" "$revert_script" >/dev/null',
                '    echo "$unit" > "$ROLLBACK_MARKER"',
                '  elif command -v at >/dev/null 2>&1; then',
                '    job="$(echo "$revert_script" | at "now + $(( ROLLBACK_SECONDS / 60 + 1 )) minutes" 2>&1 | grep -oE \'job [0-9]+\' | cut -d\' \' -f2)"',
                '    echo "$job" > "$ROLLBACK_MARKER"',
                '  else',
                '    warn "Neither systemd-run nor at is available — NO REVERT IS SCHEDULED."',
                '    read -r -p "Continue without a safety net? [y/N] " answer',
                '    [[ "$answer" =~ ^[Yy]$ ]] || die "Cancelled"',
                '  fi',
                `  log "Rules will revert in ${timer}s unless you run: $SCRIPT_NAME --confirm"`,
                'fi',
                '',
              ]
            : []),
          '# --- the rule set --------------------------------------------------------',
          'apply_nftables() {',
          '  local ruleset',
          '  ruleset="$(cat <<\'RULES\'',
          '# inet: one table for IPv4 and IPv6, so neither family is left open.',
          'table inet filter {',
          '  chain input {',
          // A base chain's policy can only be accept or drop; reject is a rule at the end.
          '    type filter hook input priority 0; policy drop;',
          '',
          '    # First, always. Without this the session applying the change is',
          '    # dropped by its own rule set, immediately.',
          '    ct state established,related accept',
          '    ct state invalid drop',
          '',
          '    # Half of what a machine does talks to itself.',
          '    iif lo accept',
          '',
          ...(icmp
            ? ['    ip protocol icmp accept', '    meta l4proto ipv6-icmp accept', '']
            : ['    # IPv6 does not work without these, ping or no ping.', `    icmpv6 type { ${ICMPV6_ESSENTIAL_NFT} } accept`, '']),
          ...rules.map((r) => `    ${nftSource(r.src)}${r.protocol} dport ${r.port} accept comment "${r.comment}"`),
          '',
          ...(bool(values, 'log_dropped', false) ? ['    limit rate 5/minute burst 10 packets log prefix "fw-drop: " level info', ''] : []),
          ...(policy === 'reject' ? ['    meta l4proto tcp reject with tcp reset', '    reject with icmpx type port-unreachable'] : []),
          '  }',
          '',
          '  chain forward { type filter hook forward priority 0; policy drop; }',
          '  chain output  { type filter hook output  priority 0; policy accept; }',
          '}',
          'RULES',
          '  )"',
          '',
          '  if (( DRY_RUN )); then',
          '    log "DRY RUN: would apply this rule set:"',
          '    printf \'%s\\n\' "$ruleset"',
          '    return 0',
          '  fi',
          '',
          '  printf \'%s\\n\' "$ruleset" > /etc/nftables.conf.new',
          '  nft -c -f /etc/nftables.conf.new || die "The rule set did not parse. Nothing was applied."',
          '  nft flush ruleset',
          '  nft -f /etc/nftables.conf.new',
          '  mv /etc/nftables.conf.new /etc/nftables.conf',
          '}',
          '',
          'apply_firewalld() {',
          // A plain port is open to both families; a rich rule names the family of its source.
          ...rules.flatMap((r) =>
            r.src.kind === 'any'
              ? [`  run firewall-cmd --permanent --add-port=${r.port}/${r.protocol}`]
              : [`  run firewall-cmd --permanent --add-rich-rule='rule family="${r.src.family === 6 ? 'ipv6' : 'ipv4'}" source address="${r.src.text}" port port="${r.port}" protocol="${r.protocol}" accept'`],
          ),
          // echo-request covers ping over IPv4 and IPv6; neighbour discovery is not an icmp-block and keeps working.
          ...(icmp ? [] : ['  run firewall-cmd --permanent --add-icmp-block=echo-request']),
          '  run firewall-cmd --reload',
          '}',
          '',
          'apply_iptables() {',
          '  if (( DRY_RUN )); then',
          '    log "DRY RUN: would apply the iptables rules"',
          '    return 0',
          '  fi',
          ...iptablesFamily('iptables', 4),
          '',
          '  # The same policy for IPv6. Filtering only IPv4 leaves every service',
          '  # open over IPv6, which the host has whenever a router advertises it.',
          '  if command -v ip6tables >/dev/null 2>&1; then',
          ...iptablesFamily('ip6tables', 6).map((line) => `  ${line}`),
          '  else',
          '    warn "ip6tables is not installed: IPv6 is NOT filtered. Install it, or disable IPv6, before relying on this firewall."',
          '  fi',
          '  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save; fi',
          '}',
          '',
          'case "$BACKEND" in',
          '  nftables)  apply_nftables ;;',
          '  firewalld) apply_firewalld ;;',
          '  iptables)  apply_iptables ;;',
          'esac',
          '',
          '(( DRY_RUN )) && { log "Dry run complete — nothing applied"; exit 0; }',
          '',
          'log "Applied. Verifying:"',
          'case "$BACKEND" in',
          '  nftables)  nft list ruleset | head -40 ;;',
          '  firewalld) firewall-cmd --list-all ;;',
          '  iptables)  iptables -L INPUT -n -v --line-numbers; if command -v ip6tables >/dev/null 2>&1; then ip6tables -L INPUT -n -v --line-numbers; fi ;;',
          'esac',
          '',
          ...(timer > 0
            ? [
                'warn "==============================================================="',
                'warn "OPEN A NEW SESSION NOW and confirm you can still reach this"',
                'warn "machine. If you can, run:  $SCRIPT_NAME --confirm"',
                `warn "If you do nothing, the old rules come back in ${timer} seconds."`,
                'warn "==============================================================="',
              ]
            : ['log "No revert timer was set. The rules are permanent."']),
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'sh_certificate_renew',
    platform: PLATFORM,
    label: 'Certificate renewal and reload',
    group: 'Configuration',
    description: 'Renew a certificate and reload what uses it — with the check that it actually renewed, and the reload that everybody forgets until the browser is still showing the old one.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'renew-certificates' },
      { id: 'method', label: 'Renew with', control: 'select', default: 'certbot', options: [
        { value: 'certbot', label: 'certbot' },
        { value: 'acme', label: 'acme.sh' },
        { value: 'check-only', label: 'Check expiry only — renewal happens elsewhere' },
      ] },
      { id: 'domains', label: 'Domains', control: 'textarea', default: 'www.example.com\napi.example.com' },
      { id: 'renew_days', label: 'Renew when fewer days remain', control: 'number', default: 30, min: 1, max: 90 },
      { id: 'reload', label: 'Reload after renewal', control: 'text', default: 'nginx, haproxy', hint: 'Services to reload — a comma separated list' },
      { id: 'verify_after', label: 'Verify the new certificate is being served', control: 'toggle', default: true },
      { id: 'copy_to', label: 'Also copy to', control: 'textarea', default: '', hint: 'path | owner:group | mode — for things that cannot read the live directory' },
    ],
    script: (values: BlueprintValues): Script => {
      const name = snake(str(values, 'script_name', 'renew-certificates'), 'renew_certificates');
      const method = str(values, 'method', 'certbot');
      const domains = listOf(str(values, 'domains', '').replace(/\n/g, ','));
      const services = listOf(str(values, 'reload', ''));
      const findings: Finding[] = [];

      if (domains.length === 0) findings.push(error('scripts.sh.no-domains', 'No domain was given.', { source: 'ArchToolKit' }));
      if (method !== 'check-only' && services.length === 0) {
        findings.push(
          error('scripts.sh.no-reload', 'A renewed certificate is a file on disk. Until the service reloads, it keeps serving the old one — and the browser keeps showing the expiry warning while the file on disk is perfectly valid. That is the single most common certificate renewal failure.', {
            remediation: 'Name the services that have to reload.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (services.some((s) => /nginx|haproxy|apache/.test(s))) {
        findings.push(
          warning('scripts.sh.reload-not-restart', 'Reload, not restart. A reload picks up the new certificate without dropping connections; a restart drops every connection in flight. The generated script reloads.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Renew ${domains.length} certificate${domains.length === 1 ? '' : 's'} and reload ${services.join(', ') || 'nothing'}`,
        effect: method === 'check-only' ? 'read' : 'idempotent',
        requires: [
          ...(method === 'certbot' ? [{ what: 'certbot', how: 'apt install certbot   # or dnf install certbot' }] : []),
          ...(method === 'acme' ? [{ what: 'acme.sh', how: 'curl https://get.acme.sh | sh' }] : []),
          { what: 'Root, to read the private keys and reload the services' },
          { what: 'openssl, for the expiry checks' },
        ],
        parameters: [
          { name: '--dry-run', description: 'Check and report, renew nothing.', required: false },
          { name: '--force', description: 'Renew regardless of how long is left.', required: false },
        ],
        notes: [
          'A renewed certificate is a file. Until the service reloads it keeps serving the old one — the browser still shows the expiry warning while the file on disk is fine. That is the most common way a renewal "fails".',
          'Reload, not restart: a reload picks up the new certificate without dropping connections in flight.',
          ...(bool(values, 'verify_after', true) ? ['After the reload, the certificate actually being served is read back from the socket and compared. That is the only check that proves the whole chain worked.'] : []),
          'The renewal is skipped when there is plenty of time left, so this is safe to run daily from cron — and it should be, because a weekly schedule has no retries before expiry.',
          ...(str(values, 'copy_to', '') ? ['Copies are made after a successful renewal, with the ownership and mode set explicitly. A private key readable by everyone is worse than an expired certificate.'] : []),
        ],
        usage: [`sudo ./${name}.sh --dry-run`, `sudo ./${name}.sh`, `# daily, because a weekly schedule leaves no room for a retry:`, `17 3 * * * /usr/local/bin/${name}.sh >> /var/log/${name}.log 2>&1`],
        undo: [
          'certbot and acme.sh both keep the previous certificate. certbot: the archive directory holds every version.',
          'To go back: point the live symlink at the previous version and reload the services.',
          'Nothing here deletes a certificate.',
        ],
        body: [
          ...preamble(),
          ...scaffolding(),
          `readonly RENEW_DAYS=${num(values, 'renew_days', 30)}`,
          'FORCE=0',
          'RENEWED=0',
          '',
          'while (( $# > 0 )); do',
          '  case "$1" in',
          '    --dry-run) DRY_RUN=1; shift ;;',
          '    --force)   FORCE=1; shift ;;',
          '    -h|--help) printf \'Usage: %s [--dry-run] [--force]\\n\' "$SCRIPT_NAME"; exit 0 ;;',
          '    *)         die "Unknown option: $1" ;;',
          '  esac',
          'done',
          '',
          '[[ $EUID -eq 0 ]] || die "This needs root to read the keys and reload the services."',
          'command -v openssl >/dev/null 2>&1 || die "openssl is required"',
          '',
          `DOMAINS=(${domains.map((d) => JSON.stringify(d)).join(' ')})`,
          '',
          'days_left() {',
          '  local cert="$1"',
          '  [[ -r "$cert" ]] || { echo -1; return; }',
          '  local end epoch now',
          '  end="$(openssl x509 -enddate -noout -in "$cert" 2>/dev/null | cut -d= -f2)" || { echo -1; return; }',
          '  epoch="$(date -d "$end" +%s 2>/dev/null)" || { echo -1; return; }',
          '  now="$(date +%s)"',
          '  echo $(( (epoch - now) / 86400 ))',
          '}',
          '',
          'served_fingerprint() {',
          '  local host="$1"',
          '  echo | timeout 10 openssl s_client -connect "${host}:443" -servername "$host" 2>/dev/null |',
          '    openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2',
          '}',
          '',
          'file_fingerprint() {',
          '  openssl x509 -noout -fingerprint -sha256 -in "$1" 2>/dev/null | cut -d= -f2',
          '}',
          '',
          '# --- check ---------------------------------------------------------------',
          'needs_renewal=()',
          'for domain in "${DOMAINS[@]}"; do',
          ...(method === 'certbot'
            ? ['  cert="/etc/letsencrypt/live/${domain}/fullchain.pem"']
            : method === 'acme'
              ? ['  cert="${HOME}/.acme.sh/${domain}/fullchain.cer"']
              : ['  cert="/etc/ssl/certs/${domain}.pem"']),
          '',
          '  left="$(days_left "$cert")"',
          '  if (( left < 0 )); then',
          '    warn "$domain: no readable certificate at $cert"',
          '    needs_renewal+=("$domain")',
          '    continue',
          '  fi',
          '',
          '  log "$domain: $left days left"',
          '  if (( FORCE || left < RENEW_DAYS )); then',
          '    needs_renewal+=("$domain")',
          '  fi',
          'done',
          '',
          'if (( ${#needs_renewal[@]} == 0 )); then',
          '  log "Nothing needs renewing"',
          '  exit 0',
          'fi',
          'log "Renewing: ${needs_renewal[*]}"',
          '',
          ...(method === 'check-only'
            ? [
                'warn "Renewal is handled elsewhere. These need attention: ${needs_renewal[*]}"',
                'exit 1',
              ]
            : [
                '# --- renew ---------------------------------------------------------------',
                'for domain in "${needs_renewal[@]}"; do',
                ...(method === 'certbot'
                  ? [
                      '  if (( DRY_RUN )); then',
                      '    log "DRY RUN: certbot renew --cert-name $domain"',
                      '    certbot renew --cert-name "$domain" --dry-run 2>&1 | tail -5 || warn "The certbot dry run failed for $domain"',
                      '    continue',
                      '  fi',
                      '  # --deploy-hook is deliberately not used: the reload is done below,',
                      '  # once, after every renewal, and then verified.',
                      '  if certbot renew --cert-name "$domain" --non-interactive --quiet; then',
                      '    log "Renewed $domain"',
                      '    RENEWED=1',
                      '  else',
                      '    warn "certbot failed for $domain"',
                      '  fi',
                    ]
                  : [
                      '  if (( DRY_RUN )); then',
                      '    log "DRY RUN: acme.sh --renew -d $domain"',
                      '    continue',
                      '  fi',
                      '  if "${HOME}/.acme.sh/acme.sh" --renew -d "$domain" --force; then',
                      '    log "Renewed $domain"',
                      '    RENEWED=1',
                      '  else',
                      '    warn "acme.sh failed for $domain"',
                      '  fi',
                    ]),
                'done',
                '',
                '(( DRY_RUN )) && { log "Dry run complete"; exit 0; }',
                '(( RENEWED )) || { warn "Nothing renewed successfully"; exit 1; }',
                '',
                ...(str(values, 'copy_to', '')
                  ? [
                      '# --- copies --------------------------------------------------------------',
                      '# A private key readable by everyone is worse than an expired certificate.',
                      ...str(values, 'copy_to', '')
                        .split('\n')
                        .map((l) => l.trim())
                        .filter(Boolean)
                        .flatMap((line) => {
                          const [path, owner, mode] = line.split('|').map((p) => p.trim());
                          return [
                            `log "Copying to ${path}"`,
                            `install -o ${owner ?? 'root:root'} -m ${mode ?? '0600'} \\`,
                            `  "/etc/letsencrypt/live/${domains[0] ?? 'example.com'}/fullchain.pem" ${JSON.stringify(path ?? '/tmp/cert.pem')}`,
                          ];
                        }),
                      '',
                    ]
                  : []),
                '# --- reload ---------------------------------------------------------------',
                '# The part everybody forgets. Until the service reloads, it serves the',
                '# old certificate and the browser still shows the warning.',
                ...(services.length > 0
                  ? [
                      `for service in ${services.map((s) => JSON.stringify(s)).join(' ')}; do`,
                      '  if ! systemctl is-active --quiet "$service"; then',
                      '    warn "$service is not running — nothing to reload"',
                      '    continue',
                      '  fi',
                      '  # Reload, not restart: a reload keeps the connections in flight.',
                      '  if systemctl reload "$service"; then',
                      '    log "Reloaded $service"',
                      '  else',
                      '    warn "Reload failed for $service — trying a restart"',
                      '    systemctl restart "$service" || warn "$service could not be restarted"',
                      '  fi',
                      'done',
                      '',
                    ]
                  : []),
                ...(bool(values, 'verify_after', true)
                  ? [
                      '# --- verify ---------------------------------------------------------------',
                      '# Reading the certificate back off the socket is the only check that',
                      '# proves the whole chain worked.',
                      'sleep 3',
                      'failures=0',
                      'for domain in "${needs_renewal[@]}"; do',
                      ...(method === 'certbot'
                        ? ['  cert="/etc/letsencrypt/live/${domain}/fullchain.pem"']
                        : ['  cert="${HOME}/.acme.sh/${domain}/fullchain.cer"']),
                      '  on_disk="$(file_fingerprint "$cert")"',
                      '  served="$(served_fingerprint "$domain")"',
                      '',
                      '  if [[ -z "$served" ]]; then',
                      '    warn "$domain: could not read the certificate being served"',
                      '    failures=$(( failures + 1 ))',
                      '  elif [[ "$on_disk" == "$served" ]]; then',
                      '    log "$domain: serving the new certificate ($(days_left "$cert") days left)"',
                      '  else',
                      '    warn "$domain: STILL SERVING THE OLD CERTIFICATE. The file renewed but the service did not pick it up."',
                      '    failures=$(( failures + 1 ))',
                      '  fi',
                      'done',
                      '',
                      '(( failures == 0 )) || exit 1',
                      '',
                    ]
                  : []),
                'log "Done"',
              ]),
        ],
        findings,
      };
    },
  }),
];
