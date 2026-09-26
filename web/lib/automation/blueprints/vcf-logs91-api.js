/**
 * VCF Operations 9.1 log management: what every log blueprint shares.
 *
 * In 9.1 log management is a service inside VCF Operations. Saved queries have
 * a documented suite-API resource (/suite-api/api/logs/queryconfigs, OpsToken).
 * Everything else on the service is reached with the KB 450054 exchange: sign
 * in to VCF Operations, POST /suite-api/api/auth/token/exchange with
 * {"serviceKeys":["ops-li"]}, and send the JWT it returns as
 * "Authorization: Bearer <jwt>" to the log management API.
 *
 * The KB documents the exchange and the header, not the host or the resource
 * paths behind it. So every apply script here:
 *   - takes the base URL from LOGMGMT_API (default https://$LOGMGMT_HOST, and
 *     LOGMGMT_HOST defaults to VCFOPS_HOST) and each resource path from its own
 *     LOGMGMT_PATH_* variable, with the path VCF Operations for Logs 8.18 used as
 *     the default (VERIFY on 9.1);
 *   - reads the collection first and keeps it as the "before" copy, which is
 *     also the check that the path is answered: when it is not, it stops with
 *     exit 3 and points at the manual steps, rather than guessing;
 *   - skips anything that already exists with the same name, so it can be run
 *     again after a partial failure;
 *   - applies when run; --dry-run only prints.
 *
 * The JWT goes to curl as -H @file from a private file (umask 077, removed on
 * exit), never as an argument.
 */

import { authHeader, authPreamble } from '../apply.js';

// ---------------------------------------------------------------------------
// Conditions, rows and small formatters
// ---------------------------------------------------------------------------

/** The filter operators every 9.1 log processing, forwarding and masking rule offers. */
export const CONDITION_OPERATORS = [
  { value: 'Contains', label: 'Contains' },
  { value: 'Does not contain', label: 'Does not contain' },
  { value: 'Starts with', label: 'Starts with' },
  { value: 'Does not start with', label: 'Does not start with' },
  { value: 'Matches Regex', label: 'Matches Regex' },
  { value: 'Exists', label: 'Exists' },
  { value: 'Does not exist', label: 'Does not exist' },
];
export const OPERATOR_NAMES                      = new Set(CONDITION_OPERATORS.map((option) => option.value));
export const VALUELESS                      = new Set(['Exists', 'Does not exist']);

                               
                         
                            
                          
 

export function json(value         )         {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function md(lines                   )         {
  return `${lines.join('\n')}\n`;
}

/** A condition as the 9.1 rule forms take it, or nothing when the value is blank. */
export function condition(field        , operator        , value        )                           {
  if (!field) return undefined;
  if (VALUELESS.has(operator)) return { field, operator };
  if (!value) return undefined;
  return { field, operator, value };
}

export function describe(c                          )         {
  if (!c) return 'no condition';
  return c.value === undefined ? `${c.field} ${c.operator.toLowerCase()}` : `${c.field} ${c.operator.toLowerCase()} "${c.value}"`;
}

export function describeAll(conditions                         , join               = 'AND')         {
  if (conditions.length === 0) return 'no condition';
  return conditions.map(describe).join(join === 'AND' ? ' and ' : ' or ');
}

export function linesOf(text        )           {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
}

/** Rows of a " | " table: comment lines skipped, every row padded to `columns` cells. */
export function rowsOf(text        , columns        )             {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      while (cells.length < columns) cells.push('');
      return cells.slice(0, columns);
    });
}

/**
 * Condition rows ("field | operator | value"). Rows with an operator 9.1 does
 * not offer are returned in `bad`, so the blueprint can say so.
 */
export function conditionRows(text        )                                                {
  const conditions                 = [];
  const bad           = [];
  for (const [field, operator, value] of rowsOf(text, 3)) {
    if (!field) continue;
    if (!OPERATOR_NAMES.has(operator )) {
      bad.push(`${field} | ${operator} | ${value}`);
      continue;
    }
    const made = condition(field, operator , value );
    if (made) conditions.push(made);
    else bad.push(`${field} | ${operator} | (no value)`);
  }
  return { conditions, bad };
}

