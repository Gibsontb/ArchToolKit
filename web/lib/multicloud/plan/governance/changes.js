/**
 * Change requests (addendum A.10.4).
 *
 * One CR per wave (an exit wave is one CR too) and one per Utilities change
 * bundle that has none yet:
 *
 *  - `governance/changes/<id>.md`: summary, justification, risk (A.10.17),
 *    impact, CIs, the window, the implementation plan (the runbook), the
 *    backout plan (the rollback steps) and the test plan (validation);
 *  - `governance/changes/change-requests.csv`: ServiceNow `change_request`
 *    import field names;
 *  - `governance/changes/create-change-requests.sh` (optional): creates them
 *    through the ServiceNow Table API. Idempotent through
 *    `correlation_id = atk-<plan8>-<id>` (looked up first). It applies by
 *    default; `--dry-run` prints the payloads. SN_INSTANCE, SN_USER and the
 *    password from `atk_secret SN_PASSWORD` (environment, a mode-600 file or
 *    the vault command) — never a file the kit writes, never an argument.
 *
 * The CR number is recorded back in the tracker by hand, and G1 checks it.
 */

import { PLATFORM_INFO } from '../../platforms.js';
                                                                                                           
import { appComplexity, crRiskOf, higherBand,                     } from './complexity.js';
                                           
import { fileSlug } from './signoffs.js';

/** ServiceNow `change_request` import field names, in this order. */
export const SERVICENOW_CR_FIELDS = Object.freeze([
  'short_description', 'description', 'justification', 'implementation_plan', 'backout_plan', 'test_plan',
  'risk', 'impact', 'start_date', 'end_date', 'cmdb_ci', 'correlation_id',
]         );
                                                                      

export const SERVICENOW_SOURCES = Object.freeze([
  'ServiceNow REST API reference, Table API: POST /api/now/table/{tableName}; GET with sysparm_query, sysparm_fields, sysparm_limit (verify on your release).',
  'change_request risk 2 High / 3 Moderate / 4 Low and impact 1 High / 2 Medium / 3 Low are the base choice lists; verify them on the instance.',
]);

                                     
                      
                                                        
                                                               
                                                            
                                  
                                    
                                          
 

/** The plan's short id for names: the first 8 alphanumerics of Plan.id. */
export const plan8 = (plan                  )         => (plan.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'plan').toLowerCase();
export const correlationId = (plan                  , id        )         => `atk-${plan8(plan)}-${id}`;

/** ServiceNow's date-time field format: yyyy-mm-dd hh:mm:ss (UTC here). */
export function snDate(iso                    , fallbackTime = '00:00:00')         {
  if (!iso) return '';
  const t = iso.length <= 10 ? `${iso.slice(0, 10)} ${fallbackTime}` : iso.slice(0, 19).replace('T', ' ');
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? t : '';
}

const IMPACT_BY_CRIT                                        = { tier0: '1', tier1: '2', tier2: '3', tier3: '3' };

/** The rollback steps (AWS cutover runbook R1–R10, condensed) — the backout plan. */
export const BACKOUT_STEPS = Object.freeze([
  'Decide rollback against the agreed trigger (the migration lead is accountable).',
  'Stop the target instances / databases so nothing writes to them.',
  'Revert DNS and load-balancer changes (rollback.sh does both).',
  'Start the source servers; for databases, resume the source as primary.',
  'Sync data written on the target back to the source if needed (the path\'s rollback verb says how).',
  'Test the application on the source; the app owner confirms.',
  'Send the rollback notice; return the items to the wave backlog.',
]);

                            
                                                                        
                      
                                         
                                                   
 

