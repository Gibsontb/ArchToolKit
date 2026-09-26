/**
 * WP-17: the databases beyond the core (addendum A.4.9, A.6.9), each a
 * generator of the execution kit keeping the script contract (A.6.2):
 *
 *   db2        db2-backup-restore, db2-hadr        paths/db/db2/db2.sh         (on the hosts, through Ansible)
 *   ase        ase-dump-load                       paths/db/ase/ase.sh         (on the hosts, through Ansible)
 *   informix   informix-backup-restore             paths/db/informix/informix.sh (on the hosts, through Ansible)
 *   mongo      mongo-mongosync                     paths/db/mongo/mongo.sh     (mongosync on the controller)
 *   redis      redis-replicaof, redis-rdb-import   paths/db/redis/redis.sh     (redis-cli and the cloud CLIs)
 *   cassandra  cassandra-zdm-proxy, -ring-join     paths/db/cassandra/cassandra.sh (dsbulk; cqlsh / nodetool on the nodes)
 *   es         es-snapshot-restore, es-reindex-remote paths/db/es/es.sh        (the REST APIs, curl)
 *
 * The shape per path follows A.6.9: prepare (the target ready, a seed),
 * replicate / in-sync (the engine's own replication or the seed plus the
 * log chain), cutover (switchover, or the final copy), rollback (through
 * the reverse path where the engine keeps one, else `replication=lost` and
 * the `exec.db.no-reverse` finding), finalize (replication and the kit's
 * leftovers removed). Settings, credentials and remote steps work as in
 * `../paths/patterns.ts`, whose shared helpers this module uses.
 *
 * Pure: no DOM, no file system.
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import { isIaasService } from '../../design/compute.ts';
import type { DbServiceId } from '../../types.ts';
import { planId8, type ExecPath, type Verb } from '../contract.ts';
import { code, shScript } from '../lib-sh.ts';
import type { ManifestItem } from '../manifest.ts';
import {
  addressOf, everyVerb, familyReadme, fnVerb, HOST_COMMANDS, HOST_NEEDS, HOST_SH, HOST_STEP_FILE, HOST_STEP_PLAYBOOK, renderSettingsSh,
  settingTokens, sourceHost, targetHost, workloadsOf, WP17, type SettingRow, type SettingSpec,
} from '../paths/patterns.ts';
import type { PathContext, PathGenerator, ToolNeed } from '../registry.ts';

const DB_DIR = 'paths/db';

/** The item's service and whether it is a VM (IaaS). */
const serviceOf = (item: ManifestItem): DbServiceId | undefined => item.target.service;
const onVm = (item: ManifestItem): boolean => isIaasService(serviceOf(item));

/** The source and target hosts of a database item (inventory names), its first address. */
function hostsOf(item: ManifestItem, ctx: PathContext): { src?: string; tgt?: string; addr?: string; srcAll: string[]; tgtAll: string[]; names: string[] } {
  const ws = workloadsOf(ctx, item);
  const w = ws[0];
  return {
    ...(w ? { src: sourceHost(w) } : {}),
    ...(w && onVm(item) ? { tgt: targetHost(w) } : {}),
    ...(w ? { addr: addressOf(w) ?? w.name } : {}),
    srcAll: ws.map(sourceHost),
    tgtAll: onVm(item) ? ws.map(targetHost) : [],
    names: ws.map((x) => x.name),
  };
}

interface Family {
  readonly id: string;
  readonly paths: readonly ExecPath[];
  readonly file: string;
  readonly summary: string;
  readonly commands: readonly string[];
  readonly needs: readonly ToolNeed[];
  readonly specs: readonly SettingSpec[];
  readonly rows: (items: readonly ManifestItem[], ctx: PathContext) => SettingRow[];
  readonly sh: string;
  readonly verbs: Record<Verb, string>;
  readonly usesHostStep: boolean;
  readonly readme: {
    readonly title: string;
    readonly intro: readonly string[];
    readonly verbs: readonly string[];
    readonly credentials: readonly string[];
    readonly environment?: readonly string[];
    readonly runbook?: readonly string[];
    readonly unconfirmed?: readonly string[];
  };
  readonly findings?: (items: readonly ManifestItem[], ctx: PathContext) => Finding[];
}

/** A verb body that dispatches on the item's path to `<prefix>_<verb>` (prefixes per path). */
function dispatch(prefix: Readonly<Partial<Record<ExecPath, string>>>, fallback: string, ctxFn: string): (v: Verb) => string {
  return (v) => {
    const cases = Object.entries(prefix).map(([p, f]) => `  ${p}) ${f}_${fnVerb(v)} "$id" ;;`);
    return [`ID="$id"`, `${ctxFn} "$id"`, 'case "${ATK_ITEM_PATH[$id]}" in', ...cases, `  *) ${fallback}_${fnVerb(v)} "$id" ;;`, 'esac'].join('\n');
  };
}

function generator(f: Family): PathGenerator {
  return {
    id: f.id,
    owner: WP17,
    paths: f.paths,
    needs: f.needs,
    entry: () => f.file,
    files(items, ctx) {
      const tokens = settingTokens(items);
      const rows = f.rows(items, ctx);
      const out: Record<string, string> = {
        [f.file]: shScript({
          file: f.file,
          paths: f.paths,
          summary: f.summary,
          needs: f.commands,
          functions: `${renderSettingsSh(rows, tokens)}\n${HOST_SH}\n${f.sh}`,
          verbs: f.verbs,
        }),
        [f.file.replace(/[^/]+$/, 'README.md')]: familyReadme({ ...f.readme, script: f.file, specs: f.specs, rows, tokens }),
      };
      if (f.usesHostStep) out[HOST_STEP_FILE] = HOST_STEP_PLAYBOOK;
      return out;
    },
    findings: (items, ctx) => f.findings?.(items, ctx) ?? [],
  };
}

const noReverse = (items: readonly ManifestItem[], paths: readonly ExecPath[], file: string, what: string): Finding[] => {
  const names = items.filter((i) => paths.includes(i.path)).map((i) => i.name);
  return names.length ? [warning('exec.db.no-reverse', `${names.join(', ')}: ${what} keeps no way back: after the cutover, a rollback loses the target's writes.`, { path: file })] : [];
};
const unknownSettings = (rows: readonly SettingRow[], keys: readonly string[], file: string): Finding[] => {
  const miss = rows.flatMap((r) => keys.filter((k) => k in r.values && !r.values[k]).map((k) => `${r.item.name}.${k}`));
  return miss.length ? [info('exec.db.settings', `Set at run time (ATK_SET_<TOKEN>_<KEY>, see the README next to the script): ${miss.join(', ')}.`, { path: file })] : [];
};

// ---------------------------------------------------------------------------
// Db2: HADR (VM to VM), online backup and logs (VM, or Amazon RDS for Db2)
// ---------------------------------------------------------------------------

const DB2_FILE = `${DB_DIR}/db2/db2.sh`;

const DB2_SH = code`
db2_ctx() {
  DB="$(set_need "$1" database)"
  INST="$(set_need "$1" instance)"
  SRC="$(set_need "$1" source_host)"
  KIND="$(set_get "$1" target)"
  TGT=""
  if [[ "$KIND" != rds ]]; then TGT="$(set_need "$1" target_host)"; fi
  DIR="$(set_need "$1" backup_dir)"
  DIR="$DIR/$(atk_name "$1")"
}
db2_host() { if [[ "$1" == src ]]; then printf '%s' "$SRC"; else printf '%s' "$TGT"; fi; }
db2_read() { host_read "$(db2_host "$1")" "$INST" "$2"; }
db2_step() { host_step "$(db2_host "$1")" "$INST" "$2" "$\{3:-}"; }
# hadr SIDE FIELD: a field of db2pd -hadr (HADR_ROLE, HADR_STATE, HADR_CONNECT_STATUS, HADR_LOG_GAP(bytes)).
hadr() { db2_read "$1" "db2pd -db $DB -hadr" | awk -v k="$2" '$1 == k && !f { print $3; f = 1 }'; }
db2_role() { local r; r="$(hadr "$1" HADR_ROLE)"; printf '%s' "$\{r:-STANDARD}"; }
is_role() { [[ "$(db2_role "$1")" == "$2" ]]; }
hadr_insync() {
  local st gap
  st="$(hadr "$1" HADR_STATE)"
  gap="$(hadr "$1" 'HADR_LOG_GAP(bytes)')"
  [[ "$st" == PEER || ( "$st" == REMOTE_CATCHUP && "$gap" == 0 ) ]]
}
rf_pending() { [[ "$(db2_read "$1" "db2 rollforward db $DB query status")" =~ (DB|TBS)[[:space:]]+pending ]]; }
# db2_cfg SIDE KEY: one value of the database configuration, by its (KEY).
db2_cfg() { db2_read "$1" "db2 get db cfg for $DB" | awk -F'= ' -v k="($2)" 'index($1, k) && !f { sub(/[[:space:]]+$/, "", $2); print $2; f = 1 }'; }
quiesced() { [[ "$(db2_read src "db2 get snapshot for database on $DB")" == *Quiesced* ]]; }
# image_ts SUB: the newest backup image's timestamp in DIR/SUB.
image_ts() { db2_read src "ls -1 $DIR/$1 2> /dev/null" | sed -n 's/.*\.\([0-9]\{14\}\)\.001$/\1/p' | sort | awk 'END { print }'; }
need_archive() {
  local arch
  arch="$(db2_cfg src LOGARCHMETH1)"
  [[ -n "$arch" && "$arch" != OFF ]] || atk_fail "$1" "archive logging is off on $SRC (LOGARCHMETH1): enable it first (it needs an offline backup; runbook)"
  ARCH="$arch"
}
seed_backup() {
  local ts
  ts="$(image_ts seed)"
  if [[ -z "$ts" ]]; then
    db2_step src "mkdir -p $DIR/seed && db2 backup db $DB online to $DIR/seed compress include logs"
    ts="$(image_ts seed)"
  fi
  if [[ -z "$ts" ]] && (( ! ATK_DRY_RUN )); then atk_fail "$ID" "no backup image in $DIR/seed after the backup"; fi
  SEED_TS="$\{ts:-TIMESTAMP}"
}
# ship_logs: close the current log on the source and copy the archived logs to the shared directory (DISK archiving).
ship_logs() {
  local path
  [[ "$ARCH" == DISK:* ]] || atk_fail "$ID" "the source archives logs to $ARCH: the kit ships logs from DISK archiving only (runbook for TSM / VENDOR)"
  path="$\{ARCH#DISK:}"
  db2_step src "db2 archive log for db $DB && mkdir -p $DIR/logs && find $path/$INST/$DB -name 'S*.LOG' -exec cp -u {} $DIR/logs/ \\;"
}
quiesce() { if ! quiesced; then db2_step src "db2 connect to $DB && db2 quiesce database immediate force connections; rc=\$?; db2 connect reset > /dev/null; [ \$rc -lt 4 ]"; fi; }
unquiesce() { if quiesced; then db2_step src "db2 connect to $DB && db2 unquiesce database; rc=\$?; db2 connect reset > /dev/null; [ \$rc -lt 4 ]"; return 0; fi; return 1; }

# ---------------------------------------------------------------- db2-hadr

hadr_prepare() {
  local id="$1"
  need_archive "$id"
  if is_role tgt STANDBY || rf_pending tgt; then atk_skip "$id" "the target holds the restored copy (rollforward pending or HADR standby)" prepared; fi
  seed_backup
  db2_step tgt "db2 restore db $DB from $DIR/seed taken at $SEED_TS replace history file without prompting"
  atk_done "$id" prepared "online backup restored on $TGT (rollforward pending: the standby to be)"
}
hadr_cfg() { # SIDE LOCAL REMOTE PORT MODE
  db2_step "$1" "db2 update db cfg for $DB using HADR_LOCAL_HOST $2 HADR_LOCAL_SVC $4 HADR_REMOTE_HOST $3 HADR_REMOTE_SVC $4 HADR_REMOTE_INST $INST HADR_SYNCMODE $5 HADR_TARGET_LIST $(url_host "$3"):$4 LOGINDEXBUILD ON"
}
hadr_replicate() {
  local id="$1" rs rt sa ta port mode
  sa="$(set_need "$id" hadr_source_addr)"
  ta="$(set_need "$id" hadr_target_addr)"
  port="$(set_need "$id" hadr_port)"
  mode="$(set_need "$id" hadr_syncmode)"
  rs="$(db2_role src)"
  rt="$(db2_role tgt)"
  if [[ "$rt" == PRIMARY ]]; then atk_skip "$id" "cut over: the target is the HADR primary" cut-over; fi
  if [[ "$rs" == PRIMARY && "$rt" == STANDBY ]]; then
    if hadr_insync tgt; then atk_skip "$id" "HADR is in peer state" in-sync inSync=true; fi
  else
    rf_pending tgt || (( ATK_DRY_RUN )) || atk_fail "$id" "the target holds no restored copy: run prepare first"
    hadr_cfg tgt "$ta" "$sa" "$port" "$mode"
    hadr_cfg src "$sa" "$ta" "$port" "$mode"
    if [[ "$rt" != STANDBY ]]; then db2_step tgt "db2 start hadr on db $DB as standby"; fi
    if [[ "$rs" != PRIMARY ]]; then db2_step src "db2 start hadr on db $DB as primary"; fi
  fi
  if atk_wait_until 720 60 hadr_insync tgt; then atk_done "$id" in-sync "HADR in peer state" inSync=true; fi
  atk_done "$id" replicating "the standby is catching up (status polls it)" inSync=false
}
hadr_status() {
  local id="$1" st gap
  if is_role tgt PRIMARY; then atk_skip "$id" "cut over: $SRC is the HADR standby (the way back)"; fi
  st="$(hadr tgt HADR_STATE)"
  gap="$(hadr tgt 'HADR_LOG_GAP(bytes)')"
  if [[ -z "$st" ]]; then atk_done "$id" "" "HADR is not running" inSync=false; fi
  if hadr_insync tgt; then atk_done "$id" in-sync "HADR $st" inSync=true logGapBytes="$\{gap:-0}"; fi
  if [[ "$(hadr tgt HADR_CONNECT_STATUS)" == DISCONNECTED ]]; then atk_fail "$id" "HADR is disconnected ($st)" inSync=false; fi
  atk_done "$id" replicating "HADR $st" inSync=false logGapBytes="$\{gap:-0}"
}
hadr_test() { atk_skip "$1" "an HADR standby is not open for use: rehearse the takeover on a non-production system (rollback.sh --rehearse)"; }
hadr_test_cleanup() { atk_skip "$1" "no test copy to remove"; }
hadr_cutover() {
  local id="$1"
  if is_role tgt PRIMARY; then atk_skip "$id" "the target is already the HADR primary" cut-over; fi
  is_role tgt STANDBY || atk_fail "$id" "the target is not an HADR standby: run replicate first"
  hadr_insync tgt || atk_fail "$id" "HADR is not in peer state: wait until status reports in-sync"
  db2_step tgt "db2 takeover hadr on db $DB"
  atk_wait_until 10 15 is_role tgt PRIMARY || atk_fail "$id" "the target did not become the primary"
  atk_done "$id" cut-over "role switch done: $TGT is the primary, $SRC the standby (the way back until finalize)" reverse=true
}
hadr_commit() {
  is_role tgt PRIMARY || atk_fail "$1" "not cut over: the target is not the primary"
  atk_done "$1" "" "committed: $SRC stays the HADR standby (the way back) until finalize"
}
hadr_rollback() {
  local id="$1"
  if is_role src PRIMARY; then atk_skip "$id" "the source is the primary: nothing to roll back" "" replication=kept; fi
  is_role src STANDBY || atk_fail "$id" "the source is neither primary nor standby: roll back by hand (runbook; db2 takeover hadr ... by force when the target is gone)"
  db2_step src "db2 takeover hadr on db $DB"
  atk_wait_until 10 15 is_role src PRIMARY || atk_fail "$id" "the source did not become the primary"
  atk_done "$id" "" "role switch back: $SRC is the primary, $TGT the standby" replication=kept
}
hadr_finalize() {
  local id="$1" rs rt
  rs="$(db2_role src)"
  rt="$(db2_role tgt)"
  if [[ "$rt" == STANDBY ]]; then atk_fail "$id" "the target is still the standby: finalize runs after the cutover"; fi
  if [[ "$rs" == STANDARD && "$rt" == STANDARD && -z "$(db2_read src "ls -d $DIR 2> /dev/null")" ]]; then atk_skip "$id" "HADR and the migration backups are already removed"; fi
  if [[ "$rs" == STANDBY ]]; then db2_step src "db2 deactivate db $DB; db2 stop hadr on db $DB"; fi
  if [[ "$rt" == PRIMARY ]]; then db2_step tgt "db2 stop hadr on db $DB"; fi
  db2_step src "rm -rf $DIR"
  atk_done "$id" "" "HADR stopped on both ends; the migration backups removed; $SRC stays for decommission"
}

# ---------------------------------------------------------------- db2-backup-restore (VM, or Amazon RDS for Db2)

rds_ctx() {
  EP="$(set_need "$1" rds_endpoint)"
  PORT="$(set_need "$1" rds_port)"
  RUSER="$(set_need "$1" rds_user)"
  BUCKET="$(set_need "$1" s3_bucket)"
  PREFIX="$(set_need "$1" s3_prefix)"
}
# rds_call SQL: run statements on RDS's rdsadmin database from the source host's Db2 client; the master password goes on stdin.
rds_call() {
  local pw
  if [[ "$(db2_read src 'db2 list node directory')" != *ATKRDS* ]]; then
    db2_step src "db2 catalog tcpip node ATKRDS remote $EP server $PORT && db2 catalog db rdsadmin as ATKRDSA at node ATKRDS && db2 terminate"
  fi
  secret_for pw DB2_RDS_MASTER_PASSWORD "$ID"
  ( export ATK_STDIN="$(printf 'connect to ATKRDSA user %s using %s;\n%s\nconnect reset;\n' "$RUSER" "$pw" "$1")"; db2_step src 'db2 +p -t' ATK_STDIN )
}
rds_upload() { db2_step src "aws s3 sync $DIR/$1 s3://$BUCKET/$PREFIX/$1/"; }
br_state() { atk_ids_get db2-backup-restore "$1.$2" 2> /dev/null || true; }
br_prepare() {
  local id="$1" st inst
  need_archive "$id"
  if [[ "$KIND" == rds ]]; then
    rds_ctx "$id"
    atk_need aws
    inst="$(set_need "$id" rds_instance)"
    st="$(aws rds describe-db-instances --db-instance-identifier "$inst" --query 'DBInstances[0].DBInstanceStatus' --output text 2> /dev/null || true)"
    [[ "$st" == available ]] || atk_fail "$id" "the RDS for Db2 instance is not available ($\{st:-not found}): the wave's Terraform builds it with the S3 integration role"
    atk_done "$id" prepared "RDS for Db2 available; backups go to s3://$BUCKET/$PREFIX through $DIR on $SRC"
  fi
  [[ -n "$(db2_read tgt 'db2level')" ]] || atk_fail "$id" "no Db2 instance answers on $TGT as $INST"
  atk_done "$id" prepared "archive logging on; $TGT answers; backups go to $DIR (visible on both hosts)"
}
br_replicate() {
  local id="$1"
  need_archive "$id"
  if [[ "$(br_state "$id" cutover)" == done ]]; then atk_skip "$id" "cut over" cut-over; fi
  seed_backup
  if [[ "$KIND" == rds ]]; then
    rds_ctx "$id"
    if [[ "$(br_state "$id" restored)" != yes ]]; then
      rds_upload seed
      rds_call "call rdsadmin.restore_database(?, '$DB', '$BUCKET', '$PREFIX/seed/', $SEED_TS, 'ONLINE');"
      atk_ids_put db2-backup-restore "$id.restored" yes
    fi
    ship_logs
    rds_upload logs
    rds_call "call rdsadmin.rollforward_database(?, '$DB', '$BUCKET', '$PREFIX/logs/', 'END_OF_LOG', 'FALSE');"
    atk_done "$id" in-sync "RDS for Db2 restored and rolled forward to the last shipped log" inSync=true
  fi
  if ! rf_pending tgt; then db2_step tgt "db2 restore db $DB from $DIR/seed taken at $SEED_TS replace history file without prompting"; fi
  ship_logs
  db2_step tgt "db2 rollforward db $DB to end of logs overflow log path ($DIR/logs)"
  atk_done "$id" in-sync "restored on $TGT and rolled forward to the last shipped log" inSync=true
}
br_status() {
  local id="$1" last
  if [[ "$(br_state "$id" cutover)" == done ]]; then atk_skip "$id" "cut over"; fi
  if [[ "$KIND" == rds ]]; then
    if [[ "$(br_state "$id" restored)" == yes ]]; then atk_done "$id" in-sync "restored on RDS; logs are applied at each replicate" inSync=true; fi
    atk_done "$id" "" "not restored yet" inSync=false
  fi
  if rf_pending tgt; then
    last="$(db2_read tgt "db2 rollforward db $DB query status" | awk -F'= ' '/Last committed transaction/ && !f { print $2; f = 1 }')"
    atk_done "$id" in-sync "rollforward pending on $TGT; last committed transaction $\{last:-unknown}" inSync=true
  fi
  atk_done "$id" "" "no restored copy on $TGT yet" inSync=false
}
br_test() { atk_skip "$1" "a copy in rollforward cannot be opened without ending the rollforward: rehearse on a non-production system (runbook)"; }
br_test_cleanup() { atk_skip "$1" "no test copy to remove"; }
br_cutover() {
  local id="$1"
  need_archive "$id"
  if [[ "$(br_state "$id" cutover)" == done ]]; then atk_skip "$id" "the target is rolled forward and open" cut-over; fi
  quiesce
  ship_logs
  if [[ "$KIND" == rds ]]; then
    rds_ctx "$id"
    rds_upload logs
    rds_call "call rdsadmin.rollforward_database(?, '$DB', '$BUCKET', '$PREFIX/logs/', 'END_OF_LOG', 'FALSE');"
    rds_call "call rdsadmin.complete_rollforward(?, '$DB');"
  else
    db2_step tgt "db2 rollforward db $DB to end of logs and complete overflow log path ($DIR/logs)"
  fi
  atk_ids_put db2-backup-restore "$id.cutover" done
  atk_done "$id" cut-over "last logs applied and the rollforward completed; the source is quiesced (rollback releases it)"
}
br_commit() { atk_done "$1" "" "committed: the source stays quiesced until decommission"; }
br_rollback() {
  local id="$1"
  if ! unquiesce; then atk_skip "$id" "the source is not quiesced: it takes the writes" "" replication=lost; fi
  if [[ "$(br_state "$id" cutover)" == done ]]; then atk_ids_put db2-backup-restore "$id.cutover" rolled-back; fi
  atk_done "$id" "" "the source is released; writes on the target since the cutover are not copied back" replication=lost
}
br_finalize() {
  local id="$1" n=0
  if [[ -n "$(db2_read src "ls -d $DIR 2> /dev/null")" ]]; then db2_step src "rm -rf $DIR"; n=1; fi
  if [[ "$KIND" == rds ]]; then
    rds_ctx "$id"
    atk_need aws
    if [[ -n "$(aws s3 ls "s3://$BUCKET/$PREFIX/" 2> /dev/null || true)" ]]; then atk_run aws s3 rm --recursive "s3://$BUCKET/$PREFIX/"; n=1; fi
    if [[ "$(db2_read src 'db2 list node directory')" == *ATKRDS* ]]; then db2_step src 'db2 uncatalog db ATKRDSA; db2 uncatalog node ATKRDS; db2 terminate'; n=1; fi
  fi
  if (( n == 0 )); then atk_skip "$id" "the migration backups and catalog entries are already removed"; fi
  atk_done "$id" "" "migration backups (and the S3 copies, catalog entries) removed"
}
`;

