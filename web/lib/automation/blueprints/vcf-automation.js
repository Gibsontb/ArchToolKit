/**
 * VCF Automation: the self-service side.
 *
 * Formerly Aria Automation, and vRA before that. The unit here is not a script
 * but a *contract with a requester*: a cloud template says what they can ask
 * for, a policy says what happens before they get it (approval), how long they
 * keep it (lease) and how much of it they may have (quota and deployment
 * limit), and a subscription hooks code onto the moment it is created.
 *
 * The thing that goes wrong is always the same and is never in the template: a
 * deployment with no lease, an approval policy that approves itself, an
 * extensibility action wired to a blocking topic that throws on its first bad
 * input and wedges every deployment in the estate behind it.
 *
 * Each is also an Orchestrator package (see vcfaPackage in
 * vcf-automation-setup.ts): the workflow imports the template, the ABX action
 * or the policy through the VM Apps organization API, idempotently, and the
 * native files — blueprint.yaml, the ABX script and zip route, the JSON — stay
 * for people who import by hand.
 */

/** A dry run may go without a project; a live run stops before any change. */
const NEEDS_PROJECT = String.raw`if (!settings.projectId) {
  if (!ctx.dryRun) throw new Error("Set projectId in the configuration element " + SETTINGS_NAME + ". Nothing was changed.");
  System.warn("A live run would stop before any change: projectId is empty.");
}
var PROJECT = settings.projectId ? String(settings.projectId) : "<REQUIRED — projectId>";
`;

import { bool, num, str,                                           } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { applyScript, authHeader, authPreamble, hostVar } from '../apply.js';
import { apiStep, importBundle, importMd, manualStep, setupOrderStep, stableId, templatePath, verifyFor } from '../vcfa-import.js';
import { fromScriptsDir, packageVerify, stepsJs, vcfaPackage, withPackageSteps } from './vcf-automation-setup.js';
import { buildTemplate, cellsOf, INPUT_TYPES, RESOURCE_TYPES, resourceTypeHelp, settingsReference,               } from './vcf-automation-template-model.js';

const PLATFORM = 'vcf-automation'         ;
const SRC = 'VCF Automation 9.1';

/** Where a policy is made by hand in a VM Apps organization. */
const POLICY_MENU = 'the VM Apps organization portal → Content & Policies → Policies → New policy (VERIFY the menu path on your 9.1 release)';

function json(value         )         {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// --- policy criteria, shared by approval, lease and quota policies ---------------

/** The operators a policy criteria expression takes (VERIFY on your release: the criteria editor lists them). */
const OPERATORS = ['eq', 'notEq', 'hasAny', 'matches', 'notMatches', 'in', 'notIn', 'greaterThan', 'lessThan', 'greaterThanEquals', 'lessThanEquals'];

                    
                                                       
                               
                        
 

/** Rows `property | operator | value` joined by all or any, as the policy API's matchExpression. */
function criteriaOf(rows        , join        , where        )           {
  const findings            = [];
  const clauses = rows
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line, index) => {
      const [key = '', operator = '', value = ''] = cellsOf(line);
      if (!key) findings.push(error('vcfa.policy.criteria-no-key', `${where}: criteria row ${index + 1} has no property.`, { source: SRC }));
      if (!OPERATORS.includes(operator)) findings.push(error('vcfa.policy.criteria-operator', `${where}: criteria row ${index + 1} has operator "${operator}"; the operators are ${OPERATORS.join(', ')}.`, { source: SRC }));
      const typed                                       = /^(in|notIn|hasAny)$/.test(operator) ? value.split(',').map((v) => v.trim()).filter(Boolean) : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : /^(true|false)$/.test(value) ? value === 'true' : value;
      return { key, operator, value: typed };
    });
  if (clauses.length === 0) return { findings, text: 'every request' };
  const text = clauses.map((c) => `${c.key} ${c.operator} ${Array.isArray(c.value) ? c.value.join(',') : String(c.value)}`).join(join === 'any' ? ' or ' : ' and ');
  if (clauses.length === 1) return { expression: { matchExpression: clauses }, findings, text };
  return { expression: { matchExpression: [{ [join === 'any' ? 'or' : 'and']: clauses }] }, findings, text };
}

const JOIN_OPTIONS = [
  { value: 'all', label: 'All of the rows (and)' },
  { value: 'any', label: 'Any of the rows (or)' },
];

const SCOPE_OPTIONS = [
  { value: 'project', label: 'One project' },
  { value: 'org', label: 'The whole organization' },
];

const ENFORCEMENT_OPTIONS = [
  { value: 'HARD', label: 'Hard — cannot be overridden by a lower-scope policy' },
  { value: 'SOFT', label: 'Soft — a project-scoped policy may override it' },
];

/** The ES5 that fills projectId (or removes it, for the organization) and ensures the policies. */
function policyScript(resources                   , projectScoped         )         {
  return projectScoped
    ? `var NAMES = ${JSON.stringify(resources)};\nfor (var n = 0; n < NAMES.length; n++) if (settings.projectId) bodies[NAMES[n]].projectId = String(settings.projectId);\nmod.ensureAll(ctx, conn, STEPS, bodies, values, settings);\n`
    : 'mod.ensureAll(ctx, conn, STEPS, bodies, values, settings);\n';
}

// --- ABX ---------------------------------------------------------------------------------

/**
 * Event topics, with whether a subscription on them may block. From the 8.x
 * event topic reference carried into 9.1 — VERIFY with GET
 * /event-broker/api/topics on your release (the list is the source of truth,
 * and says blockable per topic).
 */
const TOPICS                                                  = [
  ['compute.allocation.pre', 'Compute allocation — before placement; may change names and placement', true],
  ['compute.reservation.pre', 'Compute reservation', true],
  ['compute.provision.pre', 'Compute provision — before the machine is created', true],
  ['compute.provision.post', 'Compute post provision — after the machine is created', true],
  ['compute.initial.power.on', 'Compute initial power on', true],
  ['compute.removal.pre', 'Compute removal — before a machine is deleted', true],
  ['compute.removal.post', 'Compute post removal', true],
  ['network.configure', 'Network configure — before NICs and addresses are allocated', true],
  ['disk.allocation.pre', 'Disk allocation', true],
  ['disk.attach.pre', 'Disk attach', true],
  ['disk.attach.post', 'Disk post attach', false],
  ['ipam.ip.allocation.post', 'IPAM address allocated (VERIFY)', false],
  ['deployment.request.pre', 'Deployment requested', true],
  ['deployment.request.post', 'Deployment completed', false],
  ['deployment.resource.request.pre', 'Deployment resource requested', true],
  ['deployment.resource.request.post', 'Deployment resource completed', false],
  ['deployment.action.pre', 'Deployment action requested (day 2)', true],
  ['deployment.action.post', 'Deployment action completed (day 2)', false],
  ['deployment.resource.action.pre', 'Deployment resource action requested (day 2)', true],
  ['deployment.resource.action.post', 'Deployment resource action completed (day 2)', false],
  ['deployment.onboarded', 'Deployment onboarded', false],
  ['blueprint.configuration', 'Cloud template configuration', false],
  ['blueprint.version.created', 'Cloud template version created', false],
  ['blueprint.version.released', 'Cloud template version released', false],
  ['blueprint.version.unreleased', 'Cloud template version unreleased', false],
  ['project.create.post', 'Project created (VERIFY)', false],
  ['project.update.post', 'Project updated (VERIFY)', false],
  ['project.delete.post', 'Project deleted (VERIFY)', false],
  ['kubernetes.cluster.allocation.pre', 'Kubernetes cluster allocation', true],
  ['kubernetes.cluster.provision.pre', 'Kubernetes cluster provision', true],
  ['kubernetes.cluster.provision.post', 'Kubernetes cluster post provision', true],
  ['kubernetes.cluster.removal.pre', 'Kubernetes cluster removal', true],
  ['kubernetes.cluster.removal.post', 'Kubernetes cluster post removal', true],
  ['kubernetes.namespace.provision.post', 'Kubernetes namespace provisioned (VERIFY)', false],
];

                    
                        
                                       
                                                             
                         
 

function constantsOf(text        )                                            {
  const findings            = [];
  const rows             = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
    const [name = '', kind = '', value = ''] = cellsOf(line);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) findings.push(error('vcfa.abx.bad-constant', `"${name}" is not a valid constant or secret name: letters, digits and _.`, { source: SRC }));
    if (kind !== 'constant' && kind !== 'secret') findings.push(error('vcfa.abx.bad-constant', `${name}: the kind is constant or secret, not "${kind}".`, { source: SRC }));
    if (kind === 'secret' && !/^[A-Z_][A-Z0-9_]*$/.test(value)) {
      findings.push(error('vcfa.abx.secret-literal', `${name}: a secret's third column is the environment variable its value is read from (e.g. CMDB_TOKEN), not the value.`, { remediation: 'The value is read from the environment when the script runs and is never written to a file.', source: SRC }));
    }
    rows.push({ name, kind: kind === 'secret' ? 'secret' : 'constant', value });
  }
  return { rows, findings };
}

/** Creates the action constants and secrets: a secret's value is read from the environment by jq and sent on stdin. */
function constantsScript(rows                     )         {
  const host = hostVar('vcf-automation');
  const secrets = rows.filter((r) => r.kind === 'secret');
  return [
    '#!/usr/bin/env bash',
    '# Create the action constants and secrets the ABX action reads, through the ABX API.',
    '# A secret is created encrypted; its value is read from the environment variable',
    '# named beside it and reaches curl on stdin, never a file or an argument.',
    '#',
    '# Applies when run. With --dry-run it only prints what it would create.',
    '# An existing constant or secret of the same name is left as it is.',
    'set -euo pipefail',
    '',
    ...authPreamble('vcf-automation'),
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    'DRY_RUN=0',
    '[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
    `API="https://\${${host}}/abx/api/resources/action-secrets"`,
    `EXISTING=$(curl -sS -f "\${API}?page=0&size=500" -H "${authHeader('vcf-automation')}" -H "Accept: application/json" | jq -r '[.content[]?.name] | join("\\n")')`,
    '',
    '# create NAME ENCRYPTED, with the value on stdin',
    'create() {',
    '  local name="$1" encrypted="$2"',
    '  if grep -qxF "${name}" <<<"${EXISTING}"; then echo "exists, left as it is: ${name}"; return 0; fi',
    '  if (( DRY_RUN )); then echo "DRY RUN: would create ${name} (encrypted: ${encrypted})"; cat >/dev/null; return 0; fi',
    `  jq -R -s --arg n "\${name}" --argjson e "\${encrypted}" '{name: $n, value: (. | rtrimstr("\\n")), encrypted: $e}' |`,
    `    curl -sS -f -X POST "\${API}" -H "${authHeader('vcf-automation')}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @- >/dev/null`,
    '  echo "created ${name}"',
    '}',
    '',
    ...(secrets.length > 0 ? ['if (( ! DRY_RUN )); then', ...secrets.map((s) => `  : "\${${s.value}:?set ${s.value} in the environment — it is the value of the secret ${s.name}, and is never written to a file}"`), 'fi'] : []),
    ...rows.map((r) => (r.kind === 'secret' ? `printf '%s' "\${${r.value}:-}" | create ${JSON.stringify(r.name)} true` : `printf '%s' ${JSON.stringify(r.value)} | create ${JSON.stringify(r.name)} false`)),
    '',
    '# Undo: DELETE /abx/api/resources/action-secrets/{id} once no action reads it.',
    '',
  ].join('\n');
}

