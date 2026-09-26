/**
 * WP-17: the pattern move paths (addendum A.4.2, A.4.7), each a generator of
 * the execution kit (A.6.2) keeping the script contract:
 *
 *   sap        sap-hsr, sap-backup-restore   paths/sap/sap.sh (+ ansible/host-step.yml, host-copy.yml)
 *   m365       saas-exchange                 paths/m365/exchange.ps1 (Exchange Online PowerShell, PowerShell 7)
 *              saas-sharepoint               paths/m365/sharepoint.sh (+ ansible/spmt.yml: SPMT runs only in
 *                                            Windows PowerShell 5.1, so the play runs it on a Windows host)
 *   velero     k8s-velero                    paths/velero/velero.sh (Velero, kubectl, crane)
 *   appliance  appliance-rebuild             paths/appliance/appliance.sh (the configuration moves, not the VM)
 *
 * Commands that must run on a SAP HANA (or database) host go through the
 * project's Ansible inventory: reads as ad-hoc `ansible` calls (they run in a
 * dry run too), changes through `ansible/host-step.yml` inside `atk_run`.
 * Per-item values are rendered into each script as settings that the
 * environment can override (`ATK_SET_<TOKEN>_<KEY>`, or `ATK_SET_<KEY>` for
 * every item); a value the plan cannot know stays empty, and the verb that
 * needs it stops with exit 5 naming the variable. Credentials come only from
 * `atk_secret` / `Get-AtkSecret` and reach the tools on stdin or in the
 * environment. Steps only a person can do (the Hybrid Configuration Wizard,
 * DMO, a vendor GUI) record `skipped` with the runbook step.
 *
 * The shared helpers (settings, hosts, the remote-step playbooks, the README)
 * are exported for `../db/beyond.ts`, the other WP-17 module.
 *
 * Pure: no DOM, no file system.
 */

import { info, warning,              } from '../../../../core/findings.js';
                                               
import { planId8, resourceName, shortHash, VERBS,                          } from '../contract.js';
import { psScript } from '../lib-ps.js';
import { code, shScript } from '../lib-sh.js';
                                                   
                                                                           

// ---------------------------------------------------------------------------
// Shared: settings, hosts, remote steps, README (also used by db/beyond.ts)
// ---------------------------------------------------------------------------

export const WP17 = 'WP-17'         ;

/** `<name>` as an environment-variable token: upper case, `[A-Z0-9_]`, never starting with a digit. */
export function envToken(name        )         {
  const t = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'ITEM';
  return /^[0-9]/.test(t) ? `I_${t}` : t;
}

/** A token per item, unique among the items (a clash gets a short hash of the id). */
export function settingTokens(items                         )                      {
  const count = new Map                ();
  for (const i of items) count.set(envToken(i.name), (count.get(envToken(i.name)) ?? 0) + 1);
  return new Map(items.map((i) => {
    const t = envToken(i.name);
    return [i.id, (count.get(t) ?? 0) > 1 ? `${t}_${shortHash(i.id).slice(0, 6).toUpperCase()}` : t]         ;
  }));
}

/** A bash single-quoted literal. */
export const shq = (s        )         => `'${s.replace(/'/g, `'\\''`)}'`;
/** A PowerShell single-quoted literal. */
export const psq = (s        )         => `'${s.replace(/'/g, "''")}'`;

                              
                       
                         
                                                                        
                                       
 
                             
                              
                                                                              
                                                                
 

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const known = (v                    )              => v !== undefined && v !== '';

function checkKeys(rows                       )       {
  for (const r of rows) for (const k of Object.keys(r.values)) if (!KEY_RE.test(k)) throw new Error(`setting key ${k} is not [a-z][a-z0-9_]*`);
}

/** The settings as bash associative arrays: SET_TOK (item → token) and SET_CONF ("item|key" → value). */
export function renderSettingsSh(rows                       , tokens                             )         {
  checkKeys(rows);
  const tok = rows.map((r) => `  [${shq(r.item.id)}]=${shq(tokens.get(r.item.id) ?? 'ITEM')}`);
  const conf = rows.flatMap((r) => Object.entries(r.values).filter((e)                        => known(e[1]))
    .sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `  [${shq(`${r.item.id}|${k}`)}]=${shq(v)}`));
  return [
    '# Each item\'s settings. ATK_SET_<TOKEN>_<KEY> in the environment overrides one; ATK_SET_<KEY> fills an empty one for every item.',
    'declare -A SET_TOK=(', ...tok, ')',
    'declare -A SET_CONF=(', ...conf, ')',
  ].join('\n');
}

/** The settings as a PowerShell hashtable: `$Settings[<id>] = @{ tok = ...; <key> = ... }`. */
export function renderSettingsPs(rows                       , tokens                             )         {
  checkKeys(rows);
  const lines = rows.map((r) => {
    const kv = [['tok', tokens.get(r.item.id) ?? 'ITEM']         , ...Object.entries(r.values).filter((e)                        => known(e[1])).sort((a, b) => a[0].localeCompare(b[0]))];
    return `  ${psq(r.item.id)} = @{ ${kv.map(([k, v]) => `${k} = ${psq(v)}`).join('; ')} }`;
  });
  return ['# Each item\'s settings. ATK_SET_<TOKEN>_<KEY> in the environment overrides one; ATK_SET_<KEY> fills an empty one for every item.', '$Settings = @{', ...lines, '}'].join('\n');
}

/**
 * The bash helpers every WP-17 script shares: settings, credentials, IPv6
 * literals, and commands on inventory hosts through Ansible (reads ad hoc,
 * changes through `ansible/host-step.yml` inside `atk_run`).
 */
export const HOST_SH = code`
shopt -s inherit_errexit
ATK_INV="$\{ATK_INVENTORY:-$ATK_ROOT/ansible/inventory}"

# set_get ID KEY: the item's setting. ATK_SET_<TOKEN>_<KEY> (this item) wins, then the generated value, then ATK_SET_<KEY> (every item).
set_get() {
  local one="ATK_SET_$\{SET_TOK[$1]:-X}_$\{2^^}" all="ATK_SET_$\{2^^}"
  if [[ -n "$\{!one:-}" ]]; then
    printf '%s' "$\{!one}"
  elif [[ -n "$\{SET_CONF["$1|$2"]:-}" ]]; then
    printf '%s' "$\{SET_CONF["$1|$2"]}"
  else
    printf '%s' "$\{!all:-}"
  fi
}
# set_need ID KEY: the same; an empty value stops the item with exit 5 (a pre-check) naming the variable to set.
set_need() {
  local v
  v="$(set_get "$1" "$2")"
  [[ -n "$v" ]] || atk_die 5 "$\{ATK_NAME[$1]:-$1}: set ATK_SET_$\{SET_TOK[$1]:-X}_$\{2^^} (or ATK_SET_$\{2^^} for every item; see the README next to this script)"
  printf '%s' "$v"
}
# set_on ID KEY: true when the setting is 1, true, yes or on.
set_on() { case "$(set_get "$1" "$2")" in 1|true|yes|on|TRUE|YES|ON) return 0 ;; *) return 1 ;; esac; }
# url_host HOST: an IPv6 literal in brackets, for host:port and URLs.
url_host() { if [[ "$1" == *:* && "$1" != \[* ]]; then printf '[%s]' "$1"; else printf '%s' "$1"; fi; }
# secret_for VAR BASE ID: the credential BASE_<TOKEN> when it is set for this item (or BASE_<TOKEN>_FILE), else BASE.
secret_for() {
  local one="$2_$\{SET_TOK[$3]:-X}" file
  file="$\{one}_FILE"
  if [[ -n "$\{!one:-}" || -n "$\{!file:-}" ]]; then atk_secret_to "$1" "$one"; else atk_secret_to "$1" "$2"; fi
}
# _host_args COMMAND USER [STDIN_VAR]: the shell module's arguments as JSON. The command runs as USER in a login shell,
# base64-encoded so no quoting is lost; a secret reaches its stdin from the named controller variable, never argv.
_host_args() {
  local b64
  b64="$(printf '%s' "$1" | base64 | tr -d '\n')"
  jq -nc --arg u "$2" --arg b "$b64" --arg e "$\{3:-}" \
    '{cmd: ("su - " + $u + " -c \"$(printf %s " + $b + " | base64 -d)\"")} + (if $e == "" then {} else {stdin: ("{{ lookup(\u0027ansible.builtin.env\u0027, \u0027" + $e + "\u0027) }}")} end)'
}
# host_read HOST USER COMMAND [STDIN_VAR]: the command's stdout on an inventory host (read-only: runs in a dry run too).
host_read() {
  local out
  out="$(ANSIBLE_LOAD_CALLBACK_PLUGINS=1 ANSIBLE_STDOUT_CALLBACK=ansible.builtin.json \
    ansible "$1" -i "$ATK_INV" -b -m ansible.builtin.shell -a "$(_host_args "$3" "$2" "$\{4:-}")" 2> /dev/null)" || true
  jq -r --arg h "$1" '.plays[0].tasks[0].hosts[$h].stdout // empty' <<< "$out" 2> /dev/null || true
}
# host_step HOST USER COMMAND [STDIN_VAR]: run the command on the host as USER: a change, printed instead in a dry run.
host_step() {
  local b64
  b64="$(printf '%s' "$3" | base64 | tr -d '\n')"
  local -a extra=(-e "atk_hosts=$1" -e "atk_user=$2" -e "atk_cmd_b64=$b64")
  if [[ -n "$\{4:-}" ]]; then extra+=(-e "atk_stdin_env=$4"); fi
  atk_log "on $1 as $2: $3"
  atk_run ansible-playbook -i "$ATK_INV" "$ATK_HOME/ansible/host-step.yml" "$\{extra[@]}"
}
# host_copy FROM TO OWNER MODE PATH...: copy files from one inventory host to another through a mode-700 runtime
# directory on the controller (never the kit), removed straight after.
host_copy() {
  local from="$1" to="$2" owner="$3" mode="$4" stage rc=0 list
  shift 4
  list="$(printf '%s\n' "$@" | jq -R . | jq -sc .)"
  atk_tmpfile stage
  stage="$stage.d"
  atk_run mkdir -m 700 "$stage"
  atk_run ansible-playbook -i "$ATK_INV" "$ATK_HOME/ansible/host-copy.yml" -e "atk_copy_from=$from" -e "atk_copy_to=$to" \
    -e "atk_copy_owner=$owner" -e "atk_copy_mode=$mode" -e "atk_stage=$stage" -e "{\"atk_copy_paths\": $list}" || rc=$?
  rm -rf "$stage"
  return "$rc"
}
`;

export const HOST_STEP_FILE = 'ansible/host-step.yml';
export const HOST_COPY_FILE = 'ansible/host-copy.yml';

/** `ansible/host-step.yml`: one command on a host as a service user, with any secret on stdin. */
export const HOST_STEP_PLAYBOOK = `---
# One step of a migration path on a source or target host (the SAP HANA, Db2, SAP ASE, Informix and Cassandra
# paths run their changes here). The path scripts call it through atk_run, so a dry run prints it instead.
# The command arrives base64-encoded (atk_cmd_b64) and runs as the service's OS user in a login shell, so the
# product's environment is loaded. Anything secret arrives on the command's stdin from the controller
# environment variable named by atk_stdin_env (set by the script from atk_secret), never as an argument.
- name: Run one migration step on the host
  hosts: "{{ atk_hosts }}"
  gather_facts: false
  become: true
  tasks:
    - name: Check the call
      ansible.builtin.assert:
        that:
          - atk_cmd_b64 is defined
          - atk_user is defined
        fail_msg: Run this play through the path scripts (paths/*/*.sh), which set the host, the user and the command.

    - name: Run the step as the service user
      ansible.builtin.shell:
        cmd: "su - {{ atk_user | quote }} -c \\"$(printf %s {{ atk_cmd_b64 | quote }} | base64 -d)\\""
        stdin: "{{ lookup('ansible.builtin.env', atk_stdin_env) if (atk_stdin_env | default('')) | length > 0 else omit }}"
      no_log: "{{ (atk_stdin_env | default('')) | length > 0 }}"
      register: atk_step
      changed_when: true

    - name: Show the output
      ansible.builtin.debug:
        var: atk_step.stdout_lines
      when: (atk_stdin_env | default('')) | length == 0
`;

/** `ansible/host-copy.yml`: files from one host to others through the controller's runtime directory. */
export const HOST_COPY_PLAYBOOK = `---
# Copies files from one inventory host to others through a mode-700 runtime directory on the controller
# (atk_stage, made and removed by the calling script). Used for key material that must match on both
# ends (the SAP HANA system PKI SSFS files); no_log keeps the contents out of the output.
- name: Stage the files from the source host
  hosts: "{{ atk_copy_from }}"
  gather_facts: false
  become: true
  tasks:
    - name: Fetch each file to the controller
      ansible.builtin.fetch:
        src: "{{ item }}"
        dest: "{{ atk_stage }}/{{ item | basename }}"
        flat: true
      loop: "{{ atk_copy_paths }}"
      no_log: true

- name: Place the files on the target hosts
  hosts: "{{ atk_copy_to }}"
  gather_facts: false
  become: true
  tasks:
    - name: Copy each file, readable by its owner only
      ansible.builtin.copy:
        src: "{{ atk_stage }}/{{ item | basename }}"
        dest: "{{ item }}"
        owner: "{{ atk_copy_owner }}"
        mode: "{{ atk_copy_mode }}"
      loop: "{{ atk_copy_paths }}"
      no_log: true
`;

/** A body for every verb from one function. */
export function everyVerb(body                     )                       {
  return Object.fromEntries(VERBS.map((v) => [v, body(v)]))                        ;
}
/** `verb` as a bash function suffix (`test-cleanup` → `test_cleanup`). */
export const fnVerb = (v      )         => v.replace(/-/g, '_');

