/**
 * WP-11d: the open-source database paths (addendum A.6.6, A.6.9).
 *
 *   pg-logical          PostgreSQL logical replication; reverse (target to source) at cutover
 *   pg-dump             pg_dump -Fd / pg_restore (offline)
 *   mysql-replication   MySQL / MariaDB binlog replication by target (VM, RDS, Aurora, Azure);
 *                       reverse at cutover where the service exposes binlogs
 *   mysql-dump          MySQL Shell dump and load (mariadb-dump for MariaDB), offline
 *   azure-pg-migration  the Azure Database for PostgreSQL migration service (online), then
 *                       the same reverse logical replication as pg-logical
 *
 * Every script runs on the migration controller with the PostgreSQL / MySQL
 * clients and keeps the kit's contract (shScript). Passwords reach psql as
 * PGPASSWORD, mysql through an option file on an unnamed pipe, mysqlsh on
 * stdin, and the Azure migration service in a mode-600 runtime file that
 * the library removes at exit (the one file the contract allows, A.6.2).
 */

import type { Finding } from '../../../../core/findings.ts';
import { warning } from '../../../../core/findings.ts';
import type { DbMovePath } from '../../types.ts';
import type { ExecPath } from '../contract.ts';
import { code, shScript } from '../lib-sh.ts';
import type { ManifestItem } from '../manifest.ts';
import type { PathContext, PathGenerator } from '../registry.ts';
import {
  BASE_SETTINGS, DB_DIR, DB_SH_BASE, dbReadme, dbRows, endpointFinding, MY_SH, myReverseSupported, myTargetKind, need, noReverseFinding,
  onPath, PG_SH, rdsMysqlProcs, replicationCredentialFinding, shSettings, withTestSkips, type DbRows, type DbSetting, type ReadmeItem,
} from './common.ts';

export const OPEN_SOURCE_PATHS: readonly DbMovePath[] = Object.freeze(['pg-logical', 'pg-dump', 'mysql-replication', 'mysql-dump', 'azure-pg-migration']);

const ENTRY: Readonly<Record<string, string>> = Object.freeze({
  'pg-logical': `${DB_DIR}/pg-logical.sh`,
  'pg-dump': `${DB_DIR}/pg-dump.sh`,
  'mysql-replication': `${DB_DIR}/mysql-replication.sh`,
  'mysql-dump': `${DB_DIR}/mysql-dump.sh`,
  'azure-pg-migration': `${DB_DIR}/azure-pg.sh`,
});

// ---------------------------------------------------------------------------
// Settings per path
// ---------------------------------------------------------------------------

const PG_SETTINGS: readonly DbSetting[] = [
  { key: 'pg_sslmode', help: 'libpq sslmode from the controller (disable, require, verify-ca, verify-full)' },
  { key: 'pg_repl_sslmode', help: 'sslmode of the replication connection between the databases' },
  { key: 'reverse', help: '1: set up reverse replication (target to source) at cutover; 0: none' },
  { key: 'src_host_seen_from_tgt', help: 'the source as the target reaches it, when it differs from src_host' },
  { key: 'tgt_host_seen_from_src', help: 'the target as the source reaches it, when it differs from tgt_host' },
];
const PG_DUMP_SETTINGS: readonly DbSetting[] = [
  { key: 'pg_sslmode', help: 'libpq sslmode from the controller' },
  { key: 'jobs', help: 'parallel pg_dump / pg_restore jobs' },
];
const MY_SETTINGS: readonly DbSetting[] = [
  { key: 'my_ssl_mode', help: 'the client --ssl-mode (REQUIRED, VERIFY_CA, VERIFY_IDENTITY)' },
  { key: 'my_kind', help: 'how the target takes replication: vm, rds, aurora, azure (heatwave and cloudsql: use their own paths)' },
  { key: 'target_version', help: 'the target engine version; picks the RDS procedure names (8.4: _source, 8.0: _master) when the target does not answer' },
  { key: 'rds_set_proc', help: 'the RDS procedure the planned version selects (informative)' },
  { key: 'reverse', help: '1: set up reverse replication (target to source) at cutover; 0: none' },
  { key: 'reverse_supported', help: '1 when the target service exposes binlogs to replicate from' },
  { key: 'threads', help: 'MySQL Shell dump / load threads' },
  { key: 'src_ssl_ca_file', help: 'Azure: a file holding the source CA certificate for the replication connection' },
  { key: 'src_host_seen_from_tgt', help: 'the source as the target reaches it, when it differs from src_host' },
  { key: 'tgt_host_seen_from_src', help: 'the target as the source reaches it, when it differs from tgt_host' },
  { key: 'gtid_pos', help: 'MariaDB: the GTID position of the initial load (recorded by prepare)' },
];
const MY_DUMP_SETTINGS: readonly DbSetting[] = [
  { key: 'my_ssl_mode', help: 'the client --ssl-mode' },
  { key: 'threads', help: 'MySQL Shell dump / load threads' },
  { key: 'load_users', help: '1: load the accounts too (on a VM target); managed targets get their accounts from the runbook' },
];
const AZPG_SETTINGS: readonly DbSetting[] = [
  { key: 'resource_group', help: 'the Flexible Server resource group', required: true },
  { key: 'azure_server', help: 'the Flexible Server name', required: true },
  { key: 'azpg_ssl_mode', help: 'the migration service sslMode (VerifyFull, Require, Prefer)' },
  { key: 'pg_sslmode', help: 'libpq sslmode from the controller' },
  { key: 'pg_repl_sslmode', help: 'sslmode of the reverse replication connection' },
  { key: 'reverse', help: '1: set up reverse replication (target to source) at cutover; 0: none' },
  { key: 'tgt_host_seen_from_src', help: 'the target as the source reaches it, when it differs from tgt_host' },
];