/** A PowerShell ABX action cannot go through import/create-abx-action.sh (it takes .py and .js), so it has its own. */
function powershellApply(base        )         {
  const host = hostVar('vcf-automation');
  const hdr = authHeader('vcf-automation');
  return [
    '#!/usr/bin/env bash',
    '# Create the PowerShell ABX action and its subscription through the ABX and event',
    '# broker APIs, in the project VCFA_PROJECT_ID: the action with the script inline,',
    '# then the subscription with the new action id in runnableId.',
    '#',
    '# Applies when run. With --dry-run it only prints what it would send.',
    '# Not idempotent: the workflow is. If a run fails part way, check what was created.',
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    '',
    ...authPreamble('vcf-automation'),
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    ': "${VCFA_PROJECT_ID:?set VCFA_PROJECT_ID to the project id (GET /iaas/api/projects)}"',
    'DRY_RUN=0',
    '[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
    `API="https://\${${host}}"`,
    'send() {',
    `  curl -sS -f -X "$1" "\${API}$2" -H "${hdr}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @-`,
    '}',
    `ORG_ID=$(curl -sS -f "\${API}/iaas/api/projects/\${VCFA_PROJECT_ID}?apiVersion=2021-07-15" -H "${hdr}" -H "Accept: application/json" | jq -r '.orgId // empty')`,
    `ACTION=$(jq --rawfile s '${base}.ps1' --arg p "\${VCFA_PROJECT_ID}" --arg o "\${ORG_ID}" '. + {source: $s, projectId: $p, orgId: $o}' '${base}-action.json')`,
    'if (( DRY_RUN )); then',
    `  echo "DRY RUN: would POST ${base}-action.json (with ${base}.ps1) to \${API}/abx/api/resources/actions"`,
    `  echo "DRY RUN: would POST ${base}-subscription.json to \${API}/event-broker/api/subscriptions"`,
    '  exit 0',
    'fi',
    `ACTION_ID=$(send POST /abx/api/resources/actions <<<"\${ACTION}" | jq -r '.id // empty')`,
    '[[ -n "${ACTION_ID}" ]] || { echo "the action was not created — stopping" >&2; exit 1; }',
    'echo "ACTION_ID=${ACTION_ID}" | tee -a created-ids.txt',
    `jq --arg a "\${ACTION_ID}" --arg p "\${VCFA_PROJECT_ID}" '.runnableId = $a | if .constraints then .constraints.projectId = [$p] else . end' '${base}-subscription.json' | send POST /event-broker/api/subscriptions`,
    'echo',
    '# Undo: DELETE /event-broker/api/subscriptions/{id}, then DELETE /abx/api/resources/actions/{ACTION_ID}.',
    '',
  ].join('\n');
}

// --- the cloud template defaults -------------------------------------------------------------

const DEFAULT_RESOURCES = [
  'server | Cloud.vSphere.Machine | image=rhel9-hardened; flavor=${input.size}; networks=appnet:static; attachedDisks=data; constraints=env:${input.environment}; folderName=VCFA/${input.environment}; cloudConfig=yes; tags=environment:${input.environment}, managedBy:vcf-automation | ',
  'data | Cloud.vSphere.Disk | capacityGb=${input.dataDiskGb}; provisioningType=thin; SCSIController=SCSI_Controller_1; unitNumber=0 | ',
  'appnet | Cloud.vSphere.Network | networkType=existing; constraints=net:${input.environment} | ',
].join('\n');

const DEFAULT_INPUTS = [
  'environment | string | Environment | dev | enum=dev,test,prod',
  'size | string | Size | small | enum=small,medium',
  'dataDiskGb | integer | Data disk (GB) | 20 | min=10; max=500',
].join('\n');

const DEFAULT_CLOUD_CONFIG = ['#cloud-config', 'hostname: ${self.resourceName}', 'package_upgrade: true', 'write_files:', '  - path: /etc/motd', '    content: "Environment: ${input.environment}"'].join('\n');

const CRITERIA_HINT = 'Property | Operator | Value';

function criteriaInputs(defaultRows        , showWhen                             )                   {
  return [
    { id: 'criteria', label: 'Criteria', control: 'textarea', default: defaultRows, hint: CRITERIA_HINT, options: OPERATORS.map((op) => ({ value: op, label: op, group: 'Operator' })), help: `One condition per row. Operators: ${OPERATORS.join(', ')}. in, notIn and hasAny take a comma separated list. VERIFY the property names in the criteria editor of your release (e.g. catalogItemId, projectId, requestedBy, deployment inputs).`, ...(showWhen ? { showWhen } : {}) },
    { id: 'criteria_join', label: 'Rows combine as', control: 'select', options: JOIN_OPTIONS, default: 'all', ...(showWhen ? { showWhen } : {}) },
  ];
}

