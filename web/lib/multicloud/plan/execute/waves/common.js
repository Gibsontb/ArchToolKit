/**
 * What every wave script shares (addendum A.7, WP-12): the wave's view of the
 * manifest, the path families the orchestrators treat differently, the
 * source-adapter interface the kit consumes (WP-15), and `waveScript`, the
 * skeleton each `waves/wave-<n>/*.sh` is built on.
 *
 * The skeleton keeps the A.6.2 contract by construction: it sources
 * `lib/atk.sh`, parses the common options with `atk_init_tool` (its own
 * options are taken off first), holds the wave lock `atk_lock wave-<n>`, and
 * runs other kit scripts with this run's id and options (`atk_pwsh` for the
 * PowerShell ones). The scripts apply by default; `--dry-run` is opt-in.
 *
 * Pure: no DOM, no file system.
 */

import { slugName } from '../../options.js';
             
                                                                                                           
                        
import { EXIT_CODES,               } from '../contract.js';
import { code, libPathFrom } from '../lib-sh.js';
                                                             
                                               

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * What the wave generators read. `PathContext` (registry.ts) satisfies it, so
 * `executionKit` can pass the context it already builds.
 */
                              
                      
                              
                                       
                            
                             
 

/** One item as the wave scripts see it. */
                           
                              
                     
                                    
                            
                                 
                                                     
                              
                            
                           
 

/** One wave: its items (in run order) and what the scripts need to know about it. */
                           
                     
                         
                           
                          
                        
                                      
                                                                                             
                               
                                                                  
                                              
                                           
                                          
                          
 

const CRIT_DEFAULT              = 'tier2';

/** Every wave of the manifest with at least one item, in order. */
export function waveSpecs(ctx             )             {
  const byId = new Map                                                                                     ();
  for (const w of ctx.plan.workloads) byId.set(w.id, { env: w.env, criticality: w.criticality, windows: w.os.startsWith('win'), ...(w.rename ? { rename: w.rename } : {}) });
  for (const db of ctx.plan.databases) {
    const hosts = ctx.plan.workloads.filter((w) => db.hosts.includes(w.name));
    const env = hosts.find((h) => h.env === 'prod')?.env ?? hosts[0]?.env;
    const crit = [...hosts.map((h) => h.criticality)].sort()[0];
    byId.set(db.id, { ...(env ? { env } : {}), ...(crit ? { criticality: crit } : {}), windows: false });
  }
  const numbers = [...new Set(ctx.manifest.items.map((i) => i.wave).filter((w)              => w !== null))].sort((a, b) => a - b);
  const mwaves = new Map(ctx.manifest.waves.map((w) => [w.n, w]));
  const foundation = ctx.manifest.waves.filter((w) => w.kind === 'foundation').map((w) => w.n).sort((a, b) => a - b);
  return numbers.map((n) => {
    const mw = mwaves.get(n);
    const order = new Map((mw?.items ?? []).map((id, i) => [id, i]));
    const items = ctx.manifest.items
      .filter((i) => i.wave === n)
      .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
      .map((item)           => {
        const facts = byId.get(item.id);
        const criticality = item.criticality ?? facts?.criticality ?? CRIT_DEFAULT;
        return {
          item,
          ...(facts?.env ? { env: facts.env } : {}),
          criticality,
          keepDays: ctx.settings.keepDays[criticality],
          hypercareDays: ctx.settings.hypercareDays[criticality],
          lagSeconds: item.kind === 'database' ? ctx.settings.lagSeconds.db : ctx.settings.lagSeconds.server,
          windows: facts?.windows ?? false,
          ...(facts?.rename ? { rename: facts.rename } : {}),
        };
      });
    const production = mw?.kind !== 'foundation' && items.some((i) => i.env === 'prod');
    const platforms = [...new Set(items.map((i) => i.item.target.platform).filter((p)                => !!p))].sort();
    return {
      n,
      ...(mw?.name ? { name: mw.name } : {}),
      ...(mw?.kind ? { kind: mw.kind } : {}),
      ...(mw?.start ? { start: mw.start } : {}),
      ...(mw?.end ? { end: mw.end } : {}),
      items,
      production,
      foundationWaves: foundation.filter((f) => f < n),
      platforms,
      planId: ctx.manifest.planId,
    };
  });
}