/** The workloads behind an item (itself, or a database's hosts). */
export function workloadsOf(ctx             , item              )             {
  if (item.kind === 'workload') {
    const w = ctx.plan.workloads.find((x) => x.id === item.id);
    return w ? [w] : [];
  }
  return (item.hosts ?? []).map((id) => ctx.plan.workloads.find((x) => x.id === id)).filter((w)                => !!w);
}
/** The source machine's name in the project inventory (`inventory/sources.yml`). */
export const sourceHost = (w          )         => `src-${w.name}`;
/** The target machine's name in the project inventory. */
export const targetHost = (w          )         => w.rename ?? w.name;
/** The first known address of a machine (IPv4 or IPv6). */
export const addressOf = (w                      )                     => w?.facts?.ipAddresses?.[0];
/** The pattern answers of the item's app (`AppPlan.answers`). */
export function answersOf(ctx             , appName        )                                   {
  const app = ctx.plan.apps.find((a) => a.name === appName);
  const ap = (ctx.plan.appPlans ?? []).find((p) => p.app === app?.id);
  return ap?.answers ?? {};
}
/** Values listed in a text answer (comma, semicolon or space separated). */
export const listAnswer = (text                    )           => (text ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

                             
                         
                          
                                    
                                    
                                         
                                       
                                               
                                          
                                           
                                       
                                           
 

const md = (s        )         => s.replace(/\|/g, '\\|');

/** The README next to a WP-17 script: what it does, the verbs, each item's settings, the credentials. */
export function familyReadme(r            )         {
  const specOf = new Map(r.specs.map((s) => [s.key, s]));
  const table = r.rows.flatMap((row) => {
    const tok = r.tokens.get(row.item.id) ?? 'ITEM';
    return r.specs.filter((s) => !s.paths || s.paths.includes(row.item.path)).map((s) => {
      const v = row.values[s.key];
      return `| ${md(row.item.name)} | ${row.item.path} | ${row.item.wave ?? '-'} | \`${s.key}\` | ${known(v) ? `\`${md(v)}\`` : '**set it**'} | \`ATK_SET_${tok}_${s.key.toUpperCase()}\` |`;
    });
  });
  const keys = r.specs.map((s) => `- \`${s.key}\`: ${specOf.get(s.key)?.about ?? ''}`);
  return [
    `# ${r.title}`,
    '',
    ...r.intro,
    '',
    `Run \`${r.script} <verb> [--wave N] [--item ID] [--dry-run]\` (changes are made by default; \`--dry-run\` prints each change instead). The wave scripts call it for you.`,
    '',
    '## Verbs',
    '',
    ...r.verbs.map((v) => `- ${v}`),
    '',
    '## Settings',
    '',
    'Each item\'s values are in the script. `ATK_SET_<TOKEN>_<KEY>` in the environment overrides one item\'s value; `ATK_SET_<KEY>` fills an empty value for every item. A verb that needs an empty value stops with exit 5 naming the variable.',
    '',
    ...keys,
    '',
    '| Item | Path | Wave | Setting | Value | Override |',
    '|---|---|---|---|---|---|',
    ...table,
    '',
    '## Credentials',
    '',
    'Read with `atk_secret` / `Get-AtkSecret`: the variable itself, `<NAME>_FILE` (a file readable by its owner only), or `ATK_VAULT_CMD`. `<NAME>_<TOKEN>` (the item token above) wins over `<NAME>` when it is set. They reach the tools on stdin or in the environment, never as arguments or files in this kit.',
    '',
    ...r.credentials.map((c) => `- ${c}`),
    ...(r.environment?.length ? ['', '## Environment', '', ...r.environment.map((e) => `- ${e}`)] : []),
    ...(r.runbook?.length ? ['', '## Runbook steps (not automated)', '', ...r.runbook.map((e) => `- ${e}`)] : []),
    ...(r.unconfirmed?.length ? ['', '## To verify before the first run', '', ...r.unconfirmed.map((e) => `- ${e}`)] : []),
    '',
  ].join('\n');
}

/** The commands every host-bound script checks at start. */
export const HOST_COMMANDS                    = ['ansible', 'ansible-playbook', 'jq', 'base64'];
export const HOST_NEEDS                      = Object.freeze([
  { kind: 'command', name: 'ansible', min: '2.15', why: 'reads on the source and target hosts (ad hoc)', install: 'pipx install ansible-core' },
  { kind: 'command', name: 'ansible-playbook', min: '2.15', why: 'changes on the source and target hosts (ansible/host-step.yml)', install: 'pipx install ansible-core' },
  { kind: 'command', name: 'base64', why: 'commands sent to the hosts intact' },
]);

// ---------------------------------------------------------------------------
// SAP HANA: HANA System Replication, backup and restore
// ---------------------------------------------------------------------------

const SAP_DIR = 'paths/sap';
const SAP_FILE = `${SAP_DIR}/sap.sh`;
const SAP_PATHS                      = ['sap-hsr', 'sap-backup-restore'];

const SAP_SH = code`
SAP_KEY=ATKMIG

# sap_ctx ID: the item's SID, instance number, <sid>adm user and inventory hosts (exit 5 naming a missing setting).
sap_ctx() {
  SID="$(set_need "$1" sid)"
  NR="$(set_need "$1" instance)"
  SRC="$(set_need "$1" source_host)"
  TGT="$(set_need "$1" target_host)"
  [[ "$SID" =~ ^[A-Z][A-Z0-9]{2}$ ]] || atk_die 5 "$\{ATK_NAME[$1]}: the SID must be three characters (A-Z, 0-9), not $SID"
  [[ "$NR" =~ ^[0-9]{2}$ ]] || atk_die 5 "$\{ATK_NAME[$1]}: the instance number must be two digits, not $NR"
  ADM="$\{SID,,}adm"
}
sap_host() { if [[ "$1" == src ]]; then printf '%s' "$SRC"; else printf '%s' "$TGT"; fi; }
sap_read() { host_read "$(sap_host "$1")" "$ADM" "$2"; }
sap_step() { host_step "$(sap_host "$1")" "$ADM" "$2" "$\{3:-}"; }
# sr_mode SIDE: the HANA System Replication mode (primary, sync, syncmem, async, none) from hdbnsutil -sr_state.
sr_mode() { sap_read "$1" 'hdbnsutil -sr_state' | awk -F': *' '/^[[:space:]]*mode:/ && !f { print $2; f = 1 }'; }
is_secondary() { [[ "$1" =~ ^(sync|syncmem|async)$ ]]; }
# hana_up SIDE: every HANA process runs (sapcontrol GetProcessList exits 3).
hana_up() { [[ "$(sap_read "$1" "sapcontrol -nr $NR -function GetProcessList > /dev/null 2>&1; echo \$?")" == 3 ]]; }
hana_stop() { sap_step "$1" "sapcontrol -nr $NR -function StopSystem HDB && sapcontrol -nr $NR -function WaitforStopped 1800 10"; }
hana_start() { sap_step "$1" "sapcontrol -nr $NR -function StartSystem HDB && sapcontrol -nr $NR -function WaitforStarted 3600 10"; }
hana_version() { sap_read "$1" 'HDB version' | awk -F': *' '/^[[:space:]]*version:/ && !f { print $2; f = 1 }'; }
# hsr_overall SIDE: the overall replication status on the primary side (ACTIVE, SYNCING, INITIALIZING, ERROR, ...).
hsr_overall() { sap_read "$1" 'HDBSettings.sh systemReplicationStatus.py' | awk -F': *' 'tolower($0) ~ /overall system replication status/ && !f { print toupper($2); f = 1 }'; }
hsr_active() { [[ "$(hsr_overall "$1")" == ACTIVE ]]; }
sap_sql() { sap_read "$1" "hdbsql -U $SAP_KEY -a -x -j \"$2\"" | tr -d '"[:space:]'; }
sap_sql_do() { sap_step "$1" "hdbsql -U $SAP_KEY -a -x -j \"$2\""; }
# sap_userstore SIDE ID: the ATKMIG hdbuserstore key (SYSTEM on SYSTEMDB) for <sid>adm; the password goes on stdin.
sap_userstore() {
  local pw
  if [[ "$(sap_read "$1" "hdbuserstore LIST $SAP_KEY")" == *"KEY $SAP_KEY"* ]]; then return 0; fi
  secret_for pw SAP_HANA_SYSTEM_PASSWORD "$2"
  ( export ATK_STDIN="$pw"; sap_step "$1" "hdbuserstore -i SET $SAP_KEY localhost:3$\{NR}13 SYSTEM" ATK_STDIN )
}
sap_userstore_drop() { if [[ "$(sap_read "$1" "hdbuserstore LIST $SAP_KEY")" == *"KEY $SAP_KEY"* ]]; then sap_step "$1" "hdbuserstore DELETE $SAP_KEY"; fi; }
# sap_versions_ok ID: the target runs the same HANA release as the source, or a newer one (exit 5 otherwise).
sap_versions_ok() {
  local vs vt
  vs="$(hana_version src)"
  vt="$(hana_version tgt)"
  [[ -n "$vs" && -n "$vt" ]] || atk_die 5 "$\{ATK_NAME[$1]}: cannot read the HANA version on $SRC and $TGT (check the inventory and $ADM)"
  [[ "$(printf '%s\n%s\n' "$vs" "$vt" | sort -V | awk 'NR == 1')" == "$vs" ]] || atk_die 5 "$\{ATK_NAME[$1]}: the target HANA ($vt) is older than the source ($vs)"
}
ssfs_files() { printf '/usr/sap/%s/SYS/global/security/rsecssfs/data/SSFS_%s.DAT\n/usr/sap/%s/SYS/global/security/rsecssfs/key/SSFS_%s.KEY\n' "$SID" "$SID" "$SID" "$SID"; }
ssfs_sum() { host_read "$(sap_host "$1")" root "md5sum $(ssfs_files | tr '\n' ' ') 2> /dev/null | awk '{ print \$1 }' | tr '\n' ' '"; }
no_test() { atk_skip "$1" "HANA System Replication opens no test copy (the secondary is not open): rehearse the takeover on a non-production system (rollback.sh --rehearse)"; }

# ---------------------------------------------------------------- sap-hsr

hsr_prepare() {
  local id="$1" backups sum_s sum_t
  local -a files=()
  sap_versions_ok "$id"
  sap_userstore src "$id"
  backups="$(sap_sql src "SELECT COUNT(*) FROM SYS_DATABASES.M_BACKUP_CATALOG WHERE ENTRY_TYPE_NAME = 'complete data backup' AND STATE_NAME = 'successful'")"
  sum_s="$(ssfs_sum src)"
  sum_t="$(ssfs_sum tgt)"
  if [[ -n "$sum_s" && "$sum_s" == "$sum_t" && "$backups" =~ ^[1-9] ]]; then
    atk_skip "$id" "a full data backup exists and the system PKI (SSFS) files match on $TGT" prepared
  fi
  if [[ ! "$backups" =~ ^[1-9] ]]; then sap_sql_do src "BACKUP DATA FOR FULL SYSTEM USING FILE ('atk_hsr_seed')"; fi
  if [[ -z "$sum_s" || "$sum_s" != "$sum_t" ]]; then
    mapfile -t files < <(ssfs_files)
    host_copy "$SRC" "$TGT" "$ADM" 0600 "$\{files[@]}"
  fi
  atk_done "$id" prepared "full data backup present and the SSFS files copied to $TGT (system replication needs both)"
}
hsr_replicate() {
  local id="$1" ms mt site_s site_t remote
  site_s="$(set_need "$id" source_site)"
  site_t="$(set_need "$id" target_site)"
  remote="$(set_need "$id" source_hana_host)"
  ms="$(sr_mode src)"
  mt="$(sr_mode tgt)"
  if [[ "$mt" == primary ]] && is_secondary "$ms"; then atk_skip "$id" "cut over: the target is primary and replicates back to the source" cut-over; fi
  if [[ "$ms" == primary ]] && is_secondary "$mt"; then
    if hsr_active src; then atk_skip "$id" "HANA System Replication is ACTIVE" in-sync inSync=true; fi
  else
    if [[ "$ms" != primary ]]; then sap_step src "hdbnsutil -sr_enable --name=$site_s"; fi
    if ! is_secondary "$mt"; then
      if hana_up tgt; then hana_stop tgt; fi
      sap_step tgt "hdbnsutil -sr_register --remoteHost=$remote --remoteInstance=$NR --replicationMode=async --operationMode=logreplay --name=$site_t"
      hana_start tgt
    fi
  fi
  if atk_wait_until 1440 60 hsr_active src; then atk_done "$id" in-sync "HANA System Replication is ACTIVE" inSync=true; fi
  atk_done "$id" replicating "the initial data shipping continues (status polls it)" inSync=false
}
hsr_status() {
  local id="$1" ms mt overall
  ms="$(sr_mode src)"
  mt="$(sr_mode tgt)"
  if [[ "$mt" == primary ]]; then atk_skip "$id" "cut over: the reverse replication (target to source) is $(hsr_overall tgt)"; fi
  overall="$(hsr_overall src)"
  case "$overall" in
    ACTIVE) atk_done "$id" in-sync "system replication ACTIVE" inSync=true ;;
    SYNCING|INITIALIZING) atk_done "$id" replicating "system replication $overall" inSync=false ;;
    "") atk_fail "$id" "no system replication status on $SRC (mode $\{ms:-unknown}; not configured, or HANA is down)" inSync=false ;;
    *) atk_fail "$id" "system replication $overall" inSync=false ;;
  esac
}
hsr_test() { no_test "$1"; }
hsr_test_cleanup() { no_test "$1"; }
hsr_cutover() {
  local id="$1" ms mt site_s target_hana
  site_s="$(set_need "$id" source_site)"
  target_hana="$(set_need "$id" target_hana_host)"
  ms="$(sr_mode src)"
  mt="$(sr_mode tgt)"
  if [[ "$mt" == primary ]]; then atk_skip "$id" "the target is already primary" cut-over; fi
  is_secondary "$mt" || atk_fail "$id" "the target is not a system replication secondary (mode $\{mt:-unknown}): run replicate first"
  hsr_active src || atk_fail "$id" "system replication is not ACTIVE: wait until status reports in-sync"
  if hana_up src; then hana_stop src; fi
  sap_step tgt 'hdbnsutil -sr_takeover'
  atk_wait_until 60 20 hana_up tgt || atk_fail "$id" "the target did not come up after the takeover"
  # The way back: the old primary becomes the new secondary (it resyncs by delta where the logs allow).
  sap_step src "hdbnsutil -sr_register --remoteHost=$target_hana --remoteInstance=$NR --replicationMode=async --operationMode=logreplay --name=$site_s"
  hana_start src
  atk_done "$id" cut-over "takeover done on $TGT; $SRC replicates from it (the way back until finalize); mode was $\{ms:-unknown}" reverse=true
}
hsr_commit() {
  local id="$1"
  [[ "$(sr_mode tgt)" == primary ]] || atk_fail "$id" "not cut over: the target is not primary"
  atk_done "$id" "" "committed: $SRC stays the replication secondary (the way back) until finalize"
}
hsr_rollback() {
  local id="$1" ms mt
  ms="$(sr_mode src)"
  mt="$(sr_mode tgt)"
  if [[ "$ms" == primary ]]; then
    if hana_up src; then atk_skip "$id" "the source is primary and running: nothing to roll back" "" replication=kept; fi
    hana_start src
    atk_done "$id" "" "the source is primary: started it" replication=kept
  fi
  if is_secondary "$ms" && [[ "$mt" == primary ]]; then
    if ! hsr_active tgt; then atk_log "the reverse replication is not ACTIVE: the latest target writes may be lost by this takeover"; fi
    if hana_up tgt; then hana_stop tgt; fi
    sap_step src 'hdbnsutil -sr_takeover'
    atk_wait_until 60 20 hana_up src || atk_fail "$id" "the source did not come up after the takeover"
    atk_done "$id" "" "took over back on $SRC; $TGT is stopped and kept (replicate registers it again)" replication=kept
  fi
  atk_fail "$id" "unexpected replication modes (source $\{ms:-unknown}, target $\{mt:-unknown}): roll back by hand (runbook)"
}
hsr_finalize() {
  local id="$1" ms mt
  ms="$(sr_mode src)"
  mt="$(sr_mode tgt)"
  if [[ "$mt" == none ]] && ! is_secondary "$ms"; then atk_skip "$id" "system replication is already removed"; fi
  [[ "$mt" == primary ]] || atk_fail "$id" "the target is not primary (mode $\{mt:-unknown}): finalize runs after the cutover"
  if is_secondary "$ms"; then
    if hana_up src; then hana_stop src; fi
    sap_step src 'hdbnsutil -sr_unregister'
  fi
  sap_step tgt 'hdbnsutil -sr_disable'
  sap_userstore_drop tgt
  sap_userstore_drop src
  atk_done "$id" "" "system replication removed; $SRC stays stopped for decommission"
}

# ---------------------------------------------------------------- sap-backup-restore

br_ctx() {
  TEN="$(set_need "$1" tenant)"
  DIR="$(set_need "$1" backup_dir)"
  PRE="$DIR/atk_$(atk_name "$1")"
}
br_exists() { [[ -n "$(sap_read "$1" "ls -1 $2_databackup_0_1 2> /dev/null")" ]]; }
tenant_active() { [[ "$(sap_sql "$1" "SELECT ACTIVE_STATUS FROM M_DATABASES WHERE DATABASE_NAME = '$TEN'")" == YES ]]; }
br_recover() {
  if tenant_active tgt; then sap_sql_do tgt "ALTER SYSTEM STOP DATABASE $TEN"; fi
  sap_sql_do tgt "RECOVER DATA FOR $TEN USING FILE ('$1') CLEAR LOG"
}
br_prepare() {
  local id="$1" n
  br_ctx "$id"
  sap_versions_ok "$id"
  sap_userstore src "$id"
  sap_userstore tgt "$id"
  n="$(sap_sql tgt "SELECT COUNT(*) FROM M_DATABASES WHERE DATABASE_NAME = '$TEN'")"
  [[ "$n" =~ ^[1-9] ]] || atk_fail "$id" "tenant $TEN does not exist on $TGT: create it with the target's HANA install before prepare"
  atk_done "$id" prepared "userstore keys on both ends; tenant $TEN present on $TGT; backups go to $DIR (visible on both hosts)"
}
br_replicate() {
  local id="$1"
  br_ctx "$id"
  if br_exists src "$\{PRE}_seed"; then atk_skip "$id" "the seed backup exists ($\{PRE}_seed)" in-sync inSync=true; fi
  sap_sql_do src "BACKUP DATA FOR $TEN USING FILE ('$\{PRE}_seed')"
  atk_done "$id" in-sync "seed backup taken; an offline path: the final backup and restore run at cutover" inSync=true
}
br_status() {
  local id="$1"
  br_ctx "$id"
  if [[ "$(atk_ids_get sap-backup-restore "$id.cutover" 2> /dev/null || true)" == done ]]; then atk_skip "$id" "cut over (an offline path: nothing replicates)"; fi
  if br_exists src "$\{PRE}_seed"; then atk_done "$id" in-sync "the seed backup is ready; the final copy runs at cutover" inSync=true; fi
  atk_done "$id" "" "no seed backup yet" inSync=false
}
br_test() {
  local id="$1"
  br_ctx "$id"
  if [[ "$(atk_ids_get sap-backup-restore "$id.test" 2> /dev/null || true)" == restored ]]; then atk_skip "$id" "the seed backup is restored on $TGT" testing; fi
  br_exists tgt "$\{PRE}_seed" || atk_fail "$id" "the seed backup is not visible on $TGT under $DIR (the backup directory must be shared)"
  br_recover "$\{PRE}_seed"
  atk_ids_put sap-backup-restore "$id.test" restored
  atk_done "$id" testing "seed restored into $TEN on $TGT: test the application against it"
}
br_test_cleanup() {
  local id="$1" passed=false
  br_ctx "$id"
  if tenant_active tgt; then passed=true; fi
  atk_done "$id" tested "the test copy stays on $TGT until the cutover restore replaces it" passed="$passed"
}
br_cutover() {
  local id="$1"
  br_ctx "$id"
  if [[ "$(atk_ids_get sap-backup-restore "$id.cutover" 2> /dev/null || true)" == done ]] && tenant_active tgt; then atk_skip "$id" "restored at cutover and running on $TGT" cut-over; fi
  if ! br_exists src "$\{PRE}_final"; then sap_sql_do src "BACKUP DATA FOR $TEN USING FILE ('$\{PRE}_final')"; fi
  if tenant_active src; then sap_sql_do src "ALTER SYSTEM STOP DATABASE $TEN"; fi
  br_recover "$\{PRE}_final"
  atk_wait_until 30 20 tenant_active tgt || atk_fail "$id" "tenant $TEN did not start on $TGT after the recovery"
  atk_ids_put sap-backup-restore "$id.cutover" done
  atk_done "$id" cut-over "final backup restored into $TEN on $TGT; the source tenant is stopped (rollback starts it)"
}
br_commit() { atk_done "$1" "" "committed: the source tenant stays stopped until decommission"; }
br_rollback() {
  local id="$1" changed=0
  br_ctx "$id"
  if tenant_active tgt; then sap_sql_do tgt "ALTER SYSTEM STOP DATABASE $TEN"; changed=1; fi
  if ! tenant_active src; then sap_sql_do src "ALTER SYSTEM START DATABASE $TEN"; changed=1; fi
  if [[ -n "$(sap_read src "ls -1 $\{PRE}_final_* 2> /dev/null")" ]]; then sap_step src "rm -f $\{PRE}_final_*"; changed=1; fi
  if (( ! changed )); then atk_skip "$id" "the source tenant runs and the target tenant is stopped" "" replication=lost; fi
  atk_ids_put sap-backup-restore "$id.cutover" rolled-back
  atk_done "$id" "" "source tenant started; target tenant stopped and kept; writes on the target since the cutover are not copied back" replication=lost
}
br_finalize() {
  local id="$1"
  br_ctx "$id"
  if [[ -z "$(sap_read src "ls -1 $\{PRE}_* 2> /dev/null")" ]] && [[ "$(sap_read tgt "hdbuserstore LIST $SAP_KEY")" != *"KEY $SAP_KEY"* ]]; then
    atk_skip "$id" "the backups and the userstore keys are already removed"
  fi
  sap_step src "rm -f $\{PRE}_*"
  sap_userstore_drop tgt
  sap_userstore_drop src
  atk_done "$id" "" "removed the migration backups under $DIR and the userstore keys"
}
`;

