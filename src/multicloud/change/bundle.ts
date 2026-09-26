/**
 * The change bundle (addendum A.9.1): what one utility run downloads as.
 *
 *   change-<yyyymmdd>-<utility>-<target-slug>/
 *     terraform/ …           a root module on the landing-zone variables contract
 *     ansible/ …             a playbook, the inventory (group atk_change), requirements
 *     scripts/ …             PowerShell tools (VCF PowerCLI), when a step needs one
 *     stack/ …               the plan-managed route: the app stack's files before and after, and the diff
 *     apply.sh               applies by default; --dry-run = terraform plan + ansible-playbook --check --diff
 *     rollback.sh            undoes it (terraform destroy, the stack's old files, the recorded old value …)
 *     expire.sh              only with an expiry: runs rollback.sh on or after the date in change.json
 *     README.md, change.json the inputs (for re-generation), the plan update, the CR's plans
 *     lib/atk.sh (lib/Atk.psm1), manifest/   the execution kit's library and a one-item manifest
 *
 * Every script keeps the execution kit's contract (A.6.2): it sources
 * lib/atk.sh, parses `--dry-run` with `atk_init_tool`, runs every change
 * through `atk_run`, and writes StatusEvents with `path: 'change'` and
 * `item: <change id>` (step `deploy` for the apply, `rollback` for the
 * rollback) to `status/events.jsonl` in the bundle. `contractViolations`
 * checks every script, and a violation is an error finding.
 *
 * Pure: no DOM, no file system, no clock (the date comes from the context).
 */

import { error, type Finding } from '../../core/findings.ts';
import type { BlueprintValues } from '../../kit/blueprint.ts';
import { contractViolations, planId8, shortHash } from '../plan/execute/contract.ts';
import { renderLibPs } from '../plan/execute/lib-ps.ts';
import { code, renderLibSh } from '../plan/execute/lib-sh.ts';
import { PLATFORM_LABELS } from '../plan/options.ts';
import type { ChangeRecord, Plan, Platform } from '../plan/types.ts';
import {
  applyPlanOps, describePlanOp, lzBridge, safeName, shq, val,
  type ChangeRoute, type ChangeStep, type ChangeUtility, type PlanOp, type UtilityContext, type UtilityResult,
} from './utilities/common.ts';

export const CHANGE_KIND = 'archtoolkit.change';
/** A secret's *type* (OCI's password_type = "VAULT_SECRET"), which the credential pattern takes for a literal. */
const NOT_A_CREDENTIAL = /literal credential \("password_type/;
/** The scripts the bundle itself writes (the execution contract applies to them in full). */
const OWN_SCRIPT = /^(apply|rollback|expire|remove-after-\d+-days)\.sh$|^scripts\/[^/]+\.ps1$|^lib\//;

export interface ChangeBundle {
  readonly id: string;
  /** `change-<yyyymmdd>-<utility>-<target-slug>`; every file key starts with it. */
  readonly folder: string;
  readonly utility: string;
  readonly platform: Platform;
  readonly target: string;
  readonly summary: string;
  readonly route: ChangeRoute;
  readonly files: Readonly<Record<string, string>>;
  readonly findings: readonly Finding[];
  /** The utility-log row (key `changes`). */
  readonly record: ChangeRecord;
  /** The plan update, when the utility makes one. */
  readonly planOps: readonly PlanOp[];
  /** The plan with the update made (for the page to save), when there is one. */
  readonly plan?: Plan;
  /** Error findings block the download. */
  readonly blocked: boolean;
}

/** The change date as `YYYYMMDD`. */
function dateOf(ctx: UtilityContext): { iso: string; compact: string } {
  const raw = ctx.date ?? ctx.plan?.savedAt?.slice(0, 10) ?? '1970-01-01';
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '1970-01-01';
  return { iso, compact: iso.replace(/-/g, '') };
}

/** Values with every input's default filled, as strings (for change.json and the log). */
export function valuesOf(u: ChangeUtility, values: BlueprintValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of u.inputs) {
    const v = values[i.id];
    const d = i.default;
    out[i.id] = v === undefined || v === null ? (d === undefined ? '' : String(d)) : String(v);
  }
  for (const [k, v] of Object.entries(values)) if (!(k in out) && v !== undefined) out[k] = String(v);
  return out;
}

