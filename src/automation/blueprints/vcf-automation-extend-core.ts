/**
 * VCF Automation extensibility: what every blueprint in vcf-automation-extend*.ts
 * shares — the Orchestrator package helpers, the VCF Automation lookups the
 * packages carry, the settings every package reads, and the IMPORT.md steps.
 */

import { error, type Finding } from '../../core/findings.ts';
import type { AutomationPackage } from '../vro/to-package.ts';
import { prologue } from '../vro/to-package.ts';
import type { VroActionDef } from '../vro/core.ts';
import type { VroConfigAttribute } from '../../kit/vro-package.ts';
import { stableId, workflowId, workflowXml, type ImportStep, type VroParam, type VroWorkflowArtifact, type AbxArtifact } from '../vcfa-import.ts';

export const PLATFORM = 'vcf-automation' as const;
export const SRC = 'ArchToolKit';

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export const q = JSON.stringify;

// ---------------------------------------------------------------------------
// The Orchestrator packages
//
// Every automation here is one Orchestrator package on the shared core library
// (src/automation/vro): the package's workflow is the central component that
// does the job through the API, and the native files each blueprint already
// wrote (.workflow, ABX zip, blueprint.yaml, JSON payloads, Kubernetes YAML)
// stay beside it for anybody who imports by hand.

