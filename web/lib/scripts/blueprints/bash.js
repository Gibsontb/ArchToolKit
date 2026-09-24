/**
 * Bash: the scripts that end up in /usr/local/bin and in cron.
 *
 * Every one of them opens the same way — `set -euo pipefail`, a trap that
 * cleans up whatever happens, a usage function, logging with timestamps, and a
 * `--dry-run` on anything that changes something. That opening is most of what
 * separates a script that fails loudly from one that carries on after an error
 * and does half the job.
 *
 * The things that go wrong in shell scripts are well known and always the same:
 * an unquoted variable with a space in it, a `cd` that failed and left the next
 * line running somewhere else, a pipeline whose exit code came from the last
 * command rather than the one that failed, and `rm -rf "$DIR/"` where `$DIR`
 * was empty. Everything generated here is written against those.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { scriptBlueprint,                      } from '../from-script.js';
import { identifier, listOf, snake,             } from '../script.js';

const PLATFORM = 'bash'         ;

/**
 * The opening every generated script shares.
 *
 * `set -e` stops on an error, `-u` makes an unset variable an error rather than
 * an empty string, and `-o pipefail` makes a pipeline fail when any part of it
 * does rather than only the last. The three together turn most silent failures
 * into loud ones.
 */
function preamble()           {
  return [
    'set -euo pipefail',
    'IFS=$\'\\n\\t\'',
    '',
    'readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"',
    'readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'readonly STARTED_AT="$(date +%Y%m%d-%H%M%S)"',
    '',
  ];
}

/** Logging and the trap, which every script needs and most do not have. */
function scaffolding()           {
  return [
    'log()  { printf \'%s [%s] %s\\n\' "$(date +\'%Y-%m-%d %H:%M:%S\')" "INFO" "$*" >&2; }',
    'warn() { printf \'%s [%s] %s\\n\' "$(date +\'%Y-%m-%d %H:%M:%S\')" "WARN" "$*" >&2; }',
    'die()  { printf \'%s [%s] %s\\n\' "$(date +\'%Y-%m-%d %H:%M:%S\')" "ERROR" "$*" >&2; exit 1; }',
    '',
    '# Anything registered here runs whether the script succeeds, fails or is',
    '# interrupted. It is the only reliable way to clean up in shell.',
    'CLEANUP=()',
    'cleanup() {',
    '  local status=$?',
    '  for item in "${CLEANUP[@]:-}"; do',
    '    [[ -e "$item" ]] && rm -rf -- "$item"',
    '  done',
    '  if (( status != 0 )); then',
    '    warn "$SCRIPT_NAME exited with status $status"',
    '  fi',
    '  exit "$status"',
    '}',
    'trap cleanup EXIT INT TERM',
    '',
  ];
}