const DB2: Family = {
  id: 'db2',
  paths: ['db2-backup-restore', 'db2-hadr'],
  file: DB2_FILE,
  summary: 'Db2: HADR to a rebuilt VM (db2-hadr), or an online backup plus the log chain to a VM or Amazon RDS for Db2 (db2-backup-restore).',
  commands: HOST_COMMANDS,
  needs: [...HOST_NEEDS, { kind: 'command', name: 'jq', min: '1.6', why: 'Db2: reading the Ansible results' }],
  specs: [
    { key: 'database', about: 'the database name (8 characters at most)' },
    { key: 'instance', about: 'the instance owner on both hosts (the db2setup default is db2inst1)' },
    { key: 'source_host', about: 'the source database host in the Ansible inventory' },
    { key: 'target_host', about: 'the target VM in the Ansible inventory (VM targets)' },
    { key: 'target', about: 'vm, or rds (Amazon RDS for Db2)' },
    { key: 'backup_dir', about: 'a directory for the backup images and shipped logs: shared by both hosts for a VM target; local on the source for RDS' },
    { key: 'hadr_source_addr', about: 'HADR: the source address (IPv6 accepted)', paths: ['db2-hadr'] },
    { key: 'hadr_target_addr', about: 'HADR: the target address', paths: ['db2-hadr'] },
    { key: 'hadr_port', about: 'HADR: the service port on both hosts', paths: ['db2-hadr'] },
    { key: 'hadr_syncmode', about: 'HADR: ASYNC (default across sites), NEARSYNC or SUPERASYNC', paths: ['db2-hadr'] },
    { key: 'rds_instance', about: 'RDS: the DB instance identifier', paths: ['db2-backup-restore'] },
    { key: 'rds_endpoint', about: 'RDS: the endpoint address', paths: ['db2-backup-restore'] },
    { key: 'rds_port', about: 'RDS: the port', paths: ['db2-backup-restore'] },
    { key: 'rds_user', about: 'RDS: the master user', paths: ['db2-backup-restore'] },
    { key: 's3_bucket', about: 'RDS: the bucket the backups and logs go through', paths: ['db2-backup-restore'] },
    { key: 's3_prefix', about: 'RDS: the prefix in the bucket', paths: ['db2-backup-restore'] },
  ],
  rows: (items, ctx) => items.map((item) => {
    const h = hostsOf(item, ctx);
    const rds = serviceOf(item) === 'aws-rds-db2';
    const name = item.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return {
      item,
      values: {
        database: name.length >= 1 && name.length <= 8 ? name : undefined,
        instance: 'db2inst1',
        source_host: h.src,
        target_host: rds ? undefined : h.tgt,
        target: rds ? 'rds' : 'vm',
        backup_dir: undefined,
        ...(item.path === 'db2-hadr' ? { hadr_source_addr: h.addr, hadr_target_addr: h.tgt, hadr_port: '55001', hadr_syncmode: 'ASYNC' } : {}),
        ...(rds ? { rds_instance: undefined, rds_endpoint: undefined, rds_port: '50000', rds_user: undefined, s3_bucket: undefined, s3_prefix: item.resource } : {}),
      },
    };
  }),
  sh: DB2_SH,
  verbs: everyVerb(dispatch({ 'db2-hadr': 'hadr' }, 'br', 'db2_ctx')),
  usesHostStep: true,
  readme: {
    title: 'Db2 (db2-hadr, db2-backup-restore)',
    intro: [
      'The Db2 commands run on the database hosts as the instance owner through the project\'s Ansible inventory (reads ad hoc, changes through `ansible/host-step.yml`). Archive logging (LOGARCHMETH1) must be on at the source.',
      '**db2-hadr** (VM to VM): an online backup restored on the target (rollforward pending), HADR configured on both ends (`HADR_TARGET_LIST` with IPv6 in brackets), `start hadr as standby` / `as primary`; the cutover is a graceful `takeover hadr`, so the source becomes the standby: the way back.',
      '**db2-backup-restore**: the online backup with its logs restored on the target, then the archived logs shipped and rolled forward at each replicate; the cutover quiesces the source, ships the last logs and completes the rollforward. To Amazon RDS for Db2 the images and logs go through S3 (`rdsadmin.restore_database`, `rollforward_database`, `complete_rollforward`), called from the source host\'s Db2 client.',
    ],
    verbs: [
      '`prepare`: HADR: the seed backup restored on the target; backup and restore: the checks (RDS: the instance available).',
      '`replicate`: HADR: configured and started, waits for PEER; backup and restore: the seed restored, logs shipped and applied.',
      '`status`: HADR state and log gap; backup and restore: the last committed transaction of the copy.',
      '`test` / `test-cleanup`: no test copy (a standby or a rollforward-pending copy is not open): rehearse on non-production.',
      '`cutover`: HADR: `takeover hadr` on the target; backup and restore: source quiesced, last logs, rollforward completed.',
      '`commit`: records the point of no return.',
      '`rollback`: HADR: `takeover hadr` back on the source; backup and restore: the source released (target writes are lost).',
      '`finalize`: HADR stopped on both ends; the migration backups (and S3 copies, catalog entries) removed.',
    ],
    credentials: ['`DB2_RDS_MASTER_PASSWORD` (RDS only): the master user\'s password, sent to the Db2 CLP on stdin (`db2 +p -t`).'],
    environment: ['`ATK_INVENTORY`: the Ansible inventory (default `ansible/inventory` of the project).', 'RDS: the AWS CLI on the source host (with a role allowed to write the bucket) for `aws s3 sync`; the AWS CLI on the controller for the checks.'],
    runbook: ['Turning archive logging on (an offline backup).', 'Log shipping from TSM or vendor archiving.', 'A forced takeover (`takeover hadr … by force`) when the target is lost.'],
    unconfirmed: [
      'The argument order of `rdsadmin.restore_database`, `rdsadmin.rollforward_database` and `rdsadmin.complete_rollforward` (checked against the RDS for Db2 guide before use).',
      '"Database status = Quiesced" in `db2 get snapshot for database` as the quiesce check.',
    ],
  },
  findings: (items, ctx) => [
    ...noReverse(items, ['db2-backup-restore'], DB2_FILE, 'backup and restore'),
    ...unknownSettings(DB2.rows(items, ctx), ['database', 'backup_dir', 'rds_instance', 'rds_endpoint', 'rds_user', 's3_bucket'], DB2_FILE),
  ],
};

// ---------------------------------------------------------------------------
// SAP ASE: dump and load, then the transaction dumps
// ---------------------------------------------------------------------------

const ASE_FILE = `${DB_DIR}/ase/ase.sh`;