const SAP_SPECS                         = [
  { key: 'sid', about: 'the SAP system id (three characters): from the app\'s SIDs answer when it names one' },
  { key: 'instance', about: 'the HANA instance number (two digits)' },
  { key: 'source_host', about: 'the source HANA host in the Ansible inventory (inventory/sources.yml)' },
  { key: 'target_host', about: 'the target HANA host in the Ansible inventory' },
  { key: 'source_hana_host', about: 'the source host name HANA knows (sr_register --remoteHost); map it in global.ini [system_replication_hostname_resolution] when the sites resolve names differently, IPv6 included', paths: ['sap-hsr'] },
  { key: 'target_hana_host', about: 'the target host name HANA knows (the way back after the takeover)', paths: ['sap-hsr'] },
  { key: 'source_site', about: 'the HSR site name of the source', paths: ['sap-hsr'] },
  { key: 'target_site', about: 'the HSR site name of the target', paths: ['sap-hsr'] },
  { key: 'tenant', about: 'the tenant database to move (default: the SID)', paths: ['sap-backup-restore'] },
  { key: 'backup_dir', about: 'a directory both hosts see (NFS, or a file share) for the migration backups', paths: ['sap-backup-restore'] },
];

function sapRows(items                         , ctx             )               {
  return items.map((item) => {
    const w = workloadsOf(ctx, item)[0];
    const sids = listAnswer(answersOf(ctx, item.app)['sids']).map((s) => s.toUpperCase()).filter((s) => /^[A-Z][A-Z0-9]{2}$/.test(s));
    const sid = sids.length === 1 ? sids[0] : undefined;
    return {
      item,
      values: {
        sid,
        instance: undefined,
        source_host: w ? sourceHost(w) : undefined,
        target_host: w ? targetHost(w) : undefined,
        ...(item.path === 'sap-hsr'
          ? { source_hana_host: w?.name, target_hana_host: w ? targetHost(w) : undefined, source_site: 'ATKSRC', target_site: 'ATKTGT' }
          : { tenant: sid, backup_dir: undefined }),
      },
    };
  });
}

const SAP_GENERATOR                = {
  id: 'sap',
  owner: WP17,
  paths: SAP_PATHS,
  needs: [
    ...HOST_NEEDS,
    { kind: 'command', name: 'jq', min: '1.6', why: 'SAP HANA paths: reading the Ansible results' },
  ],
  entry: () => SAP_FILE,
  files(items, ctx) {
    const tokens = settingTokens(items);
    const rows = sapRows(items, ctx);
    const body = (v      )         => code`sap_ctx "$id"
case "$\{ATK_ITEM_PATH[$id]}" in
  sap-hsr) hsr_${fnVerb(v)} "$id" ;;
  *) br_${fnVerb(v)} "$id" ;;
esac`;
    return {
      [SAP_FILE]: shScript({
        file: SAP_FILE,
        paths: SAP_PATHS,
        summary: 'SAP HANA: HANA System Replication (sap-hsr) or a backup and restore of the tenant (sap-backup-restore), run on the HANA hosts through Ansible.',
        needs: HOST_COMMANDS,
        functions: `${renderSettingsSh(rows, tokens)}\n${HOST_SH}\n${SAP_SH}`,
        verbs: everyVerb(body),
      }),
      [`${SAP_DIR}/README.md`]: familyReadme({
        title: 'SAP HANA (sap-hsr, sap-backup-restore)',
        script: SAP_FILE,
        intro: [
          'Moves SAP HANA to a target HANA built by the wave (the certified VM and the SAP disk layout come from the Terraform and the `community.sap_install` roles). Every command runs on the HANA hosts as `<sid>adm` through the project\'s Ansible inventory: reads ad hoc (they run in a dry run too), changes through `ansible/host-step.yml`.',
          'The target must run the same HANA release as the source, or a newer one (prepare checks it).',
          '**DMO with System Move** and **heterogeneous system copy (SWPM / R3load)** are SAP tools run by SAP Basis: they are runbook steps, not this script.',
        ],
        verbs: [
          '`prepare`: sap-hsr: a full data backup of the source (when it has none) and the system PKI files (SSFS .DAT / .KEY) copied to the target; sap-backup-restore: the `ATKMIG` userstore keys and the tenant on the target.',
          '`replicate`: sap-hsr: `hdbnsutil -sr_enable` on the source; the target stopped, `hdbnsutil -sr_register --remoteHost=… --replicationMode=async --operationMode=logreplay`, started; waits until the overall status is ACTIVE. sap-backup-restore: the seed backup.',
          '`status`: the overall system replication status (`systemReplicationStatus.py`); ACTIVE = in sync.',
          '`test` / `test-cleanup`: sap-hsr opens no test copy (rehearse the takeover on non-production); sap-backup-restore restores the seed into the target tenant.',
          '`cutover`: sap-hsr: the source stopped, `hdbnsutil -sr_takeover` on the target, the old source registered as the new secondary (the way back). sap-backup-restore: the final backup, the source tenant stopped, `RECOVER DATA … CLEAR LOG` on the target.',
          '`commit`: records the point of no return; the reverse replication stays until finalize.',
          '`rollback`: sap-hsr: the target stopped and a takeover on the source; sap-backup-restore: the source tenant started, the target tenant stopped (writes on the target since the cutover are lost).',
          '`finalize`: sap-hsr: `-sr_unregister` on the old source, `-sr_disable` on the target, the userstore keys removed; sap-backup-restore: the migration backups and keys removed.',
        ],
        specs: SAP_SPECS,
        rows,
        tokens,
        credentials: [
          '`SAP_HANA_SYSTEM_PASSWORD`: the SYSTEM user of SYSTEMDB, stored at run time in the `<sid>adm` userstore as key `ATKMIG` (sent on stdin; removed at finalize).',
        ],
        environment: ['`ATK_INVENTORY`: the Ansible inventory (default `ansible/inventory` of the project).'],
        runbook: [
          'DMO with System Move, or a heterogeneous copy with SWPM / R3load, when the method answer says so (SAP Basis).',
          'The SAP note checklist for the target platform (see the pattern\'s runbook).',
          'Backup encryption: when the source encrypts backups, back up its root keys and restore them on the target before a sap-backup-restore recovery.',
        ],
        unconfirmed: [
          '`hdbuserstore -i SET <key> <env> <user>` reading the password from stdin (not a terminal).',
          '`HDBSettings.sh systemReplicationStatus.py` on the `<sid>adm` PATH, and its "overall system replication status" line.',
          '`BACKUP DATA FOR FULL SYSTEM USING FILE (…)` from SYSTEMDB as the seed for system replication.',
          '`hdbnsutil -sr_unregister` on the stopped old primary, then `-sr_disable` on the new primary, as the teardown order.',
        ],
      }),
      [HOST_STEP_FILE]: HOST_STEP_PLAYBOOK,
      [HOST_COPY_FILE]: HOST_COPY_PLAYBOOK,
    };
  },
  findings(items, ctx) {
    const out            = [];
    const rows = sapRows(items, ctx);
    const noSid = rows.filter((r) => !known(r.values['sid'])).map((r) => r.item.name);
    if (noSid.length) {
      out.push(warning('exec.sap.settings', `${noSid.join(', ')}: the SAP system id is not known (the app's SIDs answer names none, or several): set ATK_SET_<TOKEN>_SID before prepare.`, { path: SAP_FILE }));
    }
    out.push(info('exec.sap.instance', 'SAP HANA: the instance number of each system is set at run time (ATK_SET_<TOKEN>_INSTANCE); see paths/sap/README.md.', { path: SAP_FILE }));
    const br = items.filter((i) => i.path === 'sap-backup-restore').map((i) => i.name);
    if (br.length) out.push(warning('exec.db.no-reverse', `${br.join(', ')}: backup and restore keeps no way back: after the cutover, a rollback loses the target's writes.`, { path: SAP_FILE }));
    return out;
  },
};

// ---------------------------------------------------------------------------
// Microsoft 365: Exchange Online (remote move) and SharePoint Online (SPMT)
// ---------------------------------------------------------------------------

const M365_DIR = 'paths/m365';
const EXO_FILE = `${M365_DIR}/exchange.ps1`;
const SPO_FILE = `${M365_DIR}/sharepoint.sh`;
const SPMT_PLAY = 'ansible/spmt.yml';