function mysqlExtra(i: ManifestItem): Record<string, string> {
  const kind = myTargetKind(i.target.service);
  const planned = i.target.engineVersion || (i.version?.startsWith('mysql-') ? i.version.slice(6) : '');
  return {
    my_ssl_mode: 'REQUIRED',
    my_kind: kind,
    target_version: planned,
    rds_set_proc: kind === 'rds' || kind === 'aurora' ? (i.engine === 'mariadb' ? 'mysql.rds_set_external_master_gtid' : rdsMysqlProcs(planned).set) : '',
    reverse: '1',
    reverse_supported: myReverseSupported(i.engine, kind) ? '1' : '0',
    threads: '4',
    src_ssl_ca_file: '',
    src_host_seen_from_tgt: '',
    tgt_host_seen_from_src: '',
    gtid_pos: '',
  };
}

function extraFor(path: DbMovePath): (i: ManifestItem) => Record<string, string> {
  switch (path) {
    case 'pg-logical': return () => ({ pg_sslmode: 'require', pg_repl_sslmode: 'require', reverse: '1', src_host_seen_from_tgt: '', tgt_host_seen_from_src: '' });
    case 'pg-dump': return () => ({ pg_sslmode: 'require', jobs: '4' });
    case 'mysql-replication': return mysqlExtra;
    case 'mysql-dump': return (i) => ({ my_ssl_mode: 'REQUIRED', threads: '4', load_users: myTargetKind(i.target.service) === 'vm' ? '1' : '0' });
    case 'azure-pg-migration': return () => ({
      resource_group: '', azure_server: '', azpg_ssl_mode: 'VerifyFull', pg_sslmode: 'require', pg_repl_sslmode: 'require', reverse: '1', tgt_host_seen_from_src: '',
    });
    default: return () => ({});
  }
}

// ---------------------------------------------------------------------------
// pg-logical
// ---------------------------------------------------------------------------

const PG_LOGICAL_FUNCS = code`
# The wait for the first copy (replicate without --once), in minutes; --timeout overrides it.
DB_WAIT_MINUTES="$\{ATK_DB_WAIT_MINUTES:-240}"

pg_prepare_checks() {
  local id="$1"
  pg_need_logical "$id" src
  if db_on "$id" reverse; then
    local lvl
    lvl="$(pg_wal_level "$id" tgt)"
    [[ "$lvl" == logical ]] || atk_die 5 "$(db_label "$id"): the reverse replication needs wal_level = logical on the target ($(pg_wal_hint "$id" tgt)), or set ATK_DB_$\{DB_TOK[$id]}_REVERSE=0 to accept no fallback"
  fi
}
`;

