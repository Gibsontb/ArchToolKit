/**
 * What every database path generator (WP-11d) shares: the per-item
 * connection settings, the bash and PowerShell helpers that read them, the
 * PostgreSQL and MySQL helpers (forward and reverse replication), the
 * README each module writes and the findings the paths carry.
 *
 * Settings. Each database item gets a row of non-secret settings (hosts,
 * ports, users, names) rendered into its script; any of them can be
 * overridden at run time with `ATK_DB_<TOKEN>_<KEY>` (the token is the
 * database name in upper case, `[A-Z0-9_]`). Values the plan cannot know
 * (a target endpoint, a resource group) are left empty, and the verb that
 * needs one stops with exit 5 naming the variable.
 *
 * Credentials. `SRC_DB_PASSWORD_<TOKEN>`, `TGT_DB_PASSWORD_<TOKEN>` and
 * `REPL_DB_PASSWORD_<TOKEN>` are read with `atk_secret` / `Get-AtkSecret`
 * (the environment, a mode-600 `_FILE`, or `ATK_VAULT_CMD`) and reach the
 * tools only through the environment (`PGPASSWORD`), stdin (SQL sent on
 * stdin, `mysqlsh --passwords-from-stdin`), an unnamed pipe
 * (`--defaults-extra-file=<(...)`), or an in-memory PSCredential. Nothing
 * here writes one to a file, and no password is ever a command argument.
 *
 * Pure: no DOM, no file system.
 */

import { info, warning,              } from '../../../../core/findings.js';
import { DB_SERVICE_LABELS } from '../../options.js';
                                                                        
import { shortHash,                          } from '../contract.js';
import { code } from '../lib-sh.js';
                                                   
import { pathLabel } from '../paths.js';
                                                            

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Where the database scripts live, relative to `migration/execute/`. */
export const DB_DIR = 'paths/db';

/** `<name>` as an environment-variable token: upper case, `[A-Z0-9_]`, never starting with a digit. */
export function envToken(name        )         {
  const t = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'DB';
  return /^[0-9]/.test(t) ? `DB_${t}` : t;
}

/** A token per item, unique within the kit (a clash gets a short hash). */
export function itemTokens(items                         )                      {
  const out = new Map                ();
  const seen = new Map                ();
  for (const i of items) seen.set(envToken(i.name), (seen.get(envToken(i.name)) ?? 0) + 1);
  for (const i of items) {
    const t = envToken(i.name);
    out.set(i.id, (seen.get(t) ?? 0) > 1 ? `${t}_${shortHash(i.id).slice(0, 6).toUpperCase()}` : t);
  }
  return out;
}

/** The kit's name for replication objects (publications, slots, users): the resource name with `_` for `-`. */
export function sqlName(item              )         {
  return item.resource.replace(/-/g, '_');
}

/** A bash single-quoted word. */
export const shq = (s        )         => `'${s.replace(/'/g, `'\\''`)}'`;
/** A PowerShell single-quoted string. */
export const psq = (s        )         => `'${s.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------
// Per-item settings
// ---------------------------------------------------------------------------

                                   

/** One setting a script reads: its key, what it is, and whether the verbs need it. */
                            
                       
                        
                              
 

/** The settings every database item has. */
export const BASE_SETTINGS                       = Object.freeze([
  { key: 'dbname', help: 'the database (or service) name on the source and the target' },
  { key: 'src_host', help: 'the source database host (a name or an IPv4 / IPv6 address)', required: true },
  { key: 'src_port', help: 'the source port' },
  { key: 'src_user', help: 'the source administrator' },
  { key: 'tgt_host', help: 'the target endpoint (from the Terraform outputs once the target exists)', required: true },
  { key: 'tgt_port', help: 'the target port' },
  { key: 'tgt_user', help: 'the target administrator' },
  { key: 'repl_user', help: 'the dedicated replication user the kit creates and drops at finalize' },
]);

const DEFAULT_PORT                                              = {
  oracle: 1521, sqlserver: 1433, postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017,
};
const IAAS_SERVICES                         = ['aws-ec2', 'azure-vm', 'azure-sqlvm', 'google-gce', 'oci-compute', 'vmware-vm'];
export const isIaasTarget = (s                         )          => !!s && IAAS_SERVICES.includes(s);

/** The source administrator the kit assumes (override with ATK_DB_<TOKEN>_SRC_USER). */
function sourceUser(engine                      )         {
  switch (engine) {
    case 'postgres': return 'postgres';
    case 'mysql': case 'mariadb': return 'root';
    case 'oracle': return 'SYSTEM';
    case 'sqlserver': return 'sa';
    default: return 'admin';
  }
}
/** The target administrator: the engine's own on a VM, the migration blueprints' `dbadmin` on a managed service. */
function targetUser(engine                      , service                         )         {
  if (isIaasTarget(service)) return sourceUser(engine);
  if (engine === 'oracle' && service && /adb$/.test(service)) return 'ADMIN';
  return 'dbadmin';
}

/** The base settings of an item, as the plan knows them. */
export function baseSettings(item              )                         {
  const port = String(DEFAULT_PORT[item.engine ?? 'other'] ?? '');
  return {
    name: item.name,
    resource: item.resource,
    path: item.path,
    engine: item.engine ?? '',
    version: item.version ?? '',
    service: item.target.service ?? '',
    platform: item.target.platform ?? '',
    region: item.target.region ?? '',
    target_version: item.target.engineVersion ?? '',
    dbname: item.name,
    src_host: item.source.host ?? '',
    src_port: port,
    src_user: sourceUser(item.engine),
    tgt_host: '',
    tgt_port: port,
    tgt_user: targetUser(item.engine, item.target.service),
    repl_user: 'atk_repl',
    sqlname: sqlName(item),
  };
}

                         
                                               
                                                                       
 

/** Every item's settings: the base row plus the path's own keys. */
export function dbRows(items                         , extra                                                 = () => ({}))         {
  const tokens = itemTokens(items);
  const rows = new Map                                ();
  for (const i of items) rows.set(i.id, { ...baseSettings(i), ...extra(i), envtok: tokens.get(i.id)  });
  return { tokens, rows };
}

// ---------------------------------------------------------------------------
// Bash: the settings and the helpers every database script has
// ---------------------------------------------------------------------------