/** A workflow or element name from free text: Orchestrator keeps the folder in categoryPath, so no "/". */
export const elementName = (text: string): string => text.replace(/\//g, '-').trim() || 'Workflow';

/**
 * A second workflow in a package that toPackage already built — the backing
 * workflow of a day-2 action, the lifecycle workflows of a custom resource.
 * Same folder, same settings and the same prologue as the package's main one,
 * so its id is the one a native .workflow of the same name and folder has.
 */
export function extraWorkflow(pkg: AutomationPackage, hasActions: boolean, spec: { name: string; description: string; inputs: readonly VroParam[]; outputs: readonly VroParam[]; script: string }): { files: Record<string, string>; id: string } {
  const artifact: VroWorkflowArtifact = {
    name: spec.name,
    category: pkg.categoryPath,
    description: spec.description,
    inputs: spec.inputs,
    outputs: spec.outputs,
    taskName: spec.name,
    script: `${prologue({ packageName: pkg.packageName, categoryPath: pkg.categoryPath, config: { name: pkg.configName, description: '', attributes: [] }, actions: hasActions ? [{ name: 'x', description: '', resultType: 'Any', params: [], script: '' }] : [] })}${spec.script}`,
  };
  return { files: { [`${pkg.packageDir}/workflows/${pkg.categoryPath}/${spec.name}.xml`]: workflowXml(artifact) }, id: workflowId(artifact) };
}

/** The settings every package that talks to VCF Automation reads. */
export function vcfaSettings(org: 'vm-apps' | 'all-apps'): VroConfigAttribute[] {
  return [
    { name: 'vcfaHost', type: 'string', value: '', description: 'VCF Automation host (FQDN)' },
    {
      name: 'vcfaOrg',
      type: 'string',
      value: '',
      description: org === 'all-apps' ? 'The All Apps organization name, as in its login URL' : 'The VM Apps organization name, as in its login URL',
    },
    { name: 'vcfaApiToken', type: 'SecureString', description: 'An API token of that organization, exchanged at /oauth/tenant/<org>/token' },
  ];
}

/** The dryRun switch (off: it acts), the cap and the webhook, as every changing package has them. */
export function guardSettings(cap: number, what: string): VroConfigAttribute[] {
  return [
    { name: 'dryRun', type: 'boolean', value: false, description: `Set to true to preview: nothing is ${what} while it is true` },
    { name: 'cap', type: 'number', value: cap, description: 'The most changes one run may make' },
    { name: 'webhook', type: 'SecureString', description: 'Optional: where the audit record is posted' },
  ];
}

export const pa = (name: string, type: string, description: string) => ({ name, type, description });

/**
 * The actions the VCF Automation packages share, added to each package's own
 * module (an action lives in exactly one module, and a package carries its
 * module). Lists are read whole and matched here rather than with $filter,
 * whose dialect differs between the services.
 */
export function vcfaActions(packageName: string): VroActionDef[] {
  const head = `var core = System.getModule("vcf.automation.core");\nvar mod = System.getModule(${q(packageName)});\n`;
  return [
    {
      name: 'listAll',
      description:
        'Every item of a VCF Automation list: /iaas/api paged with $top/$skip, the other services (blueprint, policy, form-service, abx) with page/size; content[] and totalElements, or a bare array. Throws rather than return a partial or unrecognised list.',
      resultType: 'Any',
      params: [pa('host', 'string', 'VCF Automation host'), pa('auth', 'Any', 'What core.loginVcfAutomation returned'), pa('path', 'string', 'e.g. /iaas/api/projects'), pa('safe', 'Any', 'http options, { redact: settings._secrets }')],
      script: `${head}${String.raw`var p = String(path);
var iaas = p.indexOf("/iaas/api/") === 0;
var sep = p.indexOf("?") < 0 ? "?" : "&";
var SIZE = 200;
return core.pageAll(function (page) {
  var query = iaas ? "%24top=" + SIZE + "&%24skip=" + (page * SIZE) : "page=" + page + "&size=" + SIZE;
  var b = core.http("GET", "https://" + host + p + sep + query, auth, null, safe).body;
  if (Object.prototype.toString.call(b) === "[object Array]") return { items: page === 0 ? b : [], total: null, more: false };
  if (!b || typeof b !== "object" || Object.prototype.toString.call(b.content) !== "[object Array]") {
    throw new Error("GET " + p + " did not answer with a list (content[]); VERIFY the response shape on your release. Nothing was changed after it.");
  }
  var total = b.totalElements !== undefined && b.totalElements !== null ? Number(b.totalElements) : null;
  return { items: b.content, total: total, more: b.last === true ? false : (b.last === false ? true : null) };
}, 0);`}`,
    },
    {
      name: 'findOne',
      description: 'The one item whose fields equal criteria, or null. Throws when more than one matches: a run never guesses which of two objects was meant.',
      resultType: 'Any',
      params: [pa('items', 'Any', 'What listAll returned'), pa('criteria', 'Any', 'Object of field to value'), pa('what', 'string', 'What is looked for, for the error')],
      script: String.raw`var found = [];
for (var i = 0; i < items.length; i++) {
  var match = true;
  for (var key in criteria) {
    if (criteria.hasOwnProperty(key) && String(items[i][key]) !== String(criteria[key])) match = false;
  }
  if (match) found.push(items[i]);
}
if (found.length > 1) throw new Error("More than one " + what + " matches; refusing to guess which. Tidy them first.");
return found.length === 1 ? found[0] : null;`,
    },
    {
      name: 'projectIdOf',
      description: 'The id of the VCF Automation project with this name (GET /iaas/api/projects). Throws when there is none, or more than one.',
      resultType: 'string',
      params: [pa('host', 'string', 'VCF Automation host'), pa('auth', 'Any', 'Bearer header'), pa('safe', 'Any', 'http options'), pa('projectName', 'string', 'Project name')],
      script: `${head}${String.raw`if (!projectName) throw new Error("Set projectName in the configuration element: the project the objects belong to.");
var project = mod.findOne(mod.listAll(host, auth, "/iaas/api/projects", safe), { name: String(projectName) }, "project named " + projectName);
if (!project) throw new Error("No project named '" + projectName + "' in this organization.");
return String(project.id);`}`,
    },
    {
      name: 'vroEndpointLink',
      description:
        'The endpointLink a custom resource or resource action names its Orchestrator by: /resources/endpoints/<id> of the Orchestrator integration (GET /iaas/api/integrations, integrationType vro; KB 314899). With several, integrationName picks one. VERIFY the link form on your release against a resource action made in the interface.',
      resultType: 'string',
      params: [pa('host', 'string', 'VCF Automation host'), pa('auth', 'Any', 'Bearer header'), pa('safe', 'Any', 'http options'), pa('integrationName', 'string', 'Integration name, or empty when there is one')],
      script: `${head}${String.raw`var all = mod.listAll(host, auth, "/iaas/api/integrations", safe);
var vro = [];
for (var i = 0; i < all.length; i++) {
  if (String(all[i].integrationType).toLowerCase() === "vro" && (!integrationName || String(all[i].name) === String(integrationName))) vro.push(all[i]);
}
if (vro.length === 0) throw new Error("No Orchestrator integration" + (integrationName ? " named '" + integrationName + "'" : "") + " in this organization (Infrastructure > Integrations).");
if (vro.length > 1) throw new Error(vro.length + " Orchestrator integrations: set vroIntegrationName in the configuration element to the one to use.");
return "/resources/endpoints/" + vro[0].id;`}`,
    },
    {
      name: 'ensureAbxAction',
      description: 'The ABX action with this name in this project: left as it is when it exists, created through POST /abx/api/resources/actions (guarded by act) when not. Returns its id, or "" in a dry run.',
      resultType: 'string',
      params: [pa('ctx', 'Any', 'core.begin'), pa('host', 'string', 'VCF Automation host'), pa('auth', 'Any', 'Bearer header'), pa('safe', 'Any', 'http options'), pa('body', 'Any', 'The action: name, runtime, entrypoint, source, projectId, …')],
      script: `${head}${String.raw`var found = mod.findOne(mod.listAll(host, auth, "/abx/api/resources/actions", safe), { name: body.name, projectId: body.projectId }, "ABX action named " + body.name);
if (found) {
  System.log("Exists, left as it is: ABX action \"" + body.name + "\" (" + found.id + "). Change its script in Extensibility > Library > Actions, or delete it and run again.");
  return String(found.id);
}
var id = core.act(ctx, "create ABX action \"" + body.name + "\"", function () {
  var r = core.http("POST", "https://" + host + "/abx/api/resources/actions", auth, body, safe);
  if (!r.body || !r.body.id) throw new Error("POST /abx/api/resources/actions returned no id");
  return String(r.body.id);
});
return id || "";`}`,
    },
    {
      name: 'ensureTemplate',
      description:
        'A cloud template, as import-templates.sh does it: POST /blueprint/api/blueprint-validation (saves nothing), then create it or update the draft of the one with the same name in the project (left alone when its content is the same), then create the version unless it exists, released when template.release. Every write goes through act. Returns the template id, or "" when a dry run would create it.',
      resultType: 'string',
      params: [pa('ctx', 'Any', 'core.begin'), pa('host', 'string', 'VCF Automation host'), pa('auth', 'Any', 'Bearer header'), pa('safe', 'Any', 'http options'), pa('template', 'Any', '{ projectId, name, description, content, version, release, validate }')],
      script: `${head}${String.raw`var api = "https://" + host + "/blueprint/api/";
var t = template;
var body = { name: String(t.name), description: String(t.description || ""), projectId: String(t.projectId), requestScopeOrg: false, content: String(t.content) };
if (String(t.content).indexOf("<REQUIRED") >= 0) throw new Error("The template \"" + t.name + "\" still has a <REQUIRED …> placeholder; fill it (or the setting that fills it) first. Nothing was imported.");
if (t.validate !== false) {
  var v = core.http("POST", api + "blueprint-validation", auth, body, safe).body || {};
  var messages = v.validationMessages || [];
  for (var i = 0; i < messages.length; i++) System.log("Template \"" + t.name + "\": " + (messages[i].type || "INFO") + ": " + (messages[i].message || JSON.stringify(messages[i])));
  if (v.valid === false) throw new Error("The template \"" + t.name + "\" is not valid (the log lists why); nothing was imported.");
}
var all = mod.listAll(host, auth, "/blueprint/api/blueprints", safe);
var same = [];
for (var j = 0; j < all.length; j++) {
  if (String(all[j].name) === String(t.name) && (!all[j].projectId || String(all[j].projectId) === String(t.projectId))) same.push(all[j]);
}
if (same.length > 1) throw new Error("More than one template named \"" + t.name + "\" in the project; refusing to guess. Tidy them first.");
var id = same.length === 1 ? String(same[0].id) : "";
if (id) {
  var current = core.http("GET", api + "blueprints/" + id, auth, null, safe).body || {};
  if (String(current.content || "") === String(t.content)) {
    System.log("Exists with the same content, left as it is: template \"" + t.name + "\" (" + id + ")");
  } else {
    core.act(ctx, "update the draft of template \"" + t.name + "\" (" + id + ")", function () {
      core.http("PUT", api + "blueprints/" + id, auth, body, safe);
      return true;
    });
  }
} else {
  id = core.act(ctx, "create template \"" + t.name + "\"", function () {
    var r = core.http("POST", api + "blueprints", auth, body, safe);
    if (!r.body || !r.body.id) throw new Error("POST /blueprint/api/blueprints returned no id");
    return String(r.body.id);
  }) || "";
}
var what = "create version " + t.version + " of template \"" + t.name + "\"" + (t.release ? " and release it to the catalog" : "");
if (!id) {
  core.act(ctx, what, function () { return true; });
  return "";
}
var versions = mod.listAll(host, auth, "/blueprint/api/blueprints/" + id + "/versions", safe);
for (var k = 0; k < versions.length; k++) {
  if (String(versions[k].version) === String(t.version)) {
    System.log("Version " + t.version + " of \"" + t.name + "\" exists; versions are immutable, so raise the version to publish a change.");
    return id;
  }
}
core.act(ctx, what, function () {
  core.http("POST", api + "blueprints/" + id + "/versions", auth, { version: String(t.version), description: String(t.description || ""), changeLog: "Imported by the vcf.automation package", release: t.release === true }, safe);
  return true;
});
return id;`}`,
    },
  ];
}

/** The body POST /abx/api/resources/actions takes (as import/abx/<action>/action.json), less source and projectId. */
export function abxBody(action: AbxArtifact): Record<string, unknown> {
  return {
    name: action.name,
    description: action.description,
    actionType: 'SCRIPT',
    runtime: action.runtime,
    entrypoint: 'handler',
    inputs: action.inputs ?? {},
    timeoutSeconds: action.timeoutSeconds,
    memoryInMB: action.memoryInMB ?? 300,
    dependencies: '',
    shared: false,
  };
}

/** The opening lines of a package workflow that logs in to VCF Automation. */
export const VCFA_LOGIN = String.raw`if (!settings.vcfaHost) throw new Error("Set vcfaHost in the configuration element " + SETTINGS_NAME + ".");
if (!settings.vcfaApiToken) throw new Error("Set vcfaApiToken in the configuration element " + SETTINGS_NAME + ".");
var host = String(settings.vcfaHost);
var auth = core.loginVcfAutomation(host, settings.vcfaApiToken, settings.vcfaOrg || "");
var SAFE = { redact: settings._secrets };`;

/** What running any of the packages needs. */
export const PKG_REQUIRES = 'For the package: the Orchestrator of VCF Automation 9.1 (VM Apps organization; the Orchestrate tab of an All Apps organization) or VCF Operations orchestrator 9.1, with the vcf.automation core library imported and the endpoint certificates trusted.';

/** What every package that logs in to VCF Automation cannot confirm about the login. */
export const VERIFY_LOGIN =
  'The package logs in with core.loginVcfAutomation: an organization API token exchanged at POST /oauth/tenant/<org>/token (grant_type=refresh_token), as the community write-up "VCF Automation 9 API Access" documents for both organization types; the 9.0 TechDocs page "Get Your Access Token for the VCF Automation VM Apps API" shows /tm/oauth/tenant/<org>/token instead — VERIFY which your release answers.';

/** A fallback script moved under scripts/: it still reads the payloads beside the README. */
export function underScripts(script: string): string {
  return script
    .replace('# Apply the payloads beside this script to', '# Apply the payloads beside the README (one folder up) to')
    .replace('set -euo pipefail\n', 'set -euo pipefail\n# The payloads are one folder up, beside the README.\ncd "$(dirname "$0")/.."\n');
}

/** The ABX step of importBundle, naming the PowerShell packager by its path too, as the by-hand route. */
export function abxStep(step: ImportStep | undefined): ImportStep | undefined {
  return step ? { heading: `Or by hand: ${step.heading}`, lines: [...step.lines, '', 'On Windows, `import/package-abx.ps1` builds the same zip as `import/package-abx.sh`.'] } : undefined;
}

/** A native-import step of importBundle, as the by-hand alternative to the package. */
export function orByHand(step: ImportStep | undefined): ImportStep | undefined {
  return step ? { heading: `Or by hand: ${step.heading}`, lines: step.lines } : undefined;
}

/** The package's import steps, with the extra workflows it holds named in the first. */
export function packageSteps(pkg: AutomationPackage, extra: readonly { name: string; id: string }[] = []): ImportStep[] {
  return pkg.importSteps.map((step, index) =>
    index === 0 && extra.length > 0
      ? { heading: step.heading, lines: [...step.lines, '', `It also holds the workflow${extra.length > 1 ? 's' : ''} ${extra.map((w) => `**${w.name}** (id ${w.id})`).join(', ')} in ${pkg.categoryPath}.`] }
      : step,
  );
}

/** The payload POST /blueprint/api/blueprints takes: a cloud template is YAML inside JSON. */
export function templatePayload(name: string, description: string, yaml: string): Record<string, unknown> {
  return {
    name,
    description: `${description}`,
    projectId: '<REQUIRED — GET /iaas/api/projects and take the id>',
    requestScopeOrg: false,
    content: yaml,
  };
}

/**
 * A kubectl script that runs a server-side dry run unless told otherwise.
 *
 * Server-side, because a client-side dry run only checks that the YAML parses;
 * the server checks the class exists, the VM class is bound to the namespace and
 * the admission webhooks agree — which is where these requests actually fail.
 */
export function kubectlScript(purpose: string, files: readonly string[], undo: string): string {
  return [
    '#!/usr/bin/env bash',
    `# ${purpose}`,
    '#',
    '# Uses whatever kubectl context is current. Log in first with the VCF CLI or',
    '# kubectl vsphere login, and check the context — that is the scope.',
    '#',
    '# Applies when run. With --dry-run it runs a server-side dry run only: the',
    '# Supervisor validates the request and nothing is created.',
    'set -euo pipefail',
    '',
    'command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }',
    'echo "Context: $(kubectl config current-context)"',
    '',
    'MODE=()',
    '[[ "${1:-}" == "--dry-run" ]] && MODE=(--dry-run=server)',
    '',
    ...files.map((file) => `kubectl apply "\${MODE[@]}" -f '${file}'`),
    '',
    'if [[ ${#MODE[@]} -gt 0 ]]; then',
    '  echo "Server-side dry run only. Nothing was created. Run it without --dry-run to apply."',
    'fi',
    '',
    `# Undo: ${undo}`,
    '',
  ].join('\n');
}

/** "vm (VC:VirtualMachine)" or "dryRun (boolean, default true)" as a workflow parameter. */
export function paramOf(text: string): VroParam {
  const match = /^(\w+)\s*\(([^,)]+)/.exec(text.trim());
  return { name: match?.[1] ?? text.trim(), type: (match?.[2] ?? 'string').trim(), description: text.trim() };
}

/** A Python ABX stub: dry run by default, and honest that the work is still to be written. */
export function abxStub(title: string, what: string): string {
  const quoted = JSON.stringify(title);
  return [
    '"""',
    title,
    '',
    ' as a stub: it imports and runs, reports in a dry run,',
    `and refuses to pretend it did the work until the work is written. ${what}`,
    '"""',
    '',
    '',
    'def handler(context, inputs):',
    '    if inputs.get("dryRun", True) is not False:',
    `        print("DRY RUN:", ${quoted}, {k: v for k, v in inputs.items() if not k.startswith("__")})`,
    '        return {"dryRun": True, **inputs}',
    `    raise NotImplementedError(${quoted} + ": write the call here, then remove this line")`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Rows, and the lookups the newer packages carry

/**
 * The rows of a " | " table the page edits as a grid: each line that is not
 * empty or a # comment, split into trimmed cells and padded to `columns`. A
 * cell of "-" is empty, so a row can leave a column out and still line up.
 */
export function rowsOf(text: string, columns: number): string[][] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim()).map((cell) => (cell === '-' ? '' : cell));
      while (cells.length < columns) cells.push('');
      return cells;
    });
}