const PG_LOGICAL_VERBS = withTestSkips({
  prepare: code`
pg_prepare_checks "$id"
pg_repl_role "$id" src
pg_ensure_db "$id" tgt
pg_schema_copy "$id"
db_finish "$id" prepared "logical decoding on, the replication role on the source, the schema on the target"`,
  replicate: code`
pg_publish "$id" src "$(pg_fwd "$id")"
pg_subscribe "$id" tgt "$(pg_fwd "$id")" true
atk_wait_until "$DB_WAIT_MINUTES" 30 pg_in_sync "$id" src "$(pg_fwd "$id")" || true
pg_status "$id"`,
  status: 'pg_status "$id"',
  cutover: code`
fwd="$(pg_fwd "$id")"
if [[ "$(db_phase "$id")" == cut-over ]]; then atk_skip "$id" "already cut over" cut-over; fi
pg_has "$id" tgt sub "$fwd" || atk_fail "$id" "no subscription $fwd on the target: run replicate first"
if pg_sub_enabled "$id" tgt "$fwd"; then
  atk_wait_until 30 5 pg_in_sync "$id" src "$fwd" || atk_fail "$id" "the replication lag did not reach 0 after the freeze; nothing was switched"
  pg_sync_sequences "$id" src tgt
  pg_sub_disable "$id" tgt "$fwd"
fi
# The forward slot goes now, or the source would keep its WAL for the whole hypercare.
pg_drop_slot "$id" src "$fwd"
pg_reverse "$id"
db_phase "$id" cut-over
if db_on "$id" reverse; then rev=true; else rev=false; fi
atk_done "$id" cut-over "the target is current (lag 0, sequences carried); reverse replication: $rev" reverse="$rev"`,
  commit: 'atk_skip "$id" "nothing to commit: the reverse replication stays until finalize"',
  rollback: code`
rev="$(pg_rev "$id")"
if [[ "$(db_phase "$id")" == rolled-back ]]; then atk_skip "$id" "already rolled back"; fi
if pg_has "$id" src sub "$rev"; then
  pg_reverse_rollback "$id"
  db_phase "$id" rolled-back
  atk_done "$id" "" "the source has the target's writes (reverse lag 0, sequences carried back): switch the applications back"
fi
if [[ "$(db_phase "$id")" == cut-over ]]; then
  db_phase "$id" rolled-back
  atk_done "$id" "" "no reverse replication was set up: the source is as it was at the freeze, and writes made on the target since cutover are not carried back"
fi
if pg_has "$id" tgt sub "$(pg_fwd "$id")"; then
  pg_sub_disable "$id" tgt "$(pg_fwd "$id")"
  db_phase "$id" rolled-back
  atk_done "$id" "" "replication to the target is stopped; the source was only frozen and is unchanged"
fi
atk_skip "$id" "nothing to roll back: the source was not changed"`,
  finalize: code`
pg_teardown "$id"
db_finish "$id" "" "subscriptions, publications, slots and replication roles removed on both sides"`,
});

// ---------------------------------------------------------------------------
// pg-dump
// ---------------------------------------------------------------------------

const PG_DUMP_FUNCS = code`
pg_client_major() { pg_dump --version | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+(\.[0-9]+)*$/) { split($i, v, "."); print v[1]; exit } }'; }
pg_dump_dir() { printf '%s/pgdump' "$(db_work "$1")"; }
`;

const PG_DUMP_VERBS = withTestSkips({
  prepare: code`
src="$(pg_major "$id" src)"
tgt="$(pg_major "$id" tgt)"
cli="$(pg_client_major)"
(( cli >= src )) || atk_die 5 "$(db_label "$id"): pg_dump $cli cannot dump a PostgreSQL $src source; install the $src client or later"
(( tgt >= src )) || atk_log "$(db_label "$id"): the target ($tgt) is older than the source ($src); pg_restore may refuse newer objects"
pg_ensure_db "$id" tgt
db_finish "$id" prepared "both ends answer (source $src, target $tgt, client $cli)"`,
  replicate: 'atk_skip "$id" "an offline path: the copy runs at cutover, after the freeze"',
  status: 'atk_skip "$id" "an offline path: nothing replicates"',
  cutover: code`
if [[ "$(db_phase "$id")" == cut-over ]]; then atk_skip "$id" "already restored" cut-over; fi
dir="$(pg_dump_dir "$id")"
jobs="$(db_get "$id" jobs)"
_pg_conn "$id" src
if [[ -d "$dir" ]]; then db_changed; atk_run rm -rf -- "$dir"; fi
db_changed
PGPASSWORD="$_PG_PW" PGSSLMODE="$\{_PG_SSL:-require}" atk_run pg_dump "$\{_PG_CONN[@]}" -d "$(pg_db "$id")" -Fd -j "$jobs" -f "$dir"
_pg_conn "$id" tgt
db_changed
PGPASSWORD="$_PG_PW" PGSSLMODE="$\{_PG_SSL:-require}" atk_run pg_restore "$\{_PG_CONN[@]}" -d "$(pg_db "$id")" -j "$jobs" --no-owner --no-privileges --clean --if-exists "$dir"
pg_x "$id" tgt "$(pg_db "$id")" "analyze the restored database" "ANALYZE;"
db_phase "$id" cut-over
atk_done "$id" cut-over "dumped with $jobs jobs and restored"`,
  commit: 'atk_skip "$id" "nothing to commit on an offline path"',
  rollback: 'atk_skip "$id" "nothing to roll back: the source was only frozen and is unchanged; the target is kept for analysis"',
  finalize: code`
dir="$(pg_dump_dir "$id")"
if [[ -d "$dir" ]]; then db_changed; atk_run rm -rf -- "$dir"; fi
db_finish "$id" "" "the dump directory is removed"`,
});

// ---------------------------------------------------------------------------
// mysql-replication and mysql-dump
// ---------------------------------------------------------------------------

