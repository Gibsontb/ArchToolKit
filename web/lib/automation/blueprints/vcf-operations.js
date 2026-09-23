/**
 * VCF Operations: automation driven by what the platform already knows.
 *
 * This is the automation that follows the alerts, policies and custom groups
 * the Aria Ops page reads — same objects, same scope, same four indirections
 * between "power off idle VMs" and which VMs that turns out to be tonight.
 *
 * Most of it is a suite-API payload rather than a script, because that is what
 * the platform actually takes: a notification rule pointed at a webhook plugin,
 * a custom group that decides a scope, a policy that turns an alert on. Each
 * one comes with the script that applies it and the call that puts it back,
 * because a payload with no way to apply it is a screenshot.
 *
 * Where the documented API stops — which policy a maintenance schedule sits
 * in, which metric says a VM has been off for ninety days — the output says so
 * and marks the value to check, rather than inventing a field that looks right.
 * Every script logs in the same way (apply.ts), so the ones that run on a
 * schedule need no token in a crontab.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { applyScript, authHeader, authPreamble, readScript, scheduledEnv } from '../apply.js';
import { FORMAT_SOURCES, contentImportScript, contentPackage, contentStep, customGroupsJson, importMd, policyMergeScript,                } from '../vcfops-import.js';
import { OPS_PACKAGE_REQUIRES, inScripts, opsPackage, opsPart, packageSteps } from './vcf-operations-content.js';

const PLATFORM = 'vcf-operations'         ;
const API_REF = 'VCF Operations API 9.x: https://developer.broadcom.com/xapis/vcf-operations-api/latest/';

// ---------------------------------------------------------------------------
// The workflow scripts (ES5). ops, listAll, named and q come from the shared
// prelude in vcf-operations-content.ts.
// ---------------------------------------------------------------------------

/** Notification rule: the webhook outbound instance (by name, or by its URL), the template, then the rule once. */
const NOTIFY_BODY = String.raw`var rule = JSON.parse(core.resource(RESOURCE_PATH, "rule.json"));
var where = String(settings.endpoint || "").split("?")[0];
var plugins = listAll("alertplugins?pluginTypeId=WebhookPlugin", "notificationPluginInstances");
var plugin = null;
if (settings.pluginName) {
  plugin = named(plugins, settings.pluginName);
} else {
  var hits = [];
  for (var i = 0; i < plugins.length; i++) {
    var values = plugins[i].configValues || [];
    for (var j = 0; j < values.length; j++) {
      if (String(values[j].name).toLowerCase() === "url" && String(values[j].value) === String(settings.endpoint)) { hits.push(plugins[i]); break; }
    }
  }
  if (hits.length > 1) throw new Error(hits.length + " webhook outbound instances post to " + where + "; set pluginName to the one to use.");
  plugin = hits.length ? hits[0] : null;
}
if (!plugin) throw new Error("No webhook outbound instance " + (settings.pluginName ? "named \"" + settings.pluginName + "\"" : "posts to " + where) + " (GET alertplugins). Create it first: \"An outbound plugin\" in this kit.");
rule.pluginId = String(plugin.pluginId);
if (settings.payloadTemplate) {
  var template = named(listAll("notifications/templates?name=" + q(settings.payloadTemplate), "notificationTemplates"), settings.payloadTemplate);
  if (!template) throw new Error("No payload template named \"" + settings.payloadTemplate + "\" (GET notifications/templates).");
  rule.templateId = String(template.templateId || template.id);
}
var existing = named(listAll("notifications/rules", "rules"), rule.name);
var ruleRef = null;
if (existing) {
  ruleRef = String(existing.id);
  System.log("Exists, left as it is: notification rule \"" + rule.name + "\" (" + ruleRef + ")");
} else {
  ruleRef = core.act(ctx, "create notification rule \"" + rule.name + "\" through \"" + plugin.name + "\"", function () {
    var r = ops("POST", "notifications/rules", rule, null, null);
    if (!r.body || !r.body.id) throw new Error("POST notifications/rules returned no id.");
    return String(r.body.id);
  });
}`;

/** Custom group: the target, then the group once, then its assignment (PUT /api/policies/{id}/assign). */
const SCOPE_BODY = String.raw`var group = JSON.parse(core.resource(RESOURCE_PATH, "group.json"));
var target = named(listAll("policies", "policySummaries"), settings.policyName);
if (!target) throw new Error("Nothing named \"" + settings.policyName + "\" in GET policies; create it first.");
var existing = named(listAll("resources/groups", "groups"), group.resourceKey.name, "resourceKey.name");
var groupRef = null;
if (existing) {
  groupRef = String(existing.id);
  System.log("Exists, left as it is: custom group \"" + group.resourceKey.name + "\" (" + groupRef + "); its rules and assignment are not changed.");
} else {
  groupRef = core.act(ctx, "create custom group \"" + group.resourceKey.name + "\"", function () {
    var r = ops("POST", "resources/groups", group, null, null);
    if (!r.body || !r.body.id) throw new Error("POST resources/groups returned no id.");
    return String(r.body.id);
  });
  core.act(ctx, "assign \"" + settings.policyName + "\" to custom group \"" + group.resourceKey.name + "\"", function () {
    var r = ops("PUT", "policies/" + q(target.id) + "/assign", { groupIds: [groupRef] }, null, null);
    var failed = (r.body && r.body.failedGroupIds) || [];
    if (failed.length) throw new Error("the assignment failed for group " + failed.join(", ") + ".");
    return true;
  });
}
System.log("Open the group and read its member list before any automation points at it.");`;

/**
 * Reclamation: the group's VMs, one stat each (POST resources/stats/latest/query,
 * a query, not a change), the matches largest first; then, when ACTS, the
 * action on at most cap of them, each populated by the action API first.
 */
function reclaimBody(acts         , action        )         {
  return String.raw`var ACTS = ${acts ? 'true' : 'false'};
var ACTION = ${JSON.stringify(action)};
if (!settings.statKey) throw new Error("Set statKey in the configuration element " + SETTINGS_NAME + ".");
var threshold = Number(settings.threshold);
var requireOff = settings.requireOff === true || String(settings.requireOff) === "true";
var group = named(listAll("resources/groups", "groups"), settings.groupName, "resourceKey.name");
if (!group) throw new Error("No custom group named \"" + settings.groupName + "\".");
var members = listAll("resources/groups/" + q(group.id) + "/members", "resourceList");
var vms = [];
var nameOf = {};
for (var m = 0; m < members.length; m++) {
  if (members[m].resourceKey && String(members[m].resourceKey.resourceKindKey) === "VirtualMachine") {
    vms.push(String(members[m].identifier));
    nameOf[String(members[m].identifier)] = String(members[m].resourceKey.name);
  }
}
var candidates = [];
for (var c = 0; c < vms.length; c += 500) {
  var stats = ops("POST", "resources/stats/latest/query", { resourceId: vms.slice(c, c + 500), statKey: [String(settings.statKey), "sys|poweredOn"], maxSamples: 1 }, null, null).body || {};
  var values = stats.values || [];
  for (var v = 0; v < values.length; v++) {
    var latest = {};
    var list = (values[v]["stat-list"] && values[v]["stat-list"].stat) || [];
    for (var k = 0; k < list.length; k++) {
      var data = list[k].data || [];
      if (data.length && list[k].statKey) latest[String(list[k].statKey.key)] = Number(data[data.length - 1]);
    }
    var value = latest[String(settings.statKey)];
    // A VM that does not report the stat is left out: a missing number is not a match.
    if (value === undefined || isNaN(value) || value < threshold) continue;
    if (requireOff && latest["sys|poweredOn"] !== 0) continue;
    candidates.push({ id: String(values[v].resourceId), name: nameOf[String(values[v].resourceId)] || String(values[v].resourceId), value: value });
  }
}
candidates.sort(function (a, b) { return b.value - a.value; });
System.log(candidates.length + " of the group's " + vms.length + " VMs match (" + settings.statKey + " >= " + threshold + ").");
for (var n = 0; n < candidates.length; n++) System.log("  " + candidates[n].value + "  " + candidates[n].name + "  " + candidates[n].id);
var tasks = [];
if (ACTS) {
  var selected = candidates.slice(0, ctx.cap);
  if (candidates.length > ctx.cap) System.warn(candidates.length + " match; only the first " + ctx.cap + " are acted on (the cap). The rest wait for the next run.");
  if (selected.length && !ctx.dryRun && !settings.actionId) throw new Error("Set actionId: GET actiondefinitions and take the id of the action named like \"" + ACTION + "\".");
  for (var t = 0; t < selected.length; t++) {
    var one = selected[t];
    core.act(ctx, "run " + ACTION + " on " + one.name + " (" + one.id + ")", function () {
      var populated = ops("POST", "actions/" + q(settings.actionId) + "/query", { contextResourceId: [one.id] }, null, null).body || {};
      var execution = populated.actionExecution || populated["action-execution"];
      if (!execution) throw new Error("the action could not be populated for " + one.id + "; stopping here.");
      var started = ops("POST", "actions/" + q(settings.actionId), execution, null, null).body || {};
      tasks.push({ id: one.id, name: one.name, task: started.values || started });
      return true;
    });
  }
}`;
}

/** Maintenance window: the schedule, once, by its key. Attaching it to a policy has no API call. */
const MAINTENANCE_BODY = String.raw`var schedule = JSON.parse(core.resource(RESOURCE_PATH, "schedule.json"));
if (!settings.timeZone) throw new Error("Set timeZone in the configuration element " + SETTINGS_NAME + " (e.g. Europe/Amsterdam): the window is written in it.");
schedule.schedule.timeZone = String(settings.timeZone);
if (JSON.stringify(schedule).indexOf("<REQUIRED") >= 0) throw new Error("The schedule still has a <REQUIRED> value in it (the start was not in the form \"Third Saturday 22:00\"); regenerate it.");
var existing = named(listAll("maintenanceschedules?name=" + q(schedule.key), "schedules"), schedule.key, "key");
var scheduleRef = null;
if (existing) {
  scheduleRef = String(existing.id);
  System.log("Exists, left as it is: maintenance schedule \"" + schedule.key + "\" (" + scheduleRef + ")");
} else {
  scheduleRef = core.act(ctx, "create maintenance schedule \"" + schedule.key + "\"", function () {
    var r = ops("POST", "maintenanceschedules", schedule, null, null);
    if (!r.body || !r.body.id) throw new Error("POST maintenanceschedules returned no id.");
    return String(r.body.id);
  });
}
System.log("Next, in the interface: select \"" + schedule.key + "\" in \"" + settings.policyName + "\" (attach-to-policy.txt). There is no API call for that step.");`;

/** Overrun check: anything in maintenance at all, after the window should have ended. */
const OVERRUN_BODY = String.raw`var still = listAll("resources?resourceState=MAINTAINED&resourceState=MAINTAINED_MANUAL", "resourceList");
for (var i = 0; i < still.length; i++) {
  var key = still[i].resourceKey || {};
  System.warn("STILL IN MAINTENANCE: " + key.resourceKindKey + " " + key.name + " " + still[i].identifier);
}`;

