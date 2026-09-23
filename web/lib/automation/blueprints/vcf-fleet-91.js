/**
 * VCF 9.1 fleet management: the fleet-wide jobs that moved into VCF Operations.
 *
 * In VCF 5.x and 9.0 passwords, certificates and backups were SDDC Manager's
 * business, one instance at a time (the blueprints in vcf-fleet.ts). In 9.1
 * VCF Operations owns them for the whole fleet — every instance, the
 * management components, and in 9.1.1 VCF Automation, VCF Operations for
 * networks and the cloud proxies too — under one identity broker.
 *
 * Every script here talks to /suite-api/api/fleet-management on the VCF
 * Operations appliance with a Bearer token from the VCF Identity Broker,
 * exchanged for the API token of an API client (fleet91_api_clients writes and
 * rotates that token file; everything else reads it). Long-running requests are
 * followed at /suite-api/api/workflows/requests/{requestId}. Reads come first;
 * anything that changes the fleet is behind --execute.
 *
 * Paths and fields confirmed against the VCF Operations API reference
 * (developer.broadcom.com) and the davidwzhang.com 9.1 series are used as they
 * are. Where a path could not be confirmed the file says VERIFY, or leaves
 * <REQUIRED>, rather than guessing quietly.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { authHeader, authPreamble, readScript, scheduledEnv } from '../apply.js';
import { importGuide,                     } from './vcf-networks-logs.js';

const PLATFORM = 'vcf-fleet'         ;
const SRC = 'ArchToolKit';
const FM = '/suite-api/api/fleet-management';

const FLEET_API = 'VCF Operations API reference at developer.broadcom.com (/suite-api/api/fleet-management) and the davidwzhang.com VCF 9.1 series, as cited in each script.';

/** IMPORT.md for a 9.1 fleet blueprint: VCF Operations, through the API or the interface. */
function fleetImport(intro        , steps                                         , verify                    = [], sources                    = [FLEET_API])         {
  return importGuide({
    product: 'VCF Operations fleet management (VCF 9.1)',
    intro: `${intro} Scripts read VCFOPS_HOST, VCF_IDB_HOST and VCF_API_TOKEN_FILE (mode 600) unless they say otherwise.`,
    steps,
    verify,
    sources,
  });
}

/** The step for a read-only script run on a schedule. */
function cronStep(script        )                 {
  return { heading: 'Run it once, then schedule it', lines: [`Run \`./${script}\` by hand and compare with the VCF Operations interface, then install the line in crontab.txt with \`crontab -e\`.`] };
}

/** Single-quote a value for bash. */
function sq(value        )         {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Password-managed appliance types, as the password accounts query names them. */
const PW_APPLIANCES = [
  { value: 'ESX', label: 'ESX hosts' },
  { value: 'VCENTER', label: 'vCenter (incl. SSO administrator in 9.1.1)' },
  { value: 'SDDC_MANAGER', label: 'SDDC Manager (root, admin@local, vcf in 9.1.1)' },
  { value: 'NSXT_MANAGER', label: 'NSX Manager' },
  { value: 'NSXT_EDGE', label: 'NSX Edge' },
  { value: 'VCF_OPERATIONS', label: 'VCF Operations' },
  { value: 'VCF_AUTOMATION', label: 'VCF Automation' },
  { value: 'VCF_OPS_NETWORK', label: 'VCF Operations for networks' },
  { value: 'LOG_MANAGEMENT', label: 'VCF Operations for logs' },
  { value: 'CLOUD_PROXY', label: 'Cloud proxy' },
  { value: 'IDENTITY_BROKER', label: 'VCF Identity Broker' },
  { value: 'VCF_SERVICES_RUNTIME', label: 'VCF management services runtime' },
  { value: 'VCF_OPS_HCX', label: 'HCX' },
  { value: 'AVI_LOAD_BALANCER', label: 'Avi Load Balancer' },
];

/** Certificate-managed appliance types, as the certificates query names them. */
const CERT_APPLIANCES = [
  { value: 'VCENTER', label: 'vCenter' },
  { value: 'SDDC_MANAGER', label: 'SDDC Manager' },
  { value: 'NSXT_MANAGER', label: 'NSX Manager' },
  { value: 'ESX', label: 'ESX host' },
  { value: 'VCF_OPERATIONS', label: 'VCF Operations' },
  { value: 'VCF_AUTOMATION', label: 'VCF Automation' },
  { value: 'VCF_OPS_NETWORK', label: 'VCF Operations for networks' },
  { value: 'LOG_MANAGEMENT', label: 'VCF Operations for logs' },
  { value: 'IDENTITY_BROKER', label: 'VCF Identity Broker' },
  { value: 'CLOUD_PROXY', label: 'Cloud proxy (9.1.1)' },
  { value: 'LICENSE_SERVER', label: 'License server (9.1.1)' },
  { value: 'VCF_SERVICES_RUNTIME', label: 'VCF management services runtime' },
  { value: 'VCF_OPS_HCX', label: 'HCX' },
  { value: 'AVI_LOAD_BALANCER', label: 'Avi Load Balancer' },
  { value: 'SUPERVISOR', label: 'Supervisor' },
];

/** The private header file authPreamble('vcf-fleet') writes, as a bash expansion. */
const FLEET_HDR = authHeader('vcf-fleet').slice(1);
/** The same for the OpsToken the fleet lifecycle script exchanges. */
const OPS_HDR = authHeader('vcf-operations').slice(1);

/**
 * The call helpers every fleet script opens with, after authPreamble.
 *
 * The access token from the identity broker lasts about thirty minutes, and a
 * certificate replacement alone can take eleven. So the loops that wait call
 * refresh_token, which logs in again from the API token file when the token is
 * getting old and rewrites the private header file every call reads. It is
 * called in the parent shell, never inside $( ), or the new token would be lost
 * with the subshell.
 *
 * query_all never returns part of a list. The page size is not documented as
 * capped, and a server that caps it quietly would make "short page" look like
 * "last page", so it pages until an empty page (or pageInfo.totalCount records
 * are in hand), and fails — non-zero, nothing on stdout — on a response it does
 * not recognise, a page that repeats, a count short of totalCount, or the page
 * limit. A report that says "nothing expires" has to have read everything.
 */
function fleetApi()           {
  return [
    `FM=${FM}`,
    'TOKEN_AT=$(date +%s)',
    'refresh_token() {',
    '  [[ -n "${VCF_API_TOKEN_FILE:-}" ]] || return 0',
    '  (( $(date +%s) - TOKEN_AT < 1500 )) && return 0',
    '  : "${VCF_IDB_HOST:?set VCF_IDB_HOST to log in again}"',
    '  local fresh',
    '  fresh=$( { printf \'%s&api_token=\' \'grant_type=urn:custom:vcf:params:oauth:grant-type:api-token\'; jq -jn --rawfile p "$VCF_API_TOKEN_FILE" \'$p | rtrimstr("\\n") | @uri\'; } |',
    '    curl -sS -f -X POST "https://${VCF_IDB_HOST}/acs/t/CUSTOMER/token" -H "Accept: application/json" -H "Content-Type: application/x-www-form-urlencoded" --data-binary @- | jq -r \'.access_token // empty\') || fresh=""',
    '  if [[ -z "$fresh" ]]; then echo "Could not renew the access token at ${VCF_IDB_HOST}." >&2; return 1; fi',
    '  VCF_ACCESS_TOKEN="$fresh"',
    '  # printf is a builtin: the token goes to the private header file, never to an argument.',
    `  printf 'Authorization: Bearer %s\\n' "$VCF_ACCESS_TOKEN" > "${FLEET_HDR}"`,
    '  TOKEN_AT=$(date +%s)',
    '  return 0',
    '}',
    'api() {',
    '  local method="$1" path="$2"; shift 2',
    '  curl -sS -f -X "$method" "https://${VCFOPS_HOST}${path}" \\',
    `    -H "${authHeader('vcf-fleet')}" \\`,
    '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
    '# The HTTP status of a GET, for "does it exist" checks: 200, 404, or anything',
    '# else (000 = no answer), which the caller must treat as "cannot tell".',
    'api_status() {',
    '  curl -sS -o /dev/null -w \'%{http_code}\' "https://${VCFOPS_HOST}$1" \\',
    `    -H "${authHeader('vcf-fleet')}" -H "Accept: application/json" || true`,
    '}',
    '# POST a fleet-management query and gather every page into one JSON array.',
    '#   query_all <path> <body-json> <array-key[|other-key]> <unique-field or "">',
    'QUERY_PAGE_SIZE=1000',
    'QUERY_MAX_PAGES=200',
    'query_all() {',
    '  local path="$1" body="$2" key="$3" uniq="$4" page=0 count total="" have=0 dir',
    '  dir=$(mktemp -d) || return 1',
    '  while :; do',
    '    if (( page >= QUERY_MAX_PAGES )); then',
    '      echo "Refusing a partial list: ${path} still had records after ${page} pages of ${QUERY_PAGE_SIZE}." >&2',
    '      rm -rf "$dir"; return 1',
    '    fi',
    '    if ! api POST "${path}?page=${page}&pageSize=${QUERY_PAGE_SIZE}" --data "$body" > "${dir}/raw"; then',
    '      echo "${path}: page ${page} could not be read." >&2; rm -rf "$dir"; return 1',
    '    fi',
    '    # The list must be there as an array. A missing key is accepted only when',
    '    # pageInfo says there is nothing to list; otherwise it is a response this',
    '    # script does not understand, not an empty fleet.',
    '    if ! jq -c --arg k "$key" \'',
    '        (first(($k | split("|"))[] as $x | .[$x] | select(. != null)) // null) as $l',
    '        | if ($l | type) == "array" then $l',
    '          elif $l == null and (.pageInfo.totalCount? // -1) == 0 then []',
    '          else error("no \\($k) array in the response") end\' "${dir}/raw" > "${dir}/${page}.json"; then',
    '      echo "${path}: unrecognised response on page ${page} (expected a ${key} array)." >&2; rm -rf "$dir"; return 1',
    '    fi',
    '    count=$(jq length "${dir}/${page}.json")',
    '    [[ -n "$total" ]] || total=$(jq -r \'.pageInfo.totalCount? // empty\' "${dir}/raw")',
    '    if (( count == 0 )); then break; fi',
    '    if (( page > 0 )) && cmp -s "${dir}/${page}.json" "${dir}/$(( page - 1 )).json"; then',
    '      echo "${path}: page ${page} repeats page $(( page - 1 )); the server is not paging. Refusing a partial list." >&2',
    '      rm -rf "$dir"; return 1',
    '    fi',
    '    if ! have=$(jq -s --arg u "$uniq" \'add | map(if $u == "" then tojson else (.[$u] // error("a record has no \\($u)")) end) | unique | length\' "$dir"/[0-9]*.json); then',
    '      echo "${path}: a record has no ${uniq}; cannot tell records apart." >&2; rm -rf "$dir"; return 1',
    '    fi',
    '    if [[ -n "$total" ]] && (( have >= total )); then break; fi',
    '    page=$(( page + 1 ))',
    '  done',
    '  if [[ -n "$total" ]] && (( have < total )); then',
    '    echo "Refusing a partial list: ${path} reports ${total} record(s), ${have} were read." >&2',
    '    rm -rf "$dir"; return 1',
    '  fi',
    '  jq -s --arg u "$uniq" \'add // [] | if $u == "" then unique_by(tojson) else unique_by(.[$u]) end\' "$dir"/[0-9]*.json',
    '  rm -rf "$dir"',
    '}',
  ];
}

/**
 * Follow a fleet request to the end.
 * Returns 0 when it COMPLETED, 1 when the platform says it failed, and 2 when
 * the outcome is unknown (still running at the limit, or its status could not
 * be read) — callers that change something must not treat 2 as 1.
 */
function waitRequest()           {
  return [
    '# Fleet operations return a requestId; the request is followed here, at the',
    '# path the VCF Operations API reference documents (Workflow Request).',
    'wait_request() {',
    '  local id="$1" tries="${2:-240}" state="UNKNOWN" body i misses=0',
    '  for (( i = 0; i < tries; i++ )); do',
    '    refresh_token || { echo "  request ${id}: cannot renew the token to follow it; outcome UNKNOWN." >&2; return 2; }',
    '    if ! body=$(api GET "/suite-api/api/workflows/requests/${id}"); then',
    '      misses=$(( misses + 1 ))',
    '      if (( misses >= 8 )); then echo "  request ${id}: status unreadable ${misses} times in a row; outcome UNKNOWN." >&2; return 2; fi',
    '      sleep 15; continue',
    '    fi',
    '    misses=0',
    '    state=$(jq -r \'.state // "UNKNOWN"\' <<<"$body" 2>/dev/null) || state=UNKNOWN',
    '    case "$state" in',
    '      COMPLETED) echo "  request ${id}: COMPLETED"; return 0 ;;',
    '      FAILED|ERROR|CANCELLED|CANCELED|ABORTED)',
    '        echo "  request ${id}: ${state} — $(jq -r \'.errorCause // "no cause given"\' <<<"$body")" >&2',
    '        return 1 ;;',
    '    esac',
    '    sleep 15',
    '  done',
    '  echo "  request ${id}: still ${state} after $(( tries / 4 )) minutes; outcome UNKNOWN. Follow it in VCF Operations before running again." >&2',
    '  return 2',
    '}',
  ];
}

/** Refuse a secret file anyone but its owner can read. */
function needPrivate()           {
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

/**
 * Posts the PROBLEMS array to a webhook. The body goes on stdin (a long problem
 * list would pass the 128 KB limit on one argument), curl -f makes an HTTP error
 * a failure, and a failed post is said on stderr rather than swallowed. It does
 * not change the exit code: the script is already exiting 1 when it posts.
 */
function notify(webhook        , source        )           {
  if (!webhook) return [];
  return [
    `if ! printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "${source}", problems: .}' \\`,
    `    | curl -sS -f -o /dev/null -X POST ${sq(webhook)} -H "Content-Type: application/json" --data-binary @-; then`,
    `  echo "WARNING: could not post the problems to ${webhook.replace(/["`$\\]/g, '')}; nobody was told but this log." >&2`,
    'fi',
  ];
}

/** Parse --execute and friends without the `[[ ]] &&` trap under set -e. */
function parseArgs(extra                    = [])           {
  return [
    'DRY_RUN=1',
    'ARGS=()',
    'while (( $# > 0 )); do',
    '  case "$1" in',
    '    --execute) DRY_RUN=0 ;;',
    ...extra.map((line) => `    ${line}`),
    '    *) ARGS+=("$1") ;;',
    '  esac',
    '  shift',
    'done',
    'set -- "${ARGS[@]+"${ARGS[@]}"}"',
  ];
}

function head(title        , usage                   )           {
  return [
    '#!/usr/bin/env bash',
    `# ${title}`,
    '#',
    ...usage.map((line) => (line ? `# ${line}` : '#')),
    'set -euo pipefail',
    '',
    ...authPreamble('vcf-fleet'),
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    '',
    ...fleetApi(),
    '',
  ];
}

const json = (value         )         => `${JSON.stringify(value, null, 2)}\n`;

const cron = (base        , schedule        , script        , args = '')         =>
  [
    `# ${base}: the script logs in for itself from the API token file (mode 600,`,
    '# written and rotated by fleet91_api_clients). No token is in this line.',
    `${schedule} cd /opt/archtoolkit/${base} && ${scheduledEnv('vcf-fleet')} ./${script}${args ? ` ${args}` : ''} >> /var/log/archtoolkit/${base}.log 2>&1`,
    '',
  ].join('\n');