const ASE_SH = code`
ase_ctx() {
  DB="$(set_need "$1" database)"
  OSU="$(set_need "$1" os_user)"
  LOGIN="$(set_need "$1" login)"
  SRC="$(set_need "$1" source_host)"
  TGT="$(set_need "$1" target_host)"
  SRV_S="$(set_need "$1" source_server)"
  SRV_T="$(set_need "$1" target_server)"
  PRE="$(set_need "$1" dump_dir)"
  PRE="$PRE/$(atk_name "$1")"
  local c
  ase_input c src ''
  ase_input c tgt ''
}
ase_host() { if [[ "$1" == src ]]; then printf '%s' "$SRC"; else printf '%s' "$TGT"; fi; }
ase_srv() { if [[ "$1" == src ]]; then printf '%s' "$SRV_S"; else printf '%s' "$SRV_T"; fi; }
# ase_input VAR SIDE SQL: isql's stdin: the login's password first (isql reads it there), then the batch and go.
ase_input() {
  local pw side=SOURCE
  if [[ "$2" == tgt ]]; then side=TARGET; fi
  secret_for pw "ASE_$\{side}_PASSWORD" "$ID"
  printf -v "$1" '%s\n%s\ngo\n' "$pw" "$3"
}
ase_read() {
  local input
  ase_input input "$1" "$2"
  ( export ATK_STDIN="$input"; host_read "$(ase_host "$1")" "$OSU" "isql -U $LOGIN -S $(ase_srv "$1") -b -w 999" ATK_STDIN )
}
ase_do() {
  local input
  ase_input input "$1" "$2"
  ( export ATK_STDIN="$input"; host_step "$(ase_host "$1")" "$OSU" "isql -U $LOGIN -S $(ase_srv "$1") -b -w 999 --retserverror" ATK_STDIN )
}
st() { atk_ids_get ase-dump-load "$ID.$1" 2> /dev/null || true; }
tran_next() { local n; n="$(st trans)"; printf '%s' "$(( $\{n:-0} + 1 ))"; }
# ship_tran [final]: the next transaction dump from the source, loaded on the target.
ship_tran() {
  local n f
  n="$(tran_next)"
  f="$\{PRE}_tran_$n.trn"
  ase_do src "dump transaction $DB to '$f'$\{1:+ with standby_access}"
  ase_do tgt "load transaction $DB from '$f'"
  atk_ids_put ase-dump-load "$ID.trans" "$n"
}
ase_prepare() {
  local id="$1" dbid
  [[ "$(ase_read src 'select @@version')" == *Adaptive* ]] || atk_fail "$id" "the source ASE $SRV_S does not answer on $SRC"
  dbid="$(ase_read tgt "select db_id('$DB')" | tr -d '[:space:]')"
  [[ "$dbid" =~ ^[0-9]+$ ]] || atk_fail "$id" "database $DB does not exist on $SRV_T: create it FOR LOAD with the source's layout (sp_helpdb $DB on the source; runbook)"
  atk_done "$id" prepared "both servers answer; $DB exists on $SRV_T; dumps go to $PRE* (visible on both hosts)"
}
ase_replicate() {
  local id="$1"
  if [[ "$(st cutover)" == done ]]; then atk_skip "$id" "cut over" cut-over; fi
  if [[ "$(st full)" != loaded ]]; then
    if [[ -z "$(host_read "$SRC" "$OSU" "ls -1 $\{PRE}_full.dmp 2> /dev/null")" ]]; then ase_do src "dump database $DB to '$\{PRE}_full.dmp' with compression = 100"; fi
    ase_do tgt "load database $DB from '$\{PRE}_full.dmp'"
    atk_ids_put ase-dump-load "$id.full" loaded
  fi
  ship_tran
  atk_done "$id" in-sync "the full dump and $(st trans) transaction dumps loaded on $SRV_T (offline until cutover)" inSync=true
}
ase_status() {
  local id="$1"
  if [[ "$(st cutover)" == done ]]; then atk_skip "$id" "cut over"; fi
  if [[ "$(st full)" == loaded ]]; then atk_done "$id" in-sync "loaded through transaction dump $(st trans)" inSync=true; fi
  atk_done "$id" "" "no dump loaded yet" inSync=false
}
ase_test() { atk_skip "$1" "a database in a load sequence cannot be opened without ending it (online database): rehearse on a non-production system (runbook)"; }
ase_test_cleanup() { atk_skip "$1" "no test copy to remove"; }
ase_cutover() {
  local id="$1"
  if [[ "$(st cutover)" == done ]]; then atk_skip "$id" "the target database is online" cut-over; fi
  [[ "$(st full)" == loaded ]] || atk_fail "$id" "no full dump loaded: run replicate first"
  ship_tran final
  ase_do tgt "online database $DB"
  atk_ids_put ase-dump-load "$id.cutover" done
  atk_done "$id" cut-over "the last transaction dump loaded and $DB online on $SRV_T"
}
ase_commit() { atk_done "$1" "" "committed: the source database stays until decommission"; }
ase_rollback() {
  if [[ "$(st cutover)" == done ]]; then atk_ids_put ase-dump-load "$1.cutover" rolled-back; fi
  atk_skip "$1" "the source was only dumped: it takes the writes again after the unfreeze; writes on the target since the cutover are not copied back" "" replication=lost
}
ase_finalize() {
  local id="$1"
  if [[ -z "$(host_read "$SRC" "$OSU" "ls -1 $\{PRE}_* 2> /dev/null")" ]]; then atk_skip "$id" "the dump files are already removed"; fi
  host_step "$SRC" "$OSU" "rm -f $\{PRE}_*"
  atk_done "$id" "" "dump files removed"
}
`;

const ASE: Family = {
  id: 'ase',
  paths: ['ase-dump-load'],
  file: ASE_FILE,
  summary: 'SAP ASE: dump database and load it on the rebuilt VM, then the transaction dumps; online database at cutover.',
  commands: HOST_COMMANDS,
  needs: [...HOST_NEEDS, { kind: 'command', name: 'jq', min: '1.6', why: 'SAP ASE: reading the Ansible results' }],
  specs: [
    { key: 'database', about: 'the database to move' },
    { key: 'os_user', about: 'the OS user that runs isql with the ASE environment (the installer default is sybase)' },
    { key: 'login', about: 'the ASE login (sa, or one with dump and load rights)' },
    { key: 'source_host', about: 'the source host in the Ansible inventory' },
    { key: 'target_host', about: 'the target VM in the Ansible inventory' },
    { key: 'source_server', about: 'the source ASE server name (interfaces / sql.ini)' },
    { key: 'target_server', about: 'the target ASE server name' },
    { key: 'dump_dir', about: 'a directory both servers see for the dump files' },
  ],
  rows: (items, ctx) => items.map((item) => {
    const h = hostsOf(item, ctx);
    return { item, values: { database: item.name, os_user: 'sybase', login: 'sa', source_host: h.src, target_host: h.tgt, source_server: undefined, target_server: undefined, dump_dir: undefined } };
  }),
  sh: ASE_SH,
  verbs: everyVerb(dispatch({}, 'ase', 'ase_ctx')),
  usesHostStep: true,
  readme: {
    title: 'SAP ASE (ase-dump-load)',
    intro: [
      'isql runs on the database hosts as the ASE OS user through the project\'s Ansible inventory; the login\'s password is the first line of isql\'s stdin, never an argument.',
      'The target database is created **for load** with the source\'s layout (sp_helpdb on the source) by the rebuild. The full dump is loaded at replicate, then each replicate dumps and loads the next transaction dump (the log must not be truncated on checkpoint); the cutover loads the last one and brings the database online.',
      'SAP ASE 16.0 leaves mainstream maintenance at the end of 2027 (SAP note 1922006).',
    ],
    verbs: [
      '`prepare`: both servers answer; the target database exists.',
      '`replicate`: the full dump loaded once, then one transaction dump per run.',
      '`status`: the last transaction dump loaded.',
      '`test` / `test-cleanup`: no test copy (a database in a load sequence is not open).',
      '`cutover`: the last transaction dump (with standby_access), then `online database`.',
      '`commit`: records the point of no return.',
      '`rollback`: nothing to undo on the source (it was only dumped); target writes since the cutover are lost.',
      '`finalize`: the dump files removed.',
    ],
    credentials: ['`ASE_SOURCE_PASSWORD`, `ASE_TARGET_PASSWORD`: the login\'s password on each server, sent on isql\'s stdin.'],
    environment: ['`ATK_INVENTORY`: the Ansible inventory (default `ansible/inventory` of the project).'],
    runbook: ['Creating the target database for load with the source\'s device layout.'],
    unconfirmed: ['isql reading the password from the first line of a non-terminal stdin.', '`with compression = 100` on dump database.'],
  },
  findings: (items, ctx) => [...noReverse(items, ['ase-dump-load'], ASE_FILE, 'dump and load'), ...unknownSettings(ASE.rows(items, ctx), ['source_server', 'target_server', 'dump_dir'], ASE_FILE)],
};

// ---------------------------------------------------------------------------
// Informix: ontape level-0 archive, continuous log restore
// ---------------------------------------------------------------------------

const IFX_FILE = `${DB_DIR}/informix/informix.sh`;

const IFX_SH = code`
ifx_ctx() {
  OSU="$(set_need "$1" os_user)"
  SRC="$(set_need "$1" source_host)"
  TGT="$(set_need "$1" target_host)"
  SRV_S="$(set_need "$1" source_server)"
  SRV_T="$(set_need "$1" target_server)"
  PRE="$(set_need "$1" archive_dir)"
  PRE="$PRE/$(atk_name "$1")"
}
ifx_host() { if [[ "$1" == src ]]; then printf '%s' "$SRC"; else printf '%s' "$TGT"; fi; }
ifx_srv() { if [[ "$1" == src ]]; then printf '%s' "$SRV_S"; else printf '%s' "$SRV_T"; fi; }
ifx_read() { host_read "$(ifx_host "$1")" "$OSU" "export INFORMIXSERVER=$(ifx_srv "$1"); $2"; }
ifx_do() { host_step "$(ifx_host "$1")" "$OSU" "export INFORMIXSERVER=$(ifx_srv "$1"); $2"; }
# ifx_mode SIDE: the server mode from onstat - (On-Line, Quiescent, Off-Line, Fast Recovery, ...).
ifx_mode() { ifx_read "$1" 'onstat -' | sed -n 's/.*-- *\([A-Za-z][A-Za-z -]*[a-z]\) *--.*/\1/p' | awk 'NR == 1'; }
ifx_version() { ifx_read "$1" 'onstat -' | sed -n 's/.*Version \([^ ]*\).*/\1/p' | awk 'NR == 1'; }
st() { atk_ids_get informix-backup-restore "$ID.$1" 2> /dev/null || true; }
ship_logs() {
  ifx_do src 'ontape -a -d'
  ifx_do tgt 'ontape -l -C -d'
}
ifx_prepare() {
  local id="$1" vs vt
  vs="$(ifx_version src)"
  vt="$(ifx_version tgt)"
  [[ -n "$vs" && -n "$vt" ]] || atk_fail "$id" "onstat does not answer on $SRC ($SRV_S) or $TGT ($SRV_T)"
  [[ "$vs" == "$vt" ]] || atk_fail "$id" "a physical restore needs the same Informix version on both ends (source $vs, target $vt)"
  atk_done "$id" prepared "Informix $vs on both ends; archives go to $PRE* (visible on both hosts); logical logs from the source's LTAPEDEV directory"
}
ifx_replicate() {
  local id="$1"
  if [[ "$(st cutover)" == done ]]; then atk_skip "$id" "cut over" cut-over; fi
  if [[ "$(st seed)" != restored ]]; then
    if [[ -z "$(host_read "$SRC" "$OSU" "ls -1 $\{PRE}_L0 2> /dev/null")" ]]; then ifx_do src "ontape -s -L 0 -t STDIO > $\{PRE}_L0"; fi
    if ifx_running; then ifx_do tgt 'onmode -ky'; fi
    ifx_do tgt "ontape -p -t STDIO < $\{PRE}_L0"
    atk_ids_put informix-backup-restore "$id.seed" restored
  fi
  ship_logs
  atk_done "$id" in-sync "level-0 restored on $SRV_T; logical logs applied (continuous log restore)" inSync=true
}
ifx_status() {
  local id="$1"
  if [[ "$(st cutover)" == done ]]; then atk_skip "$id" "cut over"; fi
  if [[ "$(st seed)" == restored ]]; then atk_done "$id" in-sync "in continuous log restore on $SRV_T ($(ifx_mode tgt))" inSync=true; fi
  atk_done "$id" "" "no archive restored yet" inSync=false
}
ifx_test() { atk_skip "$1" "a server in logical restore cannot be opened without ending it: rehearse on a non-production system (runbook)"; }
ifx_test_cleanup() { atk_skip "$1" "no test copy to remove"; }
ifx_cutover() {
  local id="$1"
  if [[ "$(st cutover)" == done ]] && [[ "$(ifx_mode tgt)" == On-Line ]]; then atk_skip "$id" "the target is on-line" cut-over; fi
  [[ "$(st seed)" == restored ]] || atk_fail "$id" "no archive restored: run replicate first"
  ifx_do src 'onmode -l && ontape -a -d'
  ifx_do tgt 'ontape -l -d && onmode -m'
  atk_wait_until 15 20 ifx_online || atk_fail "$id" "the target did not come on-line"
  atk_ids_put informix-backup-restore "$id.cutover" done
  atk_done "$id" cut-over "the last logical logs applied and $SRV_T on-line"
}
ifx_online() { [[ "$(ifx_mode tgt)" == On-Line ]]; }
ifx_running() { local m; m="$(ifx_mode tgt)"; [[ -n "$m" && "$m" != Off-Line ]]; }
ifx_commit() { atk_done "$1" "" "committed: the source server stays until decommission"; }
ifx_rollback() {
  if [[ "$(st cutover)" == done ]]; then atk_ids_put informix-backup-restore "$1.cutover" rolled-back; fi
  atk_skip "$1" "the source was only archived: it takes the writes again after the unfreeze; writes on the target since the cutover are not copied back" "" replication=lost
}
ifx_finalize() {
  local id="$1"
  if [[ -z "$(host_read "$SRC" "$OSU" "ls -1 $\{PRE}_* 2> /dev/null")" ]]; then atk_skip "$id" "the archive files are already removed"; fi
  host_step "$SRC" "$OSU" "rm -f $\{PRE}_*"
  atk_done "$id" "" "archive files removed"
}
`;

const IFX: Family = {
  id: 'informix',
  paths: ['informix-backup-restore'],
  file: IFX_FILE,
  summary: 'Informix: an ontape level-0 archive restored on the rebuilt VM, the logical logs applied in continuous log restore; the last logs and on-line at cutover.',
  commands: HOST_COMMANDS,
  needs: [...HOST_NEEDS, { kind: 'command', name: 'jq', min: '1.6', why: 'Informix: reading the Ansible results' }],
  specs: [
    { key: 'os_user', about: 'the OS user with the Informix environment (informix)' },
    { key: 'source_host', about: 'the source host in the Ansible inventory' },
    { key: 'target_host', about: 'the target VM in the Ansible inventory' },
    { key: 'source_server', about: 'the source INFORMIXSERVER' },
    { key: 'target_server', about: 'the target INFORMIXSERVER (configured like the source: same chunks and paths)' },
    { key: 'archive_dir', about: 'a directory both hosts see for the level-0 archive; LTAPEDEV on both must point at one shared log directory' },
  ],
  rows: (items, ctx) => items.map((item) => {
    const h = hostsOf(item, ctx);
    return { item, values: { os_user: 'informix', source_host: h.src, target_host: h.tgt, source_server: undefined, target_server: undefined, archive_dir: undefined } };
  }),
  sh: IFX_SH,
  verbs: everyVerb(dispatch({}, 'ifx', 'ifx_ctx')),
  usesHostStep: true,
  readme: {
    title: 'Informix (informix-backup-restore)',
    intro: [
      'ontape and onmode run on the hosts as the Informix user through the project\'s Ansible inventory. The target server is installed and configured like the source (same version, chunks and paths) by the rebuild; LTAPEDEV on both ends points at one shared log directory.',
      'Replicate archives the source (level 0, to a file through STDIO) once, restores it physically on the target, then backs up the source\'s logical logs and applies them in continuous log restore at each run; the cutover applies the last logs, ends the logical restore and brings the target on-line.',
      'Informix 14.10 support ends 2028-03-31 (IIUG).',
    ],
    verbs: [
      '`prepare`: the same version on both ends.',
      '`replicate`: the level-0 archive restored once, then the logical logs.',
      '`status`: whether the target is in continuous log restore.',
      '`test` / `test-cleanup`: no test copy (a server in logical restore is not open).',
      '`cutover`: `onmode -l`, the last logical log backup, `ontape -l` to end the restore, `onmode -m`.',
      '`commit`: records the point of no return.',
      '`rollback`: nothing to undo on the source; target writes since the cutover are lost.',
      '`finalize`: the archive files removed.',
    ],
    credentials: ['None: ontape and onmode run as the Informix OS user on each host (the inventory\'s connection user needs sudo to it).'],
    environment: ['`ATK_INVENTORY`: the Ansible inventory (default `ansible/inventory` of the project).'],
    unconfirmed: ['`ontape -p -t STDIO` restoring without prompts, and `ontape -l -C -d` / `ontape -a -d` running without prompts.'],
  },
  findings: (items, ctx) => [...noReverse(items, ['informix-backup-restore'], IFX_FILE, 'backup and restore'), ...unknownSettings(IFX.rows(items, ctx), ['source_server', 'target_server', 'archive_dir'], IFX_FILE)],
};

// ---------------------------------------------------------------------------
// MongoDB: mongosync (mongomirror reached end of life 2025-07-31)
// ---------------------------------------------------------------------------

const MONGO_FILE = `${DB_DIR}/mongo/mongo.sh`;