/** "yes", "y", "true", "1" and "required" are true; anything else false. */
export const yes = (cell: string): boolean => /^(y|yes|true|1|required|on)$/i.test(cell.trim());

/**
 * Lookups by name, for packages that point at something that already exists:
 * an Orchestrator workflow (the Orchestrator REST API, /vco/api/workflows with
 * a name condition, answering link[] of attributes) or an ABX action in a
 * project. Each throws on none or more than one: a run never guesses.
 * Needs vcfaActions in the same package (listAll, findOne).
 */
export function lookupActions(packageName: string): VroActionDef[] {
  const head = `var core = System.getModule("vcf.automation.core");\nvar mod = System.getModule(${q(packageName)});\n`;
  return [
    {
      name: 'workflowIdByName',
      description:
        'The id of the Orchestrator workflow with exactly this name: GET /vco/api/workflows?conditions=name=<name> on the VCF Automation host (or vroHost), whose answer is link[] with attributes [{ name, value }]. Throws on none or several. VERIFY that the organization token is accepted at /vco/api on your release.',
      resultType: 'string',
      params: [pa('host', 'string', 'Orchestrator host'), pa('auth', 'Any', 'Bearer header'), pa('safe', 'Any', 'http options'), pa('workflowName', 'string', 'Exact workflow name')],
      script: `${head}${String.raw`if (!workflowName) throw new Error("No workflow name to look up.");
var r = core.http("GET", "https://" + host + "/vco/api/workflows?conditions=" + encodeURIComponent("name=" + workflowName), auth, null, safe).body || {};
var links = r.link || [];
var ids = [];
for (var i = 0; i < links.length; i++) {
  var attrs = links[i].attributes || [];
  var id = null, name = null;
  for (var j = 0; j < attrs.length; j++) {
    if (attrs[j].name === "id") id = attrs[j].value;
    if (attrs[j].name === "name") name = attrs[j].value;
  }
  if (id && String(name) === String(workflowName)) ids.push(String(id));
}
if (ids.length === 0) throw new Error("No Orchestrator workflow named '" + workflowName + "'. Import it first, or check the name.");
if (ids.length > 1) throw new Error(ids.length + " Orchestrator workflows are named '" + workflowName + "'; refusing to guess. Rename one, or give the id.");
return ids[0];`}`,
    },
    {
      name: 'abxIdByName',
      description: 'The id of the ABX action with exactly this name in the project (GET /abx/api/resources/actions). Throws on none or several.',
      resultType: 'string',
      params: [pa('host', 'string', 'VCF Automation host'), pa('auth', 'Any', 'Bearer header'), pa('safe', 'Any', 'http options'), pa('actionName', 'string', 'Exact action name'), pa('projectId', 'string', 'The project that owns it')],
      script: `${head}${String.raw`var found = mod.findOne(mod.listAll(host, auth, "/abx/api/resources/actions", safe), { name: actionName, projectId: projectId }, "ABX action named " + actionName);
if (!found) throw new Error("No ABX action named '" + actionName + "' in the project. Create it first (Extensibility > Library > Actions).");
return String(found.id);`}`,
    },
  ];
}

