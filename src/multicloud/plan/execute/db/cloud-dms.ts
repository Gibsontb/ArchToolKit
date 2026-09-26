/**
 * WP-11d: the providers' database migration services (addendum A.6.5, A.6.7).
 *
 *   aws-dms   AWS DMS Serverless: endpoint secrets put from the vault (stdin), the target
 *             schema first (native schema-only copy), a replication config per database with
 *             its table mappings (`paths/db/aws-dms/<db>.table-mappings.json`), full load and
 *             CDC (Oracle: a Data Pump full load at an SCN, then CDC from it), validation before
 *             cutover, sequences and identities after it, and reverse replication for
 *             PostgreSQL and MySQL targets.
 *   gcp-dms   Database Migration Service (Google Cloud (GCP)): the job Terraform defines is
 *             verified, started, promoted at cutover; PostgreSQL and MySQL get the same reverse
 *             replication.
 *
 * Endpoints, the replication subnet group and the migration jobs are
 * Terraform's (WP-11c); the scripts find them by the item's resource name
 * (`<resource>-source` / `<resource>-target`, the job `<resource>`), and
 * any of them can be given explicitly with ATK_DB_<TOKEN>_<KEY>.
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import type { DbMovePath } from '../../types.ts';
import type { ExecPath } from '../contract.ts';
import { code, shScript } from '../lib-sh.ts';
import type { ManifestItem } from '../manifest.ts';
import type { PathContext, PathGenerator } from '../registry.ts';
import {
  BASE_SETTINGS, DB_DIR, DB_SH_BASE, dbReadme, dbRows, endpointFinding, MY_SH, myReverseSupported, myTargetKind, need, noReverseFinding,
  onPath, ORA_SH, PG_SH, shSettings, withTestSkips, type DbRows, type DbSetting, type ReadmeItem,
} from './common.ts';

export const CLOUD_DMS_PATHS: readonly DbMovePath[] = Object.freeze(['aws-dms', 'gcp-dms']);

const ENTRY: Readonly<Record<string, string>> = Object.freeze({
  'aws-dms': `${DB_DIR}/aws-dms.sh`,
  'gcp-dms': `${DB_DIR}/gcp-dms.sh`,
});

/** The file an item's AWS DMS table mappings go in (relative to `migration/execute/`). */
export const tableMappingsFile = (item: ManifestItem): string => `${DB_DIR}/aws-dms/${item.resource}.table-mappings.json`;

// ---------------------------------------------------------------------------
// AWS DMS: engines, table mappings, settings
// ---------------------------------------------------------------------------

/** Schemas a selection rule must never include, per engine (the engines' own). */
const SYSTEM_SCHEMAS: Readonly<Record<string, readonly string[]>> = {
  postgres: ['pg_catalog', 'information_schema', 'pg_toast'],
  mysql: ['mysql', 'sys', 'performance_schema', 'information_schema'],
  mariadb: ['mysql', 'sys', 'performance_schema', 'information_schema'],
  sqlserver: ['sys', 'INFORMATION_SCHEMA'],
  oracle: ['SYS', 'SYSTEM', 'OUTLN', 'DBSNMP', 'APPQOSSYS', 'AUDSYS', 'CTXSYS', 'DVSYS', 'DVF', 'GSMADMIN_INTERNAL', 'LBACSYS', 'MDSYS', 'OJVMSYS', 'OLAPSYS', 'ORDDATA', 'ORDSYS', 'WMSYS', 'XDB', 'GGSYS', 'RDSADMIN', 'REMOTE_SCHEDULER_AGENT', 'DBSFWUSER'],
  mongodb: ['admin', 'local', 'config'],
};

/**
 * The table mappings: include every schema (`%`), exclude the engine's
 * own. The plan does not list schemas, so the include is a wildcard;
 * narrow it here before replicate if the database holds schemas that must
 * not move.
 */
export function tableMappings(item: ManifestItem): string {
  const excludes = SYSTEM_SCHEMAS[item.engine ?? ''] ?? [];
  const rules = [
    { 'rule-type': 'selection', 'rule-id': '1', 'rule-name': 'include-all', 'object-locator': { 'schema-name': '%', 'table-name': '%' }, 'rule-action': 'include' },
    ...excludes.map((s, i) => ({ 'rule-type': 'selection', 'rule-id': String(i + 2), 'rule-name': `exclude-${s.toLowerCase()}`, 'object-locator': { 'schema-name': s, 'table-name': '%' }, 'rule-action': 'exclude' })),
  ];
  return `${JSON.stringify({ rules }, null, 2)}\n`;
}

/** How the target's schema is made before the load: a native schema-only copy, or none. */
type SchemaFirst = 'pg' | 'mysql' | 'oracle' | 'none';
function schemaFirst(item: ManifestItem): SchemaFirst {
  switch (item.engine) {
    case 'postgres': return 'pg';
    case 'mysql': case 'mariadb': return 'mysql';
    case 'oracle': return 'oracle';
    default: return 'none';
  }
}

