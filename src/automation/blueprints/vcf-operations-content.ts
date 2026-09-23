/**
 * VCF Operations: the content an automation stands on.
 *
 * The first set of VCF Operations blueprints wires things together — a rule, a
 * group, a schedule. This set writes the content itself: the symptom and the
 * alert, the recommendation and the action behind it, the super metric, the
 * policy for a class of workload, the compliance run, the payload a webhook
 * receives, the nightly backup of all of it, and the check that VCF Operations
 * is still collecting at all.
 *
 * The Aria Ops page finds what is wrong with an estate's content. These are the
 * shapes it should have been written in.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { applyScript, authHeader, authPreamble, readScript, scheduledEnv, type ApplyTarget } from '../apply.ts';
import {
  CONTENT_ZIP,
  FORMAT_SOURCES,
  XML_OPERATOR,
  alertContentXml,
  contentImportScript,
  contentPackage,
  contentStep,
  importMd,
  nothingToImportMd,
  policyMergeScript,
  stableId,
  superMetricsJson,
  type AlertContent,
} from '../vcfops-import.ts';
import { packageNameOf, toPackage, type AutomationPackage } from '../vro/to-package.ts';
import type { ImportStep } from '../vcfops-import.ts';
import type { VroConfigAttribute } from '../../kit/vro-package.ts';
import type { VroParam } from '../vcfa-import.ts';

const PLATFORM = 'vcf-operations' as const;
const SRC = 'ArchToolKit';

// ---------------------------------------------------------------------------
// The VCF Operations automations as Orchestrator packages (shared by
// vcf-operations.ts and vcf-operations-setup.ts)
// ---------------------------------------------------------------------------

/**
 * A package or folder name part from free text. "polic…" is spelled out of it:
 * import-vcfops.test refuses any import/ path that looks like a policy file,
 * because a policy fragment imported on its own drops the rest of the policy.
 */
export function opsPart(text: string, fallback = 'x'): string {
  return slugOf(text, fallback).replace(/polic(y|ies)/g, 'pol');
}

/**
 * The start of every VCF Operations workflow: the settings it cannot run
 * without, the login (POST /suite-api/api/auth/token/acquire, an OpsToken, as
 * in 9.1), and the helpers the scripts share.
 *
 *   ops(method, path, body, options, headers)  one suite-API call, auth added
 *   listAll(path, key, method, body)           every page of .key; a response
 *                                              with no pageInfo is one page
 *   named(items, value, field)                 the one item whose field (dotted,
 *                                              default name) is value; null for
 *                                              none, an error for several
 *   q(text)                                    encodeURIComponent
 *
 * The body of the workflow runs in try, and the session is released in finally.
 */
const OPS_PRELUDE = String.raw`if (!settings.opsHost) throw new Error("Set opsHost in the configuration element " + SETTINGS_NAME + ".");
if (!settings.opsUsername || !settings.opsPassword) throw new Error("Set opsUsername and opsPassword in the configuration element " + SETTINGS_NAME + ".");
var api = "https://" + settings.opsHost + "/suite-api/api/";
var SAFE = { redact: settings._secrets };
function q(text) { return encodeURIComponent(String(text)); }
function ops(method, path, body, options, headers) {
  var o = { redact: settings._secrets };
  var h = {};
  var k;
  if (options) for (k in options) if (options.hasOwnProperty(k)) o[k] = options[k];
  for (k in auth) if (auth.hasOwnProperty(k)) h[k] = auth[k];
  if (headers) for (k in headers) if (headers.hasOwnProperty(k)) h[k] = headers[k];
  return core.http(method, api + path, h, body === undefined ? null : body, o);
}
// Every page is read; a list that cannot be read whole is an error, never an
// empty list (acting on "nothing exists" would create duplicates).
function listAll(path, key, method, body) {
  var verb = method || "GET";
  return core.pageAll(function (page) {
    var r = ops(verb, path + (path.indexOf("?") < 0 ? "?" : "&") + "page=" + page + "&pageSize=1000", body || null, null, null).body;
    if (!r || typeof r !== "object" || (!r.hasOwnProperty(key) && !r.pageInfo)) throw new Error(verb + " " + path.split("?")[0] + " returned no " + key + " (VERIFY the response shape on your release); refusing to go on with an empty list.");
    var total = r.pageInfo && r.pageInfo.totalCount !== undefined && r.pageInfo.totalCount !== null ? r.pageInfo.totalCount : null;
    return { items: r[key] || [], total: total, more: r.pageInfo ? null : false };
  }, 0);
}
function field(item, path) {
  var v = item;
  var parts = String(path).split(".");
  for (var i = 0; i < parts.length && v !== null && v !== undefined; i++) v = v[parts[i]];
  return v;
}
function named(items, value, path) {
  var hits = [];
  for (var i = 0; i < items.length; i++) if (String(field(items[i], path || "name")) === String(value)) hits.push(items[i]);
  if (hits.length > 1) throw new Error(hits.length + " objects are named \"" + value + "\"; refusing to guess which one is meant.");
  return hits.length ? hits[0] : null;
}
var auth = core.loginVcfOps(settings.opsHost, settings.opsUsername, settings.opsPassword, settings.opsAuthSource || "");`;

/** A whole VCF Operations workflow script: guard, login, body in try, logout in finally, then after. */
export function opsWorkflow(body: string, after: string, changes: boolean): string {
  return [...(changes ? ['var ctx = core.begin(settings, dryRun);'] : []), OPS_PRELUDE, 'try {', body, '} finally {', '  core.logoutVcfOps(settings.opsHost, auth);', '}', after].join('\n');
}

export interface OpsPackageSpec {
  /** Package name parts after com.archtoolkit.vcfops. */
  readonly parts: readonly string[];
  /** The folder under ArchToolKit/VCF Operations/. */
  readonly folder: string;
  readonly description: string;
  readonly workflowName: string;
  readonly workflowDescription: string;
  /** Changes something: a dryRun input, core.begin, dryRun and cap in the settings. */
  readonly changes: boolean;
  readonly cap?: number;
  readonly outputs: readonly VroParam[];
  /** Inside try, after the login. */
  readonly body: string;
  /** After the logout: outputs, audit, notify. */
  readonly after: string;
  /** What the VCF Operations account needs to be able to do. */
  readonly account: string;
  readonly settings: readonly VroConfigAttribute[];
  readonly resources?: readonly { readonly name: string; readonly content: string }[];
  readonly configName?: string;
}

/** A VCF Operations automation as an Orchestrator package, on the core library. */
export function opsPackage(spec: OpsPackageSpec): AutomationPackage {
  const configName = spec.configName ?? 'Settings';
  const pkg = toPackage({
    packageName: packageNameOf('vcfops', ...spec.parts.map((part) => opsPart(part))),
    description: `${spec.description} Generated by ArchToolKit.`,
    categoryPath: `ArchToolKit/VCF Operations/${opsPart(spec.folder)}`,
    workflow: {
      name: spec.workflowName,
      description: `${spec.workflowDescription}${spec.changes ? ' A dry run until dryRun is set to false in the configuration element.' : ' Reads only.'}`,
      inputs: spec.changes ? [{ name: 'dryRun', type: 'boolean', description: 'true: report what would change and change nothing' }] : [],
      outputs: [...spec.outputs, { name: 'summary', type: 'string', description: 'The audit record, JSON' }],
      script: opsWorkflow(spec.body, spec.after, spec.changes),
    },
    config: {
      name: configName,
      description: `Settings of the ${spec.workflowName} workflow. Fill opsPassword after import${spec.changes ? '; set dryRun to false only after a dry run' : ''}.`,
      attributes: [
        { name: 'opsHost', type: 'string', value: '', description: 'VCF Operations host (FQDN)' },
        { name: 'opsUsername', type: 'string', value: '', description: spec.account },
        { name: 'opsPassword', type: 'SecureString', description: 'Its password' },
        { name: 'opsAuthSource', type: 'string', value: '', description: 'Authentication source for the account; empty for a local account' },
        ...spec.settings,
        ...(spec.changes
          ? [
              { name: 'dryRun', type: 'boolean' as const, value: true, description: 'The arming switch: nothing is changed while this is true' },
              { name: 'cap', type: 'number' as const, value: spec.cap ?? 1, description: 'The most changes one run may make' },
            ]
          : []),
        ...(spec.settings.some((a) => a.name === 'webhook') ? [] : [{ name: 'webhook', type: 'string' as const, value: '', description: 'Optional: where the audit record is posted' }]),
      ],
    },
    ...(spec.resources ? { resources: spec.resources } : {}),
  });
  // The same guard the import test holds every import/ path to.
  const bad = Object.keys(pkg.files).filter((path) => /polic/i.test(path));
  if (bad.length > 0) throw new Error(`A package path looks like a policy file: ${bad[0]}`);
  return pkg;
}

/** The package's import steps as IMPORT.md steps, the first one naming both package folders. */
export function packageSteps(pkg: AutomationPackage, what: string): ImportStep[] {
  return pkg.importSteps.map((step, index) => ({
    heading: index === 0 ? `${step.heading} — ${what}` : step.heading,
    files: index === 0 ? [pkg.packageDir, 'import/com.archtoolkit.core.package'] : [],
    how: step.lines.filter((line) => line.trim() !== '').map((line) => line.replace(/^- /, '')),
  }));
}

/** A fallback script moved under scripts/: it reads its payloads from beside itself, wherever it is run from. */
export function inScripts(script: string): string {
  return script.replace('set -euo pipefail\n', 'set -euo pipefail\ncd "$(dirname "$0")"\n');
}

/** The display names VCF Operations gives the vCenter actions (GET /api/actiondefinitions → displayName). */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  DeleteUnusedSnapshotsForVM: 'Delete Unused Snapshots for VM',
  PowerOffVM: 'Power Off VM',
  SetCPUCountForVM: 'Set CPU Count for VM',
  SetMemoryForVM: 'Set Memory for VM',
  MoveVM: 'Move VM',
  RebalanceContainer: 'Rebalance Container',
};

/**
 * Alert action: the action definition (it exists only once actions are enabled
 * on the vCenter adapter), the recommendation (by its text; created once), and
 * the recommendation added to every state of the alert definition.
 */
const ALERT_ACTION_BODY = String.raw`var rec = JSON.parse(core.resource(RESOURCE_PATH, "recommendation.json"));
if (!settings.alertDefinitionId) throw new Error("Set alertDefinitionId in the configuration element " + SETTINGS_NAME + ".");
var alertDef = ops("GET", "alertdefinitions/" + q(settings.alertDefinitionId), null, null, null).body;
if (!alertDef || !alertDef.id) throw new Error("No alert definition " + settings.alertDefinitionId + ".");
var states = alertDef.states || [];
if (!states.length) throw new Error("Alert definition " + alertDef.id + " has no states to add a recommendation to.");
var definitions = listAll("actiondefinitions", "actionDefinitions");
var matches = [];
for (var i = 0; i < definitions.length; i++) {
  if (String(definitions[i].displayName) === String(settings.actionName) || String(definitions[i].id) === String(settings.actionName)) matches.push(definitions[i]);
}
if (matches.length !== 1) throw new Error((matches.length ? matches.length + " action definitions are" : "No action definition is") + " named \"" + settings.actionName + "\" (GET actiondefinitions). Actions are listed once they are enabled on the vCenter adapter instance.");
rec.action.actionAdapterKindId = String(matches[0].actionAdapterKindKey);
var existing = named(listAll("recommendations", "recommendations"), rec.description, "description");
var recId = null;
if (existing) {
  recId = String(existing.id);
  System.log("Exists, left as it is: the recommendation (" + recId + ")");
} else {
  recId = core.act(ctx, "create the recommendation that runs " + settings.actionName, function () {
    var r = ops("POST", "recommendations", rec, null, null);
    if (!r.body || !r.body.id) throw new Error("POST recommendations returned no id; nothing after it was changed.");
    return String(r.body.id);
  });
}
var refId = recId || "new-recommendation";
var attach = false;
for (var s = 0; s < states.length; s++) {
  var map = states[s].recommendationPriorityMap || {};
  if (!map.hasOwnProperty(refId)) {
    var n = 0;
    for (var k in map) if (map.hasOwnProperty(k)) n++;
    map[refId] = n + 1;
    states[s].recommendationPriorityMap = map;
    attach = true;
  }
}
if (attach) {
  core.act(ctx, "add the recommendation to alert definition " + alertDef.id, function () {
    return ops("PUT", "alertdefinitions", alertDef, null, null).statusCode;
  });
} else {
  System.log("Alert definition " + alertDef.id + " already carries the recommendation.");
}
System.log("Next, by a person, as a reviewed change: set automate on this alert in the dedicated policy (scripts/merge-policy.sh, or the policy editor).");`;

/**
 * Workload policy: every read first (the parent, the groups), so a missing
 * group stops the run before anything is created; then create (unless it
 * exists) and assign.
 */
const WORKLOAD_BODY = String.raw`var def = JSON.parse(core.resource(RESOURCE_PATH, "definition.json"));
var all = listAll("policies", "policySummaries");
var parentItem = named(all, def.parent);
if (!parentItem) throw new Error("Nothing named \"" + def.parent + "\" to inherit from (GET policies).");
var groupItems = listAll("resources/groups", "groups");
var groupIds = [];
var missing = [];
for (var i = 0; i < def.groups.length; i++) {
  var hit = named(groupItems, def.groups[i], "resourceKey.name");
  if (hit) groupIds.push(String(hit.id)); else missing.push(def.groups[i]);
}
if (missing.length) throw new Error("No custom group named " + missing.join(", ") + "; nothing was created or assigned.");
if (!groupIds.length) throw new Error("No groups to assign it to; assigned to nothing, it would apply to nothing.");
var existing = named(all, def.name);
var targetId = null;
if (existing) {
  targetId = String(existing.id);
  System.log("Exists, left as it is: \"" + def.name + "\" (" + targetId + "); its group assignment is still applied.");
} else {
  targetId = core.act(ctx, "create \"" + def.name + "\" inheriting from \"" + def.parent + "\"", function () {
    var r = ops("POST", "policies", { name: def.name, description: def.description, parentPolicy: String(parentItem.id) }, null, null);
    if (!r.body || !r.body.id) throw new Error("POST policies returned no id; nothing was assigned.");
    return String(r.body.id);
  });
}
core.act(ctx, "assign \"" + def.name + "\" to " + def.groups.join(", "), function () {
  var r = ops("PUT", "policies/" + q(targetId) + "/assign", { groupIds: groupIds }, null, null);
  var failed = (r.body && r.body.failedGroupIds) || [];
  if (failed.length) throw new Error("not assigned to group(s) " + failed.join(", ") + ".");
  return true;
});
System.log("Then, in the editor: the capacity values from the design, and priority " + def.priority + ".");`;

/**
 * Compliance drift: the benchmark's alert definitions (compliance subtype 21,
 * name matching), the group's members, their active alerts of those
 * definitions, and the failing rules (the alerts' contributing symptoms, by
 * name). The same steps and the same report as scripts/report.sh.
 */
const COMPLIANCE_BODY = String.raw`var rx = new RegExp(String(settings.definitionRegex), "i");
var bench = [];
var defs = listAll("alertdefinitions", "alertDefinitions");
for (var i = 0; i < defs.length; i++) {
  if (Number(defs[i].subType) === 21 && rx.test(String(defs[i].name || ""))) bench.push({ id: String(defs[i].id), name: String(defs[i].name) });
}
System.log(bench.length + " alert definition(s) for " + settings.benchmark + " (name matches /" + settings.definitionRegex + "/):");
for (var b = 0; b < bench.length; b++) System.log("  " + bench[b].name);
if (!bench.length) throw new Error("No compliance alert definition matches /" + settings.definitionRegex + "/. Nothing to report on is not the same as compliant: fix definitionRegex.");
var group = named(listAll("resources/groups", "groups"), settings.groupName, "resourceKey.name");
if (!group) throw new Error("No custom group named \"" + settings.groupName + "\".");
var members = listAll("resources/groups/" + q(group.id) + "/members", "resourceList");
if (!members.length) throw new Error("Group \"" + settings.groupName + "\" has no members: nothing would be checked.");
var inGroup = {};
for (var m = 0; m < members.length; m++) inGroup[String(members[m].identifier)] = (members[m].resourceKey && members[m].resourceKey.name) || String(members[m].identifier);
var benchIds = [];
for (var d = 0; d < bench.length; d++) benchIds.push(bench[d].id);
var alerts = listAll("alerts/query", "alerts", "POST", { activeOnly: true, alertDefinitionId: benchIds });
var mine = [];
for (var a = 0; a < alerts.length; a++) if (inGroup.hasOwnProperty(String(alerts[a].resourceId))) mine.push(alerts[a]);
// The failing rules: every symptomDefinitionId under each contributing-symptoms entry.
function collect(node, out) {
  if (!node || typeof node !== "object") return;
  if (node.symptomDefinitionId) out[String(node.symptomDefinitionId)] = true;
  for (var key in node) if (node.hasOwnProperty(key)) collect(node[key], out);
}
function keysOf(o) { var out = []; for (var k in o) if (o.hasOwnProperty(k)) out.push(k); return out; }
var symptomsOf = {};
var allSymptoms = {};
for (var c = 0; c < mine.length; c += 50) {
  var ids = [];
  for (var j = c; j < Math.min(c + 50, mine.length); j++) ids.push("id=" + q(mine[j].alertId));
  var cs = ops("GET", "alerts/contributingsymptoms?" + ids.join("&"), null, null, null).body || {};
  var entries = cs.contributingSymptoms || [];
  for (var e = 0; e < entries.length; e++) {
    var found = {};
    collect(entries[e], found);
    symptomsOf[String(entries[e].alertId || entries[e].id)] = keysOf(found);
    for (var f in found) if (found.hasOwnProperty(f)) allSymptoms[f] = true;
  }
}
var nameOf = {};
var symptomIds = keysOf(allSymptoms).sort();
for (var s = 0; s < symptomIds.length; s += 50) {
  var sq = [];
  for (var t = s; t < Math.min(s + 50, symptomIds.length); t++) sq.push("id=" + q(symptomIds[t]));
  var sd = (ops("GET", "symptomdefinitions?" + sq.join("&"), null, null, null).body || {}).symptomDefinitions || [];
  for (var u = 0; u < sd.length; u++) nameOf[String(sd[u].id)] = String(sd[u].name);
}
function addUnique(list, value) { if (list.indexOf(value) < 0) list.push(value); }
var byResource = {};
for (var r = 0; r < mine.length; r++) {
  var rid = String(mine[r].resourceId);
  var entry = byResource[rid] || (byResource[rid] = { resourceId: rid, resource: inGroup[rid], alerts: [], failingRules: [] });
  addUnique(entry.alerts, String(mine[r].alertDefinitionName));
  var rules = symptomsOf[String(mine[r].alertId)] || [];
  for (var x = 0; x < rules.length; x++) addUnique(entry.failingRules, nameOf[rules[x]] || rules[x]);
}
var report = [];
var rids = keysOf(byResource).sort();
var distinct = {};
for (var y = 0; y < rids.length; y++) {
  var item = byResource[rids[y]];
  item.alerts.sort();
  item.failingRules.sort();
  for (var z = 0; z < item.failingRules.length; z++) distinct[item.failingRules[z]] = true;
  report.push(item);
  System.log("FAILS: " + item.resource + ": " + (item.failingRules.length ? item.failingRules.join("; ") : "(no contributing symptoms returned: open the alert)"));
}
System.log(settings.benchmark + ": " + report.length + " of " + members.length + " object(s) in " + settings.groupName + " fail, across " + keysOf(distinct).length + " distinct rule(s).");`;

