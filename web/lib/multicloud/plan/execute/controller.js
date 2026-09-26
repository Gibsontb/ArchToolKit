/**
 * The migration controller's check (`controller-check.sh`) and the kit's
 * `README.md` (addendum A.6.2).
 *
 * `controller-check.sh` checks every tool, PowerShell module and Ansible
 * collection the plan's paths need, and exits 3 naming what is missing. The
 * README gives the prerequisites, the credential variables and vault hooks,
 * the verbs, options and exit codes, the paths in this kit with their
 * scripts, and the warnings (no automatic fallback, retired tools, paths
 * whose generator is not installed).
 */

                                                         
import { EXECUTION_METHOD_OPTIONS, labelOf, METHOD_OF_PATH } from '../options.js';
import { ARGUMENTS, EXIT_CODES, EXIT_MEANINGS, VERB_LABELS, VERBS,                              } from './contract.js';
import { code } from './lib-sh.js';
import { pathLabel } from './paths.js';
                                                         

/** What every kit needs, whatever its paths. */
export const BASE_NEEDS                      = Object.freeze([
  { kind: 'command', name: 'bash', min: '4.4', why: 'every script and the library' },
  { kind: 'command', name: 'awk', why: 'log redaction' },
  { kind: 'command', name: 'od', why: 'run ids' },
  { kind: 'command', name: 'mktemp', why: 'runtime files' },
  { kind: 'command', name: 'date', why: 'event times' },
  { kind: 'command', name: 'jq', min: '1.6', why: 'reading CLI output, the id cache', install: 'dnf install jq / apt install jq / brew install jq' },
]);
export const PWSH_NEED           = Object.freeze({ kind: 'command', name: 'pwsh', min: '7.4', why: 'the PowerShell path scripts', install: 'https://learn.microsoft.com/powershell/scripting/install/installing-powershell' });

