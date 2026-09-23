/**
 * VCF Automation 9.1 and 9.1.1: what the 8.x-shaped blueprints do not cover.
 *
 * The other VCF Automation files in this kit are written against the APIs that
 * carried over from Aria Automation — /iaas/api, /blueprint/api, /policy/api —
 * which is what a VM Apps organisation still speaks. VCF Automation 9 added a
 * second half that came from Cloud Director and the Supervisor: a provider
 * portal with organisations, regions and quotas (/cloudapi), OAuth API tokens
 * per organisation (/oauth/provider/token, /oauth/tenant/{org}/token), and an
 * All Apps organisation consumed as Kubernetes objects — VMs through VM
 * Service, subnets through the NSX VPC operator, databases through Data
 * Services Manager.
 *
 * Sources: Broadcom TechDocs for 9.1 (generating provider management API
 * tokens; VCF Automation 9.1 what's new; VCF Automation 9.1.1 and 9.1.0.0200
 * release notes), the vmware/vcfa Terraform provider documentation (v1.2.x,
 * which states support for VCF Automation 9.1), vrealize.it on API access and
 * programmatic tokens, Tom Fojta and Cormac Hogan on All Apps networking and
 * Data Services, and the VM Service and Argo CD examples published for 9.x.
 *
 * Where a path, apiVersion or field name could not be confirmed against a 9.1
 * system the file says VERIFY and says how to check, rather than guessing
 * quietly. Terraform is used for provider-side objects because the vmware/vcfa
 * provider is the one documented, supported client for them.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';

const PLATFORM = 'vcf-automation'         ;
const SRC = 'ArchToolKit';

const json = (value         )         => `${JSON.stringify(value, null, 2)}\n`;

/** A Kubernetes / RFC 1123 label: lower case, digits and hyphens, at most 63. */
const LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

function label(text        , fallback        )         {
  return slugOf(text, fallback).slice(0, 63).replace(/-+$/, '') || fallback;
}

/** A value for HCL or YAML inside double quotes. */
function q(text        )         {
  return JSON.stringify(text);
}

                                   

// --- shell building blocks ---------------------------------------------------

/**
 * Get a VCF Automation 9 access token, unless one is already in VCFA_TOKEN.
 *
 * The API token (an OAuth refresh token) is read from a file that must be mode
 * 600 or 400 and sent on stdin, so it is never an argument to anything. When
 * the organisation has token rotation on, the exchange answers with a new API
 * token and the old one stops working; the new one is written back before
 * anything else happens, because losing it means generating a new token in the
 * interface.
 */
function authLines(scope       )           {
  return [
    ': "${VCFA_HOST:?set VCFA_HOST, e.g. vcfa.example.com}"',
    'API_VERSION="${VCFA_API_VERSION:-9.1.0}"',
    ...(scope === 'tenant'
      ? [': "${VCFA_ORG:?set VCFA_ORG to the organization name, as it appears in its login URL}"', 'OAUTH_PATH="/oauth/tenant/${VCFA_ORG}/token"']
      : ['OAUTH_PATH="/oauth/provider/token"']),
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    'if [[ -z "${VCFA_TOKEN:-}" ]]; then',
    '  : "${VCFA_API_TOKEN_FILE:?set VCFA_TOKEN, or VCFA_API_TOKEN_FILE to a mode-600 file holding a VCF Automation API token}"',
    '  PERM=$(stat -c %a "$VCFA_API_TOKEN_FILE" 2>/dev/null || stat -f %Lp "$VCFA_API_TOKEN_FILE")',
    '  [[ "$PERM" == 600 || "$PERM" == 400 ]] || { echo "$VCFA_API_TOKEN_FILE is mode $PERM; make it 600 so only its owner can read it" >&2; exit 2; }',
    "  RESP=$( { printf 'grant_type=refresh_token&refresh_token='; jq -jn --rawfile p \"$VCFA_API_TOKEN_FILE\" '$p | rtrimstr(\"\\n\") | @uri'; } |",
    '    curl -sS -f -X POST "https://${VCFA_HOST}${OAUTH_PATH}" -H "Accept: application/*" -H "Content-Type: application/x-www-form-urlencoded" --data-binary @-)',
    "  VCFA_TOKEN=$(jq -r '.access_token // empty' <<<\"$RESP\")",
    '  [[ -n "$VCFA_TOKEN" ]] || { echo "The token exchange at ${OAUTH_PATH} returned no access_token" >&2; exit 2; }',
    "  NEW_REFRESH=$(jq -r '.refresh_token // empty' <<<\"$RESP\")",
    "  if [[ -n \"$NEW_REFRESH\" && \"$NEW_REFRESH\" != \"$(tr -d '\\n' < \"$VCFA_API_TOKEN_FILE\")\" ]]; then",
    "    ( umask 077; printf '%s\\n' \"$NEW_REFRESH\" > \"${VCFA_API_TOKEN_FILE}.new\" ) && mv \"${VCFA_API_TOKEN_FILE}.new\" \"$VCFA_API_TOKEN_FILE\"",
    '    echo "Token rotation is on: ${VCFA_API_TOKEN_FILE} now holds the new API token; the old one no longer works." >&2',
    '  fi',
    '  unset RESP NEW_REFRESH',
    'fi',
  ];
}

/** GET with the bearer token passed to curl on a file descriptor, never in argv. */
function httpLines()           {
  return [
    '# The bearer token reaches curl as a config on a file descriptor, not as an argument.',
    "auth_cfg() { printf 'header = \"Authorization: Bearer %s\"\\n' \"$VCFA_TOKEN\"; }",
    "cloudapi_type() { printf 'application/json;version=%s' \"$API_VERSION\"; }",
    'get() {  # get PATH [ACCEPT] — /cloudapi wants the versioned type, /iaas and /blueprint plain JSON',
    '  curl -sS -f -K <(auth_cfg) "https://${VCFA_HOST}$1" -H "Accept: ${2:-$(cloudapi_type)}"',
    '}',
    '# probe PATH: like get, but a 404 says the path is not on this release instead of failing silently.',
    'probe() {',
    '  local code',
    '  code=$(curl -sS -o /tmp/vcfa-probe.$$ -w "%{http_code}" -K <(auth_cfg) "https://${VCFA_HOST}$1" -H "Accept: ${2:-$(cloudapi_type)}") || true',
    '  if [[ "$code" == 200 ]]; then cat /tmp/vcfa-probe.$$; rm -f /tmp/vcfa-probe.$$; return 0; fi',
    '  rm -f /tmp/vcfa-probe.$$',
    '  echo "VERIFY: $1 answered HTTP $code on this release — check the path in the API explorer" >&2',
    '  return 1',
    '}',
  ];
}

/** Stop before sending anything if the server does not offer the API version the payloads are written for. */
function versionCheckLines()           {
  return [
    'if VERS=$(curl -sS -f "https://${VCFA_HOST}/api/versions" -H "Accept: application/json" 2>/dev/null); then',
    '  grep -q "${API_VERSION}" <<<"$VERS" || { echo "API version ${API_VERSION} is not offered by ${VCFA_HOST}; set VCFA_API_VERSION to one GET /api/versions lists" >&2; exit 2; }',
    'else',
    '  echo "warning: /api/versions did not answer; carrying on with version ${API_VERSION} unchecked" >&2',
    'fi',
  ];
}

function sendLines()           {
  return [
    'DRY_RUN=1',
    '[[ " $* " == *" --execute "* ]] && DRY_RUN=0',
    'send() {  # send METHOD PATH FILE [TYPE]',
    '  local method="$1" path="$2" file="$3" type="${4:-$(cloudapi_type)}"',
    '  if (( DRY_RUN )); then echo "DRY RUN: would ${method} ${file} to https://${VCFA_HOST}${path}"; return 0; fi',
    '  echo "${method} ${path}" >&2',
    '  curl -sS -f -K <(auth_cfg) -X "$method" "https://${VCFA_HOST}${path}" -H "Accept: ${type}" -H "Content-Type: ${type}" --data-binary @"$file"',
    '  echo',
    '}',
  ];
}

function restScript(opts                                                                                                                 )         {
  return [
    '#!/usr/bin/env bash',
    `# ${opts.purpose}`,
    '#',
    opts.act
      ? '# Without --execute this only reads and prints what it would send.'
      : '# Reads only. Exits 1 when something needs attention, so a scheduler can alert on the exit code.',
    `# Authenticates as ${opts.scope === 'provider' ? 'the provider (System), at /oauth/provider/token' : 'an organization, at /oauth/tenant/$VCFA_ORG/token'}.`,
    'set -euo pipefail',
    '',
    ...authLines(opts.scope),
    '',
    ...httpLines(),
    '',
    ...(opts.checkVersion ? [...versionCheckLines(), ''] : []),
    ...(opts.act ? [...sendLines(), ''] : []),
    ...opts.body,
    '',
    ...(opts.act ? ['if (( DRY_RUN )); then echo "Nothing was changed. Read the payloads, then re-run with --execute."; fi', ''] : []),
    ...(opts.undo ? [`# Undo: ${opts.undo}`, ''] : []),
  ].join('\n');
}

/**
 * kubectl against a VCF Automation (CCI) or Supervisor context. Server-side dry
 * run unless --execute; create rather than apply, because the VCF Automation
 * endpoint rejects the last-applied annotation apply depends on, and because
 * create refuses to overwrite an object that already exists.
 */
function kubeScript(purpose        , pre                   , files                   , undo        , verb                     = 'create')         {
  return [
    '#!/usr/bin/env bash',
    `# ${purpose}`,
    '#',
    '# Log in first with the VCF CLI, e.g.',
    '#   vcf context create <name> --type cci --endpoint https://$VCFA_HOST --tenant-name <org>',
    '#   vcf context use <name>:<namespace>:<project>',
    '# Leave --api-token off so the CLI asks for it, rather than putting the token in',
    '# your shell history and the process list (VERIFY the prompt on your CLI version).',
    '#',
    '# Without --execute this is a server-side dry run: the server validates, nothing is created.',
    'set -euo pipefail',
    '',
    'command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }',
    ': "${EXPECT_CONTEXT:?set EXPECT_CONTEXT to the kubectl context this is meant for — the context is the scope}"',
    'CTX=$(kubectl config current-context)',
    '[[ "$CTX" == "$EXPECT_CONTEXT" ]] || { echo "Current context is $CTX, not $EXPECT_CONTEXT. Switch with vcf context use." >&2; exit 2; }',
    'echo "Context: $CTX"',
    '',
    'MODE=(--dry-run=server)',
    '[[ " $* " == *" --execute "* ]] && MODE=()',
    '',
    ...pre,
    ...files.map((file) => `kubectl ${verb} "\${MODE[@]}" -f '${file}'`),
    '',
    'if [[ ${#MODE[@]} -gt 0 ]]; then echo "Server-side dry run only. Nothing was created. Re-run with --execute."; fi',
    '',
    `# Undo: ${undo}`,
    '',
  ].join('\n');
}

/** Read-only kubectl script. */
function kubeReadScript(purpose        , body                   )         {
  return [
    '#!/usr/bin/env bash',
    `# ${purpose}`,
    '#',
    '# Reads only, from the current kubectl context. Exits 1 when something needs attention.',
    'set -euo pipefail',
    'command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }',
    'echo "Context: $(kubectl config current-context)"',
    'PROBLEMS=0',
    '',
    ...body,
    '',
    'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
    '',
  ].join('\n');
}

/** terraform init/plan, and --execute applies exactly the saved plan. */
function tfScript(purpose        , undo        )         {
  return [
    '#!/usr/bin/env bash',
    `# ${purpose}`,
    '#',
    '# Without --execute: init and plan, saved to tfplan. With --execute: apply that saved',
    '# plan and nothing else — Terraform refuses it if anything changed since it was made.',
    'set -euo pipefail',
    'command -v terraform >/dev/null || { echo "terraform is required" >&2; exit 2; }',
    ': "${VCFA_URL:?set VCFA_URL, e.g. https://vcfa.example.com}"',
    ': "${VCFA_ORG:?set VCFA_ORG — System for provider work, the organization name for tenant work}"',
    'if [[ -z "${VCFA_API_TOKEN:-}" ]]; then',
    '  : "${VCFA_API_TOKEN_FILE:?set VCFA_API_TOKEN_FILE to a mode-600 file holding the API token}"',
    "  VCFA_API_TOKEN=\"$(tr -d '\\n' < \"$VCFA_API_TOKEN_FILE\")\"",
    'fi',
    'export VCFA_URL VCFA_ORG VCFA_API_TOKEN',
    '',
    'if [[ " $* " == *" --execute "* ]]; then',
    '  [[ -f tfplan ]] || { echo "No saved plan. Run without --execute first and read it." >&2; exit 2; }',
    '  terraform apply -input=false tfplan',
    '  rm -f tfplan',
    '  exit 0',
    'fi',
    '',
    'terraform init -input=false',
    'terraform plan -input=false -out=tfplan',
    'echo "Plan saved to tfplan. Read it, then re-run with --execute to apply exactly this plan."',
    '',
    `# Undo: ${undo}`,
    '',
  ].join('\n');
}

const VERSIONS_TF = [
  '# The vmware/vcfa provider. 1.2.x documents support for VCF Automation 9.1.',
  'terraform {',
  '  required_version = ">= 1.5.0"',
  '  required_providers {',
  '    vcfa = {',
  '      source  = "vmware/vcfa"',
  '      version = "~> 1.2.2"',
  '    }',
  '  }',
  '}',
  '',
  '# URL, org and the API token come from VCFA_URL, VCFA_ORG and VCFA_API_TOKEN,',
  '# which plan.sh sets from a mode-600 file. Nothing secret is written here.',
  'provider "vcfa" {',
  '  auth_type            = "api_token"',
  '  allow_unverified_ssl = false',
  '}',
  '',
].join('\n');

