/**
 * The execution kit's script contract (addendum A.6.2), as data and checks.
 *
 * Every script the kit generates — the core's and every path generator's
 * (WP-11b/c/d, WP-17) — keeps one contract:
 *
 *   1. it applies by default; `--dry-run` (`-DryRun`) is opt-in, and there is
 *      no `--yes`, no prompt and no "first run only prints" mode;
 *   2. it is idempotent: every mutating step reads the current state first and
 *      writes a `skipped` event when the item is already there;
 *   3. credentials come from the environment, a `NAME_FILE` of mode 600 or the
 *      `ATK_VAULT_CMD` hook, never from a file the kit writes;
 *   4. it writes `StatusEvent` lines (types.ts) to `status/events.jsonl`;
 *   5. it has a `rollback` verb;
 *   6. one set of verbs and arguments, 7. one set of exit codes;
 *   8. a lock per wave and a redacted log per run; 9. no footprints.
 *
 * The libraries (`lib-sh.ts`, `lib-ps.ts`) enforce it at run time; this file
 * holds the constants they are rendered from and `contractViolations`, the
 * static check every package's tests run over its generated scripts.
 *
 * Pure: no DOM, no file system.
 */

import { slugName } from '../options.ts';
import type { DbMovePath, MovePath, StatusChannel, StepId } from '../types.ts';

/** A move path of either kind: what a path generator implements. */
export type ExecPath = MovePath | DbMovePath;
/** Every value a StatusEvent's `path` can hold. */
export type EventPath = ExecPath | StatusChannel;

/** Where the kit lives in a generated project; every kit file key is relative to it. */
export const EXECUTE_DIR = 'migration/execute';
/** Run-time status, relative to the project root (created by the scripts, never generated). */
export const STATUS_DIR = 'status';
export const EVENTS_FILE = 'status/events.jsonl';

// ---------------------------------------------------------------------------
// Verbs, arguments, exit codes
// ---------------------------------------------------------------------------

export type Verb = 'prepare' | 'replicate' | 'test' | 'test-cleanup' | 'cutover' | 'commit' | 'rollback' | 'finalize' | 'status';
export const VERBS: readonly Verb[] = Object.freeze(['prepare', 'replicate', 'test', 'test-cleanup', 'cutover', 'commit', 'rollback', 'finalize', 'status']);
export const VERB_LABELS: Readonly<Record<Verb, string>> = Object.freeze({
  prepare: 'Prepare the source and the target (agents, appliances, discovery, target build)',
  replicate: 'Start or continue replication',
  test: 'Launch a test copy on the test network',
  'test-cleanup': 'Remove the test copy and record the test result',
  cutover: 'Cut over: final sync, switch to the target',
  commit: 'Commit (point of no return: finalize replication, keep the reverse path)',
  rollback: 'Roll back to the source (stops the target, keeps it for analysis)',
  finalize: 'Finalize: tear down replication and the tool’s leftovers',
  status: 'Report replication state (with --once: poll once and exit)',
});
/**
 * The step each verb reports as. `status` reports as `replicate` with
 * `data.poll = true` (and `data.inSync` when known), because the tracker's
 * transition table (A.8.2) reads replication progress from `replicate`.
 */
export const VERB_STEP: Readonly<Record<Verb, StepId>> = Object.freeze({
  prepare: 'prepare', replicate: 'replicate', test: 'test', 'test-cleanup': 'test-cleanup', cutover: 'cutover',
  commit: 'commit', rollback: 'rollback', finalize: 'finalize', status: 'replicate',
});

