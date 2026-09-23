/**
 * VCF Automation: the infrastructure underneath the catalogue.
 *
 * Formerly Aria Automation, and vRA before that. The catalogue blueprints in
 * vcf-automation.ts are what a requester sees. These are what has to exist
 * before any of that works, and they are the part an administrator sets up
 * once, in a hurry, by clicking: the cloud account, the cloud zone, the
 * project, the image and flavor mappings, the network and storage profiles,
 * the content source and who it is shared with, the naming template, the
 * property groups every template reuses.
 *
 * None of these acts at three in the morning by itself. They are still
 * automations in the sense that matters: every deployment afterwards is placed,
 * named, sized and limited by what they say, without anybody looking again. A
 * cloud zone that includes all compute is a decision made once and applied to
 * every request for years.
 *
 * Every payload here is for the IaaS, content, catalog, policy or properties
 * APIs as they stood in Aria Automation 8.x and carried into VCF Automation.
 * Where a field is not certain it is left as `<REQUIRED — ...>`; GET an
 * existing object of the same kind in your own version and copy its shape
 * rather than trusting this one.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { applyScript, authHeader, authPreamble, hostVar } from '../apply.ts';
import { apiStep, importBundle, importMd, manualStep, setupOrderStep, verifyFor } from '../vcfa-import.ts';

const PLATFORM = 'vcf-automation' as const;
const SRC = 'ArchToolKit';

// --- helpers ---------------------------------------------------------------

/** `key:value, key:value` into the tag objects every IaaS payload takes. */
function tagsOf(text: string): { key: string; value: string }[] {
  return listOf(text).map((pair) => {
    const at = pair.indexOf(':');
    return at < 0 ? { key: pair, value: '' } : { key: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim() };
  });
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

interface ChainStep {
  readonly method: 'POST' | 'PATCH' | 'PUT';
  readonly path: string;
  readonly payload: string;
  /** Capture the returned id into this shell variable, e.g. VSPHERE_ID. */
  readonly captureAs?: string;
  /** JSON field → environment variable, injected with jq at send time and never written to disk. */
  readonly secrets?: Readonly<Record<string, string>>;
  /**
   * The call may answer 202 with a request tracker instead of the object. The
   * tracker's id is not the object's id, so the script polls the tracker until
   * it finishes and takes the id from the resource link it reports.
   */
  readonly tracked?: boolean;
}

/**
 * An apply script for payloads that refer to each other.
 *
 * `applyScript` sends files as they are. Some of these objects need the id the
 * previous call returned — the NSX account names the vSphere account, the
 * sharing policy names the content source — and some need a password that
 * must never be in the file. This writes the same dry-run-by-default script,
 * with `__VAR__` tokens in later payloads replaced by earlier ids and secrets
 * injected from the environment by jq.
 *
 * Neither a secret nor a body carrying one is ever an argument to a command:
 * jq reads the secret with env, and curl reads the body on stdin, so neither
 * shows in a process list or in /proc.
 */
function chainScript(purpose: string, steps: readonly ChainStep[], undo: string): string {
  const host = hostVar('vcf-automation');
  const secretVars = [...new Set(steps.flatMap((step) => Object.values(step.secrets ?? {})))];
  const anyTracked = steps.some((step) => step.tracked);
  const lines = [
    '#!/usr/bin/env bash',
    `# ${purpose}`,
    '#',
    '# Each step may use the id an earlier step returned; those appear in the',
    '# payloads as __NAME__ and are substituted at send time. Credentials are read',
    '# from the environment and injected by jq — no file here contains one, and no',
    '# command line carries one: bodies go to curl on stdin.',
    '#',
    '# Without --execute this only prints what it would send.',
    '# Not idempotent: if a run fails part way, check what was created first.',
    'set -euo pipefail',
    '',
    ...authPreamble('vcf-automation'),
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    '',
    'DRY_RUN=1',
    '[[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
    '',
    '# send METHOD PATH, with the body on stdin.',
    'send() {',
    '  local method="$1" path="$2"',
    `  curl -sS -f -X "\${method}" "https://\${${host}}\${path}" \\`,
    `    -H "${authHeader('vcf-automation')}" \\`,
    '    -H "Accept: application/json" -H "Content-Type: application/json" \\',
    '    --data-binary @-',
    '}',
    '',
    ...(anyTracked
      ? [
          '# resolve RESPONSE: print the id of the object a create call made.',
          '# A 202 answer is a request tracker, whose own id is not the object\'s: poll',
          '# it until FINISHED and take the id from the last segment of resources[0]',
          '# (/iaas/api/cloud-accounts/<id>). FAILED or a timeout stops the script.',
          'TRACK_TIMEOUT="${TRACK_TIMEOUT:-600}"',
          'TRACK_INTERVAL="${TRACK_INTERVAL:-5}"',
          'resolve() {',
          '  local response="$1" link status waited=0',
          '  link=$(jq -r \'.selfLink // empty\' <<<"${response}")',
          '  if [[ "${link}" != */request-tracker/* ]]; then',
          '    jq -r \'.id // empty\' <<<"${response}"',
          '    return 0',
          '  fi',
          '  [[ "${link}" == http* ]] || link="https://${' + host + '}${link}"',
          '  while :; do',
          '    status=$(jq -r \'.status // empty\' <<<"${response}")',
          '    case "${status}" in',
          '      FINISHED)',
          '        jq -r \'.resources[0] // empty | sub("^.*/"; "")\' <<<"${response}"',
          '        return 0 ;;',
          '      FAILED)',
          '        echo "request ${link##*/} failed: $(jq -r \'.message // "no message"\' <<<"${response}")" >&2',
          '        return 1 ;;',
          '    esac',
          '    if (( waited >= TRACK_TIMEOUT )); then',
          '      echo "request ${link##*/} still ${status:-unknown} after ${TRACK_TIMEOUT}s — check it before re-running: GET ${link}" >&2',
          '      return 1',
          '    fi',
          '    sleep "${TRACK_INTERVAL}"',
          '    waited=$(( waited + TRACK_INTERVAL ))',
          `    response=$(curl -sS -f "\${link}" -H "${authHeader('vcf-automation')}" -H "Accept: application/json") || {`,
          '      echo "could not read request ${link##*/} — check it before re-running: GET ${link}" >&2',
          '      return 1',
          '    }',
          '  done',
          '}',
          '',
        ]
      : []),
    'if (( DRY_RUN )); then',
    ...steps.map((step) => `  echo "DRY RUN: would ${step.method} ${step.payload} to https://\${${host}}${step.path}"`),
    ...(secretVars.length > 0 ? [`  echo "With --execute it will also need: ${secretVars.join(', ')}"`] : []),
    '  echo "Nothing was changed. Read the payloads, then re-run with --execute."',
    '  exit 0',
    'fi',
    '',
    ...secretVars.map((name) => `: "\${${name}:?set ${name} in the environment — it is never written to a file}"`),
    ...(secretVars.length > 0 ? [''] : []),
  ];

  const captured: string[] = [];
  for (const step of steps) {
    const subs = captured.map((name) => `-e "s/__${name}__/\${${name}}/g"`).join(' ');
    lines.push(`BODY=$(sed ${subs || '-e ""'} '${step.payload}')`);
    for (const [field, env] of Object.entries(step.secrets ?? {})) {
      // The prefix assignment puts the secret in jq's environment, not its arguments.
      lines.push(`BODY=$(${env}="\${${env}}" jq '.${field} = env.${env}' <<<"\${BODY}")`);
    }
    if (step.captureAs) {
      if (step.tracked) {
        lines.push(`RESPONSE=$(send ${step.method} '${step.path}' <<<"\${BODY}")`);
        lines.push(`${step.captureAs}=$(resolve "\${RESPONSE}")`);
      } else {
        lines.push(`${step.captureAs}=$(send ${step.method} '${step.path}' <<<"\${BODY}" | jq -r '.id // empty')`);
      }
      lines.push(`[[ -n "\${${step.captureAs}}" ]] || { echo "${step.path} returned no id — stopping" >&2; exit 1; }`);
      lines.push(`echo "${step.captureAs}=\${${step.captureAs}}" | tee -a created-ids.txt`);
      captured.push(step.captureAs);
    } else {
      lines.push(`send ${step.method} '${step.path}' <<<"\${BODY}"`, 'echo');
    }
    lines.push('');
  }
  lines.push('echo "Ids are in created-ids.txt. Keep it: it is the undo list."', '', `# Undo: ${undo}`, '');
  return lines.join('\n');
}

/** A CIDR as an inclusive range of 32-bit addresses, or undefined if it does not parse. */
function cidrRange(cidr: string): [number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!match) return undefined;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return undefined;
  const address = octets.reduce((acc, o) => acc * 256 + o, 0);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(address / size) * size;
  return [start, start + size - 1];
}

const PLACEMENT = [
  { value: 'DEFAULT', label: 'Default — first host that fits, by priority' },
  { value: 'SPREAD', label: 'Spread — fewest machines per host' },
  { value: 'BINPACK', label: 'Binpack — fill the busiest host that still fits' },
  { value: 'SPREAD_MEMORY', label: 'Spread by memory — most free memory first' },
];

// ---------------------------------------------------------------------------

