/**
 * VCF Automation: extensibility, day 2 and modern apps.
 *
 * The first set of VCF Automation blueprints covers the request: the cloud
 * template, the approval policy, the ABX action on a lifecycle event. This set
 * covers everything that happens around and after it — the Orchestrator
 * workflows and actions the platform calls into, the custom day-2 actions and
 * the policy that says who may run them, custom resource types for the things
 * that are not machines, and the "All Apps" side of VCF 9: Supervisor
 * namespaces, VKS clusters and Terraform run from inside a template.
 *
 * Orchestrator is the VCF Automation Orchestrator. VKS was TKG, and Tanzu
 * Kubernetes Grid Service before that. The payload shapes here follow the
 * APIs as they stood at VCF 9.x; where a field name or an apiVersion moves
 * between releases the file says so rather than guessing quietly.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { applyScript } from '../apply.ts';
import { apiStep, importBundle, importMd, kubeStep, manualStep, verifyFor, workflowId, type AbxArtifact, type VroParam, type VroWorkflowArtifact } from '../vcfa-import.ts';
import { packageNameOf, toPackage } from '../vro/to-package.ts';
import type { VroActionDef } from '../vro/core.ts';
import type { VroConfigAttribute } from '../../kit/vro-package.ts';
import {
  PLATFORM,
  SRC,
  json,
  q,
  elementName,
  extraWorkflow,
  vcfaSettings,
  guardSettings,
  pa,
  vcfaActions,
  abxBody,
  VCFA_LOGIN,
  PKG_REQUIRES,
  VERIFY_LOGIN,
  underScripts,
  abxStep,
  orByHand,
  packageSteps,
  templatePayload,
  kubectlScript,
  paramOf,
  abxStub,
  rowsOf,
  yes,
  lookupActions,
  criteriaOf,
} from './vcf-automation-extend-core.ts';
import { VKS_CLUSTER } from './vcf-automation-extend-vks.ts';
import { ORCHESTRATOR_ASSETS, ORCHESTRATOR_ENDPOINT, SECRETS } from './vcf-automation-extend-orchestrator.ts';
import { GENERIC_WORKFLOW_INPUTS, customRows, workflowExtras } from './vcf-automation-extend-workflow.ts';
import { CUSTOM_FORM, FORM_FIELD_HINT, formDefinition, parseFormFields } from './vcf-automation-extend-forms.ts';

// ---------------------------------------------------------------------------
// Orchestrator workflow scaffolds

/**
 * A "From" cell of a resource action's input table as the binding stored on
 * the runnable's input parameter. The serialised form is VERIFY: make one
 * binding in the interface and GET the resource action to compare.
 */
function bindingOf(from: string): Record<string, string> {
  if (from === 'resource') return { type: 'resource' };
  if (from.startsWith('property:')) return { type: 'property', value: `\${properties.${from.slice('property:'.length)}}` };
  if (from.startsWith('form:')) return { type: 'form', value: from.slice('form:'.length) };
  return { type: 'constant', value: from.replace(/^const:/, '') };
}

interface WorkflowTask {
  readonly label: string;
  readonly about: string;
  readonly inputs: readonly { name: string; type: string; description: string }[];
  readonly outputs: readonly { name: string; type: string; description: string }[];
  /** Configuration element attributes the script reads. */
  readonly settings: readonly { key: string; type: string; description: string; example: string }[];
  /** The body of the try block, after the dry-run check. */
  readonly act: readonly string[];
  /** What the dry run logs. */
  readonly wouldDo: string;
  readonly undo: string;
  readonly scope: string;
  /**
   * The same task in the package: settings from core.settings (setting(key)
   * throws on an empty one), every change through core.act, the existing object
   * looked up first — also in a dry run — and left alone. REST calls go through
   * core.http with the account in the configuration element, instead of a REST
   * host object, so the package imports and runs with nothing else set up.
   */
  readonly pkg: { readonly settings: readonly VroConfigAttribute[]; readonly body: readonly string[] };
}

/** Basic authorization from two settings, for a REST API that takes it. */
/**
 * An IPv6 address in full form (eight groups of four), or null when it is not
 * one: to validate the input and to compare it with what the DNS API lists,
 * which may compress it differently. Plain ES5 for Orchestrator.
 */
const V6_FULL =
  'function v6Full(s) { var p = String(s).toLowerCase().split("::"); if (p.length > 2) return null; var h = p[0] ? p[0].split(":") : []; var t = p.length > 1 && p[1] ? p[1].split(":") : []; if (p.length === 1 ? h.length !== 8 : h.length + t.length > 7) return null; var g = h.slice(); for (var k = h.length + t.length; k < 8; k++) g.push("0"); g = g.concat(t); for (var i = 0; i < 8; i++) { if (!/^[0-9a-f]{1,4}$/.test(g[i])) return null; g[i] = ("000" + g[i]).slice(-4); } return g.join(":"); }';

const basicFrom = (user: string, password: string) =>`var auth = { "Authorization": "Basic " + core.base64(String(setting(${q(user)})) + ":" + String(setting(${q(password)}))) };`;

const WORKFLOW_TASKS: Readonly<Record<string, WorkflowTask>> = {
  'ad-computer': {
    label: 'Create AD computer object',
    about: 'Pre-creates the computer account in a named OU, so a machine joins the domain into the right place with the right GPOs rather than into Computers.',
    inputs: [
      { name: 'computerName', type: 'string', description: 'NetBIOS name, 15 characters or fewer.' },
      { name: 'ouDn', type: 'string', description: 'Distinguished name of the target OU.' },
    ],
    outputs: [{ name: 'computerDn', type: 'string', description: 'Distinguished name of the created (or existing) computer object.' }],
    settings: [
      { key: 'allowedOuSuffix', type: 'string', description: 'Every OU must end with this. Stops a request creating objects anywhere in the directory.', example: 'OU=Servers,DC=example,DC=com' },
    ],
    act: [
      'if (computerName.length > 15) throw "Computer name is longer than 15 characters: " + computerName;',
      'var suffix = setting("allowedOuSuffix");',
      'if (!ouDn || ouDn.toLowerCase().indexOf(suffix.toLowerCase(), ouDn.length - suffix.length) < 0) {',
      '  throw "OU " + ouDn + " is outside " + suffix + " — refusing.";',
      '}',
      '',
      '// VERIFY: the search and create calls below against your Active Directory',
      '// plugin version. The library workflow "Create a computer in an',
      '// organizational unit" shows the exact call it uses.',
      'var existing = ActiveDirectory.searchExactMatch("ComputerAD", computerName);',
      'if (existing && existing.length > 0) {',
      '  System.warn("Computer " + computerName + " already exists; returning it unchanged.");',
      '  computerDn = existing[0].distinguishedName;',
      '} else {',
      '  var ous = ActiveDirectory.searchExactMatch("OrganizationalUnit", ouDn.split(",")[0].replace(/^OU=/i, ""));',
      '  var ou = null;',
      '  for (var i = 0; i < ous.length; i++) { if (ous[i].distinguishedName == ouDn) ou = ous[i]; }',
      '  if (!ou) throw "OU not found: " + ouDn;',
      '  checkDeadline();',
      '  ou.createComputerAD(computerName);',
      '  computerDn = "CN=" + computerName + "," + ouDn;',
      '  System.log("Created " + computerDn);',
      '}',
    ],
    wouldDo: '"DRY RUN: would create computer " + computerName + " in " + ouDn',
    undo: 'Delete the computer object from the OU. If the machine has already joined, disjoin it first or it keeps a stale secure channel.',
    scope: 'Computer objects under the OU suffix set in the configuration element',
    pkg: {
      settings: [{ name: 'allowedOuSuffix', type: 'string', value: '', description: 'Every OU must end with this, e.g. OU=Servers,DC=example,DC=com. Stops a request creating objects anywhere in the directory.' }],
      body: [
        'if (String(computerName).length > 15) throw new Error("Computer name is longer than 15 characters: " + computerName);',
        'var suffix = String(setting("allowedOuSuffix")).toLowerCase();',
        'var ouLower = String(ouDn).toLowerCase();',
        'if (ouLower.length < suffix.length || ouLower.substring(ouLower.length - suffix.length) !== suffix) throw new Error("OU " + ouDn + " is outside " + setting("allowedOuSuffix") + "; refusing.");',
        '// VERIFY: searchExactMatch and createComputerAD against your Active Directory',
        '// plugin version; the library workflow "Create a computer in an organizational',
        '// unit" shows the call it uses.',
        'var existing = ActiveDirectory.searchExactMatch("ComputerAD", computerName);',
        'if (existing && existing.length > 0) {',
        '  System.log("Exists, left as it is: computer " + computerName + " (" + existing[0].distinguishedName + ")");',
        '  computerDn = String(existing[0].distinguishedName);',
        '} else {',
        '  var ous = ActiveDirectory.searchExactMatch("OrganizationalUnit", String(ouDn).split(",")[0].replace(/^OU=/i, "")) || [];',
        '  var ou = null;',
        '  for (var i = 0; i < ous.length; i++) { if (String(ous[i].distinguishedName).toLowerCase() === ouLower) ou = ous[i]; }',
        '  if (!ou) throw new Error("OU not found: " + ouDn);',
        '  checkDeadline();',
        '  core.act(ctx, "create computer " + computerName + " in " + ouDn, function () { ou.createComputerAD(computerName); return true; });',
        '  computerDn = ctx.dryRun ? "" : "CN=" + computerName + "," + ouDn;',
        '}',
      ],
    },
  },
  'dns-record': {
    label: 'Register DNS record',
    about: 'Creates an A record for an IPv4 address or an AAAA record for an IPv6 one (and the PTR if the DNS API does it for you) through the DNS or IPAM REST API, so a machine is resolvable before anybody tries to reach it.',
    inputs: [
      { name: 'hostname', type: 'string', description: 'Short host name.' },
      { name: 'zone', type: 'string', description: 'DNS zone, e.g. example.com.' },
      { name: 'ipAddress', type: 'string', description: 'IPv4 address (A record) or IPv6 address (AAAA record).' },
    ],
    outputs: [{ name: 'fqdn', type: 'string', description: 'The name that was registered.' }],
    settings: [
      { key: 'dnsRestHost', type: 'REST:RESTHost', description: 'The DNS or IPAM API, added once with "Add a REST host". Its authentication lives on the host object, not in this script.', example: '(a REST host in the inventory)' },
      { key: 'recordPath', type: 'string', description: 'Path the A record is POSTed to. Infoblox WAPI, for example, is /wapi/v2.12/record:a.', example: '/wapi/v2.12/record:a' },
      { key: 'recordPathV6', type: 'string', description: 'Path the AAAA record is POSTed to, for an IPv6 address. Infoblox WAPI, for example, is /wapi/v2.12/record:aaaa.', example: '/wapi/v2.12/record:aaaa' },
      { key: 'allowedZones', type: 'string', description: 'Comma-separated zones this workflow may write to.', example: 'example.com, lab.example.com' },
    ],
    act: [
      'var zones = setting("allowedZones").split(",").map(function (z) { return z.trim().toLowerCase(); });',
      'if (zones.indexOf(zone.toLowerCase()) < 0) throw "Zone " + zone + " is not in allowedZones — refusing.";',
      V6_FULL,
      'var v6 = String(ipAddress).indexOf(":") >= 0;',
      'if (v6 ? !v6Full(ipAddress) : !/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(ipAddress)) throw "Not an IPv4 or IPv6 address: " + ipAddress;',
      'fqdn = hostname + "." + zone;',
      '',
      'var host = RESTHostManager.createTransientHostFrom(setting("dnsRestHost"));',
      'host.operationTimeout = TIMEOUT_SECONDS;',
      '// Infoblox WAPI: record:a takes ipv4addr, record:aaaa takes ipv6addr.',
      'var body = JSON.stringify(v6 ? { name: fqdn, ipv6addr: ipAddress } : { name: fqdn, ipv4addr: ipAddress });',
      'checkDeadline();',
      'var request = host.createRequest("POST", setting(v6 ? "recordPathV6" : "recordPath"), body);',
      'request.contentType = "application/json";',
      'var response = request.execute();',
      'if (response.statusCode >= 300) throw "DNS API returned " + response.statusCode + ": " + response.contentAsString;',
      'System.log("Registered " + fqdn + " -> " + ipAddress);',
    ],
    wouldDo: '"DRY RUN: would register " + hostname + "." + zone + " -> " + ipAddress',
    undo: 'Delete the A or AAAA record (and PTR) through the same API. A stale record is how the next machine with that IP gets the wrong name.',
    scope: 'Records in the zones listed in the configuration element',
    pkg: {
      settings: [
        { name: 'dnsBaseUrl', type: 'string', value: '', description: 'The DNS or IPAM API, https://host[:port]' },
        { name: 'dnsUsername', type: 'string', value: '', description: 'An account that may create records in the allowed zones' },
        { name: 'dnsPassword', type: 'SecureString', description: 'Its password (sent as Basic authorization)' },
        { name: 'lookupPath', type: 'string', value: '/wapi/v2.12/record:a?name={name}', description: 'GET path listing the A records of a name, {name} replaced; answers a JSON array (Infoblox WAPI shown — VERIFY yours)' },
        { name: 'recordPath', type: 'string', value: '/wapi/v2.12/record:a', description: 'POST path creating an A record from {name, ipv4addr} (Infoblox WAPI shown — VERIFY yours)' },
        { name: 'lookupPathV6', type: 'string', value: '/wapi/v2.12/record:aaaa?name={name}', description: 'GET path listing the AAAA records of a name, for an IPv6 address (Infoblox WAPI shown — VERIFY yours)' },
        { name: 'recordPathV6', type: 'string', value: '/wapi/v2.12/record:aaaa', description: 'POST path creating an AAAA record from {name, ipv6addr} (Infoblox WAPI shown — VERIFY yours)' },
        { name: 'allowedZones', type: 'string', value: '', description: 'Comma-separated zones this workflow may write to, e.g. example.com, lab.example.com' },
      ],
      body: [
        'var zones = String(setting("allowedZones")).toLowerCase().split(",");',
        'var zoneOk = false;',
        'for (var z = 0; z < zones.length; z++) { if (zones[z].replace(/^\\s+|\\s+$/g, "") === String(zone).toLowerCase()) zoneOk = true; }',
        'if (!zoneOk) throw new Error("Zone " + zone + " is not in allowedZones; refusing.");',
        V6_FULL,
        '// An IPv6 address is an AAAA record (ipv6addr), an IPv4 one an A record (ipv4addr).',
        'var v6 = String(ipAddress).indexOf(":") >= 0;',
        'if (v6 ? !v6Full(ipAddress) : !/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(String(ipAddress))) throw new Error("Not an IPv4 or IPv6 address: " + ipAddress);',
        'var kind = v6 ? "AAAA" : "A";',
        'fqdn = hostname + "." + zone;',
        'var base = String(setting("dnsBaseUrl")).replace(/\\/+$/, "");',
        basicFrom('dnsUsername', 'dnsPassword'),
        'var found = core.http("GET", base + String(setting(v6 ? "lookupPathV6" : "lookupPath")).split("{name}").join(encodeURIComponent(fqdn)), auth, null, SAFE).body;',
        'var records = Object.prototype.toString.call(found) === "[object Array]" ? found : (found && found.result ? found.result : []);',
        'if (records.length > 0) {',
        '  var same = false;',
        '  // IPv6 is compared in full form: the API may list it compressed differently.',
        '  for (var r = 0; r < records.length; r++) { if (v6 ? v6Full(records[r].ipv6addr) === v6Full(ipAddress) : String(records[r].ipv4addr) === String(ipAddress)) same = true; }',
        '  if (!same) throw new Error(fqdn + " already resolves to another address; refusing to add a second " + kind + " record. Correct it by hand.");',
        '  System.log("Exists, left as it is: " + fqdn + " -> " + ipAddress);',
        '} else {',
        '  checkDeadline();',
        '  core.act(ctx, "register " + kind + " " + fqdn + " -> " + ipAddress, function () { return core.http("POST", base + String(setting(v6 ? "recordPathV6" : "recordPath")), auth, v6 ? { name: fqdn, ipv6addr: String(ipAddress) } : { name: fqdn, ipv4addr: String(ipAddress) }, SAFE); });',
        '}',
      ],
    },
  },
  'backup-job': {
    label: 'Add VM to backup job',
    about: 'Adds the new machine to an existing backup job through the backup server’s REST API, so it is protected from its first night rather than from the first audit.',
    inputs: [
      { name: 'vmName', type: 'string', description: 'The VM name as vCenter shows it.' },
      { name: 'jobName', type: 'string', description: 'The backup job to add it to.' },
    ],
    outputs: [{ name: 'jobId', type: 'string', description: 'Id of the job the VM was added to.' }],
    settings: [
      { key: 'backupRestHost', type: 'REST:RESTHost', description: 'The backup server API, added with "Add a REST host". Authentication lives on the host object.', example: '(a REST host in the inventory)' },
      { key: 'addPath', type: 'string', description: 'Path template for adding a VM to a job, with {job} in it. Check it against your backup product’s API reference.', example: '/api/v1/jobs/{job}/includes' },
      { key: 'allowedJobs', type: 'string', description: 'Comma-separated job names this workflow may modify.', example: 'Tier2-Nightly, Tier3-Weekly' },
    ],
    act: [
      'var jobs = setting("allowedJobs").split(",").map(function (j) { return j.trim(); });',
      'if (jobs.indexOf(jobName) < 0) throw "Job " + jobName + " is not in allowedJobs — refusing.";',
      '',
      'var host = RESTHostManager.createTransientHostFrom(setting("backupRestHost"));',
      'host.operationTimeout = TIMEOUT_SECONDS;',
      'var path = setting("addPath").replace("{job}", encodeURIComponent(jobName));',
      'checkDeadline();',
      'var request = host.createRequest("POST", path, JSON.stringify({ name: vmName, type: "VirtualMachine" }));',
      'request.contentType = "application/json";',
      'var response = request.execute();',
      'if (response.statusCode >= 300) throw "Backup API returned " + response.statusCode + ": " + response.contentAsString;',
      'jobId = jobName;',
      'System.log("Added " + vmName + " to " + jobName);',
    ],
    wouldDo: '"DRY RUN: would add " + vmName + " to backup job " + jobName',
    undo: 'Remove the VM from the job in the backup product. Restore points already taken stay until retention removes them.',
    scope: 'Backup jobs listed in the configuration element',
    pkg: {
      settings: [
        { name: 'backupBaseUrl', type: 'string', value: '', description: 'The backup server API, https://host[:port]' },
        { name: 'backupUsername', type: 'string', value: '', description: 'An account that may change the allowed jobs' },
        { name: 'backupPassword', type: 'SecureString', description: 'Its password (sent as Basic authorization)' },
        { name: 'listPath', type: 'string', value: '/api/v1/jobs/{job}/includes', description: 'GET path listing what a job includes, {job} replaced; items with a name (VERIFY against your backup product)' },
        { name: 'addPath', type: 'string', value: '/api/v1/jobs/{job}/includes', description: 'POST path adding {name, type} to a job, {job} replaced (VERIFY against your backup product)' },
        { name: 'allowedJobs', type: 'string', value: '', description: 'Comma-separated job names this workflow may modify' },
      ],
      body: [
        'var jobs = String(setting("allowedJobs")).split(",");',
        'var jobOk = false;',
        'for (var j = 0; j < jobs.length; j++) { if (jobs[j].replace(/^\\s+|\\s+$/g, "") === String(jobName)) jobOk = true; }',
        'if (!jobOk) throw new Error("Job " + jobName + " is not in allowedJobs; refusing.");',
        'var base = String(setting("backupBaseUrl")).replace(/\\/+$/, "");',
        basicFrom('backupUsername', 'backupPassword'),
        'var listed = core.http("GET", base + String(setting("listPath")).split("{job}").join(encodeURIComponent(jobName)), auth, null, SAFE).body;',
        'var members = Object.prototype.toString.call(listed) === "[object Array]" ? listed : (listed && (listed.data || listed.content || listed.items)) || [];',
        'var included = false;',
        'for (var m = 0; m < members.length; m++) { if (String(members[m].name) === String(vmName)) included = true; }',
        'if (included) {',
        '  System.log("Exists, left as it is: " + vmName + " is already in " + jobName);',
        '} else {',
        '  checkDeadline();',
        '  core.act(ctx, "add " + vmName + " to backup job " + jobName, function () { return core.http("POST", base + String(setting("addPath")).split("{job}").join(encodeURIComponent(jobName)), auth, { name: String(vmName), type: "VirtualMachine" }, SAFE); });',
        '}',
        'jobId = String(jobName);',
      ],
    },
  },
  custom: {
    label: 'Custom — your own inputs, outputs and settings',
    about: 'An empty scaffold with the parts that are always missing already in place: dry run, deadline, configuration element, a failure path.',
    inputs: [{ name: 'target', type: 'string', description: 'Whatever the workflow acts on.' }],
    outputs: [{ name: 'result', type: 'string', description: 'What it did.' }],
    settings: [{ key: 'exampleSetting', type: 'string', description: 'Replace with the settings your workflow needs. Hosts, paths and allow-lists go here, not in the script.', example: 'value' }],
    act: [
      '// TODO: the work. Call checkDeadline() between steps that can be slow.',
      'var example = setting("exampleSetting");',
      'result = "acted on " + target + " using " + example;',
      'System.log(result);',
    ],
    wouldDo: '"DRY RUN: would act on " + target',
    undo: 'Whatever reverses the work you add. Write it here before the workflow goes into a subscription.',
    scope: 'Whatever the workflow body touches — define it before release',
    pkg: {
      settings: [{ name: 'exampleSetting', type: 'string', value: 'value', description: 'Replace with the settings your workflow needs. Hosts, paths and allow-lists go here, not in the script.' }],
      body: [
        '// TODO: the work. Look up what exists first (also in a dry run), then make',
        '// each change inside core.act. Call checkDeadline() between slow steps.',
        'var example = setting("exampleSetting");',
        'core.act(ctx, "act on " + target, function () { return true; });',
        'result = ctx.dryRun ? "" : "acted on " + target + " using " + example;',
      ],
    },
  },
};