const MY_LOAD_FUNCS = code`
# The wait for the first copy (replicate without --once), in minutes; --timeout overrides it.
DB_WAIT_MINUTES="$\{ATK_DB_WAIT_MINUTES:-240}"

my_dump_dir() { printf '%s/mydump' "$(db_work "$1")"; }
my_uri() { printf '%s@%s:%s' "$_MY_USER" "$(db_host_url "$_MY_HOST")" "$_MY_PORT"; }
# my_user_schemas ID: the source's schemas, less the system ones.
my_user_schemas() {
  my_q "$1" src "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema') ORDER BY 1"
}
# my_load ID REPLICATION(1|0): the initial copy. MySQL: MySQL Shell (consistent dump, GTID set appended on the target,
# no binlog on the target during the load). MariaDB: mariadb-dump with the GTID position recorded.
my_load() {
  local id="$1" repl="$2" dir threads users loadusers gtid spw tpw
  if [[ "$(atk_ids_get "$(db_get "$id" path)" "$id.load" 2>/dev/null || true)" == done ]]; then
    atk_log "$(db_label "$id"): the initial copy is already loaded"
    return 0
  fi
  dir="$(my_dump_dir "$id")"
  threads="$(db_get "$id" threads)"
  if [[ "$(db_get "$id" engine)" == mariadb ]]; then
    local dumper file
    dumper="$(command -v mariadb-dump || command -v mysqldump || true)"
    [[ -n "$dumper" ]] || atk_die 3 "mariadb-dump (or mysqldump) is missing on the controller"
    file="$dir.sql"
    mkdir -p "$(dirname "$file")"
    _my_conn "$id" src
    spw="$_MY_PW"
    mapfile -t schemas < <(my_user_schemas "$id")
    (( $\{#schemas[@]} )) || atk_die 5 "$(db_label "$id"): no user schemas on the source"
    db_changed
    atk_run "$dumper" --defaults-extra-file=<(my_cnf "$spw") "$\{_MY_ARGS[@]}" --single-transaction --routines --triggers --events --gtid --master-data=2 --result-file="$file" --databases "$\{schemas[@]}"
    if (( repl )) && [[ -f "$file" ]]; then
      gtid="$(sed -n "s/^-- SET GLOBAL gtid_slave_pos='\\([^']*\\)'.*/\\1/p" "$file" | head -n 1)"
      [[ -n "$gtid" ]] || atk_die 1 "$(db_label "$id"): the dump holds no GTID position"
      atk_ids_put "$(db_get "$id" path)" "$id.gtid" "$gtid"
    fi
    _my_conn "$id" tgt
    atk_log "$(db_label "$id"): load the dump into the target"
    db_changed
    atk_run mysql --defaults-extra-file=<(my_cnf "$_MY_PW") "$\{_MY_ARGS[@]}" -e "source $file"
  else
    atk_need mysqlsh
    users=true; loadusers=false
    if [[ "$(db_get "$id" load_users)" == 1 || "$(my_kind "$id")" == vm ]]; then loadusers=true; fi
    _my_conn "$id" src
    spw="$_MY_PW"
    if [[ ! -f "$dir/@.done.json" ]]; then
      if [[ -d "$dir" ]]; then db_changed; atk_run rm -rf -- "$dir"; fi
      db_changed
      printf '%s\n' "$spw" | atk_run mysqlsh --passwords-from-stdin --uri "$(my_uri)" --ssl-mode="$(db_get "$id" my_ssl_mode)" --js \
        -e "util.dumpInstance('$dir', {consistent: true, threads: $threads, users: $users, excludeUsers: ['root', '$(db_get "$id" repl_user)']})"
    fi
    _my_conn "$id" tgt
    tpw="$_MY_PW"
    if (( repl )); then gtid="updateGtidSet: 'append', skipBinlog: true, "; else gtid=""; fi
    db_changed
    printf '%s\n' "$tpw" | atk_run mysqlsh --passwords-from-stdin --uri "$(my_uri)" --ssl-mode="$(db_get "$id" my_ssl_mode)" --js \
      -e "util.loadDump('$dir', {threads: $threads, $\{gtid}loadUsers: $loadusers, ignoreVersion: true})"
  fi
  if (( ! ATK_DRY_RUN )); then atk_ids_put "$(db_get "$id" path)" "$id.load" done; fi
}
# my_target_checks ID: the target can take the replication (or the load) the kit sets up.
my_target_checks() {
  local id="$1" kind engine
  kind="$(my_kind "$id")"
  engine="$(db_get "$id" engine)"
  case "$kind" in
    heatwave) atk_die 5 "$(db_label "$id"): HeatWave takes inbound replication through an OCI channel; use the oci-dms path, or create the channel from the runbook" ;;
    cloudsql|other) atk_die 5 "$(db_label "$id"): a $kind target is not replicated by this path; use gcp-dms or mysql-dump" ;;
  esac
  if [[ "$engine" == mariadb && ( "$kind" == aurora || "$kind" == azure ) ]]; then
    atk_die 5 "$(db_label "$id"): binlog replication from MariaDB to a MySQL service is not supported; use mysql-dump"
  fi
  if [[ "$engine" == mysql ]]; then
    [[ "$(my_q "$id" tgt "SELECT @@local_infile")" == 1 ]] || atk_die 5 "$(db_label "$id"): MySQL Shell's load needs local_infile = 1 on the target (a parameter on managed services)"
  fi
}
# my_caught_up ID: the target has applied everything the source executed (GTID sets for MySQL, lag 0 for MariaDB).
my_caught_up() {
  local id="$1" set
  my_in_sync "$id" tgt || return 1
  if [[ "$(db_get "$id" engine)" == mariadb ]]; then [[ "$(my_lag "$id" tgt)" == 0 ]]; return; fi
  set="$(my_q "$id" src "SELECT @@GLOBAL.gtid_executed")"
  [[ "$(my_q "$id" tgt "SELECT GTID_SUBSET($(my_lit "$\{set//$'\n'/}"), @@GLOBAL.gtid_executed)")" == 1 ]]
}
`;

