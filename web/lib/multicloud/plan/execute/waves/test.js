/**
 * `waves/wave-<n>/replicate.sh` and `waves/wave-<n>/test.sh` (addendum A.6.2,
 * A.7.1).
 *
 * replicate.sh: the pre-checks of the replicate stage, then per item the
 * path's `prepare` and `replicate` verbs (idempotent: a re-run continues);
 * with `--once`, only the path's `status --once` (for cron).
 *
 * test.sh:
 *   1. the pre-checks of the test stage;
 *   2. per path `test` for the testable paths; paths without a test (HCX,
 *      vMotion, VCF import, specialist and the core paths) write `test`
 *      `skipped` with the reason, and G1 then needs a rollback rehearsal
 *      (`rollback.sh --rehearse --item <nonprod item>`);
 *   3. `validate.sh --phase test` (validate.yml on `wave_<n>_test`);
 *   4. the app owners' UAT, recorded in the tracker as the test sign-off;
 *   5. per path `test-cleanup`, with `ATK_TEST_PASSED` in its environment,
 *      then the orchestrator's `test-cleanup` event with `data.passed`.
 */

import { EXIT_CODES } from '../contract.js';
import { casePattern, NO_TEST_PATHS,                waveDataSh, waveFile, waveScript } from './common.js';

export function renderReplicate(w          )         {
  const file = waveFile(w.n, 'replicate.sh');
  const functions = `${waveDataSh(w)}
step_precheck() {
  local rc=0
  wave_live
  wave_item_args
  wave_kit "waves/wave-$WAVE_N/precheck.sh" --stage replicate "\${WAVE_ITEM_ARGS[@]}" || rc=$?
  if (( rc != 0 )); then
    atk_event - precheck failed "" "pre-checks of the replicate stage failed (exit $rc)" stepNo=1
    exit "$rc"
  fi
}
prepare_item() { wave_path prepare "$1"; }
replicate_item() { wave_path replicate "$1"; }
status_item() { wave_path status "$1" --once; }
`;
  const body = `
atk_need jq
if (( \${#WAVE_ITEMS[@]} == 0 )); then atk_event - replicate skipped "" "no items in wave $WAVE_N"; exit 0; fi
if (( ATK_ONCE )); then
  wave_step 1 replicate "replication status (once)" status_each
else
  wave_step 1 precheck "pre-checks (replicate stage)" step_precheck
  wave_step 2 prepare "prepare the sources and targets" prepare_each
  wave_step 3 replicate "start or continue replication" replicate_each
fi
if (( \${#WAVE_FAILED[@]} )); then exit ${EXIT_CODES.partial}; fi
atk_log "next: poll with waves/wave-$WAVE_N/replicate.sh --once, then test with waves/wave-$WAVE_N/test.sh"
`;
  return waveScript({
    file, wave: w.n, channel: 'orchestrator',
    summary: `Wave ${w.n} replication: the replicate-stage pre-checks, then prepare and replicate per item (--once: status only).`,
    functions: `${functions}
status_each() { wave_each status_item; }
prepare_each() { wave_each prepare_item; }
replicate_each() { wave_each replicate_item; }
WAVE_CONTINUE=1`,
    body,
  });
}

export function renderTest(w          )         {
  const file = waveFile(w.n, 'test.sh');
  const functions = `${waveDataSh(w)}
declare -A TEST_PASSED=()
step_precheck() {
  local rc=0
  wave_live
  wave_item_args
  wave_kit "waves/wave-$WAVE_N/precheck.sh" --stage test "\${WAVE_ITEM_ARGS[@]}" || rc=$?
  if (( rc != 0 )); then
    atk_event - precheck failed "" "pre-checks of the test stage failed (exit $rc)" stepNo=1
    exit "$rc"
  fi
}
testable() {
  case "\${ATK_ITEM_PATH[$1]}" in ${casePattern(NO_TEST_PATHS)}) return 1 ;; esac
  return 0
}
test_item() {
  local id="$1"
  if ! testable "$id"; then
    ATK_EVENT_PATH="\${ATK_ITEM_PATH[$id]}" atk_event "$id" test skipped "" "no test migration on the \${ATK_ITEM_PATH[$id]} path: G1 needs a rollback rehearsal (rollback.sh --rehearse --item <a nonprod item on this path>)" rehearsalNeeded=true
    return 0
  fi
  wave_path test "$id"
}
step_test() { wave_each test_item; }
step_validate() {
  local rc=0 file="$ATK_STATUS/events.jsonl" id p
  wave_live
  wave_item_args
  wave_kit "waves/wave-$WAVE_N/validate.sh" --phase test "\${WAVE_ITEM_ARGS[@]}" || rc=$?
  case "$rc" in ${EXIT_CODES.usage}|${EXIT_CODES.missing}) exit "$rc" ;; esac
  for id in "\${WAVE_LIVE[@]}"; do
    testable "$id" || continue
    p=""
    if [[ -f "$file" ]]; then
      p="$(jq -r --arg run "$ATK_RUN_ID" --arg id "$id" 'select(.runId == $run and .item == $id and .step == "validate" and (.outcome == "succeeded" or .outcome == "failed")) | (.data.passed // (.outcome == "succeeded")) | tostring' "$file" | tail -n 1)"
    fi
    TEST_PASSED[$id]="\${p:-false}"
  done
}
step_uat() {
  atk_log "UAT: the app owners test on the test copies and record the test sign-off in the tracker (Migration & Utilities, Track)"
}
cleanup_item() {
  local id="$1" passed rc=0
  testable "$id" || return 0
  passed="\${TEST_PASSED[$id]:-false}"
  ATK_TEST_PASSED="$passed" wave_path test-cleanup "$id" || rc=$?
  if (( rc != 0 )); then return "$rc"; fi
  if (( ATK_DRY_RUN )); then return 0; fi
  ATK_EVENT_PATH="\${ATK_ITEM_PATH[$id]}" atk_event "$id" test-cleanup succeeded "" "test result: validation $passed" passed="$passed"
}
step_cleanup() { wave_each cleanup_item; }
`;
  const body = `
atk_need jq
if (( \${#WAVE_ITEMS[@]} == 0 )); then atk_event - test skipped "" "no items in wave $WAVE_N"; exit 0; fi
wave_step 1 precheck "pre-checks (test stage)" step_precheck
wave_step 2 test "launch the test copies" step_test
wave_step 3 validate "validate the test copies" step_validate
atk_event - manual skipped "" "step 4, UAT: the app owners' test sign-off is recorded in the tracker" stepNo=4
step_uat
wave_step 5 test-cleanup "remove the test copies and record the result" step_cleanup
if (( \${#WAVE_FAILED[@]} )); then exit ${EXIT_CODES.partial}; fi
atk_log "next: G1 at T-5 (the tracker), then waves/wave-$WAVE_N/cutover.sh in the window"
`;
  return waveScript({
    file, wave: w.n, channel: 'orchestrator',
    summary: `Wave ${w.n} test migration (A.7.1): test copies, validation, UAT, clean-up with the result.`,
    about: ['Paths without a test write "skipped"; G1 then needs rollback.sh --rehearse --item <a nonprod item on that path>.'],
    functions,
    body,
  });
}
