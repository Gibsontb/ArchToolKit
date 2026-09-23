/**
 * VCF Operations 9.1: cost and capacity.
 *
 * VCF Operations 9.1 carries a finished cost engine and a capacity engine, and
 * most estates run both on their defaults: MSRP server prices nobody checked,
 * no facilities cost, a CPU:memory split the engine chose, and a capacity
 * policy nobody knows the buffer of. The numbers still look authoritative,
 * which is the problem — a showback bill or a "time remaining" figure is read
 * by people who cannot tell the default from a decision.
 *
 * These blueprints write the decisions down, enter them where there is an API
 * for it (pricing policies, report schedules, the stats that prove the cost
 * engine ran), and say plainly where there is not (cost drivers, what-if,
 * Automation Central jobs, bills) so the interface steps are exact instead.
 *
 * 9.1 names: cost drivers now cover clusters, hosts and datacenters as well as
 * VMs; the server hardware driver has a spreadsheet-style editor; CPU:memory
 * cost ratios are customisable; the Reclaim page deletes orphaned disks and
 * shows one VM under several recommendations at once; tag, age and appliance
 * exclusions apply to Reclaim and Rightsize recommendations (tag exclusions to
 * Automation Central too, per Broadcom's 9.1 guidance — verify); bills
 * go out as PDF by email; VKS is costed down to nodes, clusters and vSphere
 * Namespaces.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { authHeader, authPreamble, readScript, scheduledEnv } from '../apply.js';

const PLATFORM = 'vcf-operations'         ;
const SRC = 'ArchToolKit';
const HDR = authHeader(PLATFORM);

const WEEKDAYS                                   = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function cronOf(when        )         {
  const match = /^\s*([a-z]+)\s+(\d{1,2}):(\d{2})\s*$/i.exec(when);
  const day = match ? WEEKDAYS[match[1] .toLowerCase()] : undefined;
  if (!match || day === undefined) return '<REQUIRED: minute hour * * weekday>';
  return `${Number(match[3])} ${Number(match[2])} * * ${day}`;
}

/** A day earlier, for a check that has to run before the job it checks. */
function dayBefore(when        )         {
  const match = /^\s*([a-z]+)\s+(\d{1,2}):(\d{2})\s*$/i.exec(when);
  const day = match ? WEEKDAYS[match[1] .toLowerCase()] : undefined;
  if (!match || day === undefined) return '<REQUIRED: minute hour * * weekday>';
  return `${Number(match[3])} ${Number(match[2])} * * ${(day + 6) % 7}`;
}

const money = (value        )         => (Math.round(value * 100) / 100).toFixed(2);

/**
 * The lines that find every cost metric a resource reports, without trusting a
 * key name from documentation: cost keys have moved between releases, so the
 * script asks one resource which of its stat keys are cost keys and reads those.
 */
function costKeyDiscovery(resourceVar        , pattern        )           {
  return [
    `keys=$(get "/suite-api/api/resources/\${${resourceVar}}/statkeys" | jq -c --arg re '${pattern}' '[.["stat-key"][]?.key | select(test($re; "i"))] | unique')`,
    'if [[ "$(jq length <<<"$keys")" == 0 ]]; then',
    '  echo "No cost metrics on this object. Either the cost engine has not run (it starts once a currency is set, then runs daily) or this release names them differently." >&2',
    '  exit 1',
    'fi',
    'printf \'%s\\n\' "$keys" >"$WORK/keys.json"',
  ];
}

/** POST for a read-only query endpoint, inside a readScript body. */
const POST_QUERY = [
  'post() {',
  `  curl -sS -f -X POST "https://\${VCFOPS_HOST}$1" -H "${HDR}" -H "Accept: application/json" -H "Content-Type: application/json" --data @-`,
  '}',
  '',
];

/** latest-stats response → {resourceId: {statKey: value}} */
const LATEST_TO_MAP = `[.values[]? | {(.resourceId): ([."stat-list".stat[]? | {(.statKey.key): ((.data // []) | last)}] | add // {})}] | add // {}`;

/** The variable holding the private auth header file authPreamble writes, so a script's own EXIT trap can remove it too. */
const AUTH_FILE_VAR = /^@\$\{(\w+)\}$/.exec(HDR)?.[1];

/**
 * Lists and stat queries sized by the estate go through files, never through
 * `jq --arg/--argjson`: an argument list tops out around 2 MB, which a group of
 * a few thousand VMs passes, and the script then dies with "Argument list too
 * long" (exit 126) instead of the check it was written to make. Lists are paged
 * and stat queries sent 500 resources at a time.
 */
const LARGE_DATA = [
  'WORK=$(umask 077; mktemp -d)',
  `trap 'rm -rf "$WORK"${AUTH_FILE_VAR ? `; rm -f "$${AUTH_FILE_VAR}"` : ''}' EXIT`,
  '',
  '# Every page of a suite-api resource list, as a JSON array in a file: get_all PATH OUT',
  'get_all() {',
  '  local path="$1" out="$2" page=0 total n sep="?"',
  '  [[ "$path" == *"?"* ]] && sep="&"',
  '  : >"$out.lines"',
  '  while :; do',
  '    get "${path}${sep}page=${page}&pageSize=1000" >"$out.page"',
  '    jq -c \'.resourceList[]?\' "$out.page" >>"$out.lines"',
  '    total=$(jq \'.pageInfo.totalCount // 0\' "$out.page")',
  '    n=$(jq \'.resourceList // [] | length\' "$out.page")',
  '    page=$((page + 1))',
  '    (( n > 0 && $(wc -l <"$out.lines") < total )) || break',
  '  done',
  '  jq -s -c . "$out.lines" >"$out"',
  '  rm -f "$out.page" "$out.lines"',
  '}',
  '',
  '# Latest value of each stat key for each resource: latest_map IDS.json KEYS.json OUT.json → {id: {key: value}}',
  'latest_map() {',
  '  local ids="$1" keys="$2" out="$3" n i',
  '  n=$(jq length "$ids")',
  '  echo \'{}\' >"$out"',
  '  for (( i = 0; i < n; i += 500 )); do',
  '    jq -n -c --slurpfile r "$ids" --slurpfile k "$keys" --argjson i "$i" \'{resourceId: $r[0][$i:$i + 500], statKey: $k[0], maxSamples: 1}\' |',
  `      post /suite-api/api/resources/stats/latest/query | jq -c '${LATEST_TO_MAP}' >"$out.part"`,
  '    jq -s -c \'.[0] + .[1]\' "$out" "$out.part" >"$out.new" && mv "$out.new" "$out"',
  '  done',
  '  rm -f "$out.part"',
  '}',
  '',
];