function cronLine(schedule        , env        , script        , log        )         {
  return [
    '# Crontab entry. No secret in it: the script reads the API token from the file named.',
    `${schedule} ${env} /opt/archtoolkit/${script} >>/var/log/archtoolkit/${log} 2>&1`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------

export const VCF_AUTOMATION_91                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_api_tokens',
    platform: PLATFORM,
    label: 'Provider and organization API tokens: exchange, audit, rotate, revoke',
    group: 'VCF Automation 9.1 — access',
    description:
      'The VCF Automation 9 way in: an API token made in the interface (My Account → API Tokens), exchanged at /oauth/provider/token or /oauth/tenant/{org}/token for a one-hour bearer token that is written to a mode-600 file other scripts read. Handles token rotation, audits expiring tokens, and revokes one by id and exact name.',
    inputs: [
      {
        id: 'scope',
        label: 'Token for',
        control: 'select',
        options: [
          { value: 'tenant', label: 'An organization — /oauth/tenant/{org}/token' },
          { value: 'provider', label: 'The provider (System) — /oauth/provider/token' },
        ],
        default: 'tenant',
      },
      { id: 'org', label: 'Organization', control: 'text', default: 'team-a', hint: 'The name in its login URL', showWhen: { input: 'scope', equals: ['tenant'] } },
      { id: 'token_file', label: 'API token file', control: 'text', default: '/etc/archtoolkit/vcfa-api-token', hint: 'Mode 600, owned by the account that runs the scripts' },
      { id: 'access_file', label: 'Write the access token to', control: 'text', default: '/run/archtoolkit/vcfa-access-token', hint: 'Other scripts read VCFA_TOKEN from here' },
      { id: 'expiry_warn_days', label: 'Warn when a token expires within (days)', control: 'number', default: 30, min: 1, max: 365 },
      { id: 'schedule_refresh', label: 'Refresh the access token every 45 minutes', control: 'toggle', default: true },
      { id: 'include_revoke', label: 'Include the revoke script', control: 'toggle', default: false },
    ],
    automation: (values                 , name        )             => {
      const scope = (str(values, 'scope', 'tenant') === 'provider' ? 'provider' : 'tenant')         ;
      const org = str(values, 'org', 'team-a');
      const tokenFile = str(values, 'token_file', '/etc/archtoolkit/vcfa-api-token');
      const accessFile = str(values, 'access_file', '/run/archtoolkit/vcfa-access-token');
      const warnDays = num(values, 'expiry_warn_days', 30);
      const schedule = bool(values, 'schedule_refresh', true);
      const revoke = bool(values, 'include_revoke', false);
      const tokenPath = scope === 'provider' ? '/oauth/provider/token' : `/oauth/tenant/${org}/token`;
      void name;

      const findings            = [];
      if (scope === 'provider') {
        findings.push(
          warning('vcfa91.token.provider', 'A provider API token acts as the service provider administrator, across every organization.', {
            remediation: 'Use an organization token wherever the work is inside one organization. Keep provider tokens for provider objects — organizations, regions, quotas — and give each one its own file and owner.',
            source: SRC,
          }),
        );
      }
      if (scope === 'tenant' && !LABEL.test(org.toLowerCase())) {
        findings.push(warning('vcfa91.token.org-name', `"${org}" does not look like an organization login name.`, { remediation: 'Use the name in the organization’s login URL, not its display name.', source: SRC }));
      }
      if (/^\/tmp\/|^\/var\/tmp\//.test(tokenFile)) {
        findings.push(warning('vcfa91.token.tmp', 'The API token file is under a shared temporary directory.', { remediation: 'Keep it under /etc or the service account’s home, mode 600. A temporary directory is cleaned, and on some hosts shared.', source: SRC }));
      }
      findings.push(
        info('vcfa91.token.rotation', 'If the organization has API token rotation on, every exchange returns a new API token and the old one stops working.', {
          remediation: 'The exchange script writes the new token back to the file before it does anything else. That only works if one job owns the file — two jobs sharing one token file with rotation on will lock each other out.',
          source: SRC,
        }),
        info('vcfa91.token.iaas-login', 'The other VCF Automation scripts in this kit log in with POST /iaas/api/login and a refresh token — the 8.x method.', {
          remediation: 'That still works for a VM Apps organization upgraded from 8.x. For a new organization, All Apps or VM Apps, use this exchange and hand those scripts VCFA_TOKEN from the access-token file.',
          source: SRC,
        }),
      );

      const exchange = [
        '#!/usr/bin/env bash',
        `# Exchange the VCF Automation API token for a one-hour access token, at ${tokenPath}.`,
        '#',
        '# The access token is written, mode 600, to ACCESS_FILE; other scripts take it with',
        '#   export VCFA_TOKEN="$(cat <ACCESS_FILE>)"',
        '# The API token itself is read from VCFA_API_TOKEN_FILE and sent on stdin.',
        'set -euo pipefail',
        '',
        `ACCESS_FILE="\${VCFA_ACCESS_FILE:-${accessFile}}"`,
        ...(scope === 'tenant' ? [`VCFA_ORG="\${VCFA_ORG:-${org}}"`] : []),
        'unset VCFA_TOKEN',
        ...authLines(scope),
        '',
        'mkdir -p "$(dirname "$ACCESS_FILE")"',
        '( umask 077; printf \'%s\\n\' "$VCFA_TOKEN" > "${ACCESS_FILE}.new" ) && mv "${ACCESS_FILE}.new" "$ACCESS_FILE"',
        '',
        '# Print when it expires, from the JWT, without printing the token.',
        "P=$(cut -d. -f2 <<<\"$VCFA_TOKEN\" | tr '_-' '/+')",
        'while (( ${#P} % 4 )); do P="${P}="; done',
        "EXP=$(base64 -d <<<\"$P\" 2>/dev/null | jq -r '.exp // empty' 2>/dev/null || true)",
        'if [[ -n "$EXP" ]]; then',
        '  echo "Access token written to $ACCESS_FILE; expires $(date -d "@$EXP" 2>/dev/null || date -r "$EXP")"',
        'else',
        '  echo "Access token written to $ACCESS_FILE (lifetime about one hour)"',
        'fi',
        '',
        '# Undo: nothing to undo. To stop it working, revoke the API token (vcfa-token-revoke.sh or My Account → API Tokens).',
        '',
      ].join('\n');

      const audit = restScript({
        purpose: `List the API tokens this ${scope === 'provider' ? 'provider' : 'organization'} account can see and flag any expiring within ${warnDays} days.`,
        scope,
        act: false,
        body: [
          `WARN_DAYS=${warnDays}`,
          '# VERIFY: /cloudapi/1.0.0/tokens is the Cloud Director token API VCF Automation inherited;',
          '# an organization user sees their own tokens, an administrator the organization’s.',
          "LIST=$(probe '/cloudapi/1.0.0/tokens?filter=type==REFRESH&pageSize=128') || exit 2",
          'NOW=$(date +%s)',
          "jq -r --argjson now \"$NOW\" --argjson warn \"$WARN_DAYS\" '",
          '  .values[]? | [.name, (.owner.name // "?"), (.id), (.expirationDate // "never")] | @tsv\' <<<"$LIST" |',
          "  awk -F'\\t' 'BEGIN{printf \"%-32s %-24s %-28s %s\\n\",\"NAME\",\"OWNER\",\"EXPIRES\",\"ID\"} {printf \"%-32s %-24s %-28s %s\\n\",$1,$2,$4,$3}'",
          "SOON=$(jq -r --argjson now \"$NOW\" --argjson warn \"$WARN_DAYS\" '",
          '  [.values[]? | select(.expirationDate != null) | select(((.expirationDate | sub("\\\\.[0-9]+"; "") | sub("(?<z>[+-][0-9]{2}:[0-9]{2}|Z)$"; "Z") | fromdateiso8601) - $now) < ($warn * 86400)) | .name] | join(", ")\' <<<"$LIST")',
          'if [[ -n "$SOON" ]]; then',
          '  echo "Expiring within ${WARN_DAYS} days: ${SOON}. Make a replacement, swap the file, then revoke the old one."',
          '  exit 1',
          'fi',
          'echo "No token expires within ${WARN_DAYS} days."',
        ],
      });

      const revokeScript = restScript({
        purpose: 'Revoke one API token, by id, only when its name matches exactly.',
        scope,
        act: true,
        body: [
          'ID="${1:-}"; NAME="${2:-}"',
          '[[ -n "$ID" && -n "$NAME" && "$ID" != --execute && "$NAME" != --execute ]] || { echo "usage: $0 <token-id> <exact-token-name> [--execute]   (ids from vcfa-tokens-audit.sh)" >&2; exit 2; }',
          'TOKEN_JSON=$(probe "/cloudapi/1.0.0/tokens/${ID}") || exit 2',
          "ACTUAL=$(jq -r '.name' <<<\"$TOKEN_JSON\")",
          '[[ "$ACTUAL" == "$NAME" ]] || { echo "Token ${ID} is named \\"${ACTUAL}\\", not \\"${NAME}\\". Nothing revoked." >&2; exit 2; }',
          "echo \"Token: ${ACTUAL}, owner $(jq -r '.owner.name // \"?\"' <<<\"$TOKEN_JSON\")\"",
          'if (( DRY_RUN )); then',
          '  echo "DRY RUN: would DELETE /cloudapi/1.0.0/tokens/${ID}. Anything still using it will fail at its next exchange."',
          'else',
          '  curl -sS -f -K <(auth_cfg) -X DELETE "https://${VCFA_HOST}/cloudapi/1.0.0/tokens/${ID}" -H "Accept: $(cloudapi_type)"',
          '  echo "Revoked ${ACTUAL}."',
          'fi',
        ],
        undo: 'none — a revoked API token cannot be restored. Make a new one in My Account → API Tokens and replace the file.',
      });

      const env = `VCFA_HOST=vcfa.example.com${scope === 'tenant' ? ` VCFA_ORG=${org}` : ''} VCFA_API_TOKEN_FILE=${tokenFile} VCFA_ACCESS_FILE=${accessFile}`;
      const files                         = {
        'vcfa-token-exchange.sh': exchange,
        'vcfa-tokens-audit.sh': audit,
        ...(revoke ? { 'vcfa-token-revoke.sh': revokeScript } : {}),
        ...(schedule ? { 'crontab.txt': cronLine('*/45 * * * *', env, 'vcfa-token-exchange.sh', 'vcfa-token.log') } : {}),
        'rotation-runbook.txt': [
          'Rotating a VCF Automation API token without an outage',
          '',
          `1. Log in to https://<vcfa>/${scope === 'provider' ? 'provider' : `tenant/${org}`} as the account the token belongs to.`,
          '2. My Account → API Tokens → NEW. Name it with the date, e.g. archtoolkit-2026-09. Copy it once;',
          '   it is not shown again.',
          `3. Write it to ${tokenFile}.new with umask 077, then mv it over ${tokenFile}.`,
          '4. Run vcfa-token-exchange.sh by hand and confirm it writes the access token.',
          '5. Wait one scheduled cycle, then list tokens with vcfa-tokens-audit.sh and revoke the old one',
          `   by id and exact name${revoke ? ' with vcfa-token-revoke.sh' : ' (enable the revoke script, or use My Account → API Tokens)'}.`,
          '',
          'If the organization has token rotation on, step 3 is done for you on every exchange: the',
          'script writes the new token back. Do not copy the file to a second machine in that case.',
          '',
        ].join('\n'),
      };

      return {
        platform: PLATFORM,
        title: `VCF Automation 9 API token handling — ${scope === 'provider' ? 'provider' : `organization ${org}`}`,
        effect: revoke ? 'irreversible' : 'reversible',
        trigger: {
          kind: schedule ? 'schedule' : 'manual',
          detail: schedule ? 'Every 45 minutes from cron, so the one-hour access token is always fresh; the audit and revoke scripts by hand.' : 'Run by hand, or by whatever job needs a token first.',
          worstCase: schedule ? '32 exchanges a day, each of which rotates the API token if rotation is on' : undefined,
        },
        scope: {
          what: `One API token of one ${scope === 'provider' ? 'provider administrator' : `user in organization ${org}`}, and the access token made from it.`,
          decidedBy: [
            'Whose token it is: an API token carries that user’s roles, no more and no less.',
            scope === 'provider' ? 'The provider scope: the System organization, which administers every organization.' : `The organization in the URL, ${org}.`,
            'The revoke script: exactly the one token whose id and name are both given.',
          ],
          ifWrong: 'A token of a highly privileged user left in a file is that user for anyone who can read the file. A revoke of the wrong token stops whatever used it at its next exchange, usually the nightly job.',
        },
        guardrails: [
          { rule: 'The API token file must be mode 600 or 400, or the scripts stop', because: 'A world-readable token file is a standing credential for anyone with a shell on the host.' },
          { rule: 'The API token is sent on stdin, and the bearer token to curl on a file descriptor', because: 'Neither shows in ps, /proc or the shell history.' },
          { rule: 'A rotated API token is written back atomically before anything else', because: 'With rotation on, the old token dies at the exchange; losing the new one means a trip to the interface and a failed night of jobs.' },
          ...(revoke ? [{ rule: 'Revoke needs the id, the exact name and --execute', because: 'Two tokens called "automation" on one account is common; revoking by name alone takes the wrong one.' }] : []),
        ],
        dryRun: [
          'vcfa-tokens-audit.sh only reads: run it first to see what tokens exist and when they expire.',
          ...(revoke ? ['vcfa-token-revoke.sh without --execute shows which token it would revoke and stops.'] : []),
          'The exchange has no dry run — the exchange is the operation. With rotation on it replaces the API token file every time.',
        ],
        undo: [
          'An exchange needs no undo: the access token expires within the hour.',
          'A revoked API token cannot be restored. Create a new one and replace the file.',
        ],
        told: ['VCF Automation records token creation and use against the user in its event log.', schedule ? 'The cron log, /var/log/archtoolkit/vcfa-token.log.' : 'The terminal it was run in.'],
        requires: [
          'VCF Automation 9.x, with the account the token belongs to able to log in to the portal.',
          'An API token made in My Account → API Tokens, saved to the token file.',
          'curl and jq on the host.',
        ],
        files,
        notes: [
          'Provider: POST https://<vcfa>/oauth/provider/token. Organization: POST https://<vcfa>/oauth/tenant/<org>/token. Both form-encoded grant_type=refresh_token&refresh_token=<API token>, Accept: application/*; the answer has access_token and token_type Bearer, valid one hour (Broadcom TechDocs, 9.1).',
          'Which login to use: /iaas/api/login with a refresh token is the Aria Automation 8.x method, still answered for VM Apps organizations upgraded from 8.x. A fresh 9.x organization — VM Apps or All Apps — authenticates like a tenant, at /oauth/tenant/<org>/token (vrealize.it, VCF Automation 9 API Access). When unsure, try the OAuth exchange first.',
          'The /cloudapi calls send Accept: application/json;version=<VCFA_API_VERSION>, default 9.1.0. 9.0 examples use 9.0.0. GET /api/versions lists what your system offers.',
          'Service accounts (Administration → Access Control → Service Accounts) use the OAuth device flow at /oauth/tenant/<org>/device_authorization and then the same token endpoint. The Terraform provider reads their token with service_account_token_file.',
          'The token list and revoke calls use /cloudapi/1.0.0/tokens, inherited from Cloud Director. VERIFY on your release: the probe prints the HTTP status if the path moved.',
          'The vcf CLI takes the token as --api-token. Omit it and let the CLI ask, so it does not land in history.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_organization',
    platform: PLATFORM,
    label: 'A tenant organization: All Apps or VM Apps, region quota and networking',
    group: 'VCF Automation 9.1 — provider',
    description:
      'Provider portal work as Terraform (vmware/vcfa): the organization, whether it is All Apps or VM Apps (classic), and for All Apps its region quota — supervisors, per-zone CPU and memory, VM classes, storage policy limit — and regional networking through a provider gateway. With a read-only check and the onboarding checklist for everything that is still a click.',
    inputs: [
      { id: 'org_name', label: 'Organization name', control: 'text', default: 'team-a', hint: 'Becomes the login URL; lower case' },
      { id: 'display_name', label: 'Display name', control: 'text', default: 'Team A' },
      {
        id: 'org_type',
        label: 'Type',
        control: 'select',
        options: [
          { value: 'all-apps', label: 'All Apps — VMs, Kubernetes, VPCs, Supervisor services' },
          { value: 'vm-apps', label: 'VM Apps — the 8.x-style organization (classic tenant)' },
        ],
        default: 'all-apps',
      },
      { id: 'region', label: 'Region', control: 'text', default: 'region1', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'vcenter', label: 'vCenter', control: 'text', default: 'vcenter-wld01', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'supervisors', label: 'Supervisors', control: 'text', default: 'supervisor-wld01', hint: 'Comma separated; 9.1 allows a quota across several', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'zones', label: 'Zones', control: 'text', default: 'zone-a', hint: 'Each gets the CPU and memory below', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'cpu_limit_mhz', label: 'CPU limit per zone (MHz)', control: 'number', default: 100000, min: 0, max: 100000000, showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'cpu_reservation_mhz', label: 'CPU reservation per zone (MHz)', control: 'number', default: 0, min: 0, max: 100000000, showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'memory_limit_mib', label: 'Memory limit per zone (MiB)', control: 'number', default: 262144, min: 0, max: 1000000000, showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'memory_reservation_mib', label: 'Memory reservation per zone (MiB)', control: 'number', default: 0, min: 0, max: 1000000000, showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'vm_classes', label: 'VM classes', control: 'text', default: 'best-effort-small, best-effort-medium, best-effort-large', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'storage_policy', label: 'Storage policy', control: 'text', default: 'vSAN Default Storage Policy', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'storage_limit_gib', label: 'Storage limit (GiB)', control: 'number', default: 2048, min: 0, max: 10000000, showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'provider_gateway', label: 'Provider gateway', control: 'text', default: 'provider-gw-01', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'edge_cluster', label: 'Edge cluster', control: 'text', default: '', hint: 'Empty lets VCF Automation pick', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'admin_group', label: 'Organization administrators (group)', control: 'text', default: 'vcfa-team-a-admins' },
      {
        id: 'identity',
        label: 'Identity source',
        control: 'select',
        options: [
          { value: 'oidc', label: 'OIDC — VCF Identity Broker or another IdP' },
          { value: 'ldap', label: 'LDAP / Active Directory' },
        ],
        default: 'oidc',
      },
    ],
    automation: (values                 , name        )             => {
      const orgName = str(values, 'org_name', 'team-a');
      const display = str(values, 'display_name', orgName);
      const allApps = str(values, 'org_type', 'all-apps') === 'all-apps';
      const region = str(values, 'region', 'region1');
      const vcenter = str(values, 'vcenter', 'vcenter-wld01');
      const supervisors = listOf(str(values, 'supervisors', 'supervisor-wld01'));
      const zones = listOf(str(values, 'zones', 'zone-a'));
      const cpuLimit = num(values, 'cpu_limit_mhz', 100000);
      const cpuRes = num(values, 'cpu_reservation_mhz', 0);
      const memLimit = num(values, 'memory_limit_mib', 262144);
      const memRes = num(values, 'memory_reservation_mib', 0);
      const vmClasses = listOf(str(values, 'vm_classes', ''));
      const storagePolicy = str(values, 'storage_policy', 'vSAN Default Storage Policy');
      const storageGib = num(values, 'storage_limit_gib', 2048);
      const gateway = str(values, 'provider_gateway', 'provider-gw-01');
      const edge = str(values, 'edge_cluster', '');
      const adminGroup = str(values, 'admin_group', '');
      const identity = str(values, 'identity', 'oidc');
      const tf = label(orgName, 'org').replace(/-/g, '_');
      void name;

      const findings            = [];
      if (!LABEL.test(orgName)) {
        findings.push(error('vcfa91.org.name', `"${orgName}" is not usable as an organization name: it becomes the login URL.`, { remediation: 'Lower case letters, digits and hyphens, starting and ending with a letter or digit.', source: SRC }));
      }
      if (allApps) {
        if (supervisors.length === 0) findings.push(error('vcfa91.org.no-supervisor', 'A region quota needs at least one supervisor.', { source: SRC }));
        if (zones.length === 0) findings.push(error('vcfa91.org.no-zone', 'A region quota needs at least one zone allocation.', { source: SRC }));
        if (cpuLimit === 0 || memLimit === 0 || storageGib === 0) {
          findings.push(warning('vcfa91.org.zero-limit', 'A limit of 0 is set; check whether that means none or nothing on your release.', { remediation: 'Give each zone an explicit CPU and memory limit and the storage policy an explicit limit. An unbounded organization can take the whole region.', source: SRC }));
        }
        if (cpuRes > cpuLimit || memRes > memLimit) {
          findings.push(error('vcfa91.org.reservation', 'A reservation is larger than its limit.', { remediation: 'Reservations are carved out of the limit. Lower the reservation or raise the limit.', source: SRC }));
        }
        if (vmClasses.length === 0) {
          findings.push(warning('vcfa91.org.no-vm-classes', 'No VM classes are granted, so nothing in the organization can make a VM or a VKS node.', { source: SRC }));
        }
        if (supervisors.length > 1) {
          findings.push(info('vcfa91.org.multi-supervisor', 'The quota spans several supervisors — new in 9.1, and only on 9.1.', { remediation: 'On a 9.0 system the second supervisor is rejected. Upgrade VCF Automation first.', source: SRC }));
        }
      } else {
        findings.push(
          info('vcfa91.org.vm-apps', 'A VM Apps organization gets no region quota or regional networking here — it places through cloud accounts and cloud zones, as in 8.x.', {
            remediation: 'After it exists: "A vSphere cloud account", "A cloud zone with a placement policy" and "A project with groups, quotas and a naming template" in this kit, run with that organization’s token.',
            source: SRC,
          }),
        );
      }
      if (!adminGroup) {
        findings.push(warning('vcfa91.org.no-admin', 'No administrator group is named, so the organization is administered only by the provider.', { source: SRC }));
      }

      const main = [
        `# Organization ${orgName} — ${allApps ? 'All Apps' : 'VM Apps (classic tenant)'}.`,
        '# Provider work: run with VCFA_ORG=System and a provider API token.',
        '',
        `resource "vcfa_org" "${tf}" {`,
        `  name         = ${q(orgName)}`,
        `  display_name = ${q(display)}`,
        '  description  = "Managed by ArchToolKit / Terraform"',
        '  is_enabled   = true',
        `  # true makes a VM Apps (classic) organization. It cannot be changed afterwards.`,
        `  is_classic_tenant = ${allApps ? 'false' : 'true'}`,
        '',
        '  lifecycle {',
        '    # Destroying an organization deletes everything in it. Remove this line on purpose, not by accident.',
        '    prevent_destroy = true',
        '  }',
        '}',
        '',
        ...(allApps
          ? [
              `data "vcfa_vcenter" "vc" {`,
              `  name = ${q(vcenter)}`,
              '}',
              '',
              `data "vcfa_region" "region" {`,
              `  name = ${q(region)}`,
              '}',
              '',
              ...supervisors.flatMap((s, i) => [`data "vcfa_supervisor" "sv${i}" {`, `  name       = ${q(s)}`, '  vcenter_id = data.vcfa_vcenter.vc.id', '}', '']),
              ...zones.flatMap((z, i) => [`data "vcfa_region_zone" "z${i}" {`, '  region_id = data.vcfa_region.region.id', `  name      = ${q(z)}`, '}', '']),
              ...vmClasses.flatMap((c, i) => [`data "vcfa_region_vm_class" "c${i}" {`, '  region_id = data.vcfa_region.region.id', `  name      = ${q(c)}`, '}', '']),
              'data "vcfa_region_storage_policy" "sp" {',
              '  region_id = data.vcfa_region.region.id',
              `  name      = ${q(storagePolicy)}`,
              '}',
              '',
              `resource "vcfa_org_region_quota" "${tf}" {`,
              `  org_id         = vcfa_org.${tf}.id`,
              '  region_id      = data.vcfa_region.region.id',
              `  supervisor_ids = [${supervisors.map((_, i) => `data.vcfa_supervisor.sv${i}.id`).join(', ')}]`,
              ...zones.flatMap((_, i) => [
                '',
                '  zone_resource_allocations {',
                `    region_zone_id         = data.vcfa_region_zone.z${i}.id`,
                `    cpu_limit_mhz          = ${cpuLimit}`,
                `    cpu_reservation_mhz    = ${cpuRes}`,
                `    memory_limit_mib       = ${memLimit}`,
                `    memory_reservation_mib = ${memRes}`,
                '  }',
              ]),
              '',
              `  region_vm_class_ids = [${vmClasses.map((_, i) => `data.vcfa_region_vm_class.c${i}.id`).join(', ')}]`,
              '',
              '  region_storage_policy {',
              '    region_storage_policy_id = data.vcfa_region_storage_policy.sp.id',
              `    storage_limit_mib        = ${storageGib * 1024}`,
              '  }',
              '}',
              '',
              'data "vcfa_provider_gateway" "gw" {',
              `  name      = ${q(gateway)}`,
              '  region_id = data.vcfa_region.region.id',
              '}',
              '',
              ...(edge ? ['data "vcfa_edge_cluster" "edge" {', `  name      = ${q(edge)}`, '  region_id = data.vcfa_region.region.id', '}', ''] : []),
              `resource "vcfa_org_networking" "${tf}" {`,
              `  org_id   = vcfa_org.${tf}.id`,
              `  # Short name used in NSX object names. VERIFY the length limit on your release.`,
              `  log_name = ${q(label(orgName, 'org').replace(/-/g, '').slice(0, 8))}`,
              '}',
              '',
              `resource "vcfa_org_regional_networking" "${tf}" {`,
              `  name                = ${q(`${label(orgName, 'org')}-${label(region, 'region')}`)}`,
              `  # The networking resource's id carries the org id, which orders the two correctly.`,
              `  org_id              = vcfa_org_networking.${tf}.id`,
              '  provider_gateway_id = data.vcfa_provider_gateway.gw.id',
              '  region_id           = data.vcfa_region.region.id',
              ...(edge ? ['  edge_cluster_id     = data.vcfa_edge_cluster.edge.id'] : ['  # edge_cluster_id left out: VCF Automation picks one.']),
              '}',
              '',
            ]
          : []),
      ].join('\n');

      const check = restScript({
        purpose: `Check organization ${orgName} exists, is enabled${allApps ? ', and its region quota is READY' : ''}.`,
        scope: 'provider',
        act: false,
        checkVersion: true,
        body: [
          `ORG=${q(orgName)}`,
          'PROBLEMS=0',
          "O=$(probe \"/cloudapi/1.0.0/orgs?filter=name==${ORG}\") || exit 2",
          "COUNT=$(jq '.values | length' <<<\"$O\")",
          '[[ "$COUNT" == 1 ]] || { echo "Organization ${ORG}: not found"; exit 1; }',
          "jq -r '.values[0] | \"Organization \\(.name): enabled=\\(.isEnabled) classic(VM Apps)=\\(.isClassicTenant // \"?\") id=\\(.id)\"' <<<\"$O\"",
          "[[ \"$(jq -r '.values[0].isEnabled' <<<\"$O\")\" == true ]] || { echo \"  not enabled\"; PROBLEMS=$((PROBLEMS+1)); }",
          ...(allApps
            ? [
                "ORG_ID=$(jq -r '.values[0].id' <<<\"$O\")",
                '# VERIFY: region quotas are virtual datacenters underneath (go-vcloud-director: virtualDatacenters/).',
                'if Q=$(probe "/cloudapi/1.0.0/virtualDatacenters?filter=org.id==${ORG_ID}"); then',
                "  jq -r '.values[]? | \"  quota \\(.name): \\(.status // \"?\")\"' <<<\"$Q\"",
                "  BAD=$(jq '[.values[]? | select(.status != \"READY\")] | length' <<<\"$Q\")",
                "  [[ \"$(jq '.values | length' <<<\"$Q\")\" -gt 0 ]] || { echo '  no region quota'; PROBLEMS=$((PROBLEMS+1)); }",
                '  (( BAD == 0 )) || PROBLEMS=$((PROBLEMS+BAD))',
                'fi',
              ]
            : []),
          'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
        ],
      });

      const checklist = [
        `# Onboarding ${display} (${orgName})`,
        '',
        `Type: ${allApps ? 'All Apps' : 'VM Apps (classic)'}. Terraform creates the organization${allApps ? ', its region quota and its regional networking' : ''}; the rest is below.`,
        '',
        '## Provider',
        '',
        `- [ ] \`plan.sh\`, read the plan, \`plan.sh --execute\`. Then \`check-org.sh\`.`,
        `- [ ] Identity: connect ${identity === 'oidc' ? 'OIDC (vcfa_org_oidc, or Organization → Identity Providers → OIDC)' : 'LDAP (vcfa_org_ldap, or Organization → Identity Providers → LDAP)'} for ${orgName}.`,
        `- [ ] Import the group ${adminGroup || '<administrators>'} and give it the Organization Administrator role. VERIFY: the vcfa provider has no group resource at 1.2.x; do it in the portal.`,
        ...(allApps
          ? [
              '- [ ] Content: share a provider content library with the organization, or let it make its own (see "Content libraries and VM images").',
              '- [ ] Networking: confirm the default VPC `<region>-default-vpc` exists and has the external and private IP blocks you meant (9.1: default private VPC and TGW blocks are set per provider).',
              '- [ ] 9.1 delegation: decide whether the organization gets vDefend firewall and Avi load balancer rights and quota, and set them now rather than on first request.',
            ]
          : [
              '- [ ] Cloud account, cloud zone and project: the VM Apps blueprints in this kit, run with this organization’s token.',
            ]),
        '',
        '## Organization administrator',
        '',
        '- [ ] Create an API token for automation (My Account → API Tokens) under a service identity, not a person.',
        ...(allApps
          ? [
              '- [ ] Create projects and namespace classes; set which VM classes, storage classes and zones each class allows.',
              '- [ ] Create one namespace per project and environment; confirm limits in vCenter.',
            ]
          : ['- [ ] Projects, catalogue content sources and sharing, approval policies.']),
        '- [ ] Record the organization in the CMDB with its owner and cost centre.',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Organization ${orgName} (${allApps ? 'All Apps' : 'VM Apps'})`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'A provider administrator onboarding a tenant runs plan.sh, reads the plan, and applies it.' },
        scope: {
          what: allApps ? `Organization ${orgName}, its quota in region ${region} across ${supervisors.length} supervisor(s) and ${zones.length} zone(s), and its regional networking through ${gateway}.` : `Organization ${orgName}, VM Apps.`,
          decidedBy: [
            'The Terraform state in the directory plan.sh runs in: it manages exactly the resources in main.tf.',
            ...(allApps ? [`The region ${region}, the supervisors named, and the zones named.`, `The VM classes (${vmClasses.length}) and the storage policy ${storagePolicy}.`, `The provider gateway ${gateway}, whose IP blocks the organization will draw from.`] : []),
          ],
          ifWrong: 'An organization given the wrong supervisor or no limits takes capacity other tenants were counting on; the first sign is their namespaces failing to schedule.',
        },
        guardrails: [
          { rule: 'Apply only a saved, read plan (plan.sh --execute applies tfplan and nothing else)', because: 'A plan re-made at apply time can differ from the one that was reviewed.' },
          { rule: 'prevent_destroy on the organization', because: 'A terraform destroy, or a rename that forces replacement, would delete every namespace and VM in it.' },
          ...(allApps && cpuLimit > 0 && memLimit > 0 && storageGib > 0 ? [{ rule: `Explicit limits: ${cpuLimit} MHz and ${memLimit} MiB per zone, ${storageGib} GiB of ${storagePolicy}`, because: 'Without limits one tenant can consume the region.' }] : []),
          { rule: 'check-org.sh stops if the server does not offer the API version it asks for', because: 'A version mismatch returns fields renamed or missing, and the check reports a healthy organization it did not read.' },
        ],
        dryRun: ['plan.sh without --execute: terraform plan, saved to tfplan, changes nothing.', 'check-org.sh reads only.'],
        undo: [
          allApps ? 'Region quota and networking: remove them from main.tf and apply. Namespaces using the quota must be deleted first.' : 'Nothing but the organization was created.',
          'The organization: remove prevent_destroy on purpose, then terraform destroy -target. That deletes everything the organization contains.',
        ],
        told: ['VCF Automation provider events record who created or changed the organization.', 'The Terraform state and whatever holds it.'],
        requires: [
          'VCF Automation 9.1 with the region, supervisors, zones and provider gateway already set up (see "Regions, zones and supervisors").',
          'Terraform 1.5+, network access to registry.terraform.io or a mirror, and a provider API token.',
        ],
        files: {
          'versions.tf': VERSIONS_TF,
          'main.tf': main,
          'plan.sh': tfScript(`Create organization ${orgName}.`, 'remove the resource from main.tf and apply; see the README for the organization itself.'),
          'check-org.sh': check,
          'onboarding-checklist.md': checklist,
        },
        notes: [
          'is_classic_tenant decides VM Apps (true) or All Apps (false), and forces replacement if changed. Choose once.',
          'Region quota arguments follow the vmware/vcfa documentation (vcfa_org_region_quota): supervisor_ids, zone_resource_allocations, region_vm_class_ids, region_storage_policy with storage_limit_mib.',
          '9.1 adds quota across several supervisors in a region, multiple external connections per organization, and default private VPC and transit gateway IP blocks. None of these exist on 9.0.',
          'Import an organization made in the portal with terraform import vcfa_org.<name> <org-name> before managing it here, or Terraform will try to make a second one.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_region_zone',
    platform: PLATFORM,
    label: 'Regions, zones and supervisors for All Apps',
    group: 'VCF Automation 9.1 — provider',
    description:
      'A region — an NSX Manager, one or more supervisors and the storage policies offered — as Terraform, and an inventory of what the region actually offers: zones and whether each has a network stack, VM classes, storage policies and classes, and namespace classes. The inventory is what an organization quota and a namespace class have to be written against.',
    inputs: [
      { id: 'create_region', label: 'Create the region', control: 'toggle', default: true, hint: 'Off: inventory only' },
      { id: 'region_name', label: 'Region name', control: 'text', default: 'region1' },
      { id: 'nsx_manager', label: 'NSX Manager', control: 'text', default: 'nsx-wld01', showWhen: { input: 'create_region', equals: ['true'] } },
      { id: 'vcenter', label: 'vCenter', control: 'text', default: 'vcenter-wld01', showWhen: { input: 'create_region', equals: ['true'] } },
      { id: 'supervisors', label: 'Supervisors', control: 'text', default: 'supervisor-wld01', showWhen: { input: 'create_region', equals: ['true'] } },
      { id: 'storage_policies', label: 'Storage policies', control: 'text', default: 'vSAN Default Storage Policy', hint: 'Comma separated, as named in vCenter', showWhen: { input: 'create_region', equals: ['true'] } },
      { id: 'expected_vm_classes', label: 'VM classes you expect to offer', control: 'text', default: 'best-effort-small, best-effort-medium, best-effort-large, guaranteed-medium', hint: 'The inventory flags any missing' },
    ],
    automation: (values                 , name        )             => {
      const create = bool(values, 'create_region', true);
      const region = str(values, 'region_name', 'region1');
      const nsx = str(values, 'nsx_manager', 'nsx-wld01');
      const vcenter = str(values, 'vcenter', 'vcenter-wld01');
      const supervisors = listOf(str(values, 'supervisors', 'supervisor-wld01'));
      const policies = listOf(str(values, 'storage_policies', 'vSAN Default Storage Policy'));
      const expected = listOf(str(values, 'expected_vm_classes', ''));
      const tf = label(region, 'region').replace(/-/g, '_');
      void name;

      const findings            = [];
      if (!LABEL.test(region)) findings.push(error('vcfa91.region.name', `"${region}" is not an RFC 1123 label, which a region name must be.`, { source: SRC }));
      if (create && supervisors.length === 0) findings.push(error('vcfa91.region.no-supervisor', 'A region needs at least one supervisor.', { source: SRC }));
      if (create && policies.length === 0) findings.push(error('vcfa91.region.no-storage', 'A region needs at least one storage policy.', { source: SRC }));
      findings.push(
        info('vcfa91.region.network-stack', 'VCF Automation 9.1.1 known issue: region creation can fail with "zones of the specified supervisors don’t have a network stack configured" on VLAN-backed stacks.', {
          remediation: 'Refresh the vCenter connection in the provider portal, or call its refresh API, and create the region again. The inventory lists zones so you can see which one it means.',
          source: 'VCF Automation 9.1.1 release notes',
        }),
      );

      const regionTf = [
        `# Region ${region}. Provider work: VCFA_ORG=System with a provider API token.`,
        '',
        `data "vcfa_vcenter" "vc" {`,
        `  name = ${q(vcenter)}`,
        '}',
        '',
        'data "vcfa_nsx_manager" "nsx" {',
        `  name = ${q(nsx)}`,
        '}',
        '',
        ...supervisors.flatMap((s, i) => [`data "vcfa_supervisor" "sv${i}" {`, `  name       = ${q(s)}`, '  vcenter_id = data.vcfa_vcenter.vc.id', '}', '']),
        `resource "vcfa_region" "${tf}" {`,
        `  name                 = ${q(region)}`,
        '  description          = "Managed by ArchToolKit / Terraform"',
        '  nsx_manager_id       = data.vcfa_nsx_manager.nsx.id',
        `  supervisor_ids       = [${supervisors.map((_, i) => `data.vcfa_supervisor.sv${i}.id`).join(', ')}]`,
        `  storage_policy_names = [${policies.map(q).join(', ')}]`,
        '',
        '  lifecycle {',
        '    # Every organization quota in the region depends on it.',
        '    prevent_destroy = true',
        '  }',
        '}',
        '',
      ].join('\n');

      const inventory = restScript({
        purpose: `Inventory region ${region}: status, zones, supervisors, VM classes, storage policies and classes.`,
        scope: 'provider',
        act: false,
        checkVersion: true,
        body: [
          `REGION=${q(region)}`,
          `EXPECTED_CLASSES=(${expected.map(q).join(' ')})`,
          'PROBLEMS=0',
          '# VERIFY: the region family lives under /cloudapi/vcf/ (go-vcloud-director OpenApiPathVcf).',
          'R=$(probe "/cloudapi/vcf/regions?filter=name==${REGION}") || exit 2',
          "[[ \"$(jq '.values | length' <<<\"$R\")\" == 1 ]] || { echo \"Region ${REGION}: not found\"; exit 1; }",
          "RID=$(jq -r '.values[0].id' <<<\"$R\")",
          "STATUS=$(jq -r '.values[0].status // \"?\"' <<<\"$R\")",
          "jq -r '.values[0] | \"Region \\(.name) status=\\(.status // \"?\") cpu=\\(.cpuCapacityMHz // \"?\")MHz memory=\\(.memoryCapacityMiB // \"?\")MiB\"' <<<\"$R\"",
          '[[ "$STATUS" == READY ]] || PROBLEMS=$((PROBLEMS+1))',
          '',
          'echo; echo "Zones:"',
          'if Z=$(probe "/cloudapi/vcf/zones?filter=region.id==${RID}&pageSize=128"); then',
          "  jq -r '.values[]? | \"  \\(.name)  cpu=\\(.cpuLimitMHz // .totalCpuCapacityMHz // \"?\")  memory=\\(.memoryLimitMiB // .totalMemoryCapacityMiB // \"?\")\"' <<<\"$Z\"",
          "  [[ \"$(jq '.values | length' <<<\"$Z\")\" -gt 0 ]] || { echo '  none — the supervisors have no zones VCF Automation can use'; PROBLEMS=$((PROBLEMS+1)); }",
          'fi',
          '',
          'echo; echo "Supervisors:"',
          "probe \"/cloudapi/vcf/supervisors?filter=region.id==${RID}\" | jq -r '.values[]? | \"  \\(.name)  \\(.status // \"\")\"' || true",
          '',
          'echo; echo "VM classes:"',
          'if C=$(probe "/cloudapi/vcf/regionVirtualMachineClasses?filter=region.id==${RID}&pageSize=128"); then',
          "  jq -r '.values[]? | \"  \\(.name)  cpu=\\(.cpuCount // \"?\") memory=\\(.memoryMiB // \"?\")MiB reserved=\\(.reserved // \"?\")\"' <<<\"$C\"",
          '  for c in "${EXPECTED_CLASSES[@]}"; do',
          "    jq -e --arg c \"$c\" '[.values[]?.name] | index($c)' <<<\"$C\" >/dev/null || { echo \"  MISSING: $c\"; PROBLEMS=$((PROBLEMS+1)); }",
          '  done',
          'fi',
          '',
          'echo; echo "Storage policies:"',
          "probe \"/cloudapi/vcf/regionStoragePolicies?filter=region.id==${RID}\" | jq -r '.values[]? | \"  \\(.name)\"' || true",
          'echo; echo "Storage classes:"',
          "probe \"/cloudapi/vcf/storageClasses?filter=region.id==${RID}\" | jq -r '.values[]? | \"  \\(.name)\"' || true",
          '',
          'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
        ],
      });

      const nsClasses = kubeReadScript('List namespace classes and what each allows (organization context).', [
        '# VERIFY the resource name: kubectl api-resources | grep -i namespaceclass',
        'if kubectl get supervisornamespaceclasses >/dev/null 2>&1; then',
        '  kubectl get supervisornamespaceclasses -o wide',
        '  echo',
        '  kubectl get supervisornamespaceclassconfigs -o yaml 2>/dev/null | grep -E "^  name:|limit:|name:" || true',
        'else',
        '  echo "No supervisornamespaceclasses resource in this context — log in to an All Apps organization (vcf context use <org-context>)."',
        '  PROBLEMS=1',
        'fi',
      ]);

      return {
        platform: PLATFORM,
        title: create ? `Region ${region} and its inventory` : `Inventory of region ${region}`,
        effect: create ? 'reversible' : 'read',
        trigger: { kind: 'manual', detail: create ? 'A provider administrator adding a region runs plan.sh; the inventory runs any time.' : 'Run by hand, or weekly, before writing quotas and namespace classes.' },
        scope: {
          what: create ? `Region ${region}: ${supervisors.length} supervisor(s), NSX Manager ${nsx}, ${policies.length} storage polic${policies.length === 1 ? 'y' : 'ies'}.` : `Region ${region}, read only.`,
          decidedBy: [
            'The supervisors named, and every zone they have.',
            'The storage policies named, which become the storage classes organizations can be granted.',
            'The NSX Manager, which provides VPC networking for the region.',
          ],
          ifWrong: 'A supervisor in the wrong region makes its capacity grantable to organizations that were never meant to land there.',
        },
        guardrails: create
          ? [
              { rule: 'Apply only a saved, read plan', because: 'The plan shows which supervisors join the region before they do.' },
              { rule: 'prevent_destroy on the region', because: 'Every organization quota in the region depends on it.' },
            ]
          : [],
        dryRun: create ? ['plan.sh without --execute.', 'inventory.sh and namespace-classes.sh only read.'] : ['Everything here reads only.'],
        undo: create ? ['Remove the region from main.tf and apply after every organization quota in it is removed. prevent_destroy has to be taken off first.'] : ['Nothing to undo.'],
        told: ['Provider events in VCF Automation.', 'The inventory output — run it weekly and it becomes the record.'],
        requires: ['VCF Automation 9.1 with the vCenter and NSX Manager connected in the provider portal.', 'Supervisors enabled with VPC networking (or 9.1.1 VLAN-backed VPC).'],
        files: {
          ...(create ? { 'versions.tf': VERSIONS_TF, 'region.tf': regionTf, 'plan.sh': tfScript(`Create region ${region}.`, 'remove it from region.tf and apply, after its quotas are gone.') } : {}),
          'inventory.sh': inventory,
          'namespace-classes.sh': nsClasses,
        },
        notes: [
          'Region arguments follow vcfa_region: name (RFC 1123), nsx_manager_id, supervisor_ids, storage_policy_names.',
          'The /cloudapi/vcf/... inventory paths are inferred from the Go SDK the Terraform provider uses. Each is called through probe, which prints the HTTP status instead of failing silently when a path differs on your release.',
          'VM classes are defined on the supervisor in vCenter; the region exposes them and a quota grants them. A class missing from the inventory has to be made in vCenter first. 9.1.1 known issue: in mixed tenancy mode new VM classes may not show in the provider UI.',
          'Namespace classes are an organization object (the existing "A Supervisor namespace, requested from All Apps" blueprint writes one). Read them from an organization context.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_vpc',
    platform: PLATFORM,
    label: 'VPC subnets for an All Apps namespace, and the IP block behind them',
    group: 'VCF Automation 9.1 — networking',
    description:
      'NSX VPC networking as an All Apps organization consumes it: Public, Private and Private-TGW subnets in a namespace’s VPC as NSX operator Subnet objects, a discovery script showing the VPC, transit gateway reachability and existing subnets, and optionally the provider’s external IP block that Public subnets are carved from. Covers the 9.1.1 VLAN-backed VPC, where Private subnets are not supported.',
    inputs: [
      { id: 'namespace', label: 'Supervisor namespace', control: 'text', default: 'team-a-dev-x7k2p', hint: 'The generated name, with its suffix' },
      { id: 'vpc_name', label: 'VPC', control: 'text', default: 'region1-default-vpc', hint: 'The region default VPC is <region>-default-vpc' },
      {
        id: 'connectivity',
        label: 'VPC connectivity',
        control: 'select',
        options: [
          { value: 'centralized', label: 'Centralized — transit gateway on edges, NAT and Private subnets' },
          { value: 'distributed-vlan', label: 'VLAN-backed (9.1.1) — no overlay, no Private subnets' },
        ],
        default: 'centralized',
      },
      { id: 'subnets', label: 'Subnets', control: 'textarea', default: 'web: Public: 16\napp: Private: 64\ndb: PrivateTGW: 32', hint: 'name: Public|Private|PrivateTGW: number of addresses (a power of two), one per line' },
      { id: 'dhcp', label: 'DHCP on the subnets', control: 'toggle', default: true },
      { id: 'include_ip_block', label: 'Also write the provider’s external IP block', control: 'toggle', default: false },
      { id: 'ip_block_name', label: 'External IP block name', control: 'text', default: 'region1-external', showWhen: { input: 'include_ip_block', equals: ['true'] } },
      { id: 'ip_block_cidr', label: 'External IP block CIDR', control: 'text', default: '203.0.113.0/24', showWhen: { input: 'include_ip_block', equals: ['true'] } },
      { id: 'region', label: 'Region', control: 'text', default: 'region1', showWhen: { input: 'include_ip_block', equals: ['true'] } },
      { id: 'max_subnet_size', label: 'Largest prefix an organization may take', control: 'number', default: 26, min: 8, max: 32, showWhen: { input: 'include_ip_block', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const namespace = str(values, 'namespace', 'team-a-dev');
      const vpc = str(values, 'vpc_name', 'region1-default-vpc');
      const vlan = str(values, 'connectivity', 'centralized') === 'distributed-vlan';
      const dhcp = bool(values, 'dhcp', true);
      const withBlock = bool(values, 'include_ip_block', false);
      const blockName = str(values, 'ip_block_name', 'region1-external');
      const blockCidr = str(values, 'ip_block_cidr', '203.0.113.0/24');
      const region = str(values, 'region', 'region1');
      const maxSize = num(values, 'max_subnet_size', 26);
      void name;

      const findings            = [];
      const subnets = str(values, 'subnets', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [n = '', mode = '', size = ''] = line.split(':').map((p) => p.trim());
          return { name: n.toLowerCase(), mode, size: Number(size), line };
        });
      const MODES = ['Public', 'Private', 'PrivateTGW'];
      for (const s of subnets) {
        if (!LABEL.test(s.name)) findings.push(error('vcfa91.vpc.name', `Subnet "${s.name}" is not a valid Kubernetes name.`, { path: s.line, source: SRC }));
        if (!MODES.includes(s.mode)) findings.push(error('vcfa91.vpc.mode', `"${s.mode}" is not an access mode. Use Public, Private or PrivateTGW.`, { path: s.line, source: SRC }));
        if (!Number.isInteger(s.size) || s.size < 4 || (s.size & (s.size - 1)) !== 0) {
          findings.push(error('vcfa91.vpc.size', `Subnet ${s.name}: ${s.size} addresses is not a power of two. NSX allocates subnets as CIDR blocks.`, { remediation: '16, 32, 64, 128, 256…', source: SRC }));
        }
        if (vlan && s.mode === 'Private') {
          findings.push(error('vcfa91.vpc.vlan-private', `Subnet ${s.name} is Private, which a VLAN-backed VPC does not support.`, { remediation: 'On 9.1.1 VLAN-backed VPCs the IP scheme comes from the physical VLAN CIDRs; use Public or PrivateTGW, or a centralized VPC.', source: 'VCF Automation 9.1.1 release notes' }));
        }
      }
      if (subnets.length === 0) findings.push(error('vcfa91.vpc.none', 'No subnets are listed.', { source: SRC }));
      const publicAddresses = subnets.filter((s) => s.mode === 'Public').reduce((sum, s) => sum + (Number.isFinite(s.size) ? s.size : 0), 0);
      if (publicAddresses > 0) {
        findings.push(info('vcfa91.vpc.public', `${publicAddresses} Public addresses come from the provider’s external IP block and are routed to the Tier-0.`, { remediation: 'Public is for what has to be reached from outside. Most tiers are Private behind NAT, or PrivateTGW when other VPCs on the same transit gateway need them.', source: SRC }));
      }
      if (withBlock && !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(blockCidr)) {
        findings.push(error('vcfa91.vpc.cidr', `"${blockCidr}" is not an IPv4 CIDR.`, { source: SRC }));
      }

      const yaml = subnets
        .map((s) =>
          [
            '---',
            '# VERIFY apiVersion and field names: kubectl explain subnet.spec (crd.nsx.vmware.com)',
            'apiVersion: crd.nsx.vmware.com/v1alpha1',
            'kind: Subnet',
            'metadata:',
            `  name: ${s.name}`,
            `  namespace: ${namespace}`,
            '  labels:',
            '    archtoolkit/managed: "true"',
            'spec:',
            `  accessMode: ${s.mode}`,
            `  ipv4SubnetSize: ${Number.isFinite(s.size) ? s.size : 16}`,
            '  subnetDHCPConfig:',
            `    mode: ${dhcp ? 'DHCPServer' : 'DHCPDeactivated'}`,
          ].join('\n'),
        )
        .join('\n')
        .concat('\n');

      const discover = kubeReadScript(`Show the VPC networking of namespace ${namespace}: API versions, VPC, subnets and subnet sets.`, [
        `NS=${q(namespace)}`,
        'echo "NSX operator resources on this endpoint:"',
        'kubectl api-resources --api-group=crd.nsx.vmware.com -o wide || { echo "crd.nsx.vmware.com is not served here"; PROBLEMS=1; }',
        'echo',
        'echo "Network info for ${NS} (which VPC it is attached to):"',
        'kubectl get networkinfos -n "$NS" -o yaml 2>/dev/null | grep -E "name:|vpc|cidr|Path" || echo "  (none visible — VERIFY: kubectl api-resources | grep -i networkinfo)"',
        'echo',
        'echo "Subnets and subnet sets:"',
        'kubectl get subnets,subnetsets -n "$NS" -o wide || PROBLEMS=1',
        `echo; echo "Expected VPC: ${vpc}"`,
      ]);

      const blockTf = [
        `# External IP block ${blockName} in region ${region}. Provider work.`,
        '# 9.1 renames IP spaces to external IP blocks; the vcfa provider still calls the resource vcfa_ip_space.',
        '',
        'data "vcfa_region" "region" {',
        `  name = ${q(region)}`,
        '}',
        '',
        `resource "vcfa_ip_space" "${label(blockName, 'block').replace(/-/g, '_')}" {`,
        `  name                          = ${q(blockName)}`,
        '  description                   = "Managed by ArchToolKit / Terraform"',
        '  region_id                     = data.vcfa_region.region.id',
        `  default_quota_max_subnet_size = ${maxSize}`,
        '  default_quota_max_cidr_count  = 4',
        '  default_quota_max_ip_count    = 16',
        '',
        '  cidr_blocks {',
        `    name = ${q(blockName)}`,
        `    cidr = ${q(blockCidr)}`,
        '  }',
        '',
        '  lifecycle {',
        '    prevent_destroy = true',
        '  }',
        '}',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${subnets.length} VPC subnet(s) in namespace ${namespace}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'A project member or organization administrator creates the subnets for an application, before the VMs that use them.' },
        scope: {
          what: `Subnets ${subnets.map((s) => s.name).join(', ')} in the VPC of namespace ${namespace}${withBlock ? `, and the external IP block ${blockName}` : ''}.`,
          decidedBy: [
            'The namespace in each object, and the kubectl context the script checks.',
            `The VPC the namespace is attached to (${vpc} unless the organization chose another).`,
            'The organization’s IP block quota, which bounds Public subnets.',
          ],
          ifWrong: 'A Public subnet exposes its VMs to whatever the Tier-0 advertises to; a wrong namespace puts the subnet in another team’s VPC.',
        },
        guardrails: [
          { rule: 'The script stops unless the current context is EXPECT_CONTEXT', because: 'The context is the scope; a subnet created in the wrong organization is a routing change in someone else’s VPC.' },
          { rule: 'kubectl create, not apply', because: 'create refuses to change a subnet that already exists; resizing a live subnet renumbers what is on it.' },
          { rule: 'Server-side dry run unless --execute', because: 'The NSX operator’s admission checks the access mode, size and quota before anything is allocated.' },
          ...(withBlock ? [{ rule: 'Apply only a saved, read plan for the IP block, with prevent_destroy', because: 'Destroying an external block withdraws addresses in use.' }] : []),
        ],
        dryRun: ['create-subnets.sh without --execute runs a server-side dry run.', 'discover.sh only reads.', ...(withBlock ? ['plan.sh without --execute.'] : [])],
        undo: ['kubectl delete subnet <name> -n ' + namespace + ' — refused while VMs are attached. Public addresses go back to the organization’s quota.'],
        told: ['NSX Manager audit log for the subnet and its segment.', 'Kubernetes events on the Subnet object.'],
        requires: ['An All Apps organization with regional networking set, and a namespace attached to a VPC.', 'kubectl and the VCF CLI, logged in to the organization and namespace.'],
        files: {
          'subnets.k8s.yaml': yaml,
          'create-subnets.sh': kubeScript(`Create the VPC subnets for ${namespace}.`, [], ['subnets.k8s.yaml'], `kubectl delete -f subnets.k8s.yaml (after the VMs on them are gone).`),
          'discover.sh': discover,
          ...(withBlock ? { 'versions.tf': VERSIONS_TF, 'ip-block.tf': blockTf, 'plan.sh': tfScript(`Create the external IP block ${blockName}.`, 'remove it from ip-block.tf and apply once nothing uses it.') } : {}),
        },
        notes: [
          'Access modes: Public comes from the external IP block and is advertised to the Tier-0; Private is reachable only inside the VPC and leaves by SNAT; PrivateTGW is reachable from every VPC on the same transit gateway (Tom Fojta, VCF Automation 9.0 networking deep dive). Older releases called PrivateTGW "Project" — VERIFY with kubectl explain subnet.spec.accessMode.',
          '9.1 adds several transit gateways per organization with NAT, IPsec VPN and gateway firewall, organization-wide shared subnets, and shared VLAN extension subnets from the provider. Those are set in the organization portal; subnets here attach to whatever the VPC is connected to.',
          'VMs join a subnet by name in spec.network.interfaces (kind Subnet or SubnetSet) — see "A VM Service virtual machine".',
          'The VPC itself — the region default <region>-default-vpc, or another — is chosen when the namespace is made. There is no separate VPC object to write here that could be confirmed on 9.1.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_content_library',
    platform: PLATFORM,
    label: 'Content libraries and VM images for All Apps',
    group: 'VCF Automation 9.1 — content',
    description:
      'A content library as VCF Automation 9.1 has them — provider, organization, or (new in 9.1) project-scoped — local, subscribed to a URL, or subscribed to the Canonical Ubuntu images; with its OVA, OVF or ISO items uploaded, and a check that lists every item’s VM image identifier (vmi-…), which is what a VM Service request names.',
    inputs: [
      { id: 'library_name', label: 'Library name', control: 'text', default: 'team-a-images' },
      {
        id: 'owner',
        label: 'Owned by',
        control: 'select',
        options: [
          { value: 'org', label: 'The organization — shared with its projects' },
          { value: 'project', label: 'Projects only (9.1 project content library)' },
          { value: 'provider', label: 'The provider — shared to organizations' },
        ],
        default: 'org',
      },
      { id: 'org_name', label: 'Organization', control: 'text', default: 'team-a', showWhen: { input: 'owner', notEquals: ['provider'] } },
      {
        id: 'subscription',
        label: 'Source',
        control: 'select',
        options: [
          { value: 'local', label: 'Local — items uploaded here' },
          { value: 'url', label: 'Subscribed to a published library URL' },
          { value: 'canonical', label: 'Subscribed to Canonical Ubuntu images (9.1)' },
        ],
        default: 'local',
      },
      { id: 'subscription_url', label: 'Subscription URL', control: 'text', default: '', placeholder: 'https://library.example.com/lib.json', showWhen: { input: 'subscription', equals: ['url', 'canonical'] } },
      { id: 'subscription_password', label: 'The published library needs a password', control: 'toggle', default: false, showWhen: { input: 'subscription', equals: ['url'] } },
      { id: 'storage_class', label: 'Storage class', control: 'text', default: 'vsan-default-storage-policy' },
      { id: 'region', label: 'Region', control: 'text', default: 'region1' },
      {
        id: 'permission',
        label: 'Projects get',
        control: 'select',
        options: [
          { value: 'READ_ONLY', label: 'Read only' },
          { value: 'READ_WRITE', label: 'Read and write' },
        ],
        default: 'READ_ONLY',
        showWhen: { input: 'owner', notEquals: ['provider'] },
      },
      { id: 'items', label: 'Items to upload', control: 'textarea', default: 'ubuntu-24.04-server: images/ubuntu-24.04-server-cloudimg-amd64.ova', hint: 'name: path, one per line; an OVF lists its .vmdk files after it, comma separated', showWhen: { input: 'subscription', equals: ['local'] } },
    ],
    automation: (values                 , name        )             => {
      const lib = str(values, 'library_name', 'images');
      const owner = str(values, 'owner', 'org');
      const org = owner === 'provider' ? 'System' : str(values, 'org_name', 'team-a');
      const sub = str(values, 'subscription', 'local');
      const url = str(values, 'subscription_url', '');
      const needsPassword = sub === 'url' && bool(values, 'subscription_password', false);
      const storageClass = str(values, 'storage_class', 'vsan-default-storage-policy');
      const region = str(values, 'region', 'region1');
      const permission = str(values, 'permission', 'READ_ONLY');
      const tf = label(lib, 'library').replace(/-/g, '_');
      void name;
      const items =
        sub === 'local'
          ? str(values, 'items', '')
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => {
                const at = l.indexOf(':');
                const itemName = at < 0 ? l.split('/').pop() ?? l : l.slice(0, at).trim();
                const paths = listOf(at < 0 ? l : l.slice(at + 1));
                return { name: itemName, paths };
              })
          : [];

      const findings            = [];
      if (sub !== 'local' && !url) {
        findings.push(
          warning('vcfa91.cl.no-url', sub === 'canonical' ? 'No Canonical subscription URL is set.' : 'No subscription URL is set.', {
            remediation: sub === 'canonical' ? 'Copy the Canonical subscription URL shown when creating a subscribed library in the 9.1 portal; this file leaves it <REQUIRED>.' : 'Use the published library’s lib.json URL.',
            source: SRC,
          }),
        );
      }
      if (needsPassword) {
        findings.push(warning('vcfa91.cl.password-401', 'Subscribing to a password-protected library fails with HTTP 401 on VCF Automation 9.1.1 (known issue), both at creation and at sync.', { remediation: 'Publish the source without a password on a network only the Supervisors reach, or wait for the fix.', source: 'VCF Automation 9.1.1 release notes' }));
      }
      for (const it of items) {
        const first = it.paths[0] ?? '';
        if (/\.ovf$/i.test(first) && it.paths.length < 2) {
          findings.push(warning('vcfa91.cl.ovf-files', `Item ${it.name} is an OVF with no disk files listed.`, { remediation: 'List the .vmdk (and .mf) files after the .ovf, comma separated, or package it as an OVA.', source: SRC }));
        }
        if (first && !/\.(ova|ovf|iso)$/i.test(first)) {
          findings.push(warning('vcfa91.cl.type', `Item ${it.name}: ${first} is not an OVA, OVF or ISO.`, { source: SRC }));
        }
      }
      if (sub === 'canonical') {
        findings.push(info('vcfa91.cl.canonical-sbom', 'Early 9.1 builds rejected some Canonical Ubuntu images on an SBOM file (fixed in 9.1.0.0200).', { remediation: 'Patch to 9.1.0.0200 or later before subscribing.', source: 'VCF Automation 9.1.0.0200 release notes' }));
      }

      const tfLines = [
        `# Content library ${lib} (${owner === 'provider' ? 'provider' : owner === 'project' ? `project-scoped, organization ${org}` : `organization ${org}`}).`,
        `# Run with VCFA_ORG=${org} and a token for it.`,
        '',
        'data "vcfa_region" "region" {',
        `  name = ${q(region)}`,
        '}',
        '',
        '# VERIFY the data source arguments: terraform providers schema -json | jq \'.provider_schemas[].data_source_schemas.vcfa_storage_class\'',
        'data "vcfa_storage_class" "sc" {',
        '  region_id = data.vcfa_region.region.id',
        `  name      = ${q(storageClass)}`,
        '}',
        '',
        ...(owner !== 'provider' ? ['data "vcfa_org" "org" {', `  name = ${q(org)}`, '}', ''] : ['data "vcfa_org" "system" {', '  name = "System"', '}', '']),
        ...(needsPassword ? ['variable "subscription_password" {', '  description = "From TF_VAR_subscription_password — never written to a file"', '  type        = string', '  sensitive   = true', '}', ''] : []),
        `resource "vcfa_content_library" "${tf}" {`,
        `  name              = ${q(lib)}`,
        '  description       = "Managed by ArchToolKit / Terraform"',
        `  org_id            = ${owner === 'provider' ? 'data.vcfa_org.system.id' : 'data.vcfa_org.org.id'}`,
        '  storage_class_ids = [data.vcfa_storage_class.sc.id]',
        ...(owner !== 'provider' ? ['  auto_attach       = true', `  is_project_scoped = ${owner === 'project' ? 'true' : 'false'}`, `  all_projects_permission = ${q(permission)}`] : []),
        ...(sub !== 'local'
          ? [
              '',
              '  subscription_config {',
              `    subscription_url = ${q(url || '<REQUIRED — the published library URL>')}`,
              ...(needsPassword ? ['    password         = var.subscription_password'] : []),
              '  }',
            ]
          : []),
        '}',
        '',
        ...items.flatMap((it, i) => [
          `resource "vcfa_content_library_item" "item${i}" {`,
          `  name               = ${q(it.name)}`,
          '  description        = "Uploaded by ArchToolKit / Terraform"',
          `  content_library_id = vcfa_content_library.${tf}.id`,
          `  file_paths         = [${it.paths.map(q).join(', ')}]`,
          '  upload_piece_size  = 10',
          '}',
          '',
        ]),
        'output "image_identifiers" {',
        '  description = "The vmi-… names VM Service requests use"',
        `  value       = { ${items.map((it, i) => `${q(it.name)} = vcfa_content_library_item.item${i}.image_identifier`).join(', ')} }`,
        '}',
        '',
      ].join('\n');

      const check = restScript({
        purpose: `Check content library ${lib} is READY and list its items with their VM image identifiers.`,
        scope: owner === 'provider' ? 'provider' : 'tenant',
        act: false,
        body: [
          `LIB=${q(lib)}`,
          '# VERIFY: /cloudapi/vcf/contentLibraries (go-vcloud-director OpenApiPathVcf + contentLibraries/).',
          'L=$(probe "/cloudapi/vcf/contentLibraries?filter=name==${LIB}") || exit 2',
          "[[ \"$(jq '.values | length' <<<\"$L\")\" -ge 1 ]] || { echo \"Library ${LIB}: not found\"; exit 1; }",
          "LID=$(jq -r '.values[0].id' <<<\"$L\"); STATUS=$(jq -r '.values[0].status // \"?\"' <<<\"$L\")",
          "jq -r '.values[0] | \"Library \\(.name): status=\\(.status // \"?\") type=\\(.libraryType // \"?\") subscribed=\\(.isSubscribed // \"?\")\"' <<<\"$L\"",
          'PROBLEMS=0',
          '[[ "$STATUS" == READY ]] || PROBLEMS=1',
          'if I=$(probe "/cloudapi/vcf/contentLibraryItems?filter=contentLibrary.id==${LID}&pageSize=128"); then',
          "  jq -r '.values[]? | \"  \\(.name)\\t\\(.itemType // \"?\")\\t\\(.imageIdentifier // \"-\")\\t\\(.status // \"?\")\"' <<<\"$I\"",
          "  BAD=$(jq '[.values[]? | select((.status // \"READY\") != \"READY\")] | length' <<<\"$I\")",
          '  (( BAD == 0 )) || { echo "  ${BAD} item(s) not READY"; PROBLEMS=1; }',
          'fi',
          'exit $PROBLEMS',
        ],
      });

      return {
        platform: PLATFORM,
        title: `Content library ${lib}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'An organization or provider administrator publishing images, and again whenever an image is replaced.', worstCase: sub !== 'local' ? 'a sync of every item on each subscription refresh — plan the storage for the whole source library' : undefined },
        scope: {
          what: `Library ${lib}${items.length ? ` and ${items.length} item(s)` : ''} on storage class ${storageClass} in region ${region}.`,
          decidedBy: [
            owner === 'provider' ? 'The provider, who shares it with organizations.' : owner === 'project' ? `Organization ${org}, scoped to the projects given permission (9.1).` : `Organization ${org}; auto_attach makes it visible in every namespace.`,
            sub !== 'local' ? 'The source library: whatever it publishes is synced here.' : 'The items listed.',
          ],
          ifWrong: 'An image in the wrong library is either invisible to the teams that need it or offered to teams that should not boot it; a subscription to a large source fills the storage class.',
        },
        guardrails: [
          { rule: 'Apply only a saved, read plan', because: 'The plan lists every upload and subscription before gigabytes move.' },
          ...(needsPassword ? [{ rule: 'The subscription password comes from TF_VAR_subscription_password, marked sensitive', because: 'It never lands in a .tf file or the plan output.' }] : []),
          { rule: 'check-library.sh fails unless the library and every item are READY', because: 'A PARTIALLY_READY library still appears in the picker and fails at VM creation.' },
        ],
        dryRun: ['plan.sh without --execute.', 'check-library.sh reads only.'],
        undo: ['Remove the items or library from content-library.tf and apply. VMs already deployed from an image keep running; new requests naming its vmi fail.'],
        told: ['VCF Automation events, and vCenter content library tasks, which VCF Operations collects.'],
        requires: ['VCF Automation 9.1 (project content libraries and Canonical subscriptions are 9.1).', 'A storage class granted to the organization in the region.', 'Terraform 1.5+ and the image files on the host that runs plan.sh.'],
        files: {
          'versions.tf': VERSIONS_TF,
          'content-library.tf': tfLines,
          'plan.sh': tfScript(`Create content library ${lib}.`, 'remove it from content-library.tf and apply.'),
          'check-library.sh': check,
        },
        notes: [
          'Arguments follow vcfa_content_library (org_id, storage_class_ids, auto_attach, is_project_scoped, all_projects_permission, subscription_config) and vcfa_content_library_item (content_library_id, file_paths, upload_piece_size in MB; image_identifier is read-only).',
          'VM Service names an image by its identifier (vmi-…) or its display name; the identifier survives a rename. kubectl get vmi / clustervmi in the namespace lists what is visible.',
          'is_project_scoped cannot be changed after creation.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_vm_service',
    platform: PLATFORM,
    label: 'A VM Service virtual machine, with cloud-init',
    group: 'VCF Automation 9.1 — consumption',
    description:
      'A virtual machine the All Apps way: a VirtualMachine object (vmoperator.vmware.com) with class, image, storage class, a named VPC subnet and cloud-init from a Secret, an optional data disk as a PVC, and an optional VirtualMachineService load balancer (Avi, self-service in 9.1). The script checks the API version is served and the image is visible before it creates anything.',
    inputs: [
      { id: 'vm_name', label: 'VM name', control: 'text', default: 'web01' },
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'team-a-dev-x7k2p' },
      {
        id: 'api_version',
        label: 'VM Operator API',
        control: 'select',
        options: [
          { value: 'v1alpha5', label: 'v1alpha5 — VCF 9.x examples' },
          { value: 'v1alpha4', label: 'v1alpha4' },
          { value: 'v1alpha3', label: 'v1alpha3 — 9.0 KB examples' },
        ],
        default: 'v1alpha5',
      },
      { id: 'vm_class', label: 'VM class', control: 'text', default: 'best-effort-small' },
      { id: 'image', label: 'Image', control: 'text', default: 'vmi-0123456789abcdef0', hint: 'kubectl get vmi -n <namespace>' },
      { id: 'storage_class', label: 'Storage class', control: 'text', default: 'vsan-default-storage-policy' },
      {
        id: 'network_kind',
        label: 'Network',
        control: 'select',
        options: [
          { value: 'default', label: 'The namespace default' },
          { value: 'Subnet', label: 'A named Subnet' },
          { value: 'SubnetSet', label: 'A named SubnetSet' },
        ],
        default: 'Subnet',
      },
      { id: 'network_name', label: 'Subnet or SubnetSet name', control: 'text', default: 'web', showWhen: { input: 'network_kind', notEquals: ['default'] } },
      { id: 'cloud_init', label: 'Bootstrap with cloud-init', control: 'toggle', default: true },
      { id: 'admin_user', label: 'Admin user', control: 'text', default: 'ops', showWhen: { input: 'cloud_init', equals: ['true'] } },
      { id: 'ssh_key', label: 'SSH public key', control: 'text', default: '', placeholder: 'ssh-ed25519 AAAA… ops@example.com', showWhen: { input: 'cloud_init', equals: ['true'] } },
      { id: 'data_disk_gib', label: 'Data disk (GiB)', control: 'number', default: 0, min: 0, max: 62000, hint: '0 means none' },
      { id: 'load_balancer', label: 'Expose with a load balancer', control: 'toggle', default: false },
      { id: 'lb_ports', label: 'Ports', control: 'text', default: '443', showWhen: { input: 'load_balancer', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const vm = label(str(values, 'vm_name', 'vm01'), 'vm01');
      const ns = str(values, 'namespace', 'team-a-dev');
      const api = str(values, 'api_version', 'v1alpha5');
      const cls = str(values, 'vm_class', 'best-effort-small');
      const image = str(values, 'image', '');
      const sc = str(values, 'storage_class', 'vsan-default-storage-policy');
      const netKind = str(values, 'network_kind', 'Subnet');
      const netName = str(values, 'network_name', 'web');
      const ci = bool(values, 'cloud_init', true);
      const user = str(values, 'admin_user', 'ops');
      const key = str(values, 'ssh_key', '');
      const disk = num(values, 'data_disk_gib', 0);
      const lb = bool(values, 'load_balancer', false);
      const ports = listOf(str(values, 'lb_ports', '443')).map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
      void name;

      const findings            = [];
      if (!image) findings.push(error('vcfa91.vm.no-image', 'No image is named.', { remediation: 'kubectl get vmi -n <namespace> lists the images the namespace can see.', source: SRC }));
      if (ci && !key) findings.push(info('vcfa91.vm.no-key', 'cloud-init has no SSH key, so nobody can log in except through the console.', { remediation: 'Add a public key. Never a password: cloud-init user-data is readable by anyone who can read the Secret.', source: SRC }));
      if (key && !/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+/.test(key)) findings.push(warning('vcfa91.vm.key', 'The SSH key does not look like an OpenSSH public key.', { source: SRC }));
      if (/^guaranteed-/.test(cls)) findings.push(info('vcfa91.vm.guaranteed', `${cls} reserves its CPU and memory whether the VM uses them or not.`, { remediation: 'Right for latency-sensitive production; expensive for development.', source: SRC }));
      if (lb && ports.length === 0) findings.push(error('vcfa91.vm.ports', 'A load balancer needs at least one valid port.', { source: SRC }));
      if (api === 'v1alpha3') findings.push(info('vcfa91.vm.api', 'v1alpha3 is the 9.0-era version. On 9.1 check kubectl api-versions | grep vmoperator for the newest served.', { source: SRC }));

      const secretName = `${vm}-cloud-init`;
      const cloudConfig = [
        '#cloud-config',
        'users:',
        `  - name: ${user}`,
        '    sudo: "ALL=(ALL) NOPASSWD:ALL"',
        '    shell: /bin/bash',
        ...(key ? ['    ssh_authorized_keys:', `      - ${key}`] : []),
        'ssh_pwauth: false',
        'package_update: true',
        ...(disk > 0 ? ['disk_setup:', '  /dev/sdb:', '    table_type: gpt', '    layout: true', 'fs_setup:', '  - device: /dev/sdb1', '    filesystem: xfs', '    label: data', 'mounts:', '  - [LABEL=data, /data, xfs, "defaults,nofail", "0", "2"]'] : []),
      ];

      const docs           = [];
      if (ci) {
        docs.push(
          [
            '---',
            '# cloud-init user-data. A public key only; no password is ever set here.',
            'apiVersion: v1',
            'kind: Secret',
            'metadata:',
            `  name: ${secretName}`,
            `  namespace: ${ns}`,
            'type: Opaque',
            'stringData:',
            '  user-data: |',
            ...cloudConfig.map((l) => `    ${l}`),
          ].join('\n'),
        );
      }
      if (disk > 0) {
        docs.push(['---', 'apiVersion: v1', 'kind: PersistentVolumeClaim', 'metadata:', `  name: ${vm}-data`, `  namespace: ${ns}`, 'spec:', '  accessModes: [ReadWriteOnce]', `  storageClassName: ${sc}`, '  resources:', '    requests:', `      storage: ${disk}Gi`].join('\n'));
      }
      docs.push(
        [
          '---',
          `apiVersion: vmoperator.vmware.com/${api}`,
          'kind: VirtualMachine',
          'metadata:',
          `  name: ${vm}`,
          `  namespace: ${ns}`,
          '  labels:',
          `    app: ${vm}`,
          '    archtoolkit/managed: "true"',
          'spec:',
          `  className: ${cls}`,
          `  imageName: ${image || '<REQUIRED — vmi-… from kubectl get vmi>'}`,
          `  storageClass: ${sc}`,
          '  powerState: PoweredOn',
          ...(netKind !== 'default'
            ? ['  network:', '    interfaces:', '      - name: eth0', '        network:', `          name: ${netName}`, `          kind: ${netKind}`, '          apiVersion: crd.nsx.vmware.com/v1alpha1']
            : []),
          ...(ci ? ['  bootstrap:', '    cloudInit:', '      rawCloudConfig:', `        name: ${secretName}`, '        key: user-data'] : []),
          ...(disk > 0 ? ['  volumes:', '    - name: data', '      persistentVolumeClaim:', `        claimName: ${vm}-data`] : []),
        ].join('\n'),
      );
      if (lb) {
        docs.push(
          [
            '---',
            `apiVersion: vmoperator.vmware.com/${api}`,
            'kind: VirtualMachineService',
            'metadata:',
            `  name: ${vm}-lb`,
            `  namespace: ${ns}`,
            'spec:',
            '  type: LoadBalancer',
            '  selector:',
            `    app: ${vm}`,
            '  ports:',
            ...ports.flatMap((p) => [`    - name: tcp-${p}`, '      protocol: TCP', `      port: ${p}`, `      targetPort: ${p}`]),
          ].join('\n'),
        );
      }
      const yaml = `${docs.join('\n')}\n`;

      const pre = [
        `NS=${q(ns)}`,
        `kubectl api-versions | grep -qx 'vmoperator.vmware.com/${api}' || { echo "vmoperator.vmware.com/${api} is not served here. kubectl api-versions | grep vmoperator shows what is." >&2; exit 2; }`,
        ...(image
          ? [`kubectl get vmi -n "$NS" '${image}' >/dev/null 2>&1 || kubectl get clustervmi '${image}' >/dev/null 2>&1 || { echo "Image ${image} is not visible in $NS (kubectl get vmi -n $NS)" >&2; exit 2; }`]
          : []),
        `kubectl get virtualmachineclass '${cls}' -n "$NS" >/dev/null 2>&1 || echo "warning: VM class ${cls} not listed in $NS — the dry run will say whether it is bound" >&2`,
        '',
      ];

      return {
        platform: PLATFORM,
        title: `VM Service VM ${vm} in ${ns}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'A project member creates it with kubectl through the VCF Automation endpoint, or a pipeline does.' },
        scope: {
          what: `One VM, ${vm}, of class ${cls} in namespace ${ns}${disk > 0 ? `, with a ${disk} GiB data disk` : ''}${lb ? `, behind a load balancer on ${ports.join(', ')}` : ''}.`,
          decidedBy: ['The kubectl context (organization, project, namespace), which the script checks.', `The namespace’s limits and the VM classes bound to it — ${cls} must be one.`, netKind === 'default' ? 'The namespace default network.' : `The ${netKind} ${netName} in the namespace’s VPC.`],
          ifWrong: 'A VM in the wrong namespace counts against another team’s limits and sits on their subnet; a load balancer on the wrong port exposes whatever listens there.',
        },
        guardrails: [
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'The context is the scope; the same file creates the VM wherever kubectl points.' },
          { rule: `Stops unless vmoperator.vmware.com/${api} is served and the image is visible`, because: 'Both fail late otherwise — the VM object exists and sits unready with an event nobody reads.' },
          { rule: 'kubectl create, never apply', because: 'create refuses to overwrite an existing VM of the same name; apply would change its class or image in place.' },
          { rule: 'cloud-init sets no password and disables SSH password login', because: 'The Secret is readable by anyone who can read Secrets in the namespace.' },
        ],
        dryRun: ['create-vm.sh without --execute: server-side dry run — class binding, image, storage class and quota are all checked.'],
        undo: [`kubectl delete -f ${vm}.k8s.yaml. The VM and its data disk are deleted with it.`],
        told: ['Kubernetes events on the VirtualMachine.', 'vCenter tasks for the VM, which VCF Operations collects.'],
        requires: ['An All Apps namespace with the VM class, storage class and image available to it.', 'kubectl and the VCF CLI logged in to the namespace context.', ...(lb ? ['Avi load balancing delegated to the organization (9.1).'] : [])],
        files: {
          [`${vm}.k8s.yaml`]: yaml,
          'create-vm.sh': kubeScript(`Create VM ${vm} in ${ns}.`, pre, [`${vm}.k8s.yaml`], `kubectl delete -f ${vm}.k8s.yaml`),
        },
        notes: [
          'VCF 9.x examples use vmoperator.vmware.com/v1alpha5; a 9.0 KB uses v1alpha3 for the same network interface shape. Pick whichever kubectl api-versions shows as newest.',
          'Use kubectl create at the VCF Automation endpoint: it rejects the last-applied annotation kubectl apply adds (theaistack.blog, 2026).',
          'spec.network.interfaces[].network names a Subnet or SubnetSet in the namespace (Broadcom KB 426105). Without it the VM goes on the namespace default.',
          'kubectl get vm <name> -n <namespace> -o jsonpath="{.status.network.primaryIP4}" gives the address once it is up.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_data_services',
    platform: PLATFORM,
    label: 'A Postgres or MySQL database from Data Services, with backups',
    group: 'VCF Automation 9.1 — consumption',
    description:
      'A database from VCF Data Services Manager, requested in an All Apps namespace: PostgresCluster or MySQLCluster (databases.dataservices.vmware.com) with VM class, storage, infrastructure policy, maintenance window and a backup schedule to a named backup location. The admin password goes into a Secret from a mode-600 file, never into the YAML.',
    inputs: [
      {
        id: 'engine',
        label: 'Engine',
        control: 'select',
        options: [
          { value: 'postgres', label: 'PostgreSQL' },
          { value: 'mysql', label: 'MySQL' },
        ],
        default: 'postgres',
      },
      { id: 'db_name', label: 'Name', control: 'text', default: 'orders-db' },
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'team-a-prod-q4m8z' },
      { id: 'version', label: 'Version', control: 'text', default: '16', hint: 'As DSM offers it: 16 for Postgres, e.g. 8.0.41 for MySQL' },
      { id: 'vm_class', label: 'VM class', control: 'text', default: 'best-effort-medium' },
      { id: 'storage_policy', label: 'Storage policy', control: 'text', default: 'vSAN Default Storage Policy' },
      { id: 'storage_gib', label: 'Storage (GiB)', control: 'number', default: 50, min: 5, max: 16000 },
      {
        id: 'topology',
        label: 'Topology',
        control: 'select',
        options: [
          { value: 'single', label: 'Single node' },
          { value: 'ha', label: 'Highly available' },
        ],
        default: 'ha',
      },
      { id: 'infra_policy', label: 'Infrastructure policy', control: 'text', default: 'dsm-infra-policy', hint: 'Set by the provider in DSM' },
      { id: 'admin_user', label: 'Admin user', control: 'text', default: 'dbadmin' },
      { id: 'backup', label: 'Scheduled backups', control: 'toggle', default: true },
      { id: 'backup_location', label: 'Backup location', control: 'text', default: 'dsm-backups', showWhen: { input: 'backup', equals: ['true'] } },
      { id: 'retention_days', label: 'Keep backups (days)', control: 'number', default: 30, min: 1, max: 365, showWhen: { input: 'backup', equals: ['true'] } },
      { id: 'backup_cron', label: 'Full backup schedule (cron)', control: 'text', default: '59 23 * * 6', showWhen: { input: 'backup', equals: ['true'] } },
      {
        id: 'maintenance_day',
        label: 'Maintenance day',
        control: 'select',
        options: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'].map((d) => ({ value: d, label: d[0] + d.slice(1).toLowerCase() })),
        default: 'SATURDAY',
      },
    ],
    automation: (values                 , name        )             => {
      const pg = str(values, 'engine', 'postgres') === 'postgres';
      const db = label(str(values, 'db_name', 'db'), 'db');
      const ns = str(values, 'namespace', 'team-a');
      const version = str(values, 'version', pg ? '16' : '8.0.41');
      const cls = str(values, 'vm_class', 'best-effort-medium');
      const sp = str(values, 'storage_policy', 'vSAN Default Storage Policy');
      const gib = num(values, 'storage_gib', 50);
      const ha = str(values, 'topology', 'ha') === 'ha';
      const infra = str(values, 'infra_policy', 'dsm-infra-policy');
      const user = str(values, 'admin_user', 'dbadmin');
      const backup = bool(values, 'backup', true);
      const loc = str(values, 'backup_location', 'dsm-backups');
      const days = num(values, 'retention_days', 30);
      const cron = str(values, 'backup_cron', '59 23 * * 6');
      const day = str(values, 'maintenance_day', 'SATURDAY');
      const kind = pg ? 'PostgresCluster' : 'MySQLCluster';
      const secret = `${db}-admin`;
      void name;

      const findings            = [];
      if (!backup) findings.push(warning('vcfa91.db.no-backup', 'No scheduled backup: a deleted or corrupted database cannot be recovered.', { remediation: 'Turn on backups to a backup location the provider has set up in DSM.', source: SRC }));
      if (backup && cron.split(/\s+/).length !== 5) findings.push(error('vcfa91.db.cron', `"${cron}" is not a five-field cron schedule.`, { source: SRC }));
      if (!ha) findings.push(info('vcfa91.db.single', 'A single-node database is down for the whole of every maintenance window and every host failure.', { source: SRC }));
      if (!pg) findings.push(info('vcfa91.db.mysql-ui', 'On 9.0.1 MySQL databases were made through kubectl only and did not appear in the VCF Automation UI.', { remediation: 'VERIFY on 9.1 whether they show under Data Services; manage them with kubectl either way.', source: 'Cormac Hogan, DSM 9.0.1 MySQL through VCF Automation' }));
      if (!pg && ha) findings.push(info('vcfa91.db.mysql-members', 'MySQL HA is three members.', { source: SRC }));

      const yaml = [
        '# VERIFY: kubectl explain ' + kind.toLowerCase() + '.spec — field names follow DSM 9.0.x examples.',
        'apiVersion: databases.dataservices.vmware.com/v1alpha1',
        `kind: ${kind}`,
        'metadata:',
        `  name: ${db}`,
        `  namespace: ${ns}`,
        '  labels:',
        '    archtoolkit/managed: "true"',
        'spec:',
        `  version: ${q(version)}`,
        `  adminUsername: ${user}`,
        '  adminPasswordRef:',
        `    name: ${secret}`,
        ...(pg ? [`  databaseName: ${db.replace(/-/g, '_')}`, `  replicas: ${ha ? 1 : 0}`] : [`  members: ${ha ? 3 : 1}`]),
        '  vmClass:',
        `    name: ${cls}`,
        `  storagePolicyName: ${q(sp)}`,
        `  storageSpace: ${gib}Gi`,
        '  infrastructurePolicy:',
        `    name: ${infra}`,
        '  maintenanceWindow:',
        `    startDay: ${day}`,
        '    startTime: "23:59"',
        '    duration: 6h',
        ...(backup
          ? ['  backupLocation:', `    name: ${loc}`, '  backupConfig:', `    backupRetentionDays: ${days}`, '    schedules:', '      - name: full-weekly', `        schedule: ${q(cron)}`, '        type: full']
          : []),
        '',
      ].join('\n');

      const pre = [
        `NS=${q(ns)}`,
        ': "${DB_ADMIN_PASSWORD_FILE:?set DB_ADMIN_PASSWORD_FILE to a mode-600 file holding the admin password}"',
        'PERM=$(stat -c %a "$DB_ADMIN_PASSWORD_FILE" 2>/dev/null || stat -f %Lp "$DB_ADMIN_PASSWORD_FILE")',
        '[[ "$PERM" == 600 || "$PERM" == 400 ]] || { echo "$DB_ADMIN_PASSWORD_FILE must be mode 600" >&2; exit 2; }',
        'kubectl api-versions | grep -qx databases.dataservices.vmware.com/v1alpha1 || { echo "Data Services is not available in this context" >&2; exit 2; }',
        `if ! kubectl get secret -n "$NS" '${secret}' >/dev/null 2>&1; then`,
        '  # The password is read from the file by kubectl; it is not an argument and not in any YAML.',
        `  kubectl create secret generic '${secret}' -n "$NS" --from-literal=username='${user}' --from-file=password="$DB_ADMIN_PASSWORD_FILE" "\${MODE[@]}"`,
        'fi',
      ];

      const check = kubeReadScript(`Check ${kind} ${db}: ready, and when it was last backed up.`, [
        `NS=${q(ns)}`,
        `kubectl get ${kind.toLowerCase()} '${db}' -n "$NS" -o wide || exit 1`,
        `READY=$(kubectl get ${kind.toLowerCase()} '${db}' -n "$NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')`,
        '[[ "$READY" == True ]] || { echo "Not Ready"; PROBLEMS=1; }',
        'echo "Connection:"',
        `kubectl get ${kind.toLowerCase()} '${db}' -n "$NS" -o jsonpath='{.status.connection}' ; echo`,
        ...(backup
          ? ['# VERIFY the backup resource name: kubectl api-resources --api-group=databases.dataservices.vmware.com', `kubectl get postgresbackups,mysqlbackups -n "$NS" 2>/dev/null | grep '${db}' | tail -3 || echo "  no backups listed yet"`]
          : ['echo "Backups are off for this database."', 'PROBLEMS=1']),
      ]);

      return {
        platform: PLATFORM,
        title: `${pg ? 'PostgreSQL' : 'MySQL'} ${db} in ${ns}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'A project member requests it with kubectl through the VCF Automation endpoint, or from the Data Services page in the organization portal.' },
        scope: {
          what: `One ${ha ? 'highly available' : 'single-node'} ${kind} named ${db}, ${gib} GiB on ${sp}, of class ${cls}.`,
          decidedBy: ['The kubectl context and namespace.', `The infrastructure policy ${infra}, which decides where DSM actually places the database VMs (an infrastructure namespace, not the team’s).`, 'The DSM data service policy that lets this organization use the engine and version.'],
          ifWrong: 'A database in the wrong namespace is owned and deletable by the wrong team; one without backups is one bad DELETE from gone.',
        },
        guardrails: [
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'The context is the scope.' },
          { rule: 'Admin password only from a mode-600 file, into a Secret, never in YAML or argv', because: 'A password in a manifest ends up in Git.' },
          { rule: 'Stops if Data Services is not served in the context', because: 'Otherwise the error is a confusing "no matches for kind".' },
          { rule: 'kubectl create, not apply', because: 'apply to an existing database changes it in place — a version or class change is a restart.' },
        ],
        dryRun: ['create-db.sh without --execute: server-side dry run of the Secret and the database.', 'check-db.sh reads only.'],
        undo: [`kubectl delete ${kind.toLowerCase()} ${db} -n ${ns} deletes the database and its data. Backups are kept for their retention (VERIFY in DSM before relying on it).`],
        told: ['DSM’s own events and alerts, and VCF Operations if the DSM management pack is installed.', 'Kubernetes events on the object.'],
        requires: ['VCF Data Services Manager 9.x integrated with VCF Automation, with a data service policy for this organization.', ...(backup ? [`Backup location ${loc} configured in DSM.`] : []), 'kubectl logged in to the namespace.'],
        files: {
          [`${db}.k8s.yaml`]: yaml,
          'create-db.sh': kubeScript(`Create ${kind} ${db} in ${ns}.`, pre, [`${db}.k8s.yaml`], `kubectl delete ${kind.toLowerCase()} ${db} -n ${ns} — deletes the data.`),
          'check-db.sh': check,
        },
        notes: [
          'Fields follow the DSM 9.0.x examples (Tom Fojta; Cormac Hogan): adminUsername, adminPasswordRef, version, storageSpace, storagePolicyName, infrastructurePolicy, vmClass, maintenanceWindow, backupLocation, backupConfig. Postgres takes replicas (0 single, 1 HA); MySQL takes members (1 or 3).',
          'Connection details appear under .status.connection once Ready; the password stays in the Secret.',
          'The 9.1 VCF Automation release notes do not list Data Services changes; the DSM release notes are where engine versions move.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_tags_placement',
    platform: PLATFORM,
    label: 'Tag-based placement from the fleet tag standard',
    group: 'VCF Automation 9.1 — governance',
    description:
      'Turns the vCenter tag standard (Environment, Tier, Application, DataClass…) into VCF Automation tags that line up: capability tags for each cloud zone, constraint snippets and inputs for templates, resource tags for deployments. Checks the result: constraints no zone can satisfy, standard values nobody can be placed on, and multiple-cardinality categories used for placement.',
    inputs: [
      {
        id: 'standard',
        label: 'Tag standard',
        control: 'textarea',
        default: 'Environment | single | Production, Staging, Development\nTier | single | Gold, Silver, Bronze\nApplication | multiple | web, database, backup\nDataClass | single | Public, Internal, Confidential',
        hint: 'Category | single|multiple | values, one category per line',
      },
      {
        id: 'zones',
        label: 'Cloud zones and what each offers',
        control: 'textarea',
        default: 'Production zone A: Environment=Production, Tier=Gold, DataClass=Confidential, DataClass=Internal\nProduction zone B: Environment=Production, Tier=Silver, DataClass=Internal\nNon-production zone: Environment=Staging, Environment=Development, Tier=Bronze, DataClass=Internal, DataClass=Public',
        hint: 'Zone name: Category=Value, …',
      },
      { id: 'constraints', label: 'Template constraints', control: 'text', default: 'Environment=${input.environment}:hard, Tier=${input.tier}:soft', hint: 'Category=Value or ${input.x}, then :hard or :soft' },
      {
        id: 'key_case',
        label: 'Capability and constraint tags',
        control: 'select',
        options: [
          { value: 'as-is', label: 'exactly as the standard spells them (Environment:Production)' },
          { value: 'lower', label: 'lower-case (environment:production); resource tags stay as the standard spells them' },
        ],
        default: 'as-is',
        hint: 'Resource tags always use the standard’s exact case: VCF Automation writes them to vCenter as tags, and a different case is a different category there',
      },
      { id: 'write_zone_tags', label: 'Write the script that applies zone tags', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const lower = str(values, 'key_case', 'as-is') === 'lower';
      // Capability and constraint tags: VCF Automation's own, matched against each other.
      const norm = (s        ) => (lower ? s.trim().toLowerCase().replace(/\s+/g, '-') : s.trim());
      const writeZones = bool(values, 'write_zone_tags', true);
      void name;
      const findings            = [];

                                                                              
      const standard             = [];
      for (const line of str(values, 'standard', '').split('\n').map((l) => l.trim()).filter(Boolean)) {
        const [cat = '', card = '', vals = ''] = line.split('|').map((p) => p.trim());
        if (!cat || !/^(single|multiple)$/i.test(card)) {
          findings.push(warning('vcfa91.tags.standard-line', `Could not read "${line}".`, { remediation: 'Category | single|multiple | value, value', source: SRC }));
          continue;
        }
        standard.push({ name: cat, multiple: /multiple/i.test(card), values: listOf(vals) });
      }
      const catOf = (n        ) => standard.find((c) => c.name.toLowerCase() === n.trim().toLowerCase());
      // The standard's own spelling of a category and a value, whatever case they were typed in here.
      const keyOf = (k        ) => catOf(k)?.name ?? k.trim();
      const valueOf = (k        , v        ) => catOf(k)?.values.find((x) => x.toLowerCase() === v.trim().toLowerCase()) ?? v.trim();
      if (lower) {
        const spaced = standard.flatMap((c) => c.values.filter((v) => /\s/.test(v)).map((v) => `${c.name}=${v}`));
        if (spaced.length > 0) findings.push(warning('vcfa91.tags.lower-spaces', `${spaced.join(', ')} contain spaces. Lower-case mode writes zone tags with hyphens, but to_lower() in the template does not replace spaces, so those constraints match no zone.`, { remediation: 'Use the standard’s exact case instead, or values without spaces.', source: SRC }));
      }

                                                                             
      const zones         = [];
      for (const line of str(values, 'zones', '').split('\n').map((l) => l.trim()).filter(Boolean)) {
        const at = line.indexOf(':');
        if (at < 0) {
          findings.push(warning('vcfa91.tags.zone-line', `Could not read "${line}".`, { remediation: 'Zone name: Category=Value, …', source: SRC }));
          continue;
        }
        const tags = listOf(line.slice(at + 1)).map((pair) => {
          const [k = '', v = ''] = pair.split('=').map((p) => p.trim());
          return { key: k, value: v };
        });
        for (const t of tags) {
          const c = catOf(t.key);
          if (!c) findings.push(warning('vcfa91.tags.unknown-category', `Zone "${line.slice(0, at)}" uses ${t.key}, which is not in the tag standard.`, { source: SRC }));
          else if (!c.values.some((v) => v.toLowerCase() === t.value.toLowerCase())) findings.push(warning('vcfa91.tags.unknown-value', `Zone "${line.slice(0, at)}": ${t.key}=${t.value} is not a value the standard allows.`, { remediation: `Allowed: ${c.values.join(', ')}.`, source: SRC }));
        }
        zones.push({ name: line.slice(0, at).trim(), tags });
      }

                                                                                            
      const constraints               = listOf(str(values, 'constraints', '')).map((c) => {
        const hard = !/:soft$/i.test(c);
        const body = c.replace(/:(hard|soft)$/i, '');
        const eq = body.indexOf('=');
        const key = eq < 0 ? body.trim() : body.slice(0, eq).trim();
        const value = eq < 0 ? '' : body.slice(eq + 1).trim();
        return { key, value, hard, templated: /^\$\{input\.[A-Za-z0-9_]+\}$/.test(value) };
      });

      const has = (z      , key        , value        ) => z.tags.some((t) => t.key.toLowerCase() === key.toLowerCase() && t.value.toLowerCase() === value.toLowerCase());

      // Constraints no zone can satisfy.
      for (const c of constraints) {
        const cat = catOf(c.key);
        if (!cat) {
          findings.push(warning('vcfa91.tags.constraint-category', `The constraint on ${c.key} names a category not in the standard.`, { source: SRC }));
          continue;
        }
        if (cat.multiple) {
          findings.push(
            warning('vcfa91.tags.multiple-placement', `${cat.name} is a multiple-cardinality category and is used for placement.`, {
              remediation: 'A cluster can carry several values of it, so a constraint on one value matches clusters meant for another. Place on single-cardinality categories (Environment, Tier) and keep multiple ones for reporting.',
              source: SRC,
            }),
          );
        }
        const candidates = c.templated ? cat.values : [c.value];
        for (const v of candidates) {
          if (!zones.some((z) => has(z, c.key, v))) {
            const msg = c.templated ? `A request with ${c.key}=${v} (an allowed input value) matches no cloud zone.` : `The constraint ${c.key}=${v} matches no cloud zone.`;
            const extra = { remediation: c.templated ? `Remove ${v} from the input’s allowed values, or tag a zone with it.` : 'Tag a zone with it, or fix the constraint.', source: SRC };
            findings.push(c.hard && !c.templated ? error('vcfa91.tags.unsatisfiable', msg, extra) : c.hard ? warning('vcfa91.tags.unserved-value', msg, extra) : info('vcfa91.tags.soft-unmatched', `${msg} It is soft, so placement falls back silently.`, extra));
          }
        }
      }
      // All literal hard constraints together.
      const literalHard = constraints.filter((c) => c.hard && !c.templated && c.value);
      if (literalHard.length > 1 && !zones.some((z) => literalHard.every((c) => has(z, c.key, c.value)))) {
        findings.push(error('vcfa91.tags.unsatisfiable-together', `No single zone has all of ${literalHard.map((c) => `${c.key}=${c.value}`).join(', ')}.`, { remediation: 'Hard constraints must all be met by one zone.', source: SRC }));
      }

      const tagText = (k        , v        ) => `${norm(keyOf(k))}:${norm(valueOf(k, v))}`;
      const placementCats = [...new Set(constraints.filter((c) => c.templated).map((c) => c.key))].map((k) => catOf(k)).filter((c)                => c !== undefined);
      const inputName = (c            ) => (c.templated ? c.value.replace(/^\$\{input\.|\}$/g, '') : '');

      // A templated constraint value: the input as the requester picked it (the
      // standard's exact spelling), lower-cased in the expression when the
      // capability tags are lower-case.
      const constraintValue = (c            ) => (c.templated ? (lower ? `\${to_lower(input.${inputName(c)})}` : c.value) : lower ? norm(c.value) : valueOf(c.key, c.value));
      const snippet = [
        '# Paste into a VM Apps cloud template (formatVersion 1).',
        '# The inputs offer only the values the tag standard allows, spelt exactly as the',
        '# standard spells them, so a request cannot ask for a tag no zone has.',
        'inputs:',
        ...constraints.filter((c) => c.templated).flatMap((c) => {
          const cat = catOf(c.key);
          return [`  ${inputName(c)}:`, '    type: string', `    title: ${cat?.name ?? c.key}`, '    enum:', ...(cat?.values ?? []).map((v) => `      - ${q(v)}`)];
        }),
        'resources:',
        '  machine:',
        '    type: Cloud.vSphere.Machine',
        '    properties:',
        `      # Placement: hard must match, soft is preferred. Matched against the zones' capability tags${lower ? ', which are lower-case: to_lower() makes the request match them' : ', in the same case'}.`,
        '      constraints:',
        ...constraints.map((c) => `        - tag: ${q(`${norm(c.key)}:${constraintValue(c)}${c.hard ? '' : ':soft'}`)}`),
        '      # Resource tags: stamped on the deployed VM and, on vSphere, written to vCenter',
        '      # as tags — key as the category, value as the tag. So they use the tag',
        '      # standard’s exact case: "environment" next to "Environment" would be a',
        '      # second category in vCenter, and half the estate would be tagged in each.',
        '      tags:',
        ...standard.filter((c) => !c.multiple).map((c) => {
          const con = constraints.find((x) => x.key.toLowerCase() === c.name.toLowerCase() && x.templated);
          return `        - key: ${q(c.name)}\n          value: ${q(con ? con.value : `<REQUIRED — one of ${c.values.join(', ')}>`)}`;
        }),
        '',
      ].join('\n');

      const csv = [
        'vcenter_category,cardinality,vcenter_value,capability_tag,resource_tag,used_for_placement',
        ...standard.flatMap((c) => c.values.map((v) => `${JSON.stringify(c.name)},${c.multiple ? 'MULTIPLE' : 'SINGLE'},${JSON.stringify(v)},${JSON.stringify(tagText(c.name, v))},${JSON.stringify(`${c.name}:${v}`)},${placementCats.includes(c) || constraints.some((x) => x.key.toLowerCase() === c.name.toLowerCase()) ? 'yes' : 'no'}`)),
        '',
      ].join('\n');

      const zoneJson = json(zones.map((z) => ({ zone: z.name, tags: z.tags.map((t) => ({ key: norm(keyOf(t.key)), value: norm(valueOf(t.key, t.value)) })) })));

      const required = constraints.filter((c) => c.hard).flatMap((c) => {
        const cat = catOf(c.key);
        return (c.templated ? cat?.values ?? [] : [c.value]).map((v) => tagText(c.key, v));
      });

      const check = restScript({
        purpose: 'Check that every tag a hard template constraint can ask for is carried by at least one cloud zone.',
        scope: 'tenant',
        act: false,
        body: [
          `REQUIRED=(${required.map(q).join(' ')})`,
          "Z=$(get '/iaas/api/zones?$top=500' application/json)",
          'echo "Cloud zones and their capability tags:"',
          "jq -r '.content[] | \"  \\(.name): \\([.tags[]? | \"\\(.key):\\(.value)\"] | join(\", \"))\"' <<<\"$Z\"",
          'PROBLEMS=0',
          'for t in "${REQUIRED[@]}"; do',
          '  k="${t%%:*}"; v="${t#*:}"',
          "  jq -e --arg k \"$k\" --arg v \"$v\" '[.content[] | select(any(.tags[]?; .key == $k and .value == $v))] | length > 0' <<<\"$Z\" >/dev/null \\",
          '    || { echo "NO ZONE carries ${t} — requests asking for it will fail placement"; PROBLEMS=$((PROBLEMS+1)); }',
          'done',
          'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
        ],
      });

      const apply = restScript({
        purpose: 'Add the capability tags in zone-tags.json to each cloud zone, keeping the tags it already has.',
        scope: 'tenant',
        act: true,
        body: [
          'HERE=$(cd "$(dirname "$0")" && pwd)',
          '# The update sends the whole zone, not only its tags: the zone update',
          '# (ZoneSpecification) requires name and regionId on older IaaS API releases,',
          '# and a body with tags alone is refused there or, worse, clears other fields.',
          '# VERIFY: the IaaS API reference documents PATCH /iaas/api/zones/{id}; set',
          '# VCFA_ZONE_METHOD=PUT if your release documents PUT for it instead.',
          'ZONE_METHOD="${VCFA_ZONE_METHOD:-PATCH}"',
          "Z=$(get '/iaas/api/zones?$top=500' application/json)",
          'COUNT=$(jq length "$HERE/zone-tags.json")',
          'for i in $(seq 0 $((COUNT-1))); do',
          "  NAME=$(jq -r --argjson i \"$i\" '.[$i].zone' \"$HERE/zone-tags.json\")",
          "  ID=$(jq -r --arg n \"$NAME\" '[.content[] | select(.name == $n)] | if length == 1 then .[0].id else empty end' <<<\"$Z\")",
          '  [[ -n "$ID" ]] || { echo "Zone \\"$NAME\\": not found, or more than one — skipped" >&2; continue; }',
          '  # The zone as it is now, read fresh, is both the base of the update and the undo.',
          '  CUR=$(get "/iaas/api/zones/${ID}" application/json)',
          "  REGION=$(jq -r '.regionId // ((._links.region.href // \"\") | split(\"/\") | last) // empty' <<<\"$CUR\")",
          '  [[ -n "$REGION" ]] || { echo "Zone ${NAME}: GET /iaas/api/zones/${ID} shows no region id; skipped rather than sending a zone without one" >&2; continue; }',
          '  # Union of what is there and what the standard says: nothing is removed.',
          "  jq --arg r \"$REGION\" --argjson i \"$i\" --slurpfile want \"$HERE/zone-tags.json\" \\",
          "    '{name, description, regionId: $r, placementPolicy, folder, customProperties, tagsToMatch,",
          "      tags: (((.tags // []) + $want[0][$i].tags) | unique_by(.key + \":\" + (.value // \"\")))} | with_entries(select(.value != null))' \\",
          '    <<<"$CUR" > "$HERE/.zone-$i.json"',
          "  ADDED=$(jq -r --argjson cur \"$CUR\" '[.tags[] | \"\\(.key):\\(.value // \"\")\"] - [$cur.tags[]? | \"\\(.key):\\(.value // \"\")\"] | join(\", \")' \"$HERE/.zone-$i.json\")",
          '  echo "Zone ${NAME}: adding ${ADDED:-nothing}"',
          '  [[ -n "$ADDED" ]] || continue',
          '  # The diff of the zone as sent: only tags lines should change.',
          "  zone_lines() { jq -r '({name, description, placementPolicy, folder, customProperties, tagsToMatch} | tojson), ((.tags // []) | sort_by(.key, .value)[] | \"tag \\(.key):\\(.value // \"\")\")'; }",
          "  diff <(zone_lines <<<\"$CUR\") <(zone_lines < \"$HERE/.zone-$i.json\") | grep '^[<>]' | sed 's/^/    /' || true",
          '  if (( ! DRY_RUN )); then',
          '    BACKUP="$HERE/zone-before-${ID}-$(date -u +%Y%m%dT%H%M%SZ).json"',
          '    printf \'%s\\n\' "$CUR" > "$BACKUP"',
          '    echo "  previous zone saved to ${BACKUP}"',
          '  fi',
          '  send "$ZONE_METHOD" "/iaas/api/zones/${ID}" "$HERE/.zone-$i.json" application/json',
          'done',
          'rm -f "$HERE"/.zone-*.json',
        ],
        undo: 'Each changed zone was saved first to zone-before-<id>-<time>.json. Send its tags back the same way (the same fields, tags from the saved file) to remove what was added.',
      });

      return {
        platform: PLATFORM,
        title: `Tag placement from a ${standard.length}-category standard across ${zones.length} zone(s)`,
        effect: writeZones ? 'reversible' : 'read',
        trigger: { kind: 'manual', detail: 'When the tag standard changes, a zone is added, or a template is written: regenerate and re-run the check.' },
        scope: {
          what: writeZones ? `Capability tags on ${zones.length} cloud zone(s), added and never removed; template snippets for copying.` : 'Nothing is changed; snippets and a check.',
          decidedBy: ['The zone names, matched exactly — one match or the zone is skipped.', 'The tag standard: only its categories and values are written.', 'The organization the token belongs to.'],
          ifWrong: 'A capability tag on the wrong zone lets production requests land on it: placement is by tag, not by name, and it is silent.',
        },
        guardrails: writeZones
          ? [
              { rule: 'Tags are added to what the zone has, never replaced', because: 'Replacing a zone’s tags drops the ones other templates rely on, and their next request fails placement.' },
              { rule: 'A zone name must match exactly one zone, or it is skipped', because: 'Two zones called "Production" is how production tags end up on the lab.' },
              { rule: 'Dry run by default, printing each tag it would add and the diff of the zone it would send', because: 'The diff is small and readable, so it gets read — and it shows nothing but tags changes.' },
              { rule: 'Reads the zone fresh and sends it whole (name, regionId and every other field), saving the previous zone first', because: 'A body with only tags is refused by releases that require name and regionId, or resets fields it leaves out; the saved copy is the undo.' },
            ]
          : [],
        dryRun: [writeZones ? 'apply-zone-tags.sh without --execute prints, per zone, the tags it would add.' : 'Nothing here acts.', 'check-tags.sh reads only and exits 1 if a hard constraint can ask for a tag no zone has.'],
        undo: ['Each zone is saved to zone-before-<id>-<time>.json before it is changed; send that zone back (its tags, with name and regionId) to remove what was added. The dry run lists the tags per zone. Deployments already placed stay where they are.'],
        told: ['VCF Automation audit of the zone change.', 'check-tags.sh output, which can run on a schedule and fail when someone untags a zone.'],
        requires: ['A VM Apps organization with cloud zones, and an organization token (see "API tokens").', 'The vCenter tag standard, with cardinality, as it is actually configured.'],
        files: {
          'zone-tags.json': zoneJson,
          'template-constraints.yaml': snippet,
          'tag-mapping.csv': csv,
          'check-tags.sh': check,
          ...(writeZones ? { 'apply-zone-tags.sh': apply } : {}),
        },
        notes: [
          'Three kinds of tag (drpranayjha.com, VCF Automation 9 series part 13): capability tags say what a zone, compute, network or storage profile offers; constraint tags in a template say what a request needs (hard by default, :soft to prefer, ! to exclude); resource tags are stamped on what is deployed.',
          'vCenter tags on clusters are collected as key:value on the compute and can be matched by a cloud zone’s tag filter directly, so the vCenter category and the VCF Automation key should be the same word, in the same case. tag-mapping.csv is that table.',
          'Resource tags on a vSphere machine are written to vCenter as tags: the key becomes the category and the value the tag (the Assembler tagging tutorial shows a deployed machine’s tags appearing on the VM in vCenter). That is why template-constraints.yaml writes resource tags with the standard’s exact case whatever the capability-tag case: environment:production would create a category "environment" beside "Environment". VERIFY on your release: whether an existing category is matched by exact name, and the cardinality VCF Automation gives a category it creates — a key matching a single-cardinality category cannot take a second value.',
          lower
            ? 'Capability and constraint tags are lower-case here; the template lower-cases the requester’s choice with to_lower() so it matches. VERIFY that your release has to_lower() in cloud template expressions, and how it compares tag case, before relying on it.'
            : 'Capability, constraint and resource tags all use the standard’s exact case, so one spelling runs from vCenter through placement to the deployed VM.',
          'The zone update sends the whole zone read fresh from GET /iaas/api/zones/{id}, with regionId taken from the zone (or its region link). VERIFY: the method — PATCH is what the IaaS API reference lists for updating a zone; VCFA_ZONE_METHOD=PUT switches it.',
          'Capability tags and cloud zones belong to VM Apps organizations. All Apps organizations place by region, zone and namespace class; the resource tags still apply to what they deploy.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_blueprint_versions',
    platform: PLATFORM,
    label: 'Template versions, release, and moving a template between organizations',
    group: 'VCF Automation 9.1 — catalogue',
    description:
      'The lifecycle of a cloud template (a "blueprint" in the API) in VCF Automation 9: export it with its versions, create a new version with a change log, release it so the catalogue offers it, and import it into another organization’s project — refusing duplicates at each step. Flags the templates that cannot move between VM Apps and All Apps organizations.',
    inputs: [
      { id: 'template_name', label: 'Template', control: 'text', default: 'Standard Linux server' },
      { id: 'version', label: 'New version', control: 'text', default: '1.4.0' },
      { id: 'change_log', label: 'Change log', control: 'text', default: 'Pin image to rhel9-2026-09; lease 60 days' },
      { id: 'release', label: 'Release it to the catalogue', control: 'toggle', default: true },
      { id: 'import_to', label: 'Also import into organization', control: 'text', default: '', placeholder: 'team-b', hint: 'Empty: no import' },
      {
        id: 'source_type',
        label: 'Source organization is',
        control: 'select',
        options: [
          { value: 'vm-apps', label: 'VM Apps' },
          { value: 'all-apps', label: 'All Apps' },
        ],
        default: 'vm-apps',
      },
      {
        id: 'target_type',
        label: 'Target organization is',
        control: 'select',
        options: [
          { value: 'vm-apps', label: 'VM Apps' },
          { value: 'all-apps', label: 'All Apps' },
        ],
        default: 'vm-apps',
        showWhen: { input: 'import_to', notEquals: [''] },
      },
    ],
    automation: (values                 , name        )             => {
      const tpl = str(values, 'template_name', 'Template');
      const version = str(values, 'version', '1.0.0');
      const changeLog = str(values, 'change_log', '');
      const release = bool(values, 'release', true);
      const target = str(values, 'import_to', '');
      const srcType = str(values, 'source_type', 'vm-apps');
      const tgtType = str(values, 'target_type', 'vm-apps');
      const base = slugOf(tpl, 'template');
      void name;

      const findings            = [];
      if (!/^\d+\.\d+(\.\d+)?$/.test(version)) findings.push(warning('vcfa91.bp.version', `"${version}" is not a numeric version.`, { remediation: 'Versions sort as strings in some views; 1.10 lands before 1.9. Use major.minor.patch.', source: SRC }));
      if (!changeLog) findings.push(warning('vcfa91.bp.no-changelog', 'No change log: the next person cannot tell what this version changed.', { source: SRC }));
      if (target && srcType !== tgtType) {
        findings.push(
          warning('vcfa91.bp.cross-type', `Moving a template from a ${srcType === 'vm-apps' ? 'VM Apps' : 'All Apps'} to a${tgtType === 'all-apps' ? 'n All Apps' : ' VM Apps'} organization.`, {
            remediation: 'VM Apps templates use Cloud.vSphere.* / Cloud.NSX.* resources placed through cloud zones; All Apps templates use CCI / Supervisor resources (VirtualMachine, namespaces, VKS). The import will be accepted and fail at request time. Rewrite the resources for the target.',
            source: SRC,
          }),
        );
      }
      if (target && !LABEL.test(target)) findings.push(warning('vcfa91.bp.target', `"${target}" does not look like an organization login name.`, { source: SRC }));

      const versionPayload = { version, description: `Generated by ArchToolKit. ${changeLog}`.trim(), changeLog, release };

      const exportScript = restScript({
        purpose: `Export template "${tpl}" and its version list from the organization in VCFA_ORG.`,
        scope: 'tenant',
        act: false,
        body: [
          `NAME=${q(tpl)}`,
          'HERE=$(cd "$(dirname "$0")" && pwd); mkdir -p "$HERE/export"',
          '# The name filter is loose; the exact match is done here.',
          "B=$(get \"/blueprint/api/blueprints?name=$(jq -rn --arg n \"$NAME\" '$n|@uri')&size=100\" application/json)",
          "MATCH=$(jq --arg n \"$NAME\" '[.content[] | select(.name == $n)]' <<<\"$B\")",
          "case $(jq length <<<\"$MATCH\") in 1) ;; 0) echo \"No template named \\\"$NAME\\\"\"; exit 1;; *) echo \"More than one template named \\\"$NAME\\\" — export by id instead\"; exit 1;; esac",
          "ID=$(jq -r '.[0].id' <<<\"$MATCH\")",
          'get "/blueprint/api/blueprints/${ID}" application/json > "$HERE/export/' + base + '.json"',
          "jq -r '.content' \"$HERE/export/" + base + ".json\" > \"$HERE/export/" + base + ".yaml\"",
          'get "/blueprint/api/blueprints/${ID}/versions?size=100" application/json > "$HERE/export/' + base + '-versions.json"',
          'echo "Exported ${NAME} (${ID}) to export/' + base + '.yaml"',
          "jq -r '.content[]? | \"  \\(.version)\\t\\(.status // \"\")\\t\\(.createdAt // \"\")\"' \"$HERE/export/" + base + "-versions.json\"",
        ],
      });

      const versionScript = restScript({
        purpose: `Create version ${version} of "${tpl}"${release ? ' and release it' : ''}, unless that version already exists.`,
        scope: 'tenant',
        act: true,
        body: [
          `NAME=${q(tpl)}; VERSION=${q(version)}`,
          'HERE=$(cd "$(dirname "$0")" && pwd)',
          "B=$(get \"/blueprint/api/blueprints?name=$(jq -rn --arg n \"$NAME\" '$n|@uri')&size=100\" application/json)",
          "ID=$(jq -r --arg n \"$NAME\" '[.content[] | select(.name == $n)] | if length == 1 then .[0].id else empty end' <<<\"$B\")",
          '[[ -n "$ID" ]] || { echo "Template \\"$NAME\\" not found, or not unique" >&2; exit 2; }',
          'V=$(get "/blueprint/api/blueprints/${ID}/versions?size=200" application/json)',
          "if jq -e --arg v \"$VERSION\" 'any(.content[]?; .version == $v)' <<<\"$V\" >/dev/null; then",
          '  echo "Version ${VERSION} already exists — versions are immutable; pick the next number." >&2; exit 2',
          'fi',
          "echo \"Current versions: $(jq -r '[.content[]?.version] | join(\", \")' <<<\"$V\")\"",
          `send POST "/blueprint/api/blueprints/\${ID}/versions" "$HERE/${base}-version.json" application/json`,
          ...(release ? ['# release: true in the payload releases it. Content sources that import this template pick it up at their next sync.'] : ['echo "Not released: the catalogue still offers the previous released version."']),
        ],
        undo: 'Unrelease: POST /blueprint/api/blueprints/{id}/versions/{version}/actions/unrelease. A version cannot be deleted while deployments use it.',
      });

      const importScript = restScript({
        purpose: `Import export/${base}.yaml into a project of organization ${target || '<target>'}, unless a template of that name is already there.`,
        scope: 'tenant',
        act: true,
        body: [
          `NAME=${q(tpl)}`,
          ...(target ? [`[[ "$VCFA_ORG" == ${q(target)} ]] || { echo "VCFA_ORG is $VCFA_ORG; this import is for ${target}. Use that organization's token file." >&2; exit 2; }`] : []),
          ': "${TARGET_PROJECT_ID:?set TARGET_PROJECT_ID — GET /iaas/api/projects in the target organization}"',
          'HERE=$(cd "$(dirname "$0")" && pwd)',
          `[[ -f "$HERE/export/${base}.yaml" ]] || { echo "Run export-template.sh against the source organization first" >&2; exit 2; }`,
          "B=$(get \"/blueprint/api/blueprints?name=$(jq -rn --arg n \"$NAME\" '$n|@uri')&size=100\" application/json)",
          "if jq -e --arg n \"$NAME\" 'any(.content[]; .name == $n)' <<<\"$B\" >/dev/null; then",
          '  echo "A template named \\"$NAME\\" already exists in $VCFA_ORG — add a version there instead of a second copy." >&2; exit 2',
          'fi',
          `jq -n --arg n "$NAME" --arg p "$TARGET_PROJECT_ID" --rawfile c "$HERE/export/${base}.yaml" \\`,
          "  '{name: $n, description: \"Imported by ArchToolKit\", projectId: $p, requestScopeOrg: false, content: $c}' > \"$HERE/.import.json\"",
          'send POST /blueprint/api/blueprints "$HERE/.import.json" application/json',
          'rm -f "$HERE/.import.json"',
          'echo "Imported as a draft. Test it in the target, then create and release a version there."',
        ],
        undo: 'DELETE /blueprint/api/blueprints/{id} in the target organization, while it has no deployments.',
      });

      return {
        platform: PLATFORM,
        title: `Template "${tpl}" version ${version}${target ? `, imported into ${target}` : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'A template author finishing a change, or a platform team promoting a template from a build organization to a consuming one.' },
        scope: {
          what: `The template "${tpl}" in the source organization${target ? `, and a new draft copy in a project of ${target}` : ''}.`,
          decidedBy: ['The organization in VCFA_ORG and its token.', 'The template name, matched exactly and required to be unique.', release ? 'Every project and content source that imports released versions of it.' : 'Nobody else: the version is unreleased.'],
          ifWrong: 'A released version goes to every catalogue that imports the template, at the next sync — a bad release is a catalogue-wide change.',
        },
        guardrails: [
          { rule: 'Refuses a version number that already exists', because: 'Versions are the audit trail; reusing one hides what changed.' },
          { rule: 'Name must match exactly one template, or it stops', because: 'Two templates with the same name in different projects is common; versioning the wrong one releases it.' },
          ...(target ? [{ rule: `Import refuses when VCFA_ORG is not ${target} or the name already exists there`, because: 'An import with the wrong token lands in the source organization as a duplicate.' }] : []),
          { rule: 'Dry run by default', because: 'The script reads first and says what it would post.' },
        ],
        dryRun: ['export-template.sh reads only.', 'version-template.sh and import-template.sh without --execute look everything up and stop before posting.'],
        undo: ['Unrelease the version (POST …/versions/{version}/actions/unrelease). Deployments made from it keep their version.', ...(target ? ['Delete the imported draft in the target.'] : [])],
        told: ['The template’s version history in the design canvas.', 'Catalogue item change in Service Broker at the next content source sync.'],
        requires: ['An organization token for the source (and one for the target) — see "API tokens".', 'The template already exists in the source organization.'],
        files: {
          'export-template.sh': exportScript,
          [`${base}-version.json`]: json(versionPayload),
          'version-template.sh': versionScript,
          ...(target ? { 'import-template.sh': importScript } : {}),
        },
        notes: [
          'Paths are the /blueprint/api carried from Aria Automation 8.x: GET /blueprint/api/blueprints, GET/POST /blueprint/api/blueprints/{id}/versions ({version, description, changeLog, release}). VERIFY they answer under a 9.x tenant token for your organization type.',
          'The catalogue shows released versions only; the requester picks among them unless the content source is set to the latest.',
          'In All Apps organizations templates are written in formatVersion 2 with CCI resource types. They are the same service underneath but not the same resource vocabulary as VM Apps.',
          'Export keeps the YAML, not the project, custom forms or property group ids; re-create those in the target.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_namespace_day2',
    platform: PLATFORM,
    label: 'Change a namespace after it exists: limits, VM classes, storage, shared subnets',
    group: 'VCF Automation 9.1 — consumption',
    description:
      'Day-2 on a Supervisor namespace, new in 9.1: raise or lower its CPU and memory limits in a zone, add VM classes or storage classes, attach organization shared subnets. Saves the namespace as it was before touching it, validates the change server-side, and only then applies.',
    inputs: [
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'team-a-dev-x7k2p' },
      { id: 'zone', label: 'Zone', control: 'text', default: 'zone-a' },
      { id: 'cpu_limit_mhz', label: 'New CPU limit (MHz)', control: 'number', default: 30000, min: 0, max: 100000000, hint: '0 leaves it' },
      { id: 'memory_limit_mib', label: 'New memory limit (MiB)', control: 'number', default: 98304, min: 0, max: 1000000000, hint: '0 leaves it' },
      { id: 'vm_classes', label: 'VM classes to allow', control: 'text', default: '', placeholder: 'best-effort-large', hint: 'Empty leaves them' },
      { id: 'storage_class', label: 'Storage class to set', control: 'text', default: '', placeholder: 'vsan-default-storage-policy' },
      { id: 'storage_limit_gib', label: 'Its limit (GiB)', control: 'number', default: 0, min: 0, max: 10000000, showWhen: { input: 'storage_class', notEquals: [''] } },
      { id: 'shared_subnets', label: 'Shared subnets to attach', control: 'text', default: '', placeholder: 'shared-mgmt' },
    ],
    automation: (values                 , name        )             => {
      const ns = str(values, 'namespace', 'team-a');
      const zone = str(values, 'zone', 'zone-a');
      const cpu = num(values, 'cpu_limit_mhz', 0);
      const mem = num(values, 'memory_limit_mib', 0);
      const classes = listOf(str(values, 'vm_classes', ''));
      const sc = str(values, 'storage_class', '');
      const scGib = num(values, 'storage_limit_gib', 0);
      const subnets = listOf(str(values, 'shared_subnets', ''));
      void name;

      const findings            = [];
      const changes = (cpu > 0 || mem > 0 ? 1 : 0) + (classes.length ? 1 : 0) + (sc ? 1 : 0) + (subnets.length ? 1 : 0);
      if (changes === 0) findings.push(error('vcfa91.nsday2.nothing', 'Nothing is being changed.', { source: SRC }));
      if (sc && scGib === 0) findings.push(warning('vcfa91.nsday2.sc-unlimited', `Storage class ${sc} is added with no limit.`, { source: SRC }));
      findings.push(info('vcfa91.nsday2.fields', 'The patch field names follow the Terraform vcfa_supervisor_namespace overrides. VERIFY with kubectl explain supervisornamespace.spec — the server-side dry run rejects unknown fields.', { source: SRC }));

      const patch = {
        spec: {
          initialClassConfigOverrides: {
            ...(cpu > 0 || mem > 0 ? { zones: [{ name: zone, ...(cpu > 0 ? { cpuLimit: `${cpu}M` } : {}), ...(mem > 0 ? { memoryLimit: `${mem}Mi` } : {}) }] } : {}),
            ...(classes.length ? { vmClasses: classes.map((c) => ({ name: c })) } : {}),
            ...(sc ? { storageClasses: [{ name: sc, ...(scGib > 0 ? { limit: `${scGib}Gi` } : {}) }] } : {}),
          },
          ...(subnets.length ? { sharedSubnetNames: subnets } : {}),
        },
      };

      const script = [
        '#!/usr/bin/env bash',
        `# Change namespace ${ns}: saves it first, server-side dry run unless --execute.`,
        'set -euo pipefail',
        'command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }',
        ': "${EXPECT_CONTEXT:?set EXPECT_CONTEXT to the organization/project context that owns the namespace}"',
        '[[ "$(kubectl config current-context)" == "$EXPECT_CONTEXT" ]] || { echo "Wrong context: $(kubectl config current-context)" >&2; exit 2; }',
        `NS=${q(ns)}`,
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        'STAMP=$(date +%Y%m%d-%H%M%S)',
        '# VERIFY the resource name: kubectl api-resources | grep -i supervisornamespace',
        'kubectl get supervisornamespace "$NS" -o yaml > "$HERE/before-${NS}-${STAMP}.yaml" || { echo "Could not read $NS — not changing what could not be saved" >&2; exit 2; }',
        'echo "Saved the current namespace to before-${NS}-${STAMP}.yaml"',
        'kubectl patch supervisornamespace "$NS" --type merge --patch-file "$HERE/patch.json" --dry-run=server -o yaml > /dev/null',
        'echo "Server-side dry run passed."',
        'if [[ " $* " != *" --execute "* ]]; then echo "Nothing changed. Re-run with --execute."; exit 0; fi',
        'kubectl patch supervisornamespace "$NS" --type merge --patch-file "$HERE/patch.json"',
        '',
        '# Undo: kubectl replace -f before-<namespace>-<stamp>.yaml (after removing status and resourceVersion), or patch the old values back.',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Day-2 change to namespace ${ns}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'A project team that has outgrown its namespace, or an administrator tightening one.' },
        scope: {
          what: `Namespace ${ns}: ${[cpu || mem ? `limits in ${zone}` : '', classes.length ? `VM classes ${classes.join(', ')}` : '', sc ? `storage class ${sc}` : '', subnets.length ? `shared subnets ${subnets.join(', ')}` : ''].filter(Boolean).join('; ') || 'nothing'}.`,
          decidedBy: ['The namespace named, in the checked context.', 'The organization’s region quota, which a raised limit must still fit in.', 'The namespace class, which bounds what a day-2 change may ask for (VERIFY on your release).'],
          ifWrong: 'A lowered limit below current use leaves running workloads unable to restart; a shared subnet attached to the wrong namespace joins it to another network.',
        },
        guardrails: [
          { rule: 'The namespace is saved to a file before any change, or nothing happens', because: 'The previous limits are the undo, and nobody remembers them.' },
          { rule: 'Server-side dry run every time, before the real patch', because: 'Quota and class checks happen on the server; a typo in a field name fails here rather than half-applying.' },
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'Namespace names are unique only within an organization.' },
        ],
        dryRun: ['change-namespace.sh without --execute: saves the namespace and runs the dry run.'],
        undo: ['Apply the saved before-*.yaml, or patch the old values back.'],
        told: ['vCenter events for the namespace limit change.', 'Kubernetes events on the SupervisorNamespace.'],
        requires: ['VCF Automation 9.1 (namespace day-2 changes are new in 9.1).', 'Rights to edit namespaces in the project.'],
        files: { 'patch.json': json(patch), 'change-namespace.sh': script },
        notes: ['9.1 what’s new: application teams can change resource limits, VM classes, storage classes and shared subnets on existing namespaces.', 'The existing "A Supervisor namespace, requested from All Apps" blueprint creates namespaces; this one changes them.'],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_argocd',
    platform: PLATFORM,
    label: 'Argo CD for a namespace, and an application it syncs',
    group: 'VCF Automation 9.1 — consumption',
    description:
      'GitOps on VCF: an Argo CD instance in a vSphere namespace (the Argo CD Supervisor Service, or 9.1.1’s Argo CD as a VCF Service in tech preview) and an Application that syncs a Git path into a namespace or a VKS cluster, with automatic sync off unless asked for.',
    inputs: [
      {
        id: 'mode',
        label: 'Installed as',
        control: 'select',
        options: [
          { value: 'supervisor', label: 'Argo CD Supervisor Service' },
          { value: 'vcf-service', label: 'Argo CD as a VCF Service (9.1.1, tech preview)' },
        ],
        default: 'supervisor',
      },
      { id: 'instance', label: 'Instance name', control: 'text', default: 'argocd' },
      { id: 'namespace', label: 'Namespace for Argo CD', control: 'text', default: 'team-a-gitops-k3v9s' },
      { id: 'version', label: 'Argo CD version', control: 'text', default: '3.0.19+vmware.1-vks.1', hint: 'X.Y.Z+vmware.W-vks.V' },
      { id: 'app_name', label: 'Application', control: 'text', default: 'orders' },
      { id: 'repo_url', label: 'Git repository', control: 'text', default: 'https://git.example.com/team-a/orders-deploy.git' },
      { id: 'repo_path', label: 'Path', control: 'text', default: 'overlays/prod' },
      { id: 'revision', label: 'Revision', control: 'text', default: 'main' },
      { id: 'destination', label: 'Deploy to cluster', control: 'text', default: 'team-a-prod-01', hint: 'As added with argocd cluster add' },
      { id: 'dest_namespace', label: 'Target namespace in it', control: 'text', default: 'orders' },
      { id: 'auto_sync', label: 'Sync automatically', control: 'toggle', default: false },
      { id: 'prune', label: 'Delete what is removed from Git', control: 'toggle', default: false, showWhen: { input: 'auto_sync', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const vcfService = str(values, 'mode', 'supervisor') === 'vcf-service';
      const inst = label(str(values, 'instance', 'argocd'), 'argocd');
      const ns = str(values, 'namespace', 'gitops');
      const version = str(values, 'version', '');
      const app = label(str(values, 'app_name', 'app'), 'app');
      const repo = str(values, 'repo_url', '');
      const path = str(values, 'repo_path', '.');
      const rev = str(values, 'revision', 'main');
      const dest = str(values, 'destination', 'in-cluster');
      const destNs = str(values, 'dest_namespace', 'default');
      const auto = bool(values, 'auto_sync', false);
      const prune = auto && bool(values, 'prune', false);
      void name;

      const findings            = [];
      if (!/^\d+\.\d+\.\d+\+vmware\.\d+-vks\.\d+$/.test(version)) findings.push(error('vcfa91.argo.version', `"${version}" does not match X.Y.Z+vmware.W-vks.V, which the ArgoCD resource requires.`, { remediation: 'kubectl explain argocd.spec.version shows the pattern; the service’s release notes list the versions.', source: SRC }));
      if (vcfService) findings.push(warning('vcfa91.argo.preview', 'Argo CD as a VCF Service is a tech preview in 9.1.1.', { remediation: 'Not for production. It supports up to 30 vSphere namespaces per instance.', source: 'VCF Automation 9.1.1 release notes' }));
      if (/^http:\/\//.test(repo)) findings.push(warning('vcfa91.argo.http', 'The repository is plain HTTP.', { source: SRC }));
      if (prune) findings.push(warning('vcfa91.argo.prune', 'Automatic sync with prune deletes anything removed from Git, including by a bad merge.', { remediation: 'Keep prune manual for stateful applications, or protect them with the Prune=false annotation.', source: SRC }));
      findings.push(info('vcfa91.argo.k8s-lag', 'Argo CD support for a new Kubernetes minor version lags VKS by two to four months.', { remediation: 'Check the VKS version of the target cluster is supported before upgrading it.', source: 'VCF Automation 9.1.1 release notes' }));

      const instance = [
        '# VERIFY apiVersion and spec: kubectl explain argocd.spec',
        'apiVersion: argocd-service.vsphere.vmware.com/v1alpha1',
        'kind: ArgoCD',
        'metadata:',
        `  name: ${inst}`,
        `  namespace: ${ns}`,
        'spec:',
        `  version: ${q(version)}`,
        '',
      ].join('\n');

      const application = [
        '# Apply into the Argo CD instance, after argocd login and argocd cluster add.',
        'apiVersion: argoproj.io/v1alpha1',
        'kind: Application',
        'metadata:',
        `  name: ${app}`,
        `  namespace: ${ns}`,
        'spec:',
        '  project: default',
        '  source:',
        `    repoURL: ${repo}`,
        `    path: ${path}`,
        `    targetRevision: ${rev}`,
        '  destination:',
        `    name: ${dest}`,
        `    namespace: ${destNs}`,
        '  syncPolicy:',
        ...(auto ? ['    automated:', `      prune: ${prune}`, '      selfHeal: true'] : ['    # Manual: argocd app sync ' + app + ' after reading argocd app diff ' + app]),
        '    syncOptions:',
        '      - CreateNamespace=true',
        '',
      ].join('\n');

      const install = kubeScript(`Create Argo CD instance ${inst} in ${ns}.`, [], ['argocd-instance.k8s.yaml'], `kubectl delete argocd ${inst} -n ${ns} — the Applications it manages keep running; only the controller goes.`);

      const connect = [
        '#!/usr/bin/env bash',
        `# After the instance is up: log in, change the admin password, add the target cluster, create ${app}.`,
        'set -euo pipefail',
        'command -v argocd >/dev/null || { echo "the argocd CLI is required" >&2; exit 2; }',
        `NS=${q(ns)}`,
        `SERVER=$(kubectl get svc -n "$NS" -o jsonpath='{.items[?(@.spec.type=="LoadBalancer")].status.loadBalancer.ingress[0].ip}')`,
        '[[ -n "$SERVER" ]] || { echo "No LoadBalancer address yet for Argo CD in $NS" >&2; exit 2; }',
        'echo "Argo CD at $SERVER. Log in as admin; the initial password is in the argocd-initial-admin-secret Secret:"',
        `echo "  kubectl get secret -n $NS argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"`,
        'argocd login "$SERVER" --username admin --sso=false --grpc-web',
        'echo "Change it now:"; argocd account update-password',
        `echo "Add the target cluster (its kubeconfig context must be current in kubectl: vcf cluster kubeconfig get ${dest}):"`,
        `echo "  argocd cluster add <kubeconfig-context> --name ${dest}"`,
        'if [[ " $* " == *" --execute "* ]]; then',
        '  argocd app create -f "$(dirname "$0")/application.yaml" --upsert=false',
        `  argocd app diff ${app} || true`,
        'else',
        '  echo "DRY RUN: would create the application from application.yaml. Re-run with --execute."',
        'fi',
        '',
        `# Undo: argocd app delete ${app} --cascade=false keeps what it deployed; --cascade deletes it too.`,
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Argo CD ${inst} in ${ns}, syncing ${app}`,
        effect: 'reversible',
        trigger: { kind: auto ? 'commit' : 'manual', detail: auto ? `Every commit to ${rev} under ${path} is synced to ${dest} within the refresh interval (three minutes by default).` : `A person runs argocd app sync ${app} after reading the diff.`, worstCase: auto ? 'once per refresh interval, with whatever is on the branch' : undefined },
        scope: {
          what: `Argo CD in ${ns}; the application ${app} writing to namespace ${destNs} of cluster ${dest}.`,
          decidedBy: [`The Git path ${path} at ${rev}: whatever manifests are there.`, `The credentials Argo CD holds for ${dest}, which decide what it may create there.`, 'The Argo CD project (default here), which can restrict destinations and kinds.'],
          ifWrong: 'The default project allows any destination and any kind; a manifest for the wrong namespace or a ClusterRole is applied as written.',
        },
        guardrails: [
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'The instance is created in the namespace the context points at.' },
          { rule: auto ? `Automatic sync${prune ? ' with prune' : ' without prune'}` : 'Manual sync — a person reads argocd app diff first', because: auto ? (prune ? 'Chosen: deletions in Git are deletions in the cluster.' : 'Removed resources are reported as out of sync, not deleted.') : 'A bad merge is caught at the diff rather than in production.' },
          { rule: 'The application is created only with --execute, and never upserts over an existing one', because: 'An upsert silently repoints an existing application at a different repository.' },
          { rule: 'The admin password is changed at first login', because: 'The initial password sits in a Secret anyone with read access to the namespace can decode.' },
        ],
        dryRun: ['install-argocd.sh without --execute: server-side dry run.', 'connect-and-create-app.sh without --execute logs in and stops before creating the application.'],
        undo: [`argocd app delete ${app} --cascade=false keeps the deployed resources.`, `kubectl delete argocd ${inst} -n ${ns} removes Argo CD itself.`],
        told: ['Argo CD’s own history per application, and its notifications if configured.', 'Git history, which is the record of what was deployed.'],
        requires: [vcfService ? 'VCF Automation 9.1.1 with Argo CD installed through Provider Management → Service Management.' : 'The Argo CD Supervisor Service installed on the Supervisor (1.2.0 adds auto-discovery of VKS clusters).', 'The argocd CLI, kubectl and the VCF CLI.', `Read access to ${repo || 'the repository'} for Argo CD.`],
        files: { 'argocd-instance.k8s.yaml': instance, 'application.yaml': application, 'install-argocd.sh': install, 'connect-and-create-app.sh': connect },
        notes: [
          'The ArgoCD resource and version pattern follow the VCF 9.0.2 Argo CD service example (kimjohansson.se): argocd-service.vsphere.vmware.com/v1alpha1, spec.version X.Y.Z+vmware.W-vks.V.',
          '9.1.1: Argo CD as a VCF Service authenticates with VCF Automation credentials and is deployed by organization administrators to vSphere namespaces, up to 30 per instance.',
          'For a VKS cluster, get its kubeconfig with vcf cluster kubeconfig get <cluster>, then argocd cluster add. The Supervisor Service 1.2.0 can attach VKS clusters automatically by policy.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_security_policy',
    platform: PLATFORM,
    label: 'A vDefend firewall policy for VMs in a namespace',
    group: 'VCF Automation 9.1 — networking',
    description:
      'Distributed firewall for an All Apps namespace, which 9.1 lets the provider delegate to organizations: an NSX operator SecurityPolicy that selects VMs by label, allows the flows listed and — by default — drops everything else inbound to them.',
    inputs: [
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'team-a-prod-q4m8z' },
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'web-tier' },
      { id: 'applied_to', label: 'Applies to VMs labelled', control: 'text', default: 'app=web01' },
      { id: 'rules', label: 'Allow', control: 'textarea', default: 'from 10.0.0.0/8 tcp/443\nfrom app=bastion tcp/22', hint: 'from <label=value | CIDR> <tcp|udp>/<port>, one per line' },
      { id: 'default_drop', label: 'Drop all other inbound traffic', control: 'toggle', default: true },
      { id: 'priority', label: 'Priority', control: 'number', default: 10, min: 0, max: 1000, hint: 'Lower is evaluated first' },
    ],
    automation: (values                 , name        )             => {
      const ns = str(values, 'namespace', 'team-a');
      const pol = label(str(values, 'policy_name', 'policy'), 'policy');
      const applied = str(values, 'applied_to', 'app=web');
      const drop = bool(values, 'default_drop', true);
      const priority = num(values, 'priority', 10);
      void name;

      const findings            = [];
      const kv = (s        )                         => Object.fromEntries(listOf(s).map((p) => { const [k = '', v = ''] = p.split('='); return [k.trim(), v.trim()]; }));
      const appliedLabels = kv(applied);
      if (Object.keys(appliedLabels).length === 0) findings.push(error('vcfa91.sp.no-selector', 'The policy applies to no VMs.', { source: SRC }));

      const rules = str(values, 'rules', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line, i) => {
          const m = /^from\s+(\S+)\s+(tcp|udp)\/(\d{1,5})$/i.exec(line);
          if (!m) {
            findings.push(warning('vcfa91.sp.rule', `Could not read "${line}".`, { remediation: 'from <label=value | CIDR> <tcp|udp>/<port>', source: SRC }));
            return undefined;
          }
          const [, from = '', proto = 'tcp', port = '0'] = m;
          const cidr = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(from);
          if (from === '0.0.0.0/0') findings.push(warning('vcfa91.sp.any', `Rule ${i + 1} allows ${proto}/${port} from anywhere.`, { source: SRC }));
          return { name: `allow-${proto.toLowerCase()}-${port}-${i + 1}`, from, cidr, proto: proto.toUpperCase(), port: Number(port) };
        })
        .filter((r)                             => r !== undefined);
      if (!drop) findings.push(info('vcfa91.sp.no-drop', 'Without a drop rule the allows change nothing — everything else is still allowed by the default rule.', { source: SRC }));

      const yaml = [
        '# VERIFY: kubectl explain securitypolicy.spec (crd.nsx.vmware.com). Field names follow the NSX operator v1alpha1 CRD.',
        'apiVersion: crd.nsx.vmware.com/v1alpha1',
        'kind: SecurityPolicy',
        'metadata:',
        `  name: ${pol}`,
        `  namespace: ${ns}`,
        'spec:',
        `  priority: ${priority}`,
        '  appliedTo:',
        '    - vmSelector:',
        '        matchLabels:',
        ...Object.entries(appliedLabels).map(([k, v]) => `          ${k}: ${q(v)}`),
        '  rules:',
        ...rules.flatMap((r) => [
          `    - name: ${r.name}`,
          '      direction: In',
          '      action: Allow',
          '      sources:',
          ...(r.cidr ? ['        - ipBlocks:', `            - cidr: ${r.from}`] : ['        - vmSelector:', '            matchLabels:', ...Object.entries(kv(r.from)).map(([k, v]) => `              ${k}: ${q(v)}`)]),
          '      ports:',
          `        - protocol: ${r.proto}`,
          `          port: ${r.port}`,
        ]),
        ...(drop ? ['    - name: drop-other-inbound', '      direction: In', '      action: Drop'] : []),
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Firewall policy ${pol} in ${ns}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'The application team, when the VMs are created or a flow changes.' },
        scope: {
          what: `VMs in ${ns} labelled ${applied}: inbound ${rules.map((r) => `${r.proto}/${r.port}`).join(', ') || 'nothing'} allowed${drop ? ', everything else dropped' : ''}.`,
          decidedBy: ['The label selector — every VM that has, or later gets, those labels.', 'The namespace; the policy cannot reach VMs in another.', 'Priority against other policies in the namespace and the organization.'],
          ifWrong: 'A selector that matches more than meant drops traffic to VMs nobody considered; one that matches nothing leaves them open.',
        },
        guardrails: [
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'The context is the scope.' },
          { rule: 'Server-side dry run before creating, and create rather than apply', because: 'The NSX operator validates selectors and ports; create refuses to overwrite a policy another team maintains.' },
        ],
        dryRun: ['create-policy.sh without --execute runs a server-side dry run.', 'Before --execute, kubectl get vm -n ' + ns + ' -l ' + applied.replace(/\s/g, '') + ' shows which VMs it will cover.'],
        undo: [`kubectl delete securitypolicy ${pol} -n ${ns} — traffic falls back to the default rule immediately.`],
        told: ['NSX Manager audit log, and the DFW rule hit counts in VCF Operations for Networks.'],
        requires: ['vDefend firewall delegated to the organization by the provider (9.1).', 'VMs carrying the labels.'],
        files: {
          [`${pol}.k8s.yaml`]: yaml,
          'create-policy.sh': kubeScript(`Create security policy ${pol} in ${ns}.`, [`echo "VMs it will cover:"; kubectl get vm -n ${q(ns)} -l ${q(Object.entries(appliedLabels).map(([k, v]) => `${k}=${v}`).join(','))} || true`], [`${pol}.k8s.yaml`], `kubectl delete securitypolicy ${pol} -n ${ns}`),
        },
        notes: ['9.1 what’s new: providers can delegate vDefend Distributed and Gateway Firewall to organization administrators, with RBAC labels for dynamic groups. Gateway firewall on a transit gateway is set in the organization portal.'],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_estate_check',
    platform: PLATFORM,
    label: 'A daily health check of VCF Automation 9.1 from the provider side',
    group: 'VCF Automation 9.1 — provider',
    description:
      'One read-only script a scheduler can run daily: the API version is offered, every organization is enabled, regions, region quotas and content libraries are READY, and no API token of the provider account expires soon. Exit 1 on anything worth a look; a path that moved is reported, not ignored.',
    inputs: [
      { id: 'expiry_warn_days', label: 'Token expiry warning (days)', control: 'number', default: 14, min: 1, max: 365 },
      { id: 'schedule', label: 'Run daily at 06:30', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const warn = num(values, 'expiry_warn_days', 14);
      const schedule = bool(values, 'schedule', true);
      void name;
      const script = restScript({
        purpose: 'Daily provider-side health check of VCF Automation 9.1.',
        scope: 'provider',
        act: false,
        checkVersion: true,
        body: [
          `WARN_DAYS=${warn}`,
          'PROBLEMS=0',
          'note() { echo "  ! $*"; PROBLEMS=$((PROBLEMS+1)); }',
          '',
          'echo "Organizations:"',
          "if O=$(probe '/cloudapi/1.0.0/orgs?pageSize=128'); then",
          "  jq -r '.values[] | \"  \\(.name)\\tenabled=\\(.isEnabled)\\tclassic=\\(.isClassicTenant // \"?\")\"' <<<\"$O\"",
          "  for o in $(jq -r '.values[] | select(.isEnabled == false) | .name' <<<\"$O\"); do note \"organization $o is disabled\"; done",
          'else PROBLEMS=$((PROBLEMS+1)); fi',
          '',
          'echo "Regions:"',
          "if R=$(probe '/cloudapi/vcf/regions?pageSize=128'); then",
          "  for r in $(jq -r '.values[] | select(.status != \"READY\") | \"\\(.name)=\\(.status)\"' <<<\"$R\"); do note \"region $r\"; done",
          "  echo \"  $(jq '.values | length' <<<\"$R\") region(s)\"",
          'else PROBLEMS=$((PROBLEMS+1)); fi',
          '',
          'echo "Region quotas:"',
          "if Q=$(probe '/cloudapi/1.0.0/virtualDatacenters?pageSize=128'); then",
          "  for q in $(jq -r '.values[] | select((.status // \"READY\") != \"READY\") | \"\\(.name)=\\(.status)\"' <<<\"$Q\"); do note \"quota $q\"; done",
          'else PROBLEMS=$((PROBLEMS+1)); fi',
          '',
          'echo "Content libraries:"',
          "if L=$(probe '/cloudapi/vcf/contentLibraries?pageSize=128'); then",
          "  for l in $(jq -r '.values[] | select((.status // \"READY\") != \"READY\") | \"\\(.name)=\\(.status)\"' <<<\"$L\"); do note \"library $l (subscribed library 401s are a 9.1.1 known issue)\"; done",
          'else PROBLEMS=$((PROBLEMS+1)); fi',
          '',
          'echo "API tokens of this account:"',
          "if T=$(probe '/cloudapi/1.0.0/tokens?filter=type==REFRESH&pageSize=128'); then",
          '  NOW=$(date +%s)',
          "  for t in $(jq -r --argjson now \"$NOW\" --argjson w \"$WARN_DAYS\" '.values[]? | select(.expirationDate != null) | select(((.expirationDate | sub(\"\\\\.[0-9]+\"; \"\") | sub(\"(?<z>[+-][0-9]{2}:[0-9]{2}|Z)$\"; \"Z\") | fromdateiso8601) - $now) < ($w * 86400)) | .name' <<<\"$T\"); do note \"token $t expires within ${WARN_DAYS} days\"; done",
          'else PROBLEMS=$((PROBLEMS+1)); fi',
          '',
          'echo; (( PROBLEMS == 0 )) && echo "All checks passed." || echo "${PROBLEMS} problem(s)."',
          'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
        ],
      });

      return {
        platform: PLATFORM,
        title: 'VCF Automation 9.1 provider health check',
        effect: 'read',
        trigger: { kind: schedule ? 'schedule' : 'manual', detail: schedule ? 'Daily at 06:30 from cron; the scheduler alerts on exit 1.' : 'Run by hand.' },
        scope: {
          what: 'Every organization, region, region quota and content library the provider account can see, and that account’s own API tokens. Read only.',
          decidedBy: ['The provider token’s rights — a read-only provider role is enough and is what it should be given.'],
          ifWrong: 'Nothing changes; a too-narrow token under-reports, which is why a probe that fails counts as a problem.',
        },
        guardrails: [],
        dryRun: ['It only reads.'],
        undo: ['Nothing to undo.'],
        told: [schedule ? 'The cron log and whatever alerts on the exit code.' : 'The terminal.'],
        requires: ['A provider API token for a read-only provider role, in a mode-600 file.', 'curl and jq.'],
        files: {
          'vcfa-health.sh': script,
          ...(schedule ? { 'crontab.txt': cronLine('30 6 * * *', 'VCFA_HOST=vcfa.example.com VCFA_API_TOKEN_FILE=/etc/archtoolkit/vcfa-provider-api-token', 'vcfa-health.sh', 'vcfa-health.log') } : {}),
          'what-it-checks.txt': [
            'GET /api/versions                       the API version the scripts use is offered',
            'GET /cloudapi/1.0.0/orgs                every organization enabled',
            'GET /cloudapi/vcf/regions               every region READY            (VERIFY path)',
            'GET /cloudapi/1.0.0/virtualDatacenters  every region quota READY      (VERIFY path)',
            'GET /cloudapi/vcf/contentLibraries      every library READY           (VERIFY path)',
            'GET /cloudapi/1.0.0/tokens              no own API token expiring soon (VERIFY path)',
            '',
            'A path that answers anything but 200 is printed as VERIFY and counted as a problem,',
            'so a moved API shows up the first morning rather than as a silent pass.',
            '',
          ].join('\n'),
        },
        notes: [
          '9.1.1 deprecates public cloud (AWS, Azure, GCP) resource management in VCF Automation and disables it by default. VM Apps organizations that still have public cloud accounts should be listed from each organization (GET /iaas/api/cloud-accounts) before upgrading.',
          'Paths under /cloudapi/vcf/ are inferred from the Go SDK the Terraform provider is built on.',
        ],
        findings: [],
      };
    },
  }),
];
