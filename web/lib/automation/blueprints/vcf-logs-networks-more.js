/**
 * VCF Operations for Networks: the groundwork.
 *
 * The first Networks blueprints raise things — a flow that should not exist.
 * These are what those stand on: the data sources Networks collects from, the
 * application definitions it groups flows by, and the check that says whether
 * what is reachable is what was intended.
 *
 * (The 9.1 log management blueprints are in vcf-ops-operate.ts.)
 *
 * The Networks API has moved between releases. Where a path or a field is not
 * certain for 9.1 the file says so; export the same object from your own
 * instance and compare before applying.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { importGuide, networksPreamble, networksScheduledEnv } from './vcf-networks-logs.js';

const NETWORKS = 'vcf-operations-networks'         ;
const SRC = 'ArchToolKit';

/**
 * The preamble every Networks script opens with: log in (or take a token), then
 * the call helper. The login is shared with the flow check in
 * vcf-networks-logs.ts, because apply.ts has no Networks target.
 */
function netPreamble()           {
  return [
    ...networksPreamble(),
    '',
    'ni() {',
    '  local method="$1" path="$2"; shift 2',
    '  curl -sS -f -X "$method" "https://${VCFNET_HOST}/api/ni${path}" \\',
    '    -H @<(printf \'Authorization: NetworkInsight %s\\n\' "$VCFNET_TOKEN") \\',
    '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
  ];
}

const SOURCE_TYPES                                                                                                            = {
  vcenter: { label: 'vCenter', path: '/data-sources/vcenters', flows: true },
  nsxt: { label: 'NSX Manager', path: '/data-sources/nsxt-managers', flows: true },
  cisco: { label: 'Cisco switch', path: '/data-sources/cisco-switches', flows: false, extra: { switch_type: '<REQUIRED — e.g. CATALYST_3000, NEXUS_9K; verify>' } },
  arista: { label: 'Arista switch', path: '/data-sources/arista-switches', flows: false },
  juniper: { label: 'Juniper switch', path: '/data-sources/juniper-switches', flows: false, extra: { switch_type: '<REQUIRED — e.g. EX, QFX; verify>' } },
};

/** datasource_type for the Bulk add devices CSV. VERIFY against the dialog's sample .csv. */
const BULK_TYPES                                   = { cisco: 'CISCO_SWITCH', arista: 'ARISTA_SWITCH', juniper: 'JUNIPER_SWITCH' };

