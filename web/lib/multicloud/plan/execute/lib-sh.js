/**
 * `lib/atk.sh`: the shared bash library every generated bash script sources
 * (addendum A.6.2), and `shScript`, the skeleton path generators build their
 * scripts on so the contract holds by construction.
 *
 * API (bash):
 *   atk_init PATHS "$@"       parse VERB and the common options (PATHS: comma list of move paths)
 *   atk_init_tool CHANNEL "$@" parse the common options for a script without verbs
 *   atk_main                  run verb_<verb> for every selected item, with events and exit codes
 *   atk_items                 select the items (ATK_ITEMS) by path, --wave and --item
 *   atk_run CMD...            run a mutating command; with --dry-run print it instead
 *   atk_retry N DELAY CMD...  atk_run, retried with a growing delay
 *   atk_wait_until MIN SEC CMD...  poll a read-only check (--once: once; --timeout: MIN)
 *   atk_secret NAME / atk_secret_to VAR NAME   a credential: $NAME, $NAME_FILE (mode 600) or $ATK_VAULT_CMD
 *   atk_event ITEM STEP OUTCOME [STATE] [DETAIL] [k=v...]   one StatusEvent line, under a lock
 *   atk_done / atk_skip / atk_fail   a verb's own terminal event (idempotence: skip when already there)
 *   atk_lock NAME             a lock held until the script exits (exit 1 when another run holds it)
 *   atk_gate G1..G5           the wave's gate file must say go, else exit 4 (--gate-override records a reason)
 *   atk_need CMD...           exit 3 naming the missing tools
 *   atk_name ID               the item's deterministic name, atk-<plan8>-<wave>-<slug>
 *   atk_item_json ID [FILTER] the item's manifest entry (jq)
 *   atk_ids_get / atk_ids_put PATH KEY [VALUE]   the re-derivable id cache in status/ids/<path>.json (jq)
 *   atk_tmpfile VAR           a mode-600 file in the runtime directory, removed on exit
 *   atk_pwsh SCRIPT ARGS...   run a PowerShell path script with the same run and options
 *   atk_log / atk_die CODE MSG   redacted log lines (stderr and status/logs/<run>.log)
 *
 * The library needs bash 4.4 or later and the usual POSIX tools (awk, od,
 * mktemp, date); jq only for atk_item_json and atk_ids_*. It reads the
 * manifest from `manifest/items.tsv` so its core runs without jq.
 */

import { ITEM_STATE_VALUES, OUTCOME_VALUES, STEP_ID_VALUES } from '../options.js';
import {
  ARGUMENTS, EXIT_CODES, EXIT_MEANINGS, GATE_ALIAS, VERB_STEP, VERBS,                                         
} from './contract.js';

/**
 * A template tag for embedded shell and PowerShell: raw text, where `$\{`
 * stands for a literal `${` (so bash expansions and TS interpolation can
 * sit side by side) and `\`` for a backtick.
 */