const MONGO_SH = code`
ms_ctx() { MPORT="$(set_need "$1" port)"; }
ms_api() { curl -sS --fail --max-time 30 "http://localhost:$MPORT/api/v1/$1" 2> /dev/null || true; }
ms_post() { printf '%s' "$2" | atk_run curl -sS --fail --max-time 120 -X POST -H 'Content-Type: application/json' --data-binary @- "http://localhost:$MPORT/api/v1/$1"; }
ms_field() { jq -r ".progress.$1 // empty" <<< "$(ms_api progress)" 2> /dev/null || true; }
ms_up() { [[ -n "$(ms_api progress)" ]]; }
ms_can_commit() { [[ "$(ms_field canCommit)" == true ]]; }
ms_is() { [[ "$(ms_field state)" == "$1" ]]; }
ms_pid() { pgrep -f -- "mongosync .*--port $MPORT" 2> /dev/null | awk 'NR == 1' || true; }
# ms_start ID: mongosync in the background on this controller; the connection strings go in a mode-600 runtime file it reads at start.
ms_start() {
  local id="$1" src tgt cfg logs
  secret_for src MONGO_SOURCE_URI "$id"
  secret_for tgt MONGO_TARGET_URI "$id"
  atk_tmpfile cfg
  printf 'cluster0: "%s"\ncluster1: "%s"\n' "$\{src//\"/\\\"}" "$\{tgt//\"/\\\"}" > "$cfg"
  logs="$ATK_STATUS/mongosync/$(atk_name "$id")"
  atk_run mkdir -p "$logs"
  atk_run nohup mongosync --config "$cfg" --port "$MPORT" --logPath "$logs" > /dev/null 2>&1 &
  atk_wait_until 3 5 ms_up || atk_fail "$id" "mongosync did not answer on port $MPORT (see $logs)"
}
mongo_prepare() {
  local id="$1"
  if ms_up; then atk_skip "$id" "mongosync answers on port $MPORT ($(ms_field state))" prepared; fi
  ms_start "$id"
  atk_done "$id" prepared "mongosync started on port $MPORT"
}
mongo_replicate() {
  local id="$1" state
  state="$(ms_field state)"
  case "$state" in
    "") atk_fail "$id" "mongosync does not answer on port $MPORT: run prepare" ;;
    COMMITTING|COMMITTED|REVERSING) atk_skip "$id" "cut over ($state)" cut-over ;;
    IDLE) ms_post start '{"source": "cluster0", "destination": "cluster1", "reversible": true, "enableUserWriteBlocking": true}' ;;
    PAUSED) ms_post resume '{}' ;;
    RUNNING) if ms_can_commit; then atk_skip "$id" "mongosync is running and can commit" in-sync inSync=true; fi ;;
  esac
  if atk_wait_until 1440 60 ms_can_commit; then atk_done "$id" in-sync "the initial copy is done and change events are applied" inSync=true lagSeconds="$(ms_field lagTimeSeconds)"; fi
  atk_done "$id" replicating "mongosync $(ms_field state): the initial copy continues" inSync=false
}
mongo_status() {
  local id="$1" state lag
  state="$(ms_field state)"
  lag="$(ms_field lagTimeSeconds)"
  case "$state" in
    "") atk_fail "$id" "mongosync does not answer on port $MPORT" inSync=false ;;
    COMMITTING|COMMITTED|REVERSING) atk_skip "$id" "cut over ($state)" ;;
    RUNNING) if ms_can_commit; then atk_done "$id" in-sync "mongosync RUNNING, can commit" inSync=true lagSeconds="$\{lag:-0}"; fi ;;
  esac
  atk_done "$id" replicating "mongosync $state" inSync=false lagSeconds="$\{lag:-0}"
}
mongo_test() { atk_skip "$1" "the destination is write-blocked until commit: test reads against it, or a copy restored elsewhere (runbook)"; }
mongo_test_cleanup() { atk_skip "$1" "no test copy to remove"; }
mongo_cutover() {
  local id="$1"
  if ms_is COMMITTED; then atk_skip "$id" "committed: the destination takes the writes" cut-over; fi
  if ! ms_is COMMITTING; then
    ms_is RUNNING || atk_fail "$id" "mongosync is not RUNNING ($(ms_field state)): run replicate"
    ms_can_commit || atk_fail "$id" "mongosync cannot commit yet: wait until status reports in-sync"
    ms_post commit '{}'
  fi
  atk_wait_until 60 15 ms_is COMMITTED || atk_fail "$id" "the commit has not finished (status reports it)"
  atk_done "$id" cut-over "committed: writes are allowed on the destination; point the applications at it"
}
mongo_commit() { atk_done "$1" "" "committed: the reversible sync can still reverse until finalize"; }
mongo_rollback() {
  local id="$1" state
  state="$(ms_field state)"
  if [[ "$(atk_ids_get mongo-mongosync "$id.reversed" 2> /dev/null || true)" == done ]]; then atk_skip "$id" "already reversed: the source takes the writes" "" replication=reverse; fi
  if [[ "$state" == COMMITTED && "$(atk_ids_get mongo-mongosync "$id.reversing" 2> /dev/null || true)" == yes ]]; then
    atk_ids_put mongo-mongosync "$id.reversed" done
    atk_skip "$id" "reversed and committed: the source takes the writes" "" replication=reverse
  fi
  case "$state" in
    RUNNING|IDLE|PAUSED) if [[ "$(atk_ids_get mongo-mongosync "$id.reversing" 2> /dev/null || true)" != yes ]]; then atk_skip "$id" "not cut over: the source still takes the writes" "" replication=kept; fi ;;
    COMMITTED) ms_post reverse '{}'; atk_ids_put mongo-mongosync "$id.reversing" yes ;;
    "") atk_fail "$id" "mongosync does not answer on port $MPORT" ;;
  esac
  atk_wait_until 240 30 ms_can_commit || atk_fail "$id" "the reverse sync has not caught up: run rollback again to continue"
  ms_post commit '{}'
  atk_wait_until 60 15 ms_is COMMITTED || atk_fail "$id" "the reverse commit has not finished: run rollback again"
  atk_ids_put mongo-mongosync "$id.reversed" done
  atk_done "$id" "" "reversed and committed: the source takes the writes again, with the target's writes" replication=reverse
}
mongo_finalize() {
  local id="$1" pid
  pid="$(ms_pid)"
  if [[ -z "$pid" ]]; then atk_skip "$id" "mongosync is not running"; fi
  atk_run kill "$pid"
  atk_done "$id" "" "mongosync stopped (its logs stay under status/mongosync)"
}
`;

const MONGO: Family = {
  id: 'mongo',
  paths: ['mongo-mongosync'],
  file: MONGO_FILE,
  summary: 'MongoDB: mongosync on the controller (reversible, with user write blocking); commit at cutover, reverse at rollback.',
  commands: ['mongosync', 'curl', 'jq'],
  needs: [
    { kind: 'command', name: 'mongosync', min: '1.9', why: 'mongo-mongosync: cluster-to-cluster sync (mongomirror reached end of life)', install: 'https://www.mongodb.com/docs/cluster-to-cluster-sync/current/installation/' },
    { kind: 'command', name: 'curl', why: 'mongo-mongosync: the mongosync HTTP API on localhost' },
  ],
  specs: [{ key: 'port', about: 'the local port of this item\'s mongosync API (one process per item)' }],
  rows: (items) => items.map((item, i) => ({ item, values: { port: String(27182 + i) } })),
  sh: MONGO_SH,
  verbs: everyVerb(dispatch({}, 'mongo', 'ms_ctx')),
  usesHostStep: false,
  readme: {
    title: 'MongoDB (mongo-mongosync)',
    intro: [
      'mongosync runs on the controller, one process per item, with its HTTP API on a local port. It starts **reversible** with user write blocking, so the cutover is a `commit` and a rollback after it is a `reverse` plus a `commit` the other way. mongomirror reached end of life on 2025-07-31.',
      'The targets: Azure DocumentDB (formerly Cosmos DB for MongoDB vCore), Oracle Database API for MongoDB on Autonomous Database, or MongoDB on VMs. DocumentDB on AWS moves with AWS DMS instead (WP-11d).',
    ],
    verbs: [
      '`prepare`: mongosync started (the connection strings in a mode-600 runtime file it reads at start).',
      '`replicate`: `POST /api/v1/start` (reversible, write blocking), waits for `canCommit`.',
      '`status`: state, `canCommit`, `lagTimeSeconds`.',
      '`test` / `test-cleanup`: no test copy (the destination is write-blocked until the commit).',
      '`cutover`: `POST /api/v1/commit`, waits for COMMITTED.',
      '`commit`: records the point of no return (reversal stays possible until finalize).',
      '`rollback`: after the commit: `POST /api/v1/reverse`, then a commit back; before it: nothing.',
      '`finalize`: mongosync stopped.',
    ],
    credentials: ['`MONGO_SOURCE_URI`, `MONGO_TARGET_URI`: the connection strings with their credentials (IPv6 hosts in brackets), written only to a mode-600 runtime file mongosync reads at start.'],
    runbook: ['Create the mongosync user roles on both clusters (the mongosync permissions page).', 'Atlas targets are report-only in the kit (live migration).'],
    unconfirmed: ['mongosync reading `cluster0` / `cluster1` from `--config` (YAML) while `--port` and `--logPath` are flags.', 'The start body `{"reversible": true, "enableUserWriteBlocking": true}` on the installed mongosync version.'],
  },
  findings: (items) => [info('exec.db.replication-credential', `${items.map((i) => i.name).join(', ')}: mongosync needs a user with its sync roles on both clusters; remove it after finalize.`, { path: MONGO_FILE })],
};

// ---------------------------------------------------------------------------
// Redis: REPLICAOF (VM targets), RDB import (managed caches)
// ---------------------------------------------------------------------------

const REDIS_FILE = `${DB_DIR}/redis/redis.sh`;

