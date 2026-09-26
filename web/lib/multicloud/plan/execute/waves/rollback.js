/**
 * `waves/wave-<n>/rollback.sh` (addendum A.7.4): the cutover in reverse,
 * per wave or `--item`.
 *
 *   1. `lb.sh revert`, then `dns.sh revert` (the recorded values);
 *   2. per path `rollback` for the servers: the target is stopped, not
 *      deleted, and kept for analysis;
 *   3. the databases: per path `rollback`, switching back through the
 *      reverse replication set up at cutover (a path without one loses the
 *      target's writes, and the statement says so);
 *   4. `source/<origin>.* start` (paths whose rollback returns the VM itself,
 *      such as HCX, are left to the path);
 *   5. `ansible/unfreeze.yml` on the sources;
 *   6. `validate.sh --phase rollback --target source`;
 *   7. the wave's rollback event with the reason; the tracker logs the
 *      decision.
 *
 * Before commit it is automatic. After commit it needs
 * `--after-commit "<reason>"` (exit 2 without it): it prints the per-path
 * data-loss statement before acting and records it; it never refuses.
 * `--rehearse --item <nonprod item>` runs this wave's cutover for that item
 * and then rolls it back, and records a rehearsal (`data.rehearsal = true`),
 * which G1 accepts for paths without a test.
 */

import { EXIT_CODES } from '../contract.js';
import { casePattern, DATA_LOSS, DATA_LOSS_DEFAULT, SOURCE_RETURNED_BY_PATH, shq,                waveDataSh, waveFile, waveScript } from './common.js';

export function renderRollback(w          )         {
  const file = waveFile(w.n, 'rollback.sh');
  const paths = [...new Set(w.items.map((i) => i.item.path))].sort();
  const statements = paths.map((p) => `    ${p}) printf '%s' ${shq(DATA_LOSS[p] ?? DATA_LOSS_DEFAULT)} ;;`).join('\n');
  const noReverse = paths.filter((p) => DATA_LOSS[p] && w.items.some((i) => i.item.path === p && i.item.kind === 'database'));
  const functions = `${waveDataSh(w)}
WAVE_ROLLBACK_HINT=""
loss_statement() {
  case "$1" in
${statements}
    *) printf '%s' ${shq(DATA_LOSS_DEFAULT)} ;;
  esac
}
child_rc() {
  case "$1" in ${EXIT_CODES.usage}|${EXIT_CODES.missing}) exit "$1" ;; esac
  return 0
}
mark_run_failures() {
  local file="$ATK_STATUS/events.jsonl" id
  [[ -f "$file" ]] || return 0
  for id in $(jq -r --arg run "$ATK_RUN_ID" --arg step "$1" 'select(.runId == $run and .step == $step and .outcome == "failed" and .item != null) | .item' "$file" | sort -u); do
    if [[ -n "\${ATK_NAME[$id]:-}" && -z "\${WAVE_FAILED[$id]:-}" ]]; then WAVE_FAILED[$id]="$1"; fi
  done
  return 0
}
step_network() {
  local rc=0
  wave_live
  wave_item_args
  wave_kit lb/lb.sh revert --wave "$WAVE_N" "\${WAVE_ITEM_ARGS[@]}" || rc=$?
  child_rc "$rc"
  rc=0
  wave_kit dns/dns.sh revert --wave "$WAVE_N" "\${WAVE_ITEM_ARGS[@]}" || rc=$?
  child_rc "$rc"
  mark_run_failures lb-switch
  mark_run_failures dns-switch
}
server_item() {
  if [[ "\${ATK_KIND[$1]}" == database ]]; then return 0; fi
  wave_path rollback "$1"
}
database_item() {
  if [[ "\${ATK_KIND[$1]}" != database ]]; then return 0; fi
  wave_path rollback "$1"
}
source_item() {
  local id="$1"
  if [[ "\${ATK_KIND[$id]}" == database ]]; then return 0; fi
  case "\${ATK_ITEM_PATH[$id]}" in
    ${casePattern(SOURCE_RETURNED_BY_PATH)}) atk_event "$id" manual skipped "" "the \${ATK_ITEM_PATH[$id]} rollback returns the source itself"; return 0 ;;
  esac
  wave_source start "$id" manual
}
step_servers() { wave_each server_item; }
step_databases() { wave_each database_item; }
step_sources() { wave_each source_item; }
step_unfreeze() {
  local rc=0
  wave_playbook unfreeze.yml "$(wave_limit "wave_\${WAVE_N}_sources")" || rc=$?
  if (( rc != 0 )); then atk_log "unfreeze.yml exited $rc: start the app services on the sources by hand"; wave_live; local id; for id in "\${WAVE_LIVE[@]}"; do WAVE_FAILED[$id]=unfreeze; done; fi
}
step_validate() {
  local rc=0
  wave_live
  wave_item_args
  wave_kit "waves/wave-$WAVE_N/validate.sh" --phase rollback --target source "\${WAVE_ITEM_ARGS[@]}" || rc=$?
  child_rc "$rc"
  mark_run_failures validate
}
`;
  const body = `
atk_need jq
if (( \${#WAVE_ITEMS[@]} == 0 )); then atk_event - rollback skipped "" "no items in wave $WAVE_N"; exit 0; fi
if [[ -n "$WAVE_AFTER_COMMIT" && "$WAVE_AFTER_COMMIT" =~ ^[[:space:]]*$ ]]; then atk_usage "--after-commit needs a reason"; fi

# A rehearsal: one nonprod item, cut over, then rolled back.
if (( WAVE_REHEARSE )); then
  (( \${#WAVE_ITEMS[@]} == 1 && \${#ATK_ITEM_FILTER[@]} == 1 )) || atk_usage "--rehearse needs exactly one --item (a nonprod item of this wave)"
  rid="\${WAVE_ITEMS[0]}"
  if [[ "\${WAVE_ENV[$rid]:-}" == prod ]]; then atk_usage "--rehearse runs on a nonprod item; \${ATK_NAME[$rid]} is production"; fi
  atk_event "$rid" rollback started "" "rollback rehearsal on \${ATK_ITEM_PATH[$rid]}: cutover, then rollback" rehearsal=true
  rc=0
  wave_kit "waves/wave-$WAVE_N/cutover.sh" --item "$rid" --gate-override "rollback rehearsal on a nonprod item" || rc=$?
  if (( rc != 0 )); then
    atk_event "$rid" rollback failed "" "rehearsal: the cutover exited $rc; rolling back what was done" rehearsal=true
  fi
fi

# After commit: a reason, and the data-loss statement first.
committed=()
for id in "\${WAVE_ITEMS[@]}"; do
  if wave_committed "$id"; then committed+=("$id"); fi
done
if (( \${#committed[@]} )); then
  if [[ -z "$WAVE_AFTER_COMMIT" ]]; then
    for id in "\${committed[@]}"; do atk_log "committed: \${ATK_NAME[$id]} (\${ATK_ITEM_PATH[$id]})"; done
    atk_usage "\${#committed[@]} item(s) are committed: roll back with --after-commit \\"<reason>\\" (the data-loss statement is printed first)"
  fi
  atk_log "rolling back after commit: $WAVE_AFTER_COMMIT"
  for id in "\${committed[@]}"; do
    stmt="$(loss_statement "\${ATK_ITEM_PATH[$id]}")"
    printf 'DATA LOSS (%s, %s): %s\\n' "\${ATK_NAME[$id]}" "\${ATK_ITEM_PATH[$id]}" "$stmt" >&2
    atk_event "$id" manual succeeded "" "rollback after commit: $stmt" afterCommit=true reason="$WAVE_AFTER_COMMIT" dataLoss="$stmt"
  done
  atk_event - rollback started "" "rollback after commit: $WAVE_AFTER_COMMIT" afterCommit=true reason="$WAVE_AFTER_COMMIT"
else
  atk_event - rollback started "" "rollback before commit\${WAVE_AFTER_COMMIT:+: $WAVE_AFTER_COMMIT}" afterCommit=false
fi
${noReverse.length ? `for id in "\${WAVE_ITEMS[@]}"; do
  case "\${ATK_ITEM_PATH[$id]}" in ${casePattern(noReverse)}) if [[ "\${ATK_KIND[$id]}" == database ]]; then atk_log "exec.db.no-reverse: \${ATK_NAME[$id]}: $(loss_statement "\${ATK_ITEM_PATH[$id]}")"; fi ;; esac
