/**
 * VCF fleet operations: the SDDC Manager jobs that keep an instance alive.
 *
 * Rotating passwords, watching certificates, checking the manager itself,
 * configuring its backup, prechecking an upgrade and commissioning hosts. None
 * of them are interesting until one is missed — a certificate expires on a
 * Saturday, a password rotation fails half way and leaves NSX locked, a backup
 * target has been full since March — and then each of them is the incident.
 *
 * Every script here talks to the SDDC Manager API at /v1 with a bearer token
 * from POST /v1/tokens, reads first, and acts only with --execute. Where the
 * exact body shape moves between releases the file says so rather than
 * guessing quietly: check it against the API reference for the release in
 * front of you.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { authHeader, authPreamble, readScript, scheduledEnv } from '../apply.js';

const PLATFORM = 'vcf-fleet'         ;
const SRC = 'ArchToolKit';

/** The call helper every acting script here opens with. */
function apiHelper()           {
  return [
    'api() {',
    '  local method="$1" path="$2"; shift 2',
    '  curl -sS -f -X "$method" "https://${SDDC_HOST}${path}" \\',
    `    -H "${authHeader('sddc-manager')}" \\`,
    '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
  ];
}

/** Posts the PROBLEMS array to a webhook, never failing the script on the way. */
function notify(webhook        , source        )           {
  if (!webhook) return [];
  return [`curl -sS -X POST "${webhook}" -H "Content-Type: application/json" --data "$(printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "${source}", problems: .}')" || true`];
}

/** The two checks every acting fleet script makes before it touches anything. */
function lifecycleGuard()           {
  return [
    '# Guardrail: nothing else is running. Rotating, commissioning or replacing',
    '# while an upgrade or a workload domain operation is in flight is how a',
    '# resource ends up locked in SDDC Manager with no clean way to release it.',
    'BUSY=$(api GET /v1/tasks | jq \'[.elements[]? | select((.status // "" | ascii_upcase) | test("IN_PROGRESS|IN PROGRESS|PENDING"))] | length\')',
    'if (( BUSY > 0 )); then',
    '  echo "Refusing: ${BUSY} SDDC Manager task(s) in progress. Wait for them to finish." >&2',
    '  exit 1',
    'fi',
  ];
}