export const BASH_BASE                             = [
  scriptBlueprint({
    id: 'sh_skeleton',
    platform: PLATFORM,
    label: 'Script skeleton',
    group: 'Scaffolding',
    description: 'The opening every shell script should have: strict mode, a trap, usage, argument parsing, logging, a lock so two copies cannot run at once, and a dry run.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'maintenance' },
      { id: 'summary', label: 'What it does', control: 'text', default: 'Runs the nightly maintenance tasks' },
      { id: 'options', label: 'Options it takes', control: 'text', default: 'target:, environment:, force', hint: 'name: for one that takes a value, name for a flag' },
      { id: 'lock', label: 'Refuse to run twice at once', control: 'toggle', default: true },
      { id: 'require_root', label: 'Require root', control: 'toggle', default: false },
      { id: 'dry_run', label: 'Include --dry-run', control: 'toggle', default: true },
      { id: 'log_file', label: 'Also write to a log file', control: 'text', default: '/var/log/vcf-automation', hint: 'Empty for stderr only' },
    ],
    script: (values                 )         => {
      const name = snake(str(values, 'script_name', 'script'), 'script');
      const options = listOf(str(values, 'options', ''));
      const dryRun = bool(values, 'dry_run', true);
      const lock = bool(values, 'lock', true);
      const logFile = str(values, 'log_file', '');
      const findings            = [];
      if (!lock) {
        findings.push(
          warning('scripts.sh.no-lock', 'Without a lock, a run that overruns its schedule will be joined by the next one. Two copies of a maintenance script working on the same files is a specific and unpleasant kind of failure.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `${name} — ${str(values, 'summary', 'a shell script')}`,
        effect: dryRun ? 'idempotent' : 'read',
        requires: [
          { what: 'Bash 4.0 or later — this uses arrays and `local`' },
          ...(bool(values, 'require_root', false) ? [{ what: 'Root, or sudo' }] : []),
          ...(lock ? [{ what: 'flock, from util-linux — present on any mainstream distribution' }] : []),
        ],
        parameters: [
          ...options.map((option) => ({
            name: `--${option.replace(/:$/, '')}`,
            description: option.endsWith(':') ? 'Takes a value.' : 'A flag.',
            required: false,
          })),
          ...(dryRun ? [{ name: '--dry-run', description: 'Report what would happen and change nothing.', required: false }] : []),
          { name: '-v, --verbose', description: 'Show each step.', required: false },
          { name: '-h, --help', description: 'Usage.', required: false },
        ],
        notes: [
          '`set -euo pipefail` is the whole point of this skeleton. Without it, a failing command in the middle carries on to the next line and the script reports success.',
          'The trap runs on exit, on interrupt and on termination, so temporary files are cleaned up even when the script is killed.',
          ...(lock ? ['The lock is held on a file descriptor, so it is released by the kernel when the process ends — including when it is killed with -9, which a lock file on disk would not survive.'] : []),
          'Every variable is quoted. An unquoted "$path" with a space in it is the most common bug in shell, and it usually appears in production rather than in testing.',
        ],
        usage: [`./${name}.sh --help`, ...(dryRun ? [`./${name}.sh --dry-run --verbose`] : []), `./${name}.sh${options[0] ? ` --${options[0].replace(/:$/, '')} value` : ''}`],
        undo: dryRun ? ['What there is to undo depends on what goes in run(). Write it here as that is filled in.', '--dry-run changes nothing, so it is always safe.'] : ['Nothing to undo — this skeleton reads and reports.'],
        body: [
          ...preamble(),
          ...scaffolding(),
          ...(logFile
            ? [
                `readonly LOG_DIR=${JSON.stringify(logFile)}`,
                'readonly LOG_FILE="${LOG_DIR}/${SCRIPT_NAME%.sh}-${STARTED_AT}.log"',
                'mkdir -p "$LOG_DIR"',
                '# Send everything to the log as well as to the terminal.',
                'exec > >(tee -a "$LOG_FILE") 2>&1',
                '',
              ]
            : []),
          'usage() {',
          '  cat <<EOF',
          `${str(values, 'summary', '')}`,
          '',
          'Usage: $SCRIPT_NAME [options]',
          '',
          'Options:',
          ...options.map((option) => {
            const flag = option.replace(/:$/, '');
            return `  --${flag}${option.endsWith(':') ? ' VALUE' : ''}${' '.repeat(Math.max(1, 20 - flag.length))}TODO: describe it`;
          }),
          ...(dryRun ? ['  --dry-run           report what would happen and change nothing'] : []),
          '  -v, --verbose       show each step',
          '  -h, --help          this',
          'EOF',
          '}',
          '',
          '# Defaults, before anything from the command line.',
          ...options.map((option) => `${snake(option.replace(/:$/, ''), 'opt').toUpperCase()}=""`),
          ...(dryRun ? ['DRY_RUN=0'] : []),
          'VERBOSE=0',
          '',
          'parse_args() {',
          '  while (( $# > 0 )); do',
          '    case "$1" in',
          ...options.flatMap((option) => {
            const flag = option.replace(/:$/, '');
            const variable = snake(flag, 'opt').toUpperCase();
            return option.endsWith(':')
              ? [`      --${flag})`, `        [[ $# -ge 2 ]] || die "--${flag} needs a value"`, `        ${variable}="$2"; shift 2 ;;`]
              : [`      --${flag})`, `        ${variable}=1; shift ;;`];
          }),
          ...(dryRun ? ['      --dry-run)', '        DRY_RUN=1; shift ;;'] : []),
          '      -v|--verbose)',
          '        VERBOSE=1; shift ;;',
          '      -h|--help)',
          '        usage; exit 0 ;;',
          '      --)',
          '        shift; break ;;',
          '      -*)',
          '        usage >&2; die "Unknown option: $1" ;;',
          '      *)',
          '        break ;;',
          '    esac',
          '  done',
          '',
          '  (( VERBOSE )) && set -x || true',
          '}',
          '',
          '# Anything that changes something goes through this, so --dry-run works',
          '# everywhere rather than in the two places someone remembered.',
          'run() {',
          ...(dryRun
            ? [
                '  if (( DRY_RUN )); then',
                "    printf '%s [%s] %s\\n' \"$(date +'%Y-%m-%d %H:%M:%S')\" \"DRYRUN\" \"$*\" >&2",
                '    return 0',
                '  fi',
              ]
            : []),
          '  log "+ $*"',
          '  "$@"',
          '}',
          '',
          'require() {',
          '  local missing=()',
          '  for command in "$@"; do',
          '    command -v "$command" >/dev/null 2>&1 || missing+=("$command")',
          '  done',
          '  (( ${#missing[@]} == 0 )) || die "Missing required command(s): ${missing[*]}"',
          '}',
          '',
          'main() {',
          '  parse_args "$@"',
          '',
          ...(bool(values, 'require_root', false)
            ? ['  [[ $EUID -eq 0 ]] || die "This needs root. Run it with sudo."', '']
            : []),
          ...(lock
            ? [
                '  # Hold the lock on a file descriptor. The kernel releases it when this',
                '  # process ends, however it ends — which a lock file on disk would not.',
                '  local lockfile="/var/lock/${SCRIPT_NAME%.sh}.lock"',
                '  exec 200>"$lockfile"',
                '  flock -n 200 || die "Another copy is already running (lock: $lockfile)"',
                '',
              ]
            : []),
          '  require date mkdir',
          '',
          '  log "$SCRIPT_NAME starting"',
          ...options.map((option) => {
            const variable = snake(option.replace(/:$/, ''), 'opt').toUpperCase();
            return `  log "${variable}=\${${variable}:-(unset)}"`;
          }),
          '',
          '  # The work goes here. Route anything that changes something through run().',
          '  #',
          '  #   run mkdir -p /srv/example',
          '  #   run systemctl restart example.service',
          '',
          '  log "$SCRIPT_NAME finished"',
          '}',
          '',
          'main "$@"',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'sh_backup',
    platform: PLATFORM,
    label: 'Backup with rotation and verification',
    group: 'Operations',
    description: 'Take a backup, prove it is readable, and delete the old ones — with the retention rule and the verification step that separate a backup from a file that might be one.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'backup-app' },
      { id: 'what', label: 'What to back up', control: 'select', default: 'directory', options: [
        { value: 'directory', label: 'A directory' },
        { value: 'mysql', label: 'A MySQL or MariaDB database' },
        { value: 'postgres', label: 'A PostgreSQL database' },
        { value: 'both', label: 'A directory and a database' },
      ] },
      { id: 'source', label: 'Directory', control: 'text', default: '/srv/app/data', showWhen: { input: 'what', equals: ['directory', 'both'] } },
      { id: 'database', label: 'Database', control: 'text', default: 'appdb', showWhen: { input: 'what', equals: ['mysql', 'postgres', 'both'] } },
      { id: 'destination', label: 'Backup directory', control: 'text', default: '/backup/app' },
      { id: 'keep_daily', label: 'Keep daily backups for (days)', control: 'number', default: 14, min: 1, max: 365 },
      { id: 'keep_weekly', label: 'Keep a weekly for (weeks)', control: 'number', default: 8, min: 0, max: 520 },
      { id: 'compression', label: 'Compression', control: 'select', default: 'zstd', options: [
        { value: 'zstd', label: 'zstd — fast, good ratio' },
        { value: 'gzip', label: 'gzip — everywhere' },
        { value: 'none', label: 'None' },
      ] },
      { id: 'verify', label: 'Verify after writing', control: 'toggle', default: true },
      { id: 'offsite', label: 'Copy offsite afterwards', control: 'text', default: '', hint: 'An rsync target or an S3 URL — empty for none' },
    ],
    script: (values                 )         => {
      const name = snake(str(values, 'script_name', 'backup'), 'backup');
      const what = str(values, 'what', 'directory');
      const compression = str(values, 'compression', 'zstd');
      const verify = bool(values, 'verify', true);
      const destination = str(values, 'destination', '');
      const offsite = str(values, 'offsite', '');
      const findings            = [];
      if (!verify) {
        findings.push(
          warning('scripts.sh.unverified-backup', 'A backup that has never been read is not a backup. Verification here only proves the archive is readable — it does not prove the data inside it is usable, which is what a restore test is for.', {
            remediation: 'Leave verification on, and restore from a backup to a scratch machine on a schedule.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!offsite) {
        findings.push(
          warning('scripts.sh.no-offsite', 'A backup on the same machine survives a mistake and nothing else — not a failed array, not a fire, not ransomware that reaches the whole filesystem.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (destination && (what === 'directory' || what === 'both') && str(values, 'source', '').startsWith(destination)) {
        findings.push(error('scripts.sh.backup-inside-source', 'The backup directory is inside the directory being backed up, so each backup will contain the previous ones and grow without limit.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Back up ${what === 'directory' ? str(values, 'source', 'a directory') : what === 'both' ? 'a directory and a database' : 'a database'} to ${destination || 'a backup directory'}`,
        effect: 'idempotent',
        requires: [
          { what: 'tar' },
          ...(compression === 'zstd' ? [{ what: 'zstd', how: 'apt install zstd   # or dnf install zstd' }] : []),
          ...(what === 'mysql' || what === 'both' ? [{ what: 'mysqldump, and credentials in ~/.my.cnf', how: 'chmod 600 ~/.my.cnf   # [client] user= and password= go in there, not in this script' }] : []),
          ...(what === 'postgres' || what === 'both' ? [{ what: 'pg_dump, and credentials in ~/.pgpass', how: 'chmod 600 ~/.pgpass' }] : []),
          { what: 'Enough free space in the backup directory for one more backup than the retention keeps' },
        ],
        parameters: [
          { name: '--dry-run', description: 'Report what would be backed up and deleted, and do neither.', required: false },
          { name: '--verbose', description: 'Show each step.', required: false },
        ],
        notes: [
          'Credentials are read from ~/.my.cnf or ~/.pgpass, never from this file and never from the command line — a password in an argument is visible in `ps` to every user on the machine.',
          'The backup is written to a temporary name and renamed only once it is complete. A backup interrupted half way through is never left looking finished.',
          'Rotation runs after the new backup succeeds, never before. A failed backup must not be the reason the old ones were deleted.',
          ...(verify ? ['Verification lists the archive back, which proves it is readable and not truncated. It does not prove the contents restore — only a restore test does that.'] : []),
          'Free space is checked before starting. Filling the backup volume takes the application down with it on most layouts.',
        ],
        usage: [`./${name}.sh --dry-run`, `./${name}.sh`, `# in cron:`, `0 2 * * * /usr/local/bin/${name}.sh >> /var/log/${name}.log 2>&1`],
        undo: [
          'Nothing to undo — this creates files and deletes only ones older than the retention.',
          'To restore: tar -x -f <backup> -C /restore/target   (test it somewhere that is not production first)',
        ],
        body: [
          ...preamble(),
          ...scaffolding(),
          `readonly DESTINATION=${JSON.stringify(destination)}`,
          ...(what === 'directory' || what === 'both' ? [`readonly SOURCE=${JSON.stringify(str(values, 'source', ''))}`] : []),
          ...(what !== 'directory' ? [`readonly DATABASE=${JSON.stringify(str(values, 'database', ''))}`] : []),
          `readonly KEEP_DAILY=${num(values, 'keep_daily', 14)}`,
          `readonly KEEP_WEEKLY=${num(values, 'keep_weekly', 8)}`,
          'readonly STAMP="$(date +%Y%m%d)"',
          'DRY_RUN=0',
          '',
          'run() {',
          '  if (( DRY_RUN )); then',
          '    log "DRY RUN: $*"',
          '    return 0',
          '  fi',
          '  "$@"',
          '}',
          '',
          'while (( $# > 0 )); do',
          '  case "$1" in',
          '    --dry-run) DRY_RUN=1; shift ;;',
          '    --verbose) set -x; shift ;;',
          '    -h|--help) printf \'Usage: %s [--dry-run] [--verbose]\\n\' "$SCRIPT_NAME"; exit 0 ;;',
          '    *) die "Unknown option: $1" ;;',
          '  esac',
          'done',
          '',
          'check_space() {',
          '  local needed_kb=0',
          ...(what === 'directory' || what === 'both'
            ? ['  needed_kb=$(du -sk "$SOURCE" | cut -f1)']
            : ['  needed_kb=1048576  # assume a gigabyte for a dump; adjust if yours is bigger']),
          '  local available_kb',
          '  available_kb=$(df -Pk "$DESTINATION" | awk \'NR==2 {print $4}\')',
          '  log "Need about $((needed_kb / 1024)) MB, have $((available_kb / 1024)) MB"',
          '  if (( available_kb < needed_kb )); then',
          '    die "Not enough space in $DESTINATION. Refusing to start rather than filling the volume."',
          '  fi',
          '}',
          '',
          'backup_files() {',
          '  local target="${DESTINATION}/files-${STAMP}.tar' + (compression === 'zstd' ? '.zst' : compression === 'gzip' ? '.gz' : '') + '"',
          '  local partial="${target}.partial"',
          '  CLEANUP+=("$partial")',
          '',
          '  log "Archiving $SOURCE"',
          ...(compression === 'zstd'
            ? ['  run tar -c -C "$(dirname "$SOURCE")" "$(basename "$SOURCE")" | run zstd -T0 -3 -o "$partial" -f']
            : compression === 'gzip'
              ? ['  run tar -cz -C "$(dirname "$SOURCE")" -f "$partial" "$(basename "$SOURCE")"']
              : ['  run tar -c -C "$(dirname "$SOURCE")" -f "$partial" "$(basename "$SOURCE")"']),
          '',
          '  # Rename only once it is complete, so an interrupted run never leaves',
          '  # something that looks like a finished backup.',
          '  run mv -- "$partial" "$target"',
          '  CLEANUP=("${CLEANUP[@]/$partial}")',
          '  log "Wrote $target ($(du -h "$target" 2>/dev/null | cut -f1 || echo "?"))"',
          '  printf \'%s\\n\' "$target"',
          '}',
          '',
          ...(what === 'mysql' || what === 'both'
            ? [
                'backup_mysql() {',
                '  local target="${DESTINATION}/${DATABASE}-${STAMP}.sql' + (compression === 'none' ? '' : compression === 'zstd' ? '.zst' : '.gz') + '"',
                '  local partial="${target}.partial"',
                '  CLEANUP+=("$partial")',
                '',
                '  log "Dumping $DATABASE"',
                '  # Credentials come from ~/.my.cnf. Never from an argument: ps shows those.',
                '  run bash -c "mysqldump --single-transaction --quick --routines --triggers --events \\"$DATABASE\\"' +
                  (compression === 'zstd' ? ' | zstd -T0 -3' : compression === 'gzip' ? ' | gzip -6' : '') +
                  ' > \\"$partial\\""',
                '  run mv -- "$partial" "$target"',
                '  log "Wrote $target"',
                '  printf \'%s\\n\' "$target"',
                '}',
                '',
              ]
            : []),
          ...(what === 'postgres'
            ? [
                'backup_postgres() {',
                '  local target="${DESTINATION}/${DATABASE}-${STAMP}.dump"',
                '  local partial="${target}.partial"',
                '  CLEANUP+=("$partial")',
                '',
                '  log "Dumping $DATABASE"',
                '  # Credentials come from ~/.pgpass. -Fc is compressed and restorable',
                '  # selectively, which a plain SQL dump is not.',
                '  run pg_dump -Fc -f "$partial" "$DATABASE"',
                '  run mv -- "$partial" "$target"',
                '  log "Wrote $target"',
                '  printf \'%s\\n\' "$target"',
                '}',
                '',
              ]
            : []),
          ...(verify
            ? [
                'verify() {',
                '  local archive="$1"',
                '  (( DRY_RUN )) && { log "DRY RUN: would verify $archive"; return 0; }',
                '  log "Verifying $archive"',
                '  case "$archive" in',
                '    *.tar.zst) zstd -t "$archive" && tar -tf "$archive" >/dev/null ;;',
                '    *.tar.gz)  gzip -t "$archive" && tar -tzf "$archive" >/dev/null ;;',
                '    *.tar)     tar -tf "$archive" >/dev/null ;;',
                '    *.sql.zst) zstd -t "$archive" ;;',
                '    *.sql.gz)  gzip -t "$archive" ;;',
                '    *.dump)    pg_restore -l "$archive" >/dev/null ;;',
                '    *)         warn "No verification rule for $archive"; return 0 ;;',
                '  esac',
                '  log "Verified $archive"',
                '}',
                '',
              ]
            : []),
          'rotate() {',
          '  # Rotation runs only after a successful backup. A failed backup must',
          '  # never be the reason the old ones were removed.',
          '  log "Removing daily backups older than $KEEP_DAILY days"',
          '  while IFS= read -r -d \'\' old; do',
          '    log "Removing $old"',
          '    run rm -f -- "$old"',
          '  done < <(find "$DESTINATION" -maxdepth 1 -type f -name \'*-*\' -mtime "+${KEEP_DAILY}" ! -name \'weekly-*\' -print0)',
          '',
          ...(num(values, 'keep_weekly', 8) > 0
            ? [
                '  # Keep one a week for longer, by hard linking it under another name.',
                '  if [[ "$(date +%u)" == "7" ]]; then',
                '    for recent in "$DESTINATION"/*-"${STAMP}"*; do',
                '      [[ -f "$recent" ]] || continue',
                '      run ln -f -- "$recent" "${DESTINATION}/weekly-$(basename "$recent")"',
                '    done',
                '  fi',
                '  log "Removing weekly backups older than $((KEEP_WEEKLY * 7)) days"',
                '  find "$DESTINATION" -maxdepth 1 -type f -name \'weekly-*\' -mtime "+$((KEEP_WEEKLY * 7))" -print0 |',
                '    while IFS= read -r -d \'\' old; do',
                '      log "Removing $old"',
                '      run rm -f -- "$old"',
                '    done',
              ]
            : []),
          '}',
          '',
          'main() {',
          '  [[ -d "$DESTINATION" ]] || run mkdir -p -- "$DESTINATION"',
          '  [[ -w "$DESTINATION" ]] || die "Cannot write to $DESTINATION"',
          ...(what === 'directory' || what === 'both' ? ['  [[ -d "$SOURCE" ]] || die "No such directory: $SOURCE"'] : []),
          '',
          '  check_space',
          '',
          '  local written=()',
          ...(what === 'directory' || what === 'both' ? ['  written+=("$(backup_files)")'] : []),
          ...(what === 'mysql' || what === 'both' ? ['  written+=("$(backup_mysql)")'] : []),
          ...(what === 'postgres' ? ['  written+=("$(backup_postgres)")'] : []),
          '',
          ...(verify ? ['  for archive in "${written[@]}"; do', '    verify "$archive"', '  done', ''] : []),
          '  rotate',
          '',
          ...(offsite
            ? [
                `  log "Copying offsite to ${offsite}"`,
                ...(offsite.startsWith('s3://')
                  ? [`  run aws s3 sync "$DESTINATION" ${JSON.stringify(offsite)} --exclude '*.partial'`]
                  : [`  run rsync -a --delete-after --exclude='*.partial' "$DESTINATION/" ${JSON.stringify(offsite)}`]),
                '',
              ]
            : []),
          '  log "Backup complete: ${#written[@]} archive(s)"',
          '  df -h "$DESTINATION" | tail -1',
          '}',
          '',
          'main "$@"',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'sh_health_check',
    platform: PLATFORM,
    label: 'Health check',
    group: 'Operations',
    description: 'Check the things that say whether a machine is healthy — services, disks, endpoints, certificates — and exit with a code a monitoring system understands.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'check-health' },
      { id: 'services', label: 'systemd units', control: 'text', default: 'nginx, postgresql' },
      { id: 'disk_warn', label: 'Warn when a filesystem is above (%)', control: 'number', default: 85, min: 1, max: 99 },
      { id: 'disk_critical', label: 'Critical above (%)', control: 'number', default: 95, min: 1, max: 99 },
      { id: 'endpoints', label: 'HTTP endpoints', control: 'textarea', default: 'http://localhost:8080/healthz\nhttps://www.example.com/', hint: 'One per line' },
      { id: 'load_multiplier', label: 'Warn when load exceeds cores ×', control: 'number', default: 2, min: 1, max: 20 },
      { id: 'check_certs', label: 'Check certificate expiry on the endpoints', control: 'toggle', default: true },
      { id: 'cert_days', label: 'Warn when fewer days remain', control: 'number', default: 30, min: 1, max: 365, showWhen: { input: 'check_certs', equals: ['true'] } },
      { id: 'output', label: 'Output', control: 'select', default: 'nagios', options: [
        { value: 'nagios', label: 'Nagios style — one summary line and exit code' },
        { value: 'json', label: 'JSON, for something else to read' },
      ] },
    ],
    script: (values                 )         => {
      const name = snake(str(values, 'script_name', 'check-health'), 'check_health');
      const services = listOf(str(values, 'services', ''));
      const endpoints = listOf(str(values, 'endpoints', '').replace(/\n/g, ','));
      const warn = num(values, 'disk_warn', 85);
      const critical = num(values, 'disk_critical', 95);
      const findings            = [];
      if (critical <= warn) findings.push(error('scripts.sh.thresholds-inverted', 'The critical disk threshold is not above the warning threshold.', { source: 'ArchToolKit' }));
      if (services.length === 0 && endpoints.length === 0) {
        findings.push(warning('scripts.sh.nothing-checked', 'No service and no endpoint was named, so this checks disk and load only.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: 'Check services, disks, endpoints and load, and exit with a code',
        effect: 'read',
        requires: [
          ...(services.length > 0 ? [{ what: 'systemd — systemctl is used to check the units' }] : []),
          ...(endpoints.length > 0 ? [{ what: 'curl' }] : []),
          ...(bool(values, 'check_certs', true) && endpoints.length > 0 ? [{ what: 'openssl, for the certificate check' }] : []),
        ],
        parameters: [{ name: '--verbose', description: 'Show every check, not just the failures.', required: false }],
        notes: [
          'Exit codes follow the monitoring convention: 0 OK, 1 warning, 2 critical, 3 unknown. Anything that polls this understands those without configuration.',
          'Every check runs even after one fails, so one report covers everything rather than stopping at the first problem.',
          'Timeouts are set on every network call. A check that hangs is worse than one that fails, because the monitoring system waits instead of alerting.',
          'tmpfs, squashfs and loop devices are excluded from the disk check — they are always full and it means nothing.',
        ],
        usage: [`./${name}.sh`, `./${name}.sh --verbose`, `echo $?   # 0 OK, 1 warning, 2 critical`],
        undo: ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble(),
          'log()  { (( VERBOSE )) && printf \'%s\\n\' "$*" >&2 || true; }',
          '',
          'VERBOSE=0',
          '[[ "${1:-}" == "--verbose" || "${1:-}" == "-v" ]] && VERBOSE=1',
          '',
          `readonly DISK_WARN=${warn}`,
          `readonly DISK_CRITICAL=${critical}`,
          '',
          '# Collected as we go, so one report covers everything.',
          'PROBLEMS=()',
          'WARNINGS=()',
          'OK_COUNT=0',
          '',
          'ok()       { OK_COUNT=$((OK_COUNT + 1)); log "OK: $*"; }',
          'problem()  { PROBLEMS+=("$*"); }',
          'warning()  { WARNINGS+=("$*"); }',
          '',
          ...(services.length > 0
            ? [
                'check_services() {',
                `  for unit in ${services.map((s) => JSON.stringify(s)).join(' ')}; do`,
                '    if systemctl is-active --quiet "$unit"; then',
                '      ok "$unit is active"',
                '    else',
                '      local state',
                '      state="$(systemctl is-active "$unit" 2>&1 || true)"',
                '      problem "$unit is $state"',
                '    fi',
                '  done',
                '}',
                '',
              ]
            : []),
          'check_disks() {',
          '  # Exclude the pseudo filesystems, which are always full and never a problem.',
          '  while read -r filesystem size used available percent mount; do',
          '    [[ "$percent" == "Use%" ]] && continue',
          '    local value="${percent%\\%}"',
          '    if (( value >= DISK_CRITICAL )); then',
          '      problem "$mount is ${value}% full"',
          '    elif (( value >= DISK_WARN )); then',
          '      warning "$mount is ${value}% full"',
          '    else',
          '      ok "$mount is ${value}% full"',
          '    fi',
          '  done < <(df -P -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null)',
          '',
          '  # Running out of inodes looks exactly like running out of space to an',
          '  # application, and does not show in df without -i.',
          '  while read -r filesystem inodes used free percent mount; do',
          '    [[ "$percent" == "IUse%" ]] && continue',
          '    [[ "$percent" == "-" ]] && continue',
          '    local value="${percent%\\%}"',
          '    (( value >= DISK_CRITICAL )) && problem "$mount has used ${value}% of its inodes"',
          '  done < <(df -Pi -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null)',
          '}',
          '',
          'check_load() {',
          '  local cores load',
          '  cores="$(nproc)"',
          '  load="$(awk \'{print $1}\' /proc/loadavg)"',
          `  local limit=$(( cores * ${num(values, 'load_multiplier', 2)} ))`,
          '  # awk rather than bash, because the load average is not an integer.',
          '  if awk -v l="$load" -v m="$limit" \'BEGIN { exit !(l > m) }\'; then',
          '    warning "Load is $load on $cores cores"',
          '  else',
          '    ok "Load is $load on $cores cores"',
          '  fi',
          '}',
          '',
          ...(endpoints.length > 0
            ? [
                'check_endpoints() {',
                `  for url in ${endpoints.map((e) => JSON.stringify(e)).join(' ')}; do`,
                '    local code time_total',
                '    # --max-time matters: a check that hangs is worse than one that fails.',
                '    if ! read -r code time_total < <(curl -sS -o /dev/null -m 10 -w \'%{http_code} %{time_total}\' "$url" 2>/dev/null); then',
                '      problem "$url did not respond"',
                '      continue',
                '    fi',
                '    if [[ "$code" =~ ^[23] ]]; then',
                '      ok "$url returned $code in ${time_total}s"',
                '    else',
                '      problem "$url returned $code"',
                '    fi',
                '  done',
                '}',
                '',
              ]
            : []),
          ...(bool(values, 'check_certs', true) && endpoints.length > 0
            ? [
                'check_certificates() {',
                `  local warn_days=${num(values, 'cert_days', 30)}`,
                `  for url in ${endpoints.map((e) => JSON.stringify(e)).join(' ')}; do`,
                '    [[ "$url" == https://* ]] || continue',
                '    local hostport="${url#https://}"',
                '    hostport="${hostport%%/*}"',
                '    [[ "$hostport" == *:* ]] || hostport="${hostport}:443"',
                '    local host="${hostport%%:*}"',
                '',
                '    local expiry',
                '    expiry="$(echo | timeout 10 openssl s_client -connect "$hostport" -servername "$host" 2>/dev/null |',
                '      openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)" || true',
                '    if [[ -z "$expiry" ]]; then',
                '      warning "Could not read the certificate for $host"',
                '      continue',
                '    fi',
                '    local expiry_epoch now days',
                '    expiry_epoch="$(date -d "$expiry" +%s 2>/dev/null || echo 0)"',
                '    now="$(date +%s)"',
                '    days=$(( (expiry_epoch - now) / 86400 ))',
                '    if (( days < 0 )); then',
                '      problem "The certificate for $host expired $(( -days )) days ago"',
                '    elif (( days < warn_days )); then',
                '      warning "The certificate for $host expires in $days days"',
                '    else',
                '      ok "The certificate for $host has $days days left"',
                '    fi',
                '  done',
                '}',
                '',
              ]
            : []),
          'main() {',
          ...(services.length > 0 ? ['  check_services'] : []),
          '  check_disks',
          '  check_load',
          ...(endpoints.length > 0 ? ['  check_endpoints'] : []),
          ...(bool(values, 'check_certs', true) && endpoints.length > 0 ? ['  check_certificates'] : []),
          '',
          ...(str(values, 'output', 'nagios') === 'json'
            ? [
                '  printf \'{\\n\'',
                '  printf \'  "status": "%s",\\n\' "$( (( ${#PROBLEMS[@]} )) && echo critical || { (( ${#WARNINGS[@]} )) && echo warning || echo ok; } )"',
                '  printf \'  "ok": %d,\\n\' "$OK_COUNT"',
                '  printf \'  "problems": [%s],\\n\' "$(printf \'"%s",\' "${PROBLEMS[@]:-}" | sed \'s/,$//\')"',
                '  printf \'  "warnings": [%s]\\n\' "$(printf \'"%s",\' "${WARNINGS[@]:-}" | sed \'s/,$//\')"',
                '  printf \'}\\n\'',
              ]
            : [
                '  if (( ${#PROBLEMS[@]} > 0 )); then',
                '    printf \'CRITICAL - %s\\n\' "$(IFS=\'; \'; echo "${PROBLEMS[*]}")"',
                '    (( ${#WARNINGS[@]} )) && printf \'  also: %s\\n\' "$(IFS=\'; \'; echo "${WARNINGS[*]}")"',
                '    exit 2',
                '  fi',
                '  if (( ${#WARNINGS[@]} > 0 )); then',
                '    printf \'WARNING - %s\\n\' "$(IFS=\'; \'; echo "${WARNINGS[*]}")"',
                '    exit 1',
                '  fi',
                '  printf \'OK - %d checks passed\\n\' "$OK_COUNT"',
                '  exit 0',
              ]),
          '}',
          '',
          '# The trap would swallow the exit code, so this script does not set one.',
          'trap - EXIT',
          'main "$@"',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'sh_deploy',
    platform: PLATFORM,
    label: 'Deploy with health check and rollback',
    group: 'Operations',
    description: 'Put a new version in place, check it actually works, and put the old one back automatically if it does not — which is the part most deployment scripts leave out.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'deploy-app' },
      { id: 'service', label: 'systemd unit', control: 'text', default: 'app.service' },
      { id: 'install_dir', label: 'Install directory', control: 'text', default: '/srv/app' },
      { id: 'artifact', label: 'Artifact', control: 'select', default: 'tarball', options: [
        { value: 'tarball', label: 'A tar archive' },
        { value: 'git', label: 'A git tag or branch' },
        { value: 'container', label: 'A container image' },
      ] },
      { id: 'repo', label: 'Repository', control: 'text', default: 'git@github.com:example/app.git', showWhen: { input: 'artifact', equals: ['git'] } },
      { id: 'image', label: 'Image', control: 'text', default: 'registry.example.com/app', showWhen: { input: 'artifact', equals: ['container'] } },
      { id: 'health_url', label: 'Health endpoint', control: 'text', default: 'http://localhost:8080/healthz' },
      { id: 'health_timeout', label: 'Wait for health (seconds)', control: 'number', default: 60, min: 5, max: 900 },
      { id: 'keep_releases', label: 'Keep previous releases', control: 'number', default: 5, min: 1, max: 50 },
      { id: 'pre_hook', label: 'Before switching', control: 'text', default: '', hint: 'A command — migrations, cache warming' },
    ],
    script: (values                 )         => {
      const name = snake(str(values, 'script_name', 'deploy'), 'deploy');
      const artifact = str(values, 'artifact', 'tarball');
      const service = str(values, 'service', 'app.service');
      const installDir = str(values, 'install_dir', '/srv/app');
      const healthUrl = str(values, 'health_url', '');
      const preHook = str(values, 'pre_hook', '');
      const findings            = [];
      if (!healthUrl) {
        findings.push(
          error('scripts.sh.no-health-check', 'Without a health endpoint there is nothing to decide whether the deployment worked, so the rollback can never trigger. A deployment script without a health check is a deployment script that always reports success.', {
            remediation: 'Give the application a health endpoint, even a trivial one, and check it here.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (preHook && /migrat/i.test(preHook)) {
        findings.push(
          warning('scripts.sh.migrations-not-rolled-back', 'A database migration is not undone by rolling the code back. The old version will start against a schema it does not expect. Migrations need to be backward compatible with the version you might roll back to — that is a design decision, not a script one.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Deploy to ${installDir} with an automatic rollback`,
        effect: 'repeat-unsafe',
        requires: [
          { what: 'systemd, and rights to restart the unit', how: `sudo systemctl status ${service}` },
          { what: 'curl, for the health check' },
          ...(artifact === 'git' ? [{ what: 'git, and read access to the repository' }] : []),
          ...(artifact === 'container' ? [{ what: 'podman or docker, and access to the registry' }] : []),
          { what: 'Write access to the install directory and its parent' },
        ],
        parameters: [
          { name: 'version', description: 'The tag, tarball or image tag to deploy.', required: true, example: 'v2.4.1' },
          { name: '--dry-run', description: 'Show every step and do none of them.', required: false },
          { name: '--no-rollback', description: 'Leave a failed deployment in place, for debugging.', required: false },
        ],
        notes: [
          'Releases are kept side by side and a symlink is switched, so a rollback is a symlink change rather than a re-download. That is what makes it fast enough to happen automatically.',
          'The health check polls until it passes or the timeout expires. A single check straight after a restart almost always fails, because nothing has started yet.',
          'If the health check fails, the symlink goes back and the service is restarted before the script exits non-zero. The failure is reported after the rollback, not instead of it.',
          ...(preHook ? [`The pre-switch hook runs before the symlink moves: ${preHook}`] : []),
          'Run it with --dry-run against production once, and read every line, before you trust it.',
        ],
        usage: [`./${name}.sh v2.4.1 --dry-run`, `./${name}.sh v2.4.1`, `./${name}.sh v2.4.0   # a rollback is just deploying the previous version`],
        undo: [
          'Automatic: a failed health check switches the symlink back and restarts the service.',
          `Manual: ln -sfn ${installDir}/releases/<previous> ${installDir}/current && systemctl restart ${service}`,
          `The previous ${num(values, 'keep_releases', 5)} releases are kept on disk for exactly this.`,
        ],
        body: [
          ...preamble(),
          ...scaffolding(),
          `readonly SERVICE=${JSON.stringify(service)}`,
          `readonly INSTALL_DIR=${JSON.stringify(installDir)}`,
          'readonly RELEASES_DIR="${INSTALL_DIR}/releases"',
          'readonly CURRENT_LINK="${INSTALL_DIR}/current"',
          `readonly HEALTH_URL=${JSON.stringify(healthUrl)}`,
          `readonly HEALTH_TIMEOUT=${num(values, 'health_timeout', 60)}`,
          `readonly KEEP=${num(values, 'keep_releases', 5)}`,
          '',
          'DRY_RUN=0',
          'ROLLBACK=1',
          'VERSION=""',
          'PREVIOUS=""',
          '',
          'run() {',
          '  if (( DRY_RUN )); then log "DRY RUN: $*"; return 0; fi',
          '  log "+ $*"',
          '  "$@"',
          '}',
          '',
          'while (( $# > 0 )); do',
          '  case "$1" in',
          '    --dry-run)     DRY_RUN=1; shift ;;',
          '    --no-rollback) ROLLBACK=0; shift ;;',
          '    -h|--help)     printf \'Usage: %s VERSION [--dry-run] [--no-rollback]\\n\' "$SCRIPT_NAME"; exit 0 ;;',
          '    -*)            die "Unknown option: $1" ;;',
          '    *)             VERSION="$1"; shift ;;',
          '  esac',
          'done',
          '',
          '[[ -n "$VERSION" ]] || die "Which version? Usage: $SCRIPT_NAME VERSION"',
          '',
          'wait_for_health() {',
          '  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))',
          '  log "Waiting up to ${HEALTH_TIMEOUT}s for $HEALTH_URL"',
          '  while (( $(date +%s) < deadline )); do',
          '    local code',
          '    code="$(curl -sS -o /dev/null -m 5 -w \'%{http_code}\' "$HEALTH_URL" 2>/dev/null || echo 000)"',
          '    if [[ "$code" =~ ^2 ]]; then',
          '      log "Healthy: $HEALTH_URL returned $code"',
          '      return 0',
          '    fi',
          '    log "  not yet ($code)"',
          '    sleep 3',
          '  done',
          '  return 1',
          '}',
          '',
          'rollback() {',
          '  if (( ! ROLLBACK )); then',
          '    warn "Health check failed. --no-rollback was given, so it is being left as it is."',
          '    return',
          '  fi',
          '  if [[ -z "$PREVIOUS" ]]; then',
          '    warn "Health check failed and there is no previous release to go back to."',
          '    return',
          '  fi',
          '  warn "Health check failed. Rolling back to $PREVIOUS"',
          '  run ln -sfn "$PREVIOUS" "$CURRENT_LINK"',
          '  run systemctl restart "$SERVICE"',
          '  if wait_for_health; then',
          '    warn "Rolled back to $PREVIOUS, and it is healthy."',
          '  else',
          '    warn "Rolled back to $PREVIOUS, and it is STILL not healthy. Something else is wrong."',
          '  fi',
          '}',
          '',
          'main() {',
          '  run mkdir -p "$RELEASES_DIR"',
          '',
          '  if [[ -L "$CURRENT_LINK" ]]; then',
          '    PREVIOUS="$(readlink -f "$CURRENT_LINK")"',
          '    log "Current release: $PREVIOUS"',
          '  else',
          '    log "Nothing deployed yet"',
          '  fi',
          '',
          '  local release="${RELEASES_DIR}/${VERSION}-${STARTED_AT}"',
          '  log "Preparing $release"',
          '',
          ...(artifact === 'git'
            ? [
                `  run git clone --depth 1 --branch "$VERSION" ${JSON.stringify(str(values, 'repo', ''))} "$release"`,
                '  run rm -rf "${release}/.git"',
              ]
            : artifact === 'container'
              ? [
                  `  run podman pull ${JSON.stringify(str(values, 'image', ''))}:"$VERSION"`,
                  '  run mkdir -p "$release"',
                  `  printf '%s\\n' "${'$'}{VERSION}" > "${'$'}{release}/VERSION"`,
                ]
              : [
                  '  local artifact="${INSTALL_DIR}/artifacts/${VERSION}.tar.gz"',
                  '  [[ -f "$artifact" ]] || die "No artifact at $artifact"',
                  '  run mkdir -p "$release"',
                  '  run tar -xzf "$artifact" -C "$release" --strip-components=1',
                ]),
          '',
          ...(preHook ? [`  log "Running the pre-switch hook"`, `  run bash -c ${JSON.stringify(preHook)}`, ''] : []),
          '  log "Switching $CURRENT_LINK to $release"',
          '  run ln -sfn "$release" "$CURRENT_LINK"',
          '  run systemctl restart "$SERVICE"',
          '',
          '  if (( DRY_RUN )); then',
          '    log "DRY RUN: would now wait for the health check"',
          '    return 0',
          '  fi',
          '',
          '  if ! wait_for_health; then',
          '    rollback',
          '    die "Deployment of $VERSION failed its health check"',
          '  fi',
          '',
          '  log "Deployed $VERSION successfully"',
          '',
          '  # Tidy up, keeping enough releases to roll back more than once.',
          '  local old',
          '  while IFS= read -r old; do',
          '    [[ "$old" == "$(readlink -f "$CURRENT_LINK")" ]] && continue',
          '    log "Removing old release $old"',
          '    run rm -rf -- "$old"',
          '  done < <(find "$RELEASES_DIR" -maxdepth 1 -mindepth 1 -type d -printf \'%T@ %p\\n\' |',
          '    sort -rn | tail -n "+$((KEEP + 1))" | cut -d\' \' -f2-)',
          '',
          '  systemctl is-active "$SERVICE" && log "$SERVICE is active"',
          '}',
          '',
          'main "$@"',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'sh_user_setup',
    platform: PLATFORM,
    label: 'Create users and keys',
    group: 'Configuration',
    description: 'Create accounts, install their public keys, put them in the right groups and set up sudo — idempotently, so it can be run against a machine that is already half configured.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'setup-users' },
      { id: 'users', label: 'Users', control: 'textarea', default: 'alice: admin, docker\nbob: developers', hint: 'One per line: username: group, group' },
      { id: 'key_source', label: 'Public keys from', control: 'select', default: 'directory', options: [
        { value: 'directory', label: 'A directory of <username>.pub files' },
        { value: 'url', label: 'A URL per user' },
        { value: 'none', label: 'No keys — accounts only' },
      ] },
      { id: 'key_dir', label: 'Key directory', control: 'text', default: './keys', showWhen: { input: 'key_source', equals: ['directory'] } },
      { id: 'key_url', label: 'URL template', control: 'text', default: 'https://keys.example.com/{user}.pub', showWhen: { input: 'key_source', equals: ['url'] } },
      { id: 'sudo', label: 'sudo for the admin group', control: 'select', default: 'password', options: [
        { value: 'password', label: 'Full sudo, with a password' },
        { value: 'nopasswd', label: 'Full sudo, no password' },
        { value: 'none', label: 'No sudo' },
      ] },
      { id: 'shell', label: 'Shell', control: 'text', default: '/bin/bash' },
      { id: 'disable_password_login', label: 'Disable password logins over SSH', control: 'toggle', default: true },
    ],
    script: (values                 )         => {
      const name = snake(str(values, 'script_name', 'setup-users'), 'setup_users');
      const users = str(values, 'users', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [user, groups] = line.split(':');
          return { user: identifier(user ?? '', 'user').toLowerCase(), groups: listOf(groups ?? '') };
        });
      const keySource = str(values, 'key_source', 'directory');
      const sudo = str(values, 'sudo', 'password');
      const findings            = [];
      if (users.length === 0) findings.push(error('scripts.sh.no-users', 'No user was given, so this creates nothing.', { source: 'ArchToolKit' }));
      if (sudo === 'nopasswd') {
        findings.push(
          warning('scripts.sh.nopasswd-sudo', 'NOPASSWD sudo means anyone who gets a shell as that user is root immediately — no second factor, no pause. It is right for automation accounts and wrong for people.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (keySource === 'none') {
        findings.push(
          warning('scripts.sh.no-keys', 'Accounts created with no key and no password can only be reached by someone setting one afterwards. That is safe, and it is also a half-finished job that gets finished insecurely in a hurry.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (bool(values, 'disable_password_login', true)) {
        findings.push(
          warning('scripts.sh.locking-out', 'Disabling SSH password authentication before confirming key access works will lock everyone out of a remote machine. The script tests for at least one working key first and refuses otherwise — do not remove that check.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Create ${users.length} user account${users.length === 1 ? '' : 's'} with keys and groups`,
        effect: 'idempotent',
        requires: [
          { what: 'Root, or sudo' },
          ...(keySource === 'directory' ? [{ what: 'A directory of <username>.pub files beside the script' }] : []),
          ...(keySource === 'url' ? [{ what: 'curl, and network access to the key server' }] : []),
        ],
        parameters: [
          { name: '--dry-run', description: 'Report what would be created and create nothing.', required: false },
          { name: '--verbose', description: 'Show each step.', required: false },
        ],
        notes: [
          'Everything here is idempotent: an existing user is not recreated, an existing key is not added twice, and an existing group membership is left alone. Run it as often as you like.',
          'Home directory and .ssh permissions are set explicitly. SSH silently refuses a key in a world-writable directory, and the error it gives says nothing about why.',
          'No password is ever set. Access is by key, which is what the key installation is for.',
          ...(bool(values, 'disable_password_login', true) ? ['Password authentication is only disabled after at least one key has been installed successfully. A machine you cannot reach is worse than one with password login.'] : []),
        ],
        usage: [`sudo ./${name}.sh --dry-run`, `sudo ./${name}.sh`, `sudo ./${name}.sh --verbose`],
        undo: [
          'Users created: userdel -r <username>   (that removes the home directory too)',
          `Sudo rule: rm /etc/sudoers.d/vcf-${name}`,
          ...(bool(values, 'disable_password_login', true) ? ['SSH configuration: the original is kept beside it with a .bak suffix and the timestamp.'] : []),
        ],
        body: [
          ...preamble(),
          ...scaffolding(),
          'DRY_RUN=0',
          '',
          'run() {',
          '  if (( DRY_RUN )); then log "DRY RUN: $*"; return 0; fi',
          '  "$@"',
          '}',
          '',
          'while (( $# > 0 )); do',
          '  case "$1" in',
          '    --dry-run) DRY_RUN=1; shift ;;',
          '    --verbose) set -x; shift ;;',
          '    -h|--help) printf \'Usage: %s [--dry-run]\\n\' "$SCRIPT_NAME"; exit 0 ;;',
          '    *) die "Unknown option: $1" ;;',
          '  esac',
          'done',
          '',
          '[[ $EUID -eq 0 ]] || die "This needs root. Run it with sudo."',
          '',
          '# username:group,group — one per line.',
          'USERS=(',
          ...users.map((u) => `  ${JSON.stringify(`${u.user}:${u.groups.join(',')}`)}`),
          ')',
          '',
          'KEYS_INSTALLED=0',
          '',
          'ensure_group() {',
          '  local group="$1"',
          '  if getent group "$group" >/dev/null; then',
          '    log "Group $group exists"',
          '  else',
          '    log "Creating group $group"',
          '    run groupadd "$group"',
          '  fi',
          '}',
          '',
          'ensure_user() {',
          '  local user="$1" groups="$2"',
          '',
          '  if id "$user" >/dev/null 2>&1; then',
          '    log "User $user exists"',
          '  else',
          '    log "Creating user $user"',
          `    run useradd --create-home --shell ${JSON.stringify(str(values, 'shell', '/bin/bash'))} "$user"`,
          '    # No password is set. Access is by key.',
          '    run passwd --lock "$user" >/dev/null',
          '  fi',
          '',
          '  if [[ -n "$groups" ]]; then',
          '    local IFS=,',
          '    for group in $groups; do',
          '      [[ -n "$group" ]] || continue',
          '      ensure_group "$group"',
          '      if id -nG "$user" | tr \' \' \'\\n\' | grep -qx "$group"; then',
          '        log "$user is already in $group"',
          '      else',
          '        log "Adding $user to $group"',
          '        run usermod -aG "$group" "$user"',
          '      fi',
          '    done',
          '  fi',
          '}',
          '',
          ...(keySource !== 'none'
            ? [
                'install_key() {',
                '  local user="$1"',
                '  local home',
                '  home="$(getent passwd "$user" | cut -d: -f6)"',
                '  [[ -n "$home" ]] || { warn "No home directory for $user"; return 1; }',
                '',
                '  local key=""',
                ...(keySource === 'directory'
                  ? [
                      `  local key_file="${JSON.stringify(str(values, 'key_dir', './keys')).slice(1, -1)}/\${user}.pub"`,
                      '  if [[ -f "$key_file" ]]; then',
                      '    key="$(cat "$key_file")"',
                      '  else',
                      '    warn "No key file for $user at $key_file"',
                      '    return 1',
                      '  fi',
                    ]
                  : [
                      `  local url="${JSON.stringify(str(values, 'key_url', '')).slice(1, -1)}"`,
                      '  url="${url//\\{user\\}/$user}"',
                      '  if ! key="$(curl -fsS -m 10 "$url")"; then',
                      '    warn "Could not fetch a key for $user from $url"',
                      '    return 1',
                      '  fi',
                    ]),
                '',
                '  # A malformed key breaks the whole authorized_keys file, so check first.',
                '  if ! printf \'%s\\n\' "$key" | ssh-keygen -l -f /dev/stdin >/dev/null 2>&1; then',
                '    warn "The key for $user is not a valid public key. Skipping it."',
                '    return 1',
                '  fi',
                '',
                '  local ssh_dir="${home}/.ssh"',
                '  local authorized="${ssh_dir}/authorized_keys"',
                '  run mkdir -p "$ssh_dir"',
                '  run touch "$authorized"',
                '',
                '  if (( ! DRY_RUN )) && grep -qF "$key" "$authorized" 2>/dev/null; then',
                '    log "$user already has this key"',
                '  else',
                '    log "Installing a key for $user"',
                '    if (( ! DRY_RUN )); then',
                '      printf \'%s\\n\' "$key" >> "$authorized"',
                '    fi',
                '    KEYS_INSTALLED=$((KEYS_INSTALLED + 1))',
                '  fi',
                '',
                '  # SSH refuses a key in a loosely permissioned directory and says',
                '  # nothing useful about why.',
                '  run chmod 700 "$ssh_dir"',
                '  run chmod 600 "$authorized"',
                '  run chown -R "${user}:${user}" "$ssh_dir"',
                '}',
                '',
              ]
            : []),
          'main() {',
          '  for entry in "${USERS[@]}"; do',
          '    local user="${entry%%:*}"',
          '    local groups="${entry#*:}"',
          '    [[ "$groups" == "$entry" ]] && groups=""',
          '    ensure_user "$user" "$groups"',
          ...(keySource !== 'none' ? ['    install_key "$user" || warn "No key installed for $user"'] : []),
          '  done',
          '',
          ...(sudo !== 'none'
            ? [
                `  local sudoers="/etc/sudoers.d/vcf-${name}"`,
                '  log "Writing $sudoers"',
                '  if (( ! DRY_RUN )); then',
                '    # Write to a temporary file and check it before installing it.',
                '    # A broken sudoers file locks everyone out of root.',
                '    local temporary',
                '    temporary="$(mktemp)"',
                '    CLEANUP+=("$temporary")',
                `    printf '%%admin ALL=(ALL:ALL) ${sudo === 'nopasswd' ? 'NOPASSWD:' : ''}ALL\\n' > "$temporary"`,
                '    if visudo -cf "$temporary" >/dev/null; then',
                '      install -m 0440 -o root -g root "$temporary" "$sudoers"',
                '      log "Installed $sudoers"',
                '    else',
                '      die "The sudoers file did not validate. Nothing was installed."',
                '    fi',
                '  fi',
                '',
              ]
            : []),
          ...(bool(values, 'disable_password_login', true)
            ? [
                '  # Only after at least one key works. Otherwise this locks everyone out.',
                '  if (( KEYS_INSTALLED > 0 )) || (( DRY_RUN )); then',
                '    local config="/etc/ssh/sshd_config"',
                '    log "Disabling password authentication in $config"',
                '    if (( ! DRY_RUN )); then',
                '      cp -a "$config" "${config}.bak-${STARTED_AT}"',
                '      sed -i \'s/^#\\?PasswordAuthentication.*/PasswordAuthentication no/\' "$config"',
                '      sed -i \'s/^#\\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/\' "$config"',
                '      if sshd -t; then',
                '        systemctl reload sshd',
                '        log "Password authentication disabled. The original is at ${config}.bak-${STARTED_AT}"',
                '      else',
                '        warn "The new sshd configuration did not validate. Restoring the original."',
                '        cp -a "${config}.bak-${STARTED_AT}" "$config"',
                '        die "sshd_config was not changed"',
                '      fi',
                '    fi',
                '  else',
                '    warn "No key was installed, so password authentication has been left enabled. Fix the keys and run this again."',
                '  fi',
                '',
              ]
            : []),
          '  log "Done. $KEYS_INSTALLED key(s) installed."',
          '}',
          '',
          'main "$@"',
        ],
        findings,
      };
    },
  }),
];
