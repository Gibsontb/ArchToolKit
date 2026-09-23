/**
 * VCF Operations for Logs and for Networks: the groundwork.
 *
 * The first Logs and Networks blueprints raise things — an alert, a flow that
 * should not exist. These are what those stand on: the content pack that turns
 * an application's log lines into fields, the agent that ships them, where they
 * are forwarded and how long they are kept; the data sources Networks collects
 * from, the application definitions it groups flows by, and the check that
 * says whether what is reachable is what was intended.
 *
 * The Logs and Networks APIs have moved more between releases than most of
 * VCF. Where a path or a field is not certain for 9.1 the file says so; export
 * the same object from your own instance and compare before applying.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { applyScript } from '../apply.js';
import {
  contentPackJson,
  importGuide,
  LOGS_SOURCES,
  networksPreamble,
  networksScheduledEnv,
  vlcpChartQuery,
  vlcpImportStep,
  vlcpInternalName,
                      
                 
} from './vcf-networks-logs.js';
import { packageNameOf, toPackage } from '../vro/to-package.js';
                                                   

const LOGS = 'vcf-operations-logs'         ;
const NETWORKS = 'vcf-operations-networks'         ;
const SRC = 'ArchToolKit';

/**
 * A fallback script moved under scripts/ still names its payloads relative to
 * the bundle root (import/…, scripts/…), so it changes to the root first and
 * works from wherever it is called.
 */
function fromRoot(script        )         {
  return script.replace('set -euo pipefail\n', 'set -euo pipefail\ncd "$(dirname "$0")/.."\n');
}

const param = (name        , type        , description        ) => ({ name, type, description });

// ---------------------------------------------------------------------------
// Orchestrator actions the Logs and Networks packages carry themselves.
//
// The core library has VCF Operations (OpsToken, and the KB 450054 exchange to
// a 9.1 log management JWT) and VCF Operations for Networks logins, but no
// login to the standalone Logs appliance of 8.18 / 9.0. The packages that
// target that appliance carry it as their own action; core should gain it
// (loginVcfLogs) so it is written once.
// ---------------------------------------------------------------------------

const LOGS_APPLIANCE_ACTIONS                          = [
  {
    name: 'logsApi',
    description: 'The API root of a standalone VCF Operations for Logs 8.18 / 9.0 appliance (or its cluster VIP): https://<host>:9543/api/v2, the port added when the host has none. Not 9.1 log management, which has no /api/v2 of its own.',
    resultType: 'string',
    params: [param('host', 'string', 'Logs appliance host[:port]')],
    script: String.raw`if (!host) throw new Error("logsApi: the Logs host is empty.");
return "https://" + host + (String(host).indexOf(":") < 0 ? ":9543" : "") + "/api/v2";`,
  },
  {
    name: 'loginLogs',
    description:
      'Standalone VCF Operations for Logs 8.18 / 9.0: POST /api/v2/sessions {username, password, provider} (the Sessions section of the Logs API reference). Returns { Authorization: "Bearer <sessionId>" }. The reference documents no session DELETE: the session lapses after its ttl, so there is nothing to log out.',
    resultType: 'Any',
    params: [
      param('host', 'string', 'Logs appliance host[:port]'),
      param('username', 'string', 'Account'),
      param('password', 'string', 'From a SecureString attribute'),
      param('provider', 'string', 'Authentication provider: Local, ActiveDirectory or vIDM; empty = Local'),
    ],
    script: String.raw`var core = System.getModule("com.archtoolkit.core");
var api = System.getModule(${JSON.stringify('__MODULE__')}).logsApi(host);
var credentials = { username: String(username), password: String(password), provider: provider ? String(provider) : "Local" };
var r = core.http("POST", api + "/sessions", null, credentials, { redact: [password] });
if (!r.body || !r.body.sessionId) throw new Error("The Logs appliance at " + host + " returned no session id.");
return { "Authorization": "Bearer " + r.body.sessionId };`,
  },
  {
    name: 'itemsOf',
    description:
      'The list in a response whose shape the reference does not publish: the body itself when it is an array, else the first array-valued property. Throws rather than guess when the body is an object with no array in it, so an unread list never becomes "nothing exists" and a duplicate.',
    resultType: 'Any',
    params: [param('body', 'Any', 'A parsed response body'), param('what', 'string', 'The call, for the error message')],
    script: String.raw`if (body === null || body === undefined || body === "") return [];
if (Array.isArray(body)) return body;
if (typeof body !== "object") throw new Error(what + ": the response is not a list (VERIFY the response shape on your release); refusing to act on it.");
var keys = [];
for (var k in body) {
  if (!body.hasOwnProperty(k)) continue;
  keys.push(k);
  if (Array.isArray(body[k])) return body[k];
}
if (keys.length === 0) return [];
throw new Error(what + ": no list in the response (keys: " + keys.join(", ") + "; VERIFY the response shape on your release); refusing to act on it.");`,
  },
];

/** The Logs appliance actions for one package: loginLogs calls logsApi in its own module. */
function logsApplianceActions(module        )                 {
  return LOGS_APPLIANCE_ACTIONS.map((action) => ({ ...action, script: action.script.split(JSON.stringify('__MODULE__')).join(JSON.stringify(module)) }));
}

/** Settings every standalone-Logs package has. */
const LOGS_APPLIANCE_SETTINGS = [
  { name: 'logsHost', type: 'string', value: '', description: 'Standalone VCF Operations for Logs 8.18 / 9.0: the appliance or cluster VIP, host[:port] (port 9543 when none)' },
  { name: 'logsUsername', type: 'string', value: '', description: 'A Logs account with the admin role' },
  { name: 'logsPassword', type: 'SecureString', description: 'Its password' },
  { name: 'logsProvider', type: 'string', value: 'Local', description: 'Authentication provider: Local, ActiveDirectory or vIDM' },
]         ;

const NETWORKS_ACTIONS                          = [
  {
    name: 'listAll',
    description:
      'Every item of a VCF Operations for Networks list (GET /api/ni<path>), following cursor until the list ends. The items are what the list returns — usually { entity_id, entity_type } only; read each for its fields. Throws rather than return a partial list.',
    resultType: 'Any',
    params: [param('host', 'string', 'Platform host'), param('auth', 'Any', 'What loginVcfNetworks returned'), param('path', 'string', 'e.g. /groups/applications'), param('safe', 'Any', 'http() options, e.g. { redact: settings._secrets }')],
    script: String.raw`var core = System.getModule("com.archtoolkit.core");
var cursor = "";
return core.pageAll(function (page) {
  var url = "https://" + host + "/api/ni" + path + (cursor ? (String(path).indexOf("?") < 0 ? "?" : "&") + "cursor=" + encodeURIComponent(cursor) : "");
  var body = core.http("GET", url, auth, null, safe).body || {};
  var items = body.results || [];
  cursor = body.cursor ? String(body.cursor) : "";
  return { items: items, total: typeof body.total_count === "number" ? body.total_count : null, more: cursor !== "" && items.length > 0 };
}, 0);`,
  },
  {
    name: 'detail',
    description: 'An entity as the list gave it when it already carries the field wanted, otherwise GET /api/ni<path>/<entity_id>.',
    resultType: 'Any',
    params: [param('host', 'string', 'Platform host'), param('auth', 'Any', 'What loginVcfNetworks returned'), param('path', 'string', 'The list path, e.g. /groups/applications'), param('item', 'Any', 'One item of the list'), param('field', 'string', 'The field wanted, e.g. name'), param('safe', 'Any', 'http() options')],
    script: String.raw`if (item && item[field] !== undefined && item[field] !== null) return item;
var url = "https://" + host + "/api/ni" + path + "/" + encodeURIComponent(String(item.entity_id));
return System.getModule("com.archtoolkit.core").http("GET", url, auth, null, safe).body || {};`,
  },
];

/** Settings every Networks package has. */
const NETWORKS_SETTINGS = [
  { name: 'netHost', type: 'string', value: '', description: 'VCF Operations for Networks platform host (FQDN)' },
  { name: 'netUsername', type: 'string', value: '', description: 'A Networks account' },
  { name: 'netPassword', type: 'SecureString', description: 'Its password' },
  { name: 'netDomainType', type: 'string', value: 'LOCAL', description: 'LOCAL for a local account, LDAP for a directory account' },
  { name: 'netDomain', type: 'string', value: 'local', description: 'local, or the directory domain' },
]         ;

/** The first lines of every Networks workflow: settings checked, then the login. */
const NETWORKS_LOGIN = String.raw`if (!settings.netHost) throw new Error("Set netHost in the configuration element " + SETTINGS_NAME + ".");
if (!settings.netUsername || !settings.netPassword) throw new Error("Set netUsername and netPassword in the configuration element " + SETTINGS_NAME + ".");
var api = "https://" + settings.netHost + "/api/ni";
var auth = core.loginVcfNetworks(settings.netHost, settings.netUsername, settings.netPassword, settings.netDomainType || "", settings.netDomain || "");
var SAFE = { redact: settings._secrets };`;

/** The first lines of every standalone-Logs workflow. */
const LOGS_APPLIANCE_LOGIN = String.raw`if (!settings.logsHost) throw new Error("Set logsHost in the configuration element " + SETTINGS_NAME + ".");
if (!settings.logsUsername || !settings.logsPassword) throw new Error("Set logsUsername and logsPassword in the configuration element " + SETTINGS_NAME + ".");
var api = mod.logsApi(settings.logsHost);
var auth = mod.loginLogs(settings.logsHost, settings.logsUsername, settings.logsPassword, settings.logsProvider || "Local");
var SAFE = { redact: settings._secrets };
// No logout: the appliance documents no session DELETE, and the session lapses after its ttl.`;

/** The IMPORT.md steps of a package, with a word on what the workflow does first. */
function packageSteps(pkg                              , what        ) {
  return pkg.importSteps.map((step, index) => (index === 0 ? { heading: `${step.heading} — ${what}`, lines: step.lines } : step));
}

// ---------------------------------------------------------------------------
// VCF Operations for Logs
// ---------------------------------------------------------------------------

/** A regex fragment that swallows everything, which makes a context match anything. */
function isGreedy(pattern        )          {
  return /\.\*(?!\?)/.test(pattern) || /\.\+(?!\?)/.test(pattern);
}

/**
 * The content pack's saved query in 9.1 log management: read the query
 * configs, create the one in the resource unless one of its name exists.
 * queryconfigs is documented in the VCF Operations API and takes the ordinary
 * OpsToken — no ops-li exchange for it.
 */
const CONTENT_PACK_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
if (!settings.opsHost) throw new Error("Set opsHost in the configuration element " + SETTINGS_NAME + ".");
if (!settings.opsUsername || !settings.opsPassword) throw new Error("Set opsUsername and opsPassword in the configuration element " + SETTINGS_NAME + ".");
var wanted = JSON.parse(core.resource(RESOURCE_PATH, "queryconfig.json"));
var url = "https://" + settings.opsHost + "/suite-api/api/logs/queryconfigs";
var auth = core.loginVcfOps(settings.opsHost, settings.opsUsername, settings.opsPassword, settings.opsAuthSource || "");
var SAFE = { redact: settings._secrets };
var id = null;
var existed = false;
try {
  var all = core.pageAll(function (page) {
    var r = core.http("GET", url + "?page=" + page + "&pageSize=1000", auth, null, SAFE).body || {};
    return { items: r.logsQueryConfigs || [], total: r.pageInfo ? r.pageInfo.totalCount : null };
  }, 0);
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].name) === String(wanted.name)) { id = String(all[i].id); existed = true; break; }
  }
  if (existed) {
    System.log("Exists, left as it is: saved query \"" + wanted.name + "\" (" + id + "). Change it in Explore Logs, or delete it to have this recreate it.");
  } else {
    id = core.act(ctx, "create saved query \"" + wanted.name + "\"", function () {
      var created = core.http("POST", url, auth, wanted, SAFE);
      if (!created.body || !created.body.id) throw new Error("POST /suite-api/api/logs/queryconfigs returned no id.");
      return String(created.body.id);
    });
  }
} finally {
  core.logoutVcfOps(settings.opsHost, auth);
}
queryConfigId = id || "";
summary = core.audit(ctx, { queryConfigId: queryConfigId, name: wanted.name, existed: existed, note: "The extracted field, alert and dashboard come from the content pack, converted and installed by hand." });
core.notify(settings.webhook, summary);`;

/**
 * A forwarding destination on the standalone 8.18 / 9.0 appliance: the Log
 * Forwarder section of its API. A destination of the same name is left as it
 * is, with any difference in what it sends where reported.
 */
const FORWARDER_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
${LOGS_APPLIANCE_LOGIN}
var wanted = JSON.parse(core.resource(RESOURCE_PATH, "forwarder.json"));
var existing = mod.itemsOf(core.http("GET", api + "/log-forwarder", auth, null, SAFE).body, "GET /api/v2/log-forwarder");
var found = null;
for (var i = 0; i < existing.length; i++) {
  if (existing[i] && String(existing[i].name) === String(wanted.name)) { found = existing[i]; break; }
}
var id = null;
if (found) {
  id = found.id ? String(found.id) : "";
  var differs = [];
  var keys = ["host", "port", "protocol", "transportProtocol", "sslEnabled", "filter"];
  for (var k = 0; k < keys.length; k++) {
    if (found[keys[k]] !== undefined && String(found[keys[k]]) !== String(wanted[keys[k]])) differs.push(keys[k]);
  }
  if (differs.length > 0) System.warn("Log forwarder \"" + wanted.name + "\" exists and differs in " + differs.join(", ") + "; left as it is. Change it under Log Forwarding, or delete it and run again.");
  else System.log("Exists, left as it is: log forwarder \"" + wanted.name + "\"" + (id ? " (" + id + ")" : "") + ".");
} else {
  id = core.act(ctx, "create log forwarder \"" + wanted.name + "\" to " + wanted.host + ":" + wanted.port, function () {
    var created = core.http("POST", api + "/log-forwarder", auth, wanted, SAFE);
    return created.body && created.body.id ? String(created.body.id) : "";
  });
}
forwarderId = id || "";
summary = core.audit(ctx, { forwarderId: forwarderId, name: wanted.name, existed: found !== null, destination: wanted.host + ":" + wanted.port });
core.notify(settings.webhook, summary);`;