function awsDmsExtra(ctx: PathContext): (i: ManifestItem) => Record<string, string> {
  return (i) => {
    const kind = myTargetKind(i.target.service);
    const engine = i.engine ?? '';
    return {
      src_endpoint_id: `${i.resource}-source`,
      tgt_endpoint_id: `${i.resource}-target`,
      src_endpoint_arn: '',
      tgt_endpoint_arn: '',
      config_id: i.resource,
      max_capacity: String(ctx.settings.dms?.maxCapacityUnits ?? 16),
      multi_az: 'true',
      schema_first: schemaFirst(i),
      prep_mode: 'DO_NOTHING',
      full_load: engine === 'oracle' ? 'datapump' : 'dms',
      validation: engine === 'mongodb' ? 'false' : 'true',
      src_service: engine === 'oracle' ? i.name.toUpperCase() : '',
      tgt_service: engine === 'oracle' ? 'ORCL' : '',
      schemas: '',
      parallel: '4',
      pg_sslmode: 'require',
      pg_repl_sslmode: 'require',
      my_ssl_mode: 'REQUIRED',
      my_kind: kind,
      reverse: engine === 'postgres' || engine === 'mysql' || engine === 'mariadb' ? '1' : '0',
      reverse_supported: (engine === 'mysql' || engine === 'mariadb') && myReverseSupported(i.engine, kind) ? '1' : engine === 'postgres' ? '1' : '0',
      target_version: i.target.engineVersion ?? '',
      tgt_host_seen_from_src: '',
      mssql_trust_cert: '1',
    };
  };
}

const AWS_DMS_SETTINGS: readonly DbSetting[] = [
  { key: 'src_endpoint_id', help: 'the DMS source endpoint identifier (Terraform aws_dms_endpoint)' },
  { key: 'tgt_endpoint_id', help: 'the DMS target endpoint identifier' },
  { key: 'src_endpoint_arn', help: 'the source endpoint ARN, when it is not found by identifier' },
  { key: 'tgt_endpoint_arn', help: 'the target endpoint ARN, when it is not found by identifier' },
  { key: 'config_id', help: 'the DMS Serverless replication config identifier' },
  { key: 'max_capacity', help: 'DMS capacity units at most (Execute › Settings › DMS)' },
  { key: 'multi_az', help: 'true: the replication runs Multi-AZ' },
  { key: 'full_load', help: 'datapump: an Oracle Data Pump full load at an SCN, then DMS CDC from it; dms: DMS full load and CDC' },
  { key: 'schemas', help: 'Oracle: the schemas to move (a comma list); empty: every schema the source does not maintain' },
  { key: 'src_service', help: 'Oracle: the source service name' },
  { key: 'tgt_service', help: 'Oracle: the target service name (RDS: the DB name)' },
  { key: 'reverse', help: '1: reverse replication (target to source) at cutover, PostgreSQL and MySQL' },
  { key: 'tgt_host_seen_from_src', help: 'the target as the source reaches it, when it differs from tgt_host' },
];

// ---------------------------------------------------------------------------
// aws-dms
// ---------------------------------------------------------------------------