/** Report schedule: the definition and the object by name, then the schedule unless the same one exists. */
const CAPACITY_BODY = String.raw`var schedule = JSON.parse(core.resource(RESOURCE_PATH, "schedule.json"));
if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(settings.startDate || ""))) throw new Error("Set startDate in the configuration element " + SETTINGS_NAME + ", as MM/DD/YYYY: the first day it may run.");
var definition = named(listAll("reportdefinitions?name=" + q(settings.reportName), "reportDefinitions"), settings.reportName);
if (!definition) throw new Error("No report definition named \"" + settings.reportName + "\" (GET reportdefinitions).");
var found = listAll("resources?name=" + q(settings.scopeObject), "resourceList");
var hits = [];
for (var i = 0; i < found.length; i++) if (found[i].resourceKey && String(found[i].resourceKey.name) === String(settings.scopeObject)) hits.push(found[i]);
if (hits.length !== 1) throw new Error((hits.length ? hits.length + " objects are" : "No object is") + " named \"" + settings.scopeObject + "\"; the schedule takes exactly one.");
schedule.reportDefinitionId = String(definition.id);
schedule.resourceId = [String(hits[0].identifier)];
schedule.startDate = String(settings.startDate);
function sameList(a, b) { return String((a || []).slice().sort()) === String((b || []).slice().sort()); }
var schedules = listAll("reportdefinitions/" + q(definition.id) + "/schedules", "reportSchedules");
var existing = null;
for (var j = 0; j < schedules.length; j++) {
  var s = schedules[j];
  if (String(s.reportScheduleType) === schedule.reportScheduleType && Number(s.recurrence || 1) === schedule.recurrence && sameList(s.resourceId, schedule.resourceId) && sameList(s.emailAddresses, schedule.emailAddresses)) existing = s;
}
var scheduleRef = null;
if (existing) {
  scheduleRef = String(existing.id || "");
  System.log("Exists, left as it is: the same schedule of \"" + settings.reportName + "\" to " + schedule.emailAddresses.join(", ") + ".");
} else {
  // Without X-Ops-API-Timezone the API reads the time as GMT.
  var zone = settings.timeZone ? { "X-Ops-API-Timezone": String(settings.timeZone) } : null;
  scheduleRef = core.act(ctx, "schedule \"" + settings.reportName + "\" " + schedule.reportScheduleType.toLowerCase() + " to " + schedule.emailAddresses.join(", "), function () {
    var r = ops("POST", "reportdefinitions/" + q(definition.id) + "/schedules", schedule, null, zone);
    return String((r.body && r.body.id) || "");
  });
}`;

/** Alert toggle: the target and every alert definition must exist before anything is turned on or off. */
const TOGGLE_BODY = String.raw`var target = named(listAll("policies", "policySummaries"), settings.policyName);
if (!target) throw new Error("Nothing named \"" + settings.policyName + "\" in GET policies.");
var ids = settings.alertDefinitionIds || [];
if (!ids.length) throw new Error("Set alertDefinitionIds in the configuration element " + SETTINGS_NAME + ".");
var verb = String(settings.direction) === "disable" ? "disable" : "enable";
var missing = [];
for (var i = 0; i < ids.length; i++) {
  var r = ops("GET", "alertdefinitions/" + q(ids[i]), null, { allow: [404] }, null);
  if (r.statusCode === 404 || !r.body || !r.body.id) missing.push(ids[i]);
}
if (missing.length) throw new Error("No alert definition " + missing.join(", ") + "; nothing was changed.");
var done = [];
for (var j = 0; j < ids.length; j++) {
  var id = String(ids[j]);
  core.act(ctx, verb + " " + id + " in \"" + settings.policyName + "\"", function () {
    return ops("PUT", "alertdefinitions/" + q(id) + "/" + verb + "?policyId=" + q(target.id), null, null, null).statusCode;
  });
  done.push(id);
}`;

/** The scope chain, spelled out. It is the same four steps every time. */
function alertScope(group        , policy        )           {
  return [
    `The alert fires on an object.`,
    `That object is in the custom group "${group}" — open it and count the members before you turn this on.`,
    `The group is on the policy "${policy}", and the policy decides whether the alert is enabled at all.`,
    `The notification rule below then decides whether the action runs for that alert.`,
  ];
}

const WEEKDAYS                                   = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/** "Sunday 02:00" as a cron schedule, or a marked placeholder when it will not parse. */
function cronOf(when        )         {
  const match = /^\s*([a-z]+)\s+(\d{1,2}):(\d{2})\s*$/i.exec(when);
  const day = match ? WEEKDAYS[match[1] .toLowerCase()] : undefined;
  if (!match || day === undefined) return '<REQUIRED: minute hour * * weekday>';
  return `${Number(match[3])} ${Number(match[2])} * * ${day}`;
}

