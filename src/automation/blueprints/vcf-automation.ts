/**
 * VCF Automation: the self-service side.
 *
 * Formerly Aria Automation, and vRA before that. The unit here is not a script
 * but a *contract with a requester*: a cloud template says what they can ask
 * for, a policy says what happens before they get it, a subscription hooks code
 * onto the moment it is created, and a day-2 policy says what they may do to it
 * afterwards.
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

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { applyScript } from '../apply.ts';
import { apiStep, importBundle, importMd, manualStep, setupOrderStep, stableId, templatePath, verifyFor } from '../vcfa-import.ts';
import { fromScriptsDir, packageVerify, stepsJs, vcfaPackage, withPackageSteps } from './vcf-automation-setup.ts';

const PLATFORM = 'vcf-automation' as const;

export const VCF_AUTOMATION_AUTOMATIONS: readonly AutomationBlueprint[] = [
  automationBlueprint({
    id: 'vcfa_cloud_template',
    platform: PLATFORM,
    label: 'A cloud template people can request',
    group: 'Catalogue',
    description:
      'A VM cloud template with the four things most hand-written ones are missing: a lease so it does not live forever, constrained inputs so nobody requests 64 vCPUs, tags that make it findable afterwards, and a project-scoped cloud zone so it lands where it should.',
    inputs: [
      { id: 'template_name', label: 'Template name', control: 'text', default: 'Standard Linux server' },
      {
        id: 'sizes',
        label: 'Sizes offered',
        control: 'select',
        options: [
          { value: 'small,medium', label: 'Small and medium only' },
          { value: 'small,medium,large', label: 'Small, medium and large' },
          { value: 'small,medium,large,xlarge', label: 'Up to extra large — needs approval' },
        ],
        default: 'small,medium',
      },
      { id: 'image', label: 'Image', control: 'text', default: 'rhel9-hardened' },
      { id: 'lease_days', label: 'Lease (days)', control: 'number', default: 90, min: 0, max: 3650, hint: '0 means it never expires — see the finding' },
      { id: 'environments', label: 'Environments', control: 'text', default: 'dev, test, prod' },
      { id: 'owner_input', label: 'Ask for an owner and a cost code', control: 'toggle', default: true },
      { id: 'constraint_tag', label: 'Place on resources tagged', control: 'text', default: 'env:${input.environment}' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const templateName = str(values, 'template_name', 'Cloud template');
      const sizes = listOf(str(values, 'sizes', 'small,medium'));
      const image = str(values, 'image', 'rhel9');
      const lease = num(values, 'lease_days', 90);
      const environments = listOf(str(values, 'environments', 'dev, test, prod'));
      const askOwner = bool(values, 'owner_input', true);
      const constraint = str(values, 'constraint_tag', '');
      const base = slugOf(name || templateName, 'cloud-template');

      const findings: Finding[] = [];
      if (lease === 0) {
        findings.push(
          warning('vcfa.template.no-lease', 'This template has no lease, so anything deployed from it lives until somebody notices.', {
            remediation: 'A lease is the only mechanism that makes self-service reversible. Ninety days with a renewal is usually accepted without complaint; forever is how an estate doubles.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!askOwner) {
        findings.push(
          warning('vcfa.template.no-owner', 'Nothing asks who owns the deployment or what it is for.', {
            remediation: 'In two years this is the difference between reclaiming it and being afraid to. Ask for an owner and a cost code at request time; nobody will ever fill it in afterwards.',
            source: 'ArchToolKit',
          }),
        );
      }

      const yaml = [
        `# ${templateName}`,
        '#',
        '#',
        '# The inputs are constrained on purpose. An unconstrained flavor input is',
        '# how a self-service catalogue ends up with 64-vCPU development boxes.',
        'formatVersion: 1',
        'inputs:',
        '  environment:',
        '    type: string',
        `    enum: [${environments.join(', ')}]`,
        `    default: ${environments[0] ?? 'dev'}`,
        '    title: Environment',
        '  size:',
        '    type: string',
        `    enum: [${sizes.join(', ')}]`,
        `    default: ${sizes[0] ?? 'small'}`,
        '    title: Size',
        ...(askOwner
          ? [
              '  owner:',
              '    type: string',
              '    title: Owner (who to ask before this is removed)',
              '    pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+$"',
              '  costCode:',
              '    type: string',
              '    title: Cost code',
              '    pattern: "^[A-Z]{2,4}-[0-9]{3,6}$"',
            ]
          : []),
        'resources:',
        '  server:',
        '    type: Cloud.vSphere.Machine',
        '    properties:',
        `      image: ${image}`,
        '      flavor: "${input.size}"',
        '      constraints:',
        ...(constraint ? [`        - tag: "${constraint}"`] : ['        - tag: "env:${input.environment}"']),
        '      tags:',
        '        - key: environment',
        '          value: "${input.environment}"',
        ...(askOwner
          ? ['        - key: owner', '          value: "${input.owner}"', '        - key: costCode', '          value: "${input.costCode}"']
          : []),
        '        - key: managedBy',
        '          value: vcf-automation',
        '  network:',
        '    type: Cloud.vSphere.Network',
        '    properties:',
        '      networkType: existing',
        '      constraints:',
        '        - tag: "net:${input.environment}"',
        '',
      ].join('\n');

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

      const template = { name: templateName, description: `${sizes.join(', ')} sizes; ${lease > 0 ? `${lease}-day lease` : 'no lease'}.`, yaml };
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
        extraResources: [{ name: 'template-blueprint.yaml', content: imported.files[templatePath(template)]! }],
        templates: true,
        settings: [
          { name: 'projectId', type: 'string', value: '', description: 'The project the template is created in (GET /iaas/api/projects)' },
          { name: 'releaseTemplate', type: 'boolean', value: false, description: 'Release the new version to the catalog' },
        ],
        cap: policy ? 3 : 2,
        script: [
          stepsJs(policy ? [{ key: 'LEASE_POLICY_ID', label: `lease policy "${policy.name}"`, resource: 'lease-policy.json', list: '/policy/api/policies?typeId=com.vmware.policy.deployment.lease', style: 'page', create: '/policy/api/policies', sameProject: true }] : []),
          `var TEMPLATE = ${JSON.stringify({ name: templateName, description: template.description, version: '1.0.0' })};\n`,
          NEEDS_PROJECT,
          String.raw`if (bodies["lease-policy.json"]) bodies["lease-policy.json"].projectId = PROJECT;
TEMPLATE.content = core.resource(RESOURCE_PATH, "template-blueprint.yaml");
values.TEMPLATE_ID = mod.importTemplate(ctx, conn, TEMPLATE, PROJECT, settings.releaseTemplate === true || String(settings.releaseTemplate) === "true");
mod.ensureAll(ctx, conn, STEPS, bodies, values, settings);
`,
        ].join(''),
      });

      return {
        platform: PLATFORM,
        title: `${templateName} — a catalogue item with a lease and constrained inputs`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'Somebody requests it from the catalogue', worstCase: 'as often as people ask, which is the point — the guardrails are the limit, not the trigger' },
        scope: {
          what: `New deployments in whichever project this template is released to, placed on resources tagged ${constraint || 'env:<environment>'}.`,
          decidedBy: [
            'The project the template is released to, and who is a member of it.',
            'The cloud zones on that project, and their capacity priority.',
            `The placement constraint: ${constraint || 'env:<environment>'}.`,
            'Whatever approval policy applies to that project.',
          ],
          ifWrong: 'Deployments land in the wrong cluster or the wrong network, at request time, for whoever asked. It is reversible, but it is reversible one deployment at a time.',
        },
        guardrails: [
          { rule: `Size is one of ${sizes.join(', ')}`, because: 'An unconstrained flavor input is how a catalogue produces development boxes larger than production.' },
          ...(lease > 0 ? [{ rule: `${lease}-day lease with 7 days’ grace`, because: 'The lease is the only thing that makes self-service reversible without a reclamation project.' }] : []),
          ...(askOwner ? [{ rule: 'Owner and cost code are required, and validated', because: 'Asked at request time they get answered. Asked two years later, nobody knows.' }] : []),
          { rule: 'Placement by tag rather than by named cluster', because: 'A named cluster in a template is a migration you have to do by hand.' },
        ],
        dryRun: [
          `Run the workflow Import cloud template ${base} with dryRun = true: it validates the template on the server, reads what exists, and logs what it would create, update and version.`,
          'Deploy it to a project whose cloud zone points at a test cluster.',
          'Then request it as an ordinary user rather than as an administrator — what the requester sees is different, and usually worse.',
        ],
        undo: [
          'Unrelease the template from the catalogue: existing deployments continue, and nobody can request more.',
          'Deleting the template does not delete what was deployed from it.',
        ],
        told: ['Whatever notification the project has. Consider a subscription that posts new deployments to a channel — it is the cheapest form of capacity awareness there is.'],
        requires: ['A project with a cloud zone and a network profile.', `An image mapping named ${image}, and flavor mappings for ${sizes.join(', ')}.`],
        files: {
          ...pkg.files,
          [`${base}.yaml`]: yaml,
          ...(policy ? { [`scripts/${base}-lease-policy.json`]: `${JSON.stringify(policy, null, 2)}\n` } : {}),
          ...(policy
            ? { 'scripts/apply.sh': fromScriptsDir(applyScript('vcf-automation', [{ method: 'POST', path: '/policy/api/policies', payload: `${base}-lease-policy.json` }], 'DELETE /policy/api/policies/{id}. Deployments keep the lease they were given until it is changed.')) }
            : {}),
          ...imported.files,
          'IMPORT.md': importMd({
            subject: `The cloud template "${templateName}"${policy ? ' and its lease policy' : ''}.`,
            steps: withPackageSteps(pkg, [
              setupOrderStep('vcfa_cloud_template'),
              manualStep('The project', ['Set projectId in the configuration element (GET /iaas/api/projects, or the project workflow output). The workflow validates the template, creates it in that project or updates the draft of the one with the same name there, and creates version 1.0.0 — released only when releaseTemplate is true. An existing version is left alone: raise version: in blueprint.yaml to publish a change.']),
              imported.steps.templates,
              policy
                ? apiStep('Or by script: lease policy', 'scripts/apply.sh', [`\`scripts/${base}-lease-policy.json\` → POST /policy/api/policies`], [
                    'Replace `<REQUIRED — project id>` with the project id first. By hand: Service Broker → Content & Policies → Policies → New policy → Lease policy (VCF Automation 9.1 VM Apps: Assembler → Content & Policies — VERIFY the menu), with the same values. The script is not idempotent; the workflow is.',
                  ])
                : undefined,
            ]),
            auth: ['import', ...(policy ? (['apply'] as const) : [])],
            verify: packageVerify([...verifyFor(imported), ...(policy ? ['Lease policy: typeId com.vmware.policy.deployment.lease and the definition keys follow the 8.x policy API; the 9.1 Policy body (VM Apps Org - Policies) has projectId, which replaces the scopeCriteria key "project" older versions of this kit wrote. GET one made in the interface and compare.'] : [])]),
          }),
        },
        notes: [
          'Image and flavor mappings are per cloud account. A template that works in one project and not another is almost always a missing mapping rather than a template problem.',
          'Release to the catalogue through a content source pointed at a repository, not by uploading. Then the template has a history and a review.',
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
      'An action wired to a lifecycle event — register in the CMDB, add to monitoring, name the machine properly. Generated with the thing that is always missing: a failure path that does not wedge every deployment in the estate behind it.',
    inputs: [
      { id: 'action_name', label: 'Action name', control: 'text', default: 'Register in the CMDB' },
      {
        id: 'topic',
        label: 'Runs on',
        control: 'select',
        options: [
          { value: 'compute.provision.post', label: 'After a machine is provisioned (non-blocking)' },
          { value: 'compute.allocation.pre', label: 'Before allocation — blocking, can change placement' },
          { value: 'compute.removal.pre', label: 'Before a machine is removed — blocking' },
          { value: 'deployment.request.post', label: 'After a deployment request completes (non-blocking)' },
        ],
        default: 'compute.provision.post',
      },
      {
        id: 'runtime',
        label: 'Written in',
        control: 'select',
        options: [
          { value: 'python', label: 'Python' },
          { value: 'nodejs', label: 'Node.js' },
        ],
        default: 'python',
      },
      { id: 'endpoint', label: 'Calls', control: 'text', default: 'https://cmdb.example.com/api/ci' },
      { id: 'fail_open', label: 'Carry on if it fails', control: 'toggle', default: true, hint: 'On a blocking topic this is the difference between one failure and an estate-wide stall' },
      { id: 'timeout_seconds', label: 'Give up after (seconds)', control: 'number', default: 30, min: 5, max: 300 },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const actionName = str(values, 'action_name', 'Extensibility action');
      const topic = str(values, 'topic', 'compute.provision.post');
      const runtime = str(values, 'runtime', 'python');
      const endpoint = str(values, 'endpoint', '');
      const failOpen = bool(values, 'fail_open', true);
      const timeout = num(values, 'timeout_seconds', 30);
      const base = slugOf(name || actionName, 'abx-action');
      const blocking = topic.endsWith('.pre');

      const findings: Finding[] = [];
      if (blocking && !failOpen) {
        findings.push(
          error('vcfa.abx.blocking-fail-closed', `${topic} is a blocking topic and this action fails closed.`, {
            remediation:
              'Every deployment in the estate waits on this action, and a bad response from the endpoint stops all of them. Either fail open, or move the work to a post topic where a failure is one deployment rather than the platform.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (blocking && timeout > 60) {
        findings.push(
          warning('vcfa.abx.blocking-slow', `A ${timeout}-second timeout on a blocking topic adds ${timeout} seconds to every deployment in the worst case.`, {
            remediation: 'Blocking work should be fast or should not be blocking.',
            source: 'ArchToolKit',
          }),
        );
      }

      const python = [
        '"""',
        `${actionName}`,
        '',
        '',
        '',
        `Topic: ${topic}${blocking ? ' — BLOCKING. Every deployment waits on this.' : ' — non-blocking.'}`,
        failOpen
          ? 'Fails open: a failure here is logged and the deployment continues.'
          : 'Fails closed: a failure here stops the deployment. On a blocking topic that means all of them.',
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
        '    """Called by VCF Automation. `inputs` is the event payload."""',
        '    # The secret comes from the action\'s own secret inputs, never from here.',
        '    token = context.getSecret(inputs.get("cmdbTokenSecret", "")) if hasattr(context, "getSecret") else None',
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
        '        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},',
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
        ` * ${actionName}`,
        ' *',
        ' *',
        ` * Topic: ${topic}${blocking ? ' — BLOCKING. Every deployment waits on this.' : ' — non-blocking.'}`,
        ` * ${failOpen ? 'Fails open: a failure is logged and the deployment continues.' : 'Fails closed: a failure stops the deployment.'}`,
        ' */',
        '',
        `const TIMEOUT = ${timeout} * 1000;`,
        `const ENDPOINT = process.env.ENDPOINT || ${JSON.stringify(endpoint)};`,
        '',
        'exports.handler = async (context, inputs) => {',
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
        '      headers: { "Content-Type": "application/json" },',
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

      const subscription = {
        name: actionName,
        type: 'RUNNABLE',
        eventTopicId: topic,
        blocking,
        disabled: true,
        timeout,
        criteria: '<OPTIONAL — e.g. event.data.projectId == "..." to narrow it>',
        runnableType: 'extensibility.abx',
        runnableId: '<REQUIRED — the action id, after the action is created>',
      };

      const imported = importBundle({
        abx: [
          {
            name: actionName,
            runtime: runtime === 'python' ? 'python' : 'nodejs',
            script: runtime === 'python' ? python : nodejs,
            description: `Runs on ${topic}; ${failOpen ? 'fails open' : 'fails closed'}.`,
            timeoutSeconds: timeout,
            subscription,
          },
        ],
      });

      // The workflow creates (or updates) the action through the ABX API, then
      // the subscription, disabled, pointing at it. The subscription id is
      // chosen here, from the name, so a re-run finds the same one.
      const actionPath = Object.keys(imported.files).find((path) => path.endsWith('/action.json'))!;
      const sourceName = runtime === 'python' ? 'action.py' : 'action.js';
      const { criteria: _criteria, ...subscriptionRest } = subscription;
      void _criteria;
      const pkg = vcfaPackage({
        thing: 'abx',
        base,
        folder: 'Extensibility',
        workflowName: `Create ABX action ${base}`,
        description: `Creates the ABX action "${actionName}" in a VCF Automation VM Apps organization project (or updates it when its script differs), then its subscription on ${topic}, disabled.`,
        outputs: { actionId: 'ACTION_ID', subscriptionId: 'SUBSCRIPTION_ID' },
        payloads: {
          'action.json': JSON.parse(imported.files[actionPath]!),
          'subscription.json': { ...subscriptionRest, id: stableId(`subscription:${actionName}`), runnableId: '__ACTION_ID__' },
        },
        extraResources: [{ name: sourceName, content: runtime === 'python' ? python : nodejs }],
        settings: [{ name: 'projectId', type: 'string', value: '', description: 'The project the action belongs to (GET /iaas/api/projects); its organization id is read from it' }],
        cap: 2,
        script: [
          stepsJs([{ key: 'SUBSCRIPTION_ID', label: `subscription "${actionName}" on ${topic}, disabled`, resource: 'subscription.json', list: '/event-broker/api/subscriptions', style: 'page', create: '/event-broker/api/subscriptions', clientId: true }]),
          `var SOURCE_NAME = ${JSON.stringify(sourceName)};\n`,
          NEEDS_PROJECT,
          String.raw`var ACTION = bodies["action.json"];
ACTION.source = core.resource(RESOURCE_PATH, SOURCE_NAME);
ACTION.projectId = PROJECT;
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
for (var i = 0; i < actions.length; i++) if (String(actions[i].name) === String(ACTION.name) && String(actions[i].projectId) === PROJECT) hits.push(actions[i]);
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

      return {
        platform: PLATFORM,
        title: `${actionName} — runs on ${topic}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: `The ${topic} event, for every deployment the criteria matches`, worstCase: 'once per machine per deployment — in a bulk request that is once per machine' },
        scope: {
          what: 'Every deployment event matching the subscription criteria. With no criteria, that is every deployment in every project.',
          decidedBy: ['The event topic.', 'The subscription criteria, which is empty unless you set it.', 'Nothing else — subscriptions are not scoped by project unless the criteria says so.'],
          ifWrong: blocking
            ? 'On a blocking topic, every deployment in the estate waits on this action. A slow or failing endpoint stalls the platform, and it looks like VCF Automation is broken.'
            : 'The action runs for deployments you did not intend, and posts to the endpoint for all of them.',
        },
        guardrails: [
          { rule: 'Created disabled', because: 'A subscription applies estate-wide the moment it is enabled. Turn it on when you have set the criteria.' },
          { rule: `Times out after ${timeout} seconds`, because: blocking ? 'On a blocking topic, no timeout means a hung endpoint hangs every deployment indefinitely.' : 'An action with no timeout eventually runs out of the platform’s patience, less clearly.' },
          ...(failOpen ? [{ rule: 'Fails open', because: 'The deployment is what the requester asked for. Registration failing is a gap to fix, not a reason to refuse them a machine.' }] : []),
          { rule: 'Secrets come from the action’s secret inputs', because: 'An action is exported, versioned and read by more people than you think.' },
        ],
        dryRun: [
          `Run the workflow Create ABX action ${base} with dryRun = true: it reads the project, the actions and the subscriptions, and logs what it would create or update.`,
          'Run the action from the interface with a sample payload and `__dryRun` set. It logs what it would post and returns.',
          'Then enable the subscription with criteria narrowed to one project.',
        ],
        undo: ['Disable the subscription. The action stays, deployments stop calling it.', 'Anything already registered downstream is not removed — that is the endpoint’s business.'],
        told: ['The action log in VCF Automation, per run. Ship it to VCF Operations for Logs if you want to know it stopped working.'],
        requires: ['An ABX action created from this file, and its id for the subscription.', endpoint ? `Network path from the extensibility runtime to ${endpoint}.` : 'An endpoint to call.'],
        files: {
          ...pkg.files,
          [runtime === 'python' ? `${base}.py` : `${base}.js`]: runtime === 'python' ? python : nodejs,
          [`${base}-subscription.json`]: `${JSON.stringify(subscription, null, 2)}\n`,
          ...imported.files,
          'IMPORT.md': importMd({
            subject: `The ABX action "${actionName}" and its subscription on ${topic}.`,
            steps: withPackageSteps(pkg, [
              manualStep('The project', ['Set projectId in the configuration element. The workflow reads the organization id from the project (the ABX API requires orgId), creates the action with the script inline — or updates the one with the same name in the project when its script differs — and then creates the subscription, disabled, with the action id in runnableId. An existing subscription of the same name is left as it is.']),
              imported.steps.abx,
              manualStep('Turn it on', [
                'The subscription is created disabled. Run the action once from the interface with a sample payload and `__dryRun` set, add criteria that narrow it to one project, then enable it (Extensibility → Subscriptions).',
              ]),
            ]),
            auth: ['import'],
            verify: packageVerify([
              ...verifyFor(imported),
              'ABX: the 9.1 VM Apps Org - ABX reference lists name, runtime, entrypoint, actionType and orgId as required on POST /abx/api/resources/actions, which is why the workflow reads orgId from the project.',
              'Subscription: POST /event-broker/api/subscriptions with the fields in subscription.json; on 8.x the client supplies the id, which the workflow and the script do. The 9.1 event broker reference was not reachable to confirm the body — VERIFY by GET of one made in the interface.',
            ]),
          }),
        },
        notes: [
          blocking
            ? 'This is a blocking topic. Read that sentence again before enabling it: every deployment in the estate waits for this action to return.'
            : 'This is a non-blocking topic, so a failure affects the registration and not the deployment.',
          'Subscriptions have no project scope of their own. If you want this to apply to one project, the criteria expression is the only place that happens.',
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
      'Approval on the requests that warrant it and not on the ones that do not. The failure here is not too little approval — it is approval on everything, which becomes a rubber stamp within a month and is then worse than none.',
    inputs: [
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'Large deployments need approval' },
      {
        id: 'when',
        label: 'Ask for approval when',
        control: 'select',
        options: [
          { value: 'size', label: 'The request is large' },
          { value: 'prod', label: 'It is going to production' },
          { value: 'cost', label: 'It costs more than a threshold' },
          { value: 'always', label: 'Always — see the finding' },
        ],
        default: 'size',
      },
      { id: 'threshold', label: 'Threshold', control: 'text', default: '8 vCPU or 32 GB', hint: 'What counts as large, or the cost figure' },
      { id: 'approvers', label: 'Approvers', control: 'text', default: 'platform-leads@example.com', hint: 'Comma separated. Prefix an entry with user: or group: to override the setting below' },
      {
        id: 'approvers_are',
        label: 'Unprefixed approvers are',
        control: 'select',
        options: [
          { value: 'GROUP', label: 'Groups — approve to a team' },
          { value: 'USER', label: 'Users — named people' },
        ],
        default: 'GROUP',
      },
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
    automation: (values: BlueprintValues, name: string): Automation => {
      const policyName = str(values, 'policy_name', 'Approval policy');
      const when = str(values, 'when', 'size');
      const threshold = str(values, 'threshold', '8 vCPU or 32 GB');
      const approversAre = str(values, 'approvers_are', 'GROUP') === 'USER' ? 'USER' : 'GROUP';
      // Each entry becomes USER:<id> or GROUP:<id>. An explicit user:/group: prefix wins.
      const approvers = listOf(str(values, 'approvers', '')).map((entry) => {
        const match = /^(user|group)\s*:\s*(.+)$/i.exec(entry);
        return match ? { kind: match[1]!.toUpperCase() as 'USER' | 'GROUP', id: match[2]!.trim() } : { kind: approversAre, id: entry };
      });
      const approverNames = approvers.map((approver) => approver.id);
      const expiry = Math.max(1, Math.round(num(values, 'auto_expire_days', 2)));
      const onExpiry = str(values, 'on_expiry', 'REJECT');
      const base = slugOf(name || policyName, 'approval-policy');

      const findings: Finding[] = [];
      if (when === 'always') {
        findings.push(
          warning('vcfa.approval.everything', 'Approval on every request becomes a rubber stamp, and a rubber stamp is worse than no approval because it looks like control.', {
            remediation: 'Approve what is large, expensive or production-bound. Let the rest through — that is what the catalogue was for.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (onExpiry === 'APPROVE') {
        findings.push(
          error('vcfa.approval.auto-approve', 'An unanswered request is approved automatically after the timeout.', {
            remediation: 'That is not approval, it is a delay. If waiting is acceptable, the request did not need approving; if it is not, expire to rejected and let people re-request.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (approvers.length === 1 && approvers[0]!.kind === 'USER') {
        findings.push(
          warning('vcfa.approval.single-approver', 'One approver is one holiday away from a stalled catalogue.', {
            remediation: 'Approve to a group rather than a person.',
            source: 'ArchToolKit',
          }),
        );
      }

      const criteria =
        when === 'size'
          ? `Requests over ${threshold}`
          : when === 'prod'
            ? 'Requests where environment == prod'
            : when === 'cost'
              ? `Requests with an estimated cost over ${threshold}`
              : 'Every request';

      const policy = {
        name: policyName,
        typeId: 'com.vmware.policy.approval',
        enforcementType: 'HARD',
        definition: {
          level: 1,
          // USER covers named users and groups; ROLE is the role-based form (project administrators and the like).
          approverType: 'USER',
          approvalMode: 'ANY_OF',
          approvers: approvers.map((approver) => `${approver.kind}:${approver.id}`),
          // What happens when nobody answers, and after how many days.
          autoApprovalDecision: onExpiry === 'APPROVE' ? 'APPROVE' : 'REJECT',
          autoApprovalExpiry: expiry,
          actions: ['Deployment.Create'],
        },
        // Every request: no criteria at all. Otherwise the expression has to
        // be written for this organization's properties, so it stays a
        // placeholder a live run refuses to send.
        ...(when === 'always' ? {} : { criteria: { matchExpression: [{ key: '<REQUIRED — the expression for: ' + criteria + '>', operator: 'eq', value: '<REQUIRED>' }] } }),
        // A project-scoped policy names its project in projectId (the Policy
        // body in the 9.1 VM Apps Org - Policies reference).
        projectId: '<REQUIRED — project id>',
      };

      const pkg = vcfaPackage({
        thing: 'approval',
        base,
        folder: 'Policies',
        workflowName: `Create approval policy ${base}`,
        description: `Creates the approval policy "${policyName}" in a VCF Automation VM Apps organization project.`,
        outputs: { policyId: 'POLICY_ID' },
        payloads: { 'approval-policy.json': policy },
        settings: [{ name: 'projectId', type: 'string', value: '', description: 'The project the policy applies to (GET /iaas/api/projects)' }],
        cap: 1,
        script: [
          stepsJs([{ key: 'POLICY_ID', label: `approval policy "${policyName}"`, resource: 'approval-policy.json', list: '/policy/api/policies?typeId=com.vmware.policy.approval', style: 'page', create: '/policy/api/policies', sameProject: true }]),
          String.raw`if (settings.projectId) bodies["approval-policy.json"].projectId = String(settings.projectId);
mod.ensureAll(ctx, conn, STEPS, bodies, values, settings);
`,
        ].join(''),
      });

      return {
        platform: PLATFORM,
        title: `${policyName} — ${criteria.toLowerCase()} wait for ${approverNames.join(', ') || 'nobody'}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: criteria, worstCase: 'as often as people request something matching the criteria' },
        scope: {
          what: 'Requests in the project this policy is scoped to, matching the criteria above.',
          decidedBy: ['The scope criteria — which project.', 'The match criteria — which requests within it.', 'Policy priority: a policy with a higher priority on the same request wins.'],
          ifWrong: 'Either everything waits for approval and the catalogue stops being used, or nothing does and the policy is decoration.',
        },
        guardrails: [
          { rule: `Decides automatically after ${expiry} day${expiry === 1 ? '' : 's'}, by ${onExpiry === 'APPROVE' ? 'approving' : 'rejecting'}`, because: 'A request that waits forever is a request that gets raised as a ticket instead, and then the catalogue is not used.' },
          { rule: 'Scoped to a project', because: 'An unscoped approval policy applies to every request in the organisation, which is discovered on the first busy morning.' },
          ...(approvers.length > 1 || approvers.some((approver) => approver.kind === 'GROUP')
            ? [{ rule: approvers.length > 1 ? 'Any one of several approvers' : 'Any member of the approving group', because: 'One named approver is a single point of failure with a holiday calendar.' }]
            : []),
        ],
        dryRun: [
          `Run the workflow Create approval policy ${base} with dryRun = true: it reads the approval policies and warns about every value still a placeholder — the criteria expression and the project — which a live run refuses to send.`,
          'Apply it to a test project and request something that should need approval, then something that should not. Both halves are worth checking.',
        ],
        undo: ['DELETE the policy, or set enforcementType to SOFT. Requests already waiting keep waiting — decide them before removing it.'],
        told: [`${approverNames.join(', ') || 'Nobody'}, at request time, through whatever notification the deployment is configured for.`],
        requires: ['The project it is scoped to.', 'The approvers to exist as users or groups in VCF Automation.'],
        files: {
          ...pkg.files,
          [`scripts/${base}.json`]: `${JSON.stringify(policy, null, 2)}\n`,
          'scripts/apply.sh': fromScriptsDir(applyScript('vcf-automation', [{ method: 'POST', path: '/policy/api/policies', payload: `${base}.json` }], 'DELETE /policy/api/policies/{id}, after deciding the requests already waiting on it.')),
          'IMPORT.md': importMd({
            subject: `The approval policy "${policyName}".`,
            steps: withPackageSteps(pkg, [
              manualStep('What only you can fill', [
                `Set projectId in the configuration element.${when === 'always' ? '' : ' Write the criteria expression into payloadOverrides, e.g. `{"approval-policy.json": {"criteria": {"matchExpression": [{"key": "…", "operator": "…", "value": "…"}]}}}` — a live run refuses to send the placeholder, because a policy with a criteria that matches nothing looks exactly like a policy that is working.'}`,
              ]),
              apiStep('Or by script: approval policy', 'scripts/apply.sh', [`\`scripts/${base}.json\` → POST /policy/api/policies`], [
                `Fill the \`<REQUIRED>\` values first: ${when === 'always' ? '' : 'the match expression for the criteria, and '}the project id. The script does not check them for you — sent as placeholders, the policy is created and matches nothing, which looks exactly like a policy that is working.`,
                'By hand: Service Broker → Content & Policies → Policies → New policy → Approval policy (VCF Automation 9.1 VM Apps: Assembler → Content & Policies — VERIFY the menu), with the same approvers, expiry and decision.',
              ]),
            ]),
            auth: ['apply'],
            verify: packageVerify([
              'The approval definition follows the 8.16 API programming guide example; the GROUP:<id> approver form is VERIFY — create one policy with a group approver in the interface and GET it.',
              'The 9.1 Policy body (VM Apps Org - Policies) has projectId, which replaces the scopeCriteria key "project" older versions of this kit wrote.',
            ]),
          }),
        },
        notes: [
          'Approval policies are evaluated by priority, and the highest priority wins outright rather than combining. Two policies on the same project is usually one policy too many.',
          'The definition follows the approval-policy example in the Aria Automation 8.16 API programming guide: approverType USER, approvers as USER:<id>, autoApprovalDecision APPROVE or REJECT, autoApprovalExpiry in days. The GROUP:<id> form for groups and the 30-day ceiling on the input are not in that example; make one policy with a group approver in the UI, GET it on your own release and match its shape before relying on either.',
          'The criteria expression is the part to test. It is easy to write one that matches nothing, and a policy that matches nothing looks exactly like a policy that is working.',
        ],
        findings,
      };
    },
  }),
];