/** The operators a policy or resource-action criterion takes (VERIFY the set on your release). */
export const CRITERIA_OPERATORS = ['eq', 'notEq', 'hasAny', 'in', 'notIn', 'greaterThan', 'lessThan'];

/**
 * "Property | Operator | Value" rows as the criteria object VCF Automation
 * policies and resource actions take: one row is { matchExpression: [row] },
 * several are all required, { matchExpression: [{ and: [rows] }] }. Values of
 * in / notIn / hasAny are comma separated. Problems go into `findings`.
 */
export function criteriaOf(text: string, what: string, findings: Finding[]): Record<string, unknown> | undefined {
  const rows = rowsOf(text, 3);
  const expressions: Record<string, unknown>[] = [];
  for (const [key = '', operator = '', value = ''] of rows) {
    if (!key || !CRITERIA_OPERATORS.includes(operator)) {
      findings.push(error(`${what}.bad-criterion`, `"${key} | ${operator} | ${value}" is not Property | Operator | Value with an operator of ${CRITERIA_OPERATORS.join(', ')}.`, { source: SRC }));
      continue;
    }
    const list = ['in', 'notIn', 'hasAny'].includes(operator);
    expressions.push({ key, operator, value: list ? value.split(',').map((v) => v.trim()).filter(Boolean) : value });
  }
  if (expressions.length === 0) return undefined;
  return expressions.length === 1 ? { matchExpression: expressions } : { matchExpression: [{ and: expressions }] };
}

