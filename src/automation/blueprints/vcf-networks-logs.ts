/**
 * VCF Operations for Networks.
 *
 * The place an automation is most often *triggered* rather than executed: a
 * flow that should not exist. Networks does not act on its own — it raises
 * something, and what listens is a webhook, a VCF Automation action or a
 * runbook.
 *
 * Which is why these emit a search and the thing that receives its result. A
 * search on its own is a saved question nobody asks.
 *
 * (The 9.1 log management blueprints are in vcf-ops-operate.ts; the shared
 * IMPORT.md builder stays here because the Networks and fleet files use it.)
 */

import { num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';

const NETWORKS = 'vcf-operations-networks' as const;

// ---------------------------------------------------------------------------
// Shared: Networks login
// ---------------------------------------------------------------------------

/**
 * The environment lines every Networks script opens with.
 *
 * apply.ts has no Networks target, so this is its authPreamble written out for
 * /api/ni. A token handed in directly suits a person at a terminal; a scheduled
 * job sets VCFNET_USER and VCFNET_PASSWORD_FILE instead and logs in for itself.
 * The password is read from a file only its owner can read and sent on stdin,
 * so it never appears in a crontab, a process list or the shell history.
 *
 * The body is the one PowervRNI's Connect-vRNIServer sends: username, password
 * and a domain of LOCAL/local, or LDAP and the directory domain.
 */
export function networksPreamble(): string[] {
  return [
    'if [[ -z "${VCFNET_TOKEN:-}" && -n "${VCFNET_PASSWORD_FILE:-}" ]]; then',
    '  : "${VCFNET_HOST:?set VCFNET_HOST, e.g. vcfnet.example.com}"',
    '  : "${VCFNET_USER:?set VCFNET_USER to the account VCFNET_PASSWORD_FILE belongs to}"',
    '  command -v jq >/dev/null || { echo "jq is required to log in" >&2; exit 2; }',
    '  # LOCAL/local for a local account; LDAP and the directory domain otherwise.',
    '  VCFNET_TOKEN=$(jq -n --arg u "$VCFNET_USER" --arg t "${VCFNET_DOMAIN_TYPE:-LOCAL}" --arg d "${VCFNET_DOMAIN:-local}" \\',
    '      --rawfile p "$VCFNET_PASSWORD_FILE" \'($p | rtrimstr("\\n")) as $p | {username: $u, password: $p, domain: {domain_type: $t, value: $d}}\' |',
    '    curl -sS -f -X POST "https://${VCFNET_HOST}/api/ni/auth/token" -H "Accept: application/json" -H "Content-Type: application/json" --data @- | jq -r \'.token // empty\')',
    '  [[ -n "$VCFNET_TOKEN" ]] || { echo "Networks login returned no token" >&2; exit 2; }',
    'fi',
    ': "${VCFNET_HOST:?set VCFNET_HOST, e.g. vcfnet.example.com}"',
    ': "${VCFNET_TOKEN:?set VCFNET_TOKEN (POST /api/ni/auth/token), or set VCFNET_USER and VCFNET_PASSWORD_FILE to a file holding its password, mode 600}"',
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
  ];
}

/** The environment a scheduled Networks job needs, for a crontab line: no secret in it. */
export function networksScheduledEnv(account = 'svc-archtoolkit'): string {
  return `VCFNET_HOST=vcfnet.example.com VCFNET_USER=${account} VCFNET_PASSWORD_FILE=/etc/archtoolkit/vcfnet-password`;
}

// ---------------------------------------------------------------------------
// Shared: IMPORT.md
// ---------------------------------------------------------------------------

export interface ImportStepSpec {
  readonly heading: string;
  readonly lines: readonly string[];
}

/**
 * IMPORT.md for the Logs, Networks and fleet blueprints: numbered steps in the
 * order they have to happen, each naming the file and exactly where it goes —
 * a menu path or one command — then what is confirmed, what is not, and where
 * it was established. Anything marked VERIFY was not in those sources.
 */
export function importGuide(opts: {
  readonly product: string;
  readonly intro: string;
  readonly steps: readonly (ImportStepSpec | undefined)[];
  readonly verify?: readonly string[];
  readonly sources: readonly string[];
}): string {
  const steps = opts.steps.filter((step): step is ImportStepSpec => step !== undefined);
  return [
    `# Importing this into ${opts.product}`,
    '',
    opts.intro,
    '',
    ...(steps.length > 1 ? ['Do the steps in order. Every script applies when run; add `--dry-run` to preview.', ''] : []),
    ...steps.flatMap((step, index) => [`## ${index + 1}. ${step.heading}`, '', ...step.lines, '']),
    '## Confirmed, and what to verify',
    '',
    ...(opts.verify && opts.verify.length > 0 ? opts.verify.map((line) => `- ${line}`) : ['- Nothing beyond what the steps say.']),
    '',
    '## Sources',
    '',
    ...opts.sources.map((line) => `- ${line}`),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// VCF Operations for Networks
// ---------------------------------------------------------------------------

export const NETWORKS_AUTOMATIONS: readonly AutomationBlueprint[] = [
  automationBlueprint({
    id: 'vcfnet_flow_check',
    platform: NETWORKS,
    label: 'Check for flows that should not exist',
    group: 'Segmentation',
    description:
      'The question a segmentation project needs answered every week and nobody asks after the first month: is anything still talking across the boundary we closed? A saved search, on a schedule, that reports rather than blocks — because a network automation that blocks on its own findings is how a data centre goes dark.',
    inputs: [
      { id: 'check_name', label: 'Check name', control: 'text', default: 'PCI zone — unexpected flows' },
      { id: 'source', label: 'From', control: 'text', default: "source security group = 'PCI'", hint: 'A condition in the Networks search bar’s language' },
      { id: 'destination', label: 'To', control: 'text', default: "destination security group != 'PCI'" },
      { id: 'allowed_ports', label: 'Except on ports', control: 'text', default: '443, 53', hint: 'The flows you already accept' },
      { id: 'window_hours', label: 'Look back (hours)', control: 'number', default: 24, min: 1, max: 720 },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/segmentation' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const checkName = str(values, 'check_name', 'Flow check');
      const source = str(values, 'source', '');
      const destination = str(values, 'destination', '');
      const allowed = listOf(str(values, 'allowed_ports', ''));
      const hours = num(values, 'window_hours', 24);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || checkName, 'flow-check');

      // The search bar's language, sent as-is to POST /api/ni/search/ql. Each
      // excepted port is its own != so the query uses only plain comparisons.
      const conditions = [source, destination, ...allowed.map((port) => `port != ${port}`)].map((part) => part.trim()).filter(Boolean);
      const search = conditions.length > 0 ? `flows where ${conditions.join(' and ')} in last ${hours} hours` : `flows in last ${hours} hours`;

      const findings: Finding[] = [];
      if (!source.trim() || !destination.trim()) {
        findings.push(error('vcfnet.flow.no-boundary', 'Without both a From and a To there is no boundary, so the check reports ordinary traffic.', { source: 'ArchToolKit' }));
      }
      if (allowed.length === 0) {
        findings.push(
          warning('vcfnet.flow.no-allowlist', 'No ports are excepted, so every legitimate flow across the boundary will be reported too.', {
            remediation: 'List what you already accept. A check that reports two thousand expected flows is a check somebody turns off.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: NETWORKS,
        title: `${checkName} — report flows crossing a boundary that should be closed`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Daily, over the last ${hours} hours`, worstCase: 'once a day' },
        scope: {
          what: 'Observed flows only. It reads what happened; it changes no rule and blocks nothing.',
          decidedBy: [
            `The search: ${source}.`,
            `To: ${destination}.`,
            allowed.length > 0 ? `Excluding ports ${allowed.join(', ')}.` : 'No port exclusions.',
            `Over the last ${hours} hours of collected flow data.`,
          ],
          ifWrong: 'You get a noisy report, or a quiet one that is hiding something. Neither breaks anything, which is the point of keeping this read-only.',
        },
        guardrails: [
          { rule: 'It reports; it never writes a firewall rule', because: 'An automation that closes flows on its own findings will close a flow that was load-bearing, at the worst possible moment, with no change record.' },
          { rule: 'Bounded to a time window', because: 'Flow data is large. An unbounded search is a slow query and an expensive one.' },
        ],
        dryRun: [`Paste the search into the Networks search bar first and look at what comes back: ${search}`, 'The result is the dry run; there is no acting version of this.'],
        undo: ['Nothing to undo. It reads.'],
        told: webhook
          ? [`Posted to ${webhook} when any flow matches: the count, the search and the first hundred flow ids. Nothing is posted on a clean run, and nothing when the search itself fails — that is the exit code’s job.`, 'Send it somewhere a person reviews weekly rather than to an alert channel — this is a review, not an incident.']
          : ['Nobody — set a destination, or this is a search nobody runs.'],
        requires: [
          'Flow collection from the relevant vCenter and NSX sources, and enough retention to cover the window.',
          'A read-only Networks account: VCFNET_USER and VCFNET_PASSWORD_FILE for a scheduled run, or VCFNET_TOKEN by hand.',
          'jq and curl.',
        ],
        files: {
          [`${base}.json`]: `${JSON.stringify({ name: checkName, search, schedule: 'daily', destination: webhook || '<REQUIRED>', reportOnly: true }, null, 2)}\n`,
          'run-check.sh': [
            '#!/usr/bin/env bash',
            '# Run the flow search and report what it found. Reads only.',
            '#',
            '# Exits 0 when nothing matched, 1 when flows crossed the boundary, and 2',
            '# when the search itself failed — so a scheduler can tell "something to',
            '# look at" from "the check is broken". A failed search is never posted as',
            '# if it were a result.',
            'set -euo pipefail',
            '',
            ...networksPreamble(),
            '',
            'RESULT=$(mktemp)',
            'trap \'rm -f "$RESULT"\' EXIT',
            '',
            '# POST /api/ni/search/ql takes the search bar’s language: {query, size}.',
            `HTTP=$(jq '{query: .search, size: 100}' ${base}.json | curl -sS -o "$RESULT" -w '%{http_code}' \\`,
            '  -X POST "https://${VCFNET_HOST}/api/ni/search/ql" \\',
            '  -H @<(printf \'Authorization: NetworkInsight %s\\n\' "$VCFNET_TOKEN") \\',
            '  -H "Accept: application/json" -H "Content-Type: application/json" \\',
            '  --data @-) || { echo "Networks did not answer" >&2; exit 2; }',
            'if [[ "$HTTP" != 2* ]]; then',
            '  echo "Search failed: HTTP ${HTTP}" >&2',
            '  head -c 500 "$RESULT" >&2; echo >&2',
            '  exit 2',
            'fi',
            '# A flow search answers with an entity list. Anything else is not a result.',
            'if ! jq -e \'.entity_list_response | type == "object"\' "$RESULT" >/dev/null; then',
            '  echo "Search returned no entity list; check the query in the search bar." >&2',
            '  exit 2',
            'fi',
            '',
            'TOTAL=$(jq -r \'.entity_list_response.total_count // 0\' "$RESULT")',
            `echo '${checkName.replace(/'/g, "'\\''")}'": \${TOTAL} flow(s)"`,
            'if (( TOTAL == 0 )); then',
            '  exit 0',
            'fi',
            'jq -r \'.entity_list_response.results[]? | .entity_id\' "$RESULT"',
            ...(webhook
              ? [
                  '',
                  `jq -n --arg check '${checkName.replace(/'/g, "'\\''")}' --arg search "$(jq -r .search ${base}.json)" --argjson total "$TOTAL" \\`,
                  '  --slurpfile r "$RESULT" \'{source: "vcfnet-flow-check", check: $check, search: $search, total: $total, flows: [$r[0].entity_list_response.results[]?.entity_id]}\' \\',
                  `  | curl -sS -f -X POST '${webhook.replace(/'/g, "'\\''")}' -H "Content-Type: application/json" --data @- >/dev/null \\`,
                  '  || echo "Could not post to the webhook." >&2',
                ]
              : []),
            'exit 1',
            '',
          ].join('\n'),
          'crontab.txt': `# Daily at 05:30, from the directory holding run-check.sh and ${base}.json.\n# The password file is mode 600 and owned by the account that runs this.\n30 5 * * * cd /opt/archtoolkit/${base} && ${networksScheduledEnv()} ./run-check.sh\n`,
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Networks',
            intro: `Networks has no file import for a search or a saved search. What goes into the product is the search text; what runs it is run-check.sh on a schedule. ${base}.json is read by run-check.sh, not by Networks.`,
            steps: [
              {
                heading: 'Put the search into Networks',
                lines: [
                  'Paste this into the search bar at the top of the Networks interface, run it, and read what comes back:',
                  '',
                  '```',
                  search,
                  '```',
                  '',
                  'To keep it in the product, save it from the results page (the save/bookmark action beside the search bar) under the check name. That is the only route: there is no import dialog or documented API for saved searches (VERIFY on your release).',
                ],
              },
              {
                heading: 'Schedule run-check.sh',
                lines: [
                  `Copy run-check.sh and ${base}.json to /opt/archtoolkit/${base} on a host that reaches Networks, run \`./run-check.sh\` once by hand, then install the line in crontab.txt with \`crontab -e\`. POST /api/ni/search/ql takes {query, size} — the body the script builds from ${base}.json.`,
                ],
              },
            ],
            verify: ['The search condition names (security group, port) are the search bar’s own; if the search bar rejects them, so will the API.'],
            sources: ['POST /api/ni/search/ql {query, size} and the {username, password, domain} login: PowervRNI (Invoke-vRNISearch, Connect-vRNIServer).'],
          }),
        },
        notes: [
          'Networks sees flows, not intent. A flow that appears here may be perfectly legitimate and undocumented, which is itself the finding.',
          'Run it for a month before anyone proposes acting on it. The first four weeks are mostly discovering what the boundary really carries.',
          'The body {query, size} for POST /api/ni/search/ql, the entity_list_response it returns, and the {username, password, domain} login body all follow PowervRNI (Invoke-vRNISearch, Connect-vRNIServer). The search condition names — source security group, destination security group, port — are the search bar’s; check the query returns what you expect there before scheduling it.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfnet_change_watch',
    platform: NETWORKS,
    label: 'Watch for NSX changes nobody raised',
    group: 'Change control',
    description:
      'A scheduled comparison of the NSX configuration against what it was, so a firewall rule added out of process is found in a day rather than at the next audit. Reports the difference; changes nothing.',
    inputs: [
      { id: 'watch_name', label: 'Name', control: 'text', default: 'NSX change watch' },
      {
        id: 'watch_what',
        label: 'Watch',
        control: 'select',
        options: [
          { value: 'dfw', label: 'Distributed firewall rules' },
          { value: 'groups', label: 'Security groups and their membership' },
          { value: 'segments', label: 'Segments and gateways' },
          { value: 'all', label: 'All of it' },
        ],
        default: 'dfw',
      },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/nsx-change' },
      { id: 'ignore_users', label: 'Ignore changes by', control: 'text', default: 'svc-terraform, svc-automation', hint: 'The accounts that are supposed to make changes' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const watchName = str(values, 'watch_name', 'NSX change watch');
      const what = str(values, 'watch_what', 'dfw');
      const webhook = str(values, 'webhook', '');
      const ignore = listOf(str(values, 'ignore_users', ''));
      const base = slugOf(name || watchName, 'nsx-change-watch');

      const findings: Finding[] = [];
      if (ignore.length === 0) {
        findings.push(
          warning('vcfnet.change.no-exclusions', 'Nothing is excluded, so every change your own automation makes will be reported as unexpected.', {
            remediation: 'List the service accounts that are meant to change NSX. What is left is the interesting part.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: NETWORKS,
        title: `${watchName} — report NSX changes made outside the expected accounts`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Daily, comparing against the previous run', worstCase: 'once a day' },
        scope: {
          what: what === 'all' ? 'Firewall rules, security groups and segments.' : what === 'dfw' ? 'Distributed firewall rules.' : what === 'groups' ? 'Security groups and membership.' : 'Segments and gateways.',
          decidedBy: ['What the previous run recorded.', ignore.length > 0 ? `Changes by ${ignore.join(', ')} are ignored.` : 'No accounts are ignored.'],
          ifWrong: 'A noisy report, or one that misses a change because the account making it was on the ignore list. Review that list as carefully as the report.',
        },
        guardrails: [
          { rule: 'Compares and reports; never reverts', because: 'Reverting a network change automatically, without knowing why it was made, is how a fix becomes an outage.' },
          ...(ignore.length > 0 ? [{ rule: `Changes by ${ignore.join(', ')} are expected`, because: 'Your own automation changing NSX is not a finding. Everything else is.' }] : []),
        ],
        dryRun: ['The first run has nothing to compare against and simply records the baseline. Keep that file; it is the reference.'],
        undo: ['Nothing to undo. Reverting an NSX change is a change of its own and belongs in the change process.'],
        told: webhook ? [`Posted to ${webhook}.`] : ['Nobody. Set a destination.'],
        requires: ['Read access to the NSX manager through Networks, and somewhere to keep the previous run’s baseline.'],
        files: {
          [`${base}.json`]: `${JSON.stringify({ name: watchName, watch: what, ignoreAccounts: ignore, destination: webhook || '<REQUIRED>', reportOnly: true, baselineFile: `${base}-baseline.json` }, null, 2)}\n`,
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Networks',
            intro: `Nothing here is imported into Networks. ${base}.json is the specification for the job that runs the comparison — what to watch, whose changes to ignore, where to report — for your scheduler or runbook tool to read.`,
            steps: [
              {
                heading: 'Take the baseline',
                lines: [
                  'In Networks, search the objects being watched (for example `firewall rules`, `security groups` or `nsx segments`) and export the result (the export action on the results page) as the first baseline; keep it in version control as the file named in baselineFile.',
                ],
              },
            ],
            verify: ['The comparison job itself is not generated here; the file says what it must do.'],
            sources: ['The search bar and its export: VMware Aria Operations for Networks user guide.'],
          }),
        },
        notes: [
          'An out-of-process firewall change is usually somebody fixing something at speed. The value here is the conversation the next morning, not the blame.',
          'Keep the baseline in version control rather than on the appliance. Then the diff is a commit, and the history is free.',
        ],
        findings,
      };
    },
  }),
];