const REDIS_SH = code`
rd_ctx() {
  local v side
  SVC="$(set_get "$1" service)"
  for side in source $([[ "$\{ATK_ITEM_PATH[$1]}" == redis-replicaof ]] && printf target); do
    v="$(set_need "$1" "$\{side}_addr")"
    v="$(set_need "$1" "$\{side}_port")"
    rd_pw v "$side"
  done
}
# rd_opts VAR SIDE: redis-cli's connection options for the side.
rd_opts() {
  local -n _o="$1"
  local host port
  host="$(set_need "$ID" "$2_addr")"
  port="$(set_need "$ID" "$2_port")"
  _o=(-h "$host" -p "$port")
  if set_on "$ID" "$2_tls"; then
    _o+=(--tls)
    if [[ -n "$\{REDIS_CA_FILE:-}" ]]; then _o+=(--cacert "$REDIS_CA_FILE"); fi
  fi
}
rd_pw() { if [[ "$(set_get "$ID" "$2_auth")" != none ]]; then secret_for "$1" "REDIS_$\{2^^}_PASSWORD" "$ID"; else printf -v "$1" '%s' ''; fi; }
# rc SIDE ARGS...: a read with redis-cli (the password in REDISCLI_AUTH, never an argument).
rc() {
  local side="$1" pw
  local -a o=()
  shift
  rd_opts o "$side"
  rd_pw pw "$side"
  REDISCLI_AUTH="$pw" redis-cli "$\{o[@]}" "$@" 2> /dev/null | tr -d '\r' || true
}
# rc_do SIDE ARGS...: a change with redis-cli (printed instead in a dry run); with no ARGS the commands come on stdin.
rc_do() {
  local side="$1" pw
  local -a o=()
  shift
  rd_opts o "$side"
  rd_pw pw "$side"
  ( export REDISCLI_AUTH="$pw"; atk_run redis-cli "$\{o[@]}" "$@" )
}
info_field() { rc "$1" INFO "$2" | awk -F: -v k="$3" '$1 == k && !f { print $2; f = 1 }'; }
rd_quote() { local s="$1"; s="$\{s//\\/\\\\}"; s="$\{s//\"/\\\"}"; printf '"%s"' "$s"; }
# masterauth SIDE FROM: the side's masterauth set to FROM's password (sent on stdin) unless it already is.
masterauth() {
  local pw now
  [[ "$(set_get "$ID" "$2_auth")" != none ]] || return 0
  secret_for pw "REDIS_$\{2^^}_PASSWORD" "$ID"
  now="$(rc "$1" CONFIG GET masterauth | awk 'NR == 2')"
  if [[ "$now" != "$pw" ]]; then printf 'CONFIG SET masterauth %s\n' "$(rd_quote "$pw")" | rc_do "$1"; fi
}
replica_of() { # SIDE OTHER: SIDE replicates from OTHER, the link is up and the initial sync is done
  [[ "$(info_field "$1" replication role)" == slave && "$(info_field "$1" replication master_host)" == "$(set_get "$ID" "$2_addr")" \
    && "$(info_field "$1" replication master_link_status)" == up && "$(info_field "$1" replication master_sync_in_progress)" == 0 ]]
}
is_master() { [[ "$(info_field "$1" replication role)" == master ]]; }
caught_up() { # REPLICA MASTER: the replica's offset equals the master's
  local a b
  a="$(info_field "$2" replication master_repl_offset)"
  b="$(info_field "$1" replication slave_repl_offset)"
  [[ -n "$a" && "$a" == "$b" ]]
}

# ---------------------------------------------------------------- redis-replicaof (a target on a VM)

ro_prepare() {
  local id="$1" vs vt
  [[ "$(rc source PING)" == PONG ]] || atk_fail "$id" "the source does not answer PING"
  [[ "$(rc target PING)" == PONG ]] || atk_fail "$id" "the target does not answer PING"
  vs="$(info_field source server redis_version)"
  vt="$(info_field target server redis_version)"
  [[ "$(printf '%s\n%s\n' "$vs" "$vt" | sort -V | awk 'NR == 1')" == "$vs" ]] || atk_fail "$id" "the target Redis ($vt) is older than the source ($vs)"
  masterauth target source
  atk_done "$id" prepared "both answer; Redis $vs to $vt; the target's masterauth is set"
}
ro_replicate() {
  local id="$1"
  if is_master target && replica_of source target; then atk_skip "$id" "cut over: the source replicates from the target" cut-over; fi
  if replica_of target source; then atk_skip "$id" "the target replicates from the source (link up, synced)" in-sync inSync=true; fi
  masterauth target source
  if [[ "$(info_field target replication master_host)" != "$(set_need "$id" source_addr)" ]]; then
    rc_do target REPLICAOF "$(set_need "$id" source_addr)" "$(set_need "$id" source_port)"
  fi
  if atk_wait_until 720 30 replica_of target source; then atk_done "$id" in-sync "the target replicates from the source" inSync=true; fi
  atk_done "$id" replicating "the initial sync continues (status polls it)" inSync=false
}
ro_status() {
  local id="$1"
  if is_master target && replica_of source target; then atk_skip "$id" "cut over: the source replicates from the target (the way back)"; fi
  if replica_of target source; then atk_done "$id" in-sync "link up, synced" inSync=true; fi
  if [[ "$(info_field target replication role)" == slave ]]; then atk_done "$id" replicating "link $(info_field target replication master_link_status)" inSync=false; fi
  atk_done "$id" "" "the target does not replicate from the source" inSync=false
}
ro_test() { atk_skip "$1" "a replica is read-only: test reads against it (runbook)"; }
ro_test_cleanup() { atk_skip "$1" "no test copy to remove"; }
ro_cutover() {
  local id="$1"
  if is_master target && replica_of source target; then atk_skip "$id" "the target is the master and the source replicates from it" cut-over; fi
  if ! is_master target; then
    replica_of target source || atk_fail "$id" "the target is not synced from the source: wait until status reports in-sync"
    atk_wait_until 10 5 caught_up target source || atk_fail "$id" "the target has not caught up with the source (are the writes frozen?)"
    rc_do target REPLICAOF NO ONE
  fi
  # The way back: the source replicates from the target.
  masterauth source target
  rc_do source REPLICAOF "$(set_need "$id" target_addr)" "$(set_need "$id" target_port)"
  atk_done "$id" cut-over "the target is the master; the source replicates from it (the way back until finalize)" reverse=true
}
ro_commit() { atk_done "$1" "" "committed: the source keeps replicating from the target until finalize"; }
ro_rollback() {
  local id="$1"
  if is_master source && replica_of target source; then atk_skip "$id" "the source is the master and the target replicates from it" "" replication=kept; fi
  if replica_of source target; then
    atk_wait_until 10 5 caught_up source target || atk_log "the source has not caught up with the target: its latest writes may be lost"
    rc_do source REPLICAOF NO ONE
  fi
  masterauth target source
  rc_do target REPLICAOF "$(set_need "$id" source_addr)" "$(set_need "$id" source_port)"
  atk_done "$id" "" "the source is the master again; the target replicates from it" replication=kept
}
ro_finalize() {
  local id="$1" n=0
  if [[ "$(info_field source replication role)" == slave ]]; then rc_do source REPLICAOF NO ONE; n=1; fi
  if [[ "$(info_field target replication role)" == slave ]]; then atk_fail "$id" "the target still replicates from the source: finalize runs after the cutover"; fi
  if (( n == 0 )); then atk_skip "$id" "no replication left"; fi
  atk_done "$id" "" "the source no longer replicates from the target"
}

# ---------------------------------------------------------------- redis-rdb-import (managed caches)

ri_st() { atk_ids_get redis-rdb-import "$ID.$1" 2> /dev/null || true; }
ri_key() { local p; p="$(set_need "$ID" prefix)"; printf '%s/%s-%s.rdb' "$p" "$(atk_name "$ID")" "$1"; }
# ri_exists NAME: the RDB object is in the target cloud's store.
ri_exists() {
  local b k
  b="$(set_need "$ID" bucket)"
  k="$(ri_key "$1")"
  case "$SVC" in
    aws-elasticache|aws-memorydb) aws s3api head-object --bucket "$b" --key "$k" > /dev/null 2>&1 ;;
    google-memorystore) gcloud storage ls "gs://$b/$k" > /dev/null 2>&1 ;;
    azure-managed-redis) [[ "$(az storage blob exists --auth-mode login --account-name "$(set_need "$ID" storage_account)" --container-name "$b" --name "$k" --query exists -o tsv 2> /dev/null || true)" == true ]] ;;
    *) return 1 ;;
  esac
}
# ri_seed NAME: an RDB taken from the source (redis-cli --rdb, a replication sync: the source keeps running), uploaded.
ri_seed() {
  local b k f
  b="$(set_need "$ID" bucket)"
  k="$(ri_key "$1")"
  if ri_exists "$1"; then return 0; fi
  f="$(set_need "$ID" rdb_dir)"
  f="$f/$(atk_name "$ID")-$1.rdb"
  rc_do source --rdb "$f"
  case "$SVC" in
    aws-elasticache|aws-memorydb) atk_run aws s3 cp "$f" "s3://$b/$k" ;;
    google-memorystore) atk_run gcloud storage cp "$f" "gs://$b/$k" ;;
    azure-managed-redis) atk_run az storage blob upload --auth-mode login --account-name "$(set_need "$ID" storage_account)" --container-name "$b" --name "$k" --file "$f" --overwrite ;;
  esac
  atk_run rm -f "$f"
}
# ri_import NAME: load the RDB into the existing cache (Memorystore, Azure Managed Redis); the RDB replaces its data.
ri_import() {
  local b k body sas exp inst region acct rid api
  b="$(set_need "$ID" bucket)"
  k="$(ri_key "$1")"
  case "$SVC" in
    google-memorystore)
      inst="$(set_need "$ID" target_instance)"
      region="$(set_need "$ID" region)"
      atk_run gcloud redis instances import "gs://$b/$k" "$inst" --region="$region"
      ;;
    azure-managed-redis)
      acct="$(set_need "$ID" storage_account)"
      rid="$(set_need "$ID" target_resource_id)"
      api="$(set_need "$ID" api_version)"
      exp="$(date -u -d '+3 hours' +%Y-%m-%dT%H:%MZ)"
      sas="$(az storage blob generate-sas --as-user --auth-mode login --account-name "$acct" --container-name "$b" --name "$k" --permissions r --expiry "$exp" --full-uri -o tsv)"
      atk_tmpfile body
      jq -n --arg u "$sas" '{sasUris: [$u]}' > "$body"
      atk_run az rest --method post --url "https://management.azure.com$rid/databases/default/import?api-version=$api" --body "@$body"
      ;;
  esac
}
ri_dbsize() { rc "$1" DBSIZE | tr -dc '0-9'; }
ri_prepare() {
  local id="$1"
  [[ "$(rc source PING)" == PONG ]] || atk_fail "$id" "the source does not answer PING"
  case "$SVC" in
    aws-elasticache|aws-memorydb) atk_need aws ;;
    google-memorystore) atk_need gcloud ;;
    azure-managed-redis) atk_need az ;;
    *) atk_skip "$id" "$SVC has no RDB import the kit drives: copy the keys with RIOT (riot replicate) or the service's import (runbook)" prepared ;;
  esac
  atk_done "$id" prepared "the source answers; RDB files go to $(set_need "$id" bucket)"
}
ri_replicate() {
  local id="$1"
  case "$SVC" in aws-elasticache|aws-memorydb|google-memorystore|azure-managed-redis) ;; *) atk_skip "$id" "no RDB import for $SVC (runbook)" ;; esac
  if [[ "$(ri_st cutover)" == done ]]; then atk_skip "$id" "cut over" cut-over; fi
  if ri_exists seed; then atk_skip "$id" "the seed RDB is uploaded" in-sync inSync=true; fi
  ri_seed seed
  atk_done "$id" in-sync "seed RDB uploaded (an offline path: the final RDB goes at cutover)" inSync=true
}
ri_status() {
  local id="$1"
  if [[ "$(ri_st cutover)" == done ]]; then atk_skip "$id" "cut over (an offline path: nothing replicates)"; fi
  if ri_exists seed; then atk_done "$id" in-sync "the seed RDB is uploaded" inSync=true; fi
  atk_done "$id" "" "no seed RDB yet" inSync=false
}
ri_test() {
  local id="$1"
  case "$SVC" in
    aws-elasticache|aws-memorydb) atk_skip "$id" "the RDB seeds a new cache at creation (Terraform snapshot_arns = the seed object): test that in a test workspace (runbook)" ;;
    google-memorystore|azure-managed-redis) ;;
    *) atk_skip "$id" "no RDB import for $SVC (runbook)" ;;
  esac
  if [[ "$(ri_st test)" == imported ]]; then atk_skip "$id" "the seed is imported into the target" testing; fi
  ri_exists seed || (( ATK_DRY_RUN )) || atk_fail "$id" "no seed RDB: run replicate first"
  ri_import seed
  atk_ids_put redis-rdb-import "$id.test" imported
  atk_done "$id" testing "the seed RDB is imported into the target: test the application against it"
}
ri_test_cleanup() {
  local id="$1" passed=false
  case "$SVC" in google-memorystore|azure-managed-redis) ;; *) atk_skip "$id" "no test copy to remove" ;; esac
  if [[ "$(ri_dbsize target)" =~ ^[1-9] ]]; then passed=true; fi
  atk_done "$id" tested "the test data stays until the cutover import replaces it" passed="$passed"
}
ri_cutover() {
  local id="$1" s t
  case "$SVC" in aws-elasticache|aws-memorydb|google-memorystore|azure-managed-redis) ;; *) atk_skip "$id" "no RDB import for $SVC (runbook)" ;; esac
  if [[ "$(ri_st cutover)" == done ]]; then atk_skip "$id" "the final RDB is loaded" cut-over; fi
  ri_seed final
  case "$SVC" in
    aws-elasticache|aws-memorydb)
      atk_ids_put redis-rdb-import "$id.cutover" done
      atk_done "$id" cut-over "final RDB at s3://$(set_need "$id" bucket)/$(ri_key final): create the cache from it (Terraform snapshot_arns), then switch the clients"
      ;;
  esac
  ri_import final
  s="$(ri_dbsize source)"
  t="$(ri_dbsize target)"
  if [[ "$s" != "$t" ]] && (( ! ATK_DRY_RUN )); then atk_fail "$id" "the target holds $t keys, the source $s: check the import, then run cutover again"; fi
  atk_ids_put redis-rdb-import "$id.cutover" done
  atk_done "$id" cut-over "final RDB imported ($t keys): switch the clients"
}
ri_commit() { atk_done "$1" "" "committed: the source stays until decommission"; }
ri_rollback() {
  if [[ "$(ri_st cutover)" == done ]]; then atk_ids_put redis-rdb-import "$1.cutover" rolled-back; fi
  atk_skip "$1" "the source was only read: it takes the writes again after the unfreeze; writes on the target since the cutover are not copied back" "" replication=lost
}
ri_finalize() {
  local id="$1" b n=0 name
  case "$SVC" in aws-elasticache|aws-memorydb|google-memorystore|azure-managed-redis) ;; *) atk_skip "$id" "nothing was uploaded" ;; esac
  b="$(set_need "$id" bucket)"
  for name in seed final; do
    ri_exists "$name" || continue
    case "$SVC" in
      aws-elasticache|aws-memorydb) atk_run aws s3 rm "s3://$b/$(ri_key "$name")" ;;
      google-memorystore) atk_run gcloud storage rm "gs://$b/$(ri_key "$name")" ;;
      azure-managed-redis) atk_run az storage blob delete --auth-mode login --account-name "$(set_need "$id" storage_account)" --container-name "$b" --name "$(ri_key "$name")" ;;
    esac
    n=$(( n + 1 ))
  done
  if (( n == 0 )); then atk_skip "$id" "the RDB files are already removed"; fi
  atk_done "$id" "" "the RDB files removed"
}
`;

const REDIS_SPECS: readonly SettingSpec[] = [
  { key: 'service', about: 'the target service (from the decision)' },
  { key: 'source_addr', about: 'the source address (IPv6 accepted)' },
  { key: 'source_port', about: 'the source port' },
  { key: 'source_tls', about: 'yes when the source needs TLS' },
  { key: 'source_auth', about: 'password (REDIS_SOURCE_PASSWORD) or none' },
  { key: 'target_addr', about: 'the target address (a VM, or the managed endpoint for the key count)' },
  { key: 'target_port', about: 'the target port' },
  { key: 'target_tls', about: 'yes when the target needs TLS (managed caches do)' },
  { key: 'target_auth', about: 'password (REDIS_TARGET_PASSWORD) or none' },
  { key: 'bucket', about: 'RDB import: the bucket (S3, Cloud Storage) or container (Azure) the RDB goes through', paths: ['redis-rdb-import'] },
  { key: 'prefix', about: 'RDB import: the prefix of the RDB objects', paths: ['redis-rdb-import'] },
  { key: 'rdb_dir', about: 'RDB import: a controller directory for the RDB while it is uploaded (as large as the dataset)', paths: ['redis-rdb-import'] },
  { key: 'region', about: 'RDB import (Memorystore): the region', paths: ['redis-rdb-import'] },
  { key: 'target_instance', about: 'RDB import (Memorystore): the instance id', paths: ['redis-rdb-import'] },
  { key: 'storage_account', about: 'RDB import (Azure Managed Redis): the storage account of the container', paths: ['redis-rdb-import'] },
  { key: 'target_resource_id', about: 'RDB import (Azure Managed Redis): the cache\'s resource id (/subscriptions/…/redisEnterprise/<name>)', paths: ['redis-rdb-import'] },
  { key: 'api_version', about: 'RDB import (Azure Managed Redis): the Microsoft.Cache/redisEnterprise API version for the import call', paths: ['redis-rdb-import'] },
];

const REDIS: Family = {
  id: 'redis',
  paths: ['redis-replicaof', 'redis-rdb-import'],
  file: REDIS_FILE,
  summary: 'Redis: REPLICAOF to a Redis on a VM (reversed at cutover), or an RDB taken from the source and loaded into the managed cache.',
  commands: ['redis-cli', 'jq'],
  needs: [{ kind: 'command', name: 'redis-cli', min: '6.0', why: 'Redis: REPLICAOF, INFO and the RDB copy (--rdb); passwords in REDISCLI_AUTH' }],
  specs: REDIS_SPECS,
  rows: (items, ctx) => items.map((item) => {
    const h = hostsOf(item, ctx);
    const svc = serviceOf(item);
    const managed = !onVm(item);
    return {
      item,
      values: {
        service: svc,
        source_addr: h.addr, source_port: '6379', source_tls: 'no', source_auth: 'password',
        target_addr: managed ? undefined : h.tgt, target_port: managed && svc === 'azure-managed-redis' ? '10000' : '6379', target_tls: managed ? 'yes' : 'no', target_auth: 'password',
        ...(item.path === 'redis-rdb-import' ? {
          bucket: undefined, prefix: `atk-${planId8(ctx.plan.id)}/redis`, rdb_dir: undefined,
          ...(svc === 'google-memorystore' ? { region: item.target.region, target_instance: undefined } : {}),
          ...(svc === 'azure-managed-redis' ? { storage_account: undefined, target_resource_id: undefined, api_version: undefined } : {}),
        } : {}),
      },
    };
  }),
  sh: REDIS_SH,
  verbs: everyVerb(dispatch({ 'redis-replicaof': 'ro' }, 'ri', 'rd_ctx')),
  usesHostStep: false,
  readme: {
    title: 'Redis (redis-replicaof, redis-rdb-import)',
    intro: [
      'redis-cli runs on the controller; passwords reach it in `REDISCLI_AUTH`, and a password a command needs (masterauth) goes on its stdin.',
      '**redis-replicaof** (a Redis on a VM): the target replicates from the source (`REPLICAOF`); at cutover, once the offsets match, the target is promoted (`REPLICAOF NO ONE`) and the source replicates from it: the way back.',
      '**redis-rdb-import** (a managed cache): an RDB taken from the source with `redis-cli --rdb` (a replication sync: the source keeps running), uploaded to the target cloud\'s store, and loaded: Memorystore `gcloud redis instances import`, Azure Managed Redis the import call; ElastiCache and MemoryDB **seed a new cache from the S3 RDB at creation** (Terraform `snapshot_arns`), so the kit uploads it and the wave\'s Terraform creates the cache. OCI Cache has no import the kit drives: RIOT (runbook). Azure Cache for Redis retires (Enterprise 2027-03-31, the other tiers 2028-09-30): Azure Managed Redis is the target.',
    ],
    verbs: [
      '`prepare`: both ends answer (REPLICAOF: the target is the same Redis version or newer, and its masterauth is set).',
      '`replicate`: REPLICAOF and the initial sync; RDB import: the seed RDB uploaded.',
      '`status`: the replication link; RDB import: whether the seed is uploaded.',
      '`test` / `test-cleanup`: RDB import on Memorystore / Azure: the seed imported into the target; otherwise no test copy.',
      '`cutover`: REPLICAOF: the target promoted, the source made its replica; RDB import: the final RDB (after the freeze) uploaded and imported, key counts compared.',
      '`commit`: records the point of no return.',
      '`rollback`: REPLICAOF: the source promoted back, the target its replica again; RDB import: nothing to undo (target writes are lost).',
      '`finalize`: REPLICAOF: the source stops replicating; RDB import: the RDB objects removed.',
    ],
    credentials: ['`REDIS_SOURCE_PASSWORD`, `REDIS_TARGET_PASSWORD` (unless the side\'s auth is none): in `REDISCLI_AUTH`; masterauth on stdin.', 'The cloud CLIs use their own credential chains (AWS profile or role, `az login` / managed identity, gcloud ADC).'],
    environment: ['`REDIS_CA_FILE`: the CA for TLS endpoints.'],
    runbook: ['OCI Cache: RIOT (`riot replicate`) or the service\'s own import.', 'ElastiCache / MemoryDB: create the cache from the final RDB (Terraform `snapshot_arns`), then switch the clients.'],
    unconfirmed: ['The Azure Managed Redis import call (`POST …/redisEnterprise/<name>/databases/default/import` with `sasUris`) and its API version.', 'A user-delegation SAS (`az storage blob generate-sas --as-user`) accepted by the import.'],
  },
  findings: (items, ctx) => [
    ...noReverse(items, ['redis-rdb-import'], REDIS_FILE, 'an RDB import'),
    ...items.filter((i) => i.path === 'redis-rdb-import' && serviceOf(i) === 'oci-cache').map((i) => info('exec.pattern.runbook', `${i.name}: OCI Cache has no RDB import the kit drives: copy the keys with RIOT (runbook).`, { path: i.id })),
    ...unknownSettings(REDIS.rows(items, ctx), ['target_addr', 'bucket', 'rdb_dir', 'target_instance', 'storage_account', 'target_resource_id', 'api_version'], REDIS_FILE),
  ],
};

// ---------------------------------------------------------------------------
// Cassandra: ZDM proxy (dual writes) + dsbulk, or joining the ring
// ---------------------------------------------------------------------------

const CASS_FILE = `${DB_DIR}/cassandra/cassandra.sh`;

