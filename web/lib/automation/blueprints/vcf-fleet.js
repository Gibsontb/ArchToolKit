/**
 * VCF fleet operations: the SDDC Manager jobs that keep an instance alive and
 * build it out.
 *
 * Checking the manager itself, prechecking an upgrade and commissioning hosts —
 * and, from vcf-fleet-91-domains.ts, creating workload domains, adding,
 * expanding and shrinking clusters, network pools, decommissioning hosts,
 * importing an existing vCenter and deploying Avi Load Balancer controllers.
 * None of them are interesting until one is missed, and then each of them is
 * the incident.
 *
 * Every script here talks to the SDDC Manager API at /v1 with a bearer token
 * from POST /v1/tokens, reads first, and acts when run (--dry-run previews). Where the
 * exact body shape moves between releases the file says so rather than
 * guessing quietly: check it against the API reference for the release in
 * front of you. The upgrade precheck is the exception: 9.1 deprecates the SDDC
 * Manager prechecks, so it runs the fleet lifecycle enhanced precheck.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { slugOf,                 } from '../automation.js';
import { authHeader, authPreamble, readScript, scheduledEnv } from '../apply.js';
                                                             
import { hostPasswordVar, lifecycleGuard, sddcApiHelper as apiHelper, sddcImport } from './vcf-fleet-91-common.js';
import { VCF_FLEET_91 } from './vcf-fleet-91.js';
import { VCF_FLEET_91_DOMAINS } from './vcf-fleet-91-domains.js';

const PLATFORM = 'vcf-fleet'         ;
const SRC = 'ArchToolKit';

/** The one step of a read-only, scheduled script. */
function scheduleStep(script        , base        , extra                    = [])                 {
  return {
    heading: 'Run it once, then schedule it',
    lines: [`Copy the files to /opt/vcf-automation/${base} on a host that reaches SDDC Manager, run \`./${script}\` by hand and compare with the SDDC Manager interface, then install the line in crontab.txt with \`crontab -e\`. It only reads.`, ...extra],
  };
}

/** Posts the PROBLEMS array to a webhook, never failing the script on the way. */
function notify(webhook        , source        )           {
  if (!webhook) return [];
  return [`curl -sS -X POST "${webhook}" -H "Content-Type: application/json" --data "$(printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "${source}", problems: .}')" || true`];
}

const STORAGE_TYPES = [
  { value: 'VSAN', label: 'vSAN (OSA)' },
  { value: 'VSAN_ESA', label: 'vSAN ESA' },
  { value: 'NFS', label: 'NFS' },
  { value: 'VMFS_FC', label: 'VMFS on Fibre Channel' },
  { value: 'VVOL', label: 'vVols' },
];