const AWS_DMS_FUNCS = code`
DB_WAIT_MINUTES="$\{ATK_DB_WAIT_MINUTES:-480}"
: "$\{ATK_DMS_SUBNET_GROUP:=atk-$ATK_PLAN8-dms}"

dms_mappings() { printf '%s/paths/db/aws-dms/%s.table-mappings.json' "$ATK_HOME" "$(atk_name "$1")"; }
# dms_endpoint ID src|tgt: the endpoint as JSON (by ARN when given, else by identifier); "" when it does not exist.
dms_endpoint() {
  local id="$1" side="$2" arn
  arn="$(db_get "$id" "$\{side}_endpoint_arn")"
  if [[ -n "$arn" ]]; then
    aws dms describe-endpoints --filters "Name=endpoint-arn,Values=$arn" --query 'Endpoints[0]' --output json 2>/dev/null || true
  else
    aws dms describe-endpoints --filters "Name=endpoint-id,Values=$(db_need "$id" "$\{side}_endpoint_id")" --query 'Endpoints[0]' --output json 2>/dev/null || true
  fi
}
dms_endpoint_arn() {
  local ep arn
  ep="$(dms_endpoint "$1" "$2")"
  arn="$(jq -r '.EndpointArn // empty' <<< "$\{ep:-null}")"
  [[ -n "$arn" ]] || atk_die 5 "$(db_label "$1"): no DMS $(db_side "$2") endpoint $(db_get "$1" "$2_endpoint_id"): apply terraform (aws_mig_replication) or set ATK_DB_$\{DB_TOK[$1]}_$\{2^^}_ENDPOINT_ARN"
  printf '%s' "$arn"
}
# dms_put_secret ID SIDE: the endpoint's Secrets Manager value from the vault, sent on stdin; skipped when it is already current.
dms_put_secret() {
  local id="$1" side="$2" role ep secret pw next cur
  role=SRC; [[ "$side" == tgt ]] && role=TGT
  ep="$(dms_endpoint "$id" "$side")"
  secret="$(jq -r '(.PostgreSQLSettings // .MySQLSettings // .OracleSettings // .MicrosoftSQLServerSettings // .DocDbSettings // .MongoDbSettings // {}).SecretsManagerSecretId // empty' <<< "$\{ep:-null}")"
  [[ -n "$secret" ]] || atk_die 5 "$(db_label "$id"): the DMS $(db_side "$side") endpoint names no Secrets Manager secret"
  db_secret_to pw "$role" "$id"
  next="$(ATK_DMS_PW="$pw" jq -cn --arg u "$(db_need "$id" "$\{side}_user")" --arg h "$(db_need "$id" "$\{side}_host")" --arg p "$(db_need "$id" "$\{side}_port")" \
    '{username: $u, password: $ENV.ATK_DMS_PW, host: $h, port: ($p | tonumber)}')"
  cur="$(aws secretsmanager get-secret-value --secret-id "$secret" --query SecretString --output text 2>/dev/null || true)"
  if [[ "$cur" == "$next" ]]; then atk_log "$(db_label "$id"): the $(db_side "$side") endpoint secret is current"; return 0; fi
  atk_log "$(db_label "$id"): put the $(db_side "$side") endpoint secret (from the vault, on stdin)"
  db_changed
  ATK_DMS_SS="$next" jq -n --arg s "$secret" '{SecretId: $s, SecretString: $ENV.ATK_DMS_SS}' | atk_run aws secretsmanager put-secret-value --cli-input-json file:///dev/stdin --query VersionId --output text
}
# dms_config_arn ID: the replication config ARN ("" when it does not exist).
dms_config_arn() {
  aws dms describe-replication-configs --filters "Name=replication-config-id,Values=$(db_need "$1" config_id)" --query 'ReplicationConfigs[0].ReplicationConfigArn' --output text 2>/dev/null | sed 's/^None$//'
}
dms_replication() {
  local arn="$2"
  [[ -n "$arn" ]] || { printf 'null'; return 0; }
  aws dms describe-replications --filters "Name=replication-config-arn,Values=$arn" --query 'Replications[0]' --output json 2>/dev/null || printf 'null'
}
# dms_state ID: status/full-load percent/cdc (e.g. running/100/cdc).
dms_state() {
  local arn
  arn="$(dms_config_arn "$1")"
  dms_replication "$1" "$arn" | jq -r 'if . == null then "none/0/-" else ((.Status // "none") + "/" + ((.ReplicationStats.FullLoadProgressPercent // 0) | tostring) + "/" + (if .ReplicationType == "cdc" or .ReplicationStats.FullLoadFinishDate != null then "cdc" else "load" end)) end'
}
dms_stopped() { [[ "$(dms_state "$1")" == stopped/* ]]; }
dms_in_sync() { [[ "$(dms_state "$1")" == running/*/cdc ]]; }
# dms_validated ID: every table validated with nothing pending or failed (engines DMS cannot validate count as validated).
dms_validated() {
  local id="$1" arn bad
  [[ "$(db_get "$id" validation)" == true ]] || return 0
  arn="$(dms_config_arn "$id")"
  bad="$(aws dms describe-replication-table-statistics --replication-config-arn "$arn" --output json 2>/dev/null \
    | jq '[.ReplicationTableStatistics[]? | select((.ValidationPendingRecords // 0) > 0 or (.ValidationFailedRecords // 0) > 0 or (.ValidationState // "" | test("Mismatch|Error|Failed"; "i")))] | length')"
  [[ "$bad" == 0 ]]
}
dms_status() {
  local id="$1" st
  st="$(dms_state "$id")"
  case "$st" in
    none/*) atk_done "$id" planned "no replication yet" inSync=false ;;
    running/*/cdc) atk_done "$id" in-sync "full load done, CDC running (CDC latency: see CloudWatch CDCLatencyTarget)" inSync=true fullLoadPct=100 ;;
    running/*) atk_done "$id" replicating "full load $\{st#running/}" inSync=false progressPct="$(cut -d/ -f2 <<< "$st")" ;;
    failed/*) atk_fail "$id" "the DMS replication failed: $(dms_replication "$id" "$(dms_config_arn "$id")" | jq -r '.StopReason // "see the DMS console"')" ;;
    *) atk_done "$id" replicating "DMS reports $st" inSync=false ;;
  esac
}
# my_schema_copy ID: the MySQL / MariaDB schema only (no rows), when the target has no user tables.
my_schema_copy() {
  local id="$1" n dumper spw
  n="$(my_q "$id" tgt "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')")"
  if [[ "$n" != 0 ]]; then atk_log "$(db_label "$id"): the target already has $n table(s); the schema is not copied again"; return 0; fi
  dumper="$(command -v mysqldump || command -v mariadb-dump || true)"
  [[ -n "$dumper" ]] || atk_die 3 "mysqldump is missing on the controller"
  mapfile -t schemas < <(my_q "$id" src "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema') ORDER BY 1")
  (( $\{#schemas[@]} )) || atk_die 5 "$(db_label "$id"): no user schemas on the source"
  _my_conn "$id" src
  spw="$_MY_PW"
  local -a sargs=("$\{_MY_ARGS[@]}")
  _my_conn "$id" tgt
  atk_log "$(db_label "$id"): copy the schema (no rows) to the target"
  db_changed
  "$dumper" --defaults-extra-file=<(my_cnf "$spw") "$\{sargs[@]}" --no-data --routines --triggers --events --skip-add-drop-table --databases "$\{schemas[@]}" \
    | atk_run mysql --defaults-extra-file=<(my_cnf "$_MY_PW") "$\{_MY_ARGS[@]}"
}
# ms_sql ID SIDE SQL: T-SQL through sqlcmd, the password in SQLCMDPASSWORD (reads); ms_x: the same as a change.
_ms_conn() {
  local id="$1" side="$2" role=SRC
  [[ "$side" == tgt ]] && role=TGT
  _MS_ARGS=(-S "tcp:$(db_need "$id" "$\{side}_host"),$(db_need "$id" "$\{side}_port")" -U "$(db_need "$id" "$\{side}_user")" -d "$(db_need "$id" dbname)" -b -h -1 -W)
  if [[ "$(db_get "$id" mssql_trust_cert)" == 1 ]]; then _MS_ARGS+=(-C); fi
  db_secret_to _MS_PW "$role" "$id"
}
ms_q() { _ms_conn "$1" "$2"; printf 'SET NOCOUNT ON;\n%s\nGO\n' "$3" | SQLCMDPASSWORD="$_MS_PW" sqlcmd "$\{_MS_ARGS[@]}" || atk_die 1 "$(db_label "$1"): cannot read the $(db_side "$2")"; }
ms_x() {
  _ms_conn "$1" "$2"
  atk_log "$(db_label "$1"): $3 (on the $(db_side "$2"))"
  db_sql_guard "$1" "$4"
  DB_CHANGED=1
  printf 'SET NOCOUNT ON;\n%s\nGO\n' "$4" | SQLCMDPASSWORD="$_MS_PW" atk_run sqlcmd "$\{_MS_ARGS[@]}" || atk_die 1 "$(db_label "$1"): $3 failed on the $(db_side "$2")"
}
# dms_schema_first ID: the target's schema before the load, by engine.
dms_schema_first() {
  local id="$1"
  case "$(db_get "$id" schema_first)" in
    pg) pg_ensure_db "$id" tgt; pg_schema_copy "$id" ;;
    mysql) my_schema_copy "$id" ;;
    oracle)
      ora_link "$id"
      if [[ -z "$(atk_ids_get aws-dms "$id.scn" 2>/dev/null || true)" ]]; then
        [[ "$(ora_q "$id" tgt "SELECT COUNT(*) FROM dba_tables WHERE owner IN ($(ora_schemas "$id"));")" == 0 ]] || { atk_log "$(db_label "$id"): the target already holds the schemas"; return 0; }
        ora_import "$id" "$(ora_scn "$id")" 0
      fi ;;
    *)
      if [[ "$(db_get "$id" engine)" == sqlserver ]]; then
        [[ "$(ms_q "$id" tgt "SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0;" | tr -d '[:space:]')" != 0 ]] \
          || atk_die 5 "$(db_label "$id"): create the schema on the target first (tables, keys, indexes: runbook, e.g. SqlPackage extract and publish); DMS then loads the rows"
      fi ;;
  esac
}
# dms_oracle_full_load ID: the Data Pump full load at an SCN; CDC then starts from that SCN.
dms_oracle_full_load() {
  local id="$1" scn
  scn="$(atk_ids_get aws-dms "$id.scn" 2>/dev/null || true)"
  if [[ -n "$scn" ]]; then printf '%s' "$scn"; return 0; fi
  ora_link "$id"
  scn="$(ora_scn "$id")"
  [[ "$scn" =~ ^[0-9]+$ ]] || atk_die 1 "$(db_label "$id"): could not read the source SCN over ATK_SRC"
  ora_import "$id" "$scn" 1 >&2
  atk_ids_put aws-dms "$id.scn" "$scn"
  printf '%s' "$scn"
}
# dms_post_cutover ID: sequences and identities, by engine, once the replication is stopped.
dms_post_cutover() {
  local id="$1"
  case "$(db_get "$id" engine)" in
    postgres) pg_sync_sequences "$id" src tgt ;;
    oracle) ora_sync_sequences "$id" ;;
    sqlserver) ms_x "$id" tgt "reseed every identity at the highest value loaded" "DECLARE @s nvarchar(max) = N''; SELECT @s += N'DBCC CHECKIDENT (''' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N''', RESEED) WITH NO_INFOMSGS; ' FROM sys.identity_columns ic JOIN sys.tables t ON t.object_id = ic.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id; EXEC sp_executesql @s;" ;;
    *) atk_log "$(db_label "$id"): no sequences to carry for $(db_get "$id" engine)" ;;
  esac
}
dms_reverse() {
  case "$(db_get "$1" engine)" in
    postgres) pg_reverse "$1" ;;
    mysql|mariadb) my_reverse "$1" pos ;;
    *) atk_log "$(db_label "$1"): no reverse replication for $(db_get "$1" engine) (exec.db.no-reverse)" ;;
  esac
}
dms_has_reverse() {
  case "$(db_get "$1" engine)" in
    postgres) pg_has "$1" src sub "$(pg_rev "$1")" ;;
    mysql|mariadb) my_is_replica_of "$1" src ;;
    *) return 1 ;;
  esac
}
`;