/** A name safe inside a bash variable. */
export function envName(text        )         {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Single-quote for bash. */
export function sq(text        )         {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// The apply script
// ---------------------------------------------------------------------------

const OPS_HDR_REF = authHeader('vcf-operations'); // "@${AUTH_HDR_VCF_OPERATIONS}"
const OPS_HDR_VAR = OPS_HDR_REF.replace(/^@\$\{/, '').replace(/\}$/, '');

export const KB_450054 = 'KB 450054: POST /suite-api/api/auth/token/exchange {"serviceKeys":["ops-li"]} on VCF Operations, then Authorization: Bearer <jwt> on the log management API.';

export const LOGS_API_VERIFY =
  'VERIFY: KB 450054 documents the ops-li token exchange and the Bearer header, not the log management API host or its resource paths. The scripts default to the VCF Operations for Logs 8.18 paths on LOGMGMT_API (https://$LOGMGMT_HOST, which defaults to VCFOPS_HOST); each path is overridable with its LOGMGMT_PATH_* variable. Every script reads the collection first and stops with exit 3 when the path is not answered, so a wrong path changes nothing.';

/**
 * The opening of every log management script: argument parsing, the VCF
 * Operations sign-in, the ops-li exchange and the two call helpers
 * (`li` for log management with the JWT, `ops` for the suite API with the
 * OpsToken). In a dry run nothing signs in.
 */
export function logsScriptHead(purpose        , extraTools                    = [])           {
  return [
    '#!/usr/bin/env bash',
    `# ${purpose}`,
    '#',
    '# Applies when run; with --dry-run it prints what it would send and signs in',
    '# to nothing. Signs in to VCF Operations from the environment (VCFOPS_TOKEN, or',
    '# VCFOPS_USER with VCFOPS_PASSWORD_FILE), exchanges that session for a log',
    '# management JWT (KB 450054, serviceKeys ops-li), and keeps the JWT in a',
    '# private header file removed on exit. No credential is written anywhere else.',
    '#',
    '# Anything that already exists with the same name is left alone, so a run that',
    '# stopped part way can be run again. What was there before is saved under',
    '# before-<time>/ beside this script: that is the record and the undo.',
    'set -euo pipefail',
    `for tool in curl jq${extraTools.map((tool) => ` ${tool}`).join('')}; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done`,
    'DRY_RUN=0',
    '[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
    'HERE=$(cd "$(dirname "$0")" && pwd)',
    '',
    'if (( ! DRY_RUN )); then',
    ...authPreamble('vcf-operations').map((line) => `  ${line}`),
    `  LI_HDR="$(umask 077; mktemp "\${TMPDIR:-/tmp}/li.XXXXXX")"`,
    '  # Anything built from a secret at run time goes here, and nowhere else.',
    `  PRIVATE="$(umask 077; mktemp -d "\${TMPDIR:-/tmp}/private.XXXXXX")"`,
    `  trap 'rm -rf "$${OPS_HDR_VAR}" "$LI_HDR" "$PRIVATE"' EXIT`,
    '  # KB 450054: exchange the OpsToken session for a log management JWT.',
    `  JWT=$(printf '%s' '{"serviceKeys":["ops-li"]}' | curl -sS -f -X POST "https://\${VCFOPS_HOST}/suite-api/api/auth/token/exchange" -H "${OPS_HDR_REF}" \\`,
    '    -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @- \\',
    "    | jq -r '.token // .accessToken // .access_token // ((.tokens // [])[0] | objects | (.token // .accessToken)) // empty')",
    '  [[ -n "$JWT" ]] || { echo "The ops-li token exchange returned no token (VERIFY the response shape on your release)." >&2; exit 2; }',
    "  printf 'Authorization: Bearer %s\\n' \"$JWT\" > \"$LI_HDR\"",
    '  unset JWT',
    '  BEFORE_DIR="$HERE/before-$(date +%Y%m%d-%H%M%S)"',
    '  mkdir -p "$BEFORE_DIR"',
    'fi',
    '',
    'LOGMGMT_HOST="${LOGMGMT_HOST:-${VCFOPS_HOST:-}}"',
    'LOGMGMT_API="${LOGMGMT_API:-https://${LOGMGMT_HOST:-<LOGMGMT_HOST>}}"',
    '',
    '# Log management, with the JWT.',
    'li() {',
    '  local method="$1" path="$2" file="${3:-}"',
    '  if [[ -n "$file" ]]; then',
    '    curl -sS -f -X "$method" "${LOGMGMT_API}${path}" -H "@${LI_HDR}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @"$file"',
    '  else',
    '    curl -sS -f -X "$method" "${LOGMGMT_API}${path}" -H "@${LI_HDR}" -H "Accept: application/json"',
    '  fi',
    '}',
    '# The VCF Operations suite API, with the OpsToken.',
    'ops() {',
    '  local method="$1" path="$2" file="${3:-}"',
    '  if [[ -n "$file" ]]; then',
    `    curl -sS -f -X "$method" "https://\${VCFOPS_HOST}\${path}" -H "${OPS_HDR_REF}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @"$file"`,
    '  else',
    `    curl -sS -f -X "$method" "https://\${VCFOPS_HOST}\${path}" -H "${OPS_HDR_REF}" -H "Accept: application/json"`,
    '  fi',
    '}',
    '# True when a list (any shape) holds an object whose name or id is $2.',
    'has_named() {',
    '  jq -e --arg n "$2" \'[.. | objects | select((.name? // .id? // .displayName? // "") == $n)] | length > 0\' "$1" >/dev/null 2>&1',
    '}',
    '',
  ];
}

                           
                                   
                        
                                                                       
                       
                                   
                        
                                             
                                            
                           
                                                                                      
                         
                                                         
                         
                                                                                                          
                                     
                                                              
                              
 

export function logsCallLines(call          , manual        , applyOnly = false)           {
  const variable = `LOGMGMT_PATH_${envName(call.key)}`;
  const method = call.method ?? 'POST';
  const fn = call.api ?? 'li';
  const base = fn === 'li' ? '${LOGMGMT_API}' : 'https://${VCFOPS_HOST}';
  const slug = call.key.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  // A payload starting with $ is a path the script built (in $PRIVATE); anything else sits beside the script.
  const file = call.payload.startsWith('$') ? call.payload : `$HERE/${call.payload}`;
  const what = call.what.replace(/"/g, '');
  const send = [`echo "${method} $P"`, `${fn} ${method} "$P" "${file}" | tee "$BEFORE_DIR/${slug}-created.json"`, 'echo'];
  const body = [
    `LIST="$BEFORE_DIR/${slug}-before.json"`,
    `if ! ${fn} GET "$L" > "$LIST"; then`,
    `  echo "GET ${base}$L was not answered. The path differs on this release: set ${variable} (and ${variable}_LIST), or apply it by hand from ${manual}. Nothing was changed for: ${what}." >&2`,
    '  exit 3',
    'fi',
    ...(call.check ?? []),
    ...(call.name ? [`if has_named "$LIST" ${sq(call.name)}; then`, `  echo "exists, left alone: ${what}"`, 'else', ...send.map((line) => `  ${line}`), 'fi'] : send),
  ];
  return [
    `# --- ${call.what}`,
    `P=\${${variable}:-${sq(call.path)}}`,
    `L=\${${variable}_LIST:-${sq(call.list ?? call.path)}}`,
    ...(applyOnly
      ? body
      : ['if (( DRY_RUN )); then', `  echo "DRY RUN: would read ${base}$L, then ${method} ${call.payload} to ${base}$P${call.name ? ` unless ${call.name.replace(/"/g, '')} exists` : ''}"`, 'else', ...body.map((line) => `  ${line}`), 'fi']),
    '',
  ];
}

/** A complete log management apply script. */
export function logsApplyScript(spec   
                           
                                      
                        
                                                                  
                          
                                          
                                                                                 
                                     
                                                             
                                     
 )         {
  return [
    ...logsScriptHead(spec.purpose, spec.extraTools),
    ...(spec.first ?? []),
    ...spec.calls.flatMap((call) => logsCallLines(call, spec.manual)),
    ...(spec.after && spec.after.length > 0 ? ['if (( ! DRY_RUN )); then', ...spec.after.map((line) => `  ${line}`), 'fi', ''] : []),
    'if (( DRY_RUN )); then',
    '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
    'else',
    '  echo "Applied. What was there before: $BEFORE_DIR"',
    'fi',
    `# Undo: ${spec.undo}`,
    '',
  ].join('\n');
}

/** The note every log management blueprint carries about how it applies. */
export function logsApplyNote()         {
  return `apply.sh applies it: ${KB_450054} ${LOGS_API_VERIFY}`;
}
