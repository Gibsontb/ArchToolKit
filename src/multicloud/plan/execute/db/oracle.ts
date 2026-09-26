/**
 * WP-11d: the Oracle paths (addendum A.6.8, A.6.9).
 *
 *   oracle-zdm-physical  Zero Downtime Migration, ONLINE_PHYSICAL (Data Guard underneath):
 *   oracle-zdm-logical   ONLINE_LOGICAL (Data Pump and GoldenGate); both run from the ZDM host
 *                        with `paths/db/zdm/<db>.rsp` (a template rendered at run time), `-eval`
 *                        at prepare, `-pauseafter` at replicate, `resume job` at cutover.
 *   oracle-dataguard     a physical standby by RMAN DUPLICATE FROM ACTIVE DATABASE, the broker,
 *                        switchover (and switchover back), through `ansible/db-oracle-dataguard.yml`
 *   oracle-rman          level 0 and level 1 backups rolled forward on the target, opened with
 *                        RESETLOGS at cutover, through `ansible/db-oracle-rman.yml`
 *   oracle-datapump      DBMS_DATAPUMP over a database link at an SCN (offline), from the controller
 *   oci-dms              OCI Database Migration: evaluate, start (waiting after the lag monitor), resume
 *
 * ZDM gives no automatic fallback: the physical fallback is a manual switchover back to the source
 * standby (SKIP_FALLBACK=FALSE keeps it), the logical one does not exist. The scripts say so at
 * cutover and rollback, and the kit's findings carry `exec.path.no-fallback` (paths.ts).
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import type { DbMovePath, DbServiceId } from '../../types.ts';
import type { ExecPath } from '../contract.ts';
import { code, shScript } from '../lib-sh.ts';
import type { ManifestItem } from '../manifest.ts';
import { NO_AUTO_FALLBACK } from '../paths.ts';
import type { PathContext, PathGenerator } from '../registry.ts';
import {
  BASE_SETTINGS, DB_DIR, DB_SH_BASE, dbReadme, dbRows, endpointFinding, need, noReverseFinding, onPath, ORA_SH, shSettings, withTestSkips,
  type DbRows, type DbSetting, type ReadmeItem,
} from './common.ts';

export const ORACLE_PATHS: readonly DbMovePath[] = Object.freeze(['oracle-zdm-physical', 'oracle-zdm-logical', 'oracle-dataguard', 'oracle-rman', 'oracle-datapump', 'oci-dms']);

const ZDM_FILE = `${DB_DIR}/oracle-zdm.sh`;
const ENTRY: Readonly<Record<string, string>> = Object.freeze({
  'oracle-zdm-physical': ZDM_FILE,
  'oracle-zdm-logical': ZDM_FILE,
  'oracle-dataguard': `${DB_DIR}/oracle-dataguard.sh`,
  'oracle-rman': `${DB_DIR}/oracle-rman.sh`,
  'oracle-datapump': `${DB_DIR}/oracle-datapump.sh`,
  'oci-dms': `${DB_DIR}/oci-dms.sh`,
});
export const DG_PLAYBOOK = 'ansible/db-oracle-dataguard.yml';
export const RMAN_PLAYBOOK = 'ansible/db-oracle-rman.yml';
/** The ZDM response file of an item (relative to `migration/execute/`). */
export const zdmRspFile = (item: ManifestItem): string => `${DB_DIR}/zdm/${item.resource}.rsp`;

// ---------------------------------------------------------------------------
// ZDM response files
// ---------------------------------------------------------------------------

/** ZDM's PLATFORM_TYPE for a target service. */
export function zdmPlatformType(service: DbServiceId | undefined): 'VMDB' | 'EXACS' | 'NON_CLOUD' {
  switch (service) {
    case 'oci-basedb': case 'google-odb-basedb': return 'VMDB';
    case 'oci-exacs': case 'aws-odb-exadata': case 'azure-odb-exadata': case 'google-odb-exadata': return 'EXACS';
    default: return 'NON_CLOUD';
  }
}

const RSP_HEAD = [
  '# Zero Downtime Migration response file. Values in {{...}} are filled at run time from',
  '# ATK_DB_<TOKEN>_<KEY> (or the values in the script) into a copy under status/work; this file holds no credential.',
  '# Reference: https://docs.oracle.com/en/database/oracle/zero-downtime-migration/21.5/zdmug/zero-downtime-migration-zdmcli-command-reference.html',
];

/**
 * The response file of an item. Physical: ONLINE_PHYSICAL over DIRECT
 * (RESTORE_FROM_SERVICE), the fallback kept (SKIP_FALLBACK=FALSE, the DG
 * configuration not cleaned up), the source not shut down. Logical:
 * ONLINE_LOGICAL over a database link to Autonomous Database.
 */
