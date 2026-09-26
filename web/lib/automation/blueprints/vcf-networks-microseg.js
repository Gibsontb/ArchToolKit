/**
 * VCF Operations for Networks: micro-segmentation, from recommended rules to
 * an NSX distributed firewall policy.
 *
 * Networks recommends allow rules from the flows it has seen for an
 * application, a tier or an NSX security group (POST /micro-seg/recommended-rules).
 * The 9.x export (POST /micro-seg/recommended-rules/nsx) is an NSX-V zip, and
 * the interface's "Create Policy" has no API, so the policy is written for the
 * NSX Policy API here: an NSX group per tier (its members' IPv4 and IPv6
 * addresses), existing NSX groups by name, and one security policy in the
 * chosen category with the rules and an optional default deny.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { slugOf,                 } from '../automation.js';
import { importGuide, networksApi } from './vcf-networks-logs.js';
import { API_REF, NET, NET_SRC, shq } from './vcf-networks-common.js';

const NSX_AUTH = [
  ': "${NSX_HOST:?set NSX_HOST to the NSX Manager VIP or FQDN}"',
  ': "${NSX_USER:?set NSX_USER to an NSX account with the Security Engineer role}"',
  ': "${NSX_PASSWORD_FILE:?set NSX_PASSWORD_FILE to a mode-600 file holding the password of NSX_USER}"',
  'NSX_TLS=()',
  '[[ -n "${NSX_CACERT:-}" ]] && NSX_TLS=(--cacert "$NSX_CACERT")',
  '# nsx METHOD PATH [curl args]. Basic auth from a config on stdin, never argv.',
  'nsx() {',
  '  local method="$1" path="$2"; shift 2',
  '  jq -rn --arg u "$NSX_USER" --rawfile p "$NSX_PASSWORD_FILE" \'"user = " + (($u + ":" + ($p | rtrimstr("\\n"))) | tojson)\' |',
  '    curl -sS -f ${NSX_TLS[@]+"${NSX_TLS[@]}"} -K - -X "$method" "https://${NSX_HOST}${path}" \\',
  '      -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
  '}',
];

export const VCFNET_MICROSEG                      = automationBlueprint({
  id: 'vcfnet_microseg_policy',
  platform: NET,
  label: 'Micro-segmentation: recommended rules to an NSX firewall policy',
  group: 'Segmentation',
  description:
    'Take the allow rules Networks recommends from observed flows for an application, a tier or an NSX security group — optionally only between two of them — and turn them into an NSX distributed firewall policy: a group per tier from its members’ addresses, the rules with their ports, and an optional default deny, in the category and sequence you choose. Applied to NSX, or written as NSX policy JSON or a CSV for review.',
  inputs: [
    {
      id: 'scope_type',
      label: 'Recommend for',
      control: 'select',
      options: [
        { value: 'Application', label: 'An application (its tiers)' },
        { value: 'Tier', label: 'A tier' },
        { value: 'NSXSecurityGroup', label: 'An NSX security group' },
      ],
      default: 'Application',
    },
    { id: 'group_1', label: 'Name', control: 'text', default: 'Orders' },
    { id: 'group_2', label: 'Only traffic with (optional)', control: 'text', default: '', hint: 'A second one of the same type. Empty: all its inbound and outbound traffic' },
    {
      id: 'window_days',
      label: 'Flows from the last',
      control: 'select',
      options: [
        { value: '30', label: '30 days' },
        { value: '14', label: '14 days' },
        { value: '7', label: '7 days' },
        { value: '1', label: '1 day' },
      ],
      default: '30',
    },
    { id: 'include_external', label: 'Include internet and shared services outside the scope', control: 'toggle', default: true },
    {
      id: 'output',
      label: 'Output',
      control: 'select',
      options: [
        { value: 'apply', label: 'Apply the policy to NSX' },
        { value: 'nsx-json', label: 'Write the NSX policy JSON only' },
        { value: 'csv', label: 'Write the rules as CSV only' },
      ],
      default: 'apply',
    },
    { id: 'policy_name', label: 'NSX policy name', control: 'text', default: 'Orders — recommended', showWhen: { input: 'output', notEquals: ['csv'] } },
    {
      id: 'category',
      label: 'DFW category',
      control: 'select',
      options: [
        { value: 'Application', label: 'Application' },
        { value: 'Environment', label: 'Environment' },
        { value: 'Infrastructure', label: 'Infrastructure' },
        { value: 'Emergency', label: 'Emergency' },
      ],
      default: 'Application',
      showWhen: { input: 'output', notEquals: ['csv'] },
    },
    { id: 'sequence', label: 'Policy sequence number', control: 'number', default: 1000, min: 0, max: 999999, showWhen: { input: 'output', notEquals: ['csv'] } },
    {
      id: 'default_rule',
      label: 'Last rule',
      control: 'select',
      options: [
        { value: 'none', label: 'None (allow rules only)' },
        { value: 'DROP', label: 'Drop everything else to the scope' },
        { value: 'REJECT', label: 'Reject everything else to the scope' },
      ],
      default: 'none',
      showWhen: { input: 'output', notEquals: ['csv'] },
    },
    { id: 'log', label: 'Log rule hits', control: 'toggle', default: true, showWhen: { input: 'output', notEquals: ['csv'] } },
    { id: 'nsx_host', label: 'NSX Manager', control: 'text', default: 'nsx-wld01.example.com', showWhen: { input: 'output', equals: ['apply'] } },
  ],
  automation: (values                 , name        )             => {
    const scopeType = str(values, 'scope_type', 'Application');
    const g1 = str(values, 'group_1', '');
    const g2 = str(values, 'group_2', '');
    const days = num(values, 'window_days', 30);
    const external = bool(values, 'include_external', true);
    const output = str(values, 'output', 'apply');
    const policyName = str(values, 'policy_name', `${g1} — recommended`);
    const category = str(values, 'category', 'Application');
    const sequence = num(values, 'sequence', 1000);
    const defaultRule = str(values, 'default_rule', 'none');
    const log = bool(values, 'log', true);
    const nsxHost = str(values, 'nsx_host', '');
    const base = slugOf(name || `${g1}-microseg`, 'microseg');
    const policyId = slugOf(policyName, 'vcfnet-policy');

    const findings            = [];
    if (!g1) findings.push(error('vcfnet.microseg.no-scope', 'Name the application, tier or security group to recommend rules for.', { source: NET_SRC }));
    if (days < 7) findings.push(warning('vcfnet.microseg.short-window', `${days} day(s) of flows misses weekly jobs, backups and patching. Rules from a short window block them.`, { remediation: 'Use 30 days before a default deny goes in.', source: NET_SRC }));
    if (output !== 'csv' && defaultRule !== 'none') {
      findings.push(
        warning('vcfnet.microseg.default-deny', `A ${defaultRule} rule blocks every flow to the scope that was not seen in the last ${days} days.`, {
          remediation: 'Apply with the last rule off first, watch the rule hits for a cycle, then add the deny.',
          source: NET_SRC,
        }),
      );
    }
    if (output === 'apply' && category === 'Emergency') findings.push(warning('vcfnet.microseg.emergency', 'Emergency is evaluated before every other category; recommended allow rules do not belong there.', { source: NET_SRC }));
    if (!external) findings.push(warning('vcfnet.microseg.no-external', 'Without external traffic the rules have nothing for DNS, NTP, AD or the internet; a default deny would cut them off.', { source: NET_SRC }));
    if (output === 'apply' && !nsxHost) findings.push(error('vcfnet.microseg.no-nsx', 'Name the NSX Manager to apply the policy to.', { source: NET_SRC }));

    const script           = [
      '#!/usr/bin/env bash',
      `# Recommended rules for ${scopeType} "${g1.replace(/[\n"]/g, ' ')}"${g2 ? ` with "${g2.replace(/[\n"]/g, ' ')}"` : ''} from VCF Operations for Networks,`,
      output === 'apply' ? '# applied to NSX as one distributed firewall policy.' : output === 'nsx-json' ? '# written as NSX Policy API JSON (nsx/).' : '# written as recommended-rules.csv.',
      '#',
      '# --dry-run fetches and writes every file and applies nothing.',
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      ...networksApi(),
      ...(output === 'apply' ? [`NSX_HOST="\${NSX_HOST:-${nsxHost.replace(/["$`\\]/g, '')}}"`, ...NSX_AUTH] : []),
      '',
      'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
      `TYPE=${shq(scopeType)}; NAME1=${shq(g1)}; NAME2=${shq(g2)}`,
      `END=$(date +%s); START=$(( END - ${days} * 86400 ))`,
      'mkdir -p nsx/groups',
      '',
      '# resolve TYPE NAME: the entity id of the one object of that type and name.',
      'resolve() {',
      '  local out n',
      '  out=$(ni POST /search --data "$(jq -n --arg t "$1" --arg n "$2" \'{entity_type: $t, filter: ("name = \\u0027" + $n + "\\u0027"), size: 5}\')")',
      "  n=$(jq -r '.results | length' <<<\"$out\")",
      '  [[ "$n" == 1 ]] || { echo "$1 \\"$2\\": ${n} match(es); need exactly one" >&2; exit 2; }',
      "  jq -r '.results[0].entity_id' <<<\"$out\"",
      '}',
      'G1=$(resolve "$TYPE" "$NAME1")',
      'G2=""; [[ -n "$NAME2" ]] && G2=$(resolve "$TYPE" "$NAME2")',
      '',
      '# POST /micro-seg/recommended-rules',
      `jq -n --arg t "$TYPE" --arg g1 "$G1" --arg n1 "$NAME1" --arg g2 "$G2" --arg n2 "$NAME2" --argjson s "$START" --argjson e "$END" --argjson ext ${external} \\`,
      "  '{group_1: {entity: {entity_id: $g1, entity_type: $t, entity_name: $n1}}}",
      "   + (if $g2 != \"\" then {group_2: {entity: {entity_id: $g2, entity_type: $t, entity_name: $n2}}} else {} end)",
      "   + {time_range: {start_time: $s, end_time: $e}, include_external: $ext}' \\",
      '  | ni POST /micro-seg/recommended-rules --data @- > recommended-rules.json',
      "echo \"$(jq '.results | length' recommended-rules.json) recommended rule(s)\"",
      '',
      '# The name and type of every endpoint the rules use.',
      "jq -r '[.results[] | .sources[], .destinations[]] | unique_by(.entity_id) | .[] | [.entity_id, .entity_type] | @tsv' recommended-rules.json \\",
      "  | while IFS=$'\\t' read -r id type; do",
      '      nm=$(ni GET "/entities/names/$id" | jq -r \'.name // empty\' || true)',
      '      jq -n --arg id "$id" --arg t "$type" --arg n "${nm:-$id}" \'{id: $id, type: $t, name: $n}\'',
      '    done | jq -s . > endpoints.json',
      '',
      '# CSV for review: one row per rule, ports as start-end.',
      "jq -r --slurpfile ep endpoints.json '($ep[0] | map({(.id): .name}) | add // {}) as $n",
      '  | ["sources","destinations","protocols","ports","action"],',
      '    (.results[] | [([.sources[] | $n[.entity_id] // .entity_id] | join(" ")), ([.destinations[] | $n[.entity_id] // .entity_id] | join(" ")),',
      '      (.protocols | join(" ")), ([.port_ranges[]? | if .start == .end then "\\(.start)" else "\\(.start)-\\(.end)" end] | join(" ")), .action]) | @csv\' \\',
      '  recommended-rules.json > recommended-rules.csv',
      'echo "wrote recommended-rules.csv"',
    ];

    if (output !== 'csv') {
      script.push(
        '',
        '# One NSX path per endpoint: an existing NSX group by name, or a group of',
        '# the members’ addresses (IPv4 and IPv6) for a tier or application, or the',
        '# address itself for an IP endpoint. Anything else is ANY, and said so.',
        'echo "{}" > endpoint-paths.json',
        "while IFS=$'\\t' read -r id type nm; do",
        '  path="ANY"',
        '  case "$type" in',
        '    NSXSecurityGroup|NSXPolicyGroup|NSGroup)',
        '      path="/infra/domains/default/groups/$(jq -rn --arg n "$nm" \'$n | ascii_downcase | gsub("[^a-z0-9]+"; "-")\')"',
        output === 'apply'
          ? '      found=$(nsx GET "/policy/api/v1/search/query?query=$(jq -rn --arg n "$nm" \'"resource_type:Group AND display_name:\\"" + $n + "\\"" | @uri\')" | jq -r \'.results[0].path // empty\'); [[ -n "$found" ]] && path="$found" || echo "NSX group \\"$nm\\" not found by name; using $path" >&2'
          : '      echo "  $nm: existing NSX group assumed at $path (VERIFY)" >&2',
        '      ;;',
        '    Tier|Application|DiscoveredTier|DiscoveredApplication|IPEndpoint)',
        '      gid="vcfnet-$(jq -rn --arg n "$nm" \'$n | ascii_downcase | gsub("[^a-z0-9]+"; "-") | .[0:60]\')"',
        '      if [[ "$type" == IPEndpoint ]]; then IPS=$(jq -cn --arg n "$nm" \'[$n]\')',
        '      else',
        '        members=$( { [[ "$type" == *Tier ]] && ni POST /groups/tiers/members --data "$(jq -n --arg i "$id" \'{entity_ids: [$i]}\')" || ni POST /groups/applications/members --data "$(jq -n --arg i "$id" \'{entity_ids: [$i]}\')"; } \\',
        "          | jq -c '[.. | objects | select(.entity_type? == \"VirtualMachine\") | {entity_id, entity_type}] | unique')",
        '        IPS=$(ni POST /entities/fetch --data "$(jq -n --argjson m "$members" \'{entity_ids: $m}\')" | jq -c \'[.. | objects | .ip_address? // empty] | unique\')',
        '      fi',
        "      if [[ \"$(jq length <<<\"$IPS\")\" == 0 ]]; then echo \"  $nm: no member addresses found; using ANY\" >&2",
        '      else',
        '        jq -n --arg n "$nm" --argjson ips "$IPS" \'{display_name: ("vcfnet " + $n), description: "Members of the Networks tier or application, by address. Refreshed by rerunning this.",',
        '          expression: [{resource_type: "IPAddressExpression", ip_addresses: $ips}], tags: [{scope: "managed-by", tag: "vcf-automation"}]}\' > "nsx/groups/${gid}.json"',
        '        path="/infra/domains/default/groups/${gid}"',
        '      fi',
        '      ;;',
        '    *) echo "  $nm ($type): no NSX group for it; the rule uses ANY there" >&2 ;;',
        '  esac',
        '  jq --arg id "$id" --arg p "$path" \'. + {($id): $p}\' endpoint-paths.json > endpoint-paths.tmp && mv endpoint-paths.tmp endpoint-paths.json',
        "done < <(jq -r '.[] | [.id, .type, .name] | @tsv' endpoints.json)",
        '',
        '# The policy: one rule per recommendation, then the optional default rule.',
        `jq --slurpfile m endpoint-paths.json --slurpfile ep endpoints.json --arg name ${shq(policyName)} --arg cat ${shq(category)} --argjson seq ${sequence} --arg last ${shq(defaultRule)} --argjson log ${log} '`,
        '  ($m[0]) as $m | ($ep[0] | map({(.id): .name}) | add // {}) as $n',
        '  | ([$ep[0][] | select(.type | test("Tier|Application|SecurityGroup|PolicyGroup|NSGroup")) | $m[.id] // "ANY"] | map(select(. != "ANY")) | unique) as $scope',
        '  | [.results | to_entries[] | .key as $k | .value as $r',
        '      | ([$r.protocols[]? as $p | if ($p == "TCP" or $p == "UDP") then {resource_type: "L4PortSetServiceEntry", id: ("svc-" + ($p | ascii_downcase)), l4_protocol: $p,',
        '            destination_ports: [$r.port_ranges[]? | if .start == .end then "\\(.start)" else "\\(.start)-\\(.end)" end]}',
        '          elif ($p | test("ICMP")) then {resource_type: "ICMPTypeServiceEntry", id: "svc-icmp", protocol: "ICMPv4"} else empty end]) as $svc',
        '      | {resource_type: "Rule", id: ("r" + (($k + 1) | tostring)), display_name: ("rec " + (($k + 1) | tostring) + ": " + ([$r.sources[] | $n[.entity_id] // "?"] | join(",")) + " -> " + ([$r.destinations[] | $n[.entity_id] // "?"] | join(","))),',
        '         sequence_number: (($k + 1) * 10), source_groups: ([$r.sources[] | $m[.entity_id] // "ANY"] | unique), destination_groups: ([$r.destinations[] | $m[.entity_id] // "ANY"] | unique),',
        '         action: "ALLOW", logged: $log, disabled: false, ip_protocol: "IPV4_IPV6", scope: ["ANY"]}',
        '        + (if ($svc | length) > 0 then {services: ["ANY"], service_entries: $svc} else {services: ["ANY"]} end)',
        '        | if (.source_groups | index("ANY")) then .source_groups = ["ANY"] else . end | if (.destination_groups | index("ANY")) then .destination_groups = ["ANY"] else . end] as $rules',
        '  | {resource_type: "SecurityPolicy", display_name: $name, category: $cat, sequence_number: $seq, stateful: true,',
        '     scope: (if ($scope | length) > 0 then $scope else ["ANY"] end), tags: [{scope: "managed-by", tag: "vcf-automation"}],',
        '     rules: ($rules + (if $last == "none" or ($scope | length) == 0 then [] else [{resource_type: "Rule", id: "default-deny", display_name: "everything else to the scope",',
        '       sequence_number: 999990, source_groups: ["ANY"], destination_groups: $scope, services: ["ANY"], action: $last, logged: true, disabled: false, ip_protocol: "IPV4_IPV6", scope: ["ANY"]}] end))}',
        `' recommended-rules.json > nsx/security-policy-${policyId}.json`,
        `echo "wrote nsx/security-policy-${policyId}.json with $(jq '.rules | length' nsx/security-policy-${policyId}.json) rule(s) and $(ls nsx/groups | wc -l) group(s)"`,
      );
    }

    if (output === 'apply') {
      script.push(
        '',
        '(( DRY_RUN )) && { echo "Dry run: nothing was applied. Review nsx/ and recommended-rules.csv, then run it without --dry-run."; exit 0; }',
        '',
        '# Groups first (PATCH is create-or-update). A group of that id that this',
        '# kit did not create is left alone and the run stops.',
        'for f in nsx/groups/*.json; do',
        '  [[ -e "$f" ]] || continue',
        '  gid=$(basename "$f" .json)',
        '  cur=$(nsx GET "/policy/api/v1/infra/domains/default/groups/${gid}" 2>/dev/null || echo "")',
        '  if [[ -n "$cur" ]] && ! jq -e \'any(.tags[]?; .scope == "managed-by" and .tag == "vcf-automation")\' <<<"$cur" >/dev/null; then',
        '    echo "REFUSED: NSX group ${gid} exists and was not created by this automation." >&2; exit 2',
        '  fi',
        '  nsx PATCH "/policy/api/v1/infra/domains/default/groups/${gid}" --data @"$f" >/dev/null && echo "group ${gid}"',
        'done',
        `cur=$(nsx GET "/policy/api/v1/infra/domains/default/security-policies/${policyId}" 2>/dev/null || echo "")`,
        'if [[ -n "$cur" ]] && ! jq -e \'any(.tags[]?; .scope == "managed-by" and .tag == "vcf-automation")\' <<<"$cur" >/dev/null; then',
        `  echo "REFUSED: policy ${policyId} exists and was not created by this automation." >&2; exit 2`,
        'fi',
        `[[ -n "$cur" ]] && echo "$cur" > nsx/previous-policy-${policyId}.json`,
        `nsx PATCH "/policy/api/v1/infra/domains/default/security-policies/${policyId}" --data @nsx/security-policy-${policyId}.json >/dev/null`,
        `echo "policy ${policyId}: $(nsx GET "/policy/api/v1/infra/domains/default/security-policies/${policyId}/rules" | jq '.result_count // (.results | length)') rule(s) in NSX, category ${category}"`,
        '',
      );
    } else {
      script.push('', 'exit 0', '');
    }

    const outputs = output === 'apply' ? 'applied to NSX' : output === 'nsx-json' ? 'written as NSX policy JSON' : 'written as CSV';
    return {
      platform: NET,
      title: `Recommended rules for ${scopeType} "${g1}"${g2 ? ` ↔ "${g2}"` : ''}, ${days} days of flows, ${outputs}${output !== 'csv' && defaultRule !== 'none' ? `, default ${defaultRule}` : ''}`,
      effect: output === 'apply' ? 'reversible' : 'read',
      trigger: { kind: 'manual', detail: 'Run when the application definition and its flows are ready; rerun to refresh the rules and group memberships.', worstCase: 'once per run' },
      scope: {
        what: output === 'apply' ? `The NSX groups vcfnet-* for the endpoints, and the security policy ${policyId} in category ${category}${defaultRule !== 'none' ? `, which ${defaultRule === 'DROP' ? 'drops' : 'rejects'} every other flow to the scope` : ''}.` : 'Nothing in NSX. It reads flows and writes files.',
        decidedBy: [`${scopeType} "${g1}"${g2 ? ` and "${g2}"` : ''}, resolved by name (exactly one match or it stops).`, `Flows of the last ${days} days${external ? ', internet and shared services included' : ''}.`, 'Tier and application groups: the members’ addresses today.'],
        ifWrong: 'An allow rule too wide lets through what should be closed; with a default deny, a flow not seen in the window is blocked the moment the policy is applied. That is why the deny is off by default.',
      },
      guardrails: [
        { rule: 'Each name must match exactly one object', because: 'A name that matches two applications would recommend rules for the wrong one.' },
        ...(output === 'apply'
          ? [
              { rule: 'Only NSX objects tagged managed-by vcf-automation are overwritten', because: 'A group or policy of the same id built by hand may carry rules somebody depends on.' },
              { rule: 'The previous policy is saved before it is replaced', because: 'Undo is re-applying that file.' },
              { rule: `Its own category and sequence (${category}, ${sequence})`, because: 'Rules land where they were meant to in the evaluation order, not above an emergency block.' },
            ]
          : [{ rule: 'Writes files; applies nothing', because: 'The rules are reviewed before any of them reaches NSX.' }]),
      ],
      dryRun: [`Run ./${base}.sh --dry-run: it fetches the recommendations and writes recommended-rules.csv${output !== 'csv' ? ' and nsx/' : ''}, and applies nothing.`],
      undo:
        output === 'apply'
          ? [`Re-apply nsx/previous-policy-${policyId}.json with PATCH, or DELETE /policy/api/v1/infra/domains/default/security-policies/${policyId}; then DELETE each /infra/domains/default/groups/vcfnet-* no other rule uses.`]
          : ['Nothing to undo: nothing was applied.'],
      told: ['Nobody. The NSX audit log records the change; rule hits show in NSX and in Networks flows.'],
      requires: [
        'An application (vcfnet_applications) or NSX security group, and 30 days of IPFIX flows for it.',
        'A Networks account: VCFNET_USER and VCFNET_PASSWORD_FILE, or VCFNET_TOKEN.',
        ...(output === 'apply' ? ['NSX_USER and NSX_PASSWORD_FILE (mode 600) for an NSX account with the Security Engineer role; NSX_CACERT if NSX uses a private CA.'] : []),
        'jq and curl.',
      ],
      files: {
        [`${base}.sh`]: script.join('\n'),
        'IMPORT.md': importGuide({
          product: output === 'apply' ? 'NSX (from VCF Operations for Networks)' : 'VCF Operations for Networks',
          intro: `${base}.sh fetches the recommendations (POST /api/ni/micro-seg/recommended-rules) and writes recommended-rules.csv${output !== 'csv' ? `, nsx/groups/*.json and nsx/security-policy-${policyId}.json` : ''}${output === 'apply' ? ', then PATCHes the groups and the policy to the NSX Policy API' : ''}.`,
          steps: [
            {
              heading: output === 'apply' ? 'Review, then apply' : 'Generate',
              lines: [
                output === 'apply'
                  ? `\`./${base}.sh --dry-run\` writes every file and applies nothing; read recommended-rules.csv and nsx/, then \`./${base}.sh\`.`
                  : `\`./${base}.sh\` writes the files.`,
                '',
                'By hand in Networks: Security > Plan Security > the application > Recommended Firewall Rules (export as CSV).',
              ],
            },
          ],
          verify: [
            'The members call (POST /groups/tiers/members, /groups/applications/members) and POST /entities/fetch are read generically for VM ids and ip_address values; check the groups in nsx/groups/ list the addresses you expect.',
            'The protocol names in recommendations (TCP, UDP, ICMP…); anything else is left as ANY service.',
            'The micro-seg API takes Application, Tier and NSXSecurityGroup (and EC2SecurityGroup, not offered).',
          ],
          sources: [API_REF, 'Microsegmentation: POST /micro-seg/recommended-rules (group_1, group_2, time_range, include_external; results[{sources, destinations, protocols, port_ranges, action}]); /recommended-rules/nsx exports NSX-V format only.', 'NSX Policy API: PATCH /policy/api/v1/infra/domains/default/groups/{id} and /security-policies/{id} (SecurityPolicy, Rule, L4PortSetServiceEntry).'],
        }),
      },
      notes: [
        'Recommended rules describe what was seen, not what should be. Read every one before it is applied: a flow from a compromised host is a recommendation too.',
        'Tier groups here are addresses, refreshed each run. For groups that follow VMs as they come and go, move the tiers to NSX tags (tags_consume) and point the policy at those groups.',
      ],
      findings,
    };
  },
});