export interface ArgumentSpec {
  /** The bash spelling. */
  readonly flag: string;
  /** The PowerShell parameter. */
  readonly ps: string;
  /** Takes a value; `repeatable` may be given more than once. */
  readonly value?: 'number' | 'text';
  readonly repeatable?: boolean;
  readonly help: string;
}
export const ARGUMENTS: readonly ArgumentSpec[] = Object.freeze([
  { flag: '--wave', ps: '-Wave', value: 'number', help: 'The wave to act on.' },
  { flag: '--item', ps: '-Item', value: 'text', repeatable: true, help: 'An item id or name (repeatable); the default is every item of the path in the wave.' },
  { flag: '--dry-run', ps: '-DryRun', help: 'Print every change instead of making it; read-only calls still run.' },
  { flag: '--gate-override', ps: '-GateOverride', value: 'text', help: 'Proceed through a closed gate, recording the reason.' },
  { flag: '--once', ps: '-Once', help: 'For replicate and status: poll once and exit (for cron).' },
  { flag: '--timeout', ps: '-Timeout', value: 'number', help: 'Minutes to wait before giving up on a wait.' },
]);

export type ExitName = 'ok' | 'other' | 'usage' | 'missing' | 'gate' | 'precheck' | 'partial';
export const EXIT_CODES: Readonly<Record<ExitName, number>> = Object.freeze({ ok: 0, other: 1, usage: 2, missing: 3, gate: 4, precheck: 5, partial: 10 });
export const EXIT_MEANINGS: Readonly<Record<ExitName, string>> = Object.freeze({
  ok: 'Everything succeeded (or was already done).',
  other: 'Anything else (a lock held by another run, an unexpected error).',
  usage: 'Usage: an unknown verb, option or item.',
  missing: 'A tool, module or credential is missing.',
  gate: 'A gate is not open.',
  precheck: 'A pre-check failed.',
  partial: 'Some items failed; the others succeeded (see the events).',
});

/** Gate files the scripts read: `status/gates/wave-<n>-<gate>.json`; the alias is accepted too (A.7.2 names G2's file `-go`). */
export const GATE_ALIAS: Readonly<Record<'G1' | 'G2' | 'G3' | 'G4' | 'G5', string>> = Object.freeze({
  G1: 'ready', G2: 'go', G3: 'commit', G4: 'decommission', G5: 'lights-out',
});
export function gateFile(wave: number, gate: keyof typeof GATE_ALIAS): string {
  return `${STATUS_DIR}/gates/wave-${wave}-${gate}.json`;
}

// ---------------------------------------------------------------------------
// Deterministic names
// ---------------------------------------------------------------------------

/** The first 8 characters of the plan id, lower-case letters and digits only. */
export function planId8(planId: string): string {
  const s = planId.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (s + '00000000').slice(0, 8);
}

/** FNV-1a, 32 bit, as 8 hex digits: a stable short hash for truncated names. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The longest name every target accepts (Google Cloud (GCP) and DNS labels: 63). */
export const RESOURCE_NAME_MAX = 63;

/**
 * The name of anything the kit creates for an item: `atk-<plan8>-<wave>-<item-slug>`.
 * Lower case, digits and hyphens, starting with a letter, at most 63
 * characters; a longer slug is cut and given a hash, so names stay unique.
 * Resources are found by this name (or a tag with it), never by a
 * remembered id alone.
 */
export function resourceName(planId: string, wave: number | null, itemName: string, max: number = RESOURCE_NAME_MAX): string {
  const slug = slugName(itemName).replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'item';
  const head = `atk-${planId8(planId)}-${wave ?? 0}-`;
  const full = head + slug;
  if (full.length <= max) return full;
  const hash = shortHash(itemName).slice(0, 6);
  const room = Math.max(1, max - head.length - hash.length - 1);
  return `${head}${slug.slice(0, room).replace(/-+$/, '')}-${hash}`;
}

// ---------------------------------------------------------------------------
// Static checks over generated text
// ---------------------------------------------------------------------------

