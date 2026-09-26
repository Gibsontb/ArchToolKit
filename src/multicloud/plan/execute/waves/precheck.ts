/**
 * `waves/wave-<n>/precheck.sh` (addendum A.7.1): the checks run at every
 * stage start, standalone, and at G1 / G2. Each check writes a `precheck`
 * event per item with `data.check`; the last event per item is a summary
 * (`data.check = summary`), which the tracker's G2 criterion reads.
 *
 * | Check | How |
 * |---|---|
 * | tools | `controller-check.sh` |
 * | vault | `ANSIBLE_VAULT_PASSWORD_FILE` readable, or `ansible-vault view` opens `group_vars/all/vault.yml` |
 * | landing-zone | `terraform -chdir=terraform/<p> output -json landing_zone` has network and subnet ids |
 * | landing-zone-gate | production waves: `status/gates/programme-landing-zone.json` says go for this plan |
 * | quotas | `capacity/fetch-quotas.sh` (WP-19) when the project has it |
 * | replication | the path's `status --once`; at cutover, the lag within the setting |
 * | source-live | the source adapter's `state` (WP-15) |
 * | reachability | `ansible -m ansible.builtin.ping` / `ansible.windows.win_ping` on the source |
 * | dns | `dns/dns.sh check` (exists, TTL at or under 300 s) |
 * | blockers | the wave's newest gate file lists no open coupling blocker for the item |
 * | baseline | `status/baseline/<item>.json` exists |
 * | source-backup | `status/backups/<item>.json` or an attestation in the gate file (else skipped, not failed) |
 * | hooks | `hooks/<wave>/precheck.d/*` (refactor hooks, A.6.10) |
 *
 * Exit 5 when any check failed. Read-only: `--dry-run` changes nothing here.
 */

import { EXIT_CODES } from '../contract.ts';
import { casePattern, NO_STATUS_PATHS, NOT_VALIDATED, type WaveSpec, waveDataSh, waveFile, waveScript } from './common.ts';
import { LANDING_ZONE_GATE_FILE, LANDING_ZONE_GATE_KIND } from './gates.ts';

export type PrecheckStage = 'replicate' | 'test' | 'cutover' | 'commit' | 'decommission' | 'all';
export type PrecheckId = 'tools' | 'vault' | 'landing-zone' | 'landing-zone-gate' | 'quotas' | 'replication' | 'source-live' | 'reachability'
  | 'dns' | 'blockers' | 'baseline' | 'source-backup' | 'hooks';

export const PRECHECK_IDS: readonly PrecheckId[] = Object.freeze([
  'tools', 'vault', 'landing-zone', 'landing-zone-gate', 'quotas', 'replication', 'source-live', 'reachability', 'dns', 'blockers', 'baseline', 'source-backup', 'hooks',
]);

/** Which checks run at which stage. */
export const STAGE_CHECKS: Readonly<Record<PrecheckStage, readonly PrecheckId[]>> = Object.freeze({
  replicate: ['tools', 'landing-zone', 'landing-zone-gate', 'quotas', 'source-live'],
  test: ['tools', 'landing-zone', 'landing-zone-gate', 'quotas', 'replication', 'blockers'],
  cutover: PRECHECK_IDS,
  commit: ['tools'],
  decommission: ['tools'],
  all: PRECHECK_IDS,
});

function stageCase(): string {
  return (Object.keys(STAGE_CHECKS) as PrecheckStage[])
    .map((s) => `    ${s}) [[ " ${STAGE_CHECKS[s].join(' ')} " == *" $1 "* ]] ;;`).join('\n');
}

