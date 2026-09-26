/**
 * Rebuild (addendum A.6.10, WP-11b): the target is deployed fresh from an
 * image, configured, and the data copied onto it; the source is never
 * changed.
 *
 * Files (relative to migration/execute/):
 *   paths/rebuild/rebuild.sh       the verbs
 *   paths/rebuild/data-sets.csv    workload,source,target,method,exclude (Execute › Settings › Data copy)
 *   paths/rebuild/README.md
 *   ansible/rebuild-copy.yml       one data set: robocopy on a Windows target, rsync on a Linux target
 *   ansible/rebuild-services.yml   start (cutover) or stop (rollback) the application services
 *
 *   prepare    terraform apply of the platform's stack (with -var max_wave=<n>
 *              when the stack declares it), then site.yml for the server
 *   replicate  every data set of the server: robocopy /MIR /COPY:DATSOU
 *              /DCOPY:DAT … on Windows, rsync -aHAX --numeric-ids --delete
 *              --partial on Linux, azcopy / rclone from the controller; the
 *              first run is the seed, and a delta at or under 1 % of the files
 *              or 1 GiB is in sync
 *   test       ansible/validate.yml -e validate_phase=test, when the kit has it
 *   cutover    the final delta copy, then the services started (the wave
 *              orchestrator freezes before and switches DNS after)
 *   rollback   the services stopped on the target; the source never changed
 *
 * Refactor items use this path too; their application deployment runs from
 * the wave's hook directories (finding exec.refactor.hook).
 */

import { error, info, warning,              } from '../../../../core/findings.js';
import { osKind } from '../../os.js';
                                                     
                                               
import { code, shScript } from '../lib-sh.js';
                                                   
                                                                           

export const REBUILD_FILE = 'paths/rebuild/rebuild.sh';
export const DATA_SETS_FILE = 'paths/rebuild/data-sets.csv';
export const COPY_PLAYBOOK = 'ansible/rebuild-copy.yml';
export const SERVICES_PLAYBOOK = 'ansible/rebuild-services.yml';
const PATHS                      = ['rebuild'];

/** The in-sync rule: a delta at or under 1 % of the files, or 1 GiB. */
export const IN_SYNC = Object.freeze({ filesPct: 1, bytes: 1024 ** 3 });
/** The robocopy switches (A.6.10), and rsync's. */
export const ROBOCOPY_SWITCHES                    = Object.freeze(['/MIR', '/COPY:DATSOU', '/DCOPY:DAT', '/MT:32', '/R:2', '/W:5', '/B', '/NP', '/NFL', '/NDL', '/BYTES', '/TEE']);
export const RSYNC_OPTIONS                    = Object.freeze(['-aHAX', '--numeric-ids', '--delete', '--partial', '--stats']);