export const VCF_FLEET_91                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet91_password_policy',
    platform: PLATFORM,
    label: 'Password policy for the fleet or chosen instances (VCF 9.1)',
    group: 'Credentials (9.1 fleet)',
    description:
      'Write the password policy VCF Operations enforces — length, character classes, history, expiry, lockout — and apply it to the whole fleet or to named VCF instances, or (9.1.1) take a policy off instances so they fall back to the fleet policy. A read-only report comes with it: every policy with its last-updated date, and every component group with its compliance and when that was last checked.',
    inputs: [
      {
        id: 'mode',
        label: 'Do',
        control: 'select',
        options: [
          { value: 'apply', label: 'Create or update the policy, then apply it' },
          { value: 'detach', label: 'Remove a policy from instances (9.1.1) — they fall back to the fleet policy' },
          { value: 'report', label: 'Report only' },
        ],
        default: 'apply',
      },
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'Fleet standard' },
      {
        id: 'target',
        label: 'Apply to',
        control: 'select',
        options: [
          { value: 'FLEET', label: 'The whole fleet (the fallback for every instance)' },
          { value: 'INSTANCE', label: 'Named VCF instances only' },
          { value: 'MANAGEMENT', label: 'Management components' },
        ],
        default: 'FLEET',
        showWhen: { input: 'mode', equals: ['apply'] },
      },
      { id: 'instances', label: 'Instance FQDNs', control: 'text', default: 'sddc-manager-01.example.com', hint: 'Comma separated — the SDDC Manager FQDN of each instance, as the component groups query lists them', showWhen: { input: 'mode', notEquals: ['report'] } },
      { id: 'min_length', label: 'Minimum length', control: 'number', default: 15, min: 8, max: 64, showWhen: { input: 'mode', equals: ['apply'] } },
      { id: 'min_upper', label: 'At least uppercase', control: 'number', default: 1, min: 0, max: 10, showWhen: { input: 'mode', equals: ['apply'] } },
      { id: 'min_lower', label: 'At least lowercase', control: 'number', default: 1, min: 0, max: 10, showWhen: { input: 'mode', equals: ['apply'] } },
      { id: 'min_numeric', label: 'At least digits', control: 'number', default: 1, min: 0, max: 10, showWhen: { input: 'mode', equals: ['apply'] } },
      { id: 'min_special', label: 'At least special', control: 'number', default: 1, min: 0, max: 10, showWhen: { input: 'mode', equals: ['apply'] } },
      { id: 'history', label: 'Remember previous passwords', control: 'number', default: 5, min: 0, max: 24, showWhen: { input: 'mode', equals: ['apply'] } },
      { id: 'max_days', label: 'Expire after (days)', control: 'number', default: 90, min: 1, max: 9999, showWhen: { input: 'mode', equals: ['apply'] } },
      { id: 'warn_days', label: 'Warn before expiry (days)', control: 'number', default: 14, min: 0, max: 365, showWhen: { input: 'mode', equals: ['apply'] } },
      { id: 'lockout_failures', label: 'Lock out after failures', control: 'number', default: 5, min: 1, max: 50, showWhen: { input: 'mode', equals: ['apply'] } },
      { id: 'lockout_period', label: 'Lockout lasts (seconds)', control: 'number', default: 900, min: 60, max: 86400, showWhen: { input: 'mode', equals: ['apply'] } },
      { id: 'lockout_window', label: 'Failures counted over (seconds)', control: 'number', default: 900, min: 60, max: 86400, showWhen: { input: 'mode', equals: ['apply'] } },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-password-policy' },
    ],
    automation: (values                 , name        )             => {
      const mode = str(values, 'mode', 'apply');
      const policyName = str(values, 'policy_name', 'Fleet standard');
      const target = str(values, 'target', 'FLEET');
      const instances = listOf(str(values, 'instances', ''));
      const len = num(values, 'min_length', 15);
      const upper = num(values, 'min_upper', 1);
      const lower = num(values, 'min_lower', 1);
      const digits = num(values, 'min_numeric', 1);
      const special = num(values, 'min_special', 1);
      const history = num(values, 'history', 5);
      const maxDays = num(values, 'max_days', 90);
      const warnDays = num(values, 'warn_days', 14);
      const failures = num(values, 'lockout_failures', 5);
      const lockPeriod = num(values, 'lockout_period', 900);
      const lockWindow = num(values, 'lockout_window', 900);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'password-policy', 'password-policy');
      const needsInstances = mode === 'detach' || (mode === 'apply' && target === 'INSTANCE');

      const findings            = [];
      if (mode === 'apply') {
        if (upper + lower + digits + special > len) {
          findings.push(error('fleet91.policy.impossible', `The character-class minimums add up to ${upper + lower + digits + special}, more than the minimum length of ${len}.`, { remediation: 'Raise the length or lower a minimum; the API will accept it and every rotation will then fail.', source: SRC }));
        }
        if (warnDays >= maxDays) {
          findings.push(error('fleet91.policy.warn-after-expiry', `Warning ${warnDays} days before a ${maxDays}-day expiry means the warning is always on.`, { source: SRC }));
        }
        if (len < 12) {
          findings.push(warning('fleet91.policy.short', `A ${len}-character minimum is below what most hardening guides ask of infrastructure accounts.`, { remediation: 'Fifteen is the usual floor for service and root accounts that nobody types by hand.', source: SRC }));
        }
        if (maxDays < 30) {
          findings.push(warning('fleet91.policy.expiry-short', `Expiring every ${maxDays} days means an appliance account is always about to expire, and a missed rotation locks it.`, { remediation: 'Pair a short expiry with fleet91_password_rotate on a schedule, or lengthen it.', source: SRC }));
        }
        if (failures <= 3) {
          findings.push(warning('fleet91.policy.lockout', `Lockout after ${failures} failures turns a stale password in one integration into a locked root account.`, { remediation: 'Five is a common setting. Service accounts retry automatically and hit a low limit first.', source: SRC }));
        }
      }
      if (needsInstances && instances.length === 0) {
        findings.push(error('fleet91.policy.no-instances', 'No instance FQDNs were given, so there is nothing to apply the policy to or remove it from.', { source: SRC }));
      }
      findings.push(info('fleet91.policy.911', 'In 9.1.1 the policy also covers VCF Automation, VCF Operations for networks and cloud proxies. On 9.1.0 those keep their own local policy.', { source: SRC }));

      const policy = {
        name: policyName,
        description: 'Written by ArchToolKit.',
        complexityConstraints: { minLength: len, minLowercase: lower, minUppercase: upper, minNumeric: digits, minSpecial: special, passwordHistory: history },
        expirationConstraints: { maxDays, warnDays },
        lockoutConstraints: { lockoutMaxAuthFailures: failures, lockoutEvaluationPeriod: lockWindow, lockoutPeriod: lockPeriod },
      };

      const report = readScript('vcf-fleet', 'Password policies, when each was last changed, and which component groups comply.', [
        ...fleetApi(),
        'PROBLEMS=()',
        'echo "Password policies (fleet = the fallback for every instance):"',
        'api POST "${FM}/password-policies/query?page=0&pageSize=1000&sortBy=updatedAt&sortOrder=DESCENDING" --data \'{}\' \\',
        '  | jq -r \'.policies[]? | "  \\(.name)\\t fleet=\\(.fleet // false)\\t length>=\\(.complexityConstraints.minLength)\\t expiry=\\(.expirationConstraints.maxDays)d\\t history=\\(.complexityConstraints.passwordHistory)\\t updated \\((.updatedAt // 0) / 1000 | strftime("%Y-%m-%d %H:%M UTC"))"\'',
        'echo',
        'echo "Component groups:"',
        '# Every page, or the script stops: a group on page two is still a group.',
        'GROUPS_JSON=$(query_all "${FM}/password-policies/component-groups/query" \'{}\' results \'\')',
        'if [[ "$(jq length <<<"$GROUPS_JSON")" == "0" ]]; then echo "No component groups returned: cannot judge compliance." >&2; exit 1; fi',
        'jq -r \'.[] | "  \\(.componentGroup)\\t\\(.componentGroupResourceFqdn // .componentGroupResourceName)\\t\\(.policyName // "-")\\t\\(.componentGroupComplianceStatus // "NO STATUS")\\t checked \\((.complianceUpdatedAt // 0) / 1000 | strftime("%Y-%m-%d"))"\' <<<"$GROUPS_JSON"',
        '# Anything not explicitly COMPLIANT is a problem, including a missing status.',
        'NONCOMPLIANT=$(jq -r \'.[] | select((.componentGroupComplianceStatus // "") != "COMPLIANT") | "\\(.componentGroupResourceFqdn // .componentGroupResourceName // "?"): \\(.componentGroupComplianceStatus // "no compliance status")"\' <<<"$GROUPS_JSON")',
        'while IFS= read -r line; do if [[ -n "$line" ]]; then PROBLEMS+=("$line"); fi; done <<<"$NONCOMPLIANT"',
        'echo',
        'echo "Accounts by last password change (9.1.1 shows the date; VERIFY the field name on your release):"',
        'query_all "${FM}/password-management/accounts/query" \'{}\' vcfPasswordAccounts passwordAccountKey \\',
        '  | jq -r \'sort_by(.lastPasswordUpdateTimestamp // 0)[] | "  \\(.appliance)\\t\\(.applianceFqdn)\\t\\(.userName)\\t\\(.status)\\t changed \\(if (.lastPasswordUpdateTimestamp // 0) > 0 then (.lastPasswordUpdateTimestamp / 1000 | strftime("%Y-%m-%d")) else "unknown" end)"\'',
        '',
        'if (( ${#PROBLEMS[@]} == 0 )); then echo "Every component group is compliant."; exit 0; fi',
        'printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...notify(webhook, 'vcf-password-policy'),
        'exit 1',
      ]);

      const groupsFilter = JSON.stringify({ componentGroupResourceFqdns: instances.length ? instances : ['<REQUIRED — instance FQDN>'] });
      const policyScript = [
        ...head(mode === 'detach' ? `Remove password policy "${policyName}" from named VCF instances (9.1.1).` : `Create or update password policy "${policyName}" and apply it to ${target === 'FLEET' ? 'the fleet' : target === 'MANAGEMENT' ? 'the management components' : 'named instances'}.`, [
          'Without --execute it shows what it would change and sends nothing.',
          'Before changing anything it exports every existing policy to',
          'policies-before-<time>.json — that file is the undo.',
        ]),
        ...parseArgs(),
        `POLICY_NAME=${sq(policyName)}`,
        `MODE=${mode}`,
        `TARGET=${target}`,
        '',
        '# Guardrail: no policy task is still running. Two overlapping tasks on',
        '# the same component group leave its compliance state meaningless.',
        '# Every page of tasks is read; an unreadable list stops the script.',
        'RUNNING=$(query_all "${FM}/password-policies/component-groups/tasks/query" \'{}\' \'results|tasks\' \'\' \\',
        '  | jq \'[.[] | select((.taskStatus // "") | IN("IN_PROGRESS","PENDING","QUEUED","RUNNING"))] | length\')',
        'if (( RUNNING > 0 )); then echo "Refusing: ${RUNNING} password policy task(s) still in progress." >&2; exit 1; fi',
        '',
        '# Matched by exact name here as well as in the query: a server that ignored',
        '# the filter would otherwise hand back some other policy to overwrite.',
        'EXISTING=$(api POST "${FM}/password-policies/query?page=0&pageSize=1000" --data "$(jq -n --arg n "$POLICY_NAME" \'{policyNames: [$n]}\')" \\',
        '  | jq -r --arg n "$POLICY_NAME" \'if (.policies | type) != "array" then error("no policies array") else [.policies[] | select(.name == $n)] end',
        '      | if length > 1 then error("\\(length) policies share the name") else (.[0].id // empty) end\')',
        ...(needsInstances
          ? [
              `WANT_FQDNS=${sq(JSON.stringify(instances))}`,
              '# Filtered by the server and again here, so a filter the server ignored',
              '# cannot widen the change.',
              `GROUP_IDS=$(query_all "\${FM}/password-policies/component-groups/query" ${sq(groupsFilter)} results '' \\`,
              `  | jq -c --argjson want "$WANT_FQDNS" '[.[] | select(.componentGroupResourceFqdn as $f | $want | index($f)) | .componentGroupResourceId // error("a component group has no componentGroupResourceId")]')`,
              `WANTED=${instances.length}`,
              'FOUND=$(jq length <<<"$GROUP_IDS")',
              'if (( FOUND != WANTED )); then',
              '  echo "Refusing: ${WANTED} instance FQDN(s) given, ${FOUND} component group(s) matched. Check the names against the report." >&2',
              '  exit 1',
              'fi',
            ]
          : ['GROUP_IDS=\'[]\'']),
        '',
        'if (( DRY_RUN )); then',
        '  if [[ "$MODE" == "detach" ]]; then',
        '    echo "DRY RUN: would detach policy \\"${POLICY_NAME}\\" (${EXISTING:-not found}) from component groups ${GROUP_IDS}."',
        '  else',
        '    if [[ -n "$EXISTING" ]]; then WHAT="update policy ${EXISTING}"; else WHAT="create a new policy"; fi',
        '    echo "DRY RUN: would ${WHAT} from policy.json, then apply it to ${TARGET} ${GROUP_IDS}."',
        '  fi',
        '  echo "Nothing was changed. Run password-policy-report.sh to see where things stand, then re-run with --execute."',
        '  exit 0',
        'fi',
        '',
        'STAMP=$(date +%Y%m%d-%H%M%S)',
        'api POST "${FM}/password-policies/export" --data \'{}\' > "policies-before-${STAMP}.json"',
        'jq -e \'. != null and . != {} and . != []\' "policies-before-${STAMP}.json" >/dev/null || { echo "Refusing: the policy export is empty or not JSON, so there would be no undo." >&2; exit 1; }',
        'echo "Existing policies exported to policies-before-${STAMP}.json"',
        '',
        'if [[ "$MODE" == "detach" ]]; then',
        '  [[ -n "$EXISTING" ]] || { echo "No policy named ${POLICY_NAME}." >&2; exit 1; }',
        '  BODY=$(jq -n --arg p "$EXISTING" --argjson ids "$GROUP_IDS" \'{taskType: "POLICY_DETACH", policyId: $p, targetComponentGroups: {componentGroups: ["INSTANCE"], componentGroupResourceIds: $ids}}\')',
        '  POLICY_ID="$EXISTING"',
        'else',
        '  if [[ -n "$EXISTING" ]]; then',
        '    # VERIFY: the update body is the create body plus the id.',
        '    POLICY_ID=$(jq --arg id "$EXISTING" \'. + {id: $id}\' policy.json | api PUT "${FM}/password-policies" --data @- | jq -r \'.id // empty\')',
        '  else',
        '    POLICY_ID=$(api POST "${FM}/password-policies" --data @policy.json | jq -r \'.id // empty\')',
        '  fi',
        '  [[ -n "$POLICY_ID" ]] || { echo "The policy was sent but no id came back; check Fleet management > Passwords before re-running." >&2; exit 1; }',
        '  echo "Policy ${POLICY_ID}"',
        '  if [[ "$TARGET" == "INSTANCE" ]]; then',
        '    BODY=$(jq -n --arg p "$POLICY_ID" --argjson ids "$GROUP_IDS" \'{taskType: "POLICY_APPLY", policyId: $p, targetComponentGroups: {componentGroups: ["INSTANCE"], componentGroupResourceIds: $ids}}\')',
        '  else',
        '    BODY=$(jq -n --arg p "$POLICY_ID" --arg g "$TARGET" \'{taskType: "POLICY_APPLY", policyId: $p, targetComponentGroups: {componentGroups: [$g], componentGroupResourceIds: []}}\')',
        '  fi',
        'fi',
        '',
        'TASK=$(api POST "${FM}/password-policies/component-groups/tasks" --data "$BODY" | jq -r \'.taskId // empty\')',
        '[[ -n "$TASK" ]] || { echo "The policy task was sent but no taskId came back; check the password policy task history." >&2; exit 1; }',
        'echo "Policy task ${TASK}"',
        'STATUS=UNKNOWN',
        'for _ in $(seq 1 120); do',
        '  refresh_token',
        '  STATUS=$(api GET "${FM}/password-policies/component-groups/tasks/${TASK}" | jq -r \'.taskStatus // "UNKNOWN"\')',
        '  echo "  ${STATUS}"',
        '  case "$STATUS" in',
        '    IN_PROGRESS|PENDING) sleep 15 ;;',
        '    *) break ;;',
        '  esac',
        'done',
        'api GET "${FM}/password-policies/component-groups/tasks/${TASK}" | jq \'{taskStatus, componentGroupsComplianceStatistics}\'',
        '[[ "$STATUS" == "COMPLETED" || "$STATUS" == "SUCCEEDED" ]] || { echo "Task ended ${STATUS}. Read the component states above before retrying (taskType POLICY_RETRY)." >&2; exit 1; }',
        '',
      ].join('\n');

      const files                         = {
        'password-policy-report.sh': report,
        'crontab.txt': cron(base, '0 6 * * 1', 'password-policy-report.sh'),
      };
      if (mode !== 'report') {
        files['password-policy.sh'] = policyScript;
        if (mode === 'apply') files['policy.json'] = json(policy);
      }
      files['IMPORT.md'] = fleetImport(
        mode === 'apply'
          ? 'policy.json is exactly the body of POST .../fleet-management/password-policies (a PUT to update adds the existing id). Password policies have no file import in the interface.'
          : 'Nothing is imported: the report reads the policies and accounts.',
        [
          cronStep('password-policy-report.sh'),
          mode !== 'report'
            ? { heading: mode === 'apply' ? 'Create or update the policy, then apply it' : 'Apply the policy', lines: ['`./password-policy.sh` (dry run), then `--execute`. In the interface: Manage > Fleet management > Passwords > Password policies (VERIFY the menu name on your build).'] }
            : undefined,
        ],
      );

      return {
        platform: PLATFORM,
        title: mode === 'report' ? 'Report VCF password policies and compliance' : mode === 'detach' ? `Remove password policy "${policyName}" from ${instances.length} instance(s)` : `Password policy "${policyName}" on ${target === 'FLEET' ? 'the fleet' : target === 'MANAGEMENT' ? 'the management components' : `${instances.length} instance(s)`}`,
        effect: mode === 'report' ? 'read' : 'reversible',
        trigger: { kind: mode === 'report' ? 'schedule' : 'manual', detail: mode === 'report' ? 'Weekly, from a scheduler outside VCF Operations.' : 'Run by hand when the standard changes; the report runs weekly.', worstCase: mode === 'report' ? 'once a week' : 'once per run; the policy then applies at every password change on every covered account' },
        scope: {
          what: mode === 'report' ? 'Every password policy and component group VCF Operations manages. Reads only.' : `Every account in the ${needsInstances ? `component groups of ${instances.join(', ')}` : target === 'FLEET' ? 'fleet — every instance that has no policy of its own' : 'management component group'}.`,
          decidedBy: [
            'POST /password-policies/component-groups/query — the component groups VCF Operations manages.',
            needsInstances ? `Filtered to componentGroupResourceFqdns ${instances.join(', ')}, and refused if the count matched is not ${instances.length}.` : 'No filter: the fleet policy is the fallback for every instance without its own.',
            'Which accounts each component group holds, which VCF Operations decides, not this script.',
          ],
          ifWrong: 'A stricter policy on accounts whose integrations still use a password that no longer complies. Nothing changes until the next rotation or expiry, and then those logins start failing.',
        },
        guardrails: [
          { rule: 'Refuses while any password policy task is in progress', because: 'Overlapping apply tasks leave component groups showing a compliance that belongs to neither policy.' },
          { rule: 'Refuses when the instance FQDNs do not all match a component group', because: 'A typo would otherwise apply the policy to fewer instances than the change record says.' },
          { rule: 'Exports every existing policy before changing anything', because: 'The previous values are the undo, and nobody writes them down beforehand.' },
          { rule: 'The generator rejects minimums that add up to more than the length, and a warning period longer than the expiry', because: 'Both are accepted by the API and make every later rotation fail.' },
        ],
        dryRun: ['Run password-policy.sh without --execute: it resolves the policy and the component groups and says what it would send.', 'Run password-policy-report.sh first; it only reads.'],
        undo: [
          'Re-create the previous values from policies-before-<time>.json with PUT /password-policies, then apply again.',
          'On 9.1.1, detaching a policy from an instance makes it fall back to the fleet policy.',
          'A password already changed under the new policy stays changed.',
        ],
        told: [webhook ? `${webhook}, when a component group is non-compliant, failed or has no policy.` : 'The exit code only.', 'VCF Operations records the task under the password policy task history.'],
        requires: ['An API client with vcf_password.manage (and administration.fleetSettings.password.* on 9.1) — see fleet91_api_clients.', 'Every VCF component at 9.1 or later: the policy page is unavailable until they are (9.1.1 known issue).', 'jq and bash 4.'],
        files,
        notes: [
          'Confirmed against the VCF Operations API reference (Fleet Password Policy Management): create, query, export, component-groups query and tasks with POLICY_APPLY and POLICY_DETACH.',
          'VERIFY: the PUT /password-policies update body — the reference shows the create shape; this adds the policy id to it.',
          'Policy changes do not rotate anything. Accounts are brought into line at their next rotation; use POLICY_REMEDIATE (taskType) when you want it now.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet91_password_rotate',
    platform: PLATFORM,
    label: 'Rotate or update component passwords across the fleet (VCF 9.1)',
    group: 'Credentials (9.1 fleet)',
    description:
      'Query the password accounts VCF Operations manages — by appliance type, credential type, FQDN and status — and change them one at a time through the fleet password API, following each request to the end. One appliance type per run, a cap on accounts, and passwords that are either generated or read from a mode-600 file, never passed on a command line.',
    inputs: [
      { id: 'appliance', label: 'Appliance type', control: 'select', options: PW_APPLIANCES, default: 'ESX', hint: 'One type per run' },
      {
        id: 'credential_type',
        label: 'Credential type',
        control: 'combo',
        options: [
          { value: 'SSH', label: 'SSH (OS accounts such as root)' },
          { value: 'API', label: 'API / application accounts (VERIFY)' },
          { value: 'SSO', label: 'SSO accounts (VERIFY, 9.1.1)' },
        ],
        default: 'SSH',
      },
      { id: 'fqdns', label: 'Appliance FQDNs', control: 'text', default: 'esx01.example.com, esx02.example.com', hint: 'Comma separated. Empty means every appliance of the type' },
      { id: 'usernames', label: 'Usernames', control: 'text', default: 'root', hint: 'Empty means every account' },
      {
        id: 'status',
        label: 'Only accounts that are',
        control: 'select',
        options: [
          { value: '', label: 'Any status' },
          { value: 'ACTIVE', label: 'Active' },
          { value: 'EXPIRING', label: 'Expiring' },
          { value: 'EXPIRED', label: 'Expired' },
        ],
        default: '',
      },
      { id: 'max_accounts', label: 'Refuse above (accounts)', control: 'number', default: 10, min: 1, max: 200 },
      {
        id: 'source',
        label: 'New passwords',
        control: 'select',
        options: [
          { value: 'generate', label: 'Generate one per account, written to a mode-600 file' },
          { value: 'file', label: 'Read from the fourth column of the mode-600 file' },
        ],
        default: 'generate',
      },
      { id: 'length', label: 'Generated length', control: 'number', default: 20, min: 12, max: 64, showWhen: { input: 'source', equals: ['generate'] } },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-credentials' },
    ],
    automation: (values                 , name        )             => {
      const appliance = str(values, 'appliance', 'ESX');
      const credType = str(values, 'credential_type', 'SSH');
      const fqdns = listOf(str(values, 'fqdns', ''));
      const users = listOf(str(values, 'usernames', ''));
      const status = str(values, 'status', '');
      const max = num(values, 'max_accounts', 10);
      const source = str(values, 'source', 'generate');
      const length = num(values, 'length', 20);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || `rotate-${appliance}`, 'rotate');
      const label = PW_APPLIANCES.find((option) => option.value === appliance)?.label ?? appliance;

      const findings            = [];
      if (fqdns.length === 0) {
        findings.push(warning('fleet91.rotate.every-appliance', `No FQDN filter: this rotates ${label} accounts across every instance in the fleet.`, { remediation: 'Name the appliances, a handful at a time. A rotation that goes wrong should cost one host, not the fleet.', source: SRC }));
      }
      if (['IDENTITY_BROKER', 'VCF_OPERATIONS', 'VCF_SERVICES_RUNTIME'].includes(appliance)) {
        findings.push(warning('fleet91.rotate.self', `${label} is part of what runs the rotation. A failure there can take away the tool you would use to recover.`, { remediation: 'Rotate these last, one at a time, with the break-glass (emergency client) path tested beforehand.', source: SRC }));
      }
      if (appliance === 'VCENTER' || appliance === 'SDDC_MANAGER') {
        findings.push(info('fleet91.rotate.911-accounts', 'On 9.1.1 VCF Operations also manages the vCenter SSO administrator and the SDDC Manager root, admin@local and vcf accounts. On 9.1.0 they are not in the query.', { source: SRC }));
      }

      const filter                         = { credentialType: credType };
      if (status) filter.status = status;

      const rotate = [
        ...head(`Change ${label} ${credType} passwords through VCF Operations fleet management.`, [
          'Needs ROTATION_FILE: a mode-600 TSV, one line per account:',
          '  applianceFqdn <TAB> userName <TAB> currentPassword' + (source === 'file' ? ' <TAB> newPassword' : ''),
          'The fleet API needs the current password to change it. Accounts that',
          'match the query but have no line in the file are skipped and listed.',
          source === 'generate' ? 'Each new password is generated here and written to new-passwords-<time>.tsv' : 'New passwords are the fourth column of ROTATION_FILE. Each account is',
          source === 'generate' ? '(mode 600) marked PENDING BEFORE it is sent, then marked DONE, FAILED,' : 'written to rotation-state-<time>.tsv marked PENDING before it is sent, then',
          source === 'generate' ? 'REFUSED or UNKNOWN. Move DONE lines into your vault; resolve the rest first.' : 'marked DONE, FAILED, REFUSED or UNKNOWN.',
          '',
          '  ./rotate-passwords.sh             dry run: list what would change',
          '  ./rotate-passwords.sh --execute   change them, one at a time',
        ]),
        ...waitRequest(),
        ...needPrivate(),
        ...parseArgs(),
        ': "${ROTATION_FILE:?set ROTATION_FILE to the mode-600 TSV of current passwords}"',
        'need_private "$ROTATION_FILE"',
        `MAX=${max}`,
        `LEN=${length}`,
        'PROBLEMS=()',
        '',
        `FQDNS=${sq(JSON.stringify(fqdns))}`,
        `USERS=${sq(JSON.stringify(users))}`,
        `FILTER=${sq(JSON.stringify({ ...filter, appliance }))}`,
        '',
        '# One appliance type per run: the query below filters on it and nothing else',
        '# in this script can widen it.',
        'query_all "${FM}/password-management/accounts/query" "$FILTER" vcfPasswordAccounts passwordAccountKey \\',
        '  | jq -c --argjson f "$FQDNS" --argjson u "$USERS" \'[ .[]',
        '      | select(($f | length) == 0 or (.applianceFqdn as $x | $f | index($x)))',
        '      | select(($u | length) == 0 or (.userName as $x | $u | index($x))) ]\' > selected.json',
        'COUNT=$(jq length selected.json)',
        'echo "Selected ${COUNT} account(s):"',
        'jq -r \'.[] | "  \\(.applianceFqdn)\\t\\(.userName)\\t\\(.status)\\t\\(.credentialType // "-")"\' selected.json',
        'if (( COUNT == 0 )); then echo "Nothing matched the filter, so nothing was rotated. Check the names against the query." >&2; exit 1; fi',
        'if (( COUNT > MAX )); then echo "Refusing: ${COUNT} accounts is above the cap of ${MAX}. Narrow the filter or raise the cap on purpose." >&2; exit 1; fi',
        '',
        '# Which selected accounts have a line in the file (checked without printing any password).',
        'declare -A HAVE=()',
        'while IFS=$\'\\t\' read -r F U _REST; do if [[ -n "$F" ]]; then HAVE["${F}|${U}"]=1; fi; done < "$ROTATION_FILE"',
        'MISSING=$(jq -r \'.[] | "\\(.applianceFqdn)|\\(.userName)"\' selected.json | while IFS= read -r k; do [[ -n "${HAVE[$k]:-}" ]] || echo "$k"; done)',
        'if [[ -n "$MISSING" ]]; then echo "No line in ROTATION_FILE for (these are skipped):"; printf "  %s\\n" $MISSING; fi',
        '',
        'if (( DRY_RUN )); then',
        '  echo "DRY RUN: nothing was changed. Re-run with --execute to change the accounts above that have a line in the file."',
        '  exit 0',
        'fi',
        'if [[ -n "$MISSING" ]]; then for k in $MISSING; do PROBLEMS+=("${k/|/ }: no line in ROTATION_FILE, not rotated"); done; fi',
        '',
        ...(source === 'generate'
          ? [
              'gen_password() {',
              '  local p',
              '  while :; do',
              '    p=$(openssl rand 2048 | LC_ALL=C tr -dc \'A-Za-z0-9#%+=@^_~.,-\' | cut -c "1-${LEN}")',
              '    if [[ ${#p} -eq $LEN && "$p" =~ [A-Z] && "$p" =~ [a-z] && "$p" =~ [0-9] && "$p" =~ [^A-Za-z0-9] ]]; then break; fi',
              '  done',
              '  printf \'%s\' "$p"',
              '}',
              'command -v openssl >/dev/null || { echo "openssl is required to generate passwords" >&2; exit 2; }',
            ]
          : []),
        '# The ledger. Each account gets its line BEFORE its request is sent, marked',
        '# PENDING, and the line is updated to DONE, FAILED, REFUSED or UNKNOWN',
        '# afterwards. If the request times out, the proxy answers 504, or this',
        '# script is killed, the line stays PENDING or UNKNOWN — and the password',
        '# that may now be in effect is still written down.',
        ...(source === 'generate'
          ? [
              'OUT="new-passwords-$(date +%Y%m%d-%H%M%S).tsv"',
              'NEW_AT="${OUT}"',
            ]
          : [
              'OUT="rotation-state-$(date +%Y%m%d-%H%M%S).tsv"',
              'NEW_AT="column 4 of ${ROTATION_FILE}"',
            ]),
        '( umask 077; printf \'# applianceFqdn\\tuserName\\t%s\\tstate\\tnote — PENDING, UNKNOWN and FAILED lines may be in effect\\n\' ' + (source === 'generate' ? "'newPassword'" : "'(new password: ROTATION_FILE)'") + ' > "$OUT" )',
        'need_private "$OUT"',
        'LOG="rotation-$(date +%Y%m%d-%H%M%S).log"',
        '',
        '# set_state <line> <state> <note>: rewrite one ledger line through a mode-600',
        '# temp file in the same directory, then rename it into place.',
        'set_state() {',
        '  local n="$1" st="$2" note="$3" tmp',
        '  tmp=$(umask 077; mktemp "${OUT}.XXXXXX") || return 1',
        '  if awk -F\'\\t\' -v OFS=\'\\t\' -v n="$n" -v st="$st" -v note="$note" \'NR == n { $4 = st; $5 = note } { print }\' "$OUT" > "$tmp" && mv -f "$tmp" "$OUT"; then return 0; fi',
        '  rm -f "$tmp"; return 1',
        '}',
        'record() {',
        '  set_state "$LINE" "$1" "$2" || echo "WARNING: could not update ${OUT} line ${LINE}; it still reads PENDING. Treat it as $1." >&2',
        '  echo "$(date -u +%FT%TZ) ${FQDN} ${ACCT} $1 $2" >> "$LOG"',
        '}',
        'unknown_outcome() {',
        '  {',
        '    echo',
        '    echo "!!! OUTCOME UNKNOWN for ${FQDN} ${ACCT}: $1"',
        '    echo "!!! The NEW password may already be in effect. It is kept in ${NEW_AT}; ledger ${OUT} line ${LINE} is marked UNKNOWN."',
        '    echo "!!! Try the new password first, then the old one. Do not delete ${OUT} or re-run until you know which works."',
        '    echo',
        '  } >&2',
        '}',
        '',
        'ROWS=$(jq -r \'.[] | [.passwordAccountKey, .applianceFqdn, .userName] | @tsv\' selected.json)',
        'while IFS=$\'\\t\' read -r KEY FQDN ACCT; do',
        '  [[ -n "$KEY" ]] || continue',
        '  CUR=""; NEW=""',
        '  while IFS=$\'\\t\' read -r F U C N; do',
        '    if [[ "$F" == "$FQDN" && "$U" == "$ACCT" ]]; then CUR="$C"; NEW="${N:-}"; break; fi',
        '  done < "$ROTATION_FILE"',
        '  [[ -n "$CUR" ]] || continue',
        ...(source === 'generate'
          ? ['  NEW=$(gen_password)']
          : ['  if [[ -z "$NEW" ]]; then PROBLEMS+=("${FQDN} ${ACCT}: no new password in column 4"); continue; fi']),
        '  refresh_token || { PROBLEMS+=("${FQDN} ${ACCT}: could not renew the access token; nothing sent"); break; }',
        '',
        '  # Written down first. If this fails, nothing is sent.',
        '  LINE=$(( $(wc -l < "$OUT") + 1 ))',
        ...(source === 'generate'
          ? ['  if ! printf \'%s\\t%s\\t%s\\t%s\\t%s\\n\' "$FQDN" "$ACCT" "$NEW" PENDING "sent $(date -u +%FT%TZ)" >> "$OUT"; then']
          : ['  if ! printf \'%s\\t%s\\t%s\\t%s\\t%s\\n\' "$FQDN" "$ACCT" "-" PENDING "sent $(date -u +%FT%TZ)" >> "$OUT"; then']),
        '    PROBLEMS+=("${FQDN} ${ACCT}: could not write the ledger; nothing sent"); break',
        '  fi',
        '  echo "$(date -u +%FT%TZ) ${FQDN} ${ACCT} PENDING" >> "$LOG"',
        '',
        '  # The body goes on stdin; neither password is ever an argument. The HTTP',
        '  # status decides what is known: 2xx with a requestId is followed, 4xx is a',
        '  # refusal, anything else (000 = timeout or no answer, 5xx, 2xx without a',
        '  # requestId) may have gone through and is UNKNOWN.',
        '  RESP=$(mktemp)',
        '  CODE=$(CUR="$CUR" NEW="$NEW" jq -n \'{currentPassword: env.CUR, newPassword: env.NEW}\' \\',
        '    | curl -sS -o "$RESP" -w \'%{http_code}\' --max-time 120 -X PUT "https://${VCFOPS_HOST}${FM}/password-management/accounts/${KEY}/password" \\',
        `        -H "${authHeader('vcf-fleet')}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @-) || true`,
        '  CODE="${CODE:-000}"',
        '  REQ=$(jq -r \'.requestId // empty\' "$RESP" 2>/dev/null) || REQ=""',
        '  WHY=$(jq -r \'.message // .errorMessage // empty\' "$RESP" 2>/dev/null | head -c 300) || WHY=""',
        '  rm -f "$RESP"',
        '  if [[ "$CODE" == 2?? && -n "$REQ" ]]; then',
        '    echo "${FQDN} ${ACCT}: request ${REQ}"',
        '    wait_request "$REQ" && RC=0 || RC=$?',
        '    case "$RC" in',
        '      0) record DONE "request ${REQ}" ;;',
        '      1) record FAILED "request ${REQ} reported failed — may still have changed (9.1.1 known issue)"',
        '         PROBLEMS+=("${FQDN} ${ACCT}: request ${REQ} reported failed; the new password is kept in ${NEW_AT} — check which one works. Stopping here.")',
        '         break ;;',
        '      *) record UNKNOWN "request ${REQ} not followed to the end"',
        '         unknown_outcome "request ${REQ} could not be followed to the end"',
        '         PROBLEMS+=("${FQDN} ${ACCT}: OUTCOME UNKNOWN (request ${REQ}); new password kept in ${NEW_AT}. Stopping here.")',
        '         break ;;',
        '    esac',
        '  elif [[ "$CODE" == 4?? && "$CODE" != 408 && "$CODE" != 429 ]]; then',
        '    record REFUSED "HTTP ${CODE}${WHY:+: ${WHY}}"',
        '    PROBLEMS+=("${FQDN} ${ACCT}: refused (HTTP ${CODE})${WHY:+: ${WHY}}. Stopping here.")',
        '    break',
        '  else',
        '    record UNKNOWN "HTTP ${CODE}, no requestId"',
        '    unknown_outcome "HTTP ${CODE} and no requestId — the change may have gone through"',
        '    PROBLEMS+=("${FQDN} ${ACCT}: OUTCOME UNKNOWN (HTTP ${CODE}); new password kept in ${NEW_AT}. Stopping here.")',
        '    break',
        '  fi',
        'done <<<"$ROWS"',
        '',
        'echo "Record (no passwords): ${LOG}"',
        'echo "Ledger: ${OUT} (mode 600) — $(awk -F\'\\t\' \'NR > 1 { n[$4]++ } END { for (s in n) printf "%s %d  ", s, n[s] }\' "$OUT")"',
        ...(source === 'generate'
          ? ['echo "New passwords: ${OUT}. Move every DONE line into the vault now; resolve any FAILED, UNKNOWN or PENDING line by trying it before you delete the file."']
          : []),
        'if (( ${#PROBLEMS[@]} > 0 )); then',
        '  printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...notify(webhook, 'vcf-fleet-password-rotation').map((line) => `  ${line}`),
        '  exit 1',
        'fi',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Change ${label} ${credType} passwords${fqdns.length ? ` on ${fqdns.length} appliance(s)` : ' across the fleet'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Run by hand in a change window, one appliance type at a time, or after a password policy change.', worstCase: `once per run, at most ${max} accounts` },
        scope: {
          what: `${label} accounts of credential type ${credType}${fqdns.length ? ` on ${fqdns.join(', ')}` : ' on every appliance of that type'}${users.length ? `, named ${users.join(', ')}` : ''}${status ? `, status ${status}` : ''} — and only those with a line in ROTATION_FILE.`,
          decidedBy: [
            `POST /password-management/accounts/query with appliance ${appliance}, credentialType ${credType}${status ? `, status ${status}` : ''}.`,
            fqdns.length ? `Filtered to applianceFqdn ${fqdns.join(', ')}.` : 'No FQDN filter.',
            users.length ? `Filtered to userName ${users.join(', ')}.` : 'No username filter.',
            `Refused outright above ${max} accounts.`,
            'Skipped when ROTATION_FILE has no current password for it.',
          ],
          ifWrong: 'Accounts that an outside tool — backup, monitoring, a script — logs in with stop working until that tool is given the new password.',
        },
        guardrails: [
          { rule: 'One appliance type per run', because: 'A failure in a mixed run is much harder to reason about than a failure in one type.' },
          { rule: `Refuses above ${max} accounts`, because: 'A filter that went wrong should stop, not rotate the fleet.' },
          { rule: 'Refuses a password file that is not mode 600 or 400', because: 'The file holds every current password in the run.' },
          { rule: 'Passwords go to the API on stdin, never as an argument', because: 'Arguments are visible to every user on the machine in the process list.' },
          { rule: 'One account at a time, and stops at the first request that does not complete', because: 'A second failure on top of the first buries the one you need to fix.' },
          ...(source === 'generate'
            ? [{ rule: 'Each new password is written to the mode-600 file, marked PENDING, before its request is sent, and only then marked DONE, FAILED, REFUSED or UNKNOWN', because: 'A timeout or a proxy 504 after the change went through would otherwise leave an account with a password nobody has — a lockout.' }]
            : [{ rule: 'Each account is marked PENDING in rotation-state-<time>.tsv before its request is sent, then DONE, FAILED, REFUSED or UNKNOWN', because: 'After a timeout or a proxy 504 you need to know which accounts may be on the new password.' }]),
          { rule: 'Refuses to act on a partial account list: every page is read, and a response it does not recognise stops the run', because: 'Rotating from page one of a larger list leaves accounts behind while the run reports success.' },
        ],
        dryRun: ['Run rotate-passwords.sh without --execute. It lists every account it would change and every account it would skip, and sends nothing.'],
        undo: [
          'Run again with a ROTATION_FILE whose third column is the new password and fourth column the old one (source "file").',
          source === 'generate' ? 'The generated passwords are in new-passwords-<time>.tsv, each written before it was sent. A line marked PENDING, UNKNOWN or FAILED may or may not be in effect — try the new password, then the old one.' : 'The previous passwords are the third column of your ROTATION_FILE; rotation-state-<time>.tsv says which accounts were DONE, and which are UNKNOWN or FAILED and need trying both ways.',
          'A password history in the policy may refuse the old password; lower it temporarily if you must put one back.',
        ],
        told: [webhook ? `${webhook}, when a change is refused or does not complete.` : 'The exit code only.', 'rotation-<time>.log beside the script, without passwords.', 'VCF Operations records each request under its password management tasks (all local account operations are audited in 9.1.1).'],
        requires: ['An API client with vcf_password.manage — see fleet91_api_clients.', 'The current passwords, from your vault, in a mode-600 file.', 'jq, bash 4' + (source === 'generate' ? ' and openssl.' : '.')],
        files: {
          'rotate-passwords.sh': rotate,
          'IMPORT.md': fleetImport('Nothing is uploaded as a file: the rotation request names accounts read from the fleet at run time.', [{ heading: 'Rotate', lines: ['`./rotate-passwords.sh` (dry run: lists the accounts), then `--execute`.'] }]),
        },
        notes: [
          'Confirmed: POST /password-management/accounts/query and PUT /password-management/accounts/{passwordAccountKey}/password {currentPassword, newPassword} returning a requestId, followed at /suite-api/api/workflows/requests/{requestId} (davidwzhang.com part 3; VCF Operations API reference).',
          'VERIFY: credentialType values other than SSH. The reference documents pageSize (default 10) but no maximum; the script asks for 1000 per page and keeps paging until an empty page or pageInfo.totalCount, and stops rather than rotate from a partial list.',
          'Generated passwords use A-Z, a-z, 0-9 and #%+=@^_~.,- . If an appliance refuses a character, the request fails and the run stops there.',
          '9.1.1 known issue: an update can be marked failed although the component changed, when an integration credential is orphaned. Check the component before retrying.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet91_certificates',
    platform: PLATFORM,
    label: 'Certificate lifecycle across the fleet (VCF 9.1)',
    group: 'Certificates (9.1 fleet)',
    description:
      'Report every fleet certificate expiring inside a window (read-only, exit code for a scheduler), and replace one appliance’s certificate at a time: CSR to an external CA and back, through an integrated Microsoft CA, or (9.1.1) with a VMCA-signed certificate. Each replacement is its own step, dry run by default, followed to the end.',
    inputs: [
      {
        id: 'action',
        label: 'Do',
        control: 'select',
        options: [
          { value: 'report', label: 'Report expiring certificates only' },
          { value: 'external', label: 'Replace: CSR, signed by an external CA, then install' },
          { value: 'msca', label: 'Replace: through an integrated Microsoft CA' },
          { value: 'vmca', label: 'Replace: with a VMCA-signed certificate (9.1.1)' },
        ],
        default: 'report',
      },
      { id: 'within_days', label: 'Report certificates expiring within (days)', control: 'number', default: 60, min: 1, max: 730 },
      { id: 'appliance', label: 'Appliance type', control: 'select', options: CERT_APPLIANCES, default: 'VCENTER', showWhen: { input: 'action', notEquals: ['report'] } },
      { id: 'fqdn', label: 'Appliance FQDN', control: 'text', default: 'vcenter-mgmt.example.com', hint: 'One appliance per run', showWhen: { input: 'action', notEquals: ['report'] } },
      { id: 'country', label: 'CSR country', control: 'text', default: 'GB', showWhen: { input: 'action', equals: ['external', 'msca'] } },
      { id: 'state', label: 'CSR state', control: 'text', default: 'London', showWhen: { input: 'action', equals: ['external', 'msca'] } },
      { id: 'locality', label: 'CSR locality', control: 'text', default: 'London', showWhen: { input: 'action', equals: ['external', 'msca'] } },
      { id: 'org', label: 'CSR organisation', control: 'text', default: 'Example Ltd', showWhen: { input: 'action', equals: ['external', 'msca'] } },
      { id: 'org_unit', label: 'CSR organisational unit', control: 'text', default: 'Infrastructure', showWhen: { input: 'action', equals: ['external', 'msca'] } },
      {
        id: 'key_size',
        label: 'Key size',
        control: 'select',
        options: [
          { value: 'KEY_2048', label: 'RSA 2048' },
          { value: 'KEY_3072', label: 'RSA 3072 (VERIFY)' },
          { value: 'KEY_4096', label: 'RSA 4096 (VERIFY)' },
        ],
        default: 'KEY_2048',
        showWhen: { input: 'action', equals: ['external', 'msca'] },
      },
      { id: 'msca_url', label: 'Microsoft CA URL', control: 'text', default: 'https://ca.example.com/certsrv', showWhen: { input: 'action', equals: ['msca'] } },
      { id: 'msca_template', label: 'Certificate template', control: 'text', default: 'VMware', showWhen: { input: 'action', equals: ['msca'] } },
      { id: 'msca_user', label: 'CA service account', control: 'text', default: 'EXAMPLE\\svc-vcf-certs', showWhen: { input: 'action', equals: ['msca'] } },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-certificates' },
    ],
    automation: (values                 , name        )             => {
      const action = str(values, 'action', 'report');
      const within = num(values, 'within_days', 60);
      const appliance = str(values, 'appliance', 'VCENTER');
      const fqdn = str(values, 'fqdn', '');
      const country = str(values, 'country', 'GB');
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'certificates', 'certificates');
      const replacing = action !== 'report';
      const caType = action === 'external' ? 'EXTERNAL_CA' : action === 'msca' ? 'MSCA' : 'VMCA';

      const findings            = [];
      if (within < 30) findings.push(warning('fleet91.cert.window', `${within} days is less than an enterprise CA usually takes to sign and a change board to approve.`, { remediation: 'Report at 60 days; 9.1.1 raises its own expiry alarms at 30.', source: SRC }));
      if (replacing && (!fqdn || /[,\s]/.test(fqdn))) findings.push(error('fleet91.cert.one-appliance', 'Give exactly one appliance FQDN. Replacement is one appliance per run.', { source: SRC }));
      if (action === 'external' || action === 'msca') {
        if (!/^[A-Za-z]{2}$/.test(country)) findings.push(error('fleet91.cert.country', `CSR country "${country}" is not a two-letter code; CSR generation will be refused.`, { source: SRC }));
      }
      if (action === 'vmca') findings.push(info('fleet91.cert.vmca', 'Replacing with a VMCA-signed certificate is new in 9.1.1. Clients that trusted your enterprise CA will need the VMCA root instead.', { source: SRC }));

      const report = readScript('vcf-fleet', `Which fleet certificates expire within ${within} days?`, [
        ...fleetApi(),
        `WITHIN=${within}`,
        'PROBLEMS=()',
        '# Every TLS certificate VCF Operations manages. daysToExpire and status',
        '# (EXPIRED, EXPIRING_30, EXPIRING_60, NORMAL) come from the fleet API.',
        '# Every page, or the script stops non-zero: "nothing expires" is only said',
        '# after the whole list has been read.',
        'query_all "${FM}/certificate-management/certificates/query" \'{"category":"TLS_CERT"}\' vcfCertificateModels certificateResourceKey > certificates.json',
        'TOTAL=$(jq length certificates.json)',
        'echo "${TOTAL} certificate(s) known to VCF Operations."',
        'if (( TOTAL == 0 )); then echo "VCF Operations returned no certificates at all; a fleet always has some. Cannot judge expiry." >&2; PROBLEMS+=("no certificates returned by the fleet certificate query"); fi',
        'EXPIRING=$(jq -r --argjson w "$WITHIN" \'',
        '  sort_by(.daysToExpire // -1)[]',
        '  | select(.status == "EXPIRED" or (.daysToExpire | type) != "number" or .daysToExpire <= $w)',
        '  | "\\(.appliance)\\t\\(.applianceFqdn)\\t\\(.daysToExpire // "?") days\\t\\(.status)\\tissued by \\(.issuedBy // "?")\\tkey \\(.certificateResourceKey)"\' certificates.json)',
        'while IFS= read -r line; do if [[ -n "$line" ]]; then PROBLEMS+=("$line"); fi; done <<<"$EXPIRING"',
        'if (( ${#PROBLEMS[@]} == 0 )); then echo "No certificate expires within ${WITHIN} days."; exit 0; fi',
        'printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...notify(webhook, 'vcf-fleet-certificates'),
        'exit 1',
      ]);

      const csrSpec = {
        certificateId: '__CERTIFICATE_KEY__',
        generateCsrSpec: {
          commonName: fqdn || '<REQUIRED — appliance FQDN>',
          country,
          keySize: str(values, 'key_size', 'KEY_2048'),
          keyAlgorithm: 'RSA',
          locality: str(values, 'locality', ''),
          organization: str(values, 'org', ''),
          orgUnit: str(values, 'org_unit', ''),
          state: str(values, 'state', ''),
          subjectAltNames: '__SANS__',
        },
      };

      const replace = [
        ...head(`Replace the ${appliance} certificate on ${fqdn || '<one appliance>'} (${caType}).`, [
          ...(action === 'external'
            ? [
                '  ./replace-certificate.sh csr                    dry run, then --execute: generate the CSR, save <fqdn>.csr',
                '  (have <fqdn>.csr signed by your CA; build chain.pem: leaf, intermediates, root)',
                '  ./replace-certificate.sh install chain.pem      dry run, then --execute: install it',
              ]
            : action === 'msca'
              ? [
                  '  ./configure-msca.sh --execute                  once: point VCF Operations at the Microsoft CA',
                  '  ./replace-certificate.sh csr --execute         generate the CSR on the appliance',
                  '  ./replace-certificate.sh install --execute     VCF Operations has the CA sign it and installs it',
                ]
              : ['  ./replace-certificate.sh install --execute     replace with a VMCA-signed certificate (9.1.1)']),
          '',
          'One appliance per run: it refuses unless the query matches exactly one',
          'TLS certificate. Services on the appliance restart during the install.',
        ]),
        ...waitRequest(),
        ...parseArgs(),
        'STEP="${1:?csr or install}"',
        `APPLIANCE=${appliance}`,
        `FQDN=${sq(fqdn)}`,
        '',
        '# Filtered by the server, every page read, and filtered again here: a filter',
        '# field the server ignored must not widen the match.',
        'match_cert() {',
        '  query_all "${FM}/certificate-management/certificates/query" "$(jq -n --arg a "$APPLIANCE" --arg f "$FQDN" \'{appliance: $a, applianceFqdn: $f, category: "TLS_CERT"}\')" vcfCertificateModels certificateResourceKey \\',
        '    | jq -c --arg a "$APPLIANCE" --arg f "$FQDN" \'[.[] | select(.appliance == $a and ((.applianceFqdn // "") | ascii_downcase) == ($f | ascii_downcase))]\'',
        '}',
        'MATCH=$(match_cert)',
        'if [[ "$(jq length <<<"$MATCH")" != "1" ]]; then',
        '  echo "Refusing: expected exactly one TLS certificate for ${APPLIANCE} ${FQDN}, found $(jq length <<<"$MATCH")." >&2',
        '  jq -r \'.[] | "  \\(.certificateResourceKey)  \\(.issuedTo)"\' <<<"$MATCH" >&2',
        '  exit 1',
        'fi',
        'KEY=$(jq -r \'.[0].certificateResourceKey\' <<<"$MATCH")',
        'echo "Certificate ${KEY}: $(jq -r \'.[0] | "\\(.daysToExpire) days left, issued by \\(.issuedBy), status \\(.status)"\' <<<"$MATCH")"',
        '',
        'case "$STEP" in',
        '  csr)',
        ...(action === 'vmca'
          ? ['    echo "No CSR step for VMCA: run install." >&2; exit 2 ;;']
          : [
              '    BODY=$(jq --arg k "$KEY" --argjson c "$MATCH" \'.certificateId = $k | .generateCsrSpec.subjectAltNames = ($c[0].subjectAlternativeNames // .generateCsrSpec.commonName)\' csr-spec.json)',
              '    if (( DRY_RUN )); then echo "DRY RUN: would POST ${FM}/certificate-management/csrs:"; jq . <<<"$BODY"; exit 0; fi',
              '    REQ=$(api POST "${FM}/certificate-management/csrs" --data "$BODY" | jq -r \'.requestId // empty\')',
              '    [[ -n "$REQ" ]] || { echo "CSR generation was sent but no requestId came back; check VCF Operations before re-running." >&2; exit 1; }',
              '    wait_request "$REQ" 40 || exit 1',
              '    api GET "${FM}/certificate-management/csrs?commonName=${FQDN}" | jq -r \'[.. | objects | select(has("csr")) | .csr][0] // empty\' > "${FQDN}.csr"',
              '    [[ -s "${FQDN}.csr" ]] || { echo "The CSR was generated but could not be read back. Download it from VCF Operations." >&2; exit 1; }',
              `    echo "CSR written to \${FQDN}.csr.${action === 'external' ? ' Have it signed, build chain.pem, then run install.' : ' Now run install.'}"`,
              '    ;;',
            ]),
        '  install)',
        ...(action === 'external'
          ? [
              '    CHAIN="${2:?the PEM chain file: leaf, intermediates, root}"',
              '    grep -q "BEGIN CERTIFICATE" "$CHAIN" || { echo "$CHAIN is not a PEM chain." >&2; exit 2; }',
              '    command -v openssl >/dev/null && openssl x509 -in "$CHAIN" -noout -subject -enddate',
              '    if (( DRY_RUN )); then echo "DRY RUN: would PUT ${FM}/certificate-management/certificates/${KEY} with caType EXTERNAL_CA and ${CHAIN}."; exit 0; fi',
              '    REQ=$(jq -n --rawfile chain "$CHAIN" \'{caType: "EXTERNAL_CA", certificateChain: $chain}\' \\',
              '          | api PUT "${FM}/certificate-management/certificates/${KEY}" --data-binary @- | jq -r \'.requestId // empty\')',
            ]
          : [
              `    if (( DRY_RUN )); then echo "DRY RUN: would PUT \${FM}/certificate-management/certificates/\${KEY} with caType ${caType}."; exit 0; fi`,
              `    REQ=$(api PUT "\${FM}/certificate-management/certificates/\${KEY}" --data '{"caType":"${caType}"}' | jq -r '.requestId // empty')`,
            ]),
        '    [[ -n "$REQ" ]] || { echo "The replacement was sent but no requestId came back. Check the appliance in VCF Operations before re-running." >&2; exit 1; }',
        '    echo "Replacement request ${REQ}. This takes ten minutes or more; the appliance restarts services."',
        '    wait_request "$REQ" 240 && RC=0 || RC=$?',
        '    if (( RC == 2 )); then echo "Outcome UNKNOWN: check the certificate on ${FQDN} before doing anything else." >&2; exit 1; fi',
        '    if (( RC != 0 )); then exit 1; fi',
        '    refresh_token',
        '    MATCH=$(match_cert)',
        '    jq -r \'.[] | "Now: \\(.daysToExpire) days left, issued by \\(.issuedBy), key \\(.certificateResourceKey)"\' <<<"$MATCH"',
        '    ;;',
        '  *) echo "unknown step $STEP" >&2; exit 2 ;;',
        'esac',
        '',
      ].join('\n');

      const configureMsca = [
        ...head('Point VCF Operations certificate management at a Microsoft CA.', [
          'Needs MSCA_PASSWORD_FILE: a mode-600 file holding the CA service account password.',
          'Without --execute it prints the body with the secret masked.',
        ]),
        ...needPrivate(),
        ...parseArgs(),
        ': "${MSCA_PASSWORD_FILE:?set MSCA_PASSWORD_FILE to a mode-600 file holding the CA account password}"',
        'need_private "$MSCA_PASSWORD_FILE"',
        `CA_URL=${sq(str(values, 'msca_url', ''))}`,
        `CA_TEMPLATE=${sq(str(values, 'msca_template', ''))}`,
        `CA_USER=${sq(str(values, 'msca_user', ''))}`,
        'build() {',
        '  jq -n --rawfile s "$MSCA_PASSWORD_FILE" --arg url "$CA_URL" --arg tpl "$CA_TEMPLATE" --arg user "$CA_USER" --arg mask "$1" \\',
        '    \'{certificateAuthorityType: "MICROSOFT", certificateAuthoritiesSpec: {microsoftCertificateAuthoritySpec: {serverUrl: $url, templateName: $tpl, username: $user, secret: (if $mask == "mask" then "********" else ($s | rtrimstr("\\n")) end)}}}\'',
        '}',
        '# Shown for the record only; nothing below depends on it.',
        'echo "Current CA configuration:"; api GET "${FM}/certificate-management/certificate-authorities" | jq \'del(.. | .secret? // empty)\' || echo "  (could not be read)"',
        'if (( DRY_RUN )); then echo "DRY RUN: would PUT ${FM}/certificate-management/certificate-authorities:"; build mask; exit 0; fi',
        'build send | api PUT "${FM}/certificate-management/certificate-authorities" --data-binary @- >/dev/null',
        'echo "Microsoft CA configured."',
        '',
      ].join('\n');

      const files                         = {
        'certificate-report.sh': report,
        'crontab.txt': cron(base, '0 7 * * *', 'certificate-report.sh'),
      };
      if (replacing) {
        files['replace-certificate.sh'] = replace;
        if (action !== 'vmca') files['csr-spec.json'] = json(csrSpec);
        if (action === 'msca') files['configure-msca.sh'] = configureMsca;
      }
      files['IMPORT.md'] = fleetImport(
        replacing
          ? `The report reads; replace-certificate.sh does the replacement.${action !== 'vmca' ? ' csr-spec.json is the CSR request body with the certificate id and subject alternative names left for the script to fill from the certificate it replaces.' : ''}`
          : 'Nothing is imported: the report reads the fleet’s certificates.',
        [
          cronStep('certificate-report.sh'),
          ...(action === 'msca' ? [{ heading: 'Configure the Microsoft CA', lines: ['`./configure-msca.sh` (dry run), then `--execute`.'] }] : []),
          replacing ? { heading: 'Replace', lines: ['`./replace-certificate.sh` (dry run), then `--execute`, in a change window.'] } : undefined,
        ],
      );

      return {
        platform: PLATFORM,
        title: replacing ? `Replace the ${appliance} certificate on ${fqdn} (${caType})` : `Report fleet certificates expiring within ${within} days`,
        effect: replacing ? 'reversible' : 'read',
        trigger: replacing ? { kind: 'manual', detail: 'Run by hand, in a change window, after the report names the appliance.', worstCase: 'once per run, one appliance' } : { kind: 'schedule', detail: 'Daily, from a scheduler outside VCF Operations.', worstCase: 'once a day, for every certificate inside the window until it is replaced' },
        scope: {
          what: replacing ? `The TLS certificate of ${appliance} ${fqdn} — exactly one, or the script refuses.` : 'Every TLS certificate VCF Operations manages across the fleet. Reads only.',
          decidedBy: replacing
            ? [`POST /certificate-management/certificates/query {appliance: ${appliance}, applianceFqdn: ${fqdn}, category: TLS_CERT}.`, 'Refused unless exactly one certificate matches.']
            : ['POST /certificate-management/certificates/query {category: TLS_CERT}, every page.', `Reported when daysToExpire is ${within} or less, the status is EXPIRED, or the expiry cannot be read.`],
          ifWrong: replacing ? 'Services on the appliance restart and clients that pinned the old certificate or trust only the old issuer fail to connect until they are given the new chain.' : 'Certificates outside what VCF Operations manages — external load balancers, proxies — are not seen here.',
        },
        guardrails: replacing
          ? [
              { rule: 'One appliance per run; refuses unless exactly one certificate matches', because: 'A loose match would replace certificates on appliances nobody put in the change record.' },
              { rule: 'Dry run unless --execute, at every step', because: 'CSR generation and installation are separate decisions, often days apart.' },
              ...(action === 'external' ? [{ rule: 'Refuses an install file that is not a PEM chain', because: 'Installing a DER file or a key by mistake fails half way on the appliance.' }] : []),
              ...(action === 'msca' ? [{ rule: 'The CA password is read from a mode-600 file and sent on stdin; the dry run masks it', because: 'The CA service account can issue certificates for anything the template allows.' }] : []),
            ]
          : [],
        dryRun: replacing ? ['Every step prints what it would send unless given --execute.', 'Run certificate-report.sh first; it only reads.'] : ['certificate-report.sh only reads. Compare its list with Fleet management > Certificates in VCF Operations once.'],
        undo: replacing
          ? ['The previous certificate cannot be put back through this API: its key stays on the appliance only until the new one is installed.', 'Replace again — with a new CSR, or with VMCA on 9.1.1 — if the new certificate is wrong.']
          : ['The report changes nothing.'],
        told: [webhook ? `${webhook}, when anything is inside the window.` : 'The exit code only.', ...(replacing ? ['VCF Operations records each request under its certificate management tasks.'] : [])],
        requires: ['An API client with vcf_certificates.manage (vcf_certificates.view for the report) — see fleet91_api_clients.', 'jq and bash 4; openssl to inspect a chain.', ...(action === 'msca' ? ['A Microsoft CA with web enrollment and a template that allows server authentication.'] : [])],
        files,
        notes: [
          'Confirmed: certificates/query, csrs (POST, and GET ?commonName=), PUT certificates/{certificateResourceKey} with caType EXTERNAL_CA, MSCA or VMCA, and PUT certificate-authorities (VCF Operations API reference; davidwzhang.com parts 1 and 2).',
          'VERIFY: the maximum pageSize of certificates/query (documented default 10, no maximum given; the report asks for 1000 per page, pages to the end and fails rather than report on a partial list); whether the VMCA replacement (9.1.1) needs a CSR first; key sizes other than KEY_2048; the exact field that GET csrs returns the PEM in (the script takes the first "csr" field it finds).',
          'From 9.1.1 VCF Operations raises expiry alarms for every VCF component certificate. Route them with a notification rule, and keep this report as the check that the alarms themselves still fire.',
          '9.1.1 known issue: after a replacement VCF Operations may not trust the component again until the next inventory sync. Wait for it before judging the result.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet91_settings',
    platform: PLATFORM,
    label: 'DNS and NTP servers for the fleet, prechecked (VCF 9.1)',
    group: 'Fleet settings (9.1)',
    description:
      'Fleet settings set the DNS and NTP servers of every component in a VCF instance in one operation. This checks that each new server actually answers — forward and reverse lookups for the names you give, a time offset for each NTP server and the skew between them — and only then applies the setting. Without an exit-0 precheck the apply script will not run.',
    inputs: [
      {
        id: 'setting',
        label: 'Setting',
        control: 'select',
        options: [
          { value: 'both', label: 'DNS and NTP' },
          { value: 'dns', label: 'DNS only' },
          { value: 'ntp', label: 'NTP only' },
        ],
        default: 'both',
      },
      { id: 'setting_name', label: 'Setting name', control: 'text', default: 'Site A infrastructure services' },
      { id: 'dns_servers', label: 'DNS servers', control: 'text', default: '10.0.0.10, 10.0.0.11', showWhen: { input: 'setting', notEquals: ['ntp'] } },
      { id: 'names', label: 'Names that must resolve', control: 'textarea', default: 'vcfops.example.com\nvcenter-mgmt.example.com\nsddc-manager-01.example.com\nnsx-mgmt.example.com', hint: 'Forward and reverse. Use the components of the instance', showWhen: { input: 'setting', notEquals: ['ntp'] } },
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: 'ntp1.example.com, ntp2.example.com', showWhen: { input: 'setting', notEquals: ['dns'] } },
      { id: 'max_offset', label: 'Largest offset from this machine (seconds)', control: 'number', default: 2, min: 1, max: 300, showWhen: { input: 'setting', notEquals: ['dns'] } },
      { id: 'instances', label: 'VCF instances', control: 'text', default: 'vcf-instance-01', hint: 'Comma separated, as fleet settings names them' },
    ],
    automation: (values                 , name        )             => {
      const setting = str(values, 'setting', 'both');
      const settingName = str(values, 'setting_name', 'Fleet setting');
      const dns = listOf(str(values, 'dns_servers', ''));
      const names = listOf(str(values, 'names', ''));
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const maxOffset = num(values, 'max_offset', 2);
      const instances = listOf(str(values, 'instances', ''));
      const doDns = setting !== 'ntp';
      const doNtp = setting !== 'dns';
      const base = slugOf(name || 'fleet-settings', 'fleet-settings');

      const findings            = [];
      if (doDns && dns.length < 2) findings.push(warning('fleet91.settings.one-dns', 'One DNS server for a whole VCF instance makes it a single point of failure for every login and certificate check.', { source: SRC }));
      if (doNtp && ntp.length < 2) findings.push(warning('fleet91.settings.one-ntp', 'One NTP server cannot be sanity-checked against another; if it drifts, the whole instance drifts with it.', { remediation: 'Give at least two, ideally three or four.', source: SRC }));
      if (doDns && names.length === 0) findings.push(error('fleet91.settings.no-names', 'The DNS precheck needs names to resolve. Give the FQDNs of the components in the instance.', { source: SRC }));
      if (instances.length === 0) findings.push(error('fleet91.settings.no-instance', 'Name at least one VCF instance to apply the setting to.', { source: SRC }));

      const precheck = [
        '#!/usr/bin/env bash',
        `# Precheck the ${setting === 'both' ? 'DNS and NTP' : setting.toUpperCase()} servers for "${settingName}" before they are applied to the fleet.`,
        '#',
        '# Runs from here, not from the components. The documented prerequisites are',
        '# that the servers are reachable from every component: run it from the',
        '# management network, or from a component shell, not from a laptop on VPN.',
        '# Exits 1 when any server fails. apply-settings.sh will not run until it passes.',
        'set -uo pipefail',
        'FAIL=0',
        'bad() { echo "FAIL: $*" >&2; FAIL=1; }',
        '',
        ...(doDns
          ? [
              `DNS_SERVERS=(${dns.map(sq).join(' ')})`,
              `NAMES=(${names.map(sq).join(' ')})`,
              'command -v dig >/dev/null || { echo "dig is required (bind-utils / dnsutils)" >&2; exit 2; }',
              'for s in "${DNS_SERVERS[@]}"; do',
              '  for n in "${NAMES[@]}"; do',
              '    ip=$(dig +short +time=2 +tries=1 @"$s" "$n" A | grep -E \'^[0-9.]+$\' | head -1)',
              '    if [[ -z "$ip" ]]; then bad "$s does not resolve $n"; continue; fi',
              '    back=$(dig +short +time=2 +tries=1 @"$s" -x "$ip" | head -1)',
              '    b="${back%.}"; if [[ "${b,,}" != "${n,,}" ]]; then bad "$s: $ip reverses to \\"${back%.}\\", not $n"; else echo "ok   $s  $n -> $ip -> ${back%.}"; fi',
              '  done',
              'done',
              '',
            ]
          : []),
        ...(doNtp
          ? [
              `NTP_SERVERS=(${ntp.map(sq).join(' ')})`,
              `MAX_OFFSET=${maxOffset}`,
              'offset_of() {',
              '  local s="$1" out',
              '  if command -v ntpdate >/dev/null; then',
              '    out=$(ntpdate -q "$s" 2>/dev/null | grep -oE \'offset -?[0-9.]+\' | tail -1 | awk \'{print $2}\')',
              '  elif command -v sntp >/dev/null; then',
              '    out=$(sntp -t 3 "$s" 2>/dev/null | grep -oE \'[+-][0-9.]+ \\+/-\' | head -1 | awk \'{print $1}\')',
              '  elif command -v chronyd >/dev/null; then',
              '    # chronyd -Q measures without setting the clock; it may need root.',
              '    out=$(chronyd -Q -t 10 "server $s iburst maxsamples 1" 2>&1 | grep -oE \'offset [+-]?[0-9.]+\' | tail -1 | awk \'{print $2}\')',
              '  else',
              '    echo "none of ntpdate, sntp or chronyd is installed" >&2; return 2',
              '  fi',
              '  [[ -n "$out" ]] && printf \'%s\' "$out"',
              '}',
              'OFFSETS=()',
              'for s in "${NTP_SERVERS[@]}"; do',
              '  o=$(offset_of "$s") || true',
              '  if [[ -z "$o" ]]; then bad "$s did not answer an NTP query"; continue; fi',
              '  OFFSETS+=("$o")',
              '  if awk -v o="$o" -v m="$MAX_OFFSET" \'BEGIN { exit !((o < 0 ? -o : o) > m) }\'; then bad "$s is ${o}s from this machine (limit ${MAX_OFFSET}s)"; else echo "ok   $s  offset ${o}s"; fi',
              'done',
              '# The documented limit: new NTP servers within five minutes of each other.',
              'if (( ${#OFFSETS[@]} > 1 )); then',
              '  spread=$(printf \'%s\\n\' "${OFFSETS[@]}" | sort -g | awk \'NR==1{lo=$1} {hi=$1} END{print hi-lo}\')',
              '  if awk -v s="$spread" \'BEGIN { exit !(s > 300) }\'; then bad "the NTP servers disagree by ${spread}s (limit 300s)"; else echo "ok   servers agree within ${spread}s"; fi',
              'fi',
              '',
            ]
          : []),
        'if (( FAIL )); then echo "Precheck failed. Do not apply this setting." >&2; exit 1; fi',
        'echo "Precheck passed."',
        '',
      ].join('\n');

      const payload = {
        name: settingName,
        description: 'Written by ArchToolKit.',
        ...(doDns ? { dnsServers: dns } : {}),
        ...(doNtp ? { ntpServers: ntp } : {}),
        instances: instances.length ? instances : ['<REQUIRED — VCF instance name>'],
      };

      const apply = [
        ...head(`Apply fleet setting "${settingName}" to ${instances.join(', ') || 'the named instances'}.`, [
          'VERIFY: the fleet settings API is not in the public VCF Operations API',
          'reference at the time of writing. Set DNS_SETTINGS_PATH / NTP_SETTINGS_PATH',
          'from the reference for your release, or apply it in the interface with',
          'apply-in-ui.txt. Either way, precheck.sh must pass first — this script runs',
          'it and stops if it fails.',
        ]),
        ...parseArgs(),
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        'bash "$HERE/precheck.sh" || { echo "Refusing: the precheck failed." >&2; exit 1; }',
        '',
        ...(doDns ? [': "${DNS_SETTINGS_PATH:?VERIFY: set DNS_SETTINGS_PATH to the fleet DNS settings endpoint from the API reference for your release}"'] : []),
        ...(doNtp ? [': "${NTP_SETTINGS_PATH:?VERIFY: set NTP_SETTINGS_PATH to the fleet NTP settings endpoint from the API reference for your release}"'] : []),
        'if (( DRY_RUN )); then',
        ...(doDns ? ['  echo "DRY RUN: would POST dns-setting.json to ${DNS_SETTINGS_PATH}"'] : []),
        ...(doNtp ? ['  echo "DRY RUN: would POST ntp-setting.json to ${NTP_SETTINGS_PATH}"'] : []),
        '  echo "Nothing was changed. Check the body shape against the reference, then re-run with --execute."',
        '  exit 0',
        'fi',
        ...(doDns ? ['api POST "$DNS_SETTINGS_PATH" --data @"$HERE/dns-setting.json" | jq .'] : []),
        ...(doNtp ? ['api POST "$NTP_SETTINGS_PATH" --data @"$HERE/ntp-setting.json" | jq .'] : []),
        'echo "Submitted. Follow it in VCF Operations; a component that fails is rolled back to its previous setting."',
        '',
      ].join('\n');

      const ui = [
        `Applying "${settingName}" in VCF Operations 9.1 (Broadcom techdocs, Fleet management > Fleet settings).`,
        '',
        '0. Run ./precheck.sh from the management network. Do not continue unless it prints "Precheck passed."',
        '   Also confirmed by the documented prerequisites: SDDC Manager reaches every component over SSH,',
        '   and every component is in an active state.',
        '',
        ...(doDns
          ? [
              'DNS',
              '1. Manage > Fleet management > Fleet settings > DNS settings.',
              `2. Create setting: name "${settingName}", DNS servers "${dns.join(',')}" (comma separated).`,
              `3. Under Instances select ${instances.join(', ')} > Apply > choose the setting > Assign.`,
              '   Updated on: SDDC Manager, vCenter, ESX, NSX, VCF management services, VCF Automation.',
              '',
            ]
          : []),
        ...(doNtp
          ? [
              'NTP',
              '1. Manage > Fleet management > Fleet settings > NTP settings.',
              `2. Create setting: name "${settingName}", NTP servers "${ntp.join(',')}" (comma separated).`,
              `3. Under Instances select ${instances.join(', ')} > Apply > choose the setting > Assign.`,
              '   Updated on: SDDC Manager, vCenter, ESX, NSX, VCF Operations, VCF Automation, management services,',
              '   VCF Operations for networks.',
              '',
            ]
          : []),
        'If a component fails, VCF Operations rolls that component back to its previous setting.',
        'Schedule it for a quiet period: how long it takes grows with the size of the instance.',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Set fleet ${setting === 'both' ? 'DNS and NTP' : setting.toUpperCase()} for ${instances.join(', ') || 'named instances'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Run by hand when infrastructure services change; the precheck can be run as often as you like.', worstCase: 'once per run, every component of each named instance' },
        scope: {
          what: `Every component in ${instances.join(', ') || 'the named VCF instances'} whose ${setting === 'both' ? 'DNS and NTP' : setting.toUpperCase()} settings fleet management owns.`,
          decidedBy: ['The instances selected when the setting is assigned.', 'The components VCF Operations updates for that setting type, listed in apply-in-ui.txt.'],
          ifWrong: 'A wrong DNS server breaks name resolution for logins, certificates and management traffic across the instance; a bad NTP server skews time until authentication tokens start failing.',
        },
        guardrails: [
          { rule: 'apply-settings.sh runs precheck.sh first and refuses if it fails', because: 'A DNS server that cannot resolve the components, or an NTP server that is minutes off, takes the whole instance with it.' },
          ...(doNtp ? [{ rule: 'The precheck fails NTP servers more than 300 seconds apart', because: 'The documented limit for new NTP servers is five minutes of skew between them.' }] : []),
          { rule: 'A component that fails the update is rolled back by VCF Operations', because: 'Documented platform behaviour: a partial failure does not leave a component with half a setting.' },
        ],
        dryRun: ['precheck.sh changes nothing.', 'apply-settings.sh without --execute runs the precheck and prints what it would send.'],
        undo: ['Assign the previous setting to the same instances. Record it from Fleet settings before you start: this generates the new one only.'],
        told: ['VCF Operations records the update under fleet management tasks.', 'precheck.sh output is the evidence for the change record.'],
        requires: ['dig; and one of ntpdate, sntp or chronyd.', 'An API client with administration.fleetSettings.manage (or the .dns / .ntp sub-privileges) — see fleet91_api_clients.'],
        files: {
          'precheck.sh': precheck,
          'apply-settings.sh': apply,
          // One body per call, exactly as sent: the DNS setting without the NTP
          // servers and the other way round.
          ...(doDns ? { 'dns-setting.json': json({ ...payload, ntpServers: undefined }) } : {}),
          ...(doNtp ? { 'ntp-setting.json': json({ ...payload, dnsServers: undefined }) } : {}),
          'apply-in-ui.txt': ui,
          'IMPORT.md': fleetImport(
            'Fleet settings have no file import. The documented route is the interface (apply-in-ui.txt, step by step); the API route sends dns-setting.json and ntp-setting.json as they stand, once the paths are known.',
            [
              { heading: 'Precheck', lines: ['`./precheck.sh` from the management network. Do not continue unless it prints "Precheck passed."'] },
              { heading: 'Apply', lines: ['Either follow apply-in-ui.txt (Manage > Fleet management > Fleet settings), or set DNS_SETTINGS_PATH / NTP_SETTINGS_PATH from the API reference for your release and run `./apply-settings.sh --execute` (VERIFY: the paths and bodies are not in the public reference).'] },
            ],
            ['The body shape of both files (name, description, dnsServers or ntpServers, instances) is not documented; compare with what the interface sends before using the API route.'],
          ),
        },
        notes: [
          'Confirmed: the UI path and the prerequisites (Broadcom techdocs 9.1, Update DNS / NTP Server Configuration); the privileges administration.fleetSettings.dns.* and .ntp.* (davidwzhang.com API Access part 6).',
          'VERIFY: the fleet settings REST path and body. They are not in the public API reference; dns-setting.json and ntp-setting.json are a reasonable shape, not a documented one.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet91_identity',
    platform: PLATFORM,
    label: 'Identity provider, custom roles and group access (VCF 9.1)',
    group: 'Identity and access (9.1)',
    description:
      'The VCF Identity Broker is where every login in the fleet now starts. Configure its OIDC identity provider (generic OIDC, Symantec, Entra ID or Okta), create a custom VCF role from component roles, give a directory group a VCF role without wiping the roles it already has, or check and re-push the roles VCF provisions into vCenter.',
    inputs: [
      {
        id: 'task',
        label: 'Do',
        control: 'select',
        options: [
          { value: 'oidc', label: 'Configure an OIDC identity provider' },
          { value: 'role', label: 'Create a custom VCF role' },
          { value: 'group', label: 'Give a directory group a VCF role' },
          { value: 'sync', label: 'Check and re-push component (vCenter) roles' },
        ],
        default: 'group',
      },
      {
        id: 'idp_type',
        label: 'Identity provider',
        control: 'select',
        options: [
          { value: 'OTHER', label: 'Generic OIDC' },
          { value: 'SYMANTEC_IDSP', label: 'Symantec Identity Security Platform' },
          { value: 'ENTRA_ID', label: 'Microsoft Entra ID' },
          { value: 'OKTA', label: 'Okta' },
        ],
        default: 'ENTRA_ID',
        showWhen: { input: 'task', equals: ['oidc'] },
      },
      { id: 'idp_name', label: 'Provider name', control: 'text', default: 'Corporate SSO', showWhen: { input: 'task', equals: ['oidc'] } },
      { id: 'discovery', label: 'Discovery endpoint', control: 'text', default: 'https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration', showWhen: { input: 'task', equals: ['oidc'] } },
      { id: 'client_id', label: 'Client id', control: 'text', default: '<REQUIRED — application (client) id>', showWhen: { input: 'task', equals: ['oidc'] } },
      {
        id: 'provision',
        label: 'Users and groups arrive by',
        control: 'select',
        options: [
          { value: 'JIT', label: 'Just-in-time, at first login' },
          { value: 'SCIM', label: 'SCIM, pushed by the provider' },
        ],
        default: 'JIT',
        showWhen: { input: 'task', equals: ['oidc'] },
      },
      { id: 'domain', label: 'Directory domain', control: 'text', default: 'example.com', showWhen: { input: 'task', equals: ['oidc'] } },
      { id: 'new_role', label: 'New role name', control: 'text', default: 'fleet-operator', showWhen: { input: 'task', equals: ['role'] } },
      { id: 'role_name', label: 'VCF role', control: 'combo', options: [{ value: 'vcf_viewer', label: 'vcf_viewer' }, { value: 'sddc_admin', label: 'sddc_admin' }, { value: 'fleetmgmt-admin', label: 'fleetmgmt-admin (custom)' }], default: 'vcf_viewer', showWhen: { input: 'task', equals: ['group'] } },
      { id: 'component_roles', label: 'Component roles', control: 'textarea', default: 'VCENTER: ReadOnly\nNSX: auditor', hint: 'One component per line — TYPE: role, role. Types from GET /iam/components', showWhen: { input: 'task', equals: ['role'] } },
      { id: 'group_name', label: 'Directory group', control: 'text', default: 'vcf-operators', showWhen: { input: 'task', equals: ['group'] } },
      {
        id: 'scope_type',
        label: 'Role applies to',
        control: 'select',
        options: [
          { value: 'SSO_REALM', label: 'The whole SSO realm' },
          { value: 'VCF_INSTANCE', label: 'One VCF instance' },
        ],
        default: 'SSO_REALM',
        showWhen: { input: 'task', equals: ['group'] },
      },
      { id: 'instance_id', label: 'VCF instance id', control: 'text', default: '<REQUIRED — vcfInstanceId from GET /iam/ssorealms>', showWhen: { input: 'scope_type', equals: ['VCF_INSTANCE'] } },
    ],
    automation: (values                 , name        )             => {
      const task = str(values, 'task', 'group');
      const idpType = str(values, 'idp_type', 'ENTRA_ID');
      const roleName = str(values, str(values, 'task', 'group') === 'role' ? 'new_role' : 'role_name', 'vcf_viewer');
      const group = str(values, 'group_name', '');
      const scopeType = str(values, 'scope_type', 'SSO_REALM');
      const instanceId = str(values, 'instance_id', '');
      const base = slugOf(name || `identity-${task}`, 'identity');

      const findings            = [];
      const componentRoles = str(values, 'component_roles', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [type = '', roles = ''] = line.split(':');
          return { componentType: type.trim(), roles: listOf(roles) };
        });
      if (task === 'role' && (componentRoles.length === 0 || componentRoles.some((c) => !c.componentType || c.roles.length === 0))) {
        findings.push(error('fleet91.identity.component-roles', 'Each component-role line needs a type and at least one role, as "VCENTER: ReadOnly".', { source: SRC }));
      }
      if (task === 'role' && /^vcf_|^sddc_/.test(roleName)) {
        findings.push(error('fleet91.identity.builtin-name', `"${roleName}" looks like a built-in role name. A custom role needs its own name.`, { source: SRC }));
      }
      if (task === 'group' && !group) findings.push(error('fleet91.identity.no-group', 'Name the directory group.', { source: SRC }));
      if (task === 'group' && /admin/i.test(roleName) && scopeType === 'SSO_REALM') {
        findings.push(warning('fleet91.identity.wide-admin', `${roleName} across the whole SSO realm is administrator of every instance in it.`, { remediation: 'Scope it to a VCF instance unless the group really runs the fleet.', source: SRC }));
      }
      if (task === 'oidc') findings.push(info('fleet91.identity.redirect', 'Register the identity broker’s redirect URI in the provider’s application before running this; VCF Operations shows it on the identity provider page.', { source: SRC }));

      const realm = [
        'REALM=$(api GET "${FM}/iam/ssorealms" | jq -r \'.ssoRealms[0].id // empty\')',
        '[[ -n "$REALM" ]] || { echo "No SSO realm found." >&2; exit 1; }',
        'echo "SSO realm ${REALM}"',
      ];

      let script           = [];
      const files                         = {};

      if (task === 'oidc') {
        files['identity-provider.json'] = json({
          idpProtocol: 'OIDC',
          idpType,
          name: str(values, 'idp_name', 'Corporate SSO'),
          provisionType: str(values, 'provision', 'JIT'),
          ssoRealmId: '__REALM__',
          directories: [{ name: str(values, 'domain', 'example.com'), defaultDomain: str(values, 'domain', 'example.com'), domains: [str(values, 'domain', 'example.com')] }],
          idpConfig: {
            oidcConfiguration: {
              clientId: str(values, 'client_id', ''),
              discoveryEndpoint: str(values, 'discovery', ''),
              openIdUserIdentifierAttribute: 'email',
              internalUserIdentifierAttribute: 'email',
            },
          },
        });
        script = [
          ...head(`Configure ${idpType} as the OIDC identity provider of the VCF Identity Broker.`, [
            'Needs OIDC_CLIENT_SECRET_FILE: a mode-600 file holding the client secret.',
            'Refuses unless an emergency client exists, so a broken provider does not',
            'lock everybody out of the fleet.',
          ]),
          ...needPrivate(),
          ...parseArgs(),
          ': "${OIDC_CLIENT_SECRET_FILE:?set OIDC_CLIENT_SECRET_FILE to a mode-600 file holding the client secret}"',
          'need_private "$OIDC_CLIENT_SECRET_FILE"',
          ...realm,
          '',
          '# Guardrail: a way in that does not depend on the new provider.',
          '# The list must be recognisable as a list: counting the keys of some other',
          '# object would pass this check with no emergency client at all.',
          'EMERGENCY=$(api GET "${FM}/iam/ssorealms/${REALM}/emergency-clients" \\',
          '  | jq \'(if type == "array" then . else (.emergencyClients // .elements) end) | if type == "array" then length else error("unrecognised emergency-clients response") end\')',
          'if (( EMERGENCY < 1 )); then',
          '  echo "Refusing: no emergency client in this realm. Create one (Identity > Emergency access) and store its token offline first." >&2',
          '  exit 1',
          'fi',
          '',
          'build() {',
          '  jq --arg r "$REALM" --rawfile s "$OIDC_CLIENT_SECRET_FILE" --arg mask "$1" \\',
          '    \'.ssoRealmId = $r | .idpConfig.oidcConfiguration.clientSecret = (if $mask == "mask" then "********" else ($s | rtrimstr("\\n")) end)\' identity-provider.json',
          '}',
          'if grep -q "<REQUIRED" identity-provider.json; then echo "identity-provider.json still has <REQUIRED> values." >&2; exit 1; fi',
          'if (( DRY_RUN )); then echo "DRY RUN: would POST ${FM}/iam/identity-providers:"; build mask; exit 0; fi',
          'build send | api POST "${FM}/iam/identity-providers" --data-binary @- | jq \'{id, name, idpType, provisionType}\'',
          'echo "Test a login in a private window before you log out of this one."',
          '',
        ];
      } else if (task === 'role') {
        files['vcf-role.json'] = json({ roleName, roleDisplayName: roleName, roleDescription: 'Written by ArchToolKit.', componentRoles });
        script = [
          ...head(`Create the custom VCF role "${roleName}".`, ['  ./identity.sh components    list component types and their roles (read only)', '  ./identity.sh               dry run', '  ./identity.sh --execute     create it']),
          ...parseArgs(),
          'if [[ "${1:-}" == "components" ]]; then',
          '  api GET "${FM}/iam/components" | jq -r \'(.components // .elements // .)[]? | "\\(.componentType // .type)\\t\\(.id // .componentId)\\t\\(.name // "")"\'',
          '  echo "Role names per component: GET ${FM}/iam/components/{componentId}/role-definitions"',
          '  exit 0',
          'fi',
          '# Only a 404 means "no such role". Any other answer — 401, 500, no answer —',
          '# means this script cannot tell, and it stops.',
          `EXISTS=$(api_status "\${FM}/iam/roles/${encodeURIComponent(roleName)}")`,
          'case "$EXISTS" in',
          `  200) echo "Refusing: a role named ${roleName} already exists. Change it with PUT /iam/roles, deliberately." >&2; exit 1 ;;`,
          '  404) ;;',
          '  *) echo "Refusing: could not tell whether the role exists (HTTP ${EXISTS})." >&2; exit 1 ;;',
          'esac',
          'if (( DRY_RUN )); then echo "DRY RUN: would POST ${FM}/iam/roles:"; jq . vcf-role.json; exit 0; fi',
          'api POST "${FM}/iam/roles" --data @vcf-role.json | jq \'{roleName, type, createdAt}\'',
          '',
        ];
      } else if (task === 'group') {
        files['groups-query.json'] = json({ searchTerms: { allOf: [{ field: 'NAME', terms: [group], operator: 'LIKE' }], anyOf: [] } });
        const assignment = scopeType === 'VCF_INSTANCE' ? { roleName, roleScope: { scopeType, resources: [{ id: instanceId }] }, expiresAt: null } : { roleName, roleScope: { scopeType }, expiresAt: null };
        // The PUT .../principals/{id}/roles body: this group's new assignment. The
        // script adds the group's current assignments to it before sending,
        // because the PUT replaces them all.
        files['role-assignment.json'] = json({ vcfRoleAssignments: [assignment] });
        script = [
          ...head(`Give directory group "${group}" the VCF role ${roleName} (${scopeType}).`, [
            'The roles endpoint replaces every assignment of a principal, so this reads',
            'the group’s current roles, adds one, and saves the before-state as the undo.',
          ]),
          ...parseArgs(),
          ...realm,
          `GROUP=${sq(group)}`,
          'MATCHES=$(api POST "${FM}/iam/ssorealms/${REALM}/groups/query?page=0&pageSize=50" --data @groups-query.json \\',
          '  | jq -c --arg g "$GROUP" \'[(.groups // .results // .elements // [])[] | select((.name // .displayName // "" | ascii_downcase) == ($g | ascii_downcase) or ((.name // "") | ascii_downcase | startswith(($g | ascii_downcase) + "@")))]\')',
          'if [[ "$(jq length <<<"$MATCHES")" != "1" ]]; then',
          '  echo "Refusing: expected one group named ${GROUP}, found $(jq length <<<"$MATCHES"). On 9.1.1 with on-demand lookup, the group must exist in AD; on 9.1.0 it must have been synced." >&2',
          '  jq -r \'.[] | "  \\(.id)  \\(.name // .displayName)"\' <<<"$MATCHES" >&2',
          '  exit 1',
          'fi',
          'GID=$(jq -r \'.[0].id\' <<<"$MATCHES")',
          '# The PUT below replaces every role of the group. If the current roles cannot',
          '# be read as a list, stop: treating "unreadable" as "none" would wipe them.',
          'CURRENT=$(api GET "${FM}/iam/ssorealms/${REALM}/principals/${GID}/roles" \\',
          '  | jq -c \'if type == "object" and has("vcfRoleAssignments") and ((.vcfRoleAssignments | type) == "array" or .vcfRoleAssignments == null) then (.vcfRoleAssignments // []) else error("no vcfRoleAssignments in the response") end\')',
          'echo "Current roles: $(jq -r \'[.[].roleName] | join(", ")\' <<<"$CURRENT")"',
          'NEW=$(jq -c --slurpfile a role-assignment.json \'. as $cur | ($a[0].vcfRoleAssignments) as $add | if all($add[]; . as $n | any($cur[]; .roleName == $n.roleName and .roleScope == $n.roleScope)) then $cur else $cur + $add end\' <<<"$CURRENT")',
          'if [[ "$NEW" == "$CURRENT" ]]; then echo "The group already has that role at that scope."; exit 0; fi',
          'if (( DRY_RUN )); then echo "DRY RUN: would PUT the roles of group ${GID}:"; jq \'{vcfRoleAssignments: .}\' <<<"$NEW"; exit 0; fi',
          'STAMP=$(date +%Y%m%d-%H%M%S)',
          'jq \'{vcfRoleAssignments: .}\' <<<"$CURRENT" > "roles-before-${GID}-${STAMP}.json"',
          'jq \'{vcfRoleAssignments: .}\' <<<"$NEW" | api PUT "${FM}/iam/ssorealms/${REALM}/principals/${GID}/roles" --data @- >/dev/null',
          'echo "Done. Undo: PUT roles-before-${GID}-${STAMP}.json to the same path."',
          '',
        ];
      } else {
        script = [
          ...head('Check the custom component roles VCF has provisioned (for example into vCenter) for drift, and re-push failed ones.', [
            '  ./identity.sh               check every role for drift (starts drift checks only)',
            '  ./identity.sh --execute     also retry provisioning of roles whose last push failed',
          ]),
          ...parseArgs(),
          'PROBLEMS=()',
          'ROLES=$(api GET "${FM}/iam/components/roles" | jq -c \'(if type == "array" then . else (.roles // .elements) end) | if type == "array" then . else error("unrecognised component roles response") end\')',
          'echo "$(jq length <<<"$ROLES") provisioned component role(s)."',
          '# Read into a variable first, so a jq failure stops the script instead of',
          '# quietly producing an empty loop.',
          'ROWS=$(jq -r \'.[] | [(.id // .roleId // error("a role has no id")), (.name // .roleName // "?"), (.status // .provisioningStatus // "UNKNOWN")] | @tsv\' <<<"$ROLES")',
          'while IFS=$\'\\t\' read -r RID RNAME RSTATE; do',
          '  [[ -n "$RID" ]] || continue',
          '  refresh_token',
          '  if RESULT=$(api POST "${FM}/iam/components/roles/${RID}/drift-check" --data \'{}\' | jq -c .); then',
          '    echo "  ${RNAME}  state=${RSTATE}  drift-check: $(jq -r \'.status // .taskId // "submitted"\' <<<"$RESULT")"',
          '  else',
          '    echo "  ${RNAME}  state=${RSTATE}  drift-check: could not be started" >&2',
          '    PROBLEMS+=("${RNAME}: drift check could not be started")',
          '  fi',
          '  case "$RSTATE" in',
          '    UNKNOWN) PROBLEMS+=("${RNAME}: provisioning status could not be read") ;;',
          '    *FAIL*|*ERROR*)',
          '      PROBLEMS+=("${RNAME}: last provisioning ${RSTATE}")',
          '      if (( ! DRY_RUN )); then',
          '        if api POST "${FM}/iam/components/roles/${RID}/retry" --data \'{}\' >/dev/null; then echo "    retried"; else PROBLEMS+=("${RNAME}: retry was refused"); fi',
          '      fi ;;',
          '  esac',
          'done <<<"$ROWS"',
          'echo "Drift results arrive as tasks: GET ${FM}/iam/tasks/{taskId}, or Identity > Roles in VCF Operations."',
          'if (( ${#PROBLEMS[@]} > 0 )); then printf "%s\\n" "${PROBLEMS[@]}" >&2; (( DRY_RUN )) && echo "Re-run with --execute to retry them." >&2; exit 1; fi',
          '',
        ];
      }
      files['identity.sh'] = script.join('\n');
      files['IMPORT.md'] = fleetImport(
        task === 'group'
          ? 'role-assignment.json is the PUT .../iam/ssorealms/{realm}/principals/{groupId}/roles body with the one new assignment; because that PUT replaces every assignment, identity.sh sends it together with the group’s current ones (groups-query.json is the body of the group lookup).'
          : 'identity.sh sends the JSON beside it; values it cannot know in advance (the realm id, the client secret) are filled in memory at run time.',
        [{ heading: 'Apply', lines: ['`./identity.sh` (dry run), then `./identity.sh --execute`. In the interface: Manage > Identity & Access (VERIFY the menu name on your build).'] }],
      );

      const titles                         = {
        oidc: `Configure ${idpType} OIDC for the VCF Identity Broker`,
        role: `Create custom VCF role ${roleName}`,
        group: `Give group ${group} the VCF role ${roleName}`,
        sync: 'Check and re-push provisioned component roles',
      };

      return {
        platform: PLATFORM,
        title: titles[task] ?? 'VCF identity and access',
        effect: 'reversible',
        trigger: { kind: task === 'sync' ? 'schedule' : 'manual', detail: task === 'sync' ? 'Weekly, and after any vCenter restore or role change made in vCenter directly.' : 'Run by hand, with a change record: identity changes decide who can log in to the whole fleet.', worstCase: task === 'sync' ? 'weekly, retrying every failed role' : 'once per run' },
        scope: {
          what:
            task === 'oidc' ? 'Every login through the VCF Identity Broker of this SSO realm.' : task === 'role' ? `A new role definition; nobody has it until it is assigned.` : task === 'group' ? `Every member of ${group}, now and later.` : 'Every custom component role VCF has provisioned into components such as vCenter.',
          decidedBy:
            task === 'group'
              ? ['GET /iam/ssorealms — the first SSO realm.', `POST /iam/ssorealms/{realm}/groups/query for ${group}; refused unless exactly one matches.`, `Scope ${scopeType}${scopeType === 'VCF_INSTANCE' ? ` ${instanceId}` : ''}.`, 'Membership, which the directory decides — on 9.1.1 with on-demand lookup, at login time.']
              : task === 'oidc'
                ? ['GET /iam/ssorealms — the first SSO realm.', 'The provider’s own assignment of users to the application.']
                : task === 'role'
                  ? ['The component roles listed in vcf-role.json.']
                  : ['GET /iam/components/roles — every provisioned custom component role.'],
          ifWrong: task === 'oidc' ? 'Nobody can log in with the new provider, and without an emergency client nobody can log in to fix it.' : 'More people than intended can act on the fleet, through every component the role reaches.',
        },
        guardrails: [
          ...(task === 'oidc'
            ? [
                { rule: 'Refuses unless the realm has an emergency client', because: 'A misconfigured provider otherwise locks every administrator out of the fleet.' },
                { rule: 'The client secret is read from a mode-600 file and sent on stdin; the dry run masks it', because: 'The secret lets anyone mint logins as the broker’s application.' },
              ]
            : []),
          ...(task === 'role' ? [{ rule: 'Refuses if a role of that name exists', because: 'Creating over an existing role would silently change what everyone holding it can do.' }] : []),
          ...(task === 'group'
            ? [
                { rule: 'Refuses unless exactly one group matches', because: 'A LIKE search for "admins" also finds "vcf-admins-old".' },
                { rule: 'Adds to the group’s current roles instead of replacing them, and saves the before-state', because: 'The endpoint replaces every assignment, so a naive call removes roles someone else gave.' },
              ]
            : []),
          ...(task === 'sync' ? [{ rule: 'Retries provisioning only with --execute', because: 'A re-push overwrites a role someone changed in vCenter on purpose, and that deserves a look first.' }] : []),
          { rule: 'Dry run unless --execute', because: 'Identity changes are reviewed before they are made, not after the first failed login.' },
        ],
        dryRun: ['identity.sh without --execute resolves everything and prints the body it would send.'],
        undo:
          task === 'oidc'
            ? ['DELETE /iam/identity-providers/{idpConfigId}, logged in through the emergency client if need be.']
            : task === 'role'
              ? [`DELETE /iam/roles/${roleName} once nobody is assigned it.`]
              : task === 'group'
                ? ['PUT roles-before-<group>-<time>.json back to /iam/ssorealms/{realm}/principals/{groupId}/roles.']
                : ['A drift check changes nothing. A retry pushes the VCF definition again; to keep a vCenter-side change, change the VCF role instead.'],
        told: ['VCF Operations audits identity changes under Identity and access.', 'The change record, which should name the group or provider.'],
        requires: ['An API client with identity.management.manage — see fleet91_api_clients.', 'jq and bash 4.', ...(task === 'oidc' ? ['An application registered in the provider with the identity broker’s redirect URI, and its client secret in a mode-600 file.'] : [])],
        files,
        notes: [
          'Confirmed paths (VCF Operations API reference, IAM APIs): /iam/ssorealms, /iam/identity-providers (idpProtocol OIDC; idpType OKTA, ENTRA_ID, SYMANTEC_IDSP, OTHER), /iam/roles (componentRoles), /iam/ssorealms/{id}/groups/query, /iam/ssorealms/{id}/principals/{principalId}/roles (vcfRoleAssignments), /iam/components/roles/{roleId}/drift-check and /retry, /iam/ssorealms/{id}/emergency-clients.',
          'VERIFY: the groups/query body (the search-terms shape is borrowed from the API token query) and its response key; the response keys of the component, role and emergency-client lists; that generic OIDC is idpType OTHER.',
          '9.1.1: on-demand lookup finds AD users and groups at login time rather than after a sync — enabled on the directory in Identity > Identity providers (UI). From vCenter 9.1.1, the VCF admin role and any custom role that includes the vCenter admin role are mapped to the local vCenter Administrators group automatically.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet91_api_clients',
    platform: PLATFORM,
    label: 'API client and API token lifecycle — the automation bootstrap (VCF 9.1)',
    group: 'Identity and access (9.1)',
    description:
      'Every fleet script in this kit logs in with VCF_API_TOKEN_FILE: the API token of an API client, exchanged at the identity broker for a half-hour access token. This creates that client and gives it a role, issues its token into a mode-600 file, reports how long it has left, rotates it before it expires — issuing the new one, proving it works, swapping the file atomically — and only then revokes the old one.',
    inputs: [
      { id: 'client_id', label: 'API client id', control: 'text', default: 'archtoolkit-automation', hint: 'Letters, digits, dash, underscore' },
      { id: 'client_name', label: 'Display name', control: 'text', default: 'ArchToolKit automation' },
      { id: 'role_name', label: 'Role', control: 'combo', options: [{ value: 'vcf_viewer', label: 'vcf_viewer — read-only reports' }, { value: 'sddc_admin', label: 'sddc_admin' }, { value: 'fleetmgmt-admin', label: 'fleetmgmt-admin (custom role)' }], default: 'fleetmgmt-admin', hint: 'The token can do exactly what this role can' },
      {
        id: 'scope_type',
        label: 'Role applies to',
        control: 'select',
        options: [
          { value: 'SSO_REALM', label: 'The whole SSO realm' },
          { value: 'VCF_INSTANCE', label: 'One VCF instance' },
        ],
        default: 'SSO_REALM',
      },
      { id: 'instance_id', label: 'VCF instance id', control: 'text', default: '<REQUIRED — vcfInstanceId from GET /iam/ssorealms>', showWhen: { input: 'scope_type', equals: ['VCF_INSTANCE'] } },
      { id: 'token_days', label: 'API token lifetime (days)', control: 'number', default: 90, min: 1, max: 365 },
      { id: 'rotate_days', label: 'Rotate when fewer than (days) left', control: 'number', default: 21, min: 1, max: 180 },
      { id: 'access_minutes', label: 'Access token lifetime (minutes)', control: 'number', default: 30, min: 5, max: 60 },
      {
        id: 'strategy',
        label: 'Rotate by',
        control: 'select',
        options: [
          { value: 'overlap', label: 'Issuing a second token, proving it, then revoking the old one' },
          { value: 'regenerate', label: 'Regenerating the same token' },
        ],
        default: 'overlap',
      },
      { id: 'token_file', label: 'Token file', control: 'text', default: '/etc/archtoolkit/vcf-api-token', hint: 'What every other script reads as VCF_API_TOKEN_FILE' },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-api-tokens' },
    ],
    automation: (values                 , name        )             => {
      const clientId = str(values, 'client_id', 'archtoolkit-automation');
      const clientName = str(values, 'client_name', clientId);
      const roleName = str(values, 'role_name', 'fleetmgmt-admin');
      const scopeType = str(values, 'scope_type', 'SSO_REALM');
      const instanceId = str(values, 'instance_id', '');
      const tokenDays = num(values, 'token_days', 90);
      const rotateDays = num(values, 'rotate_days', 21);
      const accessMinutes = num(values, 'access_minutes', 30);
      const strategy = str(values, 'strategy', 'overlap');
      const tokenFile = str(values, 'token_file', '/etc/archtoolkit/vcf-api-token');
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'api-token', 'api-token');

      const findings            = [];
      if (!/^[A-Za-z0-9_-]+$/.test(clientId)) findings.push(error('fleet91.token.client-id', `API client id "${clientId}" should be letters, digits, dash and underscore.`, { source: SRC }));
      if (rotateDays >= tokenDays) findings.push(error('fleet91.token.rotate-window', `Rotating with ${rotateDays} days left on a ${tokenDays}-day token rotates every run.`, { remediation: 'The rotation window must be shorter than the lifetime; a quarter of it is a good start.', source: SRC }));
      if (rotateDays < 7) findings.push(warning('fleet91.token.late', `${rotateDays} days leaves one bad week between a failing rotation and every automation stopping.`, { remediation: 'Rotate with at least two weeks left, and alert on the status run.', source: SRC }));
      if (tokenDays > 180) findings.push(warning('fleet91.token.long', `A ${tokenDays}-day API token is a long-lived secret on disk. The 9.1 guidance puts API token lifetimes between 30 and 180 days.`, { source: SRC }));
      if (/admin/i.test(roleName) && scopeType === 'SSO_REALM') findings.push(warning('fleet91.token.wide', `${roleName} across the whole realm makes this token administrator of the fleet. Anyone who reads the token file is.`, { remediation: 'Use a custom role with only the fleet-management privileges the scripts need (davidwzhang.com part 6 lists them), or scope it to one instance.', source: SRC }));
      if (!tokenFile.startsWith('/')) findings.push(error('fleet91.token.relative', 'Give the token file as an absolute path: cron runs from a different directory.', { source: SRC }));
      findings.push(info('fleet91.token.self-manage', 'Rotation authenticates with the token it rotates, so the client’s role needs the privilege to manage API tokens. To keep that out of the automation role, run rotation with a separate rotator client: VCF_API_TOKEN_FILE=<rotator>, TARGET_TOKEN_FILE=<this>.', { source: SRC }));

      const assignment = scopeType === 'VCF_INSTANCE' ? { roleName, roleScope: { scopeType, resources: [{ id: instanceId }] }, expiresAt: null } : { roleName, roleScope: { scopeType }, expiresAt: null };

      const script = [
        ...head(`API client "${clientId}" and its API token.`, [
          '  ./api-token.sh status                 read only: days left, exit 1 inside the rotation window',
          '  ./api-token.sh bootstrap [--execute]  create the client, give it its role, issue the first token',
          '  ./api-token.sh rotate [--execute]     rotate if inside the window (--force: rotate anyway)',
          '  ./api-token.sh revoke <tokenId> [--execute]',
          '',
          'Authenticates with VCF_API_TOKEN_FILE (or VCF_ACCESS_TOKEN). For bootstrap,',
          'that is a token of an administrator created in VCF Operations. The token it',
          'maintains is TARGET_TOKEN_FILE, which defaults to VCF_API_TOKEN_FILE.',
          'No token is ever printed: only its last characters, as VCF Operations shows them.',
        ]),
        ...needPrivate(),
        ...parseArgs(['--force) FORCE=1 ;;']),
        'FORCE=${FORCE:-0}',
        'CMD="${1:-status}"',
        `CLIENT_ID=${sq(clientId)}`,
        `CLIENT_NAME=${sq(clientName)}`,
        `TTL_MIN=$(( ${tokenDays} * 24 * 60 ))`,
        `ACCESS_MIN=${accessMinutes}`,
        `ROTATE_DAYS=${rotateDays}`,
        `STRATEGY=${strategy}`,
        `TARGET_TOKEN_FILE="\${TARGET_TOKEN_FILE:-\${VCF_API_TOKEN_FILE:-${tokenFile}}}"`,
        'PROBLEMS=()',
        'if [[ -n "${VCF_API_TOKEN_FILE:-}" ]]; then need_private "$VCF_API_TOKEN_FILE"; fi',
        '',
        'REALM=$(api GET "${FM}/iam/ssorealms" | jq -r \'.ssoRealms[0].id // empty\')',
        '[[ -n "$REALM" ]] || { echo "No SSO realm found." >&2; exit 1; }',
        '',
        '# Every page, filtered to exactly this client; an unreadable list stops the script.',
        'tokens() {',
        '  query_all "${FM}/iam/ssorealms/${REALM}/api-tokens/query" \\',
        '    "$(jq -n --arg c "$CLIENT_ID" \'{searchTerms: {allOf: [{field: "CLIENT_ID", terms: [$c], operator: "LIKE"}], anyOf: []}, filters: {tokenType: ["API_CLIENT"]}}\')" apiTokens id \\',
        '    | jq -c --arg c "$CLIENT_ID" \'[.[] | select(.apiClientId == $c)]\'',
        '}',
        '# expirationDate is a Unix timestamp; allow for seconds or milliseconds.',
        'days_left() { jq -r \'(.expirationDate // 0) as $e | (if $e > 100000000000 then $e / 1000 else $e end) as $s | (($s - now) / 86400 | floor)\'; }',
        '',
        '# Prove a token works before anything depends on it: exchange it at the',
        '# identity broker, then read the realm with the access token it returns.',
        'prove() {',
        '  local file="$1" at',
        '  : "${VCF_IDB_HOST:?set VCF_IDB_HOST to prove the new token}"',
        '  at=$( { printf \'%s&api_token=\' \'grant_type=urn:custom:vcf:params:oauth:grant-type:api-token\'; jq -jn --rawfile p "$file" \'$p | rtrimstr("\\n") | @uri\'; } |',
        '    curl -sS -f -X POST "https://${VCF_IDB_HOST}/acs/t/CUSTOMER/token" -H "Accept: application/json" -H "Content-Type: application/x-www-form-urlencoded" --data-binary @- | jq -r \'.access_token // empty\') || return 1',
        '  [[ -n "$at" ]] || return 1',
        '  printf \'header = "Authorization: Bearer %s"\\n\' "$at" | curl -sS -f -K - "https://${VCFOPS_HOST}${FM}/iam/ssorealms" -H "Accept: application/json" >/dev/null',
        '}',
        '',
        '# Write a token from a JSON response on stdin to a new mode-600 file beside',
        '# the target, prove it, and only then move it into place. Never printed.',
        'install_token() {',
        '  local resp="$1" dir tmp',
        '  dir=$(dirname "$TARGET_TOKEN_FILE")',
        '  mkdir -p "$dir"',
        '  tmp=$(umask 077; mktemp "${dir}/.vcf-api-token.XXXXXX")',
        '  jq -r \'.token // empty\' <<<"$resp" > "$tmp"',
        '  chmod 600 "$tmp"',
        '  if [[ ! -s "$tmp" ]]; then rm -f "$tmp"; echo "The response carried no token." >&2; return 1; fi',
        '  if ! prove "$tmp"; then',
        '    echo "The new token did not work. It is left in ${tmp} (mode 600); the old file is untouched." >&2',
        '    return 1',
        '  fi',
        '  # Called from `if`, where set -e does not apply: every step is checked.',
        '  if [[ -f "$TARGET_TOKEN_FILE" ]]; then',
        '    cp -p "$TARGET_TOKEN_FILE" "${TARGET_TOKEN_FILE}.previous" || { echo "Could not keep a copy of the old token file; nothing replaced. The new token is in ${tmp}." >&2; return 1; }',
        '  fi',
        '  mv -f "$tmp" "$TARGET_TOKEN_FILE" || { echo "Could not move the new token into place; it is in ${tmp}." >&2; return 1; }',
        '  echo "New token in place: ${TARGET_TOKEN_FILE} (ends $(jq -r \'.tokenLastChars // "?"\' <<<"$resp"), expires $(jq -r \'(.expirationDate // 0) as $e | (if $e > 100000000000 then $e / 1000 else $e end) | todate\' <<<"$resp"))."',
        '}',
        '',
        'issue() {',
        '  jq -n --arg c "$CLIENT_ID" --arg n "${CLIENT_ID}-$(date +%Y%m%d)" --arg ttl "$TTL_MIN" --arg at "$ACCESS_MIN" --arg d "Issued by ArchToolKit api-token.sh" --arg tt API_CLIENT \\',
        '    \'{apiClientId: $c, tokenName: $n, tokenDescription: $d, tokenType: $tt, apiTokenTtl: $ttl, accessTokenTtl: $at}\' \\',
        '    | api POST "${FM}/iam/ssorealms/${REALM}/api-tokens" --data @-',
        '}',
        '',
        'case "$CMD" in',
        '  status)',
        '    ALL=$(tokens)',
        '    echo "API tokens of ${CLIENT_ID}: $(jq length <<<"$ALL")"',
        '    jq -r \'.[] | "  \\(.id)  \\(.tokenName)  ends \\(.tokenLastChars)  \\(.tokenStatus)  last used \\(.lastUsedDate // "never")"\' <<<"$ALL"',
        '    LEFT=$(jq -c \'[.[] | select((.tokenStatus // "ACTIVE") == "ACTIVE")] | max_by(.expirationDate // 0) // {}\' <<<"$ALL" | days_left)',
        '    echo "Newest active token: ${LEFT} day(s) left; rotation window ${ROTATE_DAYS} days."',
        '    if (( LEFT <= 0 )); then PROBLEMS+=("${CLIENT_ID}: no active API token, or it has expired — every fleet automation is failing"); ',
        '    elif (( LEFT <= ROTATE_DAYS )); then PROBLEMS+=("${CLIENT_ID}: API token has ${LEFT} day(s) left — rotation is due"); fi',
        '    if (( $(jq length <<<"$ALL") > 2 )); then PROBLEMS+=("${CLIENT_ID}: $(jq length <<<"$ALL") tokens exist — revoke the ones nothing uses"); fi',
        '    ;;',
        '',
        '  bootstrap)',
        '    EXISTING=$(api POST "${FM}/iam/ssorealms/${REALM}/api-clients/query?page=0&pageSize=50" --data \'{}\' \\',
        '      | jq -r --arg c "$CLIENT_ID" \'[(.apiClients // .clients // .elements // [])[] | select(.clientId == $c)][0].clientUuid // empty\')',
        '    if [[ -f "$TARGET_TOKEN_FILE" ]]; then echo "Refusing: ${TARGET_TOKEN_FILE} already exists. Use rotate." >&2; exit 1; fi',
        '    if (( DRY_RUN )); then',
        '      if [[ -n "$EXISTING" ]]; then WHAT="reuse client ${EXISTING}"; else WHAT="create API client ${CLIENT_ID}"; fi',
        '      echo "DRY RUN: would ${WHAT}, set its roles from role-assignment.json,"',
        '      echo "         issue a ${TTL_MIN}-minute API token and write it to ${TARGET_TOKEN_FILE} (mode 600) once it is proven."',
        '      jq . role-assignment.json',
        '      exit 0',
        '    fi',
        '    if [[ -z "$EXISTING" ]]; then',
        '      EXISTING=$(jq -n --arg c "$CLIENT_ID" --arg n "$CLIENT_NAME" \'{clientId: $c, clientName: $n, clientDescription: "Fleet automation (ArchToolKit)"}\' \\',
        '        | api POST "${FM}/iam/ssorealms/${REALM}/api-clients" --data @- | jq -r \'.clientUuid // empty\')',
        '      [[ -n "$EXISTING" ]] || { echo "The API client was sent but no clientUuid came back; check Identity > API clients." >&2; exit 1; }',
        '      echo "Created API client ${CLIENT_ID} (${EXISTING})"',
        '    fi',
        '    api PUT "${FM}/iam/ssorealms/${REALM}/principals/${EXISTING}/roles" --data @role-assignment.json >/dev/null',
        '    echo "Roles: $(api GET "${FM}/iam/ssorealms/${REALM}/principals/${EXISTING}/roles" | jq -r \'[.vcfRoleAssignments[]?.roleName] | join(", ")\')"',
        '    RESP=$(issue)',
        '    install_token "$RESP" || exit 1',
        '    ;;',
        '',
        '  rotate)',
        '    ALL=$(tokens)',
        '    CUR=$(jq -c \'[.[] | select((.tokenStatus // "ACTIVE") == "ACTIVE")] | max_by(.expirationDate // 0) // {}\' <<<"$ALL")',
        '    OLD_ID=$(jq -r \'.id // empty\' <<<"$CUR")',
        '    LEFT=$(days_left <<<"$CUR")',
        '    if (( LEFT > ROTATE_DAYS && ! FORCE )); then echo "Not due: ${LEFT} day(s) left, rotating at ${ROTATE_DAYS}. Nothing done."; exit 0; fi',
        '    [[ -n "$OLD_ID" || "$STRATEGY" == "overlap" ]] || { echo "No current token to regenerate; run bootstrap." >&2; exit 1; }',
        '    if (( DRY_RUN )); then',
        '      if [[ "$STRATEGY" == "overlap" ]]; then echo "DRY RUN: would issue a new token, prove it, replace ${TARGET_TOKEN_FILE}, then revoke ${OLD_ID:-nothing}.";',
        '      else echo "DRY RUN: would regenerate ${OLD_ID}, prove it and replace ${TARGET_TOKEN_FILE}."; fi',
        '      exit 0',
        '    fi',
        '    if [[ "$STRATEGY" == "overlap" ]]; then',
        '      RESP=$(issue)',
        '      NEW_ID=$(jq -r \'.id // empty\' <<<"$RESP")',
        '      if ! install_token "$RESP"; then',
        '        PROBLEMS+=("${CLIENT_ID}: new token ${NEW_ID} failed its proof; old token kept")',
        '      elif [[ -n "$OLD_ID" && "$OLD_ID" != "$NEW_ID" ]]; then',
        '        # The old token is revoked only now: the new one is on disk and has worked.',
        '        api DELETE "${FM}/iam/ssorealms/${REALM}/api-tokens/${OLD_ID}" >/dev/null && echo "Revoked the old token ${OLD_ID}." \\',
        '          || PROBLEMS+=("${CLIENT_ID}: could not revoke old token ${OLD_ID}; revoke it by hand")',
        '        rm -f "${TARGET_TOKEN_FILE}.previous"',
        '      fi',
        '    else',
        '      # Regenerating invalidates the old secret at once (VERIFY), so the',
        '      # file is replaced immediately after the proof, with no overlap.',
        '      RESP=$(api POST "${FM}/iam/ssorealms/${REALM}/api-tokens/${OLD_ID}/regenerate" --data \'{}\')',
        '      install_token "$RESP" || PROBLEMS+=("${CLIENT_ID}: regenerated token failed its proof — fix before the next run")',
        '    fi',
        '    ;;',
        '',
        '  revoke)',
        '    TID="${2:?token id to revoke}"',
        '    # The guard against revoking the live token needs both ends of the',
        '    # comparison; if either cannot be read, it refuses rather than skip it.',
        '    [[ -r "$TARGET_TOKEN_FILE" ]] || { echo "Refusing: cannot read ${TARGET_TOKEN_FILE} to check ${TID} is not the live token." >&2; exit 1; }',
        '    CURRENT_LAST=$(jq -rn --rawfile p "$TARGET_TOKEN_FILE" \'$p | rtrimstr("\\n") | .[-4:]\')',
        '    [[ ${#CURRENT_LAST} -eq 4 ]] || { echo "Refusing: ${TARGET_TOKEN_FILE} does not hold a token." >&2; exit 1; }',
        '    VICTIM=$(tokens | jq -c --arg t "$TID" \'.[] | select(.id == $t)\')',
        '    [[ -n "$VICTIM" ]] || { echo "No token ${TID} for ${CLIENT_ID}." >&2; exit 1; }',
        '    VICTIM_LAST=$(jq -r \'.tokenLastChars // empty\' <<<"$VICTIM")',
        '    [[ -n "$VICTIM_LAST" ]] || { echo "Refusing: VCF Operations gave no tokenLastChars for ${TID}, so it cannot be told apart from the live token." >&2; exit 1; }',
        '    if [[ "$VICTIM_LAST" == *"$CURRENT_LAST" || "$CURRENT_LAST" == *"$VICTIM_LAST" ]]; then',
        '      echo "Refusing: ${TID} looks like the token in ${TARGET_TOKEN_FILE}. Rotate first." >&2; exit 1',
        '    fi',
        '    if (( DRY_RUN )); then echo "DRY RUN: would revoke $(jq -r \'"\\(.tokenName) ending \\(.tokenLastChars)"\' <<<"$VICTIM")."; exit 0; fi',
        '    if api DELETE "${FM}/iam/ssorealms/${REALM}/api-tokens/${TID}" >/dev/null; then echo "Revoked ${TID}."; else echo "Revoking ${TID} failed." >&2; exit 1; fi',
        '    ;;',
        '  *) echo "unknown command $CMD" >&2; exit 2 ;;',
        'esac',
        '',
        'if (( ${#PROBLEMS[@]} > 0 )); then',
        '  printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...notify(webhook, 'vcf-api-token').map((line) => `  ${line}`),
        '  exit 1',
        'fi',
        '',
      ].join('\n');

      const crontab = [
        `# ${base}: status every morning (alerts on the exit code), rotation attempt every`,
        '# night — it does nothing until the token is inside the rotation window.',
        '# Both authenticate with the token file itself; no token is in these lines.',
        `15 7 * * * cd /opt/archtoolkit/${base} && ${scheduledEnv('vcf-fleet')} ./api-token.sh status >> /var/log/archtoolkit/${base}.log 2>&1`,
        `45 2 * * * cd /opt/archtoolkit/${base} && ${scheduledEnv('vcf-fleet')} ./api-token.sh rotate --execute >> /var/log/archtoolkit/${base}.log 2>&1`,
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `API client ${clientId} and its ${tokenDays}-day API token, rotated at ${rotateDays} days`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `Bootstrap once by hand; then status daily and a rotation attempt nightly, which acts only inside the last ${rotateDays} days.`, worstCase: `one rotation every ${tokenDays - rotateDays} days or so; a status alert every morning while the token is inside the window` },
        scope: {
          what: `API client ${clientId}, its role ${roleName} (${scopeType}), and its API tokens. Nothing else.`,
          decidedBy: ['GET /iam/ssorealms — the first SSO realm.', `API tokens queried by CLIENT_ID ${clientId} and filtered to exactly that apiClientId.`, 'The token file at TARGET_TOKEN_FILE.'],
          ifWrong: 'If the new token is not in the file and the old one is revoked, every fleet script in this kit stops logging in until someone issues a token by hand.',
        },
        guardrails: [
          { rule: 'A new token is proven — exchanged at the identity broker and used for a read — before it replaces the file', because: 'A token that was issued but does not work would otherwise silently break every automation at the next run.' },
          { rule: 'The file is replaced atomically from a mode-600 temp file in the same directory', because: 'A reader never sees half a token, and the token is never readable by others even for a moment.' },
          { rule: 'The old token is revoked only after the new one is in place and proven (overlap strategy)', because: 'Revoke-then-issue leaves a window where nothing can log in, and a failure in that window leaves it open.' },
          { rule: `Rotation does nothing until fewer than ${rotateDays} days are left`, because: 'A nightly job that rotated every night would revoke tokens other copies might still be using.' },
          { rule: 'revoke refuses the token currently in the file', because: 'Revoking the live token by mistake is the one way this script can stop everything at once.' },
          { rule: 'Refuses a token file that is not mode 600 or 400; never prints a token', because: 'The API token is a long-lived credential with the client’s role.' },
          { rule: 'bootstrap refuses if the token file already exists', because: 'Bootstrapping twice would overwrite a working token with a new client’s.' },
        ],
        dryRun: ['Every command except status prints what it would do unless given --execute.', 'status only reads.'],
        undo: [
          'After a rotation the previous file is kept as <token file>.previous until the old token is revoked; restore it with mv if the new one misbehaves.',
          'A revoked token cannot be restored. Issue a new one with bootstrap (after moving the file aside) or from Identity > API clients in VCF Operations.',
          'To remove the client: DELETE /iam/ssorealms/{realm}/api-clients/{clientId}, after revoking its tokens.',
        ],
        told: [webhook ? `${webhook}, when the token is inside the window, has expired, a rotation fails, or tokens pile up.` : 'The exit code only.', 'VCF Operations shows each token’s creation, expiry and last use under Identity > API clients.'],
        requires: [
          'For bootstrap: an administrator’s API token (SSO user token) created in VCF Operations, in a mode-600 file set as VCF_API_TOKEN_FILE, with TARGET_TOKEN_FILE set to the new file.',
          `The role ${roleName} existing, with the privileges the other scripts need: vcf_certificates.*, vcf_password.*, identity.management.*, administration.fleetSettings.*, configuration_drifts.*, and always ops.administration.management_tasks.* and administration.api.read_access.`,
          'VCF_IDB_HOST (the identity broker) and VCFOPS_HOST set; jq, curl and bash 4.',
        ],
        files: {
          'api-token.sh': script,
          'role-assignment.json': json({ vcfRoleAssignments: [assignment] }),
          'crontab.txt': crontab,
          'IMPORT.md': fleetImport(
            'The API client, its roles and its token are created through the API; role-assignment.json is exactly the body of PUT .../iam/ssorealms/{realm}/principals/{clientUuid}/roles.',
            [
              { heading: 'Bootstrap the client', lines: ['`./api-token.sh bootstrap` (dry run), then `--execute`: creates the API client, PUTs role-assignment.json as its roles, issues a token and writes it to the token file (mode 600). In the interface: Manage > Identity & Access > API clients (VERIFY the menu name on your build).'] },
              { heading: 'Rotate on a schedule', lines: ['Install the line in crontab.txt with `crontab -e`.'] },
            ],
          ),
        },
        notes: [
          'Confirmed (davidwzhang.com API Access part 8; VCF Operations API reference, IAM APIs): GET /iam/ssorealms; POST /iam/ssorealms/{id}/api-clients {clientId, clientName, clientDescription} returning clientUuid; PUT /iam/ssorealms/{id}/principals/{clientUuid}/roles {vcfRoleAssignments}; POST /iam/ssorealms/{id}/api-tokens {apiClientId, tokenName, tokenType API_CLIENT, apiTokenTtl, accessTokenTtl in minutes} returning token, tokenLastChars, expirationDate; POST api-tokens/query; POST api-tokens/{id}/regenerate; DELETE api-tokens/{id}.',
          'Confirmed: the exchange POST https://<identity broker>/acs/t/CUSTOMER/token, grant_type urn:custom:vcf:params:oauth:grant-type:api-token, returning an access token of about 1,800 seconds.',
          'VERIFY: whether regenerate invalidates the previous secret immediately (the overlap strategy does not depend on it); the api-clients/query response key; whether expirationDate is seconds or milliseconds (the script accepts both).',
          'Keep an emergency client (Identity > Emergency access) with its token offline. It is the way back in if this client’s role or token is ever broken.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet91_licensing',
    platform: PLATFORM,
    label: 'License usage report and license server notes (VCF 9.1)',
    group: 'Licensing (9.1)',
    description:
      'In 9.1 licenses live in a license server appliance beside VCF Operations, and in connected mode the license file is refreshed every 24 hours. This writes a read-only usage report as CSV — and exits non-zero when anything reports expired, over-used or non-compliant — plus the steps for the parts that stay in the interface: registration, connected mode, and overriding the license on one host or cluster.',
    inputs: [
      { id: 'csv', label: 'CSV file', control: 'text', default: 'license-usage.csv' },
      { id: 'override_asset', label: 'Asset to override (for the steps)', control: 'text', default: 'esx-lab-01.example.com', hint: 'One ESX host or vSAN cluster that needs a different license from its vCenter' },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-licensing' },
    ],
    automation: (values                 , name        )             => {
      const csv = str(values, 'csv', 'license-usage.csv');
      const asset = str(values, 'override_asset', '');
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'license-usage', 'license-usage');
      const findings            = [];
      if (!/\.csv$/i.test(csv)) findings.push(warning('fleet91.license.csv', `"${csv}" does not end in .csv; spreadsheets will not open it by default.`, { source: SRC }));

      const report = readScript('vcf-fleet', 'VCF license usage, as CSV. Exits 1 when anything reports expired, over-used or non-compliant.', [
        `CSV=${sq(csv)}`,
        'PROBLEMS=()',
        '',
        '# Confirmed (VCF Operations API reference, Product Licensing): the license',
        '# info and edition of this VCF Operations instance.',
        'get /suite-api/api/product/licensing/info > licensing-info.json',
        '# The edition is kept for the record only; nothing below reads it.',
        'get /suite-api/api/product/licensing/edition > licensing-edition.json || echo "  (edition could not be read)" >&2',
        'echo "VCF Operations licensing:"; jq -c . licensing-info.json',
        '',
        '# VERIFY: the fleet license usage endpoint (license server capacity, used and',
        '# free, per asset) is not in the public reference at the time of writing. Set',
        '# LICENSE_USAGE_PATH from the reference for your release; the flattening below',
        '# does not depend on its exact shape.',
        'SRC_JSON=licensing-info.json',
        'if [[ -n "${LICENSE_USAGE_PATH:-}" ]]; then get "$LICENSE_USAGE_PATH" > license-usage.json; SRC_JSON=license-usage.json; fi',
        '',
        '# Flatten the largest array of objects in the response into CSV, one column',
        '# per scalar field. Nested values are written as JSON text.',
        'jq -r \'',
        '  ([.. | arrays | select(length > 0 and all(.[]; type == "object"))] | max_by(length) // [.]) as $rows',
        '  | ($rows | map(keys_unsorted) | add | unique) as $cols',
        '  | ($cols | @csv), ($rows[] | [ .[$cols[]] | if type == "object" or type == "array" then tojson else . end ] | @csv)\' "$SRC_JSON" > "$CSV"',
        'echo "Wrote $(( $(wc -l < "$CSV") - 1 )) row(s) to ${CSV}."',
        '',
        '# Into a variable first: a jq failure here stops the script rather than',
        '# reading as "nothing reported".',
        'FLAGGED=$(jq -r \'',
        '  [.. | objects | select(any(.[]; type == "string" and test("expired|over.?used|overage|non.?compliant|out of compliance|violation"; "i")))]',
        '  | .[] | [.. | scalars | tostring] | join(" ") | .[0:200]\' "$SRC_JSON")',
        'while IFS= read -r line; do if [[ -n "$line" ]]; then PROBLEMS+=("$line"); fi; done <<<"$FLAGGED"',
        'if (( ${#PROBLEMS[@]} == 0 )); then echo "Nothing reports expired, over-used or non-compliant."; exit 0; fi',
        'printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...notify(webhook, 'vcf-licensing'),
        'exit 1',
      ]);

      const steps = [
        'VCF 9.1 licensing — the steps that stay in the interface (Broadcom techdocs 9.1, Licensing).',
        '',
        'LICENSE SERVER',
        '- Deployed as its own appliance with VCF Operations (new installs and upgrades to 9.1). It is mandatory:',
        '  at least one license server per VCF Operations instance. 2 vCPU, 4 GB RAM, 8 GB disk; up to 250,000 assets.',
        '- 9.1.0 is IPv4 only; 9.1.1 adds IPv6 (static, DHCPv6, SLAAC).',
        '- A second license server suits another region with >300 ms latency, or a tenant that must be separate.',
        '- If it is down, workloads keep running; usage reports and new assignments wait until it is back.',
        '- Back it up with the other management components (fleet91_lifecycle), and include it in certificate',
        '  checks: 9.1.1 manages its certificate (fleet91_certificates, appliance LICENSE_SERVER).',
        '',
        'CONNECTED MODE',
        '- VCF Operations > Licenses & Registration: register VCF Operations and the license server with the VCF',
        '  Business Services console. In connected, automated mode usage goes to Broadcom every 24 hours and the',
        '  updated license file is downloaded and applied with no one involved.',
        '- Disconnected: generate the usage file, upload it in the Business Services console, import the license',
        '  file it returns. VCF Operations must reach its license server at least every 180 days.',
        '',
        `OVERRIDE ON ONE ASSET (new in 9.1)${asset ? ` — ${asset}` : ''}`,
        '- Manage > Licensing: select the asset (one ESX host or vSAN cluster), Assign license, choose the license.',
        '  An override on the asset takes priority over the license assigned at vCenter level.',
        '- Record overrides in the change log: nothing else shows that one host differs from its vCenter.',
        '',
        'AFTER PATCHING THE LICENSE SERVER TO 9.1.1',
        '- Known issue: used capacity can show higher than actual. Compare with the CSV before acting on it.',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: 'Report VCF license usage as CSV',
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Weekly, and before any renewal conversation.', worstCase: 'once a week' },
        scope: {
          what: 'License information VCF Operations reports. Reads only; the override and registration steps are in the interface.',
          decidedBy: ['GET /suite-api/api/product/licensing/info.', 'LICENSE_USAGE_PATH, when set, for per-asset usage from the license server.'],
          ifWrong: 'Nothing changes. A report that reads the wrong endpoint shows the wrong numbers, which is why the raw JSON is kept beside the CSV.',
        },
        guardrails: [],
        dryRun: ['license-report.sh only reads. Compare its CSV with Licenses & Registration once.'],
        undo: ['Nothing to undo.'],
        told: [webhook ? `${webhook}, when anything reports expired, over-used or non-compliant.` : 'The exit code only.'],
        requires: ['An API client with read access to licensing (vcf_viewer is enough for the info endpoint) — see fleet91_api_clients.', 'jq and bash 4.'],
        files: {
          'license-report.sh': report,
          'license-steps.txt': steps,
          'crontab.txt': cron(base, '0 8 * * 1', 'license-report.sh'),
          'IMPORT.md': fleetImport('Licences are assigned in the interface; license-steps.txt is the click path. The report only reads.', [cronStep('license-report.sh'), { heading: 'Assign', lines: ['Follow license-steps.txt.'] }]),
        },
        notes: [
          'Confirmed: GET /suite-api/api/product/licensing/info and /edition (VCF Operations API reference). Licensing APIs are available to all customers from 9.1 (VMware blog, May 2026).',
          'VERIFY: the license server usage and assignment endpoints; they are not in the public reference at the time of writing, so the report takes the path from LICENSE_USAGE_PATH and flattens whatever it returns.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet91_config_drift',
    platform: PLATFORM,
    label: 'Configuration drift on vSphere Configuration Profile clusters (VCF 9.1)',
    group: 'Configuration (9.1)',
    description:
      'Clusters managed by vSphere Configuration Profiles have a desired configuration, and VCF Operations shows where hosts have drifted from it. Detect runs the compliance check on each cluster and exits non-zero on drift. Remediate is separate: one cluster per run, precheck first, the current configuration exported as the undo, and nothing applied without --execute. The 9.1.1 VMware Salt for VCF Components status comes with both.',
    inputs: [
      {
        id: 'mode',
        label: 'Do',
        control: 'select',
        options: [
          { value: 'detect', label: 'Detect drift (read-only report)' },
          { value: 'remediate', label: 'Remediate one cluster' },
        ],
        default: 'detect',
      },
      { id: 'vcenter', label: 'vCenter', control: 'text', default: 'vcenter-wld01.example.com' },
      { id: 'clusters', label: 'Clusters', control: 'text', default: 'wld01-cl01, wld01-cl02', hint: 'Comma separated', showWhen: { input: 'mode', equals: ['detect'] } },
      { id: 'cluster', label: 'Cluster', control: 'text', default: 'wld01-cl01', hint: 'Exactly one', showWhen: { input: 'mode', equals: ['remediate'] } },
      { id: 'timeout_minutes', label: 'Give up after (minutes)', control: 'number', default: 90, min: 5, max: 600 },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-drift' },
    ],
    automation: (values                 , name        )             => {
      const mode = str(values, 'mode', 'detect');
      const vcenter = str(values, 'vcenter', '');
      const remediate = str(values, 'mode', 'detect') === 'remediate';
      const clusters = listOf(str(values, remediate ? 'cluster' : 'clusters', ''));
      const timeout = num(values, 'timeout_minutes', 90);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || `drift-${mode}`, 'drift');

      const findings            = [];
      if (clusters.length === 0) findings.push(error('fleet91.drift.no-cluster', 'Name at least one cluster.', { source: SRC }));
      if (remediate && clusters.length > 1) findings.push(error('fleet91.drift.one-cluster', `Remediation is one cluster per run; ${clusters.length} were given.`, { remediation: 'Remediate the least important cluster first and read the result before the next.', source: SRC }));
      if (remediate) findings.push(warning('fleet91.drift.reboot', 'Some configuration settings need a host reboot. Remediation puts hosts into maintenance mode one after another.', { remediation: 'Check DRS is fully automated and the cluster has room for one host out.', source: SRC }));

      const vcAuth = [
        `VC=${sq(vcenter)}`,
        '# vCenter session: VCENTER_SESSION if given, otherwise log in with VCENTER_USER',
        '# and the password in VCENTER_PASSWORD_FILE (mode 600), sent to curl on stdin.',
        'if [[ -z "${VCENTER_SESSION:-}" ]]; then',
        '  : "${VCENTER_USER:?set VCENTER_USER and VCENTER_PASSWORD_FILE, or VCENTER_SESSION}"',
        '  : "${VCENTER_PASSWORD_FILE:?set VCENTER_PASSWORD_FILE to a mode-600 file}"',
        '  need_private "$VCENTER_PASSWORD_FILE"',
        '  VCENTER_SESSION=$(jq -rn --arg u "$VCENTER_USER" --rawfile p "$VCENTER_PASSWORD_FILE" \'"user = \\(($u + ":" + ($p | rtrimstr("\\n"))) | tojson)"\' \\',
        '    | curl -sS -f -K - -X POST "https://${VC}/api/session" | jq -r \'if type == "string" then . else empty end\')',
        'fi',
        '[[ -n "$VCENTER_SESSION" ]] || { echo "No vCenter session." >&2; exit 1; }',
        '# The session id goes to curl from a private header file (-H @file), never as',
        '# an argument that ps and /proc would show to every user on the host.',
        'VC_HDR=$(umask 077; mktemp "${TMPDIR:-/tmp}/atk-vc.XXXXXX")',
        'trap \'rm -f "$VC_HDR"\' EXIT',
        'printf \'vmware-api-session-id: %s\\n\' "$VCENTER_SESSION" > "$VC_HDR"',
        'vc() {',
        '  local method="$1" path="$2"; shift 2',
        '  curl -sS -f -X "$method" "https://${VC}${path}" -H "@${VC_HDR}" -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
        '}',
        '# Matched by exact name here too: a filter vCenter ignored would otherwise',
        '# hand back the first cluster it has.',
        'cluster_id() { vc GET "/api/vcenter/cluster?names=$1" | jq -r --arg n "$1" \'[.[] | select(.name == $n)] | if length == 1 then .[0].cluster else empty end\'; }',
        `DEADLINE=$(( $(date +%s) + ${timeout} * 60 ))`,
        '# Follow a vCenter task to the end; print its result.',
        'wait_task() {',
        '  local t="$1" s="UNKNOWN" body misses=0',
        '  [[ -n "$t" && "$t" != null ]] || { echo "no task id" >&2; return 1; }',
        '  while :; do',
        '    if ! body=$(vc GET "/api/cis/tasks/${t}"); then',
        '      misses=$(( misses + 1 ))',
        '      if (( misses >= 6 )); then echo "task ${t}: status unreadable ${misses} times in a row" >&2; return 1; fi',
        '      sleep 20; continue',
        '    fi',
        '    misses=0',
        '    s=$(jq -r \'.status // "UNKNOWN"\' <<<"$body")',
        '    case "$s" in',
        '      SUCCEEDED) jq -c \'.result // {}\' <<<"$body"; return 0 ;;',
        '      FAILED|CANCELED|CANCELLED) echo "task ${t} ${s}: $(jq -c \'.error // {}\' <<<"$body")" >&2; return 1 ;;',
        '    esac',
        '    if (( $(date +%s) > DEADLINE )); then echo "task ${t} still ${s} at the deadline" >&2; return 1; fi',
        '    sleep 20',
        '  done',
        '}',
      ];

      const detect = [
        '#!/usr/bin/env bash',
        `# Detect configuration drift on ${clusters.join(', ')} (vSphere Configuration Profiles).`,
        '#',
        '# Starts vCenter’s compliance check on each cluster — which changes nothing on',
        '# the hosts — and reports the result. Exits 1 when any cluster has drifted or',
        '# could not be checked. VCF Operations shows the same result under',
        '# Fleet management > Configuration drifts once it next collects.',
        'set -euo pipefail',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        ...needPrivate(),
        ...vcAuth,
        'PROBLEMS=()',
        `for C in ${clusters.map(sq).join(' ')}; do`,
        '  ID=$(cluster_id "$C")',
        '  if [[ -z "$ID" ]]; then PROBLEMS+=("${C}: no such cluster on ${VC}"); continue; fi',
        '  if ! T=$(vc POST "/api/esx/settings/clusters/${ID}/configuration?action=checkCompliance&vmw-task=true" | jq -r .); then',
        '    PROBLEMS+=("${C}: compliance check refused — is the cluster managed by a configuration profile?"); continue',
        '  fi',
        '  if ! R=$(wait_task "$T"); then PROBLEMS+=("${C}: compliance check did not finish"); continue; fi',
        '  STATUS=$(jq -r \'.status // .cluster_status // "UNKNOWN"\' <<<"$R")',
        '  echo "${C}: ${STATUS}"',
        '  jq -r \'(.hosts // {}) | to_entries[] | "  \\(.key): \\(.value.status // .value)"\' <<<"$R" 2>/dev/null || true',
        '  [[ "$STATUS" == "COMPLIANT" ]] || PROBLEMS+=("${C}: ${STATUS}")',
        'done',
        '',
        'if (( ${#PROBLEMS[@]} == 0 )); then echo "No drift."; exit 0; fi',
        'printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...notify(webhook, 'vcf-config-drift'),
        'exit 1',
        '',
      ].join('\n');

      const cluster = clusters[0] ?? '<REQUIRED — cluster>';
      const remediateScript = [
        '#!/usr/bin/env bash',
        `# Remediate configuration drift on ONE cluster: ${cluster} on ${vcenter}.`,
        '#',
        '#   ./remediate-drift.sh             export the current configuration, check',
        '#                                    compliance, run the precheck; change nothing',
        '#   ./remediate-drift.sh --execute   all that, then apply if the precheck passed',
        '#',
        '# Hosts may enter maintenance mode, and some settings reboot them.',
        'set -euo pipefail',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        ...needPrivate(),
        ...parseArgs(),
        ...vcAuth,
        `C=${sq(cluster)}`,
        'ID=$(cluster_id "$C")',
        '[[ -n "$ID" ]] || { echo "No cluster ${C} on ${VC}." >&2; exit 1; }',
        '',
        '# The undo: the configuration as it is now, before anything is applied.',
        'STAMP=$(date +%Y%m%d-%H%M%S)',
        'T=$(vc POST "/api/esx/settings/clusters/${ID}/configuration?action=exportConfig&vmw-task=true" | jq -r .)',
        'wait_task "$T" > "config-before-${C}-${STAMP}.json"',
        'jq -e \'. != null and . != {}\' "config-before-${C}-${STAMP}.json" >/dev/null || { echo "Refusing: the configuration export is empty, so there would be no undo." >&2; exit 1; }',
        'echo "Current configuration exported to config-before-${C}-${STAMP}.json"',
        '',
        'T=$(vc POST "/api/esx/settings/clusters/${ID}/configuration?action=checkCompliance&vmw-task=true" | jq -r .)',
        'R=$(wait_task "$T")',
        'STATUS=$(jq -r \'.status // .cluster_status // "UNKNOWN"\' <<<"$R")',
        'echo "Compliance: ${STATUS}"',
        'if [[ "$STATUS" == "COMPLIANT" ]]; then echo "Nothing to remediate."; exit 0; fi',
        '',
        '# Guardrail: the precheck has to pass. It finds hosts that cannot enter',
        '# maintenance mode, or settings that cannot be applied, before anything moves.',
        'T=$(vc POST "/api/esx/settings/clusters/${ID}/configuration?action=precheck&vmw-task=true" | jq -r .)',
        'P=$(wait_task "$T") || { echo "Refusing: the precheck did not complete." >&2; exit 1; }',
        'jq . <<<"$P" > "precheck-${C}-${STAMP}.json"',
        'PSTATUS=$(jq -r \'.status // "UNKNOWN"\' <<<"$P")',
        'echo "Precheck: ${PSTATUS} (precheck-${C}-${STAMP}.json)"',
        '# Only an explicit pass goes on. A missing or unfamiliar status is not a pass.',
        'case "$PSTATUS" in',
        '  OK|SUCCESS|SUCCEEDED|PASSED) ;;',
        '  WARNING) echo "The precheck passed with warnings; read precheck-${C}-${STAMP}.json before --execute." ;;',
        '  *) echo "Refusing: the precheck status is ${PSTATUS}, not a pass." >&2; exit 1 ;;',
        'esac',
        '',
        'if (( DRY_RUN )); then echo "DRY RUN: would apply the desired configuration to ${C}. Nothing was changed."; exit 0; fi',
        '',
        'T=$(vc POST "/api/esx/settings/clusters/${ID}/configuration?action=apply&vmw-task=true" --data \'{}\' | jq -r .)',
        'echo "Remediation task ${T}"',
        'wait_task "$T" | jq .',
        'T=$(vc POST "/api/esx/settings/clusters/${ID}/configuration?action=checkCompliance&vmw-task=true" | jq -r .)',
        'AFTER=$(wait_task "$T" | jq -r \'.status // .cluster_status // "UNKNOWN"\')',
        'echo "After: ${AFTER}"',
        'if [[ "$AFTER" != "COMPLIANT" ]]; then echo "The cluster is still ${AFTER} after remediation. Read the task above before running again." >&2; exit 1; fi',
        '',
      ].join('\n');

      const salt = readScript('vcf-fleet', 'VMware Salt for VCF Components (9.1.1): which resources are and are not under Salt management.', [
        '# Confirmed (VCF Operations API reference, Salt Management): statuses, per-resource',
        '# status, enable, key rotation and tasks under /suite-api/api/salt.',
        '# VERIFY: the configuration-settings endpoints of the 9.1.1 Salt for VCF',
        '# Components API are not in the public reference at the time of writing.',
        'PROBLEMS=()',
        'get /suite-api/api/salt/resources/statuses > salt-statuses.json',
        '# The list must be a list; iterating some other object would find nothing',
        '# wrong with anything.',
        'jq -c \'(if type == "array" then . else (.resourceStatuses // .statuses // .elements) end) | if type == "array" then . else error("unrecognised Salt statuses response") end\' salt-statuses.json > salt-list.json',
        'jq -r \'.[] | "\\(.resourceId // .id)\\t\\(.resourceName // .name // "")\\t\\(.status // .saltStatus // "NO STATUS")"\' salt-list.json',
        'FLAGGED=$(jq -r \'.[] | select((.status // .saltStatus // "NO STATUS" | ascii_upcase) | test("FAIL|ERROR|DISCONNECT|NO STATUS")) | "\\(.resourceName // .resourceId // .id): \\(.status // .saltStatus // "no status")"\' salt-list.json)',
        'while IFS= read -r line; do if [[ -n "$line" ]]; then PROBLEMS+=("$line"); fi; done <<<"$FLAGGED"',
        'if (( ${#PROBLEMS[@]} == 0 )); then echo "$(jq length salt-list.json) Salt resource(s); none reports a failure."; exit 0; fi',
        'printf "%s\\n" "${PROBLEMS[@]}" >&2',
        'exit 1',
      ]);

      const files                         = remediate
        ? { 'remediate-drift.sh': remediateScript, 'salt-status.sh': salt }
        : { 'detect-drift.sh': detect, 'salt-status.sh': salt, 'crontab.txt': [`# ${base}: daily drift check. vCenter login comes from the mode-600 password file;`, '# no password is in this line.', `30 6 * * * cd /opt/archtoolkit/${base} && VCENTER_USER=svc-drift@vsphere.local VCENTER_PASSWORD_FILE=/etc/archtoolkit/vcenter-password ./detect-drift.sh >> /var/log/archtoolkit/${base}.log 2>&1`, ''].join('\n') };
      files['IMPORT.md'] = fleetImport(
        'Nothing is imported: the scripts call the vCenter configuration-profile API and the VCF Operations Salt API.',
        [remediate ? { heading: 'Remediate one cluster', lines: ['`./remediate-drift.sh` (precheck and export of the current configuration), then `--execute`.'] } : cronStep('detect-drift.sh')],
      );

      return {
        platform: PLATFORM,
        title: remediate ? `Remediate configuration drift on ${cluster}` : `Detect configuration drift on ${clusters.length} cluster(s)`,
        effect: remediate ? 'reversible' : 'read',
        trigger: remediate ? { kind: 'manual', detail: 'Run by hand in a change window, after the detect report shows drift.', worstCase: 'once per run, every host in one cluster' } : { kind: 'schedule', detail: 'Daily, from a scheduler outside vCenter.', worstCase: 'once a day per cluster' },
        scope: {
          what: remediate ? `Every host in ${cluster}, brought back to the cluster’s configuration profile.` : `The configuration profile compliance of ${clusters.join(', ')}. The check changes nothing on the hosts.`,
          decidedBy: [`GET /api/vcenter/cluster?names=… on ${vcenter}.`, 'The desired configuration of each cluster, which is whatever the profile says now — not what it said when the drift appeared.'],
          ifWrong: remediate ? 'A setting someone changed on purpose on one host is put back, and hosts pass through maintenance mode during the day.' : 'Nothing changes; a cluster that is not profile-managed is reported as not checkable.',
        },
        guardrails: remediate
          ? [
              { rule: 'One cluster per run', because: 'A remediation that goes wrong should cost one cluster’s capacity, not a workload domain’s.' },
              { rule: 'Exports the current configuration before anything else', because: 'That export is the only undo.' },
              { rule: 'Refuses unless vCenter’s precheck completes without errors', because: 'The precheck finds hosts that cannot evacuate before one is half in maintenance mode.' },
              { rule: 'Applies nothing without --execute', because: 'The compliance result deserves a read before hosts start moving.' },
              { rule: `Gives up after ${timeout} minutes`, because: 'A remediation stuck on one host should page someone, not run into the morning.' },
            ]
          : [],
        dryRun: remediate ? ['remediate-drift.sh without --execute exports, checks and prechecks, and applies nothing.'] : ['detect-drift.sh only starts compliance checks, which change nothing on the hosts.'],
        undo: remediate ? ['Import config-before-<cluster>-<time>.json (POST …/configuration?action=importConfig) and apply again — or, better, fix the profile if the drift was the intended state.'] : ['Nothing to undo.'],
        told: [...(!remediate && webhook ? [`${webhook}, when any cluster has drifted.`] : []), 'vCenter records each task; VCF Operations shows the drift under Fleet management > Configuration drifts.'],
        requires: ['Clusters managed by vSphere Configuration Profiles (Desired State – Configuration in vCenter).', 'A vCenter account with the configuration profile privileges, its password in a mode-600 file.', 'For salt-status.sh: an API client with read access — see fleet91_api_clients.', 'jq and bash 4.'],
        files,
        notes: [
          'Detection and remediation are vCenter’s: the VCF Operations configuration drift view reads the same result, and its documentation says remediation happens in vCenter, not in VCF Operations.',
          'Confirmed paths: /api/esx/settings/clusters/{cluster}/configuration with action checkCompliance, precheck, apply, exportConfig and importConfig (vSphere Automation API; govmomi).',
          'VERIFY: the fields of the compliance and precheck results (status, hosts), and the apply body — this sends {} and relies on the cluster’s remediation settings. Only a precheck status of OK, SUCCESS, SUCCEEDED, PASSED or WARNING lets remediation go on; any other value, or none, refuses.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet91_lifecycle',
    platform: PLATFORM,
    label: 'Lifecycle and backup of the management components (VCF 9.1)',
    group: 'Lifecycle (9.1)',
    description:
      'The fleet lifecycle service upgrades and backs up the management components — VCF Operations, the identity broker, VCF Automation, the management services — per VCF instance. This lists what is installed, checks the last backup is recent, configures the SFTP backup schedule, and builds and prechecks an upgrade plan. Applying the plan is gated behind --execute, a change reference, a passed precheck and a backup newer than the limit.',
    inputs: [
      {
        id: 'part',
        label: 'Generate',
        control: 'select',
        options: [
          { value: 'all', label: 'Inventory, backup check, backup schedule and upgrade plan' },
          { value: 'backup', label: 'Inventory, backup check and backup schedule' },
          { value: 'upgrade', label: 'Inventory, backup check and upgrade plan' },
        ],
        default: 'all',
      },
      { id: 'lcm_host', label: 'Fleet lifecycle host', control: 'text', default: 'fleet-lcm.example.com', hint: 'The VCF management services runtime FQDN' },
      { id: 'backup_hours', label: 'Last backup must be newer than (hours)', control: 'number', default: 24, min: 1, max: 720 },
      { id: 'sftp_host', label: 'SFTP server', control: 'text', default: 'sftp.example.com', showWhen: { input: 'part', notEquals: ['upgrade'] } },
      { id: 'sftp_port', label: 'SFTP port', control: 'number', default: 22, min: 1, max: 65535, showWhen: { input: 'part', notEquals: ['upgrade'] } },
      { id: 'sftp_user', label: 'SFTP user', control: 'text', default: 'svc-vcf-backup', showWhen: { input: 'part', notEquals: ['upgrade'] } },
      { id: 'sftp_dir', label: 'Directory', control: 'text', default: '/backups/vcf/management', showWhen: { input: 'part', notEquals: ['upgrade'] } },
      { id: 'sftp_fingerprint', label: 'SSH host key fingerprint', control: 'text', default: '', hint: 'SHA256:… from ssh-keygen -lf', showWhen: { input: 'part', notEquals: ['upgrade'] } },
      { id: 'days', label: 'Full backup on', control: 'text', default: 'MON, TUE, WED, THU, FRI, SAT, SUN', showWhen: { input: 'part', notEquals: ['upgrade'] } },
      { id: 'start', label: 'At (UTC, HH:MM)', control: 'text', default: '02:00', showWhen: { input: 'part', notEquals: ['upgrade'] } },
      { id: 'max_backups', label: 'Keep backups', control: 'number', default: 14, min: 1, max: 100, showWhen: { input: 'part', notEquals: ['upgrade'] } },
      { id: 'target_version', label: 'Target VCF version', control: 'text', default: '9.1.1.0', showWhen: { input: 'part', notEquals: ['backup'] } },
    ],
    automation: (values                 , name        )             => {
      const part = str(values, 'part', 'all');
      const lcmHost = str(values, 'lcm_host', '');
      const backupHours = num(values, 'backup_hours', 24);
      const fingerprint = str(values, 'sftp_fingerprint', '');
      const days = listOf(str(values, 'days', '')).map((day) => day.slice(0, 3).toUpperCase());
      const start = str(values, 'start', '02:00');
      const target = str(values, 'target_version', '9.1.1.0');
      const doBackup = part !== 'upgrade';
      const doUpgrade = part !== 'backup';
      const base = slugOf(name || 'fleet-lifecycle', 'fleet-lifecycle');

      const findings            = [];
      if (doBackup && !fingerprint) findings.push(warning('fleet91.lcm.fingerprint', 'No SSH host key fingerprint: the backup target is trusted on first use.', { remediation: 'ssh-keygen -lf the SFTP server’s host key and paste the SHA256 value.', source: SRC }));
      if (doBackup && !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) findings.push(error('fleet91.lcm.start', `"${start}" is not HH:MM.`, { source: SRC }));
      if (doBackup && days.some((day) => !['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].includes(day))) findings.push(error('fleet91.lcm.days', 'Backup days must be MON to SUN.', { source: SRC }));
      if (doUpgrade && !/^\d+\.\d+\.\d+\.\d+$/.test(target)) findings.push(error('fleet91.lcm.version', `"${target}" is not a four-part VCF version such as 9.1.1.0.`, { source: SRC }));
      if (backupHours > 48) findings.push(warning('fleet91.lcm.stale-backup', `Allowing a ${backupHours}-hour-old backup before an upgrade means restoring would lose up to ${Math.round(backupHours / 24)} days of configuration.`, { source: SRC }));

      const backupSpec = {
        backupConfigSpec: {
          fullSchedule: { enabled: true, schedule: { days, startTime: `${start}Z` } },
          incrementalSchedule: { enabled: false },
          retention: { maxBackups: num(values, 'max_backups', 14) },
          storage: { sftp: { host: str(values, 'sftp_host', ''), port: String(num(values, 'sftp_port', 22)), username: str(values, 'sftp_user', ''), directory: str(values, 'sftp_dir', ''), thumbprint: fingerprint || '<REQUIRED — SHA256 host key fingerprint>' } },
        },
      };

      const script = [
        '#!/usr/bin/env bash',
        '# Fleet lifecycle of the VCF management components, through the Fleet LCM API.',
        '#',
        '#   ./fleet-lifecycle.sh inventory                        components and versions (read)',
        `#   ./fleet-lifecycle.sh backup-status                    exit 1 if a backup is older than ${backupHours}h (read)`,
        ...(doBackup ? ['#   ./fleet-lifecycle.sh backup-config [--execute]        set the SFTP schedule from backup-config.json'] : []),
        ...(doUpgrade
          ? [
              `#   ./fleet-lifecycle.sh plan [--execute]                 create an upgrade plan to ${target}`,
              '#   ./fleet-lifecycle.sh precheck <planId>                run and show the plan precheck',
              '#   ./fleet-lifecycle.sh apply <planId> --execute --change <ref>',
            ]
          : []),
        '#',
        '# Authentication, as the Fleet LCM API reference documents it: an OpsToken from',
        '# VCF Operations, exchanged at /suite-api/api/auth/token/exchange for a Fleet LCM',
        '# token. VERIFY whether the exchange also accepts the identity broker Bearer token.',
        'set -euo pipefail',
        '',
        ...authPreamble('vcf-operations'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        `LCM_HOST="\${FLEET_LCM_HOST:-${lcmHost}}"`,
        `BACKUP_HOURS=${backupHours}`,
        `TARGET=${sq(target)}`,
        ...needPrivate(),
        ...parseArgs(['--change) shift; CHANGE="${1:-}" ;;']),
        'CHANGE="${CHANGE:-}"',
        'CMD="${1:-inventory}"',
        'PROBLEMS=()',
        '',
        'LCM_AT=0',
        '# The Fleet LCM token lives in its own private header file, like the OpsToken:',
        '# curl reads it with -H @file, so it is never an argument. Both files go at exit.',
        'LCM_HDR=$(umask 077; mktemp "${TMPDIR:-/tmp}/atk-lcm.XXXXXX")',
        `trap 'rm -f "${OPS_HDR}" "$LCM_HDR"' EXIT`,
        'lcm_login() {',
        '  (( $(date +%s) - LCM_AT < 1200 )) && return 0',
        '  local t',
        '  t=$(curl -sS -f -X POST "https://${VCFOPS_HOST}/suite-api/api/auth/token/exchange" \\',
        `    -H "${authHeader('vcf-operations')}" -H "Accept: application/json" -H "Content-Type: application/json" \\`,
        '    --data \'{"serviceKeys":["fleet-lcm"]}\' | jq -r \'.jwtToken // empty\') || t=""',
        '  [[ -n "$t" ]] || { echo "Could not get a Fleet LCM token." >&2; exit 1; }',
        '  printf \'Authorization: Bearer %s\\n\' "$t" > "$LCM_HDR"',
        '  LCM_AT=$(date +%s)',
        '}',
        'lcm() {',
        '  local method="$1" path="$2"; shift 2',
        '  curl -sS -f -X "$method" "https://${LCM_HOST}/fleet-lcm/v1${path}" -H "@${LCM_HDR}" -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
        '}',
        'wait_lcm_task() {',
        '  local t="$1" s="UNKNOWN" i misses=0',
        '  for (( i = 0; i < 720; i++ )); do',
        '    lcm_login',
        '    if ! s=$(lcm GET "/tasks/${t}" | jq -r \'.status // "UNKNOWN"\'); then',
        '      misses=$(( misses + 1 ))',
        '      if (( misses >= 6 )); then echo "  task ${t}: status unreadable ${misses} times in a row" >&2; return 1; fi',
        '      sleep 20; continue',
        '    fi',
        '    misses=0',
        '    case "$s" in',
        '      SUCCEEDED) echo "  task ${t}: SUCCEEDED"; return 0 ;;',
        '      FAILED|CANCELLED|CANCELED) echo "  task ${t}: ${s}" >&2; lcm GET "/tasks/${t}" | jq -c \'.stages // .errors // {}\' >&2; return 1 ;;',
        '    esac',
        '    sleep 20',
        '  done',
        '  echo "  task ${t}: still ${s} after four hours" >&2; return 1',
        '}',
        '',
        '# The newest backup point per component, in hours, one line per component:',
        '#   <sddcLcmId> TAB <componentType> TAB <name> TAB <hours, or -1 if unreadable>',
        '# Returns non-zero — and check_backups then refuses — if any instance or',
        '# backup list cannot be read or is not the shape expected. Written to a file',
        '# and checked, never read through < <( ), where a failure would be lost.',
        'backup_ages() {',
        '  local ids id',
        '  ids=$(lcm GET /sddc-lcms | jq -r \'(if type == "array" then . else (.elements // .sddcLcms) end) | if type == "array" then .[] | (.id // .sddcLcmId // error("an instance has no id")) else error("unrecognised sddc-lcms response") end\') || return 1',
        '  [[ -n "$ids" ]] || { echo "No VCF instances registered with the fleet lifecycle service." >&2; return 1; }',
        '  for id in $ids; do',
        '    lcm GET "/sddc-lcms/${id}/backups?pageSize=100" | jq -r --arg lcm "$id" \'',
        '      if (.backups | type) != "array" then error("no backups array for \\($lcm)") else . end',
        '      | .backups[] | (.points // [] | map(tostring | sub("\\\\.[0-9]+"; "") | (try fromdateiso8601 catch (try tonumber catch null))) | map(select(. != null)) | max) as $t',
        '      | "\\($lcm)\\t\\(.componentType // "?")\\t\\(.name // .componentId // "?")\\t\\(if $t == null then -1 else ((now - (if $t > 100000000000 then $t / 1000 else $t end)) / 3600 | floor) end)"\' || { echo "Backups of instance ${id} could not be read." >&2; return 1; }',
        '  done',
        '}',
        'BACKUP_ROWS=""',
        'check_backups() {',
        '  local n=0 lcmid type comp age',
        '  if ! BACKUP_ROWS=$(backup_ages); then PROBLEMS+=("the backup list could not be read in full — no backup is assumed"); return 0; fi',
        '  while IFS=$\'\\t\' read -r lcmid type comp age; do',
        '    [[ -n "$lcmid" ]] || continue',
        '    n=$(( n + 1 ))',
        '    if [[ ! "$age" =~ ^-?[0-9]+$ ]] || (( age < 0 )); then PROBLEMS+=("${type} ${comp}: no readable backup point"); ',
        '    elif (( age > BACKUP_HOURS )); then PROBLEMS+=("${type} ${comp}: last backup ${age}h ago (limit ${BACKUP_HOURS}h)");',
        '    else echo "  ok  ${type} ${comp}: ${age}h ago"; fi',
        '  done <<<"$BACKUP_ROWS"',
        '  (( n > 0 )) || PROBLEMS+=("no backups listed for any component")',
        '}',
        '',
        '# The precheck gate. Every component in the plan must carry an explicit',
        '# passing precheck status. No component list, an empty one, or any component',
        '# whose status is missing or unfamiliar blocks the apply: "could not read"',
        '# is never "passed". Prints one line per blocker; prints nothing when clear.',
        'plan_blockers() {',
        '  jq -r \'',
        '    (.components | if type == "object" then .elements elif type == "array" then . else null end) as $c',
        '    | if ($c | type) != "array" then "the plan has no component list (looked for .components.elements and .components)"',
        '      elif ($c | length) == 0 then "the plan lists no components"',
        '      else $c[]',
        '        | (.precheck.status // null) as $s',
        '        | select(($s | type) != "string" or (($s | ascii_upcase) | test("^(SUCCEEDED|SUCCESSFUL|COMPLETED|PASSED)$") | not))',
        '        | "\\(.type // .componentType // "?") \\(.fqdn // .name // "?"): precheck \\($s // "not run / no status")"',
        '      end\' <<<"$1"',
        '}',
        '',
        'lcm_login',
        'case "$CMD" in',
        '  inventory)',
        '    lcm GET /components | jq -r \'(.elements // .components // .)[]? | "\\(.type // .componentType)\\t\\(.fqdn // .name)\\t\\(.version)\\t\\(.status // "")"\'',
        '    ;;',
        '  backup-status)',
        '    check_backups',
        '    ;;',
        ...(doBackup
          ? [
              '  backup-config)',
              '    : "${SFTP_PASSWORD_FILE:?set SFTP_PASSWORD_FILE to a mode-600 file holding the SFTP password}"',
              '    : "${BACKUP_PASSPHRASE_FILE:?set BACKUP_PASSPHRASE_FILE to a mode-600 file holding the backup encryption passphrase}"',
              '    need_private "$SFTP_PASSWORD_FILE"; need_private "$BACKUP_PASSPHRASE_FILE"',
              '    grep -q "<REQUIRED" backup-config.json && { echo "backup-config.json still has <REQUIRED> values." >&2; exit 1; }',
              '    IDS=$(lcm GET /sddc-lcms | jq -r \'(if type == "array" then . else (.elements // .sddcLcms) end) | if type == "array" then .[] | (.id // .sddcLcmId // error("an instance has no id")) else error("unrecognised sddc-lcms response") end\')',
              '    [[ -n "$IDS" ]] || { echo "No VCF instances registered with the fleet lifecycle service; nothing to configure." >&2; exit 1; }',
              '    if (( DRY_RUN )); then echo "DRY RUN: would PATCH /fleet-lcm/v1/sddc-lcms/{id} for: ${IDS//$\'\\n\'/ } with backup-config.json plus the SFTP password and passphrase from their files."; exit 0; fi',
              '    for id in $IDS; do',
              '      T=$(jq --rawfile pw "$SFTP_PASSWORD_FILE" --rawfile pp "$BACKUP_PASSPHRASE_FILE" \\',
              '            \'.backupConfigSpec.storage.sftp.password = ($pw | rtrimstr("\\n")) | .backupConfigSpec.encryptionPassphrase = ($pp | rtrimstr("\\n"))\' backup-config.json \\',
              '          | lcm PATCH "/sddc-lcms/${id}" --data-binary @- | jq -r \'.id // .taskId // empty\')',
              '      echo "Backup configuration for ${id}: task ${T:-none}"',
              '      [[ -z "$T" ]] || wait_lcm_task "$T" || PROBLEMS+=("backup configuration of ${id} failed")',
              '    done',
              '    ;;',
            ]
          : []),
        ...(doUpgrade
          ? [
              '  plan)',
              '    BODY=$(jq -n --arg v "$TARGET" \'{spec: {desiredSoftware: {version: $v, components: []}, componentsFilter: []}}\')',
              '    if (( DRY_RUN )); then echo "DRY RUN: would POST /fleet-lcm/v1/upgrade-plans:"; jq . <<<"$BODY"; exit 0; fi',
              '    PLAN=$(lcm POST /upgrade-plans --data "$BODY")',
              '    PLAN_ID=$(jq -r \'.id // .planId // empty\' <<<"$PLAN")',
              '    [[ -n "$PLAN_ID" ]] || { echo "The plan was sent but no plan id came back; check Fleet management > Lifecycle." >&2; exit 1; }',
              '    echo "Plan ${PLAN_ID}:"',
              '    jq -r \'.components.elements[]? | "  \\(.type)\\t\\(.fqdn)\\t\\(.version) -> \\(.targetVersion)\\t\\(.status)"\' <<<"$PLAN"',
              '    echo "Next: ./fleet-lifecycle.sh precheck <planId>"',
              '    ;;',
              '  precheck)',
              '    PLAN_ID="${2:?plan id}"',
              '    R=$(lcm POST "/upgrade-plans/${PLAN_ID}?action=precheck" --data \'{}\')',
              '    T=$(jq -r \'.taskId // .executions[-1].taskId // .id // empty\' <<<"$R")',
              '    if [[ -n "$T" ]]; then',
              '      wait_lcm_task "$T" || PROBLEMS+=("precheck task ${T} did not succeed")',
              '    else',
              '      echo "No precheck task id came back; reading the plan as it stands."',
              '    fi',
              '    PLAN_JSON=$(lcm GET "/upgrade-plans/${PLAN_ID}")',
              '    jq -r \'(.components | if type == "object" then .elements elif type == "array" then . else [] end)[]? | "  \\(.type // .componentType)\\t\\(.fqdn // .name)\\t\\(.version) -> \\(.targetVersion)\\tprecheck \\(.precheck.status // "not run")"\' <<<"$PLAN_JSON"',
              '    BLOCKERS=$(plan_blockers "$PLAN_JSON")',
              '    while IFS= read -r line; do if [[ -n "$line" ]]; then PROBLEMS+=("not ready: ${line}"); fi; done <<<"$BLOCKERS"',
              '    if [[ -z "$BLOCKERS" ]]; then echo "Every component in the plan passed its precheck."; fi',
              '    ;;',
              '  apply)',
              '    PLAN_ID="${2:?plan id}"',
              '    # Guardrails. Each fails closed: what cannot be read counts as not passed.',
              '    # The dry run runs them too, so it says whether --execute would proceed.',
              '    if (( ! DRY_RUN )); then [[ -n "$CHANGE" ]] || { echo "Refusing: give the change reference with --change." >&2; exit 1; }; fi',
              '    PLAN_JSON=$(lcm GET "/upgrade-plans/${PLAN_ID}")',
              '    BLOCKERS=$(plan_blockers "$PLAN_JSON")',
              '    NCOMP=$(jq \'(.components | if type == "object" then .elements elif type == "array" then . else [] end) // [] | length\' <<<"$PLAN_JSON")',
              '    if [[ -n "$BLOCKERS" ]]; then',
              '      echo "Refusing: the plan has not passed its precheck:" >&2; sed \'s/^/  /\' <<<"$BLOCKERS" >&2',
              '      echo "Run ./fleet-lifecycle.sh precheck ${PLAN_ID} and read it." >&2; exit 1',
              '    fi',
              '    echo "Precheck: all ${NCOMP} component(s) in the plan passed."',
              '    check_backups',
              '    # Every component type in the plan must be among the backups just checked.',
              '    MISSING_BACKUP=$(jq -r --arg rows "$BACKUP_ROWS" \'',
              '      ($rows | split("\\n") | map(select(length > 0) | split("\\t")[1] | ascii_upcase) | unique) as $backed',
              '      | [(.components | if type == "object" then .elements else . end)[] | (.type // .componentType // "?") | ascii_upcase] | unique',
              '      | map(select(. as $t | $backed | index($t) | not)) | .[]\' <<<"$PLAN_JSON")',
              '    while IFS= read -r line; do if [[ -n "$line" ]]; then PROBLEMS+=("${line}: in the plan, but no backup of that component type is listed"); fi; done <<<"$MISSING_BACKUP"',
              '    if (( ${#PROBLEMS[@]} > 0 )); then printf "%s\\n" "${PROBLEMS[@]}" >&2; echo "Refusing: every component in the plan needs a backup newer than ${BACKUP_HOURS}h first." >&2; exit 1; fi',
              '    if (( DRY_RUN )); then echo "DRY RUN: the precheck and backup gates pass. Re-run with --execute --change <ref> to apply plan ${PLAN_ID}. Nothing was changed."; exit 0; fi',
              '    echo "Change ${CHANGE}: applying plan ${PLAN_ID}."',
              '    R=$(lcm POST "/upgrade-plans/${PLAN_ID}?action=apply" --data \'{}\')',
              '    T=$(jq -r \'.taskId // .executions[-1].taskId // .id // empty\' <<<"$R")',
              '    [[ -n "$T" ]] || { echo "No task id returned; follow the plan in VCF Operations." >&2; exit 1; }',
              '    wait_lcm_task "$T" || PROBLEMS+=("upgrade plan ${PLAN_ID} task ${T} did not succeed")',
              '    ;;',
            ]
          : []),
        '  *) echo "unknown command $CMD" >&2; exit 2 ;;',
        'esac',
        '',
        'if (( ${#PROBLEMS[@]} > 0 )); then printf "%s\\n" "${PROBLEMS[@]}" >&2; exit 1; fi',
        '',
      ].join('\n');

      const restore = [
        'Restoring a management component (VCF 9.1 fleet lifecycle).',
        '',
        '- Backups are listed per VCF instance: GET /fleet-lcm/v1/sddc-lcms/{sddcLcmId}/backups',
        '  (fleet-lifecycle.sh backup-status reads the same list).',
        '- A restore is started with POST /fleet-lcm/v1/sddc-lcms/{sddcLcmId}/backups. VERIFY: the body is not',
        '  in the public reference at the time of writing; start restores from VCF Operations > Fleet',
        '  management > Lifecycle, or follow techdocs 9.1 "Component Backup and Restore of VMware Cloud',
        '  Foundation" and "VCF Instance Backup and Restore".',
        '- A restore needs the encryption passphrase the backup was taken with. Keep BACKUP_PASSPHRASE_FILE in',
        '  the vault as well as on this machine: without it the backups are unreadable.',
        '- After a failed upgrade, restore the component to the version it was at, from a backup taken before',
        '  the upgrade started — which is what the backup check before apply is for.',
        '',
      ].join('\n');

      const files                         = {
        'fleet-lifecycle.sh': script,
        'restore-notes.txt': restore,
        'crontab.txt': [`# ${base}: backup freshness every morning. The script logs in from the password`, '# file (mode 600); no password or token is in this line.', `0 8 * * * cd /opt/archtoolkit/${base} && ${scheduledEnv('vcf-operations', 'svc-fleet-lcm')} FLEET_LCM_HOST=${lcmHost || 'fleet-lcm.example.com'} ./fleet-lifecycle.sh backup-status >> /var/log/archtoolkit/${base}.log 2>&1`, ''].join('\n'),
      };
      if (doBackup) files['backup-config.json'] = json(backupSpec);
      files['IMPORT.md'] = fleetImport(
        doBackup
          ? 'backup-config.json is the PATCH /fleet-lcm/v1/sddc-lcms/{id} body (backupConfigSpec) without its two secrets: fleet-lifecycle.sh adds the SFTP password and the encryption passphrase from their mode-600 files in memory, then sends it to each VCF instance.'
          : 'Nothing is imported: the script drives the fleet lifecycle API.',
        [
          doBackup ? { heading: 'Set the backup schedule', lines: ['Replace the <REQUIRED> SSH host-key fingerprint in backup-config.json, then `./fleet-lifecycle.sh backup-config` (dry run) and `--execute`. In the interface: Fleet management > Lifecycle > the instance > Backup settings.'] } : undefined,
          { heading: 'Check backups every morning', lines: ['Install the line in crontab.txt with `crontab -e`; it runs `fleet-lifecycle.sh backup-status`.'] },
          doUpgrade ? { heading: 'Upgrade', lines: ['`./fleet-lifecycle.sh` with the upgrade commands its header lists, dry run first; the apply step needs `--execute --change <ref>`.'] } : undefined,
        ],
        ['The backupConfigSpec field names follow the 9.1 fleet lifecycle API as the script cites it; the restore body is not public (restore-notes.txt).'],
      );

      return {
        platform: PLATFORM,
        title: `Fleet lifecycle of the management components${doUpgrade ? ` — upgrade to ${target}` : ''}${doBackup ? ', with scheduled SFTP backup' : ''}`,
        effect: doUpgrade ? 'irreversible' : 'reversible',
        trigger: { kind: 'manual', detail: `By hand for the backup schedule${doUpgrade ? ' and each upgrade' : ''}; the backup check runs daily from cron.`, worstCase: doUpgrade ? 'once per plan, every component in it' : 'once per run' },
        scope: {
          what: `The management components the fleet lifecycle service manages${doBackup ? ' (backup: every registered VCF instance)' : ''}${doUpgrade ? `; the upgrade: every component in the plan to ${target}` : ''}.`,
          decidedBy: ['GET /fleet-lcm/v1/sddc-lcms — every VCF instance registered with the fleet lifecycle service.', ...(doUpgrade ? ['The upgrade plan: components the service finds eligible for the target version, shown by plan and precheck before apply.'] : [])],
          ifWrong: doUpgrade ? 'A management component upgraded out of step with the others, or half upgraded; the way back is a restore from the backup taken before.' : 'Backups going to the wrong place, or none at all, found only on the day one is needed.',
        },
        guardrails: [
          ...(doUpgrade
            ? [
                { rule: 'apply needs --execute and a change reference (--change)', because: 'An upgrade of the management plane is a change; the reference ties the run to its approval.' },
                { rule: 'apply refuses unless every component in the plan has passed its precheck', because: 'A failed precheck is the upgrade failing early, cheaply; applying past it fails late and expensively.' },
                { rule: `apply refuses unless every component has a backup newer than ${backupHours} hours`, because: 'The only undo of an upgrade is a restore, and a restore is only as recent as the backup.' },
              ]
            : []),
          ...(doBackup
            ? [
                { rule: 'The SFTP password and encryption passphrase are read from mode-600 files and sent on stdin', because: 'Either one in a script or an argument is a way into every backup of the management plane.' },
                { rule: 'Refuses a backup configuration with <REQUIRED> values', because: 'A missing host key fingerprint means trusting whatever answers on first use.' },
              ]
            : []),
          { rule: 'Nothing changes without --execute', because: 'Every acting command prints what it would send first.' },
        ],
        dryRun: ['inventory, backup-status and precheck read (a precheck changes no component).', 'backup-config, plan and apply print what they would send unless given --execute.'],
        undo: [...(doBackup ? ['Backup schedule: PATCH the previous settings back, or disable fullSchedule.'] : []), ...(doUpgrade ? ['An upgrade cannot be rolled back in place. Restore each component from the backup taken before apply (restore-notes.txt).'] : [])],
        told: ['VCF Operations shows fleet lifecycle tasks under Fleet management > Lifecycle.', 'The change record named with --change.'],
        requires: ['A VCF Operations account with fleet lifecycle rights for the OpsToken, its password in a mode-600 file (VCFOPS_USER, VCFOPS_PASSWORD_FILE).', 'The fleet lifecycle host (FLEET_LCM_HOST).', ...(doBackup ? ['An SFTP server with space for the management components, its password and a backup passphrase in mode-600 files.'] : []), 'jq, curl and bash 4.'],
        files,
        notes: [
          'Confirmed (developer.broadcom.com, VCF Fleet LCM Service APIs): base /fleet-lcm/v1 on the fleet lifecycle host; authentication by POST /suite-api/api/auth/token/exchange {"serviceKeys":["fleet-lcm"]} with an OpsToken, returning jwtToken; GET /components; GET /sddc-lcms; PATCH /sddc-lcms/{id} with backupConfigSpec (williamlam.com, July 2026); GET /sddc-lcms/{id}/backups; POST /upgrade-plans, ?action=precheck and ?action=apply; GET /tasks/{id}. The reference says these APIs may change in future releases.',
          'VERIFY: the format of backups[].points (read here as ISO 8601 or epoch); the list keys of /components and /sddc-lcms; the body of a restore; the precheck status values (only SUCCEEDED, SUCCESSFUL, COMPLETED or PASSED count as a pass — any other, or none, blocks apply); that backups[].componentType uses the same names as the plan’s component type (apply refuses a plan component type with no backup listed).',
          'Workload domains are still upgraded through SDDC Manager: see the SDDC Manager precheck blueprint in this kit.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet91_cloud_proxy',
    platform: PLATFORM,
    label: 'Cloud proxy HA collector groups and health (VCF 9.1)',
    group: 'Cloud proxies (9.1)',
    description:
      'Put cloud proxies in a collector group with HA and — new in 9.1 — load balancing across its members, check every proxy is up and heard from recently, and (9.1.1) set outbound network proxy settings when a new cloud proxy is deployed. The health check is read-only and exits non-zero; changing the group is dry run until --execute.',
    inputs: [
      { id: 'group_name', label: 'Collector group', control: 'text', default: 'site-a-ha' },
      { id: 'proxies', label: 'Cloud proxies (names)', control: 'text', default: 'cp-site-a-01, cp-site-a-02', hint: 'As VCF Operations lists them. Two or more for HA' },
      { id: 'lb', label: 'Load-balance collection across the group', control: 'toggle', default: true },
      { id: 'vip', label: 'Virtual IP (optional)', control: 'text', default: '', hint: 'Only if your design uses one for the group' },
      { id: 'heartbeat_minutes', label: 'A proxy is late after (minutes)', control: 'number', default: 15, min: 5, max: 240 },
      { id: 'outbound_proxy', label: 'Outbound proxy for new cloud proxies (9.1.1)', control: 'text', default: '', hint: 'http://proxy.example.com:3128 — empty for none' },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-cloud-proxies' },
    ],
    automation: (values                 , name        )             => {
      const groupName = str(values, 'group_name', 'site-a-ha');
      const proxies = listOf(str(values, 'proxies', ''));
      const lb = bool(values, 'lb', true);
      const vip = str(values, 'vip', '');
      const late = num(values, 'heartbeat_minutes', 15);
      const outbound = str(values, 'outbound_proxy', '');
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'cloud-proxy', 'cloud-proxy');

      const findings            = [];
      if (proxies.length < 2) findings.push(error('fleet91.cp.one', 'An HA collector group needs at least two cloud proxies.', { source: SRC }));
      if (outbound && !/^https?:\/\/[^\s:]+:\d+/.test(outbound)) findings.push(warning('fleet91.cp.outbound', `"${outbound}" does not look like http(s)://host:port.`, { source: SRC }));
      if (/@/.test(outbound)) findings.push(error('fleet91.cp.outbound-creds', 'Do not put proxy credentials in the URL; they end up in files and logs. Enter them in the OVA properties at deploy time.', { source: SRC }));

      const group = { name: groupName, description: 'Written by ArchToolKit.', collectorId: ['<REQUIRED — cloud proxy ids; collector-group.sh fills them from the names>'], haEnabled: true, lbEnabled: lb, ...(vip ? { virtualIP: vip } : {}) };

      const apply = [
        ...head(`Create or update the HA collector group "${groupName}" with ${proxies.join(', ')}.`, [
          'Refuses unless every named cloud proxy exists and is UP: a group built from',
          'a proxy that is down fails over to nothing.',
        ]),
        ...parseArgs(),
        `NAMES=${sq(JSON.stringify(proxies))}`,
        `GROUP=${sq(groupName)}`,
        '# VERIFY: the collector list key (collector) and state value (UP).',
        'COLLECTORS=$(api GET /suite-api/api/collectors | jq -c \'.collector // .collectors // []\')',
        'SEL=$(jq -c --argjson n "$NAMES" \'[.[] | select(.name as $x | $n | index($x))]\' <<<"$COLLECTORS")',
        'FOUND=$(jq length <<<"$SEL")',
        'if (( FOUND != $(jq length <<<"$NAMES") )); then',
        '  echo "Refusing: found ${FOUND} of $(jq length <<<"$NAMES") cloud proxies. Known: $(jq -r \'[.[].name] | join(", ")\' <<<"$COLLECTORS")" >&2; exit 1',
        'fi',
        'DOWN=$(jq -r \'[.[] | select((.state // "") != "UP") | "\\(.name)=\\(.state)"] | join(", ")\' <<<"$SEL")',
        '[[ -z "$DOWN" ]] || { echo "Refusing: not UP: ${DOWN}" >&2; exit 1; }',
        'IDS=$(jq -c \'[.[].id | tonumber? // .]\' <<<"$SEL")',
        '# An unrecognised list stops here: read as "no groups", it would create a',
        '# second group of the same name.',
        'EXISTING=$(api GET /suite-api/api/collectorgroups | jq -c --arg g "$GROUP" \'(.collectorGroups // .collectorGroup) | if type == "array" then ([.[] | select(.name == $g)] | if length > 1 then error("\\(length) groups are named \\($g)") else (.[0] // empty) end) else error("unrecognised collectorgroups response") end\')',
        'BODY=$(jq --argjson ids "$IDS" --argjson ex "${EXISTING:-null}" \'.collectorId = $ids | if $ex then .id = $ex.id else . end\' collector-group.json)',
        'if [[ -n "$EXISTING" ]]; then',
        '  echo "Group exists with members $(jq -c .collectorId <<<"$EXISTING"); would become ${IDS}."',
        '  METHOD=PUT',
        'else',
        '  METHOD=POST',
        'fi',
        'if (( DRY_RUN )); then echo "DRY RUN: would ${METHOD} /suite-api/api/collectorgroups:"; jq . <<<"$BODY"; exit 0; fi',
        '[[ -n "$EXISTING" ]] && jq . <<<"$EXISTING" > "collector-group-before-$(date +%Y%m%d-%H%M%S).json"',
        'api "$METHOD" /suite-api/api/collectorgroups --data "$BODY" | jq \'{id, name, haEnabled, lbEnabled, collectorId}\'',
        'echo "Now move the adapter instances that should fail over onto the group (Administration > Integrations > each account > Collector)."',
        '',
      ].join('\n');

      const health = readScript('vcf-fleet', 'Are the cloud proxies up, recently heard from, and are HA groups still HA?', [
        `LATE_MIN=${late}`,
        'PROBLEMS=()',
        'NOW_MS=$(( $(date +%s) * 1000 ))',
        '# Files, not arguments: the collector list of a large fleet can pass the',
        '# 128 KB limit on one argument. Lists that are not lists stop the script;',
        '# an empty list would otherwise read as "every proxy is up".',
        'WORK=$(mktemp -d)',
        'get /suite-api/api/collectors | jq -c \'(.collector // .collectors) | if type == "array" then . else error("unrecognised collectors response") end\' > "${WORK}/collectors.json"',
        'if [[ "$(jq length "${WORK}/collectors.json")" == "0" ]]; then echo "VCF Operations listed no collectors at all; cannot judge." >&2; rm -rf "$WORK"; exit 1; fi',
        'get /suite-api/api/collectorgroups | jq -c \'(.collectorGroups // .collectorGroup) | if type == "array" then . else error("unrecognised collectorgroups response") end\' > "${WORK}/groups.json"',
        'jq -r \'.[] | "  \\(.name)\\t\\(.state)\\t\\(.hostName // "")\\tlast heartbeat \\(if .lastHeartbeat then (.lastHeartbeat / 1000 | strftime("%H:%M UTC")) else "?" end)"\' "${WORK}/collectors.json"',
        'LATE=$(jq -r --argjson now "$NOW_MS" --argjson late "$LATE_MIN" \'',
        '  .[] | select((.local // false) | not)',
        '  | if (.state // "") != "UP" then "\\(.name): state \\(.state // "unknown")"',
        '    elif (.lastHeartbeat // 0) < ($now - $late * 60000) then "\\(.name): no heartbeat for \\((($now - (.lastHeartbeat // 0)) / 60000) | floor) minutes"',
        '    else empty end\' "${WORK}/collectors.json")',
        '',
        '# An HA group with fewer than two members UP is not HA any more.',
        'THIN=$(jq -r --slurpfile c "${WORK}/collectors.json" \'',
        '  .[] | select(.haEnabled == true)',
        '  | (.collectorId // []) as $ids',
        '  | ([$c[0][] | select((.id | tostring) as $i | $ids | map(tostring) | index($i)) | select(.state == "UP")] | length) as $up',
        '  | select($up < 2) | "collector group \\(.name): only \\($up) member(s) UP — no failover left"\' "${WORK}/groups.json")',
        'rm -rf "$WORK"',
        'while IFS= read -r line; do if [[ -n "$line" ]]; then PROBLEMS+=("$line"); fi; done <<<"${LATE}"$\'\\n\'"${THIN}"',
        'if (( ${#PROBLEMS[@]} == 0 )); then echo "Every cloud proxy is up and HA groups have a spare."; exit 0; fi',
        'printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...notify(webhook, 'vcf-cloud-proxies'),
        'exit 1',
      ]);

      const outboundNotes = [
        'Outbound network proxy for cloud proxies (VCF 9.1.1).',
        '',
        '- From 9.1.1, the cloud proxy OVA asks for Outbound Network Proxy Settings when a NEW cloud proxy is',
        '  deployed, so it can reach external endpoints (for example public cloud APIs) through your proxy.',
        `- Proxy for this site: ${outbound || '(none set — leave the OVA fields empty)'}`,
        '- Enter any proxy credentials in the OVA properties at deploy time, never in a URL or a script.',
        '- VERIFY: the OVF property names, if you deploy with ovftool or PowerCLI rather than the wizard —',
        '  read them from the OVA itself: ovftool --hideEula <cloud-proxy>.ova | sed -n "/Properties:/,$p"',
        '- Test from the cloud proxy console after deployment:',
        outbound ? `    curl -sS -o /dev/null -w "%{http_code}\\n" -x ${outbound} https://www.broadcom.com` : '    curl -sS -o /dev/null -w "%{http_code}\\n" https://www.broadcom.com',
        '- Existing cloud proxies are not changed by this; redeploy, or follow the release notes for your build.',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `HA collector group ${groupName}${lb ? ' with load balancing' : ''}, and cloud proxy health`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'The group by hand; the health check every fifteen minutes from cron.', worstCase: 'health: every 15 minutes while a proxy is down' },
        scope: {
          what: `Collector group ${groupName} and its members ${proxies.join(', ')}. The health check reads every cloud proxy and HA group.`,
          decidedBy: ['GET /suite-api/api/collectors — matched by name; refused unless every name is found and UP.', 'GET /suite-api/api/collectorgroups — the group of that name is updated if it exists, created if not.'],
          ifWrong: 'Adapter instances on the group move between proxies that cannot reach their endpoints, and collection gaps appear until they are moved back.',
        },
        guardrails: [
          { rule: 'Refuses unless every named cloud proxy exists and is UP', because: 'A group built with a proxy that is down has no failover from the moment it is created.' },
          { rule: 'The generator refuses a group of fewer than two proxies', because: 'HA with one member is a label, not a failover.' },
          { rule: 'Saves the existing group before a change', because: 'The previous membership is the undo.' },
          { rule: 'Dry run unless --execute', because: 'Membership changes move collection, which is best seen before it happens.' },
        ],
        dryRun: ['collector-group.sh without --execute resolves the proxies and prints the body.', 'proxy-health.sh only reads.'],
        undo: ['PUT collector-group-before-<time>.json back to /suite-api/api/collectorgroups, or DELETE /suite-api/api/collectorgroups/{id} for a group this created.'],
        told: [webhook ? `${webhook}, when a proxy is down, late, or an HA group has no spare.` : 'The exit code only.'],
        requires: ['Two or more cloud proxies deployed at the same site, able to reach the same endpoints.', 'An API client with collector group rights — see fleet91_api_clients.', 'jq and bash 4.'],
        files: {
          'collector-group.sh': apply,
          'collector-group.json': json(group),
          'proxy-health.sh': health,
          'outbound-proxy.txt': outboundNotes,
          'crontab.txt': cron(base, '*/15 * * * *', 'proxy-health.sh'),
          'IMPORT.md': fleetImport(
            'collector-group.json is the collector group body; collectorId is left as a placeholder because the cloud proxy ids exist only in your VCF Operations — collector-group.sh looks them up by name and fills them (and the id, when the group exists) before sending.',
            [
              { heading: 'Create the collector group', lines: ['`./collector-group.sh` (dry run), then `--execute`. In the interface: Administration > Collector Groups > Add.'] },
              cronStep('proxy-health.sh'),
            ],
          ),
        },
        notes: [
          'Confirmed (VCF Operations API reference): /suite-api/api/collectorgroups (POST, PUT, GET, DELETE) with name, collectorId, haEnabled, lbEnabled, virtualIP; GET /suite-api/api/collectors. 9.1 adds load balancing for cloud proxies in HA-enabled collector groups.',
          'VERIFY: the list keys of GET collectors (collector) and collectorgroups (collectorGroups), the state value UP and lastHeartbeat in epoch milliseconds; the body of PUT collectorgroups (this sends the full group with its id).',
          'Cloud proxy certificates are in the fleet certificate inventory from 9.1.1 (fleet91_certificates, appliance CLOUD_PROXY); their passwords and policy in fleet91_password_rotate and fleet91_password_policy.',
        ],
        findings,
      };
    },
  }),
];
