/**
 * VCF Operations for Networks, and VCF Operations for Logs.
 *
 * Two capabilities of the same platform in 9.1, and the two most common places
 * an automation is *triggered* rather than executed: a flow that should not
 * exist, a log line that means something is about to fail. Neither of them acts
 * on its own — they raise something, and what listens is a webhook, a VCF
 * Automation action or a runbook.
 *
 * Which is why both of these emit a search or a query and the thing that
 * receives its result. A search on its own is a saved question nobody asks.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { applyScript } from '../apply.ts';
import { packageNameOf, toPackage } from '../vro/to-package.ts';
import type { VroActionDef } from '../vro/core.ts';
import type { VroConfigAttribute } from '../../kit/vro-package.ts';

const NETWORKS = 'vcf-operations-networks' as const;
const LOGS = 'vcf-operations-logs' as const;

// ---------------------------------------------------------------------------
// The Orchestrator packages
//
// Each blueprint here is one Orchestrator package on the shared core library
// (src/automation/vro/core.ts); the scripts stay beside it under scripts/.
//
// Networks: VCF Operations for networks 9.1 is still its own platform with its
// own API (developer.broadcom.com, "VCF Operations for networks API", 9.1):
// POST /api/ni/auth/token, header "NetworkInsight <token>", DELETE to log out
// — core.loginVcfNetworks / logoutVcfNetworks.
//
// Logs: 9.1 log management is a service of VCF Operations, not the old
// appliance. Its documented public API is the saved query,
// GET/POST/PUT /suite-api/api/logs/queryconfigs (LogsQueryConfig), called with
// the ordinary OpsToken (core.loginVcfOps); the service's own API takes a JWT
// from POST /suite-api/api/auth/token/exchange {"serviceKeys":["ops-li"]}
// (KB 450054, core.exchangeVcfOpsToken) and is not published. The standalone
// appliance of 8.18 and 9.0 keeps /api/v1 on port 9543 with an /api/v2/sessions
// login — the logsTarget setting says which one a package talks to.
// ---------------------------------------------------------------------------

/** The Networks account attributes. */
const NETWORKS_ATTRIBUTES: readonly VroConfigAttribute[] = [
  { name: 'netHost', type: 'string', value: '', description: 'VCF Operations for networks platform host (FQDN)' },
  { name: 'netUsername', type: 'string', value: '', description: 'A read-only account' },
  { name: 'netPassword', type: 'SecureString', description: 'Its password' },
  { name: 'netDomainType', type: 'string', value: 'LOCAL', description: 'LOCAL for a local account, LDAP for a directory one' },
  { name: 'netDomain', type: 'string', value: 'local', description: 'local, or the directory domain' },
];

/** The Logs attributes: which log management, and the account for each. */
const LOGS_ATTRIBUTES: readonly VroConfigAttribute[] = [
  { name: 'logsTarget', type: 'string', value: '9.1', description: '9.1: log management in VCF Operations. standalone: the Logs appliance of 8.18 or 9.0' },
  { name: 'opsHost', type: 'string', value: '', description: '9.1: VCF Operations host (FQDN)' },
  { name: 'opsUsername', type: 'string', value: '', description: '9.1: an account that may manage log queries' },
  { name: 'opsPassword', type: 'SecureString', description: '9.1: its password' },
  { name: 'opsAuthSource', type: 'string', value: '', description: '9.1: authentication source; empty for a local account' },
  { name: 'logsHost', type: 'string', value: '', description: 'standalone: the Logs appliance, host:9543' },
  { name: 'logsUsername', type: 'string', value: '', description: 'standalone: an account allowed to read and create alerts' },
  { name: 'logsPassword', type: 'SecureString', description: 'standalone: its password' },
  { name: 'logsProvider', type: 'string', value: 'Local', description: 'standalone: Local, ActiveDirectory or vIDM' },
];

/**
 * The standalone Logs appliance's login (8.18 and 9.0): POST /api/v2/sessions
 * with {username, password, provider}, then Authorization: Bearer <sessionId>
 * — the login apply.ts documents for the same appliance. Not in the core
 * library, which targets 9.1; 9.1 log management has no such endpoint.
 */
const LOGIN_LOGS_APPLIANCE: VroActionDef = {
  name: 'loginLogsAppliance',
  description: 'Standalone VCF Operations for Logs 8.18 / 9.0 appliance: POST /api/v2/sessions {username, password, provider}. Returns { Authorization: "Bearer <sessionId>" }. Not for 9.1 log management, which has no such endpoint.',
  resultType: 'Any',
  params: [
    { name: 'host', type: 'string', description: 'The appliance, host:9543' },
    { name: 'username', type: 'string', description: 'Account' },
    { name: 'password', type: 'string', description: 'From a SecureString attribute' },
    { name: 'provider', type: 'string', description: 'Local, ActiveDirectory or vIDM; empty = Local' },
  ],
  script: String.raw`var r = System.getModule("com.archtoolkit.core").http("POST", "https://" + host + "/api/v2/sessions", null, { username: String(username), password: String(password), provider: provider ? String(provider) : "Local" }, { redact: [password] });
if (!r.body || !r.body.sessionId) throw new Error("The Logs appliance at " + host + " returned no session.");
return { "Authorization": "Bearer " + r.body.sessionId };`,
};

/**
 * ES5 the Logs workflows open with: the target checked, and login() / logout()
 * for it. 9.1 is VCF Operations' OpsToken, 8.18/9.0 the appliance session.
 */
const LOGS_PRELUDE = String.raw`var target = String(settings.logsTarget || "9.1");
if (target !== "9.1" && target !== "standalone") throw new Error("logsTarget is 9.1 or standalone, not " + target + ".");
var SAFE = { redact: settings._secrets };
var auth = null;
function login() {
  if (target === "9.1") {
    if (!settings.opsHost || !settings.opsUsername || !settings.opsPassword) throw new Error("9.1: set opsHost, opsUsername and opsPassword in " + SETTINGS_NAME + ".");
    auth = core.loginVcfOps(settings.opsHost, settings.opsUsername, settings.opsPassword, settings.opsAuthSource || "");
  } else {
    if (!settings.logsHost || !settings.logsUsername || !settings.logsPassword) throw new Error("standalone: set logsHost, logsUsername and logsPassword in " + SETTINGS_NAME + ".");
    auth = mod.loginLogsAppliance(settings.logsHost, settings.logsUsername, settings.logsPassword, settings.logsProvider || "Local");
  }
}
function logout() {
  if (target === "9.1" && auth) core.logoutVcfOps(settings.opsHost, auth);
}
// The saved queries, whatever the list is wrapped in (the 9.1 reference names
// the item, LogsQueryConfig, not the wrapper of GET /logs/queryconfigs).
function queryConfigs() {
  var b = core.http("GET", "https://" + settings.opsHost + "/suite-api/api/logs/queryconfigs", auth, null, SAFE).body;
  if (b && b.length !== undefined && typeof b !== "string") return b;
  b = b || {};
  return b.queryConfigs || b.logsQueryConfigs || b.queryConfigList || b.configs || [];
}
`;

/**
 * A search on VCF Operations for networks, every page: POST /api/ni/search/ql
 * {query, size, cursor} → entity_list_response {results, total_count, cursor}
 * (PowervRNI Invoke-vRNISearch; "Search" in the 9.1 API reference).
 */
const NETWORKS_SEARCH = String.raw`function searchAll(query) {
  var cursor = null;
  return core.pageAll(function (page) {
    var body = { query: String(query), size: 100 };
    if (cursor) body.cursor = cursor;
    var r = core.http("POST", "https://" + settings.netHost + "/api/ni/search/ql", auth, body, SAFE).body;
    if (!r || typeof r !== "object" || !r.entity_list_response || typeof r.entity_list_response !== "object") throw new Error("The search \"" + query + "\" returned no entity list; check it in the search bar.");
    var e = r.entity_list_response;
    cursor = e.cursor || null;
    return { items: e.results || [], total: e.total_count === undefined ? null : e.total_count, more: Boolean(cursor) };
  }, 0);
}
`;

/** Where each watched kind is searched from: the search bar's own phrases (VERIFY each returns what you expect there). */
const WATCH_QUERIES: Readonly<Record<string, readonly string[]>> = {
  dfw: ['firewall rules'],
  groups: ['security groups'],
  segments: ['nsx segments'],
  all: ['firewall rules', 'security groups', 'nsx segments'],
};

/**
 * Flow check: reads only. One search, the count and the first hundred flow ids,
 * posted to the webhook when anything matched, and a failed run then too, so a
 * schedule shows it. A search that does not answer with an entity list fails
 * the run rather than reporting zero.
 */
const FLOW_CHECK_WORKFLOW = String.raw`if (!settings.netHost || !settings.netUsername || !settings.netPassword) throw new Error("Set netHost, netUsername and netPassword in " + SETTINGS_NAME + ".");
var spec = JSON.parse(core.resource(RESOURCE_PATH, "flow-check.json"));
var SAFE = { redact: settings._secrets };
var total = 0;
var ids = [];
var auth = core.loginVcfNetworks(settings.netHost, settings.netUsername, settings.netPassword, settings.netDomainType || "LOCAL", settings.netDomain || "local");
try {
  var r = core.http("POST", "https://" + settings.netHost + "/api/ni/search/ql", auth, { query: spec.search, size: 100 }, SAFE).body;
  if (!r || typeof r !== "object" || !r.entity_list_response || typeof r.entity_list_response !== "object") throw new Error("The search returned no entity list; check the query in the search bar: " + spec.search);
  total = Number(r.entity_list_response.total_count || 0);
  var results = r.entity_list_response.results || [];
  for (var i = 0; i < results.length; i++) ids.push(String(results[i].entity_id));
} finally {
  core.logoutVcfNetworks(settings.netHost, auth);
}
System.log(spec.name + ": " + total + " flow(s)");
for (var j = 0; j < ids.length; j++) System.log("  " + ids[j]);
flowCount = total;
flowIds = ids;
summary = core.audit(null, { check: spec.name, search: spec.search, total: total });
if (total > 0) {
  core.notify(settings.webhook, { source: "vcfnet-flow-check", check: spec.name, search: spec.search, total: total, flows: ids });
  if (settings.failOnFlows !== false && String(settings.failOnFlows) !== "false") throw new Error(total + " flow(s) crossed the boundary in \"" + spec.name + "\".");
}`;