const AWS_DMS_VERBS = withTestSkips({
  prepare: code`
atk_need aws
dms_endpoint_arn "$id" src > /dev/null
dms_endpoint_arn "$id" tgt > /dev/null
dms_put_secret "$id" src
dms_put_secret "$id" tgt
dms_schema_first "$id"
db_finish "$id" prepared "endpoint secrets current, the target schema in place"`,
  replicate: code`
arn="$(dms_config_arn "$id")"
if [[ -z "$arn" ]]; then
  type=full-load-and-cdc
  if [[ "$(db_get "$id" full_load)" == datapump ]]; then scn="$(dms_oracle_full_load "$id")"; type=cdc; fi
  compute="$(jq -cn --arg sn "$ATK_DMS_SUBNET_GROUP" --arg sg "$\{ATK_DMS_SECURITY_GROUPS:-}" --arg max "$(db_get "$id" max_capacity)" --arg maz "$(db_get "$id" multi_az)" \
    '{ReplicationSubnetGroupId: $sn, MaxCapacityUnits: ($max | tonumber), MultiAZ: ($maz == "true")} + (if $sg == "" then {} else {VpcSecurityGroupIds: ($sg | split(",") | map(select(length > 0)))} end)')"
  settings="$(jq -cn --arg mode "$(db_get "$id" prep_mode)" --arg val "$(db_get "$id" validation)" \
    '{TargetMetadata: {TargetTablePrepMode: $mode}, ValidationSettings: {EnableValidation: ($val == "true")}, Logging: {EnableLogging: true}}')"
  atk_log "$(db_label "$id"): create the DMS Serverless replication config ($type)"
  db_changed
  atk_run aws dms create-replication-config --replication-config-identifier "$(db_need "$id" config_id)" \
    --source-endpoint-arn "$(dms_endpoint_arn "$id" src)" --target-endpoint-arn "$(dms_endpoint_arn "$id" tgt)" \
    --replication-type "$type" --table-mappings "file://$(dms_mappings "$id")" --compute-config "$compute" --replication-settings "$settings" \
    --resource-identifier "$(db_need "$id" config_id)" --tags "Key=atk_plan,Value=$ATK_PLAN8" "Key=atk_item,Value=$(atk_name "$id")" --output text --query ReplicationConfig.ReplicationConfigArn
  arn="$(dms_config_arn "$id")"
fi
st="$(dms_state "$id")"
if [[ "$(db_phase "$id")" != cut-over && ( "$st" == none/* || "$st" == created/* || "$st" == stopped/* ) ]]; then
  start=start-replication
  [[ "$st" == stopped/* ]] && start=resume-processing
  extra=()
  scn="$(atk_ids_get aws-dms "$id.scn" 2>/dev/null || true)"
  if [[ "$start" == start-replication && -n "$scn" ]]; then extra=(--cdc-start-position "$scn"); fi
  db_changed
  atk_run aws dms start-replication --replication-config-arn "$\{arn:-dry-run}" --start-replication-type "$start" "$\{extra[@]}" --output text --query Replication.Status
fi
atk_wait_until "$DB_WAIT_MINUTES" 60 dms_in_sync "$id" || true
dms_status "$id"`,
  status: 'dms_status "$id"',
  cutover: code`
if [[ "$(db_phase "$id")" == cut-over ]]; then atk_skip "$id" "already cut over" cut-over; fi
arn="$(dms_config_arn "$id")"
[[ -n "$arn" ]] || atk_fail "$id" "no DMS replication config: run replicate first"
if [[ "$(dms_state "$id")" == running/* ]]; then
  atk_wait_until 30 20 dms_in_sync "$id" || atk_fail "$id" "the full load is not finished; nothing was switched"
  atk_wait_until 60 30 dms_validated "$id" || atk_fail "$id" "table validation reports pending or failed records after the freeze; nothing was switched"
  db_changed
  atk_run aws dms stop-replication --replication-config-arn "$arn" --output text --query Replication.Status
  atk_wait_until 30 15 dms_stopped "$id" || atk_fail "$id" "the DMS replication did not stop"
fi
dms_post_cutover "$id"
dms_reverse "$id"
db_phase "$id" cut-over
if dms_has_reverse "$id"; then rev=true; else rev=false; fi
atk_done "$id" cut-over "the replication is stopped with validation clean, sequences carried; reverse replication: $rev" reverse="$rev"`,
  commit: 'atk_skip "$id" "nothing to commit: any reverse replication stays until finalize"',
  rollback: code`
if [[ "$(db_phase "$id")" == rolled-back ]]; then atk_skip "$id" "already rolled back"; fi
if dms_has_reverse "$id"; then
  case "$(db_get "$id" engine)" in postgres) pg_reverse_rollback "$id" ;; *) my_reverse_rollback "$id" ;; esac
  db_phase "$id" rolled-back
  atk_done "$id" "" "the source has the target's writes (reverse lag 0): switch the applications back"
fi
if [[ "$(db_phase "$id")" == cut-over ]]; then
  db_phase "$id" rolled-back
  atk_done "$id" "" "no reverse replication: the source is as it was at the freeze, and writes made on the target since cutover are not carried back"
fi
if [[ "$(dms_state "$id")" == running/* ]]; then
  db_changed
  atk_run aws dms stop-replication --replication-config-arn "$(dms_config_arn "$id")" --output text --query Replication.Status
  db_phase "$id" rolled-back
  atk_done "$id" "" "the DMS replication is stopped; the source was only frozen and is unchanged; the target is kept for analysis"
fi
atk_skip "$id" "nothing to roll back: the source was not changed"`,
  finalize: code`
arn="$(dms_config_arn "$id")"
if [[ -n "$arn" ]]; then
  if [[ "$(dms_state "$id")" == running/* ]]; then db_changed; atk_run aws dms stop-replication --replication-config-arn "$arn" --output text --query Replication.Status; fi
  db_changed
  atk_run aws dms delete-replication-config --replication-config-arn "$arn" --output text --query ReplicationConfig.ReplicationConfigIdentifier
fi
case "$(db_get "$id" engine)" in
  postgres) pg_teardown "$id" ;;
  mysql|mariadb) my_teardown "$id" ;;
  oracle) ora_drop_link "$id" ;;
esac
for side in src tgt; do
  ep="$(dms_endpoint "$id" "$side")"
  secret="$(jq -r '(.PostgreSQLSettings // .MySQLSettings // .OracleSettings // .MicrosoftSQLServerSettings // .DocDbSettings // .MongoDbSettings // {}).SecretsManagerSecretId // empty' <<< "$\{ep:-null}")"
  if [[ -n "$secret" ]] && aws secretsmanager describe-secret --secret-id "$secret" --query 'DeletedDate' --output text 2>/dev/null | grep -qx None; then
    db_changed
    atk_run aws secretsmanager delete-secret --secret-id "$secret" --recovery-window-in-days 7 --query Name --output text
  fi
done
db_finish "$id" "" "the replication config and the endpoint secrets (7-day recovery window) removed"`,
});

