/**
 * Splunk Cloud Platform, continued: the Admin Config Service calls that are not
 * about creating things but about keeping them — where data goes when it ages
 * out, when the stack is allowed to restart, and the search limits a Cloud
 * customer may still tune.
 *
 * Every script here uses the same ACS prelude as cloud.ts: the token read from
 * a mode-600 file (ACS_TOKEN_FILE, default ~/.splunk/acs.token) into a private
 * header file, never an argument and never written anywhere else, and the ACS
 * host taken from ACS_SERVER — admin.splunk.com, or admin.splunkcloudfed.com
 * for a FedRAMP High stack.
 *
 * The mistakes these look for: an archive that is shorter than the searchable
 * period (ACS rejects it) or missing altogether (data deleted on the day it
 * ages out), a self-storage path that was never registered as a location, a
 * restart issued in the middle of a deployment, and a limits change nobody can
 * back out because nobody wrote down what it was before.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { splunkBlueprint,                      } from '../from-app.js';
import { splunkName,                } from '../splunk.js';
import { INDEX_NAME, TOKEN_NOTE, acsArgs, acsPrelude, kitConf, rows, script, stackFindings, stackOf } from './cloud.js';

const TIER = 'cloud'         ;
const SOURCE = 'Splunk Cloud Platform Admin Config Service';

// --- helpers ---------------------------------------------------------------

/** The ACS hosts: commercial Splunk Cloud, and FedRAMP High. */
const ACS_HOSTS = [
  { value: 'https://admin.splunk.com', label: 'admin.splunk.com — Splunk Cloud Platform' },
  { value: 'https://admin.splunkcloudfed.com', label: 'admin.splunkcloudfed.com — FedRAMP High' },
]         ;

const hostInput = { id: 'acs_host', label: 'ACS host', control: 'select', default: ACS_HOSTS[0].value, options: ACS_HOSTS }         ;

function acsServer(values                 )         {
  const chosen = str(values, 'acs_host', ACS_HOSTS[0].value);
  return ACS_HOSTS.some((h) => h.value === chosen) ? chosen : ACS_HOSTS[0].value;
}

/** The cells of a `a | b | c` row, trimmed; empty cells stay as ''. */
function cells(line        )           {
  return line.split('|').map((c) => c.trim());
}

/**
 * acsArgs with this script's own defaults set before the command is read, and
 * the ACS host fixed unless ACS_SERVER is already set in the environment.
 */
function args(stack        , server        , defaults                   , more                    = [])           {
  return [
    `ACS_SERVER="\${ACS_SERVER:-${server}}"`,
    ...acsArgs(stack, more).flatMap((line) => (line.startsWith('CMD=') ? [...defaults, line] : [line])),
  ];
}

/** The REST base, for the notes and the curl lines a change record carries. */
const base = (server        , stack        ) => `${server}/${stack}/adminconfig/v2`;

/** A self-storage path: s3://bucket/folder or gs://bucket/folder. */
const DDSS_PATH = /^(s3|gs):\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/;

// --- blueprints ------------------------------------------------------------