const EXO_PS = code`
function Get-SetValue {
  param([Parameter(Mandatory)] [string] $Id, [Parameter(Mandatory)] [string] $Key)
  $s = $Settings[$Id]
  $token = if ($s) { $s['tok'] } else { 'X' }
  $one = [Environment]::GetEnvironmentVariable("ATK_SET_$($token)_$($Key.ToUpperInvariant())")
  if ($one) { return $one }
  if ($s -and $s.ContainsKey($Key) -and $s[$Key]) { return [string] $s[$Key] }
  $all = [Environment]::GetEnvironmentVariable("ATK_SET_$($Key.ToUpperInvariant())")
  if ($all) { return $all }
  return ''
}

function Get-SetNeed {
  param([Parameter(Mandatory)] [string] $Id, [Parameter(Mandatory)] [string] $Key)
  $v = Get-SetValue -Id $Id -Key $Key
  if (-not $v) {
    $token = if ($Settings[$Id]) { $Settings[$Id]['tok'] } else { 'X' }
    Stop-Atk 5 "set ATK_SET_$($token)_$($Key.ToUpperInvariant()) (or ATK_SET_$($Key.ToUpperInvariant()) for every item; paths/m365/README.md)"
  }
  return $v
}

# App-only access to Exchange Online: an app registration with a certificate (EXO_APP_ID, EXO_ORGANIZATION,
# and EXO_CERT_THUMBPRINT on Windows, or EXO_CERT_FILE with the PFX password in EXO_CERT_PASSWORD).
function Connect-AtkExchange {
  if (Get-ConnectionInformation | Where-Object { $_.State -eq 'Connected' }) { return }
  foreach ($n in 'EXO_APP_ID', 'EXO_ORGANIZATION') {
    if (-not [Environment]::GetEnvironmentVariable($n)) { Stop-Atk 3 "set $($n) for app-only access to Exchange Online (paths/m365/README.md)" }
  }
  $connect = @{ AppId = $env:EXO_APP_ID; Organization = $env:EXO_ORGANIZATION; ShowBanner = $false }
  if ($env:EXO_CERT_THUMBPRINT) {
    Connect-ExchangeOnline @connect -CertificateThumbprint $env:EXO_CERT_THUMBPRINT
  } elseif ($env:EXO_CERT_FILE) {
    $pfx = ConvertTo-SecureString (Get-AtkSecret -Name EXO_CERT_PASSWORD) -AsPlainText -Force
    Connect-ExchangeOnline @connect -CertificateFilePath $env:EXO_CERT_FILE -CertificatePassword $pfx
  } else {
    Stop-Atk 3 'set EXO_CERT_THUMBPRINT (a certificate in the Windows store) or EXO_CERT_FILE and EXO_CERT_PASSWORD (a PFX file) for the app registration'
  }
}

# The on-premises account the migration endpoint uses (MRS proxy): EXO_ONPREM_USER and the secret EXO_ONPREM_PASSWORD.
function Get-OnPremCredential {
  if (-not $env:EXO_ONPREM_USER) { Stop-Atk 3 'set EXO_ONPREM_USER (DOMAIN\user with the right to move mailboxes on-premises)' }
  $sec = ConvertTo-SecureString (Get-AtkSecret -Name EXO_ONPREM_PASSWORD) -AsPlainText -Force
  return [pscredential]::new($env:EXO_ONPREM_USER, $sec)
}

function Find-Batch {
  param([Parameter(Mandatory)] [string] $Name)
  try { return Get-MigrationBatch -Identity $Name -ErrorAction Stop } catch { return $null }
}

function Find-Endpoint {
  param([Parameter(Mandatory)] [string] $Name)
  try { return Get-MigrationEndpoint -Identity $Name -ErrorAction Stop } catch { return $null }
}

function Get-BatchStatus {
  param($Batch)
  if ($Batch) { return [string] $Batch.Status }
  return ''
}

# The batch's mailbox list (column EmailAddress): the generated file, or the one ATK_SET_<TOKEN>_CSV names.
function Get-BatchCsv {
  param([Parameter(Mandatory)] [string] $Id)
  $path = Get-SetNeed -Id $Id -Key csv
  if (-not [System.IO.Path]::IsPathRooted($path)) { $path = Join-Path $PSScriptRoot $path }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Stop-Atk 5 "the batch file $path is missing" }
  $rows = @(Import-Csv -LiteralPath $path | Where-Object { $_.EmailAddress })
  if ($rows.Count -eq 0) { Stop-Atk 5 "add the mailboxes of this batch (column EmailAddress) to $path, or point ATK_SET_<TOKEN>_CSV at your own file" }
  return $path
}

$Done = @('Completed', 'CompletedWithErrors', 'Completing')
`;

const EXO_VERBS                       = {
  prepare: code`Connect-AtkExchange
$ep = Get-SetNeed -Id $Id -Key endpoint
$null = Get-BatchCsv -Id $Id
if (Find-Endpoint -Name $ep) {
  Set-AtkOutcome skipped "migration endpoint $ep exists" -State prepared
  return
}
$remote = Get-SetNeed -Id $Id -Key remote_server
$cred = Get-OnPremCredential
$check = Test-MigrationServerAvailability -ExchangeRemoteMove -RemoteServer $remote -Credentials $cred
if ([string] $check.Result -ne 'Success') {
  throw "the MRS proxy endpoint $remote does not answer ($($check.Message)): run the Hybrid Configuration Wizard and enable the MRS proxy (runbook)"
}
Invoke-AtkStep "New-MigrationEndpoint $ep (remote move, $remote)" { $null = New-MigrationEndpoint -ExchangeRemoteMove -Name $ep -RemoteServer $remote -Credentials $cred }
Set-AtkOutcome succeeded "migration endpoint $ep created" -State prepared`,
  replicate: code`Connect-AtkExchange
$name = Get-SetNeed -Id $Id -Key batch
$status = Get-BatchStatus (Find-Batch -Name $name)
if ($status -in $Done) {
  Set-AtkOutcome skipped "batch $name is $status" -State cut-over
  return
}
if (-not $status) {
  $ep = Get-SetNeed -Id $Id -Key endpoint
  $domain = Get-SetNeed -Id $Id -Key target_delivery_domain
  $csv = Get-BatchCsv -Id $Id
  Invoke-AtkStep "New-MigrationBatch $name from $ep" { $null = New-MigrationBatch -Name $name -SourceEndpoint $ep -TargetDeliveryDomain $domain -CSVData ([System.IO.File]::ReadAllBytes($csv)) }
  Invoke-AtkStep "Start-MigrationBatch $name" { Start-MigrationBatch -Identity $name }
} elseif ($status -in 'Stopped', 'Failed') {
  Invoke-AtkStep "Start-MigrationBatch $name (was $status)" { Start-MigrationBatch -Identity $name }
} elseif ($status -eq 'Synced') {
  Set-AtkOutcome skipped "batch $name is Synced" -State in-sync -Data @{ inSync = $true }
  return
}
if (Wait-AtkUntil -Minutes 1440 -IntervalSeconds 300 { (Get-BatchStatus (Find-Batch -Name $name)) -eq 'Synced' }) {
  Set-AtkOutcome succeeded "batch $name is Synced (the last increment runs at completion)" -State in-sync -Data @{ inSync = $true }
} else {
  Set-AtkOutcome succeeded "batch $name is syncing (status polls it)" -State replicating -Data @{ inSync = $false }
}`,
  status: code`Connect-AtkExchange
$name = Get-SetNeed -Id $Id -Key batch
$b = Find-Batch -Name $name
$status = Get-BatchStatus $b
if (-not $status) {
  Set-AtkOutcome succeeded "no batch $name yet" -Data @{ inSync = $false }
  return
}
$data = @{ inSync = ($status -eq 'Synced'); total = [int] $b.TotalCount; synced = [int] $b.SyncedCount; failed = [int] $b.FailedCount }
switch -Regex ($status) {
  '^Synced$' { Set-AtkOutcome succeeded "batch $name is Synced" -State in-sync -Data $data }
  '^Complet' { Set-AtkOutcome skipped "cut over: batch $name is $status" -Data $data }
  'Failed|WithErrors' { Set-AtkOutcome failed "batch $name is $status (Get-MigrationUser -BatchId $name for the mailboxes)" -Data $data }
  default { Set-AtkOutcome succeeded "batch $name is $status" -State replicating -Data $data }
}`,
  test: 'Set-AtkOutcome skipped \'Exchange Online opens no test copy: move pilot mailboxes in an earlier batch (runbook)\'',
  'test-cleanup': 'Set-AtkOutcome skipped \'no test copy to remove\'',
  cutover: code`Connect-AtkExchange
$name = Get-SetNeed -Id $Id -Key batch
$status = Get-BatchStatus (Find-Batch -Name $name)
if ($status -in 'Completed', 'CompletedWithErrors') {
  Set-AtkOutcome skipped "batch $name is $status" -State cut-over
  return
}
if (-not $status) { throw "no batch $($name): run replicate first" }
if ($status -ne 'Completing') {
  if ($status -ne 'Synced') { throw "batch $name is $status, not Synced: wait until status reports in-sync" }
  Invoke-AtkStep "Complete-MigrationBatch $name" { Complete-MigrationBatch -Identity $name -Confirm:$false }
}
if (Wait-AtkUntil -Minutes 720 -IntervalSeconds 120 { (Get-BatchStatus (Find-Batch -Name $name)) -in 'Completed', 'CompletedWithErrors' }) {
  Set-AtkOutcome succeeded "batch $name completed: switch MX and Autodiscover (dns.sh, runbook)" -State cut-over
} else {
  Set-AtkOutcome succeeded "batch $name is completing (status reports the end)" -State cutting-over
}`,
  commit: 'Set-AtkOutcome succeeded \'committed: completed mailboxes stay in Exchange Online (an offboarding batch is the way back)\'',
  rollback: code`Connect-AtkExchange
$name = Get-SetNeed -Id $Id -Key batch
$status = Get-BatchStatus (Find-Batch -Name $name)
if (-not $status) {
  Set-AtkOutcome skipped "no batch $($name): nothing moved" -Data @{ replication = 'kept' }
  return
}
if ($status -notin $Done) {
  if ($status -in 'Stopped', 'Stopping') {
    Set-AtkOutcome skipped "batch $name is $($status): the mailboxes are still on-premises" -Data @{ replication = 'kept' }
    return
  }
  Invoke-AtkStep "Stop-MigrationBatch $name" { Stop-MigrationBatch -Identity $name -Confirm:$false }
  Set-AtkOutcome succeeded "batch $name stopped: the mailboxes stay on-premises" -Data @{ replication = 'kept' }
  return
}
# Completed: move the mailboxes back with an offboarding batch (Exchange Online to on-premises).
$back = "$name-back"
if (Find-Batch -Name $back) {
  Set-AtkOutcome skipped "the offboarding batch $back exists" -Data @{ replication = 'reverse' }
  return
}
$ep = Get-SetNeed -Id $Id -Key endpoint
$domain = Get-SetNeed -Id $Id -Key onprem_delivery_domain
$database = Get-SetNeed -Id $Id -Key onprem_database
$csv = Get-BatchCsv -Id $Id
Invoke-AtkStep "New-MigrationBatch $back (offboarding to $database)" { $null = New-MigrationBatch -Name $back -TargetEndpoint $ep -TargetDeliveryDomain $domain -TargetDatabases @($database) -CSVData ([System.IO.File]::ReadAllBytes($csv)) -AutoStart -AutoComplete }
Set-AtkOutcome succeeded "offboarding batch $back started: the mailboxes move back on-premises; switch MX back (dns.sh revert)" -Data @{ replication = 'reverse' }`,
  finalize: code`Connect-AtkExchange
$name = Get-SetNeed -Id $Id -Key batch
$ep = Get-SetNeed -Id $Id -Key endpoint
$status = Get-BatchStatus (Find-Batch -Name $name)
$did = @()
if ($status) {
  if ($status -notin 'Completed', 'CompletedWithErrors') { throw "batch $name is $($status): complete it or roll it back before finalize" }
  Invoke-AtkStep "Remove-MigrationBatch $name" { Remove-MigrationBatch -Identity $name -Confirm:$false }
  $did += "batch $name"
}
$others = @(Get-MigrationBatch -ResultSize Unlimited | Where-Object { [string] $_.Identity -ne $name -and ("$($_.SourceEndpoint)" -eq $ep -or "$($_.TargetEndpoint)" -eq $ep) })
if ($others.Count -eq 0 -and (Find-Endpoint -Name $ep)) {
  Invoke-AtkStep "Remove-MigrationEndpoint $ep" { Remove-MigrationEndpoint -Identity $ep -Confirm:$false }
  $did += "endpoint $ep"
}
if ($did.Count -eq 0) {
  Set-AtkOutcome skipped 'nothing left: the batch is removed and the endpoint is removed or still in use'
  return
}
Set-AtkOutcome succeeded "removed $($did -join ' and ')"`,
};

const SPO_SH = code`
M365_DIR="$ATK_HOME/paths/m365"

# win_read HOST POWERSHELL: the output of a PowerShell command on a Windows inventory host (read-only).
win_read() {
  local enc out
  enc="$(printf '%s' "$2" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')"
  out="$(ANSIBLE_LOAD_CALLBACK_PLUGINS=1 ANSIBLE_STDOUT_CALLBACK=ansible.builtin.json \
    ansible "$1" -i "$ATK_INV" -m ansible.windows.win_command -a "powershell.exe -NoProfile -NonInteractive -EncodedCommand $enc" 2> /dev/null)" || true
  jq -r --arg h "$1" '.plays[0].tasks[0].hosts[$h].stdout // empty' <<< "$out" 2> /dev/null || true
}
sp_csv() {
  local f
  f="$(set_need "$1" sites_csv)"
  if [[ "$f" != /* ]]; then f="$M365_DIR/$f"; fi
  [[ -f "$f" ]] || atk_die 5 "the site list $f is missing"
  printf '%s' "$f"
}
sp_rows() { awk -F, 'NR > 1 && $1 != "" { n++ } END { print n + 0 }' "$1"; }
# sp_last ID: the last SPMT run's record on the migration host (JSON), or nothing.
sp_last() {
  local host work
  host="$(set_need "$1" spmt_host)"
  work="$(set_need "$1" work_folder)"
  win_read "$host" "\$f = Join-Path '$work' 'atk-last.json'; if (Test-Path -LiteralPath \$f) { Get-Content -Raw -LiteralPath \$f }"
}
# sp_migrate ID PHASE: one SPMT run over the site list (the first copies everything, a later one only the changes).
sp_migrate() {
  local id="$1" host csv work vars spo sp
  host="$(set_need "$id" spmt_host)"
  csv="$(sp_csv "$id")"
  work="$(set_need "$id" work_folder)"
  [[ -n "$\{SPO_USER:-}" ]] || atk_die 3 "set SPO_USER: the SharePoint Online account SPMT signs in with (paths/m365/README.md)"
  [[ -n "$\{SP_USER:-}" ]] || atk_die 3 "set SP_USER: the SharePoint Server account SPMT reads the source with"
  secret_for spo SPO_PASSWORD "$id"
  secret_for sp SP_PASSWORD "$id"
  atk_tmpfile vars
  jq -n --rawfile csv "$csv" --arg work "$work" --arg phase "$2" --arg h "$host" \
    '{atk_hosts: $h, atk_action: "migrate", atk_sites_csv: $csv, atk_work: $work, atk_phase: $phase}' > "$vars"
  ( export SPO_PASSWORD="$spo" SP_PASSWORD="$sp"; atk_run ansible-playbook -i "$ATK_INV" "$ATK_HOME/${SPMT_PLAY}" -e "@$vars" )
}
# sp_lock ID lock|unlock: the source site collections read-only, or writable again (on a SharePoint Server of the farm).
sp_lock() {
  local id="$1" host sites
  host="$(set_need "$id" source_host)"
  sites="$(awk -F, 'NR > 1 && $1 != "" { print $1 }' "$(sp_csv "$id")" | sort -u | jq -R . | jq -sc .)"
  atk_run ansible-playbook -i "$ATK_INV" "$ATK_HOME/${SPMT_PLAY}" -e "atk_hosts=$host" -e "atk_action=$2" -e "{\"atk_sites\": $sites}"
}
sp_phase() { jq -r '.phase // empty' <<< "$(sp_last "$1")" 2> /dev/null || true; }
`;