// ---------------------------------------------------------------------------
// Path families the orchestrators treat differently (A.7.1, A.7.2)
// ---------------------------------------------------------------------------

const HCX                      = ['hcx-bulk', 'hcx-rav', 'hcx-vmotion', 'hcx-cold', 'hcx-osam'];
const CORE                      = ['with-db', 'with-vm', 'retire', 'specialist'];

/** Paths with no test migration: G1 then needs a rollback rehearsal (A.7.1). */
export const NO_TEST_PATHS                        = new Set          ([...HCX, 'xvc-vmotion', 'vcf-import', ...CORE]);
/** Paths whose own cutover call does the final sync (A.7.2 step 4). */
export const SYNC_IN_CUTOVER                        = new Set          ([
  ...HCX, 'xvc-vmotion', 'vcf-import', 'vcf-converter', 'azure-migrate', 'azure-migrate-hyperv', 'azure-migrate-agent', 'gcp-m2vm',
  'gcp-image-import', 'oracle-datapump', 'pg-dump', 'mysql-dump', 'sql-backup-url', 'oracle-rman', 'ase-dump-load', 'db2-backup-restore',
  'informix-backup-restore', 'redis-rdb-import', 'es-snapshot-restore', 'sap-backup-restore', 'saas-exchange', 'saas-sharepoint', 'deploy',
]);
/** Paths whose final sync is a last delta copy (the path's `replicate` verb) (A.7.2 step 4). */
export const DELTA_COPY_PATHS                        = new Set          (['rebuild', 'appliance-rebuild', 'k8s-velero']);
/** Paths with nothing to sync. */
export const NO_SYNC_PATHS                        = new Set          (CORE);
/** Paths whose cutover stops (or moves) the source itself, so step 5 only confirms it (A.7.2 step 5). */
export const SOURCE_STOPPED_BY_CUTOVER                        = new Set          ([
  ...HCX, 'xvc-vmotion', 'vcf-import', 'azure-migrate', 'azure-migrate-hyperv', 'azure-migrate-agent',
]);
/** Offline paths: no replication to watch before the cutover (their copy is the cutover). */
export const OFFLINE_PATHS                        = new Set          ([
  'oracle-datapump', 'pg-dump', 'mysql-dump', 'sql-backup-url', 'oracle-rman', 'ase-dump-load', 'db2-backup-restore', 'informix-backup-restore',
  'redis-rdb-import', 'es-snapshot-restore', 'sap-backup-restore', 'saas-exchange', 'saas-sharepoint', 'gcp-image-import', 'vcf-converter', 'vcf-import',
  'hcx-cold', 'deploy',
]);
/** The core paths (WP-11a): nothing for a tool to do. */
export const CORE_PATHS                        = new Set          (CORE);
/** Paths with no replication to poll before the cutover. */
export const NO_STATUS_PATHS                        = new Set          ([...CORE, ...OFFLINE_PATHS]);
/** Paths with nothing on a target to measure or validate: retired, not moved (with-db), or done by an operator (specialist). */
export const NOT_VALIDATED                        = new Set          (['retire', 'with-db', 'specialist']);
/** Paths whose own rollback returns the source (the VM itself moved), so the adapter's start is not needed. */
export const SOURCE_RETURNED_BY_PATH                        = new Set          ([...HCX, 'xvc-vmotion', 'vcf-import']);
/** Paths that do not produce a new VM the orchestrator should check or adopt. */
export const NO_NEW_TARGET                        = new Set          ([...HCX, ...CORE, 'xvc-vmotion', 'vcf-import', 'deploy', 'saas-exchange', 'saas-sharepoint', 'k8s-velero']);
/** Paths where the source keeps running until decommission (the server hosts a database that moves on its own path). */
export const SOURCE_KEPT_AT_CUTOVER                        = new Set          (['with-db', 'specialist']);

/**
 * What a rollback after commit loses, per path (A.7.4). A path not listed
 * keeps a reverse path, so a rollback loses nothing written before the
 * rollback started.
 */