export const VCF_AUTOMATION_AUTOMATIONS                                 = [
  automationBlueprint({
    id: 'vcfa_cloud_template',
    platform: PLATFORM,
    label: 'A cloud template people can request',
    group: 'Catalogue',
    description:
      'A VM Apps cloud template built resource by resource — machines, disks, networks, NSX gateways, NAT and load balancers, security groups, Ansible, allocation helpers and custom resources — with a constrained inputs block. References, dependencies and defaults are checked before it is imported, and the lease comes from a lease policy.',
    inputs: [
      { id: 'template_name', label: 'Template name', control: 'text', default: 'Standard Linux server' },
      { id: 'version', label: 'Version', control: 'text', default: '1.0.0', hint: 'major.minor.patch; versions are immutable, so raise it to publish a change' },
      {
        id: 'resources',
        label: 'Resources',
        control: 'textarea',
        default: DEFAULT_RESOURCES,
        hint: 'Resource | Type | Settings (key=value; key=value) | Depends on',
        options: [...RESOURCE_TYPES.map((t) => ({ value: t.type, label: `${t.type} — ${t.label}`, group: 'Type' })), { value: 'Custom.Resource', label: 'Custom.<name> — a custom resource (type its name)', group: 'Type' }],
        help: `One resource per row. Types: ${resourceTypeHelp()}. Settings are the resource's properties as key=value; the settings reference file lists each type's keys and the shorthands (networks=net:static:v6, attachedDisks=disk, routes=HTTPS:443>HTTPS:8443, healthCheck=HTTP:8080:/health, natRules=TCP:8080>web:80, rules=https inbound Allow TCP 443 ANY). Depends on: resource names, comma separated, beyond the ones the settings already refer to.`,
      },
      {
        id: 'template_inputs',
        label: 'Inputs',
        control: 'textarea',
        default: DEFAULT_INPUTS,
        hint: 'Input | Type | Title | Default | Constraints (enum=a,b; min=; max=; pattern=; $dynamicEnum=)',
        options: INPUT_TYPES.map((t) => ({ value: t, label: t, group: 'Type' })),
        help: 'Types: string, integer, number, boolean, object, array. Constraints: enum, min, max (a length for a string), pattern, encrypted=true, readOnly=true, format, $dynamicEnum, $dynamicDefault, $ref, $data. A pattern may hold a bare |, not a ;.',
      },
      { id: 'owner_input', label: 'Ask for an owner and a cost code', control: 'toggle', default: true, hint: 'Adds both as validated inputs and tags every machine with them' },
      { id: 'cloud_config', label: 'Cloud-init', control: 'textarea', default: DEFAULT_CLOUD_CONFIG, hint: 'Used by a machine with cloudConfig=yes' },
      { id: 'lease_days', label: 'Lease policy for the project (days)', control: 'number', default: 90, min: 0, max: 3650, hint: '0: none here — use the lease policy blueprint (vcfa_lease_policy) for criteria, grace and scope' },
    ],
    automation: (values                 , name        )             => {
      const templateName = str(values, 'template_name', 'Cloud template');
      const version = str(values, 'version', '1.0.0');
      const lease = num(values, 'lease_days', 90);
      const askOwner = bool(values, 'owner_input', true);
      const base = slugOf(name || templateName, 'cloud-template');

      const extraInputs             = askOwner
        ? [
            { name: 'owner', type: 'string', title: 'Owner (who to ask before this is removed)', defaultValue: '', constraints: new Map([['pattern', '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+$']]), line: 0 },
            { name: 'costCode', type: 'string', title: 'Cost code', defaultValue: '', constraints: new Map([['pattern', '^[A-Z]{2,4}-[0-9]{3,6}$']]), line: 0 },
          ]
        : [];
      const model = buildTemplate({
        title: templateName,
        resources: str(values, 'resources', ''),
        inputs: str(values, 'template_inputs', ''),
        cloudConfig: str(values, 'cloud_config', ''),
        extraInputs,
        machineTags: askOwner ? [{ key: 'owner', value: '${input.owner}' }, { key: 'costCode', value: '${input.costCode}' }] : [],
        header: [`# ${templateName}`, '#', '# The inputs are constrained on purpose. An unconstrained flavor input is', '# how a self-service catalogue ends up with 64-vCPU development boxes.'],
      });
      const yaml = model.yaml;
      const findings            = [...model.findings];
      if (!/^\d+\.\d+\.\d+$/.test(version)) findings.push(error('vcfa.template.bad-version', `Version "${version}" is not major.minor.patch.`, { source: SRC }));
      if (model.resources.length === 0) findings.push(error('vcfa.template.no-resources', 'The template has no resources.', { source: SRC }));
      if (lease === 0) {
        findings.push(
          warning('vcfa.template.no-lease', 'This template creates no lease policy, so unless one already covers the project, anything deployed from it lives until somebody notices.', {
            remediation: 'A lease is the only mechanism that makes self-service reversible. Make one with the lease policy blueprint (vcfa_lease_policy) — per project or for the organization, with criteria and grace — or set a lease here.',
            source: SRC,
          }),
        );
      }
      if (!askOwner) {
        findings.push(
          warning('vcfa.template.no-owner', 'Nothing asks who owns the deployment or what it is for.', {
            remediation: 'In two years this is the difference between reclaiming it and being afraid to. Ask for an owner and a cost code at request time; nobody will ever fill it in afterwards.',
            source: SRC,
          }),
        );
      }

      // Flavors the template asks for: named ones, and every enum value of an input a flavor reads.
      const flavorInputs = model.resources.flatMap((r) => [...(r.settings.get('flavor') ?? '').matchAll(/input\.([A-Za-z0-9_]+)/g)].map((m) => m[1] ));
      const flavors = [...model.mappings.flavors, ...model.inputs.filter((i) => flavorInputs.includes(i.name)).flatMap((i) => (i.constraints.get('enum') ?? '').split(',').map((v) => v.trim()).filter(Boolean))];
      const counts = model.resources.reduce                        ((acc, r) => ({ ...acc, [r.type]: (acc[r.type] ?? 0) + 1 }), {});
      const summary = Object.entries(counts).map(([type, n]) => `${n} ${type}`).join(', ');

      const policy = lease > 0
        ? {
            name: `${templateName} — lease`,
            typeId: 'com.vmware.policy.deployment.lease',
            enforcementType: 'HARD',
            definition: { leaseGrace: 7, leaseTotalTermMax: lease, leaseTermMax: lease },
            // A project-scoped policy names its project in projectId (the
            // Policy body in the 9.1 VM Apps Org - Policies reference).
            projectId: '<REQUIRED — project id>',
          }
        : undefined;

      const template = { name: templateName, version, description: `${model.resources.length} resource(s); ${lease > 0 ? `${lease}-day lease` : 'lease from a lease policy'}.`, yaml };
      const imported = importBundle({ templates: [template] });

      // The workflow imports the same blueprint.yaml the import/ folder holds:
      // validate, create or update the draft, version it; then the lease policy.
      const pkg = vcfaPackage({
        thing: 'template',
        base,
        folder: 'Cloud templates',
        workflowName: `Import cloud template ${base}`,
        description: `Imports the cloud template "${templateName}" into a VCF Automation VM Apps organization project and versions it${policy ? ', then creates its lease policy' : ''}.`,
        outputs: { templateId: 'TEMPLATE_ID', ...(policy ? { leasePolicyId: 'LEASE_POLICY_ID' } : {}) },
        payloads: policy ? { 'lease-policy.json': policy } : {},
        extraResources: [{ name: 'template-blueprint.yaml', content: imported.files[templatePath(template)]  }],
        templates: true,
        settings: [
          { name: 'projectId', type: 'string', value: '', description: 'The project the template is created in (GET /iaas/api/projects)' },
          { name: 'releaseTemplate', type: 'boolean', value: true, description: 'Release the new version to the catalog (true: requesters see it at once)' },
        ],
        cap: policy ? 3 : 2,
        script: [
          stepsJs(policy ? [{ key: 'LEASE_POLICY_ID', label: `lease policy "${policy.name}"`, resource: 'lease-policy.json', list: '/policy/api/policies?typeId=com.vmware.policy.deployment.lease', style: 'page', create: '/policy/api/policies', sameProject: true }] : []),
          `var TEMPLATE = ${JSON.stringify({ name: templateName, description: template.description, version })};\n`,
          NEEDS_PROJECT,
          String.raw`if (bodies["lease-policy.json"]) bodies["lease-policy.json"].projectId = PROJECT;
TEMPLATE.content = core.resource(RESOURCE_PATH, "template-blueprint.yaml");
values.TEMPLATE_ID = mod.importTemplate(ctx, conn, TEMPLATE, PROJECT, settings.releaseTemplate === true || String(settings.releaseTemplate) === "true");
mod.ensureAll(ctx, conn, STEPS, bodies, values, settings);
`,
        ].join(''),
      });

      const constrained = model.constrainedInputs;
      return {
        platform: PLATFORM,
        title: `${templateName} — ${summary || 'no resources'}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'Somebody requests it from the catalogue', worstCase: 'as often as people ask, which is the point — the guardrails are the limit, not the trigger' },
        scope: {
          what: `New deployments in whichever project this template is released to, placed by ${model.placementTags.join(', ') || 'the project’s cloud zones alone'}.`,
          decidedBy: [
            'The project the template is released to, and who is a member of it.',
            'The cloud zones on that project, and their capacity priority.',
            `The placement constraints: ${model.placementTags.join(', ') || 'none'}.`,
            'Whatever approval, lease, quota and deployment-limit policies apply to that project.',
          ],
          ifWrong: 'Deployments land in the wrong cluster or the wrong network, at request time, for whoever asked. It is reversible, but it is reversible one deployment at a time.',
        },
        guardrails: [
          { rule: constrained.length > 0 ? `Inputs constrained: ${constrained.join(', ')}` : 'No input is constrained — see the findings', because: 'An unconstrained size input is how a catalogue produces development boxes larger than production.' },
          { rule: 'References, dependencies and defaults checked before import', because: 'A reference to a resource or input that does not exist is a template that fails at request time, in front of the requester.' },
          ...(lease > 0 ? [{ rule: `${lease}-day lease with 7 days’ grace`, because: 'The lease is the only thing that makes self-service reversible without a reclamation project.' }] : []),
          ...(askOwner ? [{ rule: 'Owner and cost code are required, and validated', because: 'Asked at request time they get answered. Asked two years later, nobody knows.' }] : []),
          { rule: 'Placement by tag rather than by named cluster', because: 'A named cluster in a template is a migration you have to do by hand.' },
        ],
        dryRun: [
          `Run the workflow Import cloud template ${base} with dryRun = true: it validates the template on the server, reads what exists, and logs what it would create, update and version.`,
          'Then request it as an ordinary user rather than as an administrator — what the requester sees is different, and usually worse.',
        ],
        undo: [
          'Unrelease the version from the catalogue: existing deployments continue, and nobody can request more.',
          'Deleting the template does not delete what was deployed from it.',
        ],
        told: ['Whatever notification the project has. Consider a subscription (the ABX action blueprint) that posts new deployments to a channel — it is the cheapest form of capacity awareness there is.'],
        requires: [
          'A project with a cloud zone and a network profile.',
          ...(model.mappings.images.length > 0 ? [`Image mappings named ${model.mappings.images.join(', ')}.`] : []),
          ...(flavors.length > 0 ? [`Flavor mappings named ${[...new Set(flavors)].join(', ')}.`] : []),
          ...(model.resources.some((r) => r.type.startsWith('Cloud.Ansible')) ? ['The Ansible or Ansible Automation Platform integration the resources name (the integrations blueprint).'] : []),
          ...(model.resources.some((r) => r.type.startsWith('Cloud.NSX')) ? ['An NSX cloud account associated with the vSphere one, and a network profile that allows on-demand networks and load balancers.'] : []),
        ],
        files: {
          ...pkg.files,
          [`${base}.yaml`]: yaml,
          [`${base}-settings-reference.md`]: `${settingsReference().join('\n')}\n`,
          ...(policy ? { [`scripts/${base}-lease-policy.json`]: json(policy) } : {}),
          ...(policy
            ? { 'scripts/apply.sh': fromScriptsDir(applyScript('vcf-automation', [{ method: 'POST', path: '/policy/api/policies', payload: `${base}-lease-policy.json` }], 'DELETE /policy/api/policies/{id}. Deployments keep the lease they were given until it is changed.')) }
            : {}),
          ...imported.files,
          'IMPORT.md': importMd({
            subject: `The cloud template "${templateName}"${policy ? ' and its lease policy' : ''}.`,
            steps: withPackageSteps(pkg, [
              setupOrderStep('vcfa_cloud_template'),
              manualStep('The project', [`Set projectId in the configuration element (GET /iaas/api/projects, or the project workflow output). The workflow validates the template, creates it in that project or updates the draft of the one with the same name there, and creates version ${version} — released to the catalog while releaseTemplate is true (the default). An existing version is left alone: raise the version to publish a change.`]),
              imported.steps.templates,
              policy
                ? apiStep('Or by script: lease policy', 'scripts/apply.sh', [`\`scripts/${base}-lease-policy.json\` → POST /policy/api/policies`], [
                    `Replace \`<REQUIRED — project id>\` with the project id first. By hand: ${POLICY_MENU} → Lease policy, with the same values. The script is not idempotent; the workflow is. For criteria, organization scope or a soft policy, use the lease policy blueprint instead.`,
                  ])
                : undefined,
            ]),
            auth: ['import', ...(policy ? (['apply']         ) : [])],
            verify: packageVerify([
              ...verifyFor(imported),
              'Resource properties: the Cloud.vSphere.*, Cloud.NSX.*, Cloud.SecurityGroup, Cloud.Ansible* and Allocations.* properties follow the 8.x cloud template schema carried into 9.1; POST /blueprint/api/blueprint-validation (which the workflow runs first) is the check. assignIPv6Address, storage.bootDiskCapacityInGB, the security group rule peer field and the Ansible Automation Platform templates block are the least certain — VERIFY them in the designer of your release.',
              ...(policy ? ['Lease policy: typeId com.vmware.policy.deployment.lease and the definition keys follow the 8.x policy API; the 9.1 Policy body (VM Apps Org - Policies) has projectId, which replaces the scopeCriteria key "project" older versions of this kit wrote. GET one made in the interface and compare.'] : []),
            ]),
          }),
        },
        notes: [
          'Image and flavor mappings are per region. A template that works in one project and not another is almost always a missing mapping rather than a template problem.',
          'Release to the catalogue through a content source pointed at a repository, not by uploading. Then the template has a history and a review.',
          `${base}-settings-reference.md lists every key each resource type takes here.`,
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfa_abx_action',
    platform: PLATFORM,
    label: 'An extensibility action on a deployment event',
    group: 'Extensibility',
    description:
      'An ABX action (Python, Node.js or PowerShell) with its constants, secrets and dependencies, wired by a subscription to any event topic — blocking or not, with a condition, a priority, a timeout and a recovery action — and a failure path that does not wedge every deployment in the estate behind it.',
    inputs: [
      { id: 'action_name', label: 'Action name', control: 'text', default: 'Register in the CMDB' },
      {
        id: 'topic',
        label: 'Runs on',
        control: 'select',
        options: [...TOPICS.map(([id, label, blockable]) => ({ value: id, label: `${label} — ${id}${blockable ? '' : ' (cannot block)'}` })), { value: 'custom', label: 'Another topic — type its id' }],
        default: 'compute.provision.post',
      },
      { id: 'custom_topic', label: 'Topic id', control: 'text', default: 'compute.provision.post', hint: 'From GET /event-broker/api/topics', showWhen: { input: 'topic', equals: ['custom'] } },
      {
        id: 'blocking',
        label: 'Blocking',
        control: 'select',
        options: [
          { value: 'auto', label: 'As the topic suggests — blocking on a .pre topic' },
          { value: 'blocking', label: 'Blocking — the event waits for the action' },
          { value: 'non-blocking', label: 'Non-blocking — the event carries on' },
        ],
        default: 'auto',
      },
      {
        id: 'runtime',
        label: 'Written in',
        control: 'select',
        options: [
          { value: 'python', label: 'Python' },
          { value: 'nodejs', label: 'Node.js' },
          { value: 'powershell', label: 'PowerShell' },
        ],
        default: 'python',
      },
      { id: 'runtime_version', label: 'Runtime version', control: 'text', default: '', placeholder: 'e.g. 3.10, 20, 7.4', hint: 'Empty: the release default. VERIFY the versions your release offers' },
      { id: 'endpoint', label: 'Calls', control: 'text', default: 'https://cmdb.example.com/api/ci' },
      { id: 'dependencies', label: 'Dependencies', control: 'text', default: '', placeholder: 'requests==2.32.3', hint: 'Comma separated: pip requirements, npm package@version, or PowerShell modules' },
      {
        id: 'constants',
        label: 'Constants and secrets',
        control: 'textarea',
        default: 'cmdbToken | secret | CMDB_TOKEN',
        hint: 'Name | Kind (constant or secret) | Value (a secret: the environment variable holding it)',
        options: [{ value: 'constant', label: 'constant', group: 'Kind' }, { value: 'secret', label: 'secret', group: 'Kind' }],
        help: 'Each becomes an action input. A constant carries its value; a secret is created encrypted from the environment variable when scripts/abx-constants.sh runs, and never appears in a file.',
      },
      { id: 'condition', label: 'Condition', control: 'text', default: '', placeholder: 'event.data.customProperties.environment == "prod"', hint: 'The subscription criteria, a JavaScript expression on event; empty runs on every event in scope' },
      { id: 'this_project_only', label: 'Only for the action’s project', control: 'toggle', default: true, hint: 'Off: every project in the organization' },
      { id: 'priority', label: 'Priority', control: 'number', default: 10, min: 0, max: 1000, hint: '0 runs first among blocking subscriptions on the topic' },
      { id: 'subscription_timeout', label: 'Blocking timeout (minutes)', control: 'number', default: 5, min: 0, max: 60, hint: 'How long a blocking event waits for this subscription' },
      { id: 'recovery_action', label: 'Recovery action', control: 'text', default: '', placeholder: 'Name of an ABX action in the project', hint: 'Run when this one fails on a blocking topic' },
      { id: 'fail_open', label: 'Carry on if it fails', control: 'toggle', default: true, hint: 'On a blocking topic this is the difference between one failure and an estate-wide stall' },
      { id: 'timeout_seconds', label: 'Give up after (seconds)', control: 'number', default: 30, min: 5, max: 900 },
      { id: 'memory_mb', label: 'Memory (MB)', control: 'number', default: 300, min: 128, max: 3072, hint: 'The function’s memory limit' },
    ],
    automation: (values                 , name        )             => {
      const actionName = str(values, 'action_name', 'Extensibility action');
      const picked = str(values, 'topic', 'compute.provision.post');
      const topic = picked === 'custom' ? str(values, 'custom_topic', 'compute.provision.post') : picked;
      const known = TOPICS.find(([id]) => id === topic);
      const blockingMode = str(values, 'blocking', 'auto');
      const blocking = blockingMode === 'blocking' ? true : blockingMode === 'non-blocking' ? false : topic.endsWith('.pre');
      const runtime = ['nodejs', 'powershell'].includes(str(values, 'runtime', 'python')) ? str(values, 'runtime', 'python') : 'python';
      const runtimeVersion = str(values, 'runtime_version', '');
      const endpoint = str(values, 'endpoint', '');
      const dependencies = listOf(str(values, 'dependencies', ''));
      const { rows: constants, findings: constantFindings } = constantsOf(str(values, 'constants', ''));
      const condition = str(values, 'condition', '');
      const projectOnly = bool(values, 'this_project_only', true);
      const priority = Math.max(0, Math.round(num(values, 'priority', 10)));
      const subscriptionTimeout = Math.max(0, Math.round(num(values, 'subscription_timeout', 5)));
      const recovery = str(values, 'recovery_action', '');
      const failOpen = bool(values, 'fail_open', true);
      const timeout = num(values, 'timeout_seconds', 30);
      const memory = Math.round(num(values, 'memory_mb', 300));
      const base = slugOf(name || actionName, 'abx-action');
      const secret = constants.find((c) => c.kind === 'secret');

      const findings            = [...constantFindings];
      if (blocking && !failOpen) {
        findings.push(
          error('vcfa.abx.blocking-fail-closed', `${topic} is a blocking subscription and this action fails closed.`, {
            remediation:
              'Every deployment in scope waits on this action, and a bad response from the endpoint stops all of them. Either fail open, or move the work to a post topic where a failure is one deployment rather than the platform.',
            source: SRC,
          }),
        );
      }
      if (blocking && known && !known[2]) {
        findings.push(error('vcfa.abx.not-blockable', `${topic} cannot be subscribed to as blocking.`, { remediation: 'Make the subscription non-blocking, or pick the .pre topic of the same event.', source: SRC }));
      }
      if (blocking && timeout > 60) {
        findings.push(
          warning('vcfa.abx.blocking-slow', `A ${timeout}-second timeout on a blocking subscription adds ${timeout} seconds to every deployment in the worst case.`, {
            remediation: 'Blocking work should be fast or should not be blocking.',
            source: SRC,
          }),
        );
      }
      if (blocking && !projectOnly && !condition) {
        findings.push(
          warning('vcfa.abx.blocking-estate-wide', 'A blocking subscription with no project scope and no condition: every deployment in the organization waits on it.', {
            remediation: 'Scope it to the project, or add a condition, before it is enabled.',
            source: SRC,
          }),
        );
      }
      if (picked === 'custom' && !/^[a-z0-9]+(\.[a-z0-9]+)+$/.test(topic)) findings.push(error('vcfa.abx.bad-topic', `"${topic}" does not look like an event topic id (e.g. compute.provision.post).`, { source: SRC }));
      if (recovery && recovery === actionName) findings.push(error('vcfa.abx.self-recovery', 'The recovery action is the action itself: a failure would run the same failure again.', { source: SRC }));
      if (dependencies.length > 0 && runtime === 'powershell') findings.push(warning('vcfa.abx.ps-modules', 'PowerShell dependencies are modules downloaded when the action is prepared; the extensibility runtime needs a path to the PowerShell Gallery (or your mirror).', { source: SRC }));

      const secretName = secret?.name ?? 'cmdbToken';
      const header = (lead        , tail        ) => [
        `${lead}${actionName}`,
        `${lead}`,
        `${lead}Topic: ${topic}${blocking ? ' — BLOCKING. Every deployment in scope waits on this.' : ' — non-blocking.'}`,
        `${lead}${failOpen ? 'Fails open: a failure is logged and the deployment continues.' : 'Fails closed: a failure stops the deployment.'}${tail}`,
      ];

      const python = [
        '"""',
        ...header('', ''),
        '"""',
        '',
        'import json',
        'import logging',
        'import os',
        'import urllib.error',
        'import urllib.request',
        '',
        'log = logging.getLogger(__name__)',
        '',
        `TIMEOUT = ${timeout}`,
        `ENDPOINT = os.environ.get("ENDPOINT", ${JSON.stringify(endpoint)})`,
        '',
        '',
        'def handler(context, inputs):',
        '    """Called by VCF Automation. `inputs` is the event payload plus the action inputs."""',
        `    # The secret is an encrypted action secret, read through the context — never from here.`,
        `    bearer = context.getSecret(inputs.get(${JSON.stringify(secretName)}, "")) if hasattr(context, "getSecret") and inputs.get(${JSON.stringify(secretName)}) else None`,
        '',
        '    payload = {',
        '        "name": inputs.get("resourceNames", [None])[0],',
        '        "deploymentId": inputs.get("deploymentId"),',
        '        "owner": inputs.get("owner"),',
        '        "project": inputs.get("projectId"),',
        '        "tags": inputs.get("tags", []),',
        '    }',
        '',
        '    if inputs.get("__dryRun"):',
        '        log.info("DRY RUN: would post %s to %s", payload, ENDPOINT)',
        '        return {"dryRun": True, "payload": payload}',
        '',
        '    request = urllib.request.Request(',
        '        ENDPOINT,',
        '        data=json.dumps(payload).encode("utf-8"),',
        '        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {bearer}"} if bearer else {})},',
        '        method="POST",',
        '    )',
        '',
        '    try:',
        '        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:',
        '            return {"status": response.status, "payload": payload}',
        '    except (urllib.error.URLError, TimeoutError) as failure:',
        failOpen
          ? '        # Fail open. The deployment matters more than the registration;\n        # the audit trail below is how the gap gets found and fixed.'
          : '        # Fail closed. Read the topic above before leaving this as it is.',
        '        log.exception("%s failed: %s", ENDPOINT, failure)',
        failOpen ? '        return {"status": "failed", "error": str(failure), "continued": True}' : '        raise',
        '',
      ].join('\n');

      const nodejs = [
        '/**',
        ...header(' * ', ''),
        ' */',
        '',
        `const TIMEOUT = ${timeout} * 1000;`,
        `const ENDPOINT = process.env.ENDPOINT || ${JSON.stringify(endpoint)};`,
        '',
        'exports.handler = async (context, inputs) => {',
        `  const bearer = inputs[${JSON.stringify(secretName)}] && context.getSecret ? await context.getSecret(inputs[${JSON.stringify(secretName)}]) : null;`,
        '  const payload = {',
        '    name: (inputs.resourceNames || [])[0],',
        '    deploymentId: inputs.deploymentId,',
        '    owner: inputs.owner,',
        '    project: inputs.projectId,',
        '    tags: inputs.tags || [],',
        '  };',
        '',
        '  if (inputs.__dryRun) {',
        '    console.log("DRY RUN: would post", payload, "to", ENDPOINT);',
        '    return { dryRun: true, payload };',
        '  }',
        '',
        '  const controller = new AbortController();',
        '  const timer = setTimeout(() => controller.abort(), TIMEOUT);',
        '  try {',
        '    const response = await fetch(ENDPOINT, {',
        '      method: "POST",',
        '      headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },',
        '      body: JSON.stringify(payload),',
        '      signal: controller.signal,',
        '    });',
        '    return { status: response.status, payload };',
        '  } catch (error) {',
        '    console.error(`${ENDPOINT} failed`, error);',
        failOpen ? '    return { status: "failed", error: String(error), continued: true };' : '    throw error;',
        '  } finally {',
        '    clearTimeout(timer);',
        '  }',
        '};',
        '',
      ].join('\n');

      const powershell = [
        '<#',
        ...header('', ''),
        '#>',
        '',
        `$Timeout = ${timeout}`,
        `$Endpoint = if ($env:ENDPOINT) { $env:ENDPOINT } else { ${JSON.stringify(endpoint).replace(/\$/g, '`$')} }`,
        '',
        'function handler($context, $inputs) {',
        `    $bearer = if ($inputs.${secretName}) { $context.getSecret($inputs.${secretName}) } else { $null }`,
        '    $payload = @{',
        '        name         = @($inputs.resourceNames)[0]',
        '        deploymentId = $inputs.deploymentId',
        '        owner        = $inputs.owner',
        '        project      = $inputs.projectId',
        '        tags         = $inputs.tags',
        '    }',
        '    if ($inputs.__dryRun) {',
        '        Write-Host "DRY RUN: would post $($payload | ConvertTo-Json -Compress) to $Endpoint"',
        '        return @{ dryRun = $true; payload = $payload }',
        '    }',
        '    $headers = @{}',
        '    if ($bearer) { $headers.Authorization = "Bearer $bearer" }',
        '    try {',
        '        $response = Invoke-RestMethod -Method Post -Uri $Endpoint -Headers $headers -ContentType "application/json" -Body ($payload | ConvertTo-Json -Depth 5) -TimeoutSec $Timeout',
        '        return @{ status = "ok"; payload = $payload; response = $response }',
        '    } catch {',
        '        Write-Error "$Endpoint failed: $_"',
        failOpen ? '        return @{ status = "failed"; error = "$_"; continued = $true }' : '        throw',
        '    }',
        '}',
        '',
      ].join('\n');

      const source = runtime === 'python' ? python : runtime === 'nodejs' ? nodejs : powershell;
      const ext = runtime === 'python' ? 'py' : runtime === 'nodejs' ? 'js' : 'ps1';

      // Each constant or secret is an action input naming it. VERIFY the reference form against an action exported with one attached.
      const actionInputs = Object.fromEntries(constants.map((c) => [c.name, `${c.kind}:${c.name}`]));
      const subscription = {
        name: actionName,
        type: 'RUNNABLE',
        eventTopicId: topic,
        blocking,
        disabled: false,
        priority,
        timeout: blocking ? subscriptionTimeout : 0,
        ...(condition ? { criteria: condition } : {}),
        ...(projectOnly ? { constraints: { projectId: ['<REQUIRED — project id>'] } } : {}),
        runnableType: 'extensibility.abx',
        runnableId: '<REQUIRED — the action id, after the action is created>',
        ...(recovery ? { recoverRunnableType: 'extensibility.abx', recoverRunnableId: `<REQUIRED — the id of the ABX action "${recovery}">` } : {}),
      };
      const extra = { dependencies: dependencies.join(runtime === 'python' ? '\n' : ','), ...(runtimeVersion ? { runtimeVersion } : {}) };

      // Python and Node.js go through the shared import bundle; PowerShell has its own files.
      // The shared import script cannot fill the project constraint or look up the
      // recovery action, so its copy leaves both out — and, when the subscription
      // is meant for one project, is created disabled rather than estate-wide.
      const { constraints: _constraints, recoverRunnableType: _rt, recoverRunnableId: _ri, ...portable } = subscription                                                                                                             ;
      void _constraints;
      void _rt;
      void _ri;
      const importCopy = { ...portable, disabled: projectOnly };
      const imported = runtime === 'powershell'
        ? undefined
        : importBundle({ abx: [{ name: actionName, runtime: runtime === 'python' ? 'python' : 'nodejs', script: source, description: `Runs on ${topic}; ${failOpen ? 'fails open' : 'fails closed'}.`, timeoutSeconds: timeout, memoryInMB: memory, inputs: actionInputs, subscription: importCopy }] });
      const importedFiles                         = { ...(imported?.files ?? {}) };
      const actionPath = Object.keys(importedFiles).find((path) => path.endsWith('/action.json'));
      if (actionPath) importedFiles[actionPath] = json({ ...(JSON.parse(importedFiles[actionPath] )                           ), ...extra });
      const actionBody                          = actionPath
        ? (JSON.parse(importedFiles[actionPath] )                           )
        : { name: actionName, description: `Runs on ${topic}; ${failOpen ? 'fails open' : 'fails closed'}.`, actionType: 'SCRIPT', runtime: 'powershell', entrypoint: 'handler', inputs: actionInputs, timeoutSeconds: timeout, memoryInMB: memory, shared: false, ...extra };

      const sourceName = `action.${ext}`;
      const { criteria: criteriaText, ...subscriptionRest } = subscription                                               ;
      const pkg = vcfaPackage({
        thing: 'abx',
        base,
        folder: 'Extensibility',
        workflowName: `Create ABX action ${base}`,
        description: `Creates the ABX action "${actionName}" in a VCF Automation VM Apps organization project (or updates it when its script differs), then its subscription on ${topic}, enabled.`,
        outputs: { actionId: 'ACTION_ID', subscriptionId: 'SUBSCRIPTION_ID' },
        payloads: {
          'action.json': actionBody,
          'subscription.json': { ...subscriptionRest, ...(criteriaText ? { criteria: criteriaText } : {}), id: stableId(`subscription:${actionName}`), runnableId: '__ACTION_ID__' },
        },
        extraResources: [{ name: sourceName, content: source }],
        settings: [{ name: 'projectId', type: 'string', value: '', description: 'The project the action belongs to (GET /iaas/api/projects); its organization id is read from it' }],
        cap: 2,
        script: [
          stepsJs([{ key: 'SUBSCRIPTION_ID', label: `subscription "${actionName}" on ${topic}${blocking ? ', blocking' : ''}`, resource: 'subscription.json', list: '/event-broker/api/subscriptions', style: 'page', create: '/event-broker/api/subscriptions', clientId: true }]),
          `var SOURCE_NAME = ${JSON.stringify(sourceName)};\nvar RECOVERY = ${JSON.stringify(recovery)};\n`,
          NEEDS_PROJECT,
          String.raw`var ACTION = bodies["action.json"];
var SUB = bodies["subscription.json"];
ACTION.source = core.resource(RESOURCE_PATH, SOURCE_NAME);
ACTION.projectId = PROJECT;
if (SUB.constraints) SUB.constraints.projectId = [PROJECT];
if (settings.projectId) {
  var project = core.http("GET", conn.host + "/iaas/api/projects/" + encodeURIComponent(PROJECT) + "?apiVersion=" + encodeURIComponent(conn.apiVersion), conn.auth, null, conn.safe).body || {};
  if (project.orgId) ACTION.orgId = String(project.orgId);
}
if (!ACTION.orgId) {
  if (!ctx.dryRun) throw new Error("Project " + PROJECT + " has no orgId, which the ABX API requires. Nothing was changed.");
  System.warn("A live run would stop before any change: no orgId for project " + PROJECT + ".");
}
var abx = conn.host + "/abx/api/resources/actions";
var actions = mod.listAll(conn, "/abx/api/resources/actions", "page");
var hits = [];
var recoveries = [];
for (var i = 0; i < actions.length; i++) {
  if (String(actions[i].projectId) !== PROJECT) continue;
  if (String(actions[i].name) === String(ACTION.name)) hits.push(actions[i]);
  if (RECOVERY && String(actions[i].name) === RECOVERY) recoveries.push(actions[i]);
}
if (RECOVERY) {
  if (recoveries.length === 1) SUB.recoverRunnableId = String(recoveries[0].id);
  else SUB.recoverRunnableId = "<REQUIRED — " + recoveries.length + " ABX actions named " + RECOVERY + " in project " + PROJECT + ">";
}
if (hits.length > 1) throw new Error(hits.length + " ABX actions named \"" + ACTION.name + "\" in project " + PROJECT + "; refusing to guess. Tidy them up first.");
if (hits.length === 1) {
  var id = String(hits[0].id);
  var current = core.http("GET", abx + "/" + encodeURIComponent(id) + "?projectId=" + encodeURIComponent(PROJECT), conn.auth, null, conn.safe).body || {};
  if (String(current.source || "") === String(ACTION.source) && String(current.runtime || "") === String(ACTION.runtime)) {
    System.log("Exists with the same script, left as it is: ABX action \"" + ACTION.name + "\" (" + id + ")");
  } else {
    ACTION.id = id;
    core.act(ctx, "update ABX action \"" + ACTION.name + "\" (" + id + ")", function () { return core.http("PUT", abx + "/" + encodeURIComponent(id), conn.auth, ACTION, conn.safe).statusCode; });
  }
  values.ACTION_ID = id;
} else {
  values.ACTION_ID = core.act(ctx, "create ABX action \"" + ACTION.name + "\" in project " + PROJECT, function () {
    var r = core.http("POST", abx, conn.auth, ACTION, conn.safe);
    if (!r.body || !r.body.id) throw new Error("POST /abx/api/resources/actions returned no id; the subscription was not created.");
    return String(r.body.id);
  }) || "new-action-id";
}
mod.ensureAll(ctx, conn, STEPS, bodies, values, settings);
`,
        ].join(''),
      });

      const scopeText = `${projectOnly ? 'the action’s project' : 'every project in the organization'}${condition ? `, where ${condition}` : ''}`;
      return {
        platform: PLATFORM,
        title: `${actionName} — runs on ${topic}${blocking ? ' (blocking)' : ''}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: `The ${topic} event, in ${scopeText}`, worstCase: 'once per machine per deployment — in a bulk request that is once per machine' },
        scope: {
          what: `Every ${topic} event in ${scopeText}.`,
          decidedBy: ['The event topic.', projectOnly ? 'The subscription’s project constraint: the action’s own project.' : 'No project constraint: every project.', condition ? `The condition: ${condition}.` : 'No condition.', `Priority ${priority} among the subscriptions on the topic.`],
          ifWrong: blocking
            ? 'On a blocking subscription, every deployment in scope waits on this action. A slow or failing endpoint stalls them, and it looks like VCF Automation is broken.'
            : 'The action runs for deployments you did not intend, and posts to the endpoint for all of them.',
        },
        guardrails: [
          { rule: projectOnly ? 'Scoped to the action’s project' : 'Scoped to the organization — see the scope', because: 'A subscription applies to everything its scope matches the moment it is created, and it is created enabled.' },
          { rule: `Action times out after ${timeout} seconds${blocking ? `; the event waits at most ${subscriptionTimeout} minutes` : ''}`, because: blocking ? 'On a blocking topic, no timeout means a hung endpoint hangs every deployment indefinitely.' : 'An action with no timeout eventually runs out of the platform’s patience, less clearly.' },
          ...(failOpen ? [{ rule: 'Fails open', because: 'The deployment is what the requester asked for. Registration failing is a gap to fix, not a reason to refuse them a machine.' }] : []),
          ...(recovery ? [{ rule: `Recovery action: ${recovery}`, because: 'A blocking failure then has a defined clean-up rather than a half-made deployment.' }] : []),
          { rule: 'Secrets are encrypted action secrets, created from the environment', because: 'An action is exported, versioned and read by more people than you think.' },
        ],
        dryRun: [
          `Run the workflow Create ABX action ${base} with dryRun = true: it reads the project, the actions and the subscriptions, and logs what it would create or update.`,
          'Run the action from the interface with a sample payload and `__dryRun` set. It logs what it would post and returns.',
          'scripts/abx-constants.sh --dry-run lists the constants and secrets it would create.',
        ],
        undo: ['Disable or delete the subscription (Extensibility → Subscriptions, or DELETE /event-broker/api/subscriptions/{id}). The action stays; deployments stop calling it.', 'Anything already registered downstream is not removed — that is the endpoint’s business.'],
        told: ['The action run log in VCF Automation (Extensibility → Activity → Action Runs). Ship it to VCF Operations for Logs if you want to know it stopped working.'],
        requires: [
          `The constants and secrets it reads: ${constants.map((c) => c.name).join(', ') || 'none'} (scripts/abx-constants.sh).`,
          endpoint ? `Network path from the extensibility runtime to ${endpoint}.` : 'An endpoint to call.',
          ...(recovery ? [`The ABX action "${recovery}" in the same project.`] : []),
        ],
        files: {
          ...pkg.files,
          [`${base}.${ext}`]: source,
          [`${base}-subscription.json`]: json(subscription),
          ...(constants.length > 0 ? { 'scripts/abx-constants.sh': constantsScript(constants) } : {}),
          ...(runtime === 'powershell'
            ? { [`scripts/${base}.ps1`]: source, [`scripts/${base}-action.json`]: json(actionBody), [`scripts/${base}-subscription.json`]: json({ ...subscription, runnableId: '' }), 'scripts/apply.sh': powershellApply(base) }
            : {}),
          ...importedFiles,
          'IMPORT.md': importMd({
            subject: `The ABX action "${actionName}" and its subscription on ${topic}.`,
            steps: withPackageSteps(pkg, [
              ...(constants.length > 0
                ? [apiStep('First: the constants and secrets', 'scripts/abx-constants.sh', constants.map((c) => `${c.name} (${c.kind}${c.kind === 'secret' ? `, value from ${c.value}` : ''}) → POST /abx/api/resources/action-secrets`), ['An existing one of the same name is left as it is. By hand: Extensibility → Library → Actions → Action Constants/Secrets (VERIFY the menu path).'])]
                : []),
              manualStep('The project', [`Set projectId in the configuration element. The workflow reads the organization id from the project (the ABX API requires orgId), creates the action with the script inline — or updates the one with the same name in the project when its script differs — and then creates the subscription, enabled${projectOnly ? ' and constrained to that project' : ''}, with the action id in runnableId${recovery ? ` and the id of "${recovery}" as its recovery runnable` : ''}. An existing subscription of the same name is left as it is.`]),
              ...(imported && projectOnly ? [manualStep('If you use the import script instead of the workflow', ['import/create-abx-action.sh cannot add the project constraint or the recovery action, so it creates the subscription disabled: add the project scope (and the recovery action) under Extensibility → Subscriptions, then enable it. The workflow creates it enabled and scoped in one go.'])] : []),
              ...(imported ? [imported.steps.abx] : [apiStep('Or by script: PowerShell action and subscription', 'scripts/apply.sh', [`\`scripts/${base}-action.json\` with \`scripts/${base}.ps1\` inline → POST /abx/api/resources/actions`, `\`scripts/${base}-subscription.json\` → POST /event-broker/api/subscriptions`], ['VCFA_PROJECT_ID names the project. The script is not idempotent; the workflow is.'])]),
            ]),
            auth: ['import', 'apply'],
            verify: packageVerify([
              ...(imported ? verifyFor(imported) : []),
              'ABX: the 9.1 VM Apps Org - ABX reference lists name, runtime, entrypoint, actionType and orgId as required on POST /abx/api/resources/actions, which is why the workflow reads orgId from the project. runtime "powershell", runtimeVersion and the dependencies format are VERIFY.',
              'Action constants and secrets: POST /abx/api/resources/action-secrets with name, value and encrypted, and the action input that refers to one (written here as "secret:<name>" / "constant:<name>"), are VERIFY — export an action with one attached and compare.',
              'Subscription: POST /event-broker/api/subscriptions with the fields in subscription.json (blocking, priority, timeout in minutes, criteria, constraints.projectId, recoverRunnableType/Id); on 8.x the client supplies the id, which the workflow and the script do. The 9.1 event broker reference was not reachable to confirm the body — VERIFY by GET of one made in the interface. The topic list is VERIFY against GET /event-broker/api/topics.',
            ]),
          }),
        },
        notes: [
          blocking
            ? 'This is a blocking subscription. Every deployment in its scope waits for this action to return.'
            : 'This is a non-blocking subscription, so a failure affects the registration and not the deployment.',
          'The subscription is created enabled. Its scope is the project constraint and the condition; nothing else narrows it.',
          ...(runtime === 'powershell' ? ['A PowerShell action has no import/abx folder (the shared import script takes Python and Node.js): the workflow, or scripts/apply.sh, creates it.'] : []),
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfa_approval_policy',
    platform: PLATFORM,
    label: 'An approval policy that can actually say no',
    group: 'Governance',
    description:
      'Approval on the requests that warrant it and not on the ones that do not — scoped to a project or the organization, matched by criteria, for create or day-2 actions, with one or two levels of approvers. The failure here is not too little approval — it is approval on everything, which becomes a rubber stamp within a month.',
    inputs: [
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'Large deployments need approval' },
      { id: 'scope', label: 'Applies to', control: 'select', options: SCOPE_OPTIONS, default: 'project' },
      {
        id: 'when',
        label: 'Ask for approval when',
        control: 'select',
        options: [
          { value: 'size', label: 'The request is large' },
          { value: 'prod', label: 'It is going to production' },
          { value: 'cost', label: 'It costs more than a threshold' },
          { value: 'custom', label: 'The criteria below match' },
          { value: 'always', label: 'Always — see the finding' },
        ],
        default: 'size',
      },
      { id: 'threshold', label: 'Threshold', control: 'text', default: '8 vCPU or 32 GB', hint: 'What counts as large, or the cost figure', showWhen: { input: 'when', equals: ['size', 'cost'] } },
      ...criteriaInputs('catalogItemName | eq | Standard Linux server\ndeployment.inputs.environment | eq | prod', { input: 'when', equals: ['custom'] }),
      { id: 'actions', label: 'For these actions', control: 'text', default: 'Deployment.Create', hint: 'Comma separated: Deployment.Create, Deployment.Delete, Cloud.vSphere.Machine.Resize… (VERIFY the action ids your release lists)' },
      { id: 'approvers', label: 'Approvers', control: 'text', default: 'platform-leads@example.com', hint: 'Comma separated. Prefix an entry with user: or group: to override the setting below' },
      {
        id: 'approvers_are',
        label: 'Unprefixed approvers are',
        control: 'select',
        options: [
          { value: 'GROUP', label: 'Groups — approve to a team' },
          { value: 'USER', label: 'Users — named people' },
          { value: 'ROLE', label: 'Roles — e.g. project administrators (VERIFY)' },
        ],
        default: 'GROUP',
      },
      {
        id: 'approval_mode',
        label: 'Needs',
        control: 'select',
        options: [
          { value: 'ANY_OF', label: 'Any one approver' },
          { value: 'ALL_OF', label: 'Every approver' },
        ],
        default: 'ANY_OF',
      },
      { id: 'level2_approvers', label: 'Second-level approvers', control: 'text', default: '', placeholder: 'group:finance-approvers@example.com', hint: 'Empty: one level. Asked after the first level approves' },
      { id: 'auto_expire_days', label: 'Auto-decide after (days)', control: 'number', default: 2, min: 1, max: 30, hint: 'The API counts in whole days' },
      {
        id: 'on_expiry',
        label: 'When it expires',
        control: 'select',
        options: [
          { value: 'REJECT', label: 'Reject it' },
          { value: 'APPROVE', label: 'Approve it — see the finding' },
        ],
        default: 'REJECT',
      },
    ],
    automation: (values                 , name        )             => {
      const policyName = str(values, 'policy_name', 'Approval policy');
      const scope = str(values, 'scope', 'project') === 'org' ? 'org' : 'project';
      const when = str(values, 'when', 'size');
      const threshold = str(values, 'threshold', '8 vCPU or 32 GB');
      const approversAre = ['USER', 'ROLE'].includes(str(values, 'approvers_are', 'GROUP')) ? str(values, 'approvers_are', 'GROUP') : 'GROUP';
      const mode = str(values, 'approval_mode', 'ANY_OF') === 'ALL_OF' ? 'ALL_OF' : 'ANY_OF';
      const actions = listOf(str(values, 'actions', 'Deployment.Create'));
      const parse = (text        ) =>
        listOf(text).map((entry) => {
          const match = /^(user|group)\s*:\s*(.+)$/i.exec(entry);
          return match ? { kind: match[1] .toUpperCase()                             , id: match[2] .trim() } : { kind: approversAre                             , id: entry };
        });
      // Each entry becomes USER:<id> or GROUP:<id>. An explicit user:/group: prefix wins.
      const approvers = parse(str(values, 'approvers', ''));
      const level2 = parse(str(values, 'level2_approvers', ''));
      const approverNames = approvers.map((approver) => approver.id);
      const expiry = Math.max(1, Math.round(num(values, 'auto_expire_days', 2)));
      const onExpiry = str(values, 'on_expiry', 'REJECT');
      const base = slugOf(name || policyName, 'approval-policy');
      const custom = when === 'custom' ? criteriaOf(str(values, 'criteria', ''), str(values, 'criteria_join', 'all'), policyName) : undefined;

      const findings            = [...(custom?.findings ?? [])];
      if (when === 'always') {
        findings.push(
          warning('vcfa.approval.everything', 'Approval on every request becomes a rubber stamp, and a rubber stamp is worse than no approval because it looks like control.', {
            remediation: 'Approve what is large, expensive or production-bound. Let the rest through — that is what the catalogue was for.',
            source: SRC,
          }),
        );
      }
      if (custom && !custom.expression) findings.push(error('vcfa.approval.no-criteria', 'Criteria was chosen and no row is given.', { source: SRC }));
      if (onExpiry === 'APPROVE') {
        findings.push(
          error('vcfa.approval.auto-approve', 'An unanswered request is approved automatically after the timeout.', {
            remediation: 'That is not approval, it is a delay. If waiting is acceptable, the request did not need approving; if it is not, expire to rejected and let people re-request.',
            source: SRC,
          }),
        );
      }
      if (approvers.length === 0) findings.push(error('vcfa.approval.no-approver', 'Nobody is named to approve.', { source: SRC }));
      if (approvers.length === 1 && approvers[0] .kind === 'USER') {
        findings.push(
          warning('vcfa.approval.single-approver', 'One approver is one holiday away from a stalled catalogue.', {
            remediation: 'Approve to a group rather than a person.',
            source: SRC,
          }),
        );
      }
      if (mode === 'ALL_OF' && approvers.length > 2) findings.push(warning('vcfa.approval.all-of-many', `Every one of ${approvers.length} approvers must approve: the request waits for the slowest of them.`, { source: SRC }));
      if (scope === 'org') findings.push(warning('vcfa.approval.org-wide', 'The policy applies to every project in the organization.', { remediation: 'Organization-wide approval is sometimes right (production everywhere); make sure the criteria narrow it, or every project’s requests wait.', source: SRC }));
      if (actions.length === 0) findings.push(error('vcfa.approval.no-actions', 'No action is named, so the policy never applies.', { source: SRC }));

      const criteria =
        when === 'size'
          ? `Requests over ${threshold}`
          : when === 'prod'
            ? 'Requests where environment == prod'
            : when === 'cost'
              ? `Requests with an estimated cost over ${threshold}`
              : when === 'custom'
                ? `Requests where ${custom?.text ?? ''}`
                : 'Every request';

      const policyFor = (level        , list                  , levelName        ) => ({
        name: levelName,
        typeId: 'com.vmware.policy.approval',
        enforcementType: 'HARD',
        definition: {
          level,
          // USER covers named users and groups; ROLE is the role-based form (project administrators and the like).
          approverType: approversAre === 'ROLE' ? 'ROLE' : 'USER',
          approvalMode: mode,
          approvers: list.map((approver) => (approver.kind === 'ROLE' ? approver.id : `${approver.kind}:${approver.id}`)),
          // What happens when nobody answers, and after how many days.
          autoApprovalDecision: onExpiry === 'APPROVE' ? 'APPROVE' : 'REJECT',
          autoApprovalExpiry: expiry,
          actions,
        },
        // Every request: no criteria at all. Custom: the rows. Otherwise the
        // expression has to be written for this organization's properties, so
        // it stays a placeholder a live run refuses to send.
        ...(when === 'always' ? {} : when === 'custom' ? (custom?.expression ? { criteria: custom.expression } : {}) : { criteria: { matchExpression: [{ key: '<REQUIRED — the expression for: ' + criteria + '>', operator: 'eq', value: '<REQUIRED>' }] } }),
        // A project-scoped policy names its project in projectId (the Policy
        // body in the 9.1 VM Apps Org - Policies reference).
        ...(scope === 'project' ? { projectId: '<REQUIRED — project id>' } : {}),
      });
      const policy = policyFor(1, approvers, policyName);
      const second = level2.length > 0 ? policyFor(2, level2, `${policyName} — level 2`) : undefined;
      const payloads                          = { 'approval-policy.json': policy, ...(second ? { 'approval-policy-level2.json': second } : {}) };

      const pkg = vcfaPackage({
        thing: 'approval',
        base,
        folder: 'Policies',
        workflowName: `Create approval policy ${base}`,
        description: `Creates the approval policy "${policyName}"${second ? ' and its second level' : ''} in a VCF Automation VM Apps organization${scope === 'project' ? ' project' : ''}.`,
        outputs: { policyId: 'POLICY_ID', ...(second ? { level2PolicyId: 'LEVEL2_POLICY_ID' } : {}) },
        payloads,
        settings: scope === 'project' ? [{ name: 'projectId', type: 'string', value: '', description: 'The project the policy applies to (GET /iaas/api/projects)' }] : [],
        cap: second ? 2 : 1,
        script: [
          stepsJs([
            { key: 'POLICY_ID', label: `approval policy "${policyName}"`, resource: 'approval-policy.json', list: '/policy/api/policies?typeId=com.vmware.policy.approval', style: 'page', create: '/policy/api/policies', sameProject: scope === 'project' },
            ...(second ? [{ key: 'LEVEL2_POLICY_ID', label: `approval policy "${second.name}"`, resource: 'approval-policy-level2.json', list: '/policy/api/policies?typeId=com.vmware.policy.approval', style: 'page'         , create: '/policy/api/policies', sameProject: scope === 'project' }] : []),
          ]),
          policyScript(Object.keys(payloads), scope === 'project'),
        ].join(''),
      });

      const files                         = { [`scripts/${base}.json`]: json(policy), ...(second ? { [`scripts/${base}-level2.json`]: json(second) } : {}) };
      return {
        platform: PLATFORM,
        title: `${policyName} — ${criteria.toLowerCase()} wait for ${approverNames.join(', ') || 'nobody'}${second ? ', then a second level' : ''}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: `${criteria}, for ${actions.join(', ')}`, worstCase: 'as often as people request something matching the criteria' },
        scope: {
          what: `${actions.join(', ')} requests in ${scope === 'project' ? 'the project this policy is scoped to' : 'every project of the organization'}, matching the criteria above.`,
          decidedBy: [scope === 'project' ? 'The project in projectId.' : 'The organization: no project.', 'The match criteria — which requests within it.', 'The actions the policy names.', 'Other approval policies: every matching policy applies, level by level.'],
          ifWrong: 'Either everything waits for approval and the catalogue stops being used, or nothing does and the policy is decoration.',
        },
        guardrails: [
          { rule: `Decides automatically after ${expiry} day${expiry === 1 ? '' : 's'}, by ${onExpiry === 'APPROVE' ? 'approving' : 'rejecting'}`, because: 'A request that waits forever is a request that gets raised as a ticket instead, and then the catalogue is not used.' },
          { rule: scope === 'project' ? 'Scoped to a project' : 'Organization-wide — see the finding', because: 'An unscoped approval policy applies to every request in the organisation, which is discovered on the first busy morning.' },
          ...(approvers.length > 1 || approvers.some((approver) => approver.kind === 'GROUP')
            ? [{ rule: mode === 'ALL_OF' ? 'Every named approver must approve' : approvers.length > 1 ? 'Any one of several approvers' : 'Any member of the approving group', because: 'One named approver is a single point of failure with a holiday calendar.' }]
            : []),
        ],
        dryRun: [
          `Run the workflow Create approval policy ${base} with dryRun = true: it reads the approval policies and warns about every value still a placeholder${when === 'custom' || when === 'always' ? '' : ' — the criteria expression'}${scope === 'project' ? ' and the project' : ''} — which a live run refuses to send.`,
          'Apply it to a test project and request something that should need approval, then something that should not. Both halves are worth checking.',
        ],
        undo: ['DELETE the policy, or set enforcementType to SOFT. Requests already waiting keep waiting — decide them before removing it.'],
        told: [`${approverNames.join(', ') || 'Nobody'}, at request time, through whatever notification the deployment is configured for.`],
        requires: [...(scope === 'project' ? ['The project it is scoped to.'] : []), 'The approvers to exist as users or groups in VCF Automation.'],
        files: {
          ...pkg.files,
          ...files,
          'scripts/apply.sh': fromScriptsDir(applyScript('vcf-automation', Object.keys(files).map((f) => ({ method: 'POST'         , path: '/policy/api/policies', payload: f.replace(/^scripts\//, '') })), 'DELETE /policy/api/policies/{id}, after deciding the requests already waiting on it.')),
          'IMPORT.md': importMd({
            subject: `The approval policy "${policyName}".`,
            steps: withPackageSteps(pkg, [
              manualStep('What only you can fill', [
                `${scope === 'project' ? 'Set projectId in the configuration element.' : 'Nothing to fill for the scope: the policy is organization-wide.'}${when === 'always' || when === 'custom' ? '' : ' Write the criteria expression into payloadOverrides, e.g. `{"approval-policy.json": {"criteria": {"matchExpression": [{"key": "…", "operator": "…", "value": "…"}]}}}` — a live run refuses to send the placeholder, because a policy with a criteria that matches nothing looks exactly like a policy that is working. Or choose "The criteria below match" and write the rows.'}`,
              ]),
              apiStep('Or by script: approval policy', 'scripts/apply.sh', Object.keys(files).map((f) => `\`${f}\` → POST /policy/api/policies`), [
                `Fill the \`<REQUIRED>\` values first${when === 'always' || when === 'custom' ? '' : ': the match expression for the criteria'}${scope === 'project' ? `${when === 'always' || when === 'custom' ? ':' : ', and'} the project id` : ''}. The script does not check them for you — sent as placeholders, the policy is created and matches nothing, which looks exactly like a policy that is working.`,
                `By hand: ${POLICY_MENU} → Approval policy, with the same approvers, expiry and decision.`,
                'All Apps organizations: approval policies are made under the organization’s own Policies page; the API route for them is not in the public 9.1 reference, so this blueprint writes the VM Apps policy only.',
              ]),
            ]),
            auth: ['apply'],
            verify: packageVerify([
              'The approval definition follows the 8.16 API programming guide example; the GROUP:<id> approver form, approverType ROLE, approvalMode ALL_OF, level 2 as a second policy and the criteria operators are VERIFY — create one policy of each kind in the interface and GET it.',
              'The 9.1 Policy body (VM Apps Org - Policies) has projectId, which replaces the scopeCriteria key "project" older versions of this kit wrote.',
            ]),
          }),
        },
        notes: [
          'The criteria expression is the part to test. It is easy to write one that matches nothing, and a policy that matches nothing looks exactly like a policy that is working.',
          'The definition follows the approval-policy example in the 8.16 automation API programming guide: approverType USER, approvers as USER:<id>, autoApprovalDecision APPROVE or REJECT, autoApprovalExpiry in days. Make one policy with a group approver in the interface, GET it on your own release and match its shape before relying on the group form.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfa_lease_policy',
    platform: PLATFORM,
    label: 'A lease policy, so deployments expire',
    group: 'Governance',
    description:
      'How long a deployment lives before it expires, how far it may be renewed, and how long it lingers powered off before it is destroyed — for one project or the whole organization, for every deployment or those the criteria match.',
    inputs: [
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'Standard lease' },
      { id: 'scope', label: 'Applies to', control: 'select', options: SCOPE_OPTIONS, default: 'project' },
      {
        id: 'applies_to',
        label: 'Deployments',
        control: 'select',
        options: [
          { value: 'all', label: 'Every deployment in scope' },
          { value: 'criteria', label: 'Those the criteria match' },
        ],
        default: 'all',
      },
      ...criteriaInputs('deployment.inputs.environment | in | dev,test', { input: 'applies_to', equals: ['criteria'] }),
      { id: 'max_lease_days', label: 'Maximum lease (days)', control: 'number', default: 30, min: 1, max: 3650, hint: 'The longest a requester may ask for, and each renewal' },
      { id: 'max_total_days', label: 'Maximum total lease (days)', control: 'number', default: 90, min: 1, max: 3650, hint: 'Across all renewals' },
      { id: 'grace_days', label: 'Grace period (days)', control: 'number', default: 7, min: 0, max: 365, hint: 'Powered off, then destroyed, after it expires' },
      { id: 'enforcement', label: 'Enforcement', control: 'select', options: ENFORCEMENT_OPTIONS, default: 'HARD' },
      { id: 'description', label: 'Description', control: 'text', default: 'Deployments expire; renew them if they are still needed.' },
    ],
    automation: (values                 , name        )             => {
      const policyName = str(values, 'policy_name', 'Lease policy');
      const scope = str(values, 'scope', 'project') === 'org' ? 'org' : 'project';
      const matching = str(values, 'applies_to', 'all') === 'criteria';
      const lease = Math.round(num(values, 'max_lease_days', 30));
      const total = Math.round(num(values, 'max_total_days', 90));
      const grace = Math.round(num(values, 'grace_days', 7));
      const enforcement = str(values, 'enforcement', 'HARD') === 'SOFT' ? 'SOFT' : 'HARD';
      const description = str(values, 'description', '');
      const base = slugOf(name || policyName, 'lease-policy');
      const criteria = matching ? criteriaOf(str(values, 'criteria', ''), str(values, 'criteria_join', 'all'), policyName) : undefined;

      const findings            = [...(criteria?.findings ?? [])];
      if (total < lease) findings.push(error('vcfa.lease.total-below-lease', `The maximum total lease (${total} days) is shorter than one lease (${lease} days).`, { remediation: 'The total is across renewals, so it is at least one lease.', source: SRC }));
      if (grace === 0) findings.push(warning('vcfa.lease.no-grace', 'No grace period: an expired deployment is destroyed the moment its lease ends.', { remediation: 'A week of grace — powered off, recoverable — turns a missed renewal into a phone call rather than a restore.', source: SRC }));
      if (total > 365) findings.push(warning('vcfa.lease.long', `A total lease of ${total} days is more than a year: effectively no lease.`, { source: SRC }));
      if (matching && !criteria?.expression) findings.push(error('vcfa.lease.no-criteria', 'Criteria was chosen and no row is given.', { source: SRC }));

      const policy = {
        name: policyName,
        description,
        typeId: 'com.vmware.policy.deployment.lease',
        enforcementType: enforcement,
        definition: { leaseTermMax: lease, leaseTotalTermMax: total, leaseGrace: grace },
        ...(criteria?.expression ? { criteria: criteria.expression } : {}),
        ...(scope === 'project' ? { projectId: '<REQUIRED — project id>' } : {}),
      };

      const pkg = vcfaPackage({
        thing: 'lease',
        base,
        folder: 'Policies',
        workflowName: `Create lease policy ${base}`,
        description: `Creates the lease policy "${policyName}" in a VCF Automation VM Apps organization${scope === 'project' ? ' project' : ''}.`,
        outputs: { policyId: 'POLICY_ID' },
        payloads: { 'lease-policy.json': policy },
        settings: scope === 'project' ? [{ name: 'projectId', type: 'string', value: '', description: 'The project the policy applies to (GET /iaas/api/projects)' }] : [],
        cap: 1,
        script: [
          stepsJs([{ key: 'POLICY_ID', label: `lease policy "${policyName}"`, resource: 'lease-policy.json', list: '/policy/api/policies?typeId=com.vmware.policy.deployment.lease', style: 'page', create: '/policy/api/policies', sameProject: scope === 'project' }]),
          policyScript(['lease-policy.json'], scope === 'project'),
        ].join(''),
      });

      const where = scope === 'project' ? 'one project' : 'every project of the organization';
      return {
        platform: PLATFORM,
        title: `${policyName} — ${lease}-day lease, ${total} days in all, ${grace} days’ grace`,
        effect: 'irreversible',
        trigger: { kind: 'schedule', detail: `A deployment in ${where}${criteria ? ` where ${criteria.text}` : ''} reaches the end of its lease`, worstCase: 'every deployment created on one busy day expiring on the same day, a lease later' },
        scope: {
          what: `Deployments in ${where}${criteria ? ` where ${criteria.text}` : ''}, created after the policy.`,
          decidedBy: [scope === 'project' ? 'The project in projectId.' : 'The organization: no project.', criteria ? `The criteria: ${criteria.text}.` : 'No criteria: every deployment.', `Enforcement ${enforcement}: ${enforcement === 'HARD' ? 'a lower-scope policy cannot loosen it' : 'a project-scoped policy may override it'}.`],
          ifWrong: 'Deployments nobody meant to expire are powered off and, after the grace period, destroyed. The owner is notified; whether they read it is another matter.',
        },
        guardrails: [
          { rule: `${grace} days’ grace, powered off, before destruction`, because: 'An expired deployment that is only powered off is recovered by renewing it.' },
          { rule: `At most ${total} days in all`, because: 'Renewal without a ceiling is a lease in name only.' },
          { rule: scope === 'project' ? 'Scoped to a project' : 'Organization-wide', because: 'A lease applied more widely than intended expires production.' },
        ],
        dryRun: [`Run the workflow Create lease policy ${base} with dryRun = true: it reads the lease policies and logs what it would create${scope === 'project' ? ', refusing a live run until projectId is set' : ''}.`, 'Apply it to a test project first and deploy something with a one-day lease to see the notice, the power-off and the destroy.'],
        undo: ['DELETE /policy/api/policies/{id}. Deployments keep the lease they were given; change them one by one (Change Lease) if needed.', 'A deployment already destroyed at the end of its grace period is gone: that part cannot be undone.'],
        told: ['The deployment owner, by the lease-expiry notifications VCF Automation sends before it expires and when it does.'],
        requires: [...(scope === 'project' ? ['The project it is scoped to.'] : []), 'Owners with working e-mail addresses, so the expiry notices reach somebody.'],
        files: {
          ...pkg.files,
          [`scripts/${base}.json`]: json(policy),
          'scripts/apply.sh': fromScriptsDir(applyScript('vcf-automation', [{ method: 'POST', path: '/policy/api/policies', payload: `${base}.json` }], 'DELETE /policy/api/policies/{id}.')),
          'IMPORT.md': importMd({
            subject: `The lease policy "${policyName}".`,
            steps: withPackageSteps(pkg, [
              manualStep('The scope', [scope === 'project' ? 'Set projectId in the configuration element; a live run refuses to send the placeholder.' : 'Nothing to fill: the policy is organization-wide.']),
              apiStep('Or by script: lease policy', 'scripts/apply.sh', [`\`scripts/${base}.json\` → POST /policy/api/policies`], [`${scope === 'project' ? 'Replace `<REQUIRED — project id>` first. ' : ''}By hand: ${POLICY_MENU} → Lease policy. The script is not idempotent; the workflow is.`]),
            ]),
            auth: ['apply'],
            verify: packageVerify(['Lease policy: typeId com.vmware.policy.deployment.lease, the definition keys leaseTermMax, leaseTotalTermMax and leaseGrace (days) and the criteria matchExpression follow the 8.x policy API; GET one made in the interface on your 9.1 release and compare.']),
          }),
        },
        notes: ['Lease policies are evaluated together: the most restrictive hard policy wins. Soft policies are the defaults a project can tighten or loosen.', 'The cloud template blueprint can also create a simple per-project lease; use this one for criteria, organization scope or soft enforcement.'],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfa_resource_quota',
    platform: PLATFORM,
    label: 'A resource quota or deployment limit policy',
    group: 'Governance',
    description:
      'How much a user, a project or the organization may have in all (resource quota), or how large one deployment may be (deployment limit): vCPU, memory, storage and machine count, enforced before the request is placed.',
    inputs: [
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'Per-user quota' },
      {
        id: 'kind',
        label: 'Kind',
        control: 'select',
        options: [
          { value: 'quota', label: 'Resource quota — totals across deployments' },
          { value: 'limit', label: 'Deployment limit — the size of one deployment' },
        ],
        default: 'quota',
      },
      {
        id: 'level',
        label: 'Counted per',
        control: 'select',
        options: [
          { value: 'user', label: 'User, within the scope' },
          { value: 'project', label: 'Project' },
          { value: 'org', label: 'Organization' },
        ],
        default: 'user',
        showWhen: { input: 'kind', equals: ['quota'] },
      },
      { id: 'scope', label: 'Applies to', control: 'select', options: SCOPE_OPTIONS, default: 'project' },
      { id: 'cpu', label: 'vCPU', control: 'number', default: 16, min: 0, max: 100000, hint: '0 is no limit' },
      { id: 'memory_gb', label: 'Memory (GB)', control: 'number', default: 64, min: 0, max: 1000000, hint: '0 is no limit' },
      { id: 'storage_gb', label: 'Storage (GB)', control: 'number', default: 1000, min: 0, max: 10000000, hint: '0 is no limit' },
      { id: 'vm_count', label: 'Machines', control: 'number', default: 10, min: 0, max: 100000, hint: '0 is no limit' },
      { id: 'enforcement', label: 'Enforcement', control: 'select', options: ENFORCEMENT_OPTIONS, default: 'HARD' },
    ],
    automation: (values                 , name        )             => {
      const policyName = str(values, 'policy_name', 'Quota');
      const kind = str(values, 'kind', 'quota') === 'limit' ? 'limit' : 'quota';
      const level = ['project', 'org'].includes(str(values, 'level', 'user')) ? str(values, 'level', 'user') : 'user';
      const scope = str(values, 'scope', 'project') === 'org' ? 'org' : 'project';
      const cpu = Math.round(num(values, 'cpu', 16));
      const memory = Math.round(num(values, 'memory_gb', 64));
      const storage = Math.round(num(values, 'storage_gb', 1000));
      const vms = Math.round(num(values, 'vm_count', 10));
      const enforcement = str(values, 'enforcement', 'HARD') === 'SOFT' ? 'SOFT' : 'HARD';
      const base = slugOf(name || policyName, 'quota-policy');
      const typeId = kind === 'quota' ? 'com.vmware.policy.resource.quota' : 'com.vmware.policy.deployment.limit';

      const findings            = [];
      const unlimited = [cpu === 0 && 'vCPU', memory === 0 && 'memory', storage === 0 && 'storage', vms === 0 && 'machines'].filter(Boolean)            ;
      if (unlimited.length === 4) findings.push(error('vcfa.quota.nothing', 'Every limit is 0 (none), so the policy limits nothing.', { source: SRC }));
      else if (unlimited.length > 0) findings.push(warning('vcfa.quota.partial', `No limit on ${unlimited.join(', ')}.`, { remediation: 'A quota on vCPU alone is met by one machine with a terabyte of memory.', source: SRC }));
      if (kind === 'quota' && level === 'org' && scope === 'project') findings.push(warning('vcfa.quota.level-scope', 'An organization-level total on a project-scoped policy counts the whole organization against one project’s policy.', { remediation: 'Scope an organization total to the organization.', source: SRC }));

      const limits = {
        ...(cpu > 0 ? { cpu: { value: cpu } } : {}),
        ...(memory > 0 ? { memory: { value: memory, unit: 'GB' } } : {}),
        ...(storage > 0 ? { storage: { value: storage, unit: 'GB' } } : {}),
        ...(vms > 0 ? { instances: { value: vms } } : {}),
      };
      const definition = kind === 'quota' ? { [`${level}Level`]: { limits } } : { deploymentLimits: limits };
      const policy = { name: policyName, typeId, enforcementType: enforcement, definition, ...(scope === 'project' ? { projectId: '<REQUIRED — project id>' } : {}) };

      const pkg = vcfaPackage({
        thing: 'quota',
        base,
        folder: 'Policies',
        workflowName: `Create ${kind === 'quota' ? 'resource quota' : 'deployment limit'} policy ${base}`,
        description: `Creates the ${kind === 'quota' ? 'resource quota' : 'deployment limit'} policy "${policyName}" in a VCF Automation VM Apps organization${scope === 'project' ? ' project' : ''}.`,
        outputs: { policyId: 'POLICY_ID' },
        payloads: { 'policy.json': policy },
        settings: scope === 'project' ? [{ name: 'projectId', type: 'string', value: '', description: 'The project the policy applies to (GET /iaas/api/projects)' }] : [],
        cap: 1,
        script: [stepsJs([{ key: 'POLICY_ID', label: `policy "${policyName}"`, resource: 'policy.json', list: `/policy/api/policies?typeId=${typeId}`, style: 'page', create: '/policy/api/policies', sameProject: scope === 'project' }]), policyScript(['policy.json'], scope === 'project')].join(''),
      });

      const text = [cpu && `${cpu} vCPU`, memory && `${memory} GB memory`, storage && `${storage} GB storage`, vms && `${vms} machines`].filter(Boolean).join(', ');
      const per = kind === 'quota' ? `per ${level === 'org' ? 'organization' : level}` : 'per deployment';
      return {
        platform: PLATFORM,
        title: `${policyName} — ${text || 'no limits'} ${per}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: `Every request in ${scope === 'project' ? 'the project' : 'the organization'}, checked before placement`, worstCase: 'every request; one over the limit is refused' },
        scope: {
          what: `Requests in ${scope === 'project' ? 'one project' : 'every project of the organization'}, counted ${per}.`,
          decidedBy: [scope === 'project' ? 'The project in projectId.' : 'The organization.', kind === 'quota' ? `The level the totals are kept at: ${level}.` : 'Each deployment on its own.', `Enforcement ${enforcement}.`],
          ifWrong: 'Requests are refused that should have been allowed — or a limit too high stops nothing. A refusal is visible and immediate; too high is silent.',
        },
        guardrails: [{ rule: `${text || 'Nothing'} ${per}`, because: 'A quota is the only thing between a loop in someone’s pipeline and a full cluster.' }, { rule: 'Checked before placement', because: 'A request over the limit is refused before anything is built, rather than half-built.' }],
        dryRun: [`Run the workflow with dryRun = true: it reads the policies of this type and logs what it would create.`, 'Request something just over the limit in a test project and check the refusal reads clearly.'],
        undo: ['DELETE /policy/api/policies/{id}; nothing deployed is affected.'],
        told: ['The requester, at request time, with the refusal. Nobody else.'],
        requires: scope === 'project' ? ['The project it is scoped to.'] : ['Nothing beyond the organization.'],
        files: {
          ...pkg.files,
          [`scripts/${base}.json`]: json(policy),
          'scripts/apply.sh': fromScriptsDir(applyScript('vcf-automation', [{ method: 'POST', path: '/policy/api/policies', payload: `${base}.json` }], 'DELETE /policy/api/policies/{id}.')),
          'IMPORT.md': importMd({
            subject: `The ${kind === 'quota' ? 'resource quota' : 'deployment limit'} policy "${policyName}".`,
            steps: withPackageSteps(pkg, [
              manualStep('The scope', [scope === 'project' ? 'Set projectId in the configuration element; a live run refuses to send the placeholder.' : 'Nothing to fill: the policy is organization-wide.']),
              apiStep('Or by script', 'scripts/apply.sh', [`\`scripts/${base}.json\` → POST /policy/api/policies`], [`By hand: ${POLICY_MENU} → ${kind === 'quota' ? 'Resource quota' : 'Deployment limit'} policy.`]),
            ]),
            auth: ['apply'],
            verify: packageVerify([`${kind === 'quota' ? 'Resource quota' : 'Deployment limit'}: typeId ${typeId} and the definition (${kind === 'quota' ? `${level}Level.limits` : 'deploymentLimits'} with cpu, memory, storage and instances as { value, unit }) are VERIFY — the public 9.1 policy reference does not show this definition. Create one in the interface, GET it, and match the shape (payloadOverrides takes the corrected definition).`]),
          }),
        },
        notes: ['Project zone limits (the project blueprint) cap what a project may place in each cloud zone; this policy caps what a user, project or deployment may have wherever it lands. Use both.'],
        findings,
      };
    },
  }),
];
