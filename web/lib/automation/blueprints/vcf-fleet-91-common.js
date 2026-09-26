/**
 * Script pieces shared by the SDDC Manager blueprints (vcf-fleet.ts and the
 * domain, cluster, network pool and host blueprints beside it) and the 9.1
 * fleet management blueprints (vcf-fleet-91.ts).
 *
 * Kept in their own module so that neither blueprint file has to import the
 * other: both are spread into one list by index.ts, and a cycle between them
 * would leave one list half-built at load time.
 */

import { authHeader, authPreamble } from '../apply.js';
import { importGuide,                     } from './vcf-networks-logs.js';

/** The source named on findings (shown on the page, never written into a file). */
export const SRC = 'ArchToolKit';

export const SDDC_API =
  'SDDC Manager API reference for VCF 9.x at developer.broadcom.com: request bodies DomainCreationSpec, ClusterCreationSpec, ClusterUpdateSpec (clusterExpansionSpec, clusterCompactionSpec), NetworkPool, HostCommissionSpec[], HostDecommissionSpec[], CredentialsUpdateSpec.';

/** Single-quote a value for bash. */
export function sq(value        )         {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const json = (value         )         => `${JSON.stringify(value, null, 2)}\n`;

/** IMPORT.md for an SDDC Manager blueprint: everything goes in through /v1, in this order. */
export function sddcImport(intro        , steps                                         , verify                    = [], sources                    = [SDDC_API])         {
  return importGuide({
    product: 'SDDC Manager',
    intro: `${intro} Every script reads SDDC_HOST and either SDDC_TOKEN (POST /v1/tokens) or SDDC_USER with SDDC_PASSWORD_FILE (mode 600). The same calls can be made from SDDC Manager > Developer Center > API Explorer by pasting the file as the body.`,
    steps,
    verify,
    sources,
  });
}

/** The call helper every acting SDDC Manager script opens with. */
export function sddcApiHelper()           {
  return [
    'api() {',
    '  local method="$1" path="$2"; shift 2',
    '  curl -sS -f -X "$method" "https://${SDDC_HOST}${path}" \\',
    `    -H "${authHeader('sddc-manager')}" \\`,
    '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
  ];
}

/** The check every acting SDDC Manager script makes before it touches anything. */
export function lifecycleGuard()           {
  return [
    '# Guardrail: nothing else is running. Changing domains, clusters or hosts',
    '# while an upgrade or another workload domain operation is in flight is how a',
    '# resource ends up locked in SDDC Manager with no clean way to release it.',
    'BUSY=$(api GET /v1/tasks | jq \'[.elements[]? | select((.status // "" | ascii_upcase) | test("IN_PROGRESS|IN PROGRESS|PENDING"))] | length\')',
    'if (( BUSY > 0 )); then',
    '  echo "Refusing: ${BUSY} SDDC Manager task(s) in progress. Wait for them to finish." >&2',
    '  exit 1',
    'fi',
  ];
}

/**
 * Follow an SDDC Manager validation and a task to the end.
 *
 * wait_validation <path-of-the-validation> prints every check and returns 0
 * only when resultStatus is SUCCEEDED: a validation still running at the limit,
 * or one whose result cannot be read, is not a pass.
 * wait_task <taskId> returns 0 on SUCCESSFUL, 1 on FAILED, 2 when unknown.
 */
export function sddcWaiters(validationTries = 90, taskTries = 720)           {
  return [
    'wait_validation() {',
    '  local path="$1" res="" i',
    `  for (( i = 0; i < ${validationTries}; i++ )); do`,
    '    res=$(api GET "$path") || res=""',
    '    [[ "$(jq -r \'.executionStatus // ""\' <<<"$res" 2>/dev/null)" == "COMPLETED" ]] && break',
    '    sleep 10',
    '  done',
    '  jq -r \'.validationChecks[]? | "  \\(.resultStatus // "?")  \\(.description // .name // "")\\(if (.errorResponse.message // "") != "" then " — " + .errorResponse.message else "" end)"\' <<<"$res" 2>/dev/null || true',
    '  [[ "$(jq -r \'.resultStatus // ""\' <<<"$res" 2>/dev/null)" == "SUCCEEDED" ]]',
    '}',
    'wait_task() {',
    '  local id="$1" status="UNKNOWN" i misses=0',
    `  for (( i = 0; i < ${taskTries}; i++ )); do`,
    '    if ! status=$(api GET "/v1/tasks/${id}" | jq -r \'.status // "UNKNOWN"\' | tr a-z A-Z); then',
    '      misses=$(( misses + 1 ))',
    '      if (( misses >= 8 )); then echo "  task ${id}: status unreadable ${misses} times in a row; outcome UNKNOWN." >&2; return 2; fi',
    '      sleep 20; continue',
    '    fi',
    '    misses=0',
    '    case "$status" in',
    '      SUCCESSFUL) echo "  task ${id}: SUCCESSFUL"; return 0 ;;',
    '      FAILED|CANCELLED) echo "  task ${id}: ${status}. Read it in SDDC Manager > Tasks; a failed task can usually be retried there (PATCH /v1/tasks/${id})." >&2; return 1 ;;',
    '    esac',
    '    sleep 20',
    '  done',
    '  echo "  task ${id}: still ${status} at the limit; outcome UNKNOWN. Follow it in SDDC Manager before running again." >&2',
    '  return 2',
    '}',
  ];
}

/** Refuse a secret file anyone but its owner can read. */
export function needPrivate()           {
  return [
    '# A file holding a secret must be readable by its owner only.',
    'need_private() {',
    '  local f="$1" m',
    '  [[ -r "$f" ]] || { echo "Cannot read $f" >&2; exit 2; }',
    '  m=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")',
    '  if [[ "$m" != "600" && "$m" != "400" ]]; then',
    '    echo "Refusing: $f is mode $m. It holds a secret; chmod 600 it first." >&2',
    '    exit 2',
    '  fi',
    '}',
  ];
}

/** Parse --dry-run and friends without the `[[ ]] &&` trap under set -e. */
export function parseArgs(extra                    = [])           {
  return [
    'DRY_RUN=0',
    'ARGS=()',
    'while (( $# > 0 )); do',
    '  case "$1" in',
    '    --dry-run) DRY_RUN=1 ;;',
    ...extra.map((line) => `    ${line}`),
    '    *) ARGS+=("$1") ;;',
    '  esac',
    '  shift',
    'done',
    'set -- "${ARGS[@]+"${ARGS[@]}"}"',
  ];
}

/** The opening of every acting SDDC Manager script. */
export function sddcHead(title        , usage                   )           {
  return [
    '#!/usr/bin/env bash',
    `# ${title}`,
    '#',
    ...usage.map((line) => (line ? `# ${line}` : '#')),
    'set -euo pipefail',
    '',
    ...authPreamble('sddc-manager'),
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    '',
    ...sddcApiHelper(),
    ...sddcWaiters(),
    ...needPrivate(),
    '',
  ];
}

/** Posts the PROBLEMS array to a webhook on stdin; a failed post is said, not swallowed. */
export function notifyProblems(webhook        , source        )           {
  if (!webhook) return [];
  return [
    `if ! printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "${source}", problems: .}' \\`,
    `    | curl -sS -f -o /dev/null -X POST ${sq(webhook)} -H "Content-Type: application/json" --data-binary @-; then`,
    `  echo "WARNING: could not post the problems to ${webhook.replace(/["`$\\]/g, '')}; nobody was told but this log." >&2`,
    'fi',
  ];
}

/**
 * Rows of a " | " table: one line per row, blank lines and # comments skipped,
 * every cell trimmed. A row with fewer cells than `columns` is padded with ''.
 */
export function tableRows(text        , columns        )             {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      while (cells.length < columns) cells.push('');
      return cells;
    });
}

/** An environment variable name for one host's password. */
export function hostPasswordVar(fqdn        )         {
  return `ESX_PW_${fqdn.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}