/** The custom task from the rows on the page: the same scaffold, with your parameters and settings. */
function customTask(rows: ReturnType<typeof customRows>): WorkflowTask {
  const first = rows.inputs[0]?.name;
  const target = first ? first : '"(no input)"';
  const reads = rows.attributes.map((a) => `var ${a.key} = setting(${JSON.stringify(a.key)});`);
  return {
    label: 'Custom',
    about: 'A workflow of your own, with the parts that are always missing already in place: dry run, deadline, configuration element, a failure path.',
    inputs: rows.inputs,
    outputs: rows.outputs,
    settings: rows.attributes.map((a) => ({ key: a.key, type: a.type, description: a.description, example: a.value })),
    act: ['// TODO: the work. Call checkDeadline() between steps that can be slow.', ...reads, `System.log("acted on " + ${target});`],
    wouldDo: `"DRY RUN: would act on " + ${target}`,
    undo: 'Whatever reverses the work you add. Write it here before the workflow goes into a subscription or a schedule.',
    scope: 'Whatever the workflow body touches — define it before release',
    pkg: {
      settings: rows.attributes.map((a): VroConfigAttribute => (a.type === 'SecureString' ? { name: a.key, type: 'SecureString', description: a.description } : { name: a.key, type: a.type, value: a.type === 'number' ? Number(a.value) : a.type === 'boolean' ? /^(true|yes|1)$/i.test(a.value) : a.type === 'Array/string' ? a.value.split(',').map((v) => v.trim()).filter(Boolean) : a.value, description: a.description })),
      body: [
        '// TODO: the work. Look up what exists first (also in a dry run), then make',
        '// each change inside core.act. Call checkDeadline() between slow steps.',
        ...reads,
        `core.act(ctx, "act on " + ${target}, function () { return true; });`,
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator action sources

interface ActionSource {
  readonly label: string;
  readonly defaultName: string;
  readonly field: string;
  readonly fieldLabel: string;
  readonly inputs: readonly { name: string; type: string; description: string }[];
  readonly body: readonly string[];
  readonly calls: string;
  /** The same list in the package action: setting(key), core, SAFE, LIMIT and result in scope. */
  readonly pkg: { readonly settings: readonly VroConfigAttribute[]; readonly body: readonly string[] };
}

const ACTION_SOURCES: Readonly<Record<string, ActionSource>> = {
  'ad-ous': {
    label: 'List AD organisational units',
    defaultName: 'listADOUs',
    field: 'ouDn',
    fieldLabel: 'Organisational unit',
    inputs: [{ name: 'filter', type: 'string', description: 'Substring to match, or empty for all under the base.' }],
    body: [
      '// VERIFY: ActiveDirectory.search against your AD plugin version.',
      'var base = setting("ouBase");',
      'var ous = ActiveDirectory.search("OrganizationalUnit", filter || "");',
      'for (var i = 0; i < ous.length && result.length < LIMIT; i++) {',
      '  var dn = ous[i].distinguishedName;',
      '  if (dn.toLowerCase().indexOf(base.toLowerCase()) >= 0) result.push(dn);',
      '}',
      'result.sort();',
    ],
    calls: 'Active Directory, through the AD plugin',
    pkg: {
      settings: [{ name: 'ouBase', type: 'string', value: '', description: 'Only OUs under this distinguished name are offered, e.g. OU=Servers,DC=example,DC=com' }],
      body: [
        '// VERIFY: ActiveDirectory.search against your AD plugin version.',
        'var base = String(setting("ouBase")).toLowerCase();',
        'var ous = ActiveDirectory.search("OrganizationalUnit", filter || "") || [];',
        'for (var i = 0; i < ous.length && result.length < LIMIT; i++) {',
        '  var dn = String(ous[i].distinguishedName);',
        '  if (dn.toLowerCase().indexOf(base) >= 0) result.push(dn);',
        '}',
        'result.sort();',
      ],
    },
  },
  'ipam-vlans': {
    label: 'List VLANs from IPAM',
    defaultName: 'listIpamVlans',
    field: 'vlan',
    fieldLabel: 'VLAN',
    inputs: [{ name: 'site', type: 'string', description: 'Site or network view to list VLANs for.' }],
    body: [
      'var host = RESTHostManager.createTransientHostFrom(setting("ipamRestHost"));',
      'host.operationTimeout = TIMEOUT_SECONDS;',
      'var path = setting("vlanPath").replace("{site}", encodeURIComponent(site || ""));',
      'var response = host.createRequest("GET", path, null).execute();',
      'if (response.statusCode >= 300) throw "IPAM returned " + response.statusCode;',
      'var vlans = JSON.parse(response.contentAsString);',
      '// Adjust to the shape your IPAM returns; this expects [{ id, name }].',
      'for (var i = 0; i < vlans.length && result.length < LIMIT; i++) {',
      '  result.push(vlans[i].id + " - " + vlans[i].name);',
      '}',
    ],
    calls: 'The IPAM REST API, through a REST host',
    pkg: {
      settings: [
        { name: 'ipamBaseUrl', type: 'string', value: '', description: 'The IPAM API, https://host[:port]' },
        { name: 'ipamUsername', type: 'string', value: '', description: 'A read-only IPAM account' },
        { name: 'ipamPassword', type: 'SecureString', description: 'Its password (sent as Basic authorization)' },
        { name: 'vlanPath', type: 'string', value: '/api/vlans?site={site}', description: 'GET path listing the VLANs of a site, {site} replaced; answers [{ id, name }] (VERIFY against your IPAM)' },
      ],
      body: [
        'var auth = { "Authorization": "Basic " + core.base64(String(setting("ipamUsername")) + ":" + String(setting("ipamPassword"))) };',
        'var path = String(setting("vlanPath")).split("{site}").join(encodeURIComponent(site || ""));',
        'var answer = core.http("GET", String(setting("ipamBaseUrl")).replace(/\\/+$/, "") + path, auth, null, SAFE).body;',
        '// Adjust to the shape your IPAM returns; this takes [{ id, name }], or { data: [...] }.',
        'var vlans = Object.prototype.toString.call(answer) === "[object Array]" ? answer : (answer && answer.data) || [];',
        'for (var i = 0; i < vlans.length && result.length < LIMIT; i++) result.push(vlans[i].id + " - " + vlans[i].name);',
      ],
    },
  },
  'vm-folders': {
    label: 'List vCenter VM folders',
    defaultName: 'listVmFolders',
    field: 'folder',
    fieldLabel: 'VM folder',
    inputs: [{ name: 'filter', type: 'string', description: 'Substring to match on the folder name.' }],
    body: [
      '// VERIFY: VcPlugin.getAllVmFolders signature against your vCenter plugin version.',
      'var folders = VcPlugin.getAllVmFolders(null, null);',
      'for (var i = 0; i < folders.length && result.length < LIMIT; i++) {',
      '  if (!filter || folders[i].name.toLowerCase().indexOf(filter.toLowerCase()) >= 0) result.push(folders[i].name);',
      '}',
      'result.sort();',
    ],
    calls: 'vCenter, through the vCenter plugin',
    pkg: {
      settings: [],
      body: [
        '// VERIFY: VcPlugin.getAllVmFolders signature against your vCenter plugin version.',
        'var folders = VcPlugin.getAllVmFolders(null, null) || [];',
        'for (var i = 0; i < folders.length && result.length < LIMIT; i++) {',
        '  if (!filter || String(folders[i].name).toLowerCase().indexOf(String(filter).toLowerCase()) >= 0) result.push(String(folders[i].name));',
        '}',
        'result.sort();',
      ],
    },
  },
  custom: {
    label: 'Custom — your own list and inputs',
    defaultName: 'listOptions',
    field: 'choice',
    fieldLabel: 'Choice',
    inputs: [{ name: 'filter', type: 'string', description: 'Whatever narrows the list.' }],
    body: ['// TODO: fill result from wherever the answers live.', 'result.push("option-a");', 'result.push("option-b");'],
    calls: 'Whatever you write in the body',
    pkg: { settings: [], body: ['// TODO: fill result from wherever the answers live.', 'result.push("option-a");', 'result.push("option-b");'] },
  },
};

// ---------------------------------------------------------------------------
// Day-2 action sets

const OPERATE_ACTIONS = [
  'Deployment.PowerOn',
  'Deployment.PowerOff',
  'Cloud.vSphere.Machine.PowerOn',
  'Cloud.vSphere.Machine.PowerOff',
  'Cloud.vSphere.Machine.Reboot',
  'Cloud.vSphere.Machine.Shutdown',
  'Cloud.vSphere.Machine.Remote.Console',
];
const STANDARD_ACTIONS = [
  ...OPERATE_ACTIONS,
  'Cloud.vSphere.Machine.Snapshot.Create',
  'Cloud.vSphere.Machine.Snapshot.Revert',
  'Cloud.vSphere.Machine.Snapshot.Delete',
  'Deployment.ChangeLease',
  'Deployment.EditTags',
];

// ---------------------------------------------------------------------------
// Custom resource types

interface CustomType {
  readonly label: string;
  readonly externalType: string;
  readonly properties: Readonly<Record<string, { type: string; title: string; example: string }>>;
  readonly what: string;
  readonly deleteMeans: string;
}

const CUSTOM_TYPES: Readonly<Record<string, CustomType>> = {
  'Custom.ADUser': {
    label: 'AD user',
    externalType: 'AD:User',
    properties: {
      accountName: { type: 'string', title: 'Account name (sAMAccountName)', example: 'svc-app01' },
      ouDn: { type: 'string', title: 'Organisational unit', example: 'OU=Service Accounts,DC=example,DC=com' },
      displayName: { type: 'string', title: 'Display name', example: 'App01 service account' },
    },
    what: 'Active Directory user accounts',
    deleteMeans: 'Deleting an AD user loses its SID. Recreating it with the same name is a different principal, and every ACL that named the old one is now wrong.',
  },
  'Custom.DNSRecord': {
    label: 'DNS record',
    externalType: '<REQUIRED — a Dynamic Types type, e.g. DynamicTypes:DNS.Record, or use ABX backing>',
    properties: {
      hostname: { type: 'string', title: 'Host name', example: 'app01' },
      zone: { type: 'string', title: 'Zone', example: 'example.com' },
      ipAddress: { type: 'string', title: 'IPv4 or IPv6 address', example: '10.0.10.21' },
    },
    what: 'DNS A and AAAA records in the allowed zones',
    deleteMeans: 'A deleted record can be recreated, but anything that cached the old answer keeps it until the TTL runs out.',
  },
  'Custom.BackupJob': {
    label: 'Backup job',
    externalType: '<REQUIRED — a Dynamic Types type, e.g. DynamicTypes:Backup.Job, or use ABX backing>',
    properties: {
      jobName: { type: 'string', title: 'Job name', example: 'App01-Nightly' },
      schedule: { type: 'string', title: 'Schedule', example: 'daily 22:00' },
      retentionDays: { type: 'integer', title: 'Retention (days)', example: '30' },
    },
    what: 'Backup jobs on the backup server',
    deleteMeans: 'Deleting a backup job may delete its restore points, depending on the product. Check before wiring delete to deployment deletion.',
  },
};

export const VCF_AUTOMATION_EXTEND: readonly AutomationBlueprint[] = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_orchestrator_workflow',
    platform: PLATFORM,
    label: 'An Orchestrator workflow with a dry run and a failure path',
    group: 'Orchestrator',
    description:
      'The scriptable task most Orchestrator workflows are, written the way they rarely are: settings read from a configuration element instead of hard-coded hosts, a dryRun input, a deadline, System.log on the way through and System.error on the way out, and a failure that says what it was doing. Emitted as the script, a description of the workflow’s inputs and outputs, and the steps to build and export it.',
    inputs: [
      { id: 'workflow_name', label: 'Workflow name', control: 'text', default: 'Create AD computer object' },
      {
        id: 'task',
        label: 'Does',
        control: 'select',
        options: Object.entries(WORKFLOW_TASKS).map(([value, task]) => ({ value, label: task.label })),
        default: 'ad-computer',
      },
      { id: 'folder', label: 'Workflow folder', control: 'text', default: 'Automation/Infrastructure' },
      { id: 'config_path', label: 'Configuration element', control: 'text', default: 'Automation/Infrastructure/Settings', hint: 'Category path and element name. Hosts and allow-lists go here' },
      { id: 'use_config', label: 'Read settings from the configuration element', control: 'toggle', default: true, hint: 'Off writes them into the script — see the finding' },
      { id: 'timeout_seconds', label: 'Give up after (seconds)', control: 'number', default: 300, min: 0, max: 3600, hint: '0 means no deadline' },
      { id: 'dry_run_input', label: 'Add a dryRun input', control: 'toggle', default: true },
      ...GENERIC_WORKFLOW_INPUTS,
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const workflowName = str(values, 'workflow_name', 'Orchestrator workflow');
      const taskId = str(values, 'task', 'ad-computer');
      const custom = taskId === 'custom' ? customRows(values) : undefined;
      const task = custom ? customTask(custom) : WORKFLOW_TASKS[taskId] ?? WORKFLOW_TASKS['custom']!;
      const folder = str(values, 'folder', 'Automation');
      const configPath = str(values, 'config_path', 'Automation/Settings');
      const useConfig = bool(values, 'use_config', true);
      const timeout = num(values, 'timeout_seconds', 300);
      const hasDryRun = bool(values, 'dry_run_input', true);
      const base = slugOf(name || workflowName, 'workflow');
      const [category, element] = (() => {
        const parts = configPath.split('/');
        const last = parts.pop() ?? 'Settings';
        return [parts.join('/') || 'Automation', last];
      })();

      const findings: Finding[] = [...(custom?.findings ?? [])];
      if (timeout === 0) {
        findings.push(
          warning('vcfa.vro.no-timeout', 'This workflow has no deadline, so a hung API call holds the workflow — and whatever deployment waits on it — until somebody cancels it.', {
            remediation: 'Give it a deadline. On a blocking subscription, the subscription timeout is the backstop; this is the one you choose.',
            source: SRC,
          }),
        );
      }
      if (!useConfig) {
        findings.push(
          warning('vcfa.vro.hardcoded-settings', 'Hosts, paths and allow-lists are written into the script.', {
            remediation: 'A script with a host name in it is edited for every environment and diverges between them. Put settings in a configuration element and export it with the package.',
            source: SRC,
          }),
        );
      }
      if (!hasDryRun) {
        findings.push(
          warning('vcfa.vro.no-dry-run', 'There is no dryRun input, so the only way to test this workflow is to let it act.', {
            remediation: 'A boolean input, default true, that logs what it would do and returns. Callers that mean it set it to false.',
            source: SRC,
          }),
        );
      }

      const inputNames = [...task.inputs.map((input) => input.name), ...(hasDryRun ? ['dryRun'] : [])];
      const settingLines = useConfig
        ? [
            `var CATEGORY_PATH = ${JSON.stringify(category)};`,
            `var ELEMENT_NAME = ${JSON.stringify(element)};`,
            '',
            '/** Read one attribute from the configuration element. Throws if it is missing. */',
            'function setting(key) {',
            '  var category = Server.getConfigurationElementCategoryWithPath(CATEGORY_PATH);',
            '  if (!category) throw "Configuration element category not found: " + CATEGORY_PATH;',
            '  var elements = category.allConfigurationElements;',
            '  for (var i = 0; i < elements.length; i++) {',
            '    if (elements[i].name == ELEMENT_NAME) {',
            '      var attribute = elements[i].getAttributeWithKey(key);',
            '      if (!attribute || attribute.value === null) throw "Setting " + key + " is empty in " + CATEGORY_PATH + "/" + ELEMENT_NAME;',
            '      return attribute.value;',
            '    }',
            '  }',
            '  throw "Configuration element not found: " + CATEGORY_PATH + "/" + ELEMENT_NAME;',
            '}',
          ]
        : [
            '// Settings written into the script. Every environment needs its own copy of',
            '// this file, which is the problem — see the README.',
            'var SETTINGS = {',
            ...task.settings.map((s) => `  ${s.key}: ${s.type.startsWith('REST:') ? `null, // ${s.type}: bind as a workflow attribute` : JSON.stringify(s.example)},`),
            '};',
            'function setting(key) {',
            '  if (SETTINGS[key] === undefined || SETTINGS[key] === null) throw "Setting " + key + " is not set";',
            '  return SETTINGS[key];',
            '}',
          ];

      const script = [
        '/**',
        ` * ${workflowName}`,
        ' *',
        ' * Scriptable task',
        ' * VCF Automation Orchestrator.',
        ` * ${task.about}`,
        ' *',
        ` * Inputs:  ${inputNames.join(', ')}`,
        ` * Outputs: ${task.outputs.map((output) => output.name).join(', ')}`,
        ' *',
        useConfig
          ? ` * Settings come from the configuration element ${configPath}. No host name`
          : ' * Settings are written below. Move them to a configuration element.',
        ' * and no credential is written here: REST hosts carry their own authentication',
        ' * and anything secret is a SecureString attribute or input.',
        ' */',
        '',
        `var TIMEOUT_SECONDS = ${timeout};`,
        'var started = new Date().getTime();',
        '',
        '/** Throw rather than carry on past the deadline. Call between slow steps. */',
        'function checkDeadline() {',
        '  if (TIMEOUT_SECONDS > 0 && new Date().getTime() - started > TIMEOUT_SECONDS * 1000) {',
        `    throw "Deadline of " + TIMEOUT_SECONDS + "s passed in ${workflowName}";`,
        '  }',
        '}',
        '',
        ...settingLines,
        '',
        ...task.outputs.map((output) => `${output.name} = null;`),
        '',
        'try {',
        ...task.inputs.map((input) => `  if (!${input.name}) throw "Input ${input.name} is required";`),
        '',
        ...(hasDryRun
          ? [
              '  if (dryRun !== false) {',
              `    System.log(${task.wouldDo});`,
              '    System.log("dryRun is not false, so nothing was changed.");',
              '  } else {',
              ...task.act.map((line) => (line ? `    ${line}` : '')),
              '  }',
            ]
          : task.act.map((line) => (line ? `  ${line}` : ''))),
        `  System.log("${workflowName}: finished in " + (new Date().getTime() - started) + " ms");`,
        '} catch (e) {',
        '  // The failure path. Log what it was doing and with what, then rethrow so',
        '  // the workflow ends in failure and the caller — a subscription, a day-2',
        '  // action — sees it. Swallowing it here is how a failed step reports success.',
        `  System.error("${workflowName} failed: " + e);`,
        ...task.inputs.map((input) => `  System.error("  ${input.name} = " + ${input.name});`),
        '  throw e;',
        '}',
        '',
      ].join('\n');

      const description = {
        name: workflowName,
        folder,
        version: '1.0.0',
        description: `${task.about}`,
        inputs: [
          ...task.inputs,
          ...(hasDryRun ? [{ name: 'dryRun', type: 'boolean', default: true, description: 'Log what would happen and change nothing. Callers that mean it pass false.' }] : []),
        ],
        outputs: task.outputs,
        configurationElement: useConfig
          ? { path: category, name: element, attributes: task.settings.map((s) => ({ key: s.key, type: s.type, description: s.description, example: s.example })) }
          : null,
        schema: [
          'Start',
          `Scriptable task "${task.label}" — paste ${base}.js; bind every input and output above`,
          'End (success)',
          'Default error handler → End (failure). The script already logs; the handler makes the failure visible to the caller.',
        ],
      };

      const importSteps = [
        `# Building "${workflowName}" in Orchestrator`,
        '',
        'IMPORT.md and import/import-orchestrator.sh build this workflow into a .workflow',
        'file and import it for you. These are the steps to build it by hand instead.',
        '',
        `1. Log in to the Orchestrator client (https://<vcf-automation>/orchestration-ui) as a workflow designer.`,
        ...(useConfig
          ? [
              `2. Assets → Configurations → New configuration: folder "${category}", name "${element}".`,
              `   Add the attributes listed under configurationElement in ${base}-workflow.json.`,
              '   REST host attributes are picked from the inventory after "Add a REST host" has run once.',
            ]
          : ['2. (No configuration element — settings are in the script. See the README finding.)']),
        `3. Library → Workflows → New workflow in folder "${folder}", named "${workflowName}".`,
        `4. Variables tab: add the inputs and outputs from ${base}-workflow.json, with the types shown.`,
        ...(hasDryRun ? ['   Give dryRun a default value of Yes.'] : []),
        `5. Schema: drag in a Scriptable task, paste ${base}.js, and bind each input and output to it.`,
        '6. Add a Default error handler to the schema, ending in an error end element.',
        '7. Validate, save, and increase the version to 1.0.0.',
        '8. Run it with dryRun = Yes against a real object and read the logs tab.',
        '',
        '## Packaging it',
        '',
        'Assets → Packages → New package. Add the workflow, the configuration element and any',
        'actions it calls. Export it, and commit the .package file beside this one.',
        'Export the configuration element without values if any attribute is a SecureString —',
        'the package otherwise carries the secret, encrypted with a key you then have to share.',
        '',
      ].join('\n');

      const imported = importBundle({
        vroWorkflows: [
          {
            name: workflowName,
            category: folder,
            description: `${task.about}`,
            inputs: [
              ...task.inputs,
              ...(hasDryRun ? [{ name: 'dryRun', type: 'boolean', description: 'Log what would happen and change nothing. Anything but false is a dry run.' }] : []),
            ],
            outputs: task.outputs,
            script,
            taskName: task.label,
          },
        ],
      });

      // The package: the same task on the core library. Its settings live in a
      // folder of their own (<workflow folder>/<name>), so two generated
      // workflows never share, and overwrite, one configuration element.
      const packageWorkflowName = elementName(workflowName);
      const pkgScript = [
        `var TIMEOUT_SECONDS = ${timeout};`,
        'var started = new Date().getTime();',
        '/** Throw rather than carry on past the deadline. Called between slow steps. */',
        'function checkDeadline() {',
        '  if (TIMEOUT_SECONDS > 0 && new Date().getTime() - started > TIMEOUT_SECONDS * 1000) {',
        `    throw new Error("Deadline of " + TIMEOUT_SECONDS + "s passed in " + ${q(packageWorkflowName)});`,
        '  }',
        '}',
        '/** One setting from the configuration element; an empty one is an error, not a default. */',
        'function setting(key) {',
        '  var value = settings[key];',
        '  if (value === null || value === undefined || value === "") throw new Error("Set " + key + " in the configuration element " + SETTINGS_PATH + "/" + SETTINGS_NAME + ".");',
        '  return value;',
        '}',
        'var SAFE = { redact: settings._secrets, timeout: TIMEOUT_SECONDS > 0 ? TIMEOUT_SECONDS : 60 };',
        `var ctx = core.begin(settings, ${hasDryRun ? 'dryRun' : 'null'});`,
        ...task.outputs.map((output) => `${output.name} = null;`),
        'try {',
        ...task.inputs.map((input) => `  if (!${input.name}) throw new Error("Input ${input.name} is required");`),
        ...task.pkg.body.map((line) => `  ${line}`),
        `  System.log(${q(packageWorkflowName)} + ": finished in " + (new Date().getTime() - started) + " ms");`,
        '} catch (e) {',
        '  // The failure path: say what it was doing and with what, then rethrow so the',
        '  // caller (a subscription, a day-2 action) sees the workflow fail.',
        `  System.error(${q(packageWorkflowName)} + " failed: " + (e && e.message ? e.message : e));`,
        ...task.inputs.map((input) => `  System.error("  ${input.name} = " + ${input.name});`),
        '  throw e;',
        '}',
        `summary = core.audit(ctx, { ${task.outputs.map((output) => `${output.name}: ${output.name}`).join(', ')} });`,
        'core.notify(settings.webhook, summary);',
      ].join('\n');
      const pkg = toPackage({
        packageName: packageNameOf('vcfa', 'workflow', base),
        description: `${workflowName}: ${task.about} On the vcf.automation.core library.`,
        categoryPath: `${folder}/${base}`,
        workflow: {
          name: packageWorkflowName,
          description: `${task.about} Set the dryRun input to true to preview without changing anything; what exists is left as it is.`,
          inputs: [...task.inputs, ...(hasDryRun ? [{ name: 'dryRun', type: 'boolean', description: 'true: report what would change and change nothing' }] : [])],
          outputs: [...task.outputs, { name: 'summary', type: 'string', description: 'The audit record, JSON' }],
          script: pkgScript,
        },
        config: {
          name: element,
          description: `Settings of the ${packageWorkflowName} workflow. Fill the secrets after import; set dryRun to true to preview instead of changing anything.`,
          attributes: [...task.pkg.settings, ...guardSettings(1, 'changed')],
        },
      });

      const extras = workflowExtras(values, { base, name: packageWorkflowName, about: task.about, workflowId: pkg.workflowId, inputs: task.inputs, outputs: task.outputs, attributes: task.settings.map((s) => ({ key: s.key })) });
      findings.push(...extras.findings);

      return {
        platform: PLATFORM,
        title: `${workflowName} — an Orchestrator workflow with a dry run`,
        effect: 'reversible',
        trigger: extras.trigger
          ? { kind: str(values, 'schedule', 'none') !== 'none' && !bool(values, 'subscribe', false) ? 'schedule' : 'request', ...extras.trigger }
          : {
              kind: 'request',
              detail: 'Whatever calls it: a subscription on a deployment event, a custom day-2 action, a catalogue item, or somebody running it from the client',
              worstCase: 'once per machine per deployment, when it is wired to a subscription — every one of a 50-machine bulk request',
            },
        scope: {
          what: `${task.scope}, for the objects named in each run’s inputs.`,
          decidedBy: [
            'The inputs of each run — the workflow acts on what it is given.',
            useConfig ? `The allow-list in ${configPath}, which the script checks before acting.` : 'The settings written in the script.',
            'Whatever calls it, and that caller’s own criteria (a subscription with no criteria calls it for every deployment).',
            'The rights of the account the plugin or REST host authenticates as — the real upper bound.',
          ],
          ifWrong: 'It acts on objects outside the intended OU, zone or job, for every run the caller makes, until somebody reads the logs.',
        },
        guardrails: [
          ...(hasDryRun ? [{ rule: 'dryRun defaults to true', because: 'A workflow that has to be told to act cannot be made to act by a caller that forgot an input.' }] : []),
          ...(useConfig && taskId !== 'custom' ? [{ rule: 'Checks an allow-list from the configuration element before acting', because: 'The service account can usually touch far more than the workflow should. The allow-list is the scope, written where it can be reviewed.' }] : []),
          ...(timeout > 0 ? [{ rule: `Gives up after ${timeout} seconds`, because: 'A hung call otherwise holds the workflow token and anything waiting on it indefinitely.' }] : []),
          { rule: 'Rethrows on failure', because: 'A workflow that logs an error and ends in success is reported as done, and the gap is found at the next audit.' },
        ],
        dryRun: [
          `The package workflow ${packageWorkflowName} previews when run with the dryRun input set to true: it looks up what exists, logs every "DRY RUN: would …" and an AUDIT summary, and changes nothing.`,
          hasDryRun ? 'Run it from the Orchestrator client with dryRun = Yes. It logs what it would do and changes nothing.' : 'There is no dryRun input — run it against a test object, which is the finding.',
          'Then wire it to a subscription with criteria narrowed to one test project before widening it.',
        ],
        undo: [task.undo, 'Orchestrator does not roll back a workflow. What it did stays done when the workflow fails half way through.'],
        told: ['The workflow run’s logs and variables in the Orchestrator client, per run.', 'Forward Orchestrator logs to VCF Operations for Logs if anybody should notice it failing overnight.', ...extras.told],
        requires: [
          PKG_REQUIRES,
          taskId === 'ad-computer' ? 'The Active Directory plugin with a configured AD server, whose account can create computers in the target OU.' : taskId === 'custom' ? 'Whatever your workflow calls.' : 'A REST host added with "Add a REST host", with its own authentication configured.',
          'A workflow designer role in Orchestrator.',
        ],
        files: {
          ...pkg.files,
          [`${base}.js`]: script,
          [`${base}-workflow.json`]: json(description),
          [`${base}-IMPORT.md`]: importSteps,
          ...extras.files,
          ...imported.files,
          'IMPORT.md': importMd({
            subject: `The Orchestrator workflow "${workflowName}", as an Orchestrator package on the vcf.automation.core library (\`${pkg.packageDir}\`), and as the plain scriptable-task workflow it was (\`import/orchestrator/\`) for anybody who would rather build or import it by hand. Use one or the other: the package is the one that reads its settings, guards every change and writes an audit record.`,
            steps: [
              ...packageSteps(pkg),
              ...(useConfig
                ? [
                    manualStep(`Or by hand: configuration element ${configPath}`, [
                      `Only for the plain workflow under \`import/orchestrator/\`: Assets → Configurations → New configuration, folder \`${category}\`, name \`${element}\`, with the attributes listed under configurationElement in \`${base}-workflow.json\`. REST host attributes are picked from the inventory after "Add a REST host" has run once.`,
                      'The plain workflow has no package to bring it, and it holds environment values that should not be generated. The package above brings its own.',
                    ]),
                  ]
                : []),
              orByHand(imported.steps.orchestrator),
              manualStep('Run the plain workflow once', [hasDryRun ? 'Run it from the Orchestrator client with the inputs filled and dryRun left empty or true; read the Logs tab.' : 'Run it against a test object and read the Logs tab.']),
              ...extras.steps,
            ],
            auth: extras.steps.length > 0 ? ['import', 'apply'] : ['import'],
            orgs: 'VCF Automation 9.1 / 9.1.1 (the Orchestrator of a VM Apps organization, or an external VCF Operations orchestrator)',
            verify: [
              ...verifyFor(imported),
              ...(taskId === 'ad-computer' ? ['The Active Directory plugin calls (ActiveDirectory.searchExactMatch, OU.createComputerAD) are as the plugin library workflows use them; VERIFY them against the plugin on your Orchestrator.'] : []),
              ...(taskId === 'dns-record' ? ['The DNS paths default to the Infoblox WAPI (GET record:a?name=, POST record:a {name, ipv4addr}; for an IPv6 address GET record:aaaa?name=, POST record:aaaa {name, ipv6addr}); VERIFY the WAPI version your grid runs, or set lookupPath/recordPath and lookupPathV6/recordPathV6 for your DNS API.'] : []),
              ...(taskId === 'backup-job' ? ['listPath and addPath are placeholders for a backup product REST API; VERIFY both against your product’s API reference before running the workflow.'] : []),
              'The package reads its settings from the configuration element in its own folder (see step 3), not from the path set on the page, which the plain workflow keeps using.',
              ...extras.verify,
            ],
          }),
        },
        notes: [
          ...extras.notes,
          'Orchestrator scripting is Rhino JavaScript (ES5 plus a little). Arrow functions, let and const may not parse depending on the runtime chosen for the task — the scaffold sticks to var and function.',
          'A scriptable task does not time out on its own. The deadline in the script is checked between steps; a single call that hangs is bounded by the REST host’s operation timeout, which the script sets.',
          'Export the package after every change. A workflow that only exists in one Orchestrator is lost with it.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_orchestrator_action',
    platform: PLATFORM,
    label: 'An Orchestrator action behind a form dropdown',
    group: 'Orchestrator',
    description:
      'A reusable Orchestrator action in a module that returns the list a custom form field offers — AD OUs, VLANs from IPAM, VM folders — and the form snippet that calls it as an external value source. Written to be fast and never throw, because it runs every time somebody opens the request form.',
    inputs: [
      { id: 'module', label: 'Module', control: 'text', default: 'com.company.infra', hint: 'Reverse-DNS, lower case' },
      {
        id: 'source',
        label: 'Lists',
        control: 'select',
        options: Object.entries(ACTION_SOURCES).map(([value, source]) => ({ value, label: source.label })),
        default: 'ad-ous',
      },
      { id: 'action_name', label: 'Action name', control: 'text', default: '', placeholder: 'listADOUs', hint: 'Empty uses the usual name for what it lists' },
      { id: 'action_inputs', label: 'Inputs', control: 'textarea', default: 'filter | string | Whatever narrows the list', hint: 'Input | Type | Description', help: 'The parameters the form passes; bind each to a form field (action:module/name(param=field) in a custom form).', showWhen: { input: 'source', equals: ['custom'] } },
      {
        id: 'return_type',
        label: 'Returns',
        control: 'select',
        options: [
          { value: 'Array/string', label: 'Array/string — a dropdown' },
          { value: 'Array/Properties', label: 'Array/Properties — a dropdown of label and value pairs' },
          { value: 'string', label: 'string — a single default value' },
        ],
        default: 'Array/string',
      },
      { id: 'config_path', label: 'Configuration element', control: 'text', default: 'Automation/Infrastructure/Settings' },
      { id: 'limit', label: 'Return at most', control: 'number', default: 200, min: 1, max: 5000 },
      { id: 'timeout_seconds', label: 'Give up after (seconds)', control: 'number', default: 10, min: 1, max: 120, hint: 'The requester is looking at a spinner for this long' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const module = str(values, 'module', 'com.company.infra');
      const sourceId = str(values, 'source', 'ad-ous');
      const actionInputs = rowsOf(str(values, 'action_inputs', ''), 3)
        .filter(([n = '']) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
        .map(([n = '', type = '', description = '']) => ({ name: n, type: type || 'string', description: description || n }));
      const presetSource = ACTION_SOURCES[sourceId] ?? ACTION_SOURCES['custom']!;
      const source = sourceId === 'custom' && actionInputs.length > 0 ? { ...presetSource, inputs: actionInputs } : presetSource;
      const actionName = str(values, 'action_name', source.defaultName).replace(/[^A-Za-z0-9_]/g, '');
      const returnType = str(values, 'return_type', 'Array/string');
      const configPath = str(values, 'config_path', 'Automation/Settings');
      const limit = num(values, 'limit', 200);
      const timeout = num(values, 'timeout_seconds', 10);
      const base = slugOf(name || `${module}-${actionName}`, 'action');
      const parts = configPath.split('/');
      const element = parts.pop() ?? 'Settings';
      const category = parts.join('/') || 'Automation';
      const pairs = returnType === 'Array/Properties';
      const dropdown = returnType === 'Array/string' || pairs;
      // Label and value pairs: each entry of result becomes a Properties { label, value }.
      const returnLine = pairs
        ? 'var pairs = []; for (var r = 0; r < result.length; r++) { var p = new Properties(); p.put("label", String(result[r])); p.put("value", String(result[r])); pairs.push(p); } return pairs;'
        : dropdown ? 'return result;' : 'return result.length > 0 ? result[0] : "";';

      const findings: Finding[] = [];
      if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(module)) {
        findings.push(
          warning('vcfa.action.module-name', `"${module}" is not a reverse-DNS module name.`, {
            remediation: 'Modules are how actions are found, exported and permissioned. com.company.area keeps yours apart from the library’s com.vmware ones.',
            source: SRC,
          }),
        );
      }
      if (timeout > 30) {
        findings.push(
          warning('vcfa.action.slow-form', `A form field that can take ${timeout} seconds to fill makes the request form look broken.`, {
            remediation: 'Keep value sources under a few seconds. If the source is slow, cache it — a scheduled workflow that writes the list to a configuration element, read here.',
            source: SRC,
          }),
        );
      }
      if (limit > 1000) {
        findings.push(
          warning('vcfa.action.long-list', `Up to ${limit} entries in one dropdown is a list nobody can use.`, {
            remediation: 'Take a filter input from another field on the form and return what matches.',
            source: SRC,
          }),
        );
      }

      const script = [
        '/**',
        ` * ${module} / ${actionName}`,
        ' *',
        ` * ${source.label}, for a custom form field.`,
        ` * Return type: ${returnType}`,
        ...source.inputs.map((input) => ` * Input: ${input.name} (${input.type}) — ${input.description}`),
        ' *',
        ' * Runs every time the form opens or a field it depends on changes, as the',
        ' * requester. So: fast, bounded, and it never throws — an exception here is an',
        ' * empty dropdown with no explanation. Failures are logged and an empty list',
        ' * returned instead.',
        ' */',
        '',
        `var LIMIT = ${limit};`,
        `var TIMEOUT_SECONDS = ${timeout};`,
        `var CATEGORY_PATH = ${JSON.stringify(category)};`,
        `var ELEMENT_NAME = ${JSON.stringify(element)};`,
        '',
        'function setting(key) {',
        '  var category = Server.getConfigurationElementCategoryWithPath(CATEGORY_PATH);',
        '  if (!category) throw "Configuration element category not found: " + CATEGORY_PATH;',
        '  var elements = category.allConfigurationElements;',
        '  for (var i = 0; i < elements.length; i++) {',
        '    if (elements[i].name == ELEMENT_NAME) return elements[i].getAttributeWithKey(key).value;',
        '  }',
        '  throw "Configuration element not found: " + CATEGORY_PATH + "/" + ELEMENT_NAME;',
        '}',
        '',
        'var result = [];',
        'try {',
        ...source.body.map((line) => `  ${line}`),
        '} catch (e) {',
        `  System.error("${module}/${actionName} failed: " + e);`,
        '  result = [];',
        '}',
        '',
        returnLine,
        '',
      ].join('\n');

      const actionDescription = {
        module,
        name: actionName,
        description: `${source.label}, for a custom form value source.`,
        returnType,
        inputs: source.inputs,
        configurationElement: { path: category, name: element, reads: sourceId === 'ad-ous' ? ['ouBase'] : sourceId === 'ipam-vlans' ? ['ipamRestHost (REST:RESTHost)', 'vlanPath (string, with {site})'] : [] },
      };

      const inputName = source.inputs[0]?.name ?? 'filter';
      const formField = {
        label: source.fieldLabel,
        type: { dataType: 'string', isMultiple: false },
        [dropdown ? 'valueList' : 'default']: {
          id: `${module}/${actionName}`,
          type: 'scriptAction',
          parameters: [{ [inputName]: '' }],
        },
        constraints: { required: true },
      };
      const form = {
        _comment: 'Merge into the form definition of the cloud template or catalogue item. In the form designer this is Value source: External source. Verify the parameter binding shape against a form exported from your release.',
        schema: { [source.field]: formField },
        layout: {
          pages: [{ id: 'page_general', title: 'General', sections: [{ id: 'section_1', fields: [{ id: source.field, display: dropdown ? 'dropDown' : 'textField' }] }] }],
        },
      };

      const imported = importBundle({ vroActions: [{ module, name: actionName, script, inputs: source.inputs, returnType }] });

      // The package. An action lives in the module of its package, and the form
      // calls <module>/<action>, so the package is named after the module when it
      // is a valid package name; otherwise vcf.automation.vcfa.action.<module>,
      // and the form field below names that module instead.
      const packageName = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(module) ? module : packageNameOf('vcfa', 'action', module);
      const categoryPath = `${category}/${actionName || 'action'}`;
      const pkgAction: VroActionDef = {
        name: actionName,
        description: `${source.label}, for a custom form value source. Reads its settings from ${categoryPath}/${element}; never throws — a failure is logged and an empty list returned.`,
        resultType: returnType,
        params: source.inputs,
        script: [
          'var core = System.getModule("vcf.automation.core");',
          `var LIMIT = ${limit};`,
          `var SAFE = { timeout: ${timeout} };`,
          'var settings = null;',
          'function setting(key) {',
          '  var value = settings[key];',
          `  if (value === null || value === undefined || value === "") throw new Error("Set " + key + " in the configuration element " + ${q(`${categoryPath}/${element}`)});`,
          '  return value;',
          '}',
          'var result = [];',
          'try {',
          `  settings = core.settings(${q(categoryPath)}, ${q(element)});`,
          '  SAFE.redact = settings._secrets;',
          ...source.pkg.body.map((line) => `  ${line}`),
          '} catch (e) {',
          `  System.error(${q(`${packageName}/${actionName} failed: `)} + (e && e.message ? e.message : e));`,
          '  result = [];',
          '}',
          returnLine,
        ].join('\n'),
      };
      const pkg = toPackage({
        packageName,
        description: `The form value source ${packageName}/${actionName} (${source.label.toLowerCase()}) and a workflow to try it.`,
        categoryPath,
        workflow: {
          name: `Try ${actionName}`,
          description: `Runs the action ${packageName}/${actionName} as the request form would, and returns what the form would offer. Reads only.`,
          inputs: source.inputs,
          outputs: [
            { name: 'result', type: returnType, description: 'What the form field would offer' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: [
            `result = mod[${q(actionName)}](${source.inputs.map((input) => input.name).join(', ')});`,
            `var count = ${dropdown ? 'result.length' : 'result ? 1 : 0'};`,
            `System.log(${q(`${packageName}/${actionName} returned `)} + count + " value(s)" + (count === 0 ? "; an empty list is also what a failure looks like to the form, so read any error above." : "."));`,
            `summary = core.audit(null, { action: ${q(`${packageName}/${actionName}`)}, count: count });`,
          ].join('\n'),
        },
        actions: [pkgAction],
        config: {
          name: element,
          description: `Settings of the action ${packageName}/${actionName}.${source.pkg.settings.some((s) => s.type === 'SecureString') ? ' Fill the password after import.' : ''}`,
          attributes: source.pkg.settings.length > 0 ? source.pkg.settings : [{ name: 'note', type: 'string', value: 'This source needs no settings.', description: 'Nothing to set' }],
        },
      });
      const pkgForm = packageName === module ? form : { ...form, schema: { [source.field]: { ...formField, [dropdown ? 'valueList' : 'default']: { id: `${packageName}/${actionName}`, type: 'scriptAction', parameters: [{ [inputName]: '' }] } } } };

      return {
        platform: PLATFORM,
        title: `${module}/${actionName} — ${source.label.toLowerCase()} for a form field`,
        effect: 'read',
        trigger: { kind: 'request', detail: `The request form opening, or the ${inputName} field changing, for every requester of an item using the field`, worstCase: 'every time any requester opens the form — dozens of calls a minute on a busy morning' },
        scope: {
          what: `Reads from ${source.calls}. Returns at most ${limit} entries.`,
          decidedBy: [
            'The inputs the form passes.',
            sourceId === 'ad-ous' ? 'The ouBase setting, which the result is filtered to.' : `The settings in ${configPath}.`,
            'The rights of the account the plugin or REST host authenticates as — the requester sees what that account can see.',
          ],
          ifWrong: 'Requesters are offered choices they should not have — an OU or VLAN from another environment — and pick them. The approval policy is the backstop, not this list.',
        },
        guardrails: [
          { rule: `Returns at most ${limit} entries`, because: 'An unbounded list on a large directory is a form that times out.' },
          { rule: 'Never throws; logs and returns empty', because: 'An exception in a value source leaves the requester with an empty dropdown and no reason.' },
          { rule: `Gives up after ${timeout} seconds on a REST source`, because: 'The requester is waiting on it, and so is every other field that depends on it.' },
        ],
        dryRun: [`Run the package workflow "Try ${actionName}" with a sample input: its output is exactly what the form field would offer, and it changes nothing.`, 'Or run the action from the Orchestrator client with a sample input and check the list it returns before binding it to a form.'],
        undo: ['Unbind the field from the action in the form designer. The action changes nothing, so there is nothing else to put back.'],
        told: ['Nobody — it reads. Failures are in the Orchestrator log as System.error lines.'],
        requires: [
          PKG_REQUIRES,
          `The module ${module} in Orchestrator (Library → Actions → New action).`,
          sourceId === 'ipam-vlans' ? 'A REST host for the IPAM API, referenced from the configuration element.' : sourceId === 'ad-ous' ? 'The Active Directory plugin with an AD server configured.' : sourceId === 'vm-folders' ? 'The vCenter plugin with the vCenter registered.' : 'Whatever the body calls.',
          `The configuration element ${configPath}.`,
        ],
        files: {
          ...pkg.files,
          [`${module}/${actionName}.js`]: script,
          [`${base}-action.json`]: json(actionDescription),
          [`${base}-form-field.json`]: json(pkgForm),
          ...imported.files,
          'IMPORT.md': importMd({
            subject: `The Orchestrator action ${packageName}/${actionName} and the form field that calls it: as an Orchestrator package with its settings and a workflow to try it (\`${pkg.packageDir}\`), or as the plain action (\`import/orchestrator/\`) with a configuration element you create by hand. Use one or the other.`,
            steps: [
              ...packageSteps(pkg),
              manualStep(`Or by hand: configuration element ${configPath}`, [`Only for the plain action under \`import/orchestrator/\`: Assets → Configurations: the element \`${element}\` in folder \`${category}\` must exist with the attributes the action reads (see \`${base}-action.json\`). The package brings its own, in ${categoryPath}.`]),
              orByHand(imported.steps.orchestrator),
              manualStep('Bind it to the request form', [
                `Open the template’s custom form (Design → Custom Forms, or Content & Policies → Content → the item → Customize form; VERIFY the menu on 9.1) — or build the whole form with "A custom request form for a catalog item", whose Values column takes action:${packageName}/${actionName} — select the field ${source.fieldLabel}, and set its values to come from an external source: the action ${packageName}/${actionName}, with its ${source.inputs[0]?.name ?? 'filter'} input bound. \`${base}-form-field.json\` shows the resulting schema; merge it by hand — it is a fragment of a form, not a whole one, so it is not imported as one.`,
                ...(packageName !== module ? [`The package is ${packageName}, not ${module}: "${module}" is not a valid package name, and an action lives in its package’s module. The plain action under \`import/orchestrator/\` keeps ${module}.`] : []),
              ]),
            ],
            auth: ['import'],
            verify: [
              ...verifyFor(imported),
              'Custom forms in 9.x: external value sources are documented for VM Apps organizations; an All Apps organization’s request forms are VERIFY.',
              ...(sourceId === 'ipam-vlans' ? ['vlanPath and the [{ id, name }] answer are a placeholder for your IPAM’s API; VERIFY both.'] : []),
            ],
          }),
        },
        notes: [
          'The action runs with the Orchestrator plugin’s credentials, not the requester’s. Anything it can see, every requester of the form can see.',
          'Actions are exported with the package that contains them. Put this module in the same package as the workflows that rely on the values it returns.',
          dropdown ? 'For label/value pairs rather than plain strings, return Array/Properties with value and label keys — verify the form accepts it on your release first.' : 'A string return fills the field’s default. The requester can still change it unless the field is read-only.',
        ],
        findings,
      };
    },
  }),

  ORCHESTRATOR_ENDPOINT,
  ORCHESTRATOR_ASSETS,
  CUSTOM_FORM,

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_resource_action',
    platform: PLATFORM,
    label: 'A custom day-2 action on a machine or deployment',
    group: 'Day 2',
    description:
      'A custom resource action — extend a disk, add to backup, change owner, snapshot with an expiry — backed by an Orchestrator workflow or an ABX action, with criteria so it is only offered when it can work, a request form, and the day-2 and approval policy lines that say who may run it.',
    inputs: [
      { id: 'action_name', label: 'Action name', control: 'text', default: 'Extend disk' },
      {
        id: 'operation',
        label: 'Does',
        control: 'select',
        options: [
          { value: 'extend-disk', label: 'Extend a disk — cannot be shrunk back' },
          { value: 'add-backup', label: 'Add to a backup job' },
          { value: 'change-owner', label: 'Change owner tag' },
          { value: 'snapshot-expiry', label: 'Snapshot, deleted automatically after N days' },
          { value: 'generic', label: 'Anything — an existing workflow or ABX action, by name' },
        ],
        default: 'extend-disk',
      },
      {
        id: 'resource_type',
        label: 'On',
        control: 'combo',
        options: [
          { value: 'Cloud.vSphere.Machine', label: 'Cloud.vSphere.Machine' },
          { value: 'Deployment', label: 'Deployment' },
          { value: 'Cloud.vSphere.Disk', label: 'Cloud.vSphere.Disk' },
          { value: 'Cloud.NSX.Network', label: 'Cloud.NSX.Network' },
          { value: 'Cloud.NSX.LoadBalancer', label: 'Cloud.NSX.LoadBalancer' },
          { value: 'Cloud.SecurityGroup', label: 'Cloud.SecurityGroup' },
          { value: 'Cloud.Ansible', label: 'Cloud.Ansible' },
          { value: 'Custom.ADUser', label: 'Custom.ADUser (a custom resource type)' },
        ],
        default: 'Cloud.vSphere.Machine',
        hint: 'Any resource type, including your Custom.* ones',
      },
      {
        id: 'backed_by',
        label: 'Backed by',
        control: 'select',
        options: [
          { value: 'vro', label: 'Orchestrator workflow' },
          { value: 'abx', label: 'ABX action' },
        ],
        default: 'vro',
      },
      { id: 'powered_on_only', label: 'Only offer when powered on', control: 'toggle', default: true },
      { id: 'max_disk_gb', label: 'Largest disk after extending (GB)', control: 'number', default: 500, min: 0, max: 62000, hint: '0 means no limit', showWhen: { input: 'operation', equals: ['extend-disk'] } },
      { id: 'expiry_days', label: 'Delete snapshot after (days)', control: 'number', default: 3, min: 1, max: 30, showWhen: { input: 'operation', equals: ['snapshot-expiry'] } },
      { id: 'require_approval', label: 'Require approval', control: 'toggle', default: true },
      { id: 'runnable_name', label: 'Workflow or ABX action to run', control: 'text', default: 'Restart application service', hint: 'Exactly as named; it must exist', showWhen: { input: 'operation', equals: ['generic'] } },
      {
        id: 'generic_effect',
        label: 'What it does can be',
        control: 'select',
        options: [
          { value: 'reversible', label: 'Put back' },
          { value: 'irreversible', label: 'Not put back' },
        ],
        default: 'reversible',
        showWhen: { input: 'operation', equals: ['generic'] },
      },
      {
        id: 'input_bindings',
        label: 'Inputs of the workflow or action',
        control: 'textarea',
        default: 'vm | VC:VirtualMachine | resource\nserviceName | string | form:serviceName',
        hint: 'Input | Type | From',
        help: 'From: resource (the resource itself), property:<name> (one of its properties, e.g. property:address), form:<field> (a field of the form below), or const:<value>.',
        showWhen: { input: 'operation', equals: ['generic'] },
      },
      { id: 'form_fields', label: 'Request form', control: 'textarea', default: 'serviceName | Service | string | yes | httpd | httpd, nginx, tomcat | - | General', hint: FORM_FIELD_HINT, showWhen: { input: 'operation', equals: ['generic'] } },
      { id: 'criteria', label: 'Only offered where', control: 'textarea', default: '', placeholder: '${properties.osType} | eq | LINUX', hint: 'Property | Operator | Value', help: 'Conditions on the resource’s properties, all of which must hold, beside "only when powered on".' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const actionName = str(values, 'action_name', 'Custom action');
      const generic = str(values, 'operation', 'extend-disk') === 'generic';
      const runnableName = str(values, 'runnable_name', '');
      const operation = str(values, 'operation', 'extend-disk');
      const resourceType = str(values, 'resource_type', 'Cloud.vSphere.Machine');
      const backedBy = str(values, 'backed_by', 'vro');
      const poweredOnOnly = bool(values, 'powered_on_only', true);
      const maxDisk = num(values, 'max_disk_gb', 500);
      const expiry = num(values, 'expiry_days', 3);
      const approval = bool(values, 'require_approval', true);
      const base = slugOf(name || actionName, 'resource-action');
      const machine = resourceType === 'Cloud.vSphere.Machine';
      const irreversible = operation === 'extend-disk' || operation === 'snapshot-expiry' || (generic && str(values, 'generic_effect', 'reversible') === 'irreversible');
      const actionId = actionName.replace(/[^A-Za-z0-9]/g, '');

      const findings: Finding[] = [];
      const form = generic ? parseFormFields(str(values, 'form_fields', '')) : { fields: [], findings: [] };
      findings.push(...form.findings);
      const bindings = generic
        ? rowsOf(str(values, 'input_bindings', ''), 3).map(([input = '', type = '', from = '']) => {
            const m = /^(resource|property:.+|form:.+|const:.*)$/.exec(from);
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input) || !m) findings.push(error('vcfa.day2.bad-binding', `"${input} | ${type} | ${from}" is not Input | Type | resource, property:<name>, form:<field> or const:<value>.`, { source: SRC }));
            if (from.startsWith('form:') && !form.fields.some((field) => field.id === from.slice(5))) findings.push(error('vcfa.day2.unknown-form-field', `Input ${input} is taken from form field ${from.slice(5)}, which the form does not have.`, { source: SRC }));
            return { input, type: type || 'string', from };
          })
        : [];
      if (generic && !runnableName) findings.push(error('vcfa.day2.no-runnable', 'Name the workflow or ABX action the action runs.', { source: SRC }));
      const extraCriteria = criteriaOf(str(values, 'criteria', ''), 'vcfa.day2', findings);
      if (irreversible && !approval) {
        findings.push(
          warning('vcfa.day2.destructive-no-approval', `${actionName} cannot be undone and nobody approves it.`, {
            remediation: operation === 'extend-disk'
              ? 'A disk extended by mistake cannot be shrunk; the fix is a new disk and a data copy. Put an approval policy on the action, or keep the size cap low.'
              : generic
                ? 'Nothing this action does comes back. Put an approval policy on it.'
                : 'The snapshot is deleted on a timer. Somebody should agree to that before the timer starts.',
            source: SRC,
          }),
        );
      }
      if (operation === 'extend-disk' && maxDisk === 0) {
        findings.push(
          warning('vcfa.day2.no-size-cap', 'Nothing limits how large a disk can be extended to.', {
            remediation: 'Cap it on the form and check it again in the workflow. A typo of one extra zero is a datastore full.',
            source: SRC,
          }),
        );
      }
      if (!poweredOnOnly && (operation === 'extend-disk' || operation === 'snapshot-expiry')) {
        findings.push(
          info('vcfa.day2.no-criteria', 'The action is offered whatever the machine’s state.', {
            remediation: 'Criteria hide the action where it cannot work. Without them, the requester finds out from a failed request.',
            source: SRC,
          }),
        );
      }
      if (!machine && operation === 'extend-disk') {
        findings.push(
          warning('vcfa.day2.disk-on-deployment', 'Extending a disk on a Deployment has to pick which machine and which disk.', {
            remediation: 'Put disk actions on Cloud.vSphere.Machine, where the resource is the machine.',
            source: SRC,
          }),
        );
      }

      const OPS: Record<string, { about: string; fields: Record<string, unknown>; workflowInputs: string[]; undo: string }> = {
        'extend-disk': {
          about: `Grows a disk on the machine to a new size, up to ${maxDisk || 'any'} GB. The guest filesystem still has to be extended inside the OS.`,
          fields: {
            diskIndex: { label: 'Disk', type: { dataType: 'integer' }, default: 0, constraints: { required: true } },
            newSizeGb: { label: 'New size (GB)', type: { dataType: 'integer' }, constraints: { required: true, min: 1, ...(maxDisk > 0 ? { max: maxDisk } : {}) } },
          },
          workflowInputs: ['vm (VC:VirtualMachine)', 'diskIndex (number)', 'newSizeGb (number)', 'dryRun (boolean, default true)'],
          undo: 'None. A virtual disk cannot be shrunk. Recovery is a new, smaller disk and a copy inside the guest.',
        },
        'add-backup': {
          about: 'Adds the machine to a named backup job.',
          fields: { jobName: { label: 'Backup job', type: { dataType: 'string' }, valueList: { id: '<REQUIRED — an action returning allowed job names>', type: 'scriptAction' }, constraints: { required: true } } },
          workflowInputs: ['vm (VC:VirtualMachine)', 'jobName (string)', 'dryRun (boolean, default true)'],
          undo: 'Remove the machine from the job in the backup product.',
        },
        'change-owner': {
          about: 'Sets the owner tag on the resource. It does not change the deployment owner, which is Deployment.ChangeOwner.',
          fields: { newOwner: { label: 'New owner', type: { dataType: 'string' }, constraints: { required: true, pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+$' } } },
          workflowInputs: ['vm (VC:VirtualMachine)', 'newOwner (string)', 'dryRun (boolean, default true)'],
          undo: 'Run it again with the previous owner. The request history shows what it was.',
        },
        'snapshot-expiry': {
          about: `Takes a snapshot and schedules its deletion ${expiry} days later, so snapshots stop being permanent by accident.`,
          fields: {
            snapshotName: { label: 'Snapshot name', type: { dataType: 'string' }, constraints: { required: true } },
            memory: { label: 'Include memory', type: { dataType: 'boolean' }, default: false },
          },
          workflowInputs: ['vm (VC:VirtualMachine)', 'snapshotName (string)', 'memory (boolean)', `expiryDays (number, fixed at ${expiry})`, 'dryRun (boolean, default true)'],
          undo: `Before expiry: cancel the scheduled deletion in Orchestrator (Scheduled workflows). After ${expiry} days the snapshot is gone and cannot be recovered.`,
        },
        generic: {
          about: `Runs "${runnableName}" on the ${resourceType}, with the inputs bound as listed.`,
          fields: generic ? (formDefinition(form.fields).schema as Record<string, unknown>) : {},
          workflowInputs: bindings.map((b) => `${b.input} (${b.type})`),
          undo: irreversible ? `None: "${runnableName}" does something that cannot be put back.` : `Whatever reverses "${runnableName}" — run it again with the previous values, or its own undo workflow.`,
        },
      };
      const op = OPS[operation] ?? OPS['change-owner']!;

      const powerCriterion: Record<string, unknown>[] = poweredOnOnly && machine ? [{ key: '${properties.powerState}', operator: 'eq', value: 'ON' }] : [];
      const extraList = (extraCriteria?.matchExpression ?? []) as Record<string, unknown>[];
      const extraExpressions = extraList.length === 1 && Array.isArray(extraList[0]!.and) ? (extraList[0]!.and as Record<string, unknown>[]) : extraList;
      const allCriteria = [...powerCriterion, ...extraExpressions];
      const criteria = allCriteria.length === 0 ? null : allCriteria.length === 1 ? { matchExpression: allCriteria } : { matchExpression: [{ and: allCriteria }] };

      // The backing workflow or ABX action, generated so it can be imported first.
      const extendDisk = [
        'if (!vm) throw "No VM was passed in";',
        `var MAX_GB = ${maxDisk}; // 0 means no cap. Checked here because the form's max is only checked in the browser.`,
        'if (MAX_GB > 0 && newSizeGb > MAX_GB) throw "New size " + newSizeGb + " GB is over the cap of " + MAX_GB + " GB — refusing.";',
        'var disks = [];',
        'var devices = vm.config.hardware.device;',
        'for (var i = 0; i < devices.length; i++) { if (devices[i] instanceof VcVirtualDisk) disks.push(devices[i]); }',
        'if (diskIndex < 0 || diskIndex >= disks.length) throw "There is no disk " + diskIndex + " on " + vm.name;',
        'var disk = disks[diskIndex];',
        'var newKb = newSizeGb * 1024 * 1024;',
        'if (newKb <= disk.capacityInKB) throw "Disk " + diskIndex + " is already " + (disk.capacityInKB / 1048576) + " GB; a disk cannot be shrunk.";',
        '// VERIFY the reconfigure against your vCenter plugin, or call the library workflow',
        '// that changes a disk size instead of these lines.',
        'var change = new VcVirtualDeviceConfigSpec();',
        'change.operation = VcVirtualDeviceConfigSpecOperation.edit;',
        'disk.capacityInKB = newKb;',
        'change.device = disk;',
        'var spec = new VcVirtualMachineConfigSpec();',
        'spec.deviceChange = [change];',
        'var task = vm.reconfigVM_Task(spec);',
        'System.getModule("com.vmware.library.vc.basic").vim3WaitTaskEnd(task, true, 2);',
        'System.log("Extended disk " + diskIndex + " of " + vm.name + " to " + newSizeGb + " GB. Extend the filesystem inside the guest next.");',
      ];
      // The package's folder. The backing workflow is in it under the same name
      // in both forms (the package and import/orchestrator), so both have one id.
      const categoryPath = `Automation/Day 2/${base}`;
      const backingName = elementName(actionName);
      const backingWorkflow: VroWorkflowArtifact | undefined = backedBy === 'vro' && !generic
        ? {
            name: backingName,
            category: categoryPath,
            description: `Backs the custom action "${actionName}" on ${resourceType}. ${op.about}`,
            inputs: op.workflowInputs.map(paramOf),
            outputs: [],
            taskName: actionName,
            script: [
              '/**',
              ` * ${actionName} — backing workflow for the custom day-2 action.`,
              ` * ${op.about}`,
              ' * The resource action passes dryRun = false; anybody running it by hand gets a report.',
              ' */',
              'if (dryRun !== false) {',
              `  System.log("DRY RUN: ${actionName} on " + (typeof vm !== "undefined" && vm ? vm.name : "(no vm)") + " — nothing was changed.");`,
              '} else {',
              ...(operation === 'extend-disk' ? extendDisk : [`throw "${actionName}: the ${operation} step is not written yet — write it here, then remove this line.";`]).map((line) => `  ${line}`),
              '}',
              '',
            ].join('\n'),
          }
        : undefined;
      const backingAbx: AbxArtifact | undefined = backedBy === 'abx' && !generic
        ? { name: actionName, runtime: 'python', script: abxStub(actionName, op.about), description: `Backs the custom action "${actionName}".`, timeoutSeconds: 120 }
        : undefined;
      const imported = importBundle({ ...(backingWorkflow ? { vroWorkflows: [backingWorkflow] } : {}), ...(backingAbx ? { abx: [backingAbx] } : {}) });

      const resourceAction = {
        name: actionId,
        displayName: actionName,
        description: `${op.about}`,
        provider: backedBy === 'vro' ? 'vro-workflow' : 'abx',
        resourceType,
        runnableItem: backedBy === 'vro'
          ? {
              // The id the generated workflow imports with (import/orchestrator); change it if you back the action with your own.
              id: backingWorkflow ? workflowId(backingWorkflow) : '<REQUIRED — the workflow id, from the Orchestrator client>',
              name: generic ? runnableName : backingName,
              type: 'vro.workflow',
              endpointLink: '<REQUIRED — /resources/endpoints/{id} of the Orchestrator integration>',
              inputParameters: generic
                ? bindings.map((b) => ({ name: b.input, type: b.type, description: `${b.input} (${b.type})`, binding: bindingOf(b.from) }))
                : op.workflowInputs.map((input) => ({ name: input.split(' ')[0], description: input })),
            }
          : {
              id: '<REQUIRED — the ABX action id>',
              name: generic ? runnableName : actionName,
              type: 'abx.action',
              projectId: '<REQUIRED — the project that owns the ABX action>',
            },
        _binding: generic
          ? 'The binding of each input is in runnableItem.inputParameters[].binding (resource, a resource property, a form field or a constant). VERIFY how your release serialises property binding: make one in the interface and GET it.'
          : machine
          ? 'Bind the workflow input vm to the resource in the interface: Property binding → vm → "In request" / resource. Verify how your release serialises this before relying on the JSON.'
          : 'Bind the deployment id to the workflow input that takes it.',
        formDefinition: {
          form: JSON.stringify(generic ? formDefinition(form.fields) : { layout: { pages: [{ id: 'page_general', sections: [{ id: 'section_1', fields: Object.keys(op.fields).map((id) => ({ id, display: 'textField' })) }] }] }, schema: op.fields }),
          styles: '',
        },
        ...(criteria ? { criteria } : {}),
        status: 'RELEASED',
      };

      const day2Line = {
        _comment: 'Add this action to the allowedActions of the project’s day-2 policy — see "A day-2 actions policy" in this kit. Verify the id form against your release: open the day-2 policy editor and search for the action by name.',
        action: `${resourceType}.custom.${actionId}`,
        forRoles: ['<REQUIRED — the roles that may run it>'],
      };
      const approvalPolicy = approval
        ? {
            name: `${actionName} — approval`,
            typeId: 'com.vmware.policy.approval',
            enforcementType: 'HARD',
            definition: {
              level: 1,
              approverType: 'USER',
              approvalMode: 'ANY_OF',
              approvers: ['<REQUIRED — USER:someone@example.com or GROUP:platform-leads@example.com>'],
              autoApprovalDecision: 'REJECT',
              autoApprovalExpiry: 2, // days, then rejected
              actions: [`${resourceType}.custom.${actionId}`],
            },
            // Scoped to one project by its id, as the policy API takes it
            // (projectId; terraform-provider-vra's vra_policy_approval).
            projectId: '<REQUIRED — the project id: GET /iaas/api/projects>',
          }
        : undefined;

      // The package: the backing workflow (Orchestrator-backed), and the
      // workflow that registers everything in VCF Automation — the ABX action
      // (ABX-backed), the resource action pointing at what backs it, and the
      // approval policy — each looked up first and left alone if it exists.
      const hasProject = backedBy === 'abx' || approval;
      const registerName = elementName(`Register ${actionName}`);
      const pkgActions = [...vcfaActions(packageNameOf('vcfa', 'day2', base)), ...(generic ? lookupActions(packageNameOf('vcfa', 'day2', base)) : [])];
      const { _binding: _unusedBinding, ...resourceActionBody } = resourceAction;
      void _unusedBinding;
      const registerScript = [
        `var BACKED_BY = ${q(backedBy)};`,
        `var HAS_APPROVAL = ${approval};`,
        `var GENERIC = ${generic};`,
        `var RUNNABLE_NAME = ${q(runnableName)};`,
        'var ctx = core.begin(settings, dryRun);',
        VCFA_LOGIN,
        String.raw`var approvers = [];
if (HAS_APPROVAL) {
  var configured = settings.approvers || [];
  for (var a = 0; a < configured.length; a++) if (configured[a] && String(configured[a]).indexOf("<") < 0) approvers.push(String(configured[a]));
  if (approvers.length === 0) throw new Error("Set approvers in the configuration element (USER:someone@example.com or GROUP:platform-leads@example.com): an approval policy nobody can answer rejects every request.");
}
var action = JSON.parse(core.resource(RESOURCE_PATH, "resource-action.json"));
var projectId = "";`,
        ...(hasProject ? ['projectId = mod.projectIdOf(host, auth, SAFE, settings.projectName);'] : []),
        String.raw`if (BACKED_BY === "vro") {
  action.runnableItem.endpointLink = mod.vroEndpointLink(host, auth, SAFE, settings.vroIntegrationName || "");
  if (GENERIC) action.runnableItem.id = mod.workflowIdByName(settings.vroHost || host, auth, SAFE, RUNNABLE_NAME);
} else if (GENERIC) {
  action.runnableItem.id = mod.abxIdByName(host, auth, SAFE, RUNNABLE_NAME, projectId);
  action.runnableItem.projectId = projectId;
} else {
  var abx = JSON.parse(core.resource(RESOURCE_PATH, "abx-action.json"));
  abx.source = core.resource(RESOURCE_PATH, "abx-action.py");
  abx.projectId = projectId;
  action.runnableItem.id = mod.ensureAbxAction(ctx, host, auth, SAFE, abx) || "new-abx-action";
  action.runnableItem.projectId = projectId;
}
var existing = mod.findOne(mod.listAll(host, auth, "/form-service/api/custom/resource-actions", SAFE), { name: action.name, resourceType: action.resourceType }, "resource action " + action.name + " on " + action.resourceType);
var actionIdOut = "";
if (existing) {
  System.log("Exists, left as it is: resource action " + action.name + " on " + action.resourceType + " (" + existing.id + ")");
  actionIdOut = String(existing.id);
} else {
  actionIdOut = core.act(ctx, "create resource action " + action.name + " on " + action.resourceType + ", released", function () {
    var r = core.http("POST", "https://" + host + "/form-service/api/custom/resource-actions", auth, action, SAFE);
    if (!r.body || !r.body.id) throw new Error("POST /form-service/api/custom/resource-actions returned no id");
    return String(r.body.id);
  }) || "";
}
if (HAS_APPROVAL) {
  var policy = JSON.parse(core.resource(RESOURCE_PATH, "approval-policy.json"));
  policy.definition.approvers = approvers;
  policy.projectId = projectId;
  var policies = mod.listAll(host, auth, "/policy/api/policies", SAFE);
  var sameName = mod.findOne(policies, { name: policy.name, typeId: policy.typeId }, "approval policy named " + policy.name);
  if (sameName) {
    System.log("Exists, left as it is: approval policy \"" + policy.name + "\" (" + sameName.id + ")");
  } else {
    core.act(ctx, "create approval policy \"" + policy.name + "\"", function () { return core.http("POST", "https://" + host + "/policy/api/policies", auth, policy, SAFE); });
  }
}
resourceActionId = ctx.dryRun ? "" : actionIdOut;
summary = core.audit(ctx, { resourceActionId: resourceActionId, note: "Released. Nobody is offered it until a day-2 policy lists it." });
core.notify(settings.webhook, summary);`,
      ].join('\n');
      const pkg = toPackage({
        packageName: packageNameOf('vcfa', 'day2', base),
        description: `The custom day-2 action "${actionName}" on ${resourceType}: ${backedBy === 'vro' ? 'its backing workflow, and ' : ''}the workflow that registers it in VCF Automation.`,
        categoryPath,
        workflow: {
          name: registerName,
          description: `Registers "${actionName}" in VCF Automation: ${backedBy === 'abx' ? 'the ABX action, ' : ''}the resource action on ${resourceType} (released)${approval ? ' and its approval policy' : ''}. What exists is left as it is. Set the dryRun input to true to preview without changing anything.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be created and change nothing' }],
          outputs: [
            { name: 'resourceActionId', type: 'string', description: 'The resource action id, empty in a dry run' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: registerScript,
        },
        actions: pkgActions,
        config: {
          name: 'Settings',
          description: `Settings of the ${registerName} workflow${backedBy === 'vro' ? ` and of the ${backingName} workflow` : ''}. Fill vcfaApiToken after import; set dryRun to true to preview instead of changing anything.`,
          attributes: [
            ...vcfaSettings('vm-apps'),
            ...(hasProject ? [{ name: 'projectName', type: 'string' as const, value: '', description: `The project ${backedBy === 'abx' ? 'that owns the ABX action' : ''}${backedBy === 'abx' && approval ? ' and ' : ''}${approval ? 'the approval policy is scoped to' : ''}` }] : []),
            ...(backedBy === 'vro' ? [{ name: 'vroIntegrationName', type: 'string' as const, value: '', description: 'The Orchestrator integration to run the workflow on; empty when there is only one' }] : []),
            ...(generic && backedBy === 'vro' ? [{ name: 'vroHost', type: 'string' as const, value: '', description: 'The Orchestrator host the workflow is looked up on, when it is not the VCF Automation host' }] : []),
            ...(approval ? [{ name: 'approvers', type: 'Array/string' as const, value: [], description: 'USER:someone@example.com or GROUP:platform-leads@example.com, one per entry' }] : []),
            ...guardSettings(1 + (approval ? 1 : 0) + (backedBy === 'abx' && !generic ? 1 : 0) + (backedBy === 'vro' ? 1 : 0), 'created or changed'),
          ],
        },
        resources: [
          { name: 'resource-action.json', content: json(resourceActionBody) },
          ...(approvalPolicy ? [{ name: 'approval-policy.json', content: json(approvalPolicy) }] : []),
          ...(backingAbx ? [{ name: 'abx-action.json', content: json(abxBody(backingAbx)) }, { name: 'abx-action.py', content: backingAbx.script, mimeType: 'text/x-python' }] : []),
        ],
      });

      // The backing workflow, in the package: the native one's task on the core
      // library, so VCF Automation calling it with dryRun = false still acts only
      // once the configuration element is armed, within its cap, and audited.
      const backingBody = operation === 'extend-disk'
        ? String.raw`var MAX_GB = ${maxDisk}; // 0 means no cap. Checked here because the form's max is only checked in the browser.
if (MAX_GB > 0 && newSizeGb > MAX_GB) throw new Error("New size " + newSizeGb + " GB is over the cap of " + MAX_GB + " GB; refusing.");
var disks = [];
var devices = vm.config.hardware.device || [];
for (var i = 0; i < devices.length; i++) { if (devices[i] instanceof VcVirtualDisk) disks.push(devices[i]); }
if (diskIndex < 0 || diskIndex >= disks.length) throw new Error("There is no disk " + diskIndex + " on " + vm.name);
var disk = disks[diskIndex];
var newKb = newSizeGb * 1024 * 1024;
if (newKb === disk.capacityInKB) {
  System.log("Exists, left as it is: disk " + diskIndex + " of " + vm.name + " is already " + newSizeGb + " GB.");
} else if (newKb < disk.capacityInKB) {
  throw new Error("Disk " + diskIndex + " is already " + (disk.capacityInKB / 1048576) + " GB; a disk cannot be shrunk.");
} else {
  core.act(ctx, "extend disk " + diskIndex + " of " + vm.name + " to " + newSizeGb + " GB", function () {
    // VERIFY the reconfigure against your vCenter plugin, or call the library
    // workflow that changes a disk size instead of these lines.
    var change = new VcVirtualDeviceConfigSpec();
    change.operation = VcVirtualDeviceConfigSpecOperation.edit;
    disk.capacityInKB = newKb;
    change.device = disk;
    var spec = new VcVirtualMachineConfigSpec();
    spec.deviceChange = [change];
    var task = vm.reconfigVM_Task(spec);
    System.getModule("com.vmware.library.vc.basic").vim3WaitTaskEnd(task, true, 2);
    return true;
  });
  if (!ctx.dryRun) System.log("Extended disk " + diskIndex + " of " + vm.name + " to " + newSizeGb + " GB. Extend the filesystem inside the guest next.");
}`
        : `core.act(ctx, ${q(`${operation} on `)} + vm.name, function () { throw new Error(${q(`${actionName}: the ${operation} step is not written yet — write it here, then remove this line.`)}); });`;
      const backing = backingWorkflow
        ? extraWorkflow(pkg, true, {
            name: backingName,
            description: backingWorkflow.description,
            inputs: backingWorkflow.inputs,
            outputs: [{ name: 'summary', type: 'string', description: 'The audit record, JSON' }],
            script: [
              'var ctx = core.begin(settings, dryRun);',
              'if (!vm) throw new Error("No VM was passed in");',
              backingBody,
              'summary = core.audit(ctx, { vm: String(vm.name) });',
              'core.notify(settings.webhook, summary);',
            ].join('\n'),
          })
        : undefined;

      return {
        platform: PLATFORM,
        title: `${actionName} — a day-2 action on ${resourceType}`,
        effect: irreversible ? 'irreversible' : 'reversible',
        trigger: { kind: 'request', detail: `Somebody runs "${actionName}" from the Actions menu of a ${machine ? 'machine' : 'deployment'}${criteria ? ' that is powered on' : ''}`, worstCase: 'once per request — but a user with the action allowed can run it on every machine they own, one after another' },
        scope: {
          what: `Any ${resourceType} in a project whose day-2 policy allows the action${criteria ? ', while powered on' : ''}.`,
          decidedBy: [
            `The resource type: ${resourceType}.`,
            criteria ? `The criteria: ${allCriteria.map((c) => `${String(c.key)} ${String(c.operator)} ${JSON.stringify(c.value)}`).join(' and ')}.` : 'No criteria — offered on every resource of the type.',
            'The day-2 policy of the project, which must list the action for the requester’s role.',
            approval ? 'The approval policy, which holds the request until someone agrees.' : 'No approval — it runs when requested.',
          ],
          ifWrong: irreversible
            ? 'The action is offered to people who should not have it and run on machines nobody intended — and neither a grown disk nor an expired snapshot comes back.'
            : 'The action is run on machines it should not be, one request at a time. Reversible, and visible in the request history.',
        },
        guardrails: [
          ...(criteria ? [{ rule: powerCriterion.length > 0 && extraExpressions.length === 0 ? 'Only offered when the machine is powered on' : 'Only offered where its criteria hold', because: 'Hidden where it would fail, rather than failing where it is offered.' }] : []),
          ...(approval ? [{ rule: 'Approval required before it runs', because: irreversible ? 'Nothing this action does can be put back, so a person agrees first.' : 'Somebody other than the requester sees it.' }] : []),
          ...(operation === 'extend-disk' && maxDisk > 0 ? [{ rule: `New size capped at ${maxDisk} GB on the form`, because: 'One extra zero on a disk size fills a datastore. Check the cap again in the workflow — a form constraint is not a server-side one.' }] : []),
          { rule: 'Only runnable once the day-2 policy lists it', because: 'A released custom action is still invisible to requesters until a policy allows it. That is the moment to decide who.' },
          { rule: 'The backing workflow takes dryRun, default true', because: 'The action passes false explicitly; anything else calling the workflow gets a report.' },
        ],
        dryRun: [
          `Run the package workflow ${registerName} with the dryRun input set to true: it reads what exists, logs every "DRY RUN: would create …" and creates nothing.`,
          'Run the backing workflow from the Orchestrator client with dryRun = true against one machine.',
          'Release the action, allow it in a test project’s day-2 policy only, and run it there as a project member.',
        ],
        undo: [op.undo, 'Removing the action from the day-2 policy stops it being offered; it does not reverse anything it did.'],
        told: ['The deployment’s History tab, per run, with the requester and the inputs.', approval ? 'The approvers, when it is requested.' : 'Nobody before it runs.'],
        requires: [
          PKG_REQUIRES,
          generic ? `The ${backedBy === 'vro' ? 'Orchestrator workflow' : 'ABX action'} "${runnableName}", already imported${backedBy === 'abx' ? ' in the project' : ''}.` : backedBy === 'vro' ? 'The backing Orchestrator workflow — see "An Orchestrator workflow with a dry run" in this kit.' : 'The backing ABX action.',
          'The Orchestrator integration in VCF Automation, for its endpoint link.',
        ],
        files: {
          ...pkg.files,
          ...(backing ? backing.files : {}),
          [`${base}.json`]: json(resourceAction),
          [`${base}-day2-policy-line.json`]: json(day2Line),
          ...(approvalPolicy ? { [`${base}-approval-policy.json`]: json(approvalPolicy) } : {}),
          'scripts/apply.sh': underScripts(
            applyScript(
              'vcf-automation',
              [
                { method: 'POST', path: '/form-service/api/custom/resource-actions', payload: `${base}.json` },
                ...(approvalPolicy ? [{ method: 'POST' as const, path: '/policy/api/policies', payload: `${base}-approval-policy.json` }] : []),
              ],
              'DELETE /form-service/api/custom/resource-actions/{id}; DELETE /policy/api/policies/{id} for the approval policy.',
            ),
          ),
          ...imported.files,
          'IMPORT.md': importMd({
            subject: `The custom day-2 action "${actionName}" on ${resourceType}, and what backs it. The Orchestrator package (\`${pkg.packageDir}\`) is the one route that does all of it: ${backedBy === 'vro' ? 'it holds the backing workflow, and ' : ''}its workflow **${registerName}** ${backedBy === 'abx' ? 'creates the ABX action, then ' : 'finds the Orchestrator integration, then '}registers the resource action${approval ? ' and the approval policy' : ''} through the API. The files after it are the same objects for importing by hand.`,
            steps: [
              ...packageSteps(pkg, backing ? [{ name: backingName, id: backing.id }] : []),
              backedBy === 'vro' ? orByHand(imported.steps.orchestrator) : abxStep(imported.steps.abx),
              apiStep('Or by hand: the resource action', 'scripts/apply.sh', [
                `\`${base}.json\` → POST /form-service/api/custom/resource-actions`,
                ...(approvalPolicy ? [`\`${base}-approval-policy.json\` → POST /policy/api/policies`] : []),
              ], [
                generic
                  ? `Fill runnableItem.id with the id of "${runnableName}" (${backedBy === 'vro' ? 'the Orchestrator client shows it; fill endpointLink with the Orchestrator integration’s link too' : 'GET /abx/api/resources/actions; and projectId with the project'}).`
                  : backedBy === 'vro'
                  ? 'runnableItem.id is already the id the generated workflow imports with. Fill endpointLink with the Orchestrator integration’s link first (VERIFY its /resources/endpoints/{id} form with GET /iaas/api/integrations).'
                  : 'Fill runnableItem.id with the action id create-abx-action.sh wrote to import/abx/created-ids.txt, and projectId with the project.',
                ...(approvalPolicy ? ['Fill the approvers and the project in the approval policy first.'] : []),
                'By hand: Design → Resource Actions → New, with the same resource type, runnable and criteria (VERIFY the menu on 9.x).',
              ]),
              manualStep('Allow it', [`Add \`${resourceType}.custom.${actionId}\` to the project’s day-2 policy (the "day-2 actions policy" blueprint, or \`${base}-day2-policy-line.json\`). Until a policy lists it nobody is offered it. Then set it RELEASED.`]),
            ],
            auth: ['import', 'apply'],
            verify: [
              ...verifyFor(imported),
              'The resource action body (/form-service/api/custom/resource-actions) and the binding of the vm input to the resource: create one in the interface and GET it to compare.',
              VERIFY_LOGIN,
              'Custom resource actions are a VM Apps organization feature (/form-service/api); an All Apps organization has no /form-service custom actions — VERIFY on your release before pointing the package at one.',
              ...(generic ? [`The workflow or ABX action is looked up by name ("${runnableName}") at register time: /vco/api/workflows?conditions=name=… for a workflow (VERIFY the organization token is accepted there), /abx/api/resources/actions for an ABX action. The binding field on each input parameter is VERIFY.`] : []),
              'endpointLink is /resources/endpoints/<Orchestrator integration id> (KB 314899: a resource action keeps the integration id it was made with); the list answer of GET /form-service/api/custom/resource-actions is VERIFY — the package refuses to act on a shape it does not recognise.',
              ...(approval ? ['The approval policy body follows the VCF Automation policy API ("Create an Approval Policy", /policy/api/policies); it is scoped by projectId (terraform-provider-vra vra_policy_approval) instead of a scopeCriteria on the project name. The action id form <type>.custom.<name> in its actions is VERIFY.'] : []),
            ],
          }),
        },
        notes: [
          'The form constraints (required, max) are checked in the browser. Check them again in the workflow — the API does not go through the form.',
          'Criteria keys use the resource’s properties as the deployment shows them. Open a machine, look at its properties, and copy the key from there if powerState does not match.',
          'Created released, so it is ready the moment a day-2 policy lists it; allow it in a test project’s policy first.',
          ...(backedBy === 'vro' ? ['The backing workflow has one id in both forms, so the resource action finds it either way — and importing import/orchestrator after the package replaces the package’s guarded version with the plain one. Use one route.'] : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_day2_policy',
    platform: PLATFORM,
    label: 'A day-2 actions policy',
    group: 'Day 2',
    description:
      'Who may do what to a deployment after it exists, per project and role: power, snapshot, resize, delete. With the approval policy for the actions that cannot be undone, because a day-2 policy says who may press the button and nothing about whether somebody should look first.',
    inputs: [
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'Members — standard day-2 actions' },
      {
        id: 'org_type',
        label: 'Organization',
        control: 'select',
        options: [
          { value: 'vm-apps', label: 'VM Apps organization' },
          { value: 'all-apps', label: 'All Apps organization (9.1)' },
        ],
        default: 'vm-apps',
      },
      {
        id: 'scope',
        label: 'Applies to',
        control: 'select',
        options: [
          { value: 'project', label: 'One project' },
          { value: 'organization', label: 'The whole organization' },
        ],
        default: 'project',
      },
      { id: 'project', label: 'Project', control: 'text', default: 'Application Team A', showWhen: { input: 'scope', equals: ['project'] } },
      {
        id: 'role',
        label: 'For',
        control: 'select',
        options: [
          { value: 'member', label: 'Project members' },
          { value: 'administrator', label: 'Project administrators' },
          { value: 'supervisor', label: 'Project supervisors' },
        ],
        default: 'member',
      },
      {
        id: 'action_set',
        label: 'Allow',
        control: 'select',
        options: [
          { value: 'operate', label: 'Power and console only' },
          { value: 'standard', label: 'Power, console, snapshots, lease and tags' },
        ],
        default: 'standard',
      },
      { id: 'allow_resize', label: 'Also allow resize', control: 'toggle', default: true },
      { id: 'resize_approval', label: 'Resize needs approval', control: 'toggle', default: true, showWhen: { input: 'allow_resize', equals: ['true'] } },
      { id: 'allow_delete', label: 'Also allow delete', control: 'toggle', default: true },
      { id: 'delete_approval', label: 'Delete needs approval', control: 'toggle', default: true, showWhen: { input: 'allow_delete', equals: ['true'] } },
      { id: 'extra_actions', label: 'Other actions', control: 'textarea', default: '', placeholder: 'Cloud.vSphere.Machine.custom.ExtendDisk', hint: 'Custom actions, one per line' },
      { id: 'extra_authorities', label: 'Also for', control: 'text', default: '', placeholder: 'GROUP:app-ops@example.com, USER:lead@example.com', hint: 'Comma-separated USER:, GROUP: or ROLE: entries, beside the role above' },
      {
        id: 'criteria',
        label: 'Only deployments where',
        control: 'textarea',
        default: '',
        placeholder: 'catalogItemName | eq | Linux server',
        hint: 'Property | Operator | Value',
        help: 'Deployment criteria, all of which must hold: a deployment property (catalogItemName, blueprintId, ownedBy, projectId, or a custom property) and an operator eq, notEq, hasAny, in or notIn. Empty: every deployment in scope.',
      },
      {
        id: 'enforcement',
        label: 'Enforcement',
        control: 'select',
        options: [
          { value: 'HARD', label: 'Hard — cannot be overridden' },
          { value: 'SOFT', label: 'Soft — a hard policy elsewhere wins' },
        ],
        default: 'HARD',
      },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const policyName = str(values, 'policy_name', 'Day-2 policy');
      const orgType = str(values, 'org_type', 'vm-apps') === 'all-apps' ? 'all-apps' : 'vm-apps';
      const projectScope = str(values, 'scope', 'project') !== 'organization';
      const project = projectScope ? str(values, 'project', '') : '';
      const role = str(values, 'role', 'member');
      const extraAuthorities = listOf(str(values, 'extra_authorities', ''));
      const actionSet = str(values, 'action_set', 'standard');
      const allowResize = bool(values, 'allow_resize', true);
      const resizeApproval = allowResize && bool(values, 'resize_approval', true);
      const allowDelete = bool(values, 'allow_delete', true);
      const deleteApproval = allowDelete && bool(values, 'delete_approval', true);
      const extra = listOf(str(values, 'extra_actions', ''));
      const enforcement = str(values, 'enforcement', 'HARD');
      const base = slugOf(name || policyName, 'day2-policy');

      const actions = [
        ...(actionSet === 'operate' ? OPERATE_ACTIONS : STANDARD_ACTIONS),
        ...(allowResize ? ['Cloud.vSphere.Machine.Resize'] : []),
        ...(allowDelete ? ['Deployment.Delete'] : []),
        ...extra,
      ];

      const findings: Finding[] = [];
      if (projectScope && !project) {
        findings.push(
          error('vcfa.day2.no-project', 'The policy is meant for one project, and no project is set.', {
            remediation: 'Name the project, or choose "The whole organization" deliberately.',
            source: SRC,
          }),
        );
      }
      if (!projectScope) {
        findings.push(
          warning('vcfa.day2.org-wide', 'The policy applies to every project in the organization.', {
            remediation: 'An organization-wide day-2 policy is a decision about every team’s deployments at once. Make it SOFT so a project’s own HARD policy can tighten it, and keep delete behind approval.',
            source: SRC,
          }),
        );
      }
      for (const authority of extraAuthorities) {
        if (!/^(USER|GROUP|ROLE):\S+$/.test(authority)) findings.push(error('vcfa.day2.bad-authority', `"${authority}" is not USER:…, GROUP:… or ROLE:….`, { source: SRC }));
      }
      const criteria = criteriaOf(str(values, 'criteria', ''), 'vcfa.day2', findings);
      if (allowDelete && !deleteApproval && role === 'member') {
        findings.push(
          warning('vcfa.day2.member-delete', 'Project members may delete deployments, and nobody approves it.', {
            remediation: 'Delete destroys the machines and their disks. Either keep it to administrators, or add the approval policy this blueprint writes.',
            source: SRC,
          }),
        );
      }
      if (allowResize && !resizeApproval) {
        findings.push(
          warning('vcfa.day2.unbounded-resize', 'Resize is allowed with no approval and nothing limiting the size.', {
            remediation: 'The cloud template’s size limits apply at request time only. After that, resize is the way round them — approve it, or cap it with a resource quota on the project.',
            source: SRC,
          }),
        );
      }
      if (actions.includes('Cloud.vSphere.Machine.Snapshot.Revert')) {
        findings.push(
          info('vcfa.day2.revert', 'Snapshot revert is allowed. It throws away everything since the snapshot, without asking twice.', {
            source: SRC,
          }),
        );
      }
      if (enforcement === 'SOFT') {
        findings.push(
          info('vcfa.day2.soft', 'A soft policy is overridden by any hard policy covering the same project and role.', {
            remediation: 'Soft is for organisation-wide defaults a project can tighten. For a project’s own policy, hard is usually what is meant.',
            source: SRC,
          }),
        );
      }

      // Scoped to the project by its id, the field the policy API has for it
      // (projectId; terraform-provider-vra vra_policy_day2_action). The package
      // workflow fills it from the project name; by hand, fill it before sending.
      const projectRef = '<REQUIRED — the project id: GET /iaas/api/projects>';
      const scopeFields = projectScope ? { projectId: projectRef } : {};
      const policy = {
        name: policyName,
        description: `Day-2 actions for project ${role}s in ${projectScope ? project || '(no project)' : 'every project of the organization'}.`,
        typeId: 'com.vmware.policy.deployment.action',
        enforcementType: enforcement,
        definition: {
          allowedActions: [
            {
              authorities: [`ROLE:${role}`, ...extraAuthorities],
              actions,
            },
          ],
        },
        ...(criteria ? { criteria } : {}),
        ...scopeFields,
      };

      const approvalActions = [...(deleteApproval ? ['Deployment.Delete'] : []), ...(resizeApproval ? ['Cloud.vSphere.Machine.Resize'] : [])];
      const approvalPolicy = approvalActions.length > 0
        ? {
            name: `${policyName} — approval for ${approvalActions.map((a) => a.split('.').pop()).join(' and ').toLowerCase()}`,
            typeId: 'com.vmware.policy.approval',
            enforcementType: 'HARD',
            definition: {
              level: 1,
              approverType: 'USER',
              approvalMode: 'ANY_OF',
              approvers: ['<REQUIRED — GROUP:platform-leads@example.com; for project administrators set approverType ROLE and verify the role id on your release>'],
              autoApprovalDecision: 'REJECT',
              autoApprovalExpiry: 2, // days, then rejected
              actions: approvalActions,
            },
            ...(criteria ? { criteria } : {}),
            ...scopeFields,
          }
        : undefined;

      // The package: one workflow that finds the project, then creates each
      // policy unless one of the same name and type exists — never a second.
      const applyName = elementName(`Apply ${policyName}`);
      const policyPkg = toPackage({
        packageName: packageNameOf('vcfa', 'policy', base),
        description: `The day-2 actions policy "${policyName}"${approvalPolicy ? ' and its approval policy' : ''}, applied through the VCF Automation policy API.`,
        categoryPath: `Automation/Policies/${base}`,
        workflow: {
          name: applyName,
          description: `Creates in VCF Automation the day-2 actions policy "${policyName}"${approvalPolicy ? ' and the approval policy for delete and resize' : ''}, ${projectScope ? 'scoped to the project in the configuration element' : 'for the whole organization'}. A policy of the same name and type is left as it is. Set the dryRun input to true to preview without changing anything.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be created and change nothing' }],
          outputs: [{ name: 'summary', type: 'string', description: 'The audit record, JSON' }],
          script: [
            `var HAS_APPROVAL = ${Boolean(approvalPolicy)};`,
            `var PROJECT_SCOPE = ${projectScope};`,
            'var ctx = core.begin(settings, dryRun);',
            VCFA_LOGIN,
            String.raw`var approvers = [];
if (HAS_APPROVAL) {
  var configured = settings.approvers || [];
  for (var a = 0; a < configured.length; a++) if (configured[a] && String(configured[a]).indexOf("<") < 0) approvers.push(String(configured[a]));
  if (approvers.length === 0) throw new Error("Set approvers in the configuration element (USER:… or GROUP:…): an approval policy nobody can answer rejects every request.");
}
var projectId = PROJECT_SCOPE ? mod.projectIdOf(host, auth, SAFE, settings.projectName) : "";
var where = PROJECT_SCOPE ? "in project " + settings.projectName : "for the whole organization";
var existing = mod.listAll(host, auth, "/policy/api/policies", SAFE);
var files = HAS_APPROVAL ? ["policy.json", "approval-policy.json"] : ["policy.json"];
var ids = [];
for (var f = 0; f < files.length; f++) {
  var policy = JSON.parse(core.resource(RESOURCE_PATH, files[f]));
  if (PROJECT_SCOPE) policy.projectId = projectId;
  if (policy.typeId === "com.vmware.policy.approval") policy.definition.approvers = approvers;
  var same = mod.findOne(existing, { name: policy.name, typeId: policy.typeId }, policy.typeId + " policy named " + policy.name);
  if (same) {
    System.log("Exists, left as it is: " + policy.typeId + " policy \"" + policy.name + "\" (" + same.id + "). Change it in the interface, or delete it and run again.");
    ids.push(String(same.id));
    continue;
  }
  var id = core.act(ctx, "create " + policy.typeId + " policy \"" + policy.name + "\" " + where, function () {
    var r = core.http("POST", "https://" + host + "/policy/api/policies", auth, policy, SAFE);
    return r.body && r.body.id ? String(r.body.id) : "";
  });
  if (id) ids.push(id);
}
summary = core.audit(ctx, { project: PROJECT_SCOPE ? String(settings.projectName) : "(organization)", projectId: projectId, policyIds: ids });
core.notify(settings.webhook, summary);`,
          ].join('\n'),
        },
        actions: vcfaActions(packageNameOf('vcfa', 'policy', base)),
        config: {
          name: 'Settings',
          description: `Settings of the ${applyName} workflow. Fill vcfaApiToken${approvalPolicy ? ' and approvers' : ''} after import; set dryRun to true to preview instead of changing anything.`,
          attributes: [
            ...vcfaSettings(orgType),
            ...(projectScope ? [{ name: 'projectName', type: 'string' as const, value: project, description: 'The project the policies are scoped to' }] : []),
            ...(approvalPolicy ? [{ name: 'approvers', type: 'Array/string' as const, value: [], description: 'Who approves delete and resize: USER:someone@example.com or GROUP:platform-leads@example.com, one per entry' }] : []),
            ...guardSettings(approvalPolicy ? 2 : 1, 'created'),
          ],
        },
        resources: [{ name: 'policy.json', content: json(policy) }, ...(approvalPolicy ? [{ name: 'approval-policy.json', content: json(approvalPolicy) }] : [])],
      });

      return {
        platform: PLATFORM,
        title: `${policyName} — what ${role}s of ${project || 'every project'} may do to a deployment`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: `A project ${role} opens the Actions menu on a deployment or machine in ${project || 'any project'}`, worstCase: 'every day-2 request in the project — the policy is evaluated on each one' },
        scope: {
          what: `Day-2 actions on deployments in ${project || 'every project'}, for users with the project ${role} role.`,
          decidedBy: [
            projectScope ? `The project: ${project || '(none set)'}.` : 'The organization: every project in it.',
            ...(criteria ? ['The deployment criteria, all of which must hold.'] : []),
            `The authority: project ${role}s${extraAuthorities.length > 0 ? `, and ${extraAuthorities.join(', ')}` : ''}. Membership is whatever the project’s member list, and the groups in it, say today.`,
            'Other day-2 policies on the same project: allowed actions from all matching policies are combined, and hard beats soft.',
            'Custom actions still need their own criteria to be offered.',
          ],
          ifWrong: 'People can delete, resize or revert machines they should only have been able to power on — and delete takes the disks with it.',
        },
        guardrails: [
          ...(projectScope ? [{ rule: `Scoped to the project ${project || '(none)'}`, because: 'An unscoped day-2 policy is a decision about every team’s deployments.' }] : []),
          ...(criteria ? [{ rule: 'Narrowed by deployment criteria', because: 'Only the deployments that match get these actions; the rest keep whatever other policies give them.' }] : []),
          ...(deleteApproval ? [{ rule: 'Delete needs approval', because: 'Delete is the one action here with no way back, and a requester deleting the wrong deployment is a common afternoon.' }] : []),
          ...(resizeApproval ? [{ rule: 'Resize needs approval', because: 'Resize is how the template’s size limits are got round after the fact.' }] : []),
          { rule: 'Actions listed explicitly', because: 'A policy that allows "*" allows every custom action anybody adds later, without anybody deciding it.' },
        ],
        dryRun: [
          `Run the package workflow ${applyName} with the dryRun input set to true: it finds the project, reads the existing policies, logs every "DRY RUN: would create …" and creates nothing.`,
          'Apply it to a test project first, then log in as a project member and open the Actions menu on a machine. What is offered there is the policy.',
          'GET /policy/api/policies?typeId=com.vmware.policy.deployment.action and read which other policies already cover the project.',
        ],
        undo: ['DELETE /policy/api/policies/{id}. Actions already run stay run — a deleted deployment is not restored by removing the policy that allowed it.'],
        told: ['The deployment History tab records who ran what.', approvalPolicy ? 'The approvers, for delete and resize requests.' : 'Nobody in advance.'],
        requires: [PKG_REQUIRES, projectScope ? `The project ${project || '(set one)'}.` : 'An organization administrator token (organization-wide policies).', 'Custom actions listed here must exist and be released.'],
        files: {
          ...policyPkg.files,
          [`${base}.json`]: json(policy),
          ...(approvalPolicy ? { [`${base}-approval.json`]: json(approvalPolicy) } : {}),
          'scripts/apply.sh': underScripts(
            applyScript(
              'vcf-automation',
              [
                { method: 'POST', path: '/policy/api/policies', payload: `${base}.json` },
                ...(approvalPolicy ? [{ method: 'POST' as const, path: '/policy/api/policies', payload: `${base}-approval.json` }] : []),
              ],
              'DELETE /policy/api/policies/{id} for each policy created.',
            ),
          ),
          'IMPORT.md': importMd({
            subject: `The day-2 actions policy "${policyName}". The Orchestrator package (\`${policyPkg.packageDir}\`) applies it: its workflow **${applyName}** finds the project and creates each policy unless it exists. \`scripts/apply.sh\` sends the same JSON by hand.`,
            steps: [
              ...packageSteps(policyPkg),
              apiStep('Or by hand: the day-2 policy', 'scripts/apply.sh', [`\`${base}.json\` → POST /policy/api/policies`, ...(approvalPolicy ? [`\`${base}-approval.json\` → POST /policy/api/policies`] : [])], [
                `${projectScope ? 'Fill projectId (GET /iaas/api/projects)' : 'Organization-wide, so there is no projectId to fill'}${approvalPolicy ? `${projectScope ? ' and' : '; fill'} the approvers` : ''} first. Custom actions it lists must exist first (the "custom day-2 action" blueprint). By hand in the interface: Content & Policies → Policies → New policy → Day 2 actions policy on a VM Apps organization (VERIFY the menu on 9.1); Manage and Govern → Policies → Definitions → New Policy → Day 2 Actions Policy on a 9.1 All Apps organization.`,
              ]),
            ],
            auth: ['apply'],
            verify: [
              `The authority form ROLE:${role}: create one in the interface and GET /policy/api/policies/{id} to compare (terraform-provider-vra documents USER:, GROUP: and ROLE: prefixes, not the role names).`,
              'Project scope is projectId, as the policy API and terraform-provider-vra have it; the scopeCriteria on a project name this file used to carry is gone.',
              VERIFY_LOGIN,
              orgType === 'all-apps'
                ? 'All Apps organization: 9.1 documents Day 2 Action policies there in the interface (Manage and Govern → Policies); the package sends the same /policy/api body with the All Apps organization token, which is VERIFY — if it is refused, create the policy in the interface with the actions and authorities in the JSON.'
                : 'The package targets the /policy/api of a VM Apps organization. 9.1 All Apps organizations have day-2 policies too (choose All Apps on the page); their API is VERIFY.',
              ...(criteria ? ['The criteria object ({ matchExpression: [...] }, several rows under and) and the operator names follow the policy API of earlier releases; VERIFY by adding criteria in the interface and comparing the GET.'] : []),
            ],
          }),
        },
        notes: [
          `The authority is written ROLE:${role}. Verify the exact form against a day-2 policy created in the interface and exported with GET /policy/api/policies/{id} — it has been written differently between releases, and a policy whose authority matches nobody allows nothing.`,
          'Action ids are as the day-2 policy editor names them. Search there for any you add by hand; a misspelt action id is silently ignored.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_custom_resource',
    platform: PLATFORM,
    label: 'A custom resource type with its whole lifecycle',
    group: 'Custom resources',
    description:
      'A resource that is not a machine — an AD user, a DNS record, a backup job — as a type people can put in a cloud template, with the create, update and delete workflows behind it. The delete is the one that matters: a custom resource with no delete workflow leaves the real object behind every time a deployment is removed.',
    inputs: [
      {
        id: 'type_name',
        label: 'Type',
        control: 'combo',
        options: Object.entries(CUSTOM_TYPES).map(([value, type]) => ({ value, label: `${value} — ${type.label}` })),
        default: 'Custom.ADUser',
        hint: 'One of these, or your own Custom.Name',
      },
      { id: 'display_name', label: 'Display name', control: 'text', default: '', placeholder: 'Firewall rule', hint: 'Empty: from the type name' },
      {
        id: 'properties',
        label: 'Properties',
        control: 'textarea',
        default: '',
        placeholder: 'ruleName | string | Rule name | yes',
        hint: 'Property | Type | Title | Required',
        help: 'Type: string, integer, number or boolean. Empty uses the built-in properties of the three listed types; your own type needs at least one.',
      },
      { id: 'external_type', label: 'Orchestrator inventory type', control: 'text', default: '', placeholder: 'DynamicTypes:Firewall.Rule', hint: 'What the create workflow returns; empty uses the listed type’s' },
      {
        id: 'backed_by',
        label: 'Backed by',
        control: 'select',
        options: [
          { value: 'vro', label: 'Orchestrator workflows' },
          { value: 'abx', label: 'ABX actions' },
        ],
        default: 'vro',
      },
      { id: 'has_update', label: 'Has an update workflow', control: 'toggle', default: true },
      { id: 'has_delete', label: 'Has a delete workflow', control: 'toggle', default: true, hint: 'Off leaves orphans — see the finding' },
      {
        id: 'runnables',
        label: 'Lifecycle',
        control: 'select',
        options: [
          { value: 'scaffold', label: 'Generate the create, update and delete scaffolds' },
          { value: 'existing', label: 'Use workflows or ABX actions that exist, by name' },
        ],
        default: 'scaffold',
      },
      { id: 'create_name', label: 'Create runs', control: 'text', default: '', placeholder: 'Create AD user', hint: 'Empty: "Create <display name>"', showWhen: { input: 'runnables', equals: ['existing'] } },
      { id: 'update_name', label: 'Update runs', control: 'text', default: '', placeholder: 'Update AD user', showWhen: { input: 'runnables', equals: ['existing'] } },
      { id: 'delete_name', label: 'Delete runs', control: 'text', default: '', placeholder: 'Delete AD user', showWhen: { input: 'runnables', equals: ['existing'] } },
      {
        id: 'additional_actions',
        label: 'Day-2 actions on it',
        control: 'textarea',
        default: '',
        placeholder: 'Reset password | Reset AD user password',
        hint: 'Action name | Workflow or ABX action',
        help: 'Resource actions on the type, each running an existing workflow (or ABX action, when backed by ABX) by name. A day-2 policy still has to allow them.',
      },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const typeName = str(values, 'type_name', 'Custom.ADUser').trim();
      const preset = CUSTOM_TYPES[typeName];
      const propertyRows = rowsOf(str(values, 'properties', ''), 4);
      const findings: Finding[] = [];
      if (!/^Custom\.[A-Za-z][A-Za-z0-9]*$/.test(typeName)) findings.push(error('vcfa.custom.bad-type-name', `"${typeName}" is not Custom.<Name> (letters and digits).`, { source: SRC }));
      const rowProps: Record<string, { type: string; title: string; example: string; required: boolean }> = {};
      for (const [key = '', ptype = '', title = '', req = ''] of propertyRows) {
        const kind = (ptype || 'string').toLowerCase();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !['string', 'integer', 'number', 'boolean'].includes(kind)) {
          findings.push(error('vcfa.custom.bad-property', `"${key} | ${ptype}" is not Property | string, integer, number or boolean.`, { source: SRC }));
          continue;
        }
        rowProps[key] = { type: kind, title: title || key, example: '', required: yes(req) };
      }
      const displayName = str(values, 'display_name', '') || preset?.label || typeName.replace(/^Custom\./, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
      const type: CustomType & { required: readonly string[] } = {
        label: displayName,
        externalType: str(values, 'external_type', '') || preset?.externalType || '<REQUIRED — a Dynamic Types type, e.g. DynamicTypes:Namespace.Type, or use ABX backing>',
        properties: propertyRows.length > 0 ? rowProps : preset?.properties ?? {},
        what: preset?.what ?? `${displayName} objects`,
        deleteMeans: preset?.deleteMeans ?? `Deleting it removes the real ${displayName.toLowerCase()}; check what else depends on it before wiring delete to deployment deletion.`,
        required: propertyRows.length > 0 ? Object.entries(rowProps).filter(([, p]) => p.required).map(([k]) => k) : Object.keys(preset?.properties ?? {}).slice(0, 2),
      };
      if (Object.keys(type.properties).length === 0) findings.push(error('vcfa.custom.no-properties', `${typeName} has no properties: give it at least one in the table.`, { source: SRC }));
      const existingRunnables = str(values, 'runnables', 'scaffold') === 'existing';
      const runnableNames: Record<string, string> = {
        Create: str(values, 'create_name', '') || `Create ${type.label}`,
        Update: str(values, 'update_name', '') || `Update ${type.label}`,
        Delete: str(values, 'delete_name', '') || `Delete ${type.label}`,
      };
      const additional = rowsOf(str(values, 'additional_actions', ''), 2).map(([actionLabel = '', runs = '']) => ({ actionLabel, runs }));
      for (const a of additional) if (!a.actionLabel || !a.runs) findings.push(error('vcfa.custom.bad-action', `"${a.actionLabel} | ${a.runs}" needs an action name and the workflow or ABX action it runs.`, { source: SRC }));
      const backedBy = str(values, 'backed_by', 'vro');
      const hasUpdate = bool(values, 'has_update', true);
      const hasDelete = bool(values, 'has_delete', true);
      const base = slugOf(name || typeName, 'custom-resource');
      const short = typeName.replace(/^Custom\./, '');

      if (!hasDelete) {
        findings.push(
          warning('vcfa.custom.no-delete', `${typeName} has no delete workflow, so deleting a deployment leaves the ${type.label} behind.`, {
            remediation: 'Every create needs a delete. Without one, the deployment disappears from VCF Automation and the real object stays, owned by nobody.',
            source: SRC,
          }),
        );
      }
      if (backedBy === 'vro' && type.externalType.startsWith('<')) {
        findings.push(
          info('vcfa.custom.external-type', `An Orchestrator-backed custom resource needs the create workflow to return an inventory type, and there is no built-in one for a ${type.label}.`, {
            remediation: 'Define one with the Dynamic Types plugin, or back this type with ABX actions, which take and return plain properties.',
            source: SRC,
          }),
        );
      }

      // The lifecycle workflows (or ABX actions), generated so the type can point at real ids.
      const objectType = backedBy === 'vro' && !type.externalType.startsWith('<') ? type.externalType : 'Properties';
      const props: VroParam[] = Object.entries(type.properties).map(([key, p]) => ({ name: key, type: p.type === 'integer' || p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string', description: p.title }));
      const dryRunParam: VroParam = { name: 'dryRun', type: 'boolean', description: 'Anything but false is a dry run. Bind it to false in the type’s lifecycle actions.' };
      const verbs = ['Create', ...(hasUpdate ? ['Update'] : []), ...(hasDelete ? ['Delete'] : [])];
      const lifecycleWorkflow = (verb: string): VroWorkflowArtifact => ({
        name: `${verb} ${type.label}`,
        category: `Automation/Custom resources/${short}`,
        description: `${verb} for the custom resource ${typeName}.`,
        inputs:
          verb === 'Create'
            ? [...props, dryRunParam]
            : verb === 'Update'
              ? [{ name: 'existing', type: objectType, description: 'The object as it is now.' }, ...props, dryRunParam]
              : [{ name: 'existing', type: objectType, description: 'The object to remove.' }, dryRunParam],
        outputs: verb === 'Delete' ? [] : [{ name: 'result', type: objectType, description: verb === 'Create' ? 'The created (or already existing) object.' : 'The object after the change.' }],
        taskName: `${verb} ${type.label}`,
        script: [
          `// ${verb} ${type.label} for ${typeName}. as a scaffold.`,
          verb === 'Create' ? '// Must be idempotent: VCF Automation may retry a create that timed out.' : verb === 'Delete' ? `// Must succeed when the object is already gone. ${type.deleteMeans}` : '// Change only what differs; log the before and after.',
          ...(objectType === 'Properties' ? ['// The type has no inventory type yet: define one with the Dynamic Types plugin and change', '// the Properties parameters to it before release.'] : []),
          'if (dryRun !== false) {',
          `  System.log("DRY RUN: ${verb.toLowerCase()} ${type.label} — nothing was changed.");`,
          ...(verb === 'Delete' ? [] : ['  result = null;']),
          ...(verb === 'Delete' ? ['} else if (!existing) {', '  System.log("Already gone — nothing to delete.");'] : []),
          '} else {',
          `  throw "${verb} ${type.label} is not written yet — write it here, then remove this line.";`,
          '}',
          '',
        ].join('\n'),
      });
      const workflows = backedBy === 'vro' && !existingRunnables ? verbs.map(lifecycleWorkflow) : [];
      const abxActions: AbxArtifact[] = backedBy === 'abx' && !existingRunnables
        ? verbs.map((verb) => ({
            name: `${verb} ${type.label}`,
            runtime: 'python' as const,
            script: abxStub(`${verb} ${type.label}`, verb === 'Delete' ? type.deleteMeans : `Returns the properties of ${typeName}.`),
            description: `${verb} for ${typeName}.`,
            timeoutSeconds: 120,
          }))
        : [];
      const workflowIdFor = (verb: string) => {
        const found = workflows.find((candidate) => candidate.name === `${verb} ${type.label}`);
        return found ? workflowId(found) : `<REQUIRED — id of the "${runnableNames[verb]}" workflow>`;
      };

      const runnable = (verb: string) =>
        backedBy === 'vro'
          ? { id: workflowIdFor(verb), name: runnableNames[verb]!, type: 'vro.workflow', endpointLink: '<REQUIRED — /resources/endpoints/{id} of the Orchestrator integration>' }
          : { id: `<REQUIRED — id of the "${runnableNames[verb]}" ABX action>`, name: runnableNames[verb]!, type: 'abx.action', projectId: '<REQUIRED — project owning the action>' };

      const resourceType = {
        displayName: type.label,
        description: `${type.what}, created and removed with the deployment.`,
        resourceType: typeName,
        ...(backedBy === 'vro' ? { externalType: type.externalType } : {}),
        schemaType: backedBy === 'vro' ? 'VRO_INVENTORY' : 'ABX_USER_DEFINED',
        status: 'RELEASED',
        mainActions: {
          create: runnable('Create'),
          ...(hasUpdate ? { update: runnable('Update') } : {}),
          ...(hasDelete ? { delete: runnable('Delete') } : {}),
        },
        properties: {
          properties: Object.fromEntries(Object.entries(type.properties).map(([key, p]) => [key, { type: p.type, title: p.title }])),
          required: type.required,
        },
        _comment: 'Field names follow the custom resource API at VCF 9.x. Verify against GET /form-service/api/custom/resource-types for one created in the interface before relying on the JSON.',
      };

      const inputs = Object.entries(type.properties);
      const yaml = [
        `# A deployment containing one ${typeName}.`,
        '#',
        '#',
        `# Deleting this deployment runs the ${hasDelete ? 'delete workflow, which removes the real object' : 'NO delete workflow — the real object is left behind'}.`,
        'formatVersion: 1',
        'inputs:',
        ...inputs.flatMap(([key, p]) => [`  ${key}:`, `    type: ${p.type}`, `    title: ${JSON.stringify(p.title)}`, ...(p.example ? [`    default: ${p.type === 'integer' ? p.example : JSON.stringify(p.example)}`] : [])]),
        'resources:',
        `  ${short.charAt(0).toLowerCase()}${short.slice(1)}:`,
        `    type: ${typeName}`,
        '    properties:',
        ...inputs.map(([key]) => `      ${key}: '\${input.${key}}'`),
        '',
      ].join('\n');

      const lifecycle = [
        '/**',
        ` * Lifecycle scaffolds for ${typeName}.`,
        ' *',
        ' * One Orchestrator workflow per verb; each is a scriptable task built as in',
        ' * "An Orchestrator workflow with a dry run". Settings come from a configuration',
        ' * element; nothing here names a host or holds a credential.',
        ' */',
        '',
        `// --- Create ${type.label} ---------------------------------------------------`,
        `// Inputs:  ${inputs.map(([key]) => key).join(', ')}`,
        backedBy === 'vro' ? `// Output:  exactly one, of type ${type.externalType}` : '// Output:  a properties object with every schema property, plus an id',
        '// Must be idempotent: VCF Automation may retry a create that timed out.',
        '',
        ...(hasUpdate
          ? [
              `// --- Update ${type.label} ---------------------------------------------------`,
              `// Inputs:  the existing object (${backedBy === 'vro' ? type.externalType : 'its id'}), plus the properties that changed`,
              '// Change only what differs; log the before and after.',
              '',
            ]
          : []),
        ...(hasDelete
          ? [
              `// --- Delete ${type.label} ---------------------------------------------------`,
              `// Input:   the existing object (${backedBy === 'vro' ? type.externalType : 'its id'})`,
              '// Must succeed when the object is already gone, or the deployment can',
              '// never be deleted. Log and return rather than throw on "not found".',
              `// ${type.deleteMeans}`,
              '',
            ]
          : [
              '// --- No delete workflow ---------------------------------------------------',
              `// Deleting the deployment will leave the ${type.label} in place. See the README.`,
              '',
            ]),
      ].join('\n');

      const imported = importBundle({
        templates: [{ name: `${type.label} request`, description: `Requests one ${typeName}.`, yaml }],
        ...(workflows.length > 0 ? { vroWorkflows: workflows } : {}),
        ...(abxActions.length > 0 ? { abx: abxActions } : {}),
      });

      // The package: the lifecycle workflows (Orchestrator-backed), and the
      // workflow that registers the type and imports the template — the ABX
      // actions first (ABX-backed), each object looked up and left alone if it
      // exists. The lifecycle workflows keep their names and folder, so their
      // ids are the ones mainActions already names.
      const customPkgName = packageNameOf('vcfa', 'custom', short);
      // Day-2 actions on the type, each running an existing runnable by name.
      const extraActions = additional.map((a) => ({
        name: a.actionLabel.replace(/[^A-Za-z0-9]/g, ''),
        displayName: a.actionLabel,
        description: `Runs "${a.runs}" on ${typeName}.`,
        provider: backedBy === 'vro' ? 'vro-workflow' : 'abx',
        resourceType: typeName,
        runnableItem: backedBy === 'vro'
          ? { id: `<REQUIRED — id of the "${a.runs}" workflow>`, name: a.runs, type: 'vro.workflow', endpointLink: '<REQUIRED — /resources/endpoints/{id} of the Orchestrator integration>' }
          : { id: `<REQUIRED — id of the "${a.runs}" ABX action>`, name: a.runs, type: 'abx.action', projectId: '<REQUIRED — project owning the action>' },
        status: 'RELEASED',
      }));
      const registerName = elementName(`Register ${typeName}`);
      const templateName = `${type.label} request`;
      const { _comment: _unusedComment, ...resourceTypeBody } = resourceType;
      void _unusedComment;
      const customPkg = toPackage({
        packageName: customPkgName,
        description: `The custom resource type ${typeName}: ${backedBy === 'vro' ? 'its lifecycle workflows, and ' : ''}the workflow that registers it and its template in VCF Automation.`,
        categoryPath: `Automation/Custom resources/${short}`,
        workflow: {
          name: registerName,
          description: `Registers ${typeName} in VCF Automation: ${backedBy === 'abx' ? 'its ABX actions, ' : ''}the custom resource type (released), and the cloud template "${templateName}" with its version 1.0.0. What exists is left as it is. Set the dryRun input to true to preview without changing anything.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be created and change nothing' }],
          outputs: [
            { name: 'resourceTypeId', type: 'string', description: 'The custom resource type id, empty in a dry run that would create it' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: [
            `var BACKED_BY = ${q(backedBy)};`,
            `var EXISTING = ${existingRunnables};`,
            `var HAS_EXTRA = ${additional.length > 0};`,
            `var TEMPLATE_NAME = ${q(templateName)};`,
            `var TEMPLATE_DESCRIPTION = ${q(`Requests one ${typeName}.`)};`,
            'var ctx = core.begin(settings, dryRun);',
            VCFA_LOGIN,
            String.raw`var projectId = mod.projectIdOf(host, auth, SAFE, settings.projectName);
var type = JSON.parse(core.resource(RESOURCE_PATH, "resource-type.json"));
var verb;
var link = BACKED_BY === "vro" ? mod.vroEndpointLink(host, auth, SAFE, settings.vroIntegrationName || "") : "";
/** The runnable of an existing workflow or ABX action, by its name. */
function runnableNamed(runName) {
  if (BACKED_BY === "vro") return { id: mod.workflowIdByName(settings.vroHost || host, auth, SAFE, runName), name: runName, type: "vro.workflow", endpointLink: link };
  return { id: mod.abxIdByName(host, auth, SAFE, runName, projectId), name: runName, type: "abx.action", projectId: projectId };
}
if (EXISTING) {
  for (verb in type.mainActions) if (type.mainActions.hasOwnProperty(verb)) type.mainActions[verb] = runnableNamed(type.mainActions[verb].name);
} else if (BACKED_BY === "vro") {
  for (verb in type.mainActions) if (type.mainActions.hasOwnProperty(verb)) type.mainActions[verb].endpointLink = link;
} else {
  for (verb in type.mainActions) {
    if (!type.mainActions.hasOwnProperty(verb)) continue;
    var abx = JSON.parse(core.resource(RESOURCE_PATH, "abx-" + verb + ".json"));
    abx.source = core.resource(RESOURCE_PATH, "abx-" + verb + ".py");
    abx.projectId = projectId;
    type.mainActions[verb].id = mod.ensureAbxAction(ctx, host, auth, SAFE, abx) || "new-abx-" + verb;
    type.mainActions[verb].projectId = projectId;
  }
}
var found = mod.findOne(mod.listAll(host, auth, "/form-service/api/custom/resource-types", SAFE), { resourceType: type.resourceType }, "custom resource type " + type.resourceType);
var typeId = "";
if (found) {
  System.log("Exists, left as it is: custom resource type " + type.resourceType + " (" + found.id + ")");
  typeId = String(found.id);
} else {
  typeId = core.act(ctx, "create custom resource type " + type.resourceType + ", released", function () {
    var r = core.http("POST", "https://" + host + "/form-service/api/custom/resource-types", auth, type, SAFE);
    if (!r.body || !r.body.id) throw new Error("POST /form-service/api/custom/resource-types returned no id");
    return String(r.body.id);
  }) || "";
}
if (HAS_EXTRA) {
  var extra = JSON.parse(core.resource(RESOURCE_PATH, "extra-actions.json"));
  var actionsNow = mod.listAll(host, auth, "/form-service/api/custom/resource-actions", SAFE);
  for (var e = 0; e < extra.length; e++) {
    var ra = extra[e];
    if (mod.findOne(actionsNow, { name: ra.name, resourceType: ra.resourceType }, "resource action " + ra.name)) {
      System.log("Exists, left as it is: resource action " + ra.displayName + " on " + ra.resourceType);
      continue;
    }
    ra.runnableItem = runnableNamed(ra.runnableItem.name);
    core.act(ctx, "create resource action " + ra.displayName + " on " + ra.resourceType + ", released", function () {
      return core.http("POST", "https://" + host + "/form-service/api/custom/resource-actions", auth, ra, SAFE);
    });
  }
}
// The template names the type, so it validates only once the type exists.
mod.ensureTemplate(ctx, host, auth, SAFE, { projectId: projectId, name: TEMPLATE_NAME, description: TEMPLATE_DESCRIPTION, content: core.resource(RESOURCE_PATH, "template.yaml"), version: "1.0.0", release: false, validate: Boolean(found) || !ctx.dryRun });
resourceTypeId = typeId;
summary = core.audit(ctx, { resourceTypeId: typeId, note: "Released: templates can use it. Generated lifecycle scaffolds refuse to act until their step is written." });
core.notify(settings.webhook, summary);`,
          ].join('\n'),
        },
        actions: [...vcfaActions(customPkgName), ...(existingRunnables || additional.length > 0 ? lookupActions(customPkgName) : [])],
        config: {
          name: 'Settings',
          description: `Settings of the ${registerName} workflow${backedBy === 'vro' && !existingRunnables ? ' and of the lifecycle workflows' : ''}. Fill vcfaApiToken after import; set dryRun to true to preview instead of changing anything.`,
          attributes: [
            ...vcfaSettings('vm-apps'),
            { name: 'projectName', type: 'string', value: '', description: `The project the template${backedBy === 'abx' ? ' and the ABX actions' : ''} belong to` },
            ...(backedBy === 'vro' ? [{ name: 'vroIntegrationName', type: 'string' as const, value: '', description: 'The Orchestrator integration the lifecycle workflows run on; empty when there is only one' }] : []),
            ...((existingRunnables || additional.length > 0) && backedBy === 'vro' ? [{ name: 'vroHost', type: 'string' as const, value: '', description: 'The Orchestrator host workflows are looked up on, when it is not the VCF Automation host' }] : []),
            ...guardSettings(3 + (backedBy === 'abx' && !existingRunnables ? verbs.length : 0) + additional.length, 'created'),
          ],
        },
        resources: [
          { name: 'resource-type.json', content: json(resourceTypeBody) },
          { name: 'template.yaml', content: yaml, mimeType: 'application/x-yaml' },
          ...(additional.length > 0 ? [{ name: 'extra-actions.json', content: json(extraActions) }] : []),
          ...abxActions.flatMap((action, index) => {
            const key = verbs[index]!.toLowerCase();
            return [{ name: `abx-${key}.json`, content: json(abxBody(action)) }, { name: `abx-${key}.py`, content: action.script, mimeType: 'text/x-python' }];
          }),
        ],
      });
      const lifecycleScript = (verb: string): string =>
        [
          'var ctx = core.begin(settings, dryRun);',
          verb === 'Create' ? '// Must be idempotent: VCF Automation may retry a create that timed out. Look the object up first.' : verb === 'Delete' ? `// Must succeed when the object is already gone. ${type.deleteMeans}` : '// Change only what differs; log the before and after.',
          ...(verb === 'Delete'
            ? [
                'if (!existing) {',
                '  System.log("Already gone: nothing to delete.");',
                '} else {',
                `  core.act(ctx, ${q(`delete ${type.label}`)}, function () { throw new Error(${q(`Delete ${type.label} is not written yet — write it here, then remove this line.`)}); });`,
                '}',
              ]
            : [
                `core.act(ctx, ${q(`${verb.toLowerCase()} ${type.label}`)}, function () { throw new Error(${q(`${verb} ${type.label} is not written yet — write it here, then remove this line.`)}); });`,
                'result = null;',
              ]),
          'summary = core.audit(ctx, {});',
          'core.notify(settings.webhook, summary);',
        ].join('\n');
      const lifecycleWorkflows = workflows.map((w) =>
        extraWorkflow(customPkg, true, { name: w.name, description: w.description, inputs: w.inputs, outputs: [...w.outputs, { name: 'summary', type: 'string', description: 'The audit record, JSON' }], script: lifecycleScript(w.name.split(' ')[0]!) }),
      );

      return {
        platform: PLATFORM,
        title: `${typeName} — a custom resource with create${hasUpdate ? ', update' : ''}${hasDelete ? ' and delete' : ' and no delete'}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: `A deployment containing ${typeName} is requested, updated or deleted`, worstCase: 'once per resource per lifecycle event — a template with count: 20 creates twenty' },
        scope: {
          what: `${type.what}, created by deployments of templates that use ${typeName}.`,
          decidedBy: [
            'Which cloud templates use the type, and which projects they are released to.',
            'The inputs of each request.',
            'The rights of the account the backing workflows run as — the real upper bound.',
          ],
          ifWrong: hasDelete
            ? `The delete workflow runs when a deployment is deleted. ${type.deleteMeans}`
            : `Objects are created with no way to remove them from VCF Automation. Every deleted deployment leaves an orphaned ${type.label}.`,
        },
        guardrails: [
          { rule: 'Lifecycle scaffolds refuse until written', because: 'The type is released so templates can use it; a generated create or delete that has not been written throws rather than pretending it worked.' },
          ...(hasDelete ? [{ rule: 'Delete succeeds when the object is already gone', because: 'A delete that throws on "not found" makes the deployment undeletable, which is worse than the orphan.' }] : []),
          { rule: 'Create is idempotent', because: 'A create that timed out is retried, and a non-idempotent one makes two.' },
          { rule: 'The workflows take dryRun, default true', because: 'The type passes false; anybody running the workflow by hand gets a report.' },
        ],
        dryRun: [
          `Run the package workflow ${registerName} with the dryRun input set to true: it reads what exists, logs every "DRY RUN: would create …" and creates nothing.`,
          'Run each backing workflow from the Orchestrator client with dryRun = true.',
          'Release the type, deploy the template in a test project, then delete the deployment and check the real object is gone.',
        ],
        undo: [
          hasDelete ? 'Delete the deployment: the delete workflow removes the object.' : 'Remove the object by hand in its own system. VCF Automation has no way to.',
          'Unreleasing or deleting the type does not delete anything created with it.',
          type.deleteMeans,
        ],
        told: ['The deployment History tab, per lifecycle event.', 'The Orchestrator run logs for the backing workflows.'],
        requires: [
          PKG_REQUIRES,
          backedBy === 'vro' ? `Create${hasUpdate ? ', update' : ''}${hasDelete ? ' and delete' : ''} workflows in Orchestrator, and the Orchestrator integration in VCF Automation.` : 'The ABX actions for each verb, in a project.',
          typeName === 'Custom.ADUser' && backedBy === 'vro' ? 'The Active Directory plugin, whose account can create and delete users in the target OUs.' : 'API access to the system the object lives in.',
        ],
        files: {
          ...customPkg.files,
          ...Object.assign({}, ...lifecycleWorkflows.map((w) => w.files)),
          [`${base}-resource-type.json`]: json(resourceType),
          [`${base}-template.yaml`]: yaml,
          [`${base}-template.json`]: json(templatePayload(`${type.label} request`, `Requests one ${typeName}.`, yaml)),
          [`${base}-lifecycle.js`]: lifecycle,
          ...(additional.length > 0 ? { [`${base}-extra-actions.json`]: json(extraActions) } : {}),
          'scripts/apply.sh': underScripts(
            applyScript(
              'vcf-automation',
              [
                { method: 'POST', path: '/form-service/api/custom/resource-types', payload: `${base}-resource-type.json` },
                { method: 'POST', path: '/blueprint/api/blueprints', payload: `${base}-template.json` },
              ],
              'DELETE /blueprint/api/blueprints/{id}, then DELETE /form-service/api/custom/resource-types/{id}. Delete deployments first — a type in use cannot be removed.',
            ),
          ),
          ...imported.files,
          'IMPORT.md': importMd({
            subject: `The custom resource type ${typeName}, its lifecycle ${backedBy === 'vro' ? 'workflows' : 'ABX actions'}, and a template that requests it. The Orchestrator package (\`${customPkg.packageDir}\`) is the one route that does all of it: ${backedBy === 'vro' ? 'it holds the lifecycle workflows, and ' : ''}its workflow **${registerName}** ${backedBy === 'abx' ? 'creates the ABX actions, then ' : 'finds the Orchestrator integration, then '}registers the type and imports the template through the API. The files after it are the same objects for importing by hand.`,
            steps: [
              ...packageSteps(customPkg, lifecycleWorkflows.map((w, index) => ({ name: workflows[index]!.name, id: w.id }))),
              backedBy === 'vro' ? orByHand(imported.steps.orchestrator) : abxStep(imported.steps.abx),
              apiStep('Or by hand: the resource type', 'scripts/apply.sh', [
                `\`${base}-resource-type.json\` → POST /form-service/api/custom/resource-types`,
                `\`${base}-template.json\` → POST /blueprint/api/blueprints (only once its projectId is filled; otherwise let it fail and use the next step)`,
              ], [
                ...(additional.length > 0 ? [`The day-2 actions in \`${base}-extra-actions.json\` are POSTed one by one to /form-service/api/custom/resource-actions, with each runnableItem id filled.`] : []),
                existingRunnables
                  ? `Fill each mainActions id with the id of the ${backedBy === 'vro' ? 'workflow' : 'ABX action'} it names (${Object.values(runnableNames).join(', ')}).`
                  : backedBy === 'vro'
                  ? 'The workflow ids in mainActions are already the ids the generated workflows import with. Fill endpointLink with the Orchestrator integration’s link first.'
                  : 'Fill each mainActions id with the ids create-abx-action.sh wrote to import/abx/created-ids.txt, and the project.',
                'By hand: Design → Custom Resources → New, with the same properties and lifecycle actions; bind dryRun = false on each lifecycle action.',
              ]),
              orByHand(imported.steps.templates),
            ],
            auth: ['import', 'apply'],
            verify: [
              ...verifyFor(imported),
              'The custom resource type body: create one in the interface and GET /form-service/api/custom/resource-types to compare before relying on the JSON (KB 314899 confirms the path, the list, and the endpointLink of each runnable).',
              'Custom resource types are a VM Apps organization feature (/form-service/api); an All Apps organization has none — VERIFY on your release.',
              VERIFY_LOGIN,
              ...(existingRunnables || additional.length > 0 ? ['Existing workflows are found by exact name through /vco/api/workflows?conditions=name=… (VERIFY the organization token there), ABX actions through /abx/api/resources/actions in the project.', 'VCF Automation custom resource types have create, update and delete lifecycle actions only; there is no read action — the create output is the state it keeps.'] : []),
              'If the package stops at the template because the type is not yet visible to the validator, run it again: the type is then left as it is.',
            ],
          }),
        },
        notes: [
          'Custom resources can have their own day-2 actions, added the same way as for machines, with resourceType set to this type.',
          'Update runs when the deployment is updated with changed inputs. Without an update workflow, a change to the inputs does nothing to the real object.',
          ...(backedBy === 'vro' ? ['Each lifecycle workflow has one id in both forms (the package and import/orchestrator), so the type finds it either way; importing import/orchestrator after the package replaces the package’s guarded versions with the plain ones. Use one route.'] : []),
        ],
        findings,
      };
    },
  }),

  SECRETS,

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_supervisor_namespace',
    platform: PLATFORM,
    label: 'A Supervisor namespace, requested from All Apps',
    group: 'Modern apps',
    description:
      'A vSphere Supervisor namespace as self-service: a cloud template using CCI.Supervisor.Namespace, and the same request as YAML for kubectl against the VCF Automation endpoint. In VCF Automation 9 these are requested through an All Apps organisation, and what a namespace may use — limits, storage classes, VM classes — comes from its class.',
    inputs: [
      { id: 'namespace_name', label: 'Namespace name', control: 'text', default: 'team-a-dev' },
      { id: 'class_name', label: 'Namespace class', control: 'text', default: 'small', hint: 'As defined in the All Apps organisation' },
      { id: 'region', label: 'Region', control: 'text', default: 'region1' },
      { id: 'storage_class', label: 'Storage class', control: 'text', default: 'vsan-default-storage-policy' },
      { id: 'vm_classes', label: 'VM classes allowed', control: 'text', default: 'best-effort-small, best-effort-medium, guaranteed-medium', hint: '"all" allows every class — see the finding' },
      { id: 'cpu_limit', label: 'CPU limit (MHz)', control: 'number', default: 20000, min: 0, max: 10000000, hint: '0 means none' },
      { id: 'memory_limit', label: 'Memory limit (MiB)', control: 'number', default: 65536, min: 0, max: 100000000, hint: '0 means none' },
      { id: 'storage_limit', label: 'Storage limit (GiB)', control: 'number', default: 500, min: 0, max: 10000000, hint: '0 means none' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const nsName = str(values, 'namespace_name', 'namespace').toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const className = str(values, 'class_name', 'default');
      const region = str(values, 'region', 'region1');
      const storageClass = str(values, 'storage_class', '');
      const vmClassesRaw = str(values, 'vm_classes', '');
      const allClasses = /^all$/i.test(vmClassesRaw.trim()) || !vmClassesRaw.trim();
      const vmClasses = allClasses ? [] : listOf(vmClassesRaw);
      const cpu = num(values, 'cpu_limit', 0);
      const mem = num(values, 'memory_limit', 0);
      const disk = num(values, 'storage_limit', 0);
      const base = slugOf(name || nsName, 'namespace');

      const findings: Finding[] = [];
      if (cpu === 0 || mem === 0 || disk === 0) {
        findings.push(
          warning('vcfa.ns.no-limits', `The namespace class has no ${[cpu === 0 ? 'CPU' : '', mem === 0 ? 'memory' : '', disk === 0 ? 'storage' : ''].filter(Boolean).join(', ')} limit.`, {
            remediation: 'A namespace with no limit can take the whole Supervisor cluster. Set limits on the class, so every namespace requested from it has them.',
            source: SRC,
          }),
        );
      }
      if (allClasses) {
        findings.push(
          warning('vcfa.ns.all-vm-classes', 'Every VM class is allowed, including the largest guaranteed ones.', {
            remediation: 'VM classes are the size menu for VMs and Kubernetes nodes in the namespace. List the ones this class of namespace should use.',
            source: SRC,
          }),
        );
      }
      if (nsName.length > 63) {
        findings.push(error('vcfa.ns.name-length', 'Namespace names are DNS labels and must be 63 characters or fewer.', { source: SRC }));
      }

      const yaml = [
        `# Supervisor namespace ${nsName}`,
        '#',
        '#',
        '# The namespace takes its limits, storage classes and VM classes from the',
        `# namespace class "${className}". Change them there, not here.`,
        'formatVersion: 2',
        'inputs:',
        '  name:',
        '    type: string',
        '    title: Namespace name',
        '    pattern: "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$"',
        `    default: ${nsName}`,
        'resources:',
        '  namespace:',
        '    type: CCI.Supervisor.Namespace',
        '    properties:',
        "      name: '${input.name}'",
        `      className: ${className}`,
        `      regionName: ${region}`,
        '',
      ].join('\n');

      // v1alpha3 is the version the vmware/vcfa Terraform provider (for VCF
      // Automation 9.x) sends, through go-vcloud-director's ccitypes; this file
      // said v1alpha1 before. The label is how the package finds its own
      // request again: the name is generated, so it cannot be looked up by name.
      const CCI_API = 'infrastructure.cci.vmware.com/v1alpha3';
      const requestLabel = 'vcf.automation/request';
      const namespaceObject = {
        apiVersion: CCI_API,
        kind: 'SupervisorNamespace',
        metadata: { generateName: `${nsName}-`, namespace: '<REQUIRED — the project namespace in VCF Automation>', labels: { [requestLabel]: nsName } },
        spec: { className, regionName: region },
      };
      const namespaceYaml = [
        '# The same request, for kubectl against the VCF Automation (CCI) endpoint.',
        '# VERIFY the apiVersion against your release:',
        '#   kubectl api-resources | grep -i supervisornamespace',
        `# ${CCI_API} is what the vmware/vcfa Terraform provider sends for 9.x.`,
        `apiVersion: ${CCI_API}`,
        'kind: SupervisorNamespace',
        'metadata:',
        `  generateName: ${nsName}-`,
        '  namespace: <REQUIRED — the project namespace in VCF Automation>',
        '  labels:',
        `    ${requestLabel}: ${nsName}`,
        'spec:',
        `  className: ${className}`,
        `  regionName: ${region}`,
        '',
      ].join('\n');

      const classConfig = [
        '# What the namespace class allows. This is where limits belong, because every',
        `# namespace requested from "${className}" inherits them.`,
        '# VERIFY the kind, apiVersion and field names against your release:',
        '#   kubectl explain supervisornamespaceclassconfig.spec',
        '# Setting these is an organisation administrator task.',
        'apiVersion: infrastructure.cci.vmware.com/v1alpha1',
        'kind: SupervisorNamespaceClassConfig',
        'metadata:',
        `  name: ${className}`,
        'spec:',
        '  limits:',
        ...(cpu > 0 ? ['    - name: cpu_limit', `      limit: "${cpu}M"`] : ['    # no CPU limit']),
        ...(mem > 0 ? ['    - name: memory_limit', `      limit: "${mem}Mi"`] : ['    # no memory limit']),
        ...(disk > 0 ? ['    - name: storage_request_limit', `      limit: "${disk}Gi"`] : ['    # no storage limit']),
        '  storageClasses:',
        `    - name: ${storageClass || '<REQUIRED — a storage policy exposed to the Supervisor>'}`,
        '  vmClasses:',
        ...(allClasses ? ['    # every class — see the README finding'] : vmClasses.map((c) => `    - name: ${c}`)),
        '',
      ].join('\n');

      const imported = importBundle({
        templates: [{ name: `Supervisor namespace (${className})`, description: `A namespace from class ${className} in ${region}.`, yaml, org: 'all-apps' }],
      });

      // The package: the namespace requested through the CCI Kubernetes API of
      // VCF Automation (https://<vcfa>/cci/kubernetes/apis/…, the path the
      // vmware/vcfa provider uses), with the organization token. Its own earlier
      // request is found by label and left alone.
      const nsWorkflow = elementName(`Request namespace ${nsName}`);
      const nsPkg = toPackage({
        packageName: packageNameOf('vcfa', 'namespace', base),
        description: `Requests the Supervisor namespace ${nsName} (class ${className}, region ${region}) from a VCF Automation All Apps organization.`,
        categoryPath: `Automation/Namespaces/${base}`,
        workflow: {
          name: nsWorkflow,
          description: `Requests a Supervisor namespace ${nsName}-… of class ${className} in region ${region}, in the project set in the configuration element, through the CCI API. A namespace this workflow already requested (found by its ${requestLabel} label) is left as it is. Set the dryRun input to true to preview without changing anything.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be requested and change nothing' }],
          outputs: [
            { name: 'namespaceName', type: 'string', description: 'The Supervisor namespace, empty in a dry run that would create it' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: [
            `var CCI_API = ${q(CCI_API)};`,
            `var LABEL = ${q(requestLabel)};`,
            `var REQUEST = ${q(nsName)};`,
            'var ctx = core.begin(settings, dryRun);',
            VCFA_LOGIN,
            String.raw`if (!settings.projectName) throw new Error("Set projectName in the configuration element: the project (its namespace in VCF Automation) the namespace is requested in.");
var project = String(settings.projectName);
var url = "https://" + host + "/cci/kubernetes/apis/" + CCI_API + "/namespaces/" + encodeURIComponent(project) + "/supervisornamespaces";
var list = core.http("GET", url, auth, null, SAFE).body;
if (!list || Object.prototype.toString.call(list.items) !== "[object Array]") throw new Error("GET " + CCI_API + " supervisornamespaces did not answer with a list (items[]); VERIFY the apiVersion with kubectl api-resources.");
var mine = [];
for (var i = 0; i < list.items.length; i++) {
  var labels = (list.items[i].metadata && list.items[i].metadata.labels) || {};
  if (String(labels[LABEL]) === REQUEST) mine.push(list.items[i]);
}
if (mine.length > 1) throw new Error(mine.length + " namespaces carry " + LABEL + "=" + REQUEST + "; refusing to guess which is meant. Tidy them first.");
var name = "";
if (mine.length === 1) {
  name = String(mine[0].metadata.name);
  System.log("Exists, left as it is: Supervisor namespace " + name + " (requested earlier as " + REQUEST + ")");
} else {
  var body = JSON.parse(core.resource(RESOURCE_PATH, "namespace.json"));
  body.metadata.namespace = project;
  name = core.act(ctx, "request Supervisor namespace " + REQUEST + "-… of class " + body.spec.className + " in " + body.spec.regionName + ", project " + project, function () {
    var r = core.http("POST", url, auth, body, SAFE);
    return r.body && r.body.metadata ? String(r.body.metadata.name) : "";
  }) || "";
}
namespaceName = name;
summary = core.audit(ctx, { namespaceName: name, project: project });
core.notify(settings.webhook, summary);`,
          ].join('\n'),
        },
        config: {
          name: 'Settings',
          description: `Settings of the ${nsWorkflow} workflow. Fill vcfaApiToken after import; set dryRun to true to preview instead of changing anything.`,
          attributes: [
            ...vcfaSettings('all-apps'),
            { name: 'projectName', type: 'string', value: '', description: 'The project to request the namespace in (its namespace in VCF Automation, as kubectl shows it)' },
            ...guardSettings(1, 'requested'),
          ],
        },
        resources: [{ name: 'namespace.json', content: json(namespaceObject) }],
      });

      return {
        platform: PLATFORM,
        title: `Supervisor namespace ${nsName} — from class ${className} in ${region}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'A project member in the All Apps organisation requests the template, or applies the YAML with kubectl', worstCase: 'once per request — and each namespace reserves nothing but can consume up to its limits' },
        scope: {
          what: `One Supervisor namespace in region ${region}, bounded by the class ${className}.`,
          decidedBy: [
            'The project in the All Apps organisation the request is made in.',
            `The region ${region}, and which Supervisors it contains.`,
            `The namespace class ${className}: its limits, storage classes and VM classes.`,
            'Who is a member of the project — they become editors of the namespace.',
          ],
          ifWrong: 'A namespace with no limits and every VM class can consume the whole Supervisor cluster, and the first sign is other teams’ pods pending.',
        },
        guardrails: [
          ...(cpu > 0 && mem > 0 && disk > 0 ? [{ rule: `Limits on the class: ${cpu} MHz, ${mem} MiB, ${disk} GiB`, because: 'Every namespace requested from the class is bounded without anyone remembering to bound it.' }] : []),
          ...(!allClasses ? [{ rule: `VM classes limited to ${vmClasses.join(', ')}`, because: 'The VM class list is the size menu. An unrestricted menu is how a development namespace ends up with guaranteed-8xlarge nodes.' }] : []),
          { rule: 'Name validated as a DNS label', because: 'An invalid name fails at the Supervisor after approval, which is the slowest place to find out.' },
        ],
        dryRun: [
          `Run the package workflow ${nsWorkflow} with the dryRun input set to true: it lists the project's namespaces, logs "DRY RUN: would request …" and requests nothing.`,
          `Run scripts/apply-kubectl.sh --dry-run: a server-side dry run against the CCI endpoint, which checks the class and region exist.`,
          'Request the template in a test project and check the namespace’s limits in vCenter match the class.',
        ],
        undo: ['Delete the deployment, or kubectl delete the SupervisorNamespace. Everything inside the namespace — VMs, clusters, volumes — is deleted with it.'],
        told: ['The deployment History tab for template requests.', 'vCenter events for the namespace creation, which VCF Operations collects.'],
        requires: [
          PKG_REQUIRES,
          'VCF Automation with an All Apps organisation, connected to a region containing a Supervisor.',
          `The namespace class ${className}, and the storage class and VM classes it names, associated with the Supervisor.`,
          'kubectl and the VCF CLI (or kubectl vsphere plugin) for the YAML route.',
        ],
        files: {
          [`${base}.yaml`]: yaml,
          [`${base}-template.json`]: json(templatePayload(`Supervisor namespace (${className})`, `A namespace from class ${className} in ${region}.`, yaml)),
          [`${base}-namespace.k8s.yaml`]: namespaceYaml,
          [`${base}-class-config.k8s.yaml`]: classConfig,
          ...nsPkg.files,
          'scripts/apply.sh': underScripts(applyScript('vcf-automation', [{ method: 'POST', path: '/blueprint/api/blueprints', payload: `${base}-template.json` }], 'DELETE /blueprint/api/blueprints/{id}. Namespaces already requested are not deleted.')),
          'scripts/apply-kubectl.sh': underScripts(kubectlScript(`Request Supervisor namespace ${nsName} through the VCF Automation CCI endpoint.`, [`${base}-namespace.k8s.yaml`], 'kubectl delete supervisornamespace <name> -n <project namespace> — deletes everything in it.')),
          ...imported.files,
          'IMPORT.md': importMd({
            subject: `A Supervisor namespace from class ${className}: requested by the Orchestrator package (\`${nsPkg.packageDir}\`, workflow **${nsWorkflow}**, through the CCI API of VCF Automation), and as a blueprint and YAML for the catalog and kubectl.`,
            orgs: 'VCF Automation 9.1 / 9.1.1 All Apps organizations',
            steps: [
              ...packageSteps(nsPkg),
              manualStep(`Namespace class ${className} (organization administrator)`, [
                `\`kubectl create -f ${base}-class-config.k8s.yaml\` in the organization context (VERIFY the kind first: \`kubectl explain supervisornamespaceclassconfig.spec\`), or set the limits, storage class and VM classes on the class in the interface.`,
              ]),
              imported.steps.templates,
              manualStep('Or request it directly with kubectl', [
                `\`scripts/apply-kubectl.sh\` applies \`${base}-namespace.k8s.yaml\` (\`--dry-run\` runs a server-side dry run only). Fill metadata.namespace (the project namespace) first. Against the VCF Automation endpoint, \`kubectl create -f ${base}-namespace.k8s.yaml\` is the safer verb: \`create\` refuses to overwrite.`,
              ]),
            ],
            auth: ['import', 'kube'],
            verify: [
              ...verifyFor(imported),
              `The CCI apiVersion is ${CCI_API} (go-vcloud-director ccitypes, sent by the vmware/vcfa Terraform provider; this file said v1alpha1 before) at https://<vcfa>/cci/kubernetes/apis/…/namespaces/<project>/supervisornamespaces. It has moved between releases: kubectl api-resources | grep -i supervisornamespace.`,
              'The package logs in with an organization API token (/oauth/tenant/<org>/token) and sends it as a bearer token to the CCI API, as the VCF CLI context does; VERIFY that your organization role may create supervisornamespaces in the project.',
              VERIFY_LOGIN,
              'SupervisorNamespaceClassConfig (the class limits) is an organization administrator task by kubectl and is not pushed by the package; its kind and fields are VERIFY (kubectl explain supervisornamespaceclassconfig.spec).',
              'The blueprint route in an All Apps organization is the documented New From Import; the package does not import the template, because the /blueprint/api project of an All Apps organization is not documented.',
            ],
          }),
        },
        notes: [
          'In VCF Automation 9, Supervisor namespaces are an All Apps organisation capability. A VM Apps organisation (the 8.x-style one) does not offer CCI resource types.',
          'CCI.Supervisor.Namespace uses formatVersion 2 templates. The apiVersion of the Kubernetes objects has moved between releases — check it on your own endpoint rather than trusting this file.',
          'Limits in the class are the ceiling for each namespace, not a reservation. A Supervisor can still be oversubscribed by many namespaces each within their limits.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  VKS_CLUSTER,

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa_terraform_in_template',
    platform: PLATFORM,
    label: 'Terraform run from a cloud template',
    group: 'Terraform',
    description:
      'A cloud template that runs a Terraform configuration from a Git repository through the Terraform runtime integration: Cloud.Terraform.Configuration with the provider bound to a cloud zone, variables from inputs, a pinned commit, and a versions.tf that pins the providers — because an unpinned provider changes under a template nobody has touched.',
    inputs: [
      { id: 'template_name', label: 'Template name', control: 'text', default: 'Application network via Terraform' },
      { id: 'repository', label: 'Repository integration', control: 'text', default: 'infrastructure-terraform', hint: 'The Git integration name in VCF Automation' },
      { id: 'source_directory', label: 'Directory in the repository', control: 'text', default: 'modules/app-network' },
      { id: 'commit', label: 'Commit', control: 'text', default: '', placeholder: '3f9c2e1…', hint: 'Empty follows the branch — see the finding' },
      { id: 'terraform_version', label: 'Terraform version', control: 'text', default: '1.9.8', hint: 'Must be one enabled under Terraform versions' },
      {
        id: 'provider',
        label: 'Provider',
        control: 'select',
        options: [
          { value: 'vsphere', label: 'vsphere (hashicorp/vsphere)' },
          { value: 'nsxt', label: 'nsxt (vmware/nsxt)' },
          { value: 'vcfa', label: 'vcfa (vmware/vcfa)' },
        ],
        default: 'nsxt',
      },
      { id: 'cloud_zone', label: 'Provider cloud zone', control: 'text', default: 'Production zone A' },
      { id: 'pin_providers', label: 'Pin provider versions', control: 'toggle', default: true },
      { id: 'variables', label: 'Variables from inputs', control: 'text', default: 'app_name, segment_cidr' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const templateName = str(values, 'template_name', 'Terraform template');
      const repository = str(values, 'repository', '');
      const directory = str(values, 'source_directory', '');
      const commit = str(values, 'commit', '');
      const tfVersion = str(values, 'terraform_version', '1.9.8');
      const provider = str(values, 'provider', 'nsxt');
      const zone = str(values, 'cloud_zone', '');
      const pin = bool(values, 'pin_providers', true);
      const variables = listOf(str(values, 'variables', '')).map((v) => v.replace(/[^A-Za-z0-9_]/g, '_'));
      const base = slugOf(name || templateName, 'terraform-template');

      const PROVIDERS: Record<string, { source: string; version: string }> = {
        vsphere: { source: 'hashicorp/vsphere', version: '~> 2.10' },
        nsxt: { source: 'vmware/nsxt', version: '~> 3.8' },
        vcfa: { source: 'vmware/vcfa', version: '~> 1.0' },
      };
      const prov = PROVIDERS[provider] ?? PROVIDERS['nsxt']!;

      const findings: Finding[] = [];
      if (!commit) {
        findings.push(
          warning('vcfa.tf.no-commit', 'The configuration is not pinned to a commit, so every deployment runs whatever the branch says at the time.',
            {
              remediation: 'Pin the commit in the template and release a new template version to move it. Then a template version means one configuration.',
              source: SRC,
            }),
        );
      }
      if (!pin) {
        findings.push(
          warning('vcfa.tf.unpinned-providers', 'Provider versions are not pinned, so the next provider release changes what this template does.', {
            remediation: `Pin with required_providers in versions.tf — ${prov.source} ${prov.version} — and commit .terraform.lock.hcl.`,
            source: SRC,
          }),
        );
      }
      findings.push(
        info('vcfa.tf.state', 'VCF Automation keeps the Terraform state for each deployment itself. Do not add a backend block to the configuration.', {
          remediation: 'The state lives with the deployment: back up VCF Automation, and change the resources through the deployment rather than by running Terraform against them elsewhere.',
          source: SRC,
        }),
      );
      if (!repository || !directory) {
        findings.push(error('vcfa.tf.no-source', 'No repository or directory is set, so there is no configuration to run.', { source: SRC }));
      }

      const yaml = [
        `# ${templateName}`,
        '#',
        '#',
        '# Runs the Terraform configuration in the repository through the Terraform',
        '# runtime integration. VCF Automation holds the state for each deployment.',
        'formatVersion: 1',
        'inputs:',
        ...variables.flatMap((v) => [`  ${v}:`, '    type: string', `    title: ${v.replace(/_/g, ' ')}`]),
        'resources:',
        '  terraform:',
        '    type: Cloud.Terraform.Configuration',
        '    properties:',
        `      terraformVersion: ${tfVersion}`,
        '      providers:',
        `        - name: ${provider}`,
        `          cloudZone: ${JSON.stringify(zone || '<REQUIRED — cloud zone whose account supplies the provider credentials>')}`,
        '      variables:',
        ...(variables.length > 0 ? variables.map((v) => `        ${v}: '\${input.${v}}'`) : ['        {}']),
        '        # Secrets: reference a VCF Automation secret, e.g. api_key: ${secret.name}.',
        '        # Never an input with a default, and never a literal.',
        '      configurationSource:',
        `        repositoryId: ${JSON.stringify(`<REQUIRED — id of the "${repository || 'repository'}" integration>`)}`,
        `        commitId: ${commit || '<REQUIRED — a commit sha; empty follows the branch>'}`,
        `        sourceDirectory: ${directory || '<REQUIRED>'}`,
        '',
      ].join('\n');

      const versions = [
        '# versions.tf — commit this in the configuration directory.',
        '#',
        '#',
        '# No backend block: VCF Automation manages the state for each deployment,',
        '# and a backend here either conflicts with that or is ignored.',
        'terraform {',
        `  required_version = "~> ${tfVersion.split('.').slice(0, 2).join('.')}"`,
        '',
        '  required_providers {',
        `    ${provider} = {`,
        `      source  = "${prov.source}"`,
        ...(pin ? [`      version = "${prov.version}"`] : ['      # version not pinned — see the README finding']),
        '    }',
        '  }',
        '}',
        '',
        ...variables.flatMap((v) => [`variable "${v}" {`, '  type = string', '}', '']),
      ].join('\n');

      const payload = templatePayload(templateName, `Runs ${directory || 'a Terraform configuration'} from ${repository || 'a repository'}.`, yaml);
      const imported = importBundle({ templates: [{ name: templateName, description: `Runs ${directory || 'a Terraform configuration'} from ${repository || 'a repository'}.`, yaml }] });

      // The package: the template imported through the blueprint API, with the
      // repository integration's id — which a person would otherwise look up and
      // paste — filled in from its name. A template with anything else still
      // <REQUIRED …> is refused rather than imported broken.
      const tfPkgName = packageNameOf('vcfa', 'terraform', base);
      const tfWorkflow = elementName(`Import ${templateName}`);
      const tfPkg = toPackage({
        packageName: tfPkgName,
        description: `Imports the cloud template "${templateName}", which runs Terraform from ${repository || 'a repository'}, into VCF Automation.`,
        categoryPath: `Automation/Terraform/${base}`,
        workflow: {
          name: tfWorkflow,
          description: `Imports "${templateName}" into the project set in the configuration element: the repository integration's id filled in, validated on the server, created (or its draft updated) and versioned 1.0.0. Set the dryRun input to true to preview without changing anything.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: validate and report, change nothing' }],
          outputs: [
            { name: 'templateId', type: 'string', description: 'The template id, empty in a dry run that would create it' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: [
            `var TEMPLATE_NAME = ${q(templateName)};`,
            `var TEMPLATE_DESCRIPTION = ${q(`Runs ${directory || 'a Terraform configuration'} from ${repository || 'a repository'}.`)};`,
            'var ctx = core.begin(settings, dryRun);',
            VCFA_LOGIN,
            String.raw`if (!settings.repositoryIntegration) throw new Error("Set repositoryIntegration in the configuration element: the name of the Git integration that holds the configuration.");
var projectId = mod.projectIdOf(host, auth, SAFE, settings.projectName);
var repo = mod.findOne(mod.listAll(host, auth, "/iaas/api/integrations", SAFE), { name: String(settings.repositoryIntegration) }, "integration named " + settings.repositoryIntegration);
if (!repo) throw new Error("No integration named '" + settings.repositoryIntegration + "' (Infrastructure > Integrations).");
var content = core.resource(RESOURCE_PATH, "template.yaml").replace(/(repositoryId:[ \t]*).*/, "$1" + JSON.stringify(String(repo.id)));
var id = mod.ensureTemplate(ctx, host, auth, SAFE, { projectId: projectId, name: TEMPLATE_NAME, description: TEMPLATE_DESCRIPTION, content: content, version: "1.0.0", release: settings.release === true, validate: true });
templateId = ctx.dryRun ? "" : id;
summary = core.audit(ctx, { templateId: id, repositoryId: String(repo.id), project: String(settings.projectName) });
core.notify(settings.webhook, summary);`,
          ].join('\n'),
        },
        actions: vcfaActions(tfPkgName),
        config: {
          name: 'Settings',
          description: `Settings of the ${tfWorkflow} workflow. Fill vcfaApiToken after import; set dryRun to true to preview instead of changing anything.`,
          attributes: [
            ...vcfaSettings('vm-apps'),
            { name: 'projectName', type: 'string', value: '', description: 'The project the template is created in' },
            { name: 'repositoryIntegration', type: 'string', value: repository, description: 'The Git integration holding the configuration (Infrastructure > Integrations), by name' },
            { name: 'release', type: 'boolean', value: false, description: 'true: release version 1.0.0 to the catalog when it is created' },
            ...guardSettings(2, 'imported'),
          ],
        },
        resources: [{ name: 'template.yaml', content: yaml, mimeType: 'application/x-yaml' }],
      });

      return {
        platform: PLATFORM,
        title: `${templateName} — Terraform from ${repository || 'a repository'}${commit ? ` at ${commit.slice(0, 8)}` : ''}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'Somebody requests the template, or updates or deletes a deployment of it', worstCase: 'a terraform apply per request, and a terraform destroy per deletion' },
        scope: {
          what: `Whatever the configuration in ${directory || '(no directory)'} declares, created with the ${provider} provider using the credentials of the account behind ${zone || 'the cloud zone'}.`,
          decidedBy: [
            `The configuration at ${commit ? `commit ${commit}` : 'the head of the branch, at the moment of each request'}.`,
            `The cloud zone ${zone || '(none)'}, whose cloud account supplies the provider credentials — and their rights are the real bound.`,
            'The input values of each request.',
            'The project the template is released to.',
          ],
          ifWrong: commit
            ? 'The configuration creates more than the template suggests, with the rights of a cloud account that can usually do far more.'
            : 'A commit to the branch changes what the next request builds, without a template change or a review in VCF Automation.',
        },
        guardrails: [
          ...(commit ? [{ rule: `Pinned to commit ${commit.slice(0, 12)}`, because: 'A template version then means one configuration. Moving it is a new version, which is reviewable.' }] : []),
          ...(pin ? [{ rule: `Provider pinned to ${prov.source} ${prov.version}`, because: 'An unpinned provider changes behaviour under a template nobody has touched.' }] : []),
          { rule: `Terraform ${tfVersion} named explicitly`, because: 'The runtime runs the version the template names, and that version has to be enabled by an administrator.' },
          { rule: 'State held by VCF Automation, not a backend in the configuration', because: 'Two places holding state for the same resources is how they drift and then get destroyed.' },
        ],
        dryRun: [
          `Run the package workflow ${tfWorkflow} with the dryRun input set to true: it resolves the project and the repository integration, has the template validated on the server, logs every "DRY RUN: would …" and imports nothing.`,
          `Run terraform init and terraform plan against the directory locally with the same versions — plan is Terraform’s own dry run.`,
          'Then deploy the template in a test project whose cloud zone points at a lab. VCF Automation shows the plan in the deployment’s history before it applies.',
        ],
        undo: [
          'Delete the deployment: VCF Automation runs terraform destroy with the state it holds.',
          'Resources the configuration created outside Terraform’s knowledge (by a provisioner or script) are not destroyed.',
        ],
        told: ['The deployment History tab, with the Terraform plan and apply logs.', 'Git history for the configuration itself.'],
        requires: [
          PKG_REQUIRES,
          'The Terraform runtime integration configured (a Kubernetes runtime for the Terraform jobs).',
          `Terraform ${tfVersion} enabled under Infrastructure → Terraform versions.`,
          `A Git integration named ${repository || '(set one)'} with access to the repository.`,
          `The cloud zone ${zone || '(set one)'} in the project, backed by an account the ${provider} provider can use.`,
        ],
        files: {
          [`${base}.yaml`]: yaml,
          [`${base}-template.json`]: json(payload),
          'versions.tf': versions,
          ...tfPkg.files,
          'scripts/apply.sh': underScripts(applyScript('vcf-automation', [{ method: 'POST', path: '/blueprint/api/blueprints', payload: `${base}-template.json` }], 'DELETE /blueprint/api/blueprints/{id}. Existing deployments keep their state and resources.')),
          ...imported.files,
          'IMPORT.md': importMd({
            subject: `The cloud template "${templateName}", which runs Terraform from ${repository || 'a repository'}. The Orchestrator package (\`${tfPkg.packageDir}\`) imports it: its workflow **${tfWorkflow}** fills in the repository integration's id, has the template validated, then creates and versions it. The files after it are the same template for importing by hand.`,
            steps: [
              manualStep('The configuration', [`Commit \`versions.tf\` into ${directory || 'the configuration directory'} of the repository behind the ${repository || '(set one)'} integration, and put the commit sha in the template. Enable Terraform ${tfVersion} under Infrastructure → Terraform versions.`]),
              ...packageSteps(tfPkg),
              orByHand(imported.steps.templates),
            ],
            auth: ['import'],
            verify: [
              ...verifyFor(imported),
              'Cloud.Terraform.Configuration property names (terraformVersion, providers[].name and cloudZone, variables, configurationSource.repositoryId, commitId, sourceDirectory) match published examples (Kovarus, on Terraform resources in cloud templates); the Terraform runtime integration is documented for 9.1 VM Apps organizations (TechDocs 9.1, "VCF Automation Terraform runtime with no internet access").',
              'repositoryId is the id of the Git integration (GET /iaas/api/integrations), which is what the package fills in; VERIFY by adding a Terraform resource in the designer once and comparing.',
              VERIFY_LOGIN,
            ],
          }),

        },
        notes: [
          'The Cloud.Terraform.Configuration property names (terraformVersion, providers with name and cloudZone, variables, configurationSource with repositoryId, commitId and sourceDirectory) are as the template designer writes them when you add a Terraform resource from a repository, and as published examples show them.',
          'Which provider versions the runtime can download depends on its network access. An air-gapped runtime needs a provider mirror.',
          'The provider takes credentials from the cloud account behind the cloud zone. Do not also pass credentials as variables — two sources of truth for one credential is how rotations break.',
        ],
        findings,
      };
    },
  }),
];

