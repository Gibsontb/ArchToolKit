/**
 * `waves/wave-<n>/cutover.sh` (addendum A.7.2): the cutover of one wave (or
 * `--item`), in fourteen steps after the lock and the gate. Each step writes
 * wave-level `started` / `succeeded` / `failed` events (`data.stepNo`), and
 * the items' own events come from the scripts each step runs (the path
 * scripts through the manifest's script column, the source adapters, dns.sh,
 * lb.sh, validate.sh) or from the orchestrator itself.
 *
 * A failed item stops the wave after the step (exit 10) and the script
 * prints the `rollback.sh` line; with `--continue-on-item-failure` the other
 * items carry on. G2 (`status/gates/wave-<n>-go.json`, decision go, this
 * plan) must be open, else exit 4; `--gate-override "<reason>"` proceeds and
 * records the reason (a `gate` event with `data.override`), which the
 * tracker logs as a decision.
 */

import { EXIT_CODES } from '../contract.js';
import {
  casePattern, DELTA_COPY_PATHS, NO_NEW_TARGET, NO_SYNC_PATHS, SOURCE_KEPT_AT_CUTOVER, SOURCE_STOPPED_BY_CUTOVER, SYNC_IN_CUTOVER,
                 waveDataSh, waveFile, waveScript,
} from './common.js';

/** The fourteen steps (and step 0), with the StepId each reports as. */
export const CUTOVER_STEPS                                                                                    = Object.freeze([
  { no: 0, step: 'gate', label: 'lock and G2 (go / no-go)' },
  { no: 1, step: 'precheck', label: 'pre-checks' },
  { no: 2, step: 'manual', label: 'pre-cutover hooks' },
  { no: 3, step: 'freeze', label: 'freeze (load balancer drained, app services stopped, databases read-only)' },
  { no: 4, step: 'final-sync', label: 'final sync' },
  { no: 5, step: 'stop-source', label: 'stop the source (restore point, then stop)' },
  { no: 6, step: 'cutover', label: 'cut over (per path)' },
  { no: 7, step: 'start-target', label: 'start the target' },
  { no: 8, step: 'adopt', label: 'adopt into Terraform' },
  { no: 9, step: 'dns-switch', label: 'network identity (DNS, then the load balancer)' },
  { no: 10, step: 'post-config', label: 'post-configuration (site.yml)' },
  { no: 11, step: 'identity', label: 'server identity (identity.yml)' },
  { no: 12, step: 'manual', label: 'post-cutover hooks' },
  { no: 13, step: 'validate', label: 'validate' },
  { no: 14, step: 'cutover', label: 'report' },
]);