/**
 * Change watch: reads only. Every watched object (a search per kind, every
 * page), its details (POST /api/ni/entities/fetch), and a fingerprint of each;
 * compared with the baseline attribute, the snapshot of the previous run.
 * Added, removed and changed objects are posted to the webhook. The snapshot is
 * written back to the baseline attribute when keepBaseline is on and this
 * Orchestrator lets a script write a configuration element; otherwise it is the
 * snapshot output, for the next run's baseline.
 */
const CHANGE_WATCH_WORKFLOW = String.raw`if (!settings.netHost || !settings.netUsername || !settings.netPassword) throw new Error("Set netHost, netUsername and netPassword in " + SETTINGS_NAME + ".");
var spec = JSON.parse(core.resource(RESOURCE_PATH, "watch.json"));
var SAFE = { redact: settings._secrets };
${NETWORKS_SEARCH}
var now = {};
var auth = core.loginVcfNetworks(settings.netHost, settings.netUsername, settings.netPassword, settings.netDomainType || "LOCAL", settings.netDomain || "local");
try {
  for (var q = 0; q < spec.queries.length; q++) {
    var found = searchAll(spec.queries[q]);
    for (var b = 0; b < found.length; b += 100) {
      var batch = [];
      for (var f = b; f < found.length && f < b + 100; f++) batch.push({ entity_id: String(found[f].entity_id) });
      var r = core.http("POST", "https://" + settings.netHost + "/api/ni/entities/fetch", auth, { entity_ids: batch }, SAFE).body || {};
      var results = r.results || [];
      for (var e = 0; e < results.length; e++) {
        var entity = results[e].entity || results[e];
        now[String(results[e].entity_id)] = { type: String(results[e].entity_type || entity.entity_type || ""), name: String(entity.name || results[e].entity_id), fp: JSON.stringify(entity) };
      }
    }
    System.log(spec.queries[q] + ": " + found.length);
  }
} finally {
  core.logoutVcfNetworks(settings.netHost, auth);
}
var before = settings.baseline ? JSON.parse(String(settings.baseline)) : null;
var added = [], removed = [], changed = [];
if (before) {
  for (var id in now) {
    if (!now.hasOwnProperty(id)) continue;
    if (!before.hasOwnProperty(id)) added.push(now[id].type + " " + now[id].name);
    else if (before[id].fp !== now[id].fp) changed.push(now[id].type + " " + now[id].name);
  }
  for (var old in before) if (before.hasOwnProperty(old) && !now.hasOwnProperty(old)) removed.push(before[old].type + " " + before[old].name);
  for (var a = 0; a < added.length; a++) System.log("ADDED: " + added[a]);
  for (var c = 0; c < changed.length; c++) System.log("CHANGED: " + changed[c]);
  for (var d = 0; d < removed.length; d++) System.log("REMOVED: " + removed[d]);
} else {
  System.log("No baseline yet: this run records it and reports nothing.");
}
snapshot = JSON.stringify(now);
changeCount = added.length + removed.length + changed.length;
if (settings.keepBaseline !== false && String(settings.keepBaseline) !== "false") {
  try {
    mod.saveSetting(SETTINGS_PATH, SETTINGS_NAME, "baseline", snapshot);
    System.log("Baseline updated in " + SETTINGS_NAME + ".");
  } catch (e) {
    System.warn("Could not keep the baseline (" + e + "). Put the snapshot output into the baseline attribute before the next run.");
  }
}
var objects = 0;
for (var n in now) if (now.hasOwnProperty(n)) objects++;
summary = core.audit(null, { watch: spec.watch, objects: objects, baseline: Boolean(before), added: added.length, removed: removed.length, changed: changed.length });
if (changeCount > 0) core.notify(settings.webhook, { source: "vcfnet-change-watch", watch: spec.name, added: added, removed: removed, changed: changed, ignoreAccounts: spec.ignoreAccounts, note: "Networks does not say who made a change; match these against the NSX audit log for the accounts in ignoreAccounts." });`;

/**
 * Writes one attribute of a configuration element — the change watch's own
 * baseline, never a setting of anything else. Uses the Orchestrator scripting
 * API ConfigurationElement.setAttributeWithKey; throws where it is missing.
 */
const SAVE_SETTING: VroActionDef = {
  name: 'saveSetting',
  description: 'Write one attribute of a configuration element (ConfigurationElement.setAttributeWithKey). Used to keep a baseline between runs. Throws when the element or the method is missing.',
  resultType: 'boolean',
  params: [
    { name: 'categoryPath', type: 'string', description: 'Configuration folder' },
    { name: 'name', type: 'string', description: 'Configuration element name' },
    { name: 'attribute', type: 'string', description: 'Attribute to write' },
    { name: 'value', type: 'string', description: 'Its new value' },
  ],
  script: String.raw`var category = Server.getConfigurationElementCategoryWithPath(String(categoryPath));
if (!category) throw new Error("No configuration folder '" + categoryPath + "'.");
var elements = category.allConfigurationElements || [];
for (var i = 0; i < elements.length; i++) {
  if (String(elements[i].name) !== String(name)) continue;
  if (typeof elements[i].setAttributeWithKey !== "function") throw new Error("this Orchestrator does not let a script write configuration element '" + name + "'");
  elements[i].setAttributeWithKey(String(attribute), String(value));
  return true;
}
throw new Error("No configuration element '" + name + "' in '" + categoryPath + "'.");`,
};

/**
 * Log alert. 9.1: the saved query the Log Based Alert Definition selects,
 * POST /suite-api/api/logs/queryconfigs, left alone when one of the name exists.
 * standalone (8.18/9.0): the alert itself, POST /api/v1/alerts, created
 * disabled, left alone when one of the name exists.
 */
const LOG_ALERT_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
${LOGS_PRELUDE}
var createdId = null;
login();
try {
  if (target === "9.1") {
    var query = JSON.parse(core.resource(RESOURCE_PATH, "queryconfig.json"));
    var existing = queryConfigs();
    for (var i = 0; i < existing.length; i++) if (String(existing[i].name) === String(query.name)) createdId = String(existing[i].id);
    if (createdId) System.log("Exists, left as it is: saved query \"" + query.name + "\" (" + createdId + ").");
    else createdId = core.act(ctx, "create saved query \"" + query.name + "\"", function () {
      var r = core.http("POST", "https://" + settings.opsHost + "/suite-api/api/logs/queryconfigs", auth, query, SAFE);
      return r.body && r.body.id ? String(r.body.id) : "created";
    });
    System.log("Next: a Log Based Alert Definition that selects \"" + query.name + "\" — see IMPORT.md.");
  } else {
    var alert = JSON.parse(core.resource(RESOURCE_PATH, "alert.json"));
    var listed = core.http("GET", "https://" + settings.logsHost + "/api/v1/alerts", auth, null, SAFE).body || [];
    var alerts = listed.length !== undefined && typeof listed !== "string" ? listed : listed.alerts || [];
    for (var j = 0; j < alerts.length; j++) if (String(alerts[j].name) === String(alert.name)) createdId = String(alerts[j].id);
    if (createdId) System.log("Exists, left as it is: alert \"" + alert.name + "\" (" + createdId + ").");
    else createdId = core.act(ctx, "create alert \"" + alert.name + "\" (disabled)", function () {
      var r = core.http("POST", "https://" + settings.logsHost + "/api/v1/alerts", auth, alert, SAFE);
      return r.body && r.body.id ? String(r.body.id) : "created";
    });
  }
} finally {
  logout();
}
objectId = createdId || "";
summary = core.audit(ctx, { target: target, id: objectId });
core.notify(settings.webhook, summary);`;

/**
 * Audit trail. 9.1: the trail's saved query, so everyone runs the same one
 * (POST /suite-api/api/logs/queryconfigs, left alone when it exists).
 * standalone: the check that the trail has not gone quiet — for each account,
 * is there at least one event in the last lookbackHours
 * (GET /api/v1/events/text/CONTAINS <account>/timestamp/><ms>?limit=1)? A
 * silent account fails the run. 9.1 has no published event query, so the quiet
 * check is standalone only.
 */
const AUDIT_TRAIL_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
${LOGS_PRELUDE}
var accounts = settings.accounts || [];
var silent = [];
var queryId = null;
login();
try {
  if (target === "9.1") {
    var query = JSON.parse(core.resource(RESOURCE_PATH, "queryconfig.json"));
    var existing = queryConfigs();
    for (var i = 0; i < existing.length; i++) if (String(existing[i].name) === String(query.name)) queryId = String(existing[i].id);
    if (queryId) System.log("Exists, left as it is: saved query \"" + query.name + "\" (" + queryId + ").");
    else queryId = core.act(ctx, "create saved query \"" + query.name + "\"", function () {
      var r = core.http("POST", "https://" + settings.opsHost + "/suite-api/api/logs/queryconfigs", auth, query, SAFE);
      return r.body && r.body.id ? String(r.body.id) : "created";
    });
  } else {
    var since = new Date().getTime() - Number(settings.lookbackHours || 24) * 3600000;
    for (var a = 0; a < accounts.length; a++) {
      var path = "/api/v1/events/text/" + encodeURIComponent("CONTAINS " + accounts[a]) + "/timestamp/" + encodeURIComponent(">" + since) + "?limit=1";
      var r = core.http("GET", "https://" + settings.logsHost + path, auth, null, SAFE).body || {};
      var events = r.events || [];
      System.log(accounts[a] + ": " + (events.length > 0 ? "present" : "SILENT") + " in the last " + (settings.lookbackHours || 24) + " hours");
      if (events.length === 0) silent.push(String(accounts[a]));
    }
  }
} finally {
  logout();
}
silentAccounts = silent;
summary = core.audit(ctx, { target: target, queryId: queryId, accounts: accounts.length, silent: silent });
core.notify(settings.webhook, summary);
if (silent.length > 0 && settings.failOnSilence !== false && String(settings.failOnSilence) !== "false") throw new Error(silent.length + " account(s) wrote nothing in the last " + (settings.lookbackHours || 24) + " hours: " + silent.join(", ") + ". Collection may have stopped.");`;