/**
 * Webhook payload: the payload template (9.x: POST /api/notifications/templates),
 * once, by name; then, when asked, the sample posted to the endpoint — for a
 * ServiceNow Table API endpoint only when no open incident has its
 * correlation_id, because the Table API never deduplicates.
 */
const PAYLOAD_BODY = String.raw`var template = JSON.parse(core.resource(RESOURCE_PATH, "template.json"));
var existing = named(listAll("notifications/templates?name=" + q(template.name), "notificationTemplates"), template.name);
var templateRef = null;
if (existing) {
  templateRef = String(existing.templateId || existing.id);
  System.log("Exists, left as it is: payload template \"" + template.name + "\" (" + templateRef + ")");
} else {
  templateRef = core.act(ctx, "create payload template \"" + template.name + "\"", function () {
    var r = ops("POST", "notifications/templates", template, null, null);
    var made = r.body && (r.body.templateId || r.body.id);
    if (!made) throw new Error("POST notifications/templates returned no templateId.");
    return String(made);
  });
}
if (settings.sendSample === true || String(settings.sendSample) === "true") {
  if (!settings.endpoint) throw new Error("Set endpoint in the configuration element " + SETTINGS_NAME + " to send the sample.");
  var endpoint = String(settings.endpoint);
  var where = endpoint.split("?")[0];
  var sample = core.resource(RESOURCE_PATH, "sample.json");
  var headers = null;
  if (settings.receiverUsername) {
    if (!settings.receiverPassword) throw new Error("Set receiverPassword for " + settings.receiverUsername + ".");
    headers = { "Authorization": "Basic " + core.base64(String(settings.receiverUsername) + ":" + String(settings.receiverPassword)) };
  }
  if (/\/api\/now\/table\/incident/.test(endpoint)) {
    var corr = JSON.parse(sample).correlation_id;
    var snBase = endpoint.split("/api/now/")[0];
    var open = core.http("GET", snBase + "/api/now/table/incident?sysparm_query=" + q("correlation_id=" + corr + "^active=true") + "&sysparm_fields=number&sysparm_limit=1", headers, null, SAFE).body || {};
    if (open.result && open.result.length) throw new Error("Open incident " + open.result[0].number + " already has correlation_id " + corr + "; not creating a second. Close it to test again.");
  }
  core.act(ctx, "post the sample payload to " + where, function () {
    return core.http("POST", endpoint, headers, sample, SAFE).statusCode;
  });
}`;

/** Content backup: every page of each content type, read whole or not at all. */
const BACKUP_BODY = String.raw`var TYPES = [["alertdefinitions", "alertDefinitions"], ["symptomdefinitions", "symptomDefinitions"], ["recommendations", "recommendations"], ["supermetrics", "superMetrics"], ["resources/groups", "groups"]];
var backup = { source: "vcf-operations", environment: settings.environment, taken: new Date().toISOString(), counts: {}, content: {} };
for (var i = 0; i < TYPES.length; i++) {
  var items = listAll(TYPES[i][0], TYPES[i][1]);
  backup.content[TYPES[i][1]] = items;
  backup.counts[TYPES[i][1]] = items.length;
  System.log(TYPES[i][1] + ": " + items.length);
}
if (settings.includePolicies === true || String(settings.includePolicies) === "true") {
  var summaries = listAll("policies", "policySummaries");
  backup.content.policySummaries = summaries;
  backup.counts.policySummaries = summaries.length;
  System.log("policySummaries: " + summaries.length + " (the list; the exports themselves are zips, taken by scripts/backup-content.sh)");
}`;

/** Self-health: the node, the collectors, every adapter instance's last collection. */
const HEALTH_BODY = String.raw`var problems = [];
var staleMs = Number(settings.staleMinutes) * 60 * 1000;
var ignore = settings.ignoreAdapters || [];
var node = ops("GET", "deployment/node/status", null, null, null).body || {};
if (String(node.status) !== "ONLINE") problems.push("node status is " + (node.status || "UNKNOWN"));
var collectors = (ops("GET", "collectors", null, null, null).body || {}).collector || [];
if (!collectors.length) problems.push("no collectors listed at all");
for (var c = 0; c < collectors.length; c++) {
  if (String(collectors[c].state) !== "UP") problems.push("collector " + collectors[c].name + " is " + collectors[c].state);
}
var adapters = (ops("GET", "adapters", null, null, null).body || {}).adapterInstancesInfoDto || [];
if (!adapters.length) problems.push("no adapter instances listed at all");
var now = new Date().getTime();
for (var a = 0; a < adapters.length; a++) {
  var name = String((adapters[a].resourceKey && adapters[a].resourceKey.name) || adapters[a].id);
  if (ignore.indexOf(name) >= 0) continue;
  var last = adapters[a].lastCollected;
  if (last === null || last === undefined || now - Number(last) > staleMs) {
    problems.push("adapter " + name + " has not collected for more than " + settings.staleMinutes + " minutes");
  } else if (adapters[a].numberOfResourcesCollected !== undefined && adapters[a].numberOfResourcesCollected !== null && Number(adapters[a].numberOfResourcesCollected) === 0) {
    problems.push("adapter " + name + " is collecting nothing; check its credential");
  }
}`;

/** The VERIFY lines that are the same for every VCF Operations package. */
export const OPS_PACKAGE_REQUIRES = 'VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Operations certificate trusted in Orchestrator, and a VCF Operations account for the configuration element — or, for the fallback script, jq and curl on the machine running it.';

/**
 * send-sample.sh for ServiceNow: dry run by default, the credential from a
 * mode-600 file on stdin, and no second incident for the same correlation_id.
 */
function serviceNowSample(endpoint: string, sampleFile: string): string {
  return [
    '#!/usr/bin/env bash',
    '# Post the filled-in sample to ServiceNow, to test the receiving end.',
    '#',
    '# This CREATES AN INCIDENT. Without --execute it only prints what it would send.',
    '# The Table API needs a credential: SN_USER, and SN_PASSWORD_FILE, a file holding',
    '# the password with mode 600. It goes to curl as a config on stdin (curl -K -),',
    '# never as an argument.',
    '#',
    '# The Table API does not deduplicate: every POST is a new incident. Against it,',
    '# this first looks for an open incident with the same correlation_id and stops',
    '# if there is one.',
    'set -euo pipefail',
    `ENDPOINT="\${ENDPOINT:-${endpoint.replace(/["$`\\]/g, '\\$&')}}"`,
    `SAMPLE="$(cd "$(dirname "$0")" && pwd)/${sampleFile}"`,
    'EXECUTE=0',
    '[[ "${1:-}" == "--execute" ]] && EXECUTE=1',
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    'CORR=$(jq -r \'.correlation_id // empty\' "$SAMPLE")',
    '[[ -n "$CORR" ]] || { echo "The sample has no correlation_id." >&2; exit 2; }',
    '',
    'if (( ! EXECUTE )); then',
    '  echo "DRY RUN: would POST $SAMPLE to $ENDPOINT, creating one incident with correlation_id $CORR:"',
    '  jq . "$SAMPLE"',
    '  echo "Nothing was sent. Re-run with --execute, against a sub-production instance first."',
    '  exit 0',
    'fi',
    '',
    ': "${SN_USER:?set SN_USER to the ServiceNow integration user}"',
    ': "${SN_PASSWORD_FILE:?set SN_PASSWORD_FILE to a file holding its password, mode 600}"',
    '[[ -r "$SN_PASSWORD_FILE" ]] || { echo "Cannot read $SN_PASSWORD_FILE" >&2; exit 2; }',
    'PERM=$(stat -c %a "$SN_PASSWORD_FILE" 2>/dev/null || stat -f %Lp "$SN_PASSWORD_FILE")',
    '[[ "$PERM" == 600 || "$PERM" == 400 ]] || { echo "$SN_PASSWORD_FILE is mode $PERM: make it 600 so only you can read it." >&2; exit 2; }',
    '',
    '# user:password as a curl config on stdin; quotes and backslashes escaped for it.',
    'sn() {',
    '  { printf \'user = "%s:\' "$SN_USER"; tr -d \'\\n\' < "$SN_PASSWORD_FILE" | sed \'s/[\\\\"]/\\\\&/g\'; printf \'"\\n\'; } |',
    '    curl -sS -f -K - "$@"',
    '}',
    '',
    'if [[ "$ENDPOINT" == */api/now/table/incident* ]]; then',
    '  BASE="${ENDPOINT%%/api/now/*}"',
    '  EXISTING=$(sn -G "$BASE/api/now/table/incident" -H "Accept: application/json" \\',
    '    --data-urlencode "sysparm_query=correlation_id=${CORR}^active=true" \\',
    '    --data-urlencode "sysparm_fields=number" --data-urlencode "sysparm_limit=1" | jq -r \'.result[0].number // empty\')',
    '  if [[ -n "$EXISTING" ]]; then',
    '    echo "Open incident $EXISTING already has correlation_id $CORR; not creating a second. Close it to test again." >&2',
    '    exit 1',
    '  fi',
    'else',
    '  echo "Not the Table API incident endpoint: this cannot check for an existing incident first. The receiving Import Set or Scripted REST API must upsert on correlation_id."',
    'fi',
    '',
    'sn -X POST "$ENDPOINT" -H "Content-Type: application/json" -H "Accept: application/json" --data-binary @"$SAMPLE" |',
    '  jq -r \'"created \\(.result.number // "?") (sys_id \\(.result.sys_id // "?"))"\'',
    'echo "Check it reads correctly, then close it."',
    '',
  ].join('\n');
}

/** How each benchmark's compliance alert definitions are usually named. VERIFY per release. */
const BENCHMARK_ALERT_RX: Readonly<Record<string, string>> = {
  'VCF 9.x Security Configuration Guide v1.0': 'VCF 9.*Security Configuration Guide',
  'PCI DSS v4.0.1 for VCF 9 v1.0': 'PCI DSS',
  'VCF 9 General Controls v1.0': 'General Controls',
  'vSphere Security Configuration Guide': 'vSphere Security Configuration Guide',
  CIS: '\\bCIS\\b',
  'DISA STIG': 'DISA|STIG',
  'PCI DSS': 'PCI DSS',
  HIPAA: 'HIPAA',
  'ISO 27001': 'ISO ?27001',
};

// ---------------------------------------------------------------------------
// Shared bash helpers (also used by vcf-ops-operate.ts and vcf-ops-build.ts)
// ---------------------------------------------------------------------------