export function renderCutover(w          )         {
  const file = waveFile(w.n, 'cutover.sh');
  const functions = `${waveDataSh(w)}
WAVE_ROLLBACK_HINT="waves/wave-$WAVE_N/rollback.sh"
WAVE_SYNC_MINUTES="\${ATK_FINAL_SYNC_MINUTES:-60}"

# mark_run_failures STEP: items whose STEP events failed in this run (written by a child script) are failed here too.
mark_run_failures() {
  local file="$ATK_STATUS/events.jsonl" id
  [[ -f "$file" ]] || return 0
  for id in $(jq -r --arg run "$ATK_RUN_ID" --arg step "$1" 'select(.runId == $run and .step == $step and .outcome == "failed" and .item != null) | .item' "$file" | sort -u); do
    if [[ -n "\${ATK_NAME[$id]:-}" && -z "\${WAVE_FAILED[$id]:-}" ]]; then WAVE_FAILED[$id]="$1"; fi
  done
  return 0
}
# mark_all_live STEP: a step that ran over the whole selection failed: every live item (workloads only with 'workloads').
mark_all_live() {
  local id
  wave_live
  for id in "\${WAVE_LIVE[@]}"; do
    if [[ "\${2:-}" == workloads && "\${ATK_KIND[$id]}" == database ]]; then continue; fi
    WAVE_FAILED[$id]="$1"
  done
  return 0
}
# child RC: stop at once on usage, missing-tool, gate or pre-check exits of a child script.
child_rc() {
  case "$1" in
    ${EXIT_CODES.usage}|${EXIT_CODES.missing}|${EXIT_CODES.gate}) atk_log "stopping: a step exited $1"; exit "$1" ;;
  esac
  return 0
}
# item_event ID STEP OUTCOME DETAIL [k=v...]: an item's event from the orchestrator.
item_event() {
  local id="$1" step="$2" outcome="$3" detail="$4"
  shift 4
  atk_event "$id" "$step" "$outcome" "" "$detail" "$@"
}

# ---------------------------------------------------------------- 1 pre-checks
step_precheck() {
  local rc=0
  wave_live
  wave_item_args
  wave_kit "waves/wave-$WAVE_N/precheck.sh" --stage cutover "\${WAVE_ITEM_ARGS[@]}" || rc=$?
  child_rc "$rc"
  if (( rc != 0 )); then
    atk_event - precheck failed "" "step 1, pre-checks failed (exit $rc): nothing was changed" stepNo=1
    exit ${EXIT_CODES.precheck}
  fi
}

# ---------------------------------------------------------------- 2 / 12 hooks
step_hooks_pre() { wave_hooks pre-cutover.d manual; }
step_hooks_post() { wave_hooks post-cutover.d manual; }

# ---------------------------------------------------------------- 3 freeze
step_freeze() {
  local rc=0
  wave_live
  wave_item_args
  wave_kit lb/lb.sh drain --wave "$WAVE_N" "\${WAVE_ITEM_ARGS[@]}" || rc=$?
  child_rc "$rc"
  mark_run_failures freeze
  rc=0
  wave_playbook freeze.yml "$(wave_limit "wave_\${WAVE_N}_sources")" || rc=$?
  if (( rc != 0 )); then atk_log "freeze.yml exited $rc"; mark_all_live freeze; fi
  local id
  wave_live
  for id in "\${WAVE_LIVE[@]}"; do
    if [[ "\${ATK_ITEM_PATH[$id]}" == k8s-velero ]]; then item_event "$id" freeze skipped "Kubernetes components are scaled to 0 by the k8s-velero path's cutover"; fi
  done
}

# ---------------------------------------------------------------- 4 final sync
sync_ok() {
  local id="$1" lag insync
  wave_path status "$id" --once > /dev/null || return 1
  lag="$(wave_data "$id" replicate lagSeconds)"
  insync="$(wave_data "$id" replicate inSync)"
  if [[ -n "$lag" ]]; then (( \${lag%.*} <= \${WAVE_LAG[$id]:-60} )); return; fi
  [[ "$insync" != false ]]
}
sync_item() {
  local id="$1" p="\${ATK_ITEM_PATH[$1]}" rc=0
  case "$p" in
    ${casePattern(NO_SYNC_PATHS)}) item_event "$id" final-sync skipped "nothing to sync on the $p path"; return 0 ;;
    ${casePattern(SYNC_IN_CUTOVER)}) item_event "$id" final-sync skipped "the $p cutover does the final sync"; return 0 ;;
    ${casePattern(DELTA_COPY_PATHS)})
      item_event "$id" final-sync started "last delta copy"
      wave_path replicate "$id" || rc=$?
      if (( rc != 0 )); then item_event "$id" final-sync failed "the last delta copy exited $rc"; return "$rc"; fi
      item_event "$id" final-sync succeeded "last delta copy done"
      return 0 ;;
  esac
  item_event "$id" final-sync started "waiting for the lag (at most \${WAVE_LAG[$id]:-60} s) and the backlog"
  if atk_wait_until "$WAVE_SYNC_MINUTES" 30 sync_ok "$id"; then
    item_event "$id" final-sync succeeded "in sync" lagSeconds="$(wave_data "$id" replicate lagSeconds)"
    return 0
  fi
  item_event "$id" final-sync failed "not in sync after $WAVE_SYNC_MINUTES minutes (ATK_FINAL_SYNC_MINUTES or --timeout)"
  return 1
}
step_sync() { wave_each sync_item; }

# ---------------------------------------------------------------- 5 stop the source
stop_item() {
  local id="$1" p="\${ATK_ITEM_PATH[$1]}" rc=0
  if [[ "\${ATK_KIND[$id]}" == database ]]; then item_event "$id" stop-source skipped "a database: its switchover stops writes on the source"; return 0; fi
  case "$p" in
    ${casePattern(SOURCE_STOPPED_BY_CUTOVER)}) item_event "$id" stop-source skipped "the $p cutover stops (or moves) the source itself"; return 0 ;;
    ${casePattern(SOURCE_KEPT_AT_CUTOVER)}) item_event "$id" stop-source skipped "the source keeps running until decommission ($p)"; return 0 ;;
  esac
  wave_source snapshot "$id" stop-source || rc=$?
  if (( rc != 0 )); then return "$rc"; fi
  wave_source stop "$id" stop-source
}
step_stop() { wave_each stop_item; }

# ---------------------------------------------------------------- 6 cut over
cut_item() { wave_path cutover "$1"; }
step_cut() { wave_each cut_item; }

# ---------------------------------------------------------------- 7 start the target
target_state() {
  local p="$1" tid="$2"
  case "$p" in
    aws) aws ec2 describe-instances --instance-ids "$tid" --query 'Reservations[0].Instances[0].State.Name' --output text ;;
    azure) az vm get-instance-view --ids "$tid" --query "instanceView.statuses[?starts_with(code, 'PowerState/')].code | [0]" -o tsv | sed 's#PowerState/##' ;;
    google) gcloud compute instances describe "$tid" --format='value(status)' | tr '[:upper:]' '[:lower:]' ;;
    oci) oci compute instance get --instance-id "$tid" --query 'data."lifecycle-state"' --raw-output | tr '[:upper:]' '[:lower:]' ;;
  esac
}
start_item() {
  local id="$1" p tid state
  if [[ "\${ATK_KIND[$id]}" == database ]]; then item_event "$id" start-target skipped "a database: the path's cutover confirms the service"; return 0; fi
  case "\${ATK_ITEM_PATH[$id]}" in
    ${casePattern(NO_NEW_TARGET)}) item_event "$id" start-target skipped "the \${ATK_ITEM_PATH[$id]} path brings no new VM to start (or verifies it itself)"; return 0 ;;
  esac
  p="$(wave_platform "$id")"
  case "$p" in aws|azure|google|oci) ;; *) item_event "$id" start-target skipped "the $\{p:-unknown} target is verified by the path"; return 0 ;; esac
  tid="$(wave_data "$id" cutover targetId)"
  if [[ -z "$tid" ]]; then
    if (( ATK_DRY_RUN )); then item_event "$id" start-target skipped "the target id is known after the cutover"; return 0; fi
    item_event "$id" start-target skipped "the cutover reported no targetId: check that the target runs"
    return 0
  fi
  case "$p" in aws) atk_need aws ;; azure) atk_need az ;; google) atk_need gcloud ;; oci) atk_need oci ;; esac
  state="$(target_state "$p" "$tid")" || { item_event "$id" start-target failed "could not read the target's state"; return 1; }
  if [[ "$state" == running ]]; then item_event "$id" start-target skipped "running" targetId="$tid"; return 0; fi
  item_event "$id" start-target started "the target is $\{state:-unknown}: starting it"
  case "$p" in
    aws) atk_run aws ec2 start-instances --instance-ids "$tid" --output text > /dev/null || return 1 ;;
    azure) atk_run az vm start --ids "$tid" -o none || return 1 ;;
    google) atk_run gcloud compute instances start "$tid" || return 1 ;;
    oci) atk_run oci compute instance action --instance-id "$tid" --action START --wait-for-state RUNNING > /dev/null || return 1 ;;
  esac
  if (( ! ATK_DRY_RUN )) && ! atk_wait_until 15 20 target_running "$p" "$tid"; then item_event "$id" start-target failed "the target did not reach running"; return 1; fi
  item_event "$id" start-target succeeded "running" targetId="$tid"
}
target_running() { [[ "$(target_state "$1" "$2")" == running ]]; }
step_start() { wave_each start_item; }

# ---------------------------------------------------------------- 8 adopt into Terraform
adopt_value() {
  local id="$1" p="$2" tid vm nic disk
  tid="$(wave_data "$id" cutover targetId)"
  if [[ "$p" == azure ]]; then
    vm="$(wave_data "$id" cutover vmId)"
    nic="$(wave_data "$id" cutover nicId)"
    disk="$(wave_data "$id" cutover osDiskId)"
    vm="\${vm:-$tid}"
    if [[ -n "$vm" && -n "$nic" && -n "$disk" ]]; then jq -nc --arg v "$vm" --arg n "$nic" --arg d "$disk" '{vm_id: $v, nic_id: $n, os_disk_id: $d}'; fi
    return 0
  fi
  if [[ -n "$tid" ]]; then jq -nc --arg v "$tid" '$v'; fi
}
step_adopt() {
  local p id dir file add val cur next rc
  local -A per=()
  wave_live
  for id in "\${WAVE_LIVE[@]}"; do
    if [[ "\${ATK_KIND[$id]}" == database ]]; then item_event "$id" adopt skipped "a database: adopted by its own blueprint"; continue; fi
    case "\${ATK_ITEM_PATH[$id]}" in ${casePattern(NO_NEW_TARGET)}) item_event "$id" adopt skipped "no new VM on the \${ATK_ITEM_PATH[$id]} path"; continue ;; esac
    p="$(wave_platform "$id")"
    case "$p" in aws|azure|google|oci) per[$p]+="$id " ;; *) item_event "$id" adopt skipped "nothing to adopt on $\{p:-an unknown platform}" ;; esac
  done
  for p in "\${!per[@]}"; do
    dir="$ATK_ROOT/terraform/$p"
    file="$dir/cutover.auto.tfvars.json"
    add='{}'
    for id in \${per[$p]}; do
      val="$(adopt_value "$id" "$p")"
      if [[ -z "$val" ]]; then item_event "$id" adopt skipped "the cutover reported no target id to adopt"; continue; fi
      add="$(jq -c --arg k "\${ATK_NAME[$id]}" --argjson v "$val" '.[$k] = $v' <<< "$add")"
    done
    [[ "$add" != '{}' ]] || continue
    if [[ ! -d "$dir" ]]; then
      for id in \${per[$p]}; do item_event "$id" adopt failed "no terraform/$p in the project"; WAVE_FAILED[$id]=adopt; done
      continue
    fi
    cur='{}'
    if [[ -f "$file" ]]; then cur="$(< "$file")"; fi
    next="$(jq --argjson add "$add" '.cutover_instance_ids = ((.cutover_instance_ids // {}) + $add)' <<< "$cur")"
    if [[ "$(jq -S . <<< "$cur")" == "$(jq -S . <<< "$next")" ]]; then
      for id in \${per[$p]}; do item_event "$id" adopt skipped "already in terraform/$p/cutover.auto.tfvars.json"; done
      continue
    fi
    if (( ATK_DRY_RUN )); then
      atk_log "dry-run: would merge $(jq -c 'keys' <<< "$add") into terraform/$p/cutover.auto.tfvars.json"
    else
      printf '%s\\n' "$next" > "$file"
      atk_need terraform
    fi
    rc=0
    atk_run terraform -chdir="$dir" apply -auto-approve -input=false || rc=$?
    for id in \${per[$p]}; do
      if [[ -z "$(adopt_value "$id" "$p")" ]]; then continue; fi
      if (( rc == 0 )); then item_event "$id" adopt succeeded "adopted into terraform/$p" platform="$p"
      else item_event "$id" adopt failed "the Terraform apply of terraform/$p exited $rc"; WAVE_FAILED[$id]=adopt; fi
    done
  done
}

# ---------------------------------------------------------------- 9 network identity
step_network() {
  local rc=0
  wave_live
  wave_item_args
  wave_kit dns/dns.sh switch --wave "$WAVE_N" "\${WAVE_ITEM_ARGS[@]}" || rc=$?
  child_rc "$rc"
  mark_run_failures dns-switch
  rc=0
  wave_live
  wave_item_args
  if (( \${#WAVE_LIVE[@]} )); then
    wave_kit lb/lb.sh switch --wave "$WAVE_N" "\${WAVE_ITEM_ARGS[@]}" || rc=$?
    child_rc "$rc"
    mark_run_failures lb-switch
  fi
}

# ---------------------------------------------------------------- 10 post-configuration, 11 identity
per_workload_event() {
  local step="$1" outcome="$2" detail="$3" id
  wave_live
  for id in "\${WAVE_LIVE[@]}"; do
    if [[ "\${ATK_KIND[$id]}" == database ]]; then continue; fi
    item_event "$id" "$step" "$outcome" "$detail"
  done
}
step_postconfig() {
  local rc=0 limit
  limit="$(wave_limit "wave_$WAVE_N")"
  if [[ ! -f "$ATK_ROOT/ansible/site.yml" ]]; then per_workload_event post-config skipped "no ansible/site.yml in the project"; return 0; fi
  if (( ! ATK_DRY_RUN )); then
    atk_need ansible-playbook
  fi
  atk_run ansible-playbook -i "$WAVE_INVENTORY" "$ATK_ROOT/ansible/site.yml" --limit "$limit" || rc=$?
  if (( rc != 0 )); then per_workload_event post-config failed "site.yml exited $rc"; mark_all_live post-config workloads; return 0; fi
  per_workload_event post-config succeeded "site.yml applied"
}
step_identity() {
  local rc=0
  wave_playbook identity.yml "$(wave_limit "wave_$WAVE_N")" || rc=$?
  if (( rc != 0 )); then per_workload_event identity failed "identity.yml exited $rc"; mark_all_live identity workloads; return 0; fi
  per_workload_event identity succeeded "identity.yml applied"
}

# ---------------------------------------------------------------- 13 validate
step_validate() {
  local rc=0
  wave_live
  wave_item_args
  wave_kit "waves/wave-$WAVE_N/validate.sh" --phase cutover "\${WAVE_ITEM_ARGS[@]}" || rc=$?
  child_rc "$rc"
  mark_run_failures validate
}
`;
  const body = `
atk_need jq
if (( \${#WAVE_ITEMS[@]} == 0 )); then
  atk_event - cutover skipped "" "no items in wave $WAVE_N"
  exit 0
fi
if (( ATK_DRY_RUN )); then atk_log "dry run: every change is printed, not made; read-only checks still run"; fi

# 0 lock (held since the start) and G2
atk_event - gate started "" "step 0, lock and G2 (go / no-go)" stepNo=0
atk_gate G2

wave_step 1 precheck "pre-checks" step_precheck
wave_step 2 manual "pre-cutover hooks" step_hooks_pre
wave_step 3 freeze "freeze (load balancer drained, app services stopped, databases read-only)" step_freeze
wave_step 4 final-sync "final sync" step_sync
wave_step 5 stop-source "stop the source (restore point, then stop)" step_stop
wave_step 6 cutover "cut over" step_cut
wave_step 7 start-target "start the target" step_start
wave_step 8 adopt "adopt into Terraform" step_adopt
wave_step 9 dns-switch "network identity (DNS, then the load balancer)" step_network
wave_step 10 post-config "post-configuration (site.yml)" step_postconfig
wave_step 11 identity "server identity (identity.yml)" step_identity
wave_step 12 manual "post-cutover hooks" step_hooks_post
wave_step 13 validate "validate" step_validate

# 14 report
ok=0
bad=0
for id in "\${WAVE_ITEMS[@]}"; do
  if [[ -n "\${WAVE_FAILED[$id]:-}" ]]; then bad=$(( bad + 1 )); else ok=$(( ok + 1 )); fi
done
if (( bad > 0 )); then
  atk_event - cutover failed "" "step 14, report: $ok item(s) cut over, $bad failed" stepNo=14 summary=true ok="$ok" failed="$bad"
else
  atk_event - cutover succeeded "" "step 14, report: $ok item(s) cut over" stepNo=14 summary=true ok="$ok" failed=0
fi
atk_log "next: commit after acceptance with waves/wave-$WAVE_N/commit.sh (needs G3), or roll back with waves/wave-$WAVE_N/rollback.sh"
if (( bad > 0 )); then
  for id in "\${!WAVE_FAILED[@]}"; do atk_log "failed at \${WAVE_FAILED[$id]}: \${ATK_NAME[$id]} (roll back: waves/wave-$WAVE_N/rollback.sh --item $id)"; done
  exit ${EXIT_CODES.partial}
fi
`;
  return waveScript({
    file, wave: w.n, channel: 'orchestrator',
    summary: `Wave ${w.n} cutover (A.7.2): the lock and G2, then fourteen steps, each with its events.`,
    about: [
      ...CUTOVER_STEPS.map((s) => `  ${String(s.no).padStart(2)}  ${s.label}`),
      'A failed item stops the wave after its step (exit 10) and the rollback line is printed; --continue-on-item-failure',
      'lets the other items carry on. G2 must be open (exit 4); --gate-override "<reason>" records the reason.',
      'Environment: ATK_FINAL_SYNC_MINUTES (default 60), ATK_ANSIBLE_INVENTORY (default <project>/ansible/inventory).',
    ],
    options: [{ flag: '--continue-on-item-failure', variable: 'WAVE_CONTINUE', help: 'carry on with the other items when one fails' }],
    functions,
    body,
  });
}