// ---------------------------------------------------------------------------
// Shared: Networks login, and the Logs query structure
// ---------------------------------------------------------------------------

/**
 * The environment lines every Networks script opens with.
 *
 * apply.ts has no Networks target, so this is its authPreamble written out for
 * /api/ni. A token handed in directly suits a person at a terminal; a scheduled
 * job sets VCFNET_USER and VCFNET_PASSWORD_FILE instead and logs in for itself.
 * The password is read from a file only its owner can read and sent on stdin,
 * so it never appears in a crontab, a process list or the shell history.
 *
 * The body is the one PowervRNI's Connect-vRNIServer sends: username, password
 * and a domain of LOCAL/local, or LDAP and the directory domain.
 */
export function networksPreamble(): string[] {
  return [
    'if [[ -z "${VCFNET_TOKEN:-}" && -n "${VCFNET_PASSWORD_FILE:-}" ]]; then',
    '  : "${VCFNET_HOST:?set VCFNET_HOST, e.g. vcfnet.example.com}"',
    '  : "${VCFNET_USER:?set VCFNET_USER to the account VCFNET_PASSWORD_FILE belongs to}"',
    '  command -v jq >/dev/null || { echo "jq is required to log in" >&2; exit 2; }',
    '  # LOCAL/local for a local account; LDAP and the directory domain otherwise.',
    '  VCFNET_TOKEN=$(jq -n --arg u "$VCFNET_USER" --arg t "${VCFNET_DOMAIN_TYPE:-LOCAL}" --arg d "${VCFNET_DOMAIN:-local}" \\',
    '      --rawfile p "$VCFNET_PASSWORD_FILE" \'($p | rtrimstr("\\n")) as $p | {username: $u, password: $p, domain: {domain_type: $t, value: $d}}\' |',
    '    curl -sS -f -X POST "https://${VCFNET_HOST}/api/ni/auth/token" -H "Accept: application/json" -H "Content-Type: application/json" --data @- | jq -r \'.token // empty\')',
    '  [[ -n "$VCFNET_TOKEN" ]] || { echo "Networks login returned no token" >&2; exit 2; }',
    'fi',
    ': "${VCFNET_HOST:?set VCFNET_HOST, e.g. vcfnet.example.com}"',
    ': "${VCFNET_TOKEN:?set VCFNET_TOKEN (POST /api/ni/auth/token), or set VCFNET_USER and VCFNET_PASSWORD_FILE to a file holding its password, mode 600}"',
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
  ];
}

/** The environment a scheduled Networks job needs, for a crontab line: no secret in it. */
export function networksScheduledEnv(account = 'svc-archtoolkit'): string {
  return `VCFNET_HOST=vcfnet.example.com VCFNET_USER=${account} VCFNET_PASSWORD_FILE=/etc/archtoolkit/vcfnet-password`;
}

export interface LogsConstraint {
  readonly internalName: string;
  readonly operator: 'CONTAINS' | 'STARTS_WITH';
  readonly value: string;
}

/**
 * A Logs chartQuery: a count of the events matching every constraint.
 *
 * The API takes it as a string holding JSON, not as an object. The keys are
 * the ones in the POST /api/v1/alerts example at vmw-loginsight.github.io,
 * without the start and end times, which an alert replaces with its own
 * search period. The platform does not publish a grammar for it; the reliable
 * way to get one right is to build the query in Explore Logs, save an alert
 * from it, and read its chartQuery back from GET /api/v1/alerts.
 */
export function logsChartQuery(constraints: readonly LogsConstraint[]): string {
  const count = { label: 'Count', value: 'COUNT', requiresField: false, numericOnly: false };
  return JSON.stringify({
    query: '',
    piqlFunctionGroups: [{ functions: [count], field: null }],
    shouldGroupByTime: true,
    eventSortOrder: 'DESC',
    summarySortOrder: 'DESC',
    compareQueryOrderBy: 'TREND',
    compareQuerySortOrder: 'DESC',
    compareQueryOptions: null,
    messageViewType: 'EVENTS',
    constraintToggle: 'ALL',
    piqlFunction: count,
    piqlFunctionField: null,
    fieldConstraints: constraints.map((constraint) => ({ internalName: constraint.internalName, operator: constraint.operator, value: constraint.value })),
    supplementalConstraints: [],
    groupByFields: [],
    extractedFields: [],
  });
}

// ---------------------------------------------------------------------------
// Shared: IMPORT.md, and the Logs content pack (.vlcp) format
// ---------------------------------------------------------------------------

export interface ImportStepSpec {
  readonly heading: string;
  readonly lines: readonly string[];
}

/**
 * IMPORT.md for the Logs, Networks and fleet blueprints: numbered steps in the
 * order they have to happen, each naming the file and exactly where it goes —
 * a menu path or one command — then what is confirmed, what is not, and where
 * it was established. Anything marked VERIFY was not in those sources.
 */
export function importGuide(opts: {
  readonly product: string;
  readonly intro: string;
  readonly steps: readonly (ImportStepSpec | undefined)[];
  readonly verify?: readonly string[];
  readonly sources: readonly string[];
}): string {
  const steps = opts.steps.filter((step): step is ImportStepSpec => step !== undefined);
  return [
    `# Importing this into ${opts.product}`,
    '',
    opts.intro,
    '',
    ...(steps.length > 1 ? ['Do the steps in order. Every script is a dry run until you add `--execute`.', ''] : []),
    ...steps.flatMap((step, index) => [`## ${index + 1}. ${step.heading}`, '', ...step.lines, '']),
    '## Confirmed, and what to verify',
    '',
    ...(opts.verify && opts.verify.length > 0 ? opts.verify.map((line) => `- ${line}`) : ['- Nothing beyond what the steps say.']),
    '',
    '## Sources',
    '',
    ...opts.sources.map((line) => `- ${line}`),
    '',
  ].join('\n');
}

/** Where the Logs import formats were established, for IMPORT.md. */
export const LOGS_SOURCES = {
  vlcp: 'Content pack format: real .vlcp files in github.com/vmw-loginsight/vlcp (Dell_EMC_OS10_Networking-v1.0.vlcp, Apache-HTTP-Server-v1.1.vlcp, Apache-CLF-v1.4.vlcp, index.json) — top-level name, namespace, contentPackId, framework "#9c4", version "2.4", contentVersion, extractedFields, queries, alerts, dashboardSections; alerts with alertType, chartQuery, messageQuery, hitCount, hitOperator, searchPeriod, searchInterval; widgets with chartType, chartOptions, widgetType, chartQuery, messageQuery; extracted-field internalName as base32 of "@@<namespace length>_<namespace><field>".',
  importUi: 'Import route 8.x and 9.0: Broadcom TechDocs, Aria Operations for Logs 8.18, "Import a Content Pack" (Content Packs > Import Content Pack; Install as content pack, or Import into My Content; imported alerts are deactivated). The 9.0 route is the same (thomas-kopton.de, "Migrating Content and Config from Aria Operations for Logs 8.18 to VCF Operations for Logs 9").',
  import91: 'VCF 9.1 Log Management: a .vlcp is not imported directly. It is converted to a management pack with Broadcom’s cp-to-mp-convertor (VCF 9.1.0.0 > Drivers and Tools) and added under Operate > Administration > Integrations > Repository > ADD, with "Allow Unsigned PAK Installation" on (ifitisnotbroken.wordpress.com, 2026-08-19, citing Broadcom’s conversion guide).',
  alertsApi: 'POST /api/v1/alerts and its body: the Log Insight API documentation at vmw-loginsight.github.io.',
  agent91: 'VCF 9.1 agent groups: Broadcom TechDocs 9.1, "Configuring Agent Group" (Operate > Administration > Configurations > Log Collection > Agent Group > ADD; filters; Agent Configuration > Code View) and "Configuring Agents" (liagent.ini, [server] with secret= for agent authentication).',
} as const;

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * The internalName a content pack gives an extracted field: base32 (RFC 4648,
 * lower case) of "@@<length of namespace>_<namespace><field name>", with the
 * padding written as zeros. Decoded from real packs — Dell's
 * "ibadem27mnxw2ltemvwgyltomv2ho33snnuw4z3pomytazdfnrwf6zlwmvxhi3dpm4000000" is
 * "@@23_com.dell.networkingos10dell_eventlog".
 */
export function vlcpInternalName(namespace: string, field: string): string {
  const bytes = new TextEncoder().encode(`@@${namespace.length}_${namespace}${field}`);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '0';
  return out;
}

export interface VlcpField {
  readonly displayName: string;
  readonly preContext: string;
  readonly postContext: string;
  readonly regexValue: string;
  readonly internalName: string;
  /** A string holding JSON, as the packs carry it. */
  readonly constraints: string;
  readonly info: string | null;
}

export interface VlcpConstraint {
  readonly internalName: string;
  readonly operator: 'CONTAINS' | 'STARTS_WITH' | 'EXISTS';
  readonly value?: string;
}

const COUNT = { label: 'Count', value: 'COUNT', requiresField: false, numericOnly: false };

/**
 * A chartQuery as a content pack carries it: the key order and fixed members of
 * the queries in the vmw-loginsight packs, including the start and end times
 * and dateFilterPreset those carry (an alert replaces them with its own period;
 * a widget with the dashboard's). Count by default; `average` charts the mean
 * of an extracted field over time.
 */
