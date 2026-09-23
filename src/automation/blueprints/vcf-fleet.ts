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

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { authHeader, authPreamble, readScript, scheduledEnv } from '../apply.ts';
import { importGuide, type ImportStepSpec } from './vcf-networks-logs.ts';
import { packageNameOf, toPackage } from '../vro/to-package.ts';

const PLATFORM = 'vcf-fleet' as const;
const SRC = 'ArchToolKit';

const SDDC_API = 'SDDC Manager API reference at developer.broadcom.com (VMware Cloud Foundation API 5.2 and the SDDC Manager API for 9.x): request bodies CredentialsUpdateSpec, CsrsGenerationSpec, ResourceCertificateSpec[], BackupConfigurationSpec, HostCommissionSpec[].';

/** IMPORT.md for an SDDC Manager blueprint: everything goes in through /v1, in this order. */
function sddcImport(intro: string, steps: readonly (ImportStepSpec | undefined)[], verify: readonly string[] = [], sources: readonly string[] = [SDDC_API]): string {
  return importGuide({
    product: 'SDDC Manager',
    intro: `${intro} Every script reads SDDC_HOST and either SDDC_TOKEN (POST /v1/tokens) or SDDC_USER with SDDC_PASSWORD_FILE (mode 600). The same calls can be made from SDDC Manager > Developer Center > API Explorer by pasting the file as the body.`,
    steps,
    verify,
    sources,
  });
}

/** The one step of a read-only, scheduled script. */
function scheduleStep(script: string, base: string, extra: readonly string[] = []): ImportStepSpec {
  return {
    heading: 'Run it once, then schedule it',
    lines: [`Copy the files to /opt/archtoolkit/${base} on a host that reaches SDDC Manager, run \`./${script}\` by hand and compare with the SDDC Manager interface, then install the line in crontab.txt with \`crontab -e\`. It only reads.`, ...extra],
  };
}