// ---------------------------------------------------------------------------
// Orchestrator scheduled tasks and event subscriptions

/** How often a scheduled workflow runs, as the Orchestrator task API names it (recurrence-cycle; VERIFY). */
export const RECURRENCE: Readonly<Record<string, { label: string; cycle: string }>> = {
  once: { label: 'Once', cycle: 'one-time' },
  hourly: { label: 'Every hour', cycle: 'every-hours' },
  daily: { label: 'Every day', cycle: 'every-days' },
  weekly: { label: 'Every week', cycle: 'every-weeks' },
  monthly: { label: 'Every month', cycle: 'every-months' },
};

/** A workflow parameter value as the Orchestrator REST API writes it: { <type>: { value } }. */
export function vroValue(type: string, value: string): Record<string, unknown> {
  if (type === 'boolean') return { boolean: { value: /^(true|yes|1)$/i.test(value) } };
  if (type === 'number') return { number: { value: Number(value) } };
  return { string: { value } };
}

/**
 * The body of POST /vco/api/tasks: a scheduled run of one workflow. The field
 * names follow the Orchestrator REST reference for tasks (start-mode,
 * recurrence-cycle, recurrence-pattern, recurrence-start-date); the pattern
 * syntax "(<zone>)HH:MM:SS," is VERIFY against a task made in the client.
 */