/** The settings as bash associative arrays (sorted, so the text is reproducible). */
export function shSettings(rows        , ctx             )         {
  const ids = [...rows.rows.keys()].sort();
  const conf           = [];
  for (const id of ids) {
    const r = rows.rows.get(id) ;
    for (const k of Object.keys(r).sort()) conf.push(`  [${shq(`${id}|${k}`)}]=${shq(r[k] )}`);
  }
  const toks = ids.map((id) => `  [${shq(id)}]=${shq(rows.tokens.get(id) )}`);
  return [
    '# The settings of each database (none of them secret). Override any at run time with ATK_DB_<TOKEN>_<KEY>.',
    `declare -A DB_TOK=(\n${toks.join('\n')}\n)`,
    `declare -A DB_CONF=(\n${conf.join('\n')}\n)`,
    `# The replication lag allowed at cutover, in seconds (Execute › Settings).`,
    `DB_LAG_MAX="$\{ATK_DB_LAG_MAX:-${ctx.settings.lagSeconds.db}}"`,
  ].join('\n').replace(/\$\\\{/g, '${');
}

/** The bash helpers every database script shares. */
export const DB_SH_BASE = code`
shopt -s inherit_errexit

# db_get ID KEY: a setting, from ATK_DB_<TOKEN>_<KEY> when set, else the generated value.
db_get() {
  local id="$1" key="$2" var
  var="ATK_DB_$\{DB_TOK[$id]:-X}_$\{key^^}"
  if [[ -n "$\{!var:-}" ]]; then printf '%s' "$\{!var}"; else printf '%s' "$\{DB_CONF["$id|$key"]:-}"; fi
}
# db_need ID KEY: the same, stopping with exit 5 (a pre-check) when it is empty.
db_need() {
  local v
  v="$(db_get "$1" "$2")"
  [[ -n "$v" ]] || atk_die 5 "$(db_label "$1"): set ATK_DB_$\{DB_TOK[$1]:-X}_$\{2^^} (see paths/db/README-*.md)"
  printf '%s' "$v"
}
db_label() { printf '%s' "$\{ATK_NAME[$1]:-$1}"; }
db_side() { case "$1" in src) printf 'source' ;; tgt) printf 'target' ;; *) printf '%s' "$1" ;; esac; }
# db_on ID KEY: true unless the setting is 0, false, no or off.
db_on() { case "$(db_get "$1" "$2")" in 0|false|no|off|FALSE|NO|OFF) return 1 ;; *) return 0 ;; esac; }
# db_secret_to VAR ROLE ID: the credential ROLE_DB_PASSWORD_<TOKEN> (ROLE: SRC, TGT, REPL) into VAR, never echoed.
db_secret_to() { atk_secret_to "$1" "$2_DB_PASSWORD_$\{DB_TOK[$3]:-X}"; }
# db_host_url HOST: the host as a URL authority part (IPv6 literals in brackets).
db_host_url() { if [[ "$1" == *:* && "$1" != \[* ]]; then printf '[%s]' "$1"; else printf '%s' "$1"; fi; }
# db_work ID: the item's work directory at run time (dumps, rendered response files); never inside the kit.
db_work() {
  local d="$\{ATK_DB_WORK_DIR:-$ATK_STATUS/work}/$(atk_name "$1")"
  mkdir -p "$d"
  chmod 700 "$d"
  printf '%s' "$d"
}
# db_lag_ok SECONDS: within the lag allowed at cutover.
db_lag_ok() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 <= DB_LAG_MAX )); }
db_skip_test() { atk_skip "$1" "a database is tested with its application (the server path's test); this path opens no test copy"; }
# DB_CHANGED: set by every change a verb makes (or prints, with --dry-run); db_finish then reports succeeded, else skipped.
DB_CHANGED=0
db_changed() { DB_CHANGED=1; }
# db_finish ID STATE DETAIL [k=v...]: the verb's terminal event: succeeded when it changed something, skipped when all was in place.
db_finish() {
  local id="$1" state="$2" detail="$3"
  shift 3
  if (( DB_CHANGED )); then atk_done "$id" "$state" "$detail" "$@"; fi
  atk_skip "$id" "already in place: $detail" "$state" "$@"
}
# db_read VAR CMD...: a read whose failure stops the verb with exit 1 (a failed read must never look like "absent").
db_read() {
  local _db_n="$1" _db_v
  shift
  _db_v="$("$@")" || atk_die 1 "a read failed ($1): see the lines above"
  printf -v "$_db_n" '%s' "$_db_v"
}
# db_sql_guard ID SQL: a change with no SQL means a read that built it failed.
db_sql_guard() { [[ -n "$2" ]] || atk_die 1 "$(db_label "$1"): no SQL to run (a read that builds it failed: see the lines above)"; }
# db_phase ID [PHASE]: the item's phase in this path's id cache (cut-over, rolled-back ...): read, or record.
db_phase() {
  if (( $# > 1 )); then atk_ids_put "$(db_get "$1" path)" "$1.phase" "$2"; else atk_ids_get "$(db_get "$1" path)" "$1.phase" 2>/dev/null || true; fi
}
`;

// ---------------------------------------------------------------------------
// PostgreSQL helpers (psql, pg_dump on the controller)
// ---------------------------------------------------------------------------

/**
 * PostgreSQL: reads (`pg_q`), changes (`pg_x`, through `atk_run`, SQL on
 * stdin), the replication role, the publication / subscription pair in
 * either direction, the lag, the sequences and the teardown. Passwords reach
 * psql as PGPASSWORD; the subscription's connection string is sent on stdin
 * and lives in the subscriber's catalog (a property of PostgreSQL:
 * `exec.db.replication-credential`).
 */
export const PG_SH = code`
# ---------------------------------------------------------------- PostgreSQL

_pg_conn() {
  local id="$1" side="$2" host port user role
  case "$side" in src) role=SRC ;; tgt) role=TGT ;; *) atk_die 1 "pg: unknown side $side" ;; esac
  host="$(db_need "$id" "$\{side}_host")"
  port="$(db_need "$id" "$\{side}_port")"
  user="$(db_need "$id" "$\{side}_user")"
  # _PG_CONN: the connection (every PostgreSQL client); _PG_ARGS: psql's, with its options.
  _PG_CONN=(-h "$host" -p "$port" -U "$user")
  _PG_ARGS=(-X -v ON_ERROR_STOP=1 "$\{_PG_CONN[@]}")
  db_secret_to _PG_PW "$role" "$id"
  _PG_SSL="$(db_get "$id" pg_sslmode)"
}
# pg_q ID SIDE DB SQL: a read; rows unaligned, tab-separated.
pg_q() {
  _pg_conn "$1" "$2"
  printf '%s\n' "$4" | PGPASSWORD="$_PG_PW" PGSSLMODE="$\{_PG_SSL:-require}" PGCONNECT_TIMEOUT=15 psql "$\{_PG_ARGS[@]}" -d "$3" -At -F $'\t' \
    || atk_die 1 "$(db_label "$1"): cannot read the $(db_side "$2") database $3"
}
# pg_x ID SIDE DB WHAT SQL: a change (printed, not run, with --dry-run). WHAT is logged; the SQL is not (it may hold a password).
pg_x() {
  _pg_conn "$1" "$2"
  atk_log "$(db_label "$1"): $4 (on the $(db_side "$2"))"
  db_sql_guard "$1" "$5"
  DB_CHANGED=1
  printf '%s\n' "$5" | PGPASSWORD="$_PG_PW" PGSSLMODE="$\{_PG_SSL:-require}" PGCONNECT_TIMEOUT=15 atk_run psql "$\{_PG_ARGS[@]}" -d "$3" -q -o /dev/null \
    || atk_die 1 "$(db_label "$1"): $4 failed on the $(db_side "$2")"
}
pg_lit() { local s="$\{1//\'/\'\'}"; printf "'%s'" "$s"; }
pg_ident() { local s="$\{1//\"/\"\"}"; printf '"%s"' "$s"; }
# pg_ci_val VALUE: a libpq connection-string value, quoted.
pg_ci_val() { local v="$\{1//\\/\\\\}"; v="$\{v//\'/\\\'}"; printf "'%s'" "$v"; }
pg_db() { db_need "$1" dbname; }
pg_major() { local v; db_read v pg_q "$1" "$2" postgres "SHOW server_version_num"; printf '%s' "$(( v / 10000 ))"; }
pg_wal_level() { pg_q "$1" "$2" postgres "SHOW wal_level"; }
pg_has() {
  local id="$1" side="$2" what="$3" name="$4" sql
  case "$what" in
    pub) sql="SELECT 1 FROM pg_publication WHERE pubname = $(pg_lit "$name")" ;;
    sub) sql="SELECT 1 FROM pg_subscription WHERE subname = $(pg_lit "$name")" ;;
    slot) sql="SELECT 1 FROM pg_replication_slots WHERE slot_name = $(pg_lit "$name")" ;;
    role) sql="SELECT 1 FROM pg_roles WHERE rolname = $(pg_lit "$name")" ;;
  esac
  local out
  db_read out pg_q "$id" "$side" "$(pg_db "$id")" "$sql"
  [[ "$out" == 1 ]]
}
pg_other() { if [[ "$1" == src ]]; then printf tgt; else printf src; fi; }
pg_fwd() { printf '%s' "$(db_get "$1" sqlname)"; }
pg_rev() { printf '%s_rev' "$(db_get "$1" sqlname)"; }
# pg_wal_hint ID SIDE: how to turn on logical decoding on that side's service.
pg_wal_hint() {
  local svc
  if [[ "$2" == src ]]; then svc=vm; else svc="$(db_get "$1" service)"; fi
  case "$svc" in
    aws-rds|aws-aurora) printf 'set rds.logical_replication = 1 in the parameter group and reboot' ;;
    azure-pg-flex) printf 'set the server parameter wal_level = logical and restart' ;;
    google-cloudsql|google-alloydb) printf 'set the flag cloudsql.logical_decoding = on (AlloyDB: alloydb.logical_decoding) and restart' ;;
    *) printf 'ALTER SYSTEM SET wal_level = logical; then restart PostgreSQL' ;;
  esac
}
# pg_need_logical ID SIDE: exit 5 unless wal_level is logical.
pg_need_logical() {
  local lvl
  lvl="$(pg_wal_level "$1" "$2")"
  [[ "$lvl" == logical ]] || atk_die 5 "$(db_label "$1"): wal_level is $lvl on the $(db_side "$2"); $(pg_wal_hint "$1" "$2")"
}
# pg_repl_role ID SIDE: the dedicated replication role (login, replication, read access), created once.
pg_repl_role() {
  local id="$1" side="$2" user pw body
  user="$(db_need "$id" repl_user)"
  if pg_has "$id" "$side" role "$user"; then atk_log "$(db_label "$id"): replication role $user already on the $(db_side "$side")"; return 0; fi
  db_secret_to pw REPL "$id"
  body='DO $atk$
DECLARE r record;
BEGIN
  EXECUTE format('"'"'CREATE ROLE %I LOGIN PASSWORD %L'"'"', '"$(pg_lit "$user")"', '"$(pg_lit "$pw")"');
  BEGIN EXECUTE format('"'"'ALTER ROLE %I REPLICATION'"'"', '"$(pg_lit "$user")"'); EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '"'"'rds_replication'"'"') THEN EXECUTE format('"'"'GRANT rds_replication TO %I'"'"', '"$(pg_lit "$user")"'); END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '"'"'pg_read_all_data'"'"') THEN
    EXECUTE format('"'"'GRANT pg_read_all_data TO %I'"'"', '"$(pg_lit "$user")"');
  ELSE
    FOR r IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE '"'"'pg\_%'"'"' AND nspname <> '"'"'information_schema'"'"' LOOP
      EXECUTE format('"'"'GRANT USAGE ON SCHEMA %I TO %I'"'"', r.nspname, '"$(pg_lit "$user")"');
      EXECUTE format('"'"'GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I'"'"', r.nspname, '"$(pg_lit "$user")"');
    END LOOP;
  END IF;
END $atk$;'
  pg_x "$id" "$side" "$(pg_db "$id")" "create the replication role $user" "$body"
}
# pg_drop_role ID SIDE
pg_drop_role() {
  local id="$1" side="$2" user
  user="$(db_need "$id" repl_user)"
  pg_has "$id" "$side" role "$user" || return 0
  pg_x "$id" "$side" "$(pg_db "$id")" "drop the replication role $user" "DROP OWNED BY $(pg_ident "$user"); DROP ROLE $(pg_ident "$user");"
}
# pg_user_tables ID SIDE: the user tables, as a comma list of qualified names.
pg_user_tables() {
  pg_q "$1" "$2" "$(pg_db "$1")" "SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY 1) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg\_%'"
}
# pg_publish ID SIDE NAME: a publication of every user table (FOR ALL TABLES where the admin is a superuser).
pg_publish() {
  local id="$1" side="$2" name="$3" super tables
  if pg_has "$id" "$side" pub "$name"; then atk_log "$(db_label "$id"): publication $name already on the $(db_side "$side")"; return 0; fi
  super="$(pg_q "$id" "$side" "$(pg_db "$id")" "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")"
  if [[ "$super" == t ]]; then
    pg_x "$id" "$side" "$(pg_db "$id")" "create the publication $name" "CREATE PUBLICATION $name FOR ALL TABLES;"
  else
    tables="$(pg_user_tables "$id" "$side")"
    [[ -n "$tables" ]] || atk_die 5 "$(db_label "$id"): no user tables on the $(db_side "$side") to publish"
    pg_x "$id" "$side" "$(pg_db "$id")" "create the publication $name (every user table)" "CREATE PUBLICATION $name FOR TABLE $tables;"
  fi
}
# pg_subscribe ID SUBSCRIBER NAME COPY: a subscription on SUBSCRIBER to the publication NAME on the other side.
pg_subscribe() {
  local id="$1" side="$2" name="$3" copy="$4" pub host port pw ci
  pub="$(pg_other "$side")"
  if pg_has "$id" "$side" sub "$name"; then atk_log "$(db_label "$id"): subscription $name already on the $(db_side "$side")"; return 0; fi
  host="$(db_get "$id" "$\{pub}_host_seen_from_$\{side}")"
  [[ -n "$host" ]] || host="$(db_need "$id" "$\{pub}_host")"
  port="$(db_need "$id" "$\{pub}_port")"
  db_secret_to pw REPL "$id"
  ci="host=$(pg_ci_val "$host") port=$port dbname=$(pg_ci_val "$(pg_db "$id")") user=$(pg_ci_val "$(db_need "$id" repl_user)") password=$(pg_ci_val "$pw") sslmode=$(pg_ci_val "$(db_get "$id" pg_repl_sslmode)")"
  pg_x "$id" "$side" "$(pg_db "$id")" "create the subscription $name (copy_data = $copy)" \
    "CREATE SUBSCRIPTION $name CONNECTION $(pg_lit "$ci") PUBLICATION $name WITH (copy_data = $copy);"
}
# pg_lag ID PUBLISHER NAME: bytes the subscriber has not confirmed ("" when the slot is missing).
pg_lag() {
  pg_q "$1" "$2" "$(pg_db "$1")" "SELECT COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn), 0)::bigint FROM pg_replication_slots WHERE slot_name = $(pg_lit "$3")"
}
# pg_not_ready ID SUBSCRIBER NAME: tables of the subscription still copying.
pg_not_ready() {
  pg_q "$1" "$2" "$(pg_db "$1")" "SELECT count(*) FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid = r.srsubid WHERE s.subname = $(pg_lit "$3") AND r.srsubstate <> 'r'"
}
# pg_in_sync ID PUBLISHER NAME: every table ready and the slot fully confirmed.
pg_in_sync() {
  local id="$1" pub="$2" name="$3" lag waiting
  lag="$(pg_lag "$id" "$pub" "$name")"
  waiting="$(pg_not_ready "$id" "$(pg_other "$pub")" "$name")"
  [[ -n "$lag" && "$lag" == 0 && "$waiting" == 0 ]]
}
pg_sub_enabled() { local out; db_read out pg_q "$1" "$2" "$(pg_db "$1")" "SELECT subenabled FROM pg_subscription WHERE subname = $(pg_lit "$3")"; [[ "$out" == t ]]; }
pg_sub_disable() {
  local id="$1" side="$2" name="$3"
  pg_has "$id" "$side" sub "$name" || return 0
  if pg_sub_enabled "$id" "$side" "$name"; then
    pg_x "$id" "$side" "$(pg_db "$id")" "disable the subscription $name" "ALTER SUBSCRIPTION $name DISABLE;"
  fi
}
# pg_sync_sequences ID FROM TO: every sequence on TO set to its value on FROM (generated setval calls).
pg_sync_sequences() {
  local id="$1" from="$2" to="$3" sql
  sql="$(pg_q "$id" "$from" "$(pg_db "$id")" "SELECT format('SELECT pg_catalog.setval(%L, %s, true);', quote_ident(schemaname) || '.' || quote_ident(sequencename), last_value) FROM pg_sequences WHERE last_value IS NOT NULL ORDER BY 1")"
  if [[ -z "$sql" ]]; then atk_log "$(db_label "$id"): no sequences to carry to the $(db_side "$to")"; return 0; fi
  pg_x "$id" "$to" "$(pg_db "$id")" "set $(printf '%s\n' "$sql" | wc -l | tr -d ' ') sequence(s) on the $(db_side "$to") from the $(db_side "$from")" "$sql"
}
# pg_drop_sub ID SUBSCRIBER NAME: drop a subscription and its slot on the publisher, also when it is disabled.
pg_drop_sub() {
  local id="$1" side="$2" name="$3" pub
  pub="$(pg_other "$side")"
  if pg_has "$id" "$side" sub "$name"; then
    if ! pg_sub_enabled "$id" "$side" "$name"; then
      pg_x "$id" "$side" "$(pg_db "$id")" "detach the subscription $name from its slot" "ALTER SUBSCRIPTION $name SET (slot_name = NONE);"
    fi
    pg_x "$id" "$side" "$(pg_db "$id")" "drop the subscription $name" "DROP SUBSCRIPTION $name;"
  fi
  pg_drop_slot "$id" "$pub" "$name"
}
pg_slot_inactive() { [[ "$(pg_q "$1" "$2" "$(pg_db "$1")" "SELECT active FROM pg_replication_slots WHERE slot_name = $(pg_lit "$3")")" != t ]]; }
pg_drop_slot() {
  local id="$1" side="$2" name="$3"
  pg_has "$id" "$side" slot "$name" || return 0
  atk_wait_until 2 3 pg_slot_inactive "$id" "$side" "$name" || atk_die 1 "$(db_label "$id"): the slot $name is still in use on the $(db_side "$side")"
  pg_x "$id" "$side" "$(pg_db "$id")" "drop the replication slot $name" "SELECT pg_drop_replication_slot($(pg_lit "$name"));"
}
pg_drop_pub() {
  local id="$1" side="$2" name="$3"
  pg_has "$id" "$side" pub "$name" || return 0
  pg_x "$id" "$side" "$(pg_db "$id")" "drop the publication $name" "DROP PUBLICATION $name;"
}
# pg_ensure_db ID SIDE: create the database on that side when it is missing.
pg_ensure_db() {
  local id="$1" side="$2" db
  db="$(pg_db "$id")"
  local out
  db_read out pg_q "$id" "$side" postgres "SELECT 1 FROM pg_database WHERE datname = $(pg_lit "$db")"
  if [[ "$out" == 1 ]]; then return 0; fi
  pg_x "$id" "$side" postgres "create the database $db" "CREATE DATABASE $(pg_ident "$db");"
  if (( ATK_DRY_RUN )); then DB_DRY_NEW_DB=1; fi
}
# pg_table_count ID SIDE: user tables on that side.
pg_table_count() {
  pg_q "$1" "$2" "$(pg_db "$1")" "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg\_%'"
}
# pg_schema_copy ID: the schema only (no owners, no privileges) from the source to an empty target.
pg_schema_copy() {
  local id="$1" n spw tpw
  if (( ATK_DRY_RUN && $\{DB_DRY_NEW_DB:-0} )); then atk_log "$(db_label "$id"): dry-run: the schema would be copied into the new database"; return 0; fi
  n="$(pg_table_count "$id" tgt)"
  if [[ "$n" != 0 ]]; then atk_log "$(db_label "$id"): the target already has $n table(s); the schema is not copied again"; return 0; fi
  _pg_conn "$id" src
  spw="$_PG_PW"
  local -a sconn=("$\{_PG_CONN[@]}")
  _pg_conn "$id" tgt
  tpw="$_PG_PW"
  atk_log "$(db_label "$id"): copy the schema (pg_dump --schema-only) to the target"
  DB_CHANGED=1
  PGPASSWORD="$spw" PGSSLMODE="$\{_PG_SSL:-require}" pg_dump "$\{sconn[@]}" -d "$(pg_db "$id")" --schema-only --no-owner --no-privileges \
    | PGPASSWORD="$tpw" PGSSLMODE="$\{_PG_SSL:-require}" atk_run psql "$\{_PG_ARGS[@]}" -d "$(pg_db "$id")" -q \
    || atk_die 1 "$(db_label "$id"): the schema copy failed"
}

# ---- replication in either direction (forward: source to target; reverse: target to source, at cutover)

pg_status() {
  local id="$1" name pub lag waiting
  name="$(pg_fwd "$id")"
  pub=src
  if pg_has "$id" src sub "$(pg_rev "$id")"; then name="$(pg_rev "$id")"; pub=tgt; fi
  if ! pg_has "$id" "$(pg_other "$pub")" sub "$name"; then atk_done "$id" planned "no subscription yet" inSync=false; fi
  lag="$(pg_lag "$id" "$pub" "$name")"
  waiting="$(pg_not_ready "$id" "$(pg_other "$pub")" "$name")"
  if [[ "$lag" == 0 && "$waiting" == 0 ]]; then
    atk_done "$id" in-sync "$name: every table ready, lag 0 bytes" inSync=true lagBytes=0 direction="$([[ $pub == src ]] && echo forward || echo reverse)"
  fi
  atk_done "$id" replicating "$name: $waiting table(s) copying, lag $\{lag:-?} bytes" inSync=false lagBytes="$\{lag:-0}" tablesCopying="$waiting"
}
# pg_reverse ID: at cutover, the target publishes and the source subscribes (copy_data = false), so a rollback keeps the target's writes.
pg_reverse() {
  local id="$1" name
  name="$(pg_rev "$id")"
  if ! db_on "$id" reverse; then atk_log "$(db_label "$id"): reverse replication is off (ATK_DB_$\{DB_TOK[$id]}_REVERSE=0)"; return 0; fi
  pg_need_logical "$id" tgt
  pg_repl_role "$id" tgt
  pg_publish "$id" tgt "$name"
  pg_subscribe "$id" src "$name" false
}
# pg_reverse_rollback ID: wait for the reverse lag to be 0, carry the sequences back, detach the source.
pg_reverse_rollback() {
  local id="$1" name
  name="$(pg_rev "$id")"
  atk_wait_until 30 10 pg_in_sync "$id" tgt "$name" || atk_fail "$id" "the reverse replication $name did not catch up; the source is not switched back"
  pg_sync_sequences "$id" tgt src
  pg_sub_disable "$id" src "$name"
}
pg_teardown() {
  local id="$1"
  pg_drop_sub "$id" tgt "$(pg_fwd "$id")"
  pg_drop_sub "$id" src "$(pg_rev "$id")"
  pg_drop_pub "$id" src "$(pg_fwd "$id")"
  pg_drop_pub "$id" tgt "$(pg_rev "$id")"
  pg_drop_role "$id" src
  pg_drop_role "$id" tgt
}
`;

// ---------------------------------------------------------------------------
// MySQL / MariaDB helpers
// ---------------------------------------------------------------------------

/**
 * The RDS for MySQL replication procedures by the target's version: `_source`
 * from 8.4, `_master` on 8.0 and before (and on RDS for MariaDB).
 * https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/mysql-stored-proc-replicating.html
 */
export function rdsMysqlWord(targetVersion        )                      {
  const m = /(\d+)\.(\d+)/.exec(targetVersion);
  if (!m) return 'master';
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 8 || (major === 8 && minor >= 4) ? 'source' : 'master';
}
export function rdsMysqlProcs(targetVersion        )                                                                                                  {
  const w = rdsMysqlWord(targetVersion);
  return {
    set: `mysql.rds_set_external_${w}_with_auto_position`,
    reset: `mysql.rds_reset_external_${w}`,
    start: 'mysql.rds_start_replication',
    stop: 'mysql.rds_stop_replication',
  };
}

/** How the target takes binlog replication: a VM, Amazon RDS, Aurora, Azure, HeatWave or none. */
                                                                                                 
export function myTargetKind(service                         )               {
  if (isIaasTarget(service)) return 'vm';
  switch (service) {
    case 'aws-rds': return 'rds';
    case 'aws-aurora': return 'aurora';
    case 'azure-mysql-flex': return 'azure';
    case 'oci-mysql-heatwave': return 'heatwave';
    case 'google-cloudsql': return 'cloudsql';
    default: return 'other';
  }
}
/** Whether the kit sets up reverse replication (target to source) for this engine and target. */
export function myReverseSupported(engine                      , kind              )          {
  if (engine === 'mariadb') return kind === 'vm' || kind === 'rds';
  return kind === 'vm' || kind === 'rds' || kind === 'aurora' || kind === 'azure';
}

/**
 * MySQL and MariaDB: reads (`my_q`), changes (`my_x`), replica status, the
 * replication user and the replication in either direction by target kind.
 * The password reaches the client through `--defaults-extra-file` on an
 * unnamed pipe (process substitution), and mysqlsh through
 * `--passwords-from-stdin`.
 */
export const MY_SH = code`
# ---------------------------------------------------------------- MySQL / MariaDB

# my_cnf PASSWORD: a client option file, written only to a pipe.
my_cnf() { local p="$\{1//\\/\\\\}"; p="$\{p//\"/\\\"}"; printf '[client]\npassword="%s"\n' "$p"; }
_my_conn() {
  local id="$1" side="$2" role
  case "$side" in src) role=SRC ;; tgt) role=TGT ;; *) atk_die 1 "mysql: unknown side $side" ;; esac
  _MY_HOST="$(db_need "$id" "$\{side}_host")"
  _MY_PORT="$(db_need "$id" "$\{side}_port")"
  _MY_USER="$(db_need "$id" "$\{side}_user")"
  _MY_ARGS=(--host="$_MY_HOST" --port="$_MY_PORT" --user="$_MY_USER" --connect-timeout=15 --ssl-mode="$(db_get "$id" my_ssl_mode)")
  db_secret_to _MY_PW "$role" "$id"
}
# my_q ID SIDE SQL: a read (batch, no column names).
my_q() {
  _my_conn "$1" "$2"
  printf '%s\n' "$3" | mysql --defaults-extra-file=<(my_cnf "$_MY_PW") "$\{_MY_ARGS[@]}" -N -B \
    || atk_die 1 "$(db_label "$1"): cannot read the $(db_side "$2")"
}
# my_qv ID SIDE SQL: a read, vertical (for SHOW REPLICA STATUS).
my_qv() {
  _my_conn "$1" "$2"
  printf '%s\n' "$3" | mysql --defaults-extra-file=<(my_cnf "$_MY_PW") "$\{_MY_ARGS[@]}" -E \
    || atk_die 1 "$(db_label "$1"): cannot read the $(db_side "$2")"
}
# my_x ID SIDE WHAT SQL: a change (printed, not run, with --dry-run); the SQL is not logged.
my_x() {
  _my_conn "$1" "$2"
  atk_log "$(db_label "$1"): $3 (on the $(db_side "$2"))"
  db_sql_guard "$1" "$4"
  DB_CHANGED=1
  printf '%s\n' "$4" | atk_run mysql --defaults-extra-file=<(my_cnf "$_MY_PW") "$\{_MY_ARGS[@]}" -N -B \
    || atk_die 1 "$(db_label "$1"): $3 failed on the $(db_side "$2")"
}
my_lit() { local s="$\{1//\\/\\\\}"; s="$\{s//\'/\'\'}"; printf "'%s'" "$s"; }
my_version() { my_q "$1" "$2" "SELECT VERSION()"; }
my_is_maria() { local v; db_read v my_version "$1" "$2"; [[ "$v" == *MariaDB* ]]; }
# my_ge ID SIDE X.Y.Z: the server is at least that version (MariaDB counts as 8.0.22 for the REPLICA spellings).
my_ge() {
  local v
  db_read v my_version "$1" "$2"
  if [[ "$v" == *MariaDB* ]]; then v=8.0.22; fi
  v="$\{v%%-*}"
  [[ "$(printf '%s\n%s\n' "$3" "$v" | sort -V | head -n 1)" == "$3" ]]
}
# my_replica_field ID SIDE FIELD...: the first of the fields SHOW REPLICA STATUS reports ("" when not a replica).
my_replica_field() {
  local id="$1" side="$2" out f
  shift 2
  if my_ge "$id" "$side" 8.0.22; then out="$(my_qv "$id" "$side" "SHOW REPLICA STATUS")" || return 1; else out="$(my_qv "$id" "$side" "SHOW SLAVE STATUS")" || return 1; fi
  for f in "$@"; do
    awk -F': ' -v f="$f" '{ k = $1; gsub(/^ +/, "", k) } k == f { print $2; found = 1; exit } END { exit !found }' <<< "$out" && return 0
  done
  return 0
}
my_is_replica_of() { local out; db_read out my_replica_field "$1" "$2" Source_Host Master_Host; [[ -n "$out" ]]; }
my_lag() { my_replica_field "$1" "$2" Seconds_Behind_Source Seconds_Behind_Master; }
my_io() { my_replica_field "$1" "$2" Replica_IO_Running Slave_IO_Running; }
my_sql_err() { my_replica_field "$1" "$2" Last_SQL_Error Last_Error; }
my_in_sync() {
  local lag io
  lag="$(my_lag "$1" "$2")"
  io="$(my_io "$1" "$2")"
  [[ "$io" == Yes ]] && db_lag_ok "$lag"
}
# my_kind ID: vm, rds, aurora, azure, heatwave, cloudsql or other.
my_kind() { db_get "$1" my_kind; }
# my_gtid_pos ID: the MariaDB GTID position the initial load recorded (ATK_DB_<TOKEN>_GTID_POS overrides it).
my_gtid_pos() {
  local v
  v="$(db_get "$1" gtid_pos)"
  [[ -n "$v" ]] || v="$(atk_ids_get "$(db_get "$1" path)" "$1.gtid" 2>/dev/null || true)"
  [[ -n "$v" ]] || atk_die 5 "$(db_label "$1"): no GTID position is recorded for the initial load; run prepare (or set ATK_DB_$\{DB_TOK[$1]}_GTID_POS)"
  printf '%s' "$v"
}
# my_rds_word ID: source (8.4 and later) or master, from the target's version when it answers, else the planned version.
my_rds_word() {
  local v
  v="$(my_version "$1" tgt 2>/dev/null || true)"
  [[ -n "$v" ]] || v="$(db_get "$1" target_version)"
  if [[ "$v" == *MariaDB* ]]; then printf master; return 0; fi
  if [[ "$v" =~ ^([0-9]+)\.([0-9]+) ]] && (( BASH_REMATCH[1] > 8 || (BASH_REMATCH[1] == 8 && BASH_REMATCH[2] >= 4) )); then printf source; else printf master; fi
}
# my_repl_user ID SIDE: the replication user (REQUIRE SSL), created once.
my_repl_user() {
  local id="$1" side="$2" user pw
  user="$(db_need "$id" repl_user)"
  local n
  db_read n my_q "$id" "$side" "SELECT COUNT(*) FROM mysql.user WHERE user = $(my_lit "$user")"
  if [[ "$n" != 0 ]]; then
    atk_log "$(db_label "$id"): replication user $user already on the $(db_side "$side")"
    return 0
  fi
  db_secret_to pw REPL "$id"
  my_x "$id" "$side" "create the replication user $user" \
    "CREATE USER $(my_lit "$user")@'%' IDENTIFIED BY $(my_lit "$pw") REQUIRE SSL; GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO $(my_lit "$user")@'%';"
}
my_drop_user() {
  local id="$1" side="$2" user
  user="$(db_need "$id" repl_user)"
  local n
  db_read n my_q "$id" "$side" "SELECT COUNT(*) FROM mysql.user WHERE user = $(my_lit "$user")"
  [[ "$n" != 0 ]] || return 0
  my_x "$id" "$side" "drop the replication user $user" "DROP USER IF EXISTS $(my_lit "$user")@'%';"
}
# my_need_binlog ID SIDE: exit 5 unless binary logging with ROW format (and GTIDs on MySQL) is on.
my_need_binlog() {
  local id="$1" side="$2" nogtid="$\{3:-}" row
  row="$(my_q "$id" "$side" "SELECT @@log_bin, @@binlog_format")"
  [[ "$row" == $'1\tROW' ]] || atk_die 5 "$(db_label "$id"): binary logging must be on with binlog_format ROW on the $(db_side "$side") (it reports: $\{row//$'\t'/, })"
  if [[ -z "$nogtid" ]] && ! my_is_maria "$id" "$side"; then
    [[ "$(my_q "$id" "$side" "SELECT @@gtid_mode")" == ON ]] || atk_die 5 "$(db_label "$id"): gtid_mode must be ON (with enforce_gtid_consistency) on the $(db_side "$side")"
  fi
}
# my_source_sql ID REPLICA: the SQL that points REPLICA at the other side and starts it (the password is inside: stdin only).
my_source_sql() {
  local id="$1" side="$2" from host port user pw kind word ssl
  from=src; [[ "$side" == src ]] && from=tgt
  host="$(db_get "$id" "$\{from}_host_seen_from_$\{side}")"
  [[ -n "$host" ]] || host="$(db_need "$id" "$\{from}_host")"
  port="$(db_need "$id" "$\{from}_port")"
  user="$(db_need "$id" repl_user)"
  db_secret_to pw REPL "$id"
  kind=vm; [[ "$side" == tgt ]] && kind="$(my_kind "$id")"
  # The reverse replica (the source) ignores the target service's own tables (heartbeats, settings, accounts).
  if [[ "$side" == src ]]; then
    if my_is_maria "$id" src; then printf "SET GLOBAL replicate_wild_ignore_table = 'mysql.%%'; "; else printf "CHANGE REPLICATION FILTER REPLICATE_WILD_IGNORE_TABLE = ('mysql.%%'); "; fi
  fi
  case "$kind" in
    rds|aurora)
      word="$(my_rds_word "$id")"
      if [[ "$(db_get "$id" engine)" == mariadb ]]; then
        printf "CALL mysql.rds_set_external_master_gtid(%s, %s, %s, %s, %s, 1); CALL mysql.rds_start_replication;" \
          "$(my_lit "$host")" "$port" "$(my_lit "$user")" "$(my_lit "$pw")" "$(my_lit "$(my_gtid_pos "$id")")"
      else
        printf "CALL mysql.rds_set_external_%s_with_auto_position(%s, %s, %s, %s, 1, 0); CALL mysql.rds_start_replication;" \
          "$word" "$(my_lit "$host")" "$port" "$(my_lit "$user")" "$(my_lit "$pw")"
      fi ;;
    azure)
      ssl=""
      if [[ -n "$(db_get "$id" src_ssl_ca_file)" ]]; then ssl="$(< "$(db_get "$id" src_ssl_ca_file)")"; fi
      printf "CALL mysql.az_replication_change_master_with_gtid(%s, %s, %s, %s, %s); CALL mysql.az_replication_start;" \
        "$(my_lit "$host")" "$(my_lit "$user")" "$(my_lit "$pw")" "$port" "$(my_lit "$ssl")" ;;
    vm)
      # _MY_FROM_FILE / _MY_FROM_POS (set by my_reverse after a tool's copy): replicate from a binlog position, not by GTID.
      local at
      if my_is_maria "$id" "$side"; then
        if [[ -n "$\{_MY_FROM_FILE:-}" ]]; then
          at="MASTER_LOG_FILE = $(my_lit "$_MY_FROM_FILE"), MASTER_LOG_POS = $_MY_FROM_POS"
        elif [[ "$side" == tgt ]]; then
          printf "SET GLOBAL gtid_slave_pos = %s; " "$(my_lit "$(my_gtid_pos "$id")")"
          at="MASTER_USE_GTID = slave_pos"
        else
          at="MASTER_USE_GTID = current_pos"
        fi
        printf "CHANGE MASTER TO MASTER_HOST = %s, MASTER_PORT = %s, MASTER_USER = %s, MASTER_PASSWORD = %s, %s, MASTER_SSL = 1; START SLAVE;" \
          "$(my_lit "$host")" "$port" "$(my_lit "$user")" "$(my_lit "$pw")" "$at"
      elif my_ge "$id" "$side" 8.0.23; then
        at="SOURCE_AUTO_POSITION = 1"
        if [[ -n "$\{_MY_FROM_FILE:-}" ]]; then at="SOURCE_LOG_FILE = $(my_lit "$_MY_FROM_FILE"), SOURCE_LOG_POS = $_MY_FROM_POS"; fi
        printf "CHANGE REPLICATION SOURCE TO SOURCE_HOST = %s, SOURCE_PORT = %s, SOURCE_USER = %s, SOURCE_PASSWORD = %s, %s, SOURCE_SSL = 1; START REPLICA;" \
          "$(my_lit "$host")" "$port" "$(my_lit "$user")" "$(my_lit "$pw")" "$at"
      else
        at="MASTER_AUTO_POSITION = 1"
        if [[ -n "$\{_MY_FROM_FILE:-}" ]]; then at="MASTER_LOG_FILE = $(my_lit "$_MY_FROM_FILE"), MASTER_LOG_POS = $_MY_FROM_POS"; fi
        printf "CHANGE MASTER TO MASTER_HOST = %s, MASTER_PORT = %s, MASTER_USER = %s, MASTER_PASSWORD = %s, %s, MASTER_SSL = 1; START SLAVE;" \
          "$(my_lit "$host")" "$port" "$(my_lit "$user")" "$(my_lit "$pw")" "$at"
      fi ;;
    *) atk_die 5 "$(db_label "$id"): the kit cannot point a $kind target at a replication source; use the provider's service or the dump path" ;;
  esac
}
# my_stop_sql ID SIDE: the SQL that stops replication on SIDE.
my_stop_sql() {
  local kind=vm
  [[ "$2" == tgt ]] && kind="$(my_kind "$1")"
  case "$kind" in
    rds|aurora) printf 'CALL mysql.rds_stop_replication;' ;;
    azure) printf 'CALL mysql.az_replication_stop;' ;;
    *) if my_ge "$1" "$2" 8.0.22; then printf 'STOP REPLICA;'; else printf 'STOP SLAVE;'; fi ;;
  esac
}
# my_reset_sql ID SIDE: the SQL that removes the replication configuration on SIDE.
my_reset_sql() {
  local kind=vm
  [[ "$2" == tgt ]] && kind="$(my_kind "$1")"
  case "$kind" in
    rds|aurora) printf 'CALL mysql.rds_stop_replication; CALL mysql.rds_reset_external_%s;' "$(my_rds_word "$1")" ;;
    azure) printf 'CALL mysql.az_replication_stop; CALL mysql.az_replication_remove_master;' ;;
    *) if my_ge "$1" "$2" 8.0.22; then printf 'STOP REPLICA; RESET REPLICA ALL;'; else printf 'STOP SLAVE; RESET SLAVE ALL;'; fi ;;
  esac
  if [[ "$2" == src ]]; then
    if my_is_maria "$1" src; then printf '%s' " SET GLOBAL replicate_wild_ignore_table = '';"; else printf ' CHANGE REPLICATION FILTER REPLICATE_WILD_IGNORE_TABLE = ();'; fi
  fi
}
my_read_only_sql() {
  local on="$3"
  if my_is_maria "$1" "$2"; then printf 'SET GLOBAL read_only = %s;' "$on"; elif [[ "$on" == ON ]]; then printf 'SET GLOBAL super_read_only = ON;'; else printf 'SET GLOBAL super_read_only = OFF; SET GLOBAL read_only = OFF;'; fi
}
my_status() {
  local id="$1" side=tgt dir=forward lag io err
  if my_is_replica_of "$id" src; then side=src; dir=reverse; fi
  if ! my_is_replica_of "$id" "$side"; then atk_done "$id" planned "no replication yet" inSync=false; fi
  lag="$(my_lag "$id" "$side")"
  io="$(my_io "$id" "$side")"
  err="$(my_sql_err "$id" "$side")"
  if [[ -n "$err" ]]; then atk_fail "$id" "$dir replication stopped: $err"; fi
  if [[ "$io" == Yes ]] && db_lag_ok "$lag"; then atk_done "$id" in-sync "$dir replication, $\{lag}s behind" inSync=true lagSeconds="$lag" direction="$dir"; fi
  atk_done "$id" replicating "$dir replication: I/O $\{io:-?}, $\{lag:-?}s behind" inSync=false lagSeconds="$\{lag:-0}" direction="$dir"
}
# my_reverse ID: at cutover, the source replicates from the target (where the service exposes binlogs) and is made read-only.
# my_reverse ID [pos]: pos after a migration tool's copy, whose own writes on the target the source must not replay:
# the source then replicates from the target's binlog position at cutover instead of by GTID.
my_reverse() {
  local id="$1" mode="$\{2:-gtid}" status
  if ! db_on "$id" reverse; then atk_log "$(db_label "$id"): reverse replication is off"; return 0; fi
  if [[ "$(db_get "$id" reverse_supported)" != 1 ]]; then atk_log "$(db_label "$id"): no reverse replication from a $(my_kind "$id") target (exec.db.no-reverse)"; return 0; fi
  if my_is_replica_of "$id" src; then atk_log "$(db_label "$id"): the source already replicates from the target"; return 0; fi
  if [[ "$mode" == pos ]]; then my_need_binlog "$id" tgt nogtid; else my_need_binlog "$id" tgt; fi
  if [[ "$(my_kind "$id")" == rds || "$(my_kind "$id")" == aurora ]]; then
    my_x "$id" tgt "keep the binlogs 24 hours for the reverse replication" "CALL mysql.rds_set_configuration('binlog retention hours', 24);"
  fi
  my_repl_user "$id" tgt
  if [[ "$mode" == pos ]]; then
    if ! my_is_maria "$id" tgt && my_ge "$id" tgt 8.2.0; then status="SHOW BINARY LOG STATUS"; else status="SHOW MASTER STATUS"; fi
    IFS=$'\t' read -r _MY_FROM_FILE _MY_FROM_POS _ < <(my_q "$id" tgt "$status" | head -n 1) || true
    [[ -n "$\{_MY_FROM_FILE:-}" && "$\{_MY_FROM_POS:-}" =~ ^[0-9]+$ ]] || atk_die 5 "$(db_label "$id"): the target reports no binlog position; binary logging must be on for the reverse replication"
    atk_log "$(db_label "$id"): the reverse replication starts at the target's $_MY_FROM_FILE:$_MY_FROM_POS"
  fi
  my_x "$id" src "make the source read-only" "$(my_read_only_sql "$id" src ON)"
  my_x "$id" src "point the source at the target (reverse replication)" "$(my_source_sql "$id" src)"
}
my_reverse_rollback() {
  local id="$1"
  atk_wait_until 30 10 my_in_sync "$id" src || atk_fail "$id" "the reverse replication did not catch up; the source is not switched back"
  my_x "$id" src "stop the reverse replication" "$(my_reset_sql "$id" src)"
  my_x "$id" src "make the source writable" "$(my_read_only_sql "$id" src OFF)"
}
my_teardown() {
  local id="$1"
  if my_is_replica_of "$id" tgt; then my_x "$id" tgt "remove the forward replication" "$(my_reset_sql "$id" tgt)"; fi
  if my_is_replica_of "$id" src; then
    my_x "$id" src "remove the reverse replication" "$(my_reset_sql "$id" src)"
    my_x "$id" src "make the source writable" "$(my_read_only_sql "$id" src OFF)"
  fi
  my_drop_user "$id" src
  my_drop_user "$id" tgt
}
`;

// ---------------------------------------------------------------------------
// Oracle helpers (SQL*Plus on the controller)
// ---------------------------------------------------------------------------

/**
 * Oracle over SQL*Net from the controller: reads (`ora_q`) and changes
 * (`ora_x`) through `sqlplus -S -L /nolog`, with the CONNECT (and its
 * password) on stdin; the database link to the source; Data Pump over that
 * link (DBMS_DATAPUMP, which also works on Amazon RDS and Autonomous
 * Database, where there is no OS access); and the sequences.
 */
export const ORA_SH = code`
# ---------------------------------------------------------------- Oracle

# ora_ez ID SIDE: the EZConnect string //host:port/service (an IPv6 literal in brackets).
ora_ez() { printf '//%s:%s/%s' "$(db_host_url "$(db_need "$1" "$2_host")")" "$(db_need "$1" "$2_port")" "$(db_need "$1" "$2_service")"; }
# _ora_script ID SIDE BODY: the SQL*Plus input: settings, the connection, the body, exit.
_ora_script() {
  local id="$1" side="$2" role pw
  case "$side" in src) role=SRC ;; tgt) role=TGT ;; *) atk_die 1 "oracle: unknown side $side" ;; esac
  db_secret_to pw "$role" "$id"
  printf 'WHENEVER OSERROR EXIT FAILURE\nWHENEVER SQLERROR EXIT FAILURE\nSET HEADING OFF FEEDBACK OFF PAGESIZE 0 LINESIZE 32767 TRIMSPOOL ON TRIMOUT ON VERIFY OFF ECHO OFF DEFINE OFF SERVEROUTPUT ON\n'
  printf 'CONNECT "%s"/"%s"@%s\n' "$(db_need "$id" "$\{side}_user")" "$pw" "$(ora_ez "$id" "$side")"
  printf '%s\n' "$3"
  printf 'EXIT\n'
}
# ora_q ID SIDE SQL: a read (no headings, one row per line).
ora_q() { { _ora_script "$1" "$2" "$3" | sqlplus -S -L /nolog | sed '/^[[:space:]]*$/d'; } || atk_die 1 "$(db_label "$1"): cannot read the $(db_side "$2")"; }
# ora_x ID SIDE WHAT SQL: a change (printed, not run, with --dry-run); the SQL is not logged.
ora_x() {
  atk_log "$(db_label "$1"): $3 (on the $(db_side "$2"))"
  db_sql_guard "$1" "$4"
  DB_CHANGED=1
  _ora_script "$1" "$2" "$4" | atk_run sqlplus -S -L /nolog || atk_die 1 "$(db_label "$1"): $3 failed on the $(db_side "$2")"
}
ora_lit() { local s="$\{1//\'/\'\'}"; printf "'%s'" "$s"; }
# ora_link ID: the database link ATK_SRC on the target, to the source (Autonomous Database: created from the runbook).
ora_link() {
  local id="$1" pw
  local n
  db_read n ora_q "$id" tgt "SELECT COUNT(*) FROM user_db_links WHERE db_link LIKE 'ATK_SRC%';"
  if [[ "$n" != 0 ]]; then return 0; fi
  if [[ "$(db_get "$id" service)" == *adb ]]; then
    atk_die 5 "$(db_label "$id"): create the database link ATK_SRC on Autonomous Database with DBMS_CLOUD_ADMIN.CREATE_DATABASE_LINK (runbook), then run this again"
  fi
  db_secret_to pw SRC "$id"
  ora_x "$id" tgt "create the database link ATK_SRC to the source" \
    "CREATE DATABASE LINK ATK_SRC CONNECT TO \"$(db_need "$id" src_user)\" IDENTIFIED BY \"$pw\" USING $(ora_lit "$(ora_ez "$id" src)");"
}
ora_drop_link() {
  local id="$1"
  local n
  db_read n ora_q "$id" tgt "SELECT COUNT(*) FROM user_db_links WHERE db_link LIKE 'ATK_SRC%';"
  [[ "$n" != 0 ]] || return 0
  ora_x "$id" tgt "drop the database link ATK_SRC" "DROP DATABASE LINK ATK_SRC;"
}
# ora_schemas ID: the schemas to move, quoted for IN (...): the setting, else every schema the source does not maintain itself.
ora_schemas() {
  local id="$1" list s out="" sep=""
  list="$(db_get "$id" schemas)"
  if [[ -z "$list" ]]; then
    list="$(ora_q "$id" tgt "SELECT LISTAGG(username, ',') WITHIN GROUP (ORDER BY username) FROM dba_users@ATK_SRC WHERE oracle_maintained = 'N';")"
  fi
  [[ -n "$list" ]] || atk_die 5 "$(db_label "$id"): no schemas to move; set ATK_DB_$\{DB_TOK[$id]}_SCHEMAS (a comma list)"
  IFS=, read -r -a arr <<< "$list"
  for s in "$\{arr[@]}"; do s="$\{s// /}"; [[ -n "$s" ]] || continue; out+="$sep$(ora_lit "$\{s^^}")"; sep=", "; done
  printf '%s' "$out"
}
ora_scn() { ora_q "$1" tgt "SELECT TO_CHAR(current_scn) FROM v\$database@ATK_SRC;"; }
# ora_import ID SCN ROWS(1|0): a Data Pump schema import over ATK_SRC as of SCN, waited for; ROWS=0 copies the metadata only.
ora_import() {
  local id="$1" scn="$2" rows="$3" job schemas filter=""
  job="ATK_IMP_$(printf '%s' "$(atk_name "$id")$rows" | cksum | awk '{ print $1 }')"
  schemas="$(ora_schemas "$id")"
  if [[ "$rows" == 0 ]]; then filter="DBMS_DATAPUMP.DATA_FILTER(h, 'INCLUDE_ROWS', 0);"; fi
  ora_x "$id" tgt "Data Pump import over ATK_SRC as of SCN $scn ($([[ $rows == 0 ]] && echo 'metadata only' || echo 'schemas and rows'))" "DECLARE
  h NUMBER;
  st VARCHAR2(30);
BEGIN
  h := DBMS_DATAPUMP.OPEN(operation => 'IMPORT', job_mode => 'SCHEMA', remote_link => 'ATK_SRC', job_name => '$job');
  DBMS_DATAPUMP.ADD_FILE(h, '$job.log', 'DATA_PUMP_DIR', filetype => DBMS_DATAPUMP.KU\$_FILE_TYPE_LOG_FILE, reusefile => 1);
  DBMS_DATAPUMP.METADATA_FILTER(h, 'SCHEMA_EXPR', 'IN (' || q'[$schemas]' || ')');
  DBMS_DATAPUMP.SET_PARAMETER(h, 'FLASHBACK_SCN', $scn);
  DBMS_DATAPUMP.SET_PARAMETER(h, 'TABLE_EXISTS_ACTION', 'REPLACE');
  $filter
  DBMS_DATAPUMP.SET_PARALLEL(h, $(db_get "$id" parallel));
  DBMS_DATAPUMP.START_JOB(h);
  DBMS_DATAPUMP.WAIT_FOR_JOB(h, st);
  IF st <> 'COMPLETED' THEN RAISE_APPLICATION_ERROR(-20001, 'Data Pump job $job ended ' || st); END IF;
END;
/"
}
# ora_sync_sequences ID: every sequence of the moved schemas restarted on the target at the source's next value.
ora_sync_sequences() {
  local id="$1" sql
  sql="$(ora_q "$id" tgt "SELECT 'ALTER SEQUENCE \"' || sequence_owner || '\".\"' || sequence_name || '\" RESTART START WITH ' || TO_CHAR(last_number) || ';' FROM dba_sequences@ATK_SRC WHERE sequence_owner IN ($(ora_schemas "$id")) ORDER BY 1;")"
  if [[ -z "$sql" ]]; then atk_log "$(db_label "$id"): no sequences to carry"; return 0; fi
  ora_x "$id" tgt "restart $(printf '%s\n' "$sql" | wc -l | tr -d ' ') sequence(s) at the source's values" "$sql"
}
`;

// ---------------------------------------------------------------------------
// PowerShell: the settings and the helpers the SQL Server scripts share
// ---------------------------------------------------------------------------

export function psSettings(rows        , ctx             )         {
  const ids = [...rows.rows.keys()].sort();
  const entries = ids.map((id) => {
    const r = rows.rows.get(id) ;
    const kv = Object.keys(r).sort().map((k) => `    ${k} = ${psq(r[k] )}`).join('\n');
    return `  ${psq(id)} = @{\n${kv}\n  }`;
  });
  return [
    '# The settings of each database (none of them secret). Override any at run time with $env:ATK_DB_<TOKEN>_<KEY>.',
    `$script:DbConf = @{\n${entries.join('\n')}\n}`,
    `$script:DbLagMax = if ($env:ATK_DB_LAG_MAX) { [int] $env:ATK_DB_LAG_MAX } else { ${ctx.settings.lagSeconds.db} }`,
  ].join('\n');
}

export const DB_PS_BASE = code`
$script:DbConn = @{}
function Get-DbConf {
  param([Parameter(Mandatory)] [string] $Id, [Parameter(Mandatory)] [string] $Key)
  $row = $script:DbConf[$Id]
  if (-not $row) { Stop-Atk 1 "no settings for $Id" }
  $v = [Environment]::GetEnvironmentVariable("ATK_DB_$($row.envtok)_$($Key.ToUpperInvariant())")
  if ($v) { return $v }
  if ($row.ContainsKey($Key)) { return [string] $row[$Key] }
  return ''
}
function Get-DbNeed {
  param([Parameter(Mandatory)] [string] $Id, [Parameter(Mandatory)] [string] $Key)
  $v = Get-DbConf -Id $Id -Key $Key
  if (-not $v) { Stop-Atk 5 "$($script:DbConf[$Id].name): set ATK_DB_$($script:DbConf[$Id].envtok)_$($Key.ToUpperInvariant()) (see paths/db/README-*.md)" }
  return $v
}
function Test-DbOn {
  param([string] $Id, [string] $Key)
  return (Get-DbConf -Id $Id -Key $Key) -notin @('0', 'false', 'no', 'off')
}
# Get-DbCredential: an in-memory PSCredential from ROLE_DB_PASSWORD_<TOKEN>; never written, never an argument.
function Get-DbCredential {
  param([Parameter(Mandatory)] [string] $Id, [Parameter(Mandatory)] [ValidateSet('SRC', 'TGT', 'REPL')] [string] $Role, [string] $User = '')
  if (-not $User) { $User = Get-DbNeed -Id $Id -Key "$($Role.ToLowerInvariant())_user" }
  $plain = Get-AtkSecret -Name "$($Role)_DB_PASSWORD_$($script:DbConf[$Id].envtok)"
  return [pscredential]::new($User, (ConvertTo-SecureString -String $plain -AsPlainText -Force))
}
# Get-DbInstance: host,port for SqlClient (an IPv6 literal in brackets).
function Get-DbInstance {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $Side)
  $h = Get-DbNeed -Id $Id -Key "$($Side)_host"
  if ($h.Contains(':') -and -not $h.StartsWith('[')) { $h = "[$h]" }
  $p = Get-DbConf -Id $Id -Key "$($Side)_port"
  if ($p) { return "$h,$p" } else { return $h }
}
# Connect-DbSide: an SMO connection (dbatools); reads use its .Query() method, changes go through Invoke-DbSql.
function Connect-DbSide {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $Side)
  $key = "$Id|$Side"
  if ($script:DbConn.ContainsKey($key)) { return $script:DbConn[$key] }
  $trust = Test-DbOn -Id $Id -Key 'trust_server_certificate'
  $c = Connect-DbaInstance -SqlInstance (Get-DbInstance -Id $Id -Side $Side) -SqlCredential (Get-DbCredential -Id $Id -Role $Side.ToUpperInvariant()) -TrustServerCertificate:$trust -EncryptConnection -EnableException
  $script:DbConn[$key] = $c
  return $c
}
function Read-DbSql {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $Side, [string] $Sql, [string] $Database = 'master')
  $s = Connect-DbSide -Id $Id -Side $Side
  return $s.Query($Sql, $Database)
}
# Invoke-DbSql: a change (logged, not run, with -DryRun). The description is logged, the SQL is not (it may hold a secret).
function Invoke-DbSql {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $Side, [string] $What, [string] $Sql, [string] $Database = 'master')
  $s = Connect-DbSide -Id $Id -Side $Side
  Invoke-AtkStep "$($script:DbConf[$Id].name): $What (on the $(if ($Side -eq 'src') { 'source' } else { 'target' }))" {
    Invoke-DbaQuery -SqlInstance $s -Database $Database -Query $Sql -QueryTimeout 0 -EnableException | Out-Null
  }
}
function ConvertTo-DbIdent { param([string] $Name) return '[' + $Name.Replace(']', ']]') + ']' }
function ConvertTo-DbLit { param([string] $Text) return "N'" + $Text.Replace("'", "''") + "'" }
# Connect-DbAzure: the controller's managed identity, or a service principal with a federated token.
function Connect-DbAzure {
  $sub = $env:ATK_AZURE_SUBSCRIPTION_ID
  $ctx = Get-AzContext -ErrorAction SilentlyContinue
  if ($ctx -and (-not $sub -or $ctx.Subscription.Id -eq $sub)) { return }
  $extra = @{}
  if ($sub) { $extra.Subscription = $sub }
  if ($env:AZURE_FEDERATED_TOKEN_FILE) {
    $null = Connect-AzAccount -ServicePrincipal -ApplicationId $env:AZURE_CLIENT_ID -TenantId $env:AZURE_TENANT_ID -FederatedToken ([System.IO.File]::ReadAllText($env:AZURE_FEDERATED_TOKEN_FILE).Trim()) @extra
  } else {
    $null = Connect-AzAccount -Identity @extra
  }
}
function Skip-DbTest { Set-AtkOutcome skipped "a database is tested with its application (the server path's test); this path opens no test copy" }
`;

// ---------------------------------------------------------------------------
// The README each module writes, and the findings
// ---------------------------------------------------------------------------

                             
                              
                          
                                          
                                      
                                     
 

/** `paths/db/README-<module>.md`: per database, its script, the settings and the credential names (never a value). */
export function dbReadme(title        , intro        , entries                       , rows        )         {
  const out           = [`# ${title}`, '', intro, '', 'Every script applies by default; `--dry-run` prints each change instead. Settings are read from `ATK_DB_<TOKEN>_<KEY>` first, then from the values generated into the script. Credentials come from the environment, a mode-600 `NAME_FILE` or `ATK_VAULT_CMD` (see ../../README.md), and reach the database tools only through the environment or stdin.', ''];
  for (const e of [...entries].sort((a, b) => a.item.name.localeCompare(b.item.name))) {
    const r = rows.rows.get(e.item.id) ?? {};
    const tok = rows.tokens.get(e.item.id) ?? envToken(e.item.name);
    out.push(`## ${e.item.name} (${pathLabel(e.item.path)})`, '');
    out.push(`- Script: \`${e.script} <verb> --item ${e.item.name}\``);
    out.push(`- Target: ${e.item.target.service ? DB_SERVICE_LABELS[e.item.target.service] : 'unknown'}${e.item.target.region ? ` in ${e.item.target.region}` : ''}`);
    out.push(`- Credentials: ${e.secrets.map((s) => `\`${s.replace('<TOKEN>', tok)}\``).join(', ') || 'none (the tool uses its own credential chain)'}`);
    for (const n of e.notes ?? []) out.push(`- ${n}`);
    out.push('', '| Variable | Generated value | What it is |', '|---|---|---|');
    for (const s of e.settings) {
      const v = r[s.key] ?? '';
      out.push(`| \`ATK_DB_${tok}_${s.key.toUpperCase()}\` | ${v ? `\`${v}\`` : s.required ? '**required**' : '(empty)'} | ${s.help} |`);
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The finding every path whose replication user's password ends up in the target's catalog carries (A.6.9). */
export function replicationCredentialFinding(item              )          {
  return info('exec.db.replication-credential', `${item.name}: the replication connection (with the dedicated replication user's password) is stored in the subscriber's catalog by the engine itself; the user is dropped at finalize.`, {
    path: item.id,
    remediation: 'Use a dedicated REPL_DB_PASSWORD_<TOKEN> for this move only, and rotate or drop it after finalize (the kit drops the user).',
  });
}
export function noReverseFinding(item              , why        )          {
  return warning('exec.db.no-reverse', `${item.name}: ${pathLabel(item.path)} sets up no reverse replication (${why}), so a rollback after cutover loses the writes made on the target.`, {
    path: item.id,
    remediation: 'Agree the point of no return with the application owner, or choose a path that replicates back.',
  });
}
export function endpointFinding(items                         , rows        , key = 'tgt_host')            {
  const missing = items.filter((i) => !(rows.rows.get(i.id)?.[key]));
  if (!missing.length) return [];
  return [info('exec.db.endpoint-at-run-time', `${missing.length} database(s) (${missing.slice(0, 4).map((i) => i.name).join(', ')}${missing.length > 4 ? ', …' : ''}) take their ${key === 'tgt_host' ? 'target endpoint' : key} at run time: the verbs that need it stop with exit 5 until ATK_DB_<TOKEN>_${key.toUpperCase()} is set.`, {
    remediation: 'Export the endpoint from the Terraform outputs once the target exists (see paths/db/README-*.md for each variable).',
  })];
}

// ---------------------------------------------------------------------------
// Small helpers for the modules
// ---------------------------------------------------------------------------

/** The items on one path. */
export const onPath = (items                         , path            )                 => items.filter((i) => i.path === path);

/** The same body for every verb that does nothing on a database path (test, test-cleanup). */
export const SH_SKIP_TEST = 'db_skip_test "$id"';
export const PS_SKIP_TEST = 'Skip-DbTest';

/** Verb bodies with the shared skips filled in. */
export function withTestSkips                                                               (v   , ps = false)                       {
  const s = ps ? PS_SKIP_TEST : SH_SKIP_TEST;
  return { ...v, test: s, 'test-cleanup': s }                        ;
}

/** A tool need, frozen. */
export const need = (kind                  , name        , why        , extra                    = {})           => Object.freeze({ kind, name, why, ...extra });

/** The script file of a path. */
export const dbScript = (path          , ext               = 'sh')         => `${DB_DIR}/${path}.${ext}`;