const SPO_VERBS                       = {
  prepare: code`local host csv n v
host="$(set_need "$id" spmt_host)"
csv="$(sp_csv "$id")"
n="$(sp_rows "$csv")"
(( n > 0 )) || atk_fail "$id" "the site list $csv has no rows: add Source,SourceList,TargetWeb,TargetList lines (paths/m365/README.md)"
v="$(win_read "$host" '(Get-Module -ListAvailable Microsoft.SharePoint.MigrationTool.PowerShell | Select-Object -First 1).Version.ToString()')"
[[ -n "$v" ]] || atk_fail "$id" "the SharePoint Migration Tool is not installed on $host (or the host does not answer): install SPMT there (runbook; it needs Windows PowerShell 5.1)"
atk_done "$id" prepared "$n site rows; SPMT $v on $host"`,
  replicate: code`if [[ "$(sp_phase "$id")" == cutover ]]; then atk_skip "$id" "cut over: the source is read-only" cut-over; fi
sp_migrate "$id" replicate
atk_done "$id" in-sync "SPMT run complete (the next run copies only changes)" inSync=true`,
  status: code`local last phase
last="$(sp_last "$id")"
phase="$(jq -r '.phase // empty' <<< "$last" 2> /dev/null || true)"
if [[ -z "$phase" ]]; then atk_done "$id" "" "no SPMT run yet" inSync=false; fi
if [[ "$phase" == cutover ]]; then atk_skip "$id" "cut over (the last SPMT run was the final one)"; fi
atk_done "$id" in-sync "last SPMT run: $(jq -r '"\(.tasks) tasks, finished \(.finished)"' <<< "$last")" inSync=true`,
  test: 'atk_skip "$id" "SharePoint Online opens no test copy: move pilot sites in an earlier wave (runbook)"',
  'test-cleanup': 'atk_skip "$id" "no test copy to remove"',
  cutover: code`if [[ "$(sp_phase "$id")" == cutover ]]; then atk_skip "$id" "the final SPMT run is done and the source is read-only" cut-over; fi
sp_lock "$id" lock
sp_migrate "$id" cutover
atk_done "$id" cut-over "source sites read-only; the final incremental copy is done: point the users at SharePoint Online (runbook)"`,
  commit: 'atk_done "$id" "" "committed: the source sites stay read-only until decommission"',
  rollback: code`sp_lock "$id" unlock
atk_done "$id" "" "the source sites are writable again; changes made in SharePoint Online since the cutover are not copied back" replication=lost`,
  finalize: 'atk_skip "$id" "nothing to tear down: the SPMT working folder goes with the migration host"',
};

/** `ansible/spmt.yml`: SPMT in Windows PowerShell 5.1 on the migration host, and the source site lock. */
const SPMT_PLAYBOOK = `---
# SharePoint Server to SharePoint Online with the SharePoint Migration Tool (SPMT). SPMT's PowerShell module
# runs only in Windows PowerShell 5.1, so paths/m365/sharepoint.sh runs this play against a Windows migration
# host (setting spmt_host) where SPMT is installed; ansible.windows.win_powershell runs Windows PowerShell there.
# Actions (atk_action): migrate (register, one task per row of the site list, start; a later run copies only
# changes), lock / unlock (the source site collections read-only, or writable again, on a SharePoint Server).
# Credentials come from the controller environment (SPO_USER / SPO_PASSWORD, SP_USER / SP_PASSWORD), set by the
# script from atk_secret; no_log keeps them out of the output.
- name: SharePoint migration step
  hosts: "{{ atk_hosts }}"
  gather_facts: false
  tasks:
    - name: Check the call
      ansible.builtin.assert:
        that:
          - atk_action in ['migrate', 'lock', 'unlock']
        fail_msg: Run this play through paths/m365/sharepoint.sh.

    - name: Copy the site list with SPMT (Windows PowerShell 5.1)
      when: atk_action == 'migrate'
      no_log: true
      ansible.windows.win_powershell:
        parameters:
          SitesCsv: "{{ atk_sites_csv }}"
          WorkFolder: "{{ atk_work }}"
          Phase: "{{ atk_phase | default('replicate') }}"
          SpoUser: "{{ lookup('ansible.builtin.env', 'SPO_USER') }}"
          SpoSecret: "{{ lookup('ansible.builtin.env', 'SPO_PASSWORD') }}"
          SpUser: "{{ lookup('ansible.builtin.env', 'SP_USER') }}"
          SpSecret: "{{ lookup('ansible.builtin.env', 'SP_PASSWORD') }}"
        script: |
          param([string] $SitesCsv, [string] $WorkFolder, [string] $Phase, [string] $SpoUser, [string] $SpoSecret, [string] $SpUser, [string] $SpSecret)
          $ErrorActionPreference = 'Stop'
          Import-Module Microsoft.SharePoint.MigrationTool.PowerShell
          $spo = New-Object System.Management.Automation.PSCredential ($SpoUser, (ConvertTo-SecureString $SpoSecret -AsPlainText -Force))
          $sp = New-Object System.Management.Automation.PSCredential ($SpUser, (ConvertTo-SecureString $SpSecret -AsPlainText -Force))
          New-Item -ItemType Directory -Force -Path $WorkFolder | Out-Null
          Register-SPMTMigration -SPOCredential $spo -WorkingFolder $WorkFolder -Force
          $rows = @($SitesCsv | ConvertFrom-Csv | Where-Object { $_.Source })
          foreach ($r in $rows) {
            $task = @{ SharePointSourceCredential = $sp; SharePointSourceSiteUrl = $r.Source; TargetSiteUrl = $r.TargetWeb }
            if ($r.SourceList) { $task.SourceList = $r.SourceList; $task.TargetList = $r.TargetList } else { $task.MigrateAll = $true }
            Add-SPMTTask @task
          }
          Start-SPMTMigration
          @{ phase = $Phase; tasks = $rows.Count; finished = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json |
            Set-Content -LiteralPath (Join-Path $WorkFolder 'atk-last.json') -Encoding UTF8
          $Ansible.Changed = $true

    - name: Set the source site collections read-only, or writable again (SharePoint Server)
      when: atk_action in ['lock', 'unlock']
      ansible.windows.win_powershell:
        parameters:
          Sites: "{{ atk_sites }}"
          LockState: "{{ 'ReadOnly' if atk_action == 'lock' else 'Unlock' }}"
        script: |
          param([string[]] $Sites, [string] $LockState)
          $ErrorActionPreference = 'Stop'
          Add-PSSnapin Microsoft.SharePoint.PowerShell -ErrorAction SilentlyContinue
          $Ansible.Changed = $false
          foreach ($url in $Sites) {
            $site = Get-SPSite -Identity $url
            $want = $LockState -eq 'ReadOnly'
            if ([bool] $site.ReadOnly -ne $want) {
              Set-SPSite -Identity $url -LockState $LockState
              $Ansible.Changed = $true
            }
            $site.Dispose()
          }
`;

const EXO_SPECS                         = [
  { key: 'batch', about: 'the migration batch name (atk-w<wave>-<item>)' },
  { key: 'endpoint', about: 'the remote-move migration endpoint (one per plan)' },
  { key: 'csv', about: 'the batch\'s mailbox list, column EmailAddress (relative to paths/m365, or an absolute path)' },
  { key: 'remote_server', about: 'the on-premises MRS proxy host (the EWS name the Hybrid Configuration Wizard published)' },
  { key: 'target_delivery_domain', about: 'the tenant\'s routing domain (for example contoso.mail.onmicrosoft.com)' },
  { key: 'onprem_delivery_domain', about: 'rollback after completion: the on-premises routing domain for the offboarding batch' },
  { key: 'onprem_database', about: 'rollback after completion: the on-premises mailbox database the offboarding batch moves to' },
];
const SPO_SPECS                         = [
  { key: 'spmt_host', about: 'the Windows migration host with SPMT, in the Ansible inventory (Windows PowerShell 5.1)' },
  { key: 'source_host', about: 'a SharePoint Server of the source farm in the inventory (to set the sites read-only at cutover)' },
  { key: 'sites_csv', about: 'the site list, columns Source,SourceList,TargetWeb,TargetList (relative to paths/m365, or absolute)' },
  { key: 'work_folder', about: 'SPMT\'s working folder on the migration host (keeps the incremental state)' },
];

function m365Rows(items                         , ctx             )                                           {
  const p8 = planId8(ctx.plan.id);
  const exo = items.filter((i) => i.path === 'saas-exchange').map((item) => ({
    item,
    values: {
      batch: `atk-w${item.wave ?? 0}-${item.resource.replace(/^atk-[a-z0-9]+-\d+-/, '')}`,
      endpoint: `atk-${p8}-exo`,
      csv: `batches/${item.resource}.csv`,
      remote_server: undefined, target_delivery_domain: undefined, onprem_delivery_domain: undefined, onprem_database: undefined,
    },
  }));
  const spo = items.filter((i) => i.path === 'saas-sharepoint').map((item) => {
    const w = workloadsOf(ctx, item)[0];
    return {
      item,
      values: {
        spmt_host: undefined,
        source_host: w ? sourceHost(w) : undefined,
        sites_csv: `sites/${item.resource}.csv`,
        work_folder: `C:\\ProgramData\\atk\\spmt\\${item.resource}`,
      },
    };
  });
  return { exo, spo };
}