const MY_REPL_VERBS = withTestSkips({
  prepare: code`
my_need_binlog "$id" src
my_target_checks "$id"
if db_on "$id" reverse && [[ "$(db_get "$id" reverse_supported)" == 1 ]]; then my_need_binlog "$id" tgt; fi
my_repl_user "$id" src
my_load "$id" 1
db_finish "$id" prepared "binlogs checked, the replication user on the source, the initial copy loaded"`,
  replicate: code`
if ! my_is_replica_of "$id" tgt && [[ "$(db_phase "$id")" != cut-over ]]; then
  my_x "$id" tgt "point the target at the source" "$(my_source_sql "$id" tgt)"
fi
atk_wait_until "$DB_WAIT_MINUTES" 30 my_in_sync "$id" tgt || true
my_status "$id"`,
  status: 'my_status "$id"',
  cutover: code`
if [[ "$(db_phase "$id")" == cut-over ]]; then atk_skip "$id" "already cut over" cut-over; fi
if my_is_replica_of "$id" tgt; then
  atk_wait_until 30 5 my_caught_up "$id" || atk_fail "$id" "the target did not catch up after the freeze; nothing was switched"
  my_x "$id" tgt "stop the replication from the source" "$(my_stop_sql "$id" tgt)"
fi
my_reverse "$id"
db_phase "$id" cut-over
if my_is_replica_of "$id" src; then rev=true; else rev=false; fi
atk_done "$id" cut-over "the target is current; reverse replication: $rev" reverse="$rev"`,
  commit: 'atk_skip "$id" "nothing to commit: the reverse replication stays until finalize"',
  rollback: code`
if [[ "$(db_phase "$id")" == rolled-back ]]; then atk_skip "$id" "already rolled back"; fi
if my_is_replica_of "$id" src; then
  my_reverse_rollback "$id"
  db_phase "$id" rolled-back
  atk_done "$id" "" "the source has the target's writes and is writable again: switch the applications back"
fi
if [[ "$(db_phase "$id")" == cut-over ]]; then
  db_phase "$id" rolled-back
  atk_done "$id" "" "no reverse replication: the source is as it was at the freeze, and writes made on the target since cutover are not carried back"
fi
if my_is_replica_of "$id" tgt; then
  my_x "$id" tgt "stop the replication from the source" "$(my_stop_sql "$id" tgt)"
  db_phase "$id" rolled-back
  atk_done "$id" "" "replication to the target is stopped; the source was only frozen and is unchanged"
fi
atk_skip "$id" "nothing to roll back: the source was not changed"`,
  finalize: code`
my_teardown "$id"
dir="$(my_dump_dir "$id")"
if [[ -e "$dir" ]]; then db_changed; atk_run rm -rf -- "$dir"; fi
if [[ -e "$dir.sql" ]]; then db_changed; atk_run rm -f -- "$dir.sql"; fi
db_finish "$id" "" "replication removed in both directions, the replication users dropped"`,
});

const MY_DUMP_VERBS = withTestSkips({
  prepare: code`
src="$(my_version "$id" src)"
tgt="$(my_version "$id" tgt)"
if [[ "$(db_get "$id" engine)" == mysql ]]; then
  [[ "$(my_q "$id" tgt "SELECT @@local_infile")" == 1 ]] || atk_die 5 "$(db_label "$id"): MySQL Shell's load needs local_infile = 1 on the target"
fi
atk_skip "$id" "both ends answer (source $src, target $tgt)" prepared`,
  replicate: 'atk_skip "$id" "an offline path: the copy runs at cutover, after the freeze"',
  status: 'atk_skip "$id" "an offline path: nothing replicates"',
  cutover: code`
if [[ "$(db_phase "$id")" == cut-over ]]; then atk_skip "$id" "already loaded" cut-over; fi
my_load "$id" 0
db_phase "$id" cut-over
atk_done "$id" cut-over "dumped and loaded"`,
  commit: 'atk_skip "$id" "nothing to commit on an offline path"',
  rollback: 'atk_skip "$id" "nothing to roll back: the source was only frozen and is unchanged; the target is kept for analysis"',
  finalize: code`
dir="$(my_dump_dir "$id")"
if [[ -e "$dir" ]]; then db_changed; atk_run rm -rf -- "$dir"; fi
if [[ -e "$dir.sql" ]]; then db_changed; atk_run rm -f -- "$dir.sql"; fi
db_finish "$id" "" "the dump is removed"`,
});