export const VCF_OPS_COST                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_cost_drivers',
    platform: PLATFORM,
    label: 'Cost drivers and the CPU:memory cost ratio, per datacenter',
    group: 'Cost',
    description:
      'The numbers every VM cost is derived from: server hardware (bought and depreciated, or leased), licences, maintenance, labour, network, facilities and storage, per datacenter — plus the 9.1 customisable ratio that splits a host’s cost between CPU and memory. Written as a reviewed design table and the exact values to type into the 9.1 cost driver editor, with a check that snapshots the cost engine’s output before the change and fails if a cluster’s cost swings further than you said it should.',
    inputs: [
      { id: 'datacenters', label: 'Datacenters', control: 'text', default: 'DC-North, DC-South', hint: 'As VCF Operations names them. The same values are written for each; edit the CSV where they differ' },
      { id: 'currency', label: 'Currency', control: 'select', options: [{ value: 'USD', label: 'US dollar' }, { value: 'EUR', label: 'Euro' }, { value: 'GBP', label: 'Pound sterling' }, { value: 'AUD', label: 'Australian dollar' }, { value: 'JPY', label: 'Japanese yen' }], default: 'USD', hint: 'Set once, before the first calculation. Changing it later is not a conversion' },
      { id: 'hosts', label: 'Hosts per datacenter', control: 'number', default: 8, min: 1, max: 2000 },
      { id: 'ownership', label: 'Server hardware is', control: 'select', options: [{ value: 'purchase', label: 'Bought, and depreciated' }, { value: 'lease', label: 'Leased' }], default: 'purchase' },
      { id: 'server_cost', label: 'Price paid per server', control: 'number', default: 28000, min: 0, max: 2000000, showWhen: { input: 'ownership', equals: ['purchase'] }, hint: 'What you paid, not list price. The engine’s default is an MSRP estimate' },
      { id: 'depreciation_years', label: 'Depreciate over (years)', control: 'number', default: 5, min: 1, max: 10, showWhen: { input: 'ownership', equals: ['purchase'] } },
      { id: 'depreciation_method', label: 'Depreciation method', control: 'select', options: [{ value: 'straight', label: 'Straight line' }, { value: 'double', label: 'Max of double declining or straight line' }], default: 'straight', showWhen: { input: 'ownership', equals: ['purchase'] } },
      { id: 'lease_monthly', label: 'Lease per server per month', control: 'number', default: 700, min: 0, max: 100000, showWhen: { input: 'ownership', equals: ['lease'] } },
      { id: 'cores_per_host', label: 'Licensed cores per host', control: 'number', default: 64, min: 1, max: 1024 },
      { id: 'licence_core_year', label: 'Licence per core per year', control: 'number', default: 350, min: 0, max: 100000, hint: 'Your contracted price for the VCF subscription plus any guest OS licensing you want costed per host' },
      { id: 'maintenance_pct', label: 'Hardware maintenance (% of price per year)', control: 'number', default: 10, min: 0, max: 50, showWhen: { input: 'ownership', equals: ['purchase'] } },
      { id: 'labour_host_month', label: 'Labour per host per month', control: 'number', default: 180, min: 0, max: 100000, hint: 'Loaded salary cost of the people who run it, divided by hosts' },
      { id: 'network_host_month', label: 'Network per host per month', control: 'number', default: 120, min: 0, max: 100000 },
      { id: 'facilities_host_month', label: 'Facilities per host per month', control: 'number', default: 220, min: 0, max: 100000, hint: 'Space, power and cooling. Zero here makes every VM look cheaper than a cloud' },
      { id: 'storage_model', label: 'Storage', control: 'select', options: [{ value: 'hci', label: 'vSAN — inside the server price' }, { value: 'external', label: 'External arrays — priced per GB' }], default: 'hci' },
      { id: 'hci_compute_pct', label: 'Share of server price that is compute (%)', control: 'number', default: 70, min: 10, max: 95, showWhen: { input: 'storage_model', equals: ['hci'] }, hint: 'The rest is attributed to vSAN storage' },
      { id: 'storage_gb_month', label: 'Storage per GB per month', control: 'number', default: 0.08, min: 0, max: 100, showWhen: { input: 'storage_model', equals: ['external'] } },
      { id: 'cpu_share_pct', label: 'CPU share of compute cost (%)', control: 'number', default: 60, min: 5, max: 95, hint: 'The 9.1 custom cost ratio. Memory gets the rest' },
      { id: 'max_swing_pct', label: 'Fail the check if a cluster’s cost moves more than (%)', control: 'number', default: 30, min: 1, max: 500 },
    ],
    automation: (values                 , name        )             => {
      const dcs = listOf(str(values, 'datacenters', ''));
      const currency = str(values, 'currency', 'USD');
      const hosts = num(values, 'hosts', 8);
      const ownership = str(values, 'ownership', 'purchase');
      const bought = ownership === 'purchase';
      const serverCost = num(values, 'server_cost', 28000);
      const years = num(values, 'depreciation_years', 5);
      const method = str(values, 'depreciation_method', 'straight');
      const lease = num(values, 'lease_monthly', 700);
      const cores = num(values, 'cores_per_host', 64);
      const licence = num(values, 'licence_core_year', 350);
      const maintPct = num(values, 'maintenance_pct', 10);
      const labour = num(values, 'labour_host_month', 180);
      const network = num(values, 'network_host_month', 120);
      const facilities = num(values, 'facilities_host_month', 220);
      const storageModel = str(values, 'storage_model', 'hci');
      const hciCompute = num(values, 'hci_compute_pct', 70);
      const storageGb = num(values, 'storage_gb_month', 0.08);
      const cpuShare = num(values, 'cpu_share_pct', 60);
      const swing = num(values, 'max_swing_pct', 30);
      const base = slugOf(name || 'cost-drivers', 'cost-drivers');

      const hardwareMonth = bought ? serverCost / (Math.max(years, 1) * 12) : lease;
      const maintMonth = bought ? (serverCost * maintPct) / 100 / 12 : 0;
      const licenceMonth = (cores * licence) / 12;
      const hostMonth = hardwareMonth + maintMonth + licenceMonth + labour + network + facilities;
      const computeMonth = storageModel === 'hci' ? hostMonth - (hardwareMonth * (100 - hciCompute)) / 100 : hostMonth;

      const findings            = [];
      if (dcs.length === 0) findings.push(error('vcfops.cost.no-datacenter', 'No datacenter is named, so there is nothing to enter these values against.', { source: SRC }));
      if (bought && (years < 2 || years > 5)) {
        findings.push(
          error('vcfops.cost.depreciation-range', `${years} years is outside the depreciation period VCF Operations accepts for server hardware (documented as 2 to 5 years).`, {
            remediation: 'Use the period finance actually depreciates servers over, within 2–5. If finance uses longer, enter 5 and note the difference in the design.',
            source: SRC,
          }),
        );
      } else if (bought && years < 3) {
        findings.push(
          warning('vcfops.cost.depreciation-short', `Depreciating servers over ${years} years is unrealistic for hardware that stays in the rack five or more.`, {
            remediation: 'A short period front-loads the cost: every VM looks expensive now and free in year three, and showback swings when the hardware is fully written down.',
            source: SRC,
          }),
        );
      }
      if (facilities === 0) {
        findings.push(
          warning('vcfops.cost.no-facilities', 'There is no facilities cost — no space, power or cooling.', {
            remediation: 'Facilities are typically a tenth to a fifth of the cost of running a host. Without them every VM is undercosted and every cloud comparison is unfair to the cloud.',
            source: SRC,
          }),
        );
      }
      if (bought && serverCost === 0) findings.push(warning('vcfops.cost.free-hardware', 'The server price is zero, so hardware contributes nothing to any VM’s cost.', { source: SRC }));
      if (cpuShare < 20 || cpuShare > 80) {
        findings.push(
          warning('vcfops.cost.ratio-extreme', `A ${cpuShare}:${100 - cpuShare} CPU:memory split puts almost all of a host’s cost on one resource.`, {
            remediation: 'Base the ratio on what the hardware cost: the share of the server price that is processors versus DIMMs is usually between 40:60 and 60:40.',
            source: SRC,
          }),
        );
      }
      if (licence === 0) findings.push(info('vcfops.cost.no-licence', 'Licence cost is zero. Deliberate if licences are costed centrally; otherwise VMs are undercosted by the largest single line.', { source: SRC }));

      const drivers                                     = [
        ['Server hardware', bought ? `${currency} ${money(serverCost)} per server, purchase, ${method === 'straight' ? 'straight line' : 'max of double declining or straight line'} over ${years} years` : `${currency} ${money(lease)} per server per month, lease`, `${money(hardwareMonth)}`, bought ? 'The price paid replaces the MSRP estimate the engine starts with. Set the purchase date per host in the 9.1 spreadsheet view.' : 'A lease is a monthly cost with no depreciation.'],
        ['Licence', `${currency} ${money(licence)} per core per year × ${cores} cores`, `${money(licenceMonth)}`, 'Per host. Guest OS licences can be added as their own line.'],
        ['Maintenance', bought ? `${maintPct}% of hardware price per year` : 'Included in the lease', `${money(maintMonth)}`, 'Support contracts on the hardware.'],
        ['Labour', `${currency} ${money(labour)} per host per month`, `${money(labour)}`, 'Operations staff, loaded, divided across hosts.'],
        ['Network', `${currency} ${money(network)} per host per month`, `${money(network)}`, 'Switch ports, uplinks and their support.'],
        ['Facilities', `${currency} ${money(facilities)} per host per month`, `${money(facilities)}`, facilities === 0 ? 'MISSING — see the findings.' : 'Space, power and cooling.'],
        ['Storage', storageModel === 'hci' ? `vSAN: ${100 - hciCompute}% of the server price is storage` : `${currency} ${storageGb} per GB per month`, storageModel === 'hci' ? `${money((hardwareMonth * (100 - hciCompute)) / 100)}` : 'per GB', storageModel === 'hci' ? 'On hyperconverged servers the engine splits the server price into compute and storage by this percentage.' : 'Entered per datastore type or per datastore.'],
      ];

      const design = [
        `# Cost drivers — ${dcs.join(', ') || '(no datacenter)'}`,
        '',
        'Generated by ArchToolKit for VCF Operations 9.1. Reviewed values, and why each one.',
        `Currency: **${currency}**. Hosts per datacenter: **${hosts}**.`,
        '',
        `| Driver | Value | ${currency} per host per month | Why |`,
        '|---|---|---|---|',
        ...drivers.map(([driver, value, month, why]) => `| ${driver} | ${value} | ${month} | ${why} |`),
        `| **Total** | | **${money(hostMonth)}** | Before the storage split: ${money(computeMonth)} of it is compute. |`,
        '',
        `Per datacenter, per month: **${currency} ${money(hostMonth * hosts)}**. Per year: ${currency} ${money(hostMonth * hosts * 12)}.`,
        '',
        '## CPU:memory cost ratio (9.1)',
        '',
        `CPU **${cpuShare}%**, memory **${100 - cpuShare}%** of compute cost. Of ${currency} ${money(computeMonth)} per host per month,`,
        `${currency} ${money((computeMonth * cpuShare) / 100)} is charged to CPU and ${currency} ${money((computeMonth * (100 - cpuShare)) / 100)} to memory.`,
        'Base it on the bill of materials: what the processors cost against what the memory cost.',
        '',
        '## Entering it',
        '',
        '1. Run `cost-check.sh --baseline` first. It saves every cluster’s cost metrics as they are today.',
        '2. Currency: set once under the global cost settings (Administration → Global Settings → Cost/Price in recent releases). Nothing is costed until it is set, and changing it later does not convert anything.',
        `3. Cost drivers (Manage → Cost → Cost Drivers in 9.1; Infrastructure Operations → Configurations → Cost Drivers before): for each datacenter, enter the values from \`${base}-values.csv\`. Use the 9.1 spreadsheet view for server hardware — it takes purchase date, price and ownership per host.`,
        '4. The CPU:memory ratio is set with the cost drivers in 9.1. Enter the split above.',
        '5. Run the cost calculation once by hand (Administration → Control Panel → Cost Calculation) rather than waiting for the daily run, and wait for it to finish.',
        `6. Run \`cost-check.sh --compare\`. It fails if any cluster’s cost moved more than ${swing}% — read why before anyone sees a bill.`,
        '',
        'There is no documented suite-API call for cost drivers, so this is entered in the interface. VERIFY against your',
        'release before scripting anything that claims otherwise.',
        '',
      ].join('\n');

      const csv = [
        'datacenter,driver,field,value,unit',
        ...dcs.flatMap((dc) => [
          ...(bought
            ? [`${dc},Server hardware,ownership,purchase,`, `${dc},Server hardware,price per server,${serverCost},${currency}`, `${dc},Server hardware,depreciation years,${years},years`, `${dc},Server hardware,depreciation method,${method === 'straight' ? 'Straight line' : 'Max of double declining or straight line'},`]
            : [`${dc},Server hardware,ownership,lease,`, `${dc},Server hardware,lease per month,${lease},${currency}`]),
          `${dc},Licence,per core per year,${licence},${currency}`,
          `${dc},Licence,cores per host,${cores},cores`,
          ...(bought ? [`${dc},Maintenance,percent of hardware per year,${maintPct},%`] : []),
          `${dc},Labour,per host per month,${labour},${currency}`,
          `${dc},Network,per host per month,${network},${currency}`,
          `${dc},Facilities,per host per month,${facilities},${currency}`,
          storageModel === 'hci' ? `${dc},Storage,compute share of server price,${hciCompute},%` : `${dc},Storage,per GB per month,${storageGb},${currency}`,
          `${dc},Cost ratio,CPU share,${cpuShare},%`,
          `${dc},Cost ratio,memory share,${100 - cpuShare},%`,
        ]),
        '',
      ].join('\n');

      const check = readScript('vcf-operations', 'Snapshot, and compare, the cost the engine calculates for every cluster.', [
        ...POST_QUERY,
        ...LARGE_DATA,
        `MAX_SWING_PCT=${swing}`,
        'MODE="${1:---compare}"',
        'BASELINE="${BASELINE:-cost-baseline.json}"',
        '',
        'get_all "/suite-api/api/resources?adapterKind=VMWARE&resourceKind=ClusterComputeResource" "$WORK/all.json"',
        "jq -c '[.[] | {id: .identifier, name: .resourceKey.name}]' \"$WORK/all.json\" >\"$WORK/clusters.json\"",
        'if [[ "$(jq length "$WORK/clusters.json")" == 0 ]]; then echo "No clusters found." >&2; exit 1; fi',
        'first=$(jq -r ".[0].id" "$WORK/clusters.json")',
        ...costKeyDiscovery('first', '^cost\\|'),
        '# The metric compared is the first cost key with "total" in it. VERIFY it is the',
        '# monthly total in your release, or set COST_KEY to the one you want.',
        'COST_KEY="${COST_KEY:-$(jq -r \'[.[] | select(test("total"; "i"))][0] // .[0]\' <<<"$keys")}"',
        'echo "Comparing on ${COST_KEY}"',
        '',
        'jq -c \'[.[].id]\' "$WORK/clusters.json" >"$WORK/ids.json"',
        'latest_map "$WORK/ids.json" "$WORK/keys.json" "$WORK/latest.json"',
        'now="$WORK/now.json"',
        'jq -c --slurpfile v "$WORK/latest.json" \'($v[0]) as $v | [.[] | {name, id, stats: ($v[.id] // {})}]\' "$WORK/clusters.json" >"$now"',
        '',
        'case "$MODE" in',
        '  --baseline)',
        '    cp "$now" "$BASELINE"',
        '    echo "Saved $(jq length "$now") clusters to ${BASELINE}. Make the cost driver change, run the cost calculation, then --compare."',
        '    exit 0 ;;',
        '  --compare)',
        '    [[ -f "$BASELINE" ]] || { echo "No ${BASELINE}. Run with --baseline before changing anything." >&2; exit 2; }',
        '    report=$(jq -c --slurpfile b "$BASELINE" --arg k "$COST_KEY" --argjson max "$MAX_SWING_PCT" \'',
        '      ($b[0] | map({(.id): .stats[$k]}) | add // {}) as $old',
        '      | [.[] | {name, before: $old[.id], after: .stats[$k]}',
        '         | .pct = (if (.before // 0) == 0 then null else (((.after // 0) - .before) / .before * 100 | . * 10 | round / 10) end)',
        '         | .over = (.pct != null and ((.pct | fabs) > $max))]\' "$now")',
        '    jq -r \'.[] | "\\(.name)\\t\\(.before)\\t->\\t\\(.after)\\t\\(.pct // "n/a")%\\(if .over then "\\tOVER" else "" end)"\' <<<"$report"',
        '    over=$(jq \'[.[] | select(.over)] | length\' <<<"$report")',
        '    if (( over > 0 )); then',
        '      echo "${over} cluster(s) moved more than ${MAX_SWING_PCT}%. Find out why before a bill goes out." >&2',
        '      exit 1',
        '    fi',
        '    echo "Every cluster within ${MAX_SWING_PCT}%." ;;',
        '  *) echo "usage: $0 --baseline | --compare" >&2; exit 2 ;;',
        'esac',
      ]);

      return {
        platform: PLATFORM,
        title: `Cost drivers for ${dcs.join(', ') || 'no datacenter'} — ${currency} ${money(hostMonth)} per host per month, CPU:memory ${cpuShare}:${100 - cpuShare}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Entered once as a change, then reviewed each budget year or hardware refresh.' },
        scope: {
          what: `Every cost VCF Operations calculates in ${dcs.join(', ') || '(none)'}: host, cluster, VM, and everything showback and bills are built from.`,
          decidedBy: ['The datacenter each driver is entered against.', 'The per-host values in the 9.1 server hardware editor, which override the datacenter default for that host.', 'The daily cost calculation, which applies them from its next run.'],
          ifWrong: 'Every VM cost, every showback line and every bill is wrong by the same factor, and looks authoritative. Nothing fails; people pay or budget from it.',
        },
        guardrails: [
          { rule: 'Baseline before, compare after — cost-check.sh', because: `It fails when a cluster’s cost moves more than ${swing}%, which is how a zero in the wrong field is caught before a tenant sees it on a bill.` },
          { rule: 'Every value has a reason in the design table', because: 'A cost driver nobody can explain is the engine’s default, and the default is an MSRP guess.' },
        ],
        dryRun: [
          'Enter nothing yet. Run `cost-check.sh --baseline` and read the per-cluster costs it saves — that is what the engine thinks today.',
          'Compare the per-host total in the design with what finance says a host costs. If they differ by more than the swing you set, one of them is wrong.',
        ],
        undo: ['Re-enter the previous values (the baseline file shows the costs they produced) and run the cost calculation again. Past daily cost metrics already written are not recalculated.'],
        told: ['Nobody automatically. Cost changes flow into showback and bills silently — record the change, and tell the people who read bills before the next one goes out.'],
        requires: ['A currency set in VCF Operations — the cost engine does not run without one.', 'jq on the machine that runs cost-check.sh.', 'The real price paid, purchase dates and lease terms from finance, not the engine’s estimates.'],
        files: {
          [`${base}-design.md`]: design,
          [`${base}-values.csv`]: csv,
          'cost-check.sh': check,
        },
        notes: [
          'VCF 9.1 applies additional cost drivers to clusters, hosts and datacenters, not only VMs — an “additional cost” entered at datacenter level is spread across what is in it.',
          'The engine only recalculates forward. A change made on the 20th leaves the first nineteen days of the month at the old rates, so make it on the first.',
          'The cost key cost-check.sh compares on is discovered from the first cluster’s stat keys. Set COST_KEY if it picks the wrong one.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_showback',
    platform: PLATFORM,
    label: 'Showback and chargeback: a rate card, assigned, billed and emailed',
    group: 'Cost',
    description:
      'A pricing policy with rates per vCPU, per GB of memory, per GB of storage and a fixed charge per VM, created through the pricing API by cloning one policy made once in the interface — so the item names are the platform’s, not a guess. Then the 9.1 pieces around it: assignment to organizations, projects or a cost-centre tag, application showback, tenant reports and alerts, and a recurring bill sent as PDF by email.',
    inputs: [
      { id: 'policy_name', label: 'Pricing policy name', control: 'text', default: 'Standard rate card 2027' },
      { id: 'basis', label: 'Charge on', control: 'select', options: [{ value: 'allocation', label: 'Allocation — what was asked for' }, { value: 'usage', label: 'Usage — what was used' }], default: 'allocation', hint: 'Set on the template policy; the clone keeps it' },
      { id: 'rate_vcpu', label: 'Per vCPU per month', control: 'number', default: 18, min: 0, max: 10000 },
      { id: 'rate_ram', label: 'Per GB memory per month', control: 'number', default: 4, min: 0, max: 10000 },
      { id: 'rate_storage', label: 'Per GB storage per month', control: 'number', default: 0.1, min: 0, max: 1000 },
      { id: 'fixed_vm', label: 'Fixed per VM per month', control: 'number', default: 5, min: 0, max: 100000 },
      { id: 'assign_to', label: 'Assign to', control: 'select', options: [{ value: 'organization', label: 'VCF Automation organizations' }, { value: 'project', label: 'VCF Automation projects' }, { value: 'tag', label: 'VMs by a cost-centre tag' }], default: 'organization' },
      { id: 'assign_names', label: 'Organizations or projects', control: 'text', default: 'Finance, Retail', showWhen: { input: 'assign_to', equals: ['organization', 'project'] } },
      { id: 'tag_category', label: 'Tag category that carries the cost centre', control: 'text', default: 'CostCenter', showWhen: { input: 'assign_to', equals: ['tag'] }, hint: 'Same category as the tag standard; one value per cost centre' },
      { id: 'bill_cadence', label: 'Bills', control: 'select', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'none', label: 'No bills — showback only' }], default: 'monthly' },
      { id: 'bill_recipients', label: 'Email bills to', control: 'text', default: 'showback@example.com', showWhen: { input: 'bill_cadence', notEquals: ['none'] } },
      { id: 'tenant_alert_pct', label: 'Alert a tenant at (% of quota)', control: 'number', default: 80, min: 0, max: 100, hint: '0 turns tenant alerts off' },
      { id: 'app_showback', label: 'Show cost per application and tier', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const policyName = str(values, 'policy_name', 'Rate card');
      const basis = str(values, 'basis', 'allocation');
      const rVcpu = num(values, 'rate_vcpu', 18);
      const rRam = num(values, 'rate_ram', 4);
      const rStorage = num(values, 'rate_storage', 0.1);
      const fixed = num(values, 'fixed_vm', 5);
      const assignTo = str(values, 'assign_to', 'organization');
      const names = listOf(str(values, 'assign_names', ''));
      const tagCategory = str(values, 'tag_category', '');
      const cadence = str(values, 'bill_cadence', 'monthly');
      const recipients = listOf(str(values, 'bill_recipients', ''));
      const alertPct = num(values, 'tenant_alert_pct', 80);
      const appShowback = bool(values, 'app_showback', true);
      const base = slugOf(name || policyName, 'rate-card');
      const bills = cadence !== 'none';

      const findings            = [];
      if (rVcpu + rRam + rStorage + fixed === 0) findings.push(error('vcfops.showback.all-zero', 'Every rate is zero, so every bill is zero.', { source: SRC }));
      if (assignTo === 'tag' && !tagCategory.trim()) findings.push(error('vcfops.showback.no-tag', 'Tag-based assignment needs the tag category that carries the cost centre.', { source: SRC }));
      if (assignTo !== 'tag' && names.length === 0) findings.push(error('vcfops.showback.unassigned', 'A pricing policy assigned to nothing prices nothing.', { source: SRC }));
      if (bills && recipients.length === 0) findings.push(error('vcfops.showback.no-recipient', 'Bills are scheduled with nobody to send them to.', { source: SRC }));
      if (basis === 'usage') {
        findings.push(
          warning('vcfops.showback.usage', 'Charging on usage makes a tenant’s bill depend on how busy their VMs were, and oversized VMs cost them almost nothing.', {
            remediation: 'Allocation-based pricing charges for what was reserved, which is what drives the hardware you buy. VCF Automation’s upfront pricing estimates are also allocation-based.',
            source: SRC,
          }),
        );
      }
      if (assignTo === 'tag') {
        findings.push(
          info('vcfops.showback.untagged', `VMs with no ${tagCategory} tag fall outside a tag-based policy and are priced by whatever policy is next — often the default.`, {
            remediation: 'Report untagged VMs every month, and make the tag mandatory in the VCF Automation template so new VMs cannot be untagged.',
            source: SRC,
          }),
        );
      }

      const card = {
        $comment: 'ArchToolKit rate card. build-policy.sh maps each rate onto the item in a template pricing policy whose itemName matches the regex.',
        name: policyName,
        description: `Generated by ArchToolKit. ${basis === 'allocation' ? 'Allocation' : 'Usage'} based; per month.`,
        rates: [
          { label: 'vCPU', array: 'meterings', match: 'cpu', rate: rVcpu },
          { label: 'Memory GB', array: 'meterings', match: 'mem|ram', rate: rRam },
          { label: 'Storage GB', array: 'meterings', match: 'storage|disk', rate: rStorage },
          ...(fixed > 0 ? [{ label: 'Fixed per VM', array: 'unconditionalMeterings', match: 'vm|fixed|recurring', rate: fixed }] : []),
        ],
      };

      const build = [
        '#!/usr/bin/env bash',
        `# Create the pricing policy "${policyName}" by cloning a template policy and`,
        '# setting its rates from rate-card.json.',
        '#',
        '# Why a template: the pricing API documents the shape of a policy but not the',
        '# item names, units or charge periods it expects. A policy made once in the',
        '# interface carries all of them, so this copies its structure and changes only',
        '# the numbers. It refuses if a rate matches no item, rather than guessing.',
        '#',
        '# Without --execute it prints the policy it would create.',
        'set -euo pipefail',
        ...authPreamble(PLATFORM),
        ': "${TEMPLATE_POLICY_ID:?set TEMPLATE_POLICY_ID: create one policy in the interface with every item priced, then GET /suite-api/api/pricing and take its id}"',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'CARD="${CARD:-rate-card.json}"',
        '',
        'api() {',
        '  local method="$1" path="$2"; shift 2',
        `  curl -sS -f -X "$method" "https://\${VCFOPS_HOST}\${path}" -H "${HDR}" -H "Accept: application/json" "$@"`,
        '}',
        '',
        'name=$(jq -r .name "$CARD")',
        'if api GET /suite-api/api/pricing | jq -e --arg n "$name" \'[.policies[]? | select(.name == $n)] | length > 0\' >/dev/null; then',
        '  echo "A pricing policy named \\"${name}\\" already exists. Rename it in ${CARD}, or change the existing one in the interface." >&2',
        '  exit 2',
        'fi',
        '',
        'tpl=$(api GET "/suite-api/api/pricing/${TEMPLATE_POLICY_ID}")',
        '',
        "missing=$(jq -r --slurpfile c \"$CARD\" '",
        '  . as $t | ($c[0]) as $c | [$c.rates[] | .match as $re | .array as $a',
        '    | select([($t[$a] // [])[] | .itemName | ascii_downcase | test($re)] | any | not) | "\\(.label) (\\($a), /\\($re)/)"] | .[]\' <<<"$tpl")',
        'if [[ -n "$missing" ]]; then',
        '  echo "These rates match no item in the template policy, so they would be silently dropped:" >&2',
        '  echo "$missing" >&2',
        '  echo "Items the template has:" >&2',
        '  jq -r \'[.meterings[]?.itemName, .unconditionalMeterings[]?.itemName] | .[]\' <<<"$tpl" >&2',
        '  echo "Price those items in the template, or change the match in ${CARD}." >&2',
        '  exit 2',
        'fi',
        '',
        "policy=$(jq --slurpfile c \"$CARD\" '",
        '  ($c[0]) as $c',
        '  | def rate($arr; $item): [$c.rates[] | .match as $re | select(.array == $arr and ($item | ascii_downcase | test($re)))][0].rate;',
        '  del(.id, .links, .lastUpdateTimestamp)',
        '  | .name = $c.name | .description = $c.description | .createdBy = "VROPS"',
        '  | .meterings = [(.meterings // [])[] | rate("meterings"; .itemName) as $r | if $r == null then . else .metering.baseRate = $r end]',
        '  | .unconditionalMeterings = [(.unconditionalMeterings // [])[] | rate("unconditionalMeterings"; .itemName) as $r | if $r == null then . else .unconditionalMetering.rate = $r end]\' <<<"$tpl")',
        '',
        'echo "Rates as they will be set:"',
        "jq -r '(.meterings[]? | \"  \\(.itemName)\\t\\(.metering.baseRate)\\t\\(.metering.chargeBasedOn // \"\")\\t\\(.metering.chargePeriod // \"\")\"), (.unconditionalMeterings[]? | \"  \\(.itemName)\\t\\(.unconditionalMetering.rate)\\t\\t\\(.unconditionalMetering.chargePeriod // \"\")\")' <<<\"$policy\"",
        '',
        'if [[ "${1:-}" != "--execute" ]]; then',
        '  echo "DRY RUN: would POST this policy to https://${VCFOPS_HOST}/suite-api/api/pricing. Nothing was changed."',
        '  exit 0',
        'fi',
        '',
        'id=$(printf \'%s\' "$policy" | api POST /suite-api/api/pricing -H "Content-Type: application/json" --data-binary @- | jq -r .id)',
        'if [[ -z "$id" || "$id" == null ]]; then echo "The API accepted the request but returned no id. Check GET /suite-api/api/pricing before running again." >&2; exit 1; fi',
        'echo "Created pricing policy ${id}. It prices nothing until it is assigned — see showback-setup.md."',
        'echo "${id}" > created-pricing-policy-id.txt',
        '',
        '# Undo: DELETE /suite-api/api/pricing/{id} (the id is in created-pricing-policy-id.txt).',
        '',
      ].join('\n');

      const assignLine =
        assignTo === 'tag'
          ? `VMs by the vSphere tag category **${tagCategory}**: one tag value per cost centre, priced by this policy. Assign the policy to the tag-based group (or use tag-based rate factors in the policy) under Manage → Cost → Pricing. Cross-check with the tag standard so the category is the same one VCF Automation stamps on new VMs.`
          : `The VCF Automation ${assignTo === 'organization' ? 'organizations' : 'projects'} **${names.join(', ') || '(none)'}**. Under Manage → Cost → Pricing, assign the policy to each; an ${assignTo} with no assignment is priced by the default policy.`;

      const setup = [
        `# ${policyName} — showback and chargeback setup`,
        '',
        'Generated by ArchToolKit for VCF Operations 9.1.',
        '',
        '| Rate | Per month | Charged on |',
        '|---|---|---|',
        `| vCPU | ${rVcpu} | ${basis} |`,
        `| Memory, per GB | ${rRam} | ${basis} |`,
        `| Storage, per GB | ${rStorage} | ${basis} |`,
        `| Fixed, per VM | ${fixed} | recurring |`,
        '',
        'Cost is what it costs you (the cost drivers). Price is what you charge. The gap between them is the',
        'margin or the subsidy, and it should be a decision — compare this card with the per-host cost from',
        '"Cost drivers" before publishing it.',
        '',
        '## 1. Create the template once, in the interface',
        '',
        `Manage → Cost → Pricing (VERIFY the path in your build): create a policy with every item you want priced — CPU, memory, storage, a recurring per-VM charge — charged on **${basis}**, monthly. Any non-zero rate. Its id is TEMPLATE_POLICY_ID.`,
        '',
        '## 2. Create the real policy from it',
        '',
        '`build-policy.sh` (dry run), then `build-policy.sh --execute`.',
        '',
        '## 3. Assign it',
        '',
        assignLine,
        '',
        ...(appShowback
          ? ['## 4. Application showback (9.1)', '', 'Define the applications and tiers (VCF Operations applications) whose total running cost and charges should be visible, and use the Organization and Project Showback dashboards with the 9.1 service-type filter (regular VMs, VKS, Data Services Manager) so VKS and DSM cost are not mixed into VM cost.', '']
          : []),
        `## ${appShowback ? '5' : '4'}. Bills`,
        '',
        bills
          ? `Manage → Cost → Bills: a **recurring** bill, ${cadence}, per ${assignTo === 'tag' ? 'cost centre' : assignTo}. 9.1 generates the bill as PDF and emails it: send to ${recipients.join(', ') || '(nobody)'}. Generate one bill by hand first and read it.`
          : 'No bills. Showback dashboards only.',
        '',
        `## ${appShowback ? '6' : '5'}. Tenant reports and alerts (9.1)`,
        '',
        alertPct > 0
          ? `Notification rules for tenants: email the organization when its consumption passes **${alertPct}%** of its quota, and a monthly consumption and cost report. Tenants read these, so send them to a team address in the tenant, not to the platform team.`
          : 'Tenant alerts are off.',
        '',
        '## Undo',
        '',
        'Unassign the policy (the next applicable policy takes over), then DELETE /suite-api/api/pricing/{id}. Bills already',
        'generated keep the rates they were generated with.',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${policyName} — ${rVcpu}/vCPU, ${rRam}/GB RAM, ${rStorage}/GB storage, ${fixed}/VM, per month`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: bills ? `Prices recalculated with the daily cost run; bills generated ${cadence}` : 'Prices recalculated with the daily cost run', worstCase: bills ? `a bill per ${assignTo === 'tag' ? 'cost centre' : assignTo} every ${cadence === 'quarterly' ? 'quarter' : 'month'}` : 'daily recalculation' },
        scope: {
          what: assignTo === 'tag' ? `VMs tagged with a value in ${tagCategory}.` : `Everything in the ${assignTo}s ${names.join(', ') || '(none)'}.`,
          decidedBy: [
            assignTo === 'tag' ? `The vSphere tag category ${tagCategory}, as VCF Operations last collected it.` : `The ${assignTo} assignment made under Pricing.`,
            'Policy precedence: where more than one pricing policy could apply, the more specific assignment wins (VERIFY the order in your release).',
            `The charge basis — ${basis} — set on the template and copied.`,
          ],
          ifWrong: 'A tenant is billed at the wrong rate, or not at all. Bills are documents people pay from; a wrong one is corrected by a credit note and an apology, not an undo.',
        },
        guardrails: [
          { rule: 'Rates are mapped onto the template’s own items, and the script refuses if one does not match', because: 'A rate that matches no item is silently dropped by the API, and the bill comes out cheaper than the card with no error anywhere.' },
          { rule: 'Refuses to create a second policy with the same name', because: 'Two identically named policies is how the wrong one gets assigned.' },
          { rule: 'Dry run unless --execute', because: 'The rates it prints are the review. Nothing is created without it.' },
        ],
        dryRun: ['Run build-policy.sh without --execute and read every item and rate it prints.', 'Generate one bill by hand for one tenant and check it against the card before the recurring bill is turned on.'],
        undo: ['Unassign the policy, then DELETE /suite-api/api/pricing/{id} with the id in created-pricing-policy-id.txt.', 'Bills already sent cannot be recalled.'],
        told: bills ? [`${recipients.join(', ') || 'Nobody'} receives each bill as PDF, ${cadence}.`, ...(alertPct > 0 ? [`Tenants are emailed at ${alertPct}% of quota.`] : [])] : ['Nobody; showback dashboards only.'],
        requires: [
          'A template pricing policy created once in the interface, and its id in TEMPLATE_POLICY_ID.',
          'Cost drivers reviewed first — see "Cost drivers and the CPU:memory cost ratio".',
          ...(assignTo === 'tag' ? [`vSphere tags in category ${tagCategory} on the VMs, collected by VCF Operations.`] : ['The VCF Automation integration in VCF Operations, so organizations and projects are visible.']),
          ...(bills ? ['An outbound mail plugin configured in VCF Operations.'] : []),
        ],
        files: {
          'rate-card.json': `${JSON.stringify(card, null, 2)}\n`,
          'build-policy.sh': build,
          'showback-setup.md': setup,
        },
        notes: [
          'The pricing API is GET/POST/PUT /suite-api/api/pricing and GET/DELETE /suite-api/api/pricing/{id}, documented for Aria Operations 8.x. VERIFY it against your 9.1 build — the path and createdBy value are the likeliest to differ.',
          'There is no documented API for pricing assignment, bills or tenant notifications, so those are interface steps.',
          'VCF Automation 9.1 shows an upfront price estimate when a VM or a VKS node is requested. It comes from the same policy, so a wrong rate is visible to requesters before it is visible on a bill.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_whatif',
    platform: PLATFORM,
    label: 'A what-if scenario, written down so it can be run again',
    group: 'Capacity',
    description:
      'What-if analysis answers “will it fit, and until when” for adding workloads, adding or removing hosts, or moving to a cloud. The answer is only as good as the inputs, and the inputs usually live in someone’s head. This writes the scenario as a file, the exact steps to enter it, and a read-only baseline of the cluster’s capacity figures on the day, so the result can be checked and the same question asked again next quarter.',
    inputs: [
      { id: 'scenario', label: 'Scenario', control: 'select', options: [{ value: 'add-workload', label: 'Add workloads' }, { value: 'add-hosts', label: 'Add hosts' }, { value: 'remove-hosts', label: 'Remove hosts' }, { value: 'migrate-cloud', label: 'Migrate to a cloud' }], default: 'add-workload' },
      { id: 'scenario_name', label: 'Scenario name', control: 'text', default: 'Q1 ERP expansion' },
      { id: 'cluster', label: 'Cluster', control: 'text', default: 'wld01-cl01' },
      { id: 'vm_count', label: 'VMs', control: 'number', default: 40, min: 1, max: 100000, showWhen: { input: 'scenario', equals: ['add-workload', 'migrate-cloud'] } },
      { id: 'vcpu', label: 'vCPU each', control: 'number', default: 4, min: 1, max: 768, showWhen: { input: 'scenario', equals: ['add-workload', 'migrate-cloud'] } },
      { id: 'mem_gb', label: 'Memory each (GB)', control: 'number', default: 16, min: 1, max: 24576, showWhen: { input: 'scenario', equals: ['add-workload', 'migrate-cloud'] } },
      { id: 'disk_gb', label: 'Disk each (GB)', control: 'number', default: 200, min: 1, max: 65536, showWhen: { input: 'scenario', equals: ['add-workload', 'migrate-cloud'] } },
      { id: 'util_pct', label: 'Expected utilisation (%)', control: 'number', default: 40, min: 1, max: 100, showWhen: { input: 'scenario', equals: ['add-workload', 'migrate-cloud'] } },
      { id: 'hosts_delta', label: 'Hosts', control: 'number', default: 2, min: 1, max: 64, showWhen: { input: 'scenario', equals: ['add-hosts', 'remove-hosts'] } },
      { id: 'host_cores', label: 'Cores per new host', control: 'number', default: 64, min: 1, max: 1024, showWhen: { input: 'scenario', equals: ['add-hosts'] } },
      { id: 'host_mem_gb', label: 'Memory per new host (GB)', control: 'number', default: 1024, min: 1, max: 24576, showWhen: { input: 'scenario', equals: ['add-hosts'] } },
      { id: 'cloud', label: 'Cloud', control: 'select', options: [{ value: 'VMware Cloud on AWS', label: 'VMware Cloud on AWS' }, { value: 'Azure VMware Solution', label: 'Azure VMware Solution' }, { value: 'Google Cloud VMware Engine', label: 'Google Cloud VMware Engine' }, { value: 'Native public cloud', label: 'Native public cloud (AWS, Azure, GCP)' }], default: 'VMware Cloud on AWS', showWhen: { input: 'scenario', equals: ['migrate-cloud'] } },
      { id: 'start_date', label: 'Implementation date', control: 'text', default: '2027-01-15' },
      { id: 'min_days', label: 'Baseline fails below (days of capacity remaining)', control: 'number', default: 90, min: 0, max: 3650 },
    ],
    automation: (values                 , name        )             => {
      const scenario = str(values, 'scenario', 'add-workload');
      const scenarioName = str(values, 'scenario_name', 'What-if');
      const cluster = str(values, 'cluster', '');
      const count = num(values, 'vm_count', 40);
      const vcpu = num(values, 'vcpu', 4);
      const mem = num(values, 'mem_gb', 16);
      const disk = num(values, 'disk_gb', 200);
      const util = num(values, 'util_pct', 40);
      const hostsDelta = num(values, 'hosts_delta', 2);
      const hostCores = num(values, 'host_cores', 64);
      const hostMem = num(values, 'host_mem_gb', 1024);
      const cloud = str(values, 'cloud', 'VMware Cloud on AWS');
      const start = str(values, 'start_date', '');
      const minDays = num(values, 'min_days', 90);
      const base = slugOf(name || scenarioName, 'whatif');
      const workload = scenario === 'add-workload' || scenario === 'migrate-cloud';
      const totalTb = (count * disk) / 1024;

      const findings            = [];
      if (!cluster.trim()) findings.push(error('vcfops.whatif.no-cluster', 'A scenario needs a cluster (or, for migration, the source) to be measured against.', { source: SRC }));
      if (workload && count > 10000) findings.push(error('vcfops.whatif.too-many-vms', `${count} VMs is above the 10,000 a 9.1 what-if scenario supports.`, { remediation: 'Split it into scenarios by application or by phase.', source: SRC }));
      if (workload && totalTb > 200) findings.push(error('vcfops.whatif.too-much-storage', `${Math.round(totalTb)} TB is above the 200 TB of storage a 9.1 what-if scenario supports.`, { remediation: 'Split it into scenarios by application or by phase.', source: SRC }));
      if (scenario === 'remove-hosts') {
        findings.push(
          warning('vcfops.whatif.remove', `Removing ${hostsDelta} host(s) also removes HA failover capacity if admission control reserves a percentage.`, {
            remediation: 'Check the result against the cluster’s admission control, not only the capacity figure. What-if does not change admission control for you.',
            source: SRC,
          }),
        );
      }
      if (workload && util >= 90) findings.push(warning('vcfops.whatif.util', `${util}% expected utilisation is a sizing for peak, not for demand.`, { remediation: 'Use the average you expect. Allocation-model results already cover what was promised.', source: SRC }));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) findings.push(warning('vcfops.whatif.date', 'The implementation date is not a YYYY-MM-DD date, so the steps cannot say when to set it for.', { source: SRC }));

      const spec = {
        $comment: 'ArchToolKit what-if scenario. Entered in the interface; there is no documented API for what-if analysis.',
        name: scenarioName,
        type: scenario,
        cluster,
        implementationDate: start,
        ...(workload ? { workload: { vmCount: count, vcpuPerVm: vcpu, memoryGbPerVm: mem, diskGbPerVm: disk, expectedUtilisationPct: util, totals: { vcpu: count * vcpu, memoryGb: count * mem, diskGb: count * disk } } } : {}),
        ...(scenario === 'add-hosts' ? { hosts: { add: hostsDelta, coresEach: hostCores, memoryGbEach: hostMem, totals: { cores: hostsDelta * hostCores, memoryGb: hostsDelta * hostMem } } } : {}),
        ...(scenario === 'remove-hosts' ? { hosts: { remove: hostsDelta } } : {}),
        ...(scenario === 'migrate-cloud' ? { target: cloud } : {}),
      };

      const typeLabel                         = {
        'add-workload': 'Workload Planning: Traditional (add VMs)',
        'add-hosts': 'Infrastructure Planning: Traditional (add hosts)',
        'remove-hosts': 'Infrastructure Planning: Traditional (remove hosts)',
        'migrate-cloud': cloud === 'Native public cloud' ? 'Migration Planning: Public Cloud' : 'Migration Planning: VMware Cloud',
      };

      const steps = [
        `# What-if: ${scenarioName}`,
        '',
        'Generated by ArchToolKit for VCF Operations 9.1. What-if analysis is read-only: it models, and changes',
        'nothing in the inventory. There is no documented API for it, so the scenario is entered by hand from',
        `\`${base}-scenario.json\`, which is the record of what was asked.`,
        '',
        '1. Run `baseline.sh` and keep its output beside this file. It is what the cluster looked like the day the question was asked.',
        `2. Manage → Capacity → What-If Analysis (VERIFY the path in your build). Choose **${typeLabel[scenario]}**.`,
        `3. Location: **${cluster || '(cluster)'}**. Implementation date: **${start || '(date)'}**.`,
        ...(workload
          ? [`4. Workload: ${count} VMs, ${vcpu} vCPU, ${mem} GB memory, ${disk} GB disk each, expected utilisation ${util}%. Totals: ${count * vcpu} vCPU, ${count * mem} GB memory, ${Math.round(totalTb * 10) / 10} TB disk.`]
          : scenario === 'add-hosts'
            ? [`4. Add ${hostsDelta} host(s), ${hostCores} cores and ${hostMem} GB each — choose the matching server model or enter it as a custom profile.`]
            : [`4. Remove ${hostsDelta} host(s). Pick the ones you would actually remove, not the smallest.`]),
        ...(scenario === 'migrate-cloud' ? [`5. Target: **${cloud}**. Pick the region and instance type you would buy; the cost comparison depends on it.`] : ['5. Save the scenario, then run it.']),
        '6. Read both results — demand and allocation. Record: fits yes/no, the constraining resource, and time remaining after.',
        `7. Paste those three into \`${base}-result.md\` beside this file. That is the answer, with its question and its baseline.`,
        '',
        'Scenarios can be combined to see several changes together. Run each alone first, or you cannot tell which one',
        'does not fit.',
        '',
      ].join('\n');

      const baseline = readScript('vcf-operations', `Capacity baseline for "${cluster}", taken before the what-if "${scenarioName}".`, [
        ...POST_QUERY,
        ...LARGE_DATA,
        `CLUSTER=${JSON.stringify(cluster)}`,
        `MIN_DAYS=${minDays}`,
        '',
        'id=$(get "/suite-api/api/resources?adapterKind=VMWARE&resourceKind=ClusterComputeResource&name=$(jq -rn --arg n "$CLUSTER" \'$n|@uri\')" |',
        '  jq -r --arg n "$CLUSTER" \'[.resourceList[]? | select(.resourceKey.name == $n)][0].identifier // empty\')',
        '[[ -n "$id" ]] || { echo "No cluster named ${CLUSTER}." >&2; exit 2; }',
        '',
        '# Capacity keys are discovered rather than assumed: every OnlineCapacityAnalytics',
        '# stat this cluster reports about time or capacity remaining.',
        'keys=$(get "/suite-api/api/resources/${id}/statkeys" | jq -c \'[.["stat-key"][]?.key | select(test("^OnlineCapacityAnalytics\\\\|.*(timeRemaining|capacityRemaining|recommendedSize)"; "i"))] | unique\')',
        'if [[ "$(jq length <<<"$keys")" == 0 ]]; then echo "The cluster reports no capacity analytics yet." >&2; exit 1; fi',
        '',
        'printf \'%s\\n\' "$keys" >"$WORK/keys.json"',
        'stats=$(jq -n --arg id "$id" --slurpfile k "$WORK/keys.json" \'{resourceId: [$id], statKey: $k[0], maxSamples: 1}\' |',
        `  post /suite-api/api/resources/stats/latest/query | jq -c --arg id "$id" '(${LATEST_TO_MAP})[$id] // {}')`,
        'out="baseline-$(date +%Y%m%d).json"',
        'printf \'%s\\n\' "$stats" >"$WORK/stats.json"',
        'jq -n --arg c "$CLUSTER" --arg id "$id" --slurpfile s "$WORK/stats.json" \'{cluster: $c, id: $id, taken: (now | todate), stats: $s[0]}\' >"$out"',
        'jq -r \'to_entries[] | "  \\(.key)\\t\\(.value)"\' <<<"$stats"',
        'echo "Saved to ${out}."',
        '',
        '# Fail when the cluster is already short: a what-if on a cluster with no room',
        '# answers a question nobody should be asking yet.',
        'least=$(jq \'[to_entries[] | select(.key | test("timeRemaining"; "i")) | .value | numbers] | min // empty\' <<<"$stats")',
        'if [[ -n "$least" ]] && (( $(printf "%.0f" "$least") < MIN_DAYS )); then',
        '  echo "Least time remaining is ${least} days, under ${MIN_DAYS}. Fix the current shortfall before modelling more." >&2',
        '  exit 1',
        'fi',
      ]);

      return {
        platform: PLATFORM,
        title: `What-if “${scenarioName}” on ${cluster || 'no cluster'} — ${scenario.replace('-', ' ')}`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Run when the question is asked, and again each quarter with the same file.' },
        scope: {
          what: `The capacity model of ${cluster || '(no cluster)'}. Nothing in the inventory.`,
          decidedBy: ['The cluster chosen as the location.', 'The capacity policy on that cluster — its model, buffer and overcommit decide the answer as much as the scenario does.'],
          ifWrong: 'A scenario run against the wrong cluster or the wrong policy says “fits” and hardware is not bought. Nothing changes until someone acts on the answer.',
        },
        guardrails: [
          { rule: 'Read-only: what-if models and never changes the inventory', because: 'The platform keeps scenarios separate from the estate, so a mistaken scenario costs nothing but the decision made from it.' },
          { rule: 'Baseline saved with the date', because: 'An answer with no record of the capacity it started from cannot be checked when the hardware arrives and the numbers disagree.' },
        ],
        dryRun: ['Everything here is a dry run. Run baseline.sh and read what the cluster has today before trusting what the scenario says it will have.'],
        undo: ['Nothing to undo. Delete the saved scenario in the interface when it is no longer wanted.'],
        told: ['Whoever asked the question, with the result file. baseline.sh exits 1 if the cluster is already under the days-remaining floor.'],
        requires: [`The cluster ${cluster} collected by VCF Operations with at least a few weeks of history — capacity forecasts need it.`, 'jq on the machine that runs baseline.sh.'],
        files: {
          [`${base}-scenario.json`]: `${JSON.stringify(spec, null, 2)}\n`,
          [`${base}-steps.md`]: steps,
          'baseline.sh': baseline,
        },
        notes: [
          '9.1 raised the what-if limits to 10,000 VMs and 200 TB of storage per scenario.',
          'The result depends on the capacity policy of the cluster: an allocation-model policy with a 4:1 CPU ratio and a demand-model policy give different answers to the same scenario. Say which one it was in the result file.',
          'No documented suite-API endpoint runs what-if analysis. If one appears in your build’s API reference, the scenario file has everything it would need.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_reclaim_91',
    platform: PLATFORM,
    label: 'Reclamation in 9.1: Automation Central jobs, orphaned disks, exclusions',
    group: 'Capacity',
    description:
      'The 9.1 reclamation surface in one place: Automation Central jobs for old snapshots, idle and powered-off VMs and rightsizing (with idle and powered-off VMs now includable), tag-based exclusions set on the Reclaim and Rightsize pages (which Broadcom says Automation Central honours too — verified in the job preview), the reclamation dashboard — and orphaned disks, which 9.1 can now delete. The orphaned-disk half is a script: it re-checks every disk against every VM and template in every vCenter you list, by path and by disk UUID, refuses CNS volumes and replicas, quarantines before it deletes, writes the list before it acts, and stops at a cap.',
    inputs: [
      { id: 'mode', label: 'Generate', control: 'select', options: [{ value: 'jobs', label: 'Automation Central jobs, exclusions and a pre-run check' }, { value: 'orphan-quarantine', label: 'Orphaned disks — move to quarantine (reversible)' }, { value: 'orphan-delete', label: 'Orphaned disks — delete from quarantine (irreversible)' }], default: 'jobs' },
      { id: 'group_name', label: 'Jobs act only within group', control: 'text', default: 'Automation — safe to act on', showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'exclude_tag', label: 'Exclusion tag (category=value)', control: 'text', default: 'Automation=never', hint: 'From the tag standard. Set in the Reclaim and Rightsize exclusion settings; Broadcom’s 9.1 guidance is that Automation Central honours it too (verify in a job preview)' },
      { id: 'snapshot_age', label: 'Delete snapshots older than (days)', control: 'number', default: 14, min: 1, max: 365, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'include_idle', label: 'Include idle VMs in snapshot and rightsizing jobs', control: 'toggle', default: true, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'include_off', label: 'Include powered-off VMs in snapshot jobs', control: 'toggle', default: true, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'delete_off', label: 'Also delete powered-off VMs', control: 'toggle', default: false, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'downsize', label: 'Downsize oversized VMs', control: 'toggle', default: true, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'upsize', label: 'Scale up undersized VMs', control: 'toggle', default: false, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'min_vm_age', label: 'Exclude VMs younger than (days)', control: 'number', default: 30, min: 0, max: 365, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'max_objects', label: 'Never more than (objects per run)', control: 'number', default: 25, min: 1, max: 1000 },
      { id: 'hold_days', label: 'Keep in quarantine at least (days)', control: 'number', default: 14, min: 1, max: 365, showWhen: { input: 'mode', equals: ['orphan-quarantine', 'orphan-delete'] } },
      { id: 'window', label: 'Jobs run at', control: 'text', default: 'Sunday 02:00', showWhen: { input: 'mode', equals: ['jobs'] } },
    ],
    automation: (values                 , name        )             => {
      const mode = str(values, 'mode', 'jobs');
      const group = str(values, 'group_name', '');
      const excludeTag = str(values, 'exclude_tag', '');
      const snapAge = num(values, 'snapshot_age', 14);
      const includeIdle = bool(values, 'include_idle', true);
      const includeOff = bool(values, 'include_off', true);
      const deleteOff = bool(values, 'delete_off', false);
      const downsize = bool(values, 'downsize', true);
      const upsize = bool(values, 'upsize', false);
      const minAge = num(values, 'min_vm_age', 30);
      const cap = num(values, 'max_objects', 25);
      const hold = num(values, 'hold_days', 14);
      const window = str(values, 'window', 'Sunday 02:00');
      const base = slugOf(name || 'reclaim-91', 'reclaim');

      const findings            = [];
      if (!excludeTag.trim()) {
        findings.push(
          error('vcfops.reclaim91.no-exclusion', 'There is no exclusion tag.', {
            remediation: 'Without one, the only way to take a VM out of reclamation at speed is to edit a job while it runs. Use the tag standard’s Automation=never.',
            source: SRC,
          }),
        );
      }
      if (cap > 100) findings.push(warning('vcfops.reclaim91.cap', `A cap of ${cap} per run is high for deletions.`, { remediation: 'Twenty-five is a sensible first number. Raise it after a quarter of runs nobody complained about.', source: SRC }));

      if (mode === 'jobs') {
        if (!group.trim() || /default|all|world/i.test(group)) {
          findings.push(error('vcfops.reclaim91.no-group', 'The jobs are not bounded by a purpose-built group.', { remediation: 'Scope every destructive Automation Central job to a group built with an opt-in tag — see "A custom group to scope automation".', source: SRC }));
        }
        if (upsize) findings.push(warning('vcfops.reclaim91.upsize', 'Scaling up undersized VMs adds resources automatically, which spends capacity and, on hot-add-disabled VMs, reboots them.', { remediation: 'Keep scale-up as a report until the capacity it will consume is budgeted.', source: SRC }));
        if (deleteOff) findings.push(warning('vcfops.reclaim91.delete-off', 'Deleting powered-off VMs removes machines somebody may have turned off on purpose — DR copies, quarterly batch servers.', { remediation: 'Tag those with the exclusion tag first; ninety days powered off is the usual threshold.', source: SRC }));
        if (minAge === 0) findings.push(warning('vcfops.reclaim91.new-vms', 'New VMs are not excluded, so a VM built yesterday can be rightsized on one day of history.', { remediation: 'Exclude VMs younger than 30 days — 9.1 supports exclusion by VM age.', source: SRC }));
      }

      if (mode !== 'jobs') {
        const quarantine = mode === 'orphan-quarantine';
        const listName = quarantine ? 'orphaned-disks.txt' : 'quarantined-disks.txt';
        const header = quarantine ? '# Move orphaned VMDKs into a quarantine folder on the same datastore.' : `# Delete VMDKs that have sat in quarantine for at least ${hold} days.`;
        const script = [
          '#!/usr/bin/env bash',
          header,
          '#',
          '# VCF Operations reports orphaned disks conservatively and its own documentation',
          '# says a disk in use can be listed. So this does not trust the list. Every disk',
          '# is judged again, here, immediately before it is touched, and is refused unless',
          '# every one of these says it is unused:',
          '#   - the files of every VM and template in EVERY vCenter in VCENTERS (file',
          '#     layouts, and every disk backing including its parent chain), compared as',
          '#     whole normalised paths keyed by datastore URL, not by datastore name;',
          '#   - the disk\'s own ddb.uuid against every VM disk\'s backing UUID;',
          '#   - First Class Disks (CNS persistent volumes) on its datastore;',
          '#   - its folder: no unregistered .vmx (a VM this script cannot see) and no',
          '#     vSphere Replication files.',
          '# It refuses to judge at all if any VM is disconnected, inaccessible or orphaned,',
          '# has no file layout, or uses a datastore the account cannot see.',
          '#',
          `# Input: a text file, one "[datastore] path/to/disk.vmdk" per line (default ${listName}),`,
          '# datastore names as the FIRST vCenter in VCENTERS names them.',
          '# Without --execute it writes the manifest and changes nothing.',
          'set -euo pipefail',
          'shopt -s inherit_errexit',
          '',
          `MODE=${quarantine ? 'quarantine' : 'delete'}`,
          `MAX_OBJECTS=${cap}  # the cap. Change it here, in review, not on the command line.`,
          `HOLD_DAYS=${hold}`,
          'QDIR="_orphan_quarantine"',
          `LIST="${listName}"`,
          'EXECUTE=0',
          'for arg in "$@"; do',
          '  case "$arg" in',
          '    --execute) EXECUTE=1 ;;',
          '    -*) echo "Unknown option ${arg}. The only option is --execute." >&2; exit 2 ;;',
          '    *) LIST="$arg" ;;',
          '  esac',
          'done',
          '[[ -f "$LIST" ]] || { echo "No ${LIST}. Export the orphaned disks from the Reclaim page and write one [datastore] path per line." >&2; exit 2; }',
          '',
          ': "${VCENTERS:?set VCENTERS to every vCenter whose hosts mount these datastores, space-separated host names; the first is the one the list names datastores in}"',
          ': "${GOVC_USERNAME:?set GOVC_USERNAME to the account (or put <vcenter>.username beside its password file)}"',
          ': "${GOVC_PASSWORD_DIR:?set GOVC_PASSWORD_DIR to a directory holding <vcenter>.password for each vCenter, each mode 600}"',
          'command -v govc >/dev/null || { echo "govc is required" >&2; exit 2; }',
          'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
          'read -r -a VCS <<<"$VCENTERS"',
          '(( ${#VCS[@]} > 0 )) || { echo "VCENTERS is empty." >&2; exit 2; }',
          'ACT="${VCS[0]}"',
          'for v in "${VCS[@]}"; do',
          '  [[ "$v" =~ ^[A-Za-z0-9._:-]+$ ]] || { echo "VCENTERS entries are host names, not URLs: ${v}" >&2; exit 2; }',
          '  f="${GOVC_PASSWORD_DIR}/${v}.password"',
          '  [[ -f "$f" ]] || { echo "No password file ${f} for vCenter ${v}." >&2; exit 2; }',
          '  [[ "$(stat -c %a "$f")" == 600 ]] || { echo "${f} must be mode 600." >&2; exit 2; }',
          'done',
          '',
          '# govc against one vCenter. The password is read from its file into the',
          '# environment of that one govc process; it is never an argument.',
          'vc() {',
          '  local host="$1"; shift',
          '  local user="$GOVC_USERNAME"',
          '  [[ -f "${GOVC_PASSWORD_DIR}/${host}.username" ]] && user="$(<"${GOVC_PASSWORD_DIR}/${host}.username")"',
          '  GOVC_URL="https://${host}/sdk" GOVC_USERNAME="$user" GOVC_PASSWORD="$(<"${GOVC_PASSWORD_DIR}/${host}.password")" govc "$@"',
          '}',
          'die() { echo "$*" >&2; exit 2; }',
          '',
          'STAMP=$(date +%Y%m%d-%H%M%S)',
          'MANIFEST="orphan-manifest-${STAMP}.tsv"',
          'RESTORE="orphan-restore-${STAMP}.sh"',
          'WORK=$(mktemp -d)',
          'trap \'rm -rf "$WORK"\' EXIT',
          '',
          '# govc object.collect -json prints one object per managed object in current',
          '# releases ({obj, changeSet:[{name, val}]}) and ObjectContent arrays',
          '# ({Obj, PropSet:[{Name, Val}]}) in older ones; both become {id, name, p}.',
          '# Paths are compared as <datastore URL>/<path>, with // and ./ removed and ..',
          '# resolved, and the top folder of a vSAN or vVols datastore mapped to one name',
          '# whether it was written as the namespace UUID or its friendly name.',
          'cat >"$WORK/lib.jq" <<\'JQ\'',
          'def unwrap: if type == "object" and has("_value") then ._value else . end;',
          'def objects_of: [ .[] | if type == "array" then .[] else . end | select(type == "object") ]',
          '  | map({ id: ((.obj // .Obj // {}) | "\\(.type // .Type):\\(.value // .Value)"),',
          '          p: ([ (.changeSet // .PropSet // .propSet // [])[] | {key: (.name // .Name), value: ((.val // .Val) | unwrap)} ] | from_entries) })',
          '  | map(.name = (.p.name // .id));',
          'def segs: split("/") | map(select(. != "" and . != "."))',
          '  | reduce .[] as $s ([]; if $s == ".." then (if length > 0 then .[:-1] else . end) else . + [$s] end);',
          'def canon($url; $rel; $alias): ($rel | segs) as $s | ($url | sub("/+$"; "")) as $u',
          '  | (if ($s | length) > 0 and (($alias[$u] // {})[$s[0]] != null) then [$alias[$u][$s[0]]] + $s[1:] else $s end) as $t',
          '  | $u + "/" + ($t | join("/"));',
          'def dspath: [capture("^\\\\[(?<ds>[^\\\\]]*)\\\\] ?(?<rel>.*)$")] | first // null;',
          'def forms($p; $dsmap; $alias): ($p | dspath) as $c',
          '  | if $c == null then "UNPARSED\\t" + $p',
          '    elif $c.ds == "" then empty',
          '    elif (($dsmap[$c.ds] // []) | length) == 0 then "NODS\\t" + $p',
          '    else $dsmap[$c.ds][] as $url | canon($url; $c.rel; $alias) end;',
          'def layout: [ (.p["layoutEx.file"] // null) | .. | objects | (.name // .Name // empty) | strings ];',
          'def devkeys($k): [ (.p["config.hardware.device"] // null) | .. | objects | to_entries[] | select(.key | ascii_downcase == $k) | .value | strings ];',
          'def hexid: ascii_downcase | gsub("[^0-9a-f]"; "");',
          'JQ',
          'lib=$(<"$WORK/lib.jq")',
          '',
          'is_ns_type() { [[ "${1,,}" == vsan* || "${1,,}" == vvol* ]]; }',
          '',
          '# Take everything the verdict depends on, from every vCenter, into directory $1.',
          'snapshot() {',
          '  local D="$1" i v',
          '  mkdir -p "$D"',
          '  : >"$D/attached"; : >"$D/uuids"; : >"$D/vcuuids"; echo \'{}\' >"$D/alias.json"',
          '  for i in "${!VCS[@]}"; do',
          '    v="${VCS[$i]}"',
          '    vc "$v" about -json >"$D/about.$i" || die "Could not reach vCenter ${v}; refusing to judge anything orphaned."',
          '    jq -r \'(.about // .About // {}) | (.instanceUuid // .InstanceUuid // empty) | ascii_downcase\' "$D/about.$i" >>"$D/vcuuids"',
          '    vc "$v" object.collect -json -type s / name summary.url summary.type >"$D/ds.$i" || die "Could not list datastores in ${v}."',
          '    jq -s -c "$lib"\' objects_of | map(select((.id | startswith("Datastore:")) and (.p["summary.url"] | type) == "string")) | reduce .[] as $d ({}; .[$d.p.name] += [$d.p["summary.url"]])\' "$D/ds.$i" >"$D/dsmap.$i.json"',
          '    jq -s -r "$lib"\' objects_of[] | select(.id | startswith("Datastore:")) | [.p.name, .p["summary.url"], (.p["summary.type"] // "")] | @tsv\' "$D/ds.$i" >"$D/dsrows.$i"',
          '    # vSAN and vVols: pair each top-level namespace UUID with its friendly name.',
          '    while IFS=$\'\\t\' read -r name url type; do',
          '      is_ns_type "$type" || continue',
          '      vc "$v" datastore.ls -ds "$name" -json >"$D/root.json" || die "Could not list the top level of ${type} datastore ${name} in ${v}."',
          '      jq -c --slurpfile a "$D/alias.json" --arg u "${url%/}" \\',
          '        \'($a[0]) as $a | $a + {($u): (($a[$u] // {}) + ([.[]?.file[]? | select((.friendlyName // "") != "" and .friendlyName != .path) | {(.friendlyName): .path, (.path): .path}] | add // {}))}\' \\',
          '        "$D/root.json" >"$D/alias.new" && mv "$D/alias.new" "$D/alias.json"',
          '    done <"$D/dsrows.$i"',
          '  done',
          '  for i in "${!VCS[@]}"; do',
          '    v="${VCS[$i]}"',
          '    vc "$v" object.collect -json -type m / name config.template runtime.connectionState layoutEx.file config.hardware.device >"$D/vm.$i" \\',
          '      || die "Could not read VM file layouts from ${v}; refusing to judge anything orphaned."',
          '    jq -s -c "$lib"\' objects_of | map(select(.id | startswith("VirtualMachine:")))',
          '      | {count: length,',
          '         notConnected: [.[] | select(.p["runtime.connectionState"] != "connected") | "\\(.name) (\\(.p["runtime.connectionState"] // "state unknown"))"],',
          '         noLayout: [.[] | select(layout | length == 0) | .name]}\' "$D/vm.$i" >"$D/vmcheck.$i"',
          '    local count; count=$(jq .count "$D/vmcheck.$i")',
          '    (( count > 0 )) || die "vCenter ${v} returned no VMs or templates. An account that sees nothing makes every disk look orphaned; refusing. It needs read-only at the vCenter root, propagated."',
          '    if [[ "$(jq \'.notConnected | length\' "$D/vmcheck.$i")" != 0 ]]; then',
          '      echo "vCenter ${v} has VMs that are not connected, so their disks cannot be seen:" >&2',
          '      jq -r \'.notConnected[] | "  " + .\' "$D/vmcheck.$i" >&2',
          '      die "Refusing to judge anything orphaned until every VM is connected (or unregistered on purpose)."',
          '    fi',
          '    if [[ "$(jq \'.noLayout | length\' "$D/vmcheck.$i")" != 0 ]]; then',
          '      echo "vCenter ${v} returned no file layout for these VMs:" >&2',
          '      jq -r \'.noLayout[] | "  " + .\' "$D/vmcheck.$i" >&2',
          '      die "Refusing: a VM whose files cannot be read cannot be shown not to use a disk."',
          '    fi',
          '    jq -s -r --slurpfile m "$D/dsmap.$i.json" --slurpfile a "$D/alias.json" "$lib"\' ($m[0]) as $m | ($a[0]) as $a',
          '      | objects_of | map(select(.id | startswith("VirtualMachine:")))[] | (layout + devkeys("filename"))[] as $f | forms($f; $m; $a)\' \\',
          '      "$D/vm.$i" >>"$D/attached"',
          '    jq -s -r "$lib"\' objects_of | map(select(.id | startswith("VirtualMachine:")))[] | devkeys("uuid")[] | hexid | select(length == 32)\' \\',
          '      "$D/vm.$i" >>"$D/uuids"',
          '    echo "vCenter ${v}: ${count} VMs and templates, all connected, all with file layouts." >&2',
          '  done',
          '  if grep -q $\'^\\(UNPARSED\\|NODS\\)\\t\' "$D/attached"; then',
          '    echo "VM files on datastores this account cannot see, or paths that could not be read:" >&2',
          '    grep $\'^\\(UNPARSED\\|NODS\\)\\t\' "$D/attached" | sort -u | head -20 >&2',
          '    die "Refusing: the account needs read-only on every datastore, from the vCenter root, propagated."',
          '  fi',
          '  sort -u -o "$D/attached" "$D/attached"',
          '  sort -u -o "$D/uuids" "$D/uuids"',
          '}',
          '',
          '# The canonical form of "[ds] rel" in the acting vCenter, or empty.',
          'canon_of() {',
          '  jq -n -r --slurpfile m "$1/dsmap.0.json" --slurpfile a "$1/alias.json" --arg p "[$2] $3" \\',
          '    "$lib"\' ($m[0]) as $m | ($a[0]) as $a | forms($p; $m; $a) | select(startswith("NODS") or startswith("UNPARSED") | not)\'',
          '}',
          '',
          '# First Class Disks on one datastore, as canonical paths. Once per datastore per snapshot; a failure stops the run.',
          'fcd_list() {',
          '  local D="$1" ds="$2" f',
          '  f="$D/fcd.$(printf %s "$ds" | md5sum | cut -c1-16)"',
          '  if [[ ! -f "$f" ]]; then',
          '    vc "$ACT" disk.ls -ds "$ds" -L >"$f.raw" || die "govc disk.ls failed on ${ds}; cannot rule out First Class Disks, refusing."',
          '    # -L prints "<id>  <path>"; the id has no spaces, the path may.',
          '    sed -E \'s/^[^[:space:]]+[[:space:]]+//\' "$f.raw" >"$f.paths"',
          '    jq -R -r --slurpfile m "$D/dsmap.0.json" --slurpfile a "$D/alias.json" "$lib"\' ($m[0]) as $m | ($a[0]) as $a | select(length > 0) | forms(.; $m; $a)\' "$f.paths" >"$f"',
          '  fi',
          '  printf %s "$f"',
          '}',
          '',
          '# Does a vCenter that is not in VCENTERS run HA on this datastore? Its heartbeat',
          '# folder names that vCenter\'s instance UUID. Best effort: absent folder = no evidence.',
          'foreign_ha() {',
          '  local D="$1" ds="$2" u',
          '  vc "$ACT" datastore.ls -ds "$ds" .vSphere-HA >"$WORK/ha" 2>/dev/null || return 1',
          '  while IFS= read -r u; do',
          '    [[ -n "$u" ]] || continue',
          '    grep -qxF -- "$u" "$D/vcuuids" || { echo "$u"; return 0; }',
          '  done < <(grep -oiE \'^FDM-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\' "$WORK/ha" | cut -c5- | tr \'A-F\' \'a-f\')',
          '  return 1',
          '}',
          '',
          '# The verdict for one disk against snapshot $1: "ok", or "skip: why".',
          'judge() {',
          '  local D="$1" ds="$2" rel="$3" c url type dir base u f',
          '  case "$rel" in',
          '    *$\'\\t\'* | *$\'\\r\'*) echo "skip: control character in the path"; return ;;',
          '  esac',
          '  if [[ "$rel" == /* || "$rel" == ./* || "$rel" == *//* || "$rel" == */./* || "$rel" =~ (^|/)\\.\\.(/|$) ]]; then',
          '    echo "skip: not a canonical path (//, ./, .. or a leading /) — write it as the datastore browser shows it"; return',
          '  fi',
          '  base="${rel##*/}"',
          '  if [[ "$rel" == */* ]]; then dir="${rel%/*}"; else dir=""; fi',
          '  shopt -s nocasematch',
          '  if [[ "$rel" =~ (^|/)\\. ]]; then echo "skip: hidden system folder"; shopt -u nocasematch; return; fi',
          '  if [[ "$rel" =~ ^(fcd|catalog|contentlib-[^/]*)/ || "$rel" == */fcd/* ]]; then echo "skip: First Class Disk or content library folder"; shopt -u nocasematch; return; fi',
          '  if [[ "$rel" =~ (^|/)hbr ]]; then echo "skip: vSphere Replication file or folder"; shopt -u nocasematch; return; fi',
          '  if [[ "$base" =~ -(flat|delta|ctk|sesparse|rdm|rdmp|digest)\\.vmdk$ ]]; then echo "skip: an extent, change-tracking, RDM or digest file — list the descriptor, never this"; shopt -u nocasematch; return; fi',
          '  shopt -u nocasematch',
          '  if [[ "$MODE" == quarantine ]]; then',
          '    [[ "$rel" == "$QDIR"/* ]] && { echo "skip: already in quarantine"; return; }',
          '  else',
          '    if [[ ! "$rel" =~ ^_orphan_quarantine/([0-9]{8})-([0-9]{6})/([^/]+\\.vmdk)$ ]]; then',
          '      echo "skip: not exactly ${QDIR}/<YYYYmmdd-HHMMSS>/<name>.vmdk — only quarantined disks may be deleted"; return',
          '    fi',
          '    local qd="${BASH_REMATCH[1]}" qdate',
          '    qdate=$(date -d "$qd" +%s 2>/dev/null) || { echo "skip: ${qd} is not a date"; return; }',
          '    (( ( $(date +%s) - qdate ) / 86400 >= HOLD_DAYS )) || { echo "skip: in quarantine for less than ${HOLD_DAYS} days"; return; }',
          '  fi',
          '  # The datastore, as the acting vCenter knows it: exactly one.',
          '  local n; n=$(jq -r --arg d "$ds" \'(.[$d] // []) | length\' "$D/dsmap.0.json")',
          '  (( n == 1 )) || { echo "skip: datastore ${ds} is not exactly one datastore in ${ACT} (found ${n})"; return; }',
          '  url=$(jq -r --arg d "$ds" \'.[$d][0]\' "$D/dsmap.0.json")',
          '  type=$(awk -F\'\\t\' -v d="$ds" \'$1 == d { print $3; exit }\' "$D/dsrows.0")',
          '  if is_ns_type "$type"; then',
          '    local top="${rel%%/*}"',
          '    jq -e --arg u "${url%/}" --arg t "$top" \'(.[$u] // {})[$t] != null\' "$D/alias.json" >/dev/null \\',
          '      || { echo "skip: ${type} datastore, and the namespace ${top} could not be resolved to both its UUID and friendly name, so a path match cannot be trusted"; return; }',
          '  fi',
          '  if u=$(foreign_ha "$D" "$ds"); then echo "skip: vSphere HA from a vCenter not in VCENTERS (instance ${u}) uses this datastore"; return; fi',
          '  c=$(canon_of "$D" "$ds" "$rel")',
          '  [[ -n "$c" ]] || { echo "skip: path could not be normalised"; return; }',
          '  grep -qxF -- "$c" "$D/attached" && { echo "skip: a VM or template refers to it"; return; }',
          '  vc "$ACT" datastore.ls -ds "$ds" "$rel" >/dev/null 2>&1 || { echo "skip: not found on the datastore"; return; }',
          '  f=$(fcd_list "$D" "$ds")',
          '  grep -qxF -- "$c" "$f" && { echo "skip: registered as a First Class Disk"; return; }',
          '  # The folder it sits in: an unregistered .vmx is a VM this script cannot see.',
          '  if ! vc "$ACT" datastore.ls -ds "$ds" -json "${dir:-.}" >"$WORK/dir.json" 2>/dev/null; then',
          '    echo "skip: could not list its folder"; return',
          '  fi',
          '  if jq -e \'[.[]?.file[]?.path | select(test("^hbr(grp|disk|cfg)\\\\."; "i"))] | length > 0\' "$WORK/dir.json" >/dev/null; then',
          '    echo "skip: vSphere Replication files in the folder — a replica, not an orphan"; return',
          '  fi',
          '  local vmx',
          '  while IFS= read -r vmx; do',
          '    local cv; cv=$(canon_of "$D" "$ds" "${dir:+$dir/}$vmx")',
          '    grep -qxF -- "$cv" "$D/attached" || { echo "skip: ${vmx} in the same folder is not registered in any vCenter in VCENTERS — a VM this script cannot see may use it"; return; }',
          '  done < <(jq -r \'.[]?.file[]?.path | select(test("\\\\.vmx$"; "i"))\' "$WORK/dir.json")',
          '  # The disk\'s own UUID, from its descriptor (the last 64 KiB, so a binary disk is not downloaded).',
          '  vc "$ACT" datastore.tail -c 65536 -ds "$ds" "$rel" >"$WORK/desc" 2>/dev/null || { echo "skip: could not read the descriptor"; return; }',
          '  u=$(grep -aiE \'^[[:space:]]*ddb\\.uuid[[:space:]]*=\' "$WORK/desc" | head -n1 | cut -d= -f2- | tr \'A-F\' \'a-f\' | tr -cd \'0-9a-f\' || true)',
          '  [[ ${#u} == 32 ]] || { echo "skip: no ddb.uuid in the descriptor, so it cannot be matched by UUID"; return; }',
          '  grep -qxF -- "$u" "$D/uuids" && { echo "skip: a VM disk has the same UUID (${u})"; return; }',
          '  echo ok',
          '}',
          '',
          'echo "Reading every VM and template from: ${VCS[*]}" >&2',
          'snapshot "$WORK/s1"',
          '',
          'printf "datastore\\tpath\\tverdict\\n" >"$MANIFEST"',
          'eligible=()',
          'declare -A dests=()',
          'while IFS= read -r line || [[ -n "$line" ]]; do',
          '  [[ -z "$line" || "$line" == \\#* ]] && continue',
          '  if [[ ! "$line" =~ ^\\[([^]]+)\\]\\ (.+\\.vmdk)$ ]]; then',
          '    printf "?\\t%s\\tskip: not a [datastore] path.vmdk line\\n" "${line//$\'\\t\'/ }" >>"$MANIFEST"; continue',
          '  fi',
          '  ds="${BASH_REMATCH[1]}"; rel="${BASH_REMATCH[2]}"',
          '  verdict=$(judge "$WORK/s1" "$ds" "$rel")',
          '  if [[ "$verdict" == ok && "$MODE" == quarantine ]]; then',
          '    dest="${QDIR}/${STAMP}/$(printf %s "$rel" | tr / _)"',
          '    if [[ -n "${dests[$ds$\'\\t\'$dest]:-}" ]]; then verdict="skip: another disk in this run flattens to the same quarantine name"; fi',
          '    dests[$ds$\'\\t\'$dest]=1',
          '  fi',
          '  if [[ "$verdict" == ok ]]; then',
          '    if (( ${#eligible[@]} >= MAX_OBJECTS )); then',
          '      verdict="skip: over the cap of ${MAX_OBJECTS}; next run"',
          '    else',
          '      verdict="$MODE"',
          '      eligible+=("${ds}"$\'\\t\'"${rel}")',
          '    fi',
          '  fi',
          '  printf "%s\\t%s\\t%s\\n" "$ds" "${rel//$\'\\t\'/ }" "$verdict" >>"$MANIFEST"',
          'done <"$LIST"',
          '',
          'echo "Manifest written to ${MANIFEST}: ${#eligible[@]} disk(s) eligible, cap ${MAX_OBJECTS}."',
          'column -t -s $\'\\t\' "$MANIFEST" 2>/dev/null || cat "$MANIFEST"',
          '',
          'if (( ! EXECUTE )); then',
          '  echo "DRY RUN: nothing was changed. Read the manifest in full, then re-run with --execute."',
          '  exit 0',
          'fi',
          '(( ${#eligible[@]} > 0 )) || { echo "Nothing eligible."; exit 0; }',
          '',
          '# Judge again, from a fresh read of every vCenter, immediately before acting.',
          'echo "Re-reading every vCenter before acting." >&2',
          'snapshot "$WORK/s2"',
          'LOG="orphan-${MODE}-${STAMP}.log"',
          'if [[ "$MODE" == quarantine ]]; then',
          '  {',
          '    echo "#!/usr/bin/env bash"',
          '    echo "# Put back the disks moved by run ${STAMP}. Needs GOVC_USERNAME and GOVC_PASSWORD_DIR as for the run."',
          '    echo "set -euo pipefail"',
          '    echo \': "${GOVC_USERNAME:?set GOVC_USERNAME}" "${GOVC_PASSWORD_DIR:?set GOVC_PASSWORD_DIR}"\'',
          '    printf \'ACT=%q\\n\' "$ACT"',
          '    declare -f vc',
          '  } >"$RESTORE"',
          '  chmod +x "$RESTORE"',
          'fi',
          'for entry in "${eligible[@]}"; do',
          '  ds="${entry%%$\'\\t\'*}"; rel="${entry#*$\'\\t\'}"',
          '  verdict=$(judge "$WORK/s2" "$ds" "$rel")',
          '  if [[ "$verdict" != ok ]]; then',
          '    echo "$(date -u +%FT%TZ) left [${ds}] ${rel}: ${verdict} on the second check" | tee -a "$LOG"',
          '    continue',
          '  fi',
          '  if [[ "$MODE" == quarantine ]]; then',
          '    dest="${QDIR}/${STAMP}/$(printf %s "$rel" | tr / _)"',
          '    if ! vc "$ACT" datastore.ls -ds "$ds" "$QDIR" >/dev/null 2>&1; then',
          '      type=$(awk -F\'\\t\' -v d="$ds" \'$1 == d { print $3; exit }\' "$WORK/s2/dsrows.0")',
          '      if is_ns_type "$type"; then',
          '        # vSAN and vVols take a top-level folder only as a namespace. VERIFY with your govc and release.',
          '        vc "$ACT" datastore.mkdir -ds "$ds" -namespace "$QDIR" >/dev/null',
          '      else',
          '        vc "$ACT" datastore.mkdir -ds "$ds" -p "$QDIR"',
          '      fi',
          '    fi',
          '    vc "$ACT" datastore.mkdir -ds "$ds" -p "${QDIR}/${STAMP}"',
          '    if vc "$ACT" datastore.ls -ds "$ds" "$dest" >/dev/null 2>&1; then',
          '      echo "$(date -u +%FT%TZ) left [${ds}] ${rel}: ${dest} already exists" | tee -a "$LOG"',
          '      continue',
          '    fi',
          '    vc "$ACT" datastore.mv -ds "$ds" "$rel" "$dest"',
          '    printf \'vc "$ACT" datastore.mv -ds %q %q %q\\n\' "$ds" "$dest" "$rel" >>"$RESTORE"',
          '    echo "$(date -u +%FT%TZ) moved [${ds}] ${rel} -> ${dest}" | tee -a "$LOG"',
          '  else',
          '    vc "$ACT" datastore.rm -ds "$ds" "$rel"',
          '    echo "$(date -u +%FT%TZ) deleted [${ds}] ${rel}" | tee -a "$LOG"',
          '  fi',
          'done',
          'if [[ "$MODE" == quarantine ]]; then',
          '  echo "Done. ${RESTORE} moves them back; ${LOG} is the record. After ${HOLD_DAYS} days, list the quarantined paths and run the delete script."',
          'else',
          '  echo "Done. The log is ${LOG}; the manifest is ${MANIFEST}."',
          'fi',
          '',
        ].join('\n');

        const listTemplate = [
          `# ${quarantine ? 'Orphaned disks to quarantine' : 'Quarantined disks to delete'} — one per line, as "[datastore] path/to/disk.vmdk".`,
          '# Datastore names as the FIRST vCenter in VCENTERS names them. Paths exactly as the datastore browser shows them:',
          '# no //, ./ or .., and the descriptor (name.vmdk), never -flat, -delta, -ctk, -sesparse, -rdm(p) or -digest.',
          quarantine
            ? '# From the Reclaim page → Orphaned Disks → Export All. Copy the datastore and path columns (VERIFY the column names in your export).'
            : '# From the log of a quarantine run, or: govc datastore.ls -ds <datastore> -R _orphan_quarantine. Exactly _orphan_quarantine/<YYYYmmdd-HHMMSS>/<name>.vmdk.',
          quarantine ? '# [vsan-wld01] old-vm-01/old-vm-01_1.vmdk' : '# [vsan-wld01] _orphan_quarantine/20270101-020000/old-vm-01_old-vm-01_1.vmdk',
          '',
        ].join('\n');

        return {
          platform: PLATFORM,
          title: quarantine ? `Quarantine up to ${cap} orphaned disks per run, re-checked against every vCenter` : `Delete up to ${cap} quarantined orphaned disks, after ${hold} days, re-checked first`,
          effect: quarantine ? 'reversible' : 'irreversible',
          trigger: { kind: 'manual', detail: quarantine ? 'Run by hand after exporting the Reclaim page’s orphaned disk list.' : `Run by hand at least ${hold} days after a quarantine run.`, worstCase: `${cap} disks per run` },
          scope: {
            what: quarantine
              ? 'VMDK descriptors in the input list that no VM or template in any listed vCenter refers to by path or by disk UUID, that are not First Class Disks, replicas or system files, and that still exist.'
              : `VMDK descriptors in the input list at exactly _orphan_quarantine/<date>/<name>.vmdk, quarantined ${hold} or more days ago, that still pass every in-use check.`,
            decidedBy: [
              'The input list, from the VCF Operations Reclaim page export.',
              'Every vCenter in VCENTERS: the file layout and every disk backing (with its parent chain and UUID) of every VM and template, read at the start of the run and again immediately before acting.',
              'Paths compared whole, after normalising, keyed by datastore URL — so a shared datastore named differently in two vCenters still matches.',
              'The disk’s own ddb.uuid from its descriptor, against every VM disk’s backing UUID.',
              'govc disk.ls -L on the datastore (First Class Disks / CNS volumes), and the fcd/, catalog/ and contentlib-*/ folder rules.',
              'Its folder: a .vmx no listed vCenter has registered, or vSphere Replication (hbr*) files, refuse it. On a vSAN or vVols datastore, the top folder must resolve to both its UUID and friendly name.',
              ...(quarantine ? [] : [`The quarantine date in the path, which must be ${hold} or more days ago.`]),
              `The cap: at most ${cap} per run.`,
            ],
            ifWrong: quarantine
              ? 'A disk in use by something no listed vCenter knows about — a VM on a vCenter left out of VCENTERS, a standalone host, a backup appliance’s hot-added disk — is moved away. It can be moved back with the restore script; whatever used it fails until then.'
              : 'A disk somebody needed is gone. The hold period is the time they had to notice it was missing.',
          },
          guardrails: [
            { rule: 'Every disk is judged against every VM and template in every vCenter in VCENTERS — by whole normalised path and by disk UUID — at the start and again immediately before it is moved or deleted', because: 'VCF Operations lists orphaned disks conservatively and says a disk in use can appear. A grep of raw JSON missed paths with & < > in them, and one vCenter missed VMs on another that share the datastore.' },
            { rule: 'Refuses to judge anything if a vCenter returns no VMs, or any VM is disconnected, inaccessible or orphaned, has no file layout, or uses a datastore the account cannot see', because: 'An account that sees nothing, or a VM whose files cannot be read, makes every disk look orphaned.' },
            { rule: 'Refuses paths with //, ./ or .., and in delete mode anything that is not exactly _orphan_quarantine/<YYYYmmdd-HHMMSS>/<name>.vmdk', because: 'A path like _orphan_quarantine/<date>/../../app01/app01.vmdk passed a prefix check and deleted a live disk.' },
            { rule: 'First Class Disks (govc disk.ls -L, compared by full path; fcd/, catalog/, contentlib-*/) are refused, and a disk.ls failure stops the run', because: 'A detached CNS persistent volume looks orphaned and is somebody’s database. Kubernetes owns it, not this script.' },
            { rule: 'Refuses extents and sidecars (-flat, -delta, -ctk, -sesparse, -rdm, -rdmp, -digest), hidden folders, vSphere Replication (hbr*) files and folders, and a folder holding a .vmx no listed vCenter has registered', because: 'Those are parts of a disk, a replica, or a VM this script cannot see — not orphans.' },
            { rule: 'Refuses a datastore whose vSphere HA heartbeat folder names a vCenter not in VCENTERS (best effort)', because: 'That is the one on-disk sign that another vCenter’s hosts mount it; a disk they use looks orphaned from here.' },
            { rule: `At most ${cap} per run, enforced by the script`, because: 'A wrong list with a cap is an afternoon of moving files back; without one it is a datastore.' },
            { rule: 'The manifest is written before anything acts, and --execute is required', because: 'The export before acting is what the change record points to, and the dry run is where a wrong list is visible.' },
            ...(quarantine
              ? [{ rule: 'Moved, not deleted, with a generated restore script', because: 'The first time an orphaned disk turns out to be in use, moving it back is a command rather than a restore from backup.' }]
              : [{ rule: `Only disks in quarantine for ${hold}+ days can be deleted`, because: 'The path carries the date it was quarantined; anything newer, not a real date, or outside quarantine, is refused. Deletion is never the first thing that happens to a disk.' }]),
            { rule: 'Each vCenter password comes from its own mode-600 file, checked, and reaches govc through its environment, never its arguments', because: 'The script refuses a readable password file rather than running with one.' },
          ],
          dryRun: ['Run it without --execute. It writes the manifest with a verdict for every line and changes nothing.', 'Read every “quarantine”/“delete” line. Anything you cannot name the origin of, exclude from the list.'],
          undo: quarantine
            ? ['Run the orphan-restore-<stamp>.sh the run wrote (same GOVC_USERNAME and GOVC_PASSWORD_DIR): it moves each disk back to where it was.']
            : ['A deleted VMDK cannot be restored except from a datastore-level backup or array snapshot. That is why deletion only happens from quarantine.'],
          told: [`The manifest, the ${quarantine ? 'restore script and move log' : 'deletion log'} (including any disk left alone on the second check), written beside the script. Attach them to the change.`],
          requires: [
            'govc and jq (1.6 or later).',
            'VCENTERS: every vCenter whose hosts mount these datastores, space-separated host names, the one the list’s datastore names come from first. A vCenter left out is a vCenter whose VMs this cannot see — the HA-folder and unregistered-.vmx checks catch some of that, not all.',
            'GOVC_PASSWORD_DIR holding <vcenter>.password for each (mode 600), and optionally <vcenter>.username; otherwise GOVC_USERNAME is used for all.',
            'An account with read-only at each vCenter root, propagated to every VM, template and datastore — an account that cannot see a VM cannot tell that the VM uses a disk — plus Datastore → Browse datastore and Low level file operations on the datastores it acts on.',
            'The orphaned disk list exported from Manage → Capacity → Reclaim → Orphaned Disks.',
          ],
          files: {
            'orphan-disks.sh': script,
            [quarantine ? 'orphaned-disks.txt' : 'quarantined-disks.txt']: listTemplate,
          },
          notes: [
            '9.1 can delete orphaned disks from the Reclaim page itself, behind a confirmation dialog. That deletes directly, with no quarantine and no cap — this script is the slower path with both. Parts of the 9.1 docs still say orphaned disks are only exported; VERIFY which your build does.',
            'govc datastore.mv and datastore.rm on a .vmdk use the virtual disk manager, so the descriptor and its -flat file move together. VERIFY on one disk first with your govc version.',
            'vSAN and vVols: the quarantine folder is created with govc datastore.mkdir -namespace, because a plain top-level folder cannot be created there, and a disk is only judged when the datastore browser returns both the namespace UUID and its friendly name (FileInfo.friendlyName) for its top folder — otherwise it is refused. VERIFY both on one disk with your govc and vSAN release.',
            'The HA check reads .vSphere-HA/FDM-<vCenter instance UUID>-… folder names. VERIFY the naming on one heartbeat datastore; an absent folder is treated as no evidence, not as proof.',
            'A disk whose descriptor has no ddb.uuid cannot be matched by UUID and is refused. That includes some imported disks — move those by hand after checking.',
            'Automation Central has no orphaned-disk job, which is why this is a script and not a schedule.',
          ],
          findings,
        };
      }

      // ---- mode === 'jobs'
      const jobs                                                                       = [
        { name: 'Delete old snapshots', action: 'Reclaim → Delete old snapshots', params: `older than ${snapAge} days${includeIdle ? '; include idle VMs' : ''}${includeOff ? '; include powered-off VMs' : ''}; skip snapshots whose name contains "keep"`, deletes: true },
        ...(deleteOff ? [{ name: 'Delete powered-off VMs', action: 'Reclaim → Delete powered off VMs', params: 'powered off for the Reclaim threshold (90 days suggested)', deletes: true }] : []),
        ...(downsize ? [{ name: 'Downsize oversized VMs', action: 'Rightsize → Downsize oversized VMs', params: `${includeIdle ? 'include idle VMs; ' : ''}needs a reboot unless hot-remove applies — run in the window`, deletes: false }] : []),
        ...(upsize ? [{ name: 'Scale up undersized VMs', action: 'Rightsize → Scale-up undersized VMs', params: 'adds capacity; check the cluster has it', deletes: false }] : []),
      ];

      const design = [
        `# Reclamation in VCF Operations 9.1 — ${group || '(no group)'}`,
        '',
        'Generated by ArchToolKit.',
        '',
        '## 1. Exclusions first (platform-enforced)',
        '',
        `- Manage → Capacity → Optimize → Reclaim → settings (gear), and Rightsize → EXCLUSION SETTINGS: select the vSphere tag **${excludeTag || '(none)'}**.`,
        '  Broadcom’s 9.1 guidance (Brock Peterson, “Rightsizing and Reclamation Exclusions using vSphere Tags in VCF Operations 9.1”) is that a VM excluded on the',
        '  Reclaim or Rightsize page is excluded from Automation Central as well. The techdocs Reclaim page does not say so — VERIFY: tag one test VM and check it',
        '  disappears from each job’s preview before relying on it.',
        `- Exclude VMs younger than **${minAge} days**: age-based exclusions are set under Operate → Administration → Global Settings (9.1 techdocs, “Using Reclaim to Free Up Resources”).`,
        '  They are documented for rightsizing and reclamation recommendations; whether Automation Central jobs honour them is not documented — VERIFY in the preview.',
        '- The 9.1 release notes list “automatic exclusion of Broadcom appliances” from rightsizing and reclamation recommendations. Which appliances count, and whether',
        `  it reaches Automation Central jobs, is not documented — VERIFY, and tag vCenter, NSX, VCF Operations and every other management VM with ${excludeTag || 'the exclusion tag'} regardless.`,
        '',
        '## 2. Automation Central jobs',
        '',
        `Manage → Automation Central (VERIFY the path in your build). Scope every job to the custom group **${group || '(none)'}**, never to a datacenter or vCenter. Schedule: ${window}.`,
        '',
        '| Job | Action | Parameters | Irreversible |',
        '|---|---|---|---|',
        ...jobs.map((job) => `| ${job.name} | ${job.action} | ${job.params} | ${job.deletes ? 'yes' : 'no — resize can be reversed'} |`),
        '',
        'Before saving each job, open its preview of affected VMs and read it.',
        '',
        '## 3. The pre-run check (enforced by preflight.sh)',
        '',
        `Automation Central has no per-run cap. \`preflight.sh\` runs the day before, exports the group’s members and their reclaim and rightsize signals to CSV, and **exits 1 if the group has more than ${cap} VMs**. It cannot stop the job — wire its exit code to someone who can pause it.`,
        '',
        '## 4. The reclamation dashboard (9.1)',
        '',
        'The Reclamation dashboard shows savings achieved from reclaimed idle VMs, snapshots, orphaned disks and powered-off VMs. Review it monthly; a job that reclaims nothing month after month is scoped to the wrong group.',
        '',
        '## 5. One VM, several recommendations (9.1)',
        '',
        'A VM can now appear under snapshot reclamation, idle and rightsizing at once. Acting on one does not clear the others: deleting an idle VM’s snapshots leaves it idle. Decide the order — snapshots first, then rightsizing, then idle — so a VM is not resized the week before it is deleted.',
        '',
        '## Orphaned disks',
        '',
        'Not an Automation Central job. Generate this blueprint again with “Orphaned disks — move to quarantine”.',
        '',
      ].join('\n');

      const preflight = readScript('vcf-operations', `Pre-run check for the reclamation jobs on "${group}": export, then fail if the scope is over the cap.`, [
        ...POST_QUERY,
        ...LARGE_DATA,
        `: "\${GROUP_ID:?set GROUP_ID to the id of the custom group \\"${group}\\"}"`,
        `MAX_OBJECTS=${cap}`,
        '',
        '# Every member, every page: a group of thousands is exactly when this check matters.',
        'get_all "/suite-api/api/resources/groups/${GROUP_ID}/members" "$WORK/all.json"',
        'jq -c \'[.[] | select(.resourceKey.resourceKindKey == "VirtualMachine") | {id: .identifier, name: .resourceKey.name}]\' "$WORK/all.json" >"$WORK/members.json"',
        'count=$(jq length "$WORK/members.json")',
        '',
        '# Signals exported beside each VM. VERIFY these keys with',
        '# GET /suite-api/api/resources/{id}/statkeys on one VM; a missing key exports blank.',
        'echo \'["sys|poweredOn","summary|oversized","summary|undersized","summary|idle","diskspace|snapshot|age"]\' >"$WORK/keys.json"',
        'out="reclaim-scope-$(date +%Y%m%d).csv"',
        'if (( count > 0 )); then',
        '  jq -c \'[.[].id]\' "$WORK/members.json" >"$WORK/ids.json"',
        '  latest_map "$WORK/ids.json" "$WORK/keys.json" "$WORK/latest.json"',
        '  jq -r -n --slurpfile v "$WORK/latest.json" --slurpfile m "$WORK/members.json" --slurpfile k "$WORK/keys.json" \'($v[0]) as $v | ($k[0]) as $k',
        '    | (["name","id"] + $k | @csv), ($m[0][] | . as $vm | ([$vm.name, $vm.id] + [$k[] as $key | ($v[$vm.id][$key] // "")]) | @csv)\' >"$out"',
        'else',
        '  echo "name,id" >"$out"',
        'fi',
        'echo "${count} VM(s) in scope; exported to ${out}."',
        '',
        'if (( count > MAX_OBJECTS )); then',
        '  echo "The group has ${count} VMs, over the cap of ${MAX_OBJECTS}. Pause the Automation Central jobs and narrow the group before they run." >&2',
        '  exit 1',
        'fi',
        'if (( count == 0 )); then echo "The group is empty; the jobs will do nothing." >&2; exit 1; fi',
        'echo "Within the cap."',
      ]);

      const crontab = [
        '# Pre-run check, the day before the jobs. Written disabled: uncomment after a first manual run.',
        '# It exits 1 over the cap; route cron mail or the exit code to whoever can pause the jobs.',
        `# ${dayBefore(window)} ${scheduledEnv(PLATFORM)} GROUP_ID=<id> /opt/archtoolkit/${base}-preflight.sh >>/var/log/archtoolkit/${base}-preflight.log 2>&1`,
        `# The jobs themselves run in Automation Central at ${window} (cron equivalent: ${cronOf(window)}) — not from cron.`,
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Reclamation jobs on “${group || 'no group'}” — snapshots over ${snapAge} days${downsize ? ', downsizing' : ''}${deleteOff ? ', powered-off VM deletion' : ''}`,
        effect: 'irreversible',
        trigger: { kind: 'schedule', detail: `${window}, from Automation Central; the pre-run check a day earlier from cron`, worstCase: 'every member of the group, once a week — Automation Central has no per-run cap' },
        scope: {
          what: `VMs in the custom group "${group || '(none)'}" that qualify for each job, minus everything the exclusion settings remove.`,
          decidedBy: [
            `The custom group "${group || '(none)'}", resolved when the job runs.`,
            `The Reclaim and Rightsize exclusion tag ${excludeTag || '(none)'}, which Broadcom’s 9.1 guidance says Automation Central honours (VERIFY in the job preview).`,
            `The age exclusion (${minAge} days) and the automatic exclusion of Broadcom appliances — documented for recommendations; not documented for Automation Central jobs (VERIFY).`,
            'Each job’s own criteria (snapshot age, idle or powered-off status, oversized or undersized).',
          ],
          ifWrong: 'Snapshots that were someone’s rollback are deleted and VMs are resized or deleted across the whole group in one run. Snapshot and VM deletion cannot be undone.',
        },
        guardrails: [
          { rule: `VMs tagged ${excludeTag || '(none)'} are excluded — by the platform, once set in the Reclaim and Rightsize exclusion settings`, because: 'Broadcom’s 9.1 guidance is that a VM excluded on the Reclaim or Rightsize page is excluded from Automation Central too, so one tag takes a VM out of every reclamation path at once. The techdocs do not say so yet: check a tagged VM is missing from each job’s preview.' },
          { rule: `Pre-run check exits 1 when the group has more than ${cap} VMs`, because: 'Automation Central has no cap of its own. The check cannot stop the job, but it fails loudly the day before, when someone can still pause it.' },
          { rule: 'The scope is exported to CSV before every run', because: 'After a deletion the question is always “what was in scope”; the export is the answer, dated.' },
          { rule: `VMs younger than ${minAge} days excluded from recommendations (Global Settings)`, because: 'A week of history makes every new VM look oversized. Documented for recommendations only — whether Automation Central honours it is the preview’s to show.' },
        ],
        dryRun: ['Create each job and read its preview of affected VMs before saving it; do not schedule it the same day.', 'Run preflight.sh by hand and read the CSV. Every VM in it is one the jobs may act on.'],
        undo: [
          'Deleted snapshots and deleted VMs cannot be restored except from backup.',
          'A downsize or scale-up is reversed by resizing back — the job history in Automation Central records the before and after.',
          'Disable or delete the job in Automation Central to stop the next run.',
        ],
        told: ['Automation Central keeps a history of each run and the objects it acted on.', 'The pre-run CSV and its exit code, from cron mail or wherever the check is scheduled.', 'The reclamation dashboard, monthly.'],
        requires: [
          `The custom group "${group}" (opt-in tag, exclusion tag) and its id in GROUP_ID.`,
          `vSphere tag ${excludeTag} created in vCenter and collected by VCF Operations.`,
          'Actions enabled on the vCenter adapter, with an account that has the rights these jobs need and no more.',
        ],
        files: {
          [`${base}-design.md`]: design,
          [`${base}-preflight.sh`]: preflight,
          'crontab.txt': crontab,
        },
        notes: [
          'For snapshot or powered-off deletion with a hard per-run cap enforced by a script instead of Automation Central, use “Reclaim idle and oversized VMs on a schedule”.',
          'There is no documented suite-API for Automation Central jobs or Reclaim settings in 9.1, so both are interface steps. VERIFY before scripting.',
          'Exclusions, as documented: tag, age and history exclusions and the automatic exclusion of Broadcom appliances apply to rightsizing and reclamation recommendations (9.1 release notes; techdocs “Using Reclaim to Free Up Resources”). That tag exclusions carry to Automation Central comes from Broadcom’s Brock Peterson (brockpeterson.com, 9.1 exclusions post), not the techdocs; nothing documents appliance or age exclusions for Automation Central. VERIFY each in a job preview.',
          'The stat keys the pre-run export reads are the VMware adapter’s as documented for earlier releases; a key that is not present exports blank rather than failing.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_capacity_policy',
    platform: PLATFORM,
    label: 'Capacity settings in a policy, with a monthly capacity report',
    group: 'Capacity',
    description:
      'The capacity half of a policy, decided rather than inherited: allocation or demand, overcommit, buffers per resource, time-remaining thresholds, forecast risk level, and the 9.1 additions — storage-based workload eviction, network port group placement, and exclusions by tag and VM age. Paired with the monthly capacity report schedule that makes anyone read the result.',
    inputs: [
      { id: 'policy_name', label: 'Policy', control: 'text', default: 'Capacity — production clusters' },
      { id: 'groups', label: 'Applies to groups', control: 'text', default: 'Production clusters' },
      { id: 'model', label: 'Capacity model', control: 'select', options: [{ value: 'allocation', label: 'Allocation — what is promised' }, { value: 'demand', label: 'Demand — what is used' }], default: 'allocation' },
      { id: 'cpu_overcommit', label: 'CPU overcommit (vCPU:core)', control: 'number', default: 4, min: 1, max: 20, showWhen: { input: 'model', equals: ['allocation'] } },
      { id: 'mem_overcommit', label: 'Memory overcommit', control: 'number', default: 1, min: 1, max: 4, showWhen: { input: 'model', equals: ['allocation'] } },
      { id: 'buffer_cpu', label: 'CPU buffer %', control: 'number', default: 10, min: 0, max: 50 },
      { id: 'buffer_mem', label: 'Memory buffer %', control: 'number', default: 10, min: 0, max: 50 },
      { id: 'buffer_disk', label: 'Disk buffer %', control: 'number', default: 15, min: 0, max: 50 },
      { id: 'risk', label: 'Forecast risk level', control: 'select', options: [{ value: 'conservative', label: 'Conservative — plan for the upper forecast' }, { value: 'aggressive', label: 'Aggressive — plan for the mean' }], default: 'conservative' },
      { id: 'tr_warning', label: 'Warn when time remaining under (days)', control: 'number', default: 120, min: 1, max: 730 },
      { id: 'tr_critical', label: 'Critical when time remaining under (days)', control: 'number', default: 60, min: 1, max: 730 },
      { id: 'storage_eviction', label: 'Storage-based workload eviction', control: 'toggle', default: true, hint: '9.1: Workload Automation moves VMs off a cluster whose storage is stressed' },
      { id: 'storage_threshold', label: 'Evict when datastore use above (%)', control: 'number', default: 85, min: 50, max: 99, showWhen: { input: 'storage_eviction', equals: ['true'] } },
      { id: 'port_groups', label: 'Place across equivalent port groups', control: 'toggle', default: false, hint: '9.1, for All Apps organizations' },
      { id: 'exclude_tag', label: 'Exclude from recommendations (tag)', control: 'text', default: 'Automation=never' },
      { id: 'min_vm_age', label: 'Exclude VMs younger than (days)', control: 'number', default: 30, min: 0, max: 365 },
      { id: 'report_name', label: 'Report definition', control: 'text', default: 'Cluster capacity' },
      { id: 'recipients', label: 'Send the report to', control: 'text', default: 'capacity-team@example.com' },
      { id: 'day_of_month', label: 'On day of month', control: 'number', default: 1, min: 1, max: 28 },
      { id: 'scope_object', label: 'Run it for', control: 'text', default: 'vSphere World' },
    ],
    automation: (values                 , name        )             => {
      const policy = str(values, 'policy_name', 'Capacity');
      const groups = listOf(str(values, 'groups', ''));
      const model = str(values, 'model', 'allocation');
      const cpuOc = num(values, 'cpu_overcommit', 4);
      const memOc = num(values, 'mem_overcommit', 1);
      const bCpu = num(values, 'buffer_cpu', 10);
      const bMem = num(values, 'buffer_mem', 10);
      const bDisk = num(values, 'buffer_disk', 15);
      const risk = str(values, 'risk', 'conservative');
      const trWarn = num(values, 'tr_warning', 120);
      const trCrit = num(values, 'tr_critical', 60);
      const eviction = bool(values, 'storage_eviction', true);
      const storageThreshold = num(values, 'storage_threshold', 85);
      const portGroups = bool(values, 'port_groups', false);
      const excludeTag = str(values, 'exclude_tag', '');
      const minAge = num(values, 'min_vm_age', 30);
      const reportName = str(values, 'report_name', 'Cluster capacity');
      const recipients = listOf(str(values, 'recipients', ''));
      const dom = num(values, 'day_of_month', 1);
      const scopeObject = str(values, 'scope_object', 'vSphere World');
      const base = slugOf(name || policy, 'capacity-policy');

      const findings            = [];
      if (groups.length === 0) findings.push(error('vcfops.capacity.unassigned', 'A policy assigned to no group applies to nothing.', { source: SRC }));
      if (trCrit >= trWarn) findings.push(error('vcfops.capacity.thresholds', `The critical threshold (${trCrit} days) is not below the warning threshold (${trWarn} days).`, { source: SRC }));
      if (recipients.length === 0) findings.push(error('vcfops.capacity.no-recipient', 'The capacity report goes to nobody.', { source: SRC }));
      if (trWarn < 90) findings.push(warning('vcfops.capacity.short-warning', `${trWarn} days is less than most hardware lead times.`, { remediation: 'The warning exists to start a purchase. Set it to procurement plus racking time — usually 90 to 180 days.', source: SRC }));
      if (bCpu === 0 && bMem === 0) findings.push(warning('vcfops.capacity.no-buffer', 'No CPU or memory buffer: capacity is reported as available right up to the host failure that takes it away.', { remediation: 'Cover at least one host per cluster, unless HA admission control already reserves it — then say so in the design.', source: SRC }));
      if (model === 'allocation' && memOc > 1.5) findings.push(warning('vcfops.capacity.mem-overcommit', `${memOc}:1 memory overcommit plans for ballooning and swap.`, { source: SRC }));
      if (risk === 'aggressive') findings.push(info('vcfops.capacity.aggressive', 'Aggressive planning uses the mean forecast, so time remaining runs out about half the time before it says it will.', { source: SRC }));
      if (eviction && storageThreshold > 90) findings.push(warning('vcfops.capacity.eviction-late', `Evicting at ${storageThreshold}% leaves little room to move anything — Storage vMotion needs free space on the source and destination while it runs.`, { source: SRC }));
      if (!excludeTag.trim()) findings.push(warning('vcfops.capacity.no-exclusion', 'No exclusion tag, so every VM is a rightsizing and eviction candidate.', { source: SRC }));

      const rows                             = [
        ['Capacity model', model, model === 'allocation' ? 'Plans against what has been promised — what a production service can call on.' : 'Plans against use; reclaims more and protects less.'],
        ...(model === 'allocation' ? ([['CPU overcommit', `${cpuOc}:1`, cpuOc > 6 ? 'High; watch CPU ready.' : 'A common production ratio.'], ['Memory overcommit', `${memOc}:1`, memOc > 1 ? 'Relies on memory reclamation under load.' : 'No reliance on ballooning or swap.']]                              ) : []),
        ['Buffer — CPU / memory / disk', `${bCpu}% / ${bMem}% / ${bDisk}%`, 'Held back from what is reported available. Disk higher: it fills without warning and cannot be overcommitted back.'],
        ['Forecast risk level', risk, risk === 'conservative' ? 'Plans against the upper range of the forecast.' : 'Plans against the mean.'],
        ['Time remaining — warning / critical', `${trWarn} / ${trCrit} days`, 'Warning starts a purchase; critical escalates it.'],
        ['Storage-based workload eviction (9.1)', eviction ? `on, above ${storageThreshold}% datastore use` : 'off', eviction ? 'Workload Automation moves VMs off a cluster whose storage is stressed, not only CPU and memory.' : 'Only CPU and memory drive workload moves.'],
        ['Network port group placement (9.1)', portGroups ? 'on' : 'off', portGroups ? 'VMs in All Apps organizations can be placed across equivalent port groups, so a move is not blocked by a port group name.' : 'Moves stay within the same port group.'],
        ['Exclusions (9.1)', `${excludeTag || 'no tag'}; VMs younger than ${minAge} days; Broadcom appliances`, 'Excluded VMs are not recommended for rightsizing, reclamation or moves.'],
      ];

      const design = [
        `# ${policy} — capacity settings`,
        '',
        'Generated by ArchToolKit for VCF Operations 9.1. Only the capacity settings; everything else is inherited.',
        '',
        '| Setting | Value | Why |',
        '|---|---|---|',
        ...rows.map(([s, v, w]) => `| ${s} | ${v} | ${w} |`),
        '',
        `Applies to: ${groups.join(', ') || '(nothing)'}.`,
        '',
        '## Applying it',
        '',
        '1. `export-policy.sh` — saves the policy as it is now. That file is the undo.',
        `2. Configure → Policies → ${policy} → Capacity: model, overcommit, buffers, risk level and time-remaining thresholds as above.`,
        `3. Workload Automation settings of the same policy: ${eviction ? `turn on storage-based eviction at ${storageThreshold}%` : 'leave storage-based eviction off'}${portGroups ? '; allow placement across equivalent network port groups' : ''}.`,
        `4. Rightsize and Reclaim exclusion settings: tag ${excludeTag || '(none)'}, VM age ${minAge} days.`,
        '5. Export again and commit both exports beside this file.',
        '6. `apply-report-schedule.sh` — schedules the monthly capacity report.',
        '',
        'Capacity values are set in the policy editor. Writing policy XML by hand for them is possible and not worth a silently ignored element.',
        '',
      ].join('\n');

      const schedule = {
        reportDefinitionId: '<set by apply-report-schedule.sh from REPORT_DEFINITION_ID>',
        resourceId: ['<set by apply-report-schedule.sh from RESOURCE_ID>'],
        reportScheduleType: 'MONTHLY',
        recurrence: 1,
        dayOfTheMonth: dom,
        startDate: '<REQUIRED — the first date it may run, e.g. 2027-01-01; check the format against GET of an existing schedule>',
        startHour: 7,
        startMinute: 0,
        emailAddresses: recipients,
        relativePath: [],
      };

      const apply = [
        '#!/usr/bin/env bash',
        `# Schedule the report "${reportName}" monthly, on day ${dom}, at 07:00 GMT.`,
        '#',
        '# Schedules created through the API run in GMT. Without --execute this only prints',
        '# what it would send. Not idempotent: a second run makes a second schedule.',
        'set -euo pipefail',
        '',
        ...authPreamble(PLATFORM),
        `: "\${REPORT_DEFINITION_ID:?set REPORT_DEFINITION_ID: GET /suite-api/api/reportdefinitions and match the name \\"${reportName}\\"}"`,
        `: "\${RESOURCE_ID:?set RESOURCE_ID to the id of \\"${scopeObject}\\": GET /suite-api/api/resources?name=...}"`,
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        `body=$(jq --arg d "$REPORT_DEFINITION_ID" --arg r "$RESOURCE_ID" '.reportDefinitionId = $d | .resourceId = [$r]' capacity-report-schedule.json)`,
        'if grep -q "<REQUIRED" <<<"$body"; then',
        '  echo "capacity-report-schedule.json still has a <REQUIRED> value in it. Fill it in first." >&2',
        '  exit 2',
        'fi',
        '',
        'path="/suite-api/api/reportdefinitions/${REPORT_DEFINITION_ID}/schedules"',
        'if [[ "${1:-}" != "--execute" ]]; then',
        '  echo "DRY RUN: would POST to https://${VCFOPS_HOST}${path}:"',
        '  echo "$body"',
        '  echo "Nothing was changed. Re-run with --execute."',
        '  exit 0',
        'fi',
        '',
        `printf '%s' "$body" | curl -sS -f -X POST "https://\${VCFOPS_HOST}\${path}" -H "${HDR}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @-`,
        'echo',
        '',
        '# Undo: GET ${path} for the schedule id, then',
        '#   DELETE /suite-api/api/reportdefinitions/${REPORT_DEFINITION_ID}/schedules/{scheduleId}',
        '',
      ].join('\n');

      const exportPolicy = [
        '#!/usr/bin/env bash',
        `# Save "${policy}" as it is now, before its capacity settings are changed.`,
        'set -euo pipefail',
        ...authPreamble(PLATFORM),
        `: "\${POLICY_ID:?set POLICY_ID: GET /suite-api/api/policies and match \\"${policy}\\"}"`,
        '',
        'out="policy-$(date +%Y%m%d-%H%M%S).zip"',
        'curl -sS -f "https://${VCFOPS_HOST}/suite-api/api/policies/export?id=${POLICY_ID}" \\',
        `  -H "${HDR}" \\`,
        '  -o "$out"',
        '[[ -s "$out" ]] || { echo "The export is empty." >&2; exit 1; }',
        'echo "Saved ${out}. Commit it beside the design; importing it is the undo."',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${policy} — ${model} capacity, ${trWarn}/${trCrit}-day thresholds${eviction ? ', storage eviction' : ''}, monthly report`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `Capacity is recalculated every collection cycle; the report goes out monthly on day ${dom} at 07:00 GMT.`, worstCase: eviction ? 'Workload Automation moves on every run it is scheduled for, when storage crosses the threshold' : 'once a month, a report' },
        scope: {
          what: `Clusters, hosts, datastores and VMs in ${groups.join(', ') || '(no groups)'}, unless a higher-priority policy covers them.`,
          decidedBy: ['The groups the policy is assigned to, and its priority against other policies on the same objects.', `Exclusions: tag ${excludeTag || '(none)'}, VM age ${minAge} days, Broadcom appliances.`, eviction ? 'Workload Automation’s own schedule and automation level, which decide whether an eviction is recommended or performed.' : 'No eviction.'],
          ifWrong: 'Time remaining is wrong for the clusters people buy hardware for — too early and money is spent, too late and a cluster fills. With eviction on, VMs are storage-vMotioned on a threshold meant for somewhere else.',
        },
        guardrails: [
          { rule: 'Export the policy before changing it — export-policy.sh', because: 'The export is the diff and the undo; a capacity setting changed without one cannot be put back exactly.' },
          { rule: 'Report schedule is a dry run unless --execute, and refuses a payload with <REQUIRED> in it', because: 'An unfilled start date posts a schedule that never runs, and nobody notices a report that never arrives.' },
          { rule: `Excluded: ${excludeTag || 'no tag'}, VMs under ${minAge} days, Broadcom appliances`, because: 'The platform leaves excluded VMs out of rightsizing and reclamation recommendations. Whether that also covers the eviction moves this policy turns on is not documented — VERIFY before turning eviction to act.' },
        ],
        dryRun: ['After assigning, open one cluster in each group and check its policy is this one and its time remaining changed the way the design says.', 'Run apply-report-schedule.sh without --execute and read the payload. Run the report once by hand.', ...(eviction ? ['Set Workload Automation to recommend, not act, for the first month and read what it would have moved.'] : [])],
        undo: ['Import the export taken by export-policy.sh, or unassign the groups.', 'Delete the report schedule: DELETE /suite-api/api/reportdefinitions/{id}/schedules/{scheduleId}.', ...(eviction ? ['VMs already moved by eviction stay where they are; move them back with vMotion if needed.'] : [])],
        told: [`${recipients.join(', ') || 'Nobody'}, monthly, with the capacity report.`, 'Capacity time-remaining alerts, through whatever notification rules match them.'],
        requires: [`The groups ${groups.join(', ') || '(none)'}, and POLICY_ID for "${policy}".`, `The report definition "${reportName}" and its id; the id of ${scopeObject}.`, 'An outbound mail plugin in VCF Operations.', ...(eviction ? ['Workload Automation enabled for these clusters, and Storage vMotion allowed between their datastores.'] : [])],
        files: {
          [`${base}-design.md`]: design,
          'export-policy.sh': exportPolicy,
          'capacity-report-schedule.json': `${JSON.stringify(schedule, null, 2)}\n`,
          'apply-report-schedule.sh': apply,
        },
        notes: [
          'The report schedule uses POST /suite-api/api/reportdefinitions/{id}/schedules, the same as “Email a capacity report on a schedule”. Formats are set on the report definition, not the schedule.',
          '9.1 also improved storage visibility across vSAN, VMFS, NFS and vVol for clusters, hosts and VMs, and reworked the forecasting for explainability — expect time-remaining figures to move after an upgrade to 9.1 without any policy change.',
          'Where the storage eviction and port group settings sit in the policy editor is not in the API reference. VERIFY the labels in your build.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_vks_cost',
    platform: PLATFORM,
    label: 'VKS cost per vSphere Namespace, for showback',
    group: 'Cost',
    description:
      'VCF Operations 9.1 costs VKS down to nodes, clusters, vSphere Namespaces, projects and organizations. This reads that cost per namespace — discovering the namespace object type and its cost metrics rather than assuming their names — rolls it up by an organization property if you give one, writes a monthly CSV for showback, and fails when a namespace has no cost at all, which is the sign the cost engine is not covering it.',
    inputs: [
      { id: 'ns_kind', label: 'Namespace object type', control: 'text', default: 'Namespace', hint: 'The resource kind VCF Operations uses for vSphere Namespaces. The script lists candidates if this finds nothing' },
      { id: 'ns_adapter', label: 'Adapter', control: 'text', default: 'VMWARE' },
      { id: 'group_by', label: 'Roll up by', control: 'select', options: [{ value: 'namespace', label: 'Namespace only' }, { value: 'property', label: 'A property of the namespace (organization, project)' }], default: 'namespace' },
      { id: 'property_key', label: 'Property key', control: 'text', default: 'summary|organization', showWhen: { input: 'group_by', equals: ['property'] }, hint: 'VERIFY: GET /suite-api/api/resources/{id}/properties on one namespace' },
      { id: 'fail_on_uncosted', label: 'Fail when a namespace has no cost', control: 'toggle', default: true },
      { id: 'schedule', label: 'Run monthly (crontab, disabled)', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const kind = str(values, 'ns_kind', 'Namespace');
      const adapter = str(values, 'ns_adapter', 'VMWARE');
      const groupBy = str(values, 'group_by', 'namespace');
      const propKey = str(values, 'property_key', '');
      const failUncosted = bool(values, 'fail_on_uncosted', true);
      const schedule = bool(values, 'schedule', true);
      const base = slugOf(name || 'vks-cost', 'vks-cost');

      const findings            = [];
      if (!kind.trim()) findings.push(error('vcfops.vks.no-kind', 'No namespace object type.', { source: SRC }));
      if (groupBy === 'property' && !propKey.trim()) findings.push(error('vcfops.vks.no-property', 'Roll-up by property needs the property key.', { source: SRC }));
      findings.push(
        info('vcfops.vks.double-count', 'VKS node VMs are VMs. A VM showback that includes them and a namespace showback that includes them bills the same capacity twice.', {
          remediation: 'Use the 9.1 service-type filter on the Organization and Project Showback dashboards (Regular VMs vs VKS) and bill VKS from one place only.',
          source: SRC,
        }),
      );

      const script = readScript('vcf-operations', 'Cost per vSphere Namespace from VCF Operations, as CSV.', [
        ...POST_QUERY,
        ...LARGE_DATA,
        `NS_KIND="\${NS_KIND:-${kind}}"`,
        `NS_ADAPTER="\${NS_ADAPTER:-${adapter}}"`,
        ...(groupBy === 'property' ? [`PROP_KEY="\${PROP_KEY:-${propKey}}"`] : []),
        `FAIL_ON_UNCOSTED=${failUncosted ? 1 : 0}`,
        '',
        'get_all "/suite-api/api/resources?adapterKind=${NS_ADAPTER}&resourceKind=${NS_KIND}" "$WORK/all.json"',
        'ns="$WORK/ns.json"',
        'jq -c \'[.[] | {id: .identifier, name: .resourceKey.name}]\' "$WORK/all.json" >"$ns"',
        'if [[ "$(jq length "$ns")" == 0 ]]; then',
        '  echo "No ${NS_ADAPTER}/${NS_KIND} objects. Resource kinds that look like namespaces or VKS:" >&2',
        '  get "/suite-api/api/adapterkinds/${NS_ADAPTER}/resourcekinds" |',
        '    jq -r \'.["resource-kind"][]? | .key | select(test("namespace|supervisor|kubernetes|vks|tkc"; "i"))\' >&2 || true',
        '  echo "Set NS_KIND (and NS_ADAPTER) to the right one and run again." >&2',
        '  exit 2',
        'fi',
        'first=$(jq -r ".[0].id" "$ns")',
        ...costKeyDiscovery('first', '^(cost|price)\\|'),
        '',
        'jq -c \'[.[].id]\' "$ns" >"$WORK/ids.json"',
        'values="$WORK/values.json"',
        'latest_map "$WORK/ids.json" "$WORK/keys.json" "$values"',
        '',
        ...(groupBy === 'property'
          ? [
              '# The roll-up property, one call per namespace (there are usually tens, not thousands).',
              'owners="$WORK/owners.json"',
              ': >"$owners.lines"',
              'for id in $(jq -r ".[].id" "$ns"); do',
              '  get "/suite-api/api/resources/${id}/properties" | jq -c --arg id "$id" --arg k "$PROP_KEY" \'{($id): ([.property[]? | select(.name == $k) | .value][0] // "(none)")}\' >>"$owners.lines"',
              'done',
              'jq -s -c \'add // {}\' "$owners.lines" >"$owners"',
            ]
          : ['owners="$WORK/owners.json"', 'echo \'{}\' >"$owners"']),
        '',
        'out="vks-cost-$(date +%Y%m).csv"',
        'jq -r --slurpfile n "$ns" --slurpfile k "$WORK/keys.json" --slurpfile o "$owners" \'',
        '  . as $v | ($k[0]) as $k | ($o[0]) as $o',
        '  | (["namespace","owner"] + $k | @csv),',
        '    ($n[0][] | . as $x | ([$x.name, ($o[$x.id] // "")] + [$k[] as $key | ($v[$x.id][$key] // "")]) | @csv)\' "$values" >"$out"',
        'echo "Wrote ${out}: $(jq length "$ns") namespace(s), $(jq length "$WORK/keys.json") cost metric(s)."',
        ...(groupBy === 'property'
          ? [
              '',
              '# Totals per owner, on the first cost key with "total" in it (VERIFY which key is the monthly total).',
              'TOTAL_KEY="${TOTAL_KEY:-$(jq -r \'[.[] | select(test("total"; "i"))][0] // .[0]\' <<<"$keys")}"',
              'echo "Per owner, on ${TOTAL_KEY}:"',
              'jq -r --slurpfile n "$ns" --slurpfile o "$owners" --arg k "$TOTAL_KEY" \'',
              '  . as $v | ($o[0]) as $o | [$n[0][] | {owner: ($o[.id] // "(none)"), cost: ($v[.id][$k] // 0)}]',
              '  | group_by(.owner) | .[] | "  \\(.[0].owner)\\t\\(map(.cost) | add)"\' "$values"',
            ]
          : []),
        '',
        'uncosted=$(jq -r --slurpfile n "$ns" \'. as $v | [$n[0][] | select(($v[.id] // {}) | [.[] | numbers] | map(select(. != 0)) | length == 0) | .name] | .[]\' "$values")',
        'if [[ -n "$uncosted" ]]; then',
        '  echo "Namespaces with no cost at all:" >&2',
        '  echo "$uncosted" | sed "s/^/  /" >&2',
        '  (( FAIL_ON_UNCOSTED )) && exit 1',
        'fi',
        'exit 0',
      ]);

      const files                         = {
        [`${base}.sh`]: script,
        [`${base}-showback.md`]: [
          '# VKS showback — setup',
          '',
          'Generated by ArchToolKit for VCF Operations 9.1.',
          '',
          '1. Check the Supervisor and its vSphere Namespaces are collected (the script lists candidate object types if the default finds none).',
          '2. Price VKS separately if it should be: 9.1 has granular pricing for VKS nodes. Create or clone a pricing policy for it with “Showback and chargeback: a rate card” and assign it to the organizations that consume VKS.',
          '3. On the Organization and Project Showback dashboards, filter by service type (Regular VMs, VKS, DSM) so VKS cost is shown once.',
          `4. Run \`${base}.sh\` and read the CSV. Namespaces with no cost mean the cost engine is not covering them — check the cost drivers for the cluster the Supervisor runs on.`,
          '5. VCF Automation 9.1 shows an upfront price when a VKS node is requested; check it against the rate you set.',
          '',
        ].join('\n'),
      };
      if (schedule) {
        files['crontab.txt'] = [
          '# Monthly VKS cost export, first of the month 06:00. Written disabled: uncomment after a manual run.',
          '# No secret here: the script logs in from the password file.',
          `# 0 6 1 * * ${scheduledEnv(PLATFORM)} /opt/archtoolkit/${base}.sh >>/var/log/archtoolkit/${base}.log 2>&1`,
          '',
        ].join('\n');
      }

      return {
        platform: PLATFORM,
        title: `VKS cost per vSphere Namespace${groupBy === 'property' ? `, rolled up by ${propKey}` : ''}`,
        effect: 'read',
        trigger: { kind: schedule ? 'schedule' : 'manual', detail: schedule ? 'Monthly, from cron, once uncommented' : 'Run by hand for each showback period', worstCase: schedule ? 'once a month' : 'whenever it is run' },
        scope: {
          what: `Every ${adapter}/${kind} object VCF Operations knows about, and its cost metrics.`,
          decidedBy: ['The resource kind, discovered or set in NS_KIND.', 'The cost and price metrics the first namespace reports, discovered from its stat keys.', ...(groupBy === 'property' ? [`The property ${propKey} on each namespace, for the roll-up.`] : [])],
          ifWrong: 'The CSV covers the wrong objects or the wrong metric, and a showback is built on it. Nothing in the platform changes.',
        },
        guardrails: [{ rule: 'It only reads', because: 'Showback is a report. Charging a tenant is a separate decision made from it, by a person.' }, ...(failUncosted ? [{ rule: 'Exits 1 when a namespace has no cost', because: 'A zero on a showback is read as “free”, not as “not measured”.' }] : [])],
        dryRun: ['Everything here is read-only. Run it once and compare one namespace against the VCF Operations interface.'],
        undo: ['Nothing to undo. Delete the CSV.'],
        told: ['Whoever reads the CSV or the cron mail; it exits 1 when a namespace is uncosted.'],
        requires: ['VCF Operations 9.1 collecting the Supervisor, with a currency set and the cost engine running.', 'jq on the machine that runs it.'],
        files,
        notes: [
          `The namespace object type (${kind}) and the property key are not in the API reference. VERIFY with GET /suite-api/api/adapterkinds/${adapter}/resourcekinds.`,
          'Cost metric keys are discovered from the first namespace’s stat keys (anything beginning cost| or price|), so the columns are whatever your release reports.',
        ],
        findings,
      };
    },
  }),
];