const CASS_SH = code`
cs_ctx() {
  OSU="$(set_need "$1" os_user)"
  KS="$(set_get "$1" keyspaces | tr ',;' '  ')"
  mapfile -t SRCN < <(set_get "$1" source_nodes | tr ', ' '\n\n' | sed '/^$/d')
  mapfile -t TGTN < <(set_get "$1" target_nodes | tr ', ' '\n\n' | sed '/^$/d')
  if [[ "$\{ATK_ITEM_PATH[$1]}" == cassandra-ring-join ]]; then
    local v
    v="$(set_need "$1" keyspaces)"
    v="$(set_need "$1" source_nodes)"
    cs_rc v source
  fi
}
cs_st() { atk_ids_get "$\{ATK_ITEM_PATH[$ID]}" "$ID.$1" 2> /dev/null || true; }
cs_put() { atk_ids_put "$\{ATK_ITEM_PATH[$ID]}" "$ID.$1" "$2"; }
# cs_rc VAR SIDE: a cqlshrc for the side's user (cqlsh reads its credentials from a file: written on the node, mode 600, removed at once).
cs_rc() {
  local user pw
  user="$(set_need "$ID" "$2_user")"
  secret_for pw "CASSANDRA_$\{2^^}_PASSWORD" "$ID"
  printf -v "$1" '[authentication]\nusername = %s\npassword = %s\n' "$user" "$pw"
}
cs_wrap() { printf 'f=$(mktemp) && chmod 600 $f && cat > $f && cqlsh --cqlshrc $f -e "%s"; rc=$?; rm -f $f; exit $rc' "$1"; }
cql() { local rc; cs_rc rc "$2"; ( export ATK_STDIN="$rc"; host_read "$1" "$OSU" "$(cs_wrap "$3")" ATK_STDIN ); }
cql_do() { local rc; cs_rc rc "$2"; ( export ATK_STDIN="$rc"; host_step "$1" "$OSU" "$(cs_wrap "$3")" ATK_STDIN ); }
# dcs NODE: the datacenters nodetool status lists, with their UN (up and normal) node counts: "dc count" lines.
dcs() { host_read "$1" "$OSU" 'nodetool status' | awk '/^Datacenter:/ { dc = $2; n[dc] = 0 } /^UN / { n[dc]++ } END { for (d in n) print d, n[d] }'; }
dc_up() { dcs "$\{SRCN[0]}" | awk -v d="$1" '$1 == d && $2 > 0 { ok = 1 } END { exit !ok }'; }

# ---------------------------------------------------------------- cassandra-ring-join (Azure Managed Instance or VMs)

rj_prepare() {
  local id="$1" dc n
  dc="$(set_need "$id" target_dc)"
  if dc_up "$dc"; then atk_skip "$id" "datacenter $dc is in the ring" prepared; fi
  if (( $\{#TGTN[@]} == 0 )); then atk_fail "$id" "datacenter $dc is not in the ring: create the Managed Instance datacenter with the source seed nodes and exchange the node certificates (Terraform and runbook)"; fi
  local start='systemctl start cassandra'
  for n in "$\{TGTN[@]}"; do host_step "$n" root "$start"; done
  atk_wait_until 30 20 dc_up "$dc" || atk_fail "$id" "datacenter $dc did not join: check cluster_name, the seeds and cassandra-rackdc.properties on the new nodes"
  atk_done "$id" prepared "datacenter $dc joined the ring"
}
# rj_replication KS: the keyspace's replication map on the source.
rj_replication() { cql "$\{SRCN[0]}" source "SELECT replication FROM system_schema.keyspaces WHERE keyspace_name = '$1'" | awk '/class/ && !f { print; f = 1 }'; }
rj_alter() { # KS WITH_DCS...: NetworkTopologyStrategy with each "dc:rf"
  local ks="$1" m="'class': 'NetworkTopologyStrategy'" p
  shift
  for p in "$@"; do m+=", '$\{p%%:*}': $\{p##*:}"; done
  cql_do "$\{SRCN[0]}" source "ALTER KEYSPACE $ks WITH replication = {$m}"
}
rj_replicate() {
  local id="$1" sdc tdc rf ks rep srf n done_nodes=0
  sdc="$(set_need "$id" source_dc)"
  tdc="$(set_need "$id" target_dc)"
  rf="$(set_need "$id" target_rf)"
  for ks in $KS; do
    rep="$(rj_replication "$ks")"
    if [[ "$rep" == *"'$tdc'"* ]]; then continue; fi
    srf="$(printf '%s' "$rep" | sed -n "s/.*'$sdc': '\\([0-9]*\\)'.*/\\1/p")"
    rj_alter "$ks" "$sdc:$\{srf:-3}" "$tdc:$rf"
  done
  if (( $\{#TGTN[@]} == 0 )); then
    atk_done "$id" replicating "keyspaces replicate to $tdc: run nodetool rebuild -- $sdc on each Managed Instance node (az managed-cassandra cluster invoke-command; runbook), then status" inSync=false
  fi
  for n in "$\{TGTN[@]}"; do
    if [[ "$(cs_st "rebuilt.$n")" == yes ]]; then done_nodes=$(( done_nodes + 1 )); continue; fi
    host_step "$n" "$OSU" "nodetool rebuild -- $sdc"
    cs_put "rebuilt.$n" yes
    done_nodes=$(( done_nodes + 1 ))
  done
  atk_done "$id" in-sync "keyspaces replicate to $tdc; $done_nodes nodes rebuilt from $sdc" inSync=true
}
rj_status() {
  local id="$1" tdc n=0 node
  tdc="$(set_need "$id" target_dc)"
  dc_up "$tdc" || atk_done "$id" "" "datacenter $tdc is not in the ring" inSync=false
  for node in "$\{TGTN[@]}"; do if [[ "$(cs_st "rebuilt.$node")" == yes ]]; then n=$(( n + 1 )); fi; done
  if (( $\{#TGTN[@]} > 0 && n == $\{#TGTN[@]} )); then atk_done "$id" in-sync "datacenter $tdc is rebuilt ($n nodes)" inSync=true; fi
  atk_done "$id" replicating "datacenter $tdc: $n of $\{#TGTN[@]} nodes rebuilt by the kit" inSync=false
}
rj_test() { atk_skip "$1" "test with a client pinned to the new datacenter (LOCAL_QUORUM there; runbook)"; }
rj_test_cleanup() { atk_skip "$1" "no test copy to remove"; }
rj_cutover() {
  local id="$1" tdc
  tdc="$(set_need "$id" target_dc)"
  if [[ "$(cs_st cutover)" == done ]]; then atk_skip "$id" "cut over to $tdc" cut-over; fi
  dc_up "$tdc" || atk_fail "$id" "datacenter $tdc is not up"
  cs_put cutover done
  atk_done "$id" cut-over "datacenter $tdc holds every write: switch the applications' local datacenter to $tdc (runbook); both datacenters keep replicating"
}
rj_commit() { atk_done "$1" "" "committed: the source datacenter keeps replicating until finalize"; }
rj_rollback() {
  local id="$1" sdc
  sdc="$(set_need "$id" source_dc)"
  if [[ "$(cs_st cutover)" == done ]]; then cs_put cutover rolled-back; fi
  atk_done "$id" "" "switch the applications' local datacenter back to $sdc (runbook): both datacenters kept every write" replication=kept
}
rj_finalize() {
  local id="$1" sdc tdc rf ks rep n c=0
  sdc="$(set_need "$id" source_dc)"
  tdc="$(set_need "$id" target_dc)"
  rf="$(set_need "$id" target_rf)"
  [[ "$(cs_st cutover)" == done ]] || atk_fail "$id" "not cut over: finalize removes the source datacenter"
  for ks in $KS; do
    rep="$(rj_replication "$ks")"
    if [[ "$rep" != *"'$sdc'"* ]]; then continue; fi
    rj_alter "$ks" "$tdc:$rf"
    c=$(( c + 1 ))
  done
  for n in "$\{SRCN[@]}"; do
    if [[ "$(host_read "$n" "$OSU" 'nodetool netstats' | awk '/^Mode:/ { print $2 }')" == NORMAL ]]; then
      host_step "$n" "$OSU" 'nodetool decommission'
      c=$(( c + 1 ))
    fi
  done
  if (( c == 0 )); then atk_skip "$id" "the source datacenter is already out of the keyspaces and the ring"; fi
  atk_done "$id" "" "keyspaces replicate only to $tdc; the source nodes decommissioned"
}

# ---------------------------------------------------------------- cassandra-zdm-proxy (Amazon Keyspaces, or a VM ring)

zdm_proxy_up() { [[ -n "$(curl -sS --fail --max-time 15 "http://$(url_host "$(set_need "$ID" zdm_proxy_addr)"):$(set_need "$ID" zdm_metrics_port)/metrics" 2> /dev/null | awk 'NR == 1' || true)" ]]; }
zdm_tables() { set_need "$ID" tables | tr ',;' '  '; }
# zdm_conf VAR SIDE: dsbulk settings for the side: the operator's file (Keyspaces: TLS and SigV4, no secret), else a mode-600 runtime file.
zdm_conf() {
  local file user pw
  file="$(set_get "$ID" "$2_dsbulk_conf")"
  if [[ -z "$file" ]]; then
    user="$(set_need "$ID" "$2_user")"
    secret_for pw "CASSANDRA_$\{2^^}_PASSWORD" "$ID"
    atk_tmpfile file
    printf 'datastax-java-driver.advanced.auth-provider { class = PlainTextAuthProvider, username = "%s", password = "%s" }\n' "$\{user//\"/\\\"}" "$\{pw//\"/\\\"}" > "$file"
  fi
  printf -v "$1" '%s' "$file"
}
zdm_work() { local d; d="$(set_need "$ID" unload_dir)"; printf '%s/%s' "$d" "$(atk_name "$ID")"; }
zp_prepare() {
  local id="$1" t ks tb
  zdm_proxy_up || atk_fail "$id" "the ZDM proxy does not answer on $(set_need "$id" zdm_proxy_addr): deploy it (zdm-proxy-automation) with ORIGIN primary and point the applications at it (runbook)"
  if [[ "$\{SVC_KIND:-}" == keyspaces ]]; then
    atk_need aws
    for t in $(zdm_tables); do
      ks="$\{t%%.*}"; tb="$\{t#*.}"
      aws keyspaces get-table --keyspace-name "$ks" --table-name "$tb" > /dev/null 2>&1 || atk_fail "$id" "Keyspaces table $t is missing: the wave's Terraform creates the keyspaces and tables"
    done
  fi
  atk_done "$id" prepared "the ZDM proxy answers (dual writes to both clusters); the target tables exist"
}
zp_replicate() {
  local id="$1" t src tgt dir sc tc n=0 total=0
  if [[ "$(cs_st cutover)" == done ]]; then atk_skip "$id" "cut over" cut-over; fi
  sc="$(set_need "$id" source_contact)"
  tc="$(set_need "$id" target_contact)"
  zdm_conf src source
  zdm_conf tgt target
  dir="$(zdm_work)"
  for t in $(zdm_tables); do
    total=$(( total + 1 ))
    if [[ "$(cs_st "loaded.$t")" == yes ]]; then n=$(( n + 1 )); continue; fi
    atk_run mkdir -p "$dir/$t"
    atk_run dsbulk unload -f "$src" -h "$sc" -k "$\{t%%.*}" -t "$\{t#*.}" -url "$dir/$t"
    atk_run dsbulk load -f "$tgt" -h "$tc" -k "$\{t%%.*}" -t "$\{t#*.}" -url "$dir/$t"
    cs_put "loaded.$t" yes
    n=$(( n + 1 ))
  done
  if (( n == total )); then atk_done "$id" in-sync "$n tables copied with dsbulk; the proxy's dual writes keep them in step" inSync=true; fi
  atk_done "$id" replicating "$n of $total tables copied" inSync=false
}
zp_status() {
  local id="$1" t n=0 total=0
  if [[ "$(cs_st cutover)" == done ]]; then atk_skip "$id" "cut over: the proxy reads from the target"; fi
  for t in $(zdm_tables); do total=$(( total + 1 )); if [[ "$(cs_st "loaded.$t")" == yes ]]; then n=$(( n + 1 )); fi; done
  zdm_proxy_up || atk_fail "$id" "the ZDM proxy does not answer: dual writes are not certain" inSync=false
  if (( n == total )); then atk_done "$id" in-sync "$n tables copied; dual writes running" inSync=true; fi
  atk_done "$id" replicating "$n of $total tables copied" inSync=false
}
zp_count() { dsbulk count -f "$2" -h "$3" -k "$\{1%%.*}" -t "$\{1#*.}" 2> /dev/null | awk '/^[0-9]+/ { v = $1 } END { print v }' || true; }
zp_test() {
  local id="$1" t src tgt a b passed=true
  zdm_conf src source
  zdm_conf tgt target
  for t in $(zdm_tables); do
    a="$(zp_count "$t" "$src" "$(set_need "$id" source_contact)")"
    b="$(zp_count "$t" "$tgt" "$(set_need "$id" target_contact)")"
    if [[ -z "$a" || "$a" != "$b" ]]; then passed=false; atk_log "$t: source $\{a:-?} rows, target $\{b:-?}"; fi
  done
  cs_put test "$passed"
  atk_done "$id" testing "row counts compared (dsbulk count): passed=$passed" passed="$passed"
}
zp_test_cleanup() { atk_done "$1" tested "nothing to remove" passed="$(cs_st test)"; }
zp_primary() { # ORIGIN|TARGET: the proxy's primary cluster, through the operator's zdm-proxy-automation (rolling restart)
  local dir
  dir="$(set_get "$ID" zdm_automation_dir)"
  if [[ -z "$dir" ]]; then return 1; fi
  atk_run ansible-playbook -i "$dir/zdm_ansible_inventory" "$dir/rolling_update_zdm_proxy.yml" -e "primary_cluster=$1"
}
zp_cutover() {
  local id="$1"
  if [[ "$(cs_st cutover)" == done ]]; then atk_skip "$id" "the proxy's primary is the target" cut-over; fi
  if ! zp_primary TARGET; then atk_skip "$id" "set the proxy's primary cluster to TARGET with a rolling restart (zdm-proxy-automation; runbook), or set zdm_automation_dir"; fi
  cs_put cutover done
  atk_done "$id" cut-over "the proxy reads from the target (still dual writing): point the applications at the target directly, then remove the proxy (runbook)"
}
zp_commit() { atk_done "$1" "" "committed: the proxy keeps dual writing (the way back) until the applications connect to the target directly"; }
zp_rollback() {
  local id="$1"
  if [[ "$(cs_st cutover)" != done ]]; then atk_skip "$id" "not cut over: the origin is the proxy's primary" "" replication=kept; fi
  if ! zp_primary ORIGIN; then atk_skip "$id" "set the proxy's primary cluster back to ORIGIN (zdm-proxy-automation; runbook)" "" replication=kept; fi
  cs_put cutover rolled-back
  atk_done "$id" "" "the proxy reads from the origin again; dual writes kept both clusters complete" replication=kept
}
zp_finalize() {
  local id="$1" dir
  dir="$(zdm_work)"
  if [[ ! -d "$dir" ]]; then atk_skip "$id" "nothing left on the controller: remove the ZDM proxy once the applications connect to the target directly (runbook)"; fi
  atk_run rm -rf "$dir"
  atk_done "$id" "" "the dsbulk unload files removed; remove the ZDM proxy once the applications connect to the target directly (runbook)"
}
`;