export const DATA_LOSS                                              = Object.freeze({
  'aws-mgn': 'AWS Transform MGN has no failback after finalize: target writes since cutover are lost unless copied back by hand (AWS DRS offers failback, MGN does not).',
  'azure-migrate': 'Azure Migrate has no reverse replication: target writes since cutover are lost when the source restarts.',
  'azure-migrate-hyperv': 'Azure Migrate has no reverse replication: target writes since cutover are lost when the source restarts.',
  'azure-migrate-agent': 'Azure Migrate has no reverse replication: target writes since cutover are lost when the source restarts.',
  'gcp-m2vm': 'Migrate to Virtual Machines has no reverse replication after finalize: target writes since cutover are lost.',
  'gcp-image-import': 'An image import has no reverse path: target writes since cutover are lost.',
  'oci-ocm': 'Oracle Cloud Migrations has no reverse replication: target writes since cutover are lost.',
  'hcx-rav': 'HCX Replication Assisted vMotion has no automatic reverse migration: target writes since the switchover stay on the target unless it is migrated back.',
  'hcx-bulk': 'HCX Bulk keeps the renamed source, frozen at the switchover: target writes since then are lost when it is renamed back.',
  rebuild: 'A rebuilt server has no reverse copy: data written on the target since cutover must be copied back by the data-copy tool, or it is lost.',
  'vcf-converter': 'A converted VM has no reverse path: target writes since cutover are lost.',
  'oracle-datapump': 'Data Pump is one-way: target writes since cutover are lost.',
  'pg-dump': 'pg_dump is one-way: target writes since cutover are lost.',
  'mysql-dump': 'mysqldump is one-way: target writes since cutover are lost.',
  'sql-backup-url': 'Backup to URL is one-way: target writes since cutover are lost.',
  'aws-dms': 'AWS DMS was not set up in reverse: target writes since cutover are lost unless a reverse task is created.',
  'azure-dms': 'Azure DMS offline migration is one-way: target writes since cutover are lost.',
  'sql-mi-lrs': 'The Log Replay Service is one-way: target writes since cutover are lost.',
  'sql-rds-native': 'Native backup and restore to RDS is one-way: target writes since cutover are lost.',
  'oracle-zdm-logical': 'ZDM logical migration has no automatic reverse switchover: target writes since cutover are lost unless GoldenGate is reversed by hand.',
});
export const DATA_LOSS_DEFAULT = 'The reverse replication set up at cutover carries target writes back; nothing is lost if it is healthy.';

// ---------------------------------------------------------------------------
// Source adapters (WP-15): the interface the kit consumes
// ---------------------------------------------------------------------------

/** The verbs of `source/<platform>.*` (A.3.3). */
                                                                                                               

/**
 * A source adapter as the wave scripts call it:
 *   bash:       source/<file>.sh  VERB --item ID [--wave N] [--dry-run] [--timeout MIN] [--step STEP] [--path PATH]
 *   PowerShell: source/<file>.ps1 VERB -Item ID [-Wave N] [-DryRun] [-TimeoutMinutes MIN] [-Step STEP] [-Path PATH]
 * It writes its own status events (with STEP and PATH), exits 0 / 2 / 3 / 10,
 * and `state` prints `name<TAB>state` without writing events.
 */
                                   
                                    
                                        
                        
                              
                                                                                                       
                              
 

/**
 * The adapter file per source platform. A stub of what WP-15's
 * `sources/adapters.ts` renders; when it lands, replace this table with its
 * export (the file names match its `ADAPTER_SCRIPTS` keys).
 */
