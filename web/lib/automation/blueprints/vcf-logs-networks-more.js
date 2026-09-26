/**
 * VCF Operations for Networks: the groundwork and the settings.
 *
 * The first Networks blueprints (vcf-networks-logs.ts) raise things — a flow
 * that should not exist, an NSX change. These are what those stand on: the
 * data sources Networks collects from, what counts as East-West and Internet,
 * the application definitions it groups flows by, the micro-segmentation
 * policy written from them, intents and search-based alerts, who can log in,
 * and the configuration backup.
 *
 * The blueprints themselves live in vcf-networks-*.ts; this file orders them
 * and keeps the flow-based reachability check. Paths and bodies follow the
 * VCF Operations for Networks API reference (9.1 / 9.1.1 operation index);
 * where a field is not spelled out there the output says VERIFY.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { slugOf,                 } from '../automation.js';
import { importGuide, networksApi, networksScheduledEnv } from './vcf-networks-logs.js';
import { API_REF } from './vcf-networks-common.js';
import { VCFNET_DATA_SOURCES } from './vcf-networks-sources.js';
import { VCFNET_APPLICATIONS, VCFNET_APP_DISCOVERY } from './vcf-networks-apps.js';
import { VCFNET_MICROSEG } from './vcf-networks-microseg.js';
import { VCFNET_ACCESS, VCFNET_BACKUP, VCFNET_INTENTS, VCFNET_IP_DEFINITIONS, VCFNET_IP_TAGS_DNS, VCFNET_SEARCH_ALERT } from './vcf-networks-settings.js';

const NETWORKS = 'vcf-operations-networks'         ;
const SRC = 'VCF Operations for Networks API reference';

/** The login and the `ni` call helper, shared with every Networks script. */
function netPreamble()           {
  return networksApi();
}