const CASS: Family = {
  id: 'cassandra',
  paths: ['cassandra-zdm-proxy', 'cassandra-ring-join'],
  file: CASS_FILE,
  summary: 'Cassandra: the ZDM proxy (dual writes) with dsbulk to Amazon Keyspaces or a VM ring, or a new datacenter joining the ring (Azure Managed Instance or VMs).',
  commands: HOST_COMMANDS,
  needs: [
    ...HOST_NEEDS,
    { kind: 'command', name: 'jq', min: '1.6', why: 'Cassandra: reading the Ansible results' },
    { kind: 'command', name: 'dsbulk', min: '1.11', why: 'cassandra-zdm-proxy: copying the existing rows (unload, load, count)', install: 'https://github.com/datastax/dsbulk' },
    { kind: 'command', name: 'curl', why: 'cassandra-zdm-proxy: the proxy\'s metrics endpoint' },
  ],
  specs: [
    { key: 'keyspaces', about: 'the application keyspaces (comma separated)' },
    { key: 'os_user', about: 'the OS user that runs cqlsh and nodetool on the nodes' },
    { key: 'source_nodes', about: 'the source nodes in the Ansible inventory (comma separated)' },
    { key: 'target_nodes', about: 'the new nodes in the inventory (VM targets; empty for a Managed Instance)', paths: ['cassandra-ring-join'] },
    { key: 'source_user', about: 'the source cluster user (with CASSANDRA_SOURCE_PASSWORD)' },
    { key: 'target_user', about: 'the target user (with CASSANDRA_TARGET_PASSWORD; Keyspaces: service-specific credentials, or target_dsbulk_conf with SigV4)', paths: ['cassandra-zdm-proxy'] },
    { key: 'source_dc', about: 'the source datacenter name', paths: ['cassandra-ring-join'] },
    { key: 'target_dc', about: 'the new datacenter name', paths: ['cassandra-ring-join'] },
    { key: 'target_rf', about: 'the replication factor in the new datacenter', paths: ['cassandra-ring-join'] },
    { key: 'target_kind', about: 'keyspaces (Amazon Keyspaces: prepare checks the tables with the AWS CLI) or cassandra', paths: ['cassandra-zdm-proxy'] },
    { key: 'tables', about: 'the tables to copy, keyspace.table, comma separated', paths: ['cassandra-zdm-proxy'] },
    { key: 'zdm_proxy_addr', about: 'the ZDM proxy address', paths: ['cassandra-zdm-proxy'] },
    { key: 'zdm_metrics_port', about: 'the ZDM proxy metrics port', paths: ['cassandra-zdm-proxy'] },
    { key: 'zdm_automation_dir', about: 'the operator\'s zdm-proxy-automation directory (the cutover switches the primary cluster with it); empty = a runbook step', paths: ['cassandra-zdm-proxy'] },
    { key: 'source_contact', about: 'a source contact point for dsbulk', paths: ['cassandra-zdm-proxy'] },
    { key: 'target_contact', about: 'a target contact point for dsbulk (Keyspaces: cassandra.<region>.amazonaws.com)', paths: ['cassandra-zdm-proxy'] },
    { key: 'source_dsbulk_conf', about: 'an operator dsbulk settings file for the source (no secret in it), instead of the generated one', paths: ['cassandra-zdm-proxy'] },
    { key: 'target_dsbulk_conf', about: 'an operator dsbulk settings file for the target (Keyspaces: TLS truststore and the SigV4 auth provider)', paths: ['cassandra-zdm-proxy'] },
    { key: 'unload_dir', about: 'a controller directory for the unloaded rows (as large as the tables)', paths: ['cassandra-zdm-proxy'] },
  ],
  rows: (items, ctx) => items.map((item) => {
    const h = hostsOf(item, ctx);
    const ks = serviceOf(item) === 'aws-keyspaces';
    return {
      item,
      values: {
        keyspaces: undefined, os_user: 'cassandra', source_nodes: h.srcAll.join(','), source_user: undefined,
        ...(item.path === 'cassandra-ring-join'
          ? { target_nodes: h.tgtAll.join(',') || undefined, source_dc: undefined, target_dc: undefined, target_rf: '3' }
          : {
            target_kind: ks ? 'keyspaces' : 'cassandra', target_user: undefined, tables: undefined, zdm_proxy_addr: undefined, zdm_metrics_port: '14001', zdm_automation_dir: undefined,
            source_contact: h.addr, target_contact: ks && item.target.region ? `cassandra.${item.target.region}.amazonaws.com` : h.tgt,
            source_dsbulk_conf: undefined, target_dsbulk_conf: undefined, unload_dir: undefined,
          }),
      },
    };
  }),
  sh: CASS_SH,
  verbs: everyVerb((v) => [
    'ID="$id"',
    'cs_ctx "$id"',
    'case "${ATK_ITEM_PATH[$id]}" in',
    `  cassandra-ring-join) rj_${fnVerb(v)} "$id" ;;`,
    `  *) SVC_KIND="$(set_get "$id" target_kind)"; zp_${fnVerb(v)} "$id" ;;`,
    'esac',
  ].join('\n')),
  usesHostStep: true,
  readme: {
    title: 'Cassandra (cassandra-zdm-proxy, cassandra-ring-join)',
    intro: [
      '**cassandra-zdm-proxy** (Amazon Keyspaces, or a VM ring): the ZDM proxy (deployed with zdm-proxy-automation, a runbook step) writes to both clusters; the kit copies the existing rows with dsbulk (unload, load), compares the counts at test, and at cutover switches the proxy\'s primary cluster to the target (a rolling restart through the operator\'s zdm-proxy-automation). The applications then connect to the target directly and the proxy is removed. Keyspaces tables are created by the wave\'s Terraform.',
      '**cassandra-ring-join** (Azure Managed Instance, or VMs): the new datacenter joins the source ring (the Managed Instance datacenter is created by Terraform with the source seeds; new VMs start with the same cluster name and seeds), the keyspaces replicate to it (`ALTER KEYSPACE … NetworkTopologyStrategy`), and `nodetool rebuild -- <source dc>` streams the data (the kit runs it on VMs; on a Managed Instance it is `az managed-cassandra cluster invoke-command`, a runbook step). Finalize takes the source datacenter out of the keyspaces and decommissions its nodes.',
      'cqlsh and nodetool run on the nodes through the project\'s Ansible inventory; cqlsh reads its credentials from a mode-600 file written on the node from stdin and removed at once.',
    ],
    verbs: [
      '`prepare`: ZDM: the proxy answers and the target tables exist; ring join: the new datacenter is in the ring.',
      '`replicate`: ZDM: each table unloaded and loaded once; ring join: the keyspaces replicate to the new datacenter, its nodes rebuilt.',
      '`status`: ZDM: tables copied and the proxy up; ring join: nodes rebuilt.',
      '`test` / `test-cleanup`: ZDM: row counts compared; ring join: a client pinned to the new datacenter (runbook).',
      '`cutover`: ZDM: the proxy\'s primary set to TARGET; ring join: the applications switch their local datacenter (runbook).',
      '`commit`: records the point of no return (both keep the way back: dual writes, or both datacenters).',
      '`rollback`: ZDM: the proxy\'s primary back to ORIGIN; ring join: the applications switch back.',
      '`finalize`: ZDM: the unload files removed (the proxy removal is a runbook step); ring join: the source datacenter removed and decommissioned.',
    ],
    credentials: ['`CASSANDRA_SOURCE_PASSWORD`, `CASSANDRA_TARGET_PASSWORD`: for cqlsh (a transient file on the node, from stdin) and dsbulk (a mode-600 runtime file), with the users in the settings. Keyspaces with SigV4 uses the AWS credential chain through `target_dsbulk_conf`.'],
    environment: ['`ATK_INVENTORY`: the Ansible inventory (default `ansible/inventory` of the project).'],
    runbook: ['Deploying and removing the ZDM proxy (zdm-proxy-automation) and pointing the applications at it.', 'Managed Instance: the node certificates between the source ring and the Managed Instance, and `nodetool rebuild` on its nodes.', 'Switching the applications\' local datacenter (ring join).'],
    unconfirmed: [
      'zdm-proxy-automation\'s `rolling_update_zdm_proxy.yml` with `primary_cluster=TARGET|ORIGIN` and its inventory file name.',
      'cqlsh reading `[authentication] username / password` from `--cqlshrc` (Cassandra 4.1 prefers a credentials file).',
      'The ZDM proxy metrics port (14001) as the liveness check.',
    ],
  },
  findings: (items, ctx) => [
    ...unknownSettings(CASS.rows(items, ctx), ['keyspaces', 'source_user', 'target_user', 'source_dc', 'target_dc', 'tables', 'zdm_proxy_addr', 'unload_dir'], CASS_FILE),
    ...items.filter((i) => i.path === 'cassandra-zdm-proxy').map((i) => info('exec.pattern.runbook', `${i.name}: the ZDM proxy itself is deployed and removed by a runbook step (zdm-proxy-automation); the kit copies the rows and switches the primary cluster.`, { path: i.id })),
  ],
};

// ---------------------------------------------------------------------------
// Elasticsearch / OpenSearch: snapshot and restore, or reindex from remote
// ---------------------------------------------------------------------------

const ES_FILE = `${DB_DIR}/es/es.sh`;