export const SOURCE_ADAPTERS                                                     = Object.freeze(Object.fromEntries(
  ([
    ['vsphere', 'vsphere.ps1'], ['hyperv', 'hyperv.ps1'], ['ahv', 'ahv.sh'], ['kvm', 'kvm.sh'], ['proxmox', 'proxmox.sh'], ['ovirt', 'ovirt.sh'],
    ['xen', 'xen.sh'], ['physical', 'physical.sh'], ['aws', 'aws.sh'], ['azure', 'azure.ps1'], ['google', 'gcp.sh'], ['oci', 'oci.sh'],
    ['power', 'operator.sh'], ['sparc', 'operator.sh'], ['itanium', 'operator.sh'], ['pa-risc', 'operator.sh'], ['mainframe', 'operator.sh'], ['other', 'operator.sh'],
  ]         ).map(([p, f]) => [p, { platform: p, file: `source/${f}`, lang: f.endsWith('.ps1') ? 'ps1' : 'sh', automated: f !== 'operator.sh' }]),
)                                            );

export function sourceAdapterFor(platform                )                   {
  return SOURCE_ADAPTERS[platform];
}

// ---------------------------------------------------------------------------
// Needs
// ---------------------------------------------------------------------------

export const WAVE_NEEDS                      = Object.freeze([
  { kind: 'command', name: 'jq', min: '1.6', why: 'the wave scripts read the manifest and the events' },
  { kind: 'command', name: 'ansible-playbook', min: '2.16', why: 'freeze, baseline, validation, identity and Windows DNS plays', install: 'pipx install ansible-core' },
  { kind: 'command', name: 'terraform', min: '1.7', why: 'adopting the cut-over VMs (import blocks) and the landing-zone check' },
  { kind: 'ansible-collection', name: 'ansible.windows', why: 'freeze, identity and Windows DNS' },
  { kind: 'ansible-collection', name: 'microsoft.ad', why: 'server identity (computer objects)' },
  { kind: 'ansible-collection', name: 'community.postgresql', why: 'setting PostgreSQL read-only at the freeze' },
  { kind: 'ansible-collection', name: 'ansible.mysql', why: 'setting MySQL read-only at the freeze' },
  { kind: 'ansible-collection', name: 'lowlydba.sqlserver', why: 'setting SQL Server databases read-only at the freeze' },
]                     );

// ---------------------------------------------------------------------------
// The script skeleton
// ---------------------------------------------------------------------------

/** An option a wave script takes besides the common ones (taken off before `atk_init_tool`). */
                             
                                           
                        
                                                                   
                            
                           
                                                            
                            
                        
 

                                 
                                                                        
                        
                        
                                 
                           
                           
                                     
                                          
                                                  
                                           
                                                                        
                                     
                                           
                          
                                   
                              
                       
                        
 

const shq = (s        )         => `'${s.replace(/'/g, `'\\''`)}'`;
export { shq };

/** A bash array literal of words. */
export function bashWords(words                   )         {
  return words.map(shq).join(' ');
}

/** A bash `case` pattern list (`a|b|c`), or a pattern that matches nothing. */
export function casePattern(values                  )         {
  const list = [...values].sort();
  return list.length ? list.join('|') : '__none__';
}

/** The item id as a file name (`status/baseline/<id>.json`): anything but letters, digits, dot, dash and underscore becomes `_`. */
export function itemFileName(id        )         {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** The adapter lookup as a bash function, from `SOURCE_ADAPTERS`. */
function adapterCase()         {
  const by = new Map                  ();
  for (const a of Object.values(SOURCE_ADAPTERS)) by.set(a.file, [...(by.get(a.file) ?? []), a.platform]);
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([file, ps]) => `    ${ps.sort().join('|')}) printf '%s' ${shq(file)} ;;`).join('\n');
}

/**
 * The functions every wave script carries (after `atk_init_tool`):
 * item selection, calling other kit scripts, source adapters, events data,
 * and the step wrapper with its failure policy.
 */
export function waveFunctions(wave        )         {
  return code`WAVE_N=${wave}
WAVE_ITEMS=()
WAVE_LIVE=()
WAVE_OPTS=()
declare -A WAVE_FAILED=()
WAVE_INVENTORY="$\{ATK_ANSIBLE_INVENTORY:-$ATK_ROOT/ansible/inventory}"
export ANSIBLE_ROLES_PATH="$ATK_ROOT/ansible/roles$\{ANSIBLE_ROLES_PATH:+:$ANSIBLE_ROLES_PATH}"