export function renderPrecheck(w: WaveSpec): string {
  const file = waveFile(w.n, 'precheck.sh');
  const functions = `${waveDataSh(w)}
PRE_STAGE="\${WAVE_STAGE:-all}"
case "$PRE_STAGE" in ${Object.keys(STAGE_CHECKS).join('|')}) ;; *) atk_usage "--stage is one of ${Object.keys(STAGE_CHECKS).join(', ')}" ;; esac
PRE_WAVE_FAILED=""
declare -A PRE_FAILED=()

# pre_on CHECK: the check is part of this stage.
pre_on() {
  case "$PRE_STAGE" in
${stageCase()}
  esac
}
# pre_item ID CHECK OUTCOME DETAIL [k=v...]
pre_item() {
  local id="$1" check="$2" outcome="$3" detail="$4"
  shift 4
  atk_event "$id" precheck "$outcome" "" "$check: $detail" check="$check" stage="$PRE_STAGE" "$@"
  if [[ "$outcome" == failed ]]; then PRE_FAILED[$id]+="$check "; fi
  return 0
}
# pre_wave CHECK OUTCOME DETAIL: a check of the whole wave (its failure fails every item).
pre_wave() {
  atk_event - precheck "$2" "" "$1: $3" check="$1" stage="$PRE_STAGE"
  if [[ "$2" == failed ]]; then PRE_WAVE_FAILED+="$1 "; fi
  return 0
}
# pre_run_failures STEP CHECK: the items this run's STEP events failed (from a child script).
pre_run_failures() {
  local file="$ATK_STATUS/events.jsonl"
  [[ -f "$file" ]] || return 0
  jq -r --arg run "$ATK_RUN_ID" --arg step "$1" --arg check "$2" \\
    'select(.runId == $run and .step == $step and .outcome == "failed" and .item != null and (($check == "") or ((.data // {}).check == $check))) | .item' "$file" | sort -u
}

check_tools() {
  local rc=0
  wave_kit controller-check.sh || rc=$?
  if (( rc == 0 )); then pre_wave tools succeeded "the controller has every tool the kit needs"; else pre_wave tools failed "controller-check.sh exited $rc"; fi
}

check_vault() {
  local vf="$WAVE_INVENTORY/group_vars/all/vault.yml"
  if [[ -n "\${ANSIBLE_VAULT_PASSWORD_FILE:-}" && -r "\${ANSIBLE_VAULT_PASSWORD_FILE}" ]]; then pre_wave vault succeeded "ANSIBLE_VAULT_PASSWORD_FILE is readable"; return 0; fi
  if [[ ! -f "$vf" ]]; then pre_wave vault skipped "no group_vars/all/vault.yml in the inventory"; return 0; fi
  if command -v ansible-vault > /dev/null 2>&1 && ansible-vault view "$vf" < /dev/null > /dev/null 2>&1; then pre_wave vault succeeded "the vault opens"; return 0; fi
  pre_wave vault failed "the vault does not open: set ANSIBLE_VAULT_PASSWORD_FILE"
}

declare -A PRE_LZ=()
lz_state() {
  local p="$1" dir out
  if [[ -n "\${PRE_LZ[$p]:-}" ]]; then printf '%s' "\${PRE_LZ[$p]}"; return 0; fi
  dir="$ATK_ROOT/terraform/$p"
  if [[ ! -d "$dir" ]]; then PRE_LZ[$p]="missing:no terraform/$p in the project"
  elif ! command -v terraform > /dev/null 2>&1; then PRE_LZ[$p]="missing:terraform is not installed"
  elif ! out="$(terraform -chdir="$dir" output -json landing_zone 2> /dev/null)"; then PRE_LZ[$p]="missing:terraform/$p has no landing_zone output (apply the landing zone first)"
  elif ! jq -e '((.network_ids // {}) | length > 0) and ((.subnet_ids // {}) | length > 0)' <<< "$out" > /dev/null 2>&1; then PRE_LZ[$p]="missing:the landing_zone output of terraform/$p has no network or subnet ids"
  else PRE_LZ[$p]="ok:terraform/$p landing_zone output present"
  fi
  printf '%s' "\${PRE_LZ[$p]}"
}
check_landing_zone() {
  local id p s
  for id in "\${WAVE_ITEMS[@]}"; do
    p="$(wave_platform "$id")"
    if [[ -z "$p" ]]; then pre_item "$id" landing-zone skipped "no target platform"; continue; fi
    s="$(lz_state "$p")"
    if [[ "$s" == ok:* ]]; then pre_item "$id" landing-zone succeeded "\${s#ok:}"; else pre_item "$id" landing-zone failed "\${s#missing:}"; fi
  done
}

check_landing_zone_gate() {
  local id f="$ATK_STATUS/${LANDING_ZONE_GATE_FILE}" ok=0 why
  if (( ! WAVE_PRODUCTION )); then return 0; fi
  if [[ -f "$f" ]] && jq -e --arg p "$ATK_PLAN_ID" '.kind == "${LANDING_ZONE_GATE_KIND}" and .decision == "go" and .planId == $p' "$f" > /dev/null 2>&1; then
    ok=1; why="the landing-zone gate is open"
  elif [[ -n "$ATK_GATE_OVERRIDE" ]]; then
    ok=2; why="the landing-zone gate is overridden: $ATK_GATE_OVERRIDE"
  else
    why="production wave: record the landing-zone gate (foundation items F01-F14 green) and export status/${LANDING_ZONE_GATE_FILE}"
  fi
  for id in "\${WAVE_ITEMS[@]}"; do
    if (( ok == 1 )); then pre_item "$id" landing-zone-gate succeeded "$why"
    elif (( ok == 2 )); then pre_item "$id" landing-zone-gate succeeded "$why" override=true
    else pre_item "$id" landing-zone-gate failed "$why"; fi
  done
}

check_quotas() {
  local id f="$ATK_ROOT/capacity/fetch-quotas.sh" rc=0
  if [[ ! -x "$f" ]]; then
    for id in "\${WAVE_ITEMS[@]}"; do pre_item "$id" quotas skipped "no capacity/fetch-quotas.sh in the project: check the quotas by hand"; done
    return 0
  fi
  "$f" > /dev/null || rc=$?
  for id in "\${WAVE_ITEMS[@]}"; do
    if (( rc == 0 )); then pre_item "$id" quotas succeeded "capacity/fetch-quotas.sh passed"; else pre_item "$id" quotas failed "capacity/fetch-quotas.sh exited $rc"; fi
  done
}

check_replication() {
  local id rc lag limit insync
  for id in "\${WAVE_ITEMS[@]}"; do
    case "\${ATK_ITEM_PATH[$id]}" in
      ${casePattern(NO_STATUS_PATHS)}) pre_item "$id" replication skipped "no replication on the \${ATK_ITEM_PATH[$id]} path"; continue ;;
    esac
    rc=0
    wave_path status "$id" --once > /dev/null || rc=$?
    if (( rc != 0 )); then pre_item "$id" replication failed "the path's status exited $rc (stalled, in error or not started)"; continue; fi
    lag="$(wave_data "$id" replicate lagSeconds)"
    insync="$(wave_data "$id" replicate inSync)"
    limit="\${WAVE_LAG[$id]:-60}"
    if [[ "$PRE_STAGE" == cutover || "$PRE_STAGE" == all ]] && [[ -n "$lag" ]] && (( \${lag%.*} > limit )); then
      pre_item "$id" replication failed "lag $lag s is over the $limit s allowed at cutover" lagSeconds="$lag"
    else
      pre_item "$id" replication succeeded "healthy\${lag:+, lag $lag s}\${insync:+, in sync $insync}" \${lag:+lagSeconds=$lag}
    fi
  done
}

check_source_live() {
  local id file out rc state
  for id in "\${WAVE_ITEMS[@]}"; do
    if [[ "\${ATK_KIND[$id]}" == database ]]; then pre_item "$id" source-live skipped "a database: its host is checked"; continue; fi
    file="$(wave_adapter "\${ATK_SOURCE[$id]}")"
    if [[ "$file" == source/operator.sh ]]; then pre_item "$id" source-live skipped "no automation for a \${ATK_SOURCE[$id]} source"; continue; fi
    if [[ ! -f "$ATK_HOME/$file" ]]; then pre_item "$id" source-live failed "no source adapter $file in the kit"; continue; fi
    rc=0
    out="$(wave_source state "$id" precheck 2> /dev/null)" || rc=$?
    state="$(printf '%s' "$out" | awk -F '\\t' 'NF > 1 { print $2; exit }')"
    if (( rc != 0 )) || [[ -z "$state" || "$state" == absent || "$state" == unknown* ]]; then
      pre_item "$id" source-live failed "the source adapter reports \${state:-nothing} (exit $rc)"
    else
      pre_item "$id" source-live succeeded "source $state" sourceState="$state"
    fi
  done
}

check_reachability() {
  local id module rc
  if ! command -v ansible > /dev/null 2>&1; then pre_wave reachability failed "ansible is not installed"; return 0; fi
  for id in "\${WAVE_ITEMS[@]}"; do
    if [[ "\${ATK_KIND[$id]}" == database ]]; then pre_item "$id" reachability skipped "a database: its host is checked"; continue; fi
    module=ansible.builtin.ping
    if [[ "\${WAVE_OS[$id]:-linux}" == windows ]]; then module=ansible.windows.win_ping; fi
    rc=0
    ansible -i "$WAVE_INVENTORY" "\${ATK_NAME[$id]}" -m "$module" > /dev/null 2>&1 || rc=$?
    if (( rc == 0 )); then pre_item "$id" reachability succeeded "$module answered"; else pre_item "$id" reachability failed "$module did not answer (exit $rc): the freeze needs Ansible access to the source"; fi
  done
}

check_dns() {
  local rc=0 id
  wave_live
  wave_item_args
  wave_kit dns/dns.sh check --wave "$WAVE_N" "\${WAVE_ITEM_ARGS[@]}" || rc=$?
  if (( rc == ${EXIT_CODES.missing} )); then pre_wave dns failed "dns.sh is missing a tool or credential"; return 0; fi
  for id in $(pre_run_failures precheck dns); do
    if [[ -n "\${ATK_NAME[$id]:-}" ]]; then PRE_FAILED[$id]+="dns "; fi
  done
  if (( rc != 0 && rc != ${EXIT_CODES.precheck} )); then pre_wave dns failed "dns.sh check exited $rc"; fi
}

check_blockers() {
  local id g newest="" list
  for g in "$ATK_STATUS/gates/wave-$WAVE_N-"*.json; do
    [[ -f "$g" ]] || continue
    if [[ -z "$newest" || "$g" -nt "$newest" ]]; then newest="$g"; fi
  done
  for id in "\${WAVE_ITEMS[@]}"; do
    if [[ -z "$newest" ]]; then pre_item "$id" blockers skipped "no gate file exported for wave $WAVE_N yet"; continue; fi
    list="$(jq -r --arg id "$id" '[.blockers[]? | select(.item == $id) | .issues[]] | join(", ")' "$newest")"
    if [[ -n "$list" ]]; then pre_item "$id" blockers failed "open coupling blockers: $list"; else pre_item "$id" blockers succeeded "no open blockers"; fi
  done
}

check_baseline() {
  local id
  for id in "\${WAVE_ITEMS[@]}"; do
    if [[ "\${ATK_KIND[$id]}" == database ]]; then pre_item "$id" baseline skipped "a database: its host has the baseline"; continue; fi
    case "\${ATK_ITEM_PATH[$id]}" in ${casePattern(NOT_VALIDATED)}) pre_item "$id" baseline skipped "nothing to compare on the \${ATK_ITEM_PATH[$id]} path"; continue ;; esac
    if [[ -f "$ATK_STATUS/baseline/$(wave_file "$id").json" ]]; then pre_item "$id" baseline succeeded "status/baseline has it"
    else pre_item "$id" baseline failed "no baseline: run waves/wave-$WAVE_N/validate.sh --baseline (T-7 and T-1)"; fi
  done
}

check_source_backup() {
  local id g attested
  for id in "\${WAVE_ITEMS[@]}"; do
    attested=0
    if [[ -f "$ATK_STATUS/backups/$(wave_file "$id").json" ]]; then attested=1; fi
    for g in "$ATK_STATUS/gates/wave-$WAVE_N-go.json" "$ATK_STATUS/gates/wave-$WAVE_N-G2.json" "$ATK_STATUS/gates/wave-$WAVE_N-ready.json"; do
      if [[ -f "$g" ]] && jq -e '[.criteria[]? | select(.id == "precheck.source-backup" or .id == "source-backup") | .met] | any' "$g" > /dev/null 2>&1; then attested=1; fi
    done
    if (( attested )); then pre_item "$id" source-backup succeeded "a source backup is attested"
    else pre_item "$id" source-backup skipped "no source backup attestation: confirm the latest backup (status/backups/<item>.json or the gate)"; fi
  done
}

check_hooks() {
  local dir="$ATK_HOME/hooks/$WAVE_N/precheck.d" f rc
  [[ -d "$dir" ]] || return 0
  for f in "$dir"/*; do
    [[ -f "$f" && -x "$f" ]] || continue
    rc=0
    ATK_WAVE="$WAVE_N" ATK_DRY_RUN="$ATK_DRY_RUN" ATK_RUN_ID="$ATK_RUN_ID" "$f" || rc=$?
    if (( rc == 0 )); then pre_wave hooks succeeded "\${f##*/} passed"; else pre_wave hooks failed "\${f##*/} exited $rc"; fi
  done
}
`;
  const body = `
atk_need jq
if (( \${#WAVE_ITEMS[@]} == 0 )); then
  atk_event - precheck skipped "" "no items in wave $WAVE_N" stage="$PRE_STAGE"
  exit 0
fi
atk_event - precheck started "" "pre-checks, stage $PRE_STAGE" stage="$PRE_STAGE"
for check in ${['tools', 'vault', 'landing-zone', 'landing-zone-gate', 'quotas', 'replication', 'source-live', 'reachability', 'dns', 'blockers', 'baseline', 'source-backup', 'hooks'].join(' ')}; do
  if pre_on "$check"; then "check_\${check//-/_}"; fi
done

failed=0
for id in "\${WAVE_ITEMS[@]}"; do
  why="\${PRE_FAILED[$id]:-}\${PRE_WAVE_FAILED}"
  if [[ -n "$why" ]]; then
    atk_event "$id" precheck failed "" "failed: \${why% }" check=summary stage="$PRE_STAGE" failed="\${why% }"
    failed=$(( failed + 1 ))
  else
    atk_event "$id" precheck succeeded "" "every check passed" check=summary stage="$PRE_STAGE"
  fi
done
if (( failed > 0 )); then
  atk_event - precheck failed "" "$failed of \${#WAVE_ITEMS[@]} item(s) failed a pre-check" stage="$PRE_STAGE" failed="$failed"
  exit ${EXIT_CODES.precheck}
fi
atk_event - precheck succeeded "" "every item passed the $PRE_STAGE pre-checks" stage="$PRE_STAGE"
`;
  return waveScript({
    file, wave: w.n, channel: 'orchestrator',
    summary: `Wave ${w.n} pre-checks (A.7.1): run at every stage start, standalone, and for G1 / G2.`,
    about: [`Stages: ${Object.keys(STAGE_CHECKS).join(', ')} (default all). Checks: ${PRECHECK_IDS.join(', ')}.`, 'Read-only; exit 5 when a check failed.'],
    options: [{ flag: '--stage', variable: 'WAVE_STAGE', value: true, default: 'all', help: 'the stage whose checks to run' }],
    functions,
    body,
  });
}