/**
 * An agent group on the standalone 8.18 / 9.0 appliance. The route is not in
 * the published reference: a 404 on the list stops the run before anything is
 * sent, with the way to do it by hand.
 */
const AGENT_GROUP_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
${LOGS_APPLIANCE_LOGIN}
var wanted = JSON.parse(core.resource(RESOURCE_PATH, "agent-group.json"));
var list = core.http("GET", api + "/agent/groups", auth, null, { redact: settings._secrets, allow: [404] });
if (list.statusCode === 404) {
  throw new Error("This appliance has no agent group API at /api/v2/agent/groups (the route is not in the published reference). Nothing was changed: create the group by hand, as IMPORT.md says, pasting the resource element liagent.ini.");
}
var existing = mod.itemsOf(list.body, "GET /api/v2/agent/groups");
var found = null;
for (var i = 0; i < existing.length; i++) {
  if (existing[i] && String(existing[i].name) === String(wanted.name)) { found = existing[i]; break; }
}
if (found) {
  System.log("Exists, left as it is: agent group \"" + wanted.name + "\". Its configuration is not replaced; paste the resource element liagent.ini into it by hand if it should change.");
} else {
  core.act(ctx, "create agent group \"" + wanted.name + "\" for hostname " + wanted.criteria.hostname + " (" + wanted.criteria.os + ")", function () {
    return core.http("POST", api + "/agent/groups", auth, wanted, SAFE).body;
  });
}
summary = core.audit(ctx, { name: wanted.name, existed: found !== null, criteria: wanted.criteria });
core.notify(settings.webhook, summary);`;

/**
 * An index partition and archiving on the standalone 8.18 / 9.0 appliance.
 * Neither route is in the published reference: a 404 stops the run before
 * anything is sent. An existing partition is never edited — a retention
 * change deletes events, and is made by a person under a change — and an
 * archive already pointed somewhere else is never redirected.
 */
const RETENTION_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
${LOGS_APPLIANCE_LOGIN}
var partition = JSON.parse(core.resource(RESOURCE_PATH, "partition.json"));
var HAS_ARCHIVE = HAS_ARCHIVE_VALUE;
function listOr404(path) {
  var r = core.http("GET", api + path, auth, null, { redact: settings._secrets, allow: [404] });
  if (r.statusCode === 404) throw new Error("This appliance has no API at /api/v2" + path + " (the route is not in the published reference). Nothing was changed: configure it by hand, as IMPORT.md says.");
  return r.body;
}
var partitions = mod.itemsOf(listOr404("/partitions"), "GET /api/v2/partitions");
var archive = HAS_ARCHIVE ? JSON.parse(core.resource(RESOURCE_PATH, "archive.json")) : null;
var current = HAS_ARCHIVE ? (listOr404("/archiving") || {}) : null;
var found = null;
for (var i = 0; i < partitions.length; i++) {
  if (partitions[i] && String(partitions[i].name) === String(partition.name)) { found = partitions[i]; break; }
}
var kept = [];
if (found) {
  if (found.retentionPeriod !== undefined && Number(found.retentionPeriod) !== Number(partition.retentionPeriod)) {
    System.warn("Partition \"" + partition.name + "\" exists with a retention of " + found.retentionPeriod + " days, not " + partition.retentionPeriod + "; left as it is. A retention change deletes events or keeps them longer than agreed: make it by hand, under a change.");
    kept.push("partition " + partition.name + " (retention differs)");
  } else {
    System.log("Exists, left as it is: partition \"" + partition.name + "\".");
    kept.push("partition " + partition.name);
  }
} else {
  core.act(ctx, "create partition \"" + partition.name + "\" keeping " + partition.retentionPeriod + " days", function () {
    return core.http("POST", api + "/partitions", auth, partition, SAFE).body;
  });
}
if (HAS_ARCHIVE) {
  var on = current.enabled === true || String(current.enabled) === "true";
  if (on && String(current.archiveUri) === String(archive.archiveUri)) {
    System.log("Exists, left as it is: archiving to " + archive.archiveUri + ".");
    kept.push("archiving");
  } else if (on && current.archiveUri) {
    System.warn("Archiving is already on, to " + current.archiveUri + "; left as it is rather than redirected to " + archive.archiveUri + ". Change it by hand if that is intended.");
    kept.push("archiving (another target)");
  } else {
    core.act(ctx, "turn on archiving to " + archive.archiveUri, function () {
      return core.http("PUT", api + "/archiving", auth, archive, SAFE).body;
    });
  }
}
summary = core.audit(ctx, { partition: partition.name, retentionDays: partition.retentionPeriod, archive: HAS_ARCHIVE ? archive.archiveUri : null, leftAsItIs: kept });
core.notify(settings.webhook, summary);`;