if [[ -n "$ATK_WAVE" && "$ATK_WAVE" != "$WAVE_N" ]]; then atk_usage "this script is for wave $WAVE_N (use waves/wave-$ATK_WAVE/)"; fi
ATK_WAVE="$WAVE_N"

# wave_lock: hold status/.lock-wave-N for this run (a script this run starts inherits it).
wave_lock() {
  if [[ "$\{ATK_WAVE_LOCKED:-}" == "$WAVE_N" ]]; then return 0; fi
  atk_lock "wave-$WAVE_N"
  export ATK_WAVE_LOCKED="$WAVE_N"
}

# wave_items: WAVE_ITEMS := the wave's items in run order, narrowed by --item (id or name).
wave_items() {
  WAVE_ITEMS=()
  local id f matched lname
  local -A hit=()
  for id in "$\{ATK_ALL_IDS[@]}"; do
    [[ "$\{ATK_ITEM_WAVE[$id]}" == "$WAVE_N" ]] || continue
    if (( $\{#ATK_ITEM_FILTER[@]} )); then
      matched=0
      lname="$\{ATK_NAME[$id],,}"
      for f in "$\{ATK_ITEM_FILTER[@]}"; do
        if [[ "$f" == "$id" || "$\{f,,}" == "$lname" ]]; then matched=1; hit[$f]=1; fi
      done
      (( matched )) || continue
    fi
    WAVE_ITEMS+=("$id")
  done
  for f in "$\{ATK_ITEM_FILTER[@]}"; do
    [[ -n "$\{hit[$f]:-}" ]] || atk_usage "no item \"$f\" in wave $WAVE_N"
  done
  return 0
}

# wave_live: WAVE_LIVE := the selected items that have not failed in this run.
wave_live() {
  WAVE_LIVE=()
  local id
  for id in "$\{WAVE_ITEMS[@]}"; do
    if [[ -z "$\{WAVE_FAILED[$id]:-}" ]]; then WAVE_LIVE+=("$id"); fi
  done
  return 0
}

# wave_item_args: --item for every selected item (for scripts that take a filter).
wave_item_args() {
  WAVE_ITEM_ARGS=()
  local id
  for id in "$\{WAVE_LIVE[@]}"; do WAVE_ITEM_ARGS+=(--item "$id"); done
  return 0
}

wave_opts() {
  WAVE_OPTS=()
  if (( ATK_DRY_RUN )); then WAVE_OPTS+=(--dry-run); fi
  if (( ATK_TIMEOUT > 0 )); then WAVE_OPTS+=(--timeout "$ATK_TIMEOUT"); fi
  if [[ -n "$ATK_GATE_OVERRIDE" ]]; then WAVE_OPTS+=(--gate-override "$ATK_GATE_OVERRIDE"); fi
  return 0
}

# wave_kit SCRIPT ARGS...: another kit script (relative to migration/execute/), bash or PowerShell, with this run's id and options.
wave_kit() {
  local script="$1"
  shift
  [[ -f "$ATK_HOME/$script" ]] || { atk_log "missing kit script: $script (regenerate the kit)"; return ${EXIT_CODES.missing}; }
  wave_opts
  if [[ "$script" == *.ps1 ]]; then
    atk_pwsh "$script" "$@" "$\{WAVE_OPTS[@]}"
  else
    "$ATK_HOME/$script" "$@" "$\{WAVE_OPTS[@]}"
  fi
}

# wave_path VERB ID [ARGS...]: the item's path script (the manifest's script column) runs VERB for that one item.
wave_path() {
  local verb="$1" id="$2" script="$\{ATK_SCRIPT[$2]:-}"
  shift 2
  if [[ -z "$script" || "$script" == "-" ]]; then atk_log "$id: the manifest names no script for the $\{ATK_ITEM_PATH[$id]} path"; return 1; fi
  wave_kit "$script" "$verb" --wave "$WAVE_N" --item "$id" "$@"
}

# wave_adapter PLATFORM: the source adapter for a source platform (relative to migration/execute/).
wave_adapter() {
  case "$1" in
${adapterCase()}
    *) printf '%s' 'source/operator.sh' ;;
  esac
}

# wave_source VERB ID STEP: the item's source adapter runs VERB, reporting as STEP on the item's path.
wave_source() {
  local verb="$1" id="$2" step="$3" file
  file="$(wave_adapter "$\{ATK_SOURCE[$id]}")"
  if [[ ! -f "$ATK_HOME/$file" ]]; then
    atk_event "$id" "$step" failed "" "no source adapter $file in the kit: do the $verb by hand, then re-run"
    return ${EXIT_CODES.missing}
  fi
  local -a args=()
  if [[ "$file" == *.ps1 ]]; then
    args=("$verb" -Item "$id" -Wave "$WAVE_N" -Step "$step" -Path "$\{ATK_ITEM_PATH[$id]}")
    if (( ATK_DRY_RUN )); then args+=(-DryRun); fi
    if (( ATK_TIMEOUT > 0 )); then args+=(-TimeoutMinutes "$ATK_TIMEOUT"); fi
    atk_need pwsh
    ATK_RUN_ID="$ATK_RUN_ID" ATK_PLAN_ID="$ATK_PLAN_ID" pwsh -NoProfile -NonInteractive -File "$ATK_HOME/$file" "$\{args[@]}"
  else
    args=("$verb" --item "$id" --wave "$WAVE_N" --step "$step" --path "$\{ATK_ITEM_PATH[$id]}")
    if (( ATK_DRY_RUN )); then args+=(--dry-run); fi
    if (( ATK_TIMEOUT > 0 )); then args+=(--timeout "$ATK_TIMEOUT"); fi
    ATK_RUN_ID="$ATK_RUN_ID" ATK_PLAN_ID="$ATK_PLAN_ID" "$ATK_HOME/$file" "$\{args[@]}"
  fi
}

# wave_note ID RC STEP: record an item's result; usage, missing-tool, gate and pre-check exits stop the run at once.
wave_note() {
  local id="$1" rc="$2" step="$3"
  case "$rc" in
    0) return 0 ;;
    ${EXIT_CODES.usage}|${EXIT_CODES.missing}|${EXIT_CODES.gate}|${EXIT_CODES.precheck})
      atk_event - "$step" failed "" "stopped: $\{ATK_NAME[$id]:-$id} exited $rc" exit="$rc"
      exit "$rc" ;;
    *) WAVE_FAILED[$id]="$step"; return 0 ;;
  esac
}