// ---------------------------------------------------------------------------
// gcp-dms
// ---------------------------------------------------------------------------

const GCP_DMS_SETTINGS: readonly DbSetting[] = [
  { key: 'job', help: 'the migration job id (Terraform google_database_migration_service_migration_job)' },
  { key: 'project', help: 'the Google Cloud (GCP) project (empty: gcloud config)' },
  { key: 'gcs_backups', help: 'SQL Server: gs://bucket/prefix holding the full and log backups' },
  { key: 'reverse', help: '1: reverse replication (target to source) at cutover, PostgreSQL and MySQL' },
  { key: 'tgt_host_seen_from_src', help: 'the target as the source reaches it, when it differs from tgt_host' },
];

function gcpDmsExtra(i: ManifestItem): Record<string, string> {
  const engine = i.engine ?? '';
  return {
    job: i.resource,
    project: '',
    gcs_backups: engine === 'sqlserver' ? `gs://${i.resource}-backups/${i.name}` : '',
    pg_sslmode: 'require',
    pg_repl_sslmode: 'require',
    my_ssl_mode: 'REQUIRED',
    my_kind: 'cloudsql',
    reverse: engine === 'postgres' || engine === 'mysql' ? '1' : '0',
    reverse_supported: engine === 'postgres' || engine === 'mysql' ? '1' : '0',
    target_version: i.target.engineVersion ?? '',
    tgt_host_seen_from_src: '',
  };
}