export const CLOUD_ACS_BLUEPRINTS                             = [
  // 1. Archive: DDAA and DDSS -----------------------------------------------
  splunkBlueprint({
    id: 'splunk_acs_archive',
    tier: TIER,
    label: 'Archive: DDAA and DDSS through ACS',
    group: 'Admin Config Service',
    description: 'What happens to each index when data ages out of search: Dynamic Data Active Archive (splunkArchivalRetentionDays, restorable in Splunk) or Dynamic Data Self Storage (selfStorageBucketPath, a copy in your own bucket) — the self-storage location registered and its bucket policy fetched first, then each index PATCHed and read back until the change shows.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_cloud_archive' },
      { id: 'stack', label: 'Stack', control: 'text', default: 'example-stack', hint: 'The first label of <stack>.splunkcloud.com' },
      hostInput,
      {
        id: 'archive',
        label: 'Indexes',
        control: 'textarea',
        default: 'app_web | 90 | 365 | \nnetfw | 90 | 1095 | \naudit | 90 |  | s3://org-splunk-ddss/audit',
        hint: 'index | searchable days | archive days | DDSS path — archive days for DDAA, or a DDSS path, not both',
      },
      { id: 'contract_days', label: 'Searchable retention your contract includes (days)', control: 'number', default: 90, min: 1, max: 3650, hint: 'Usually 90; see your order form' },
      { id: 'ddss_title', label: 'Self-storage location title', control: 'text', default: 'org-ddss', hint: 'Used when a DDSS path is not yet a location; the bucket name is added when there are several' },
      { id: 'ddss_description', label: 'Self-storage location description', control: 'text', default: 'Archive copies of aged-out Splunk Cloud data' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_cloud_archive'), 'org_cloud_archive');
      const stack = stackOf(values);
      const server = acsServer(values);
      const contract = Math.round(num(values, 'contract_days', 90));
      const title = str(values, 'ddss_title', 'org-ddss');
      const description = str(values, 'ddss_description', '');
      const findings            = [...stackFindings(stack)];

                     
                     
                               
                                             
                                       
       
      const desired        = [];
      const seen = new Set        ();
      const lines = rows(str(values, 'archive', ''));
      if (lines.length === 0) findings.push(error('splunk.acs-archive-empty', 'No indexes were given.'));

      for (const line of lines) {
        const [name = '', searchableText = '', archiveText = '', path = '', ...extra] = cells(line);
        const searchable = Number(searchableText);
        const archive = archiveText === '' ? undefined : Number(archiveText);
        let ok = true;
        if (extra.some(Boolean)) {
          findings.push(error('splunk.acs-archive-row', `"${line}" has more than four columns: index | searchable days | archive days | DDSS path.`));
          ok = false;
        }
        if (!INDEX_NAME.test(name)) {
          findings.push(error('splunk.acs-index-name', `"${name}" is not a valid index name: lower-case letters, digits, underscores and hyphens, not starting with _ or -.`, { source: SOURCE }));
          ok = false;
        }
        if (seen.has(name)) {
          findings.push(error('splunk.acs-archive-duplicate', `${name} is listed twice; only one set of retention settings can apply.`));
          ok = false;
        }
        seen.add(name);
        if (!Number.isInteger(searchable) || searchable < 1) {
          findings.push(error('splunk.acs-searchable-days', `${name}: searchable days "${searchableText}" must be a whole number of at least 1.`, { source: SOURCE }));
          ok = false;
        }
        if (archive !== undefined && (!Number.isInteger(archive) || archive < 1)) {
          findings.push(error('splunk.acs-ddaa-days', `${name}: archive days "${archiveText}" must be a whole number.`, { source: SOURCE }));
          ok = false;
        }
        if (archive !== undefined && path) {
          findings.push(error('splunk.acs-archive-both', `${name} has both archive days (DDAA) and a DDSS path. An index archives to one or the other; ACS will not set both.`, { source: SOURCE }));
          ok = false;
        }
        if (archive !== undefined && Number.isInteger(searchable) && archive <= searchable) {
          findings.push(error('splunk.acs-ddaa-days', `${name}: splunkArchivalRetentionDays (${archive}) must be greater than searchableDays (${searchable}); ACS rejects it otherwise.`, { source: SOURCE }));
          ok = false;
        }
        if (archive !== undefined && archive > 3650) {
          findings.push(error('splunk.acs-ddaa-max', `${name}: DDAA keeps data for at most 3650 days (10 years).`, { source: SOURCE }));
          ok = false;
        }
        if (path && !DDSS_PATH.test(path)) {
          findings.push(error('splunk.acs-ddss-path', `${name}: "${path}" is not a self-storage path. It is s3://bucket/folder or gs://bucket/folder, with a bucket name in lower case.`, { source: SOURCE }));
          ok = false;
        }
        if (archive === undefined && !path && name) {
          findings.push(
            warning('splunk.acs-index-no-archive', `${name} has neither archive days nor a DDSS path, so events are deleted on day ${searchable + 1}. There is no recycle bin, and Splunk support cannot restore them.`, {
              remediation: 'Give it archive days (DDAA, restorable into search) or a DDSS path (a copy in your own bucket).',
            }),
          );
        }
        if (Number.isInteger(searchable) && searchable > contract) {
          findings.push(
            warning('splunk.acs-searchable-over-contract', `${name}: ${searchable} searchable days is more than the ${contract} your contract includes. DDAS is sized on ingest × searchable days, so the extra days are billed as overage.`, {
              remediation: `Keep ${contract} days searchable and archive the rest.`,
            }),
          );
        }
        if (ok) {
          desired.push({
            name,
            searchableDays: searchable,
            ...(archive !== undefined ? { splunkArchivalRetentionDays: archive } : {}),
            ...(path ? { selfStorageBucketPath: path.replace(/\/+$/, '') } : {}),
          });
        }
      }

      // One self-storage location per distinct bucket and folder.
      const paths = [...new Set(desired.map((d) => d.selfStorageBucketPath).filter((p)              => Boolean(p)))];
      const locations = paths.map((p) => {
        const m = DDSS_PATH.exec(p) ;
        return {
          title: paths.length > 1 ? `${title}-${m[2]}${m[3] ? `-${m[3].replace(/[^A-Za-z0-9]+/g, '-')}` : ''}` : title,
          bucketName: m[2] ,
          folder: m[3] ?? '',
          description,
        };
      });
      if (locations.length > 0 && !title) findings.push(error('splunk.acs-ddss-title', 'A self-storage location needs a title.', { source: SOURCE }));
      const clouds = new Set(paths.map((p) => p.slice(0, 2)));
      if (clouds.size > 1) {
        findings.push(error('splunk.acs-ddss-mixed', 'The DDSS paths mix s3:// and gs://. A stack stores to the object store of the cloud it runs in: S3 for a stack on AWS, GCS for one on Google Cloud.', { source: SOURCE }));
      }

      const sh = [
        '#!/usr/bin/env bash',
        '# Splunk Cloud archiving through the Admin Config Service (ACS): DDAA and DDSS.',
        '#',
        '# usage: acs-archive.sh COMMAND [options]',
        '#   locations                the self-storage locations on the stack, and the',
        '#                            prefix and service accounts DDSS buckets must use',
        '#   policy BUCKET            fetch the bucket policy Splunk needs on BUCKET and',
        '#                            save it as ddss-policy-BUCKET.json beside this script',
        '#   register [--dry-run]     register each location in ddss-locations.json that',
        '#                            is not one yet (apply its bucket policy first)',
        '#   plan                     compare archive.json with the stack (no changes)',
        '#   apply [--dry-run]        PATCH each index that differs, and wait until it shows',
        '# options:',
        '#   --stack S               the stack (default below)',
        '#   --token-file F          ACS token, alone in a mode-600 file (default ~/.splunk/acs.token)',
        '#   --desired F             the per-index settings (default archive.json beside this script)',
        '#',
        '# Order for DDSS: policy, then apply that policy to your bucket, then register,',
        '# then apply. apply refuses a DDSS path whose bucket is not a location yet.',
        '# ACS will not switch an index between DDAA and DDSS, nor turn DDAA off; those',
        '# show as CONFLICT and are a change in the Splunk Cloud UI.',
        'set -euo pipefail',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...args(stack, server, ['DESIRED="$HERE/archive.json"; LOCATIONS="$HERE/ddss-locations.json"'], ['--desired) DESIRED=$2; shift 2 ;;']),
        '',
        ...acsPrelude(),
        '',
        'case "$CMD" in help|-h|--help) sed -n "2,24p" "$0"; exit 0 ;; esac',
        'setup_acs',
        'LOC=/cloud-resources/self-storage-locations',
        '',
        ...script`
# VERIFY the response shape of the locations list on your stack. The check is a
# plain text match of the bucket (and folder) anywhere in the listing, so it does
# not depend on the field names.
is_location() {
  jq -e --arg b "$1" --arg f "$2" 'tostring | contains($b) and contains($f)' "$WORK/locs.json" > /dev/null
}
list_locations() { acs GET "$LOC/buckets" > "$WORK/locs.json" || die "could not list the self-storage locations"; }

# Every DDSS path in the desired file must already be a registered location.
check_locations() {
  local p b f
  jq -r '[.[] | .selfStorageBucketPath // empty] | unique[]' "$DESIRED" > "$WORK/paths"
  [ -s "$WORK/paths" ] || return 0
  list_locations
  while IFS= read -r p <&3; do
    b=\${p#*://}; f=\${b#*/}; b=\${b%%/*}; [ "$f" != "$b" ] || f=""
    is_location "$b" "$f" || die "$p is not a self-storage location on $STACK yet. Run: acs-archive.sh policy $b, apply that policy to the bucket, then acs-archive.sh register"
  done 3< "$WORK/paths"
}

# ACS answers 202 and changes the index in the background. Wait until GET shows
# every field of the request at its new value.
wait_fields() {
  local i
  for i in $(seq 1 60); do
    if acs GET "/indexes/$(enc "$1")" > "$WORK/now.json" 2>/dev/null \
      && jq -e --slurpfile want "$2" '. as $e | $want[0] | to_entries | all(.[]; (.value | tostring) == (($e[.key] // "") | tostring))' "$WORK/now.json" > /dev/null 2>&1; then
      return 0
    fi
    sleep "\${ACS_POLL_SECONDS:-10}"
  done
  die "$1 did not show the requested settings in time; check with: acs-archive.sh plan"
}

case "$CMD" in
  locations)
    list_locations
    jq . "$WORK/locs.json"
    echo "== bucket prefix DDSS requires (VERIFY: may apply to GCS only)"
    acs GET "$LOC/configs/prefix" | jq . || true
    echo "== service accounts to grant on a GCS bucket (VERIFY: GCS only)"
    acs GET "$LOC/configs/service-accounts" | jq . || true
    ;;
  policy)
    [ -n "$TARGET" ] || die "policy needs a bucket name"
    acs GET "$LOC/buckets/$(enc "$TARGET")/policy" > "$WORK/policy.json" || die "could not fetch the policy for $TARGET"
    jq . "$WORK/policy.json" > "$HERE/ddss-policy-$TARGET.json"
    cat "$HERE/ddss-policy-$TARGET.json"
    note "saved: $HERE/ddss-policy-$TARGET.json — apply it to the bucket (S3 bucket policy, or the GCS IAM bindings it lists), then run: acs-archive.sh register"
    ;;
  register)
    [ -f "$LOCATIONS" ] || die "not found: $LOCATIONS"
    list_locations
    while IFS= read -r loc <&3; do
      b=$(jq -r .bucketName <<< "$loc"); f=$(jq -r '.folder // ""' <<< "$loc")
      if is_location "$b" "$f"; then echo "ok        $b/$f is already a self-storage location"; continue; fi
      printf '%-9s REGISTER %s\n' "$(mode)" "$loc"
      [ "$EXECUTE" = 1 ] || continue
      printf '%s' "$loc" > "$WORK/req.json"
      acs_json POST "$LOC/buckets" "$WORK/req.json" > /dev/null \
        || die "registering $b failed. Splunk checks it can write to the bucket: apply the policy from 'acs-archive.sh policy $b' first"
      echo "          registered: $b/$f"
    done 3< <(jq -c '.[]' "$LOCATIONS")
    [ "$EXECUTE" = 1 ] || echo "Dry run: nothing was changed. Run it without --dry-run to apply."
    ;;
  plan|apply)
    [ -f "$DESIRED" ] || die "not found: $DESIRED"
    jq -e 'type == "array"' "$DESIRED" > /dev/null || die "$DESIRED is not a JSON array"
    [ "$CMD" = plan ] || check_locations
    label=PLAN; [ "$CMD" = plan ] || label=$(mode)
    conflicts=0; missing=0
    while IFS= read -r row <&3; do
      name=$(jq -r .name <<< "$row")
      if ! acs GET "/indexes/$(enc "$name")" > "$WORK/idx.json" 2> "$WORK/err"; then
        if grep -q 'HTTP 404' "$WORK/err"; then
          printf 'MISSING   %s: create it first (Indexes through ACS)\n' "$name"; missing=$((missing + 1)); continue
        fi
        cat "$WORK/err" >&2; die "could not read index $name"
      fi
      jq -c --slurpfile cur "$WORK/idx.json" '
        . as $d | $cur[0] as $e
        | if ($d.splunkArchivalRetentionDays != null and ($e.selfStorageBucketPath // "") != "")
             or ($d.selfStorageBucketPath != null and (($e.splunkArchivalRetentionDays // 0) | tonumber) > 0)
          then {conflict: "switching between DDAA and DDSS is a UI change"}
          else ($d | del(.name) | with_entries(select((.value | tostring) != (($e[.key] // "") | tostring)))) end' <<< "$row" > "$WORK/diff.json"
      if jq -e 'has("conflict")' "$WORK/diff.json" > /dev/null; then
        printf 'CONFLICT  %s: %s\n' "$name" "$(jq -r .conflict "$WORK/diff.json")"; conflicts=$((conflicts + 1))
      elif jq -e 'length == 0' "$WORK/diff.json" > /dev/null; then
        printf 'ok        %s\n' "$name"
      else
        printf '%-9s UPDATE  %s %s\n' "$label" "$name" "$(cat "$WORK/diff.json")"
        if [ "$CMD" = apply ] && [ "$EXECUTE" = 1 ]; then
          jq -n --slurpfile cur "$WORK/idx.json" --arg n "$name" '$cur[0] | {name: $n, searchableDays, splunkArchivalRetentionDays, selfStorageBucketPath} | with_entries(select(.value != null))' \
            >> "$HERE/archive-before.jsonl"
          acs_json PATCH "/indexes/$(enc "$name")" "$WORK/diff.json" > /dev/null || die "PATCH $name failed"
          wait_fields "$name" "$WORK/diff.json"
          echo "          done: $name"
        fi
      fi
    done 3< <(jq -c '.[]' "$DESIRED")
    [ "$CMD" = plan ] || [ "$EXECUTE" = 1 ] || echo "Dry run: nothing was changed. Run it without --dry-run to apply."
    [ "$conflicts" -eq 0 ] && [ "$missing" -eq 0 ] || exit 1
    ;;
  *) die "unknown command $CMD (try --help)" ;;
esac
`,
      ];

      const acsBase = base(server, stack);
      const names = desired.map((d) => d.name);
      return {
        tier: TIER,
        title: `Splunk Cloud archiving on ${stack}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`,
        app,
        activation: 'reload',
        notes: [
          TOKEN_NOTE,
          'ops/acs-archive.sh apply PATCHes indexes/{name} with only the fields that differ (searchableDays, splunkArchivalRetentionDays, selfStorageBucketPath) and reads each index back until the change shows; apply --dry-run previews, plan compares. The values before each change are appended to ops/archive-before.jsonl.',
          'The indexes must already exist (Indexes through ACS creates them). ACS will not switch an index between DDAA and DDSS or turn DDAA off; those are a Splunk Cloud UI change.',
          ...(desired.some((d) => d.splunkArchivalRetentionDays !== undefined)
            ? ['DDAA archive days are counted from the event’s time, so they include the searchable days. Restoring from DDAA into search takes hours and counts against the DDAA restore entitlement.']
            : []),
          ...(locations.length > 0
            ? [
                `DDSS, in order: acs-archive.sh policy ${locations[0] .bucketName} saves the bucket policy Splunk needs; apply it to the bucket; acs-archive.sh register adds the location (Splunk tests that it can write); acs-archive.sh apply sets selfStorageBucketPath on the indexes.`,
                'DDSS data is yours to keep, lifecycle and pay for, and it is not searchable from Splunk Cloud: bring it back by thawing the buckets into a Splunk Enterprise instance.',
                'VERIFY: the shape of the self-storage locations listing, and whether configs/prefix and configs/service-accounts apply to S3 or only to GCS, against the ACS OpenAPI (https://admin.splunk.com/service/info/specs/v2/openapi.json) for your stack.',
              ]
            : []),
          'Searching archived data in place: the Federated Search for Amazon S3 provider and index model (type aws_s3) is deprecated in Splunk Cloud 10.4.2604 and read-only from 10.5.2605. New work is a Data Management connection and dataset, set up in the UI; nothing here creates aws_s3 providers.',
          ...(server !== ACS_HOSTS[0].value ? [`FedRAMP High: the scripts call ${server}. Set ACS_SERVER in the environment to override it.`] : []),
        ],
        before: [
          `bash ops/acs-archive.sh plan --stack ${stack}`,
          ...(locations.length > 0 ? [`bash ops/acs-archive.sh locations --stack ${stack}`] : []),
          'Settings > Indexes on the stack: DDAA entitlement and current archive usage — enough headroom for the new archive days?',
        ],
        files: {
          'default/app.conf': kitConf(app, `ACS archive settings for ${stack}`),
          'ops/archive.json': [JSON.stringify(desired, null, 2)],
          ...(locations.length > 0 ? { 'ops/ddss-locations.json': [JSON.stringify(locations, null, 2)] } : {}),
          'ops/acs-archive.sh': sh,
          'ops/acs-rest.txt': [
            '# The REST calls acs-archive.sh makes:',
            `#   GET    ${acsBase}/cloud-resources/self-storage-locations/buckets`,
            `#   GET    ${acsBase}/cloud-resources/self-storage-locations/buckets/{bucketName}/policy`,
            `#   GET    ${acsBase}/cloud-resources/self-storage-locations/configs/prefix`,
            `#   GET    ${acsBase}/cloud-resources/self-storage-locations/configs/service-accounts`,
            `#   POST   ${acsBase}/cloud-resources/self-storage-locations/buckets    {title, bucketName, folder, description}`,
            `#   GET    ${acsBase}/indexes/{name}`,
            `#   PATCH  ${acsBase}/indexes/{name}    {searchableDays, splunkArchivalRetentionDays | selfStorageBucketPath}`,
          ],
        },
        verify: [
          `bash ops/acs-archive.sh plan --stack ${stack}   # every line ok, exit 0`,
          `| rest /services/data/indexes splunk_server=* | search title IN (${names.slice(0, 10).join(', ') || '<index>'}) | stats values(frozenTimePeriodInSecs) as frozen by title`,
        ],
        backout: [
          `jq -s . ops/archive-before.jsonl > ops/archive-before.json && bash ops/acs-archive.sh apply --desired ops/archive-before.json --stack ${stack}   # the values recorded before each change`,
          '# Data already deleted by a shorter retention is not recoverable. A self-storage location is removed in the Splunk Cloud UI once no index uses it.',
        ],
        findings,
      };
    },
  }),

  // 2. Maintenance windows, restarts and deployment status --------------------
  splunkBlueprint({
    id: 'splunk_acs_maintenance',
    tier: TIER,
    label: 'Maintenance windows, restarts and deployment status',
    group: 'Admin Config Service',
    description: 'The stack’s maintenance windows and preferences, its deployment status, and a restart through ACS that refuses to run without the stack name repeated, while a deployment or another restart is in progress, or while the stack is not Ready — then polls restart/status until it is done.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_cloud_maintenance' },
      { id: 'stack', label: 'Stack', control: 'text', default: 'example-stack', hint: 'The first label of <stack>.splunkcloud.com' },
      hostInput,
      { id: 'prefs_method', label: 'Method for maintenance preferences', control: 'select', default: 'POST', options: [
        { value: 'POST', label: 'POST — as the ACS reference lists it' },
        { value: 'PUT', label: 'PUT — if your stack’s OpenAPI says so' },
      ] },
      { id: 'block_deploying', label: 'Refuse to restart during a deployment', control: 'toggle', default: true },
      { id: 'poll_seconds', label: 'Poll every (seconds)', control: 'number', default: 30, min: 5, max: 600 },
      { id: 'timeout_minutes', label: 'Give up on a restart after (minutes)', control: 'number', default: 60, min: 5, max: 600 },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_cloud_maintenance'), 'org_cloud_maintenance');
      const stack = stackOf(values);
      const server = acsServer(values);
      const method = str(values, 'prefs_method', 'POST') === 'PUT' ? 'PUT' : 'POST';
      const blockDeploying = bool(values, 'block_deploying', true);
      const poll = Math.round(num(values, 'poll_seconds', 30));
      const timeout = Math.round(num(values, 'timeout_minutes', 60));
      const findings            = [...stackFindings(stack)];

      if (poll < 1) findings.push(error('splunk.acs-poll', 'The poll interval must be at least one second.'));
      if (timeout * 60 <= poll) findings.push(error('splunk.acs-restart-timeout', `A ${timeout}-minute timeout with a ${poll}-second poll never checks the restart once.`));
      if (!blockDeploying) {
        findings.push(
          warning('splunk.acs-restart-during-deploy', 'The restart will not check deployment/status. A restart issued while an app install or configuration change is being deployed can leave it half applied, and the retry is then yours to notice.', {
            remediation: 'Leave the check on; use --ignore-deployments for the one occasion that needs it.',
          }),
        );
      }

      const sh = [
        '#!/usr/bin/env bash',
        '# Splunk Cloud maintenance windows, restarts and deployment status through ACS.',
        '#',
        '# usage: acs-maintenance.sh COMMAND [options]',
        '#   windows                  the scheduled maintenance windows',
        '#   window ID | audits ID    one window, or its audit trail',
        '#   preferences              the stack’s maintenance preferences',
        '#   set-preferences FILE [--dry-run]  send FILE (JSON) as the new preferences;',
        '#                            the current ones are saved beside this script first',
        '#   status                   restart status, deployment status and stack status',
        '#   deployment [ID]          deployment status, or one deployment',
        '#   retry [--dry-run]        retry the failed deployment',
        '#   restart --confirm STACK [--dry-run]  restart the stack, then wait for it',
        '# options:',
        '#   --stack S  --token-file F',
        `#   --method M               POST or PUT for set-preferences (default ${method})`,
        `#   --ignore-deployments     restart even while deployment/status shows work in progress${blockDeploying ? '' : ' (on by default here)'}`,
        'set -euo pipefail',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...args(
          stack,
          server,
          [
            `PREFS_METHOD=${method}; IGNORE_DEPLOYMENTS=${blockDeploying ? 0 : 1}; TIMEOUT_MINUTES=${timeout}`,
            `ACS_POLL_SECONDS="\${ACS_POLL_SECONDS:-${poll}}"`,
          ],
          ['--method) PREFS_METHOD=$2; shift 2 ;;', '--ignore-deployments) IGNORE_DEPLOYMENTS=1; shift ;;'],
        ),
        '',
        ...acsPrelude(),
        '',
        'case "$CMD" in help|-h|--help) sed -n "2,20p" "$0"; exit 0 ;; esac',
        'case "$PREFS_METHOD" in POST|PUT) ;; *) die "--method is POST or PUT" ;; esac',
        'setup_acs',
        '',
        ...script`
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
show() { acs GET "$1" > "$WORK/out.json" || die "GET $1 failed"; jq . "$WORK/out.json"; }

# VERIFY the field names of restart/status on your stack; this reads the first of
# status, restartStatus and state, and treats anything it cannot read as unknown.
restart_state() {
  local s
  s=$(acs GET /restart/status 2>/dev/null | jq -r '.status // .restartStatus // .state // "unknown"' 2>/dev/null) || s=unknown
  printf '%s' "\${s:-unknown}"
}
busy() { case $(lower "$1") in *progress*|*running*|*restarting*|*pending*|*scheduled*) return 0 ;; *) return 1 ;; esac; }

# A deployment is in progress when deployment/status mentions one. VERIFY the
# response shape; this is a text match so it does not depend on field names.
deploying() {
  acs GET /deployment/status > "$WORK/dep.json" || die "could not read deployment/status"
  jq -e 'tostring | ascii_downcase | test("in.?progress|running|pending")' "$WORK/dep.json" > /dev/null
}

case "$CMD" in
  windows) show /maintenance-windows/schedules ;;
  window)
    [ -n "$TARGET" ] || die "window needs an ID (from: acs-maintenance.sh windows)"
    show "/maintenance-windows/schedules/$(enc "$TARGET")" ;;
  audits)
    [ -n "$TARGET" ] || die "audits needs a window ID"
    show "/maintenance-windows/schedules/$(enc "$TARGET")/audits" ;;
  preferences) show /maintenance-windows/preferences ;;
  set-preferences)
    [ -n "$TARGET" ] && [ -f "$TARGET" ] || die "set-preferences needs a JSON file; start from: acs-maintenance.sh preferences > preferences.json"
    jq -e 'type == "object"' "$TARGET" > /dev/null || die "$TARGET is not a JSON object"
    ts=$(date +%Y%m%d-%H%M%S)
    if acs GET /maintenance-windows/preferences > "$WORK/before.json" 2>/dev/null; then
      cp "$WORK/before.json" "$HERE/maintenance-preferences-before-$ts.json"
      note "current preferences saved: $HERE/maintenance-preferences-before-$ts.json"
    else
      note "could not read the current preferences; there is nothing saved to back out to"
    fi
    echo "$(mode)  $PREFS_METHOD /maintenance-windows/preferences $(jq -c . "$TARGET")"
    [ "$EXECUTE" = 1 ] || { echo "Dry run: nothing was changed. Run it without --dry-run to apply."; exit 0; }
    acs_json "$PREFS_METHOD" /maintenance-windows/preferences "$TARGET" > "$WORK/out.json" || die "$PREFS_METHOD preferences failed (try --method $([ "$PREFS_METHOD" = POST ] && echo PUT || echo POST))"
    jq . "$WORK/out.json" 2>/dev/null || true
    ;;
  status)
    echo "stack:   $(stack_status)"
    echo "restart: $(restart_state)"
    echo "== deployment/status"; show /deployment/status ;;
  deployment)
    if [ -n "$TARGET" ]; then show "/deployment/status/$(enc "$TARGET")"; else show /deployment/status; fi ;;
  retry)
    echo "$(mode)  POST /deployment/retry"
    [ "$EXECUTE" = 1 ] || exit 0
    acs POST /deployment/retry > "$WORK/out.json" || die "retry failed"
    jq . "$WORK/out.json" 2>/dev/null || true
    wait_ready ;;
  restart)
    [ "$CONFIRM" = "$STACK" ] || die "restarting $STACK interrupts every search and scheduled search on it. Repeat the stack name: --confirm $STACK"
    s=$(restart_state)
    busy "$s" && die "a restart is already $s; follow it with: acs-maintenance.sh status"
    if [ "$IGNORE_DEPLOYMENTS" != 1 ] && deploying; then
      die "deployment/status shows a deployment in progress; a restart now can leave it half applied. Wait, or pass --ignore-deployments"
    fi
    st=$(stack_status)
    [ "$st" = Ready ] || die "the stack is $st, not Ready; not restarting on top of that"
    echo "$(mode)  POST /restart-now on $STACK"
    [ "$EXECUTE" = 1 ] || { echo "Dry run: nothing was changed. Run it without --dry-run to restart."; exit 0; }
    acs POST /restart-now > "$WORK/out.json" || die "restart-now was refused"
    jq . "$WORK/out.json" 2>/dev/null || true
    start=$SECONDS; seen=0
    while :; do
      [ $((SECONDS - start)) -lt $((TIMEOUT_MINUTES * 60)) ] || die "no end to the restart after $TIMEOUT_MINUTES minutes; check with: acs-maintenance.sh status"
      s=$(restart_state)
      case $(lower "$s") in
        *fail*|*error*) die "restart reported: $s" ;;
      esac
      if busy "$s"; then
        seen=1
      elif [ "$seen" = 1 ] || [ $((SECONDS - start)) -ge "\${ACS_SETTLE_SECONDS:-120}" ]; then
        # Not busy any more, having been busy (or never seen busy for long enough to
        # be sure it has not simply not started yet).
        break
      fi
      note "restart: $s"
      sleep "$ACS_POLL_SECONDS"
    done
    wait_ready
    echo "restart finished: restart $(restart_state), stack $(stack_status)"
    ;;
  *) die "unknown command $CMD (try --help)" ;;
esac
`,
      ];

      const acsBase = base(server, stack);
      return {
        tier: TIER,
        title: `Splunk Cloud maintenance and restarts on ${stack}`,
        app,
        activation: 'reload',
        notes: [
          TOKEN_NOTE,
          `ops/acs-maintenance.sh restart --confirm ${stack} restarts the stack when run; --dry-run shows what it would do. It refuses while a restart is already running, while deployment/status shows work in progress${blockDeploying ? '' : ' (off here — see the finding)'}, or while the stack is not Ready, then polls restart/status every ${poll} seconds for up to ${timeout} minutes and waits for the stack to say Ready.`,
          'A restart interrupts running searches and delays scheduled ones. Splunk also restarts the stack itself in its maintenance windows; acs-maintenance.sh windows shows when the next one is.',
          'set-preferences sends a JSON file as-is. Start from what the stack returns (acs-maintenance.sh preferences > preferences.json) and edit that, so the field names are the stack’s own; the previous preferences are saved beside the script before anything is sent.',
          `VERIFY: whether maintenance-windows/preferences takes POST or PUT on your stack (sources differ; this package uses ${method}), and whether it answers GET.`,
          'VERIFY: the response fields of restart/status and deployment/status, and the method and body of deployment/retry, against the ACS OpenAPI (https://admin.splunk.com/service/info/specs/v2/openapi.json). The scripts read them defensively and print the raw JSON.',
          ...(server !== ACS_HOSTS[0].value ? [`FedRAMP High: the scripts call ${server}. Set ACS_SERVER in the environment to override it.`] : []),
        ],
        before: [
          `bash ops/acs-maintenance.sh status --stack ${stack}`,
          `bash ops/acs-maintenance.sh windows --stack ${stack}`,
          'Tell the people who search the stack when the restart will happen; scheduled searches that fall inside it run late or are skipped.',
        ],
        files: {
          'default/app.conf': kitConf(app, `ACS maintenance and restarts for ${stack}`),
          'ops/acs-maintenance.sh': sh,
          'ops/acs-rest.txt': [
            '# The REST calls acs-maintenance.sh makes:',
            `#   GET    ${acsBase}/maintenance-windows/schedules`,
            `#   GET    ${acsBase}/maintenance-windows/schedules/{id}`,
            `#   GET    ${acsBase}/maintenance-windows/schedules/{id}/audits`,
            `#   ${method.padEnd(6)} ${acsBase}/maintenance-windows/preferences`,
            `#   POST   ${acsBase}/restart-now`,
            `#   GET    ${acsBase}/restart/status`,
            `#   GET    ${acsBase}/deployment/status`,
            `#   GET    ${acsBase}/deployment/status/{id}`,
            `#   POST   ${acsBase}/deployment/retry`,
          ],
        },
        verify: [
          `bash ops/acs-maintenance.sh status --stack ${stack}   # stack Ready, no restart in progress`,
          '| rest /services/server/info splunk_server=local | table serverName startup_time version',
        ],
        backout: [
          '# A restart cannot be backed out; it is over when the stack is Ready again.',
          `bash ops/acs-maintenance.sh set-preferences ops/maintenance-preferences-before-<timestamp>.json --stack ${stack}   # the preferences as they were`,
        ],
        findings,
      };
    },
  }),

  // 3. Limits and private connectivity ---------------------------------------
  splunkBlueprint({
    id: 'splunk_acs_limits',
    tier: TIER,
    label: 'Limits and private connectivity through ACS',
    group: 'Admin Config Service',
    description: 'The limits.conf settings ACS lets a Cloud customer change, set one stanza and setting at a time with the current value read first and written down for the back out, and a read-only report of whether the stack is eligible for private connectivity and which endpoints it has.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_cloud_limits' },
      { id: 'stack', label: 'Stack', control: 'text', default: 'example-stack', hint: 'The first label of <stack>.splunkcloud.com' },
      hostInput,
      { id: 'limits', label: 'Limits', control: 'textarea', default: 'kv | limit | 200\nkv | maxcols | 1024', hint: 'stanza | setting | value — only the settings ACS exposes; acs-limits.sh show lists them' },
      { id: 'connectivity', label: 'Include the private connectivity report', control: 'toggle', default: true },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_cloud_limits'), 'org_cloud_limits');
      const stack = stackOf(values);
      const server = acsServer(values);
      const connectivity = bool(values, 'connectivity', true);
      const findings            = [...stackFindings(stack)];

      const wanted                                                       = [];
      const seen = new Set        ();
      for (const line of rows(str(values, 'limits', ''))) {
        const [stanza = '', setting = '', value = '', ...extra] = cells(line);
        if (extra.length > 0 || !stanza || !setting || !value) {
          findings.push(error('splunk.acs-limits-row', `"${line}" is not stanza | setting | value.`));
          continue;
        }
        if (!/^[A-Za-z0-9_:.-]+$/.test(stanza) || !/^[A-Za-z0-9_.-]+$/.test(setting)) {
          findings.push(error('splunk.acs-limits-name', `[${stanza}] ${setting} is not a limits.conf stanza and setting name (letters, digits, _ . - and : in a stanza).`));
          continue;
        }
        const key = `${stanza}/${setting}`;
        if (seen.has(key)) {
          findings.push(error('splunk.acs-limits-duplicate', `[${stanza}] ${setting} is listed twice; only one value can apply.`));
          continue;
        }
        seen.add(key);
        wanted.push({ stanza, setting, value });
      }
      if (wanted.length === 0 && !connectivity) findings.push(error('splunk.acs-limits-nothing', 'No limits and no connectivity report: there is nothing for this package to do.'));

      const sh = [
        '#!/usr/bin/env bash',
        '# Splunk Cloud limits through ACS, and the private connectivity report.',
        '#',
        '# usage: acs-limits.sh COMMAND [options]',
        '#   show [STANZA]            the limits ACS exposes, or one stanza',
        '#   plan                     compare limits.txt with the stack (no changes)',
        '#   apply [--dry-run]        set each setting that differs; the current values are',
        '#                            appended to limits-before-<time>.txt first',
        '#   connectivity             private connectivity eligibility and endpoints (read only)',
        '# options:',
        '#   --stack S  --token-file F',
        '#   --file F                 stanza | setting | value lines (default limits.txt beside this script)',
        'set -euo pipefail',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        ...args(stack, server, ['LIMITS_FILE="$HERE/limits.txt"'], ['--file) LIMITS_FILE=$2; shift 2 ;;']),
        '',
        ...acsPrelude(),
        '',
        'case "$CMD" in help|-h|--help) sed -n "2,14p" "$0"; exit 0 ;; esac',
        'setup_acs',
        '',
        ...script`
trim() { local s=$1; s=\${s#"\${s%%[![:space:]]*}"}; s=\${s%"\${s##*[![:space:]]}"}; printf '%s' "$s"; }

# current_value STANZA SETTING: the value on the stack, or a non-zero return.
# VERIFY the response shape; this accepts {"value": v}, {"<setting>": v} or the
# setting anywhere in the response.
current_value() {
  acs GET "/limits/$(enc "$1")/$(enc "$2")" > "$WORK/cur.json" 2>/dev/null || return 1
  jq -er --arg k "$2" '(if type == "object" and has("value") then .value
      elif type == "object" and has($k) then .[$k]
      else ([.. | objects | select(has($k)) | .[$k]] | first) end) // empty | tostring' "$WORK/cur.json"
}

case "$CMD" in
  show)
    if [ -n "$TARGET" ]; then acs GET "/limits/$(enc "$TARGET")" | jq .; else acs GET /limits | jq .; fi ;;
  connectivity)
    ts=$(date +%Y%m%d-%H%M%S)
    acs GET /private-connectivity/eligibility > "$WORK/eligibility.json" || echo '{"error": "eligibility could not be read"}' > "$WORK/eligibility.json"
    acs GET /private-connectivity/endpoints > "$WORK/endpoints.json" || echo '{"error": "endpoints could not be read"}' > "$WORK/endpoints.json"
    jq -n --arg stack "$STACK" --arg at "$ts" --slurpfile e "$WORK/eligibility.json" --slurpfile p "$WORK/endpoints.json" \
      '{stack: $stack, at: $at, eligibility: $e[0], endpoints: $p[0]}' | tee "$HERE/private-connectivity-$ts.json"
    note "saved: $HERE/private-connectivity-$ts.json"
    ;;
  plan|apply)
    [ -f "$LIMITS_FILE" ] || die "not found: $LIMITS_FILE"
    label=PLAN; [ "$CMD" = plan ] || label=$(mode)
    BEFORE="$HERE/limits-before-$(date +%Y%m%d-%H%M%S).txt"
    unreadable=0
    while IFS= read -r line <&3; do
      line=$(trim "$line")
      [ -n "$line" ] && [ "\${line#\#}" = "$line" ] || continue
      IFS='|' read -r st se va extra <<< "$line"
      st=$(trim "$st"); se=$(trim "\${se:-}"); va=$(trim "\${va:-}")
      [ -n "$st" ] && [ -n "$se" ] && [ -n "$va" ] && [ -z "\${extra:-}" ] || die "not stanza | setting | value: $line"
      if ! cur=$(current_value "$st" "$se"); then
        printf 'UNREADABLE [%s] %s: ACS does not expose it, or the name is wrong (see: acs-limits.sh show %s)\n' "$st" "$se" "$st"
        unreadable=$((unreadable + 1)); continue
      fi
      if [ "$cur" = "$va" ]; then printf 'ok        [%s] %s = %s\n' "$st" "$se" "$va"; continue; fi
      printf '%-9s CHANGE  [%s] %s: %s -> %s\n' "$label" "$st" "$se" "$cur" "$va"
      [ "$CMD" = apply ] && [ "$EXECUTE" = 1 ] || continue
      [ -f "$BEFORE" ] || echo "# limits on $STACK before acs-limits.sh apply; back out with: acs-limits.sh apply --file $BEFORE" > "$BEFORE"
      printf '%s | %s | %s\n' "$st" "$se" "$cur" >> "$BEFORE"
      # VERIFY the method and body: PATCH with {"value": ...} per setting.
      jq -n --arg v "$va" '{value: $v}' > "$WORK/req.json"
      acs_json PATCH "/limits/$(enc "$st")/$(enc "$se")" "$WORK/req.json" > /dev/null || die "setting [$st] $se failed"
      for i in $(seq 1 30); do
        [ "$(current_value "$st" "$se" || true)" = "$va" ] && break
        [ "$i" -lt 30 ] || die "[$st] $se did not read back as $va in time"
        sleep "\${ACS_POLL_SECONDS:-10}"
      done
      echo "          done: [$st] $se = $va"
    done 3< "$LIMITS_FILE"
    [ ! -f "$BEFORE" ] || note "previous values: $BEFORE"
    [ "$CMD" = plan ] || [ "$EXECUTE" = 1 ] || echo "Dry run: nothing was changed. Run it without --dry-run to apply."
    [ "$unreadable" -eq 0 ] || exit 1
    ;;
  *) die "unknown command $CMD (try --help)" ;;
esac
`,
      ];

      const acsBase = base(server, stack);
      return {
        tier: TIER,
        title: `Splunk Cloud limits${connectivity ? ' and private connectivity' : ''} on ${stack}`,
        app,
        activation: 'reload',
        notes: [
          TOKEN_NOTE,
          'ops/acs-limits.sh apply reads each setting first, appends the current value to ops/limits-before-<time>.txt, sets the new one and reads it back; apply --dry-run previews, plan compares. A setting ACS does not expose shows as UNREADABLE and nothing is sent for it.',
          'ACS exposes only some limits.conf settings; acs-limits.sh show lists the ones your stack allows. Anything else is a support case.',
          'VERIFY: the method and body for limits/{stanza}/{setting} (the script sends PATCH {"value": "..."}) and the shape of its GET response, against the ACS OpenAPI (https://admin.splunk.com/service/info/specs/v2/openapi.json).',
          ...(connectivity
            ? ['acs-limits.sh connectivity only reads private-connectivity/eligibility and private-connectivity/endpoints and saves them as ops/private-connectivity-<time>.json. Setting up private connectivity is not an ACS change here.']
            : []),
          ...(server !== ACS_HOSTS[0].value ? [`FedRAMP High: the scripts call ${server}. Set ACS_SERVER in the environment to override it.`] : []),
        ],
        before: [
          `bash ops/acs-limits.sh show --stack ${stack}`,
          `bash ops/acs-limits.sh plan --stack ${stack}`,
        ],
        files: {
          'default/app.conf': kitConf(app, `ACS limits for ${stack}`),
          'ops/limits.txt': ['# stanza | setting | value', ...wanted.map((w) => `${w.stanza} | ${w.setting} | ${w.value}`)],
          'ops/acs-limits.sh': sh,
          'ops/acs-rest.txt': [
            '# The REST calls acs-limits.sh makes:',
            `#   GET    ${acsBase}/limits`,
            `#   GET    ${acsBase}/limits/{stanza}`,
            `#   GET    ${acsBase}/limits/{stanza}/{setting}`,
            `#   PATCH  ${acsBase}/limits/{stanza}/{setting}    {"value": "..."}`,
            ...(connectivity ? [`#   GET    ${acsBase}/private-connectivity/eligibility`, `#   GET    ${acsBase}/private-connectivity/endpoints`] : []),
          ],
        },
        verify: [
          `bash ops/acs-limits.sh plan --stack ${stack}   # every line ok, exit 0`,
          `| rest /services/configs/conf-limits splunk_server=local | search title IN (${[...new Set(wanted.map((w) => w.stanza))].join(', ') || '<stanza>'}) | table title ${[...new Set(wanted.map((w) => w.setting))].join(' ')}`,
        ],
        backout: [`bash ops/acs-limits.sh apply --file ops/limits-before-<time>.txt --stack ${stack}   # the values as they were`],
        findings,
      };
    },
  }),
];
