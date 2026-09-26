/**
 * `waves/wave-<n>/validate.sh` (addendum A.7.5): runs `ansible/validate.yml`
 * (the wrapper around WP-7's `validate` role) and turns the reports it
 * writes, `reports/validation-<host>.json` (`archtoolkit.validation`), into
 * one `validate` event per item with `data.passed` and `data.phase`.
 *
 *   --phase test | cutover | rollback   (default cutover)
 *   --target target | source            (default source for rollback, else target)
 *   --baseline                          capture the performance baseline instead (baseline.yml on the sources, T−7 and T−1)
 *
 * The inventory group is `wave_<n>_test` for the test phase, `wave_<n>_sources`
 * for the source, else `wave_<n>` (or the item names with `--item`). A
 * database item passes when the reports of its hosts pass, or, for a managed
 * database, those of its app's servers in the wave. Only reports written by
 * this run count. A performance regression beyond the tolerance is a
 * warning in the report (`data.warnings`), not a failure.
 */

import { EXIT_CODES } from '../contract.js';
import { casePattern, NOT_VALIDATED,                waveDataSh, waveFile, waveScript } from './common.js';

export function renderValidate(w          )         {
  const file = waveFile(w.n, 'validate.sh');
  const functions = `${waveDataSh(w)}
VAL_PHASE="\${WAVE_PHASE:-cutover}"
case "$VAL_PHASE" in test|cutover|rollback) ;; *) atk_usage "--phase is test, cutover or rollback" ;; esac
VAL_TARGET="\${WAVE_TARGET:-}"
if [[ -z "$VAL_TARGET" ]]; then if [[ "$VAL_PHASE" == rollback ]]; then VAL_TARGET=source; else VAL_TARGET=target; fi; fi
case "$VAL_TARGET" in target|source) ;; *) atk_usage "--target is target or source" ;; esac
VAL_REPORTS='[]'

val_group() {
  if (( WAVE_BASELINE )) || [[ "$VAL_TARGET" == source ]]; then printf 'wave_%s_sources' "$WAVE_N"
  elif [[ "$VAL_PHASE" == test ]]; then printf 'wave_%s_test' "$WAVE_N"
  else printf 'wave_%s' "$WAVE_N"; fi
}
# val_load START: every validation report of this phase written since START.
val_load() {
  local f
  local -a files=()
  for f in "$ATK_ROOT"/reports/validation-*.json; do [[ -f "$f" ]] && files+=("$f"); done
  if (( \${#files[@]} == 0 )); then VAL_REPORTS='[]'; return 0; fi
  VAL_REPORTS="$(jq -s --arg p "$VAL_PHASE" --arg start "$1" --arg plan "$ATK_PLAN_ID" \\
    'map(select(.kind == "archtoolkit.validation" and .phase == $p and .planId == $plan and (.at // "") >= $start))' "\${files[@]}")"
}
# val_of IDS...: "passed|failed|none <count> <warnings> <first failing check>" over the reports of these items.
val_of() {
  jq -r --argjson ids "$(printf '%s\\n' "$@" | jq -R . | jq -sc .)" '
    [ .[] | select(.item as $i | $ids | any(. == $i)) ] as $r
    | if ($r | length) == 0 then "none 0 0 -"
      else "\\(if all($r[]; .passed) then "passed" else "failed" end) \\($r | length) \\([$r[].warnings // [] | length] | add) \\(([$r[].checks[]? | select(.passed == false) | .id] | first) // "-")"
      end' <<< "$VAL_REPORTS"
}
val_item() {
  local id="$1" res verdict n warns first
  local -a hosts=()
  local -a ids=("$id")
  case "\${ATK_ITEM_PATH[$id]}" in
    ${casePattern(NOT_VALIDATED)}) atk_event "$id" validate skipped "" "nothing to validate on the \${ATK_ITEM_PATH[$id]} path" phase="$VAL_PHASE"; return 0 ;;
  esac
  if [[ "\${ATK_KIND[$id]}" == database ]]; then
    mapfile -t hosts < <(wave_json "$id" '(.hosts // [])[]')
    ids=("\${hosts[@]}")
    if (( \${#ids[@]} == 0 )); then
      local other
      for other in "\${WAVE_ITEMS[@]}"; do
        if [[ "\${ATK_KIND[$other]}" == workload && "\${ATK_APP[$other]}" == "\${ATK_APP[$id]}" ]]; then ids+=("$other"); fi
      done
    fi
  fi
  if (( \${#ids[@]} == 0 )); then
    atk_event "$id" validate failed "" "no server to validate this database through" phase="$VAL_PHASE" passed=false
    return 1
  fi
  res="$(val_of "\${ids[@]}")"
  verdict="\${res%% *}"; res="\${res#* }"; n="\${res%% *}"; res="\${res#* }"; warns="\${res%% *}"; first="\${res#* }"
  case "$verdict" in
    passed) atk_event "$id" validate succeeded "" "validation passed ($n report(s), $warns warning(s))" phase="$VAL_PHASE" target="$VAL_TARGET" passed=true warnings="$warns"; return 0 ;;
    failed) atk_event "$id" validate failed "" "validation failed: $first" phase="$VAL_PHASE" target="$VAL_TARGET" passed=false warnings="$warns"; return 1 ;;
    *) atk_event "$id" validate failed "" "no validation report for this item (is its host in the $(val_group) group?)" phase="$VAL_PHASE" target="$VAL_TARGET" passed=false; return 1 ;;
  esac
}
baseline_item() {
  local id="$1"
  if [[ "\${ATK_KIND[$id]}" == database ]]; then return 0; fi
  case "\${ATK_ITEM_PATH[$id]}" in ${casePattern(NOT_VALIDATED)}) return 0 ;; esac
  if [[ -f "$ATK_STATUS/baseline/$(wave_file "$id").json" ]]; then
    atk_event "$id" precheck succeeded "" "baseline captured" check=baseline
  elif (( ATK_DRY_RUN )); then
    atk_event "$id" precheck skipped "" "dry run: the baseline was not captured" check=baseline
  else
    atk_event "$id" precheck failed "" "no baseline written for this item (is its host in the $(val_group) group?)" check=baseline
    return 1
  fi
}
`;
  const body = `
atk_need jq
if (( \${#WAVE_ITEMS[@]} == 0 )); then atk_event - validate skipped "" "no items in wave $WAVE_N"; exit 0; fi
if (( WAVE_BASELINE )); then
  atk_event - precheck started "" "performance baseline" check=baseline
  rc=0
  wave_playbook baseline.yml "$(wave_limit "$(val_group)")" || rc=$?
  if (( rc != 0 )); then atk_log "baseline.yml exited $rc"; fi
  wave_each baseline_item
  if (( \${#WAVE_FAILED[@]} )); then atk_event - precheck failed "" "baseline missing for \${#WAVE_FAILED[@]} item(s)" check=baseline; exit ${EXIT_CODES.partial}; fi
  atk_event - precheck succeeded "" "baseline captured" check=baseline
  exit 0
fi

start="$(atk_now)"
atk_event - validate started "" "validation, phase $VAL_PHASE, on the $VAL_TARGET" phase="$VAL_PHASE" target="$VAL_TARGET"
rc=0
wave_playbook validate.yml "$(wave_limit "$(val_group)")" -e "validate_phase=$VAL_PHASE" || rc=$?
if (( rc != 0 )); then atk_log "validate.yml exited $rc (a host that fails a check fails the play; the reports say which)"; fi
if (( ATK_DRY_RUN )); then
  wave_live
  for id in "\${WAVE_LIVE[@]}"; do atk_event "$id" validate skipped "" "dry run: validation not run" phase="$VAL_PHASE"; done
  atk_event - validate skipped "" "dry run" phase="$VAL_PHASE"
  exit 0
fi
val_load "$start"
WAVE_CONTINUE=1
wave_each val_item
bad=\${#WAVE_FAILED[@]}
if (( bad > 0 )); then
  atk_event - validate failed "" "$bad of \${#WAVE_ITEMS[@]} item(s) failed validation" phase="$VAL_PHASE" failed="$bad"
  exit ${EXIT_CODES.partial}
fi
atk_event - validate succeeded "" "every item passed validation" phase="$VAL_PHASE"
`;
  return waveScript({
    file, wave: w.n, channel: 'orchestrator',
    summary: `Wave ${w.n} validation (A.7.5): validate.yml, then one validate event per item; --baseline captures the baseline.`,
    options: [
      { flag: '--phase', variable: 'WAVE_PHASE', value: true, default: 'cutover', help: 'test, cutover or rollback' },
      { flag: '--target', variable: 'WAVE_TARGET', value: true, help: 'target or source (default source for rollback)' },
      { flag: '--baseline', variable: 'WAVE_BASELINE', help: 'capture the performance baseline (T-7 and T-1)' },
    ],
    functions,
    body,
  });
}