# wave_each FN: FN ID for every live item; FN returns the item's exit code.
wave_each() {
  local fn="$1" id rc
  wave_live
  for id in "$\{WAVE_LIVE[@]}"; do
    rc=0
    "$fn" "$id" || rc=$?
    wave_note "$id" "$rc" "$\{WAVE_STEP_ID:-manual}"
  done
  return 0
}

WAVE_CONTINUE="$\{WAVE_CONTINUE:-0}"
WAVE_STEP_ID=""
WAVE_ROLLBACK_HINT=""
# wave_step NO STEP LABEL FN: one numbered step with wave-level started / succeeded / failed events.
# A failed item stops the wave after the step (exit ${EXIT_CODES.partial}), unless --continue-on-item-failure.
wave_step() {
  local no="$1" step="$2" label="$3" fn="$4" before after
  WAVE_STEP_ID="$step"
  before=$\{#WAVE_FAILED[@]}
  wave_live
  if (( $\{#WAVE_LIVE[@]} == 0 )); then
    atk_event - "$step" skipped "" "step $no, $label: no items left" stepNo="$no"
    return 0
  fi
  atk_event - "$step" started "" "step $no, $label" stepNo="$no"
  "$fn"
  after=$\{#WAVE_FAILED[@]}
  if (( after > before )); then
    atk_event - "$step" failed "" "step $no, $label: $(( after - before )) item(s) failed" stepNo="$no" failed="$(( after - before ))"
    wave_failed_stop "$no" "$label"
  else
    atk_event - "$step" succeeded "" "step $no, $label" stepNo="$no"
  fi
  return 0
}

# wave_failed_stop NO LABEL: print the failed items and the rollback line; stop unless --continue-on-item-failure.
wave_failed_stop() {
  local id
  for id in "$\{!WAVE_FAILED[@]}"; do atk_log "failed at $\{WAVE_FAILED[$id]}: $\{ATK_NAME[$id]:-$id}"; done
  if [[ -n "$WAVE_ROLLBACK_HINT" ]]; then
    for id in "$\{!WAVE_FAILED[@]}"; do atk_log "to roll back: $WAVE_ROLLBACK_HINT --item $id"; done
  fi
  if (( WAVE_CONTINUE )); then
    atk_log "continuing with the other items (--continue-on-item-failure)"
    return 0
  fi
  atk_log "stopping the wave at step $1 ($2); the other items were not touched after it"
  exit ${EXIT_CODES.partial}
}

# wave_data ID STEP KEY: a data value from the item's latest succeeded STEP event (a dry run's only in a dry run).
wave_data() {
  local file="$ATK_STATUS/events.jsonl"
  [[ -f "$file" ]] || return 0
  jq -r --arg id "$1" --arg step "$2" --arg key "$3" --argjson dry "$ATK_DRY_RUN" \
    'select(.item == $id and .step == $step and .outcome == "succeeded" and (.dryRun == false or $dry == 1) and ((.data // {})[$key] // null) != null) | .data[$key] | tostring' \
    "$file" | tail -n 1
}

# wave_committed ID: true when the item has a real (not dry-run) commit.
wave_committed() {
  local file="$ATK_STATUS/events.jsonl"
  [[ -f "$file" ]] || return 1
  [[ -n "$(jq -r --arg id "$1" 'select(.item == $id and .step == "commit" and .outcome == "succeeded" and .dryRun == false) | .at' "$file" | tail -n 1)" ]]
}

# wave_json ID FILTER: a value from the item's manifest entry (items.json).
wave_json() {
  jq -r --arg id "$1" ".items[] | select(.id == \$id) | $2" "$ATK_HOME/manifest/items.json"
}

# wave_file ID: the item id as a file name.
wave_file() {
  local s="$1"
  printf '%s' "$\{s//[^A-Za-z0-9._-]/_}"
}

# wave_platform ID: the item's target platform (manifest target column, platform:region).
wave_platform() {
  local t="$\{ATK_TARGET[$1]:--}"
  [[ "$t" != "-" ]] || { printf ''; return 0; }
  printf '%s' "$\{t%%:*}"
}
wave_region() {
  local t="$\{ATK_TARGET[$1]:--}"
  if [[ "$t" == *:* ]]; then printf '%s' "$\{t#*:}"; fi
}

# wave_limit GROUP: the Ansible --limit for the selection: the group when every item is selected, else the item names.
wave_limit() {
  local group="$1" id names=""
  if (( $\{#ATK_ITEM_FILTER[@]} == 0 && $\{#WAVE_FAILED[@]} == 0 )); then printf '%s' "$group"; return 0; fi
  wave_live
  for id in "$\{WAVE_LIVE[@]}"; do names+="$\{names:+,}$\{ATK_NAME[$id]}"; done
  printf '%s' "$names"
}

# wave_playbook PLAY LIMIT [ARGS...]: one of the kit's plays against the project inventory (printed, not run, in a dry run).
wave_playbook() {
  local play="$1" limit="$2"
  shift 2
  if (( ! ATK_DRY_RUN )); then
    atk_need ansible-playbook
  fi
  atk_run ansible-playbook -i "$WAVE_INVENTORY" "$ATK_HOME/ansible/$play" --limit "$limit" \
    -e "atk_wave=$WAVE_N" -e "atk_kit=$ATK_HOME" -e "atk_status=$ATK_STATUS" -e "atk_root=$ATK_ROOT" "$@"
}

# wave_hooks DIR STEP: every executable in hooks/<wave>/DIR, in name order.
wave_hooks() {
  local dir="$ATK_HOME/hooks/$WAVE_N/$1" f rc
  [[ -d "$dir" ]] || { atk_log "no hooks in hooks/$WAVE_N/$1"; return 0; }
  for f in "$dir"/*; do
    [[ -f "$f" && -x "$f" ]] || continue
    rc=0
    ATK_WAVE="$WAVE_N" ATK_DRY_RUN="$ATK_DRY_RUN" ATK_RUN_ID="$ATK_RUN_ID" "$f" || rc=$?
    if (( rc != 0 )); then
      atk_log "hook $\{f##*/} exited $rc"
      local id
      wave_live
      for id in "$\{WAVE_LIVE[@]}"; do WAVE_FAILED[$id]="$2"; done
      return 0
    fi
    atk_log "hook $\{f##*/} done"
  done
  return 0
}
`;
}

/** Bash that takes the script's own options off `"$@"` into `WAVE_ARGS`, the rest going to `atk_init_tool`. */
function optionParser(options                       )         {
  const defaults = options.map((o) => `${o.variable}=${shq(o.default ?? (o.value ? '' : '0'))}`).join('\n');
  const cases = options.map((o) => (o.value
    ? `    ${o.flag}) [[ -n "\${2:-}" ]] || { echo "${o.flag} needs a value" >&2; exit ${EXIT_CODES.usage}; }; ${o.variable}="$2"; shift 2 ;;`
    : `    ${o.flag}) ${o.variable}=1; shift ;;`)).join('\n');
  const help = options.map((o) => `#   ${(o.flag + (o.value ? ' VALUE' : '')).padEnd(34)}${o.help}`).join('\n');
  return `${help ? `# Options besides the common ones (--wave --item --dry-run --gate-override --once --timeout):\n${help}\n` : ''}${defaults}
WAVE_ARGS=()
while (( $# )); do
  case "$1" in
${cases}
    *) WAVE_ARGS+=("$1"); shift ;;
  esac
done`;
}

/** A wave script: header, own options, `lib/atk.sh`, `atk_init_tool`, the wave functions, the lock, the body. */
export function waveScript(spec                )         {
  const lib = libPathFrom(spec.file, 'atk.sh');
  const options = spec.options ?? [];
  const about = (spec.about ?? []).map((l) => (l ? `# ${l}` : '#')).join('\n');
  return code`#!/usr/bin/env bash
# ${spec.summary}
${about ? `${about}\n` : ''}# Changes are made by default; --dry-run prints each change instead. Exit codes: 0 ok, 2 usage,
# 3 missing tool or credential, 4 gate not open, 5 pre-check failed, 10 some items failed, 1 other.
set -Eeuo pipefail
${optionParser(options)}
source "$(cd "$(dirname "$\{BASH_SOURCE[0]}")" && pwd)/${lib}"
atk_init_tool ${spec.channel} --wave ${spec.wave} "$\{WAVE_ARGS[@]}"
${spec.needs?.length ? `atk_need ${spec.needs.join(' ')}\n` : ''}
${waveFunctions(spec.wave)}
${spec.functions ? `${spec.functions.trim()}\n` : ''}
${spec.lock === false ? '' : 'wave_lock\n'}wave_items
${spec.body.trim()}
`;
}

/** The wave's per-item facts as bash: lag allowed, environment, OS family, old names of renamed servers, production flag. */
export function waveDataSh(w          )         {
  const assoc = (name        , pairs                                        )         =>
    `declare -A ${name}=(${pairs.map(([k, v]) => `[${shq(k)}]=${shq(v)}`).join(' ')})`;
  return [
    `WAVE_PRODUCTION=${w.production ? 1 : 0}`,
    assoc('WAVE_LAG', w.items.map((i) => [i.item.id, String(i.lagSeconds)]         )),
    assoc('WAVE_ENV', w.items.map((i) => [i.item.id, i.env ?? '']         )),
    assoc('WAVE_OS', w.items.map((i) => [i.item.id, i.windows ? 'windows' : 'linux']         )),
    assoc('WAVE_RENAMED', w.items.filter((i) => i.rename && i.rename.toLowerCase() !== i.item.name.toLowerCase()).map((i) => [i.item.id, i.item.name]         )),
  ].join('\n');
}

/** `waves/wave-<n>/<file>`. */
export function waveFile(n        , file        )         {
  return `waves/wave-${n}/${file}`;
}

/** A slug for names derived from an item (Azure LB address names and the like). */
export function slugOf(name        )         {
  return slugName(name).replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'item';
}