export function vlcpChartQuery(opts: {
  readonly constraints: readonly VlcpConstraint[];
  readonly toggle?: 'ALL' | 'ANY';
  readonly average?: VlcpField;
  readonly byTime?: boolean;
  readonly fields?: readonly VlcpField[];
}): string {
  const fn = opts.average ? { label: 'Average', value: 'AVG', requiresField: true, numericOnly: true } : COUNT;
  const field = opts.average ? { internalName: opts.average.internalName, displayName: opts.average.displayName, displayNamespace: null } : null;
  return JSON.stringify({
    query: '',
    startTimeMillis: 1700000000000,
    endTimeMillis: 1700003600000,
    piqlFunctionGroups: [{ functions: [fn], field }],
    dateFilterPreset: 'CUSTOM',
    shouldGroupByTime: opts.byTime ?? false,
    eventSortOrder: 'DESC',
    summarySortOrder: 'DESC',
    compareQueryOrderBy: 'TREND',
    compareQuerySortOrder: 'DESC',
    compareQueryOptions: null,
    messageViewType: 'EVENTS',
    constraintToggle: opts.toggle ?? 'ALL',
    piqlFunction: fn,
    piqlFunctionField: opts.average ? opts.average.internalName : null,
    fieldConstraints: opts.constraints.map((c) => (c.operator === 'EXISTS' ? { internalName: c.internalName, operator: c.operator } : { internalName: c.internalName, operator: c.operator, value: c.value ?? '' })),
    supplementalConstraints: [],
    groupByFields: [],
    extractedFields: (opts.fields ?? []).map((f) => ({ displayName: f.displayName, preContext: f.preContext, postContext: f.postContext, regexValue: f.regexValue, internalName: f.internalName, constraints: f.constraints })),
  });
}

export interface VlcpAlert {
  readonly name: string;
  readonly info: string;
  readonly chartQuery: string;
  readonly hitCount: number;
  readonly searchPeriod: number;
  readonly searchInterval: number;
}

export interface VlcpWidget {
  readonly name: string;
  readonly info: string;
  readonly chartQuery: string;
}

/**
 * A .vlcp: the JSON a content pack is, with the top-level keys and element
 * shapes of the packs in github.com/vmw-loginsight/vlcp. `version` is the pack
 * format ("2.4" in every current pack); the pack's own version is
 * `contentVersion`. No icon: packs import without one (VERIFY on 9.1 conversion).
 */
export function contentPackJson(opts: {
  readonly name: string;
  readonly namespace: string;
  readonly contentVersion: string;
  readonly info: string;
  readonly instructions: string;
  readonly extractedFields?: readonly VlcpField[];
  readonly queries?: readonly { readonly name: string; readonly info: string; readonly chartQuery: string }[];
  readonly alerts?: readonly VlcpAlert[];
  readonly dashboard?: { readonly name: string; readonly widgets: readonly VlcpWidget[] };
}): string {
  const pack = {
    name: opts.name,
    namespace: opts.namespace,
    contentPackId: opts.namespace,
    framework: '#9c4',
    version: '2.4',
    extractedFields: (opts.extractedFields ?? []).map((f) => ({ ...f })),
    queries: (opts.queries ?? []).map((q) => ({ name: q.name, info: q.info, chartQuery: q.chartQuery, messageQuery: '' })),
    alerts: (opts.alerts ?? []).map((a) => ({
      name: a.name,
      info: a.info,
      alertType: 'RATE_BASED',
      chartQuery: a.chartQuery,
      messageQuery: '',
      hitCount: a.hitCount,
      hitOperator: 'GREATER_THAN',
      searchPeriod: a.searchPeriod,
      searchInterval: a.searchInterval,
    })),
    dashboardSections: opts.dashboard
      ? [
          {
            views: [
              {
                name: opts.dashboard.name,
                constraints: [],
                rows: [{ widgets: opts.dashboard.widgets.map((w) => ({ name: w.name, info: w.info, chartType: null, chartOptions: '{}', widgetType: 'chart', chartQuery: w.chartQuery, messageQuery: '' })) }],
              },
            ],
          },
        ]
      : [],
    author: 'Generated by ArchToolKit',
    url: 'https://example.com/archtoolkit',
    contentVersion: opts.contentVersion,
    info: opts.info,
    instructions: opts.instructions,
  };
  return `${JSON.stringify(pack, null, 2)}\n`;
}

/** The IMPORT.md step for a .vlcp, both routes. */
export function vlcpImportStep(file: string, what: string, mode: 'install' | 'my-content' = 'install'): ImportStepSpec {
  return {
    heading: `Import ${file}`,
    lines: [
      `${what}`,
      '',
      `- **VCF Operations for Logs 9.0, Aria Operations for Logs 8.x:** main menu > Content Packs > Import Content Pack > ${mode === 'install' ? '**Install as content pack**' : '**Import into My Content**'} > browse to \`${file}\` > Import. Imported alerts arrive deactivated.`,
      `- **VCF 9.1 Log Management (in VCF Operations):** a .vlcp is not imported as it stands. Convert it with Broadcom’s converter — \`java -jar cp-to-mp-convertor-jar-with-dependencies.jar -i ${file.split('/').pop()}\` — then VCF Operations > Operate > Administration > Integrations > Repository > ADD > Browse, the .pak it wrote. Turn on "Allow Unsigned PAK Installation" in Administrator Settings first: a converted pack is unsigned. (VERIFY — see Sources.)`,
    ],
  };
}

// ---------------------------------------------------------------------------
// VCF Operations for Networks
// ---------------------------------------------------------------------------