export const LOGS_MORE                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog_content_pack',
    platform: LOGS,
    label: 'A content pack for an application’s logs',
    group: 'Content',
    description:
      'The package that makes an application’s logs usable rather than merely stored: an extracted field that pulls a value out of each line, a saved query, an alert and a minimal dashboard, under one namespace so it can be versioned and upgraded as a unit. With the import instructions, because a content pack nobody installed is a file.',
    inputs: [
      { id: 'app_name', label: 'Application', control: 'text', default: 'Orders API' },
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'com.example.orders', hint: 'Reverse DNS. It is the content pack’s identity; changing it makes a new pack' },
      { id: 'version', label: 'Version', control: 'text', default: '1.0.0' },
      { id: 'app_filter', label: 'Logs from', control: 'text', default: 'orders-api', hint: 'The appname the agent tags these lines with' },
      { id: 'field_name', label: 'Extracted field', control: 'text', default: 'orders_latency_ms' },
      { id: 'pre_context', label: 'Text before the value', control: 'text', default: 'latency=', hint: 'Regex. Keep it literal and short' },
      { id: 'value_regex', label: 'The value', control: 'text', default: '\\d+' },
      { id: 'post_context', label: 'Text after the value', control: 'text', default: 'ms\\b' },
      { id: 'error_query', label: 'Alert when lines contain', control: 'text', default: 'ERROR' },
      { id: 'alert_threshold', label: 'More than (in 5 minutes)', control: 'number', default: 20, min: 1, max: 100000 },
    ],
    automation: (values                 , name        )             => {
      const app = str(values, 'app_name', 'Application');
      const namespace = str(values, 'namespace', 'com.example.app');
      const version = str(values, 'version', '1.0.0');
      const appFilter = str(values, 'app_filter', '');
      const field = str(values, 'field_name', 'value');
      const pre = str(values, 'pre_context', '');
      const valueRe = str(values, 'value_regex', '\\d+');
      const post = str(values, 'post_context', '');
      const errorText = str(values, 'error_query', 'ERROR');
      const threshold = num(values, 'alert_threshold', 20);
      const base = slugOf(name || namespace, 'content-pack');

      const findings            = [];
      if (isGreedy(pre) && isGreedy(post)) {
        findings.push(
          warning('vcflog.cp.greedy-both', 'The extracted field has a greedy .* on both sides of the value.', {
            remediation: 'Each context should be the few literal characters next to the value. With .* on both sides the engine backtracks across the whole line for every event, and the value it lands on depends on what else is in the line.',
            source: SRC,
          }),
        );
      } else if (isGreedy(pre) || isGreedy(post) || isGreedy(valueRe)) {
        findings.push(info('vcflog.cp.greedy', 'One part of the extracted field is a greedy .* — fine if it is anchored, slow if it is not.', { source: SRC }));
      }
      if (!pre && !post) {
        findings.push(warning('vcflog.cp.no-context', 'The value has no context on either side, so it matches the first thing in any line that fits it.', { source: SRC }));
      }
      try {
        new RegExp(`${pre}(${valueRe})${post}`);
      } catch {
        findings.push(error('vcflog.cp.bad-regex', 'The extracted field does not compile as a regular expression.', { source: SRC }));
      }
      if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/i.test(namespace)) {
        findings.push(warning('vcflog.cp.namespace', `"${namespace}" is not reverse-DNS. Two packs with the same namespace overwrite each other.`, { source: SRC }));
      }
      if (!appFilter) {
        findings.push(warning('vcflog.cp.no-filter', 'The field is extracted from every log line in the system, not just this application’s.', { source: SRC }));
      }

      // The field is tried only on this application's lines: the constraints
      // string the packs carry, with a filter on appname.
      const fieldDef            = {
        displayName: field,
        preContext: pre,
        postContext: post,
        regexValue: valueRe,
        internalName: vlcpInternalName(namespace, field),
        constraints: JSON.stringify(
          appFilter
            ? { filters: [{ internalName: 'appname', displayName: 'appname', operator: 'CONTAINS', value: appFilter, fieldType: 'STRING', isExtracted: false, hidden: false }], searchTerms: '' }
            : { searchTerms: '' },
        ),
        info: `Extracted from ${app} lines.`,
      };
      const appConstraints                   = appFilter ? [{ internalName: 'appname', operator: 'CONTAINS', value: appFilter }] : [];
      const errorQuery = vlcpChartQuery({ constraints: [...appConstraints, { internalName: 'text', operator: 'CONTAINS', value: errorText }] });
      const errorChart = vlcpChartQuery({ constraints: [...appConstraints, { internalName: 'text', operator: 'CONTAINS', value: errorText }], byTime: true });
      const averageChart = vlcpChartQuery({ constraints: [...appConstraints, { internalName: fieldDef.internalName, operator: 'EXISTS' }], average: fieldDef, byTime: true, fields: [fieldDef] });

      const packFile = `import/${base}.vlcp`;
      const packText = contentPackJson({
        name: app,
        namespace,
        contentVersion: version,
        info: `Extracted fields, a query, an alert and a dashboard for ${app}. Generated by ArchToolKit.`,
        instructions: `Configure the agent to tag ${app} logs with appname=${appFilter || '<your app>'}. Enable the alert only after running its query over a day of history.`,
        extractedFields: [fieldDef],
        queries: [{ name: `${app} — errors`, info: 'Every error line from this application.', chartQuery: errorQuery }],
        alerts: [{ name: `${app} — error rate`, info: `More than ${threshold} error lines in 5 minutes.`, chartQuery: errorQuery, hitCount: threshold, searchPeriod: 300000, searchInterval: 60000 }],
        dashboard: {
          name: app,
          widgets: [
            { name: 'Errors over time', info: `Lines containing ${errorText}.`, chartQuery: errorChart },
            { name: `Average ${field}`, info: `Mean of the extracted ${field} over time.`, chartQuery: averageChart },
          ],
        },
      });

      // The saved query of the pack as 9.1 log management keeps it: a query
      // config in VCF Operations (the documented /suite-api/api/logs/queryconfigs,
      // LogsQueryConfig: name, description, queryText, dateRange, queryFilters).
      const queryName = `${app} — errors`;
      const queryConfig = {
        name: queryName,
        description: `Generated by ArchToolKit from the ${namespace} content pack ${version}: every line from ${appFilter ? `appname ${appFilter}` : 'every source'} containing ${errorText}.`,
        queryText: [errorText],
        dateRange: { fixedRange: 'LAST_7_DAYS' },
        queryFilters: {
          logQueryFiltersOperator: 'AND',
          logQueryFilterConditions: appFilter ? [{ conditionField: 'appname', conditionValues: [appFilter], queryFilterConditionOperatorType: 'CONTAINS' }] : [],
        },
      };
      const pkg = toPackage({
        packageName: packageNameOf('logs', 'contentpack', base),
        description: `VCF 9.1 log management: the saved query "${queryName}" of the ${app} content pack ${version}, created in VCF Operations if it is missing. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/Logs/${base}`,
        workflow: {
          name: `Log content ${base}`,
          description: `VCF 9.1 log management, through VCF Operations: creates the saved query "${queryName}" (POST /suite-api/api/logs/queryconfigs) unless one of that name exists, which is left as it is. The rest of the content pack — extracted field, alert, dashboard — has no 9.1 API: it is the .vlcp, converted and installed by hand (IMPORT.md). A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be created and change nothing' }],
          outputs: [
            { name: 'queryConfigId', type: 'string', description: 'The saved query id; empty in a dry run when it does not exist yet' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: CONTENT_PACK_WORKFLOW,
        },
        config: {
          name: 'Settings',
          description: `Settings of the Log content ${base} workflow. Fill opsPassword after import; set dryRun to false only after a dry run.`,
          attributes: [
            { name: 'opsHost', type: 'string', value: '', description: 'VCF Operations 9.1 host (FQDN), where log management is' },
            { name: 'opsUsername', type: 'string', value: '', description: 'An account allowed to manage log queries' },
            { name: 'opsPassword', type: 'SecureString', description: 'Its password' },
            { name: 'opsAuthSource', type: 'string', value: '', description: 'Authentication source for the account; empty for a local account' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is created while this is true' },
            { name: 'cap', type: 'number', value: 1, description: 'The most objects one run may create' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [{ name: 'queryconfig.json', content: `${JSON.stringify(queryConfig, null, 2)}\n` }],
      });

      const importText = importGuide({
        product: 'VCF Operations for Logs',
        intro: `${packFile} is the content pack: one JSON file in the .vlcp format, ${app} version ${version}, namespace ${namespace}. The namespace is its identity — import a new version over the old one; a different namespace is a different pack. The Orchestrator package \`${pkg.packageDir}\` targets **VCF 9.1 log management** (through VCF Operations): it creates the pack's saved query "${queryName}" through the documented /suite-api/api/logs/queryconfigs, with the ordinary OpsToken. It cannot install the pack itself — 9.1 has no API for that — so the .vlcp stays the artifact for the extracted field, the alert and the dashboard.`,
        steps: [
          ...packageSteps(pkg, 'the saved query in 9.1 log management'),
          vlcpImportStep(packFile, `Install it as a content pack (shared, read-only for everyone). If a previous version is installed, the import offers to update it; alert changes made locally are overwritten.`),
          {
            heading: 'Or through the API (standalone 8.18 / 9.0 appliance only)',
            lines: [`\`./scripts/apply.sh\` shows what it would send; \`./scripts/apply.sh --execute\` posts ${packFile} to /api/v2/content/contentpack/import on VCFLOGS_HOST. VERIFY: that route is not in the published Logs API reference — if it answers 404, use the previous step. It does not exist on 9.1 log management.`],
          },
          {
            heading: 'Check it, then enable the alert',
            lines: [
              `Explore Logs, filter to ${appFilter ? `appname contains ${appFilter}` : 'the application'}, and check ${field} appears on recent lines. The alert "${app} — error rate" arrives disabled: run its query over the last day, count the hits, then enable it and choose who it notifies.`,
            ],
          },
        ],
        verify: [
          'Top-level keys, element shapes and the extracted field’s internalName are those of the published packs. `upgradeInstructions` and an icon are left out.',
          `The filter inside the extracted field’s constraints (appname CONTAINS ${appFilter || '…'}) is written as recent exports write it; if Logs ignores it, the field is simply tried on every line.`,
          'The average widget references the extracted field the way the Dell pack’s widgets do (piqlFunctionField, and the field in extractedFields). If it renders empty, rebuild it in the interface and export the pack.',
          'Confirmed for 9.1: GET/POST /suite-api/api/logs/queryconfigs and the LogsQueryConfig body (name, description, queryText, dateRange.fixedRange, queryFilters with logQueryFiltersOperator and logQueryFilterConditions); the list answers { pageInfo, logsQueryConfigs }.',
          ...(appFilter
            ? ['VERIFY: conditionField. The reference example gives a field id (a UUID) there; "appname" is written here as the other 9.1 blueprints write it. If the POST answers 400, read the id of the appname field from a saved query made in Explore Logs (GET /suite-api/api/logs/queryconfigs) and put it in the resource element queryconfig.json.']
            : []),
          'VERIFY: whether queryconfigs honours page and pageSize. The workflow asks for pages of 1000 and stops when pageInfo.totalCount is reached.',
          'VERIFY: 9.1 has no API that installs a content pack or its extracted fields, alerts and dashboards: the .vlcp is converted and installed by hand. The KB 450054 token exchange (serviceKeys ["ops-li"]) authenticates to the log management service, but the service’s own paths are not published.',
        ],
        sources: [
          LOGS_SOURCES.vlcp,
          LOGS_SOURCES.importUi,
          LOGS_SOURCES.import91,
          'developer.broadcom.com, VCF Operations API 9.1, Logs Management: GET/POST/PUT /api/logs/queryconfigs, GET/DELETE /api/logs/queryconfigs/{queryConfigId} (https://developer.broadcom.com/xapis/vcf-operations-api/latest/logs-management/).',
          'Broadcom KB 450054, "Accessing VCF Operations 9.1 Log Management via API" (POST /suite-api/api/auth/token/exchange {"serviceKeys":["ops-li"]}, then Bearer <jwt>).',
        ],
      });

      return {
        platform: LOGS,
        title: `${app} content pack ${version} — fields, query, alert and dashboard`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Imported by hand, once per version.', worstCase: 'once per import' },
        scope: {
          what: `Log lines from ${appFilter ? `appname ${appFilter}` : 'every source'} gain the ${field} field; the alert watches the same lines.`,
          decidedBy: [appFilter ? `The extracted field is constrained to appname CONTAINS ${appFilter}.` : 'No constraint — the field is tried against every line.', 'The agent configuration that sets appname on these lines.'],
          ifWrong: 'The field is tried against every line in the system: slower queries for everyone, and wrong values wherever the pattern happens to match.',
        },
        guardrails: [
          { rule: 'The alert is imported disabled', because: 'An alert that has never been run against real volume is a page storm waiting for its first busy hour.' },
          { rule: 'The extracted field is constrained to this application', because: 'An unconstrained field is evaluated against every line from every source.' },
          { rule: 'The workflow creates the saved query only when none of that name exists, and is a dry run until armed', because: 'Every POST to queryconfigs is a new query; a second run must not make a second one.' },
        ],
        dryRun: [
          `Run the workflow Log content ${base} with dryRun = true (the configuration element keeps it a dry run until its dryRun is set to false): it reads the saved queries and logs "DRY RUN: would create saved query …" or that it exists.`,
          'Before importing, paste the extracted field into Interactive Analytics as an ad-hoc field on the last hour and check what it pulls out.',
          'scripts/apply.sh prints what it would send unless given --execute.',
        ],
        undo: [
          'Content Packs > the pack > Uninstall (9.1: uninstall the converted management pack under Integrations > Repository). Dashboards and alerts it installed go with it; user copies made from them do not.',
          `DELETE /suite-api/api/logs/queryconfigs/{queryConfigId} with the id in the workflow's queryConfigId output, after deleting any alert definition that selects "${queryName}".`,
        ],
        told: ['Nobody. Content is not an event. The workflow’s audit record goes to its webhook when one is set. The alert, once enabled, notifies whatever its own notification is set to.'],
        requires: [
          'Agents or syslog sources that tag these lines with the appname above.',
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Operations certificate trusted in Orchestrator, and a VCF Operations account allowed to manage log queries.',
          'A Logs account with permission to install content packs (8.18 / 9.0), or the VCF Operations administrator who adds management packs (9.1).',
        ],
        files: {
          [packFile]: packText,
          'IMPORT.md': importText,
          ...pkg.files,
          'scripts/apply.sh': fromRoot(applyScript(LOGS, [{ method: 'POST', path: '/api/v2/content/contentpack/import', payload: packFile }], 'Uninstall the content pack from Content Packs in the interface.')),
        },
        notes: [
          'The .vlcp has the top-level keys and element shapes of the packs published at github.com/vmw-loginsight/vlcp: framework "#9c4", format version "2.4", the pack version in contentVersion, and the extracted field’s internalName encoded the way those packs encode it.',
          'Queries, the alert and the widgets carry chartQuery — field constraints as a JSON string — not a text query: Logs has no pipe-and-function query language to write one in.',
          'Version the namespace’s content in a repository. The pack is the unit of change: edit it there, bump the version, import over the old one.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog_forwarding',
    platform: LOGS,
    label: 'Forward logs to another system',
    group: 'Forwarding',
    description:
      'A forwarding destination: a Splunk heavy forwarder over syslog on TLS, or another Logs instance over its own ingestion API, with a filter so only what the other side needs is sent and a disk-backed queue so a restart at the far end does not drop events.',
    inputs: [
      { id: 'dest_name', label: 'Name', control: 'text', default: 'Splunk heavy forwarder' },
      { id: 'host', label: 'Destination host', control: 'text', default: 'splunk-hf01.example.com' },
      {
        id: 'protocol',
        label: 'Protocol',
        control: 'select',
        options: [
          { value: 'syslog-tls', label: 'Syslog over TLS' },
          { value: 'syslog-tcp', label: 'Syslog over TCP' },
          { value: 'syslog-udp', label: 'Syslog over UDP' },
          { value: 'cfapi', label: 'Another Logs instance (cfapi)' },
          { value: 'raw', label: 'Raw TCP' },
        ],
        default: 'syslog-tls',
      },
      { id: 'port', label: 'Port', control: 'number', default: 6514, min: 1, max: 65535, hint: '6514 syslog TLS, 514 plain, 9543 cfapi TLS' },
      { id: 'filter', label: 'Only forward', control: 'textarea', default: '(appname=~"orders-api") or (hostname=~"esx*")', hint: 'A Logs forwarding filter: field=~"glob", and / or / not. Empty forwards everything' },
      { id: 'queue_mb', label: 'Disk queue (MB)', control: 'number', default: 2000, min: 0, max: 100000 },
      { id: 'workers', label: 'Worker connections', control: 'number', default: 8, min: 1, max: 32 },
      { id: 'add_tags', label: 'Tag forwarded events', control: 'text', default: 'forwarded_from=vcflogs01' },
    ],
    automation: (values                 , name        )             => {
      const destName = str(values, 'dest_name', 'Forwarder');
      const host = str(values, 'host', '');
      const protocol = str(values, 'protocol', 'syslog-tls');
      const port = num(values, 'port', 6514);
      const filter = str(values, 'filter', '');
      const queue = num(values, 'queue_mb', 2000);
      const workers = num(values, 'workers', 8);
      const tags = listOf(str(values, 'add_tags', ''));
      const base = slugOf(name || destName, 'forwarding');

      const findings            = [];
      if (protocol === 'syslog-udp') {
        findings.push(
          warning('vcflog.fwd.udp', 'Syslog over UDP drops events silently when the destination is busy or restarting, and sends them in clear text.', {
            remediation: 'Use syslog over TLS. If the destination cannot take TLS, TCP at least tells the sender that it did not arrive.',
            source: SRC,
          }),
        );
      }
      if (!filter) {
        findings.push(
          warning('vcflog.fwd.no-filter', 'No filter: every event is forwarded.', {
            remediation: 'The destination ingests — and usually licenses — everything sent to it. Forward what the other team asked for, not the firehose; the full copy already lives here.',
            source: SRC,
          }),
        );
      }
      if (queue === 0) {
        findings.push(warning('vcflog.fwd.no-queue', 'With no disk queue, anything sent while the destination is down is lost.', { source: SRC }));
      }
      if (protocol === 'cfapi' && port !== 9543 && port !== 9000) {
        findings.push(info('vcflog.fwd.cfapi-port', 'cfapi listens on 9543 (TLS) or 9000 (plain) by default.', { source: SRC }));
      }
      if (protocol === 'syslog-tls' && port === 514) {
        findings.push(warning('vcflog.fwd.tls-port', 'Port 514 is plain syslog; TLS syslog is normally 6514.', { source: SRC }));
      }

      const tls = protocol === 'syslog-tls' || protocol === 'cfapi';
      // The body of a log forwarder as the Logs API takes it (the working
      // example in thomas-kopton.de's 8.18-to-9 migration): diskCacheSize in
      // bytes, protocol syslog / cfapi / raw, transportProtocol tcp / udp.
      const payload = {
        acceptCert: false,
        name: destName,
        host,
        port,
        protocol: protocol.startsWith('syslog') ? 'syslog' : protocol,
        sslEnabled: tls,
        workerCount: workers,
        diskCacheSize: queue * 1024 * 1024,
        tags: Object.fromEntries(tags.map((tag) => tag.split('=').map((part) => part.trim())                    )),
        filter: filter || '',
        transportProtocol: protocol === 'syslog-udp' ? 'udp' : 'tcp',
        forwardComplementaryFields: false,
      };
      if (filter && /\b(OR|AND|STARTS_WITH|CONTAINS)\b|[^=!]=\s*"/.test(filter)) {
        findings.push(warning('vcflog.fwd.filter-syntax', 'The filter does not look like a Logs forwarding filter.', { remediation: 'Forwarding filters are written field=~"glob", joined with lower-case and / or / not, e.g. (appname=~"orders-api") or (hostname=~"esx*"). Check it in the forwarding dialog’s filter preview.', source: SRC }));
      }

      const packageName = packageNameOf('logs', 'forwarding', base);
      const pkg = toPackage({
        packageName,
        description: `Standalone VCF Operations for Logs 8.18 / 9.0: the forwarding destination "${destName}" (${host}:${port}), created if missing. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/Logs/${base}`,
        workflow: {
          name: `Create log forwarder ${base}`,
          description: `Standalone VCF Operations for Logs 8.18 / 9.0 appliance: creates the forwarding destination "${destName}" through POST /api/v2/log-forwarder unless one of that name exists, which is left as it is (differences are reported). Not for VCF 9.1 log management, whose forwarding is set in VCF Operations by hand. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be created and change nothing' }],
          outputs: [
            { name: 'forwarderId', type: 'string', description: 'The forwarder id when the appliance returns one; empty in a dry run' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: FORWARDER_WORKFLOW,
        },
        actions: logsApplianceActions(packageName),
        config: {
          name: 'Settings',
          description: `Settings of the Create log forwarder ${base} workflow. Fill logsPassword after import; set dryRun to false only after a dry run.`,
          attributes: [
            ...LOGS_APPLIANCE_SETTINGS,
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is created while this is true' },
            { name: 'cap', type: 'number', value: 1, description: 'The most objects one run may create' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [{ name: 'forwarder.json', content: `${JSON.stringify(payload, null, 2)}\n` }],
      });

      return {
        platform: LOGS,
        title: `Forward ${filter ? 'filtered' : 'all'} events to ${destName} (${protocol})`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Configured once; from then on every matching event is forwarded as it arrives.', worstCase: 'every matching event, continuously' },
        scope: {
          what: filter ? `Events matching: ${filter}` : 'Every event this Logs instance ingests.',
          decidedBy: ['The filter above, evaluated on each event as it is ingested.', 'Only events ingested after the destination is created — nothing historical is sent.'],
          ifWrong: 'The destination receives far more than it expected: a licence overrun on the Splunk side, a full disk on a receiving Logs instance, and nothing on this side to notice.',
        },
        guardrails: [
          { rule: 'Filtered at the source', because: 'The cheapest event to license is the one never sent.' },
          { rule: 'The workflow creates the destination only when none of that name exists, and never edits one that does', because: 'Two forwarders with the same filter send every event twice; an edited one may be feeding somebody else’s pipeline.' },
          { rule: `Disk-backed queue of ${queue} MB`, because: 'A restart at the far end should delay events, not lose them.' },
          ...(tls ? [{ rule: 'Encrypted in transit', because: 'Logs carry usernames, hostnames and sometimes things that should never have been logged.' }] : []),
        ],
        dryRun: [
          `Run the workflow Create log forwarder ${base} with dryRun = true (the configuration element keeps it a dry run until its dryRun is set to false): it reads the destinations and logs "DRY RUN: would create log forwarder …" or that it exists.`,
          filter ? `Run the filter in Interactive Analytics over the last day and read the event count — that is the daily volume this sends.` : 'Look at the ingestion rate on the system dashboard. That whole rate is what this sends.',
          'scripts/apply.sh prints what it would send unless given --execute.',
        ],
        undo: ['Delete the destination under Log Forwarding, or DELETE /api/v2/log-forwarder/{id} with the id in the workflow\'s forwarderId output. Events already forwarded stay at the destination.'],
        told: ['Nobody. The workflow’s audit record goes to its webhook when one is set. Watch the forwarder’s dropped and queued counters on the Log Forwarding page, or add them to the Logs health check.'],
        requires: [
          `${host}:${port} reachable from every Logs node.`,
          ...(tls ? ['The destination’s certificate chain trusted by Logs.'] : []),
          ...(protocol.startsWith('syslog') ? ['On Splunk: a TCP/TLS input on the heavy forwarder with the right sourcetype. Logs does not send to the HTTP Event Collector directly.'] : []),
        ],
        files: {
          // First among the import/ JSON files: it is the destination's body.
          [`import/${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          ...pkg.files,
          'scripts/apply.sh': fromRoot(applyScript(LOGS, [{ method: 'POST', path: '/api/v2/log-forwarder', payload: `import/${base}.json` }], 'DELETE /api/v2/log-forwarder/{id}, or remove it under Log Forwarding.')),
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Logs',
            intro: `Logs has no file import for a forwarding destination: it goes in through the API or is typed into the Log Forwarding dialog with the values from import/${base}.json. The Orchestrator package \`${pkg.packageDir}\` targets the **standalone VCF Operations for Logs 8.18 / 9.0 appliance** (its /api/v2 on port 9543): it creates the destination through POST /api/v2/log-forwarder unless one of the same name exists. **VCF 9.1 log management has no public API for forwarding destinations** — set it by hand there (step ${pkg.importSteps.length + 2}).`,
            steps: [
              ...packageSteps(pkg, 'the forwarding destination on the standalone appliance'),
              {
                heading: 'Or: the script, or by hand',
                lines: [
                  `\`./scripts/apply.sh\` shows what it would send; \`./scripts/apply.sh --execute\` posts \`import/${base}.json\` to /api/v2/log-forwarder on VCFLOGS_HOST. It is not idempotent: run it once.`,
                  '',
                  `By hand instead: Configuration > Log Forwarding > New Destination, with name ${destName}, host ${host}, protocol ${payload.protocol}${payload.protocol === 'syslog' ? ` over ${payload.transportProtocol}` : ''}, port ${port}, SSL ${tls ? 'on' : 'off'}, the filter and tags from the file, then Test and Save.`,
                ],
              },
              {
                heading: 'VCF 9.1 log management',
                lines: [
                  'In 9.1 forwarding is set in VCF Operations: Operate > Administration > Configurations > Log Management, forwarding — enter the values from the file in the dialog. The /api/v2 routes belong to the separate Logs appliance of 8.18 / 9.0 and do not exist on 9.1.',
                  '',
                  'Do not use /suite-api/api/logs/forwarding for this: in the VCF Operations API it forwards VCF Operations’ own logs (entities ANALYTICS, COLLECTOR, …), not the events log management ingests.',
                ],
              },
            ],
            verify: [
              'Body: every field is from a working POST body published for 8.18/9.0 (acceptCert, name, host, port, protocol, sslEnabled, workerCount, diskCacheSize in bytes, tags, filter, transportProtocol, forwardComplementaryFields).',
              'Path: GET and POST /api/v2/log-forwarder are in the "Log Forwarder" section of the Logs API reference (with GET/PUT/PATCH/DELETE …/{id}); one published migration example writes /api/v2/log-forwarders, and older releases used /api/v1/forwarding. VERIFY in https://<logs host>/rest-api on your release.',
              'VERIFY: the shape of the GET /api/v2/log-forwarder response is not published. The workflow takes the body when it is an array, or its first array-valued property, and refuses to act on anything else.',
              'VERIFY (9.1): the KB 450054 exchange (serviceKeys ["ops-li"]) yields a token for the 9.1 log management service, but its forwarding API is not published; until it is, 9.1 forwarding is configured by hand.',
            ],
            sources: [
              'developer.broadcom.com, VMware Aria Operations for Logs API: Sessions (POST /api/v2/sessions) and Log Forwarder (GET/POST /v2/log-forwarder, …/{id}, …/testconnection) (https://developer.broadcom.com/xapis/vrealize-log-insight-api/latest/log-forwarder/).',
              'thomas-kopton.de, "Migrating Content and Config from Aria Operations for Logs 8.18 to VCF Operations for Logs 9" (the forwarder POST body, and the /rest-api Swagger page).',
              'developer.broadcom.com, VCF Operations API 9.1: PUT /api/logs/forwarding (VCF Operations’ own logs; entities, host, protocol CFAPI/SYSLOG).',
              'gibsonvirt.com, "VCF 9.1 – What’s New? VCF Operations for Logs" (Operate > Administration > Configurations > Log Management).',
              'Broadcom KB 450054, "Accessing VCF Operations 9.1 Log Management via API".',
            ],
          }),
        },
        notes: [
          'The forwarding API path is not stable across releases: /api/v1/forwarding in older ones, the Log Forwarder section (/api/v2/log-forwarder) in the current reference. The body here is a working 8.18/9.0 one; verify the path in /rest-api on your release.',
          'Forwarding to Splunk HEC is not supported natively. Syslog to a heavy forwarder is the supported route.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog_agent_group',
    platform: LOGS,
    label: 'Agent configuration for a group of servers',
    group: 'Agents',
    description:
      'The liagent.ini that tells the agent which files or event channels to ship and where to, and the agent group that applies it centrally to servers matching a filter — so configuration is set once in Logs rather than edited on each server.',
    inputs: [
      { id: 'group_name', label: 'Agent group', control: 'text', default: 'Orders API servers' },
      { id: 'os', label: 'Operating system', control: 'select', options: [{ value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' }], default: 'linux' },
      { id: 'hostname_filter', label: 'Servers named', control: 'text', default: 'orders-*', hint: 'Glob on the agent hostname' },
      { id: 'server', label: 'Logs server', control: 'text', default: 'vcflogs.example.com' },
      { id: 'ssl', label: 'TLS', control: 'toggle', default: true },
      { id: 'app', label: 'Application tag', control: 'text', default: 'orders-api' },
      { id: 'directory', label: 'Log directory', control: 'text', default: '/var/log/orders', showWhen: { input: 'os', equals: ['linux'] } },
      { id: 'include', label: 'Files', control: 'text', default: '*.log', showWhen: { input: 'os', equals: ['linux'] } },
      { id: 'channels', label: 'Event channels', control: 'text', default: 'Application, System, Security', showWhen: { input: 'os', equals: ['windows'] } },
      { id: 'win_directory', label: 'Also a log directory', control: 'text', default: 'C:\\ProgramData\\Orders\\Logs', showWhen: { input: 'os', equals: ['windows'] } },
    ],
    automation: (values                 , name        )             => {
      const group = str(values, 'group_name', 'Agent group');
      const os = str(values, 'os', 'linux');
      const filter = str(values, 'hostname_filter', '');
      const server = str(values, 'server', '');
      const ssl = bool(values, 'ssl', true);
      const app = str(values, 'app', 'app');
      const directory = str(values, 'directory', '/var/log');
      const include = str(values, 'include', '*.log');
      const channels = listOf(str(values, 'channels', ''));
      const winDir = str(values, 'win_directory', '');
      const base = slugOf(name || group, 'agent-group');
      const appSlug = slugOf(app, 'app');

      const findings            = [];
      if (!ssl) {
        findings.push(
          warning('vcflog.agent.no-ssl', 'ssl=no sends every log line in clear text across the network.', {
            remediation: 'Use ssl=yes on 9543. The agent trusts the Logs certificate on first connect unless ssl_ca_path is set, so set that too.',
            source: SRC,
          }),
        );
      }
      if (os === 'linux' && /^\/var\/log\/?$/.test(directory) && /^\*(\.\*)?$/.test(include)) {
        findings.push(
          warning('vcflog.agent.everything', 'include=* in /var/log ships every file there, including rotated and compressed ones and anything the OS already sends by syslog.', {
            remediation: 'Name the application’s files. Duplicate and binary lines cost ingest and make searches worse.',
            source: SRC,
          }),
        );
      }
      if (!filter) {
        findings.push(warning('vcflog.agent.no-filter', 'The agent group has no hostname filter, so it applies to every agent.', { source: SRC }));
      }

      const serverSection = ['[server]', `hostname=${server}`, 'proto=cfapi', `port=${ssl ? 9543 : 9000}`, `ssl=${ssl ? 'yes' : 'no'}`, ...(ssl ? ['; ssl_ca_path=/etc/pki/tls/certs/vcflogs-ca.pem   ; set this to pin the CA'] : []), ''];
      const body =
        os === 'linux'
          ? [`[filelog|${appSlug}]`, `directory=${directory}`, `include=${include}`, 'exclude=*.gz;*.zip;*.[0-9]', 'parser=auto', `tags={"appname":"${app}"}`, '']
          : [
              ...channels.flatMap((channel) => [`[winlog|${slugOf(channel, 'channel')}]`, `channel=${channel}`, `tags={"appname":"${app}"}`, '']),
              ...(winDir ? [`[filelog|${appSlug}]`, `directory=${winDir}`, 'include=*.log', 'parser=auto', `tags={"appname":"${app}"}`, ''] : []),
            ];
      const ini = ['; Generated by ArchToolKit. Central configuration for the agent group', `; "${group}". Agent-local settings in the file on each server still apply.`, '', ...serverSection, ...body].join('\n');

      const groupPayload = {
        name: group,
        info: `Generated by ArchToolKit for ${app} on ${os}.`,
        criteria: { hostname: filter || '*', os: os === 'linux' ? 'Linux' : 'Windows' },
        agentConfig: ini,
      };

      const packageName = packageNameOf('logs', 'agentgroup', base);
      const pkg = toPackage({
        packageName,
        description: `Standalone VCF Operations for Logs 8.18 / 9.0: the agent group "${group}" with its central liagent.ini, created if missing. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/Logs/${base}`,
        workflow: {
          name: `Create agent group ${base}`,
          description: `Standalone VCF Operations for Logs 8.18 / 9.0 appliance: creates the agent group "${group}" (hostname ${filter || '*'}, ${os}) with the central agent configuration, unless one of that name exists. The API route is not in the published reference: when the appliance answers 404 the run stops before changing anything. Not for VCF 9.1, where agent groups are made in VCF Operations by hand. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be created and change nothing' }],
          outputs: [{ name: 'summary', type: 'string', description: 'The audit record, JSON' }],
          script: AGENT_GROUP_WORKFLOW,
        },
        actions: logsApplianceActions(packageName),
        config: {
          name: 'Settings',
          description: `Settings of the Create agent group ${base} workflow. Fill logsPassword after import; set dryRun to false only after a dry run.`,
          attributes: [
            ...LOGS_APPLIANCE_SETTINGS,
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is created while this is true' },
            { name: 'cap', type: 'number', value: 1, description: 'The most objects one run may create' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [
          { name: 'agent-group.json', content: `${JSON.stringify(groupPayload, null, 2)}\n` },
          { name: 'liagent.ini', content: `${ini}\n` },
        ],
      });

      return {
        platform: LOGS,
        title: `Agent group "${group}" — ship ${app} logs from ${os === 'linux' ? directory : `${channels.join(', ')}`}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Created once. Agents matching the filter pick up the configuration on their next check-in.', worstCase: 'every matching agent within minutes' },
        scope: {
          what: `Agents on ${os} servers whose hostname matches ${filter || 'anything'}.`,
          decidedBy: [`The agent group filter: hostname ${filter || '*'}, OS ${os}.`, 'Agents register with this Logs instance — an agent pointed elsewhere is not affected.'],
          ifWrong: 'The configuration is pushed to servers it was not written for: they start shipping files that do not exist (harmless) or files that do and should not be shipped (not harmless).',
        },
        guardrails: [
          { rule: 'Scoped by hostname and OS', because: 'An agent group with no filter applies to every agent in the estate.' },
          { rule: 'Named files, not the whole directory', because: 'Shipping everything in a log directory ships the rotated copies and the binaries too.' },
          { rule: 'The workflow creates the group only when none of that name exists, and never replaces the configuration of one that does', because: 'A group in use is pushing configuration to live agents; replacing it is a change to every one of them.' },
        ],
        dryRun: [
          'Put the generated liagent.ini on one server by hand first and watch its lines arrive in Interactive Analytics filtered to the appname.',
          `Run the workflow Create agent group ${base} with dryRun = true (the configuration element keeps it a dry run until its dryRun is set to false): it reads the agent groups and logs "DRY RUN: would create agent group …" or that it exists.`,
          'scripts/apply.sh prints what it would send unless given --execute.',
        ],
        undo: ['Delete the agent group. Agents drop the central configuration at their next check-in and fall back to their local liagent.ini.'],
        told: ['Nobody. The workflow’s audit record goes to its webhook when one is set. Agent status is on the Agents page; a missing agent is only noticed if something watches it.'],
        requires: ['The Logs agent installed on each server, pointed at this Logs instance.', ssl ? `Port 9543 open from the servers to ${server}.` : `Port 9000 open from the servers to ${server}.`],
        files: {
          'import/liagent.ini': `${ini}\n`,
          [`import/${base}.json`]: `${JSON.stringify(groupPayload, null, 2)}\n`,
          ...pkg.files,
          'scripts/apply.sh': fromRoot(applyScript(LOGS, [{ method: 'POST', path: '/api/v2/agent/groups', payload: `import/${base}.json` }], 'Delete the agent group under Management > Agents.')),
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Logs',
            intro: `import/liagent.ini is the agent configuration in the agent’s own INI format. It goes in one of two places: pasted into an agent group, so every matching agent receives it centrally, or dropped on a server as its local liagent.ini. The agent group itself has no file import. The Orchestrator package \`${pkg.packageDir}\` targets the **standalone VCF Operations for Logs 8.18 / 9.0 appliance**: it creates the group from import/${base}.json unless one of that name exists — through a route that is not in the published reference, so a 404 stops it before anything changes. **On VCF 9.1 the group is made by hand** in VCF Operations (the step "Create the agent group" below); 9.1 publishes no agent group API.`,
            steps: [
              ...packageSteps(pkg, 'the agent group on the standalone appliance'),
              {
                heading: 'Try it on one server first',
                lines: [
                  `Copy import/liagent.ini over the agent’s file and restart the agent:`,
                  '',
                  os === 'linux'
                    ? '- Linux: `/var/lib/loginsight-agent/liagent.ini`, then `systemctl restart liagentd`. (The 9.1 agent documentation refers to `/etc/liagent.ini`; use whichever path your installed agent reads — VERIFY.)'
                    : '- Windows: `C:\\ProgramData\\VMware\\Log Insight Agent\\liagent.ini`, then `Restart-Service LogInsightAgentService`.',
                  '',
                  `Then filter Explore Logs to appname ${app} and check lines arrive.`,
                  ...(ssl ? ['', 'On VCF 9.1 the agent authenticates: add `secret=<agent token>` to the [server] section, the token copied from Log Collection in VCF Operations. Never commit the file with the token in it.'] : []),
                ],
              },
              {
                heading: 'Create the agent group',
                lines: [
                  `- **VCF 9.1:** Operate > Administration > Configurations > Log Collection > Agent Group tab > ADD. Name "${group}", ADD FILTER hostname ${filter ? `Starts with/Contains ${filter.replace(/\*/g, '')}` : '(none)'} and OS ${os === 'linux' ? 'Linux' : 'Windows'}, Preview, NEXT; Agent Configuration > New Agent Group > Code View, paste import/liagent.ini without the [server] section, save.`,
                  `- **9.0 and 8.x:** Configuration > Agents (Management > Agents on older releases) > the agents drop-down > New Group; the same filter; paste import/liagent.ini into Agent Configuration; Save New Group.`,
                  `- **API (8.18 / 9.0):** the workflow above, or \`./scripts/apply.sh --execute\`, which posts import/${base}.json to /api/v2/agent/groups — VERIFY first: that route and body are not in the published Logs API reference.`,
                ],
              },
            ],
            verify: [
              'The INI sections ([server], [filelog|name] with directory, include, exclude, parser, tags; [winlog|name] with channel) are the agent’s documented format.',
              'Whether Code View accepts the [server] section: the server is usually set at install time, so it is left out when pasting (VERIFY).',
              'VERIFY: GET/POST /api/v2/agent/groups and the body (name, info, criteria, agentConfig) are not in the published Logs API reference (its sections are Sessions, Log Forwarder, Events, Vsphere, Users, … — no agent groups). The workflow stops on a 404 before creating anything; its list reading takes an array or the first array-valued property and refuses anything else.',
              'VERIFY (9.1): no agent group API is published for 9.1 log management; the KB 450054 ops-li token reaches the service but its paths are not documented.',
            ],
            sources: [
              LOGS_SOURCES.agent91,
              'Aria Operations for Logs 8.x agent administration guide: liagent.ini sections and agent groups.',
              'developer.broadcom.com, VMware Aria Operations for Logs API: the category list (https://developer.broadcom.com/xapis/vrealize-log-insight-api/latest/) and Sessions (POST /api/v2/sessions).',
            ],
          }),
        },
        notes: [
          'Agent groups are most reliably created in the interface (Management > Agents > the group dropdown > New Group; 9.1: Log Collection > Agent Group), pasting liagent.ini into the configuration box. The API route and body the workflow and scripts/apply.sh use are not in the published reference; the workflow stops on a 404 before changing anything.',
          'Central configuration merges with the local file on each server. A setting in both places takes the central value.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog_retention',
    platform: LOGS,
    label: 'Index partitions, retention and archiving',
    group: 'Retention',
    description:
      'Keep different logs for different lengths of time: an index partition for a class of events with its own retention, and archiving to NFS so events older than that still exist somewhere when an auditor asks. Set against the retention the organisation is actually required to keep, not the disk that happens to be free.',
    inputs: [
      { id: 'partition', label: 'Partition name', control: 'text', default: 'audit' },
      { id: 'filter', label: 'Events in it', control: 'textarea', default: 'appname = "sshd" OR appname = "sudo" OR text CONTAINS "vpxd-svcs"' },
      { id: 'retention_days', label: 'Keep searchable for (days)', control: 'number', default: 90, min: 1, max: 3650 },
      { id: 'required_days', label: 'Required retention (days)', control: 'number', default: 365, min: 1, max: 3650, hint: 'What policy or regulation requires' },
      { id: 'archive', label: 'Archive to NFS', control: 'text', default: 'nfs://nas01.example.com/exports/vcflogs-archive', hint: 'Empty for no archive' },
    ],
    automation: (values                 , name        )             => {
      const partition = str(values, 'partition', 'partition');
      const filter = str(values, 'filter', '');
      const retention = num(values, 'retention_days', 90);
      const required = num(values, 'required_days', 365);
      const archive = str(values, 'archive', '');
      const base = slugOf(name || partition, 'retention');

      const findings            = [];
      if (!archive && retention < required) {
        findings.push(
          error('vcflog.retention.short', `Events are deleted after ${retention} days and not archived, against a requirement of ${required} days.`, {
            remediation: 'Either archive to NFS, or raise retention to the requirement and size the disk for it. As it stands, events the organisation must keep are deleted.',
            source: SRC,
          }),
        );
      } else if (archive && retention < required) {
        findings.push(info('vcflog.retention.archive-carries', `Days ${retention}–${required} exist only in the archive. Searching them means importing the archive back into a Logs instance.`, { source: SRC }));
      }
      if (archive && !/^nfs:\/\/[^/]+\/.+/.test(archive)) {
        findings.push(error('vcflog.retention.nfs-uri', `"${archive}" is not an nfs://server/export/path URI.`, { source: SRC }));
      }
      if (!filter) {
        findings.push(warning('vcflog.retention.no-filter', 'A partition with no filter is the default partition under another name.', { source: SRC }));
      }

      const partitionPayload = { name: partition, enabled: true, retentionPeriod: retention, filter };
      const archivePayload = archive ? { enabled: true, archiveUri: archive } : null;

      const packageName = packageNameOf('logs', 'retention', base);
      const pkg = toPackage({
        packageName,
        description: `Standalone VCF Operations for Logs 8.18 / 9.0: the index partition "${partition}" (${retention} days)${archive ? ` and archiving to ${archive}` : ''}, created if missing, never edited. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/Logs/${base}`,
        workflow: {
          name: `Set retention ${base}`,
          description: `Standalone VCF Operations for Logs 8.18 / 9.0 appliance: creates the index partition "${partition}" keeping ${retention} days${archive ? `, and turns on archiving to ${archive}` : ''}, unless they exist. An existing partition is never edited (a retention change deletes events) and an archive already on elsewhere is never redirected. The API routes are not in the published reference: a 404 stops the run before anything changes. Not for VCF 9.1, where retention is set in VCF Operations by hand. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would change and change nothing' }],
          outputs: [{ name: 'summary', type: 'string', description: 'The audit record, JSON' }],
          script: RETENTION_WORKFLOW.replace('HAS_ARCHIVE_VALUE', archivePayload ? 'true' : 'false'),
        },
        actions: logsApplianceActions(packageName),
        config: {
          name: 'Settings',
          description: `Settings of the Set retention ${base} workflow. Fill logsPassword after import; set dryRun to false only after a dry run, under an approved change.`,
          attributes: [
            ...LOGS_APPLIANCE_SETTINGS,
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is changed while this is true' },
            { name: 'cap', type: 'number', value: archivePayload ? 2 : 1, description: 'The most changes one run may make' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [
          { name: 'partition.json', content: `${JSON.stringify(partitionPayload, null, 2)}\n` },
          ...(archivePayload ? [{ name: 'archive.json', content: `${JSON.stringify(archivePayload, null, 2)}\n` }] : []),
        ],
      });

      return {
        platform: LOGS,
        title: `Partition "${partition}" — ${retention} days searchable${archive ? `, archived to ${archive}` : ', not archived'}`,
        effect: 'irreversible',
        trigger: { kind: 'schedule', detail: `Configured once; from then on Logs deletes events in this partition older than ${retention} days, continuously.`, worstCase: 'every day, on every event past its retention' },
        scope: {
          what: `Events matching the partition filter, from the moment it is created. Older events stay where they were ingested.`,
          decidedBy: ['The partition filter, evaluated at ingest.', `Retention of ${retention} days on that partition.`, archive ? `Archiving of every event to ${archive}, which has no retention of its own — the NFS server’s is what applies.` : 'No archive.'],
          ifWrong: 'Shortening retention deletes events older than the new value at the next cleanup. They cannot be brought back unless an archive holds them.',
        },
        guardrails: [
          { rule: 'Armed only under an approved change: the workflow is a dry run until dryRun is set to false', because: 'Reducing retention is a deletion. Somebody accountable for the requirement should agree to it.' },
          { rule: 'An existing partition is never edited, and an archive already on elsewhere is never redirected', because: 'Changing the retention of a partition in use deletes events at the next cleanup; redirecting an archive breaks whoever reads the old one.' },
          { rule: `Checked against the required ${required} days`, because: 'The number that matters is what the organisation must keep, not what fits on disk.' },
          ...(archive ? [{ rule: 'Archived before it is deleted', because: 'The archive is what makes the retention reversible for the auditor, if not for the search bar.' }] : []),
        ],
        dryRun: [
          `Run the workflow Set retention ${base} with dryRun = true (the configuration element keeps it a dry run until its dryRun is set to false): it reads the partitions${archive ? ' and the archive setting' : ''} and logs what it would create.`,
          'Run the filter in Interactive Analytics over the last day to see what the partition will hold and how fast it grows.',
          'scripts/apply.sh prints what it would send unless given --execute.',
        ],
        undo: [
          'Raise the retention back. Events already deleted are gone.',
          archive ? `Events past retention can be recovered from ${archive} by importing the archive into a Logs instance.` : 'Without an archive, nothing past retention can be recovered.',
        ],
        told: ['Nobody. The workflow’s audit record goes to its webhook when one is set. Retention runs quietly; check the partition’s oldest event on the Index Partitions page.'],
        requires: [
          'Disk on every Logs node for the partition at its ingest rate times its retention.',
          ...(archive ? [`The NFS export writable by the Logs nodes, sized for ${required} days at least, with its own retention and backup.`] : []),
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the Logs appliance certificate trusted in Orchestrator.',
        ],
        files: {
          [`import/${base}-partition.json`]: `${JSON.stringify(partitionPayload, null, 2)}\n`,
          ...(archivePayload ? { [`import/${base}-archive.json`]: `${JSON.stringify(archivePayload, null, 2)}\n` } : {}),
          ...pkg.files,
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Logs',
            intro: `Index partitions and archiving have no file import. They are set in the interface, or through the API from the files under import/. The Orchestrator package \`${pkg.packageDir}\` targets the **standalone VCF Operations for Logs 8.18 / 9.0 appliance**: it creates the partition${archive ? ' and turns on archiving' : ''} unless they exist, never edits an existing partition and never redirects an archive — through routes that are not in the published reference, so a 404 stops it before anything changes. **On VCF 9.1 this is set by hand** in VCF Operations (Operate > Administration > Configurations > Log Management); 9.1 publishes no retention or archiving API.`,
            steps: [
              ...packageSteps(pkg, 'the partition and archiving on the standalone appliance'),
              {
                heading: 'Or: create the partition by hand, or with the script',
                lines: [
                  `- Interface (8.x, 9.0): Configuration > Index Partitions > New Partition: name ${partition}, retention ${retention} days, the filter from import/${base}-partition.json. In 9.1: Operate > Administration > Configurations > Log Management (VERIFY where partitions sit on your build).`,
                  `- API: \`./scripts/apply.sh --execute\` posts import/${base}-partition.json to /api/v2/partitions${archive ? ` and puts import/${base}-archive.json to /api/v2/archiving` : ''} (VERIFY — not in the published reference; check /rest-api on the appliance). It is not idempotent.`,
                ],
              },
              archivePayload
                ? {
                    heading: 'Or: turn on archiving by hand',
                    lines: [`- Interface: Configuration > Archiving > Enable Data Archiving, NFS path ${archive}, Test, Save. The workflow and scripts/apply.sh send import/${base}-archive.json to /api/v2/archiving (VERIFY; /api/v1/archiving/config is the deprecated, documented route).`],
                  }
                : undefined,
            ],
            verify: [
              'Field names in both files (retentionPeriod, filter; archiveUri) are not in the published API reference. Read the objects back from /rest-api after creating one in the interface and compare.',
              'VERIFY: GET/POST /api/v2/partitions and GET/PUT /api/v2/archiving are not in the published Logs API reference. The workflow stops on a 404 before changing anything; its list reading takes an array or the first array-valued property and refuses anything else.',
              'VERIFY (9.1): no index partition, retention or archiving API is published for 9.1 log management; the KB 450054 ops-li token reaches the service but its paths are not documented.',
            ],
            sources: [
              'vmw-loginsight.github.io: /api/v1/archiving/config (deprecated).',
              'Aria Operations for Logs 8.x administration guide: Index Partitions, Archiving.',
              'developer.broadcom.com, VMware Aria Operations for Logs API: the category list and Sessions (POST /api/v2/sessions) (https://developer.broadcom.com/xapis/vrealize-log-insight-api/latest/).',
              'Broadcom KB 450054, "Accessing VCF Operations 9.1 Log Management via API".',
            ],
          }),
          'scripts/apply.sh': fromRoot(
            applyScript(
              LOGS,
              [
                { method: 'POST', path: '/api/v2/partitions', payload: `import/${base}-partition.json` },
                ...(archivePayload ? [{ method: 'PUT'         , path: '/api/v2/archiving', payload: `import/${base}-archive.json` }] : []),
              ],
              'Edit the partition retention back up; delete the partition under Index Partitions. Deleted events do not come back.',
            ),
          ),
        },
        notes: [
          'Index partitions and archiving are in the interface under Management > Index Partitions and Management > Archiving. The API routes the workflow and scripts/apply.sh use (/api/v2/partitions, /api/v2/archiving) are not documented identically across releases; verify both, or configure in the interface.',
          'Archives are written continuously, not at deletion time, so the archive grows from the day it is turned on — not from the first day of retention.',
        ],
        findings,
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// VCF Operations for Networks
// ---------------------------------------------------------------------------

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

/**
 * The data-source types, their list path under /api/ni, and — for the two that
 * carry flows — the body field that turns IPFIX on as the source is added, as
 * the 9.1 API reference documents it: ipfix_request.enable_all on a vCenter
 * (every distributed switch), ipfix_enabled on an NSX Manager.
 */
const SOURCE_TYPES                                                                                                                                             = {
  vcenter: { label: 'vCenter', path: '/data-sources/vcenters', flows: true, ipfix: { ipfix_request: { enable_all: true } } },
  nsxt: { label: 'NSX Manager', path: '/data-sources/nsxt-managers', flows: true, ipfix: { ipfix_enabled: true } },
  cisco: { label: 'Cisco switch', path: '/data-sources/cisco-switches', flows: false, extra: { switch_type: '<REQUIRED — e.g. CATALYST_3000, NEXUS_9K; verify>' } },
  arista: { label: 'Arista switch', path: '/data-sources/arista-switches', flows: false },
  juniper: { label: 'Juniper switch', path: '/data-sources/juniper-switches', flows: false, extra: { switch_type: '<REQUIRED — e.g. EX, QFX; verify>' } },
};

/**
 * Add the data sources that are not there yet, through a named collector, each
 * password from its own SecureString attribute. What exists (by FQDN or IP) is
 * left alone. Every password a create needs must be set before anything is
 * sent.
 */
const DATA_SOURCES_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
var CFG = JSON.parse(core.resource(RESOURCE_PATH, "data-source.json"));
var sources = JSON.parse(core.resource(RESOURCE_PATH, "sources.json"));
if (!settings.collectorId && !settings.collectorName) throw new Error("Set collectorId or collectorName in the configuration element " + SETTINGS_NAME + ".");
if (CFG.needsSwitchType && !settings.switchType) throw new Error("Set switchType in the configuration element " + SETTINGS_NAME + " (the model family the API takes for a " + CFG.label + ").");
${NETWORKS_LOGIN}
var added = [];
try {
  var proxy = settings.collectorId ? String(settings.collectorId) : "";
  if (!proxy) {
    var nodes = mod.listAll(settings.netHost, auth, "/infra/nodes", SAFE);
    for (var n = 0; n < nodes.length && !proxy; n++) {
      var node = mod.detail(settings.netHost, auth, "/infra/nodes", nodes[n], "name", SAFE);
      if (String(node.name || "") === String(settings.collectorName)) proxy = String(node.proxy_id || nodes[n].entity_id);
    }
    if (!proxy) throw new Error("No collector named " + settings.collectorName + " in /api/ni/infra/nodes. Set collectorId instead.");
  }
  System.log("Collector " + proxy);

  var have = {};
  var existing = mod.listAll(settings.netHost, auth, CFG.path, SAFE);
  for (var e = 0; e < existing.length; e++) {
    var ds = mod.detail(settings.netHost, auth, CFG.path, existing[e], "fqdn", SAFE);
    if (ds.fqdn) have[String(ds.fqdn).toLowerCase()] = String(existing[e].entity_id);
    if (ds.ip) have[String(ds.ip).toLowerCase()] = String(existing[e].entity_id);
  }

  var todo = [];
  var missing = [];
  for (var i = 0; i < sources.length; i++) {
    var known = have[String(sources[i].fqdn).toLowerCase()];
    if (known) {
      System.log("Exists, left as it is: " + CFG.label + " " + sources[i].fqdn + " (" + known + ").");
      continue;
    }
    todo.push(sources[i]);
    if (!settings[sources[i].passwordAttribute]) missing.push(sources[i].passwordAttribute);
  }
  if (missing.length > 0) {
    if (!ctx.dryRun) throw new Error("Set " + missing.join(", ") + " in the configuration element " + SETTINGS_NAME + ". Nothing was added.");
    System.warn("A live run would stop here: " + missing.join(", ") + " not set.");
  }

  for (var t = 0; t < todo.length; t++) {
    var source = todo[t];
    var body = JSON.parse(JSON.stringify(CFG.body));
    body.fqdn = source.fqdn;
    body.nickname = source.nickname;
    body.proxy_id = proxy;
    body.credentials = { username: String(settings.sourceUsername || ""), password: String(settings[source.passwordAttribute] || "") };
    if (CFG.needsSwitchType) body.switch_type = String(settings.switchType);
    var id = core.act(ctx, "add " + CFG.label + " data source " + source.fqdn + (CFG.ipfix ? ", with IPFIX" : ""), function () {
      var created = core.http("POST", api + CFG.path, auth, body, SAFE);
      if (!created.body || !created.body.entity_id) throw new Error("POST /api/ni" + CFG.path + " returned no entity_id.");
      return String(created.body.entity_id);
    });
    if (id) added.push(id);
  }
} finally {
  core.logoutVcfNetworks(settings.netHost, auth);
}
addedIds = added.join(",");
summary = core.audit(ctx, { type: CFG.label, collector: proxy, added: added, requested: sources.length });
core.notify(settings.webhook, summary);`;

/**
 * An application and its tiers. Each tier's VM count is read first and logged
 * — the check that the criteria are right. The application is found by name
 * and created only when missing; so is each tier. An existing tier is never
 * edited.
 */
const APPLICATION_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
var APP = JSON.parse(core.resource(RESOURCE_PATH, "application.json"));
var TIERS = JSON.parse(core.resource(RESOURCE_PATH, "tiers.json"));
${NETWORKS_LOGIN}
var appId = null;
var existed = false;
var counts = {};
var created = [];
try {
  for (var t = 0; t < TIERS.length; t++) {
    var filter = TIERS[t].group_membership_criteria[0].search_membership_criteria.filter;
    var found = core.http("POST", api + "/search", auth, { entity_type: "VirtualMachine", filter: filter, size: 1 }, SAFE).body || {};
    counts[TIERS[t].name] = Number(found.total_count || 0);
    System.log("tier " + TIERS[t].name + ": " + counts[TIERS[t].name] + " VM(s) match " + filter);
    if (counts[TIERS[t].name] === 0) System.warn("Tier " + TIERS[t].name + " matches no VM today. Check its filter in the search bar before relying on it.");
  }

  var apps = mod.listAll(settings.netHost, auth, "/groups/applications", SAFE);
  for (var a = 0; a < apps.length; a++) {
    var one = mod.detail(settings.netHost, auth, "/groups/applications", apps[a], "name", SAFE);
    if (String(one.name) === String(APP.name)) { appId = String(apps[a].entity_id); existed = true; break; }
  }
  var have = {};
  if (existed) {
    System.log("Exists: application \"" + APP.name + "\" (" + appId + "); only its missing tiers are added.");
    var tierPath = "/groups/applications/" + encodeURIComponent(appId) + "/tiers";
    var tiers = mod.listAll(settings.netHost, auth, tierPath, SAFE);
    for (var h = 0; h < tiers.length; h++) have[String(mod.detail(settings.netHost, auth, tierPath, tiers[h], "name", SAFE).name)] = true;
  } else {
    appId = core.act(ctx, "create application \"" + APP.name + "\"", function () {
      var r = core.http("POST", api + "/groups/applications", auth, APP, SAFE);
      if (!r.body || !r.body.entity_id) throw new Error("POST /api/ni/groups/applications returned no entity_id; no tier was created.");
      return String(r.body.entity_id);
    });
  }
  for (var n = 0; n < TIERS.length; n++) {
    var tier = TIERS[n];
    if (have[tier.name]) {
      System.log("Exists, left as it is: tier \"" + tier.name + "\" of \"" + APP.name + "\".");
      continue;
    }
    var tierId = core.act(ctx, "create tier \"" + tier.name + "\" in \"" + APP.name + "\" (" + counts[tier.name] + " VM(s) today)", function () {
      var r = core.http("POST", api + "/groups/applications/" + encodeURIComponent(appId) + "/tiers", auth, tier, SAFE);
      return r.body && r.body.entity_id ? String(r.body.entity_id) : "";
    });
    if (tierId) created.push(tierId);
  }
} finally {
  core.logoutVcfNetworks(settings.netHost, auth);
}
applicationId = appId || "";
tierCounts = JSON.stringify(counts);
summary = core.audit(ctx, { application: APP.name, applicationId: applicationId, existed: existed, tiersCreated: created, tierVmCounts: counts });
core.notify(settings.webhook, summary);`;

/**
 * Observed reachability against intent. Reads only: every call is the
 * documented POST /api/ni/search, which is a query. A deny fails only on flows
 * the firewall allowed; an allow fails on flows it blocked, and — when strict —
 * on no flows at all.
 */
const INTENT_WORKFLOW = String.raw`var intents = JSON.parse(core.resource(RESOURCE_PATH, "intents.json"));
${NETWORKS_LOGIN}
var hours = Number(settings.windowHours) > 0 ? Number(settings.windowHours) : 24;
var strict = settings.strict === true || String(settings.strict) === "true";
var end = Math.floor(new Date().getTime() / 1000);
var start = end - hours * 3600;
var problems = [];
var results = [];
function count(filter) {
  var r = core.http("POST", api + "/search", auth, { entity_type: "Flow", filter: filter, size: 1, time_range: { start_time: start, end_time: end } }, SAFE).body || {};
  return Number(r.total_count || 0);
}
try {
  for (var i = 0; i < intents.length; i++) {
    var it = intents[i];
    var between = "source_vm.name = '" + it.source + "' and destination_vm.name = '" + it.destination + "'";
    var seen = count(between);
    var verdict = "ok";
    if (it.intent === "deny") {
      var allowed = count(between + " and firewall_action = 'ALLOW'");
      if (allowed > 0) { verdict = "violation"; problems.push(it.source + " -> " + it.destination + ": intended deny, " + allowed + " flow(s) allowed by the firewall"); }
      else if (seen > 0) { verdict = "enforced"; System.log("enforced: " + it.source + " -> " + it.destination + " (deny) - " + seen + " flow(s) attempted and not allowed"); }
    } else {
      var dropped = count(between + " and (firewall_action = 'DROP' or firewall_action = 'REJECT' or firewall_action = 'DENY')");
      if (dropped > 0) { verdict = "violation"; problems.push(it.source + " -> " + it.destination + ": intended allow, " + dropped + " flow(s) blocked by the firewall"); }
      if (seen === 0) {
        if (strict) { verdict = "violation"; problems.push(it.source + " -> " + it.destination + ": intended allow, no flows observed"); }
        else if (verdict === "ok") { verdict = "no evidence"; System.log("no evidence: " + it.source + " -> " + it.destination + " (allow) - no flows in the window"); }
      }
    }
    System.log(it.source + " -> " + it.destination + " (" + it.intent + "): " + seen + " flow(s), " + verdict);
    results.push({ source: it.source, destination: it.destination, intent: it.intent, flows: seen, verdict: verdict });
  }
} finally {
  core.logoutVcfNetworks(settings.netHost, auth);
}
for (var p = 0; p < problems.length; p++) System.warn("VIOLATION: " + problems[p]);
problemCount = problems.length;
report = JSON.stringify(results);
summary = core.audit(null, { windowHours: hours, strict: strict, checked: intents.length, violations: problems });
if (problems.length > 0) core.notify(settings.webhook, { source: "vcfnet-intent-check", problems: problems, summary: JSON.parse(summary) });
else System.log("Observed reachability matches intent.");
var fail = !(settings.failOnViolation === false || String(settings.failOnViolation) === "false");
if (problems.length > 0 && fail) throw new Error(problems.length + " intent violation(s): " + problems.join("; "));`;

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
        // The SecureString attribute of the Orchestrator package that holds it.
        passwordAttribute: `pw_${fqdn.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
      }));
      // What the body carries beyond the source and its credential: the
      // switch model family, and IPFIX turned on as the source is added.
      const withIpfix = source.flows && ipfix && source.ipfix ? source.ipfix : {};
      const additions = { ...(source.extra ?? {}), ...withIpfix };

      const specJq = [
        '# One data-source body per source, password from its own variable via $ENV.',
        '# Field names follow the 9.1 Networks API data-source schema.',
        '{ fqdn: .fqdn, nickname: .nickname, proxy_id: $proxy, enabled: true,',
        '  notes: "Added by ArchToolKit",',
        `  credentials: { username: $user, password: $ENV[.envVar] }${Object.keys(additions).length > 0 ? ` } + ${JSON.stringify(additions)}` : ' }'}`,
        '',
      ].join('\n');

      const script = [
        '#!/usr/bin/env bash',
        `# Add ${fqdns.length} ${source.label} data source(s) to VCF Operations for Networks.`,
        '#',
        '# The fallback for the Orchestrator package. Each password comes from its own',
        '# variable, named in scripts/sources.json. Not idempotent: a source that is',
        '# already there is added again, so run it once. Without',
        '# --execute it prints each body with the password left out.',
        'set -euo pipefail',
        ...netPreamble(),
        '',
        'DRY_RUN=1; [[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
        '',
        'MISSING=()',
        '# Exported so jq can read each one through $ENV; never passed as an argument.',
        'for v in $(jq -r \'.[].envVar\' scripts/sources.json); do if [[ -n "${!v:-}" ]]; then export "$v"; else MISSING+=("$v"); fi; done',
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
        'jq -c \'.[]\' scripts/sources.json | while read -r src; do',
        `  BODY=$(echo "$src" | jq --arg proxy "$PROXY" --arg user '${user}' -f scripts/spec.jq)`,
        '  if (( DRY_RUN )); then',
        `    echo "DRY RUN: would POST ${source.path}:"; echo "$BODY" | jq 'del(.credentials.password)'`,
        '    continue',
        '  fi',
        `  echo "$BODY" | ni POST ${source.path} --data @- | jq -r '"added \\(.entity_id // "?") \\(.fqdn // .ip // "")"'`,
        'done',
        '',
        ...(source.flows && ipfix
          ? [`# IPFIX is turned on by the body itself (${Object.keys(withIpfix).join(', ')}): check flows appear under Flows within the hour.`]
          : []),
        '(( DRY_RUN )) && echo "Nothing was changed. Re-run with --execute."',
        'exit 0',
        '',
      ].join('\n');

      const packageName = packageNameOf('networks', 'datasources', base);
      const dataSource = {
        label: source.label,
        path: source.path,
        ipfix: Object.keys(withIpfix).length > 0,
        needsSwitchType: Boolean(source.extra?.switch_type),
        body: { enabled: true, notes: 'Added by ArchToolKit', ...withIpfix },
      };
      const pkg = toPackage({
        packageName,
        description: `VCF Operations for Networks: adds ${fqdns.length} ${source.label} data source(s) through a named collector${dataSource.ipfix ? ', with IPFIX' : ''}; what is there is left alone. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/Networks/${base}`,
        workflow: {
          name: `Add data sources ${base}`,
          description: `Adds to VCF Operations for Networks each ${source.label} of the resource element sources.json that is not there yet (by FQDN or IP), through the collector in the settings, each password from its own SecureString attribute${dataSource.ipfix ? ', with IPFIX turned on in the same call' : ''}. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be added and change nothing' }],
          outputs: [
            { name: 'addedIds', type: 'string', description: 'The entity ids added, comma-separated; empty in a dry run' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: DATA_SOURCES_WORKFLOW,
        },
        actions: NETWORKS_ACTIONS,
        config: {
          name: 'Settings',
          description: `Settings of the Add data sources ${base} workflow. Fill netPassword and ${sources.map((entry) => entry.passwordAttribute).join(', ') || 'the source passwords'} after import; set dryRun to false only after a dry run.`,
          attributes: [
            ...NETWORKS_SETTINGS,
            { name: 'collectorId', type: 'string', value: collectorId, description: 'The collector (proxy) id; empty to find it by collectorName' },
            { name: 'collectorName', type: 'string', value: collectorName, description: 'The collector name, looked up in /api/ni/infra/nodes when collectorId is empty' },
            { name: 'sourceUsername', type: 'string', value: user, description: `The ${source.label} account every source is added with` },
            ...(dataSource.needsSwitchType ? [{ name: 'switchType', type: 'string'         , value: '', description: `The switch_type the API takes for a ${source.label} (from the API reference; e.g. ${source.extra?.switch_type?.replace(/^<REQUIRED — e\.g\. |; verify>$/g, '')})` }] : []),
            ...sources.map((entry) => ({ name: entry.passwordAttribute, type: 'SecureString'         , description: `The password of ${user} on ${entry.fqdn}` })),
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is added while this is true' },
            { name: 'cap', type: 'number', value: fqdns.length, description: 'The most sources one run may add' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [
          { name: 'sources.json', content: `${JSON.stringify(sources.map((entry) => ({ fqdn: entry.fqdn, nickname: entry.nickname, passwordAttribute: entry.passwordAttribute })), null, 2)}\n` },
          { name: 'data-source.json', content: `${JSON.stringify(dataSource, null, 2)}\n` },
        ],
      });

      return {
        platform: NETWORKS,
        title: `Add ${fqdns.length} ${source.label} data source${fqdns.length === 1 ? '' : 's'}${source.flows ? (ipfix ? ', with IPFIX' : ', without flows') : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Run once when the sources are ready to be monitored; running it again adds only what is missing.', worstCase: 'once per source' },
        scope: {
          what: `Exactly the listed ${source.label} sources: ${fqdns.join(', ') || 'none'}.`,
          decidedBy: ['The resource element sources.json (scripts/sources.json for the script), written from the list above.', `Collector ${collectorId || collectorName}.`],
          ifWrong: source.flows && ipfix
            ? 'IPFIX turned on for a distributed switch it was not meant for adds a flow export from every host on it. Nothing breaks, but the collector’s load rises with it.'
            : 'A source added twice is polled twice. Networks deduplicates the inventory, but the credential is used from two places.',
        },
        guardrails: [
          { rule: 'Each credential from its own SecureString attribute (its own variable for the script), all present before anything is sent', because: 'A password in the payload is a password in the repository.' },
          { rule: 'Through a named collector', because: 'A source on the wrong collector is polled across a WAN link, or not at all.' },
          { rule: 'The workflow adds only sources that are not there (by FQDN or IP), is a dry run until armed, and stops at the cap and the first failure', because: 'A source added twice is polled twice with the same credential.' },
        ],
        dryRun: [
          `Run the workflow Add data sources ${base} with dryRun = true (the configuration element keeps it a dry run until its dryRun is set to false): it resolves the collector, reads the sources there, and logs "DRY RUN: would add …" for each one missing.`,
          'The fallback scripts/' + `${base}.sh` + ' without --execute prints every body it would send, with the password left out.',
        ],
        undo: ['Delete the data source (DELETE /api/ni/data-sources/…/{id} with an id from the workflow\'s addedIds output, or in Settings). Collected history is kept until it ages out.', ...(source.flows && ipfix ? ['Turn IPFIX off on the source; the hosts stop exporting.'] : [])],
        told: ['Nobody. The workflow’s audit record goes to its webhook when one is set. A failing data source shows on Settings > Accounts and Data Sources, and should be in the VCF Operations health checks.'],
        requires: [
          `A ${source.label} account with read access${source.flows ? ' and the privilege to change IPFIX settings' : ''}.`,
          `For the package: its passwords in ${sources.map((entry) => entry.passwordAttribute).join(', ') || 'the SecureString attributes'}; VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the Networks platform certificate trusted in Orchestrator.`,
          ...sources.map((entry) => `For the script: ${entry.envVar} set to ${entry.fqdn}’s password, from your vault.`),
          'The collector able to reach every source.',
        ],
        files: {
          ...pkg.files,
          [`scripts/${base}.sh`]: fromRoot(script),
          'scripts/sources.json': `${JSON.stringify(sources, null, 2)}\n`,
          'scripts/spec.jq': specJq,
          ...(source.flows
            ? {}
            : {
                // Settings > Accounts and Data Sources > Bulk add devices takes a
                // CSV with these columns. The password column is left empty: fill
                // it from your vault on the machine that uploads, then delete it.
                'import/bulk-add-devices.csv': `${[
                  'datasource_type,ip,fqdn,username,password,nickname,polling_interval_in_mins,collector_ip,notes',
                  ...sources.map((entry) => [BULK_TYPES[type] ?? type, '', entry.fqdn, user, '', entry.nickname, '10', '<REQUIRED — collector IP>', 'Added by ArchToolKit'].map(csvCell).join(',')),
                ].join('\n')}\n`,
              }),
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Networks',
            intro: `${
              source.flows
                ? `${source.label} data sources are added one at a time — in the interface or through the API.`
                : `Physical devices can be added in bulk from a CSV (import/bulk-add-devices.csv) or one at a time through the API.`
            } The Orchestrator package \`${pkg.packageDir}\` adds each source not already there with one POST /api/ni${source.path}${dataSource.ipfix ? `, turning IPFIX on in the same body (${Object.keys(withIpfix).join(', ')})` : ''}; scripts/${base}.sh does the same from a Linux host, without the check for what exists.`,
            steps: [
              ...packageSteps(pkg, `the ${source.label} data sources`),
              ...(source.flows
                ? []
                : [
                    {
                      heading: 'Or: bulk add from the CSV',
                      lines: [
                        'Fill the password column (and collector_ip) on the machine that uploads, from your vault, then: Settings > Accounts and Data Sources > Data Sources > the add drop-down > **Bulk add devices** > upload import/bulk-add-devices.csv. Delete the filled copy afterwards.',
                        '',
                        `VERIFY: datasource_type accepts the values in the sample .csv that dialog offers for download; "${BULK_TYPES[type] ?? type}" is written here — replace it if the sample spells it differently.`,
                      ],
                    },
                  ]),
              {
                heading: 'Or: the script, or by hand',
                lines: [
                  `Export each password variable named in scripts/sources.json (${sources.map((entry) => entry.envVar).join(', ') || 'none'}), then \`./scripts/${base}.sh\` (prints each body without the password) and \`./scripts/${base}.sh --execute\`.`,
                  '',
                  `By hand: Settings > Accounts and Data Sources > Add Source > ${source.label}, collector ${collectorName || collectorId}, the FQDN, username and password${source.flows && ipfix ? ', and tick Enable NetFlow (IPFIX)' : ''}.`,
                ],
              },
            ],
            verify: [
              `Confirmed in the 9.1 VCF Operations for Networks API reference: GET and POST /api/ni${source.path} (and …/{id}), and the body (fqdn, nickname, proxy_id, enabled, notes, credentials {username, password}${source.path.endsWith('vcenters') ? ', ipfix_request {enable_all}' : source.path.endsWith('nsxt-managers') ? ', ipfix_enabled' : ''}); POST /api/ni/auth/token and DELETE /api/ni/auth/token.`,
              ...(dataSource.needsSwitchType ? ['VERIFY: the switch_type values for this switch family: take them from the API reference for your release.'] : []),
              'VERIFY: that the data-source list answers { results: [{ entity_id, … }], cursor } as the other /api/ni lists do, and the collector name field of GET /api/ni/infra/nodes/{id}; set collectorId to skip the lookup.',
              ...(source.flows ? [] : ['The CSV columns are the ones listed for Bulk add devices (datasource_type, ip, fqdn, username, password, nickname, polling_interval_in_mins, collector_ip mandatory; notes and the snmp_* columns optional).']),
            ],
            sources: [
              'developer.broadcom.com, VCF Operations for Networks API 9.1: Data Sources (https://developer.broadcom.com/xapis/vcf-operations-for-networks-api/latest/data-sources/), POST /api/ni/data-sources/vcenters and /nsxt-managers bodies, Authentication (/api/ni/auth/token).',
              'PowervRNI (New-vRNIDataSource) for the data-source routes and bodies.',
              ...(source.flows ? [] : ['VMware Aria Operations for Networks documentation, "Bulk Add Devices as Data Sources" (Settings > Accounts and Data Sources > Bulk add devices; the CSV columns).']),
            ],
          }),
        },
        notes: [
          'The data-source routes (/api/ni/data-sources/vcenters, /nsxt-managers, /cisco-switches and so on) are in the 9.1 API reference. The switch_type values for physical switches vary by model and release; take them from the API reference.',
          'Collector lookup by name walks /api/ni/infra/nodes; if your release returns the name on the list directly, pass the id instead.',
          ...(source.flows ? ['In 9.1 IPFIX is turned on by the add call itself (vCenter: ipfix_request.enable_all; NSX Manager: ipfix_enabled). Earlier releases took it only in the interface.'] : []),
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
        '# Without --execute it shows how many VMs each tier matches today, and',
        '# creates nothing — the count is the check that the criteria are right.',
        '# The fallback for the Orchestrator package: not idempotent, so run it once.',
        'set -euo pipefail',
        ...netPreamble(),
        '',
        'DRY_RUN=1; [[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
        '',
        'jq -c \'.[]\' import/tiers.json | while read -r tier; do',
        '  NAME=$(echo "$tier" | jq -r .name)',
        '  FILTER=$(echo "$tier" | jq -r \'.group_membership_criteria[0].search_membership_criteria.filter\')',
        '  COUNT=$(ni POST /search --data "$(jq -n --arg f "$FILTER" \'{entity_type: "VirtualMachine", filter: $f, size: 1}\')" | jq -r \'.total_count // 0\')',
        '  echo "tier ${NAME}: ${COUNT} VM(s) match ${FILTER}"',
        'done',
        '',
        '(( DRY_RUN )) && { echo "DRY RUN: nothing created. Re-run with --execute."; exit 0; }',
        '',
        'APP_ID=$(ni POST /groups/applications --data @import/application.json | jq -r .entity_id)',
        'echo "application ${APP_ID}"',
        'jq -c \'.[]\' import/tiers.json | while read -r tier; do',
        '  ni POST "/groups/applications/${APP_ID}/tiers" --data "$tier" | jq -r \'"tier \\(.name // "?") \\(.entity_id // "")"\'',
        'done',
        'echo "${APP_ID}" > scripts/created-application-id.txt',
        '',
      ].join('\n');

      const pkg = toPackage({
        packageName: packageNameOf('networks', 'application', base),
        description: `VCF Operations for Networks: the application "${app}" and its ${tiers.length} tier(s), each created only when missing, with each tier's VM count logged first. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/Networks/${base}`,
        workflow: {
          name: `Define application ${base}`,
          description: `Counts the VMs each tier of "${app}" matches today (POST /api/ni/search), then creates the application (POST /api/ni/groups/applications) and each tier (POST …/{id}/tiers) that is not there yet, by name. An existing tier is never edited. A definition only: nothing on the network changes. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: count and report, create nothing' }],
          outputs: [
            { name: 'applicationId', type: 'string', description: 'The application entity id; empty in a dry run when it does not exist yet' },
            { name: 'tierCounts', type: 'string', description: 'JSON: VMs each tier matches today' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: APPLICATION_WORKFLOW,
        },
        actions: NETWORKS_ACTIONS,
        config: {
          name: 'Settings',
          description: `Settings of the Define application ${base} workflow. Fill netPassword after import; set dryRun to false only after a dry run.`,
          attributes: [
            ...NETWORKS_SETTINGS,
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is created while this is true' },
            { name: 'cap', type: 'number', value: tiers.length + 1, description: 'The most objects one run may create (the application and its tiers)' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [
          { name: 'application.json', content: `${JSON.stringify({ name: app }, null, 2)}\n` },
          { name: 'tiers.json', content: `${JSON.stringify(tierBodies, null, 2)}\n` },
        ],
      });

      return {
        platform: NETWORKS,
        title: `Application "${app}" with ${tiers.length} tier${tiers.length === 1 ? '' : 's'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Created once; running it again adds only what is missing. Membership is re-evaluated as VMs come and go.', worstCase: 'membership changes whenever a VM matching a tier filter appears' },
        scope: {
          what: 'A definition only: it groups VMs for analysis and changes nothing on the network.',
          decidedBy: tiers.map((tier) => `Tier ${tier.name}: ${tier.filter || '(no filter)'}.`),
          ifWrong: 'The flow analysis shows the wrong VMs in a tier, and any firewall rules recommended from it are wrong in the same way. That is where the harm is — in the rules written later from this.',
        },
        guardrails: [
          { rule: 'Counts each tier’s members before creating anything, and warns on a tier that matches none', because: 'A tier that matches three hundred VMs instead of three is visible as a number before it is visible as a bad rule.' },
          { rule: 'Creates a definition, never a rule', because: 'Recommended rules are reviewed and applied in NSX by a person.' },
          { rule: 'The workflow creates the application and each tier only when missing, never edits a tier, and is a dry run until armed', because: 'Two applications of the same name split the flow analysis between them.' },
        ],
        dryRun: [
          `Run the workflow Define application ${base} with dryRun = true (the configuration element keeps it a dry run until its dryRun is set to false): it logs how many VMs each tier matches today and what it would create.`,
          `The fallback scripts/${base}.sh without --execute prints the same counts and creates nothing.`,
        ],
        undo: ['DELETE /api/ni/groups/applications/{id} with the id in the workflow\'s applicationId output (scripts/created-application-id.txt with the script), or delete it under Applications.'],
        told: ['Nobody. It is a definition. The workflow’s audit record goes to its webhook when one is set.'],
        requires: ['VM names or tags consistent enough for a filter to find them.', 'Flow collection (IPFIX) for the flow analysis to have anything in it.', 'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the Networks platform certificate trusted in Orchestrator.'],
        files: {
          'import/application.json': `${JSON.stringify({ name: app }, null, 2)}\n`,
          'import/tiers.json': `${JSON.stringify(tierBodies, null, 2)}\n`,
          ...(csvRows.length > 0 ? { 'import/application-discovery.csv': `${['Application Name,Tier Name,VM Name', ...csvRows].join('\n')}\n` } : {}),
          ...pkg.files,
          [`scripts/${base}.sh`]: fromRoot(script),
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Networks',
            intro: `An application is created through the API (POST /api/ni/groups/applications with import/application.json, then one POST .../tiers per element of import/tiers.json — each element is exactly that body), or by hand. The Orchestrator package \`${pkg.packageDir}\` does it idempotently: it counts each tier's VMs, then creates the application and the tiers that are not there yet. Networks also takes a CSV, but only as input to flow-based application discovery, not as a definition.`,
            steps: [
              ...packageSteps(pkg, 'the application and its tiers'),
              {
                heading: 'Or: the script, or by hand',
                lines: [
                  `\`./scripts/${base}.sh\` counts each tier’s VMs and creates nothing; \`./scripts/${base}.sh --execute\` creates "${app}" and its ${tiers.length} tier(s) and writes the id to scripts/created-application-id.txt. It does not look for what exists: run it once.`,
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
            verify: [
              'The application and tier bodies are the ones PowervRNI (New-vRNIApplication, New-vRNIApplicationTier) sends.',
              'Confirmed in the 9.1 API reference: GET/POST /api/ni/groups/applications, GET /api/ni/groups/applications/{id}, GET/POST /api/ni/groups/applications/{id}/tiers, POST /api/ni/search (entity_type, filter, size → results, total_count, cursor).',
              'VERIFY: that the application and tier lists answer { results: [{ entity_id }], cursor } as the other /api/ni lists do; the workflow reads each entry for its name when the list does not carry it.',
            ],
            sources: [
              'developer.broadcom.com, VCF Operations for Networks API 9.1: Applications (https://developer.broadcom.com/xapis/vcf-operations-for-networks-api/latest/applications/) and Search.',
              'PowervRNI: POST /api/ni/groups/applications {name}; POST /api/ni/groups/applications/{id}/tiers {name, group_membership_criteria [{membership_type SearchMembershipCriteria, search_membership_criteria {entity_type, filter}}]}.',
              'Broadcom TechDocs, Aria Operations for Networks 6.14, "Discover Applications using Flows" (Discovery Options, CSV upload, VM Name as a regular expression).',
            ],
          }),
        },
        notes: [
          'The applications and tiers routes and the SearchMembershipCriteria shape follow the Networks API reference. The filter syntax is the search bar’s: try each filter there first.',
          'Networks can discover applications from flows and tags on its own. Use that to find candidates, then write the definition here so it is reviewed and versioned.',
          '9.1 also has POST /api/ni/groups/applications/full (an application with its tiers in one call). The workflow uses the two-step form so it can add a missing tier to an application that exists.',
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
        '# The fallback for the Orchestrator package, from a Linux host.',
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
        "done < <(jq -r '.[] | [.source, .destination, .intent] | @tsv' scripts/intents.json)",
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

      const pkg = toPackage({
        packageName: packageNameOf('networks', 'intentcheck', base),
        description: `VCF Operations for Networks: checks ${intents.length} reachability intent(s) against the flows observed over ${hours} hours. Reads only. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/Networks/${base}`,
        workflow: {
          name: `Reachability intent check ${base}`,
          description: `For each intent in the resource element intents.json, counts the flows between the two VMs over the window with POST /api/ni/search (a query): a deny fails on flows the firewall allowed, an allow on flows it blocked${strict ? ' or on no flows at all' : ''}. Changes nothing. Fails the run on any violation, so a schedule shows it, after posting the problems to the webhook.`,
          inputs: [],
          outputs: [
            { name: 'problemCount', type: 'number', description: 'Violations found' },
            { name: 'report', type: 'string', description: 'JSON: each intent with its flow count and verdict' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: INTENT_WORKFLOW,
        },
        actions: [],
        config: {
          name: 'Settings',
          description: `Settings of the Reachability intent check ${base} workflow. Fill netPassword after import; a read-only Networks account is enough.`,
          attributes: [
            ...NETWORKS_SETTINGS,
            { name: 'windowHours', type: 'number', value: hours, description: 'Hours of flows to look back over' },
            { name: 'strict', type: 'boolean', value: strict, description: 'An allow with no flows at all is a violation, not "no evidence"' },
            { name: 'failOnViolation', type: 'boolean', value: true, description: 'Fail the run on any violation, so a schedule shows it' },
            { name: 'webhook', type: 'string', value: webhook, description: 'Optional: where violations are posted' },
          ],
        },
        resources: [{ name: 'intents.json', content: `${JSON.stringify(intents, null, 2)}\n` }],
      });

      return {
        platform: NETWORKS,
        title: `Reachability intent check — ${intents.length} statement${intents.length === 1 ? '' : 's'} over ${hours} hours`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Daily, over the last ${hours} hours of flows, from the Orchestrator scheduler (or cron, with the fallback script)`, worstCase: 'once a day' },
        scope: {
          what: 'Observed flows between the named VM pairs. It reads flow records; it changes nothing.',
          decidedBy: intents.map((entry) => `${entry.source} -> ${entry.destination}: ${entry.intent}.`),
          ifWrong: 'A misnamed VM matches nothing, so a deny passes trivially. Check each name returns flows in the search bar before trusting a clean result.',
        },
        guardrails: [
          { rule: 'Reports; never writes a rule. Every call is a login, the search query, or the logout', because: 'An automation that closes a flow on its own finding will one day close one that was load-bearing.' },
          { rule: 'An allow with no flows is "no evidence", not a pass', because: 'Not having seen traffic is different from traffic being possible.' },
          { rule: 'A deny fails only on flows the firewall allowed', because: 'An enforced deny still leaves flow records — the attempts it dropped. Counting those would report a working rule as a violation.' },
        ],
        dryRun: ['It only reads. Run the workflow by hand once, read its log, and compare one pair with a path search in the interface.'],
        undo: ['Nothing to undo.'],
        told: [webhook ? `${webhook}, on any violation; and a failed run, to whatever scheduled it.` : 'A failed run, to whatever scheduled it (the script: its exit code).'],
        requires: [
          'IPFIX flow collection covering these VMs, from the NSX distributed firewall so each flow carries the action taken.',
          'Flow retention at least as long as the window.',
          'A read-only Networks account: in the configuration element for the package; VCFNET_USER and VCFNET_PASSWORD_FILE for the scheduled script, or VCFNET_TOKEN by hand.',
        ],
        files: {
          ...pkg.files,
          [`scripts/${base}.sh`]: fromRoot(script),
          'scripts/intents.json': `${JSON.stringify(intents, null, 2)}\n`,
          'crontab.txt': `# The fallback script, daily at 06:00. With the Orchestrator package, schedule the workflow instead and leave this out.\n# The password file is mode 600 and owned by the account that runs this.\n0 6 * * * cd /opt/archtoolkit/${base} && ${networksScheduledEnv()} ./scripts/${base}.sh\n`,
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Networks',
            intro: `Nothing is imported into Networks: the check reads flows through POST /api/ni/search. The Orchestrator package \`${pkg.packageDir}\` runs it — schedule its workflow daily; scripts/${base}.sh does the same from a Linux host with cron.`,
            steps: [
              ...packageSteps(pkg, 'the check'),
              {
                heading: 'Or: schedule the script',
                lines: [`Copy the bundle to /opt/archtoolkit/${base}, run \`./scripts/${base}.sh\` once by hand and compare one pair with a path search in the interface ("VM 'a' to VM 'b'"), then install the line in crontab.txt with \`crontab -e\`.`],
              },
            ],
            verify: [
              'The Flow filter property names (source_vm.name, destination_vm.name, firewall_action) — see the notes in README.md.',
              'Confirmed in the 9.1 API reference: POST /api/ni/search with entity_type, filter, size and time_range {start_time, end_time}; the response carries total_count.',
            ],
            sources: ['developer.broadcom.com, VCF Operations for Networks API 9.1: Search (https://developer.broadcom.com/xapis/vcf-operations-for-networks-api/latest/search/).', 'PowervRNI (Invoke-vRNISearch) for POST /api/ni/search.'],
          }),
        },
        notes: [
          'This checks observed flows. Whether a path is possible — the "VM \'a\' to VM \'b\'" path search in the interface — is not exposed as a stable API in every release; use it by hand to confirm any violation this reports.',
          'The filter property names (source_vm.name, destination_vm.name, firewall_action) follow the Flow schema in the Networks API reference. The action values tested (ALLOW; DROP, REJECT, DENY) are the firewall’s — check which your release reports with a flow search in the interface. A wrong property name or value returns zero results, which reads as a pass for a deny.',
          'The deny check can only see what the firewall reported. A flow with no firewall action on it — one seen only through the distributed switch’s IPFIX, with no NSX distributed firewall in the path — is counted as seen but never as allowed, so it cannot fail a deny. The check logs those as "attempted and not allowed"; if a deny pair shows flows there and you have no DFW rule for it, look in the interface.',
        ],
        findings,
      };
    },
  }),
];