const ES_SH = code`
_esc() { local s="$1"; s="$\{s//\\/\\\\}"; s="$\{s//\"/\\\"}"; printf '%s' "$s"; }
# es_cfg VAR SIDE: curl settings for the side (credentials included, sent to curl on stdin).
es_cfg() {
  local _var="$1" side="$2" out="" pw user region
  case "$(set_get "$ID" "$\{side}_auth")" in
    none) ;;
    sigv4)
      region="$(set_need "$ID" region)"
      [[ -n "$\{AWS_ACCESS_KEY_ID:-}" && -n "$\{AWS_SECRET_ACCESS_KEY:-}" ]] || atk_die 3 "sigv4 needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment (short-lived, from the role)"
      out+="aws-sigv4 = \"aws:amz:$region:es\""$'\n'
      out+="user = \"$(_esc "$AWS_ACCESS_KEY_ID"):$(_esc "$AWS_SECRET_ACCESS_KEY")\""$'\n'
      if [[ -n "$\{AWS_SESSION_TOKEN:-}" ]]; then out+="header = \"x-amz-security-token: $(_esc "$AWS_SESSION_TOKEN")\""$'\n'; fi
      ;;
    *)
      user="$(set_need "$ID" "$\{side}_user")"
      secret_for pw "ES_$\{side^^}_PASSWORD" "$ID"
      out+="user = \"$(_esc "$user"):$(_esc "$pw")\""$'\n'
      ;;
  esac
  if [[ -n "$\{ES_CA_FILE:-}" ]]; then out+="cacert = \"$(_esc "$ES_CA_FILE")\""$'\n'; fi
  printf -v "$_var" '%s' "$out"
}
es_url() { set_need "$ID" "$1_url"; }
# es_ctx: both URLs and both sides' credentials are set (exit 5 / 3 up front, not inside a read).
es_ctx() {
  local v
  v="$(es_url source)"
  v="$(es_url target)"
  es_cfg v source
  es_cfg v target
}
# es_get SIDE PATH: a read (runs in a dry run too); prints the body, nothing on an error.
es_get() {
  local cfg url
  es_cfg cfg "$1"
  url="$(es_url "$1")"
  printf '%s' "$cfg" | curl -sS --fail --max-time 60 --config - "$url$2" 2> /dev/null || true
}
# es_send SIDE METHOD PATH [BODYFILE]: a change (printed instead in a dry run).
es_send() {
  local cfg url
  es_cfg cfg "$1"
  url="$(es_url "$1")"
  local -a body=()
  if [[ -n "$\{4:-}" ]]; then body=(-H 'Content-Type: application/json' --data-binary "@$4"); fi
  printf '%s' "$cfg" | atk_run curl -sS --fail --max-time 300 --config - -X "$2" "$\{body[@]}" "$url$3" > /dev/null
}
es_body() { local _ebf; atk_tmpfile _ebf; printf '%s' "$2" > "$_ebf"; printf -v "$1" '%s' "$_ebf"; }
es_version() { jq -r '[.version.distribution // "elasticsearch", .version.number] | join(" ")' <<< "$(es_get "$1" /)" 2> /dev/null || true; }
# es_compatible: the snapshot can be restored on the target (OpenSearch restores Elasticsearch 7.x up to 7.10.2 and
# 6.8; Elasticsearch restores the same major or the one before). Exit 5 with the reason otherwise.
es_compatible() {
  local s t sd sv td tv smaj tmaj
  s="$(es_version source)"
  t="$(es_version target)"
  [[ -n "$s" && -n "$t" ]] || atk_die 5 "$\{ATK_NAME[$ID]}: the source or the target does not answer (source_url, target_url, credentials)"
  sd="$\{s%% *}"; sv="$\{s#* }"; td="$\{t%% *}"; tv="$\{t#* }"
  smaj="$\{sv%%.*}"; tmaj="$\{tv%%.*}"
  if [[ "$td" == opensearch && "$sd" != opensearch ]]; then
    [[ "$(printf '%s\n%s\n' "$sv" 7.10.2 | sort -V | awk 'END { print }')" == 7.10.2 && "$smaj" -ge 6 ]] \
      || atk_die 5 "$\{ATK_NAME[$ID]}: OpenSearch cannot restore an Elasticsearch $sv snapshot: use es-reindex-remote (a path override)"
  elif [[ "$td" == "$sd" ]]; then
    (( tmaj == smaj || tmaj == smaj + 1 )) || atk_die 5 "$\{ATK_NAME[$ID]}: $td $tv cannot restore a $sd $sv snapshot (same major or the next one only)"
  else
    atk_die 5 "$\{ATK_NAME[$ID]}: $td cannot restore a $sd snapshot"
  fi
  COMPAT="$s to $t"
}
es_st() { atk_ids_get "$\{ATK_ITEM_PATH[$ID]}" "$ID.$1" 2> /dev/null || true; }
es_put() { atk_ids_put "$\{ATK_ITEM_PATH[$ID]}" "$ID.$1" "$2"; }
es_pattern() { set_need "$ID" indices; }
# es_indices SIDE [PATTERN]: the index names (no dot indices).
es_indices() {
  local p="$\{2:-}" skip='^atktest-'
  if [[ -n "$p" ]]; then skip='^$'; else p="$(es_pattern)"; fi
  es_get "$1" "/_cat/indices/$p?h=index&expand_wildcards=open" | awk -v s="$skip" '$1 !~ /^\./ && $1 !~ s { print $1 }' | sort
}
es_count() { jq -r '.count // empty' <<< "$(es_get "$1" "/$2/_count")" 2> /dev/null || true; }

# ---------------------------------------------------------------- es-snapshot-restore

snap_repo() { set_need "$ID" repo; }
snap_name() { printf '%s-%s' "$(atk_name "$ID")" "$1"; }
snap_state() { jq -r '.snapshots[0].state // empty' <<< "$(es_get source "/_snapshot/$(snap_repo)/$(snap_name "$1")")" 2> /dev/null || true; }
snap_done() { [[ "$(snap_state "$1")" == SUCCESS ]]; }
snap_ended() { case "$(snap_state "$1")" in SUCCESS|FAILED|PARTIAL|INCOMPATIBLE) return 0 ;; *) return 1 ;; esac; }
# repo_body READONLY: the repository in the target cloud's object store.
repo_body() {
  local f
  es_body f "$(jq -n --arg type "$(set_need "$ID" repo_type)" --arg bucket "$(set_need "$ID" bucket)" --arg base "$(atk_name "$ID")" \
    --arg role "$(set_get "$ID" role_arn)" --argjson extra "$(set_get "$ID" repo_settings | awk 'NF' | awk 'END { if (NR == 0) print "{}" } { print }')" --argjson ro "$1" \
    '{type: $type, settings: ((if $type == "azure" then {container: $bucket} else {bucket: $bucket} end) + {base_path: $base, readonly: $ro} + (if $role == "" then {} else {role_arn: $role} end) + $extra)}')"
  REPO_BODY="$f"
}
repo_there() { [[ -n "$(es_get "$1" "/_snapshot/$(snap_repo)")" ]]; }
sn_prepare() {
  local id="$1" n=0
  es_compatible
  if ! repo_there source; then repo_body false; es_send source PUT "/_snapshot/$(snap_repo)" "$REPO_BODY"; n=1; fi
  if ! repo_there target; then repo_body true; es_send target PUT "/_snapshot/$(snap_repo)" "$REPO_BODY"; n=1; fi
  if (( n == 0 )); then atk_skip "$id" "the repository is registered on both ($COMPAT)" prepared; fi
  atk_done "$id" prepared "repository $(snap_repo) registered (read-only on the target); $COMPAT"
}
snap_take() { # NAME
  local f
  if [[ -n "$(snap_state "$1")" ]]; then return 0; fi
  es_body f "$(jq -n --arg i "$(es_pattern)" '{indices: $i, include_global_state: false}')"
  es_send source PUT "/_snapshot/$(snap_repo)/$(snap_name "$1")?wait_for_completion=false" "$f"
}
snap_check() { if (( ! ATK_DRY_RUN )) && ! snap_done "$1"; then atk_fail "$ID" "snapshot $(snap_name "$1") ended $(snap_state "$1")"; fi; }
sn_replicate() {
  local id="$1"
  if [[ "$(es_st cutover)" == done ]]; then atk_skip "$id" "cut over" cut-over; fi
  if snap_done seed; then atk_skip "$id" "the seed snapshot is complete" in-sync inSync=true; fi
  snap_take seed
  if atk_wait_until 720 30 snap_ended seed; then
    snap_check seed
    atk_done "$id" in-sync "seed snapshot complete (an offline path: the final snapshot goes at cutover)" inSync=true
  fi
  atk_done "$id" replicating "the seed snapshot is running" inSync=false
}
sn_status() {
  local id="$1" s
  if [[ "$(es_st cutover)" == done ]]; then atk_skip "$id" "cut over (an offline path: nothing replicates)"; fi
  s="$(snap_state seed)"
  case "$s" in
    SUCCESS) atk_done "$id" in-sync "the seed snapshot is complete" inSync=true ;;
    "") atk_done "$id" "" "no seed snapshot yet" inSync=false ;;
    FAILED|PARTIAL|INCOMPATIBLE) atk_fail "$id" "the seed snapshot is $s" inSync=false ;;
  esac
  atk_done "$id" replicating "the seed snapshot is $s" inSync=false
}
restore() { # NAME [PREFIX]
  local f
  es_body f "$(jq -n --arg i "$(es_pattern)" --arg p "$\{2:-}" '{indices: $i, include_global_state: false} + (if $p == "" then {} else {rename_pattern: "(.+)", rename_replacement: ($p + "$1")} end)')"
  es_send target POST "/_snapshot/$(snap_repo)/$(snap_name "$1")/_restore" "$f"
}
no_red() { [[ -n "$(es_indices target "$1")" && -z "$(es_get target "/_cat/indices/$1?h=health" | awk '$1 == "red"')" ]]; }
sn_test() {
  local id="$1"
  if [[ -n "$(es_indices target 'atktest-*')" ]]; then atk_skip "$id" "the test copy (atktest-*) is on the target" testing; fi
  snap_done seed || (( ATK_DRY_RUN )) || atk_fail "$id" "no complete seed snapshot: run replicate first"
  restore seed atktest-
  atk_wait_until 120 20 no_red 'atktest-*' || atk_fail "$id" "the test restore has not finished"
  atk_done "$id" testing "the seed restored as atktest-* on the target"
}
sn_test_cleanup() {
  local id="$1" i passed=false
  local -a idx=()
  mapfile -t idx < <(es_indices target 'atktest-*')
  if (( $\{#idx[@]} == 0 )); then atk_skip "$id" "no test copy left"; fi
  if no_red 'atktest-*'; then passed=true; fi
  for i in "$\{idx[@]}"; do es_send target DELETE "/$i"; done
  atk_done "$id" tested "the test indices removed" passed="$passed"
}
sn_cutover() {
  local id="$1" i s t
  if [[ "$(es_st cutover)" == done ]]; then atk_skip "$id" "the final snapshot is restored" cut-over; fi
  snap_take final
  atk_wait_until 720 30 snap_ended final || atk_fail "$id" "the final snapshot has not finished: run cutover again"
  snap_check final
  if [[ -z "$(es_indices target)" ]]; then restore final; fi
  atk_wait_until 240 20 no_red "$(es_pattern)" || atk_fail "$id" "the restore has not finished: run cutover again"
  if (( ! ATK_DRY_RUN )); then
    for i in $(es_indices source); do
      s="$(es_count source "$i")"; t="$(es_count target "$i")"
      [[ "$s" == "$t" ]] || atk_fail "$id" "index $i: $s documents on the source, $\{t:-none} on the target"
    done
  fi
  es_put cutover done
  atk_done "$id" cut-over "the final snapshot restored and the document counts match: switch the clients"
}
sn_commit() { atk_done "$1" "" "committed: the source cluster stays until decommission"; }
sn_rollback() {
  if [[ "$(es_st cutover)" == done ]]; then es_put cutover rolled-back; fi
  atk_skip "$1" "the source was only snapshotted: it takes the writes again after the unfreeze; writes on the target since the cutover are not copied back" "" replication=lost
}
sn_finalize() {
  local id="$1" n=0 s
  for s in seed final; do
    if [[ -n "$(snap_state "$s")" ]]; then es_send source DELETE "/_snapshot/$(snap_repo)/$(snap_name "$s")"; n=$(( n + 1 )); fi
  done
  if repo_there target; then es_send target DELETE "/_snapshot/$(snap_repo)"; n=$(( n + 1 )); fi
  if repo_there source; then es_send source DELETE "/_snapshot/$(snap_repo)"; n=$(( n + 1 )); fi
  if (( n == 0 )); then atk_skip "$id" "the snapshots and the repository are already removed"; fi
  atk_done "$id" "" "the snapshots deleted and the repository deregistered on both ends"
}

# ---------------------------------------------------------------- es-reindex-remote

rx_allowed() { [[ "$(es_get target '/_nodes/settings?filter_path=nodes.*.settings.reindex')" == *"$(set_need "$ID" remote_host)"* ]]; }
rx_create() { # INDEX: the index on the target with the source's mappings and main settings
  local f
  es_body f "$(jq -c --arg i "$1" '.[$i] | {mappings: .mappings, settings: {index: (.settings.index | {number_of_shards, number_of_replicas} + (if .analysis then {analysis: .analysis} else {} end))}}' <<< "$(es_get source "/$1")")"
  es_send target PUT "/$1" "$f"
}
rx_same() { local a b; a="$(es_count source "$1")"; b="$(es_count target "$1")"; [[ -n "$a" && "$a" == "$b" ]]; }
rx_all_same() { local i; for i in $(es_indices source); do rx_same "$i" || return 1; done; }
rx_task_running() { local t; t="$(es_st "task.$1")"; [[ -n "$t" && "$(jq -r '.completed // empty' <<< "$(es_get target "/_tasks/$t")" 2> /dev/null)" == false ]]; }
# rx_copy INDEX: a reindex from the remote source into the target (asynchronous; the task id is kept). The source
# password goes in the request body, from a mode-600 runtime file, never an argument.
rx_copy() {
  local user pw f cfg url out t
  user="$(set_need "$ID" source_user)"
  secret_for pw ES_SOURCE_PASSWORD "$ID"
  atk_tmpfile f
  jq -n --arg h "$(set_need "$ID" source_url)" --arg u "$user" --arg p "$pw" --arg i "$1" \
    '{source: {remote: {host: $h, username: $u, password: $p}, index: $i}, dest: {index: $i}}' > "$f"
  es_cfg cfg target
  url="$(es_url target)"
  out="$(printf '%s' "$cfg" | atk_run curl -sS --fail --max-time 120 --config - -X POST -H 'Content-Type: application/json' --data-binary "@$f" "$url/_reindex?wait_for_completion=false")"
  t="$(jq -r '.task // empty' <<< "$out" 2> /dev/null || true)"
  if [[ -n "$t" ]]; then es_put "task.$1" "$t"; fi
}
rx_prepare() {
  local id="$1" i n=0
  rx_allowed || atk_fail "$id" "the target's reindex.remote.allowlist does not hold $(set_need "$id" remote_host): add it (elasticsearch.yml, or the domain's settings; runbook)"
  for i in $(es_indices source); do
    if [[ -z "$(es_indices target "$i")" ]]; then rx_create "$i"; n=$(( n + 1 )); fi
  done
  atk_done "$id" prepared "the target allows the source; $n indices created with the source's mappings"
}
rx_pass() { local i; RX_STARTED=0; for i in $(es_indices source); do if rx_same "$i" || rx_task_running "$i"; then continue; fi; rx_copy "$i"; RX_STARTED=$(( RX_STARTED + 1 )); done; }
rx_replicate() {
  local id="$1"
  if [[ "$(es_st cutover)" == done ]]; then atk_skip "$id" "cut over" cut-over; fi
  if rx_all_same; then atk_skip "$id" "the document counts match" in-sync inSync=true; fi
  rx_pass
  if atk_wait_until 720 60 rx_all_same; then atk_done "$id" in-sync "the document counts match ($RX_STARTED reindex tasks started)" inSync=true; fi
  atk_done "$id" replicating "$RX_STARTED reindex tasks running" inSync=false
}
rx_status() {
  local id="$1" i n=0 d=0
  if [[ "$(es_st cutover)" == done ]]; then atk_skip "$id" "cut over"; fi
  for i in $(es_indices source); do n=$(( n + 1 )); if ! rx_same "$i"; then d=$(( d + 1 )); fi; done
  if (( d == 0 && n > 0 )); then atk_done "$id" in-sync "$n indices, the document counts match" inSync=true; fi
  atk_done "$id" replicating "$d of $n indices differ" inSync=false
}
rx_test() { local passed=false; if rx_all_same; then passed=true; fi; atk_done "$1" testing "document counts compared: passed=$passed; query the target read-only" passed="$passed"; }
rx_test_cleanup() { local passed=false; if rx_all_same; then passed=true; fi; atk_done "$1" tested "nothing to remove" passed="$passed"; }
rx_cutover() {
  local id="$1"
  if [[ "$(es_st cutover)" == done ]]; then atk_skip "$id" "cut over" cut-over; fi
  rx_pass
  atk_wait_until 240 30 rx_all_same || atk_fail "$id" "the document counts do not match yet (are the writes frozen?): run cutover again"
  es_put cutover done
  atk_done "$id" cut-over "a last reindex pass done and the counts match: switch the clients (deletes on the source after the first pass are not carried over)"
}
rx_commit() { atk_done "$1" "" "committed: the source cluster stays until decommission"; }
rx_rollback() {
  if [[ "$(es_st cutover)" == done ]]; then es_put cutover rolled-back; fi
  atk_skip "$1" "the source was only read: writes on the target since the cutover are not copied back" "" replication=lost
}
rx_finalize() { atk_skip "$1" "nothing the kit made to remove: take the source out of reindex.remote.allowlist (runbook)"; }
`;

const ES_REPO: Readonly<Record<string, string>> = { aws: 's3', azure: 'azure', google: 'gcs', oci: 's3', vmware: 's3' };

const ES: Family = {
  id: 'es',
  paths: ['es-snapshot-restore', 'es-reindex-remote'],
  file: ES_FILE,
  summary: 'Elasticsearch / OpenSearch: snapshot and restore through the target cloud\'s object store (with a version check), or reindex from the remote source.',
  commands: ['curl', 'jq'],
  needs: [{ kind: 'command', name: 'curl', min: '7.75', why: 'Elasticsearch / OpenSearch: the REST APIs (--aws-sigv4 for Amazon OpenSearch Service)' }],
  specs: [
    { key: 'source_url', about: 'the source cluster URL (https://host:9200; IPv6 hosts in brackets)' },
    { key: 'target_url', about: 'the target URL (the domain or cluster endpoint)' },
    { key: 'source_auth', about: 'basic (source_user with ES_SOURCE_PASSWORD) or none' },
    { key: 'target_auth', about: 'basic, sigv4 (Amazon OpenSearch Service, AWS credentials in the environment) or none' },
    { key: 'source_user', about: 'the source user' },
    { key: 'target_user', about: 'the target user (basic)' },
    { key: 'region', about: 'sigv4: the target region' },
    { key: 'indices', about: 'the indices to move (a pattern list; dot indices are left out)' },
    { key: 'repo', about: 'snapshot: the repository name on both clusters', paths: ['es-snapshot-restore'] },
    { key: 'repo_type', about: 'snapshot: s3, azure or gcs (OCI: s3 with the S3-compatible endpoint in repo_settings)', paths: ['es-snapshot-restore'] },
    { key: 'bucket', about: 'snapshot: the bucket (or Azure container) in the target cloud', paths: ['es-snapshot-restore'] },
    { key: 'role_arn', about: 'snapshot (Amazon OpenSearch Service): the role the domain uses for the bucket', paths: ['es-snapshot-restore'] },
    { key: 'repo_settings', about: 'snapshot: extra repository settings as JSON (for example {"endpoint": "...", "client": "..."})', paths: ['es-snapshot-restore'] },
    { key: 'remote_host', about: 'reindex: the source host:port as the target\'s reindex.remote.allowlist holds it', paths: ['es-reindex-remote'] },
  ],
  rows: (items, ctx) => items.map((item) => {
    const h = hostsOf(item, ctx);
    const host = h.addr ? (h.addr.includes(':') ? `[${h.addr}]` : h.addr) : undefined;
    const managed = !onVm(item);
    const aws = serviceOf(item) === 'aws-opensearch';
    return {
      item,
      values: {
        source_url: host ? `https://${host}:9200` : undefined,
        target_url: managed ? undefined : (h.tgt ? `https://${h.tgt}:9200` : undefined),
        source_auth: 'basic', target_auth: aws ? 'sigv4' : 'basic', source_user: undefined, target_user: undefined,
        region: aws ? item.target.region : undefined,
        indices: '*,-.*',
        ...(item.path === 'es-snapshot-restore'
          ? { repo: `atk-${planId8(ctx.plan.id)}`, repo_type: ES_REPO[item.target.platform ?? ''] ?? 's3', bucket: undefined, role_arn: undefined, repo_settings: undefined }
          : { remote_host: host ? `${host}:9200` : undefined }),
      },
    };
  }),
  sh: ES_SH,
  verbs: everyVerb(dispatch({ 'es-reindex-remote': 'rx' }, 'sn', 'es_ctx')),
  usesHostStep: false,
  readme: {
    title: 'Elasticsearch / OpenSearch (es-snapshot-restore, es-reindex-remote)',
    intro: [
      'curl on the controller calls both clusters\' REST APIs; the credentials go to curl in its config on stdin (basic), or as SigV4 for Amazon OpenSearch Service (`--aws-sigv4`, the AWS credentials from the environment).',
      '**es-snapshot-restore**: a repository in the target cloud\'s object store (read-only on the target), a seed snapshot at replicate, the final snapshot after the freeze and its restore at cutover, document counts compared. prepare checks that the target can restore the source\'s snapshots (OpenSearch restores Elasticsearch 7.x up to 7.10.2 and 6.8; Elasticsearch the same major or the one before); otherwise use es-reindex-remote.',
      '**es-reindex-remote**: the target pulls each index from the source (`_reindex` with a remote source; the source must be in the target\'s `reindex.remote.allowlist`), after prepare created the indices with the source\'s mappings; later passes copy the indices whose counts differ. Deletes on the source are not carried over.',
    ],
    verbs: [
      '`prepare`: snapshot: the version check and the repository on both; reindex: the allowlist and the target indices.',
      '`replicate`: the seed snapshot; reindex: a pass over the differing indices.',
      '`status`: the seed snapshot; reindex: the indices whose counts differ.',
      '`test` / `test-cleanup`: snapshot: the seed restored as `atktest-*` on the target, then removed; reindex: counts compared.',
      '`cutover`: the final snapshot restored (or a last reindex pass); the counts must match.',
      '`commit`: records the point of no return.',
      '`rollback`: nothing to undo on the source; target writes since the cutover are lost.',
      '`finalize`: snapshot: the snapshots deleted and the repository deregistered; reindex: nothing (the allowlist entry is a runbook step).',
    ],
    credentials: ['`ES_SOURCE_PASSWORD`, `ES_TARGET_PASSWORD` (basic): in curl\'s config on stdin; the reindex body carries the source password from a mode-600 runtime file.', 'sigv4: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` in the environment (short-lived, from a role).'],
    environment: ['`ES_CA_FILE`: the CA for the clusters\' certificates.'],
    runbook: ['The repository plugin and its keystore credentials on the source nodes (repository-s3 / -azure / -gcs).', 'reindex.remote.allowlist on the target (a static setting).', 'Elastic Cloud targets are report-only.'],
    unconfirmed: ['The restore compatibility rules above against the installed versions.', 'A read-only repository registration on Amazon OpenSearch Service with `role_arn` from a SigV4-signed request.'],
  },
  findings: (items, ctx) => [
    ...noReverse(items, ['es-snapshot-restore', 'es-reindex-remote'], ES_FILE, 'snapshot and restore (or reindex)'),
    ...unknownSettings(ES.rows(items, ctx), ['source_url', 'target_url', 'source_user', 'bucket'], ES_FILE),
  ],
};

// ---------------------------------------------------------------------------
// The module's generators
// ---------------------------------------------------------------------------

/**
 * WP-17's database paths: db2-backup-restore, db2-hadr, ase-dump-load,
 * informix-backup-restore, mongo-mongosync, redis-replicaof, redis-rdb-import,
 * cassandra-zdm-proxy, cassandra-ring-join, es-snapshot-restore, es-reindex-remote.
 */
export const GENERATORS: readonly PathGenerator[] = Object.freeze([DB2, ASE, IFX, MONGO, REDIS, CASS, ES].map(generator));