const GCP_DMS_FUNCS = code`
DB_WAIT_MINUTES="$\{ATK_DB_WAIT_MINUTES:-480}"

gdms_args() {
  printf '%s\n' "$(db_need "$1" job)" --region "$(db_need "$1" region)"
  if [[ -n "$(db_get "$1" project)" ]]; then printf '%s\n' --project "$(db_get "$1" project)"; fi
}
gdms_job() {
  local -a a
  mapfile -t a < <(gdms_args "$1")
  gcloud database-migration migration-jobs describe "$\{a[@]}" --format=json 2>/dev/null || printf 'null'
}
# gdms_state ID: STATE/PHASE (e.g. RUNNING/CDC).
gdms_state() { gdms_job "$1" | jq -r 'if . == null then "NONE/" else ((.state // "") + "/" + (.phase // "")) end'; }
gdms_in_sync() { [[ "$(gdms_state "$1")" =~ ^RUNNING/(CDC|READY_FOR_PROMOTE)$ ]]; }
gdms_completed() { [[ "$(gdms_state "$1")" == COMPLETED/* ]]; }
gdms_status() {
  local id="$1" st
  st="$(gdms_state "$id")"
  case "$st" in
    NONE/*) atk_fail "$id" "no migration job $(db_get "$id" job) in $(db_get "$id" region): apply terraform (google_mig_replication)" ;;
    RUNNING/CDC|RUNNING/READY_FOR_PROMOTE) atk_done "$id" in-sync "the job is in $\{st#*/}" inSync=true phase="$\{st#*/}" ;;
    COMPLETED/*) atk_done "$id" cut-over "the job is promoted" ;;
    FAILED/*) atk_fail "$id" "the migration job failed ($st)" ;;
    *) atk_done "$id" replicating "the job reports $st" inSync=false phase="$\{st#*/}" ;;
  esac
}
gdms_run() {
  local id="$1" verb="$2"
  local -a a
  mapfile -t a < <(gdms_args "$id")
  db_changed
  atk_run gcloud database-migration migration-jobs "$verb" "$\{a[@]}" --quiet
}
gdms_reverse() {
  case "$(db_get "$1" engine)" in
    postgres) pg_reverse "$1" ;;
    mysql) my_reverse "$1" pos ;;
    *) atk_log "$(db_label "$1"): no reverse replication for $(db_get "$1" engine) (exec.db.no-reverse)" ;;
  esac
}
gdms_has_reverse() {
  case "$(db_get "$1" engine)" in
    postgres) pg_has "$1" src sub "$(pg_rev "$1")" ;;
    mysql) my_is_replica_of "$1" src ;;
    *) return 1 ;;
  esac
}
`;