export function scheduledTaskBody(o: {
  readonly name: string;
  readonly description: string;
  readonly workflowId: string;
  readonly recurrence: string;
  readonly start: string;
  readonly timezone: string;
  readonly params: readonly (readonly [string, string, string])[];
}): Record<string, unknown> {
  const cycle = RECURRENCE[o.recurrence]?.cycle ?? 'one-time';
  const time = (/T(\d{2}:\d{2}(:\d{2})?)/.exec(o.start)?.[1] ?? '02:00:00').padEnd(8, ':00').slice(0, 8);
  const day = new Date(o.start);
  const weekday = Number.isNaN(day.getTime()) ? 'Mon' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day.getUTCDay()]!;
  const dayOfMonth = Number.isNaN(day.getTime()) ? 1 : day.getUTCDate();
  const pattern = cycle === 'every-weeks' ? `(${o.timezone})${weekday} ${time},` : cycle === 'every-months' ? `(${o.timezone})${dayOfMonth} ${time},` : cycle === 'every-hours' ? `(${o.timezone})${time.slice(3)},` : `(${o.timezone})${time},`;
  return {
    name: o.name,
    description: o.description,
    'start-mode': 'normal',
    'recurrence-cycle': cycle,
    ...(cycle === 'one-time' ? {} : { 'recurrence-pattern': pattern }),
    'recurrence-start-date': o.start,
    workflow: { id: o.workflowId },
    'input-parameters': o.params.map(([name, type, value]) => ({ name, type, scope: 'local', value: vroValue(type, value) })),
  };
}