function waveDraft(plan      , wave          , opts           )                     {
  const kind = wave.kind === 'exit' ? 'exit-wave' : 'wave';
  const id = `${kind === 'exit-wave' ? 'exit-' : ''}wave-${wave.n}`;
  const scores = wave.apps.map((a) => appComplexity(plan, a, { on: opts.on }));
  const band = scores.reduce                ((b, s) => higherBand(b, s.risk), 'Low');
  const crits = wave.apps.map((a) => plan.apps.find((x) => x.name === a)?.criticality ?? 'tier2');
  const impact = crits.map((c) => IMPACT_BY_CRIT[c]).sort()[0] ?? '3';
  const platforms = [...new Set(wave.items.map((i) => plan.decision?.items[i.id]?.chosen?.platform).filter((p)                => !!p))];
  const cis = [...wave.apps, ...wave.items.map((i) => i.name)];
  const hyper = Math.max(0, ...crits.map((c) => opts.execution?.hypercareDays[c] ?? 0));
  const keep = Math.max(0, ...crits.map((c) => opts.execution?.keepDays[c] ?? 0));
  const record                                    = {
    short_description: `Migration wave ${wave.n}${wave.name ? ` (${wave.name})` : ''}: ${wave.apps.join(', ') || 'no apps yet'}`,
    description: [
      `Move ${wave.items.length} item(s) of ${wave.apps.length} application(s) to ${platforms.map((p) => PLATFORM_INFO[p].label).join(', ') || 'the target platform'}.`,
      `Configuration items: ${cis.join(', ') || '—'}.`,
      `Risk ${band}: ${scores.map((s) => `${s.app} ${s.score} (${s.risk})`).join('; ') || '—'}.`,
    ].join('\n'),
    justification: `${plan.name}: ${plan.mode === 'dc-exit' ? 'data-centre exit' : 'migration programme'} wave ${wave.n}, as planned and approved (sign-offs plan-approved and design-approved per app).`,
    implementation_plan: [
      `Runbook: runbooks/wave-${wave.n}.md and execute/wave-${wave.n}/cutover.sh (applies by default; --dry-run to preview).`,
      '1. Pre-checks (G1 criteria) 2. Freeze and final sync 3. Stop source 4. Cut over and start target 5. DNS / load-balancer switch 6. Validate 7. Hand over to hypercare.',
      hyper ? `Hypercare: ${hyper} day(s).` : '',
    ].filter(Boolean).join('\n'),
    backout_plan: [...BACKOUT_STEPS.map((s, i) => `${i + 1}. ${s}`), keep ? `The source is kept for ${keep} day(s) after cutover, so rollback stays possible until then.` : ''].filter(Boolean).join('\n'),
    test_plan: `Validation: execute/wave-${wave.n}/validate.sh (smoke, port, service and SQL checks; performance against the baseline). The app owners run their test plans and sign test-passed (G1) and accepted (G3).`,
    risk: crRiskOf(band).risk,
    impact,
    start_date: snDate(wave.start),
    end_date: snDate(wave.end, '23:59:59'),
    cmdb_ci: wave.apps[0] ?? '',
    correlation_id: correlationId(plan, id),
  };
  return { id, kind, record, cis, riskBand: band, riskFactors: scores.flatMap((s) => s.factors.filter((f) => f.points > 0).map((f) => `${s.app}: ${f.label} = ${f.points}`)) };
}

function bundleDraft(plan      , change              )                     {
  const id = `change-${fileSlug(change.id)}`;
  const record                                    = {
    short_description: `${change.utility}: ${change.summary}`.slice(0, 160),
    description: `${change.summary}\nTarget: ${change.target}\nSettings: ${Object.entries(change.values).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    justification: `Utility change on ${change.target}, prepared in the Multi-Cloud Migration & Utilities page.`,
    implementation_plan: `Apply the generated bundle for ${change.id} (applies by default; --dry-run to preview).`,
    backout_plan: 'Run the bundle\'s rollback (every utility bundle has one).',
    test_plan: 'The bundle\'s post-checks; confirm with the service owner.',
    risk: crRiskOf('Low').risk,
    impact: '3',
    start_date: '',
    end_date: '',
    cmdb_ci: change.target,
    correlation_id: correlationId(plan, id),
  };
  return { id, kind: 'change-bundle', record, cis: [change.target], riskBand: 'Low', riskFactors: [] };
}

/** Every CR the plan needs. Change bundles that already carry a CR number are skipped. */
export function changeRequests(plan      , waves                     , opts           )                       {
  return [
    ...[...waves].sort((a, b) => a.n - b.n).map((w) => waveDraft(plan, w, opts)),
    ...(opts.changeRecords ?? []).filter((c) => !c.cr).map((c) => bundleDraft(plan, c)),
  ];
}

const csvField = (t        )         => (/[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);

/** change-requests.csv, ServiceNow field names as the header. */
export function changeRequestsCsv(drafts                               )         {
  const lines = [SERVICENOW_CR_FIELDS.join(',')];
  for (const d of drafts) lines.push(SERVICENOW_CR_FIELDS.map((f) => csvField(d.record[f])).join(','));
  return `${lines.join('\n')}\n`;
}

export function changeRequestMarkdown(d                    )         {
  const r = d.record;
  const riskLabel = d.riskBand === 'High' ? 'High' : d.riskBand === 'Medium' ? 'Moderate' : 'Low';
  return [
    `# Change request ${d.id}`, '',
    `**Summary:** ${r.short_description}`, '',
    `**Correlation id:** \`${r.correlation_id}\` (the CR number is recorded in the tracker once raised)`, '',
    '## Justification', '', r.justification, '',
    '## Description', '', r.description, '',
    '## Risk and impact', '',
    `- Risk: ${riskLabel} (ServiceNow ${r.risk})`,
    `- Impact: ${r.impact === '1' ? 'High' : r.impact === '2' ? 'Medium' : 'Low'} (ServiceNow ${r.impact})`,
    ...d.riskFactors.map((f) => `  - ${f}`), '',
    '## Configuration items', '', ...d.cis.map((c) => `- ${c}`), '',
    '## Window', '', `${r.start_date || '[start]'} to ${r.end_date || '[end]'} (UTC)`, '',
    '## Implementation plan', '', r.implementation_plan, '',
    '## Backout plan', '', r.backout_plan, '',
    '## Test plan', '', r.test_plan, '',
  ].join('\n');
}