export const VCF_FLEET                                 = [


  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_health',
    platform: PLATFORM,
    label: 'Check SDDC Manager health (SDDC Manager)',
    group: 'Health',
    description:
      'The morning question, answered on a schedule: is SDDC Manager answering, has any task failed, is anything stuck, is any host unusable, and did last night’s backup happen? It reads, lists what it found, and exits non-zero when any of it is wrong.',
    inputs: [
      { id: 'failed_hours', label: 'Report failed tasks from the last (hours)', control: 'number', default: 24, min: 1, max: 720 },
      { id: 'stuck_hours', label: 'A task is stuck after (hours)', control: 'number', default: 6, min: 1, max: 168 },
      { id: 'backup_hours', label: 'Last backup must be newer than (hours)', control: 'number', default: 26, min: 1, max: 720 },
      { id: 'health_summary', label: 'Also start a health summary run', control: 'toggle', default: false, hint: 'Starts a SoS health run; heavier than a read' },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/sddc-health', hint: 'Somewhere that is not SDDC Manager' },
    ],
    automation: (values                 , name        )             => {
      const failedHours = num(values, 'failed_hours', 24);
      const stuckHours = num(values, 'stuck_hours', 6);
      const backupHours = num(values, 'backup_hours', 26);
      const summary = bool(values, 'health_summary', false);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'sddc-health', 'sddc-health');

      const findings            = [];
      if (backupHours > 7 * 24) {
        findings.push(warning('fleet.health.backup-window', `A backup up to ${Math.round(backupHours / 24)} days old counts as healthy here.`, { remediation: 'SDDC Manager should be backed up daily and on every state change. Check for 26 hours.', source: SRC }));
      }
      if (/sddc/i.test(webhook) && !/hooks/i.test(webhook)) {
        findings.push(warning('fleet.health.self-report', 'The failure report goes to SDDC Manager, which is the thing being checked.', { source: SRC }));
      }

      const tasksJq = [
        '# Failed tasks in the window, and tasks running longer than the stuck limit.',
        '# creationTimestamp format varies; fractional seconds are stripped first.',
        'def ts: (. // "" | sub("\\\\.[0-9]+"; "") | sub("\\\\+00:00$"; "Z") | (try fromdateiso8601 catch null));',
        '[ .elements[]?',
        '  | { name: (.name // .type // .id), status: (.status // "" | ascii_upcase), t: (.creationTimestamp | ts) }',
        '  | select(.t != null)',
        '  | if (.status == "FAILED") and (($now - .t) < ($failed * 3600)) then "failed task: \\(.name)"',
        '    elif (.status | test("IN_PROGRESS|IN PROGRESS")) and (($now - .t) > ($stuck * 3600)) then "stuck task (over \\($stuck)h): \\(.name)"',
        '    else empty end ]',
        '',
      ].join('\n');

      const script = readScript('sddc-manager', 'Is SDDC Manager healthy, and was it backed up?', [
        'NOW=$(date +%s)',
        'PROBLEMS=()',
        '',
        '# 1. It answers, and says what it is.',
        'if ! MGR=$(get /v1/sddc-managers); then',
        '  PROBLEMS+=("SDDC Manager API is not answering")',
        'else',
        '  echo "$MGR" | jq -r \'.elements[]? | "SDDC Manager \\(.fqdn) \\(.version)"\'',
        'fi',
        '',
        '# 2. Failed and stuck tasks.',
        'while read -r line; do PROBLEMS+=("$line"); done < <(get /v1/tasks \\',
        `  | jq -r --argjson now "$NOW" --argjson failed ${failedHours} --argjson stuck ${stuckHours} -f tasks.jq | jq -r '.[]')`,
        '',
        '# 3. Hosts SDDC Manager cannot use. Status names: ASSIGNED, UNASSIGNED_USEABLE,',
        '#    UNASSIGNED_UNUSEABLE — verify against your release.',
        'while read -r h; do PROBLEMS+=("host not usable: $h"); done < <(get /v1/hosts \\',
        '  | jq -r \'.elements[]? | select((.status // "") | test("UNUSEABLE|UNUSABLE|ERROR")) | "\\(.fqdn) (\\(.status))"\')',
        '',
        '# 4. Backup configured, and recent.',
        'BACKUP=$(get /v1/system/backup-configuration || echo "{}")',
        'if [[ "$(echo "$BACKUP" | jq \'(.backupLocations // []) | length\')" == "0" ]]; then',
        '  PROBLEMS+=("no backup location is configured")',
        'fi',
        '# The last backup, taken as the newest task whose name or type mentions backup. Verify.',
        'LAST=$(get /v1/tasks | jq -r \'[.elements[]? | select(((.name // "") + (.type // "")) | test("backup"; "i"))] | sort_by(.creationTimestamp) | last // {} | "\\(.status // "NONE") \\(.creationTimestamp // "")"\')',
        'read -r LAST_STATUS LAST_TIME <<<"$LAST"',
        'if [[ "$LAST_STATUS" == "NONE" ]]; then',
        '  PROBLEMS+=("no backup task found")',
        'else',
        '  LAST_T=$(date -d "${LAST_TIME%%.*}" +%s 2>/dev/null || echo 0)',
        `  (( NOW - LAST_T < ${backupHours} * 3600 )) || PROBLEMS+=("last backup is older than ${backupHours} hours (${'$'}{LAST_TIME})")`,
        '  [[ "${LAST_STATUS^^}" == "FAILED" ]] && PROBLEMS+=("last backup failed (${LAST_TIME})")',
        'fi',
        ...(summary
          ? [
              '',
              '# 5. Health summary. POST /v1/system/health-summary starts a SoS run and',
              '#    returns a task; this only starts it. Verify the path for your release.',
              'curl -sS -f -X POST "https://${SDDC_HOST}/v1/system/health-summary" -H "' + authHeader('sddc-manager') + '" \\',
              '  -H "Content-Type: application/json" --data \'{}\' | jq -r \'"health summary task: \\(.id // "none")"\' || PROBLEMS+=("could not start a health summary")',
            ]
          : []),
        '',
        'if (( ${#PROBLEMS[@]} == 0 )); then',
        '  echo "SDDC Manager: healthy"',
        '  exit 0',
        'fi',
        'printf "SDDC Manager: %s\\n" "${PROBLEMS[@]}" >&2',
        ...notify(webhook, 'sddc-manager-health'),
        'exit 1',
      ]);

      return {
        platform: PLATFORM,
        title: 'SDDC Manager health — tasks, hosts and backup',
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Every hour, from a scheduler outside SDDC Manager', worstCase: 'every hour while something is wrong' },
        scope: {
          what: 'One SDDC Manager instance: its tasks, its host inventory and its backup configuration. Nothing is changed.',
          decidedBy: [
            'GET /v1/sddc-managers — the instance answering.',
            `GET /v1/tasks — failed in the last ${failedHours}h, or running over ${stuckHours}h.`,
            'GET /v1/hosts — hosts SDDC Manager marks unusable.',
            `GET /v1/system/backup-configuration, and the newest backup task within ${backupHours}h.`,
          ],
          ifWrong: 'Only this instance is checked. A fleet with several SDDC Manager instances needs one run per instance.',
        },
        guardrails: [{ rule: 'Runs outside SDDC Manager and reports to an independent destination', because: 'A manager that is down cannot report that it is down.' }],
        dryRun: ['It only reads. Run it by hand once and compare with the SDDC Manager dashboard.'],
        undo: ['Nothing to undo.', ...(summary ? ['The health summary run leaves a bundle on the appliance; clear old ones as you would any SoS bundle.'] : [])],
        told: [webhook ? `${webhook}, whenever any check fails.` : 'The exit code only.'],
        requires: ['A read-only SDDC Manager account for the token (an ADMIN one if the health summary is on).', 'jq, bash 4 and GNU date.'],
        files: {
          [`${base}.sh`]: script,
          'tasks.jq': tasksJq,
          'crontab.txt': `# Hourly, from the directory holding ${base}.sh and tasks.jq.\n# The password file is mode 600 and owned by the account that runs this.\n0 * * * * cd /opt/vcf-automation/${base} && ${scheduledEnv('sddc-manager')} ./${base}.sh\n`,
          'IMPORT.md': sddcImport('Nothing is imported: this reads SDDC Manager on a schedule.', [scheduleStep(`${base}.sh`, base)]),
        },
        notes: [
          'On VCF 9.1 the management components VCF Operations now owns are checked through fleet lifecycle: see "fleet91_lifecycle" and "fleet91_cloud_proxy" in this kit. SDDC Manager still owns its own tasks, which this checks.',
          'The last-backup test reads the task list, because the backup configuration does not report the last run in every release. If your release exposes it directly, use that instead.',
          'A failed task that has since been retried successfully is still reported until it leaves the window. That is on purpose: someone should look at why it failed.',
        ],
        findings,
      };
    },
  }),


  // -------------------------------------------------------------------------
  // VCF 9.1 deprecates the SDDC Manager upgrade prechecks (/v1/system/prechecks)
  // this blueprint used to start. It keeps its id and now builds the fleet
  // lifecycle enhanced precheck (fleet91_lifecycle, part "precheck") for one
  // workload domain, or for chosen hosts in it.
  automationBlueprint({
    id: 'fleet_upgrade_precheck',
    platform: PLATFORM,
    label: 'Enhanced precheck of a workload domain before an upgrade (fleet lifecycle, 9.1)',
    group: 'Lifecycle',
    description:
      'Run the fleet lifecycle enhanced precheck — the 9.1 replacement for the deprecated SDDC Manager upgrade prechecks — against one workload domain of a VCF instance, or selected ESX hosts in it, for a target version. It builds an upgrade plan, runs the precheck, exports the result as JSON and CSV, and lists every component that did not pass. It upgrades nothing.',
    inputs: [
      { id: 'domain', label: 'Workload domain name', control: 'text', default: 'mgmt-domain' },
      { id: 'target_version', label: 'Target VCF version', control: 'text', default: '9.1.1.0', hint: 'Four parts, as the depot names it' },
      {
        id: 'scope',
        label: 'Precheck',
        control: 'select',
        options: [
          { value: 'VCF_INSTANCE', label: 'The whole domain: SDDC Manager, NSX, vCenter and hosts' },
          { value: 'HOSTS', label: 'Selected ESX hosts of the domain' },
        ],
        default: 'VCF_INSTANCE',
      },
      { id: 'hosts', label: 'ESX hosts', control: 'text', default: 'esx05.example.com, esx06.example.com', hint: 'Comma separated FQDNs', showWhen: { input: 'scope', equals: ['HOSTS'] } },
      { id: 'lcm_host', label: 'Fleet lifecycle host', control: 'text', default: 'fleet-lcm.example.com', hint: 'The VCF management services runtime FQDN' },
    ],
    automation: (values                 , name        )             => {
      const lifecycle = VCF_FLEET_91.find((blueprint) => blueprint.id === 'fleet91_lifecycle');
      if (!lifecycle) throw new Error('fleet91_lifecycle is missing');
      const domain = str(values, 'domain', 'mgmt-domain');
      const scope = str(values, 'scope', 'VCF_INSTANCE');
      const inner = lifecycle.automation(
        {
          part: 'precheck',
          scope,
          domain,
          hosts: str(values, 'hosts', ''),
          target_version: str(values, 'target_version', '9.1.1.0'),
          lcm_host: str(values, 'lcm_host', 'fleet-lcm.example.com'),
          backup_hours: 24,
        },
        name || `precheck-${domain}`,
      );
      const findings            = [...(inner.findings ?? [])];
      if (/^mgmt|management/i.test(domain)) findings.push(info('fleet.precheck.management-first', 'The management domain is upgraded first; precheck it before any workload domain.', { source: SRC }));
      return {
        ...inner,
        title: `Enhanced precheck — ${scope === 'HOSTS' ? `hosts of ${domain}` : domain} for ${str(values, 'target_version', '9.1.1.0')}`,
        notes: [
          'VCF 9.1 deprecates the SDDC Manager upgrade prechecks (POST /v1/system/prechecks and /v1/system/check-sets). This runs the fleet lifecycle enhanced precheck instead; fleet91_lifecycle has the same precheck for the management components, and the apply step with its gates.',
          ...(inner.notes ?? []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_host_commission',
    platform: PLATFORM,
    label: 'Commission ESX hosts (SDDC Manager)',
    group: 'Hosts',
    description:
      'Add prepared ESX hosts to SDDC Manager’s inventory so a domain or cluster can use them. It always validates first — validation is the dry run — reads each host’s root password from its own environment variable, and commissions only when every host has passed.',
    inputs: [
      { id: 'hosts', label: 'Hosts', control: 'textarea', default: 'esx05.example.com\nesx06.example.com\nesx07.example.com\nesx08.example.com', hint: 'One FQDN per line. Append :NFS (or another type) to override the storage type for that host' },
      { id: 'storage_type', label: 'Storage type', control: 'select', options: STORAGE_TYPES, default: 'VSAN_ESA' },
      { id: 'network_pool', label: 'Network pool', control: 'text', default: 'wld-01-np01' },
      { id: 'username', label: 'Username', control: 'text', default: 'root' },
    ],
    automation: (values                 , name        )             => {
      const lines = str(values, 'hosts', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const defaultType = str(values, 'storage_type', 'VSAN_ESA');
      const pool = str(values, 'network_pool', '');
      const user = str(values, 'username', 'root');
      const base = slugOf(name || 'commission-hosts', 'commission-hosts');

      const hosts = lines.map((line) => {
        const [fqdn = '', type] = line.split(':').map((part) => part.trim());
        return {
          fqdn,
          storageType: (type || defaultType).toUpperCase(),
          username: user,
          envVar: hostPasswordVar(fqdn),
        };
      });

      const findings            = [];
      if (hosts.length === 0) findings.push(error('fleet.hosts.none', 'No hosts are listed.', { source: SRC }));
      const types = [...new Set(hosts.map((host) => host.storageType))];
      if (types.length > 1) {
        findings.push(
          warning('fleet.hosts.mixed-storage', `This batch mixes storage types: ${types.join(', ')}.`, {
            remediation: 'A cluster takes one principal storage type. Commission each type as its own batch so a host cannot end up in the wrong pool by default.',
            source: SRC,
          }),
        );
      }
      const unknown = types.filter((type) => !STORAGE_TYPES.some((option) => option.value === type));
      if (unknown.length > 0) findings.push(error('fleet.hosts.bad-storage', `Unknown storage type: ${unknown.join(', ')}.`, { source: SRC }));
      const shortNames = hosts.filter((host) => !host.fqdn.includes('.'));
      if (shortNames.length > 0) {
        findings.push(warning('fleet.hosts.not-fqdn', `Not fully qualified: ${shortNames.map((host) => host.fqdn).join(', ')}. SDDC Manager needs forward and reverse DNS for the FQDN.`, { source: SRC }));
      }
      if (types.includes('VSAN') || types.includes('VSAN_ESA')) {
        if (hosts.filter((host) => host.storageType.startsWith('VSAN')).length < 3) {
          findings.push(warning('fleet.hosts.vsan-min', 'Fewer than three vSAN hosts cannot form a new vSAN cluster on their own.', { source: SRC }));
        }
      }

      const specJq = [
        '# The commission spec: hosts.json plus the network pool id and each host’s',
        '# password, read from its own environment variable via $ENV. Never on disk.',
        '[ .[] | { fqdn: .fqdn, username: .username, storageType: .storageType,',
        '          networkPoolId: $pool, networkPoolName: $poolName,',
        '          password: $ENV[.envVar] } ]',
        '',
      ].join('\n');

      const script = [
        '#!/usr/bin/env bash',
        `# Commission ${hosts.length} ESX host(s) into SDDC Manager.`,
        '#',
        '# Always validates first, and commissions only if every host passed. With',
        '# --dry-run it stops after validation: SDDC Manager connects to each host and',
        '# checks it, and nothing is changed.',
        '#',
        '# Each host’s password comes from its own variable, listed in hosts.json.',
        'set -euo pipefail',
        ...authPreamble('sddc-manager'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        ...apiHelper(),
        '',
        'MISSING=()',
        '# Exported so jq can read each one through $ENV; never passed as an argument.',
        'for v in $(jq -r \'.[].envVar\' hosts.json); do if [[ -n "${!v:-}" ]]; then export "$v"; else MISSING+=("$v"); fi; done',
        'if (( ${#MISSING[@]} > 0 )); then',
        '  printf "Set from your vault: %s\\n" "${MISSING[@]}" >&2',
        '  exit 2',
        'fi',
        '',
        ...lifecycleGuard(),
        '',
        `POOL_NAME='${pool}'`,
        'POOL_ID=$(api GET /v1/network-pools | jq -r --arg n "$POOL_NAME" \'.elements[]? | select(.name == $n) | .id\')',
        '[[ -n "$POOL_ID" ]] || { echo "No network pool named ${POOL_NAME}" >&2; exit 2; }',
        '',
        'SPEC=$(jq --arg pool "$POOL_ID" --arg poolName "$POOL_NAME" -f spec.jq hosts.json)',
        '',
        '# 1. Validate. Not optional: commissioning an unvalidated host is how a host',
        '#    with the wrong VLAN or an old build ends up in the free pool.',
        'VAL=$(echo "$SPEC" | api POST /v1/hosts/validations --data @- | jq -r .id)',
        'echo "validation ${VAL}"',
        'for _ in $(seq 1 60); do',
        '  RES=$(api GET "/v1/hosts/validations/${VAL}")',
        '  [[ "$(echo "$RES" | jq -r \'.executionStatus // ""\')" == "COMPLETED" ]] && break',
        '  sleep 10',
        'done',
        'echo "$RES" | jq -r \'.validationChecks[]? | "  \\(.resultStatus)  \\(.description)"\'',
        'if [[ "$(echo "$RES" | jq -r \'.resultStatus // ""\')" != "SUCCEEDED" ]]; then',
        '  echo "Validation did not succeed. Nothing was commissioned." >&2',
        '  exit 1',
        'fi',
        '',
        'if (( DRY_RUN )); then',
        '  echo "DRY RUN: validation passed. Nothing was changed. Run it without --dry-run to commission."',
        '  exit 0',
        'fi',
        '',
        '# 2. Commission.',
        'TASK=$(echo "$SPEC" | api POST /v1/hosts --data @- | jq -r .id)',
        'echo "commission task ${TASK}"',
        'for _ in $(seq 1 120); do',
        '  STATUS=$(api GET "/v1/tasks/${TASK}" | jq -r \'.status // "UNKNOWN"\' | tr a-z A-Z)',
        '  echo "  ${STATUS}"',
        '  [[ "$STATUS" =~ SUCCESSFUL|FAILED ]] && break',
        '  sleep 20',
        'done',
        '[[ "$STATUS" == "SUCCESSFUL" ]] || { echo "Commissioning did not succeed; see task ${TASK}." >&2; exit 1; }',
        'echo "Commissioned. The hosts are now in the free pool, unassigned."',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Commission ${hosts.length} ESX host${hosts.length === 1 ? '' : 's'} (${types.join(', ') || defaultType}) into ${pool}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Run by hand when hosts have been racked, imaged and given DNS.', worstCase: 'once per batch' },
        scope: {
          what: `Exactly the hosts listed: ${hosts.map((host) => host.fqdn).join(', ') || 'none'}.`,
          decidedBy: ['hosts.json, written from the list in this blueprint.', `Network pool ${pool}, resolved to its id at run time.`],
          ifWrong: 'A host that belongs to something else is taken into SDDC Manager’s inventory. It is not reimaged or joined to a cluster, but SDDC Manager now believes it owns it — decommission it before anyone builds on it.',
        },
        guardrails: [
          { rule: 'Always validates, and commissions only if every host passed', because: 'Validation catches the wrong VLAN, a bad password, an unsupported build — before the host is in the pool.' },
          { rule: 'One password variable per host, all present before anything is sent', because: 'A shared root password across hosts is one leak away from all of them, and a missing one should stop the run at the start.' },
          { rule: 'Refuses while another task is running', because: 'Commissioning during a domain operation competes for the network pool’s addresses.' },
        ],
        dryRun: ['Run with --dry-run. It validates every host with SDDC Manager and stops there.'],
        undo: [
          'Decommission: DELETE /v1/hosts with a body listing each FQDN (verify the shape for your release), or Hosts > Decommission in SDDC Manager.',
          'A decommissioned host has to be reimaged before it is commissioned again.',
        ],
        told: ['SDDC Manager records the validation and the commission task. Nothing else is told.'],
        requires: [
          'Each host imaged at a supported ESX build, with forward and reverse DNS, NTP, and SSH enabled.',
          `The network pool ${pool} with free addresses for vMotion and storage for every host.`,
          ...hosts.map((host) => `${host.envVar} set to ${host.fqdn}’s ${user} password, from your vault.`),
        ],
        files: {
          [`${base}.sh`]: script,
          'hosts.json': `${JSON.stringify(hosts, null, 2)}\n`,
          'spec.jq': specJq,
          'IMPORT.md': sddcImport(
            'hosts.json lists the hosts without passwords; spec.jq turns it into exactly the HostCommissionSpec array POST /v1/hosts and POST /v1/hosts/validations take (fqdn, username, password, storageType, networkPoolId, networkPoolName), each password read from the variable named in hosts.json.',
            [
              { heading: 'Validate', lines: [`Export each host’s password variable (${hosts.map((host) => host.envVar).join(', ')}), then \`./${base}.sh\`: it resolves the network pool id and runs POST /v1/hosts/validations.`] },
              { heading: 'Commission', lines: [`\`./${base}.sh\` (add \`--dry-run\` first to validate only) sends the same body to POST /v1/hosts and follows the task. In the interface: Inventory > Hosts > Commission Hosts, which also accepts a JSON file of the same host list.`] },
            ],
            ['The interface’s Commission Hosts JSON import uses its own template (downloadable from that dialog); the file to upload there is not hosts.json — VERIFY its fields against the template before using that route.'],
          ),
        },
        notes: [
          'VCF 9.1 has no fleet-management equivalent for commissioning: hosts are still commissioned through SDDC Manager, as here. The fleet-level jobs that moved to VCF Operations are the "fleet91_" blueprints in this kit.',
          'The storageType values follow the SDDC Manager HostCommissionSpec. VSAN_ESA is how recent releases name ESA; some take VSAN with a separate ESA flag instead. Verify against your release.',
          'Commissioning does not put a host in a cluster. It makes it available; adding it to a cluster or a new domain is a separate operation.',
        ],
        findings,
      };
    },
  }),
  // Building the instance out: workload domains, clusters, network pools, hosts,
  // VCF Import and Avi Load Balancer controllers (vcf-fleet-91-domains.ts).
  ...VCF_FLEET_91_DOMAINS,
];