/** A CSV cell: quoted when it holds a comma, quote or newline. */
function csvCell(value        )         {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The quoted value in a Networks filter, for overlap checks. */
function quotedValues(filter        )           {
  return [...filter.matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => (match[1] ?? match[2] ?? '').toLowerCase()).filter(Boolean);
}

export const NETWORKS_MORE                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet_data_sources',
    platform: NETWORKS,
    label: 'Add data sources',
    group: 'Data sources',
    description:
      'Onboard the systems Networks collects from — vCenter, NSX, physical switches — through a named collector, with each credential read from the environment. And the setting that decides whether any of it produces flows: IPFIX on the distributed switches and NSX, without which Networks shows topology and nothing moving across it.',
    inputs: [
      {
        id: 'source_type',
        label: 'Source type',
        control: 'select',
        options: Object.entries(SOURCE_TYPES).map(([value, entry]) => ({ value, label: entry.label })),
        default: 'vcenter',
      },
      { id: 'fqdns', label: 'Sources', control: 'textarea', default: 'vcenter-mgmt.example.com\nvcenter-wld01.example.com', hint: 'One FQDN per line' },
      { id: 'collector_id', label: 'Collector id', control: 'text', default: '', hint: 'From GET /api/ni/infra/nodes. Empty resolves it by name below' },
      { id: 'collector_name', label: 'Collector name', control: 'text', default: 'vcfnet-collector01' },
      { id: 'username', label: 'Username', control: 'text', default: 'svc-vcfnet@vsphere.local' },
      { id: 'ipfix', label: 'Enable IPFIX / flow collection', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const type = str(values, 'source_type', 'vcenter');
      const source = SOURCE_TYPES[type] ?? SOURCE_TYPES.vcenter ;
      const fqdns = listOf(str(values, 'fqdns', ''));
      const collectorId = str(values, 'collector_id', '');
      const collectorName = str(values, 'collector_name', '');
      const user = str(values, 'username', '');
      const ipfix = bool(values, 'ipfix', true);
      const base = slugOf(name || `${type}-sources`, 'data-sources');

      const findings            = [];
      if (source.flows && !ipfix) {
        findings.push(
          warning('vcfnet.ds.no-ipfix', `IPFIX is not enabled, so these ${source.label} sources give Networks topology and configuration, and no flows.`, {
            remediation: 'Every flow-based feature — application discovery, micro-segmentation planning, the flow checks in this kit — needs IPFIX on the distributed switches (vCenter) or the NSX firewall.',
            source: SRC,
          }),
        );
      }
      if (fqdns.length === 0) findings.push(error('vcfnet.ds.none', 'No sources are listed.', { source: SRC }));
      if (!collectorId && !collectorName) findings.push(error('vcfnet.ds.no-collector', 'No collector is named. Every data source is polled through a collector.', { source: SRC }));
      if (/administrator@vsphere\.local|^admin$|^root$/i.test(user)) {
        findings.push(warning('vcfnet.ds.admin', `${user} is an administrator account. Networks needs read access plus the IPFIX privilege, not full admin.`, { source: SRC }));
      }

      const sources = fqdns.map((fqdn) => ({
        fqdn,
        nickname: fqdn.split('.')[0] ?? fqdn,
        envVar: `VCFNET_PW_${fqdn.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
      }));

      const specJq = [
        '# One data-source body per source, password from its own variable via $ENV.',
        '# Field names follow the Networks API data-source schema; verify for 9.1.',
        '{ fqdn: .fqdn, nickname: .nickname, proxy_id: $proxy, enabled: true,',
        '  notes: "Added by automation",',
        `  credentials: { username: $user, password: $ENV[.envVar] }${source.extra ? ` } + ${JSON.stringify(source.extra)}` : ' }'}`,
        '',
      ].join('\n');

      const script = [
        '#!/usr/bin/env bash',
        `# Add ${fqdns.length} ${source.label} data source(s) to VCF Operations for Networks.`,
        '#',
        '# Each password comes from its own variable, named in sources.json. With',
        '# --dry-run it only prints each body with the password left out.',
        'set -euo pipefail',
        ...netPreamble(),
        '',
        'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        '',
        'MISSING=()',
        '# Exported so jq can read each one through $ENV; never passed as an argument.',
        'for v in $(jq -r \'.[].envVar\' sources.json); do if [[ -n "${!v:-}" ]]; then export "$v"; else MISSING+=("$v"); fi; done',
        '(( ${#MISSING[@]} == 0 )) || { printf "Set from your vault: %s\\n" "${MISSING[@]}" >&2; exit 2; }',
        '',
        `PROXY='${collectorId}'`,
        'if [[ -z "$PROXY" ]]; then',
        '  # The node list carries ids only; each node is read to match its name.',
        `  for id in $(ni GET /infra/nodes | jq -r '.results[]? | .entity_id'); do`,
        `    PROXY=$(ni GET "/infra/nodes/$id" | jq -r --arg n '${collectorName}' --arg id "$id" 'select((.name // "") == $n) | .proxy_id // $id')`,
        '    [[ -n "$PROXY" ]] && break',
        '  done',
        `  [[ -n "$PROXY" ]] || { echo "No collector named ${collectorName}" >&2; exit 2; }`,
        'fi',
        'echo "collector ${PROXY}"',
        '',
        'jq -c \'.[]\' sources.json | while read -r src; do',
        `  BODY=$(echo "$src" | jq --arg proxy "$PROXY" --arg user '${user}' -f spec.jq)`,
        '  if (( DRY_RUN )); then',
        `    echo "DRY RUN: would POST ${source.path}:"; echo "$BODY" | jq 'del(.credentials.password)'`,
        '    continue',
        '  fi',
        `  echo "$BODY" | ni POST ${source.path} --data @- | jq -r '"added \\(.entity_id // "?") \\(.fqdn // .ip // "")"'`,
        'done',
        '',
        ...(source.flows && ipfix
          ? [
              '# IPFIX. The Networks API has no stable route for this across releases;',
              '# in the interface it is the "Enable NetFlow (IPFIX)" option on the data',
              `# source. Turn it on for each ${source.label} added above, then check flows`,
              '# appear under Flows within the hour.',
              'echo "Now enable IPFIX on each source (Settings > Accounts and Data Sources > edit)."',
            ]
          : []),
        '(( DRY_RUN )) && echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        'exit 0',
        '',
      ].join('\n');

      return {
        platform: NETWORKS,
        title: `Add ${fqdns.length} ${source.label} data source${fqdns.length === 1 ? '' : 's'}${source.flows ? (ipfix ? ', with IPFIX' : ', without flows') : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Run once when the sources are ready to be monitored.', worstCase: 'once per source' },
        scope: {
          what: `Exactly the listed ${source.label} sources: ${fqdns.join(', ') || 'none'}.`,
          decidedBy: ['sources.json, written from the list above.', `Collector ${collectorId || collectorName}.`],
          ifWrong: source.flows && ipfix
            ? 'IPFIX turned on for a distributed switch it was not meant for adds a flow export from every host on it. Nothing breaks, but the collector’s load rises with it.'
            : 'A source added twice is polled twice. Networks deduplicates the inventory, but the credential is used from two places.',
        },
        guardrails: [
          { rule: 'Each credential from its own variable, all present before anything is sent', because: 'A password in the payload is a password in the repository.' },
          { rule: 'Through a named collector', because: 'A source on the wrong collector is polled across a WAN link, or not at all.' },
        ],
        dryRun: ['Run with --dry-run. It prints every body it would send, with the password left out.'],
        undo: ['Delete the data source (DELETE /api/ni/data-sources/…/{id}, or in Settings). Collected history is kept until it ages out.', ...(source.flows && ipfix ? ['Turn IPFIX off on the source; the hosts stop exporting.'] : [])],
        told: ['Nobody. A failing data source shows on Settings > Accounts and Data Sources, and should be in the VCF Operations health checks.'],
        requires: [
          `A ${source.label} account with read access${source.flows ? ' and the privilege to change IPFIX settings' : ''}.`,
          ...sources.map((entry) => `${entry.envVar} set to ${entry.fqdn}’s password, from your vault.`),
          'The collector able to reach every source.',
        ],
        files: {
          [`${base}.sh`]: script,
          'sources.json': `${JSON.stringify(sources, null, 2)}\n`,
          'spec.jq': specJq,
          ...(source.flows
            ? {}
            : {
                // Settings > Accounts and Data Sources > Bulk add devices takes a
                // CSV with these columns. The password column is left empty: fill
                // it from your vault on the machine that uploads, then delete it.
                'import/bulk-add-devices.csv': `${[
                  'datasource_type,ip,fqdn,username,password,nickname,polling_interval_in_mins,collector_ip,notes',
                  ...sources.map((entry) => [BULK_TYPES[type] ?? type, '', entry.fqdn, user, '', entry.nickname, '10', '<REQUIRED — collector IP>', 'Added by automation'].map(csvCell).join(',')),
                ].join('\n')}\n`,
              }),
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Networks',
            intro: source.flows
              ? `${source.label} data sources are added one at a time — in the interface or through the API. ${base}.sh posts one body per source to ${source.path}: spec.jq turns each entry of sources.json into exactly that body, with the password from its own environment variable.`
              : `Physical devices can be added in bulk from a CSV (import/bulk-add-devices.csv) or one at a time through the API (${base}.sh, one POST ${source.path} per device).`,
            steps: [
              ...(source.flows
                ? []
                : [
                    {
                      heading: 'Either: bulk add from the CSV',
                      lines: [
                        'Fill the password column (and collector_ip) on the machine that uploads, from your vault, then: Settings > Accounts and Data Sources > Data Sources > the add drop-down > **Bulk add devices** > upload import/bulk-add-devices.csv. Delete the filled copy afterwards.',
                        '',
                        `VERIFY: datasource_type accepts the values in the sample .csv that dialog offers for download; "${BULK_TYPES[type] ?? type}" is written here — replace it if the sample spells it differently.`,
                      ],
                    },
                  ]),
              {
                heading: source.flows ? 'Add the sources' : 'Or: add them through the API',
                lines: [
                  `Export each password variable named in sources.json (${sources.map((entry) => entry.envVar).join(', ') || 'none'}), then \`./${base}.sh\` (add \`--dry-run\` first to print each body without the password).`,
                  '',
                  `By hand: Settings > Accounts and Data Sources > Add Source > ${source.label}, collector ${collectorName || collectorId}, the FQDN, username and password.`,
                ],
              },
              ...(source.flows && ipfix ? [{ heading: 'Turn on flows', lines: [`Edit each new ${source.label} source and tick Enable NetFlow (IPFIX); flows appear within the hour.`] }] : []),
            ],
            verify: [
              `The body (fqdn, nickname, proxy_id, enabled, notes, credentials {username, password}${source.extra ? ', switch_type' : ''}) is the one PowervRNI’s New-vRNIDataSource sends to ${source.path}.`,
              ...(source.flows ? [] : ['The CSV columns are the ones listed for Bulk add devices (datasource_type, ip, fqdn, username, password, nickname, polling_interval_in_mins, collector_ip mandatory; notes and the snmp_* columns optional).']),
            ],
            sources: [
              'PowervRNI (New-vRNIDataSource) for the data-source routes and bodies.',
              ...(source.flows ? [] : ['VMware Aria Operations for Networks documentation, "Bulk Add Devices as Data Sources" (Settings > Accounts and Data Sources > Bulk add devices; the CSV columns).']),
            ],
          }),
        },
        notes: [
          'The data-source routes (/api/ni/data-sources/vcenters, /nsxt-managers, /cisco-switches and so on) are long-standing. The switch_type values for physical switches vary by model and release; take them from the API reference.',
          'Collector lookup by name walks /api/ni/infra/nodes; if your release returns the name on the list directly, pass the id instead.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet_applications',
    platform: NETWORKS,
    label: 'Define an application and its tiers',
    group: 'Segmentation',
    description:
      'An application in Networks is a name and a set of tiers, each tier a search for the VMs in it. Once it exists, Networks can show what the tiers say to each other and to the outside, which is the input to a micro-segmentation rule set — and the tiers have to be disjoint, or the rules written from them will be too.',
    inputs: [
      { id: 'app_name', label: 'Application', control: 'text', default: 'Orders' },
      {
        id: 'tiers',
        label: 'Tiers',
        control: 'textarea',
        default: "web = name like 'orders-web'\napp = name like 'orders-app'\ndb = name like 'orders-db'",
        hint: "One per line: tier = filter. e.g. name like 'x', or security_tags = 'tier:web'",
      },
    ],
    automation: (values                 , name        )             => {
      const app = str(values, 'app_name', 'Application');
      const base = slugOf(name || app, 'application');
      const tiers = str(values, 'tiers', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf('=');
          return at < 0 ? { name: line, filter: '' } : { name: line.slice(0, at).trim(), filter: line.slice(at + 1).trim() };
        });

      const findings            = [];
      if (tiers.length === 0) findings.push(error('vcfnet.app.no-tiers', 'An application with no tiers groups nothing.', { source: SRC }));
      const empty = tiers.filter((tier) => !tier.filter);
      if (empty.length > 0) findings.push(error('vcfnet.app.empty-tier', `No filter for tier ${empty.map((tier) => tier.name).join(', ')}.`, { source: SRC }));
      const overlaps           = [];
      for (let i = 0; i < tiers.length; i += 1) {
        for (let j = i + 1; j < tiers.length; j += 1) {
          const a = tiers[i] ;
          const b = tiers[j] ;
          const va = quotedValues(a.filter);
          const vb = quotedValues(b.filter);
          const clash = a.filter === b.filter || va.some((x) => vb.some((y) => (/\blike\b/i.test(a.filter) && y.includes(x)) || (/\blike\b/i.test(b.filter) && x.includes(y)) || x === y));
          if (clash) overlaps.push(`${a.name} and ${b.name}`);
        }
      }
      if (overlaps.length > 0) {
        findings.push(
          warning('vcfnet.app.overlap', `Tier criteria overlap: ${overlaps.join('; ')}. A VM matching both is in both tiers.`, {
            remediation: '"name like" is a substring match, so like \'web\' also matches \'web-db\'. Make every tier’s criterion exclusive — a tag per tier is the cleanest way.',
            source: SRC,
          }),
        );
      }

      // The discovery CSV: one row per tier whose filter is a VM-name match.
      const csvRows = tiers.flatMap((tier) => {
        const like = /^name\s+like\s+'([^']+)'$/i.exec(tier.filter);
        const equal = /^name\s*=\s*'([^']+)'$/i.exec(tier.filter);
        const escape = (text        )         => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = like ? `.*${escape(like[1] )}.*` : equal ? escape(equal[1] ) : '';
        return pattern ? [[app, tier.name, pattern].map(csvCell).join(',')] : [];
      });

      const tierBodies = tiers.map((tier) => ({
        name: tier.name,
        group_membership_criteria: [{ membership_type: 'SearchMembershipCriteria', search_membership_criteria: { entity_type: 'BaseVirtualMachine', filter: tier.filter } }],
      }));

      const script = [
        '#!/usr/bin/env bash',
        `# Create the application "${app}" and its ${tiers.length} tier(s) in VCF Operations for Networks.`,
        '#',
        '# It shows how many VMs each tier matches today, then creates them. With',
        '# --dry-run it stops after the count — the check that the criteria are right.',
        'set -euo pipefail',
        ...netPreamble(),
        '',
        'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        '',
        'jq -c \'.[]\' import/tiers.json | while read -r tier; do',
        '  NAME=$(echo "$tier" | jq -r .name)',
        '  FILTER=$(echo "$tier" | jq -r \'.group_membership_criteria[0].search_membership_criteria.filter\')',
        '  COUNT=$(ni POST /search --data "$(jq -n --arg f "$FILTER" \'{entity_type: "VirtualMachine", filter: $f, size: 1}\')" | jq -r \'.total_count // 0\')',
        '  echo "tier ${NAME}: ${COUNT} VM(s) match ${FILTER}"',
        'done',
        '',
        '(( DRY_RUN )) && { echo "Dry run: nothing was created. Run it without --dry-run to apply."; exit 0; }',
        '',
        'APP_ID=$(ni POST /groups/applications --data @import/application.json | jq -r .entity_id)',
        'echo "application ${APP_ID}"',
        'jq -c \'.[]\' import/tiers.json | while read -r tier; do',
        '  ni POST "/groups/applications/${APP_ID}/tiers" --data "$tier" | jq -r \'"tier \\(.name // "?") \\(.entity_id // "")"\'',
        'done',
        'echo "${APP_ID}" > created-application-id.txt',
        '',
      ].join('\n');

      return {
        platform: NETWORKS,
        title: `Application "${app}" with ${tiers.length} tier${tiers.length === 1 ? '' : 's'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Created once. Membership is re-evaluated as VMs come and go.', worstCase: 'membership changes whenever a VM matching a tier filter appears' },
        scope: {
          what: 'A definition only: it groups VMs for analysis and changes nothing on the network.',
          decidedBy: tiers.map((tier) => `Tier ${tier.name}: ${tier.filter || '(no filter)'}.`),
          ifWrong: 'The flow analysis shows the wrong VMs in a tier, and any firewall rules recommended from it are wrong in the same way. That is where the harm is — in the rules written later from this.',
        },
        guardrails: [
          { rule: 'Counts each tier’s members before creating anything', because: 'A tier that matches three hundred VMs instead of three is visible as a number before it is visible as a bad rule.' },
          { rule: 'Creates a definition, never a rule', because: 'Recommended rules are reviewed and applied in NSX by a person.' },
        ],
        dryRun: ['Run with --dry-run. It prints how many VMs each tier matches today and creates nothing.'],
        undo: ['DELETE /api/ni/groups/applications/{id} with the id in created-application-id.txt, or delete it under Applications.'],
        told: ['Nobody. It is a definition.'],
        requires: ['VM names or tags consistent enough for a filter to find them.', 'Flow collection (IPFIX) for the flow analysis to have anything in it.'],
        files: {
          [`${base}.sh`]: script,
          'import/application.json': `${JSON.stringify({ name: app }, null, 2)}\n`,
          'import/tiers.json': `${JSON.stringify(tierBodies, null, 2)}\n`,
          ...(csvRows.length > 0 ? { 'import/application-discovery.csv': `${['Application Name,Tier Name,VM Name', ...csvRows].join('\n')}\n` } : {}),
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Networks',
            intro: `An application is created through the API (POST /api/ni/groups/applications with import/application.json, then one POST .../tiers per element of import/tiers.json — each element is exactly that body), or by hand. Networks also takes a CSV, but only as input to flow-based application discovery, not as a definition.`,
            steps: [
              {
                heading: 'Create the application and tiers',
                lines: [
                  `\`./${base}.sh --dry-run\` counts each tier’s VMs and creates nothing; \`./${base}.sh\` counts them and creates "${app}" and its ${tiers.length} tier(s) and writes the id to created-application-id.txt.`,
                  '',
                  `By hand: Applications > Add Application, name "${app}", one tier per element of import/tiers.json with its filter as a VM search.`,
                ],
              },
              csvRows.length > 0
                ? {
                    heading: 'Optional: seed flow-based discovery with the CSV',
                    lines: [
                      'Applications > Discover > Flow based > Discovery Options > upload import/application-discovery.csv. Discovery uses it to name applications and tiers and checks it against observed flows; it does not create the definition above. The VM Name column takes regular expressions.',
                      '',
                      `VERIFY: the header names. The documentation names the VM Name column and says the file maps VMs to application and tier names; "Application Name" and "Tier Name" are written here — the upload reports any column it cannot find.${csvRows.length < tiers.length ? ' Tiers whose filter is not a VM-name match are left out of the CSV.' : ''}`,
                    ],
                  }
                : undefined,
            ],
            verify: ['The application and tier bodies are the ones PowervRNI (New-vRNIApplication, New-vRNIApplicationTier) sends.'],
            sources: [
              'PowervRNI: POST /api/ni/groups/applications {name}; POST /api/ni/groups/applications/{id}/tiers {name, group_membership_criteria [{membership_type SearchMembershipCriteria, search_membership_criteria {entity_type, filter}}]}.',
              'Broadcom TechDocs, Aria Operations for Networks 6.14, "Discover Applications using Flows" (Discovery Options, CSV upload, VM Name as a regular expression).',
            ],
          }),
        },
        notes: [
          'The applications and tiers routes and the SearchMembershipCriteria shape follow the Networks API reference. The filter syntax is the search bar’s: try each filter there first.',
          'Networks can discover applications from flows and tags on its own. Use that to find candidates, then write the definition here so it is reviewed and versioned.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
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
            sources: ['PowervRNI (Invoke-vRNISearch) for POST /api/ni/search.'],
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
  }),
];