done` : ''}

wave_step 1 dns-switch "load balancer and DNS back to the source" step_network
wave_step 2 rollback "stop the targets (kept for analysis)" step_servers
wave_step 3 rollback "databases back through the reverse replication" step_databases
wave_step 4 manual "start the sources" step_sources
wave_step 5 freeze "unfreeze the sources" step_unfreeze
wave_step 6 validate "validate the sources" step_validate

bad=\${#WAVE_FAILED[@]}
if (( WAVE_REHEARSE )); then
  if (( bad == 0 )); then
    ATK_EVENT_PATH="\${ATK_ITEM_PATH[$rid]}" atk_event "$rid" rollback succeeded "" "rollback rehearsal passed on \${ATK_ITEM_PATH[$rid]}" rehearsal=true
  else
    ATK_EVENT_PATH="\${ATK_ITEM_PATH[$rid]}" atk_event "$rid" rollback failed "" "rollback rehearsal failed at \${WAVE_FAILED[$rid]:-a step}" rehearsal=true
  fi
fi
if (( bad > 0 )); then
  atk_event - rollback failed "" "step 7: $bad item(s) did not roll back cleanly" stepNo=7 failed="$bad" reason="\${WAVE_AFTER_COMMIT:-before commit}"
  exit ${EXIT_CODES.partial}
fi
atk_event - rollback succeeded "" "step 7: \${#WAVE_ITEMS[@]} item(s) back on the source" stepNo=7 reason="\${WAVE_AFTER_COMMIT:-before commit}"
atk_log "rolled back; the targets are stopped and kept for analysis. Re-plan the items into a later wave."
`;
  return waveScript({
    file, wave: w.n, channel: 'orchestrator',
    summary: `Wave ${w.n} rollback (A.7.4): the cutover in reverse; the targets are stopped and kept.`,
    about: [
      'Before commit it is automatic. After commit it needs --after-commit "<reason>" and prints the data-loss statement first.',
      '--rehearse --item <nonprod item>: cut over that item, roll it back and record the rehearsal (G1, paths without a test).',
    ],
    options: [
      { flag: '--after-commit', variable: 'WAVE_AFTER_COMMIT', value: true, help: 'roll back committed items; the reason is recorded' },
      { flag: '--rehearse', variable: 'WAVE_REHEARSE', help: 'a rollback rehearsal on one nonprod item (cutover, then rollback)' },
      { flag: '--continue-on-item-failure', variable: 'WAVE_CONTINUE', help: 'carry on with the other items when one fails' },
    ],
    functions,
    body,
  });
}
