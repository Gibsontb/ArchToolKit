/**
 * Splunk Cloud Platform: what a Cloud customer still controls, through the
 * Admin Config Service (ACS), and the migration that gets an on-premises
 * deployment there.
 *
 * In Splunk Cloud there is no shell on the indexers and no indexes.conf to
 * edit. Indexes, HEC tokens, network access and apps are changed through ACS
 * (https://admin.splunk.com/{stack}/adminconfig/v2/...), with a JWT for a user
 * holding the sc_admin role. That token can delete every index on the stack, so
 * it is treated like the root password it is: read from a mode-600 file into a
 * private header file and sent with `curl -H @file` — never an argument, never
 * echoed, never in a generated file.
 *
 * The mistakes these blueprints look for are the Cloud-shaped ones: searchable
 * retention above what the contract pays for (an overage nobody notices until
 * the invoice), indexes with no archive (data deleted on the day it ages out),
 * HEC tokens allowed to write anywhere, allow lists left at 0.0.0.0/0 or filled
 * with private addresses Splunk Cloud never sees, and apps uploaded without the
 * AppInspect cloud checks they will be held to anyway.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { splunkBlueprint,                      } from '../from-app.js';
import { listOf, splunkName,                } from '../splunk.js';
import { containsAny, familyOf, parseCidrAny,             } from '../../core/ip.js';
import { parseIPv4 } from '../../core/net.js';

const TIER = 'cloud'         ;

// --- helpers ---------------------------------------------------------------

/**
 * A shell script as a template, with bash's own `${...}` written `\${...}`.
 * String.raw keeps `\n` in a printf as `\n`; only `${` needs escaping.
 */