/** The shared secret helper (the execution kit's `atk_secret` contract, A.6.2). */
export const ATK_SECRET_SH = [
  '# atk_secret NAME: $NAME, else the contents of $NAME_FILE (mode 600), else `$ATK_VAULT_CMD NAME`.',
  'atk_secret() {',
  '  local name="$1" file_var="${1}_FILE"',
  '  if [[ -n "${!name:-}" ]]; then printf \'%s\' "${!name}"; return; fi',
  '  if [[ -n "${!file_var:-}" ]]; then',
  '    local f="${!file_var}"',
  '    [[ "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" == 600 ]] || { echo "$file_var must be mode 600" >&2; exit 3; }',
  '    tr -d \'\\n\' < "$f"; return',
  '  fi',
  '  if [[ -n "${ATK_VAULT_CMD:-}" ]]; then',
  '    # shellcheck disable=SC2059',
  '    local cmd; cmd=$(printf "$ATK_VAULT_CMD" "$name"); bash -c "$cmd"; return',
  '  fi',
  '  echo "Set $name, ${name}_FILE or ATK_VAULT_CMD" >&2; exit 3',
  '}',
];

/** The ServiceNow login and call helper: credentials through a curl config on a pipe, never in argv. */
export const SN_API_SH = [
  ': "${SN_INSTANCE:?set SN_INSTANCE, e.g. example.service-now.com}"',
  ': "${SN_USER:?set SN_USER}"',
  'command -v jq >/dev/null || { echo "jq is required" >&2; exit 3; }',
  'SN_PASS=$(atk_secret SN_PASSWORD)',
  'sn() {',
  '  local method="$1" path="$2"; shift 2',
  '  curl -sS -f -X "$method" "https://${SN_INSTANCE}${path}" \\',
  '    --config <(printf \'user = "%s:%s"\\n\' "$SN_USER" "$SN_PASS") \\',
  '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
  '}',
];

/** create-change-requests.sh: idempotent by correlation_id; applies by default. */
export function createChangeRequestsScript()         {
  return [
    '#!/usr/bin/env bash',
    '# Create the change requests in ServiceNow (Table API, change_request).',
    '# Applies by default; --dry-run prints each payload instead of creating it.',
    '# Idempotent: a CR with the same correlation_id is found first and skipped.',
    '# Needs SN_INSTANCE, SN_USER and SN_PASSWORD (or SN_PASSWORD_FILE, mode 600, or ATK_VAULT_CMD).',
    'set -euo pipefail',
    'DRY_RUN=0',
    'for a in "$@"; do case "$a" in --dry-run) DRY_RUN=1 ;; *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;; esac; done',
    'cd "$(dirname "$0")"',
    '',
    ...ATK_SECRET_SH,
    '',
    ...SN_API_SH,
    '',
    'failed=0',
    'echo "id,correlation_id,number" > created.csv',
    'while IFS= read -r row; do',
    '  cid=$(jq -r .correlation_id <<<"$row")',
    '  found=$(sn GET /api/now/table/change_request -G --data-urlencode "sysparm_query=correlation_id=${cid}" \\',
    '    --data-urlencode "sysparm_fields=number,sys_id" --data-urlencode "sysparm_limit=1" | jq -r \'.result[0].number // empty\') || { failed=1; continue; }',
    '  if [[ -n "$found" ]]; then echo "exists  ${cid}  ${found}"; echo "${cid#atk-*-},${cid},${found}" >> created.csv; continue; fi',
    '  if (( DRY_RUN )); then echo "would create ${cid}:"; jq . <<<"$row"; continue; fi',
    '  number=$(jq -c . <<<"$row" | sn POST /api/now/table/change_request --data @- | jq -r \'.result.number // empty\') || { echo "failed  ${cid}" >&2; failed=1; continue; }',
    '  echo "created ${cid}  ${number}"',
    '  echo "${cid#atk-*-},${cid},${number}" >> created.csv',
    'done < <(jq -c \'.[]\' change-requests.json)',
    'echo "Record each CR number in the tracker (Waves, Governance, Change requests); G1 checks it."',
    'exit $(( failed ? 10 : 0 ))',
    '',
  ].join('\n');
}

/** The governance/changes/ files. */
export function changeRequestFiles(drafts                               , options                                = {})                         {
  const files                         = {};
  for (const d of drafts) files[`governance/changes/${d.id}.md`] = changeRequestMarkdown(d);
  files['governance/changes/change-requests.csv'] = changeRequestsCsv(drafts);
  if (options.script !== false) {
    files['governance/changes/change-requests.json'] = `${JSON.stringify(drafts.map((d) => d.record), null, 2)}\n`;
    files['governance/changes/create-change-requests.sh'] = createChangeRequestsScript();
  }
  return files;
}

/** G1's CR criterion: the wave's CR recorded with a number and approved. */
export function crCriterion(crs                      , waveId        )                                                              {
  const cr = crs.find((c) => c.id === waveId);
  const met = !!cr?.number && cr.status === 'approved';
  return { id: `cr.${waveId}`, auto: true, met, detail: cr ? `CR ${cr.number ?? '(no number)'} is ${cr.status}.` : 'No change request recorded.' };
}