export const NETWORKS_AUTOMATIONS: readonly AutomationBlueprint[] = [
  automationBlueprint({
    id: 'vcfnet_flow_check',
    platform: NETWORKS,
    label: 'Check for flows that should not exist',
    group: 'Segmentation',
    description:
      'The question a segmentation project needs answered every week and nobody asks after the first month: is anything still talking across the boundary we closed? A saved search, on a schedule, that reports rather than blocks — because a network automation that blocks on its own findings is how a data centre goes dark.',
    inputs: [
      { id: 'check_name', label: 'Check name', control: 'text', default: 'PCI zone — unexpected flows' },
      { id: 'source', label: 'From', control: 'text', default: "source security group = 'PCI'", hint: 'A condition in the Networks search bar’s language' },
      { id: 'destination', label: 'To', control: 'text', default: "destination security group != 'PCI'" },
      { id: 'allowed_ports', label: 'Except on ports', control: 'text', default: '443, 53', hint: 'The flows you already accept' },
      { id: 'window_hours', label: 'Look back (hours)', control: 'number', default: 24, min: 1, max: 720 },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/segmentation' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const checkName = str(values, 'check_name', 'Flow check');
      const source = str(values, 'source', '');
      const destination = str(values, 'destination', '');
      const allowed = listOf(str(values, 'allowed_ports', ''));
      const hours = num(values, 'window_hours', 24);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || checkName, 'flow-check');

      // The search bar's language, sent as-is to POST /api/ni/search/ql. Each
      // excepted port is its own != so the query uses only plain comparisons.
      const conditions = [source, destination, ...allowed.map((port) => `port != ${port}`)].map((part) => part.trim()).filter(Boolean);
      const search = conditions.length > 0 ? `flows where ${conditions.join(' and ')} in last ${hours} hours` : `flows in last ${hours} hours`;

      const findings: Finding[] = [];
      if (!source.trim() || !destination.trim()) {
        findings.push(error('vcfnet.flow.no-boundary', 'Without both a From and a To there is no boundary, so the check reports ordinary traffic.', { source: 'ArchToolKit' }));
      }
      if (allowed.length === 0) {
        findings.push(
          warning('vcfnet.flow.no-allowlist', 'No ports are excepted, so every legitimate flow across the boundary will be reported too.', {
            remediation: 'List what you already accept. A check that reports two thousand expected flows is a check somebody turns off.',
            source: 'ArchToolKit',
          }),
        );
      }

      const specJson = `${JSON.stringify({ name: checkName, search, schedule: 'daily', destination: webhook || '<REQUIRED>', reportOnly: true }, null, 2)}\n`;
      const pkg = toPackage({
        packageName: packageNameOf('vcfnet', 'flow', base),
        description: `${checkName}: one flow search on VCF Operations for networks, reported. Reads only. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations for networks/${base}`,
        workflow: {
          name: `Flow check ${base}`,
          description: `Runs the search "${search}" and reports the flows it finds: logged, posted to the webhook, and a failed run when there are any, so a schedule shows it. Changes nothing.`,
          inputs: [],
          outputs: [
            { name: 'flowCount', type: 'number', description: 'Flows found' },
            { name: 'flowIds', type: 'Array/string', description: 'The first hundred flow entity ids' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: FLOW_CHECK_WORKFLOW,
        },
        config: {
          name: 'Settings',
          description: 'Settings of the flow check. Fill netPassword after import.',
          attributes: [
            ...NETWORKS_ATTRIBUTES,
            { name: 'webhook', type: 'string', value: webhook, description: 'Where flows found are posted' },
            { name: 'failOnFlows', type: 'boolean', value: true, description: 'Fail the run when any flow matched' },
          ],
        },
        resources: [{ name: 'flow-check.json', content: specJson }],
      });

      return {
        platform: NETWORKS,
        title: `${checkName} — report flows crossing a boundary that should be closed`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Daily, over the last ${hours} hours`, worstCase: 'once a day' },
        scope: {
          what: 'Observed flows only. It reads what happened; it changes no rule and blocks nothing.',
          decidedBy: [
            `The search: ${source}.`,
            `To: ${destination}.`,
            allowed.length > 0 ? `Excluding ports ${allowed.join(', ')}.` : 'No port exclusions.',
            `Over the last ${hours} hours of collected flow data.`,
          ],
          ifWrong: 'You get a noisy report, or a quiet one that is hiding something. Neither breaks anything, which is the point of keeping this read-only.',
        },
        guardrails: [
          { rule: 'It reports; it never writes a firewall rule', because: 'An automation that closes flows on its own findings will close a flow that was load-bearing, at the worst possible moment, with no change record.' },
          { rule: 'Bounded to a time window', because: 'Flow data is large. An unbounded search is a slow query and an expensive one.' },
        ],
        dryRun: [`Paste the search into the Networks search bar first and look at what comes back: ${search}`, `Then run the workflow Flow check ${base} by hand once. The result is the dry run; there is no acting version of this.`],
        undo: ['Nothing to undo. It reads.'],
        told: webhook
          ? [`Posted to ${webhook} when any flow matches: the count, the search and the first hundred flow ids. Nothing is posted on a clean run, and nothing when the search itself fails — that is the exit code’s job.`, 'Send it somewhere a person reviews weekly rather than to an alert channel — this is a review, not an incident.']
          : ['Nobody — set a destination, or this is a search nobody runs.'],
        requires: [
          'Flow collection from the relevant vCenter and NSX sources, and enough retention to cover the window.',
          'A read-only Networks account: netUsername and netPassword in the package settings; VCFNET_USER and VCFNET_PASSWORD_FILE for the script on a schedule, or VCFNET_TOKEN by hand.',
          'VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the Networks certificate trusted — or jq and curl for the script.',
        ],
        files: {
          ...pkg.files,
          [`scripts/${base}.json`]: specJson,
          'scripts/run-check.sh': [
            '#!/usr/bin/env bash',
            '# Run the flow search and report what it found. Reads only.',
            '#',
            '# Exits 0 when nothing matched, 1 when flows crossed the boundary, and 2',
            '# when the search itself failed — so a scheduler can tell "something to',
            '# look at" from "the check is broken". A failed search is never posted as',
            '# if it were a result.',
            'set -euo pipefail',
            'cd "$(dirname "$0")"',
            '',
            ...networksPreamble(),
            '',
            'RESULT=$(mktemp)',
            'trap \'rm -f "$RESULT"\' EXIT',
            '',
            '# POST /api/ni/search/ql takes the search bar’s language: {query, size}.',
            `HTTP=$(jq '{query: .search, size: 100}' ${base}.json | curl -sS -o "$RESULT" -w '%{http_code}' \\`,
            '  -X POST "https://${VCFNET_HOST}/api/ni/search/ql" \\',
            '  -H @<(printf \'Authorization: NetworkInsight %s\\n\' "$VCFNET_TOKEN") \\',
            '  -H "Accept: application/json" -H "Content-Type: application/json" \\',
            '  --data @-) || { echo "Networks did not answer" >&2; exit 2; }',
            'if [[ "$HTTP" != 2* ]]; then',
            '  echo "Search failed: HTTP ${HTTP}" >&2',
            '  head -c 500 "$RESULT" >&2; echo >&2',
            '  exit 2',
            'fi',
            '# A flow search answers with an entity list. Anything else is not a result.',
            'if ! jq -e \'.entity_list_response | type == "object"\' "$RESULT" >/dev/null; then',
            '  echo "Search returned no entity list; check the query in the search bar." >&2',
            '  exit 2',
            'fi',
            '',
            'TOTAL=$(jq -r \'.entity_list_response.total_count // 0\' "$RESULT")',
            `echo '${checkName.replace(/'/g, "'\\''")}'": \${TOTAL} flow(s)"`,
            'if (( TOTAL == 0 )); then',
            '  exit 0',
            'fi',
            'jq -r \'.entity_list_response.results[]? | .entity_id\' "$RESULT"',
            ...(webhook
              ? [
                  '',
                  `jq -n --arg check '${checkName.replace(/'/g, "'\\''")}' --arg search "$(jq -r .search ${base}.json)" --argjson total "$TOTAL" \\`,
                  '  --slurpfile r "$RESULT" \'{source: "vcfnet-flow-check", check: $check, search: $search, total: $total, flows: [$r[0].entity_list_response.results[]?.entity_id]}\' \\',
                  `  | curl -sS -f -X POST '${webhook.replace(/'/g, "'\\''")}' -H "Content-Type: application/json" --data @- >/dev/null \\`,
                  '  || echo "Could not post to the webhook." >&2',
                ]
              : []),
            'exit 1',
            '',
          ].join('\n'),
          'crontab.txt': `# With the fallback script: daily at 05:30. With the Orchestrator package, schedule the workflow Flow check ${base} instead.\n# The password file is mode 600 and owned by the account that runs this.\n30 5 * * * cd /opt/archtoolkit/${base} && ${networksScheduledEnv()} ./scripts/run-check.sh\n`,
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Networks',
            intro: `Networks has no file import for a search or a saved search. What goes into the product is the search text; what runs it is the workflow **Flow check ${base}** in the Orchestrator package, on a schedule (or scripts/run-check.sh from cron). scripts/${base}.json is read by the script; the package carries the same as the resource element flow-check.json.`,
            steps: [
              ...pkg.importSteps,
              {
                heading: 'Put the search into Networks',
                lines: [
                  'Paste this into the search bar at the top of the Networks interface, run it, and read what comes back:',
                  '',
                  '```',
                  search,
                  '```',
                  '',
                  'To keep it in the product, save it from the results page (the save/bookmark action beside the search bar) under the check name. That is the only route: there is no import dialog or documented API for saved searches (VERIFY on your release).',
                ],
              },
              {
                heading: 'Or: schedule scripts/run-check.sh',
                lines: [
                  `Copy the folder to /opt/archtoolkit/${base} on a host that reaches Networks, run \`./scripts/run-check.sh\` once by hand, then install the line in crontab.txt with \`crontab -e\`. POST /api/ni/search/ql takes {query, size} — the body the script builds from scripts/${base}.json.`,
                ],
              },
            ],
            verify: ['The search condition names (security group, port) are the search bar’s own; if the search bar rejects them, so will the API.', 'The body of POST /api/ni/search/ql and its entity_list_response follow PowervRNI; the 9.1 API reference lists the Search operation without it in the page text we could read.'],
            sources: ['POST /api/ni/search/ql {query, size} and the {username, password, domain} login: PowervRNI (Invoke-vRNISearch, Connect-vRNIServer).', 'POST/DELETE /api/ni/auth/token and the Search and Entities categories: developer.broadcom.com, "VCF Operations for networks API", 9.1.'],
          }),
        },
        notes: [
          'Networks sees flows, not intent. A flow that appears here may be perfectly legitimate and undocumented, which is itself the finding.',
          'Run it for a month before anyone proposes acting on it. The first four weeks are mostly discovering what the boundary really carries.',
          'The body {query, size} for POST /api/ni/search/ql, the entity_list_response it returns, and the {username, password, domain} login body all follow PowervRNI (Invoke-vRNISearch, Connect-vRNIServer). The search condition names — source security group, destination security group, port — are the search bar’s; check the query returns what you expect there before scheduling it.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfnet_change_watch',
    platform: NETWORKS,
    label: 'Watch for NSX changes nobody raised',
    group: 'Change control',
    description:
      'A scheduled comparison of the NSX configuration against what it was, so a firewall rule added out of process is found in a day rather than at the next audit. Reports the difference; changes nothing.',
    inputs: [
      { id: 'watch_name', label: 'Name', control: 'text', default: 'NSX change watch' },
      {
        id: 'watch_what',
        label: 'Watch',
        control: 'select',
        options: [
          { value: 'dfw', label: 'Distributed firewall rules' },
          { value: 'groups', label: 'Security groups and their membership' },
          { value: 'segments', label: 'Segments and gateways' },
          { value: 'all', label: 'All of it' },
        ],
        default: 'dfw',
      },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/nsx-change' },
      { id: 'ignore_users', label: 'Ignore changes by', control: 'text', default: 'svc-terraform, svc-automation', hint: 'The accounts that are supposed to make changes' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const watchName = str(values, 'watch_name', 'NSX change watch');
      const what = str(values, 'watch_what', 'dfw');
      const webhook = str(values, 'webhook', '');
      const ignore = listOf(str(values, 'ignore_users', ''));
      const base = slugOf(name || watchName, 'nsx-change-watch');

      const findings: Finding[] = [];
      if (ignore.length === 0) {
        findings.push(
          warning('vcfnet.change.no-exclusions', 'Nothing is excluded, so every change your own automation makes will be reported as unexpected.', {
            remediation: 'List the service accounts that are meant to change NSX. What is left is the interesting part.',
            source: 'ArchToolKit',
          }),
        );
      }

      const queries = WATCH_QUERIES[what] ?? WATCH_QUERIES.dfw!;
      const pkg = toPackage({
        packageName: packageNameOf('vcfnet', 'watch', base),
        description: `${watchName}: the NSX objects Networks sees, compared with the previous run. Reads only. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations for networks/${base}`,
        workflow: {
          name: `Change watch ${base}`,
          description: `Lists ${queries.join(', ')} from VCF Operations for networks with their details, compares each with the previous run's snapshot (the baseline attribute), and posts what was added, removed or changed. The first run records the baseline. Changes nothing in NSX.`,
          inputs: [],
          outputs: [
            { name: 'changeCount', type: 'number', description: 'Objects added, removed or changed' },
            { name: 'snapshot', type: 'string', description: 'This run’s objects and fingerprints, JSON: the next run’s baseline' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: CHANGE_WATCH_WORKFLOW,
        },
        actions: [SAVE_SETTING],
        config: {
          name: 'Settings',
          description: 'Settings of the change watch. Fill netPassword after import. baseline is written by the workflow.',
          attributes: [
            ...NETWORKS_ATTRIBUTES,
            { name: 'webhook', type: 'string', value: webhook, description: 'Where changes are posted' },
            { name: 'baseline', type: 'string', value: '', description: 'The previous run’s snapshot; empty on the first run' },
            { name: 'keepBaseline', type: 'boolean', value: true, description: 'Write each run’s snapshot back into baseline' },
          ],
        },
        resources: [{ name: 'watch.json', content: `${JSON.stringify({ name: watchName, watch: what, queries, ignoreAccounts: ignore }, null, 2)}\n` }],
      });

      return {
        platform: NETWORKS,
        title: `${watchName} — report NSX changes made outside the expected accounts`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Daily, comparing against the previous run', worstCase: 'once a day' },
        scope: {
          what: what === 'all' ? 'Firewall rules, security groups and segments.' : what === 'dfw' ? 'Distributed firewall rules.' : what === 'groups' ? 'Security groups and membership.' : 'Segments and gateways.',
          decidedBy: ['What the previous run recorded.', ignore.length > 0 ? `Changes by ${ignore.join(', ')} are ignored.` : 'No accounts are ignored.'],
          ifWrong: 'A noisy report, or one that misses a change because the account making it was on the ignore list. Review that list as carefully as the report.',
        },
        guardrails: [
          { rule: 'Compares and reports; never reverts — it only reads Networks, and writes nothing but its own baseline attribute', because: 'Reverting a network change automatically, without knowing why it was made, is how a fix becomes an outage.' },
          ...(ignore.length > 0 ? [{ rule: `Changes by ${ignore.join(', ')} are expected`, because: 'Your own automation changing NSX is not a finding. Everything else is.' }] : []),
        ],
        dryRun: [`The first run of the workflow Change watch ${base} has nothing to compare against and simply records the baseline. Read its log: every object it lists is the reference.`],
        undo: ['Nothing to undo. Reverting an NSX change is a change of its own and belongs in the change process.'],
        told: webhook ? [`Posted to ${webhook}.`] : ['Nobody. Set a destination.'],
        requires: ['Read access to the NSX manager through Networks: netUsername and netPassword in the package settings.', 'VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the Networks certificate trusted.'],
        files: {
          ...pkg.files,
          [`${base}.json`]: `${JSON.stringify({ name: watchName, watch: what, queries, ignoreAccounts: ignore, destination: webhook || '<REQUIRED>', reportOnly: true, baselineFile: `${base}-baseline.json` }, null, 2)}\n`,
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Networks',
            intro: `Nothing is imported into Networks. The comparison is the workflow **Change watch ${base}** in the Orchestrator package: it searches the watched objects, fetches their details, and compares them with the previous run. ${base}.json is the same specification in a file, for a runbook tool that would rather do it itself.`,
            steps: [
              ...pkg.importSteps,
              {
                heading: 'Take the baseline',
                lines: [
                  `Run Change watch ${base} once: it records the baseline in the baseline attribute (or, where Orchestrator does not let a script write a configuration element, logs a warning — then paste its snapshot output into baseline). By hand, the same objects are the search bar’s \`${queries.join('`, `')}\`, exported from the results page.`,
                ],
              },
              {
                heading: 'Schedule it',
                lines: [`Library → Change watch ${base} → Schedule, daily.`],
              },
            ],
            verify: [
              'POST /api/ni/entities/fetch with {entity_ids: [{entity_id}]} and its results[].entity follow the vRNI API (the 9.1 reference lists "Get details of entities" under Entities); confirm the body on your build.',
              `The search phrases (${queries.join(', ')}) are the search bar’s; run each there first.`,
              'Networks does not record who changed an object. ignoreAccounts is passed to the webhook for the receiver to match against the NSX audit log; it filters nothing here.',
              'Writing the baseline uses ConfigurationElement.setAttributeWithKey from the workflow; if your Orchestrator refuses, the warning says so and the snapshot output carries it.',
            ],
            sources: ['POST/DELETE /api/ni/auth/token, the Search and the Entities categories: developer.broadcom.com, "VCF Operations for networks API", 9.1.', 'POST /api/ni/search/ql {query, size, cursor} → entity_list_response: PowervRNI (Invoke-vRNISearch).'],
          }),
        },
        notes: [
          'An out-of-process firewall change is usually somebody fixing something at speed. The value here is the conversation the next morning, not the blame.',
          'Keep the baseline in version control rather than on the appliance. Then the diff is a commit, and the history is free.',
        ],
        findings,
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// VCF Operations for Logs
// ---------------------------------------------------------------------------

export const LOGS_AUTOMATIONS: readonly AutomationBlueprint[] = [
  automationBlueprint({
    id: 'vcflog_alert_webhook',
    platform: LOGS,
    label: 'Raise an alert from a log query',
    group: 'Alerting',
    description:
      'A count alert: more than so many matching lines in a window, posted to a webhook. The thing that goes wrong here is not the query — it is that the query matches ten thousand events an hour and the alert becomes its own incident. Logs has no separate rate limit; after a count alert fires it stays quiet for its own window, so the window is the rate limit.',
    inputs: [
      { id: 'alert_name', label: 'Alert name', control: 'text', default: 'ESXi storage path failure' },
      { id: 'match_text', label: 'Lines containing', control: 'text', default: 'Lost path redundancy', hint: 'One phrase. A second phrase is a second alert, or an OR built in Explore Logs' },
      { id: 'host_prefix', label: 'From hosts starting with', control: 'text', default: 'esx', hint: 'Empty matches every source' },
      { id: 'threshold', label: 'Fire when more than', control: 'number', default: 5, min: 0, max: 100000, hint: 'Events in the window' },
      { id: 'window_minutes', label: 'In (minutes)', control: 'number', default: 15, min: 1, max: 1440, hint: 'Also how long it stays quiet after firing' },
      { id: 'webhook', label: 'Send to', control: 'text', default: 'https://runbooks.example.com/hooks/logs' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const alertName = str(values, 'alert_name', 'Log alert');
      const matchText = str(values, 'match_text', '');
      const hostPrefix = str(values, 'host_prefix', '');
      const threshold = num(values, 'threshold', 5);
      const windowMinutes = Math.max(1, num(values, 'window_minutes', 15));
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || alertName, 'log-alert');

      const findings: Finding[] = [];
      if (windowMinutes < 5) {
        findings.push(
          error('vcflog.alert.no-rate-limit', `A ${windowMinutes}-minute window is, in effect, no rate limit: through a log storm this notifies every ${windowMinutes} minute${windowMinutes === 1 ? '' : 's'}.`, {
            remediation: 'Logs has no separate re-fire setting. After a count alert fires it is snoozed for its own time period, so the window is the quiet period. Fifteen to sixty minutes is usually right; raise the threshold with it.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (threshold <= 1) {
        findings.push(
          warning('vcflog.alert.hair-trigger', `A threshold of ${threshold} means one or two lines page somebody.`, {
            remediation: 'For a genuinely fatal message that is right. For anything that happens transiently it is not — use a count over a window.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!matchText) {
        findings.push(error('vcflog.alert.no-match', 'No text to match, so the alert counts every line from these sources.', { source: 'ArchToolKit' }));
      }
      if (/\s/.test(webhook)) {
        findings.push(error('vcflog.alert.webhook-space', 'The webhook address contains a space. Logs reads webhookURLs as a space-separated list, so this becomes two addresses.', { source: 'ArchToolKit' }));
      }

      const constraints: LogsConstraint[] = [
        ...(matchText ? [{ internalName: 'text', operator: 'CONTAINS' as const, value: matchText }] : []),
        ...(hostPrefix ? [{ internalName: 'hostname', operator: 'STARTS_WITH' as const, value: hostPrefix }] : []),
      ];

      // The POST /api/v1/alerts schema: a RATE_BASED alert fires when the count
      // of events matching chartQuery in searchPeriod milliseconds is more than
      // hitCount. chartQuery is a string holding JSON. webhookURLs is a
      // space-separated string.
      const definition = {
        name: alertName,
        info: `Generated by ArchToolKit. More than ${threshold} matching events in ${windowMinutes} minutes.`,
        recommendation: 'Confirm against the metric before acting: a log line says something was written, not that something is broken.',
        alertType: 'RATE_BASED',
        hitCount: threshold,
        hitOperator: 'GREATER_THAN',
        searchPeriod: windowMinutes * 60000,
        chartQuery: logsChartQuery(constraints),
        enabled: false,
        emailEnabled: false,
        vcopsEnabled: false,
        webhookEnabled: Boolean(webhook),
        webhookURLs: webhook,
        autoClearAlertAfterTimeout: false,
      };

      if (![5, 15, 30, 60, 360].includes(windowMinutes)) {
        findings.push(
          warning('vcflog.alert.91-window', `VCF 9.1 log-based alert conditions take a window of 5, 15, 30, 60 or 360 minutes, not ${windowMinutes}.`, {
            remediation: 'On 9.1, pick the nearest of those in the Log Based Alert Definition (log-trigger-condition timeInterval in the 9.1 API reference). The standalone appliance takes any window of a minute or more.',
            source: 'ArchToolKit',
          }),
        );
      }

      // 9.1: the saved query a Log Based Alert Definition selects, as the 9.1
      // API reference's LogsQueryConfig: name, queryText (at least one),
      // dateRange (a fixedRange, or start and end), queryFilters.
      const queryConfig = {
        name: alertName,
        description: `Generated by ArchToolKit. Selected by the log-based alert "${alertName}": more than ${threshold} matching events in ${windowMinutes} minutes.`,
        queryText: [matchText || '*'],
        dateRange: { fixedRange: 'LAST_HOUR' },
        queryFilters: {
          logQueryFiltersOperator: 'AND',
          partitions: [],
          logQueryFilterConditions: hostPrefix ? [{ conditionField: 'hostname', conditionValues: [hostPrefix], queryFilterConditionOperatorType: 'STARTS_WITH' }] : [],
        },
      };
      const definitionJson = `${JSON.stringify(definition, null, 2)}\n`;
      const pkg = toPackage({
        packageName: packageNameOf('vcflog', 'alert', base),
        description: `The log alert "${alertName}": the saved query for it on 9.1 log management, or the alert itself on the 8.18/9.0 appliance. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations for logs/${base}`,
        workflow: {
          name: `Log alert ${base}`,
          description: `logsTarget 9.1: creates the saved query "${alertName}" in VCF Operations log management (POST /suite-api/api/logs/queryconfigs), for the Log Based Alert Definition to select. logsTarget standalone: creates the alert, disabled, on the 8.18/9.0 appliance (POST /api/v1/alerts). Either way, one of the same name is left alone. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would change and change nothing' }],
          outputs: [{ name: 'objectId', type: 'string', description: 'The saved query or alert created or found' }, { name: 'summary', type: 'string', description: 'The audit record, JSON' }],
          script: LOG_ALERT_WORKFLOW,
        },
        actions: [LOGIN_LOGS_APPLIANCE],
        config: {
          name: 'Settings',
          description: 'Settings of the log alert workflow. Set logsTarget, fill the password for it after import; set dryRun to false only after a dry run.',
          attributes: [
            ...LOGS_ATTRIBUTES,
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is created while this is true' },
            { name: 'cap', type: 'number', value: 1, description: 'The most objects one run may create' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [
          { name: 'queryconfig.json', content: `${JSON.stringify(queryConfig, null, 2)}\n` },
          { name: 'alert.json', content: definitionJson },
        ],
      });

      return {
        platform: LOGS,
        title: `${alertName} — fire when more than ${threshold} matching events arrive in ${windowMinutes} minutes`,
        // Creating the alert (or its saved query) is a change, even if the alert itself only reports.
        effect: 'reversible',
        trigger: {
          kind: 'alert',
          detail: `More than ${threshold} events matching the query in the last ${windowMinutes} minutes, evaluated on the platform’s own schedule`,
          worstCase: `once every ${windowMinutes} minutes while the condition holds — after firing, a count alert is snoozed for its own window`,
        },
        scope: {
          what: `Log events whose text contains "${matchText || '(anything)'}"${hostPrefix ? `, from hosts whose name starts with ${hostPrefix}` : ', from every source'}.`,
          decidedBy: [
            matchText ? `text CONTAINS "${matchText}".` : 'No text constraint.',
            hostPrefix ? `hostname STARTS_WITH "${hostPrefix}".` : 'No source filter, so every host shipping logs.',
            `The threshold: more than ${threshold} in ${windowMinutes} minutes.`,
          ],
          ifWrong: 'Either nobody is told about a real failure, or everybody is told about a normal one until they mute the channel. The second is more common and more damaging.',
        },
        guardrails: [
          { rule: 'The workflow is a dry run until dryRun is false, creates at most one object, and leaves one of the same name alone', because: 'A second run would otherwise add a second alert or saved query with the same name, and people then tune the wrong one.' },
          { rule: `Quiet for ${windowMinutes} minutes after it fires`, because: 'Logs snoozes a count alert for the duration of its time period once it has fired, so a storm that lasts an hour notifies about once per window rather than once per line. That is the only rate limit there is: to hear less often, lengthen the window and raise the threshold with it.' },
          { rule: `A count over ${windowMinutes} minutes, not a single line`, because: 'Almost every log message worth alerting on appears once harmlessly before it appears repeatedly.' },
          { rule: 'Sent with enabled set to false', because: 'Turn it on after you have run the query over a week of history and know what it would have done. The published create schema does not list enabled, so check the created alert rather than trusting the request.' },
        ],
        dryRun: [
          'Build the same query in Explore Logs over the last seven days.',
          'Count the times it would have crossed the threshold. That is how often this will notify somebody.',
          `Run the workflow Log alert ${base} with dryRun = true: it logs "DRY RUN: would create …" and changes nothing. scripts/apply.sh (standalone only) prints what it would send unless given --execute. After a standalone create, GET /api/v1/alerts/{id} and confirm enabled is false; if it is not, disable it under Alerts before anything fires.`,
        ],
        undo: ['9.1: delete the Log Based Alert Definition, then DELETE /suite-api/api/logs/queryconfigs/{queryConfigId} with the workflow’s objectId.', 'Appliance: disable it under Alerts > Alert Definitions, or DELETE /api/v1/alerts/{id}. Nothing that already fired is recalled.'],
        told: webhook
          ? [`Posted to ${webhook}. The notification carries up to 200 of the matching events, the total count and a link back to Explore Logs.`, 'A delivery that does not get a 2xx back is retried later by Logs.']
          : ['Nobody — no destination set. The alert still appears under Triggered Alerts.'],
        requires: ['The relevant hosts shipping logs, and enough retention to cover the window you test against.', '9.1: a VCF Operations account allowed to manage log queries and alert definitions. Standalone: a Logs account allowed to create alerts (logsUsername/logsPassword in the package; VCFLOGS_USER and VCFLOGS_PASSWORD_FILE, or VCFLOGS_TOKEN, for the script).'],
        files: {
          ...pkg.files,
          [`import/${base}.json`]: definitionJson,
          [`import/${base}-queryconfig.json`]: `${JSON.stringify(queryConfig, null, 2)}\n`,
          [`import/${base}-alert.vlcp`]: contentPackJson({
            name: `${alertName} (alert)`,
            namespace: `com.archtoolkit.alert.${slugOf(alertName, 'alert').replace(/-/g, '')}`,
            contentVersion: '1.0',
            info: `One alert: more than ${threshold} matching events in ${windowMinutes} minutes. Generated by ArchToolKit.`,
            instructions: webhook ? `After import, open the alert, choose the webhook for ${webhook} under Notify, and enable it.` : 'After import, set who is notified and enable it.',
            alerts: [
              {
                name: alertName,
                info: definition.info,
                chartQuery: vlcpChartQuery({ constraints }),
                hitCount: threshold,
                searchPeriod: windowMinutes * 60000,
                searchInterval: Math.min(windowMinutes * 60000, 300000),
              },
            ],
          }),
          'scripts/apply.sh': applyScript(LOGS, [{ method: 'POST', path: '/api/v1/alerts', payload: `import/${base}.json` }], 'disable the alert under Alerts > Alert Definitions, or DELETE /api/v1/alerts/{id} with the id it returned.').replace('set -euo pipefail\n', 'set -euo pipefail\n# The payloads are under import/, beside scripts/.\ncd "$(dirname "$0")/.."\n'),
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Logs',
            intro: `The Orchestrator package is the central route, for both kinds of log management: its workflow **Log alert ${base}** creates, on VCF 9.1 (logsTarget 9.1), the saved query import/${base}-queryconfig.json in VCF Operations log management, which the Log Based Alert Definition then selects; on the 8.18/9.0 appliance (logsTarget standalone), the alert import/${base}.json itself, disabled. The hand routes stay: scripts/apply.sh sends import/${base}.json to the appliance, and import/${base}-alert.vlcp is a content pack holding only this alert (a content pack carries no notification, so the webhook is chosen after import).`,
            steps: [
              ...pkg.importSteps,
              {
                heading: 'VCF 9.1: the Log Based Alert Definition',
                lines: [
                  `After the workflow has created the saved query "${alertName}": Infrastructure Operations → Configurations → Alert Definitions → Add; the base object type the hosts map to; Add Log Condition, Filter By the saved query; count greater than ${threshold} in ${[5, 15, 30, 60, 360].includes(windowMinutes) ? windowMinutes : 'the nearest allowed window to ' + windowMinutes} minutes; enable it in a policy, then a notification rule with the webhook (TechDocs 9.1, "Log Based Alerts").`,
                  '',
                  'The 9.1 API reference also has a CONDITION_LOG symptom condition (log-condition: queryId or queryTexts, logQueryFilters, logTriggerCondition {functionType COUNT, operatorType GREATER_THAN, value, timeInterval of 5, 15, 30, 60 or 360}). The symptom and alert definition that carry it are not generated here: VERIFY the symptom wrapper for a log condition (adapter and resource kind, state) on your build before scripting it.',
                ],
              },
              {
                heading: 'Or (8.18/9.0 appliance): scripts/apply.sh',
                lines: [
                  `\`./scripts/apply.sh\` shows what it would send; \`./scripts/apply.sh --execute\` sends \`import/${base}.json\` to POST /api/v1/alerts on VCFLOGS_HOST (port 9543). Then GET /api/v1/alerts and check the new alert is disabled. It does not look for an existing alert first; the workflow does.`,
                ],
              },
              vlcpImportStep(`import/${base}-alert.vlcp`, 'Or: import the alert as a content pack. Use Import into My Content so the alert can be edited (an installed pack is read-only), then add the webhook and enable it under Alerts > Alert Definitions.', 'my-content'),
            ],
            verify: [
              'The 9.1 saved query follows the LogsQueryConfig model of the 9.1 API reference (queryText, dateRange.fixedRange, queryFilters with logQueryFilterConditions {conditionField, conditionValues, queryFilterConditionOperatorType}). The wrapper of the GET list is not named there; the workflow accepts a bare array or queryConfigs. "hostname" as a conditionField: VERIFY in Explore Logs.',
              'The appliance alert body follows the published POST /api/v1/alerts schema; the chartQuery was written from the published example and the packs, not exported — build the same query in Explore Logs and compare.',
              'The .vlcp alert element has exactly the keys of the alerts in the vmw-loginsight packs; `enabled` and notification fields are not part of it.',
            ],
            sources: [
              'Logs Management APIs (GET/POST/PUT /suite-api/api/logs/queryconfigs, GET/DELETE …/{queryConfigId}) and the LogsQueryConfig, log-query-filters, log-condition and log-trigger-condition models: developer.broadcom.com, VCF Operations API 9.1.1.',
              'The 9.1 log management service API takes a JWT from POST /suite-api/api/auth/token/exchange {"serviceKeys":["ops-li"]}: Broadcom KB 450054. The /api/v1 and /api/v2 appliance API does not exist on 9.1.',
              LOGS_SOURCES.alertsApi,
              LOGS_SOURCES.vlcp,
              LOGS_SOURCES.importUi,
              LOGS_SOURCES.import91,
            ],
          }),
        },
        notes: [
          'A log alert tells you something was written, not that something is broken. Pair it with the metric that confirms it before anybody is woken up.',
          'VCF 9.1 log management is part of VCF Operations: the workflow creates the saved query through /suite-api/api/logs/queryconfigs with the VCF Operations session, and the alert is a Log Based Alert Definition there. /api/v1/alerts is the 8.18/9.0 appliance only.',
          'The payload follows the POST /api/v1/alerts schema published at vmw-loginsight.github.io: alertType, hitCount, hitOperator, searchPeriod in milliseconds (at least 60000), chartQuery as a JSON string, webhookEnabled and a space-separated webhookURLs. Recent releases choose a named webhook in the interface instead; if the URL list is ignored on yours, pick the webhook there after creating the alert.',
          'The chartQuery was written from the published example, not exported from 9.1. The surest check is to build the query in Explore Logs, save an alert from it, and compare its chartQuery (GET /api/v1/alerts) with the one here.',
          'Narrow by source first, then by text. A CONTAINS across every source is the expensive query.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcflog_audit_trail',
    platform: LOGS,
    label: 'Keep an audit trail of what automation did',
    group: 'Audit',
    description:
      'The other half of every automation in this kit: somewhere the record goes that is not the appliance that did it. A query and a scheduled export, so "what changed last night" is answerable without logging into four systems.',
    inputs: [
      { id: 'trail_name', label: 'Name', control: 'text', default: 'Automation audit trail' },
      { id: 'accounts', label: 'Service accounts to follow', control: 'text', default: 'svc-automation, svc-vcfops, svc-terraform' },
      { id: 'retention_days', label: 'Keep for (days)', control: 'number', default: 400, min: 30, max: 3650, hint: '400 covers a year plus the audit' },
      { id: 'export_to', label: 'Export to', control: 'text', default: 's3://audit-archive/vcf/', hint: 'Somewhere outside the platform being audited' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const trailName = str(values, 'trail_name', 'Audit trail');
      const accounts = listOf(str(values, 'accounts', ''));
      const retention = num(values, 'retention_days', 400);
      const exportTo = str(values, 'export_to', '');
      const base = slugOf(name || trailName, 'audit-trail');

      const findings: Finding[] = [];
      if (!exportTo) {
        findings.push(
          warning('vcflog.audit.no-export', 'The trail stays on the platform it is auditing.', {
            remediation: 'An audit trail that lives on the system being audited is not an audit trail. Export it somewhere with different credentials.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (retention < 90) {
        findings.push(
          warning('vcflog.audit.short-retention', `${retention} days will not cover an audit that asks about last quarter.`, { source: 'ArchToolKit' }),
        );
      }

      const query = accounts.length > 0 ? accounts.map((account) => `user CONTAINS "${account}"`).join(' OR ') : 'user EXISTS';

      const trailQuery = {
        name: `${trailName} — automation accounts`,
        description: `Generated by ArchToolKit. Any event whose text names one of: ${accounts.join(', ') || '(no account)'}.`,
        queryText: ['*'],
        dateRange: { fixedRange: 'LAST_24_HOUR' },
        queryFilters: {
          logQueryFiltersOperator: 'OR',
          partitions: [],
          logQueryFilterConditions: accounts.map((account) => ({ conditionField: 'text', conditionValues: [account], queryFilterConditionOperatorType: 'CONTAINS' })),
        },
      };
      const pkg = toPackage({
        packageName: packageNameOf('vcflog', 'audit', base),
        description: `${trailName}: the saved query on 9.1 log management, or the check that the trail has not gone quiet on the 8.18/9.0 appliance. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations for logs/${base}`,
        workflow: {
          name: `Audit trail ${base}`,
          description: `logsTarget 9.1: creates the saved query "${trailQuery.name}" in VCF Operations log management, unless it exists. logsTarget standalone: checks every account wrote at least one event in the last lookbackHours and fails when one is silent — a trail that goes quiet looks exactly like a quiet night. A dry run until dryRun is set to false in the configuration element; the check is a read and runs in a dry run too.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would change and change nothing' }],
          outputs: [{ name: 'silentAccounts', type: 'Array/string', description: 'standalone: accounts with no event in the window' }, { name: 'summary', type: 'string', description: 'The audit record, JSON' }],
          script: AUDIT_TRAIL_WORKFLOW,
        },
        actions: [LOGIN_LOGS_APPLIANCE],
        config: {
          name: 'Settings',
          description: 'Settings of the audit trail workflow. Set logsTarget and fill the password for it after import.',
          attributes: [
            ...LOGS_ATTRIBUTES,
            { name: 'accounts', type: 'Array/string', value: accounts, description: 'The automation service accounts to follow' },
            { name: 'lookbackHours', type: 'number', value: 24, description: 'standalone: an account with no event in this many hours is silent' },
            { name: 'failOnSilence', type: 'boolean', value: true, description: 'standalone: fail the run when an account is silent' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is created while this is true' },
            { name: 'cap', type: 'number', value: 1, description: 'The most objects one run may create' },
            { name: 'webhook', type: 'string', value: '', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [{ name: 'queryconfig.json', content: `${JSON.stringify(trailQuery, null, 2)}\n` }],
      });

      return {
        platform: LOGS,
        title: `${trailName} — everything the automation accounts did, kept ${retention} days`,
        // On 9.1 the workflow creates the saved query; otherwise it reads.
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: 'Daily export of the previous day', worstCase: 'once a day' },
        scope: {
          what: accounts.length > 0 ? `Events attributed to ${accounts.join(', ')}.` : 'Every event with a user on it.',
          decidedBy: ['The account list above.', 'Whatever those accounts are actually used for — check that none of them is also a human’s day-to-day login.'],
          ifWrong: 'The trail is incomplete and nobody notices until it is needed, which is the worst possible time to find out.',
        },
        guardrails: [
          { rule: 'Reads the logs; the one thing it creates is the saved query (9.1), once, left alone when it exists, and only when armed', because: 'An audit trail that can be written to by the thing it audits is not evidence.' },
          ...(exportTo ? [{ rule: `Exported to ${exportTo}`, because: 'Different system, different credentials. That is what makes it a trail rather than a log.' }] : []),
        ],
        dryRun: ['Run the query for yesterday and read it. If an account you expected is absent, it is not logging what you think it is.', `Run the workflow Audit trail ${base} with dryRun = true: on 9.1 it logs the saved query it would create; on the appliance it checks every account for silence either way.`],
        undo: ['9.1: DELETE /suite-api/api/logs/queryconfigs/{queryConfigId} removes the saved query. Nothing else to undo.'],
        told: ['Nobody routinely — this is a record rather than an alert. On the 8.18/9.0 appliance the workflow fails when an account goes quiet, which means collection has stopped; webhook gets the audit record when set.'],
        requires: ['The automation accounts to be distinct from human accounts, or the trail cannot separate the two.'],
        files: {
          ...pkg.files,
          [`${base}.json`]: `${JSON.stringify({ name: trailName, query, schedule: 'daily', retentionDays: retention, exportTo: exportTo || '<REQUIRED>', format: 'json' }, null, 2)}\n`,
          [`import/${base}-queryconfig.json`]: `${JSON.stringify(trailQuery, null, 2)}\n`,
          [`import/${base}.vlcp`]: contentPackJson({
            name: trailName,
            namespace: `com.archtoolkit.audit.${slugOf(trailName, 'audit').replace(/-/g, '')}`,
            contentVersion: '1.0',
            info: `A saved query for the events of ${accounts.length > 0 ? accounts.join(', ') : 'every account'}. Generated by ArchToolKit.`,
            instructions: 'Open the query from Content Packs, run it over yesterday, and check every service account appears.',
            queries: [
              {
                name: `${trailName} — automation accounts`,
                info: 'Any event whose text names one of the automation service accounts.',
                chartQuery: vlcpChartQuery({ constraints: accounts.map((account) => ({ internalName: 'text', operator: 'CONTAINS' as const, value: account })), toggle: 'ANY', byTime: true }),
              },
            ],
          }),
          'IMPORT.md': importGuide({
            product: 'VCF Operations for Logs',
            intro: `The Orchestrator package carries the trail: its workflow **Audit trail ${base}** creates, on VCF 9.1, the saved query import/${base}-queryconfig.json in VCF Operations log management, and on the 8.18/9.0 appliance checks daily that no account has gone quiet. import/${base}.vlcp carries the same query as a content pack for the appliance. ${base}.json is the specification for the daily export job (query, retention, destination) for your scheduler; Logs has no import for a scheduled export, and 9.1 has no published event query to export with.`,
            steps: [
              ...pkg.importSteps,
              vlcpImportStep(`import/${base}.vlcp`, 'Or: the saved query as a content pack. Install it so it is the same, read-only query for everyone.'),
            ],
            verify: [
              '9.1: the saved query is a LogsQueryConfig with queryText ["*"] and one text CONTAINS condition per account, joined by OR (logQueryFiltersOperator). "text" as a conditionField is not listed in the 9.1 reference; run the saved query in Explore Logs and check every account appears.',
              'standalone: GET /api/v1/events/text/CONTAINS <account>/timestamp/><ms>?limit=1 is the event query of the Log Insight API (vmw-loginsight.github.io); 9.1 log management has no published equivalent, so the quiet check is appliance-only.',
              'The query element (name, info, chartQuery, messageQuery) is written like the alert and widget elements of the published packs; the published packs sampled carry an empty queries array, so VERIFY by exporting a pack with a saved query from your instance.',
              'The accounts are matched as text CONTAINS, any of them. If your sources extract a user field, a constraint on that field is tighter.',
            ],
            sources: ['GET/POST /suite-api/api/logs/queryconfigs and LogsQueryConfig: developer.broadcom.com, VCF Operations API 9.1.1.', 'The 9.1 log management service API and its ops-li token exchange: Broadcom KB 450054.', LOGS_SOURCES.vlcp, LOGS_SOURCES.importUi, LOGS_SOURCES.import91],
          }),
        },
        notes: [
          'Alert on the absence of events, not just their content. A trail that goes silent looks exactly like a quiet night.',
          'Every automation in this kit has a "who is told" section. This is where those records should end up.',
        ],
        findings,
      };
    },
  }),
];