export function script(strings                      , ...values           )           {
  return String.raw(strings, ...values)
    .replace(/\\\$\{/g, '${')
    .replace(/^\n/, '')
    .replace(/\n$/, '')
    .split('\n');
}

/** A value safe inside bash single quotes. */
export function shq(value        )         {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Lines of a textarea, with comments and blanks dropped. */
export function rows(value        )           {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** A Splunk Cloud stack name: the part before .splunkcloud.com. */
export function stackOf(values                 )         {
  return str(values, 'stack', 'example-stack')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.splunkcloud\.com.*$/, '')
    .trim();
}

export function stackFindings(stack        )            {
  return /^[a-z0-9][a-z0-9-]*$/.test(stack)
    ? []
    : [error('splunk.acs-bad-stack', `"${stack}" is not a stack name. It is the first label of the stack URL: for https://acme-prod.splunkcloud.com the stack is acme-prod.`, { source: 'ArchToolKit' })];
}

/** Index names Splunk accepts: lower case, digits, _ and -, not starting with _ or -. */
export const INDEX_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * A parsed IPv4 or IPv6 CIDR, or why it is not one. ACS keeps the two families
 * in separate lists (ipallowlists and ipallowlists-v6), so the family decides
 * which list an entry goes to.
 */
                
                        
                       
                            
                           
                            
                           
                              
 

function parseCidr(text        )       {
  const t = text.trim();
  const [ip = '', bits, extra] = t.split('/');
  if (extra !== undefined) return { text: t, ok: false, problem: 'not a CIDR' };
  const family = familyOf(ip);
  if (family === null) return { text: t, ok: false, problem: 'not an IPv4 or IPv6 address' };
  const max = family === 6 ? 128 : 32;
  if (bits === undefined) return { text: t, ok: false, problem: `no prefix length — write ${t}/${max} for a single address` };
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return { text: t, ok: false, problem: `prefix length must be 0–${max}` };
  const c = parseCidrAny(t) ;
  return { text: t, ok: true, family, network: c.network, prefix: c.prefix, hostBits: family === 6 ? c.network !== c.address : parseIPv4(c.address) !== parseIPv4(c.network) };
}

/** Where the source address Splunk Cloud sees can never be, for each family. */
const NON_PUBLIC                                    = {
  // Private, shared (CGNAT), loopback and link-local.
  4: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16'],
  // Unique local (fc00::/7), link-local, loopback and IPv4-mapped.
  6: ['fc00::/7', 'fe80::/10', '::1/128', '::ffff:0:0/96'],
};

/** Private, shared, loopback and link-local space: never the source address Splunk Cloud sees. */
function isNonPublic(c      )          {
  if (!c.ok || c.network === undefined || c.prefix === undefined || c.family === undefined) return false;
  return NON_PUBLIC[c.family].some((base) => c.prefix  >= Number(base.split('/')[1]) && containsAny(base, c.network ));
}

function cidrFindings(list                   , what        , codePrefix        )            {
  const findings            = [];
  const seen = new Set        ();
  for (const raw of list) {
    const c = parseCidr(raw);
    if (!c.ok) {
      findings.push(error(`${codePrefix}-invalid`, `${what}: "${raw}" is not usable (${c.problem}). ACS rejects the whole request when one entry is invalid.`, { source: 'ArchToolKit' }));
      continue;
    }
    if (c.prefix === 0) {
      findings.push(
        error(`${codePrefix}-open`, `${what}: ${raw} allows every ${c.family === 6 ? 'IPv6 ' : ''}address on the internet. That is the state an allow list exists to end.`, {
          remediation: 'List the public egress addresses of the networks that need access — the NAT gateways, proxies and VPN concentrators — as /32s or small ranges.',
          source: 'ArchToolKit',
        }),
      );
      continue;
    }
    if (c.hostBits) {
      findings.push(error(`${codePrefix}-host-bits`, `${what}: ${raw} has host bits set; the network is ${c.network}/${c.prefix}. Write that, or ${raw.split('/')[0]}/${c.family === 6 ? 128 : 32} if one address was meant.`, { source: 'ArchToolKit' }));
    }
    if (c.family === 4 && c.prefix  < 16) {
      findings.push(warning(`${codePrefix}-wide`, `${what}: ${raw} is ${(2 ** (32 - c.prefix )).toLocaleString('en-US')} addresses. A range that wide usually means a cloud provider’s whole block — every other tenant in it gets through too.`, { source: 'ArchToolKit' }));
    }
    // An IPv6 site is a /48 and an ISP allocation a /32: anything wider is
    // someone's whole network, not yours.
    if (c.family === 6 && c.prefix  < 32) {
      findings.push(warning(`${codePrefix}-wide`, `${what}: ${raw} is wider than a whole ISP allocation (/32). A range that wide usually means a provider’s block — every other customer in it gets through too.`, { source: 'ArchToolKit' }));
    }
    if (isNonPublic(c)) {
      findings.push(
        warning(
          `${codePrefix}-private`,
          c.family === 6
            ? `${what}: ${raw} is unique-local, link-local or otherwise non-routable IPv6. Splunk Cloud sees your global IPv6 address, so this entry never matches anything (unless the stack is reached over AWS PrivateLink — VERIFY).`
            : `${what}: ${raw} is private or non-routable address space. Splunk Cloud sees your traffic after NAT, from a public address, so this entry never matches anything (unless the stack is reached over AWS PrivateLink — VERIFY).`,
          {
            remediation: c.family === 6 ? 'Find the global egress address: curl -6 https://api6.ipify.org from the network in question.' : 'Find the public egress address: curl https://checkip.amazonaws.com from the network in question.',
            source: 'ArchToolKit',
          },
        ),
      );
    }
    const key = `${c.network}/${c.prefix}`;
    if (seen.has(key)) findings.push(info(`${codePrefix}-duplicate`, `${what}: ${raw} is listed twice.`, { source: 'ArchToolKit' }));
    seen.add(key);
  }
  return findings;
}

/**
 * The shared bash prelude for every ACS script: private files, a private work
 * directory, and one curl function that never puts the token on a command line.
 */
export function acsPrelude()           {
  return script`
die() { printf 'error: %s\n' "$*" >&2; exit 2; }
note() { printf '%s\n' "$*" >&2; }

# A secret file must be readable by its owner only; anything looser and the
# secret has already leaked to whoever else can read it.
check_private() {
  local f=$1 m
  [ -f "$f" ] || die "not found: $f"
  m=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")
  case "$m" in
    600|400) ;;
    *) die "$f is mode $m. Run: chmod 600 $f  (refusing to use a secret other users can read)" ;;
  esac
}

command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required"

umask 077
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mode() { [ "$EXECUTE" = 1 ] && echo EXECUTE || echo DRY-RUN; }
enc() { jq -rn --arg v "$1" '$v|@uri'; }

# The ACS token is a JWT for a user with the sc_admin role (Settings > Tokens on
# the stack, or acs login). It is read from a mode-600 file into a private header
# file and reaches curl through -H @file, so it is never an argument and never
# appears in ps output or shell history.
setup_acs() {
  [[ "$STACK" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "'$STACK' is not a stack name (the first label of <stack>.splunkcloud.com)"
  ACS="\${ACS_SERVER:-https://admin.splunk.com}/$STACK/adminconfig/v2"
  check_private "$TOKEN_FILE"
  local t=""
  IFS= read -r t < "$TOKEN_FILE" || true
  t=\${t%$'\r'}
  [ -n "$t" ] || die "$TOKEN_FILE is empty"
  printf 'Authorization: Bearer %s\n' "$t" > "$WORK/auth.h"
  t=""
}

# acs METHOD PATH [curl args...]: the response body on stdout. On an HTTP error,
# the status and ACS's message on stderr and a non-zero return.
acs() {
  local method=$1 path=$2 code; shift 2
  code=$(curl -sS -o "$WORK/body" -w '%{http_code}' -X "$method" -H @"$WORK/auth.h" "$@" "$ACS$path") || die "could not reach $ACS"
  case $code in
    2??) cat "$WORK/body" ;;
    *) note "HTTP $code from $method $path"
       jq -r '.message // .code // .' "$WORK/body" >&2 2>/dev/null || head -c 2000 "$WORK/body" >&2
       return 1 ;;
  esac
}
acs_json() { local method=$1 path=$2 file=$3; acs "$method" "$path" -H 'Content-Type: application/json' --data-binary @"$file"; }

# fetch_all PATH KEY OUT: every item of a paged ACS list, as one JSON array in OUT.
# ACS returns 30 items by default and at most 100 per request (count); offset moves
# through the rest. Anything that could make the list partial — an HTTP error, a
# response without the KEY array, a page bigger than asked for, the same item on
# two pages (offset ignored) — stops the script: a truncated list shown as the
# whole list is worse than no list.
fetch_all() {
  local path=$1 key=$2 out=$3 offset=0 n pages=0 sep='?'
  case $path in *\?*) sep='&' ;; esac
  echo '[]' > "$out"
  while :; do
    pages=$((pages + 1))
    [ "$pages" -le 500 ] || die "more than 500 pages from $path; stopping rather than looping"
    acs GET "$path\${sep}count=100&offset=$offset" > "$WORK/page.json" || die "listing $path failed at offset $offset"
    jq --arg k "$key" 'if type == "array" then . elif (.[$k] | type) == "array" then .[$k] else error("no \($k) array") end' "$WORK/page.json" > "$WORK/items.json" 2>/dev/null \
      || die "unexpected response listing $path (no $key array); refusing to show a partial list"
    n=$(jq 'length' "$WORK/items.json")
    [ "$n" -le 100 ] || die "$path returned $n items for count=100; paging is not behaving as documented"
    jq -s '.[0] + .[1]' "$out" "$WORK/items.json" > "$WORK/merged.json"
    mv "$WORK/merged.json" "$out"
    jq -e '[.[] | (.name // .spec.name // tojson)] | length == (unique | length)' "$out" > /dev/null \
      || die "$path returned the same item on more than one page (offset ignored?); refusing to show a partial list"
    [ "$n" -eq 100 ] || break
    offset=$((offset + 100))
  done
}

# The stack status from GET /status, or "unknown".
# VERIFY the status field names against GET /adminconfig/v2/status on your stack.
stack_status() {
  local s
  s=$(acs GET /status 2>/dev/null | jq -r '.infrastructure.stackStatus // .infrastructure.status // .status // "unknown"' 2>/dev/null) || s=unknown
  printf '%s' "\${s:-unknown}"
}

# Most ACS changes are asynchronous (202 Accepted). Wait for the stack to say Ready.
wait_ready() {
  local i s
  for i in $(seq 1 60); do
    s=$(stack_status)
    [ "$s" = Ready ] && return 0
    note "stack status: $s (waiting)"
    sleep "\${ACS_POLL_SECONDS:-20}"
  done
  die "the stack did not report Ready in time; check with: acs status current-stack"
}

# wait_applied DESCRIPTION CHECK [ARGS...]: after a change, wait until it has taken
# effect. /status can still say Ready for a while after the request, before ACS has
# picked it up, so Ready straight after a change proves nothing. This waits until
# CHECK (a command that reads the resource back) sees the change AND the stack is
# Ready — a Ready that only counts once a non-Ready state has been seen since the
# request, or once the change has been visible for ACS_SETTLE_SECONDS (default 120).
wait_applied() {
  local desc=$1 i s busy=0 since=""; shift
  for i in $(seq 1 120); do
    s=$(stack_status)
    [ "$s" = Ready ] || busy=1
    if "$@"; then
      [ -n "$since" ] || since=$SECONDS
      if [ "$s" = Ready ] && { [ "$busy" = 1 ] || [ $((SECONDS - since)) -ge "\${ACS_SETTLE_SECONDS:-120}" ]; }; then
        note "$desc: applied"
        return 0
      fi
      note "$desc: visible, stack $s (waiting for it to settle)"
    else
      since=""
      note "$desc: not visible yet, stack $s (waiting)"
    fi
    sleep "\${ACS_POLL_SECONDS:-10}"
  done
  die "$desc: not applied in time; check with: acs status current-stack"
}
`;
}

/** The option parsing every ACS script shares; extra cases go in `more`. */
export function acsArgs(stack        , more                    = [])           {
  return [
    `STACK=${shq(stack)}`,
    'TOKEN_FILE="${ACS_TOKEN_FILE:-$HOME/.splunk/acs.token}"',
    'EXECUTE=1; CONFIRM=""; TARGET=""',
    'CMD=${1:-help}; [ $# -gt 0 ] && shift',
    'while [ $# -gt 0 ]; do',
    '  case $1 in',
    '    --stack) STACK=$2; shift 2 ;;',
    '    --token-file) TOKEN_FILE=$2; shift 2 ;;',
    '    --confirm) CONFIRM=$2; shift 2 ;;',
    '    --dry-run) EXECUTE=0; shift ;;',
    ...more.map((line) => `    ${line}`),
    '    -*) printf "unknown option: %s\\n" "$1" >&2; exit 2 ;;',
    '    *) TARGET=$1; shift ;;',
    '  esac',
    'done',
  ];
}

/** app.conf for an operations package: not visible, not configured, versioned. */
export function kitConf(app        , description        )           {
  return ['[install]', 'is_configured = 0', '', '[ui]', 'is_visible = 0', `label = ${app}`, '', '[launcher]', 'author = Automation', `description = ${description}`, 'version = 1.0.0', '', '[package]', `id = ${app}`];
}

export const TOKEN_NOTE =
  'The ACS token is a JWT for a user with the sc_admin role — create it in Settings > Tokens on the stack (or with acs login), put it alone in ~/.splunk/acs.token, chmod 600. The scripts refuse a token file other users can read, and send it from a private header file, never on the command line.';

// --- blueprints ------------------------------------------------------------

export const CLOUD_BLUEPRINTS                             = [
  // 7. Indexes --------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_acs_indexes',
    tier: TIER,
    label: 'Indexes through ACS',
    group: 'Admin Config Service',
    description: 'Splunk Cloud indexes created and updated through the Admin Config Service from a desired-state file (or the migration planner’s index mapping CSV): a plan that shows what would change, searchable retention checked against the contract, and archiving (DDAA or DDSS) so data is kept rather than deleted when it ages out.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_cloud_indexes' },
      { id: 'stack', label: 'Stack', control: 'text', default: 'example-stack', hint: 'The first label of <stack>.splunkcloud.com' },
      { id: 'indexes', label: 'Indexes', control: 'textarea', default: 'app_web\napp_db\nnetfw', hint: 'One per line' },
      { id: 'datatype', label: 'Type', control: 'select', default: 'event', options: [
        { value: 'event', label: 'Event' },
        { value: 'metric', label: 'Metric' },
      ] },
      { id: 'searchable_days', label: 'Searchable retention (days)', control: 'number', default: 90, min: 1, max: 3650 },
      { id: 'contract_days', label: 'Searchable retention your contract includes (days)', control: 'number', default: 90, min: 1, max: 3650, hint: 'Usually 90; see your order form' },
      { id: 'max_size_mb', label: 'Maximum size (MB)', control: 'number', default: 0, min: 0, hint: '0 = no size cap; retention decides' },
      { id: 'archive', label: 'When data ages out', control: 'select', default: 'ddaa', options: [
        { value: 'ddaa', label: 'Archive in Splunk (DDAA) — restorable' },
        { value: 'ddss', label: 'Copy to my own bucket (DDSS)' },
        { value: 'none', label: 'Delete it' },
      ] },
      { id: 'archive_days', label: 'Keep in the archive until day', control: 'number', default: 365, min: 2, max: 3650, hint: 'Counted from the event, not from archiving; must exceed searchable', showWhen: { input: 'archive', equals: ['ddaa'] } },
      { id: 'ddss_path', label: 'Self-storage location', control: 'text', default: 's3://org-splunk-ddss/stack', showWhen: { input: 'archive', equals: ['ddss'] } },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_cloud_indexes'), 'org_cloud_indexes');
      const stack = stackOf(values);
      const names = rows(str(values, 'indexes', '')).flatMap((line) => listOf(line));
      const datatype = str(values, 'datatype', 'event') === 'metric' ? 'metric' : 'event';
      const searchable = Math.round(num(values, 'searchable_days', 90));
      const contract = Math.round(num(values, 'contract_days', 90));
      const maxMB = Math.max(0, Math.round(num(values, 'max_size_mb', 0)));
      const archive = str(values, 'archive', 'ddaa');
      const archiveDays = Math.round(num(values, 'archive_days', 365));
      const ddss = str(values, 'ddss_path', '');
      const findings            = [...stackFindings(stack)];

      if (names.length === 0) findings.push(error('splunk.acs-no-indexes', 'No index names were given.', { source: 'ArchToolKit' }));
      for (const n of names) {
        if (!INDEX_NAME.test(n)) {
          findings.push(error('splunk.acs-index-name', `"${n}" is not a valid index name: lower-case letters, digits, underscores and hyphens, not starting with _ or -. Names starting with _ are reserved for Splunk’s own indexes.`, { source: 'ArchToolKit' }));
        }
        if (['main', 'history', 'summary', 'lastchanceindex', 'kvstore'].includes(n)) {
          findings.push(warning('splunk.acs-index-builtin', `${n} is an index Splunk Cloud already has. This will update its retention, not create a new one.`, { source: 'ArchToolKit' }));
        }
      }
      if (searchable < 1) findings.push(error('splunk.acs-searchable-days', 'Searchable retention must be at least one day.', { source: 'ArchToolKit' }));
      if (searchable > contract) {
        findings.push(
          warning('splunk.acs-searchable-over-contract', `Searchable retention of ${searchable} days is more than the ${contract} your contract includes. Splunk Cloud storage (DDAS) is sized on ingest × searchable days, so every day above the contract is storage you will be billed for as overage — silently, until the entitlement report or the invoice.`, {
            remediation: `Keep ${contract} days searchable and archive the rest (DDAA or DDSS), or buy the extra DDAS deliberately.`,
            source: 'ArchToolKit',
          }),
        );
      }
      if (archive === 'none') {
        findings.push(
          warning('splunk.acs-index-no-archive', `With no archive, events are deleted on day ${searchable + 1}. There is no recycle bin and Splunk support cannot restore them; audit and security data usually has to be kept for a year or more.`, {
            remediation: 'Choose DDAA (Splunk keeps it, restorable into a searchable index) or DDSS (a copy in your own S3 or GCS bucket).',
            source: 'ArchToolKit',
          }),
        );
      }
      if (archive === 'ddaa') {
        if (archiveDays <= searchable) findings.push(error('splunk.acs-ddaa-days', `splunkArchivalRetentionDays (${archiveDays}) must be greater than searchableDays (${searchable}); ACS rejects it otherwise.`, { source: 'ArchToolKit' }));
        if (archiveDays > 3650) findings.push(error('splunk.acs-ddaa-max', 'DDAA keeps data for at most 3650 days (10 years).', { source: 'ArchToolKit' }));
      }
      if (archive === 'ddss' && !/^(s3|gs):\/\/[a-z0-9][a-z0-9.-]+(\/.*)?$/.test(ddss)) {
        findings.push(error('splunk.acs-ddss-path', `"${ddss}" is not a self-storage location. It is s3://bucket/prefix or gs://bucket/prefix, and must already be set up as a self-storage location on the stack (Settings > Indexes > New Index > Self storage locations).`, { source: 'ArchToolKit' }));
      }
      if (maxMB === 0) {
        findings.push(info('splunk.acs-index-unbounded', 'No size cap: retention alone decides how much is kept. That is usually right in Splunk Cloud — a size cap deletes the oldest data early, before its searchable days are up, whenever volume spikes.', { source: 'ArchToolKit' }));
      } else if (maxMB < 10240) {
        findings.push(warning('splunk.acs-index-small-cap', `A ${maxMB} MB cap deletes the oldest data as soon as the index reaches it, whatever the searchable retention says. One noisy day and the retention promise is broken.`, { source: 'ArchToolKit' }));
      }

      const desired = names
        .filter((n) => INDEX_NAME.test(n))
        .map((name) => ({
          name,
          datatype,
          searchableDays: searchable,
          maxDataSizeMB: maxMB,
          ...(archive === 'ddaa' ? { splunkArchivalRetentionDays: archiveDays } : {}),
          ...(archive === 'ddss' ? { selfStorageBucketPath: ddss } : {}),
        }));

      const sh = [
        '#!/usr/bin/env bash',
        '# Splunk Cloud indexes through the Admin Config Service (ACS).',
        '#',
        '# usage: acs-indexes.sh COMMAND [options]',
        '#   plan                    compare the desired indexes with the stack (no changes)',
        '#   apply [--dry-run]       create what is missing, update what differs',
        '#   list                    every index on the stack, with size and retention',
        '#   delete NAME --confirm NAME [--dry-run]  delete an index AND ALL ITS DATA',
        '# options:',
        '#   --stack S               the stack (default below)',
        '#   --token-file F          ACS token, alone in a mode-600 file (default ~/.splunk/acs.token)',
        '#   --csv F                 the desired indexes (default: indexes.csv beside this script),',
        '#                           or the migration planner\'s index-mapping.csv; rows whose',
        '#                           action is not create or migrate are skipped',
        '#   --desired F             a JSON array of index objects instead of a CSV',
        '#   --contract-days N       warn on searchableDays above this',
        '#',
        '# Nothing is ever deleted by plan or apply. name and datatype cannot change',
        '# after creation, and ACS will not switch an index between DDAA and DDSS —',
        '# those show as CONFLICT and need the Splunk Cloud UI or a new index.',
        'set -euo pipefail',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...acsArgs(stack, [
          '--desired) DESIRED=$2; CSV=""; shift 2 ;;',
          '--csv) CSV=$2; DESIRED=""; shift 2 ;;',
          '--contract-days) CONTRACT_DAYS=$2; shift 2 ;;',
        ]).flatMap((line) => (line.startsWith('CMD=') ? ['DESIRED=""; CSV="$HERE/indexes.csv"', `CONTRACT_DAYS=${contract}`, line] : [line])),
        '',
        ...acsPrelude(),
        '',
        'case "$CMD" in help|-h|--help) sed -n "2,20p" "$0"; exit 0 ;; esac',
        'setup_acs',
        '',
        '# Every index on the stack, 100 at a time (the most ACS returns per page). An',
        '# empty or partial current list would turn every index into a CREATE, so any',
        '# doubt about the listing stops the script (fetch_all).',
        'fetch_current() { fetch_all /indexes indexes "$WORK/current.json"; }',
        '',
        'load_desired() {',
        '  if [ -n "$CSV" ]; then',
        '    [ -f "$CSV" ] || die "not found: $CSV"',
        '    # Header row names the columns; empty cells are left out of the request.',
        "    jq -R -s '",
        '      split("\\n") | map(sub("\\r$"; "")) | map(select(length > 0 and (startswith("#") | not)))',
        '      | (.[0] | split(",") | map(gsub("^\\"|\\"$"; ""))) as $h',
        '      | .[1:]',
        '      | map(split(",") | map(gsub("^\\"|\\"$"; "")) as $r',
        '            | reduce range(0; $h | length) as $i ({}; if ($r[$i] // "") == "" then . else . + {($h[$i]): $r[$i]} end))',
        '      | map(select((.action // "create") | test("^(create|migrate)$")))',
        '      | map({name, datatype: (.datatype // "event"),',
        '             searchableDays: ((.searchableDays // "90") | tonumber),',
        '             maxDataSizeMB: ((.maxDataSizeMB // "0") | tonumber)}',
        '            + (if .splunkArchivalRetentionDays then {splunkArchivalRetentionDays: (.splunkArchivalRetentionDays | tonumber)} else {} end)',
        "            + (if .selfStorageBucketPath then {selfStorageBucketPath} else {} end))' \"$CSV\" > \"$WORK/desired.json\"",
        '  else',
        '    [ -f "$DESIRED" ] || die "not found: $DESIRED"',
        '    jq . "$DESIRED" > "$WORK/desired.json"',
        '  fi',
        '  # Checks ACS would fail on, made before anything is sent.',
        '  jq -r \'.[] | select((.name | test("^[a-z0-9][a-z0-9_-]*$") | not)',
        '    or (.splunkArchivalRetentionDays != null and .splunkArchivalRetentionDays <= .searchableDays)',
        '    or (.splunkArchivalRetentionDays != null and .splunkArchivalRetentionDays > 3650)) | .name\' "$WORK/desired.json" > "$WORK/bad"',
        '  [ -s "$WORK/bad" ] && die "invalid name or archive days for: $(tr "\\n" " " < "$WORK/bad")"',
        '  jq -r --argjson c "$CONTRACT_DAYS" \'.[] | select(.searchableDays > $c) | "warning: \\(.name) searchableDays \\(.searchableDays) is above the \\($c) days in the contract (DDAS overage)"\' "$WORK/desired.json" >&2',
        '  jq -r \'.[] | select(.splunkArchivalRetentionDays == null and .selfStorageBucketPath == null) | "warning: \\(.name) has no archive; data is deleted after \\(.searchableDays) days"\' "$WORK/desired.json" >&2',
        '  true',
        '}',
        '',
        '# One TSV row per desired index: ACTION NAME BODY.',
        'make_plan() {',
        "  jq -r --slurpfile cur \"$WORK/current.json\" '",
        '    ($cur[0] | map({key: .name, value: .}) | from_entries) as $c',
        '    | .[] | . as $d | $c[$d.name] as $e',
        '    | if $e == null then ["CREATE", $d.name, ($d | tojson)]',
        '      elif (($e.datatype // "event") != ($d.datatype // "event")) then ["CONFLICT", $d.name, "datatype is \\($e.datatype) on the stack and cannot change"]',
        '      elif ($d.splunkArchivalRetentionDays != null and ($e.selfStorageBucketPath // "") != "") or ($d.selfStorageBucketPath != null and ($e.splunkArchivalRetentionDays // 0 | tonumber) > 0) then ["CONFLICT", $d.name, "switching between DDAA and DDSS is a UI change"]',
        '      else (["searchableDays", "maxDataSizeMB", "splunkArchivalRetentionDays", "selfStorageBucketPath"]',
        '            | map(select(. as $k | $d[$k] != null and (($e[$k] // "") | tostring) != ($d[$k] | tostring)))) as $diff',
        '        | if ($diff | length) == 0 then ["OK", $d.name, ""]',
        '          else ["UPDATE", $d.name, ($d | with_entries(select(.key as $k | $diff | index($k))) | tojson)] end',
        "      end | @tsv' \"$WORK/desired.json\" > \"$WORK/plan.tsv\"",
        '}',
        '',
        '# ACS answers 202 and creates or updates the index in the background. For an',
        '# update the index already exists, so "it answers GET" proves nothing: wait',
        '# until GET shows every field of the request at its new value.',
        'wait_index() {',
        '  local i',
        '  for i in $(seq 1 60); do',
        '    if acs GET "/indexes/$(enc "$1")" > "$WORK/idx.json" 2>/dev/null \\',
        '      && jq -e --slurpfile want "$2" \'. as $e | $want[0] | to_entries | all(.[]; (.value | tostring) == (($e[.key] // "") | tostring))\' "$WORK/idx.json" > /dev/null 2>&1; then',
        '      return 0',
        '    fi',
        '    sleep "\${ACS_POLL_SECONDS:-10}"',
        '  done',
        '  die "$1 did not show the requested settings in time; check with: acs-indexes.sh list"',
        '}',
        '',
        'case "$CMD" in',
        '  list)',
        '    fetch_current',
        '    printf "%-32s %-7s %10s %10s %10s %12s %s\\n" NAME TYPE SEARCHABLE MAX_MB ARCHIVE RAW_MB SELF_STORAGE',
        '    jq -r \'sort_by(.name)[] | [.name, (.datatype // "event"), (.searchableDays // ""), (.maxDataSizeMB // ""), (.splunkArchivalRetentionDays // "-"), (.totalRawSizeMB // ""), (.selfStorageBucketPath // "-")] | @tsv\' "$WORK/current.json" \\',
        '      | awk -F"\\t" \'{printf "%-32s %-7s %10s %10s %10s %12s %s\\n",$1,$2,$3,$4,$5,$6,$7}\'',
        '    ;;',
        '  plan|apply)',
        '    load_desired',
        '    fetch_current',
        '    make_plan',
        '    conflicts=0',
        '    while IFS=$\'\\t\' read -r action name body; do',
        '      case $action in',
        '        OK) printf "ok        %s\\n" "$name" ;;',
        '        CONFLICT) printf "CONFLICT  %s: %s\\n" "$name" "$body"; conflicts=$((conflicts + 1)) ;;',
        '        CREATE|UPDATE)',
        '          printf "%-9s %-7s %s %s\\n" "$(mode)" "$action" "$name" "$body"',
        '          if [ "$CMD" = apply ] && [ "$EXECUTE" = 1 ]; then',
        '            printf "%s" "$body" > "$WORK/req.json"',
        '            if [ "$action" = CREATE ]; then',
        '              acs_json POST /indexes "$WORK/req.json" > /dev/null',
        '            else',
        '              acs_json PATCH "/indexes/$(enc "$name")" "$WORK/req.json" > /dev/null',
        '            fi',
        '            wait_index "$name" "$WORK/req.json"',
        '            echo "          done: $name"',
        '          fi ;;',
        '      esac',
        '    done < "$WORK/plan.tsv"',
        '    [ "$CMD" = plan ] || [ "$EXECUTE" = 1 ] || echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        '    [ "$conflicts" -eq 0 ] || exit 1',
        '    ;;',
        '  delete)',
        '    [ -n "$TARGET" ] || die "delete needs an index name"',
        '    [ "$CONFIRM" = "$TARGET" ] || die "deleting $TARGET removes all of its data, searchable and archived. Repeat the name: --confirm $TARGET"',
        '    acs GET "/indexes/$(enc "$TARGET")" | jq -r \'"\\(.name): \\(.totalEventCount // "?") events, \\(.totalRawSizeMB // "?") MB raw"\'',
        '    echo "$(mode)  DELETE index $TARGET"',
        '    [ "$EXECUTE" = 1 ] || exit 0',
        '    acs DELETE "/indexes/$(enc "$TARGET")" > /dev/null',
        '    echo "deletion accepted"',
        '    ;;',
        '  *) die "unknown command $CMD (try --help)" ;;',
        'esac',
      ];

      const cli = [
        '# The same with the acs CLI (github.com/splunk/acs-cli releases). The CLI',
        '# reads the token from the STACK_TOKEN environment variable, not an argument:',
        '#   export STACK_TOKEN="$(cat ~/.splunk/acs.token)"',
        `#   acs config add-stack ${stack} && acs config use-stack ${stack}`,
        '# VERIFY the flag names with: acs indexes create --help',
        '',
        'acs indexes list',
        ...desired.map(
          (d) =>
            `acs indexes create --name ${d.name} --data-type ${d.datatype} --searchable-days ${d.searchableDays} --max-data-size-mb ${d.maxDataSizeMB}` +
            ('splunkArchivalRetentionDays' in d ? ` --splunk-archival-retention-days ${d.splunkArchivalRetentionDays}` : '') +
            ('selfStorageBucketPath' in d ? ` --self-storage-bucket-path ${d.selfStorageBucketPath}` : ''),
        ),
        ...(desired[0] ? [`acs indexes update ${desired[0].name} --searchable-days ${desired[0].searchableDays}`, `acs indexes describe ${desired[0].name}`] : []),
        '',
        '# The REST calls the script makes:',
        `#   GET    https://admin.splunk.com/${stack}/adminconfig/v2/indexes?count=100&offset=0`,
        `#   POST   https://admin.splunk.com/${stack}/adminconfig/v2/indexes          {name, datatype, searchableDays, maxDataSizeMB, splunkArchivalRetentionDays | selfStorageBucketPath}`,
        `#   PATCH  https://admin.splunk.com/${stack}/adminconfig/v2/indexes/{name}   only the fields that change`,
        `#   DELETE https://admin.splunk.com/${stack}/adminconfig/v2/indexes/{name}`,
      ];

      return {
        tier: TIER,
        title: `Splunk Cloud indexes on ${stack}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`,
        app,
        activation: 'reload',
        notes: [
          TOKEN_NOTE,
          'ops/acs-indexes.sh plan shows what would be created or changed; apply makes the changes (apply --dry-run previews). The desired state is ops/indexes.csv — edit it, or feed the migration planner’s index-mapping.csv with --csv.',
          'An index in Splunk Cloud is not usable until something can write to it: a HEC token allowing it (splunk_acs_hec), or forwarders sending to it, and the roles that should search it given it in srchIndexesAllowed.',
          'name and datatype cannot be changed after creation. ACS will not turn DDAA off or switch an index between DDAA and DDSS; that is the Splunk Cloud UI.',
          ...(archive === 'ddss' ? ['DDSS writes to your bucket as data ages out; the bucket needs the policy Splunk shows when you add the self-storage location, and it is then your data to keep, lifecycle and pay for. Data in DDSS is not searchable from Splunk Cloud; bring it back by thawing it into a Splunk Enterprise instance.'] : []),
          ...(archive === 'ddaa' ? [`DDAA archive days are counted from the event’s time, so ${archiveDays} means kept for ${archiveDays} days in total — ${searchable} searchable, then ${archiveDays - searchable} archived. Restoring from DDAA into search takes hours and counts against the DDAA restore entitlement.`] : []),
        ],
        before: [
          `bash ops/acs-indexes.sh list --stack ${stack}`,
          `bash ops/acs-indexes.sh plan --stack ${stack}`,
          'Settings > Indexes on the stack: DDAS and DDAA entitlement and current usage (Monitoring Console > License usage / Cloud Monitoring Console > Storage) — enough headroom for the new retention?',
        ],
        files: {
          'default/app.conf': kitConf(app, `ACS index management for ${stack}`),
          'ops/indexes.csv': [
            '# Desired indexes for acs-indexes.sh. Same columns as the migration planner’s index-mapping.csv;',
            '# empty cells are left out of the request. action: create (or migrate) to include a row.',
            'name,datatype,searchableDays,maxDataSizeMB,splunkArchivalRetentionDays,selfStorageBucketPath,action',
            ...desired.map((d) => [d.name, d.datatype, d.searchableDays, d.maxDataSizeMB, 'splunkArchivalRetentionDays' in d ? d.splunkArchivalRetentionDays : '', 'selfStorageBucketPath' in d ? d.selfStorageBucketPath : '', 'create'].join(',')),
          ],
          'ops/acs-indexes.sh': sh,
          'ops/acs-cli.txt': cli,
        },
        verify: [
          `bash ops/acs-indexes.sh plan --stack ${stack}   # every line ok, exit 0`,
          `| rest /services/data/indexes splunk_server=* | search title IN (${names.slice(0, 10).join(', ')}) | stats values(frozenTimePeriodInSecs) as frozen, values(datatype) as type by title`,
          `| eventcount summarize=false index=${names[0] ?? '<index>'} | stats sum(count) by index`,
        ],
        backout: [
          `bash ops/acs-indexes.sh delete <name> --confirm <name> --stack ${stack}   # an index created by mistake, before data arrives`,
          '# A retention change is backed out by PATCHing the old value (from the list output taken before). Data already removed by a shorter retention is not recoverable.',
        ],
        findings,
      };
    },
  }),

  // 8. HEC tokens -----------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_acs_hec',
    tier: TIER,
    label: 'HEC tokens through ACS',
    group: 'Admin Config Service',
    description: 'An HTTP Event Collector token on Splunk Cloud created through ACS, scoped to the indexes it may write, with the token value written straight from the response to a mode-600 file and never printed — plus rotation by overlap, disable, and the search that shows when the old token has gone quiet.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_cloud_hec' },
      { id: 'stack', label: 'Stack', control: 'text', default: 'example-stack' },
      { id: 'token_name', label: 'Token name', control: 'text', default: 'app_web_prod', hint: 'Name the sender, not the index' },
      { id: 'default_index', label: 'Default index', control: 'text', default: 'app_web' },
      { id: 'allowed_indexes', label: 'Allowed indexes', control: 'text', default: 'app_web', hint: 'Comma separated; empty = every index' },
      { id: 'sourcetype', label: 'Default sourcetype', control: 'text', default: '_json' },
      { id: 'source', label: 'Default source', control: 'text', default: '', placeholder: 'http:app_web' },
      { id: 'use_ack', label: 'Indexer acknowledgement (useACK)', control: 'toggle', default: false, hint: 'For Amazon Data Firehose; senders must poll for acks' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_cloud_hec'), 'org_cloud_hec');
      const stack = stackOf(values);
      const name = str(values, 'token_name', 'hec_token').replace(/[^A-Za-z0-9_.-]/g, '_');
      const defaultIndex = str(values, 'default_index', '');
      const allowed = listOf(str(values, 'allowed_indexes', ''));
      const sourcetype = str(values, 'sourcetype', '');
      const source = str(values, 'source', '');
      const useAck = bool(values, 'use_ack', false);
      const findings            = [...stackFindings(stack)];

      if (allowed.length === 0) {
        findings.push(
          error('splunk.acs-hec-any-index', 'No allowed indexes: the token can write to every index on the stack, including the ones security and audit data live in. Anyone holding it can pollute or flood any of them.', {
            remediation: 'List exactly the indexes this sender writes to.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (allowed.length > 0 && defaultIndex && !allowed.includes(defaultIndex)) {
        findings.push(error('splunk.acs-hec-default-not-allowed', `The default index ${defaultIndex} is not in the allowed list, so events sent without an index are rejected (VERIFY: ACS may refuse the token outright).`, { source: 'ArchToolKit' }));
      }
      if (!defaultIndex) findings.push(warning('splunk.acs-hec-no-default', 'No default index: events that do not name one go to main — or are rejected if main is not allowed.', { source: 'ArchToolKit' }));
      for (const idx of [defaultIndex, ...allowed].filter(Boolean)) {
        if (idx.startsWith('_')) findings.push(error('splunk.acs-hec-internal', `${idx} is an internal index. A HEC sender writing there can forge Splunk’s own logs and audit trail.`, { source: 'ArchToolKit' }));
      }
      if (defaultIndex === 'main' || allowed.includes('main')) {
        findings.push(warning('splunk.acs-hec-main', 'main is where data with nowhere else to go ends up. A sender writing there is data nobody gave an owner, a retention or a role.', { source: 'ArchToolKit' }));
      }
      if (useAck) {
        findings.push(
          warning('splunk.acs-hec-ack', 'With useACK every sender must send a channel ID and poll /services/collector/ack. A client that does not (most loggers and libraries) gets errors once its channel fills. It is meant for Amazon Data Firehose, which does poll.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (allowed.length > 5) findings.push(info('splunk.acs-hec-many-indexes', `${allowed.length} allowed indexes for one token is usually several senders sharing it. One token per sender makes rotation and revocation a change to one system.`, { source: 'ArchToolKit' }));

      const spec = {
        name,
        defaultIndex: defaultIndex || 'main',
        allowedIndexes: allowed,
        ...(sourcetype ? { defaultSourcetype: sourcetype } : {}),
        ...(source ? { defaultSource: source } : {}),
        useACK: useAck,
        disabled: false,
      };
      const hecHost = useAck ? `http-inputs-firehose-${stack}.splunkcloud.com` : `http-inputs-${stack}.splunkcloud.com`;

      const sh = [
        '#!/usr/bin/env bash',
        '# Splunk Cloud HEC tokens through the Admin Config Service.',
        '#',
        '# usage: acs-hec.sh COMMAND [NAME] [options]',
        '#   list                     every token, settings only (values removed)',
        '#   describe NAME            one token, value removed',
        '#   create [--out FILE]      create the token in hec-token.spec; value -> FILE (mode 600)',
        '#   rotate NAME --out FILE   a second token with NAME\'s settings, named NAME-rYYYYMMDD;',
        '#                            move the senders, watch usage, then disable NAME',
        '#   usage NAME               the search that shows traffic per token',
        '#   disable NAME | enable NAME',
        '#   delete NAME --confirm NAME',
        '# options: --stack S  --token-file F (the ACS token, mode 600)  --spec F  --dry-run',
        '#',
        '# A token value is only ever written from an ACS response to a mode-600 file.',
        '# It is never printed, logged or passed as an argument.',
        'set -euo pipefail',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...acsArgs(stack, ['--spec) SPEC=$2; shift 2 ;;', '--out) OUT=$2; shift 2 ;;']).flatMap((line) => (line.startsWith('CMD=') ? ['SPEC="$HERE/hec-token.spec"; OUT=""', line] : [line])),
        '',
        ...acsPrelude(),
        '',
        'case "$CMD" in help|-h|--help) sed -n "2,20p" "$0"; exit 0 ;; esac',
        'setup_acs',
        'HEC_PATH=/inputs/http-event-collectors',
        '',
        '# Remove every token value from ACS output before anything reaches the screen.',
        "redact() { jq 'walk(if type == \"object\" then del(.token) else . end)'; }",
        '',
        '# Write the token value from an ACS response to $OUT, mode 600. If the',
        '# response came back before the token was provisioned (202), poll for it.',
        'save_value() {',
        '  local name=$1 resp=$2 i',
        '  mkdir -p "$(dirname "$OUT")"',
        '  jq -j \'.["http-event-collector"].token // empty\' "$resp" > "$WORK/value"',
        '  for i in $(seq 1 30); do',
        '    [ -s "$WORK/value" ] && break',
        '    sleep 10',
        '    acs GET "$HEC_PATH/$(enc "$name")" 2>/dev/null | jq -j \'.["http-event-collector"].token // empty\' > "$WORK/value" || true',
        '  done',
        '  [ -s "$WORK/value" ] || die "ACS returned no token value for $name yet; run: acs-hec.sh describe $name, then rotate if needed"',
        '  install -m 600 "$WORK/value" "$OUT"',
        '  echo "token value for $name written to $OUT (mode 600). Move it into the sender\'s secret store and delete the file."',
        '}',
        '',
        'exists() { acs GET "$HEC_PATH/$(enc "$1")" > /dev/null 2>&1; }',
        '',
        '# True once GET shows the token with disabled = FLAG. A response without the',
        '# token spec is not a match: a missing field must not read as "applied".',
        'hec_flag_is() {',
        '  acs GET "$HEC_PATH/$(enc "$1")" > "$WORK/hec.json" 2>/dev/null || return 1',
        '  jq -e --argjson f "$2" \'.["http-event-collector"].spec | type == "object" and ((.disabled // false) == $f)\' "$WORK/hec.json" > /dev/null',
        '}',
        '',
        '# Change one flag with PATCH and only that field (ACS: PATCH',
        '# .../inputs/http-event-collectors/{name} {"disabled": true}), so the token value',
        '# is never part of a request. Then wait until GET shows the new state and the',
        '# stack has settled — not just the first Ready, which can predate the change.',
        'set_disabled() {',
        '  local name=$1 flag=$2',
        '  exists "$name" || die "no token named $name on $STACK"',
        '  jq -n --argjson f "$flag" \'{disabled: $f}\' > "$WORK/req.json"',
        '  echo "$(mode)  set disabled=$flag on $name"',
        '  [ "$EXECUTE" = 1 ] || exit 0',
        '  acs_json PATCH "$HEC_PATH/$(enc "$name")" "$WORK/req.json" > /dev/null',
        '  wait_applied "$name disabled=$flag" hec_flag_is "$name" "$flag"',
        '}',
        '',
        'case "$CMD" in',
        '  list)',
        '    # Every token, 100 per request, paged until ACS has no more (fetch_all).',
        '    fetch_all "$HEC_PATH" http-event-collectors "$WORK/hecs.json"',
        '    redact < "$WORK/hecs.json" | jq -r \'.[] | .spec // . | [.name, .defaultIndex, ((.allowedIndexes // []) | join(",")), (.defaultSourcetype // ""), (.disabled // false), (.useACK // false)] | @tsv\' \\',
        '      | awk -F"\\t" \'BEGIN{printf "%-32s %-16s %-40s %-16s %-8s %s\\n","NAME","DEFAULT","ALLOWED","SOURCETYPE","DISABLED","ACK"} {printf "%-32s %-16s %-40s %-16s %-8s %s\\n",$1,$2,$3,$4,$5,$6}\'',
        '    ;;',
        '  describe)',
        '    [ -n "$TARGET" ] || die "describe needs a token name"',
        '    acs GET "$HEC_PATH/$(enc "$TARGET")" | redact',
        '    ;;',
        '  create)',
        '    [ -f "$SPEC" ] || die "not found: $SPEC"',
        '    sed "/^[[:space:]]*#/d" "$SPEC" | jq \'del(.token)\' > "$WORK/req.json" || die "$SPEC is not valid JSON after its comments"',
        "    NAME=$(jq -er '.name | select(type == \"string\" and length > 0)' \"$WORK/req.json\") || die \"$SPEC has no name\"",
        '    [ -n "$OUT" ] || OUT="$HOME/.splunk/hec/$NAME.token"',
        '    [ -e "$OUT" ] && die "$OUT exists; refusing to overwrite a token file"',
        '    exists "$NAME" && die "a token named $NAME already exists (use rotate to replace it)"',
        '    jq -e \'(.allowedIndexes | length) > 0\' "$WORK/req.json" > /dev/null || note "warning: allowedIndexes is empty; this token can write to every index"',
        '    echo "$(mode)  create HEC token $NAME -> $OUT"',
        '    jq . "$WORK/req.json"',
        '    [ "$EXECUTE" = 1 ] || exit 0',
        '    acs_json POST "$HEC_PATH" "$WORK/req.json" > "$WORK/created.json"',
        '    save_value "$NAME" "$WORK/created.json"',
        '    ;;',
        '  rotate)',
        '    [ -n "$TARGET" ] || die "rotate needs the current token name"',
        '    NEW="$TARGET-r$(date +%Y%m%d)"',
        '    [ -n "$OUT" ] || OUT="$HOME/.splunk/hec/$NEW.token"',
        '    [ -e "$OUT" ] && die "$OUT exists"',
        '    exists "$NEW" && die "$NEW already exists"',
        '    # The response holds the old value; it goes straight into jq, which drops it.',
        '    acs GET "$HEC_PATH/$(enc "$TARGET")" | jq --arg n "$NEW" \'.["http-event-collector"].spec | if type == "object" then . else error("no token spec in the response") end | del(.token) | .name = $n | .disabled = false\' > "$WORK/req.json"',
        '    # Without the spec the copy would have no allowedIndexes, i.e. every index.',
        '    jq -e \'(.allowedIndexes | type) == "array"\' "$WORK/req.json" > /dev/null || die "$TARGET has no allowedIndexes in its spec; refusing to create a token that can write anywhere"',
        '    echo "$(mode)  create $NEW with the settings of $TARGET -> $OUT"',
        '    jq . "$WORK/req.json"',
        '    [ "$EXECUTE" = 1 ] || exit 0',
        '    acs_json POST "$HEC_PATH" "$WORK/req.json" > "$WORK/created.json"',
        '    save_value "$NEW" "$WORK/created.json"',
        '    echo "Next: move each sender to the new token, then check the old one has gone quiet (acs-hec.sh usage $TARGET) and disable it."',
        '    ;;',
        '  usage)',
        '    [ -n "$TARGET" ] || die "usage needs a token name"',
        '    echo "Run on the stack (per_token_thruput is reported by the HEC tier; VERIFY the series name matches the token name on your stack):"',
        '    echo "  index=_internal source=*metrics.log* group=per_token_thruput series=\\"$TARGET\\" earliest=-24h | timechart span=1h sum(kb) as kb"',
        '    echo "  index=_introspection sourcetype=http_event_collector_metrics data.token_name=\\"$TARGET\\" earliest=-24h | timechart span=1h sum(data.num_of_events)"',
        '    ;;',
        '  disable) [ -n "$TARGET" ] || die "disable needs a token name"; set_disabled "$TARGET" true ;;',
        '  enable) [ -n "$TARGET" ] || die "enable needs a token name"; set_disabled "$TARGET" false ;;',
        '  delete)',
        '    [ -n "$TARGET" ] || die "delete needs a token name"',
        '    [ "$CONFIRM" = "$TARGET" ] || die "deleting $TARGET cannot be undone; disable it first, then repeat the name: --confirm $TARGET"',
        '    echo "$(mode)  delete HEC token $TARGET"',
        '    [ "$EXECUTE" = 1 ] || exit 0',
        '    acs DELETE "$HEC_PATH/$(enc "$TARGET")" > /dev/null',
        '    echo "deletion accepted"',
        '    ;;',
        '  *) die "unknown command $CMD (try --help)" ;;',
        'esac',
      ];

      return {
        tier: TIER,
        title: `HEC token ${name} on ${stack} → ${allowed.length ? allowed.join(', ') : 'any index'}`,
        app,
        activation: 'reload',
        notes: [
          TOKEN_NOTE,
          `The HEC token value is a credential in its own right: anyone holding it can write to ${allowed.length ? allowed.join(', ') : 'every index'}. The script writes it from the ACS response straight into ~/.splunk/hec/${name}.token (mode 600) and never prints it; list and describe strip it from their output.`,
          `Senders use https://${hecHost}:443/services/collector/event (or /raw) with the header Authorization: Splunk <token>. The hec IP allow list (splunk_acs_network) must include their public addresses.`,
          'Rotation is by overlap: rotate creates a second token with the same settings, senders move one at a time, and the old token is disabled once the usage search shows no traffic — then deleted a week later. Two valid tokens is the normal state during rotation.',
          'All the allowed indexes must already exist (splunk_acs_indexes); a token naming an index that does not exist is rejected or, worse, accepted and its events dropped (VERIFY on your stack).',
        ],
        before: [
          `bash ops/acs-hec.sh list --stack ${stack}`,
          `bash ops/acs-indexes.sh list --stack ${stack} | grep -E "^(${[defaultIndex, ...allowed].filter(Boolean).join('|') || 'main'}) "   # the indexes exist`,
          `bash ops/acs-hec.sh create --stack ${stack} --dry-run   # shows the request`,
        ],
        files: {
          'default/app.conf': kitConf(app, `ACS HEC token ${name} for ${stack}`),
          'ops/hec-token.spec': ['# The token definition sent to ACS: JSON after these comment lines, which the script strips.', ...JSON.stringify(spec, null, 2).split('\n')],
          'ops/acs-hec.sh': sh,
          'ops/acs-cli.txt': [
            '# acs CLI equivalents. The CLI takes the ACS token from STACK_TOKEN:',
            '#   export STACK_TOKEN="$(cat ~/.splunk/acs.token)"',
            '# It prints the new token value to the terminal on create — which is why the',
            '# script above is the one to use when the terminal is recorded or shared.',
            '# VERIFY flag names with: acs hec-token create --help',
            '',
            'acs hec-token list',
            `acs hec-token create --name ${name} --default-index ${spec.defaultIndex}${allowed.length ? ` --allowed-indexes ${allowed.join(',')}` : ''}${sourcetype ? ` --default-source-type ${sourcetype}` : ''}${useAck ? ' --use-ack' : ''}`,
            `acs hec-token describe ${name}`,
            `acs hec-token update ${name} --disabled true`,
            `acs hec-token delete ${name}`,
            '',
            '# REST: GET/POST https://admin.splunk.com/{stack}/adminconfig/v2/inputs/http-event-collectors',
            '#       GET/PATCH/DELETE .../inputs/http-event-collectors/{name}   (PATCH {"disabled": true} changes one field)',
            '#       lists are paged: ?count=100&offset=0, 100, ... (30 per request by default, 100 at most)',
            '# The response wraps the token as {"http-event-collector": {"spec": {...}, "token": "..."}}.',
          ],
        },
        verify: [
          `bash ops/acs-hec.sh describe ${name} --stack ${stack}`,
          `curl -sS -H @<(printf 'Authorization: Splunk %s\\n' "$(cat ~/.splunk/hec/${name}.token)") https://${hecHost}/services/collector/event -d '{"event":"hec test","index":"${spec.defaultIndex}"}'   # {"text":"Success","code":0}`,
          `index=${spec.defaultIndex} "hec test" earliest=-15m | table _time, index, sourcetype, source, host`,
          `index=_internal sourcetype=splunkd component=HttpInputDataHandler earliest=-1h | stats count by log_level, message | sort - count   # rejected events and why`,
        ],
        backout: [
          `bash ops/acs-hec.sh disable ${name} --stack ${stack}   # reversible: enable brings it back with the same value`,
          `bash ops/acs-hec.sh delete ${name} --confirm ${name} --stack ${stack}`,
          `rm -f ~/.splunk/hec/${name}.token`,
        ],
        findings,
      };
    },
  }),

  // 9. Network --------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_acs_network',
    tier: TIER,
    label: 'IP allow lists and outbound ports through ACS',
    group: 'Admin Config Service',
    description: 'Who can reach the stack — search UI, REST API, HEC, forwarders (S2S), IDM — as ACS IP allow lists with every subnet validated before it is sent, a plan that adds before it removes, a guard against locking yourself out, and outbound ports for federated search or on-premises lookups.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_cloud_network' },
      { id: 'stack', label: 'Stack', control: 'text', default: 'example-stack' },
      { id: 'feature', label: 'Allow list', control: 'select', default: 'search-api', options: [
        { value: 'search-api', label: 'search-api — REST API, port 8089' },
        { value: 'search-ui', label: 'search-ui — Splunk Web, 443' },
        { value: 'hec', label: 'hec — HTTP Event Collector, 443' },
        { value: 's2s', label: 's2s — forwarders, 9997' },
        { value: 'idm-api', label: 'idm-api — Inputs Data Manager API, 8089' },
        { value: 'idm-ui', label: 'idm-ui — Inputs Data Manager UI, 443' },
      ] },
      { id: 'subnets', label: 'Subnets', control: 'textarea', default: '203.0.113.0/24\n198.51.100.17/32', hint: 'Public IPv4 or IPv6 CIDRs, one per line; IPv6 goes to the separate IPv6 list' },
      { id: 'remove_open', label: 'Remove 0.0.0.0/0 (and ::/0) once these are in place', control: 'toggle', default: true },
      { id: 'exact', label: 'Remove anything else not listed', control: 'toggle', default: false },
      { id: 'outbound', label: 'Also open an outbound port', control: 'toggle', default: false },
      { id: 'outbound_port', label: 'Outbound port', control: 'number', default: 8089, min: 1, max: 65535, showWhen: { input: 'outbound', equals: ['true'] } },
      { id: 'outbound_subnets', label: 'Outbound destinations', control: 'textarea', default: '198.51.100.40/32', hint: 'IPv4 CIDRs', showWhen: { input: 'outbound', equals: ['true'] } },
      { id: 'outbound_reason', label: 'Reason', control: 'text', default: 'Federated search to on-premises Splunk', showWhen: { input: 'outbound', equals: ['true'] } },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_cloud_network'), 'org_cloud_network');
      const stack = stackOf(values);
      const feature = str(values, 'feature', 'search-api');
      const subnets = rows(str(values, 'subnets', '')).flatMap((l) => listOf(l));
      const removeOpen = bool(values, 'remove_open', true);
      const exact = bool(values, 'exact', false);
      const outbound = bool(values, 'outbound', false);
      const outPort = Math.round(num(values, 'outbound_port', 8089));
      const outSubnets = rows(str(values, 'outbound_subnets', '')).flatMap((l) => listOf(l));
      const outReason = str(values, 'outbound_reason', '');
      const findings            = [...stackFindings(stack), ...cidrFindings(subnets, `${feature} allow list`, 'splunk.acs-allowlist')];

      // IPv4 subnets go to ipallowlists, IPv6 to ipallowlists-v6: two lists,
      // two files, never one request mixing families.
      const parsed = subnets.map(parseCidr).filter((c) => c.ok && c.prefix  > 0);
      const unique = [...new Set(parsed.filter((c) => c.family === 4).map((c) => `${c.network}/${c.prefix}`))];
      const unique6 = [...new Set(parsed.filter((c) => c.family === 6).map((c) => `${c.network}/${c.prefix}`))];
      const total = unique.length + unique6.length;
      if (subnets.length === 0) {
        findings.push(error('splunk.acs-allowlist-empty', `No subnets for ${feature}. An empty allow list blocks everyone.`, { source: 'ArchToolKit' }));
      }
      for (const [list, name] of [[unique, 'IPv4'], [unique6, 'IPv6']]         ) {
        if (list.length > 200) findings.push(error('splunk.acs-allowlist-limit', `${list.length} ${name} subnets; ACS allows 200 per feature (230 per group on AWS). Summarise into larger ranges.`, { source: 'ArchToolKit' }));
      }
      if (!removeOpen && !exact) {
        findings.push(
          warning('splunk.acs-allowlist-still-open', `Most allow lists start as 0.0.0.0/0. Adding subnets without removing it changes nothing: ${feature} stays open to the internet.`, {
            remediation: 'Turn on "Remove 0.0.0.0/0" — the script adds your subnets first and removes it only after they are in place.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (['search-api', 'search-ui'].includes(feature) && (removeOpen || exact)) {
        findings.push(info('splunk.acs-allowlist-lockout', `Closing ${feature} to these subnets locks out every other address — including yours if you run this from outside them. The script checks your own public address first and refuses unless it is covered.`, { source: 'ArchToolKit' }));
      }
      if (outbound) {
        // Outbound ports take IPv4 destinations; ACS documents no IPv6 form for them.
        const out6 = outSubnets.filter((s) => familyOf(s.split('/')[0] ?? '') === 6);
        for (const s of out6) {
          findings.push(error('splunk.acs-outbound-ipv6', `outbound port ${outPort}: ACS outbound ports on Splunk Cloud do not support IPv6 (${s}).`, { remediation: 'Give the destination’s IPv4 address. VERIFY: IPv6 outbound ports in the ACS endpoint reference for your stack’s release.', source: 'ArchToolKit' }));
        }
        findings.push(...cidrFindings(outSubnets.filter((s) => !out6.includes(s)), `outbound port ${outPort}`, 'splunk.acs-outbound'));
        if (outSubnets.length === 0) findings.push(error('splunk.acs-outbound-empty', 'An outbound port needs at least one destination subnet.', { source: 'ArchToolKit' }));
        if (outPort < 1 || outPort > 65535) findings.push(error('splunk.acs-outbound-port', `${outPort} is not a port.`, { source: 'ArchToolKit' }));
        if (!outReason) findings.push(warning('splunk.acs-outbound-no-reason', 'No reason: the rule will be in place long after anyone remembers why.', { source: 'ArchToolKit' }));
      }
      const outValid = [...new Set(outSubnets.map(parseCidr).filter((c) => c.ok && c.family === 4 && c.prefix  > 0).map((c) => `${c.network}/${c.prefix}`))];

      const sh = [
        '#!/usr/bin/env bash',
        '# Splunk Cloud IP allow lists and outbound ports through ACS.',
        '#',
        '# usage: acs-network.sh COMMAND [options]',
        '#   plan | apply             bring one allow list to the subnets in allowlist-<feature>.txt',
        '#   show                     the current allow list for --feature',
        '#   outbound-plan | outbound-apply   the rule in outbound-ports.spec',
        '# options:',
        `#   --feature F              search-api search-ui hec s2s idm-api idm-ui (default ${feature})`,
        '#   --subnets-file F         one CIDR per line (default allowlist-<feature>.txt beside this script)',
        '#   --ipv6                   the IPv6 list (ipallowlists-v6) from allowlist-<feature>-v6.txt',
        `#   --remove-open            remove 0.0.0.0/0 (::/0 with --ipv6) after the subnets are in place${removeOpen ? ' (on by default here)' : ''}`,
        `#   --exact                  also remove every subnet not in the file${exact ? ' (on by default here)' : ''}`,
        '#   --allow-lockout          skip the check that your own address stays allowed',
        '#   --stack S  --token-file F  --dry-run (apply and outbound-apply only preview)',
        '#',
        '# Order is always: add, wait for the stack to apply it, then remove — so there',
        '# is never a moment when the list is narrower than both the old and new state.',
        'set -euo pipefail',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...acsArgs(stack, [
          '--feature) FEATURE=$2; shift 2 ;;',
          '--subnets-file) SUBNETS_FILE=$2; shift 2 ;;',
          '--remove-open) REMOVE_OPEN=1; shift ;;',
          '--keep-open) REMOVE_OPEN=0; shift ;;',
          '--exact) EXACT=1; shift ;;',
          '--allow-lockout) ALLOW_LOCKOUT=1; shift ;;',
          '--ipv6) V6=1; shift ;;',
        ]).flatMap((line) => (line.startsWith('CMD=') ? [`FEATURE=${shq(feature)}; SUBNETS_FILE=""; REMOVE_OPEN=${removeOpen ? 1 : 0}; EXACT=${exact ? 1 : 0}; ALLOW_LOCKOUT=0; V6=0`, line] : [line])),
        '',
        ...acsPrelude(),
        '',
        'case "$CMD" in help|-h|--help) sed -n "2,21p" "$0"; exit 0 ;; esac',
        'case "$FEATURE" in search-api|search-ui|hec|s2s|idm-api|idm-ui) ;; *) die "unknown feature $FEATURE" ;; esac',
        'setup_acs',
        '# IPv4 and IPv6 are separate lists on the stack: ipallowlists and ipallowlists-v6.',
        'if [ "$V6" = 1 ]; then SUFFIX=-v6; OPEN="::/0"; else SUFFIX=""; OPEN="0.0.0.0/0"; fi',
        '[ -n "$SUBNETS_FILE" ] || SUBNETS_FILE="$HERE/allowlist-$FEATURE$SUFFIX.txt"',
        'AL="/access/$FEATURE/ipallowlists$SUFFIX"',
        '',
        'ip2int() { local IFS=.; set -- $1; echo $(( ($1 << 24) + ($2 << 16) + ($3 << 8) + $4 )); }',
        '# valid_cidr A.B.C.D/N: an IPv4 network with no host bits set.',
        'valid_cidr() {',
        '  local c=$1 ip bits o',
        '  [[ "$c" =~ ^([0-9]{1,3}\\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || return 1',
        '  ip=${c%/*}; bits=${c#*/}',
        '  [ "$bits" -le 32 ] || return 1',
        '  for o in ${ip//./ }; do [ "$o" -le 255 ] || return 1; done',
        '  local mask=$(( bits == 0 ? 0 : (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF ))',
        '  [ $(( $(ip2int "$ip") & ~mask & 0xFFFFFFFF )) -eq 0 ] || return 1',
        '}',
        'in_cidr() {',
        '  local ip=$1 net=\${2%/*} bits=\${2#*/}',
        '  local mask=$(( bits == 0 ? 0 : (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF ))',
        '  [ $(( $(ip2int "$ip") & mask )) -eq $(( $(ip2int "$net") & mask )) ]',
        '}',
        '# IPv6 with python3 (ipaddress) when it is there: a full check, and one written',
        '# form (compressed, lower case) so the file and the stack\'s list compare line by',
        '# line. Without python3 only the shape is checked and case is folded.',
        'valid_cidr6() {',
        '  if command -v python3 >/dev/null; then python3 -c \'import ipaddress,sys; ipaddress.IPv6Network(sys.argv[1], strict=True)\' "$1" 2>/dev/null; return; fi',
        '  [[ "$1" =~ ^[0-9A-Fa-f:]+/[0-9]{1,3}$ ]] && [[ "$1" == *:*:* ]] && [ "${1#*/}" -le 128 ]',
        '}',
        'in_cidr6() { python3 -c \'import ipaddress,sys; sys.exit(0 if ipaddress.ip_address(sys.argv[1]) in ipaddress.ip_network(sys.argv[2], strict=False) else 1)\' "$1" "$2" 2>/dev/null; }',
        'canon6() { if command -v python3 >/dev/null; then python3 -c \'import ipaddress,sys; [print(ipaddress.ip_network(l.strip(), strict=False)) for l in sys.stdin if l.strip()]\'; else tr "A-F" "a-f"; fi; }',
        'valid() { if [ "$V6" = 1 ]; then valid_cidr6 "$1"; else valid_cidr "$1"; fi; }',
        'in_net() { if [ "$V6" = 1 ]; then in_cidr6 "$1" "$2"; else in_cidr "$1" "$2"; fi; }',
        'canon() { if [ "$V6" = 1 ]; then canon6; else cat; fi; }',
        '',
        'read_list() {',
        '  [ -f "$1" ] || die "not found: $1"',
        '  local bad=0 c',
        '  : > "$WORK/list.raw"',
        '  while IFS= read -r c || [ -n "$c" ]; do',
        '    c=\${c%%#*}; c=\${c//[[:space:]]/}',
        '    [ -n "$c" ] || continue',
        '    if valid "$c"; then echo "$c" >> "$WORK/list.raw"; else note "invalid CIDR (or host bits set): $c"; bad=1; fi',
        '  done < "$1"',
        '  canon < "$WORK/list.raw" | sort -u',
        '  return $bad',
        '}',
        '',
        'body() { jq -n --args \'{subnets: $ARGS.positional}\' "$@"; }',
        '',
        '# The subnets on the list now, one per line, into $WORK/live. An HTTP error or a',
        '# response without a subnets array fails: it never reads as an empty list.',
        'live_list() {',
        '  acs GET "$AL" > "$WORK/live.json" || return 1',
        '  jq -r \'if (.subnets | type) == "array" then .subnets[] else error("no subnets array") end\' "$WORK/live.json" | canon | sort -u > "$WORK/live"',
        '}',
        '# Read-back checks for wait_applied: every line of FILE on the list / none of them.',
        'all_present() { live_list || return 1; comm -13 "$WORK/live" "$1" > "$WORK/missing"; [ ! -s "$WORK/missing" ]; }',
        'all_absent() { live_list || return 1; comm -12 "$WORK/live" "$1" > "$WORK/still"; [ ! -s "$WORK/still" ]; }',
        'outbound_visible() { acs GET "/access/outbound-ports/$1" > /dev/null 2>&1; }',
        '# covers IP FILE: some CIDR in FILE contains IP.',
        'covers() { local c; while IFS= read -r c; do [ -n "$c" ] && in_net "$1" "$c" && return 0; done < "$2"; return 1; }',
        '',
        'case "$CMD" in',
        '  show)',
        '    live_list || die "could not read the $FEATURE allow list"',
        '    cat "$WORK/live"',
        '    ;;',
        '  plan|apply)',
        '    read_list "$SUBNETS_FILE" > "$WORK/desired" || die "fix the subnets file first"',
        '    [ -s "$WORK/desired" ] || die "$SUBNETS_FILE is empty; an empty allow list blocks everyone"',
        '    grep -qx "$OPEN" "$WORK/desired" && die "$SUBNETS_FILE contains $OPEN"',
        '    live_list || die "could not read the $FEATURE allow list; not planning against a guess"',
        '    cp "$WORK/live" "$WORK/current"',
        '    comm -13 "$WORK/current" "$WORK/desired" > "$WORK/add"',
        '    : > "$WORK/remove"',
        '    if [ "$REMOVE_OPEN" = 1 ]; then grep -x "$OPEN" "$WORK/current" >> "$WORK/remove" || true; fi',
        '    if [ "$EXACT" = 1 ]; then comm -23 "$WORK/current" "$WORK/desired" >> "$WORK/remove"; fi',
        '    sort -u -o "$WORK/remove" "$WORK/remove"',
        '    sort -u "$WORK/current" "$WORK/add" | comm -23 - "$WORK/remove" > "$WORK/after"',
        '    echo "allow list $FEATURE on $STACK:"',
        '    sed "s/^/  keep    /" <(comm -12 "$WORK/current" "$WORK/after")',
        '    sed "s/^/  ADD     /" "$WORK/add"',
        '    sed "s/^/  REMOVE  /" "$WORK/remove"',
        '    [ "$(wc -l < "$WORK/after")" -le 200 ] || die "more than 200 subnets after the change; ACS will refuse"',
        '    # The search-api and search-ui lists also decide whether you can get back in.',
        '    ME=""',
        '    if [[ "$FEATURE" == search-* ]] && [ -s "$WORK/remove" ] && [ "$ALLOW_LOCKOUT" != 1 ] && [ "$V6" = 1 ]; then',
        '      # The IPv6 list decides access only for a host that reaches the stack over IPv6.',
        '      ME=$(curl -6 -fsS --max-time 10 https://api6.ipify.org | tr -d "[:space:]") || ME=""',
        '      if [ -z "$ME" ]; then',
        '        echo "  (this host has no public IPv6 address; the IPv6 list does not decide its access)"',
        '      else',
        '        command -v python3 >/dev/null || die "python3 is needed to check $ME against the IPv6 list; pass --allow-lockout if you are sure"',
        '        covers "$ME" "$WORK/after" || die "this host ($ME) would not be in the IPv6 $FEATURE list afterwards. Add it, or pass --allow-lockout if you reach the stack another way."',
        '        echo "  (this host, $ME, stays allowed)"',
        '      fi',
        '    elif [[ "$FEATURE" == search-* ]] && [ -s "$WORK/remove" ] && [ "$ALLOW_LOCKOUT" != 1 ]; then',
        '      ME=$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d "[:space:]") || die "could not find this host\'s public address; pass --allow-lockout if you are sure"',
        '      [[ "$ME" =~ ^([0-9]{1,3}\\.){3}[0-9]{1,3}$ ]] || die "checkip.amazonaws.com returned \'$ME\', not an IPv4 address; pass --allow-lockout if you are sure"',
        '      covers "$ME" "$WORK/after" || die "this host ($ME) would not be in the $FEATURE list afterwards. Add it, or pass --allow-lockout if you reach the stack another way."',
        '      echo "  (this host, $ME, stays allowed)"',
        '    fi',
        '    if [ ! -s "$WORK/add" ] && [ ! -s "$WORK/remove" ]; then echo "no change"; exit 0; fi',
        '    if [ "$CMD" = plan ]; then echo "Plan only: nothing was changed. Run apply to make these changes."; exit 0; fi',
        '    [ "$EXECUTE" = 1 ] || { echo "Dry run: nothing was changed. Run it without --dry-run to apply."; exit 0; }',
        '    if [ -s "$WORK/add" ]; then',
        '      mapfile -t a < "$WORK/add"; body "\${a[@]}" > "$WORK/add.json"',
        '      acs_json POST "$AL" "$WORK/add.json" > /dev/null',
        '      # Not just the first Ready: the new subnets must read back on the list, and the',
        '      # stack must have settled, before anything is removed.',
        '      wait_applied "adding \${#a[@]} to $FEATURE" all_present "$WORK/add"',
        '      echo "added \${#a[@]}"',
        '    fi',
        '    if [ -s "$WORK/remove" ]; then',
        '      # The lockout guard again, against the list as it is now rather than as planned.',
        '      if [ -n "$ME" ]; then',
        '        live_list || die "could not re-read the $FEATURE list before removing; nothing removed"',
        '        comm -23 "$WORK/live" "$WORK/remove" > "$WORK/live-after"',
        '        covers "$ME" "$WORK/live-after" || die "after removing, this host ($ME) would not be on the live $FEATURE list; nothing removed"',
        '      fi',
        '      mapfile -t r < "$WORK/remove"; body "\${r[@]}" > "$WORK/remove.json"',
        '      acs_json DELETE "$AL" "$WORK/remove.json" > /dev/null',
        '      wait_applied "removing \${#r[@]} from $FEATURE" all_absent "$WORK/remove"',
        '      echo "removed \${#r[@]}"',
        '    fi',
        '    live_list || die "could not read the $FEATURE list back"',
        '    diff "$WORK/live" "$WORK/after" || die "the $FEATURE list does not match the plan (diff above: < on the stack, > planned)"',
        '    echo "$FEATURE now matches the plan"',
        '    ;;',
        '  outbound-plan|outbound-apply)',
        '    [ -f "$HERE/outbound-ports.spec" ] || die "not found: $HERE/outbound-ports.spec"',
        '    OB="$WORK/outbound.json"',
        '    sed "/^[[:space:]]*#/d" "$HERE/outbound-ports.spec" | jq . > "$OB" || die "outbound-ports.spec is not valid JSON after its comments"',
        "    port=$(jq -r '.outboundPorts[0].port // empty' \"$OB\")",
        '    [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "outbound-ports.spec: outboundPorts[0].port is not a port"',
        "    jq -r '.outboundPorts[0].subnets[]' \"$OB\" | while IFS= read -r c; do valid_cidr \"$c\" || die \"invalid destination $c\"; [ \"$c\" != 0.0.0.0/0 ] || die \"0.0.0.0/0 as a destination lets the stack send anywhere\"; done",
        '    echo "current rule for port $port:"',
        '    acs GET "/access/outbound-ports/$port" 2>/dev/null | jq . || echo "  (none)"',
        '    echo "$(mode)  outbound port $port to: $(jq -r \'.outboundPorts[0].subnets | join(", ")\' "$OB")"',
        '    [ "$CMD" = outbound-apply ] && [ "$EXECUTE" = 1 ] || exit 0',
        '    # A rule cannot be edited: to change its subnets, delete it and create it again',
        '    # (VERIFY: DELETE /access/outbound-ports/{port} takes {"subnets": [...]} as its body).',
        '    acs_json POST /access/outbound-ports "$OB" > /dev/null',
        '    wait_applied "outbound port $port" outbound_visible "$port"',
        '    acs GET "/access/outbound-ports/$port" | jq .',
        '    ;;',
        '  *) die "unknown command $CMD (try --help)" ;;',
        'esac',
      ];

      const ports                         = { 'search-api': '8089', 'search-ui': '443', hec: '443', s2s: '9997', 'idm-api': '8089', 'idm-ui': '443' };
      const probeHost = feature === 'hec' ? `http-inputs-${stack}.splunkcloud.com` : feature === 's2s' ? `inputs1.${stack}.splunkcloud.com` : feature.startsWith('idm') ? `idm-${stack}.splunkcloud.com` : `${stack}.splunkcloud.com`;

      return {
        tier: TIER,
        title: `${feature} allow list on ${stack}: ${total} subnet${total === 1 ? '' : 's'}${unique6.length > 0 ? ` (${unique6.length} IPv6)` : ''}${outbound ? `, outbound ${outPort}` : ''}`,
        app,
        activation: 'reload',
        notes: [
          TOKEN_NOTE,
          'Splunk Cloud sees the public address your traffic leaves from — the NAT gateway, proxy or VPN egress — never a private 10.x or 192.168.x address. Find it with curl https://checkip.amazonaws.com from the network that needs access.',
          `Changes take several minutes to apply (the script waits for the stack to report Ready). ${feature} controls port ${ports[feature]}.`,
          'Each list is separate: allowing an address on search-ui does not let it use the REST API (search-api), send HEC, or connect forwarders (s2s). Forwarders also need the Cloud universal forwarder credentials app; allowing s2s is only the network half.',
          ...(outbound ? [`Outbound port ${outPort} lets the stack connect out to ${outValid.join(', ')}. A rule cannot be edited — to change its destinations, delete and recreate it.`] : []),
          ...(unique6.length > 0
            ? [
                `IPv6: ${unique6.length} subnet${unique6.length === 1 ? '' : 's'} in ops/allowlist-${feature}-v6.txt go to the separate IPv6 list (…/access/${feature}/ipallowlists-v6), applied with --ipv6. The IPv4 and IPv6 lists are independent: a client is checked against the list of the family it connects with.`,
                'VERIFY: that your stack offers the IPv6 list for this feature (GET …/ipallowlists-v6 answers), and the acs CLI option for IPv6 lists (acs ip-allowlist --help).',
              ]
            : []),
        ],
        before: [
          `bash ops/acs-network.sh show --feature ${feature} --stack ${stack}   # save this output: it is the back-out`,
          `bash ops/acs-network.sh plan --feature ${feature} --stack ${stack}`,
          'curl -fsS https://checkip.amazonaws.com   # the address this host is seen from',
          ...(unique6.length > 0
            ? [`bash ops/acs-network.sh show --ipv6 --feature ${feature} --stack ${stack}   # the IPv6 list, also the back-out`, `bash ops/acs-network.sh plan --ipv6 --feature ${feature} --stack ${stack}`, 'curl -6 -fsS https://api6.ipify.org   # the IPv6 address this host is seen from, if it has one']
            : []),
        ],
        files: {
          'default/app.conf': kitConf(app, `ACS network access for ${stack}`),
          ...(unique.length > 0 || unique6.length === 0 ? { [`ops/allowlist-${feature}.txt`]: [`# ${feature} allow list for ${stack}. One public IPv4 CIDR per line.`, ...unique] } : {}),
          ...(unique6.length > 0 ? { [`ops/allowlist-${feature}-v6.txt`]: [`# ${feature} IPv6 allow list for ${stack}. One global IPv6 CIDR per line; applied with --ipv6.`, ...unique6] } : {}),
          'ops/acs-network.sh': sh,
          ...(outbound
            ? { 'ops/outbound-ports.spec': ['# The outbound rule sent to ACS: JSON after these comment lines, which the script strips.', ...JSON.stringify({ outboundPorts: [{ subnets: outValid, port: outPort }], reason: outReason }, null, 2).split('\n')] }
            : {}),
          'ops/acs-cli.txt': [
            '# acs CLI equivalents (token from STACK_TOKEN). VERIFY flags with --help.',
            `acs ip-allowlist describe ${feature}`,
            ...(unique.length > 0 || unique6.length === 0 ? [`acs ip-allowlist create ${feature} --subnets ${unique.join(',')}`] : []),
            ...(removeOpen ? [`acs ip-allowlist delete ${feature} --subnets 0.0.0.0/0   # only after the create has applied`] : []),
            ...(unique6.length > 0 ? [`# IPv6 (${unique6.join(',')}): use acs-network.sh --ipv6 or the REST path below; VERIFY the CLI's IPv6 option with acs ip-allowlist --help.`] : []),
            ...(outbound ? [`acs outbound-port create ${outPort} --subnets ${outValid.join(',')}`, `acs outbound-port describe ${outPort}`] : []),
            'acs status current-stack',
            '',
            '# REST: GET/POST/DELETE https://admin.splunk.com/{stack}/adminconfig/v2/access/{feature}/ipallowlists  body {"subnets": [...]}',
            ...(unique6.length > 0 ? ['#       GET/POST/DELETE https://admin.splunk.com/{stack}/adminconfig/v2/access/{feature}/ipallowlists-v6  body {"subnets": [...]} (IPv6)'] : []),
            '#       POST https://admin.splunk.com/{stack}/adminconfig/v2/access/outbound-ports  body {"outboundPorts": [{"subnets": [...], "port": N}], "reason": "..."}',
          ],
        },
        verify: [
          `bash ops/acs-network.sh plan --feature ${feature} --stack ${stack}   # "no change"`,
          `nc -vz -w 5 ${probeHost} ${ports[feature]}   # from an allowed network: open; from elsewhere: times out`,
          ...(unique6.length > 0 ? [`bash ops/acs-network.sh plan --ipv6 --feature ${feature} --stack ${stack}   # "no change"`, `nc -6 -vz -w 5 ${probeHost} ${ports[feature]}   # over IPv6, from an allowed IPv6 network`] : []),
          ...(outbound ? [`bash ops/acs-network.sh outbound-plan --stack ${stack}`] : []),
        ],
        backout: [
          `# Put back the subnets from the "show" output taken before: write them to a file and run`,
          `bash ops/acs-network.sh apply --feature ${feature} --subnets-file before.txt --exact --keep-open --stack ${stack}`,
          ...(unique6.length > 0 ? [`bash ops/acs-network.sh apply --ipv6 --feature ${feature} --subnets-file before-v6.txt --exact --keep-open --stack ${stack}`] : []),
          '# In an emergency (locked out of search-api and search-ui): the Splunk Cloud Admin UI is also blocked, so open a P1 case with Splunk Support to restore access.',
          ...(outbound ? [`acs outbound-port delete ${outPort} --subnets ${outValid.join(',')}`] : []),
        ],
        findings,
      };
    },
  }),

  // 10. Apps ----------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_acs_apps',
    tier: TIER,
    label: 'Private and Splunkbase apps through ACS',
    group: 'Admin Config Service',
    description: 'A private app checked locally with splunk-appinspect against the Splunk Cloud tags, packaged the way vetting expects (no local/, no compiled Python, correct app.conf), and installed through ACS with an AppInspect token — or a Splunkbase app installed by ID with its licence acknowledged — for the Victoria or Classic experience.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_cloud_apps' },
      { id: 'stack', label: 'Stack', control: 'text', default: 'example-stack' },
      { id: 'experience', label: 'Stack experience', control: 'select', default: 'victoria', options: [
        { value: 'victoria', label: 'Victoria (most stacks since 2022)' },
        { value: 'classic', label: 'Classic' },
      ] },
      { id: 'source', label: 'App source', control: 'select', default: 'private', options: [
        { value: 'private', label: 'A private app of our own' },
        { value: 'splunkbase', label: 'Splunkbase' },
      ] },
      { id: 'private_app', label: 'App folder (its id)', control: 'text', default: 'org_custom_app', showWhen: { input: 'source', equals: ['private'] } },
      { id: 'private_version', label: 'Version', control: 'text', default: '1.0.0', hint: 'Must go up with every upload', showWhen: { input: 'source', equals: ['private'] } },
      { id: 'tags', label: 'AppInspect tags', control: 'select', default: 'auto', options: [
        { value: 'auto', label: 'The private-app checks for this stack’s experience' },
        { value: 'private_victoria', label: 'private_victoria — private app, Victoria' },
        { value: 'private_classic', label: 'private_classic — private app, Classic' },
        { value: 'cloud', label: 'cloud — all Splunk Cloud checks' },
      ], showWhen: { input: 'source', equals: ['private'] } },
      { id: 'splunkbase_id', label: 'Splunkbase app ID', control: 'text', default: '833', hint: 'From the URL: splunkbase.splunk.com/app/833 is the Splunk Add-on for Unix and Linux', showWhen: { input: 'source', equals: ['splunkbase'] } },
      { id: 'splunkbase_version', label: 'Version', control: 'text', default: '', placeholder: 'empty = latest', showWhen: { input: 'source', equals: ['splunkbase'] } },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_cloud_apps'), 'org_cloud_apps');
      const stack = stackOf(values);
      const victoria = str(values, 'experience', 'victoria') !== 'classic';
      const privateApp = str(values, 'source', 'private') === 'private';
      const appId = str(values, 'private_app', 'org_custom_app');
      const version = str(values, 'private_version', '1.0.0');
      const tagChoice = str(values, 'tags', 'auto');
      const tags = tagChoice === 'auto' ? (victoria ? 'private_victoria' : 'private_classic') : tagChoice;
      const sbId = str(values, 'splunkbase_id', '');
      const sbVersion = str(values, 'splunkbase_version', '');
      const findings            = [...stackFindings(stack)];
      const appsPath = victoria ? '/apps/victoria' : '/apps';

      if (privateApp) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(appId)) findings.push(error('splunk.acs-app-id', `"${appId}" is not a usable app id: letters, digits, _ . and -, the same as the folder name and [package] id in app.conf.`, { source: 'ArchToolKit' }));
        if (/^(Splunk_|SA-|DA-|TA-|splunk_|search$|launcher$)/.test(appId)) {
          findings.push(warning('splunk.acs-app-reserved', `${appId} looks like a Splunk or Splunkbase app id. A private app with the same id as a Splunkbase app is refused, or replaces it; prefix private apps with your organisation.`, { source: 'ArchToolKit' }));
        }
        if (!/^\d+\.\d+\.\d+$/.test(version)) findings.push(warning('splunk.acs-app-version', `"${version}" is not major.minor.patch. AppInspect expects a semantic version in app.conf [launcher] version, and each upload must be higher than the installed one.`, { source: 'ArchToolKit' }));
        if (victoria && tags === 'private_classic') findings.push(error('splunk.acs-app-tags', 'private_classic is the check set for Classic stacks; a Victoria stack vets against private_victoria.', { source: 'ArchToolKit' }));
        if (!victoria && tags === 'private_victoria') findings.push(error('splunk.acs-app-tags', 'private_victoria is the check set for Victoria stacks; a Classic stack vets against private_classic.', { source: 'ArchToolKit' }));
      } else {
        if (!/^\d+$/.test(sbId)) findings.push(error('splunk.acs-splunkbase-id', `"${sbId}" is not a Splunkbase app ID; it is the number in the app’s Splunkbase URL.`, { source: 'ArchToolKit' }));
        if (!sbVersion) findings.push(info('splunk.acs-splunkbase-latest', 'No version: the latest Splunkbase release is installed. Pin the version you tested, so the stack and your test environment match.', { source: 'ArchToolKit' }));
        if (!victoria) findings.push(info('splunk.acs-splunkbase-classic', 'On Classic, ACS upgrades a Splunkbase app to the latest version only — no pinning and no downgrade.', { source: 'ArchToolKit' }));
      }
      findings.push(info('splunk.acs-app-experience', `Written for the ${victoria ? 'Victoria' : 'Classic'} experience (${appsPath}). Check which your stack is: the script reads it from GET /adminconfig/v2/status (VERIFY the field) and refuses a mismatch; the stack’s About page also shows it.`, { source: 'ArchToolKit' }));

      const pkg = `dist/${appId}-${version}.tgz`;

      const inspect = [
        '#!/usr/bin/env bash',
        '# Package a private app the way Splunk Cloud vetting expects, and run',
        '# splunk-appinspect locally against the Splunk Cloud checks before uploading.',
        '# Nothing here needs a credential; it runs entirely on this machine.',
        '#',
        `# usage: appinspect-local.sh [APP_DIR] [--tags ${tags}] [--dry-run]`,
        '#   with --dry-run: show what would be packaged and the checks that would run',
        '#   APP_DIR defaults to the app folder named below, next to this package',
        'set -euo pipefail',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        `APP_ID=${shq(appId)}`,
        `TAGS=${shq(tags)}`,
        'APP_DIR=""; EXECUTE=1',
        'while [ $# -gt 0 ]; do',
        '  case $1 in',
        '    --tags) TAGS=$2; shift 2 ;;',
        '    --dry-run) EXECUTE=0; shift ;;',
        '    -*) printf "unknown option: %s\\n" "$1" >&2; exit 2 ;;',
        '    *) APP_DIR=$1; shift ;;',
        '  esac',
        'done',
        '[ -n "$APP_DIR" ] || APP_DIR="$HERE/../../$APP_ID"',
        'die() { printf "error: %s\\n" "$*" >&2; exit 2; }',
        '[ -d "$APP_DIR" ] || die "no app directory at $APP_DIR"',
        'APP_DIR=$(cd "$APP_DIR" && pwd)',
        'NAME=$(basename "$APP_DIR")',
        '',
        '# What vetting rejects before it looks at anything else.',
        'problems=0',
        'flag() { printf "  FAIL  %s\\n" "$*"; problems=$((problems + 1)); }',
        '[ -f "$APP_DIR/default/app.conf" ] || flag "default/app.conf is missing"',
        'pid=$(awk -F"=" \'/^\\[package\\]/{p=1;next} /^\\[/{p=0} p && $1 ~ /^[ \\t]*id[ \\t]*$/ {gsub(/[ \\t]/,"",$2); print $2}\' "$APP_DIR/default/app.conf" 2>/dev/null || true)',
        '[ "$pid" = "$NAME" ] || flag "app.conf [package] id is \'$pid\', the folder is \'$NAME\'; they must match"',
        'ver=$(awk -F"=" \'/^\\[launcher\\]/{p=1;next} /^\\[/{p=0} p && $1 ~ /^[ \\t]*version[ \\t]*$/ {gsub(/[ \\t]/,"",$2); print $2}\' "$APP_DIR/default/app.conf" 2>/dev/null || true)',
        '[ -n "$ver" ] || flag "app.conf [launcher] version is not set"',
        '[ -d "$APP_DIR/local" ] && flag "local/ exists: merge it into default/ — Cloud vetting fails an app with a local directory"',
        '[ -f "$APP_DIR/metadata/local.meta" ] && flag "metadata/local.meta exists: merge it into default.meta"',
        'find "$APP_DIR" \\( -name "*.pyc" -o -name "__pycache__" -o -name ".DS_Store" -o -name ".git" \\) -print | sed "s/^/  FAIL  compiled or hidden: /" | grep . && problems=$((problems + 1)) || true',
        'find "$APP_DIR" -type f -perm -o+w -print | sed "s/^/  FAIL  world-writable: /" | grep . && problems=$((problems + 1)) || true',
        'grep -rIlE "^[[:space:]]*(password|token|pass4SymmKey|sslPassword)[[:space:]]*=[[:space:]]*[^[:space:]<$]" "$APP_DIR" --include="*.conf" | sed "s/^/  FAIL  a credential in: /" | grep . && problems=$((problems + 1)) || true',
        'echo "$NAME $ver: $problems packaging problem(s)"',
        '',
        'PKG="$HERE/../dist/$NAME-$ver.tgz"',
        'REPORT="$HERE/../dist/$NAME-$ver.appinspect.json"',
        'if [ "$EXECUTE" != 1 ]; then',
        '  echo "DRY RUN: tar the app (owner-writable files, no hidden files) into $PKG"',
        '  echo "DRY RUN: splunk-appinspect inspect $PKG --mode precert --included-tags $TAGS --data-format json --output-file $REPORT"',
        '  exit 0',
        'fi',
        '[ "$problems" -eq 0 ] || die "fix the packaging problems above first"',
        'mkdir -p "$HERE/../dist"',
        '',
        '# A tar made on macOS carries extended attributes (._ files) unless told not to.',
        'COPYFILE_DISABLE=1 tar -C "$(dirname "$APP_DIR")" --exclude=".*" --exclude="local" --exclude="*.pyc" --exclude="__pycache__" -czf "$PKG" "$NAME"',
        'echo "packaged $PKG"',
        '',
        '# splunk-appinspect in its own virtual environment (Python 3.9+, and libmagic',
        '# from the OS: apt install libmagic1 / brew install libmagic). VERIFY the',
        '# current supported Python version on the AppInspect release notes.',
        'VENV="$HERE/../.venv-appinspect"',
        'if [ ! -x "$VENV/bin/splunk-appinspect" ]; then',
        '  python3 -m venv "$VENV"',
        '  "$VENV/bin/pip" install --quiet --upgrade pip splunk-appinspect',
        'fi',
        '"$VENV/bin/splunk-appinspect" inspect "$PKG" --mode precert --included-tags "$TAGS" --data-format json --output-file "$REPORT" > /dev/null || true',
        '[ -s "$REPORT" ] || die "appinspect produced no report"',
        "jq -r '.summary | \"failure=\\(.failure) error=\\(.error) manual_check=\\(.manual_check) warning=\\(.warning) success=\\(.success)\"' \"$REPORT\"",
        "jq -r '.reports[]?.groups[]?.checks[]? | select(.result == \"failure\" or .result == \"error\" or .result == \"manual_check\") | \"  \\(.result | ascii_upcase)  \\(.name): \\((.messages // [])[0].message // \"\" | .[0:200])\"' \"$REPORT\"",
        "jq -e '.summary | (.failure | type) == \"number\" and (.error | type) == \"number\" and (.manual_check | type) == \"number\"' \"$REPORT\" > /dev/null || die \"the report has no summary counts; treat it as failed\"",
        "fails=$(jq '.summary.failure + .summary.error' \"$REPORT\")",
        "manual=$(jq '.summary.manual_check' \"$REPORT\")",
        '[ "$fails" -eq 0 ] || die "$fails failure(s) or error(s): the upload would be rejected"',
        '[ "$manual" -eq 0 ] || echo "note: $manual manual check(s). ACS self-service installs need 0; these go to Splunk\'s vetting team, which takes days."',
        'echo "ready to upload: $PKG"',
      ];

      const install = [
        '#!/usr/bin/env bash',
        '# Splunk Cloud apps through the Admin Config Service.',
        '#',
        '# usage: acs-apps.sh COMMAND [options]',
        '#   list                                    installed apps',
        '#   describe NAME',
        '#   install-private PKG --appinspect-login F',
        '#   install-splunkbase ID [--version V] [--license-url URL] --splunkbase-login F',
        '#   upgrade-splunkbase NAME --version V [--license-url URL] --splunkbase-login F',
        '#   uninstall NAME --confirm NAME',
        '# options: --stack S  --token-file F (the ACS token, mode 600)  --dry-run (preview only)',
        '#   --appinspect-login F   mode 600: line 1 your splunk.com user, line 2 its password',
        '#   --splunkbase-login F   mode 600: the same, for Splunkbase',
        '#',
        '# The splunk.com password is sent to api.splunk.com / splunkbase.splunk.com from',
        '# a private curl config file (curl -K), and the tokens that come back go to ACS',
        '# from private header files. Nothing secret is ever an argument.',
        'set -euo pipefail',
        ...acsArgs(stack, [
          '--appinspect-login) AI_LOGIN=$2; shift 2 ;;',
          '--splunkbase-login) SB_LOGIN=$2; shift 2 ;;',
          '--version) VERSION=$2; shift 2 ;;',
          '--license-url) LICENSE_URL=$2; shift 2 ;;',
        ]).flatMap((line) => (line.startsWith('CMD=') ? [`EXPERIENCE=${shq(victoria ? 'victoria' : 'classic')}`, 'AI_LOGIN=""; SB_LOGIN=""; VERSION=""; LICENSE_URL=""', line] : [line])),
        '',
        ...acsPrelude(),
        '',
        'case "$CMD" in help|-h|--help) sed -n "2,18p" "$0"; exit 0 ;; esac',
        'setup_acs',
        'if [ "$EXPERIENCE" = victoria ]; then APPS=/apps/victoria; else APPS=/apps; fi',
        '',
        '# The experience decides the endpoint; installing through the wrong one fails.',
        '# A failed read stops here; only a missing field (whose name is VERIFY) is tolerated.',
        'acs GET /status > "$WORK/status.json" || die "could not read the stack status (GET /status)"',
        "actual=$(jq -r '.infrastructure.stackType // empty' \"$WORK/status.json\" 2>/dev/null) || actual=\"\"",
        'if [ -n "$actual" ] && [ "$actual" != "$EXPERIENCE" ]; then die "this stack reports stackType=$actual, but the package was generated for $EXPERIENCE"; fi',
        '[ -n "$actual" ] || note "could not read the stack type from /status (VERIFY); assuming $EXPERIENCE"',
        '',
        '# login_cfg FILE -> a private curl config with the user and password from FILE.',
        'login_cfg() {',
        '  check_private "$1"',
        '  local u="" p=""',
        '  { IFS= read -r u; IFS= read -r p; } < "$1" || true',
        "  u=\${u%$'\\r'}; p=\${p%$'\\r'}",
        '  [ -n "$u" ] && [ -n "$p" ] || die "$1 needs a user name line and a password line"',
        '  esc() { local s=$1; s=\${s//\\\\/\\\\\\\\}; s=\${s//\\"/\\\\\\"}; printf \'%s\' "$s"; }',
        '  printf \'user = "%s:%s"\\n\' "$(esc "$u")" "$(esc "$p")" > "$WORK/basic.cfg"',
        '  printf \'data-urlencode = "username=%s"\\ndata-urlencode = "password=%s"\\n\' "$(esc "$u")" "$(esc "$p")" > "$WORK/form.cfg"',
        '  u=""; p=""',
        '}',
        '',
        '# An AppInspect API token: GET api.splunk.com login with basic auth.',
        'appinspect_token() {',
        '  [ -n "$AI_LOGIN" ] || die "--appinspect-login FILE is required"',
        '  login_cfg "$AI_LOGIN"',
        '  curl -sS --fail -K "$WORK/basic.cfg" https://api.splunk.com/2.0/rest/login/splunk > "$WORK/ai.json" || die "AppInspect login failed"',
        '  jq -j \'.data.token // empty\' "$WORK/ai.json" > "$WORK/ai.token"',
        '  [ -s "$WORK/ai.token" ] || die "no token in the AppInspect login response"',
        '  { printf \'X-Splunk-Authorization: \'; cat "$WORK/ai.token"; printf \'\\n\'; } > "$WORK/ai.h"',
        '  # Classic takes the same token as a form field; curl reads it from a config file.',
        '  { printf \'form = "token=\'; cat "$WORK/ai.token"; printf \'"\\n\'; } > "$WORK/ai-form.cfg"',
        '}',
        '',
        '# A Splunkbase session id: POST splunkbase.splunk.com/api/account:login.',
        'splunkbase_session() {',
        '  [ -n "$SB_LOGIN" ] || die "--splunkbase-login FILE is required"',
        '  login_cfg "$SB_LOGIN"',
        '  curl -sS --fail -K "$WORK/form.cfg" https://splunkbase.splunk.com/api/account:login > "$WORK/sb.xml" || die "Splunkbase login failed"',
        '  sed -n \'s:.*<id>\\([^<]*\\)</id>.*:\\1:p\' "$WORK/sb.xml" | head -1 | tr -d "\\n" > "$WORK/sb.id"',
        '  [ -s "$WORK/sb.id" ] || die "no session id in the Splunkbase login response"',
        '  { printf \'X-Splunkbase-Authorization: \'; cat "$WORK/sb.id"; printf \'\\n\'; } > "$WORK/sb.h"',
        '}',
        '',
        '# The licence URL for ACS-Licensing-Ack: --license-url, or the one Splunkbase',
        '# lists for app ID. ACS requires the header on install (POST) and on a version',
        '# change (PATCH) alike.',
        'resolve_license() {',
        '  [ -n "$LICENSE_URL" ] && return 0',
        '  [[ "$1" =~ ^[0-9]+$ ]] || die "no Splunkbase ID to look the licence up with; pass --license-url"',
        '  # VERIFY: the Splunkbase API field that carries the licence URL.',
        '  curl -fsS "https://splunkbase.splunk.com/api/v1/app/$1/?include=release" > "$WORK/sbapp.json" || die "could not read Splunkbase app $1; pass --license-url"',
        "  LICENSE_URL=$(jq -r '.release.license_url // .license_url // empty' \"$WORK/sbapp.json\")",
        '  [ -n "$LICENSE_URL" ] || die "could not find the licence URL; pass --license-url (ACS names it in its error if it is wrong)"',
        '}',
        '',
        'wait_app() {',
        '  local i s',
        '  for i in $(seq 1 60); do',
        "    s=$(acs GET \"$APPS/$(enc \"$1\")\" 2>/dev/null | jq -r '.status // empty') || s=\"\"",
        '    [ "$s" = installed ] && { echo "$1: installed"; return 0; }',
        '    note "$1: \${s:-pending}"',
        '    sleep 20',
        '  done',
        '  die "$1 did not reach installed within 20 minutes"',
        '}',
        '',
        'case "$CMD" in',
        '  list)',
        '    # Every app, 100 per request, paged until ACS has no more (fetch_all).',
        '    fetch_all "$APPS" apps "$WORK/apps.json"',
        '    jq -r \'.[] | [.name, .version, .status, (.label // "")] | @tsv\' "$WORK/apps.json" | sort | awk -F"\\t" \'{printf "%-40s %-12s %-12s %s\\n",$1,$2,$3,$4}\'',
        '    ;;',
        '  describe)',
        '    [ -n "$TARGET" ] || die "describe needs an app name"',
        '    acs GET "$APPS/$(enc "$TARGET")" | jq .',
        '    ;;',
        '  install-private)',
        '    [ -n "$TARGET" ] && [ -f "$TARGET" ] || die "install-private needs the package from appinspect-local.sh"',
        '    tar -tzf "$TARGET" | grep -qE "^[^/]+/local/" && die "the package contains local/; rebuild it with appinspect-local.sh"',
        '    name=$(tar -tzf "$TARGET" | head -1 | cut -d/ -f1)',
        '    echo "$(mode)  install private app $name from $TARGET on $STACK ($EXPERIENCE)"',
        '    [ "$EXECUTE" = 1 ] || exit 0',
        '    appinspect_token',
        '    # ACS runs AppInspect itself with this token; the upload fails on any failure,',
        '    # error or manual check. VERIFY the content type ACS expects on your release.',
        '    if [ "$EXPERIENCE" = victoria ]; then',
        '      acs POST "$APPS" -H @"$WORK/ai.h" -H "ACS-Legal-Ack: Y" --data-binary @"$TARGET" | jq .',
        '    else',
        '      acs POST "$APPS" -H "ACS-Legal-Ack: Y" -K "$WORK/ai-form.cfg" -F "package=@$TARGET" | jq .',
        '    fi',
        '    wait_app "$name"',
        '    ;;',
        '  install-splunkbase)',
        '    [[ "$TARGET" =~ ^[0-9]+$ ]] || die "install-splunkbase needs the numeric Splunkbase ID"',
        '    resolve_license "$TARGET"',
        '    echo "$(mode)  install Splunkbase app $TARGET \${VERSION:+version $VERSION }on $STACK, accepting the licence at $LICENSE_URL"',
        '    [ "$EXECUTE" = 1 ] || exit 0',
        '    splunkbase_session',
        '    args=(--data-urlencode "splunkbaseID=$TARGET")',
        '    [ -n "$VERSION" ] && args+=(--data-urlencode "version=$VERSION")',
        '    acs POST "$APPS?splunkbase=true" -H @"$WORK/sb.h" -H "ACS-Licensing-Ack: $LICENSE_URL" "\${args[@]}" > "$WORK/inst.json"',
        '    jq . "$WORK/inst.json"',
        "    name=$(jq -r '.name // empty' \"$WORK/inst.json\")",
        '    [ -n "$name" ] || die "ACS accepted the install but returned no app name; follow it with: acs-apps.sh list"',
        '    wait_app "$name"',
        '    ;;',
        '  upgrade-splunkbase)',
        '    [ -n "$TARGET" ] && [ -n "$VERSION" ] || die "upgrade-splunkbase needs NAME and --version"',
        '    acs GET "$APPS/$(enc "$TARGET")" > "$WORK/app.json" || die "no app $TARGET on $STACK"',
        "    sbid=$(jq -r '.splunkbaseID // empty' \"$WORK/app.json\")",
        '    # ACS requires ACS-Licensing-Ack on the update too (Manage Splunkbase apps: the',
        '    # PATCH example sends it). The licence can change between versions: pass',
        '    # --license-url from the target version\'s Splunkbase download page when it has.',
        '    resolve_license "$sbid"',
        '    echo "$(mode)  change $TARGET to version $VERSION, accepting the licence at $LICENSE_URL"',
        '    [ "$EXECUTE" = 1 ] || exit 0',
        '    splunkbase_session',
        '    acs PATCH "$APPS/$(enc "$TARGET")" -H @"$WORK/sb.h" -H "ACS-Licensing-Ack: $LICENSE_URL" --data-urlencode "version=$VERSION" | jq .',
        '    wait_app "$TARGET"',
        '    ;;',
        '  uninstall)',
        '    [ -n "$TARGET" ] || die "uninstall needs an app name"',
        '    [ "$CONFIRM" = "$TARGET" ] || die "uninstalling removes the app and its knowledge objects. Repeat the name: --confirm $TARGET"',
        '    echo "$(mode)  uninstall $TARGET"',
        '    [ "$EXECUTE" = 1 ] || exit 0',
        '    acs DELETE "$APPS/$(enc "$TARGET")" > /dev/null',
        '    echo "uninstall accepted"',
        '    ;;',
        '  *) die "unknown command $CMD (try --help)" ;;',
        'esac',
      ];

      return {
        tier: TIER,
        title: privateApp ? `Private app ${appId} ${version} on ${stack} (${victoria ? 'Victoria' : 'Classic'})` : `Splunkbase app ${sbId}${sbVersion ? ` ${sbVersion}` : ''} on ${stack} (${victoria ? 'Victoria' : 'Classic'})`,
        app,
        activation: 'reload',
        notes: [
          TOKEN_NOTE,
          ...(privateApp
            ? [
                `Run ops/appinspect-local.sh first: it catches the packaging mistakes (local/, local.meta, .pyc files, a [package] id that does not match the folder) and runs splunk-appinspect with --included-tags ${tags}, the same checks ACS will run on upload. Only an app with 0 failures, 0 errors and 0 manual checks installs self-service.`,
                'The AppInspect token comes from your splunk.com account (api.splunk.com login), not from the stack. The script reads the user and password from a mode-600 file and sends them from a private curl config.',
                'Every upload needs a higher version in app.conf. Anything the app needs in local/ on the stack (passwords, per-environment settings) is set after install through the app’s setup page or the storage/passwords endpoint — never in the package.',
                ...(victoria ? ['Victoria installs the app on every search head, and pushes index-time parts (props/transforms) to the indexers itself; a restart, if the app needs one, is handled by ACS.'] : ['Classic: apps that need a restart are installed during a maintenance window by Splunk Cloud operations (VERIFY for your stack); ACS reports the status.']),
              ]
            : [
                'Splunkbase installs need a splunk.com login (for the Splunkbase session) and the app’s licence URL as ACS-Licensing-Ack. Only apps marked as Splunk Cloud compatible on Splunkbase can be installed.',
                `Install the version you tested; on ${victoria ? 'Victoria you can change it later with upgrade-splunkbase' : 'Classic ACS only upgrades to the latest'}.`,
              ]),
        ],
        before: [
          `bash ops/acs-apps.sh list --stack ${stack}`,
          ...(privateApp ? [`bash ops/appinspect-local.sh /path/to/${appId} --dry-run   # packaging checks only`, `bash ops/appinspect-local.sh /path/to/${appId}   # package and inspect`] : [`curl -fsS "https://splunkbase.splunk.com/api/v1/app/${sbId}/?include=release" | jq '{title, release: .release.title}'   # the app and its current release (VERIFY API)`]),
        ],
        files: {
          'default/app.conf': kitConf(app, `ACS app installs for ${stack}`),
          ...(privateApp ? { 'ops/appinspect-local.sh': inspect } : {}),
          'ops/acs-apps.sh': install,
          'ops/acs-cli.txt': [
            '# acs CLI equivalents. The CLI takes the ACS token from STACK_TOKEN and the',
            '# splunk.com credentials for AppInspect / Splunkbase from SPLUNK_USERNAME and',
            '# SPLUNK_PASSWORD — environment variables, set from a file, not typed on the line:',
            '#   export STACK_TOKEN="$(cat ~/.splunk/acs.token)"',
            '#   { read -r SPLUNK_USERNAME; read -r SPLUNK_PASSWORD; } < ~/.splunk/splunkcom.login; export SPLUNK_USERNAME SPLUNK_PASSWORD',
            '# VERIFY flags with: acs apps install --help',
            '',
            'acs apps list',
            ...(privateApp
              ? [`acs apps install private --acs-legal-ack Y --app-package ${pkg}`]
              : [`acs apps install splunkbase --splunkbase-id ${sbId}${sbVersion ? ` --version ${sbVersion}` : ''} --acs-licensing-ack <licence URL>`]),
            `acs apps describe ${privateApp ? appId : '<app name>'}`,
            `acs apps uninstall ${privateApp ? appId : '<app name>'}`,
            '',
            `# REST: ${victoria ? 'POST https://admin.splunk.com/{stack}/adminconfig/v2/apps/victoria  (X-Splunk-Authorization: <AppInspect token>, ACS-Legal-Ack: Y, the package as the body)' : 'POST https://admin.splunk.com/{stack}/adminconfig/v2/apps  (ACS-Legal-Ack: Y, form fields token and package)'}`,
            `#       Splunkbase: POST ${appsPath}?splunkbase=true  (X-Splunkbase-Authorization, ACS-Licensing-Ack, splunkbaseID=, version=)`,
            `#       version change: PATCH ${appsPath}/{app}  (X-Splunkbase-Authorization, ACS-Licensing-Ack: <licence URL>, version=)`,
            `#       list: GET ${appsPath}?count=100&offset=0, 100, ... (30 per request by default, 100 at most)`,
          ],
        },
        verify: [
          `bash ops/acs-apps.sh describe ${privateApp ? appId : '<app name>'} --stack ${stack}   # status: installed`,
          `| rest /services/apps/local splunk_server=local | search title=${privateApp ? appId : '<app name>'} | table title, version, disabled, visible`,
          'index=_internal sourcetype=splunkd component=ApplicationUpdater OR component=AppsManager earliest=-1h | table _time, log_level, message   # VERIFY component names',
        ],
        backout: [
          `bash ops/acs-apps.sh uninstall ${privateApp ? appId : '<app name>'} --confirm ${privateApp ? appId : '<app name>'} --stack ${stack}`,
          ...(privateApp ? ['# Or install the previous package with a higher version number: ACS does not downgrade a private app.'] : ['# Or on Victoria: bash ops/acs-apps.sh upgrade-splunkbase <app name> --version <previous>']),
        ],
        findings,
      };
    },
  }),

  // 11. Migration -----------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_cloud_migration',
    tier: TIER,
    label: 'Enterprise to Cloud migration planner',
    group: 'Migration',
    description: 'The inventory and plan for moving a Splunk Enterprise deployment to Splunk Cloud: a read-only script that lists apps, indexes with sizes, retention and daily volume, forwarders, scripted and modular inputs, custom commands and authentication; a compatibility report; an index mapping CSV that feeds splunk_acs_indexes; the forwarder switch to the Cloud credentials app (with an optional dual-forwarding period); and a cutover checklist.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_cloud_migration' },
      { id: 'stack', label: 'Target stack', control: 'text', default: 'example-stack' },
      { id: 'source_url', label: 'On-premises search head (management URL)', control: 'text', default: 'https://splunk-sh1.corp.example.com:8089' },
      { id: 'contract_days', label: 'Searchable retention in the Cloud contract (days)', control: 'number', default: 90, min: 1, max: 3650 },
      { id: 'archive', label: 'Retention beyond that', control: 'select', default: 'ddaa', options: [
        { value: 'ddaa', label: 'DDAA — Splunk-managed archive' },
        { value: 'ddss', label: 'DDSS — our own bucket' },
        { value: 'none', label: 'None — delete at the contract limit' },
      ] },
      { id: 'ddss_path', label: 'Self-storage location', control: 'text', default: 's3://org-splunk-ddss/stack', showWhen: { input: 'archive', equals: ['ddss'] } },
      { id: 'deployment_apps', label: 'Deployment server apps directory', control: 'text', default: '/opt/splunk/etc/deployment-apps', hint: 'Scanned for inputs and outputs when the inventory runs on the deployment server' },
      { id: 'cutover', label: 'Forwarder cutover', control: 'select', default: 'dual', options: [
        { value: 'dual', label: 'Dual-forward for a period, then switch' },
        { value: 'switch', label: 'Switch directly' },
      ] },
      { id: 'onprem_group', label: 'Existing tcpout group', control: 'text', default: 'primary_indexers', showWhen: { input: 'cutover', equals: ['dual'] } },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_cloud_migration'), 'org_cloud_migration');
      const stack = stackOf(values);
      const url = str(values, 'source_url', 'https://localhost:8089').replace(/\/+$/, '');
      const contract = Math.round(num(values, 'contract_days', 90));
      const archive = str(values, 'archive', 'ddaa');
      const ddss = str(values, 'ddss_path', '');
      const depApps = str(values, 'deployment_apps', '/opt/splunk/etc/deployment-apps');
      const dual = str(values, 'cutover', 'dual') === 'dual';
      const onpremGroup = str(values, 'onprem_group', 'primary_indexers').replace(/[^A-Za-z0-9_.-]/g, '_');
      const dualApp = `000_${splunkName(stack, 'stack')}_dual_forward`;
      const findings            = [...stackFindings(stack)];

      if (!/^https:\/\//.test(url)) findings.push(error('splunk.migration-cleartext', 'The on-premises management URL is not HTTPS; the token the inventory sends would cross the network in clear.', { source: 'ArchToolKit' }));
      if (dual) {
        findings.push(
          warning('splunk.migration-dual-licence', 'While forwarders send to both, every event is licensed twice — on the on-premises licence and in the Cloud ingest entitlement — and each side needs capacity for the full volume. Keep the dual period short and planned.', {
            remediation: 'Dual-forward a pilot group first, compare counts, then switch; or switch directly per serverclass.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (archive === 'none') findings.push(warning('splunk.migration-no-archive', `Indexes kept longer than ${contract} days on premises will lose everything older in Cloud. Audit and security data usually has to be kept for a year or more.`, { source: 'ArchToolKit' }));
      if (archive === 'ddss' && !/^(s3|gs):\/\//.test(ddss)) findings.push(error('splunk.migration-ddss-path', 'The self-storage location must be s3://… or gs://…', { source: 'ArchToolKit' }));
      findings.push(info('splunk.migration-historic-data', 'The inventory plans new data flowing to Cloud. Moving already-indexed historic buckets is a separate Splunk-run service (or re-ingest, which costs licence); decide which indexes need history before cutover, not after.', { source: 'ArchToolKit' }));

      const inventory = [
        '#!/usr/bin/env bash',
        '# Splunk Enterprise -> Splunk Cloud: inventory of the on-premises deployment.',
        '# Read-only: every call is a GET or a search; nothing is changed.',
        '#',
        '# usage: inventory.sh [--url URL] [--token-file F] [--out DIR] [--cacert F]',
        '#                     [--contract-days N] [--archive ddaa|ddss|none] [--ddss-path P]',
        '#                     [--deployment-apps DIR]',
        '#   --token-file F  a Splunk authentication token for a user with admin (or',
        '#                   list_settings + rest_properties_get + search on _internal), alone',
        '#                   in a mode-600 file. Run it against a search head that can search',
        '#                   every indexer (and the license manager\'s _internal).',
        '#   --deployment-apps DIR  when run on the deployment server: also scan the apps',
        '#                   pushed to forwarders for inputs and outputs.',
        '# Writes CSVs, index-mapping.csv and compat-report.md into --out.',
        'set -euo pipefail',
        `SPLUNK_URL=${shq(url)}`,
        'TOKEN_FILE="${SPLUNK_TOKEN_FILE:-$HOME/.splunk/onprem.token}"',
        `OUT="./inventory-$(date +%Y%m%d)"; CA_FILE=""; CONTRACT_DAYS=${contract}; ARCHIVE=${shq(archive)}; DDSS_PATH=${shq(archive === 'ddss' ? ddss : '')}`,
        `DEP_APPS=""; DEP_DEFAULT=${shq(depApps)}`,
        'while [ $# -gt 0 ]; do',
        '  case $1 in',
        '    --url) SPLUNK_URL=$2; shift 2 ;;',
        '    --token-file) TOKEN_FILE=$2; shift 2 ;;',
        '    --out) OUT=$2; shift 2 ;;',
        '    --cacert) CA_FILE=$2; shift 2 ;;',
        '    --contract-days) CONTRACT_DAYS=$2; shift 2 ;;',
        '    --archive) ARCHIVE=$2; shift 2 ;;',
        '    --ddss-path) DDSS_PATH=$2; shift 2 ;;',
        '    --deployment-apps) DEP_APPS=$2; shift 2 ;;',
        '    -h|--help) sed -n "2,16p" "$0"; exit 0 ;;',
        '    *) printf "unknown option: %s\\n" "$1" >&2; exit 2 ;;',
        '  esac',
        'done',
        '[ -z "$DEP_APPS" ] && [ -d "$DEP_DEFAULT" ] && DEP_APPS=$DEP_DEFAULT',
        '',
        ...script`
die() { printf 'error: %s\n' "$*" >&2; exit 2; }
note() { printf '%s\n' "$*" >&2; }
check_private() {
  local f=$1 m
  [ -f "$f" ] || die "not found: $f"
  m=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")
  case "$m" in 600|400) ;; *) die "$f is mode $m. Run: chmod 600 $f" ;; esac
}
command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required"
umask 077
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"
CURL_TLS=()
[ -n "$CA_FILE" ] && CURL_TLS=(--cacert "$CA_FILE")

# The token reaches curl from a private header file, never from argv.
check_private "$TOKEN_FILE"
t=""
IFS= read -r t < "$TOKEN_FILE" || true
t=\${t%$'\r'}
[ -n "$t" ] || die "$TOKEN_FILE is empty"
printf 'Authorization: Bearer %s\n' "$t" > "$WORK/auth.h"
t=""

# A failed search leaves an empty file, which would read as "none found" in the
# report and the index mapping; every failure is listed and the run exits 1.
FAILED=()
# spl NAME 'SEARCH' [earliest]: results as one JSON object per line in $OUT/NAME.jsonl
spl() {
  local name=$1 q=$2 earliest=\${3:--24h}
  note "searching: $name"
  curl -sS --fail -H @"$WORK/auth.h" \${CURL_TLS[@]+"\${CURL_TLS[@]}"} "$SPLUNK_URL/services/search/v2/jobs/export" \
    --data-urlencode "search=$q" -d output_mode=json -d earliest_time="$earliest" -d latest_time=now \
    | jq -c 'select(.result) | .result' > "$OUT/$name.jsonl" || { note "  FAILED: $name (continuing; the run exits 1)"; : > "$OUT/$name.jsonl"; FAILED+=("$name"); }
}
# csv NAME col1 col2 ...: $OUT/NAME.jsonl as CSV with those columns.
csv() {
  local name=$1; shift
  jq -r -s --args '$ARGS.positional as $c | ($c | @csv), (.[] | [ $c[] as $k | (.[$k] // "" | if type == "array" then join(" ") else tostring end) ] | @csv)' "$@" < "$OUT/$name.jsonl" > "$OUT/$name.csv"
}
`,
        '',
        '# --- what is there ---------------------------------------------------------',
        "spl apps '| rest /services/apps/local splunk_server=local count=0 | rename title as app | eval splunkbase=if(match(details, \"splunkbase\"), 1, 0) | table app, label, version, disabled, visible, author, splunkbase, details'",
        'csv apps app label version disabled visible author splunkbase details',
        '',
        "spl indexes '| rest /services/data/indexes splunk_server=* datatype=all count=0 | search NOT title=_* disabled=0 | stats first(datatype) as datatype, sum(currentDBSizeMB) as sizeMB, sum(totalEventCount) as events, max(frozenTimePeriodInSecs) as frozen, max(maxTotalDataSizeMB) as maxMB, values(coldToFrozenDir) as frozenDir, values(coldToFrozenScript) as frozenScript by title'",
        'csv indexes title datatype sizeMB events frozen maxMB frozenDir frozenScript',
        '',
        '# Average daily licence usage per index over 30 days (needs the license',
        "# manager's _internal searchable from here).",
        "spl volume 'search index=_internal source=*license_usage.log* type=Usage earliest=-30d@d latest=@d | stats sum(b) as b by idx | eval avg_daily_gb=round(b/30/1073741824, 3) | table idx, avg_daily_gb' -30d@d",
        'csv volume idx avg_daily_gb',
        '',
        '# Every forwarder that connected in the last day, with version and OS.',
        "spl forwarders 'search index=_internal source=*metrics.log* group=tcpin_connections earliest=-24h | stats latest(version) as version, latest(os) as os, latest(fwdType) as fwdType, latest(sourceIp) as ip, sum(kb) as kb by hostname | sort - kb'",
        'csv forwarders hostname fwdType version os ip kb',
        '',
        "spl sourcetypes '| tstats count, dc(host) as hosts where index=* NOT index=_* earliest=-7d by index, sourcetype | sort index, - count' -7d",
        'csv sourcetypes index sourcetype count hosts',
        '',
        "spl scripted '| rest /servicesNS/-/-/data/inputs/script splunk_server=* count=0 | search disabled=0 | table splunk_server, title, eai:acl.app, interval, index, sourcetype'",
        'csv scripted splunk_server title eai:acl.app interval index sourcetype',
        '',
        "spl modinputs '| rest /servicesNS/-/-/data/inputs/all splunk_server=* count=0 | search disabled=0 eai:type!=monitor eai:type!=script eai:type!=tcp eai:type!=udp eai:type!=http | table splunk_server, eai:type, title, eai:acl.app'",
        'csv modinputs splunk_server eai:type title eai:acl.app',
        '',
        "spl commands '| rest /servicesNS/-/-/configs/conf-commands splunk_server=local count=0 | table title, eai:acl.app, filename, type, python.version, python.required, chunked'",
        'csv commands title eai:acl.app filename type python.version python.required chunked',
        '',
        "spl realtime '| rest /servicesNS/-/-/saved/searches splunk_server=local count=0 | search is_scheduled=1 disabled=0 | rename dispatch.earliest_time as det | eval realtime=if(match(det, \"^rt\"), 1, 0) | stats count as scheduled, sum(realtime) as realtime by eai:acl.app'",
        'csv realtime eai:acl.app scheduled realtime',
        '',
        "spl auth '| rest /services/authentication/providers/services splunk_server=local | table title, active'",
        'csv auth title active',
        '',
        "spl kvstore '| rest /servicesNS/-/-/storage/collections/config splunk_server=local count=0 | table title, eai:acl.app'",
        'csv kvstore title eai:acl.app',
        '',
        '# Inputs and outputs in the apps the deployment server pushes to forwarders.',
        'if [ -n "$DEP_APPS" ] && [ -d "$DEP_APPS" ]; then',
        '  note "scanning $DEP_APPS"',
        '  { echo "app,file,stanza"',
        '    { grep -rHE "^\\[(monitor|script|tcp|udp|WinEventLog|perfmon|http|splunktcp|tcpout)(:|\\])" "$DEP_APPS" --include=inputs.conf --include=outputs.conf 2>/dev/null || true; } \\',
        '      | sed -E "s#^$DEP_APPS/?##" | awk -F: \'{ split($1, p, "/"); s=$0; sub(/^[^:]*:/, "", s); gsub(/"/, "\\"\\"", s); printf "\\"%s\\",\\"%s\\",\\"%s\\"\\n", p[1], $1, s }\'',
        '  } > "$OUT/deployment-apps.csv"',
        'fi',
        '',
        '# --- index mapping -> splunk_acs_indexes (acs-indexes.sh plan --csv) --------',
        "jq -r -s --argjson contract \"$CONTRACT_DAYS\" --arg archive \"$ARCHIVE\" --arg ddss \"$DDSS_PATH\" --slurpfile vol \"$OUT/volume.jsonl\" '",
        '  ($vol | map({key: .idx, value: .avg_daily_gb}) | from_entries) as $v',
        '  | ["name","datatype","searchableDays","maxDataSizeMB","splunkArchivalRetentionDays","selfStorageBucketPath","source_frozen_days","source_size_mb","avg_daily_gb","action"],',
        '    (.[] | ((.frozen // "0") | tonumber / 86400 | ceil) as $fd',
        '     | (if $fd > 0 and $fd < $contract then $fd else $contract end) as $sd',
        '     | [ .title,',
        '         (if (.datatype // "event") == "metric" then "metric" else "event" end),',
        '         $sd, 0,',
        '         (if $archive == "ddaa" and $fd > $sd then ([$fd, 3650] | min) else "" end),',
        '         (if $archive == "ddss" and $fd > $sd then $ddss else "" end),',
        '         $fd, (.sizeMB // ""), ($v[.title] // ""),',
        '         (if (.title | test("^[a-z0-9][a-z0-9_-]*$")) then "create" else "rename" end) ])',
        "  | @csv' \"$OUT/indexes.jsonl\" > \"$OUT/index-mapping.csv\"",
        '',
        '# --- compatibility report ----------------------------------------------------',
        'count() { [ -s "$OUT/$1.jsonl" ] && wc -l < "$OUT/$1.jsonl" | tr -d " " || echo 0; }',
        'BUILTIN="^(search|launcher|learned|legacy|sample_app|splunk_.*|SplunkForwarder|SplunkDeploymentServerConfig|SplunkLightForwarder|introspection_generator_addon|alert_.*|appsbrowser|framework|gettingstarted|user-prefs|dmc|journald_input|python_upgrade_readiness_app|splunk-dashboard-studio|100_.*)$"',
        '{',
        '  echo "# Splunk Cloud compatibility report"',
        '  echo',
        `  echo "Source: $SPLUNK_URL, $(date -u +%Y-%m-%dT%H:%MZ). Target stack: ${stack}."`,
        '  echo',
        '  echo "## Apps"',
        '  echo',
        '  echo "Private apps (not from Splunkbase, not built in) must pass AppInspect with the private_victoria or private_classic tags before they can be installed (splunk_acs_apps). Splunkbase apps must be marked Splunk Cloud compatible for the version you install."',
        '  echo',
        "  jq -r -s --arg b \"$BUILTIN\" '.[] | select((.app | test($b)) | not) | \"- \\(.app) \\(.version // \"\") — \\(if .splunkbase == \"1\" then \"Splunkbase: check Cloud compatibility\" else \"private: run appinspect-local.sh\" end)\\(if .disabled == \"1\" then \" (disabled: leave behind?)\" else \"\" end)\"' \"$OUT/apps.jsonl\"",
        '  echo',
        '  echo "## Inputs that will not run in Splunk Cloud"',
        '  echo',
        '  echo "Scripted and modular inputs on the search heads or indexers have no host to run on in Cloud. Move each to a heavy forwarder (or the Inputs Data Manager for supported add-ons) that sends to the stack."',
        '  echo',
        "  jq -r '\"- scripted: \\(.title) in \\(.[\"eai:acl.app\"]) on \\(.splunk_server)\"' \"$OUT/scripted.jsonl\"",
        "  jq -r '\"- modular (\\(.[\"eai:type\"])): \\(.title) in \\(.[\"eai:acl.app\"]) on \\(.splunk_server)\"' \"$OUT/modinputs.jsonl\"",
        '  echo',
        '  echo "## Custom search commands"',
        '  echo',
        '  echo "Custom commands must pass Cloud vetting and run on the stack’s Python: Splunk Cloud Platform 10.5 runs 3.9 and 3.13, so declare python.required = 3.9, 3.13 and ship no compiled modules. A command pinned to python2 or python3.7 must be rewritten. Commands in built-in apps are listed for completeness and can be ignored."',
        '  echo',
        "  jq -r -s --arg b \"$BUILTIN\" '.[] | select((.[\"eai:acl.app\"] | test($b)) | not) | \"- \\(.title) in \\(.[\"eai:acl.app\"]) (\\(.filename // \"?\"), python \\(.[\"python.required\"] // .[\"python.version\"] // \"default\"), chunked=\\(.chunked // \"0\"))\"' \"$OUT/commands.jsonl\"",
        '  echo',
        '  echo "## Indexes"',
        '  echo',
        '  echo "$(count indexes) indexes; mapping in index-mapping.csv (review it, then: acs-indexes.sh plan --csv index-mapping.csv)."',
        "  jq -r --argjson c \"$CONTRACT_DAYS\" 'select(((.frozen // \"0\") | tonumber) / 86400 > $c) | \"- \\(.title): kept \\((((.frozen | tonumber) / 86400) | ceil)) days on premises; \\($c) searchable in Cloud, the rest archived or lost\"' \"$OUT/indexes.jsonl\"",
        "  jq -r 'select((.frozenDir // \"\") != \"\" or (.frozenScript // \"\") != \"\") | \"- \\(.title): archives frozen buckets on premises (coldToFrozen) — decide DDAA or DDSS\"' \"$OUT/indexes.jsonl\"",
        "  jq -r 'select(.title | test(\"^[a-z0-9][a-z0-9_-]*$\") | not) | \"- \\(.title): not a valid Cloud index name — rename, and change every input and search that uses it\"' \"$OUT/indexes.jsonl\"",
        '  echo',
        '  echo "## Forwarders"',
        '  echo',
        '  echo "$(count forwarders) forwarders connected in the last 24 hours (forwarders.csv). Each needs the Splunk Cloud universal forwarder credentials app and outbound 9997 to the stack; the s2s allow list must include their public egress addresses."',
        "  jq -r 'select((.version // \"0\") | split(\".\") | (.[0] | tonumber? // 0) < 9) | \"- \\(.hostname): \\(.fwdType) \\(.version) — below 9.x; check the Splunk Cloud forwarder compatibility matrix (VERIFY the supported minimum)\"' \"$OUT/forwarders.jsonl\"",
        '  echo',
        '  echo "## Other things to settle"',
        '  echo',
        "  jq -r 'select(.active == \"1\" or .active == true) | \"- authentication provider: \\(.title) — SAML is the usual Cloud setup; LDAP needs the directory reachable from the stack (VERIFY support for your stack)\"' \"$OUT/auth.jsonl\"",
        "  jq -r -s 'map(.realtime | tonumber? // 0) | add // 0 | select(. > 0) | \"- \\(.) scheduled real-time searches: Cloud limits real-time search; convert them to scheduled searches with a short interval\"' \"$OUT/realtime.jsonl\"",
        '  echo "- $(count kvstore) KV store collections: exported and re-imported per app (VERIFY sizes against the Cloud KV store limits)."',
        '  [ -f "$OUT/deployment-apps.csv" ] && echo "- deployment-apps.csv: every forwarder app with an outputs.conf is replaced by the Cloud credentials app; review the inputs for paths and indexes that change."',
        '} > "$OUT/compat-report.md"',
        '',
        'echo "Wrote to $OUT:"',
        'ls -1 "$OUT"',
        'if [ "\${#FAILED[@]}" -gt 0 ]; then',
        '  printf "error: these searches failed, so their files are empty and the report is incomplete: %s\\n" "\${FAILED[*]}" >&2',
        '  exit 1',
        'fi',
      ];

      const stage = script`
#!/usr/bin/env bash
# Stage the Splunk Cloud universal forwarder credentials app on the
# deployment server, and (optionally) a dual-forwarding override — then check,
# on a forwarder, that the override really is the one in effect.
#
# Download the package from the stack: Apps > Universal Forwarder >
# Download Universal Forwarder Credentials (splunkclouduf.spl). It contains the
# app 100_<stack>_splunkcloud: outputs.conf to the stack's inputs endpoints and
# the client certificate. Splunk generated it; it is not edited here.
#
# usage: stage-cloud-uf.sh SPL [--deployment-apps DIR] [--dual|--switch] [--dry-run]
#          on the deployment server: stage the apps (--dry-run previews)
#        stage-cloud-uf.sh --check [--dual|--switch] [--splunk-home DIR] [--cloud-group G]
#          on a pilot forwarder, after the deployment server has pushed the apps:
#          splunk btool outputs list tcpout --debug must show the intended
#          defaultGroup, or this exits 1 and names the file that overrides it.
#
# Why the check: the dual-forwarding app sets defaultGroup in its default/
# outputs.conf. Any local/ outputs.conf that sets defaultGroup outranks every
# default/ — an app's local/, or etc/system/local/outputs.conf, which is what
# "splunk add forward-server" writes (defaultGroup = default-autolb-group). Then
# the forwarder silently keeps sending to one side only. btool shows what wins.
set -euo pipefail
DEP_APPS=${shq(depApps)}
MODE=${dual ? 'dual' : 'switch'}; EXECUTE=1; SPL=""; CHECK=0; CLOUD_GROUP_ARG=""
SPLUNK_HOME="\${SPLUNK_HOME:-/opt/splunkforwarder}"
ONPREM_GROUP=${shq(onpremGroup)}
DUAL_APP=${shq(dualApp)}
while [ $# -gt 0 ]; do
  case $1 in
    --deployment-apps) DEP_APPS=$2; shift 2 ;;
    --dual) MODE=dual; shift ;;
    --switch) MODE=switch; shift ;;
    --dry-run) EXECUTE=0; shift ;;
    --check) CHECK=1; shift ;;
    --splunk-home) SPLUNK_HOME=$2; shift 2 ;;
    --cloud-group) CLOUD_GROUP_ARG=$2; shift 2 ;;
    -*) printf "unknown option: %s\n" "$1" >&2; exit 2 ;;
    *) SPL=$1; shift ;;
  esac
done
die() { printf "error: %s\n" "$*" >&2; exit 2; }
# A defaultGroup value as a sorted set, one group per line.
groups() { tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' | LC_ALL=C sort -u; }

if [ "$CHECK" = 1 ]; then
  SPLUNK="$SPLUNK_HOME/bin/splunk"
  [ -x "$SPLUNK" ] || die "no splunk binary at $SPLUNK (use --splunk-home)"
  CLOUD_GROUP=$CLOUD_GROUP_ARG
  if [ -z "$CLOUD_GROUP" ]; then
    CRED=$(ls -1d "$SPLUNK_HOME"/etc/apps/100_*_splunkcloud 2>/dev/null | head -1) || true
    [ -n "$CRED" ] || die "no 100_*_splunkcloud app under $SPLUNK_HOME/etc/apps: the deployment server has not pushed it here yet"
    CLOUD_GROUP=$(sed -n 's/^\[tcpout:\([^]]*\)\].*/\1/p' "$CRED"/default/outputs.conf | head -1)
    [ -n "$CLOUD_GROUP" ] || die "no [tcpout:...] group in $CRED/default/outputs.conf; pass --cloud-group"
  fi
  umask 077
  CK=$(mktemp -d); trap 'rm -rf "$CK"' EXIT
  if [ "$MODE" = dual ]; then printf '%s, %s\n' "$ONPREM_GROUP" "$CLOUD_GROUP"; else printf '%s\n' "$CLOUD_GROUP"; fi | groups > "$CK/want"
  # No "|| true": if btool fails, the check fails.
  "$SPLUNK" btool outputs list tcpout --debug > "$CK/btool" || die "splunk btool outputs list tcpout failed (run as the user splunkd runs as)"
  line=$(sed -nE 's/^([^[:space:]]+)[[:space:]]+defaultGroup[[:space:]]*=[[:space:]]*(.*)$/\1|\2/p' "$CK/btool" | tail -1)
  [ -n "$line" ] || die "no defaultGroup in the effective [tcpout] stanza: this forwarder has no default destination"
  from=\${line%%|*}; value=\${line#*|}
  echo "effective defaultGroup = $value"
  echo "  set in $from"
  if [ "$(printf '%s\n' "$value" | groups)" != "$(cat "$CK/want")" ]; then
    printf 'FAIL: expected defaultGroup = %s (%s)\n' "$(paste -sd, "$CK/want" | sed 's/,/, /g')" "$MODE" >&2
    printf '  %s outranks the %s app. Remove defaultGroup there (or the file, if "splunk add forward-server" wrote it), then restart and re-run --check.\n' "$from" "$([ "$MODE" = dual ] && echo "$DUAL_APP" || echo credentials)" >&2
    exit 1
  fi
  # Every group named must exist as a [tcpout:<group>] stanza, or its data goes nowhere.
  while IFS= read -r g; do
    "$SPLUNK" btool outputs list "tcpout:$g" 2>/dev/null | grep -q "^\[tcpout:$g\]" || { echo "FAIL: defaultGroup names $g, but there is no [tcpout:$g] stanza" >&2; exit 1; }
  done < "$CK/want"
  echo "OK: $MODE forwarding is in effect ($value)"
  exit 0
fi

[ -f "$SPL" ] || die "give the path to splunkclouduf.spl"
[ -d "$DEP_APPS" ] || die "no deployment-apps directory at $DEP_APPS"
umask 077
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
tar -xzf "$SPL" -C "$WORK"
APP=$(ls -1 "$WORK" | head -1)
[[ "$APP" == 100_*_splunkcloud ]] || echo "note: the app is $APP (expected 100_<stack>_splunkcloud; VERIFY the package)"
OUTPUTS=$(find "$WORK/$APP" -name outputs.conf | head -1)
[ -n "$OUTPUTS" ] || die "no outputs.conf in the package"
CLOUD_GROUP=$(sed -n 's/^\[tcpout:\([^]]*\)\].*/\1/p' "$OUTPUTS" | head -1)
[ -n "$CLOUD_GROUP" ] || die "no [tcpout:...] group in $OUTPUTS"
echo "credentials app: $APP  tcpout group: $CLOUD_GROUP"

run() { if [ "$EXECUTE" = 1 ]; then "$@"; else printf "DRY RUN:"; printf " %q" "$@"; printf "\n"; fi; }
# Owned by whoever owns deployment-apps (the splunk user), readable by it only:
# the package holds the forwarders' client certificate.
OWNER=$(stat -c %U:%G "$DEP_APPS" 2>/dev/null || stat -f %Su:%Sg "$DEP_APPS")
run cp -R "$WORK/$APP" "$DEP_APPS/"
run chown -R "$OWNER" "$DEP_APPS/$APP"
run chmod -R go-rwx "$DEP_APPS/$APP"

if [ "$MODE" = dual ]; then
  # 000_ sorts before 100_, so among default/ directories this app's defaultGroup
  # wins over the credentials app's. It does NOT win over any local/ outputs.conf
  # (see the header): deployment apps that ship one are listed now, and --check
  # on a pilot forwarder shows what actually won there, system/local included.
  # Each group has its own queue; if either side blocks, the forwarder blocks for
  # both — watch the queues during the dual period.
  overrides=$(grep -lE '^[[:space:]]*defaultGroup[[:space:]]*=' "$DEP_APPS"/*/local/outputs.conf 2>/dev/null || true)
  for f in "$DEP_APPS"/*/default/outputs.conf; do
    [ -f "$f" ] || continue
    a=$(basename "$(dirname "$(dirname "$f")")")
    [ "$a" = "$DUAL_APP" ] && continue
    if [[ "$(printf '%s\n%s\n' "$a" "$DUAL_APP" | LC_ALL=C sort | head -1)" == "$a" ]] && grep -qE '^[[:space:]]*defaultGroup[[:space:]]*=' "$f"; then overrides="$overrides $f"; fi
  done
  if [ -n "\${overrides// /}" ]; then
    echo "WARNING: these deployment apps set defaultGroup where it outranks $DUAL_APP; a forwarder that gets one of them will not dual-forward:"
    for f in $overrides; do echo "  $f"; done
  fi
  if [ "$EXECUTE" = 1 ]; then
    mkdir -p "$DEP_APPS/$DUAL_APP/default" "$DEP_APPS/$DUAL_APP/metadata"
    { echo "# Dual-forwarding during the Splunk Cloud migration. Remove at cutover."
      echo "# defaultGroup here is overridden by ANY local/outputs.conf that sets it (an app's"
      echo "# local/, or etc/system/local from 'splunk add forward-server'). Confirm on each"
      echo "# forwarder with: splunk btool outputs list tcpout --debug  (or stage-cloud-uf.sh --check)"
      echo "[tcpout]"
      echo "defaultGroup = $ONPREM_GROUP, $CLOUD_GROUP"
    } > "$DEP_APPS/$DUAL_APP/default/outputs.conf"
    printf "[install]\nstate = enabled\n\n[package]\nid = %s\n\n[launcher]\nversion = 1.0.0\ndescription = Dual-forwarding override for the Splunk Cloud migration\n" "$DUAL_APP" > "$DEP_APPS/$DUAL_APP/default/app.conf"
    chown -R "$OWNER" "$DEP_APPS/$DUAL_APP"
    chmod -R u+rwX,go-rwx "$DEP_APPS/$DUAL_APP"
  else
    echo "DRY RUN: create $DEP_APPS/$DUAL_APP/default/outputs.conf with defaultGroup = $ONPREM_GROUP, $CLOUD_GROUP"
  fi
fi

cat <<EOF
Next, on the deployment server:
  1. Map $APP$([ "$MODE" = dual ] && echo " and $DUAL_APP") to a PILOT serverclass (serverclass.conf, restartSplunkd = true).
  2. splunk reload deploy-server -class <pilot serverclass>
  3. On each pilot forwarder, once it has restarted: bash stage-cloud-uf.sh --check --$MODE
     It exits 1 if another outputs.conf (system/local included) decides defaultGroup.
  4. Compare counts on both sides (see the cutover checklist), then widen the serverclass.
  5. At cutover: remove $([ "$MODE" = dual ] && echo "$DUAL_APP and ")the old outputs app from every serverclass, reload.
EOF
`;

      const cutover = [
        `# Cutover checklist: Splunk Enterprise → ${stack}.splunkcloud.com`,
        '',
        '## Weeks before',
        '',
        '- [ ] Run ops/inventory.sh against the on-premises search head (and on the deployment server with --deployment-apps). Keep the output with the project.',
        '- [ ] Go through compat-report.md: every private app has a plan (vet, rewrite, leave behind); every scripted or modular input has a new home (heavy forwarder or IDM).',
        `- [ ] Review index-mapping.csv: searchable days (contract: ${contract}), archive, and any rename. Then \`acs-indexes.sh plan --csv index-mapping.csv\` (splunk_acs_indexes).`,
        '- [ ] Private apps pass `appinspect-local.sh` and are installed (splunk_acs_apps); Splunkbase add-ons installed at the versions running today.',
        '- [ ] Roles and SAML set up on the stack; srchIndexesAllowed for every role covers the new indexes.',
        '- [ ] IP allow lists: search-ui and search-api for users and automation, s2s for every forwarder egress address, hec for HEC senders (splunk_acs_network).',
        '- [ ] HEC tokens recreated on the stack (splunk_acs_hec); senders have the new URL and token ready but not switched.',
        '- [ ] Outbound connectivity from forwarders to inputs1.<stack>.splunkcloud.com:9997 (and the other inputsN hosts in the credentials app) tested: `nc -vz inputs1.' + stack + '.splunkcloud.com 9997`.',
        '',
        '## Pilot',
        '',
        '- [ ] `stage-cloud-uf.sh splunkclouduf.spl` on the deployment server (add --dry-run first to preview).',
        '- [ ] Map to a pilot serverclass of a few forwarders of each type; reload.',
        `- [ ] On each pilot forwarder, after it restarts: \`bash stage-cloud-uf.sh --check --${dual ? 'dual' : 'switch'}\` (copy the script there). It runs \`splunk btool outputs list tcpout --debug\` and exits 1 if the effective defaultGroup is not ${dual ? `${onpremGroup} + the Cloud group` : 'the Cloud group'} — naming the file that overrides it (typically etc/system/local/outputs.conf from \`splunk add forward-server\`, or an app's local/outputs.conf).`,
        dual
          ? `- [ ] Dual-forwarding: the ${dualApp} app sends to ${onpremGroup} and the Cloud group together. Compare per index and sourcetype on both sides for the same hour:`
          : '- [ ] Compare per index and sourcetype on the stack against the same hour on premises the day before:',
        '  `| tstats count where index=* NOT index=_* earliest=-1h@h latest=@h by index, sourcetype`',
        '- [ ] Forwarder health on the pilot hosts: `index=_internal host=<pilot> source=*splunkd.log* (component=TcpOutputProc OR component=TcpOutputFd) log_level!=INFO`',
        '- [ ] Blocked queues: `index=_internal host=<pilot> source=*metrics.log* group=queue blocked=true | stats count by name`',
        '',
        '## Cutover',
        '',
        '- [ ] Freeze changes to apps and knowledge objects on premises.',
        '- [ ] Widen the serverclass to all forwarders; watch the forwarder count on the stack reach the inventory count.',
        '- [ ] Switch HEC senders to the Cloud URL and tokens; switch syslog and heavy forwarders.',
        '- [ ] Move saved searches, alerts and dashboards (in their apps) and re-point any automation to https://' + stack + '.splunkcloud.com:8089 (needs the search-api allow list).',
        ...(dual ? [`- [ ] End dual-forwarding: remove ${dualApp} and the old outputs app from every serverclass; reload.`] : ['- [ ] Remove the old outputs app from every serverclass; reload.']),
        '',
        '## After',
        '',
        '- [ ] No forwarder still connects to the on-premises indexers: `index=_internal source=*metrics.log* group=tcpin_connections earliest=-1h | stats count by hostname` on premises, expected empty.',
        '- [ ] Licence: ingest on the stack matches the inventory’s avg_daily_gb within expected variance (Cloud Monitoring Console > License Usage).',
        '- [ ] Keep the on-premises deployment searchable (read-only) until its data ages past what the business needs, or until historic data has been migrated.',
      ];

      return {
        tier: TIER,
        title: `Migration plan: ${url.replace(/^https?:\/\//, '').replace(/:\d+$/, '')} → ${stack}.splunkcloud.com`,
        app,
        activation: 'restart',
        notes: [
          'ops/inventory.sh is read-only and runs from any host that can reach the on-premises search head on 8089. It authenticates with a Splunk authentication token read from a mode-600 file and sent from a private header file.',
          'Run it against a search head that searches every indexer: index sizes come from | rest splunk_server=*, and daily volume from the license manager’s license_usage.log in _internal.',
          'index-mapping.csv feeds splunk_acs_indexes directly: bash ops/acs-indexes.sh plan --csv index-mapping.csv (rows whose action is not create are skipped — rename rows need a decision first).',
          'The forwarder switch uses the credentials app Splunk generates for the stack (splunkclouduf.spl, app 100_<stack>_splunkcloud). It holds the client certificate and outputs to the stack; nothing in this package writes a certificate or password. Forwarders restart when the deployment server pushes it, which is why the activation is a restart.',
          ...(dual ? [`Dual-forwarding works only if ${dualApp}'s defaultGroup is the one in effect. It is in default/, so any local/outputs.conf that sets defaultGroup overrides it — including etc/system/local/outputs.conf written by "splunk add forward-server". stage-cloud-uf.sh lists deployment apps that would override it, and stage-cloud-uf.sh --check on a forwarder confirms with btool and fails otherwise.`] : []),
          ...(dual ? [`During dual-forwarding the forwarder waits for the slower of the two destinations. If Cloud connectivity fails, on-premises ingestion stops too — keep the pilot small until the path is proven.`] : []),
        ],
        before: [
          `curl -fsS -H @<(printf 'Authorization: Bearer %s\\n' "$(cat ~/.splunk/onprem.token)") ${url}/services/server/info?output_mode=json | jq '.entry[0].content | {serverName, version}'`,
          '| rest /services/server/info splunk_server=* | table splunk_server, version, server_roles',
          `bash ops/inventory.sh --url ${url} --out ./inventory`,
        ],
        files: {
          'default/app.conf': kitConf(app, `Splunk Cloud migration plan for ${stack}`),
          'ops/inventory.sh': inventory,
          'ops/stage-cloud-uf.sh': stage,
          'ops/index-mapping.template.csv': [
            'name,datatype,searchableDays,maxDataSizeMB,splunkArchivalRetentionDays,selfStorageBucketPath,source_frozen_days,source_size_mb,avg_daily_gb,action',
            `app_web,event,${contract},0,${archive === 'ddaa' ? 365 : ''},${archive === 'ddss' ? ddss : ''},365,120000,4.2,create`,
          ],
          'CUTOVER.md': cutover,
        },
        verify: [
          'ls ./inventory   # apps, indexes, forwarders, scripted, commands CSVs, index-mapping.csv, compat-report.md',
          `bash ops/stage-cloud-uf.sh --check --${dual ? 'dual' : 'switch'}   # on each pilot forwarder: exit 0 and "OK: ${dual ? 'dual' : 'switch'} forwarding is in effect"`,
          '$SPLUNK_HOME/bin/splunk btool outputs list tcpout --debug | grep defaultGroup   # on a forwarder: the file that sets it',
          `bash ops/acs-indexes.sh plan --csv ./inventory/index-mapping.csv --stack ${stack}   # from splunk_acs_indexes`,
          `| tstats count where index=* NOT index=_* earliest=-1h@h latest=@h by index, sourcetype   # on the stack and on premises, compared`,
          'index=_internal source=*metrics.log* group=tcpin_connections earliest=-1h | stats dc(hostname) as forwarders   # on the stack, against the inventory count',
        ],
        backout: [
          `# Before cutover: unmap 100_${stack}_splunkcloud${dual ? ` and ${dualApp}` : ''} from the serverclass and reload the deployment server; forwarders fall back to the old outputs app.`,
          'splunk reload deploy-server -class <serverclass>',
          '# After cutover: re-map the old outputs app. Data sent to Cloud in the meantime stays there; nothing on premises is deleted by this plan.',
        ],
        findings,
      };
    },
  }),
];