const GCP_DMS_VERBS = withTestSkips({
  prepare: code`
atk_need gcloud
[[ "$(gdms_state "$id")" != NONE/* ]] || atk_die 5 "$(db_label "$id"): no migration job $(db_get "$id" job): apply terraform (google_mig_replication) first"
if [[ "$(db_get "$id" engine)" == sqlserver ]]; then
  gcloud storage ls "$(db_need "$id" gcs_backups)/" > /dev/null 2>&1 || atk_die 5 "$(db_label "$id"): no backups in $(db_get "$id" gcs_backups): put the full backup and the log backups there (runbook)"
fi
mapfile -t a < <(gdms_args "$id")
gcloud database-migration migration-jobs verify "$\{a[@]}" --quiet > /dev/null || atk_die 5 "$(db_label "$id"): the migration job does not verify (connectivity, source settings): see the Database Migration Service console"
atk_skip "$id" "the migration job verifies" prepared`,
  replicate: code`
st="$(gdms_state "$id")"
case "$st" in
  NOT_STARTED/*|DRAFT/*|CREATING/*) gdms_run "$id" start ;;
  STOPPED/*) if [[ "$(db_phase "$id")" != cut-over ]]; then gdms_run "$id" resume; fi ;;
esac
atk_wait_until "$DB_WAIT_MINUTES" 60 gdms_in_sync "$id" || true
gdms_status "$id"`,
  status: 'gdms_status "$id"',
  cutover: code`
if [[ "$(db_phase "$id")" == cut-over ]]; then atk_skip "$id" "already cut over" cut-over; fi
if ! gdms_completed "$id"; then
  atk_wait_until 30 20 gdms_in_sync "$id" || atk_fail "$id" "the job is not in CDC ($(gdms_state "$id")); nothing was switched"
  if [[ "$(db_get "$id" engine)" == sqlserver ]]; then atk_log "$(db_label "$id"): the last log backup must be in $(db_get "$id" gcs_backups) before the promote (runbook)"; fi
  gdms_run "$id" promote
  atk_wait_until 60 20 gdms_completed "$id" || atk_fail "$id" "the promote did not complete ($(gdms_state "$id"))"
fi
if [[ "$(db_get "$id" engine)" == postgres ]]; then pg_sync_sequences "$id" src tgt; fi
gdms_reverse "$id"
db_phase "$id" cut-over
if gdms_has_reverse "$id"; then rev=true; else rev=false; fi
atk_done "$id" cut-over "the destination is promoted; reverse replication: $rev" reverse="$rev"`,
  commit: 'atk_skip "$id" "nothing to commit: a promote cannot be undone, and any reverse replication stays until finalize"',
  rollback: code`
if [[ "$(db_phase "$id")" == rolled-back ]]; then atk_skip "$id" "already rolled back"; fi
if gdms_has_reverse "$id"; then
  case "$(db_get "$id" engine)" in postgres) pg_reverse_rollback "$id" ;; *) my_reverse_rollback "$id" ;; esac
  db_phase "$id" rolled-back
  atk_done "$id" "" "the source has the target's writes (reverse lag 0): switch the applications back"
fi
if [[ "$(db_phase "$id")" == cut-over ]] || gdms_completed "$id"; then
  db_phase "$id" rolled-back
  atk_done "$id" "" "no reverse replication: the source is as it was at the freeze, and writes made on the destination since the promote are not carried back"
fi
if [[ "$(gdms_state "$id")" == RUNNING/* ]]; then
  gdms_run "$id" stop
  db_phase "$id" rolled-back
  atk_done "$id" "" "the migration job is stopped; the source was only frozen and is unchanged"
fi
atk_skip "$id" "nothing to roll back: the source was not changed"`,
  finalize: code`
case "$(db_get "$id" engine)" in
  postgres) pg_teardown "$id" ;;
  mysql) my_teardown "$id" ;;
esac
if [[ "$(gdms_state "$id")" != NONE/* ]]; then gdms_run "$id" delete; fi
db_finish "$id" "" "the migration job deleted (remove its connection profiles from Terraform on the next apply)"`,
});

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

function awsScript(rows: DbRows, ctx: PathContext): string {
  return shScript({
    file: ENTRY['aws-dms']!,
    paths: ['aws-dms'],
    summary: 'AWS DMS Serverless: endpoint secrets from the vault, the schema first, full load and CDC, validation before cutover, reverse replication for PostgreSQL and MySQL.',
    needs: ['aws', 'jq'],
    functions: [DB_SH_BASE, shSettings(rows, ctx), PG_SH, MY_SH, ORA_SH, AWS_DMS_FUNCS].join('\n'),
    verbs: AWS_DMS_VERBS,
  });
}
function gcpScript(rows: DbRows, ctx: PathContext): string {
  return shScript({
    file: ENTRY['gcp-dms']!,
    paths: ['gcp-dms'],
    summary: 'Database Migration Service (Google Cloud (GCP)): verify, start, promote at cutover; reverse replication for PostgreSQL and MySQL.',
    needs: ['gcloud', 'jq'],
    functions: [DB_SH_BASE, shSettings(rows, ctx), PG_SH, MY_SH, GCP_DMS_FUNCS].join('\n'),
    verbs: GCP_DMS_VERBS,
  });
}

function cloudDmsFindings(items: readonly ManifestItem[]): Finding[] {
  const out: Finding[] = [];
  for (const i of items) {
    const engine = i.engine ?? '';
    if (i.path === 'aws-dms') {
      if (engine === 'sqlserver') out.push(info('exec.db.schema-first', `${i.name}: AWS DMS loads rows only; create the SQL Server schema (tables, keys, indexes) on the target before prepare.`, { path: i.id, remediation: 'Script the schema from the source (SqlPackage extract and publish, or SSMS generate scripts) as a runbook step.' }));
      if (engine === 'oracle') out.push(info('exec.db.oracle-full-load', `${i.name}: the full load is an Oracle Data Pump import over a database link at an SCN; DMS then replicates changes from that SCN (data.fullLoad = datapump).`, { path: i.id, source: 'https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.Oracle.html' }));
      if (engine !== 'postgres' && engine !== 'mysql' && engine !== 'mariadb') out.push(noReverseFinding(i, 'DMS replicates one way, and no native reverse exists for this engine here'));
      else if ((engine === 'mysql' || engine === 'mariadb') && !myReverseSupported(i.engine, myTargetKind(i.target.service))) out.push(noReverseFinding(i, 'the target exposes no binlogs to replicate back from'));
    } else if (i.path === 'gcp-dms') {
      if (engine !== 'postgres' && engine !== 'mysql') out.push(noReverseFinding(i, 'a promote cannot be undone, and the kit has no reverse replication for this engine'));
      if (engine === 'sqlserver') out.push(warning('exec.db.gcs-backups', `${i.name}: Database Migration Service for SQL Server reads the full and log backups from Cloud Storage; putting them there (and the last one before the promote) is a runbook step.`, { path: i.id, source: 'https://docs.cloud.google.com/database-migration/docs/sqlserver' }));
    }
  }
  return out;
}