// ---------------------------------------------------------------------------
// azure-pg-migration
// ---------------------------------------------------------------------------

const AZPG_FUNCS = code`
DB_WAIT_MINUTES="$\{ATK_DB_WAIT_MINUTES:-240}"

azpg_args() { printf '%s\n' -g "$(db_need "$1" resource_group)" -n "$(db_need "$1" azure_server)" --migration-name "$(atk_name "$1")"; }
# azpg_show ID: the migration as JSON ("" when it does not exist).
azpg_show() {
  local -a a
  mapfile -t a < <(azpg_args "$1")
  az postgres flexible-server migration show "$\{a[@]}" -o json 2>/dev/null || true
}
azpg_state() { azpg_show "$1" | jq -r '(.currentStatus.state // "") + "/" + (.currentStatus.currentSubStateDetails.currentSubState // "")'; }
azpg_waiting_cutover() { [[ "$(azpg_state "$1")" == */WaitingForCutoverTrigger ]]; }
azpg_succeeded() { [[ "$(azpg_state "$1")" == Succeeded/* ]]; }
azpg_status() {
  local id="$1" st
  st="$(azpg_state "$id")"
  case "$st" in
    /) atk_done "$id" planned "no migration yet" inSync=false ;;
    */WaitingForCutoverTrigger) atk_done "$id" in-sync "the migration service waits for the cutover trigger" inSync=true serviceState="$st" ;;
    Succeeded/*) atk_done "$id" cut-over "the migration service reports Succeeded" serviceState="$st" ;;
    Failed/*|Canceled/*) atk_fail "$id" "the migration service reports $st" ;;
    *) atk_done "$id" replicating "the migration service reports $st" inSync=false serviceState="$st" ;;
  esac
}
# azpg_create ID: the online migration, its properties (with both passwords) in a mode-600 runtime file removed at exit.
azpg_create() {
  local id="$1" props src
  local -a a
  mapfile -t a < <(azpg_args "$id")
  src="$(db_need "$id" src_host):$(db_need "$id" src_port)@$(db_need "$id" src_user)"
  atk_tmpfile props
  db_secret_to ATK_AZPG_SRC_PW SRC "$id"
  db_secret_to ATK_AZPG_TGT_PW TGT "$id"
  ATK_AZPG_SRC_PW="$ATK_AZPG_SRC_PW" ATK_AZPG_TGT_PW="$ATK_AZPG_TGT_PW" jq -n \
    --arg src "$src" --arg db "$(pg_db "$id")" --arg ssl "$(db_get "$id" azpg_ssl_mode)" \
    '{properties: {sourceDbServerResourceId: $src, sourceType: "OnPremises", sslMode: $ssl, dbsToMigrate: [$db], overwriteDbsInTarget: "false",
      secretParameters: {adminCredentials: {sourceServerPassword: $ENV.ATK_AZPG_SRC_PW, targetServerPassword: $ENV.ATK_AZPG_TGT_PW}}}}' > "$props"
  unset ATK_AZPG_SRC_PW ATK_AZPG_TGT_PW
  db_changed
  atk_run az postgres flexible-server migration create "$\{a[@]}" --migration-mode online --migration-option ValidateAndMigrate --properties "$props" -o none
}
`;