const RESOURCE_TYPES = [
  { value: 'ESXI', label: 'ESXi hosts' },
  { value: 'VCENTER', label: 'vCenter' },
  { value: 'NSXT_MANAGER', label: 'NSX Manager' },
  { value: 'NSXT_EDGE', label: 'NSX Edge' },
  { value: 'BACKUP', label: 'Backup (SFTP) account' },
];

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
    id: 'fleet_password_rotation',
    platform: PLATFORM,
    label: 'Rotate managed passwords',
    group: 'Credentials',
    description:
      'Rotate the passwords SDDC Manager holds for one kind of resource — ESXi root, vCenter, NSX — and optionally set the policy that rotates them on a schedule. It refuses to start while another task is running or a previous rotation has failed, because a rotation that fails half way leaves the resource and SDDC Manager disagreeing about the password, and that is the state you least want to add to.',
    inputs: [
      { id: 'resource_type', label: 'Resource type', control: 'select', options: RESOURCE_TYPES, default: 'ESXI', hint: 'One type per run' },
      {
        id: 'account_type',
        label: 'Account type',
        control: 'select',
        options: [
          { value: 'USER', label: 'User accounts (root, admin)' },
          { value: 'SYSTEM', label: 'System accounts' },
          { value: 'SERVICE', label: 'Service accounts' },
        ],
        default: 'USER',
      },
      { id: 'domains', label: 'Workload domains', control: 'text', default: 'wld-01', hint: 'Comma separated. Empty means every domain' },
      { id: 'usernames', label: 'Usernames', control: 'text', default: 'root', hint: 'Empty means every account of that type' },
      { id: 'max_resources', label: 'Refuse above (accounts)', control: 'number', default: 16, min: 1, max: 500 },
      { id: 'auto_rotate', label: 'Also set an auto-rotate policy', control: 'toggle', default: true },
      { id: 'auto_rotate_days', label: 'Rotate every (days)', control: 'number', default: 90, min: 1, max: 365, showWhen: { input: 'auto_rotate', equals: ['true'] } },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-credentials' },
    ],
    automation: (values                 , name        )             => {
      const type = str(values, 'resource_type', 'ESXI');
      const account = str(values, 'account_type', 'USER');
      const domains = listOf(str(values, 'domains', ''));
      const users = listOf(str(values, 'usernames', ''));
      const max = num(values, 'max_resources', 16);
      const auto = bool(values, 'auto_rotate', false);
      const days = num(values, 'auto_rotate_days', 90);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || `rotate-${type}`, 'rotate');
      const typeLabel = RESOURCE_TYPES.find((option) => option.value === type)?.label ?? type;

      const findings            = [];
      if (type === 'ESXI' && domains.length === 0) {
        findings.push(
          warning('fleet.rotate.every-esxi', 'This rotates ESXi passwords in every workload domain in one run.', {
            remediation: 'Do one domain first, management last. If the run fails part way, you want the damage to be one domain’s hosts, not the fleet’s.',
            source: SRC,
          }),
        );
      }
      if (auto && days < 30) {
        findings.push(
          warning('fleet.rotate.too-often', `Auto-rotating every ${days} days means a rotation is always recent, and anything that caches the password breaks on that cycle.`, {
            remediation: 'Thirty to ninety days is the usual range. Rotate more often only if every consumer of the password reads it from SDDC Manager or a vault.',
            source: SRC,
          }),
        );
      }
      if (account === 'SERVICE') {
        findings.push(
          info('fleet.rotate.service', 'Service accounts are the ones SDDC Manager uses to talk to the components. Rotating them is supported, but a failure breaks management rather than a login.', { source: SRC }),
        );
      }

      const selectJq = [
        '# Which accounts this run rotates. Read by rotate.sh with jq -f.',
        '[ .elements[]?',
        '  | select(($domains | length) == 0 or ((.resource.domainName // "") as $d | $domains | index($d)))',
        '  | select(($users | length) == 0 or (.username as $u | $users | index($u)))',
        ']',
        '',
      ].join('\n');

      const bodyJq = [
        '# Group the selected accounts by resource into one PATCH /v1/credentials body.',
        '# Shape per the SDDC Manager API: operationType plus one element per',
        '# resource, each listing the accounts to rotate. Verify against your release.',
        '{',
        '  operationType: $op,',
        '  elements: [ group_by(.resource.resourceName)[]',
        '    | { resourceName: .[0].resource.resourceName,',
        '        resourceType: .[0].resource.resourceType,',
        '        credentials: [ .[] | { credentialType: .credentialType, username: .username } ] } ]',
        '}',
        '| if $days > 0 then . + { autoRotatePolicy: { frequencyInDays: $days, enableAutoRotatePolicy: true } } else . end',
        '',
      ].join('\n');

      const rotate = [
        '#!/usr/bin/env bash',
        `# Rotate ${typeLabel} ${account} passwords held by SDDC Manager.`,
        '#',
        '# Without --execute it lists the accounts it would rotate and writes the body',
        '# it would send. Nothing is rotated until you pass --execute.',
        '#   ./rotate.sh              dry run',
        '#   ./rotate.sh --execute    rotate now',
        ...(auto ? ['#   ./rotate.sh --execute --policy   set the auto-rotate policy instead of rotating'] : []),
        'set -euo pipefail',
        ...authPreamble('sddc-manager'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        'DRY_RUN=1; MODE=ROTATE',
        'for arg in "$@"; do',
        '  [[ "$arg" == "--execute" ]] && DRY_RUN=0',
        ...(auto ? ['  [[ "$arg" == "--policy" ]] && MODE=UPDATE_AUTO_ROTATE_POLICY'] : []),
        'done',
        `MAX=${max}`,
        `POLICY_DAYS=${auto ? days : 0}`,
        'PROBLEMS=()',
        '',
        ...apiHelper(),
        '',
        '# Guardrail: no earlier credential operation has failed. A failed rotation',
        '# leaves resources locked; remediate it (operationType REMEDIATE) first.',
        'FAILED=$(api GET /v1/credentials/tasks | jq \'[.elements[]? | select((.status // "" | ascii_upcase) == "FAILED")] | length\')',
        'if (( FAILED > 0 )); then',
        '  echo "Refusing: ${FAILED} failed credential task(s) in SDDC Manager. Resolve them first." >&2',
        '  exit 1',
        'fi',
        '',
        ...lifecycleGuard(),
        '',
        `api GET "/v1/credentials?resourceType=${type}&accountType=${account}" \\`,
        `  | jq --argjson domains '${JSON.stringify(domains)}' --argjson users '${JSON.stringify(users)}' -f select.jq > selected.json`,
        'COUNT=$(jq length selected.json)',
        'echo "Selected ${COUNT} account(s):"',
        'jq -r \'.[] | "  \\(.resource.domainName // "-")  \\(.resource.resourceName)  \\(.username)"\' selected.json',
        '',
        'if (( COUNT == 0 )); then echo "Nothing matched. Check the domain and username filters."; exit 0; fi',
        'if (( COUNT > MAX )); then',
        '  echo "Refusing: ${COUNT} accounts is more than the cap of ${MAX}. Narrow the scope or raise the cap on purpose." >&2',
        '  exit 1',
        'fi',
        '',
        'DAYS=0; [[ "$MODE" == "UPDATE_AUTO_ROTATE_POLICY" ]] && DAYS=$POLICY_DAYS',
        'jq --arg op "$MODE" --argjson days "$DAYS" -f body.jq selected.json > request-body.json',
        '',
        'if (( DRY_RUN )); then',
        '  echo "DRY RUN: would PATCH /v1/credentials with request-body.json (operationType ${MODE})."',
        '  echo "Nothing was changed. Read request-body.json, then re-run with --execute."',
        '  exit 0',
        'fi',
        '',
        'TASK=$(api PATCH /v1/credentials --data @request-body.json | jq -r .id)',
        'echo "Credential task ${TASK}"',
        'for _ in $(seq 1 120); do',
        '  STATUS=$(api GET "/v1/credentials/tasks/${TASK}" | jq -r \'.status // "UNKNOWN"\')',
        '  echo "  ${STATUS}"',
        '  case "${STATUS^^}" in',
        '    SUCCESSFUL|SUCCEEDED|COMPLETED) break ;;',
        '    FAILED) PROBLEMS+=("credential task ${TASK} failed — resources may be locked; remediate before anything else"); break ;;',
        '  esac',
        '  sleep 15',
        'done',
        '',
        'if (( ${#PROBLEMS[@]} > 0 )); then',
        '  printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...notify(webhook, 'vcf-credential-rotation').map((line) => `  ${line}`),
        '  exit 1',
        'fi',
        `echo "Done. ${typeLabel} ${account} passwords ${auto ? 'rotated, or policy set,' : 'rotated'} — task ${'$'}{TASK}."`,
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Rotate ${typeLabel} ${account.toLowerCase()} passwords${domains.length ? ` in ${domains.join(', ')}` : ' across the fleet'}`,
        effect: 'reversible',
        trigger: {
          kind: auto ? 'schedule' : 'manual',
          detail: auto
            ? `Run by hand to rotate now; the auto-rotate policy then rotates every ${days} days inside SDDC Manager.`
            : 'Run by hand, in a change window, one resource type at a time.',
          worstCase: auto ? `every ${days} days per account, for as long as the policy stays set` : 'once per run',
        },
        scope: {
          what: `${typeLabel} ${account} accounts that SDDC Manager manages${domains.length ? ` in ${domains.join(', ')}` : ', in every workload domain'}${users.length ? `, named ${users.join(', ')}` : ''}.`,
          decidedBy: [
            `GET /v1/credentials?resourceType=${type}&accountType=${account}.`,
            domains.length ? `Filtered to domain ${domains.join(', ')}.` : 'No domain filter — every domain.',
            users.length ? `Filtered to username ${users.join(', ')}.` : 'No username filter — every account of that type.',
            `Refused outright above ${max} accounts.`,
          ],
          ifWrong: 'Passwords rotate on resources someone still logs into with the old one, or that an external tool — a backup product, a monitoring collector — authenticates with. Nothing goes down, but those logins start failing.',
        },
        guardrails: [
          { rule: 'One resource type per run', because: 'A mixed run that fails part way is much harder to reason about than a failed run of one type.' },
          { rule: 'Refuses while any SDDC Manager task is in progress', because: 'Rotation during an upgrade or a domain operation competes for the same resource locks.' },
          { rule: 'Refuses while any earlier credential task has failed', because: 'A failed rotation leaves resources locked. Adding a second one on top buries the first.' },
          { rule: `Refuses above ${max} accounts`, because: 'A filter that went wrong should stop, not rotate the fleet.' },
        ],
        dryRun: ['Run rotate.sh without --execute. It lists every account and writes request-body.json, and sends nothing.'],
        undo: [
          'A rotation cannot be undone: the old password is gone.',
          'SDDC Manager holds the new one. Retrieve it with GET /v1/credentials?resourceName=<name> as an ADMIN, or lookup_passwords on the appliance.',
          'To put a known value back, PATCH /v1/credentials with operationType UPDATE and the password read from your vault — never typed into a file.',
          ...(auto ? ['To stop scheduled rotation, run the same selection with UPDATE_AUTO_ROTATE_POLICY and enableAutoRotatePolicy false.'] : []),
        ],
        told: [webhook ? `${webhook}, when a rotation task fails.` : 'The exit code only.', 'SDDC Manager records the task under Credentials > Password Management.'],
        requires: ['An SDDC Manager account with the ADMIN role for the token.', 'jq and bash 4 on the machine running it.'],
        files: { 'rotate.sh': rotate, 'select.jq': selectJq, 'body.jq': bodyJq },
        notes: [
          'The UPDATE_AUTO_ROTATE_POLICY operation type and the autoRotatePolicy block are the shape in recent releases. Verify both against the API reference for your release before running --policy.',
          'Anything outside VCF that uses these passwords — backup products, monitoring, scripts — should read them from SDDC Manager or a vault. If they are typed into those tools, rotation breaks them.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_certificate_check',
    platform: PLATFORM,
    label: 'Report certificates about to expire',
    group: 'Certificates',
    description:
      'Walk every workload domain, read the certificates of every resource in it, and report the ones expiring inside the window. It exits non-zero when any are found, so a scheduler can page. A replacement plan comes with it — CSR generation and installation — as a separate script that does nothing unless told to.',
    inputs: [
      { id: 'within_days', label: 'Report certificates expiring within (days)', control: 'number', default: 45, min: 1, max: 730 },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-certificates' },
      { id: 'org', label: 'CSR organisation', control: 'text', default: 'Example Ltd' },
      { id: 'org_unit', label: 'CSR organisational unit', control: 'text', default: 'Infrastructure' },
      { id: 'locality', label: 'CSR locality', control: 'text', default: 'London' },
      { id: 'state', label: 'CSR state', control: 'text', default: 'London' },
      { id: 'country', label: 'CSR country', control: 'text', default: 'GB', hint: 'Two letters' },
      { id: 'email', label: 'CSR email', control: 'text', default: 'pki@example.com' },
      { id: 'key_size', label: 'Key size', control: 'select', options: [{ value: '2048', label: '2048' }, { value: '3072', label: '3072' }, { value: '4096', label: '4096' }], default: '3072' },
    ],
    automation: (values                 , name        )             => {
      const within = num(values, 'within_days', 45);
      const webhook = str(values, 'webhook', '');
      const country = str(values, 'country', 'GB');
      const base = slugOf(name || 'certificate-check', 'certificate-check');

      const findings            = [];
      if (within < 21) {
        findings.push(
          warning('fleet.cert.short-window', `${within} days is less time than most enterprise CAs take to sign a request.`, {
            remediation: 'Report at 45 days at least. The replacement is quick; getting the CSR signed is not.',
            source: SRC,
          }),
        );
      }
      if (!/^[A-Za-z]{2}$/.test(country)) {
        findings.push(error('fleet.cert.country', `The CSR country "${country}" is not a two-letter code, and the CSR generation will be rejected.`, { source: SRC }));
      }

      const expiringJq = [
        '# Certificates expiring inside the window. Read by the check with jq -f.',
        '# Field names vary by release: numberOfDaysToExpire where present, otherwise',
        '# expirationDate or notAfter parsed as ISO 8601. Verify against your release.',
        'def days_left:',
        '  if .numberOfDaysToExpire != null then .numberOfDaysToExpire',
        '  else ((.expirationDate // .notAfter // "") | sub("\\\\.[0-9]+"; "") | sub("\\\\+00:00$"; "Z")',
        '        | (try fromdateiso8601 catch null)) as $t',
        '       | if $t == null then null else (($t - $now) / 86400 | floor) end',
        '  end;',
        '[ .elements[]? | { resource: (.issuedTo // .resourceFqdn // .resourceName // "unknown"), days: days_left }',
        '  | select(.days == null or .days <= $within) ]',
        '',
      ].join('\n');

      const check = readScript('sddc-manager', `Which VCF certificates expire within ${within} days?`, [
        `WITHIN=${within}`,
        'NOW=$(date +%s)',
        'PROBLEMS=()',
        '',
        'while IFS=$\'\\t\' read -r DOMAIN_ID DOMAIN_NAME; do',
        '  while IFS=$\'\\t\' read -r RES DAYS; do',
        '    if [[ "$DAYS" == "null" ]]; then',
        '      PROBLEMS+=("${DOMAIN_NAME}: ${RES} — expiry date could not be read")',
        '    else',
        '      PROBLEMS+=("${DOMAIN_NAME}: ${RES} expires in ${DAYS} days")',
        '    fi',
        '  done < <(get "/v1/domains/${DOMAIN_ID}/resource-certificates" \\',
        '           | jq -r --argjson now "$NOW" --argjson within "$WITHIN" -f expiring.jq \\',
        '           | jq -r \'.[] | [.resource, (.days|tostring)] | @tsv\')',
        'done < <(get /v1/domains | jq -r \'.elements[]? | [.id, .name] | @tsv\')',
        '',
        'if (( ${#PROBLEMS[@]} == 0 )); then',
        `  echo "No certificate expires within ${within} days."`,
        '  exit 0',
        'fi',
        'printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...notify(webhook, 'vcf-certificates'),
        'exit 1',
      ]);

      const csrSpec = {
        csrGenerationSpec: {
          country,
          email: str(values, 'email', ''),
          keyAlgorithm: 'RSA',
          keySize: str(values, 'key_size', '3072'),
          locality: str(values, 'locality', ''),
          organization: str(values, 'org', ''),
          organizationUnit: str(values, 'org_unit', ''),
          state: str(values, 'state', ''),
        },
        resources: [{ fqdn: '<REQUIRED — resource FQDN from the check>', type: '<REQUIRED — VCENTER, NSXT_MANAGER, SDDC_MANAGER, ...>' }],
      };

      const install = [{ resourceFqdn: '<REQUIRED — resource FQDN>', certificateChain: '<REQUIRED — PEM: leaf, then intermediates, then root>' }];

      const plan = [
        '#!/usr/bin/env bash',
        '# CERTIFICATE REPLACEMENT PLAN — separate from the check, and it acts.',
        '#',
        '#   ./replace-plan.sh csrs <domain-id>              dry run: show the CSR request',
        '#   ./replace-plan.sh csrs <domain-id> --execute    PUT /v1/domains/{id}/csrs',
        '#   ./replace-plan.sh install <domain-id>           dry run: show the install body',
        '#   ./replace-plan.sh install <domain-id> --execute PATCH /v1/domains/{id}/resource-certificates',
        '#',
        '# Between the two: fetch the CSRs (GET /v1/domains/{id}/csrs), have them',
        '# signed by your CA, and put the chains into install-certificates.json.',
        '# Paths and bodies are the documented shape; verify against your release.',
        'set -euo pipefail',
        ...authPreamble('sddc-manager'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        'STEP="${1:?csrs or install}"; DOMAIN="${2:?workload domain id}"',
        'DRY_RUN=1; [[ "${3:-}" == "--execute" ]] && DRY_RUN=0',
        '',
        ...apiHelper(),
        '',
        'case "$STEP" in',
        '  csrs)    METHOD=PUT;   PATH_="/v1/domains/${DOMAIN}/csrs";                  FILE=csr-request.json ;;',
        '  install) METHOD=PATCH; PATH_="/v1/domains/${DOMAIN}/resource-certificates"; FILE=install-certificates.json ;;',
        '  *) echo "unknown step $STEP" >&2; exit 2 ;;',
        'esac',
        '',
        'if grep -q "<REQUIRED" "$FILE"; then',
        '  echo "$FILE still has <REQUIRED> placeholders. Fill them from the check output first." >&2',
        '  (( DRY_RUN )) || exit 1',
        'fi',
        '',
        'if (( DRY_RUN )); then',
        '  echo "DRY RUN: would ${METHOD} ${FILE} to ${PATH_}"',
        '  jq . "$FILE"',
        '  exit 0',
        'fi',
        '',
        ...lifecycleGuard(),
        '',
        'TASK=$(api "$METHOD" "$PATH_" --data @"$FILE" | jq -r \'.id // empty\')',
        'echo "Task ${TASK:-none returned} — follow it under Tasks in SDDC Manager. Services restart during install."',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Report VCF certificates expiring within ${within} days`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Daily, from a scheduler outside SDDC Manager', worstCase: 'once a day, for every certificate inside the window, until it is replaced' },
        scope: {
          what: 'Every resource certificate SDDC Manager knows about, in every workload domain. The check reads; the replacement plan is a separate script run by hand.',
          decidedBy: ['GET /v1/domains — every domain this SDDC Manager manages.', 'GET /v1/domains/{id}/resource-certificates for each.', `Kept when it expires within ${within} days, or its date cannot be read.`],
          ifWrong: 'A certificate outside what SDDC Manager manages — a load balancer, a proxy — is not seen here at all. Check those separately.',
        },
        guardrails: [
          { rule: 'The check never replaces anything', because: 'A certificate replacement restarts services. It belongs in a change window, not on a timer.' },
          { rule: 'The replacement plan is dry-run by default, refuses placeholders, and refuses while another task runs', because: 'A half-filled install body or an overlapping task leaves a component with the wrong certificate and no one watching.' },
        ],
        dryRun: [
          'The check only reads. Run it once by hand and compare against Security > Certificate Management in SDDC Manager.',
          'replace-plan.sh prints what it would send unless given --execute.',
        ],
        undo: [
          'The check changes nothing.',
          'A replaced certificate can be put back only if you kept the previous chain and key. Export them before running the install step.',
        ],
        told: [webhook ? `${webhook}, whenever anything is inside the window.` : 'The exit code only.'],
        requires: ['A read-only SDDC Manager account for the check; an ADMIN one for the replacement plan.', 'jq and bash 4.', 'For replacement: a CA that will sign the CSRs, or a Microsoft CA configured in SDDC Manager.'],
        files: {
          [`${base}.sh`]: check,
          'expiring.jq': expiringJq,
          'replace-plan.sh': plan,
          'csr-request.json': `${JSON.stringify(csrSpec, null, 2)}\n`,
          'install-certificates.json': `${JSON.stringify(install, null, 2)}\n`,
          'crontab.txt': `# Daily at 07:00, from the directory holding ${base}.sh and expiring.jq.\n# The password file is mode 600 and owned by the account that runs this.\n0 7 * * * cd /opt/archtoolkit/${base} && ${scheduledEnv('sddc-manager')} ./${base}.sh\n`,
        },
        notes: [
          'The resource-certificates response has named its expiry field differently across releases. expiring.jq tries numberOfDaysToExpire, expirationDate and notAfter; an entry it cannot read is reported rather than ignored.',
          'The ESXi host certificates are managed by vCenter, not by this API in most releases. Check them from vCenter as well.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_health',
    platform: PLATFORM,
    label: 'Check SDDC Manager health',
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
        files: { [`${base}.sh`]: script, 'tasks.jq': tasksJq, 'crontab.txt': `# Hourly, from the directory holding ${base}.sh and tasks.jq.\n# The password file is mode 600 and owned by the account that runs this.\n0 * * * * cd /opt/archtoolkit/${base} && ${scheduledEnv('sddc-manager')} ./${base}.sh\n` },
        notes: [
          'The last-backup test reads the task list, because the backup configuration does not report the last run in every release. If your release exposes it directly, use that instead.',
          'A failed task that has since been retried successfully is still reported until it leaves the window. That is on purpose: someone should look at why it failed.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_backup_config',
    platform: PLATFORM,
    label: 'Configure SDDC Manager backup to SFTP',
    group: 'Backup',
    description:
      'Point SDDC Manager — and the NSX managers it registers — at an SFTP server, with a schedule, a retention and an encryption passphrase. Credentials come from the environment at apply time, the server’s host key is pinned by fingerprint, and the current configuration is saved first so it can be put back.',
    inputs: [
      { id: 'server', label: 'SFTP server', control: 'text', default: 'sftp.example.com' },
      { id: 'port', label: 'Port', control: 'number', default: 22, min: 1, max: 65535 },
      { id: 'directory', label: 'Directory', control: 'text', default: '/backups/vcf/sddc-manager' },
      { id: 'username', label: 'SFTP user', control: 'text', default: 'svc-vcf-backup' },
      { id: 'fingerprint', label: 'SSH host key fingerprint', control: 'text', default: '', hint: 'ssh-keygen -lf of the server key, SHA256:...' },
      { id: 'frequency', label: 'Frequency', control: 'select', options: [{ value: 'WEEKLY', label: 'Daily or weekly, on chosen days' }, { value: 'HOURLY', label: 'Hourly' }], default: 'WEEKLY' },
      { id: 'days', label: 'On days', control: 'text', default: 'MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY', showWhen: { input: 'frequency', equals: ['WEEKLY'] } },
      { id: 'hour', label: 'At hour', control: 'number', default: 2, min: 0, max: 23, showWhen: { input: 'frequency', equals: ['WEEKLY'] } },
      { id: 'minute', label: 'At minute', control: 'number', default: 0, min: 0, max: 59 },
      { id: 'on_state_change', label: 'Also back up on every state change', control: 'toggle', default: true },
      { id: 'retain_recent', label: 'Keep most recent backups', control: 'number', default: 10, min: 1, max: 600 },
      { id: 'retain_daily_days', label: 'Keep one per day for (days)', control: 'number', default: 14, min: 0, max: 600 },
    ],
    automation: (values                 , name        )             => {
      const server = str(values, 'server', '');
      const port = num(values, 'port', 22);
      const directory = str(values, 'directory', '/backups');
      const user = str(values, 'username', '');
      const fingerprint = str(values, 'fingerprint', '');
      const frequency = str(values, 'frequency', 'WEEKLY');
      const days = listOf(str(values, 'days', '')).map((day) => day.toUpperCase());
      const hour = num(values, 'hour', 2);
      const minute = num(values, 'minute', 0);
      const onChange = bool(values, 'on_state_change', true);
      const recent = num(values, 'retain_recent', 10);
      const dailyDays = num(values, 'retain_daily_days', 14);
      const base = slugOf(name || 'sddc-backup', 'sddc-backup');

      const findings            = [];
      if (!fingerprint) {
        findings.push(
          warning('fleet.backup.no-fingerprint', 'No host key fingerprint is given, so apply.sh will read it from the server with ssh-keyscan and trust whatever answers.', {
            remediation: 'Get the fingerprint from the SFTP server’s own console (ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub) and put it here. Pinning it is what stops a backup going to the wrong server.',
            source: SRC,
          }),
        );
      }
      // Days of history kept: the daily retention, or however long the most
      // recent N backups span at this schedule, whichever is longer.
      const spanOfRecent = frequency === 'HOURLY' ? recent / 24 : (recent * 7) / Math.max(days.length, 1);
      const effectiveDays = Math.floor(Math.max(dailyDays, spanOfRecent));
      if (effectiveDays < 7) {
        findings.push(
          warning('fleet.backup.short-retention', `Retention covers about ${effectiveDays} days of backups.`, {
            remediation: 'Keep at least seven days. A corruption found on Monday that started the Friday before needs a backup from Thursday.',
            source: SRC,
          }),
        );
      }
      if (frequency === 'WEEKLY' && days.length === 0) {
        findings.push(error('fleet.backup.no-days', 'A weekly schedule with no days never runs.', { source: SRC }));
      }
      const badDays = days.filter((day) => !['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].includes(day));
      if (badDays.length > 0) {
        findings.push(error('fleet.backup.bad-day', `Not a day SDDC Manager accepts: ${badDays.join(', ')}.`, { source: SRC }));
      }

      const payload = {
        backupLocations: [
          {
            server,
            port,
            protocol: 'SFTP',
            directoryPath: directory,
            username: user,
            password: '<REQUIRED — injected from SFTP_PASSWORD at apply time>',
            sshFingerprint: fingerprint || '<REQUIRED — injected by apply.sh; see README>',
          },
        ],
        backupSchedules: [
          {
            resourceType: 'SDDC_MANAGER',
            frequency,
            ...(frequency === 'WEEKLY' ? { daysOfWeek: days, hourOfDay: hour } : {}),
            minuteOfHour: minute,
            takeScheduledBackups: true,
            takeBackupOnStateChange: onChange,
            retentionPolicy: {
              numberOfMostRecentBackups: recent,
              numberOfDaysOfDailyBackups: dailyDays,
              numberOfDaysOfHourlyBackups: frequency === 'HOURLY' ? 1 : 0,
            },
          },
        ],
        encryption: { passphrase: '<REQUIRED — injected from BACKUP_PASSPHRASE at apply time>' },
      };

      const apply = [
        '#!/usr/bin/env bash',
        '# Configure SDDC Manager backup to SFTP.',
        '#',
        '# The SFTP password and the encryption passphrase are read from the',
        '# environment and merged into the request in memory; neither is written to',
        '# disk. Without --execute it prints the request with both masked.',
        'set -euo pipefail',
        ...authPreamble('sddc-manager'),
        ': "${SFTP_PASSWORD:?set SFTP_PASSWORD from your vault}"',
        ': "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE from your vault — without it the backups cannot be restored}"',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        'DRY_RUN=1; [[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
        ...apiHelper(),
        '',
        ...(fingerprint
          ? [`FP='${fingerprint}'`]
          : [
              '# No fingerprint was given. This reads it from the server, which trusts',
              '# whatever answers on the network right now. Compare it by hand.',
              `FP=$(ssh-keyscan -p ${port} -t rsa ${server} 2>/dev/null | ssh-keygen -lf - | awk '{print $2}')`,
              'echo "Server presented ${FP}. Confirm this on the server console before --execute."',
            ]),
        '',
        '# Save what is configured now, so it can be put back.',
        'api GET /v1/system/backup-configuration > previous-backup-configuration.json || true',
        '',
        '# The secrets are read by jq from its environment ($ENV), not passed as',
        '# arguments, so they never appear in a process list.',
        'export SFTP_PASSWORD BACKUP_PASSPHRASE',
        `REQUEST=$(jq --arg fp "$FP" '.backupLocations[0].sshFingerprint = $fp | .backupLocations[0].password = $ENV.SFTP_PASSWORD | .encryption.passphrase = $ENV.BACKUP_PASSPHRASE' ${base}.json)`,
        '',
        'if (( DRY_RUN )); then',
        '  echo "DRY RUN: would PUT /v1/system/backup-configuration with (password and passphrase left out):"',
        "  echo \"$REQUEST\" | jq 'del(.backupLocations[0].password, .encryption.passphrase)'",
        '  echo "Nothing was changed. Re-run with --execute."',
        '  exit 0',
        'fi',
        '',
        ...lifecycleGuard(),
        '',
        'echo "$REQUEST" | api PUT /v1/system/backup-configuration --data @- | jq -r \'"task: \\(.id // "none")"\'',
        'echo "Then take one backup now (POST /v1/backups/tasks) and check it lands on the server."',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Back up SDDC Manager to sftp://${server}${directory}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Run once when the backup target is built or changes; SDDC Manager then runs the schedule itself.', worstCase: onChange ? 'on the schedule, plus after every state change' : 'on the schedule' },
        scope: {
          what: 'The backup configuration of one SDDC Manager instance, which also sets the target NSX Manager backups use for the domains it manages.',
          decidedBy: ['The SDDC_HOST the script is pointed at.', 'PUT /v1/system/backup-configuration replaces the whole configuration, not one field.'],
          ifWrong: 'Backups go to the wrong server, or to one that does not exist — and nothing fails loudly until a backup task does. The health check in this kit is what notices.',
        },
        guardrails: [
          { rule: 'Credentials only from the environment', because: 'A backup password in a file is a password in every copy of that repository.' },
          { rule: 'The host key is pinned by fingerprint', because: 'Without it, whoever answers on that address receives the backup, encrypted or not.' },
          { rule: 'Refuses while another task is running', because: 'Changing the target during a backup or an upgrade leaves that run pointing at a half-configured location.' },
        ],
        dryRun: ['Run apply.sh without --execute. It prints the request with the password and passphrase masked, and changes nothing.'],
        undo: [
          'previous-backup-configuration.json is the configuration before the change. PUT it back — with its password re-supplied from the vault, because the API does not return it.',
          'Backups already written to the new target stay there; remove them on the SFTP server if the change is abandoned.',
        ],
        told: ['SDDC Manager records the reconfiguration task. Nothing else is told — pair this with the SDDC Manager health check.'],
        requires: [
          'An SFTP server reachable from SDDC Manager and the NSX managers, with the directory created and writable by the user.',
          'SFTP_PASSWORD and BACKUP_PASSPHRASE in the environment, read from a vault.',
          'The passphrase stored somewhere that survives losing SDDC Manager. Without it the backup is unreadable.',
        ],
        files: { [`${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`, 'apply.sh': apply },
        notes: [
          'Field names follow the SDDC Manager API BackupConfigurationSpec. The retention fields in particular have been renamed between releases; verify against yours before --execute.',
          'Taking a backup on every state change is what makes a restore land just before the change that broke things, rather than the night before.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_upgrade_precheck',
    platform: PLATFORM,
    label: 'Precheck a workload domain before an upgrade',
    group: 'Lifecycle',
    description:
      'Run the SDDC Manager precheck against one workload domain, wait for it, and list every check that failed — with the bundles that are available and downloaded for the target version beside it. It starts a precheck and reads; it upgrades nothing.',
    inputs: [
      { id: 'domain', label: 'Workload domain name', control: 'text', default: 'mgmt-domain' },
      { id: 'target_version', label: 'Target VCF version', control: 'text', default: '9.1.0.0', hint: 'As the bundle list names it' },
      { id: 'timeout_minutes', label: 'Give up after (minutes)', control: 'number', default: 60, min: 5, max: 480 },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-lifecycle' },
    ],
    automation: (values                 , name        )             => {
      const domain = str(values, 'domain', 'mgmt-domain');
      const target = str(values, 'target_version', '');
      const timeout = num(values, 'timeout_minutes', 60);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || `precheck-${domain}`, 'precheck');

      const findings            = [];
      if (!target) {
        findings.push(warning('fleet.precheck.no-target', 'No target version is given, so bundle availability cannot be checked.', { source: SRC }));
      }
      if (timeout < 20) {
        findings.push(info('fleet.precheck.short-timeout', 'A precheck of a large domain routinely takes longer than twenty minutes.', { source: SRC }));
      }

      const failuresJq = [
        '# Every failed sub-check, flattened. The task shape nests validations under',
        '# subTasks or validationChecks depending on release; both are walked.',
        '[ .. | objects',
        '  | select(((.resultStatus // .status // "") | ascii_upcase) | test("FAILED|ERROR"))',
        '  | select(.name != null or .description != null)',
        '  | "\\(.name // .description): \\((.errors // [])[0].message // .errorMessage // "see SDDC Manager")" ]',
        '| unique',
        '',
      ].join('\n');

      const script = readScript('sddc-manager', `Precheck ${domain} for an upgrade to ${target || 'the next release'}.`, [
        'PROBLEMS=()',
        `DOMAIN_NAME='${domain}'`,
        `TARGET='${target}'`,
        '',
        'DOMAIN_ID=$(get /v1/domains | jq -r --arg n "$DOMAIN_NAME" \'.elements[]? | select(.name == $n) | .id\')',
        '[[ -n "$DOMAIN_ID" ]] || { echo "No workload domain named ${DOMAIN_NAME}" >&2; exit 2; }',
        '',
        '# Bundles for the target: available, and downloaded? Verify field names.',
        'if [[ -n "$TARGET" ]]; then',
        '  BUNDLES=$(get /v1/bundles | jq -r --arg v "$TARGET" \'[.elements[]? | select((.version // "" | startswith($v)) or ((.components // []) | map(.toVersion // "") | any(startswith($v))))]\')',
        '  echo "$BUNDLES" | jq -r \'.[] | "bundle \\(.id)  \\(.type // "")  \\(.downloadStatus // "UNKNOWN")"\'',
        '  [[ "$(echo "$BUNDLES" | jq length)" == "0" ]] && PROBLEMS+=("no bundle found for ${TARGET}")',
        '  while read -r b; do PROBLEMS+=("bundle not downloaded: $b"); done < <(echo "$BUNDLES" | jq -r \'.[] | select((.downloadStatus // "") != "SUCCESSFUL") | .id\')',
        '  # What the domain can move to, per SDDC Manager. Path verify-per-release.',
        '  get "/v1/upgradables/domains/${DOMAIN_ID}" 2>/dev/null | jq -r \'.elements[]? | "upgradable: \\(.bundleId // .bundle.id // "?") \\(.status // "")"\' || true',
        'fi',
        '',
        '# Start the precheck. The one write: it runs checks and changes nothing.',
        '# 9.x may use /v1/system/check-sets for targeted prechecks instead; verify.',
        'TASK=$(curl -sS -f -X POST "https://${SDDC_HOST}/v1/system/prechecks" \\',
        `  -H "${authHeader('sddc-manager')}" -H "Content-Type: application/json" \\`,
        '  --data "$(jq -n --arg id "$DOMAIN_ID" \'{resources: [{resourceId: $id, type: "DOMAIN"}]}\')" | jq -r .id)',
        'echo "precheck task ${TASK}"',
        '',
        `DEADLINE=$(( $(date +%s) + ${timeout} * 60 ))`,
        'while :; do',
        '  RESULT=$(get "/v1/system/prechecks/tasks/${TASK}")',
        '  STATUS=$(echo "$RESULT" | jq -r \'.status // "UNKNOWN"\' | tr a-z A-Z)',
        '  [[ "$STATUS" =~ IN_PROGRESS|IN\\ PROGRESS|PENDING ]] || break',
        '  (( $(date +%s) < DEADLINE )) || { PROBLEMS+=("precheck still running after ' + timeout + ' minutes"); break; }',
        '  sleep 30',
        'done',
        'echo "$RESULT" > precheck-result.json',
        'while read -r f; do PROBLEMS+=("$f"); done < <(jq -r -f failures.jq precheck-result.json | jq -r \'.[]\')',
        '',
        'if (( ${#PROBLEMS[@]} == 0 )); then',
        '  echo "Precheck passed for ${DOMAIN_NAME}. Full result in precheck-result.json."',
        '  exit 0',
        'fi',
        'printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...notify(webhook, 'vcf-upgrade-precheck'),
        'exit 1',
      ]);

      return {
        platform: PLATFORM,
        title: `Upgrade precheck — ${domain}${target ? ` to ${target}` : ''}`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Daily in the week before an upgrade window, and once by hand the morning of it', worstCase: 'once a day' },
        scope: {
          what: `The workload domain ${domain}: its components, as the SDDC Manager precheck sees them, and the bundle list.`,
          decidedBy: [`GET /v1/domains, matched by name ${domain}.`, 'POST /v1/system/prechecks with that domain as the only resource.', target ? `GET /v1/bundles filtered to ${target}.` : 'No bundle check.'],
          ifWrong: 'A precheck of the wrong domain passes and reassures nobody usefully. The script prints the domain id it resolved; check it.',
        },
        guardrails: [
          { rule: 'Starts a precheck and nothing else', because: 'An upgrade is a change-window decision, not a scheduled job.' },
          { rule: `Gives up after ${timeout} minutes`, because: 'A precheck that hangs should be a finding, not a scheduler slot held forever.' },
        ],
        dryRun: ['The precheck is itself the dry run of the upgrade. It changes no component.'],
        undo: ['Nothing to undo. The precheck result stays in SDDC Manager’s task list.'],
        told: [webhook ? `${webhook}, with each failed check.` : 'The exit code, and precheck-result.json.'],
        requires: ['An SDDC Manager account allowed to run prechecks (OPERATOR or ADMIN).', 'The target bundles downloaded, or a depot configured, for the bundle part to mean anything.'],
        files: { [`${base}.sh`]: script, 'failures.jq': failuresJq },
        notes: [
          'Newer releases split prechecks into check-sets (POST /v1/system/check-sets/queries, then /v1/system/check-sets) so you can precheck against a specific target. If /v1/system/prechecks is deprecated in yours, move to those.',
          'Run it early enough to fix what it finds. A precheck on the morning of the window only tells you the window is lost.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_host_commission',
    platform: PLATFORM,
    label: 'Commission ESXi hosts',
    group: 'Hosts',
    description:
      'Add prepared ESXi hosts to SDDC Manager’s inventory so a domain or cluster can use them. It always validates first — validation is the dry run — reads each host’s root password from its own environment variable, and commissions only when every host has passed.',
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
          envVar: `ESXI_PW_${fqdn.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
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
        `# Commission ${hosts.length} ESXi host(s) into SDDC Manager.`,
        '#',
        '# Always validates first. Without --execute it stops after validation, which',
        '# is the dry run: SDDC Manager connects to each host and checks it, and',
        '# changes nothing. With --execute it commissions only if every host passed.',
        '#',
        '# Each host’s password comes from its own variable, listed in hosts.json.',
        'set -euo pipefail',
        ...authPreamble('sddc-manager'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        'DRY_RUN=1; [[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
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
        '  echo "DRY RUN: validation passed. Re-run with --execute to commission."',
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
        title: `Commission ${hosts.length} ESXi host${hosts.length === 1 ? '' : 's'} (${types.join(', ') || defaultType}) into ${pool}`,
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
        dryRun: ['Run without --execute. It validates every host with SDDC Manager and stops there.'],
        undo: [
          'Decommission: DELETE /v1/hosts with a body listing each FQDN (verify the shape for your release), or Hosts > Decommission in SDDC Manager.',
          'A decommissioned host has to be reimaged before it is commissioned again.',
        ],
        told: ['SDDC Manager records the validation and the commission task. Nothing else is told.'],
        requires: [
          'Each host imaged at a supported ESXi build, with forward and reverse DNS, NTP, and SSH enabled.',
          `The network pool ${pool} with free addresses for vMotion and storage for every host.`,
          ...hosts.map((host) => `${host.envVar} set to ${host.fqdn}’s ${user} password, from your vault.`),
        ],
        files: { [`${base}.sh`]: script, 'hosts.json': `${JSON.stringify(hosts, null, 2)}\n`, 'spec.jq': specJq },
        notes: [
          'The storageType values follow the SDDC Manager HostCommissionSpec. VSAN_ESA is how recent releases name ESA; some take VSAN with a separate ESA flag instead. Verify against your release.',
          'Commissioning does not put a host in a cluster. It makes it available; adding it to a cluster or a new domain is a separate operation.',
        ],
        findings,
      };
    },
  }),
];