export const VCF_OPERATIONS_AUTOMATIONS                                 = [
  automationBlueprint({
    id: 'vcfops_notify_webhook',
    platform: PLATFORM,
    label: 'Send an alert to a webhook',
    group: 'Notification',
    description:
      'A notification rule that sends matching alerts to a webhook plugin — a runbook, a ticket queue, a chat channel — rather than to a mailbox nobody reads. The rule decides which alerts; the plugin instance holds the URL. This is the piece that closes the gap the Aria Ops page keeps finding: alert definitions that fire and tell nobody.',
    inputs: [
      { id: 'rule_name', label: 'Rule name', control: 'text', default: 'Critical infrastructure to runbook' },
      { id: 'endpoint', label: 'Webhook URL (on the plugin)', control: 'text', default: 'https://runbooks.example.com/hooks/vcfops', hint: 'Set on the webhook plugin instance, not on this rule. Used here to check it and to name the plugin to use' },
      {
        id: 'criticality',
        label: 'Only these severities',
        control: 'select',
        options: [
          { value: 'CRITICAL', label: 'Critical only' },
          { value: 'CRITICAL,IMMEDIATE', label: 'Critical and immediate' },
          { value: 'CRITICAL,IMMEDIATE,WARNING', label: 'Critical, immediate and warning' },
          { value: '', label: 'Every severity — see the warning' },
        ],
        default: 'CRITICAL,IMMEDIATE',
      },
      { id: 'resource_kinds', label: 'Only these object kinds', control: 'text', default: 'HostSystem, Datastore, ClusterComputeResource', hint: 'Empty means every kind, which is wider than it sounds' },
      { id: 'alert_ids', label: 'Only these alert definitions', control: 'textarea', default: '', hint: 'One id per line. Empty means every alert definition that passes the filters above' },
      { id: 'on_cancel', label: 'Also send when the alert is cancelled', control: 'toggle', default: true, hint: 'So a ticket the alert opened can be closed by the same channel' },
    ],
    automation: (values                 , name        )             => {
      const ruleName = str(values, 'rule_name', 'Alert to webhook');
      const endpoint = str(values, 'endpoint', '');
      const criticalities = listOf(str(values, 'criticality', ''));
      const kinds = listOf(str(values, 'resource_kinds', ''));
      const alertIds = listOf(str(values, 'alert_ids', ''));
      const onCancel = bool(values, 'on_cancel', true);
      const base = slugOf(name || ruleName, 'notification-rule');

      const findings            = [];
      if (criticalities.length === 0 && kinds.length === 0 && alertIds.length === 0) {
        findings.push(
          warning('vcfops.rule.catch-all', 'This rule has no filters at all, so it notifies on every alert in the estate.', {
            remediation: 'A rule that notifies on everything is a rule people filter to a folder within a fortnight. Narrow it to the severity and object kinds that warrant acting.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (/[?&](token|key|secret|signature)=/i.test(endpoint)) {
        findings.push(
          error('vcfops.rule.secret-in-url', 'The webhook URL carries a secret in its query string.', {
            remediation: 'It will be stored on the plugin instance, exported with the content, and written to every log along the way. Put the secret in the plugin’s authentication or a header instead.',
            source: 'ArchToolKit',
          }),
        );
      }

      // Fields as documented for POST /api/notifications/rules. There is no
      // enabled flag and no URL here: the URL belongs to the plugin instance.
      const payload = {
        name: ruleName,
        pluginId: `<REQUIRED — the id of the webhook plugin instance that posts to ${endpoint || 'your endpoint'}>`,
        templateId: '<VERIFY — the payload template id, if your webhook plugin uses payload templates; delete this line if it does not>',
        alertControlStates: ['OPEN'],
        alertStatuses: ['NEW', 'UPDATED', ...(onCancel ? ['CANCELED'] : [])],
        ...(criticalities.length > 0 ? { criticalities } : {}),
        ...(kinds.length > 0 ? { resourceKindFilters: kinds.map((kind) => ({ adapterKind: 'VMWARE', resourceKind: kind })) } : {}),
        ...(alertIds.length > 0 ? { alertDefinitionIdFilters: { values: alertIds } } : {}),
      };

      const rulesExport = `${JSON.stringify({ NotificationRules: [{ ...payload, enabled: true }] }, null, 2)}\n`;
      // The 9.x rule takes an enabled flag (POST /api/notifications/rules); the
      // workflow fills pluginId and templateId from what it finds by name.
      const { pluginId: _pluginId, templateId: _templateId, ...ruleBody } = payload;
      const pkg = opsPackage({
        parts: ['rule', base],
        folder: `rule-${base}`,
        description: `Creates the notification rule "${ruleName}" through the webhook outbound instance that posts to ${endpoint.split('?')[0] || 'your endpoint'}, once.`,
        workflowName: `Create rule ${opsPart(base)}`,
        workflowDescription: `Finds the webhook outbound instance (pluginName, or the one whose URL is the endpoint) and the payload template, and creates the notification rule "${ruleName}" unless one of that name exists.`,
        changes: true,
        cap: 1,
        outputs: [{ name: 'ruleId', type: 'string', description: 'The notification rule id, empty in a dry run' }],
        account: 'An account that may manage notification rules',
        settings: [
          { name: 'endpoint', type: 'string', value: endpoint, description: 'The webhook URL, to find the outbound instance that posts to it' },
          { name: 'pluginName', type: 'string', value: '', description: 'Or the webhook outbound instance, by name' },
          { name: 'payloadTemplate', type: 'string', value: '', description: 'Optional: the payload template, by name' },
        ],
        resources: [{ name: 'rule.json', content: `${JSON.stringify({ ...ruleBody, enabled: true }, null, 2)}\n` }],
        body: NOTIFY_BODY,
        after: String.raw`ruleId = ctx.dryRun ? "" : (ruleRef || "");
summary = core.audit(ctx, { ruleId: ruleId });
core.notify(settings.webhook, summary);`,
      });

      return {
        platform: PLATFORM,
        title: `${ruleName} — post matching alerts to a webhook`,
        effect: 'read',
        trigger: {
          kind: 'alert',
          detail: alertIds.length > 0 ? `${alertIds.length} named alert definitions, at ${criticalities.join(' or ') || 'any severity'}` : `Any alert definition at ${criticalities.join(' or ') || 'any severity'}${kinds.length > 0 ? ` on ${kinds.join(', ')}` : ''}`,
          worstCase: `once when each alert is raised, again each time it is updated${onCancel ? ', and once when it is cancelled' : ''}`,
        },
        scope: {
          what: kinds.length > 0 ? `Alerts on ${kinds.join(', ')}.` : 'Alerts on every object kind.',
          decidedBy: [
            'The severity filter on this rule.',
            kinds.length > 0 ? `The object-kind filter: ${kinds.join(', ')}.` : 'No object-kind filter, so every kind.',
            alertIds.length > 0 ? `${alertIds.length} named alert definitions.` : 'No named alerts, so every definition that passes the filters.',
            'Whether each of those alert definitions is enabled in the policy that applies to the object.',
          ],
          ifWrong: 'The endpoint receives more than it can cope with and somebody mutes it, which is worse than never having built it.',
        },
        guardrails: [
          { rule: 'Severity and object kind are filtered', because: 'An unfiltered rule posts every informational alert in the estate and trains people to ignore the channel.' },
          { rule: 'Open alerts only', because: 'alertControlStates is OPEN, so an alert somebody has suspended or suppressed stops posting.' },
          { rule: 'The workflow is a dry run until dryRun is false, and creates the rule once, by name', because: 'Two rules with the same filters post every alert twice.' },
        ],
        dryRun: [
          `Run the workflow Create rule ${opsPart(base)} with dryRun = true: it finds the outbound instance and logs the rule it would create.`,
          'Point the webhook plugin at a request bin first, apply this rule, and let it run for an hour.',
          'Count what arrives. That count is what the endpoint has to survive on a bad night, not on a quiet one.',
        ],
        undo: [
          'DELETE /suite-api/api/notifications/rules/{id} with the id the apply script printed (verify the call on your release), or delete the rule in the interface.',
          'Deleting the rule leaves the webhook plugin in place for anything else that uses it.',
        ],
        told: ['The webhook endpoint itself. Nothing else is notified — this rule replaces no mailbox unless you delete the mailbox rule as well.'],
        requires: [
          `A webhook plugin instance whose URL is ${endpoint || 'your endpoint'} — the outbound plugin automation in this kit generates one — and its id.`,
          'For the fallback script: VCFOPS_TOKEN, or VCFOPS_USER with VCFOPS_PASSWORD_FILE so the script logs in for itself.',
          OPS_PACKAGE_REQUIRES,
        ],
        files: {
          ...pkg.files,
          [`scripts/${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'scripts/apply.sh': inScripts(applyScript(PLATFORM, [{ method: 'POST', path: '/suite-api/api/notifications/rules', payload: `${base}.json` }], 'DELETE /suite-api/api/notifications/rules/{id}, or delete the rule in the interface.')),
          'import/notification-rule.json': rulesExport,
          ...contentPackage({ 'notificationrules.json': rulesExport }, { notificationRules: 1 }),
          'import-content.sh': contentImportScript({ what: `the notification rule "${ruleName}"`, contentType: 'NOTIFICATION_RULES', needles: [`"name": ${JSON.stringify(ruleName)}`, `"name":${JSON.stringify(ruleName)}`] }),
          'IMPORT.md': importMd({
            title: `the notification rule "${ruleName}"`,
            steps: [
              { heading: 'First, the webhook outbound instance', files: [], how: ['Generate "An outbound plugin (webhook, email, …)" in this kit, or add one under Configure → Alerts → Outbound Settings. The workflow finds it by pluginName or by its URL; for the files below, put its id (GET /suite-api/api/alertplugins → pluginId) in place of the <REQUIRED> pluginId, and remove templateId if the plugin uses no payload template.'] },
              ...packageSteps(pkg, 'the workflow that creates the rule'),
              { heading: 'Or: the rule, by the fallback script', files: [`scripts/${base}.json`, 'scripts/apply.sh'], how: ['./scripts/apply.sh --execute — POST /suite-api/api/notifications/rules.'] },
              {
                heading: 'Or: the rule as a file',
                files: ['import/notification-rule.json'],
                how: ['Configure → Alerts → Notifications → ⋯ → Import, and choose import/notification-rule.json: {"NotificationRules": [the rule]}, the wrapper a content export uses.'],
                verify: ['the notification-rule import in the interface and its file shape are not documented; the wrapper is the one content exports hold, and the rule inside is the REST body. If the dialog rejects it, use the workflow or scripts/apply.sh.'],
              },
              contentStep('NOTIFICATION_RULES'),
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          'The plugin id is not guessable. GET /suite-api/api/alertplugins and take the pluginId of the webhook instance you mean — the workflow does this for you.',
          'The 9.x reference gives the rule an enabled flag (and GET /suite-api/api/notifications/rules lists them under "rules"); the workflow creates the rule enabled.',
          'The URL, any authentication and how often a message may be repeated are properties of the plugin instance, not of this rule. The documented rule has no resend setting; if your release offers one in the interface, set it there and record that you did.',
          'Filters are "empty means everything" in both directions: a rule with nothing set covers the estate, and a rule with an object-kind filter silently stops covering an adapter somebody adds next year.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfops_scope_group',
    platform: PLATFORM,
    label: 'A custom group to scope automation',
    group: 'Scope',
    description:
      'The group that decides what an automation may touch. Built with an exclusion tag in it from the start, so an object can be taken out of scope by tagging it rather than by editing the automation at two in the morning.',
    inputs: [
      { id: 'group_name', label: 'Group name', control: 'text', default: 'Automation — safe to act on' },
      {
        id: 'object_kind',
        label: 'Object kind',
        control: 'select',
        options: [
          { value: 'VirtualMachine', label: 'Virtual machines' },
          { value: 'HostSystem', label: 'ESXi hosts' },
          { value: 'Datastore', label: 'Datastores' },
          { value: 'ClusterComputeResource', label: 'Clusters' },
        ],
        default: 'VirtualMachine',
      },
      { id: 'include_tag', label: 'Include objects tagged', control: 'text', default: 'automation:allowed', hint: 'An opt-in tag. Safer than opting the estate in and excluding from it' },
      { id: 'exclude_tag', label: 'Never touch objects tagged', control: 'text', default: 'automation:never', hint: 'The escape hatch. Leave this set' },
      { id: 'name_excludes', label: 'Never touch names containing', control: 'text', default: 'dc, sql, prod-db', hint: 'A crude second net, on purpose' },
      { id: 'policy_name', label: 'Put the group on this policy', control: 'text', default: 'Production Policy' },
    ],
    automation: (values                 , name        )             => {
      const groupName = str(values, 'group_name', 'Automation scope');
      const kind = str(values, 'object_kind', 'VirtualMachine');
      const includeTag = str(values, 'include_tag', '');
      const excludeTag = str(values, 'exclude_tag', '');
      const nameExcludes = listOf(str(values, 'name_excludes', ''));
      const policy = str(values, 'policy_name', 'Default Policy');
      const base = slugOf(name || groupName, 'custom-group');

      const findings            = [];
      if (!excludeTag) {
        findings.push(
          warning('vcfops.group.no-escape', 'There is no exclusion tag on this group.', {
            remediation: 'Without one, taking a single object out of scope means editing the group while the automation is live. Set one and leave it set.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!includeTag) {
        findings.push(
          warning('vcfops.group.opt-out', 'This group opts the whole object kind in and then excludes from it.', {
            remediation: 'An opt-in tag is the safer shape: anything new is outside the automation until somebody says otherwise, rather than inside it until somebody notices.',
            source: 'ArchToolKit',
          }),
        );
      }

      const payload = {
        resourceKey: {
          name: groupName,
          adapterKindKey: 'Container',
          resourceKindKey: 'Environment',
          resourceIdentifiers: [],
        },
        policy: '<REQUIRED — the id of the policy named below>',
        autoResolveMembership: true,
        membershipDefinition: {
          includedResources: [],
          excludedResources: [],
          rules: [
            {
              resourceKindKey: { resourceKind: kind, adapterKind: 'VMWARE' },
              propertyConditionRules: [
                ...(includeTag ? [{ key: 'summary|tag', stringValue: includeTag, compareOperator: 'CONTAINS' }] : []),
                ...(excludeTag ? [{ key: 'summary|tag', stringValue: excludeTag, compareOperator: 'NOT_CONTAINS' }] : []),
              ],
              resourceNameConditionRules: nameExcludes.map((fragment) => ({ name: fragment, compareOperator: 'NOT_CONTAINS' })),
              statConditionRules: [],
              relationshipConditionRules: [],
              resourceTagConditionRules: [],
            },
          ],
        },
      };

      // The same group in the shape Custom Groups → Export writes (notoriousbdg exports).
      const rules              = [
        ...(includeTag ? [{ ruleType: 'StringMetricPropertyRule'         , ruleMetricKey: 'summary|tag', isProperty: true, ruleStringOperator: 'CONTAINS', ruleStringValue: includeTag }] : []),
        ...(excludeTag ? [{ ruleType: 'StringMetricPropertyRule'         , ruleMetricKey: 'summary|tag', isProperty: true, ruleStringOperator: 'NOT_CONTAINS', ruleStringValue: excludeTag }] : []),
        ...nameExcludes.map((fragment) => ({ ruleType: 'ResourceNameRule'         , ruleStringOperator: 'NOT_CONTAINS', ruleStringValue: fragment })),
      ];
      const groupExport = customGroupsJson([
        { name: groupName, description: `Generated by ArchToolKit. Put on the policy "${policy}".`, groupType: 'Environment', autoResolve: true, ruleGroups: [{ adapterKind: 'VMWARE', resourceKind: kind, rules }] },
      ]);

      // The 9.x API assigns a group with PUT /api/policies/{id}/assign
      // {groupIds}; the workflow uses that rather than the group's policy field.
      const { policy: _policy, ...groupBody } = payload;
      const pkg = opsPackage({
        parts: ['group', base],
        folder: `group-${base}`,
        description: `Creates the custom group "${groupName}" and assigns "${policy}" to it, once.`,
        workflowName: `Create group ${opsPart(base)}`,
        workflowDescription: `Creates the custom group "${groupName}" unless one of that name exists (left as it is), then assigns "${policy}" to it.`,
        changes: true,
        cap: 2,
        outputs: [{ name: 'groupId', type: 'string', description: 'The custom group id, empty in a dry run' }],
        account: 'An account that may create custom groups and assign policies',
        settings: [{ name: 'policyName', type: 'string', value: policy, description: 'Assigned to the group, by name' }],
        resources: [{ name: 'group.json', content: `${JSON.stringify(groupBody, null, 2)}\n` }],
        body: SCOPE_BODY,
        after: String.raw`groupId = ctx.dryRun ? "" : (groupRef || "");
summary = core.audit(ctx, { groupId: groupId });
core.notify(settings.webhook, summary);`,
      });

      return {
        platform: PLATFORM,
        title: `${groupName} — the scope an automation may act on`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Nothing. A group does not act; it decides what may be acted on.' },
        scope: {
          what: `${kind} objects${includeTag ? ` tagged ${includeTag}` : ''}${excludeTag ? `, never those tagged ${excludeTag}` : ''}.`,
          decidedBy: [
            `Object kind: ${kind}.`,
            includeTag ? `Must carry the tag ${includeTag}.` : 'No opt-in tag — every object of that kind is a candidate.',
            excludeTag ? `Must not carry the tag ${excludeTag}.` : 'No exclusion tag.',
            nameExcludes.length > 0 ? `Name must not contain: ${nameExcludes.join(', ')}.` : 'No name exclusions.',
          ],
          ifWrong: 'Every automation scoped to this group inherits the mistake at once. This is the single object worth reviewing twice.',
        },
        guardrails: [
          ...(excludeTag ? [{ rule: `Anything tagged ${excludeTag} is out`, because: 'Somebody needs a way to take one object out of an automation at speed without editing the automation.' }] : []),
          ...(nameExcludes.length > 0 ? [{ rule: `Names containing ${nameExcludes.join(', ')} are out`, because: 'A crude second net, deliberately. Tags get removed by accident; a naming convention rarely does.' }] : []),
          { rule: 'Membership resolves automatically', because: 'A group with fixed members drifts out of date silently, which is the other way scope goes wrong.' },
        ],
        dryRun: [
          `Run the workflow Create group ${opsPart(base)} with dryRun = true: it logs what it would create and assign.`,
          'Create the group, open it, and read the member list before any automation points at it.',
          'Compare the count against what you expected. If it is within an order of magnitude, look again.',
        ],
        undo: ['DELETE /suite-api/api/resources/groups/{id}. Deleting a group does not touch its members.'],
        told: ['Nobody. A group is configuration; it is the automations pointed at it that act.'],
        requires: [`The policy "${policy}" to exist (the workflow finds it by name; the fallback script needs its id — GET /suite-api/api/policies).`, OPS_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          [`scripts/${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'scripts/apply.sh': inScripts(applyScript(PLATFORM, [{ method: 'POST', path: '/suite-api/api/resources/groups', payload: `${base}.json` }], 'DELETE /suite-api/api/resources/groups/{id}. Deleting a group does not touch its members.')),
          'import/custom-group.json': groupExport,
          ...contentPackage({ 'customgroups.json': groupExport }, { customGroups: 1 }),
          'import-content.sh': contentImportScript({ what: `the custom group "${groupName}"`, contentType: 'CUSTOM_GROUPS', needles: [`"name": ${JSON.stringify(groupName)}`, `"name":${JSON.stringify(groupName)}`] }),
          'IMPORT.md': importMd({
            title: `the custom group "${groupName}"`,
            steps: [
              ...packageSteps(pkg, 'the workflow that creates the group and assigns it'),
              {
                heading: 'Or: the group, as a file',
                files: ['import/custom-group.json'],
                how: [
                  'Inventory → Custom Groups → ⋯ → Import (8.x: Environment → Custom Groups → gear → Import Custom Group(s)), and choose import/custom-group.json — {"customGroups": [...]} in the shape the interface exports, one rule group for the object kind, every rule in it required.',
                  `Then open the group, check the member count, and set its policy to "${policy}" (the export shape has no policy).`,
                ],
                verify: nameExcludes.length > 0 ? ['the name rules are written as ruleType "ResourceNameRule" with ruleStringOperator NOT_CONTAINS; the tag rules as a StringMetricPropertyRule on summary|tag, the type real exports use. Check the name rules survived the import in the group editor.'] : [],
              },
              {
                heading: 'Or by the fallback script',
                files: [`scripts/${base}.json`, 'scripts/apply.sh'],
                how: ['Fill in the policy id, then ./scripts/apply.sh --execute — POST /suite-api/api/resources/groups.'],
                verify: ['the "policy" field in the POST body: the 9.x reference assigns groups with PUT /suite-api/api/policies/{id}/assign {"groupIds": [...]}, which the workflow uses. If the group arrives on the default policy, assign it that way or in the interface.'],
              },
              contentStep('CUSTOM_GROUPS'),
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          `Put the group on "${policy}" rather than the default policy. A group on the default policy gets the same thresholds as everything else, which makes the group pointless.`,
          'Tag conditions read vSphere tags through summary|tag. The tag has to be assigned in vCenter, and the adapter has to have collected since.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfops_reclaim_schedule',
    platform: PLATFORM,
    label: 'Reclaim idle and oversized VMs on a schedule',
    group: 'Automation Central',
    description:
      'The reclamation most estates talk about and few turn on: old snapshots, long powered-off VMs, oversized VMs. Generated as a script rather than a job, because the guardrails that matter — a cap on how much one run may touch, a list read before anything acts — are only real if something enforces them. The script does; Automation Central has no per-run cap.',
    inputs: [
      { id: 'job_name', label: 'Job name', control: 'text', default: 'Monthly reclamation' },
      {
        id: 'what',
        label: 'What to reclaim',
        control: 'select',
        options: [
          { value: 'snapshots', label: 'Delete snapshots older than N days' },
          { value: 'powered-off', label: 'Delete VMs powered off for N days' },
          { value: 'oversized', label: 'List oversized VMs (report only)' },
        ],
        default: 'snapshots',
      },
      { id: 'older_than', label: 'Older than (days)', control: 'number', default: 30, min: 1, max: 365, showWhen: { input: 'what', equals: ['snapshots', 'powered-off'] } },
      { id: 'group_name', label: 'Only within group', control: 'text', default: 'Automation — safe to act on' },
      { id: 'max_objects', label: 'Never touch more than (objects per run)', control: 'number', default: 25, min: 1, max: 500 },
      { id: 'window', label: 'Run at', control: 'text', default: 'Sunday 02:00', hint: 'Day and 24-hour time, in the time zone of the host that runs it. Outside the change freeze, inside the maintenance window' },
    ],
    automation: (values                 , name        )             => {
      const jobName = str(values, 'job_name', 'Reclamation');
      const what = str(values, 'what', 'snapshots');
      const olderThan = num(values, 'older_than', 30);
      const group = str(values, 'group_name', 'Automation — safe to act on');
      const cap = num(values, 'max_objects', 25);
      const window = str(values, 'window', 'Sunday 02:00');
      const base = slugOf(name || jobName, 'reclaim');

                      
                               
                                                 
                                
                               
                                                                                        
                                 
                                  
                                   
                                     
                                
       
      const WHAT                       = {
        snapshots: {
          title: `delete snapshots older than ${olderThan} days`,
          effect: 'irreversible',
          undo: ['A deleted snapshot cannot be restored. What it protected is gone with it.', 'The only real undo is a backup of the VM taken before the run.'],
          query: `the stat Disk Space|Snapshot|Age (Days) is ${olderThan} or more`,
          statKey: 'diskspace|snapshot|age',
          statNote: 'VERIFY: the key of "Disk Space|Snapshot|Age (Days)". Check it with GET /suite-api/api/resources/{id}/statkeys on one VM that has a snapshot.',
          threshold: olderThan,
          requireOff: false,
          action: 'Delete Unused Snapshots for VM',
        },
        'powered-off': {
          title: `delete VMs powered off for more than ${olderThan} days`,
          effect: 'irreversible',
          undo: ['Restore from backup. There is no other way back.'],
          query: `powered off now (sys|poweredOn is 0), and a powered-off-duration stat of ${olderThan * 1440} minutes or more`,
          statKey: '',
          statNote: 'REQUIRED: VCF Operations has no built-in "powered off for N days" metric. Create a super metric that counts minutes powered off (reset when sys|poweredOn is 1) and set STAT_KEY to its key. It only counts from the day it is created.',
          threshold: olderThan * 1440,
          requireOff: true,
          action: 'Delete Powered Off VM',
        },
        oversized: {
          title: 'list oversized VMs',
          effect: 'read',
          undo: ['Nothing to undo. It lists; it does not resize.'],
          query: 'the stat summary|oversized is 1',
          statKey: 'summary|oversized',
          statNote: 'VERIFY: the key of the Oversized flag on a VM, with GET /suite-api/api/resources/{id}/statkeys.',
          threshold: 1,
          requireOff: false,
          action: '',
        },
      };
      const spec = WHAT[what] ?? WHAT['snapshots'] ;
      const acts = spec.effect !== 'read';

      const findings            = [];
      if (acts && cap > 100) {
        findings.push(
          warning('vcfops.reclaim.cap', `A cap of ${cap} objects in one run is high for something that cannot be undone.`, {
            remediation: 'The cap exists so that a wrong scope is a small incident rather than a large one. Twenty-five is a sensible first number.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (what === 'powered-off' && olderThan < 30) {
        findings.push(
          warning('vcfops.reclaim.hasty', `Deleting VMs powered off for only ${olderThan} days will catch machines somebody turned off on purpose last month.`, {
            remediation: 'Ninety days is the number most estates settle on, with a move-to-folder phase first.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (what === 'powered-off') {
        findings.push(
          info('vcfops.reclaim.no-off-metric', 'How long a VM has been powered off is not a built-in metric, so this needs a super metric before it can find anything.', {
            remediation: 'Create the super metric, let it run past the threshold, and only then schedule this. Until it has, every VM looks recently powered off.',
            source: 'ArchToolKit',
          }),
        );
      }

      const cron = cronOf(window);
      const script = [
        '#!/usr/bin/env bash',
        `# ${jobName}: ${spec.title}, within the custom group "${group}".`,
        '#',
        acts
          ? `# Without --execute this lists what it would act on and changes nothing. With it, it acts on at most ${cap} of them, largest first, through the VCF Operations action API, and writes what it sent to a log.`
          : '# Reads only. It lists; there is no --execute.',
        '#',
        '# Scope is the group members, filtered by one stat. Members that do not report the stat are left out.',
        'set -euo pipefail',
        '',
        ...authPreamble(PLATFORM),
        `: "\${GROUP_ID:?set GROUP_ID to the id of the custom group \\"${group}\\"}"`,
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        `MAX_OBJECTS=${cap}  # the cap. Change it here, in review, not on the command line.`,
        `THRESHOLD=${spec.threshold}`,
        `# ${spec.statNote}`,
        spec.statKey ? `STAT_KEY="\${STAT_KEY:-${spec.statKey}}"` : ': "${STAT_KEY:?set STAT_KEY to the key of your powered-off-duration super metric, in minutes}"',
        `REQUIRE_OFF=${spec.requireOff}`,
        'LOG_DIR="${LOG_DIR:-.}"',
        '',
        'EXECUTE=0',
        ...(acts ? ['[[ "${1:-}" == "--execute" ]] && EXECUTE=1'] : ['[[ "${1:-}" == "--execute" ]] && { echo "This one is report only." >&2; exit 2; }']),
        '',
        'api() {',
        '  local method="$1" path="$2"; shift 2',
        `  curl -sS -f -X "$method" "https://\${VCFOPS_HOST}\${path}" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" "$@"`,
        '}',
        '',
        'members=$(api GET "/suite-api/api/resources/groups/${GROUP_ID}/members?pageSize=10000" |',
        `  jq -c '[.resourceList[]? | select(.resourceKey.resourceKindKey == "VirtualMachine") | {id: .identifier, name: .resourceKey.name}]')`,
        'if [[ "$(jq length <<<"$members")" == 0 ]]; then',
        '  echo "The group has no VM members. Nothing to do."',
        '  exit 0',
        'fi',
        '',
        'stats=$(jq -n --argjson m "$members" --arg k "$STAT_KEY" \'{resourceId: [$m[].id], statKey: [$k, "sys|poweredOn"], maxSamples: 1}\' |',
        '  api POST /suite-api/api/resources/stats/latest/query -H "Content-Type: application/json" --data @-)',
        '',
        'candidates=$(jq -c --argjson m "$members" --arg k "$STAT_KEY" --argjson t "$THRESHOLD" --argjson off "$REQUIRE_OFF" \'',
        '  ($m | map({(.id): .name}) | add) as $names',
        '  | [ .values[]?',
        '      | .resourceId as $id',
        '      | ([."stat-list".stat[]? | {(.statKey.key): ((.data // []) | last)}] | add // {}) as $s',
        '      | {id: $id, name: $names[$id], value: $s[$k], on: $s["sys|poweredOn"]}',
        '      | select(.value != null and .value >= $t)',
        '      | select(($off | not) or .on == 0) ]',
        '  | sort_by(-.value)\' <<<"$stats")',
        '',
        'total=$(jq length <<<"$candidates")',
        'echo "${total} of the group\'s VMs match (${STAT_KEY} >= ${THRESHOLD})."',
        'jq -r \'.[] | "  \\(.value)\\t\\(.name)\\t\\(.id)"\' <<<"$candidates"',
        ...(acts
          ? [
              'selected=$(jq -c --argjson n "$MAX_OBJECTS" \'.[:$n]\' <<<"$candidates")',
              'if (( total > MAX_OBJECTS )); then',
              '  echo "WARNING: ${total} match; only the first ${MAX_OBJECTS} would be acted on. The rest wait for the next run." >&2',
              'fi',
              '',
              'if (( ! EXECUTE )); then',
              '  if [[ -n "${ACTION_ID:-}" && "$total" != 0 ]]; then',
              '    echo "What the action would be sent for the first of them (populated, not run):"',
              '    jq -n --arg id "$(jq -r \'.[0].id\' <<<"$selected")" \'{contextResourceId: [$id]}\' |',
              '      api POST "/suite-api/api/actions/${ACTION_ID}/query" -H "Content-Type: application/json" --data @- | jq \'.actionExecution // .["action-execution"]\'',
              '  fi',
              '  echo "DRY RUN: nothing was changed. Read the list in full, then re-run with --execute."',
              '  exit 0',
              'fi',
              '',
              `: "\${ACTION_ID:?set ACTION_ID: GET /suite-api/api/actiondefinitions and take the id of the action named like \\"${spec.action}\\"}"`,
              'LOG="${LOG_DIR}/reclaim-$(date +%Y%m%d-%H%M%S).log"',
              'for id in $(jq -r \'.[].id\' <<<"$selected"); do',
              '  body=$(jq -n --arg id "$id" \'{contextResourceId: [$id]}\' |',
              '    api POST "/suite-api/api/actions/${ACTION_ID}/query" -H "Content-Type: application/json" --data @- |',
              '    jq -c \'.actionExecution // .["action-execution"]\')',
              '  if [[ -z "$body" || "$body" == null ]]; then',
              '    echo "The action could not be populated for ${id}; stopping here." >&2',
              '    exit 1',
              '  fi',
              '  echo "$(date -u +%FT%TZ) send ${id} ${body}" >>"$LOG"',
              '  task=$(api POST "/suite-api/api/actions/${ACTION_ID}" -H "Content-Type: application/json" --data "$body" | jq -r \'.values[]?\')',
              '  echo "$(date -u +%FT%TZ) ${id} task ${task}" | tee -a "$LOG"',
              'done',
              'echo "Done. Check each task with GET /suite-api/api/actions/{taskId}/status; the log is ${LOG}."',
            ]
          : ['(( total > 0 )) && exit 1', 'exit 0']),
        '',
      ].join('\n');

      const crontab = [
        `# ${jobName}. Written disabled: the line below is commented out.`,
        '# Uncomment it only after a dry run has been read in full, and after GROUP_ID',
        `# and ${acts ? 'ACTION_ID' : 'STAT_KEY if you changed it'} have been checked. Cron runs in the host's time zone.`,
        '# No secret here: the script logs in from the password file.',
        '# With the Orchestrator package, schedule the workflow in Orchestrator instead and leave this out.',
        `# ${cron} ${scheduledEnv(PLATFORM)} GROUP_ID=<id>${acts ? ' ACTION_ID=<id>' : ''}${spec.statKey ? '' : ' STAT_KEY=<key>'} LOG_DIR=/var/log/archtoolkit /opt/archtoolkit/${base}.sh${acts ? ' --execute' : ''} >>/var/log/archtoolkit/${base}.log 2>&1`,
        '',
      ].join('\n');

      // The package reads and acts like the script: the group's VMs, one stat
      // each, largest first, at most cap of them, each action populated by the
      // action API before it is sent. The cap is the configuration element's.
      const pkg = opsPackage({
        parts: ['reclaim', base],
        folder: `reclaim-${base}`,
        description: `${jobName}: ${spec.title}, within the custom group "${group}"${acts ? `, at most ${cap} per run` : ''}.`,
        workflowName: `Reclaim ${opsPart(base)}`,
        workflowDescription: `Reads the VMs of "${group}" and the stat ${spec.statKey || 'statKey'} of each, lists those at or above ${spec.threshold}${spec.requireOff ? ' that are powered off now' : ''}, largest first${acts ? `, and runs the action "${spec.action}" on at most cap of them, each populated by POST actions/{id}/query before it is sent` : ''}.`,
        changes: acts,
        cap,
        outputs: [
          { name: 'matchCount', type: 'number', description: 'VMs that match' },
          { name: 'matchesJson', type: 'string', description: 'The matches, largest first: [{id, name, value}]' },
        ],
        account: acts ? 'An account that may run the action' : 'A read-only account',
        settings: [
          { name: 'groupName', type: 'string', value: group, description: 'Only VMs in this custom group' },
          { name: 'statKey', type: 'string', value: spec.statKey, description: spec.statNote },
          { name: 'threshold', type: 'number', value: spec.threshold, description: 'A VM matches at or above this value' },
          { name: 'requireOff', type: 'boolean', value: spec.requireOff, description: 'Also require the VM to be powered off now' },
          ...(acts ? [{ name: 'actionId', type: 'string'         , value: '', description: `The id of the action named like "${spec.action}" (GET /suite-api/api/actiondefinitions)` }] : []),
        ],
        body: reclaimBody(acts, spec.action),
        after: acts
          ? String.raw`matchCount = candidates.length;
matchesJson = JSON.stringify(candidates);
summary = core.audit(ctx, { matched: candidates.length, tasks: tasks });
core.notify(settings.webhook, summary);`
          : String.raw`matchCount = candidates.length;
matchesJson = JSON.stringify(candidates);
summary = core.audit(null, { matched: candidates.length });
core.notify(settings.webhook, summary);`,
      });

      return {
        platform: PLATFORM,
        title: `${jobName} — ${spec.title}`,
        effect: spec.effect,
        trigger: { kind: 'schedule', detail: `${window}, from cron on the host that runs it`, worstCase: acts ? `once a week, up to ${cap} objects each time` : 'once a week, a list' },
        scope: {
          what: `VMs in the custom group "${group}" where ${spec.query}.`,
          decidedBy: [
            `Membership of the custom group "${group}", read at the start of each run.`,
            `The stat: ${spec.query}. A VM that does not report it is left out.`,
            ...(acts ? [`The cap: at most ${cap} objects in any one run, largest value first.`] : []),
            ...(acts ? [`What the action "${spec.action}" does with the parameters VCF Operations populates for it — the dry run prints them.`] : []),
          ],
          ifWrong: acts
            ? `Up to ${cap} objects are destroyed per run, and they do not come back. This is why the cap is in the script and the schedule is written commented out.`
            : 'A wrong list, read by somebody who then acts on it by hand.',
        },
        guardrails: [
          ...(acts
            ? [
                { rule: `At most ${cap} objects in one run, enforced by the script`, because: 'A wrong scope with a cap is an incident; a wrong scope without one is an outage.' },
                { rule: 'Dry run unless --execute is given', because: 'The list it prints is the only place a wrong scope is visible before it acts.' },
                { rule: 'The crontab line is written commented out, the workflow is a dry run until dryRun is false in its configuration element, and nothing schedules it', because: 'Nothing generated here starts running because a file was copied or a package imported. Somebody has to turn it on deliberately.' },
                { rule: 'Stops at the first object the action cannot be populated for', because: 'An action that does not fit one VM is a sign it does not fit the rest.' },
              ]
            : [{ rule: 'It only reads', because: 'Resizing is a change a person makes from this list, not something a schedule does.' }]),
          ...(spec.requireOff ? [{ rule: 'Powered off now, as well as for long enough', because: 'A super metric that has stopped updating still says ninety days. The live power state is the second check.' }] : []),
          { rule: 'VMs that do not report the stat are left out', because: 'A missing number is not a zero, and it is not a match either.' },
        ],
        dryRun: [
          `Run the workflow Reclaim ${opsPart(base)}${acts ? ' with dryRun = true' : ''}: it logs every match with its value${acts ? ' and every "DRY RUN: would run …"' : ''}. Or run the script with no arguments: it prints every match with its value, and, if ACTION_ID is set, the action body it would send for the first.`,
          'Read the list in full — not the count, the list.',
          'Expect to find something in it that should not be. That is what the exclusion tag on the group is for.',
        ],
        undo: spec.undo,
        told: acts
          ? ['The script writes each object and the task id it started to a log in LOG_DIR.', 'Wire the log or the cron mail somewhere a person reads — a run log nobody reads is not a record.']
          : ['Whoever reads the cron output. It exits 1 when it finds anything, so a scheduler can alert on that.'],
        requires: [
          `The custom group "${group}" to exist and to be narrower than you first think, and its id in GROUP_ID.`,
          'jq, curl, and VCFOPS_USER with VCFOPS_PASSWORD_FILE for the scheduled run.',
          ...(acts ? [`The action "${spec.action}" (name as in your release — verify it) enabled, with a vCenter account that has the rights to do this and no more.`] : []),
          ...(spec.statKey ? [] : ['A super metric that measures how long a VM has been powered off.']),
          OPS_PACKAGE_REQUIRES,
        ],
        files: {
          ...pkg.files,
          [`scripts/${base}.sh`]: script,
          'crontab.txt': crontab,
          'IMPORT.md': importMd({
            title: jobName,
            intro: ['Nothing here is content VCF Operations imports: the package and the script act through its API. What goes where:'],
            steps: [
              ...packageSteps(pkg, `the workflow that ${acts ? 'reclaims' : 'lists'}`),
              {
                heading: 'Or: the script, from a Linux host',
                files: [`scripts/${base}.sh`, 'crontab.txt'],
                how: [
                  `scripts/${base}.sh goes on a host of your own (in /opt/archtoolkit) and crontab.txt in the service account's crontab.`,
                  'Run it by hand without --execute first: it lists what it would act on and stops. The crontab line stays commented out until that list has been read.',
                ],
              },
            ],
            sources: [`${API_REF} (Resources: POST /api/resources/stats/latest/query; Actions: POST /api/actions/{id}/query, POST /api/actions/{id}, GET /api/actions/{taskId}/status)`],
          }),
        },
        notes: [
          'Reclamation is where automation earns its keep and where it does the most damage. Both facts are about the same property: it acts on many objects at once.',
          `Scope comes from ${spec.statKey ? `the stat ${spec.statKey}` : 'STAT_KEY'}. ${spec.statNote}`,
          ...(acts ? ['The action body is whatever POST /suite-api/api/actions/{id}/query populates for each VM, sent back unchanged. If the populated parameters are not what you expect — which snapshots, which age — this script is not right for your release; stop and use the interface.'] : []),
          'Automation Central in the interface has a Reclaim job that does the same on a schedule, with a preview of the affected VMs. It has no per-run cap, which is why this is a script.',
          'Orphaned disks are not here: there is no documented suite-API call that lists them. Use the Reclaim page in the interface.',
          'The account the action runs as decides what is actually possible. Give it exactly the rights for this job rather than an administrator, and the blast radius is bounded by vCenter as well as by the cap.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfops_maintenance_window',
    platform: PLATFORM,
    label: 'Silence alerts during a maintenance window',
    group: 'Automation Central',
    description:
      'A recurring maintenance schedule so patching does not page anybody, plus the thing people forget: the check that it actually ended. A window that never closes is an estate with no alerting and nobody aware of it.',
    inputs: [
      { id: 'window_name', label: 'Window name', control: 'text', default: 'Monthly patching' },
      { id: 'group_name', label: 'Applies to group', control: 'text', default: 'Production hosts' },
      { id: 'policy_name', label: 'Through the policy', control: 'text', default: 'Production hosts — maintenance', hint: 'A maintenance schedule takes effect only as part of a policy, on every object that policy covers' },
      { id: 'starts', label: 'Starts', control: 'text', default: 'Third Saturday 22:00', hint: 'First, second, third, fourth or last; a weekday; a 24-hour time' },
      { id: 'hours', label: 'Length (hours)', control: 'number', default: 6, min: 1, max: 24 },
      { id: 'alert_on_overrun', label: 'Raise an alert if it has not ended', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const windowName = str(values, 'window_name', 'Maintenance');
      const group = str(values, 'group_name', 'Production hosts');
      const policy = str(values, 'policy_name', 'Production hosts — maintenance');
      const starts = str(values, 'starts', 'Third Saturday 22:00');
      const hours = num(values, 'hours', 6);
      const overrun = bool(values, 'alert_on_overrun', true);
      const base = slugOf(name || windowName, 'maintenance-window');

      const parsed = /^\s*(first|second|third|fourth|last)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(\d{1,2}):(\d{2})\s*$/i.exec(starts);
      const findings            = [];
      if (!overrun) {
        findings.push(
          error('vcfops.window.no-overrun-check', 'Nothing will tell you if this maintenance window fails to end.', {
            remediation: 'A window that stays open is an estate with alerting switched off and no symptom. Turn the overrun check on.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (hours > 12) {
        findings.push(
          warning('vcfops.window.long', `A ${hours}-hour window is a long time to be blind.`, {
            remediation: 'Consider two shorter windows rather than one long one, so the estate is watched between them.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!parsed) {
        findings.push(
          warning('vcfops.window.unparsed', `"${starts}" is not in the form "Third Saturday 22:00", so the schedule in the payload is left for you to fill in.`, {
            source: 'ArchToolKit',
          }),
        );
      }

      const hour = parsed ? Number(parsed[3]) : 0;
      const minute = parsed ? Number(parsed[4]) : 0;
      // Fields as documented for the maintenance-schedule and schedule data
      // structures. How MONTHLY combines weeksOfTheMonth with daysOfTheWeek is
      // not spelled out in the reference; the note says to check it.
      const schedule = {
        key: windowName,
        schedule: parsed
          ? {
              scheduleType: 'MONTHLY',
              months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
              weeksOfTheMonth: [parsed[1] .toUpperCase()],
              daysOfTheWeek: [parsed[2] .toUpperCase()],
              hour,
              minuteOfTheHour: minute,
              duration: hours * 60,
              timeZone: '<REQUIRED — the time zone the window is written in; the API defaults to the server’s. Check the accepted format against an existing schedule>',
            }
          : {
              scheduleType: '<REQUIRED — ONCE, DAILY, WEEKLY, MONTHLY or YEARLY>',
              hour: '<REQUIRED>',
              minuteOfTheHour: '<REQUIRED>',
              duration: hours * 60,
              timeZone: '<REQUIRED>',
            },
      };

      const checkAt = `${minute} ${(hour + hours + 1) % 24} * * *`;
      const check = readScript(PLATFORM, `Is anything still in maintenance that should not be? Run daily, an hour after "${windowName}" is due to end.`, [
        '# Every object VCF Operations has in maintenance right now, scheduled or manual.',
        '# This is estate-wide, not just this window: outside a window nothing should be',
        '# in maintenance, and anything that is has alerting off without a symptom.',
        'found=$(get "/suite-api/api/resources?resourceState=MAINTAINED&resourceState=MAINTAINED_MANUAL&pageSize=1000" |',
        '  jq -r \'.resourceList[]? | "\\(.resourceKey.resourceKindKey)\\t\\(.resourceKey.name)\\t\\(.identifier)"\')',
        'if [[ -n "$found" ]]; then',
        `  echo "WARNING: still in maintenance after \\"${windowName}\\" should have ended:" >&2`,
        '  echo "$found" >&2',
        '  echo "To end it for an object: DELETE /suite-api/api/resources/maintained?id=<identifier>" >&2',
        '  exit 1',
        'fi',
        'echo "Nothing is in maintenance."',
      ]);

      // Two packages: the schedule (a change) and the daily overrun check (a
      // read), each its own workflow on the same core library.
      const folder = `maintenance-${base}`;
      const pkg = opsPackage({
        parts: ['maintenance', base],
        folder,
        description: `Creates the maintenance schedule "${windowName}", once.`,
        workflowName: `Create maintenance window ${opsPart(base)}`,
        workflowDescription: `Creates the maintenance schedule "${windowName}" (${starts}, ${hours} hours, in timeZone) unless one with that key exists. Attaching it to "${policy}" is done in the interface: there is no API call for it.`,
        changes: true,
        cap: 1,
        outputs: [{ name: 'scheduleId', type: 'string', description: 'The maintenance schedule id, empty in a dry run' }],
        account: 'An account that may manage maintenance schedules',
        settings: [
          { name: 'timeZone', type: 'string', value: '', description: 'The time zone the window is written in, e.g. Europe/Amsterdam (the API otherwise uses the server’s)' },
          { name: 'policyName', type: 'string', value: policy, description: 'Named in the log: where the schedule is attached, by a person' },
        ],
        resources: [{ name: 'schedule.json', content: `${JSON.stringify(schedule, null, 2)}\n` }],
        body: MAINTENANCE_BODY,
        after: String.raw`scheduleId = ctx.dryRun ? "" : (scheduleRef || "");
summary = core.audit(ctx, { scheduleId: scheduleId });
core.notify(settings.webhook, summary);`,
      });
      const overrunPkg = overrun
        ? opsPackage({
            parts: ['maintenance', base, 'overrun'],
            folder,
            description: `Fails when anything is still in maintenance after "${windowName}" should have ended. Reads only.`,
            workflowName: `Maintenance overrun check ${opsPart(base)}`,
            workflowDescription: 'Lists every object VCF Operations has in maintenance (scheduled or manual) and fails the run when there is any, posting the list to the webhook first. Schedule it daily, an hour after the window is due to end.',
            changes: false,
            outputs: [{ name: 'inMaintenance', type: 'number', description: 'Objects still in maintenance' }],
            account: 'A read-only account',
            settings: [{ name: 'webhook', type: 'string', value: '', description: 'Where the list is posted when anything is still in maintenance' }],
            configName: 'Overrun check settings',
            body: OVERRUN_BODY,
            after: String.raw`inMaintenance = still.length;
summary = core.audit(null, { inMaintenance: inMaintenance });
if (still.length) {
  if (settings.webhook) core.notify(settings.webhook, summary);
  throw new Error(still.length + " object(s) still in maintenance after the window should have ended. To end it for one: DELETE /suite-api/api/resources/maintained?id=<identifier>.");
}
System.log("Nothing is in maintenance.");`,
          })
        : null;

      return {
        platform: PLATFORM,
        title: `${windowName} — stop alerting on "${group}" for ${hours} hours`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `${starts}, for ${hours} hours`, worstCase: `${hours} hours a month with no alerting and no collection on everything the policy covers` },
        scope: {
          what: `Every object the policy "${policy}" covers, of the object type the schedule is set on in that policy — which should be exactly the group "${group}".`,
          decidedBy: [
            `The policy "${policy}": the schedule has no effect until it is part of a policy.`,
            `The groups that policy is assigned to — "${group}" and nothing else, if this is right.`,
            'The object type the schedule is selected on inside the policy.',
            'Policy priority: a higher-priority policy on the same object wins, and then this window does not apply to it.',
          ],
          ifWrong: 'Collection and alerting are off for objects you did not mean to include, for the length of the window, and nothing reports that they are off.',
        },
        guardrails: [
          { rule: `Bounded to ${hours} hours`, because: 'A maintenance schedule with no end is the commonest way an estate ends up unmonitored for a month.' },
          ...(overrun ? [{ rule: 'A daily check exits 1 if anything is still in maintenance', because: 'This is the only symptom of a window that stuck open. Without it, nothing is wrong and nothing is watching.' }] : []),
        ],
        dryRun: [
          `Run the workflow Create maintenance window ${opsPart(base)} with dryRun = true (or scripts/apply.sh with no arguments): it logs what it would create.`,
          `After attaching it to "${policy}", open two or three objects in "${group}" and check that the policy shown is "${policy}" — then one object outside the group, to check it is not.`,
        ],
        undo: [
          'Remove the schedule from the policy, or delete it: DELETE /suite-api/api/maintenanceschedules with its id (check the parameter name on your release), or Delete under Maintenance Schedules in the interface.',
          'To end a window early for an object: DELETE /suite-api/api/resources/maintained?id=<identifier>. Collection resumes; what happened during the window was not collected and is not replayed.',
        ],
        told: overrun ? ['Whoever reads the overrun check’s output. It exits 1, so the scheduler that runs it can alert. Send it somewhere a human reads at the weekend, because that is when this runs.'] : ['Nobody. Consider turning the overrun check on.'],
        requires: [`The custom group "${group}".`, `A policy "${policy}" assigned to that group and nothing else.`, OPS_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          ...(overrunPkg ? overrunPkg.files : {}),
          'IMPORT.md': importMd({
            title: `the maintenance window "${windowName}"`,
            steps: [
              ...packageSteps(pkg, 'the workflow that creates the schedule'),
              ...(overrunPkg
                ? [{ heading: 'And the overrun check — a second package on the same core library', files: [overrunPkg.packageDir], how: [`Import ${overrunPkg.packageDir.slice('import/'.length)} the same way, fill opsHost, opsUsername and opsPassword in its configuration element "Overrun check settings", and schedule the workflow Maintenance overrun check ${opsPart(base)} daily, an hour after the window is due to end. It only reads, and fails the run when anything is still in maintenance.`] }]
                : []),
              { heading: 'Or: the schedule by the fallback script', files: [`scripts/${base}.json`, 'scripts/apply.sh'], how: ['Fill in the <REQUIRED> time zone, then ./scripts/apply.sh --execute — POST /suite-api/api/maintenanceschedules. Or add it by hand under Configurations → Maintenance Schedules. There is no file import for maintenance schedules.'] },
              { heading: 'Attach it to the policy — in the interface', files: ['attach-to-policy.txt'], how: [`As attach-to-policy.txt says: the schedule takes effect only through "${policy}", and the 9.x API has no call that attaches it (the Policies API assigns groups and edits capacity, pricing and workload-automation settings only).`] },
              ...(overrun ? [{ heading: 'Or: the overrun check by script', files: ['scripts/overrun-check.sh', 'crontab.txt'], how: ['scripts/overrun-check.sh in /opt/archtoolkit on a host of your own, crontab.txt in its crontab. It only reads.'] }] : []),
            ],
            sources: [`${API_REF} (Maintenance Schedules: GET, POST, PUT, DELETE /api/maintenanceschedules)`],
          }),
          [`scripts/${base}.json`]: `${JSON.stringify(schedule, null, 2)}\n`,
          'scripts/apply.sh': inScripts(applyScript(PLATFORM, [{ method: 'POST', path: '/suite-api/api/maintenanceschedules', payload: `${base}.json` }], 'remove it from the policy, or DELETE /suite-api/api/maintenanceschedules with its id.')),
          'attach-to-policy.txt': [
            `Attach "${windowName}" to "${policy}" — in the interface; there is no documented API call for this step.`,
            '',
            '1. Operate > Administration > Configurations > Maintenance Schedules: check the schedule is listed with the right day, time, length and time zone.',
            `2. Open the policy "${policy}" for editing (Configure > Policies in older releases).`,
            `3. In the policy, select the object type the objects in "${group}" are, and set its maintenance schedule to "${windowName}". The label differs between releases — look for Maintenance Schedule.`,
            `4. Check the policy is assigned to "${group}" and to nothing else, and that no higher-priority policy covers the same objects.`,
            '5. Save. The window applies from its next start.',
            '',
          ].join('\n'),
          ...(overrun
            ? {
                'scripts/overrun-check.sh': check,
                'crontab.txt': [
                  `# Daily, an hour after "${windowName}" is due to end. Cron runs in the host's time zone —`,
                  '# make that the same zone as the schedule. No secret here: the script logs in from the password file.',
                  '# With the Orchestrator package, schedule the overrun-check workflow instead and leave this out.',
                  `${checkAt} ${scheduledEnv(PLATFORM)} /opt/archtoolkit/overrun-check.sh >>/var/log/archtoolkit/overrun-check.log 2>&1 || logger -t archtoolkit "maintenance overrun: ${windowName}"`,
                  '',
                ].join('\n'),
              }
            : {}),
        },
        notes: [
          'A maintenance schedule does more than silence alerts: while an object is in maintenance VCF Operations stops collecting from it and cancels its active alerts. The morning after, there is a gap in the charts, not a queue of suppressed alerts.',
          `VERIFY: the payload asks for the ${parsed ? `${parsed[1] .toLowerCase()} ${parsed[2] .toLowerCase()}` : 'given day'} of every month. The API reference lists the fields but not how MONTHLY combines weeksOfTheMonth with daysOfTheWeek — after applying, read the schedule back in the interface and check it says what you meant.`,
          'A maintenance window stops alerting. It does not stop an automation firing — check whether anything scheduled overlaps it.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfops_capacity_report',
    platform: PLATFORM,
    label: 'Email a capacity report on a schedule',
    group: 'Reporting',
    description:
      'The safest automation there is, and the one most often left undone: a report that actually arrives. The Aria Ops page finds report definitions with no schedule at all — this is the schedule.',
    inputs: [
      { id: 'report_name', label: 'Report definition', control: 'text', default: 'Cluster capacity' },
      { id: 'recipients', label: 'Send to', control: 'text', default: 'platform-team@example.com', hint: 'A team address. A person’s mailbox stops working the week they change role' },
      {
        id: 'cadence',
        label: 'How often',
        control: 'select',
        options: [
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Monthly' },
          { value: 'quarterly', label: 'Quarterly' },
        ],
        default: 'monthly',
      },
      { id: 'formats', label: 'Formats', control: 'text', default: 'pdf, csv' },
      { id: 'scope_object', label: 'Run it for', control: 'text', default: 'vSphere World' },
    ],
    automation: (values                 , name        )             => {
      const reportName = str(values, 'report_name', 'Capacity');
      const recipients = listOf(str(values, 'recipients', ''));
      const cadence = str(values, 'cadence', 'monthly');
      const formats = listOf(str(values, 'formats', 'pdf'));
      const scopeObject = str(values, 'scope_object', 'vSphere World');
      const base = slugOf(name || reportName, 'report-schedule');

      const findings            = [];
      const personal = recipients.filter((address) => /^[a-z]+[._][a-z]/i.test(address.split('@')[0] ?? '') && !/(team|ops|support|alerts?|noc|group|dl|it-)/i.test(address));
      if (personal.length > 0) {
        findings.push(
          warning('vcfops.report.personal-mailbox', `${personal.join(', ')} looks like an individual rather than a team.`, {
            remediation: 'When that person changes role the report stops being read and nothing reports that it has. Send it to a distribution list.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (recipients.length === 0) {
        findings.push(error('vcfops.report.no-recipient', 'No recipients, so this report is generated and delivered to nobody.', { source: 'ArchToolKit' }));
      }

      // Fields as documented for POST /api/reportdefinitions/{id}/schedules.
      // The ids are filled in by apply.sh from the environment.
      const schedule = {
        reportDefinitionId: '<set by apply.sh from REPORT_DEFINITION_ID>',
        resourceId: ['<set by apply.sh from RESOURCE_ID>'],
        reportScheduleType: cadence === 'weekly' ? 'WEEKLY' : 'MONTHLY',
        recurrence: cadence === 'quarterly' ? 3 : 1,
        ...(cadence === 'weekly' ? { daysOfTheWeek: ['MONDAY'] } : {}),
        dayOfTheMonth: 1,
        // The 9.x reference writes startDate as MM/DD/YYYY ("01/01/2015").
        startDate: '<REQUIRED — the first date it may run, MM/DD/YYYY, e.g. 10/01/2026>',
        startHour: 7,
        startMinute: 0,
        emailAddresses: recipients,
        relativePath: [],
      };
      const pkg = opsPackage({
        parts: ['report', base],
        folder: `report-${base}`,
        description: `Schedules the report "${reportName}" ${cadence} to ${recipients.join(', ') || 'nobody'}, once.`,
        workflowName: `Schedule report ${opsPart(base)}`,
        workflowDescription: `Finds the report definition "${reportName}" and the object "${scopeObject}" by name and schedules the report ${cadence} to ${recipients.join(', ') || 'nobody'} — unless the same schedule (type, recurrence, object and recipients) exists. The time is read in timeZone (X-Ops-API-Timezone), not GMT.`,
        changes: true,
        cap: 1,
        outputs: [{ name: 'scheduleId', type: 'string', description: 'The report schedule id, empty in a dry run' }],
        account: 'An account that may schedule reports',
        settings: [
          { name: 'reportName', type: 'string', value: reportName, description: 'The report definition, by name' },
          { name: 'scopeObject', type: 'string', value: scopeObject, description: 'The one object the report is run for, by name' },
          { name: 'startDate', type: 'string', value: '', description: 'The first day it may run, MM/DD/YYYY' },
          { name: 'timeZone', type: 'string', value: '', description: 'The time zone of startHour (e.g. Europe/Amsterdam); empty means GMT' },
        ],
        resources: [{ name: 'schedule.json', content: `${JSON.stringify(schedule, null, 2)}\n` }],
        body: CAPACITY_BODY,
        after: String.raw`scheduleId = ctx.dryRun ? "" : (scheduleRef || "");
summary = core.audit(ctx, { scheduleId: scheduleId });
core.notify(settings.webhook, summary);`,
      });
      const apply = [
        '#!/usr/bin/env bash',
        `# Schedule the report "${reportName}" in VCF Operations.`,
        '#',
        '# Schedules created through the API run in GMT unless the X-Ops-API-Timezone',
        '# header names a zone (set OPS_TIMEZONE, e.g. Europe/Amsterdam). Without it',
        '# 07:00 here is 07:00 GMT.',
        '#',
        '# Without --execute this only prints what it would send. Not idempotent: a',
        '# second run makes a second schedule, and a second email.',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        '',
        ...authPreamble(PLATFORM),
        `: "\${REPORT_DEFINITION_ID:?set REPORT_DEFINITION_ID: GET /suite-api/api/reportdefinitions and match the name \\"${reportName}\\"}"`,
        `: "\${RESOURCE_ID:?set RESOURCE_ID to the id of \\"${scopeObject}\\": GET /suite-api/api/resources?name=...}"`,
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        `body=$(jq --arg d "$REPORT_DEFINITION_ID" --arg r "$RESOURCE_ID" '.reportDefinitionId = $d | .resourceId = [$r]' ${base}.json)`,
        'if grep -q "<REQUIRED" <<<"$body"; then',
        `  echo "${base}.json still has a <REQUIRED> value in it. Fill it in first." >&2`,
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
        'ZONE=()',
        '[[ -n "${OPS_TIMEZONE:-}" ]] && ZONE=(-H "X-Ops-API-Timezone: ${OPS_TIMEZONE}")',
        `curl -sS -f -X POST "https://\${VCFOPS_HOST}\${path}" -H "${authHeader(PLATFORM)}" "\${ZONE[@]}" -H "Accept: application/json" -H "Content-Type: application/json" --data "$body"`,
        'echo',
        '',
        '# Undo: GET ${path} to find the schedule id, then',
        '#   DELETE /suite-api/api/reportdefinitions/${REPORT_DEFINITION_ID}/schedules/{scheduleId}',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${reportName} — sent ${cadence} to ${recipients.join(', ') || 'nobody'}`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `${cadence}, at 07:00 in the workflow's timeZone (GMT when it is empty, and always GMT for the fallback script without OPS_TIMEZONE)`, worstCase: cadence === 'weekly' ? 'once a week' : cadence === 'quarterly' ? 'once a quarter' : 'once a month' },
        scope: {
          what: `The report "${reportName}", run against ${scopeObject}.`,
          decidedBy: ['The report definition itself and the views in it.', `The object it is run for: ${scopeObject}.`],
          ifWrong: 'Somebody gets a report about the wrong part of the estate and, because it looks plausible, acts on it.',
        },
        guardrails: [
          { rule: 'It only reads', because: 'A report changes nothing. This is the one automation that is safe to turn on before you have thought about it.' },
          { rule: 'The workflow creates the schedule once: the same type, recurrence, object and recipients already scheduled is left as it is', because: 'A second schedule is a second email every month, which is how reports get filtered away.' },
          ...(recipients.length > 0 ? [{ rule: 'Goes to a named list', because: 'A scheduled report with no recipient is a file generated onto an appliance and deleted by retention.' }] : []),
        ],
        dryRun: ['Run the report once by hand for the same object and read it. A report nobody has read once will not be read monthly.', `Run the workflow Schedule report ${opsPart(base)} with dryRun = true: it finds the definition and the object and logs the schedule it would create.`],
        undo: [
          'GET /suite-api/api/reportdefinitions/{id}/schedules to find the schedule id, then DELETE /suite-api/api/reportdefinitions/{id}/schedules/{scheduleId}.',
          'Or delete it from the report definition’s schedules in the interface. Nothing else changes.',
        ],
        told: recipients.length > 0 ? [`${recipients.join(', ')}, every ${cadence === 'weekly' ? 'week' : cadence === 'quarterly' ? 'quarter' : 'month'}.`] : ['Nobody, which makes this schedule pointless.'],
        requires: [
          `The report definition "${reportName}" to exist, and its id in REPORT_DEFINITION_ID.`,
          `The id of ${scopeObject} in RESOURCE_ID. The API takes one resource per schedule.`,
          'An outbound mail plugin configured, and allowed through to your relay. If there is more than one, add emailPluginId to the payload.',
          OPS_PACKAGE_REQUIRES,
        ],
        files: {
          ...pkg.files,
          [`scripts/${base}.json`]: `${JSON.stringify(schedule, null, 2)}\n`,
          'scripts/apply.sh': apply,
          'IMPORT.md': importMd({
            title: `the schedule for "${reportName}"`,
            steps: [
              { heading: 'The report definition', files: [], how: [`"${reportName}" has to exist first — import it with "A report from views, on a schedule" in this kit (import/report.zip under Reports → Import), or use a built-in report.`] },
              ...packageSteps(pkg, 'the workflow that schedules the report'),
              { heading: 'Or: the schedule by the fallback script', files: [`scripts/${base}.json`, 'scripts/apply.sh'], how: ['Fill in startDate (MM/DD/YYYY), then REPORT_DEFINITION_ID=… RESOURCE_ID=… OPS_TIMEZONE=… ./scripts/apply.sh --execute — POST /suite-api/api/reportdefinitions/{id}/schedules. Or in the interface: the report → Schedule. A schedule is not something VCF Operations imports from a file.'] },
            ],
            sources: [`${API_REF} (Reports: POST /api/reportdefinitions/{id}/schedules — startDate MM/DD/YYYY, X-Ops-API-Timezone, one resource per schedule)`],
          }),
        },
        notes: [
          `Formats: ${formats.join(', ')}. The schedule has no format field — formats are set on the report definition itself, so check them there. PDF is what people read; CSV is what they actually use, because the first thing anybody does with a capacity report is sort it.`,
          'The time is read in the X-Ops-API-Timezone header the workflow sends from timeZone (VCF Operations 9.x API reference); with timeZone empty — and for the fallback script without OPS_TIMEZONE — it is GMT, which does not move for daylight saving.',
          'If the report has never been scheduled before, check the mail plugin first. A schedule that silently fails to send looks identical to one that is working.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfops_policy_toggle',
    platform: PLATFORM,
    label: 'Turn alert definitions on or off in a policy',
    group: 'Policy',
    description:
      'Where an alert that "should be firing" usually went. Generates the policy override that enables or disables a named set of alert definitions, with the current state recorded first so it can be put back exactly.',
    inputs: [
      { id: 'policy_name', label: 'Policy', control: 'text', default: 'Production Policy' },
      {
        id: 'direction',
        label: 'What to do',
        control: 'select',
        options: [
          { value: 'enable', label: 'Turn these alerts on' },
          { value: 'disable', label: 'Turn these alerts off' },
        ],
        default: 'enable',
      },
      { id: 'alert_ids', label: 'Alert definition ids', control: 'textarea', default: 'AlertDefinition-VMWARE-DatastoreUsage\nAlertDefinition-VMWARE-HostMemContentionManyVMs', hint: 'One per line. The Aria Ops page lists them' },
      { id: 'object_kind', label: 'On object kind', control: 'text', default: 'HostSystem' },
    ],
    automation: (values                 , name        )             => {
      const policy = str(values, 'policy_name', 'Production Policy');
      const direction = str(values, 'direction', 'enable');
      const ids = listOf(str(values, 'alert_ids', ''));
      const kind = str(values, 'object_kind', 'HostSystem');
      const base = slugOf(name || `${policy}-${direction}`, 'policy-override');
      const enabling = direction === 'enable';

      const findings            = [];
      if (ids.length === 0) {
        findings.push(error('vcfops.policy.nothing', 'No alert definitions named, so this override does nothing.', { source: 'ArchToolKit' }));
      }
      if (!enabling && ids.length > 20) {
        findings.push(
          warning('vcfops.policy.mass-disable', `Turning off ${ids.length} alert definitions at once leaves a large hole in the monitoring.`, {
            remediation: 'Disabling in bulk is how an estate ends up with 2,000 definitions and nothing watching. Disable what is noisy, and fix what is noisy for a reason.',
            source: 'ArchToolKit',
          }),
        );
      }

      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<PolicyContent>',
        '    <Policies>',
        `        <Policy description="ArchToolKit override" key="&lt;REQUIRED — the policy id&gt;" name="${policy}">`,
        '            <PackageSettings>',
        `                <Alerts adapterKind="VMWARE" resourceKind="${kind}">`,
        ...ids.map((id) => `                    <Alert enabled="${enabling}" id="${id}"/>`),
        '                </Alerts>',
        '            </PackageSettings>',
        '        </Policy>',
        '    </Policies>',
        '</PolicyContent>',
        '',
      ].join('\n');

      // 9.x: PUT /api/alertdefinitions/{id}/enable|disable?policyId=… turns an
      // alert definition on or off in a policy, without exporting, merging and
      // re-importing the whole policy.
      const pkg = opsPackage({
        parts: ['alerttoggle', base],
        folder: `alerts-${base}`,
        description: `${enabling ? 'Enables' : 'Disables'} ${ids.length} alert definition(s) in "${policy}".`,
        workflowName: `${enabling ? 'Enable' : 'Disable'} alerts ${opsPart(base)}`,
        workflowDescription: `Checks that "${policy}" and every named alert definition exist, then ${enabling ? 'enables' : 'disables'} each one in it (PUT alertdefinitions/{id}/${enabling ? 'enable' : 'disable'}?policyId=…).`,
        changes: true,
        cap: Math.max(1, ids.length),
        outputs: [{ name: 'changedIds', type: 'string', description: 'The alert definitions changed, JSON; empty in a dry run' }],
        account: 'An account that may edit policies',
        settings: [
          { name: 'policyName', type: 'string', value: policy, description: 'By name' },
          { name: 'direction', type: 'string', value: enabling ? 'enable' : 'disable', description: 'enable or disable' },
          { name: 'alertDefinitionIds', type: 'Array/string', value: ids, description: 'The alert definitions' },
        ],
        body: TOGGLE_BODY,
        after: String.raw`changedIds = ctx.dryRun ? "" : JSON.stringify(done);
summary = core.audit(ctx, { changed: ctx.dryRun ? [] : done, undo: "Run it again with direction " + (verb === "enable" ? "disable" : "enable") + " — or re-import the export taken before." });
core.notify(settings.webhook, summary);`,
      });

      return {
        platform: PLATFORM,
        title: `${policy} — ${enabling ? 'enable' : 'disable'} ${ids.length} alert definition${ids.length === 1 ? '' : 's'} on ${kind}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once, by a person, as a change.' },
        scope: {
          what: `Every object the policy "${policy}" applies to.`,
          decidedBy: [
            `The custom groups that "${policy}" is assigned to.`,
            'The policy priority order — a higher-priority policy on the same object wins.',
            `The ${ids.length} named alert definitions, on ${kind} only.`,
          ],
          ifWrong: enabling
            ? 'Alerts start firing across a wider set of objects than expected, and the notification rules send all of it.'
            : 'Alerts stop firing on objects you did not mean to include, and nothing at all reports that they have stopped.',
        },
        guardrails: [
          { rule: 'Export the policy before applying this', because: 'The export is the undo. There is no other one, and the interface will not tell you what the previous value was.' },
          { rule: 'Named definitions only, on one object kind', because: 'A policy edit that changes a whole package changes settings nobody reviewed.' },
          { rule: 'The workflow checks the policy and every alert definition exist before it changes any, and is a dry run until dryRun is false', because: 'Half a change — some alerts on, a typo left off — is harder to reason about than none.' },
        ],
        dryRun: [
          `Run the workflow ${enabling ? 'Enable' : 'Disable'} alerts ${opsPart(base)} with dryRun = true: it lists every "DRY RUN: would ${enabling ? 'enable' : 'disable'} …".`,
          'Run scripts/export-first.sh and keep the zip. That file is the undo.',
          'Diff it against this override so that what changes is exactly the list above and nothing else.',
        ],
        undo: [
          'Re-import the policy export taken before the change (POST /suite-api/api/policies/import?forceImport=true with the zip, or Import under Policies). Keep it with the change record; it is small and it is the only exact way back.',
          `Running the workflow again with direction ${enabling ? 'disable' : 'enable'} reverses it only where the alert was ${enabling ? 'off' : 'on'} before: the API has no read of an alert's previous state in a policy, which is why the export comes first.`,
        ],
        told: ['Nobody automatically. A policy change is silent, which is why it belongs in a change record rather than in somebody’s afternoon.'],
        requires: [`The policy "${policy}" (the workflow finds it by name; the scripts need its id).`, 'An export of the policy as it is now.', OPS_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          'scripts/merge-policy.sh': policyMergeScript(`${base}.xml`, policy),
          'IMPORT.md': importMd({
            title: `${enabling ? 'enabling' : 'disabling'} ${ids.length} alert definition${ids.length === 1 ? '' : 's'} in "${policy}"`,
            steps: [
              { heading: 'Take the undo', files: ['scripts/export-first.sh'], how: [`POLICY_ID=<id of "${policy}"> ./scripts/export-first.sh — the policy as it is now, as a zip that re-imports. The workflow does not take it: Orchestrator's REST calls carry text, and the export is a zip.`] },
              ...packageSteps(pkg, `the workflow that ${enabling ? 'enables' : 'disables'} the alerts`),
              {
                heading: 'Or: merge and import, by script (8.x, or without Orchestrator)',
                files: [`scripts/${base}.xml`, 'scripts/merge-policy.sh'],
                how: [
                  `${base}.xml is the change, not a policy to import: a policy file holds all of a policy's overrides, so importing this one alone would drop every other override "${policy}" has.`,
                  'POLICY_ID=… ./scripts/merge-policy.sh exports the policy, sets these <Alert enabled> values in it and writes scripts/import/policy-merged.zip; with --execute it imports that zip (POST /suite-api/api/policies/import?forceImport=true, multipart field policy).',
                  'Or import scripts/import/policy-merged.zip yourself: Configure → Policies → ⋯ → Import (8.x: Administration → Policies → Policy Library → Import).',
                ],
              },
            ],
            sources: [...FORMAT_SOURCES, `${API_REF} (Alerts: PUT /api/alertdefinitions/{id}/enable and /disable, query policyId)`],
          }),
          [`scripts/${base}.xml`]: xml,
          'scripts/export-first.sh': [
            '#!/usr/bin/env bash',
            '# Take the export that is your only undo, before changing anything.',
            '#',
            '# The export is a zip, meant to be re-imported into the same version only.',
            'set -euo pipefail',
            ...authPreamble(PLATFORM),
            ': "${POLICY_ID:?set POLICY_ID — GET /suite-api/api/policies and match by name}"',
            '',
            'out="policy-before-$(date +%Y%m%d-%H%M%S).zip"',
            'curl -sS -f \\',
            '  "https://${VCFOPS_HOST}/suite-api/api/policies/export?id=${POLICY_ID}" \\',
            `  -H "${authHeader(PLATFORM)}" \\`,
            '  -o "$out"',
            '',
            'echo "Saved ${out}. Keep it with the change record — it is the undo."',
            '',
          ].join('\n'),
        },
        notes: [
          'A policy inherits from its parent. Setting an alert to enabled here overrides the parent for objects this policy applies to, and changes nothing anywhere else.',
          'If an alert still does not fire after enabling it, the next things to check are whether its symptoms still exist and whether a higher-priority policy applies to the object.',
        ],
        findings,
      };
    },
  }),
];
