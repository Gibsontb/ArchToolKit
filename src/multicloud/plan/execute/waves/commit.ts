/**
 * `waves/wave-<n>/commit.sh` (addendum A.7.3 G3): the point of no return.
 * It needs G3 (`status/gates/wave-<n>-commit.json`: validation passed, no
 * Sev1 / Sev2, the app owners' acceptance), else exit 4. Per item it runs
 * the path's `commit` verb: MGN `finalize-cutover`, M2VM `finalizeMigration`,
 * the DB forward replication torn down with the reverse replication kept.
 * An item already committed (a real `commit` event) is skipped.
 */

import { EXIT_CODES } from '../contract.ts';
import { DATA_LOSS, DATA_LOSS_DEFAULT, type WaveSpec, waveDataSh, waveFile, waveScript, shq } from './common.ts';

export function renderCommit(w: WaveSpec): string {
  const file = waveFile(w.n, 'commit.sh');
  const paths = [...new Set(w.items.map((i) => i.item.path))].sort();
  const statements = paths.map((p) => `    ${p}) printf '%s' ${shq(DATA_LOSS[p] ?? DATA_LOSS_DEFAULT)} ;;`).join('\n');
  const functions = `${waveDataSh(w)}
loss_statement() {
  case "$1" in
${statements}
    *) printf '%s' ${shq(DATA_LOSS_DEFAULT)} ;;
  esac
}
commit_item() {
  local id="$1"
  if wave_committed "$id"; then
    ATK_EVENT_PATH="\${ATK_ITEM_PATH[$id]}" atk_event "$id" commit skipped "" "already committed"
    return 0
  fi
  wave_path commit "$id"
}
step_commit() { wave_each commit_item; }
`;
  const body = `
atk_need jq
if (( \${#WAVE_ITEMS[@]} == 0 )); then atk_event - commit skipped "" "no items in wave $WAVE_N"; exit 0; fi
atk_gate G3
atk_log "commit is the point of no return: after it, a rollback loses what the path cannot carry back:"
declare -A seen=()
for id in "\${WAVE_ITEMS[@]}"; do
  p="\${ATK_ITEM_PATH[$id]}"
  if [[ -z "\${seen[$p]:-}" ]]; then seen[$p]=1; atk_log "  $p: $(loss_statement "$p")"; fi
done
wave_step 1 commit "commit (point of no return)" step_commit
if (( \${#WAVE_FAILED[@]} )); then exit ${EXIT_CODES.partial}; fi
atk_log "next: after the keep-days and a first target backup, waves/wave-$WAVE_N/decommission.sh (needs G4)"
`;
  return waveScript({
    file, wave: w.n, channel: 'orchestrator',
    summary: `Wave ${w.n} commit (A.7.3 G3): the point of no return, per path; the reverse replication is kept.`,
    about: ['Needs G3 (exit 4 when it is not open; --gate-override "<reason>" records the reason).'],
    functions,
    body,
  });
}