/** Escape for a bash single-quoted string. */
export function shq(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** The variable authPreamble keeps its private header file in. */
export function authFileVar(target: ApplyTarget): string {
  return authHeader(target).slice(3, -1);
}

/**
 * A private work directory, removed on exit together with the auth header file.
 * One trap for both: a second `trap … EXIT` would replace the one authPreamble
 * set, and the token file would be left behind.
 */
export function workDirLines(target: ApplyTarget = PLATFORM, extra: readonly string[] = []): string[] {
  const files = [`"$WORK"`, `"\${${authFileVar(target)}:-}"`, ...extra.map((name) => `"\${${name}:-}"`)].join(' ');
  return ['WORK=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/atk-work.XXXXXX")', `trap 'rm -rf ${files}' EXIT`];
}

/**
 * Paged reads for a readScript, all through files so no list is ever an argument
 * (an argument over 128 KB fails with "Argument list too long").
 *
 * get_all and post_all follow page= until a short page or pageInfo.totalCount,
 * and fail — rather than return an empty list — when a page cannot be read or
 * has neither the list key nor pageInfo. They need WORK (workDirLines).
 */
export const PAGED_HELPERS: readonly string[] = [
  'post() {',
  `  curl -sS -f -X POST "https://\${VCFOPS_HOST}$1" -H "${authHeader(PLATFORM)}" \\`,
  '    -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @-',
  '}',
  '',
  '# pages METHOD PATH KEY OUT [BODYFILE]: every item of .KEY across all pages, as',
  '# one JSON array in the file OUT.',
  'pages() {',
  '  local method="$1" path="$2" key="$3" out="$4" body="${5:-}" page=0 size="${PAGE_SIZE:-1000}" sep="?" n total',
  '  [[ "$path" == *\\?* ]] && sep="&"',
  '  : > "$out.items"',
  '  while :; do',
  '    if [[ "$method" == GET ]]; then',
  '      get "${path}${sep}page=${page}&pageSize=${size}" > "$WORK/page.json" || { echo "GET ${path} (page ${page}) failed" >&2; return 1; }',
  '    else',
  '      post "${path}${sep}page=${page}&pageSize=${size}" < "$body" > "$WORK/page.json" || { echo "POST ${path} (page ${page}) failed" >&2; return 1; }',
  '    fi',
  '    jq -e --arg k "$key" \'type == "object" and (has($k) or has("pageInfo"))\' "$WORK/page.json" >/dev/null \\',
  '      || { echo "${path}: the response has no .${key} — VERIFY the response shape" >&2; return 1; }',
  '    jq -c --arg k "$key" \'(.[$k] // [])[]\' "$WORK/page.json" >> "$out.items" || return 1',
  '    n=$(jq --arg k "$key" \'(.[$k] // []) | length\' "$WORK/page.json") || return 1',
  '    total=$(jq \'.pageInfo.totalCount // -1\' "$WORK/page.json") || return 1',
  '    page=$((page + 1))',
  '    if (( n < size )) || (( total >= 0 && page * size >= total )); then break; fi',
  '    (( page < 10000 )) || { echo "${path}: still paging after 10000 pages" >&2; return 1; }',
  '  done',
  '  jq -s . "$out.items" > "$out" || return 1',
  '  rm -f "$out.items"',
  '}',
  'get_all() { pages GET "$@"; }',
  'post_all() { pages POST "$1" "$2" "$3" "$4"; }',
];

/**
 * Posting a report to a webhook. curl -f makes an HTTP error a failure, and a
 * failed post turns the exit code into 3, so an undelivered report is never
 * mistaken for a delivered one (1 stays "problems found", 2 "could not run").
 */
export const WEBHOOK_HELPER: readonly string[] = [
  'WEBHOOK_FAILED=0',
  'post_webhook() {',
  '  curl -sS -f -X POST "$1" -H "Content-Type: application/json" --data-binary @"$2" >/dev/null \\',
  '    || { echo "webhook post to $1 failed: the report was NOT delivered" >&2; WEBHOOK_FAILED=1; }',
  '}',
  '# Exit with $1, or with 3 when a webhook post failed.',
  'finish() { if (( WEBHOOK_FAILED )); then exit 3; fi; exit "$1"; }',
];

/** Object kinds people write alerts against, with the metrics that matter on each. */
const KINDS: Readonly<Record<string, { label: string; metrics: readonly { key: string; label: string; unit: string }[] }>> = {
  VirtualMachine: {
    label: 'Virtual machine',
    metrics: [
      { key: 'cpu|readyPct', label: 'CPU ready %', unit: '%' },
      { key: 'cpu|usage_average', label: 'CPU usage %', unit: '%' },
      { key: 'mem|guest_usage', label: 'Guest memory usage %', unit: '%' },
      { key: 'mem|balloonPct', label: 'Memory ballooned %', unit: '%' },
      { key: 'guestfilesystem|percentage_total', label: 'Guest disk used %', unit: '%' },
      { key: 'virtualDisk|totalLatency', label: 'Disk latency (ms)', unit: 'ms' },
      { key: 'diskspace|snapshot', label: 'Snapshot space (GB)', unit: 'GB' },
    ],
  },
  HostSystem: {
    label: 'ESXi host',
    metrics: [
      { key: 'cpu|usage_average', label: 'CPU usage %', unit: '%' },
      { key: 'mem|host_usagePct', label: 'Memory usage %', unit: '%' },
      { key: 'cpu|capacity_contentionPct', label: 'CPU contention %', unit: '%' },
      { key: 'net|droppedPct', label: 'Network packets dropped %', unit: '%' },
      { key: 'sys|uptime_latest', label: 'Uptime (seconds)', unit: 's' },
    ],
  },
  ClusterComputeResource: {
    label: 'Cluster',
    metrics: [
      { key: 'cpu|demandPct', label: 'CPU demand %', unit: '%' },
      { key: 'mem|host_usagePct', label: 'Memory usage %', unit: '%' },
      { key: 'OnlineCapacityAnalytics|timeRemaining', label: 'Capacity time remaining (days)', unit: 'days' },
    ],
  },
  Datastore: {
    label: 'Datastore',
    metrics: [
      { key: 'capacity|usedSpacePct', label: 'Used space %', unit: '%' },
      { key: 'devices|totalLatency_average', label: 'Latency (ms)', unit: 'ms' },
      { key: 'OnlineCapacityAnalytics|diskspace|timeRemaining', label: 'Disk time remaining (days)', unit: 'days' },
    ],
  },
};

const METRIC_OPTIONS = Object.entries(KINDS).flatMap(([kind, info]) =>
  info.metrics.map((metric) => ({ value: `${kind}::${metric.key}`, label: metric.label, group: info.label })),
);

function metricOf(value: string): { kind: string; key: string; label: string; unit: string } {
  const [kind = 'HostSystem', key = 'cpu|usage_average'] = value.split('::');
  const found = KINDS[kind]?.metrics.find((metric) => metric.key === key);
  return { kind, key, label: found?.label ?? key, unit: found?.unit ?? '' };
}

/** The alert classification VCF Operations files every alert definition under. */
const ALERT_TYPES: readonly { value: string; label: string }[] = [
  { value: '16', label: 'Virtualization/Hypervisor' },
  { value: '15', label: 'Application' },
  { value: '17', label: 'Hardware (OSI)' },
  { value: '18', label: 'Storage' },
  { value: '19', label: 'Network' },
];
const ALERT_SUBTYPES: readonly { value: string; label: string }[] = [
  { value: '19', label: 'Performance' },
  { value: '18', label: 'Availability' },
  { value: '20', label: 'Capacity' },
  { value: '21', label: 'Compliance' },
  { value: '22', label: 'Configuration' },
];

const OPERATORS = [
  { value: 'GT', label: 'is above' },
  { value: 'GT_EQ', label: 'is at or above' },
  { value: 'LT', label: 'is below' },
  { value: 'LT_EQ', label: 'is at or below' },
];

/**
 * The alert-definition workflow: symptoms, then the recommendation, then the
 * alert that refers to them, each id passed along. Idempotent: an object that
 * already exists (symptoms and the alert by name, the recommendation by its
 * text) is left as it is and its id used. Every create goes through core.act,
 * so a dry run creates nothing and the cap bounds a run.
 */
function alertDefinitionWorkflow(kind: string, hasRecommendation: boolean): string {
  return String.raw`var RESOURCE_KIND = ${JSON.stringify(kind)};
var HAS_RECOMMENDATION = ${hasRecommendation ? 'true' : 'false'};
var ctx = core.begin(settings, dryRun);
if (!settings.opsHost) throw new Error("Set opsHost in the configuration element " + SETTINGS_NAME + ".");
if (!settings.opsUsername || !settings.opsPassword) throw new Error("Set opsUsername and opsPassword in the configuration element " + SETTINGS_NAME + ".");
var api = "https://" + settings.opsHost + "/suite-api/api/";
var auth = core.loginVcfOps(settings.opsHost, settings.opsUsername, settings.opsPassword, settings.opsAuthSource || "");
var SAFE = { redact: settings._secrets };

function listAll(path, key) {
  return core.pageAll(function (page) {
    var r = core.http("GET", api + path + (path.indexOf("?") < 0 ? "?" : "&") + "page=" + page + "&pageSize=1000", auth, null, SAFE).body || {};
    return { items: r[key] || [], total: r.pageInfo ? r.pageInfo.totalCount : null };
  }, 0);
}
function find(items, field, value) {
  for (var i = 0; i < items.length; i++) if (String(items[i][field]) === String(value)) return String(items[i].id);
  return null;
}
// key names the object in a dry run's placeholder id, which ends up inside
// the alert's JSON: letters and hyphens only.
function ensure(key, label, existing, path, body) {
  if (existing) {
    System.log("Exists, left as it is: " + label + " (" + existing + ")");
    return existing;
  }
  var id = core.act(ctx, "create " + label, function () {
    var r = core.http("POST", api + path, auth, body, SAFE);
    if (!r.body || !r.body.id) throw new Error("POST " + path + " returned no id; nothing after it was created.");
    return String(r.body.id);
  });
  return id || "new-" + key;
}

var alertId = null;
try {
  var warning = JSON.parse(core.resource(RESOURCE_PATH, "symptom-warning.json"));
  var critical = JSON.parse(core.resource(RESOURCE_PATH, "symptom-critical.json"));
  var alertText = core.resource(RESOURCE_PATH, "alert.json");
  var alertName = JSON.parse(alertText).name;

  var symptoms = listAll("symptomdefinitions?adapterKind=VMWARE&resourceKind=" + encodeURIComponent(RESOURCE_KIND), "symptomDefinitions");
  var warningId = ensure("warning-symptom", "warning symptom \"" + warning.name + "\"", find(symptoms, "name", warning.name), "symptomdefinitions", warning);
  var criticalId = ensure("critical-symptom", "critical symptom \"" + critical.name + "\"", find(symptoms, "name", critical.name), "symptomdefinitions", critical);
  var recommendationId = "";
  if (HAS_RECOMMENDATION) {
    var recommendation = JSON.parse(core.resource(RESOURCE_PATH, "recommendation.json"));
    var recommendations = listAll("recommendations", "recommendations");
    recommendationId = ensure("recommendation", "recommendation", find(recommendations, "description", recommendation.description), "recommendations", recommendation);
  }

  var alerts = listAll("alertdefinitions?adapterKind=VMWARE&resourceKind=" + encodeURIComponent(RESOURCE_KIND), "alertDefinitions");
  var alertBody = JSON.parse(alertText.split("__WARNING_SYMPTOM_ID__").join(warningId).split("__CRITICAL_SYMPTOM_ID__").join(criticalId).split("__RECOMMENDATION_ID__").join(recommendationId));
  alertId = ensure("alert-definition", "alert definition \"" + alertName + "\"", find(alerts, "name", alertName), "alertdefinitions", alertBody);
} finally {
  core.logoutVcfOps(settings.opsHost, auth);
}
alertDefinitionId = ctx.dryRun ? "" : alertId;
summary = core.audit(ctx, { alertDefinitionId: alertDefinitionId, note: "The alert is enabled only where a policy enables it." });
core.notify(settings.webhook, summary);`;
}

export const VCF_OPERATIONS_CONTENT: readonly AutomationBlueprint[] = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_alert_definition',
    platform: PLATFORM,
    label: 'An alert, with its symptoms and a recommendation',
    group: 'Alerts',
    description:
      'The three objects an alert actually is: a symptom that tests a metric, an alert definition that is raised when the symptoms hold, and a recommendation that tells whoever receives it what to do. The Aria Ops page finds hundreds of alerts missing one of the three; this writes all three together and applies them in the order they refer to each other.',
    inputs: [
      { id: 'alert_name', label: 'Alert name', control: 'text', default: 'Host memory pressure sustained' },
      { id: 'metric', label: 'When', control: 'select', options: METRIC_OPTIONS, default: 'HostSystem::mem|host_usagePct' },
      { id: 'operator', label: 'Is', control: 'select', options: OPERATORS, default: 'GT' },
      { id: 'warning_at', label: 'Warning at', control: 'number', default: 85, min: 0, max: 1000000 },
      { id: 'critical_at', label: 'Critical at', control: 'number', default: 95, min: 0, max: 1000000 },
      { id: 'wait_cycles', label: 'For (collection cycles)', control: 'number', default: 3, min: 1, max: 60, hint: 'One cycle is five minutes by default. Three means fifteen minutes of it being true' },
      { id: 'cancel_cycles', label: 'Clear after (cycles)', control: 'number', default: 3, min: 1, max: 60 },
      { id: 'alert_type', label: 'Type', control: 'select', options: ALERT_TYPES, default: '16' },
      { id: 'alert_subtype', label: 'Subtype', control: 'select', options: ALERT_SUBTYPES, default: '19' },
      { id: 'recommendation', label: 'Recommendation', control: 'textarea', default: 'Check for VMs with memory reservations or limits on this host, then migrate the largest consumers with vMotion. If the whole cluster is above 85%, this is a capacity request, not a tuning one.', hint: 'What the person who receives it should do. An alert with no answer to "and then what" is noise' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const alertName = str(values, 'alert_name', 'Custom alert');
      const metric = metricOf(str(values, 'metric', 'HostSystem::mem|host_usagePct'));
      const operator = str(values, 'operator', 'GT');
      const warnAt = num(values, 'warning_at', 85);
      const critAt = num(values, 'critical_at', 95);
      const wait = num(values, 'wait_cycles', 3);
      const cancel = num(values, 'cancel_cycles', 3);
      const type = Number(str(values, 'alert_type', '16'));
      const subType = Number(str(values, 'alert_subtype', '19'));
      const recommendation = str(values, 'recommendation', '');
      const base = slugOf(name || alertName, 'alert');
      const rising = operator.startsWith('GT');

      const findings: Finding[] = [];
      if (metric.unit === '%' && (warnAt > 100 || critAt > 100)) {
        findings.push(error('vcfops.alert.over-100', `${metric.label} is a percentage, and a threshold above 100 can never be reached.`, { source: SRC }));
      }
      if (rising ? critAt <= warnAt : critAt >= warnAt) {
        findings.push(
          error('vcfops.alert.inverted', `The critical threshold (${critAt}) is not beyond the warning threshold (${warnAt}) in the direction of the test.`, {
            remediation: rising ? 'For an "is above" test, critical must be higher than warning.' : 'For an "is below" test, critical must be lower than warning.',
            source: SRC,
          }),
        );
      }
      if (wait === 1) {
        findings.push(
          warning('vcfops.alert.one-cycle', 'A single collection cycle raises this on one five-minute spike.', {
            remediation: 'Most metrics worth alerting on are only a problem when they are sustained. Three cycles is fifteen minutes and filters almost every transient.',
            source: SRC,
          }),
        );
      }
      if (!recommendation.trim()) {
        findings.push(
          warning('vcfops.alert.no-recommendation', 'This alert tells somebody something is wrong and not what to do about it.', {
            remediation: 'The recommendation is what turns an alert into an action. Write the first thing an engineer would check.',
            source: SRC,
          }),
        );
      }

      const symptom = (severity: 'WARNING' | 'CRITICAL', value: number) => ({
        name: `${alertName} — ${metric.label} ${OPERATORS.find((o) => o.value === operator)?.label ?? operator} ${value}${metric.unit === '%' ? '%' : ` ${metric.unit}`} (${severity.toLowerCase()})`,
        adapterKindKey: 'VMWARE',
        resourceKindKey: metric.kind,
        waitCycles: wait,
        cancelCycles: cancel,
        state: {
          severity,
          condition: {
            type: 'CONDITION_HT',
            key: metric.key,
            operator,
            value,
            valueType: 'NUMERIC',
            instanced: false,
            thresholdType: 'STATIC',
          },
        },
      });

      const alert = {
        name: alertName,
        description: `Generated by ArchToolKit. Raised when ${metric.label} ${OPERATORS.find((o) => o.value === operator)?.label ?? operator} ${warnAt} (warning) or ${critAt} (critical) for ${wait} cycles.`,
        adapterKindKey: 'VMWARE',
        resourceKindKey: metric.kind,
        waitCycles: 1,
        cancelCycles: 1,
        type,
        subType,
        states: [
          {
            severity: 'AUTO',
            'base-symptom-set': {
              type: 'SYMPTOM_SET',
              relation: 'SELF',
              aggregation: 'ALL',
              symptomSetOperator: 'OR',
              symptomDefinitionIds: ['__WARNING_SYMPTOM_ID__', '__CRITICAL_SYMPTOM_ID__'],
            },
            // The three badges an alert can affect: HEALTH, RISK, EFFICIENCY.
            impact: { impactType: 'BADGE', detail: subType === 20 ? 'EFFICIENCY' : subType === 21 || subType === 22 ? 'RISK' : 'HEALTH' },
            ...(recommendation.trim() ? { recommendationPriorityMap: { __RECOMMENDATION_ID__: 1 } } : {}),
          },
        ],
      };

      // The same three objects as Alerts → Alert Definitions → Import takes them.
      const ids = {
        warn: `SymptomDefinition-${stableId(`symptom:${alertName}:warning`)}`,
        crit: `SymptomDefinition-${stableId(`symptom:${alertName}:critical`)}`,
        alert: `AlertDefinition-${stableId(`alert:${alertName}`)}`,
        rec: `Recommendation-ud-${stableId(`recommendation:${alertName}`)}`,
      };
      const xmlSymptom = (id: string, severity: 'WARNING' | 'CRITICAL', value: number) => {
        const json = symptom(severity, value);
        return { id, name: json.name, adapterKind: 'VMWARE', resourceKind: metric.kind, severity: severity === 'WARNING' ? ('warning' as const) : ('critical' as const), waitCycle: wait, cancelCycle: cancel, key: metric.key, operator: XML_OPERATOR[operator] ?? '>', value };
      };
      const content: AlertContent = {
        alerts: [
          {
            id: ids.alert,
            name: alertName,
            description: alert.description,
            adapterKind: 'VMWARE',
            resourceKind: metric.kind,
            type,
            subType,
            impact: subType === 20 ? 'efficiency' : subType === 21 || subType === 22 ? 'risk' : 'health',
            symptomOperator: 'or',
            symptomRefs: [ids.warn, ids.crit],
            recommendationRefs: recommendation.trim() ? [ids.rec] : [],
          },
        ],
        symptoms: [xmlSymptom(ids.warn, 'WARNING', warnAt), xmlSymptom(ids.crit, 'CRITICAL', critAt)],
        recommendations: recommendation.trim() ? [{ key: ids.rec, description: recommendation }] : [],
      };

      const apply = [
        '#!/usr/bin/env bash',
        `# Create "${alertName}" in VCF Operations: two symptoms, a recommendation,`,
        '# and the alert that refers to all three. Order matters — each step needs',
        '# the id the previous one returned, which is why this is one script.',
        '#',
        '# Without --execute it only prints what it would send. It reads the payloads',
        '# beside it, in scripts/.',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        ...authPreamble('vcf-operations'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        'DRY_RUN=1',
        '[[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
        '',
        'post() {',
        '  curl -sS -f -X POST "https://${VCFOPS_HOST}/suite-api/api/$1" \\',
        `    -H "${authHeader('vcf-operations')}" \\`,
        '    -H "Accept: application/json" -H "Content-Type: application/json" \\',
        '    --data-binary @-',
        '}',
        '# The id of what was created, or stop: a missing id is not a success, and',
        '# the next step would otherwise refer to "null".',
        'created() {',
        '  local kind="$1" file="$2" id',
        '  id=$(post "$kind" < "$file" | jq -r \'.id // empty\')',
        '  [[ -n "$id" ]] || { echo "POST $kind returned no id; see created-ids.txt for what exists so far." >&2; return 1; }',
        '  echo "$id"',
        '}',
        '',
        'if (( DRY_RUN )); then',
        `  echo "DRY RUN: would create 2 symptoms${recommendation.trim() ? ', 1 recommendation' : ''} and the alert in ${base}-alert.json"`,
        '  echo "Nothing was changed. Re-run with --execute."',
        '  exit 0',
        'fi',
        '',
        ': > created-ids.txt',
        `WARN_ID=$(created symptomdefinitions ${base}-symptom-warning.json)`,
        'echo "warning symptom   $WARN_ID" | tee -a created-ids.txt',
        `CRIT_ID=$(created symptomdefinitions ${base}-symptom-critical.json)`,
        'echo "critical symptom  $CRIT_ID" | tee -a created-ids.txt',
        ...(recommendation.trim()
          ? [`REC_ID=$(created recommendations ${base}-recommendation.json)`, 'echo "recommendation    $REC_ID" | tee -a created-ids.txt']
          : ['REC_ID=""']),
        '',
        `sed -e "s/__WARNING_SYMPTOM_ID__/$WARN_ID/" -e "s/__CRITICAL_SYMPTOM_ID__/$CRIT_ID/" -e "s/__RECOMMENDATION_ID__/$REC_ID/" ${base}-alert.json > created-alert.json`,
        'ALERT_ID=$(created alertdefinitions created-alert.json)',
        'echo "alert definition  $ALERT_ID" | tee -a created-ids.txt',
        'echo "Ids written to created-ids.txt. The alert is not enabled in any policy yet — see the README."',
        '',
      ].join('\n');

      const hasRecommendation = Boolean(recommendation.trim());
      const pkg = toPackage({
        packageName: packageNameOf('vcfops', 'alert', base),
        description: `Creates the VCF Operations alert "${alertName}" with its two symptoms${hasRecommendation ? ' and its recommendation' : ''}, in order, idempotently. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations/${base}`,
        workflow: {
          name: `Create alert ${base}`,
          description: `Creates in VCF Operations the symptoms${hasRecommendation ? ', the recommendation' : ''} and the alert definition "${alertName}", each id passed to the next. What already exists (by name; the recommendation by its text) is left as it is. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be created and change nothing' }],
          outputs: [
            { name: 'alertDefinitionId', type: 'string', description: 'The alert definition id, empty in a dry run' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: alertDefinitionWorkflow(metric.kind, hasRecommendation),
        },
        config: {
          name: 'Settings',
          description: `Settings of the Create alert ${base} workflow. Fill opsPassword after import; set dryRun to false only after a dry run.`,
          attributes: [
            { name: 'opsHost', type: 'string', value: '', description: 'VCF Operations host (FQDN)' },
            { name: 'opsUsername', type: 'string', value: '', description: 'An account that may create alert content' },
            { name: 'opsPassword', type: 'SecureString', description: 'Its password' },
            { name: 'opsAuthSource', type: 'string', value: '', description: 'Authentication source for the account; empty for a local account' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is created while this is true' },
            { name: 'cap', type: 'number', value: hasRecommendation ? 4 : 3, description: 'The most objects one run may create' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [
          { name: 'symptom-warning.json', content: `${JSON.stringify(symptom('WARNING', warnAt), null, 2)}\n` },
          { name: 'symptom-critical.json', content: `${JSON.stringify(symptom('CRITICAL', critAt), null, 2)}\n` },
          ...(hasRecommendation ? [{ name: 'recommendation.json', content: `${JSON.stringify({ description: recommendation }, null, 2)}\n` }] : []),
          { name: 'alert.json', content: `${JSON.stringify(alert, null, 2)}\n` },
        ],
      });

      return {
        platform: PLATFORM,
        title: `${alertName} — ${metric.label} on ${KINDS[metric.kind]?.label.toLowerCase() ?? metric.kind}`,
        // Creating content is a change, even if the alert itself only reports.
        effect: 'reversible',
        trigger: {
          kind: 'alert',
          detail: `${metric.label} ${OPERATORS.find((o) => o.value === operator)?.label ?? operator} ${warnAt} for ${wait} collection cycles (critical at ${critAt})`,
          worstCase: `once per ${KINDS[metric.kind]?.label.toLowerCase() ?? 'object'} while the condition holds — on a busy cluster, that is every host at once`,
        },
        scope: {
          what: `Every ${KINDS[metric.kind]?.label.toLowerCase() ?? metric.kind} where the alert is enabled by policy.`,
          decidedBy: [
            `Object kind: ${metric.kind}.`,
            'Which policies enable the alert — it is created enabled in the default policy only if your default policy enables new content.',
            'Which custom groups those policies are assigned to.',
            'The notification rules that match it, which decide whether anybody hears.',
          ],
          ifWrong: 'An alert raised across the whole estate for a threshold tuned for one cluster. Nothing breaks; people learn to ignore the alert, which is worse.',
        },
        guardrails: [
          { rule: `Sustained for ${wait} cycles before it is raised`, because: 'Every metric spikes. An alert on a spike is an alert people mute.' },
          { rule: 'Warning and critical are separate symptoms', because: 'One alert that escalates is read; two alerts for the same thing are deduplicated by hand at 3am.' },
          ...(recommendation.trim() ? [{ rule: 'Carries a recommendation', because: 'The person receiving it knows the first thing to check without opening a runbook.' }] : []),
        ],
        dryRun: [
          `Run the workflow Create alert ${base} with dryRun = true (the configuration element keeps it a dry run until its dryRun is set to false). The log lists every "DRY RUN: would create …". The fallback scripts/apply.sh does the same without --execute.`,
          `Before enabling it anywhere, open a ${metric.kind} in the interface, chart ${metric.key} over the last 30 days, and count how often it crossed ${warnAt}. That is how often this will fire.`,
        ],
        undo: [
          'DELETE /suite-api/api/alertdefinitions/{id}, then the symptoms and the recommendation, using the ids in the workflow\'s AUDIT log lines and summary output (scripts/created-ids.txt with the script).',
          'Delete the alert first: a symptom that an alert still refers to cannot be deleted.',
        ],
        told: ['Nobody until a notification rule matches it. Pair it with "Send an alert to a webhook" in this kit, filtered to this alert id.'],
        requires: ['VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Operations certificate trusted in Orchestrator — or, for the fallback script, jq on the machine running it.', 'A policy to enable it in — see "Turn alert definitions on or off in a policy".'],
        files: {
          ...pkg.files,
          [`scripts/${base}-symptom-warning.json`]: `${JSON.stringify(symptom('WARNING', warnAt), null, 2)}\n`,
          [`scripts/${base}-symptom-critical.json`]: `${JSON.stringify(symptom('CRITICAL', critAt), null, 2)}\n`,
          ...(recommendation.trim() ? { [`scripts/${base}-recommendation.json`]: `${JSON.stringify({ description: recommendation }, null, 2)}\n` } : {}),
          [`scripts/${base}-alert.json`]: `${JSON.stringify(alert, null, 2)}\n`,
          'scripts/apply.sh': apply,
          'import/alert-definitions.xml': alertContentXml(content),
          ...contentPackage(
            {
              'alertdefs.xml': alertContentXml(content, 'alerts'),
              'symptomdefs.xml': alertContentXml(content, 'symptoms'),
              ...(content.recommendations.length > 0 ? { 'recommendationdefs.xml': alertContentXml(content, 'recommendations') } : {}),
            },
            { alertDefinitions: 1, symptomDefinitions: 2, recommendationDefinitions: content.recommendations.length },
          ),
          'import-content.sh': contentImportScript({ what: `the alert "${alertName}" with its symptoms${recommendation.trim() ? ' and recommendation' : ''}`, contentType: 'ALERT_DEFINITIONS', needles: [ids.alert, `name="${alertName.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`] }),
          'IMPORT.md': importMd({
            title: `the alert "${alertName}"`,
            steps: [
              // The Orchestrator package first: one unit that creates all of it, in order.
              ...pkg.importSteps.map((step, index) => ({
                heading: index === 0 ? `${step.heading} — the workflow that creates the alert` : step.heading,
                files: index === 0 ? [pkg.packageDir, 'import/com.archtoolkit.core.package'] : [],
                how: step.lines.filter((line) => line.trim() !== '').map((line) => line.replace(/^- /, '')),
              })),
              {
                heading: 'Or: the alert, its symptoms and its recommendation — one file',
                files: ['import/alert-definitions.xml'],
                how: [
                  'Alerts → Configure → Alert Definitions → ⋯ → Import (8.x: Configure → Alerts → Alert Definitions → Import), and choose import/alert-definitions.xml. The symptoms and the recommendation it refers to are in the same file and are created with it.',
                  `Ids in the file are fixed (${ids.alert}), so importing it again with "Overwrite" replaces this alert and nothing else.`,
                ],
              },
              {
                heading: 'Or by the REST API',
                files: [`scripts/${base}-symptom-warning.json`, `scripts/${base}-symptom-critical.json`, ...(recommendation.trim() ? [`scripts/${base}-recommendation.json`] : []), `scripts/${base}-alert.json`, 'scripts/apply.sh'],
                how: ['./scripts/apply.sh --execute creates the symptoms, the recommendation and then the alert, in that order, through /suite-api/api/symptomdefinitions, /recommendations and /alertdefinitions. The API assigns its own ids.'],
              },
              contentStep('ALERT_DEFINITIONS'),
              {
                heading: 'Then enable it in a policy',
                files: [],
                how: ['An imported alert definition is enabled only where a policy enables it. Use "Turn alert definitions on or off in a policy" in this kit with the id above, or Policies → edit → Alerts and Symptoms.'],
              },
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          `Metric key ${metric.key} is the VMware adapter’s. If an object shows it under a different key in your version, open the object’s metric picker and copy the key from there.`,
          'The type and subtype decide where the alert is filed and which badge it affects. They do not change when it fires.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_alert_action',
    platform: PLATFORM,
    label: 'Act on an alert automatically',
    group: 'Alerts',
    description:
      'The step from "it tells somebody" to "it fixes it": a recommendation with an action behind it, and the policy setting that lets VCF Operations run that action without asking. Scoped to a group built for the purpose, because automating an action in a policy applies it to every object that policy covers.',
    inputs: [
      { id: 'alert_id', label: 'Alert definition id', control: 'text', default: 'AlertDefinition-VMWARE-VMSnapshotsOld', hint: 'The alert whose recommendation this action is attached to' },
      {
        id: 'action',
        label: 'Action',
        control: 'select',
        options: [
          { value: 'DeleteUnusedSnapshotsForVM', label: 'Delete unused snapshots for VM', group: 'Virtual machine' },
          { value: 'PowerOffVM', label: 'Power off VM', group: 'Virtual machine' },
          { value: 'SetCPUCountForVM', label: 'Set CPU count for VM', group: 'Virtual machine' },
          { value: 'SetMemoryForVM', label: 'Set memory for VM', group: 'Virtual machine' },
          { value: 'MoveVM', label: 'Move VM', group: 'Virtual machine' },
          { value: 'RebalanceContainer', label: 'Rebalance container', group: 'Cluster' },
        ],
        default: 'DeleteUnusedSnapshotsForVM',
      },
      { id: 'policy_name', label: 'Automate it in policy', control: 'text', default: 'Automation — non-production' },
      { id: 'group_name', label: 'That policy covers the group', control: 'text', default: 'Automation — safe to act on' },
      { id: 'snapshot_age', label: 'Snapshots older than (days)', control: 'number', default: 14, min: 1, max: 365, showWhen: { input: 'action', equals: ['DeleteUnusedSnapshotsForVM'] } },
      { id: 'change_ticket', label: 'Require a change ticket before the policy is changed', control: 'toggle', default: true },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const alertId = str(values, 'alert_id', '');
      const action = str(values, 'action', 'DeleteUnusedSnapshotsForVM');
      const policy = str(values, 'policy_name', 'Automation');
      const group = str(values, 'group_name', '');
      const age = num(values, 'snapshot_age', 14);
      const ticket = bool(values, 'change_ticket', true);
      const base = slugOf(name || `${action}-automation`, 'alert-action');

      const irreversible = action === 'DeleteUnusedSnapshotsForVM';
      const disruptive = action === 'PowerOffVM' || action.startsWith('Set');
      const target = action === 'RebalanceContainer' ? 'ClusterComputeResource' : 'VirtualMachine';

      const findings: Finding[] = [];
      if (/default/i.test(policy) || !group.trim()) {
        findings.push(
          error('vcfops.action.default-policy', 'Automating an action in the default policy, or with no group, applies it to every object the policy covers.', {
            remediation: 'Create a policy for automation, assign it only to a group built for the purpose, and automate the action there.',
            source: SRC,
          }),
        );
      }
      if (irreversible && !ticket) {
        findings.push(
          warning('vcfops.action.no-change', 'An irreversible action is being automated with no change record.', {
            remediation: 'The policy change that turns automation on is the moment to record. After that it acts on its own.',
            source: SRC,
          }),
        );
      }
      if (action === 'PowerOffVM') {
        findings.push(
          warning('vcfops.action.power-off', 'Powering off a VM on an alert takes a service down on a metric.', {
            remediation: 'Reserve it for groups where that is the intended outcome — expired test environments, quarantined machines — and nowhere else.',
            source: SRC,
          }),
        );
      }

      // The recommendation's action as the 9.x reference writes it (POST
      // /api/recommendations): actionAdapterKindId, targetAdapterKindId,
      // targetResourceKindId, targetMethod. There is no actionId field.
      const recommendation = {
        description: `Run ${action} on the object that raised the alert. Automated in "${policy}" only.`,
        action: {
          actionAdapterKindId: '<REQUIRED — the actionAdapterKindKey of this action in GET /suite-api/api/actiondefinitions>',
          targetAdapterKindId: 'VMWARE',
          targetResourceKindId: target,
          targetMethod: action,
        },
      };
      const actionLabel = ACTION_LABELS[action] ?? action;
      const pkg = opsPackage({
        parts: ['alertaction', base],
        folder: base,
        description: `Creates the recommendation that runs ${action} and adds it to the alert definition ${alertId || '(set alertDefinitionId)'}, idempotently.`,
        workflowName: `Add action ${opsPart(base)}`,
        workflowDescription: `Looks up the action "${actionLabel}" in the action definitions, creates the recommendation that runs it (unless one with the same text exists) and adds it to the alert definition's recommendations. The automate flag stays a policy change made by a person.`,
        changes: true,
        cap: 2,
        outputs: [{ name: 'recommendationId', type: 'string', description: 'The recommendation id, empty in a dry run' }],
        account: 'An account that may create recommendations and edit alert definitions',
        settings: [
          { name: 'alertDefinitionId', type: 'string', value: alertId, description: 'The alert definition the recommendation is added to' },
          { name: 'actionName', type: 'string', value: actionLabel, description: 'The action, as GET /suite-api/api/actiondefinitions names it (displayName or id)' },
        ],
        resources: [{ name: 'recommendation.json', content: `${JSON.stringify({ description: recommendation.description, action: { targetAdapterKindId: 'VMWARE', targetResourceKindId: target, targetMethod: action } }, null, 2)}\n` }],
        body: ALERT_ACTION_BODY,
        after: String.raw`recommendationId = ctx.dryRun ? "" : (recId || "");
summary = core.audit(ctx, { recommendationId: recommendationId, alertDefinitionId: settings.alertDefinitionId, next: "Set automate on this alert in the dedicated policy: scripts/merge-policy.sh, or the policy editor. There is no REST call for the automate flag." });
core.notify(settings.webhook, summary);`,
      });

      const policyXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- Merge this into an export of the policy, not over it. The export is the undo. -->',
        '<PolicyContent>',
        '    <Policies>',
        `        <Policy name="${policy}" key="&lt;REQUIRED — the policy id&gt;">`,
        '            <PackageSettings>',
        `                <Alerts adapterKind="VMWARE" resourceKind="${target}">`,
        `                    <Alert id="${alertId || '&lt;REQUIRED&gt;'}" enabled="true" automate="true"/>`,
        '                </Alerts>',
        '            </PackageSettings>',
        '        </Policy>',
        '    </Policies>',
        '</PolicyContent>',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${action} automatically when ${alertId || 'the alert'} is raised`,
        effect: irreversible ? 'irreversible' : 'reversible',
        trigger: { kind: 'alert', detail: `${alertId || 'the alert'} raised on a ${target === 'VirtualMachine' ? 'VM' : 'cluster'} covered by "${policy}"`, worstCase: `once per object in "${group || 'every group on the policy'}" — all at once, if the alert fires across the group` },
        scope: {
          what: `${target === 'VirtualMachine' ? 'VMs' : 'Clusters'} in the group "${group || '(none set)'}" on which ${alertId || 'the alert'} is raised.`,
          decidedBy: [
            `The policy "${policy}" — the automate flag is set there and nowhere else.`,
            `The group "${group || '(none)'}", which is what the policy is assigned to.`,
            'Policy priority: if a higher-priority policy covers the same object without automation, it wins and nothing is automated.',
            `The alert’s own symptoms${action === 'DeleteUnusedSnapshotsForVM' ? `, and a snapshot age above ${age} days` : ''}.`,
          ],
          ifWrong: irreversible
            ? 'Snapshots are deleted on objects nobody meant to include, and those snapshots may have been somebody’s rollback plan.'
            : disruptive
              ? 'VMs are powered off or resized on the strength of a metric, and the first anybody hears is the outage.'
              : 'Objects are moved or rebalanced unexpectedly. Recoverable, but noticed.',
        },
        guardrails: [
          { rule: 'Automated in a dedicated policy only', because: 'The automate flag applies to everything the policy covers. A dedicated policy on a dedicated group is the only way to bound that.' },
          { rule: `Only objects in "${group || '(none)'}"`, because: 'The group is built with an exclusion tag — see "A custom group to scope automation".' },
          ...(ticket ? [{ rule: 'A change ticket before the policy change', because: 'The policy edit is the last moment a human is involved. Record it.' }] : []),
          { rule: 'Run the action by hand from the alert first', because: 'Running it once from the recommendation shows exactly what it does, on one object, while someone is watching.' },
        ],
        dryRun: [
          `Run the workflow Add action ${opsPart(base)} with dryRun = true: it looks up the alert and the action and logs the recommendation it would create and the alert it would add it to. Nothing changes until dryRun is false in its configuration element.`,
          'Leave automate off. Let the alert fire for a week and run the recommendation by hand from the alert each time.',
          'Count how many objects it would have acted on. If that surprises you, the group is wrong.',
        ],
        undo: irreversible
          ? ['A deleted snapshot cannot be restored. Turning automation off stops the next one; it does not bring back the last.', 'Set automate="false" in the policy, or re-import the export taken before the change.']
          : ['Set automate="false" in the policy, or re-import the export taken before the change.', 'Objects already changed are put back by hand, using the Automated Actions history.'],
        told: ['Every automated run appears under Administration → History → Recent Tasks, with the object and the result.', 'Wire the alert to a webhook as well, so a person sees it acted rather than only that it fired.'],
        requires: ['Actions enabled on the vCenter adapter, with a credential that has exactly the rights this action needs.', `The policy "${policy}" and the group "${group}".`, OPS_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          [`scripts/${base}-recommendation.json`]: `${JSON.stringify(recommendation, null, 2)}\n`,
          [`scripts/${base}-policy-automate.xml`]: policyXml,
          'scripts/apply.sh': inScripts(applyScript('vcf-operations', [{ method: 'POST', path: '/suite-api/api/recommendations', payload: `${base}-recommendation.json` }], 'DELETE /suite-api/api/recommendations/{id}; set automate="false" in the policy.')),
          'scripts/merge-policy.sh': policyMergeScript(`${base}-policy-automate.xml`, policy),
          'IMPORT.md': importMd({
            title: `automating ${action} for ${alertId || 'the alert'}`,
            steps: [
              ...packageSteps(pkg, 'the workflow that creates the recommendation and adds it to the alert'),
              {
                heading: 'Or: the recommendation by the fallback script',
                files: [`scripts/${base}-recommendation.json`, 'scripts/apply.sh'],
                how: [
                  'Fill in actionAdapterKindId (the actionAdapterKindKey of the action in GET /suite-api/api/actiondefinitions), then ./scripts/apply.sh --execute — POST /suite-api/api/recommendations. It does not add the recommendation to the alert: do that in the alert definition editor, or with the workflow.',
                  'In the interface: Alerts → Configure → Recommendations → Add, with the action selected. There is no file import for a recommendation on its own.',
                ],
                verify: [
                  `targetMethod "${action}": the 9.x reference documents targetMethod but not the values each adapter takes; the workflow takes actionAdapterKindId from the action definition named "${actionLabel}", and targetMethod as written here. Compare with GET /suite-api/api/recommendations for a recommendation made in the interface with the same action.`,
                  'adding the recommendation to a built-in (VMware-supplied) alert definition with PUT /suite-api/api/alertdefinitions: if your release refuses to edit it, add the recommendation in the alert definition editor, or copy the alert definition first.',
                ],
              },
              {
                heading: 'The automate flag, merged into the policy — by a person',
                files: [`scripts/${base}-policy-automate.xml`, 'scripts/merge-policy.sh'],
                how: [
                  `${base}-policy-automate.xml is the change, not a policy to import: a policy file holds all of a policy's overrides, so importing this one would drop every other override "${policy}" has. The 9.x API has no call for the automate flag (PUT /api/alertdefinitions/{id}/enable turns an alert on in a policy, not its automation), so this stays a reviewed policy change.`,
                  `POLICY_ID=<id of "${policy}"> ./scripts/merge-policy.sh exports the policy (the export is kept as the undo), sets these <Alert> attributes in it, and writes scripts/import/policy-merged.zip. With --execute it imports that zip: POST /suite-api/api/policies/import?forceImport=true.`,
                  'Or import scripts/import/policy-merged.zip yourself: Configure → Policies → ⋯ → Import (8.x: Administration → Policies → Policy Library → Import).',
                ],
                verify: ['the automate attribute name, against an export of your own policy: the merge copies the attribute names as written here.'],
              },
            ],
            sources: [...FORMAT_SOURCES, 'VCF Operations API 9.x, POST /api/recommendations and PUT /api/alertdefinitions: https://developer.broadcom.com/xapis/vcf-operations-api/latest/'],
          }),
        },
        notes: [
          'The automate attribute is set on the alert inside the policy, not on the alert definition. The same alert can be automated in one policy and only reported in another — that is the mechanism for scoping it.',
          'Check the attribute name against an export of your own policy before importing: it is written by the interface and its spelling has changed between releases.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_super_metric',
    platform: PLATFORM,
    label: 'A super metric',
    group: 'Metrics',
    description:
      'A metric that does not exist until you compute it: the worst CPU ready of any VM in a cluster, the number of powered-off VMs per host, free space across a datastore cluster. Written with the depth kept small, because a super metric is evaluated every cycle for every object it is enabled on.',
    inputs: [
      { id: 'metric_name', label: 'Name', control: 'text', default: 'Cluster — worst VM CPU ready %' },
      {
        id: 'preset',
        label: 'Computes',
        control: 'select',
        options: [
          { value: 'max-vm-ready', label: 'Worst VM CPU ready % in a cluster' },
          { value: 'avg-vm-ready', label: 'Average VM CPU ready % in a cluster' },
          { value: 'poweredoff-per-host', label: 'Powered-off VMs per host' },
          { value: 'ds-free-sum', label: 'Free space across datastores in a cluster (GB)' },
          { value: 'vcpu-ratio', label: 'vCPU to physical core ratio of a cluster' },
          { value: 'custom', label: 'My own formula' },
        ],
        default: 'max-vm-ready',
      },
      { id: 'formula', label: 'Formula', control: 'textarea', default: '', hint: 'Only used for "My own formula"', showWhen: { input: 'preset', equals: ['custom'] } },
      { id: 'unit', label: 'Unit', control: 'text', default: 'percent' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const metricName = str(values, 'metric_name', 'Super metric');
      const preset = str(values, 'preset', 'max-vm-ready');
      const custom = str(values, 'formula', '');
      const unit = str(values, 'unit', '');
      const base = slugOf(name || metricName, 'super-metric');

      const PRESETS: Record<string, { formula: string; on: string; about: string }> = {
        'max-vm-ready': { formula: 'max(${adaptertype=VMWARE, objecttype=VirtualMachine, metric=cpu|readyPct, depth=2})', on: 'ClusterComputeResource', about: 'The worst VM, not the average one — the average hides the VM that is actually suffering.' },
        'avg-vm-ready': { formula: 'avg(${adaptertype=VMWARE, objecttype=VirtualMachine, metric=cpu|readyPct, depth=2})', on: 'ClusterComputeResource', about: 'Useful as a trend line. Alert on the max, chart the average.' },
        'poweredoff-per-host': { formula: 'count(${adaptertype=VMWARE, objecttype=VirtualMachine, metric=sys|poweredOn, depth=1, where=($value==0)})', on: 'HostSystem', about: 'A cheap reclamation indicator, per host.' },
        'ds-free-sum': { formula: 'sum(${adaptertype=VMWARE, objecttype=Datastore, metric=capacity|available_space, depth=1})', on: 'ClusterComputeResource', about: 'Free space the cluster can actually reach, across its datastores.' },
        'vcpu-ratio': { formula: '${this, metric=summary|number_running_vcpus} / ${this, metric=cpu|corecount_provisioned}', on: 'ClusterComputeResource', about: 'The consolidation ratio. Watch the trend, not the number.' },
      };
      const chosen = preset === 'custom' ? { formula: custom, on: '<REQUIRED — the object type to enable it on>', about: 'Your own formula.' } : PRESETS[preset] ?? PRESETS['max-vm-ready']!;

      const findings: Finding[] = [];
      if (!chosen.formula.trim()) {
        findings.push(error('vcfops.supermetric.empty', 'There is no formula.', { source: SRC }));
      }
      const depths = [...chosen.formula.matchAll(/depth\s*=\s*(-?\d+)/g)].map((m) => Number(m[1]));
      if (depths.some((depth) => depth > 3 || depth < 0)) {
        findings.push(
          warning('vcfops.supermetric.deep', 'This formula walks more than three levels of relationships.', {
            remediation: 'It is evaluated every collection cycle for every object it is enabled on. Enable it on the level you need rather than reaching down from the top.',
            source: SRC,
          }),
        );
      }
      if (/\$\{adaptertype=[^}]*\}/.test(chosen.formula) && !/depth\s*=/.test(chosen.formula)) {
        findings.push(warning('vcfops.supermetric.no-depth', 'A resource entry with no depth defaults to one level, which may not be what you meant.', { source: SRC }));
      }

      // The 9.x reference for POST /api/supermetrics takes name, formula and
      // description; the unit is carried only by the export (import/supermetric.json).
      const payload = {
        name: metricName,
        formula: chosen.formula,
        description: `Generated by ArchToolKit. ${chosen.about}`,
      };
      // SuperMetric.json, as Super Metrics → Export writes it: keyed by id.
      const smId = stableId(`supermetric:${metricName}`);
      const known = preset !== 'custom';
      const exportJson = superMetricsJson([
        { id: smId, name: metricName, formula: chosen.formula, description: payload.description, unitId: unit, resourceKinds: known ? [{ adapterKindKey: 'VMWARE', resourceKindKey: chosen.on }] : [] },
      ]);

      const pkg = opsPackage({
        parts: ['supermetric', base],
        folder: base,
        description: `Creates the super metric "${metricName}" in VCF Operations, once.`,
        workflowName: `Create super metric ${opsPart(base)}`,
        workflowDescription: `Creates the super metric "${metricName}" unless one of that name exists, which is left as it is (a different formula is reported, not overwritten).`,
        changes: true,
        cap: 1,
        outputs: [{ name: 'superMetricId', type: 'string', description: 'The super metric id, empty in a dry run' }],
        account: 'An account that may create super metrics',
        settings: [],
        resources: [{ name: 'supermetric.json', content: `${JSON.stringify(payload, null, 2)}\n` }],
        body: String.raw`var metric = JSON.parse(core.resource(RESOURCE_PATH, "supermetric.json"));
if (!metric.formula) throw new Error("The super metric has no formula.");
var existing = named(listAll("supermetrics?name=" + q(metric.name), "superMetrics"), metric.name);
var smId = null;
if (existing) {
  smId = String(existing.id);
  System.log("Exists, left as it is: super metric \"" + metric.name + "\" (" + smId + ")");
  if (existing.formula !== undefined && String(existing.formula) !== String(metric.formula)) System.warn("Its formula is not this package's: " + existing.formula + ". Edit it in the super metric editor if this one is meant.");
} else {
  smId = core.act(ctx, "create super metric \"" + metric.name + "\"", function () {
    var r = ops("POST", "supermetrics", metric, null, null);
    if (!r.body || !r.body.id) throw new Error("POST supermetrics returned no id.");
    return String(r.body.id);
  });
}`,
        after: String.raw`superMetricId = ctx.dryRun ? "" : (smId || "");
summary = core.audit(ctx, { superMetricId: superMetricId, note: "It computes nothing until it is assigned to an object type and enabled in a policy." });
core.notify(settings.webhook, summary);`,
      });

      return {
        platform: PLATFORM,
        title: `${metricName} — a super metric on ${chosen.on}`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: 'Every collection cycle, once enabled in a policy', worstCase: 'every five minutes, for every object of the type it is enabled on' },
        scope: {
          what: `Objects of type ${chosen.on} covered by a policy that enables it.`,
          decidedBy: ['The object type it is assigned to.', 'The policies that enable it — a super metric that is created but enabled nowhere computes nothing.'],
          ifWrong: 'Nothing is changed. The cost is load on the cluster, and a number nobody checked being used in a capacity decision.',
        },
        guardrails: [{ rule: 'Depth kept to the level it needs', because: 'Super metric cost grows with every object it reaches. A formula from the vCenter down is evaluated across the whole inventory.' }],
        dryRun: [
          'Paste the formula into the super metric editor and use Preview against one object. The preview is the dry run, and it shows the last week’s values.',
          `Then run the workflow Create super metric ${opsPart(base)} with dryRun = true: it logs whether it would create the super metric or finds it already there.`,
        ],
        undo: ['DELETE /suite-api/api/supermetrics/{id}. Its history goes with it.'],
        told: ['Nobody — it is a metric. Alert on it with "An alert, with its symptoms and a recommendation" if it needs watching.'],
        requires: ['Nothing beyond the VMware adapter collecting the metrics the formula reads.', OPS_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          [`scripts/${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'scripts/apply.sh': inScripts(applyScript('vcf-operations', [{ method: 'POST', path: '/suite-api/api/supermetrics', payload: `${base}.json` }], 'DELETE /suite-api/api/supermetrics/{id}.')),
          'import/supermetric.json': exportJson,
          ...contentPackage({ 'supermetrics.json': exportJson }, { superMetrics: 1 }),
          'import-content.sh': contentImportScript({ what: `the super metric "${metricName}"`, contentType: 'SUPER_METRICS', needles: [smId, `"name": ${JSON.stringify(metricName)}`, `"name":${JSON.stringify(metricName)}`] }),
          'IMPORT.md': importMd({
            title: `the super metric "${metricName}"`,
            steps: [
              ...packageSteps(pkg, 'the workflow that creates the super metric'),
              {
                heading: 'Or: the super metric as a file',
                files: ['import/supermetric.json'],
                how: [
                  'Configure → Super Metrics → ⋯ → Import (8.x: Administration → Configuration → Super Metrics → Import Super Metric), and choose import/supermetric.json. A super metric with the same name is skipped unless you choose to overwrite.',
                  known ? `It arrives assigned to ${chosen.on}, keyed by id ${smId}; its metric key is Super Metric|sm_${smId}.` : 'It arrives assigned to no object type: assign it under the super metric’s Object Types after import.',
                ],
              },
              {
                heading: 'Or by the fallback script',
                files: [`scripts/${base}.json`, 'scripts/apply.sh'],
                how: ['./scripts/apply.sh --execute — POST /suite-api/api/supermetrics. The API assigns its own id.'],
                verify: ['the unit: POST /api/supermetrics in the 9.x reference has no unit field, so the workflow and the script create the super metric without one; set it in the editor, or use import/supermetric.json, which carries it.', 'assigning the super metric to an object type: the 9.x API lists no call for it (GET, POST, PUT /api/supermetrics and DELETE, GET /api/supermetrics/{id} only), so after the workflow it is assigned in the editor, or arrives assigned with import/supermetric.json.'],
              },
              contentStep('SUPER_METRICS'),
              {
                heading: 'Then enable it in a policy',
                files: [],
                how: [`Policies → edit → Metrics and Properties → ${chosen.on === '<REQUIRED — the object type to enable it on>' ? 'the object type' : chosen.on} → the super metric → Enabled. Until then it computes nothing.`],
              },
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          `After creating it, assign it to ${chosen.on} and enable it in a policy under Metrics and Properties. Until then it exists and computes nothing.`,
          'A super metric only starts from the moment it is enabled. There is no backfill, so the first week of charts is empty — create it before you need it.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_workload_policy',
    platform: PLATFORM,
    label: 'A policy for a class of workload',
    group: 'Policy',
    description:
      'The Aria Ops page finds most custom groups on the default policy, which makes the group decorative. This writes the design of a policy for one class of workload — its parent, its priority, the thresholds that differ and why — plus the group assignment and the export that is its undo.',
    inputs: [
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'Tier 1 production' },
      { id: 'parent', label: 'Inherits from', control: 'text', default: 'Default Policy' },
      { id: 'groups', label: 'Applies to groups', control: 'text', default: 'Tier 1 VMs, Tier 1 hosts' },
      { id: 'priority', label: 'Priority', control: 'number', default: 1, min: 1, max: 100, hint: '1 is highest. A higher-priority policy wins outright where two cover the same object' },
      {
        id: 'capacity_model',
        label: 'Capacity based on',
        control: 'select',
        options: [
          { value: 'demand', label: 'Demand — what is used' },
          { value: 'allocation', label: 'Allocation — what is promised' },
        ],
        default: 'allocation',
      },
      { id: 'cpu_overcommit', label: 'CPU overcommit ratio (allocation model)', control: 'number', default: 4, min: 1, max: 20, showWhen: { input: 'capacity_model', equals: ['allocation'] } },
      { id: 'mem_overcommit', label: 'Memory overcommit ratio (allocation model)', control: 'number', default: 1, min: 1, max: 4, showWhen: { input: 'capacity_model', equals: ['allocation'] } },
      { id: 'buffer_pct', label: 'Capacity buffer %', control: 'number', default: 20, min: 0, max: 50 },
      { id: 'time_remaining_days', label: 'Warn when capacity runs out within (days)', control: 'number', default: 120, min: 30, max: 365 },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const policyName = str(values, 'policy_name', 'Workload policy');
      const parent = str(values, 'parent', 'Default Policy');
      const groups = listOf(str(values, 'groups', ''));
      const priority = num(values, 'priority', 1);
      const model = str(values, 'capacity_model', 'allocation');
      const cpuRatio = num(values, 'cpu_overcommit', 4);
      const memRatio = num(values, 'mem_overcommit', 1);
      const buffer = num(values, 'buffer_pct', 20);
      const days = num(values, 'time_remaining_days', 120);
      const base = slugOf(name || policyName, 'policy');

      const findings: Finding[] = [];
      if (groups.length === 0) {
        findings.push(error('vcfops.policy.unassigned', 'A policy assigned to no group applies to nothing.', { source: SRC }));
      }
      if (model === 'allocation' && memRatio > 1.5) {
        findings.push(
          warning('vcfops.policy.mem-overcommit', `A ${memRatio}:1 memory overcommit in the capacity model will plan for ballooning and swapping.`, {
            remediation: 'For production, plan memory at 1:1 and let the demand model show where the real headroom is.',
            source: SRC,
          }),
        );
      }
      if (buffer === 0) {
        findings.push(warning('vcfops.policy.no-buffer', 'With no buffer, capacity is reported as available right up to the moment a host failure makes it unavailable.', { remediation: 'The buffer should at least cover one host per cluster — N+1 is what HA already assumes.', source: SRC }));
      }

      const design = [
        `# ${policyName}`,
        '',
        'Generated by ArchToolKit. A policy is a set of differences from its parent;',
        'this lists only the differences, and the reason for each one.',
        '',
        '| Setting | Value | Why |',
        '|---|---|---|',
        `| Inherits from | ${parent} | Everything not listed here comes from the parent, and changes when it changes. |`,
        `| Priority | ${priority} | Where two policies cover the same object, the higher priority wins outright — they do not combine. |`,
        `| Applies to | ${groups.join(', ') || '(nothing)'} | The group is what makes the policy mean anything. |`,
        `| Capacity model | ${model} | ${model === 'allocation' ? 'Plans against what has been promised, which is what a production service can call on.' : 'Plans against what is used, which reclaims more and protects less.'} |`,
        ...(model === 'allocation' ? [`| CPU overcommit | ${cpuRatio}:1 | ${cpuRatio > 6 ? 'High for production; check CPU ready first.' : 'A common production ratio.'} |`, `| Memory overcommit | ${memRatio}:1 | ${memRatio > 1 ? 'Relies on memory reclamation under load.' : 'No reliance on ballooning or swap.'} |`] : []),
        `| Capacity buffer | ${buffer}% | Held back from what is reported as available. |`,
        `| Time-remaining warning | ${days} days | Long enough to buy and rack hardware, which is the only thing this warning is for. |`,
        '',
        '## Applying it',
        '',
        `1. Run scripts/export-parent.sh to save "${parent}" as it is now. That file is the reference, and the undo.`,
        `2. Run the Orchestrator workflow (or, in Configure → Policies, create "${policyName}" inheriting from "${parent}" and assign it to the groups listed). The workflow creates it and assigns the groups.`,
        '3. In the policy editor, set the values above and the priority.',
        '4. Export the new policy and commit it beside this file. From then on, changes to it are diffs.',
        '',
        'The policy editor is the reliable way to set capacity values; the export it produces is',
        'the reliable way to keep them. Writing policy XML by hand for capacity settings is',
        'possible and is not worth the risk of a silently ignored element.',
        '',
      ].join('\n');

      // The 9.x API creates a policy (POST /api/policies, name, description,
      // parentPolicy) and assigns it (PUT /api/policies/{id}/assign, groupIds).
      // Capacity values go through PATCH /api/policies/{id}/settings
      // (capacitySettings), whose fields the reference does not spell out, so
      // they stay with the policy editor rather than being guessed at.
      const folder = `workload-${opsPart(base)}`;
      const pkg = opsPackage({
        parts: ['workload', base],
        folder,
        description: `Creates "${policyName}" inheriting from "${parent}" and assigns it to ${groups.join(', ') || 'its groups'}.`,
        workflowName: `Create workload profile ${opsPart(base)}`,
        workflowDescription: `Creates "${policyName}" inheriting from "${parent}" unless it exists, then assigns it to the custom groups ${groups.join(', ')}. Its capacity values and priority are set in the editor, from the design.`,
        changes: true,
        cap: 2,
        outputs: [{ name: 'createdId', type: 'string', description: 'The id of the created (or existing) object, empty in a dry run' }],
        account: 'An account that may create and assign policies',
        settings: [],
        resources: [
          { name: 'definition.json', content: `${JSON.stringify({ name: policyName, description: `Generated by ArchToolKit. Capacity model ${model}, buffer ${buffer}%, time-remaining warning ${days} days${model === 'allocation' ? `, CPU ${cpuRatio}:1, memory ${memRatio}:1` : ''}.`, parent, groups, priority }, null, 2)}\n` },
        ],
        body: WORKLOAD_BODY,
        after: String.raw`createdId = ctx.dryRun ? "" : (targetId || "");
summary = core.audit(ctx, { id: createdId, groups: def.groups, next: "Set the capacity values and the priority in the editor, from the design; then export it and keep the export." });
core.notify(settings.webhook, summary);`,
      });

      return {
        platform: PLATFORM,
        title: `${policyName} — its own thresholds and capacity model for ${groups.join(', ') || 'no group yet'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once, as a change.' },
        scope: {
          what: `Every object in ${groups.join(', ') || '(no groups)'}, unless a higher-priority policy also covers it.`,
          decidedBy: ['The groups it is assigned to.', `Its priority (${priority}) against every other policy covering the same objects.`, `Everything not set here, inherited from "${parent}".`],
          ifWrong: 'Alerts and capacity figures change for objects you did not mean to include. The capacity report is what people buy hardware from, so a wrong model is an expensive mistake made slowly.',
        },
        guardrails: [
          { rule: 'Export the parent before creating this', because: 'The comparison and the undo are the same file.' },
          { rule: 'Only differences from the parent are set', because: 'A policy that restates every inherited value stops following its parent, and nobody notices which values froze.' },
        ],
        dryRun: [
          `Run the workflow Create workload profile ${opsPart(base)} with dryRun = true: it finds the parent and the groups and logs what it would create and assign.`,
          'After assigning it, open one object in each group and check Policy in its summary shows this policy — not a higher-priority one.',
        ],
        undo: ['Unassign the groups (PUT /suite-api/api/policies/{id}/unassign, or in the interface); they fall back to whichever policy covers them next. Deleting the policy does the same.'],
        told: ['Nobody. A policy change is silent, which is why it belongs in a change record.'],
        requires: [`The groups ${groups.join(', ') || '(none)'} to exist.`, OPS_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          [`${base}-design.md`]: design,
          'scripts/export-parent.sh': [
            '#!/usr/bin/env bash',
            `# Save "${parent}" as it is now, before a child policy is created from it.`,
            'set -euo pipefail',
            ...authPreamble('vcf-operations'),
            ': "${PARENT_POLICY_ID:?set PARENT_POLICY_ID — GET /suite-api/api/policies and match by name}"',
            '',
            'curl -sS -f "https://${VCFOPS_HOST}/suite-api/api/policies/export?id=${PARENT_POLICY_ID}" \\',
            `  -H "${authHeader('vcf-operations')}" \\`,
            '  -o "parent-policy-$(date +%Y%m%d).zip"',
            'echo "Saved. Commit it beside the design."',
            '',
          ].join('\n'),
          'IMPORT.md': importMd({
            title: `the policy "${policyName}"`,
            steps: [
              { heading: 'Save the parent', files: ['scripts/export-parent.sh'], how: [`PARENT_POLICY_ID=<id of "${parent}"> ./scripts/export-parent.sh — GET /suite-api/api/policies/export, a zip holding the policy XML. That zip is the undo, and re-imports under Policies → Import or POST /suite-api/api/policies/import?forceImport=true (multipart field policy). The workflow does not take it: Orchestrator's REST calls carry text, and the export is a zip.`] },
              ...packageSteps(pkg, 'the workflow that creates the policy and assigns its groups'),
              {
                heading: 'Set the values that differ, in the editor',
                files: [`${base}-design.md`],
                how: [
                  'The workflow creates the policy inheriting everything from its parent and assigns the groups (POST /suite-api/api/policies, PUT /suite-api/api/policies/{id}/assign). The capacity model, overcommit, buffer and time-remaining values in the design file are set in Configure → Policies → edit; the priority under Policies → Reorder (PUT /suite-api/api/policies/priorities takes the whole ordered list of active policies, so it is not changed from here).',
                  'Once it is right, export it (Policies → ⋯ → Export) and keep that zip with the design: from then on it is the importable form of this policy, for this instance and for the next one.',
                ],
                verify: ['PATCH /suite-api/api/policies/{id}/settings takes capacitySettings in 9.x, but the reference does not list its fields; set the capacity values in the editor rather than by a guessed body.'],
              },
            ],
            sources: [...FORMAT_SOURCES, 'VCF Operations API 9.x, Policies: https://developer.broadcom.com/xapis/vcf-operations-api/latest/policies/'],
          }),
        },
        notes: [
          'Policies do not combine. An object covered by two policies gets all of the higher-priority one and none of the other, which is the most common reason an alert "should" be firing and is not.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_compliance',
    platform: PLATFORM,
    label: 'Run a compliance benchmark and report the drift',
    group: 'Compliance',
    description:
      'Turns on a compliance benchmark for a group and sends a weekly list of what fails it. Reports only — the fixes belong in a change, not in an automation triggered by an auditor’s checklist.',
    inputs: [
      {
        id: 'benchmark',
        label: 'Benchmark',
        control: 'select',
        options: [
          // 9.1 Security Posture Management: the three benchmarks it ships with.
          { value: 'VCF 9.x Security Configuration Guide v1.0', label: 'VCF Security Configuration Guide (VCF 9.x SCG v1.0)', group: 'VCF 9.1 Security Posture Management' },
          { value: 'PCI DSS v4.0.1 for VCF 9 v1.0', label: 'PCI DSS v4.0.1 for VCF 9', group: 'VCF 9.1 Security Posture Management' },
          { value: 'VCF 9 General Controls v1.0', label: 'VCF 9 General Controls', group: 'VCF 9.1 Security Posture Management' },
          { value: 'vSphere Security Configuration Guide', label: 'vSphere Security Configuration Guide (8.x compliance pack)', group: 'VCF Operations 8.x' },
          { value: 'CIS', label: 'CIS benchmark (8.x compliance pack)', group: 'VCF Operations 8.x' },
          { value: 'DISA STIG', label: 'DISA STIG (8.x compliance pack)', group: 'VCF Operations 8.x' },
          { value: 'PCI DSS', label: 'PCI DSS (8.x compliance pack)', group: 'VCF Operations 8.x' },
          { value: 'HIPAA', label: 'HIPAA (8.x compliance pack)', group: 'VCF Operations 8.x' },
          { value: 'ISO 27001', label: 'ISO 27001 (8.x compliance pack)', group: 'VCF Operations 8.x' },
        ],
        default: 'VCF 9.x Security Configuration Guide v1.0',
      },
      { id: 'group_name', label: 'For group', control: 'text', default: 'Production hosts' },
      { id: 'policy_name', label: 'Enabled in policy', control: 'text', default: 'Tier 1 production' },
      { id: 'webhook', label: 'Weekly drift report to', control: 'text', default: 'https://runbooks.example.com/hooks/compliance' },
      { id: 'fail_on', label: 'Exit non-zero when more than (failing objects)', control: 'number', default: 0, min: 0, max: 100000 },
      { id: 'definition_regex', label: 'Benchmark alert definitions named like', control: 'text', default: '', hint: 'Regex on the compliance alert definition name. Empty uses the usual name for the chosen benchmark — VERIFY it under Alerts > Alert Definitions' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const benchmark = str(values, 'benchmark', 'VCF 9.x Security Configuration Guide v1.0');
      const group = str(values, 'group_name', '');
      const policy = str(values, 'policy_name', '');
      const webhook = str(values, 'webhook', '');
      const failOn = num(values, 'fail_on', 0);
      const base = slugOf(name || `${benchmark}-compliance`, 'compliance');
      // 9.1 Security Posture Management benchmarks ship with the platform; the 8.x
      // vSphere guide was built in; the rest are compliance packs to install.
      const spm = / for VCF 9 |VCF 9\.x |VCF 9 General/.test(benchmark);
      const pack = !spm && benchmark !== 'vSphere Security Configuration Guide';

      const findings: Finding[] = [];
      if (!str(values, 'definition_regex', '') && spm) {
        findings.push(
          warning('vcfops.compliance.spm-names', `The name pattern for ${benchmark}'s alert definitions is a guess: 9.1 does not document how Security Posture Management names them.`, {
            remediation: 'Open Alerts > Alert Definitions, filter on the benchmark, and set "Benchmark alert definitions named like" to match. The report stops (exit 2) rather than reporting "compliant" when nothing matches.',
            source: SRC,
          }),
        );
      }
      if (/default/i.test(policy)) {
        findings.push(
          warning('vcfops.compliance.default-policy', 'Enabling a benchmark in the default policy applies it to every object in the estate.', {
            remediation: 'A benchmark is a list of alerts. Across the whole estate that is thousands of them on the first day, most on things nobody intends to harden.',
            source: SRC,
          }),
        );
      }

      const defRx = str(values, 'definition_regex', '') || BENCHMARK_ALERT_RX[benchmark] || benchmark;
      const report = readScript('vcf-operations', `Weekly ${benchmark} drift report for "${group}".`, [
        `THRESHOLD=${failOn}`,
        `BENCH=${shq(benchmark)}`,
        `DEF_RX="\${DEF_RX:-${defRx.replace(/["$`\\]/g, '\\$&')}}"`,
        ': "${GROUP_ID:?set GROUP_ID — GET /suite-api/api/resources/groups?name=... and take its id}"',
        ...workDirLines(),
        ...PAGED_HELPERS,
        ...WEBHOOK_HELPER,
        'STAMP=$(date +%Y%m%d)',
        'OUT="compliance-$STAMP.json"',
        '',
        '# 1. This benchmark’s alert definitions: compliance (subType 21) definitions whose',
        '#    name matches DEF_RX. The API has no name filter, so every page is read and',
        '#    filtered here. VERIFY DEF_RX against the names under Alerts > Alert',
        '#    Definitions (compliance packs name them "<object> is violating <benchmark>").',
        'get_all /suite-api/api/alertdefinitions alertDefinitions "$WORK/defs.json" || exit 2',
        'jq --arg rx "$DEF_RX" \'[.[] | select(.subType == 21 and ((.name // "") | test($rx; "i"))) | {id, name}]\' "$WORK/defs.json" > "$WORK/bench-defs.json"',
        'ND=$(jq length "$WORK/bench-defs.json")',
        'echo "$ND alert definition(s) for $BENCH (name matches /$DEF_RX/):"',
        'jq -r \'.[].name | "  " + .\' "$WORK/bench-defs.json"',
        '(( ND > 0 )) || { echo "No compliance alert definition matches /$DEF_RX/. Nothing to report on is not the same as compliant: fix DEF_RX." >&2; exit 2; }',
        '',
        '# 2. The group, so the report covers it and nothing else.',
        'get_all "/suite-api/api/resources/groups/${GROUP_ID}/members" resourceList "$WORK/members.json" || exit 2',
        'NM=$(jq length "$WORK/members.json")',
        '(( NM > 0 )) || { echo "Group $GROUP_ID has no members: nothing would be checked." >&2; exit 2; }',
        '',
        '# 3. Active alerts of those definitions only, paged, then narrowed to the group.',
        'jq \'{activeOnly: true, alertDefinitionId: [.[].id]}\' "$WORK/bench-defs.json" > "$WORK/alert-query.json"',
        'post_all /suite-api/api/alerts/query alerts "$WORK/alerts.json" "$WORK/alert-query.json" || exit 2',
        'jq --slurpfile m "$WORK/members.json" \'($m[0] | map({key: .identifier, value: (.resourceKey.name // .identifier)}) | from_entries) as $in',
        '  | [.[] | select($in[.resourceId] != null) | . + {resourceName: $in[.resourceId]}]\' "$WORK/alerts.json" > "$WORK/group-alerts.json"',
        '',
        '# 4. The failing rules are the alert’s contributing symptoms, 50 alerts a call.',
        '#    VERIFY the nesting of contributingSymptoms on your release: the ids are',
        '#    found wherever symptomDefinitionId appears under each entry.',
        'jq -r \'.[].alertId\' "$WORK/group-alerts.json" > "$WORK/alert-ids.txt"',
        ': > "$WORK/symptoms.items"',
        'while mapfile -t -n 50 batch && (( ${#batch[@]} )); do',
        '  q=$(printf "id=%s&" "${batch[@]}")',
        '  get "/suite-api/api/alerts/contributingsymptoms?${q%&}" > "$WORK/cs.json" || { echo "Could not read contributing symptoms." >&2; exit 2; }',
        '  jq -c \'(.contributingSymptoms // [])[] | {alertId: (.alertId // .id), defs: ([.. | objects | .symptomDefinitionId? // empty] | unique)}\' "$WORK/cs.json" >> "$WORK/symptoms.items"',
        'done < "$WORK/alert-ids.txt"',
        'jq -s . "$WORK/symptoms.items" > "$WORK/symptoms.json"',
        'jq -r \'[.[].defs[]] | unique[]\' "$WORK/symptoms.json" > "$WORK/symptom-ids.txt"',
        ': > "$WORK/names.items"',
        'while mapfile -t -n 50 batch && (( ${#batch[@]} )); do',
        '  q=$(printf "id=%s&" "${batch[@]}")',
        '  get "/suite-api/api/symptomdefinitions?${q%&}" > "$WORK/sd.json" || { echo "Could not read symptom definitions." >&2; exit 2; }',
        '  jq -c \'(.symptomDefinitions // [])[] | {id, name}\' "$WORK/sd.json" >> "$WORK/names.items"',
        'done < "$WORK/symptom-ids.txt"',
        'jq -s . "$WORK/names.items" > "$WORK/names.json"',
        '',
        'jq -n --slurpfile a "$WORK/group-alerts.json" --slurpfile s "$WORK/symptoms.json" --slurpfile n "$WORK/names.json" \'',
        '  ($s[0] | map({key: .alertId, value: .defs}) | from_entries) as $sym',
        '  | ($n[0] | map({key: .id, value: .name}) | from_entries) as $name',
        '  | $a[0] | group_by(.resourceId)',
        '  | map({resourceId: .[0].resourceId, resource: .[0].resourceName, alerts: (map(.alertDefinitionName) | unique),',
        '         failingRules: ([.[] | ($sym[.alertId] // [])[] | ($name[.] // .)] | unique)})\' > "$OUT"',
        '',
        'COUNT=$(jq length "$OUT")',
        'RULES=$(jq \'[.[].failingRules[]] | unique | length\' "$OUT")',
        `echo "$BENCH: $COUNT of $NM object(s) in ${group.replace(/["$`\\]/g, '')} fail, across $RULES distinct rule(s). Report: $OUT"`,
        'jq -r \'.[] | "\\(.resource): \\(if (.failingRules | length) > 0 then (.failingRules | join("; ")) else "(no contributing symptoms returned: open the alert)" end)"\' "$OUT"',
        ...(webhook
          ? ['', `jq -n --arg b "$BENCH" --slurpfile r "$OUT" '{benchmark: $b, objects: $r[0]}' > "$WORK/webhook.json"`, `post_webhook ${shq(webhook)} "$WORK/webhook.json"`]
          : []),
        '',
        'if (( COUNT > THRESHOLD )); then finish 1; fi',
        'finish 0',
      ]);

      const pkg = opsPackage({
        parts: ['compliance', base],
        folder: base,
        description: `Weekly ${benchmark} drift report for "${group}". Reads only.`,
        workflowName: `Compliance drift ${opsPart(base)}`,
        workflowDescription: `Lists every member of "${group}" with an active alert of a ${benchmark} compliance alert definition, and the rules (contributing symptoms) it fails. Fails above the threshold, so a schedule shows it.`,
        changes: false,
        outputs: [
          { name: 'failingCount', type: 'number', description: 'Objects in the group that fail the benchmark' },
          { name: 'reportJson', type: 'string', description: '{benchmark, objects: [{resourceId, resource, alerts, failingRules}]}' },
        ],
        account: 'A read-only account',
        settings: [
          { name: 'benchmark', type: 'string', value: benchmark, description: 'The benchmark, for the report' },
          { name: 'definitionRegex', type: 'string', value: defRx, description: "Regular expression on the benchmark's compliance alert definition names. VERIFY it under Alerts > Alert Definitions" },
          { name: 'groupName', type: 'string', value: group, description: 'The custom group reported on' },
          { name: 'maxFailing', type: 'number', value: failOn, description: 'The run fails when more objects than this fail' },
          { name: 'webhook', type: 'string', value: webhook, description: 'Optional: where the report is posted' },
        ],
        body: COMPLIANCE_BODY,
        after: String.raw`failingCount = report.length;
reportJson = JSON.stringify({ benchmark: settings.benchmark, objects: report });
summary = core.audit(null, { benchmark: settings.benchmark, group: settings.groupName, members: members.length, failing: failingCount });
if (settings.webhook) core.notify(settings.webhook, reportJson);
if (failingCount > Number(settings.maxFailing)) throw new Error(failingCount + " object(s) fail " + settings.benchmark + ", above the threshold of " + settings.maxFailing + ".");`,
      });

      return {
        platform: PLATFORM,
        title: `${benchmark} on "${group}" — a weekly list of what fails it`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Weekly, from wherever the report script is scheduled', worstCase: 'once a week' },
        scope: {
          what: `Objects in "${group}", checked against ${benchmark}.`,
          decidedBy: [
            `The policy "${policy}", where the benchmark is enabled.`,
            `The group "${group}" (GROUP_ID): only its members are reported.`,
            `The benchmark's compliance alert definitions, found by name (/${defRx}/); only their active alerts count, not every compliance alert.`,
          ],
          ifWrong: 'The report covers the wrong objects. Nothing is changed either way, which is why this stops at reporting.',
        },
        guardrails: [
          { rule: 'Reports; never remediates', because: 'Hardening changes break things — SSH disabled on a host an engineer is in, a TLS setting a backup agent needed. They go through change.' },
          { rule: 'Enabled for a group, not the estate', because: 'A benchmark across everything is thousands of alerts on day one, and alert fatigue before the first fix.' },
          { rule: 'report.sh exits 2 when no alert definition matches the benchmark name pattern, the group is empty, or any read fails', because: 'A report built from nothing says "0 failing", which reads as compliant.' },
          { rule: 'Every list is paged and kept in files, never passed as an argument', because: 'A large estate’s alert list is over the 128 KB argument limit and the report would die with "Argument list too long".' },
          ...(webhook ? [{ rule: 'The webhook post uses curl -f; a failed post exits 3', because: 'Otherwise an undelivered report looks exactly like a delivered one.' }] : []),
        ],
        dryRun: ['Enable the benchmark, wait one collection cycle, and open Compliance for the group. The score there is what the report will say.', `Run the workflow Compliance drift ${opsPart(base)} (or scripts/report.sh) by hand once and check the alert definitions it lists are this benchmark’s and no other’s.`],
        undo: [`Turn the benchmark off in "${policy}". Its alerts clear on the next cycle.`],
        told: webhook ? [`${webhook}, weekly, with each failing object, the benchmark alerts on it, and the rules (the alerts’ contributing symptoms) it fails.`] : ['The JSON file the script writes. Set a webhook if somebody should read it.'],
        requires: [
          spm
            ? `VCF Operations 9.1 or later; ${benchmark} ships with Security Posture Management. VERIFY licensing — the 9.1 Security Posture Management documentation is published under VMware Advanced Cyber Compliance.`
            : pack
              ? `The ${benchmark} compliance management pack installed — it is not built in.`
              : 'Nothing extra; the vSphere Security Configuration Guide ships with VCF Operations 8.x.',
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Operations certificate trusted in Orchestrator; for the fallback script, jq on the machine running it.',
        ],
        files: {
          ...pkg.files,
          [`${base}-enable.md`]: [
            `# Enable ${benchmark}`,
            '',
            `1. ${pack ? `Install the ${benchmark} compliance pack from the Integrations repository.` : 'Nothing to install.'}`,
            spm
              ? `2. Protect → Security Posture Management → ⋮ next to ${benchmark} → Enable Benchmark → assign "${policy}". Set any rule marked * (site-specific value) under View Control Set, then Run Assessment.`
              : `2. Configure → Policies → "${policy}" → Compliance: enable ${benchmark}.`,
            `3. Check "${policy}" is assigned to "${group}" and that no higher-priority policy covers the same objects.`,
            `4. Schedule the workflow Compliance drift ${opsPart(base)} weekly in Orchestrator (it fails above the threshold), or scripts/report.sh with GROUP_ID set. Both only read. The script exits 0: at or under the threshold; 1: over it; 2: could not read, or found no alert definitions for the benchmark; 3: the webhook post failed.`,
            '',
          ].join('\n'),
          'scripts/report.sh': report,
          'IMPORT.md': importMd({
            title: 'the compliance run',
            steps: [
              { heading: 'Enable the benchmark — by a person', files: [`${base}-enable.md`], how: [`${base}-enable.md: the benchmark is enabled in the interface, on the policy it names. The benchmarks are VMware's own, so there is no file to import for them. A custom benchmark of your own is a separate import (Compliance → Custom Benchmarks → Import) and is not generated here.`] },
              ...packageSteps(pkg, 'the workflow that reports the drift'),
              { heading: 'Or: the script, from a Linux host', files: ['scripts/report.sh'], how: ['scripts/report.sh reads the same over the API and changes nothing. Run it by hand or from cron with GROUP_ID set; it exits non-zero on drift.'] },
            ],
          }),
        },
        notes: [
          'The first run is a baseline, not a failure. Agree the number that is acceptable this quarter and set the threshold to it, then lower it.',
          'Documented calls: GET /api/alertdefinitions (paged; no name filter, so names are matched here), POST /api/alerts/query {activeOnly, alertDefinitionId} (paged), GET /api/alerts/contributingsymptoms?id=… (reports symptoms defined on SELF), GET /api/symptomdefinitions?id=…. GET /api/alerts has no activeOnly parameter, which is why the query form is used.',
          'VERIFY: that compliance alert definitions carry subType 21 and are named after the benchmark (8.x packs: "ESXi Host is violating …"), and the nesting of contributingSymptoms entries.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_webhook_payload',
    platform: PLATFORM,
    label: 'The payload a webhook receives',
    group: 'Notification',
    description:
      'The other half of "Send an alert to a webhook": the body that arrives. Shaped for where it lands — a ServiceNow incident, a Teams or Slack message, a runbook runner — using the alert fields VCF Operations substitutes, and a script that posts a sample so the receiving end can be tested before a real alert depends on it.',
    inputs: [
      {
        id: 'destination',
        label: 'Lands in',
        control: 'select',
        options: [
          { value: 'servicenow', label: 'ServiceNow incident' },
          { value: 'teams', label: 'Microsoft Teams (Workflows)' },
          { value: 'slack', label: 'Slack' },
          { value: 'runbook', label: 'A runbook runner (generic JSON)' },
        ],
        default: 'runbook',
      },
      { id: 'endpoint', label: 'Endpoint', control: 'text', default: 'https://runbooks.example.com/hooks/vcfops' },
      { id: 'assignment_group', label: 'ServiceNow assignment group', control: 'text', default: 'Platform Operations', showWhen: { input: 'destination', equals: ['servicenow'] } },
      { id: 'include_link', label: 'Link back to the alert', control: 'toggle', default: true },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const destination = str(values, 'destination', 'runbook');
      const endpoint = str(values, 'endpoint', '');
      const assignment = str(values, 'assignment_group', 'Platform Operations');
      const link = bool(values, 'include_link', true);
      const base = slugOf(name || `${destination}-payload`, 'payload');
      const sn = destination === 'servicenow';

      const findings: Finding[] = [];
      if (destination === 'teams' && /outlook\.office\.com\/webhook|webhook\.office\.com/i.test(endpoint)) {
        findings.push(
          error('vcfops.payload.teams-connector', 'This is an Office 365 connector URL, and Microsoft has retired those connectors.', {
            remediation: 'Create a Teams workflow with the "When a Teams webhook request is received" trigger and use its URL instead.',
            source: SRC,
          }),
        );
      }
      if (/^http:\/\//i.test(endpoint)) {
        findings.push(warning('vcfops.payload.plain-http', 'The endpoint is plain HTTP, so alert details cross the network unencrypted.', { source: SRC }));
      }

      const fields = {
        alert: '${ALERT_DEFINITION}',
        criticality: '${ALERT_CRITICALITY}',
        status: '${STATUS}',
        object: '${RESOURCE_NAME}',
        objectKind: '${RESOURCE_KIND}',
        alertId: '${ALERT_ID}',
        raised: '${CREATE_TIME}',
        ...(link ? { url: '${ALERT_URL}' } : {}),
      };

      const bodies: Record<string, unknown> = {
        // 9.1: ${SYMPTOMS} is a structured JSON object and must be the whole value of its own key.
        runbook: { source: 'vcf-operations', ...fields, recommendations: '${ALERT_RECOMMENDATIONS}', symptoms: '${SYMPTOMS}' },
        servicenow: {
          short_description: '[VCF Operations] ${ALERT_DEFINITION} on ${RESOURCE_NAME}',
          // Real newlines: JSON.stringify writes them as \n, which ServiceNow renders as a line break.
          description: `Criticality: \${ALERT_CRITICALITY}\nStatus: \${STATUS}\nRaised: \${CREATE_TIME}\nRecommendation: \${ALERT_RECOMMENDATIONS}${link ? '\n${ALERT_URL}' : ''}`,
          assignment_group: assignment,
          correlation_id: '${ALERT_ID}',
          urgency: '2',
          impact: '2',
        },
        teams: {
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                  { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: '${ALERT_DEFINITION}' },
                  { type: 'FactSet', facts: [{ title: 'Object', value: '${RESOURCE_NAME}' }, { title: 'Criticality', value: '${ALERT_CRITICALITY}' }, { title: 'Status', value: '${STATUS}' }] },
                ],
                ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in VCF Operations', url: '${ALERT_URL}' }] } : {}),
              },
            },
          ],
        },
        slack: {
          text: '${ALERT_CRITICALITY}: ${ALERT_DEFINITION} on ${RESOURCE_NAME}',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*\${ALERT_DEFINITION}*\n\${RESOURCE_NAME} — \${ALERT_CRITICALITY}, \${STATUS}${link ? '\n<${ALERT_URL}|Open in VCF Operations>' : ''}` } },
          ],
        },
      };
      const body = bodies[destination] ?? bodies['runbook'];

      const sample = JSON.stringify(body, null, 2)
        .replaceAll('${ALERT_DEFINITION}', 'Host memory pressure sustained')
        .replaceAll('${ALERT_CRITICALITY}', 'CRITICAL')
        .replaceAll('${STATUS}', 'ACTIVE')
        .replaceAll('${RESOURCE_NAME}', 'esx-test-01.example.com')
        .replaceAll('${RESOURCE_KIND}', 'HostSystem')
        .replaceAll('${ALERT_ID}', 'sample-0000')
        .replaceAll('${CREATE_TIME}', '2026-01-01T00:00:00Z')
        .replaceAll('${ALERT_URL}', 'https://vcfops.example.com/ui/')
        .replaceAll('${ALERT_RECOMMENDATIONS}', 'This is a test payload from ArchToolKit.')
        // The object VCF Operations 9.1 substitutes for "${SYMPTOMS}", quotes and all.
        .replaceAll(
          '"${SYMPTOMS}"',
          JSON.stringify({
            definedOn: 'self',
            symptoms: [{ name: 'Host memory usage above 95% (critical)', resourceName: 'esx-test-01.example.com', resourceId: '00000000-0000-0000-0000-000000000000', metricName: 'mem|host_usagePct', messageInfo: '96.2 > 95' }],
            conditions: [],
          }),
        );

      // The payload template as the 9.x API creates it (POST
      // /api/notifications/templates): a WebhookPlugin template whose
      // formattingTemplate carries the method, the headers and the body.
      const templateName = `ArchToolKit ${destination} payload (${opsPart(base)})`;
      const template = {
        name: templateName,
        description: 'Generated by ArchToolKit.',
        pluginTypeId: 'WebhookPlugin',
        templateType: 'ALERT',
        formattingTemplate: {
          type: 'WEBHOOK_TEMPLATE',
          newAlertTemplate: { endpoint: '', headers: [{ key: 'Content-Type', value: 'application/json' }], method: 'POST', payload: JSON.stringify(body, null, 2) },
        },
      };
      const pkg = opsPackage({
        parts: ['payload', base],
        folder: base,
        description: `Creates the ${destination} webhook payload template in VCF Operations, once, and can post a filled-in sample to the endpoint.`,
        workflowName: `Create payload template ${opsPart(base)}`,
        workflowDescription: `Creates the payload template "${templateName}" (WebhookPlugin) unless it exists. With sendSample on, it also posts the filled-in sample to the endpoint${sn ? ' — for the ServiceNow Table API only when no open incident has its correlation_id' : ''}.`,
        changes: true,
        cap: 2,
        outputs: [{ name: 'templateId', type: 'string', description: 'The payload template id, empty in a dry run' }],
        account: 'An account that may manage notification settings',
        settings: [
          { name: 'endpoint', type: 'string', value: endpoint, description: 'The receiving endpoint, for the sample' },
          { name: 'sendSample', type: 'boolean', value: false, description: sn ? 'Post the sample: this CREATES AN INCIDENT' : 'Post the sample to the endpoint' },
          { name: 'receiverUsername', type: 'string', value: '', description: sn ? 'The ServiceNow integration user, for the sample' : 'Optional: a user for Basic authentication at the endpoint' },
          { name: 'receiverPassword', type: 'SecureString', description: 'Its password' },
        ],
        resources: [
          { name: 'template.json', content: `${JSON.stringify(template, null, 2)}\n` },
          { name: 'sample.json', content: `${sample}\n` },
        ],
        body: PAYLOAD_BODY,
        after: String.raw`templateId = ctx.dryRun ? "" : (templateRef || "");
summary = core.audit(ctx, { templateId: templateId, next: "Select the template on the notification rule that uses the webhook outbound instance." });
core.notify(settings.webhook, summary);`,
      });

      return {
        platform: PLATFORM,
        title: `Alert payload for ${destination === 'servicenow' ? 'ServiceNow' : destination === 'teams' ? 'Teams' : destination === 'slack' ? 'Slack' : 'a runbook runner'}`,
        // The workflow creates a payload template; a ServiceNow sample also creates an incident.
        effect: 'reversible',
        trigger: { kind: 'alert', detail: 'Whatever notification rule uses the webhook this payload is attached to', worstCase: 'as often as that rule fires' },
        scope: {
          what: 'The body sent for every alert the notification rule matches.',
          decidedBy: ['The notification rule the outbound instance is attached to — this payload changes the shape, not the scope.'],
          ifWrong: 'The receiving end rejects it and nobody knows, because a rejected webhook is logged on the sender and read by nobody.',
        },
        guardrails: [
          { rule: 'Tested with a sample before a real alert depends on it', because: 'A payload the receiver cannot parse fails silently on the sending side.' },
          { rule: 'The workflow is a dry run until dryRun is false, creates the template once (by name), and posts the sample only when sendSample is on', because: 'Re-running it never adds a second template, and a test is sent on purpose.' },
          ...(sn
            ? [
                { rule: 'send-sample.sh is a dry run unless --execute: it prints the incident it would create and sends nothing', because: 'Each real run opens an incident in a queue somebody works; a test should not page the service desk by accident.' },
                { rule: 'Against the Table API, send-sample.sh refuses when an open incident already has the sample’s correlation_id', because: 'The Table API never deduplicates, so re-running a test would open a second incident for the same alert.' },
                { rule: 'The ServiceNow password is read from a mode-600 file (checked) and given to curl as a config on stdin', because: 'On a command line it would be visible to every user of the host through ps.' },
              ]
            : []),
        ],
        dryRun: [
          `Run the workflow Create payload template ${opsPart(base)} with dryRun = true: it logs the template it would create${sn ? ' and, with sendSample on, the incident check and the post it would make' : ' and the sample post it would make'}.`,
          ...(sn
            ? ['Or run scripts/send-sample.sh without --execute: it prints the sample and the endpoint and sends nothing.', 'Then point the endpoint at a sub-production instance and send the sample for real; check the incident, then close it.']
            : ['Or run scripts/send-sample.sh. It posts a filled-in sample to the endpoint. Check it arrives, and arrives looking right.']),
        ],
        undo: [
          'Detach the payload template from the notification rule, or delete it (DELETE /suite-api/api/notifications/templates/{id}). Alerts go on being raised; they stop being sent in this shape.',
          ...(sn ? ['Close (or delete) the incident send-sample.sh created: its number and sys_id are printed when it is created.'] : []),
        ],
        told: [`${endpoint || 'The endpoint'}, per alert.`],
        requires: ['A webhook outbound instance in VCF Operations pointing at the endpoint.', destination === 'servicenow' ? 'A ServiceNow integration user with rights to create incidents, stored on the outbound instance — not in the payload.' : 'Whatever the receiving end needs to accept a POST.', OPS_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          [`${base}-template.json`]: `${JSON.stringify(body, null, 2)}\n`,
          [`scripts/${base}-sample.json`]: `${sample}\n`,
          'scripts/send-sample.sh': sn ? serviceNowSample(endpoint, `${base}-sample.json`) : [
            '#!/usr/bin/env bash',
            '# Post a filled-in sample to the endpoint, to test the receiving end.',
            'set -euo pipefail',
            `ENDPOINT="\${ENDPOINT:-${endpoint}}"`,
            `curl -sS -f -X POST "$ENDPOINT" -H "Content-Type: application/json" --data-binary @"$(dirname "$0")/${base}-sample.json"`,
            'echo',
            'echo "Sent. Check it arrived and reads correctly before attaching the template to a rule."',
            '',
          ].join('\n'),
          'IMPORT.md': importMd({
            title: 'the webhook payload template',
            steps: [
              ...packageSteps(pkg, 'the workflow that creates the payload template'),
              {
                heading: 'Or: the payload template by hand',
                files: [`${base}-template.json`],
                how: [
                  'Configure → Alerts → Payload Templates → Add (8.x: Configure → Alerts → Payload Templates), choose the Webhook Notification Plugin as the outbound method, and paste the contents of this file as the request body. It is the body, not a template export.',
                  'Then select the template on the notification rule that uses the webhook outbound instance.',
                ],
                verify: [
                  'the payload-template export/import in the interface writes its own wrapper around the body; that wrapper is not documented, so this is pasted rather than imported.',
                  'the workflow fills formattingTemplate.newAlertTemplate (type WEBHOOK_TEMPLATE, method, headers, payload) as the 9.x reference shows it; the reference does not show the templates for an updated or cancelled alert, or whether newAlertTemplate.endpoint is a path added to the outbound instance URL (it is left empty). Open the template after the workflow creates it and check both.',
                ],
              },
              { heading: 'Test the receiving end', files: [`scripts/${base}-sample.json`, 'scripts/send-sample.sh'], how: ['The workflow with sendSample on, or ./scripts/send-sample.sh, posts the filled-in sample straight to the endpoint, without VCF Operations.'] },
            ],
            sources: ['VCF Operations API 9.x, POST /api/notifications/templates: https://developer.broadcom.com/xapis/vcf-operations-api/latest/suite-api/api/notifications/templates/post/'],
          }),
        },
        notes: [
          'In the interface: Configure → Payload Templates → Add, choose the webhook outbound method, and paste the template. Then select the template on the notification rule.',
          'The ${...} fields are substituted by VCF Operations. If one arrives literally, it is not a field your version supports — check the list in the payload template editor.',
          ...(destination === 'runbook'
            ? ['9.1: ${SYMPTOMS} is now a structured JSON object (symptom sets, conditions and context), not a string. It must be the whole value of its own key — "symptoms": "${SYMPTOMS}" — and embedding it inside a longer string no longer works. VERIFY the object’s fields against a real alert: the sample uses definedOn, symptoms[] (name, resourceName, resourceId, metricName, messageInfo) and conditions[], as published examples show.']
            : []),
          ...(sn
            ? [
                'correlation_id carries the alert id, but the Table API (POST /api/now/table/incident) does not deduplicate on it: every post is a new incident, including the update and the cancel VCF Operations sends for the same alert. To get one incident per alert, point the outbound instance at an Import Set (POST /api/now/import/<staging table>) whose Transform Map coalesces on correlation_id, so a second post updates the open incident; or at a Scripted REST API that looks the incident up by correlation_id and updates it, creating one only when none is open.',
                'send-sample.sh needs the ServiceNow credential for a real Table API endpoint: SN_USER and SN_PASSWORD_FILE (the password, mode 600). The script checks the mode and passes user:password to curl as a config on stdin (curl -K -), never as an argument.',
                'The description uses real line breaks (\\n in the JSON), which ServiceNow shows as new lines. A literal backslash-n would show as the two characters.',
              ]
            : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_content_backup',
    platform: PLATFORM,
    label: 'Back up the content to git, nightly',
    group: 'Content',
    description:
      'Alert definitions, symptoms, recommendations, super metrics, custom groups and policies, pulled nightly as JSON and committed to a repository. The history of who changed which threshold is then a git log, and the content can be compared between environments or put back after a bad import.',
    inputs: [
      { id: 'repo_path', label: 'Repository folder', control: 'text', default: '/srv/vcfops-content', hint: 'A git working copy on the machine that runs this' },
      { id: 'environment', label: 'Environment name', control: 'text', default: 'production' },
      { id: 'push', label: 'Push after committing', control: 'toggle', default: true },
      { id: 'include_policies', label: 'Include policy exports', control: 'toggle', default: true },
      { id: 'runner', label: 'Scheduled on', control: 'select', options: [{ value: 'bash', label: 'Linux (cron)' }, { value: 'powershell', label: 'Windows (Task Scheduler)' }], default: 'bash' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const repo = str(values, 'repo_path', '/srv/vcfops-content');
      const env = slugOf(str(values, 'environment', 'production'), 'production');
      const push = bool(values, 'push', true);
      const policies = bool(values, 'include_policies', true);
      const runner = str(values, 'runner', 'bash');

      const types = [
        ['alertdefinitions', 'alertDefinitions'],
        ['symptomdefinitions', 'symptomDefinitions'],
        ['recommendations', 'recommendations'],
        ['supermetrics', 'superMetrics'],
        ['resources/groups', 'groups'],
      ] as const;

      const bash = readScript('vcf-operations', `Nightly backup of VCF Operations content (${env}) to ${repo}.`, [
        `REPO="${repo}"`,
        `OUT="$REPO/${env}"`,
        'mkdir -p "$OUT"',
        ...workDirLines(),
        ...PAGED_HELPERS,
        '',
        '# Every page of each list is read into a file first; only when the whole list',
        '# was read is the folder replaced, so an object deleted in VCF Operations shows',
        '# as a deletion in git and a failed read never empties the backup.',
        '# One file per object, sorted keys, so a diff is about the change and not the order.',
        ...types.flatMap(([path, key]) => [
          `get_all /suite-api/api/${path} ${key} "$WORK/${key}.json" || exit 2`,
          `rm -rf "$OUT/${key}" && mkdir -p "$OUT/${key}"`,
          `jq -c '.[]' "$WORK/${key}.json" > "$WORK/${key}.items"`,
          'while IFS= read -r item; do',
          `  id=$(jq -r '.id // .resourceKey.name' <<<"$item" | tr -c 'A-Za-z0-9._-' '_')`,
          `  jq -S . <<<"$item" > "$OUT/${key}/$id.json"`,
          `done < "$WORK/${key}.items"`,
          `echo "${key}: $(jq length "$WORK/${key}.json")"`,
        ]),
        ...(policies
          ? [
              '',
              'get_all /suite-api/api/policies policySummaries "$WORK/policies.json" || exit 2',
              'rm -rf "$OUT/policies" && mkdir -p "$OUT/policies"',
              'jq -r \'.[].id\' "$WORK/policies.json" > "$WORK/policy-ids.txt"',
              'while IFS= read -r id; do',
              `  curl -sS -f "https://\${VCFOPS_HOST}/suite-api/api/policies/export?id=$id" -H "${authHeader('vcf-operations')}" -o "$OUT/policies/$id.zip"`,
              'done < "$WORK/policy-ids.txt"',
            ]
          : []),
        '',
        'cd "$REPO"',
        'git add -A',
        'if git diff --cached --quiet; then',
        '  echo "No content changed."',
        '  exit 0',
        'fi',
        `git -c user.name="vcfops-backup" -c user.email="vcfops-backup@localhost" commit -q -m "VCF Operations content, ${env}, $(date +%F)"`,
        ...(push ? ['git push -q'] : []),
        'git log --stat -1 | head -30',
      ]);

      const ps = [
        '<#',
        '.SYNOPSIS',
        `    Nightly backup of VCF Operations content (${env}) to a git repository.`,
        '.DESCRIPTION',
        '    Generated by ArchToolKit. Reads only from VCF Operations. The token is',
        '    read from the VCFOPS_TOKEN environment variable, never from this file.',
        '#>',
        '[CmdletBinding()]',
        `param([string]$Repo = '${repo}')`,
        'Set-StrictMode -Version Latest',
        "$ErrorActionPreference = 'Stop'",
        "if (-not $env:VCFOPS_HOST) { throw 'Set VCFOPS_HOST' }",
        '# A token can be handed in; a scheduled task logs in for itself from a',
        '# password file that only its account can read (or a DPAPI-protected one).',
        '$token = $env:VCFOPS_TOKEN',
        'if (-not $token) {',
        "    if (-not $env:VCFOPS_USER -or -not $env:VCFOPS_PASSWORD_FILE) { throw 'Set VCFOPS_TOKEN, or VCFOPS_USER and VCFOPS_PASSWORD_FILE' }",
        '    $body = @{ username = $env:VCFOPS_USER; password = (Get-Content -Raw $env:VCFOPS_PASSWORD_FILE).TrimEnd() } | ConvertTo-Json',
        "    $token = (Invoke-RestMethod -Method Post -Uri \"https://$($env:VCFOPS_HOST)/suite-api/api/auth/token/acquire\" -ContentType 'application/json' -Body $body).token",
        '}',
        "$headers = @{ Authorization = \"OpsToken $token\"; Accept = 'application/json' }",
        `$out = Join-Path $Repo '${env}'`,
        '',
        `$types = @{ ${types.map(([path, key]) => `'${path}' = '${key}'`).join('; ')} }`,
        'foreach ($path in $types.Keys) {',
        '    $key = $types[$path]',
        '    $dir = Join-Path $out $key',
        '    New-Item -ItemType Directory -Force -Path $dir | Out-Null',
        '    # Every page, and stop rather than back up nothing when the list key is missing.',
        '    $items = @(); $page = 0; $size = 1000',
        '    do {',
        '        $resp = Invoke-RestMethod -Uri "https://$($env:VCFOPS_HOST)/suite-api/api/$($path)?page=$page&pageSize=$size" -Headers $headers',
        '        $prop = $resp.PSObject.Properties[$key]',
        '        $info = $resp.PSObject.Properties[\'pageInfo\']',
        '        if (-not $prop -and -not $info) { throw "No $key in the response from $path" }',
        '        $batch = if ($prop -and $null -ne $prop.Value) { @($prop.Value) } else { @() }',
        '        $items += $batch',
        '        $page++',
        '        $total = if ($info -and $info.Value.PSObject.Properties[\'totalCount\']) { [int]$info.Value.totalCount } else { -1 }',
        '    } while ($batch.Count -eq $size -and ($total -lt 0 -or $page * $size -lt $total))',
        '    Remove-Item -Recurse -Force $dir',
        '    New-Item -ItemType Directory -Force -Path $dir | Out-Null',
        '    foreach ($item in $items) {',
        "        $id = ($item.id, $item.resourceKey.name | Where-Object { $_ } | Select-Object -First 1) -replace '[^A-Za-z0-9._-]', '_'",
        '        $item | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 (Join-Path $dir "$id.json")',
        '    }',
        '}',
        '',
        'Push-Location $Repo',
        'try {',
        '    git add -A',
        '    git diff --cached --quiet',
        "    if ($LASTEXITCODE -eq 0) { Write-Output 'No content changed.'; return }",
        `    git -c user.name=vcfops-backup -c user.email=vcfops-backup@localhost commit -q -m "VCF Operations content, ${env}, $(Get-Date -Format yyyy-MM-dd)"`,
        ...(push ? ['    git push -q'] : []),
        '} finally { Pop-Location }',
        '',
      ].join('\n');

      // Orchestrator cannot run git, so the package reads the same content,
      // whole, and hands it on: the backupJson output, and a webhook (a
      // collector of your own that commits it). The git history stays with
      // the script.
      const pkg = opsPackage({
        parts: ['backup', env],
        folder: `content-backup-${env}`,
        description: `Reads the VCF Operations content (${env}) whole, as JSON. Reads only.`,
        workflowName: `Read content ${env}`,
        workflowDescription: 'Reads every page of the alert definitions, symptom definitions, recommendations, super metrics and custom groups (and the policy list), and returns them as one JSON document; with a webhook set, posts it there and fails when the post fails.',
        changes: false,
        outputs: [{ name: 'backupJson', type: 'string', description: '{source, environment, taken, counts, content: {type: [objects]}}' }],
        account: 'A read-only account',
        settings: [
          { name: 'environment', type: 'string', value: env, description: 'The environment name, recorded in the backup' },
          { name: 'includePolicies', type: 'boolean', value: policies, description: 'Also list the policies (the exports are zips, which only the script takes)' },
          { name: 'webhook', type: 'string', value: '', description: 'Optional: where the backup JSON is posted — a receiver of your own that commits it' },
        ],
        body: BACKUP_BODY,
        after: String.raw`backupJson = JSON.stringify(backup);
summary = core.audit(null, { environment: settings.environment, counts: backup.counts });
if (settings.webhook && !core.notify(settings.webhook, backupJson)) throw new Error("The content was read but the backup was NOT delivered to the webhook.");`,
      });

      return {
        platform: PLATFORM,
        title: `Nightly content backup — ${env} to git`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Nightly, from cron or Task Scheduler', worstCase: 'once a night' },
        scope: {
          what: 'Custom content in VCF Operations: alert and symptom definitions, recommendations, super metrics, custom groups' + (policies ? ' and policies.' : '.'),
          decidedBy: ['What the token’s account can read. A read-only account sees everything this needs.'],
          ifWrong: 'Something is missing from the backup, and you find out the day you need it. Restore a file from it into a test instance once a quarter.',
        },
        guardrails: [
          { rule: 'Reads only, with a read-only account', because: 'A backup job holding an administrator token is a larger risk than the one it mitigates.' },
          { rule: 'Every list is read page by page and must be read whole before its folder is replaced; a failed read stops the run (exit 2)', because: 'A backup that silently wrote an empty folder would commit the deletion of every alert definition, and the history would say it was intended.' },
          { rule: 'One file per object, keys sorted', because: 'So the git history shows which threshold changed, not that a 4 MB export differs.' },
        ],
        dryRun: ['Run it once by hand into an empty repository and read the tree it produces.', `The workflow Read content ${env} only reads: run it once and read the counts in its log.`],
        undo: ['Nothing to undo. To restore an object, POST its JSON back — without the id, which the target will assign.'],
        told: ['The git log. Point your repository’s notifications at a channel and every content change in VCF Operations becomes visible.'],
        requires: ['git and jq on the machine that runs it, and a working copy already cloned at ' + repo + '.', push ? 'Credentials for the push held by git’s own credential helper, not in the script.' : 'Nothing else.', 'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Operations certificate trusted in Orchestrator.'],
        files: {
          ...pkg.files,
          ...(runner === 'powershell' ? { 'scripts/Backup-VcfOpsContent.ps1': ps } : { 'scripts/backup-content.sh': bash, 'crontab.txt': `# Nightly at 01:30. The script logs in for itself from the password file\n# (mode 600, owned by the job's user); no token or password is in this line.\n30 1 * * * cd ${repo} && ${scheduledEnv('vcf-operations', 'svc-vcfops-readonly')} /usr/local/bin/backup-content.sh >> /var/log/vcfops-backup.log 2>&1\n` }),
          'IMPORT.md': importMd({
            title: 'the nightly content backup',
            intro: ['Nothing here is content VCF Operations imports: the package and the script read the API. What goes where:'],
            steps: [
              {
                heading: 'The script, with git — the backup itself',
                files: [runner === 'powershell' ? 'scripts/Backup-VcfOpsContent.ps1' : 'scripts/backup-content.sh'],
                how: [
                  runner === 'powershell'
                    ? 'scripts/Backup-VcfOpsContent.ps1 runs from Task Scheduler on a host of your own; it reads the API and writes JSON into the repository.'
                    : 'scripts/backup-content.sh goes in /usr/local/bin and crontab.txt in the service account’s crontab; it reads the API and writes JSON into the repository.',
                  'What it writes is the API’s GET responses, one folder per content type: a record of what changed and when, readable in a diff. It is not an import format. To put content back, POST the object to the same API path, or restore from a Content Management export (Administration → Control Panel → Content Management → Export, then Import) — which is the backup to keep for a rebuild.',
                ],
              },
              ...packageSteps(pkg, 'the same read, from Orchestrator'),
            ],
          }),
        },
        notes: [
          'Tokens from /suite-api/api/auth/token/acquire expire after a few hours, so the job logs in for itself each run from VCFOPS_PASSWORD_FILE — a file only the job’s user can read. The password is sent on stdin, never on a command line.',
          'Committing two environments into one repository makes "what differs between test and production" a directory diff.',
        ],
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_self_health',
    platform: PLATFORM,
    label: 'Check that VCF Operations is still collecting',
    group: 'Health',
    description:
      'The failure nothing alerts on: VCF Operations itself stops collecting. A cloud proxy goes down, an adapter’s credential expires, and every alert in this kit goes quiet — which looks exactly like a healthy estate. This checks the nodes, the collectors and every adapter instance’s last collection, and exits non-zero so something outside VCF Operations can page.',
    inputs: [
      { id: 'stale_minutes', label: 'An adapter is stale after (minutes)', control: 'number', default: 30, min: 10, max: 1440 },
      { id: 'ignore_adapters', label: 'Ignore adapter instances named', control: 'text', default: '', hint: 'Ones that are known to be off' },
      { id: 'webhook', label: 'Post failures to', control: 'text', default: 'https://runbooks.example.com/hooks/vcfops-health', hint: 'Somewhere that is not VCF Operations' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const stale = num(values, 'stale_minutes', 30);
      const ignore = listOf(str(values, 'ignore_adapters', ''));
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'vcfops-health', 'vcfops-health');

      const findings: Finding[] = [];
      if (/vcfops|aria|vrops/i.test(webhook) && !/hooks/i.test(webhook)) {
        findings.push(
          warning('vcfops.health.self-report', 'The failure report goes to VCF Operations, which is the thing that may have failed.', {
            remediation: 'Send it somewhere independent — a chat webhook, a pager, a different monitoring system.',
            source: SRC,
          }),
        );
      }
      if (stale < 15) {
        findings.push(warning('vcfops.health.tight', `A ${stale}-minute threshold is inside two collection cycles and will report a slow cycle as a failure.`, { source: SRC }));
      }

      const script = readScript('vcf-operations', 'Is VCF Operations itself healthy and collecting?', [
        `STALE_MS=$(( ${stale} * 60 * 1000 ))`,
        'NOW_MS=$(( $(date +%s) * 1000 ))',
        `IGNORE='${JSON.stringify(ignore)}'`,
        'PROBLEMS=()',
        '',
        ...workDirLines(),
        ...WEBHOOK_HELPER,
        '',
        '# Each answer is saved to a file first: a read that fails stops the check',
        '# (exit 2) instead of feeding an empty list into a loop that then finds',
        '# nothing wrong.',
        '# 1. The node answering this call.',
        'get /suite-api/api/deployment/node/status > "$WORK/node.json" || { echo "Cannot read the node status." >&2; exit 2; }',
        'NODE=$(jq -r ".status // \\"UNKNOWN\\"" "$WORK/node.json")',
        '[[ "$NODE" == "ONLINE" ]] || PROBLEMS+=("node status is $NODE")',
        '',
        '# 2. Collectors and cloud proxies.',
        'get /suite-api/api/collectors > "$WORK/collectors.json" || { echo "Cannot read the collectors." >&2; exit 2; }',
        '(( $(jq "[.collector[]?] | length" "$WORK/collectors.json") > 0 )) || PROBLEMS+=("no collectors listed at all")',
        'while read -r cname cstate; do',
        '  [[ "$cstate" == "UP" ]] || PROBLEMS+=("collector $cname is $cstate")',
        'done < <(jq -r ".collector[]? | \\"\\(.name|gsub(\\" \\";\\"_\\")) \\(.state)\\"" "$WORK/collectors.json")',
        '',
        '# 3. Every adapter instance: when did it last collect?',
        'get /suite-api/api/adapters > "$WORK/adapters.json" || { echo "Cannot read the adapter instances." >&2; exit 2; }',
        '(( $(jq "[.adapterInstancesInfoDto[]?] | length" "$WORK/adapters.json") > 0 )) || PROBLEMS+=("no adapter instances listed at all")',
        'while read -r aname last count; do',
        '  echo "$IGNORE" | jq -e --arg n "$aname" "index(\\$n)" >/dev/null && continue',
        '  if [[ "$last" == "null" ]] || (( NOW_MS - last > STALE_MS )); then',
        `    PROBLEMS+=("adapter $aname has not collected for more than ${stale} minutes")`,
        '  elif [[ "$count" == "0" ]]; then',
        '    PROBLEMS+=("adapter $aname is collecting nothing — check its credential")',
        '  fi',
        // numberOfResourcesCollected is not in the 9.x reference's adapter list: "?" when absent, so a
        // missing field is not reported as an adapter collecting nothing.
        'done < <(jq -r ".adapterInstancesInfoDto[]? | \\"\\(.resourceKey.name|gsub(\\" \\";\\"_\\")) \\(.lastCollected) \\(.numberOfResourcesCollected // \\"?\\")\\"" "$WORK/adapters.json")',
        '',
        'if (( ${#PROBLEMS[@]} == 0 )); then',
        '  echo "VCF Operations: healthy"',
        '  exit 0',
        'fi',
        '',
        'printf "VCF Operations: %s\\n" "${PROBLEMS[@]}" >&2',
        ...(webhook
          ? [`printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "vcf-operations-health", problems: .}' > "$WORK/webhook.json"`, `post_webhook ${shq(webhook)} "$WORK/webhook.json"`]
          : []),
        'finish 1',
      ]);

      const pkg = opsPackage({
        parts: ['health', base],
        folder: base,
        description: 'Checks that VCF Operations is still collecting: the node, the collectors, every adapter instance. Reads only.',
        workflowName: `VCF Operations self-check ${opsPart(base)}`,
        workflowDescription: `Reads the node status, the collectors and every adapter instance's last collection, and fails the run when anything is wrong — an adapter silent for more than ${stale} minutes, a collector not UP, an empty list — posting the problems to the webhook first.`,
        changes: false,
        outputs: [
          { name: 'healthy', type: 'boolean', description: 'true when nothing is wrong' },
          { name: 'problemsJson', type: 'string', description: 'The problems found, a JSON array of strings' },
        ],
        account: 'A read-only account',
        settings: [
          { name: 'staleMinutes', type: 'number', value: stale, description: 'An adapter is stale after this many minutes without a collection' },
          { name: 'ignoreAdapters', type: 'Array/string', value: ignore, description: 'Adapter instances known to be off' },
          { name: 'webhook', type: 'string', value: webhook, description: 'Where problems are posted: somewhere that is not VCF Operations' },
        ],
        body: HEALTH_BODY,
        after: String.raw`healthy = problems.length === 0;
problemsJson = JSON.stringify(problems);
summary = core.audit(null, { healthy: healthy, problems: problems });
for (var p = 0; p < problems.length; p++) System.warn("PROBLEM: " + problems[p]);
if (!healthy) {
  if (settings.webhook) core.notify(settings.webhook, { source: "vcf-operations-health", problems: problems });
  throw new Error("VCF Operations: " + problems.length + " problem(s): " + problems.join("; "));
}
System.log("VCF Operations: healthy");`,
      });

      return {
        platform: PLATFORM,
        title: 'VCF Operations self-check — nodes, collectors and adapter freshness',
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Every 15 minutes, from a scheduler outside VCF Operations', worstCase: 'every 15 minutes while it is broken' },
        scope: {
          what: 'VCF Operations itself: the node that answers, every collector and cloud proxy, every adapter instance.',
          decidedBy: [ignore.length > 0 ? `Everything except ${ignore.join(', ')}.` : 'Every adapter instance — nothing is ignored.'],
          ifWrong: 'An adapter left on the ignore list after it was meant to come back fails silently. Review that list whenever it changes.',
        },
        guardrails: [
          { rule: 'Runs outside VCF Operations', because: 'A monitoring system cannot reliably report its own failure.' },
          { rule: 'Reports to an independent destination', because: 'Otherwise the failure report is queued behind the failure.' },
          { rule: 'A read that fails, or a collector or adapter list that comes back empty, is a failure (exit 2 or 1), never "healthy"', because: 'An API that answers nothing is exactly what a broken VCF Operations looks like.' },
          ...(webhook ? [{ rule: 'The webhook post uses curl -f and a failed post exits 3', because: 'A report that did not arrive must not look like one that did.' }] : []),
        ],
        dryRun: ['It only reads. Run it (the workflow, or the script) once by hand and check each adapter it names is one you expect.'],
        undo: ['Nothing to undo.'],
        told: webhook ? [`${webhook}, whenever a check fails.`] : ['The exit code only. Set a webhook, or have the scheduler alert on a non-zero exit.'],
        requires: ['jq and bash 4 on the machine that runs the script.', 'A read-only VCF Operations account.', 'For the package: the Orchestrator of VCF Automation 9.1, not the orchestrator inside VCF Operations — the check has to keep running when VCF Operations does not.'],
        files: {
          ...pkg.files,
          [`scripts/${base}.sh`]: script,
          'crontab.txt': `# Every 15 minutes. The script logs in for itself from the password file\n# (mode 600); no token or password is in this line.\n*/15 * * * * ${scheduledEnv('vcf-operations', 'svc-vcfops-readonly')} /usr/local/bin/${base}.sh\n`,
          'IMPORT.md': importMd({
            title: 'the VCF Operations self-health check',
            intro: ['Nothing here is content VCF Operations imports: the package and the script read its API, from outside it. What goes where:'],
            steps: [
              ...packageSteps(pkg, 'the workflow that checks VCF Operations; import it into the Orchestrator of VCF Automation, not the one inside VCF Operations, and schedule it every 15 minutes'),
              { heading: 'Or: the script, from a Linux host', files: [`scripts/${base}.sh`, 'crontab.txt'], how: [`scripts/${base}.sh goes in /usr/local/bin on a host outside VCF Operations (it has to keep working when VCF Operations does not), and crontab.txt in the service account’s crontab. It only reads.`] },
            ],
            sources: ['VCF Operations API 9.x: GET /api/deployment/node/status, GET /api/collectors (collector[]), GET /api/adapters (adapterInstancesInfoDto[]) — https://developer.broadcom.com/xapis/vcf-operations-api/latest/'],
          }),
        },
        notes: [
          'An adapter collecting zero objects is almost always an expired or changed credential, and it is the most common reason an estate goes quiet.',
          'Run the same check against every VCF Operations instance in the fleet; each one only knows about its own collectors.',
        ],
        findings,
      };
    },
  }),
];