const stable = (o: Readonly<Record<string, string>>): string => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

/** `chg-<yyyymmdd>-<hash>`: the same inputs on the same day give the same id. */
export function changeId(utility: string, values: Readonly<Record<string, string>>, ctx: UtilityContext): string {
  return `chg-${dateOf(ctx).compact}-${shortHash(`${utility}|${ctx.plan?.id ?? ''}|${stable(values)}`)}`;
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

interface ScriptModel {
  readonly id: string;
  readonly item: string;
  readonly channel: 'change' | 'deploy';
  readonly utility: ChangeUtility;
  readonly result: UtilityResult;
}

const HELPERS = code`CHANGE_STEP="start"
CHANGE_FAILED_EVENT=0
change_fail_event() {
  if (( CHANGE_FAILED_EVENT )); then return 0; fi
  CHANGE_FAILED_EVENT=1
  atk_event "$CHANGE_ITEM" "$CHANGE_EVENT_STEP" failed "" "$1"
}
change_on_error() {
  local rc=$?
  trap - ERR
  change_fail_event "failed at: $CHANGE_STEP (exit $rc)"
  exit 1
}
change_stop() {
  local code="$1"
  shift
  change_fail_event "$*"
  atk_die "$code" "$*"
}
step() {
  CHANGE_STEP="$1"
  atk_log "step: $1"
}
# change_remember KEY VALUE: keep a value from before the change for rollback.sh, once (a re-run keeps the first).
change_remember() {
  if atk_ids_get change "$CHANGE_ITEM:$1" > /dev/null 2>&1; then return 0; fi
  atk_ids_put change "$CHANGE_ITEM:$1" "$2"
}
# change_recall KEY: the kept value ('' when apply.sh has not run, or ran with --dry-run).
change_recall() { atk_ids_get change "$CHANGE_ITEM:$1" 2> /dev/null || true; }

# The landing zone's variables (the landing_zone_source = variables contract).
tf_bridge() {
  local dir="$CHANGE_HOME/$1"
  if [[ -f "$dir/landing_zone.auto.tfvars.json" ]]; then return 0; fi
  if [[ -n "$\{ATK_LZ_DIR:-}" ]]; then
    atk_need jq
    terraform -chdir="$ATK_LZ_DIR" output -json landing_zone | jq '{landing_zone: .}' > "$dir/landing_zone.auto.tfvars.json"
    return 0
  fi
  change_stop 3 "$1 needs the landing zone: set ATK_LZ_DIR to the landing-zone project's terraform/<platform> folder, or write $1/landing_zone.auto.tfvars.json (see README.md)"
}
tf_apply() {
  local dir="$CHANGE_HOME/$1"
  if [[ "$2" == 1 ]]; then tf_bridge "$1"; fi
  terraform -chdir="$dir" init -input=false -no-color >&2
  if (( ATK_DRY_RUN )); then
    terraform -chdir="$dir" plan -input=false -no-color
  else
    atk_run terraform -chdir="$dir" apply -input=false -auto-approve -no-color
  fi
}
tf_destroy() {
  local dir="$CHANGE_HOME/$1"
  if [[ "$2" == 1 ]]; then tf_bridge "$1"; fi
  terraform -chdir="$dir" init -input=false -no-color >&2
  if (( ATK_DRY_RUN )); then
    terraform -chdir="$dir" plan -destroy -input=false -no-color
  else
    atk_run terraform -chdir="$dir" destroy -input=false -auto-approve -no-color
  fi
}
an_play() {
  local dir="$CHANGE_HOME/$\{2:-ansible}"
  if [[ -f "$dir/requirements.yml" ]]; then (trap - ERR; cd "$dir" && ansible-galaxy collection install -r requirements.yml >&2); fi
  if (( ATK_DRY_RUN )); then
    (trap - ERR; cd "$dir" && ATK_DRY_RUN=0 atk_run ansible-playbook "$1" --check --diff)
  else
    (trap - ERR; cd "$dir" && atk_run ansible-playbook "$1")
  fi
}
ps_tool() {
  local script="$1"
  shift
  local -a args=("$@")
  if (( ATK_DRY_RUN )); then args+=(--dry-run); fi
  atk_pwsh "$script" "$\{args[@]}"
}`;

const STACK_HELPERS = code`
# The plan-managed route: the app stack's own folder (with its state) is $ATK_STACK_DIR.
STACK_DIR=""
stack_dir() {
  STACK_DIR="$\{ATK_STACK_DIR:-}"
  if [[ -z "$STACK_DIR" || ! -d "$STACK_DIR" ]]; then
    change_stop 3 "set ATK_STACK_DIR to the app stack's terraform/<platform> folder (the one holding its state); see README.md"
  fi
}
stack_list() {
  jq -r --arg k "$1" '.[$k][]' "$CHANGE_HOME/stack/files.json"
}
# stack_swap FROM TO: every file the change touches must hold the FROM text (or already the TO text).
stack_swap() {
  local from="$1" to="$2" f
  local -a changed=() added=() removed=()
  mapfile -t changed < <(stack_list changed)
  mapfile -t added < <(stack_list added)
  mapfile -t removed < <(stack_list removed)
  for f in "$\{changed[@]}"; do
    if cmp -s "$CHANGE_HOME/stack/$to/$f" "$STACK_DIR/$f"; then continue; fi
    cmp -s "$CHANGE_HOME/stack/$from/$f" "$STACK_DIR/$f" || change_stop 5 "the stack's $f is not the one this change was made from: regenerate the change from the current plan"
  done
  if [[ "$to" == after ]]; then
    for f in "$\{changed[@]}" "$\{added[@]}"; do
      atk_run mkdir -p "$(dirname "$STACK_DIR/$f")"
      atk_run cp "$CHANGE_HOME/stack/after/$f" "$STACK_DIR/$f"
    done
    for f in "$\{removed[@]}"; do atk_run rm -f "$STACK_DIR/$f"; done
  else
    for f in "$\{changed[@]}" "$\{removed[@]}"; do
      atk_run mkdir -p "$(dirname "$STACK_DIR/$f")"
      atk_run cp "$CHANGE_HOME/stack/before/$f" "$STACK_DIR/$f"
    done
    for f in "$\{added[@]}"; do atk_run rm -f "$STACK_DIR/$f"; done
  fi
}
# stack_apply after|before: with --dry-run, plan in a copy of the stack with the new files (nothing in the stack changes).
stack_apply() {
  local to="$1" from=before tmp f
  if [[ "$to" == before ]]; then from=after; fi
  atk_need jq cmp
  stack_dir
  if (( ATK_DRY_RUN )); then
    tmp="$(mktemp -d)"
    cp -a "$STACK_DIR/." "$tmp/"
    while IFS= read -r f; do mkdir -p "$(dirname "$tmp/$f")"; cp "$CHANGE_HOME/stack/$to/$f" "$tmp/$f"; done < <(stack_list changed; if [[ "$to" == after ]]; then stack_list added; else stack_list removed; fi)
    terraform -chdir="$tmp" init -input=false -no-color >&2
    terraform -chdir="$tmp" plan -lock=false -input=false -no-color
    rm -rf "$tmp"
    return 0
  fi
  stack_swap "$from" "$to"
  terraform -chdir="$STACK_DIR" init -input=false -no-color >&2
  atk_run terraform -chdir="$STACK_DIR" apply -input=false -auto-approve -no-color
}`;

function stepCall(s: ChangeStep, n: number, fns: string[]): string[] {
  const title = `step ${shq(s.title)}`;
  switch (s.kind) {
    case 'terraform': return [title, `tf_apply ${shq(s.dir)} ${s.lz ? 1 : 0}`];
    case 'terraform-destroy': return [title, `tf_destroy ${shq(s.dir)} ${s.lz ? 1 : 0}`];
    case 'ansible': return [title, `an_play ${shq(s.playbook)}${s.dir ? ` ${shq(s.dir)}` : ''}`];
    case 'stack': return [title, `stack_apply ${s.direction === 'apply' ? 'after' : 'before'}`];
    case 'pwsh': return [title, `ps_tool ${[s.file, ...(s.args ?? [])].map(shq).join(' ')}`];
    case 'manual': return [title, `atk_log ${shq(`by hand: ${s.text}`)}`];
    case 'sh': {
      const fn = `change_step_${n}`;
      fns.push(`${fn}() {\n${s.body.trim().split('\n').map((l) => (l.trim() ? `  ${l}` : '')).join('\n')}\n}`);
      return [title, fn];
    }
    default: return [];
  }
}

function script(m: ScriptModel, which: 'apply' | 'rollback'): string {
  const r = m.result;
  const steps = which === 'apply' ? r.apply : r.rollback;
  const validate = which === 'apply' ? (r.validate ?? []) : [];
  const fns: string[] = [];
  const calls: string[] = [];
  steps.forEach((s, i) => calls.push(...stepCall(s, i + 1, fns)));
  const vcalls: string[] = [];
  validate.forEach((s, i) => vcalls.push(...stepCall(s, 100 + i, fns)));
  const all = [...steps, ...validate];
  const needs = new Set<string>(r.needs);
  if (all.some((s) => s.kind === 'terraform' || s.kind === 'terraform-destroy' || s.kind === 'stack')) needs.add('terraform');
  if (all.some((s) => s.kind === 'ansible')) { needs.add('ansible-playbook'); needs.add('ansible-galaxy'); }
  if (all.some((s) => s.kind === 'stack')) { needs.add('jq'); needs.add('cmp'); }
  if (all.some((s) => s.kind === 'pwsh')) needs.add('pwsh');
  const eventStep = which === 'apply' ? 'deploy' : 'rollback';
  const detail = which === 'apply' ? r.summary : `rolled back: ${r.summary}`;
  const data = `utility=${shq(m.utility.id)} platform=${r.platform} route=${r.route}`;
  const verb = which === 'apply' ? 'Applies' : 'Rolls back';
  return `#!/usr/bin/env bash
# ${which}.sh: ${verb} "${m.utility.label}" on ${PLATFORM_LABELS[r.platform]}: ${r.summary.replace(/\n/g, ' ')}
# Changes are made by default. --dry-run runs terraform plan and ansible-playbook --check --diff, and prints
# every other change instead of making it. Events: status/events.jsonl (path ${m.channel}, item ${m.item}).
# Exit codes: 0 done, 1 a step failed, 2 usage, 3 a tool, credential or input is missing, 5 a pre-check failed.
set -Eeuo pipefail
CHANGE_HOME="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export ATK_ROOT="\${ATK_ROOT:-$CHANGE_HOME}"
source "$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/lib/atk.sh"
atk_init_tool ${m.channel} "$@"
${needs.size ? `atk_need ${[...needs].sort().join(' ')}\n` : ''}atk_lock ${m.id}
CHANGE_ITEM=${shq(m.item)}
CHANGE_EVENT_STEP=${eventStep}

${HELPERS}
${all.some((s) => s.kind === 'stack') ? `${STACK_HELPERS}\n` : ''}${fns.length ? `\n${fns.join('\n\n')}\n` : ''}
trap change_on_error ERR
atk_event "$CHANGE_ITEM" ${eventStep} started "" ${shq(detail)} ${data}
${calls.join('\n')}
atk_event "$CHANGE_ITEM" ${eventStep} succeeded "" ${shq(detail)} ${data}
${vcalls.length ? `CHANGE_EVENT_STEP=validate
CHANGE_FAILED_EVENT=0
atk_event "$CHANGE_ITEM" validate started "" ${shq(`validate: ${r.summary}`)} ${data}
${vcalls.join('\n')}
atk_event "$CHANGE_ITEM" validate succeeded "" ${shq(`validate: ${r.summary}`)} ${data}
` : ''}trap - ERR
atk_log ${shq(which === 'apply' ? 'applied; rollback.sh undoes it' : 'rolled back')}
`;
}

function expireScript(m: ScriptModel): string {
  return `#!/usr/bin/env bash
# expire.sh: runs rollback.sh on or after the expiry in change.json (run it daily, for example from cron).
# --dry-run is passed on to rollback.sh.
set -Eeuo pipefail
CHANGE_HOME="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export ATK_ROOT="\${ATK_ROOT:-$CHANGE_HOME}"
source "$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/lib/atk.sh"
atk_init_tool ${m.channel} "$@"
atk_need jq date
expires="$(jq -r '.expires // empty' "$CHANGE_HOME/change.json")"
today="$(date -u +%F)"
if [[ -z "$expires" || "$today" < "$expires" ]]; then
  atk_log "not expired yet (expires $\{expires:-never})"
  exit 0
fi
args=()
if (( ATK_DRY_RUN )); then args+=(--dry-run); fi
atk_log "expired on $expires: rolling back"
"$CHANGE_HOME/rollback.sh" "\${args[@]}"
`;
}

// ---------------------------------------------------------------------------
// README, change.json, manifest
// ---------------------------------------------------------------------------

function stepLine(s: ChangeStep): string {
  switch (s.kind) {
    case 'terraform': return `${s.title} (\`terraform apply\` in \`${s.dir}/\`)`;
    case 'terraform-destroy': return `${s.title} (\`terraform destroy\` in \`${s.dir}/\`)`;
    case 'ansible': return `${s.title} (\`ansible-playbook ${s.playbook}\`)`;
    case 'stack': return `${s.title} (the files in \`stack/${s.direction === 'apply' ? 'after' : 'before'}/\` into \`$ATK_STACK_DIR\`, then \`terraform apply\` there)`;
    case 'pwsh': return `${s.title} (\`${s.file}\`)`;
    case 'manual': return `${s.title}: ${s.text}`;
    default: return s.title;
  }
}

function readme(m: ScriptModel, folder: string, files: Readonly<Record<string, string>>, ops: readonly PlanOp[]): string {
  const r = m.result;
  const u = m.utility;
  const lzDirs = [...new Set([...r.apply, ...r.rollback].filter((s) => (s.kind === 'terraform' || s.kind === 'terraform-destroy') && s.lz).map((s) => (s as { dir: string }).dir))];
  const stack = [...r.apply, ...r.rollback].some((s) => s.kind === 'stack');
  const pwsh = [...r.apply, ...r.rollback].some((s) => s.kind === 'pwsh');
  const secrets = Object.entries(files)
    .filter(([f]) => f.endsWith('variables.tf'))
    .flatMap(([, t]) => [...t.matchAll(/variable "([a-z0-9_]+)" \{[^}]*sensitive\s+=\s+true/g)].map((x) => x[1]!));
  const lines = [
    `# ${u.label}: ${r.target}`,
    '',
    `${r.summary}`,
    '',
    `- Change: \`${m.id}\` (${u.label}, ${PLATFORM_LABELS[r.platform]}).`,
    `- Route: ${ROUTE_TEXT[r.route]}.`,
    `- Risk: ${u.risk}. ${u.reversible ? 'Reversible' : 'Not fully reversible'}: ${u.rollback}`,
    ...(r.expires ? [`- Expires: ${r.expires}. \`expire.sh\` (run it daily, e.g. \`0 6 * * * ${folder}/expire.sh\`) rolls the change back on or after that day.`] : []),
    '',
    '## Run it',
    '',
    '```sh',
    './apply.sh --dry-run   # terraform plan, ansible-playbook --check --diff, every other change printed',
    './apply.sh             # makes the change',
    './rollback.sh          # undoes it',
    '```',
    '',
    `Both write status events (\`path: ${m.channel}\`, \`item: ${m.item}\`) to \`status/events.jsonl\`; import that file on the Utilities log (Migration & Utilities) to record when the change was applied and rolled back. A run holds a lock, and logs to \`status/logs/\` with credentials redacted.`,
    '',
    '## What apply.sh does',
    '',
    ...r.apply.map((s, i) => `${i + 1}. ${stepLine(s)}`),
    ...((r.validate ?? []).length ? ['', 'Then it validates:', '', ...(r.validate ?? []).map((s, i) => `${i + 1}. ${stepLine(s)}`)] : []),
    '',
    '## What rollback.sh does',
    '',
    ...r.rollback.map((s, i) => `${i + 1}. ${stepLine(s)}`),
    '',
  ];
  if (ops.length) {
    lines.push('## The plan update', '', 'Saving this change on the page updates the plan (rolling it back on the page reverts it):', '', ...ops.map((o) => `- ${describePlanOp(o)}`), '');
  }
  if (stack) {
    lines.push(
      '## The app stack',
      '',
      'The target is managed by an app stack, so the change is made in that stack\'s Terraform instead of around it. `stack/stack.diff` is the change to the stack; `stack/after/` and `stack/before/` hold the files it touches.',
      '',
      'Point `ATK_STACK_DIR` at the app stack\'s `terraform/<platform>` folder (the one holding its state or backend) before running the scripts. apply.sh checks every file still holds what the change was made from, puts the new ones in, and applies; with `--dry-run` it plans a copy and changes nothing.',
      '',
    );
  }
  if (lzDirs.length) {
    lines.push(
      '## The landing zone',
      '',
      'The Terraform here builds in an existing landing zone (`var.landing_zone`, the landing-zone variables contract); nothing in it is a pasted id. Bring the landing zone in once, before the first run, with the one-line bridge:',
      '',
      '```sh',
      ...lzDirs.map((d) => lzBridge(r.platform, d)),
      '```',
      '',
      'or set `ATK_LZ_DIR` to the landing-zone project\'s `terraform/<platform>` folder and the scripts do it. `landing_zone.auto.tfvars.json.example` shows the shape.',
      '',
    );
  }
  lines.push('## Credentials', '', 'Nothing in this bundle holds a credential.', '');
  lines.push(...CREDENTIAL_LINES[r.platform]);
  if (secrets.length) lines.push(`- Terraform's sensitive variables: ${[...new Set(secrets)].sort().map((s) => `\`TF_VAR_${s}\``).join(', ')}.`);
  if (pwsh) lines.push('- VCF PowerCLI (VCF.PowerCLI module): `VC_SERVER`, `VC_USER`, and the password from `VC_PASSWORD`, `VC_PASSWORD_FILE` (mode 600) or `ATK_VAULT_CMD`.');
  if (Object.keys(files).some((f) => f.startsWith('ansible/'))) lines.push('- Ansible: SSH keys from your agent; Windows over WinRM with Kerberos; `vault_*` variables from ansible-vault (`--ask-vault-pass` or `ANSIBLE_VAULT_PASSWORD_FILE`).');
  lines.push('');
  if (r.notes?.length) lines.push('## Notes', '', ...r.notes.map((n) => `- ${n}`), '');
  lines.push('## Change request', '', 'Implementation plan: the apply.sh steps above. Backout plan: the rollback.sh steps above. Test plan: `./apply.sh --dry-run` first, then the checks the steps run.', '');
  return lines.join('\n');
}

const ROUTE_TEXT: Readonly<Record<ChangeRoute, string>> = {
  plan: 'through the plan (a plan update and the app stack\'s diff)',
  terraform: 'Terraform in the landing zone (its own root module and state)',
  ansible: 'Ansible on the target',
  cli: 'the platform\'s own CLI (a target outside Terraform)',
  mixed: 'Terraform and Ansible, or the CLI where Terraform does not manage it',
  manual: 'by hand (the README lists the steps)',
};

const CREDENTIAL_LINES: Readonly<Record<Platform, readonly string[]>> = {
  aws: ['- AWS: the CLI\'s and Terraform\'s own chain (`AWS_PROFILE`, SSO or an instance role).'],
  azure: ['- Azure: `az login` (or a managed identity); Terraform reads the same sign-in.'],
  google: ['- Google Cloud (GCP): `gcloud auth login` and `gcloud auth application-default login` (or a service account through workload identity).'],
  oci: ['- OCI: the CLI config (`~/.oci/config`) or instance principals (`OCI_CLI_AUTH=instance_principal`).'],
  vmware: ['- VCF: `TF_VAR_vsphere_user` and `TF_VAR_vsphere_password` for Terraform (NSX: `TF_VAR_nsx_username` / `TF_VAR_nsx_password`).'],
};

function changeJson(m: ScriptModel, values: Readonly<Record<string, string>>, ctx: UtilityContext, ops: readonly PlanOp[]): string {
  const r = m.result;
  return `${JSON.stringify({
    kind: CHANGE_KIND,
    v: 1,
    id: m.id,
    utility: m.utility.id,
    label: m.utility.label,
    platform: r.platform,
    target: r.target,
    summary: r.summary,
    route: r.route,
    risk: m.utility.risk,
    reversible: m.utility.reversible,
    planId: ctx.plan?.id ?? null,
    channel: m.channel,
    item: m.item,
    ...(r.expires ? { expires: r.expires } : {}),
    values,
    planUpdate: ops,
    changeRequest: {
      implementation: r.apply.map(stepLine),
      backout: r.rollback.map(stepLine),
      test: [...(r.validate ?? []).map(stepLine), './apply.sh --dry-run'],
    },
  }, null, 2)}\n`;
}

function manifest(m: ScriptModel, planId: string, pwsh: boolean): Record<string, string> {
  const r = m.result;
  const cell = (s: string): string => s.replace(/[\t\r\n]+/g, ' ');
  const row = [m.item, r.target, m.channel === 'deploy' ? 'app-deploy' : 'change', m.utility.id, '', m.channel, 'apply.sh', safeName(`${m.utility.id}-${r.target}`, 63), '', r.platform].map(cell);
  const files: Record<string, string> = {
    'manifest/items.tsv': `#plan\t${cell(planId)}\t${planId8(planId)}\n#id\tname\tkind\tapp\twave\tpath\tscript\tresource\tsource\ttarget\n${row.join('\t')}\n`,
  };
  if (pwsh) {
    files['manifest/items.json'] = `${JSON.stringify({ planId, planId8: planId8(planId), items: [{ id: m.item, name: r.target, kind: row[2], app: m.utility.id, wave: null, path: m.channel, script: 'apply.sh', resource: row[7], target: { platform: r.platform } }] }, null, 2)}\n`;
  }
  return files;
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/** Build one utility's change bundle. */
export function buildChangeBundle(u: ChangeUtility, values: BlueprintValues, ctx: UtilityContext = {}): ChangeBundle {
  const all = valuesOf(u, values);
  const result = u.build(all, ctx);
  const id = changeId(u.id, all, ctx);
  const channel = result.channel ?? 'change';
  const m: ScriptModel = { id, item: result.item ?? id, channel, utility: u, result };
  const date = dateOf(ctx);
  const folder = `change-${date.compact}-${u.id}-${safeName(result.target, 40)}`;
  const findings: Finding[] = [...result.findings];
  const planId = ctx.plan?.id ?? 'no-plan';
  const allSteps = [...result.apply, ...result.rollback, ...(result.validate ?? [])];
  const pwsh = allSteps.some((s) => s.kind === 'pwsh');
  const inner: Record<string, string> = {
    ...result.files,
    'lib/atk.sh': renderLibSh(),
    ...(pwsh ? { 'lib/Atk.psm1': renderLibPs() } : {}),
    ...manifest(m, planId, pwsh),
    'apply.sh': script(m, 'apply'),
    'rollback.sh': script(m, 'rollback'),
    ...(result.expires ? { 'expire.sh': expireScript(m) } : {}),
  };
  const ops = result.planOps ?? [];
  inner['change.json'] = changeJson(m, all, ctx, ops);
  inner['README.md'] = readme(m, folder, inner, ops);

  for (const [f, text] of Object.entries(inner)) {
    // The bundle's own scripts keep the whole contract; other files (a generated app stack, a CI pipeline's
    // scripts) are checked for credentials and footprints only.
    const own = OWN_SCRIPT.test(f);
    const name = own ? f : `${f}.data`;
    for (const v of contractViolations(name, text)) {
      if (!own && NOT_A_CREDENTIAL.test(v)) continue;
      findings.push(error('change.contract', own ? v : v.replace(`${f}.data`, f), { path: `${folder}/${f}` }));
    }
  }
  if (result.apply.length === 0) findings.push(error('change.no-steps', 'The change has nothing to apply.'));
  if (result.rollback.length === 0) findings.push(error('change.no-rollback', 'The change has no rollback.'));

  const files: Record<string, string> = {};
  for (const k of Object.keys(inner).sort()) files[`${folder}/${k}`] = inner[k]!;
  const record: ChangeRecord = {
    id,
    utility: u.id,
    target: result.target,
    summary: result.summary,
    values: all,
    generatedAt: ctx.now ?? `${date.iso}T00:00:00.000Z`,
  };
  return {
    id, folder, utility: u.id, platform: result.platform, target: result.target, summary: result.summary, route: result.route,
    files, findings, record, planOps: ops,
    ...(ops.length && ctx.plan ? { plan: applyPlanOps(ctx.plan, ops) } : {}),
    blocked: findings.some((f) => f.severity === 'error'),
  };
}

/** The bundle's scripts and their contract violations (for tests and the page's check). */
export function bundleViolations(bundle: Pick<ChangeBundle, 'files' | 'folder'>): string[] {
  return Object.entries(bundle.files).flatMap(([f, t]) => {
    const rel = f.slice(bundle.folder.length + 1);
    return OWN_SCRIPT.test(rel) ? contractViolations(f, t) : contractViolations(`${f}.data`, t).filter((v) => !NOT_A_CREDENTIAL.test(v));
  });
}

export { val };