const M365_GENERATOR                = {
  id: 'm365',
  owner: WP17,
  paths: ['saas-exchange', 'saas-sharepoint'],
  needs: [
    { kind: 'pwsh-module', name: 'ExchangeOnlineManagement', min: '3.4', why: 'saas-exchange: Exchange Online remote-move batches' },
    { kind: 'command', name: 'iconv', why: 'saas-sharepoint: PowerShell commands sent to the Windows migration host' },
    { kind: 'ansible-collection', name: 'ansible.windows', why: 'saas-sharepoint: SPMT runs in Windows PowerShell 5.1 on the migration host' },
    ...HOST_NEEDS,
  ],
  entry: (p) => (p === 'saas-exchange' ? EXO_FILE : SPO_FILE),
  files(items, ctx) {
    const tokens = settingTokens(items);
    const { exo, spo } = m365Rows(items, ctx);
    const out                         = {};
    if (exo.length) {
      out[EXO_FILE] = psScript({
        file: EXO_FILE,
        paths: ['saas-exchange'],
        summary: 'Exchange Server to Exchange Online: remote-move migration batches (after the Hybrid Configuration Wizard, a runbook step).',
        modules: ['ExchangeOnlineManagement'],
        functions: `${renderSettingsPs(exo, tokens)}\n${EXO_PS}`,
        verbs: EXO_VERBS,
      });
      for (const r of exo) out[`${M365_DIR}/${r.values['csv']}`] = 'EmailAddress\n';
    }
    if (spo.length) {
      out[SPO_FILE] = shScript({
        file: SPO_FILE,
        paths: ['saas-sharepoint'],
        summary: 'SharePoint Server to SharePoint Online with the SharePoint Migration Tool, run on a Windows migration host through Ansible (SPMT needs Windows PowerShell 5.1).',
        needs: [...HOST_COMMANDS, 'iconv'],
        functions: `${renderSettingsSh(spo, tokens)}\n${HOST_SH}\n${SPO_SH}`,
        verbs: SPO_VERBS,
      });
      out[SPMT_PLAY] = SPMT_PLAYBOOK;
      for (const r of spo) out[`${M365_DIR}/${r.values['sites_csv']}`] = 'Source,SourceList,TargetWeb,TargetList\n';
    }
    out[`${M365_DIR}/README.md`] = familyReadme({
      title: 'Microsoft 365 (saas-exchange, saas-sharepoint)',
      script: exo.length ? EXO_FILE : SPO_FILE,
      intro: [
        'Exchange Server mailboxes move to Exchange Online in remote-move batches (`exchange.ps1`, PowerShell 7 with ExchangeOnlineManagement, app-only certificate sign-in). SharePoint Server sites move to SharePoint Online with the SharePoint Migration Tool (`sharepoint.sh`).',
        'SPMT\'s PowerShell module runs only in **Windows PowerShell 5.1**, while the migration controller is Linux: `sharepoint.sh` therefore runs `ansible/spmt.yml` against a Windows migration host (`spmt_host`) where SPMT is installed; `ansible.windows.win_powershell` uses Windows PowerShell there.',
        'The batch and site lists are generated empty (a header only): fill them, or point `ATK_SET_<TOKEN>_CSV` / `ATK_SET_<TOKEN>_SITES_CSV` at your own files so a regenerated kit does not overwrite them.',
      ],
      verbs: [
        '`prepare`: Exchange: checks the MRS proxy (`Test-MigrationServerAvailability`) and creates the remote-move endpoint; SharePoint: checks the site list and SPMT on the migration host.',
        '`replicate`: Exchange: `New-MigrationBatch -SourceEndpoint … -TargetDeliveryDomain … -CSVData …`, `Start-MigrationBatch`, waits for Synced; SharePoint: one SPMT run (later runs copy only changes).',
        '`status`: the batch status and counts; the last SPMT run.',
        '`test` / `test-cleanup`: no test copy: move pilot mailboxes or sites in an earlier wave.',
        '`cutover`: Exchange: `Complete-MigrationBatch`, then switch MX and Autodiscover; SharePoint: the source sites set read-only, a final SPMT run.',
        '`commit`: records the point of no return.',
        '`rollback`: Exchange: a batch not yet completed is stopped; a completed one is moved back by an offboarding batch; SharePoint: the source sites made writable again (changes in SharePoint Online are not copied back).',
        '`finalize`: Exchange: the completed batch and the unused endpoint removed; SharePoint: nothing.',
      ],
      specs: [...(exo.length ? EXO_SPECS : []), ...(spo.length ? SPO_SPECS : [])],
      rows: [...exo, ...spo],
      tokens,
      credentials: [
        ...(exo.length ? [
          '`EXO_APP_ID`, `EXO_ORGANIZATION` (environment): the app registration for app-only access; with `EXO_CERT_THUMBPRINT` (Windows certificate store) or `EXO_CERT_FILE` (a PFX) and the secret `EXO_CERT_PASSWORD`.',
          '`EXO_ONPREM_USER` (environment) and the secret `EXO_ONPREM_PASSWORD`: the on-premises account of the migration endpoint.',
        ] : []),
        ...(spo.length ? [
          '`SPO_USER` (environment) and the secret `SPO_PASSWORD`: the SharePoint Online account SPMT signs in with (SPMT cannot answer an MFA prompt: use an account allowed to sign in without one).',
          '`SP_USER` (environment) and the secret `SP_PASSWORD`: the SharePoint Server account SPMT reads the source with. The site lock runs as the inventory\'s Windows account, which must be a farm administrator.',
        ] : []),
      ],
      environment: ['`ATK_INVENTORY`: the Ansible inventory (default `ansible/inventory` of the project).'],
      runbook: [
        ...(exo.length ? ['The **Hybrid Configuration Wizard** (a GUI) and the MRS proxy on the on-premises EWS virtual directory, before prepare.', 'MX and Autodiscover records after the batch completes.'] : []),
        ...(spo.length ? ['Install the SharePoint Migration Tool on the Windows migration host.', 'Point the users and links at SharePoint Online after the cutover.'] : []),
      ],
      unconfirmed: [
        ...(exo.length ? ['The offboarding batch (`New-MigrationBatch -TargetEndpoint … -TargetDatabases … -AutoStart -AutoComplete`) as the rollback after completion.', 'Matching batches to the endpoint through their `SourceEndpoint` / `TargetEndpoint` text at finalize.'] : []),
        ...(spo.length ? ['The SPMT cmdlet parameters (`Register-SPMTMigration -WorkingFolder -Force`, `Add-SPMTTask -SharePointSourceCredential -SharePointSourceSiteUrl -TargetSiteUrl -MigrateAll | -SourceList -TargetList`).', 'Ad hoc `ansible.windows.win_command` with an encoded PowerShell command for the reads.'] : []),
      ],
    });
    return out;
  },
  findings(items) {
    const out            = [];
    if (items.some((i) => i.path === 'saas-exchange')) {
      out.push(info('exec.pattern.hcw', 'Exchange Online: the Hybrid Configuration Wizard is a GUI step (runbook) before paths/m365/exchange.ps1 prepare; the batch lists are generated empty.', { path: EXO_FILE, source: 'https://learn.microsoft.com/en-us/exchange/hybrid-deployment/move-mailboxes' }));
    }
    if (items.some((i) => i.path === 'saas-sharepoint')) {
      out.push(info('exec.pattern.spmt-host', 'SharePoint Online: SPMT runs only in Windows PowerShell 5.1, so the kit runs it on a Windows migration host through Ansible (setting spmt_host); the site lists are generated empty.', { path: SPO_FILE }));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Kubernetes: Velero backup and restore, images with crane (A.4.7)
// ---------------------------------------------------------------------------

const VELERO_DIR = 'paths/velero';
const VELERO_FILE = `${VELERO_DIR}/velero.sh`;

const VELERO_SH = code`
VELERO_DIR="$ATK_HOME/paths/velero"
FAILED_PHASES=" Failed PartiallyFailed FailedValidation "

# v_ctx ID: the item's clusters (kubectl contexts), backup name and namespaces.
v_ctx() {
  local raw
  CS="$(set_need "$1" source_context)"
  CT="$(set_need "$1" target_context)"
  BK="$(set_need "$1" backup)"
  raw="$(set_need "$1" namespaces)"
  NS="$(printf '%s' "$raw" | tr ' ;' ',,' | tr -s ',' | sed 's/^,//; s/,$//')"
  mapfile -t NSL < <(printf '%s\n' "$NS" | tr ',' '\n' | sed '/^$/d')
}
# v_phase CONTEXT KIND NAME: the phase of a Velero backup or restore ('' when there is none).
v_phase() { kubectl --context "$1" -n velero get "$2s.velero.io" "$3" -o jsonpath='{.status.phase}' 2> /dev/null || true; }
v_done() { [[ "$(v_phase "$1" "$2" "$3")" == Completed ]]; }
v_ended() { local p; p="$(v_phase "$1" "$2" "$3")"; [[ "$p" == Completed || "$FAILED_PHASES" == *" $p "* ]] && [[ -n "$p" ]]; }
v_visible() { kubectl --context "$1" -n velero get backups.velero.io "$2" > /dev/null 2>&1; }
v_installed() { kubectl --context "$1" -n velero get deployment velero > /dev/null 2>&1; }
# v_install ID CONTEXT: Velero with the node agent (file-system backup of volumes), the bucket in the target cloud.
v_install() {
  local id="$1" ctx="$2" provider plugins bucket prefix cfg creds file
  provider="$(set_need "$id" provider)"
  plugins="$(set_need "$id" plugins)"
  bucket="$(set_need "$id" bucket)"
  prefix="$(set_need "$id" prefix)"
  local -a args=(install --kubecontext "$ctx" --provider "$provider" --plugins "$plugins" --bucket "$bucket" --prefix "$prefix" \
    --use-node-agent --use-volume-snapshots=false --wait)
  cfg="$(set_get "$id" bsl_config)"
  if [[ -n "$cfg" ]]; then args+=(--backup-location-config "$cfg"); fi
  if [[ "$(set_get "$id" credentials)" == none ]]; then
    args+=(--no-secret)
  else
    secret_for creds VELERO_CLOUD_CREDENTIALS "$id"
    atk_tmpfile file
    printf '%s\n' "$creds" > "$file"
    args+=(--secret-file "$file")
  fi
  atk_run velero "$\{args[@]}"
}
# v_modifiers ID: the resource-modifier ConfigMap on the target (storage class and ingress class remaps).
# Sets MOD (its name, or empty when nothing is remapped) and MOD_NEW (1 when this run created it).
v_modifiers() {
  local id="$1" sc ic file
  MOD=""
  MOD_NEW=0
  sc="$(set_get "$id" storage_class)"
  ic="$(set_get "$id" ingress_class)"
  [[ -n "$sc$ic" ]] || return 0
  MOD="$BK-modifiers"
  if kubectl --context "$CT" -n velero get configmap "$MOD" > /dev/null 2>&1; then return 0; fi
  atk_tmpfile file
  {
    printf 'version: v1\nresourceModifierRules:\n'
    if [[ -n "$sc" ]]; then
      printf -- '- conditions:\n    groupResource: persistentvolumeclaims\n    resourceNameRegex: ".*"\n  patches:\n  - operation: add\n    path: "/spec/storageClassName"\n    value: "%s"\n' "$sc"
    fi
    if [[ -n "$ic" ]]; then
      printf -- '- conditions:\n    groupResource: ingresses.networking.k8s.io\n    resourceNameRegex: ".*"\n  patches:\n  - operation: add\n    path: "/spec/ingressClassName"\n    value: "%s"\n' "$ic"
    fi
  } > "$file"
  atk_run kubectl --context "$CT" -n velero create configmap "$MOD" --from-file="modifiers.yaml=$file"
  MOD_NEW=1
}
# v_images ID: copy each "SOURCE TARGET" line of the image list with crane; an image whose digest already matches is skipped.
v_images() {
  local id="$1" list line src dst ds dt reg user pw
  local -a lines=()
  IMAGES_COPIED=0
  list="$(set_need "$id" images)"
  if [[ "$list" != /* ]]; then list="$VELERO_DIR/$list"; fi
  [[ -f "$list" ]] || return 0
  mapfile -t lines < <(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$list")
  (( $\{#lines[@]} )) || return 0
  atk_need crane
  reg="$(set_get "$id" target_registry)"
  user="$(set_get "$id" target_registry_user)"
  if [[ -n "$reg" && -n "$user" ]]; then
    secret_for pw REGISTRY_TARGET_PASSWORD "$id"
    printf '%s' "$pw" | atk_run crane auth login "$reg" -u "$user" --password-stdin
  fi
  for line in "$\{lines[@]}"; do
    line="$(printf '%s' "$line" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')"
    src="$\{line%% *}"
    dst="$\{line##* }"
    [[ -n "$src" && "$src" != "$dst" ]] || atk_die 5 "image list $list: each line is SOURCE TARGET ($line)"
    ds="$(crane digest "$src" 2> /dev/null || true)"
    dt="$(crane digest "$dst" 2> /dev/null || true)"
    if [[ -n "$ds" && "$ds" == "$dt" ]]; then continue; fi
    atk_retry 3 20 crane copy "$src" "$dst"
    IMAGES_COPIED=$(( IMAGES_COPIED + 1 ))
  done
}
# v_workloads CONTEXT NAMESPACE: kind, name, replicas and the recorded replicas (or -) of each Deployment and StatefulSet.
v_workloads() {
  kubectl --context "$1" -n "$2" get deployments,statefulsets -o json 2> /dev/null \
    | jq -r '.items[] | [(.kind | ascii_downcase), .metadata.name, ((.spec.replicas // 1) | tostring), (.metadata.annotations["archtoolkit.io/replicas"] // "-")] | @tsv' || true
}
_tsv4() { local r="$1"; F1="$\{r%%$'\t'*}"; r="$\{r#*$'\t'}"; F2="$\{r%%$'\t'*}"; r="$\{r#*$'\t'}"; F3="$\{r%%$'\t'*}"; F4="$\{r#*$'\t'}"; }
# v_scale_down CONTEXT NAMESPACE...: record each workload's replicas in an annotation (once), then scale it to 0. Sets SCALED.
v_scale_down() {
  local ctx="$1" ns line
  local -a lines=()
  shift
  SCALED=0
  for ns in "$@"; do
    mapfile -t lines < <(v_workloads "$ctx" "$ns")
    for line in "$\{lines[@]}"; do
      [[ -n "$line" ]] || continue
      _tsv4 "$line"
      if [[ "$F4" == - ]]; then atk_run kubectl --context "$ctx" -n "$ns" annotate "$F1/$F2" "archtoolkit.io/replicas=$F3" --overwrite; fi
      if [[ "$F3" != 0 ]]; then
        atk_run kubectl --context "$ctx" -n "$ns" scale "$F1/$F2" --replicas=0
        SCALED=$(( SCALED + 1 ))
      fi
    done
  done
}
# v_scale_up CONTEXT NAMESPACE...: each workload back to its recorded replicas. Sets SCALED.
v_scale_up() {
  local ctx="$1" ns line
  local -a lines=()
  shift
  SCALED=0
  for ns in "$@"; do
    mapfile -t lines < <(v_workloads "$ctx" "$ns")
    for line in "$\{lines[@]}"; do
      [[ -n "$line" ]] || continue
      _tsv4 "$line"
      if [[ "$F4" != - && "$F3" != "$F4" ]]; then
        atk_run kubectl --context "$ctx" -n "$ns" scale "$F1/$F2" --replicas="$F4"
        SCALED=$(( SCALED + 1 ))
      fi
    done
  done
}
# v_backup CONTEXT NAME: create the backup of the item's namespaces unless it exists (a failed one stops the verb).
v_backup() {
  local ph
  ph="$(v_phase "$1" backup "$2")"
  if [[ "$FAILED_PHASES" == *" $ph "* && -n "$ph" ]]; then
    atk_fail "$ID" "backup $2 is $ph: see velero backup describe $2 --details, delete it (velero backup delete $2 --confirm), then run again"
  fi
  if [[ -z "$ph" ]]; then atk_run velero --kubecontext "$1" backup create "$2" --include-namespaces "$NS" --default-volumes-to-fs-backup; fi
}
# v_restore NAME FROM [MAPPINGS]: create the restore on the target unless it exists, with the modifiers.
v_restore() {
  local -a args=(restore create "$1" --from-backup "$2")
  if [[ -n "$\{3:-}" ]]; then args+=(--namespace-mappings "$3"); fi
  v_modifiers "$ID"
  if [[ -n "$MOD" ]]; then args+=(--resource-modifier-configmap "$MOD"); fi
  if [[ -z "$(v_phase "$CT" restore "$1")" ]]; then atk_run velero --kubecontext "$CT" "$\{args[@]}"; fi
}
v_check_ended() { # CONTEXT KIND NAME WHAT
  if (( ATK_DRY_RUN )); then return 0; fi
  v_done "$1" "$2" "$3" || atk_fail "$ID" "$4 $3 ended $(v_phase "$1" "$2" "$3"): velero $2 describe $3 --details"
}
`;

const VELERO_VERBS                       = {
  prepare: code`local ctx did=0
ID="$id"; v_ctx "$id"
for ctx in "$CS" "$CT"; do
  if v_installed "$ctx"; then continue; fi
  v_install "$id" "$ctx"
  did=1
done
v_modifiers "$id"
if (( did == 0 && MOD_NEW == 0 )); then atk_skip "$id" "Velero runs on $CS and $CT$\{MOD:+; the modifier ConfigMap $MOD exists}" prepared; fi
atk_done "$id" prepared "Velero on $CS and $CT$\{MOD:+; modifiers in $MOD}"`,
  replicate: code`local seed
ID="$id"; v_ctx "$id"
seed="$BK-seed"
v_images "$id"
if v_done "$CS" backup "$seed" && (( IMAGES_COPIED == 0 )); then atk_skip "$id" "the seed backup $seed is complete and the images match" in-sync inSync=true; fi
v_backup "$CS" "$seed"
if atk_wait_until 480 30 v_ended "$CS" backup "$seed"; then
  v_check_ended "$CS" backup "$seed" "the seed backup"
  atk_done "$id" in-sync "seed backup $seed complete; $IMAGES_COPIED images copied" inSync=true
fi
atk_done "$id" replicating "the seed backup $seed is running" inSync=false`,
  status: code`local ph
ID="$id"; v_ctx "$id"
if v_done "$CT" restore "$BK"; then atk_skip "$id" "cut over: restored from $BK on $CT"; fi
ph="$(v_phase "$CS" backup "$BK-seed")"
if [[ -z "$ph" ]]; then atk_done "$id" "" "no seed backup yet" inSync=false; fi
if [[ "$ph" == Completed ]]; then atk_done "$id" in-sync "the seed backup is complete" inSync=true; fi
if [[ "$FAILED_PHASES" == *" $ph "* ]]; then atk_fail "$id" "the seed backup is $ph" inSync=false; fi
atk_done "$id" replicating "the seed backup is $ph" inSync=false`,
  test: code`local t maps="" ns
ID="$id"; v_ctx "$id"
t="$BK-test"
if v_done "$CT" restore "$t"; then atk_skip "$id" "the test restore $t is complete" testing; fi
v_done "$CS" backup "$BK-seed" || (( ATK_DRY_RUN )) || atk_fail "$id" "no complete seed backup: run replicate first"
atk_wait_until 20 20 v_visible "$CT" "$BK-seed" || atk_fail "$id" "the seed backup is not visible on $CT yet (both clusters use the same bucket and prefix?)"
for ns in "$\{NSL[@]}"; do maps+="$\{maps:+,}$ns:$ns-atktest"; done
v_restore "$t" "$BK-seed" "$maps"
if atk_wait_until 240 30 v_ended "$CT" restore "$t"; then
  v_check_ended "$CT" restore "$t" "the test restore"
  atk_done "$id" testing "test copy restored into the *-atktest namespaces on $CT"
fi
atk_done "$id" testing "the test restore $t is running"`,
  'test-cleanup': code`local t ph passed=false left=0 ns
ID="$id"; v_ctx "$id"
t="$BK-test"
ph="$(v_phase "$CT" restore "$t")"
if [[ "$ph" == Completed ]]; then passed=true; fi
for ns in "$\{NSL[@]}"; do
  if kubectl --context "$CT" get namespace "$ns-atktest" > /dev/null 2>&1; then
    atk_run kubectl --context "$CT" delete namespace "$ns-atktest" --wait=false
    left=1
  fi
done
if [[ -n "$ph" ]]; then
  atk_run velero --kubecontext "$CT" restore delete "$t" --confirm
  left=1
fi
if (( left == 0 )); then atk_skip "$id" "no test copy left"; fi
atk_done "$id" tested "test copy removed (the test restore was $\{ph:-missing})" passed="$passed"`,
  cutover: code`ID="$id"; v_ctx "$id"
if v_done "$CT" restore "$BK"; then atk_skip "$id" "restored from $BK on $CT" cut-over; fi
# 1. The source to 0 replicas, each workload's count recorded on it for rollback.
v_scale_down "$CS" "$\{NSL[@]}"
local scaled="$SCALED"
# 2. The final backup.
v_backup "$CS" "$BK"
atk_wait_until 480 30 v_ended "$CS" backup "$BK" || atk_fail "$id" "the final backup $BK has not finished: run cutover again to continue"
v_check_ended "$CS" backup "$BK" "the final backup"
# 3. The restore on the target.
atk_wait_until 20 20 v_visible "$CT" "$BK" || atk_fail "$id" "the final backup is not visible on $CT yet: run cutover again"
v_restore "$BK" "$BK"
atk_wait_until 480 30 v_ended "$CT" restore "$BK" || atk_fail "$id" "the restore $BK has not finished: run cutover again to continue"
v_check_ended "$CT" restore "$BK" "the restore"
# 4. DNS and ingress switch next (dns.sh, in the wave's cutover).
atk_done "$id" cut-over "restored on $CT; $scaled workloads scaled to 0 on $CS (recorded for rollback): switch DNS / ingress next"`,
  commit: 'atk_done "$id" "" "committed: the source stays at 0 replicas (recorded on each workload) until finalize"',
  rollback: code`local up down=0
ID="$id"; v_ctx "$id"
v_scale_up "$CS" "$\{NSL[@]}"
up="$SCALED"
if [[ -n "$(v_phase "$CT" restore "$BK")" ]]; then
  v_scale_down "$CT" "$\{NSL[@]}"
  down="$SCALED"
fi
if (( up == 0 && down == 0 )); then atk_skip "$id" "the source runs at its recorded replicas and the target copy is at 0" "" replication=lost; fi
atk_done "$id" "" "source scaled back ($up workloads); the target copy scaled to 0 and kept ($down); target writes since the cutover are not copied back" replication=lost`,
  finalize: code`local b n=0
ID="$id"; v_ctx "$id"
for b in "$BK-seed" "$BK"; do
  if [[ -n "$(v_phase "$CS" backup "$b")" ]]; then
    atk_run velero --kubecontext "$CS" backup delete "$b" --confirm
    n=$(( n + 1 ))
  fi
done
if kubectl --context "$CT" -n velero get configmap "$BK-modifiers" > /dev/null 2>&1; then
  atk_run kubectl --context "$CT" -n velero delete configmap "$BK-modifiers"
  n=$(( n + 1 ))
fi
if (( n == 0 )); then atk_skip "$id" "nothing left: the backups and the modifier ConfigMap are removed"; fi
atk_done "$id" "" "removed the backups (their data in the bucket too) and the modifier ConfigMap; Velero stays installed"`,
};

const VELERO_SPECS                         = [
  { key: 'backup', about: 'the Velero backup name of the app (one per app: the app\'s nodes share it)' },
  { key: 'namespaces', about: 'the app\'s namespaces (from the pattern\'s namespaces answer)' },
  { key: 'source_context', about: 'the kubectl context of the source cluster' },
  { key: 'target_context', about: 'the kubectl context of the target cluster' },
  { key: 'provider', about: 'the Velero object-store provider (aws, azure, gcp; OCI uses the S3-compatible API)' },
  { key: 'plugins', about: 'the Velero plugin images with tags (for example velero/velero-plugin-for-aws:<tag>; VKS adds the vSphere plugin)' },
  { key: 'bucket', about: 'the bucket in the target cloud (from the app stack)' },
  { key: 'prefix', about: 'the prefix in the bucket (one per plan)' },
  { key: 'bsl_config', about: 'the backup location config (region=…, or resourceGroup=…,storageAccount=… on Azure, s3Url=…,s3ForcePathStyle=true on OCI)' },
  { key: 'credentials', about: 'secret (VELERO_CLOUD_CREDENTIALS, written to a runtime file for velero install) or none (workload identity)' },
  { key: 'storage_class', about: 'the target storage class the restore sets on each PVC (empty = unchanged)' },
  { key: 'ingress_class', about: 'the target ingress class the restore sets on each Ingress (empty = unchanged)' },
  { key: 'images', about: 'the image list, one SOURCE TARGET per line (relative to paths/velero, or absolute); copied with crane' },
  { key: 'target_registry', about: 'the target registry to log in to (with target_registry_user and REGISTRY_TARGET_PASSWORD), when the cloud credential helper does not' },
  { key: 'target_registry_user', about: 'the user for target_registry' },
];

const VELERO_PROVIDER                                   = { aws: 'aws', azure: 'azure', google: 'gcp', oci: 'aws', vmware: 'aws' };

function veleroRows(items                         , ctx             )               {
  const p8 = planId8(ctx.plan.id);
  return items.map((item) => {
    const ns = listAnswer(answersOf(ctx, item.app)['namespaces']);
    const backup = resourceName(ctx.plan.id, item.wave, item.app);
    return {
      item,
      values: {
        backup,
        namespaces: ns.length ? ns.join(',') : undefined,
        source_context: undefined,
        target_context: undefined,
        provider: VELERO_PROVIDER[item.target.platform ?? ''] ?? undefined,
        plugins: undefined,
        bucket: undefined,
        prefix: `atk-${p8}`,
        bsl_config: item.target.region && item.target.platform === 'aws' ? `region=${item.target.region}` : undefined,
        credentials: 'secret',
        storage_class: undefined,
        ingress_class: undefined,
        images: `images/${backup}.txt`,
        target_registry: undefined,
        target_registry_user: undefined,
      },
    };
  });
}

const VELERO_GENERATOR                = {
  id: 'velero',
  owner: WP17,
  paths: ['k8s-velero'],
  needs: [
    { kind: 'command', name: 'velero', min: '1.14', why: 'k8s-velero: backup and restore of the app namespaces', install: 'https://velero.io/docs/main/basic-install/' },
    { kind: 'command', name: 'kubectl', why: 'k8s-velero: both clusters (the source scaled to 0 at cutover)' },
    { kind: 'command', name: 'crane', why: 'k8s-velero: the image copies (skopeo sync is the alternative)', install: 'go install github.com/google/go-containerregistry/cmd/crane@latest' },
  ],
  entry: () => VELERO_FILE,
  files(items, ctx) {
    const tokens = settingTokens(items);
    const rows = veleroRows(items, ctx);
    const out                         = {
      [VELERO_FILE]: shScript({
        file: VELERO_FILE,
        paths: ['k8s-velero'],
        summary: 'Kubernetes: Velero backup of the app namespaces, restore on the target cluster with the storage and ingress class remaps; images copied with crane.',
        needs: ['velero', 'kubectl', 'jq'],
        functions: `${renderSettingsSh(rows, tokens)}\n${HOST_SH}\n${VELERO_SH}`,
        verbs: VELERO_VERBS,
      }),
    };
    for (const r of rows) {
      out[`${VELERO_DIR}/${r.values['images']}`] = `# ${r.item.app}: the images to copy, one per line: SOURCE TARGET (for example registry.example/app/web:1.4 <target registry>/app/web:1.4).\n# Registry credentials come from the environment (docker config, the cloud helper, or target_registry with REGISTRY_TARGET_PASSWORD).\n`;
    }
    out[`${VELERO_DIR}/README.md`] = familyReadme({
      title: 'Kubernetes with Velero (k8s-velero)',
      script: VELERO_FILE,
      intro: [
        'One Velero backup per app (its nodes share it), in a bucket in the target cloud created by the app stack. Velero is installed on both clusters with the node agent (file-system backup of the volumes). The restore remaps the storage class and the ingress class through a resource-modifier ConfigMap. VKS clusters on VCF use Velero with the vSphere plugin (add it to `plugins`).',
        'Cutover order (A.4.7): the source Deployments and StatefulSets scaled to 0 (each one\'s replica count recorded in the annotation `archtoolkit.io/replicas`), the final backup, the restore, then DNS / ingress. Rollback scales the source back.',
      ],
      verbs: [
        '`prepare`: `velero install --provider … --plugins … --bucket … --use-node-agent` on both clusters (skipped where Velero runs); the modifier ConfigMap on the target.',
        '`replicate`: the images (crane copy, skipped when the digests match) and the seed backup `<backup>-seed`.',
        '`status`: the seed backup\'s phase.',
        '`test`: the seed restored into `<namespace>-atktest` namespaces on the target; `test-cleanup` removes them and records the result.',
        '`cutover`: source to 0, final backup `<backup>`, restore on the target.',
        '`commit`: records the point of no return.',
        '`rollback`: the source back to its recorded replicas; the target copy to 0 (kept).',
        '`finalize`: the backups (and their data in the bucket) and the modifier ConfigMap removed.',
      ],
      specs: VELERO_SPECS,
      rows,
      tokens,
      credentials: [
        '`VELERO_CLOUD_CREDENTIALS` (with `credentials` = secret): the object-store credentials file content for `velero install --secret-file` (written to a mode-600 runtime file, removed on exit).',
        '`REGISTRY_TARGET_PASSWORD` (with `target_registry`): sent to `crane auth login --password-stdin`.',
      ],
      runbook: ['Switch DNS / ingress to the target after the restore (the wave\'s dns.sh).', 'Stateful data outside the cluster (external databases) moves on its own path.'],
      unconfirmed: [
        'The resource-modifier `add` patches on `/spec/storageClassName` and `/spec/ingressClassName`.',
        'Velero\'s backup sync to the target cluster (both clusters on the same bucket and prefix) before the restore.',
      ],
    });
    return out;
  },
  findings(items, ctx) {
    const rows = veleroRows(items, ctx);
    const noNs = rows.filter((r) => !known(r.values['namespaces'])).map((r) => r.item.name);
    return noNs.length
      ? [warning('exec.velero.namespaces', `${noNs.join(', ')}: the app's namespaces are not known (the pattern's namespaces answer): set ATK_SET_<TOKEN>_NAMESPACES before prepare.`, { path: VELERO_FILE })]
      : [];
  },
};

// ---------------------------------------------------------------------------
// Network appliances: move the configuration, not the VM
// ---------------------------------------------------------------------------

const APPL_DIR = 'paths/appliance';
const APPL_FILE = `${APPL_DIR}/appliance.sh`;

const APPL_SH = code`
_curl_esc() { local s="$1"; s="$\{s//\\/\\\\}"; s="$\{s//\"/\\\"}"; printf '%s' "$s"; }
ap_vendor() { set_need "$1" vendor; }
ap_addr() { set_need "$1" "$2_addr"; }
# ap_cfg VAR ID SIDE: curl settings for the side's management API, credentials included (sent to curl on stdin).
ap_cfg() {
  local _var="$1" id="$2" side="$3" vendor user sec out=""
  vendor="$(ap_vendor "$id")"
  case "$vendor" in
    f5)
      user="$(set_need "$id" "$\{side}_user")"
      secret_for sec "F5_$\{side^^}_PASSWORD" "$id"
      out+="user = \"$(_curl_esc "$user"):$(_curl_esc "$sec")\""$'\n'
      ;;
    paloalto)
      secret_for sec "PANOS_$\{side^^}_API_KEY" "$id"
      out+="header = \"X-PAN-KEY: $(_curl_esc "$sec")\""$'\n'
      ;;
    *) atk_die 1 "no management API settings for $vendor" ;;
  esac
  if [[ -n "$\{APPL_CA_BUNDLE:-}" ]]; then out+="cacert = \"$(_curl_esc "$APPL_CA_BUNDLE")\""$'\n'; fi
  if [[ "$\{APPL_TLS_INSECURE:-0}" == 1 ]]; then out+=$'insecure\n'; fi
  printf -v "$_var" '%s' "$out"
}
ap_base() { local a; a="$(ap_addr "$1" "$2")"; printf 'https://%s' "$(url_host "$a")"; }
# ap_get ID SIDE PATH [curl args]: a GET on the side's management API (read-only: runs in a dry run too).
ap_get() {
  local cfg base
  ap_cfg cfg "$1" "$2"
  base="$(ap_base "$1" "$2")"
  printf '%s' "$cfg" | curl -sS --fail --connect-timeout 20 --config - "$\{@:4}" "$base$3"
}
# ap_send ID SIDE METHOD PATH [curl args]: a call that changes something (printed instead in a dry run).
ap_send() {
  local cfg base
  ap_cfg cfg "$1" "$2"
  base="$(ap_base "$1" "$2")"
  printf '%s' "$cfg" | atk_run curl -sS --fail --connect-timeout 20 --config - -X "$3" "$\{@:5}" "$base$4"
}
# ap_note ID: the runbook step for a vendor (or setup) the kit does not automate, or nothing.
ap_note() {
  case "$(ap_vendor "$1")" in
    f5|paloalto) if [[ "$(ap_vendor "$1")" == paloalto ]] && set_on "$1" panorama; then printf '%s' "Palo Alto managed by Panorama: add the new VM-Series to its device group and template stack, then commit and push from Panorama (runbook)"; fi ;;
    fortinet) printf '%s' "FortiGate: restore the configuration through FortiManager or FortiConverter so the interfaces map to the cloud VM's ports; a straight restore on a VM with other ports locks the unit out (runbook)" ;;
    checkpoint) printf '%s' "Check Point: migrate_server export on the source management server (expert mode) and migrate_server import on the new one; the gateways then get their policy from it (runbook)" ;;
    cisco) printf '%s' "Cisco: translate the running-config to the cloud router's interfaces on the Network page, then apply it (runbook)" ;;
    *) printf '%s' "move the configuration with the vendor's export and import (runbook)" ;;
  esac
}

# ---------------------------------------------------------------- F5 BIG-IP: AS3 declarations (declarative, so a re-post is idempotent)

# f5_map ID: the source declaration with the address map applied (old=new pairs: the virtual addresses in the target VPC / VNet).
f5_map() { jq --arg map "$(set_get "$1" address_map)" 'def pairs: ($map | split(",") | map(select(contains("="))) | map(split("=") | {(.[0]): .[1]}) | add // {}); pairs as $m | walk(if type == "string" and ($m[.] != null) then $m[.] else . end)'; }
f5_norm() { jq -S 'del(.id, .updateMode, .schemaVersion, .controls, .label, .remark)' 2> /dev/null || true; }
# f5_copy ID: post the source's AS3 declaration to the target when they differ. Sets COPY (none, same, copied).
f5_copy() {
  local id="$1" body now
  atk_tmpfile body
  { ap_get "$id" source /mgmt/shared/appsvcs/declare 2> /dev/null || true; } | { f5_map "$id" 2> /dev/null || true; } > "$body"
  if ! jq -e '.class == "ADC"' "$body" > /dev/null 2>&1; then COPY=none; return 0; fi
  now="$({ ap_get "$id" target /mgmt/shared/appsvcs/declare 2> /dev/null || true; } | f5_norm)"
  if [[ -n "$now" && "$now" == "$(f5_norm < "$body")" ]]; then COPY=same; return 0; fi
  ap_send "$id" target POST /mgmt/shared/appsvcs/declare -H 'Content-Type: application/json' --data-binary "@$body" > /dev/null
  COPY=copied
}
f5_same() {
  local a b
  a="$({ ap_get "$1" source /mgmt/shared/appsvcs/declare 2> /dev/null || true; } | { f5_map "$1" 2> /dev/null || true; } | f5_norm)"
  b="$({ ap_get "$1" target /mgmt/shared/appsvcs/declare 2> /dev/null || true; } | f5_norm)"
  [[ -n "$a" && "$a" == "$b" ]]
}

# ---------------------------------------------------------------- Palo Alto: the vsys and shared configuration (XML API)

PAN_DEV="/config/devices/entry[@name='localhost.localdomain']"
pan_get() { local id="$1" side="$2"; shift 2; local -a q=(); local kv; for kv in "$@"; do q+=(--data-urlencode "$kv"); done; ap_get "$id" "$side" /api/ -G "$\{q[@]}"; }
pan_do() { local id="$1" side="$2"; shift 2; local -a q=(); local kv; for kv in "$@"; do q+=(--data-urlencode "$kv"); done; ap_send "$id" "$side" GET /api/ -G "$\{q[@]}"; }
pan_rules() { { pan_get "$1" "$2" type=config action=get "xpath=$PAN_DEV/vsys/entry/rulebase/security/rules" 2> /dev/null || true; } | { grep -o '<entry ' || true; } | wc -l | tr -d ' '; }
pan_job_done() { [[ "$(pan_get "$1" target type=op "cmd=<show><jobs><id>$2</id></jobs></show>" 2> /dev/null || true)" == *"<status>FIN</status>"* ]]; }
# pan_copy ID: export the source's configuration, import it on the target, load its vsys and shared parts, commit.
# Skipped when the export has not changed since the last copy. Sets COPY (same, copied).
pan_copy() {
  local id="$1" file sum name job
  atk_tmpfile file
  pan_get "$id" source type=export category=configuration > "$file"
  sum="$(sha256sum "$file" | awk '{ print $1 }')"
  if [[ "$(atk_ids_get appliance-rebuild "$id.panos" 2> /dev/null || true)" == "$sum" ]]; then COPY=same; return 0; fi
  name="$(atk_name "$id").xml"
  ap_send "$id" target POST "/api/?type=import&category=configuration" -F "file=@$file;filename=$name" > /dev/null
  pan_do "$id" target type=op "cmd=<load><config><partial><from>$name</from><from-xpath>$PAN_DEV/vsys</from-xpath><to-xpath>$PAN_DEV/vsys</to-xpath><mode>replace</mode></partial></config></load>" > /dev/null
  pan_do "$id" target type=op "cmd=<load><config><partial><from>$name</from><from-xpath>/config/shared</from-xpath><to-xpath>/config/shared</to-xpath><mode>merge</mode></partial></config></load>" > /dev/null
  job="$(pan_do "$id" target type=commit 'cmd=<commit></commit>' | sed -n 's:.*<job>\([0-9][0-9]*\)</job>.*:\1:p')"
  if [[ -n "$job" ]]; then atk_wait_until 30 15 pan_job_done "$id" "$job" || atk_fail "$id" "the commit (job $job) on the target has not finished"; fi
  atk_ids_put appliance-rebuild "$id.panos" "$sum"
  COPY=copied
}

# ap_copy ID: the vendor's configuration copy (sets COPY).
ap_copy() { case "$(ap_vendor "$1")" in f5) f5_copy "$1" ;; paloalto) pan_copy "$1" ;; esac; }
# ap_same ID: the target holds the source's configuration.
ap_same() {
  case "$(ap_vendor "$1")" in
    f5) f5_same "$1" ;;
    paloalto) local a; a="$(pan_rules "$1" source)"; [[ "$a" != 0 && "$a" == "$(pan_rules "$1" target)" ]] ;;
    *) return 1 ;;
  esac
}
# ap_manual ID [STATE]: a runbook vendor records skipped with its step; otherwise the addresses and credentials must be set (exit 5 / 3).
ap_manual() {
  local n a cfg
  n="$(ap_note "$1")"
  if [[ -n "$n" ]]; then atk_skip "$1" "$n" "$\{2:-}"; fi
  a="$(ap_addr "$1" source)"
  a="$(ap_addr "$1" target)"
  ap_cfg cfg "$1" source
  ap_cfg cfg "$1" target
}
f5_none() { atk_skip "$1" "F5 without AS3 on the source: tmsh save sys ucs on the source, then load sys ucs <file> no-license platform-migrate on the new BIG-IP VE, or adopt AS3 (runbook)" "$\{2:-}"; }
`;

const APPL_VERBS                       = {
  prepare: code`ap_manual "$id" prepared
local side
for side in source target; do
  case "$(ap_vendor "$id")" in
    f5) [[ -n "$(ap_get "$id" "$side" /mgmt/shared/appsvcs/info 2> /dev/null || true)" ]] || atk_fail "$id" "no AS3 answer from the $side BIG-IP ($(ap_addr "$id" "$side")): install AS3 there, check the address and the credentials" ;;
    paloalto) [[ "$(pan_get "$id" "$side" type=op 'cmd=<show><system><info></info></system></show>' 2> /dev/null || true)" == *"status=\"success\""* ]] || atk_fail "$id" "no answer from the $side firewall's XML API ($(ap_addr "$id" "$side"))" ;;
  esac
done
atk_done "$id" prepared "the management APIs of both appliances answer"`,
  replicate: code`ap_manual "$id" in-sync
ap_copy "$id"
case "$COPY" in
  none) f5_none "$id" ;;
  same) atk_skip "$id" "the target already holds the source's configuration" in-sync inSync=true ;;
esac
atk_done "$id" in-sync "configuration copied to the target (not in the traffic path yet)" inSync=true`,
  status: code`ap_manual "$id"
if ap_same "$id"; then atk_done "$id" in-sync "the target holds the source's configuration" inSync=true; fi
atk_done "$id" replicating "the target's configuration differs from the source's (replicate copies it)" inSync=false`,
  test: code`ap_manual "$id" testing
local passed=false
if ap_same "$id"; then passed=true; fi
atk_done "$id" testing "configuration compared (passed=$passed): test traffic through the target on its test address" passed="$passed"`,
  'test-cleanup': code`ap_manual "$id"
local passed=false
if ap_same "$id"; then passed=true; fi
atk_done "$id" tested "nothing to remove; the target keeps the copied configuration" passed="$passed"`,
  cutover: code`ap_manual "$id" cut-over
ap_copy "$id"
if [[ "$COPY" == none ]]; then f5_none "$id" cut-over; fi
atk_done "$id" cut-over "final configuration copy $COPY: move the traffic (routes, load balancer and DNS: the Network page and dns.sh)"`,
  commit: 'atk_done "$id" "" "committed: the source appliance is left unchanged until decommission"',
  rollback: 'atk_skip "$id" "the source appliance was never changed: revert the routes and the load balancer (rollback.sh reverts DNS)" "" replication=kept',
  finalize: 'atk_skip "$id" "nothing to tear down: the source appliance goes at decommission"',
};

const APPL_SPECS                         = [
  { key: 'vendor', about: 'f5, paloalto, fortinet, checkpoint, cisco or other (from the workload type or the app pattern); f5 (AS3) and paloalto are automated, the others are runbook steps' },
  { key: 'source_addr', about: 'the source appliance\'s management address (IPv6 accepted)' },
  { key: 'target_addr', about: 'the new appliance\'s management address (a Terraform output)' },
  { key: 'source_user', about: 'F5: the source BIG-IP user (with F5_SOURCE_PASSWORD)' },
  { key: 'target_user', about: 'F5: the new BIG-IP user (with F5_TARGET_PASSWORD)' },
  { key: 'address_map', about: 'F5: old=new pairs, comma separated: the virtual addresses in the target network' },
  { key: 'panorama', about: 'Palo Alto: yes when Panorama manages the firewalls (then the move is a Panorama runbook step)' },
];

const APPL_VENDORS = ['f5', 'paloalto', 'fortinet', 'checkpoint', 'cisco']         ;

function vendorOf(item              , ctx             )         {
  const w = workloadsOf(ctx, item)[0];
  const pattern = ctx.plan.apps.find((a) => a.name === item.app)?.pattern;
  for (const s of [w?.workloadType, pattern]) {
    const v = s?.startsWith('appliance-') ? s.slice('appliance-'.length) : undefined;
    if (v && (APPL_VENDORS                     ).includes(v)) return v;
  }
  return 'other';
}

function applRows(items                         , ctx             )               {
  return items.map((item) => {
    const w = workloadsOf(ctx, item)[0];
    const vendor = vendorOf(item, ctx);
    return {
      item,
      values: {
        vendor,
        source_addr: addressOf(w) ?? w?.name,
        target_addr: undefined,
        ...(vendor === 'f5' ? { source_user: undefined, target_user: undefined, address_map: undefined } : {}),
        ...(vendor === 'paloalto' ? { panorama: 'no' } : {}),
      },
    };
  });
}

const APPLIANCE_GENERATOR                = {
  id: 'appliance',
  owner: WP17,
  paths: ['appliance-rebuild'],
  needs: [
    { kind: 'command', name: 'curl', min: '7.76', why: 'appliance-rebuild: the appliances\' management APIs' },
    { kind: 'command', name: 'sha256sum', why: 'appliance-rebuild: whether a configuration changed since the last copy' },
  ],
  entry: () => APPL_FILE,
  files(items, ctx) {
    const tokens = settingTokens(items);
    const rows = applRows(items, ctx);
    return {
      [APPL_FILE]: shScript({
        file: APPL_FILE,
        paths: ['appliance-rebuild'],
        summary: 'Network appliances: the new appliance comes from the marketplace image (Terraform); this moves the configuration, not the VM.',
        needs: ['curl', 'jq'],
        functions: `${renderSettingsSh(rows, tokens)}\n${HOST_SH}\n${APPL_SH}`,
        verbs: APPL_VERBS,
      }),
      [`${APPL_DIR}/README.md`]: familyReadme({
        title: 'Network appliances (appliance-rebuild)',
        script: APPL_FILE,
        intro: [
          'The new appliance is deployed from the vendor\'s marketplace image by the wave\'s Terraform; this script moves the **configuration, not the VM**. The device configuration itself (interfaces, zones, routes) is the Network page\'s job (`network.html`).',
          'Automated: **F5 BIG-IP with AS3** (the source\'s declaration, with the address map applied, posted to the new BIG-IP; declarative, so a repeat is idempotent) and **Palo Alto** without Panorama (the running configuration exported, imported on the new VM-Series, its vsys part loaded with `replace` and the shared part with `merge`, then committed; interfaces and management stay the new unit\'s own).',
          'Runbook steps (every verb records skipped with the step): F5 without AS3 (UCS with `platform-migrate`), Palo Alto under Panorama, FortiGate (FortiManager / FortiConverter), Check Point (`migrate_server export` / `import`), Cisco (running-config translated on the Network page).',
        ],
        verbs: [
          '`prepare`: both management APIs answer.',
          '`replicate`: the configuration copy (skipped when the target already holds it).',
          '`status`: whether the target holds the source\'s configuration.',
          '`test` / `test-cleanup`: compare the configurations; test traffic through the target\'s test address.',
          '`cutover`: a final copy (the freeze keeps the source unchanged), then the traffic moves (routes, load balancer, DNS).',
          '`commit`: records the point of no return.',
          '`rollback`: nothing to undo on the appliances: the source was never changed; the routes and DNS go back.',
          '`finalize`: nothing (the source goes at decommission).',
        ],
        specs: APPL_SPECS,
        rows,
        tokens,
        credentials: [
          'F5: `F5_SOURCE_PASSWORD`, `F5_TARGET_PASSWORD` (with the users in the settings), sent to curl in its config on stdin.',
          'Palo Alto: `PANOS_SOURCE_API_KEY`, `PANOS_TARGET_API_KEY` (XML API keys), sent as the X-PAN-KEY header in curl\'s config on stdin.',
        ],
        environment: ['`APPL_CA_BUNDLE`: a CA file for the appliances\' certificates; `APPL_TLS_INSECURE=1` skips the check (self-signed lab units only).'],
        runbook: ['The vendors and setups listed above.', 'AS3 declarations holding secrets encrypted by the source device (passphrases, keys) must be re-entered on the new BIG-IP.'],
        unconfirmed: [
          'Palo Alto partial load (`<load><config><partial>…<mode>replace|merge</mode>`) with the default device entry `localhost.localdomain` on both units.',
          'AS3 accepting the declaration returned by `GET /mgmt/shared/appsvcs/declare` as the body of a POST, with only the address map changed.',
        ],
      }),
    };
  },
  findings(items, ctx) {
    return applRows(items, ctx).filter((r) => !['f5', 'paloalto'].includes(r.values['vendor'] ?? '')).map((r) =>
      info('exec.pattern.runbook', `${r.item.name}: the ${r.values['vendor']} configuration moves by a runbook step (no vendor-neutral automation); the script records each verb as skipped with the step.`, { path: r.item.id }));
  },
};

// ---------------------------------------------------------------------------
// The module's generators
// ---------------------------------------------------------------------------

/** WP-17's pattern paths: sap-hsr, sap-backup-restore, saas-exchange, saas-sharepoint, k8s-velero, appliance-rebuild. */
export const GENERATORS                           = Object.freeze([SAP_GENERATOR, M365_GENERATOR, VELERO_GENERATOR, APPLIANCE_GENERATOR]);