const AZPG_VERBS = withTestSkips({
  prepare: code`
atk_need az
az postgres flexible-server show -g "$(db_need "$id" resource_group)" -n "$(db_need "$id" azure_server)" -o none || atk_die 5 "$(db_label "$id"): the Flexible Server is not there yet: apply terraform first"
pg_need_logical "$id" src
if db_on "$id" reverse; then
  lvl="$(pg_wal_level "$id" tgt)"
  [[ "$lvl" == logical ]] || atk_die 5 "$(db_label "$id"): the reverse replication needs wal_level = logical on the target ($(pg_wal_hint "$id" tgt)), or set ATK_DB_$\{DB_TOK[$id]}_REVERSE=0 to accept no fallback"
fi
atk_skip "$id" "the target server answers and logical decoding is on" prepared`,
  replicate: code`
if [[ "$(azpg_state "$id")" == / ]]; then azpg_create "$id"; fi
atk_wait_until "$DB_WAIT_MINUTES" 60 azpg_waiting_cutover "$id" || true
azpg_status "$id"`,
  status: 'azpg_status "$id"',
  cutover: code`
if [[ "$(db_phase "$id")" == cut-over ]]; then atk_skip "$id" "already cut over" cut-over; fi
if ! azpg_succeeded "$id"; then
  atk_wait_until 30 20 azpg_waiting_cutover "$id" || atk_fail "$id" "the migration service is not waiting for the cutover trigger ($(azpg_state "$id"))"
  mapfile -t a < <(azpg_args "$id")
  db_changed
  atk_run az postgres flexible-server migration update "$\{a[@]}" --cutover -o none
  atk_wait_until 60 20 azpg_succeeded "$id" || atk_fail "$id" "the migration did not reach Succeeded after the cutover trigger ($(azpg_state "$id"))"
fi
pg_sync_sequences "$id" src tgt
pg_reverse "$id"
db_phase "$id" cut-over
if db_on "$id" reverse; then rev=true; else rev=false; fi
atk_done "$id" cut-over "the migration service cut over; reverse replication: $rev" reverse="$rev"`,
  commit: 'atk_skip "$id" "nothing to commit: the reverse replication stays until finalize"',
  rollback: code`
if [[ "$(db_phase "$id")" == rolled-back ]]; then atk_skip "$id" "already rolled back"; fi
if pg_has "$id" src sub "$(pg_rev "$id")"; then
  pg_reverse_rollback "$id"
  db_phase "$id" rolled-back
  atk_done "$id" "" "the source has the target's writes (reverse lag 0): switch the applications back"
fi
if [[ "$(db_phase "$id")" == cut-over ]]; then
  db_phase "$id" rolled-back
  atk_done "$id" "" "no reverse replication: writes made on the target since cutover are not carried back"
fi
st="$(azpg_state "$id")"
if [[ "$st" != / && "$st" != Succeeded/* && "$st" != Canceled/* ]]; then
  mapfile -t a < <(azpg_args "$id")
  db_changed
  atk_run az postgres flexible-server migration update "$\{a[@]}" --cancel -o none
  db_phase "$id" rolled-back
  atk_done "$id" "" "the migration is cancelled; the source was only frozen and is unchanged"
fi
atk_skip "$id" "nothing to roll back: the source was not changed"`,
  finalize: code`
pg_teardown "$id"
db_finish "$id" "" "the reverse replication objects and the replication role removed"`,
});

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

interface PathSpec {
  readonly summary: string;
  readonly needs: readonly string[];
  readonly engine: 'pg' | 'my';
  readonly functions: string;
  readonly verbs: ReturnType<typeof withTestSkips>;
  readonly settings: readonly DbSetting[];
  readonly secrets: readonly string[];
}

const SPECS: Readonly<Record<string, PathSpec>> = {
  'pg-logical': {
    summary: 'PostgreSQL logical replication (publication on the source, subscription on the target); reverse replication at cutover.',
    needs: ['psql', 'pg_dump', 'jq'], engine: 'pg', functions: PG_LOGICAL_FUNCS, verbs: PG_LOGICAL_VERBS, settings: PG_SETTINGS,
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>', 'REPL_DB_PASSWORD_<TOKEN>'],
  },
  'pg-dump': {
    summary: 'PostgreSQL offline copy: pg_dump -Fd and pg_restore at cutover.',
    needs: ['psql', 'pg_dump', 'pg_restore', 'jq'], engine: 'pg', functions: PG_DUMP_FUNCS, verbs: PG_DUMP_VERBS, settings: PG_DUMP_SETTINGS,
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>'],
  },
  'mysql-replication': {
    summary: 'MySQL / MariaDB binlog replication into a VM, Amazon RDS, Aurora or Azure; reverse replication at cutover where the service exposes binlogs.',
    needs: ['mysql', 'jq'], engine: 'my', functions: MY_LOAD_FUNCS, verbs: MY_REPL_VERBS, settings: MY_SETTINGS,
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>', 'REPL_DB_PASSWORD_<TOKEN>'],
  },
  'mysql-dump': {
    summary: 'MySQL offline copy with MySQL Shell (util.dumpInstance / util.loadDump; mariadb-dump for MariaDB) at cutover.',
    needs: ['mysql', 'jq'], engine: 'my', functions: MY_LOAD_FUNCS, verbs: MY_DUMP_VERBS, settings: MY_DUMP_SETTINGS,
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>'],
  },
  'azure-pg-migration': {
    summary: 'The Azure Database for PostgreSQL migration service (online), then reverse logical replication at cutover.',
    needs: ['az', 'psql', 'jq'], engine: 'pg', functions: AZPG_FUNCS, verbs: AZPG_VERBS, settings: AZPG_SETTINGS,
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>', 'REPL_DB_PASSWORD_<TOKEN>'],
  },
};