export function code(strings                      , ...values                    )         {
  return String.raw({ raw: strings.raw }, ...values).replace(/\$\\\{/g, '${').replace(/\\`/g, '`');
}

/** The usage text every script prints on a usage error. */
export function usageText(forPs = false)         {
  const args = ARGUMENTS.map((a) => `  ${(forPs ? a.ps : a.flag) + (a.value ? (a.value === 'number' ? ' N' : ' TEXT') : '')}`.padEnd(26) + a.help);
  const exits = (Object.keys(EXIT_CODES)              ).map((k) => `  ${String(EXIT_CODES[k]).padStart(2)}  ${EXIT_MEANINGS[k]}`);
  return [
    `Usage: SCRIPT VERB [options]`,
    `Verbs: ${VERBS.join(' ')}`,
    'Options:',
    ...args,
    'Changes are made by default; --dry-run prints each change instead.',
    'Exit codes:',
    ...exits,
  ].join('\n');
}

const verbStepPairs = VERBS.map((v) => `[${v}]=${VERB_STEP[v]}`).join(' ');

/** The text of `lib/atk.sh`. */
export function renderLibSh()         {
  const gateCases = (Object.keys(GATE_ALIAS)                               ).map((g) => `    ${g}) alias=${GATE_ALIAS[g]} ;;`).join('\n');
  return code`#!/usr/bin/env bash
# lib/atk.sh: the execution kit's shared library. Every bash script in the kit sources it.
#
# The contract it enforces:
#   - changes are made by default; --dry-run prints each change instead of making it
#     (read-only calls still run, events carry "dryRun": true); there is no --yes and no prompt;
#   - verbs are idempotent: they read the current state first and write "skipped" when an item is there;
#   - credentials come from $NAME, $NAME_FILE (mode 600) or $ATK_VAULT_CMD, never from kit files;
#   - status events (kind archtoolkit.migration-status) are appended to status/events.jsonl under a lock;
#   - one set of verbs, options and exit codes; a lock per wave; a redacted log per run.
# Needs bash 4.4 or later, awk, od, mktemp and date; jq for atk_item_json and atk_ids_*.

if [[ -n "$\{ATK_LIB_LOADED:-}" ]]; then return 0; fi
ATK_LIB_LOADED=1
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  echo "atk: bash 4.4 or later is needed (on macOS install a current bash)" >&2
  exit ${EXIT_CODES.missing}
fi

ATK_VERBS=(${VERBS.join(' ')})
declare -A ATK_VERB_STEP=(${verbStepPairs})
ATK_STEP_LIST=" ${STEP_ID_VALUES.join(' ')} "
ATK_STATE_LIST=" ${ITEM_STATE_VALUES.join(' ')} "
ATK_OUTCOME_LIST=" ${OUTCOME_VALUES.join(' ')} "

ATK_HOME="$(cd "$(dirname "$\{BASH_SOURCE[0]}")/.." && pwd)"
ATK_ROOT="$\{ATK_ROOT:-$(cd "$ATK_HOME/../.." && pwd)}"
ATK_STATUS="$\{ATK_STATUS_DIR:-$ATK_ROOT/status}"
ATK_MANIFEST="$\{ATK_MANIFEST:-$ATK_HOME/manifest/items.tsv}"

ATK_PLAN_ID=""
ATK_PLAN8=""
ATK_PATHS=()
ATK_VERB=""
ATK_WAVE=""
ATK_ITEM_FILTER=()
ATK_DRY_RUN=0
ATK_GATE_OVERRIDE=""
ATK_ONCE=0
ATK_TIMEOUT=0
ATK_ITEMS=()
ATK_ALL_IDS=()
ATK_TMPFILES=()
ATK_LOCK_DIRS=()
ATK_REDACT_OWNER=""
ATK_EVENT_PATH=""
ATK_LOG=""
ATK_F=()
declare -A ATK_NAME=() ATK_KIND=() ATK_APP=() ATK_ITEM_WAVE=() ATK_ITEM_PATH=() ATK_SCRIPT=() ATK_RESOURCE=() ATK_SOURCE=() ATK_TARGET=()

# ---------------------------------------------------------------- logging

atk_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

_atk_redact_stream() {
  if [[ -n "$\{ATK_REDACT_FILE:-}" && -s "$\{ATK_REDACT_FILE:-}" ]]; then
    ATK_REDACT_FILE="$ATK_REDACT_FILE" awk '
      BEGIN { f = ENVIRON["ATK_REDACT_FILE"]; while ((getline s < f) > 0) if (length(s) > 0) sec[++n] = s; close(f) }
      { line = $0
        for (i = 1; i <= n; i++) { out = ""; while ((p = index(line, sec[i])) > 0) { out = out substr(line, 1, p - 1) "***"; line = substr(line, p + length(sec[i])) } line = out line }
        print line; fflush() }'
  else
    cat
  fi
}
_atk_redact_text() { printf '%s\n' "$1" | _atk_redact_stream; }

atk_log() {
  local msg
  msg="$(_atk_redact_text "$*")"
  printf 'atk: %s\n' "$msg" >&2
  if [[ -n "$ATK_LOG" ]]; then printf '%s %s\n' "$(atk_now)" "$msg" >> "$ATK_LOG"; fi
  return 0
}
atk_die() {
  local code="$1"
  shift
  atk_log "error: $*"
  exit "$code"
}
_atk_usage_text() {
  cat <<'ATK_USAGE'
${usageText()}
ATK_USAGE
}
atk_usage() {
  atk_log "usage: $*"
  _atk_usage_text >&2
  exit ${EXIT_CODES.usage}
}

# ---------------------------------------------------------------- runtime files and secrets

_atk_runtime_dir() {
  local d
  for d in "$\{XDG_RUNTIME_DIR:-}" /dev/shm "$\{TMPDIR:-}" /tmp; do
    if [[ -n "$d" && -d "$d" && -w "$d" ]]; then printf '%s' "$d"; return 0; fi
  done
  return 1
}
_atk_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# atk_tmpfile VAR: a mode-600 file in the runtime directory (never the kit), removed when the script exits.
atk_tmpfile() {
  local _atk_dir _atk_file
  _atk_dir="$(_atk_runtime_dir)" || atk_die 1 "no writable runtime directory"
  _atk_file="$(umask 077 && mktemp "$_atk_dir/atk.XXXXXXXX")" || atk_die 1 "mktemp failed"
  chmod 600 "$_atk_file"
  ATK_TMPFILES+=("$_atk_file")
  printf -v "$1" '%s' "$_atk_file"
}

_atk_redact_add() {
  local value="$1" line
  [[ -n "$\{ATK_REDACT_FILE:-}" && -f "$\{ATK_REDACT_FILE:-}" ]] || return 0
  local -a lines=()
  mapfile -t lines <<< "$value"
  for line in "$\{lines[@]}"; do
    if (( $\{#line} >= 4 )); then printf '%s\n' "$line" >> "$ATK_REDACT_FILE"; fi
  done
  return 0
}

_atk_secret_value() {
  local name="$1" file_var="$1_FILE" file mode cmd
  if [[ ! "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then atk_die ${EXIT_CODES.usage} "not a variable name: $name"; fi
  if [[ -n "$\{!name:-}" ]]; then
    ATK_SECRET_VALUE="$\{!name}"
  elif [[ -n "$\{!file_var:-}" ]]; then
    file="$\{!file_var}"
    [[ -f "$file" && -r "$file" ]] || atk_die ${EXIT_CODES.missing} "$file_var names a file that cannot be opened"
    mode="$(_atk_mode "$file")"
    [[ "$mode" =~ 00$ ]] || atk_die ${EXIT_CODES.missing} "$file_var must be readable by its owner only (mode 600); it is $mode"
    ATK_SECRET_VALUE="$(< "$file")"
  elif [[ -n "$\{ATK_VAULT_CMD:-}" ]]; then
    if [[ "$ATK_VAULT_CMD" == *%s* ]]; then cmd="$\{ATK_VAULT_CMD//%s/"$name"}"; else cmd="$ATK_VAULT_CMD $name"; fi
    ATK_SECRET_VALUE="$(bash -c "$cmd")" || atk_die ${EXIT_CODES.missing} "ATK_VAULT_CMD failed for $name"
  else
    ATK_SECRET_VALUE=""
  fi
  [[ -n "$ATK_SECRET_VALUE" ]] || atk_die ${EXIT_CODES.missing} "credential $name is not set: export $name, or $file_var (mode 600), or ATK_VAULT_CMD"
  _atk_redact_add "$ATK_SECRET_VALUE"
}
# atk_secret NAME: print the credential (use in an assignment: v="$(atk_secret NAME)").
atk_secret() {
  local ATK_SECRET_VALUE=""
  _atk_secret_value "$1"
  printf '%s' "$ATK_SECRET_VALUE"
}
# atk_secret_to VAR NAME: set VAR to the credential without a subshell.
atk_secret_to() {
  local ATK_SECRET_VALUE=""
  _atk_secret_value "$2"
  printf -v "$1" '%s' "$ATK_SECRET_VALUE"
}

_atk_on_exit() {
  local rc=$? f
  for f in "$\{ATK_TMPFILES[@]}"; do rm -f "$f"; done
  for f in "$\{ATK_LOCK_DIRS[@]}"; do rmdir "$f" 2>/dev/null || true; done
  if [[ "$ATK_REDACT_OWNER" == "$BASHPID" && -n "$\{ATK_REDACT_FILE:-}" ]]; then rm -f "$ATK_REDACT_FILE"; fi
  return "$rc"
}

# ---------------------------------------------------------------- arguments and the manifest

_atk_random_id() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }

_atk_parse() {
  local want_verb="$1"
  shift
  while (( $# )); do
    case "$1" in
      --wave)
        [[ "$\{2:-}" =~ ^[0-9]+$ ]] || atk_usage "--wave needs a number"
        ATK_WAVE="$2"; shift 2 ;;
      --item)
        [[ -n "$\{2:-}" ]] || atk_usage "--item needs an id or a name"
        ATK_ITEM_FILTER+=("$2"); shift 2 ;;
      --dry-run) ATK_DRY_RUN=1; shift ;;
      --gate-override)
        [[ -n "$\{2:-}" ]] || atk_usage "--gate-override needs a reason"
        ATK_GATE_OVERRIDE="$2"; shift 2 ;;
      --once) ATK_ONCE=1; shift ;;
      --timeout)
        [[ "$\{2:-}" =~ ^[0-9]+$ ]] || atk_usage "--timeout needs minutes"
        ATK_TIMEOUT="$2"; shift 2 ;;
      -h|--help) _atk_usage_text; exit 0 ;;
      -*) atk_usage "unknown option: $1" ;;
      *)
        if [[ "$want_verb" == 1 && -z "$ATK_VERB" ]]; then ATK_VERB="$1"; shift; else atk_usage "unexpected argument: $1"; fi ;;
    esac
  done
  if [[ "$want_verb" == 1 ]]; then
    [[ -n "$ATK_VERB" ]] || atk_usage "a verb is needed"
    [[ -n "$\{ATK_VERB_STEP[$ATK_VERB]:-}" ]] || atk_usage "unknown verb: $ATK_VERB"
  fi
  return 0
}

_atk_fields() {
  local rest="$1"
  ATK_F=()
  while [[ "$rest" == *$'\t'* ]]; do
    ATK_F+=("$\{rest%%$'\t'*}")
    rest="$\{rest#*$'\t'}"
  done
  ATK_F+=("$rest")
}

_atk_manifest_load() {
  [[ -f "$ATK_MANIFEST" ]] || atk_die 1 "the manifest (manifest/items.tsv) is missing: regenerate the kit"
  local -a lines=()
  local line id
  mapfile -t lines < "$ATK_MANIFEST"
  for line in "$\{lines[@]}"; do
    line="$\{line%$'\r'}"
    [[ -n "$line" ]] || continue
    _atk_fields "$line"
    if [[ "$\{ATK_F[0]}" == "#plan" ]]; then ATK_PLAN_ID="$\{ATK_F[1]:-}"; ATK_PLAN8="$\{ATK_F[2]:-}"; continue; fi
    [[ "$\{ATK_F[0]}" != \#* ]] || continue
    (( $\{#ATK_F[@]} >= 10 )) || atk_die 1 "the manifest has a short row: regenerate the kit"
    id="$\{ATK_F[0]}"
    ATK_ALL_IDS+=("$id")
    ATK_NAME[$id]="$\{ATK_F[1]}"; ATK_KIND[$id]="$\{ATK_F[2]}"; ATK_APP[$id]="$\{ATK_F[3]}"; ATK_ITEM_WAVE[$id]="$\{ATK_F[4]}"
    ATK_ITEM_PATH[$id]="$\{ATK_F[5]}"; ATK_SCRIPT[$id]="$\{ATK_F[6]}"; ATK_RESOURCE[$id]="$\{ATK_F[7]}"
    ATK_SOURCE[$id]="$\{ATK_F[8]}"; ATK_TARGET[$id]="$\{ATK_F[9]}"
  done
  [[ -n "$ATK_PLAN_ID" ]] || atk_die 1 "the manifest has no plan id: regenerate the kit"
}

_atk_setup() {
  export ATK_RUN_ID="$\{ATK_RUN_ID:-$(_atk_random_id)}"
  mkdir -p "$ATK_STATUS/logs" "$ATK_STATUS/ids" "$ATK_STATUS/gates"
  ATK_LOG="$ATK_STATUS/logs/$ATK_RUN_ID.log"
  if [[ -z "$\{ATK_REDACT_FILE:-}" || ! -f "$\{ATK_REDACT_FILE:-}" ]]; then
    local dir
    dir="$(_atk_runtime_dir)" || atk_die 1 "no writable runtime directory"
    ATK_REDACT_FILE="$(umask 077 && mktemp "$dir/atk-redact.XXXXXXXX")" || atk_die 1 "mktemp failed"
    export ATK_REDACT_FILE
    ATK_REDACT_OWNER="$BASHPID"
  fi
  trap _atk_on_exit EXIT
  _atk_manifest_load
}

# atk_init PATHS "$@": PATHS is the move path this script serves (a comma list when it serves several).
atk_init() {
  (( $# >= 1 )) || atk_die 1 "atk_init needs the path"
  local list="$\{1//,/ }"
  shift
  ATK_PATHS=()
  local p
  for p in $list; do ATK_PATHS+=("$p"); done
  _atk_parse 1 "$@"
  _atk_setup
}
# atk_init_tool CHANNEL "$@": for scripts without verbs (controller-check.sh, orchestrators).
atk_init_tool() {
  ATK_PATHS=("$1")
  ATK_EVENT_PATH="$1"
  shift
  _atk_parse 0 "$@"
  _atk_setup
}

# atk_items: ATK_ITEMS := the items of this script's paths, in --wave, matching --item (id or name).
atk_items() {
  ATK_ITEMS=()
  local id f p on matched lname
  local -A hit=()
  for id in "$\{ATK_ALL_IDS[@]}"; do
    on=0
    for p in "$\{ATK_PATHS[@]}"; do if [[ "$\{ATK_ITEM_PATH[$id]}" == "$p" ]]; then on=1; fi; done
    (( on )) || continue
    if [[ -n "$ATK_WAVE" && "$\{ATK_ITEM_WAVE[$id]}" != "$ATK_WAVE" ]]; then continue; fi
    if (( $\{#ATK_ITEM_FILTER[@]} )); then
      matched=0
      lname="$\{ATK_NAME[$id],,}"
      for f in "$\{ATK_ITEM_FILTER[@]}"; do
        if [[ "$f" == "$id" || "$\{f,,}" == "$lname" ]]; then matched=1; hit[$f]=1; fi
      done
      (( matched )) || continue
    fi
    ATK_ITEMS+=("$id")
  done
  for f in "$\{ATK_ITEM_FILTER[@]}"; do
    [[ -n "$\{hit[$f]:-}" ]] || atk_usage "no item \"$f\" on this path$\{ATK_WAVE:+ in wave $ATK_WAVE}"
  done
  return 0
}

atk_name() {
  [[ -n "$\{ATK_RESOURCE[$1]:-}" ]] || atk_die 1 "no item $1 in the manifest"
  printf '%s' "$\{ATK_RESOURCE[$1]}"
}

atk_need() {
  local c
  local -a missing=()
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  (( $\{#missing[@]} == 0 )) || atk_die ${EXIT_CODES.missing} "missing on the controller: $\{missing[*]} (run controller-check.sh)"
  return 0
}

atk_item_json() {
  atk_need jq
  jq -c --arg id "$1" '.items[] | select(.id == $id)' "$ATK_HOME/manifest/items.json" | jq -r "$\{2:-.}"
}

# ---------------------------------------------------------------- events

# Quoted replacements are literal in every bash from 4.4 (5.2 treats \ and & in unquoted ones specially).
_atk_json_to() {
  local _v="$2" _bs='\' _q='"' _nl=$'\n' _cr=$'\r' _tab=$'\t'
  _v="$\{_v//"$_bs"/"$_bs$_bs"}"
  _v="$\{_v//"$_q"/"$_bs$_q"}"
  _v="$\{_v//"$_nl"/"$\{_bs}n"}"
  _v="$\{_v//"$_cr"/"$\{_bs}r"}"
  _v="$\{_v//"$_tab"/"$\{_bs}t"}"
  _v="$\{_v//[[:cntrl:]]/}"
  printf -v "$1" '"%s"' "$_v"
}

_atk_lock_append() {
  local file="$1" line="$2" i
  if command -v flock >/dev/null 2>&1; then
    {
      flock -w 30 9 || atk_die 1 "could not lock $\{file##*/}"
      printf '%s\n' "$line" >> "$file"
    } 9>> "$file.lock"
  else
    for (( i = 0; i < 300; i++ )); do
      if mkdir "$file.lock.d" 2>/dev/null; then
        printf '%s\n' "$line" >> "$file"
        rmdir "$file.lock.d"
        return 0
      fi
      sleep 0.1
    done
    atk_die 1 "could not lock $\{file##*/} (remove $\{file##*/}.lock.d when no run is active)"
  fi
}

_atk_scrub() {
  local s="$1"
  s="$\{s//$'\n'/ }"
  s="$\{s//$'\r'/ }"
  if [[ -n "$\{ATK_ROOT:-}" ]]; then s="$\{s//"$ATK_ROOT"/.}"; fi
  if [[ -n "$\{HOME:-}" && $\{#HOME} -gt 1 ]]; then s="$\{s//"$HOME"/'~'}"; fi
  if [[ -n "$\{HOSTNAME:-}" && $\{#HOSTNAME} -gt 2 ]]; then s="$\{s//"$HOSTNAME"/host}"; fi
  if [[ -n "$\{USER:-}" && $\{#USER} -gt 2 ]]; then s="$\{s//"$USER"/user}"; fi
  s="$(_atk_redact_text "$s")"
  printf '%s' "$\{s:0:500}"
}

# atk_event ITEM STEP OUTCOME [STATE] [DETAIL] [key=value ...]   (ITEM "-" for a wave-level event)
atk_event() {
  (( $# >= 3 )) || atk_die 1 "atk_event needs ITEM STEP OUTCOME"
  local item="$1" step="$2" outcome="$3" state="$\{4:-}" detail="$\{5:-}"
  shift 3
  if (( $# )); then shift; fi
  if (( $# )); then shift; fi
  [[ "$ATK_STEP_LIST" == *" $step "* ]] || atk_die 1 "atk_event: unknown step $step"
  [[ "$ATK_OUTCOME_LIST" == *" $outcome "* ]] || atk_die 1 "atk_event: unknown outcome $outcome"
  [[ -z "$state" || "$ATK_STATE_LIST" == *" $state "* ]] || atk_die 1 "atk_event: unknown state $state"
  local path="$ATK_EVENT_PATH" wave="$ATK_WAVE" json q kv key val data="" sep=""
  if [[ -z "$path" ]]; then
    if [[ "$item" != "-" && -n "$\{ATK_ITEM_PATH[$item]:-}" ]]; then path="$\{ATK_ITEM_PATH[$item]}"; else path="$\{ATK_PATHS[0]:-orchestrator}"; fi
  fi
  if [[ -z "$wave" && "$item" != "-" ]]; then wave="$\{ATK_ITEM_WAVE[$item]:-}"; fi
  [[ "$wave" =~ ^[0-9]+$ ]] || wave=null
  json='{"kind":"archtoolkit.migration-status","v":1'
  _atk_json_to q "$ATK_PLAN_ID"; json+=",\"planId\":$q"
  _atk_json_to q "$ATK_RUN_ID"; json+=",\"runId\":$q"
  json+=",\"at\":\"$(atk_now)\",\"wave\":$wave"
  if [[ "$item" == "-" ]]; then
    json+=',"item":null'
  else
    _atk_json_to q "$item"; json+=",\"item\":$q"
    if [[ -n "$\{ATK_NAME[$item]:-}" ]]; then _atk_json_to q "$\{ATK_NAME[$item]}"; json+=",\"name\":$q"; fi
  fi
  _atk_json_to q "$path"; json+=",\"path\":$q,\"step\":\"$step\",\"outcome\":\"$outcome\""
  if (( ATK_DRY_RUN )); then json+=',"dryRun":true'; else json+=',"dryRun":false'; fi
  if [[ -n "$state" ]]; then json+=",\"state\":\"$state\""; fi
  if [[ -n "$detail" ]]; then _atk_json_to q "$(_atk_scrub "$detail")"; json+=",\"detail\":$q"; fi
  if [[ "$ATK_VERB" == status && "$step" == replicate ]]; then set -- "$@" poll=true; fi
  for kv in "$@"; do
    [[ "$kv" == *=* ]] || atk_die 1 "atk_event: data must be key=value: $kv"
    key="$\{kv%%=*}"
    val="$\{kv#*=}"
    [[ "$key" =~ ^[A-Za-z][A-Za-z0-9_.-]*$ ]] || atk_die 1 "atk_event: bad data key $key"
    val="$(_atk_scrub "$val")"
    if [[ "$val" =~ ^-?(0|[1-9][0-9]{0,14})(\.[0-9]+)?$ || "$val" == true || "$val" == false ]]; then
      data+="$sep\"$key\":$val"
    else
      _atk_json_to q "$val"; data+="$sep\"$key\":$q"
    fi
    sep=","
  done
  if [[ -n "$data" ]]; then json+=",\"data\":{$data}"; fi
  json+=',"source":"script"}'
  _atk_lock_append "$ATK_STATUS/events.jsonl" "$json"
  atk_log "$item $step $outcome$\{state:+ ($state)}$\{detail:+: $detail}"
  return 0
}

# Inside a verb: write the item's own terminal event and end the verb.
# atk_done ID [STATE] [DETAIL] [k=v...]   atk_skip ID DETAIL [STATE] [k=v...]   atk_fail ID DETAIL [k=v...]
atk_done() {
  local id="$1" state="$\{2:-}" detail="$\{3:-}"
  shift; if (( $# )); then shift; fi; if (( $# )); then shift; fi
  atk_event "$id" "$\{ATK_VERB_STEP[$ATK_VERB]}" succeeded "$state" "$detail" "$@"
  exit 76
}
atk_skip() {
  local id="$1" detail="$\{2:-already done}" state="$\{3:-}"
  shift; if (( $# )); then shift; fi; if (( $# )); then shift; fi
  atk_event "$id" "$\{ATK_VERB_STEP[$ATK_VERB]}" skipped "$state" "$detail" "$@"
  exit 75
}
atk_fail() {
  local id="$1" detail="$\{2:-failed}"
  shift; if (( $# )); then shift; fi
  atk_event "$id" "$\{ATK_VERB_STEP[$ATK_VERB]}" failed "" "$detail" "$@"
  exit 77
}

# ---------------------------------------------------------------- running things

# atk_run CMD [ARGS...]: every command that changes something goes through here.
atk_run() {
  (( $# )) || atk_die 1 "atk_run needs a command"
  local shown
  printf -v shown '%q ' "$@"
  shown="$(_atk_redact_text "$\{shown% }")"
  if (( ATK_DRY_RUN )); then
    # Drain piped input so the writer sees no broken pipe, but never wait on
    # a pipe that stays open (wsl.exe, CI runners).
    if [[ -p /dev/stdin ]] && command -v timeout > /dev/null; then timeout 2 cat > /dev/null 2>&1 || true; fi
    atk_log "dry-run, not run: $shown"
    return 0
  fi
  atk_log "run: $shown"
  "$@" 2> >(_atk_redact_stream | tee -a "$\{ATK_LOG:-/dev/null}" >&2)
}

# atk_retry ATTEMPTS DELAY_SECONDS CMD...: atk_run with retries (the delay grows each time).
atk_retry() {
  local n="$1" delay="$2" i rc=0
  shift 2
  for (( i = 1; i <= n; i++ )); do
    if atk_run "$@"; then return 0; else rc=$?; fi
    if (( i < n )); then atk_log "attempt $i of $n failed (exit $rc); trying again"; sleep $(( delay * i )); fi
  done
  return "$rc"
}

# atk_wait_until MINUTES INTERVAL_SECONDS CHECK...: poll a read-only check until it succeeds.
atk_wait_until() {
  local minutes="$1" every="$2" deadline
  shift 2
  if (( ATK_TIMEOUT > 0 )); then minutes="$ATK_TIMEOUT"; fi
  if "$@"; then return 0; fi
  if (( ATK_DRY_RUN )); then atk_log "dry-run, not waiting for: $*"; return 0; fi
  if (( ATK_ONCE )); then return 1; fi
  deadline=$(( SECONDS + minutes * 60 ))
  while (( SECONDS < deadline )); do
    sleep "$every"
    if "$@"; then return 0; fi
  done
  atk_log "gave up after $minutes minutes waiting for: $*"
  return 1
}

# atk_lock NAME: hold status/.lock-NAME until the script exits.
atk_lock() {
  local file="$ATK_STATUS/.lock-$1"
  if command -v flock >/dev/null 2>&1; then
    exec {ATK_LOCK_FD}>> "$file"
    flock -n "$ATK_LOCK_FD" || atk_die 1 "another run holds the lock $1"
  else
    mkdir "$file.d" 2>/dev/null || atk_die 1 "another run holds the lock $1 (remove status/.lock-$1.d when no run is active)"
    ATK_LOCK_DIRS+=("$file.d")
  fi
  return 0
}

_atk_json_field() {
  local re="\"$2\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""
  if [[ "$1" =~ $re ]]; then printf '%s' "$\{BASH_REMATCH[1]}"; fi
}

# atk_gate G1..G5: the wave's gate file must hold decision "go" for this plan, else exit ${EXIT_CODES.gate}.
atk_gate() {
  local gate="$1" alias f text
  [[ -n "$ATK_WAVE" ]] || atk_usage "gate $gate needs --wave"
  case "$gate" in
${gateCases}
    *) atk_die 1 "unknown gate $gate" ;;
  esac
  for f in "$ATK_STATUS/gates/wave-$ATK_WAVE-$gate.json" "$ATK_STATUS/gates/wave-$ATK_WAVE-$alias.json"; do
    [[ -f "$f" ]] || continue
    text="$(< "$f")"
    if [[ "$(_atk_json_field "$text" decision)" == go && "$(_atk_json_field "$text" planId)" == "$ATK_PLAN_ID" ]]; then
      ATK_EVENT_PATH=gate atk_event - gate succeeded "" "$gate is open" gate="$gate"
      return 0
    fi
  done
  if [[ -n "$ATK_GATE_OVERRIDE" ]]; then
    ATK_EVENT_PATH=gate atk_event - gate succeeded "" "$gate overridden: $ATK_GATE_OVERRIDE" gate="$gate" override=true
    return 0
  fi
  ATK_EVENT_PATH=gate atk_event - gate failed "" "$gate is not open" gate="$gate"
  atk_die ${EXIT_CODES.gate} "gate $gate is not open for wave $ATK_WAVE: record the decision in the tracker and export the gate file, or pass --gate-override \"<reason>\""
}

# atk_ids_get PATH KEY / atk_ids_put PATH KEY VALUE: status/ids/PATH.json, a cache that can always be re-derived.
atk_ids_get() {
  local file="$ATK_STATUS/ids/$1.json"
  [[ -f "$file" ]] || return 1
  atk_need jq
  jq -er --arg k "$2" '.[$k] // empty' "$file"
}
atk_ids_put() {
  local file="$ATK_STATUS/ids/$1.json" next
  atk_need jq
  if (( ATK_DRY_RUN )); then return 0; fi
  [[ -f "$file" ]] || printf '{}\n' > "$file"
  next="$file.$BASHPID"
  jq --arg k "$2" --arg v "$3" '.[$k] = $v' "$file" > "$next"
  mv -f "$next" "$file"
}

# atk_pwsh SCRIPT [VERB] [--options]: a PowerShell path script, with this run's id and the options translated.
atk_pwsh() {
  local script="$1" joined
  shift
  local -a args=() items=()
  while (( $# )); do
    case "$1" in
      --wave) args+=(-Wave "$\{2:?--wave needs a number}"); shift 2 ;;
      --item) items+=("$\{2:?--item needs a value}"); shift 2 ;;
      --dry-run) args+=(-DryRun); shift ;;
      --gate-override) args+=(-GateOverride "$\{2:?--gate-override needs a reason}"); shift 2 ;;
      --once) args+=(-Once); shift ;;
      --timeout) args+=(-Timeout "$\{2:?--timeout needs minutes}"); shift 2 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  if (( $\{#items[@]} )); then joined="$(IFS=,; printf '%s' "$\{items[*]}")"; args+=(-Item "$joined"); fi
  atk_need pwsh
  ATK_RUN_ID="$ATK_RUN_ID" pwsh -NoProfile -NonInteractive -File "$ATK_HOME/$script" "$\{args[@]}"
}

# ---------------------------------------------------------------- the verb dispatcher

# Called with errexit off and outside any && / || list, so that set -e takes effect inside the verb's subshell.
_atk_do_item() {
  local id="$1" fn="$2" step="$3" rc=0
  atk_event "$id" "$step" started
  (
    ATK_TMPFILES=()
    ATK_LOCK_DIRS=()
    trap _atk_on_exit EXIT
    set -e
    "$fn" "$id"
  )
  rc=$?
  case "$rc" in
    0) atk_event "$id" "$step" succeeded; return 0 ;;
    75|76) return 0 ;;
    77) return 1 ;;
    ${EXIT_CODES.usage}|${EXIT_CODES.missing}|${EXIT_CODES.gate}|${EXIT_CODES.precheck}) atk_event "$id" "$step" failed "" "stopped with exit $rc (see the run log)"; return "$rc" ;;
    *) atk_event "$id" "$step" failed "" "exit $rc (see the run log)"; return 1 ;;
  esac
}

# atk_main: run verb_<verb> once per selected item. Every item gets a started and a terminal event;
# the script exits 0 when all succeeded or were skipped, ${EXIT_CODES.partial} when some failed, and stops
# at once on a usage, missing-tool, gate or pre-check exit.
atk_main() {
  local fn="verb_$\{ATK_VERB//-/_}" step="$\{ATK_VERB_STEP[$ATK_VERB]}" id rc ok=0 failed=0
  declare -F "$fn" > /dev/null || atk_usage "this script has no $ATK_VERB verb"
  atk_items
  if (( $\{#ATK_ITEMS[@]} == 0 )); then
    atk_event - "$step" started
    atk_event - "$step" skipped "" "no items on this path in the selection"
    return 0
  fi
  for id in "$\{ATK_ITEMS[@]}"; do
    set +e
    _atk_do_item "$id" "$fn" "$step"
    rc=$?
    set -e
    case "$rc" in
      0) ok=$(( ok + 1 )) ;;
      1) failed=$(( failed + 1 )) ;;
      *) atk_log "stopping: exit $rc"; exit "$rc" ;;
    esac
  done
  atk_log "$ATK_VERB: $ok done, $failed failed"
  if (( failed > 0 )); then exit ${EXIT_CODES.partial}; fi
  return 0
}
`;
}

// ---------------------------------------------------------------------------
// The script skeleton path generators use
// ---------------------------------------------------------------------------

                               
                                                                                               
                        
                                                                                    
                                      
                                        
                           
                                                                          
                                     
                                                                 
                              
                                                                                                         
                                                 
 

/** `lib/<file>` relative to a kit file (both relative to `migration/execute/`). */
export function libPathFrom(file        , lib        )         {
  const depth = file.split('/').length - 1;
  return `${'../'.repeat(depth)}lib/${lib}`;
}

const indent = (text        , by = '  ')         =>
  text.split('\n').map((l) => (l.trim() ? by + l : '')).join('\n');

/** A contract-keeping bash path script: header, library, argument parsing, one function per verb, `atk_main`. */
export function shScript(spec              )         {
  const lib = libPathFrom(spec.file, 'atk.sh');
  const verbs = VERBS.map((v) => {
    const body = spec.verbs[v].trim() || ':';
    return `verb_${v.replace(/-/g, '_')}() {\n  local id="$1"\n${indent(body)}\n}`;
  }).join('\n\n');
  return code`#!/usr/bin/env bash
# ${spec.summary}
# Paths: ${spec.paths.join(', ')}. Verbs: ${VERBS.join(' ')}.
# Changes are made by default; --dry-run prints each change instead. See ../../README.md.
set -Eeuo pipefail
source "$(cd "$(dirname "$\{BASH_SOURCE[0]}")" && pwd)/${lib}"
atk_init ${spec.paths.join(',')} "$@"
${spec.needs?.length ? `atk_need ${spec.needs.join(' ')}\n` : ''}${spec.functions ? `\n${spec.functions.trim()}\n` : ''}
${verbs}

atk_main
`;
}