/** A data-set field the CSV and the scripts cannot carry, or one that holds a credential. */
const BAD_FIELD = /[,"\r\n\t]/;
const CREDENTIAL_IN_PATH = /[?&](sig|sv|se|sp|sas)=|:\/\/[^/\s@]+:[^/\s@]+@/i;

                                                                            

/** The data sets of the rebuilt items, and the rows left out (with why). */
export function dataSetsFor(items                         , sets                           )                                                                             {
  const byName = new Map(items.map((i) => [i.name.toLowerCase(), i]));
  const rows               = [];
  const refused                                            = [];
  for (const s of sets) {
    const item = byName.get(s.workload.trim().toLowerCase());
    if (!item) continue;
    const fields = [s.workload, s.source, s.target, s.exclude ?? ''];
    if (fields.some((f) => BAD_FIELD.test(f))) { refused.push({ row: s, reason: 'a field holds a comma, a quote, a tab or a line break' }); continue; }
    if (fields.some((f) => CREDENTIAL_IN_PATH.test(f))) { refused.push({ row: s, reason: 'a path holds a credential (a SAS token or a user:password@ URL); use the tool\'s own credential chain' }); continue; }
    if (!s.source.trim() || !s.target.trim()) { refused.push({ row: s, reason: 'the source or target path is empty' }); continue; }
    rows.push({ ...s, item: item.id });
  }
  rows.sort((a, b) => a.workload.localeCompare(b.workload) || a.source.localeCompare(b.source));
  return { rows, refused };
}

export function renderDataSetsCsv(rows                       )         {
  return `${['workload,source,target,method,exclude', ...rows.map((r) => [r.workload, r.source, r.target, r.method, r.exclude ?? ''].join(','))].join('\n')}\n`;
}

const FUNCTIONS = code`
REBUILD_DIR="$(cd "$(dirname "$\{BASH_SOURCE[0]}")" && pwd)"
DATA_SETS="$REBUILD_DIR/data-sets.csv"
ANSIBLE_DIR="$ATK_ROOT/ansible"
INVENTORY="$\{ATK_INVENTORY:-$ANSIBLE_DIR/inventory}"
if [[ -z "$\{ANSIBLE_CONFIG:-}" && -f "$ANSIBLE_DIR/ansible.cfg" ]]; then export ANSIBLE_CONFIG="$ANSIBLE_DIR/ansible.cfg"; fi
# ansible-playbook, named through a variable (ATK_ANSIBLE_PLAYBOOK overrides it, for a virtual environment).
ANSIBLE_PLAYBOOK="$\{ATK_ANSIBLE_PLAYBOOK:-ansible-playbook}"
atk_need "$ANSIBLE_PLAYBOOK"
IN_SYNC_FILES_PCT=${IN_SYNC.filesPct}
IN_SYNC_BYTES=${IN_SYNC.bytes}

rebuild_platform() { local t="$\{ATK_TARGET[$1]}"; printf '%s' "$\{t%%:*}"; }

# The inventory name of the rebuilt server (Google Cloud (GCP) lower-cases instance names).
rebuild_host() {
  local n="$\{ATK_NAME[$1]}"
  if [[ "$(rebuild_platform "$1")" == google ]]; then n="$\{n,,}"; n="$\{n//[^a-z0-9-]/-}"; fi
  printf '%s' "$n"
}

# The data sets of an item, one per line: method<TAB>source<TAB>target<TAB>exclude.
rebuild_rows() {
  local name="$\{ATK_NAME[$1],,}" line rest
  local -a lines=() f=()
  [[ -f "$DATA_SETS" ]] || return 0
  mapfile -t lines < "$DATA_SETS"
  for line in "$\{lines[@]:1}"; do
    line="$\{line%$'\r'}"
    [[ -n "$line" ]] || continue
    f=()
    rest="$line,"
    while [[ -n "$rest" ]]; do f+=("$\{rest%%,*}"); rest="$\{rest#*,}"; done
    [[ "$\{f[0],,}" == "$name" ]] || continue
    printf '%s\t%s\t%s\t%s\n' "$\{f[3]:-}" "$\{f[1]:-}" "$\{f[2]:-}" "$\{f[4]:-}"
  done
}

# rebuild_playbook ID PLAYBOOK JSON: a playbook against the rebuilt server.
rebuild_playbook() {
  atk_run "$ANSIBLE_PLAYBOOK" -i "$INVENTORY" "$2" --limit "$(rebuild_host "$1")" -e "$3"
}

# Terraform for the item's platform, once per run and wave.
rebuild_apply() {
  local id="$1" p wave dir key
  p="$(rebuild_platform "$id")"
  wave="$\{ATK_ITEM_WAVE[$id]}"
  dir="$ATK_ROOT/terraform/$p"
  [[ -d "$dir" ]] || atk_fail "$id" "no Terraform stack at terraform/$p: generate the project's Terraform first"
  key="applied:$p:$wave"
  if [[ "$(atk_ids_get rebuild "$key" 2> /dev/null || true)" == "$ATK_RUN_ID" ]]; then return 0; fi
  local -a vars=()
  if grep -qs '^variable "max_wave"' "$dir"/*.tf && [[ "$wave" =~ ^[0-9]+$ ]]; then
    vars=(-var "max_wave=$wave")
  else
    atk_log "terraform/$p declares no max_wave variable: the whole stack is applied"
  fi
  atk_run terraform -chdir="$dir" init -input=false
  atk_run terraform -chdir="$dir" apply -input=false -auto-approve "$\{vars[@]}"
  atk_ids_put rebuild "$key" "$ATK_RUN_ID"
}

# One robocopy or rsync data set; prints "total=N files=N bytes=N" (nothing in a dry run).
rebuild_copy() {
  local id="$1" method="$2" src="$3" dst="$4" exclude="$5" vars out
  vars="$(jq -cn --arg m "$method" --arg s "$src" --arg d "$dst" --arg x "$exclude" --arg n "$(atk_name "$id")" \
    '{copy_method: $m, copy_src: $s, copy_dst: $d, copy_exclude: $x, copy_name: $n}')"
  out="$(rebuild_playbook "$id" "$ATK_HOME/${COPY_PLAYBOOK}" "$vars")" || return 1
  printf '%s\n' "$out" >&2
  if [[ "$out" =~ ATK-COPY\ (total=[0-9]+\ files=[0-9]+\ bytes=[0-9]+) ]]; then printf '%s' "$\{BASH_REMATCH[1]}"; fi
}

# Every data set of the item; sets COPY_ROWS, COPY_TOTAL, COPY_FILES, COPY_BYTES, COPY_MEASURED, COPY_OTHER.
rebuild_copy_all() {
  local id="$1" row method src dst exclude stats
  local -a rows=()
  mapfile -t rows < <(rebuild_rows "$id")
  COPY_ROWS=$\{#rows[@]}; COPY_TOTAL=0; COPY_FILES=0; COPY_BYTES=0; COPY_MEASURED=0; COPY_OTHER=0
  for row in "$\{rows[@]}"; do
    method="$\{row%%$'\t'*}"; row="$\{row#*$'\t'}"
    src="$\{row%%$'\t'*}"; row="$\{row#*$'\t'}"
    dst="$\{row%%$'\t'*}"; exclude="$\{row#*$'\t'}"
    case "$method" in
      robocopy|rsync)
        stats="$(rebuild_copy "$id" "$method" "$src" "$dst" "$exclude")" || atk_fail "$id" "$method of $src failed (see the run log)"
        if [[ "$stats" =~ total=([0-9]+)\ files=([0-9]+)\ bytes=([0-9]+) ]]; then
          COPY_TOTAL=$(( COPY_TOTAL + BASH_REMATCH[1] )); COPY_FILES=$(( COPY_FILES + BASH_REMATCH[2] )); COPY_BYTES=$(( COPY_BYTES + BASH_REMATCH[3] )); COPY_MEASURED=1
        fi ;;
      azcopy)
        atk_need azcopy
        atk_run azcopy sync "$src" "$dst" --recursive --delete-destination=true || atk_fail "$id" "azcopy sync of $src failed (see the run log)"
        COPY_OTHER=$(( COPY_OTHER + 1 )) ;;
      rclone)
        atk_need rclone
        atk_run rclone sync "$src" "$dst" || atk_fail "$id" "rclone sync of $src failed (see the run log)"
        COPY_OTHER=$(( COPY_OTHER + 1 )) ;;
      datasync|storage-mover|storage-transfer)
        atk_log "$method data sets are copied by the file-service pattern, not by this script: $src" ;;
      *) atk_fail "$id" "unknown copy method '$method' in data-sets.csv" ;;
    esac
  done
}

# The application services on the rebuilt server: started or stopped.
rebuild_services() {
  local id="$1" state="$2" vars
  vars="$(atk_item_json "$id" "{atk_services: .services, atk_service_state: \"$state\"}" | jq -c .)"
  if [[ "$(jq -r '.atk_services | length' <<< "$vars")" == 0 ]]; then atk_log "no services recorded for $\{ATK_NAME[$id]}"; return 0; fi
  rebuild_playbook "$id" "$ATK_HOME/${SERVICES_PLAYBOOK}" "$vars"
}

# atk_done, remembering the state for status.
rebuild_done() {
  atk_ids_put rebuild "state:$1" "$2"
  atk_done "$@"
}
`;

const VERBS = {
  prepare: code`
rebuild_apply "$id"
rebuild_playbook "$id" "$ANSIBLE_DIR/site.yml" '{}' || atk_fail "$id" "site.yml failed for this server (see the run log)"
rebuild_done "$id" prepared "built from its image and configured"`,
  replicate: code`
rebuild_copy_all "$id"
(( COPY_ROWS )) || atk_skip "$id" "no data set for this server (Execute > Settings > Data copy): nothing to copy"
if (( ATK_DRY_RUN )); then atk_done "$id" "" "dry run: the copies were printed"; fi
detail="$COPY_FILES of $COPY_TOTAL files, $COPY_BYTES bytes"
if [[ -z "$(atk_ids_get rebuild "seeded:$id" 2> /dev/null || true)" ]]; then
  atk_ids_put rebuild "seeded:$id" yes
  rebuild_done "$id" replicating "seed copy: $detail" files="$COPY_FILES" bytes="$COPY_BYTES"
fi
if (( COPY_MEASURED )) && (( COPY_FILES * 100 > COPY_TOTAL * IN_SYNC_FILES_PCT )) && (( COPY_BYTES > IN_SYNC_BYTES )); then
  rebuild_done "$id" replicating "delta: $detail (in sync at 1% of the files or 1 GiB)" files="$COPY_FILES" bytes="$COPY_BYTES"
fi
rebuild_done "$id" in-sync "delta: $detail" files="$COPY_FILES" bytes="$COPY_BYTES" inSync=true`,
  test: code`
[[ -f "$ATK_HOME/ansible/validate.yml" ]] || atk_skip "$id" "ansible/validate.yml is not in this kit: test the rebuilt server by hand"
rebuild_playbook "$id" "$ATK_HOME/ansible/validate.yml" '{"validate_phase":"test"}' || atk_fail "$id" "validation failed on the rebuilt server (see the run log)"
rebuild_done "$id" testing "validated on the rebuilt server, reached by its own name"`,
  'test-cleanup': `atk_skip "$id" "nothing to clean up: the rebuilt server is the target" tested`,
  cutover: code`
rebuild_copy_all "$id"
rebuild_services "$id" started || atk_fail "$id" "the services did not start on the rebuilt server (see the run log)"
rebuild_done "$id" cut-over "final copy ($COPY_FILES of $COPY_TOTAL files, $COPY_BYTES bytes) and services started" files="$COPY_FILES" bytes="$COPY_BYTES"`,
  commit: `atk_skip "$id" "nothing to commit: the source was never changed"`,
  rollback: code`
rebuild_services "$id" stopped || atk_fail "$id" "the services did not stop on the rebuilt server (see the run log)"
atk_done "$id" "" "the services on the rebuilt server are stopped; the source was never changed (the wave's rollback reverts DNS and unfreezes it)"`,
  finalize: `atk_skip "$id" "nothing to tear down: decommission removes the source"`,
  status: code`
st="$(atk_ids_get rebuild "state:$id" 2> /dev/null || true)"
[[ -n "$st" ]] || atk_skip "$id" "nothing run yet"
atk_done "$id" "$st" "last recorded: $st"`,
};

export function renderRebuildScript()         {
  return shScript({
    file: REBUILD_FILE,
    paths: PATHS,
    summary: 'Rebuild: deploy the target fresh (Terraform, then Ansible), copy the data onto it (robocopy / rsync), start its services at cutover.',
    needs: ['terraform', 'jq'],
    functions: FUNCTIONS,
    verbs: VERBS,
  });
}

const yamlList = (xs                   )         => `[${xs.map((x) => `'${x}'`).join(', ')}]`;

export function renderCopyPlaybook()         {
  return code`---
# Copies one data set onto a rebuilt server; paths/rebuild/rebuild.sh runs it (replicate, cutover) with --limit <server>.
# Windows: robocopy runs on the target and pulls from the source share, as SYSTEM by default (so the target's
#   computer account needs read access to the share; set copy_windows_user, and ansible_become_password from
#   the vault, for another account).
# Linux: rsync runs on the target and pulls from the source over SSH (the source must trust the target's root key).
# The last task reports the size of the copy for the in-sync rule (1% of the files, or 1 GiB).
- name: Copy a data set onto the rebuilt server
  hosts: all
  gather_facts: false
  vars:
    copy_method: rsync
    copy_src: ""
    copy_dst: ""
    copy_exclude: ""
    copy_name: data
    copy_windows_user: SYSTEM
    copy_log: 'C:\Windows\Temp\{{ copy_name }}-copy.log'
    copy_excludes: "{{ copy_exclude | split(';') | map('trim') | select | list }}"
    robocopy_switches: ${yamlList(ROBOCOPY_SWITCHES)}
    robocopy_excludes: "{{ (['/XF'] + copy_excludes + ['/XD'] + copy_excludes) if copy_excludes else [] }}"
    rsync_options: ${yamlList(RSYNC_OPTIONS)}
    rsync_excludes: "{{ copy_excludes | map('regex_replace', '^', '--exclude=') | list }}"
    rsync_paths: "{{ [copy_src | regex_replace('/+$', '') ~ '/', copy_dst | regex_replace('/+$', '') ~ '/'] }}"
  tasks:
    - name: Check the data set
      ansible.builtin.assert:
        that:
          - copy_src | length > 0
          - copy_dst | length > 0
          - copy_method in ['robocopy', 'rsync']
        quiet: true

    - name: Mirror with robocopy
      when: copy_method == 'robocopy'
      ansible.windows.win_command:
        argv: "{{ ['robocopy', copy_src, copy_dst] + robocopy_switches + ['/LOG+:' ~ copy_log] + robocopy_excludes }}"
      register: copy_robocopy
      changed_when: copy_robocopy.rc in [1, 3, 5, 7]
      failed_when: copy_robocopy.rc >= 8
      become: true
      become_method: ansible.builtin.runas
      become_user: "{{ copy_windows_user }}"

    - name: Read the robocopy summary
      when: copy_method == 'robocopy'
      vars:
        files: "{{ copy_robocopy.stdout | regex_findall('Files *: *([0-9]+) +([0-9]+)') | first | default(['0', '0']) }}"
        size: "{{ copy_robocopy.stdout | regex_findall('Bytes *: *([0-9]+) +([0-9]+)') | first | default(['0', '0']) }}"
      ansible.builtin.set_fact:
        copy_counts: "{{ [files[0], files[1]] }}"
        copy_size: "{{ [size[1]] }}"

    - name: Install rsync on the target
      when: copy_method == 'rsync'
      become: true
      ansible.builtin.package:
        name: rsync
        state: present

    - name: Mirror with rsync, pulled from the source over SSH
      when: copy_method == 'rsync'
      become: true
      ansible.builtin.command:
        argv: "{{ ['rsync'] + rsync_options + ['-e', 'ssh'] + rsync_excludes + rsync_paths }}"
      register: copy_rsync
      changed_when: "'Number of regular files transferred: 0' not in copy_rsync.stdout"

    - name: Read the rsync summary
      when: copy_method == 'rsync'
      vars:
        out: "{{ copy_rsync.stdout }}"
        total: "{{ out | regex_findall('Number of files: ([0-9,.]+)') | first | default('0') }}"
        moved: "{{ out | regex_findall('Number of regular files transferred: ([0-9,.]+)') | first | default('0') }}"
        size: "{{ out | regex_findall('Total transferred file size: ([0-9,.]+)') | first | default('0') }}"
      ansible.builtin.set_fact:
        copy_counts: "{{ [total | regex_replace('[,.]', ''), moved | regex_replace('[,.]', '')] }}"
        copy_size: "{{ [size | regex_replace('[,.]', '')] }}"

    - name: Report the size of the copy
      ansible.builtin.debug:
        msg: "ATK-COPY total={{ copy_counts[0] | int }} files={{ copy_counts[1] | int }} bytes={{ copy_size[0] | int }}"
`;
}

export function renderServicesPlaybook()         {
  return code`---
# Starts (cutover) or stops (rollback) the application services on a rebuilt server; paths/rebuild/rebuild.sh runs it
# with --limit <server> and the services the source ran. Services the target does not have are left out.
- name: Start or stop the application services on the rebuilt server
  hosts: all
  gather_facts: true
  vars:
    atk_services: []
    atk_service_state: started
  tasks:
    - name: Linux services
      when: ansible_facts['os_family'] != 'Windows'
      become: true
      block:
        - name: Read the services
          ansible.builtin.service_facts:

        - name: Set the services
          ansible.builtin.service:
            name: "{{ item }}"
            state: "{{ atk_service_state }}"
          loop: "{{ atk_services | select('in', ansible_facts['services'].values() | map(attribute='name') | map('replace', '.service', '') | list) | list }}"

    - name: Windows services
      when: ansible_facts['os_family'] == 'Windows'
      block:
        - name: Read the services
          ansible.windows.win_service_info:
          register: atk_win_services

        - name: Set the services
          ansible.windows.win_service:
            name: "{{ item }}"
            state: "{{ atk_service_state }}"
          loop: "{{ atk_services | select('in', atk_win_services.services | map(attribute='name') | list) | list }}"
`;
}

export function renderRebuildReadme(items                         , rows                       )         {
  return [
    '# Rebuild',
    '',
    `${items.length} server(s) are deployed fresh and their data copied onto them (${rows.length} data set(s) in \`data-sets.csv\`). The source is never changed, so the rollback is to stop the target and point DNS back.`,
    '',
    '## Verbs',
    '',
    '| Verb | What it does |',
    '|---|---|',
    '| `prepare` | `terraform -chdir=terraform/<platform> apply` (with `-var max_wave=<n>` when the stack declares it), then `ansible-playbook site.yml --limit <server>`: baseline, domain join, database install, monitoring. |',
    `| \`replicate\` | Every data set of the server. **robocopy** on a Windows target: \`robocopy <source> <target> ${ROBOCOPY_SWITCHES.join(' ')} /LOG+:<log>\`. **rsync** on a Linux target, pulled from the source: \`rsync ${RSYNC_OPTIONS.join(' ')} -e ssh <source>/ <target>/\`. **azcopy** / **rclone** from the controller, with their own credential chains. AWS DataSync, Azure Storage Mover and Storage Transfer Service rows belong to the file-service pattern. The first run is the seed; a later run that moves at most 1% of the files or 1 GiB is in sync. |`,
    '| `test` | `ansible/validate.yml -e validate_phase=test` against the rebuilt server, reached by its own name (when the kit has it). |',
    '| `cutover` | The final delta copy, then the application services started (the wave orchestrator freezes the source before and switches DNS after). |',
    '| `rollback` | The services on the rebuilt server stopped. The wave\'s rollback reverts DNS and unfreezes the source. |',
    '| `commit`, `finalize`, `test-cleanup` | Nothing to do: recorded as skipped. |',
    '',
    '## Data sets',
    '',
    '`data-sets.csv` comes from Execute › Settings › Data copy: `workload,source,target,method,exclude`, with exclusions separated by `;`. Fields cannot hold commas, and paths never hold credentials: robocopy reads the source share as the target\'s computer account (or `copy_windows_user`), rsync uses SSH keys, azcopy `AZCOPY_AUTO_LOGIN_TYPE`, rclone its configured remotes.',
    '',
    'Refactored applications use this path for everything the kit can generate; their own deployment runs from `hooks/<wave>/pre-cutover.d/` and `post-cutover.d/`.',
    '',
  ].join('\n');
}

const NEEDS                      = Object.freeze([
  { kind: 'command', name: 'terraform', min: '1.9', why: 'rebuild: deploy the target servers', install: 'https://developer.hashicorp.com/terraform/install' },
  { kind: 'command', name: 'ansible', min: '2.16', why: 'rebuild: Ansible configures the servers and copies the data', install: 'python3 -m pip install ansible-core' },
  { kind: 'ansible-collection', name: 'ansible.windows', why: 'rebuild: data copy and services on Windows targets' },
]);

export const REBUILD_GENERATOR                = Object.freeze({
  id: 'rebuild',
  owner: 'WP-11b'         ,
  paths: PATHS,
  needs: NEEDS,
  entry: () => REBUILD_FILE,
  files(items                         , ctx             )                                   {
    const { rows } = dataSetsFor(items, ctx.settings.dataSets);
    return {
      [REBUILD_FILE]: renderRebuildScript(),
      [DATA_SETS_FILE]: renderDataSetsCsv(rows),
      'paths/rebuild/README.md': renderRebuildReadme(items, rows),
      [COPY_PLAYBOOK]: renderCopyPlaybook(),
      [SERVICES_PLAYBOOK]: renderServicesPlaybook(),
    };
  },
  findings(items                         , ctx             )                     {
    const out            = [];
    const { rows, refused } = dataSetsFor(items, ctx.settings.dataSets);
    for (const r of refused) {
      out.push(error('exec.rebuild.data-set-refused', `The data set ${r.row.workload}: ${r.row.source} is left out of data-sets.csv: ${r.reason}.`, { path: 'execution.dataSets', remediation: 'Fix the row under Execute › Settings › Data copy.' }));
    }
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const r of rows) {
      const it = byId.get(r.item);
      const kind = it?.os ? osKind(it.os) : undefined;
      if ((r.method === 'robocopy' && kind === 'linux') || (r.method === 'rsync' && kind === 'windows')) {
        out.push(warning('exec.rebuild.copy-method-os', `${r.workload} runs ${kind === 'linux' ? 'Linux' : 'Windows'}, and its data set ${r.source} uses ${r.method}, which runs on ${r.method === 'robocopy' ? 'Windows' : 'Linux'} targets.`, { path: 'execution.dataSets', remediation: `Use ${r.method === 'robocopy' ? 'rsync' : 'robocopy'} for it.` }));
      }
    }
    const withRows = new Set(rows.map((r) => r.item));
    const without = items.filter((i) => i.kind === 'workload' && !withRows.has(i.id));
    if (without.length) {
      out.push(info('exec.rebuild.no-data-sets', `${without.length} rebuilt server(s) have no data set (${without.slice(0, 5).map((i) => i.name).join(', ')}${without.length > 5 ? ', …' : ''}): replicate records nothing to copy for them.`, { path: 'execution.dataSets' }));
    }
    const refactorApps = [...new Set(items.filter((i) => ctx.decision.items[i.id]?.disposition === 'refactor').map((i) => `${i.app}|${i.wave ?? 'unwaved'}`))].sort();
    for (const key of refactorApps) {
      const [app, wave] = key.split('|');
      out.push(info('exec.refactor.hook', `${app} is refactored: the kit builds its platform and copies its data, and its own deployment runs from hooks/${wave}/pre-cutover.d/ or post-cutover.d/ (the G2 gate needs one there).`, { remediation: 'Put the application team\'s deployment step in the wave\'s hook directory.' }));
    }
    return out;
  },
});

export const GENERATORS                           = Object.freeze([REBUILD_GENERATOR]);