function scriptFor(path: DbMovePath, rows: DbRows, ctx: PathContext): string {
  const spec = SPECS[path]!;
  return shScript({
    file: ENTRY[path]!,
    paths: [path],
    summary: spec.summary,
    needs: spec.needs,
    functions: [DB_SH_BASE, shSettings(rows, ctx), spec.engine === 'pg' ? PG_SH : MY_SH, spec.functions].join('\n'),
    verbs: spec.verbs,
  });
}

/** The findings of these items: the replication credential, no reverse, MariaDB limits, endpoints at run time. */
function openSourceFindings(items: readonly ManifestItem[]): Finding[] {
  const out: Finding[] = [];
  for (const i of items) {
    if (i.path === 'pg-logical' || i.path === 'mysql-replication' || i.path === 'azure-pg-migration') out.push(replicationCredentialFinding(i));
    if (i.path === 'pg-dump' || i.path === 'mysql-dump') out.push(noReverseFinding(i, 'an offline copy'));
    if (i.path === 'mysql-replication') {
      const kind = myTargetKind(i.target.service);
      if (i.engine === 'mariadb' && (kind === 'aurora' || kind === 'azure')) {
        out.push(warning('exec.db.mariadb-to-mysql', `${i.name}: binlog replication from MariaDB into a MySQL service is not supported; the script stops at prepare.`, { path: i.id, remediation: 'Override the path to mysql-dump.' }));
      } else if (kind === 'heatwave' || kind === 'cloudsql' || kind === 'other') {
        out.push(warning('exec.db.replication-target', `${i.name}: this path cannot point a ${kind} target at a replication source; the script stops at prepare.`, { path: i.id, remediation: 'Use oci-dms (HeatWave), gcp-dms (Cloud SQL) or mysql-dump.' }));
      } else if (!myReverseSupported(i.engine, kind)) {
        out.push(noReverseFinding(i, `a ${kind} target exposes no binlogs to replicate back from`));
      }
    }
  }
  return out;
}

export const OPEN_SOURCE_GENERATOR: PathGenerator = Object.freeze({
  id: 'db-open-source',
  owner: 'WP-11d' as const,
  paths: OPEN_SOURCE_PATHS,
  needs: [
    need('command', 'psql', 'PostgreSQL paths (the client at the source major version or later)', { install: 'dnf install postgresql / apt install postgresql-client' }),
    need('command', 'pg_dump', 'PostgreSQL schema and offline copies'),
    need('command', 'pg_restore', 'the pg-dump path'),
    need('command', 'mysql', 'MySQL / MariaDB paths (the MySQL 8 client)', { install: 'dnf install mysql / apt install mysql-client' }),
    need('command', 'mysqlsh', 'MySQL Shell dump and load', { min: '8.0.32', install: 'https://dev.mysql.com/downloads/shell/' }),
    need('command', 'az', 'the Azure PostgreSQL migration service', { install: 'https://learn.microsoft.com/cli/azure/install-azure-cli' }),
  ],
  entry: (p: ExecPath) => ENTRY[p] ?? `${DB_DIR}/${p}.sh`,
  files(items: readonly ManifestItem[], ctx: PathContext): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    const readme: ReadmeItem[] = [];
    const merged = new Map<string, Readonly<Record<string, string>>>();
    const tokens = new Map<string, string>();
    for (const path of OPEN_SOURCE_PATHS) {
      const list = onPath(items, path);
      if (!list.length) continue;
      const rows = dbRows(list, extraFor(path));
      out[ENTRY[path]!] = scriptFor(path, rows, ctx);
      for (const [k, v] of rows.rows) merged.set(k, v);
      for (const [k, v] of rows.tokens) tokens.set(k, v);
      for (const i of list) readme.push({ item: i, script: ENTRY[path]!, settings: [...BASE_SETTINGS, ...SPECS[path]!.settings], secrets: SPECS[path]!.secrets });
    }
    const allRows: DbRows = { rows: merged, tokens };
    out[`${DB_DIR}/README-open-source.md`] = dbReadme(
      'PostgreSQL and MySQL paths',
      'Run from the migration controller. The verbs follow the wave: prepare, replicate (waits for the first copy; --once polls), cutover (after the freeze), rollback, finalize.',
      readme, allRows,
    );
    return out;
  },
  findings(items: readonly ManifestItem[]): readonly Finding[] {
    const tokens = new Map<string, string>();
    const rows = new Map<string, Record<string, string>>();
    for (const path of OPEN_SOURCE_PATHS) {
      const r = dbRows(onPath(items, path), extraFor(path));
      for (const [k, v] of r.rows) rows.set(k, { ...v });
      for (const [k, v] of r.tokens) tokens.set(k, v);
    }
    return [...openSourceFindings(items), ...endpointFinding(items, { rows, tokens })];
  },
});

export const GENERATORS: readonly PathGenerator[] = Object.freeze([OPEN_SOURCE_GENERATOR]);