/** The call helper every acting script here opens with. */
function apiHelper(): string[] {
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
function notify(webhook: string, source: string): string[] {
  if (!webhook) return [];
  return [`curl -sS -X POST "${webhook}" -H "Content-Type: application/json" --data "$(printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "${source}", problems: .}')" || true`];
}

/** The two checks every acting fleet script makes before it touches anything. */
function lifecycleGuard(): string[] {
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

// ---------------------------------------------------------------------------
// The same jobs as Orchestrator packages
// ---------------------------------------------------------------------------

/** The SDDC Manager login every package here carries. */
const SDDC_ATTRIBUTES = [
  { name: 'sddcHost', type: 'string', value: '', description: 'SDDC Manager host (FQDN)' },
  { name: 'sddcUsername', type: 'string', value: '', description: 'An SDDC Manager account (see requires in the README for the role)' },
  { name: 'sddcPassword', type: 'SecureString', description: 'Its password' },
] as const;

/**
 * The lines every SDDC Manager workflow starts with: POST /v1/tokens, a GET
 * helper, and the guard every acting script here makes — nothing else running.
 */
const SDDC_PRELUDE = String.raw`var SAFE = { redact: settings._secrets };
if (!settings.sddcHost || !settings.sddcUsername || !settings.sddcPassword) throw new Error("Set sddcHost, sddcUsername and sddcPassword in " + SETTINGS_NAME + ".");
var api = "https://" + settings.sddcHost;
var auth = core.loginSddcManager(settings.sddcHost, settings.sddcUsername, settings.sddcPassword);
function get(path) { return core.http("GET", api + path, auth, null, SAFE).body || {}; }
function upper(s) { return String(s === undefined || s === null ? "" : s).toUpperCase(); }
// Every element of a paged SDDC Manager list (/v1/tasks, /v1/hosts,
// /v1/credentials...): the first page as SDDC Manager serves it, then
// pageNumber/pageSize until pageMetadata.totalElements are in hand. An answer
// with no elements list, or fewer elements than pageMetadata promises, is an
// error: never a partial or empty list to act on.
function getAll(path) {
  var sep = path.indexOf("?") < 0 ? "?" : "&";
  var firstNumber = 0;
  var size = 0;
  return core.pageAll(function (page) {
    var b = get(page === 0 ? path : path + sep + "pageNumber=" + (firstNumber + page) + "&pageSize=" + size);
    if (Object.prototype.toString.call(b.elements) !== "[object Array]") throw new Error("GET " + path.split("?")[0] + " returned no elements list (VERIFY the response shape on your release); refusing to go on with an empty list.");
    var meta = b.pageMetadata && typeof b.pageMetadata === "object" ? b.pageMetadata : null;
    if (page === 0) {
      firstNumber = meta && meta.pageNumber !== undefined && meta.pageNumber !== null ? Number(meta.pageNumber) : 0;
      size = meta && Number(meta.pageSize) > 0 ? Number(meta.pageSize) : b.elements.length;
    }
    var total = meta && meta.totalElements !== undefined && meta.totalElements !== null ? Number(meta.totalElements) : null;
    var more = !meta ? false : meta.totalPages !== undefined && meta.totalPages !== null ? page + 1 < Number(meta.totalPages) : null;
    return { items: b.elements, total: total, more: more };
  }, 0);
}
// Nothing else running: rotating, commissioning or reconfiguring while an
// upgrade or a domain operation is in flight is how a resource ends up locked.
function busyGuard() {
  var tasks = getAll("/v1/tasks");
  var busy = 0;
  for (var i = 0; i < tasks.length; i++) if (/IN_PROGRESS|IN PROGRESS|PENDING/.test(upper(tasks[i].status))) busy++;
  if (busy > 0) throw new Error("Refusing: " + busy + " SDDC Manager task(s) in progress. Wait for them to finish. Nothing was changed.");
}
`;

const ROTATION_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
${SDDC_PRELUDE}
var TYPE = String(settings.resourceType), ACCOUNT = String(settings.accountType);
var MODE = String(mode || "ROTATE");
if (MODE !== "ROTATE" && MODE !== "UPDATE_AUTO_ROTATE_POLICY") throw new Error("mode is ROTATE or UPDATE_AUTO_ROTATE_POLICY, not " + MODE + ".");
var DAYS = Number(settings.autoRotateDays || 0);
if (MODE === "UPDATE_AUTO_ROTATE_POLICY" && !(DAYS > 0)) throw new Error("No auto-rotate policy is configured: set autoRotateDays in " + SETTINGS_NAME + ".");
busyGuard();
var domains = settings.domains || [], users = settings.usernames || [];
var all = getAll("/v1/credentials?resourceType=" + encodeURIComponent(TYPE) + "&accountType=" + encodeURIComponent(ACCOUNT));
var selected = [];
for (var i = 0; i < all.length; i++) {
  var c = all[i];
  var domain = c.resource && c.resource.domainName ? String(c.resource.domainName) : "";
  if (domains.length && domains.indexOf(domain) < 0) continue;
  if (users.length && users.indexOf(String(c.username)) < 0) continue;
  selected.push(c);
  System.log("Selected: " + (domain || "-") + "  " + c.resource.resourceName + "  " + c.username);
}
// A failed rotation leaves resources locked; remediate it (operationType REMEDIATE) first.
// Which credential tasks stop the run (GET /v1/credentials/tasks, every page):
//   - one still running (IN_PROGRESS, PENDING): always;
//   - a FAILED one created within failedTaskHours (default 24), or whose
//     creation time cannot be read: always, it may be what is being remediated;
//   - an older FAILED one that names one of the selected resources (a subtask's
//     resourceName or entityName), unless a later SUCCESSFUL task names that
//     resource too (the remediation, or a rotation since);
//   - any other older FAILED one is only warned about: once it is remediated
//     it stays in the list, and must not block every rotation after it.
// VERIFY on your release: the subtask fields that name the resource.
var credentialTasks = getAll("/v1/credentials/tasks");
var WINDOW_HOURS = Number(settings.failedTaskHours || 24);
var nowMs = new Date().getTime();
var selectedNames = {};
for (var sn = 0; sn < selected.length; sn++) selectedNames[String(selected[sn].resource.resourceName).toLowerCase()] = true;
function createdAt(task) { var t = Date.parse(String(task.creationTimestamp || "").replace(/\.[0-9]+/, "").replace(/\+00:00$/, "Z")); return isNaN(t) ? null : t; }
function namesOf(task) {
  var out = {};
  var subs = task.subTasks || task.subtasks || [];
  for (var i = 0; i < subs.length; i++) {
    var n = subs[i].resourceName || subs[i].entityName || (subs[i].resource && subs[i].resource.resourceName);
    if (n) out[String(n).toLowerCase()] = true;
  }
  return out;
}
var lastGood = {};
for (var g = 0; g < credentialTasks.length; g++) {
  if (!/^(SUCCESSFUL|SUCCEEDED|COMPLETED)$/.test(upper(credentialTasks[g].status))) continue;
  var goodAt = createdAt(credentialTasks[g]);
  var goodNames = namesOf(credentialTasks[g]);
  for (var gn in goodNames) if (goodNames.hasOwnProperty(gn) && goodAt !== null && (!lastGood[gn] || goodAt > lastGood[gn])) lastGood[gn] = goodAt;
}
var running = 0, failedTasks = 0, oldFailed = 0;
for (var f = 0; f < credentialTasks.length; f++) {
  var ft = credentialTasks[f];
  var fs = upper(ft.status);
  if (/IN_PROGRESS|IN PROGRESS|PENDING/.test(fs)) { running++; continue; }
  if (fs !== "FAILED") continue;
  var at = createdAt(ft);
  if (at === null || nowMs - at < WINDOW_HOURS * 3600000) { failedTasks++; continue; }
  var names = namesOf(ft);
  var blocks = false;
  for (var fn in names) if (names.hasOwnProperty(fn) && selectedNames[fn] && !(lastGood[fn] && lastGood[fn] > at)) blocks = true;
  if (blocks) failedTasks++;
  else { oldFailed++; System.warn("An older failed credential task (" + (ft.id || "no id") + ", " + ft.creationTimestamp + ") does not block this run: it names no selected resource, or a later task succeeded on it. Check it was remediated."); }
}
if (running > 0) throw new Error("Refusing: " + running + " credential task(s) in progress in SDDC Manager. Wait for them to finish. Nothing was changed.");
if (failedTasks > 0) throw new Error("Refusing: " + failedTasks + " failed credential task(s) in SDDC Manager (in the last " + WINDOW_HOURS + "h, or on a selected resource). Resolve them first. Nothing was changed.");
requestBody = "";
var taskId = "";
if (!selected.length) {
  System.log("Nothing matched. Check the domain and username filters.");
} else {
  var max = Number(settings.maxResources || 0);
  if (selected.length > max) throw new Error("Refusing: " + selected.length + " accounts is more than maxResources (" + max + "). Narrow the scope or raise it on purpose. Nothing was changed.");
  // One PATCH changes every selected account, so the cap counts accounts, not calls.
  var room = ctx.cap - ctx.count;
  if (selected.length > room) {
    if (!ctx.dryRun) throw new Error("Refusing: one PATCH /v1/credentials would change " + selected.length + " account(s), and the cap allows " + room + " more change(s) (cap " + ctx.cap + "). The cap counts accounts. Narrow the scope or raise cap on purpose. Nothing was changed.");
    System.warn("A live run would refuse: " + selected.length + " account(s) is more than the cap of " + ctx.cap + " (the cap counts accounts).");
  }
  // One element per resource, each listing the accounts to rotate (CredentialsUpdateSpec).
  var byResource = {};
  var elements = [];
  for (var s = 0; s < selected.length; s++) {
    var name = String(selected[s].resource.resourceName);
    if (!byResource[name]) { byResource[name] = { resourceName: name, resourceType: selected[s].resource.resourceType, credentials: [] }; elements.push(byResource[name]); }
    byResource[name].credentials.push({ credentialType: selected[s].credentialType, username: selected[s].username });
  }
  var body = { operationType: MODE, elements: elements };
  if (MODE === "UPDATE_AUTO_ROTATE_POLICY") body.autoRotatePolicy = { frequencyInDays: DAYS, enableAutoRotatePolicy: true };
  requestBody = JSON.stringify(body, null, 2);
  var polls = Number(settings.taskPolls || 120);
  taskId = core.act(ctx, (MODE === "ROTATE" ? "rotate " : "set the auto-rotate policy (every " + DAYS + " days) of ") + selected.length + " " + TYPE + " " + ACCOUNT + " password(s)", function () {
    var r = core.http("PATCH", api + "/v1/credentials", auth, body, SAFE);
    var id = r.body && r.body.id;
    if (!id) throw new Error("PATCH /v1/credentials returned no task id.");
    for (var p = 0; p < polls; p++) {
      var status = upper(get("/v1/credentials/tasks/" + encodeURIComponent(id)).status || "UNKNOWN");
      System.log("Credential task " + id + ": " + status);
      if (/^(SUCCESSFUL|SUCCEEDED|COMPLETED)$/.test(status)) return String(id);
      if (status === "FAILED") throw new Error("Credential task " + id + " failed: resources may be locked; remediate before anything else.");
      System.sleep(15000);
    }
    throw new Error("Credential task " + id + " is still running after " + polls + " polls; follow it under Security > Password Management.");
  }) || "";
}
credentialTaskId = taskId;
summary = core.audit(ctx, { resourceType: TYPE, accountType: ACCOUNT, mode: MODE, accounts: selected.length, taskId: taskId });
core.notify(settings.webhook, summary);`;

const CERTIFICATE_WORKFLOW = String.raw`${SDDC_PRELUDE}
var WITHIN = Number(settings.withinDays);
var now = new Date().getTime();
function daysLeft(c) {
  if (c.numberOfDaysToExpire !== undefined && c.numberOfDaysToExpire !== null) return Number(c.numberOfDaysToExpire);
  var text = c.expirationDate || c.notAfter;
  if (!text) return null;
  var t = Date.parse(String(text).replace(/\.[0-9]+/, "").replace(/\+00:00$/, "Z"));
  return isNaN(t) ? null : Math.floor((t - now) / 86400000);
}
var problems = [];
var rows = ["domain,resource,days_left"];
var domains = get("/v1/domains").elements || [];
for (var d = 0; d < domains.length; d++) {
  var certs = get("/v1/domains/" + encodeURIComponent(domains[d].id) + "/resource-certificates").elements || [];
  for (var c = 0; c < certs.length; c++) {
    var resource = certs[c].issuedTo || certs[c].resourceFqdn || certs[c].resourceName || "unknown";
    var days = daysLeft(certs[c]);
    rows.push([domains[d].name, resource, days === null ? "" : days].join(","));
    if (days === null) problems.push(domains[d].name + ": " + resource + " — expiry date could not be read");
    else if (days <= WITHIN) problems.push(domains[d].name + ": " + resource + " expires in " + days + " days");
  }
}
certificatesCsv = rows.join("\n") + "\n";
problemCount = problems.length;
for (var p = 0; p < problems.length; p++) System.warn("PROBLEM: " + problems[p]);
summary = core.audit(null, { source: "vcf-certificates", within: WITHIN, problems: problems });
if (problems.length) {
  core.notify(settings.webhook, { source: "vcf-certificates", problems: problems });
  throw new Error(problems.length + " certificate(s) expire within " + WITHIN + " days or could not be read: " + problems.join("; "));
}
System.log("No certificate expires within " + WITHIN + " days.");`;

const HEALTH_WORKFLOW = String.raw`${SDDC_PRELUDE}
var now = new Date().getTime();
var problems = [];
function ts(text) { if (!text) return null; var t = Date.parse(String(text).replace(/\.[0-9]+/, "").replace(/\+00:00$/, "Z")); return isNaN(t) ? null : t; }
// 1. It answers, and says what it is.
try {
  var managers = get("/v1/sddc-managers").elements || [];
  for (var m = 0; m < managers.length; m++) System.log("SDDC Manager " + managers[m].fqdn + " " + managers[m].version);
} catch (e) { problems.push("SDDC Manager API is not answering: " + (e && e.message ? e.message : e)); }
// 2. Failed and stuck tasks.
var tasks = getAll("/v1/tasks");
for (var t = 0; t < tasks.length; t++) {
  var at = ts(tasks[t].creationTimestamp);
  if (at === null) continue;
  var status = upper(tasks[t].status);
  var name = tasks[t].name || tasks[t].type || tasks[t].id;
  if (status === "FAILED" && now - at < Number(settings.failedHours) * 3600000) problems.push("failed task: " + name);
  else if (/IN_PROGRESS|IN PROGRESS/.test(status) && now - at > Number(settings.stuckHours) * 3600000) problems.push("stuck task (over " + settings.stuckHours + "h): " + name);
}
// 3. Hosts SDDC Manager cannot use.
var hosts = getAll("/v1/hosts");
for (var h = 0; h < hosts.length; h++) if (/UNUSEABLE|UNUSABLE|ERROR/.test(upper(hosts[h].status))) problems.push("host not usable: " + hosts[h].fqdn + " (" + hosts[h].status + ")");
// 4. Backup configured, and recent: the newest task whose name or type mentions backup.
var backup = {};
try { backup = get("/v1/system/backup-configuration"); } catch (e2) { backup = {}; }
if (!(backup.backupLocations || []).length) problems.push("no backup location is configured");
var last = null;
for (var b = 0; b < tasks.length; b++) {
  if (!/backup/i.test(String(tasks[b].name || "") + String(tasks[b].type || ""))) continue;
  if (!last || String(tasks[b].creationTimestamp) > String(last.creationTimestamp)) last = tasks[b];
}
if (!last) problems.push("no backup task found");
else {
  var lastAt = ts(last.creationTimestamp) || 0;
  if (now - lastAt >= Number(settings.backupHours) * 3600000) problems.push("last backup is older than " + settings.backupHours + " hours (" + last.creationTimestamp + ")");
  if (upper(last.status) === "FAILED") problems.push("last backup failed (" + last.creationTimestamp + ")");
}
// 5. Optionally start a health summary (a SoS run): the one POST, and it only starts it.
if (settings.startHealthSummary === true || String(settings.startHealthSummary) === "true") {
  try {
    var run = core.http("POST", api + "/v1/system/health-summary", auth, {}, SAFE).body || {};
    System.log("health summary task: " + (run.id || "none"));
  } catch (e3) { problems.push("could not start a health summary"); }
}
problemCount = problems.length;
for (var p = 0; p < problems.length; p++) System.warn("PROBLEM: " + problems[p]);
summary = core.audit(null, { source: "sddc-manager-health", problems: problems });
if (problems.length) {
  core.notify(settings.webhook, { source: "sddc-manager-health", problems: problems });
  throw new Error("SDDC Manager: " + problems.join("; "));
}
System.log("SDDC Manager: healthy");`;

const BACKUP_CONFIG_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
${SDDC_PRELUDE}
function clean(o) {
  // The previous configuration is an output: never let a secret ride along in it.
  if (o === null || typeof o !== "object") return o;
  var out = Object.prototype.toString.call(o) === "[object Array]" ? [] : {};
  for (var k in o) if (o.hasOwnProperty(k) && !/password|passphrase/i.test(k)) out[k] = clean(o[k]);
  return out;
}
var wanted = JSON.parse(core.resource(RESOURCE_PATH, "backup-configuration.json"));
var FP = String(settings.sshFingerprint || "");
if (!FP) {
  // Orchestrator cannot read the key from the server, and trusting whatever
  // answers is how a backup goes to the wrong server.
  if (!ctx.dryRun) throw new Error("Refusing: set sshFingerprint in " + SETTINGS_NAME + " (ssh-keygen -lf of the SFTP server key, SHA256:...). Nothing was changed.");
  System.warn("sshFingerprint is empty; an armed run refuses until it is set.");
}
wanted.backupLocations[0].sshFingerprint = FP;
var current = get("/v1/system/backup-configuration");
previousConfiguration = JSON.stringify(clean(current), null, 2);
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
var now0 = (current.backupLocations || [])[0] || {};
var want0 = wanted.backupLocations[0];
var unchanged = !!now0.server && now0.server === want0.server && Number(now0.port) === Number(want0.port) && now0.directoryPath === want0.directoryPath && now0.username === want0.username && now0.sshFingerprint === want0.sshFingerprint && same(current.backupSchedules, wanted.backupSchedules);
if (unchanged && !(resend === true || String(resend) === "true")) {
  System.log("Already configured as generated (target, fingerprint and schedule); left as it is. Run with resend = true to send it again, for example after changing the SFTP password or the passphrase.");
} else {
  if (!ctx.dryRun && (!settings.sftpPassword || !settings.backupPassphrase)) throw new Error("Set sftpPassword and backupPassphrase in " + SETTINGS_NAME + ": without the passphrase the backups cannot be restored. Nothing was changed.");
  busyGuard();
  core.act(ctx, "configure SDDC Manager backup to sftp://" + want0.server + ":" + want0.port + want0.directoryPath, function () {
    var body = JSON.parse(JSON.stringify(wanted));
    body.backupLocations[0].password = String(settings.sftpPassword);
    body.encryption.passphrase = String(settings.backupPassphrase);
    var r = core.http("PUT", api + "/v1/system/backup-configuration", auth, body, SAFE);
    return r.body && r.body.id ? String(r.body.id) : "";
  });
  System.log("Then take one backup (POST /v1/backups/tasks, or Backup Now) and check it lands on the server.");
}
summary = core.audit(ctx, { server: want0.server, directory: want0.directoryPath, unchanged: unchanged });
core.notify(settings.webhook, summary);`;

const PRECHECK_WORKFLOW = String.raw`${SDDC_PRELUDE}
var DOMAIN = String(settings.domainName), TARGET = String(settings.targetVersion || "");
var problems = [];
var domainId = null;
var domains = get("/v1/domains").elements || [];
for (var d = 0; d < domains.length; d++) if (domains[d].name === DOMAIN) domainId = String(domains[d].id);
if (!domainId) throw new Error("No workload domain named " + DOMAIN + ".");
System.log("Domain " + DOMAIN + " is " + domainId);
if (TARGET) {
  var bundles = get("/v1/bundles").elements || [];
  var found = 0;
  for (var b = 0; b < bundles.length; b++) {
    var bundle = bundles[b];
    var hit = String(bundle.version || "").indexOf(TARGET) === 0;
    var comps = bundle.components || [];
    for (var c = 0; c < comps.length; c++) if (String(comps[c].toVersion || "").indexOf(TARGET) === 0) hit = true;
    if (!hit) continue;
    found++;
    System.log("bundle " + bundle.id + "  " + (bundle.type || "") + "  " + (bundle.downloadStatus || "UNKNOWN"));
    if (bundle.downloadStatus !== "SUCCESSFUL") problems.push("bundle not downloaded: " + bundle.id);
  }
  if (!found) problems.push("no bundle found for " + TARGET);
}
function failures(node, out) {
  if (node === null || typeof node !== "object") return;
  var status = upper(node.resultStatus || node.status || "");
  if (/FAILED|ERROR|COMPLETED_WITH_FAILURE/.test(status) && (node.name || node.description)) {
    var first = node.errors && node.errors.length ? node.errors[0].message : null;
    var line = (node.name || node.description) + ": " + (first || node.errorMessage || "see SDDC Manager");
    if (out.indexOf(line) < 0) out.push(line);
  }
  for (var k in node) if (node.hasOwnProperty(k)) failures(node[k], out);
}
// Start the precheck: it runs checks and changes nothing. VCF 5.2 and 9.x run
// them as check-sets (query, then run the selection); /v1/system/prechecks is
// deprecated in 5.2 and not in the 9.1 reference, and is used only when the
// check-sets query is not there (404).
var polls = Number(settings.pollCount || 120);
var result = null;
var query = core.http("POST", api + "/v1/system/check-sets/queries", auth, { checkSetType: "UPGRADE", domains: [{ domainId: domainId }] }, { allow: [404], redact: settings._secrets });
if (query.statusCode === 404) {
  var legacy = core.http("POST", api + "/v1/system/prechecks", auth, { resources: [{ resourceId: domainId, type: "DOMAIN" }] }, SAFE).body || {};
  if (!legacy.id) throw new Error("POST /v1/system/prechecks returned no task id.");
  for (var i = 0; i < polls; i++) {
    result = get("/v1/system/prechecks/tasks/" + encodeURIComponent(legacy.id));
    if (!/IN_PROGRESS|IN PROGRESS|PENDING/.test(upper(result.status))) break;
    System.sleep(30000);
  }
} else {
  var q = query.body || {};
  var selection = [];
  var resources = q.resources || [];
  for (var r = 0; r < resources.length; r++) {
    var sets = [];
    for (var s = 0; s < (resources[r].checkSets || []).length; s++) sets.push({ checkSetId: resources[r].checkSets[s].checkSetId });
    if (sets.length) selection.push({ resourceName: resources[r].resourceName, resourceId: resources[r].resourceId, resourceType: resources[r].resourceType, domain: resources[r].domain, checkSets: sets });
  }
  if (!selection.length) throw new Error("SDDC Manager offers no UPGRADE check-sets for " + DOMAIN + ".");
  var runBody = { queryId: q.queryId, resources: selection };
  if (TARGET) runBody.metadata = { targetVersion: TARGET };
  var run = core.http("POST", api + "/v1/system/check-sets", auth, runBody, SAFE).body || {};
  if (!run.id) throw new Error("POST /v1/system/check-sets returned no id.");
  System.log("precheck run " + run.id);
  for (var j = 0; j < polls; j++) {
    result = get("/v1/system/check-sets/" + encodeURIComponent(run.id));
    if (!/IN_PROGRESS|PENDING/.test(upper(result.status))) break;
    System.sleep(30000);
  }
}
if (/IN_PROGRESS|IN PROGRESS|PENDING/.test(upper(result && result.status))) problems.push("precheck still running after " + polls + " polls");
var found2 = [];
failures(result, found2);
for (var f = 0; f < found2.length; f++) problems.push(found2[f]);
precheckResult = JSON.stringify(result, null, 2);
problemCount = problems.length;
for (var p = 0; p < problems.length; p++) System.warn("PROBLEM: " + problems[p]);
summary = core.audit(null, { source: "vcf-upgrade-precheck", domain: DOMAIN, target: TARGET, problems: problems });
if (problems.length) {
  core.notify(settings.webhook, { source: "vcf-upgrade-precheck", problems: problems });
  throw new Error("Precheck of " + DOMAIN + ": " + problems.join("; "));
}
System.log("Precheck passed for " + DOMAIN + ".");`;

const COMMISSION_WORKFLOW = String.raw`var ctx = core.begin(settings, dryRun);
${SDDC_PRELUDE}
var hosts = JSON.parse(core.resource(RESOURCE_PATH, "hosts.json"));
var missing = [];
for (var m = 0; m < hosts.length; m++) if (!settings[hosts[m].envVar]) missing.push(hosts[m].envVar);
if (missing.length) throw new Error("Fill these SecureString attributes in " + SETTINGS_NAME + " from your vault: " + missing.join(", ") + ". Nothing was sent.");
busyGuard();
var POOL = String(settings.networkPool);
var poolId = null;
var pools = get("/v1/network-pools").elements || [];
for (var p = 0; p < pools.length; p++) if (pools[p].name === POOL) poolId = String(pools[p].id);
if (!poolId) throw new Error("No network pool named " + POOL + ".");
// Idempotent: a host SDDC Manager already has is left alone.
var known = {};
var inventory = getAll("/v1/hosts");
for (var k = 0; k < inventory.length; k++) known[String(inventory[k].fqdn).toLowerCase()] = inventory[k].status || "known";
var todo = [];
for (var h = 0; h < hosts.length; h++) {
  if (known[hosts[h].fqdn.toLowerCase()]) System.log("Already in SDDC Manager (" + known[hosts[h].fqdn.toLowerCase()] + "), left alone: " + hosts[h].fqdn);
  else todo.push(hosts[h]);
}
var validationId = "";
var taskId = "";
if (!todo.length) {
  System.log("Every host is commissioned already. Nothing to do.");
} else {
  // One POST /v1/hosts commissions every host in it, so the cap counts hosts, not calls.
  var room = ctx.cap - ctx.count;
  if (todo.length > room) {
    if (!ctx.dryRun) throw new Error("Refusing: one POST /v1/hosts would commission " + todo.length + " host(s), and the cap allows " + room + " more change(s) (cap " + ctx.cap + "). The cap counts hosts. Raise cap on purpose, or list fewer hosts. Nothing was sent.");
    System.warn("A live run would refuse: " + todo.length + " host(s) is more than the cap of " + ctx.cap + " (the cap counts hosts).");
  }
  var spec = [];
  for (var t = 0; t < todo.length; t++) spec.push({ fqdn: todo[t].fqdn, username: todo[t].username, storageType: todo[t].storageType, networkPoolId: poolId, networkPoolName: POOL, password: String(settings[todo[t].envVar]) });
  var polls = Number(settings.pollCount || 60);
  // 1. Validate. Not optional, and also in a dry run — it is the dry run: SDDC
  //    Manager connects to each host and checks it, and changes nothing.
  var v = core.http("POST", api + "/v1/hosts/validations", auth, spec, SAFE).body || {};
  if (!v.id) throw new Error("POST /v1/hosts/validations returned no id.");
  validationId = String(v.id);
  var result = {};
  for (var i = 0; i < polls; i++) {
    result = get("/v1/hosts/validations/" + encodeURIComponent(validationId));
    if (upper(result.executionStatus) === "COMPLETED") break;
    System.sleep(10000);
  }
  var checks = result.validationChecks || [];
  for (var c = 0; c < checks.length; c++) System.log("  " + checks[c].resultStatus + "  " + checks[c].description);
  if (upper(result.resultStatus) !== "SUCCEEDED") throw new Error("Validation " + validationId + " did not succeed (" + (result.resultStatus || result.executionStatus || "no result") + "). Nothing was commissioned.");
  // 2. Commission, only when every host passed.
  taskId = core.act(ctx, "commission " + todo.length + " host(s) into network pool " + POOL, function () {
    var r = core.http("POST", api + "/v1/hosts", auth, spec, SAFE).body || {};
    if (!r.id) throw new Error("POST /v1/hosts returned no task id.");
    for (var j = 0; j < polls * 2; j++) {
      var status = upper(get("/v1/tasks/" + encodeURIComponent(r.id)).status);
      System.log("Commission task " + r.id + ": " + status);
      if (status === "SUCCESSFUL") return String(r.id);
      if (status === "FAILED") throw new Error("Commission task " + r.id + " failed; see it under Tasks in SDDC Manager.");
      System.sleep(20000);
    }
    throw new Error("Commission task " + r.id + " is still running; follow it under Tasks in SDDC Manager.");
  }) || "";
}
commissionTaskId = taskId;
summary = core.audit(ctx, { hosts: todo.length, alreadyKnown: hosts.length - todo.length, validationId: validationId, taskId: taskId });
core.notify(settings.webhook, summary);`;

/** IMPORT.md steps for an SDDC Manager package, then the script's own. */
function withPackage(pkg: { importSteps: readonly { heading: string; lines: readonly string[] }[] }, steps: readonly (ImportStepSpec | undefined)[]): (ImportStepSpec | undefined)[] {
  return [...pkg.importSteps, ...steps.map((step) => (step ? { ...step, heading: `Or, with the script: ${step.heading.charAt(0).toLowerCase()}${step.heading.slice(1)}` } : undefined))];
}

export const VCF_FLEET: readonly AutomationBlueprint[] = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_password_rotation',
    platform: PLATFORM,
    label: 'Rotate managed passwords (SDDC Manager, VCF 5.x / 9.0)',
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
    automation: (values: BlueprintValues, name: string): Automation => {
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

      const findings: Finding[] = [];
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
        '#   ./rotate.sh              dry run (from scripts/; reads select.jq and body.jq beside it)',
        '#   ./rotate.sh --execute    rotate now',
        ...(auto ? ['#   ./rotate.sh --execute --policy   set the auto-rotate policy instead of rotating'] : []),
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
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

      const pkg = toPackage({
        packageName: packageNameOf('fleet', 'password_rotation', base),
        description: `Rotates the ${typeLabel} ${account} passwords SDDC Manager holds${domains.length ? ` in ${domains.join(', ')}` : ''}${auto ? `, or sets their auto-rotate policy (every ${days} days)` : ''}. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/SDDC Manager/${base}`,
        workflow: {
          name: `Rotate passwords ${base}`,
          description: `Selects the ${typeLabel} ${account} accounts SDDC Manager manages (GET /v1/credentials, filtered by domain and username), refuses while any task is running, while a credential task has failed in the last failedTaskHours or on a selected resource, or above maxResources or the cap (which counts accounts), then PATCH /v1/credentials (operationType ${auto ? 'ROTATE, or UPDATE_AUTO_ROTATE_POLICY with the mode input' : 'ROTATE'}) and follows the task. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [
            { name: 'dryRun', type: 'boolean', description: 'true: select and show the request body, change nothing' },
            { name: 'mode', type: 'string', description: auto ? 'ROTATE (default) or UPDATE_AUTO_ROTATE_POLICY' : 'ROTATE (default)' },
          ],
          outputs: [
            { name: 'requestBody', type: 'string', description: 'The PATCH /v1/credentials body (no passwords: SDDC Manager generates them)' },
            { name: 'credentialTaskId', type: 'string', description: 'The credential task, empty in a dry run' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: ROTATION_WORKFLOW,
        },
        config: {
          name: 'Settings',
          description: `Settings of the Rotate passwords ${base} workflow. Fill sddcPassword after import (an ADMIN account); set dryRun to false only after a dry run.`,
          attributes: [
            ...SDDC_ATTRIBUTES,
            { name: 'resourceType', type: 'string', value: type, description: 'ESXI, VCENTER, NSXT_MANAGER, NSXT_EDGE or BACKUP: one type per run' },
            { name: 'accountType', type: 'string', value: account, description: 'USER, SYSTEM or SERVICE' },
            { name: 'domains', type: 'Array/string', value: domains, description: 'Workload domains; empty means every domain' },
            { name: 'usernames', type: 'Array/string', value: users, description: 'Usernames; empty means every account of that type' },
            { name: 'maxResources', type: 'number', value: max, description: 'Refuse above this many accounts' },
            { name: 'autoRotateDays', type: 'number', value: auto ? days : 0, description: 'The auto-rotate policy for mode UPDATE_AUTO_ROTATE_POLICY; 0: none' },
            { name: 'taskPolls', type: 'number', value: 120, description: 'How many times to poll the credential task, 15 seconds apart' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is rotated while this is true' },
            { name: 'failedTaskHours', type: 'number', value: 24, description: 'A FAILED credential task newer than this many hours refuses the run; an older one only when it names a selected resource with no later successful task' },
            { name: 'cap', type: 'number', value: max, description: 'The most accounts one run may change (one PATCH /v1/credentials changes them all, so the cap counts accounts)' },
            { name: 'webhook', type: 'SecureString', description: 'Where the audit record is posted' },
          ],
        },
      });

      return {
        platform: PLATFORM,
        title: `Rotate ${typeLabel} ${account.toLowerCase()} passwords${domains.length ? ` in ${domains.join(', ')}` : ' across the fleet'}`,
        effect: 'reversible',
        trigger: {
          kind: auto ? 'schedule' : 'manual',
          detail: auto
            ? `Run by hand (the workflow Rotate passwords ${base}, or scripts/rotate.sh) to rotate now; the auto-rotate policy then rotates every ${days} days inside SDDC Manager.`
            : `Run by hand (the workflow Rotate passwords ${base}, or scripts/rotate.sh), in a change window, one resource type at a time.`,
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
        dryRun: [`The workflow Rotate passwords ${base} is a dry run until dryRun is set to false in its configuration element: it lists every account and returns the request body in requestBody, and sends nothing.`, 'Run scripts/rotate.sh without --execute. It lists every account and writes request-body.json, and sends nothing.'],
        undo: [
          'A rotation cannot be undone: the old password is gone.',
          'SDDC Manager holds the new one. Retrieve it with GET /v1/credentials?resourceName=<name> as an ADMIN, or lookup_passwords on the appliance.',
          'To put a known value back, PATCH /v1/credentials with operationType UPDATE and the password read from your vault — never typed into a file.',
          ...(auto ? ['To stop scheduled rotation, run the same selection with UPDATE_AUTO_ROTATE_POLICY and enableAutoRotatePolicy false.'] : []),
        ],
        told: [webhook ? `${webhook}: the workflow posts its audit record every run; the script posts when a rotation task fails.` : 'The workflow’s log and audit record; the script’s exit code.', 'SDDC Manager records the task under Credentials > Password Management.'],
        requires: ['An SDDC Manager account with the ADMIN role for the token.', 'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the SDDC Manager certificate trusted in Orchestrator. For the script: jq and bash 4.'],
        files: {
          ...pkg.files,
          'scripts/rotate.sh': rotate,
          'scripts/select.jq': selectJq,
          'scripts/body.jq': bodyJq,
          'IMPORT.md': sddcImport(
            `Nothing is uploaded as a file: the request body is built at run time from the accounts SDDC Manager reports, because each rotation names the exact resources and usernames it touches. The Orchestrator package \`${pkg.packageDir}\` (on the shared core library) does it with the workflow **Rotate passwords ${base}**; scripts/rotate.sh does the same from a host.`,
            withPackage(pkg, [
              {
                heading: 'Build and check the body',
                lines: ['`./scripts/rotate.sh` selects the accounts (GET /v1/credentials, filtered by select.jq) and writes `request-body.json` — exactly the PATCH /v1/credentials body (CredentialsUpdateSpec: operationType ROTATE, elements [{resourceName, resourceType, credentials [{credentialType, username}]}]). Read it.'],
              },
              { heading: 'Rotate', lines: ['`./scripts/rotate.sh --execute` sends request-body.json to PATCH /v1/credentials and follows the task (GET /v1/credentials/tasks/{id}).'] },
              auto
                ? { heading: 'Set the auto-rotate policy', lines: [`\`./scripts/rotate.sh --execute --policy\` (or the workflow with mode UPDATE_AUTO_ROTATE_POLICY) sends the same selection with operationType UPDATE_AUTO_ROTATE_POLICY and autoRotatePolicy {frequencyInDays: ${days}, enableAutoRotatePolicy: true} — the body Broadcom KB 370275 gives.`] }
                : undefined,
            ]),
            ['operationType values (UPDATE, ROTATE, REMEDIATE, UPDATE_AUTO_ROTATE_POLICY) and the element fields are in the CredentialsUpdateSpec schema.', 'The workflow reads every page of GET /v1/credentials and /v1/credentials/tasks (pageNumber and pageSize until pageMetadata.totalElements; VERIFY the paging parameters on your release) and refuses a list shorter than pageMetadata promises. The script reads one page (elements); on an instance with more credentials than one page holds, check the pageMetadata of your release.', 'A FAILED credential task refuses the run when it is newer than failedTaskHours (24), has no readable creation time, or names a selected resource with no later successful task; an older one is only warned about, because a remediated failure stays in the task list.', 'VCF 9.1: SDDC Manager still manages these passwords (techdocs "Using SDDC Manager to Manage Passwords"), but VCF Operations is the preferred place; see fleet91_password_rotate.'],
            [SDDC_API, 'Broadcom KB 370275, "Change password rotation to a custom value, in SDDC manager, via Developer center".'],
          ),
        },
        notes: [
          'On VCF 9.1 the fleet-wide equivalent is in VCF Operations fleet management: see "fleet91_password_rotate" and "fleet91_password_policy" in this kit, against /suite-api/api/fleet-management/password-management.',
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
    label: 'Report certificates about to expire (SDDC Manager, VCF 5.x / 9.0)',
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
    automation: (values: BlueprintValues, name: string): Automation => {
      const within = num(values, 'within_days', 45);
      const webhook = str(values, 'webhook', '');
      const country = str(values, 'country', 'GB');
      const base = slugOf(name || 'certificate-check', 'certificate-check');

      const findings: Finding[] = [];
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
        '#   ./replace-plan.sh install <domain-id> --execute PUT /v1/domains/{id}/resource-certificates',
        '#',
        '# Between the two: fetch the CSRs (GET /v1/domains/{id}/csrs), have them',
        '# signed by your CA, and put the chains into install-certificates.json.',
        '# Both files are exactly the request bodies: CsrsGenerationSpec, and an',
        '# array of ResourceCertificateSpec (PUT; PATCH on that path only sets',
        '# auto-renew in current releases).',
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
        '  install) METHOD=PUT;   PATH_="/v1/domains/${DOMAIN}/resource-certificates"; FILE=install-certificates.json ;;',
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

      const pkg = toPackage({
        packageName: packageNameOf('fleet', 'certificate_check', base),
        description: `Reports the SDDC Manager resource certificates expiring within ${within} days. Reads only. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/SDDC Manager/${base}`,
        workflow: {
          name: `Certificate check ${base}`,
          description: `Reads every workload domain (GET /v1/domains) and the certificates of every resource in it (GET /v1/domains/{id}/resource-certificates), and fails when any expires within withinDays or its date cannot be read, so a schedule shows it. Changes nothing.`,
          inputs: [],
          outputs: [
            { name: 'problemCount', type: 'number', description: 'Certificates inside the window, or unreadable' },
            { name: 'certificatesCsv', type: 'string', description: 'domain,resource,days_left for every certificate' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: CERTIFICATE_WORKFLOW,
        },
        config: {
          name: 'Settings',
          description: `Settings of the Certificate check ${base} workflow. Fill sddcPassword after import (a read-only account is enough).`,
          attributes: [
            ...SDDC_ATTRIBUTES,
            { name: 'withinDays', type: 'number', value: within, description: 'Report certificates expiring within this many days' },
            { name: 'webhook', type: 'SecureString', description: 'Where the problems are posted when there are any' },
          ],
        },
      });

      return {
        platform: PLATFORM,
        title: `Report VCF certificates expiring within ${within} days`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Daily: the workflow Certificate check ${base} on the Orchestrator scheduler, or the fallback script from cron — either way outside SDDC Manager`, worstCase: 'once a day, for every certificate inside the window, until it is replaced' },
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
          'The check only reads (the workflow and scripts/' + base + '.sh alike). Run it once by hand and compare against Security > Certificate Management in SDDC Manager.',
          'scripts/replace-plan.sh prints what it would send unless given --execute.',
        ],
        undo: [
          'The check changes nothing.',
          'A replaced certificate can be put back only if you kept the previous chain and key. Export them before running the install step.',
        ],
        told: [webhook ? `${webhook}, whenever anything is inside the window; and a failed workflow run (or exit code) that the scheduler shows.` : 'A failed workflow run, or the exit code, that the scheduler shows.'],
        requires: ['A read-only SDDC Manager account for the check; an ADMIN one for the replacement plan.', 'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the SDDC Manager certificate trusted in Orchestrator. For the scripts: jq and bash 4.', 'For replacement: a CA that will sign the CSRs, or a Microsoft CA configured in SDDC Manager.'],
        files: {
          ...pkg.files,
          [`scripts/${base}.sh`]: check.replace('set -euo pipefail\n', 'set -euo pipefail\ncd "$(dirname "$0")"\n'),
          'scripts/expiring.jq': expiringJq,
          'scripts/replace-plan.sh': plan.replace('set -euo pipefail\n', 'set -euo pipefail\ncd "$(dirname "$0")/.."\n'),
          'csr-request.json': `${JSON.stringify(csrSpec, null, 2)}\n`,
          'install-certificates.json': `${JSON.stringify(install, null, 2)}\n`,
          'crontab.txt': `# Daily at 07:00, with the fallback script (schedule the workflow in Orchestrator instead if you use the package).\n# The password file is mode 600 and owned by the account that runs this.\n0 7 * * * cd /opt/archtoolkit/${base} && ${scheduledEnv('sddc-manager')} ./scripts/${base}.sh\n`,
          'IMPORT.md': sddcImport(
            `The check reads — the Orchestrator package \`${pkg.packageDir}\` (workflow **Certificate check ${base}**, on the shared core library) or scripts/${base}.sh. Replacing a certificate is two calls whose bodies are the two JSON files here, filled in from the check’s output; scripts/replace-plan.sh sends them (it works from this folder).`,
            [
              ...pkg.importSteps,
              { ...scheduleStep(`scripts/${base}.sh`, base), heading: 'Or: run the script once, then schedule it' },
              {
                heading: 'When something is in the window: generate CSRs',
                lines: ['Fill `resources` in csr-request.json (fqdn and type of each resource from the check), then `./scripts/replace-plan.sh csrs <domain-id>` and `--execute`: PUT /v1/domains/{id}/csrs with csr-request.json as the body. Fetch them with GET /v1/domains/{id}/csrs and have them signed.'],
              },
              {
                heading: 'Install the signed certificates',
                lines: ['Put one element per resource in install-certificates.json (resourceFqdn and certificateChain — leaf, intermediates, root; resourceCertificate and caCertificate are the alternative), then `./scripts/replace-plan.sh install <domain-id> --execute`: PUT /v1/domains/{id}/resource-certificates. Services restart.'],
              },
            ],
            ['CsrsGenerationSpec (keySize is a string: "2048", "3072" or "4096") and the ResourceCertificateSpec array are as the 5.2 and 9.x references give them. On VCF 4.x the install call was a PATCH on the same path.'],
          ),
        },
        notes: [
          'On VCF 9.1 the fleet-wide equivalent is in VCF Operations fleet management: see "fleet91_certificates" in this kit, against /suite-api/api/fleet-management/certificate-management.',
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
    label: 'Check SDDC Manager health (SDDC Manager, VCF 5.x / 9.0)',
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
    automation: (values: BlueprintValues, name: string): Automation => {
      const failedHours = num(values, 'failed_hours', 24);
      const stuckHours = num(values, 'stuck_hours', 6);
      const backupHours = num(values, 'backup_hours', 26);
      const summary = bool(values, 'health_summary', false);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'sddc-health', 'sddc-health');

      const findings: Finding[] = [];
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

      const pkg = toPackage({
        packageName: packageNameOf('fleet', 'health', base),
        description: 'Checks SDDC Manager: it answers, no failed or stuck task, no unusable host, a backup configured and recent. Reads only. Generated by ArchToolKit.',
        categoryPath: `ArchToolKit/SDDC Manager/${base}`,
        workflow: {
          name: `SDDC Manager health ${base}`,
          description: `GET /v1/sddc-managers, /v1/tasks (failed in the last failedHours, running over stuckHours), /v1/hosts (unusable) and /v1/system/backup-configuration with the newest backup task; fails when anything is wrong, so a schedule shows it.${summary ? ' Optionally starts a health summary (POST /v1/system/health-summary).' : ''}`,
          inputs: [],
          outputs: [
            { name: 'problemCount', type: 'number', description: 'Problems found' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: HEALTH_WORKFLOW,
        },
        config: {
          name: 'Settings',
          description: `Settings of the SDDC Manager health ${base} workflow. Fill sddcPassword after import (read-only is enough, unless startHealthSummary is on).`,
          attributes: [
            ...SDDC_ATTRIBUTES,
            { name: 'failedHours', type: 'number', value: failedHours, description: 'Report failed tasks from the last this many hours' },
            { name: 'stuckHours', type: 'number', value: stuckHours, description: 'A task running longer than this is stuck' },
            { name: 'backupHours', type: 'number', value: backupHours, description: 'The last backup must be newer than this' },
            { name: 'startHealthSummary', type: 'boolean', value: summary, description: 'Also start a SoS health summary run' },
            { name: 'webhook', type: 'SecureString', description: 'Where the problems are posted when there are any; somewhere that is not SDDC Manager' },
          ],
        },
      });

      return {
        platform: PLATFORM,
        title: 'SDDC Manager health — tasks, hosts and backup',
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Every hour, from a scheduler outside SDDC Manager: the workflow SDDC Manager health ${base} on the Orchestrator scheduler, or the fallback script from cron`, worstCase: 'every hour while something is wrong' },
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
        dryRun: ['It only reads (the optional health summary starts a SoS run and changes no component). Run it by hand once and compare with the SDDC Manager dashboard.'],
        undo: ['Nothing to undo.', ...(summary ? ['The health summary run leaves a bundle on the appliance; clear old ones as you would any SoS bundle.'] : [])],
        told: [webhook ? `${webhook}, whenever any check fails; and a failed workflow run (or exit code) that the scheduler shows.` : 'A failed workflow run, or the exit code, that the scheduler shows.'],
        requires: ['A read-only SDDC Manager account for the token (an ADMIN one if the health summary is on).', 'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the SDDC Manager certificate trusted in Orchestrator. For the script: jq, bash 4 and GNU date.'],
        files: {
          ...pkg.files,
          [`scripts/${base}.sh`]: script.replace('set -euo pipefail\n', 'set -euo pipefail\ncd "$(dirname "$0")"\n'),
          'scripts/tasks.jq': tasksJq,
          'crontab.txt': `# Hourly, with the fallback script (schedule the workflow in Orchestrator instead if you use the package).\n# The password file is mode 600 and owned by the account that runs this.\n0 * * * * cd /opt/archtoolkit/${base} && ${scheduledEnv('sddc-manager')} ./scripts/${base}.sh\n`,
          'IMPORT.md': sddcImport(`Nothing is imported into SDDC Manager: this reads it on a schedule — the Orchestrator package \`${pkg.packageDir}\` (workflow **SDDC Manager health ${base}**, on the shared core library), or scripts/${base}.sh.`, [...pkg.importSteps, { ...scheduleStep(`scripts/${base}.sh`, base), heading: 'Or: run the script once, then schedule it' }], ['Host status names (ASSIGNED, UNASSIGNED_USEABLE, UNASSIGNED_UNUSEABLE) and the task fields are read as the 5.2 and 9.x references give them; the last backup is found in the task list because the backup configuration does not report its last run in every release.']),
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
  automationBlueprint({
    id: 'fleet_backup_config',
    platform: PLATFORM,
    label: 'Configure SDDC Manager backup to SFTP (SDDC Manager, VCF 5.x / 9.0)',
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
    automation: (values: BlueprintValues, name: string): Automation => {
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

      const findings: Finding[] = [];
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
        '# Works from the folder above scripts/, where the body is.',
        'set -euo pipefail',
        'cd "$(dirname "$0")/.."',
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

      const pkg = toPackage({
        packageName: packageNameOf('fleet', 'backup_config', base),
        description: `Configures SDDC Manager (and NSX Manager) backup to sftp://${server}${directory}, the host key pinned, the secrets from SecureString attributes. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/SDDC Manager/${base}`,
        workflow: {
          name: `Configure backup ${base}`,
          description: 'Reads the current backup configuration (the previousConfiguration output, secrets removed), leaves it alone when target, fingerprint and schedule are already as generated, and otherwise — refusing while any task is running, or without the fingerprint and both secrets — PUT /v1/system/backup-configuration with the payload in the resource element, the SFTP password and passphrase filled in from the configuration element in memory. A dry run until dryRun is set to false in the configuration element.',
          inputs: [
            { name: 'dryRun', type: 'boolean', description: 'true: compare and report, change nothing' },
            { name: 'resend', type: 'boolean', description: 'true: send it even when it looks the same (after changing the SFTP password or the passphrase)' },
          ],
          outputs: [
            { name: 'previousConfiguration', type: 'string', description: 'The configuration before, without secrets: PUT it back (with the secrets) to undo' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: BACKUP_CONFIG_WORKFLOW,
        },
        config: {
          name: 'Settings',
          description: `Settings of the Configure backup ${base} workflow. Fill sddcPassword (ADMIN), sftpPassword and backupPassphrase after import, and sshFingerprint from the SFTP server's own console.`,
          attributes: [
            ...SDDC_ATTRIBUTES,
            { name: 'sshFingerprint', type: 'string', value: fingerprint, description: 'The SFTP server host key fingerprint, SHA256:... (ssh-keygen -lf on the server)' },
            { name: 'sftpPassword', type: 'SecureString', description: `The password of ${user} on ${server}` },
            { name: 'backupPassphrase', type: 'SecureString', description: 'The encryption passphrase; keep a copy where it survives losing SDDC Manager' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is sent while this is true' },
            { name: 'cap', type: 'number', value: 1, description: 'The most configuration changes one run may make' },
            { name: 'webhook', type: 'SecureString', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [{ name: 'backup-configuration.json', content: `${JSON.stringify(payload, null, 2)}\n` }],
      });

      return {
        platform: PLATFORM,
        title: `Back up SDDC Manager to sftp://${server}${directory}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: `Run once (the workflow Configure backup ${base}, or scripts/apply.sh) when the backup target is built or changes; SDDC Manager then runs the schedule itself.`, worstCase: onChange ? 'on the schedule, plus after every state change' : 'on the schedule' },
        scope: {
          what: 'The backup configuration of one SDDC Manager instance, which also sets the target NSX Manager backups use for the domains it manages.',
          decidedBy: ['The SDDC_HOST the script is pointed at.', 'PUT /v1/system/backup-configuration replaces the whole configuration, not one field.'],
          ifWrong: 'Backups go to the wrong server, or to one that does not exist — and nothing fails loudly until a backup task does. The health check in this kit is what notices.',
        },
        guardrails: [
          { rule: 'Credentials only from SecureString attributes (the workflow) or the environment (the script), merged in memory', because: 'A backup password in a file is a password in every copy of that repository.' },
          { rule: 'The host key is pinned by fingerprint; the workflow refuses an armed run without one', because: 'Without it, whoever answers on that address receives the backup, encrypted or not.' },
          { rule: 'Leaves a configuration that already matches alone', because: 'A PUT replaces the whole configuration; sending it for nothing is a change record with no change.' },
          { rule: 'Refuses while another task is running', because: 'Changing the target during a backup or an upgrade leaves that run pointing at a half-configured location.' },
        ],
        dryRun: [`The workflow Configure backup ${base} is a dry run until dryRun is set to false in its configuration element: it compares, logs "DRY RUN: would configure …", and sends nothing.`, 'Run scripts/apply.sh without --execute. It prints the request with the password and passphrase masked, and changes nothing.'],
        undo: [
          'The workflow’s previousConfiguration output (scripts/previous-backup-configuration.json for the script) is the configuration before the change. PUT it back — with its password re-supplied from the vault, because the API does not return it.',
          'Backups already written to the new target stay there; remove them on the SFTP server if the change is abandoned.',
        ],
        told: ['SDDC Manager records the reconfiguration task. Nothing else is told — pair this with the SDDC Manager health check.'],
        requires: [
          'An SFTP server reachable from SDDC Manager and the NSX managers, with the directory created and writable by the user.',
          'The SFTP password and the passphrase in the SecureString attributes sftpPassword and backupPassphrase (the workflow), or SFTP_PASSWORD and BACKUP_PASSPHRASE in the environment from a vault (the script).',
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the SDDC Manager certificate trusted in Orchestrator.',
          'The passphrase stored somewhere that survives losing SDDC Manager. Without it the backup is unreadable.',
        ],
        files: {
          ...pkg.files,
          [`${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'scripts/apply.sh': apply,
          'IMPORT.md': sddcImport(
            `The Orchestrator package \`${pkg.packageDir}\` (workflow **Configure backup ${base}**, on the shared core library) sends it. ${base}.json is the BackupConfigurationSpec that PUT /v1/system/backup-configuration takes — backupLocations, backupSchedules and encryption — with the two secrets left as <REQUIRED> placeholders. apply.sh fills them (and the SSH fingerprint) from the SFTP_PASSWORD and BACKUP_PASSPHRASE environment variables in memory and never writes the filled body to disk.`,
            [
              ...pkg.importSteps,
              {
                heading: 'Or: apply the configuration with the script',
                lines: ['`./scripts/apply.sh` (it reads the body one level up) saves the current configuration to previous-backup-configuration.json and shows the body without secrets; `./scripts/apply.sh --execute` sends it. In the interface the same is Administration > Backup > Site Settings (VCF 9.1: VCF Operations > Administration > SDDC Manager > Backup Settings > Site Settings).'],
              },
              { heading: 'Prove it', lines: ['Take one backup now (POST /v1/backups/tasks, or Backup Now in the interface) and check the file lands on the SFTP server.'] },
            ],
            ['PUT replaces the whole configuration; PATCH on the same path updates it. Both use the complete body here.', 'VCF 9.1.1 also has POST /v1/system/backup-configuration/validations; its response shape is not used here — validate by taking a backup.'],
          ),
        },
        notes: [
          'On VCF 9.1 backups of the management components (VCF Operations, identity broker, management services) are scheduled through the fleet lifecycle API: see "fleet91_lifecycle" in this kit. SDDC Manager backup is still configured here.',
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
    label: 'Precheck a workload domain before an upgrade (SDDC Manager, VCF 5.x / 9.0)',
    group: 'Lifecycle',
    description:
      'Run the SDDC Manager precheck against one workload domain, wait for it, and list every check that failed — with the bundles that are available and downloaded for the target version beside it. It starts a precheck and reads; it upgrades nothing.',
    inputs: [
      { id: 'domain', label: 'Workload domain name', control: 'text', default: 'mgmt-domain' },
      { id: 'target_version', label: 'Target VCF version', control: 'text', default: '9.1.0.0', hint: 'As the bundle list names it' },
      { id: 'timeout_minutes', label: 'Give up after (minutes)', control: 'number', default: 60, min: 5, max: 480 },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-lifecycle' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const domain = str(values, 'domain', 'mgmt-domain');
      const target = str(values, 'target_version', '');
      const timeout = num(values, 'timeout_minutes', 60);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || `precheck-${domain}`, 'precheck');

      const findings: Finding[] = [];
      if (!target) {
        findings.push(warning('fleet.precheck.no-target', 'No target version is given, so bundle availability cannot be checked.', { source: SRC }));
      }
      if (timeout < 20) {
        findings.push(info('fleet.precheck.short-timeout', 'A precheck of a large domain routinely takes longer than twenty minutes.', { source: SRC }));
      }

      const failuresJq = [
        '# Every failed sub-check, flattened. The result nests checks under subTasks,',
        '# validationChecks or (check-sets) the assessment output depending on release;',
        '# every object is walked.',
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
        '# Start the precheck. It runs checks and changes nothing. VCF 5.2 and 9.x run',
        '# them as check-sets: query the UPGRADE check-sets for the domain, then run',
        '# all of them. /v1/system/prechecks is deprecated in 5.2 and not in the 9.1',
        '# reference; it is used only when the check-sets query is not there (404).',
        `CS_CODE=$(curl -sS -o check-set-query.json -w '%{http_code}' -X POST "https://\${SDDC_HOST}/v1/system/check-sets/queries" \\`,
        `  -H "${authHeader('sddc-manager')}" -H "Content-Type: application/json" -H "Accept: application/json" \\`,
        '  --data "$(jq -n --arg id "$DOMAIN_ID" \'{checkSetType: "UPGRADE", domains: [{domainId: $id}]}\')" || echo 000)',
        'if [[ "$CS_CODE" == 200 ]]; then',
        '  RUN_BODY=$(jq -c --arg t "$TARGET" \'{queryId, resources: [.resources[]? | select((.checkSets // []) | length > 0) | {resourceName, resourceId, resourceType, domain, checkSets: [.checkSets[] | {checkSetId}]}]} + (if $t != "" then {metadata: {targetVersion: $t}} else {} end)\' check-set-query.json)',
        '  [[ "$(jq \'.resources | length\' <<<"$RUN_BODY")" != 0 ]] || { echo "SDDC Manager offers no UPGRADE check-sets for ${DOMAIN_NAME}" >&2; exit 2; }',
        `  TASK=$(curl -sS -f -X POST "https://\${SDDC_HOST}/v1/system/check-sets" -H "${authHeader('sddc-manager')}" -H "Content-Type: application/json" --data "$RUN_BODY" | jq -r .id)`,
        '  RESULT_PATH="/v1/system/check-sets/${TASK}"',
        'elif [[ "$CS_CODE" == 404 ]]; then',
        '  TASK=$(curl -sS -f -X POST "https://${SDDC_HOST}/v1/system/prechecks" \\',
        `    -H "${authHeader('sddc-manager')}" -H "Content-Type: application/json" \\`,
        '    --data "$(jq -n --arg id "$DOMAIN_ID" \'{resources: [{resourceId: $id, type: "DOMAIN"}]}\')" | jq -r .id)',
        '  RESULT_PATH="/v1/system/prechecks/tasks/${TASK}"',
        'else',
        '  echo "The check-sets query answered HTTP ${CS_CODE}; see check-set-query.json" >&2; exit 2',
        'fi',
        'echo "precheck ${TASK}"',
        '',
        `DEADLINE=$(( $(date +%s) + ${timeout} * 60 ))`,
        'while :; do',
        '  RESULT=$(get "$RESULT_PATH")',
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

      const pkg = toPackage({
        packageName: packageNameOf('fleet', 'upgrade_precheck', base),
        description: `Prechecks workload domain ${domain}${target ? ` for ${target}` : ''} in SDDC Manager and lists every failed check. Starts a precheck and reads; upgrades nothing. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/SDDC Manager/${base}`,
        workflow: {
          name: `Upgrade precheck ${base}`,
          description: 'Resolves the domain by name, checks the target bundles are there and downloaded, then runs the UPGRADE check-sets for the domain (POST /v1/system/check-sets/queries, then POST /v1/system/check-sets, then GET /v1/system/check-sets/{runId}) — or, where check-sets are not there, the older POST /v1/system/prechecks — and fails listing every failed check, so a schedule shows it. Changes no component.',
          inputs: [],
          outputs: [
            { name: 'problemCount', type: 'number', description: 'Failed checks and missing bundles' },
            { name: 'precheckResult', type: 'string', description: 'The full precheck result, JSON' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: PRECHECK_WORKFLOW,
        },
        config: {
          name: 'Settings',
          description: `Settings of the Upgrade precheck ${base} workflow. Fill sddcPassword after import (OPERATOR or ADMIN).`,
          attributes: [
            ...SDDC_ATTRIBUTES,
            { name: 'domainName', type: 'string', value: domain, description: 'The workload domain, by name' },
            { name: 'targetVersion', type: 'string', value: target, description: 'The target VCF version, as the bundle list names it; empty: no bundle check' },
            { name: 'pollCount', type: 'number', value: timeout * 2, description: 'How many times to poll the precheck, 30 seconds apart' },
            { name: 'webhook', type: 'SecureString', description: 'Where the failed checks are posted when there are any' },
          ],
        },
      });

      return {
        platform: PLATFORM,
        title: `Upgrade precheck — ${domain}${target ? ` to ${target}` : ''}`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Daily in the week before an upgrade window (the workflow Upgrade precheck ${base} on the Orchestrator scheduler, or the fallback script), and once by hand the morning of it`, worstCase: 'once a day' },
        scope: {
          what: `The workload domain ${domain}: its components, as the SDDC Manager precheck sees them, and the bundle list.`,
          decidedBy: [`GET /v1/domains, matched by name ${domain}.`, 'The UPGRADE check-sets SDDC Manager offers for that domain (POST /v1/system/check-sets/queries), all of them selected; on a release without check-sets, POST /v1/system/prechecks with that domain as the only resource.', target ? `GET /v1/bundles filtered to ${target}.` : 'No bundle check.'],
          ifWrong: 'A precheck of the wrong domain passes and reassures nobody usefully. The script prints the domain id it resolved; check it.',
        },
        guardrails: [
          { rule: 'Starts a precheck and nothing else', because: 'An upgrade is a change-window decision, not a scheduled job.' },
          { rule: `Gives up after ${timeout} minutes`, because: 'A precheck that hangs should be a finding, not a scheduler slot held forever.' },
        ],
        dryRun: ['The precheck is itself the dry run of the upgrade. It changes no component.'],
        undo: ['Nothing to undo. The precheck result stays in SDDC Manager’s task list.'],
        told: [webhook ? `${webhook}, with each failed check; and a failed workflow run (or exit code) that the scheduler shows.` : 'A failed workflow run with the precheckResult output, or the script’s exit code and precheck-result.json.'],
        requires: ['An SDDC Manager account allowed to run prechecks (OPERATOR or ADMIN).', 'The target bundles downloaded, or a depot configured, for the bundle part to mean anything.', 'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the SDDC Manager certificate trusted in Orchestrator.'],
        files: {
          ...pkg.files,
          [`scripts/${base}.sh`]: script.replace('set -euo pipefail\n', 'set -euo pipefail\ncd "$(dirname "$0")"\n'),
          'scripts/failures.jq': failuresJq,
          'IMPORT.md': sddcImport(
            `Nothing is imported into SDDC Manager: the Orchestrator package \`${pkg.packageDir}\` (workflow **Upgrade precheck ${base}**, on the shared core library) starts a precheck and reads its result; scripts/${base}.sh does the same from a host.`,
            [
              ...pkg.importSteps,
              { heading: 'Or: run the precheck with the script', lines: [`\`./scripts/${base}.sh\` from a host that reaches SDDC Manager, a day or more before the upgrade window. In the interface: Lifecycle Management > the domain > Precheck (VCF 9.1 reaches the SDDC Manager pages from VCF Operations; VERIFY the menu on your release).`] },
            ],
            [
              'POST /v1/system/prechecks is marked deprecated in the VCF 5.2 API reference and is not in the SDDC Manager 9.1.1 reference, which has check-sets instead; the workflow and the script use check-sets and fall back to prechecks only on a 404.',
              'The check-sets run is read back with GET /v1/system/check-sets/{runId}, taking the id the run call returned as the run id, and its status values (IN_PROGRESS, COMPLETED_WITH_SUCCESS, COMPLETED_WITH_FAILURE) from the 9.1.1 reference; where the failed checks sit inside that result is not spelt out there, so every object with a FAILED or ERROR status and a name is reported. Check one run by hand.',
            ],
          ),
        },
        notes: [
          'On VCF 9.1 the management components are upgraded through the fleet lifecycle upgrade plan: see "fleet91_lifecycle" in this kit. Workload domains are still prechecked in SDDC Manager, as here.',
          'Newer releases split prechecks into check-sets (POST /v1/system/check-sets/queries, then /v1/system/check-sets) so you can precheck against a specific target: the workflow and the script use them, and /v1/system/prechecks (deprecated since 5.2, gone from the 9.1 reference) only where they are not there.',
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
    label: 'Commission ESXi hosts (SDDC Manager, VCF 5.x / 9.0)',
    group: 'Hosts',
    description:
      'Add prepared ESXi hosts to SDDC Manager’s inventory so a domain or cluster can use them. It always validates first — validation is the dry run — reads each host’s root password from its own environment variable, and commissions only when every host has passed.',
    inputs: [
      { id: 'hosts', label: 'Hosts', control: 'textarea', default: 'esx05.example.com\nesx06.example.com\nesx07.example.com\nesx08.example.com', hint: 'One FQDN per line. Append :NFS (or another type) to override the storage type for that host' },
      { id: 'storage_type', label: 'Storage type', control: 'select', options: STORAGE_TYPES, default: 'VSAN_ESA' },
      { id: 'network_pool', label: 'Network pool', control: 'text', default: 'wld-01-np01' },
      { id: 'username', label: 'Username', control: 'text', default: 'root' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
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

      const findings: Finding[] = [];
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
        'cd "$(dirname "$0")"',
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

      const pkg = toPackage({
        packageName: packageNameOf('fleet', 'host_commission', base),
        description: `Commissions ${hosts.length} ESXi host(s) into SDDC Manager, network pool ${pool}: validates every host first and commissions only when all pass. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/SDDC Manager/${base}`,
        workflow: {
          name: `Commission hosts ${base}`,
          description: 'Refuses while any task is running or a host password is missing; leaves alone a host SDDC Manager already has; validates the rest (POST /v1/hosts/validations — the dry run, it changes nothing) and, only when every host passed and dryRun is false in the configuration element, commissions them (POST /v1/hosts) and follows the task.',
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: validate only' }],
          outputs: [
            { name: 'commissionTaskId', type: 'string', description: 'The commission task, empty in a dry run' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: COMMISSION_WORKFLOW,
        },
        config: {
          name: 'Settings',
          description: `Settings of the Commission hosts ${base} workflow. Fill sddcPassword (ADMIN) and each host's ${user} password after import, from your vault.`,
          attributes: [
            ...SDDC_ATTRIBUTES,
            { name: 'networkPool', type: 'string', value: pool, description: 'The network pool, by name' },
            ...hosts.map((host) => ({ name: host.envVar, type: 'SecureString' as const, description: `${host.fqdn}: the ${user} password` })),
            { name: 'pollCount', type: 'number', value: 60, description: 'How many times to poll the validation (10 s apart; the commission task twice as many, 20 s apart)' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is commissioned while this is true' },
            { name: 'cap', type: 'number', value: hosts.length, description: 'The most hosts one run may commission (one POST /v1/hosts commissions them all, so the cap counts hosts; a run over it refuses before sending anything)' },
            { name: 'webhook', type: 'SecureString', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: [{ name: 'hosts.json', content: `${JSON.stringify(hosts, null, 2)}\n` }],
      });

      return {
        platform: PLATFORM,
        title: `Commission ${hosts.length} ESXi host${hosts.length === 1 ? '' : 's'} (${types.join(', ') || defaultType}) into ${pool}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: `Run by hand (the workflow Commission hosts ${base}, or scripts/${base}.sh) when hosts have been racked, imaged and given DNS.`, worstCase: 'once per batch' },
        scope: {
          what: `Exactly the hosts listed: ${hosts.map((host) => host.fqdn).join(', ') || 'none'}.`,
          decidedBy: ['hosts.json, written from the list in this blueprint.', `Network pool ${pool}, resolved to its id at run time.`],
          ifWrong: 'A host that belongs to something else is taken into SDDC Manager’s inventory. It is not reimaged or joined to a cluster, but SDDC Manager now believes it owns it — decommission it before anyone builds on it.',
        },
        guardrails: [
          { rule: 'Always validates, and commissions only if every host passed', because: 'Validation catches the wrong VLAN, a bad password, an unsupported build — before the host is in the pool.' },
          { rule: 'One password per host (a SecureString attribute in the workflow, a variable for the script), all present before anything is sent', because: 'A shared root password across hosts is one leak away from all of them, and a missing one should stop the run at the start.' },
          { rule: 'A host SDDC Manager already has is left alone', because: 'Running the batch again after a partial success must not try to commission a host twice.' },
          { rule: 'Refuses while another task is running', because: 'Commissioning during a domain operation competes for the network pool’s addresses.' },
        ],
        dryRun: [`The workflow Commission hosts ${base} is a dry run until dryRun is set to false in its configuration element: it validates every host with SDDC Manager and stops there. The script does the same without --execute.`],
        undo: [
          'Decommission: DELETE /v1/hosts with a body listing each FQDN (verify the shape for your release), or Hosts > Decommission in SDDC Manager.',
          'A decommissioned host has to be reimaged before it is commissioned again.',
        ],
        told: ['SDDC Manager records the validation and the commission task; the workflow’s audit record goes to the webhook if set.'],
        requires: [
          'Each host imaged at a supported ESXi build, with forward and reverse DNS, NTP, and SSH enabled.',
          `The network pool ${pool} with free addresses for vMotion and storage for every host.`,
          ...hosts.map((host) => `${host.envVar} (the attribute of that name in the workflow's configuration element, or the variable for the script) set to ${host.fqdn}’s ${user} password, from your vault.`),
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the SDDC Manager certificate trusted in Orchestrator.',
        ],
        files: {
          ...pkg.files,
          [`scripts/${base}.sh`]: script,
          'scripts/hosts.json': `${JSON.stringify(hosts, null, 2)}\n`,
          'scripts/spec.jq': specJq,
          'IMPORT.md': sddcImport(
            `The Orchestrator package \`${pkg.packageDir}\` (workflow **Commission hosts ${base}**, on the shared core library) builds the body from its resource element hosts.json and the per-host SecureString attributes. scripts/hosts.json lists the hosts without passwords; scripts/spec.jq turns it into exactly the HostCommissionSpec array POST /v1/hosts and POST /v1/hosts/validations take (fqdn, username, password, storageType, networkPoolId, networkPoolName), each password read from the variable named in hosts.json.`,
            [
              ...pkg.importSteps,
              { heading: 'Or: validate with the script', lines: [`Export each host’s password variable (${hosts.map((host) => host.envVar).join(', ')}), then \`./scripts/${base}.sh\`: it resolves the network pool id and runs POST /v1/hosts/validations.`] },
              { heading: 'Or: commission with the script', lines: [`\`./scripts/${base}.sh --execute\` sends the same body to POST /v1/hosts and follows the task. In the interface: Inventory > Hosts > Commission Hosts, which also accepts a JSON file of the same host list.`] },
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
];