/** Event topics a subscription is most often on (the full list is in Extensibility → Event Topics). */
export const EVENT_TOPICS = [
  'compute.allocation.pre',
  'compute.provision.pre',
  'compute.provision.post',
  'compute.removal.pre',
  'compute.removal.post',
  'network.configure',
  'deployment.request.pre',
  'deployment.request.post',
  'deployment.action.pre',
  'deployment.action.post',
  'deployment.resource.action.pre',
  'deployment.resource.action.post',
  'disk.allocation.pre',
  'blueprint.version.released',
  'project.lifecycle.post',
];

/** The body of POST /event-broker/api/subscriptions for an Orchestrator workflow, enabled. */
export function workflowSubscription(o: { readonly name: string; readonly topic: string; readonly workflowId: string; readonly blocking: boolean; readonly timeoutMinutes: number; readonly criteria: string; readonly priority: number }): Record<string, unknown> {
  return {
    id: `sub_${stableId(`subscription:${o.name}:${o.topic}`).replace(/-/g, "").slice(0, 12)}`,
    name: o.name,
    type: 'RUNNABLE',
    eventTopicId: o.topic,
    runnableType: 'extensibility.vro',
    runnableId: o.workflowId,
    blocking: o.blocking,
    ...(o.blocking ? { priority: o.priority, timeout: o.timeoutMinutes } : {}),
    ...(o.criteria ? { criteria: o.criteria } : {}),
    disabled: false,
  };
}