export const VCF_AUTOMATION_SETUP: readonly AutomationBlueprint[] = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_cloud_account',
    platform: PLATFORM,
    label: 'A vSphere cloud account, with its NSX account',
    group: 'Infrastructure',
    description:
      'The vCenter and NSX Manager that VCF Automation places on, as two cloud accounts associated with each other, enabling only the datacenters you name and tagging the account with what it can do. The passwords are read from the environment when the script runs and are never written into a payload.',
    inputs: [
      { id: 'account_name', label: 'Account name', control: 'text', default: 'wld01-vcenter' },
      { id: 'vcenter_host', label: 'vCenter FQDN', control: 'text', default: 'wld01-vc.example.com' },
      { id: 'vcenter_user', label: 'vCenter service account', control: 'text', default: 'svc-vcfa@vsphere.local', hint: 'A dedicated account with the documented role, not administrator@vsphere.local' },
      { id: 'include_nsx', label: 'Add the associated NSX account', control: 'toggle', default: true },
      { id: 'nsx_host', label: 'NSX Manager FQDN (the VIP)', control: 'text', default: 'wld01-nsx.example.com', showWhen: { input: 'include_nsx', equals: ['true'] } },
      { id: 'nsx_user', label: 'NSX service account', control: 'text', default: 'svc-vcfa', showWhen: { input: 'include_nsx', equals: ['true'] } },
      { id: 'enable_all', label: 'Enable every datacenter the vCenter has', control: 'toggle', default: false, hint: 'See the finding before turning this on' },
      {
        id: 'datacenters',
        label: 'Datacenters to enable',
        control: 'textarea',
        default: 'Datacenter:datacenter-3',
        hint: 'externalRegionId, as region enumeration returns it — Datacenter:<moref>',
        showWhen: { input: 'enable_all', equals: ['false'] },
      },
      { id: 'capability_tags', label: 'Capability tags', control: 'text', default: 'cloud:vsphere, site:dc1', hint: 'key:value, comma separated' },
      { id: 'accept_self_signed', label: 'Accept a self-signed certificate', control: 'toggle', default: false },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const accountName = str(values, 'account_name', 'vcenter');
      const vcHost = str(values, 'vcenter_host', '<REQUIRED — vCenter FQDN>');
      const vcUser = str(values, 'vcenter_user', '<REQUIRED — service account>');
      const withNsx = bool(values, 'include_nsx', true);
      const nsxHost = str(values, 'nsx_host', '<REQUIRED — NSX Manager VIP>');
      const nsxUser = str(values, 'nsx_user', '<REQUIRED — service account>');
      const enableAll = bool(values, 'enable_all', false);
      const datacenters = enableAll ? [] : listOf(str(values, 'datacenters', ''));
      const tags = tagsOf(str(values, 'capability_tags', ''));
      const selfSigned = bool(values, 'accept_self_signed', false);
      const base = slugOf(name || accountName, 'cloud-account');

      const findings: Finding[] = [];
      if (enableAll) {
        findings.push(
          warning('vcfa.account.all-datacenters', 'Every datacenter in this vCenter will be enabled as a region, including ones nobody meant to offer.', {
            remediation: 'A region that is enabled can be put in a cloud zone by anyone with cloud admin, and a management or DR datacenter in a zone is a request away from having workloads on it. Name the datacenters instead.',
            source: SRC,
          }),
        );
      } else if (datacenters.length === 0) {
        findings.push(
          error('vcfa.account.no-datacenters', 'No datacenter is enabled, so the account will collect nothing that can be placed on.', {
            remediation: 'Run region enumeration against the vCenter and list the externalRegionId of each datacenter to offer.',
            source: SRC,
          }),
        );
      }
      if (tags.length === 0) {
        findings.push(
          warning('vcfa.account.no-tags', 'The account has no capability tags.', {
            remediation: 'Tags on the account are how a template or a project says "only vSphere at this site". Without them placement falls back to whatever cloud zone happens to be first.',
            source: SRC,
          }),
        );
      }
      if (/^administrator@/i.test(vcUser)) {
        findings.push(
          warning('vcfa.account.admin-user', 'The vCenter account is the SSO administrator.', {
            remediation: 'Every action VCF Automation takes then appears in vCenter as administrator, and rotating that password breaks provisioning. Use a service account with the documented privileges.',
            source: SRC,
          }),
        );
      }
      if (selfSigned) {
        findings.push(
          info('vcfa.account.self-signed', 'A self-signed certificate is accepted without checking who presented it.', {
            remediation: 'Fine in a lab. In production, replace the vCenter certificate with a CA-signed one, or pass its certificate in certificateInfo so a change is noticed.',
            source: SRC,
          }),
        );
      }

      const regions = enableAll
        ? '<REQUIRED — every externalRegionId from region enumeration>'
        : datacenters.map((dc) => ({ externalRegionId: dc, name: dc.split(':')[0] ?? dc }));

      const vsphere = {
        name: accountName,
        description: 'Generated by ArchToolKit.',
        hostName: vcHost,
        username: vcUser,
        password: '<REQUIRED — injected from VSPHERE_PASSWORD by apply.sh>',
        acceptSelfSignedCertificate: selfSigned,
        createDefaultZones: false,
        regions,
        tags,
      };

      const nsx = {
        name: `${accountName}-nsx`,
        description: 'Generated by ArchToolKit. Associated with the vSphere account above.',
        hostName: nsxHost,
        username: nsxUser,
        password: '<REQUIRED — injected from NSX_PASSWORD by apply.sh>',
        acceptSelfSignedCertificate: selfSigned,
        associatedCloudAccountIds: ['__VSPHERE_ACCOUNT_ID__'],
        managerMode: false,
        isGlobalManager: false,
        tags,
      };

      const steps: ChainStep[] = [
        { method: 'POST', path: '/iaas/api/cloud-accounts-vsphere', payload: `${base}-vsphere.json`, captureAs: 'VSPHERE_ACCOUNT_ID', secrets: { password: 'VSPHERE_PASSWORD' }, tracked: true },
        ...(withNsx ? [{ method: 'POST' as const, path: '/iaas/api/cloud-accounts-nsx-t', payload: `${base}-nsx.json`, captureAs: 'NSX_ACCOUNT_ID', secrets: { password: 'NSX_PASSWORD' }, tracked: true }] : []),
      ];

      const enumerate = [
        '#!/usr/bin/env bash',
        '# List the datacenters the vCenter offers, as the externalRegionId values the',
        '# account payload wants. Reads only; creates nothing.',
        'set -euo pipefail',
        ...authPreamble('vcf-automation'),
        ': "${VSPHERE_PASSWORD:?set VSPHERE_PASSWORD in the environment}"',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        '# The password reaches jq through its environment and curl on stdin, so it is',
        '# never an argument that a process list could show.',
        `VSPHERE_PASSWORD="\${VSPHERE_PASSWORD}" jq -n --arg h '${vcHost}' --arg u '${vcUser}' '{hostName:$h, username:$u, password:env.VSPHERE_PASSWORD, acceptSelfSignedCertificate:${selfSigned}}' |`,
        `  curl -sS -f -X POST "https://\${${hostVar('vcf-automation')}}/iaas/api/cloud-accounts-vsphere/region-enumeration" \\`,
        `  -H "${authHeader('vcf-automation')}" -H "Accept: application/json" -H "Content-Type: application/json" \\`,
        '  --data-binary @- | jq .',
        '# In newer releases this is asynchronous: it returns a request tracker, and the',
        '# regions are on the tracker once it completes. Follow selfLink if that is what you get.',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${accountName} — vSphere${withNsx ? ' and NSX' : ''} cloud account${withNsx ? 's' : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'An administrator runs apply.sh once, when the workload domain is handed to VCF Automation' },
        scope: {
          what: enableAll ? `Every datacenter in ${vcHost}, and everything VCF Automation discovers in them.` : `The datacenters ${datacenters.join(', ')} in ${vcHost}, and everything VCF Automation discovers in them.`,
          decidedBy: [
            'The regions enabled on the account — each becomes something a cloud zone can be built on.',
            'What the service account can see in vCenter: discovery is limited by its permissions, not by this payload.',
            withNsx ? 'The NSX account association, which decides which segments and on-demand networks are available to those regions.' : 'No NSX account, so only existing port groups are available as networks.',
            'Every cloud zone later built on these regions.',
          ],
          ifWrong: 'A datacenter that should not host self-service workloads becomes a region, and the first cloud zone that includes it starts receiving them. Nothing is deployed by the account itself, so the damage waits for the zone.',
        },
        guardrails: [
          { rule: enableAll ? 'Every datacenter is enabled — see the finding' : 'Only the named datacenters are enabled', because: 'A management or recovery datacenter enabled by accident is one cloud zone away from running somebody’s test VMs.' },
          { rule: 'createDefaultZones is false', because: 'Default zones include all compute with no tag filter, and they are created silently. Zones are written deliberately in the next blueprint.' },
          { rule: 'Passwords come from the environment, injected by jq at send time and sent on stdin', because: 'A cloud-account payload with the password in it gets committed to a repository within the week, and a password passed as a curl argument is readable in ps by anyone on the box while it runs.' },
          { rule: 'The account id is read from the finished request, not the 202', because: 'Creating a cloud account is asynchronous: the POST answers with a request tracker whose id is not the account’s. Put that in the NSX association or the undo list and both point at nothing. The script polls the tracker until FINISHED, stops on FAILED or after TRACK_TIMEOUT seconds (600 by default), and takes the id from the resource link.' },
          { rule: 'The script stops if the vSphere account returns no id', because: 'An NSX account associated with nothing is created happily, and then every on-demand network fails with an error that does not mention it.' },
        ],
        dryRun: [
          'Run enumerate-regions.sh to see what the vCenter offers before choosing what to enable.',
          'Run apply.sh without --execute: it lists the payloads and the environment variables it will need.',
        ],
        undo: [
          'DELETE /iaas/api/cloud-accounts-nsx-t/{id}, then DELETE /iaas/api/cloud-accounts-vsphere/{id}, using created-ids.txt.',
          'Deleting a cloud account removes every discovered resource under it, and fails or orphans deployments that still use it. Undo is only clean before anything has been deployed.',
        ],
        told: ['VCF Automation records the account creation in its own audit log. Nothing else is notified; if the change process needs a record, raise it before --execute.'],
        requires: [
          'A vCenter service account with the privileges VCF Automation documents for a vSphere cloud account.',
          ...(withNsx ? ['An NSX service account with enterprise admin or the documented role, against the Manager VIP rather than a node.'] : []),
          'In VCF, the workload domain may already be registered for you — check Cloud Accounts before creating a second one for the same vCenter.',
          'jq on the machine running the scripts, and VSPHERE_PASSWORD' + (withNsx ? ' and NSX_PASSWORD' : '') + ' in its environment.',
        ],
        files: {
          [`${base}-vsphere.json`]: json(vsphere),
          ...(withNsx ? { [`${base}-nsx.json`]: json(nsx) } : {}),
          'enumerate-regions.sh': enumerate,
          'apply.sh': chainScript(`Create the ${accountName} cloud account${withNsx ? 's' : ''} in VCF Automation.`, steps, 'DELETE the NSX account, then the vSphere account, by the ids in created-ids.txt.'),
          'IMPORT.md': importMd({
            subject: `The vSphere cloud account ${accountName}${withNsx ? ' and its NSX account' : ''}.`,
            steps: [
              setupOrderStep('vcfa_cloud_account'),
              manualStep('Find the regions', ['`./enumerate-regions.sh` lists the datacenters the vCenter offers as externalRegionId values; put the ones you mean in the regions field of the vSphere payload.']),
              apiStep('Cloud accounts', 'apply.sh', [
                `\`${base}-vsphere.json\` → POST /iaas/api/cloud-accounts-vsphere, with the password taken from VSPHERE_PASSWORD`,
                ...(withNsx ? [`\`${base}-nsx.json\` → POST /iaas/api/cloud-accounts-nsx-t, with the password from NSX_PASSWORD and the vSphere account id from the first call`] : []),
              ], ['The passwords are read from the environment by jq and sent on stdin; they are never in the files. The ids go to created-ids.txt, for the zone and for undo.']),
            ],
            auth: ['apply'],
            orgs: 'VCF Automation 9.1 / 9.1.1 VM Apps organizations and Aria Automation 8.x. In an All Apps organization vCenter and NSX arrive with the provider’s region instead',
            verify: ['The association field between the NSX and vSphere accounts has moved between releases; GET an existing pair and match it.'],
          }),
        },
        notes: [
          'The association field has moved between releases: some take associatedCloudAccountIds on the NSX account, some on the vSphere one, some both. GET an existing pair in your system and match it.',
          'In VCF Automation 9 with the all-apps organisation model, vCenter and NSX arrive through the provider’s region and are not created per tenant. This blueprint is for the VM Apps (Assembler) model.',
          'The create calls are asynchronous in the current API (202 with a RequestTracker; status INPROGRESS, FINISHED or FAILED; resources holds the account link) and take an apiVersion query parameter. Without apiVersion some releases answer with the older, synchronous shape; apply.sh handles both. If your release rejects the regions field, add ?apiVersion= with the version your API reference lists to both paths.',
          'The regions field replaced regionIds in 8.x. If your version rejects it, GET an existing account and copy its shape.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_cloud_zone',
    platform: PLATFORM,
    label: 'A cloud zone with a placement policy',
    group: 'Infrastructure',
    description:
      'The set of clusters and resource pools that deployments may land on, chosen by a tag filter rather than by picking every compute resource, with a placement policy, a VM folder, and the capability tags templates use to ask for it.',
    inputs: [
      { id: 'zone_name', label: 'Zone name', control: 'text', default: 'dc1-general' },
      { id: 'region_id', label: 'Region id', control: 'text', default: '<REQUIRED — GET /iaas/api/regions>', hint: 'The IaaS region id, not the datacenter moref' },
      { id: 'placement', label: 'Placement policy', control: 'select', options: PLACEMENT, default: 'DEFAULT' },
      {
        id: 'compute_mode',
        label: 'Compute',
        control: 'select',
        options: [
          { value: 'tags', label: 'Compute matching tags — dynamic' },
          { value: 'explicit', label: 'Named compute resources — static' },
          { value: 'all', label: 'All compute in the region' },
        ],
        default: 'tags',
      },
      { id: 'compute_tags', label: 'Include compute tagged', control: 'text', default: 'workload:general', showWhen: { input: 'compute_mode', equals: ['tags'] } },
      { id: 'compute_ids', label: 'Compute ids', control: 'textarea', default: '', placeholder: 'one per line, from GET /iaas/api/fabric-computes', showWhen: { input: 'compute_mode', equals: ['explicit'] } },
      { id: 'folder', label: 'VM folder', control: 'text', default: 'VCFA/general', hint: 'Relative to the datacenter' },
      { id: 'zone_tags', label: 'Capability tags', control: 'text', default: 'site:dc1, tier:general' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const zoneName = str(values, 'zone_name', 'cloud-zone');
      const regionId = str(values, 'region_id', '<REQUIRED — GET /iaas/api/regions>');
      const placement = str(values, 'placement', 'DEFAULT');
      const mode = str(values, 'compute_mode', 'tags');
      const computeTags = tagsOf(str(values, 'compute_tags', ''));
      const computeIds = listOf(str(values, 'compute_ids', ''));
      const folder = str(values, 'folder', '');
      const zoneTags = tagsOf(str(values, 'zone_tags', ''));
      const base = slugOf(name || zoneName, 'cloud-zone');

      const findings: Finding[] = [];
      if (mode === 'all' || (mode === 'tags' && computeTags.length === 0)) {
        findings.push(
          warning('vcfa.zone.all-compute', 'This zone includes every compute resource in the region, including clusters added later.', {
            remediation: 'A cluster added next year for a different purpose — edge, GPU, a tenant’s dedicated hosts — joins this zone the moment it is discovered. Filter by a tag that someone has to put on a cluster deliberately.',
            source: SRC,
          }),
        );
      }
      if (mode === 'explicit' && computeIds.length === 0) {
        findings.push(error('vcfa.zone.no-compute', 'Explicit compute was chosen and none is listed, so nothing can be placed in this zone.', { source: SRC }));
      }
      if (zoneTags.length === 0) {
        findings.push(
          warning('vcfa.zone.no-tags', 'The zone has no capability tags, so no template constraint can select it.', {
            remediation: 'Placement then depends only on project zone priority, which is the order someone clicked them in.',
            source: SRC,
          }),
        );
      }
      if (!folder) {
        findings.push(
          info('vcfa.zone.no-folder', 'Machines will be created in the datacenter’s root VM folder.', {
            remediation: 'A folder per zone or per project is what makes vCenter permissions and backup selection work without tags.',
            source: SRC,
          }),
        );
      }

      const zone = {
        name: zoneName,
        description: 'Generated by ArchToolKit.',
        regionId,
        placementPolicy: placement,
        ...(mode === 'tags' && computeTags.length > 0 ? { tagsToMatch: computeTags } : {}),
        ...(mode === 'explicit' ? { computeIds } : {}),
        ...(folder ? { folder } : {}),
        tags: zoneTags,
      };

      return {
        platform: PLATFORM,
        title: `${zoneName} — cloud zone, ${placement.toLowerCase()} placement`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'An administrator runs apply.sh when the zone is created; afterwards every deployment in every project that uses it is placed by it' },
        scope: {
          what:
            mode === 'tags'
              ? `Compute in region ${regionId} tagged ${computeTags.map((t) => `${t.key}:${t.value}`).join(', ') || '(no tag — all compute)'}, now and whenever a new cluster is tagged the same way.`
              : mode === 'explicit'
                ? `The ${computeIds.length} named compute resource(s) in region ${regionId}.`
                : `All compute in region ${regionId}, including clusters discovered later.`,
          decidedBy: [
            'The region, which comes from the cloud account.',
            mode === 'tags' ? 'The tag filter, matched against compute each time data collection runs.' : mode === 'explicit' ? 'The compute ids, which are fixed until someone edits the zone.' : 'Nothing: every compute resource in the region.',
            'Which projects add this zone, and at what priority.',
            'The constraints in each cloud template, matched against the zone’s capability tags.',
          ],
          ifWrong: 'Deployments land on clusters they were never meant for — a management cluster, a licensed-by-core cluster, a tenant’s dedicated hosts — and nobody notices until the capacity or the licence bill does.',
        },
        guardrails: [
          { rule: mode === 'all' ? 'None on compute — see the finding' : mode === 'tags' ? 'Compute selected by tag, not by "all"' : 'Compute listed explicitly', because: 'The zone is evaluated every data collection. A zone of "all" quietly grows every time a cluster is added.' },
          { rule: `Placement policy ${placement}`, because: placement === 'BINPACK' ? 'Binpack runs hosts hot on purpose; it is chosen here, not inherited.' : 'The default policy picks the first host that fits, which concentrates load; the choice is written down rather than assumed.' },
          ...(folder ? [{ rule: `Machines go in folder ${folder}`, because: 'A folder is what vCenter permissions, backup jobs and humans use to tell self-service machines from everything else.' }] : []),
        ],
        dryRun: [
          'Run apply.sh without --execute to see the payload.',
          mode === 'tags' ? `Before creating it, GET /iaas/api/fabric-computes?$filter=tags.item.key eq '${computeTags[0]?.key ?? 'key'}' and count what comes back. That is the zone.` : 'Before creating it, list the compute it will include in the interface and check each one.',
          'After creating it, open the zone’s Compute tab: it shows what the filter actually matched.',
        ],
        undo: ['DELETE /iaas/api/zones/{id}. It fails while a project still references the zone; remove it from the projects first. Existing machines stay where they are.'],
        told: ['Nobody. Changes to zones are in the VCF Automation audit log only.'],
        requires: ['A cloud account with the region enabled (see the cloud account blueprint).', mode === 'tags' ? 'Tags on the clusters or resource pools — applied in VCF Automation or synchronised from vCenter tags.' : 'The fabric compute ids.', ...(folder ? [`The folder ${folder} existing in vCenter.`] : [])],
        files: {
          [`${base}.json`]: json(zone),
          'apply.sh': applyScript('vcf-automation', [{ method: 'POST', path: '/iaas/api/zones', payload: `${base}.json` }], 'DELETE /iaas/api/zones/{id} after removing it from every project.'),
          'IMPORT.md': importMd({
            subject: `The cloud zone ${zoneName}.`,
            steps: [
              setupOrderStep('vcfa_cloud_zone'),
              apiStep('Cloud zone', 'apply.sh', [`\`${base}.json\` → POST /iaas/api/zones`], ['Fill the region id first (GET /iaas/api/regions, after the cloud account has collected). The zone id it returns goes into the project.']),
            ],
            auth: ['apply'],
            verify: [],
          }),
        },
        notes: [
          'SPREAD_MEMORY is present from 8.12 onwards. An older system rejects it; use SPREAD.',
          'Placement policy on the zone is overridden by the project’s own placement policy when the project sets one.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_project',
    platform: PLATFORM,
    label: 'A project with groups, quotas and a naming template',
    group: 'Projects',
    description:
      'The unit of tenancy: who administers it and who can request from it, as directory groups; which cloud zones it can use and how much of each; how its machines are named; and the custom properties — cost centre and the like — that every deployment in it inherits.',
    inputs: [
      { id: 'project_name', label: 'Project name', control: 'text', default: 'finance-apps' },
      { id: 'principal_type', label: 'Grant access to', control: 'select', options: [{ value: 'group', label: 'Directory groups' }, { value: 'user', label: 'Individual users' }], default: 'group' },
      { id: 'admins', label: 'Administrators', control: 'text', default: 'vcfa-finance-admins@example.com' },
      { id: 'members', label: 'Members', control: 'text', default: 'vcfa-finance-users@example.com' },
      { id: 'zone_ids', label: 'Cloud zone ids', control: 'text', default: '<REQUIRED — GET /iaas/api/zones>', hint: 'Comma separated; the first is highest priority' },
      { id: 'max_instances', label: 'Max machines per zone', control: 'number', default: 50, min: 0, max: 100000, hint: '0 is unlimited' },
      { id: 'memory_gb', label: 'Memory limit per zone (GB)', control: 'number', default: 512, min: 0, max: 1000000, hint: '0 is unlimited' },
      { id: 'cpu_limit', label: 'vCPU limit per zone', control: 'number', default: 128, min: 0, max: 100000, hint: '0 is unlimited' },
      { id: 'storage_gb', label: 'Storage limit per zone (GB)', control: 'number', default: 10240, min: 0, max: 10000000, hint: '0 is unlimited' },
      { id: 'naming', label: 'Machine naming template', control: 'text', default: '${project.name}-${###}', hint: 'Empty uses the custom naming template or the default' },
      { id: 'placement', label: 'Placement across zones', control: 'select', options: [{ value: 'DEFAULT', label: 'Default — by zone priority' }, { value: 'SPREAD', label: 'Spread across zones' }], default: 'DEFAULT' },
      { id: 'shared', label: 'Deployments visible to all members', control: 'toggle', default: true },
      { id: 'custom_props', label: 'Custom properties', control: 'text', default: 'costCenter:CC-4410, owner:finance-it' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const projectName = str(values, 'project_name', 'project');
      const type = str(values, 'principal_type', 'group');
      const admins = listOf(str(values, 'admins', ''));
      const members = listOf(str(values, 'members', ''));
      const zoneIds = listOf(str(values, 'zone_ids', ''));
      const maxInstances = num(values, 'max_instances', 50);
      const memoryGb = num(values, 'memory_gb', 512);
      const cpu = num(values, 'cpu_limit', 128);
      const storageGb = num(values, 'storage_gb', 10240);
      const naming = str(values, 'naming', '');
      const placement = str(values, 'placement', 'DEFAULT');
      const shared = bool(values, 'shared', true);
      const props = Object.fromEntries(tagsOf(str(values, 'custom_props', '')).map((t) => [t.key, t.value]));
      const base = slugOf(name || projectName, 'project');

      const unlimited = [maxInstances === 0 && 'machines', memoryGb === 0 && 'memory', cpu === 0 && 'vCPU', storageGb === 0 && 'storage'].filter(Boolean) as string[];

      const findings: Finding[] = [];
      if (unlimited.length > 0) {
        findings.push(
          warning('vcfa.project.unlimited', `The project has no limit on ${unlimited.join(', ')} in its zones.`, {
            remediation: 'A quota is the only thing between a loop in someone’s pipeline and a full cluster. Set it generously, but set it; raising it is a two-minute change with a record.',
            source: SRC,
          }),
        );
      }
      if (type === 'user') {
        findings.push(
          warning('vcfa.project.users', 'Access is granted to individual users rather than groups.', {
            remediation: 'Nobody removes a leaver from a VCF Automation project. They do remove them from the directory group. Grant to groups and let the directory do joiners and leavers.',
            source: SRC,
          }),
        );
      }
      if (!naming) {
        findings.push(
          warning('vcfa.project.no-naming', 'No naming template, so machines are named from the default — the template resource name and a random suffix.', {
            remediation: 'Set a template here or, better, a custom naming template (the naming blueprint) that every project shares.',
            source: SRC,
          }),
        );
      }
      if (admins.length === 0) {
        findings.push(error('vcfa.project.no-admin', 'The project has no administrator.', { source: SRC }));
      }
      if (!props.costCenter && !props.costCentre) {
        findings.push(info('vcfa.project.no-cost', 'No costCenter custom property, so deployments carry nothing that ties them to a budget.', { source: SRC }));
      }

      const principal = (email: string) => ({ email, type });
      const project = {
        name: projectName,
        description: 'Generated by ArchToolKit.',
        administrators: admins.map(principal),
        members: members.map(principal),
        viewers: [],
        zoneAssignmentConfigurations: zoneIds.map((zoneId, index) => ({
          zoneId,
          priority: index,
          maxNumberInstances: maxInstances,
          memoryLimitMB: memoryGb * 1024,
          cpuLimit: cpu,
          storageLimitGB: storageGb,
        })),
        ...(naming ? { machineNamingTemplate: naming } : {}),
        placementPolicy: placement,
        sharedResources: shared,
        operationTimeout: 0,
        customProperties: props,
      };

      return {
        platform: PLATFORM,
        title: `${projectName} — project for ${members.length} member ${type}(s), ${zoneIds.length} zone(s)`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'An administrator runs apply.sh when a team is onboarded; afterwards its members can request whatever is shared to it' },
        scope: {
          what: `Everything members of ${members.join(', ') || '(nobody)'} deploy through project ${projectName}, in zones ${zoneIds.join(', ')}.`,
          decidedBy: [
            `The ${type === 'group' ? 'directory group membership' : 'user list'} of administrators and members.`,
            'The cloud zones assigned, in priority order, and the quota on each.',
            'The catalogue items and templates shared to the project.',
            'Any policy (lease, approval, day-2) scoped to the project.',
          ],
          ifWrong: 'A group that is wider than it sounds — "all engineering" rather than "finance engineering" — gives everyone in it request rights against these zones up to the quota.',
        },
        guardrails: [
          { rule: unlimited.length > 0 ? `Quotas set except ${unlimited.join(', ')}` : `Quota per zone: ${maxInstances} machines, ${cpu} vCPU, ${memoryGb} GB memory, ${storageGb} GB storage`, because: 'A pipeline that deploys in a loop stops at the quota rather than at a full datastore.' },
          { rule: type === 'group' ? 'Access by directory group' : 'Access by named user — see the finding', because: 'Leavers are removed from groups by the directory, not from projects by anyone.' },
          ...(naming ? [{ rule: `Machines named ${naming}`, because: 'A name that says which project owns it is how an orphan in vCenter gets back to a person.' }] : []),
        ],
        dryRun: ['Run apply.sh without --execute to see the payload.', 'Expand each group in the directory and count its members before --execute. That count is who can deploy.'],
        undo: ['DELETE /iaas/api/projects/{id}. It fails while the project has deployments; those must be deleted or moved to another project first, which is why undo is only clean on day one.'],
        told: ['Nobody. Consider an Event Broker subscription on project changes if the change process needs one.'],
        requires: ['The cloud zones, and their ids.', 'The directory groups, synchronised into VCF Automation’s identity source.'],
        files: {
          [`${base}.json`]: json(project),
          'apply.sh': applyScript('vcf-automation', [{ method: 'POST', path: '/iaas/api/projects', payload: `${base}.json` }], 'DELETE /iaas/api/projects/{id} once it has no deployments.'),
          'IMPORT.md': importMd({
            subject: `The project ${projectName}.`,
            steps: [
              setupOrderStep('vcfa_project'),
              apiStep('Project', 'apply.sh', [`\`${base}.json\` → POST /iaas/api/projects`], ['Fill the cloud zone ids first (GET /iaas/api/zones). The project id it returns is what VCFA_PROJECT_ID means in every import script on this page.']),
            ],
            auth: ['apply'],
            verify: [],
          }),
        },
        notes: [
          'The machine naming template on a project is superseded by custom naming (see the naming blueprint) when both exist. Keep one, not both.',
          'The principal type values are user and group in 8.x. Some releases also accept email without type for users — GET an existing project to see yours.',
          'Custom properties on the project are passed to every machine as properties, and can be read by extensibility actions and by naming templates as ${project.customProperties.<name>} in newer releases.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_mappings',
    platform: PLATFORM,
    label: 'Image and flavor mappings for a region',
    group: 'Projects',
    description:
      'The names a template asks for — small, medium, rhel9 — mapped to real sizes and real templates in one region. A template that works in one project and fails in another is almost always a mapping that exists in one region and not the other.',
    inputs: [
      { id: 'profile_name', label: 'Profile name', control: 'text', default: 'dc1-standard' },
      { id: 'region_id', label: 'Region id', control: 'text', default: '<REQUIRED — GET /iaas/api/regions>' },
      { id: 'small', label: 'small (vCPU / GB)', control: 'text', default: '1/2', section: 'Flavors' },
      { id: 'medium', label: 'medium (vCPU / GB)', control: 'text', default: '2/8', section: 'Flavors' },
      { id: 'large', label: 'large (vCPU / GB)', control: 'text', default: '4/16', section: 'Flavors' },
      { id: 'xlarge', label: 'xlarge (vCPU / GB)', control: 'text', default: '8/32', section: 'Flavors' },
      { id: 'images', label: 'Images', control: 'textarea', default: 'rhel9 = tpl-rhel9-hardened\nubuntu24 = tpl-ubuntu-2404\nwin2022 = tpl-win2022-std', hint: 'mapping name = vCenter template or content library item, one per line' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const profileName = str(values, 'profile_name', 'profile');
      const regionId = str(values, 'region_id', '<REQUIRED — GET /iaas/api/regions>');
      const sizeNames = ['small', 'medium', 'large', 'xlarge'] as const;
      const defaults: Record<string, string> = { small: '1/2', medium: '2/8', large: '4/16', xlarge: '8/32' };
      const sizes = sizeNames.map((size) => {
        const [cpu = 0, mem = 0] = str(values, size, defaults[size]).split('/').map((part) => Number(part.trim()));
        return { size, cpu, mem };
      });
      const images = str(values, 'images', '')
        .split('\n')
        .map((line) => line.split('='))
        .filter((parts) => parts.length === 2 && parts[0]!.trim() && parts[1]!.trim())
        .map(([key, template]) => ({ key: key!.trim(), template: template!.trim() }));
      const base = slugOf(name || profileName, 'mappings');

      const findings: Finding[] = [];
      for (const s of sizes) {
        if (!Number.isFinite(s.cpu) || !Number.isFinite(s.mem) || s.cpu <= 0 || s.mem <= 0) {
          findings.push(error('vcfa.mappings.bad-size', `${s.size} is not written as vCPU/GB, e.g. 2/8.`, { source: SRC }));
        }
      }
      for (let i = 1; i < sizes.length; i++) {
        const prev = sizes[i - 1]!;
        const cur = sizes[i]!;
        if (cur.cpu < prev.cpu || cur.mem < prev.mem || (cur.cpu === prev.cpu && cur.mem === prev.mem)) {
          findings.push(
            error('vcfa.mappings.not-monotonic', `${cur.size} (${cur.cpu}/${cur.mem}) is not larger than ${prev.size} (${prev.cpu}/${prev.mem}).`, {
              remediation: 'Requesters choose by name. A "large" that is smaller than "medium" in either dimension is a support ticket every time it is chosen.',
              source: SRC,
            }),
          );
        }
      }
      const xl = sizes[3]!;
      if (xl.cpu > 16 || xl.mem > 128) {
        findings.push(
          warning('vcfa.mappings.xlarge', `xlarge is ${xl.cpu} vCPU and ${xl.mem} GB — beyond what a self-service size usually should be.`, {
            remediation: 'Above about 16 vCPU a VM starts to span NUMA nodes and to need a conversation about placement. Offer it through an approval policy, or not at all.',
            source: SRC,
          }),
        );
      }
      if (images.length === 0) {
        findings.push(warning('vcfa.mappings.no-images', 'No image mappings, so no template in this region can resolve an image.', { source: SRC }));
      }

      const flavor = {
        name: `${profileName}-flavors`,
        description: 'Generated by ArchToolKit.',
        regionId,
        flavorMapping: Object.fromEntries(sizes.map((s) => [s.size, { cpuCount: s.cpu, memoryInMB: s.mem * 1024 }])),
      };
      const image = {
        name: `${profileName}-images`,
        description: 'Generated by ArchToolKit.',
        regionId,
        imageMapping: Object.fromEntries(
          images.map((img) => [img.key, { id: `<REQUIRED — id of ${img.template} from GET /iaas/api/images?$filter=name eq '${img.template}'>`, name: img.template }]),
        ),
      };

      return {
        platform: PLATFORM,
        title: `${profileName} — ${sizes.length} flavor and ${images.length} image mappings`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'An administrator runs apply.sh per region; afterwards every template that names these sizes or images resolves through them' },
        scope: {
          what: `Every deployment in region ${regionId} whose template asks for ${sizeNames.join(', ')} or ${images.map((i) => i.key).join(', ') || 'any image'}.`,
          decidedBy: ['The region the profile is created in.', 'The mapping names, which templates refer to by string.', 'The zones on that region and the projects that use them.'],
          ifWrong: 'A size that is larger than intended is deployed at that size to every request that names it, until the mapping is edited; the machines already deployed keep the wrong size.',
        },
        guardrails: [
          { rule: 'Sizes checked to grow in both vCPU and memory', because: 'A mis-typed mapping produces a "large" smaller than "medium" and nobody finds out until someone complains about performance.' },
          { rule: `xlarge capped at a warning above 16 vCPU / 128 GB`, because: 'The largest self-service size is the one most often chosen "to be safe".' },
          { rule: 'Image ids resolved from the region, not typed', because: 'An image mapping to a template name that exists only in another vCenter fails at request time with an allocation error.' },
        ],
        dryRun: ['Run apply.sh without --execute.', 'GET /iaas/api/images?$filter=... for each template and put its id in the image payload before --execute.'],
        undo: ['DELETE /iaas/api/flavor-profiles/{id} and /iaas/api/image-profiles/{id}. Deployed machines are unaffected; new requests naming these mappings fail until they are replaced.'],
        told: ['Nobody. The audit log records the change.'],
        requires: ['The region, with data collection complete so templates are discovered.', 'Templates or content library items named as listed, in that region.'],
        files: {
          [`${base}-flavor-profile.json`]: json(flavor),
          [`${base}-image-profile.json`]: json(image),
          'apply.sh': applyScript(
            'vcf-automation',
            [
              { method: 'POST', path: '/iaas/api/flavor-profiles', payload: `${base}-flavor-profile.json` },
              { method: 'POST', path: '/iaas/api/image-profiles', payload: `${base}-image-profile.json` },
            ],
            'DELETE /iaas/api/flavor-profiles/{id} and /iaas/api/image-profiles/{id}.',
          ),
          'IMPORT.md': importMd({
            subject: 'Image and flavor mappings for one region.',
            steps: [
              setupOrderStep('vcfa_mappings'),
              apiStep('Mappings', 'apply.sh', [`\`${base}-flavor-profile.json\` → POST /iaas/api/flavor-profiles`, `\`${base}-image-profile.json\` → POST /iaas/api/image-profiles`], ['Fill each image id from GET /iaas/api/images first. A region that already has a profile needs a PATCH of that one instead of a second POST.']),
            ],
            auth: ['apply'],
            verify: [],
          }),
        },
        notes: [
          'One flavor profile and one image profile per region. A second POST for the same region may fail or may replace — GET /iaas/api/flavor-profiles?$filter=regionId eq ... first and PATCH if one exists.',
          'The image mapping entry’s fields (id, name, cloudConfig, constraints) vary a little by release. GET an existing image profile and match it.',
          'Content library items appear in /iaas/api/images once the content library is subscribed in the region and data collection has run.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_network_profile',
    platform: PLATFORM,
    label: 'A network profile with IP ranges and isolation',
    group: 'Infrastructure',
    description:
      'Which networks deployments in a region may use, whether VCF Automation may create networks on demand and how it isolates them, where addresses come from, and the capability tags templates use to pick a network. Overlapping CIDRs are checked before anything is sent.',
    inputs: [
      { id: 'profile_name', label: 'Profile name', control: 'text', default: 'dc1-app-networks' },
      { id: 'region_id', label: 'Region id', control: 'text', default: '<REQUIRED — GET /iaas/api/regions>' },
      {
        id: 'mode',
        label: 'Networks',
        control: 'select',
        options: [
          { value: 'existing', label: 'Existing segments only' },
          { value: 'on-demand', label: 'Existing plus on-demand (NSX)' },
        ],
        default: 'existing',
      },
      {
        id: 'isolation',
        label: 'Isolation policy',
        control: 'select',
        options: [
          { value: 'NONE', label: 'None' },
          { value: 'ON_DEMAND_NETWORK', label: 'On-demand network' },
          { value: 'ON_DEMAND_SECURITY_GROUP', label: 'On-demand security group' },
        ],
        default: 'NONE',
      },
      { id: 'existing_cidrs', label: 'Existing network CIDRs', control: 'text', default: '10.20.10.0/24, 10.20.11.0/24', hint: 'The segments the profile includes, for the overlap check' },
      { id: 'ondemand_cidr', label: 'On-demand address space', control: 'text', default: '10.200.0.0/16', showWhen: { input: 'mode', equals: ['on-demand'] } },
      { id: 'ondemand_prefix', label: 'Subnet size (prefix)', control: 'number', default: 28, min: 16, max: 29, showWhen: { input: 'mode', equals: ['on-demand'] } },
      {
        id: 'ipam',
        label: 'Addresses from',
        control: 'select',
        options: [
          { value: 'internal', label: 'VCF Automation internal IPAM' },
          { value: 'external', label: 'External IPAM integration (e.g. Infoblox)' },
          { value: 'dhcp', label: 'DHCP' },
        ],
        default: 'internal',
      },
      { id: 'range_start', label: 'Static range start', control: 'text', default: '10.20.10.50', showWhen: { input: 'ipam', equals: ['internal'] } },
      { id: 'range_end', label: 'Static range end', control: 'text', default: '10.20.10.200', showWhen: { input: 'ipam', equals: ['internal'] } },
      { id: 'security_groups', label: 'Security group ids', control: 'text', default: '', placeholder: 'from GET /iaas/api/security-groups' },
      { id: 'net_tags', label: 'Capability tags', control: 'text', default: 'net:app, site:dc1' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const profileName = str(values, 'profile_name', 'network-profile');
      const regionId = str(values, 'region_id', '<REQUIRED — GET /iaas/api/regions>');
      const mode = str(values, 'mode', 'existing');
      const isolation = str(values, 'isolation', 'NONE');
      const existing = listOf(str(values, 'existing_cidrs', ''));
      const onDemandCidr = mode === 'on-demand' ? str(values, 'ondemand_cidr', '') : '';
      const prefix = num(values, 'ondemand_prefix', 28);
      const ipam = str(values, 'ipam', 'internal');
      const rangeStart = str(values, 'range_start', '');
      const rangeEnd = str(values, 'range_end', '');
      const sgs = listOf(str(values, 'security_groups', ''));
      const tags = tagsOf(str(values, 'net_tags', ''));
      const base = slugOf(name || profileName, 'network-profile');

      const findings: Finding[] = [];
      if (mode === 'on-demand' && isolation === 'NONE') {
        findings.push(
          warning('vcfa.network.no-isolation', 'On-demand networks are allowed with no isolation policy.', {
            remediation: 'Without isolation, an "outbound" or "private" network in a template has nothing to be private from. Choose on-demand network (a new segment per deployment) or on-demand security group.',
            source: SRC,
          }),
        );
      }
      if (mode === 'existing' && isolation !== 'NONE') {
        findings.push(info('vcfa.network.isolation-unused', 'An isolation policy is set but only existing networks are offered, so it only applies to templates asking for private networks.', { source: SRC }));
      }
      const all = [...existing, ...(onDemandCidr ? [onDemandCidr] : [])];
      const ranges = all.map((cidr) => ({ cidr, range: cidrRange(cidr) }));
      for (const r of ranges) {
        if (!r.range) findings.push(error('vcfa.network.bad-cidr', `${r.cidr} is not an IPv4 CIDR.`, { source: SRC }));
      }
      for (let i = 0; i < ranges.length; i++) {
        for (let j = i + 1; j < ranges.length; j++) {
          const a = ranges[i]!.range;
          const b = ranges[j]!.range;
          if (a && b && a[0] <= b[1] && b[0] <= a[1]) {
            findings.push(
              error('vcfa.network.overlap', `${ranges[i]!.cidr} overlaps ${ranges[j]!.cidr}.`, {
                remediation: 'Two networks in one profile with overlapping addresses means two machines can be given the same IP. On-demand address space in particular must be carved out of nothing else.',
                source: SRC,
              }),
            );
          }
        }
      }
      if (ipam === 'internal') {
        const first = existing[0] ? cidrRange(existing[0]) : undefined;
        const toNum = (ip: string) => cidrRange(`${ip}/32`)?.[0];
        const s = toNum(rangeStart);
        const e = toNum(rangeEnd);
        if (s === undefined || e === undefined || s > e) {
          findings.push(error('vcfa.network.bad-range', `The static range ${rangeStart} – ${rangeEnd} is not a valid ascending range.`, { source: SRC }));
        } else if (first && (s < first[0] || e > first[1])) {
          findings.push(warning('vcfa.network.range-outside', `The static range is not inside ${existing[0]}, the first existing network.`, { source: SRC }));
        }
      }
      if (tags.length === 0) {
        findings.push(warning('vcfa.network.no-tags', 'No capability tags, so templates cannot choose this profile by constraint.', { source: SRC }));
      }

      const isolationType = isolation === 'ON_DEMAND_NETWORK' ? 'SUBNET' : isolation === 'ON_DEMAND_SECURITY_GROUP' ? 'SECURITY_GROUP' : 'NONE';
      const profile = {
        name: profileName,
        description: 'Generated by ArchToolKit.',
        regionId,
        fabricNetworkIds: existing.map((cidr) => `<REQUIRED — fabric network id for ${cidr}, from GET /iaas/api/fabric-networks>`),
        isolationType,
        ...(isolationType === 'SUBNET'
          ? {
              isolationNetworkDomainId: '<REQUIRED — NSX transport zone / network domain id>',
              isolationNetworkDomainCIDR: onDemandCidr || '<REQUIRED — address space>',
              isolatedNetworkCIDRPrefix: prefix,
              isolationExternalFabricNetworkId: '<REQUIRED — external network id for outbound access>',
            }
          : {}),
        securityGroupIds: sgs,
        tags,
        customProperties: {
          onDemandNetworkIPAssignmentType: ipam === 'dhcp' ? 'dynamic' : 'static',
          ...(mode === 'on-demand' ? { tier0LogicalRouterId: '<REQUIRED — Tier-0 gateway id>', edgeClusterRouterStateId: '<REQUIRED — edge cluster id>' } : {}),
        },
      };

      const range =
        ipam === 'internal'
          ? {
              name: `${profileName}-range`,
              description: 'Generated by ArchToolKit.',
              fabricNetworkIds: [`<REQUIRED — fabric network id for ${existing[0] ?? 'the network'}>`],
              startIPAddress: rangeStart,
              endIPAddress: rangeEnd,
              ipVersion: 'IPv4',
            }
          : undefined;

      const fabric = existing.map((cidr) => ({
        _path: `PATCH /iaas/api/fabric-networks-vsphere/<id for ${cidr}>`,
        cidr,
        defaultGateway: '<REQUIRED>',
        dnsServerAddresses: ['<REQUIRED>'],
        domain: '<REQUIRED>',
        tags,
      }));

      return {
        platform: PLATFORM,
        title: `${profileName} — ${mode === 'on-demand' ? 'existing and on-demand' : 'existing'} networks, ${isolation.toLowerCase().replace(/_/g, ' ')} isolation`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'An administrator runs apply.sh per region; afterwards every machine placed in the region takes its network and address from here' },
        scope: {
          what: `Network placement and IP allocation for every deployment in region ${regionId} whose network constraints match ${tags.map((t) => `${t.key}:${t.value}`).join(', ') || '(anything)'}.`,
          decidedBy: [
            'The region the profile is in.',
            'The existing networks listed, each matched by its own tags.',
            mode === 'on-demand' ? `The on-demand address space ${onDemandCidr}, cut into /${prefix} subnets.` : 'No on-demand networks.',
            `The IPAM source: ${ipam}.`,
            'The network constraints in each template.',
          ],
          ifWrong: 'A machine is given an address that is already in use, or attached to a network that routes somewhere it should not. Both happen at deployment time and look like a guest OS problem.',
        },
        guardrails: [
          { rule: 'CIDRs in the profile checked for overlap before sending', because: 'Overlapping ranges in one profile are the usual cause of duplicate IPs between self-service machines.' },
          { rule: `Isolation: ${isolation}`, because: mode === 'on-demand' ? 'On-demand networks without isolation are just more flat networks with a nicer name.' : 'Written down, so a template asking for a private network fails clearly rather than getting a shared one.' },
          ...(ipam === 'internal' ? [{ rule: `Static range ${rangeStart} – ${rangeEnd} only`, because: 'The range leaves the gateway, infrastructure and anything allocated by hand outside what VCF Automation hands out.' }] : []),
        ],
        dryRun: ['Run apply.sh without --execute.', 'Fill every <REQUIRED> id from GET /iaas/api/fabric-networks and the NSX objects before --execute; the POST fails on a placeholder rather than guessing.'],
        undo: ['DELETE /iaas/api/network-profiles/{id} and /iaas/api/network-ip-ranges/{id}. Machines keep their addresses; allocations recorded in internal IPAM are released only when the machines are deleted.'],
        told: ['Nobody by VCF Automation. If an external IPAM is used, its own audit log records each allocation.'],
        requires: [
          'The existing segments discovered in the region, with CIDR, gateway and DNS set on each fabric network (fabric-networks.json).',
          ...(mode === 'on-demand' ? ['An NSX cloud account associated with the vSphere account, a Tier-0 gateway and an edge cluster.'] : []),
          ...(ipam === 'external' ? ['An IPAM integration configured under Integrations, with its IP ranges discovered and assigned to these networks.'] : []),
        ],
        files: {
          [`${base}.json`]: json(profile),
          ...(range ? { [`${base}-ip-range.json`]: json(range) } : {}),
          'fabric-networks.json': json(fabric),
          'apply.sh': applyScript(
            'vcf-automation',
            [
              ...(range ? [{ method: 'POST' as const, path: '/iaas/api/network-ip-ranges', payload: `${base}-ip-range.json` }] : []),
              { method: 'POST', path: '/iaas/api/network-profiles', payload: `${base}.json` },
            ],
            'DELETE /iaas/api/network-profiles/{id}, then /iaas/api/network-ip-ranges/{id}.',
          ),
          'IMPORT.md': importMd({
            subject: 'A network profile and its IP range.',
            steps: [
              setupOrderStep('vcfa_network_profile'),
              apiStep('Network profile', 'apply.sh', [...(range ? [`\`${base}-ip-range.json\` → POST /iaas/api/network-ip-ranges`] : []), `\`${base}.json\` → POST /iaas/api/network-profiles`], ['Fill the fabric network ids from GET /iaas/api/fabric-networks first; fabric-networks.json lists the PATCH each network needs.']),
            ],
            auth: ['apply'],
            verify: [],
          }),
        },
        notes: [
          'The interface calls them "on-demand network" and "on-demand security group"; the API field isolationType takes NONE, SUBNET and SECURITY_GROUP. The payload maps one to the other.',
          'The NSX-related custom properties (Tier-0, edge cluster) have changed names between releases. GET an existing network profile that uses on-demand networks and copy its shape.',
          'fabric-networks.json is not sent by apply.sh: each entry is a PATCH against a discovered network, and the ids have to be looked up first.',
          ...(ipam === 'external' ? ['With external IPAM, IP ranges come from the provider via the integration and are not created here; assign them to the networks in the interface or via /iaas/api/external-network-ip-ranges.'] : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_storage_profile',
    platform: PLATFORM,
    label: 'A vSphere storage profile',
    group: 'Infrastructure',
    description:
      'Where disks go and how they are provisioned: a storage policy or a datastore, thin or thick, an IOPS limit, and the capability tags templates use to ask for it — with a check on the choices that are expensive to have made the default.',
    inputs: [
      { id: 'profile_name', label: 'Profile name', control: 'text', default: 'dc1-vsan-standard' },
      { id: 'region_id', label: 'Region id', control: 'text', default: '<REQUIRED — GET /iaas/api/regions>' },
      { id: 'storage_policy', label: 'Storage policy name', control: 'text', default: 'vSAN Default Storage Policy', hint: 'Looked up to an id; leave empty to use a datastore' },
      { id: 'datastore', label: 'Datastore name', control: 'text', default: '', hint: 'Used only when there is no storage policy' },
      {
        id: 'provisioning',
        label: 'Disk type',
        control: 'select',
        options: [
          { value: 'thin', label: 'Thin' },
          { value: 'thick', label: 'Thick, lazy zeroed' },
          { value: 'eagerZeroedThick', label: 'Thick, eager zeroed' },
        ],
        default: 'thin',
      },
      { id: 'limit_iops', label: 'IOPS limit per disk', control: 'number', default: 0, min: 0, max: 1000000, hint: '0 is no limit' },
      { id: 'default_item', label: 'Default for the region', control: 'toggle', default: true },
      { id: 'storage_tags', label: 'Capability tags', control: 'text', default: 'storage:standard' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const profileName = str(values, 'profile_name', 'storage-profile');
      const regionId = str(values, 'region_id', '<REQUIRED — GET /iaas/api/regions>');
      const policy = str(values, 'storage_policy', '');
      const datastore = str(values, 'datastore', '');
      const provisioning = str(values, 'provisioning', 'thin');
      const iops = num(values, 'limit_iops', 0);
      const isDefault = bool(values, 'default_item', true);
      const tags = tagsOf(str(values, 'storage_tags', ''));
      const base = slugOf(name || profileName, 'storage-profile');

      const findings: Finding[] = [];
      if (!policy && !datastore) {
        findings.push(error('vcfa.storage.no-target', 'Neither a storage policy nor a datastore is given, so disks have nowhere to go.', { source: SRC }));
      }
      if (policy && datastore) {
        findings.push(info('vcfa.storage.both', 'Both a storage policy and a datastore are set. The datastore pins placement and the policy then only decides compliance.', { source: SRC }));
      }
      if (isDefault && provisioning === 'eagerZeroedThick') {
        findings.push(
          warning('vcfa.storage.ezt-default', 'Eager-zeroed thick is the default disk type for everything in this region.', {
            remediation: 'Every disk is written in full before the machine powers on — a 500 GB disk is 500 GB of writes and minutes of wait — and none of it is reclaimable. Keep it in a separate, tagged profile for the workloads that need it (clustered disks, some databases).',
            source: SRC,
          }),
        );
      } else if (isDefault && provisioning === 'thick') {
        findings.push(info('vcfa.storage.thick-default', 'Thick provisioning by default reserves every requested gigabyte whether it is used or not.', { source: SRC }));
      }
      if (isDefault && iops > 0) {
        findings.push(
          warning('vcfa.storage.default-iops', `The default profile caps every disk at ${iops} IOPS.`, {
            remediation: 'A cap on the default applies to databases as well as web servers. Put limits on a named tier that templates choose, not on the default.',
            source: SRC,
          }),
        );
      }
      if (tags.length === 0 && !isDefault) {
        findings.push(warning('vcfa.storage.unreachable', 'This profile is not the default and has no tags, so nothing can select it.', { source: SRC }));
      }

      const profile = {
        name: profileName,
        description: 'Generated by ArchToolKit.',
        regionId,
        defaultItem: isDefault,
        ...(policy ? { storagePolicyId: `<REQUIRED — id of "${policy}" from GET /iaas/api/fabric-vsphere-storage-policies>` } : {}),
        ...(datastore ? { datastoreId: `<REQUIRED — id of "${datastore}" from GET /iaas/api/fabric-vsphere-datastores>` } : {}),
        provisioningType: provisioning,
        diskType: 'standard',
        ...(iops > 0 ? { limitIops: String(iops) } : {}),
        sharesLevel: 'normal',
        tags,
      };

      return {
        platform: PLATFORM,
        title: `${profileName} — ${provisioning} disks on ${policy || datastore || 'no target'}${isDefault ? ', region default' : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'An administrator runs apply.sh per region; afterwards every disk placed in the region with matching constraints — or none, if this is the default — uses it' },
        scope: {
          what: isDefault ? `Every disk in region ${regionId} whose template does not ask for a specific storage tag.` : `Disks in region ${regionId} whose template constrains storage to ${tags.map((t) => `${t.key}:${t.value}`).join(', ')}.`,
          decidedBy: ['The region.', isDefault ? 'The default flag: templates with no storage constraint land here.' : 'The capability tags matched against template storage constraints.', policy ? `The storage policy "${policy}" and which datastores are compatible with it.` : `The datastore "${datastore}".`],
          ifWrong: 'Every new disk in the region is provisioned the expensive or the slow way until the profile is changed, and existing disks keep it.',
        },
        guardrails: [
          { rule: `Disk type ${provisioning}${isDefault ? ' on the default' : ''}`, because: 'Eager-zeroed thick as a default is the usual reason a self-service VM takes ten minutes to power on and a datastore fills in a week.' },
          { rule: iops > 0 ? `${iops} IOPS limit per disk` : 'No IOPS limit on this profile', because: 'Limits belong on a tier that is chosen; a limit on the default throttles workloads that never asked for it.' },
          { rule: 'Storage policy or datastore resolved by id, not by name in the payload', because: 'Two datastores with the same name in two clusters is common, and the API does not choose between them for you.' },
        ],
        dryRun: ['Run apply.sh without --execute.', 'Resolve each <REQUIRED> id and confirm which datastores the storage policy is compatible with in this region before --execute.'],
        undo: ['DELETE /iaas/api/storage-profiles/{id}. Existing disks are unaffected. If it was the default, another profile must be made default first or new requests without a storage constraint fail.'],
        told: ['Nobody. The audit log records the change.'],
        requires: ['The region with data collection complete, so storage policies and datastores are discovered.'],
        files: {
          [`${base}.json`]: json(profile),
          'apply.sh': applyScript('vcf-automation', [{ method: 'POST', path: '/iaas/api/storage-profiles-vsphere', payload: `${base}.json` }], 'DELETE /iaas/api/storage-profiles-vsphere/{id}.'),
          'IMPORT.md': importMd({
            subject: 'A vSphere storage profile.',
            steps: [
              setupOrderStep('vcfa_storage_profile'),
              apiStep('Storage profile', 'apply.sh', [`\`${base}.json\` → POST /iaas/api/storage-profiles-vsphere`], ['Fill the region, storage policy and datastore ids first.']),
            ],
            auth: ['apply'],
            verify: [],
          }),
        },
        notes: [
          'provisioningType takes thin, thick and eagerZeroedThick in 8.x. limitIops is a string in some releases and a number in others — GET an existing vSphere storage profile and match it.',
          'Only one profile per region should be the default. A second default makes which one wins depend on ordering.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_catalog',
    platform: PLATFORM,
    label: 'A catalogue content source and who it is shared with',
    group: 'Catalogue',
    description:
      'Templates imported from a repository branch into a project, a Service Broker content source that brings them into the catalogue, and a content-sharing policy that decides which groups see them. Sharing is where catalogues go wrong: an item shared to every project is an item every project can request.',
    inputs: [
      { id: 'source_name', label: 'Content source name', control: 'text', default: 'platform-templates' },
      {
        id: 'source_type',
        label: 'Templates come from',
        control: 'select',
        options: [
          { value: 'com.gitlab', label: 'GitLab repository' },
          { value: 'com.github', label: 'GitHub repository' },
          { value: 'com.vmw.blueprint', label: 'Released templates in a project (no repository)' },
        ],
        default: 'com.gitlab',
      },
      { id: 'repository', label: 'Repository', control: 'text', default: 'platform/vcfa-templates', showWhen: { input: 'source_type', notEquals: ['com.vmw.blueprint'] } },
      { id: 'branch', label: 'Branch', control: 'text', default: 'release', showWhen: { input: 'source_type', notEquals: ['com.vmw.blueprint'] } },
      { id: 'path', label: 'Folder in the repository', control: 'text', default: 'templates', showWhen: { input: 'source_type', notEquals: ['com.vmw.blueprint'] } },
      { id: 'source_project', label: 'Source project id', control: 'text', default: '<REQUIRED — GET /iaas/api/projects>' },
      {
        id: 'share_to',
        label: 'Share to',
        control: 'select',
        options: [
          { value: 'groups', label: 'Named groups in one project' },
          { value: 'project', label: 'Every member of one project' },
          { value: 'all', label: 'Every project in the organisation' },
        ],
        default: 'groups',
      },
      { id: 'share_groups', label: 'Groups', control: 'text', default: 'vcfa-finance-users@example.com', showWhen: { input: 'share_to', equals: ['groups'] } },
      { id: 'consumer_project', label: 'Project it is shared in', control: 'text', default: '<REQUIRED — consuming project id>', showWhen: { input: 'share_to', notEquals: ['all'] } },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const sourceName = str(values, 'source_name', 'content-source');
      const type = str(values, 'source_type', 'com.gitlab');
      const git = type !== 'com.vmw.blueprint';
      const repo = str(values, 'repository', '');
      const branch = str(values, 'branch', 'main');
      const path = str(values, 'path', '');
      const sourceProject = str(values, 'source_project', '<REQUIRED>');
      const shareTo = str(values, 'share_to', 'groups');
      const groups = listOf(str(values, 'share_groups', ''));
      const consumer = str(values, 'consumer_project', '<REQUIRED>');
      const base = slugOf(name || sourceName, 'catalog');

      const findings: Finding[] = [];
      if (shareTo === 'all') {
        findings.push(
          warning('vcfa.catalog.share-all', 'The content is shared to every project in the organisation.', {
            remediation: 'Every project that is created from now on sees these items too, with its own quotas and zones. Share per project, to groups, so adding a catalogue item is a decision about who gets it.',
            source: SRC,
          }),
        );
      } else if (shareTo === 'project') {
        findings.push(info('vcfa.catalog.share-project', 'Shared to every member of the project, including members added later for other reasons.', { source: SRC }));
      }
      if (shareTo === 'groups' && groups.length === 0) {
        findings.push(error('vcfa.catalog.no-groups', 'Sharing to groups was chosen and no group is named, so nobody will see the items.', { source: SRC }));
      }
      if (git && !/^(release|releases?\/.+|main|master|prod(uction)?)$/i.test(branch)) {
        findings.push(
          warning('vcfa.catalog.branch', `Templates are imported from the branch "${branch}", which does not look like a release branch.`, {
            remediation: 'The content source imports on every commit to that branch. A feature or development branch means an unreviewed change is in the catalogue within the sync interval. Point it at a protected branch that is only merged into.',
            source: SRC,
          }),
        );
      }
      if (git && !repo) {
        findings.push(error('vcfa.catalog.no-repo', 'A repository source was chosen with no repository.', { source: SRC }));
      }

      const gitSource = git
        ? {
            name: `${sourceName}-git`,
            typeId: type,
            projectId: sourceProject,
            description: 'Generated by ArchToolKit. Imports cloud templates from the repository into the project.',
            syncEnabled: true,
            config: {
              integrationId: `<REQUIRED — the ${type === 'com.gitlab' ? 'GitLab' : 'GitHub'} integration id, from GET /iaas/api/integrations>`,
              repository: repo,
              branch,
              path,
              contentType: 'blueprint',
            },
          }
        : undefined;

      const catalogSource = {
        name: sourceName,
        typeId: 'com.vmw.blueprint',
        description: 'Generated by ArchToolKit. Brings the project’s released cloud templates into the catalogue.',
        config: { sourceProjectId: sourceProject },
      };

      const principals =
        shareTo === 'groups' ? groups.map((g) => ({ type: 'GROUP', referenceId: g })) : [{ type: 'PROJECT', referenceId: '' }];
      const sharing = {
        name: `${sourceName} — sharing`,
        description: 'Generated by ArchToolKit.',
        typeId: 'com.vmware.policy.catalog.entitlement',
        enforcementType: 'HARD',
        ...(shareTo === 'all' ? {} : { projectId: consumer }),
        definition: {
          entitledUsers: [
            {
              userType: 'USER',
              principals,
              items: [{ id: '__CATALOG_SOURCE_ID__', type: 'CATALOG_SOURCE_IDENTIFIER' }],
            },
          ],
        },
      };

      const steps: ChainStep[] = [
        ...(gitSource ? [{ method: 'POST' as const, path: '/content/api/sources', payload: `${base}-git-source.json`, captureAs: 'GIT_SOURCE_ID' }] : []),
        { method: 'POST', path: '/catalog/api/admin/sources', payload: `${base}-catalog-source.json`, captureAs: 'CATALOG_SOURCE_ID' },
        { method: 'POST', path: '/policy/api/policies', payload: `${base}-sharing-policy.json`, captureAs: 'SHARING_POLICY_ID' },
      ];

      return {
        platform: PLATFORM,
        title: `${sourceName} — ${git ? `${repo}@${branch}` : 'released templates'} shared to ${shareTo === 'groups' ? groups.join(', ') : shareTo === 'project' ? 'one project' : 'every project'}`,
        effect: 'reversible',
        trigger: git
          ? { kind: 'commit', detail: `A commit to ${branch} in ${repo} is imported at the next sync, and any version marked released appears in the catalogue`, worstCase: 'on every commit to the branch, within the sync interval — nobody approves the individual import' }
          : { kind: 'manual', detail: 'A template version is released in the source project, and the content source picks it up at its next import' },
        scope: {
          what: `Every catalogue item imported from ${git ? `${repo}/${path} on ${branch}` : `project ${sourceProject}`}, visible to ${shareTo === 'groups' ? groups.join(', ') : shareTo === 'project' ? `every member of project ${consumer}` : 'every project in the organisation'}.`,
          decidedBy: [
            git ? `What is merged into ${branch}, and which versions are released.` : 'Which template versions are released in the source project.',
            'The content source, which imports every released template from the source project.',
            'The sharing policy: which project, and which principals within it.',
            'The consuming project’s zones and quotas, which decide where a request lands.',
          ],
          ifWrong: 'A template meant for one team appears in every team’s catalogue, and the first anyone knows is a request placed in their zones against their quota.',
        },
        guardrails: [
          { rule: git ? `Imports from ${branch} only` : 'Imports released versions only', because: 'A catalogue fed from a working branch publishes whatever was pushed last, reviewed or not.' },
          { rule: shareTo === 'all' ? 'Shared organisation-wide — see the finding' : shareTo === 'project' ? 'Shared to one project' : 'Shared to named groups in one project', because: 'Sharing is what turns a template into something a person can request. It is the change control on the catalogue.' },
          { rule: 'Sharing policy created after, and referring to, the content source', because: 'A sharing policy that names a source id from another environment silently shares nothing.' },
        ],
        dryRun: ['Run apply.sh without --execute.', 'After --execute, open Service Broker → Content as a member of one of the groups rather than as an administrator, and check exactly which items appear.'],
        undo: [
          'DELETE /policy/api/policies/{id} first: the items disappear from the catalogue at once.',
          'Then DELETE /catalog/api/admin/sources/{id}' + (git ? ' and /content/api/sources/{id}' : '') + ', by the ids in created-ids.txt. Existing deployments are unaffected.',
        ],
        told: ['Nobody when an item is imported. The repository’s merge request is the record — which is why the branch has to be one that is only merged into.'],
        requires: [
          ...(git ? [`A ${type === 'com.gitlab' ? 'GitLab' : 'GitHub'} integration in VCF Automation with read access to ${repo}.`] : []),
          'The source project and the consuming project.',
          'Directory groups synchronised and members of the consuming project.',
          'jq on the machine running apply.sh.',
        ],
        files: {
          ...(gitSource ? { [`${base}-git-source.json`]: json(gitSource) } : {}),
          [`${base}-catalog-source.json`]: json(catalogSource),
          [`${base}-sharing-policy.json`]: json(sharing),
          'apply.sh': chainScript(`Create the ${sourceName} content source and its sharing policy.`, steps, 'DELETE the sharing policy, then the catalog source, then the repository source, by the ids in created-ids.txt.'),
          'IMPORT.md': importMd({
            subject: `The content source ${sourceName} and who it is shared with.`,
            steps: [
              setupOrderStep('vcfa_catalog'),
              ...(git
                ? [
                    manualStep('Lay out the repository', [
                      `The repository source imports cloud templates from ${repo || 'the repository'}${path ? `, folder ${path}` : ''}, branch ${branch}. Each template must be its own folder holding a file named \`blueprint.yaml\` with \`name:\` and \`version:\` at the top — exactly the \`import/templates/<name>/\` folders the template blueprints on this page generate. Copy those folders in and commit.`,
                    ]),
                  ]
                : []),
              apiStep('Content source and sharing', 'apply.sh', [
                ...(git ? [`\`${base}-git-source.json\` → POST /content/api/sources (the repository, imported into the project)`] : []),
                `\`${base}-catalog-source.json\` → POST /catalog/api/admin/sources (released templates of the project, into the catalogue)`,
                `\`${base}-sharing-policy.json\` → POST /policy/api/policies, with the catalog source id from the call before`,
              ], ['Fill the `<REQUIRED>` project and integration ids first.']),
            ],
            auth: ['apply'],
            verify: ['The repository source config field names are the least certain part; GET an existing one and match it.'],
          }),
        },
        notes: [
          'The repository source (/content/api/sources, typeId com.gitlab or com.github) and the catalogue source (/catalog/api/admin/sources, typeId com.vmw.blueprint) are two different objects in two services. The field names in the repository source config are the least certain part here — GET an existing one and match it.',
          'The principal types in the sharing policy (PROJECT, GROUP, USER) and the item type CATALOG_SOURCE_IDENTIFIER are as 8.x writes them. Export an existing content-sharing policy with GET /policy/api/policies?typeId=com.vmware.policy.catalog.entitlement and compare.',
          'A custom request form is a separate object (/form-service/api/forms) per catalogue item. Create it after the item exists; a form that hides an input does not constrain it — the template’s enum does.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_naming',
    platform: PLATFORM,
    label: 'A custom naming template',
    group: 'Projects',
    description:
      'How machines are named, for every project that uses it: a pattern built from project and request properties with a counter, checked against the two limits that bite later — running out of counter digits, and the 15-character NetBIOS limit on Windows machine names.',
    inputs: [
      { id: 'naming_name', label: 'Template name', control: 'text', default: 'standard-machine-names' },
      { id: 'pattern', label: 'Pattern', control: 'text', default: '${project.name}-${resource.environment}-${###}', hint: '${###} is the counter; its width is the number of #' },
      { id: 'sample_project', label: 'Longest project name it will see', control: 'text', default: 'fin', hint: 'Used to check the length' },
      { id: 'sample_env', label: 'Longest environment value', control: 'text', default: 'prd' },
      { id: 'start_counter', label: 'Counter starts at', control: 'number', default: 1, min: 0, max: 999999 },
      { id: 'projected', label: 'Machines expected per project, ever', control: 'number', default: 500, min: 1, max: 10000000, hint: 'The counter is not reused when machines are deleted' },
      { id: 'windows', label: 'Used for Windows machines', control: 'toggle', default: true },
      {
        id: 'scope',
        label: 'Applies to',
        control: 'select',
        options: [
          { value: 'org', label: 'The organisation — the default for every project' },
          { value: 'projects', label: 'Named projects only' },
        ],
        default: 'org',
      },
      { id: 'project_ids', label: 'Project ids', control: 'text', default: '', showWhen: { input: 'scope', equals: ['projects'] } },
      { id: 'counter_scope', label: 'Counter shared across projects', control: 'toggle', default: false, hint: 'Off: each project counts from the start' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const namingName = str(values, 'naming_name', 'naming');
      const pattern = str(values, 'pattern', '${project.name}-${###}');
      const sampleProject = str(values, 'sample_project', 'project');
      const sampleEnv = str(values, 'sample_env', 'env');
      const start = num(values, 'start_counter', 1);
      const projected = num(values, 'projected', 500);
      const windows = bool(values, 'windows', true);
      const scope = str(values, 'scope', 'org');
      const projectIds = listOf(str(values, 'project_ids', ''));
      const shared = bool(values, 'counter_scope', false);
      const base = slugOf(name || namingName, 'naming');

      const digits = (/\$\{(#+)\}/.exec(pattern)?.[1] ?? '').length;
      const samples: Record<string, string> = { 'project.name': sampleProject, 'resource.environment': sampleEnv };
      const example = pattern.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
        if (/^#+$/.test(key)) return String(start + projected - 1).padStart(key.length, '0');
        return samples[key] ?? 'xxxx';
      });

      const findings: Finding[] = [];
      if (digits === 0) {
        findings.push(
          error('vcfa.naming.no-counter', 'The pattern has no ${###} counter, so the second machine gets the same name as the first.', {
            remediation: 'Add a counter. Uniqueness is checked at request time, and a clash fails the deployment rather than renaming it.',
            source: SRC,
          }),
        );
      } else if (start + projected - 1 >= 10 ** digits) {
        findings.push(
          warning('vcfa.naming.counter-width', `${digits} counter digit(s) run out at ${10 ** digits - 1}, and ${projected} machines are expected.`, {
            remediation: 'The counter is not reused when machines are deleted. When it overflows, names grow a digit — breaking any regex, CMDB rule or sort that assumed a fixed width. Size it for the lifetime of the project.',
            source: SRC,
          }),
        );
      }
      if (/xxxx/.test(example)) {
        findings.push(info('vcfa.naming.unknown-length', 'The pattern uses properties whose length is not known here; each was counted as four characters.', { source: SRC }));
      }
      if (windows && example.length > 15) {
        findings.push(
          error('vcfa.naming.netbios', `A name from this pattern can be ${example.length} characters (${example}), over the 15-character NetBIOS limit for Windows.`, {
            remediation: 'Windows truncates the computer name to 15 characters, so the guest name no longer matches the VM name and two machines can collide in the domain. Shorten the pattern, or use a separate template for Windows machines.',
            source: SRC,
          }),
        );
      } else if (example.length > 63) {
        findings.push(error('vcfa.naming.dns', `A name from this pattern can be ${example.length} characters, beyond the 63-character DNS label limit.`, { source: SRC }));
      }
      if (/[^A-Za-z0-9-]/.test(example)) {
        findings.push(warning('vcfa.naming.characters', `The example name "${example}" has characters other than letters, digits and hyphens, which are not valid in a hostname.`, { source: SRC }));
      }
      if (scope === 'projects' && projectIds.length === 0) {
        findings.push(error('vcfa.naming.no-projects', 'Named projects was chosen and no project is listed.', { source: SRC }));
      }

      const naming = {
        name: namingName,
        description: 'Generated by ArchToolKit.',
        projects:
          scope === 'org'
            ? [{ orgDefault: true, active: true, orgId: '<REQUIRED — organisation id>' }]
            : projectIds.map((projectId) => ({ projectId, active: true, orgDefault: false })),
        templates: [
          {
            name: `${namingName}-machine`,
            resourceType: 'COMPUTE',
            resourceTypeName: 'Machine',
            pattern,
            staticPattern: '',
            startCounter: start,
            incrementStep: 1,
            uniqueName: true,
            counterScope: shared ? 'ORG' : 'PROJECT',
          },
        ],
      };

      return {
        platform: PLATFORM,
        title: `${namingName} — ${pattern}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'Every machine requested in a project the template applies to is named by it at allocation time', worstCase: 'once per machine, for the life of every project it applies to' },
        scope: {
          what: scope === 'org' ? 'Every machine in every project that does not have its own naming template.' : `Every machine in project(s) ${projectIds.join(', ')}.`,
          decidedBy: [
            scope === 'org' ? 'The organisation default flag.' : 'The project list.',
            'Whether a project also sets its own machineNamingTemplate, which the custom naming template supersedes.',
            'The properties the pattern reads, from the project and the request.',
          ],
          ifWrong: 'Machines are named in a way that breaks something downstream — a Windows name truncated in the domain, a CMDB match rule, a backup selection by prefix — for every machine until the template is changed. Existing names are not changed back.',
        },
        guardrails: [
          { rule: `${digits}-digit counter for ${projected} expected machines`, because: 'A counter that overflows grows a digit and breaks every fixed-width assumption downstream.' },
          { rule: windows ? 'Checked against the 15-character NetBIOS limit' : 'Checked against the 63-character DNS label limit', because: 'Windows silently truncates to 15 characters, and two truncated names collide in Active Directory.' },
          { rule: 'uniqueName is on', because: 'A duplicate name fails the request at allocation instead of creating a second machine with the same name.' },
        ],
        dryRun: ['Run apply.sh without --execute.', `The longest name this pattern produces with the samples given is ${example} (${example.length} characters). Try it with your longest real project name.`],
        undo: ['DELETE /iaas/api/naming/{id}. Projects fall back to their own template or the default. Names already given stay.'],
        told: ['Nobody. The name appears in the deployment and in vCenter.'],
        requires: ['The organisation id, or the project ids.', ...(pattern.includes('resource.environment') ? ['An environment custom property on every machine resource — set by the template input — or the name contains an empty segment.'] : [])],
        files: {
          [`${base}.json`]: json(naming),
          'apply.sh': applyScript('vcf-automation', [{ method: 'POST', path: '/iaas/api/naming', payload: `${base}.json` }], 'DELETE /iaas/api/naming/{id}.'),
          'IMPORT.md': importMd({
            subject: 'A custom naming template.',
            steps: [
              setupOrderStep('vcfa_naming'),
              apiStep('Custom naming', 'apply.sh', [`\`${base}.json\` → POST /iaas/api/naming`], ['By hand: Infrastructure → Custom naming → New, with the same template.']),
            ],
            auth: ['apply'],
            verify: ['The naming field names are the least certain in the set: GET /iaas/api/naming on a system with one configured and match it.'],
          }),
        },
        notes: [
          'Custom naming arrived in 8.x at /iaas/api/naming. The template field names (resourceType, counterScope and so on) are the least certain in this set — GET /iaas/api/naming on a system with one configured and match it.',
          'The counter is persisted per template and scope and is not reused when machines are deleted. Starting a new template restarts it — which can collide with names that still exist.',
          'Templates exist per resource type. This writes one for machines; networks, load balancers and security groups keep the default until given their own.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_property_group',
    platform: PLATFORM,
    label: 'A property group shared across templates',
    group: 'Catalogue',
    description:
      'A set of inputs or constants defined once and referenced by every template — standard tags, a backup policy, the operating systems offered — so changing the list is one edit rather than forty. Includes the YAML showing how a template refers to it.',
    inputs: [
      { id: 'group_name', label: 'Property group name', control: 'text', default: 'backupPolicy', hint: 'Letters and digits; used in ${propgroup.<name>...}' },
      {
        id: 'kind',
        label: 'Contents',
        control: 'select',
        options: [
          { value: 'backup', label: 'Backup policy — constants' },
          { value: 'tags', label: 'Standard tags — inputs' },
          { value: 'os', label: 'Operating system choices — inputs' },
        ],
        default: 'backup',
      },
      { id: 'backup_tier', label: 'Backup tier', control: 'select', options: [{ value: 'gold', label: 'Gold — daily, 35 days' }, { value: 'silver', label: 'Silver — daily, 14 days' }, { value: 'bronze', label: 'Bronze — weekly, 30 days' }], default: 'silver', showWhen: { input: 'kind', equals: ['backup'] } },
      { id: 'os_list', label: 'Operating systems', control: 'text', default: 'rhel9, ubuntu24, win2022', hint: 'Image mapping names', showWhen: { input: 'kind', equals: ['os'] } },
      { id: 'environments', label: 'Environments', control: 'text', default: 'dev, test, prod', showWhen: { input: 'kind', equals: ['tags'] } },
      { id: 'shared', label: 'Available to every project', control: 'toggle', default: true },
      { id: 'project_id', label: 'Project id', control: 'text', default: '<REQUIRED — project id>', showWhen: { input: 'shared', equals: ['false'] } },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const groupName = str(values, 'group_name', 'standard');
      const kind = str(values, 'kind', 'backup');
      const tier = str(values, 'backup_tier', 'silver');
      const osList = listOf(str(values, 'os_list', 'rhel9'));
      const envs = listOf(str(values, 'environments', 'dev, test, prod'));
      const shared = bool(values, 'shared', true);
      const projectId = str(values, 'project_id', '<REQUIRED>');
      const base = slugOf(name || groupName, 'property-group');
      const type = kind === 'backup' ? 'CONSTANT' : 'INPUT';

      const findings: Finding[] = [];
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(groupName)) {
        findings.push(
          error('vcfa.propgroup.name', `"${groupName}" cannot be used in a template expression.`, {
            remediation: 'The name appears in ${propgroup.<name>.<property>} and in /ref/property-groups/<name>. Start with a letter and use only letters, digits and underscores.',
            source: SRC,
          }),
        );
      }
      if (kind === 'os' && osList.length === 0) findings.push(error('vcfa.propgroup.no-os', 'No operating systems listed.', { source: SRC }));
      if (kind === 'tags' && envs.length === 0) findings.push(error('vcfa.propgroup.no-envs', 'No environments listed.', { source: SRC }));
      if (shared && type === 'CONSTANT') {
        findings.push(info('vcfa.propgroup.shared-constant', 'A shared constant group changes every template that refers to it the next time each is deployed — which is the point, and also the risk.', { source: SRC }));
      }

      const retention: Record<string, [string, number]> = { gold: ['daily', 35], silver: ['daily', 14], bronze: ['weekly', 30] };
      const [schedule, days] = retention[tier] ?? ['daily', 14];

      const properties: Record<string, unknown> =
        kind === 'backup'
          ? {
              backupTier: { type: 'string', const: tier },
              backupSchedule: { type: 'string', const: schedule },
              backupRetentionDays: { type: 'integer', const: days },
            }
          : kind === 'os'
            ? { image: { type: 'string', title: 'Operating system', enum: osList, default: osList[0] ?? '' } }
            : {
                environment: { type: 'string', title: 'Environment', enum: envs, default: envs[0] ?? '' },
                owner: { type: 'string', title: 'Owner email', pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+$' },
                costCode: { type: 'string', title: 'Cost code', pattern: '^[A-Z]{2,4}-[0-9]{3,6}$' },
              };

      const group = {
        name: groupName,
        displayName: groupName,
        description: 'Generated by ArchToolKit.',
        type,
        ...(shared ? {} : { projectId }),
        properties,
      };

      const example =
        type === 'CONSTANT'
          ? [
              `# How a cloud template uses the constant property group "${groupName}".`,
              'formatVersion: 1',
              'resources:',
              '  server:',
              '    type: Cloud.vSphere.Machine',
              '    properties:',
              '      image: rhel9',
              '      flavor: small',
              '      tags:',
              '        - key: backupTier',
              `          value: \${propgroup.${groupName}.backupTier}`,
              '        - key: backupRetentionDays',
              `          value: \${propgroup.${groupName}.backupRetentionDays}`,
              '',
            ]
          : [
              `# How a cloud template uses the input property group "${groupName}".`,
              'formatVersion: 1',
              'inputs:',
              `  ${groupName}:`,
              '    type: object',
              `    $ref: /ref/property-groups/${groupName}`,
              'resources:',
              '  server:',
              '    type: Cloud.vSphere.Machine',
              '    properties:',
              ...(kind === 'os'
                ? [`      image: \${input.${groupName}.image}`, '      flavor: small']
                : [
                    '      image: rhel9',
                    '      flavor: small',
                    '      tags:',
                    '        - key: environment',
                    `          value: \${input.${groupName}.environment}`,
                    '        - key: owner',
                    `          value: \${input.${groupName}.owner}`,
                    '        - key: costCode',
                    `          value: \${input.${groupName}.costCode}`,
                  ]),
              '',
            ];

      const imported = importBundle({
        templates: [{ name: `${groupName} property group example`, description: `Generated by ArchToolKit. Uses the ${type.toLowerCase()} property group ${groupName}.`, yaml: example.join('\n') }],
      });

      return {
        platform: PLATFORM,
        title: `${groupName} — ${type.toLowerCase()} property group${shared ? ', shared' : ''}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'Read by every template that refers to it, each time one of those templates is requested or updated' },
        scope: {
          what: shared ? 'Every cloud template in any project that refers to this property group.' : `Every cloud template in project ${projectId} that refers to it.`,
          decidedBy: ['Whether the group is shared or project-scoped.', 'Which templates refer to it by name — nothing lists them for you; search the repository.', 'Which versions of those templates are released.'],
          ifWrong: 'An edit meant for one template changes every template that refers to the group, at their next deployment or day-2 update. A removed property fails every one of those requests.',
        },
        guardrails: [
          { rule: 'Name checked as valid in a template expression', because: 'A name with a hyphen or space is accepted by the API and then cannot be referenced from YAML.' },
          { rule: type === 'CONSTANT' ? 'Constants, not inputs' : 'Inputs are constrained by enum or pattern', because: type === 'CONSTANT' ? 'A backup tier that requesters could type would be whatever they typed.' : 'The group is where the constraint lives once, rather than in forty templates slightly differently.' },
          { rule: 'Changes to the group are edits in the repository, applied by this script', because: 'A property group edited in the interface is changed for every template at once with no record of what it was.' },
        ],
        dryRun: ['Run apply.sh without --execute.', `Search the template repository for "${groupName}" before changing the group, and count the templates that will be affected.`],
        undo: ['DELETE /properties/api/property-groups/{id}. Templates that refer to it then fail validation, so remove the references first. To revert an edit, PUT the previous version from the repository.'],
        told: ['Nobody. Template authors find out when a template fails to validate — which is why changes go through the repository.'],
        requires: [...(kind === 'os' ? [`Image mappings named ${osList.join(', ')} in every region the templates deploy to.`] : []), 'Templates updated to refer to the group (see the example YAML).'],
        files: {
          [`${base}.json`]: json(group),
          [`${base}-template-example.yaml`]: example.join('\n'),
          'apply.sh': applyScript('vcf-automation', [{ method: 'POST', path: '/properties/api/property-groups', payload: `${base}.json` }], 'DELETE /properties/api/property-groups/{id} once no template refers to it.'),
          ...imported.files,
          'IMPORT.md': importMd({
            subject: `The property group ${groupName}, and a template that uses it.`,
            steps: [
              setupOrderStep('vcfa_property_group'),
              apiStep('Property group', 'apply.sh', [`\`${base}.json\` → POST /properties/api/property-groups`], ['By hand: Design → Property Groups → New, with the same properties. It must exist before a template that refers to it validates.']),
              imported.steps.templates,
            ],
            auth: ['apply', 'import'],
            verify: verifyFor(imported),
          }),
        },
        notes: [
          'Constant groups are referenced as ${propgroup.<name>.<property>}; input groups through an input with $ref: /ref/property-groups/<name>, read as ${input.<input>.<property>}.',
          'How a constant is declared inside properties (const, or default with readOnly) has varied between releases. Export an existing constant group with GET /properties/api/property-groups and match it.',
          'Omitting projectId makes the group available organisation-wide in the releases that support sharing; in older ones a projectId is required.',
        ],
        findings,
      };
    },
  }),
];