const VCFNET_INTENT_CHECK                      = automationBlueprint({
  id: 'vcfnet_intent_check',
  platform: NETWORKS,
  label: 'Check that reachability matches intent',
  group: 'Segmentation',
  description:
    'A list of statements — this VM should reach that one, this one should not — checked against what Networks has observed. A flow the firewall allowed where the intent says deny, or blocked where it says allow, is reported and the script exits non-zero. It reads and reports; it never changes a rule.',
  inputs: [
    {
      id: 'intents',
      label: 'Intents',
      control: 'textarea',
      default: 'orders-web01 -> orders-db01 : deny\norders-app01 -> orders-db01 : allow\norders-web01 -> orders-app01 : allow',
      hint: 'One per line: source-vm -> destination-vm : allow | deny',
    },
    { id: 'window_hours', label: 'Look back (hours)', control: 'number', default: 24, min: 1, max: 720 },
    { id: 'strict', label: 'Fail when an allow has no flows at all', control: 'toggle', default: false, hint: 'Otherwise that is reported as no evidence' },
    { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/segmentation' },
  ],
  automation: (values                 , name        )             => {
    const hours = num(values, 'window_hours', 24);
    const strict = bool(values, 'strict', false);
    const webhook = str(values, 'webhook', '');
    const base = slugOf(name || 'intent-check', 'intent-check');

    const findings            = [];
    const intents                                                            = [];
    for (const line of str(values, 'intents', '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      const match = /^(.+?)\s*->\s*(.+?)\s*:\s*(allow|deny)\s*$/i.exec(line);
      if (!match) {
        findings.push(warning('vcfnet.intent.unparsed', `Could not read "${line}". Write it as: source -> destination : allow|deny.`, { source: SRC }));
        continue;
      }
      intents.push({ source: match[1] , destination: match[2] , intent: match[3] .toLowerCase() });
    }
    if (intents.length === 0) findings.push(error('vcfnet.intent.none', 'No intents to check.', { source: SRC }));
    if (hours < 24) {
      findings.push(info('vcfnet.intent.short-window', `A ${hours}-hour window misses anything that runs daily or less often — backups, batch jobs.`, { source: SRC }));
    }

    const script = [
      '#!/usr/bin/env bash',
      '# Is what was observed on the network what was intended? Reads only.',
      '#',
      '# For each intent, search the flows between the two VMs over the window.',
      '#   deny  + flows the firewall allowed -> violation',
      '#   deny  + flows seen, none allowed   -> enforced, reported as such',
      '#   allow + flows the firewall blocked -> violation',
      `#   allow + no flows at all            -> ${strict ? 'violation (strict)' : 'no evidence, reported but not failed'}`,
      '# Exits 1 on any violation.',
      'set -euo pipefail',
      ...netPreamble(),
      '',
      'END=$(date +%s)',
      `START=$(( END - ${hours} * 3600 ))`,
      'PROBLEMS=()',
      '',
      'count() {',
      '  ni POST /search --data "$(jq -n --arg f "$1" --argjson s "$START" --argjson e "$END" \\',
      '    \'{entity_type: "Flow", filter: $f, size: 1, time_range: {start_time: $s, end_time: $e}}\')" | jq -r \'.total_count // 0\'',
      '}',
      '',
      'while IFS=$\'\\t\' read -r SRC_VM DST_VM INTENT; do',
      '  BETWEEN="source_vm.name = \'${SRC_VM}\' and destination_vm.name = \'${DST_VM}\'"',
      '  SEEN=$(count "$BETWEEN")',
      '  if [[ "$INTENT" == "deny" ]]; then',
      '    # A deny that the firewall enforced still shows up as flows, with the',
      '    # action DROP or REJECT. Only flows it allowed break the intent.',
      '    ALLOWED=$(count "${BETWEEN} and firewall_action = \'ALLOW\'")',
      '    (( ALLOWED == 0 )) || PROBLEMS+=("${SRC_VM} -> ${DST_VM}: intended deny, ${ALLOWED} flow(s) allowed by the firewall")',
      '    if (( SEEN > ALLOWED )); then',
      '      echo "enforced: ${SRC_VM} -> ${DST_VM} (deny) — $(( SEEN - ALLOWED )) flow(s) attempted and not allowed"',
      '    fi',
      '  else',
      '    DROPPED=$(count "${BETWEEN} and (firewall_action = \'DROP\' or firewall_action = \'REJECT\' or firewall_action = \'DENY\')")',
      '    (( DROPPED == 0 )) || PROBLEMS+=("${SRC_VM} -> ${DST_VM}: intended allow, ${DROPPED} flow(s) blocked by the firewall")',
      '    if (( SEEN == 0 )); then',
      strict
        ? '      PROBLEMS+=("${SRC_VM} -> ${DST_VM}: intended allow, no flows observed")'
        : '      echo "no evidence: ${SRC_VM} -> ${DST_VM} (allow) — no flows in the window"',
      '    fi',
      '  fi',
      '  echo "${SRC_VM} -> ${DST_VM} (${INTENT}): ${SEEN} flow(s)"',
      "done < <(jq -r '.[] | [.source, .destination, .intent] | @tsv' intents.json)",
      '',
      'if (( ${#PROBLEMS[@]} == 0 )); then',
      '  echo "Observed reachability matches intent."',
      '  exit 0',
      'fi',
      'printf "%s\\n" "${PROBLEMS[@]}" >&2',
      ...(webhook
        ? [`curl -sS -X POST "${webhook}" -H "Content-Type: application/json" --data "$(printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "vcfnet-intent-check", problems: .}')" || true`]
        : []),
      'exit 1',
      '',
    ].join('\n');

    return {
      platform: NETWORKS,
      title: `Reachability intent check — ${intents.length} statement${intents.length === 1 ? '' : 's'} over ${hours} hours`,
      effect: 'read',
      trigger: { kind: 'schedule', detail: `Daily, over the last ${hours} hours of flows`, worstCase: 'once a day' },
      scope: {
        what: 'Observed flows between the named VM pairs. It reads flow records; it changes nothing.',
        decidedBy: intents.map((entry) => `${entry.source} -> ${entry.destination}: ${entry.intent}.`),
        ifWrong: 'A misnamed VM matches nothing, so a deny passes trivially. Check each name returns flows in the search bar before trusting a clean result.',
      },
      guardrails: [
        { rule: 'Reports; never writes a rule', because: 'An automation that closes a flow on its own finding will one day close one that was load-bearing.' },
        { rule: 'An allow with no flows is "no evidence", not a pass', because: 'Not having seen traffic is different from traffic being possible.' },
        { rule: 'A deny fails only on flows the firewall allowed', because: 'An enforced deny still leaves flow records — the attempts it dropped. Counting those would report a working rule as a violation.' },
      ],
      dryRun: ['It only reads. Run it by hand once and compare with a path search in the interface.'],
      undo: ['Nothing to undo.'],
      told: [webhook ? `${webhook}, on any violation.` : 'The exit code only.'],
      requires: ['IPFIX flow collection covering these VMs, from the NSX distributed firewall so each flow carries the action taken.', 'Flow retention at least as long as the window.', 'A read-only Networks account: VCFNET_USER and VCFNET_PASSWORD_FILE for the scheduled run, or VCFNET_TOKEN by hand.'],
      files: {
        [`${base}.sh`]: script,
        'intents.json': `${JSON.stringify(intents, null, 2)}\n`,
        'crontab.txt': `# Daily at 06:00, from the directory holding ${base}.sh and intents.json.\n# The password file is mode 600 and owned by the account that runs this.\n0 6 * * * cd /opt/vcf-automation/${base} && ${networksScheduledEnv()} ./${base}.sh\n`,
        'IMPORT.md': importGuide({
          product: 'VCF Operations for Networks',
          intro: `Nothing is imported into Networks: the check reads flows through POST /api/ni/search. intents.json is read by ${base}.sh.`,
          steps: [
            {
              heading: 'Schedule the check',
              lines: [`Copy ${base}.sh and intents.json to /opt/vcf-automation/${base}, run \`./${base}.sh\` once by hand and compare one pair with a path search in the interface ("VM 'a' to VM 'b'"), then install the line in crontab.txt with \`crontab -e\`.`],
            },
          ],
          verify: ['The Flow filter property names (source_vm.name, destination_vm.name, firewall_action) — see the notes in README.md.'],
          sources: [API_REF, 'Search: POST /api/ni/search (entity_type Flow, filter, size, time_range).'],
        }),
      },
      notes: [
        'This checks observed flows. Whether a path is possible — the "VM \'a\' to VM \'b\'" path search in the interface — is not exposed as a stable API in every release; use it by hand to confirm any violation this reports.',
        'The filter property names (source_vm.name, destination_vm.name, firewall_action) follow the Flow schema in the Networks API reference. The action values tested (ALLOW; DROP, REJECT, DENY) are the firewall’s — check which your release reports with a flow search in the interface. A wrong property name or value returns zero results, which reads as a pass for a deny.',
        'The deny check can only see what the firewall reported. A flow with no firewall action on it — one seen only through the distributed switch’s IPFIX, with no NSX distributed firewall in the path — is counted as seen but never as allowed, so it cannot fail a deny. The script prints those as "attempted and not allowed"; if a deny pair shows flows there and you have no DFW rule for it, look in the interface.',
      ],
      findings,
    };
  },
});

/** In the order the work is done: collect, classify, define, segment, alert, run. */
export const NETWORKS_MORE                                 = [
  VCFNET_DATA_SOURCES,
  VCFNET_IP_DEFINITIONS,
  VCFNET_IP_TAGS_DNS,
  VCFNET_APPLICATIONS,
  VCFNET_APP_DISCOVERY,
  VCFNET_MICROSEG,
  VCFNET_INTENT_CHECK,
  VCFNET_INTENTS,
  VCFNET_SEARCH_ALERT,
  VCFNET_ACCESS,
  VCFNET_BACKUP,
];