export function zdmResponseFile(item: ManifestItem): string {
  if (item.path === 'oracle-zdm-logical') {
    return [
      ...RSP_HEAD,
      'MIGRATION_METHOD=ONLINE_LOGICAL',
      'DATA_TRANSFER_MEDIUM=DBLINK',
      'DATAPUMPSETTINGS_DATABASELINKDETAILS_NAME=ATK_ZDM_LINK',
      'TARGETDATABASE_OCID={{target_ocid}}',
      'TARGETDATABASE_ADMINUSERNAME={{tgt_user}}',
      'SOURCEDATABASE_ADMINUSERNAME={{src_user}}',
      'SOURCEDATABASE_CONNECTIONDETAILS_HOST={{src_host}}',
      'SOURCEDATABASE_CONNECTIONDETAILS_PORT={{src_port}}',
      'SOURCEDATABASE_CONNECTIONDETAILS_SERVICENAME={{src_service}}',
      'SOURCEDATABASE_GGADMINUSERNAME=ggadmin',
      'TARGETDATABASE_GGADMINUSERNAME=ggadmin',
      'OCIAUTHENTICATIONDETAILS_REGIONID={{region}}',
      'OCIAUTHENTICATIONDETAILS_USERPRINCIPAL_TENANTID={{oci_tenancy}}',
      'OCIAUTHENTICATIONDETAILS_USERPRINCIPAL_USERID={{oci_user}}',
      'OCIAUTHENTICATIONDETAILS_USERPRINCIPAL_FINGERPRINT={{oci_fingerprint}}',
      'OCIAUTHENTICATIONDETAILS_USERPRINCIPAL_PRIVATEKEYFILE={{oci_key_file}}',
      'GOLDENGATEHUB_ADMINUSERNAME=oggadmin',
      'GOLDENGATEHUB_URL={{gg_url}}',
      'GOLDENGATEHUB_SOURCEDEPLOYMENTNAME={{gg_src_deployment}}',
      'GOLDENGATEHUB_TARGETDEPLOYMENTNAME={{gg_tgt_deployment}}',
      '',
    ].join('\n');
  }
  const exa = zdmPlatformType(item.target.service) === 'EXACS';
  return [
    ...RSP_HEAD,
    'MIGRATION_METHOD=ONLINE_PHYSICAL',
    'DATA_TRANSFER_MEDIUM=DIRECT',
    'ZDM_RMAN_DIRECT_METHOD=RESTORE_FROM_SERVICE',
    'TGT_DB_UNIQUE_NAME={{tgt_unique}}',
    `PLATFORM_TYPE=${zdmPlatformType(item.target.service)}`,
    `TGT_DATADG={{tgt_data_dg}}`,
    `TGT_REDODG={{tgt_reco_dg}}`,
    `TGT_RECODG={{tgt_reco_dg}}`,
    '# The fallback: the source stays a standby of the target after the switchover (it is not shut down,',
    '# and the Data Guard configuration is kept for the manual switchover back: ZDM does not reverse roles).',
    'SKIP_FALLBACK=FALSE',
    'SHUTDOWN_SRC=FALSE',
    'ZDM_SKIP_DG_CONFIG_CLEANUP=TRUE',
    '# TGT_RETAIN_DB_UNIQUE_NAME=TRUE   keeps the fallback through an observation period (verify on your ZDM release before enabling).',
    ...(exa ? ['# Exadata: the disk groups above are +DATAC1 / +RECOC1 by default; set ATK_DB_<TOKEN>_TGT_DATA_DG / _TGT_RECO_DG if yours differ.'] : []),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const lowerUnique = (name: string): string => name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'db';

function oracleExtra(path: DbMovePath): (i: ManifestItem) => Record<string, string> {
  return (i): Record<string, string> => {
    const host = i.source.host ?? '';
    const common = { src_service: i.name.toUpperCase(), tgt_service: '', schemas: '', parallel: '4' };
    switch (path) {
      case 'oracle-zdm-physical': {
        const exa = zdmPlatformType(i.target.service) === 'EXACS';
        return {
          ...common, src_unique: lowerUnique(i.name), tgt_unique: '', src_node: host, tgt_node: '', src_os_user: 'oracle', tgt_os_user: 'opc',
          tgt_data_dg: exa ? '+DATAC1' : '+DATA', tgt_reco_dg: exa ? '+RECOC1' : '+RECO',
          src_inventory_host: host ? `src-${host}` : '', tgt_inventory_host: '', src_oracle_home: '/u01/app/oracle/product/19.0.0/dbhome_1',
          src_sid: i.name.toUpperCase(), tgt_oracle_home: '', tgt_sid: '',
        };
      }
      case 'oracle-zdm-logical':
        return {
          ...common, src_unique: lowerUnique(i.name), src_node: host, src_os_user: 'oracle', target_ocid: '', oci_tenancy: '', oci_user: '',
          oci_fingerprint: '', oci_key_file: '', gg_url: '', gg_src_deployment: '', gg_tgt_deployment: '',
        };
      case 'oracle-dataguard':
      case 'oracle-rman':
        return {
          ...common, src_unique: lowerUnique(i.name), tgt_unique: `${lowerUnique(i.name).slice(0, 26)}_stb`, src_inventory_host: host ? `src-${host}` : '',
          tgt_inventory_host: host, src_oracle_home: '/u01/app/oracle/product/19.0.0/dbhome_1', tgt_oracle_home: '/u01/app/oracle/product/19.0.0/dbhome_1',
          src_sid: i.name.toUpperCase(), tgt_sid: i.name.toUpperCase(), backup_dir: `/backup/atk/${i.resource}`,
        };
      case 'oracle-datapump':
        return { ...common };
      case 'oci-dms':
        return { compartment: '', migration_id: '', migration_name: i.resource, engine_kind: i.engine === 'oracle' ? 'ORACLE' : 'MYSQL' };
      default:
        return {};
    }
  };
}

const ZDM_PHYS_SETTINGS: readonly DbSetting[] = [
  { key: 'src_unique', help: 'the source DB_UNIQUE_NAME' },
  { key: 'tgt_unique', help: 'the target DB_UNIQUE_NAME (the database the target service created)', required: true },
  { key: 'src_node', help: 'the source database host, as the ZDM host reaches it over SSH' },
  { key: 'tgt_node', help: 'the target database node, as the ZDM host reaches it over SSH', required: true },
  { key: 'src_os_user', help: 'the SSH user on the source (sudo to root and oracle)' },
  { key: 'tgt_os_user', help: 'the SSH user on the target' },
  { key: 'tgt_data_dg', help: 'the target data disk group' },
  { key: 'tgt_reco_dg', help: 'the target recovery disk group' },
  { key: 'src_inventory_host', help: 'the source in the Ansible inventory (the manual switchover back)' },
  { key: 'tgt_inventory_host', help: 'the target node in the Ansible inventory (the manual switchover back)', required: true },
  { key: 'src_oracle_home', help: 'ORACLE_HOME on the source' },
  { key: 'src_sid', help: 'ORACLE_SID on the source' },
  { key: 'tgt_oracle_home', help: 'ORACLE_HOME on the target node', required: true },
  { key: 'tgt_sid', help: 'ORACLE_SID on the target node', required: true },
];
const ZDM_LOG_SETTINGS: readonly DbSetting[] = [
  { key: 'src_unique', help: 'the source DB_UNIQUE_NAME' },
  { key: 'src_node', help: 'the source database host, as the ZDM host reaches it over SSH' },
  { key: 'src_os_user', help: 'the SSH user on the source' },
  { key: 'src_service', help: 'the source service name' },
  { key: 'target_ocid', help: 'the Autonomous Database OCID (Terraform output)', required: true },
  { key: 'oci_tenancy', help: 'the tenancy OCID of the OCI API user ZDM calls with', required: true },
  { key: 'oci_user', help: 'the OCI API user OCID', required: true },
  { key: 'oci_fingerprint', help: 'the API key fingerprint', required: true },
  { key: 'oci_key_file', help: 'the API private key file on the ZDM host (a path; never generated)', required: true },
  { key: 'gg_url', help: 'the OCI GoldenGate deployment URL', required: true },
  { key: 'gg_src_deployment', help: 'the GoldenGate deployment for the source', required: true },
  { key: 'gg_tgt_deployment', help: 'the GoldenGate deployment for the target', required: true },
];
const DG_SETTINGS: readonly DbSetting[] = [
  { key: 'src_unique', help: 'the primary DB_UNIQUE_NAME (the source)' },
  { key: 'tgt_unique', help: 'the standby DB_UNIQUE_NAME (the target)' },
  { key: 'src_inventory_host', help: 'the source host in the Ansible inventory' },
  { key: 'tgt_inventory_host', help: 'the rebuilt target host in the Ansible inventory' },
  { key: 'src_oracle_home', help: 'ORACLE_HOME on the source' },
  { key: 'tgt_oracle_home', help: 'ORACLE_HOME on the target (the oracle_db role, software only)' },
  { key: 'src_sid', help: 'ORACLE_SID on the source' },
  { key: 'tgt_sid', help: 'ORACLE_SID on the target' },
];
const RMAN_SETTINGS: readonly DbSetting[] = [
  ...DG_SETTINGS,
  { key: 'backup_dir', help: 'the backup location both hosts mount (NFS), for the level 0 / level 1 sets' },
];
const DP_SETTINGS: readonly DbSetting[] = [
  { key: 'src_service', help: 'the source service name', required: true },
  { key: 'tgt_service', help: 'the target service name (Autonomous Database: the _high / _tp service)', required: true },
  { key: 'schemas', help: 'the schemas to move (a comma list); empty: every schema the source does not maintain itself (12c and later)' },
  { key: 'parallel', help: 'Data Pump parallelism (Enterprise Edition)' },
];
const ODMS_SETTINGS: readonly DbSetting[] = [
  { key: 'compartment', help: 'the compartment OCID of the migration (or ATK_OCI_COMPARTMENT_ID)' },
  { key: 'migration_id', help: 'the migration OCID, when it is not found by name' },
  { key: 'migration_name', help: 'the display name of the migration (Terraform oci_database_migration_migration)' },
];

// ---------------------------------------------------------------------------
// oracle-zdm.sh
// ---------------------------------------------------------------------------

const ZDM_FUNCS = code`
DB_WAIT_MINUTES="$\{ATK_DB_WAIT_MINUTES:-720}"

zdm_cli() {
  local cli="$\{ZDM_HOME:-}/bin/zdmcli"
  [[ -n "$\{ZDM_HOME:-}" && -x "$cli" ]] || atk_die 3 "zdmcli not found: run this on the ZDM host with ZDM_HOME set"
  printf '%s' "$cli"
}
zdm_logical() { [[ "$\{ATK_ITEM_PATH[$1]}" == oracle-zdm-logical ]]; }
# zdm_rsp ID: the response file rendered for this run (settings filled in; no credential) under status/work.
zdm_rsp() {
  local id="$1" tpl text key val out
  tpl="$ATK_HOME/paths/db/zdm/$(atk_name "$id").rsp"
  [[ -f "$tpl" ]] || atk_die 1 "$(db_label "$id"): the response file $\{tpl##*/} is missing: regenerate the kit"
  text="$(< "$tpl")"
  for key in $(grep -o '{{[a-z0-9_]*}}' "$tpl" | tr -d '{}' | sort -u); do
    val="$(db_need "$id" "$key")"
    text="$\{text//"{{$key}}"/"$val"}"
  done
  out="$(db_work "$id")/zdm.rsp"
  printf '%s\n' "$text" > "$out"
  chmod 600 "$out"
  printf '%s' "$out"
}
# zdm_args ID: the zdmcli migrate database arguments (the SSH key and the wallet are paths from the environment).
zdm_args() {
  local id="$1" key="$\{ZDM_SSH_KEY:-}"
  [[ -n "$key" ]] || atk_die 3 "set ZDM_SSH_KEY: the private key file the ZDM host uses to reach the database hosts"
  printf '%s\n' migrate database -sourcedb "$(db_need "$id" src_unique)" -sourcenode "$(db_need "$id" src_node)" \
    -srcauth zdmauth -srcarg1 "user:$(db_need "$id" src_os_user)" -srcarg2 "identity_file:$key" -srcarg3 sudo_location:/usr/bin/sudo
  if ! zdm_logical "$id"; then
    printf '%s\n' -targetnode "$(db_need "$id" tgt_node)" -tgtauth zdmauth -tgtarg1 "user:$(db_need "$id" tgt_os_user)" -tgtarg2 "identity_file:$key" -tgtarg3 sudo_location:/usr/bin/sudo
    [[ -n "$\{ZDM_SRC_WALLET:-}" ]] || atk_die 3 "set ZDM_SRC_WALLET: the auto-login wallet holding the source SYS password (mkstore, on the ZDM host)"
    printf '%s\n' -sourcesyswallet "$ZDM_SRC_WALLET"
  fi
  printf '%s\n' -rsp "$(zdm_rsp "$id")"
}
# zdm_stdin ID: what zdmcli reads on stdin: nothing for physical (the wallet); for logical the passwords it asks for, in order:
# the source admin, the target admin, the source and target GoldenGate admins (verify the order with -eval on your release).
zdm_stdin() {
  local id="$1" spw tpw gpw
  if zdm_logical "$id"; then
    db_secret_to spw SRC "$id"
    db_secret_to tpw TGT "$id"
    atk_secret_to gpw "GG_DB_PASSWORD_$\{DB_TOK[$id]}"
    printf '%s\n%s\n%s\n%s\n' "$spw" "$tpw" "$gpw" "$gpw"
  fi
}
zdm_pause_phase() { if zdm_logical "$1"; then printf ZDM_MONITOR_GG_LAG; else printf ZDM_CONFIGURE_DG_SRC; fi; }
zdm_switch_phase() { if zdm_logical "$1"; then printf ZDM_SWITCHOVER_APP; else printf ZDM_SWITCHOVER_SRC; fi; }
zdm_job_key() { printf '%s.%s' "$1" "$2"; }
zdm_job() { atk_ids_get "$\{ATK_ITEM_PATH[$1]}" "$(zdm_job_key "$1" "$2")" 2>/dev/null || true; }
zdm_query() { "$(zdm_cli)" query job -jobid "$1" 2>/dev/null || true; }
# zdm_job_status JOB: EXECUTING, PAUSED, SUCCEEDED, FAILED, ABORTED ... ("" when unknown).
zdm_job_status() { zdm_query "$1" | sed -n 's/^[[:space:]]*Current status:[[:space:]]*\([A-Z_]*\).*/\1/p' | head -n 1; }
zdm_phase_done() { zdm_query "$1" | grep -Eq "^[[:space:]]*$2[[:space:]]+\.*[[:space:]]*COMPLETED"; }
zdm_terminal() { [[ "$(zdm_job_status "$1")" =~ ^(SUCCEEDED|FAILED|ABORTED|PAUSED)$ ]]; }
zdm_paused() { [[ "$(zdm_job_status "$1")" == PAUSED ]]; }
zdm_succeeded() { [[ "$(zdm_job_status "$1")" == SUCCEEDED ]]; }
# zdm_submit ID KIND ARGS...: submit a job and record its id (eval or migrate).
zdm_submit() {
  local id="$1" kind="$2" out job
  shift 2
  local -a args
  mapfile -t args < <(zdm_args "$id")
  db_changed
  out="$(zdm_stdin "$id" | atk_run "$(zdm_cli)" "$\{args[@]}" "$@")"
  job="$(sed -n 's/.*job ID "\{0,1\}\([0-9][0-9]*\)"\{0,1\}.*/\1/p' <<< "$out" | head -n 1)"
  if (( ATK_DRY_RUN )); then printf 'dry-run'; return 0; fi
  [[ -n "$job" ]] || atk_die 1 "$(db_label "$id"): zdmcli returned no job id"
  atk_ids_put "$\{ATK_ITEM_PATH[$id]}" "$(zdm_job_key "$id" "$kind")" "$job"
  printf '%s' "$job"
}
zdm_warn_fallback() {
  if zdm_logical "$1"; then
    atk_log "$(db_label "$1"): no automatic fallback: ZDM (logical) sets up no reverse replication, so a rollback after the switchover loses the target's writes"
  else
    atk_log "$(db_label "$1"): no automatic fallback: ZDM does not handle reverse role switches; the source stays a standby (SKIP_FALLBACK=FALSE) and rollback switches over back by hand (ansible/db-oracle-dataguard.yml)"
  fi
}
zdm_status() {
  local id="$1" job st
  job="$(zdm_job "$id" migrate)"
  [[ -n "$job" ]] || atk_done "$id" planned "no ZDM migration job yet" inSync=false
  st="$(zdm_job_status "$job")"
  case "$st" in
    PAUSED) atk_done "$id" in-sync "ZDM job $job paused after $(zdm_pause_phase "$id")" inSync=true zdmJob="$job" ;;
    SUCCEEDED) atk_done "$id" cut-over "ZDM job $job succeeded" zdmJob="$job" ;;
    FAILED|ABORTED) atk_fail "$id" "ZDM job $job is $st (zdmcli query job -jobid $job)" ;;
    *) atk_done "$id" replicating "ZDM job $job is $\{st:-running}" inSync=false zdmJob="$job" ;;
  esac
}
# The manual fallback of the physical path: the Data Guard playbook, in SQL mode (ZDM configures no broker).
zdm_dg() {
  local id="$1" action="$2"
  db_changed
  atk_run ansible-playbook -i "$\{ATK_ANSIBLE_INVENTORY:-$ATK_ROOT/ansible/inventory}" "$ATK_HOME/${DG_PLAYBOOK}" \
    -e "dg_action=$action" -e dg_mode=sql \
    -e "dg_primary_host=$(db_need "$id" tgt_inventory_host)" -e "dg_standby_host=$(db_need "$id" src_inventory_host)" \
    -e "dg_primary_unique=$(db_need "$id" tgt_unique)" -e "dg_standby_unique=$(db_need "$id" src_unique)" \
    -e "dg_primary_home=$(db_need "$id" tgt_oracle_home)" -e "dg_standby_home=$(db_need "$id" src_oracle_home)" \
    -e "dg_primary_sid=$(db_need "$id" tgt_sid)" -e "dg_standby_sid=$(db_need "$id" src_sid)"
}
`;

const ZDM_VERBS = withTestSkips({
  prepare: code`
zdm_cli > /dev/null
job="$(zdm_job "$id" eval)"
if [[ -n "$job" ]] && zdm_succeeded "$job"; then atk_skip "$id" "ZDM evaluation job $job already succeeded" prepared zdmJob="$job"; fi
if [[ -z "$job" ]] || [[ "$(zdm_job_status "$job")" =~ ^(FAILED|ABORTED)$ ]]; then job="$(zdm_submit "$id" eval -eval)"; fi
if [[ "$job" == dry-run ]]; then atk_done "$id" prepared "the evaluation job would be submitted"; fi
atk_wait_until 180 30 zdm_terminal "$job" || atk_fail "$id" "the ZDM evaluation job $job did not finish"
zdm_succeeded "$job" || atk_fail "$id" "the ZDM evaluation job $job is $(zdm_job_status "$job"): zdmcli query job -jobid $job"
atk_done "$id" prepared "the ZDM evaluation (-eval) succeeded" zdmJob="$job"`,
  replicate: code`
job="$(zdm_job "$id" migrate)"
if [[ -z "$job" ]] || [[ "$(zdm_job_status "$job")" =~ ^(ABORTED)$ ]]; then
  job="$(zdm_submit "$id" migrate -pauseafter "$(zdm_pause_phase "$id")")"
elif [[ "$(zdm_job_status "$job")" == FAILED ]]; then
  db_changed
  atk_run "$(zdm_cli)" resume job -jobid "$job" -pauseafter "$(zdm_pause_phase "$id")"
fi
if [[ "$job" == dry-run ]]; then atk_done "$id" replicating "the migration job would be submitted, pausing after $(zdm_pause_phase "$id")"; fi
atk_wait_until "$DB_WAIT_MINUTES" 60 zdm_paused "$job" || true
zdm_status "$id"`,
  status: 'zdm_status "$id"',
  cutover: code`
job="$(zdm_job "$id" migrate)"
[[ -n "$job" ]] || atk_fail "$id" "no ZDM migration job: run replicate first"
if zdm_succeeded "$job"; then atk_skip "$id" "ZDM job $job already succeeded" cut-over zdmJob="$job"; fi
zdm_warn_fallback "$id"
if zdm_paused "$job"; then
  db_changed
  atk_run "$(zdm_cli)" resume job -jobid "$job"
fi
atk_wait_until 240 30 zdm_terminal "$job" || atk_fail "$id" "ZDM job $job did not finish the switchover in time (zdmcli query job -jobid $job)"
zdm_succeeded "$job" || atk_fail "$id" "ZDM job $job is $(zdm_job_status "$job") (zdmcli query job -jobid $job)"
atk_done "$id" cut-over "ZDM switched over; no automatic fallback (see the rollback verb)" zdmJob="$job" fallback=manual`,
  commit: 'atk_skip "$id" "ZDM ran its post-migration phases at cutover; the fallback standby stays until finalize"',
  rollback: code`
job="$(zdm_job "$id" migrate)"
[[ -n "$job" ]] || atk_skip "$id" "nothing to roll back: no ZDM job ran"
if ! zdm_phase_done "$job" "$(zdm_switch_phase "$id")"; then
  st="$(zdm_job_status "$job")"
  if [[ "$st" =~ ^(ABORTED)$ ]]; then atk_skip "$id" "ZDM job $job is already aborted"; fi
  db_changed
  atk_run "$(zdm_cli)" abort job -jobid "$job"
  atk_done "$id" "" "ZDM job $job aborted before the switchover; the source is unchanged"
fi
zdm_warn_fallback "$id"
if zdm_logical "$id"; then
  atk_done "$id" "" "past the switchover: ZDM (logical) has no way back; the source is as it was at the switchover and the target's writes since are not carried back"
fi
zdm_dg "$id" switchover-back
atk_done "$id" "" "switched back to the source by hand (Data Guard, the source was kept as a standby): switch the applications back"`,
  finalize: code`
if zdm_logical "$id"; then atk_skip "$id" "ZDM's cleanup phases removed the GoldenGate and Data Pump objects"; fi
zdm_dg "$id" remove
db_finish "$id" "" "the Data Guard link to the old source is removed on the target (the old source is dropped at decommission)"`,
});

// ---------------------------------------------------------------------------
// oracle-dataguard.sh and oracle-rman.sh (Ansible on the database hosts)
// ---------------------------------------------------------------------------

const DG_FUNCS = code`
DB_WAIT_MINUTES="$\{ATK_DB_WAIT_MINUTES:-720}"

# dg_play ID ACTION [k=v...]: the Data Guard playbook for this database (broker mode), its result in status/work.
dg_play() {
  local id="$1" action="$2"
  shift 2
  local -a extra=()
  local kv
  for kv in "$@"; do extra+=(-e "$kv"); done
  DB_CHANGED=1
  atk_run ansible-playbook -i "$\{ATK_ANSIBLE_INVENTORY:-$ATK_ROOT/ansible/inventory}" "$ATK_HOME/${DG_PLAYBOOK}" \
    -e "dg_action=$action" -e dg_mode=broker -e "atk_result_file=$(db_work "$id")/dg.json" \
    -e "dg_primary_host=$(db_need "$id" src_inventory_host)" -e "dg_standby_host=$(db_need "$id" tgt_inventory_host)" \
    -e "dg_primary_unique=$(db_need "$id" src_unique)" -e "dg_standby_unique=$(db_need "$id" tgt_unique)" \
    -e "dg_primary_home=$(db_need "$id" src_oracle_home)" -e "dg_standby_home=$(db_need "$id" tgt_oracle_home)" \
    -e "dg_primary_sid=$(db_need "$id" src_sid)" -e "dg_standby_sid=$(db_need "$id" tgt_sid)" "$\{extra[@]}"
}
dg_result() { local f; f="$(db_work "$1")/dg.json"; [[ -f "$f" ]] && jq -r "$2 // empty" "$f"; }
dg_status() {
  local id="$1" lag role
  dg_play "$id" status
  if (( ATK_DRY_RUN )); then atk_done "$id" "" "the Data Guard state is not read in a dry run"; fi
  lag="$(dg_result "$id" .applyLagSeconds)"
  role="$(dg_result "$id" .standbyRole)"
  if [[ "$role" == PRIMARY ]]; then atk_done "$id" cut-over "the standby is the primary" role="$role"; fi
  if [[ "$role" != "PHYSICAL STANDBY" ]]; then atk_done "$id" planned "no standby yet" inSync=false; fi
  if db_lag_ok "$lag"; then atk_done "$id" in-sync "apply lag $\{lag}s" inSync=true lagSeconds="$lag"; fi
  atk_done "$id" replicating "apply lag $\{lag:-?}s" inSync=false lagSeconds="$\{lag:-0}"
}
`;

const DG_VERBS = withTestSkips({
  prepare: code`
dg_play "$id" prepare
atk_done "$id" prepared "the primary logs in force-logging mode with the broker on; the standby host has the password file, the aliases and a static listener entry"`,
  replicate: code`
dg_play "$id" duplicate
dg_play "$id" broker
dg_status "$id"`,
  status: 'dg_status "$id"',
  cutover: code`
dg_play "$id" switchover
atk_done "$id" cut-over "the broker validated the standby and switched over; the old primary is now the standby (the way back)"`,
  commit: 'atk_skip "$id" "nothing to commit: the old primary stays a standby until finalize"',
  rollback: code`
dg_play "$id" switchover-back
atk_done "$id" "" "switched back to the source with no data loss (it was the standby): switch the applications back"`,
  finalize: code`
dg_play "$id" remove
atk_done "$id" "" "the broker configuration is removed; the old primary is dropped at decommission"`,
});

const RMAN_FUNCS = code`
DB_WAIT_MINUTES="$\{ATK_DB_WAIT_MINUTES:-720}"

rman_play() {
  local id="$1" action="$2"
  DB_CHANGED=1
  atk_run ansible-playbook -i "$\{ATK_ANSIBLE_INVENTORY:-$ATK_ROOT/ansible/inventory}" "$ATK_HOME/${RMAN_PLAYBOOK}" \
    -e "rman_action=$action" -e "atk_result_file=$(db_work "$id")/rman.json" -e "rman_dir=$(db_need "$id" backup_dir)" \
    -e "rman_source_host=$(db_need "$id" src_inventory_host)" -e "rman_target_host=$(db_need "$id" tgt_inventory_host)" \
    -e "rman_source_home=$(db_need "$id" src_oracle_home)" -e "rman_target_home=$(db_need "$id" tgt_oracle_home)" \
    -e "rman_source_sid=$(db_need "$id" src_sid)" -e "rman_target_sid=$(db_need "$id" tgt_sid)"
}
rman_result() { local f; f="$(db_work "$1")/rman.json"; [[ -f "$f" ]] && jq -r "$2 // empty" "$f"; }
rman_status() {
  local id="$1" scn mode
  rman_play "$id" status
  if (( ATK_DRY_RUN )); then atk_done "$id" "" "the target state is not read in a dry run"; fi
  scn="$(rman_result "$id" .checkpointScn)"
  mode="$(rman_result "$id" .openMode)"
  if [[ "$mode" == "READ WRITE" ]]; then atk_done "$id" cut-over "the target is open"; fi
  if [[ -z "$scn" ]]; then atk_done "$id" planned "nothing restored yet" inSync=false; fi
  atk_done "$id" in-sync "the target is rolled forward to SCN $scn (the last level 1)" inSync=true scn="$scn"
}
`;

const RMAN_VERBS = withTestSkips({
  prepare: code`
rman_play "$id" prepare
atk_done "$id" prepared "the backup location is mounted on both hosts and the source is in ARCHIVELOG mode"`,
  replicate: code`
if [[ "$(db_phase "$id")" == cut-over ]]; then atk_skip "$id" "already cut over" cut-over; fi
rman_play "$id" level0
rman_play "$id" restore
rman_play "$id" level1
rman_play "$id" recover
rman_status "$id"`,
  status: 'rman_status "$id"',
  cutover: code`
if [[ "$(db_phase "$id")" == cut-over ]]; then atk_skip "$id" "already opened" cut-over; fi
rman_play "$id" final
rman_play "$id" open
db_phase "$id" cut-over
atk_done "$id" cut-over "the final level 1 and archived logs applied; the target is open (RESETLOGS)"`,
  commit: 'atk_skip "$id" "nothing to commit: the source is unchanged until decommission"',
  rollback: 'atk_skip "$id" "nothing to roll back: the source was only frozen and is unchanged (RMAN only read it); the target is kept for analysis"',
  finalize: code`
rman_play "$id" remove
atk_done "$id" "" "the backup sets are removed from the backup location"`,
});

// ---------------------------------------------------------------------------
// oracle-datapump.sh (DBMS_DATAPUMP over a database link, from the controller)
// ---------------------------------------------------------------------------

const DP_VERBS = withTestSkips({
  prepare: code`
ora_link "$id"
[[ "$(ora_q "$id" tgt "SELECT 1 FROM dual@ATK_SRC;")" == 1 ]] || atk_die 5 "$(db_label "$id"): the database link ATK_SRC does not reach the source"
schemas="$(ora_schemas "$id")"
db_finish "$id" prepared "the link ATK_SRC reaches the source; schemas: $schemas"`,
  replicate: 'atk_skip "$id" "an offline path: the import runs at cutover, after the freeze"',
  status: 'atk_skip "$id" "an offline path: nothing replicates"',
  cutover: code`
if [[ "$(db_phase "$id")" == cut-over ]]; then atk_skip "$id" "already imported" cut-over; fi
scn="$(ora_scn "$id")"
[[ "$scn" =~ ^[0-9]+$ ]] || atk_die 1 "$(db_label "$id"): could not read the source SCN over ATK_SRC"
ora_import "$id" "$scn" 1
db_phase "$id" cut-over
atk_done "$id" cut-over "imported over ATK_SRC as of SCN $scn" scn="$scn"`,
  commit: 'atk_skip "$id" "nothing to commit on an offline path"',
  rollback: 'atk_skip "$id" "nothing to roll back: the source was only frozen and is unchanged; the target is kept for analysis"',
  finalize: code`
ora_drop_link "$id"
db_finish "$id" "" "the database link ATK_SRC is dropped"`,
});

// ---------------------------------------------------------------------------
// oci-dms.sh
// ---------------------------------------------------------------------------

const ODMS_FUNCS = code`
DB_WAIT_MINUTES="$\{ATK_DB_WAIT_MINUTES:-720}"

odms_compartment() {
  local c
  c="$(db_get "$1" compartment)"
  [[ -n "$c" ]] || c="$\{ATK_OCI_COMPARTMENT_ID:-}"
  [[ -n "$c" ]] || atk_die 5 "set ATK_OCI_COMPARTMENT_ID (or ATK_DB_$\{DB_TOK[$1]}_COMPARTMENT): the compartment of the migration"
  printf '%s' "$c"
}
# odms_id ID: the migration OCID (by name, re-derived each run).
odms_id() {
  local m
  m="$(db_get "$1" migration_id)"
  if [[ -z "$m" ]]; then
    m="$(oci database-migration migration list --compartment-id "$(odms_compartment "$1")" --display-name "$(db_need "$1" migration_name)" --all --output json 2>/dev/null \
      | jq -r '[(.data.items // .data // [])[] | select(."lifecycle-state" != "DELETED")][0].id // empty')"
  fi
  [[ -n "$m" ]] || atk_die 5 "$(db_label "$1"): no OCI migration named $(db_get "$1" migration_name): apply terraform (oci_mig_replication) or set ATK_DB_$\{DB_TOK[$1]}_MIGRATION_ID"
  printf '%s' "$m"
}
# odms_job ID TYPE: the latest job of that type (EVALUATION, MIGRATION) as JSON ("null" when none).
odms_job() {
  oci database-migration job list --migration-id "$(odms_id "$1")" --all --output json 2>/dev/null \
    | jq -c --arg t "$2" '[(.data.items // .data // [])[] | select((.type // "") == $t)] | sort_by(."time-created") | last // null'
}
# odms_state ID TYPE: STATE/PHASE of the latest job (e.g. WAITING/ODMS_MONITOR_REPLICATION_LAG).
odms_state() { odms_job "$1" "$2" | jq -r 'if . == null then "NONE/" else ((."lifecycle-state" // "") + "/" + (.progress."current-phase" // "")) end'; }
odms_in_sync() { [[ "$(odms_state "$1" MIGRATION)" == WAITING/ODMS_MONITOR_REPLICATION_LAG ]]; }
odms_done() { [[ "$(odms_state "$1" "$2")" =~ ^(SUCCEEDED|FAILED|CANCELED|TERMINATED)/ ]]; }
odms_status() {
  local id="$1" st
  st="$(odms_state "$id" MIGRATION)"
  case "$st" in
    NONE/*) atk_done "$id" planned "no migration job yet" inSync=false ;;
    WAITING/ODMS_MONITOR_REPLICATION_LAG) atk_done "$id" in-sync "the job waits after the lag monitor" inSync=true phase=ODMS_MONITOR_REPLICATION_LAG ;;
    SUCCEEDED/*) atk_done "$id" cut-over "the migration job succeeded" ;;
    FAILED/*|CANCELED/*|TERMINATED/*) atk_fail "$id" "the migration job is $st" ;;
    *) atk_done "$id" replicating "the migration job is $st" inSync=false phase="$\{st#*/}" ;;
  esac
}
`;

const ODMS_VERBS = withTestSkips({
  prepare: code`
atk_need oci
st="$(odms_state "$id" EVALUATION)"
if [[ "$st" == SUCCEEDED/* ]]; then atk_skip "$id" "the evaluation already succeeded" prepared; fi
if [[ "$st" == NONE/* || "$st" =~ ^(FAILED|CANCELED)/ ]]; then
  db_changed
  atk_run oci database-migration migration evaluate --migration-id "$(odms_id "$id")" --output json > /dev/null
fi
if (( ATK_DRY_RUN )); then atk_done "$id" prepared "the evaluation would run"; fi
atk_wait_until 120 30 odms_done "$id" EVALUATION || atk_fail "$id" "the evaluation did not finish"
[[ "$(odms_state "$id" EVALUATION)" == SUCCEEDED/* ]] || atk_fail "$id" "the evaluation is $(odms_state "$id" EVALUATION): see the job's phases in the console"
atk_done "$id" prepared "the evaluation succeeded"`,
  replicate: code`
st="$(odms_state "$id" MIGRATION)"
if [[ "$st" == NONE/* || "$st" =~ ^(FAILED|CANCELED)/ ]]; then
  db_changed
  atk_run oci database-migration migration start --migration-id "$(odms_id "$id")" --wait-after ODMS_MONITOR_REPLICATION_LAG --output json > /dev/null
fi
atk_wait_until "$DB_WAIT_MINUTES" 60 odms_in_sync "$id" || true
odms_status "$id"`,
  status: 'odms_status "$id"',
  cutover: code`
st="$(odms_state "$id" MIGRATION)"
if [[ "$st" == SUCCEEDED/* ]]; then atk_skip "$id" "the migration job already succeeded" cut-over; fi
[[ "$st" == WAITING/* ]] || atk_fail "$id" "the migration job is $st, not waiting after the lag monitor; nothing was switched"
job="$(odms_job "$id" MIGRATION | jq -r .id)"
db_changed
atk_run oci database-migration job resume --job-id "$job" --output json > /dev/null
atk_wait_until 240 30 odms_done "$id" MIGRATION || atk_fail "$id" "the switchover did not finish in time"
[[ "$(odms_state "$id" MIGRATION)" == SUCCEEDED/* ]] || atk_fail "$id" "the migration job is $(odms_state "$id" MIGRATION)"
atk_done "$id" cut-over "switched over and cleaned up (ODMS_SWITCHOVER, ODMS_CLEANUP)"`,
  commit: 'atk_skip "$id" "nothing to commit: OCI Database Migration has no reverse replication to keep"',
  rollback: code`
st="$(odms_state "$id" MIGRATION)"
case "$st" in
  NONE/*) atk_skip "$id" "nothing to roll back: no migration job ran" ;;
  SUCCEEDED/*) atk_done "$id" "" "past the switchover: OCI Database Migration has no reverse replication; the source is as it was at the freeze and the target's writes are not carried back" ;;
  FAILED/*|CANCELED/*|TERMINATED/*) atk_skip "$id" "the migration job is already $st; the source is unchanged" ;;
esac
job="$(odms_job "$id" MIGRATION | jq -r .id)"
db_changed
atk_run oci database-migration job abort --job-id "$job" --output json > /dev/null
atk_done "$id" "" "the migration job is aborted before the switchover; the source is unchanged"`,
  finalize: 'atk_skip "$id" "ODMS_CLEANUP removed the replication objects; the migration and its connections are removed from Terraform on the next apply"',
});

// ---------------------------------------------------------------------------
// The playbooks
// ---------------------------------------------------------------------------

/** `ansible/db-oracle-dataguard.yml`: the Data Guard steps of the dataguard path and the ZDM fallback. */
export function dataGuardPlaybook(): string {
  return `# The execution kit's Oracle Data Guard steps: the oracle-dataguard path (broker mode) and the manual
# fallback of ZDM physical (sql mode: ZDM configures no broker). Run by paths/db/*.sh with -e dg_action=...
# Credentials: vault_oracle_sys_password (Ansible Vault), passed on stdin with no_log; nothing is written but the result file.
# Actions: prepare, duplicate, broker, status, switchover, switchover-back, remove. Each reads the state first.
- name: Oracle Data Guard ({{ dg_action }})
  hosts: "{{ dg_primary_host }}:{{ dg_standby_host }}"
  gather_facts: false
  become: true
  become_user: oracle
  vars:
    dg_mode: broker
    dg_is_primary: "{{ inventory_hostname == dg_primary_host }}"
    dg_home: "{{ dg_primary_home if dg_is_primary | bool else dg_standby_home }}"
    dg_sid: "{{ dg_primary_sid if dg_is_primary | bool else dg_standby_sid }}"
    dg_env:
      ORACLE_HOME: "{{ dg_home }}"
      ORACLE_SID: "{{ dg_sid }}"
      PATH: "{{ dg_home }}/bin:/usr/bin:/bin"
    dg_sqlplus: ["{{ dg_home }}/bin/sqlplus", "-S", "-L", "/", "as", "sysdba"]
    dg_quiet: "SET HEADING OFF FEEDBACK OFF PAGESIZE 0 LINESIZE 400 VERIFY OFF\\n"
  tasks:
    - name: Check the action and the vault variable
      ansible.builtin.assert:
        that:
          - dg_action in ['prepare', 'duplicate', 'broker', 'status', 'switchover', 'switchover-back', 'remove']
          - dg_mode in ['broker', 'sql']
          - vault_oracle_sys_password is defined
      no_log: true

    - name: Read the role and open mode
      ansible.builtin.command:
        argv: "{{ dg_sqlplus }}"
        stdin: "{{ dg_quiet }}SELECT database_role || '|' || open_mode FROM v$database;\\nEXIT;"
      environment: "{{ dg_env }}"
      register: dg_state
      changed_when: false
      failed_when: false

    - name: Keep the role
      ansible.builtin.set_fact:
        dg_role: "{{ (dg_state.stdout | default('') | trim).split('|')[0] if '|' in (dg_state.stdout | default('')) else 'NOT MOUNTED' }}"

    # ---------------------------------------------------------------- prepare (broker mode)
    - name: Check ARCHIVELOG mode on the primary
      ansible.builtin.command:
        argv: "{{ dg_sqlplus }}"
        stdin: "{{ dg_quiet }}SELECT log_mode FROM v$database;\\nEXIT;"
      environment: "{{ dg_env }}"
      register: dg_logmode
      changed_when: false
      failed_when: "'ARCHIVELOG' != (dg_logmode.stdout | trim)"
      when: dg_action == 'prepare' and dg_is_primary | bool

    - name: Force logging, the broker and standby redo logs on the primary
      ansible.builtin.command:
        argv: "{{ dg_sqlplus }}"
        stdin: |
          WHENEVER SQLERROR EXIT FAILURE
          SET SERVEROUTPUT ON
          DECLARE
            n NUMBER; s NUMBER; g NUMBER; changed NUMBER := 0;
          BEGIN
            SELECT COUNT(*) INTO n FROM v$database WHERE force_logging = 'YES';
            IF n = 0 THEN EXECUTE IMMEDIATE 'ALTER DATABASE FORCE LOGGING'; changed := 1; END IF;
            SELECT COUNT(*) INTO n FROM v$parameter WHERE name = 'dg_broker_start' AND value = 'TRUE';
            IF n = 0 THEN EXECUTE IMMEDIATE 'ALTER SYSTEM SET dg_broker_start = TRUE SCOPE = BOTH'; changed := 1; END IF;
            SELECT COUNT(*) INTO n FROM v$standby_log;
            IF n = 0 THEN
              SELECT MAX(bytes), COUNT(*) + 1 INTO s, g FROM v$log;
              FOR i IN 1 .. g LOOP EXECUTE IMMEDIATE 'ALTER DATABASE ADD STANDBY LOGFILE SIZE ' || s; END LOOP;
              changed := 1;
            END IF;
            DBMS_OUTPUT.PUT_LINE('ATK_CHANGED=' || changed);
          END;
          /
          EXIT;
      environment: "{{ dg_env }}"
      register: dg_prep
      changed_when: "'ATK_CHANGED=1' in dg_prep.stdout"
      when: dg_action == 'prepare' and dg_is_primary | bool

    - name: Read the primary's password file
      ansible.builtin.slurp:
        src: "{{ dg_home }}/dbs/orapw{{ dg_sid }}"
      register: dg_orapw
      no_log: true
      when: dg_action == 'prepare' and dg_is_primary | bool

    - name: Copy the password file to the standby (the same SYS password, as Data Guard needs)
      ansible.builtin.copy:
        content: "{{ hostvars[dg_primary_host].dg_orapw.content | b64decode }}"
        dest: "{{ dg_home }}/dbs/orapw{{ dg_sid }}"
        mode: "0640"
      no_log: true
      when: dg_action == 'prepare' and not dg_is_primary | bool

    - name: The connect aliases of both databases (tnsnames.ora, IPv4 or IPv6)
      ansible.builtin.blockinfile:
        path: "{{ dg_home }}/network/admin/tnsnames.ora"
        create: true
        mode: "0644"
        marker: "# {mark} atk data guard"
        block: |
          {{ dg_primary_unique }} = (DESCRIPTION = (ADDRESS = (PROTOCOL = TCP)(HOST = {{ hostvars[dg_primary_host].ansible_host | default(dg_primary_host) }})(PORT = 1521)) (CONNECT_DATA = (SERVICE_NAME = {{ dg_primary_unique }})))
          {{ dg_standby_unique }} = (DESCRIPTION = (ADDRESS = (PROTOCOL = TCP)(HOST = {{ hostvars[dg_standby_host].ansible_host | default(dg_standby_host) }})(PORT = 1521)) (CONNECT_DATA = (SERVICE_NAME = {{ dg_standby_unique }}) (UR = A)))
      when: dg_action == 'prepare'

    - name: A static listener entry for the standby (RMAN reaches it while it is not mounted)
      ansible.builtin.blockinfile:
        path: "{{ dg_home }}/network/admin/listener.ora"
        create: true
        mode: "0644"
        marker: "# {mark} atk data guard"
        block: |
          SID_LIST_LISTENER = (SID_LIST = (SID_DESC = (GLOBAL_DBNAME = {{ dg_standby_unique }}) (ORACLE_HOME = {{ dg_home }}) (SID_NAME = {{ dg_sid }})) (SID_DESC = (GLOBAL_DBNAME = {{ dg_standby_unique }}_DGMGRL) (ORACLE_HOME = {{ dg_home }}) (SID_NAME = {{ dg_sid }})))
      register: dg_listener
      when: dg_action == 'prepare' and not dg_is_primary | bool

    - name: Reload the listener
      ansible.builtin.command:
        argv: ["{{ dg_home }}/bin/lsnrctl", "reload"]
      environment: "{{ dg_env }}"
      when: dg_action == 'prepare' and not dg_is_primary | bool and dg_listener is changed

    - name: A minimal parameter file for the standby instance
      ansible.builtin.copy:
        content: "db_name={{ dg_primary_sid }}\\ndb_unique_name={{ dg_standby_unique }}\\n"
        dest: "{{ dg_home }}/dbs/init{{ dg_sid }}.ora"
        mode: "0640"
        force: false
      when: dg_action == 'prepare' and not dg_is_primary | bool

    - name: Start the standby instance (NOMOUNT) for the duplicate
      ansible.builtin.command:
        argv: "{{ dg_sqlplus }}"
        stdin: "STARTUP NOMOUNT PFILE='{{ dg_home }}/dbs/init{{ dg_sid }}.ora';\\nEXIT;"
      environment: "{{ dg_env }}"
      when: dg_action == 'prepare' and not dg_is_primary | bool and dg_role == 'NOT MOUNTED' and 'ORA-01034' in (dg_state.stdout | default(''))

    # ---------------------------------------------------------------- duplicate (on the standby host)
    - name: Duplicate the primary into the standby (RMAN, from the active database)
      ansible.builtin.command:
        argv: ["{{ dg_home }}/bin/rman"]
        stdin: |
          CONNECT TARGET sys/"{{ vault_oracle_sys_password }}"@{{ dg_primary_unique }}
          CONNECT AUXILIARY sys/"{{ vault_oracle_sys_password }}"@{{ dg_standby_unique }}
          DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE USING COMPRESSED BACKUPSET DORECOVER
            SPFILE SET db_unique_name='{{ dg_standby_unique }}' SET fal_server='{{ dg_primary_unique }}' SET dg_broker_start='TRUE'
            NOFILENAMECHECK;
          EXIT;
      environment: "{{ dg_env }}"
      no_log: true
      async: 86400
      poll: 60
      when: dg_action == 'duplicate' and not dg_is_primary | bool and dg_role != 'PHYSICAL STANDBY'

    - name: Start redo apply on the standby
      ansible.builtin.command:
        argv: "{{ dg_sqlplus }}"
        stdin: "ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;\\nEXIT;"
      environment: "{{ dg_env }}"
      register: dg_mrp
      changed_when: "'ORA-01153' not in dg_mrp.stdout"
      failed_when: false
      when: dg_action == 'duplicate' and not dg_is_primary | bool and dg_mode == 'broker'

    # ---------------------------------------------------------------- the broker (run on the primary)
    - name: Create and enable the broker configuration
      ansible.builtin.command:
        argv: ["{{ dg_home }}/bin/dgmgrl", "-silent", "/nolog"]
        stdin: |
          CONNECT sys/"{{ vault_oracle_sys_password }}"@{{ dg_primary_unique }}
          CREATE CONFIGURATION atk AS PRIMARY DATABASE IS {{ dg_primary_unique }} CONNECT IDENTIFIER IS {{ dg_primary_unique }};
          ADD DATABASE {{ dg_standby_unique }} AS CONNECT IDENTIFIER IS {{ dg_standby_unique }} MAINTAINED AS PHYSICAL;
          ENABLE CONFIGURATION;
          EXIT;
      environment: "{{ dg_env }}"
      no_log: true
      register: dg_broker
      changed_when: "'already exists' not in dg_broker.stdout and 'ORA-16504' not in dg_broker.stdout"
      failed_when: "dg_broker.rc != 0 and 'already exists' not in dg_broker.stdout and 'ORA-16504' not in dg_broker.stdout"
      when: dg_action == 'broker' and dg_is_primary | bool

    # ---------------------------------------------------------------- status (lag read on the standby)
    - name: Read the apply lag
      ansible.builtin.command:
        argv: "{{ dg_sqlplus }}"
        stdin: "{{ dg_quiet }}SELECT NVL(MAX(EXTRACT(DAY FROM TO_DSINTERVAL(value)) * 86400 + EXTRACT(HOUR FROM TO_DSINTERVAL(value)) * 3600 + EXTRACT(MINUTE FROM TO_DSINTERVAL(value)) * 60 + EXTRACT(SECOND FROM TO_DSINTERVAL(value))), -1) FROM v$dataguard_stats WHERE name = 'apply lag';\\nEXIT;"
      environment: "{{ dg_env }}"
      register: dg_lag
      changed_when: false
      failed_when: false
      when: dg_action == 'status' and not dg_is_primary | bool

    - name: Write the result for the script
      ansible.builtin.copy:
        content: "{{ {'standbyRole': dg_role, 'applyLagSeconds': ((dg_lag.stdout | default('-1') | trim | float) | int) if dg_lag is defined and dg_lag.stdout is defined else -1} | to_json }}"
        dest: "{{ atk_result_file }}"
        mode: "0600"
      delegate_to: localhost
      become: false
      when: dg_action == 'status' and not dg_is_primary | bool and atk_result_file is defined

    # ---------------------------------------------------------------- switchover (broker)
    - name: Validate and switch over to the standby (broker)
      ansible.builtin.command:
        argv: ["{{ dg_home }}/bin/dgmgrl", "-silent", "/nolog"]
        stdin: |
          CONNECT sys/"{{ vault_oracle_sys_password }}"@{{ dg_primary_unique }}
          VALIDATE DATABASE {{ dg_standby_unique }};
          SWITCHOVER TO {{ dg_standby_unique }};
          EXIT;
      environment: "{{ dg_env }}"
      no_log: true
      when: dg_action == 'switchover' and dg_mode == 'broker' and not dg_is_primary | bool and dg_role == 'PHYSICAL STANDBY'

    - name: Switch back to the old primary (broker)
      ansible.builtin.command:
        argv: ["{{ dg_home }}/bin/dgmgrl", "-silent", "/nolog"]
        stdin: |
          CONNECT sys/"{{ vault_oracle_sys_password }}"@{{ dg_standby_unique }}
          VALIDATE DATABASE {{ dg_primary_unique }};
          SWITCHOVER TO {{ dg_primary_unique }};
          EXIT;
      environment: "{{ dg_env }}"
      no_log: true
      when: dg_action == 'switchover-back' and dg_mode == 'broker' and dg_is_primary | bool and dg_role == 'PHYSICAL STANDBY'

    # ---------------------------------------------------------------- switchover back (sql mode, the ZDM fallback)
    # Here dg_primary_host is the current primary (the ZDM target) and dg_standby_host the old source.
    - name: Switch the current primary over to the old source (SQL, verified first)
      ansible.builtin.command:
        argv: "{{ dg_sqlplus }}"
        stdin: |
          WHENEVER SQLERROR EXIT FAILURE
          ALTER DATABASE SWITCHOVER TO {{ dg_standby_unique }} VERIFY;
          ALTER DATABASE SWITCHOVER TO {{ dg_standby_unique }};
          EXIT;
      environment: "{{ dg_env }}"
      when: dg_action == 'switchover-back' and dg_mode == 'sql' and dg_is_primary | bool and dg_role == 'PRIMARY'

    - name: Open the old source as the primary
      ansible.builtin.command:
        argv: "{{ dg_sqlplus }}"
        stdin: "ALTER DATABASE OPEN;\\nEXIT;"
      environment: "{{ dg_env }}"
      register: dg_open
      changed_when: "'ORA-01531' not in dg_open.stdout"
      failed_when: false
      when: dg_action == 'switchover-back' and dg_mode == 'sql' and not dg_is_primary | bool

    - name: Mount the former target as the standby and apply redo
      ansible.builtin.command:
        argv: "{{ dg_sqlplus }}"
        stdin: "STARTUP MOUNT;\\nALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;\\nEXIT;"
      environment: "{{ dg_env }}"
      register: dg_remount
      changed_when: "'ORA-01081' not in dg_remount.stdout"
      failed_when: false
      when: dg_action == 'switchover-back' and dg_mode == 'sql' and dg_is_primary | bool

    # ---------------------------------------------------------------- remove
    - name: Remove the broker configuration
      ansible.builtin.command:
        argv: ["{{ dg_home }}/bin/dgmgrl", "-silent", "/"]
        stdin: "REMOVE CONFIGURATION;\\nEXIT;"
      environment: "{{ dg_env }}"
      register: dg_remove
      changed_when: "'ORA-16532' not in dg_remove.stdout"
      failed_when: "dg_remove.rc != 0 and 'ORA-16532' not in dg_remove.stdout"
      when: dg_action == 'remove' and dg_mode == 'broker' and dg_is_primary | bool

    - name: Remove the redo destination to the old source and its settings (SQL mode)
      ansible.builtin.command:
        argv: "{{ dg_sqlplus }}"
        stdin: |
          WHENEVER SQLERROR EXIT FAILURE
          SET SERVEROUTPUT ON
          BEGIN
            FOR p IN (SELECT name FROM v$parameter WHERE name LIKE 'log_archive_dest\\_%' ESCAPE '\\' AND UPPER(value) LIKE '%DB_UNIQUE_NAME=' || UPPER('{{ dg_standby_unique }}') || '%') LOOP
              EXECUTE IMMEDIATE 'ALTER SYSTEM SET ' || p.name || ' = '''' SCOPE = BOTH';
              DBMS_OUTPUT.PUT_LINE('ATK_CHANGED=1');
            END LOOP;
            FOR p IN (SELECT name FROM v$parameter WHERE name IN ('fal_server', 'log_archive_config') AND value IS NOT NULL) LOOP
              EXECUTE IMMEDIATE 'ALTER SYSTEM SET ' || p.name || ' = '''' SCOPE = BOTH';
              DBMS_OUTPUT.PUT_LINE('ATK_CHANGED=1');
            END LOOP;
          END;
          /
          EXIT;
      environment: "{{ dg_env }}"
      register: dg_unlink
      changed_when: "'ATK_CHANGED=1' in dg_unlink.stdout"
      when: dg_action == 'remove' and dg_mode == 'sql' and dg_is_primary | bool
`;
}

/** `ansible/db-oracle-rman.yml`: level 0 / level 1 backups rolled forward on the target, opened at cutover. */
export function rmanPlaybook(): string {
  return `# The execution kit's Oracle RMAN path: level 0 then level 1 backups on the source, restored and rolled
# forward on the target, the final level 1 and archived logs at cutover, OPEN RESETLOGS. Run by
# paths/db/oracle-rman.sh with -e rman_action=... Both hosts mount rman_dir (NFS). OS authentication only:
# no password is used. The target is assumed to have the source's directory layout (a rebuild of it).
- name: Oracle RMAN ({{ rman_action }})
  hosts: "{{ rman_source_host }}:{{ rman_target_host }}"
  gather_facts: false
  become: true
  become_user: oracle
  vars:
    rman_on_source: "{{ inventory_hostname == rman_source_host }}"
    rman_home: "{{ rman_source_home if rman_on_source | bool else rman_target_home }}"
    rman_sid: "{{ rman_source_sid if rman_on_source | bool else rman_target_sid }}"
    rman_env:
      ORACLE_HOME: "{{ rman_home }}"
      ORACLE_SID: "{{ rman_sid }}"
      PATH: "{{ rman_home }}/bin:/usr/bin:/bin"
    rman_sqlplus: ["{{ rman_home }}/bin/sqlplus", "-S", "-L", "/", "as", "sysdba"]
    rman_quiet: "SET HEADING OFF FEEDBACK OFF PAGESIZE 0 LINESIZE 400 VERIFY OFF\\n"
  tasks:
    - name: Check the action
      ansible.builtin.assert:
        that: [rman_action in ['prepare', 'level0', 'restore', 'level1', 'recover', 'final', 'open', 'status', 'remove']]

    - name: The backup location is mounted and writable
      ansible.builtin.stat:
        path: "{{ rman_dir }}"
      register: rman_stat
      when: rman_action in ['prepare', 'level0', 'level1', 'final', 'restore', 'recover', 'open']

    - name: Fail when it is not
      ansible.builtin.assert:
        that: [rman_stat.stat.exists and rman_stat.stat.isdir and rman_stat.stat.writeable]
        fail_msg: "{{ rman_dir }} is not a writable directory on {{ inventory_hostname }}: mount the backup location on both hosts"
      when: rman_stat is not skipped

    - name: Read the database state
      ansible.builtin.command:
        argv: "{{ rman_sqlplus }}"
        stdin: "{{ rman_quiet }}SELECT log_mode || '|' || open_mode || '|' || TO_CHAR(checkpoint_change#) FROM v$database;\\nEXIT;"
      environment: "{{ rman_env }}"
      register: rman_db
      changed_when: false
      failed_when: false

    - name: Keep it
      ansible.builtin.set_fact:
        rman_state: "{{ (rman_db.stdout | trim).split('|') if '|' in rman_db.stdout else ['', 'NOT MOUNTED', ''] }}"

    - name: The source must be in ARCHIVELOG mode
      ansible.builtin.assert:
        that: [rman_state[0] == 'ARCHIVELOG']
        fail_msg: "the source is in {{ rman_state[0] }} mode; RMAN rolling forward needs ARCHIVELOG (a restart, from the runbook)"
      when: rman_action == 'prepare' and rman_on_source | bool

    - name: Level 0 backup of the source (once)
      ansible.builtin.command:
        argv: ["{{ rman_home }}/bin/rman", "target", "/"]
        stdin: |
          BACKUP AS COMPRESSED BACKUPSET INCREMENTAL LEVEL 0 DATABASE FORMAT '{{ rman_dir }}/l0_%U' PLUS ARCHIVELOG FORMAT '{{ rman_dir }}/arc_%U';
          BACKUP CURRENT CONTROLFILE FORMAT '{{ rman_dir }}/ctl_l0.bkp' REUSE;
          BACKUP SPFILE FORMAT '{{ rman_dir }}/spfile.bkp' REUSE;
          EXIT;
        creates: "{{ rman_dir }}/.atk-level0"
      environment: "{{ rman_env }}"
      async: 86400
      poll: 60
      register: rman_l0
      when: rman_action == 'level0' and rman_on_source | bool

    - name: Mark the level 0 done
      ansible.builtin.file:
        path: "{{ rman_dir }}/.atk-level0"
        state: touch
        mode: "0640"
      when: rman_action == 'level0' and rman_on_source | bool and rman_l0 is changed

    - name: Restore the level 0 on the target (spfile, control file, database; once)
      ansible.builtin.command:
        argv: ["{{ rman_home }}/bin/rman", "target", "/"]
        stdin: |
          STARTUP FORCE NOMOUNT;
          RESTORE SPFILE FROM '{{ rman_dir }}/spfile.bkp';
          STARTUP FORCE NOMOUNT;
          RESTORE CONTROLFILE FROM '{{ rman_dir }}/ctl_l0.bkp';
          ALTER DATABASE MOUNT;
          CATALOG START WITH '{{ rman_dir }}/' NOPROMPT;
          RESTORE DATABASE;
          RECOVER DATABASE NOREDO;
          EXIT;
        creates: "{{ rman_dir }}/.atk-restored"
      environment: "{{ rman_env }}"
      async: 86400
      poll: 60
      register: rman_restore
      when: rman_action == 'restore' and not rman_on_source | bool

    - name: Mark the restore done
      ansible.builtin.file:
        path: "{{ rman_dir }}/.atk-restored"
        state: touch
        mode: "0640"
      when: rman_action == 'restore' and not rman_on_source | bool and rman_restore is changed

    - name: Level 1 backup of the source
      ansible.builtin.command:
        argv: ["{{ rman_home }}/bin/rman", "target", "/"]
        stdin: "BACKUP AS COMPRESSED BACKUPSET INCREMENTAL LEVEL 1 DATABASE FORMAT '{{ rman_dir }}/l1_%U';\\nEXIT;"
      environment: "{{ rman_env }}"
      async: 43200
      poll: 60
      when: rman_action in ['level1', 'final'] and rman_on_source | bool

    - name: Roll the target forward with the new level 1s
      ansible.builtin.command:
        argv: ["{{ rman_home }}/bin/rman", "target", "/"]
        stdin: "CATALOG START WITH '{{ rman_dir }}/' NOPROMPT;\\nRECOVER DATABASE NOREDO;\\nEXIT;"
      environment: "{{ rman_env }}"
      async: 43200
      poll: 60
      when: rman_action in ['recover', 'open'] and not rman_on_source | bool and rman_state[1] != 'READ WRITE'

    - name: The final archived logs of the source (after the freeze)
      ansible.builtin.command:
        argv: ["{{ rman_home }}/bin/rman", "target", "/"]
        stdin: "SQL 'ALTER SYSTEM ARCHIVE LOG CURRENT';\\nBACKUP ARCHIVELOG ALL NOT BACKED UP FORMAT '{{ rman_dir }}/farc_%U';\\nEXIT;"
      environment: "{{ rman_env }}"
      when: rman_action == 'final' and rman_on_source | bool

    - name: The last archived sequence of the source
      ansible.builtin.command:
        argv: "{{ rman_sqlplus }}"
        stdin: "{{ rman_quiet }}SELECT MAX(sequence#) FROM v$archived_log WHERE thread# = 1;\\nEXIT;"
      environment: "{{ rman_env }}"
      register: rman_seq
      changed_when: false
      when: rman_action == 'final' and rman_on_source | bool

    - name: Record it for the target
      ansible.builtin.copy:
        content: "{{ rman_seq.stdout | trim }}\\n"
        dest: "{{ rman_dir }}/.atk-final-seq"
        mode: "0640"
      when: rman_action == 'final' and rman_on_source | bool

    - name: Read the final sequence
      ansible.builtin.slurp:
        src: "{{ rman_dir }}/.atk-final-seq"
      register: rman_final
      when: rman_action == 'open' and not rman_on_source | bool and rman_state[1] != 'READ WRITE'

    - name: Apply the archived logs and open the target (RESETLOGS)
      ansible.builtin.command:
        argv: ["{{ rman_home }}/bin/rman", "target", "/"]
        stdin: |
          CATALOG START WITH '{{ rman_dir }}/' NOPROMPT;
          RECOVER DATABASE UNTIL SEQUENCE {{ (rman_final.content | b64decode | trim | int) + 1 }} THREAD 1;
          ALTER DATABASE OPEN RESETLOGS;
          EXIT;
      environment: "{{ rman_env }}"
      async: 43200
      poll: 60
      when: rman_action == 'open' and not rman_on_source | bool and rman_state[1] != 'READ WRITE'

    - name: Write the result for the script
      ansible.builtin.copy:
        content: "{{ {'openMode': rman_state[1], 'checkpointScn': rman_state[2]} | to_json }}"
        dest: "{{ atk_result_file }}"
        mode: "0600"
      delegate_to: localhost
      become: false
      when: rman_action == 'status' and not rman_on_source | bool and atk_result_file is defined

    - name: Remove the backup sets
      ansible.builtin.file:
        path: "{{ rman_dir }}"
        state: absent
      when: rman_action == 'remove' and rman_on_source | bool
`;
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

interface OraSpec {
  readonly file: string;
  readonly paths: readonly DbMovePath[];
  readonly summary: string;
  readonly needs: readonly string[];
  readonly functions: string;
  readonly ora: boolean;
  readonly verbs: ReturnType<typeof withTestSkips>;
}
const SPECS: readonly OraSpec[] = [
  {
    file: ZDM_FILE, paths: ['oracle-zdm-physical', 'oracle-zdm-logical'], needs: ['jq'], ora: false, functions: ZDM_FUNCS, verbs: ZDM_VERBS,
    summary: 'Oracle Zero Downtime Migration (physical and logical), run on the ZDM host: -eval, -pauseafter, resume at cutover. No automatic fallback.',
  },
  { file: ENTRY['oracle-dataguard']!, paths: ['oracle-dataguard'], needs: ['jq'], ora: false, functions: DG_FUNCS, verbs: DG_VERBS, summary: 'Oracle Data Guard: a physical standby on the rebuilt host, then switchover (and back) with the broker.' },
  { file: ENTRY['oracle-rman']!, paths: ['oracle-rman'], needs: ['jq'], ora: false, functions: RMAN_FUNCS, verbs: RMAN_VERBS, summary: 'Oracle RMAN: level 0 and level 1 backups rolled forward on the target, opened with RESETLOGS at cutover.' },
  { file: ENTRY['oracle-datapump']!, paths: ['oracle-datapump'], needs: ['sqlplus', 'jq'], ora: true, functions: '', verbs: DP_VERBS, summary: 'Oracle Data Pump over a database link (DBMS_DATAPUMP, from the controller), offline at cutover.' },
  { file: ENTRY['oci-dms']!, paths: ['oci-dms'], needs: ['oci', 'jq'], ora: false, functions: ODMS_FUNCS, verbs: ODMS_VERBS, summary: 'OCI Database Migration: evaluate, start (waiting after the lag monitor), resume into the switchover at cutover.' },
];

const SETTINGS_OF: Readonly<Record<string, readonly DbSetting[]>> = {
  'oracle-zdm-physical': ZDM_PHYS_SETTINGS, 'oracle-zdm-logical': ZDM_LOG_SETTINGS, 'oracle-dataguard': DG_SETTINGS, 'oracle-rman': RMAN_SETTINGS,
  'oracle-datapump': DP_SETTINGS, 'oci-dms': ODMS_SETTINGS,
};
const SECRETS_OF: Readonly<Record<string, readonly string[]>> = {
  'oracle-zdm-physical': [],
  'oracle-zdm-logical': ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>', 'GG_DB_PASSWORD_<TOKEN>'],
  'oracle-dataguard': [],
  'oracle-rman': [],
  'oracle-datapump': ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>'],
  'oci-dms': [],
};
const NOTES_OF: Readonly<Record<string, readonly string[]>> = {
  'oracle-zdm-physical': [
    'Runs on the ZDM host: `ZDM_HOME`, `ZDM_SSH_KEY` (the key file path) and `ZDM_SRC_WALLET` (an auto-login wallet with the source SYS password, made with mkstore) come from the environment; the kit writes none of them.',
    `No automatic fallback: ZDM does not reverse roles. The source stays a standby (SKIP_FALLBACK=FALSE) and \`rollback\` switches back by hand with \`${DG_PLAYBOOK}\` (vault_oracle_sys_password).`,
  ],
  'oracle-zdm-logical': [
    'Runs on the ZDM host (`ZDM_HOME`, `ZDM_SSH_KEY`). The passwords ZDM asks for are sent on its stdin; verify their order with the `prepare` (-eval) run on your ZDM release.',
    'No automatic fallback: no reverse replication is set up; a rollback after the switchover loses the target\'s writes.',
  ],
  'oracle-dataguard': [`Runs \`${DG_PLAYBOOK}\` against the project inventory; SYS comes from vault_oracle_sys_password (no_log).`],
  'oracle-rman': [`Runs \`${RMAN_PLAYBOOK}\` against the project inventory (OS authentication on the hosts; no password).`],
  'oracle-datapump': ['Needs SQL*Plus (Oracle Instant Client) on the controller; the connection and the link password go on its stdin.'],
  'oci-dms': ['Uses the OCI CLI credential chain (`OCI_CLI_AUTH=instance_principal` or the OCI config); the connection passwords are OCI Vault secrets named in Terraform.'],
};

function scriptOf(spec: OraSpec, rows: DbRows, ctx: PathContext): string {
  return shScript({
    file: spec.file,
    paths: spec.paths,
    summary: spec.summary,
    needs: spec.needs,
    functions: [DB_SH_BASE, shSettings(rows, ctx), spec.ora ? ORA_SH : '', spec.functions].filter(Boolean).join('\n'),
    verbs: spec.verbs,
  });
}

function oracleRows(items: readonly ManifestItem[]): { rows: Map<string, Readonly<Record<string, string>>>; tokens: Map<string, string> } {
  const rows = new Map<string, Readonly<Record<string, string>>>();
  const tokens = new Map<string, string>();
  for (const path of ORACLE_PATHS) {
    const r = dbRows(onPath(items, path), oracleExtra(path));
    for (const [k, v] of r.rows) rows.set(k, v);
    for (const [k, v] of r.tokens) tokens.set(k, v);
  }
  return { rows, tokens };
}

function oracleFindings(items: readonly ManifestItem[]): Finding[] {
  const out: Finding[] = [];
  for (const i of items) {
    const fb = NO_AUTO_FALLBACK[i.path];
    if (i.path === 'oracle-zdm-physical') {
      out.push(info('exec.db.zdm-fallback', `${i.name}: the ZDM response file keeps the fallback (SKIP_FALLBACK=FALSE, SHUTDOWN_SRC=FALSE, the Data Guard configuration not cleaned up); rollback after the switchover is the manual switchover back in ${DG_PLAYBOOK}.`, {
        path: i.id, remediation: fb?.remediation ?? 'Rehearse the manual switchover back before the wave.', ...(fb ? { source: fb.source } : {}),
      }));
    }
    if (i.path === 'oracle-zdm-logical') out.push(noReverseFinding(i, 'ZDM logical sets up no reverse replication'));
    if (i.path === 'oracle-datapump' || i.path === 'oracle-rman') out.push(noReverseFinding(i, 'an offline copy'));
    if (i.path === 'oci-dms') out.push(noReverseFinding(i, 'OCI Database Migration replicates one way'));
    if (i.path === 'oracle-datapump' && i.target.service && /adb$/.test(i.target.service)) {
      out.push(warning('exec.db.adb-link', `${i.name}: on Autonomous Database the link to the source is made with DBMS_CLOUD_ADMIN.CREATE_DATABASE_LINK (a wallet and a credential object); the script checks for it and stops at prepare until it exists.`, { path: i.id }));
    }
  }
  return out;
}

export const ORACLE_GENERATOR: PathGenerator = Object.freeze({
  id: 'db-oracle',
  owner: 'WP-11d' as const,
  paths: ORACLE_PATHS,
  needs: [
    need('command', 'ansible-playbook', 'the Oracle Data Guard and RMAN playbooks on the database hosts'),
    need('command', 'sqlplus', 'Oracle Data Pump over a database link (Oracle Instant Client with SQL*Plus)'),
    need('command', 'oci', 'OCI Database Migration', { install: 'https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm' }),
  ],
  entry: (p: ExecPath) => ENTRY[p] ?? `${DB_DIR}/${p}.sh`,
  files(items: readonly ManifestItem[], ctx: PathContext): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    const readme: ReadmeItem[] = [];
    const all = oracleRows(items);
    for (const spec of SPECS) {
      const list = items.filter((i) => spec.paths.includes(i.path as DbMovePath));
      if (!list.length) continue;
      const rows: DbRows = { rows: new Map(list.map((i) => [i.id, all.rows.get(i.id)!])), tokens: new Map(list.map((i) => [i.id, all.tokens.get(i.id)!])) };
      out[spec.file] = scriptOf(spec, rows, ctx);
      for (const i of list) {
        readme.push({ item: i, script: spec.file, settings: [...BASE_SETTINGS, ...(SETTINGS_OF[i.path] ?? [])], secrets: SECRETS_OF[i.path] ?? [], notes: NOTES_OF[i.path] ?? [] });
        if (i.path === 'oracle-zdm-physical' || i.path === 'oracle-zdm-logical') out[zdmRspFile(i)] = zdmResponseFile(i);
      }
    }
    if (items.some((i) => i.path === 'oracle-dataguard' || i.path === 'oracle-zdm-physical')) out[DG_PLAYBOOK] = dataGuardPlaybook();
    if (items.some((i) => i.path === 'oracle-rman')) out[RMAN_PLAYBOOK] = rmanPlaybook();
    out[`${DB_DIR}/README-oracle.md`] = dbReadme(
      'Oracle paths',
      'Zero Downtime Migration runs on the ZDM host; Data Guard and RMAN run on the database hosts through the kit\'s playbooks; Data Pump and OCI Database Migration run from the controller.',
      readme, all,
    );
    return out;
  },
  findings(items: readonly ManifestItem[]): readonly Finding[] {
    const all = oracleRows(items);
    const needHost = items.filter((i) => i.path === 'oracle-datapump');
    return [...oracleFindings(items), ...endpointFinding(needHost, all)];
  },
});

export const GENERATORS: readonly PathGenerator[] = Object.freeze([ORACLE_GENERATOR]);