/**
 * A literal credential: the toolkit's base pattern (a secret-like key with a
 * quoted literal value), an AWS access key id, a PEM block, a `password=`
 * with a value, or a Secrets Manager `SecretString` with a value.
 */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(password|passwd|secret|api[_-]?key|token|credential|community)\w*\s*[:=]+\s*["'][^"'$%{<@(\s]/i,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN/,
  /password=(?![\s"'$`{<%)\]]|\*)/i,
  /SecretString\\?"\s*:\s*\\?"(?![\s"$\\{<%])/,
]);

/**
 * Footprints of the machine that generated the kit: a user's home or a
 * drive path, a temp path written as a literal, "Generated by", or a date
 * written as a literal (scripts only: a README may cite a dated fact).
 */
export const FOOTPRINT_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|[\s"'=:(])\/(?:home|Users|root)\/[A-Za-z0-9._-]+/m,
  /(^|[\s"'=:(])[A-Za-z]:[\\/](?:Users|Documents and Settings|Repos|home)\b/im,
  /(^|[\s"'=:(])\/tmp\/[A-Za-z0-9]/m,
  /\bGenerated (by|on|at)\b/i,
]);
export const DATE_LITERAL = /\b(19|20)\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b|\b\d{1,2}\/\d{1,2}\/(19|20)\d\d\b/;

/**
 * Bash command lines that change something. A line that matches must run
 * through `atk_run` (or `atk_retry`, which calls it), so `--dry-run` prints
 * it instead. The list is the kit's own vocabulary; a generator that calls
 * another mutating tool adds it with `extraMutating`.
 */
export const MUTATING_SH: readonly RegExp[] = Object.freeze([
  /\baws\s+[a-z0-9-]+\s+(create|delete|update|put|start|stop|terminate|modify|reboot|register|deregister|finalize|mark|change|retry|disconnect|initialize|reverse|launch|attach|detach|associate|disassociate|tag|untag|restore|import|reset|revoke|authorize|execute|send|enable|disable)-[a-z0-9-]*/,
  /\baz\s+(?:[a-z0-9-]+\s+){1,5}(create|delete|update|start|stop|deallocate|restart|set|add|remove|add-record|remove-record|cutover|failover|import|restore|begin|resume|swap|deploy)\b/,
  /\bgcloud\s+(?:[a-z0-9-]+\s+){1,5}(create|delete|update|start|stop|reset|cutover|finalize|pause|resume|promote|restart|import|export|add-[a-z-]+|remove-[a-z-]+|set-[a-z-]+)\b/,
  /\boci\s+(?:[a-z0-9-]+\s+){1,5}(create|delete|update|terminate|action|change-compartment|start|stop|execute|restore)\b/,
  /\bcurl\b[^\n]*(-X|--request)\s*['"]?(POST|PUT|PATCH|DELETE)\b/,
  /\bvirsh\s+(shutdown|start|destroy|undefine|snapshot-create-as|snapshot-delete|define)\b/,
  /\bpvesh\s+(create|delete|set)\b/,
  /\bqm\s+(start|stop|shutdown|snapshot|destroy)\b/,
  /\bxe\s+vm-(shutdown|start|uninstall|snapshot)\b/,
  /\bansible-playbook\b/,
  /\bterraform\b[^\n]*\s(apply|destroy|import)\b/,
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/,
  /\b(rsync|robocopy|azcopy|rclone)\b\s/,
  /\bgsutil\s+(cp|rm|mv|rsync)\b/,
  /\bgcloud\s+storage\s+(cp|rm|mv|rsync)\b/,
  /\bqemu-img\s+convert\b/,
  /\bkubectl\s+(apply|delete|scale|patch|create|replace)\b/,
  /\bvelero\s+(install|backup\s+create|restore\s+create)\b/,
  /\bzdmcli\s+(migrate|resume|abort|suspend)\b/,
  /\b(psql|mysql|sqlplus|sqlcmd|mongosh|redis-cli)\b[^\n]*\s(-c|-e|--command|--eval|-Q)\s/,
]);

/** PowerShell command lines that change something; they must sit inside an `Invoke-AtkStep` script block. */
export const MUTATING_PS: readonly RegExp[] = Object.freeze([
  /\b(New|Set|Remove|Start|Stop|Restart|Move|Suspend|Resume|Update|Enable|Disable|Add|Register|Unregister|Initialize|Complete|Mount|Dismount|Checkpoint|Convert|Restore|Backup|Install|Uninstall|Rename|Copy)-(Az[A-Z]\w*|HCX\w*|VM\w*|VI\w*|Sql\w*|Dba\w*|Snapshot|VHD|HardDisk|NetworkAdapter|Datastore|Cluster\w*|Folder|Tag\w*|DnsServer\w*|Dhcp\w*|Migration\w*|SPMT\w*|DfsnFolderTarget|ResourceGroup)\b/,
  /\bInvoke-(RestMethod|WebRequest)\b[^\n]*-Method\s+['"]?(Post|Put|Patch|Delete)\b/i,
  /\bInvoke-AzRestMethod\b[^\n]*-Method\s+['"]?(PUT|POST|PATCH|DELETE)\b/i,
  /\bInvoke-(DbaQuery|Sqlcmd)\b/,
  /\bInvoke-Command\b/,
]);

export interface ContractOptions {
  /** More mutating command patterns for this file. */
  readonly extraMutating?: readonly RegExp[];
}

const isScript = (file: string): 'sh' | 'ps' | undefined => (file.endsWith('.sh') ? 'sh' : file.endsWith('.ps1') || file.endsWith('.psm1') ? 'ps' : undefined);

/** Bash lines with `\` continuations joined, heredoc bodies and comments dropped. */
function shLogicalLines(text: string): { line: string; n: number }[] {
  const out: { line: string; n: number }[] = [];
  const raw = text.split('\n');
  let heredoc: string | undefined;
  let acc = '';
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i]!;
    if (heredoc !== undefined) {
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    const doc = /<<-?\s*['"]?([A-Z_]+)['"]?/.exec(line);
    if (!acc) start = i + 1;
    if (line.endsWith('\\')) {
      acc += line.slice(0, -1) + ' ';
      continue;
    }
    const full = acc + line;
    acc = '';
    if (doc) heredoc = doc[1];
    const t = full.trim();
    if (!t || t.startsWith('#')) continue;
    out.push({ line: full, n: start });
  }
  return out;
}

/** A bash line that only prints or logs text (the command appears inside a message). */
const SH_MESSAGE = /^\s*(echo|printf|check_command|check_pwsh_module|check_collection|check_python_module|atk_need|atk_log|atk_die|atk_usage|atk_event|atk_done|atk_skip|atk_fail|local\s+\w+=["']|\w+=["'])/;
const PS_MESSAGE = /^\s*(Write-(Host|Output|Verbose|Warning|AtkLog|AtkEvent)|Set-AtkOutcome|#|throw\b|'[^']*'\s*$|"[^"]*"\s*$)/;

/**
 * What a generated file breaks of the contract, one line each; empty when
 * it keeps it. Every file is checked for credentials and footprints; a
 * `.sh` / `.ps1` is also checked for:
 *   - `--dry-run` / `-DryRun` parsed (through the library), and no `--yes`,
 *     `-Confirm:$true` or `read ` / `Read-Host` prompt;
 *   - every mutating command line inside `atk_run` / `Invoke-AtkStep`;
 *   - verbs dispatched through `atk_main` / `Invoke-AtkMain`, which writes a
 *     `started` and a terminal event for every item (a path script must
 *     implement `rollback`);
 *   - no date literal.
 */
export function contractViolations(file: string, text: string, options: ContractOptions = {}): string[] {
  const out: string[] = [];
  for (const re of CREDENTIAL_PATTERNS) {
    const m = re.exec(text);
    if (m) out.push(`${file}: looks like a literal credential (${JSON.stringify(m[0].slice(0, 24))})`);
  }
  for (const re of FOOTPRINT_PATTERNS) {
    const m = re.exec(text);
    if (m) out.push(`${file}: footprint ${JSON.stringify(m[0].trim().slice(0, 40))}`);
  }
  const kind = isScript(file);
  if (!kind) return out;
  const date = DATE_LITERAL.exec(text);
  if (date) out.push(`${file}: date literal ${date[0]}`);
  const isLib = /(^|\/)lib\/(atk\.sh|Atk\.psm1)$/.test(file);
  if (kind === 'sh') {
    const live = text.replace(/^\s*#.*$/gm, '');
    if (/\s--yes\b/.test(live)) out.push(`${file}: has --yes`);
    if (/(^\s*|[;&|({]\s*|\b(?:do|then|else|while|until|if)\s+)read\s/m.test(live)) out.push(`${file}: reads from the terminal (read)`);
    if (!isLib) {
      if (!/^source\s+.*lib\/atk\.sh"?\s*$/m.test(text)) out.push(`${file}: does not source lib/atk.sh`);
      if (!/\batk_init(_tool)?\s/.test(text)) out.push(`${file}: does not parse its arguments with atk_init (so --dry-run is not parsed)`);
    }
    const verbs = [...text.matchAll(/^verb_([a-z_]+)\s*\(\)/gm)].map((m) => m[1]!);
    if (verbs.length) {
      if (!/\batk_main\b/.test(text)) out.push(`${file}: defines verbs but does not dispatch them with atk_main`);
      if (!verbs.includes('rollback')) out.push(`${file}: has no rollback verb`);
    }
    if (!isLib) {
      const patterns = [...MUTATING_SH, ...(options.extraMutating ?? [])];
      for (const { line, n } of shLogicalLines(text)) {
        if (SH_MESSAGE.test(line) || /\batk_(run|retry)\b/.test(line)) continue;
        const hit = patterns.find((re) => re.test(line));
        if (hit) out.push(`${file}:${n}: mutating command outside atk_run: ${line.trim().slice(0, 80)}`);
      }
    }
  } else {
    const live = text.replace(/^\s*#.*$/gm, '').replace(/<#[\s\S]*?#>/g, '');
    if (/\bRead-Host\b/.test(live)) out.push(`${file}: prompts (Read-Host)`);
    if (/\s--yes\b|-Confirm:\$true/.test(live)) out.push(`${file}: asks for confirmation`);
    if (!isLib) {
      if (!/Import-Module\s+[^\n]*Atk\.psm1/.test(text)) out.push(`${file}: does not import lib/Atk.psm1`);
      if (!/\bInitialize-Atk\b/.test(text)) out.push(`${file}: does not parse its arguments with Initialize-Atk (so -DryRun is not parsed)`);
      if (!/\[switch\]\s*\$DryRun/.test(text)) out.push(`${file}: has no -DryRun switch`);
    }
    const verbTable = /\$Verbs\s*=\s*@\{/.test(text);
    if (verbTable) {
      if (!/\bInvoke-AtkMain\b/.test(text)) out.push(`${file}: defines verbs but does not dispatch them with Invoke-AtkMain`);
      if (!/^\s*'?rollback'?\s*=\s*\{/m.test(text)) out.push(`${file}: has no rollback verb`);
    }
    if (!isLib) {
      const patterns = [...MUTATING_PS, ...(options.extraMutating ?? [])];
      let depth = 0;
      let wrappedAt = -1;
      const lines = text.split('\n');
      let inComment = false;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (inComment) {
          if (line.includes('#>')) inComment = false;
          continue;
        }
        if (line.trim().startsWith('<#')) {
          if (!line.includes('#>')) inComment = true;
          continue;
        }
        const code = line.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/#.*$/, '');
        const opens = (code.match(/\{/g) ?? []).length;
        const closes = (code.match(/\}/g) ?? []).length;
        const starts = /\bInvoke-Atk(Step|Retry)\b/.test(line);
        if (starts && wrappedAt < 0) wrappedAt = depth;
        const wrapped = wrappedAt >= 0;
        if (!wrapped && !PS_MESSAGE.test(line)) {
          const hit = patterns.find((re) => re.test(code));
          if (hit) out.push(`${file}:${i + 1}: mutating command outside Invoke-AtkStep: ${line.trim().slice(0, 80)}`);
        }
        depth += opens - closes;
        if (wrappedAt >= 0 && depth <= wrappedAt) wrappedAt = -1;
      }
    }
  }
  return out;
}