/** One need per name and kind, in a stable order. */
export function mergeNeeds(needs                     )             {
  const out = new Map                  ();
  for (const n of needs) {
    const key = `${n.kind}:${n.name}`;
    const had = out.get(key);
    out.set(key, had ? { ...had, why: had.why.includes(n.why) ? had.why : `${had.why}; ${n.why}` } : n);
  }
  const order                                             = { command: 0, 'pwsh-module': 1, 'ansible-collection': 2, 'python-module': 3 };
  return [...out.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

const shq = (s        )         => `'${s.replace(/'/g, `'\\''`)}'`;

/** The text of `controller-check.sh`. */
export function renderControllerCheck(needs                     )         {
  const lines = mergeNeeds(needs).map((n) => {
    switch (n.kind) {
      case 'command': return `check_command ${shq(n.name)} ${shq(n.why)}${n.install ? ` ${shq(n.install)}` : ''}`;
      case 'pwsh-module': return `check_pwsh_module ${shq(n.name)} ${shq(n.why)}`;
      case 'ansible-collection': return `check_collection ${shq(n.name)} ${shq(n.why)}`;
      case 'python-module': return `check_python_module ${shq(n.name)} ${shq(n.why)}`;
    }
  });
  return code`#!/usr/bin/env bash
# Checks that this controller has every tool, PowerShell module and Ansible collection the kit's paths need.
# Read-only (--dry-run is accepted and changes nothing). Exit 0 when all are present, ${EXIT_CODES.missing} naming what is missing.
set -Eeuo pipefail
source "$(cd "$(dirname "$\{BASH_SOURCE[0]}")" && pwd)/lib/atk.sh"
atk_init_tool orchestrator "$@"

missing=()
check_command() {
  if command -v "$1" > /dev/null 2>&1; then atk_log "ok: $1"; else missing+=("$1 ($2)$\{3:+: $3}"); fi
}
check_pwsh_module() {
  if command -v pwsh > /dev/null 2>&1 && pwsh -NoProfile -NonInteractive -Command "if (Get-Module -ListAvailable -Name '$1') { exit 0 } else { exit 1 }" > /dev/null 2>&1; then
    atk_log "ok: PowerShell module $1"
  else
    missing+=("PowerShell module $1 ($2): Install-PSResource $1")
  fi
}
check_collection() {
  if command -v ansible-galaxy > /dev/null 2>&1 && ansible-galaxy collection list "$1" 2> /dev/null | grep -q "^$1 "; then
    atk_log "ok: Ansible collection $1"
  else
    missing+=("Ansible collection $1 ($2): ansible-galaxy collection install $1")
  fi
}
check_python_module() {
  if command -v python3 > /dev/null 2>&1 && python3 -c "import $1" > /dev/null 2>&1; then atk_log "ok: Python module $1"; else missing+=("Python module $1 ($2)"); fi
}

atk_event - precheck started
if ! command -v flock > /dev/null 2>&1; then atk_log "note: flock is not installed; the library falls back to lock directories"; fi
${lines.join('\n')}

if (( $\{#missing[@]} )); then
  for m in "$\{missing[@]}"; do atk_log "missing: $m"; done
  atk_event - precheck failed "" "$\{#missing[@]} tools or modules are missing on the controller" missing="$\{#missing[@]}"
  exit ${EXIT_CODES.missing}
fi
atk_event - precheck succeeded "" "the controller has every tool the kit needs"
`;
}

                             
                          
                         
                          
                            
                            
 
                              
                                        
                                      
                                        
                                    
                          
 

const VAULT_LINES                                         = [
  ['HashiCorp Vault', "export ATK_VAULT_CMD='vault kv get -field=value secret/migration/%s'"],
  ['Azure Key Vault (secret names use hyphens, so map NAME to the secret)', "export ATK_VAULT_CMD='az keyvault secret show --vault-name <vault> --name %s --query value -o tsv'"],
  ['AWS Secrets Manager', "export ATK_VAULT_CMD='aws secretsmanager get-secret-value --secret-id migration/%s --query SecretString --output text'"],
  ['Google Cloud (GCP) Secret Manager', "export ATK_VAULT_CMD='gcloud secrets versions access latest --secret=%s'"],
  ['OCI Vault', "export ATK_VAULT_CMD='oci secrets secret-bundle get-secret-bundle-by-name --vault-id <vault-ocid> --secret-name %s --query \"data.\\\"secret-bundle-content\\\".content\" --raw-output | base64 -d'"],
];

const table = (head                   , rows                                )         =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

/** The text of the kit's `README.md`. */
export function renderReadme(input             )         {
  const needs = mergeNeeds(input.needs);
  const kindLabel                                             = { command: 'Command', 'pwsh-module': 'PowerShell module', 'ansible-collection': 'Ansible collection', 'python-module': 'Python module' };
  const pathRows = [...input.paths].sort((a, b) => a.path.localeCompare(b.path)).map((p) => [
    `\`${p.path}\``, pathLabel(p.path), labelOf(EXECUTION_METHOD_OPTIONS, METHOD_OF_PATH[p.path]), String(p.items), `\`${p.script}\``,
    p.pending ? `not generated yet (${p.owner})` : p.owner,
  ]);
  const warn = input.warnings.filter((f) => f.severity !== 'info');
  const pending = input.paths.filter((p) => p.pending);
  const exitRows = (Object.keys(EXIT_CODES)              ).map((k) => [String(EXIT_CODES[k]), EXIT_MEANINGS[k]]);
  const example = input.paths.find((p) => !p.pending) ?? input.paths[0];
  const wave = input.waves[0] ?? 1;
  return [
    '# Migration execution kit',
    '',
    'Replication and cutover automation for this plan, one script family per move path. Run it from one Linux host, the migration controller, that reaches the sources, the targets, the cloud APIs and the DNS APIs.',
    '',
    '**Every script makes its changes when run.** `--dry-run` (`-DryRun` in PowerShell) prints each change instead of making it; read-only calls still run, so a dry run shows the real current state. There is no `--yes` and no prompt. Every verb is idempotent: it reads the current state first and records `skipped` when the item is already there, so a re-run after a failure resumes.',
    '',
    '## Order of operations',
    '',
    '1. `./controller-check.sh`: checks the tools below; exit 3 names what is missing.',
    '2. Set the credentials (below) in the environment or the vault hook.',
    '3. Per wave, run each path script with the verbs in order: `prepare`, `replicate` (poll with `status --once`), `test`, `test-cleanup`, then in the window `cutover`, and after acceptance `commit` and `finalize`. `rollback` undoes a cutover. The wave orchestrators (`waves/wave-<n>/`) run the same verbs across every path, with the gates.',
    `4. Import \`status/events.jsonl\` into the tracker (Migration & Utilities › Track).`,
    '',
    example ? `For example: \`${example.script.endsWith('.ps1') ? `pwsh -NoProfile -File ${example.script} prepare -Wave ${wave} -DryRun` : `./${example.script} prepare --wave ${wave} --dry-run`}\`.` : '',
    '',
    '## Verbs',
    '',
    table(['Verb', 'What it does'], VERBS.map((v) => [`\`${v}\``, VERB_LABELS[v]])),
    '',
    '## Options',
    '',
    table(['Bash', 'PowerShell', 'Meaning'], ARGUMENTS.map((a) => [`\`${a.flag}${a.value ? ' ' + (a.value === 'number' ? 'N' : 'TEXT') : ''}\``, `\`${a.ps}\``, a.help])),
    '',
    '## Exit codes',
    '',
    table(['Code', 'Meaning'], exitRows),
    '',
    '## Credentials',
    '',
    'No credential is written in this kit. A script asks for one by name (`atk_secret NAME` / `Get-AtkSecret NAME`) and takes, in order:',
    '',
    '1. the environment variable `NAME`;',
    '2. the contents of the file named by `NAME_FILE`, which must be readable by its owner only (mode 600), or the script exits 3;',
    '3. the output of `$ATK_VAULT_CMD NAME` (`%s` in the command is replaced by the name).',
    '',
    ...VAULT_LINES.flatMap(([what, line]) => [`${what}:`, '', '```sh', line, '```', '']),
    'Cloud CLIs use their own credential chains: an AWS profile or instance role; `Connect-AzAccount -Identity` or a service principal with a federated token (`AZURE_FEDERATED_TOKEN_FILE`); `gcloud` application default credentials; `OCI_CLI_AUTH=instance_principal` or the OCI config. Secrets reach tools on stdin or in the environment, never as arguments; where a tool insists on a file, it is created with mode 600 in `$XDG_RUNTIME_DIR` (or `/dev/shm`) and removed on exit. Logs redact every value a script read as a credential.',
    '',
    '## Status',
    '',
    'Every step appends one JSON line to `status/events.jsonl` (the schema is `status.schema.json`, kind `archtoolkit.migration-status`): the plan, the run, the time, the wave, the item, the path, the step, the outcome and whether it was a dry run. Events carry no user, host or path. Logs go to `status/logs/<run>.log`; ids the tools return are cached in `status/ids/<path>.json`, which can always be rebuilt by name. Resources the kit creates are named `atk-<plan>-<wave>-<item>` and found by that name. Gate files the tracker exports go in `status/gates/`.',
    '',
    '## Paths in this kit',
    '',
    input.paths.length ? table(['Path', 'Move', 'Method', 'Items', 'Script', 'From'], pathRows) : 'No item in this plan has a move path.',
    '',
    ...(warn.length ? ['## Warnings', '', ...warn.map((f) => `- ${f.message}${f.remediation ? ` ${f.remediation}` : ''}${f.source ? ` (${f.source})` : ''}`), ''] : []),
    ...(pending.length ? ['## Not generated yet', '', `These paths have no generator in this kit, so their script (\`paths/pending/pending.sh\`) fails every verb and says so: ${pending.map((p) => `\`${p.path}\``).join(', ')}. Move those items by hand and record the transitions in the tracker, or regenerate the kit when the generators are installed.`, ''] : []),
    '## Controller prerequisites',
    '',
    table(['Kind', 'Name', 'Minimum', 'Why'], needs.map((n) => [kindLabel[n.kind], `\`${n.name}\``, n.min ?? '', n.why])),
    '',
    input.hasPs ? 'PowerShell scripts are run with `pwsh -NoProfile -File`; from bash, `atk_pwsh` passes the options (`--dry-run` becomes `-DryRun`).\n' : '',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}