export const CLOUD_DMS_GENERATOR: PathGenerator = Object.freeze({
  id: 'db-cloud-dms',
  owner: 'WP-11d' as const,
  paths: CLOUD_DMS_PATHS,
  needs: [
    need('command', 'aws', 'AWS DMS', { min: '2', install: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html' }),
    need('command', 'gcloud', 'Database Migration Service (Google Cloud (GCP))', { install: 'https://cloud.google.com/sdk/docs/install' }),
    need('command', 'psql', 'PostgreSQL schema copy and reverse replication'),
    need('command', 'mysql', 'MySQL schema copy and reverse replication'),
    need('command', 'sqlplus', 'Oracle Data Pump full load over a database link (Oracle Instant Client with SQL*Plus)'),
    need('command', 'sqlcmd', 'SQL Server identity reseed after AWS DMS'),
  ],
  entry: (p: ExecPath) => ENTRY[p] ?? `${DB_DIR}/${p}.sh`,
  files(items: readonly ManifestItem[], ctx: PathContext): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    const readme: ReadmeItem[] = [];
    const rows = new Map<string, Readonly<Record<string, string>>>();
    const tokens = new Map<string, string>();
    const aws = onPath(items, 'aws-dms');
    if (aws.length) {
      const r = dbRows(aws, awsDmsExtra(ctx));
      out[ENTRY['aws-dms']!] = awsScript(r, ctx);
      for (const i of aws) {
        out[tableMappingsFile(i)] = tableMappings(i);
        readme.push({
          item: i, script: ENTRY['aws-dms']!, settings: [...BASE_SETTINGS, ...AWS_DMS_SETTINGS],
          secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>', ...(i.engine === 'postgres' || i.engine === 'mysql' || i.engine === 'mariadb' ? ['REPL_DB_PASSWORD_<TOKEN>'] : [])],
          notes: [`Table mappings: \`${tableMappingsFile(i)}\` (every schema except the engine's own; narrow it before replicate if needed).`, 'The replication subnet group is `ATK_DMS_SUBNET_GROUP` (default `atk-<plan8>-dms`), the security groups `ATK_DMS_SECURITY_GROUPS` (a comma list).'],
        });
      }
      for (const [k, v] of r.rows) rows.set(k, v);
      for (const [k, v] of r.tokens) tokens.set(k, v);
    }
    const gcp = onPath(items, 'gcp-dms');
    if (gcp.length) {
      const r = dbRows(gcp, gcpDmsExtra);
      out[ENTRY['gcp-dms']!] = gcpScript(r, ctx);
      for (const i of gcp) {
        readme.push({
          item: i, script: ENTRY['gcp-dms']!, settings: [...BASE_SETTINGS, ...GCP_DMS_SETTINGS],
          secrets: i.engine === 'postgres' || i.engine === 'mysql' ? ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>', 'REPL_DB_PASSWORD_<TOKEN>'] : [],
          notes: ['The connection profiles hold the source password as a sensitive Terraform variable (TF_VAR_), as the base design says; the script itself needs the passwords only for the reverse replication.'],
        });
      }
      for (const [k, v] of r.rows) rows.set(k, v);
      for (const [k, v] of r.tokens) tokens.set(k, v);
    }
    out[`${DB_DIR}/README-cloud-dms.md`] = dbReadme(
      'Provider database migration services',
      'AWS DMS Serverless and Database Migration Service (Google Cloud (GCP)). Terraform defines the endpoints, the subnet group and the migration jobs; these scripts fill the endpoint secrets, start, watch, cut over, roll back and clean up.',
      readme, { rows, tokens },
    );
    return out;
  },
  findings(items: readonly ManifestItem[], ctx: PathContext): readonly Finding[] {
    const rows = new Map<string, Record<string, string>>();
    const tokens = new Map<string, string>();
    for (const [path, extra] of [['aws-dms', awsDmsExtra(ctx)], ['gcp-dms', gcpDmsExtra]] as const) {
      const r = dbRows(onPath(items, path), extra);
      for (const [k, v] of r.rows) rows.set(k, { ...v });
      for (const [k, v] of r.tokens) tokens.set(k, v);
    }
    const needHost = items.filter((i) => i.path === 'aws-dms' || (i.path === 'gcp-dms' && (i.engine === 'postgres' || i.engine === 'mysql')));
    return [...cloudDmsFindings(items), ...endpointFinding(needHost, { rows, tokens })];
  },
});

export const GENERATORS: readonly PathGenerator[] = Object.freeze([CLOUD_DMS_GENERATOR]);
